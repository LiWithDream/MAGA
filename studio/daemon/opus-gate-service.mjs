/**
 * Daemon-side Opus Gate Service:
 * - Persists sanitized dual-pool quota snapshots (`quota-state.json`) synced from UI
 * - Reads/CAS-dismisses per-conversation Opus checkpoint proposals (`opus-gate-proposals/<cid>.json`)
 * - Builds compact, evidence-first Swarm & Standalone Handoff briefs
 * - Idempotently syncs/removes the native `maga-opus-gate` Antigravity plugin
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  OPUS_GATE_PROPOSALS_DIR,
  QUOTA_STATE_FILE,
  readJsonOrFallback,
  writeAtomicUtf8,
} from '../../core/daemon/env.mjs';
import {
  buildPinnedHooksJsonForPlugin,
  extractPluginHookNodeBin,
  getPluginTargetDir as resolveManagedPluginTargetDir,
  isPluginInstalled,
  syncManagedPlugin,
  verifyPluginHookNodeRuntime,
} from './plugin-sync.mjs';
import { loadStudioPrefs } from '../../core/daemon/prefs-bundle.mjs';
import { resolveLocalProjectDir } from '../../core/daemon/projects.mjs';

const SAFE_CID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_PROPOSAL_FILES = 32;
const MAX_PROPOSAL_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_DIFF_SNIPPET_LINES = 250;
const MAX_DIFF_SNIPPET_CHARS = 12_000;
const PLUGIN_NAME = 'maga-opus-gate';
const PLUGIN_FILES = [
  'plugin.json',
  'hooks.json',
  'rules/AGENTS.md',
  'skills/opus-gate/SKILL.md',
  'hooks/gate-check.mjs',
];
const REQUIRED_PLUGIN_FILES = ['plugin.json', 'hooks.json', 'hooks/gate-check.mjs'];
const EXECUTABLE_PLUGIN_FILES = new Set(['hooks/gate-check.mjs']);

export const OPUS_GATE_ACTIONS = new Set([
  'saveQuotaState',
  'getOpusGateStatus',
  'dismissOpusGateProposal',
  'buildOpusHandoffBrief',
  'syncOpusGatePlugin',
]);

function clampPct(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function cleanSec(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function sanitizePool(rawPool, includeResets = false) {
  const src = rawPool && typeof rawPool === 'object' ? rawPool : {};
  const base = {
    fiveHourRemainingPct: clampPct(src.fiveHourRemainingPct),
    weeklyRemainingPct: clampPct(src.weeklyRemainingPct),
  };
  if (includeResets) {
    base.fiveHourResetSec = cleanSec(src.fiveHourResetSec);
    base.weeklyResetSec = cleanSec(src.weeklyResetSec);
  }
  return base;
}

function sanitizeInlineText(str, maxLen = 220) {
  return String(str || '')
    .replace(/`/g, "'")
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

function sanitizePathSafe(str) {
  return String(str || '')
    .replace(/\\/g, '/')
    .replace(/[`'"\r\n\t\u0000-\u001F\u007F]/g, '')
    .replace(/[^\w./@:+-]/g, '_')
    .slice(0, 220);
}

export function sanitizeQuotaState(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    schema: 1,
    updatedAt: Number(src.updatedAt) > 0 ? Math.floor(Number(src.updatedAt)) : Date.now(),
    tierName: typeof src.tierName === 'string' ? src.tierName.trim().slice(0, 64) : '',
    claude: sanitizePool(src.claude, true),
    gemini: sanitizePool(src.gemini, false),
  };
}

export function loadQuotaState(opts = {}) {
  const quotaFile = opts.quotaStateFile || QUOTA_STATE_FILE;
  const raw = readJsonOrFallback(quotaFile, null);
  return raw ? sanitizeQuotaState(raw) : null;
}

export function saveQuotaState(payload, opts = {}) {
  const quotaFile = opts.quotaStateFile || QUOTA_STATE_FILE;
  const next = sanitizeQuotaState(payload);
  fs.mkdirSync(path.dirname(quotaFile), { recursive: true });
  writeAtomicUtf8(quotaFile, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, quotaState: next };
}

function getProposalsDir(opts = {}) {
  return opts.proposalsDir || OPUS_GATE_PROPOSALS_DIR;
}

function getProposalFilePath(cid, opts = {}) {
  const safe = typeof cid === 'string' ? cid.trim() : '';
  if (!SAFE_CID_RE.test(safe)) return '';
  return path.join(getProposalsDir(opts), `${path.basename(safe)}.json`);
}

function pruneProposalsDir(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return;
    const now = Date.now();
    const alive = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      const full = path.join(dir, ent.name);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > MAX_PROPOSAL_AGE_MS) {
          fs.rmSync(full, { force: true });
        } else {
          alive.push({ full, mtimeMs: st.mtimeMs });
        }
      } catch {}
    }
    if (alive.length > MAX_PROPOSAL_FILES) {
      alive.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const item of alive.slice(0, alive.length - MAX_PROPOSAL_FILES)) {
        try {
          fs.rmSync(item.full, { force: true });
        } catch {}
      }
    }
  } catch {}
}

export function readOpusGateProposal(cid, opts = {}) {
  const filePath = getProposalFilePath(cid, opts);
  if (!filePath) return null;
  const raw = readJsonOrFallback(filePath, null);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

export function writeOpusGateProposal(cid, proposal, opts = {}) {
  const filePath = getProposalFilePath(cid, opts);
  if (!filePath || !proposal || typeof proposal !== 'object') return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeAtomicUtf8(filePath, `${JSON.stringify(proposal, null, 2)}\n`);
  pruneProposalsDir(path.dirname(filePath));
  return true;
}

function readActiveProposal(cid, opts = {}, now = Date.now()) {
  const entry = readOpusGateProposal(cid, opts);
  if (!entry || entry.dismissed === true) return null;
  if (now - Number(entry.ts || 0) >= PROPOSAL_TTL_MS) return null;
  return entry;
}

function getPluginTargetDir(opts = {}) {
  return resolveManagedPluginTargetDir(PLUGIN_NAME, opts);
}

export function isOpusGatePluginInstalled(opts = {}) {
  return isPluginInstalled(PLUGIN_NAME, REQUIRED_PLUGIN_FILES, opts);
}

export function buildPinnedOpusGateHooksJson(rawText, nodeBin = process.execPath) {
  return buildPinnedHooksJsonForPlugin(PLUGIN_NAME, rawText, nodeBin);
}

export function extractOpusGateHookNodeBin(hooksObj) {
  return extractPluginHookNodeBin(PLUGIN_NAME, hooksObj);
}

export function verifyOpusGateHookNodeRuntime(opts = {}) {
  return verifyPluginHookNodeRuntime(PLUGIN_NAME, {}, opts);
}

export function syncOpusGatePlugin({ remove = false } = {}, opts = {}) {
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

export function getOpusGateStatus(payload = {}, opts = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const pluginDir = getPluginTargetDir(opts);
  const pluginInstalled = isOpusGatePluginInstalled(opts);
  const quotaState = loadQuotaState(opts);
  const proposal = cid && SAFE_CID_RE.test(cid) ? readActiveProposal(cid, opts, now) : null;
  return { ok: true, pluginInstalled, pluginDir, quotaState, proposal };
}

export function dismissOpusGateProposal(payload = {}, opts = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  if (!cid || !SAFE_CID_RE.test(cid)) {
    return { ok: false, error: 'invalid_cascade_id' };
  }
  const cur = readOpusGateProposal(cid, opts);
  if (!cur) {
    return { ok: true, cascadeId: cid, matched: false };
  }
  const expectedHash = typeof payload?.diffHash === 'string' ? payload.diffHash.trim() : '';
  const expectedTs = Number(payload?.ts || 0);
  if (expectedHash && cur.diffHash && cur.diffHash !== expectedHash) {
    if (!expectedTs || Number(cur.ts || 0) !== expectedTs) {
      return { ok: true, cascadeId: cid, matched: false };
    }
  }
  writeOpusGateProposal(
    cid,
    {
      ...cur,
      dismissed: true,
      dismissedDiffHash: cur.diffHash || expectedHash || '',
    },
    opts
  );
  return { ok: true, cascadeId: cid, matched: true };
}

function execGitBriefAsync(absDir, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', absDir, ...args],
      {
        timeout: 1500,
        maxBuffer: 192 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        encoding: 'utf8',
      },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim())
    );
  });
}

function resolveOpusModelIdForTier(tier) {
  return tier === 'medium' ? 'claude-opus-5-5-medium' : 'claude-opus-5-5-high';
}

function computeRecommendedTier(prefs, quotaState, kind) {
  if (kind === 'stop') return 'medium';
  const claude5h = quotaState?.claude?.fiveHourRemainingPct ?? null;
  const preferredTier = prefs?.opusGatePreferredTier === 'medium' ? 'medium' : 'high';
  const min5h = Number(prefs?.opusGateMinQuota5hPct ?? 20);
  return preferredTier === 'high' && (claude5h === null || claude5h >= min5h + 15) ? 'high' : 'medium';
}

function resolveVerifiedWorkspaceDir(candidate, allowAnyDir = false) {
  const s = typeof candidate === 'string' ? candidate.trim() : '';
  if (!s) return '';
  return resolveLocalProjectDir(s) || (allowAnyDir && fs.existsSync(s) ? path.resolve(s) : '');
}

function boundDiffSnippet(rawDiff) {
  if (!rawDiff) return '';
  const lines = String(rawDiff).split(/\r?\n/).slice(0, MAX_DIFF_SNIPPET_LINES);
  let joined = lines.join('\n');
  if (joined.length > MAX_DIFF_SNIPPET_CHARS) {
    joined = `${joined.slice(0, MAX_DIFF_SNIPPET_CHARS)}\n... [truncated]`;
  }
  return joined.replace(/```/g, "'''");
}

export async function buildOpusHandoffBrief(payload = {}, opts = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  const rawKind = typeof payload?.kind === 'string' ? payload.kind.trim().toLowerCase() : '';
  const note = sanitizeInlineText(payload?.note || '', 500);
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const prefs = opts.studioPrefs || loadStudioPrefs(opts);
  const quotaState = loadQuotaState(opts);
  const prop = cid && SAFE_CID_RE.test(cid) ? readActiveProposal(cid, opts, now) : null;

  const kind = rawKind || prop?.kind || 'review';
  const recommendedTier = computeRecommendedTier(prefs, quotaState, kind);
  const recommendedModelId = resolveOpusModelIdForTier(recommendedTier);

  const absDir =
    resolveVerifiedWorkspaceDir(prop?.worktreeRoot, opts.allowAnyDir) ||
    resolveVerifiedWorkspaceDir(payload?.dirPath, opts.allowAnyDir) ||
    '';

  const safeHighRisk = Array.isArray(prop?.highRiskFiles)
    ? prop.highRiskFiles.map((f) => sanitizePathSafe(f)).filter(Boolean).slice(0, 8)
    : [];
  const safePlanFiles = Array.isArray(prop?.planFiles)
    ? prop.planFiles.map((f) => sanitizePathSafe(f)).filter(Boolean).slice(0, 5)
    : [];

  let statusText = '';
  let diffStat = '';
  let diffSnippet = '';
  if (absDir) {
    const safeRelPaths = safeHighRisk.filter((p) => !path.isAbsolute(p) && !p.startsWith('..'));
    const diffArgs = safeRelPaths.length
      ? ['diff', '-U3', '--', ...safeRelPaths]
      : ['diff', '-U3'];
    [statusText, diffStat, diffSnippet] = await Promise.all([
      execGitBriefAsync(absDir, ['status', '--short']),
      execGitBriefAsync(absDir, ['diff', '--stat']),
      execGitBriefAsync(absDir, diffArgs),
    ]);
  }

  const scopeLines = [];
  if (absDir) scopeLines.push(`- Active Worktree: \`${sanitizePathSafe(absDir)}\``);
  scopeLines.push(`- Gate Kind: \`${sanitizeInlineText(kind, 32)}\` (target tier: \`${recommendedModelId}\`)`);
  if (prop?.reason) scopeLines.push(`- Trigger Reason: ${sanitizeInlineText(prop.reason, 220)}`);
  if (safeHighRisk.length > 0) {
    scopeLines.push(`- High-Risk Files: ${safeHighRisk.map((f) => `\`${f}\``).join(', ')}`);
  }
  if (safePlanFiles.length > 0) {
    scopeLines.push(`- Plan / Design Artifacts: ${safePlanFiles.map((f) => `\`${f}\``).join(', ')}`);
  }
  if (Number(prop?.consecutiveErrors) > 0) {
    const safeSig = prop?.lastErrorSig ? ` (${sanitizeInlineText(prop.lastErrorSig, 160)})` : '';
    scopeLines.push(`- Consecutive Tool Errors: ${prop.consecutiveErrors}${safeSig}`);
  }
  if (note) scopeLines.push(`- User Note: ${note}`);
  if (statusText) {
    scopeLines.push(`- Git Status:\n\`\`\`text\n${statusText.split(/\r?\n/).slice(0, 20).join('\n')}\n\`\`\``);
  }
  if (diffStat) {
    scopeLines.push(`- Diff Summary:\n\`\`\`text\n${diffStat.split(/\r?\n/).slice(0, 20).join('\n')}\n\`\`\``);
  }
  const boundedDiff = boundDiffSnippet(diffSnippet);
  if (boundedDiff) {
    scopeLines.push(`- Diff Snippet (<= ${MAX_DIFF_SNIPPET_LINES} lines):\n\`\`\`diff\n${boundedDiff}\n\`\`\``);
  }
  const scopeBlock = scopeLines.join('\n');

  const swarmPrompt = [
    `[MAGA Opus Gate · ${sanitizeInlineText(kind, 32)}] Please load the \`opus-gate\` skill and delegate a compact, read-only Claude Opus (${recommendedTier}) checkpoint review via \`swarm\`.`,
    `- Only use \`fork: "coordinator"\` if \`${sanitizeInlineText(kind, 32)}\` is \`debug\` escalation; otherwise omit \`fork\` to keep context compact.`,
    `- Instruct \`opus-gate\` to inspect read-only using batched parallel reads/checks within **<= 3 turns**, keep output under **500 words**, and post \`@coordinator [done]\` with Verdict (\`APPROVE\` / \`REVISE\` / \`HOLD\`) and P0/P1/P2 findings (\`file:line\`).`,
    '',
    '### Gate Context',
    scopeBlock,
  ].join('\n');

  const handoffPrompt = [
    `Perform a focused, high-signal Claude Opus architecture & code review (${sanitizeInlineText(kind, 32)} checkpoint).`,
    'Inspect read-only first using batched parallel reads/checks (<= 3 turns) and keep the final report under 500 words.',
    '',
    '### Context & Scope',
    scopeBlock,
    '',
    '### Required Output Format',
    '- **Verdict**: `APPROVE` | `REVISE` | `HOLD`',
    '- **P0 (Blockers / Data Loss / Broken Invariants)**',
    '- **P1 (Functional Bugs / Races / Edge Cases)**',
    '- **P2 (Hardening & Missing Tests)**',
    'Include exact `file:line`, failure scenario, and minimal fix sketch per item.',
  ].join('\n');

  return {
    ok: true,
    kind,
    recommendedTier,
    recommendedModelId,
    quotaState,
    swarmPrompt,
    handoffPrompt,
  };
}

export async function handleOpusGateRpc(action, payload = {}, opts = {}) {
  switch (action) {
    case 'saveQuotaState':
      return saveQuotaState(payload, opts);
    case 'getOpusGateStatus':
      return getOpusGateStatus(payload, opts);
    case 'dismissOpusGateProposal':
      return dismissOpusGateProposal(payload, opts);
    case 'buildOpusHandoffBrief':
      return buildOpusHandoffBrief(payload, opts);
    case 'syncOpusGatePlugin':
      return syncOpusGatePlugin(payload, opts);
    default:
      return { ok: false, error: 'unknown_opus_gate_action' };
  }
}
