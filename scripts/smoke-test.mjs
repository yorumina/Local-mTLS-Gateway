import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sidecarKey = 'smoke-sidecar-key-12345';
let mockServer;
let sidecarProcess;
const observed = [];

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

    if (request.url === '/v1/models' && request.method === 'GET') {
      const payload = JSON.stringify({ object: 'list', data: [{ id: 'Qwen3.6-smoke', object: 'model' }] });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
      return;
    }

    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      const parsed = JSON.parse(body || '{}');
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
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: { get: (name) => response.headers[String(name).toLowerCase()] ?? null },
        body: Buffer.concat(chunks).toString('utf8'),
        rawBody: Buffer.concat(chunks),
      }));
    });
    outgoing.once('error', reject);
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

  const deniedRoute = await request(sidecarPort, '/admin');
  assert(deniedRoute.status === 404, 'unlisted route should be rejected');

  const queryCredential = await request(sidecarPort, '/v1/models?api_key=leak');
  assert(queryCredential.status === 400, 'credential query string should be rejected');

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
