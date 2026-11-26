/**
 * Synchronous, zero-external-dep Antigravity `Stop` Hook & CLI for MAGA Auto-Compact.
 * - Inspects read-only SQLite `steps` (`step_type = 132` with running `status > 0 && status < 3`)
 *   for active `schedule` timers, `step_type = 23` checkpoints, `trajectory_metadata_blob`
 *   for child-conversation exclusion, and `gen_metadata` for ring-matched `ctxPct`.
 * - Never installs a `PreToolUse` hook (zero permission-merge interference / zero write races).
 * - Writes isolated per-conversation requests (`auto-compact-requests/<cid>.json`), respecting
 *   active 30s claim leases so concurrent UI consumption never encounters CAS loss.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let DatabaseSync = null;
try {
  const req = createRequire(import.meta.url);
  ({ DatabaseSync } = req('node:sqlite'));
} catch {}

const SAFE_CID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const REQUEST_TTL_MS = 5 * 60 * 1000;
const MODEL_REQUEST_TTL_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 120 * 1000;
const MAX_AUTO_PER_SESSION = 12;
const MAX_DIR_FILES = 32;
const MAX_CONV_STATE_FILES = 256;
const MAX_DIR_AGE_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 5000;
const SLEEP_BUF = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

function withRequestLock(reqFile, fn, { now = Date.now(), maxWaitMs = 200 } = {}) {
  if (!reqFile) return fn();
  const lockPath = `${reqFile}.lock`;
  fs.mkdirSync(path.dirname(reqFile), { recursive: true });
  let acquired = false;
  const deadline = Date.now() + maxWaitMs;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, `${process.pid}:${now}\n`);
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') break;
      try {
        const st = fs.statSync(lockPath, { throwIfNoEntry: false });
        if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) break;
      if (SLEEP_BUF) {
        try {
          Atomics.wait(SLEEP_BUF, 0, 0, 8);
        } catch {}
      }
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {}
    }
  }
}

export const DEFAULT_PREFS = {
  autoCompactMode: 'semi',
  autoCompactThresholdPct: 50,
  autoCompactMinWaitSec: 300,
  autoCompactHighWaterPct: 0,
  autoCompactTriggers: { longTimer: true, modelRequest: true, highWater: false },
};

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeAtomicJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    if (process.platform === 'win32') {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          fs.renameSync(tmp, filePath);
          break;
        } catch (err) {
          const code = err?.code;
          if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt === 5) throw err;
          if (SLEEP_BUF) {
            try {
              Atomics.wait(SLEEP_BUF, 0, 0, 20);
            } catch {}
          }
        }
      }
    } else {
      fs.renameSync(tmp, filePath);
    }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitizeHighWaterPct(val, fallback) {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded <= 0) return 0;
  return Math.max(65, Math.min(95, rounded));
}

function sha1Short(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

function sanitizeInlineText(str, maxLen = 200) {
  return String(str || '')
    .replace(/`/g, "'")
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

function pruneDirFiles(dir, { maxFiles = MAX_DIR_FILES, maxAgeMs = MAX_DIR_AGE_MS, pruneNow = Date.now() } = {}) {
  try {
    if (!dir || !fs.existsSync(dir)) return;
    const alive = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      const full = path.join(dir, ent.name);
      try {
        const st = fs.statSync(full);
        if (pruneNow - st.mtimeMs > maxAgeMs) {
          fs.rmSync(full, { force: true });
        } else {
          alive.push({ full, mtimeMs: st.mtimeMs });
        }
      } catch {}
    }
    if (alive.length > maxFiles) {
      alive.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const item of alive.slice(0, alive.length - maxFiles)) {
        try {
          fs.rmSync(item.full, { force: true });
        } catch {}
      }
    }
  } catch {}
}

function getSafeCid(raw) {
  const cid = typeof raw === 'string' ? raw.trim() : '';
  return SAFE_CID_RE.test(cid) ? path.basename(cid) : '';
}

function resolvePaths(opts = {}) {
  const stateDir =
    opts.stateDir ||
    process.env.ANTI_CLAUDE_STATE_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'anti-claude');
  const conversationsDir =
    opts.conversationsDir ||
    process.env.ANTI_CLAUDE_CONVERSATIONS_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
  return {
    stateDir,
    conversationsDir,
    prefsFile: opts.studioPrefsFile || path.join(stateDir, 'studio-prefs.json'),
    userConfigFile: opts.userConfigFile || path.join(stateDir, 'user', 'config.json'),
    requestsDir: opts.requestsDir || path.join(stateDir, 'auto-compact-requests'),
    pluginDataDir: opts.pluginDataDir || process.env.PLUGIN_DATA || path.join(stateDir, 'auto-compact-data'),
  };
}

function loadPrefs(prefsFile) {
  const raw = readJsonSafe(prefsFile, {}) || {};
  const trRaw = raw.autoCompactTriggers && typeof raw.autoCompactTriggers === 'object' ? raw.autoCompactTriggers : {};
  return {
    autoCompactMode: ['off', 'semi', 'auto'].includes(raw.autoCompactMode)
      ? raw.autoCompactMode
      : DEFAULT_PREFS.autoCompactMode,
    autoCompactThresholdPct: clampInt(
      raw.autoCompactThresholdPct,
      25,
      85,
      DEFAULT_PREFS.autoCompactThresholdPct
    ),
    autoCompactMinWaitSec: clampInt(raw.autoCompactMinWaitSec, 60, 3600, DEFAULT_PREFS.autoCompactMinWaitSec),
    autoCompactHighWaterPct: sanitizeHighWaterPct(raw.autoCompactHighWaterPct, DEFAULT_PREFS.autoCompactHighWaterPct),
    autoCompactTriggers: {
      longTimer: typeof trRaw.longTimer === 'boolean' ? trRaw.longTimer : true,
      modelRequest: typeof trRaw.modelRequest === 'boolean' ? trRaw.modelRequest : true,
      highWater: typeof trRaw.highWater === 'boolean' ? trRaw.highWater : false,
    },
  };
}

function defaultConvState() {
  return {
    lastRequestedGenIdx: 0,
    lastRequestedAt: 0,
    autoCount: 0,
    pendingModelRequest: null,
  };
}

function loadConvState(pluginDataDir, cid) {
  if (!cid) return { convFile: '', conv: defaultConvState() };
  const convFile = path.join(pluginDataDir, `${cid}.json`);
  const conv = { ...defaultConvState(), ...(readJsonSafe(convFile, null) || {}) };
  return { convFile, conv };
}

function persistConvState(convFile, conv, pluginDataDir, now) {
  if (!convFile) return;
  writeAtomicJson(convFile, conv);
  pruneDirFiles(pluginDataDir, { maxFiles: MAX_CONV_STATE_FILES, pruneNow: now });
}

/* ---- Cron Interval Estimation (Minimum Gap With Wrap-Around) ---- */

