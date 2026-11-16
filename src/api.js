import crypto from 'node:crypto';
import { config } from './config.js';
import { db, getSettings, setSetting } from './db.js';
import { httpRequest } from './http.js';
import { readBody, jsonParse } from './utils.js';
import { deleteProfile, importProfile, listAccounts, listProfiles, refreshCredits, syncProfile, updateAccount, updateProfile, verifyAccount, accountCounts } from './accounts.js';
import { clearJobs, createJob, deleteJob, executeJob, findJobByIdempotency, getJob, listJobs, retryJob, waitForJob } from './jobs.js';
import { authenticate, checkRateLimit, createKey, deleteKey, listKeys, revokeKey } from './keys.js';
import { listModels, modelInfo, resolveModel } from './provider/models.js';
import { clearSession, checkPassword, authRequired, isAdmin, issueSession, setAdminPassword } from './session.js';
import { sessionSecret } from './vault.js';
import { automationState, runAutomationNow } from './scheduler.js';

const VERSION = '1.0.0';

const SETTING_KEYS = ['defaultModel', 'accountConcurrency', 'maxAttempts', 'jobTimeoutMs', 'retentionDays', 'rateLimitRpm', 'autoSyncMinutes'];

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? null));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers
  });
  res.end(payload);
}

function fail(res, status, message, code = '', param = '', extra = {}) {
  send(res, status, { ok: false, error: { code, message, param, status } }, extra);
}

function openaiError(res, status, message, code, param = '', headers = {}) {
  send(res, status, {
    error: {
      message,
      type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error',
      param: param || null,
      code: code || null
    }
  }, headers);
}

