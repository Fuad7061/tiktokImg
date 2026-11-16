import { config } from './config.js';
import { db } from './db.js';
import { markError, markSessionExpired, markSuccess, scheduleCreditsRefresh } from './accounts.js';
import { httpError, jsonParse, nowIso, sleep, uid } from './utils.js';
import { modelOrDefault, resolveModel } from './provider/models.js';
import { canvasFor, resolveDimensions } from './provider/png.js';
import { uploadImage } from './provider/upload.js';
import { normalizeReferences, referenceBuffer } from './provider/refs.js';
import { pollGeneration, submitGeneration } from './provider/client.js';
import { acquireAccount, accountKey, releaseAccount } from './provider/pool.js';

const running = new Set();
const jobBuffers = new Map();

function parseRow(row) {
  if (!row) return null;
  const result = jsonParse(row.result_json, null);
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    apiKeyId: row.api_key_id || null,
    model: row.model,
    prompt: row.prompt,
    ratio: row.ratio,
    size: row.size,
    requested: row.requested,
    status: row.status,
    stage: row.stage,
    error: row.error_message ? { code: row.error_code || '', message: row.error_message } : null,
    account: row.account_id ? { profileId: row.cookie_profile_id, accountId: row.account_id } : null,
    taskId: row.task_id,
    attempts: row.attempts,
    images: result?.images || [],
    partial: Boolean(result?.partial),
    output: result
      ? { model: result.model, ratio: result.ratio, size: result.size, partial: Boolean(result.partial) }
      : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms
  };
}

export function getJob(id) {
  return parseRow(db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
}

export function listJobs({ limit = 50, status = '', source = '' } = {}) {
  const clauses = [];
  const values = [];
  if (status) {
    clauses.push('status=?');
    values.push(status);
  }
  if (source) {
    clauses.push('source=?');
    values.push(source);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...values, Math.max(1, Math.min(200, Number(limit) || 50)))
    .map(parseRow);
}

export function findJobByIdempotency(key, apiKeyId = null) {
  if (!key) return null;
  return parseRow(db.prepare("SELECT * FROM jobs WHERE idempotency_key=? AND COALESCE(api_key_id,'')=?")
    .get(String(key), String(apiKeyId || '')));
}

export function createJob({ kind, source, apiKeyId = null, model, prompt, count = 1, references = [], request = {}, idempotencyKey = null }) {
  const resolved = resolveModel(model || config.defaultModel);
  const normalizedRefs = normalizeReferences(references);
  const jobId = uid('job');
  const at = nowIso();
  const dims = kind === 't2i' ? resolveDimensions({ ratio: '9:16' }) : null;
  const refsJson = JSON.stringify({ inputs: normalizedRefs, remoteUrls: [], canvasUrl: null });
  const requestJson = JSON.stringify({
    prompt,
    model: resolved.id,
    count,
    references: normalizedRefs
  });
  db.prepare(`INSERT INTO jobs(id,kind,source,api_key_id,model,prompt,ratio,size,requested,status,stage,refs_json,request_json,idempotency_key,attempts,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`).run(
    jobId,
    kind,
    source,
    apiKeyId,
    resolved.id,
    prompt,
    dims?.ratio || 'auto',
    dims?.label || '',
    count,
    'queued',
    'queued',
    refsJson,
    requestJson,
    idempotencyKey,
    at
  );
  return getJob(jobId);
}

function updateJob(id, fields) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  const sql = `UPDATE jobs SET ${entries.map(([key]) => `${key}=?`).join(', ')} WHERE id=?`;
  db.prepare(sql).run(...entries.map(([, value]) => value), id);
}

function setStage(id, stage) {
  updateJob(id, { stage });
}

function finishFailure(row, error) {
  const message = String(error.message || 'Generation failed.').slice(0, 1000);
  updateJob(row.id, {
    status: 'failed',
    stage: 'failed',
    error_code: String(error.code || 'generation_failed'),
    error_message: message,
    finished_at: nowIso(),
    duration_ms: Date.now() - Date.parse(row.started_at || row.created_at)
  });
}

function accountFault(error) {
  if (['invalid_reference', 'reference_download_failed', 'reference_too_large', 'too_many_references'].includes(error.code)) return false;
  if (Number(error.statusCode) >= 400 && Number(error.statusCode) < 500) return false;
  return true;
}

function sessionFault(error) {
  return Number(error.statusCode) === 401 || error.code === 'session_expired' || /session (has )?expired|login required|cookie (expired|invalid)/i.test(String(error.message || ''));
}

async function prepareReferences(buffers) {
  const output = [];
  for (const reference of buffers) output.push(await referenceBuffer(reference));
  return output;
}

function refsState(row) {
  return jsonParse(row.refs_json, { inputs: [], remoteUrls: [], canvasUrl: null });
}

function saveRefs(id, refs) {
  updateJob(id, { refs_json: JSON.stringify(refs) });
}

