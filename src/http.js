import http from 'node:http';
import https from 'node:https';
import { sleep } from './utils.js';

const MAX_REDIRECTS = 5;

function once(url, options) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const body = options.body == null ? null : Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body));
  const headers = { 'user-agent': 'image-studio/1.0', accept: 'application/json, text/plain, */*', ...(options.headers || {}) };
  if (body) headers['content-length'] = String(body.length);

  return new Promise((resolve, reject) => {
    const req = transport.request(target, { method: options.method || 'GET', headers }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > (options.maxBytes || 64 * 1024 * 1024)) {
          req.destroy(new Error('Response body too large.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* not JSON */
        }
        resolve({ status: response.statusCode || 0, headers: response.headers, body: raw, text, json });
      });
      response.on('error', reject);
    });
    req.setTimeout(options.timeoutMs || 30000, () => req.destroy(new Error('Request timed out.')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function httpRequest(url, options = {}) {
  let currentUrl = url;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    let lastError = null;
    const attempts = Math.max(1, options.retries ?? 1);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await once(currentUrl, options);
        if (response.status >= 300 && response.status < 400 && response.headers.location) {
          if (options.followRedirects === false) return response;
          currentUrl = new URL(response.headers.location, currentUrl).toString();
          lastError = null;
          break;
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < attempts) {
          await sleep(400 * attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await sleep(400 * attempt);
      }
    }
    if (lastError) throw lastError;
    if (redirect === MAX_REDIRECTS) throw new Error('Too many redirects.');
  }
  throw new Error('Request failed.');
}

export async function downloadBuffer(url, timeoutMs = 60000) {
  const response = await httpRequest(url, { timeoutMs, retries: 1 });
  if (response.status !== 200) throw new Error(`Image download failed (HTTP ${response.status}).`);
  return response.body;
}
