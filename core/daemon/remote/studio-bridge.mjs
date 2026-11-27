/**
 * AGY Studio v1.3 Remote Bridge Helpers:
 * - Interrupted-Task Resume detection & cooldown suppression
 * - Sanitized Studio Overview aggregator (Projects, Worktrees, Quota, Today Usage, Opus Gate & Auto-Compact)
 * - Safe Opus Gate proposal dismissal
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, NATIVE_PROJECTS_DIR, STUDIO_PREFS_FILE, UUID_RE, readJsonOrFallback } from '../env.mjs';
import { DEFAULT_STUDIO_PREFS, sanitizeStudioPrefs } from '../../../studio/shared/prefs-schema.mjs';
import { parseConversationMetrics } from '../metrics-db.mjs';
import {
  extractNativeProjectFolderUris,
  getAuthorizedProjectDirs,
  listRepoWorktreesAsync,
  loadConversationWorktreeMap,
  normalizeRealPath,
} from '../worktrees.mjs';
import { collectResumeState } from '../../../studio/daemon/resume-detector.mjs';
import {
  dismissOpusGateProposal,
  getOpusGateStatus,
  loadQuotaState,
} from '../../../studio/daemon/opus-gate-service.mjs';
import { getAutoCompactStatus } from '../../../studio/daemon/auto-compact-service.mjs';
import { getAnchorsStatus } from '../../../studio/daemon/anchors-service.mjs';
import { collectUsageStatsAsync } from '../../../studio/daemon/usage-service.mjs';
import { isCascadeWriteActiveOrRecent } from './cascade-lock.mjs';

export const SILENT_RESUME_SENTINEL = '\u2063\u200B\u2063';
export const SILENT_RESUME_PROMPT =
  `${SILENT_RESUME_SENTINEL}Please resume from where the task was interrupted — ` +
  'quickly verify the current state and continue the remaining steps.';

const MAX_OVERVIEW_PROJECTS = 12;
const PROPOSAL_ID_RE = /^[A-Za-z0-9._:-]{4,128}$/;

function formatShortPath(absPath) {
  const s = String(absPath || '').trim();
  if (!s) return '';
  const home = os.homedir();
  if (home && (s === home || s.startsWith(`${home}${path.sep}`))) {
    return s === home ? '~' : `~${s.slice(home.length)}`;
  }
  return s;
}

function decodeFolderPath(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^file:\/\//i.test(s)) {
    try {
      let p = decodeURIComponent(new URL(s).pathname);
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return p;
    } catch {
      return '';
    }
  }
  return s;
}

function readNativeProjectMetaMap(nativeProjectsDir = NATIVE_PROJECTS_DIR) {
  const map = new Map();
  try {
    const entries = fs.readdirSync(nativeProjectsDir, { withFileTypes: true });
    for (const ent of entries) {
      if ((!ent.isFile() && !ent.isSymbolicLink()) || !ent.name.endsWith('.json')) continue;
      const rec = readJsonOrFallback(path.join(nativeProjectsDir, ent.name), null);
      if (!rec || typeof rec !== 'object') continue;
      const id = String(rec.id || ent.name.slice(0, -'.json'.length)).trim();
      const name = String(rec.name || rec.title || '').trim();
      const folders = extractNativeProjectFolderUris(rec);
      for (const rawFolder of folders) {
        const fsPath = decodeFolderPath(rawFolder);
        if (!fsPath) continue;
        const norm = normalizeRealPath(fsPath);
        if (!map.has(norm)) {
          map.set(norm, { id, name: name || path.basename(fsPath) || id });
        }
      }
    }
  } catch {}
  return map;
}

function formatLocalDay(tsMs = Date.now()) {
  const d = new Date(tsMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function getRemoteResumeState(
  cascadeId,
  { liveBusy = false, liveWaiting = false, conversationsDir, now } = {}
) {
  const cid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
  if (!UUID_RE.test(cid)) {
    return { ok: false, error: 'invalid_cascade_id', interrupted: false };
  }
  if (liveBusy || liveWaiting || isCascadeWriteActiveOrRecent(cid, now ? { now } : undefined)) {
    return {
      ok: true,
      cascadeId: cid,
      interrupted: false,
      active: true,
      reason: liveWaiting ? 'waiting_user' : liveBusy ? 'running' : 'remote_write_active',
      lastIdx: -1,
    };
  }
  const res = collectResumeState(
    { cascadeId: cid, force: false },
    conversationsDir ? { conversationsDir } : undefined
  );
  return {
    ok: Boolean(res?.ok),
    cascadeId: cid,
    interrupted: Boolean(res?.interrupted),
    reason: String(res?.reason || 'done'),
    lastIdx: Number.isInteger(res?.lastIdx) ? res.lastIdx : -1,
    active: Boolean(res?.active),
    ...(res?.error ? { error: String(res.error) } : {}),
  };
}

function sanitizeQuotaSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pickPool = (pool, includeResets = false) => {
    const src = pool && typeof pool === 'object' ? pool : {};
    return {
      fiveHourRemainingPct:
        typeof src.fiveHourRemainingPct === 'number' && Number.isFinite(src.fiveHourRemainingPct)
          ? src.fiveHourRemainingPct
          : null,
      weeklyRemainingPct:
        typeof src.weeklyRemainingPct === 'number' && Number.isFinite(src.weeklyRemainingPct)
          ? src.weeklyRemainingPct
          : null,
      ...(includeResets
        ? {
            fiveHourResetSec:
              typeof src.fiveHourResetSec === 'number' && Number.isFinite(src.fiveHourResetSec)
                ? src.fiveHourResetSec
                : null,
            weeklyResetSec:
              typeof src.weeklyResetSec === 'number' && Number.isFinite(src.weeklyResetSec)
                ? src.weeklyResetSec
                : null,
          }
        : {}),
    };
  };
  return {
    tierName: typeof raw.tierName === 'string' ? raw.tierName.slice(0, 64) : '',
    updatedAt: Number(raw.updatedAt || 0),
    claude: pickPool(raw.claude, true),
    gemini: pickPool(raw.gemini, true),
  };
}

export function readRemoteStudioPrefs(opts = {}) {
  const filePath = opts.studioPrefsFile || STUDIO_PREFS_FILE;
  const raw = readJsonOrFallback(filePath, null);
  const p =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? sanitizeStudioPrefs(raw)
      : sanitizeStudioPrefs({ ...DEFAULT_STUDIO_PREFS });
  return {
    customizeModelList: Boolean(p.customizeModelList),
    hiddenModels: Array.isArray(p.hiddenModels) ? p.hiddenModels.slice(0, 64) : [],
    defaultTierByFamily:
      p.defaultTierByFamily && typeof p.defaultTierByFamily === 'object' ? { ...p.defaultTierByFamily } : {},
    showModelDots: p.showModelDots !== false,
    hideModelTags: p.hideModelTags !== false,
    hideDefaultEffort: Boolean(p.hideDefaultEffort),
    showEffortBar: p.showEffortBar !== false,
    effortTheme: p.effortTheme || 'auto',
    geminiTheme: p.geminiTheme || 'physical',
    claudeTheme: p.claudeTheme || 'matrix',
    codexTheme: p.codexTheme || 'nebula',
    orchestratorMode: p.orchestratorMode || 'dock',
    orchestratorIcon: p.orchestratorIcon || 'prism',
    hideThinkingProse: p.hideThinkingProse !== false,
  };
}

export async function collectStudioOverview(params = {}, opts = {}) {
  const rawCid = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  const cascadeId = rawCid && UUID_RE.test(rawCid) ? rawCid : '';
  const nativeProjectsDir = opts.nativeProjectsDir || NATIVE_PROJECTS_DIR;
  const authorizedDirs = Array.isArray(opts.authorizedDirs)
    ? opts.authorizedDirs
    : getAuthorizedProjectDirs({ nativeProjectsDir });

  const nativeMetaByNorm = readNativeProjectMetaMap(nativeProjectsDir);
  const targetDirs = authorizedDirs.slice(0, MAX_OVERVIEW_PROJECTS);
  const convMapOpts = opts.convWtDir ? { convWtDir: opts.convWtDir } : undefined;
  const convWtMap = loadConversationWorktreeMap(convMapOpts);

  const listWtFn = opts.listRepoWorktreesAsync || listRepoWorktreesAsync;
  const collectUsageFn = opts.collectUsageStatsAsync || collectUsageStatsAsync;
  const wtPromise = Promise.allSettled(
    targetDirs.map(async (dirPath) => {
      const wtRes = await listWtFn(dirPath, {
        includeStats: false,
        ...(opts.convWtDir ? { convWtDir: opts.convWtDir } : {}),
      });
      return { dirPath, wtRes };
    })
  );
  const usagePromise = Promise.resolve()
    .then(() => collectUsageFn({ force: false }))
    .catch(() => null);
  const [wtResults, usageRes] = await Promise.all([wtPromise, usagePromise]);

  const repoMetaByNorm = new Map();
  const scannedRepoNorms = new Set();
  const liveWorktreeByNorm = new Map();
  const projects = [];
  for (let i = 0; i < wtResults.length; i++) {
    const dirPath = targetDirs[i];
    const normDir = normalizeRealPath(dirPath);
    const meta = nativeMetaByNorm.get(normDir) || null;
    const fallbackId = `proj-${crypto
      .createHash('sha256')
      .update(normDir || String(dirPath || ''), 'utf8')
      .digest('hex')
      .slice(0, 12)}`;
    const projId = meta?.id || fallbackId;
    const projName = meta?.name || path.basename(dirPath) || 'Project';
    repoMetaByNorm.set(normDir, { id: projId, name: projName });

    const settled = wtResults[i];
    const wtRes = settled.status === 'fulfilled' ? settled.value?.wtRes : null;
    const rawList = Array.isArray(wtRes?.worktrees) ? wtRes.worktrees : [];
    const worktrees = rawList
      .filter((w) => w && !w.bare && !w.prunable)
      .slice(0, 16)
      .map((w) => {
        const wtReal = String(w.realPath || w.path || '');
        const wtNorm = wtReal ? normalizeRealPath(wtReal) : '';
        const wtBranch = String(w.branch || (w.detached ? 'detached' : ''));
        const wtName = w.isMain ? 'main' : path.basename(wtReal) || 'worktree';
        if (wtNorm) {
          liveWorktreeByNorm.set(wtNorm, { branch: wtBranch, name: wtName, isMain: Boolean(w.isMain) });
        }
        return {
          name: wtName,
          branch: wtBranch,
          isMain: Boolean(w.isMain),
          shortPath: formatShortPath(wtReal),
        };
      });
    if (wtRes?.ok && worktrees.length > 0 && normDir) {
      scannedRepoNorms.add(normDir);
    }

    projects.push({
      id: projId,
      name: projName,
      shortPath: formatShortPath(dirPath),
      isGitRepo: Boolean(wtRes?.ok && worktrees.length > 0),
      worktreeCount: worktrees.length,
      worktrees,
    });
  }

  const worktreeByCid = {};
  for (const [cid, rec] of Object.entries(convWtMap.entries || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const wtPath = String(rec.worktreePath || '');
    const wtNorm = wtPath ? normalizeRealPath(wtPath) : '';
    const repoNorm = rec.repoRoot ? normalizeRealPath(rec.repoRoot) : '';
    const repoMeta = repoNorm ? repoMetaByNorm.get(repoNorm) : null;
    const repoScanned = Boolean(repoNorm && scannedRepoNorms.has(repoNorm));
    const liveWt = wtNorm ? liveWorktreeByNorm.get(wtNorm) : null;
    // If repo was scanned and the bound worktree no longer exists (e.g. cleaned via wt:clean),
    // keep project association but clear the stale branch badge.
    const branch = repoScanned ? (liveWt ? liveWt.branch : '') : String(rec.branch || '');
    const worktreeName = repoScanned ? (liveWt ? liveWt.name : '') : wtPath ? path.basename(wtPath) : '';
    worktreeByCid[cid] = {
      branch,
      worktreeName,
      repoName: repoMeta?.name || (rec.repoRoot ? path.basename(rec.repoRoot) : ''),
      projectId: repoMeta?.id || '',
    };
  }

  const quotaRaw = (opts.loadQuotaState || loadQuotaState)(opts.quotaOpts);
  const quota = sanitizeQuotaSnapshot(quotaRaw);

  const nowMs = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const todayStr = formatLocalDay(nowMs);
  let todayUsage = { date: todayStr, requests: 0, totalTokens: 0, uncached: 0, cacheRead: 0, output: 0 };
  const days = Array.isArray(usageRes?.days) ? usageRes.days : [];
  const todayBucket = days.find((d) => d?.date === todayStr);
  if (todayBucket) {
    const uncached = Number(todayBucket.uncached || 0);
    const cacheRead = Number(todayBucket.cacheRead || 0);
    const cacheWrite = Number(todayBucket.cacheWrite || 0);
    const output = Number(todayBucket.output || 0);
    todayUsage = {
      date: todayStr,
      requests: Number(todayBucket.requests || 0),
      totalTokens: uncached + cacheRead + cacheWrite + output,
      uncached,
      cacheRead,
      output,
    };
  }
  const usageDays = days.slice(-30).map((d) => {
    const uncached = Number(d?.uncached || 0);
    const cacheRead = Number(d?.cacheRead || 0);
    const cacheWrite = Number(d?.cacheWrite || 0);
    const output = Number(d?.output || 0);
    return {
      date: String(d?.date || ''),
      requests: Number(d?.requests || 0),
      totalTokens: uncached + cacheRead + cacheWrite + output,
      uncached,
      cacheRead,
      output,
    };
  });

  let activeCascade;
  if (cascadeId) {
    const opusRaw = (opts.getOpusGateStatus || getOpusGateStatus)({ cascadeId }, opts.opusOpts);
    const rawProp = opusRaw?.proposal && typeof opusRaw.proposal === 'object' ? opusRaw.proposal : null;
    const propId = rawProp
      ? String(rawProp.id || rawProp.diffHash || (rawProp.ts ? `ts-${rawProp.ts}` : 'active'))
      : '';
    const opusGate = {
      enabled: Boolean(opusRaw?.pluginInstalled),
      proposal: rawProp
        ? {
            id: propId,
            diffHash: String(rawProp.diffHash || ''),
            ts: Number(rawProp.ts || 0),
            kind: String(rawProp.kind || ''),
            reason: String(rawProp.reason || '').slice(0, 280),
            summary: String(rawProp.summary || rawProp.reason || '').slice(0, 280),
            trigger: String(rawProp.trigger || rawProp.kind || ''),
            recommendedTier: String(rawProp.recommendedTier || ''),
            createdAt: Number(rawProp.createdAt || rawProp.ts || 0),
          }
        : null,
    };

    const acRaw = (opts.getAutoCompactStatus || getAutoCompactStatus)({ cascadeId }, opts.compactOpts);
    const rawReq = acRaw?.request && typeof acRaw.request === 'object' ? acRaw.request : null;
    const autoCompact = {
      enabled: Boolean(acRaw?.pluginInstalled),
      pending: rawReq
        ? {
            requestId: String(rawReq.id || rawReq.requestId || ''),
            reason: String(rawReq.reason || '').slice(0, 120),
            ctxPct: Number(rawReq.ctxPct || 0),
            createdAt: Number(rawReq.ts || 0),
          }
        : null,
    };

    const ancRaw = (opts.getAnchorsStatus || getAnchorsStatus)(
      { cascadeId },
      { ...(opts.anchorOpts || {}), stripThinking: true }
    );
    const anchors = {
      enabled: Boolean(ancRaw?.pluginInstalled),
      compactionCount: Number(ancRaw?.compactionCount || 0),
      handoffRecommended: Boolean(ancRaw?.handoffRecommended),
      pendingCount: Array.isArray(ancRaw?.proposals) ? ancRaw.proposals.length : 0,
      proposals: Array.isArray(ancRaw?.proposals)
        ? ancRaw.proposals.map((p) => ({
            id: String(p.id || ''),
            verbatimQuote: String(p.verbatimQuote || '').slice(0, 280),
            stepIndex: Number(p.stepIndex || 0),
            ts: Number(p.ts || 0),
          }))
        : [],
      tokenBudget: ancRaw?.tokenBudget || { usedTokens: 0, maxTokens: 400 },
    };

    let metrics = null;
    try {
      const convDir = opts.conversationsDir || path.join(HOME, '.gemini', 'antigravity', 'conversations');
      const mRes = (opts.parseConversationMetrics || parseConversationMetrics)(cascadeId, convDir);
      if (mRes?.hasData && mRes.metrics) {
        const m = mRes.metrics;
        metrics = {
          ctxPct: Number(m.ctxPct || 0),
          ctxRatioStr: String(m.ctxRatioStr || ''),
          ctx: Number(m.ctx || 0),
          ctxLimit: Number(m.ctxLimit || 0),
          ctxLimitStr: String(m.ctxLimitStr || ''),
          ctxClass: String(m.ctxClass || 'ag-ctx-ok'),
          displayTps: Number(m.displayTps || 0),
          useStream: Boolean(m.useStream),
          ttft: Number(m.ttft || 0),
          totDur: Number(m.totDur || 0),
          outTok: Number(m.outTok || 0),
          lastCacheRate: Number(m.lastCacheRate || 0),
          sessionCacheRate: Number(m.sessionCacheRate || 0),
          turns: Number(mRes.stats?.turns || 0),
          calls: Number(mRes.stats?.calls || 0),
        };
      }
    } catch {}

    activeCascade = {
      cascadeId,
      opusGate,
      autoCompact,
      anchors,
      ...(metrics ? { metrics } : {}),
    };
  }

  return {
    ok: true,
    generatedAt: nowMs,
    projects,
    worktreeByCid,
    quota,
    todayUsage,
    usageDays,
    studioPrefs: readRemoteStudioPrefs(opts),
    ...(activeCascade ? { activeCascade } : {}),
  };
}

export function handleRemoteOpusDismiss(params = {}, opts = {}) {
  const cascadeId = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  const proposalId = typeof params?.proposalId === 'string' ? params.proposalId.trim() : '';
  if (!PROPOSAL_ID_RE.test(proposalId)) {
    throw Object.assign(new Error('invalid_proposal_id'), { code: 'invalid_proposal_id' });
  }

  let diffHash = '';
  let ts = Number(params?.ts || 0);
  if (proposalId === 'active') {
    diffHash = '';
    ts = 0;
  } else if (proposalId.startsWith('ts-') && /^\d+$/.test(proposalId.slice(3))) {
    ts = Number(proposalId.slice(3));
    diffHash = '';
  } else {
    diffHash = proposalId;
  }

  const res = (opts.dismissOpusGateProposal || dismissOpusGateProposal)(
    { cascadeId, diffHash, ...(ts > 0 ? { ts } : {}), strictCas: true },
    opts.opusOpts
  );
  if (!res?.ok) {
    const code = String(res?.error || 'dismiss_failed');
    throw Object.assign(new Error(code), { code });
  }
  return {
    ok: true,
    cascadeId,
    proposalId,
    matched: Boolean(res.matched),
  };
}
