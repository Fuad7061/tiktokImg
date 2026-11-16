const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

const PG_PREFS_KEY = 'image-studio.playground';

function savePlaygroundPrefs() {
  try {
    localStorage.setItem(PG_PREFS_KEY, JSON.stringify({
      model: $('#pg-model').value,
      count: $('#pg-count').value
    }));
  } catch {
    /* ignore */
  }
}

function loadPlaygroundPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PG_PREFS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

const VIEWS = {
  overview: { title: 'Overview', subtitle: 'Account pool and generation activity' },
  accounts: { title: 'Accounts', subtitle: 'Cookie profiles, expiry dates, and account slots' },
  playground: { title: 'Playground', subtitle: 'Generate images with the live account pool' },
  jobs: { title: 'Jobs', subtitle: 'Every request, its output, and its account' },
  keys: { title: 'API keys', subtitle: 'OpenAI-compatible access for your tools' },
  settings: { title: 'Settings', subtitle: 'Defaults, limits, and retention' }
};

const state = {
  view: 'overview',
  wired: false,
  entered: false,
  models: [],
  settings: {},
  profiles: [],
  accounts: [],
  timers: {},
  pgPoll: null,
  pgJob: null,
  refs: [],
  modalJob: null,
  lastKey: null
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function toast(message, tone = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast ${tone}`.trim();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add('hidden'), 4200);
}

async function apiFetch(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, credentials: 'same-origin', headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
  }
  const response = await fetch(path, init);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

/* ---------- formatting ---------- */

const numberFormat = new Intl.NumberFormat('en-US');

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? numberFormat.format(Number(value)) : '0';
}

function formatDate(iso, withTime = true) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', withTime
    ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: 'short', year: 'numeric' });
}

function relativeTime(iso) {
  if (!iso) return '—';
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return '—';
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso, false);
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
  const minutes = Math.floor(value / 60000);
  return `${minutes}m ${Math.round((value % 60000) / 1000)}s`;
}

function elapsedSeconds(job) {
  const start = Date.parse(job.startedAt || job.createdAt || '');
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.round((Date.now() - start) / 1000));
}

const MODEL_ALIASES = {
  gemini: 'nano-banana-pro',
  'nano-banana': 'nano-banana-pro',
  nano_banana_pro: 'nano-banana-pro',
  'gemini-pro': 'nano-banana-pro',
  'genai_seedream4.5': 'seedream4.5',
  'seedream-4.5': 'seedream4.5',
  seedream: 'seedream4.5',
  'seedream-4': 'seedream4.5'
};

function canonicalModelId(value) {
  const wanted = String(value || '').toLowerCase();
  if (!wanted) return value;
  const mapped = MODEL_ALIASES[wanted] || wanted;
  const model = state.models.find(item => item.id === mapped
    || item.id.toLowerCase() === mapped
    || item.id.toLowerCase() === wanted);
  return model?.id || mapped || value;
}

function modelName(id) {
  const key = canonicalModelId(id);
  const model = state.models.find(item => item.id === key);
  return model?.name ? model.name : String(id || '—');
}

function statusClass(status) {
  return { succeeded: 'ok', failed: 'err', running: 'info', queued: 'neutral' }[status] || 'neutral';
}

function statusBadge(status) {
  if (!status) return '<span class="badge neutral">—</span>';
  return `<span class="badge ${statusClass(status)}">${esc(status[0].toUpperCase() + status.slice(1))}</span>`;
}

function expiryBadge(daysLeft, expired) {
  if (expired) return '<span class="badge err">Expired</span>';
  if (daysLeft === null || daysLeft === undefined) return '<span class="badge neutral">No expiry</span>';
  const tone = daysLeft <= 7 ? 'warn' : 'neutral';
  const label = daysLeft <= 0 ? 'Expires today' : daysLeft === 1 ? '1 day left' : `${daysLeft} days left`;
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}

function promptTitle(prompt) {
  return String(prompt || '').slice(0, 120) || '—';
}

/* ---------- session ---------- */

async function boot() {
  wire();
  try {
    const health = await apiFetch('/healthz');
    setHealth(true);
    if (health.version) $('#version-badge').textContent = `v${health.version}`;
  } catch {
    setHealth(false);
  }
  try {
    const session = await apiFetch('/api/session');
    if (session.authRequired && !session.authenticated) return showLogin();
    await enterApp();
  } catch (error) {
    showLogin();
    if (error.status === 401) $('#login-error').textContent = 'Please sign in to continue.';
  }
}

function showLogin() {
  $('#boot').classList.add('hidden');
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  $('#login-password').focus();
}

async function enterApp() {
  $('#boot').classList.add('hidden');
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#logout-button').classList.remove('hidden');
  if (!state.entered) {
    state.entered = true;
    wire();
    try {
      await loadModels();
    } catch (error) {
      toast(error.message, 'err');
    }
  }
  navigate('overview');
}

function wire() {
  if (state.wired) return;
  state.wired = true;

  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]');
    $('#login-error').textContent = '';
    button.disabled = true;
    try {
      await apiFetch('/api/login', { method: 'POST', body: { password: $('#login-password').value } });
      $('#login-password').value = '';
      await enterApp();
    } catch (error) {
      $('#login-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#logout-button').addEventListener('click', async () => {
    try {
      await apiFetch('/api/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    state.entered = false;
    state.models = [];
    showLogin();
  });

  $$('.nav-item').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-goto]');
    if (target) navigate(target.dataset.goto);
  });

  $('#refresh-button').addEventListener('click', () => refreshView(true));
  $('#import-form').addEventListener('submit', handleImport);
  $('#import-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    $('#import-content').value = await file.text();
    if (!$('#import-name').value) $('#import-name').value = file.name.replace(/\.[^.]+$/, '');
  });

  $('#profiles').addEventListener('click', handleProfileAction);
  $('#sync-all-button').addEventListener('click', handleSyncAll);

  $('#pg-refs').addEventListener('change', handleRefFiles);
  $('#pg-model').addEventListener('change', savePlaygroundPrefs);
  $('#pg-count').addEventListener('change', savePlaygroundPrefs);
  $('#pg-ref-preview').addEventListener('click', event => {
    const button = event.target.closest('button[data-remove]');
    if (!button) return;
    const index = Number(button.dataset.remove);
    const [removed] = state.refs.splice(index, 1);
    if (removed) URL.revokeObjectURL(removed.url);
    renderRefs();
  });
  $('#playground-form').addEventListener('submit', handleGenerate);
  $('#pg-history').addEventListener('click', event => {
    const item = event.target.closest('[data-job]');
    if (item) openJobModal(item.dataset.job);
  });

  $('#job-status-filter').addEventListener('change', () => loadJobs());
  $('#jobs-refresh').addEventListener('click', () => loadJobs());
  $('#jobs-clear').addEventListener('click', handleClearJobs);
  $('#jobs-body').addEventListener('click', handleJobAction);

  $('#key-form').addEventListener('submit', handleKeyCreate);
  $('#key-list').addEventListener('click', handleKeyAction);
  $('#key-created').addEventListener('click', event => {
    if (event.target.closest('[data-copy-key]')) copyText(state.lastKey || '');
  });

  $('#settings-form').addEventListener('submit', handleSettingsSave);
  $('#automation-sync').addEventListener('click', handleAutomationSync);
  $('#password-form').addEventListener('submit', handlePasswordChange);

  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', event => {
    if (event.target.id === 'modal') closeModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeModal();
  });
  $('#modal-body').addEventListener('click', async event => {
    const retry = event.target.closest('[data-retry]');
    if (retry) {
      const button = retry;
      button.disabled = true;
      try {
        await apiFetch(`/api/jobs/${encodeURIComponent(retry.dataset.retry)}/retry`, { method: 'POST' });
        toast('Job queued again.', 'ok');
        closeModal();
        if (state.view === 'jobs') loadJobs();
      } catch (error) {
        toast(error.message, 'err');
        button.disabled = false;
      }
      return;
    }
    const copy = event.target.closest('[data-copy-job]');
    if (copy && state.modalJob) copyText(JSON.stringify(state.modalJob, null, 2));
  });
}

function setHealth(ok) {
  const dot = $('#health-dot');
  dot.className = `dot ${ok ? 'ok' : 'err'}`;
  $('#health-label').textContent = ok ? 'API online' : 'API unreachable';
}

/* ---------- navigation ---------- */

function navigate(view) {
  if (!VIEWS[view]) return;
  state.view = view;
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $$('.view').forEach(section => section.classList.toggle('hidden', section.dataset.view !== view));
  $('#page-title').textContent = VIEWS[view].title;
  $('#page-subtitle').textContent = VIEWS[view].subtitle;
  clearInterval(state.timers.overview);
  clearInterval(state.timers.jobs);
  refreshView(false);
  if (view === 'overview') state.timers.overview = setInterval(() => { if (!document.hidden) loadOverview(); }, 8000);
  if (view === 'jobs') state.timers.jobs = setInterval(() => { if (!document.hidden) loadJobs(); }, 7000);
}

function refreshView(showError) {
  const loaders = {
    overview: loadOverview,
    accounts: loadAccounts,
    playground: loadPlayground,
    jobs: loadJobs,
    keys: loadKeys,
    settings: loadSettings
  };
  const loader = loaders[state.view];
  if (!loader) return;
  Promise.resolve(loader()).catch(error => {
    if (showError) toast(error.message, 'err');
  });
}

/* ---------- overview ---------- */

async function loadOverview() {
  const [data, jobsData, accountsData] = await Promise.all([
    apiFetch('/api/overview'),
    apiFetch('/api/jobs?limit=6'),
    apiFetch('/api/accounts')
  ]);
  state.settings = data.settings || state.settings;
  state.profiles = accountsData.profiles || [];
  state.accounts = accountsData.accounts || [];

  const active = data.jobs.active || 0;
  const cards = [
    { label: 'Usable accounts', value: `${data.accounts.usable}`, hint: `${data.accounts.accounts} total · ${data.accounts.profiles} profile(s)` },
    { label: 'Credit balance', value: formatNumber(data.accounts.credits), hint: `${formatNumber(Math.floor(Number(data.accounts.credits || 0) / 4))} images available · 4 points each` },
    { label: 'Jobs · 24h', value: formatNumber(data.jobs.today), hint: `${active} active · ${formatNumber(data.jobs.total)} all time` },
    { label: 'Avg generation', value: formatDuration(data.jobs.avgDurationMs), hint: `${formatNumber(data.jobs.images)} images produced` }
  ];
  $('#stat-cards').innerHTML = cards.map(card => `
    <article class="stat">
      <div class="label">${esc(card.label)}</div>
      <div class="value">${esc(card.value)}</div>
      <div class="hint">${esc(card.hint)}</div>
    </article>`).join('');

  const rows = jobsData.jobs || [];
  $('#recent-jobs').innerHTML = rows.length ? rows.map(job => `
    <tr>
      <td>${esc(relativeTime(job.createdAt))}</td>
      <td>${esc(modelName(job.model))}</td>
      <td>${esc(job.ratio || 'auto')}</td>
      <td>${statusBadge(job.status)}</td>
      <td>${job.images?.length || 0}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty">No jobs yet. Try the playground.</td></tr>';

  const activeMap = data.pool || {};
  const usable = state.accounts.filter(account => account.available && account.enabled && !account.expired);
  const poolRows = usable.slice(0, 6).map(account => {
    const count = activeMap[`${account.profileId}:${account.accountId}`] || 0;
    return `
      <div class="pool-row">
        <div class="who">
          <span>${esc(account.name || `Account ${String(account.accountId).slice(-5)}`)}</span>
          <small>${esc(account.profileName)} · ${esc(account.role || 'member')}</small>
        </div>
        ${count ? `<span class="badge info">${count} running</span>` : '<span class="badge neutral">Idle</span>'}
      </div>`;
  }).join('');
  $('#pool-status').innerHTML = poolRows || '<p class="muted small">No usable account yet. Import a cookie file on the Accounts page.</p>';

  $('#overview-curl').textContent = `curl -s ${location.origin}/v1/images/generations \\
  -H "Authorization: Bearer sk-..." \\
  -H "Content-Type: application/json" \\
  -d '{"model":"nano-banana-pro","prompt":"A serene mountain lake at sunrise"}'`;
}

/* ---------- accounts ---------- */

async function loadAccounts() {
  const data = await apiFetch('/api/accounts');
  state.profiles = data.profiles || [];
  state.accounts = data.accounts || [];
  renderProfiles();
}

function creditTotals(accounts) {
  let total = 0;
  let known = 0;
  for (const account of accounts) {
    const value = Number(account.credits);
    if (account.credits !== null && account.credits !== undefined && Number.isFinite(value)) {
      total += value;
      known += 1;
    }
  }
  return { total, known, unknown: accounts.length - known, images: Math.floor(total / 4) };
}

function renderPoolSummary() {
  const container = $('#pool-summary');
  if (!container) return;
  const totals = creditTotals(state.accounts);
  const ready = state.accounts.filter(account => account.available && account.enabled && !account.expired).length;
  container.innerHTML = `
    <div class="summary-item"><span>Accounts</span><strong>${formatNumber(state.accounts.length)}</strong></div>
    <div class="summary-item"><span>Ready</span><strong>${formatNumber(ready)}</strong></div>
    <div class="summary-item"><span>Total credits</span><strong>${formatNumber(totals.total)}${totals.unknown ? '+' : ''}</strong><small>${totals.unknown ? `${totals.unknown} unknown` : 'all synced'}</small></div>
    <div class="summary-item"><span>Images available</span><strong>${formatNumber(totals.images)}${totals.unknown ? '+' : ''}</strong><small>4 credits per image</small></div>`;
}

function roleBadge(role) {
  const value = String(role || '').toLowerCase();
  if (value === 'main') return '<span class="badge info sm">Main</span>';
  if (value === '1' || value === 'sub' || value === 'member') return '<span class="badge neutral sm">Sub</span>';
  return esc(role || '—');
}

function renderProfiles() {
  const container = $('#profiles');
  renderPoolSummary();
  if (!state.profiles.length) {
    container.innerHTML = '<p class="muted small">No cookie profiles yet. Import your exported TikTok cookies to get started.</p>';
    return;
  }
  container.innerHTML = state.profiles.map(profile => {
    const accounts = state.accounts.filter(account => account.profileId === profile.id);
    const totals = creditTotals(accounts);
    const statusBadgeHtml = profile.expired ? '<span class="badge err">Expired</span>' : expiryBadge(profile.daysLeft, false);
    const accountRows = accounts.map(account => `
      <tr>
        <td>
          <div class="account-name">
            <span>${esc(account.name || 'Unnamed')}</span>
            <small>${esc(account.accountId)}</small>
          </div>
        </td>
        <td>${roleBadge(account.role)}</td>
        <td>${esc(account.tier || '—')}</td>
        <td>${account.credits === null || account.credits === undefined ? '—' : formatNumber(account.credits)}</td>
        <td>${expiryBadge(account.daysLeft, account.expired)}</td>
        <td>
          ${account.available ? '<span class="badge ok">Ready</span>' : '<span class="badge warn">Unavailable</span>'}
          ${account.enabled ? '' : '<span class="badge neutral">Paused</span>'}
        </td>
        <td class="right">
          <button class="btn small subtle" type="button" data-action="verify" data-profile="${esc(profile.id)}" data-account="${esc(account.accountId)}">Validate</button>
          <button class="btn small subtle" type="button" data-action="toggle-account" data-profile="${esc(profile.id)}" data-account="${esc(account.accountId)}" data-enabled="${account.enabled ? '1' : '0'}">${account.enabled ? 'Pause' : 'Enable'}</button>
        </td>
      </tr>`).join('');

    return `
      <article class="profile ${profile.enabled ? '' : 'paused'}">
        <div class="profile-head">
          <div class="profile-title">
            <strong>${esc(profile.name)}</strong>
            ${profile.enabled ? '<span class="badge ok">Active</span>' : '<span class="badge neutral">Paused</span>'}
            <span class="badge ${profile.status === 'valid' ? 'info' : 'warn'}">${esc(profile.status || 'unknown')}</span>
            ${statusBadgeHtml}
          </div>
          <div class="profile-actions">
            <button class="btn small subtle" type="button" data-action="edit-cookies" data-profile="${esc(profile.id)}">Edit cookies</button>
            <button class="btn small subtle" type="button" data-action="sync" data-profile="${esc(profile.id)}">Sync</button>
            <button class="btn small subtle" type="button" data-action="credits" data-profile="${esc(profile.id)}">Credits</button>
            <button class="btn small subtle" type="button" data-action="toggle-profile" data-profile="${esc(profile.id)}" data-enabled="${profile.enabled ? '1' : '0'}">${profile.enabled ? 'Pause' : 'Resume'}</button>
            <button class="btn small danger" type="button" data-action="delete" data-profile="${esc(profile.id)}">Delete</button>
          </div>
        </div>
        <div class="profile-meta">
          <div><span class="k">Accounts</span><span class="v">${formatNumber(accounts.length)}</span></div>
          <div><span class="k">Total credits</span><span class="v">${formatNumber(totals.total)}${totals.unknown ? '+' : ''}${totals.unknown ? ` · ${totals.unknown} unknown` : ''}</span></div>
          <div><span class="k">Images available</span><span class="v">${formatNumber(totals.images)}${totals.unknown ? '+' : ''}</span></div>
          <div><span class="k">Cookies</span><span class="v">${esc(profile.cookieCount ?? '—')}</span></div>
          <div><span class="k">Expires</span><span class="v">${esc(profile.expiresAt ? formatDate(profile.expiresAt, false) : '—')}</span></div>
          <div><span class="k">Validated</span><span class="v">${esc(profile.validatedAt ? relativeTime(profile.validatedAt) : 'Never')}</span></div>
        </div>
        ${profile.lastError ? `<div class="profile-error">${esc(profile.lastError)}</div>` : ''}
        <div class="table-wrap">
          <table class="account-table">
            <thead>
              <tr><th>Account</th><th>Role</th><th>Tier</th><th>Credits</th><th>Session</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>${accountRows || '<tr><td colspan="7" class="muted">No accounts discovered yet. Run Sync to load them.</td></tr>'}</tbody>
          </table>
        </div>
      </article>`;
  }).join('');
}

async function handleProfileAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const profileId = button.dataset.profile;
  const accountId = button.dataset.account;
  const enabled = button.dataset.enabled === '1';
  if (action === 'edit-cookies') {
    openCookieEditor(profileId);
    return;
  }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    if (action === 'sync') {
      const result = await apiFetch(`/api/accounts/${encodeURIComponent(profileId)}/sync`, { method: 'POST' });
      const count = Array.isArray(result?.accounts) ? result.accounts.length : 0;
      toast(`Profile synced${count ? ` · ${count} account(s)` : ''}.`, 'ok');
      await loadAccounts();
    } else if (action === 'credits') {
      const result = await apiFetch(`/api/accounts/${encodeURIComponent(profileId)}/credits`, { method: 'POST' });
      const rows = Array.isArray(result?.credits) ? result.credits : [];
      const credits = rows.reduce((sum, row) => sum + (Number(row.credits) || 0), 0);
      toast(`Credits refreshed${rows.length ? ` · ${formatNumber(credits)}` : ''}.`, 'ok');
      await loadAccounts();
    } else if (action === 'toggle-profile') {
      await apiFetch(`/api/accounts/${encodeURIComponent(profileId)}`, { method: 'PATCH', body: { enabled: !enabled } });
      toast(enabled ? 'Profile paused.' : 'Profile resumed.', 'ok');
      await loadAccounts();
    } else if (action === 'delete') {
      if (!confirm('Delete this cookie profile and its accounts? Existing jobs keep their records.')) return;
      await apiFetch(`/api/accounts/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
      toast('Profile deleted.', 'ok');
      await loadAccounts();
    } else if (action === 'verify') {
      await apiFetch(`/api/accounts/${encodeURIComponent(profileId)}/${encodeURIComponent(accountId)}/verify`, { method: 'POST' });
      toast('Account validated.', 'ok');
      await loadAccounts();
    } else if (action === 'toggle-account') {
      await apiFetch(`/api/accounts/${encodeURIComponent(profileId)}/${encodeURIComponent(accountId)}`, {
        method: 'PATCH',
        body: { enabled: !enabled }
      });
      toast(enabled ? 'Account paused.' : 'Account enabled.', 'ok');
      await loadAccounts();
    }
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function handleSyncAll() {
  const button = $('#sync-all-button');
  if (!state.profiles.length) return toast('No profiles to sync.', 'err');
  button.disabled = true;
  button.textContent = 'Syncing…';
  let failed = 0;
  for (const profile of state.profiles) {
    try {
      await apiFetch(`/api/accounts/${encodeURIComponent(profile.id)}/sync`, { method: 'POST' });
    } catch {
      failed += 1;
    }
  }
  button.disabled = false;
  button.textContent = 'Sync all';
  toast(failed ? `Synced with ${failed} failure(s).` : 'All profiles synced.', failed ? 'err' : 'ok');
  await loadAccounts();
}

async function handleImport(event) {
  event.preventDefault();
  const content = $('#import-content').value.trim();
  if (!content) return toast('Paste a cookie file or choose one first.', 'err');
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Importing…';
  try {
    const result = await apiFetch('/api/accounts/import', {
      method: 'POST',
      body: { name: $('#import-name').value.trim(), content }
    });
    toast(result.syncError ? `Imported, but sync failed: ${result.syncError}` : 'Profile imported and synced.', result.syncError ? 'err' : 'ok');
    $('#import-name').value = '';
    $('#import-content').value = '';
    $('#import-file').value = '';
    await loadAccounts();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Import and validate';
  }
}

function openCookieEditor(profileId) {
  const profile = state.profiles.find(item => item.id === profileId);
  if (!profile) return;
  state.modalJob = null;
  $('#modal-title').textContent = `Edit cookies — ${profile.name}`;
  $('#modal-body').innerHTML = `
    <form id="cookie-edit-form" class="stack">
      <p class="muted small">Paste or upload a fresh cookie export for this profile. The stored cookies are replaced, then the profile re-syncs automatically. If the new cookies belong to a different main account the save is rejected.</p>
      <label class="field"><span>Cookie file</span>
        <input id="ce-file" type="file" accept=".txt,.json,text/plain,application/json" />
      </label>
      <label class="field"><span>Or paste cookie text</span>
        <textarea id="ce-content" rows="10" spellcheck="false" placeholder="Paste the contents of tiktok_cookies.txt"></textarea>
      </label>
      <div class="row tight">
        <button class="btn primary" type="submit">Save and sync</button>
        <button class="btn subtle" type="button" id="ce-cancel">Cancel</button>
      </div>
    </form>`;
  $('#modal').classList.remove('hidden');

  const form = $('#cookie-edit-form');
  const content = $('#ce-content');
  $('#ce-file').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (file) content.value = await file.text();
  });
  $('#ce-cancel').addEventListener('click', closeModal);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = content.value.trim();
    if (!text) return toast('Paste a cookie file or choose one first.', 'err');
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      const result = await apiFetch(`/api/accounts/${encodeURIComponent(profileId)}`, { method: 'PATCH', body: { content: text } });
      toast(result.syncError ? `Cookies saved, but sync failed: ${result.syncError}` : 'Cookies updated and profile synced.', result.syncError ? 'err' : 'ok');
      closeModal();
      await loadAccounts();
    } catch (error) {
      toast(error.message, 'err');
      submit.disabled = false;
      submit.textContent = 'Save and sync';
    }
  });
}

/* ---------- playground ---------- */

async function loadModels() {
  const data = await apiFetch('/api/models');
  state.models = data?.data || [];
  const modelOptions = state.models.map(model => `<option value="${esc(model.id)}">${esc(model.name)} (${esc(model.id)})</option>`).join('');
  $('#pg-model').innerHTML = modelOptions;
  $('#set-model').innerHTML = modelOptions;
  $('#pg-count').innerHTML = [1, 2, 3, 4].map(value => `<option value="${value}"${value === 1 ? ' selected' : ''}>${value}</option>`).join('');
}

async function loadPlayground() {
  const settingsData = await apiFetch('/api/settings');
  state.settings = settingsData.settings || state.settings;
  if (!$('#pg-model').options.length) await loadModels();
  const prefs = loadPlaygroundPrefs();
  if (prefs.model) $('#pg-model').value = canonicalModelId(prefs.model);
  else if (state.settings.defaultModel) $('#pg-model').value = canonicalModelId(state.settings.defaultModel);
  if (prefs.count) $('#pg-count').value = prefs.count;
  if (!$('#pg-prompt').value) $('#pg-prompt').value = '';
  await loadPlaygroundHistory();
  if (state.pgJob) renderPlaygroundJob(state.pgJob);
}

async function loadPlaygroundHistory() {
  const data = await apiFetch('/api/jobs?source=playground&limit=6');
  const jobs = data.jobs || [];
  $('#pg-history').innerHTML = jobs.length ? jobs.map(job => `
    <div class="history-item" data-job="${esc(job.id)}">
      <span class="badge ${statusClass(job.status)} sm">${esc(job.status)}</span>
      <div class="grow"><div class="title">${esc(promptTitle(job.prompt))}</div></div>
      <span class="muted small">${esc(relativeTime(job.createdAt))}</span>
    </div>`).join('') : '<p class="muted small">No playground jobs yet.</p>';
}

function handleRefFiles(event) {
  const files = Array.from(event.target.files || []).filter(file => file.type.startsWith('image/'));
  for (const file of files) {
    if (state.refs.length >= 4) {
      toast('A request can include up to 4 reference images.', 'err');
      break;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast(`${file.name} is larger than 20 MB and was skipped.`, 'err');
      continue;
    }
    state.refs.push({ file, url: URL.createObjectURL(file) });
  }
  event.target.value = '';
  renderRefs();
}

function renderRefs() {
  $('#pg-ref-preview').innerHTML = state.refs.map((item, index) => `
    <div class="thumb">
      <img src="${item.url}" alt="Reference ${index + 1}" />
      <button type="button" data-remove="${index}" title="Remove">×</button>
    </div>`).join('');
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function handleGenerate(event) {
  event.preventDefault();
  const prompt = $('#pg-prompt').value.trim();
  if (!prompt) return toast('Write a prompt first.', 'err');
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Starting…';
  clearTimeout(state.pgPoll);
  try {
    const references = await Promise.all(state.refs.map(item => fileToDataUrl(item.file)));
    savePlaygroundPrefs();
    // Fresh key per click → parallel playground jobs never share a key.
    // Re-submitting the same click (network retry) reuses this key → same job.
    const idempotencyKey = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = {
      prompt,
      model: $('#pg-model').value,
      count: Number($('#pg-count').value) || 1,
      references,
      idempotencyKey
    };
    const result = await apiFetch('/api/generate', { method: 'POST', body: payload });
    state.pgJob = result.job;
    renderPlaygroundJob(state.pgJob);
    pollPlaygroundJob(result.job.id);
    toast(result.replay ? 'Existing job resumed.' : 'Job started.', 'ok');
  } catch (error) {
    toast(error.message, 'err');
    $('#pg-output').innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
  } finally {
    button.disabled = false;
    button.textContent = 'Generate';
  }
}

function pollPlaygroundJob(jobId) {
  clearTimeout(state.pgPoll);
  state.pgPoll = setTimeout(async () => {
    try {
      const data = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
      state.pgJob = data.job;
      renderPlaygroundJob(data.job);
      if (data.job.status === 'succeeded' || data.job.status === 'failed') {
        loadPlaygroundHistory().catch(() => {});
        return;
      }
    } catch (error) {
      $('#pg-output').innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
      return;
    }
    pollPlaygroundJob(jobId);
  }, 2000);
}

function renderPlaygroundJob(job) {
  const container = $('#pg-output');
  if (!container) return;
  if (job.status === 'queued' || job.status === 'running') {
    const stage = job.stage ? job.stage[0].toUpperCase() + job.stage.slice(1) : job.status;
    container.innerHTML = `
      <div class="progress">
        <div class="progress-head">
          <strong>${esc(stage)}</strong>
          <span class="muted small">${elapsedSeconds(job)}s</span>
        </div>
        <div class="bar"><span></span></div>
        <p class="muted small">${esc(modelName(job.model))} · ${esc(job.ratio || 'auto')} · ${esc(job.kind === 'i2i' ? 'image-to-image' : 'text-to-image')}</p>
      </div>`;
    $('#pg-timer').textContent = `${elapsedSeconds(job)}s elapsed`;
    return;
  }
  $('#pg-timer').textContent = job.durationMs ? formatDuration(job.durationMs) : '';
  if (job.status === 'failed') {
    container.innerHTML = `
      <div class="profile-error">${esc(job.error?.message || 'Generation failed.')}</div>
      <p class="muted small">Job ${esc(job.id)}${job.taskId ? ` · task ${esc(job.taskId)}` : ''}</p>`;
    return;
  }
  container.innerHTML = `
    ${imagesHtml(job)}
    <p class="muted small">${esc(modelName(job.model))} · ${esc(job.output?.ratio || job.ratio || 'auto')}${job.partial ? ' · partial result' : ''} · ${esc(formatDuration(job.durationMs))}</p>`;
}

function mediaUrl(jobId, index) {
  return `/api/media/${encodeURIComponent(jobId)}/${index}`;
}

function imagesHtml(job) {
  const images = Array.isArray(job.images) ? job.images : [];
  if (!images.length) return '<p class="muted small">No images were returned.</p>';
  return `<div class="output-grid">${images.map((image, index) => `
    <figure class="output-item">
      <a href="${mediaUrl(job.id, index)}" target="_blank" rel="noopener">
        <img src="${mediaUrl(job.id, index)}" alt="Generated image ${index + 1}" loading="lazy" />
      </a>
      <figcaption class="meta">
        <span>${image.width && image.height ? `${esc(image.width)} × ${esc(image.height)}` : 'Image'}</span>
        <a href="${mediaUrl(job.id, index)}" download="image-studio-${esc(job.id)}-${index + 1}.png">Download</a>
      </figcaption>
    </figure>`).join('')}</div>`;
}

/* ---------- jobs ---------- */

async function loadJobs() {
  const status = $('#job-status-filter').value;
  const query = new URLSearchParams({ limit: '100' });
  if (status) query.set('status', status);
  const data = await apiFetch(`/api/jobs?${query.toString()}`);
  renderJobs(data.jobs || []);
}

function renderJobs(jobs) {
  const body = $('#jobs-body');
  if (!jobs.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">No jobs match this filter.</td></tr>';
    return;
  }
  body.innerHTML = jobs.map(job => `
    <tr>
      <td title="${esc(formatDate(job.createdAt))}">${esc(relativeTime(job.createdAt))}<div class="muted small">${esc(job.kind || '')}</div></td>
      <td>${esc(job.source || '—')}</td>
      <td>${esc(modelName(job.model))}</td>
      <td class="truncate" title="${esc(job.prompt)}">${esc(promptTitle(job.prompt))}</td>
      <td>${statusBadge(job.status)}<div class="muted small">${esc(job.stage || '')}</div></td>
      <td>${job.account ? esc(job.account.profileId.replace(/^profile_/, '').slice(0, 8)) : '—'}</td>
      <td>${esc(formatDuration(job.durationMs))}</td>
      <td class="actions">
        <button class="btn small subtle" type="button" data-job-view="${esc(job.id)}">View</button>
        ${job.status === 'failed' ? `<button class="btn small subtle" type="button" data-job-retry="${esc(job.id)}">Retry</button>` : ''}
        <button class="btn small danger" type="button" data-job-delete="${esc(job.id)}">Delete</button>
      </td>
    </tr>`).join('');
}

async function handleJobAction(event) {
  const view = event.target.closest('[data-job-view]');
  if (view) return openJobModal(view.dataset.jobView);

  const retry = event.target.closest('[data-job-retry]');
  if (retry) {
    retry.disabled = true;
    try {
      await apiFetch(`/api/jobs/${encodeURIComponent(retry.dataset.jobRetry)}/retry`, { method: 'POST' });
      toast('Job queued again.', 'ok');
      await loadJobs();
    } catch (error) {
      toast(error.message, 'err');
      retry.disabled = false;
    }
    return;
  }

  const remove = event.target.closest('[data-job-delete]');
  if (remove) {
    if (!confirm('Delete this job record? Generated images stay at the provider but the links disappear.')) return;
    remove.disabled = true;
    try {
      await apiFetch(`/api/jobs/${encodeURIComponent(remove.dataset.jobDelete)}`, { method: 'DELETE' });
      toast('Job deleted.', 'ok');
      await loadJobs();
    } catch (error) {
      toast(error.message, 'err');
      remove.disabled = false;
    }
  }
}

async function handleClearJobs() {
  if (!confirm('Delete all job history? Generated images stay at the provider, but the stored links and logs disappear.')) return;
  const button = $('#jobs-clear');
  button.disabled = true;
  try {
    const result = await apiFetch('/api/jobs', { method: 'DELETE' });
    toast(`Job history cleared${result.deleted ? ` · ${result.deleted} removed` : ''}.`, 'ok');
    await loadJobs();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
  }
}

async function openJobModal(id) {
  try {
    const data = await apiFetch(`/api/jobs/${encodeURIComponent(id)}`);
    state.modalJob = data.job;
    renderJobModal(data.job);
    $('#modal').classList.remove('hidden');
  } catch (error) {
    toast(error.message, 'err');
  }
}

function renderJobModal(job) {
  $('#modal-title').textContent = `Job ${job.id}`;
  $('#modal-body').innerHTML = `
    <dl class="kv">
      <dt>Status</dt><dd>${statusBadge(job.status)} ${job.stage ? `<span class="muted small">${esc(job.stage)}</span>` : ''}</dd>
      <dt>Model</dt><dd>${esc(modelName(job.model))} <span class="muted small">(${esc(job.model)})</span></dd>
      <dt>Kind</dt><dd>${esc(job.kind === 'i2i' ? 'Image-to-image' : 'Text-to-image')}</dd>
      <dt>Ratio</dt><dd>${esc(job.ratio || 'auto')}${job.size ? ` · ${esc(job.size)}` : ''}</dd>
      <dt>Requested</dt><dd>${esc(job.requested)} image(s)</dd>
      <dt>Source</dt><dd>${esc(job.source || '—')}</dd>
      <dt>Created</dt><dd>${esc(formatDate(job.createdAt))}</dd>
      <dt>Duration</dt><dd>${esc(formatDuration(job.durationMs))}</dd>
      <dt>Attempts</dt><dd>${esc(job.attempts ?? 0)}</dd>
      <dt>Account</dt><dd>${job.account ? `${esc(job.account.profileId)} · ${esc(job.account.accountId)}` : '—'}</dd>
      <dt>Task ID</dt><dd>${esc(job.taskId || '—')}</dd>
    </dl>
    ${job.error ? `<div class="profile-error">${esc(job.error.message)}${job.error.code ? ` (${esc(job.error.code)})` : ''}</div>` : ''}
    <div>
      <h3>Prompt</h3>
      <p>${esc(job.prompt)}</p>
    </div>
    <div>
      <h3>Images</h3>
      ${imagesHtml(job)}
      ${job.partial ? '<p class="badge warn">Partial result: fewer images than requested.</p>' : ''}
    </div>
    <div class="row tight">
      <button class="btn subtle" type="button" data-copy-job>Copy JSON</button>
      ${job.status === 'failed' ? `<button class="btn primary" type="button" data-retry="${esc(job.id)}">Retry job</button>` : ''}
    </div>`;
}

function closeModal() {
  $('#modal').classList.add('hidden');
  state.modalJob = null;
}

/* ---------- keys ---------- */

async function loadKeys() {
  if (!state.settings.defaultModel) {
    try {
      const settingsData = await apiFetch('/api/settings');
      state.settings = settingsData.settings || {};
    } catch {
      /* keep model fallback */
    }
  }
  const data = await apiFetch('/api/keys');
  const keys = data.keys || [];
  $('#key-list').innerHTML = keys.length ? keys.map(key => `
    <div class="key-row">
      <div class="grow">
        <div class="name">${esc(key.name)}</div>
        <div class="prefix">${esc(key.prefix)}… · created ${esc(formatDate(key.createdAt, false))}${key.lastUsedAt ? ` · used ${esc(relativeTime(key.lastUsedAt))}` : ''}</div>
      </div>
      ${key.revokedAt ? '<span class="badge neutral">Revoked</span>' : '<span class="badge ok">Active</span>'}
      ${key.revokedAt
        ? `<button class="btn small danger" type="button" data-key-delete="${esc(key.id)}">Delete</button>`
        : `<button class="btn small subtle" type="button" data-key-revoke="${esc(key.id)}">Revoke</button>`}
    </div>`).join('') : '<p class="muted small">No API keys yet.</p>';

  $('#api-base').textContent = location.origin;
  $('#doc-default-model').textContent = state.settings.defaultModel || 'nano-banana-pro';
  // Unique key per shell run — reuse $ID to retry the same job; each parallel line gets its own ID.
  const idem = `$(uuidgen 2>/dev/null || openssl rand -hex 16)`;
  $('#curl-generations').textContent = `ID="${idem}"
curl -s ${location.origin}/v1/images/generations \\
  -H "Authorization: Bearer sk-..." \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $ID" \\
  -d '{
    "model": "nano-banana-pro",
    "prompt": "A minimal product shot of a ceramic mug",
    "n": 1
  }'
# Retry the same request later with the same "$ID" → same job, no double charge.`;
  $('#curl-edits').textContent = `ID="${idem}"
curl -s ${location.origin}/v1/images/edits \\
  -H "Authorization: Bearer sk-..." \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $ID" \\
  -d '{
    "model": "seedream4.5",
    "prompt": "Turn this into a watercolor painting",
    "images": ["data:image/png;base64,..."]
  }'`;
  $('#curl-async').textContent = `ID="${idem}"
curl -s ${location.origin}/v1/images/generations \\
  -H "Authorization: Bearer sk-..." \\
  -H "Content-Type: application/json" \\
  -H "Prefer: respond-async" \\
  -H "Idempotency-Key: $ID" \\
  -d '{"model":"nano-banana-pro","prompt":"A serene mountain lake at sunrise"}'
# Response: 202 + x-job-id. Poll with that job id.
# Parallel-safe: each shell run generates a fresh $ID, so requests never collide.
# Retry-safe: re-run with the same $ID → the existing job, not a new one.`;
  $('#curl-poll').textContent = `curl -s ${location.origin}/api/jobs/JOB_ID \\
  -H "Authorization: Bearer sk-..."`;
}

async function handleKeyCreate(event) {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await apiFetch('/api/keys', { method: 'POST', body: { name: $('#key-name').value.trim() || 'API key' } });
    state.lastKey = result.key;
    $('#key-name').value = '';
    $('#key-created').innerHTML = `
      <strong>Key created</strong>
      <div class="key-value">${esc(result.key)}</div>
      <p class="muted small">Copy it now; it cannot be shown again.</p>
      <button class="btn small primary" type="button" data-copy-key>Copy key</button>`;
    $('#key-created').classList.remove('hidden');
    await loadKeys();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
  }
}

