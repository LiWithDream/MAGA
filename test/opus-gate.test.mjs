import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERMETIC_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-opus-gate-test-'));
process.env.ANTI_CLAUDE_STATE_DIR = HERMETIC_STATE;
process.on('exit', () => {
  try {
    fs.rmSync(HERMETIC_STATE, { recursive: true, force: true });
  } catch {}
});

const { DEFAULT_STUDIO_PREFS, sanitizeStudioPrefs } = await import('../core/daemon/prefs-bundle.mjs');
const { createStudioPrefsRuntime } = await import('../studio/modules/studio-prefs.mjs');
const {
  saveQuotaState,
  loadQuotaState,
  syncOpusGatePlugin,
  isOpusGatePluginInstalled,
  verifyOpusGateHookNodeRuntime,
  getOpusGateStatus,
  dismissOpusGateProposal,
  buildOpusHandoffBrief,
  writeOpusGateProposal,
  readOpusGateProposal,
  handleOpusGateRpc,
} = await import('../studio/daemon/opus-gate-service.mjs');
const {
  GATE_DEFAULT_PREFS,
  evaluateHookEvent,
  evaluatePreflight,
  clearGateState,
  isSelfOrHigherModel,
} = await import('../studio/plugin/maga-opus-gate/hooks/gate-check.mjs');
const { createOpusGatePillRuntime } = await import('../studio/modules/opus-gate-pill.mjs');
const { buildStudioBundle } = await import('../studio/build.mjs');

let JSDOM = null;
try {
  JSDOM = createRequire(process.env.JSDOM_FROM || import.meta.url)('jsdom').JSDOM;
} catch {}
const skipDom = JSDOM ? false : 'jsdom not installed';

