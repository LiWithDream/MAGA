/**
 * Synchronous, zero-dependency Antigravity Lifecycle Hook Sentinel, Semantic Preflight & Clear Gate.
 * - Appends file touches atomically (`<cid>.touched.log`) to prevent parallel PostToolUse lost updates.
 * - Computes strict per-conversation attribution (`touched ∩ gitChanged`), no-spawn worktree root,
 *   set-based `risk` dedup & delta-based `stop` dedup with `GIT_OPTIONAL_LOCKS=0`.
 * - Writes isolated per-conversation proposals (`opus-gate-proposals/<cid>.json`), eliminating shared-file RMW races.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIGH_RISK_PATH_RE =
  /(?:^|\/)(?:kernel|dom|cdp-[^/]+|daemon|prefs-bundle|build|cli|auth|security|migration|schema)\.(?:m?js|ts|sql)$|package\.json$|hooks\.json$/i;
const PLAN_PATH_RE =
  /(?:^|\/)(?:implementation_plan|plan|design|architecture|rfc|spec)(?:[._-][^/]*)?\.md$/i;
const SAFE_CID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const MAX_DIR_FILES = 32;
const MAX_DIR_AGE_MS = 24 * 60 * 60 * 1000;
const GIT_DEADLINE_MS = 3000;
const VALID_KINDS = new Set(['plan', 'risk', 'debug', 'stop', 'review']);

const DEFAULT_PREFS = {
  opusGateMode: 'semi',
  opusGatePreferredTier: 'high',
  opusGateMinQuota5hPct: 20,
  opusGateMinQuotaWeeklyPct: 15,
  opusGateMaxAutoPerSession: 2,
  opusGateCheckpoints: { plan: true, risk: true, debug: true, stop: true },
};

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const GATE_RETRY_SLEEP_BUF =
  typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

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
          if (GATE_RETRY_SLEEP_BUF) {
            try {
              Atomics.wait(GATE_RETRY_SLEEP_BUF, 0, 0, 20);
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

function sha1Short(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

function realpathSafe(p) {
  if (!p) return '';
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function resolveAbsPath(rawPath, cwd = '') {
  const s = String(rawPath || '').trim();
  if (!s) return '';
  const candidate = path.isAbsolute(s) ? path.normalize(s) : path.resolve(cwd || process.cwd(), s);
  try {
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  } catch {}
  let cur = path.dirname(candidate);
  const tail = [path.basename(candidate)];
  while (cur) {
    try {
      if (fs.existsSync(cur)) return path.join(fs.realpathSync(cur), ...tail);
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return candidate;
}

function findGitRootSync(startPath) {
  if (!startPath) return '';
  let cur = path.resolve(startPath);
  try {
    if (fs.existsSync(cur) && fs.statSync(cur).isFile()) cur = path.dirname(cur);
    else if (!fs.existsSync(cur)) cur = path.dirname(cur);
  } catch {
    cur = path.dirname(cur);
  }
  for (let i = 0; i < 24 && cur; i++) {
    try {
      if (fs.existsSync(path.join(cur, '.git'))) return realpathSafe(cur);
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return '';
}

function normalizeRelPath(absPath, rootDir) {
  if (!absPath || !rootDir) return '';
  const rootReal = realpathSafe(rootDir);
  const absReal = realpathSafe(absPath);
  const rel = path.relative(rootReal, absReal);
  if (!rel || rel === '.' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return '';
  return rel.split(path.sep).join('/');
}

function sanitizePromptText(str, maxLen = 200) {
  return String(str || '')
    .replace(/`/g, "'")
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

function sanitizePathDisplay(str) {
  return String(str || '')
    .replace(/\\/g, '/')
    .replace(/[`'"\r\n\t\u0000-\u001F\u007F]/g, '')
    .replace(/[^\w./@:+-]/g, '_')
    .slice(0, 220);
}

function pruneDirFiles(dir, { maxFiles = MAX_DIR_FILES, maxAgeMs = MAX_DIR_AGE_MS, pruneNow = Date.now() } = {}) {
  try {
    if (!dir || !fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const alive = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!/\.(?:json|log)$/i.test(ent.name)) continue;
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

function loadPrefs(prefsPath) {
  const raw = readJsonSafe(prefsPath, {}) || {};
  const cpRaw = raw.opusGateCheckpoints && typeof raw.opusGateCheckpoints === 'object' ? raw.opusGateCheckpoints : {};
  return {
    opusGateMode: ['off', 'semi', 'auto'].includes(raw.opusGateMode) ? raw.opusGateMode : DEFAULT_PREFS.opusGateMode,
    opusGatePreferredTier: ['high', 'medium'].includes(raw.opusGatePreferredTier)
      ? raw.opusGatePreferredTier
      : DEFAULT_PREFS.opusGatePreferredTier,
    opusGateMinQuota5hPct: clampInt(raw.opusGateMinQuota5hPct, 5, 80, DEFAULT_PREFS.opusGateMinQuota5hPct),
    opusGateMinQuotaWeeklyPct: clampInt(raw.opusGateMinQuotaWeeklyPct, 5, 60, DEFAULT_PREFS.opusGateMinQuotaWeeklyPct),
    opusGateMaxAutoPerSession: clampInt(raw.opusGateMaxAutoPerSession, 1, 5, DEFAULT_PREFS.opusGateMaxAutoPerSession),
    opusGateCheckpoints: {
      plan: typeof cpRaw.plan === 'boolean' ? cpRaw.plan : true,
      risk: typeof cpRaw.risk === 'boolean' ? cpRaw.risk : true,
      debug: typeof cpRaw.debug === 'boolean' ? cpRaw.debug : true,
      stop: typeof cpRaw.stop === 'boolean' ? cpRaw.stop : true,
    },
  };
}

function resolveQuotaSnapshot(quotaPath) {
  const raw = readJsonSafe(quotaPath, null);
  const claude = raw && typeof raw.claude === 'object' ? raw.claude : {};
  const toPct = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  };
  return {
    claude5hPct: toPct(claude.fiveHourRemainingPct),
    claudeWeeklyPct: toPct(claude.weeklyRemainingPct),
  };
}

function evaluateQuotaPolicy(prefs, quota, kind = '') {
  const healthy =
    (quota.claude5hPct === null || quota.claude5hPct >= prefs.opusGateMinQuota5hPct) &&
    (quota.claudeWeeklyPct === null || quota.claudeWeeklyPct >= prefs.opusGateMinQuotaWeeklyPct);
  const recommendedTier =
    kind === 'stop'
      ? 'medium'
      : prefs.opusGatePreferredTier === 'high' &&
          (quota.claude5hPct === null || quota.claude5hPct >= prefs.opusGateMinQuota5hPct + 15)
        ? 'high'
        : 'medium';
  return { healthy, recommendedTier };
}

function resolvePaths(opts = {}) {
  const stateDir =
    opts.stateDir ||
    process.env.ANTI_CLAUDE_STATE_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'anti-claude');
  return {
    stateDir,
    prefsFile: opts.studioPrefsFile || path.join(stateDir, 'studio-prefs.json'),
    quotaFile: opts.quotaStateFile || path.join(stateDir, 'quota-state.json'),
    proposalsDir: opts.proposalsDir || path.join(stateDir, 'opus-gate-proposals'),
    pluginDataDir: opts.pluginDataDir || process.env.PLUGIN_DATA || path.join(stateDir, 'opus-gate-data'),
  };
}

function getSafeCid(raw) {
  const cid = typeof raw === 'string' ? raw.trim() : '';
  return SAFE_CID_RE.test(cid) ? path.basename(cid) : '';
}

function defaultConvState() {
  return {
    consecutiveErrors: 0,
    lastErrorSig: '',
    touchedAbsFiles: [],
    planFiles: [],
    pendingPlanHash: '',
    pendingPlanReason: '',
    lastAuditedPlanHash: '',
    lastSuggestedPlanHash: '',
    lastAuditedRiskHash: '',
    lastSuggestedRiskHash: '',
    lastAuditedStopFiles: 0,
    lastAuditedStopLines: 0,
    lastSuggestedStopFiles: 0,
    lastSuggestedStopLines: 0,
    autoCalls: 0,
    lastAutoSemanticHash: '',
    lastSuggestedSemanticHash: '',
  };
}

function loadConvState(pluginDataDir, cid) {
  if (!cid) {
    return { convFile: '', touchLogFile: '', conv: defaultConvState(), hadLog: false };
  }
  const convFile = path.join(pluginDataDir, `${cid}.json`);
  const touchLogFile = path.join(pluginDataDir, `${cid}.touched.log`);
  const conv = { ...defaultConvState(), ...(readJsonSafe(convFile, null) || {}) };
  if (!Array.isArray(conv.touchedAbsFiles)) conv.touchedAbsFiles = [];
  if (!Array.isArray(conv.planFiles)) conv.planFiles = [];
  const hadLog = foldTouchLog(conv, touchLogFile);
  return { convFile, touchLogFile, conv, hadLog };
}

function foldTouchLog(conv, touchLogFile) {
  if (!touchLogFile || !fs.existsSync(touchLogFile)) return false;
  let raw = '';
  try {
    raw = fs.readFileSync(touchLogFile, 'utf8');
  } catch {
    return false;
  }
  if (!raw) return false;
  let dirty = false;
  const seen = new Set(conv.touchedAbsFiles);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (typeof rec.abs === 'string' && rec.abs) {
        if (!seen.has(rec.abs)) {
          seen.add(rec.abs);
          conv.touchedAbsFiles.push(rec.abs);
        }
        dirty = true;
      }
      if (rec.isPlan && rec.planHash) {
        if (rec.abs && !conv.planFiles.includes(rec.abs)) {
          conv.planFiles = conv.planFiles.concat(rec.abs).slice(-10);
        }
        conv.pendingPlanHash = rec.planHash;
        if (rec.planReason) conv.pendingPlanReason = rec.planReason;
        if (rec.suggestedPlanHash) conv.lastSuggestedPlanHash = rec.suggestedPlanHash;
        dirty = true;
      }
    } catch {}
  }
  if (conv.touchedAbsFiles.length > 120) {
    conv.touchedAbsFiles = conv.touchedAbsFiles.slice(-120);
  }
  return dirty;
}

function clearTouchLog(touchLogFile) {
  if (!touchLogFile) return;
  try {
    fs.rmSync(touchLogFile, { force: true });
  } catch {}
}

function parsePorcelainZ(bufText) {
  const rels = [];
  const parts = String(bufText || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const status = rec.slice(0, 2);
    const rel = rec.slice(3);
    if (rel) rels.push(rel);
    if ((status[0] === 'R' || status[0] === 'C') && i + 1 < parts.length) {
      i += 1;
    }
  }
  return rels;
}

function parseNumstatLines(text) {
  const byRel = new Map();
  let total = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const a = parseInt(cols[0], 10);
    const d = parseInt(cols[1], 10);
    const sum = (Number.isFinite(a) ? a : 0) + (Number.isFinite(d) ? d : 0);
    total += sum;
    const rel = cols.slice(2).join('\t').trim();
    if (rel) byRel.set(rel, (byRel.get(rel) || 0) + sum);
  }
  return { byRel, total };
}

function resolveEffectiveGitRoot(touchedAbsFiles, fallbackCwd = '') {
  if (Array.isArray(touchedAbsFiles)) {
    for (let i = touchedAbsFiles.length - 1; i >= 0; i--) {
      const p = touchedAbsFiles[i];
      if (!p) continue;
      const root = findGitRootSync(p);
      if (root) return root;
    }
  }
  return findGitRootSync(fallbackCwd || '');
}

function inspectGitSummary(gitRoot) {
  if (!gitRoot || !fs.existsSync(gitRoot)) {
    return {
      gitRoot: '',
      changedAbsFiles: [],
      changedRelByAbs: {},
      perFileLines: {},
      changedFiles: 0,
      changedLines: 0,
      gitHighRisk: [],
      diffHash: sha1Short(''),
    };
  }
  const deadline = Date.now() + GIT_DEADLINE_MS;
  const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const execGit = (args) => {
    const rem = deadline - Date.now();
    if (rem < 150) return null;
    try {
      return execFileSync('git', ['-C', gitRoot, ...args], {
        encoding: 'utf8',
        timeout: Math.min(1500, rem),
        maxBuffer: 256 * 1024,
        windowsHide: true,
        env: gitEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };

  const statusZ = execGit(['status', '--porcelain', '-z']);
  if (statusZ === null) {
    return {
      gitRoot,
      changedAbsFiles: [],
      changedRelByAbs: {},
      perFileLines: {},
      changedFiles: 0,
      changedLines: 0,
      gitHighRisk: [],
      diffHash: sha1Short('git-timeout'),
    };
  }

  let numstat = execGit(['diff', 'HEAD', '--numstat']);
  if (numstat === null) numstat = execGit(['diff', '--cached', '--numstat']) || '';

  const relList = parsePorcelainZ(statusZ);
  const { byRel, total } = parseNumstatLines(numstat);

  const changedAbsFiles = [];
  const changedRelByAbs = {};
  const perFileLines = {};
  const gitHighRisk = [];
  const seenAbs = new Set();

  for (const rel of relList) {
    const abs = realpathSafe(path.join(gitRoot, rel));
    if (!seenAbs.has(abs)) {
      seenAbs.add(abs);
      changedAbsFiles.push(abs);
    }
    const cleanRel = rel.split(path.sep).join('/');
    changedRelByAbs[abs] = cleanRel;
    if (byRel.has(rel)) perFileLines[abs] = byRel.get(rel);
    if (HIGH_RISK_PATH_RE.test(cleanRel) && !gitHighRisk.includes(cleanRel)) gitHighRisk.push(cleanRel);
  }
  for (const [rel, lines] of byRel.entries()) {
    const abs = realpathSafe(path.join(gitRoot, rel));
    perFileLines[abs] = lines;
    if (!seenAbs.has(abs)) {
      seenAbs.add(abs);
      changedAbsFiles.push(abs);
      changedRelByAbs[abs] = rel.split(path.sep).join('/');
    }
  }

  return {
    gitRoot,
    changedAbsFiles,
    changedRelByAbs,
    perFileLines,
    changedFiles: changedAbsFiles.length,
    changedLines: total,
    gitHighRisk,
    diffHash: sha1Short(`${statusZ}\n--\n${numstat}`),
  };
}

function getProposalPath(proposalsDir, cid) {
  return path.join(proposalsDir, `${path.basename(cid)}.json`);
}

function writeProposalFile(proposalsDir, cid, proposalObj, pruneOpts = {}) {
  if (!cid || !proposalsDir) return;
  writeAtomicJson(getProposalPath(proposalsDir, cid), proposalObj);
  pruneDirFiles(proposalsDir, pruneOpts);
}

function removeProposalFile(proposalsDir, cid) {
  if (!cid || !proposalsDir) return;
  try {
    fs.rmSync(getProposalPath(proposalsDir, cid), { force: true });
  } catch {}
}

function persistConvState(convFile, conv, touchLogFile, pluginDataDir, pruneOpts = {}) {
  if (!convFile) return;
  writeAtomicJson(convFile, conv);
  clearTouchLog(touchLogFile);
  pruneDirFiles(pluginDataDir, pruneOpts);
}

function computeAttribution(conv, git, { injectedSummary = false } = {}) {
  const root = git.gitRoot || '';
  if (Array.isArray(git.changedAbsFiles)) {
    const gitSet = new Set(git.changedAbsFiles.map((p) => realpathSafe(p)));
    const attributedAbs = [];
    const attributedRel = [];
    const highRiskRel = [];
    let stopLines = 0;

    for (const rawAbs of conv.touchedAbsFiles) {
      const abs = realpathSafe(rawAbs);
      if (!gitSet.has(abs)) continue;
      attributedAbs.push(abs);
      const rel = sanitizePathDisplay(
        (git.changedRelByAbs && git.changedRelByAbs[abs]) || normalizeRelPath(abs, root) || abs
      );
      attributedRel.push(rel);
      stopLines += Number(git.perFileLines?.[abs] || 0);
      if (HIGH_RISK_PATH_RE.test(rel) && !highRiskRel.includes(rel)) {
        highRiskRel.push(rel);
      }
    }
    return {
      stopFiles: attributedAbs.length,
      stopLines,
      highRiskRel,
      attributedRel,
    };
  }

  // Legacy injected unit-test summary fallback without changedAbsFiles:
  // still enforce strict conversation attribution (0 touched files -> never fires risk/stop).
  if (!injectedSummary || conv.touchedAbsFiles.length === 0) {
    return { stopFiles: 0, stopLines: 0, highRiskRel: [], attributedRel: [] };
  }
  const touchedRel = conv.touchedAbsFiles.map((abs) =>
    sanitizePathDisplay(normalizeRelPath(abs, root) || path.basename(abs))
  );
  const gitHigh = Array.isArray(git.gitHighRisk) ? git.gitHighRisk.map((p) => sanitizePathDisplay(p)) : [];
  const highRiskSet = new Set([...touchedRel.filter((p) => HIGH_RISK_PATH_RE.test(p)), ...gitHigh]);
  return {
    stopFiles: Number(git.changedFiles || 0),
    stopLines: Number(git.changedLines || 0),
    highRiskRel: Array.from(highRiskSet).slice(0, 12),
    attributedRel: touchedRel,
  };
}

function buildProposalRecord({
  kind,
  source = 'hook',
  reason,
  diffHash = '',
  changedFiles = 0,
  changedLines = 0,
  highRiskFiles = [],
  planFiles = [],
  worktreeRoot = '',
  conv,
  quota,
  quotaPolicy,
  now,
}) {
  return {
    kind,
    source,
    reason: sanitizePromptText(reason, 220),
    diffHash,
    changedFiles,
    changedLines,
    highRiskFiles: highRiskFiles.map((f) => sanitizePathDisplay(f)).filter(Boolean),
    planFiles: planFiles.map((f) => sanitizePathDisplay(f)).filter(Boolean),
    worktreeRoot: worktreeRoot ? sanitizePathDisplay(worktreeRoot) : '',
    consecutiveErrors: conv.consecutiveErrors,
    lastErrorSig: sanitizePromptText(conv.lastErrorSig, 160),
    recommendedTier: quotaPolicy.recommendedTier,
    quotaBlocked: !quotaPolicy.healthy,
    claude5hPct: quota.claude5hPct,
    claudeWeeklyPct: quota.claudeWeeklyPct,
    ts: now,
    dismissed: false,
  };
}

/**
 * Evaluate a single Antigravity lifecycle hook payload synchronously.
 * Accepts optional path/clock overrides via `opts` for isolated unit tests.
 */
