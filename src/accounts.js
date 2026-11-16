import { db } from './db.js';
import { cookieExpiry, cookieHeaderFromText, csrfFromCookieHeader, parseCookieText, profileCookieHeader, profileSecret, saveProfileContent } from './cookies.js';
import { encryptSecret } from './vault.js';
import { httpRequest } from './http.js';
import { httpError, nowIso, sleep, uid } from './utils.js';

const BASE = 'https://ads.tiktok.com';
const QUERY = 'aid=585599&app_name=creative_aio_client&device_platform=web';

function headersFor(cookieHeader, referer = `${BASE}/creative/creativestudio/create`) {
  const csrf = csrfFromCookieHeader(cookieHeader);
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json; charset=utf-8',
    'agw-js-conv': 'str',
    'x-creative-source': 'creative_studio',
    referer,
    cookie: cookieHeader,
    ...(csrf ? { 'x-csrftoken': csrf } : {})
  };
}

function platformError(message, code, statusCode = 502) {
  return httpError(statusCode, message, code);
}

function parseSetCookieHeader(header) {
  const parts = String(header).split(';');
  const first = parts[0];
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name || !value) return null;
  const cookie = { name, value, domain: '.tiktok.com', path: '/', expires: -1, secure: false, httpOnly: false, hostOnly: false };
  for (const attr of parts.slice(1)) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'domain' && val) cookie.domain = val;
    else if (key === 'path' && val) cookie.path = val;
    else if (key === 'expires' && val) {
      const t = Date.parse(val);
      if (Number.isFinite(t)) cookie.expires = Math.floor(t / 1000);
    } else if (key === 'max-age' && val) {
      const s = Number(val);
      if (Number.isFinite(s)) cookie.expires = Math.floor(Date.now() / 1000) + s;
    } else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
  }
  return cookie;
}

function absorbSetCookie(profileId, setCookie) {
  if (!profileId || !setCookie) return false;
  try {
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    const incoming = list
      .map(parseSetCookieHeader)
      .filter(c => c && c.value && /tiktok\.com$/i.test(String(c.domain || '')));
    if (!incoming.length) return false;
    const { content } = profileSecret(profileId);
    const cookies = parseCookieText(content);
    if (!cookies.length) return false;
    let changed = false;
    for (const c of incoming) {
      const idx = cookies.findIndex(x =>
        x.name === c.name &&
        String(x.domain || '').toLowerCase() === String(c.domain || '').toLowerCase() &&
        String(x.path || '/') === String(c.path || '/')
      );
      if (idx >= 0) {
        const prev = cookies[idx];
        if (prev.value !== c.value || Number(prev.expires || -1) !== c.expires) {
          cookies[idx] = {
            ...prev,
            value: c.value,
            expires: c.expires,
            secure: Boolean(c.secure || prev.secure),
            httpOnly: Boolean(c.httpOnly || prev.httpOnly)
          };
          changed = true;
        }
      } else {
        cookies.push(c);
        changed = true;
      }
    }
    if (!changed) return false;
    const serialized = JSON.stringify(cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      hostOnly: Boolean(c.hostOnly),
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      expires: Number.isFinite(Number(c.expires)) ? Number(c.expires) : -1
    })));
    db.prepare('UPDATE cookie_profiles SET secret=?, cookie_count=?, expires_at=?, updated_at=? WHERE id=?')
      .run(encryptSecret(serialized), cookies.length, cookieExpiry(cookies), nowIso(), profileId);
    return true;
  } catch {
    return false;
  }
}

async function apiGet(profileId, path, { accountId = '', extra = '', timeoutMs = 30000, retried = false } = {}) {
  const url = `${BASE}${path}?${QUERY}${extra}`;
  const { cookieHeader } = profileCookieHeader(profileId, accountId, url);
  let response;
  try {
    response = await httpRequest(url, { headers: headersFor(cookieHeader), timeoutMs, retries: 1 });
  } catch (error) {
    throw platformError(`Network error while contacting TikTok: ${error.message}`, 'network_error');
  }
  const refreshed = absorbSetCookie(profileId, response.headers?.['set-cookie']);
  const value = response.json;
  const business = value?.BaseResp?.StatusCode ?? value?.code;
  if (response.status === 401 || /login required/i.test(String(value?.message || value?.BaseResp?.StatusMessage || ''))) {
    if (refreshed && !retried) {
      return apiGet(profileId, path, { accountId, extra, timeoutMs, retried: true });
    }
    throw platformError('Session expired. Re-import the cookie file.', 'session_expired', 401);
  }
  if (response.status === 429) throw platformError('TikTok rate limit reached. Try again shortly.', 'rate_limited', 429);
  if (response.status !== 200 || (business !== 0 && business !== undefined && business !== null)) {
    throw platformError(`TikTok request failed (HTTP ${response.status}, business ${business ?? 'unknown'}).`, 'platform_error');
  }
  return value;
}