function makeTempDirs(prefix = 'og-unit-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const pluginDataDir = path.join(root, 'plugin-data');
  const proposalsDir = path.join(stateDir, 'opus-gate-proposals');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(pluginDataDir, { recursive: true });
  fs.mkdirSync(proposalsDir, { recursive: true });
  return {
    root,
    stateDir,
    pluginsDir,
    pluginDataDir,
    proposalsDir,
    studioPrefsFile: path.join(stateDir, 'studio-prefs.json'),
    quotaStateFile: path.join(stateDir, 'quota-state.json'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function proposalFile(dirs, cid) {
  return path.join(dirs.proposalsDir, `${cid}.json`);
}

function readProposal(dirs, cid) {
  const f = proposalFile(dirs, cid);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

async function withMockDom(dom, fn) {
  const keys = ['window', 'document', 'location', 'localStorage'];
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  const assign = (k, val) => {
    try {
      Object.defineProperty(globalThis, k, { value: val, configurable: true, writable: true });
    } catch {}
  };
  assign('window', dom.window);
  assign('document', dom.window.document);
  assign('location', dom.window.location);
  assign('localStorage', dom.window.localStorage);
  try {
    return await fn();
  } finally {
    for (const [k, desc] of saved) {
      if (desc) {
        try {
          Object.defineProperty(globalThis, k, desc);
        } catch {}
      } else {
        try {
          delete globalThis[k];
        } catch {}
      }
    }
    dom.window.close();
  }
}

function tick(ms = 25) {
  return new Promise((r) => setTimeout(r, ms));
}

test('prefs defaults and sanitization handle Review Gate fields, parity, and bounds', () => {
  assert.equal(DEFAULT_STUDIO_PREFS.opusGateMode, 'semi');
  assert.equal(DEFAULT_STUDIO_PREFS.opusGateModel, 'opus');
  assert.equal(DEFAULT_STUDIO_PREFS.opusGatePreferredTier, undefined);
  assert.equal(DEFAULT_STUDIO_PREFS.opusGateMinQuota5hPct, 20);
  assert.equal(DEFAULT_STUDIO_PREFS.opusGateMinQuotaWeeklyPct, 15);
  assert.equal(DEFAULT_STUDIO_PREFS.opusGateMaxAutoPerSession, 2);
  assert.deepEqual(DEFAULT_STUDIO_PREFS.opusGateCheckpoints, {
    plan: true,
    risk: true,
    debug: true,
    stop: true,
  });

  // Parity guard: hook DEFAULT_PREFS stays aligned with schema DEFAULT_STUDIO_PREFS
  assert.equal(GATE_DEFAULT_PREFS.opusGateMode, DEFAULT_STUDIO_PREFS.opusGateMode);
  assert.equal(GATE_DEFAULT_PREFS.opusGateModel, DEFAULT_STUDIO_PREFS.opusGateModel);
  assert.equal(GATE_DEFAULT_PREFS.opusGateMinQuota5hPct, DEFAULT_STUDIO_PREFS.opusGateMinQuota5hPct);
  assert.equal(GATE_DEFAULT_PREFS.opusGateMinQuotaWeeklyPct, DEFAULT_STUDIO_PREFS.opusGateMinQuotaWeeklyPct);
  assert.equal(GATE_DEFAULT_PREFS.opusGateMaxAutoPerSession, DEFAULT_STUDIO_PREFS.opusGateMaxAutoPerSession);
  assert.deepEqual(GATE_DEFAULT_PREFS.opusGateCheckpoints, DEFAULT_STUDIO_PREFS.opusGateCheckpoints);

  const clamped = sanitizeStudioPrefs({
    opusGateMode: 'bogus',
    opusGateModel: 'ultra',
    opusGatePreferredTier: 'medium',
    opusGateMinQuota5hPct: 1,
    opusGateMinQuotaWeeklyPct: 99,
    opusGateMaxAutoPerSession: 12,
    opusGateCheckpoints: { plan: false, stop: 'yes' },
  });
  assert.equal(clamped.opusGateMode, 'semi');
  assert.equal(clamped.opusGateModel, 'opus');
  assert.equal(clamped.opusGatePreferredTier, undefined);
  assert.equal(clamped.opusGateMinQuota5hPct, 5);
  assert.equal(clamped.opusGateMinQuotaWeeklyPct, 60);
  assert.equal(clamped.opusGateMaxAutoPerSession, 5);
  assert.deepEqual(clamped.opusGateCheckpoints, {
    plan: false,
    risk: true,
    debug: true,
    stop: true,
  });

  const valid = sanitizeStudioPrefs({
    opusGateMode: 'auto',
    opusGateModel: 'carbon',
    opusGateMinQuota5hPct: 35,
    opusGateMinQuotaWeeklyPct: 25,
    opusGateMaxAutoPerSession: 3,
    opusGateCheckpoints: { plan: true, risk: false, debug: true, stop: false },
  });
  assert.equal(valid.opusGateMode, 'auto');
  assert.equal(valid.opusGateModel, 'carbon');
  assert.equal(valid.opusGateMinQuota5hPct, 35);
  assert.equal(valid.opusGateMinQuotaWeeklyPct, 25);
  assert.equal(valid.opusGateMaxAutoPerSession, 3);
  assert.deepEqual(valid.opusGateCheckpoints, {
    plan: true,
    risk: false,
    debug: true,
    stop: false,
  });

  const rt = createStudioPrefsRuntime();
  try {
    assert.equal(rt.get().opusGateMode, 'semi');
    assert.equal(rt.get().opusGateModel, 'opus');
    rt.patch({ opusGateMode: 'auto', opusGateModel: 'carbon', opusGateCheckpoints: { debug: false } });
    assert.equal(rt.get().opusGateMode, 'auto');
    assert.equal(rt.get().opusGateModel, 'carbon');
    assert.deepEqual(rt.get().opusGateCheckpoints, {
      plan: true,
      risk: true,
      debug: false,
      stop: true,
    });
  } finally {
    rt.dispose();
  }
});

test('opus-gate-service persists quota, syncs plugin, enforces CAS dismiss, recomputes live tier & dispatches RPC', async () => {
  const dirs = makeTempDirs();
  try {
    const saved = saveQuotaState(
      {
        tierName: 'AI Ultra',
        claude: { fiveHourRemainingPct: 120, weeklyRemainingPct: 48.34, fiveHourResetSec: 1200 },
        gemini: { fiveHourRemainingPct: -5, weeklyRemainingPct: 90, fiveHourResetSec: 900, weeklyResetSec: 86400 },
      },
      { quotaStateFile: dirs.quotaStateFile }
    );
    assert.equal(saved.ok, true);
    const loaded = loadQuotaState({ quotaStateFile: dirs.quotaStateFile });
    assert.equal(loaded.tierName, 'AI Ultra');
    assert.equal(loaded.claude.fiveHourRemainingPct, 100);
    assert.equal(loaded.claude.weeklyRemainingPct, 48.3);
    assert.equal(loaded.claude.fiveHourResetSec, 1200);
    assert.equal(loaded.gemini.fiveHourRemainingPct, 0);
    assert.equal(loaded.gemini.fiveHourResetSec, 900);
    assert.equal(loaded.gemini.weeklyResetSec, 86400);

    const rulesStat = fs.statSync(path.join(REPO, 'studio', 'plugin', 'maga-opus-gate', 'rules', 'AGENTS.md'));
    assert.ok(rulesStat.size > 0 && rulesStat.size < 1500, `expected rules/AGENTS.md < 1500 bytes, got ${rulesStat.size}`);

    assert.equal(isOpusGatePluginInstalled({ pluginsDir: dirs.pluginsDir }), false);
    const synced = syncOpusGatePlugin({}, { pluginsDir: dirs.pluginsDir });
    assert.equal(synced.ok, true);
    assert.equal(synced.installed, true);
    assert.ok(synced.files.includes('plugin.json'));
    assert.ok(synced.files.includes('hooks.json'));
    assert.ok(synced.files.includes('rules/AGENTS.md'));
    assert.ok(synced.files.includes('skills/opus-gate/SKILL.md'));
    assert.ok(synced.files.includes('hooks/gate-check.mjs'));
    assert.equal(isOpusGatePluginInstalled({ pluginsDir: dirs.pluginsDir }), true);

    const cid = 'conv_service_123456';
    writeOpusGateProposal(
      cid,
      {
        kind: 'risk',
        reason: 'High-risk file changes (studio/core/kernel.mjs)',
        diffHash: 'abc123def456',
        highRiskFiles: ['studio/core/kernel.mjs'],
        planFiles: ['docs/architecture-plan.md'],
        worktreeRoot: REPO,
        recommendedTier: 'high',
        ts: 100_000,
        dismissed: false,
      },
      { proposalsDir: dirs.proposalsDir }
    );

    const active = getOpusGateStatus(
      { cascadeId: cid },
      {
        studioPrefs: { ...DEFAULT_STUDIO_PREFS, opusGateModel: 'opus' },
        pluginsDir: dirs.pluginsDir,
        quotaStateFile: dirs.quotaStateFile,
        proposalsDir: dirs.proposalsDir,
        now: 120_000,
      }
    );
    assert.equal(active.ok, true);
    assert.equal(active.pluginInstalled, true);
    assert.equal(active.proposal?.kind, 'risk');
    assert.equal(active.proposal?.reviewerModel, 'opus');
    assert.equal(active.proposal?.quotaPool, 'claude');
    assert.equal(active.proposal?.quotaBlocked, false);

    // P0-2 regression: switching opusGateModel to carbon recomputes pool pcts & quotaBlocked from live quotaState
    const activeCarbon = getOpusGateStatus(
      { cascadeId: cid },
      {
        studioPrefs: { ...DEFAULT_STUDIO_PREFS, opusGateModel: 'carbon', opusGateMinQuota5hPct: 20 },
        pluginsDir: dirs.pluginsDir,
        quotaStateFile: dirs.quotaStateFile,
        proposalsDir: dirs.proposalsDir,
        now: 120_000,
      }
    );
    assert.equal(activeCarbon.proposal?.reviewerModel, 'carbon');
    assert.equal(activeCarbon.proposal?.recommendedModelId, 'gemini-4-carbon-high');
    assert.equal(activeCarbon.proposal?.quotaPool, 'gemini');
    assert.equal(activeCarbon.proposal?.pool5hPct, 0);
    assert.equal(activeCarbon.proposal?.quotaBlocked, true);

    const expired = getOpusGateStatus(
      { cascadeId: cid },
      {
        pluginsDir: dirs.pluginsDir,
        quotaStateFile: dirs.quotaStateFile,
        proposalsDir: dirs.proposalsDir,
        now: 100_000 + 31 * 60 * 1000,
      }
    );
    assert.equal(expired.proposal, null);

    // Expired proposal is NOT used in buildOpusHandoffBrief
    const briefExpired = await buildOpusHandoffBrief(
      { cascadeId: cid, dirPath: REPO, kind: 'risk' },
      {
        studioPrefs: DEFAULT_STUDIO_PREFS,
        quotaStateFile: dirs.quotaStateFile,
        proposalsDir: dirs.proposalsDir,
        allowAnyDir: true,
        now: 100_000 + 31 * 60 * 1000,
      }
    );
    const expiredHeader = briefExpired.swarmPrompt.split('\n- Git Status:')[0].split('\n- Diff Snippet')[0];
    assert.doesNotMatch(expiredHeader, /High-risk file changes/);
    assert.doesNotMatch(expiredHeader, /Plan \/ Design Artifacts/);
    assert.equal(briefExpired.handoffPrompt, undefined);

    const briefHigh = await buildOpusHandoffBrief(
      { cascadeId: cid, dirPath: REPO, note: 'Check `observer`\nisolation' },
      {
        studioPrefs: { ...DEFAULT_STUDIO_PREFS, opusGateModel: 'opus', opusGateMinQuota5hPct: 20 },
        quotaStateFile: dirs.quotaStateFile,
        proposalsDir: dirs.proposalsDir,
        allowAnyDir: true,
        now: 120_000,
      }
    );
    assert.equal(briefHigh.ok, true);
    assert.equal(briefHigh.reviewerModel, 'opus');
    assert.equal(briefHigh.workerName, 'review-opus');
    assert.equal(briefHigh.recommendedTier, 'high');
    assert.equal(briefHigh.recommendedModelId, 'claude-opus-5-5-high');
    assert.equal(briefHigh.handoffPrompt, undefined);
    assert.match(briefHigh.swarmPrompt, /review-opus/);
    assert.match(briefHigh.swarmPrompt, /claude-opus-5-5-high/);
    assert.match(briefHigh.swarmPrompt, /<= 3 turns/);
    assert.match(briefHigh.swarmPrompt, /500 words/);
    assert.match(briefHigh.swarmPrompt, /APPROVE/);
    assert.match(briefHigh.swarmPrompt, /Check 'observer' isolation/);
    assert.match(briefHigh.swarmPrompt, /Plan \/ Design Artifacts: `docs\/architecture-plan\.md`/);

    // Locked High effort: tight 5h quota and kind='stop' NEVER downgrade to medium
    saveQuotaState(
      {
        claude: { fiveHourRemainingPct: 25, weeklyRemainingPct: 50 },
        gemini: { fiveHourRemainingPct: 88, weeklyRemainingPct: 92 },
      },
      { quotaStateFile: dirs.quotaStateFile }
    );
    const briefStopOpus = await buildOpusHandoffBrief(
      { cascadeId: cid, kind: 'stop' },
      {
        studioPrefs: { ...DEFAULT_STUDIO_PREFS, opusGateModel: 'opus', opusGateMinQuota5hPct: 20 },
        quotaStateFile: dirs.quotaStateFile,
        proposalsDir: dirs.proposalsDir,
        allowAnyDir: true,
        now: 120_000,
      }
    );
    assert.equal(briefStopOpus.recommendedTier, 'high');
    assert.equal(briefStopOpus.recommendedModelId, 'claude-opus-5-5-high');

    // Configured Carbon + per-click override in either direction without mutating prefs
    const briefCarbon = await buildOpusHandoffBrief(
      { cascadeId: cid, kind: 'risk' },
      {
        studioPrefs: { ...DEFAULT_STUDIO_PREFS, opusGateModel: 'carbon' },
        quotaStateFile: dirs.quotaStateFile,
        proposalsDir: dirs.proposalsDir,
        allowAnyDir: true,
        now: 120_000,
      }
    );
    assert.equal(briefCarbon.reviewerModel, 'carbon');
    assert.equal(briefCarbon.workerName, 'review-carbon');
    assert.equal(briefCarbon.quotaPool, 'gemini');
    assert.equal(briefCarbon.recommendedTier, 'high');
    assert.equal(briefCarbon.recommendedModelId, 'gemini-4-carbon-high');
    assert.match(briefCarbon.swarmPrompt, /review-carbon/);
    assert.match(briefCarbon.swarmPrompt, /gemini-4-carbon-high/);
    assert.match(briefCarbon.swarmPrompt, /Gemini 4 Carbon \(High\)/);

    const briefOverrideCarbon = await buildOpusHandoffBrief(
      { cascadeId: cid, kind: 'risk', model: 'carbon' },
      {
        studioPrefs: { ...DEFAULT_STUDIO_PREFS, opusGateModel: 'opus' },
        quotaStateFile: dirs.quotaStateFile,
        proposalsDir: dirs.proposalsDir,
        allowAnyDir: true,
        now: 120_000,
      }
    );
    assert.equal(briefOverrideCarbon.reviewerModel, 'carbon');
    assert.equal(briefOverrideCarbon.recommendedModelId, 'gemini-4-carbon-high');

    const briefInvalidOverride = await buildOpusHandoffBrief(
      { cascadeId: cid, kind: 'risk', model: 'invalid-model' },
      {
        studioPrefs: { ...DEFAULT_STUDIO_PREFS, opusGateModel: 'carbon' },
        quotaStateFile: dirs.quotaStateFile,
        proposalsDir: dirs.proposalsDir,
        allowAnyDir: true,
        now: 120_000,
      }
    );
    assert.equal(briefInvalidOverride.reviewerModel, 'carbon');
    assert.equal(briefInvalidOverride.recommendedModelId, 'gemini-4-carbon-high');

    // Compare-And-Set dismiss: mismatched diffHash leaves newer proposal intact
    const casMiss = dismissOpusGateProposal(
      { cascadeId: cid, diffHash: 'stale_hash_000' },
      { proposalsDir: dirs.proposalsDir }
    );
    assert.equal(casMiss.ok, true);
    assert.equal(casMiss.matched, false);
    assert.equal(readOpusGateProposal(cid, { proposalsDir: dirs.proposalsDir })?.dismissed, false);

    // Matching diffHash marks dismissed
    const dis = dismissOpusGateProposal(
      { cascadeId: cid, diffHash: 'abc123def456' },
      { proposalsDir: dirs.proposalsDir }
    );
    assert.equal(dis.ok, true);
    assert.equal(dis.matched, true);
    const afterDismiss = getOpusGateStatus(
      { cascadeId: cid },
      { pluginsDir: dirs.pluginsDir, quotaStateFile: dirs.quotaStateFile, proposalsDir: dirs.proposalsDir, now: 120_000 }
    );
    assert.equal(afterDismiss.proposal, null);

    // Unified handleOpusGateRpc dispatcher
    const rpcStatus = await handleOpusGateRpc(
      'getOpusGateStatus',
      { cascadeId: cid },
      { pluginsDir: dirs.pluginsDir, quotaStateFile: dirs.quotaStateFile, proposalsDir: dirs.proposalsDir, now: 120_000 }
    );
    assert.equal(rpcStatus.ok, true);
    const rpcUnknown = await handleOpusGateRpc('nonexistentOp', {}, { proposalsDir: dirs.proposalsDir });
    assert.equal(rpcUnknown.ok, false);

    const removed = syncOpusGatePlugin({ remove: true }, { pluginsDir: dirs.pluginsDir });
    assert.equal(removed.ok, true);
    assert.equal(removed.installed, false);
    assert.equal(isOpusGatePluginInstalled({ pluginsDir: dirs.pluginsDir }), false);
  } finally {
    dirs.cleanup();
  }
});

test('gate-check sentinel enforces self-skip, error streak, risk/stop dedup, auto cap, quota breaker & prompt sanitization', () => {
  const dirs = makeTempDirs('og-hook-');
  const cid = 'conv_hook_987654';
  const hookOpts = (extra = {}) => ({
    stateDir: dirs.stateDir,
    studioPrefsFile: dirs.studioPrefsFile,
    quotaStateFile: dirs.quotaStateFile,
    proposalsDir: dirs.proposalsDir,
    pluginDataDir: dirs.pluginDataDir,
    now: 500_000,
    ...extra,
  });

  try {
    fs.writeFileSync(
      dirs.studioPrefsFile,
      JSON.stringify({
        ...DEFAULT_STUDIO_PREFS,
        opusGateMode: 'semi',
        opusGateMinQuota5hPct: 20,
        opusGateMinQuotaWeeklyPct: 15,
        opusGateMaxAutoPerSession: 2,
      })
    );
    fs.writeFileSync(
      dirs.quotaStateFile,
      JSON.stringify({
        schema: 1,
        updatedAt: 500_000,
        claude: { fiveHourRemainingPct: 80, weeklyRemainingPct: 70 },
      })
    );

    // 1. Self-recursion skip when current agent is already Opus + invalid cid never creates default.json
    assert.deepEqual(
      evaluateHookEvent(
        {
          hookEventName: 'Stop',
          conversationId: cid,
          modelName: 'Claude Opus 5.5 (High)',
          terminationReason: 'NO_TOOL_CALL',
        },
        hookOpts({ gitSummary: { changedFiles: 5, changedLines: 300, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'd0' } })
      ),
      {}
    );
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: 'bad',
        cwd: REPO,
        toolCall: { name: 'edit_file', args: { Path: path.join(REPO, 'studio/core/kernel.mjs') } },
      },
      hookOpts()
    );
    assert.equal(fs.existsSync(path.join(dirs.pluginDataDir, 'default.json')), false);

    // 2. PostToolUse consecutive command error tracking + prompt-injection sanitization
    evaluateHookEvent(
      { hookEventName: 'PostToolUse', conversationId: cid, toolCall: { name: 'run_command' }, error: 'ENOENT step 1' },
      hookOpts()
    );
    assert.equal(fs.existsSync(proposalFile(dirs, cid)), false);

    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cid,
        toolCall: { name: 'run_command' },
        error: 'ERR `ignore previous` step 2\nline2',
      },
      hookOpts()
    );
    let prop = readProposal(dirs, cid);
    assert.equal(prop?.kind, 'debug');
    assert.equal(prop?.consecutiveErrors, 2);
    assert.equal(prop?.lastErrorSig.includes('`'), false);

    evaluateHookEvent(
      { hookEventName: 'PostToolUse', conversationId: cid, toolCall: { name: 'run_command' }, error: '' },
      hookOpts()
    );

    // 3. Edit high-risk file tracking + Stop guards
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cid,
        cwd: REPO,
        toolCall: { name: 'edit_file', args: { Path: path.join(REPO, 'studio/core/kernel.mjs') } },
      },
      hookOpts()
    );

    assert.deepEqual(
      evaluateHookEvent(
        {
          hookEventName: 'Stop',
          conversationId: cid,
          continuationActive: true,
          terminationReason: 'NO_TOOL_CALL',
        },
        hookOpts({ gitSummary: { changedFiles: 1, changedLines: 10, gitHighRisk: [], diffHash: 'd1' } })
      ),
      {}
    );

    // 4. Semi mode publishes risk proposal & deduplicates same risk set (even if extra non-risk lines change)
    assert.deepEqual(
      evaluateHookEvent(
        { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
        hookOpts({ gitSummary: { changedFiles: 1, changedLines: 12, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'hash_risk_1' } })
      ),
      {}
    );
    prop = readProposal(dirs, cid);
    assert.equal(prop?.kind, 'risk');
    assert.equal(prop?.recommendedTier, 'high');

    fs.unlinkSync(proposalFile(dirs, cid));
    evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 2, changedLines: 30, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'hash_risk_2' } })
    );
    assert.equal(fs.existsSync(proposalFile(dirs, cid)), false);

    // 5. Auto mode: high-risk fires first (high), then +3 files / +160 lines fires stop (still locked high), then cap falls back to proposal
    fs.writeFileSync(
      dirs.studioPrefsFile,
      JSON.stringify({
        ...DEFAULT_STUDIO_PREFS,
        opusGateMode: 'auto',
        opusGateMinQuota5hPct: 20,
        opusGateMinQuotaWeeklyPct: 15,
        opusGateMaxAutoPerSession: 2,
      })
    );

    const auto1 = evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 1, changedLines: 20, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'hash_auto_1' } })
    );
    assert.equal(auto1.decision, 'continue');
    assert.match(auto1.reason, /\[MAGA Review Gate · risk\]/);
    assert.match(auto1.reason, /claude-opus-5-5-high/);
    assert.match(auto1.reason, /review-opus/);

    // Same high-risk set + small diff growth stays silent
    assert.deepEqual(
      evaluateHookEvent(
        { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
        hookOpts({ gitSummary: { changedFiles: 2, changedLines: 45, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'hash_auto_1b' } })
      ),
      {}
    );

    // Grow diff by +3 files and +160 lines -> risk already audited, stop fires with locked high tier
    const auto2 = evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 4, changedLines: 180, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'hash_auto_2' } })
    );
    assert.equal(auto2.decision, 'continue');
    assert.match(auto2.reason, /\[MAGA Review Gate · stop\]/);
    assert.match(auto2.reason, /claude-opus-5-5-high/);

    // 3rd trigger hits maxAutoPerSession=2 -> falls back to per-cid proposal
    const auto3 = evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 8, changedLines: 340, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'hash_auto_3' } })
    );
    assert.deepEqual(auto3, {});
    prop = readProposal(dirs, cid);
    assert.equal(prop?.kind, 'stop');

    // 6. Quota circuit breaker on fresh coding conversation when claude5hPct < minQuota5hPct
    const cidBreaker = 'conv_breaker_1111';
    fs.writeFileSync(
      dirs.quotaStateFile,
      JSON.stringify({
        schema: 1,
        updatedAt: 500_000,
        claude: { fiveHourRemainingPct: 12, weeklyRemainingPct: 60 },
        gemini: { fiveHourRemainingPct: 88, weeklyRemainingPct: 92 },
      })
    );
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cidBreaker,
        cwd: REPO,
        toolCall: { name: 'edit_file', args: { Path: path.join(REPO, 'src/app.mjs') } },
      },
      hookOpts()
    );
    const blockedRes = evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cidBreaker, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 4, changedLines: 140, gitHighRisk: [], diffHash: 'hash_brk_1' } })
    );
    assert.deepEqual(blockedRes, {});
    prop = readProposal(dirs, cidBreaker);
    assert.equal(prop?.quotaBlocked, true);
    assert.equal(prop?.quotaPool, 'claude');

    // 7. Carbon reviewer routing: uses Gemini pool, skips Carbon/Opus self-sessions, allows Neon/Hydrogen
    assert.equal(isSelfOrHigherModel('opus', 'Claude Opus 5.5 (High)'), true);
    assert.equal(isSelfOrHigherModel('opus', 'Gemini 4 Carbon (High)'), false);
    assert.equal(isSelfOrHigherModel('carbon', 'Gemini 4 Carbon (High)'), true);
    assert.equal(isSelfOrHigherModel('carbon', 'Orchestrator (Carbon)'), true);
    assert.equal(isSelfOrHigherModel('carbon', 'Claude Opus 5.5 (High)'), true);
    assert.equal(isSelfOrHigherModel('carbon', 'Gemini 4 Neon (High)'), false);
    assert.equal(isSelfOrHigherModel('carbon', 'Gemini 4 Hydrogen (Low)'), false);

    const cidCarbon = 'conv_carbon_2222';
    fs.writeFileSync(
      dirs.studioPrefsFile,
      JSON.stringify({
        ...DEFAULT_STUDIO_PREFS,
        opusGateMode: 'auto',
        opusGateModel: 'carbon',
        opusGateMinQuota5hPct: 20,
        opusGateMinQuotaWeeklyPct: 15,
      })
    );
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cidCarbon,
        cwd: REPO,
        modelName: 'Gemini 4 Neon (High)',
        toolCall: { name: 'edit_file', args: { Path: path.join(REPO, 'studio/core/kernel.mjs') } },
      },
      hookOpts()
    );
    // Carbon session skips reviewing itself; Neon session triggers Carbon even though Claude pool is 12%
    assert.deepEqual(
      evaluateHookEvent(
        { hookEventName: 'Stop', conversationId: cidCarbon, modelName: 'Gemini 4 Carbon (High)', terminationReason: 'NO_TOOL_CALL' },
        hookOpts({ gitSummary: { changedFiles: 1, changedLines: 25, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'hash_cb_skip' } })
      ),
      {}
    );
    const carbonAuto = evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cidCarbon, modelName: 'Gemini 4 Neon (High)', terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 1, changedLines: 25, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'hash_cb_run' } })
    );
    assert.equal(carbonAuto.decision, 'continue');
    assert.match(carbonAuto.reason, /gemini-4-carbon-high/);
    assert.match(carbonAuto.reason, /review-carbon/);

    // Low Gemini pool blocks Carbon even when Claude pool is abundant
    const cidCarbonBlocked = 'conv_carbon_blk_3333';
    fs.writeFileSync(
      dirs.quotaStateFile,
      JSON.stringify({
        schema: 1,
        updatedAt: 500_000,
        claude: { fiveHourRemainingPct: 95, weeklyRemainingPct: 95 },
        gemini: { fiveHourRemainingPct: 10, weeklyRemainingPct: 80 },
      })
    );
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cidCarbonBlocked,
        cwd: REPO,
        modelName: 'Gemini 4 Hydrogen (Low)',
        toolCall: { name: 'edit_file', args: { Path: path.join(REPO, 'src/index.mjs') } },
      },
      hookOpts()
    );
    const cbBlocked = evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cidCarbonBlocked, modelName: 'Gemini 4 Hydrogen (Low)', terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 4, changedLines: 150, gitHighRisk: [], diffHash: 'hash_cb_blk' } })
    );
    assert.deepEqual(cbBlocked, {});
    const cbProp = readProposal(dirs, cidCarbonBlocked);
    assert.equal(cbProp?.reviewerModel, 'carbon');
    assert.equal(cbProp?.quotaPool, 'gemini');
    assert.equal(cbProp?.quotaBlocked, true);
  } finally {
    dirs.cleanup();
  }
});

