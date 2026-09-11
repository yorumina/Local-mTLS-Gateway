import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const calls = [];

export function handleCompactionMock(body, response) {
  const model = body.model;
  if (!['limit-disabled', 'limit-enabled', 'overflow-recovery', 'aux'].includes(model)) return false;
  const summary = JSON.stringify(body.messages).includes('The following is the conversation history:');
  const first = !calls.some((call) => call.model === model);
  const overflow = model === 'overflow-recovery' && first;
  calls.push({ model, summary, status: overflow ? 400 : 200 });
  if (overflow) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'context_budget_exceeded', message: 'mock budget exhausted' } }));
    return true;
  }
  const input = first && model.startsWith('limit-') ? 85000 : 100;
  const content = summary ? 'The user asked for OK. Reply OK to finish.' : 'OK';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = {
    id: 'chatcmpl-compaction-smoke', object: 'chat.completion.chunk', model, created: 1,
  };
  for (const data of [
    { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: input, completion_tokens: 10, total_tokens: input + 10 } },
  ]) response.write(`data: ${JSON.stringify(data)}\n\n`);
  response.end('data: [DONE]\n\n');
  return true;
}

function runCli(executable, args, options, allowRecoveryExit = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrBytes = 0;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('isolated OpenCode check exceeded 60 seconds'));
    }, 60000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    child.once('error', (error) => { clearTimeout(timeout); reject(new Error(`OpenCode launch failed (${error.code})`)); });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !allowRecoveryExit) {
        const errors = stdout.split(/\r?\n/).flatMap((line) => {
          try {
            const event = JSON.parse(line);
            return event.type === 'error' ? [{ name: event.error?.name, message: event.error?.data?.message }] : [];
          } catch { return []; }
        });
        return reject(new Error(`isolated OpenCode exited ${code}; stderr bytes: ${stderrBytes}; mock errors: ${JSON.stringify(errors)}; calls: ${JSON.stringify(calls)}`));
      }
      resolve({ stdout, code });
    });
  });
}

export async function runCompactionSmoke({ executable, sidecarPort, sidecarKey, root }) {
  if (!path.isAbsolute(executable)) throw new Error('OpenCode executable must be an absolute path');
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-opencode-smoke-'));
  try {
    const env = {};
    // Do not inherit provider credentials, real OpenCode config, or user databases.
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    for (const [key, directory] of Object.entries({
      XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state',
      OPENCODE_TEST_HOME: 'home', APPDATA: 'roaming', LOCALAPPDATA: 'local', TEMP: 'tmp', TMP: 'tmp',
    })) {
      env[key] = path.join(temporaryRoot, directory);
      await fs.mkdir(env[key], { recursive: true });
    }
    const template = JSON.parse(await fs.readFile(path.join(root, 'opencode.json'), 'utf8'));
    const limit = template.provider.gb10.models['gb10-private-llm'].limit;
    const config = {
      $schema: 'https://opencode.ai/config.json',
      compaction: template.compaction, share: 'disabled', autoupdate: false,
      permission: 'deny', small_model: 'smoke/aux', enabled_providers: ['smoke'],
      provider: { smoke: {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: `http://127.0.0.1:${sidecarPort}/v1`, apiKey: sidecarKey },
        models: {
          'limit-disabled': { name: 'No context limit' },
          'limit-enabled': { name: 'Known context limit', limit },
          'overflow-recovery': { name: 'Overflow recovery', limit },
          aux: { name: 'Auxiliary', limit },
        },
      } },
    };
    env.OPENCODE_CONFIG = path.join(temporaryRoot, 'opencode.json');
    await fs.writeFile(env.OPENCODE_CONFIG, JSON.stringify(config));
    Object.assign(env, {
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
      OPENCODE_DB: path.join(temporaryRoot, 'opencode.db'),
    });
    const options = { cwd: temporaryRoot, env };
    // Verify config isolation before allowing inference, even though only fake secrets are used.
    const effective = JSON.parse((await runCli(executable, ['debug', 'config'], options)).stdout);
    if (Object.keys(effective.provider ?? {}).join() !== 'smoke' || effective.mcp && Object.keys(effective.mcp).length || effective.plugin?.length) {
      throw new Error('isolated OpenCode unexpectedly loaded external configuration');
    }
    for (const model of ['limit-disabled', 'limit-enabled', 'overflow-recovery']) {
      const { stdout, code } = await runCli(executable, ['run', '--format', 'json', '--model', `smoke/${model}`, 'Reply OK. Do not use tools.'], options, model === 'overflow-recovery');
      const observed = calls.filter((call) => call.model === model);
      const summaries = observed.filter((call) => call.summary).length;
      const events = stdout.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      const errors = events.filter((event) => event.type === 'error');
      // OpenCode 1.18.15 emits the recoverable error and retains CLI exit 1 even
      // after its session successfully compacts and continues. Assert that
      // limitation explicitly; never treat an arbitrary failed run as recovery.
      const recoverable = model === 'overflow-recovery' && code === 1 && errors.length === 1
        && errors[0].error?.name === 'ContextOverflowError';
      const text = events.some((event) => event.type === 'text' && event.part?.text?.includes('OK'));
      console.log(`opencode-compaction-smoke: ${JSON.stringify({ model, requests: observed.length, summaries, errors: errors.length, cliExitCode: code, recoveredWithCliError: recoverable, text })}`);
      if (!observed.length || ((code !== 0 || errors.length) && !recoverable) || !text || summaries !== (model === 'limit-disabled' ? 0 : 1)) {
        throw new Error(`OpenCode compaction behavior mismatch for ${model}`);
      }
      if (model !== 'limit-disabled' && !observed.some((call, index) => index > observed.findIndex((item) => item.summary) && !call.summary && call.status === 200)) {
        throw new Error(`OpenCode did not continue after compaction for ${model}`);
      }
    }
  } finally {
    const resolved = await fs.realpath(temporaryRoot);
    const expectedParent = await fs.realpath(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== expectedParent.toLowerCase() || !path.basename(resolved).startsWith('sidecar-opencode-smoke-')) {
      throw new Error('Refusing to clean up an unexpected temporary path');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
