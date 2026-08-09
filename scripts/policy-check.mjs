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
  'src/server.mjs',
  'scripts/smoke-test.mjs',
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
  const gitignore = read('.gitignore');
  const config = read('src/config.mjs');
  const server = read('src/server.mjs');
  const packageJson = JSON.parse(read('package.json'));

  for (const file of requiredFiles) assert(fs.existsSync(path.join(root, file)), `missing required file: ${file}`);
  assert(agent.includes('MUST NOT'), 'AGENTS.md must contain mandatory prohibitions');
  assert(agent.includes('npm run check'), 'AGENTS.md must require npm run check');
  assert(agent.includes('127.0.0.1'), 'AGENTS.md must pin the loopback bind');
  assert(agent.includes('rejectUnauthorized: true'), 'AGENTS.md must pin TLS verification');
  assert(gitignore.includes('.env.*'), '.env files must be ignored');
  assert(gitignore.includes('*.key'), 'private key files must be ignored');
  assert(gitignore.includes('*.pfx'), 'PFX files must be ignored');
  assert(config.includes("process.env.UPSTREAM_BASE_URL ?? 'https://llm.yorumina.com'"), 'default upstream changed');
  assert(config.includes("host !== '127.0.0.1'"), 'non-loopback bind guard missing');
  assert(config.includes('rejectUnauthorized: true'), 'TLS verification guard missing');
  assert(config.includes('MTLS_CERT_FILE') && config.includes('MTLS_KEY_FILE'), 'PEM mTLS configuration missing');
  assert(config.includes('MTLS_PFX_FILE'), 'PFX mTLS configuration missing');
  assert(server.includes('crypto.timingSafeEqual'), 'constant-time API-key comparison missing');
  assert(server.includes('containsCredentialQuery'), 'credential query-string rejection missing');
  assert(server.includes("['/v1/models', new Set(['GET'])]"), 'models route guard missing');
  assert(server.includes("['/v1/chat/completions', new Set(['POST'])]"), 'chat route guard missing');
  assert(server.includes('Object.assign(options, config.tls'), 'upstream TLS options are not applied');
  assert(server.includes('NODE_TLS_REJECT_UNAUTHORIZED') === false, 'TLS bypass token found in server');
  assert(packageJson.scripts?.check === 'node scripts/policy-check.mjs', 'npm check script changed');
  assert(packageJson.scripts?.smoke === 'node scripts/smoke-test.mjs', 'npm smoke script changed');

  console.log(`policy-check: passed (${checks} checks)`);
} catch (error) {
  console.error(`policy-check: failed: ${error.message}`);
  process.exitCode = 1;
}
