import assert from 'node:assert/strict';
import { validateSafeConfig } from '../src/config-validation.mjs';

const pfxBase = {
  upstreamBaseUrl: 'https://llm.yorumina.com',
  port: 8787,
  maxBodyBytes: 16 * 1024 * 1024,
  upstreamTimeoutMs: 120_000,
  identityType: 'pfx',
  mtlsPfxFile: 'C:\\certs\\client.pfx',
  mtlsCertFile: '',
  mtlsKeyFile: '',
  mtlsCaFile: '',
};

function errorsFor(config) {
  return validateSafeConfig(config).errors;
}

assert.equal(validateSafeConfig(pfxBase).valid, true, 'valid HTTPS PFX configuration should pass');
assert(errorsFor({ ...pfxBase, upstreamBaseUrl: 'http://llm.yorumina.com' }).some((item) => item.field === 'upstreamBaseUrl'), 'HTTP production URL should fail');
assert(errorsFor({ ...pfxBase, upstreamBaseUrl: 'https://user:pass@llm.yorumina.com' }).some((item) => item.message.includes('credentials')), 'embedded URL credentials should fail');
assert(errorsFor({ ...pfxBase, port: 70000 }).some((item) => item.field === 'port'), 'invalid port should fail');

const pemBase = {
  ...pfxBase,
  identityType: 'pem',
  mtlsPfxFile: '',
  mtlsCertFile: 'C:\\certs\\client.pem',
  mtlsKeyFile: 'C:\\certs\\client.key',
};
assert.equal(validateSafeConfig(pemBase).valid, true, 'valid PEM configuration should pass');
assert(errorsFor({ ...pemBase, mtlsKeyFile: '' }).some((item) => item.field === 'mtlsKeyFile'), 'PEM missing key should fail');
assert(errorsFor({ ...pemBase, mtlsCertFile: '' }).some((item) => item.field === 'mtlsCertFile'), 'PEM missing certificate should fail');
assert.equal(validateSafeConfig({ ...pemBase, mtlsPfxFile: 'C:\\certs\\client.pfx' }).valid, false, 'mixed PFX and PEM identity should fail');

console.log('config-test: passed (8 checks)');