test('per-conversation attribution, linked worktree .git file detection, parallel touch log & --clear baseline', () => {
  const dirs = makeTempDirs('og-attr-');
  const wtRoot = fs.realpathSync(fs.mkdtempSync(path.join(dirs.root, 'linked-wt-')));
  fs.writeFileSync(path.join(wtRoot, '.git'), 'gitdir: /tmp/fake-main/.git/worktrees/wt1\n');
  fs.mkdirSync(path.join(wtRoot, 'studio', 'core'), { recursive: true });
  fs.mkdirSync(path.join(wtRoot, 'src', '..foo'), { recursive: true });
  const kernelAbs = path.join(wtRoot, 'studio', 'core', 'kernel.mjs');
  const siblingDotAbs = path.join(wtRoot, 'src', '..foo', 'edge.mjs');
  const unrelatedAbs = path.join(wtRoot, 'studio', 'core', 'dom.mjs');
  fs.writeFileSync(kernelAbs, '// kernel\n');
  fs.writeFileSync(siblingDotAbs, '// sibling ..foo dir\n');
  fs.writeFileSync(unrelatedAbs, '// touched by someone else\n');

  const cidQa = 'conv_qa_isolated_1111';
  const cidWork = 'conv_work_parallel_2222';
  const hookOpts = (extra = {}) => ({
    stateDir: dirs.stateDir,
    studioPrefsFile: dirs.studioPrefsFile,
    quotaStateFile: dirs.quotaStateFile,
    proposalsDir: dirs.proposalsDir,
    pluginDataDir: dirs.pluginDataDir,
    now: 900_000,
    ...extra,
  });

  try {
    fs.writeFileSync(
      dirs.quotaStateFile,
      JSON.stringify({ schema: 1, updatedAt: 900_000, claude: { fiveHourRemainingPct: 90, weeklyRemainingPct: 88 } })
    );
    fs.writeFileSync(dirs.studioPrefsFile, JSON.stringify({ ...DEFAULT_STUDIO_PREFS, opusGateMode: 'auto' }));

    // Workspace has dirty files edited by another conversation; pure Q&A session must NOT fire!
    const sharedSummary = {
      gitRoot: wtRoot,
      changedAbsFiles: [kernelAbs, siblingDotAbs, unrelatedAbs],
      changedRelByAbs: {
        [kernelAbs]: 'studio/core/kernel.mjs',
        [siblingDotAbs]: 'src/..foo/edge.mjs',
        [unrelatedAbs]: 'studio/core/dom.mjs',
      },
      perFileLines: {
        [kernelAbs]: 30,
        [siblingDotAbs]: 15,
        [unrelatedAbs]: 95,
      },
      changedFiles: 3,
      changedLines: 140,
      gitHighRisk: ['studio/core/kernel.mjs', 'studio/core/dom.mjs'],
      diffHash: 'wt_diff_1',
    };

    assert.deepEqual(
      evaluateHookEvent(
        { hookEventName: 'Stop', conversationId: cidQa, cwd: wtRoot, terminationReason: 'NO_TOOL_CALL' },
        hookOpts({ gitSummary: sharedSummary })
      ),
      {}
    );
    assert.equal(fs.existsSync(proposalFile(dirs, cidQa)), false);

    // Parallel PostToolUse edits write to append-only <cid>.touched.log without dropping concurrent touches
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cidWork,
        cwd: REPO,
        toolCall: { name: 'edit_file', args: { Path: kernelAbs } },
      },
      hookOpts()
    );
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cidWork,
        cwd: REPO,
        toolCall: { name: 'edit_file', args: { Path: siblingDotAbs } },
      },
      hookOpts()
    );
    const touchLog = path.join(dirs.pluginDataDir, `${cidWork}.touched.log`);
    assert.equal(fs.existsSync(touchLog), true);

    // Clear removes proposal & snapshots risk/stop baseline so immediate post-review fix-ups do NOT re-fire
    const cleared = clearGateState(
      { cid: cidWork, dir: wtRoot },
      hookOpts({ gitSummary: sharedSummary })
    );
    assert.equal(cleared.ok, true);
    assert.equal(cleared.worktreeRoot, wtRoot);
    assert.equal(fs.existsSync(touchLog), false);

    // Same attributed set stays quiet after --clear
    assert.deepEqual(
      evaluateHookEvent(
        { hookEventName: 'Stop', conversationId: cidWork, cwd: REPO, terminationReason: 'NO_TOOL_CALL' },
        hookOpts({ gitSummary: sharedSummary })
      ),
      {}
    );

    // CLI `--clear` runs synchronously without blocking stdin and exits 0
    const cliClear = spawnSync(
      process.execPath,
      [
        path.join(REPO, 'studio', 'plugin', 'maga-opus-gate', 'hooks', 'gate-check.mjs'),
        '--clear',
        '--cid',
        cidWork,
        '--dir',
        wtRoot,
      ],
      {
        env: { ...process.env, ANTI_CLAUDE_STATE_DIR: dirs.stateDir },
        input: undefined,
        encoding: 'utf8',
        timeout: 3000,
      }
    );
    assert.equal(cliClear.status, 0, cliClear.stderr);
    const parsedClear = JSON.parse(String(cliClear.stdout || '').trim());
    assert.equal(parsedClear.ok, true);
    assert.equal(parsedClear.worktreeRoot, wtRoot);
  } finally {
    dirs.cleanup();
  }
});

