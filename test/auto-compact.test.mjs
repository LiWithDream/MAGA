import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERMETIC_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-auto-compact-test-'));
process.env.ANTI_CLAUDE_STATE_DIR = HERMETIC_STATE;
process.on('exit', () => {
  try {
    fs.rmSync(HERMETIC_STATE, { recursive: true, force: true });
  } catch {}
});

const { DEFAULT_STUDIO_PREFS, sanitizeStudioPrefs } = await import('../core/daemon/prefs-bundle.mjs');
const { createStudioPrefsRuntime } = await import('../studio/modules/studio-prefs.mjs');
const {
  AUTO_COMPACT_REQUEST_TTL_MS,
  AUTO_COMPACT_LEASE_TTL_MS,
  syncAutoCompactPlugin,
  isAutoCompactPluginInstalled,
  getAutoCompactStatus,
  claimAutoCompactRequest,
  commitAutoCompactRequest,
  releaseAutoCompactRequest,
  dismissAutoCompactRequest,
  writeAutoCompactRequest,
  readAutoCompactRequest,
  withRequestLock,
  verifyInstalledHookNodeRuntime,
  verifyLiveScheduleStepDecoder,
  handleAutoCompactRpc,
} = await import('../studio/daemon/auto-compact-service.mjs');
const {
  estimateCronIntervalSec,
  parseScheduleStepPayload,
  readConversationContextSnapshot,
  evaluateCompactHookEvent,
  requestAutoCompact,
  clearCompactState,
} = await import('../studio/plugin/maga-auto-compact/hooks/compact-check.mjs');
const { createAutoCompactRuntime } = await import('../studio/modules/auto-compact.mjs');
const { buildStudioBundle, buildUserCustomJs } = await import('../studio/build.mjs');

let JSDOM = null;
try {
  JSDOM = createRequire(process.env.JSDOM_FROM || import.meta.url)('jsdom').JSDOM;
} catch {}
const skipDom = JSDOM ? false : 'jsdom not installed';

/* ---- Minimal Protobuf Wire Encoder for Hermetic SQLite Fixtures ---- */

function encodeVarint(n) {
  const bytes = [];
  let v = Number(n) || 0;
  if (v < 0) v = 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function pbVarint(fieldNo, val) {
  return Buffer.concat([encodeVarint(fieldNo * 8), encodeVarint(val)]);
}

function pbBytes(fieldNo, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return Buffer.concat([encodeVarint(fieldNo * 8 + 2), encodeVarint(buf.length), buf]);
}

function encodeScheduleStepPayload(toolName, argsObj) {
  const f4 = Buffer.concat([
    pbBytes(1, 'call_sched_1'),
    pbBytes(2, toolName),
    pbBytes(3, JSON.stringify(argsObj)),
  ]);
  const f5 = pbBytes(4, f4);
  return pbBytes(5, f5);
}

function encodeGenMetadataRow({ inTok = 0, cacheRead = 0, outTok = 100, maxCtx = 256000 }) {
  const usage = Buffer.concat([pbVarint(2, inTok), pbVarint(3, outTok), pbVarint(5, cacheRead)]);
  const ctxWin = pbVarint(4, maxCtx);
  const chatStart = pbBytes(10, ctxWin);
  const chat = Buffer.concat([pbBytes(4, usage), pbBytes(9, chatStart)]);
  return pbBytes(1, chat);
}

function encodeTrajectoryMeta({ parentId = '', rootId = '' }) {
  const parts = [];
  if (parentId) parts.push(pbBytes(5, parentId));
  if (rootId) parts.push(pbBytes(6, rootId));
  return Buffer.concat(parts);
}

function createFixtureDb(conversationsDir, cid, { steps = [], genRows = [], trajMeta = null } = {}) {
  fs.mkdirSync(conversationsDir, { recursive: true });
  const dbPath = path.join(conversationsDir, `${cid}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE steps (
      idx INTEGER PRIMARY KEY,
      step_type INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 0,
      step_payload BLOB
    );
    CREATE TABLE gen_metadata (
      idx INTEGER PRIMARY KEY,
      data BLOB
    );
    CREATE TABLE trajectory_metadata_blob (
      id TEXT PRIMARY KEY DEFAULT 'main',
      data BLOB
    );
  `);
  const insStep = db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)');
  for (const s of steps) {
    insStep.run(s.idx, s.step_type, s.status, s.step_payload || null);
  }
  const insGen = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
  for (const g of genRows) {
    insGen.run(g.idx, g.data);
  }
  if (trajMeta) {
    db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', trajMeta);
  }
  db.close();
  return dbPath;
}

