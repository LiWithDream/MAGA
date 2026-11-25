#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROTECTED_BRANCHES = new Set(['main', 'master']);

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
const PROTECTED_REFSPEC_RE = /^\+?([^:]*:)?(refs\/heads\/)?(main|master)$/;

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

export function splitShellSegments(commandLine) {
  if (!commandLine || typeof commandLine !== 'string') return [];
  const segments = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed) segments.push(trimmed);
    buf = '';
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
      flush();
      continue;
    }

    if (ch === '&' && next === '&') {
      flush();
      i += 1;
      continue;
    }

    if (ch === '|') {
      flush();
      if (next === '|') i += 1;
      continue;
    }

    buf += ch;
  }

  flush();
  return segments;
}

export function tokenizeSegment(segment) {
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

export function extractGitInvocations(commandLine, initialCwd = process.cwd()) {
  const segments = splitShellSegments(commandLine);
  const invocations = [];
  let currentDir = path.resolve(expandHome(initialCwd) || process.cwd());
  let prevDir = currentDir;

  for (const seg of segments) {
    const rawTokens = tokenizeSegment(seg);
    if (rawTokens.length === 0) continue;

    const { env, cmdTokens } = parseCommandWrapper(rawTokens);
    if (cmdTokens.length === 0) continue;

    if (cmdTokens[0] === 'cd') {
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

      // Unknown leading git flag; consume and continue scanning for subcommand.
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

  return invocations;
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
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    branch = out || null;
  } catch {
    branch = null;
  }

  const merging = fs.existsSync(path.join(gitDir, 'MERGE_HEAD'));
  return { topLevel, gitDir, branch, merging };
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

function evaluateRunCommand(commandLine, payload) {
  const initialCwd = payload?.cwd || payload?.workspacePaths?.[0] || process.cwd();
  const invocations = extractGitInvocations(commandLine, initialCwd);

  for (const inv of invocations) {
    if (inv.subcommand === 'push') {
      const { isForce, hasTagsFlag, refspecs } = analyzePushArgs(inv.subArgs);
      if (hasTagsFlag) {
        return {
          decision: 'deny',
          reason:
            "Blocked by MAGA Git Guardrail: never run 'git push --tags' (legacy upstream v2.x/v3.x tags must not be pushed to origin). Push explicit tags instead: git push origin vX.Y.Z.",
        };
      }

      const ctx = resolveGitContext(inv.targetDir);
      if (!ctx) continue;

      const targetsProtected =
        refspecs.some((spec) => PROTECTED_REFSPEC_RE.test(spec)) ||
        (refspecs.length === 0 && Boolean(ctx.branch && PROTECTED_BRANCHES.has(ctx.branch)));

      if (isForce && targetsProtected) {
        return {
          decision: 'deny',
          reason: "Blocked by MAGA Git Guardrail: force-pushing to protected branch 'main'/'master' is forbidden.",
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
          decision: 'deny',
          reason: `Blocked by MAGA Git Guardrail: direct 'git commit' on protected branch '${ctx.branch}' is forbidden. Develop on a feat/*, fix/*, chore/*, or release/* branch (or sibling worktree) and merge back with 'git merge --no-ff'.`,
        };
      }
    }
  }

  return { decision: 'allow' };
}

export function evaluateHookPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};

  const eventName = String(payload.hookEventName || '');
  const baseCwd = payload.cwd || payload.workspacePaths?.[0] || process.cwd();

  if (eventName === 'SessionStart') {
    const ctx = resolveGitContext(baseCwd);
    if (ctx && ctx.branch && PROTECTED_BRANCHES.has(ctx.branch)) {
      return {
        injectSteps: [
          {
            systemMessage: {
              systemMessage: `[MAGA Git Guardrail] Current workspace is on protected branch '${ctx.branch}'. Never develop features or fix bugs directly on 'main'. Create a branch (\`git checkout -b feat/<slug>\` / \`fix/<slug>\`) or an isolated sibling worktree (\`git worktree add -b <type>/<slug> ../MAGA-wt/<slug> main\`) before editing files or committing. Direct repo edits and commits on 'main' are blocked by PreToolUse hook.`,
            },
          },
        ],
      };
    }
    return {};
  }

  if (eventName && eventName !== 'PreToolUse') {
    return {};
  }

  const isPreToolUse = eventName === 'PreToolUse' || Boolean(payload.toolCall);
  const allowResult = isPreToolUse ? { decision: 'allow' } : {};

  if (!isPreToolUse) {
    return {};
  }

  const toolName = String(payload.toolCall?.name || '').toLowerCase();
  const args = payload.toolCall?.args && typeof payload.toolCall.args === 'object' ? payload.toolCall.args : {};

  if (FILE_EDIT_TOOLS.has(toolName)) {
    const rawPath = args.Path || args.TargetFile || args.path || args.file_path || '';
    if (!rawPath || typeof rawPath !== 'string') return allowResult;

    const absPath = path.resolve(baseCwd, expandHome(rawPath));
    if (payload.artifactDirectoryPath && isInsideDir(absPath, payload.artifactDirectoryPath)) {
      return allowResult;
    }

    const ctx = resolveGitContext(path.dirname(absPath));
    if (!ctx || ctx.merging) return allowResult;

    if (ctx.branch && PROTECTED_BRANCHES.has(ctx.branch)) {
      return {
        decision: 'deny',
        reason: `Blocked by MAGA Git Guardrail: cannot edit repository files directly on protected branch '${ctx.branch}' (${ctx.topLevel}). Switch to a feature/fix branch (\`git checkout -b feat/<slug>\` or \`fix/<slug>\`) or create an isolated sibling worktree (\`git worktree add -b <type>/<slug> ../MAGA-wt/<slug> main\`) first.`,
      };
    }
    return allowResult;
  }

  if (toolName === 'run_command') {
    const commandLine = String(args.CommandLine || args.command || '');
    return evaluateRunCommand(commandLine, payload);
  }

  return allowResult;
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
    const result = evaluateHookPayload(payload);
    process.stdout.write(`${JSON.stringify(result || {})}\n`);
  } catch {
    const fallback = raw.includes('PreToolUse') ? { decision: 'allow' } : {};
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
  }
}
