import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { nowIso, sha256Hex, uid } from './utils.js';

const windows = new Map();

export function createKey(name = 'API key') {
  const raw = `sk-${crypto.randomBytes(24).toString('base64url')}`;
  const id = uid('key');
  const at = nowIso();
  db.prepare('INSERT INTO api_keys(id,name,key_hash,prefix,created_at) VALUES(?,?,?,?,?)')
    .run(id, String(name || 'API key').slice(0, 100), sha256Hex(raw), raw.slice(0, 10), at);
  return { id, name: String(name || 'API key').slice(0, 100), key: raw, prefix: raw.slice(0, 10), createdAt: at };
}

export function ensureBootstrapKey() {
  if (!config.bootstrapApiKey) return null;
  const hash = sha256Hex(config.bootstrapApiKey);
  const existing = db.prepare('SELECT id FROM api_keys WHERE key_hash=?').get(hash);
  if (existing) return { id: existing.id, created: false };
  const id = uid('key');
  db.prepare('INSERT INTO api_keys(id,name,key_hash,prefix,created_at) VALUES(?,?,?,?,?)')
    .run(id, 'Environment (API_KEY)', hash, String(config.bootstrapApiKey).slice(0, 10), nowIso());
  return { id, created: true };
}

export function listKeys() {
  return db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all().map(row => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  }));
}

export function revokeKey(id) {
  const row = db.prepare('SELECT id FROM api_keys WHERE id=?').get(id);
  if (!row) return { ok: false };
  db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=?').run(nowIso(), id);
  return { ok: true };
}

export function deleteKey(id) {
  db.prepare('DELETE FROM api_keys WHERE id=?').run(id);
  return { ok: true };
}

export function authenticate(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (config.bootstrapApiKey && crypto.timingSafeEqual(Buffer.from(sha256Hex(value)), Buffer.from(sha256Hex(config.bootstrapApiKey)))) {
    return { id: 'env', name: 'Environment key', env: true };
  }
  const hash = sha256Hex(value);
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL').get(hash);
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(nowIso(), row.id);
  return { id: row.id, name: row.name, env: false };
}

export function checkRateLimit(keyId, rpm = config.rateLimitRpm) {
  const now = Date.now();
  const windowStart = now - 60000;
  const timestamps = (windows.get(keyId || 'anonymous') || []).filter(time => time > windowStart);
  if (timestamps.length >= rpm) {
    windows.set(keyId || 'anonymous', timestamps);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((timestamps[0] + 60000 - now) / 1000)) };
  }
  timestamps.push(now);
  windows.set(keyId || 'anonymous', timestamps);
  return { ok: true };
}
