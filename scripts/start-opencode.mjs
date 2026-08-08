import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const serverEntry = path.join(projectRoot, 'src', 'server.mjs');

await access(serverEntry);

const requiredNames = ['SIDECAR_API_KEY'];
const hasPemIdentity = Boolean(process.env.MTLS_CERT_FILE && process.env.MTLS_KEY_FILE);
const hasPfxIdentity = Boolean(process.env.MTLS_PFX_FILE);

for (const name of requiredNames) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

if (!hasPemIdentity && !hasPfxIdentity) {
  throw new Error('Configure either MTLS_CERT_FILE + MTLS_KEY_FILE or MTLS_PFX_FILE.');
}

const sidecar = spawn(process.execPath, [serverEntry], {
  cwd: projectRoot,
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});

let shuttingDown = false;
function stopSidecar() {
  if (!shuttingDown && !sidecar.killed) {
    shuttingDown = true;
    sidecar.kill();
  }
}

process.on('SIGINT', stopSidecar);
process.on('SIGTERM', stopSidecar);
process.on('exit', stopSidecar);

try {
  const deadline = Date.now() + 10_000;
  let ready = false;

  while (Date.now() < deadline) {
    if (sidecar.exitCode !== null) {
      throw new Error(`Sidecar exited before becoming ready (code ${sidecar.exitCode}).`);
    }

    try {
      const response = await fetch('http://127.0.0.1:8787/readyz');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The loopback listener may still be starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (!ready) {
    throw new Error('Sidecar did not become ready within 10 seconds.');
  }

  const command = process.platform === 'win32'
    ? path.join(process.env.APPDATA, 'npm', 'opencode.cmd')
    : 'opencode';
  const opencode = spawn(command, process.argv.slice(2), {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
  });

  const exitCode = await new Promise((resolve, reject) => {
    opencode.once('error', reject);
    opencode.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  stopSidecar();
}