function expandCronField(expr, minVal, maxVal) {
  const raw = String(expr || '').trim();
  if (!raw) return null;
  const set = new Set();
  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (!seg) return null;
    const slashParts = seg.split('/');
    if (slashParts.length > 2) return null;
    const [rangePart, stepStr] = slashParts;
    let step = 1;
    if (stepStr !== undefined) {
      if (!/^\d+$/.test(stepStr)) return null;
      step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    let start = minVal;
    let end = maxVal;
    if (rangePart === '*') {
      start = minVal;
      end = maxVal;
    } else if (/^\d+$/.test(rangePart)) {
      start = Number(rangePart);
      end = stepStr !== undefined ? maxVal : start;
    } else {
      const m = rangePart.match(/^(\d+)-(\d+)$/);
      if (!m) return null;
      start = Number(m[1]);
      end = Number(m[2]);
    }
    if (start < minVal || end > maxVal || start > end) return null;
    for (let v = start; v <= end; v += step) {
      set.add(v);
    }
  }
  return set.size > 0 ? Array.from(set).sort((a, b) => a - b) : null;
}

function isValidCronConstraint(expr, minVal, maxVal) {
  return expandCronField(expr, minVal, maxVal) !== null;
}

/**
 * Computes minimum interval in seconds between consecutive firings of a 5-field cron expression
 * over a 24-hour wrap-around cycle (returns 0 on invalid expressions).
 */
