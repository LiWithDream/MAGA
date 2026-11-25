import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  getOpusGateStatus,
  dismissOpusGateProposal,
  buildOpusHandoffBrief,
} = await import('../studio/daemon/opus-gate-service.mjs');
const { evaluateHookEvent } = await import('../studio/plugin/maga-opus-gate/hooks/gate-check.mjs');
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
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(pluginDataDir, { recursive: true });
  return {
    root,
    stateDir,
    pluginsDir,
    pluginDataDir,
    studioPrefsFile: path.join(stateDir, 'studio-prefs.json'),
    quotaStateFile: path.join(stateDir, 'quota-state.json'),
    gateStateFile: path.join(stateDir, 'opus-gate-state.json'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
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

test('prefs defaults and sanitization handle Opus Gate fields and bounds', () => {
  assert.equal(DEFAULT_STUDIO_PREFS.opusGateMode, 'semi');
  assert.equal(DEFAULT_STUDIO_PREFS.opusGatePreferredTier, 'high');
  assert.equal(DEFAULT_STUDIO_PREFS.opusGateMinQuota5hPct, 20);
  assert.equal(DEFAULT_STUDIO_PREFS.opusGateMinQuotaWeeklyPct, 15);
  assert.equal(DEFAULT_STUDIO_PREFS.opusGateMaxAutoPerSession, 2);
  assert.deepEqual(DEFAULT_STUDIO_PREFS.opusGateCheckpoints, {
    plan: true,
    risk: true,
    debug: true,
    stop: true,
  });

  const clamped = sanitizeStudioPrefs({
    opusGateMode: 'bogus',
    opusGatePreferredTier: 'ultra',
    opusGateMinQuota5hPct: 1,
    opusGateMinQuotaWeeklyPct: 99,
    opusGateMaxAutoPerSession: 12,
    opusGateCheckpoints: { plan: false, stop: 'yes' },
  });
  assert.equal(clamped.opusGateMode, 'semi');
  assert.equal(clamped.opusGatePreferredTier, 'high');
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
    opusGatePreferredTier: 'medium',
    opusGateMinQuota5hPct: 35,
    opusGateMinQuotaWeeklyPct: 25,
    opusGateMaxAutoPerSession: 3,
    opusGateCheckpoints: { plan: true, risk: false, debug: true, stop: false },
  });
  assert.equal(valid.opusGateMode, 'auto');
  assert.equal(valid.opusGatePreferredTier, 'medium');
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
    rt.patch({ opusGateMode: 'auto', opusGateCheckpoints: { debug: false } });
    assert.equal(rt.get().opusGateMode, 'auto');
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

test('opus-gate-service persists quota, syncs/removes plugin, manages proposals, and builds briefs', async () => {
  const dirs = makeTempDirs();
  try {
    const saved = saveQuotaState(
      {
        tierName: 'AI Ultra',
        claude: { fiveHourRemainingPct: 120, weeklyRemainingPct: 48.34, fiveHourResetSec: 1200 },
        gemini: { fiveHourRemainingPct: -5, weeklyRemainingPct: 90 },
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

    assert.equal(isOpusGatePluginInstalled({ pluginsDir: dirs.pluginsDir }), false);
    const synced = syncOpusGatePlugin({}, { pluginsDir: dirs.pluginsDir });
    assert.equal(synced.ok, true);
    assert.equal(synced.installed, true);
    assert.ok(synced.files.includes('plugin.json'));
    assert.ok(synced.files.includes('hooks.json'));
    assert.ok(synced.files.includes('skills/opus-gate/SKILL.md'));
    assert.equal(isOpusGatePluginInstalled({ pluginsDir: dirs.pluginsDir }), true);

    const cid = 'conv_service_123456';
    fs.writeFileSync(
      dirs.gateStateFile,
      JSON.stringify({
        schema: 1,
        conversations: {
          [cid]: {
            kind: 'risk',
            reason: 'High-risk file changes (studio/core/kernel.mjs)',
            diffHash: 'abc123def456',
            highRiskFiles: ['studio/core/kernel.mjs'],
            recommendedTier: 'high',
            ts: 100_000,
            dismissed: false,
          },
        },
      })
    );

    const active = getOpusGateStatus(
      { cascadeId: cid },
      {
        pluginsDir: dirs.pluginsDir,
        quotaStateFile: dirs.quotaStateFile,
        gateStateFile: dirs.gateStateFile,
        now: 120_000,
      }
    );
    assert.equal(active.ok, true);
    assert.equal(active.pluginInstalled, true);
    assert.equal(active.proposal?.kind, 'risk');

    const expired = getOpusGateStatus(
      { cascadeId: cid },
      {
        pluginsDir: dirs.pluginsDir,
        quotaStateFile: dirs.quotaStateFile,
        gateStateFile: dirs.gateStateFile,
        now: 100_000 + 31 * 60 * 1000,
      }
    );
    assert.equal(expired.proposal, null);

    const briefHigh = await buildOpusHandoffBrief(
      { cascadeId: cid, dirPath: REPO, note: 'Check observer isolation' },
      {
        studioPrefs: { ...DEFAULT_STUDIO_PREFS, opusGatePreferredTier: 'high', opusGateMinQuota5hPct: 20 },
        quotaStateFile: dirs.quotaStateFile,
        gateStateFile: dirs.gateStateFile,
      }
    );
    assert.equal(briefHigh.ok, true);
    assert.equal(briefHigh.recommendedTier, 'high');
    assert.equal(briefHigh.recommendedModelId, 'claude-opus-5-5-high');
    assert.match(briefHigh.swarmPrompt, /opus-gate/);
    assert.match(briefHigh.swarmPrompt, /swarm/);
    assert.match(briefHigh.handoffPrompt, /APPROVE/);
    assert.match(briefHigh.handoffPrompt, /Check observer isolation/);

    saveQuotaState(
      { claude: { fiveHourRemainingPct: 25, weeklyRemainingPct: 50 } },
      { quotaStateFile: dirs.quotaStateFile }
    );
    fs.writeFileSync(
      dirs.gateStateFile,
      JSON.stringify({ schema: 1, conversations: {} })
    );
    const briefDowngraded = await buildOpusHandoffBrief(
      { cascadeId: cid, kind: 'stop' },
      {
        studioPrefs: { ...DEFAULT_STUDIO_PREFS, opusGatePreferredTier: 'high', opusGateMinQuota5hPct: 20 },
        quotaStateFile: dirs.quotaStateFile,
        gateStateFile: dirs.gateStateFile,
      }
    );
    assert.equal(briefDowngraded.recommendedTier, 'medium');
    assert.equal(briefDowngraded.recommendedModelId, 'claude-opus-5-5-medium');

    const dis = dismissOpusGateProposal({ cascadeId: cid, diffHash: 'abc123def456' }, { gateStateFile: dirs.gateStateFile });
    assert.equal(dis.ok, true);
    const afterDismiss = getOpusGateStatus(
      { cascadeId: cid },
      { pluginsDir: dirs.pluginsDir, quotaStateFile: dirs.quotaStateFile, gateStateFile: dirs.gateStateFile, now: 120_000 }
    );
    assert.equal(afterDismiss.proposal, null);

    const removed = syncOpusGatePlugin({ remove: true }, { pluginsDir: dirs.pluginsDir });
    assert.equal(removed.ok, true);
    assert.equal(removed.installed, false);
    assert.equal(isOpusGatePluginInstalled({ pluginsDir: dirs.pluginsDir }), false);
  } finally {
    dirs.cleanup();
  }
});

test('gate-check sentinel enforces self-skip, error streak, risk/stop triggers, auto cap, diffHash dedup, and quota breaker', () => {
  const dirs = makeTempDirs('og-hook-');
  const cid = 'conv_hook_987654';
  const hookOpts = (extra = {}) => ({
    stateDir: dirs.stateDir,
    studioPrefsFile: dirs.studioPrefsFile,
    quotaStateFile: dirs.quotaStateFile,
    gateStateFile: dirs.gateStateFile,
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

    // 1. Self-recursion skip when current agent is already Opus
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

    // 2. PostToolUse consecutive command error tracking -> debug proposal after 2 errors -> reset on success
    evaluateHookEvent(
      { hookEventName: 'PostToolUse', conversationId: cid, toolCall: { name: 'run_command' }, error: 'ENOENT step 1' },
      hookOpts()
    );
    assert.equal(fs.existsSync(dirs.gateStateFile), false);

    evaluateHookEvent(
      { hookEventName: 'PostToolUse', conversationId: cid, toolCall: { name: 'run_command' }, error: 'ENOENT step 2' },
      hookOpts()
    );
    let gate = JSON.parse(fs.readFileSync(dirs.gateStateFile, 'utf8'));
    assert.equal(gate.conversations[cid]?.kind, 'debug');
    assert.equal(gate.conversations[cid]?.consecutiveErrors, 2);

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

    // 4. Semi mode publishes risk proposal & deduplicates same diffHash
    const semiRes = evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 1, changedLines: 12, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'hash_risk_1' } })
    );
    assert.deepEqual(semiRes, {});
    gate = JSON.parse(fs.readFileSync(dirs.gateStateFile, 'utf8'));
    assert.equal(gate.conversations[cid]?.kind, 'risk');
    assert.equal(gate.conversations[cid]?.recommendedTier, 'high');

    // Mutate file manually to confirm dedup does not rewrite same diffHash
    fs.unlinkSync(dirs.gateStateFile);
    evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 1, changedLines: 12, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'hash_risk_1' } })
    );
    assert.equal(fs.existsSync(dirs.gateStateFile), false);

    // 5. Auto mode continues with swarm instructions up to maxAutoPerSession=2 and downgrades on tight 5h quota
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
    assert.match(auto1.reason, /Claude Opus \(high\)/);
    assert.match(auto1.reason, /opus-gate/);

    // Same diffHash should not auto-continue again
    assert.deepEqual(
      evaluateHookEvent(
        { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
        hookOpts({ gitSummary: { changedFiles: 1, changedLines: 20, gitHighRisk: ['studio/core/kernel.mjs'], diffHash: 'hash_auto_1' } })
      ),
      {}
    );

    // Drop 5h quota to 25% (between 20 and 35 -> healthy but downgrade to medium)
    fs.writeFileSync(
      dirs.quotaStateFile,
      JSON.stringify({ schema: 1, updatedAt: 500_000, claude: { fiveHourRemainingPct: 25, weeklyRemainingPct: 60 } })
    );
    const auto2 = evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 4, changedLines: 180, gitHighRisk: [], diffHash: 'hash_auto_2' } })
    );
    assert.equal(auto2.decision, 'continue');
    assert.match(auto2.reason, /Claude Opus \(medium\)/);

    // 3rd call hits maxAutoPerSession=2 -> falls back to non-blocking proposal
    const auto3 = evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 5, changedLines: 220, gitHighRisk: [], diffHash: 'hash_auto_3' } })
    );
    assert.deepEqual(auto3, {});
    gate = JSON.parse(fs.readFileSync(dirs.gateStateFile, 'utf8'));
    assert.equal(gate.conversations[cid]?.kind, 'risk');

    // 6. Quota circuit breaker on fresh conversation when claude5hPct < minQuota5hPct
    const cidBreaker = 'conv_breaker_1111';
    fs.writeFileSync(
      dirs.quotaStateFile,
      JSON.stringify({ schema: 1, updatedAt: 500_000, claude: { fiveHourRemainingPct: 12, weeklyRemainingPct: 60 } })
    );
    const blockedRes = evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: cidBreaker, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({ gitSummary: { changedFiles: 4, changedLines: 140, gitHighRisk: [], diffHash: 'hash_brk_1' } })
    );
    assert.deepEqual(blockedRes, {});
    gate = JSON.parse(fs.readFileSync(dirs.gateStateFile, 'utf8'));
    assert.equal(gate.conversations[cidBreaker]?.quotaBlocked, true);
  } finally {
    dirs.cleanup();
  }
});

