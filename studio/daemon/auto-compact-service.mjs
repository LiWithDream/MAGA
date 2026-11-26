/**
 * Daemon-side Auto-Compact Service:
 * - Reads, claims (30s CAS lease), commits, releases & dismisses per-conversation
 *   auto-compact requests (`auto-compact-requests/<cid>.json`)
 * - Idempotently syncs/removes the native `maga-auto-compact` Antigravity plugin
 * - Verifies SQLite `step_type = 132` schedule decoder compatibility for `doctor`
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTO_COMPACT_REQUESTS_DIR,
  DB_FILE_RE,
  DatabaseSync,
  GLOBAL_PLUGINS_DIR,
  REPO_ROOT,
  readJsonOrFallback,
  writeAtomicUtf8,
} from '../../core/daemon/env.mjs';

const SAFE_CID_RE = /^[A-Za-z0-9_-]{4,128}$/;
export const AUTO_COMPACT_REQUEST_TTL_MS = 5 * 60 * 1000;
export const AUTO_COMPACT_LEASE_TTL_MS = 30 * 1000;
const MAX_REQUEST_FILES = 32;
const MAX_REQUEST_AGE_MS = 24 * 60 * 60 * 1000;
const PLUGIN_NAME = 'maga-auto-compact';
const PLUGIN_FILES = [
  'plugin.json',
  'hooks.json',
  'rules/AGENTS.md',
  'skills/auto-compact/SKILL.md',
  'hooks/compact-check.mjs',
];

export const AUTO_COMPACT_ACTIONS = new Set([
  'getAutoCompactStatus',
  'claimAutoCompactRequest',
  'commitAutoCompactRequest',
  'releaseAutoCompactRequest',
  'dismissAutoCompactRequest',
  'syncAutoCompactPlugin',
]);

function getRequestsDir(opts = {}) {
  return opts.requestsDir || AUTO_COMPACT_REQUESTS_DIR;
}

function getRequestFilePath(cid, opts = {}) {
  const safe = typeof cid === 'string' ? cid.trim() : '';
  if (!SAFE_CID_RE.test(safe)) return '';
  return path.join(getRequestsDir(opts), `${path.basename(safe)}.json`);
}

function pruneRequestsDir(dir, now = Date.now()) {
  try {
    if (!dir || !fs.existsSync(dir)) return;
    const alive = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      const full = path.join(dir, ent.name);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > MAX_REQUEST_AGE_MS) {
          fs.rmSync(full, { force: true });
        } else {
          alive.push({ full, mtimeMs: st.mtimeMs });
        }
      } catch {}
    }
    if (alive.length > MAX_REQUEST_FILES) {
      alive.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const item of alive.slice(0, alive.length - MAX_REQUEST_FILES)) {
        try {
          fs.rmSync(item.full, { force: true });
        } catch {}
      }
    }
  } catch {}
}

export function readAutoCompactRequest(cid, opts = {}) {
  const filePath = getRequestFilePath(cid, opts);
  if (!filePath) return null;
  const raw = readJsonOrFallback(filePath, null);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

export function writeAutoCompactRequest(cid, reqObj, opts = {}) {
  const filePath = getRequestFilePath(cid, opts);
  if (!filePath || !reqObj || typeof reqObj !== 'object') return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeAtomicUtf8(filePath, `${JSON.stringify(reqObj, null, 2)}\n`);
  pruneRequestsDir(path.dirname(filePath), Number(opts.now) > 0 ? Number(opts.now) : Date.now());
  return true;
}

function isRequestActive(entry, now) {
  if (!entry || entry.consumed === true || entry.dismissed === true) return false;
  const ts = Number(entry.ts || 0);
  if (!ts || now - ts >= AUTO_COMPACT_REQUEST_TTL_MS) return false;
  if (Number(entry.claimExpiresAt || 0) > now) return false;
  return true;
}

function getPluginTargetDir(opts = {}) {
  return path.join(opts.pluginsDir || GLOBAL_PLUGINS_DIR, PLUGIN_NAME);
}

export function isAutoCompactPluginInstalled(opts = {}) {
  const targetDir = getPluginTargetDir(opts);
  return (
    fs.existsSync(path.join(targetDir, 'plugin.json')) &&
    fs.existsSync(path.join(targetDir, 'hooks.json')) &&
    fs.existsSync(path.join(targetDir, 'hooks', 'compact-check.mjs'))
  );
}

export function syncAutoCompactPlugin({ remove = false } = {}, opts = {}) {
  const srcDir = opts.pluginSrcDir || path.join(REPO_ROOT, 'studio', 'plugin', PLUGIN_NAME);
  const targetDir = getPluginTargetDir(opts);
  if (remove) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return { ok: true, action: 'removed', pluginDir: targetDir, installed: false };
  }
  if (!fs.existsSync(srcDir)) {
    return { ok: false, error: 'missing_plugin_source', srcDir };
  }
  const copied = [];
  for (const rel of PLUGIN_FILES) {
    const from = path.join(srcDir, rel);
    const to = path.join(targetDir, rel);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    writeAtomicUtf8(to, fs.readFileSync(from, 'utf8'));
    copied.push(rel);
  }
  return {
    ok: true,
    action: 'synced',
    pluginDir: targetDir,
    files: copied,
    installed: isAutoCompactPluginInstalled(opts),
  };
}

export function getAutoCompactStatus(payload = {}, opts = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const pluginDir = getPluginTargetDir(opts);
  const pluginInstalled = isAutoCompactPluginInstalled(opts);
  let request = null;
  if (cid && SAFE_CID_RE.test(cid)) {
    const raw = readAutoCompactRequest(cid, opts);
    if (isRequestActive(raw, now)) request = raw;
  }
  return { ok: true, pluginInstalled, pluginDir, request };
}

export function claimAutoCompactRequest(payload = {}, opts = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
  if (!cid || !SAFE_CID_RE.test(cid)) {
    return { ok: false, error: 'invalid_cascade_id' };
  }
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const cur = readAutoCompactRequest(cid, opts);
  if (!cur || !isRequestActive(cur, now)) {
    return { ok: true, cascadeId: cid, matched: false };
  }
  if (requestId && cur.id && cur.id !== requestId) {
    return { ok: true, cascadeId: cid, matched: false };
  }
  const claimToken = crypto.randomBytes(12).toString('hex');
  writeAutoCompactRequest(
    cid,
    {
      ...cur,
      claimToken,
      claimedAt: now,
      claimExpiresAt: now + AUTO_COMPACT_LEASE_TTL_MS,
    },
    opts
  );
  return { ok: true, cascadeId: cid, matched: true, claimToken };
}

export function commitAutoCompactRequest(payload = {}, opts = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
  const claimToken = typeof payload?.claimToken === 'string' ? payload.claimToken.trim() : '';
  if (!cid || !SAFE_CID_RE.test(cid)) {
    return { ok: false, error: 'invalid_cascade_id' };
  }
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const cur = readAutoCompactRequest(cid, opts);
  if (!cur || cur.consumed === true || cur.dismissed === true) {
    return { ok: true, cascadeId: cid, matched: false };
  }
  if (requestId && cur.id && cur.id !== requestId) {
    return { ok: true, cascadeId: cid, matched: false };
  }
  if (!claimToken || !cur.claimToken || cur.claimToken !== claimToken) {
    return { ok: true, cascadeId: cid, matched: false };
  }
  const next = { ...cur, consumed: true, consumedAt: now };
  delete next.claimToken;
  delete next.claimedAt;
  delete next.claimExpiresAt;
  writeAutoCompactRequest(cid, next, opts);
  return { ok: true, cascadeId: cid, matched: true };
}

export function releaseAutoCompactRequest(payload = {}, opts = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
  const claimToken = typeof payload?.claimToken === 'string' ? payload.claimToken.trim() : '';
  if (!cid || !SAFE_CID_RE.test(cid)) {
    return { ok: false, error: 'invalid_cascade_id' };
  }
  const cur = readAutoCompactRequest(cid, opts);
  if (!cur || cur.consumed === true || cur.dismissed === true) {
    return { ok: true, cascadeId: cid, matched: false };
  }
  if (requestId && cur.id && cur.id !== requestId) {
    return { ok: true, cascadeId: cid, matched: false };
  }
  if (!claimToken || !cur.claimToken || cur.claimToken !== claimToken) {
    return { ok: true, cascadeId: cid, matched: false };
  }
  const next = { ...cur };
  delete next.claimToken;
  delete next.claimedAt;
  delete next.claimExpiresAt;
  writeAutoCompactRequest(cid, next, opts);
  return { ok: true, cascadeId: cid, matched: true };
}

export function dismissAutoCompactRequest(payload = {}, opts = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
  if (!cid || !SAFE_CID_RE.test(cid)) {
    return { ok: false, error: 'invalid_cascade_id' };
  }
  const cur = readAutoCompactRequest(cid, opts);
  if (!cur) {
    return { ok: true, cascadeId: cid, matched: false };
  }
  if (requestId && cur.id && cur.id !== requestId) {
    return { ok: true, cascadeId: cid, matched: false };
  }
  const next = {
    ...cur,
    dismissed: true,
    dismissedAt: Number(opts.now) > 0 ? Number(opts.now) : Date.now(),
  };
  delete next.claimToken;
  delete next.claimedAt;
  delete next.claimExpiresAt;
  writeAutoCompactRequest(cid, next, opts);
  return { ok: true, cascadeId: cid, matched: true };
}

function parseProtoMap(buf) {
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
    if (wireType === 0) out.set(fieldNo, readVarint());
    else if (wireType === 1) pos += 8;
    else if (wireType === 2) {
      const subLen = readVarint();
      if (subLen < 0 || pos + subLen > len) break;
      out.set(fieldNo, bytes.subarray(pos, pos + subLen));
      pos += subLen;
    } else if (wireType === 5) pos += 4;
    else break;
  }
  return out;
}

function decodeToolNameFromStepPayload(buf) {
  try {
    const top = parseProtoMap(buf);
    const body = top.get(5);
    if (!(body instanceof Uint8Array)) return '';
    const f5 = parseProtoMap(body);
    const tool = f5.get(4);
    if (!(tool instanceof Uint8Array)) return '';
    const f4 = parseProtoMap(tool);
    const rawName = f4.get(2);
    if (!(rawName instanceof Uint8Array)) return '';
    return Buffer.from(rawName.buffer, rawName.byteOffset, rawName.byteLength).toString('utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Verifies against recent local conversation DBs that `step_type = 132` rows
 * still carry a decodable tool name in protobuf field `5 -> 4 -> 2`.
 */
