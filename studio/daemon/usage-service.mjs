/**
 * Cached daily & per-model Token Usage service for the unified daemon.
 * Reuses incremental mtime/WAL stamp scanning with zero extra processes.
 * Properly chains follow-up scans when `force: true` or a new `activeId` arrives mid-scan.
 */
import os from 'node:os';
import path from 'node:path';
import { createUsageHistory } from '../../vendor/agy-capsule/usage_history.mjs';
import { readConversationUsage } from './usage-reader.mjs';

const HOME = os.homedir();
const DEFAULT_CONVERSATION_DIRS = [
  path.join(HOME, '.gemini', 'antigravity', 'conversations'),
];

let sharedHistory = null;
let lastResult = null;
let lastScanTs = 0;
let inFlightPromise = null;
let inFlightActiveIds = new Set();
const MIN_RESCAN_MS = 4000;

function getHistory() {
  if (!sharedHistory) {
    sharedHistory = createUsageHistory({
      directories: DEFAULT_CONVERSATION_DIRS,
      readRequests: readConversationUsage,
    });
  }
  return sharedHistory;
}

async function runFreshScan(activeId) {
  const activeSet = new Set(activeId ? [activeId] : []);
  inFlightActiveIds = activeSet;
  const p = getHistory()
    .read({ activeId })
    .then((data) => {
      const res = {
        ok: true,
        generatedAt: Date.now(),
        days: data.days || [],
        undated: data.undated || { requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        unread: data.unread || 0,
      };
      lastResult = res;
      lastScanTs = Date.now();
      return res;
    })
    .finally(() => {
      if (inFlightPromise === p) {
        inFlightPromise = null;
        inFlightActiveIds = new Set();
      }
    });
  inFlightPromise = p;
  return p;
}

export async function collectUsageStatsAsync(payload = {}) {
  const force = Boolean(payload?.force);
  const activeId = typeof payload?.activeId === 'string' ? payload.activeId.trim() : '';
  const now = Date.now();

  if (!force && !inFlightPromise && lastResult && now - lastScanTs < MIN_RESCAN_MS) {
    return lastResult;
  }

  if (inFlightPromise) {
    const needsFollowUp = force || (activeId && !inFlightActiveIds.has(activeId));
    const current = await inFlightPromise;
    if (!needsFollowUp) return current;
    return runFreshScan(activeId);
  }

  return runFreshScan(activeId);
}