test('opus-gate-pill renders proposal, opens dual-path menu, submits Path A swarm, and cleans up on dispose', { skip: skipDom }, async () => {
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
          quotaState: { claude: { fiveHourRemainingPct: 72, weeklyRemainingPct: 64 } },
          proposal: {
            kind: 'risk',
            reason: 'High-risk file changes (kernel.mjs)',
            diffHash: 'dom_hash_1',
            recommendedTier: 'high',
            quotaBlocked: false,
            ts: Date.now(),
          },
        };
      }
      if (action === 'buildOpusHandoffBrief') {
        return {
          ok: true,
          kind: payload.kind || 'risk',
          recommendedTier: 'high',
          recommendedModelId: 'claude-opus-5-5-high',
          swarmPrompt: '[MAGA Opus Gate · risk] swarm prompt body',
          handoffPrompt: 'handoff prompt body',
        };
      }
      if (action === 'dismissOpusGateProposal') {
        return { ok: true };
      }
      return { ok: false };
    };

    const studioPrefs = createStudioPrefsRuntime({ initialPrefs: { opusGateMode: 'semi' } });
    const runtime = createOpusGatePillRuntime({ studioPrefs });
    try {
      assert.equal(typeof window.__agyOpusGateTrigger, 'function');
      runtime.sync();
      await tick(30);

      const pill = document.getElementById('agy-opus-gate-pill');
      assert.ok(pill, 'expected #agy-opus-gate-pill to be rendered');
      assert.equal(pill.getAttribute('data-maga-own'), '1');

      // Hides while composer has unsent draft text
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
      assert.ok(menu.querySelector('button[data-agy-opus-action="swarm"]'));
      assert.ok(menu.querySelector('button[data-agy-opus-action="handoff"]'));

      menu.querySelector('button[data-agy-opus-action="swarm"]').click();
      await tick(30);

      assert.equal(submittedPrompts.length, 1);
      assert.match(submittedPrompts[0], /MAGA Opus Gate/);
      assert.ok(rpcCalls.some((c) => c.action === 'dismissOpusGateProposal'));
      assert.equal(document.getElementById('agy-opus-gate-pill'), null);

      // Turns off cleanly when opusGateMode switches to off
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