test('opus-gate-pill renders generic label, supports per-click Carbon/Opus switch without mutating prefs, and submits /swarm only', { skip: skipDom }, async () => {
  const cid = 'conv_dom_123456';
  const dom = new JSDOM(
    `<!doctype html><html data-ag-ux-lang="zh-CN"><body>
      <div id="antigravity.agentSidePanelInputBox">
        <div data-lexical-editor="true"></div>
        <div class="agy-composer-footer">
          <div class="left-group"><span>anchor</span></div>
          <div class="right-group"></div>
        </div>
      </div>
    </body></html>`,
    { url: `http://127.0.0.1/c/${cid}` }
  );

  await withMockDom(dom, async () => {
    const rpcCalls = [];
    const submittedPrompts = [];
    const box = document.getElementById('antigravity.agentSidePanelInputBox');
    box.__reactFiber$test = {
      memoizedProps: {
        handleSubmit: (chunks) => {
          submittedPrompts.push(chunks?.[0]?.chunk?.value || '');
        },
      },
      return: null,
    };

    window.__agProjectCall = async (action, payload) => {
      rpcCalls.push({ action, payload });
      if (action === 'getOpusGateStatus') {
        return {
          ok: true,
          pluginInstalled: true,
          quotaState: {
            claude: { fiveHourRemainingPct: 12, weeklyRemainingPct: 64 },
            gemini: { fiveHourRemainingPct: 89, weeklyRemainingPct: 91 },
          },
          proposal: {
            kind: 'risk',
            reason: 'High-risk file changes (kernel.mjs)',
            diffHash: 'dom_hash_1',
            reviewerModel: 'opus',
            quotaPool: 'claude',
            recommendedTier: 'high',
            quotaBlocked: true,
            ts: Date.now(),
          },
        };
      }
      if (action === 'buildOpusHandoffBrief') {
        const model = payload.model === 'carbon' ? 'carbon' : 'opus';
        return {
          ok: true,
          kind: payload.kind || 'risk',
          reviewerModel: model,
          recommendedTier: 'high',
          recommendedModelId: model === 'carbon' ? 'gemini-4-carbon-high' : 'claude-opus-5-5-high',
          swarmPrompt: `[MAGA Review Gate · risk] model=${model}`,
        };
      }
      if (action === 'dismissOpusGateProposal') {
        return { ok: true };
      }
      return { ok: false };
    };

    const studioPrefs = createStudioPrefsRuntime({ initialPrefs: { opusGateMode: 'semi', opusGateModel: 'opus' } });
    const runtime = createOpusGatePillRuntime({ studioPrefs });
    try {
      assert.equal(typeof window.__agyOpusGateTrigger, 'function');
      runtime.sync();
      await tick(30);

      const pill = document.getElementById('agy-opus-gate-pill');
      assert.ok(pill, 'expected #agy-opus-gate-pill to be rendered');
      assert.equal(pill.getAttribute('data-maga-own'), '1');
      assert.equal(pill.getAttribute('data-reviewer-model'), 'opus');
      assert.equal(pill.getAttribute('data-quota-blocked'), '1');
      assert.equal(pill.querySelector('.agy-opus-label')?.textContent, '审查配额紧');

      // Live pref change to Carbon switches pill to live Gemini pool (89% >= 20% -> unblocked!)
      studioPrefs.patch({ opusGateModel: 'carbon' });
      assert.equal(pill.getAttribute('data-reviewer-model'), 'carbon');
      assert.equal(pill.getAttribute('data-quota-blocked'), '0');
      assert.equal(pill.querySelector('.agy-opus-label')?.textContent, '请求审查');
      studioPrefs.patch({ opusGateModel: 'opus' });

      const editor = box.querySelector('[data-lexical-editor="true"]');
      editor.textContent = 'draft text';
      runtime.sync();
      assert.equal(document.getElementById('agy-opus-gate-pill'), null);

      editor.textContent = '';
      runtime.sync();
      const restored = document.getElementById('agy-opus-gate-pill');
      assert.ok(restored);

      restored.querySelector('.agy-opus-go').click();
      const menu = document.getElementById('agy-opus-gate-menu');
      assert.ok(menu);
      assert.equal(menu.getAttribute('data-maga-own'), '1');
      assert.equal(menu.getAttribute('data-open'), '1');
      assert.equal(menu.getAttribute('data-reviewer-model'), 'opus');
      assert.equal(menu.querySelector('.agy-opus-menu-model')?.textContent, 'Opus High');
      assert.match(menu.querySelector('.agy-opus-menu-reason')?.textContent || '', /涉及高风险文件：kernel\.mjs/);
      const readQRows = () =>
        [...menu.querySelectorAll('.agy-opus-menu-qrow')].map((el) => [
          el.querySelector('.agy-opus-menu-qlbl')?.textContent || '',
          el.querySelector('.agy-opus-menu-qval')?.textContent || '',
        ]);
      assert.doesNotMatch(menu.querySelector('.agy-opus-menu-quota')?.textContent || '', /Claude/);
      assert.deepEqual(readQRows(), [['5h', '12%'], ['每周', '64%']]);
      assert.equal(menu.querySelector('button[data-agy-opus-action="handoff"]'), null);
      const swarmBtn = menu.querySelector('button[data-agy-opus-action="swarm"]');
      assert.ok(swarmBtn);
      assert.doesNotMatch(swarmBtn.textContent || '', /\/swarm/);

      // Per-click switch to Carbon High updates popover in-place WITHOUT mutating studioPrefs
      const carbonBtn = menu.querySelector('button[data-agy-opus-model="carbon"]');
      assert.ok(carbonBtn);
      carbonBtn.click();
      assert.equal(menu.getAttribute('data-reviewer-model'), 'carbon');
      assert.equal(menu.getAttribute('data-open'), '1');
      assert.equal(menu.querySelector('.agy-opus-menu-model')?.textContent, 'Carbon High');
      assert.doesNotMatch(menu.querySelector('.agy-opus-menu-quota')?.textContent || '', /Gemini/);
      assert.deepEqual(readQRows(), [['5h', '89%'], ['每周', '91%']]);
      assert.equal(studioPrefs.get().opusGateModel, 'opus');

      // Path A passes per-click model='carbon'
      menu.querySelector('button[data-agy-opus-action="swarm"]').click();
      await tick(30);

      assert.equal(submittedPrompts.length, 1);
      assert.match(submittedPrompts[0], /MAGA Review Gate.*model=carbon/);
      assert.ok(rpcCalls.some((c) => c.action === 'buildOpusHandoffBrief' && c.payload.model === 'carbon'));
      assert.ok(rpcCalls.some((c) => c.action === 'dismissOpusGateProposal'));
      assert.equal(document.getElementById('agy-opus-gate-pill'), null);

      studioPrefs.patch({ opusGateMode: 'off' });
      runtime.sync();
      window.__agyOpusGateTrigger('manual');
      assert.equal(document.getElementById('agy-opus-gate-menu')?.getAttribute('data-open'), null);
    } finally {
      runtime.dispose();
      studioPrefs.dispose();
    }
    assert.equal(window.__agyOpusGateTrigger, null);
  });
});

