import { spawn } from 'node:child_process';
import path from 'node:path';

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!child || child.exitCode !== null) return resolve();
    const timeout = setTimeout(() => reject(new Error('Sidecar did not close gracefully')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForHealth(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

export class SidecarProcessManager {
  constructor({ projectRoot, envFile, settingsFile, managed = false }) {
    this.projectRoot = projectRoot;
    this.envFile = envFile;
    this.settingsFile = settingsFile;
    this.managed = managed;
    this.child = undefined;
    this.external = false;
  }

  status() {
    return {
      managed: this.managed && !this.external,
      external: this.external,
      running: this.external || Boolean(this.child && this.child.exitCode === null),
    };
  }

  async start(port) {
    if (!this.managed) return { managed: false, restarted: false, restartRequired: true };
    if (this.child && this.child.exitCode === null) return { managed: true, restarted: false, running: true };
    if (await waitForHealth(port, 1_000)) {
      this.external = true;
      return { managed: false, external: true, restarted: false, restartRequired: true, running: true };
    }
    this.external = false;
    const args = [];
    if (this.envFile) args.push(`--env-file=${this.envFile}`);
    args.push(path.join(this.projectRoot, 'src', 'server.mjs'));
    this.child = spawn(process.execPath, args, {
      cwd: this.projectRoot,
      env: { ...process.env, SIDECAR_SETTINGS_FILE: this.settingsFile },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    const healthy = await waitForHealth(port);
    if (!healthy) throw new Error('Sidecar did not become healthy after start');
    return { managed: true, restarted: false, running: true };
  }

  async stop() {
    if (!this.managed || this.external || !this.child || this.child.exitCode !== null) return;
    if (!this.child.connected) throw new Error('Managed sidecar IPC channel is unavailable');
    this.child.send({ type: 'shutdown' });
    await waitForExit(this.child, 5_000);
    this.child = undefined;
  }

  async restart(port) {
    if (!this.managed || this.external) return { managed: false, external: this.external, restarted: false, restartRequired: true };
    await this.stop();
    await this.start(port);
    return { managed: true, restarted: true, restartRequired: false };
  }
}
