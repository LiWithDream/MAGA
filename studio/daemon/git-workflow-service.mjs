/**
 * Daemon-side Git Workflow Service (`maga-git-workflow`):
 * - Atomically manages `~/.gemini/antigravity/anti-claude/git-workflow-policy.json` keyed by normalized `realpath(git-common-dir)`
 * - Surfaces recent deny telemetry from `git-workflow-events.json` & detects stale deleted repo keys
 * - Idempotently syncs/removes the native `maga-git-workflow` plugin with pinned Node executable
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  GIT_WORKFLOW_EVENTS_FILE,
  GIT_WORKFLOW_POLICY_FILE,
  NATIVE_PROJECTS_DIR,
  readJsonOrFallback,
  writeAtomicUtf8,
} from '../../core/daemon/env.mjs';
import {
  buildPinnedHooksJsonForPlugin,
  extractPluginHookNodeBin,
  isPluginInstalled,
  syncManagedPlugin,
  verifyPluginHookNodeRuntime,
} from './plugin-sync.mjs';
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
  withFileLock,
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
const REQUIRED_PLUGIN_FILES = [
  'plugin.json',
  'hooks.json',
  'hooks/git-guard.mjs',
  'lib/worktree-core.mjs',
  'bin/wt.mjs',
];
const EXECUTABLE_PLUGIN_FILES = new Set(['hooks/git-guard.mjs', 'bin/wt.mjs']);
const LOCK_STALE_MS = 5000;

export const GIT_WORKFLOW_ACTIONS = new Set([
  'getGitWorkflowPolicy',
  'setGitWorkflowPolicy',
  'syncGitWorkflowPlugin',
]);

function withPolicyLock(policyFile, fn, { maxWaitMs = 400 } = {}) {
  return withFileLock(policyFile, fn, {
    maxWaitMs,
    staleMs: LOCK_STALE_MS,
    busyError: 'policy_locked',
  });
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
  return isPluginInstalled(PLUGIN_NAME, REQUIRED_PLUGIN_FILES, opts);
}

export function buildPinnedGitWorkflowHooksJson(rawText, nodeBin = process.execPath) {
  return buildPinnedHooksJsonForPlugin(PLUGIN_NAME, rawText, nodeBin);
}

export function extractGitWorkflowHookNodeBin(hooksObj) {
  return extractPluginHookNodeBin(PLUGIN_NAME, hooksObj);
}

export function verifyGitWorkflowHookNodeRuntime(opts = {}) {
  return verifyPluginHookNodeRuntime(PLUGIN_NAME, {}, opts);
}

export function syncGitWorkflowPlugin({ remove = false } = {}, opts = {}) {
  return syncManagedPlugin(
    {
      pluginName: PLUGIN_NAME,
      pluginFiles: PLUGIN_FILES,
      requiredFiles: REQUIRED_PLUGIN_FILES,
      executableFiles: EXECUTABLE_PLUGIN_FILES,
      remove,
    },
    opts
  );
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
  const maxWaitMs = opts.lockMaxWaitMs ?? opts.maxWaitMs ?? 400;
  return withPolicyLock(
    policyFile,
    () => {
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
    },
    { maxWaitMs }
  );
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
    guardActive: Boolean(pluginInstalled && hookNode?.ok && hookNode?.pinned !== false),
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

  const lockRes = saveGitWorkflowPolicyMutation((draft) => {
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

  if (!lockRes?.ok) {
    return {
      ok: false,
      error: lockRes?.error || 'policy_locked',
      retryable: lockRes?.retryable !== false,
    };
  }

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
