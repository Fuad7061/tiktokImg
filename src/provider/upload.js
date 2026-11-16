import crypto from 'node:crypto';
import { db } from '../db.js';
import { csrfFromCookieHeader, profileCookieHeader } from '../cookies.js';
import { httpRequest } from '../http.js';
import { nowIso, sha256Hex } from '../utils.js';
import { crc32Hex } from './png.js';

const SERVICE_ID = 'n2703mo9gi';
const UPLOAD_HOST = 'tos-my216-up.tiktokcdn.com';
const IMAGE_HOST = 'https://p19-creative-tool-sg.ibyteimg.com';
const PROXY = 'https://ads.tiktok.com/creative/creativestudio/upload-proxy';
const REFERER = 'https://ads.tiktok.com/creative/creativestudio/image-to-video';

const inflight = new Map();

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function normalizedHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) output[key.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  return output;
}

function canonicalQuery(params) {
  return [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function signAws({ method, url, headers, body = '', accessKeyId, secretAccessKey, amzDate, service = 'imagex', region = 'i18n' }) {
  const target = new URL(url);
  const lower = normalizedHeaders(headers);
  const names = Object.keys(lower).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map(name => `${name}:${lower[name]}\n`).join('');
  const payloadHash = lower['x-amz-content-sha256'] || sha256Hex(body);
  const canonicalRequest = [method.toUpperCase(), target.pathname || '/', canonicalQuery(target.searchParams), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function buildSessionKey({ storeUri, auth, uploadId }) {
  return Buffer.from(JSON.stringify({
    accountType: 'ImageX',
    appId: '',
    bizType: '',
    fileType: 'image',
    legal: '',
    storeInfos: JSON.stringify([{ StoreUri: storeUri, Auth: auth, UploadID: uploadId, UploadHeader: null }]),
    uploadHost: UPLOAD_HOST,
    uri: storeUri,
    userId: ''
  })).toString('base64');
}

function creativeImageUrl(uri) {
  if (/^https?:\/\//i.test(uri)) return uri;
  return `${IMAGE_HOST}/${uri}~tplv-n2703mo9gi-webp:1280:1280.image`;
}

async function fetchUploadToken(cookieHeader, csrf) {
  const response = await httpRequest(
    'https://ads.tiktok.com/creative_bff_i18n/api/cue/upload/token?aid=585599&app_name=creative_aio_client&device_platform=web',
    {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        cookie: cookieHeader,
        referer: REFERER,
        'x-creative-source': 'CreativeStudio/MiniApp/ImageToVideo',
        ...(csrf ? { 'x-csrftoken': csrf } : {})
      },
      body: '{}',
      timeoutMs: 60000,
      retries: 1
    }
  );
  if (response.status < 200 || response.status >= 300 || Number(response.json?.code) !== 0) {
    throw new Error(`Upload token failed (HTTP ${response.status}).`);
  }
  return response.json.data;
}

async function applyUpload({ token, fileSize, cookieHeader }) {
  const url = new URL(PROXY);
  url.searchParams.set('Action', 'ApplyImageUpload');
  url.searchParams.set('Version', '2018-08-01');
  url.searchParams.set('ServiceId', SERVICE_ID);
  url.searchParams.set('FileSize', String(fileSize));
  url.searchParams.set('s', Math.random().toString(36).slice(2, 13));
  url.searchParams.set('device_platform', 'web');
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const signed = { 'x-amz-date': amzDate, 'x-amz-security-token': token.SessionToken || '' };
  const authorization = signAws({ method: 'GET', url: url.toString(), headers: signed, accessKeyId: token.AccessKeyId, secretAccessKey: token.SecretAccessKey, amzDate });
  const response = await httpRequest(url.toString(), {
    headers: { ...signed, authorization, cookie: cookieHeader, referer: REFERER },
    timeoutMs: 90000,
    retries: 2
  });
  if (response.status < 200 || response.status >= 300 || !response.json?.Result?.UploadAddress) {
    throw new Error(`Upload init failed (HTTP ${response.status}).`);
  }
  return response.json.Result.UploadAddress;
}

async function uploadBytes({ buffer, storeUri, auth }) {
  const response = await httpRequest(`https://${UPLOAD_HOST}/upload/v1/${storeUri}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      authorization: auth,
      'content-crc32': crc32Hex(buffer),
      'content-disposition': 'attachment; filename="image.png"',
      'x-storage-u': 'ad_creative_tools_unknown_user',
      referer: 'https://ads.tiktok.com/'
    },
    body: buffer,
    timeoutMs: 120000,
    retries: 2
  });
  if (response.status < 200 || response.status >= 300 || (response.text && Number(response.json?.code) !== 2000)) {
    throw new Error(`Image upload failed (HTTP ${response.status}).`);
  }
}

async function commitUpload({ cookieHeader, token, storeUri, auth, uploadId, sessionKey }) {
  const url = `${PROXY}?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${SERVICE_ID}`;
  const body = JSON.stringify({ SessionKey: sessionKey || buildSessionKey({ storeUri, auth, uploadId }) });
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const signed = {
    'x-amz-content-sha256': sha256Hex(body),
    'x-amz-date': amzDate,
    'x-amz-security-token': token.SessionToken || ''
  };
  const authorization = signAws({ method: 'POST', url, headers: signed, body, accessKeyId: token.AccessKeyId, secretAccessKey: token.SecretAccessKey, amzDate });
  const response = await httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed, authorization, cookie: cookieHeader, referer: REFERER },
    body,
    timeoutMs: 90000,
    retries: 2
  });
  if (response.status < 200 || response.status >= 300 || !response.json?.Result) {
    throw new Error(`Upload commit failed (HTTP ${response.status}).`);
  }
  return response.json;
}

async function uploadRemote({ buffer, sha256, profileId, accountId, mime, width, height }) {
  const { cookieHeader } = profileCookieHeader(profileId, accountId);
  const csrf = csrfFromCookieHeader(cookieHeader);
  const token = await fetchUploadToken(cookieHeader, csrf);
  const address = await applyUpload({ token, fileSize: buffer.length, cookieHeader });
  const store = address.StoreInfos?.[0];
  if (!store) throw new Error('Upload init returned no storage info.');
  await uploadBytes({ buffer, storeUri: store.StoreUri, auth: store.Auth });
  await new Promise(resolve => setTimeout(resolve, 400));
  const commit = await commitUpload({
    cookieHeader,
    token,
    storeUri: store.StoreUri,
    auth: store.Auth,
    uploadId: store.UploadID,
    sessionKey: address.SessionKey
  });
  const plugin = commit?.Result?.PluginResult?.[0] || {};
  const result = commit?.Result?.Results?.[0] || {};
  const uri = plugin.ImageUri || result.Uri || store.StoreUri;
  const remote = {
    cdnUrl: creativeImageUrl(uri),
    remoteUri: uri,
    width: Number(plugin.ImageWidth || width || 0),
    height: Number(plugin.ImageHeight || height || 0)
  };
  const at = nowIso();
  db.prepare(`INSERT INTO uploads(sha256,cookie_profile_id,account_id,cdn_url,mime,width,height,created_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(sha256,cookie_profile_id,account_id) DO UPDATE SET cdn_url=excluded.cdn_url`,
  ).run(sha256, profileId, accountId, remote.cdnUrl, mime || 'image/png', remote.width, remote.height, at);
  return remote;
}

export async function uploadImage(buffer, { profileId, accountId, mime = 'image/png', width = 0, height = 0 } = {}) {
  const sha256 = sha256Hex(buffer);
  const cached = db.prepare('SELECT cdn_url, width, height FROM uploads WHERE sha256=? AND cookie_profile_id=? AND account_id=?')
    .get(sha256, profileId, accountId);
  if (cached?.cdn_url) return { cdnUrl: cached.cdn_url, width: cached.width, height: cached.height, cacheHit: true };

  const key = `${profileId}:${accountId}:${sha256}`;
  if (inflight.has(key)) return inflight.get(key);
  const promise = uploadRemote({ buffer, sha256, profileId, accountId, mime, width, height })
    .then(result => ({ ...result, cacheHit: false }))
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) throw new Error('Invalid data URL.');
  const mime = match[1] || 'image/png';
  const value = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  return { buffer: value, mime };
}
