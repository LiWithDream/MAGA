#!/usr/bin/env node
/**
 * Read-Only Host Coupling Probe (`npm run probe:host`).
 * Verifies Antigravity Desktop version + read-only SQLite `steps` schema +
 * optional live CDP DOM/React-Fiber/Redux contract health (zero mutations).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateOnAntigravityPage } from './cdp-probe.mjs';
import {
  HOST_CONTRACTS,
  buildReadOnlyCdpContractProbeExpression,
  evaluateHostContractReport,
} from './host/contracts.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const realpathNative = fs.realpathSync.native || fs.realpathSync;

let DatabaseSync = null;
try {
  const req = createRequire(import.meta.url);
  ({ DatabaseSync } = req('node:sqlite'));
} catch {}

export function inspectReadOnlyConversationSqlite({
  conversationsDir = process.env.ANTI_CLAUDE_CONVERSATIONS_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'conversations'),
  DatabaseSyncImpl = DatabaseSync,
} = {}) {
  if (!DatabaseSyncImpl) return { status: 'sqlite_unavailable' };
  if (!conversationsDir || !fs.existsSync(conversationsDir)) return { status: 'no_db' };

  let newestDb = '';
  let newestMtime = -1;
  try {
    for (const ent of fs.readdirSync(conversationsDir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.db')) continue;
      const full = path.join(conversationsDir, ent.name);
      try {
        const st = fs.statSync(full);
        if (st.size > 0 && st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs;
          newestDb = full;
        }
      } catch {}
    }
  } catch {
    return { status: 'no_db' };
  }

  if (!newestDb) return { status: 'no_db' };

  const sqliteContract = HOST_CONTRACTS.find((c) => c.id === 'sqlite.conversation_steps_table');
  const requiredCols = sqliteContract?.requiredColumns || ['idx', 'step_type', 'status', 'step_payload'];

  let db = null;
  try {
    db = new DatabaseSyncImpl(newestDb, { open: true, readOnly: true });
    const rows = db.prepare('PRAGMA table_info(steps)').all();
    const present = new Set(rows.map((r) => String(r?.name || '')));
    const missingColumns = requiredCols.filter((c) => !present.has(c));
    return {
      status: missingColumns.length === 0 ? 'pass' : 'fail',
      columns: Array.from(present),
      missingColumns,
    };
  } catch (err) {
    return {
      status: 'fail',
      error: String(err?.message || err).slice(0, 160),
      missingColumns: requiredCols,
    };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export async function runHostContractProbe({
  offline = false,
  requireLiveCdp = false,
  timeoutMs = 5000,
  port = 0,
  conversationsDir,
  evaluateFn = evaluateOnAntigravityPage,
  detectAppFingerprintFn = null,
} = {}) {
  let detectedVersion = 'unknown';
  try {
    const fpFn =
      detectAppFingerprintFn ||
      (await import(pathToFileURL(path.join(REPO_ROOT, 'install.mjs')).href)).getAntigravityAppFingerprint;
    if (typeof fpFn === 'function') {
      const fp = fpFn();
      if (fp?.version && fp.version !== 'unknown') detectedVersion = fp.version;
    }
  } catch {}

  const sqliteReport = inspectReadOnlyConversationSqlite({ conversationsDir });

  let cdpSnapshot = null;
  let cdpError = null;
  if (!offline) {
    const cdpRes = await evaluateFn(buildReadOnlyCdpContractProbeExpression(), { port, timeoutMs });
    if (cdpRes?.ok && cdpRes.value && typeof cdpRes.value === 'object') {
      cdpSnapshot = cdpRes.value;
      if (cdpSnapshot.hostVersion && detectedVersion === 'unknown') {
        detectedVersion = cdpSnapshot.hostVersion;
      }
    } else {
      cdpError = cdpRes?.error || 'cdp_unreachable';
    }
  }

  const report = evaluateHostContractReport({
    hostVersion: cdpSnapshot?.hostVersion || detectedVersion,
    cdpSnapshot,
    sqliteReport,
    requireLiveCdp,
  });

  return {
    ...report,
    cdpStatus: offline ? 'offline_requested' : cdpSnapshot ? 'connected' : 'unreachable',
    ...(cdpError ? { cdpError } : {}),
  };
}

function parseCliArgs(argv) {
  let offline = false;
  let requireLiveCdp = false;
  let timeoutMs = 5000;
  let port = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--offline') offline = true;
    else if (a === '--require-live') requireLiveCdp = true;
    else if (a === '--timeout' && argv[i + 1]) timeoutMs = Math.max(1000, parseInt(argv[++i], 10) || 5000);
    else if (a === '--port' && argv[i + 1]) port = parseInt(argv[++i], 10) || 0;
  }
  return { offline, requireLiveCdp, timeoutMs, port };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
    return norm(realpathNative(path.resolve(process.argv[1]))) === norm(realpathNative(__filename));
  } catch {
    return false;
  }
})();

if (isMain) {
  const opts = parseCliArgs(process.argv.slice(2));
  const res = await runHostContractProbe(opts);
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) process.exit(1);
}
