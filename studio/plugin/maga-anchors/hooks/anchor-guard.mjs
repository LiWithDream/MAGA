#!/usr/bin/env node
/**
 * Zero-External-Dep Antigravity Hook Engine for `maga-anchors` (`PreToolUse`, `PostToolUse`, `Stop`).
 *
 * Pillar 1: Counts compaction generation `G` (`step_type = 23` / `CHECKPOINT`) & emits zero-model-token
 *           `metadata.user_markdown` handoff nudge when `G >= 3`.
 * Pillar 2: Out-of-band UTF-8-safe `transcript_full.jsonl` tail scanner pairing verbatim user corrections
 *           with redacted next-step `thinking` comprehension previews into `anchor-proposals/<cid>.json`,
 *           plus cache-friendly `Stop`-boundary flush of accepted `.agents/rules/anchors.local.md` writes.
 * Pillar 3: Zero-LLM `.agents/locks.json` `PreToolUse` `force_ask` speed-bump guard + deterministic `>= 3`
 *           consecutive failure-signature escalation to `opus-gate` `debug`.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let DatabaseSync = null;
try {
  const req = createRequire(import.meta.url);
  ({ DatabaseSync } = req('node:sqlite'));
} catch {}

const SAFE_CID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const FILE_EDIT_TOOLS = new Set([
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);
const MAX_TAIL_READ_BYTES = 512 * 1024;
const MAX_PROPOSALS_PER_CONV = 3;
const MAX_MUTED_HASHES = 128;
const MAX_ANCHOR_TOKENS = 400;
const ACTION_LOOP_THRESHOLD = 3;
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const realpathNative = fs.realpathSync.native || fs.realpathSync;

// Bilingual high-precision constraint / user-correction cue matcher (applied outside fenced code blocks)
const CORRECTION_CUE_RE =
  /(?:严禁|禁止|不准|不能改|不能动|不要再|不要改|别再|切忌|必须保持|刚才说了|不是这个意思|我说的是|锁死|\bmust\s+not\b|\bnever\s+(?:modify|edit|change|run|use|touch|override|bypass|delete|drop)\b|\b(?:do\s+not|don['’]t)\s+(?:modify|edit|change|run|use|touch|override|bypass|delete|drop|remove)\b|\bstop\s+(?:changing|editing|modifying|running|using|touching)\b|\b(?:i\s+said|i\s+told\s+you|that['’]s\s+not\s+what\s+i\s+meant|keep\s+it\s+(?:strictly|unchanged|locked))\b|\bstrictly\s+forbidden\b)/i;

export function sha1Short(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

export function redactSensitiveText(raw) {
  let s = String(raw || '');
  if (!s) return '';
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_KEY]');
  s = s.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{28,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, '[REDACTED_TOKEN]');
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED_TOKEN]');
  s = s.replace(/((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*)(?:['"][^'"]{3,}['"]|\S{4,})/gi, '$1[REDACTED]');
  s = s.replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1[REDACTED]@');
  return s;
}

export function estimateRuleTokens(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef)) {
      cjk += 1;
    }
  }
  const nonCjkWords = s
    .replace(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.ceil(cjk * 0.7 + nonCjkWords * 1.3));
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeAtomicText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

function writeAtomicJson(filePath, obj) {
  writeAtomicText(filePath, `${JSON.stringify(obj, null, 2)}\n`);
}

function getSafeCid(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return SAFE_CID_RE.test(s) ? path.basename(s) : '';
}

export function resolveAnchorPaths(opts = {}) {
  const stateDir =
    opts.stateDir ||
    process.env.ANTI_CLAUDE_STATE_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'anti-claude');
  const conversationsDir =
    opts.conversationsDir ||
    process.env.ANTI_CLAUDE_CONVERSATIONS_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
  const brainDir =
    opts.brainDir ||
    process.env.ANTI_CLAUDE_BRAIN_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  return {
    stateDir,
    conversationsDir,
    brainDir,
    prefsFile: opts.studioPrefsFile || path.join(stateDir, 'studio-prefs.json'),
    userConfigFile: opts.userConfigFile || path.join(stateDir, 'user', 'config.json'),
    proposalsDir: opts.proposalsDir || path.join(stateDir, 'anchor-proposals'),
    pendingWritesDir: opts.pendingWritesDir || path.join(stateDir, 'anchor-pending-writes'),
    pluginDataDir: opts.pluginDataDir || process.env.PLUGIN_DATA || path.join(stateDir, 'anchors-data'),
    opusProposalsDir: opts.opusProposalsDir || path.join(stateDir, 'opus-gate-proposals'),
  };
}

function isZhUiConfigured(paths, opts = {}) {
  if (opts.lang === 'zh') return true;
  if (opts.lang === 'en') return false;
  const cfg = readJsonSafe(paths.userConfigFile, null);
  return Boolean(cfg?.modules?.i18n === true);
}

function isAnchorsEnabled(prefsFile) {
  const raw = readJsonSafe(prefsFile, null);
  return raw?.anchorsMode !== 'off';
}

function resolveGitRoots(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel', '--git-common-dir'], {
      encoding: 'utf8',
      timeout: 1200,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const lines = out.split(/\r?\n/);
    if (lines.length < 2) return null;
    const topLevel = realpathNative(lines[0].trim());
    const commonDir = realpathNative(path.resolve(cwd, lines[1].trim()));
    const mainRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : topLevel;
    return { topLevel, commonDir, mainRoot };
  } catch {
    return null;
  }
}

export function normalizeRepoKeyHash(repoRoot) {
  const norm = String(repoRoot || '')
    .trim()
    .replace(/\\/g, '/');
  const key = CASE_INSENSITIVE_FS ? norm.toLowerCase() : norm;
  return sha1Short(key);
}

function loadRepoLocks(gitRoots) {
  if (!gitRoots) return null;
  for (const dir of [gitRoots.topLevel, gitRoots.mainRoot]) {
    if (!dir) continue;
    const locksFile = path.join(dir, '.agents', 'locks.json');
    const parsed = readJsonSafe(locksFile, null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { locks: parsed, locksRoot: dir };
    }
  }
  return null;
}

function isSafeBoundedRegex(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 384) return false;
  // Reject nested repeating groups that risk catastrophic backtracking
  if (/\([^)]*[+*][^)]*\)[+*?]/.test(pattern)) return false;
  return true;
}

function findFastUpwardLocks(startDir) {
  if (!startDir || typeof startDir !== 'string') return null;
  let cur = path.resolve(startDir);
  for (let depth = 0; depth < 16; depth += 1) {
    const locksCandidate = path.join(cur, '.agents', 'locks.json');
    if (fs.existsSync(locksCandidate)) {
      const parsed = readJsonSafe(locksCandidate, null);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { locks: parsed, locksRoot: cur };
      }
    }
    const gitEntry = path.join(cur, '.git');
    if (fs.existsSync(gitEntry)) {
      // Linked worktree `.git` is a file pointing to `<commonDir>/worktrees/<slug>`; check mainRoot too!
      try {
        const st = fs.statSync(gitEntry);
        if (st.isFile()) {
          const gitPtr = fs.readFileSync(gitEntry, 'utf8').trim();
          const m = gitPtr.match(/^gitdir:\s*(.+)$/i);
          if (m) {
            const wtGitDir = path.resolve(cur, m[1].trim());
            const commonCandidate = path.resolve(wtGitDir, '..', '..');
            if (path.basename(commonCandidate) === '.git') {
              const mainRoot = path.dirname(commonCandidate);
              const mainLocks = path.join(mainRoot, '.agents', 'locks.json');
              if (fs.existsSync(mainLocks)) {
                const parsed = readJsonSafe(mainLocks, null);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  return { locks: parsed, locksRoot: mainRoot, topLevel: cur, mainRoot };
                }
              }
            }
          }
        }
      } catch {}
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function normalizeLocksSchema(locks) {
  if (!locks || typeof locks !== 'object') {
    return { lockedFiles: [], paramLocks: [], bannedPatterns: [] };
  }
  const lockedFiles = [
    ...(Array.isArray(locks.lockedFiles) ? locks.lockedFiles : []),
    ...(Array.isArray(locks.locked_files) ? locks.locked_files : []),
  ];
  const paramLocks = [
    ...(Array.isArray(locks.paramLocks) ? locks.paramLocks : []),
    ...(Array.isArray(locks.param_locks) ? locks.param_locks : []),
  ];
  const rawBanned = [
    ...(Array.isArray(locks.bannedPatterns) ? locks.bannedPatterns : []),
    ...(Array.isArray(locks.tombstone_rules) ? locks.tombstone_rules : []),
  ];
  const bannedPatterns = rawBanned.map((b) => {
    const scope = typeof b?.scope === 'string' ? b.scope.trim() : '';
    const defaultApplies = scope && /sanitization/i.test(scope) ? ['file'] : ['shell'];
    const appliesTo = Array.isArray(b?.appliesTo)
      ? b.appliesTo.map((x) => String(x || '').toLowerCase())
      : Array.isArray(b?.applies_to)
        ? b.applies_to.map((x) => String(x || '').toLowerCase())
        : defaultApplies;
    const rawExclude = Array.isArray(b?.excludeFiles)
      ? b.excludeFiles
      : Array.isArray(b?.exclude_files)
        ? b.exclude_files
        : [];
    const excludeFiles = rawExclude
      .map((x) => {
        const norm = String(x || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
        return CASE_INSENSITIVE_FS ? norm.toLowerCase() : norm;
      })
      .filter(Boolean);
    return {
      id: b?.id || '',
      scope,
      appliesTo,
      excludeFiles,
      pattern: b?.pattern || '',
      flags: b?.flags || '',
      quote: b?.quote || b?.message || '',
      source: b?.source || b?.provenance || '',
      reopenIf: b?.reopenIf || b?.reopen_if || '',
    };
  });
  return { lockedFiles, paramLocks, bannedPatterns };
}

function resolveExistingPrefixRealpath(targetPath) {
  let cur = path.resolve(targetPath);
  const tail = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  let realBase = cur;
  try {
    realBase = realpathNative(cur);
  } catch {}
  return tail.length > 0 ? path.join(realBase, ...tail) : realBase;
}

function normalizeRelCompare(absTarget, rootDir) {
  const realT = resolveExistingPrefixRealpath(absTarget);
  const realR = resolveExistingPrefixRealpath(rootDir);
  const rel = path.relative(realR, realT).replace(/\\/g, '/');
  return CASE_INSENSITIVE_FS ? rel.toLowerCase() : rel;
}

export function evaluateLocksPreToolUse(payload, opts = {}) {
  const paths = resolveAnchorPaths(opts);
  if (!isAnchorsEnabled(paths.prefsFile)) return { decision: 'allow' };

  const args = payload?.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
  const rawCwd = args.Cwd || args.cwd || payload?.cwd || process.cwd();
  const toolName = String(payload?.toolCall?.name || '').toLowerCase();

  if (FILE_EDIT_TOOLS.has(toolName)) {
    const rawPath = args.Path || args.TargetFile || args.path || args.file_path || '';
    if (!rawPath || typeof rawPath !== 'string') return { decision: 'allow' };
    const absTarget = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(rawCwd, rawPath);
    // Zero-subprocess fast path (`<0.2ms` pure fs walk starting from edited target's directory; zero git spawn when `.agents/locks.json` is absent)
    const loaded = findFastUpwardLocks(path.dirname(absTarget)) || findFastUpwardLocks(rawCwd);
    if (!loaded) return { decision: 'allow' };

    const { locks: rawLocks, locksRoot, topLevel, mainRoot } = loaded;
    const locks = normalizeLocksSchema(rawLocks);
    const lockedFiles = locks.lockedFiles;
    for (const entry of lockedFiles) {
      const lockRelRaw = typeof entry?.path === 'string' ? entry.path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '';
      if (!lockRelRaw) continue;
      const cmpLock = CASE_INSENSITIVE_FS ? lockRelRaw.toLowerCase() : lockRelRaw;
      for (const rootCand of [topLevel, mainRoot, locksRoot]) {
        if (!rootCand) continue;
        const rel = normalizeRelCompare(absTarget, rootCand);
        if (rel === cmpLock || rel.startsWith(`${cmpLock}/`)) {
          const quote = String(entry.quote || 'Locked by repository .agents/locks.json').slice(0, 220);
          const src = entry.source ? ` (${String(entry.source).slice(0, 40)})` : '';
          return {
            decision: 'force_ask',
            reason: `[AGY Studio Lock Guard] File '${lockRelRaw}' is locked${src}: "${quote}"`,
          };
        }
      }
    }

    // Check file-scoped `bannedPatterns` (e.g. sanitization guards against committing private strings into tracked files)
    const basenameTarget = path.basename(absTarget);
    const cmpBase = CASE_INSENSITIVE_FS ? basenameTarget.toLowerCase() : basenameTarget;
    const relCandidates = [topLevel, mainRoot, locksRoot]
      .filter(Boolean)
      .map((rootCand) => normalizeRelCompare(absTarget, rootCand));
    const chunkTexts = Array.isArray(args.ReplacementChunks)
      ? args.ReplacementChunks.map((c) => String(c?.ReplacementContent || '')).filter(Boolean)
      : [];
    const writtenContent = [String(args.Content || args.Replacement || args.TargetContent || ''), ...chunkTexts]
      .filter(Boolean)
      .join('\n');
    if (writtenContent) {
      for (const b of locks.bannedPatterns) {
        if (!b.appliesTo.includes('file') || !isSafeBoundedRegex(b?.pattern)) continue;
        const isExcluded =
          b.excludeFiles.length > 0 &&
          b.excludeFiles.some(
            (ex) =>
              ex === cmpBase ||
              relCandidates.some((rel) => rel === ex || rel.startsWith(`${ex.replace(/\/+$/, '')}/`))
          );
        if (isExcluded) continue;
        try {
          const re = new RegExp(b.pattern, b.flags && /^[im]{0,2}$/.test(b.flags) ? b.flags : '');
          if (re.test(writtenContent)) {
            const quote = String(b.quote || 'Content matches banned file pattern').slice(0, 220);
            const src = b.source ? ` (${String(b.source).slice(0, 40)})` : '';
            return {
              decision: 'force_ask',
              reason: `[AGY Studio File Guard] Edit to '${basenameTarget}' hits '${b.id || b.pattern}'${src}: "${quote}"`,
            };
          }
        } catch {}
      }
    }
    return { decision: 'allow' };
  }

  // Zero-subprocess fast path (`<0.2ms` pure fs walk; zero git spawn when `.agents/locks.json` is absent)
  const loaded = findFastUpwardLocks(rawCwd);
  if (!loaded) return { decision: 'allow' };
  const locks = normalizeLocksSchema(loaded.locks);

  if (toolName === 'run_command') {
    const cmd = String(args.CommandLine || args.command || '');
    if (!cmd) return { decision: 'allow' };

    // 1. Parameter locks (`KEY=val` or `--kebab-key val` / `--kebab-key=val`) — deterministic speed-bump across local & ssh strings
    const paramLocks = locks.paramLocks;
    for (const p of paramLocks) {
      const key = typeof p?.key === 'string' ? p.key.trim() : '';
      const expected = p?.expected !== undefined && p?.expected !== null ? String(p.expected).trim() : '';
      if (!key || !expected || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) continue;
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const kebab = key.toLowerCase().replace(/_/g, '-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const envAssignRe = new RegExp(`(?:^|[\\s;"'&|])${escapedKey}=([^\\s;"'&|]+)`, 'g');
      const flagAssignRe = new RegExp(`(?:^|[\\s;"'])--${kebab}(?:=|\\s+)([^\\s;"'&|]+)`, 'gi');

      for (const re of [envAssignRe, flagAssignRe]) {
        let m = null;
        while ((m = re.exec(cmd)) !== null) {
          const actual = String(m[1] || '').replace(/^['"]|['"]$/g, '').trim();
          if (actual && actual !== expected) {
            const quote = String(p.quote || `${key} is locked to ${expected}`).slice(0, 220);
            const src = p.source ? ` (${String(p.source).slice(0, 40)})` : '';
            return {
              decision: 'force_ask',
              reason: `[AGY Studio Lock Guard] '${key}=${actual}' overrides locked value '${expected}'${src}: "${quote}"`,
            };
          }
        }
      }
    }

    // 2. Banned dead-end / Tombstone patterns (`appliesTo` includes `'shell'`)
    const bannedPatterns = locks.bannedPatterns;
    for (const b of bannedPatterns) {
      if (!b.appliesTo.includes('shell')) continue;
      if (!isSafeBoundedRegex(b?.pattern)) continue;
      try {
        const re = new RegExp(b.pattern, b.flags && /^[im]{0,2}$/.test(b.flags) ? b.flags : '');
        if (re.test(cmd)) {
          const quote = String(b.quote || 'Matches falsified tombstone pattern').slice(0, 220);
          const src = b.source ? ` (${String(b.source).slice(0, 40)})` : '';
          const reopen = b.reopenIf ? ` [reopen-if: ${String(b.reopenIf).slice(0, 100)}]` : '';
          return {
            decision: 'force_ask',
            reason: `[AGY Studio Tombstone Guard] Command hits locked dead-end '${b.id || b.pattern}'${src}: "${quote}"${reopen}`,
          };
        }
      } catch {}
    }
  }

  return { decision: 'allow' };
}

function loadConvAnchorState(pluginDataDir, cid) {
  const defaultState = {
    byteOffset: 0,
    transcriptCheckpoints: 0,
    lastNudgedCompactionGen: 0,
    mutedHashes: [],
    loopSig: '',
    loopCount: 0,
    escalatedLoopSigs: [],
  };
  if (!cid) return { stateFile: '', state: defaultState };
  const stateFile = path.join(pluginDataDir, `${cid}.json`);
  const existing = readJsonSafe(stateFile, null);
  return {
    stateFile,
    state: existing && typeof existing === 'object' ? { ...defaultState, ...existing } : defaultState,
  };
}

export function evaluateActionLoopPostToolUse(payload, opts = {}) {
  const paths = resolveAnchorPaths(opts);
  if (!isAnchorsEnabled(paths.prefsFile)) return {};
  const cid = getSafeCid(payload?.conversationId);
  if (!cid) return {};

  const toolName = String(payload?.toolCall?.name || '').toLowerCase();
  if (!toolName) return {};
  const args = payload?.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
  const outText = String(payload?.toolResult?.output || payload?.output || '');
  const exitMatch = outText.match(/Command exited with code (\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : payload?.toolResult?.isError ? 1 : 0;
  const failed = exitCode !== 0 || Boolean(payload?.toolResult?.isError);

  const { stateFile, state } = loadConvAnchorState(paths.pluginDataDir, cid);
  if (!failed) {
    if (state.loopCount > 0) {
      state.loopSig = '';
      state.loopCount = 0;
      writeAtomicJson(stateFile, state);
    }
    return {};
  }

  let targetKey = '';
  if (toolName === 'run_command') {
    const cmd = String(args.CommandLine || args.command || '').trim().replace(/\s+/g, ' ');
    targetKey = cmd.slice(0, 80);
  } else {
    targetKey = String(args.Path || args.TargetFile || args.path || '').trim();
  }
  if (!targetKey) return {};

  const sig = `${toolName}|${targetKey}|exit:${exitCode}`;
  if (state.loopSig === sig) {
    state.loopCount = (Number(state.loopCount) || 0) + 1;
  } else {
    state.loopSig = sig;
    state.loopCount = 1;
  }

  const escalated = new Set(Array.isArray(state.escalatedLoopSigs) ? state.escalatedLoopSigs : []);
  if (state.loopCount >= ACTION_LOOP_THRESHOLD && !escalated.has(sig)) {
    escalated.add(sig);
    state.escalatedLoopSigs = Array.from(escalated).slice(-32);
    const prefs = readJsonSafe(paths.prefsFile, {}) || {};
    if (prefs.opusGateMode !== 'off') {
      const opusPropFile = path.join(paths.opusProposalsDir, `${cid}.json`);
      const existingProp = readJsonSafe(opusPropFile, null);
      if (!existingProp || existingProp.dismissed === true) {
        writeAtomicJson(opusPropFile, {
          id: `loop-${sha1Short(sig)}-${Date.now()}`,
          cid,
          kind: 'debug',
          trigger: 'action_loop',
          reason: `Repeated failure (${state.loopCount}x) on ${toolName}: ${targetKey.slice(0, 60)}`,
          diffHash: sha1Short(sig),
          ts: Date.now(),
          createdAt: Date.now(),
          dismissed: false,
        });
      }
    }
  }

  writeAtomicJson(stateFile, state);
  return {};
}

export function renderAnchorsMarkdownFile(anchors) {
  const items = Array.isArray(anchors) ? anchors : [];
  if (items.length === 0) return '';
  const lines = [
    '<!-- BEGIN maga-anchors-local -->',
    '## Active Local Anchors (Human-Approved Verbatim Constraints)',
    '',
  ];
  for (const a of items) {
    const id = String(a.id || '').trim();
    const quote = String(a.text || '').replace(/\r?\n+/g, ' ').trim();
    if (!id || !quote) continue;
    const src = a.sourceTurn ? ` (${String(a.sourceTurn)})` : '';
    lines.push(`- \`[${id}]\`${src}: "${quote}"`);
  }
  lines.push('<!-- END maga-anchors-local -->', '');
  return lines.join('\n');
}

export function flushQueuedAnchorWritesForRepo(gitRoots, opts = {}) {
  if (!gitRoots?.topLevel) return { flushed: false };
  const paths = resolveAnchorPaths(opts);
  const repoHash = normalizeRepoKeyHash(gitRoots.mainRoot || gitRoots.topLevel);
  const queueFile = path.join(paths.pendingWritesDir, `${repoHash}.json`);
  const claimedFile = `${queueFile}.flushing-${process.pid}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
  try {
    fs.renameSync(queueFile, claimedFile);
  } catch {
    return { flushed: false };
  }

  try {
    const queued = readJsonSafe(claimedFile, null);
    if (!queued || !Array.isArray(queued.anchors)) return { flushed: false };

    // Ensure `.agents/rules/anchors.local.md` & `.anchors-meta.json` are excluded in `<commonDir>/info/exclude`
    if (gitRoots.commonDir) {
      const excludeFile = path.join(gitRoots.commonDir, 'info', 'exclude');
      try {
        const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
        const lineSet = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
        if (!lineSet.has('/.agents') && !lineSet.has('.agents')) {
          const missing = [];
          for (const reqLine of ['/.agents/rules/anchors.local.md', '/.agents/rules/.anchors-meta.json']) {
            if (!lineSet.has(reqLine) && !lineSet.has(reqLine.slice(1))) {
              missing.push(reqLine);
            }
          }
          if (missing.length > 0) {
            const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
            writeAtomicText(excludeFile, `${existing}${prefix}${missing.join('\n')}\n`);
          }
        }
      } catch {}
    }

    // Write strictly sanitized verbatim user quotes (NEVER thinking snippets -> I12/I16!)
    const safeAnchors = [];
    let usedTokens = 0;
    for (const raw of queued.anchors) {
      const text = String(raw?.text || '').replace(/\r?\n+/g, ' ').trim();
      if (!text) continue;
      const tok = estimateRuleTokens(text);
      if (usedTokens + tok > MAX_ANCHOR_TOKENS) continue;
      usedTokens += tok;
      safeAnchors.push({
        id: String(raw.id || sha1Short(text)).slice(0, 16),
        text,
        sourceTurn: raw.sourceTurn ? String(raw.sourceTurn).slice(0, 32) : '',
        acceptedAt: Number(raw.acceptedAt) || Date.now(),
      });
    }

    for (const rootDir of new Set([gitRoots.mainRoot, gitRoots.topLevel].filter(Boolean))) {
      const targetMd = path.join(rootDir, '.agents', 'rules', 'anchors.local.md');
      const metaJson = path.join(rootDir, '.agents', 'rules', '.anchors-meta.json');
      if (safeAnchors.length === 0) {
        try {
          fs.rmSync(targetMd, { force: true });
          fs.rmSync(metaJson, { force: true });
        } catch {}
      } else {
        writeAtomicText(targetMd, renderAnchorsMarkdownFile(safeAnchors));
        writeAtomicJson(metaJson, { schema: 1, usedTokens, maxTokens: MAX_ANCHOR_TOKENS, anchors: safeAnchors });
      }
    }

    return { flushed: true, count: safeAnchors.length, usedTokens };
  } finally {
    try {
      fs.rmSync(claimedFile, { force: true });
    } catch {}
  }
}

function extractCleanUserRequestText(rawContent) {
  let s = String(rawContent || '');
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (m) s = m[1];
  else s = s.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '').replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  // Strip fenced code blocks & inline blockquotes so pasted logs/code never trigger false positives
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('>'))
    .join('\n')
    .trim();
  return s;
}

export function extractCandidateCorrectionParagraphs(cleanUserText) {
  if (!cleanUserText || cleanUserText.length < 10) return [];
  const out = [];
  const paragraphs = cleanUserText
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const para of paragraphs) {
    if (para.length < 10 || para.length > 360) continue;
    if (/[?？]$/.test(para) && !/不能|严禁|不准|must\s+not|never|don['’]t/i.test(para)) continue;
    if (CORRECTION_CUE_RE.test(para)) {
      out.push(para.slice(0, 280));
    }
  }
  return out;
}

export function scanTranscriptTailForProposals(transcriptFullPath, { byteOffset = 0, mutedHashes = [] } = {}) {
  if (!transcriptFullPath || !fs.existsSync(transcriptFullPath)) {
    return { nextByteOffset: 0, checkpointCount: 0, candidates: [] };
  }
  const st = fs.statSync(transcriptFullPath);
  let startOffset = Number(byteOffset) >= 0 ? Number(byteOffset) : 0;
  let skippedPrefix = false;
  // Reset cursor if file shrunk/rotated
  if (st.size < startOffset) {
    startOffset = 0;
  }
  if (st.size === startOffset) {
    return { nextByteOffset: startOffset, checkpointCount: 0, candidates: [] };
  }
  if (st.size - startOffset > MAX_TAIL_READ_BYTES) {
    startOffset = st.size - MAX_TAIL_READ_BYTES;
    skippedPrefix = true;
  }

  const readLen = st.size - startOffset;
  const buf = Buffer.alloc(readLen);
  const fd = fs.openSync(transcriptFullPath, 'r');
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buf, 0, readLen, startOffset);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
  if (bytesRead <= 0) {
    return { nextByteOffset: startOffset, checkpointCount: 0, candidates: [] };
  }

  const validSlice = buf.subarray(0, bytesRead);
  // Read ONLY up to the last complete `\n` (0x0A) so multi-byte UTF-8 characters are never split!
  const lastNl = validSlice.lastIndexOf(0x0a);
  if (lastNl === -1) {
    return { nextByteOffset: startOffset, checkpointCount: 0, candidates: [] };
  }

  let sliceStart = 0;
  if (skippedPrefix) {
    const firstNl = validSlice.indexOf(0x0a);
    if (firstNl === -1 || firstNl >= lastNl) {
      return { nextByteOffset: startOffset + lastNl + 1, checkpointCount: 0, candidates: [] };
    }
    sliceStart = firstNl + 1;
  }

  const nextByteOffset = startOffset + lastNl + 1;
  const textChunk = validSlice.subarray(sliceStart, lastNl + 1).toString('utf8');
  const lines = textChunk.split('\n').filter(Boolean);

  const steps = [];
  let checkpointCount = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        if (parsed.type === 'CHECKPOINT') checkpointCount += 1;
        steps.push(parsed);
      }
    } catch {}
  }

  const mutedSet = new Set(Array.isArray(mutedHashes) ? mutedHashes : []);
  const candidates = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.source !== 'USER_EXPLICIT' || step.type !== 'USER_INPUT') continue;
    const cleanUser = extractCleanUserRequestText(step.content);
    const matchedParas = extractCandidateCorrectionParagraphs(cleanUser);
    if (matchedParas.length === 0) continue;

    // Pair with the immediately following MODEL PLANNER_RESPONSE `thinking` comprehension preview
    let nextThinking = '';
    for (let j = i + 1; j < Math.min(steps.length, i + 5); j += 1) {
      if (steps[j].source === 'USER_EXPLICIT' && steps[j].type === 'USER_INPUT') break;
      if (steps[j].source === 'MODEL' && steps[j].type === 'PLANNER_RESPONSE' && typeof steps[j].thinking === 'string' && steps[j].thinking.trim()) {
        nextThinking = redactSensitiveText(steps[j].thinking.trim().replace(/\s+/g, ' ')).slice(0, 220);
        break;
      }
    }

    for (const verbatimQuote of matchedParas) {
      const redactedQuote = redactSensitiveText(verbatimQuote);
      const quoteHash = sha1Short(redactedQuote);
      if (mutedSet.has(quoteHash)) continue;
      candidates.push({
        id: `anc-${quoteHash}`,
        quoteHash,
        verbatimQuote: redactedQuote,
        thinkingPreview: nextThinking,
        stepIndex: Number.isFinite(Number(step.step_index)) ? Number(step.step_index) : i,
        createdAt: step.created_at || new Date().toISOString(),
      });
    }
  }

  return { nextByteOffset, checkpointCount, candidates };
}

export function readCompactionGenerationCount(cid, opts = {}) {
  const safeCid = getSafeCid(cid);
  if (!safeCid || !DatabaseSync) return 0;
  const { conversationsDir } = resolveAnchorPaths(opts);
  const dbPath = path.join(conversationsDir, `${safeCid}.db`);
  if (!fs.existsSync(dbPath)) return 0;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 40 });
    try {
      const row = db
        .prepare('SELECT COUNT(*) AS cnt FROM steps WHERE step_type = 23 AND status > 0 AND status <= 3')
        .get();
      return Number(row?.cnt || 0);
    } catch {
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM steps WHERE step_type = 23').get();
      return Number(row?.cnt || 0);
    }
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function evaluateStopBoundary(payload, opts = {}) {
  const paths = resolveAnchorPaths(opts);
  const rawCwd = payload?.cwd || process.cwd();
  const gitRoots = resolveGitRoots(rawCwd);

  // 1. Always flush any human-accepted pending `.agents/rules/anchors.local.md` write at the Stop boundary
  if (gitRoots) {
    flushQueuedAnchorWritesForRepo(gitRoots, opts);
  }

  if (!isAnchorsEnabled(paths.prefsFile)) return {};

  const cid = getSafeCid(payload?.conversationId);
  if (!cid) return {};

  const { stateFile, state } = loadConvAnchorState(paths.pluginDataDir, cid);

  // 2. Resolve `transcript_full.jsonl`
  let transcriptFullPath = '';
  if (typeof payload?.transcriptPath === 'string' && payload.transcriptPath.trim()) {
    const sibling = path.join(path.dirname(payload.transcriptPath.trim()), 'transcript_full.jsonl');
    if (fs.existsSync(sibling)) transcriptFullPath = sibling;
    else if (fs.existsSync(payload.transcriptPath.trim())) transcriptFullPath = payload.transcriptPath.trim();
  }
  if (!transcriptFullPath) {
    const fallback = path.join(paths.brainDir, cid, '.system_generated', 'logs', 'transcript_full.jsonl');
    if (fs.existsSync(fallback)) transcriptFullPath = fallback;
  }

  if (transcriptFullPath) {
    const prevByteOffset = Number(state.byteOffset) || 0;
    const scanRes = scanTranscriptTailForProposals(transcriptFullPath, {
      byteOffset: prevByteOffset,
      mutedHashes: state.mutedHashes,
    });
    state.byteOffset = scanRes.nextByteOffset;
    if (scanRes.nextByteOffset < prevByteOffset) {
      state.transcriptCheckpoints = scanRes.checkpointCount;
    } else {
      state.transcriptCheckpoints = (Number(state.transcriptCheckpoints) || 0) + scanRes.checkpointCount;
    }

    if (scanRes.candidates.length > 0) {
      const propFile = path.join(paths.proposalsDir, `${cid}.json`);
      const existingDoc = readJsonSafe(propFile, { schema: 1, cid, proposals: [] });
      const activeList = Array.isArray(existingDoc?.proposals)
        ? existingDoc.proposals.filter((p) => p && !p.dismissed && !p.accepted)
        : [];
      const seenHashes = new Set(activeList.map((p) => p.quoteHash));
      for (const cand of scanRes.candidates) {
        if (seenHashes.has(cand.quoteHash)) continue;
        seenHashes.add(cand.quoteHash);
        activeList.push({
          ...cand,
          repoRoot: gitRoots?.mainRoot || gitRoots?.topLevel || rawCwd,
          ts: Date.now(),
        });
      }
      const bounded = activeList.slice(-MAX_PROPOSALS_PER_CONV);
      writeAtomicJson(propFile, { schema: 1, cid, updatedAt: Date.now(), proposals: bounded });
    }
  }

  // 3. Compaction generation `G >= 3` zero-model-token inline user notice
  const sqlGen = readCompactionGenerationCount(cid, opts);
  const compactionGen = Math.max(sqlGen, Number(state.transcriptCheckpoints) || 0);
  let out = {};
  if (compactionGen >= 3 && (Number(state.lastNudgedCompactionGen) || 0) < compactionGen) {
    state.lastNudgedCompactionGen = compactionGen;
    const zh = isZhUiConfigured(paths, opts);
    out = {
      systemMessage: '',
      metadata: {
        user_markdown: zh
          ? `💡 **AGY Studio Anti-Drift**: 当前会话已完成 **G=${compactionGen}** 次上下文压缩（未固化约束半衰期约 2–3 次压缩）。可点击底栏 **G${compactionGen}** 徽章将关键约束固化至仓库锚点，或一键交接至全新里程碑会话。`
          : `💡 **AGY Studio Anti-Drift**: This chat has undergone **G=${compactionGen}** compactions (unanchored constraints decay after ~2–3 compactions). Click the **G${compactionGen}** dock pill to pin key constraints or hand off cleanly to a fresh milestone chat.`,
      },
    };
  }

  state.mutedHashes = Array.isArray(state.mutedHashes) ? state.mutedHashes.slice(-MAX_MUTED_HASHES) : [];
  writeAtomicJson(stateFile, state);
  return out;
}

export function runAnchorGuardCli(opts = {}) {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8').trim();
    const payload = raw ? JSON.parse(raw) : {};
    const ev = String(payload?.hookEventName || '');
    if (ev === 'PreToolUse' || (!ev && payload?.toolCall)) {
      process.stdout.write(`${JSON.stringify(evaluateLocksPreToolUse(payload, opts))}\n`);
      return;
    }
    if (ev === 'PostToolUse') {
      process.stdout.write(`${JSON.stringify(evaluateActionLoopPostToolUse(payload, opts))}\n`);
      return;
    }
    if (ev === 'Stop') {
      process.stdout.write(`${JSON.stringify(evaluateStopBoundary(payload, opts))}\n`);
      return;
    }
    process.stdout.write('{}\n');
  } catch {
    const isPre = raw.includes('PreToolUse') || raw.includes('"toolCall"');
    process.stdout.write(`${JSON.stringify(isPre ? { decision: 'allow' } : {})}\n`);
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    return realpathNative(fileURLToPath(import.meta.url)) === realpathNative(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
})();

if (isMain) {
  runAnchorGuardCli();
}