function makeTempDirs(prefix = 'ac-unit-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const pluginDataDir = path.join(root, 'plugin-data');
  const requestsDir = path.join(stateDir, 'auto-compact-requests');
  const conversationsDir = path.join(root, 'conversations');
  const userConfigFile = path.join(stateDir, 'user', 'config.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(pluginDataDir, { recursive: true });
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(conversationsDir, { recursive: true });
  return {
    root,
    stateDir,
    pluginsDir,
    pluginDataDir,
    requestsDir,
    conversationsDir,
    userConfigFile,
    studioPrefsFile: path.join(stateDir, 'studio-prefs.json'),
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

test('prefs defaults and sanitization handle Auto-Compact fields and bounds', () => {
  assert.equal(DEFAULT_STUDIO_PREFS.autoCompactMode, 'semi');
  assert.equal(DEFAULT_STUDIO_PREFS.autoCompactThresholdPct, 50);
  assert.equal(DEFAULT_STUDIO_PREFS.autoCompactMinWaitSec, 300);
  assert.equal(DEFAULT_STUDIO_PREFS.autoCompactHighWaterPct, 0);
  assert.deepEqual(DEFAULT_STUDIO_PREFS.autoCompactTriggers, {
    longTimer: true,
    modelRequest: true,
    highWater: false,
  });

  const clean = sanitizeStudioPrefs({
    autoCompactMode: 'bogus',
    autoCompactThresholdPct: 999,
    autoCompactMinWaitSec: 5,
    autoCompactHighWaterPct: 50,
    autoCompactTriggers: { longTimer: false, modelRequest: 'invalid', highWater: true },
  });
  assert.equal(clean.autoCompactMode, 'semi');
  assert.equal(clean.autoCompactThresholdPct, 85);
  assert.equal(clean.autoCompactMinWaitSec, 60);
  assert.equal(clean.autoCompactHighWaterPct, 65);
  assert.deepEqual(clean.autoCompactTriggers, {
    longTimer: false,
    modelRequest: true,
    highWater: true,
  });

  const hwZero = sanitizeStudioPrefs({ autoCompactHighWaterPct: 0 });
  assert.equal(hwZero.autoCompactHighWaterPct, 0);

  const rt = createStudioPrefsRuntime({
    initialPrefs: { autoCompactMode: 'auto', autoCompactThresholdPct: 45, autoCompactHighWaterPct: 80 },
  });
  assert.equal(rt.get().autoCompactMode, 'auto');
  assert.equal(rt.get().autoCompactThresholdPct, 45);
  assert.equal(rt.get().autoCompactHighWaterPct, 80);
  rt.dispose();
});

test('estimateCronIntervalSec handles standard, wrap-around, and invalid cron expressions', () => {
  assert.equal(estimateCronIntervalSec('* * * * *'), 60);
  assert.equal(estimateCronIntervalSec('*/3 * * * *'), 180);
  assert.equal(estimateCronIntervalSec('*/5 * * * *'), 300);
  assert.equal(estimateCronIntervalSec('*/7 * * * *'), 240); // wrap-around 56 -> 60 (4 min)
  assert.equal(estimateCronIntervalSec('*/10 * * * *'), 600);
  assert.equal(estimateCronIntervalSec('0,30 * * * *'), 1800);
  assert.equal(estimateCronIntervalSec('0 * * * *'), 3600);
  assert.equal(estimateCronIntervalSec('0 */2 * * *'), 7200);
  assert.equal(estimateCronIntervalSec('0 9 * * *'), 86400);
  assert.equal(estimateCronIntervalSec('bad cron'), 0);
  assert.equal(estimateCronIntervalSec('75 * * * *'), 0);
  assert.equal(estimateCronIntervalSec(''), 0);
});

test('SQLite decoder reads active schedule timers, child exclusion, checkpoints & malformed blobs fail-safely', () => {
  const dirs = makeTempDirs('ac-sqlite-');
  try {
    // 1. Corrupt step_payload fails safely without throwing
    assert.equal(parseScheduleStepPayload(Buffer.from([0xff, 0xff, 0x00])), null);
    assert.equal(parseScheduleStepPayload(encodeScheduleStepPayload('run_command', { CommandLine: 'ls' })), null);

    // 2. Normal conversation with active 10m timer (case-insensitive keys) + 55% ctx
    const cidMain = '11111111-1111-4111-8111-111111111111';
    createFixtureDb(dirs.conversationsDir, cidMain, {
      steps: [
        { idx: 0, step_type: 14, status: 3 },
        { idx: 1, step_type: 15, status: 3 },
        {
          idx: 2,
          step_type: 132,
          status: 2,
          step_payload: encodeScheduleStepPayload('schedule', {
            durationSeconds: 600,
            timerCondition: 'NEVER',
            prompt: 'Wake up check',
          }),
        },
        { idx: 3, step_type: 15, status: 3 },
      ],
      genRows: [{ idx: 0, data: encodeGenMetadataRow({ inTok: 10_000, cacheRead: 130_800, maxCtx: 256_000 }) }],
      trajMeta: encodeTrajectoryMeta({ rootId: cidMain }),
    });
    const snapMain = readConversationContextSnapshot(cidMain, dirs);
    assert.equal(snapMain?.isChild, false);
    assert.equal(snapMain?.alreadyCompacted, false);
    assert.equal(snapMain?.ctx, 140_800);
    assert.equal(snapMain?.ctxPct, 55);
    assert.equal(snapMain?.activeTimer?.waitSec, 600);
    assert.equal(snapMain?.activeTimer?.kind, 'timer');

    // Verify doctor decoder sees verified schedule rows
    const docCheck = verifyLiveScheduleStepDecoder(dirs.conversationsDir);
    assert.equal(docCheck.status, 'verified');
    assert.ok(docCheck.scheduleRows >= 1);

    // 3. Child conversation excluded by parentId / mismatched rootId
    const cidChild = '22222222-2222-4222-8222-222222222222';
    createFixtureDb(dirs.conversationsDir, cidChild, {
      steps: [
        { idx: 0, step_type: 14, status: 3 },
        {
          idx: 1,
          step_type: 132,
          status: 2,
          step_payload: encodeScheduleStepPayload('schedule', { DurationSeconds: 600 }),
        },
      ],
      genRows: [{ idx: 0, data: encodeGenMetadataRow({ inTok: 150_000, cacheRead: 0, maxCtx: 256_000 }) }],
      trajMeta: encodeTrajectoryMeta({ parentId: cidMain, rootId: cidMain }),
    });
    assert.equal(readConversationContextSnapshot(cidChild, dirs)?.isChild, true);

    // 4. Active CHECKPOINT after lastPlannerIdx -> alreadyCompacted; failed CHECKPOINT (status=4) does NOT block
    const cidCp = '33333333-3333-4333-8333-333333333333';
    createFixtureDb(dirs.conversationsDir, cidCp, {
      steps: [
        { idx: 0, step_type: 14, status: 3 },
        { idx: 1, step_type: 15, status: 3 },
        { idx: 2, step_type: 23, status: 3 },
      ],
      genRows: [{ idx: 0, data: encodeGenMetadataRow({ inTok: 200_000, cacheRead: 0, maxCtx: 256_000 }) }],
    });
    assert.equal(readConversationContextSnapshot(cidCp, dirs)?.alreadyCompacted, true);

    const cidFailedCp = '44444444-4444-4444-8444-444444444444';
    createFixtureDb(dirs.conversationsDir, cidFailedCp, {
      steps: [
        { idx: 0, step_type: 14, status: 3 },
        {
          idx: 1,
          step_type: 132,
          status: 2,
          step_payload: encodeScheduleStepPayload('schedule', { CronExpression: '*/10 * * * *' }),
        },
        { idx: 2, step_type: 15, status: 3 },
        { idx: 3, step_type: 23, status: 4 }, // summarization failed
      ],
      genRows: [{ idx: 0, data: encodeGenMetadataRow({ inTok: 160_000, cacheRead: 0, maxCtx: 256_000 }) }],
    });
    const failedSnap = readConversationContextSnapshot(cidFailedCp, dirs);
    assert.equal(failedSnap?.alreadyCompacted, false);
    assert.equal(failedSnap?.activeTimer?.waitSec, 600);

    // 5. Older recurring cron (idx=1) created BEFORE an earlier CHECKPOINT (idx=3) still applies once new planner work grows context
    const cidRecurring = '55555555-5555-4555-8555-555555555555';
    createFixtureDb(dirs.conversationsDir, cidRecurring, {
      steps: [
        { idx: 0, step_type: 14, status: 3 },
        {
          idx: 1,
          step_type: 132,
          status: 2,
          step_payload: encodeScheduleStepPayload('schedule', { CronExpression: '*/10 * * * *' }),
        },
        { idx: 2, step_type: 15, status: 3 },
        { idx: 3, step_type: 23, status: 3 },
        { idx: 4, step_type: 15, status: 3 },
      ],
      genRows: [{ idx: 0, data: encodeGenMetadataRow({ inTok: 150_000, cacheRead: 0, maxCtx: 256_000 }) }],
    });
    const recSnap = readConversationContextSnapshot(cidRecurring, dirs);
    assert.equal(recSnap?.alreadyCompacted, false);
    assert.equal(recSnap?.activeTimer?.waitSec, 600);
  } finally {
    dirs.cleanup();
  }
});

test('evaluateCompactHookEvent enforces triggers, opus-gate continuation refresh, lease guard, anti-loop & CLI', () => {
  const dirs = makeTempDirs('ac-hook-');
  const cid = 'conv_hook_test_1234';
  const hookOpts = (extra = {}) => ({
    stateDir: dirs.stateDir,
    studioPrefsFile: dirs.studioPrefsFile,
    requestsDir: dirs.requestsDir,
    pluginDataDir: dirs.pluginDataDir,
    conversationsDir: dirs.conversationsDir,
    userConfigFile: dirs.userConfigFile,
    now: 1_000_000,
    ...extra,
  });

  try {
    // 1. Off mode -> no-op
    fs.writeFileSync(dirs.studioPrefsFile, JSON.stringify({ ...DEFAULT_STUDIO_PREFS, autoCompactMode: 'off' }));
    evaluateCompactHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({
        ctxSnapshot: { isChild: false, alreadyCompacted: false, ctxPct: 75, ctx: 192000, limit: 256000, lastGenIdx: 5, activeTimer: { waitSec: 600, kind: 'timer' } },
      })
    );
    assert.equal(fs.existsSync(path.join(dirs.requestsDir, `${cid}.json`)), false);

    // 2. Short timer or low context -> no-op; child -> no-op
    fs.writeFileSync(dirs.studioPrefsFile, JSON.stringify({ ...DEFAULT_STUDIO_PREFS, autoCompactMode: 'auto' }));
    evaluateCompactHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({
        ctxSnapshot: { isChild: false, alreadyCompacted: false, ctxPct: 70, ctx: 180000, limit: 256000, lastGenIdx: 5, activeTimer: { waitSec: 120, kind: 'timer' } },
      })
    );
    assert.equal(fs.existsSync(path.join(dirs.requestsDir, `${cid}.json`)), false);

    evaluateCompactHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({
        ctxSnapshot: { isChild: false, alreadyCompacted: false, ctxPct: 35, ctx: 90000, limit: 256000, lastGenIdx: 5, activeTimer: { waitSec: 600, kind: 'timer' } },
      })
    );
    assert.equal(fs.existsSync(path.join(dirs.requestsDir, `${cid}.json`)), false);

    evaluateCompactHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({
        ctxSnapshot: { isChild: true, alreadyCompacted: false, ctxPct: 85, ctx: 220000, limit: 256000, lastGenIdx: 5, activeTimer: { waitSec: 600, kind: 'timer' } },
      })
    );
    assert.equal(fs.existsSync(path.join(dirs.requestsDir, `${cid}.json`)), false);

    // 3. Opus Gate Stop #1 followed by continuationActive=true Stop #2 overwrites with fresher genIdx/ctxPct
    evaluateCompactHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL', continuationActive: false },
      hookOpts({
        now: 1_000_000,
        ctxSnapshot: { isChild: false, alreadyCompacted: false, ctxPct: 54, ctx: 138000, limit: 256000, lastGenIdx: 10, activeTimer: { waitSec: 600, kind: 'timer' } },
      })
    );
    const req1 = readAutoCompactRequest(cid, dirs);
    assert.equal(req1?.kind, 'long_timer');
    assert.equal(req1?.genIdx, 10);
    assert.equal(req1?.ctxPct, 54);

    evaluateCompactHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL', continuationActive: true },
      hookOpts({
        now: 1_015_000, // 15s later (< 120s cooldown) during Opus continuation
        ctxSnapshot: { isChild: false, alreadyCompacted: false, ctxPct: 58, ctx: 148000, limit: 256000, lastGenIdx: 14, activeTimer: { waitSec: 600, kind: 'timer' } },
      })
    );
    const req2 = readAutoCompactRequest(cid, dirs);
    assert.equal(req2?.genIdx, 14);
    assert.equal(req2?.ctxPct, 58);

    // 4. Refresh skips when an active claim lease exists (prevents commit CAS mismatch)
    const claim = claimAutoCompactRequest({ cascadeId: cid, requestId: req2.id }, { ...dirs, now: 1_016_000 });
    assert.equal(claim.matched, true);
    evaluateCompactHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL', continuationActive: true },
      hookOpts({
        now: 1_017_000,
        ctxSnapshot: { isChild: false, alreadyCompacted: false, ctxPct: 62, ctx: 158000, limit: 256000, lastGenIdx: 16, activeTimer: { waitSec: 600, kind: 'timer' } },
      })
    );
    assert.equal(readAutoCompactRequest(cid, dirs)?.genIdx, 14);

    // 5. Commit + cooldown blocks duplicate trigger within 120s, then highWater works after cooldown
    commitAutoCompactRequest(
      { cascadeId: cid, requestId: req2.id, claimToken: claim.claimToken },
      { ...dirs, now: 1_018_000 }
    );
    assert.equal(readAutoCompactRequest(cid, dirs)?.consumed, true);

    fs.writeFileSync(
      dirs.studioPrefsFile,
      JSON.stringify({
        ...DEFAULT_STUDIO_PREFS,
        autoCompactMode: 'auto',
        autoCompactHighWaterPct: 80,
        autoCompactTriggers: { longTimer: true, modelRequest: true, highWater: true },
      })
    );
    evaluateCompactHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({
        now: 1_050_000, // inside 120s cooldown
        ctxSnapshot: { isChild: false, alreadyCompacted: false, ctxPct: 85, ctx: 217000, limit: 256000, lastGenIdx: 20, activeTimer: null },
      })
    );
    assert.equal(readAutoCompactRequest(cid, dirs)?.consumed, true);

    evaluateCompactHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({
        now: 1_200_000, // past 120s cooldown
        ctxSnapshot: { isChild: false, alreadyCompacted: false, ctxPct: 85, ctx: 217000, limit: 256000, lastGenIdx: 20, activeTimer: null },
      })
    );
    const hwReq = readAutoCompactRequest(cid, dirs);
    assert.equal(hwReq?.kind, 'high_water');
    assert.equal(hwReq?.consumed, false);

    // 6. CLI --request and Stop trigger
    const cidCli = 'conv_cli_req_5678';
    const cliOut = spawnSync(
      process.execPath,
      [
        path.join(REPO, 'studio', 'plugin', 'maga-auto-compact', 'hooks', 'compact-check.mjs'),
        '--request',
        '--cid',
        cidCli,
        '--reason',
        'Phase 1 research finished',
      ],
      {
        env: { ...process.env, ANTI_CLAUDE_STATE_DIR: dirs.stateDir, PLUGIN_DATA: dirs.pluginDataDir },
        encoding: 'utf8',
        timeout: 3000,
      }
    );
    assert.equal(cliOut.status, 0, cliOut.stderr);
    assert.equal(JSON.parse(cliOut.stdout.trim()).action, 'queued');
    evaluateCompactHookEvent(
      { hookEventName: 'Stop', conversationId: cidCli, terminationReason: 'NO_TOOL_CALL' },
      hookOpts({
        now: Date.now(),
        ctxSnapshot: { isChild: false, alreadyCompacted: false, ctxPct: 42, ctx: 108000, limit: 256000, lastGenIdx: 7, activeTimer: null },
      })
    );
    assert.equal(readAutoCompactRequest(cidCli, dirs)?.kind, 'model_request');

    clearCompactState({ cid: cidCli }, dirs);
    assert.equal(readAutoCompactRequest(cidCli, dirs), null);
    assert.equal(requestAutoCompact({ cid: 'bad' }, dirs).ok, false);
  } finally {
    dirs.cleanup();
  }
});

