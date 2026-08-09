const state = {
  token: '',
  saved: null,
  draft: null,
  secretStatus: {},
  secretUpdates: {},
  status: null,
  busy: false,
};

const pageMeta = {
  overview: ['Overview', '本機 sidecar 的連線、安全與診斷狀態。'],
  connection: ['Connection', '設定安全的 upstream 與 loopback listener。'],
  identity: ['mTLS Identity', '管理 PEM 或 PFX identity 的外部檔案路徑。'],
  limits: ['Limits', '控制 request body 與 upstream timeout。'],
  opencode: ['OpenCode', '查看固定 provider 設定與 write-only API keys。'],
  diagnostics: ['Diagnostics', '執行本機檢查與真實 upstream 驗證。'],
  about: ['Settings / About', 'Control Panel 的版本與安全界線。'],
};

const labels = {
  upstreamBaseUrl: 'Upstream URL',
  port: 'Port',
  maxBodyBytes: 'Maximum Request Body',
  upstreamTimeoutMs: 'Upstream Timeout',
  identityType: 'mTLS Identity',
  mtlsCertFile: 'Certificate Path',
  mtlsKeyFile: 'Private Key Path',
  mtlsCaFile: 'Private CA Path',
  mtlsPfxFile: 'PFX Path',
};

function $(selector) { return document.querySelector(selector); }
function $$(selector) { return [...document.querySelectorAll(selector)]; }

