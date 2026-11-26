/**
 * AGY Studio Remote Control — Daemon-side Bridge Facade, Host Tap & UDS NDJSON RPC Server
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync, REPO_ROOT, UUID_RE, attachedTargets, runtimeState } from './env.mjs';
import { isPathInsideDir } from './projects.mjs';
import {
  DEFAULT_REMOTE_CONFIG,
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
      diskRead: Boolean(DatabaseSync)
    },
    agVersion: null,
    globalPreset: diskPreset,
    tapActive: Boolean(state?.tapDesiredActive ?? state?.tapActive),
    activeStreams: state ? Array.from(state.watchedStreams.keys()) : []
  };

  if (!primary) return base;

  const tapCap =
    primary._remoteCap ||
    (await evalOnHost(primary, 'window.__agRemoteTap ? window.__agRemoteTap.getCapabilities() : null', 3000)).value ||
    null;
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
      diskRead: Boolean(DatabaseSync)
    },
    agVersion: tapCap.agVersion || null,
    globalPreset: tapCap.globalPreset ?? diskPreset,
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
      return applySnapshotByteBudget({
        cascadeId,
        source: 'cdp',
        status: String(r.value.status || 'IDLE'),
        steps: r.value.steps,
        hasMore: Boolean(r.value.hasMore),
        nextBeforeIdx: Number.isInteger(r.value.nextBeforeIdx) ? r.value.nextBeforeIdx : null,
        waitingSteps: normalizeWaitingStepsWithSha(cascadeId, r.value.waitingSteps),
        streamingText: String(r.value.streamingText || '')
      });
    }
  }
  const disk = readConversationSnapshotFromDisk(cascadeId, { beforeIdx });
  if (disk.ok === false) {
    throw Object.assign(new Error(disk.error || 'snapshot_failed'), { code: disk.error || 'snapshot_failed' });
  }
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

  bridgeState = {
    paths,
    gatewayScript: gatewayScript || path.join(REPO_ROOT, 'remote', 'gateway', 'server.mjs'),
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
