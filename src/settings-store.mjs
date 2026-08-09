import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SAFE_CONFIG,
  normalizeSafeConfig,
  settingsFromEnvironment,
  validateSafeConfig,
} from './config-validation.mjs';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const SETTINGS_FILE = path.join(PROJECT_ROOT, '.sidecar.local.json');
export const ENV_FILE = path.join(PROJECT_ROOT, '.env.local');
export const SECRET_NAMES = Object.freeze(['SIDECAR_API_KEY', 'UPSTREAM_API_KEY', 'MTLS_PASSPHRASE']);

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function readSettings({ filePath = SETTINGS_FILE, env = process.env } = {}) {
  const fallback = settingsFromEnvironment(env);
  const text = safeReadText(filePath);
  if (text === undefined) return normalizeSafeConfig(fallback, DEFAULT_SAFE_CONFIG);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Local settings file contains invalid JSON');
  }
  return normalizeSafeConfig(parsed, fallback);
}

function atomicWrite(filePath, text) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function writeSettings(settings, { filePath = SETTINGS_FILE } = {}) {
  const result = validateSafeConfig(settings);
  if (!result.valid) {
    const error = new Error('Configuration validation failed');
    error.validation = result;
    throw error;
  }
  atomicWrite(filePath, `${JSON.stringify(result.config, null, 2)}\n`);
  return result.config;
}

function parseEnvAssignments(text = '') {
  const configured = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !SECRET_NAMES.includes(match[1])) continue;
    const raw = match[2].trim();
    if (raw && raw !== '""' && raw !== "''") configured.add(match[1]);
  }
  return configured;
}

export function readSecretStatus({ filePath = ENV_FILE, env = process.env } = {}) {
  const configured = parseEnvAssignments(safeReadText(filePath));
  return {
    sidecarApiKeyConfigured: configured.has('SIDECAR_API_KEY') || Boolean(env.SIDECAR_API_KEY),
    upstreamApiKeyConfigured: configured.has('UPSTREAM_API_KEY') || Boolean(env.UPSTREAM_API_KEY),
    pfxPassphraseConfigured: configured.has('MTLS_PASSPHRASE') || Boolean(env.MTLS_PASSPHRASE),
  };
}

function serializeEnvValue(value) {
  return JSON.stringify(value);
}

export function updateSecrets(updates, { filePath = ENV_FILE } = {}) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('Secret updates must be an object');
  const allowed = new Map([
    ['sidecarApiKey', 'SIDECAR_API_KEY'],
    ['upstreamApiKey', 'UPSTREAM_API_KEY'],
    ['pfxPassphrase', 'MTLS_PASSPHRASE'],
  ]);
  const requested = [];
  for (const [field, value] of Object.entries(updates)) {
    const envName = allowed.get(field);
    if (!envName) throw new Error('Unknown secret field');
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Secret value is invalid');
    if (envName !== 'MTLS_PASSPHRASE' && value.length > 0 && value.length < 16) throw new Error('API keys must contain at least 16 characters');
    requested.push([envName, value]);
  }
  if (requested.length === 0) return { updated: [] };

  const original = safeReadText(filePath) ?? '';
  const lines = original.split(/\r?\n/);
  const remaining = new Map(requested);
  const next = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${serializeEnvValue(value)}`;
  });
  for (const [name, value] of remaining) next.push(`${name}=${serializeEnvValue(value)}`);
  atomicWrite(filePath, `${next.join('\n').replace(/\n+$/, '')}\n`);
  return { updated: requested.map(([name]) => name) };
}

export function snapshotFile(filePath) {
  const content = safeReadText(filePath);
  return { exists: content !== undefined, content };
}

export function restoreFile(filePath, snapshot) {
  if (snapshot.exists) atomicWrite(filePath, snapshot.content);
  else if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export function diffSettings(before, after) {
  const changes = [];
  for (const key of Object.keys(DEFAULT_SAFE_CONFIG)) {
    if (before[key] === after[key]) continue;
    changes.push({ field: key, before: before[key], after: after[key] });
  }
  return changes;
}