async function api(route, { method = 'GET', body } = {}) {
  const options = { method, headers: {} };
  if (method !== 'GET') {
    options.headers['content-type'] = 'application/json';
    options.headers['x-sidecar-control-token'] = state.token;
    options.body = JSON.stringify(body ?? {});
  }
  const response = await fetch(route, options);
  const payload = await response.json().catch(() => ({ error: { message: 'Invalid server response' } }));
  if (!response.ok) {
    const error = new Error(payload.error?.message ?? `Request failed (${response.status})`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function statusClass(level) {
  if (['Healthy', 'Ready', 'Configured', 'Passed', 'Running'].includes(level)) return 'healthy';
  if (level === 'Warning') return 'warning';
  if (level === 'Failed') return 'failed';
  return 'unknown';
}

function setStatus(element, level, label = level) {
  if (!element) return;
  element.classList.remove('healthy', 'warning', 'failed', 'unknown');
  element.classList.add(statusClass(level));
  const dot = element.querySelector('.status-dot');
  if (dot) dot.className = `status-dot ${statusClass(level)}`;
  const textNode = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
  if (textNode) textNode.textContent = label;
  else element.textContent = label;
}

function setDiagnosticIcon(id, level, glyph) {
  const icon = $(id);
  icon.className = `diagnostic-icon ${statusClass(level)}`;
  icon.textContent = glyph;
}

function toast(title, message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  const strong = document.createElement('strong');
  strong.textContent = title;
  const span = document.createElement('span');
  span.textContent = message;
  item.append(strong, span);
  $('#toast-stack').append(item);
  setTimeout(() => item.remove(), 5200);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function humanTimeout(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minutes` : `${Math.round(ms / 1000)} seconds`;
}

function formatValue(field, value) {
  if (field === 'maxBodyBytes') return humanBytes(Number(value));
  if (field === 'upstreamTimeoutMs') return humanTimeout(Number(value));
  if (field === 'identityType') return String(value).toUpperCase();
  return value === '' ? 'Not configured' : String(value);
}

function configChanges() {
  if (!state.saved || !state.draft) return [];
  return Object.keys(labels)
    .filter((field) => state.saved[field] !== state.draft[field])
    .map((field) => ({ field, before: state.saved[field], after: state.draft[field], secret: false }));
}

function secretChanges() {
  return Object.entries(state.secretUpdates)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([field]) => ({ field, before: 'Configured', after: 'Updated', secret: true }));
}

function allChanges() { return [...configChanges(), ...secretChanges()]; }

function renderApplyBar() {
  const changes = allChanges();
  $('#apply-bar').hidden = changes.length === 0;
  $('#change-count').textContent = `${changes.length} unsaved change${changes.length === 1 ? '' : 's'}`;
}

function updateLimitDisplays() {
  $('#body-size-human').textContent = humanBytes(Number(state.draft.maxBodyBytes));
  $('#timeout-human').textContent = humanTimeout(Number(state.draft.upstreamTimeoutMs));
  $('#body-size-range').value = Math.max(1, Math.min(256, Math.round(Number(state.draft.maxBodyBytes) / 1024 / 1024)));
  $('#timeout-range').value = Math.max(1, Math.min(1800, Math.round(Number(state.draft.upstreamTimeoutMs) / 1000)));
}

function renderIdentity() {
  const isPem = state.draft.identityType === 'pem';
  $$('[data-identity]').forEach((button) => button.classList.toggle('active', button.dataset.identity === state.draft.identityType));
  $('#pem-fields').hidden = !isPem;
  $('#pfx-fields').hidden = isPem;
}

function renderForm() {
  $$('[data-field]').forEach((input) => {
    input.value = state.draft[input.dataset.field] ?? '';
  });
  renderIdentity();
  updateLimitDisplays();
  $('#overview-port').textContent = `Port ${state.draft.port}`;
  $('#opencode-base-url').textContent = `http://127.0.0.1:${state.draft.port}/v1`;
  $('#about-port').textContent = state.draft.port;
}

function renderSecretStatus() {
  const mapping = [
    ['#secret-sidecar-status', state.secretStatus.sidecarApiKeyConfigured],
    ['#secret-upstream-status', state.secretStatus.upstreamApiKeyConfigured],
    ['#secret-passphrase-status', state.secretStatus.pfxPassphraseConfigured],
  ];
  for (const [selector, configured] of mapping) {
    const element = $(selector);
    element.textContent = configured ? 'Configured ✓' : 'Not configured';
    element.className = configured ? 'healthy' : 'unknown';
  }
  $('#pfx-passphrase-hint').textContent = state.secretStatus.pfxPassphraseConfigured
    ? 'Configured · leave blank to keep current'
    : 'Not configured · write-only';
}

function renderStatus() {
  if (!state.status) return;
  const sidecar = state.status.sidecar?.level ?? 'Unknown';
  setStatus($('#global-status'), sidecar, sidecar);
  setStatus($('#overview-running'), sidecar, sidecar === 'Healthy' ? 'Running' : sidecar);
  setStatus($('#local-status'), sidecar, sidecar);
  const upstreamLevel = state.status.upstream?.level ?? 'Unknown';
  setStatus($('#upstream-status'), upstreamLevel, upstreamLevel);
  $('#upstream-host').textContent = state.status.upstream?.url ?? 'Unknown';
  const identity = state.status.identity ?? { level: 'Unknown' };
  $('#identity-label').textContent = `${(identity.identityType ?? state.draft.identityType).toUpperCase()} Identity`;
  $('#identity-configured').textContent = identity.configured ? 'Configured' : 'Not configured';
  setStatus($('#identity-status'), identity.level, identity.level);
  setStatus($('#certificate-status'), identity.level, identity.level);
  $('#certificate-type').textContent = (identity.identityType ?? state.draft.identityType).toUpperCase();
  $('#certificate-configured').textContent = identity.configured ? 'Yes' : 'No';
  const policy = state.status.policy?.level ?? 'Unknown';
  $('#policy-value').textContent = policy === 'Healthy' ? 'Passed' : policy === 'Unknown' ? 'Not run' : policy;
  setStatus($('#policy-status'), policy, policy);
  $('#health-output').textContent = `Local Sidecar: ${sidecar}`;
  setDiagnosticIcon('#health-icon', sidecar, sidecar === 'Healthy' ? '✓' : '●');
}

async function refresh() {
  const [config, secretStatus, status] = await Promise.all([
    api('/api/config'),
    api('/api/secrets/status'),
    api('/api/status'),
  ]);
  state.saved = config;
  state.draft = clone(config);
  state.secretStatus = secretStatus;
  state.secretUpdates = {};
  state.status = status;
  $$('[data-secret]').forEach((input) => { input.value = ''; });
  renderForm();
  renderSecretStatus();
  renderStatus();
  renderApplyBar();
}

async function validateDraft(showSuccess = true) {
  const result = await api('/api/config/validate', { method: 'POST', body: { config: state.draft } });
  if (result.valid) {
    $('#validation-output').textContent = result.warnings.length ? `Valid with ${result.warnings.length} warning(s)` : 'Valid ✓';
    if (showSuccess) toast('Configuration valid', 'All authoritative validation checks passed.');
    return true;
  }
  const details = result.errors.map((item) => `${item.field}: ${item.message}`).join('\n');
  $('#validation-output').textContent = details;
  toast('Configuration invalid', result.errors[0]?.message ?? 'Check the highlighted values.', 'error');
  return false;
}

function renderDiff() {
  const container = $('#diff-list');
  container.textContent = '';
  for (const change of allChanges()) {
    const item = document.createElement('div');
    item.className = 'diff-item';
    const label = document.createElement('strong');
    label.textContent = change.secret ? change.field.replace(/([A-Z])/g, ' $1') : labels[change.field];
    const values = document.createElement('div');
    values.className = 'diff-values';
    const before = document.createElement('code');
    before.textContent = change.secret ? 'Configured' : formatValue(change.field, change.before);
    const arrow = document.createElement('i');
    arrow.textContent = '→';
    const after = document.createElement('code');
    after.textContent = change.secret ? 'Updated' : formatValue(change.field, change.after);
    values.append(before, arrow, after);
    item.append(label, values);
    container.append(item);
  }
}

async function reviewChanges() {
  if (!(await validateDraft(false))) return;
  renderDiff();
  $('#diff-modal').hidden = false;
}

function setBusy(busy) {
  state.busy = busy;
  $$('#apply-bar button, #diff-modal button').forEach((button) => { button.disabled = busy; });
  $('#confirm-apply').textContent = busy ? 'Applying…' : 'Apply & Restart';
}

async function applyChanges() {
  setBusy(true);
  try {
    const secrets = Object.fromEntries(Object.entries(state.secretUpdates).filter(([, value]) => value));
    const result = await api('/api/config/apply', { method: 'POST', body: { config: state.draft, secrets } });
    $('#diff-modal').hidden = true;
    const restartMessage = result.restart?.restartRequired
      ? '設定已套用；目前 sidecar 不是由 Control Panel 管理，需要重新啟動。'
      : '設定、policy check 與受控重新啟動均已完成。';
    toast('Configuration applied', restartMessage, result.restart?.restartRequired ? 'success' : 'success');
    await refresh();
  } catch (error) {
    toast('Configuration could not be applied', error.message || 'Your previous configuration is still active.', 'error');
  } finally {
    setBusy(false);
  }
}

async function runDiagnostic(name, button) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Running…';
  try {
    if (name === 'validate') {
      await validateDraft();
    } else if (name === 'health') {
      state.status = await api('/api/status');
      renderStatus();
      toast('Health refreshed', `Local sidecar: ${state.status.sidecar.level}`);
    } else {
      const route = `/api/diagnostics/${name}`;
      const result = await api(route, { method: 'POST', body: {} });
      if (name === 'policy-check') {
        $('#policy-output').textContent = result.summary || (result.passed ? 'Passed' : 'Failed');
        setDiagnosticIcon('#policy-icon', result.level, result.passed ? '✓' : '×');
      } else if (name === 'smoke') {
        $('#smoke-output').textContent = `${result.summary || (result.passed ? 'Passed' : 'Failed')}\nRemote mTLS verified: No`;
        setDiagnosticIcon('#smoke-icon', result.level, result.passed ? '✓' : '×');
      } else if (name === 'upstream') {
        $('#upstream-output').textContent = result.level === 'Healthy'
          ? `HTTPS reachable\nmTLS handshake: Success\nHTTP ${result.status}`
          : `Failed\n${result.errorCode ?? 'upstream_failed'}`;
        setDiagnosticIcon('#upstream-icon', result.level, result.level === 'Healthy' ? '✓' : '×');
      }
      toast('Diagnostic complete', `${name}: ${result.level ?? (result.passed ? 'Healthy' : 'Failed')}`);
      state.status = await api('/api/status');
      renderStatus();
    }
  } catch (error) {
    toast('Diagnostic failed', error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function bindEvents() {
  $$('.nav-item[data-page]').forEach((button) => button.addEventListener('click', () => {
    const page = button.dataset.page;
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
    $$('.page').forEach((panel) => panel.classList.toggle('active', panel.dataset.pagePanel === page));
    $('#page-title').textContent = pageMeta[page][0];
    $('#page-description').textContent = pageMeta[page][1];
  }));

  $$('[data-field]').forEach((input) => input.addEventListener('input', () => {
    const field = input.dataset.field;
    state.draft[field] = input.type === 'number' ? Number(input.value) : input.value;
    updateLimitDisplays();
    renderApplyBar();
  }));

  $$('[data-secret]').forEach((input) => input.addEventListener('input', () => {
    state.secretUpdates[input.dataset.secret] = input.value;
    renderApplyBar();
  }));

  $$('[data-identity]').forEach((button) => button.addEventListener('click', () => {
    state.draft.identityType = button.dataset.identity;
    if (state.draft.identityType === 'pem') state.draft.mtlsPfxFile = '';
    else {
      state.draft.mtlsCertFile = '';
      state.draft.mtlsKeyFile = '';
    }
    renderForm();
    renderApplyBar();
  }));

  $('#body-size-range').addEventListener('input', (event) => {
    state.draft.maxBodyBytes = Number(event.target.value) * 1024 * 1024;
    $('#maxBodyBytes').value = state.draft.maxBodyBytes;
    updateLimitDisplays();
    renderApplyBar();
  });
  $('#timeout-range').addEventListener('input', (event) => {
    state.draft.upstreamTimeoutMs = Number(event.target.value) * 1000;
    $('#upstreamTimeoutMs').value = state.draft.upstreamTimeoutMs;
    updateLimitDisplays();
    renderApplyBar();
  });

  $$('.picker').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api('/api/files/pick', { method: 'POST', body: { kind: button.dataset.picker } });
      if (!result.canceled && result.path) {
        state.draft[button.dataset.target] = result.path;
        $(`#${button.dataset.target}`).value = result.path;
        renderApplyBar();
      }
    } catch (error) {
      toast('File picker failed', error.message, 'error');
    } finally { button.disabled = false; }
  }));

  $('#refresh-button').addEventListener('click', () => refresh().then(() => toast('Refreshed', 'Control Panel state is up to date.')).catch((error) => toast('Refresh failed', error.message, 'error')));
  $('#revert-button').addEventListener('click', () => {
    state.draft = clone(state.saved);
    state.secretUpdates = {};
    $$('[data-secret]').forEach((input) => { input.value = ''; });
    renderForm();
    renderApplyBar();
    toast('Changes reverted', 'No configuration was written.');
  });
  $('#validate-button').addEventListener('click', () => validateDraft());
  $('#review-button').addEventListener('click', reviewChanges);
  $('#close-modal').addEventListener('click', () => { $('#diff-modal').hidden = true; });
  $('#cancel-apply').addEventListener('click', () => { $('#diff-modal').hidden = true; });
  $('#confirm-apply').addEventListener('click', applyChanges);
  $('#diff-modal').addEventListener('click', (event) => { if (event.target === $('#diff-modal') && !state.busy) $('#diff-modal').hidden = true; });
  $$('.diagnostic-action').forEach((button) => button.addEventListener('click', () => runDiagnostic(button.dataset.diagnostic, button)));
}

async function init() {
  try {
    state.token = (await api('/api/session')).token;
    bindEvents();
    await refresh();
  } catch (error) {
    toast('Control Panel unavailable', error.message, 'error');
    setStatus($('#global-status'), 'Failed', 'Failed');
  }
}

void init();
