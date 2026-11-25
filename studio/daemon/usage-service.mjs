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

const EMPTY_UNDATED = () => ({ requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

function normalizeIdList(rawList, limit = 500) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

async function ensureBaseUsage({ force, activeId }) {
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

export async function collectUsageStatsAsync(payload = {}) {
  const force = Boolean(payload?.force);
  const activeId = typeof payload?.activeId === 'string' ? payload.activeId.trim() : '';

  if (payload?.projectGroups && typeof payload.projectGroups === 'object' && !Array.isArray(payload.projectGroups)) {
    const sanitized = {};
    const emptyByProject = {};
    let hasAnyId = false;
    let count = 0;
    for (const [rawPid, rawIds] of Object.entries(payload.projectGroups)) {
      if (count >= 120) break;
      const pid = String(rawPid || '').trim();
      if (!pid) continue;
      count += 1;
      const ids = normalizeIdList(rawIds, 500);
      sanitized[pid] = ids;
      emptyByProject[pid] = { totalTokens: 0, requests: 0 };
      if (ids.length > 0) hasAnyId = true;
    }
    if (!hasAnyId) {
      return {
        ok: true,
        generatedAt: Date.now(),
        globalTotalTokens: 0,
        byProject: emptyByProject,
      };
    }
    const base = await ensureBaseUsage({ force, activeId });
    const grouped = getHistory().summarizeGroups(sanitized);
    return {
      ok: true,
      generatedAt: base.generatedAt || Date.now(),
      ...grouped,
    };
  }

  if (Array.isArray(payload?.conversationIds)) {
    const ids = normalizeIdList(payload.conversationIds, 500);
    if (ids.length === 0) {
      return {
        ok: true,
        generatedAt: Date.now(),
        days: [],
        undated: EMPTY_UNDATED(),
        unread: 0,
        conversationCount: 0,
        globalTotalTokens: 0,
        byChat: {},
      };
    }
    const base = await ensureBaseUsage({ force, activeId });
    const filtered = getHistory().summarizeForIds(ids);
    return {
      ok: true,
      generatedAt: base.generatedAt || Date.now(),
      ...filtered,
      unread: base.unread || 0,
      conversationCount: ids.length,
    };
  }

  return ensureBaseUsage({ force, activeId });
}
