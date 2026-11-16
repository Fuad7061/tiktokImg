import { config } from './config.js';
import { getSetting } from './db.js';
import { listProfiles, syncAllProfiles } from './accounts.js';

const state = {
  running: false,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  runs: 0
};

function intervalMinutes() {
  const stored = getSetting('autoSyncMinutes');
  const value = stored === null || stored === undefined ? config.autoSyncMinutes : Number(stored);
  return Number.isFinite(value) ? Math.max(0, Math.min(1440, value)) : config.autoSyncMinutes;
}

export function automationState() {
  return {
    enabled: intervalMinutes() > 0,
    intervalMinutes: intervalMinutes(),
    running: state.running,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    runs: state.runs,
    results: state.lastResult
  };
}

export async function runAutomationNow({ withCredits = true } = {}) {
  if (state.running) return { skipped: true, reason: 'already running' };
  if (!listProfiles().length) {
    state.lastRunAt = new Date().toISOString();
    state.lastResult = [];
    return { ok: true, results: [] };
  }
  state.running = true;
  try {
    const results = await syncAllProfiles({ withCredits });
    state.lastRunAt = new Date().toISOString();
    state.lastResult = results;
    state.lastError = results.find(item => item.error)?.error || null;
    state.runs += 1;
    const failed = results.filter(item => item.error).length;
    console.log(`[automation] synced ${results.length - failed}/${results.length} profile(s)${failed ? `, ${failed} failed` : ''}`);
    return { ok: true, results };
  } catch (error) {
    state.lastError = error.message;
    console.error(`[automation] sync failed: ${error.message}`);
    return { ok: false, error: error.message };
  } finally {
    state.running = false;
  }
}

let timer = null;
let lastTick = 0;

function tick() {
  const minutes = intervalMinutes();
  if (minutes <= 0 || state.running) return;
  const due = !state.lastRunAt || Date.now() - Date.parse(state.lastRunAt) >= minutes * 60000;
  if (due && Date.now() - lastTick > 30000) {
    lastTick = Date.now();
    runAutomationNow();
  }
}

export function startAutomation() {
  if (timer) return;
  timer = setInterval(tick, 60000);
  timer.unref?.();
  setTimeout(() => runAutomationNow(), 3000).unref?.();
}
