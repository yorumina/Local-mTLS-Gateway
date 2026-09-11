import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const requiredFiles = [
  'AGENTS.md',
  'README.md',
  '.env.example',
  '.gitignore',
  'package.json',
  'src/config.mjs',
  'src/config-validation.mjs',
  'src/settings-store.mjs',
  'src/server.mjs',
  'control-panel/server.mjs',
  'control-panel/lib/process-manager.mjs',
  'control-panel/lib/diagnostics.mjs',
  'control-panel/public/index.html',
  'control-panel/public/app.js',
  'control-panel/public/styles.css',
  'scripts/config-test.mjs',
  'scripts/control-panel-test.mjs',
  'scripts/smoke-test.mjs',
  'install-windows-integration.ps1',
  'opencode.json',
];
let checks = 0;

function read(relativePath) {
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target)) throw new Error(`missing required file: ${relativePath}`);
  return fs.readFileSync(target, 'utf8');
}

function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
}

try {
  const agent = read('AGENTS.md');
  const envExample = read('.env.example');
  const gitignore = read('.gitignore');
  const config = read('src/config.mjs');
  const validation = read('src/config-validation.mjs');
  const settingsStore = read('src/settings-store.mjs');
  const server = read('src/server.mjs');
  const controlServer = read('control-panel/server.mjs');
  const processManager = read('control-panel/lib/process-manager.mjs');
  const diagnostics = read('control-panel/lib/diagnostics.mjs');
  const controlApp = read('control-panel/public/app.js');
  const controlHtml = read('control-panel/public/index.html');
  const smoke = read('scripts/smoke-test.mjs');
  const windowsInstaller = read('install-windows-integration.ps1');
  const openCodeConfig = JSON.parse(read('opencode.json'));
  const packageJson = JSON.parse(read('package.json'));

  for (const file of requiredFiles) assert(fs.existsSync(path.join(root, file)), `missing required file: ${file}`);
  assert(agent.includes('MUST NOT'), 'AGENTS.md must contain mandatory prohibitions');
  assert(agent.includes('npm run check'), 'AGENTS.md must require npm run check');
  assert(agent.includes('127.0.0.1'), 'AGENTS.md must pin the loopback bind');
  assert(agent.includes('rejectUnauthorized: true'), 'AGENTS.md must pin TLS verification');
  assert(gitignore.includes('.env.*'), '.env files must be ignored');
  assert(gitignore.includes('*.key'), 'private key files must be ignored');
  assert(gitignore.includes('*.pfx'), 'PFX files must be ignored');
  assert(gitignore.includes('.sidecar.local.json'), 'safe local settings must be ignored');
  assert(/^SIDECAR_API_KEY=$/m.test(envExample), 'example sidecar API key must be empty');
  assert(config.includes('PLACEHOLDER_TOKENS') && config.includes('must not use a placeholder value'), 'placeholder API-key rejection missing');
  assert(validation.includes("upstreamBaseUrl: 'https://llm.yorumina.com'"), 'default upstream changed');
  assert(validation.includes("host: '127.0.0.1'"), 'non-loopback bind guard missing');
  assert(validation.includes("input?.host !== undefined && input.host !== '127.0.0.1'"), 'host lock validation missing');
  assert(config.includes('rejectUnauthorized: true'), 'TLS verification guard missing');
  assert(validation.includes("identityType === 'pem'") && validation.includes('mtlsCertFile') && validation.includes('mtlsKeyFile'), 'PEM mTLS configuration missing');
  assert(validation.includes("identityType === 'pfx'") && validation.includes('mtlsPfxFile'), 'PFX mTLS configuration missing');
  assert(settingsStore.includes("'.sidecar.local.json'"), 'local settings store missing');
  assert(server.includes('crypto.timingSafeEqual'), 'constant-time API-key comparison missing');
  assert(server.includes('containsCredentialQuery'), 'credential query-string rejection missing');
  assert(server.includes("['/v1/models', new Set(['GET'])]"), 'models route guard missing');
  assert(server.includes("['/v1/chat/completions', new Set(['POST'])]"), 'chat route guard missing');
  assert(server.includes("['/v1/audio/speech', new Set(['POST'])]"), 'TTS route guard missing');
  assert(agent.includes('/v1/audio/speech'), 'AGENTS.md TTS allowlist missing');
  assert(smoke.includes("request.url === '/v1/audio/speech'") && smoke.includes("'content-type': 'audio/mpeg'") && smoke.includes("observed.at(-1)?.body === speechBody"), 'binary TTS passthrough smoke coverage missing');
  assert(server.includes('Object.assign(options, config.tls'), 'upstream TLS options are not applied');
  assert(server.includes('NODE_TLS_REJECT_UNAUTHORIZED') === false, 'TLS bypass token found in server');
  assert(controlServer.includes("const CONTROL_HOST = '127.0.0.1'"), 'Control Panel loopback bind missing');
  assert(controlServer.includes('host !== CONTROL_HOST') && controlServer.includes('Control Panel host is locked to 127.0.0.1'), 'Control Panel host lock missing');
  assert(controlServer.includes('readSettings') && controlServer.includes('readSecretStatus'), 'Control Panel safe settings APIs missing');
  assert(controlServer.includes('x-sidecar-control-token') && controlServer.includes('requireMutationAccess') && controlServer.includes('allowedOrigin'), 'Control Panel mutation protection missing');
  assert(controlServer.includes("'/api/config'") && controlServer.includes("'/api/secrets/status'"), 'Control Panel safe read APIs missing');
  assert(controlServer.includes('NODE_TLS_REJECT_UNAUTHORIZED=0') === false, 'TLS bypass token found in Control Panel');
  assert(controlServer.includes('rejectUnauthorized: false') === false, 'insecure TLS found in Control Panel');
  assert(processManager.includes('0.0.0.0') === false, 'non-loopback listener token found in process manager');
  assert(processManager.includes('SECRET_NAMES') && processManager.includes('delete childEnv[name]'), 'managed sidecar may inherit stale secrets');
  assert(diagnostics.includes('0.0.0.0') === false, 'non-loopback listener token found in diagnostics');
  assert(controlHtml.includes('SIDECAR_API_KEY') && controlHtml.includes('Write-only') && controlApp.includes("'Configured ✓'"), 'write-only secret status UI missing');
  assert(controlHtml.includes('API Clients') && controlHtml.includes('/v1/audio/speech'), 'generic API client UI or TTS endpoint missing');
  assert(windowsInstaller.includes('start-opencode-desktop.ps1') === false, 'desktop installer still launches OpenCode');
  assert(windowsInstaller.includes("$shortcutName = 'Local mTLS Gateway.lnk'"), 'generic desktop shortcut missing');
  assert(openCodeConfig.provider?.gb10?.models?.['gb10-private-llm']?.limit?.context === 131072, 'OpenCode context limit is stale');
  assert(openCodeConfig.provider?.gb10?.models?.['gb10-private-llm']?.limit?.output === 32768, 'OpenCode output limit is stale');
  assert(openCodeConfig.provider?.gb10?.models?.['gb10-private-llm']?.limit?.input === 98304, 'OpenCode input headroom is missing');
  assert(openCodeConfig.compaction?.auto === true && openCodeConfig.compaction?.reserved === 20000, 'OpenCode automatic compaction headroom is missing');
  assert(packageJson.scripts?.check === 'node scripts/policy-check.mjs', 'npm check script changed');
  assert(packageJson.scripts?.smoke === 'node scripts/smoke-test.mjs', 'npm smoke script changed');
  assert(packageJson.scripts?.control === 'node --env-file=.env.local control-panel/server.mjs', 'npm control script missing');
  assert(packageJson.scripts?.['test:config'] === 'node scripts/config-test.mjs', 'config test script missing');
  assert(packageJson.scripts?.['test:control'] === 'node scripts/control-panel-test.mjs', 'Control Panel test script missing');

  console.log(`policy-check: passed (${checks} checks)`);
} catch (error) {
  console.error(`policy-check: failed: ${error.message}`);
  process.exitCode = 1;
}
