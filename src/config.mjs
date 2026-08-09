import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isTrue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function integerEnv(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be a non-negative integer`);
  }
  const value = Number(raw);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ConfigError(`${name} is outside the supported range`);
  }
  return value;
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

export function loadConfig() {
  const testMode = isTrue(process.env.SIDECAR_TEST_MODE);
  const errors = [];
  const host = process.env.HOST ?? '127.0.0.1';
  const port = integerEnv('PORT', 8787, { allowZero: testMode });

  if (host !== '127.0.0.1') {
    errors.push('HOST must remain 127.0.0.1');
  }
  if (port > 65535) errors.push('PORT is outside the supported range');

  const sidecarApiKey = process.env.SIDECAR_API_KEY ?? '';
  validateToken(sidecarApiKey, 'SIDECAR_API_KEY', errors, { required: true });

  const upstreamApiKey = process.env.UPSTREAM_API_KEY ?? '';
  validateToken(upstreamApiKey, 'UPSTREAM_API_KEY', errors);

  let upstreamBaseUrl;
  try {
    upstreamBaseUrl = new URL(process.env.UPSTREAM_BASE_URL ?? 'https://llm.yorumina.com');
    if (upstreamBaseUrl.username || upstreamBaseUrl.password) {
      errors.push('UPSTREAM_BASE_URL must not contain embedded credentials');
    }
    if (!['https:', 'http:'].includes(upstreamBaseUrl.protocol)) {
      errors.push('UPSTREAM_BASE_URL must use HTTPS');
    }
    if (upstreamBaseUrl.protocol !== 'https:' && !testMode) {
      errors.push('HTTP upstream is allowed only in SIDECAR_TEST_MODE');
    }
  } catch {
    errors.push('UPSTREAM_BASE_URL is invalid');
  }

  const certFile = resolveConfiguredPath(process.env.MTLS_CERT_FILE);
  const keyFile = resolveConfiguredPath(process.env.MTLS_KEY_FILE);
  const caFile = resolveConfiguredPath(process.env.MTLS_CA_FILE);
  const pfxFile = resolveConfiguredPath(process.env.MTLS_PFX_FILE);
  const passphrase = process.env.MTLS_PASSPHRASE ?? '';

  if (!testMode) {
    if (pfxFile && (certFile || keyFile)) {
      errors.push('use either MTLS_PFX_FILE or MTLS_CERT_FILE + MTLS_KEY_FILE, not both');
    } else if (!pfxFile && (!certFile || !keyFile)) {
      errors.push('formal mode requires MTLS_CERT_FILE + MTLS_KEY_FILE or MTLS_PFX_FILE');
    }
  }

  if (errors.length > 0) throw new ConfigError(errors.join('; '));

  const tls = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  if (!testMode) {
    if (pfxFile) {
      tls.pfx = readIdentityFile(pfxFile, 'MTLS_PFX_FILE');
      if (passphrase) tls.passphrase = passphrase;
    } else {
      tls.cert = readIdentityFile(certFile, 'MTLS_CERT_FILE');
      tls.key = readIdentityFile(keyFile, 'MTLS_KEY_FILE');
    }
    if (caFile) tls.ca = readIdentityFile(caFile, 'MTLS_CA_FILE');
  }

  return {
    host,
    port,
    maxBodyBytes: integerEnv('MAX_BODY_BYTES', 16 * 1024 * 1024),
    upstreamTimeoutMs: integerEnv('UPSTREAM_TIMEOUT_MS', 120_000),
    upstreamBaseUrl,
    sidecarApiKey: Buffer.from(sidecarApiKey, 'utf8'),
    upstreamApiKey: upstreamApiKey || undefined,
    testMode,
    tls,
  };
}