export async function executeJob(jobId) {
  if (running.has(jobId)) return getJob(jobId);
  const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
  if (!row) throw httpError(404, 'Job not found.', 'job_not_found');
  if (row.status === 'succeeded') return parseRow(row);
  if (row.status === 'running') return parseRow(row);

  running.add(jobId);
  updateJob(jobId, { status: 'running', stage: 'preparing', started_at: nowIso(), finished_at: null, duration_ms: null });
  const startedAt = Date.now();

  try {
    const request = jsonParse(row.request_json, {});
    const model = modelOrDefault(request.model || row.model);
    const count = Math.max(1, Math.min(model.maxOutputs, Number(request.count || row.requested || 1)));
    const dims = row.kind === 't2i' ? resolveDimensions({ ratio: '9:16' }) : null;
    const references = request.references || [];
    const buffers = row.kind === 'i2i' && references.length ? await prepareReferences(references) : [];
    jobBuffers.set(jobId, buffers);

    const excluded = new Set();
    let lastError = null;
    let attempt = 0;
    const maxAttempts = Math.max(1, Number(config.maxAttempts));

    while (attempt < maxAttempts) {
      attempt += 1;
      updateJob(jobId, { attempts: attempt });
      let account = null;
      try {
        account = await acquireAccount(excluded);
        const refs = refsState(db.prepare('SELECT refs_json FROM jobs WHERE id=?').get(jobId));
        setStage(jobId, 'uploading');
        let imageUrls = [];
        if (row.kind === 't2i') {
          if (!refs.canvasUrl) {
            const uploaded = await uploadImage(canvasFor(dims), {
              profileId: account.profileId,
              accountId: account.accountId,
              width: dims.width,
              height: dims.height,
              mime: 'image/png'
            });
            refs.canvasUrl = uploaded.cdnUrl;
            saveRefs(jobId, refs);
          }
          imageUrls = [refs.canvasUrl];
        } else {
          if (!refs.remoteUrls || refs.remoteUrls.length !== buffers.length) {
            refs.remoteUrls = [];
            for (const buffer of buffers) {
              const uploaded = await uploadImage(buffer.buffer, {
                profileId: account.profileId,
                accountId: account.accountId,
                mime: buffer.mime,
                width: 0,
                height: 0
              });
              refs.remoteUrls.push(uploaded.cdnUrl);
            }
            saveRefs(jobId, refs);
          }
          imageUrls = refs.remoteUrls;
        }

        setStage(jobId, 'submitting');
        const submitted = await submitGeneration({
          profileId: account.profileId,
          accountId: account.accountId,
          prompt: request.prompt || row.prompt,
          model,
          num: count,
          imageUrls
        });
        updateJob(jobId, { cookie_profile_id: account.profileId, account_id: account.accountId, task_id: submitted.taskId });
        setStage(jobId, 'polling');
        const generated = await pollGeneration({
          profileId: account.profileId,
          accountId: account.accountId,
          taskId: submitted.taskId,
          count,
          timeoutMs: config.jobTimeoutMs,
          onProgress: progress => {
            const label = progress.settled ? 'finalizing' : `polling ${progress.images}/${count}`;
            const current = db.prepare('SELECT stage FROM jobs WHERE id=?').get(jobId)?.stage || '';
            if (current !== label) updateJob(jobId, { stage: label });
          }
        });

        const result = {
          images: generated.images.map(image => ({
            url: image.url,
            width: image.width || generated.images[0]?.width || null,
            height: image.height || generated.images[0]?.height || null
          })),
          model: model.id,
          ratio: dims?.ratio || 'auto',
          size: dims?.label || '',
          partial: generated.partial,
          taskId: submitted.taskId
        };
        markSuccess(account.profileId, account.accountId, generated.images.length);
        scheduleCreditsRefresh(account.profileId);
        updateJob(jobId, {
          status: 'succeeded',
          stage: 'succeeded',
          error_code: null,
          error_message: null,
          result_json: JSON.stringify(result),
          finished_at: nowIso(),
          duration_ms: Date.now() - startedAt
        });
        return getJob(jobId);
      } catch (error) {
        lastError = error;
        if (account) {
          if (sessionFault(error)) markSessionExpired(account.profileId, error.message);
          if (accountFault(error)) markError(account.profileId, account.accountId, error.message);
          excluded.add(accountKey(account));
          releaseAccount(account);
          account = null;
        }
        if (!accountFault(error)) break;
      } finally {
        if (account) releaseAccount(account);
      }
    }

    finishFailure(row, lastError || new Error('No account could complete the request.'));
    return getJob(jobId);
  } catch (error) {
    finishFailure(row, error);
    return getJob(jobId);
  } finally {
    jobBuffers.delete(jobId);
    running.delete(jobId);
  }
}

export async function waitForJob(id, timeoutMs = config.jobTimeoutMs + 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJob(id);
    if (!job) throw httpError(404, 'Job not found.', 'job_not_found');
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await sleep(400);
  }
  return getJob(id);
}

export function retryJob(id) {
  const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!row) throw httpError(404, 'Job not found.', 'job_not_found');
  if (row.status === 'running') throw httpError(409, 'Job is still running.', 'job_running');
  updateJob(id, {
    status: 'queued',
    stage: 'queued',
    error_code: null,
    error_message: null,
    task_id: null,
    result_json: null,
    finished_at: null,
    duration_ms: null,
    attempts: 0
  });
  const job = getJob(id);
  setImmediate(() => executeJob(id).catch(() => {}));
  return job;
}

export async function runNewJob(params) {
  const job = createJob(params);
  if (params.background) {
    setImmediate(() => executeJob(job.id).catch(() => {}));
    return job;
  }
  return executeJob(job.id);
}

export function clearJobs() {
  const result = db.prepare('DELETE FROM jobs').run();
  return { ok: true, deleted: Number(result.changes || 0) };
}

export function deleteJob(id) {
  const row = db.prepare('SELECT id FROM jobs WHERE id=?').get(id);
  if (!row) throw httpError(404, 'Job not found.', 'job_not_found');
  db.prepare('DELETE FROM jobs WHERE id=?').run(id);
  return { ok: true };
}
