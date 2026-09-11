import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { handleCompactionMock, runCompactionSmoke } from './opencode-compaction-smoke.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sidecarKey = 'smoke-sidecar-key-12345';
let mockServer;
let sidecarProcess;
const observed = [];
const budgetError = JSON.stringify({ error: { type: 'context_budget_exceeded', message: 'mock input plus output exceeds context' } });
const errorFixtures = {
  budget: { body: budgetError },
  code: { body: JSON.stringify({ error: { code: 'context_budget_exceeded' } }) },
  chunked: { body: budgetError, chunked: true },
  unrelated: { body: '{ "error": { "type": "invalid_request_error", "message": "invalid parameter" } }' },
  malformed: { body: '{ "error":' },
  large: { body: JSON.stringify({ error: { type: 'context_budget_exceeded', message: 'x'.repeat(70000) } }) },
  largeChunked: { body: JSON.stringify({ error: { type: 'context_budget_exceeded', message: 'x'.repeat(70000) } }), chunked: true },
  unauthorized: { body: budgetError, status: 401 },
  rateLimit: { body: budgetError, status: 429 },
  html: { body: budgetError, contentType: 'text/html' },
  compressed: { body: gzipSync(budgetError), contentEncoding: 'gzip' },
  aborted: { body: budgetError, aborted: true },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function collectRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

function createMockGateway() {
  return http.createServer(async (request, response) => {
    const body = await collectRequestBody(request);
    observed.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body,
    });

    const fixture = errorFixtures[request.headers['x-client-request-id']];
    if (fixture) {
      const rawBody = Buffer.from(fixture.body);
      response.writeHead(fixture.status ?? 400, {
        'content-type': fixture.contentType ?? 'application/json; charset=utf-8',
        ...(fixture.chunked ? {} : { 'content-length': rawBody.length }),
        ...(fixture.contentEncoding ? { 'content-encoding': fixture.contentEncoding } : {}),
        etag: '"mock-original"',
        'last-modified': 'Sun, 06 Sep 2026 00:00:00 GMT',
        'x-request-id': 'mock-request-id',
      });
      response.write(rawBody.subarray(0, 11));
      setImmediate(() => {
        if (fixture.aborted) response.destroy();
        else response.end(rawBody.subarray(11));
      });
      return;
    }

    if (request.url === '/v1/models' && request.method === 'GET') {
      const payload = JSON.stringify({ object: 'list', data: [{ id: 'Qwen3.6-smoke', object: 'model' }] });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
      return;
    }

    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      const parsed = JSON.parse(body || '{}');
      if (handleCompactionMock(parsed, response)) return;
      if (parsed.stream === true) {
        response.writeHead(200, {
          'cache-control': 'no-cache',
          'content-type': 'text/event-stream',
        });
        response.write('data: {"id":"smoke","choices":[{"delta":{"content":"ok"}}]}\n\n');
        response.end('data: [DONE]\n\n');
        return;
      }
      const payload = JSON.stringify({
        id: 'chatcmpl-smoke',
        object: 'chat.completion',
        model: parsed.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
      return;
    }

    if (request.url === '/v1/responses' && request.method === 'POST') {
      const payload = JSON.stringify({ id: 'resp-smoke', object: 'response', status: 'completed', output: [] });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
      return;
    }

    if (request.url === '/v1/audio/speech' && request.method === 'POST') {
      const audio = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
      response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
      response.end(audio);
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('sidecar did not start in time')), 5_000);
    const onData = (chunk) => {
      output += chunk.toString();
      for (const line of output.split(/\r?\n/)) {
        if (!line.includes('"event":"listening"')) continue;
        try {
          const record = JSON.parse(line);
          clearTimeout(timeout);
          resolve(record.port);
          return;
        } catch {
          // Wait for a complete JSON line.
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`sidecar exited before listening (${code})`));
      }
    });
  });
}

