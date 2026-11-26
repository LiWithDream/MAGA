#!/usr/bin/env node
/**
 * Canonical MAGA Global Git Workflow Guardrail Engine (`maga-git-workflow`).
 * Enforces 3-tier per-project workflow policies (`observe` | `protect-main` | `worktree-only`),
 * auto-records per-conversation linked worktree attribution across all Git projects,
 * prevents policy/plugin/hook tampering, and defers safely to verified repo-local guardrails.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CASE_INSENSITIVE_FS,
  DEFAULT_PROTECTED_BRANCHES,
  SAFE_CID_RE,
  getProtectedBranchesForRepo,
  getRealPathPreserveCase,
  normalizePolicyKey,
  withFileLock,
  writeAtomicUtf8,
} from '../lib/worktree-core.mjs';

export const PROTECTED_BRANCHES = DEFAULT_PROTECTED_BRANCHES;
export const VALID_WORKFLOW_MODES = ['observe', 'protect-main', 'worktree-only'];
const VALID_MODE_SET = new Set(VALID_WORKFLOW_MODES);

const HOOK_RECORD_THROTTLE_MS = 30_000;
const DENY_EVENTS_MAX = 200;
const WT_CLI_DISPLAY_PATH = '~/.gemini/config/plugins/maga-git-workflow/bin/wt.mjs';

const MUTATING_GIT_SUBCOMMANDS = new Set([
  'add',
  'commit',
  'checkout',
  'switch',
  'merge',
  'rebase',
  'cherry-pick',
  'reset',
  'stash',
  'restore',
  'rm',
  'mv',
  'apply',
  'am',
  'tag',
  'pull',
]);

const FILE_EDIT_TOOLS = new Set([
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
]);

const GIT_GLOBAL_BOOL_FLAGS = new Set([
  '--no-pager',
  '-p',
  '--paginate',
  '--bare',
  '--literal-pathspecs',
  '-P',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '--no-optional-locks',
  '--no-advice',
  '-h',
  '--help',
  '-v',
  '--version',
]);

const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROTECTED_REFSPEC_BASE_RE = /^\+?([^:]*:)?(refs\/heads\/)?([^\s]+)$/;
const ENGINE_MARKER_RE = /studio[\\/]plugin[\\/]maga-git-workflow[\\/]hooks[\\/]git-guard\.mjs|\.githooks[\\/]guard-main-branch\.mjs/;
const SHELL_TAMPER_SUSPECT_RE = /git-workflow-policy\.json|maga-git-workflow|\.agents[\\/]hooks/;
const SHELL_MUTATING_BINS = new Set([
  'tee',
  'rm',
  'rmdir',
  'unlink',
  'mv',
  'cp',
  'install',
  'ln',
  'truncate',
  'chmod',
  'chown',
  'chflags',
  'touch',
  'dd',
  'shred',
  'sponge',
]);
const INLINE_SCRIPT_RUNNERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl', 'osascript']);
const INLINE_WRITE_HINT_RE = /\b(?:write|writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rm|rmSync|rmdir|rename|renameSync|copyFile|copyFileSync|chmod|chmodSync|truncate|truncateSync|open|mkdir|mkdirSync)\b/i;

function gitExecEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
}

function getDefaultStateDir(explicit) {
  return path.resolve(
    explicit || process.env.ANTI_CLAUDE_STATE_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'anti-claude')
  );
}

function getDefaultPluginsDir(explicit) {
  return path.resolve(
    explicit || process.env.ANTI_CLAUDE_PLUGINS_DIR || path.join(os.homedir(), '.gemini', 'config', 'plugins')
  );
}

function expandHome(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return inputPath;
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
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
    realBase = fs.realpathSync(cur);
  } catch {}
  return tail.length > 0 ? path.join(realBase, ...tail) : realBase;
}

export function isInsideDir(targetPath, baseDir) {
  if (!targetPath || !baseDir) return false;
  const resolvedTarget = resolveExistingPrefixRealpath(targetPath);
  const resolvedBase = resolveExistingPrefixRealpath(baseDir);
  const a = CASE_INSENSITIVE_FS ? resolvedTarget.toLowerCase() : resolvedTarget;
  const b = CASE_INSENSITIVE_FS ? resolvedBase.toLowerCase() : resolvedBase;
  const rel = path.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function splitShellSegmentsWithOps(commandLine) {
  if (!commandLine || typeof commandLine !== 'string') return [];
  const segments = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let sepBefore = '';

  const flush = (sepAfter = '') => {
    const trimmed = buf.trim();
    if (trimmed) {
      segments.push({ text: trimmed, sepBefore, sepAfter });
    }
    buf = '';
    sepBefore = sepAfter;
  };

  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i];
    const next = commandLine[i + 1];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }

    if (inSingle) {
      if (ch === "'") inSingle = false;
      buf += ch;
      continue;
    }

    if (inDouble) {
      if (ch === '\\') {
        escaped = true;
        buf += ch;
        continue;
      }
      if (ch === '"') inDouble = false;
      buf += ch;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      buf += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      buf += ch;
      continue;
    }

    if (ch === ';' || ch === '\n' || ch === '\r') {
      flush(';');
      continue;
    }

    if (ch === '&' && next === '&') {
      flush('&&');
      i += 1;
      continue;
    }

    if (ch === '|') {
      if (next === '|') {
        flush('||');
        i += 1;
      } else {
        flush('|');
      }
      continue;
    }

    buf += ch;
  }

  flush('');
  return segments;
}

export function splitShellSegments(commandLine) {
  return splitShellSegmentsWithOps(commandLine).map((s) => s.text);
}

function stripUnquotedGroupDelimiters(segmentText) {
  let s = String(segmentText || '').trim();
  while (s.startsWith('(') || s.startsWith('{')) {
    if (s.startsWith('{') && !/^\{\s/.test(s) && s !== '{') break;
    s = s.slice(1).trimStart();
  }
  while (s.endsWith(')') || s.endsWith('}')) {
    const last = s[s.length - 1];
    const prev = s.length >= 2 ? s[s.length - 2] : '';
    if (prev === "'" || prev === '"' || prev === '\\') break;
    // Do not strip balanced quoting or ${var}
    if (last === '}' && /\$\{[^}]*\}$/.test(s)) break;
    if (last === ')' && /\$\([^)]*\)$/.test(s)) break;
    s = s.slice(0, -1).trimEnd();
  }
  return s;
}

function tryExpandDollar(segment, idx, shellVars) {
  if (!shellVars || shellVars.size === 0) return null;
  const next = segment[idx + 1];
  if (!next || next === '(' || next === '`') return null;

  if (next === '{') {
    const closeIdx = segment.indexOf('}', idx + 2);
    if (closeIdx === -1) return null;
    const inner = segment.slice(idx + 2, closeIdx);
    if (!VAR_NAME_RE.test(inner) || !shellVars.has(inner)) return null;
    return { value: shellVars.get(inner), nextIndex: closeIdx };
  }

  if (!/[A-Za-z_]/.test(next)) return null;
  let end = idx + 2;
  while (end < segment.length && /[A-Za-z0-9_]/.test(segment[end])) {
    end += 1;
  }
  const name = segment.slice(idx + 1, end);
  if (!shellVars.has(name)) return null;
  return { value: shellVars.get(name), nextIndex: end - 1 };
}

export function tokenizeSegment(segment, shellVars = null) {
  if (!segment || typeof segment !== 'string') return [];
  const tokens = [];
  let current = '';
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushToken = () => {
    if (hasToken) {
      tokens.push(current);
      current = '';
      hasToken = false;
    }
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];

    if (escaped) {
      current += ch;
      hasToken = true;
      escaped = false;
      continue;
    }

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
        hasToken = true;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '\\') {
        const next = segment[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          escaped = true;
        } else if (next === '\n') {
          i += 1;
        } else {
          current += ch;
          hasToken = true;
        }
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '$') {
        const exp = tryExpandDollar(segment, i, shellVars);
        if (exp) {
          current += exp.value;
          i = exp.nextIndex;
        } else {
          current += ch;
        }
        hasToken = true;
      } else {
        current += ch;
        hasToken = true;
      }
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      hasToken = true;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      hasToken = true;
      continue;
    }

    if (ch === '$') {
      const exp = tryExpandDollar(segment, i, shellVars);
      if (exp) {
        current += exp.value;
        i = exp.nextIndex;
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }

    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }

    current += ch;
    hasToken = true;
  }

  if (escaped) {
    current += '\\';
    hasToken = true;
  }
  pushToken();
  return tokens;
}

function isGitBinary(token) {
  if (!token) return false;
  return token === 'git' || path.basename(token) === 'git';
}

function parseCommandWrapper(tokens) {
  const env = {};
  let idx = 0;

  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === '(' || tok === '{' || tok === '}' || tok === ')') {
      idx += 1;
      continue;
    }
    const m = tok.match(ENV_ASSIGNMENT_RE);
    if (m) {
      env[m[1]] = m[2];
      idx += 1;
      continue;
    }

    const base = path.basename(tok);
    if (base === 'env') {
      idx += 1;
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const flag = tokens[idx];
        idx += 1;
        if ((flag === '-u' || flag === '--unset' || flag === '-C' || flag === '--chdir') && idx < tokens.length) {
          idx += 1;
        }
      }
      continue;
    }

    if (base === 'command' || base === 'nohup' || base === 'time') {
      idx += 1;
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        idx += 1;
      }
      continue;
    }

    if (base === 'sudo') {
      idx += 1;
      const SUDO_VAL_FLAGS = new Set(['-u', '--user', '-g', '--group', '-C', '--close-from', '-h', '--host', '-p', '--prompt', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout']);
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const flag = tokens[idx];
        idx += 1;
        if (SUDO_VAL_FLAGS.has(flag) && idx < tokens.length) idx += 1;
      }
      continue;
    }

    if (base === 'nice') {
      idx += 1;
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const flag = tokens[idx];
        idx += 1;
        if ((flag === '-n' || flag === '--adjustment') && idx < tokens.length) idx += 1;
      }
      continue;
    }

    if (base === 'xargs') {
      idx += 1;
      const XARGS_VAL_FLAGS = new Set(['-I', '-i', '-J', '-L', '-l', '-n', '-P', '-s', '-E', '-d', '-a', '--arg-file', '--delimiter', '--eof', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--replace']);
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        const flag = tokens[idx];
        idx += 1;
        if (XARGS_VAL_FLAGS.has(flag) && idx < tokens.length) idx += 1;
      }
      continue;
    }

    break;
  }

  return { env, cmdTokens: tokens.slice(idx) };
}

function extractInlineShellString(cmdTokens) {
  if (!Array.isArray(cmdTokens) || cmdTokens.length < 2) return '';
  const base = path.basename(cmdTokens[0]);
  if (base !== 'sh' && base !== 'bash' && base !== 'zsh') return '';
  for (let i = 1; i < cmdTokens.length; i += 1) {
    const tok = cmdTokens[i];
    if (tok === '-c' || tok === '-lc' || tok === '-ec' || tok === '-xc' || /^-[a-z]*c$/.test(tok)) {
      return typeof cmdTokens[i + 1] === 'string' ? cmdTokens[i + 1] : '';
    }
    if (!tok.startsWith('-')) break;
  }
  return '';
}

function extractGitInvocationsDetailed(commandLine, initialCwd = process.cwd(), depth = 0) {
  const segments = splitShellSegmentsWithOps(commandLine);
  const invocations = [];
  const shellVars = new Map();
  let currentDir = path.resolve(expandHome(initialCwd) || process.cwd());
  let prevDir = currentDir;

  for (const seg of segments) {
    const inPipeline = seg.sepBefore === '|' || seg.sepAfter === '|';
    const cleanedSegText = stripUnquotedGroupDelimiters(seg.text);
    const rawTokens = tokenizeSegment(cleanedSegText, shellVars);
    if (rawTokens.length === 0) continue;

    if (rawTokens[0] === 'export' && rawTokens.length > 1) {
      if (!inPipeline) {
        for (const tok of rawTokens.slice(1)) {
          const m = tok.match(ENV_ASSIGNMENT_RE);
          if (m) shellVars.set(m[1], m[2]);
        }
      }
      continue;
    }

    const { env, cmdTokens } = parseCommandWrapper(rawTokens);

    if (cmdTokens.length === 0) {
      if (!inPipeline) {
        for (const [k, v] of Object.entries(env)) {
          shellVars.set(k, v);
        }
      }
      continue;
    }

    if (cmdTokens[0] === 'cd') {
      if (inPipeline) continue;
      let argIdx = 1;
      if (cmdTokens[argIdx] === '--') argIdx += 1;
      const rawTarget = cmdTokens[argIdx];
      let nextDir = currentDir;
      if (!rawTarget) {
        nextDir = os.homedir();
      } else if (rawTarget === '-') {
        nextDir = prevDir;
      } else {
        nextDir = path.resolve(currentDir, expandHome(rawTarget));
      }
      prevDir = currentDir;
      currentDir = nextDir;
      continue;
    }

    if (depth === 0) {
      const inlineShell = extractInlineShellString(cmdTokens);
      if (inlineShell) {
        const nested = extractGitInvocationsDetailed(inlineShell, currentDir, depth + 1);
        for (const subInv of nested.invocations) {
          invocations.push({
            ...subInv,
            env: { ...env, ...subInv.env },
          });
        }
        continue;
      }
    }

    if (!isGitBinary(cmdTokens[0])) continue;

    let targetDir = currentDir;
    let i = 1;
    while (i < cmdTokens.length) {
      const tok = cmdTokens[i];
      if (tok === '--') {
        i += 1;
        break;
      }
      if (!tok.startsWith('-') || tok === '-') {
        break;
      }

      if (tok === '-C' && i + 1 < cmdTokens.length) {
        targetDir = path.resolve(targetDir, expandHome(cmdTokens[i + 1]));
        i += 2;
        continue;
      }
      if (tok.startsWith('-C') && tok.length > 2) {
        targetDir = path.resolve(targetDir, expandHome(tok.slice(2)));
        i += 1;
        continue;
      }
      if (tok.startsWith('--work-tree=')) {
        const wt = tok.slice('--work-tree='.length);
        if (wt) targetDir = path.resolve(targetDir, expandHome(wt));
        i += 1;
        continue;
      }
      if (tok === '--work-tree' && i + 1 < cmdTokens.length) {
        targetDir = path.resolve(targetDir, expandHome(cmdTokens[i + 1]));
        i += 2;
        continue;
      }

      const eqIdx = tok.indexOf('=');
      if (eqIdx > 0 && GIT_GLOBAL_VALUE_FLAGS.has(tok.slice(0, eqIdx))) {
        i += 1;
        continue;
      }
      if (tok.startsWith('--exec-path=')) {
        i += 1;
        continue;
      }
      if (GIT_GLOBAL_VALUE_FLAGS.has(tok) && i + 1 < cmdTokens.length) {
        i += 2;
        continue;
      }
      if (tok.startsWith('-c') && tok.length > 2) {
        i += 1;
        continue;
      }
      if (GIT_GLOBAL_BOOL_FLAGS.has(tok)) {
        i += 1;
        continue;
      }

      i += 1;
    }

    const subcommand = cmdTokens[i] || '';
    const subArgs = subcommand ? cmdTokens.slice(i + 1) : [];
    if (subcommand) {
      invocations.push({
        targetDir,
        subcommand,
        subArgs,
        env,
      });
    }
  }

  return { invocations, finalDir: currentDir };
}

export function extractGitInvocations(commandLine, initialCwd = process.cwd()) {
  return extractGitInvocationsDetailed(commandLine, initialCwd).invocations;
}

function findNearestGitCandidateDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') {
    return { existingDir: '', hasGitHint: false, gitHintRoot: '', isBareHint: false };
  }
  let cur = path.resolve(expandHome(dirPath));
  while (true) {
    try {
      const st = fs.statSync(cur, { throwIfNoEntry: false });
      if (st && st.isDirectory()) break;
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) {
      return { existingDir: '', hasGitHint: false, gitHintRoot: '', isBareHint: false };
    }
    cur = parent;
  }

  let probe = cur;
  while (true) {
    try {
      const gitEntry = fs.lstatSync(path.join(probe, '.git'), { throwIfNoEntry: false });
      if (gitEntry) return { existingDir: cur, hasGitHint: true, gitHintRoot: probe, isBareHint: false };
      const headEntry = fs.lstatSync(path.join(probe, 'HEAD'), { throwIfNoEntry: false });
      const objEntry = fs.lstatSync(path.join(probe, 'objects'), { throwIfNoEntry: false });
      if (headEntry && objEntry && objEntry.isDirectory()) {
        return { existingDir: cur, hasGitHint: true, gitHintRoot: probe, isBareHint: true };
      }
    } catch {}
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  return { existingDir: cur, hasGitHint: false, gitHintRoot: '', isBareHint: false };
}

function buildFailClosedFallbackCtx(targetDir, detailed) {
  const hintRoot = getRealPathPreserveCase(detailed?.gitHintRoot || targetDir);
  let commonDir = detailed?.isBareHint ? hintRoot : path.join(hintRoot, '.git');
  let mainRoot = hintRoot;
  try {
    const dotGit = path.join(hintRoot, '.git');
    const st = fs.lstatSync(dotGit, { throwIfNoEntry: false });
    if (st && st.isFile()) {
      const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (m) {
        const wtGitDir = path.resolve(hintRoot, m[1].trim());
        const commonRel = fs.readFileSync(path.join(wtGitDir, 'commondir'), 'utf8').trim();
        if (commonRel) {
          commonDir = getRealPathPreserveCase(path.resolve(wtGitDir, commonRel));
          if (path.basename(commonDir) === '.git') mainRoot = path.dirname(commonDir);
        }
      }
    }
  } catch {}
  return {
    topLevel: hintRoot,
    commonDir,
    commonDirKey: normalizePolicyKey(commonDir),
    mainRoot,
  };
}

export function resolveGitContextDetailed(dirPath) {
  const { existingDir, hasGitHint, gitHintRoot, isBareHint } = findNearestGitCandidateDir(dirPath);
  if (!existingDir || !hasGitHint) {
    return { ctx: null, error: null, hasGitHint: false, gitHintRoot: '', isBareHint: false };
  }

  let topAndGit = '';
  try {
    topAndGit = execFileSync('git', ['-C', existingDir, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], {
      encoding: 'utf8',
      timeout: 2000,
      env: gitExecEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const timedOut = Boolean(err?.killed && err?.signal === 'SIGTERM');
    return {
      ctx: null,
      error: timedOut ? 'git rev-parse timed out' : `git rev-parse failed (${String(err?.message || 'error').split('\n')[0]})`,
      hasGitHint: true,
      gitHintRoot,
      isBareHint,
    };
  }

  const lines = topAndGit.trim().split(/\r?\n/);
  if (lines.length < 3) {
    return { ctx: null, error: null, hasGitHint: true, gitHintRoot, isBareHint };
  }

  const topLevel = getRealPathPreserveCase(lines[0].trim());
  const gitDir = getRealPathPreserveCase(path.resolve(existingDir, lines[1].trim()));
  const commonDir = getRealPathPreserveCase(path.resolve(existingDir, lines[2].trim()));
  const commonDirKey = normalizePolicyKey(commonDir);
  const isLinkedWorktree = normalizePolicyKey(gitDir) !== commonDirKey;
  const mainRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : topLevel;

  let branch = null;
  let detached = false;
  try {
    const out = execFileSync('git', ['-C', existingDir, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      env: gitExecEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    branch = out || null;
  } catch {
    branch = null;
    detached = true;
  }

  const merging = fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
  return {
    ctx: {
      topLevel,
      gitDir,
      commonDir,
      commonDirKey,
      mainRoot,
      branch,
      detached,
      merging,
      isLinkedWorktree,
    },
    error: null,
    hasGitHint: true,
  };
}

export function resolveGitContext(dirPath) {
  return resolveGitContextDetailed(dirPath).ctx;
}

function isUnbornHead(dirPath) {
  if (!dirPath) return { unborn: false, error: 'missing_dir' };
  const res = spawnSync('git', ['-C', dirPath, 'rev-parse', '--verify', '-q', 'HEAD'], {
    encoding: 'utf8',
    timeout: 1200,
    env: gitExecEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) {
    return { unborn: false, error: `git HEAD verification failed (${res.error.code || res.error.message})` };
  }
  if (res.status === 0) return { unborn: false, error: null };
  if (res.status === 1 && !String(res.stderr || '').trim()) {
    return { unborn: true, error: null };
  }
  return { unborn: false, error: `git HEAD verification failed (exit ${res.status})` };
}

export function readWorkflowPolicy({ stateDir = '' } = {}) {
  const dir = getDefaultStateDir(stateDir);
  const policyFile = path.join(dir, 'git-workflow-policy.json');
  const defaults = {
    schema: 1,
    defaultMode: 'observe',
    blockForcePushProtected: true,
    blockPushTags: false,
    projects: {},
  };
  try {
    if (!fs.existsSync(policyFile)) return defaults;
    const raw = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
    const defaultMode = VALID_MODE_SET.has(raw.defaultMode) ? raw.defaultMode : 'observe';
    const projects = raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects) ? raw.projects : {};
    return {
      schema: 1,
      defaultMode,
      blockForcePushProtected: raw.blockForcePushProtected !== false,
      blockPushTags: raw.blockPushTags === true,
      projects,
    };
  } catch {
    return defaults;
  }
}

export function resolveEffectiveProjectPolicy(ctx, policy, opts = {}) {
  const forced = opts?.forcedPolicy;
  if (forced && typeof forced === 'object') {
    const mode = VALID_MODE_SET.has(forced.mode) ? forced.mode : 'worktree-only';
    const prot = getProtectedBranchesForRepo(ctx?.commonDir || '', forced.protectedBranches || null);
    return {
      mode,
      blockForcePushProtected: forced.blockForcePushProtected !== false,
      blockPushTags: forced.blockPushTags === true,
      protectedBranches: prot,
      localOnlyPaths: Array.isArray(forced.localOnlyPaths) ? forced.localOnlyPaths : [],
      source: 'local-guardrail',
      entry: null,
    };
  }

  const projects = policy?.projects || {};
  let matchedEntry = null;
  let source = 'default';

  if (ctx?.commonDirKey && projects[ctx.commonDirKey]) {
    matchedEntry = projects[ctx.commonDirKey];
    source = 'project';
  } else if (ctx?.mainRoot) {
    const normMain = normalizePolicyKey(ctx.mainRoot);
    if (projects[normMain]) {
      matchedEntry = projects[normMain];
      source = 'project';
    } else {
      for (const entry of Object.values(projects)) {
        if (entry && typeof entry === 'object' && entry.displayRoot && normalizePolicyKey(entry.displayRoot) === normMain) {
          matchedEntry = entry;
          source = 'project';
          break;
        }
      }
    }
  }

  const mode =
    matchedEntry && VALID_MODE_SET.has(matchedEntry.mode)
      ? matchedEntry.mode
      : VALID_MODE_SET.has(policy?.defaultMode)
        ? policy.defaultMode
        : 'observe';

  const prot = getProtectedBranchesForRepo(ctx?.commonDir || '', matchedEntry?.protectedBranches || null);
  return {
    mode,
    blockForcePushProtected: policy?.blockForcePushProtected !== false,
    blockPushTags: typeof matchedEntry?.blockPushTags === 'boolean' ? matchedEntry.blockPushTags : policy?.blockPushTags === true,
    protectedBranches: prot,
    localOnlyPaths: Array.isArray(matchedEntry?.localOnlyPaths) ? matchedEntry.localOnlyPaths : [],
    source,
    entry: matchedEntry,
  };
}

function isPolicyOrPluginTamperPath(absPath, opts = {}) {
  if (!absPath) return false;
  const realTarget = resolveExistingPrefixRealpath(absPath);
  const stateDir = getDefaultStateDir(opts.stateDir);
  const realState = resolveExistingPrefixRealpath(stateDir);
  const policyPrefix = CASE_INSENSITIVE_FS ? path.join(realState, 'git-workflow-policy.json').toLowerCase() : path.join(realState, 'git-workflow-policy.json');
  const normTarget = CASE_INSENSITIVE_FS ? realTarget.toLowerCase() : realTarget;
  if (normTarget === policyPrefix || normTarget.startsWith(`${policyPrefix}.`)) {
    return true;
  }

  const pluginsDir = getDefaultPluginsDir(opts.pluginsDir);
  const installedPluginDir = path.join(pluginsDir, 'maga-git-workflow');
  if (isInsideDir(realTarget, installedPluginDir)) {
    return true;
  }
  return false;
}

function isRepoHooksTamperPath(absPath, mainRoot) {
  if (!absPath || !mainRoot) return false;
  const realTarget = resolveExistingPrefixRealpath(absPath);
  const realMain = resolveExistingPrefixRealpath(mainRoot);
  const hooksJson = path.join(realMain, '.agents', 'hooks.json');
  const hooksDir = path.join(realMain, '.agents', 'hooks');
  const a = CASE_INSENSITIVE_FS ? realTarget.toLowerCase() : realTarget;
  const hj = CASE_INSENSITIVE_FS ? hooksJson.toLowerCase() : hooksJson;
  return a === hj || isInsideDir(realTarget, hooksDir);
}

function isPrimaryLocalOnlyPath(absPath, mainRoot, localOnlyPaths = []) {
  if (!absPath || !mainRoot) return false;
  if (isRepoHooksTamperPath(absPath, mainRoot)) return false;
  const realTarget = resolveExistingPrefixRealpath(absPath);
  const realMain = resolveExistingPrefixRealpath(mainRoot);
  for (const rel of localOnlyPaths) {
    if (typeof rel !== 'string' || !rel.trim()) continue;
    const targetCandidate = path.join(realMain, rel.trim());
    if (isInsideDir(realTarget, targetCandidate)) return true;
  }
  return false;
}

function extractCommandTargetsFromHookDef(rawCmd) {
  const tokens = tokenizeSegment(String(rawCmd || '').trim());
  if (tokens.length === 0) return '';
  const { cmdTokens } = parseCommandWrapper(tokens);
  if (cmdTokens.length === 0) return '';
  const exe = path.basename(cmdTokens[0]).toLowerCase();
  if (exe === 'node' || exe === 'node.exe' || exe === 'bun' || exe === 'deno') {
    for (let i = 1; i < cmdTokens.length; i += 1) {
      if (!cmdTokens[i].startsWith('-')) return cmdTokens[i];
    }
    return '';
  }
  return cmdTokens[0];
}

export function hasValidLocalGuardrail(mainRoot) {
  if (!mainRoot) return false;
  try {
    const realMain = fs.realpathSync(mainRoot);
    const agentsDir = path.join(realMain, '.agents');
    const hooksDir = path.join(agentsDir, 'hooks');
    const hooksJsonPath = path.join(agentsDir, 'hooks.json');
    if (!fs.existsSync(hooksJsonPath)) return false;

    const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    const guardCfg = parsed && typeof parsed === 'object' ? parsed['maga-git-guardrail'] : null;
    if (!guardCfg || typeof guardCfg !== 'object') return false;

    const preHandlers = Array.isArray(guardCfg.PreToolUse) ? guardCfg.PreToolUse : [];
    if (preHandlers.length === 0) return false;

    const commands = [];
    for (const entry of preHandlers) {
      if (entry && typeof entry.command === 'string') commands.push(entry.command);
      if (Array.isArray(entry?.hooks)) {
        for (const sub of entry.hooks) {
          if (sub && typeof sub.command === 'string') commands.push(sub.command);
        }
      }
    }
    if (commands.length === 0) return false;

    for (const cmd of commands) {
      const rawScript = extractCommandTargetsFromHookDef(cmd);
      if (!rawScript) return false;
      const absScript = path.resolve(agentsDir, expandHome(rawScript));
      if (!fs.existsSync(absScript)) return false;
      const realScript = fs.realpathSync(absScript);
      const realHooksDir = fs.existsSync(hooksDir) ? fs.realpathSync(hooksDir) : hooksDir;
      if (!isInsideDir(realScript, realHooksDir)) return false;
      const a = CASE_INSENSITIVE_FS ? realScript.toLowerCase() : realScript;
      const b = CASE_INSENSITIVE_FS ? realHooksDir.toLowerCase() : realHooksDir;
      if (a === b) return false;

      const body = fs.readFileSync(realScript, 'utf8');
      if (!ENGINE_MARKER_RE.test(body)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function resolveConversationId(payload) {
  const direct = String(payload?.conversationId || '').trim();
  if (SAFE_CID_RE.test(direct)) return direct;
  const artDir = String(payload?.artifactDirectoryPath || '').trim();
  if (artDir) {
    const base = path.basename(artDir);
    if (SAFE_CID_RE.test(base)) return base;
  }
  return '';
}

export function recordConversationWorktree(
  payload,
  ctx,
  { stateDir = '', protectedBranches = DEFAULT_PROTECTED_BRANCHES } = {}
) {
  try {
    const prot = protectedBranches instanceof Set ? protectedBranches : DEFAULT_PROTECTED_BRANCHES;
    if (!ctx || !ctx.topLevel || !ctx.branch || prot.has(ctx.branch)) {
      return { recorded: false, reason: 'not_worktree' };
    }
    if (!ctx.isLinkedWorktree) {
      return { recorded: false, reason: 'not_linked_worktree' };
    }
    const cid = resolveConversationId(payload);
    if (!cid) return { recorded: false, reason: 'missing_cid' };

    const convDir = path.join(getDefaultStateDir(stateDir), 'conv-worktrees');
    const filePath = path.join(convDir, `${cid}.json`);

    try {
      const st = fs.statSync(filePath, { throwIfNoEntry: false });
      if (st && st.isFile() && Date.now() - st.mtimeMs < HOOK_RECORD_THROTTLE_MS) {
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (existing?.worktreePath === ctx.topLevel && existing?.branch === ctx.branch) {
          return { recorded: false, reason: 'throttled', filePath };
        }
      }
    } catch {}

    const repoRoot = ctx.mainRoot || ctx.topLevel;
    const record = {
      schema: 1,
      cid,
      worktreePath: ctx.topLevel,
      branch: ctx.branch,
      repoRoot,
      source: 'hook',
      updatedAt: Date.now(),
    };
    writeAtomicUtf8(filePath, `${JSON.stringify(record, null, 2)}\n`);
    return { recorded: true, filePath, record };
  } catch {
    return { recorded: false, reason: 'write_failed' };
  }
}

export function recordGuardDenyEvent(event, { stateDir = '', lockMaxWaitMs = 300 } = {}) {
  try {
    const eventsFile = path.join(getDefaultStateDir(stateDir), 'git-workflow-events.json');
    const lockRes = withFileLock(
      eventsFile,
      () => {
        let existing = [];
        try {
          const raw = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
          if (Array.isArray(raw?.events)) existing = raw.events;
        } catch {}
        const next = [
          ...existing,
          {
            ts: Date.now(),
            cid: String(event?.cid || '').slice(0, 64),
            repo: String(event?.repo || '').slice(0, 120),
            commonDir: String(event?.commonDir || '').slice(0, 220),
            mode: String(event?.mode || 'observe'),
            tool: String(event?.tool || ''),
            reason: String(event?.reason || '').slice(0, 260),
          },
        ].slice(-DENY_EVENTS_MAX);
        writeAtomicUtf8(eventsFile, `${JSON.stringify({ schema: 1, events: next }, null, 2)}\n`);
        return true;
      },
      { maxWaitMs: lockMaxWaitMs, staleMs: 5000, busyError: 'events_locked' }
    );
    return Boolean(lockRes?.ok);
  } catch {
    return false;
  }
}

function analyzePushArgs(subArgs) {
  const PUSH_VALUE_FLAGS = new Set([
    '--repo',
    '--receive-pack',
    '--exec',
    '-o',
    '--push-option',
  ]);

  let isForce = false;
  let hasTagsFlag = false;
  const positional = [];
  let afterDoubleDash = false;

  for (let i = 0; i < subArgs.length; i += 1) {
    const tok = subArgs[i];
    if (!afterDoubleDash && tok === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && tok.startsWith('-') && tok !== '-') {
      if (tok === '--tags') {
        hasTagsFlag = true;
      } else if (
        tok === '-f' ||
        tok === '--force' ||
        tok === '--force-with-lease' ||
        tok.startsWith('--force-with-lease=') ||
        tok === '--force-if-includes' ||
        /^-[A-Za-z]*f[A-Za-z]*$/.test(tok)
      ) {
        isForce = true;
      } else if (PUSH_VALUE_FLAGS.has(tok) && i + 1 < subArgs.length) {
        i += 1;
      }
      continue;
    }
    positional.push(tok);
  }

  const refspecs = positional.slice(1);
  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) isForce = true;
  }

  return { isForce, hasTagsFlag, refspecs };
}

function refspecTargetsProtectedBranch(spec, protectedBranches) {
  const m = String(spec || '').match(PROTECTED_REFSPEC_BASE_RE);
  if (!m) return false;
  const target = m[3];
  return Boolean(target && protectedBranches.has(target));
}

function analyzePrimaryBranchSwitch(inv, protectedBranches) {
  const args = Array.isArray(inv.subArgs) ? inv.subArgs : [];
  const sub = inv.subcommand;
  const ddIdx = args.indexOf('--');
  const preDd = ddIdx === -1 ? args : args.slice(0, ddIdx);

  if (sub === 'switch') {
    const pos = [];
    for (let i = 0; i < preDd.length; i += 1) {
      const tok = preDd[i];
      if (
        tok === '-c' ||
        tok === '-C' ||
        tok === '--create' ||
        tok === '--force-create' ||
        tok === '-t' ||
        tok === '--track' ||
        tok.startsWith('--track=') ||
        tok === '--orphan' ||
        tok === '--detach' ||
        tok === '-d' ||
        tok.startsWith('-c') ||
        tok.startsWith('-C')
      ) {
        return { blocked: true, reason: `creating or detaching branch '${sub} ${tok}' in primary checkout` };
      }
      if (tok === '--conflict') {
        i += 1;
        continue;
      }
      if (tok.startsWith('-') && tok !== '-') continue;
      pos.push(tok);
    }
    if (pos.length > 0 && !protectedBranches.has(pos[0])) {
      return { blocked: true, reason: `switching primary checkout to branch '${pos[0]}'` };
    }
    return { blocked: false };
  }

  const posBeforeDd = [];
  for (let i = 0; i < preDd.length; i += 1) {
    const tok = preDd[i];
    if (
      tok === '-b' ||
      tok === '-B' ||
      tok === '-t' ||
      tok === '--track' ||
      tok.startsWith('--track=') ||
      tok === '--orphan' ||
      tok === '--detach' ||
      tok === '-d' ||
      tok.startsWith('-b') ||
      tok.startsWith('-B') ||
      tok.startsWith('--orphan=')
    ) {
      return { blocked: true, reason: `creating or detaching branch 'checkout ${tok}' in primary checkout` };
    }
    if (tok === '--conflict' || tok === '--pathspec-from-file' || tok === '-U' || tok === '--unified') {
      i += 1;
      continue;
    }
    if (tok.startsWith('-') && tok !== '-') continue;
    posBeforeDd.push(tok);
  }

  if (ddIdx !== -1) {
    if (posBeforeDd.length <= 1) return { blocked: false };
    return { blocked: true, reason: `unexpected checkout target '${posBeforeDd.join(' ')}' in primary checkout` };
  }

  if (posBeforeDd.length === 0) return { blocked: false };
  const first = posBeforeDd[0];
  if (protectedBranches.has(first)) return { blocked: false };

  if (posBeforeDd.length === 1) {
    try {
      const st = fs.lstatSync(path.resolve(inv.targetDir, first), { throwIfNoEntry: false });
      if (st && (st.isFile() || st.isSymbolicLink() || st.isDirectory())) return { blocked: false };
    } catch {}
  }

  return { blocked: true, reason: `switching primary checkout to '${first}'` };
}

function buildWtCommandHint(ctx, opts = {}) {
  if (opts?.isLocalRepoHook) {
    return 'npm run wt:new -- <type>/<slug>';
  }
  const repoDir = ctx?.mainRoot || '<repo>';
  return `node ${WT_CLI_DISPLAY_PATH} new feat/<slug> --repo "${repoDir}"`;
}

function makeDeny(reason, { ctx = null, eff = null, tool = '', payload = null } = {}) {
  return {
    result: { decision: 'deny', reason },
    resolvedCtx: null,
    recordCandidateDir: '',
    recordProtectedBranches: null,
    denyEvent: {
      cid: resolveConversationId(payload),
      repo: ctx?.mainRoot || '',
      commonDir: ctx?.commonDirKey || '',
      mode: eff?.mode || 'observe',
      tool,
      reason,
    },
  };
}

function shouldDeferToLocalGuardrail(ctx, opts) {
  if (opts?.isLocalRepoHook || opts?.forcedPolicy) return false;
  if (!ctx?.mainRoot) return false;
  return hasValidLocalGuardrail(ctx.mainRoot);
}

function resolvePayloadCwd(payload, args = {}) {
  const candidates = [
    args?.Cwd,
    args?.cwd,
    payload?.cwd,
    Array.isArray(payload?.workspacePaths) ? payload.workspacePaths[0] : '',
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return path.resolve(expandHome(c.trim()));
    }
  }
  return process.cwd();
}

function resolveEditTargetPath(rawPath, payload, args = {}) {
  const expanded = expandHome(rawPath);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);

  const bases = [];
  for (const cand of [
    args?.Cwd,
    args?.cwd,
    payload?.cwd,
    ...(Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : []),
  ]) {
    if (typeof cand === 'string' && cand.trim()) {
      const absBase = path.resolve(expandHome(cand.trim()));
      if (!bases.includes(absBase)) bases.push(absBase);
    }
  }
  if (bases.length === 0) bases.push(process.cwd());

  for (const b of bases) {
    const candidate = path.resolve(b, expanded);
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const b of bases) {
    const candidate = path.resolve(b, expanded);
    if (findNearestGitCandidateDir(path.dirname(candidate)).hasGitHint) return candidate;
  }
  return path.resolve(bases[0], expanded);
}

function expandShellArg(raw, shellVars, opts = {}) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const eq = s.indexOf('=');
  if (eq > 0 && (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.slice(0, eq)) || /^--[A-Za-z0-9_-]+$/.test(s.slice(0, eq)))) {
    s = s.slice(eq + 1);
  }
  const envOverrides = {
    HOME: os.homedir(),
    ANTI_CLAUDE_STATE_DIR: getDefaultStateDir(opts.stateDir),
    ANTI_CLAUDE_PLUGINS_DIR: getDefaultPluginsDir(opts.pluginsDir),
  };
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (full, braced, bare) => {
    const name = braced || bare;
    if (shellVars && shellVars.has(name)) return shellVars.get(name);
    if (Object.prototype.hasOwnProperty.call(envOverrides, name)) return envOverrides[name];
    if (typeof process.env[name] === 'string' && process.env[name]) return process.env[name];
    return full;
  });
  return expandHome(s);
}

function extractWriteRedirectTargets(segmentText) {
  const targets = [];
  if (!segmentText || !segmentText.includes('>')) return targets;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < segmentText.length; i += 1) {
    const ch = segmentText[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch !== '>') continue;
    if (i > 0 && segmentText[i - 1] === '<' && !(i > 1 && segmentText[i - 2] === '<')) {
      // `<>` read-write open IS mutating; fall through
    } else if (i > 0 && segmentText[i - 1] === '<') {
      continue;
    }

    let j = i + 1;
    if (segmentText[j] === '>' || segmentText[j] === '|') j += 1;
    if (segmentText[j] === '&') {
      i = j;
      continue;
    }
    while (j < segmentText.length && /\s/.test(segmentText[j])) j += 1;

    let tok = '';
    let tSingle = false;
    let tDouble = false;
    let tEsc = false;
    while (j < segmentText.length) {
      const c = segmentText[j];
      if (tEsc) {
        tok += c;
        tEsc = false;
        j += 1;
        continue;
      }
      if (tSingle) {
        if (c === "'") tSingle = false;
        else tok += c;
        j += 1;
        continue;
      }
      if (tDouble) {
        if (c === '\\') tEsc = true;
        else if (c === '"') tDouble = false;
        else tok += c;
        j += 1;
        continue;
      }
      if (c === '\\') {
        tEsc = true;
        j += 1;
        continue;
      }
      if (c === "'") {
        tSingle = true;
        j += 1;
        continue;
      }
      if (c === '"') {
        tDouble = true;
        j += 1;
        continue;
      }
      if (/[\s;|&()<>]/.test(c)) break;
      tok += c;
      j += 1;
    }
    if (tok && tok !== '/dev/null') targets.push(tok);
    i = Math.max(i, j - 1);
  }
  return targets;
}

function getShellSegmentWriteInfo(cmdTokens, rawSegText) {
  if (!Array.isArray(cmdTokens) || cmdTokens.length === 0) {
    return { mutating: false, inlineScript: false };
  }
  const bin = path.basename(cmdTokens[0]).toLowerCase();
  if (SHELL_MUTATING_BINS.has(bin)) return { mutating: true, inlineScript: false };
  if (bin === 'sed') {
    const hasInPlace = cmdTokens.slice(1).some((t) => t === '--in-place' || /^-[a-zA-Z]*i/.test(t));
    return { mutating: hasInPlace, inlineScript: false };
  }
  if (bin === 'perl') {
    const hasInPlace = cmdTokens.slice(1).some((t) => /^-[a-zA-Z]*i/.test(t));
    if (hasInPlace) return { mutating: true, inlineScript: false };
  }
  if (INLINE_SCRIPT_RUNNERS.has(bin)) {
    const hasInlineFlag = cmdTokens.slice(1).some((t) => t === '-e' || t === '--eval' || t === '-c' || /^-[a-z]*[ec]$/i.test(t));
    if (hasInlineFlag && INLINE_WRITE_HINT_RE.test(rawSegText)) {
      return { mutating: true, inlineScript: true };
    }
  }
  if (isGitBinary(cmdTokens[0])) {
    const mutatingGit = cmdTokens.slice(1).some((t) => t === 'rm' || t === 'mv' || t === 'checkout' || t === 'restore' || t === 'clean');
    if (mutatingGit) return { mutating: true, inlineScript: false };
  }
  return { mutating: false, inlineScript: false };
}

function evaluateShellTamperCommand(commandLine, initialCwd, payload, policy, opts, depth = 0) {
  const segments = splitShellSegmentsWithOps(commandLine);
  const shellVars = new Map();
  let currentDir = path.resolve(expandHome(initialCwd) || process.cwd());
  let prevDir = currentDir;

  for (const seg of segments) {
    const inPipeline = seg.sepBefore === '|' || seg.sepAfter === '|';
    const cleanedSegText = stripUnquotedGroupDelimiters(seg.text);
    const rawTokens = tokenizeSegment(cleanedSegText, shellVars);
    if (rawTokens.length === 0) continue;

    if (rawTokens[0] === 'export' && rawTokens.length > 1) {
      if (!inPipeline) {
        for (const tok of rawTokens.slice(1)) {
          const m = tok.match(ENV_ASSIGNMENT_RE);
          if (m) shellVars.set(m[1], m[2]);
        }
      }
      continue;
    }

    const { env, cmdTokens } = parseCommandWrapper(rawTokens);
    for (const [k, v] of Object.entries(env)) {
      if (!shellVars.has(k) && !inPipeline && cmdTokens.length === 0) shellVars.set(k, v);
    }
    if (cmdTokens.length === 0) continue;

    if (cmdTokens[0] === 'cd') {
      if (!inPipeline) {
        let argIdx = 1;
        if (cmdTokens[argIdx] === '--') argIdx += 1;
        const rawTarget = cmdTokens[argIdx];
        let nextDir = currentDir;
        if (!rawTarget) nextDir = os.homedir();
        else if (rawTarget === '-') nextDir = prevDir;
        else nextDir = path.resolve(currentDir, expandShellArg(rawTarget, shellVars, opts));
        prevDir = currentDir;
        currentDir = nextDir;
      }
      continue;
    }

    if (depth === 0) {
      const inlineShell = extractInlineShellString(cmdTokens);
      if (inlineShell) {
        const nestedDeny = evaluateShellTamperCommand(inlineShell, currentDir, payload, policy, opts, depth + 1);
        if (nestedDeny) return nestedDeny;
      }
    }

    const redirectTargets = extractWriteRedirectTargets(cleanedSegText);
    const { mutating, inlineScript } = getShellSegmentWriteInfo(cmdTokens, cleanedSegText);
    if (!mutating && redirectTargets.length === 0) continue;

    const expandedText = expandShellArg(cleanedSegText, shellVars, opts);
    const rawCandidates = [...redirectTargets, ...cmdTokens.slice(1)];
    const resolvedCandidates = [];
    for (const raw of rawCandidates) {
      const expanded = expandShellArg(raw, shellVars, opts);
      if (!expanded) continue;
      resolvedCandidates.push({
        raw,
        expanded,
        absPath: path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(currentDir, expanded),
      });
    }

    // 1. Policy file (`git-workflow-policy.json*`) & live plugin (`maga-git-workflow`) tamper in ALL tiers
    if (
      /git-workflow-policy\.json/.test(expandedText) ||
      resolvedCandidates.some((c) => isPolicyOrPluginTamperPath(c.absPath, opts)) ||
      (isPolicyOrPluginTamperPath(currentDir, opts) && (mutating || redirectTargets.length > 0)) ||
      resolvedCandidates.some(
        (c) =>
          c.expanded.includes('maga-git-workflow') &&
          (/\$(?:\(|\{|[A-Za-z_])/.test(c.expanded) || /[\\/]plugins[\\/]maga-git-workflow/i.test(c.expanded))
      ) ||
      (inlineScript &&
        expandedText.includes('maga-git-workflow') &&
        !/studio[\\/]plugin[\\/]maga-git-workflow/.test(expandedText))
    ) {
      return makeDeny(
        'Blocked by MAGA Git Workflow: modifying git-workflow-policy.json or the installed maga-git-workflow plugin via shell is forbidden. Change project workflow modes via MAGA Projects Cockpit or MAGA Settings UI.',
        { tool: 'run_command', payload }
      );
    }

    // 2. Repository `.agents/hooks.json` / `.agents/hooks/**` tamper in enforced or locally-guarded repos
    if (/\.agents[\\/]hooks/.test(expandedText) || isInsideDir(currentDir, path.join(initialCwd, '.agents', 'hooks'))) {
      const probeDirs = new Set([currentDir, initialCwd]);
      for (const c of resolvedCandidates) {
        if (/\.agents[\\/]hooks/.test(c.expanded)) {
          probeDirs.add(path.dirname(c.absPath));
        }
      }
      for (const probeDir of probeDirs) {
        const detailed = resolveGitContextDetailed(probeDir);
        const ctx = detailed.ctx || (detailed.error ? buildFailClosedFallbackCtx(probeDir, detailed) : null);
        if (!ctx) continue;
        const eff = resolveEffectiveProjectPolicy(ctx, policy, opts);
        const hasLocal = shouldDeferToLocalGuardrail(ctx, opts);
        if (eff.mode !== 'protect-main' && eff.mode !== 'worktree-only' && !hasLocal) continue;

        const hitsRepoHooks =
          resolvedCandidates.some((c) => isRepoHooksTamperPath(c.absPath, ctx.mainRoot)) ||
          isRepoHooksTamperPath(currentDir, ctx.mainRoot) ||
          ((inlineScript || /\$(?:\(|\{|[A-Za-z_])/.test(expandedText)) &&
            (!ctx.isLinkedWorktree || expandedText.includes(ctx.mainRoot)));
        if (hitsRepoHooks) {
          return makeDeny(
            `Blocked by MAGA Git Workflow (${eff.mode}): modifying '.agents/hooks.json' or '.agents/hooks/**' via shell in an enforced repository is forbidden.`,
            { ctx, eff, tool: 'run_command', payload }
          );
        }
      }
    }
  }
  return null;
}

function evaluateRunCommandDetailed(commandLine, payload, policy, opts) {
  const args = payload?.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
  const initialCwd = resolvePayloadCwd(payload, args);

  if (SHELL_TAMPER_SUSPECT_RE.test(commandLine) || isPolicyOrPluginTamperPath(initialCwd, opts)) {
    const tamperDeny = evaluateShellTamperCommand(commandLine, initialCwd, payload, policy, opts);
    if (tamperDeny) return tamperDeny;
  }

  // Hot-path: skip tokenization & git spawns unless `git` token appears
  if (!/\bgit\b/.test(commandLine)) {
    return {
      result: { decision: 'allow' },
      resolvedCtx: null,
      recordCandidateDir: '',
      recordProtectedBranches: null,
      denyEvent: null,
    };
  }

  const { invocations, finalDir } = extractGitInvocationsDetailed(commandLine, initialCwd);
  let lastTrackedCtx = null;
  let lastTrackedProtected = null;

  for (const inv of invocations) {
    const detailed = resolveGitContextDetailed(inv.targetDir);
    if (!detailed.ctx && detailed.error) {
      // Fail-closed only if policy for this path resolves or directory policy is enforced
      const fallbackCtx = buildFailClosedFallbackCtx(inv.targetDir, detailed);
      const effErr = resolveEffectiveProjectPolicy(fallbackCtx, policy, opts);
      if (effErr.mode === 'protect-main' || effErr.mode === 'worktree-only') {
        return makeDeny(
          `Blocked by MAGA Git Workflow (${effErr.mode}): ${detailed.error}. Use MAGA_ALLOW_MAIN_COMMIT=1 / MAGA_ALLOW_PRIMARY_CHECKOUT=1 if intentional.`,
          { ctx: fallbackCtx, eff: effErr, tool: 'run_command', payload }
        );
      }
      continue;
    }
    const ctx = detailed.ctx;

    if (ctx && shouldDeferToLocalGuardrail(ctx, opts)) {
      continue;
    }

    const eff = resolveEffectiveProjectPolicy(ctx, policy, opts);
    const prot = eff.protectedBranches;

    if (inv.subcommand === 'push') {
      const { isForce, hasTagsFlag, refspecs } = analyzePushArgs(inv.subArgs);
      if (hasTagsFlag && eff.blockPushTags) {
        return makeDeny(
          "Blocked by MAGA Git Guardrail: never run 'git push --tags'. Push explicit tags instead: git push origin vX.Y.Z.",
          { ctx, eff, tool: 'run_command', payload }
        );
      }
      if (!ctx) continue;

      const targetsProtected =
        refspecs.some((spec) => refspecTargetsProtectedBranch(spec, prot)) ||
        (refspecs.length === 0 && Boolean(ctx.branch && prot.has(ctx.branch)));

      if (isForce && targetsProtected && eff.blockForcePushProtected) {
        return makeDeny(
          `Blocked by MAGA Git Workflow: force-pushing to protected branch '${ctx.branch || 'main/master'}' is forbidden.`,
          { ctx, eff, tool: 'run_command', payload }
        );
      }
      continue;
    }

    if (inv.subcommand === 'commit') {
      if (!ctx) continue;

      if (eff.mode === 'observe') {
        if (ctx.isLinkedWorktree && ctx.branch && !prot.has(ctx.branch)) {
          lastTrackedCtx = ctx;
          lastTrackedProtected = prot;
        }
        continue;
      }

      const onProtected = Boolean(ctx.branch && prot.has(ctx.branch));
      if (onProtected) {
        if (!ctx.merging && inv.env.MAGA_ALLOW_MAIN_COMMIT !== '1') {
          const unbornCheck = isUnbornHead(inv.targetDir);
          if (unbornCheck.error) {
            return makeDeny(
              `Blocked by MAGA Git Workflow (${eff.mode}): ${unbornCheck.error}. Override intentionally with MAGA_ALLOW_MAIN_COMMIT=1.`,
              { ctx, eff, tool: 'run_command', payload }
            );
          }
          if (!unbornCheck.unborn) {
            const wtCmd = buildWtCommandHint(ctx, opts);
            return makeDeny(
              `Blocked by MAGA Git Guardrail (${eff.mode}): direct 'git commit' on protected branch '${ctx.branch}' is forbidden. Create a worktree first: \`${wtCmd}\` (or override: \`MAGA_ALLOW_MAIN_COMMIT=1 git commit ...\`).`,
              { ctx, eff, tool: 'run_command', payload }
            );
          }
        }
      } else if (eff.mode === 'worktree-only' && !ctx.isLinkedWorktree && !ctx.merging && inv.env.MAGA_ALLOW_MAIN_COMMIT !== '1') {
        const wtCmd = buildWtCommandHint(ctx, opts);
        return makeDeny(
          `Blocked by MAGA Worktree Policy: primary checkout (${ctx.topLevel}) must stay on clean main branch. Commit inside an isolated worktree (\`${wtCmd}\`), or override: \`MAGA_ALLOW_MAIN_COMMIT=1\`.`,
          { ctx, eff, tool: 'run_command', payload }
        );
      }

      if (ctx.isLinkedWorktree && ctx.branch && !prot.has(ctx.branch)) {
        lastTrackedCtx = ctx;
        lastTrackedProtected = prot;
      }
      continue;
    }

    if (inv.subcommand === 'checkout' || inv.subcommand === 'switch') {
      if (ctx && eff.mode === 'worktree-only' && !ctx.isLinkedWorktree && inv.env.MAGA_ALLOW_PRIMARY_CHECKOUT !== '1') {
        const check = analyzePrimaryBranchSwitch(inv, prot);
        if (check.blocked) {
          const wtCmd = buildWtCommandHint(ctx, opts);
          return makeDeny(
            `Blocked by MAGA Worktree Policy: ${check.reason} is forbidden because primary checkout (${ctx.topLevel}) stays permanently on main. Create an isolated worktree instead: \`${wtCmd}\` (escape hatch: \`MAGA_ALLOW_PRIMARY_CHECKOUT=1\`).`,
            { ctx, eff, tool: 'run_command', payload }
          );
        }
      }
      if (ctx && ctx.isLinkedWorktree && ctx.branch && !prot.has(ctx.branch)) {
        lastTrackedCtx = ctx;
        lastTrackedProtected = prot;
      }
      continue;
    }

    if (MUTATING_GIT_SUBCOMMANDS.has(inv.subcommand)) {
      if (ctx && ctx.isLinkedWorktree && ctx.branch && !prot.has(ctx.branch)) {
        lastTrackedCtx = ctx;
        lastTrackedProtected = prot;
      }
    }
  }

  return {
    result: { decision: 'allow' },
    resolvedCtx: lastTrackedCtx,
    recordCandidateDir: !lastTrackedCtx && invocations.length > 0 ? finalDir : '',
    recordProtectedBranches: lastTrackedProtected,
    denyEvent: null,
  };
}

export function evaluateHookPayloadDetailed(payload, opts = {}) {
  if (!payload || typeof payload !== 'object') {
    return { result: {}, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
  }

  const policy = opts.forcedPolicy ? null : readWorkflowPolicy({ stateDir: opts.stateDir });
  const eventName = String(payload.hookEventName || '');
  const args = payload.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};
  const baseCwd = resolvePayloadCwd(payload, args);

  if (eventName === 'SessionStart') {
    const detailed = resolveGitContextDetailed(baseCwd);
    const ctx = detailed.ctx;
    if (!ctx) {
      return { result: {}, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
    }
    if (shouldDeferToLocalGuardrail(ctx, opts)) {
      return { result: {}, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
    }
    const eff = resolveEffectiveProjectPolicy(ctx, policy, opts);
    if (eff.mode === 'observe') {
      return { result: {}, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
    }

    const prot = eff.protectedBranches;
    const wtCmd = buildWtCommandHint(ctx, opts);
    let msg = '';

    if (eff.mode === 'worktree-only') {
      if (!ctx.isLinkedWorktree) {
        msg =
          ctx.branch && prot.has(ctx.branch)
            ? `[MAGA Worktree Policy] Primary checkout (${ctx.topLevel}) is on protected branch '${ctx.branch}'. Read-only research proceeds here. Before any code edit, ALWAYS create an isolated sibling worktree (\`${wtCmd}\`) instead of \`git checkout -b\` or editing here.`
            : `[MAGA Worktree Policy] Primary checkout (${ctx.topLevel}) is currently drifted onto '${ctx.branch || 'HEAD'}' instead of clean main. Do not edit or commit here; create a sibling worktree (\`${wtCmd}\`).`;
      } else if (ctx.branch && prot.has(ctx.branch)) {
        msg = `[MAGA Git Guardrail] Linked worktree (${ctx.topLevel}) is on protected branch '${ctx.branch}'. Switch to a feature/fix branch inside this worktree before editing or committing.`;
      }
    } else if (eff.mode === 'protect-main') {
      if (ctx.branch && prot.has(ctx.branch)) {
        msg = `[MAGA Git Workflow] Policy for '${path.basename(ctx.mainRoot || ctx.topLevel)}' is protect-main. Branch '${ctx.branch}' is protected against direct edits/commits; switch branches or create an isolated worktree (\`${wtCmd}\`).`;
      }
    }

    if (!msg) {
      return { result: {}, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
    }
    return {
      result: { injectSteps: [{ systemMessage: { systemMessage: msg } }] },
      resolvedCtx: null,
      recordCandidateDir: '',
      recordProtectedBranches: null,
      denyEvent: null,
    };
  }

  if (eventName && eventName !== 'PreToolUse') {
    return { result: {}, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
  }

  const isPreToolUse = eventName === 'PreToolUse' || Boolean(payload.toolCall);
  if (!isPreToolUse) {
    return { result: {}, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
  }

  const allowResult = { decision: 'allow' };
  const toolName = String(payload.toolCall?.name || '').toLowerCase();

  if (FILE_EDIT_TOOLS.has(toolName)) {
    const rawPath = args.Path || args.TargetFile || args.path || args.file_path || '';
    if (!rawPath || typeof rawPath !== 'string') {
      return { result: allowResult, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
    }

    const absPath = resolveEditTargetPath(rawPath, payload, args);

    // Self-tamper protection in ALL tiers (policy file & live installed plugin dir)
    if (isPolicyOrPluginTamperPath(absPath, opts)) {
      return makeDeny(
        'Blocked by MAGA Git Workflow: editing git-workflow-policy.json or the installed maga-git-workflow plugin directly is forbidden. Change project workflow modes via MAGA Projects Cockpit or MAGA Settings UI.',
        { tool: toolName, payload }
      );
    }

    if (payload.artifactDirectoryPath && isInsideDir(absPath, payload.artifactDirectoryPath)) {
      return { result: allowResult, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
    }

    const targetDir = path.dirname(absPath);
    const detailed = resolveGitContextDetailed(targetDir);
    if (!detailed.ctx) {
      if (detailed.error) {
        const probeCtx = buildFailClosedFallbackCtx(targetDir, detailed);
        const effErr = resolveEffectiveProjectPolicy(probeCtx, policy, opts);
        if (effErr.mode === 'protect-main' || effErr.mode === 'worktree-only') {
          return makeDeny(
            `Blocked by MAGA Git Workflow (${effErr.mode}): ${detailed.error}.`,
            { ctx: probeCtx, eff: effErr, tool: toolName, payload }
          );
        }
      }
      return { result: allowResult, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
    }

    const ctx = detailed.ctx;
    const eff = resolveEffectiveProjectPolicy(ctx, policy, opts);
    const hasLocal = shouldDeferToLocalGuardrail(ctx, opts);

    if ((eff.mode === 'protect-main' || eff.mode === 'worktree-only' || hasLocal) && isRepoHooksTamperPath(absPath, ctx.mainRoot)) {
      return makeDeny(
        `Blocked by MAGA Git Workflow (${eff.mode}): editing '.agents/hooks.json' or '.agents/hooks/**' in an enforced repository is forbidden.`,
        { ctx, eff, tool: toolName, payload }
      );
    }

    if (hasLocal) {
      return { result: allowResult, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
    }

    const prot = eff.protectedBranches;

    if (ctx.merging) {
      return { result: allowResult, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
    }

    if (eff.mode === 'observe') {
      return {
        result: allowResult,
        resolvedCtx: ctx.isLinkedWorktree ? ctx : null,
        recordCandidateDir: '',
        recordProtectedBranches: prot,
        denyEvent: null,
      };
    }

    if (eff.mode === 'worktree-only') {
      if (!ctx.isLinkedWorktree) {
        if (isPrimaryLocalOnlyPath(absPath, ctx.mainRoot, eff.localOnlyPaths)) {
          return { result: allowResult, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
        }
        const onProtected = Boolean(ctx.branch && prot.has(ctx.branch));
        const unbornCheck = isUnbornHead(ctx.topLevel);
        if (unbornCheck.error) {
          return makeDeny(
            `Blocked by MAGA Worktree Policy: ${unbornCheck.error}.`,
            { ctx, eff, tool: toolName, payload }
          );
        }
        if (unbornCheck.unborn) {
          return { result: allowResult, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
        }
        const wtCmd = buildWtCommandHint(ctx, opts);
        return makeDeny(
          onProtected
            ? `Blocked by MAGA Worktree Policy: cannot edit repository files in primary checkout on protected branch '${ctx.branch}' (${ctx.topLevel}). Create an isolated sibling worktree first: \`${wtCmd}\` (emergency override on primary: \`MAGA_ALLOW_PRIMARY_CHECKOUT=1\`).`
            : `Blocked by MAGA Worktree Policy: primary checkout (${ctx.topLevel}, currently on '${ctx.branch || 'HEAD'}') is reserved for clean main branch. Isolate edits in a sibling worktree: \`${wtCmd}\` (for git bisect/detached override: \`MAGA_ALLOW_PRIMARY_CHECKOUT=1\`).`,
          { ctx, eff, tool: toolName, payload }
        );
      }

      if (ctx.branch && prot.has(ctx.branch)) {
        const unbornCheck = isUnbornHead(ctx.topLevel);
        if (!unbornCheck.error && unbornCheck.unborn) {
          return { result: allowResult, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
        }
        const wtCmd = buildWtCommandHint(ctx, opts);
        return makeDeny(
          `Blocked by MAGA Git Guardrail: cannot edit repository files directly on protected branch '${ctx.branch}' (${ctx.topLevel}). Switch branches or create a worktree: \`${wtCmd}\`.`,
          { ctx, eff, tool: toolName, payload }
        );
      }

      return {
        result: allowResult,
        resolvedCtx: ctx,
        recordCandidateDir: '',
        recordProtectedBranches: prot,
        denyEvent: null,
      };
    }

    // eff.mode === 'protect-main'
    if (ctx.branch && prot.has(ctx.branch)) {
      if (isPrimaryLocalOnlyPath(absPath, ctx.mainRoot, eff.localOnlyPaths)) {
        return { result: allowResult, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
      }
      const unbornCheck = isUnbornHead(ctx.topLevel);
      if (unbornCheck.error) {
        return makeDeny(
          `Blocked by MAGA Git Workflow (protect-main): ${unbornCheck.error}.`,
          { ctx, eff, tool: toolName, payload }
        );
      }
      if (!unbornCheck.unborn) {
        const wtCmd = buildWtCommandHint(ctx, opts);
        return makeDeny(
          `Blocked by MAGA Git Workflow (protect-main): cannot edit files directly on protected branch '${ctx.branch}' (${ctx.topLevel}). Switch to a feature branch or create an isolated worktree: \`${wtCmd}\`.`,
          { ctx, eff, tool: toolName, payload }
        );
      }
    }

    return {
      result: allowResult,
      resolvedCtx: ctx.isLinkedWorktree ? ctx : null,
      recordCandidateDir: '',
      recordProtectedBranches: prot,
      denyEvent: null,
    };
  }

  if (toolName === 'run_command') {
    const commandLine = String(args.CommandLine || args.command || '');
    return evaluateRunCommandDetailed(commandLine, payload, policy, opts);
  }

  return { result: allowResult, resolvedCtx: null, recordCandidateDir: '', recordProtectedBranches: null, denyEvent: null };
}

export function evaluateHookPayloadWithOptions(payload, opts = {}) {
  return evaluateHookPayloadDetailed(payload, opts).result;
}

export function evaluateHookPayload(payload, opts = {}) {
  return evaluateHookPayloadDetailed(payload, opts).result;
}

export function runGuardCli(opts = {}) {
  let raw = '';
  let resolvedMode = 'observe';
  try {
    raw = fs.readFileSync(0, 'utf8').trim();
    const payload = raw ? JSON.parse(raw) : {};
    const {
      result,
      resolvedCtx,
      recordCandidateDir,
      recordProtectedBranches,
      denyEvent,
    } = evaluateHookPayloadDetailed(payload, opts);

    if (result?.decision === 'deny' && denyEvent) {
      resolvedMode = denyEvent.mode || 'observe';
      recordGuardDenyEvent(denyEvent, { stateDir: opts.stateDir });
    }

    process.stdout.write(`${JSON.stringify(result || {})}\n`);

    if (result?.decision === 'allow') {
      const ctxToRecord = resolvedCtx || (recordCandidateDir ? resolveGitContext(recordCandidateDir) : null);
      if (ctxToRecord) {
        recordConversationWorktree(payload, ctxToRecord, {
          stateDir: opts.stateDir,
          protectedBranches: recordProtectedBranches || DEFAULT_PROTECTED_BRANCHES,
        });
      }
    }
  } catch (err) {
    const isPre = raw.includes('PreToolUse') || raw.includes('"toolCall"');
    if (opts?.forcedPolicy?.mode === 'worktree-only' || resolvedMode === 'protect-main' || resolvedMode === 'worktree-only') {
      const failOut = isPre
        ? {
            decision: 'deny',
            reason: `Blocked by MAGA Git Workflow: guardrail evaluation failed (${String(err?.message || 'error')}). Escape hatch: MAGA_ALLOW_MAIN_COMMIT=1.`,
          }
        : {};
      process.stdout.write(`${JSON.stringify(failOut)}\n`);
    } else {
      const fallback = isPre ? { decision: 'allow' } : {};
      process.stdout.write(`${JSON.stringify(fallback)}\n`);
    }
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runGuardCli({});
}
