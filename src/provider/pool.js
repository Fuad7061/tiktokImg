import { config } from '../config.js';
import { getSetting } from '../db.js';
import { eligibleAccounts } from '../accounts.js';
import { httpError, sleep } from '../utils.js';

const active = new Map();
const waiters = [];

export function accountKey(account) {
  return `${account.profileId}:${account.accountId}`;
}

export function concurrencyLimit() {
  const configured = Number(getSetting('accountConcurrency', config.accountConcurrency));
  return Number.isFinite(configured) ? Math.max(1, Math.min(5, configured)) : config.accountConcurrency;
}

function wake() {
  for (const resolve of waiters.splice(0)) resolve();
}

export async function acquireAccount(excluded = new Set(), { timeoutMs = 120000 } = {}) {
  const started = Date.now();
  while (true) {
    const candidates = eligibleAccounts().filter(account => !excluded.has(accountKey(account)));
    if (!candidates.length) {
      throw httpError(503, 'No usable accounts. Import a cookie file or re-validate an existing account.', 'no_accounts');
    }
    const limit = concurrencyLimit();
    const free = candidates.find(account => (active.get(accountKey(account)) || 0) < limit);
    if (free) {
      const key = accountKey(free);
      active.set(key, (active.get(key) || 0) + 1);
      return free;
    }
    if (Date.now() - started > timeoutMs) {
      throw httpError(503, 'All accounts are busy. Please retry shortly.', 'accounts_busy', '');
    }
    await Promise.race([
      new Promise(resolve => waiters.push(resolve)),
      sleep(750)
    ]);
  }
}

export function releaseAccount(account) {
  const key = accountKey(account);
  const count = (active.get(key) || 1) - 1;
  if (count <= 0) active.delete(key);
  else active.set(key, count);
  wake();
}

export async function withAccount(excluded, action, options) {
  const account = await acquireAccount(excluded, options);
  try {
    return await action(account);
  } finally {
    releaseAccount(account);
  }
}

export function poolSnapshot() {
  return Object.fromEntries(active.entries());
}
