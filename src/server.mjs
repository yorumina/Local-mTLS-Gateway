import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ConfigError, loadConfig } from './config.mjs';

const SERVICE_NAME = 'local-mtls-gateway';
const ALLOWED_ROUTES = new Map([
  ['/v1/models', new Set(['GET'])],
  ['/v1/chat/completions', new Set(['POST'])],
  ['/v1/completions', new Set(['POST'])],
  ['/v1/responses', new Set(['POST'])],
  ['/v1/embeddings', new Set(['POST'])],
  ['/v1/audio/speech', new Set(['POST'])],
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const RESPONSE_HEADER_ALLOWLIST = new Set([
  'cache-control',
  'content-encoding',
  'content-length',
  'content-type',
  'etag',
  'last-modified',
  'retry-after',
  'vary',
]);
const FORWARD_REQUEST_HEADERS = [
  'openai-beta',
  'x-client-request-id',
];
const CORS_ALLOWED_HEADERS = 'Authorization, Content-Type, OpenAI-Beta, X-Client-Request-Id';
const CORS_ALLOWED_METHODS = 'GET, POST, OPTIONS';
const REASONING_BUDGETS = new Map([
  ['none', 0],
  ['off', 0],
  ['low', 512],
  ['medium', 2048],
  ['high', 8192],
  ['max', 32768],
]);

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

let config;
try {
  config = loadConfig();
} catch (error) {
  const message = error instanceof ConfigError ? error.message : 'configuration failed';
  console.error(JSON.stringify({ event: 'config_error', service: SERVICE_NAME, message }));
  process.exit(1);
}

function log(event, fields = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: SERVICE_NAME,
    event,
    ...fields,
  }));
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': body.length,
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(body);
}

function isAllowedCorsOrigin(origin) {
  if (origin === 'null') return true;

  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function corsHeadersFor(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return {};
  if (!isAllowedCorsOrigin(origin)) return undefined;

  return {
    'access-control-allow-headers': CORS_ALLOWED_HEADERS,
    'access-control-allow-methods': CORS_ALLOWED_METHODS,
    'access-control-allow-origin': origin,
    'access-control-expose-headers': 'retry-after, x-request-id',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function sendCorsNoContent(response, corsHeaders) {
  response.writeHead(204, {
    ...corsHeaders,
    'content-length': '0',
  });
  response.end();
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBearer(authorization) {
  if (typeof authorization !== 'string') return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match || /[\r\n]/.test(match[1])) return undefined;
  return match[1];
}

function requireBearer(request) {
  const token = parseBearer(request.headers.authorization);
  if (!token || !constantTimeEqual(token, config.sidecarApiKey)) {
    throw new HttpError(401, 'unauthorized', 'a valid bearer token is required');
  }
  return token;
}

function containsCredentialQuery(searchParams) {
  for (const key of searchParams.keys()) {
    if (/(?:^|[_-])(api[_-]?key|token|secret|password|authorization)(?:$|[_-])/i.test(key)) {
      return true;
    }
  }
  return false;
}

function readBody(request) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isSafeInteger(declaredLength) && declaredLength > config.maxBodyBytes) {
    request.resume();
    throw new HttpError(413, 'body_too_large', 'request body exceeds the configured limit');
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > config.maxBodyBytes) {
        request.resume();
        fail(new HttpError(413, 'body_too_large', 'request body exceeds the configured limit'));
        return;
      }
      chunks.push(chunk);
    });
    request.once('aborted', () => fail(new HttpError(499, 'client_aborted', 'client aborted the request')));
    request.once('error', fail);
    request.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
  });
}

function upstreamPath(baseUrl, requestUrl) {
  const incoming = new URL(requestUrl, 'http://127.0.0.1');
  const prefix = baseUrl.pathname === '/' ? '' : baseUrl.pathname.replace(/\/+$/, '');
  const target = new URL(baseUrl.toString());
  target.pathname = `${prefix}${incoming.pathname}` || '/';
  target.search = incoming.search;
  target.hash = '';
  return target;
}

function buildRequestHeaders(request, body, upstreamAuthorization) {
  const headers = {
    accept: request.headers.accept ?? 'application/json',
    'accept-encoding': 'identity',
    authorization: upstreamAuthorization,
    'content-length': String(body.length),
    'user-agent': `${SERVICE_NAME}/0.1.0`,
  };
  if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string' && value.length <= 512) headers[name] = value;
  }
  return headers;
}

