import crypto from 'node:crypto';
import { csrfFromCookieHeader, profileCookieHeader } from '../cookies.js';
import { httpRequest } from '../http.js';
import { sleep } from '../utils.js';

const BASE = 'https://ads.tiktok.com';
const QUERY = 'aid=585599&app_name=creative_aio_client&device_platform=web';
const REFERER = `${BASE}/creative/creativestudio/image-to-video`;
const UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';

function submitHeaders(cookieHeader, csrf) {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json; charset=utf-8',
    'agw-js-conv': 'str',
    'user-agent': UA,
    cookie: cookieHeader,
    referer: REFERER,
    'x-creative-source': 'CreativeStudio/MiniApp/ImageToVideo',
    ...(csrf ? { 'x-csrftoken': csrf } : {})
  };
}

function checkHeaders(cookieHeader, csrf) {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'agw-js-conv': 'str',
    cookie: cookieHeader,
    referer: REFERER,
    'x-creative-source': 'creative_studio',
    ...(csrf ? { 'x-csrftoken': csrf } : {})
  };
}

export async function submitGeneration({ profileId, accountId, prompt, model, num, imageUrls }) {
  const { cookieHeader } = profileCookieHeader(profileId, accountId);
  const csrf = csrfFromCookieHeader(cookieHeader);
  const settings = {
    aiModel: model.id,
    prompt,
    images: imageUrls.map((url, index) => ({
      fileType: 'image',
      id: crypto.randomUUID(),
      label: `image ${index + 1}`,
      name: `image-${index + 1}.png`,
      previewUrl: url,
      imageSrcSet: { origin: url },
      previewUrlSrcSet: { origin: url }
    })),
    num
  };
  const body = JSON.stringify({ images: imageUrls, prompt, model: model.id, num, settings: JSON.stringify(settings) });
  const response = await httpRequest(`${BASE}/creative_bff_i18n/api/cue/i2v/gen_i2i_image?${QUERY}`, {
    method: 'POST',
    headers: submitHeaders(cookieHeader, csrf),
    body,
    timeoutMs: 120000,
    retries: 0
  });
  const taskId = response.json?.data?.task_id;
  if (response.status !== 200 || Number(response.json?.code) !== 0 || !taskId) {
    const message = response.json?.message || response.json?.msg || response.text?.slice(0, 300) || `HTTP ${response.status}`;
    throw Object.assign(new Error(`Generation request rejected: ${message}`), {
      code: 'submit_failed',
      httpStatus: response.status,
      platformCode: response.json?.code
    });
  }
  return { taskId: String(taskId), raw: response.json };
}

export async function checkGeneration({ profileId, accountId, taskId }) {
  const { cookieHeader } = profileCookieHeader(profileId, accountId);
  const csrf = csrfFromCookieHeader(cookieHeader);
  const response = await httpRequest(`${BASE}/creative_bff_i18n/api/cue/generate-task/check?${QUERY}`, {
    method: 'POST',
    headers: checkHeaders(cookieHeader, csrf),
    body: JSON.stringify({ taskId }),
    timeoutMs: 60000,
    retries: 1
  });
  if (response.status !== 200 || (Number(response.json?.code) !== 0 && response.json?.code !== undefined)) {
    const message = response.json?.message || response.json?.msg || `HTTP ${response.status}`;
    throw Object.assign(new Error(`Status check failed: ${message}`), { code: 'check_failed' });
  }
  return response.json?.data || {};
}

function parseRows(payload, taskId) {
  const rows = Array.isArray(payload?.draft_infos) ? payload.draft_infos : [];
  const matching = rows.filter(row => row.taskId == null || String(row.taskId) === String(taskId));
  return matching.length ? matching : rows;
}

export async function pollGeneration({ profileId, accountId, taskId, count = 1, timeoutMs = 300000, onProgress }) {
  const deadline = Date.now() + timeoutMs;
  const images = [];
  const seen = new Set();
  let errors = [];
  let lastRows = [];
  let delay = 3000;
  let lastChange = Date.now();

  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(5000, delay + 250);
    let payload;
    try {
      payload = await checkGeneration({ profileId, accountId, taskId });
    } catch (error) {
      if (error.code === 'check_failed' && /login|expired/i.test(error.message)) throw error;
      continue;
    }
    const rows = parseRows(payload, taskId);
    lastRows = rows;
    errors = [];
    for (const row of rows) {
      const url = row.imageSrcSet?.origin || row.imageSrcSet?.webp || row.coverImage || row.imageUrl || '';
      if (url && !seen.has(url)) {
        seen.add(url);
        lastChange = Date.now();
        images.push({
          url,
          width: Number(row.imageWidth || row.width || 0) || null,
          height: Number(row.imageHeight || row.height || 0) || null
        });
      }
      if (!url && row.generateErrorCode) {
        errors.push({ code: String(row.generateErrorCode), message: String(row.generateErrorMessage || 'Generation failed.') });
      }
    }
    const settled = rows.length > 0 && rows.every(row => row.imageSrcSet?.origin || row.imageSrcSet?.webp || row.coverImage || row.imageUrl || row.generateErrorCode);
    onProgress?.({ images: images.length, settled, rows: rows.length });
    if (images.length >= count && settled) break;
    if (settled && images.length) break;
    if (images.length >= count) break;
    if (images.length && Date.now() - lastChange > 45000) break;
    if (settled && !images.length && errors.length) {
      const unique = [...new Map(errors.map(item => [item.code, item])).values()];
      throw Object.assign(new Error(unique.map(item => `${item.message} (${item.code})`).join('; ')), {
        code: 'generation_failed',
        platformCode: unique[0]?.code || ''
      });
    }
  }

  if (!images.length) {
    const detail = errors.length ? ` ${errors[0].message}` : '';
    throw Object.assign(new Error(`Generation timed out after ${Math.round(timeoutMs / 1000)}s.${detail}`), { code: 'timeout' });
  }
  return {
    images: images.slice(0, count),
    rows: lastRows.length,
    partial: images.length < count
  };
}