function baseUrl(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function mediaToken(jobId, index, expiresAt) {
  const signature = crypto.createHmac('sha256', sessionSecret()).update(`${jobId}:${index}:${expiresAt}`).digest('base64url');
  return `${expiresAt}.${signature}`;
}

function verifyMediaToken(jobId, index, token) {
  const [rawExpiry, signature] = String(token || '').split('.');
  const expiresAt = Number(rawExpiry);
  if (!expiresAt || expiresAt < Date.now() || !signature) return false;
  const expected = mediaToken(jobId, index, expiresAt).split('.')[1];
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function mediaUrl(req, jobId, index = 0) {
  const expiresAt = Date.now() + 7 * 86400000;
  return `${baseUrl(req)}/api/media/${encodeURIComponent(jobId)}/${index}?t=${mediaToken(jobId, index, expiresAt)}`;
}

function jobForClient(req, job) {
  if (!job) return job;
  return {
    ...job,
    images: (job.images || []).map((image, index) => ({ ...image, url: mediaUrl(req, job.id, index) }))
  };
}

async function toDataUrl(url) {
  const response = await httpRequest(url, { timeoutMs: 120000, retries: 1, maxBytes: 64 * 1024 * 1024 });
  if (response.status !== 200) throw new Error(`Could not download generated image (HTTP ${response.status}).`);
  const mime = String(response.headers['content-type'] || 'image/png').split(';')[0];
  return `data:${mime};base64,${response.body.toString('base64')}`;
}

async function openaiPayload(req, job, responseFormat = 'url') {
  const data = [];
  for (let index = 0; index < job.images.length; index += 1) {
    const image = job.images[index];
    if (responseFormat === 'b64_json') {
      const dataUrl = await toDataUrl(image.url);
      data.push({ b64_json: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    } else {
      data.push({ url: mediaUrl(req, job.id, index), revised_prompt: job.prompt });
    }
  }
  return {
    created: Math.floor(Date.parse(job.createdAt) / 1000),
    data,
    model: job.model,
    output: job.output,
    id: job.id
  };
}

function jobStatus(job) {
  return {
    id: job.id,
    object: 'image.generation',
    status: job.status,
    stage: job.stage,
    model: job.model,
    created: Math.floor(Date.parse(job.createdAt) / 1000),
    error: job.error,
    images: job.images.map((image, index) => ({ url: image.url, width: image.width, height: image.height, index })),
    output: job.output
  };
}

function collectionParams(input) {
  const value = Number(input);
  return Math.max(1, Math.min(4, Number.isFinite(value) ? Math.trunc(value) : 1));
}

function normalizeResponseFormat(value) {
  const normalized = String(value || 'url').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ['b64_json', 'base64', 'base_64', 'b64', 'data_url'].includes(normalized) ? 'b64_json' : 'url';
}

function referencesFrom(body) {
  const values = [];
  const keys = ['reference_images', 'referenceImages', 'image', 'images', 'image_url', 'imageUrl', 'input_image', 'inputImage', 'init_image', 'initImage', 'reference', 'reference_image'];
  for (const key of keys) {
    const value = body?.[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') values.push(item);
        else if (typeof item === 'object' && item?.url) values.push(String(item.url));
      }
    } else if (typeof value === 'string') {
      values.push(value);
    } else if (typeof value === 'object' && value?.url) {
      values.push(String(value.url));
    }
  }
  return values.filter(item => typeof item === 'string' && item.length > 0);
}

function generationParams(body, { edits = false } = {}) {
  const model = resolveModel(body?.model || config.defaultModel);
  const prompt = String(body?.prompt || body?.description || '').trim();
  const count = collectionParams(body?.n ?? body?.num ?? body?.count ?? 1);
  const references = referencesFrom(body);
  return {
    kind: edits || references.length ? 'i2i' : 't2i',
    model,
    prompt,
    count,
    references,
    responseFormat: normalizeResponseFormat(body?.response_format || body?.responseFormat || body?.output_format || body?.outputFormat || body?.output),
    quality: String(body?.quality || ''),
    background: String(body?.response_mode || '').toLowerCase() === 'async'
  };
}

async function createAndRun(req, params, { source, apiKeyId, idempotencyKey, background, isOpenAI }) {
  // Client key → retry-safe replay. No key → server issues a fresh UUID (parallel-safe).
  const key = idempotencyKey || crypto.randomUUID();
  const existing = findJobByIdempotency(key, apiKeyId);
  if (existing) {
    if (background) return { job: existing, replay: true };
    if (existing.status === 'queued' || existing.status === 'running') return { job: await waitForJob(existing.id), replay: true };
    return { job: existing, replay: true };
  }
  const job = createJob({
    kind: params.kind,
    source,
    apiKeyId,
    model: params.model.id,
    prompt: params.prompt,
    count: params.count,
    references: params.references,
    request: { prompt: params.prompt, model: params.model.id, count: params.count, references: params.references },
    idempotencyKey: key
  });
  if (background || params.background) {
    setImmediate(() => executeJob(job.id).catch(() => {}));
    return { job: getJob(job.id), replay: false };
  }
  const finished = await executeJob(job.id);
  return { job: finished, replay: false };
}

function openaiFailure(res, job, headers = {}) {
  const status = job.error?.code === 'no_accounts' ? 503 : job.error?.code === 'accounts_busy' ? 429 : 502;
  openaiError(res, status, job.error?.message || 'Image generation failed.', job.error?.code || 'generation_failed', '', headers);
}

async function handleGeneration(req, res, url, { edits = false } = {}) {
  const authHeader = req.headers.authorization || '';
  const raw = authHeader.replace(/^Bearer\s+/i, '').trim();
  const key = authenticate(raw);
  if (!key) return openaiError(res, 401, 'Missing or invalid API key.', 'invalid_api_key');
  const rate = checkRateLimit(key.id, Number(getSettings(['rateLimitRpm']).rateLimitRpm || config.rateLimitRpm));
  if (!rate.ok) return openaiError(res, 429, `Rate limit reached. Retry in ${rate.retryAfter}s.`, 'rate_limit_exceeded', '', { 'retry-after': String(rate.retryAfter) });

  let body;
  const contentType = String(req.headers['content-type'] || '');
  try {
    if (edits && contentType.includes('multipart/form-data')) {
      body = await parseMultipartRequest(req, contentType);
    } else {
      const rawBody = await readBody(req, 25 * 1024 * 1024);
      body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
    }
  } catch (error) {
    return openaiError(res, 400, `Invalid request body: ${error.message}`, 'invalid_body');
  }

  const params = generationParams(body, { edits });
  if (!params.prompt) return openaiError(res, 400, 'A prompt is required.', 'invalid_prompt', 'prompt');
  if (edits && !params.references.length) return openaiError(res, 400, 'At least one reference image is required.', 'missing_image', 'image');
  if (params.kind === 'i2i' && !edits) params.kind = 'i2i';

  const prefer = String(req.headers.prefer || '').toLowerCase();
  const background = prefer.includes('respond-async');
  const idempotencyKey = String(req.headers['idempotency-key'] || body.idempotencyKey || body.idempotency_key || '').slice(0, 200) || null;

  try {
    const { job, replay } = await createAndRun(req, params, {
      source: edits ? 'api-edit' : 'api',
      apiKeyId: key.id === 'env' ? null : key.id,
      idempotencyKey,
      background,
      isOpenAI: true
    });
    if (background || job.status === 'queued' || job.status === 'running') {
      return send(res, 202, jobStatus(job), { 'x-job-id': job.id, 'x-idempotent-replay': replay ? 'true' : 'false' });
    }
    if (job.status !== 'succeeded') return openaiFailure(res, job);
    const payload = await openaiPayload(req, job, params.responseFormat);
    send(res, 200, payload, { 'x-job-id': job.id });
  } catch (error) {
    openaiError(res, error.statusCode || 500, error.message, error.code || 'server_error');
  }
}

function parseMultipartRequest(req, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error('Missing multipart boundary.');
  const boundary = `--${match[1] || match[2]}`;
  return readBody(req, 30 * 1024 * 1024).then(raw => {
    const text = raw.toString('latin1');
    const parts = text.split(boundary).slice(1, -1);
    const body = { images: [] };
    for (const part of parts) {
      const index = part.indexOf('\r\n\r\n');
      if (index < 0) continue;
      const headers = part.slice(0, index);
      let content = part.slice(index + 4);
      if (content.endsWith('\r\n')) content = content.slice(0, -2);
      const nameMatch = headers.match(/name="([^"]+)"/i);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      const filenameMatch = headers.match(/filename="([^"]*)"/i);
      if (filenameMatch) {
        const typeMatch = headers.match(/content-type:\s*([^\r\n]+)/i);
        const mime = (typeMatch?.[1] || 'image/png').trim();
        body.images.push(`data:${mime};base64,${Buffer.from(content, 'latin1').toString('base64')}`);
      } else {
        body[name] = Buffer.from(content, 'latin1').toString('utf8');
      }
    }
    return body;
  });
}

function overview() {
  const jobs = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today
    FROM jobs`).get(new Date(Date.now() - 86400000).toISOString()) || {};
  const images = db.prepare("SELECT result_json FROM jobs WHERE status='succeeded' ORDER BY created_at DESC LIMIT 500").all();
  let imageCount = 0;
  for (const row of images) {
    const result = jsonParse(row.result_json, null);
    imageCount += Array.isArray(result?.images) ? result.images.length : 0;
  }
  const duration = db.prepare("SELECT AVG(duration_ms) AS avg FROM jobs WHERE status='succeeded' AND duration_ms IS NOT NULL").get();
  const credits = db.prepare('SELECT SUM(credits) AS total FROM accounts').get();
  const counts = accountCounts();
  return {
    version: VERSION,
    authRequired: authRequired(),
    jobs: {
      total: Number(jobs.total || 0),
      succeeded: Number(jobs.succeeded || 0),
      failed: Number(jobs.failed || 0),
      active: Number(jobs.active || 0),
      today: Number(jobs.today || 0),
      images: imageCount,
      avgDurationMs: duration?.avg ? Math.round(Number(duration.avg)) : null
    },
    accounts: { ...counts, credits: Number(credits?.total || 0) },
    settings: currentSettings(),
    automation: automationState()
  };
}

export function currentSettings() {
  const stored = getSettings(SETTING_KEYS);
  return {
    defaultModel: stored.defaultModel || config.defaultModel,
    accountConcurrency: Number(stored.accountConcurrency || config.accountConcurrency),
    maxAttempts: Number(stored.maxAttempts || config.maxAttempts),
    jobTimeoutMs: Number(stored.jobTimeoutMs || config.jobTimeoutMs),
    retentionDays: Number(stored.retentionDays || config.retentionDays),
    rateLimitRpm: Number(stored.rateLimitRpm || config.rateLimitRpm),
    autoSyncMinutes: stored.autoSyncMinutes === null || stored.autoSyncMinutes === undefined ? config.autoSyncMinutes : Number(stored.autoSyncMinutes)
  };
}

function validateSettings(body) {
  const output = {};
  if (body.defaultModel !== undefined) {
    const model = resolveModel(body.defaultModel);
    output.defaultModel = model.id;
  }
  const numeric = {
    accountConcurrency: [1, 5],
    maxAttempts: [1, 5],
    jobTimeoutMs: [30000, 900000],
    retentionDays: [1, 365],
    rateLimitRpm: [1, 10000],
    autoSyncMinutes: [0, 1440]
  };
  for (const [key, [min, max]] of Object.entries(numeric)) {
    if (body[key] === undefined) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value)) continue;
    output[key] = Math.max(min, Math.min(max, Math.trunc(value)));
  }
  if (output.defaultModel) output.defaultModel = resolveModel(output.defaultModel).id;
  return output;
}

async function serveMedia(req, res, jobId, index, url) {
  const job = getJob(jobId);
  if (!job) return send(res, 404, { ok: false, error: { code: 'job_not_found', message: 'Job not found.' } });
  const image = job.images[index];
  if (!image) return send(res, 404, { ok: false, error: { code: 'image_not_found', message: 'Image not found.' } });
  const token = url.searchParams.get('t');
  if (!isAdmin(req) && !verifyMediaToken(jobId, index, token)) {
    return send(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Invalid or expired media link.' } });
  }
  const response = await httpRequest(image.url, { timeoutMs: 120000, retries: 1, maxBytes: 64 * 1024 * 1024 });
  if (response.status !== 200) return send(res, 502, { ok: false, error: { code: 'media_failed', message: 'Could not load image.' } });
  res.writeHead(200, {
    'content-type': String(response.headers['content-type'] || 'image/png'),
    'content-length': response.body.length,
    'cache-control': 'private, max-age=86400'
  });
  res.end(response.body);
}

export async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (pathname === '/healthz') {
    return send(res, 200, { ok: true, version: VERSION, uptime: Math.round(process.uptime()), authRequired: authRequired() });
  }

  if (pathname === '/api/login' && method === 'POST') {
    try {
      const body = await readBody(req, 64 * 1024);
      const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
      if (!checkPassword(payload.password)) return fail(res, 401, 'Incorrect password.', 'invalid_password');
      return send(res, 200, { ok: true }, { 'set-cookie': issueSession() });
    } catch {
      return fail(res, 400, 'Invalid login request.', 'invalid_request');
    }
  }

  if (pathname === '/api/logout' && method === 'POST') {
    return send(res, 200, { ok: true }, { 'set-cookie': clearSession() });
  }

  if (pathname === '/api/session') {
    return send(res, 200, { ok: true, authenticated: isAdmin(req), authRequired: authRequired() });
  }

  const jobStatusMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobStatusMatch && method === 'GET') {
    const job = getJob(decodeURIComponent(jobStatusMatch[1]));
    if (!job) return fail(res, 404, 'Job not found.', 'job_not_found');
    if (isAdmin(req)) return send(res, 200, { ok: true, job: jobForClient(req, job) });
    const key = authenticate((req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim());
    const owned = key && (job.apiKeyId === key.id || (key.env && !job.apiKeyId));
    if (!owned) return fail(res, 401, 'Please sign in.', 'unauthorized');
    return send(res, 200, { ok: true, job: jobForClient(req, job) });
  }

  const mediaMatch = pathname.match(/^\/api\/media\/([^/]+)\/(\d+)$/);
  if (mediaMatch && method === 'GET') {
    return serveMedia(req, res, decodeURIComponent(mediaMatch[1]), Number(mediaMatch[2]), url);
  }

  if (pathname === '/v1/models' && method === 'GET') {
    if (!authenticate((req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim())) {
      return openaiError(res, 401, 'Missing or invalid API key.', 'invalid_api_key');
    }
    return send(res, 200, listModels());
  }

  const modelMatch = pathname.match(/^\/v1\/models\/(.+)$/);
  if (modelMatch && method === 'GET') {
    if (!authenticate((req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim())) {
      return openaiError(res, 401, 'Missing or invalid API key.', 'invalid_api_key');
    }
    return send(res, 200, modelInfo(resolveModel(decodeURIComponent(modelMatch[1]))));
  }

  if (pathname === '/v1/images/generations' && method === 'POST') {
    return handleGeneration(req, res, url, { edits: false });
  }
  if (pathname === '/v1/images/edits' && method === 'POST') {
    return handleGeneration(req, res, url, { edits: true });
  }

  if (!pathname.startsWith('/api/')) return false;
  if (!isAdmin(req)) return fail(res, 401, 'Please sign in.', 'unauthorized');

  if (pathname === '/api/overview' && method === 'GET') return send(res, 200, overview());
  if (pathname === '/api/models' && method === 'GET') return send(res, 200, listModels());

  if (pathname === '/api/accounts' && method === 'GET') {
    return send(res, 200, { profiles: listProfiles(), accounts: listAccounts(), counts: accountCounts() });
  }

  if (pathname === '/api/accounts/import' && method === 'POST') {
    try {
      const body = await readBody(req, 2 * 1024 * 1024);
      const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
      const profile = await importProfile({ name: payload.name, content: payload.content });
      let synced = null;
      let syncError = null;
      try {
        synced = await syncProfile(profile.id);
      } catch (error) {
        syncError = error.message;
      }
      return send(res, 200, { ok: true, profile, synced, syncError });
    } catch (error) {
      return fail(res, error.statusCode || 422, error.message, error.code || 'import_failed');
    }
  }

  const profileMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (profileMatch) {
    const profileId = decodeURIComponent(profileMatch[1]);
    if (method === 'PATCH' || method === 'PUT') {
      try {
        const body = await readBody(req, 2 * 1024 * 1024);
        const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
        const profile = await updateProfile(profileId, payload);
        let synced = null;
        let syncError = null;
        if (payload.content !== undefined && payload.content !== null && String(payload.content).trim()) {
          try {
            synced = await syncProfile(profileId);
          } catch (error) {
            syncError = error.message;
          }
        }
        return send(res, 200, { ok: true, profile: synced?.profile || profile, synced, syncError });
      } catch (error) {
        return fail(res, error.statusCode || 422, error.message, error.code || 'update_failed');
      }
    }
    if (method === 'DELETE') {
      try {
        return send(res, 200, deleteProfile(profileId));
      } catch (error) {
        return fail(res, error.statusCode || 400, error.message, error.code || 'delete_failed');
      }
    }
  }

  const syncMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/sync$/);
  if (syncMatch && method === 'POST') {
    try {
      return send(res, 200, { ok: true, ...(await syncProfile(decodeURIComponent(syncMatch[1]))) });
    } catch (error) {
      return fail(res, error.statusCode || 502, error.message, error.code || 'sync_failed');
    }
  }

  const creditsMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/credits$/);
  if (creditsMatch && method === 'POST') {
    try {
      return send(res, 200, { ok: true, credits: await refreshCredits(decodeURIComponent(creditsMatch[1])) });
    } catch (error) {
      return fail(res, error.statusCode || 502, error.message, error.code || 'credits_failed');
    }
  }

  const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/(\d+)$/);
  if (accountMatch && (method === 'PATCH' || method === 'PUT')) {
    try {
      const body = await readBody(req, 64 * 1024);
      const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
      const account = updateAccount(decodeURIComponent(accountMatch[1]), accountMatch[2], payload);
      return send(res, 200, { ok: true, account });
    } catch (error) {
      return fail(res, error.statusCode || 422, error.message, error.code || 'update_failed');
    }
  }

  const verifyMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/(\d+)\/verify$/);
  if (verifyMatch && method === 'POST') {
    try {
      return send(res, 200, await verifyAccount(decodeURIComponent(verifyMatch[1]), verifyMatch[2]));
    } catch (error) {
      return fail(res, error.statusCode || 502, error.message, error.code || 'verify_failed');
    }
  }

  if (pathname === '/api/jobs' && method === 'DELETE') return send(res, 200, clearJobs());
  if (pathname === '/api/jobs' && method === 'GET') {
    return send(res, 200, {
      jobs: listJobs({ limit: url.searchParams.get('limit'), status: url.searchParams.get('status') || '', source: url.searchParams.get('source') || '' })
    });
  }

  if (pathname === '/api/generate' && method === 'POST') {
    try {
      const body = await readBody(req, 30 * 1024 * 1024);
      const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
      const references = referencesFrom(payload);
      const model = resolveModel(payload.model || currentSettings().defaultModel);
      const prompt = String(payload.prompt || '').trim();
      if (!prompt) return fail(res, 422, 'A prompt is required.', 'invalid_prompt');
      const clientKey = String(payload.idempotencyKey || payload.idempotency_key || req.headers['idempotency-key'] || '').slice(0, 200) || null;
      const idempotencyKey = clientKey || crypto.randomUUID();
      if (clientKey) {
        const existing = findJobByIdempotency(clientKey, null);
        if (existing) return send(res, 200, { ok: true, job: existing, replay: true });
      }
      const kind = references.length ? 'i2i' : 't2i';
      const count = collectionParams(payload.count ?? payload.n ?? 1);
      const job = createJob({
        kind,
        source: 'playground',
        model: model.id,
        prompt,
        count,
        references,
        idempotencyKey,
        request: {
          prompt,
          model: model.id,
          count,
          references
        }
      });
      setImmediate(() => executeJob(job.id).catch(() => {}));
      return send(res, 202, { ok: true, job, replay: false });
    } catch (error) {
      return fail(res, error.statusCode || 400, error.message, error.code || 'generate_failed');
    }
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && method === 'DELETE') {
    return send(res, 200, deleteJob(decodeURIComponent(jobMatch[1])));
  }

  const retryMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
  if (retryMatch && method === 'POST') {
    try {
      return send(res, 202, { ok: true, job: retryJob(decodeURIComponent(retryMatch[1])) });
    } catch (error) {
      return fail(res, error.statusCode || 400, error.message, error.code || 'retry_failed');
    }
  }

  if (pathname === '/api/keys' && method === 'GET') return send(res, 200, { keys: listKeys() });
  if (pathname === '/api/keys' && method === 'POST') {
    try {
      const body = await readBody(req, 64 * 1024);
      const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
      return send(res, 200, { ok: true, ...createKey(payload.name) });
    } catch (error) {
      return fail(res, error.statusCode || 422, error.message, error.code || 'key_failed');
    }
  }
  const keyMatch = pathname.match(/^\/api\/keys\/([^/]+)$/);
  if (keyMatch && method === 'DELETE') {
    if (url.searchParams.get('purge') === '1') return send(res, 200, deleteKey(decodeURIComponent(keyMatch[1])));
    return send(res, 200, revokeKey(decodeURIComponent(keyMatch[1])));
  }

  if (pathname === '/api/automation/sync' && method === 'POST') {
    try {
      const result = await runAutomationNow();
      return send(res, 200, { ok: Boolean(result.ok), automation: automationState() });
    } catch (error) {
      return fail(res, error.statusCode || 502, error.message, error.code || 'sync_failed');
    }
  }

  if (pathname === '/api/settings/password' && method === 'POST') {
    try {
      const body = await readBody(req, 16 * 1024);
      const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
      if (authRequired() && !checkPassword(payload.currentPassword)) {
        return fail(res, 403, 'Current password is incorrect.', 'invalid_password');
      }
      setAdminPassword(payload.newPassword);
      return send(res, 200, { ok: true, message: 'Admin password updated.' }, { 'set-cookie': issueSession() });
    } catch (error) {
      return fail(res, error.statusCode || 422, error.message, error.code || 'password_change_failed');
    }
  }

  if (pathname === '/api/settings' && method === 'GET') return send(res, 200, { ok: true, settings: currentSettings() });
  if (pathname === '/api/settings' && method === 'PATCH') {
    try {
      const body = await readBody(req, 64 * 1024);
      const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
      for (const [key, value] of Object.entries(validateSettings(payload))) setSetting(key, value);
      return send(res, 200, { ok: true, settings: currentSettings() });
    } catch (error) {
      return fail(res, error.statusCode || 422, error.message, error.code || 'settings_failed');
    }
  }

  return fail(res, 404, 'Not found.', 'not_found');
}