export function estimateCronIntervalSec(expr) {
  const fields = String(expr || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (fields.length !== 5) return 0;
  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = fields;
  const mins = expandCronField(minExpr, 0, 59);
  const hours = expandCronField(hourExpr, 0, 23);
  if (!mins || !hours) return 0;
  if (
    !isValidCronConstraint(domExpr, 1, 31) ||
    !isValidCronConstraint(monExpr, 1, 12) ||
    !isValidCronConstraint(dowExpr, 0, 7)
  ) {
    return 0;
  }
  const occurrences = [];
  for (const h of hours) {
    for (const m of mins) {
      occurrences.push(h * 60 + m);
    }
  }
  if (occurrences.length === 0) return 0;
  if (occurrences.length === 1) return 86400;
  let minGapMin = 1440;
  for (let i = 1; i < occurrences.length; i++) {
    minGapMin = Math.min(minGapMin, occurrences[i] - occurrences[i - 1]);
  }
  minGapMin = Math.min(minGapMin, occurrences[0] + 1440 - occurrences[occurrences.length - 1]);
  return minGapMin > 0 ? minGapMin * 60 : 0;
}

/* ---- Fail-Safe Read-Only SQLite & Protobuf Inspection ---- */

function parseProto(buf) {
  const bytes = buf instanceof Uint8Array ? buf : Buffer.from(buf || []);
  const out = new Map();
  let pos = 0;
  const len = bytes.length;
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
      out.set(fieldNo, readVarint());
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      const subLen = readVarint();
      if (subLen < 0 || pos + subLen > len) break;
      out.set(fieldNo, bytes.subarray(pos, pos + subLen));
      pos += subLen;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return out;
}

function parseProtoRepeated(buf) {
  const bytes = buf instanceof Uint8Array ? buf : Buffer.from(buf || []);
  const out = [];
  let pos = 0;
  const len = bytes.length;
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
      out.push([fieldNo, readVarint()]);
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      const subLen = readVarint();
      if (subLen < 0 || pos + subLen > len) break;
      out.push([fieldNo, bytes.subarray(pos, pos + subLen)]);
      pos += subLen;
    } else if (wireType === 5) {
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

function normalizeScheduleArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return null;
  const lowered = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    lowered[String(k || '').toLowerCase()] = v;
  }
  const cleanStr = (v) => {
    if (v === undefined || v === null) return '';
    let s = String(v).trim();
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
      try {
        s = JSON.parse(s);
      } catch {
        s = s.slice(1, -1);
      }
    }
    return String(s || '').trim();
  };
  const durRaw = lowered.durationseconds;
  const durNum = Number(cleanStr(durRaw));
  const durationSeconds = Number.isFinite(durNum) && durNum > 0 ? Math.round(durNum) : 0;
  const cronExpression = cleanStr(lowered.cronexpression);
  const timerCondition = cleanStr(lowered.timercondition).toLowerCase();
  const promptPreview = sanitizeInlineText(cleanStr(lowered.prompt), 120);
  const cronIntervalSec = cronExpression ? estimateCronIntervalSec(cronExpression) : 0;
  const waitSec = durationSeconds > 0 ? durationSeconds : cronIntervalSec;
  if (waitSec <= 0) return null;
  return {
    kind: durationSeconds > 0 ? 'timer' : 'cron',
    waitSec,
    timerCondition,
    promptPreview,
  };
}

export function parseScheduleStepPayload(buf) {
  try {
    if (!buf) return null;
    const top = parseProto(buf);
    const body = top.get(5);
    if (!(body instanceof Uint8Array)) return null;
    const f5 = parseProto(body);
    const tool = f5.get(4);
    if (!(tool instanceof Uint8Array)) return null;
    const f4 = parseProto(tool);
    const toolName = readUtf8(f4.get(2)).trim();
    if (toolName !== 'schedule') return null;

    let argsObj = null;
    const rawArgsStr = readUtf8(f4.get(3)).trim();
    if (rawArgsStr) {
      try {
        argsObj = JSON.parse(rawArgsStr);
      } catch {}
    }
    if (!argsObj) {
      const topRepeated = parseProtoRepeated(buf);
      const fallbackArgs = {};
      for (const [fno, val] of topRepeated) {
        if (fno !== 140 || !(val instanceof Uint8Array)) continue;
        for (const [subFno, subVal] of parseProtoRepeated(val)) {
          if (subFno !== 1 || !(subVal instanceof Uint8Array)) continue;
          const kv = parseProto(subVal);
          const k = readUtf8(kv.get(1)).trim();
          const v = readUtf8(kv.get(2)).trim();
          if (k) fallbackArgs[k] = v;
        }
      }
      if (Object.keys(fallbackArgs).length > 0) argsObj = fallbackArgs;
    }
    return normalizeScheduleArgs(argsObj);
  } catch {
    return null;
  }
}

