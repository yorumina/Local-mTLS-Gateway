import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(projectRoot, 'src', 'server.mjs');
const desktopEntry = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Programs',
  '@opencode-aidesktop',
  'OpenCode.exe',
);

await access(serverEntry);
await access(desktopEntry);

let sidecar;
let ownsSidecar = false;
let stopping = false;
function stopSidecar() {
  if (!stopping && ownsSidecar && sidecar && !sidecar.killed) {
    stopping = true;
    sidecar.kill();
  }
}

process.on('SIGINT', stopSidecar);
process.on('SIGTERM', stopSidecar);
process.on('exit', stopSidecar);

try {
  let ready = false;
  try {
    const response = await fetch('http://127.0.0.1:8787/readyz');
    ready = response.ok;
  } catch {
    // No existing sidecar; start one below.
  }

  if (!ready) {
    ownsSidecar = true;
    sidecar = spawn(process.execPath, [serverEntry], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: process.platform === 'win32',
      windowsHide: true,
    });
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (ownsSidecar && sidecar.exitCode !== null) {
      throw new Error(`Sidecar exited before readiness (code ${sidecar.exitCode}).`);
    }
    try {
      const response = await fetch('http://127.0.0.1:8787/readyz');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The sidecar may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!ready) throw new Error('Sidecar did not become ready within 10 seconds.');

  if (process.platform === 'win32') {
    if (ownsSidecar) {
      sidecar.unref();
      ownsSidecar = false;
    }
    const desktop = spawn(desktopEntry, [], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'ignore',
      detached: true,
      windowsHide: false,
    });
    desktop.once('error', (error) => {
      console.error(`OpenCode Desktop failed to launch: ${error.message}`);
    });
    desktop.unref();
    console.log('OpenCode Desktop launched.');
  } else {
    const desktop = spawn(desktopEntry, [], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    });
    const exitCode = await new Promise((resolve, reject) => {
      desktop.once('error', reject);
      desktop.once('exit', (code) => resolve(code ?? 1));
    });
    process.exitCode = exitCode;
  }
} finally {
  stopSidecar();
}
