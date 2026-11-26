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

export const GATE_DEFAULT_PREFS = Object.freeze({
  opusGateMode: 'semi',
  opusGateModel: 'opus',
  opusGateMinQuota5hPct: 20,
  opusGateMinQuotaWeeklyPct: 15,
  opusGateMaxAutoPerSession: 2,
  opusGateCheckpoints: Object.freeze({ plan: true, risk: true, debug: true, stop: true }),
});
const DEFAULT_PREFS = GATE_DEFAULT_PREFS;

const REVIEWER_MODELS = Object.freeze({
  opus: Object.freeze({
    key: 'opus',
    modelId: 'claude-opus-5-5-high',
    workerName: 'review-opus',
    label: 'Claude Opus 5.5 (High)',
    pool: 'claude',
  }),
  carbon: Object.freeze({
    key: 'carbon',
    modelId: 'gemini-4-carbon-high',
    workerName: 'review-carbon',
    label: 'Gemini 4 Carbon (High)',
    pool: 'gemini',
  }),
});

export function resolveReviewerSpec(rawModel) {
  const s = typeof rawModel === 'string' ? rawModel.trim().toLowerCase() : '';
  return s === 'carbon' ? REVIEWER_MODELS.carbon : REVIEWER_MODELS.opus;
}

export function isSelfOrHigherModel(reviewerKey, currentModelName) {
  const m = String(currentModelName || '').trim();
  if (!m) return false;
  if (resolveReviewerSpec(reviewerKey).key === 'carbon') {
    return /carbon|opus/i.test(m);
  }
  return /opus/i.test(m);
}

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
    opusGateModel: ['carbon', 'opus'].includes(raw.opusGateModel)
      ? raw.opusGateModel
      : DEFAULT_PREFS.opusGateModel,
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
  const gemini = raw && typeof raw.gemini === 'object' ? raw.gemini : {};
  const toPct = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  };
  return {
    claude5hPct: toPct(claude.fiveHourRemainingPct),
    claudeWeeklyPct: toPct(claude.weeklyRemainingPct),
    gemini5hPct: toPct(gemini.fiveHourRemainingPct),
    geminiWeeklyPct: toPct(gemini.weeklyRemainingPct),
  };
}

function evaluateQuotaPolicy(prefs, quota) {
  const spec = resolveReviewerSpec(prefs.opusGateModel);
  const pool5hPct = spec.pool === 'gemini' ? quota.gemini5hPct : quota.claude5hPct;
  const poolWeeklyPct = spec.pool === 'gemini' ? quota.geminiWeeklyPct : quota.claudeWeeklyPct;
  const healthy =
    (pool5hPct === null || pool5hPct >= prefs.opusGateMinQuota5hPct) &&
    (poolWeeklyPct === null || poolWeeklyPct >= prefs.opusGateMinQuotaWeeklyPct);
  return {
    healthy,
    recommendedTier: 'high',
    reviewerModel: spec.key,
    recommendedModelId: spec.modelId,
    workerName: spec.workerName,
    label: spec.label,
    quotaPool: spec.pool,
    pool5hPct,
    poolWeeklyPct,
  };
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
    blockingPlanHash: '',
    acknowledgedPlanHash: '',
    lastAuditedRiskHash: '',
    lastSuggestedRiskHash: '',
    lastAuditedStopFiles: 0,
    lastAuditedStopLines: 0,
    lastSuggestedStopFiles: 0,
    lastSuggestedStopLines: 0,
    blockingLandingHash: '',
    acknowledgedLandingHash: '',
    lastAuditedLandingHash: '',
    activeReviewWorker: '',
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

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--exec-path',
  '--config-env',
]);
const GIT_MERGE_VALUE_FLAGS = new Set([
  '-m',
  '--message',
  '-F',
  '--file',
  '-s',
  '--strategy',
  '-X',
  '--strategy-option',
  '--into-name',
  '--cleanup',
]);

function stripHeredocBodies(cmd) {
  const src = String(cmd || '');
  if (!src.includes('<<')) return src;
  const lines = src.split(/\r?\n/);
  const out = [];
  const pendingDelims = [];

  for (const line of lines) {
    if (pendingDelims.length > 0) {
      const cur = pendingDelims[0];
      const check = cur.stripTabs ? line.replace(/^\t+/, '') : line;
      if (check === cur.delim) {
        pendingDelims.shift();
      }
      continue;
    }
    out.push(line);
    let quote = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote === "'") {
        if (ch === "'") quote = '';
        continue;
      }
      if (quote === '"') {
        if (ch === '\\' && i + 1 < line.length) i += 1;
        else if (ch === '"') quote = '';
        continue;
      }
      if (ch === '\\' && i + 1 < line.length) {
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
        const m = line.slice(i).match(/^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))/);
        if (m) {
          const delim = m[2] || m[3] || m[4] || '';
          if (delim) pendingDelims.push({ delim, stripTabs: m[1] === '-' });
          i += m[0].length - 1;
        }
      }
    }
  }
  return out.join('\n');
}

