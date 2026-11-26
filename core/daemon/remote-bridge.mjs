/**
 * AGY Studio Remote Control — Daemon-side Bridge Facade, Host Tap & UDS NDJSON RPC Server
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync, REPO_ROOT, UUID_RE, attachedTargets, runtimeState } from './env.mjs';
import { isPathInsideDir } from './projects.mjs';
import {
  DEFAULT_REMOTE_CONFIG,
  MAX_FIELD_CHARS,
  applySnapshotByteBudget,
  computeWaitingStepHash,
  ensureRemoteDir,
  normalizeWaitingStepsWithSha,
  readConversationListFromDisk,
  readConversationSnapshotFromDisk,
  readDiskGlobalPreset,
  resolveRemotePaths
} from './remote/disk-fallback.mjs';
import {
  reclaimOrphanGateway,
  reconcileGatewayProcess,
  stopGatewayChildGracefully,
  stopGatewayChildSync
} from './remote/gateway-supervisor.mjs';
import { withCascadeWriteLock } from './remote/cascade-lock.mjs';
import {
  SILENT_RESUME_PROMPT,
  collectStudioOverview,
  getRemoteResumeState,
  handleRemoteOpusDismiss
} from './remote/studio-bridge.mjs';
import { collectResumeState } from '../../studio/daemon/resume-detector.mjs';

export {
  DEFAULT_REMOTE_CONFIG,
  computeWaitingStepHash,
  readConversationListFromDisk,
  readConversationSnapshotFromDisk,
  readDiskGlobalPreset,
  resolveRemotePaths
};

const MAX_ACTIVE_STREAMS = 3;
const MAX_UDS_LINE_BYTES = 1024 * 1024;
const WRITE_UDS_METHODS = new Set(['convo.send', 'convo.approve', 'convo.cancel', 'convo.resume', 'convo.compact', 'opus.dismiss']);
const TAP_INVOKE_METHODS = new Set(['convo.owns', 'convo.send', 'convo.approve', 'convo.cancel', 'convo.compact']);

let bridgeState = null;

function getConfirmedHostEntries() {
  const pages = [];
  for (const [, entry] of attachedTargets.entries()) {
    if (entry?.hostConfirmed && entry.type === 'page' && entry.ws?.readyState === WebSocket.OPEN) {
      pages.push(entry);
    }
  }
  return pages;
}

function scoreHostCapabilities(tapCap) {
  if (!tapCap || !tapCap.capabilities) return -1;
  const c = tapCap.capabilities;
  return (
    (c.reduxSummaries ? 8 : 0) +
    (c.agentStream ? 4 : 0) +
    (c.sendMessage ? 2 : 0) +
    (c.approval ? 2 : 0) +
    (c.cancel ? 1 : 0)
  );
}

function pickPrimaryHostEntry() {
  const hosts = getConfirmedHostEntries();
  if (hosts.length === 0) return null;
  if (hosts.length === 1) return hosts[0];
  let best = hosts[0];
  let bestScore = typeof best._remoteCapScore === 'number' ? best._remoteCapScore : -1;
  for (const h of hosts) {
    const score = typeof h._remoteCapScore === 'number' ? h._remoteCapScore : -1;
    if (score > bestScore) {
      best = h;
      bestScore = score;
    }
  }
  return best;
}

async function resolvePrimaryHostEntry() {
  const hosts = getConfirmedHostEntries();
  if (hosts.length === 0) return null;
  if (hosts.length === 1) {
    const only = hosts[0];
    const r = await evalOnHost(only, 'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null', 2500);
    if (r.ok && r.value && typeof r.value === 'object') {
      only._remoteCap = r.value;
      only._remoteCapScore = scoreHostCapabilities(r.value);
    }
    return only;
  }
  const results = await Promise.all(
    hosts.map(async (entry) => {
      const r = await evalOnHost(entry, 'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null', 2500);
      const cap = r.ok && r.value && typeof r.value === 'object' ? r.value : null;
      if (cap) {
        entry._remoteCap = cap;
        entry._remoteCapScore = scoreHostCapabilities(cap);
      }
      return { entry, score: cap ? scoreHostCapabilities(cap) : -1 };
    })
  );
  results.sort((a, b) => b.score - a.score);
  return results[0]?.entry || hosts[0];
}

async function evalOnHost(entry, expression, timeoutMs = 4500) {
  if (!entry?.hostConfirmed || entry.ws?.readyState !== WebSocket.OPEN) {
    return { ok: false, error: 'host_not_ready' };
  }
  const params = {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(entry.trustedContextId !== null ? { contextId: entry.trustedContextId } : {})
  };
  try {
    const res = await entry.send('Runtime.evaluate', params, timeoutMs);
    if (res?.exceptionDetails) {
      return { ok: false, error: res.exceptionDetails.text || 'cdp_eval_exception' };
    }
    return { ok: true, value: res?.result?.result?.value ?? null };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

function serializeEvalJson(val) {
  return JSON.stringify(val).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

async function invokeTapOnHost(entry, method, payload, timeoutMs = 8000) {
  if (!TAP_INVOKE_METHODS.has(method)) {
    return { ok: false, error: 'disallowed_invoke_method' };
  }
  const expr = `window.__agRemoteTap && typeof window.__agRemoteTap.invoke === 'function' ? window.__agRemoteTap.invoke(${serializeEvalJson(method)}, ${serializeEvalJson(payload)}) : { ok: false, error: "tap_invoke_unavailable" }`;
  return evalOnHost(entry, expr, timeoutMs);
}

async function resolveHostForCascade(cascadeId) {
  const hosts = getConfirmedHostEntries();
  if (hosts.length === 0) {
    throw Object.assign(new Error('host_not_attached'), { code: 'host_not_attached' });
  }
  if (hosts.length === 1) return hosts[0];
  const checks = await Promise.all(
    hosts.map(async (entry) => {
      const [ownRes, capRes] = await Promise.all([
        invokeTapOnHost(entry, 'convo.owns', { cascadeId }, 2000),
        entry._remoteCap
          ? Promise.resolve({ ok: true, value: entry._remoteCap })
          : evalOnHost(entry, 'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null', 1500),
      ]);
      if (!entry._remoteCap && capRes?.ok && capRes.value && typeof capRes.value === 'object') {
        entry._remoteCap = capRes.value;
        entry._remoteCapScore = scoreHostCapabilities(capRes.value);
      }
      const owned = Boolean(ownRes.ok && ownRes.value?.ok && ownRes.value.owned);
      const active = Boolean(ownRes.ok && ownRes.value?.ok && ownRes.value.active);
      const ownRank = owned ? (active ? 3 : 2) : 0;
      const capScore = typeof entry._remoteCapScore === 'number' ? entry._remoteCapScore : -1;
      return { entry, ownRank, capScore };
    })
  );
  checks.sort((a, b) => (b.ownRank !== a.ownRank ? b.ownRank - a.ownRank : b.capScore - a.capScore));
  return checks[0].entry;
}

function isSafeNonTurboPreset(preset) {
  if (typeof preset === 'boolean' || preset === null || preset === undefined) return false;
  if (typeof preset === 'string' && !/^\d+$/.test(preset.trim())) return false;
  const n = Number(preset);
  return n === 1 || n === 2;
}

function isTurboPreset(preset) {
  return !isSafeNonTurboPreset(preset);
}

function verifyUdsWriteToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function probeRemoteCapabilities() {
  const hosts = getConfirmedHostEntries();
  const primary = await resolvePrimaryHostEntry();
  const diskPreset = readDiskGlobalPreset();
  const state = bridgeState;

  const base = {
    ok: true,
    hostAttached: hosts.length > 0,
    hostCount: hosts.length,
    capabilities: {
      reduxSummaries: false,
      agentStream: false,
      sendMessage: false,
      cancel: false,
      approval: false,
      compact: false,
      resume: true,
      diskRead: Boolean(DatabaseSync)
    },
    agVersion: null,
    globalPreset: diskPreset,
    tapActive: Boolean(state?.tapDesiredActive ?? state?.tapActive),
    activeStreams: state ? Array.from(state.watchedStreams.keys()) : []
  };

  if (!primary) return base;

  const capRes = await evalOnHost(primary, 'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null', 2500);
  const liveCap = capRes.ok && capRes.value && typeof capRes.value === 'object' ? capRes.value : null;
  if (liveCap) {
    primary._remoteCap = liveCap;
    primary._remoteCapScore = scoreHostCapabilities(liveCap);
  }
  const tapCap = liveCap || primary._remoteCap || null;
  if (!tapCap || typeof tapCap !== 'object') return base;

  return {
    ok: true,
    hostAttached: true,
    hostCount: hosts.length,
    capabilities: {
      reduxSummaries: Boolean(tapCap.capabilities?.reduxSummaries),
      agentStream: Boolean(tapCap.capabilities?.agentStream),
      sendMessage: Boolean(tapCap.capabilities?.sendMessage),
      cancel: Boolean(tapCap.capabilities?.cancel),
      approval: Boolean(tapCap.capabilities?.approval),
      compact: Boolean(tapCap.capabilities?.compact),
      resume: true,
      diskRead: Boolean(DatabaseSync)
    },
    agVersion: tapCap.agVersion || null,
    globalPreset: tapCap.globalPreset ?? null,
    tapActive: Boolean(state ? state.tapActive && tapCap.tapActive : tapCap.tapActive),
    activeStreams: state ? Array.from(state.watchedStreams.keys()) : tapCap.activeStreams || []
  };
}

function broadcastTapEvent(kind, data) {
  if (!bridgeState) return;
  const line = `${JSON.stringify({
    event: 'tap',
    payload: {
      kind,
      ts: Date.now(),
      data
    }
  })}\n`;
  for (const client of bridgeState.clients.keys()) {
    if (!client.destroyed && client.writable) {
      try {
        client.write(line);
      } catch {}
    }
  }
}

async function applyTapStateToHost(entry, active, skipWatchCid = null) {
  if (!entry?.hostConfirmed || entry.type !== 'page' || !entry.rpcToken) return false;
  if (active) {
    const r = await evalOnHost(
      entry,
      `window.__agRemoteTap ? window.__agRemoteTap.enable(${JSON.stringify({ token: entry.rpcToken, throttleMs: 150 })}) : { ok: false }`,
      3000
    );
    if (!r.ok || !r.value?.ok) return false;
    if (bridgeState) {
      for (const cid of bridgeState.watchedStreams.keys()) {
        if (skipWatchCid && cid === skipWatchCid) continue;
        await evalOnHost(
          entry,
          `window.__agRemoteTap ? window.__agRemoteTap.watch(${JSON.stringify(cid)}) : { ok: false }`,
          3000
        );
      }
    }
    return true;
  }
  await evalOnHost(entry, 'window.__agRemoteTap ? window.__agRemoteTap.disable() : { ok: true }', 2500);
  return true;
}

async function setTapActive(active, { skipWatchCid = null } = {}) {
  if (!bridgeState) return { ok: false, active: false };
  const next = Boolean(active);
  bridgeState.tapDesiredActive = next;
  const hosts = getConfirmedHostEntries();
  if (!next) {
    bridgeState.tapActive = false;
    bridgeState.activeTapTargetId = null;
    bridgeState.tapRetryNextAt = 0;
    bridgeState.tapRetryBackoffMs = 2000;
    bridgeState.watchedStreams.clear();
    await Promise.allSettled(hosts.map((entry) => applyTapStateToHost(entry, false)));
    return { ok: true, active: false };
  }
  const primary = await resolvePrimaryHostEntry();
  let applied = false;
  if (primary) {
    bridgeState.activeTapTargetId = primary.id;
    const results = await Promise.allSettled(
      hosts.map((entry) => applyTapStateToHost(entry, entry.id === primary.id, skipWatchCid))
    );
    const pIdx = hosts.indexOf(primary);
    applied = pIdx !== -1 && results[pIdx]?.status === 'fulfilled' && results[pIdx].value === true;
    bridgeState.tapActive = applied;
    if (!applied) {
      bridgeState.tapRetryBackoffMs = 2000;
      bridgeState.tapRetryNextAt = Date.now() + 2000;
    } else {
      bridgeState.tapRetryBackoffMs = 2000;
      bridgeState.tapRetryNextAt = 0;
    }
  } else {
    bridgeState.tapActive = false;
  }
  return { ok: true, active: next, tapEnabledOnHost: applied };
}

async function handleConvoList(params = {}) {
  const includeSubagents = Boolean(params?.includeSubagents);
  const primary = await resolvePrimaryHostEntry();
  if (primary) {
    const r = await evalOnHost(
      primary,
      `window.__agRemoteTap ? window.__agRemoteTap.listSummaries(${JSON.stringify({ includeSubagents })}) : null`,
      4500
    );
    if (r.ok && r.value?.ok && Array.isArray(r.value.conversations)) {
      const conversations = r.value.conversations.map((c) => ({
        id: String(c.id || ''),
        title: String(c.title || ''),
        summary: String(c.summary || ''),
        status: String(c.status || 'IDLE'),
        stepCount: Number(c.stepCount || 0),
        lastModifiedTime: String(c.lastModifiedTime || ''),
        projectId: String(c.projectId || ''),
        parentConversationId: String(c.parentConversationId || ''),
        waitingSteps: normalizeWaitingStepsWithSha(c.id, c.waitingSteps),
        ...(Array.isArray(c.waitingSubagents) && c.waitingSubagents.length > 0
          ? {
              waitingSubagents: c.waitingSubagents.map((sub) => ({
                id: String(sub.id || ''),
                title: String(sub.title || ''),
                waitingSteps: normalizeWaitingStepsWithSha(sub.id, sub.waitingSteps)
              }))
            }
          : {})
      }));
      return {
        source: 'cdp',
        globalPreset: r.value.globalPreset ?? readDiskGlobalPreset(),
        conversations,
        ...(r.value.byParent ? { byParent: r.value.byParent } : {})
      };
    }
  }
  return readConversationListFromDisk({ includeSubagents });
}

async function handleConvoSnapshot(params = {}) {
  const cascadeId = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  const rawBefore = params?.beforeIdx;
  const beforeIdx =
    rawBefore !== undefined && rawBefore !== null && Number.isInteger(Number(rawBefore)) && Number(rawBefore) >= 0
      ? Number(rawBefore)
      : null;

  const primary = await resolvePrimaryHostEntry();
  if (primary) {
    const tapOpts = beforeIdx !== null ? { beforeIdx } : {};
    const r = await evalOnHost(
      primary,
      `window.__agRemoteTap ? window.__agRemoteTap.getSnapshot(${JSON.stringify(cascadeId)}, ${JSON.stringify(tapOpts)}) : null`,
      6000
    );
    if (r.ok && r.value?.ok && Array.isArray(r.value.steps)) {
      const snapStatus = String(r.value.status || 'IDLE');
      const waitingSteps = normalizeWaitingStepsWithSha(cascadeId, r.value.waitingSteps);
      const snap = applySnapshotByteBudget({
        cascadeId,
        source: 'cdp',
        status: snapStatus,
        steps: r.value.steps,
        hasMore: Boolean(r.value.hasMore),
        nextBeforeIdx: Number.isInteger(r.value.nextBeforeIdx) ? r.value.nextBeforeIdx : null,
        waitingSteps,
        streamingText: String(r.value.streamingText || '')
      });
      snap.resumeState = getRemoteResumeState(cascadeId, {
        liveBusy: /RUNNING|BUSY|CANCEL/i.test(snapStatus),
        liveWaiting: waitingSteps.length > 0,
        ...(bridgeState?.conversationsDir ? { conversationsDir: bridgeState.conversationsDir } : {}),
      });
      return snap;
    }
  }
  const disk = readConversationSnapshotFromDisk(cascadeId, { beforeIdx });
  if (disk.ok === false) {
    throw Object.assign(new Error(disk.error || 'snapshot_failed'), { code: disk.error || 'snapshot_failed' });
  }
  disk.resumeState = getRemoteResumeState(cascadeId, {
    liveBusy: /RUNNING|BUSY|CANCEL/i.test(String(disk.status || '')),
    liveWaiting: Array.isArray(disk.waitingSteps) && disk.waitingSteps.length > 0,
    ...(bridgeState?.conversationsDir ? { conversationsDir: bridgeState.conversationsDir } : {}),
  });
  return disk;
}

async function handleConvoWatch(client, params = {}) {
  if (!bridgeState) throw new Error('bridge_not_initialized');
  const cascadeId = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  const watch = Boolean(params?.watch);
  const clientSet = bridgeState.clients.get(client);
  const streams = bridgeState.watchedStreams;

  if (watch) {
    let streamEntry = streams.get(cascadeId);
    if (!streamEntry) {
      if (streams.size >= MAX_ACTIVE_STREAMS) {
        throw Object.assign(new Error('max_streams_reached'), { code: 'max_streams_reached' });
      }
      const primary =
        (bridgeState.activeTapTargetId &&
          getConfirmedHostEntries().find((e) => e.id === bridgeState.activeTapTargetId)) ||
        pickPrimaryHostEntry();
      if (!primary) {
        throw Object.assign(new Error('no_host_attached'), { code: 'no_host_attached' });
      }

      streamEntry = { owners: new Set([client]), readyPromise: null };
      streams.set(cascadeId, streamEntry);
      clientSet?.add(cascadeId);

      streamEntry.readyPromise = (async () => {
        if (!bridgeState) throw new Error('bridge_closed');
        if (!bridgeState.tapActive || bridgeState.activeTapTargetId !== primary.id) {
          await setTapActive(true, { skipWatchCid: cascadeId });
        }
        const target =
          getConfirmedHostEntries().find((e) => e.id === bridgeState.activeTapTargetId) ||
          (await resolvePrimaryHostEntry());
        if (!target) {
          throw Object.assign(new Error('no_host_attached'), { code: 'no_host_attached' });
        }
        const r = await evalOnHost(
          target,
          `window.__agRemoteTap ? window.__agRemoteTap.watch(${JSON.stringify(cascadeId)}) : { ok: false, error: "tap_not_mounted" }`,
          4000
        );
        if (!r.ok || !r.value?.ok) {
          throw Object.assign(new Error(r.value?.error || r.error || 'watch_failed'), {
            code: r.value?.error || r.error || 'watch_failed'
          });
        }
      })();
    } else {
      streamEntry.owners.add(client);
      clientSet?.add(cascadeId);
    }

    try {
      await streamEntry.readyPromise;
    } catch (err) {
      streamEntry.owners.delete(client);
      clientSet?.delete(cascadeId);
      if (streamEntry.owners.size === 0 && streams.get(cascadeId) === streamEntry) {
        streams.delete(cascadeId);
      }
      throw err;
    }

    if (client.destroyed) {
      await handleConvoWatch(client, { cascadeId, watch: false }).catch(() => {});
      throw Object.assign(new Error('client_closed'), { code: 'client_closed' });
    }
    return { ok: true, watching: true, activeStreams: Array.from(streams.keys()) };
  }

  clientSet?.delete(cascadeId);
  const streamEntry = streams.get(cascadeId);
  if (streamEntry) {
    streamEntry.owners.delete(client);
    if (streamEntry.owners.size === 0) {
      streams.delete(cascadeId);
      const hosts = getConfirmedHostEntries();
      await Promise.allSettled(
        hosts.map((entry) =>
          evalOnHost(
            entry,
            `window.__agRemoteTap ? window.__agRemoteTap.unwatch(${JSON.stringify(cascadeId)}, true) : { ok: true }`,
            3000
          )
        )
      );
    }
  }
  return { ok: true, watching: streams.has(cascadeId), activeStreams: Array.from(streams.keys()) };
}

async function releaseClientWatches(client) {
  if (!bridgeState) return;
  const watched = bridgeState.clients.get(client);
  if (!watched) return;
  for (const cid of Array.from(watched)) {
    await handleConvoWatch(client, { cascadeId: cid, watch: false }).catch(() => {});
  }
}

async function handleConvoSend(params = {}) {
  const cascadeId = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  if (typeof params?.text !== 'string') {
    throw Object.assign(new Error('invalid_text'), { code: 'invalid_text' });
  }
  const text = params.text;
  if (!text.trim() || text.length > MAX_FIELD_CHARS) {
    throw Object.assign(new Error('invalid_text_length'), { code: 'invalid_text_length' });
  }

  return withCascadeWriteLock(
    cascadeId,
    'remote:send',
    async () => {
      const host = await resolveHostForCascade(cascadeId);
      const capRes = await evalOnHost(host, 'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null', 2000);
      const preset = capRes.ok && capRes.value && typeof capRes.value === 'object' ? capRes.value.globalPreset : null;
      if (isTurboPreset(preset) && params.turboWriteConfirmed !== true) {
        throw Object.assign(new Error('turbo_write_confirmation_required'), { code: 'turbo_write_confirmation_required' });
      }

      const r = await invokeTapOnHost(
        host,
        'convo.send',
        { cascadeId, text, turboWriteConfirmed: Boolean(params.turboWriteConfirmed) },
        10000
      );
      if (!r.ok || !r.value?.ok) {
        const errCode = r.value?.error || r.error || 'send_failed';
        throw Object.assign(new Error(errCode), { code: errCode });
      }
      return r.value;
    },
    { markCooldownOnSuccess: true }
  );
}

async function handleConvoApprove(params = {}) {
  const cascadeId = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  const decision = params?.decision;
  if (decision !== 'allow_once' && decision !== 'deny') {
    throw Object.assign(new Error('invalid_decision'), { code: 'invalid_decision' });
  }
  const stepIndex = params?.stepIndex;
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    throw Object.assign(new Error('invalid_step_index'), { code: 'invalid_step_index' });
  }
  const waitingStepHash = typeof params?.waitingStepHash === 'string' ? params.waitingStepHash.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{16}$/.test(waitingStepHash)) {
    throw Object.assign(new Error('invalid_waiting_step_hash'), { code: 'invalid_waiting_step_hash' });
  }

  return withCascadeWriteLock(cascadeId, 'remote:approve', async () => {
    const host = await resolveHostForCascade(cascadeId);
    const r = await invokeTapOnHost(
      host,
      'convo.approve',
      { cascadeId, stepIndex, waitingStepHash, decision },
      10000
    );
    if (!r.ok || !r.value?.ok) {
      const errCode = r.value?.error || r.error || 'approve_failed';
      throw Object.assign(new Error(errCode), { code: errCode });
    }
    return r.value;
  });
}

async function handleConvoCancel(params = {}) {
  const cascadeId = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  return withCascadeWriteLock(cascadeId, 'remote:cancel', async () => {
    const host = await resolveHostForCascade(cascadeId);
    const r = await invokeTapOnHost(
      host,
      'convo.cancel',
      { cascadeId, killBackgroundTasks: Boolean(params?.killBackgroundTasks) },
      8000
    );
    if (!r.ok || !r.value?.ok) {
      const errCode = r.value?.error || r.error || 'cancel_failed';
      throw Object.assign(new Error(errCode), { code: errCode });
    }
    return r.value;
  });
}

async function handleConvoResumeState(params = {}) {
  const cascadeId = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  let liveBusy = false;
  let liveWaiting = false;
  const primary = await resolvePrimaryHostEntry();
  if (primary) {
    const r = await evalOnHost(
      primary,
      'window.__agRemoteTap ? window.__agRemoteTap.listSummaries({ includeSubagents: true }) : null',
      2500
    );
    const list = r.ok && r.value?.ok && Array.isArray(r.value.conversations) ? r.value.conversations : [];
    const sum = list.find((c) => c && c.id === cascadeId);
    if (sum) {
      liveBusy = /RUNNING|BUSY|CANCEL/i.test(String(sum.status || ''));
      liveWaiting = Array.isArray(sum.waitingSteps) && sum.waitingSteps.length > 0;
    }
  }
  return getRemoteResumeState(cascadeId, {
    liveBusy,
    liveWaiting,
    ...(bridgeState?.conversationsDir ? { conversationsDir: bridgeState.conversationsDir } : {}),
  });
}

async function handleConvoResume(params = {}) {
  const cascadeId = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  const expectedLastIdx = params?.expectedLastIdx;
  if (!Number.isInteger(expectedLastIdx) || expectedLastIdx < 0) {
    throw Object.assign(new Error('invalid_expected_last_idx'), { code: 'invalid_expected_last_idx' });
  }

  return withCascadeWriteLock(
    cascadeId,
    'remote:resume',
    async () => {
      const host = await resolveHostForCascade(cascadeId);
      const capRes = await evalOnHost(host, 'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null', 2000);
      const preset = capRes.ok && capRes.value && typeof capRes.value === 'object' ? capRes.value.globalPreset : null;
      if (isTurboPreset(preset) && params.turboWriteConfirmed !== true) {
        throw Object.assign(new Error('turbo_write_confirmation_required'), { code: 'turbo_write_confirmation_required' });
      }

      const st = collectResumeState(
        { cascadeId, force: true },
        bridgeState?.conversationsDir ? { conversationsDir: bridgeState.conversationsDir } : undefined
      );
      if (!st?.ok || !st.interrupted || st.lastIdx !== expectedLastIdx) {
        throw Object.assign(new Error('resume_state_changed'), { code: 'resume_state_changed' });
      }

      const r = await invokeTapOnHost(
        host,
        'convo.send',
        {
          cascadeId,
          text: SILENT_RESUME_PROMPT,
          turboWriteConfirmed: Boolean(params.turboWriteConfirmed),
        },
        10000
      );
      if (!r.ok || !r.value?.ok) {
        const errCode = r.value?.error || r.error || 'resume_failed';
        throw Object.assign(new Error(errCode), { code: errCode });
      }
      return {
        ok: true,
        cascadeId,
        resumedFromIdx: expectedLastIdx,
        reason: String(st.reason || 'aborted'),
      };
    },
    { markCooldownOnSuccess: true }
  );
}

async function handleConvoCompact(params = {}) {
  const cascadeId = typeof params?.cascadeId === 'string' ? params.cascadeId.trim() : '';
  if (!UUID_RE.test(cascadeId)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  return withCascadeWriteLock(
    cascadeId,
    'remote:compact',
    async () => {
      const host = await resolveHostForCascade(cascadeId);
      const r = await invokeTapOnHost(host, 'convo.compact', { cascadeId }, 8000);
      if (!r.ok || !r.value?.ok) {
        const errCode = r.value?.error || r.error || 'compact_failed';
        throw Object.assign(new Error(errCode), { code: errCode });
      }
      return r.value;
    },
    { markCooldownOnSuccess: true }
  );
}

async function handleStudioOverview(params = {}) {
  return collectStudioOverview(params, bridgeState?.studioOpts);
}

async function handleOpusDismiss(params = {}) {
  return handleRemoteOpusDismiss(params, bridgeState?.studioOpts);
}

async function dispatchUdsRpc(client, req) {
  const id = req?.id;
  const method = req?.method;
  const params = req?.params && typeof req.params === 'object' ? req.params : {};
  const reply = (ok, result = null, error = null) => {
    if (id === undefined || client.destroyed || !client.writable) return;
    try {
      client.write(`${JSON.stringify({ id, ok, result, error })}\n`);
    } catch {}
  };

  if (typeof method !== 'string' || !method) {
    reply(false, null, 'invalid_request');
    return;
  }

  if (WRITE_UDS_METHODS.has(method) && !verifyUdsWriteToken(req?.udsToken, bridgeState?.udsWriteToken)) {
    reply(false, null, 'uds_unauthorized');
    return;
  }

  try {
    if (method === 'bridge.health') {
      const res = await probeRemoteCapabilities();
      reply(true, res, null);
    } else if (method === 'tap.setActive') {
      const res = await setTapActive(Boolean(params.active));
      reply(true, res, null);
    } else if (method === 'convo.list') {
      const res = await handleConvoList(params);
      reply(true, res, null);
    } else if (method === 'convo.snapshot') {
      const res = await handleConvoSnapshot(params);
      reply(true, res, null);
    } else if (method === 'convo.watch') {
      const res = await handleConvoWatch(client, params);
      reply(true, res, null);
    } else if (method === 'convo.send') {
      const res = await handleConvoSend(params);
      reply(true, res, null);
    } else if (method === 'convo.approve') {
      const res = await handleConvoApprove(params);
      reply(true, res, null);
    } else if (method === 'convo.cancel') {
      const res = await handleConvoCancel(params);
      reply(true, res, null);
    } else if (method === 'convo.resumeState') {
      const res = await handleConvoResumeState(params);
      reply(true, res, null);
    } else if (method === 'convo.resume') {
      const res = await handleConvoResume(params);
      reply(true, res, null);
    } else if (method === 'convo.compact') {
      const res = await handleConvoCompact(params);
      reply(true, res, null);
    } else if (method === 'studio.overview') {
      const res = await handleStudioOverview(params);
      reply(true, res, null);
    } else if (method === 'opus.dismiss') {
      const res = await handleOpusDismiss(params);
      reply(true, res, null);
    } else {
      reply(false, null, 'method_not_supported');
    }
  } catch (err) {
    reply(false, null, String(err?.code || err?.message || err || 'rpc_error'));
  }
}

function safeUnlinkSocket(sockPath) {
  try {
    const lst = fs.lstatSync(sockPath);
    if (lst.isSocket()) {
      fs.rmSync(sockPath, { force: true });
    }
  } catch {}
}

function createUdsServer(sockPath, remoteDir) {
  try {
    const lst = fs.lstatSync(sockPath);
    if (lst.isSocket()) {
      fs.rmSync(sockPath, { force: true });
    } else {
      throw new Error(`refusing_to_unlink_non_socket:${sockPath}`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const parentDir = path.dirname(sockPath);
  if (parentDir === remoteDir || isPathInsideDir(remoteDir, sockPath)) {
    ensureRemoteDir(parentDir);
  } else {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const server = net.createServer((client) => {
    if (!bridgeState) {
      client.destroy();
      return;
    }
    bridgeState.clients.set(client, new Set());
    let buf = Buffer.alloc(0);

    client.on('data', (chunk) => {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length + piece.length > MAX_UDS_LINE_BYTES) {
        client.destroy();
        return;
      }
      buf = buf.length === 0 ? piece : Buffer.concat([buf, piece]);
      let nlIdx;
      while ((nlIdx = buf.indexOf(0x0a)) !== -1) {
        const line = buf.subarray(0, nlIdx).toString('utf8').trim();
        buf = buf.subarray(nlIdx + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        dispatchUdsRpc(client, req).catch(() => {});
      }
    });

    const cleanup = () => {
      releaseClientWatches(client)
        .catch(() => {})
        .finally(() => {
          bridgeState?.clients.delete(client);
        });
    };
    client.on('close', cleanup);
    client.on('error', cleanup);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {}
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function handleTapBindingEvent(parsed) {
  if (!bridgeState || !parsed || typeof parsed !== 'object') return;
  const kind = parsed.kind;
  if (kind !== 'summaries' && kind !== 'stream' && kind !== 'host_status') return;
  let data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
  if (kind === 'summaries' && Array.isArray(data.changed)) {
    data = {
      ...data,
      changed: data.changed.map((c) => ({
        ...c,
        waitingSteps: normalizeWaitingStepsWithSha(c.id, c.waitingSteps)
      }))
    };
  }
  broadcastTapEvent(kind, data);
}

async function retryTapIfNeeded() {
  if (!bridgeState || bridgeState.shuttingDown || !bridgeState.tapDesiredActive) return;
  if (Date.now() < bridgeState.tapRetryNextAt) return;
  const hosts = getConfirmedHostEntries();
  if (hosts.length === 0) return;

  const target =
    (bridgeState.activeTapTargetId && hosts.find((e) => e.id === bridgeState.activeTapTargetId)) ||
    (await resolvePrimaryHostEntry());
  if (!target) return;

  const capRes = await evalOnHost(
    target,
    'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null',
    2500
  );
  const cap = capRes.ok && capRes.value && typeof capRes.value === 'object' ? capRes.value : null;
  if (cap?.tapActive) {
    bridgeState.tapActive = true;
    bridgeState.activeTapTargetId = target.id;
    bridgeState.tapRetryBackoffMs = 2000;
    bridgeState.tapRetryNextAt = 0;
    return;
  }

  const ok = await applyTapStateToHost(target, true);
  if (ok) {
    bridgeState.tapActive = true;
    bridgeState.activeTapTargetId = target.id;
    bridgeState.tapRetryBackoffMs = 2000;
    bridgeState.tapRetryNextAt = 0;
    broadcastTapEvent('host_status', {
      hostAttached: true,
      hostCount: hosts.length,
      tapActive: true
    });
  } else {
    bridgeState.tapActive = false;
    const backoff = Math.min(10000, bridgeState.tapRetryBackoffMs || 2000);
    bridgeState.tapRetryNextAt = Date.now() + backoff;
    bridgeState.tapRetryBackoffMs = Math.min(10000, backoff * 2);
  }
}

export async function initRemoteBridge({ env = process.env, gatewayScript } = {}) {
  if (bridgeState) return bridgeState;
  const paths = resolveRemotePaths(env);
  ensureRemoteDir(paths.remoteDir);
  await reclaimOrphanGateway(paths.remoteDir);

  const udsServer = await createUdsServer(paths.sockPath, paths.remoteDir);

  const studioOpts = {};
  if (typeof env.ANTI_CLAUDE_STATE_DIR === 'string' && env.ANTI_CLAUDE_STATE_DIR.trim()) {
    const stDir = path.resolve(env.ANTI_CLAUDE_STATE_DIR.trim());
    studioOpts.opusOpts = {
      proposalsDir: path.join(stDir, 'opus-gate-proposals'),
      quotaStateFile: path.join(stDir, 'quota-state.json'),
    };
    studioOpts.quotaOpts = { quotaStateFile: path.join(stDir, 'quota-state.json') };
    studioOpts.compactOpts = { requestsDir: path.join(stDir, 'auto-compact-requests') };
  }
  const conversationsDir =
    typeof env.MAGA_REMOTE_CONV_DIR === 'string' && env.MAGA_REMOTE_CONV_DIR.trim()
      ? path.resolve(env.MAGA_REMOTE_CONV_DIR.trim())
      : undefined;

  bridgeState = {
    paths,
    studioOpts,
    conversationsDir,
    gatewayScript: gatewayScript || path.join(REPO_ROOT, 'remote', 'gateway', 'server.mjs'),
    udsWriteToken:
      typeof env.MAGA_REMOTE_UDS_TOKEN === 'string' && env.MAGA_REMOTE_UDS_TOKEN.trim()
        ? env.MAGA_REMOTE_UDS_TOKEN.trim()
        : crypto.randomBytes(32).toString('hex'),
    udsServer,
    clients: new Map(),
    watchedStreams: new Map(),
    tapDesiredActive: false,
    tapActive: false,
    tapRetryNextAt: 0,
    tapRetryBackoffMs: 2000,
    activeTapTargetId: null,
    gatewayChild: null,
    lastConfigRaw: '',
    restartTimer: 0,
    backoffIdx: 0,
    pollTimer: null,
    pollInFlight: false,
    lastHostAttached: getConfirmedHostEntries().length > 0,
    shuttingDown: false
  };

  runtimeState.onRemoteTapEvent = handleTapBindingEvent;
  runtimeState.onHostTargetInjected = (entry) => {
    if (!bridgeState) return;
    const hosts = getConfirmedHostEntries();
    const attached = hosts.length > 0;
    if (attached !== bridgeState.lastHostAttached) {
      bridgeState.lastHostAttached = attached;
      broadcastTapEvent('host_status', {
        hostAttached: attached,
        hostCount: hosts.length,
        tapActive: bridgeState.tapActive
      });
    }
    if (bridgeState.tapDesiredActive && entry?.hostConfirmed && entry.type === 'page') {
      if (!bridgeState.activeTapTargetId || bridgeState.activeTapTargetId === entry.id) {
        bridgeState.activeTapTargetId = entry.id;
        applyTapStateToHost(entry, true)
          .then((ok) => {
            if (!bridgeState) return;
            bridgeState.tapActive = Boolean(ok);
            if (ok) {
              bridgeState.tapRetryBackoffMs = 2000;
              bridgeState.tapRetryNextAt = 0;
              broadcastTapEvent('host_status', {
                hostAttached: true,
                hostCount: getConfirmedHostEntries().length,
                tapActive: true
              });
            } else {
              bridgeState.tapRetryBackoffMs = 2000;
              bridgeState.tapRetryNextAt = Date.now() + 2000;
            }
          })
          .catch(() => {});
      }
    }
  };
  runtimeState.onHostTargetClosed = (closedEntry) => {
    if (!bridgeState) return;
    if (closedEntry?.id && bridgeState.activeTapTargetId === closedEntry.id) {
      bridgeState.activeTapTargetId = null;
      bridgeState.tapActive = false;
    }
    const hosts = getConfirmedHostEntries();
    const count = hosts.length;
    const attached = count > 0;
    if (attached !== bridgeState.lastHostAttached) {
      bridgeState.lastHostAttached = attached;
      broadcastTapEvent('host_status', {
        hostAttached: attached,
        hostCount: count,
        tapActive: attached ? bridgeState.tapActive : false
      });
    }
    if (bridgeState.tapDesiredActive && !bridgeState.activeTapTargetId && attached) {
      resolvePrimaryHostEntry()
        .then((nextPrimary) => {
          if (!bridgeState || !nextPrimary) return;
          bridgeState.activeTapTargetId = nextPrimary.id;
          return applyTapStateToHost(nextPrimary, true).then((ok) => {
            if (bridgeState) bridgeState.tapActive = Boolean(ok);
          });
        })
        .catch(() => {});
    }
  };

  reconcileGatewayProcess(bridgeState);

  bridgeState.pollTimer = setInterval(() => {
    if (!bridgeState || bridgeState.shuttingDown || bridgeState.pollInFlight) return;
    bridgeState.pollInFlight = true;
    Promise.resolve()
      .then(async () => {
        reconcileGatewayProcess(bridgeState);
        await retryTapIfNeeded();
      })
      .catch(() => {})
      .finally(() => {
        if (bridgeState) bridgeState.pollInFlight = false;
      });
  }, 2000);
  bridgeState.pollTimer.unref?.();

  return bridgeState;
}

export function shutdownRemoteBridgeSync() {
  if (!bridgeState) return;
  bridgeState.shuttingDown = true;
  if (bridgeState.pollTimer) {
    clearInterval(bridgeState.pollTimer);
    bridgeState.pollTimer = null;
  }
  stopGatewayChildSync(bridgeState);
  for (const client of Array.from(bridgeState.clients.keys())) {
    try {
      client.destroy();
    } catch {}
  }
  bridgeState.clients.clear();
  try {
    bridgeState.udsServer?.close();
  } catch {}
  safeUnlinkSocket(bridgeState.paths.sockPath);
  runtimeState.onRemoteTapEvent = null;
  runtimeState.onHostTargetInjected = null;
  runtimeState.onHostTargetClosed = null;
  bridgeState = null;
}

export async function shutdownRemoteBridge() {
  if (!bridgeState) return;
  const state = bridgeState;
  state.shuttingDown = true;
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.tapActive) {
    await setTapActive(false).catch(() => {});
  }
  await stopGatewayChildGracefully(state);
  for (const client of Array.from(state.clients.keys())) {
    try {
      client.destroy();
    } catch {}
  }
  state.clients.clear();
  if (state.udsServer) {
    await new Promise((resolve) => {
      try {
        state.udsServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  safeUnlinkSocket(state.paths.sockPath);
  runtimeState.onRemoteTapEvent = null;
  runtimeState.onHostTargetInjected = null;
  runtimeState.onHostTargetClosed = null;
  if (bridgeState === state) bridgeState = null;
}
