#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROTECTED_BRANCHES = new Set(['main', 'master']);
const SAFE_CID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const HOOK_RECORD_THROTTLE_MS = 30_000;

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
const PROTECTED_REFSPEC_RE = /^\+?([^:]*:)?(refs\/heads\/)?(main|master)$/;

function gitExecEnv() {
  return { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
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
  const rel = path.relative(resolvedBase, resolvedTarget);
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

    if (base === 'command') {
      idx += 1;
      while (idx < tokens.length && tokens[idx].startsWith('-')) {
        idx += 1;
      }
      continue;
    }

    break;
  }

  return { env, cmdTokens: tokens.slice(idx) };
}

function extractGitInvocationsDetailed(commandLine, initialCwd = process.cwd()) {
  const segments = splitShellSegmentsWithOps(commandLine);
  const invocations = [];
  const shellVars = new Map();
  let currentDir = path.resolve(expandHome(initialCwd) || process.cwd());
  let prevDir = currentDir;

  for (const seg of segments) {
    const inPipeline = seg.sepBefore === '|' || seg.sepAfter === '|';
    const rawTokens = tokenizeSegment(seg.text, shellVars);
    if (rawTokens.length === 0) continue;

    // Handle standalone `export KEY=VAL` (only outside pipelines)
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

    // Standalone assignment segment (`WT=/path && ...`) feeds later non-pipeline expansions.
    // Prefix assignments (`WT=/path git -C "$WT"`) do NOT feed expansion because shell expands before assigning.
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

export function resolveGitContext(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return null;

  let cur = path.resolve(expandHome(dirPath));
  while (true) {
    try {
      const st = fs.statSync(cur);
      if (st.isDirectory()) break;
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }

  let topAndGit = '';
  try {
    topAndGit = execFileSync('git', ['-C', cur, 'rev-parse', '--show-toplevel', '--git-dir'], {
      encoding: 'utf8',
      timeout: 2000,
      env: gitExecEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }

  const lines = topAndGit.trim().split(/\r?\n/);
  if (lines.length < 2) return null;

  const topLevel = lines[0].trim();
  const gitDir = path.resolve(cur, lines[1].trim());

  let branch = null;
  try {
    const out = execFileSync('git', ['-C', cur, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      env: gitExecEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    branch = out || null;
  } catch {
    branch = null;
  }

  const merging = fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
  return { topLevel, gitDir, branch, merging };
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
  { stateDir = path.join(os.homedir(), '.gemini', 'antigravity', 'anti-claude') } = {}
) {
  try {
    if (!ctx || !ctx.topLevel || !ctx.branch || PROTECTED_BRANCHES.has(ctx.branch)) {
      return { recorded: false, reason: 'not_worktree' };
    }
    const cid = resolveConversationId(payload);
    if (!cid) return { recorded: false, reason: 'missing_cid' };

    const convDir = path.join(stateDir, 'conv-worktrees');
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

    let repoRoot = ctx.topLevel;
    try {
      const commonRaw = execFileSync('git', ['-C', ctx.topLevel, 'rev-parse', '--git-common-dir'], {
        encoding: 'utf8',
        timeout: 1200,
        env: gitExecEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (commonRaw) {
        const absCommon = path.resolve(ctx.topLevel, commonRaw);
        if (path.basename(absCommon) === '.git') {
          repoRoot = path.dirname(absCommon);
        }
      }
    } catch {}

    fs.mkdirSync(convDir, { recursive: true });
    const record = {
      schema: 1,
      cid,
      worktreePath: ctx.topLevel,
      branch: ctx.branch,
      repoRoot,
      source: 'hook',
      updatedAt: Date.now(),
    };
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      throw err;
    }
    return { recorded: true, filePath, record };
  } catch {
    return { recorded: false, reason: 'write_failed' };
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

function evaluateRunCommandDetailed(commandLine, payload) {
  const initialCwd = payload?.cwd || payload?.workspacePaths?.[0] || process.cwd();
  const { invocations, finalDir } = extractGitInvocationsDetailed(commandLine, initialCwd);
  let lastNonProtectedCtx = null;

  for (const inv of invocations) {
    if (inv.subcommand === 'push') {
      const { isForce, hasTagsFlag, refspecs } = analyzePushArgs(inv.subArgs);
      if (hasTagsFlag) {
        return {
          result: {
            decision: 'deny',
            reason:
              "Blocked by MAGA Git Guardrail: never run 'git push --tags' (legacy upstream v2.x/v3.x tags must not be pushed to origin). Push explicit tags instead: git push origin vX.Y.Z.",
          },
          resolvedCtx: null,
          recordCandidateDir: '',
        };
      }

      const ctx = resolveGitContext(inv.targetDir);
      if (!ctx) continue;
      if (ctx.branch && !PROTECTED_BRANCHES.has(ctx.branch)) lastNonProtectedCtx = ctx;

      const targetsProtected =
        refspecs.some((spec) => PROTECTED_REFSPEC_RE.test(spec)) ||
        (refspecs.length === 0 && Boolean(ctx.branch && PROTECTED_BRANCHES.has(ctx.branch)));

      if (isForce && targetsProtected) {
        return {
          result: {
            decision: 'deny',
            reason: "Blocked by MAGA Git Guardrail: force-pushing to protected branch 'main'/'master' is forbidden.",
          },
          resolvedCtx: null,
          recordCandidateDir: '',
        };
      }
      continue;
    }

    if (inv.subcommand === 'commit') {
      const ctx = resolveGitContext(inv.targetDir);
      if (!ctx) continue;
      if (ctx.branch && PROTECTED_BRANCHES.has(ctx.branch)) {
        if (ctx.merging || inv.env.MAGA_ALLOW_MAIN_COMMIT === '1') {
          continue;
        }
        return {
          result: {
            decision: 'deny',
            reason: `Blocked by MAGA Git Guardrail: direct 'git commit' on protected branch '${ctx.branch}' is forbidden. Develop on a feat/*, fix/*, chore/*, or release/* branch (or sibling worktree) and merge back with 'git merge --no-ff'.`,
          },
          resolvedCtx: null,
          recordCandidateDir: '',
        };
      }
      if (ctx.branch && !PROTECTED_BRANCHES.has(ctx.branch)) lastNonProtectedCtx = ctx;
      continue;
    }

    const ctx = resolveGitContext(inv.targetDir);
    if (ctx && ctx.branch && !PROTECTED_BRANCHES.has(ctx.branch)) {
      lastNonProtectedCtx = ctx;
    }
  }

  return {
    result: { decision: 'allow' },
    resolvedCtx: lastNonProtectedCtx,
    recordCandidateDir: !lastNonProtectedCtx ? finalDir : '',
  };
}

function evaluateHookPayloadDetailed(payload) {
  if (!payload || typeof payload !== 'object') {
    return { result: {}, resolvedCtx: null, recordCandidateDir: '' };
  }

  const eventName = String(payload.hookEventName || '');
  const baseCwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd();

  if (eventName === 'SessionStart') {
    const ctx = resolveGitContext(baseCwd);
    if (ctx && ctx.branch && PROTECTED_BRANCHES.has(ctx.branch)) {
      return {
        result: {
          injectSteps: [
            {
              systemMessage: {
                systemMessage: `[MAGA Git Guardrail] Current workspace is on protected branch '${ctx.branch}'. Never develop features or fix bugs directly on 'main'. Create a branch (\`git checkout -b feat/<slug>\` / \`fix/<slug>\`) or an isolated sibling worktree (\`git worktree add -b <type>/<slug> ../MAGA-wt/<slug> main\`) before editing files or committing. Direct repo edits and commits on 'main' are blocked by PreToolUse hook.`,
              },
            },
          ],
        },
        resolvedCtx: null,
        recordCandidateDir: '',
      };
    }
    return { result: {}, resolvedCtx: null, recordCandidateDir: '' };
  }

  if (eventName && eventName !== 'PreToolUse') {
    return { result: {}, resolvedCtx: null, recordCandidateDir: '' };
  }

  const isPreToolUse = eventName === 'PreToolUse' || Boolean(payload.toolCall);
  if (!isPreToolUse) {
    return { result: {}, resolvedCtx: null, recordCandidateDir: '' };
  }

  const allowResult = { decision: 'allow' };
  const toolName = String(payload.toolCall?.name || '').toLowerCase();
  const args = payload.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};

  if (FILE_EDIT_TOOLS.has(toolName)) {
    const rawPath = args.Path || args.TargetFile || args.path || args.file_path || '';
    if (!rawPath || typeof rawPath !== 'string') {
      return { result: allowResult, resolvedCtx: null, recordCandidateDir: '' };
    }

    const absPath = path.resolve(baseCwd, expandHome(rawPath));
    if (payload.artifactDirectoryPath && isInsideDir(absPath, payload.artifactDirectoryPath)) {
      return { result: allowResult, resolvedCtx: null, recordCandidateDir: '' };
    }

    const ctx = resolveGitContext(path.dirname(absPath));
    if (!ctx || ctx.merging) {
      return { result: allowResult, resolvedCtx: null, recordCandidateDir: '' };
    }

    if (ctx.branch && PROTECTED_BRANCHES.has(ctx.branch)) {
      return {
        result: {
          decision: 'deny',
          reason: `Blocked by MAGA Git Guardrail: cannot edit repository files directly on protected branch '${ctx.branch}' (${ctx.topLevel}). Switch to a feature/fix branch (\`git checkout -b feat/<slug>\` or \`fix/<slug>\`) or create an isolated sibling worktree (\`git worktree add -b <type>/<slug> ../MAGA-wt/<slug> main\`) first.`,
        },
        resolvedCtx: null,
        recordCandidateDir: '',
      };
    }
    return { result: allowResult, resolvedCtx: ctx, recordCandidateDir: '' };
  }

  if (toolName === 'run_command') {
    const commandLine = String(args.CommandLine || args.command || '');
    return evaluateRunCommandDetailed(commandLine, payload);
  }

  return { result: allowResult, resolvedCtx: null, recordCandidateDir: '' };
}

export function evaluateHookPayload(payload) {
  return evaluateHookPayloadDetailed(payload).result;
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
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8').trim();
    const payload = raw ? JSON.parse(raw) : {};
    const { result, resolvedCtx, recordCandidateDir } = evaluateHookPayloadDetailed(payload);
    process.stdout.write(`${JSON.stringify(result || {})}\n`);

    if (result?.decision === 'allow') {
      const ctxToRecord = resolvedCtx || (recordCandidateDir ? resolveGitContext(recordCandidateDir) : null);
      if (ctxToRecord) recordConversationWorktree(payload, ctxToRecord);
    }
  } catch {
    const fallback = raw.includes('PreToolUse') ? { decision: 'allow' } : {};
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
  }
}