export function evaluateHookEvent(payload = {}, opts = {}) {
  if (!payload || typeof payload !== 'object') return {};
  if (/opus/i.test(String(payload.modelName || ''))) return {};

  const { prefsFile, quotaFile, proposalsDir, pluginDataDir } = resolvePaths(opts);
  const prefs = loadPrefs(prefsFile);
  if (prefs.opusGateMode === 'off') return {};

  const cid = getSafeCid(payload.conversationId);
  if (!cid) return {};

  const { convFile, touchLogFile, conv, hadLog } = loadConvState(pluginDataDir, cid);
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const event = String(payload.hookEventName || '');
  const quota = resolveQuotaSnapshot(quotaFile);

  if (event === 'PostToolUse') {
    const toolName = String(payload.toolCall?.name || '').trim();
    if (toolName === 'run_command') {
      const errText = typeof payload.error === 'string' ? payload.error.trim() : '';
      if (errText) {
        conv.consecutiveErrors += 1;
        conv.lastErrorSig = sanitizePromptText(errText.split(/\r?\n/)[0], 160);
        if (prefs.opusGateCheckpoints.debug && conv.consecutiveErrors >= 2) {
          const qp = evaluateQuotaPolicy(prefs, quota, 'debug');
          const gitRoot = resolveEffectiveGitRoot(conv.touchedAbsFiles, payload.cwd || '');
          writeProposalFile(
            proposalsDir,
            cid,
            buildProposalRecord({
              kind: 'debug',
              source: 'hook',
              reason: `Consecutive command failures (${conv.consecutiveErrors})`,
              changedFiles: conv.touchedAbsFiles.length,
              highRiskFiles: conv.touchedAbsFiles
                .map((p) => normalizeRelPath(p, gitRoot) || p)
                .filter((r) => HIGH_RISK_PATH_RE.test(r))
                .slice(0, 10),
              worktreeRoot: gitRoot,
              conv,
              quota,
              quotaPolicy: qp,
              now,
            })
          );
        }
      } else {
        conv.consecutiveErrors = 0;
        conv.lastErrorSig = '';
      }
      persistConvState(convFile, conv, touchLogFile, pluginDataDir);
      return {};
    }

    if (toolName === 'exit_plan_mode') {
      const args = payload.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
      const planHash = sha1Short(`exit_plan_mode:${String(args.plan || '').slice(0, 4000)}`);
      const planReason = 'Plan finalized via exit_plan_mode';
      let suggestedPlanHash = '';
      if (prefs.opusGateCheckpoints.plan && prefs.opusGateMode === 'semi') {
        const curProp = readJsonSafe(getProposalPath(proposalsDir, cid), null);
        if (curProp?.diffHash !== planHash && conv.lastSuggestedPlanHash !== planHash) {
          const qp = evaluateQuotaPolicy(prefs, quota, 'plan');
          const gitRoot = resolveEffectiveGitRoot(conv.touchedAbsFiles, payload.cwd || '');
          writeProposalFile(
            proposalsDir,
            cid,
            buildProposalRecord({
              kind: 'plan',
              source: 'hook',
              reason: planReason,
              diffHash: planHash,
              changedFiles: conv.touchedAbsFiles.length,
              planFiles: conv.planFiles.map((p) => normalizeRelPath(p, gitRoot) || p).slice(0, 5),
              worktreeRoot: gitRoot,
              conv,
              quota,
              quotaPolicy: qp,
              now,
            })
          );
          suggestedPlanHash = planHash;
        }
      }
      fs.mkdirSync(pluginDataDir, { recursive: true });
      fs.appendFileSync(
        touchLogFile,
        `${JSON.stringify({ abs: '', isPlan: true, planHash, planReason, suggestedPlanHash })}\n`,
        'utf8'
      );
      return {};
    }

    if (toolName === 'edit_file' || toolName === 'write_file') {
      const args = payload.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
      const rawFile = args.Path || args.path || args.TargetFile || args.AbsolutePath || '';
      const absPath = resolveAbsPath(rawFile, payload.cwd || '');
      const isPlan = Boolean(args.ArtifactMetadata?.RequestFeedback) || (absPath ? PLAN_PATH_RE.test(absPath) : false);
      if (!absPath && !isPlan) return {};

      const planBody = isPlan ? String(args.Content ?? args.Replacement ?? '').slice(0, 4000) : '';
      const planHash = isPlan ? sha1Short(`${absPath || 'plan'}:${planBody}`) : '';
      const planReason = isPlan
        ? absPath
          ? `Plan artifact updated (${sanitizePathDisplay(path.basename(absPath))})`
          : 'Plan artifact ready for review'
        : '';

      let suggestedPlanHash = '';
      if (isPlan && prefs.opusGateCheckpoints.plan && prefs.opusGateMode === 'semi') {
        const curProp = readJsonSafe(getProposalPath(proposalsDir, cid), null);
        if (curProp?.diffHash !== planHash && conv.lastSuggestedPlanHash !== planHash) {
          const qp = evaluateQuotaPolicy(prefs, quota, 'plan');
          const gitRoot = findGitRootSync(absPath || payload.cwd || '');
          const dispPlan = absPath ? normalizeRelPath(absPath, gitRoot) || absPath : '';
          const planList = Array.from(
            new Set([
              ...conv.planFiles.map((p) => normalizeRelPath(p, gitRoot) || p),
              ...(dispPlan ? [dispPlan] : []),
            ])
          ).slice(-5);
          writeProposalFile(
            proposalsDir,
            cid,
            buildProposalRecord({
              kind: 'plan',
              source: 'hook',
              reason: planReason,
              diffHash: planHash,
              changedFiles: conv.touchedAbsFiles.length,
              planFiles: planList,
              worktreeRoot: gitRoot,
              conv,
              quota,
              quotaPolicy: qp,
              now,
            })
          );
          suggestedPlanHash = planHash;
        }
      }
      fs.mkdirSync(pluginDataDir, { recursive: true });
      fs.appendFileSync(
        touchLogFile,
        `${JSON.stringify({ abs: absPath, isPlan, planHash, planReason, suggestedPlanHash })}\n`,
        'utf8'
      );
      return {};
    }
    return {};
  }

  if (event === 'Stop') {
    if (payload.terminationReason !== 'NO_TOOL_CALL' || payload.continuationActive === true) {
      if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
      return {};
    }

    const effectiveGitRoot = resolveEffectiveGitRoot(conv.touchedAbsFiles, payload.cwd || '');
    const git = opts.gitSummary || inspectGitSummary(effectiveGitRoot);
    if (!git.gitRoot && effectiveGitRoot) git.gitRoot = effectiveGitRoot;

    const attr = computeAttribution(conv, git, { injectedSummary: Boolean(opts.gitSummary) });
    const riskHash = attr.highRiskRel.length ? sha1Short(attr.highRiskRel.slice().sort().join('\n')) : '';

    const planPending = Boolean(conv.pendingPlanHash);
    const existingSemiPlan =
      prefs.opusGateMode === 'semi' ? readJsonSafe(getProposalPath(proposalsDir, cid), null) : null;
    const planEligible =
      prefs.opusGateCheckpoints.plan &&
      planPending &&
      ((prefs.opusGateMode === 'auto' && conv.lastAuditedPlanHash !== conv.pendingPlanHash) ||
        (prefs.opusGateMode === 'semi' &&
          conv.lastSuggestedPlanHash !== conv.pendingPlanHash &&
          existingSemiPlan?.diffHash !== conv.pendingPlanHash));

    const riskNotSeen =
      prefs.opusGateMode === 'auto'
        ? conv.lastAuditedRiskHash !== riskHash
        : conv.lastSuggestedRiskHash !== riskHash;
    const riskEligible =
      prefs.opusGateCheckpoints.risk && attr.stopFiles > 0 && attr.highRiskRel.length > 0 && riskNotSeen;

    const prevStopFiles = prefs.opusGateMode === 'auto' ? conv.lastAuditedStopFiles : conv.lastSuggestedStopFiles;
    const prevStopLines = prefs.opusGateMode === 'auto' ? conv.lastAuditedStopLines : conv.lastSuggestedStopLines;
    const stopEligible =
      prefs.opusGateCheckpoints.stop &&
      attr.stopFiles > 0 &&
      (attr.stopFiles - prevStopFiles >= 3 || attr.stopLines - prevStopLines >= 120);

    let kind = '';
    let reason = '';
    if (prefs.opusGateCheckpoints.debug && conv.consecutiveErrors >= 2) {
      kind = 'debug';
      reason = `Consecutive command failures (${conv.consecutiveErrors})`;
    } else if (planEligible) {
      kind = 'plan';
      reason = conv.pendingPlanReason || 'Plan artifact ready for review';
    } else if (riskEligible) {
      kind = 'risk';
      reason = `High-risk file changes (${attr.highRiskRel.slice(0, 3).join(', ')})`;
    } else if (stopEligible) {
      kind = 'stop';
      reason = `Substantial workspace diff (${attr.stopFiles} files, ${attr.stopLines} lines)`;
    }

    if (!kind) {
      if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
      return {};
    }

    const quotaPolicy = evaluateQuotaPolicy(prefs, quota, kind);
    const canAutoContinue =
      prefs.opusGateMode === 'auto' &&
      quotaPolicy.healthy &&
      conv.autoCalls < prefs.opusGateMaxAutoPerSession;

    const planDisplayList = conv.planFiles
      .map((p) => sanitizePathDisplay(normalizeRelPath(p, effectiveGitRoot) || p))
      .filter(Boolean)
      .slice(-5);

    if (canAutoContinue) {
      conv.autoCalls += 1;
      if (kind === 'plan') {
        conv.lastAuditedPlanHash = conv.pendingPlanHash;
        conv.pendingPlanHash = '';
        conv.pendingPlanReason = '';
      } else {
        if (riskHash) conv.lastAuditedRiskHash = riskHash;
        conv.lastAuditedStopFiles = Math.max(conv.lastAuditedStopFiles, attr.stopFiles);
        conv.lastAuditedStopLines = Math.max(conv.lastAuditedStopLines, attr.stopLines);
      }
      persistConvState(convFile, conv, touchLogFile, pluginDataDir);
      removeProposalFile(proposalsDir, cid);

      const safeReason = sanitizePromptText(reason, 200);
      const wtNote = effectiveGitRoot ? ` Worktree: ${sanitizePathDisplay(effectiveGitRoot)}.` : '';
      const planNote = kind === 'plan' && planDisplayList.length ? ` Plan artifacts: ${planDisplayList.join(', ')}.` : '';
      const riskNote =
        kind !== 'plan' && attr.highRiskRel.length ? ` High-risk files: ${attr.highRiskRel.slice(0, 5).join(', ')}.` : '';
      const forkNote =
        kind === 'debug' ? ' You may use fork: "coordinator" if warm error context is needed.' : ' Omit fork to keep context compact.';
      return {
        decision: 'continue',
        reason:
          `[MAGA Opus Gate · ${kind}] ${safeReason}.${wtNote}${planNote}${riskNote} ` +
          `Load the \`opus-gate\` skill and invoke \`swarm\` with one read-only Claude Opus (${quotaPolicy.recommendedTier}) worker \`opus-gate\`.${forkNote} ` +
          `Instruct it to post \`@coordinator [done]\` with Verdict (APPROVE/REVISE/HOLD) and P0/P1/P2 findings.`,
      };
    }

    const diffHash = kind === 'plan' ? conv.pendingPlanHash : kind === 'risk' ? riskHash : git.diffHash || '';
    writeProposalFile(
      proposalsDir,
      cid,
      buildProposalRecord({
        kind,
        source: 'hook',
        reason,
        diffHash,
        changedFiles: attr.stopFiles,
        changedLines: attr.stopLines,
        highRiskFiles: attr.highRiskRel,
        planFiles: kind === 'plan' ? planDisplayList : [],
        worktreeRoot: effectiveGitRoot,
        conv,
        quota,
        quotaPolicy,
        now,
      })
    );

    if (kind === 'plan') {
      conv.lastSuggestedPlanHash = conv.pendingPlanHash;
    } else {
      if (riskHash) conv.lastSuggestedRiskHash = riskHash;
      conv.lastSuggestedStopFiles = Math.max(conv.lastSuggestedStopFiles, attr.stopFiles);
      conv.lastSuggestedStopLines = Math.max(conv.lastSuggestedStopLines, attr.stopLines);
    }
    persistConvState(convFile, conv, touchLogFile, pluginDataDir);
    return {};
  }

  return {};
}

