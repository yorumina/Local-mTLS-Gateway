import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSafeConfig } from '../src/config-validation.mjs';
import {
  ENV_FILE,
  SETTINGS_FILE,
  diffSettings,
  readSecretStatus,
  readSettings,
  restoreFile,
  snapshotFile,
  updateSecrets,
  writeSettings,
} from '../src/settings-store.mjs';
import { checkSidecarHealth, pickIdentityFile, runNpmScript, runUpstreamDiagnostic } from './lib/diagnostics.mjs';
import { SidecarProcessManager } from './lib/process-manager.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'control-panel', 'public');
const CONTROL_HOST = '127.0.0.1';
const DEFAULT_CONTROL_PORT = 8790;
const MAX_API_BODY = 64 * 1024;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function log(event, fields = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: 'sidecar-control-panel', event, ...fields }));
}

function securityHeaders(contentType) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'content-type': contentType,
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, { ...securityHeaders('application/json; charset=utf-8'), 'content-length': body.length });
  response.end(body);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      reject(Object.assign(new Error('JSON content type is required'), { statusCode: 415, code: 'json_required' }));
      return;
    }
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_API_BODY) {
        reject(Object.assign(new Error('Request is too large'), { statusCode: 413, code: 'body_too_large' }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400, code: 'invalid_json' })); }
    });
  });
}

