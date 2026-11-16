import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';

let cachedKey = null;

function masterKey() {
  if (cachedKey) return cachedKey;
  if (fs.existsSync(config.masterKeyPath)) {
    const key = fs.readFileSync(config.masterKeyPath);
    if (key.length !== 32) throw new Error('Invalid master key file.');
    cachedKey = key;
    return cachedKey;
  }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(config.masterKeyPath, key, { mode: 0o600, flag: 'wx' });
  } catch {
    cachedKey = fs.readFileSync(config.masterKeyPath);
    return cachedKey;
  }
  cachedKey = key;
  return cachedKey;
}

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptSecret(payload) {
  const buffer = Buffer.from(String(payload || ''), 'base64');
  if (buffer.length < 30 || buffer[0] !== 1) throw new Error('Invalid encrypted secret.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), buffer.subarray(1, 13));
  decipher.setAuthTag(buffer.subarray(13, 29));
  return Buffer.concat([decipher.update(buffer.subarray(29)), decipher.final()]).toString('utf8');
}

export function sessionSecret() {
  if (config.sessionSecret) return config.sessionSecret;
  try {
    return fs.readFileSync(config.sessionKeyPath, 'utf8');
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(config.sessionKeyPath, secret, { mode: 0o600 });
    return secret;
  }
}