/**
 * Evaluate a model-initiated semantic checkpoint request before calling `swarm`.
 * Enforces user mode (`off`/`semi`/`auto`), checkpoint switches, quota thresholds & per-session auto cap.
 */
export function evaluatePreflight(params = {}, opts = {}) {
  const rawKind = String(params?.kind || '').trim().toLowerCase();
  const kind = VALID_KINDS.has(rawKind) ? rawKind : 'review';
  if (/opus/i.test(String(params?.model || ''))) {
    return { action: 'skip', reason: 'already_opus' };
  }

  const { prefsFile, quotaFile, proposalsDir, pluginDataDir } = resolvePaths(opts);
  const prefs = loadPrefs(prefsFile);
  if (prefs.opusGateMode === 'off') {
    return { action: 'skip', reason: 'mode_off', mode: 'off' };
  }

  const cpEnabled =
    kind === 'review' ? prefs.opusGateCheckpoints.stop !== false : prefs.opusGateCheckpoints[kind] !== false;
  if (!cpEnabled) {
    return { action: 'skip', reason: 'checkpoint_disabled', kind, mode: prefs.opusGateMode };
  }

  const cid = getSafeCid(params?.cid);
  const { convFile, touchLogFile, conv, hadLog } = loadConvState(pluginDataDir, cid);
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const quota = resolveQuotaSnapshot(quotaFile);
  const quotaPolicy = evaluateQuotaPolicy(prefs, quota, kind);

  const reasonText = sanitizePromptText(params?.reason || '', 220) || `Semantic ${kind} checkpoint`;
  const fileList = (Array.isArray(params?.files) ? params.files : String(params?.files || '').split(','))
    .map((s) => sanitizePathDisplay(s))
    .filter(Boolean)
    .slice(0, 10);
  const semanticHash = sha1Short(`${kind}|${reasonText}|${fileList.join(',')}`);
  const recommendedModelId =
    quotaPolicy.recommendedTier === 'medium' ? 'claude-opus-5-5-medium' : 'claude-opus-5-5-high';
  const proposalPublished = Boolean(cid);
  const effectiveGitRoot = resolveEffectiveGitRoot(conv.touchedAbsFiles, opts.cwd || '');

  const writeSemanticProposal = () => {
    if (!cid) return;
    writeProposalFile(
      proposalsDir,
      cid,
      buildProposalRecord({
        kind,
        source: 'semantic',
        reason: reasonText,
        diffHash: semanticHash,
        changedFiles: conv.touchedAbsFiles.length,
        highRiskFiles: kind === 'plan' ? [] : fileList,
        planFiles: kind === 'plan' ? fileList : [],
        worktreeRoot: effectiveGitRoot,
        conv,
        quota,
        quotaPolicy,
        now,
      })
    );
  };

  if (prefs.opusGateMode === 'auto') {
    if (cid && conv.lastAutoSemanticHash === semanticHash) {
      if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
      return { action: 'skip', reason: 'already_audited', mode: 'auto', kind };
    }
    if (quotaPolicy.healthy && conv.autoCalls < prefs.opusGateMaxAutoPerSession) {
      conv.autoCalls += 1;
      conv.lastAutoSemanticHash = semanticHash;
      persistConvState(convFile, conv, touchLogFile, pluginDataDir);
      if (cid) removeProposalFile(proposalsDir, cid);
      return {
        action: 'run_swarm',
        mode: 'auto',
        kind,
        recommendedTier: quotaPolicy.recommendedTier,
        recommendedModelId,
        autoCallsUsed: conv.autoCalls,
        autoCallsMax: prefs.opusGateMaxAutoPerSession,
        claude5hPct: quota.claude5hPct,
        claudeWeeklyPct: quota.claudeWeeklyPct,
      };
    }

    const downgradedReason = !quotaPolicy.healthy ? 'quota_blocked' : 'auto_cap_reached';
    writeSemanticProposal();
    conv.lastSuggestedSemanticHash = semanticHash;
    persistConvState(convFile, conv, touchLogFile, pluginDataDir);
    return {
      action: 'propose',
      mode: 'auto',
      downgradedReason,
      kind,
      recommendedTier: quotaPolicy.recommendedTier,
      recommendedModelId,
      quotaBlocked: !quotaPolicy.healthy,
      proposalPublished,
      claude5hPct: quota.claude5hPct,
      claudeWeeklyPct: quota.claudeWeeklyPct,
    };
  }

  if (cid && conv.lastSuggestedSemanticHash !== semanticHash) {
    writeSemanticProposal();
    conv.lastSuggestedSemanticHash = semanticHash;
    persistConvState(convFile, conv, touchLogFile, pluginDataDir);
  } else if (hadLog) {
    persistConvState(convFile, conv, touchLogFile, pluginDataDir);
  }
  return {
    action: 'propose',
    mode: 'semi',
    kind,
    recommendedTier: quotaPolicy.recommendedTier,
    recommendedModelId,
    quotaBlocked: !quotaPolicy.healthy,
    proposalPublished,
    claude5hPct: quota.claude5hPct,
    claudeWeeklyPct: quota.claudeWeeklyPct,
  };
}