function allowedOrigin(port, origin) {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function requireMutationAccess(request, port, sessionToken) {
  if (!allowedOrigin(port, request.headers.origin)) {
    throw Object.assign(new Error('Same-origin request required'), { statusCode: 403, code: 'origin_rejected' });
  }
  if (!safeEqual(request.headers['x-sidecar-control-token'], sessionToken)) {
    throw Object.assign(new Error('Control session token is invalid'), { statusCode: 403, code: 'session_rejected' });
  }
}

function isAllowedHost(hostHeader, port) {
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

function certificateStatus(settings) {
  const selectedPath = settings.identityType === 'pfx' ? settings.mtlsPfxFile : settings.mtlsCertFile;
  if (!selectedPath) return { level: 'Unknown', configured: false };
  try {
    const stats = fs.statSync(selectedPath);
    return { level: stats.isFile() ? 'Configured' : 'Failed', configured: stats.isFile(), identityType: settings.identityType };
  } catch {
    return { level: 'Failed', configured: true, identityType: settings.identityType };
  }
}

export async function applyConfiguration({
  proposed,
  secrets,
  settingsFile,
  envFile,
  processManager,
  runPolicy,
  currentEnv,
}) {
  const validation = validateSafeConfig(proposed);
  if (!validation.valid) return { statusCode: 400, payload: validation };

  const before = readSettings({ filePath: settingsFile, env: currentEnv });
  const settingsSnapshot = snapshotFile(settingsFile);
  const envSnapshot = snapshotFile(envFile);
  let wroteSecrets = false;
  try {
    writeSettings(validation.config, { filePath: settingsFile });
    let updatedSecrets = [];
    if (secrets && Object.keys(secrets).length > 0) {
      updatedSecrets = updateSecrets(secrets, { filePath: envFile }).updated;
      wroteSecrets = updatedSecrets.length > 0;
    }
    const policy = await runPolicy();
    if (!policy.passed) throw Object.assign(new Error('Security policy check failed'), { code: 'policy_failed' });
    const restart = await processManager.restart(validation.config.port);
    return {
      statusCode: 200,
      payload: {
        applied: true,
        config: validation.config,
        changes: diffSettings(before, validation.config),
        secretsUpdated: updatedSecrets.length,
        policy: { passed: true, durationMs: policy.durationMs },
        restart,
      },
    };
  } catch (error) {
    restoreFile(settingsFile, settingsSnapshot);
    if (wroteSecrets) restoreFile(envFile, envSnapshot);
    try {
      if (processManager.status().managed) await processManager.restart(before.port);
    } catch {}
    return {
      statusCode: 500,
      payload: {
        applied: false,
        error: {
          code: error.code ?? 'apply_failed',
          message: 'Configuration could not be applied. Your previous configuration is still active.',
        },
      },
    };
  }
}

export function createControlPanel({
  host = CONTROL_HOST,
  port = DEFAULT_CONTROL_PORT,
  projectRoot = PROJECT_ROOT,
  publicRoot = PUBLIC_ROOT,
  settingsFile = SETTINGS_FILE,
  envFile = ENV_FILE,
  currentEnv = process.env,
  manageSidecar = false,
  processManager = new SidecarProcessManager({ projectRoot, envFile, settingsFile, managed: manageSidecar }),
  runPolicy = () => runNpmScript(projectRoot, 'check'),
  runSmoke = () => runNpmScript(projectRoot, 'smoke'),
  runUpstream = () => runUpstreamDiagnostic(projectRoot, envFile, settingsFile),
} = {}) {
  if (host !== CONTROL_HOST) throw new Error('Control Panel host is locked to 127.0.0.1');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Control Panel port');
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  let lastPolicy;
  let lastSmoke;

  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now();
    let route = 'invalid';
    try {
      const address = server.address();
      const activePort = typeof address === 'object' && address ? address.port : port;
      if (!isAllowedHost(request.headers.host, activePort)) {
        throw Object.assign(new Error('Host is not allowed'), { statusCode: 403, code: 'host_rejected' });
      }
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${activePort}`);
      route = url.pathname;

      if (request.method === 'GET' && STATIC_FILES.has(route)) {
        const [fileName, contentType] = STATIC_FILES.get(route);
        const body = fs.readFileSync(path.join(publicRoot, fileName));
        response.writeHead(200, { ...securityHeaders(contentType), 'content-length': body.length });
        response.end(body);
        return;
      }
      if (request.method === 'GET' && route === '/api/session') {
        sendJson(response, 200, { token: sessionToken });
        return;
      }
      if (request.method === 'GET' && route === '/api/config') {
        sendJson(response, 200, readSettings({ filePath: settingsFile, env: currentEnv }));
        return;
      }
      if (request.method === 'GET' && route === '/api/secrets/status') {
        sendJson(response, 200, readSecretStatus({ filePath: envFile, env: currentEnv }));
        return;
      }
      if (request.method === 'GET' && route === '/api/status') {
        const settings = readSettings({ filePath: settingsFile, env: currentEnv });
        const validation = validateSafeConfig(settings);
        sendJson(response, 200, {
          controlPanel: { level: 'Healthy', host: CONTROL_HOST, port: activePort },
          sidecar: await checkSidecarHealth(settings.port),
          upstream: { level: 'Unknown', url: new URL(settings.upstreamBaseUrl).host },
          identity: certificateStatus(settings),
          policy: lastPolicy ?? { level: 'Unknown' },
          smoke: lastSmoke ?? { level: 'Unknown' },
          configuration: { level: validation.valid ? 'Healthy' : 'Failed', errors: validation.errors },
          process: processManager.status(),
        });
        return;
      }

      if (request.method !== 'POST') throw Object.assign(new Error('Route not found'), { statusCode: 404, code: 'not_found' });
      requireMutationAccess(request, activePort, sessionToken);
      const body = await readJsonBody(request);

      if (route === '/api/config/validate') {
        sendJson(response, 200, validateSafeConfig(body.config ?? body));
        return;
      }
      if (route === '/api/config/apply') {
        const result = await applyConfiguration({
          proposed: body.config,
          secrets: body.secrets,
          settingsFile,
          envFile,
          processManager,
          runPolicy,
          currentEnv,
        });
        sendJson(response, result.statusCode, result.payload);
        return;
      }
      if (route === '/api/secrets/update') {
        const result = updateSecrets(body, { filePath: envFile });
        sendJson(response, 200, { configured: true, updated: result.updated.length });
        return;
      }
      if (route === '/api/diagnostics/policy-check') {
        const result = await runPolicy();
        lastPolicy = { level: result.passed ? 'Healthy' : 'Failed', ...result };
        sendJson(response, result.passed ? 200 : 500, lastPolicy);
        return;
      }
      if (route === '/api/diagnostics/smoke') {
        const result = await runSmoke();
        lastSmoke = { level: result.passed ? 'Healthy' : 'Failed', ...result, remoteVerified: false };
        sendJson(response, result.passed ? 200 : 500, lastSmoke);
        return;
      }
      if (route === '/api/diagnostics/upstream') {
        sendJson(response, 200, await runUpstream());
        return;
      }
      if (route === '/api/files/pick') {
        sendJson(response, 200, await pickIdentityFile(body.kind));
        return;
      }
      if (route === '/api/sidecar/restart') {
        const settings = readSettings({ filePath: settingsFile, env: currentEnv });
        sendJson(response, 200, await processManager.restart(settings.port));
        return;
      }
      throw Object.assign(new Error('Route not found'), { statusCode: 404, code: 'not_found' });
    } catch (error) {
      const statusCode = error.statusCode ?? 500;
      sendJson(response, statusCode, { error: { code: error.code ?? 'control_panel_error', message: statusCode >= 500 ? 'Control Panel operation failed' : error.message } });
      log('operation_failed', { operation: route, status: statusCode, errorCode: error.code ?? 'control_panel_error', durationMs: Date.now() - startedAt });
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 180_000;
  server.keepAliveTimeout = 5_000;
  return { server, processManager, sessionToken };
}

export async function startControlPanel(options = {}) {
  const control = createControlPanel(options);
  await new Promise((resolve, reject) => {
    control.server.once('error', reject);
    control.server.listen(options.port ?? DEFAULT_CONTROL_PORT, CONTROL_HOST, resolve);
  });
  const address = control.server.address();
  const activePort = typeof address === 'object' && address ? address.port : DEFAULT_CONTROL_PORT;
  log('listening', { host: CONTROL_HOST, port: activePort, managedSidecar: Boolean(options.manageSidecar) });
  if (options.manageSidecar) {
    const settings = readSettings({ filePath: options.settingsFile ?? SETTINGS_FILE, env: options.currentEnv ?? process.env });
    await control.processManager.start(settings.port);
  }
  return control;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const manageSidecar = ['1', 'true', 'yes', 'on'].includes(String(process.env.CONTROL_PANEL_MANAGE_SIDECAR ?? '').toLowerCase());
  const control = await startControlPanel({ manageSidecar });
  const close = async () => {
    try { await control.processManager.stop(); } catch {}
    control.server.close(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
