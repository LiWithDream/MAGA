/**
 * Cached daily & per-model Token Usage service for the unified Anti-Claude daemon.
 * Reuses agy-capsule's incremental mtime/WAL stamp scanner with zero extra processes.
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

export async function collectUsageStatsAsync(payload = {}) {
  const force = Boolean(payload?.force);
  const now = Date.now();
  if (!force && lastResult && now - lastScanTs < MIN_RESCAN_MS) {
    return lastResult;
  }
  const activeId = typeof payload?.activeId === 'string' ? payload.activeId.trim() : '';
  const data = await getHistory().read({ activeId });
  lastResult = {
    ok: true,
    generatedAt: Date.now(),
    days: data.days || [],
    undated: data.undated || { requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    unread: data.unread || 0,
  };
  lastScanTs = Date.now();
  return lastResult;
}