test('auto-compact daemon service handles plugin sync, TTL expiry, and two-phase CAS lease', async () => {
  const dirs = makeTempDirs('ac-svc-');
  const cid = 'conv_svc_lease_999';
  try {
    assert.equal(isAutoCompactPluginInstalled(dirs), false);
    const syncRes = syncAutoCompactPlugin({}, dirs);
    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.installed, true);

    const now = 2_000_000;
    writeAutoCompactRequest(
      cid,
      {
        schema: 1,
        id: 'req_abc',
        cid,
        kind: 'long_timer',
        mode: 'auto',
        ctxPct: 60,
        ts: now,
        consumed: false,
        dismissed: false,
      },
      { ...dirs, now }
    );

    const st1 = getAutoCompactStatus({ cascadeId: cid }, { ...dirs, now: now + 1000 });
    assert.equal(st1.request?.id, 'req_abc');

    // Claim blocks concurrent claim & hides from status
    const c1 = claimAutoCompactRequest({ cascadeId: cid, requestId: 'req_abc' }, { ...dirs, now: now + 2000 });
    assert.equal(c1.matched, true);
    assert.ok(c1.claimToken);
    assert.equal(
      claimAutoCompactRequest({ cascadeId: cid, requestId: 'req_abc' }, { ...dirs, now: now + 3000 }).matched,
      false
    );
    assert.equal(getAutoCompactStatus({ cascadeId: cid }, { ...dirs, now: now + 3000 }).request, null);

    // Release unlocks immediately
    assert.equal(
      releaseAutoCompactRequest(
        { cascadeId: cid, requestId: 'req_abc', claimToken: c1.claimToken },
        { ...dirs, now: now + 4000 }
      ).matched,
      true
    );
    assert.equal(getAutoCompactStatus({ cascadeId: cid }, { ...dirs, now: now + 4500 }).request?.id, 'req_abc');

    // Expired 30s lease counts as released
    const c2 = claimAutoCompactRequest({ cascadeId: cid, requestId: 'req_abc' }, { ...dirs, now: now + 5000 });
    assert.equal(c2.matched, true);
    const afterLease = now + 5000 + AUTO_COMPACT_LEASE_TTL_MS + 100;
    assert.equal(getAutoCompactStatus({ cascadeId: cid }, { ...dirs, now: afterLease }).request?.id, 'req_abc');

    // Mismatched claimToken cannot commit
    assert.equal(
      commitAutoCompactRequest(
        { cascadeId: cid, requestId: 'req_abc', claimToken: 'wrong-token' },
        { ...dirs, now: afterLease }
      ).matched,
      false
    );
    assert.equal(
      commitAutoCompactRequest(
        { cascadeId: cid, requestId: 'req_abc', claimToken: c2.claimToken },
        { ...dirs, now: afterLease }
      ).matched,
      true
    );
    assert.equal(getAutoCompactStatus({ cascadeId: cid }, { ...dirs, now: afterLease + 10 }).request, null);

    // TTL > 5min hides request
    writeAutoCompactRequest(
      cid,
      { schema: 1, id: 'req_old', cid, kind: 'long_timer', ctxPct: 60, ts: now, consumed: false, dismissed: false },
      { ...dirs, now }
    );
    assert.equal(
      getAutoCompactStatus({ cascadeId: cid }, { ...dirs, now: now + AUTO_COMPACT_REQUEST_TTL_MS + 1 }).request,
      null
    );

    // Dismiss via RPC
    writeAutoCompactRequest(
      cid,
      { schema: 1, id: 'req_dis', cid, kind: 'long_timer', ctxPct: 60, ts: now, consumed: false, dismissed: false },
      { ...dirs, now }
    );
    const disRes = await handleAutoCompactRpc('dismissAutoCompactRequest', { cascadeId: cid, requestId: 'req_dis' }, dirs);
    assert.equal(disRes.matched, true);
    assert.equal(readAutoCompactRequest(cid, dirs)?.dismissed, true);

    const rmRes = syncAutoCompactPlugin({ remove: true }, dirs);
    assert.equal(rmRes.installed, false);
  } finally {
    dirs.cleanup();
  }
});

