/**
 * Per-cascade Single-Writer Lock & Short Post-Write Cooldown Registry.
 * Prevents concurrent remote/desktop writes on the same cascade and suppresses
 * false-positive Interrupted-Task Resume detection while SQLite WAL flushes.
 */

export const DEFAULT_RECENT_WRITE_COOLDOWN_MS = 3000;
export const DEFAULT_LOCK_STALE_MS = 30_000;
const MAX_RECENT_ENTRIES = 128;

const activeWriters = new Map();
const recentWrites = new Map();

export function isCascadeWriteActive(cascadeId, now = Date.now()) {
  const cid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
  if (!cid) return false;
  const entry = activeWriters.get(cid);
  if (!entry) return false;
  if (now - entry.acquiredAt >= DEFAULT_LOCK_STALE_MS) {
    activeWriters.delete(cid);
    return false;
  }
  return true;
}

export function isCascadeWriteActiveOrRecent(
  cascadeId,
  { cooldownMs = DEFAULT_RECENT_WRITE_COOLDOWN_MS, now = Date.now() } = {}
) {
  const cid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
  if (!cid) return false;
  if (isCascadeWriteActive(cid, now)) return true;
  const ts = recentWrites.get(cid);
  if (!ts) return false;
  if (now - ts < cooldownMs) return true;
  recentWrites.delete(cid);
  return false;
}

export function markCascadeWritten(cascadeId, now = Date.now()) {
  const cid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
  if (!cid) return;
  recentWrites.delete(cid);
  recentWrites.set(cid, now);
  while (recentWrites.size > MAX_RECENT_ENTRIES) {
    const oldest = recentWrites.keys().next().value;
    if (oldest === undefined) break;
    recentWrites.delete(oldest);
  }
}

export async function withCascadeWriteLock(
  cascadeId,
  owner,
  fn,
  { markCooldownOnSuccess = false } = {}
) {
  const cid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
  if (!cid || typeof fn !== 'function') {
    throw Object.assign(new Error('invalid_lock_args'), { code: 'invalid_lock_args' });
  }
  if (isCascadeWriteActive(cid)) {
    throw Object.assign(new Error('cascade_write_busy'), {
      code: 'cascade_write_busy',
      holder: activeWriters.get(cid)?.owner || '',
    });
  }
  const token = { owner: String(owner || 'write'), acquiredAt: Date.now() };
  activeWriters.set(cid, token);
  try {
    const res = await fn();
    if (markCooldownOnSuccess) {
      markCascadeWritten(cid);
    }
    return res;
  } finally {
    if (activeWriters.get(cid) === token) {
      activeWriters.delete(cid);
    }
  }
}

export function resetCascadeWriteLocksForTest() {
  activeWriters.clear();
  recentWrites.clear();
}
