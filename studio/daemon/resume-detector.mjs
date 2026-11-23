/**
 * Interrupted-Task Resume Detector (Daemon-side, read-only SQLite + fileStamp cache).
 * Inspects the tail step of ~/.gemini/antigravity/conversations/<cascadeId>.db in <1ms
 * to determine whether the last turn was interrupted abnormally (app quit/restart/crash,
 * mid-tool abort, manual cancel, error, or unanswered prompt).
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
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

function getFileStamp(dbPath) {
  try {
    const st = statSync(dbPath);
    let walStamp = '';
    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) {
      const wst = statSync(walPath);
      walStamp = `:${wst.size}:${Math.trunc(wst.mtimeMs)}`;
    }
    return `${st.size}:${Math.trunc(st.mtimeMs)}${walStamp}`;
  } catch {
    return '';
  }
}

export function collectResumeState(payload) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  if (!cid || !SAFE_ID_RE.test(cid)) {
    return { ok: false, interrupted: false, error: 'invalid_cascade_id' };
  }

  const dbPath = path.join(CONV_DIR, `${cid}.db`);
  if (!existsSync(dbPath)) {
    return { ok: true, cascadeId: cid, interrupted: false, reason: 'no_db', lastIdx: -1 };
  }

  const stamp = getFileStamp(dbPath);
  const hit = cache.get(cid);
  if (hit && hit.stamp === stamp) {
    return hit.result;
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const last = db
      .prepare('SELECT idx, step_type, status, length(error_details) AS err_len FROM steps ORDER BY idx DESC LIMIT 1')
      .get();

    if (!last) {
      const emptyRes = { ok: true, cascadeId: cid, interrupted: false, reason: 'empty', lastIdx: -1 };
      cache.set(cid, { stamp, result: emptyRes });
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
    cache.set(cid, { stamp, result });
    return result;
  } catch (err) {
    return { ok: false, cascadeId: cid, interrupted: false, error: err?.message || 'read_failed' };
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}
