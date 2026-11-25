/**
 * Lean, zero-dependency protobuf + SQLite usage row reader for Antigravity conversation DBs.
 * Opens idle databases with immutable=1 so SQLite never leaves stray -wal/-shm sidecar files.
 */
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MIN_USAGE_EPOCH_S = 1577836800; // 2020-01-01T00:00:00Z
const isValidEpochSec = (v) => Number.isSafeInteger(v) && v >= MIN_USAGE_EPOCH_S && v < 4e9;

function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length && i - offset < 10) {
    const b = buf[i++];
    if (i - offset === 10 && b > 1) throw new RangeError('Invalid 64-bit protobuf varint');
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [Number(val), i];
    shift += 7n;
  }
  throw new RangeError('Truncated protobuf varint');
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

function asBytes(value) {
  return value instanceof Uint8Array
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : Buffer.alloc(0);
}

export function parseUsageRow(data, stepMetadata) {
  const top = parsePbMap(asBytes(data));
  const chat = parsePbMap(asBytes(top.get(1)?.[0]));
  const usage = parsePbMap(asBytes(chat.get(4)?.[0]));
  const count = (field) => (Number.isSafeInteger(usage.get(field)?.[0]) ? usage.get(field)[0] : 0);
  const text = (field) => asBytes(usage.get(field)?.[0]).toString('utf8');

  // input_tokens (2) is uncached; cacheRead (5), cacheWrite (4), total output (3)
  const tokens = {
    uncached: count(2),
    cacheRead: count(5),
    cacheWrite: count(4),
    output: count(3),
  };
  if (!Object.values(tokens).some(Boolean)) return null;

  const seconds = (stamp) => parsePbMap(asBytes(stamp)).get(1)?.[0];
  let startedAt = seconds(parsePbMap(asBytes(chat.get(9)?.[0])).get(4)?.[0]);
  if (!isValidEpochSec(startedAt)) {
    startedAt = null;
    for (const entry of top.get(2) || []) {
      if (typeof entry === 'number') {
        const candidate = seconds(parsePbMap(asBytes(stepMetadata(entry))).get(1)?.[0]);
        if (isValidEpochSec(candidate)) {
          startedAt = candidate;
          break;
        }
      } else if (entry?.length) {
        let offset = 0;
        while (offset < entry.length) {
          let stepIndex;
          try {
            [stepIndex, offset] = readVarint(entry, offset);
          } catch {
            break;
          }
          const candidate = seconds(parsePbMap(asBytes(stepMetadata(stepIndex))).get(1)?.[0]);
          if (isValidEpochSec(candidate)) {
            startedAt = candidate;
            break;
          }
        }
        if (startedAt !== null) break;
      }
    }
  }

  const responseId = text(11);
  const messageId = text(7);
  const name = (field) => asBytes(chat.get(field)?.[0]).toString('utf8').trim().slice(0, 80);

  return {
    at: isValidEpochSec(startedAt) ? startedAt * 1000 : null,
    id: responseId ? `r${count(6)}:${responseId}` : messageId ? `m${count(6)}:${messageId}` : '',
    model: name(21) || name(19),
    ...tokens,
  };
}

function readTrajectoryLineage(db) {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trajectory_metadata_blob'").get()) {
      return { parentId: '', rootId: '' };
    }
    const row = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
    if (!row?.data) return { parentId: '', rootId: '' };
    const meta = parsePbMap(asBytes(row.data));
    return {
      parentId: asBytes(meta.get(5)?.[0]).toString('utf8').trim(),
      rootId: asBytes(meta.get(6)?.[0]).toString('utf8').trim(),
    };
  } catch {
    return { parentId: '', rootId: '' };
  }
}

export function readConversationUsageRecord(dbPath, { immutable = true } = {}) {
  const hasActiveWal = (statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size || 0) > 0;
  const useImmutable = immutable && !hasActiveWal;
  let location = dbPath;
  if (useImmutable) {
    location = pathToFileURL(dbPath);
    location.searchParams.set('immutable', '1');
  }
  const db = new DatabaseSync(location, { readOnly: true, timeout: 150 });
  try {
    if (!useImmutable) db.exec('PRAGMA busy_timeout = 150');
    let requests = [];
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata'").get()) {
      const hasSteps = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='steps'").get()
      );
      let stepStmt = null;
      const stepMetadata = hasSteps
        ? (index) => (stepStmt ??= db.prepare('SELECT metadata FROM steps WHERE idx = ?')).get(index)?.metadata
        : () => undefined;
      requests = db
        .prepare('SELECT data FROM gen_metadata ORDER BY idx ASC')
        .all()
        .map((row) => parseUsageRow(row.data, stepMetadata))
        .filter(Boolean);
    }
    const { parentId, rootId } = readTrajectoryLineage(db);
    return { requests, parentId, rootId };
  } finally {
    db.close();
  }
}

export function readConversationUsage(dbPath, opts = {}) {
  return readConversationUsageRecord(dbPath, opts).requests;
}