function applyReasoningBudget(requestUrl, body) {
  if (body.length === 0) return body;
  const path = new URL(requestUrl, 'http://127.0.0.1').pathname;
  if (path !== '/v1/chat/completions' && path !== '/v1/responses') return body;

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return body;
  if (Object.hasOwn(payload, 'thinking_budget_tokens')) return body;

  const effort = payload.reasoning_effort
    ?? payload.reasoningEffort
    ?? (payload.reasoning && typeof payload.reasoning === 'object' ? payload.reasoning.effort : undefined);
  if (typeof effort !== 'string') return body;
  const budget = REASONING_BUDGETS.get(effort.toLowerCase());
  if (budget === undefined) return body;

  return Buffer.from(JSON.stringify({
    ...payload,
    thinking_budget_tokens: budget,
    chat_template_kwargs: {
      ...(payload.chat_template_kwargs && typeof payload.chat_template_kwargs === 'object'
        ? payload.chat_template_kwargs
        : {}),
      enable_thinking: budget > 0,
    },
  }));
}

function requestUpstream(url, method, headers, body, signal) {
  const transport = url.protocol === 'https:' ? https : http;
  const options = {
    hostname: url.hostname,
    method,
    path: `${url.pathname}${url.search}`,
    port: url.port || undefined,
    headers,
    signal,
    timeout: config.upstreamTimeoutMs,
  };
  if (url.protocol === 'https:') {
    Object.assign(options, config.tls, {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let upstreamRequest;
    try {
      upstreamRequest = transport.request(options, (response) => {
        settled = true;
        resolve(response);
      });
      upstreamRequest.once('timeout', () => {
        const timeoutError = new Error('upstream request timed out');
        timeoutError.code = 'UPSTREAM_TIMEOUT';
        upstreamRequest.destroy(timeoutError);
      });
      upstreamRequest.once('error', (error) => {
        if (!settled) reject(error);
      });
      upstreamRequest.end(body);
    } catch (error) {
      reject(error);
    }
  });
}

function forwardResponseHeaders(upstreamResponse, response) {
  for (const [name, value] of Object.entries(upstreamResponse.headers)) {
    const lowerName = name.toLowerCase();
    const isRateLimitHeader = lowerName.startsWith('x-ratelimit-');
    const isRequestIdHeader = lowerName === 'x-request-id';
    if (HOP_BY_HOP_HEADERS.has(lowerName)) continue;
    if (!RESPONSE_HEADER_ALLOWLIST.has(lowerName) && !isRateLimitHeader && !isRequestIdHeader) continue;
    if (value !== undefined) response.setHeader(name, value);
  }
}

function pipeResponse(upstreamResponse, response) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    upstreamResponse.once('end', finish);
    upstreamResponse.once('aborted', () => {
      if (!response.destroyed) response.destroy();
      finish();
    });
    upstreamResponse.once('error', () => {
      if (!response.destroyed) response.destroy();
      finish();
    });
    response.once('close', finish);
    upstreamResponse.pipe(response);
  });
}

function needsContextErrorCompatibility(upstreamResponse, requestUrl) {
  const pathname = new URL(requestUrl, 'http://127.0.0.1').pathname;
  return ['/v1/chat/completions', '/v1/completions', '/v1/responses'].includes(pathname)
    && upstreamResponse.statusCode === 400
    && /^application\/json(?:\s*;|$)/i.test(upstreamResponse.headers['content-type'] ?? '')
    && (!upstreamResponse.headers['content-encoding'] || upstreamResponse.headers['content-encoding'] === 'identity');
}

function contextErrorCompatibility(response) {
  // Inspect only small JSON failures. Successful SSE/audio keeps its streaming path.
  const maxBytes = 64 * 1024;
  let chunks = [];
  let size = 0;
  let passthrough = false;
  return new Transform({
    transform(chunk, encoding, callback) {
      if (passthrough) return callback(null, chunk);
      size += chunk.length;
      if (size > maxBytes) {
        passthrough = true;
        for (const buffered of chunks) this.push(buffered);
        chunks = [];
        return callback(null, chunk);
      }
      chunks.push(chunk);
      callback();
    },
    flush(callback) {
      if (passthrough) return callback();
      let body = Buffer.concat(chunks, size);
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { /* Preserve non-JSON bytes. */ }
      if (payload?.error?.type === 'context_budget_exceeded' || payload?.error?.code === 'context_budget_exceeded') {
        // OpenCode recognizes this standard code and can recover by compacting.
        body = Buffer.from(JSON.stringify({ error: {
          type: 'context_budget_exceeded',
          code: 'context_length_exceeded',
          message: 'This request exceeds the model context window. Compact the conversation or reduce the input.',
        } }));
        response.setHeader('content-length', body.length);
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.removeHeader('etag');
        response.removeHeader('last-modified');
        response.removeHeader('content-encoding');
      }
      callback(null, body);
    },
  });
}

