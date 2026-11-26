/**
 * Interrupted-Task Resume Detector (Daemon-side, read-only SQLite + fileStamp cache).
 * Inspects the tail steps, executor_metadata, and conversation_summaries.db of
 * ~/.gemini/antigravity/conversations/<cascadeId>.db in <1ms to accurately distinguish
 * genuine interruptions (abort, cancel, error, max-steps, mid-tool stop, unanswered)
 * from normal completion or intentional waits (subagents, timers, swarm_wait, user input).
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const CONV_DIR = path.join(homedir(), '.gemini', 'antigravity', 'conversations');
const SAFE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

// Step types & statuses verified against Antigravity 2.x SQLite/protobuf schema
const STEP_USER_INPUT = 14;
const STEP_PLANNER_RESPONSE = 15;
const STEP_ERROR_MESSAGE = 17;
const STEP_CHECKPOINT = 23;
const STEP_EPHEMERAL_MESSAGE = 90;
const STEP_SYSTEM_MESSAGE = 101;
const STEP_WAIT = 102;
const STEP_INVOKE_SUBAGENT = 127;
const STEP_TOOL_CALL = 132;
const STEP_ASK_QUESTION = 138;

const META_STEP_TYPES = new Set([STEP_SYSTEM_MESSAGE, STEP_EPHEMERAL_MESSAGE, STEP_CHECKPOINT]);
const TERMINAL_NON_INTERRUPTED_STEP_TYPES = new Set([2, 27, 82, STEP_WAIT, STEP_ASK_QUESTION]);
const WAIT_TOOL_NAMES = new Set(['swarm_wait', 'schedule', 'ask_question', 'exit_plan_mode', 'send_message_to_user']);

const STATUS_PENDING = 1;
const STATUS_RUNNING = 2;
const STATUS_DONE = 3;
const STATUS_INVALID = 4;
const STATUS_CLEARED = 5;
const STATUS_CANCELED = 6;
const STATUS_ERROR = 7;
const STATUS_GENERATING = 8;
const STATUS_WAITING = 9;
const STATUS_QUEUED = 11;
const STATUS_INTERRUPTED = 12;

const ACTIVE_STEP_STATUSES = new Set([STATUS_PENDING, STATUS_RUNNING, STATUS_GENERATING, STATUS_QUEUED]);
const ABNORMAL_STOP_REASONS = new Set([1, 3, 9, 11, 13, 14, 16, 17, 18, 19, 20]);

const EXEC_ERROR = 1;
const EXEC_USER_CANCELED = 2;
const EXEC_MAX_INVOCATIONS = 3;
const EXEC_NO_TOOL_CALL = 4;
const EXEC_MAX_FORCED_INVOCATIONS = 6;
const EXEC_TERMINAL_STEP_TYPE = 8;
const EXEC_TERMINAL_CUSTOM_HOOK = 9;
const EXEC_INJECTED_RESPONSE = 10;
const EXEC_MAX_TOKEN_BUDGET_EXCEEDED = 11;
const EXEC_MAX_LIMIT_REASONS = new Set([
  EXEC_MAX_INVOCATIONS,
  EXEC_MAX_FORCED_INVOCATIONS,
  EXEC_MAX_TOKEN_BUDGET_EXCEEDED,
]);

const cache = new Map(); // cacheKey -> { stamp, result }
const MAX_CACHE = 48;

function inspectDbFiles(dbPath) {
  const st = statSync(dbPath, { throwIfNoEntry: false });
  if (!st) return null;
  const walSt = statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
  const shmSt = statSync(`${dbPath}-shm`, { throwIfNoEntry: false });
  const hasActiveWal = Boolean((walSt && walSt.size > 0) || (shmSt && shmSt.size > 0));
  const walStamp = walSt ? `:${walSt.size}:${Math.trunc(walSt.mtimeMs)}` : '';
  const shmStamp = shmSt ? `:${shmSt.size}:${Math.trunc(shmSt.mtimeMs)}` : '';
  return {
    stamp: `${st.size}:${Math.trunc(st.mtimeMs)}${walStamp}${shmStamp}`,
    hasActiveWal,
  };
}

function withReadOnlyDb(dbPath, meta, fn) {
  const run = (useImmutable) => {
    let db = null;
    try {
      let location = dbPath;
      if (useImmutable) {
        location = pathToFileURL(dbPath);
        location.searchParams.set('immutable', '1');
      }
      db = new DatabaseSync(location, { readOnly: true, timeout: 150 });
      if (!useImmutable) db.exec('PRAGMA busy_timeout = 150');
      return fn(db);
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  };

  if (meta.hasActiveWal) return run(false);
  try {
    return run(true);
  } catch {
    return run(false);
  }
}

function parseProtoFields(buf) {
  const out = new Map();
  if (!buf) return out;
  const bytes = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  const len = bytes.length;
  let pos = 0;

  const readVarint = () => {
    let result = 0;
    let shift = 0;
    while (pos < len) {
      const b = bytes[pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 53) {
        while (pos < len && (bytes[pos++] & 0x80) !== 0) {}
        return result;
      }
    }
    return result;
  };

  while (pos < len) {
    const tag = readVarint();
    if (!tag) break;
    const fieldNo = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (wireType === 0) {
      let arr = out.get(fieldNo);
      if (!arr) {
        arr = [];
        out.set(fieldNo, arr);
      }
      arr.push(readVarint());
    } else if (wireType === 1) {
      if (pos + 8 > len) break;
      pos += 8;
    } else if (wireType === 2) {
      const subLen = readVarint();
      if (subLen < 0 || pos + subLen > len) break;
      let arr = out.get(fieldNo);
      if (!arr) {
        arr = [];
        out.set(fieldNo, arr);
      }
      arr.push(bytes.subarray(pos, pos + subLen));
      pos += subLen;
    } else if (wireType === 5) {
      if (pos + 4 > len) break;
      pos += 4;
    } else {
      break;
    }
  }
  return out;
}

function readUtf8(val) {
  if (!(val instanceof Uint8Array)) return '';
  return Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('utf8');
}

function extractToolName(metadataBuf) {
  if (!metadataBuf) return '';
  const meta = parseProtoFields(metadataBuf);
  const tcRaw = meta.get(4)?.[0];
  if (!(tcRaw instanceof Uint8Array)) return '';
  const tc = parseProtoFields(tcRaw);
  return readUtf8(tc.get(2)?.[0]).trim();
}

function extractPlannerMeta(stepPayloadBuf) {
  if (!stepPayloadBuf) return { stopReason: 0, toolCallCount: 0 };
  const top = parseProtoFields(stepPayloadBuf);
  const prRaw = top.get(20)?.[0];
  if (!(prRaw instanceof Uint8Array)) return { stopReason: 0, toolCallCount: 0 };
  const pr = parseProtoFields(prRaw);
  return {
    stopReason: Number(pr.get(12)?.[0] ?? 0),
    toolCallCount: (pr.get(7) || []).length,
  };
}

function extractExecMeta(dataBuf) {
  if (!dataBuf) return null;
  const f = parseProtoFields(dataBuf);
  if (!f.size) return null;
  return {
    terminationReason: Number(f.get(1)?.[0] ?? 0),
    lastStepIdx: f.has(3) ? Number(f.get(3)[0]) : -1,
  };
}

function extractSummaryTermReason(rawSummaryBuf) {
  if (!rawSummaryBuf) return 0;
  const f = parseProtoFields(rawSummaryBuf);
  return Number(f.get(28)?.[0] ?? 0);
}

function readSummaryState(cid, sumDbPath, sumMeta) {
  if (!sumMeta) return null;
  try {
    return withReadOnlyDb(sumDbPath, sumMeta, (db) => {
      const cols = new Set(db.prepare('PRAGMA table_info(conversation_summaries)').all().map((c) => c.name));
      if (!cols.has('conversation_id')) return null;

      const selectCols = [
        cols.has('status') ? 'status' : "'' AS status",
        cols.has('not_fully_idle') ? 'not_fully_idle' : '0 AS not_fully_idle',
        cols.has('killed') ? 'killed' : '0 AS killed',
        cols.has('step_count') ? 'step_count' : '0 AS step_count',
        cols.has('raw_summary') ? 'raw_summary' : 'NULL AS raw_summary',
      ].join(', ');

      const row = db
        .prepare(`SELECT ${selectCols} FROM conversation_summaries WHERE conversation_id = ?`)
        .get(cid);

      let runningChildren = 0;
      if (cols.has('parent_conversation_id')) {
        const childConds = [];
        if (cols.has('not_fully_idle')) childConds.push('not_fully_idle = 1');
        if (cols.has('status')) {
          childConds.push("status IN ('CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_BUSY', 'CASCADE_RUN_STATUS_CANCELING')");
        }
        if (childConds.length > 0) {
          const killedClause = cols.has('killed') ? 'killed = 0 AND ' : '';
          const childRow = db
            .prepare(
              `SELECT COUNT(*) AS cnt FROM conversation_summaries WHERE parent_conversation_id = ? AND ${killedClause}(${childConds.join(' OR ')})`
            )
            .get(cid);
          runningChildren = Number(childRow?.cnt || 0);
        }
      }

      if (!row && runningChildren === 0) return null;

      const killed = Boolean(Number(row?.killed || 0));
      const notFullyIdle = Boolean(Number(row?.not_fully_idle || 0));
      const statusStr = String(row?.status || '');
      const isRunningStatus = !killed && /RUNNING|BUSY|CANCELING/i.test(statusStr);
      const isBackgroundWaiting = !killed && (notFullyIdle || runningChildren > 0);
      const stepCount = Number(row?.step_count || 0);
      const summaryTermReason = extractSummaryTermReason(row?.raw_summary);

      return {
        killed,
        notFullyIdle,
        statusStr,
        isRunningStatus,
        isBackgroundWaiting,
        runningChildren,
        stepCount,
        summaryTermReason,
      };
    });
  } catch {
    return null;
  }
}

function setBoundedCache(key, value) {
  if (cache.size >= MAX_CACHE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, value);
}

export function collectResumeState(payload, { conversationsDir = CONV_DIR } = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  if (!cid || !SAFE_ID_RE.test(cid)) {
    return { ok: false, interrupted: false, error: 'invalid_cascade_id' };
  }

  const liveIdle = payload?.liveIdle === true;
  const dbPath = path.join(conversationsDir, `${cid}.db`);
  const meta = inspectDbFiles(dbPath);
  if (!meta) {
    return { ok: true, cascadeId: cid, interrupted: false, reason: 'no_db', lastIdx: -1 };
  }

  const sumDbPath = path.join(path.dirname(conversationsDir), 'conversation_summaries.db');
  const sumMeta = inspectDbFiles(sumDbPath);
  const stamp = `${meta.stamp}|${sumMeta ? sumMeta.stamp : 'nosum'}`;
  const cacheKey = `${conversationsDir}:${cid}:${liveIdle ? '1' : '0'}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.stamp === stamp) {
    return hit.result;
  }

  try {
    const dbData = withReadOnlyDb(dbPath, meta, (db) => {
      const stepCols = new Set(db.prepare('PRAGMA table_info(steps)').all().map((c) => c.name));
      const selectCols = [
        'idx',
        'step_type',
        'status',
        stepCols.has('error_details') ? 'length(error_details) AS err_len' : '0 AS err_len',
        stepCols.has('metadata') ? 'metadata' : 'NULL AS metadata',
        stepCols.has('step_payload') ? 'step_payload' : 'NULL AS step_payload',
      ].join(', ');

      const rows = db.prepare(`SELECT ${selectCols} FROM steps ORDER BY idx DESC LIMIT 24`).all();
      if (!rows.length) return { empty: true };

      let execMeta = null;
      try {
        const hasExecTable = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'executor_metadata' LIMIT 1")
          .get();
        if (hasExecTable) {
          const execCols = new Set(db.prepare('PRAGMA table_info(executor_metadata)').all().map((c) => c.name));
          if (execCols.has('data')) {
            const orderCol = execCols.has('idx') ? 'idx' : 'rowid';
            const execRow = db
              .prepare(`SELECT data FROM executor_metadata ORDER BY ${orderCol} DESC LIMIT 1`)
              .get();
            if (execRow?.data) execMeta = extractExecMeta(execRow.data);
          }
        }
      } catch {}

      return { empty: false, rows, execMeta };
    });

    if (dbData.empty) {
      const emptyRes = { ok: true, cascadeId: cid, interrupted: false, reason: 'empty', lastIdx: -1 };
      setBoundedCache(cacheKey, { stamp, result: emptyRes });
      return emptyRes;
    }

    const { rows, execMeta } = dbData;
    const summary = readSummaryState(cid, sumDbPath, sumMeta);
    const lastIdx = Number(rows[0].idx ?? -1);
    const headStepType = Number(rows[0].step_type ?? 0);
    const headStatus = Number(rows[0].status ?? 0);

    // A. Effective Tail Step: skip trailing system/ephemeral/checkpoint metadata markers
    let effectiveRow = rows[0];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const t = Number(r.step_type ?? 0);
      const s = Number(r.status ?? 0);
      const err = Number(r.err_len || 0) > 0;
      if (META_STEP_TYPES.has(t) && s === STATUS_DONE && !err) {
        continue;
      }
      effectiveRow = r;
      break;
    }

    const effectiveIdx = Number(effectiveRow.idx ?? lastIdx);
    const stepType = Number(effectiveRow.step_type ?? 0);
    const status = Number(effectiveRow.status ?? 0);
    const hasErr = Number(effectiveRow.err_len || 0) > 0;

    const execCoversTail = Boolean(execMeta && execMeta.lastStepIdx >= effectiveIdx);
    const execTr = execCoversTail ? execMeta.terminationReason : 0;
    const hasExecFailure =
      execTr === EXEC_USER_CANCELED || execTr === EXEC_ERROR || EXEC_MAX_LIMIT_REASONS.has(execTr);
    const hasStepFailure =
      status === STATUS_CANCELED ||
      status === STATUS_INTERRUPTED ||
      status === STATUS_ERROR ||
      status === STATUS_INVALID ||
      stepType === STEP_ERROR_MESSAGE ||
      hasErr;
    const hasExplicitFailure = hasExecFailure || hasStepFailure;

    // B. Active / Background Guard from conversation_summaries.db (unless live UI already proved idle or explicit failure exists)
    if (!liveIdle && summary && !hasExplicitFailure) {
      if (summary.isRunningStatus) {
        const res = {
          ok: true,
          cascadeId: cid,
          interrupted: false,
          active: true,
          reason: 'running',
          lastIdx,
          stepType: headStepType,
          status: headStatus,
        };
        setBoundedCache(cacheKey, { stamp, result: res });
        return res;
      }
      if (summary.isBackgroundWaiting) {
        const res = {
          ok: true,
          cascadeId: cid,
          interrupted: false,
          waiting: true,
          reason: 'waiting_background',
          lastIdx,
          stepType: headStepType,
          status: headStatus,
        };
        setBoundedCache(cacheKey, { stamp, result: res });
        return res;
      }
    }

    // C. Authoritative abnormal executor_metadata takes precedence even over STATUS_WAITING
    if (hasExecFailure) {
      const execReason =
        execTr === EXEC_USER_CANCELED ? 'canceled' : execTr === EXEC_ERROR ? 'error' : 'max_steps';
      const res = {
        ok: true,
        cascadeId: cid,
        interrupted: true,
        reason: execReason,
        lastIdx,
        stepType,
        status,
      };
      setBoundedCache(cacheKey, { stamp, result: res });
      return res;
    }

    // D. User-Wait Status
    if (status === STATUS_WAITING) {
      const res = {
        ok: true,
        cascadeId: cid,
        interrupted: false,
        waiting: true,
        reason: 'waiting_user',
        lastIdx,
        stepType,
        status,
      };
      setBoundedCache(cacheKey, { stamp, result: res });
      return res;
    }

    let interrupted = false;
    let reason = 'done';
    let decidedByExec = false;

    // E. Remaining authoritative executor_metadata (terminal hooks / step types / injected response)
    if (
      execCoversTail &&
      (execTr === EXEC_TERMINAL_CUSTOM_HOOK ||
        execTr === EXEC_TERMINAL_STEP_TYPE ||
        execTr === EXEC_INJECTED_RESPONSE)
    ) {
      if (!hasStepFailure && !ACTIVE_STEP_STATUSES.has(status) && stepType !== STEP_USER_INPUT) {
        interrupted = false;
        reason = execTr === EXEC_TERMINAL_CUSTOM_HOOK ? 'waiting_swarm' : 'done';
        decidedByExec = true;
      }
    }

    // F. Step-Level Analysis
    if (!decidedByExec) {
      if (ACTIVE_STEP_STATUSES.has(status)) {
        interrupted = true;
        reason = 'aborted';
      } else if (status === STATUS_CANCELED) {
        interrupted = true;
        reason = 'canceled';
      } else if (status === STATUS_INTERRUPTED) {
        interrupted = true;
        reason = 'interrupted';
      } else if (
        stepType === STEP_ERROR_MESSAGE ||
        status === STATUS_INVALID ||
        status === STATUS_ERROR ||
        hasErr
      ) {
        interrupted = true;
        reason = 'error';
      } else if (stepType === STEP_USER_INPUT) {
        interrupted = true;
        reason = 'unanswered';
      } else if (stepType === STEP_PLANNER_RESPONSE && status === STATUS_DONE) {
        const plannerMeta = extractPlannerMeta(effectiveRow.step_payload);
        if (plannerMeta.stopReason === 16) {
          interrupted = true;
          reason = 'canceled';
        } else if (ABNORMAL_STOP_REASONS.has(plannerMeta.stopReason)) {
          interrupted = true;
          reason =
            plannerMeta.stopReason === 1 || plannerMeta.stopReason === 3 || plannerMeta.stopReason === 9
              ? 'aborted'
              : 'error';
        } else if (plannerMeta.toolCallCount > 0) {
          interrupted = true;
          reason = 'aborted';
        } else {
          interrupted = false;
          reason = 'done';
        }
      } else if (TERMINAL_NON_INTERRUPTED_STEP_TYPES.has(stepType)) {
        interrupted = false;
        reason = 'done';
      } else if (status === STATUS_DONE && !META_STEP_TYPES.has(stepType)) {
        const toolName = extractToolName(effectiveRow.metadata);
        if (WAIT_TOOL_NAMES.has(toolName)) {
          interrupted = false;
          reason =
            toolName === 'schedule'
              ? 'waiting_timer'
              : toolName === 'swarm_wait'
                ? 'waiting_swarm'
                : 'waiting_user';
        } else {
          interrupted = true;
          reason = 'mid_tool';
        }
      }

      // G. Summary raw_summary fallback when executor_metadata is absent
      if (!interrupted && !execMeta && summary && summary.stepCount === lastIdx + 1) {
        if (summary.summaryTermReason === EXEC_USER_CANCELED) {
          interrupted = true;
          reason = 'canceled';
        } else if (summary.summaryTermReason === EXEC_ERROR) {
          interrupted = true;
          reason = 'error';
        } else if (EXEC_MAX_LIMIT_REASONS.has(summary.summaryTermReason)) {
          interrupted = true;
          reason = 'max_steps';
        }
      }
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

    setBoundedCache(cacheKey, { stamp, result });
    return result;
  } catch (err) {
    return { ok: false, cascadeId: cid, interrupted: false, error: err?.message || 'read_failed' };
  }
}
