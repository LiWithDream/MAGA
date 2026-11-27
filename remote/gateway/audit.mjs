/**
 * MAGA Remote Gateway — Append-only 0600 JSONL Audit Logger with Size Rotation & Denial Rate-Limiting
 * Zero third-party dependencies (Node >= 22 built-ins only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureRemoteDir, getRemotePaths } from './config.mjs';
import { isPosixPermsEnforced, renameWithWinRetry } from '../shared/fs-paths.mjs';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 10;

const RATE_LIMITED_EVENTS = new Set([
  'http_access_denied',
  'ws_upgrade_rejected',
  'ws_auth_failed',
  'pair_failed',
]);

const SENSITIVE_KEYS = new Set([
  'code',
  'nonce',
  'signature',
  'jwt',
  'assertion',
  'cfAccessJwt',
  'token',
  'privateKey',
  'privateKeyJwk',
]);

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const out = {};
  for (const [k, v] of Object.entries(details)) {
    if (SENSITIVE_KEYS.has(k) || v === undefined) continue;
    if (k === 'url' && typeof v === 'string') {
      out[k] = v.split('?')[0];
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function createAuditLogger({
  remoteDir = null,
  auditFile = null,
  now = Date.now,
  maxBytes = DEFAULT_MAX_BYTES,
  rateWindowMs = DEFAULT_RATE_WINDOW_MS,
  rateLimit = DEFAULT_RATE_LIMIT,
} = {}) {
  const paths = getRemotePaths(remoteDir);
  const targetFile = auditFile ? path.resolve(auditFile) : paths.auditFile;
  const targetDir = path.dirname(targetFile);
  const rotatedFile = `${targetFile}.1`;
  const rateBuckets = new Map();

  function ensureReady() {
    ensureRemoteDir(targetDir, 0o700);
    try {
      const lst = fs.lstatSync(targetFile);
      if (lst.isSymbolicLink()) {
        throw new Error(`refusing_symlink_audit:${targetFile}`);
      }
      if (lst.size >= maxBytes) {
        try {
          const rotLst = fs.lstatSync(rotatedFile);
          if (rotLst.isSymbolicLink()) {
            fs.rmSync(rotatedFile, { force: true });
          }
        } catch {}
        renameWithWinRetry(targetFile, rotatedFile);
        if (isPosixPermsEnforced()) {
          try {
            fs.chmodSync(rotatedFile, 0o600);
          } catch {}
        }
        const fd = fs.openSync(targetFile, 'a', 0o600);
        fs.closeSync(fd);
        if (isPosixPermsEnforced()) {
          try {
            fs.chmodSync(targetFile, 0o600);
          } catch {}
        }
        return;
      }
      if (isPosixPermsEnforced() && (lst.mode & 0o777) !== 0o600) {
        fs.chmodSync(targetFile, 0o600);
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const fd = fs.openSync(targetFile, 'a', 0o600);
        fs.closeSync(fd);
        if (isPosixPermsEnforced()) {
          try {
            fs.chmodSync(targetFile, 0o600);
          } catch {}
        }
      } else {
        throw err;
      }
    }
  }

  function checkRateLimit(event, details, tsMs) {
    if (!RATE_LIMITED_EVENTS.has(event)) return { allow: true, suppressedPrev: 0 };
    const sourceKey = `${event}:${details.clientKey || details.remoteAddr || 'default'}`;
    let bucket = rateBuckets.get(sourceKey);
    if (!bucket || tsMs - bucket.windowStart >= rateWindowMs) {
      const suppressedPrev = bucket ? bucket.suppressed : 0;
      if (rateBuckets.size >= 1024) {
        const oldest = rateBuckets.keys().next().value;
        if (oldest !== undefined) rateBuckets.delete(oldest);
      }
      bucket = { windowStart: tsMs, count: 1, suppressed: 0 };
      rateBuckets.set(sourceKey, bucket);
      return { allow: true, suppressedPrev };
    }
    bucket.count += 1;
    if (bucket.count > rateLimit) {
      bucket.suppressed += 1;
      return { allow: false, suppressedPrev: 0 };
    }
    return { allow: true, suppressedPrev: 0 };
  }

  function append(event, details = {}) {
    if (!event || typeof event !== 'string') return null;
    const tsMs = now();
    const clean = sanitizeDetails(details);
    const rate = checkRateLimit(event, clean, tsMs);
    if (!rate.allow) return null;

    ensureReady();
    const record = {
      ts: new Date(tsMs).toISOString(),
      tsMs,
      event,
      ...clean,
      ...(rate.suppressedPrev > 0 ? { suppressedPrev: rate.suppressedPrev } : {}),
    };
    fs.appendFileSync(targetFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    return record;
  }

  function readTail(limit = 50) {
    try {
      if (!fs.existsSync(targetFile)) return [];
      const lines = fs
        .readFileSync(targetFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      const slice = limit > 0 ? lines.slice(-limit) : lines;
      const entries = [];
      for (const line of slice) {
        try {
          entries.push(JSON.parse(line));
        } catch {}
      }
      return entries;
    } catch {
      return [];
    }
  }

  return {
    auditFile: targetFile,
    rotatedFile,
    append,
    readTail,
  };
}
