/**
 * Git Diff Inspection, Landing Command Detection (`git merge` / `git push` / `npm run deploy`),
 * and Worktree Root Attribution Helpers for `maga-opus-gate`.
 * Zero third-party dependencies (Node >= 22 built-ins only).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HIGH_RISK_PATH_RE =
  /(?:^|[\\/])(?:kernel|dom|cdp-[^\\/]+|daemon|prefs-bundle|build|cli|auth|security|migration|schema)\.(?:m?js|ts|sql)$|package\.json$|hooks\.json$/i;
const GIT_DEADLINE_MS = 3000;
const realpathNative = fs.realpathSync.native || fs.realpathSync;

export function normFsPathKey(p) {
  const s = String(p || '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

export function sha1Short(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

export function realpathSafe(p) {
  if (!p) return '';
  try {
    return realpathNative(p);
  } catch {
    return path.resolve(p);
  }
}

export function resolveAbsPath(rawPath, cwd = '') {
  const s = String(rawPath || '').trim();
  if (!s) return '';
  const candidate = path.isAbsolute(s) ? path.normalize(s) : path.resolve(cwd || process.cwd(), s);
  try {
    if (fs.existsSync(candidate)) return realpathNative(candidate);
  } catch {}
  let cur = path.dirname(candidate);
  const tail = [path.basename(candidate)];
  while (cur) {
    try {
      if (fs.existsSync(cur)) return path.join(realpathNative(cur), ...tail);
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return candidate;
}

export function findGitRootSync(startPath) {
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
        const label =
          cmdBase === 'npm' && pos[0] === 'run'
            ? 'npm run deploy'
            : `${cmdBase} ${pos[0] === 'run' ? 'run deploy' : 'deploy'}`;
        return { action: 'deploy', repoDir: deployDir, sourceRef: '', label };
      }
    }
  }
  return null;
}

export function getGitCommonDirNoSpawn(dir) {
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

export function resolveEffectiveGitRoot(touchedAbsFiles, fallbackCwd = '') {
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

export function resolveLandingGitRoot(touchedAbsFiles, landingRepoDir, fallbackCwd = '') {
  const landingRoot = findGitRootSync(landingRepoDir || fallbackCwd || '');
  if (landingRoot) {
    const landingCommon = normFsPathKey(getGitCommonDirNoSpawn(landingRoot));
    if (landingCommon && Array.isArray(touchedAbsFiles)) {
      for (let i = touchedAbsFiles.length - 1; i >= 0; i--) {
        const p = touchedAbsFiles[i];
        if (!p) continue;
        const root = findGitRootSync(p);
        if (root && normFsPathKey(getGitCommonDirNoSpawn(root)) === landingCommon) return root;
      }
    }
    return landingRoot;
  }
  return resolveEffectiveGitRoot(touchedAbsFiles, fallbackCwd);
}

export function inspectGitSummary(
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
        windowsHide: true,
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