test('buildStudioBundle compiles Opus Gate runtime & settings views without global :has() CSS', async () => {
  const bundle = await buildStudioBundle();
  assert.match(bundle.jsBlock, /createOpusGatePillRuntime/);
  assert.match(bundle.jsBlock, /models-opus-gate/);
  assert.equal(/[^\n]*:has\s*\(/.test(bundle.cssBlock), false);
});

test('gate-check sentinel detects plan artifacts & exit_plan_mode in semi and auto modes', () => {
  const dirs = makeTempDirs('og-plan-');
  const cidSemi = 'conv_plan_semi_1234';
  const cidAuto = 'conv_plan_auto_5678';
  const hookOpts = (extra = {}) => ({
    stateDir: dirs.stateDir,
    studioPrefsFile: dirs.studioPrefsFile,
    quotaStateFile: dirs.quotaStateFile,
    proposalsDir: dirs.proposalsDir,
    pluginDataDir: dirs.pluginDataDir,
    now: 700_000,
    ...extra,
  });

  try {
    fs.writeFileSync(
      dirs.quotaStateFile,
      JSON.stringify({ schema: 1, updatedAt: 700_000, claude: { fiveHourRemainingPct: 82, weeklyRemainingPct: 75 } })
    );
    fs.writeFileSync(dirs.studioPrefsFile, JSON.stringify({ ...DEFAULT_STUDIO_PREFS, opusGateMode: 'semi' }));

    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cidSemi,
        cwd: REPO,
        toolCall: {
          name: 'write_file',
          args: { Path: path.join(REPO, 'implementation_plan.md'), Content: '# Plan v1\nStep 1' },
        },
      },
      hookOpts()
    );
    let prop = readProposal(dirs, cidSemi);
    assert.equal(prop?.kind, 'plan');
    assert.equal(prop?.source, 'hook');
    assert.deepEqual(prop?.planFiles, ['implementation_plan.md']);
    const hashV1 = prop?.diffHash;
    assert.ok(hashV1);

    // Deduplicated on Stop even if proposal file was removed
    fs.unlinkSync(proposalFile(dirs, cidSemi));
    assert.deepEqual(
      evaluateHookEvent(
        { hookEventName: 'Stop', conversationId: cidSemi, cwd: REPO, terminationReason: 'NO_TOOL_CALL' },
        hookOpts({ gitSummary: { gitRoot: REPO, changedAbsFiles: [], changedFiles: 0, changedLines: 0, gitHighRisk: [], diffHash: 'empty' } })
      ),
      {}
    );
    assert.equal(fs.existsSync(proposalFile(dirs, cidSemi)), false);

    // RequestFeedback artifact with updated body produces a new planHash and re-publishes
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cidSemi,
        toolCall: {
          name: 'write_file',
          args: {
            Path: '/tmp/artifacts/custom-notes.md',
            Content: '# Plan v2\nStep 2 revised',
            ArtifactMetadata: { RequestFeedback: true },
          },
        },
      },
      hookOpts()
    );
    prop = readProposal(dirs, cidSemi);
    assert.equal(prop?.kind, 'plan');
    assert.notEqual(prop?.diffHash, hashV1);

    // exit_plan_mode triggers plan proposal too
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cidSemi,
        toolCall: { name: 'exit_plan_mode', args: { plan: 'Ordered steps 1..4' } },
      },
      hookOpts()
    );
    prop = readProposal(dirs, cidSemi);
    assert.equal(prop?.kind, 'plan');
    assert.match(prop?.reason, /exit_plan_mode/);

    // Auto mode: write_file + Stop even when changedFiles === 0 returns decision='continue', then deduplicates
    fs.writeFileSync(dirs.studioPrefsFile, JSON.stringify({ ...DEFAULT_STUDIO_PREFS, opusGateMode: 'auto' }));
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cidAuto,
        cwd: REPO,
        toolCall: {
          name: 'write_file',
          args: { Path: path.join(REPO, 'docs/architecture-plan.md'), Content: '# Arch RFC' },
        },
      },
      hookOpts()
    );
    const autoStop = evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cidAuto, cwd: REPO, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { gitRoot: REPO, changedAbsFiles: [], changedFiles: 0, changedLines: 0, gitHighRisk: [], diffHash: 'empty' } })
    );
    assert.equal(autoStop.decision, 'continue');
    assert.match(autoStop.reason, /\[MAGA Review Gate · plan\]/);
    assert.match(autoStop.reason, /Plan artifacts: docs\/architecture-plan\.md/);
    assert.match(autoStop.reason, /Omit fork/);

    assert.deepEqual(
      evaluateHookEvent(
        { hookEventName: 'Stop', conversationId: cidAuto, cwd: REPO, terminationReason: 'NO_TOOL_CALL' },
        hookOpts({ gitSummary: { gitRoot: REPO, changedAbsFiles: [], changedFiles: 0, changedLines: 0, gitHighRisk: [], diffHash: 'empty' } })
      ),
      {}
    );

    const cidDisabled = 'conv_plan_off_9999';
    fs.writeFileSync(
      dirs.studioPrefsFile,
      JSON.stringify({
        ...DEFAULT_STUDIO_PREFS,
        opusGateMode: 'auto',
        opusGateCheckpoints: { ...DEFAULT_STUDIO_PREFS.opusGateCheckpoints, plan: false },
      })
    );
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: cidDisabled,
        toolCall: { name: 'exit_plan_mode', args: { plan: 'Should not trigger' } },
      },
      hookOpts()
    );
    assert.deepEqual(
      evaluateHookEvent(
        { hookEventName: 'Stop', conversationId: cidDisabled, terminationReason: 'NO_TOOL_CALL' },
        hookOpts({ gitSummary: { gitRoot: REPO, changedAbsFiles: [], changedFiles: 0, changedLines: 0, gitHighRisk: [], diffHash: 'empty' } })
      ),
      {}
    );
  } finally {
    dirs.cleanup();
  }
});