export function fetchUserInfo(profileId) {
  return apiGet(profileId, '/CreativeOne/Client/ClientGetUserInfo', { extra: '&needPlain=false' });
}

export function fetchAccounts(profileId) {
  return apiGet(profileId, '/CreativeOne/Client/ClientGetAccountList');
}

export function fetchAccountInfo(profileId, accountId) {
  return apiGet(profileId, '/CreativeOne/Client/ClientGetAccountInfo', { accountId });
}

export async function fetchCredits(profileId, accountId) {
  const value = await apiGet(profileId, '/CreativeOne/SymphonyPlatform/QueryUserCreditAccount', { accountId });
  const credit = value?.user_credit_account;
  if (!credit) throw platformError('Unexpected credits response.', 'credits_invalid');
  const numeric = input => {
    const number = Number(input);
    return Number.isFinite(number) ? number : null;
  };
  return {
    accountId: String(credit.aio_id || ''),
    credits: numeric(credit.credits),
    weeklyGrant: numeric(credit.credit_grant),
    weeklySpent: numeric(credit.weekly_spent),
    tier: String(credit.user_segment_tier || ''),
    frozen: credit.frozen === true || credit.frozen === 1 || credit.frozen === '1' || credit.frozen === 'true'
  };
}

function normalizeId(value) {
  const id = String(value ?? '');
  if (!/^\d+$/.test(id)) throw platformError('TikTok returned an unexpected account id.', 'invalid_account_id');
  return id;
}

export function listProfiles() {
  return db.prepare('SELECT * FROM cookie_profiles ORDER BY created_at').all().map(publicProfile);
}

export function getProfile(id) {
  const row = db.prepare('SELECT * FROM cookie_profiles WHERE id=?').get(id);
  if (!row) throw httpError(404, 'Cookie profile not found.', 'profile_not_found');
  return publicProfile(row);
}

