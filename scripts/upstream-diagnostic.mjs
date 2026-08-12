import http from 'node:http';
import https from 'node:https';
import { loadConfig } from '../src/config.mjs';

function request(config) {
  const url = new URL('/v1/models', config.upstreamBaseUrl);
  const transport = url.protocol === 'https:' ? https : http;
  const options = {
    hostname: url.hostname,
    port: url.port || undefined,
    path: url.pathname,
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.upstreamApiKey ?? config.sidecarApiKey.toString('utf8')}`,
    },
    timeout: Math.min(config.upstreamTimeoutMs, 15_000),
    ...config.tls,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };
  return new Promise((resolve, reject) => {
    const req = transport.request(options, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'UPSTREAM_TIMEOUT' })));
    req.once('error', reject);
    req.end();
  });
}

try {
  const status = await request(loadConfig());
  console.log(JSON.stringify({
    level: status >= 200 && status < 300 ? 'Healthy' : 'Failed',
    httpsReachable: true,
    mtlsHandshake: true,
    status,
  }));
} catch (error) {
  console.log(JSON.stringify({ level: 'Failed', httpsReachable: false, mtlsHandshake: false, errorCode: error.code ?? 'upstream_failed' }));
}