async function request(port, route, { method = 'GET', key = sidecarKey, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (key !== null) requestHeaders.authorization = `Bearer ${key}`;
  if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    requestHeaders['content-length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: requestHeaders }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: { get: (name) => response.headers[String(name).toLowerCase()] ?? null },
        body: Buffer.concat(chunks).toString('utf8'),
        rawBody: Buffer.concat(chunks),
      }));
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('mock request timed out')));
    outgoing.end(body);
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function run() {
  mockServer = createMockGateway();
  const gatewayPort = await listen(mockServer);
  sidecarProcess = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      SIDECAR_API_KEY: sidecarKey,
      SIDECAR_TEST_MODE: 'true',
      SIDECAR_SETTINGS_FILE: path.join(root, '.smoke-test-settings-do-not-create.json'),
      UPSTREAM_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
      UPSTREAM_API_KEY: '',
      UPSTREAM_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sidecarPort = await waitForListening(sidecarProcess);

  const health = await request(sidecarPort, '/healthz', { key: null });
  assert(health.status === 200, 'healthz should be available locally');

  const unauthorized = await request(sidecarPort, '/v1/models', { key: null });
  assert(unauthorized.status === 401, 'missing API key should be rejected');
  assert(observed.length === 0, 'unauthorized request must not reach the gateway');

  const preflight = await request(sidecarPort, '/v1/chat/completions', {
    method: 'OPTIONS',
    key: null,
    headers: {
      origin: 'http://localhost:5173',
      'access-control-request-headers': 'authorization, content-type',
      'access-control-request-method': 'POST',
    },
  });
  assert(preflight.status === 204, 'local AIRI CORS preflight should succeed');
  assert(preflight.headers.get('access-control-allow-origin') === 'http://localhost:5173', 'CORS origin was not echoed');

  const rejectedPreflight = await request(sidecarPort, '/v1/chat/completions', {
    method: 'OPTIONS',
    key: null,
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
  });
  assert(rejectedPreflight.status === 403, 'non-local CORS origin should be rejected');

  const models = await request(sidecarPort, '/v1/models');
  assert(models.status === 200 && models.body.includes('Qwen3.6-smoke'), 'models response was not proxied');
  assert(observed.at(-1)?.authorization === `Bearer ${sidecarKey}`, 'inbound bearer was not forwarded');

  const completionBody = JSON.stringify({ model: 'Qwen3.6-smoke', messages: [{ role: 'user', content: 'ping' }] });
  const completion = await request(sidecarPort, '/v1/chat/completions', { method: 'POST', body: completionBody });
  assert(completion.status === 200 && completion.body.includes('chatcmpl-smoke'), 'JSON completion was not proxied');
  assert(observed.at(-1)?.body === completionBody, 'request body was changed unexpectedly');

  const reasoningBudgets = {
    none: 0,
    low: 512,
    medium: 2048,
    high: 8192,
    max: 32768,
  };
  for (const [effort, expectedBudget] of Object.entries(reasoningBudgets)) {
    const reasoningBody = JSON.stringify({
      model: 'Qwen3.6-smoke',
      messages: [{ role: 'user', content: effort }],
      reasoning_effort: effort,
    });
    const reasoning = await request(sidecarPort, '/v1/chat/completions', { method: 'POST', body: reasoningBody });
    assert(reasoning.status === 200, `${effort} reasoning request was not proxied`);
    const forwarded = JSON.parse(observed.at(-1)?.body ?? '{}');
    assert(forwarded.thinking_budget_tokens === expectedBudget, `${effort} reasoning budget was not mapped`);
    assert(forwarded.chat_template_kwargs?.enable_thinking === (expectedBudget > 0), `${effort} thinking toggle was not mapped`);
  }

  const explicitBudgetBody = JSON.stringify({
    model: 'Qwen3.6-smoke',
    messages: [{ role: 'user', content: 'explicit' }],
    reasoning_effort: 'low',
    thinking_budget_tokens: 1234,
  });
  await request(sidecarPort, '/v1/chat/completions', { method: 'POST', body: explicitBudgetBody });
  assert(observed.at(-1)?.body === explicitBudgetBody, 'explicit thinking budget should take precedence');

  const responseBody = JSON.stringify({ model: 'Qwen3.6-smoke', input: 'ping' });
  const responsesApi = await request(sidecarPort, '/v1/responses', { method: 'POST', body: responseBody });
  assert(responsesApi.status === 200 && responsesApi.body.includes('resp-smoke'), 'Responses API was not proxied');

  const speechBody = JSON.stringify({
    model: 'nyako-tts',
    input: '要講的內容',
    voice: 'nyako',
    instructions: '這一句的情緒和說話方式',
    response_format: 'mp3',
    speed: 1.0,
    stream_format: 'audio',
  });
  const speech = await request(sidecarPort, '/v1/audio/speech', {
    method: 'POST',
    body: speechBody,
    headers: { accept: 'audio/*' },
  });
  assert(speech.status === 200, 'TTS response was not proxied');
  assert(observed.at(-1)?.body === speechBody, 'TTS request body was changed unexpectedly');
  assert(speech.headers.get('content-type') === 'audio/mpeg', 'TTS content type was not preserved');
  assert(speech.rawBody.subarray(0, 3).toString('ascii') === 'ID3', 'TTS binary body was not preserved');

  const deniedAudioRoute = await request(sidecarPort, '/v1/audio/transcriptions', { method: 'POST', body: '{}' });
  assert(deniedAudioRoute.status === 404, 'unlisted audio route should be rejected');

  const streamBody = JSON.stringify({ model: 'Qwen3.6-smoke', messages: [{ role: 'user', content: 'stream' }], stream: true });
  const stream = await request(sidecarPort, '/v1/chat/completions', {
    method: 'POST',
    body: streamBody,
    headers: { accept: 'text/event-stream' },
  });
  assert(stream.status === 200 && stream.body.includes('data: [DONE]'), 'SSE completion was not proxied');

  for (const route of ['/v1/chat/completions', '/v1/completions', '/v1/responses']) {
    for (const name of ['budget', 'code', 'chunked']) {
      const result = await request(sidecarPort, route, {
        method: 'POST', body: streamBody,
        headers: { 'x-client-request-id': name, origin: 'http://localhost:5173' },
      });
      assert(result.status === 400, `${route}/${name}: context overflow must retain HTTP 400`);
      assert(JSON.parse(result.body).error.code === 'context_length_exceeded', `${route}/${name}: OpenCode overflow code missing`);
      assert(Number(result.headers.get('content-length')) === result.rawBody.length, `${route}/${name}: stale content length`);
      assert(result.headers.get('etag') === null && result.headers.get('last-modified') === null, `${route}/${name}: stale validators`);
      assert(result.headers.get('x-request-id') === 'mock-request-id', `${route}/${name}: request id lost`);
      assert(result.headers.get('access-control-allow-origin') === 'http://localhost:5173', `${route}/${name}: CORS lost`);
    }
  }
  for (const name of ['unrelated', 'malformed', 'large', 'largeChunked', 'unauthorized', 'rateLimit', 'html', 'compressed']) {
    const result = await request(sidecarPort, '/v1/chat/completions', {
      method: 'POST', body: completionBody, headers: { 'x-client-request-id': name },
    });
    assert(result.status === (errorFixtures[name].status ?? 400), `${name}: status changed`);
    assert(result.rawBody.equals(Buffer.from(errorFixtures[name].body)), `${name}: nonmatching error must pass through byte-for-byte`);
    assert(result.headers.get('etag') === '"mock-original"', `${name}: original headers changed`);
  }
  const speechError = await request(sidecarPort, '/v1/audio/speech', {
    method: 'POST', body: speechBody, headers: { 'x-client-request-id': 'budget' },
  });
  assert(speechError.body === budgetError, 'audio errors must not be normalized');
  const abortedError = await request(sidecarPort, '/v1/chat/completions', {
    method: 'POST', body: completionBody, headers: { 'x-client-request-id': 'aborted' },
  }).then(() => false, () => true);
  assert(abortedError, 'truncated error response must close instead of returning a complete error');
  assert((await request(sidecarPort, '/healthz', { key: null })).status === 200, 'sidecar must survive upstream abort');

  const deniedRoute = await request(sidecarPort, '/admin');
  assert(deniedRoute.status === 404, 'unlisted route should be rejected');

  const queryCredential = await request(sidecarPort, '/v1/models?api_key=leak');
  assert(queryCredential.status === 400, 'credential query string should be rejected');

  const executableIndex = process.argv.indexOf('--opencode-bin');
  if (executableIndex !== -1) {
    await runCompactionSmoke({ executable: process.argv[executableIndex + 1], sidecarPort, sidecarKey, root });
  }

  console.log('smoke-test: passed (loopback mock only; no real mTLS was used)');
}

try {
  await run();
} catch (error) {
  console.error(`smoke-test: failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stopChild(sidecarProcess);
  await closeServer(mockServer);
}
