/**
 * Daemon-side Git Workflow Service (`maga-git-workflow`):
 * - Atomically manages `~/.gemini/antigravity/anti-claude/git-workflow-policy.json` keyed by normalized `realpath(git-common-dir)`
 * - Surfaces recent deny telemetry from `git-workflow-events.json` & detects stale deleted repo keys
 * - Idempotently syncs/removes the native `maga-git-workflow` plugin with pinned Node executable
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  GIT_WORKFLOW_EVENTS_FILE,
  GIT_WORKFLOW_POLICY_FILE,
  GLOBAL_PLUGINS_DIR,
  NATIVE_PROJECTS_DIR,
  REPO_ROOT,
  readJsonOrFallback,
  writeAtomicUtf8,
} from '../../core/daemon/env.mjs';
import { resolveLocalProjectDir } from '../../core/daemon/projects.mjs';
import { getAuthorizedProjectDirs, isAuthorizedProjectDir } from '../../core/daemon/worktrees.mjs';
import {
  VALID_WORKFLOW_MODES,
  hasValidLocalGuardrail,
  readWorkflowPolicy,
  resolveEffectiveProjectPolicy,
} from '../plugin/maga-git-workflow/hooks/git-guard.mjs';
import {
  normalizePolicyKey,
  resolveCommonGitDirAsync,
} from '../plugin/maga-git-workflow/lib/worktree-core.mjs';

const PLUGIN_NAME = 'maga-git-workflow';
const PLUGIN_FILES = [
  'plugin.json',
  'hooks.json',
  'rules/AGENTS.md',
  'skills/git-workflow/SKILL.md',
  'hooks/git-guard.mjs',
  'lib/worktree-core.mjs',
  'bin/wt.mjs',
];
const EXECUTABLE_PLUGIN_FILES = new Set(['hooks/git-guard.mjs', 'bin/wt.mjs']);
const LOCK_STALE_MS = 5000;
const SLEEP_BUF = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

export const GIT_WORKFLOW_ACTIONS = new Set([
  'getGitWorkflowPolicy',
  'setGitWorkflowPolicy',
  'syncGitWorkflowPlugin',
]);

function withPolicyLock(policyFile, fn, { maxWaitMs = 400 } = {}) {
  const lockPath = `${policyFile}.lock`;
  fs.mkdirSync(path.dirname(policyFile), { recursive: true });
  let acquired = false;
  const deadline = Date.now() + maxWaitMs;
  for (let attempt = 0; attempt < 40; attempt++) {
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
      if (err?.code !== 'EEXIST') break;
      try {
        const st = fs.statSync(lockPath, { throwIfNoEntry: false });
        if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) break;
      if (SLEEP_BUF) {
        try {
          Atomics.wait(SLEEP_BUF, 0, 0, 10);
        } catch {}
      }
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {}
    }
  }
}

function getPluginTargetDir(opts = {}) {
  return path.join(opts.pluginsDir || GLOBAL_PLUGINS_DIR, PLUGIN_NAME);
}

function getPolicyFilePath(opts = {}) {
  if (opts.policyFile) return opts.policyFile;
  if (opts.stateDir) return path.join(opts.stateDir, 'git-workflow-policy.json');
  return GIT_WORKFLOW_POLICY_FILE;
}

function getEventsFilePath(opts = {}) {
  if (opts.eventsFile) return opts.eventsFile;
  if (opts.stateDir) return path.join(opts.stateDir, 'git-workflow-events.json');
  return GIT_WORKFLOW_EVENTS_FILE;
}

export function isGitWorkflowPluginInstalled(opts = {}) {
  const targetDir = getPluginTargetDir(opts);
  return (
    fs.existsSync(path.join(targetDir, 'plugin.json')) &&
    fs.existsSync(path.join(targetDir, 'hooks.json')) &&
    fs.existsSync(path.join(targetDir, 'hooks', 'git-guard.mjs')) &&
    fs.existsSync(path.join(targetDir, 'lib', 'worktree-core.mjs')) &&
    fs.existsSync(path.join(targetDir, 'bin', 'wt.mjs'))
  );
}

function formatPinnedHookCommand(rawCmd, nodeBin) {
  const cmd = String(rawCmd || '').trim();
  const m = cmd.match(/^node\s+(.+)$/);
  if (!m || !nodeBin) return cmd;
  const quoted =
    process.platform === 'win32'
      ? `"${String(nodeBin).replace(/"/g, '\\"')}"`
      : `'${String(nodeBin).replace(/'/g, `'\\''`)}'`;
  return `${quoted} ${m[1]}`;
}

export function buildPinnedGitWorkflowHooksJson(rawText, nodeBin = process.execPath) {
  const parsed = JSON.parse(rawText);
  const root = parsed?.[PLUGIN_NAME];
  if (root && typeof root === 'object') {
    for (const handlers of Object.values(root)) {
      if (!Array.isArray(handlers)) continue;
      for (const h of handlers) {
        if (h && typeof h === 'object' && typeof h.command === 'string') {
          h.command = formatPinnedHookCommand(h.command, nodeBin);
        }
        if (Array.isArray(h?.hooks)) {
          for (const sub of h.hooks) {
            if (sub && typeof sub === 'object' && typeof sub.command === 'string') {
              sub.command = formatPinnedHookCommand(sub.command, nodeBin);
            }
          }
        }
      }
    }
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function extractGitWorkflowHookNodeBin(hooksObj) {
  const root = hooksObj?.[PLUGIN_NAME];
  const sessionCmd = Array.isArray(root?.SessionStart) ? String(root.SessionStart[0]?.command || '').trim() : '';
  const preHandlers = Array.isArray(root?.PreToolUse) ? root.PreToolUse : [];
  let preCmd = '';
  for (const h of preHandlers) {
    if (typeof h?.command === 'string' && h.command.trim()) {
      preCmd = h.command.trim();
      break;
    }
    if (Array.isArray(h?.hooks) && typeof h.hooks[0]?.command === 'string' && h.hooks[0].command.trim()) {
      preCmd = h.hooks[0].command.trim();
      break;
    }
  }
  const cmd = sessionCmd || preCmd;
  if (!cmd) return process.execPath;
  const sq = cmd.match(/^'((?:[^']|'\\'')+)'\s+/);
  if (sq) return sq[1].replace(/'\\''/g, "'");
  const dq = cmd.match(/^"([^"]+)"\s+/);
  if (dq) return dq[1];
  const bare = cmd.match(/^(\S+)\s+/);
  return bare ? bare[1] : process.execPath;
}

export function verifyGitWorkflowHookNodeRuntime(opts = {}) {
  const hooksFile = path.join(getPluginTargetDir(opts), 'hooks.json');
  const hooksObj = readJsonOrFallback(hooksFile, null);
  const nodeBin = hooksObj ? extractGitWorkflowHookNodeBin(hooksObj) : opts.nodeExecPath || process.execPath;
  try {
    if (!fs.existsSync(nodeBin) && nodeBin !== 'node') {
      return { ok: false, nodeBin, error: 'node_binary_missing' };
    }
    const ver = execFileSync(nodeBin, ['--version'], {
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, nodeBin, version: ver };
  } catch (err) {
    return {
      ok: false,
      nodeBin,
      error: String(err?.message || err).slice(0, 160),
    };
  }
}

export function syncGitWorkflowPlugin({ remove = false } = {}, opts = {}) {
  const srcDir = opts.pluginSrcDir || path.join(REPO_ROOT, 'studio', 'plugin', PLUGIN_NAME);
  const targetDir = getPluginTargetDir(opts);
  if (remove) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return { ok: true, action: 'removed', pluginDir: targetDir, installed: false };
  }
  if (!fs.existsSync(srcDir)) {
    return { ok: false, error: 'missing_plugin_source', srcDir };
  }
  const nodeBin = opts.nodeExecPath || process.execPath;
  const copied = [];
  for (const rel of PLUGIN_FILES) {
    const from = path.join(srcDir, rel);
    const to = path.join(targetDir, rel);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    let body = fs.readFileSync(from, 'utf8');
    if (rel === 'hooks.json') {
      try {
        body = buildPinnedGitWorkflowHooksJson(body, nodeBin);
      } catch {}
    }
    writeAtomicUtf8(to, body);
    if (EXECUTABLE_PLUGIN_FILES.has(rel)) {
      try {
        fs.chmodSync(to, 0o755);
      } catch {}
    }
    copied.push(rel);
  }
  return {
    ok: true,
    action: 'synced',
    pluginDir: targetDir,
    files: copied,
    nodeBin,
    installed: isGitWorkflowPluginInstalled(opts),
  };
}

export function loadGitWorkflowPolicy(opts = {}) {
  const policyFile = getPolicyFilePath(opts);
  return readWorkflowPolicy({ stateDir: path.dirname(policyFile) });
}

function normalizeProjectPolicyEntry(key, val) {
  if (!val || typeof val !== 'object') return null;
  if (!VALID_WORKFLOW_MODES.includes(val.mode)) return null;
  return {
    mode: val.mode,
    displayRoot: typeof val.displayRoot === 'string' ? val.displayRoot : '',
    commonDir: typeof val.commonDir === 'string' ? val.commonDir : key,
    ...(Array.isArray(val.protectedBranches) ? { protectedBranches: val.protectedBranches.filter(Boolean) } : {}),
    ...(typeof val.blockPushTags === 'boolean' ? { blockPushTags: val.blockPushTags } : {}),
    ...(Array.isArray(val.localOnlyPaths) ? { localOnlyPaths: val.localOnlyPaths.filter(Boolean) } : {}),
    updatedAt: Number(val.updatedAt) > 0 ? Number(val.updatedAt) : Date.now(),
  };
}

export function saveGitWorkflowPolicyMutation(mutator, opts = {}) {
  const policyFile = getPolicyFilePath(opts);
  return withPolicyLock(policyFile, () => {
    const current = loadGitWorkflowPolicy(opts);
    const cloned = {
      schema: 1,
      defaultMode: current.defaultMode,
      blockForcePushProtected: current.blockForcePushProtected,
      blockPushTags: current.blockPushTags,
      projects: { ...(current.projects || {}) },
    };
    const next = mutator(cloned) || cloned;
    const cleanProjects = {};
    for (const [k, v] of Object.entries(next.projects || {})) {
      const normalized = normalizeProjectPolicyEntry(k, v);
      if (normalized) cleanProjects[k] = normalized;
    }
    const finalDoc = {
      schema: 1,
      defaultMode: VALID_WORKFLOW_MODES.includes(next.defaultMode) ? next.defaultMode : 'observe',
      blockForcePushProtected: next.blockForcePushProtected !== false,
      blockPushTags: next.blockPushTags === true,
      projects: cleanProjects,
    };
    writeAtomicUtf8(policyFile, `${JSON.stringify(finalDoc, null, 2)}\n`);
    return finalDoc;
  });
}

export function findStalePolicyProjects(policy) {
  const stale = [];
  const projects = policy?.projects && typeof policy.projects === 'object' ? policy.projects : {};
  for (const [key, entry] of Object.entries(projects)) {
    const commonExists = Boolean(entry?.commonDir && fs.existsSync(entry.commonDir));
    const keyExists = Boolean(key && fs.existsSync(key));
    const rootExists = Boolean(entry?.displayRoot && fs.existsSync(entry.displayRoot));
    if (!commonExists && !keyExists && !rootExists) {
      stale.push({
        commonDirKey: key,
        displayRoot: entry?.displayRoot || key,
        mode: entry?.mode || 'observe',
      });
    }
  }
  return stale;
}

export function readRecentGuardEvents(opts = {}) {
  const eventsFile = getEventsFilePath(opts);
  const raw = readJsonOrFallback(eventsFile, null);
  const all = Array.isArray(raw?.events) ? raw.events : [];
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  let denyCount24h = 0;
  for (const ev of all) {
    if (Number(ev?.ts || 0) >= cutoff24h) denyCount24h += 1;
  }
  const recentEvents = all
    .slice(-10)
    .reverse()
    .map((ev) => ({
      ts: Number(ev.ts || 0),
      cid: String(ev.cid || ''),
      repo: String(ev.repo || ''),
      repoName: ev.repo ? path.basename(ev.repo) : '',
      mode: String(ev.mode || 'observe'),
      tool: String(ev.tool || ''),
      reason: String(ev.reason || ''),
    }));
  return { denyCount24h, totalStored: all.length, recentEvents };
}

export async function getProjectWorkflowPolicyBadgeAsync(dirPath, opts = {}) {
  const absDir = resolveLocalProjectDir(dirPath);
  if (!absDir) return null;
  const gitCtx = await resolveCommonGitDirAsync(absDir);
  if (!gitCtx) return null;
  const policy = loadGitWorkflowPolicy(opts);
  const localGuardrailActive = hasValidLocalGuardrail(gitCtx.mainRoot);
  if (localGuardrailActive) {
    return {
      mode: 'worktree-only',
      source: 'local-guardrail',
      localGuardrailActive: true,
      commonDirKey: gitCtx.commonDirKey,
      mainRoot: gitCtx.mainRoot,
    };
  }
  const eff = resolveEffectiveProjectPolicy(gitCtx, policy);
  return {
    mode: eff.mode,
    source: eff.source,
    localGuardrailActive: false,
    commonDirKey: gitCtx.commonDirKey,
    mainRoot: gitCtx.mainRoot,
  };
}

export async function getGitWorkflowStatus(payload = {}, opts = {}) {
  const policy = loadGitWorkflowPolicy(opts);
  const pluginInstalled = isGitWorkflowPluginInstalled(opts);
  const hookNode = verifyGitWorkflowHookNodeRuntime(opts);
  const eventsMeta = readRecentGuardEvents(opts);
  const staleProjects = findStalePolicyProjects(policy);

  const authorizedDirs = Array.isArray(opts.authorizedDirs)
    ? opts.authorizedDirs
    : getAuthorizedProjectDirs({ nativeProjectsDir: opts.nativeProjectsDir || NATIVE_PROJECTS_DIR });

  const seenKeys = new Set();
  const projectsSummary = [];
  for (const dir of authorizedDirs) {
    const gitCtx = await resolveCommonGitDirAsync(dir);
    if (!gitCtx || seenKeys.has(gitCtx.commonDirKey)) continue;
    seenKeys.add(gitCtx.commonDirKey);
    const localGuardrailActive = hasValidLocalGuardrail(gitCtx.mainRoot);
    const eff = resolveEffectiveProjectPolicy(gitCtx, policy);
    const overrideEntry = policy.projects?.[gitCtx.commonDirKey] || null;
    projectsSummary.push({
      id: gitCtx.commonDirKey,
      name: path.basename(gitCtx.mainRoot) || gitCtx.mainRoot,
      dirPath: gitCtx.mainRoot,
      commonDir: gitCtx.commonDir,
      mode: localGuardrailActive ? 'worktree-only' : eff.mode,
      source: localGuardrailActive ? 'local-guardrail' : eff.source,
      overrideMode: overrideEntry?.mode || '',
      localGuardrailActive,
      protectedBranches: Array.from(eff.protectedBranches),
    });
  }

  for (const [key, entry] of Object.entries(policy.projects || {})) {
    if (seenKeys.has(key)) continue;
    if (!entry?.commonDir && !entry?.displayRoot) continue;
    const isStale = staleProjects.some((s) => s.commonDirKey === key);
    if (isStale) continue;
    projectsSummary.push({
      id: key,
      name: path.basename(entry.displayRoot || key) || key,
      dirPath: entry.displayRoot || key,
      commonDir: entry.commonDir || key,
      mode: entry.mode,
      source: 'project',
      overrideMode: entry.mode,
      localGuardrailActive: false,
      protectedBranches: Array.isArray(entry.protectedBranches) ? entry.protectedBranches : ['main', 'master'],
    });
  }

  return {
    ok: true,
    pluginInstalled,
    hookNode,
    guardActive: Boolean(pluginInstalled && hookNode?.ok),
    policy,
    projectsSummary,
    staleProjects,
    recentEvents: eventsMeta.recentEvents,
    denyCount24h: eventsMeta.denyCount24h,
  };
}

export async function setGitWorkflowPolicy(payload = {}, opts = {}) {
  const updatesGlobal =
    typeof payload.defaultMode === 'string' ||
    typeof payload.blockForcePushProtected === 'boolean' ||
    typeof payload.blockPushTags === 'boolean' ||
    payload.pruneStale === true;

  let projectChange = null;
  if (typeof payload.dirPath === 'string' && payload.dirPath.trim()) {
    const absProj = resolveLocalProjectDir(payload.dirPath);
    if (!absProj) return { ok: false, error: 'invalid_project_dir' };
    if (
      !opts.allowUnregistered &&
      !isAuthorizedProjectDir(absProj, {
        authorizedDirs: opts.authorizedDirs || null,
        nativeProjectsDir: opts.nativeProjectsDir || NATIVE_PROJECTS_DIR,
      })
    ) {
      return { ok: false, error: 'unregistered_project_dir' };
    }
    const gitCtx = await resolveCommonGitDirAsync(absProj);
    if (!gitCtx) return { ok: false, error: 'not_git_repo' };
    const nextMode = String(payload.mode || '').trim();
    if (nextMode && nextMode !== 'default' && !VALID_WORKFLOW_MODES.includes(nextMode)) {
      return { ok: false, error: 'invalid_workflow_mode' };
    }
    projectChange = { gitCtx, nextMode };
  } else if (typeof payload.commonDirKey === 'string' && payload.commonDirKey.trim() && (payload.mode === 'default' || !payload.mode)) {
    projectChange = { deleteKey: payload.commonDirKey.trim() };
  } else if (!updatesGlobal) {
    return { ok: false, error: 'missing_policy_update' };
  }

  saveGitWorkflowPolicyMutation((draft) => {
    if (typeof payload.defaultMode === 'string' && VALID_WORKFLOW_MODES.includes(payload.defaultMode)) {
      draft.defaultMode = payload.defaultMode;
    }
    if (typeof payload.blockForcePushProtected === 'boolean') {
      draft.blockForcePushProtected = payload.blockForcePushProtected;
    }
    if (typeof payload.blockPushTags === 'boolean') {
      draft.blockPushTags = payload.blockPushTags;
    }
    if (payload.pruneStale === true) {
      for (const stale of findStalePolicyProjects(draft)) {
        delete draft.projects[stale.commonDirKey];
      }
    }
    if (projectChange?.deleteKey) {
      delete draft.projects[projectChange.deleteKey];
    } else if (projectChange?.gitCtx) {
      const { gitCtx, nextMode } = projectChange;
      if (!nextMode || nextMode === 'default') {
        delete draft.projects[gitCtx.commonDirKey];
        const normRoot = normalizePolicyKey(gitCtx.mainRoot);
        if (normRoot && normRoot !== gitCtx.commonDirKey) {
          delete draft.projects[normRoot];
        }
      } else {
        draft.projects[gitCtx.commonDirKey] = {
          mode: nextMode,
          displayRoot: gitCtx.mainRoot,
          commonDir: gitCtx.commonDir,
          updatedAt: Date.now(),
        };
      }
    }
    return draft;
  }, opts);

  return getGitWorkflowStatus(payload, opts);
}

export async function handleGitWorkflowRpc(action, payload = {}, opts = {}) {
  switch (action) {
    case 'getGitWorkflowPolicy':
      return getGitWorkflowStatus(payload, opts);
    case 'setGitWorkflowPolicy':
      return setGitWorkflowPolicy(payload, opts);
    case 'syncGitWorkflowPlugin':
      return syncGitWorkflowPlugin(payload, opts);
    default:
      return { ok: false, error: 'unknown_git_workflow_action' };
  }
}