function publicProfile(row) {
  const expiry = row.expires_at || null;
  const daysLeft = expiry ? Math.ceil((Date.parse(expiry) - Date.now()) / 86400000) : null;
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    status: row.status,
    cookieCount: row.cookie_count,
    expiresAt: expiry,
    daysLeft,
    expired: Boolean(expiry && Date.parse(expiry) <= Date.now()),
    mainAccountId: row.main_account_id,
    mainAccountName: row.main_account_name,
    lastError: row.last_error,
    validatedAt: row.validated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listAccounts() {
  return db.prepare(`
    SELECT a.*, p.name AS profile_name, p.status AS profile_status, p.expires_at AS profile_expires_at
    FROM accounts a JOIN cookie_profiles p ON p.id = a.cookie_profile_id
    ORDER BY p.created_at, a.role = 'main' DESC, a.created_at
  `).all().map(row => {
    const expiresAt = row.cookie_expires_at || row.profile_expires_at || null;
    return {
      profileId: row.cookie_profile_id,
      profileName: row.profile_name,
      accountId: row.account_id,
      name: row.name,
      role: row.role,
      tier: row.tier,
      credits: row.credits,
      weeklyGrant: row.weekly_grant,
      remoteStatus: row.remote_status,
      available: Boolean(row.available),
      enabled: Boolean(row.enabled),
      expiresAt,
      daysLeft: expiresAt ? Math.ceil((Date.parse(expiresAt) - Date.now()) / 86400000) : null,
      expired: Boolean(expiresAt && Date.parse(expiresAt) <= Date.now()),
      profileStatus: row.profile_status,
      lastError: row.last_error,
      validatedAt: row.validated_at,
      createdAt: row.created_at
    };
  });
}

export async function importProfile({ name = '', content = '' } = {}) {
  const cookies = parseCookieText(content);
  if (!cookies.length) throw httpError(422, 'No valid cookies were found in the provided text.', 'invalid_cookies');
  const expiresAt = cookieExpiry(cookies);

  let identity = null;
  try {
    const response = await httpRequest(
      `${BASE}/CreativeOne/Client/ClientGetUserInfo?${QUERY}&needPlain=false`,
      { headers: headersFor(cookieHeaderFromText(content, `${BASE}/creative/creativestudio/create`)), timeoutMs: 25000, retries: 0 }
    );
    if (response.status === 200 && response.json?.BaseResp?.StatusCode === 0 && /^\d+$/.test(String(response.json?.userInfo?.tt4bUID || ''))) {
      identity = response.json.userInfo;
    }
  } catch {
    /* stored for explicit validation */
  }

  const existing = identity
    ? db.prepare('SELECT * FROM cookie_profiles WHERE main_account_id=?').get(identity.tt4bUID)
    : null;

  if (existing) {
    db.prepare('UPDATE cookie_profiles SET name=?, secret=?, cookie_count=?, expires_at=?, status=?, last_error=NULL, updated_at=? WHERE id=?')
      .run(String(name || existing.name).slice(0, 100), encryptSecret(content), cookies.length, expiresAt, 'unknown', nowIso(), existing.id);
    return getProfile(existing.id);
  }

  const id = uid('profile');
  const at = nowIso();
  db.prepare(`INSERT INTO cookie_profiles(id,name,secret,status,cookie_count,expires_at,created_at,updated_at,main_account_id,main_account_name)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    String(name || identity?.name || 'TikTok account').slice(0, 100),
    encryptSecret(content),
    'unknown',
    cookies.length,
    expiresAt,
    at,
    at,
    identity?.tt4bUID || null,
    identity?.name || null
  );
  return getProfile(id);
}

export async function syncProfile(profileId, { withCredits = true } = {}) {
  const profile = getProfile(profileId);
  const userResponse = await fetchUserInfo(profileId);
  const identity = userResponse?.userInfo;
  const mainId = normalizeId(identity?.tt4bUID);
  if (profile.mainAccountId && profile.mainAccountId !== mainId) {
    throw platformError('This cookie belongs to a different main account. Import it as a new profile.', 'account_mismatch', 409);
  }
  const response = await fetchAccounts(profileId);
  if (!Array.isArray(response?.accounts)) throw platformError('Unexpected account list response.', 'account_list_invalid');

  const seen = new Set();
  const rows = [];
  for (const account of response.accounts) {
    const id = normalizeId(account.aioClientID);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      name: String(account.profileName || 'Untitled account').slice(0, 160),
      role: String(account.role ?? ''),
      status: Number(account.status ?? 1)
    });
  }

  const { content } = profileSecret(profileId);
  const expiresAt = cookieExpiry(parseCookieText(content));
  const at = nowIso();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE accounts SET available=0, updated_at=? WHERE cookie_profile_id=?').run(at, profileId);
    const upsert = db.prepare(`INSERT INTO accounts(cookie_profile_id,account_id,name,role,remote_status,available,enabled,cookie_expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,1,1,?,?,?)
      ON CONFLICT(cookie_profile_id,account_id) DO UPDATE SET name=excluded.name, role=excluded.role,
        remote_status=excluded.remote_status, available=1, cookie_expires_at=excluded.cookie_expires_at, updated_at=excluded.updated_at`);
    for (const row of rows) upsert.run(profileId, row.id, row.name, row.role, row.status, expiresAt, at, at);
    if (mainId) {
      db.prepare('DELETE FROM accounts WHERE cookie_profile_id = ? AND role = ? AND account_id = ?').run(profileId, 'main', mainId);
    }
    db.prepare("UPDATE cookie_profiles SET name=?, status='valid', main_account_id=?, main_account_name=?, expires_at=?, last_error=NULL, validated_at=?, updated_at=? WHERE id=?")
      .run(String(profile.name || identity?.name || 'TikTok account').slice(0, 100), mainId, String(identity?.name || 'Main account').slice(0, 160), expiresAt, at, at, profileId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  let credits = [];
  if (withCredits) {
    credits = await refreshCredits(profileId).catch(() => []);
  }
  return { profile: getProfile(profileId), accounts: listAccounts().filter(item => item.profileId === profileId), credits };
}

export async function refreshCredits(profileId) {
  const accounts = db.prepare('SELECT account_id FROM accounts WHERE cookie_profile_id=? AND available=1 ORDER BY role = \'main\' DESC, created_at').all(profileId);
  const results = [];
  for (const account of accounts.slice(0, 20)) {
    try {
      const credit = await fetchCredits(profileId, account.account_id);
      if (credit.accountId && credit.accountId !== account.account_id) continue;
      db.prepare('UPDATE accounts SET credits=?, weekly_grant=?, tier=?, validated_at=?, updated_at=? WHERE cookie_profile_id=? AND account_id=?')
        .run(credit.credits, credit.weeklyGrant, credit.tier, nowIso(), nowIso(), profileId, account.account_id);
      results.push({ accountId: account.account_id, ...credit });
    } catch (error) {
      results.push({ accountId: account.account_id, error: error.message });
    }
    await sleep(120);
  }
  return results;
}

export async function verifyAccount(profileId, accountId) {
  const info = await fetchAccountInfo(profileId, accountId);
  const returned = String(info?.account?.aioClientID || '');
  if (returned !== accountId) throw platformError('The platform returned a different account id.', 'account_mismatch');
  db.prepare('UPDATE accounts SET last_error=NULL, validated_at=?, updated_at=? WHERE cookie_profile_id=? AND account_id=?')
    .run(nowIso(), nowIso(), profileId, accountId);
  return { ok: true, accountId };
}

export async function updateProfile(id, { name, enabled, content } = {}) {
  const row = db.prepare('SELECT * FROM cookie_profiles WHERE id=?').get(id);
  if (!row) throw httpError(404, 'Cookie profile not found.', 'profile_not_found');
  if (name !== undefined) {
    const value = String(name).trim();
    if (!value) throw httpError(422, 'Profile name cannot be empty.', 'invalid_name');
    db.prepare('UPDATE cookie_profiles SET name=?, updated_at=? WHERE id=?').run(value.slice(0, 100), nowIso(), id);
  }
  if (enabled !== undefined) {
    db.prepare('UPDATE cookie_profiles SET enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, nowIso(), id);
  }
  if (content !== undefined && content !== null && String(content).trim()) {
    const text = String(content);
    const cookies = parseCookieText(text);
    if (!cookies.length) throw httpError(422, 'No valid cookies were found in the provided text.', 'invalid_cookies');
    if (row.main_account_id) {
      let identity = null;
      try {
        const response = await httpRequest(
          `${BASE}/CreativeOne/Client/ClientGetUserInfo?${QUERY}&needPlain=false`,
          { headers: headersFor(cookieHeaderFromText(text, `${BASE}/creative/creativestudio/create`)), timeoutMs: 25000, retries: 0 }
        );
        if (response.status === 200 && response.json?.BaseResp?.StatusCode === 0 && /^\d+$/.test(String(response.json?.userInfo?.tt4bUID || ''))) {
          identity = response.json.userInfo;
        }
      } catch {
        /* invalid cookies surface during the sync below */
      }
      if (identity?.tt4bUID && String(identity.tt4bUID) !== String(row.main_account_id)) {
        throw httpError(409, 'This cookie belongs to a different main account. Import it as a new profile instead.', 'account_mismatch');
      }
    }
    saveProfileContent(id, text);
  }
  return getProfile(id);
}

export function updateAccount(profileId, accountId, { enabled } = {}) {
  const row = db.prepare('SELECT 1 FROM accounts WHERE cookie_profile_id=? AND account_id=?').get(profileId, accountId);
  if (!row) throw httpError(404, 'Account not found.', 'account_not_found');
  if (enabled !== undefined) {
    db.prepare('UPDATE accounts SET enabled=?, updated_at=? WHERE cookie_profile_id=? AND account_id=?')
      .run(enabled ? 1 : 0, nowIso(), profileId, accountId);
  }
  return listAccounts().find(item => item.profileId === profileId && item.accountId === accountId);
}

export function deleteProfile(id) {
  const row = db.prepare('SELECT * FROM cookie_profiles WHERE id=?').get(id);
  if (!row) throw httpError(404, 'Cookie profile not found.', 'profile_not_found');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM accounts WHERE cookie_profile_id=?').run(id);
    db.prepare('DELETE FROM uploads WHERE cookie_profile_id=?').run(id);
    db.prepare('DELETE FROM cookie_profiles WHERE id=?').run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true };
}

export function markSessionExpired(profileId, message) {
  db.prepare("UPDATE cookie_profiles SET status='invalid', last_error=?, updated_at=? WHERE id=?")
    .run(String(message || 'Cookie expired.').slice(0, 1000), nowIso(), profileId);
}

export function markError(profileId, accountId, message) {
  if (profileId) {
    db.prepare('UPDATE cookie_profiles SET last_error=?, updated_at=? WHERE id=?')
      .run(String(message || '').slice(0, 1000), nowIso(), profileId);
  }
  if (profileId && accountId) {
    db.prepare('UPDATE accounts SET last_error=?, updated_at=? WHERE cookie_profile_id=? AND account_id=?')
      .run(String(message || '').slice(0, 1000), nowIso(), profileId, accountId);
  }
}

export function markSuccess(profileId, accountId, images = 0) {
  const cost = Math.max(0, Math.trunc(Number(images) || 0)) * 4;
  db.prepare(`UPDATE accounts SET last_error=NULL, validated_at=?, updated_at=?,
    credits = CASE WHEN credits IS NULL THEN NULL ELSE MAX(credits - ?, 0) END
    WHERE cookie_profile_id=? AND account_id=?`)
    .run(nowIso(), nowIso(), cost, profileId, accountId);
}

export function eligibleAccounts() {
  const rows = db.prepare(`
    SELECT a.*, p.expires_at AS profile_expires_at
    FROM accounts a JOIN cookie_profiles p ON p.id = a.cookie_profile_id
    WHERE a.enabled=1 AND a.available=1 AND a.remote_status=1 AND p.enabled=1 AND p.status != 'invalid'
    ORDER BY (a.credits IS NULL), a.credits DESC, a.created_at
  `).all();
  const now = Date.now();
  return rows.filter(row => {
    const expiresAt = row.profile_expires_at || row.cookie_expires_at;
    return !expiresAt || Date.parse(expiresAt) > now;
  }).map(row => ({
    profileId: row.cookie_profile_id,
    accountId: row.account_id,
    name: row.name,
    role: row.role,
    credits: row.credits,
    tier: row.tier,
    expiresAt: row.profile_expires_at || row.cookie_expires_at || null
  }));
}

export function accountCounts() {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN a.enabled=1 AND a.available=1 AND a.remote_status=1 AND p.enabled=1 AND p.status != 'invalid' AND a.role != 'main' THEN 1 ELSE 0 END) AS usable
    FROM accounts a JOIN cookie_profiles p ON p.id=a.cookie_profile_id
  `).get();
  const profiles = db.prepare('SELECT COUNT(*) AS count FROM cookie_profiles').get();
  return { profiles: Number(profiles?.count || 0), accounts: Number(totals?.total || 0), usable: Number(totals?.usable || 0) };
}


const creditRefreshTimers = new Map();

export function scheduleCreditsRefresh(profileId, delayMs = 2500) {
  if (!profileId) return;
  const existing = creditRefreshTimers.get(profileId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    creditRefreshTimers.delete(profileId);
    refreshCredits(profileId).catch(error => markError(profileId, null, error.message));
  }, Math.max(250, Number(delayMs) || 2500));
  timer.unref?.();
  creditRefreshTimers.set(profileId, timer);
}

export async function syncAllProfiles({ withCredits = true } = {}) {
  const results = [];
  for (const profile of listProfiles()) {
    if (!profile.enabled) {
      results.push({ profileId: profile.id, skipped: true });
      continue;
    }
    try {
      const synced = await syncProfile(profile.id, { withCredits });
      results.push({ profileId: profile.id, ok: true, accounts: synced.accounts?.length || 0 });
    } catch (error) {
      if (error.code === 'session_expired') markSessionExpired(profile.id, error.message);
      else markError(profile.id, null, `Auto sync: ${error.message}`);
      results.push({ profileId: profile.id, error: error.message });
    }
  }
  return results;
}
