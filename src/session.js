import crypto from 'node:crypto';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';
import { sessionSecret } from './vault.js';

const COOKIE = 'is_session';
const MAX_AGE = 7 * 86400;
const PASSWORD_KEY = 'adminPasswordHash';

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

export function authRequired() {
  return Boolean(config.adminPassword || getSetting(PASSWORD_KEY));
}

export function issueSession() {
  const payload = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + MAX_AGE * 1000 })).toString('base64url');
  const token = `${payload}.${sign(payload)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function clearSession() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseCookies(header) {
  const output = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    output[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return output;
}

export function verifySession(cookieHeader) {
  const token = parseCookies(cookieHeader)[COOKIE];
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

export function isAdmin(req) {
  if (!authRequired()) return true;
  return verifySession(req.headers.cookie || '');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyHash(stored, password) {
  const [scheme, saltB64, hashB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64url'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function checkPassword(value) {
  const given = String(value || '');
  const stored = getSetting(PASSWORD_KEY);
  if (stored && verifyHash(stored, given)) return true;
  const expected = String(config.adminPassword || '');
  const left = Buffer.from(crypto.createHash('sha256').update(given).digest());
  const right = Buffer.from(crypto.createHash('sha256').update(expected).digest());
  return Boolean(expected) && crypto.timingSafeEqual(left, right);
}

export function setAdminPassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw new Error('Password must be at least 8 characters.');
  if (value.length > 200) throw new Error('Password is too long.');
  setSetting(PASSWORD_KEY, hashPassword(value));
  return { ok: true };
}