function parseGenMetadataContextRow(data) {
  try {
    const top = parseProto(data);
    const chatRaw = top.get(1);
    const chat = chatRaw instanceof Uint8Array ? parseProto(chatRaw) : new Map();
    const usageRaw = chat.get(4);
    const usage = usageRaw instanceof Uint8Array ? parseProto(usageRaw) : new Map();
    const chatStartRaw = chat.get(9);
    const chatStart = chatStartRaw instanceof Uint8Array ? parseProto(chatStartRaw) : new Map();
    const ctxWinRaw = chatStart.get(10);
    const ctxWin = ctxWinRaw instanceof Uint8Array ? parseProto(ctxWinRaw) : new Map();
    const inTok = usage.get(2) || 0;
    const cacheRead = usage.get(5) || 0;
    const maxCtx = ctxWin.get(4) || 0;
    return { inTok, cacheRead, ctx: inTok + cacheRead, maxCtx };
  } catch {
    return { inTok: 0, cacheRead: 0, ctx: 0, maxCtx: 0 };
  }
}

function readContextLimitConfig(userConfigFile) {
  const cfg = readJsonSafe(userConfigFile, null);
  const override = Number(cfg?.contextLimitOverride) > 0 ? Number(cfg.contextLimitOverride) : 0;
  const fallback = Number(cfg?.contextLimit) > 0 ? Number(cfg.contextLimit) : 256000;
  return { override, fallback };
}

/**
 * Reads child-conversation status, checkpoint state, active `schedule` timers (`status > 0 && status < 3`),
 * and latest `ctxPct` from the conversation's read-only SQLite database. Never throws.
 */
