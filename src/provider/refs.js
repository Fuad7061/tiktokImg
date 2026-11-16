import dns from 'node:dns/promises';
import net from 'node:net';
import { httpRequest } from '../http.js';
import { httpError } from '../utils.js';
import { dataUrlToBuffer } from './upload.js';

const MAX_BYTES = 25 * 1024 * 1024;

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value === '::1' || value === '::') return true;
    if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true;
    if (value.startsWith('fc') || value.startsWith('fd')) return true;
    if (value.startsWith('::ffff:')) return isPrivateIp(value.slice(7));
    return false;
  }
  return true;
}

async function assertPublicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw httpError(400, 'Invalid reference image URL.', 'invalid_reference', 'image');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw httpError(400, 'Reference images must use http(s).', 'invalid_reference', 'image');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) {
    throw httpError(400, 'Private hosts are not allowed for reference images.', 'invalid_reference', 'image');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw httpError(400, 'Private IP addresses are not allowed for reference images.', 'invalid_reference', 'image');
    return url;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw httpError(400, `Could not resolve reference host: ${host}`, 'invalid_reference', 'image');
  }
  if (!records.length || records.some(record => isPrivateIp(record.address))) {
    throw httpError(400, 'Reference host resolves to a private address.', 'invalid_reference', 'image');
  }
  return url;
}

async function fetchWithRedirects(url, depth = 0) {
  if (depth > 3) throw httpError(400, 'Too many redirects for reference image.', 'invalid_reference', 'image');
  await assertPublicUrl(url);
  const response = await httpRequest(url, { timeoutMs: 60000, retries: 1, followRedirects: false, maxBytes: MAX_BYTES });
  if (response.status >= 300 && response.status < 400 && response.headers.location) {
    return fetchWithRedirects(new URL(response.headers.location, url).toString(), depth + 1);
  }
  if (response.status !== 200) throw httpError(400, `Reference image download failed (HTTP ${response.status}).`, 'reference_download_failed', 'image');
  return { buffer: response.body, mime: String(response.headers['content-type'] || 'image/png').split(';')[0] };
}

export async function referenceBuffer(reference) {
  if (reference?.kind === 'data') {
    const { buffer, mime } = dataUrlToBuffer(reference.dataUrl);
    if (buffer.length > MAX_BYTES) throw httpError(413, 'Reference image is too large.', 'reference_too_large', 'image');
    return { buffer, mime };
  }
  if (reference?.kind === 'url') {
    const { buffer, mime } = await fetchWithRedirects(reference.url);
    if (buffer.length > MAX_BYTES) throw httpError(413, 'Reference image is too large.', 'reference_too_large', 'image');
    return { buffer, mime };
  }
  throw httpError(400, 'Unsupported reference image.', 'invalid_reference', 'image');
}

export function normalizeReferences(input) {
  const values = Array.isArray(input) ? input : input == null ? [] : [input];
  const output = [];
  for (const value of values) {
    if (value == null || value === '') continue;
    if (typeof value !== 'string') throw httpError(400, 'Reference images must be URLs or data URLs.', 'invalid_reference', 'image');
    if (/^https?:\/\//i.test(value)) output.push({ kind: 'url', url: value });
    else if (/^data:image\//i.test(value)) output.push({ kind: 'data', dataUrl: value });
    else throw httpError(400, 'Reference images must be http(s) URLs or data URLs.', 'invalid_reference', 'image');
    if (output.length > 4) throw httpError(400, 'At most 4 reference images are supported per request.', 'too_many_references', 'image');
  }
  return output;
}
