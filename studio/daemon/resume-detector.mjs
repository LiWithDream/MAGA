/**
 * Interrupted-Task Resume Detector (Daemon-side, read-only SQLite + fileStamp cache).
 * Inspects the tail step of ~/.gemini/antigravity/conversations/<cascadeId>.db in <1ms
 * to determine whether the last turn was interrupted abnormally (app quit/restart/crash,
 * mid-tool abort, manual cancel, error, or unanswered prompt).
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const CONV_DIR = path.join(homedir(), '.gemini', 'antigravity', 'conversations');
const SAFE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

// Step types & statuses verified against Antigravity 2.34 SQLite schema
const STEP_USER_INPUT = 14;
const STEP_PLANNER_RESPONSE = 15;
const STEP_TOOL_CALL = 132;

const STATUS_RUNNING = 2;
const STATUS_DONE = 3;
const STATUS_ERROR_A = 4;
const STATUS_CANCELED = 6;
const STATUS_ERROR_B = 7;

const cache = new Map(); // cascadeId -> { stamp, result }
const MAX_CACHE = 48;

function inspectDbFiles(dbPath) {
  const st = statSync(dbPath, { throwIfNoEntry: false });
  if (!st) return null;
  const walSt = statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
  const hasActiveWal = Boolean(walSt && walSt.size > 0);
  const walStamp = walSt ? `:${walSt.size}:${Math.trunc(walSt.mtimeMs)}` : '';
  return {
    stamp: `${st.size}:${Math.trunc(st.mtimeMs)}${walStamp}`,
    hasActiveWal,
  };
}

export function collectResumeState(payload, { conversationsDir = CONV_DIR } = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  if (!cid || !SAFE_ID_RE.test(cid)) {
    return { ok: false, interrupted: false, error: 'invalid_cascade_id' };
  }

  const dbPath = path.join(conversationsDir, `${cid}.db`);
  const meta = inspectDbFiles(dbPath);
  if (!meta) {
    return { ok: true, cascadeId: cid, interrupted: false, reason: 'no_db', lastIdx: -1 };
  }

  const { stamp, hasActiveWal } = meta;
  const cacheKey = `${conversationsDir}:${cid}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.stamp === stamp) {
    return hit.result;
  }

  let db = null;
  try {
    let location = dbPath;
    if (!hasActiveWal) {
      location = pathToFileURL(dbPath);
      location.searchParams.set('immutable', '1');
    }
    db = new DatabaseSync(location, { readOnly: true, timeout: 150 });
    if (hasActiveWal) db.exec('PRAGMA busy_timeout = 150');
    const last = db
      .prepare('SELECT idx, step_type, status, length(error_details) AS err_len FROM steps ORDER BY idx DESC LIMIT 1')
      .get();

    if (!last) {
      const emptyRes = { ok: true, cascadeId: cid, interrupted: false, reason: 'empty', lastIdx: -1 };
      cache.set(cacheKey, { stamp, result: emptyRes });
      return emptyRes;
    }

    const lastIdx = Number(last.idx ?? -1);
    const stepType = Number(last.step_type ?? 0);
    const status = Number(last.status ?? 0);
    const hasErr = Number(last.err_len || 0) > 0;

    let interrupted = false;
    let reason = 'done';

    if (status === STATUS_RUNNING) {
      interrupted = true;
      reason = 'aborted';
    } else if (status === STATUS_CANCELED) {
      interrupted = true;
      reason = 'canceled';
    } else if (status === STATUS_ERROR_A || status === STATUS_ERROR_B || hasErr) {
      interrupted = true;
      reason = 'error';
    } else if (stepType === STEP_USER_INPUT) {
      interrupted = true;
      reason = 'unanswered';
    } else if (stepType === STEP_TOOL_CALL && status === STATUS_DONE) {
      interrupted = true;
      reason = 'mid_tool';
    } else if (stepType === STEP_PLANNER_RESPONSE && status === STATUS_DONE) {
      interrupted = false;
      reason = 'done';
    }

    const result = {
      ok: true,
      cascadeId: cid,
      interrupted,
      reason,
      lastIdx,
      stepType,
      status,
    };

    if (cache.size >= MAX_CACHE) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }
    cache.set(cacheKey, { stamp, result });
    return result;
  } catch (err) {
    return { ok: false, cascadeId: cid, interrupted: false, error: err?.message || 'read_failed' };
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}
