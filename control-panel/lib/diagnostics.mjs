import { spawn } from 'node:child_process';
import path from 'node:path';

const MAX_OUTPUT = 64 * 1024;

export function runNpmScript(projectRoot, scriptName) {
  if (!['check', 'smoke', 'test:config', 'test:control'].includes(scriptName)) throw new Error('Diagnostic is not allowed');
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(command, ['run', scriptName], {
      cwd: projectRoot,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const startedAt = Date.now();
    let output = '';
    const collect = (chunk) => {
      if (output.length >= MAX_OUTPUT) return;
      output += chunk.toString('utf8').slice(0, MAX_OUTPUT - output.length);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => resolve({ passed: false, durationMs: Date.now() - startedAt, errorCode: error.code ?? 'spawn_failed' }));
    child.once('exit', (code) => resolve({
      passed: code === 0,
      durationMs: Date.now() - startedAt,
      summary: output.split(/\r?\n/).filter(Boolean).slice(-3).join('\n'),
      errorCode: code === 0 ? undefined : 'diagnostic_failed',
    }));
  });
}

export async function checkSidecarHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2500) });
    return { level: response.ok ? 'Healthy' : 'Failed', status: response.status };
  } catch {
    return { level: 'Unknown' };
  }
}

export function runUpstreamDiagnostic(projectRoot, envFile, settingsFile) {
  return new Promise((resolve) => {
    const args = [];
    if (envFile) args.push(`--env-file=${envFile}`);
    args.push(path.join(projectRoot, 'scripts', 'upstream-diagnostic.mjs'));
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: { ...process.env, SIDECAR_SETTINGS_FILE: settingsFile },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8').slice(0, 4096 - output.length); });
    child.once('error', (error) => resolve({ level: 'Failed', errorCode: error.code ?? 'spawn_failed' }));
    child.once('exit', () => {
      try { resolve(JSON.parse(output.trim())); }
      catch { resolve({ level: 'Failed', errorCode: 'invalid_diagnostic_result' }); }
    });
  });
}

export function pickIdentityFile(kind) {
  if (process.platform !== 'win32') return Promise.resolve({ canceled: true, unsupported: true });
  const filters = {
    certificate: 'Certificates (*.pem;*.crt;*.cer)|*.pem;*.crt;*.cer|All files (*.*)|*.*',
    privateKey: 'Private keys (*.key;*.pem)|*.key;*.pem|All files (*.*)|*.*',
    privateCa: 'CA certificates (*.pem;*.crt;*.cer)|*.pem;*.crt;*.cer|All files (*.*)|*.*',
    pfx: 'PKCS#12 identity (*.pfx;*.p12)|*.pfx;*.p12|All files (*.*)|*.*',
  };
  const filter = filters[kind];
  if (!filter) return Promise.reject(new Error('File picker type is not allowed'));
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    `$dialog.Filter = '${filter.replaceAll("'", "''")}'`,
    '$dialog.CheckFileExists = $true',
    '$dialog.Multiselect = $false',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-STA', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: false,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8').slice(0, 4096 - output.length); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error('File picker failed'));
      else resolve(output.trim() ? { canceled: false, path: output.trim() } : { canceled: true });
    });
  });
}
