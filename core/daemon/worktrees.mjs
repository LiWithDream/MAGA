/**
 * Hardened Git Worktree Discovery, Per-Conversation Pinning & Lifecycle Service.
 * Delegates pure Git worktree operations to `../../studio/plugin/maga-git-workflow/lib/worktree-core.mjs`
 * while managing daemon authorization, caches, stats gating, and per-conversation bindings.
 */
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
import {
  ACTIVE_CID_TTL_MS,
  ALLOWED_WORKTREE_TYPES,
  SAFE_CID_RE,
  SAFE_SLUG_RE,
  createRepoWorktreeCore,
  execGitAsyncWithRaw,
  getProtectedBranchesForRepo,
  getRealPathPreserveCase,
  normalizeRealPath,
  parseWorktreeListPorcelainZ,
  removeRepoWorktreeCore,
  resolveCommonGitDirAsync,
} from '../../studio/plugin/maga-git-workflow/lib/worktree-core.mjs';

export const CONV_WORKTREES_DIR = path.join(STATE_DIR, 'conv-worktrees');
export const PINS_FILE_NAME = 'pins.json';
export {
  ALLOWED_WORKTREE_TYPES,
  SAFE_CID_RE,
  SAFE_SLUG_RE,
  getRealPathPreserveCase,
  normalizeRealPath,
  parseWorktreeListPorcelainZ,
};

const MAX_HOOK_FILES = 64;
const WORKTREE_CACHE_TTL_MS = 5000;
const STATS_CONCURRENCY = 3;

const worktreeListCache = new Map();
const worktreeListInFlight = new Map();
const worktreeAheadCache = new Map();

function getPinsFilePath(convWtDir = CONV_WORKTREES_DIR) {
  return path.join(convWtDir, PINS_FILE_NAME);
}

export function extractNativeProjectFolderUris(record) {
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
    const [out, gitCtx] = await Promise.all([
      execGitAsync(absDir, ['worktree', 'list', '--porcelain', '-z'], 1500),
      resolveCommonGitDirAsync(absDir),
    ]);
    if (out !== null) {
      const prot = getProtectedBranchesForRepo(gitCtx?.commonDir || '');
      entries = parseWorktreeListPorcelainZ(out, prot);
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

export async function createRepoWorktreeAsync(
  projectDir,
  {
    type = 'feat',
    slug = '',
    branch = '',
    baseBranch = '',
    cid = '',
    allowGenericBranch = false,
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

  const created = await createRepoWorktreeCore(mainEntry, {
    type,
    slug,
    branch,
    baseBranch,
    allowGenericBranch,
  });
  if (!created.ok) return created;

  invalidateWorktreeListCache(mainReal);
  invalidateOverviewGitCache(created.worktreePath);

  if (SAFE_CID_RE.test(String(cid || '').trim())) {
    await setConversationWorktreeBindingAsync(mainReal, cid, created.worktreePath, { convWtDir });
  }

  return created;
}

export async function removeRepoWorktreeAsync(
  projectDir,
  {
    worktreePath = '',
    deleteBranch = false,
    forceActive = false,
    callerCid = '',
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

  const removed = await removeRepoWorktreeCore(mainEntry, listRes.worktrees, {
    worktreePath,
    deleteBranch,
    forceActive,
    callerCid,
    baseBranch: listRes.baseBranch || '',
  });
  if (!removed.ok) return removed;

  // Clean up any manual pins pointing to the removed worktree
  try {
    const pinsFile = getPinsFilePath(convWtDir);
    const pinsDoc = readJsonOrFallback(pinsFile, null);
    if (pinsDoc && typeof pinsDoc.pins === 'object' && pinsDoc.pins) {
      let changed = false;
      const nextPins = { ...pinsDoc.pins };
      for (const [cidKey, pin] of Object.entries(nextPins)) {
        if (pin && pin.worktreePath && normalizeRealPath(pin.worktreePath) === normalizeRealPath(removed.removedPath)) {
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
  invalidateOverviewGitCache(removed.removedPath);

  return removed;
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
      callerCid: payload?.cid || '',
      allowUnregistered: false,
      authorizedDirs: opts.authorizedDirs || null,
      nativeProjectsDir: opts.nativeProjectsDir || NATIVE_PROJECTS_DIR,
      convWtDir: opts.convWtDir || CONV_WORKTREES_DIR,
    });
  }
  return null;
}