async function handleKeyAction(event) {
  const revoke = event.target.closest('[data-key-revoke]');
  const remove = event.target.closest('[data-key-delete]');
  try {
    if (revoke) {
      if (!confirm('Revoke this key? Requests using it will start failing immediately.')) return;
      revoke.disabled = true;
      await apiFetch(`/api/keys/${encodeURIComponent(revoke.dataset.keyRevoke)}`, { method: 'DELETE' });
      toast('Key revoked.', 'ok');
      await loadKeys();
    } else if (remove) {
      if (!confirm('Delete this key permanently?')) return;
      remove.disabled = true;
      await apiFetch(`/api/keys/${encodeURIComponent(remove.dataset.keyDelete)}?purge=1`, { method: 'DELETE' });
      toast('Key deleted.', 'ok');
      await loadKeys();
    }
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard.', 'ok');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('Copied to clipboard.', 'ok');
    } catch {
      toast('Copy failed. Select the value manually.', 'err');
    }
    area.remove();
  }
}

/* ---------- settings ---------- */

async function loadSettings() {
  if (!state.models.length) await loadModels();
  const [settingsData, overview, health] = await Promise.all([
    apiFetch('/api/settings'),
    apiFetch('/api/overview'),
    apiFetch('/healthz')
  ]);
  state.settings = settingsData.settings || {};
  $('#set-model').value = canonicalModelId(state.settings.defaultModel || 'nano-banana-pro');
  $('#set-concurrency').value = state.settings.accountConcurrency ?? 1;
  $('#set-attempts').value = state.settings.maxAttempts ?? 3;
  $('#set-timeout').value = state.settings.jobTimeoutMs ?? 300000;
  $('#set-retention').value = state.settings.retentionDays ?? 30;
  $('#set-rpm').value = state.settings.rateLimitRpm ?? 60;
  $('#set-autosync').value = state.settings.autoSyncMinutes ?? 15;
  const automation = overview.automation || {};
  $('#automation-state').textContent = automation.enabled
    ? `Automatic sync every ${automation.intervalMinutes} minute(s). Last run ${automation.lastRunAt ? relativeTime(automation.lastRunAt) : 'starting soon'}${automation.lastError ? ` · ${automation.lastError}` : ''}.`
    : 'Automatic sync is off. Accounts and credits only refresh when you press Sync.';

  $('#runtime-info').innerHTML = `
    <dt>Version</dt><dd>${esc(health.version || '—')}</dd>
    <dt>Uptime</dt><dd>${esc(formatUptime(health.uptime))}</dd>
    <dt>Dashboard auth</dt><dd>${health.authRequired ? 'Password required' : 'Open access'}</dd>
    <dt>Base URL</dt><dd>${esc(location.origin)}</dd>
    <dt>Accounts</dt><dd>${esc(overview.accounts.usable)} usable of ${esc(overview.accounts.accounts)}</dd>
    <dt>Credit balance</dt><dd>${esc(formatNumber(overview.accounts.credits))}</dd>
    <dt>Jobs stored</dt><dd>${esc(formatNumber(overview.jobs.total))}</dd>
    <dt>Images produced</dt><dd>${esc(formatNumber(overview.jobs.images))}</dd>
    <dt>Images available</dt><dd>${esc(formatNumber(Math.floor(Number(overview.accounts.credits || 0) / 4)))}</dd>
    <dt>Auto sync</dt><dd>${automation.enabled ? `every ${esc(automation.intervalMinutes)} min` : 'off'}${automation.lastRunAt ? ` · ${esc(relativeTime(automation.lastRunAt))}` : ''}</dd>`;
}

