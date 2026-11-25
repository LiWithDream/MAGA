/**
 * Hardened Git Worktree Discovery, Per-Conversation Pinning & Lifecycle Service.
 * Imports only Node built-ins, `./env.mjs`, `./git-exec.mjs`, and `./projects.mjs`
 * so CLI tools (`studio/wt-cli.mjs`) never pull CDP or bundle runtime state.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  NATIVE_PROJECTS_DIR,
  STATE_DIR,
  readJsonOrFallback,
  setBounded,
  writeAtomicUtf8,
} from './env.mjs';
import {
  execGitAsync,
  invalidateOverviewGitCache,
  readOverviewGitStatusAsync,
} from './git-exec.mjs';
import {
  getRegisteredProjectDirs,
  resolveLocalProjectDir,
} from './projects.mjs';

export const CONV_WORKTREES_DIR = path.join(STATE_DIR, 'conv-worktrees');
export const PINS_FILE_NAME = 'pins.json';
export const SAFE_CID_RE = /^[A-Za-z0-9_-]{6,128}$/;
export const ALLOWED_WORKTREE_TYPES = new Set(['feat', 'fix', 'perf', 'refactor', 'docs', 'chore', 'release']);
export const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,48}$/;

const MAX_HOOK_FILES = 64;
const ACTIVE_CID_TTL_MS = 10 * 60 * 1000;
const WORKTREE_CACHE_TTL_MS = 5000;
const STATS_CONCURRENCY = 3;
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

const worktreeListCache = new Map();
const worktreeListInFlight = new Map();
const worktreeAheadCache = new Map();

export function getRealPathPreserveCase(p) {
  const resolved = path.resolve(String(p || ''));
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function normalizeRealPath(p) {
  const real = getRealPathPreserveCase(p);
  return CASE_INSENSITIVE_FS ? real.toLowerCase() : real;
}

function getPinsFilePath(convWtDir = CONV_WORKTREES_DIR) {
  return path.join(convWtDir, PINS_FILE_NAME);
}

function extractNativeProjectFolderUris(record) {
  const uris = [];
  if (!record || typeof record !== 'object') return uris;
  if (Array.isArray(record.folderUris)) uris.push(...record.folderUris);
  const resources = Array.isArray(record.projectResources?.resources) ? record.projectResources.resources : [];
  for (const res of resources) {
    if (!res || typeof res !== 'object') continue;
    for (const candidate of [res, res.gitFolder, res.folder, res.workspace]) {
      if (!candidate || typeof candidate !== 'object') continue;
      for (const key of ['folderUri', 'workspaceFolderAbsoluteUri', 'uri', 'dirPath', 'path']) {
        if (typeof candidate[key] === 'string' && candidate[key].trim()) {
          uris.push(candidate[key].trim());
        }
      }
    }
  }
  return uris;
}

export function getAuthorizedProjectDirs({ nativeProjectsDir = NATIVE_PROJECTS_DIR } = {}) {
  const byNorm = new Map();
  const addDir = (raw) => {
    const resolved = resolveLocalProjectDir(raw);
    if (!resolved) return;
    const norm = normalizeRealPath(resolved);
    if (!byNorm.has(norm)) byNorm.set(norm, getRealPathPreserveCase(resolved));
  };

  for (const d of getRegisteredProjectDirs()) {
    addDir(d);
  }

  try {
    const entries = fs.readdirSync(nativeProjectsDir, { withFileTypes: true });
    for (const ent of entries) {
      if ((!ent.isFile() && !ent.isSymbolicLink()) || !ent.name.endsWith('.json')) continue;
      const rec = readJsonOrFallback(path.join(nativeProjectsDir, ent.name), null);
      for (const uri of extractNativeProjectFolderUris(rec)) {
        addDir(uri);
      }
    }
  } catch {}

  return Array.from(byNorm.values());
}

export function isAuthorizedProjectDir(absDir, opts = {}) {
  if (!absDir) return false;
  if (Array.isArray(opts.authorizedDirs)) {
    const targetNorm = normalizeRealPath(absDir);
    return opts.authorizedDirs.some((d) => normalizeRealPath(d) === targetNorm);
  }
  const targetNorm = normalizeRealPath(absDir);
  return getAuthorizedProjectDirs(opts).some((d) => normalizeRealPath(d) === targetNorm);
}

export function parseWorktreeListPorcelainZ(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const tokens = raw.split('\0');
  const entries = [];
  let cur = null;

  const pushCur = () => {
    if (!cur || !cur.path) return;
    const realPath = getRealPathPreserveCase(cur.path);
    const branch = cur.branchRef ? cur.branchRef.replace(/^refs\/heads\//, '') : '';
    const isMain = entries.length === 0;
    const isProtected = branch === 'main' || branch === 'master';
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

export function loadConversationWorktreeMap({ convWtDir = CONV_WORKTREES_DIR } = {}) {
  const hooksByCid = {};
  const pinsByCid = {};
  const entries = {};
  const hookFiles = [];

  try {
    const dirEntries = fs.readdirSync(convWtDir, { withFileTypes: true });
    for (const ent of dirEntries) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      if (ent.name === PINS_FILE_NAME) continue;
      const cid = ent.name.slice(0, -'.json'.length);
      if (!SAFE_CID_RE.test(cid)) continue;
      const filePath = path.join(convWtDir, ent.name);
      const data = readJsonOrFallback(filePath, null);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs || 0;
      } catch {}
      if (!data || typeof data !== 'object' || typeof data.worktreePath !== 'string' || !data.worktreePath.trim()) {
        continue;
      }
      const updatedAt = Number(data.updatedAt) || Math.floor(mtimeMs) || 0;
      const rec = {
        cid,
        worktreePath: data.worktreePath.trim(),
        branch: String(data.branch || '').trim(),
        repoRoot: String(data.repoRoot || '').trim(),
        source: 'hook',
        updatedAt,
      };
      hooksByCid[cid] = rec;
      entries[cid] = rec;
      hookFiles.push({ filePath, sortTs: updatedAt || mtimeMs });
    }
  } catch {}

  if (hookFiles.length > MAX_HOOK_FILES) {
    hookFiles.sort((a, b) => a.sortTs - b.sortTs);
    const excess = hookFiles.length - MAX_HOOK_FILES;
    for (let i = 0; i < excess; i += 1) {
      try {
        fs.rmSync(hookFiles[i].filePath, { force: true });
      } catch {}
    }
  }

  const pinsDoc = readJsonOrFallback(getPinsFilePath(convWtDir), null);
  const rawPins = pinsDoc && typeof pinsDoc.pins === 'object' && pinsDoc.pins ? pinsDoc.pins : {};
  for (const [cid, pin] of Object.entries(rawPins)) {
    if (!SAFE_CID_RE.test(cid)) continue;
    if (!pin || typeof pin !== 'object' || typeof pin.worktreePath !== 'string' || !pin.worktreePath.trim()) {
      continue;
    }
    const rec = {
      cid,
      worktreePath: pin.worktreePath.trim(),
      branch: String(pin.branch || '').trim(),
      repoRoot: String(pin.repoRoot || '').trim(),
      source: 'manual',
      updatedAt: Number(pin.updatedAt) || 0,
    };
    pinsByCid[cid] = rec;
    entries[cid] = rec;
  }

  return { ok: true, entries, hooksByCid, pinsByCid };
}

async function mapWithConcurrency(items, limit, fn) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readAheadBehindAsync(wtDir, baseBranch, { force = false } = {}) {
  if (!wtDir || !baseBranch) return { ahead: 0, behind: 0 };
  const key = `${normalizeRealPath(wtDir)}::${baseBranch}`;
  const now = Date.now();
  const cached = worktreeAheadCache.get(key);
  if (!force && cached && now - cached.ts < WORKTREE_CACHE_TTL_MS) {
    return cached.val;
  }
  const prevGood = cached?.val || { ahead: 0, behind: 0 };
  const out = await execGitAsync(wtDir, ['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`], 1000);
  if (out !== null) {
    const parts = out.trim().split(/\s+/);
    const behind = parseInt(parts[0], 10);
    const ahead = parseInt(parts[1], 10);
    const val = {
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
    setBounded(worktreeAheadCache, key, { ts: Date.now(), val }, 64);
    return val;
  }
  return prevGood;
}

async function fetchBaseWorktreeListAsync(absDir, { force = false } = {}) {
  const repoKey = normalizeRealPath(absDir);
  if (!force) {
    const cached = worktreeListCache.get(repoKey);
    if (cached && Date.now() - cached.ts < WORKTREE_CACHE_TTL_MS) {
      return cached.entries;
    }
  }
  if (worktreeListInFlight.has(repoKey)) {
    return worktreeListInFlight.get(repoKey);
  }
  const prevGood = worktreeListCache.get(repoKey)?.entries || null;

  const task = (async () => {
    let entries = [];
    const out = await execGitAsync(absDir, ['worktree', 'list', '--porcelain', '-z'], 1500);
    if (out !== null) {
      entries = parseWorktreeListPorcelainZ(out);
    } else if (prevGood) {
      entries = prevGood;
    }
    setBounded(worktreeListCache, repoKey, { ts: Date.now(), entries }, 32);
    return entries;
  })().finally(() => {
    worktreeListInFlight.delete(repoKey);
  });

  worktreeListInFlight.set(repoKey, task);
  return task;
}

export function invalidateWorktreeListCache(dirPath = '') {
  if (dirPath) {
    worktreeListCache.delete(normalizeRealPath(dirPath));
  } else {
    worktreeListCache.clear();
  }
}

export async function listRepoWorktreesAsync(
  rawDir,
  { force = false, includeStats = false, activeWorktreePath = '', convWtDir = CONV_WORKTREES_DIR } = {}
) {
  const absDir = resolveLocalProjectDir(rawDir);
  if (!absDir) {
    return { ok: false, error: 'invalid_project_dir', mainDirPath: '', baseBranch: '', worktrees: [] };
  }

  const baseEntries = await fetchBaseWorktreeListAsync(absDir, { force });
  const mainEntry = baseEntries.find((w) => w.isMain) || baseEntries[0] || null;
  const mainDirPath = mainEntry ? mainEntry.realPath : getRealPathPreserveCase(absDir);
  const baseBranch = mainEntry && mainEntry.branch && !mainEntry.detached ? mainEntry.branch : 'main';

  const convMap = loadConversationWorktreeMap({ convWtDir });
  const now = Date.now();

  const boundByNorm = new Map();
  for (const rec of Object.values(convMap.entries)) {
    const wtNorm = normalizeRealPath(rec.worktreePath);
    if (!boundByNorm.has(wtNorm)) boundByNorm.set(wtNorm, []);
    boundByNorm.get(wtNorm).push({
      cid: rec.cid,
      source: rec.source,
      updatedAt: rec.updatedAt || 0,
      branch: rec.branch || '',
    });
  }

  const activeNorm = activeWorktreePath ? normalizeRealPath(activeWorktreePath) : '';

  const enriched = baseEntries.map((entry) => {
    const norm = normalizeRealPath(entry.realPath);
    const bound = boundByNorm.get(norm) || [];
    const recentNonMain =
      !entry.isMain
        ? bound.filter((b) => b.updatedAt > 0 && now - b.updatedAt <= ACTIVE_CID_TTL_MS).map((b) => b.cid)
        : [];
    const collisionCids = recentNonMain.length >= 2 ? recentNonMain : [];
    return Object.assign({}, entry, {
      boundCids: bound,
      collisionCids,
      git: null,
      ahead: 0,
      behind: 0,
    });
  });

  const targetsForStats = enriched.filter((w) => {
    if (w.bare || w.prunable) return false;
    if (includeStats) return true;
    return Boolean(activeNorm && normalizeRealPath(w.realPath) === activeNorm);
  });

  if (targetsForStats.length > 0) {
    await mapWithConcurrency(targetsForStats, STATS_CONCURRENCY, async (wt) => {
      const git = await readOverviewGitStatusAsync(wt.realPath, { force });
      wt.git = git || null;
      if (includeStats && !wt.isMain && wt.branch && baseBranch && wt.branch !== baseBranch) {
        const { ahead, behind } = await readAheadBehindAsync(wt.realPath, baseBranch, { force });
        wt.ahead = ahead;
        wt.behind = behind;
      }
    });
  }

  return {
    ok: true,
    mainDirPath,
    baseBranch,
    worktrees: enriched,
  };
}

export async function resolveConversationWorktreeAsync(
  projectDir,
  cid,
  { force = false, convWtDir = CONV_WORKTREES_DIR } = {}
) {
  const absDir = resolveLocalProjectDir(projectDir);
  if (!absDir) {
    return {
      ok: false,
      worktreePath: '',
      branch: '',
      isWorktree: false,
      source: 'default',
      mainDirPath: '',
      worktreeCount: 0,
      collisionCids: [],
    };
  }

  const listRes = await listRepoWorktreesAsync(absDir, { force, includeStats: false, convWtDir });
  const mainEntry = listRes.worktrees.find((w) => w.isMain) || listRes.worktrees[0] || null;
  const mainDirPath = listRes.mainDirPath || getRealPathPreserveCase(absDir);
  const worktreeCount = listRes.worktrees.length;

  const cleanCid = String(cid || '').trim();
  if (!SAFE_CID_RE.test(cleanCid)) {
    return {
      ok: true,
      worktreePath: mainDirPath,
      branch: mainEntry?.branch || '',
      isWorktree: false,
      source: 'default',
      mainDirPath,
      worktreeCount,
      collisionCids: [],
    };
  }

  const convMap = loadConversationWorktreeMap({ convWtDir });
  for (const rec of [convMap.pinsByCid?.[cleanCid], convMap.hooksByCid?.[cleanCid]]) {
    if (!rec || !rec.worktreePath) continue;
    const recNorm = normalizeRealPath(rec.worktreePath);
    const matched = listRes.worktrees.find((w) => !w.prunable && normalizeRealPath(w.realPath) === recNorm);
    if (matched) {
      return {
        ok: true,
        worktreePath: matched.realPath,
        branch: matched.branch || (matched.detached ? 'HEAD' : '') || rec.branch || '',
        isWorktree: !matched.isMain,
        source: rec.source,
        mainDirPath,
        worktreeCount,
        collisionCids: matched.collisionCids.filter((id) => id !== cleanCid),
      };
    }
  }

  return {
    ok: true,
    worktreePath: mainDirPath,
    branch: mainEntry?.branch || '',
    isWorktree: false,
    source: 'default',
    mainDirPath,
    worktreeCount,
    collisionCids: [],
  };
}

export async function setConversationWorktreeBindingAsync(
  projectDir,
  cid,
  worktreePath = '',
  { convWtDir = CONV_WORKTREES_DIR } = {}
) {
  const cleanCid = String(cid || '').trim();
  if (!SAFE_CID_RE.test(cleanCid)) {
    return { ok: false, error: 'invalid_conversation_id' };
  }
  const absDir = resolveLocalProjectDir(projectDir);
  if (!absDir) {
    return { ok: false, error: 'invalid_project_dir' };
  }

  const pinsFile = getPinsFilePath(convWtDir);
  const existingDoc = readJsonOrFallback(pinsFile, null);
  const pins = existingDoc && typeof existingDoc.pins === 'object' && existingDoc.pins ? { ...existingDoc.pins } : {};

  const rawTarget = String(worktreePath || '').trim();
  if (!rawTarget) {
    delete pins[cleanCid];
    writeAtomicUtf8(pinsFile, `${JSON.stringify({ schema: 1, pins }, null, 2)}\n`);
    return { ok: true, cid: cleanCid, mode: 'auto', worktreePath: '' };
  }

  const listRes = await listRepoWorktreesAsync(absDir, { force: true, convWtDir });
  const targetNorm = normalizeRealPath(rawTarget);
  const matched = listRes.worktrees.find((w) => !w.prunable && normalizeRealPath(w.realPath) === targetNorm);
  if (!matched) {
    return { ok: false, error: 'worktree_not_found' };
  }

  const resolvedBranch = matched.branch || (matched.detached ? 'HEAD' : '');
  pins[cleanCid] = {
    worktreePath: matched.realPath,
    branch: resolvedBranch,
    repoRoot: listRes.mainDirPath || getRealPathPreserveCase(absDir),
    updatedAt: Date.now(),
  };
  writeAtomicUtf8(pinsFile, `${JSON.stringify({ schema: 1, pins }, null, 2)}\n`);
  return {
    ok: true,
    cid: cleanCid,
    mode: 'manual',
    worktreePath: matched.realPath,
    branch: resolvedBranch,
  };
}

function execGitWithStatusAsync(absDir, args, timeoutMs = 4000) {
  return execGitAsyncWithRaw(absDir, args, timeoutMs);
}

function execGitAsyncWithRaw(absDir, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', absDir, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 256 * 1024,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      }
    );
  });
}

async function ensureNodeModulesExcludedAsync(repoDir) {
  const commonOut = await execGitAsync(repoDir, ['rev-parse', '--git-common-dir'], 1000);
  if (!commonOut) return;
  const commonDir = path.resolve(repoDir, commonOut.trim());
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

export async function createRepoWorktreeAsync(
  projectDir,
  {
    type = 'feat',
    slug = '',
    branch = '',
    baseBranch = '',
    cid = '',
    allowUnregistered = false,
    authorizedDirs = null,
    nativeProjectsDir = NATIVE_PROJECTS_DIR,
    convWtDir = CONV_WORKTREES_DIR,
  } = {}
) {
  const absProj = resolveLocalProjectDir(projectDir);
  if (!absProj) return { ok: false, error: 'invalid_project_dir' };
  if (!allowUnregistered && !isAuthorizedProjectDir(absProj, { authorizedDirs, nativeProjectsDir })) {
    return { ok: false, error: 'unregistered_project_dir' };
  }

  const listRes = await listRepoWorktreesAsync(absProj, { force: true, convWtDir });
  const mainEntry = listRes.worktrees.find((w) => w.isMain) || null;
  if (!mainEntry) return { ok: false, error: 'not_git_repo' };
  const mainReal = getRealPathPreserveCase(mainEntry.realPath);

  let wtType = String(type || 'feat').trim().toLowerCase();
  let wtSlug = String(slug || '').trim().toLowerCase();
  const rawBranch = String(branch || '').trim();
  if (rawBranch) {
    const m = rawBranch.match(/^([a-z]+)\/(.+)$/i);
    if (!m) return { ok: false, error: 'invalid_branch_format' };
    wtType = m[1].toLowerCase();
    wtSlug = m[2].toLowerCase();
  }

  if (!ALLOWED_WORKTREE_TYPES.has(wtType)) {
    return { ok: false, error: 'invalid_worktree_type' };
  }
  if (
    !SAFE_SLUG_RE.test(wtSlug) ||
    wtSlug.includes('..') ||
    wtSlug.endsWith('.lock') ||
    wtSlug.endsWith('.') ||
    wtSlug.startsWith('.')
  ) {
    return { ok: false, error: 'invalid_worktree_slug' };
  }

  const fullBranch = `${wtType}/${wtSlug}`;
  if (fullBranch === 'main' || fullBranch === 'master') {
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

  const dest = path.join(wtParentReal, wtSlug);
  const existingLstat = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (existingLstat) {
    return { ok: false, error: 'worktree_path_exists' };
  }

  const addRes = await execGitWithStatusAsync(mainReal, ['worktree', 'add', '-b', fullBranch, '--', dest, targetBase], 8000);
  if (!addRes.ok) {
    return { ok: false, error: 'git_worktree_add_failed', detail: addRes.stderr.trim() || 'git worktree add failed' };
  }

  const destReal = getRealPathPreserveCase(dest);
  await ensureNodeModulesExcludedAsync(mainReal);
  const srcNodeModules = path.join(mainReal, 'node_modules');
  const destNodeModules = path.join(destReal, 'node_modules');
  if (fs.existsSync(srcNodeModules) && !fs.lstatSync(destNodeModules, { throwIfNoEntry: false })) {
    try {
      fs.symlinkSync(srcNodeModules, destNodeModules);
    } catch {}
  }

  invalidateWorktreeListCache(mainReal);
  invalidateOverviewGitCache(destReal);

  if (SAFE_CID_RE.test(String(cid || '').trim())) {
    await setConversationWorktreeBindingAsync(mainReal, cid, destReal, { convWtDir });
  }

  return {
    ok: true,
    worktreePath: destReal,
    branch: fullBranch,
    baseBranch: targetBase,
    mainDirPath: mainReal,
  };
}

export async function removeRepoWorktreeAsync(
  projectDir,
  {
    worktreePath = '',
    deleteBranch = false,
    forceActive = false,
    allowUnregistered = false,
    authorizedDirs = null,
    nativeProjectsDir = NATIVE_PROJECTS_DIR,
    convWtDir = CONV_WORKTREES_DIR,
  } = {}
) {
  const absProj = resolveLocalProjectDir(projectDir);
  if (!absProj) return { ok: false, error: 'invalid_project_dir' };
  if (!allowUnregistered && !isAuthorizedProjectDir(absProj, { authorizedDirs, nativeProjectsDir })) {
    return { ok: false, error: 'unregistered_project_dir' };
  }

  const rawTarget = String(worktreePath || '').trim();
  if (!rawTarget) return { ok: false, error: 'missing_worktree_path' };

  const listRes = await listRepoWorktreesAsync(absProj, { force: true, convWtDir });
  const mainEntry = listRes.worktrees.find((w) => w.isMain) || null;
  if (!mainEntry) return { ok: false, error: 'not_git_repo' };
  const mainReal = getRealPathPreserveCase(mainEntry.realPath);

  const targetNorm = normalizeRealPath(rawTarget);
  const entry = listRes.worktrees.find(
    (w) => normalizeRealPath(w.realPath) === targetNorm || normalizeRealPath(w.path) === targetNorm
  );
  if (!entry) return { ok: false, error: 'worktree_not_found' };
  if (entry.isMain) return { ok: false, error: 'cannot_remove_main_worktree' };
  if (entry.locked) return { ok: false, error: 'worktree_locked' };
  if (entry.prunable) return { ok: false, error: 'worktree_prunable' };

  if (!forceActive && Array.isArray(entry.boundCids)) {
    const now = Date.now();
    const activeBound = entry.boundCids.some((b) => b.updatedAt > 0 && now - b.updatedAt <= ACTIVE_CID_TTL_MS);
    if (activeBound) {
      return { ok: false, error: 'worktree_active_in_conversation' };
    }
  }

  // Ensure /node_modules is excluded before plain `git worktree remove` (no --force)
  await ensureNodeModulesExcludedAsync(mainReal);

  const rmRes = await execGitWithStatusAsync(mainReal, ['worktree', 'remove', '--', entry.realPath], 8000);
  if (!rmRes.ok) {
    return { ok: false, error: 'git_worktree_remove_failed', detail: rmRes.stderr.trim() || 'worktree may be dirty' };
  }

  let branchDeleted = false;
  let branchWarning = '';
  if (deleteBranch && entry.branch && entry.branch !== 'main' && entry.branch !== 'master') {
    const brRes = await execGitWithStatusAsync(mainReal, ['branch', '-d', '--', entry.branch], 4000);
    if (brRes.ok) {
      branchDeleted = true;
    } else {
      branchWarning = brRes.stderr.trim() || 'branch not fully merged';
    }
  }

  // Clean up any manual pins pointing to the removed worktree
  try {
    const pinsFile = getPinsFilePath(convWtDir);
    const pinsDoc = readJsonOrFallback(pinsFile, null);
    if (pinsDoc && typeof pinsDoc.pins === 'object' && pinsDoc.pins) {
      let changed = false;
      const nextPins = { ...pinsDoc.pins };
      for (const [cidKey, pin] of Object.entries(nextPins)) {
        if (pin && pin.worktreePath && normalizeRealPath(pin.worktreePath) === normalizeRealPath(entry.realPath)) {
          delete nextPins[cidKey];
          changed = true;
        }
      }
      if (changed) {
        writeAtomicUtf8(pinsFile, `${JSON.stringify({ schema: 1, pins: nextPins }, null, 2)}\n`);
      }
    }
  } catch {}

  invalidateWorktreeListCache(mainReal);
  invalidateOverviewGitCache(entry.realPath);

  return {
    ok: true,
    removedPath: entry.realPath,
    branch: entry.branch,
    branchDeleted,
    ...(branchWarning ? { branchWarning } : {}),
  };
}

export async function collectAuthorizedWorktreeRootsAsync(extraProjectDir = '', opts = {}) {
  const roots = new Set();
  const dirs = getAuthorizedProjectDirs(opts);
  if (extraProjectDir && isAuthorizedProjectDir(extraProjectDir, opts)) {
    dirs.push(extraProjectDir);
  }
  for (const d of dirs) {
    const listRes = await listRepoWorktreesAsync(d, { includeStats: false, convWtDir: opts.convWtDir });
    if (!listRes.ok) continue;
    for (const wt of listRes.worktrees) {
      if (wt.realPath && !wt.prunable) roots.add(wt.realPath);
    }
  }
  return Array.from(roots);
}

export async function isAuthorizedWorktreePathAsync(candidateDir, opts = {}) {
  if (!candidateDir) return false;
  const candNorm = normalizeRealPath(candidateDir);
  const roots = await collectAuthorizedWorktreeRootsAsync('', opts);
  return roots.some((r) => normalizeRealPath(r) === candNorm);
}

export async function handleWorktreeRpc(action, payload = {}, opts = {}) {
  if (action === 'listRepoWorktrees') {
    return listRepoWorktreesAsync(payload?.dirPath, {
      force: Boolean(payload?.force),
      includeStats: Boolean(payload?.includeStats),
      activeWorktreePath: typeof payload?.activeWorktreePath === 'string' ? payload.activeWorktreePath : '',
      convWtDir: opts.convWtDir || CONV_WORKTREES_DIR,
    });
  }
  if (action === 'getConvWorktreeMap') {
    return loadConversationWorktreeMap({ convWtDir: opts.convWtDir || CONV_WORKTREES_DIR });
  }
  if (action === 'bindConversationWorktree') {
    return setConversationWorktreeBindingAsync(payload?.dirPath, payload?.cid, payload?.worktreePath || '', {
      convWtDir: opts.convWtDir || CONV_WORKTREES_DIR,
    });
  }
  if (action === 'createRepoWorktree') {
    return createRepoWorktreeAsync(payload?.dirPath, {
      type: payload?.type,
      slug: payload?.slug,
      branch: payload?.branch,
      baseBranch: payload?.baseBranch,
      cid: payload?.cid,
      allowUnregistered: false,
      authorizedDirs: opts.authorizedDirs || null,
      nativeProjectsDir: opts.nativeProjectsDir || NATIVE_PROJECTS_DIR,
      convWtDir: opts.convWtDir || CONV_WORKTREES_DIR,
    });
  }
  if (action === 'removeRepoWorktree') {
    return removeRepoWorktreeAsync(payload?.dirPath, {
      worktreePath: payload?.worktreePath,
      deleteBranch: Boolean(payload?.deleteBranch),
      forceActive: false,
      allowUnregistered: false,
      authorizedDirs: opts.authorizedDirs || null,
      nativeProjectsDir: opts.nativeProjectsDir || NATIVE_PROJECTS_DIR,
      convWtDir: opts.convWtDir || CONV_WORKTREES_DIR,
    });
  }
  return null;
}
