/**
 * Read-Only SQLite & File-Stamp Cached Background Task Inspector (Daemon-side).
 * Inspects active steps (`WHERE status IN (1, 2, 8)`) only for `notFullyIdle` conversations
 * to classify `subagent`, `command` (`run_command`), `timer` (`schedule`), or `bg-wait`.
 */
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let DefaultDatabaseSync = null;
try {
  const req = createRequire(import.meta.url);
  ({ DatabaseSync: DefaultDatabaseSync } = req('node:sqlite'));
} catch {}

const CONV_DIR = path.join(homedir(), '.gemini', 'antigravity', 'conversations');
const SAFE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_BATCH = 40;
const MAX_CACHE = 64;
const STEP_INVOKE_SUBAGENT = 127;
const SUBAGENT_TOOLS = new Set(['invoke_subagent', 'swarm_wait', 'run_workflow']);
const KIND_RANK = Object.freeze({
  'bg-wait': 0,
  timer: 1,
  command: 2,
  subagent: 3,
});

const cache = new Map();

export function resetBackgroundTaskStatusCache() {
  cache.clear();
}

function setBoundedCache(key, value) {
  if (cache.has(key)) cache.delete(key);
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function inspectDbFiles(dbPath) {
  const st = statSync(dbPath, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
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

function withReadOnlyDb(dbPath, meta, fn, DbCtor) {
  const run = (useImmutable) => {
    let db = null;
    try {
      let location = dbPath;
      if (useImmutable) {
        location = pathToFileURL(dbPath);
        location.searchParams.set('immutable', '1');
      }
      db = new DbCtor(location, { readOnly: true, timeout: 150 });
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

function parseArgsJson(rawStr) {
  const s = String(rawStr || '').trim();
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractToolFromSubFields(toolBytes) {
  if (!(toolBytes instanceof Uint8Array)) return { toolName: '', argsObj: null };
  const tc = parseProtoFields(toolBytes);
  const rawName = readUtf8(tc.get(2)?.[0]).trim();
  const toolName = rawName ? rawName.split(':').pop().trim() : '';
  const argsObj = parseArgsJson(readUtf8(tc.get(3)?.[0]));
  return { toolName, argsObj };
}

function extractRepeatedKvArgs(stepPayloadBuf) {
  const top = parseProtoFields(stepPayloadBuf);
  const rawList = top.get(140) || [];
  if (!rawList.length) return null;
  const fallback = {};
  for (const val of rawList) {
    if (!(val instanceof Uint8Array)) continue;
    const nested = parseProtoFields(val);
    for (const subVal of nested.get(1) || []) {
      if (!(subVal instanceof Uint8Array)) continue;
      const kv = parseProtoFields(subVal);
      const k = readUtf8(kv.get(1)?.[0]).trim();
      const v = readUtf8(kv.get(2)?.[0]).trim();
      if (k) fallback[k] = v;
    }
  }
  return Object.keys(fallback).length > 0 ? fallback : null;
}

export function extractToolCallFromStep(metadataBuf, stepPayloadBuf) {
  let toolName = '';
  let argsObj = null;

  if (metadataBuf) {
    const meta = parseProtoFields(metadataBuf);
    const tcRaw = meta.get(4)?.[0];
    if (tcRaw instanceof Uint8Array) {
      const parsed = extractToolFromSubFields(tcRaw);
      toolName = parsed.toolName;
      argsObj = parsed.argsObj;
    }
  }

  if ((!toolName || !argsObj) && stepPayloadBuf) {
    const top = parseProtoFields(stepPayloadBuf);
    const body = top.get(5)?.[0];
    if (body instanceof Uint8Array) {
      const f5 = parseProtoFields(body);
      const tcRaw = f5.get(4)?.[0];
      if (tcRaw instanceof Uint8Array) {
        const parsed = extractToolFromSubFields(tcRaw);
        if (!toolName && parsed.toolName) toolName = parsed.toolName;
        if (!argsObj && parsed.argsObj) argsObj = parsed.argsObj;
      }
    }
    if (!argsObj) {
      argsObj = extractRepeatedKvArgs(stepPayloadBuf);
    }
  }

  return { toolName, argsObj };
}

function cleanSingleLine(str) {
  return String(str || '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(str, maxLen) {
  const s = String(str || '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

export function redactCommandPreview(rawCmd, maxLen = 48) {
  const single = cleanSingleLine(rawCmd);
  if (!single) return '';
  const redacted = single
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD|PASSWD|AUTH|COOKIE)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '$1=[REDACTED]')
    .replace(/(--?(?:token|api-key|secret|password|passwd|auth|cookie)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]');
  return truncateText(redacted, maxLen);
}

function getCaseInsensitiveArg(argsObj, keyLower) {
  if (!argsObj || typeof argsObj !== 'object') return undefined;
  for (const [k, v] of Object.entries(argsObj)) {
    if (String(k || '').toLowerCase() === keyLower) return v;
  }
  return undefined;
}

function formatDurationCompact(seconds) {
  const n = Math.round(Number(seconds));
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 60) return `${n}s`;
  if (n < 3600) {
    const mins = Math.round(n / 60);
    return `${mins}m`;
  }
  const hrs = (n / 3600).toFixed(n % 3600 === 0 ? 0 : 1);
  return `${hrs}h`;
}

export function formatScheduleDetail(argsObj) {
  if (!argsObj) return '';
  const rawCron = cleanSingleLine(getCaseInsensitiveArg(argsObj, 'cronexpression') || '');
  if (rawCron) return `Cron: ${truncateText(rawCron, 32)}`;
  const durRaw = getCaseInsensitiveArg(argsObj, 'durationseconds');
  const durStr = formatDurationCompact(durRaw);
  return durStr ? `${durStr}` : '';
}

export function formatSubagentDetail(argsObj, toolName) {
  if (argsObj) {
    const role = cleanSingleLine(getCaseInsensitiveArg(argsObj, 'role') || '');
    if (role) return truncateText(role, 32);
    const typeName = cleanSingleLine(getCaseInsensitiveArg(argsObj, 'typename') || '');
    if (typeName) return truncateText(typeName, 32);
  }
  return cleanSingleLine(toolName || '');
}

export function inspectConversationBgState(
  cid,
  { conversationsDir = CONV_DIR, DatabaseSyncImpl = DefaultDatabaseSync } = {}
) {
  if (!cid || !SAFE_ID_RE.test(cid)) {
    return { kind: 'bg-wait', detail: '', toolName: '', count: 0, degraded: true };
  }
  if (!DatabaseSyncImpl) {
    return { kind: 'bg-wait', detail: '', toolName: '', count: 0, degraded: true };
  }

  const dbPath = path.join(conversationsDir, `${cid}.db`);
  const meta = inspectDbFiles(dbPath);
  if (!meta) {
    return { kind: 'bg-wait', detail: '', toolName: '', count: 0, degraded: true };
  }

  const cacheKey = `${conversationsDir}:${cid}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.stamp === meta.stamp) {
    return hit.result;
  }

  try {
    const rows = withReadOnlyDb(
      dbPath,
      meta,
      (db) => {
        const hasSteps = Boolean(
          db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps' LIMIT 1").get()
        );
        if (!hasSteps) return [];
        const cols = new Set(db.prepare('PRAGMA table_info(steps)').all().map((c) => c.name));
        if (!cols.has('idx') || !cols.has('step_type') || !cols.has('status')) return [];
        const selectCols = [
          'idx',
          'step_type',
          'status',
          cols.has('metadata') ? 'metadata' : 'NULL AS metadata',
          cols.has('step_payload') ? 'step_payload' : 'NULL AS step_payload',
        ].join(', ');
        return db
          .prepare(`SELECT ${selectCols} FROM steps WHERE status IN (1, 2, 8) ORDER BY idx DESC LIMIT 24`)
          .all();
      },
      DatabaseSyncImpl
    );

    let best = null;
    let matchedCount = 0;

    for (const row of rows) {
      const stepType = Number(row.step_type ?? 0);
      const stepIdx = Number(row.idx ?? 0);
      const { toolName, argsObj } = extractToolCallFromStep(row.metadata, row.step_payload);
      let candidate = null;

      if (stepType === STEP_INVOKE_SUBAGENT || SUBAGENT_TOOLS.has(toolName)) {
        candidate = {
          kind: 'subagent',
          detail: formatSubagentDetail(argsObj, toolName),
          toolName: toolName || 'invoke_subagent',
          stepIdx,
        };
      } else if (toolName === 'run_command') {
        const cmd = getCaseInsensitiveArg(argsObj, 'commandline') || getCaseInsensitiveArg(argsObj, 'command') || '';
        candidate = {
          kind: 'command',
          detail: redactCommandPreview(cmd),
          toolName: 'run_command',
          stepIdx,
        };
      } else if (toolName === 'schedule') {
        candidate = {
          kind: 'timer',
          detail: formatScheduleDetail(argsObj),
          toolName: 'schedule',
          stepIdx,
        };
      }

      if (!candidate) continue;
      matchedCount += 1;
      if (
        !best ||
        KIND_RANK[candidate.kind] > KIND_RANK[best.kind] ||
        (KIND_RANK[candidate.kind] === KIND_RANK[best.kind] && candidate.stepIdx > best.stepIdx)
      ) {
        best = candidate;
      }
    }

    const result = best
      ? {
          kind: best.kind,
          detail: best.detail,
          toolName: best.toolName,
          count: matchedCount,
        }
      : {
          kind: 'bg-wait',
          detail: '',
          toolName: '',
          count: rows.length,
        };

    setBoundedCache(cacheKey, { stamp: meta.stamp, result });
    return result;
  } catch {
    return { kind: 'bg-wait', detail: '', toolName: '', count: 0, degraded: true };
  }
}

export function collectBackgroundTaskStates(payload = {}, opts = {}) {
  const rawIds = Array.isArray(payload?.cascadeIds) ? payload.cascadeIds : [];
  const states = {};
  const seen = new Set();

  for (const raw of rawIds) {
    if (seen.size >= MAX_BATCH) break;
    const cid = typeof raw === 'string' ? raw.trim() : '';
    if (!cid || seen.has(cid) || !SAFE_ID_RE.test(cid)) continue;
    seen.add(cid);
    states[cid] = inspectConversationBgState(cid, opts);
  }

  return { ok: true, states };
}
