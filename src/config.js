import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

function loadDotEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index < 1) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* .env is optional */
  }
}

loadDotEnv(path.join(ROOT, '.env'));

const number = (name, fallback, min, max) => {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
};

const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(dataDir, { recursive: true });

export const config = Object.freeze({
  root: ROOT,
  dataDir,
  dbPath: path.join(dataDir, 'studio.db'),
  masterKeyPath: path.join(dataDir, 'master.key'),
  sessionKeyPath: path.join(dataDir, 'session.key'),
  port: number('PORT', 4175, 1, 65535),
  host: process.env.HOST || '0.0.0.0',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  bootstrapApiKey: process.env.API_KEY || '',
  cookieFile: process.env.COOKIE_FILE || '',
  cookieName: process.env.COOKIE_PROFILE_NAME || 'Main account',
  autoSyncMinutes: number('AUTO_SYNC_MINUTES', 15, 0, 1440),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  defaultModel: process.env.DEFAULT_MODEL || 'nano-banana-pro',
  accountConcurrency: number('ACCOUNT_CONCURRENCY', 1, 1, 5),
  maxAttempts: number('MAX_ATTEMPTS', 3, 1, 5),
  jobTimeoutMs: number('JOB_TIMEOUT_MS', 300000, 30000, 900000),
  retentionDays: number('RETENTION_DAYS', 30, 1, 365),
  rateLimitRpm: number('RATE_LIMIT_RPM', 60, 1, 10000),
  logLevel: process.env.LOG_LEVEL || 'info'
});