function splitCommandSegments(cmd) {
  const segs = [];
  const src = stripHeredocBodies(cmd);
  let cur = '';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      cur += ch;
      if (ch === '\\' && i + 1 < src.length) {
        cur += src[++i];
      } else if (ch === '"') {
        quote = '';
      }
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      cur += ch + src[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if ((ch === '&' && src[i + 1] === '&') || (ch === '|' && src[i + 1] === '|')) {
      segs.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      segs.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) segs.push(cur);
  return segs;
}

function tokenizeSegment(seg) {
  const tokens = [];
  const src = String(seg || '');
  let cur = '';
  let inTok = false;
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote === "'") {
      inTok = true;
      if (ch === "'") quote = '';
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      inTok = true;
      if (ch === '\\' && i + 1 < src.length) {
        const next = src[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
          cur += next;
          i += 1;
          continue;
        }
      }
      if (ch === '"') quote = '';
      else cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inTok) {
        tokens.push(cur);
        cur = '';
        inTok = false;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      inTok = true;
      cur += src[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      inTok = true;
      quote = ch;
      continue;
    }
    inTok = true;
    cur += ch;
  }
  if (inTok) tokens.push(cur);
  return tokens;
}

function resolveCdTarget(baseDir, rawTarget) {
  const s = String(rawTarget || '').trim();
  if (!s || s === '-') return baseDir;
  let expanded = s;
  if (expanded === '~') expanded = os.homedir();
  else if (expanded.startsWith('~/') || expanded.startsWith(`~${path.sep}`)) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(baseDir || process.cwd(), expanded);
}

/**
 * Inspect a shell command string for high-impact landing operations (`git merge`, `git push`, `npm run deploy`).
 */
export function detectLandingAction(commandLine, fallbackCwd = '') {
  const raw = String(commandLine || '');
  if (!raw.trim()) return null;
  let curDir = fallbackCwd ? resolveAbsPath(fallbackCwd) || fallbackCwd : '';
  const segs = splitCommandSegments(raw);

  for (const seg of segs) {
    let tokens = tokenizeSegment(seg);
    let idx = 0;
    while (idx < tokens.length && ENV_ASSIGN_RE.test(tokens[idx])) idx += 1;
    while (idx < tokens.length && (tokens[idx] === 'env' || tokens[idx] === 'command' || tokens[idx] === 'exec')) {
      idx += 1;
      while (idx < tokens.length && (ENV_ASSIGN_RE.test(tokens[idx]) || tokens[idx] === '-u')) {
        if (tokens[idx] === '-u') idx += 1;
        idx += 1;
      }
    }
    tokens = tokens.slice(idx);
    if (tokens.length === 0) continue;

    const cmdBase = path.basename(tokens[0]);
    if (cmdBase === 'cd' || cmdBase === 'pushd') {
      let arg = '';
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === '--' && i + 1 < tokens.length) {
          arg = tokens[i + 1];
          break;
        }
        if (!tokens[i].startsWith('-')) {
          arg = tokens[i];
          break;
        }
      }
      if (arg) curDir = resolveCdTarget(curDir, arg);
      continue;
    }

    if (cmdBase === 'git') {
      let repoDir = curDir;
      let sub = '';
      let subStart = -1;
      for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok === '-C' && i + 1 < tokens.length) {
          repoDir = resolveCdTarget(curDir, tokens[++i]);
          continue;
        }
        if (tok.startsWith('-C') && tok.length > 2) {
          repoDir = resolveCdTarget(curDir, tok.slice(2));
          continue;
        }
        if (tok === '--work-tree' && i + 1 < tokens.length) {
          repoDir = resolveCdTarget(curDir, tokens[++i]);
          continue;
        }
        if (tok.startsWith('--work-tree=')) {
          repoDir = resolveCdTarget(curDir, tok.slice('--work-tree='.length));
          continue;
        }
        if (GIT_GLOBAL_VALUE_FLAGS.has(tok) && i + 1 < tokens.length) {
          i += 1;
          continue;
        }
        if (tok.startsWith('-')) continue;
        sub = tok;
        subStart = i + 1;
        break;
      }
      if (!sub) continue;
      const subArgs = tokens.slice(subStart);
      if (sub === 'merge') {
        if (subArgs.includes('--abort') || subArgs.includes('--quit')) continue;
        let sourceRef = '';
        for (let j = 0; j < subArgs.length; j++) {
          const a = subArgs[j];
          if (a === '--') {
            if (j + 1 < subArgs.length && !subArgs[j + 1].startsWith('-')) {
              sourceRef = subArgs[j + 1];
            }
            break;
          }
          if (GIT_MERGE_VALUE_FLAGS.has(a) && j + 1 < subArgs.length) {
            j += 1;
            continue;
          }
          if (a.startsWith('-')) continue;
          sourceRef = a;
          break;
        }
        return { action: 'merge', repoDir, sourceRef, label: 'git merge' };
      }
      if (sub === 'push') {
        if (subArgs.includes('--dry-run') || subArgs.includes('-n')) continue;
        return { action: 'push', repoDir, sourceRef: '', label: 'git push' };
      }
      continue;
    }

    if (cmdBase === 'npm' || cmdBase === 'pnpm' || cmdBase === 'yarn' || cmdBase === 'bun') {
      let deployDir = curDir;
      const pos = [];
      for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i];
        if ((tok === '--prefix' || tok === '-C' || tok === '--cwd') && i + 1 < tokens.length) {
          deployDir = resolveCdTarget(curDir, tokens[++i]);
          continue;
        }
        if (tok.startsWith('--prefix=')) {
          deployDir = resolveCdTarget(curDir, tok.slice('--prefix='.length));
          continue;
        }
        if (tok === '--') break;
        if (tok.startsWith('-')) continue;
        pos.push(tok);
      }
      if ((pos[0] === 'run' && pos[1] === 'deploy') || pos[0] === 'deploy') {
        const label = cmdBase === 'npm' && pos[0] === 'run' ? 'npm run deploy' : `${cmdBase} ${pos[0] === 'run' ? 'run deploy' : 'deploy'}`;
        return { action: 'deploy', repoDir: deployDir, sourceRef: '', label };
      }
    }
  }
  return null;
}