function formatUptime(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total)) return '—';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${Math.floor(total % 60)}s`;
}

async function handleSettingsSave(event) {
  event.preventDefault();
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await apiFetch('/api/settings', {
      method: 'PATCH',
      body: {
        defaultModel: $('#set-model').value,
        accountConcurrency: Number($('#set-concurrency').value),
        maxAttempts: Number($('#set-attempts').value),
        jobTimeoutMs: Number($('#set-timeout').value),
        retentionDays: Number($('#set-retention').value),
        rateLimitRpm: Number($('#set-rpm').value),
        autoSyncMinutes: Number($('#set-autosync').value)
      }
    });
    state.settings = result.settings || state.settings;
    toast('Settings saved.', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
  }
}

async function handleAutomationSync() {
  const button = $('#automation-sync');
  button.disabled = true;
  button.textContent = 'Syncing…';
  try {
    const result = await apiFetch('/api/automation/sync', { method: 'POST' });
    const results = result.automation?.results || [];
    const failed = results.filter(item => item.error).length;
    toast(failed ? `Sync finished with ${failed} failure(s).` : 'Accounts and credits synced.', failed ? 'err' : 'ok');
    await loadSettings();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Sync accounts & credits now';
  }
}

async function handlePasswordChange(event) {
  event.preventDefault();
  const currentPassword = $('#pw-current').value;
  const newPassword = $('#pw-new').value;
  if (newPassword !== $('#pw-confirm').value) return toast('New passwords do not match.', 'err');
  if (newPassword.length < 8) return toast('Use at least 8 characters.', 'err');
  const button = event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await apiFetch('/api/settings/password', { method: 'POST', body: { currentPassword, newPassword } });
    $('#password-form').reset();
    toast('Admin password updated.', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = false;
  }
}

/* ---------- start ---------- */

setInterval(async () => {
  try {
    await apiFetch('/healthz');
    setHealth(true);
  } catch {
    setHealth(false);
  }
}, 30000);

boot();
