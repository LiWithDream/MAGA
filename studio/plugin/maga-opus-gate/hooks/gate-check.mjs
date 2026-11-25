/**
 * Synchronous, zero-dependency Antigravity Lifecycle Hook Sentinel for MAGA Opus Gate.
 * - Tracks consecutive command errors & touched high-risk files per conversation.
 * - Enforces dual-pool quota circuit breakers & diffHash deduplication on Stop.
 * - In `auto` mode (when healthy & within cap), returns `{ decision: 'continue', reason }`.
 * - In `semi` mode (or when circuit-broken/capped), publishes a non-blocking proposal for MAGA UI.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIGH_RISK_PATH_RE =
  /(?:^|\/)(?:kernel|dom|cdp-[^/]+|daemon|prefs-bundle|build|cli|auth|security|migration|schema)\.(?:m?js|ts|sql)$|package\.json$|hooks\.json$/i;
const SAFE_CID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const MAX_GATE_CONVERSATIONS = 24;

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

function writeAtomicJson(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
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

function evaluateQuotaPolicy(prefs, quota) {
  const healthy =
    (quota.claude5hPct === null || quota.claude5hPct >= prefs.opusGateMinQuota5hPct) &&
    (quota.claudeWeeklyPct === null || quota.claudeWeeklyPct >= prefs.opusGateMinQuotaWeeklyPct);
  const recommendedTier =
    prefs.opusGatePreferredTier === 'high' &&
    (quota.claude5hPct === null || quota.claude5hPct >= prefs.opusGateMinQuota5hPct + 15)
      ? 'high'
      : 'medium';
  return { healthy, recommendedTier };
}

function parsePorcelainStatus(text) {
  const files = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || line.length < 4) continue;
    let filePath = line.slice(3).trim();
    const arrow = filePath.indexOf(' -> ');
    if (arrow !== -1) filePath = filePath.slice(arrow + 4).trim();
    if (filePath) files.push(filePath);
  }
  return files;
}

function sumNumstatLines(text) {
  let total = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue;
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    const a = parseInt(cols[0], 10);
    const d = parseInt(cols[1], 10);
    if (Number.isFinite(a)) total += a;
    if (Number.isFinite(d)) total += d;
  }
  return total;
}

function inspectGitSummary(cwd, touchedFiles) {
  if (cwd && fs.existsSync(cwd)) {
    try {
      const execGit = (args) =>
        execFileSync('git', ['-C', cwd, ...args], {
          encoding: 'utf8',
          timeout: 1500,
          maxBuffer: 128 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      const status = execGit(['status', '--porcelain']);
      const numstat = execGit(['diff', '--numstat']);
      const cached = execGit(['diff', '--cached', '--numstat']);
      const statusFiles = parsePorcelainStatus(status);
      const changedFiles = statusFiles.length;
      const changedLines = sumNumstatLines(numstat) + sumNumstatLines(cached);
      const gitHighRisk = statusFiles.filter((f) => HIGH_RISK_PATH_RE.test(f));
      const diffHash = crypto
        .createHash('sha1')
        .update(`${status}\n--\n${numstat}\n--\n${cached}`)
        .digest('hex')
        .slice(0, 16);
      return { changedFiles, changedLines, gitHighRisk, diffHash };
    } catch {}
  }
  const uniqueTouched = Array.isArray(touchedFiles) ? Array.from(new Set(touchedFiles)) : [];
  const diffHash = crypto.createHash('sha1').update(uniqueTouched.join('\n')).digest('hex').slice(0, 16);
  return {
    changedFiles: uniqueTouched.length,
    changedLines: 0,
    gitHighRisk: uniqueTouched.filter((f) => HIGH_RISK_PATH_RE.test(f)),
    diffHash,
  };
}

function upsertGateProposal(gateStateFile, cid, proposalObj) {
  if (!cid || !SAFE_CID_RE.test(cid)) return;
  const raw = readJsonSafe(gateStateFile, null);
  const convs =
    raw && typeof raw.conversations === 'object' && !Array.isArray(raw.conversations)
      ? { ...raw.conversations }
      : {};
  if (proposalObj === null) {
    delete convs[cid];
  } else {
    convs[cid] = proposalObj;
  }
  const trimmed = Object.entries(convs)
    .filter(([k, v]) => SAFE_CID_RE.test(k) && v && typeof v === 'object')
    .sort((a, b) => Number(a[1]?.ts || 0) - Number(b[1]?.ts || 0))
    .slice(-MAX_GATE_CONVERSATIONS);
  writeAtomicJson(gateStateFile, { schema: 1, conversations: Object.fromEntries(trimmed) });
}

function normalizeRelPath(rawPath, cwd) {
  const s = String(rawPath || '').trim();
  if (!s) return '';
  if (cwd && path.isAbsolute(s)) {
    const rel = path.relative(cwd, s);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return s;
}

function defaultConvState() {
  return {
    consecutiveErrors: 0,
    lastErrorSig: '',
    touchedFiles: [],
    highRiskFiles: [],
    autoCalls: 0,
    lastAuditedDiffHash: '',
    lastSuggestedDiffHash: '',
  };
}

/**
 * Evaluate a single Antigravity lifecycle hook payload synchronously.
 * Accepts optional path/clock overrides via `opts` for isolated unit tests.
 */