/**
 * Clear pending proposals & snapshot current risk/stop baseline after an Opus review completes.
 * Prevents immediate post-review coordinator fix-ups from re-triggering stale pills.
 */
export function clearGateState(params = {}, opts = {}) {
  const cid = getSafeCid(params?.cid);
  if (!cid) return { ok: false, error: 'invalid_cid' };

  const { proposalsDir, pluginDataDir } = resolvePaths(opts);
  removeProposalFile(proposalsDir, cid);

  const { convFile, touchLogFile, conv } = loadConvState(pluginDataDir, cid);
  if (conv.pendingPlanHash) {
    conv.lastAuditedPlanHash = conv.pendingPlanHash;
    conv.lastSuggestedPlanHash = conv.pendingPlanHash;
    conv.pendingPlanHash = '';
    conv.pendingPlanReason = '';
  }

  const effectiveGitRoot = findGitRootSync(params?.dir || '') || resolveEffectiveGitRoot(conv.touchedAbsFiles, '');
  const git = opts.gitSummary || (effectiveGitRoot ? inspectGitSummary(effectiveGitRoot) : null);
  if (git) {
    if (!git.gitRoot && effectiveGitRoot) git.gitRoot = effectiveGitRoot;
    const attr = computeAttribution(conv, git, { injectedSummary: Boolean(opts.gitSummary) });
    if (attr.highRiskRel.length > 0) {
      const riskHash = sha1Short(attr.highRiskRel.slice().sort().join('\n'));
      conv.lastAuditedRiskHash = riskHash;
      conv.lastSuggestedRiskHash = riskHash;
    }
    conv.lastAuditedStopFiles = Math.max(conv.lastAuditedStopFiles, attr.stopFiles);
    conv.lastAuditedStopLines = Math.max(conv.lastAuditedStopLines, attr.stopLines);
    conv.lastSuggestedStopFiles = Math.max(conv.lastSuggestedStopFiles, attr.stopFiles);
    conv.lastSuggestedStopLines = Math.max(conv.lastSuggestedStopLines, attr.stopLines);
  }

  persistConvState(convFile, conv, touchLogFile, pluginDataDir);
  pruneDirFiles(proposalsDir);
  return {
    ok: true,
    cid,
    clearedProposal: true,
    worktreeRoot: effectiveGitRoot || '',
  };
}

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--') || tok === '--preflight' || tok === '--clear') continue;
    const eq = tok.indexOf('=');
    let key = '';
    let val = '';
    if (eq !== -1) {
      key = tok.slice(2, eq).trim();
      val = tok.slice(eq + 1);
    } else {
      key = tok.slice(2).trim();
      if (i + 1 < argv.length && !String(argv[i + 1] || '').startsWith('--')) {
        val = argv[++i];
      }
    }
    if (key) out[key] = val;
  }
  return out;
}

function isDirectCli() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectCli()) {
  const isClear = process.argv.includes('--clear');
  const isPreflight = process.argv.includes('--preflight');
  let result = {};
  try {
    if (isClear) {
      const args = parseCliArgs(process.argv.slice(2));
      result = clearGateState({ cid: args.cid, dir: args.dir });
    } else if (isPreflight) {
      const args = parseCliArgs(process.argv.slice(2));
      result = evaluatePreflight({
        kind: args.kind,
        reason: args.reason,
        cid: args.cid,
        files: args.files,
        model: args.model,
      });
    } else {
      let payload = {};
      try {
        const raw = fs.readFileSync(0, 'utf8').trim();
        if (raw) payload = JSON.parse(raw);
      } catch {}
      result = evaluateHookEvent(payload);
    }
  } catch {
    result = isClear ? { ok: false, error: 'error' } : isPreflight ? { action: 'skip', reason: 'error' } : {};
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