export function verifyLiveScheduleStepDecoder(
  conversationsDir = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations')
) {
  if (!DatabaseSync || !conversationsDir || !fs.existsSync(conversationsDir)) {
    return { status: 'no_samples', checkedRows: 0, decodedOk: 0, scheduleRows: 0 };
  }
  let candidates = [];
  try {
    candidates = fs
      .readdirSync(conversationsDir)
      .filter((name) => DB_FILE_RE.test(name))
      .map((name) => {
        const full = path.join(conversationsDir, name);
        const st = fs.statSync(full, { throwIfNoEntry: false });
        return st ? { full, mtimeMs: st.mtimeMs } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 5);
  } catch {
    return { status: 'no_samples', checkedRows: 0, decodedOk: 0, scheduleRows: 0 };
  }

  let checkedRows = 0;
  let decodedOk = 0;
  let scheduleRows = 0;
  for (const item of candidates) {
    if (checkedRows >= 10) break;
    let db = null;
    try {
      db = new DatabaseSync(item.full, { readOnly: true, timeout: 30 });
      const rows = db
        .prepare('SELECT step_payload FROM steps WHERE step_type = 132 AND step_payload IS NOT NULL ORDER BY idx DESC LIMIT 5')
        .all();
      for (const r of rows) {
        if (checkedRows >= 10) break;
        checkedRows += 1;
        const name = decodeToolNameFromStepPayload(r.step_payload);
        if (/^[a-z][a-z0-9_]{1,64}$/i.test(name)) {
          decodedOk += 1;
          if (name === 'schedule') scheduleRows += 1;
        }
      }
    } catch {
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  const status = checkedRows === 0 ? 'no_samples' : decodedOk > 0 ? 'verified' : 'unverified';
  return { status, checkedRows, decodedOk, scheduleRows };
}

export async function handleAutoCompactRpc(action, payload = {}, opts = {}) {
  switch (action) {
    case 'getAutoCompactStatus':
      return getAutoCompactStatus(payload, opts);
    case 'claimAutoCompactRequest':
      return claimAutoCompactRequest(payload, opts);
    case 'commitAutoCompactRequest':
      return commitAutoCompactRequest(payload, opts);
    case 'releaseAutoCompactRequest':
      return releaseAutoCompactRequest(payload, opts);
    case 'dismissAutoCompactRequest':
      return dismissAutoCompactRequest(payload, opts);
    case 'syncAutoCompactPlugin':
      return syncAutoCompactPlugin(payload, opts);
    default:
      return { ok: false, error: 'unknown_auto_compact_action' };
  }
}
