/**
 * Daemon-side Opus Gate Service:
 * - Persists sanitized dual-pool quota snapshots (`quota-state.json`) synced from UI
 * - Reads/dismisses hook-published Opus checkpoint proposals (`opus-gate-state.json`)
 * - Builds compact, token-minimal Swarm & Standalone Handoff briefs
 * - Idempotently syncs/removes the native `maga-opus-gate` Antigravity plugin
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  GLOBAL_PLUGINS_DIR,
  OPUS_GATE_STATE_FILE,
  QUOTA_STATE_FILE,
  REPO_ROOT,
  readJsonOrFallback,
  writeAtomicUtf8,
} from '../../core/daemon/env.mjs';
import { loadStudioPrefs } from '../../core/daemon/prefs-bundle.mjs';
import { resolveLocalProjectDir } from '../../core/daemon/projects.mjs';

const SAFE_CID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_GATE_CONVERSATIONS = 24;
const PLUGIN_NAME = 'maga-opus-gate';
const PLUGIN_FILES = [
  'plugin.json',
  'hooks.json',
  'rules/AGENTS.md',
  'skills/opus-gate/SKILL.md',
  'hooks/gate-check.mjs',
];

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

export function loadOpusGateState(opts = {}) {
  const gateFile = opts.gateStateFile || OPUS_GATE_STATE_FILE;
  const raw = readJsonOrFallback(gateFile, null);
  const convs =
    raw && typeof raw.conversations === 'object' && !Array.isArray(raw.conversations)
      ? raw.conversations
      : {};
  return { schema: 1, conversations: convs };
}

export function saveOpusGateState(nextState, opts = {}) {
  const gateFile = opts.gateStateFile || OPUS_GATE_STATE_FILE;
  const rawConvs =
    nextState && typeof nextState.conversations === 'object' && !Array.isArray(nextState.conversations)
      ? nextState.conversations
      : {};
  const entries = Object.entries(rawConvs)
    .filter(([cid, v]) => SAFE_CID_RE.test(cid) && v && typeof v === 'object')
    .sort((a, b) => Number(a[1]?.ts || 0) - Number(b[1]?.ts || 0))
    .slice(-MAX_GATE_CONVERSATIONS);
  const cleaned = { schema: 1, conversations: Object.fromEntries(entries) };
  fs.mkdirSync(path.dirname(gateFile), { recursive: true });
  writeAtomicUtf8(gateFile, `${JSON.stringify(cleaned, null, 2)}\n`);
  return cleaned;
}

function getPluginTargetDir(opts = {}) {
  return path.join(opts.pluginsDir || GLOBAL_PLUGINS_DIR, PLUGIN_NAME);
}

export function isOpusGatePluginInstalled(opts = {}) {
  const targetDir = getPluginTargetDir(opts);
  return fs.existsSync(path.join(targetDir, 'plugin.json')) && fs.existsSync(path.join(targetDir, 'hooks.json'));
}

export function syncOpusGatePlugin({ remove = false } = {}, opts = {}) {
  const srcDir = opts.pluginSrcDir || path.join(REPO_ROOT, 'studio', 'plugin', PLUGIN_NAME);
  const targetDir = getPluginTargetDir(opts);
  if (remove) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return { ok: true, action: 'removed', pluginDir: targetDir, installed: false };
  }
  if (!fs.existsSync(srcDir)) {
    return { ok: false, error: 'missing_plugin_source', srcDir };
  }
  const copied = [];
  for (const rel of PLUGIN_FILES) {
    const from = path.join(srcDir, rel);
    const to = path.join(targetDir, rel);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const body = fs.readFileSync(from, 'utf8');
    writeAtomicUtf8(to, body);
    copied.push(rel);
  }
  return { ok: true, action: 'synced', pluginDir: targetDir, files: copied, installed: isOpusGatePluginInstalled(opts) };
}

export function getOpusGateStatus(payload = {}, opts = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const pluginDir = getPluginTargetDir(opts);
  const pluginInstalled = isOpusGatePluginInstalled(opts);
  const quotaState = loadQuotaState(opts);
  const gateState = loadOpusGateState(opts);
  let proposal = null;
  if (cid && SAFE_CID_RE.test(cid)) {
    const entry = gateState.conversations[cid];
    if (entry && entry.dismissed !== true && now - Number(entry.ts || 0) < PROPOSAL_TTL_MS) {
      proposal = entry;
    }
  }
  return { ok: true, pluginInstalled, pluginDir, quotaState, proposal };
}

export function dismissOpusGateProposal(payload = {}, opts = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  if (!cid || !SAFE_CID_RE.test(cid)) {
    return { ok: false, error: 'invalid_cascade_id' };
  }
  const state = loadOpusGateState(opts);
  const cur = state.conversations[cid] && typeof state.conversations[cid] === 'object' ? state.conversations[cid] : {};
  state.conversations[cid] = {
    ...cur,
    dismissed: true,
    dismissedDiffHash: typeof payload?.diffHash === 'string' ? payload.diffHash : cur.diffHash || '',
    ts: Number(cur.ts || Date.now()),
  };
  saveOpusGateState(state, opts);
  return { ok: true, cascadeId: cid };
}

function execGitBriefAsync(absDir, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', absDir, ...args],
      { timeout: 1500, maxBuffer: 128 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim())
    );
  });
}

function resolveOpusModelIdForTier(tier) {
  return tier === 'medium' ? 'claude-opus-5-5-medium' : 'claude-opus-5-5-high';
}

export async function buildOpusHandoffBrief(payload = {}, opts = {}) {
  const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
  const rawKind = typeof payload?.kind === 'string' ? payload.kind.trim().toLowerCase() : '';
  const note = typeof payload?.note === 'string' ? payload.note.trim().slice(0, 500) : '';
  const prefs = opts.studioPrefs || loadStudioPrefs(opts);
  const quotaState = loadQuotaState(opts);
  const gateState = loadOpusGateState(opts);
  const prop = cid && SAFE_CID_RE.test(cid) ? gateState.conversations[cid] || null : null;

  const kind = rawKind || prop?.kind || 'review';
  const claude5h = quotaState?.claude?.fiveHourRemainingPct ?? null;
  const preferredTier = prefs?.opusGatePreferredTier === 'medium' ? 'medium' : 'high';
  const min5h = Number(prefs?.opusGateMinQuota5hPct ?? 20);
  const recommendedTier =
    prop?.recommendedTier ||
    (preferredTier === 'high' && (claude5h === null || claude5h >= min5h + 15) ? 'high' : 'medium');
  const recommendedModelId = resolveOpusModelIdForTier(recommendedTier);

  const rawDir = typeof payload?.dirPath === 'string' ? payload.dirPath.trim() : '';
  const absDir = rawDir ? resolveLocalProjectDir(rawDir) || (opts.allowAnyDir && fs.existsSync(rawDir) ? path.resolve(rawDir) : '') : '';

  let statusText = '';
  let diffStat = '';
  if (absDir) {
    [statusText, diffStat] = await Promise.all([
      execGitBriefAsync(absDir, ['status', '--short']),
      execGitBriefAsync(absDir, ['diff', '--stat']),
    ]);
  }

  const scopeLines = [];
  if (absDir) scopeLines.push(`- Workspace: \`${absDir}\``);
  scopeLines.push(`- Gate Kind: \`${kind}\` (target tier: \`${recommendedModelId}\`)`);
  if (prop?.reason) scopeLines.push(`- Trigger Reason: ${prop.reason}`);
  if (Array.isArray(prop?.highRiskFiles) && prop.highRiskFiles.length > 0) {
    scopeLines.push(`- High-Risk Files: ${prop.highRiskFiles.slice(0, 8).map((f) => `\`${f}\``).join(', ')}`);
  }
  if (Number(prop?.consecutiveErrors) > 0) {
    scopeLines.push(`- Consecutive Tool Errors: ${prop.consecutiveErrors}${prop.lastErrorSig ? ` (${prop.lastErrorSig})` : ''}`);
  }
  if (note) scopeLines.push(`- User Note: ${note}`);
  if (statusText) {
    scopeLines.push(`- Git Status:\n\`\`\`text\n${statusText.split(/\r?\n/).slice(0, 20).join('\n')}\n\`\`\``);
  }
  if (diffStat) {
    scopeLines.push(`- Diff Summary:\n\`\`\`text\n${diffStat.split(/\r?\n/).slice(0, 20).join('\n')}\n\`\`\``);
  }
  const scopeBlock = scopeLines.join('\n');

  const swarmPrompt = [
    `[MAGA Opus Gate · ${kind}] Please load the \`opus-gate\` skill and delegate a compact, read-only Claude Opus (${recommendedTier}) checkpoint review via \`swarm\`.`,
    `- Only use \`fork: "coordinator"\` if \`${kind}\` is \`debug\` escalation; otherwise keep context compact.`,
    `- Instruct \`opus-gate\` to inspect read-only and post \`@coordinator [done]\` with Verdict (\`APPROVE\` / \`REVISE\` / \`HOLD\`) and P0/P1/P2 findings (\`file:line\`).`,
    '',
    '### Gate Context',
    scopeBlock,
  ].join('\n');

  const handoffPrompt = [
    `Perform a focused, high-signal Claude Opus architecture & code review (${kind} checkpoint).`,
    'Inspect read-only first and provide concrete, actionable findings.',
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
