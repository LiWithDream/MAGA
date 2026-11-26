/**
 * AGY Studio Remote Control — Phase 2 Integration & Security Test Suite
 * Covers: per-cascade single-writer lock & desktop resume suppression, studio-bridge,
 * end-to-end Gateway -> Bridge -> Tap silent resume, /compact, Opus proposal dismiss,
 * and static invariants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GW_DIR = path.join(REPO, 'remote', 'gateway');
const PWA_DIR = path.join(REPO, 'remote', 'pwa');

const configMod = await import(pathToFileURL(path.join(GW_DIR, 'config.mjs')).href);
const serverMod = await import(pathToFileURL(path.join(GW_DIR, 'server.mjs')).href);
const lockMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote', 'cascade-lock.mjs')).href);
const studioBridgeMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote', 'studio-bridge.mjs')).href);
const opusService = await import(pathToFileURL(path.join(REPO, 'studio', 'daemon', 'opus-gate-service.mjs')).href);
const acService = await import(pathToFileURL(path.join(REPO, 'studio', 'daemon', 'auto-compact-service.mjs')).href);

function writeInterruptedConvDb(convDir, cid, { lastIdx = 4, stepType = 15, status = 8 } = {}) {
  fs.mkdirSync(convDir, { recursive: true });
  const dbPath = path.join(convDir, `${cid}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, metadata BLOB, step_payload BLOB);'
  );
  const stmt = db.prepare(
    'INSERT INTO steps (idx, step_type, status, error_details, metadata, step_payload) VALUES (?, ?, ?, ?, ?, ?);'
  );
  stmt.run(0, 14, 3, Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0));
  stmt.run(lastIdx, stepType, status, Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0));
  db.close();
}

async function signHello(privateKey, { nonce, deviceId, lastSeq = 0, lastEpoch = '' }) {
  const payload = `maga-remote/1:hello:${nonce}:${deviceId}:${lastSeq ?? 0}:${lastEpoch || ''}`;
  const sigBuf = await crypto.webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(payload)
  );
  return Buffer.from(sigBuf).toString('base64url');
}

function makeMaskedClientFrame(opcode, payloadBuf = Buffer.alloc(0)) {
  const mask = crypto.randomBytes(4);
  const len = payloadBuf.length;
  const header =
    len < 126
      ? Buffer.from([0x80 | opcode, 0x80 | len])
      : Buffer.from([0x80 | opcode, 0x80 | 126, (len >>> 8) & 0xff, len & 0xff]);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = payloadBuf[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function rawWsUpgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...headers,
      },
    });
    req.on('upgrade', (res, socket, head) => resolve({ status: res.statusCode, socket, head }));
    req.on('error', reject);
    req.end();
  });
}

function readServerFrames(socket, initialBuf = Buffer.alloc(0)) {
  let buf = Buffer.from(initialBuf);
  const queue = [];
  let waiter = null;

  const pump = () => {
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const len7 = b1 & 0x7f;
      let off = 2;
      let len = len7;
      if (len7 === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len7 === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      const frame = { opcode: b0 & 0x0f, payload };
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(frame);
      } else {
        queue.push(frame);
      }
    }
  };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  pump();

  return {
    nextFrame(timeoutMs = 5000) {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          waiter = null;
          reject(new Error('ws_read_timeout'));
        }, timeoutMs);
        waiter = (f) => {
          clearTimeout(t);
          resolve(f);
        };
      });
    },
  };
}

test('Phase 2 cascade-lock enforces single writer per cascade and suppresses desktop getResumeState during cooldown', async () => {
  lockMod.resetCascadeWriteLocksForTest();
  const cid1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const cid2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const { handleProjectRpcRequest } = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'overview-skills.mjs')).href);

  try {
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });

    const p1 = lockMod.withCascadeWriteLock(cid1, 'writer-1', async () => {
      await gate;
      return 'done-1';
    }, { markCooldownOnSuccess: true });

    await assert.rejects(
      () => lockMod.withCascadeWriteLock(cid1, 'writer-2', async () => 'should-fail'),
      (err) => err?.code === 'cascade_write_busy'
    );

    const p2 = await lockMod.withCascadeWriteLock(cid2, 'other-cascade', async () => 'ok-2');
    assert.equal(p2, 'ok-2');

    // Active lock suppresses desktop getResumeState
    const duringActive = await handleProjectRpcRequest(
      JSON.stringify({ reqId: 'rpc-1', token: 'tok-1', action: 'getResumeState', payload: { cascadeId: cid1 } }),
      { rpcToken: 'tok-1', hostConfirmed: true }
    );
    assert.equal(duringActive.result.ok, true);
    assert.equal(duringActive.result.interrupted, false);
    assert.equal(duringActive.result.active, true);
    assert.equal(duringActive.result.reason, 'remote_write_active');

    releaseFirst();
    assert.equal(await p1, 'done-1');
    assert.equal(lockMod.isCascadeWriteActive(cid1), false);
    assert.equal(lockMod.isCascadeWriteActiveOrRecent(cid1), true, '3s cooldown should hold after write');

    // Cooldown window still suppresses desktop getResumeState
    const duringCooldown = await handleProjectRpcRequest(
      JSON.stringify({ reqId: 'rpc-2', token: 'tok-1', action: 'getResumeState', payload: { cascadeId: cid1 } }),
      { rpcToken: 'tok-1', hostConfirmed: true }
    );
    assert.equal(duringCooldown.result.reason, 'remote_write_active');
    assert.equal(duringCooldown.result.interrupted, false);
  } finally {
    lockMod.resetCascadeWriteLocksForTest();
  }
});

test('Phase 2 studio-bridge aggregates resumeState, sanitized overview & Opus Gate proposal dismissal', async () => {
  lockMod.resetCascadeWriteLocksForTest();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-p2br-'));
  try {
    const convDir = path.join(tmpRoot, 'conversations');
    const stateDir = path.join(tmpRoot, 'state');
    const nativeProjectsDir = path.join(tmpRoot, 'projects');
    const convWtDir = path.join(tmpRoot, 'conv-worktrees');
    const projDir = path.join(tmpRoot, 'demo-repo');
    const proposalsDir = path.join(stateDir, 'opus-gate-proposals');
    const requestsDir = path.join(stateDir, 'auto-compact-requests');
    const quotaStateFile = path.join(stateDir, 'quota-state.json');

    fs.mkdirSync(nativeProjectsDir, { recursive: true });
    fs.mkdirSync(convWtDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });

    const cid = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
    writeInterruptedConvDb(convDir, cid, { lastIdx: 6, stepType: 15, status: 8 });

    // Interrupted DB state & suppression flags
    assert.equal(studioBridgeMod.getRemoteResumeState('bad-id').error, 'invalid_cascade_id');
    assert.equal(studioBridgeMod.getRemoteResumeState(cid, { liveBusy: true }).interrupted, false);
    assert.equal(studioBridgeMod.getRemoteResumeState(cid, { liveWaiting: true }).reason, 'waiting_user');
    const rs = studioBridgeMod.getRemoteResumeState(cid, { conversationsDir: convDir });
    assert.equal(rs.ok, true);
    assert.equal(rs.interrupted, true);
    assert.equal(rs.lastIdx, 6);
    assert.equal(rs.reason, 'aborted');

    // Fixtures for Studio Overview
    fs.writeFileSync(
      path.join(nativeProjectsDir, 'proj-demo.json'),
      JSON.stringify({ id: 'proj-demo', name: 'Demo Repo', folderUris: [`file://${projDir}`] })
    );
    fs.writeFileSync(
      path.join(convWtDir, `${cid}.json`),
      JSON.stringify({ worktreePath: path.join(tmpRoot, 'MAGA-wt', 'remote'), branch: 'feat/remote-control', repoRoot: projDir, updatedAt: Date.now() })
    );
    opusService.saveQuotaState(
      { tierName: 'Pro', claude: { fiveHourRemainingPct: 82, weeklyRemainingPct: 91 }, gemini: { fiveHourRemainingPct: 100, weeklyRemainingPct: 100 } },
      { quotaStateFile }
    );
    const nowTs = Date.now();
    opusService.writeOpusGateProposal(
      cid,
      { kind: 'risk', reason: 'High-risk auth change', diffHash: 'abc123def456', recommendedTier: 'high', ts: nowTs },
      { proposalsDir }
    );
    acService.writeAutoCompactRequest(
      cid,
      { requestId: 'ac-1', reason: 'context_high', ctxPct: 92, ts: nowTs },
      { requestsDir }
    );

    const d = new Date(nowTs);
    const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const overview = await studioBridgeMod.collectStudioOverview(
      { cascadeId: cid },
      {
        authorizedDirs: [projDir],
        nativeProjectsDir,
        convWtDir,
        now: nowTs,
        quotaOpts: { quotaStateFile },
        opusOpts: { proposalsDir, quotaStateFile },
        compactOpts: { requestsDir },
        listRepoWorktreesAsync: async () => ({
          ok: true,
          worktrees: [
            { realPath: projDir, branch: 'main', isMain: true },
            { realPath: path.join(tmpRoot, 'MAGA-wt', 'remote'), branch: 'feat/remote-control', isMain: false },
          ],
        }),
        collectUsageStatsAsync: async () => ({
          ok: true,
          days: [{ date: todayStr, requests: 5, uncached: 1200, cacheRead: 8000, cacheWrite: 500, output: 300 }],
        }),
      }
    );

    assert.equal(overview.ok, true);
    assert.equal(overview.projects.length, 1);
    assert.equal(overview.projects[0].name, 'Demo Repo');
    assert.equal(overview.projects[0].worktreeCount, 2);
    assert.equal(overview.worktreeByCid[cid].branch, 'feat/remote-control');
    assert.equal(overview.worktreeByCid[cid].projectId, 'proj-demo');
    assert.equal(overview.quota.claude.fiveHourRemainingPct, 82);
    assert.equal(overview.todayUsage.totalTokens, 10_000);
    assert.equal(overview.activeCascade.opusGate.proposal.id, 'abc123def456');
    assert.equal(overview.activeCascade.autoCompact.pending.ctxPct, 92);

    const dismissed = studioBridgeMod.handleRemoteOpusDismiss(
      { cascadeId: cid, proposalId: 'abc123def456' },
      { opusOpts: { proposalsDir } }
    );
    assert.equal(dismissed.ok, true);
    assert.equal(dismissed.matched, true);
    assert.equal(opusService.getOpusGateStatus({ cascadeId: cid }, { proposalsDir, quotaStateFile }).proposal, null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    lockMod.resetCascadeWriteLocksForTest();
  }
});

test('Phase 2 End-to-End (Gateway + Bridge + Tap): studio.overview, convo.resume, convo.compact & opus.dismiss', async () => {
  lockMod.resetCascadeWriteLocksForTest();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-p2e2e-'));
  const remoteDir = path.join(tmpRoot, 'remote');
  const stateDir = path.join(tmpRoot, 'state');
  const convDir = path.join(tmpRoot, 'conversations');
  const sockPath = path.join(tmpRoot, 'bridge.sock');
  const bootToken = 'phase2-boot-token-0123456789abcd';
  const bridgeMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote-bridge.mjs')).href);
  const { attachedTargets } = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'env.mjs')).href);
  const { createRemoteTapModule } = await import(pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'remote-tap.mjs')).href);
  const prevTargets = Array.from(attachedTargets.entries());
  const openSockets = [];
  let gw = null;

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://127.0.0.1:60000/c/dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
  });
  const keys = ['window', 'document'];
  const prevGlobals = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  let tap = null;

  try {
    const cid = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
    const otherCid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5';
    writeInterruptedConvDb(convDir, cid, { lastIdx: 4, stepType: 15, status: 8 });
    opusService.writeOpusGateProposal(
      cid,
      { kind: 'plan', reason: 'Plan ready', diffHash: 'planhash0001', ts: Date.now() },
      { proposalsDir: path.join(stateDir, 'opus-gate-proposals') }
    );

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;

    let currentPreset = 3; // TURBO
    let hasDraft = false;
    let cidStatus = 1;
    let cidWaitingSteps = [];
    const sentMessages = [];
    const compactCalls = [];
    dom.window.__agClaudeUxBridge = {
      async triggerConversationCompact(opts) {
        compactCalls.push(opts);
        if (hasDraft) return false;
        return true;
      },
    };
    const mockStore = {
      subscribe: () => () => {},
      getState: () => ({
        userStatus: { permissionSettings: { globalPreset: currentPreset } },
        trajectorySummaries: {
          summaries: {
            [cid]: { summary: 'Interrupted Task', status: cidStatus, waitingSteps: cidWaitingSteps },
            [otherCid]: { summary: 'Background Chat', status: 1, waitingSteps: [] },
          },
        },
      }),
    };
    const mockLsClient = {
      sendUserCascadeMessage: async (arg) => sentMessages.push(arg),
      handleCascadeUserInteraction: async () => {},
      cancelCascadeInvocation: async () => {},
      createAgentStateProviderForConvo: () => ({ getState: () => null, onDidChange: () => ({ dispose: () => {} }), dispose: () => {} }),
      getCascadeTrajectory: async () => ({ trajectory: { steps: [] } }),
    };
    dom.window.document.getElementById('root').__reactContainer$p2 = {
      memoizedProps: { store: mockStore, lsClient: mockLsClient },
      child: null,
      sibling: null,
    };

    tap = createRemoteTapModule({ state: { disposed: false } });
    const tapApi = dom.window.__agRemoteTap;
    assert.equal(tapApi.getCapabilities().capabilities.compact, true);

    attachedTargets.clear();
    attachedTargets.set('p2-host', {
      id: 'p2-host',
      type: 'page',
      hostConfirmed: true,
      trustedContextId: 1,
      ws: { readyState: 1 },
      async send(method, params) {
        if (method === 'Runtime.evaluate') {
          const val = await dom.window.eval(String(params.expression || 'null'));
          return { result: { result: { value: val } } };
        }
        return {};
      },
    });

    await bridgeMod.initRemoteBridge({
      env: {
        ANTI_CLAUDE_STATE_DIR: stateDir,
        MAGA_REMOTE_STATE_DIR: remoteDir,
        MAGA_REMOTE_SOCK_PATH: sockPath,
        MAGA_REMOTE_UDS_TOKEN: bootToken,
        MAGA_REMOTE_CONV_DIR: convDir,
      },
      gatewayScript: path.join(tmpRoot, 'missing-gw.mjs'),
    });

    gw = await serverMod.createGatewayServer({
      remoteDir,
      sockPath,
      port: 0,
      writePid: false,
      udsWriteToken: bootToken,
    });

    const enrollAndConnect = async (role, name) => {
      configMod.writePairing(
        { code: `P2_${name}`, expiresAt: Date.now() + 60_000, role, gatewayFingerprint: gw.gatewayFingerprint },
        { remoteDir }
      );
      const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const publicKeyJwk = await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
      const pr = await (
        await fetch(`http://127.0.0.1:${gw.port}/api/pair/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: `P2_${name}`, deviceName: name, publicKeyJwk, turboAcknowledged: true }),
        })
      ).json();
      assert.equal(pr.ok, true);
      const ch = await (await fetch(`http://127.0.0.1:${gw.port}/api/auth/challenge`)).json();
      const sig = await signHello(kp.privateKey, { nonce: ch.nonce, deviceId: pr.deviceId, lastSeq: 0, lastEpoch: '' });
      const ws = await rawWsUpgrade(gw.port);
      openSockets.push(ws.socket);
      const reader = readServerFrames(ws.socket, ws.head);
      ws.socket.write(
        makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({
          type: 'hello', protocol: 'maga-remote/1', deviceId: pr.deviceId, nonce: ch.nonce, signature: sig, lastSeq: 0, lastEpoch: '',
        })))
      );
      const welcome = JSON.parse((await reader.nextFrame()).payload.toString('utf8'));
      assert.equal(welcome.type, 'welcome');
      return { ws, reader };
    };

    const callRpc = async (c, reqId, method, params) => {
      c.ws.socket.write(makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', reqId, method, params }))));
      return JSON.parse((await c.reader.nextFrame()).payload.toString('utf8'));
    };

    const cObs = await enrollAndConnect('observe', 'ObsP2');
    const cSteer = await enrollAndConnect('steer', 'SteerP2');

    // Observe can read studio.overview & convo.resumeState, blocked from writes
    const ovObs = await callRpc(cObs, 'o-1', 'studio.overview', { cascadeId: cid });
    assert.equal(ovObs.ok, true);
    assert.equal(ovObs.result.activeCascade.opusGate.proposal.id, 'planhash0001');

    const rsObs = await callRpc(cObs, 'o-2', 'convo.resumeState', { cascadeId: cid });
    assert.equal(rsObs.ok, true);
    assert.equal(rsObs.result.interrupted, true);
    assert.equal(rsObs.result.lastIdx, 4);

    assert.equal(
      (await callRpc(cObs, 'o-3', 'convo.resume', { cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-obs-res-1', turboWriteConfirmed: true })).error,
      'forbidden_role_observe'
    );
    assert.equal(
      (await callRpc(cObs, 'o-4', 'convo.compact', { cascadeId: cid, idempotencyKey: 'k-obs-cmp-1' })).error,
      'forbidden_role_observe'
    );
    assert.equal(
      (await callRpc(cObs, 'o-5', 'opus.dismiss', { cascadeId: cid, proposalId: 'planhash0001', idempotencyKey: 'k-obs-dis-1' })).error,
      'forbidden_role_observe'
    );

    // Steer: TURBO fails closed without ack
    assert.equal(
      (await callRpc(cSteer, 's-1', 'convo.resume', { cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-noack', turboWriteConfirmed: false })).error,
      'turbo_write_confirmation_required'
    );

    // Stale expectedLastIdx fails with resume_state_changed
    assert.equal(
      (await callRpc(cSteer, 's-2', 'convo.resume', { cascadeId: cid, expectedLastIdx: 99, idempotencyKey: 'k-st-res-stale', turboWriteConfirmed: true })).error,
      'resume_state_changed'
    );

    // Per-cascade lock contention returns cascade_write_busy (not cached), and retry after release succeeds
    let relLock;
    const holdPromise = lockMod.withCascadeWriteLock(cid, 'desktop-writer', () => new Promise((r) => { relLock = r; }));
    const busyRes = await callRpc(cSteer, 's-3', 'convo.resume', {
      cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-busy', turboWriteConfirmed: true,
    });
    assert.equal(busyRes.ok, false);
    assert.equal(busyRes.error, 'cascade_write_busy');
    relLock();
    await holdPromise;

    const okRes = await callRpc(cSteer, 's-4', 'convo.resume', {
      cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-busy', turboWriteConfirmed: true,
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.result.resumedFromIdx, 4);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].items[0].chunk.value.startsWith(studioBridgeMod.SILENT_RESUME_SENTINEL));

    // Cooldown immediately after convo.resume suppresses convo.resumeState
    const afterCooldownRs = await callRpc(cSteer, 's-5', 'convo.resumeState', { cascadeId: cid });
    assert.equal(afterCooldownRs.result.interrupted, false);
    assert.equal(afterCooldownRs.result.reason, 'remote_write_active');

    // convo.compact checks active pane & requireEmptyDraft
    assert.equal(
      (await callRpc(cSteer, 's-6', 'convo.compact', { cascadeId: otherCid, idempotencyKey: 'k-cmp-inactive' })).error,
      'compact_requires_active_pane'
    );
    hasDraft = true;
    assert.equal(
      (await callRpc(cSteer, 's-7', 'convo.compact', { cascadeId: cid, idempotencyKey: 'k-cmp-draft' })).error,
      'compact_rejected_or_busy'
    );
    hasDraft = false;
    const cmpOk = await callRpc(cSteer, 's-8', 'convo.compact', { cascadeId: cid, idempotencyKey: 'k-cmp-ok-1' });
    assert.equal(cmpOk.ok, true);
    assert.deepEqual(compactCalls.at(-1), { expectedCid: cid, requireEmptyDraft: true });

    // opus.dismiss via Gateway -> Bridge -> opus-gate-service.mjs
    // First test idempotency payloadHash binds `ts` too
    const disMismatch = await callRpc(cSteer, 's-9a', 'opus.dismiss', {
      cascadeId: cid, proposalId: 'planhash0001', ts: 123456, idempotencyKey: 'k-opus-dis-ts',
    });
    assert.equal(disMismatch.ok, true);
    assert.equal(disMismatch.result.matched, false);
    const disConflict = await callRpc(cSteer, 's-9b', 'opus.dismiss', {
      cascadeId: cid, proposalId: 'planhash0001', ts: 999999, idempotencyKey: 'k-opus-dis-ts',
    });
    assert.equal(disConflict.ok, false);
    assert.equal(disConflict.error, 'idempotency_key_conflict');

    const disOk = await callRpc(cSteer, 's-9', 'opus.dismiss', {
      cascadeId: cid, proposalId: 'planhash0001', idempotencyKey: 'k-opus-dis-1',
    });
    assert.equal(disOk.ok, true);
    assert.equal(disOk.result.matched, true);
    const ovAfterDis = await callRpc(cSteer, 's-10', 'studio.overview', { cascadeId: cid });
    assert.equal(ovAfterDis.result.activeCascade.opusGate.proposal, null);

    // P1-1 regression: convo.resume rejects during 3s cooldown and when live host is RUNNING or has waitingSteps
    assert.equal(
      (await callRpc(cSteer, 's-11', 'convo.resume', {
        cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-cool', turboWriteConfirmed: true,
      })).error,
      'resume_state_changed'
    );
    lockMod.resetCascadeWriteLocksForTest();
    cidStatus = 2; // RUNNING
    assert.equal(
      (await callRpc(cSteer, 's-12', 'convo.resume', {
        cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-live-run', turboWriteConfirmed: true,
      })).error,
      'resume_state_changed'
    );
    cidStatus = 1;
    cidWaitingSteps = [{ stepIndex: 4, case: 'permission' }];
    assert.equal(
      (await callRpc(cSteer, 's-13', 'convo.resume', {
        cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-live-wait', turboWriteConfirmed: true,
      })).error,
      'resume_state_changed'
    );
    cidWaitingSteps = [];
  } finally {
    for (const s of openSockets) {
      try { s.destroy(); } catch {}
    }
    await gw?.close().catch(() => {});
    tap?.dispose();
    dom.window.close();
    for (const [k, desc] of prevGlobals.entries()) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    attachedTargets.clear();
    for (const [k, v] of prevTargets) attachedTargets.set(k, v);
    await bridgeMod.shutdownRemoteBridge().catch(() => {});
    lockMod.resetCascadeWriteLocksForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 2 Carbon P1 regressions: strict opus CAS, projectResources/hashed projId & parallel studio overview + explicit UDS timeouts', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-p2reg-'));
  try {
    const cid = 'ffffffff-ffff-4fff-8fff-fffffffffff6';
    const proposalsDir = path.join(tmpRoot, 'opus-gate-proposals');
    const nativeProjectsDir = path.join(tmpRoot, 'projects');
    const projKnown = path.join(tmpRoot, 'secret-user-path', 'known-repo');
    const projUnmatched = path.join(tmpRoot, 'secret-user-path', 'unmatched-repo');
    fs.mkdirSync(nativeProjectsDir, { recursive: true });
    fs.mkdirSync(projKnown, { recursive: true });
    fs.mkdirSync(projUnmatched, { recursive: true });

    // Strict CAS checks in studio-bridge + opus-gate-service
    opusService.writeOpusGateProposal(
      cid,
      { kind: 'risk', reason: 'A'.repeat(400), diffHash: 'hashA111', ts: 10001 },
      { proposalsDir }
    );
    assert.equal(
      studioBridgeMod.handleRemoteOpusDismiss({ cascadeId: cid, proposalId: 'active' }, { opusOpts: { proposalsDir } }).matched,
      false,
      '"active" must not bypass CAS on hashed/timestamped proposal'
    );
    assert.equal(
      studioBridgeMod.handleRemoteOpusDismiss({ cascadeId: cid, proposalId: 'ts-99999' }, { opusOpts: { proposalsDir } }).matched,
      false,
      'mismatched ts-<n> must not dismiss'
    );
    // Empty-hash debug proposal must not be dismissed by stale hash
    opusService.writeOpusGateProposal(
      cid,
      { kind: 'debug', reason: 'Error burst', diffHash: '', ts: 20002 },
      { proposalsDir }
    );
    assert.equal(
      studioBridgeMod.handleRemoteOpusDismiss({ cascadeId: cid, proposalId: 'hashA111' }, { opusOpts: { proposalsDir } }).matched,
      false,
      'stale hash must not dismiss empty-hash debug proposal'
    );
    assert.equal(
      studioBridgeMod.handleRemoteOpusDismiss({ cascadeId: cid, proposalId: 'ts-20002' }, { opusOpts: { proposalsDir } }).matched,
      true
    );

    // projectResources extraction & hashed fallback projId + parallel usage stats
    fs.writeFileSync(
      path.join(nativeProjectsDir, 'p-res.json'),
      JSON.stringify({
        id: 'proj-from-resources',
        name: 'Resources Repo',
        projectResources: { resources: [{ workspaceFolderAbsoluteUri: `file://${projKnown}` }] },
      })
    );
    let wtStarted = false;
    let usageStarted = false;
    let bothConcurrent = false;
    let relWt;
    let relUsage;
    const overviewPromise = studioBridgeMod.collectStudioOverview(
      {},
      {
        authorizedDirs: [projKnown, projUnmatched],
        nativeProjectsDir,
        listRepoWorktreesAsync: () =>
          new Promise((resolve) => {
            wtStarted = true;
            if (usageStarted) bothConcurrent = true;
            const done = () => resolve({ ok: true, worktrees: [] });
            if (relWt) done();
            else relWt = done;
          }),
        collectUsageStatsAsync: () =>
          new Promise((resolve) => {
            usageStarted = true;
            if (wtStarted) bothConcurrent = true;
            const done = () => resolve({ ok: true, days: [] });
            if (relUsage) done();
            else relUsage = done;
          }),
      }
    );
    await new Promise((r) => setTimeout(r, 20));
    relWt?.();
    relUsage?.();
    const overview = await overviewPromise;
    assert.equal(bothConcurrent, true, 'collectUsageStatsAsync must run concurrently with listRepoWorktreesAsync');
    assert.equal(overview.projects[0].id, 'proj-from-resources');
    assert.match(overview.projects[1].id, /^proj-[0-9a-f]{12}$/);
    assert.equal(overview.projects[1].id.includes('secret-user-path'), false);

    // ws-server.mjs passes explicit UDS timeouts >= studio-bridge budgets
    const wsServerSrc = fs.readFileSync(path.join(GW_DIR, 'ws-server.mjs'), 'utf8');
    assert.match(wsServerSrc, /request\(\s*'convo\.resumeState'[\s\S]*?timeoutMs:\s*6500/);
    assert.match(wsServerSrc, /request\(\s*'studio\.overview'[\s\S]*?timeoutMs:\s*8500/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 2 static invariants: 7 gateway files, <2000 lines, Zero-XSS across all PWA modules & zero :has()', () => {
  const gwFiles = fs.readdirSync(GW_DIR).filter((f) => f.endsWith('.mjs'));
  assert.equal(gwFiles.length, 7, 'remote/gateway/*.mjs must remain strictly 7 files');

  const filesToCheck = [
    path.join(REPO, 'core', 'daemon', 'remote', 'cascade-lock.mjs'),
    path.join(REPO, 'core', 'daemon', 'remote', 'studio-bridge.mjs'),
    path.join(REPO, 'core', 'daemon', 'remote-bridge.mjs'),
    path.join(REPO, 'user', 'src', 'modules', 'remote-tap.mjs'),
    path.join(GW_DIR, 'ws-server.mjs'),
    path.join(PWA_DIR, 'src', 'studio-panel.mjs'),
    path.join(PWA_DIR, 'src', 'overview-panel.mjs'),
    path.join(PWA_DIR, 'src', 'app.mjs'),
    path.join(PWA_DIR, 'src', 'ws-client.mjs'),
  ];
  for (const abs of filesToCheck) {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    const src = fs.readFileSync(abs, 'utf8');
    assert.ok(src.split('\n').length < 2000, `${path.relative(REPO, abs)} must stay < 2000 lines`);
  }

  const pwaSrcFiles = fs.readdirSync(path.join(PWA_DIR, 'src')).filter((f) => f.endsWith('.mjs'));
  assert.ok(pwaSrcFiles.length > 0);
  for (const fname of pwaSrcFiles) {
    const src = fs.readFileSync(path.join(PWA_DIR, 'src', fname), 'utf8');
    assert.equal(
      /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/.test(src),
      false,
      `PWA module ${fname} must not contain XSS sinks`
    );
  }
  const cssSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'styles.css'), 'utf8');
  assert.equal(cssSrc.includes(':has('), false);

  const appSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'app.mjs'), 'utf8');
  assert.match(appSrc, /workspaceRefs\s*=\s*\{\s*topbar,/);
});

test('Phase 2 PWA shell regressions: Markdown Zero-XSS & stale IDLE stream suppression', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = dom.window.document;

  try {
    const timelineMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'timeline-view.mjs')).href);
    const mdNode = timelineMod.renderSafeMarkdown([
      '### 总结',
      '- **重点**：查看 [app.mjs](file:///Users/demo/app.mjs#L10) 与 [Docs](https://example.com/docs)',
      '- XSS: [bad](javascript:alert(1)) <script>alert(2)</script> `inline()`',
      '```js',
      'const x = 1;',
      '```',
    ].join('\n'));

    assert.equal(mdNode.querySelector('script'), null, 'Zero-XSS: never create <script> elements');
    assert.ok(mdNode.querySelector('.rc-md-h[data-level="3"]'));
    assert.equal(mdNode.querySelector('.rc-md-file')?.textContent, 'app.mjs');
    const extLink = mdNode.querySelector('a.rc-md-link');
    assert.equal(extLink?.getAttribute('href'), 'https://example.com/docs');
    assert.equal(extLink?.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(mdNode.querySelector('a[href^="javascript:"]'), null, 'javascript: links must be blocked');
    assert.equal(mdNode.querySelector('code.rc-md-code')?.textContent, 'inline()');
    assert.equal(mdNode.querySelector('pre.rc-pre')?.textContent, 'const x = 1;');

    // IDLE conversation must NOT render orange .rc-stream-card even if stale stream entry exists
    const cid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const doc = dom.window.document;
    const refs = {
      detailTitle: doc.createElement('h2'),
      detailSub: doc.createElement('div'),
      timeline: doc.createElement('div'),
    };
    const state = {
      selectedId: cid,
      identity: { role: 'observe' },
      hostAttached: true,
      wsStatus: 'connected',
      conversations: [{ id: cid, title: 'Completed Chat', status: 'IDLE', waitingSteps: [] }],
      snapshots: new Map([
        [cid, { cascadeId: cid, status: 'IDLE', steps: [{ idx: 1, type: 'PLANNER_RESPONSE', status: 'DONE', text: 'Done' }], waitingSteps: [] }],
      ]),
      streams: new Map([[cid, { stepIdx: 1, text: 'Stale leftover text', thinkingText: '', status: 'DONE' }]]),
      studioOverview: null,
      snapshotLoading: false,
      snapshotError: '',
      approvingHash: '',
    };
    timelineMod.renderDetailTimeline({ state, refs, onSelectConversation: () => {}, onApprove: () => {} });
    assert.equal(refs.timeline.querySelector('.rc-stream-card'), null, 'IDLE snapshot must suppress .rc-stream-card');

    // RUNNING conversation DOES render .rc-stream-card
    state.snapshots.get(cid).status = 'RUNNING';
    state.streams.get(cid).status = 'RUNNING';
    timelineMod.renderDetailTimeline({ state, refs, onSelectConversation: () => {}, onApprove: () => {} });
    assert.ok(refs.timeline.querySelector('.rc-stream-card'), 'RUNNING snapshot should render .rc-stream-card');

    // No literal "null" text in detailSub when wtMeta.branch is absent
    assert.equal(refs.detailSub.textContent.includes('null'), false, 'detailSub must not contain literal "null"');

    // Nested inline Markdown inside **bold**
    const nestedMd = timelineMod.renderSafeMarkdown('回归测试（**隔离工作树 `8d1b3f0` 内查看 [sw.js](file:///tmp/sw.js)**）');
    const strongEl = nestedMd.querySelector('strong');
    assert.ok(strongEl, 'expected <strong> element for bold span');
    assert.equal(strongEl.querySelector('code.rc-md-code')?.textContent, '8d1b3f0');
    assert.equal(strongEl.querySelector('code.rc-md-file')?.textContent, 'sw.js');
    assert.equal(strongEl.textContent.includes('`'), false, 'nested inline code must not leave raw backticks inside <strong>');

    // renderOpusGateBanner & renderResumeBanner must not emit literal "null"
    const studioPanelMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'studio-panel.mjs')).href);
    const opusContainer = doc.createElement('div');
    studioPanelMod.renderOpusGateBanner(opusContainer, {
      opusGate: { proposal: { id: 'p-1', kind: 'plan', recommendedTier: 'high', summary: 'Plan finalized' } },
      canWrite: false,
    });
    assert.equal(opusContainer.textContent.includes('null'), false, 'Opus Gate banner must not contain literal "null"');

    const resumeContainer = doc.createElement('div');
    studioPanelMod.renderResumeBanner(resumeContainer, {
      resumeState: { interrupted: true, active: false, lastIdx: 7, reason: 'interrupted' },
      canWrite: true,
      online: true,
      needTurboConfirm: false,
    });
    assert.equal(resumeContainer.textContent.includes('null'), false, 'Resume banner must not contain literal "null"');
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    dom.window.close();
  }
});

test('Phase 2 Dual-Form UI regressions: layout mode, Overview panel, code copy & step data-role', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = dom.window.document;

  try {
    const helpersMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'ui-helpers.mjs')).href);
    const overviewMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'overview-panel.mjs')).href);
    const timelineMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'timeline-view.mjs')).href);

    // 1. resolveLayoutMode & formatResetCountdown
    assert.equal(helpersMod.resolveLayoutMode('auto', 1280), 'desktop');
    assert.equal(helpersMod.resolveLayoutMode('auto', 390), 'mobile');
    assert.equal(helpersMod.resolveLayoutMode('desktop', 390), 'desktop');
    assert.equal(helpersMod.resolveLayoutMode('mobile', 1440), 'mobile');
    assert.equal(helpersMod.formatResetCountdown(2700), '45m');
    assert.equal(helpersMod.formatResetCountdown(12000), '3h 20m');
    assert.equal(helpersMod.formatResetCountdown(0), '');

    // 2. renderOverviewPanel
    const ovRoot = dom.window.document.createElement('aside');
    let filteredPid = '';
    overviewMod.renderOverviewPanel(ovRoot, {
      overview: {
        quota: {
          tierName: 'Ultra',
          claude: { fiveHourRemainingPct: 92, weeklyRemainingPct: 79, fiveHourResetSec: 3600, weeklyResetSec: 172800 },
          gemini: { fiveHourRemainingPct: 80, weeklyRemainingPct: 90, fiveHourResetSec: 1800, weeklyResetSec: 86400 },
        },
        todayUsage: {
          date: '2026-11-26',
          requests: 120,
          totalTokens: 1_500_000,
          uncached: 150_000,
          cacheRead: 850_000,
          output: 500_000,
        },
        projects: [
          { id: 'proj-maga', name: 'MAGA', shortPath: '~/Developer/MAGA', worktrees: [{ branch: 'main', isMain: true }] },
        ],
        worktreeByCid: {
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1': { branch: 'feat/remote-dual-ui', repoName: 'MAGA', projectId: 'proj-maga' },
        },
        activeCascade: {
          cascadeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          opusGate: { proposal: { id: 'p-1' } },
          autoCompact: { pending: null },
        },
      },
      selectedConvo: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', title: 'Dual UI Test', status: 'IDLE', stepCount: 12 },
      snapshot: { cascadeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', status: 'IDLE', source: 'cdp', steps: [{ idx: 1 }] },
      selectedProjectId: '',
      onSelectProject: (pid) => {
        filteredPid = pid;
      },
    });
    assert.equal(ovRoot.querySelectorAll('.rc-meter-fill').length, 4);
    assert.match(ovRoot.textContent, /1\.5M tok/);
    assert.match(ovRoot.textContent, /缓存 85%/);
    assert.match(ovRoot.textContent, /feat\/remote-dual-ui/);
    assert.equal(ovRoot.textContent.includes('null'), false, 'Overview panel must never emit literal "null"');
    const projBtn = Array.from(ovRoot.querySelectorAll('button')).find((b) => b.textContent === '筛选');
    assert.ok(projBtn, 'expected project filter button in Overview panel');
    projBtn.click();
    assert.equal(filteredPid, 'proj-maga');

    // 3. Fenced code block wrapper with copy button + untouched pre.rc-pre textContent
    const codeMd = timelineMod.renderSafeMarkdown('```ts\nconst answer = 42;\n```');
    assert.ok(codeMd.querySelector('.rc-code-block'));
    assert.equal(codeMd.querySelector('.rc-code-head .rc-code-lang')?.textContent, 'ts');
    assert.ok(codeMd.querySelector('.rc-code-head .rc-code-copy'));
    assert.equal(codeMd.querySelector('pre.rc-pre')?.textContent, 'const answer = 42;');

    // 4. renderStepCard data-role attribute
    const userCard = timelineMod.renderStepCard({ idx: 1, type: 'USER_INPUT', status: 'DONE', text: 'Hi' });
    const botCard = timelineMod.renderStepCard({ idx: 2, type: 'PLANNER_RESPONSE', status: 'DONE', text: 'Hello' });
    const toolCard = timelineMod.renderStepCard({ idx: 3, type: 'GENERIC', status: 'DONE', toolCalls: [] });
    assert.equal(userCard.getAttribute('data-role'), 'user');
    assert.equal(botCard.getAttribute('data-role'), 'assistant');
    assert.equal(toolCard.getAttribute('data-role'), 'tool');

    // 5. Dual-UI polish regressions: Overview sync on host_status/onStatus, auto-refresh & read-only dock CSS
    const appSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'app.mjs'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'styles.css'), 'utf8');
    assert.match(appSrc, /if\s*\(kind\s*===\s*'host_status'\)[\s\S]*?renderStudioPanels\(\)/);
    assert.match(appSrc, /if\s*\(!wasAttached\s*&&\s*state\.hostAttached\)\s*\{\s*refreshAllData\(\);/);
    assert.match(appSrc, /onStatus:[\s\S]*?renderStudioPanels\(\)/);
    assert.ok(cssSrc.includes('.rc-composer-card[data-writable="false"]'));
    assert.ok(cssSrc.includes('.rc-group-subagent'));
    assert.equal(cssSrc.includes(':has('), false);
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    dom.window.close();
  }
});
