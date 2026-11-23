/**
 * Lean, fileStamp-cached SQLite metrics reader for side-panel subagent conversations.
 * Extracts model/effort, context ratio, generation tok/s, TTFT/Hold, and running state.
 */
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileStamp } from '../../vendor/agy-capsule/sqlite_cache.mjs';

const HOME = os.homedir();
const CONVERSATIONS_DIR = path.join(HOME, '.gemini', 'antigravity', 'conversations');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAREN_TIER_RE = /^(.*?)\s*\((?:thinking[\s,/-]+)?(off|minimal|low|medium|high|xhigh|extra|max)(?:\s+thinking)?\)$/i;
const TIER_LABEL = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium',
  high: 'High', xhigh: 'XHigh', extra: 'Extra', max: 'Max',
};

const cache = new Map();

function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length && i - offset < 10) {
    const b = buf[i++];
    if (i - offset === 10 && b > 1) throw new RangeError('Invalid varint');
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [Number(val), i];
    shift += 7n;
  }
  throw new RangeError('Truncated varint');
}

function parsePbMap(buf) {
  const fields = new Map();
  let i = 0;
  while (i < buf.length) {
    try {
      const [tag, nextI] = readVarint(buf, i);
      i = nextI;
      const fn = tag >>> 3;
      const wt = tag & 7;
      if (fn === 0) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        const [val, nI] = readVarint(buf, i);
        i = nI;
        fields.get(fn).push(val);
      } else if (wt === 2) {
        const [len, nI] = readVarint(buf, i);
        i = nI;
        if (len < 0 || i + len > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + len));
        i += len;
      } else if (wt === 5) {
        fields.get(fn).push(buf.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
        fields.get(fn).push(buf.subarray(i, i + 8));
        i += 8;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

function asBytes(v) {
  return v instanceof Uint8Array
    ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
    : Buffer.alloc(0);
}

function parseDurationSec(chat, field) {
  if (!chat.has(field)) return null;
  const f = parsePbMap(asBytes(chat.get(field)[0]));
  return (f.get(1)?.[0] || 0) + (f.get(2)?.[0] || 0) / 1e9;
}

function splitModelDisplay(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { modelName: '', effort: '' };
  const m = PAREN_TIER_RE.exec(trimmed);
  if (m && m[1].trim()) {
    return {
      modelName: m[1].trim(),
      effort: TIER_LABEL[m[2].toLowerCase()] || m[2],
    };
  }
  return { modelName: trimmed, effort: '' };
}

function inferDefaultLimit(modelName) {
  const lower = String(modelName || '').toLowerCase();
  if (lower.includes('claude') || lower.includes('opus') || lower.includes('sonnet') || lower.includes('haiku')) return 200_000;
  if (lower.includes('flash')) return 1_000_000;
  if (lower.includes('gpt')) return 128_000;
  return 512_000;
}

function readDbSnapshot(dbPath) {
  const hasActiveWal = (statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size || 0) > 0;
  let location = dbPath;
  if (!hasActiveWal) {
    location = pathToFileURL(dbPath);
    location.searchParams.set('immutable', '1');
  }
  const db = new DatabaseSync(location, { readOnly: true, timeout: 150 });
  try {
    if (!hasActiveWal) db.exec('PRAGMA busy_timeout = 150');
    const hasGen = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata'").get());
    const hasSteps = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='steps'").get());

    let running = false;
    if (hasSteps) {
      const lastStep = db.prepare('SELECT status FROM steps ORDER BY idx DESC LIMIT 1').get();
      if (lastStep && (lastStep.status === 2 || lastStep.status === 8)) {
        running = true;
      }
    }

    if (!hasGen) return { hasData: false, running };
    const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx ASC').all();
    if (!rows.length) return { hasData: false, running };

    let latest = null;
    let maxCtxLimit = 0;
    let calls = 0;

    for (const row of rows) {
      const top = parsePbMap(asBytes(row.data));
      if (!top.has(1)) continue;
      const chat = parsePbMap(asBytes(top.get(1)[0]));
      const usage = parsePbMap(asBytes(chat.get(4)?.[0]));

      const uncached = usage.get(2)?.[0] || 0;
      const cached = usage.get(5)?.[0] || 0;
      const totalOut = usage.get(3)?.[0] || 0;
      const contextTokens = uncached + cached;

      if (chat.has(9)) {
        const m9 = parsePbMap(asBytes(chat.get(9)[0]));
        if (m9.has(10)) {
          const m10 = parsePbMap(asBytes(m9.get(10)[0]));
          const lim = m10.get(4)?.[0] || 0;
          if (lim > maxCtxLimit) maxCtxLimit = lim;
        }
      }

      const rawModel = asBytes(chat.get(21)?.[0]).toString('utf8').trim()
        || asBytes(chat.get(19)?.[0]).toString('utf8').trim();
      const ttft = parseDurationSec(chat, 11);
      const streaming = parseDurationSec(chat, 12);

      if (contextTokens > 0 || totalOut > 0 || rawModel) {
        calls++;
        latest = {
          rawModel,
          contextTokens,
          totalOut,
          ttft,
          streaming,
        };
      }
    }

    if (!latest) return { hasData: false, running };

    const { modelName, effort } = splitModelDisplay(latest.rawModel);
    const maxContextTokens = maxCtxLimit > 0 ? maxCtxLimit : inferDefaultLimit(modelName);
    const pct = maxContextTokens > 0
      ? Math.max(0, Math.min(100, Math.round((latest.contextTokens / maxContextTokens) * 100)))
      : 0;

    const useStream = latest.streaming !== null && latest.streaming >= 0.15 && latest.totalOut > 0;
    const totDur = (latest.ttft || 0) + (latest.streaming || 0);
    let tps = null;
    if (useStream) {
      tps = latest.totalOut / latest.streaming;
    } else if (totDur > 0 && latest.totalOut > 0) {
      tps = latest.totalOut / totDur;
    }

    return {
      hasData: true,
      model: latest.rawModel,
      modelName,
      effort,
      contextTokens: latest.contextTokens,
      maxContextTokens,
      pct,
      tps: Number.isFinite(tps) && tps > 0 ? Math.round(tps * 10) / 10 : null,
      ttft: latest.ttft !== null ? Math.round(latest.ttft * 10) / 10 : null,
      isHold: !useStream && latest.ttft !== null,
      calls,
      running,
    };
  } finally {
    db.close();
  }
}

export function collectSubagentMetrics(payload = {}) {
  const cascadeId = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    return { ok: false, error: 'invalid_cascade_id' };
  }
  const dbPath = path.join(CONVERSATIONS_DIR, `${cascadeId}.db`);
  const dbStamp = fileStamp(dbPath);
  if (!dbStamp || dbStamp.size === 0n) {
    return { ok: true, cascadeId, hasData: false };
  }
  const walStamp = fileStamp(`${dbPath}-wal`);
  const key = `${dbStamp.key}|${walStamp && walStamp.size > 0n ? walStamp.key : 'no-wal'}`;
  const cached = cache.get(cascadeId);
  if (cached && cached.key === key) {
    return cached.value;
  }
  try {
    const snap = readDbSnapshot(dbPath);
    const value = { ok: true, cascadeId, ...snap };
    cache.delete(cascadeId);
    cache.set(cascadeId, { key, value });
    if (cache.size > 24) cache.delete(cache.keys().next().value);
    return value;
  } catch (err) {
    return cached?.value || { ok: false, error: String(err?.message || err) };
  }
}
