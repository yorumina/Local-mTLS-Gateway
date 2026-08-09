import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsFromEnvironment, validateSafeConfig } from './config-validation.mjs';
import { readSettings, SETTINGS_FILE } from './settings-store.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function isTrue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function resolveConfiguredPath(value) {
  if (!value) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function readIdentityFile(filePath, label) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error('not a regular file');
    return fs.readFileSync(filePath);
  } catch {
    throw new ConfigError(`${label} is not readable`);
  }
}

function validateToken(value, name, errors, { required = false } = {}) {
  if (!value) {
    if (required) errors.push(`${name} is required`);
    return;
  }
  if (value.length < 16) errors.push(`${name} must contain at least 16 characters`);
  if (/[\r\n]/.test(value)) errors.push(`${name} contains a forbidden newline`);
}

export function loadConfigFromEnvironment(env = process.env, { settingsFile = SETTINGS_FILE } = {}) {
  const testMode = isTrue(env.SIDECAR_TEST_MODE);
  const errors = [];
  let safeInput;
  try {
    safeInput = fs.existsSync(settingsFile)
      ? readSettings({ filePath: settingsFile, env })
      : settingsFromEnvironment(env);
  } catch (error) {
    throw new ConfigError(error.message);
  }

  const validation = validateSafeConfig(safeInput, {
    testMode,
    requireIdentity: !testMode,
    allowZeroPort: testMode,
  });
  errors.push(...validation.errors.map(({ field, message }) => `${field}: ${message}`));

  const sidecarApiKey = env.SIDECAR_API_KEY ?? '';
  validateToken(sidecarApiKey, 'SIDECAR_API_KEY', errors, { required: true });
  const upstreamApiKey = env.UPSTREAM_API_KEY ?? '';
  validateToken(upstreamApiKey, 'UPSTREAM_API_KEY', errors);
  if (errors.length > 0) throw new ConfigError(errors.join('; '));

  const safe = validation.config;
  const certFile = resolveConfiguredPath(safe.mtlsCertFile);
  const keyFile = resolveConfiguredPath(safe.mtlsKeyFile);
  const caFile = resolveConfiguredPath(safe.mtlsCaFile);
  const pfxFile = resolveConfiguredPath(safe.mtlsPfxFile);
  const passphrase = env.MTLS_PASSPHRASE ?? '';
  const tls = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };

  if (!testMode) {
    if (safe.identityType === 'pfx') {
      tls.pfx = readIdentityFile(pfxFile, 'MTLS_PFX_FILE');
      if (passphrase) tls.passphrase = passphrase;
    } else {
      tls.cert = readIdentityFile(certFile, 'MTLS_CERT_FILE');
      tls.key = readIdentityFile(keyFile, 'MTLS_KEY_FILE');
    }
    if (caFile) tls.ca = readIdentityFile(caFile, 'MTLS_CA_FILE');
  }

  return {
    host: '127.0.0.1',
    port: safe.port,
    maxBodyBytes: safe.maxBodyBytes,
    upstreamTimeoutMs: safe.upstreamTimeoutMs,
    upstreamBaseUrl: new URL(safe.upstreamBaseUrl),
    sidecarApiKey: Buffer.from(sidecarApiKey, 'utf8'),
    upstreamApiKey: upstreamApiKey || undefined,
    testMode,
    tls,
  };
}

export function loadConfig() {
  return loadConfigFromEnvironment(process.env, {
    settingsFile: process.env.SIDECAR_SETTINGS_FILE || SETTINGS_FILE,
  });
}
