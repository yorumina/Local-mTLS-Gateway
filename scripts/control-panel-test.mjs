import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createControlPanel } from '../control-panel/server.mjs';
import { buildManagedSidecarEnvironment } from '../control-panel/lib/process-manager.mjs';
import { writeSettings } from '../src/settings-store.mjs';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-control-test-'));
const settingsFile = path.join(temporaryRoot, '.sidecar.local.json');
const envFile = path.join(temporaryRoot, '.env.local');
const fakeSecret = 'fake-sidecar-key-for-tests-only';
const baseConfig = {
  host: '127.0.0.1',
  upstreamBaseUrl: 'https://llm.yorumina.com',
  port: 18787,
  maxBodyBytes: 16 * 1024 * 1024,
  upstreamTimeoutMs: 120_000,
  identityType: 'pfx',
  mtlsCertFile: '',
  mtlsKeyFile: '',
  mtlsCaFile: '',
  mtlsPfxFile: 'C:\\test\\client.pfx',
};
writeSettings(baseConfig, { filePath: settingsFile });
fs.writeFileSync(envFile, `SIDECAR_API_KEY=${fakeSecret}\n`, { mode: 0o600 });

const managedEnvironment = buildManagedSidecarEnvironment({
  PATH: 'test-path',
  SIDECAR_API_KEY: 'stale-sidecar-key',
  UPSTREAM_API_KEY: 'stale-upstream-key',
  MTLS_PASSPHRASE: 'stale-passphrase',
}, settingsFile);
assert.equal(managedEnvironment.PATH, 'test-path', 'non-secret environment was not preserved');
assert.equal(managedEnvironment.SIDECAR_SETTINGS_FILE, settingsFile, 'settings path was not provided');
assert.equal(Object.hasOwn(managedEnvironment, 'SIDECAR_API_KEY'), false, 'stale sidecar key was inherited');
assert.equal(Object.hasOwn(managedEnvironment, 'UPSTREAM_API_KEY'), false, 'stale upstream key was inherited');
assert.equal(Object.hasOwn(managedEnvironment, 'MTLS_PASSPHRASE'), false, 'stale passphrase was inherited');

let policyPasses = true;
const fakeManager = {
  status: () => ({ managed: false, running: false }),
  restart: async () => ({ managed: false, restarted: false, restartRequired: true }),
  stop: async () => {},
};
const control = createControlPanel({
  port: 0,
  settingsFile,
  envFile,
  currentEnv: {},
  processManager: fakeManager,
  runPolicy: async () => ({ passed: policyPasses, durationMs: 1 }),
  runSmoke: async () => ({ passed: true, durationMs: 1 }),
  runUpstream: async () => ({ level: 'Unknown' }),
});
await new Promise((resolve, reject) => {
  control.server.once('error', reject);
  control.server.listen(0, '127.0.0.1', resolve);
});
const address = control.server.address();
assert.equal(address.address, '127.0.0.1', 'Control Panel must bind only to loopback');
const baseUrl = `http://127.0.0.1:${address.port}`;

async function json(route, options) {
  const url = new URL(`${baseUrl}${route}`);
  const payload = options?.body ?? '';
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: options?.method ?? 'GET',
      headers: payload ? { ...options?.headers, 'content-length': Buffer.byteLength(payload) } : options?.headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

try {
  const session = await json('/api/session');
  const mutationHeaders = {
    'content-type': 'application/json',
    origin: baseUrl,
    'x-sidecar-control-token': session.body.token,
  };

  const configResponse = await json('/api/config');
  assert.equal(configResponse.status, 200);
  assert.equal(JSON.stringify(configResponse.body).includes(fakeSecret), false, '/api/config exposed a secret');
  assert.equal(Object.hasOwn(configResponse.body, 'sidecarApiKey'), false, '/api/config returned a secret field');

  const secretStatus = await json('/api/secrets/status');
  assert.deepEqual(secretStatus.body, {
    sidecarApiKeyConfigured: true,
    upstreamApiKeyConfigured: false,
    pfxPassphraseConfigured: false,
  });
  assert.equal(JSON.stringify(secretStatus.body).includes(fakeSecret), false, 'secret status exposed a value');

  const invalid = await json('/api/config/validate', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ config: { ...baseConfig, upstreamBaseUrl: 'http://example.com' } }),
  });
  assert.equal(invalid.body.valid, false, 'invalid HTTP production config passed validation');

  const originalSettings = fs.readFileSync(settingsFile, 'utf8');
  const rejectedApply = await json('/api/config/apply', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ config: { ...baseConfig, port: 70000 } }),
  });
  assert.equal(rejectedApply.status, 400, 'invalid config was applied');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalSettings, 'invalid apply changed settings');

  policyPasses = false;
  const failedApply = await json('/api/config/apply', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ config: { ...baseConfig, upstreamTimeoutMs: 180_000 } }),
  });
  assert.equal(failedApply.status, 500, 'policy failure should fail apply');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalSettings, 'apply failure did not restore previous settings');

  policyPasses = true;
  const applied = await json('/api/config/apply', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ config: { ...baseConfig, upstreamTimeoutMs: 180_000 } }),
  });
  assert.equal(applied.status, 200, 'valid config was not applied');
  assert.equal(applied.body.applied, true);
  assert.equal(JSON.stringify(applied.body).includes(fakeSecret), false, 'apply response exposed a secret');

  const missingToken = await json('/api/config/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ config: baseConfig }),
  });
  assert.equal(missingToken.status, 403, 'mutation without session token was accepted');

  console.log('control-panel-test: passed (17 checks)');
} finally {
  await new Promise((resolve) => control.server.close(resolve));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