export function readConversationContextSnapshot(cid, opts = {}) {
  const safeCid = getSafeCid(cid);
  if (!safeCid || !DatabaseSync) return null;
  const { conversationsDir, userConfigFile } = resolvePaths(opts);
  const dbPath = path.join(conversationsDir, `${safeCid}.db`);
  if (!fs.existsSync(dbPath)) return null;

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 30 });

    // 1. Child / subagent conversation exclusion (matches metrics-db.mjs:247-253)
    try {
      const trajRow = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
      if (trajRow?.data) {
        const meta = parseProto(trajRow.data);
        const parentId = readUtf8(meta.get(5)).trim();
        const rootId = readUtf8(meta.get(6)).trim();
        if (parentId || (rootId && rootId !== safeCid)) {
          return { isChild: true, alreadyCompacted: false };
        }
      }
    } catch {}

    // 2. Checkpoint anti-loop (ignore failed checkpoints with status > 3)
    const stepStat = db
      .prepare(
        `SELECT
           MAX(CASE WHEN step_type = 23 AND status > 0 AND status <= 3 THEN idx END) AS lastValidCpIdx,
           MAX(CASE WHEN step_type = 15 THEN idx END) AS lastPlannerIdx
         FROM steps`
      )
      .get();
    const lastValidCpIdx = stepStat?.lastValidCpIdx ?? null;
    const lastPlannerIdx = stepStat?.lastPlannerIdx ?? -1;
    if (lastValidCpIdx !== null && lastValidCpIdx > lastPlannerIdx) {
      return {
        isChild: false,
        alreadyCompacted: true,
        lastCpIdx: lastValidCpIdx,
        lastPlannerIdx,
      };
    }

    // 3. Active ticking `schedule` steps (`status > 0 && status < 3`, no boundary filter so recurring crons stay eligible)
    let activeTimer = null;
    try {
      const schedRows = db
        .prepare(
          'SELECT idx, status, step_payload FROM steps WHERE step_type = 132 AND status > 0 AND status < 3 ORDER BY idx DESC LIMIT 24'
        )
        .all();
      for (const row of schedRows) {
        const parsed = parseScheduleStepPayload(row.step_payload);
        if (!parsed) continue;
        if (parsed.timerCondition && parsed.timerCondition !== 'never') continue;
        if (!activeTimer || parsed.waitSec > activeTimer.waitSec) {
          activeTimer = { stepIdx: row.idx, ...parsed };
        }
      }
    } catch {}

    // 4. Context usage from gen_metadata (inTok + cacheRead, matching metrics-db.mjs:164)
    const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 5').all();
    let matchedGen = null;
    for (const row of genRows) {
      const parsed = parseGenMetadataContextRow(row.data);
      if (parsed.ctx > 0) {
        matchedGen = { idx: row.idx, ...parsed };
        break;
      }
    }
    if (!matchedGen) return null;

    const { override, fallback } = readContextLimitConfig(userConfigFile);
    const limit = override > 0 ? override : matchedGen.maxCtx > 0 ? matchedGen.maxCtx : fallback;
    const ctxPct = limit > 0 ? Math.round((matchedGen.ctx / limit) * 100) : 0;

    return {
      isChild: false,
      alreadyCompacted: false,
      ctx: matchedGen.ctx,
      limit,
      ctxPct,
      lastGenIdx: matchedGen.idx,
      activeTimer,
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/* ---- Hook & CLI Evaluation ---- */

export function evaluateCompactHookEvent(payload = {}, opts = {}) {
  if (!payload || typeof payload !== 'object') return {};
  if (String(payload.hookEventName || '') !== 'Stop') return {};
  if (String(payload.terminationReason || '') !== 'NO_TOOL_CALL') return {};

  const { prefsFile, requestsDir, pluginDataDir } = resolvePaths(opts);
  const prefs = loadPrefs(prefsFile);
  if (prefs.autoCompactMode === 'off') return {};

  const cid = getSafeCid(payload.conversationId);
  if (!cid) return {};

  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const { convFile, conv } = loadConvState(pluginDataDir, cid);
  const ctxSnap = opts.ctxSnapshot !== undefined ? opts.ctxSnapshot : readConversationContextSnapshot(cid, opts);

  if (!ctxSnap || ctxSnap.isChild || ctxSnap.alreadyCompacted) {
    if (conv.pendingModelRequest) {
      conv.pendingModelRequest = null;
      persistConvState(convFile, conv, pluginDataDir, now);
    }
    return {};
  }

  const reqFile = path.join(requestsDir, `${cid}.json`);
  return withRequestLock(
    reqFile,
    () => {
      const existingReq = readJsonSafe(reqFile, null);
      const hasActiveLease = Boolean(
        existingReq &&
          existingReq.consumed !== true &&
          existingReq.dismissed !== true &&
          Number(existingReq.claimExpiresAt || 0) > now
      );
      if (hasActiveLease) {
        return {};
      }

      const lastGenIdx = Number(ctxSnap.lastGenIdx || 0);
      if (lastGenIdx > 0 && lastGenIdx === conv.lastRequestedGenIdx) {
        return {};
      }

      const isRefreshingActiveReq = Boolean(
        existingReq &&
          existingReq.consumed !== true &&
          existingReq.dismissed !== true &&
          Number(existingReq.ts || 0) > 0 &&
          now - Number(existingReq.ts) < REQUEST_TTL_MS &&
          lastGenIdx > Number(conv.lastRequestedGenIdx || 0)
      );

      if (!isRefreshingActiveReq && Number(conv.autoCount || 0) >= MAX_AUTO_PER_SESSION) {
        return {};
      }
      if (!isRefreshingActiveReq && conv.lastRequestedAt > 0 && now - conv.lastRequestedAt < COOLDOWN_MS) {
        return {};
      }

      const pendingReq =
        conv.pendingModelRequest &&
        Number(conv.pendingModelRequest.ts || 0) > 0 &&
        now - Number(conv.pendingModelRequest.ts) < MODEL_REQUEST_TTL_MS
          ? conv.pendingModelRequest
          : null;

      let kind = '';
      let reason = '';
      let waitSec = 0;

      if (prefs.autoCompactTriggers.modelRequest && pendingReq) {
        kind = 'model_request';
        reason = sanitizeInlineText(pendingReq.reason || 'Agent requested end-of-turn compaction', 180);
      } else if (
        prefs.autoCompactTriggers.longTimer &&
        ctxSnap.activeTimer &&
        ctxSnap.activeTimer.waitSec >= prefs.autoCompactMinWaitSec &&
        ctxSnap.ctxPct >= prefs.autoCompactThresholdPct
      ) {
        kind = 'long_timer';
        waitSec = ctxSnap.activeTimer.waitSec;
        const waitMin = Math.max(1, Math.round(waitSec / 60));
        reason = `Active ${waitMin}m timer (${ctxSnap.activeTimer.kind}) at ${ctxSnap.ctxPct}% context`;
      } else if (
        prefs.autoCompactTriggers.highWater &&
        prefs.autoCompactHighWaterPct >= 65 &&
        ctxSnap.ctxPct >= prefs.autoCompactHighWaterPct
      ) {
        kind = 'high_water';
        reason = `Context reached ${ctxSnap.ctxPct}% (>= ${prefs.autoCompactHighWaterPct}%)`;
      }

      if (!kind) {
        if (conv.pendingModelRequest && !pendingReq) {
          conv.pendingModelRequest = null;
          persistConvState(convFile, conv, pluginDataDir, now);
        }
        return {};
      }

      const reqObj = {
        schema: 1,
        id: sha1Short(`${cid}:${kind}:${lastGenIdx}:${now}`),
        cid,
        kind,
        mode: prefs.autoCompactMode,
        reason,
        ctxPct: Number(ctxSnap.ctxPct || 0),
        ctxTokens: Number(ctxSnap.ctx || 0),
        limitTokens: Number(ctxSnap.limit || 256000),
        waitSec,
        genIdx: lastGenIdx,
        ts: now,
        consumed: false,
        dismissed: false,
      };

      writeAtomicJson(reqFile, reqObj);
      pruneDirFiles(requestsDir, { maxFiles: MAX_DIR_FILES, pruneNow: now });

      conv.lastRequestedGenIdx = lastGenIdx;
      conv.lastRequestedAt = now;
      if (!isRefreshingActiveReq) conv.autoCount = Number(conv.autoCount || 0) + 1;
      conv.pendingModelRequest = null;
      persistConvState(convFile, conv, pluginDataDir, now);
      return {};
    },
    { now }
  );
}

export function requestAutoCompact(params = {}, opts = {}) {
  const { prefsFile, pluginDataDir } = resolvePaths(opts);
  const prefs = loadPrefs(prefsFile);
  if (prefs.autoCompactMode === 'off' || !prefs.autoCompactTriggers.modelRequest) {
    return {
      ok: true,
      action: 'skipped',
      reason: prefs.autoCompactMode === 'off' ? 'mode_off' : 'model_request_disabled',
    };
  }
  const cid = getSafeCid(params.cid);
  if (!cid) {
    return { ok: false, error: 'invalid_cid' };
  }
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const { convFile, conv } = loadConvState(pluginDataDir, cid);
  const reason = sanitizeInlineText(params.reason || 'Model requested end-of-turn compaction', 180);
  conv.pendingModelRequest = { reason, ts: now };
  persistConvState(convFile, conv, pluginDataDir, now);
  const cooldownRemainingSec =
    conv.lastRequestedAt > 0 && now - conv.lastRequestedAt < COOLDOWN_MS
      ? Math.ceil((COOLDOWN_MS - (now - conv.lastRequestedAt)) / 1000)
      : 0;
  return {
    ok: true,
    action: 'queued',
    cid,
    mode: prefs.autoCompactMode,
    reason,
    ...(cooldownRemainingSec > 0 ? { cooldownRemainingSec } : {}),
  };
}

export function clearCompactState(params = {}, opts = {}) {
  const { requestsDir, pluginDataDir } = resolvePaths(opts);
  const cid = getSafeCid(params.cid);
  if (!cid) return { ok: false, error: 'invalid_cid' };
  const reqFile = path.join(requestsDir, `${cid}.json`);
  const convFile = path.join(pluginDataDir, `${cid}.json`);
  try {
    fs.rmSync(reqFile, { force: true });
  } catch {}
  try {
    fs.rmSync(convFile, { force: true });
  } catch {}
  return { ok: true, cid };
}

/* ---- CLI Entrypoint ---- */

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.request) {
    process.stdout.write(`${JSON.stringify(requestAutoCompact({ cid: cli.cid || '', reason: cli.reason || '' }))}\n`);
  } else if (cli.clear) {
    process.stdout.write(`${JSON.stringify(clearCompactState({ cid: cli.cid || '' }))}\n`);
  } else {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    let payload = null;
    try {
      payload = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    const out = payload ? evaluateCompactHookEvent(payload) : {};
    process.stdout.write(`${JSON.stringify(out)}\n`);
  }
}