test('createAutoCompactRuntime handles auto lease/commit, concurrent draft fallback pill, semi pill & live prefs', { skip: skipDom }, async () => {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div data-testid="conversation-view" data-cascade-id="conv-ac-1">
        <div id="antigravity.agentSidePanelInputBox">
          <div data-lexical-editor="true"></div>
          <div class="agy-composer-footer">
            <div><button type="button">+</button></div>
            <div><button data-testid="input-send-button"></button></div>
          </div>
        </div>
      </div>
    </body></html>`,
    { url: 'http://127.0.0.1/c/conv-ac-1' }
  );

  await withMockDom(dom, async () => {
    const rpcLog = [];
    let currentRequest = {
      schema: 1,
      id: 'req_auto_1',
      cid: 'conv-ac-1',
      kind: 'long_timer',
      mode: 'auto',
      ctxPct: 62,
      ts: Date.now(),
    };
    let submitShouldSucceed = true;
    let compactStatus = 'idle';
    let triggerCalls = 0;

    window.__agClaudeUxBridge = {
      detectCompactStatus: () => compactStatus,
      triggerConversationCompact: async (opts) => {
        triggerCalls += 1;
        const ed = document.querySelector('[data-lexical-editor="true"]');
        if (opts?.requireEmptyDraft && (ed?.textContent || '').trim().length > 0) {
          return false;
        }
        return submitShouldSucceed;
      },
    };
    window.__agProjectCall = async (action, payload) => {
      rpcLog.push({ action, payload });
      if (action === 'getAutoCompactStatus') return { ok: true, request: currentRequest };
      if (action === 'claimAutoCompactRequest') return { ok: true, matched: true, claimToken: 'lease_tok_1' };
      if (action === 'commitAutoCompactRequest') {
        currentRequest = null;
        return { ok: true, matched: true };
      }
      if (action === 'releaseAutoCompactRequest' || action === 'dismissAutoCompactRequest') {
        if (action === 'dismissAutoCompactRequest') currentRequest = null;
        return { ok: true, matched: true };
      }
      return { ok: true };
    };

    const studioPrefs = createStudioPrefsRuntime({ initialPrefs: { autoCompactMode: 'auto' } });
    const runtime = createAutoCompactRuntime({ studioPrefs, settleDelayMs: 15, retryDelayMs: 0 });
    try {
      // 1. Auto mode executes on turn settle (prevRunning true -> false)
      const box = document.getElementById('antigravity.agentSidePanelInputBox');
      const footer = box.querySelector('.agy-composer-footer');
      const leftGroup = footer.children[0];
      runtime.write(null, { enabled: true, mode: 'auto', cid: 'conv-ac-1', box, footer, leftGroup, running: true, editorEmpty: true, langTag: 'zh' });
      runtime.write(null, { enabled: true, mode: 'auto', cid: 'conv-ac-1', box, footer, leftGroup, running: false, editorEmpty: true, langTag: 'zh' });
      await tick(50);

      assert.equal(triggerCalls, 1);
      assert.ok(rpcLog.some((c) => c.action === 'claimAutoCompactRequest'));
      assert.ok(rpcLog.some((c) => c.action === 'commitAutoCompactRequest' && c.payload.claimToken === 'lease_tok_1'));
      assert.equal(document.getElementById('agy-auto-compact-pill'), null);

      // 2. Concurrent draft typed during claim -> submit returns false -> releases lease & shows fallback pill once draft clears
      rpcLog.length = 0;
      currentRequest = {
        schema: 1,
        id: 'req_auto_draft',
        cid: 'conv-ac-1',
        kind: 'long_timer',
        mode: 'auto',
        ctxPct: 68,
        ts: Date.now(),
      };
      const ed = box.querySelector('[data-lexical-editor="true"]');
      window.__agProjectCall = async (action, payload) => {
        rpcLog.push({ action, payload });
        if (action === 'getAutoCompactStatus') return { ok: true, request: currentRequest };
        if (action === 'claimAutoCompactRequest') {
          ed.textContent = 'user started typing mid-rpc';
          return { ok: true, matched: true, claimToken: 'lease_tok_2' };
        }
        return { ok: true, matched: true };
      };
      ed.textContent = '';
      runtime.write(null, { enabled: true, mode: 'auto', cid: 'conv-ac-1', box, footer, leftGroup, running: true, editorEmpty: true, langTag: 'zh' });
      runtime.write(null, { enabled: true, mode: 'auto', cid: 'conv-ac-1', box, footer, leftGroup, running: false, editorEmpty: true, langTag: 'zh' });
      await tick(50);

      assert.ok(rpcLog.some((c) => c.action === 'releaseAutoCompactRequest' && c.payload.claimToken === 'lease_tok_2'));
      assert.equal(rpcLog.some((c) => c.action === 'commitAutoCompactRequest'), false);
      assert.equal(ed.textContent, 'user started typing mid-rpc');

      ed.textContent = '';
      runtime.sync();
      const fallbackPill = document.getElementById('agy-auto-compact-pill');
      assert.ok(fallbackPill, 'fallback pill should render when auto submit declined');
      assert.equal(fallbackPill.getAttribute('data-maga-own'), '1');

      // 3. Switching live prefs from auto -> off dismisses request immediately (even though req.mode === 'auto')
      studioPrefs.patch({ autoCompactMode: 'off' });
      await tick(25);
      assert.equal(document.getElementById('agy-auto-compact-pill'), null);
      assert.ok(rpcLog.some((c) => c.action === 'dismissAutoCompactRequest'));

      // 4. Semi mode renders pill, click commits, non-idle detectCompactStatus auto-dismisses without pill flash
      rpcLog.length = 0;
      studioPrefs.patch({ autoCompactMode: 'semi' });
      currentRequest = {
        schema: 1,
        id: 'req_semi_1',
        cid: 'conv-ac-1',
        kind: 'long_timer',
        mode: 'auto', // stale request snapshot should defer to live 'semi' pref
        ctxPct: 55,
        ts: Date.now(),
      };
      window.__agProjectCall = async (action, payload) => {
        rpcLog.push({ action, payload });
        if (action === 'getAutoCompactStatus') return { ok: true, request: currentRequest };
        if (action === 'claimAutoCompactRequest') return { ok: true, matched: true, claimToken: 'lease_tok_3' };
        if (action === 'commitAutoCompactRequest') {
          currentRequest = null;
          return { ok: true, matched: true };
        }
        return { ok: true, matched: true };
      };
      runtime.write(null, { enabled: true, mode: 'semi', cid: 'conv-ac-1', box, footer, leftGroup, running: true, editorEmpty: true, langTag: 'zh' });
      runtime.write(null, { enabled: true, mode: 'semi', cid: 'conv-ac-1', box, footer, leftGroup, running: false, editorEmpty: true, langTag: 'zh' });
      await tick(50);

      const semiPill = document.getElementById('agy-auto-compact-pill');
      assert.ok(semiPill);
      assert.match(semiPill.textContent, /55%/);
      semiPill.querySelector('.agy-ac-go').click();
      await tick(30);
      assert.ok(rpcLog.some((c) => c.action === 'commitAutoCompactRequest' && c.payload.claimToken === 'lease_tok_3'));
      assert.equal(document.getElementById('agy-auto-compact-pill'), null);

      // 5. Non-idle detectCompactStatus auto-dismisses stale request without flashing pill
      rpcLog.length = 0;
      compactStatus = 'compacted';
      currentRequest = { schema: 1, id: 'req_stale_cp', cid: 'conv-ac-1', kind: 'long_timer', ctxPct: 60, ts: Date.now() };
      runtime.write(null, { enabled: true, mode: 'semi', cid: 'conv-ac-1', box, footer, leftGroup, running: true, editorEmpty: true, langTag: 'zh' });
      runtime.write(null, { enabled: true, mode: 'semi', cid: 'conv-ac-1', box, footer, leftGroup, running: false, editorEmpty: true, langTag: 'zh' });
      await tick(50);
      assert.equal(document.getElementById('agy-auto-compact-pill'), null);
      assert.ok(rpcLog.some((c) => c.action === 'dismissAutoCompactRequest'));
    } finally {
      runtime.dispose();
      studioPrefs.dispose();
    }
  });
});

test('user/custom.js bridge triggerConversationCompact protects live drafts and submits plain /compact', { skip: skipDom }, async () => {
  const { code } = await buildUserCustomJs({ writeToRepo: false });
  const testCid = 'a1b2c3d4-1111-4222-8333-444455556666';
  const dom = new JSDOM(
    `<!doctype html><body>
      <div data-testid="conversation-view" data-cascade-id="${testCid}">
        <div id="antigravity.agentSidePanelInputBox">
          <div data-lexical-editor="true"></div>
        </div>
      </div>
    </body>`,
    { runScripts: 'outside-only', url: `http://127.0.0.1/c/${testCid}`, pretendToBeVisual: true }
  );
  const { window } = dom;
  try {
    window.ctx = { modules: {}, onCleanup: () => {} };
    window.eval(code);

    const box = window.document.getElementById('antigravity.agentSidePanelInputBox');
    const submitted = [];
    const slashDef = { title: 'compact', info: { name: 'compact', type: 1 } };
    box.__reactFiber$test = {
      memoizedProps: {
        cascadeId: testCid,
        isRunning: false,
        slashCommandItems: [slashDef],
        handleSubmit: async (items) => {
          submitted.push(items);
        },
      },
      return: null,
    };

    assert.equal(typeof window.__agClaudeUxBridge?.triggerConversationCompact, 'function');
    assert.equal(typeof window.__agClaudeUxBridge?.detectCompactStatus, 'function');

    // Wrong expectedCid rejected
    assert.equal(
      await window.__agClaudeUxBridge.triggerConversationCompact({
        expectedCid: '00000000-0000-4000-8000-000000000000',
        requireEmptyDraft: true,
      }),
      false
    );

    // Non-empty draft rejected synchronously before handleSubmit
    const ed = box.querySelector('[data-lexical-editor="true"]');
    ed.textContent = 'keep my draft!';
    assert.equal(
      await window.__agClaudeUxBridge.triggerConversationCompact({ expectedCid: testCid, requireEmptyDraft: true }),
      false
    );
    assert.equal(submitted.length, 0);

    // Empty draft submits plain '/compact ' (trailing ' ')
    ed.textContent = '';
    assert.equal(
      await window.__agClaudeUxBridge.triggerConversationCompact({ expectedCid: testCid, requireEmptyDraft: true }),
      true
    );
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0][0].chunk.value.scopeItem.value.info.name, 'compact');
    assert.equal(submitted[0][1].chunk.value, ' ');
  } finally {
    window.close();
  }
});

