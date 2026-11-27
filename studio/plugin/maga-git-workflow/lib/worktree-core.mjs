/**
 * Pure, self-contained Git Worktree Core (Node built-ins only).
 * Shared by `~/.gemini/config/plugins/maga-git-workflow/bin/wt.mjs` and `core/daemon/worktrees.mjs`.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SAFE_CID_RE = /^[A-Za-z0-9_-]{6,128}$/;
export const ALLOWED_WORKTREE_TYPES = new Set([
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'chore',
  'release',
]);
export const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,48}$/;
export const ACTIVE_CID_TTL_MS = 10 * 60 * 1000;
export const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
export const DEFAULT_PROTECTED_BRANCHES = new Set(['main', 'master']);
export const LOCAL_GOVERNANCE_ALLOWLIST = Object.freeze([
  'AGENTS.md',
  'GEMINI.md',
  'ENV.md',
  '.agents/skills',
  '.agents/rules',
]);
const LOCAL_GOVERNANCE_MANIFEST_FILE = 'maga-wt-governance.json';
const MAX_GOVERNANCE_FILE_BYTES = 512 * 1024;

const realpathNative = fs.realpathSync.native || fs.realpathSync;

export function getRealPathPreserveCase(p) {
  const resolved = path.resolve(String(p || ''));
  try {
    return realpathNative(resolved);
  } catch {
    return resolved;
  }
}

export function normalizeRealPath(p) {
  const real = getRealPathPreserveCase(p);
  return CASE_INSENSITIVE_FS ? real.toLowerCase() : real;
}

export function normalizePolicyKey(p) {
  const real = getRealPathPreserveCase(p).replace(/\\/g, '/');
  if (CASE_INSENSITIVE_FS) return real.toLowerCase();
  return real.replace(/^[A-Z]:(?=\/)/, (m) => m.toLowerCase());
}

const LOCK_SLEEP_BUF = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

export function withFileLock(targetFile, fn, { maxWaitMs = 400, staleMs = 5000, busyError = 'file_locked' } = {}) {
  const lockPath = `${targetFile}.lock`;
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  let acquired = false;
  let lockError = '';
  const waitBudgetMs = Math.max(0, Number(maxWaitMs) || 0);
  const deadline = Date.now() + waitBudgetMs;
  const maxAttempts = Math.max(40, Math.ceil(waitBudgetMs / 10) + 5);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, `${process.pid}:${Date.now()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        lockError = `${busyError}_error:${err?.code || 'unknown'}`;
        break;
      }
      try {
        const st = fs.statSync(lockPath, { throwIfNoEntry: false });
        if (st && Date.now() - st.mtimeMs > staleMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) break;
      if (LOCK_SLEEP_BUF) {
        try {
          Atomics.wait(LOCK_SLEEP_BUF, 0, 0, 10);
        } catch {}
      }
    }
  }
  if (!acquired) {
    return {
      ok: false,
      error: lockError || busyError,
      retryable: !lockError,
    };
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {}
  }
}

export function writeAtomicUtf8(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    if (process.platform === 'win32') {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          fs.renameSync(tmp, filePath);
          break;
        } catch (err) {
          const code = err?.code;
          if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt === 5) {
            throw err;
          }
          if (LOCK_SLEEP_BUF) {
            try {
              Atomics.wait(LOCK_SLEEP_BUF, 0, 0, 20);
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

export function execGitAsyncWithRaw(absDir, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', absDir, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 256 * 1024,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut: Boolean(err?.killed && err?.signal === 'SIGTERM'),
          errorCode: err?.code ?? null,
        });
      }
    );
  });
}

export function execGitWithStatusAsync(absDir, args, timeoutMs = 4000) {
  return execGitAsyncWithRaw(absDir, args, timeoutMs);
}

export function detectDefaultBranchFromFs(commonDir) {
  if (!commonDir) return '';
  try {
    const headRefPath = path.join(commonDir, 'refs', 'remotes', 'origin', 'HEAD');
    const raw = fs.readFileSync(headRefPath, 'utf8').trim();
    const m = raw.match(/^ref:\s*refs\/remotes\/origin\/([^\s\r\n]+)$/);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

export async function detectOriginHeadBranchAsync(absDir, commonDir = '') {
  const fromFs = detectDefaultBranchFromFs(commonDir);
  if (fromFs) return fromFs;
  if (!absDir) return '';
  const res = await execGitAsyncWithRaw(
    absDir,
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    1000
  );
  if (!res.ok) return '';
  const trimmed = res.stdout.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('origin/') ? trimmed.slice('origin/'.length) : trimmed;
}

export function getProtectedBranchesForRepo(commonDir, customProtectedBranches = null, fallbackDetected = '') {
  if (Array.isArray(customProtectedBranches) && customProtectedBranches.length > 0) {
    const custom = new Set();
    for (const item of customProtectedBranches) {
      const name = String(item || '').trim();
      if (name) custom.add(name);
    }
    if (custom.size > 0) return custom;
  }
  const set = new Set(['main', 'master']);
  const detected = detectDefaultBranchFromFs(commonDir) || String(fallbackDetected || '').trim();
  if (detected && detected !== 'HEAD') set.add(detected);
  return set;
}

export async function resolveCommonGitDirAsync(dirPath) {
  const resolved = path.resolve(String(dirPath || ''));
  const res = await execGitAsyncWithRaw(
    resolved,
    ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'],
    1500
  );
  if (!res.ok) return null;
  const lines = res.stdout.trim().split(/\r?\n/);
  if (lines.length < 3) return null;
  const topLevel = getRealPathPreserveCase(lines[0].trim());
  const gitDir = getRealPathPreserveCase(path.resolve(resolved, lines[1].trim()));
  const commonDir = getRealPathPreserveCase(path.resolve(resolved, lines[2].trim()));
  const isLinkedWorktree = normalizePolicyKey(gitDir) !== normalizePolicyKey(commonDir);
  const mainRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : topLevel;
  return {
    topLevel,
    gitDir,
    commonDir,
    commonDirKey: normalizePolicyKey(commonDir),
    mainRoot,
    isLinkedWorktree,
  };
}

export function parseWorktreeListPorcelainZ(raw, protectedBranches = DEFAULT_PROTECTED_BRANCHES) {
  if (!raw || typeof raw !== 'string') return [];
  const prot = protectedBranches instanceof Set ? protectedBranches : DEFAULT_PROTECTED_BRANCHES;
  const tokens = raw.split('\0');
  const entries = [];
  let cur = null;

  const pushCur = () => {
    if (!cur || !cur.path) return;
    const realPath = getRealPathPreserveCase(cur.path);
    const branch = cur.branchRef ? cur.branchRef.replace(/^refs\/heads\//, '') : '';
    const isMain = entries.length === 0;
    const isProtected = Boolean(branch && prot.has(branch));
    entries.push({
      path: cur.path,
      realPath,
      head: cur.head || '',
      branch,
      isMain,
      isProtected,
      detached: Boolean(cur.detached),
      bare: Boolean(cur.bare),
      locked: Boolean(cur.locked),
      lockReason: cur.lockReason || '',
      prunable: Boolean(cur.prunable),
      prunableReason: cur.prunableReason || '',
    });
    cur = null;
  };

  for (const tok of tokens) {
    if (tok === '') {
      pushCur();
      continue;
    }
    if (tok.startsWith('worktree ')) {
      pushCur();
      cur = {
        path: tok.slice('worktree '.length),
        head: '',
        branchRef: '',
        detached: false,
        bare: false,
        locked: false,
        lockReason: '',
        prunable: false,
        prunableReason: '',
      };
      continue;
    }
    if (!cur) continue;
    if (tok.startsWith('HEAD ')) {
      cur.head = tok.slice('HEAD '.length).trim();
    } else if (tok.startsWith('branch ')) {
      cur.branchRef = tok.slice('branch '.length).trim();
    } else if (tok === 'detached') {
      cur.detached = true;
    } else if (tok === 'bare') {
      cur.bare = true;
    } else if (tok === 'locked') {
      cur.locked = true;
    } else if (tok.startsWith('locked ')) {
      cur.locked = true;
      cur.lockReason = tok.slice('locked '.length).trim();
    } else if (tok === 'prunable') {
      cur.prunable = true;
    } else if (tok.startsWith('prunable ')) {
      cur.prunable = true;
      cur.prunableReason = tok.slice('prunable '.length).trim();
    }
  }
  pushCur();
  return entries;
}

export async function listRepoWorktreesPorcelainAsync(dirPath, { protectedBranches = null } = {}) {
  const absDir = path.resolve(String(dirPath || ''));
  const wtRes = await execGitAsyncWithRaw(absDir, ['worktree', 'list', '--porcelain', '-z'], 1500);
  if (!wtRes.ok) return { ok: false, error: 'not_git_repo', worktrees: [] };
  const gitCtx = await resolveCommonGitDirAsync(absDir);
  const commonDir = gitCtx?.commonDir || path.join(absDir, '.git');
  const prot = getProtectedBranchesForRepo(commonDir, protectedBranches);
  const worktrees = parseWorktreeListPorcelainZ(wtRes.stdout, prot);
  const mainEntry = worktrees.find((w) => w.isMain) || worktrees[0] || null;
  const mainDirPath = mainEntry ? mainEntry.realPath : getRealPathPreserveCase(absDir);
  return {
    ok: true,
    mainDirPath,
    commonDir,
    commonDirKey: normalizePolicyKey(commonDir),
    protectedBranches: Array.from(prot),
    worktrees,
  };
}

export async function ensureNodeModulesExcludedIfNeededAsync(mainReal, targetWorktreeDir = '') {
  const srcNodeModules = path.join(mainReal, 'node_modules');
  const hasMainNodeModules = fs.existsSync(srcNodeModules);
  const hasWorktreeNodeModulesSymlink = Boolean(
    targetWorktreeDir &&
    fs.lstatSync(path.join(targetWorktreeDir, 'node_modules'), { throwIfNoEntry: false })?.isSymbolicLink()
  );
  if (!hasMainNodeModules && !hasWorktreeNodeModulesSymlink) {
    return { needed: false };
  }

  const commonRes = await execGitAsyncWithRaw(mainReal, ['rev-parse', '--git-common-dir'], 1000);
  if (commonRes.ok && commonRes.stdout.trim()) {
    const commonDir = path.resolve(mainReal, commonRes.stdout.trim());
    const excludeFile = path.join(commonDir, 'info', 'exclude');
    try {
      const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
      const hasEntry = existing.split(/\r?\n/).some((line) => line.trim() === '/node_modules');
      if (!hasEntry) {
        const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
        writeAtomicUtf8(excludeFile, `${existing}${prefix}/node_modules\n`);
      }
    } catch {}
  }

  if (targetWorktreeDir && hasMainNodeModules) {
    const destNodeModules = path.join(targetWorktreeDir, 'node_modules');
    if (!fs.lstatSync(destNodeModules, { throwIfNoEntry: false })) {
      try {
        fs.symlinkSync(srcNodeModules, destNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {}
    }
  }

  return { needed: true };
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function isAllowedLocalGovernanceFileRel(relPath) {
  if (typeof relPath !== 'string') return false;
  const norm = relPath.trim().replace(/\\/g, '/');
  if (!norm || norm.startsWith('/') || norm.endsWith('/')) return false;
  const segs = norm.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..' || s === '*' || s === '**')) return false;
  if (norm === 'AGENTS.md' || norm === 'GEMINI.md' || norm === 'ENV.md') return true;
  if (norm.startsWith('.agents/skills/') && segs.length >= 3) return true;
  if (norm.startsWith('.agents/rules/') && segs.length >= 3) return true;
  return false;
}

async function isPathTrackedInGitAsync(repoDir, relPath) {
  const res = await execGitAsyncWithRaw(repoDir, ['ls-files', '--error-unmatch', '--', relPath], 1000);
  if (res.ok) return true;
  // Also check directory contents for directory entries like `.agents/skills`
  const listRes = await execGitAsyncWithRaw(repoDir, ['ls-files', '--', relPath], 1000);
  return Boolean(listRes.ok && listRes.stdout.trim());
}

function ensureExcludeEntries(commonDir, entriesToAdd) {
  if (!commonDir || !Array.isArray(entriesToAdd) || entriesToAdd.length === 0) return;
  const excludeFile = path.join(commonDir, 'info', 'exclude');
  try {
    const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
    const lines = existing.split(/\r?\n/).map((l) => l.trim());
    const lineSet = new Set(lines);
    const hasDotAgentsUmbrella = lineSet.has('/.agents') || lineSet.has('/.agents/') || lineSet.has('.agents') || lineSet.has('.agents/');
    const missing = [];
    for (const rawEntry of entriesToAdd) {
      const entry = rawEntry.startsWith('/') ? rawEntry : `/${rawEntry}`;
      const bare = entry.slice(1);
      if (bare.startsWith('.agents/') && hasDotAgentsUmbrella) continue;
      if (lineSet.has(entry) || lineSet.has(bare) || lineSet.has(`${entry}/`) || lineSet.has(`${bare}/`)) continue;
      lineSet.add(entry);
      missing.push(entry);
    }
    if (missing.length > 0) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      writeAtomicUtf8(excludeFile, `${existing}${prefix}${missing.join('\n')}\n`);
    }
  } catch {}
}

function collectSafeGovernanceDirFiles(baseDir, relPrefix, outFiles) {
  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === '.DS_Store' || ent.name.endsWith('.tmp') || ent.name.endsWith('.lock')) continue;
    const abs = path.join(baseDir, ent.name);
    const rel = `${relPrefix}/${ent.name}`;
    let lst = null;
    try {
      lst = fs.lstatSync(abs, { throwIfNoEntry: false });
    } catch {}
    if (!lst || lst.isSymbolicLink()) continue;
    if (lst.isDirectory()) {
      collectSafeGovernanceDirFiles(abs, rel, outFiles);
    } else if (lst.isFile() && lst.size <= MAX_GOVERNANCE_FILE_BYTES && isAllowedLocalGovernanceFileRel(rel)) {
      outFiles.push({ abs, rel });
    }
  }
}

export async function materializeLocalGovernanceAsync(mainReal, targetWorktreeDir, commonDir = '') {
  if (!mainReal || !targetWorktreeDir) return { materialized: [] };
  const gitDirRes = await execGitAsyncWithRaw(targetWorktreeDir, ['rev-parse', '--git-dir'], 1000);
  if (!gitDirRes.ok || !gitDirRes.stdout.trim()) return { materialized: [] };
  const wtGitDir = path.resolve(targetWorktreeDir, gitDirRes.stdout.trim());
  const resolvedCommon =
    commonDir || (await resolveCommonGitDirAsync(mainReal))?.commonDir || path.join(mainReal, '.git');

  const filesToCopy = [];
  const excludeCandidates = [];

  for (const item of LOCAL_GOVERNANCE_ALLOWLIST) {
    const srcAbs = path.join(mainReal, item);
    const lstat = fs.lstatSync(srcAbs, { throwIfNoEntry: false });
    if (!lstat) continue;

    // Never touch paths tracked in either primary checkout or worktree branch HEAD
    if ((await isPathTrackedInGitAsync(mainReal, item)) || (await isPathTrackedInGitAsync(targetWorktreeDir, item))) {
      continue;
    }

    const destCheck = path.join(targetWorktreeDir, item);
    if (fs.lstatSync(destCheck, { throwIfNoEntry: false })) continue;

    if (item === 'AGENTS.md' || item === 'GEMINI.md' || item === 'ENV.md') {
      if (lstat.isSymbolicLink()) {
        // Dereference symlink ONLY for AGENTS.md / GEMINI.md pointing to a regular .md file (e.g. ~/Research/GEMINI.md); never ENV.md
        if (item === 'ENV.md') continue;
        try {
          const targetReal = realpathNative(srcAbs);
          const targetStat = fs.statSync(targetReal);
          if (!targetStat.isFile() || targetStat.size > MAX_GOVERNANCE_FILE_BYTES || !targetReal.toLowerCase().endsWith('.md')) {
            continue;
          }
          filesToCopy.push({ abs: targetReal, rel: item });
          excludeCandidates.push(item);
        } catch {}
      } else if (lstat.isFile() && lstat.size <= MAX_GOVERNANCE_FILE_BYTES) {
        filesToCopy.push({ abs: srcAbs, rel: item });
        excludeCandidates.push(item);
      }
    } else if (lstat.isDirectory() && !lstat.isSymbolicLink()) {
      const beforeLen = filesToCopy.length;
      collectSafeGovernanceDirFiles(srcAbs, item, filesToCopy);
      if (filesToCopy.length > beforeLen) {
        excludeCandidates.push(item);
      }
    }
  }

  if (filesToCopy.length === 0) return { materialized: [] };

  ensureExcludeEntries(resolvedCommon, excludeCandidates);

  const recordedFiles = [];
  for (const f of filesToCopy) {
    if (!isAllowedLocalGovernanceFileRel(f.rel)) continue;
    const dstAbs = path.join(targetWorktreeDir, ...f.rel.split('/'));
    if (fs.lstatSync(dstAbs, { throwIfNoEntry: false })) continue;
    try {
      const buf = fs.readFileSync(f.abs);
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      fs.writeFileSync(dstAbs, buf);
      recordedFiles.push({ rel: f.rel, sha256: sha256Buffer(buf) });
    } catch {}
  }

  if (recordedFiles.length > 0) {
    try {
      writeAtomicUtf8(
        path.join(wtGitDir, LOCAL_GOVERNANCE_MANIFEST_FILE),
        `${JSON.stringify({ schema: 1, mainDirPath: mainReal, files: recordedFiles }, null, 2)}\n`
      );
    } catch {}
  }

  return { materialized: recordedFiles.map((r) => r.rel) };
}

async function cleanupLocalGovernanceBeforeRemoveAsync(worktreeRealPath) {
  const removedBackups = [];
  const skippedModified = [];
  const gitDirRes = await execGitAsyncWithRaw(worktreeRealPath, ['rev-parse', '--git-dir'], 1000);
  if (!gitDirRes.ok || !gitDirRes.stdout.trim()) {
    return { restore: () => {}, skippedModified };
  }
  const wtGitDir = path.resolve(worktreeRealPath, gitDirRes.stdout.trim());
  const manifestPath = path.join(wtGitDir, LOCAL_GOVERNANCE_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return { restore: () => {}, skippedModified };
  }

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { restore: () => {}, skippedModified };
  }

  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  for (const item of files) {
    const rel = typeof item?.rel === 'string' ? item.rel.trim() : '';
    const expectedSha = typeof item?.sha256 === 'string' ? item.sha256.trim().toLowerCase() : '';
    if (!isAllowedLocalGovernanceFileRel(rel) || !/^[0-9a-f]{64}$/.test(expectedSha)) continue;
    const targetAbs = path.join(worktreeRealPath, ...rel.split('/'));
    const lst = fs.lstatSync(targetAbs, { throwIfNoEntry: false });
    if (!lst || lst.isSymbolicLink() || !lst.isFile()) continue;
    try {
      const buf = fs.readFileSync(targetAbs);
      if (sha256Buffer(buf) !== expectedSha) {
        skippedModified.push(rel);
        continue;
      }
      fs.rmSync(targetAbs, { force: true });
      removedBackups.push({ targetAbs, buf });
    } catch {}
  }

  // Prune empty governance directories bottom-up so `git worktree remove` succeeds cleanly
  const pruneEmptyUpTo = (relDir) => {
    const absDir = path.join(worktreeRealPath, ...relDir.split('/'));
    const walkEmpty = (dir) => {
      let ents = [];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.isDirectory() && !e.isSymbolicLink()) walkEmpty(path.join(dir, e.name));
      }
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {}
    };
    if (fs.lstatSync(absDir, { throwIfNoEntry: false })?.isDirectory()) walkEmpty(absDir);
  };
  pruneEmptyUpTo('.agents/skills');
  pruneEmptyUpTo('.agents/rules');
  try {
    const dotAgents = path.join(worktreeRealPath, '.agents');
    if (fs.lstatSync(dotAgents, { throwIfNoEntry: false })?.isDirectory() && fs.readdirSync(dotAgents).length === 0) {
      fs.rmdirSync(dotAgents);
    }
  } catch {}

  const restore = () => {
    for (const bak of removedBackups) {
      try {
        if (!fs.lstatSync(bak.targetAbs, { throwIfNoEntry: false })) {
          fs.mkdirSync(path.dirname(bak.targetAbs), { recursive: true });
          fs.writeFileSync(bak.targetAbs, bak.buf);
        }
      } catch {}
    }
  };

  return { restore, skippedModified };
}

function validateSafeDirSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!SAFE_SLUG_RE.test(s) || s.includes('..') || s.endsWith('.lock') || s.endsWith('.') || s.startsWith('.')) {
    return '';
  }
  return s;
}

export async function createRepoWorktreeCore(
  mainEntry,
  {
    type = 'feat',
    slug = '',
    branch = '',
    baseBranch = '',
    allowGenericBranch = false,
    commonDir = '',
    protectedBranches = null,
  } = {}
) {
  if (!mainEntry || !mainEntry.realPath) return { ok: false, error: 'not_git_repo' };
  const mainReal = getRealPathPreserveCase(mainEntry.realPath);
  const resolvedCommon = commonDir || (await resolveCommonGitDirAsync(mainReal))?.commonDir || path.join(mainReal, '.git');
  const detectedOriginHead = await detectOriginHeadBranchAsync(mainReal, resolvedCommon);
  const prot = getProtectedBranchesForRepo(resolvedCommon, protectedBranches, detectedOriginHead);

  let fullBranch = '';
  let dirSlug = '';
  const rawBranch = String(branch || '').trim();

  if (rawBranch) {
    if (rawBranch.startsWith('-')) {
      return { ok: false, error: allowGenericBranch ? 'invalid_branch_name' : 'invalid_branch_format' };
    }
    const typedMatch = rawBranch.match(/^([a-z]+)\/(.+)$/i);
    if (typedMatch && !allowGenericBranch) {
      const wtType = typedMatch[1].toLowerCase();
      const wtSlug = validateSafeDirSlug(typedMatch[2]);
      if (!ALLOWED_WORKTREE_TYPES.has(wtType)) {
        return { ok: false, error: 'invalid_worktree_type' };
      }
      if (!wtSlug) {
        return { ok: false, error: 'invalid_worktree_slug' };
      }
      fullBranch = `${wtType}/${wtSlug}`;
      dirSlug = wtSlug;
    } else if (allowGenericBranch) {
      if (rawBranch.includes('..') || rawBranch.endsWith('.lock') || rawBranch.endsWith('.') || rawBranch.startsWith('.')) {
        return { ok: false, error: 'invalid_branch_name' };
      }
      fullBranch = rawBranch;
      const tail = rawBranch.includes('/') ? rawBranch.split('/').pop() : rawBranch;
      const normalized = String(tail || '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
      dirSlug = validateSafeDirSlug(normalized);
      if (!dirSlug) {
        return { ok: false, error: 'invalid_worktree_slug' };
      }
    } else {
      return { ok: false, error: 'invalid_branch_format' };
    }
  } else {
    const wtType = String(type || 'feat').trim().toLowerCase();
    const wtSlug = validateSafeDirSlug(slug);
    if (!ALLOWED_WORKTREE_TYPES.has(wtType)) {
      return { ok: false, error: 'invalid_worktree_type' };
    }
    if (!wtSlug) {
      return { ok: false, error: 'invalid_worktree_slug' };
    }
    fullBranch = `${wtType}/${wtSlug}`;
    dirSlug = wtSlug;
  }

  if (prot.has(fullBranch)) {
    return { ok: false, error: 'protected_branch_forbidden' };
  }

  const branchCheck = await execGitAsyncWithRaw(mainReal, ['check-ref-format', '--branch', fullBranch], 1000);
  if (!branchCheck.ok || !branchCheck.stdout.trim()) {
    return { ok: false, error: 'invalid_branch_name' };
  }

  const targetBase = String(baseBranch || mainEntry.branch || 'main').trim();
  if (!targetBase || targetBase.startsWith('-')) {
    return { ok: false, error: 'invalid_base_branch' };
  }
  const baseCheck = await execGitAsyncWithRaw(mainReal, ['check-ref-format', '--branch', targetBase], 1000);
  if (!baseCheck.ok || !baseCheck.stdout.trim()) {
    return { ok: false, error: 'invalid_base_branch' };
  }

  const wtParent = path.join(path.dirname(mainReal), `${path.basename(mainReal)}-wt`);
  const wtParentLstat = fs.lstatSync(wtParent, { throwIfNoEntry: false });
  if (wtParentLstat && wtParentLstat.isSymbolicLink()) {
    return { ok: false, error: 'unsafe_worktree_parent' };
  }
  fs.mkdirSync(wtParent, { recursive: true });
  const wtParentReal = getRealPathPreserveCase(wtParent);
  if (
    CASE_INSENSITIVE_FS
      ? wtParentReal.toLowerCase() !== wtParent.toLowerCase()
      : wtParentReal !== wtParent
  ) {
    return { ok: false, error: 'unsafe_worktree_parent' };
  }

  const dest = path.join(wtParentReal, dirSlug);
  const existingLstat = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (existingLstat) {
    return { ok: false, error: 'worktree_path_exists' };
  }

  const addRes = await execGitWithStatusAsync(
    mainReal,
    ['worktree', 'add', '-b', fullBranch, '--', dest, targetBase],
    8000
  );
  if (!addRes.ok) {
    return {
      ok: false,
      error: 'git_worktree_add_failed',
      detail: addRes.stderr.trim() || 'git worktree add failed',
    };
  }

  const destReal = getRealPathPreserveCase(dest);
  await ensureNodeModulesExcludedIfNeededAsync(mainReal, destReal);
  const govRes = await materializeLocalGovernanceAsync(mainReal, destReal, resolvedCommon);

  return {
    ok: true,
    worktreePath: destReal,
    branch: fullBranch,
    baseBranch: targetBase,
    mainDirPath: mainReal,
    ...(govRes.materialized.length > 0 ? { governanceMaterialized: govRes.materialized } : {}),
  };
}

export async function removeRepoWorktreeCore(
  mainEntry,
  worktrees,
  {
    worktreePath = '',
    deleteBranch = false,
    forceActive = false,
    commonDir = '',
    protectedBranches = null,
    now = Date.now(),
  } = {}
) {
  if (!mainEntry || !mainEntry.realPath) return { ok: false, error: 'not_git_repo' };
  const mainReal = getRealPathPreserveCase(mainEntry.realPath);
  const rawTarget = String(worktreePath || '').trim();
  if (!rawTarget) return { ok: false, error: 'missing_worktree_path' };

  const list = Array.isArray(worktrees) ? worktrees : [];
  const targetNorm = normalizeRealPath(rawTarget);
  const entry = list.find(
    (w) => normalizeRealPath(w.realPath) === targetNorm || normalizeRealPath(w.path) === targetNorm
  );
  if (!entry) return { ok: false, error: 'worktree_not_found' };
  if (entry.isMain) return { ok: false, error: 'cannot_remove_main_worktree' };
  if (entry.locked) return { ok: false, error: 'worktree_locked' };
  if (entry.prunable) return { ok: false, error: 'worktree_prunable' };

  if (!forceActive && Array.isArray(entry.boundCids)) {
    const activeBound = entry.boundCids.some((b) => b.updatedAt > 0 && now - b.updatedAt <= ACTIVE_CID_TTL_MS);
    if (activeBound) {
      return { ok: false, error: 'worktree_active_in_conversation' };
    }
  }

  await ensureNodeModulesExcludedIfNeededAsync(mainReal, entry.realPath);
  const govCleanup = await cleanupLocalGovernanceBeforeRemoveAsync(entry.realPath);
  if (govCleanup.skippedModified.length > 0) {
    govCleanup.restore();
    return {
      ok: false,
      error: 'modified_governance_files',
      detail: `Refusing to remove worktree with modified local governance files: ${govCleanup.skippedModified.join(', ')}`,
      modifiedGovernanceFiles: govCleanup.skippedModified,
    };
  }

  const wtNodeModules = path.join(entry.realPath, 'node_modules');
  const mainNodeModules = path.join(mainReal, 'node_modules');
  let unlinkedNodeModules = false;
  try {
    const nmStat = fs.lstatSync(wtNodeModules, { throwIfNoEntry: false });
    if (nmStat && nmStat.isSymbolicLink()) {
      try {
        fs.unlinkSync(wtNodeModules);
      } catch {
        fs.rmdirSync(wtNodeModules);
      }
      unlinkedNodeModules = true;
    }
  } catch {}

  const rmRes = await execGitWithStatusAsync(mainReal, ['worktree', 'remove', '--', entry.realPath], 8000);
  if (!rmRes.ok) {
    govCleanup.restore();
    if (unlinkedNodeModules && fs.existsSync(mainNodeModules) && !fs.lstatSync(wtNodeModules, { throwIfNoEntry: false })) {
      try {
        fs.symlinkSync(mainNodeModules, wtNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {}
    }
    return {
      ok: false,
      error: 'git_worktree_remove_failed',
      detail: rmRes.stderr.trim() || 'worktree may be dirty',
      ...(govCleanup.skippedModified.length > 0 ? { modifiedGovernanceFiles: govCleanup.skippedModified } : {}),
    };
  }

  const resolvedCommon = commonDir || (await resolveCommonGitDirAsync(mainReal))?.commonDir || path.join(mainReal, '.git');
  const prot = getProtectedBranchesForRepo(resolvedCommon, protectedBranches);

  let branchDeleted = false;
  let branchWarning = '';
  if (deleteBranch && entry.branch && !prot.has(entry.branch)) {
    const brRes = await execGitWithStatusAsync(mainReal, ['branch', '-d', '--', entry.branch], 4000);
    if (brRes.ok) {
      branchDeleted = true;
    } else {
      branchWarning = brRes.stderr.trim() || 'branch not fully merged';
    }
  }

  return {
    ok: true,
    removedPath: entry.realPath,
    branch: entry.branch,
    branchDeleted,
    ...(branchWarning ? { branchWarning } : {}),
  };
}
