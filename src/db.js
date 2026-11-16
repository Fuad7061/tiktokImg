import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { nowIso } from './utils.js';

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS cookie_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'unknown',
    cookie_count INTEGER,
    expires_at TEXT,
    last_error TEXT,
    validated_at TEXT,
    main_account_id TEXT,
    main_account_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    cookie_profile_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    name TEXT,
    role TEXT,
    tier TEXT,
    credits REAL,
    weekly_grant REAL,
    remote_status INTEGER NOT NULL DEFAULT 1,
    available INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    cookie_expires_at TEXT,
    last_error TEXT,
    validated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (cookie_profile_id, account_id)
  );
  CREATE INDEX IF NOT EXISTS idx_accounts_profile ON accounts(cookie_profile_id);

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    api_key_id TEXT,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    ratio TEXT,
    size TEXT,
    requested INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    stage TEXT,
    error_code TEXT,
    error_message TEXT,
    cookie_profile_id TEXT,
    account_id TEXT,
    task_id TEXT,
    refs_json TEXT,
    result_json TEXT,
    request_json TEXT,
    idempotency_key TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS uploads (
    sha256 TEXT NOT NULL,
    cookie_profile_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    cdn_url TEXT NOT NULL,
    mime TEXT,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (sha256, cookie_profile_id, account_id)
  );
`);

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key=?');
const setSettingStmt = db.prepare(`
  INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
`);

export function getSetting(key, fallback = null) {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  setSettingStmt.run(key, value == null ? null : String(value), nowIso());
}

export function getSettings(keys) {
  const output = {};
  for (const key of keys) output[key] = getSetting(key);
  return output;
}

export function pruneHistory() {
  const days = Number(getSetting('retentionDays', config.retentionDays)) || config.retentionDays;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  db.prepare('DELETE FROM jobs WHERE created_at < ?').run(cutoff);
  db.prepare('DELETE FROM uploads WHERE created_at < ?').run(cutoff);
}

export function pruneUploadCache(maxRows = 200) {
  const row = db.prepare('SELECT COUNT(*) AS count FROM uploads').get();
  if (Number(row?.count || 0) <= maxRows) return;
  db.prepare(`DELETE FROM uploads WHERE rowid IN (
    SELECT rowid FROM uploads ORDER BY created_at ASC LIMIT ?
  )`).run(Number(row.count) - maxRows);
}
