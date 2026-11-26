/**
 * Portable Shell Segment, Tokenizer, Redirect & Git Invocation Parser for `maga-git-workflow`.
 * Zero external dependencies; self-contained inside `studio/plugin/maga-git-workflow/`.
 */
import os from 'node:os';
import path from 'node:path';

export const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export function expandHome(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return inputPath;
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function splitShellSegmentsWithOps(commandLine) {
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

export function stripUnquotedGroupDelimiters(segmentText) {
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

export function isGitBinary(token) {
  if (!token) return false;
  return token === 'git' || path.basename(token) === 'git';
}

export function parseCommandWrapper(tokens) {
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

export function extractInlineShellString(cmdTokens) {
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

export function extractGitInvocationsDetailed(commandLine, initialCwd = process.cwd(), depth = 0) {
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

export function extractWriteRedirectTargets(segmentText) {
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

export function getShellSegmentWriteInfo(cmdTokens, rawSegText) {
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