async function proxyRequest(request, response, requestUrl, inboundToken) {
  const incomingBody = request.method === 'POST' ? await readBody(request) : Buffer.alloc(0);
  const body = applyReasoningBudget(requestUrl, incomingBody);
  const targetUrl = upstreamPath(config.upstreamBaseUrl, requestUrl);
  const upstreamToken = config.upstreamApiKey ?? inboundToken;
  const headers = buildRequestHeaders(request, body, `Bearer ${upstreamToken}`);
  const controller = new AbortController();
  const abortForClient = () => controller.abort();
  request.once('aborted', abortForClient);
  response.once('close', abortForClient);

  try {
    const upstreamResponse = await requestUpstream(targetUrl, request.method, headers, body, controller.signal);
    if (response.destroyed) {
      upstreamResponse.resume();
      return;
    }
    forwardResponseHeaders(upstreamResponse, response);
    response.statusCode = upstreamResponse.statusCode ?? 502;
    if (needsContextErrorCompatibility(upstreamResponse, requestUrl)) {
      await pipeline(upstreamResponse, contextErrorCompatibility(response), response);
    } else {
      response.writeHead(response.statusCode);
      await pipeResponse(upstreamResponse, response);
    }
  } finally {
    request.off('aborted', abortForClient);
    response.off('close', abortForClient);
  }
}

async function handleRequest(request, response) {
  const startedAt = Date.now();
  let requestPath = 'invalid';
  let logged = false;
  const finishLog = (statusCode, errorCode) => {
    if (logged) return;
    logged = true;
    log('request_complete', {
      method: request.method,
      path: requestPath,
      status: statusCode,
      durationMs: Date.now() - startedAt,
      ...(errorCode ? { errorCode } : {}),
    });
  };
  const corsHeaders = corsHeadersFor(request);
  if (corsHeaders) {
    for (const [name, value] of Object.entries(corsHeaders)) response.setHeader(name, value);
  }
  response.once('finish', () => finishLog(response.statusCode));
  response.once('close', () => {
    if (!response.writableFinished) finishLog(response.statusCode || 499, 'client_closed');
  });

  try {
    const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    requestPath = parsedUrl.pathname;

    if (parsedUrl.pathname === '/healthz' || parsedUrl.pathname === '/readyz') {
      if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'GET is required');
      sendJson(response, 200, { status: 'ok', service: SERVICE_NAME });
      return;
    }

    const allowedMethods = ALLOWED_ROUTES.get(parsedUrl.pathname);
    if (!allowedMethods) throw new HttpError(404, 'not_found', 'route not found');
    if (request.method === 'OPTIONS') {
      if (corsHeaders === undefined) throw new HttpError(403, 'cors_origin_rejected', 'origin is not allowed');
      sendCorsNoContent(response, corsHeaders);
      return;
    }
    if (!allowedMethods.has(request.method)) {
      throw new HttpError(405, 'method_not_allowed', 'method is not allowed for this route');
    }
    if (containsCredentialQuery(parsedUrl.searchParams)) {
      throw new HttpError(400, 'credential_query_rejected', 'credentials are not accepted in the query string');
    }

    const inboundToken = requireBearer(request);
    await proxyRequest(request, response, request.url ?? '/', inboundToken);
  } catch (error) {
    const statusCode = error instanceof HttpError
      ? error.statusCode
      : error?.code === 'UPSTREAM_TIMEOUT'
        ? 504
        : 502;
    const errorCode = error instanceof HttpError ? error.code : error?.code ?? 'upstream_error';
    if (!response.headersSent && !response.destroyed) {
      sendJson(response, statusCode, { error: { message: error instanceof HttpError ? error.message : 'upstream request failed', type: errorCode } });
    } else if (!response.destroyed) {
      response.destroy();
    }
    finishLog(statusCode, errorCode);
  }
}

const server = http.createServer((request, response) => {
  void handleRequest(request, response);
});
server.headersTimeout = 30_000;
server.requestTimeout = config.upstreamTimeoutMs + 10_000;
server.keepAliveTimeout = 5_000;

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  log('client_error', { errorCode: error?.code ?? 'client_error' });
});

function shutdown(signal) {
  log('shutdown_requested', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('message', (message) => {
  if (message?.type === 'shutdown') shutdown('IPC');
});

server.listen(config.port, config.host, () => {
  const address = server.address();
  log('listening', {
    host: config.host,
    port: typeof address === 'object' && address ? address.port : config.port,
    upstream: config.upstreamBaseUrl.origin,
    mtls: !config.testMode,
  });
});

server.on('error', (error) => {
  log('server_error', { errorCode: error?.code ?? 'server_error' });
  process.exitCode = 1;
});
