import path from 'node:path';

export const DEFAULT_SAFE_CONFIG = Object.freeze({
  host: '127.0.0.1',
  upstreamBaseUrl: 'https://llm.yorumina.com',
  port: 8787,
  maxBodyBytes: 16 * 1024 * 1024,
  upstreamTimeoutMs: 120_000,
  identityType: 'pfx',
  mtlsCertFile: '',
  mtlsKeyFile: '',
  mtlsCaFile: '',
  mtlsPfxFile: '',
});

function error(field, message) {
  return { field, message };
}

function asTrimmedString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asNumber(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  return typeof value === 'number' ? value : Number(value);
}

export function settingsFromEnvironment(env = process.env) {
  const hasPfx = Boolean(env.MTLS_PFX_FILE);
  return {
    host: env.HOST ?? DEFAULT_SAFE_CONFIG.host,
    upstreamBaseUrl: env.UPSTREAM_BASE_URL ?? DEFAULT_SAFE_CONFIG.upstreamBaseUrl,
    port: asNumber(env.PORT, DEFAULT_SAFE_CONFIG.port),
    maxBodyBytes: asNumber(env.MAX_BODY_BYTES, DEFAULT_SAFE_CONFIG.maxBodyBytes),
    upstreamTimeoutMs: asNumber(env.UPSTREAM_TIMEOUT_MS, DEFAULT_SAFE_CONFIG.upstreamTimeoutMs),
    identityType: hasPfx ? 'pfx' : 'pem',
    mtlsCertFile: env.MTLS_CERT_FILE ?? '',
    mtlsKeyFile: env.MTLS_KEY_FILE ?? '',
    mtlsCaFile: env.MTLS_CA_FILE ?? '',
    mtlsPfxFile: env.MTLS_PFX_FILE ?? '',
  };
}

export function normalizeSafeConfig(input = {}, fallback = DEFAULT_SAFE_CONFIG) {
  return {
    host: '127.0.0.1',
    upstreamBaseUrl: asTrimmedString(input.upstreamBaseUrl, fallback.upstreamBaseUrl),
    port: asNumber(input.port, fallback.port),
    maxBodyBytes: asNumber(input.maxBodyBytes, fallback.maxBodyBytes),
    upstreamTimeoutMs: asNumber(input.upstreamTimeoutMs, fallback.upstreamTimeoutMs),
    identityType: asTrimmedString(input.identityType, fallback.identityType).toLowerCase(),
    mtlsCertFile: asTrimmedString(input.mtlsCertFile, fallback.mtlsCertFile),
    mtlsKeyFile: asTrimmedString(input.mtlsKeyFile, fallback.mtlsKeyFile),
    mtlsCaFile: asTrimmedString(input.mtlsCaFile, fallback.mtlsCaFile),
    mtlsPfxFile: asTrimmedString(input.mtlsPfxFile, fallback.mtlsPfxFile),
  };
}

function validatePath(value, field, errors) {
  if (!value) return;
  if (value.includes('\0')) errors.push(error(field, 'Path contains a forbidden null character'));
  if (!path.isAbsolute(value)) errors.push(error(field, 'An absolute file path is required'));
}

export function validateSafeConfig(input, {
  testMode = false,
  requireIdentity = true,
  allowZeroPort = false,
} = {}) {
  const config = normalizeSafeConfig(input);
  const errors = [];
  const warnings = [];

  if (input?.host !== undefined && input.host !== '127.0.0.1') {
    errors.push(error('host', 'Local interface is locked to 127.0.0.1'));
  }

  let parsedUpstream;
  try {
    parsedUpstream = new URL(config.upstreamBaseUrl);
    if (parsedUpstream.username || parsedUpstream.password) {
      errors.push(error('upstreamBaseUrl', 'Embedded URL credentials are forbidden'));
    }
    if (parsedUpstream.protocol !== 'https:') {
      const allowedTestHttp = testMode
        && parsedUpstream.protocol === 'http:'
        && ['127.0.0.1', 'localhost', '::1'].includes(parsedUpstream.hostname);
      if (!allowedTestHttp) errors.push(error('upstreamBaseUrl', 'HTTPS is required'));
    }
  } catch {
    errors.push(error('upstreamBaseUrl', 'A valid upstream URL is required'));
  }

  const minimumPort = allowZeroPort ? 0 : 1;
  if (!Number.isSafeInteger(config.port) || config.port < minimumPort || config.port > 65535) {
    errors.push(error('port', `Port must be between ${minimumPort} and 65535`));
  }
  if (!Number.isSafeInteger(config.maxBodyBytes) || config.maxBodyBytes < 1024 || config.maxBodyBytes > 256 * 1024 * 1024) {
    errors.push(error('maxBodyBytes', 'Maximum request body must be between 1 KB and 256 MB'));
  }
  if (!Number.isSafeInteger(config.upstreamTimeoutMs) || config.upstreamTimeoutMs < 1000 || config.upstreamTimeoutMs > 30 * 60 * 1000) {
    errors.push(error('upstreamTimeoutMs', 'Upstream timeout must be between 1 second and 30 minutes'));
  }

  if (!['pem', 'pfx'].includes(config.identityType)) {
    errors.push(error('identityType', 'Identity type must be PEM or PFX'));
  }

  for (const [field, value] of [
    ['mtlsCertFile', config.mtlsCertFile],
    ['mtlsKeyFile', config.mtlsKeyFile],
    ['mtlsCaFile', config.mtlsCaFile],
    ['mtlsPfxFile', config.mtlsPfxFile],
  ]) validatePath(value, field, errors);

  if (config.identityType === 'pem') {
    if (config.mtlsPfxFile) errors.push(error('mtlsPfxFile', 'PFX cannot be combined with PEM identity'));
    if (requireIdentity && !config.mtlsCertFile) errors.push(error('mtlsCertFile', 'PEM certificate path is required'));
    if (requireIdentity && !config.mtlsKeyFile) errors.push(error('mtlsKeyFile', 'PEM private key path is required'));
  } else if (config.identityType === 'pfx') {
    if (config.mtlsCertFile || config.mtlsKeyFile) {
      errors.push(error('identityType', 'PFX cannot be combined with PEM certificate or key paths'));
    }
    if (requireIdentity && !config.mtlsPfxFile) errors.push(error('mtlsPfxFile', 'PFX path is required'));
  }

  if (parsedUpstream?.hash) warnings.push({ field: 'upstreamBaseUrl', message: 'URL fragments are ignored by HTTP requests' });

  return { valid: errors.length === 0, errors, warnings, config };
}