test('evaluatePreflight and --preflight CLI enforce mode, checkpoint switch, quota, dedup & cap', () => {
  const dirs = makeTempDirs('og-preflight-');
  const cid = 'conv_preflight_1234';
  const pfOpts = (extra = {}) => ({
    stateDir: dirs.stateDir,
    studioPrefsFile: dirs.studioPrefsFile,
    quotaStateFile: dirs.quotaStateFile,
    proposalsDir: dirs.proposalsDir,
    pluginDataDir: dirs.pluginDataDir,
    now: 800_000,
    ...extra,
  });

  try {
    fs.writeFileSync(
      dirs.quotaStateFile,
      JSON.stringify({ schema: 1, updatedAt: 800_000, claude: { fiveHourRemainingPct: 85, weeklyRemainingPct: 80 } })
    );

    assert.deepEqual(
      evaluatePreflight({ kind: 'plan', model: 'Claude Opus 5.5 (High)', cid }, pfOpts()),
      { action: 'skip', reason: 'already_self_or_higher', reviewerModel: 'opus' }
    );

    fs.writeFileSync(dirs.studioPrefsFile, JSON.stringify({ ...DEFAULT_STUDIO_PREFS, opusGateMode: 'auto', opusGateModel: 'carbon' }));
    assert.deepEqual(
      evaluatePreflight({ kind: 'plan', model: 'Gemini 4 Carbon (High)', cid }, pfOpts()),
      { action: 'skip', reason: 'already_self_or_higher', reviewerModel: 'carbon' }
    );
    assert.deepEqual(
      evaluatePreflight({ kind: 'plan', model: 'Claude Opus 5.5 (High)', cid }, pfOpts()),
      { action: 'skip', reason: 'already_self_or_higher', reviewerModel: 'carbon' }
    );

    fs.writeFileSync(dirs.studioPrefsFile, JSON.stringify({ ...DEFAULT_STUDIO_PREFS, opusGateMode: 'off' }));
    assert.deepEqual(evaluatePreflight({ kind: 'risk', cid }, pfOpts()), {
      action: 'skip',
      reason: 'mode_off',
      mode: 'off',
    });

    fs.writeFileSync(
      dirs.studioPrefsFile,
      JSON.stringify({
        ...DEFAULT_STUDIO_PREFS,
        opusGateMode: 'auto',
        opusGateCheckpoints: { ...DEFAULT_STUDIO_PREFS.opusGateCheckpoints, plan: false },
      })
    );
    assert.deepEqual(evaluatePreflight({ kind: 'plan', cid }, pfOpts()), {
      action: 'skip',
      reason: 'checkpoint_disabled',
      kind: 'plan',
      mode: 'auto',
    });

    fs.writeFileSync(dirs.studioPrefsFile, JSON.stringify({ ...DEFAULT_STUDIO_PREFS, opusGateMode: 'semi' }));
    const semi = evaluatePreflight(
      { kind: 'risk', reason: 'Lock ordering edge case', cid, files: 'src/queue.mjs,src/worker.mjs' },
      pfOpts()
    );
    assert.equal(semi.action, 'propose');
    assert.equal(semi.mode, 'semi');
    assert.equal(semi.proposalPublished, true);
    const prop = readProposal(dirs, cid);
    assert.equal(prop?.source, 'semantic');
    assert.equal(prop?.kind, 'risk');
    assert.deepEqual(prop?.highRiskFiles, ['src/queue.mjs', 'src/worker.mjs']);

    fs.writeFileSync(
      dirs.studioPrefsFile,
      JSON.stringify({
        ...DEFAULT_STUDIO_PREFS,
        opusGateMode: 'auto',
        opusGateMinQuota5hPct: 20,
        opusGateMaxAutoPerSession: 2,
      })
    );
    const run1 = evaluatePreflight(
      { kind: 'plan', reason: 'Multi-module plugin sync architecture', cid, files: 'docs/plan.md' },
      pfOpts()
    );
    assert.equal(run1.action, 'run_swarm');
    assert.equal(run1.recommendedTier, 'high');
    assert.equal(run1.recommendedModelId, 'claude-opus-5-5-high');
    assert.equal(run1.autoCallsUsed, 1);

    const dup = evaluatePreflight(
      { kind: 'plan', reason: 'Multi-module plugin sync architecture', cid, files: 'docs/plan.md' },
      pfOpts()
    );
    assert.deepEqual(dup, { action: 'skip', reason: 'already_audited', mode: 'auto', kind: 'plan' });

    fs.writeFileSync(
      dirs.quotaStateFile,
      JSON.stringify({
        schema: 1,
        updatedAt: 800_000,
        claude: { fiveHourRemainingPct: 25, weeklyRemainingPct: 70 },
        gemini: { fiveHourRemainingPct: 90, weeklyRemainingPct: 88 },
      })
    );
    const run2 = evaluatePreflight({ kind: 'debug', model: 'Gemini 4 Neon (High)', reason: 'Unexplained cache mismatch', cid }, pfOpts());
    assert.equal(run2.action, 'run_swarm');
    assert.equal(run2.recommendedTier, 'high');
    assert.equal(run2.recommendedModelId, 'claude-opus-5-5-high');
    assert.equal(run2.autoCallsUsed, 2);

    const capped = evaluatePreflight({ kind: 'stop', reason: 'Final sanity check', cid }, pfOpts());
    assert.equal(capped.action, 'propose');
    assert.equal(capped.mode, 'auto');
    assert.equal(capped.downgradedReason, 'auto_cap_reached');
    assert.equal(capped.proposalPublished, true);

    const cidQuota = 'conv_preflight_quota_999';
    fs.writeFileSync(
      dirs.quotaStateFile,
      JSON.stringify({ schema: 1, updatedAt: 800_000, claude: { fiveHourRemainingPct: 10, weeklyRemainingPct: 70 } })
    );
    const blocked = evaluatePreflight({ kind: 'risk', reason: 'Auth flow edit', cid: cidQuota }, pfOpts());
    assert.equal(blocked.action, 'propose');
    assert.equal(blocked.downgradedReason, 'quota_blocked');
    assert.equal(blocked.quotaBlocked, true);

    // Carbon preflight routes via Gemini pool even when Claude pool is low
    const cidPrefCarbon = 'conv_preflight_carbon_777';
    fs.writeFileSync(dirs.studioPrefsFile, JSON.stringify({ ...DEFAULT_STUDIO_PREFS, opusGateMode: 'auto', opusGateModel: 'carbon', opusGateMinQuota5hPct: 20 }));
    fs.writeFileSync(
      dirs.quotaStateFile,
      JSON.stringify({
        schema: 1,
        updatedAt: 800_000,
        claude: { fiveHourRemainingPct: 5, weeklyRemainingPct: 5 },
        gemini: { fiveHourRemainingPct: 85, weeklyRemainingPct: 80 },
      })
    );
    const runCarbon = evaluatePreflight({ kind: 'risk', model: 'Gemini 4 Neon (High)', reason: 'State machine edge', cid: cidPrefCarbon }, pfOpts());
    assert.equal(runCarbon.action, 'run_swarm');
    assert.equal(runCarbon.reviewerModel, 'carbon');
    assert.equal(runCarbon.workerName, 'review-carbon');
    assert.equal(runCarbon.quotaPool, 'gemini');
    assert.equal(runCarbon.recommendedTier, 'high');
    assert.equal(runCarbon.recommendedModelId, 'gemini-4-carbon-high');

    fs.writeFileSync(dirs.studioPrefsFile, JSON.stringify({ ...DEFAULT_STUDIO_PREFS, opusGateMode: 'semi' }));
    const cli = spawnSync(
      process.execPath,
      [
        path.join(REPO, 'studio', 'plugin', 'maga-opus-gate', 'hooks', 'gate-check.mjs'),
        '--preflight',
        '--kind',
        'plan',
        '--reason',
        'CLI preflight check',
        '--cid',
        'conv_cli_1234',
        '--files',
        'docs/plan.md',
      ],
      {
        env: { ...process.env, ANTI_CLAUDE_STATE_DIR: dirs.stateDir },
        input: undefined,
        encoding: 'utf8',
        timeout: 3000,
      }
    );
    assert.equal(cli.status, 0, cli.stderr);
    const parsedCli = JSON.parse(String(cli.stdout || '').trim());
    assert.equal(parsedCli.action, 'propose');
    assert.equal(parsedCli.mode, 'semi');
    assert.equal(parsedCli.kind, 'plan');
    assert.equal(parsedCli.proposalPublished, true);
  } finally {
    dirs.cleanup();
  }
});