export function evaluateHookEvent(payload = {}, opts = {}) {
  if (!payload || typeof payload !== 'object') return {};
  if (/opus/i.test(String(payload.modelName || ''))) return {};

  const stateDir =
    opts.stateDir ||
    process.env.ANTI_CLAUDE_STATE_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'anti-claude');
  const prefsFile = opts.studioPrefsFile || path.join(stateDir, 'studio-prefs.json');
  const quotaFile = opts.quotaStateFile || path.join(stateDir, 'quota-state.json');
  const gateStateFile = opts.gateStateFile || path.join(stateDir, 'opus-gate-state.json');
  const pluginDataDir = opts.pluginDataDir || process.env.PLUGIN_DATA || path.join(stateDir, 'opus-gate-data');

  const prefs = loadPrefs(prefsFile);
  if (prefs.opusGateMode === 'off') return {};

  const rawCid = typeof payload.conversationId === 'string' ? payload.conversationId.trim() : '';
  const safeCid = SAFE_CID_RE.test(rawCid) ? rawCid : 'default';
  const convFile = path.join(pluginDataDir, `${safeCid}.json`);
  const conv = { ...defaultConvState(), ...(readJsonSafe(convFile, null) || {}) };
  if (!Array.isArray(conv.touchedFiles)) conv.touchedFiles = [];
  if (!Array.isArray(conv.highRiskFiles)) conv.highRiskFiles = [];

  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const event = String(payload.hookEventName || '');
  const quota = resolveQuotaSnapshot(quotaFile);
  const quotaPolicy = evaluateQuotaPolicy(prefs, quota);

  if (event === 'PostToolUse') {
    const toolName = String(payload.toolCall?.name || '').trim();
    if (toolName === 'run_command') {
      const errText = typeof payload.error === 'string' ? payload.error.trim() : '';
      if (errText) {
        conv.consecutiveErrors += 1;
        conv.lastErrorSig = errText.split(/\r?\n/)[0].slice(0, 160);
        if (prefs.opusGateCheckpoints.debug && conv.consecutiveErrors >= 2 && SAFE_CID_RE.test(rawCid)) {
          upsertGateProposal(gateStateFile, rawCid, {
            kind: 'debug',
            reason: `Consecutive command failures (${conv.consecutiveErrors})`,
            diffHash: '',
            changedFiles: conv.touchedFiles.length,
            changedLines: 0,
            highRiskFiles: conv.highRiskFiles.slice(0, 10),
            consecutiveErrors: conv.consecutiveErrors,
            lastErrorSig: conv.lastErrorSig,
            recommendedTier: quotaPolicy.recommendedTier,
            quotaBlocked: !quotaPolicy.healthy,
            claude5hPct: quota.claude5hPct,
            claudeWeeklyPct: quota.claudeWeeklyPct,
            ts: now,
            dismissed: false,
          });
        }
      } else {
        conv.consecutiveErrors = 0;
        conv.lastErrorSig = '';
      }
      writeAtomicJson(convFile, conv);
      return {};
    }

    if (toolName === 'edit_file' || toolName === 'write_file') {
      const args = payload.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
      const rel = normalizeRelPath(args.Path || args.path || args.TargetFile || '', payload.cwd || '');
      if (rel) {
        if (!conv.touchedFiles.includes(rel)) {
          conv.touchedFiles = conv.touchedFiles.concat(rel).slice(-50);
        }
        if (HIGH_RISK_PATH_RE.test(rel) && !conv.highRiskFiles.includes(rel)) {
          conv.highRiskFiles = conv.highRiskFiles.concat(rel).slice(-30);
        }
        writeAtomicJson(convFile, conv);
      }
      return {};
    }
    return {};
  }

  if (event === 'Stop') {
    if (payload.terminationReason !== 'NO_TOOL_CALL' || payload.continuationActive === true) {
      return {};
    }
    const git = opts.gitSummary || inspectGitSummary(payload.cwd || '', conv.touchedFiles);
    const mergedHighRisk = Array.from(new Set([...(conv.highRiskFiles || []), ...(git.gitHighRisk || [])])).slice(0, 12);

    let kind = '';
    let reason = '';
    if (prefs.opusGateCheckpoints.debug && conv.consecutiveErrors >= 2) {
      kind = 'debug';
      reason = `Consecutive command failures (${conv.consecutiveErrors})`;
    } else if (prefs.opusGateCheckpoints.risk && mergedHighRisk.length > 0 && git.changedFiles > 0) {
      kind = 'risk';
      reason = `High-risk file changes (${mergedHighRisk.slice(0, 3).join(', ')})`;
    } else if (prefs.opusGateCheckpoints.stop && (git.changedFiles >= 3 || git.changedLines >= 120)) {
      kind = 'stop';
      reason = `Substantial workspace diff (${git.changedFiles} files, ${git.changedLines} lines)`;
    }

    if (!kind) return {};

    const isDiffBased = kind === 'risk' || kind === 'stop';
    if (isDiffBased && git.diffHash) {
      if (prefs.opusGateMode === 'auto' && conv.lastAuditedDiffHash === git.diffHash) return {};
      if (prefs.opusGateMode === 'semi' && conv.lastSuggestedDiffHash === git.diffHash) return {};
    }

    const canAutoContinue =
      prefs.opusGateMode === 'auto' &&
      quotaPolicy.healthy &&
      conv.autoCalls < prefs.opusGateMaxAutoPerSession;

    if (canAutoContinue) {
      conv.autoCalls += 1;
      if (git.diffHash) conv.lastAuditedDiffHash = git.diffHash;
      writeAtomicJson(convFile, conv);
      if (SAFE_CID_RE.test(rawCid)) upsertGateProposal(gateStateFile, rawCid, null);

      const riskNote = mergedHighRisk.length ? ` High-risk files: ${mergedHighRisk.slice(0, 5).join(', ')}.` : '';
      const forkNote = kind === 'debug' ? ' You may use fork: "coordinator" if warm error context is needed.' : ' Omit fork to keep context compact.';
      return {
        decision: 'continue',
        reason:
          `[MAGA Opus Gate · ${kind}] ${reason}.${riskNote} ` +
          `Load the \`opus-gate\` skill and invoke \`swarm\` with one read-only Claude Opus (${quotaPolicy.recommendedTier}) worker \`opus-gate\`.${forkNote} ` +
          `Instruct it to post \`@coordinator [done]\` with Verdict (APPROVE/REVISE/HOLD) and P0/P1/P2 findings.`,
      };
    }

    if (SAFE_CID_RE.test(rawCid)) {
      upsertGateProposal(gateStateFile, rawCid, {
        kind,
        reason,
        diffHash: git.diffHash || '',
        changedFiles: git.changedFiles,
        changedLines: git.changedLines,
        highRiskFiles: mergedHighRisk,
        consecutiveErrors: conv.consecutiveErrors,
        lastErrorSig: conv.lastErrorSig,
        recommendedTier: quotaPolicy.recommendedTier,
        quotaBlocked: !quotaPolicy.healthy,
        claude5hPct: quota.claude5hPct,
        claudeWeeklyPct: quota.claudeWeeklyPct,
        ts: now,
        dismissed: false,
      });
    }
    if (git.diffHash) conv.lastSuggestedDiffHash = git.diffHash;
    writeAtomicJson(convFile, conv);
    return {};
  }

  return {};
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
  let payload = {};
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (raw) payload = JSON.parse(raw);
  } catch {}
  let result = {};
  try {
    result = evaluateHookEvent(payload);
  } catch {
    result = {};
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