function getGitCommonDirNoSpawn(dir) {
  const root = findGitRootSync(dir);
  if (!root) return '';
  const dotGit = path.join(root, '.git');
  try {
    const st = fs.lstatSync(dotGit);
    if (st.isDirectory()) return realpathSafe(dotGit);
    if (st.isFile()) {
      const content = fs.readFileSync(dotGit, 'utf8');
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (m && m[1]) {
        const gitdir = path.resolve(root, m[1].trim());
        const commondirFile = path.join(gitdir, 'commondir');
        try {
          if (fs.existsSync(commondirFile)) {
            const relCommon = fs.readFileSync(commondirFile, 'utf8').trim();
            if (relCommon) return realpathSafe(path.resolve(gitdir, relCommon));
          }
        } catch {}
        const wtMatch = gitdir.match(/^(.*[/\\]\.git)[/\\]worktrees[/\\][^/\\]+[/\\]?$/);
        if (wtMatch) return realpathSafe(wtMatch[1]);
        return realpathSafe(gitdir);
      }
    }
  } catch {}
  return '';
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

function resolveLandingGitRoot(touchedAbsFiles, landingRepoDir, fallbackCwd = '') {
  const landingRoot = findGitRootSync(landingRepoDir || fallbackCwd || '');
  if (landingRoot) {
    const landingCommon = getGitCommonDirNoSpawn(landingRoot);
    if (landingCommon && Array.isArray(touchedAbsFiles)) {
      for (let i = touchedAbsFiles.length - 1; i >= 0; i--) {
        const p = touchedAbsFiles[i];
        if (!p) continue;
        const root = findGitRootSync(p);
        if (root && getGitCommonDirNoSpawn(root) === landingCommon) return root;
      }
    }
    return landingRoot;
  }
  return resolveEffectiveGitRoot(touchedAbsFiles, fallbackCwd);
}

function inspectGitSummary(
  gitRoot,
  { includeBranchDiff = false, mergeRepoDir = '', mergeSourceRef = '', includeUpstreamOnMain = false } = {}
) {
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
  const execGitIn = (dir, args) => {
    const rem = deadline - Date.now();
    if (rem < 150 || !dir || !fs.existsSync(dir)) return null;
    try {
      return execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        timeout: Math.min(1500, rem),
        maxBuffer: 256 * 1024,
        env: gitEnv,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };
  const execGit = (args) => execGitIn(gitRoot, args);

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
  let branchNumstat = '';
  let branchMeta = '';
  if (includeBranchDiff) {
    const safeRef =
      typeof mergeSourceRef === 'string' &&
      mergeSourceRef &&
      !/^-/.test(mergeSourceRef) &&
      !/[\u0000-\u001F\s]/.test(mergeSourceRef)
        ? mergeSourceRef
        : '';
    if (safeRef) {
      const targetRepo = mergeRepoDir && fs.existsSync(mergeRepoDir) ? mergeRepoDir : gitRoot;
      const headSha = (execGitIn(targetRepo, ['rev-parse', '--verify', '--quiet', 'HEAD']) || '').trim();
      const srcSha = (execGitIn(targetRepo, ['rev-parse', '--verify', '--quiet', safeRef]) || '').trim();
      const wtHeadSha = (execGit(['rev-parse', '--verify', '--quiet', 'HEAD']) || '').trim();
      let handledUnified = false;
      if (statusZ && wtHeadSha && srcSha && wtHeadSha === srcSha && headSha) {
        const mb = (execGit(['merge-base', headSha, 'HEAD']) || '').trim();
        const unified = mb ? execGit(['diff', '--numstat', mb, '--']) : null;
        if (unified !== null) {
          numstat = unified;
          branchMeta = `${mb}..wt(${srcSha})`;
          handledUnified = true;
        }
      }
      if (!handledUnified) {
        if (headSha && srcSha) {
          branchNumstat = execGitIn(targetRepo, ['diff', '--numstat', `${headSha}...${srcSha}`, '--']) || '';
          branchMeta = `${headSha}..${srcSha}`;
        } else if (srcSha) {
          branchNumstat = execGitIn(targetRepo, ['diff', '--numstat', `HEAD...${safeRef}`, '--']) || '';
          branchMeta = safeRef;
        }
      }
    } else {
      const curBranch = (execGit(['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
      const headSha = (execGit(['rev-parse', '--verify', '--quiet', 'HEAD']) || '').trim();
      let baseRef = '';
      if (curBranch && curBranch !== 'main' && curBranch !== 'master') {
        for (const cand of ['main', 'master', '@{upstream}']) {
          const sha = (execGit(['rev-parse', '--verify', '--quiet', cand]) || '').trim();
          if (sha && (!headSha || sha !== headSha)) {
            baseRef = cand;
            break;
          }
        }
      } else if ((curBranch === 'main' || curBranch === 'master') && includeUpstreamOnMain) {
        const upSha = (execGit(['rev-parse', '--verify', '--quiet', '@{upstream}']) || '').trim();
        if (upSha && (!headSha || upSha !== headSha)) baseRef = '@{upstream}';
      }
      if (baseRef) {
        const mb = (execGit(['merge-base', baseRef, 'HEAD']) || '').trim();
        const unified = mb ? execGit(['diff', '--numstat', mb, '--']) : null;
        if (unified !== null) {
          numstat = unified;
          branchMeta = `${baseRef}@${mb}..wt`;
        } else {
          branchNumstat = execGit(['diff', '--numstat', `${baseRef}...HEAD`, '--']) || '';
          branchMeta = `${baseRef}..${headSha}`;
        }
      }
    }
  }

  const { byRel } = parseNumstatLines(numstat);
  const { byRel: branchByRel } = parseNumstatLines(branchNumstat);

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
    perFileLines[abs] = Math.max(perFileLines[abs] || 0, lines);
    const cleanRel = rel.split(path.sep).join('/');
    if (!seenAbs.has(abs)) {
      seenAbs.add(abs);
      changedAbsFiles.push(abs);
      changedRelByAbs[abs] = cleanRel;
    }
    if (HIGH_RISK_PATH_RE.test(cleanRel) && !gitHighRisk.includes(cleanRel)) gitHighRisk.push(cleanRel);
  }
  for (const [rel, lines] of branchByRel.entries()) {
    const abs = realpathSafe(path.join(gitRoot, rel));
    perFileLines[abs] = Math.max(perFileLines[abs] || 0, lines);
    const cleanRel = rel.split(path.sep).join('/');
    if (!seenAbs.has(abs)) {
      seenAbs.add(abs);
      changedAbsFiles.push(abs);
      changedRelByAbs[abs] = cleanRel;
    }
    if (HIGH_RISK_PATH_RE.test(cleanRel) && !gitHighRisk.includes(cleanRel)) gitHighRisk.push(cleanRel);
  }

  let total = 0;
  for (const lines of Object.values(perFileLines)) total += Number(lines || 0);

  return {
    gitRoot,
    changedAbsFiles,
    changedRelByAbs,
    perFileLines,
    changedFiles: changedAbsFiles.length,
    changedLines: total,
    gitHighRisk,
    diffHash: sha1Short(
      branchNumstat || branchMeta
        ? `${statusZ}\n--\n${numstat}\n--\n${branchMeta}\n${branchNumstat}`
        : `${statusZ}\n--\n${numstat}`
    ),
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

export function computeAttributionHash(attr) {
  return sha1Short(
    JSON.stringify({
      files: Array.isArray(attr?.attributedRel) ? attr.attributedRel.slice().sort() : [],
      lines: Number(attr?.stopLines || 0),
      risk: Array.isArray(attr?.highRiskRel) ? attr.highRiskRel.slice().sort() : [],
    })
  );
}

function computeAttribution(conv, git, { injectedSummary = false } = {}) {
  const root = git.gitRoot || '';
  if (Array.isArray(git.changedAbsFiles)) {
    const gitSet = new Set(git.changedAbsFiles.map((p) => realpathSafe(p)));
    const gitCommonDir = root ? getGitCommonDirNoSpawn(root) : '';
    const changedRelMap = new Map();
    for (const abs of git.changedAbsFiles) {
      const rAbs = realpathSafe(abs);
      const rawRel =
        (git.changedRelByAbs && (git.changedRelByAbs[abs] || git.changedRelByAbs[rAbs])) ||
        normalizeRelPath(rAbs, root);
      if (rawRel) changedRelMap.set(rawRel.split(path.sep).join('/'), rAbs);
    }

    const attributedAbs = [];
    const attributedRel = [];
    const highRiskRel = [];
    const seenRel = new Set();
    let stopLines = 0;

    for (const rawAbs of conv.touchedAbsFiles) {
      const abs = realpathSafe(rawAbs);
      let matchedAbs = gitSet.has(abs) ? abs : '';
      let rel = '';
      if (matchedAbs) {
        rel = sanitizePathDisplay(
          (git.changedRelByAbs && (git.changedRelByAbs[rawAbs] || git.changedRelByAbs[matchedAbs])) ||
            normalizeRelPath(matchedAbs, root) ||
            matchedAbs
        );
      } else {
        const touchedRoot = findGitRootSync(abs) || root;
        const touchedRel = normalizeRelPath(abs, touchedRoot);
        if (touchedRel && changedRelMap.has(touchedRel)) {
          const touchedCommon = getGitCommonDirNoSpawn(touchedRoot);
          if (!gitCommonDir || !touchedCommon || gitCommonDir === touchedCommon) {
            matchedAbs = changedRelMap.get(touchedRel);
            rel = sanitizePathDisplay(touchedRel);
          }
        }
      }
      if (!matchedAbs) continue;
      if (rel && seenRel.has(rel)) continue;
      if (rel) seenRel.add(rel);
      attributedAbs.push(matchedAbs);
      attributedRel.push(rel);
      stopLines += Number(git.perFileLines?.[matchedAbs] || git.perFileLines?.[abs] || 0);
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
    reviewerModel: quotaPolicy.reviewerModel,
    recommendedModelId: quotaPolicy.recommendedModelId,
    workerName: quotaPolicy.workerName,
    quotaPool: quotaPolicy.quotaPool,
    pool5hPct: quotaPolicy.pool5hPct,
    poolWeeklyPct: quotaPolicy.poolWeeklyPct,
    recommendedTier: 'high',
    quotaBlocked: !quotaPolicy.healthy,
    claude5hPct: quota.claude5hPct,
    claudeWeeklyPct: quota.claudeWeeklyPct,
    gemini5hPct: quota.gemini5hPct,
    geminiWeeklyPct: quota.geminiWeeklyPct,
    ts: now,
    dismissed: false,
  };
}

function applyAuditBaselineSnapshot(conv, convFile, touchLogFile, pluginDataDir, proposalsDir, cid, effectiveGitRoot, git, attr) {
  removeProposalFile(proposalsDir, cid);
  if (conv.pendingPlanHash) {
    conv.lastAuditedPlanHash = conv.pendingPlanHash;
    conv.lastSuggestedPlanHash = conv.pendingPlanHash;
    conv.acknowledgedPlanHash = conv.pendingPlanHash;
    conv.pendingPlanHash = '';
    conv.pendingPlanReason = '';
  }
  conv.blockingPlanHash = '';
  conv.blockingLandingHash = '';
  if (git && attr) {
    if (attr.highRiskRel.length > 0) {
      const riskHash = sha1Short(attr.highRiskRel.slice().sort().join('\n'));
      conv.lastAuditedRiskHash = riskHash;
      conv.lastSuggestedRiskHash = riskHash;
    }
    conv.lastAuditedStopFiles = Math.max(conv.lastAuditedStopFiles, attr.stopFiles);
    conv.lastAuditedStopLines = Math.max(conv.lastAuditedStopLines, attr.stopLines);
    conv.lastSuggestedStopFiles = Math.max(conv.lastSuggestedStopFiles, attr.stopFiles);
    conv.lastSuggestedStopLines = Math.max(conv.lastSuggestedStopLines, attr.stopLines);
    if (attr.stopFiles > 0) {
      conv.lastAuditedLandingHash = computeAttributionHash(attr);
    }
  }
  persistConvState(convFile, conv, touchLogFile, pluginDataDir);
}

/**
 * Evaluate a single Antigravity lifecycle hook payload synchronously.
 * Accepts optional path/clock overrides via `opts` for isolated unit tests.
 */
export function evaluateHookEvent(payload = {}, opts = {}) {
  const event = String(payload?.hookEventName || '');
  const emptyResult = event === 'PreToolUse' ? { decision: 'allow' } : {};
  if (!payload || typeof payload !== 'object') return emptyResult;

  const { prefsFile, quotaFile, proposalsDir, pluginDataDir } = resolvePaths(opts);
  const prefs = loadPrefs(prefsFile);
  if (prefs.opusGateMode === 'off') return emptyResult;
  if (isSelfOrHigherModel(prefs.opusGateModel, payload.modelName)) return emptyResult;

  const cid = getSafeCid(payload.conversationId);
  if (!cid) return emptyResult;

  const { convFile, touchLogFile, conv, hadLog } = loadConvState(pluginDataDir, cid);
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const quota = resolveQuotaSnapshot(quotaFile);

  if (event === 'PreToolUse') {
    const toolName = String(payload.toolCall?.name || '').trim();
    const args = payload.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};

    if (toolName === 'edit_file' || toolName === 'write_file') {
      if (!prefs.opusGateCheckpoints.plan || !conv.pendingPlanHash) {
        if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
        return emptyResult;
      }
      const rawFile = args.Path || args.path || args.TargetFile || args.AbsolutePath || '';
      const absPath = resolveAbsPath(rawFile, payload.cwd || '');
      const isPlanTarget = Boolean(args.ArtifactMetadata?.RequestFeedback) || (absPath ? PLAN_PATH_RE.test(absPath) : false);
      if (isPlanTarget) {
        if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
        return emptyResult;
      }
      const planHash = conv.pendingPlanHash;
      const curProp = readJsonSafe(getProposalPath(proposalsDir, cid), null);
      if (
        conv.lastAuditedPlanHash === planHash ||
        conv.acknowledgedPlanHash === planHash ||
        (curProp?.dismissed === true && curProp?.dismissedDiffHash === planHash)
      ) {
        if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
        return emptyResult;
      }

      const effectiveGitRoot = resolveEffectiveGitRoot(conv.touchedAbsFiles, payload.cwd || '');
      const planDisplayList = conv.planFiles
        .map((p) => sanitizePathDisplay(normalizeRelPath(p, effectiveGitRoot) || p))
        .filter(Boolean)
        .slice(-5);
      const quotaPolicy = evaluateQuotaPolicy(prefs, quota, 'plan');
      const planNames = planDisplayList.length ? planDisplayList.join(', ') : 'plan artifact';
      const planReason = `Plan artifact pending review before coding (${sanitizePromptText(planNames, 120)})`;

      writeProposalFile(
        proposalsDir,
        cid,
        buildProposalRecord({
          kind: 'plan',
          source: 'hook',
          reason: planReason,
          diffHash: planHash,
          changedFiles: conv.touchedAbsFiles.length,
          planFiles: planDisplayList,
          worktreeRoot: effectiveGitRoot,
          conv,
          quota,
          quotaPolicy,
          now,
        })
      );
      const isAutoReview =
        prefs.opusGateMode === 'auto' && quotaPolicy.healthy && conv.autoCalls < prefs.opusGateMaxAutoPerSession;
      if (isAutoReview && conv.blockingPlanHash !== planHash) {
        conv.autoCalls += 1;
      }
      conv.blockingPlanHash = planHash;
      persistConvState(convFile, conv, touchLogFile, pluginDataDir);

      if (isAutoReview) {
        return {
          decision: 'deny',
          reason:
            `[MAGA Review Gate · plan] Plan artifact was just written without review. ` +
            `Load the \`opus-gate\` skill and run a read-only ${quotaPolicy.label} plan review via \`swarm\` (\`${quotaPolicy.workerName}\`, \`model: "${quotaPolicy.recommendedModelId}"\`) before editing source files.`,
        };
      }
      return {
        decision: 'deny',
        reason:
          `[MAGA Review Gate · plan] Paused before editing source files: plan artifact (${sanitizePromptText(planNames, 120)}) has not been presented to the user yet. ` +
          `Stop this turn now, present the plan summary to the user, and wait for them to click \`✦ 请求审查\` or confirm implementation.`,
      };
    }

    if (toolName === 'run_command') {
      const commandLine = String(args.CommandLine || args.command || '');
      const landing = detectLandingAction(commandLine, payload.cwd || '');
      if (!landing) {
        if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
        return emptyResult;
      }
      if (conv.touchedAbsFiles.length === 0 && !opts.gitSummary) {
        if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
        return emptyResult;
      }

      const effectiveGitRoot = resolveLandingGitRoot(conv.touchedAbsFiles, landing.repoDir, payload.cwd || '');
      const git =
        opts.gitSummary ||
        inspectGitSummary(effectiveGitRoot, {
          includeBranchDiff: true,
          mergeRepoDir: landing.repoDir,
          mergeSourceRef: landing.sourceRef,
          includeUpstreamOnMain: landing.action === 'push',
        });
      if (!git.gitRoot && effectiveGitRoot) git.gitRoot = effectiveGitRoot;

      const attr = computeAttribution(conv, git, { injectedSummary: Boolean(opts.gitSummary) });
      const riskHit = prefs.opusGateCheckpoints.risk && attr.stopFiles > 0 && attr.highRiskRel.length > 0;
      const stopHit =
        prefs.opusGateCheckpoints.stop && attr.stopFiles > 0 && (attr.stopFiles >= 3 || attr.stopLines >= 120);
      if (!riskHit && !stopHit) {
        if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
        return emptyResult;
      }

      const landingHash = computeAttributionHash(attr);
      const riskHash = attr.highRiskRel.length ? sha1Short(attr.highRiskRel.slice().sort().join('\n')) : '';
      const curProp = readJsonSafe(getProposalPath(proposalsDir, cid), null);
      if (
        conv.lastAuditedLandingHash === landingHash ||
        conv.acknowledgedLandingHash === landingHash ||
        (curProp?.dismissed === true && curProp?.dismissedDiffHash === landingHash) ||
        (riskHit && !stopHit && riskHash && conv.lastAuditedRiskHash === riskHash) ||
        (stopHit && !riskHit && attr.stopFiles <= conv.lastAuditedStopFiles && attr.stopLines <= conv.lastAuditedStopLines)
      ) {
        if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
        return emptyResult;
      }

      const kind = riskHit ? 'risk' : 'stop';
      const reason = riskHit
        ? `Pre-${landing.action} high-risk changes (${attr.highRiskRel.slice(0, 3).join(', ')})`
        : `Pre-${landing.action} review (${attr.stopFiles} files, ${attr.stopLines} lines)`;
      const quotaPolicy = evaluateQuotaPolicy(prefs, quota, kind);

      writeProposalFile(
        proposalsDir,
        cid,
        buildProposalRecord({
          kind,
          source: 'hook',
          reason,
          diffHash: landingHash,
          changedFiles: attr.stopFiles,
          changedLines: attr.stopLines,
          highRiskFiles: attr.highRiskRel,
          worktreeRoot: effectiveGitRoot,
          conv,
          quota,
          quotaPolicy,
          now,
        })
      );
      const isAutoReview =
        prefs.opusGateMode === 'auto' && quotaPolicy.healthy && conv.autoCalls < prefs.opusGateMaxAutoPerSession;
      if (isAutoReview && conv.blockingLandingHash !== landingHash) {
        conv.autoCalls += 1;
      }
      conv.blockingLandingHash = landingHash;
      persistConvState(convFile, conv, touchLogFile, pluginDataDir);

      if (isAutoReview) {
        return {
          decision: 'deny',
          reason:
            `[MAGA Review Gate · pre-${landing.action}] ${sanitizePromptText(reason, 200)}. ` +
            `Load the \`opus-gate\` skill and run a read-only ${quotaPolicy.label} review via \`swarm\` (\`${quotaPolicy.workerName}\`, \`model: "${quotaPolicy.recommendedModelId}"\`) before running \`${landing.label}\`.`,
        };
      }
      return {
        decision: 'deny',
        reason:
          `[MAGA Review Gate · pre-${landing.action}] Paused before \`${landing.label}\`: ${sanitizePromptText(reason, 200)}. ` +
          `Stop this turn now, summarize the verified changes and test results, and let the user choose \`✦ 请求审查\` in the bottom bar or reply to proceed directly.`,
      };
    }

    if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
    return emptyResult;
  }

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

    if (toolName === 'swarm') {
      const errText = typeof payload.error === 'string' ? payload.error.trim() : '';
      if (errText) {
        if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
        return {};
      }
      const args = payload.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
      const action = String(args.action || '').trim().toLowerCase();
      const name = String(args.name || '').trim();
      const isReviewName = /(?:^|[-_])(?:opus|carbon|review)(?:[-_]|$)/i.test(name);
      const isReviewAdd = action === 'add' && isReviewName;
      const isReviewKill =
        action === 'kill' && ((Boolean(conv.activeReviewWorker) && conv.activeReviewWorker === name) || isReviewName);

      if (!isReviewAdd && !isReviewKill) {
        if (hadLog) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
        return {};
      }

      if (isReviewAdd) {
        conv.activeReviewWorker = name;
        removeProposalFile(proposalsDir, cid);
        persistConvState(convFile, conv, touchLogFile, pluginDataDir);
        return {};
      }

      conv.activeReviewWorker = '';
      const effectiveGitRoot = resolveEffectiveGitRoot(conv.touchedAbsFiles, payload.cwd || '');
      const git = opts.gitSummary || (effectiveGitRoot ? inspectGitSummary(effectiveGitRoot, { includeBranchDiff: true }) : null);
      if (git && !git.gitRoot && effectiveGitRoot) git.gitRoot = effectiveGitRoot;
      const attr = git ? computeAttribution(conv, git, { injectedSummary: Boolean(opts.gitSummary) }) : null;
      applyAuditBaselineSnapshot(conv, convFile, touchLogFile, pluginDataDir, proposalsDir, cid, effectiveGitRoot, git, attr);
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

    let justPausedLanding = false;
    let justPausedPlan = false;
    if (conv.blockingLandingHash) {
      conv.acknowledgedLandingHash = conv.blockingLandingHash;
      conv.blockingLandingHash = '';
      justPausedLanding = true;
    }
    if (conv.blockingPlanHash) {
      conv.acknowledgedPlanHash = conv.blockingPlanHash;
      conv.blockingPlanHash = '';
      if (prefs.opusGateMode === 'semi') {
        conv.lastSuggestedPlanHash = conv.acknowledgedPlanHash;
      }
      justPausedPlan = true;
    }
    if (conv.pendingPlanHash) {
      conv.acknowledgedPlanHash = conv.pendingPlanHash;
    }

    const effectiveGitRoot = resolveEffectiveGitRoot(conv.touchedAbsFiles, payload.cwd || '');
    const git = opts.gitSummary || inspectGitSummary(effectiveGitRoot, { includeBranchDiff: true });
    if (!git.gitRoot && effectiveGitRoot) git.gitRoot = effectiveGitRoot;

    const attr = computeAttribution(conv, git, { injectedSummary: Boolean(opts.gitSummary) });
    const riskHash = attr.highRiskRel.length ? sha1Short(attr.highRiskRel.slice().sort().join('\n')) : '';

    if (justPausedLanding || justPausedPlan) {
      if (justPausedLanding) {
        if (riskHash) conv.lastSuggestedRiskHash = riskHash;
        conv.lastSuggestedStopFiles = Math.max(conv.lastSuggestedStopFiles, attr.stopFiles);
        conv.lastSuggestedStopLines = Math.max(conv.lastSuggestedStopLines, attr.stopLines);
      }
      persistConvState(convFile, conv, touchLogFile, pluginDataDir);
      return {};
    }

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
      if (hadLog || conv.pendingPlanHash) persistConvState(convFile, conv, touchLogFile, pluginDataDir);
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
          `[MAGA Review Gate · ${kind}] ${safeReason}.${wtNote}${planNote}${riskNote} ` +
          `Load the \`opus-gate\` skill and invoke \`swarm\` with one read-only ${quotaPolicy.label} worker \`${quotaPolicy.workerName}\` (\`model: "${quotaPolicy.recommendedModelId}"\`).${forkNote} ` +
          `Instruct it to post \`@coordinator [done]\` with Verdict (APPROVE/REVISE/HOLD) and P0/P1/P2 findings.`,
      };
    }

    const landingHash = attr.stopFiles > 0 ? computeAttributionHash(attr) : '';
    const diffHash = kind === 'plan' ? conv.pendingPlanHash : landingHash || riskHash || git.diffHash || '';
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
      if (landingHash) conv.acknowledgedLandingHash = landingHash;
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

  const { prefsFile, quotaFile, proposalsDir, pluginDataDir } = resolvePaths(opts);
  const prefs = loadPrefs(prefsFile);
  if (prefs.opusGateMode === 'off') {
    return { action: 'skip', reason: 'mode_off', mode: 'off' };
  }
  if (isSelfOrHigherModel(prefs.opusGateModel, params?.model)) {
    return { action: 'skip', reason: 'already_self_or_higher', reviewerModel: prefs.opusGateModel };
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
  const quotaPolicy = evaluateQuotaPolicy(prefs, quota);

  const reasonText = sanitizePromptText(params?.reason || '', 220) || `Semantic ${kind} checkpoint`;
  const fileList = (Array.isArray(params?.files) ? params.files : String(params?.files || '').split(','))
    .map((s) => sanitizePathDisplay(s))
    .filter(Boolean)
    .slice(0, 10);
  const semanticHash = sha1Short(`${kind}|${reasonText}|${fileList.join(',')}`);
  const recommendedModelId = quotaPolicy.recommendedModelId;
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
        reviewerModel: quotaPolicy.reviewerModel,
        workerName: quotaPolicy.workerName,
        quotaPool: quotaPolicy.quotaPool,
        recommendedTier: 'high',
        recommendedModelId,
        autoCallsUsed: conv.autoCalls,
        autoCallsMax: prefs.opusGateMaxAutoPerSession,
        pool5hPct: quotaPolicy.pool5hPct,
        poolWeeklyPct: quotaPolicy.poolWeeklyPct,
        claude5hPct: quota.claude5hPct,
        claudeWeeklyPct: quota.claudeWeeklyPct,
        gemini5hPct: quota.gemini5hPct,
        geminiWeeklyPct: quota.geminiWeeklyPct,
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
      reviewerModel: quotaPolicy.reviewerModel,
      workerName: quotaPolicy.workerName,
      quotaPool: quotaPolicy.quotaPool,
      recommendedTier: 'high',
      recommendedModelId,
      quotaBlocked: !quotaPolicy.healthy,
      proposalPublished,
      pool5hPct: quotaPolicy.pool5hPct,
      poolWeeklyPct: quotaPolicy.poolWeeklyPct,
      claude5hPct: quota.claude5hPct,
      claudeWeeklyPct: quota.claudeWeeklyPct,
      gemini5hPct: quota.gemini5hPct,
      geminiWeeklyPct: quota.geminiWeeklyPct,
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
    reviewerModel: quotaPolicy.reviewerModel,
    workerName: quotaPolicy.workerName,
    quotaPool: quotaPolicy.quotaPool,
    recommendedTier: 'high',
    recommendedModelId,
    quotaBlocked: !quotaPolicy.healthy,
    proposalPublished,
    pool5hPct: quotaPolicy.pool5hPct,
    poolWeeklyPct: quotaPolicy.poolWeeklyPct,
    claude5hPct: quota.claude5hPct,
    claudeWeeklyPct: quota.claudeWeeklyPct,
    gemini5hPct: quota.gemini5hPct,
    geminiWeeklyPct: quota.geminiWeeklyPct,
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
  const { convFile, touchLogFile, conv } = loadConvState(pluginDataDir, cid);
  conv.activeReviewWorker = '';

  const effectiveGitRoot = findGitRootSync(params?.dir || '') || resolveEffectiveGitRoot(conv.touchedAbsFiles, '');
  const git =
    opts.gitSummary || (effectiveGitRoot ? inspectGitSummary(effectiveGitRoot, { includeBranchDiff: true }) : null);
  let attr = null;
  if (git) {
    if (!git.gitRoot && effectiveGitRoot) git.gitRoot = effectiveGitRoot;
    attr = computeAttribution(conv, git, { injectedSummary: Boolean(opts.gitSummary) });
  }
  applyAuditBaselineSnapshot(conv, convFile, touchLogFile, pluginDataDir, proposalsDir, cid, effectiveGitRoot, git, attr);
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
  let rawStdin = '';
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
        rawStdin = fs.readFileSync(0, 'utf8').trim();
        if (rawStdin) payload = JSON.parse(rawStdin);
      } catch {}
      result = evaluateHookEvent(payload);
    }
  } catch {
    result = isClear
      ? { ok: false, error: 'error' }
      : isPreflight
        ? { action: 'skip', reason: 'error' }
        : rawStdin.includes('PreToolUse')
          ? { decision: 'allow' }
          : {};
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