test('buildStudioBundle compiles Auto-Compact runtime & settings L3 without :has() CSS', async () => {
  const bundle = await buildStudioBundle();
  assert.match(bundle.jsBlock, /createAutoCompactRuntime/);
  assert.match(bundle.jsBlock, /stream-auto-compact/);
  assert.equal(/[^\n]*:has\s*\(/.test(bundle.cssBlock), false);
});

test('Opus P2 regressions: O_EXCL stale lock, commit interleave, resync/retry, pinned node, cooldown, fallback draft & module size', async () => {
  // 1. metrics-quota.mjs line count stays well under 2000 lines after compact-controller split
  const mqLines = fs.readFileSync(path.join(REPO, 'user', 'src', 'modules', 'metrics-quota.mjs'), 'utf8').split('\n').length;
  assert.ok(mqLines < 1800, `Expected metrics-quota.mjs < 1800 lines, got ${mqLines}`);

  const dirs = makeTempDirs('ac-p2-');
  const cid = 'conv_p2_lock_1234';
  try {
    // 2. Stale O_EXCL lock eviction & hook-vs-commit interleave protection
    const reqFile = path.join(dirs.requestsDir, `${cid}.json`);
    const lockFile = `${reqFile}.lock`;
    fs.writeFileSync(lockFile, '99999:stale\n', 'utf8');
    const oldTime = new Date(Date.now() - 10_000);
    fs.utimesSync(lockFile, oldTime, oldTime);
    let ran = false;
    withRequestLock(reqFile, () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lockFile), false);

    // Claim req_old, then overwrite with req_new (simulating hook refresh) -> commit for req_old must NOT overwrite req_new
    const now = 3_000_000;
    writeAutoCompactRequest(cid, { schema: 1, id: 'req_old', cid, ts: now, consumed: false, dismissed: false }, { ...dirs, now });
    const claimOld = claimAutoCompactRequest({ cascadeId: cid, requestId: 'req_old' }, { ...dirs, now: now + 100 });
    assert.equal(claimOld.matched, true);
    writeAutoCompactRequest(cid, { schema: 1, id: 'req_new', cid, ts: now + 200, consumed: false, dismissed: false }, { ...dirs, now: now + 200 });
    const commitOld = commitAutoCompactRequest(
      { cascadeId: cid, requestId: 'req_old', claimToken: claimOld.claimToken },
      { ...dirs, now: now + 300 }
    );
    assert.equal(commitOld.matched, false);
    assert.equal(readAutoCompactRequest(cid, dirs)?.id, 'req_new');
    assert.equal(readAutoCompactRequest(cid, dirs)?.consumed, false);

    // 3. syncAutoCompactPlugin pins nodeExecPath in synced hooks.json while keeping source portable
    const customNode = process.execPath;
    const syncRes = syncAutoCompactPlugin({}, { ...dirs, nodeExecPath: customNode });
    assert.equal(syncRes.ok, true);
    const syncedHooks = JSON.parse(fs.readFileSync(path.join(dirs.pluginsDir, 'maga-auto-compact', 'hooks.json'), 'utf8'));
    const repoHooks = JSON.parse(
      fs.readFileSync(path.join(REPO, 'studio', 'plugin', 'maga-auto-compact', 'hooks.json'), 'utf8')
    );
    assert.equal(repoHooks['maga-auto-compact'].Stop[0].command, 'node ./hooks/compact-check.mjs');
    assert.ok(syncedHooks['maga-auto-compact'].Stop[0].command.includes(customNode));
    const nodeCheck = verifyInstalledHookNodeRuntime(dirs);
    assert.equal(nodeCheck.ok, true);
    assert.equal(nodeCheck.sqliteSupported, true);

    // 4. requestAutoCompact reports cooldownRemainingSec when within 120s cooldown
    fs.writeFileSync(dirs.studioPrefsFile, JSON.stringify({ ...DEFAULT_STUDIO_PREFS, autoCompactMode: 'auto' }));
    evaluateCompactHookEvent(
      { hookEventName: 'Stop', conversationId: cid, terminationReason: 'NO_TOOL_CALL' },
      {
        ...dirs,
        now: 4_000_000,
        ctxSnapshot: { isChild: false, alreadyCompacted: false, ctxPct: 60, ctx: 150000, limit: 256000, lastGenIdx: 12, activeTimer: { waitSec: 600, kind: 'timer' } },
      }
    );
    const qRes = requestAutoCompact({ cid, reason: 'Check cooldown' }, { ...dirs, now: 4_030_000 });
    assert.equal(qRes.action, 'queued');
    assert.equal(qRes.cooldownRemainingSec, 90);
  } finally {
    dirs.cleanup();
  }

  // 5. Frontend resync on refreshed-id claim mismatch & commit retry after submit
  if (!skipDom) {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <div data-testid="conversation-view" data-cascade-id="conv-p2-ui">
          <div id="antigravity.agentSidePanelInputBox">
            <div data-lexical-editor="true"></div>
            <div class="agy-composer-footer"><div></div><div></div></div>
          </div>
        </div>
      </body></html>`,
      { url: 'http://127.0.0.1/c/conv-p2-ui' }
    );
    await withMockDom(dom, async () => {
      let statusGets = 0;
      let commitCalls = 0;
      let activeReq = { schema: 1, id: 'req_stale_id', cid: 'conv-p2-ui', kind: 'long_timer', ctxPct: 60, ts: Date.now() };
      let triggerCount = 0;

      window.__agClaudeUxBridge = {
        detectCompactStatus: () => 'idle',
        triggerConversationCompact: async () => {
          triggerCount += 1;
          return true;
        },
      };
      window.__agProjectCall = async (action, payload) => {
        if (action === 'getAutoCompactStatus') {
          statusGets += 1;
          return { ok: true, request: activeReq };
        }
        if (action === 'claimAutoCompactRequest') {
          if (payload.requestId === 'req_stale_id') {
            activeReq = { schema: 1, id: 'req_fresh_id', cid: 'conv-p2-ui', kind: 'long_timer', ctxPct: 65, ts: Date.now() };
            return { ok: true, matched: false };
          }
          return { ok: true, matched: true, claimToken: 'tok_fresh' };
        }
        if (action === 'commitAutoCompactRequest') {
          commitCalls += 1;
          if (commitCalls === 1) return { ok: true, matched: false }; // fail first, succeed on retry
          activeReq = null;
          return { ok: true, matched: true };
        }
        return { ok: true, matched: true };
      };

      const studioPrefs = createStudioPrefsRuntime({ initialPrefs: { autoCompactMode: 'auto' } });
      const runtime = createAutoCompactRuntime({ studioPrefs, settleDelayMs: 10, retryDelayMs: 0, commitRetryDelayMs: 10 });
      try {
        const box = document.getElementById('antigravity.agentSidePanelInputBox');
        const footer = box.querySelector('.agy-composer-footer');
        runtime.write(null, { enabled: true, mode: 'auto', cid: 'conv-p2-ui', box, footer, leftGroup: footer.children[0], running: true, editorEmpty: true, langTag: 'zh' });
        runtime.write(null, { enabled: true, mode: 'auto', cid: 'conv-p2-ui', box, footer, leftGroup: footer.children[0], running: false, editorEmpty: true, langTag: 'zh' });
        await tick(120);

        assert.ok(statusGets >= 2, `expected resync fetchStatus after claim mismatch, got ${statusGets}`);
        assert.equal(triggerCount, 1);
        assert.equal(commitCalls, 2, 'expected commit retry once after initial mismatch');
      } finally {
        runtime.dispose();
        studioPrefs.dispose();
      }
    });

    // 6. Fallback path without inputBoxRef.current.submit leaves composer text clean (no '/compact ' pollution)
    const { code } = await buildUserCustomJs({ writeToRepo: false });
    const testCid = 'b2c3d4e5-2222-4333-8444-555566667777';
    const fbDom = new JSDOM(
      `<!doctype html><body>
        <div data-testid="conversation-view" data-cascade-id="${testCid}">
          <div id="antigravity.agentSidePanelInputBox">
            <div data-lexical-editor="true"></div>
          </div>
        </div>
      </body>`,
      { runScripts: 'outside-only', url: `http://127.0.0.1/c/${testCid}`, pretendToBeVisual: true }
    );
    try {
      const w = fbDom.window;
      w.ctx = { modules: {}, onCleanup: () => {} };
      w.eval(code);
      const box = w.document.getElementById('antigravity.agentSidePanelInputBox');
      const ed = box.querySelector('[data-lexical-editor="true"]');
      box.__reactFiber$fb = {
        memoizedProps: {
          value: {
            inputBoxRef: {
              current: {
                lexicalRef: { current: { getRootElement: () => ed } },
                // submit intentionally missing
              },
            },
          },
        },
        return: null,
      };
      const ok = await w.__agClaudeUxBridge.triggerConversationCompact({ expectedCid: testCid, requireEmptyDraft: true });
      assert.equal(ok, false);
      assert.equal(ed.textContent, '', 'missing ref.submit must not pollute composer text');
    } finally {
      fbDom.window.close();
    }
  }
});