test('syncOpusGatePlugin pins absolute Node executable, chmods hook, prunes stale files & verifies runtime', () => {
  const dirs = makeTempDirs('og-pin-');
  try {
    const staleFile = path.join(dirs.pluginsDir, 'maga-opus-gate', 'hooks', 'legacy-stale.mjs');
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, '// stale\n', 'utf8');

    const synced = syncOpusGatePlugin({}, { pluginsDir: dirs.pluginsDir, nodeExecPath: process.execPath });
    assert.equal(synced.ok, true);
    assert.equal(synced.pinned, true);
    assert.equal(synced.installed, true);
    assert.equal(fs.existsSync(staleFile), false, 'stale orphaned plugin file pruned on sync');

    const syncedHooks = JSON.parse(fs.readFileSync(path.join(dirs.pluginsDir, 'maga-opus-gate', 'hooks.json'), 'utf8'));
    const repoHooks = JSON.parse(fs.readFileSync(path.join(REPO, 'studio', 'plugin', 'maga-opus-gate', 'hooks.json'), 'utf8'));
    assert.equal(repoHooks['maga-opus-gate'].Stop[0].command, 'node ./hooks/gate-check.mjs');
    assert.ok(syncedHooks['maga-opus-gate'].Stop[0].command.includes(process.execPath));
    assert.ok(syncedHooks['maga-opus-gate'].PostToolUse[0].hooks[0].command.includes(process.execPath));

    const hookStat = fs.statSync(path.join(dirs.pluginsDir, 'maga-opus-gate', 'hooks', 'gate-check.mjs'));
    assert.ok((hookStat.mode & 0o111) !== 0, 'gate-check.mjs must be executable');

    const runtimeCheck = verifyOpusGateHookNodeRuntime({ pluginsDir: dirs.pluginsDir });
    assert.equal(runtimeCheck.ok, true);
    assert.equal(runtimeCheck.pinned, true);
  } finally {
    dirs.cleanup();
  }
});
