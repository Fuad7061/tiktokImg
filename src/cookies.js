import { db } from './db.js';
import { decryptSecret, encryptSecret } from './vault.js';
import { httpError, nowIso } from './utils.js';

const HOST = 'ads.tiktok.com';
const COOKIE_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function normalizeCookie(cookie) {
  if (!cookie?.name) return null;
  const domain = cookie.domain || '.tiktok.com';
  return {
    name: String(cookie.name),
    value: String(cookie.value ?? ''),
    domain,
    path: cookie.path || '/',
    hostOnly: cookie.hostOnly ?? !String(domain).startsWith('.'),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    expires: cookie.session ? -1 : Number(cookie.expirationDate ?? cookie.expires ?? -1)
  };
}

function parseNetscape(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    const parts = line.replace(/^#HttpOnly_/, '').split(/\t+/);
    if (parts.length < 7) continue;
    const [domain, subdomains, cookiePath, secure, expires, name, ...valueParts] = parts;
    rows.push(normalizeCookie({
      domain,
      hostOnly: subdomains !== 'TRUE',
      path: cookiePath,
      secure: secure === 'TRUE',
      httpOnly: line.startsWith('#HttpOnly_'),
      expires: Number(expires) || -1,
      name,
      value: valueParts.join('\t')
    }));
  }
  return rows.filter(Boolean);
}

export function parseCookieText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try {
    const json = JSON.parse(raw);
    const source = Array.isArray(json) ? json : Array.isArray(json?.cookies) ? json.cookies : [];
    if (source.length) return source.map(normalizeCookie).filter(Boolean);
  } catch {
    /* not JSON */
  }
  const netscape = parseNetscape(raw);
  if (netscape.length) return netscape;
  if (raw.includes('=')) {
    return raw.split(';').map(item => item.trim()).filter(Boolean).map(pair => {
      const index = pair.indexOf('=');
      return index > 0 ? normalizeCookie({ name: pair.slice(0, index).trim(), value: pair.slice(index + 1) }) : null;
    }).filter(Boolean);
  }
  return [];
}

export function cookieExpiry(cookies) {
  const times = cookies.map(cookie => Number(cookie.expires)).filter(value => Number.isFinite(value) && value > 0);
  if (!times.length) return null;
  return new Date(Math.min(...times) * 1000).toISOString();
}

export function cookieHeaderFromText(text, url = `https://${HOST}/`, accountId = '') {
  const target = new URL(url);
  if (target.hostname !== HOST) throw httpError(400, 'Cookies are only allowed for ads.tiktok.com.', 'invalid_cookie_host');
  const cookies = parseCookieText(text).filter(cookie => {
    const domain = String(cookie.domain).replace(/^\./, '').toLowerCase();
    const domainMatches = cookie.hostOnly ? target.hostname === domain : target.hostname === domain || target.hostname.endsWith(`.${domain}`);
    const prefix = String(cookie.path || '/');
    const pathMatches = target.pathname === prefix || (target.pathname.startsWith(prefix) && (prefix.endsWith('/') || target.pathname[prefix.length] === '/'));
    return domainMatches && pathMatches && (!cookie.secure || target.protocol === 'https:') &&
      (!(cookie.expires > 0) || cookie.expires > Date.now() / 1000) &&
      COOKIE_NAME_RE.test(cookie.name) && !/[\r\n;]/.test(cookie.value) &&
      (!accountId || cookie.name !== 's_aio_client_id');
  }).sort((a, b) => b.path.length - a.path.length);
  if (accountId) {
    if (!/^\d+$/.test(String(accountId))) throw httpError(400, 'Invalid account id.', 'invalid_account_id');
    cookies.push({ name: 's_aio_client_id', value: String(accountId) });
  }
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

export function csrfFromCookieHeader(header) {
  const match = String(header || '').match(/(?:^|;\s*)csrftoken=([^;]+)/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function profileSecret(profileId) {
  const row = db.prepare('SELECT * FROM cookie_profiles WHERE id=?').get(profileId);
  if (!row) throw httpError(404, 'Cookie profile not found.', 'profile_not_found');
  return { row, content: decryptSecret(row.secret) };
}

export function profileCookieHeader(profileId, accountId = '', url = `https://${HOST}/`) {
  const { row, content } = profileSecret(profileId);
  return { row, content, cookieHeader: cookieHeaderFromText(content, url, accountId) };
}

export function encryptCookieText(text) {
  return encryptSecret(text);
}

export function saveProfileContent(profileId, content) {
  const cookies = parseCookieText(content);
  if (!cookies.length) throw httpError(422, 'No valid cookies were found in the provided text.', 'invalid_cookies');
  const expiresAt = cookieExpiry(cookies);
  db.prepare('UPDATE cookie_profiles SET secret=?, cookie_count=?, expires_at=?, status=?, last_error=NULL, updated_at=? WHERE id=?')
    .run(encryptSecret(content), cookies.length, expiresAt, 'unknown', nowIso(), profileId);
  return { cookies: cookies.length, expiresAt };
}
