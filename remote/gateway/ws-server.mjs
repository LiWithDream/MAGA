/**
 * MAGA Remote Gateway — Lightweight RFC 6455 WebSocket Server & maga-remote/1 Session Handler
 * Features: 128KB frame cap, 5s hello timeout, epoch + 512-entry non-stream ring buffer,
 * zero-race welcome buffering, server ping/pong watchdog, 1MB backpressure guard,
 * watch leak protection, and live device revocation kicking (4001).
 * Zero third-party dependencies (Node >= 22 built-ins only).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureRemoteDir, getRemotePaths, readDevices, readJsonSafe, writeJsonAtomic } from './config.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 128 * 1024;
const MAX_RING_SIZE = 512;
const MAX_WELCOME_BUFFER_SIZE = 512;
const DEFAULT_MAX_WRITE_BUFFER_BYTES = 1024 * 1024; // 1MB backpressure cap
const DEFAULT_PING_INTERVAL_MS = 25_000;
const DEFAULT_REVOCATION_CHECK_MS = 2000;
const DEFAULT_MAX_WRITES_PER_MINUTE = 20;
const DEFAULT_MAX_CONCURRENT_WRITES = 4;
const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const MAX_IDEMPOTENCY_ENTRIES = 2048;
const MAX_WRITE_TEXT_CHARS = 16384;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9._:-]{8,128}$/;
const WAITING_HASH_RE = /^[0-9a-f]{16}$/i;
const READ_METHODS = new Set(['convo.list', 'convo.snapshot', 'convo.watch']);
const WRITE_METHODS = new Set(['convo.send', 'convo.approve', 'convo.cancel']);
const ROLE_RANK = Object.freeze({ observe: 0, steer: 1, admin: 2 });

function isSafeNonTurboPreset(preset) {
  if (typeof preset === 'boolean' || preset === null || preset === undefined) return false;
  if (typeof preset === 'string' && !/^\d+$/.test(preset.trim())) return false;
  const n = Number(preset);
  return n === 1 || n === 2;
}

function isTurboPreset(preset) {
  return !isSafeNonTurboPreset(preset);
}

function isAmbiguousWriteError(errCode) {
  if (!errCode || errCode === 'uds_unauthorized') return false;
  return (
    errCode === 'outcome_unknown' ||
    errCode === 'uds_timeout' ||
    errCode === 'uds_disconnected' ||
    errCode === 'uds_not_connected' ||
    errCode === 'uds_closed' ||
    errCode === 'uds_error' ||
    errCode === 'cdp_timeout' ||
    errCode === 'eval_timeout' ||
    /timeout|uds_/i.test(errCode)
  );
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function encodeWsFrame(opcode, payloadBuf = Buffer.alloc(0)) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return len > 0 ? Buffer.concat([header, payloadBuf]) : header;
}

function encodeClosePayload(code = 1000, reason = '') {
  const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
  const buf = Buffer.allocUnsafe(2 + reasonBuf.length);
  buf.writeUInt16BE(code, 0);
  if (reasonBuf.length > 0) reasonBuf.copy(buf, 2);
  return buf;
}

function writeHttpRejection(socket, status, error) {
  const body = JSON.stringify({ ok: false, error });
  const text = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request';
  try {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\n` +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n` +
        'Connection: close\r\n\r\n' +
        body
    );
  } catch {}
  try {
    socket.destroy();
  } catch {}
}

export function createWsServer({
  remoteDir = null,
  transportGuard,
  auth,
  udsClient,
  audit = null,
  helloTimeoutMs = 5000,
  tapDeactivateDelayMs = 30_000,
  pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
  revocationCheckMs = DEFAULT_REVOCATION_CHECK_MS,
  maxWriteBufferBytes = DEFAULT_MAX_WRITE_BUFFER_BYTES,
  maxFrameBytes = MAX_FRAME_BYTES,
  maxRingSize = MAX_RING_SIZE,
  maxWritesPerMinute = DEFAULT_MAX_WRITES_PER_MINUTE,
  maxConcurrentWrites = DEFAULT_MAX_CONCURRENT_WRITES,
  idempotencyTtlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
  now = Date.now,
  getActivePort = () => null,
} = {}) {
  const epoch = crypto.randomBytes(8).toString('hex');
  const paths = getRemotePaths(remoteDir);
  const writeIdempotencyFile = path.join(paths.remoteDir, 'write-idempotency.json');
  let seq = 0;
  const ring = [];
  const authenticatedClients = new Set();
  const allConnections = new Set();
  const watchRefCounts = new Map();
  const inFlightWritesByDevice = new Map();
  const writeTimestampsByDevice = new Map();
  const lastRateLimitAuditByDevice = new Map();
  const idempotencyInFlight = new Map();
  const idempotencyCache = new Map();
  let tapActive = false;
  let tapDeactivateTimer = null;
  let closed = false;
  let lastDevicesSig = '';

  function pruneIdempotencyCache() {
    const ts = now();
    for (const [k, entry] of idempotencyCache.entries()) {
      if (!entry || typeof entry !== 'object' || ts >= Number(entry.expiresAt || 0)) {
        idempotencyCache.delete(k);
      }
    }
    while (idempotencyCache.size > MAX_IDEMPOTENCY_ENTRIES) {
      const oldest = idempotencyCache.keys().next().value;
      if (oldest === undefined) break;
      idempotencyCache.delete(oldest);
    }
  }

  function loadIdempotencyCache() {
    const saved = readJsonSafe(writeIdempotencyFile, null);
    const entries = saved && typeof saved === 'object' && saved.entries && typeof saved.entries === 'object' ? saved.entries : null;
    if (!entries) return;
    const ts = now();
    for (const [k, entry] of Object.entries(entries)) {
      if (entry && typeof entry === 'object' && ts < Number(entry.expiresAt || 0)) {
        idempotencyCache.set(k, entry);
      }
    }
    pruneIdempotencyCache();
  }

  function persistIdempotencyCache() {
    pruneIdempotencyCache();
    try {
      writeJsonAtomic(writeIdempotencyFile, { entries: Object.fromEntries(idempotencyCache.entries()) }, { mode: 0o600, dirMode: 0o700 });
    } catch {}
  }

  loadIdempotencyCache();

  function clearTapDeactivateTimer() {
    if (tapDeactivateTimer) {
      clearTimeout(tapDeactivateTimer);
      tapDeactivateTimer = null;
    }
  }

  function deliverFrameToClient(client, frame) {
    if (client.closed) return;
    if (client.bufferingWelcome) {
      if (client.welcomeBuffer.length < MAX_WELCOME_BUFFER_SIZE) {
        client.welcomeBuffer.push(frame);
      }
      return;
    }
    client.sendJson(frame);
  }

  function recordAndBroadcastTap(payload) {
    if (closed || !payload || typeof payload !== 'object') return;
    const kind = String(payload.kind || 'unknown');
    const ts = payload.ts ?? Date.now();
    const data = payload.data ?? null;

    // Stream chunks bypass the 512-entry replay ring so high-frequency streaming never evicts summary state
    if (kind === 'stream') {
      const streamFrame = { type: 'delta', epoch, kind, ts, data };
      for (const client of Array.from(authenticatedClients)) {
        deliverFrameToClient(client, streamFrame);
      }
      return;
    }

    seq += 1;
    const item = { seq, kind, ts, data };
    ring.push(item);
    while (ring.length > maxRingSize) {
      ring.shift();
    }
    const frame = { type: 'delta', epoch, seq: item.seq, kind: item.kind, ts: item.ts, data: item.data };
    for (const client of Array.from(authenticatedClients)) {
      deliverFrameToClient(client, frame);
    }
  }

  function checkClientActiveAndRole(client, liveDevice) {
    const did = client.device?.deviceId;
    if (!did || !liveDevice) {
      audit?.append('device_revoked_kicked', { deviceId: did, clientKey: client.clientKey });
      client.sendJson({ type: 'error', error: 'device_revoked' });
      client.close(4001, 'device_revoked');
      return null;
    }
    const prevRole = String(client.device?.role || 'observe');
    const nextRole = String(liveDevice.role || 'observe');
    const prevRank = ROLE_RANK[prevRole] ?? 0;
    const nextRank = ROLE_RANK[nextRole] ?? 0;
    if (nextRank < prevRank) {
      audit?.append('device_role_demoted_kicked', {
        deviceId: did,
        fromRole: prevRole,
        toRole: nextRole,
        clientKey: client.clientKey,
      });
      client.sendJson({ type: 'error', error: 'device_role_demoted' });
      client.close(4003, 'device_role_demoted');
      return null;
    }
    client.device.role = nextRole;
    return liveDevice;
  }

  function verifyClientDeviceLive(client) {
    const did = client.device?.deviceId;
    if (!did) return checkClientActiveAndRole(client, null);
    let live = null;
    if (typeof auth.getActiveDevice === 'function') {
      live = auth.getActiveDevice(did);
    } else if (typeof auth.isDeviceActive === 'function') {
      if (auth.isDeviceActive(did)) {
        const devs = readDevices({ remoteDir: paths.remoteDir });
        live = devs.find((d) => d.deviceId === did && !d.revokedAt) || client.device;
      }
    } else {
      live = client.device;
    }
    return checkClientActiveAndRole(client, live);
  }

  function kickRevokedClients(forceRead = false) {
    if (closed || authenticatedClients.size === 0) return;
    try {
      const st = fs.statSync(paths.devicesFile, { throwIfNoEntry: false });
      const sig = st ? `${st.size}:${Math.floor(st.mtimeMs)}` : 'missing';
      if (!forceRead && sig === lastDevicesSig) return;
      lastDevicesSig = sig;
    } catch {
      if (!forceRead) return;
    }

    const devices = readDevices({ remoteDir: paths.remoteDir });
    const activeById = new Map(devices.filter((d) => !d.revokedAt).map((d) => [d.deviceId, d]));
    for (const client of Array.from(authenticatedClients)) {
      const did = client.device?.deviceId;
      checkClientActiveAndRole(client, did ? activeById.get(did) || null : null);
    }
  }

  let dirWatcher = null;
  try {
    ensureRemoteDir(paths.remoteDir, 0o700);
    dirWatcher = fs.watch(paths.remoteDir, { persistent: false }, (_evType, filename) => {
      if (!filename || filename === path.basename(paths.devicesFile)) {
        kickRevokedClients(true);
      }
    });
    dirWatcher.on('error', () => {});
  } catch {
    dirWatcher = null;
  }

  const revocationTimer =
    revocationCheckMs > 0
      ? setInterval(() => {
          kickRevokedClients(false);
        }, revocationCheckMs)
      : null;
  revocationTimer?.unref?.();

  const pingTimer =
    pingIntervalMs > 0
      ? setInterval(() => {
          if (closed) return;
          for (const client of Array.from(allConnections)) {
            client.sendServerPing();
          }
        }, pingIntervalMs)
      : null;
  pingTimer?.unref?.();

  const unsubTap = udsClient?.onTap?.(recordAndBroadcastTap) || (() => {});
  const unsubConnect =
    udsClient?.onConnect?.(() => {
      if (closed || authenticatedClients.size === 0) return;
      tapActive = true;
      udsClient.request('tap.setActive', { active: true }).catch(() => {});
      for (const cid of watchRefCounts.keys()) {
        udsClient.request('convo.watch', { cascadeId: cid, watch: true }).catch(() => {});
      }
    }) || (() => {});

  function activateTapIfNeeded() {
    clearTapDeactivateTimer();
    if (!tapActive) {
      tapActive = true;
      udsClient?.request('tap.setActive', { active: true }).catch(() => {});
    }
  }

  function scheduleTapDeactivateIfIdle() {
    if (authenticatedClients.size > 0 || tapDeactivateTimer || !tapActive) return;
    tapDeactivateTimer = setTimeout(() => {
      tapDeactivateTimer = null;
      if (!closed && authenticatedClients.size === 0 && tapActive) {
        tapActive = false;
        udsClient?.request('tap.setActive', { active: false }).catch(() => {});
      }
    }, tapDeactivateDelayMs);
    tapDeactivateTimer.unref?.();
  }

  function releaseClientWatches(client) {
    for (const cid of client.watchedCids) {
      const nextCount = (watchRefCounts.get(cid) || 1) - 1;
      if (nextCount <= 0) {
        watchRefCounts.delete(cid);
        udsClient?.request('convo.watch', { cascadeId: cid, watch: false }).catch(() => {});
      } else {
        watchRefCounts.set(cid, nextCount);
      }
    }
    client.watchedCids.clear();
  }

  async function sendInitialSync(client, { lastSeq, lastEpoch }) {
    const canReplay =
      Boolean(lastEpoch) &&
      lastEpoch === epoch &&
      typeof lastSeq === 'number' &&
      Number.isInteger(lastSeq) &&
      lastSeq > 0 &&
      ring.length > 0 &&
      lastSeq >= ring[0].seq - 1 &&
      lastSeq <= seq;

    if (canReplay) {
      authenticatedClients.add(client);
      activateTapIfNeeded();
      const items = ring.filter((it) => it.seq > lastSeq);
      client.sendJson({ type: 'deltas', epoch, seq, items });
      return;
    }

    // Record seq0 and buffer concurrent tap deltas while convo.list is in flight (zero-race snapshot sync)
    const seq0 = seq;
    client.bufferingWelcome = true;
    client.welcomeBuffer = [];
    authenticatedClients.add(client);
    activateTapIfNeeded();

    const [healthRes, listRes] = await Promise.allSettled([
      udsClient ? udsClient.request('bridge.health', {}, { timeoutMs: 2500 }) : Promise.reject(new Error('no_uds')),
      udsClient ? udsClient.request('convo.list', {}, { timeoutMs: 2500 }) : Promise.reject(new Error('no_uds')),
    ]);

    if (client.closed) {
      client.bufferingWelcome = false;
      client.welcomeBuffer = [];
      return;
    }

    const health =
      healthRes.status === 'fulfilled' && healthRes.value
        ? healthRes.value
        : { ok: false, hostAttached: false, capabilities: {}, globalPreset: null };
    const conversations =
      listRes.status === 'fulfilled' && Array.isArray(listRes.value?.conversations)
        ? listRes.value.conversations
        : [];

    client.sendJson({
      type: 'welcome',
      epoch,
      seq: seq0,
      deviceRole: client.device?.role || 'observe',
      gatewayFingerprint: auth.gatewayFingerprint,
      health,
      conversations,
    });

    const buffered = client.welcomeBuffer;
    client.bufferingWelcome = false;
    client.welcomeBuffer = [];
    for (const frame of buffered) {
      if (client.closed) break;
      if (frame.kind === 'stream' || (typeof frame.seq === 'number' && frame.seq > seq0)) {
        client.sendJson(frame);
      }
    }
  }

  function checkAndRecordWriteRate(deviceId) {
    const ts = now();
    const cutoff = ts - 60_000;
    const prev = (writeTimestampsByDevice.get(deviceId) || []).filter((t) => t > cutoff);
    if (prev.length >= maxWritesPerMinute) {
      writeTimestampsByDevice.set(deviceId, prev);
      return false;
    }
    prev.push(ts);
    writeTimestampsByDevice.set(deviceId, prev);
    return true;
  }

  function auditRateLimitedWrite(deviceId, method, clientKey) {
    const ts = now();
    const lastAt = lastRateLimitAuditByDevice.get(deviceId) || 0;
    if (ts - lastAt >= 15_000) {
      lastRateLimitAuditByDevice.set(deviceId, ts);
      audit?.append('ws_write_rate_limited', { deviceId, method, clientKey });
    }
  }

  function validateAndBuildWriteSpec(method, params) {
    const cascadeId = typeof params.cascadeId === 'string' ? params.cascadeId.trim() : '';
    if (!UUID_RE.test(cascadeId)) {
      return { ok: false, error: 'invalid_cascade_id' };
    }
    const rawKey = typeof params.idempotencyKey === 'string' ? params.idempotencyKey.trim() : '';
    if (method === 'convo.send' || method === 'convo.approve') {
      if (!rawKey || !IDEMPOTENCY_KEY_RE.test(rawKey)) {
        return { ok: false, error: 'invalid_idempotency_key' };
      }
    } else if (rawKey && !IDEMPOTENCY_KEY_RE.test(rawKey)) {
      return { ok: false, error: 'invalid_idempotency_key' };
    }

    if (method === 'convo.send') {
      if (typeof params.text !== 'string') return { ok: false, error: 'invalid_text' };
      const text = params.text;
      if (!text.trim() || text.length > MAX_WRITE_TEXT_CHARS) {
        return { ok: false, error: 'invalid_text_length' };
      }
      return {
        ok: true,
        cascadeId,
        idempotencyKey: rawKey,
        payloadHash: sha256Hex(JSON.stringify(['convo.send', cascadeId, text])),
        rpcParams: {
          cascadeId,
          text,
          turboWriteConfirmed: Boolean(params.turboWriteConfirmed),
        },
        auditMeta: {
          cascadeId,
          textSha256: sha256Hex(text),
          textLen: text.length,
        },
      };
    }

    if (method === 'convo.approve') {
      const decision = params.decision;
      if (decision !== 'allow_once' && decision !== 'deny') {
        return { ok: false, error: 'invalid_decision' };
      }
      const stepIndex = params.stepIndex;
      if (!Number.isInteger(stepIndex) || stepIndex < 0) {
        return { ok: false, error: 'invalid_step_index' };
      }
      const waitingStepHash = typeof params.waitingStepHash === 'string' ? params.waitingStepHash.trim().toLowerCase() : '';
      if (!WAITING_HASH_RE.test(waitingStepHash)) {
        return { ok: false, error: 'invalid_waiting_step_hash' };
      }
      return {
        ok: true,
        cascadeId,
        idempotencyKey: rawKey,
        payloadHash: sha256Hex(JSON.stringify(['convo.approve', cascadeId, stepIndex, waitingStepHash, decision])),
        rpcParams: { cascadeId, stepIndex, waitingStepHash, decision },
        auditMeta: { cascadeId, stepIndex, waitingStepHash, decision },
      };
    }

    const killBackgroundTasks = Boolean(params.killBackgroundTasks);
    return {
      ok: true,
      cascadeId,
      idempotencyKey: rawKey,
      payloadHash: sha256Hex(JSON.stringify(['convo.cancel', cascadeId, killBackgroundTasks])),
      rpcParams: { cascadeId, killBackgroundTasks },
      auditMeta: { cascadeId, killBackgroundTasks },
    };
  }

  async function handleWriteRpc(client, reqId, method, params, liveDevice) {
    const deviceId = liveDevice.deviceId;
    const role = String(liveDevice.role || 'observe');
    if ((ROLE_RANK[role] ?? 0) < ROLE_RANK.steer) {
      if (!checkAndRecordWriteRate(deviceId)) {
        auditRateLimitedWrite(deviceId, method, client.clientKey);
        if (!client.closed) {
          client.sendJson({ type: 'res', reqId, ok: false, error: 'write_rate_limited' });
        }
        return;
      }
      audit?.append('ws_write_forbidden_role', {
        deviceId,
        role,
        method,
        clientKey: client.clientKey,
      });
      if (!client.closed) {
        client.sendJson({ type: 'res', reqId, ok: false, error: 'forbidden_role_observe' });
      }
      return;
    }

    const spec = validateAndBuildWriteSpec(method, params);
    if (!spec.ok) {
      if (!checkAndRecordWriteRate(deviceId)) {
        auditRateLimitedWrite(deviceId, method, client.clientKey);
        if (!client.closed) {
          client.sendJson({ type: 'res', reqId, ok: false, error: 'write_rate_limited' });
        }
        return;
      }
      if (!client.closed) {
        client.sendJson({ type: 'res', reqId, ok: false, error: spec.error });
      }
      return;
    }

    const cacheKey = spec.idempotencyKey ? `${deviceId}:${method}:${spec.idempotencyKey}` : '';
    if (cacheKey) {
      pruneIdempotencyCache();
      const cached = idempotencyCache.get(cacheKey);
      if (cached && now() < Number(cached.expiresAt || 0)) {
        if (!cached.payloadHash || cached.payloadHash !== spec.payloadHash) {
          if (!client.closed) {
            client.sendJson({ type: 'res', reqId, ok: false, error: 'idempotency_key_conflict' });
          }
          return;
        }
        if (!client.closed) {
          client.sendJson({
            type: 'res',
            reqId,
            ok: Boolean(cached.ok),
            ...(cached.ok ? { result: cached.result } : { error: cached.error }),
            replayed: true,
          });
        }
        return;
      }
      const existingFlight = idempotencyInFlight.get(cacheKey);
      if (existingFlight) {
        if (existingFlight.payloadHash !== spec.payloadHash) {
          if (!client.closed) {
            client.sendJson({ type: 'res', reqId, ok: false, error: 'idempotency_key_conflict' });
          }
          return;
        }
        const outcome = await existingFlight.promise;
        if (!client.closed) {
          client.sendJson({
            type: 'res',
            reqId,
            ok: Boolean(outcome.ok),
            ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
            replayed: true,
          });
        }
        return;
      }
    }

    const currentInFlight = inFlightWritesByDevice.get(deviceId) || 0;
    if (currentInFlight >= maxConcurrentWrites) {
      if (!client.closed) {
        client.sendJson({ type: 'res', reqId, ok: false, error: 'too_many_concurrent_writes' });
      }
      return;
    }

    if (!checkAndRecordWriteRate(deviceId)) {
      auditRateLimitedWrite(deviceId, method, client.clientKey);
      if (!client.closed) {
        client.sendJson({ type: 'res', reqId, ok: false, error: 'write_rate_limited' });
      }
      return;
    }

    // Synchronously reserve concurrency slot and in-flight key BEFORE any await
    inFlightWritesByDevice.set(deviceId, currentInFlight + 1);
    const execPromise = (async () => {
      try {
        if (method === 'convo.send') {
          const health = await udsClient.request('bridge.health', {}, { timeoutMs: 2000 }).catch(() => null);
          const stillLive = verifyClientDeviceLive(client);
          if (!stillLive) {
            return { ok: false, error: 'device_revoked' };
          }
          if ((ROLE_RANK[String(stillLive.role || 'observe')] ?? 0) < ROLE_RANK.steer) {
            return { ok: false, error: 'forbidden_role_observe' };
          }
          if (!health || isTurboPreset(health.globalPreset)) {
            if (spec.rpcParams.turboWriteConfirmed !== true) {
              audit?.append('ws_send_rejected_turbo', {
                deviceId,
                cascadeId: spec.cascadeId,
                globalPreset: health?.globalPreset ?? null,
              });
              return { ok: false, error: 'turbo_write_confirmation_required' };
            }
          }
        }

        const timeoutMs = method === 'convo.send' ? 20_000 : method === 'convo.approve' ? 18_000 : 15_000;
        const result = await udsClient.request(method, spec.rpcParams, { timeoutMs, write: true });
        audit?.append('remote_write', {
          deviceId,
          role,
          method,
          ...spec.auditMeta,
          ok: true,
        });
        const outcome = { ok: true, result };
        if (cacheKey) {
          idempotencyCache.set(cacheKey, {
            ...outcome,
            payloadHash: spec.payloadHash,
            createdAt: now(),
            expiresAt: now() + idempotencyTtlMs,
          });
          persistIdempotencyCache();
        }
        return outcome;
      } catch (err) {
        const errCode = String(err?.code || err?.message || 'uds_error');
        if (isAmbiguousWriteError(errCode)) {
          audit?.append('remote_write', {
            deviceId,
            role,
            method,
            ...spec.auditMeta,
            ok: false,
            error: 'outcome_unknown',
            originalError: errCode,
          });
          const outcome = { ok: false, error: 'outcome_unknown' };
          if (cacheKey) {
            idempotencyCache.set(cacheKey, {
              ...outcome,
              payloadHash: spec.payloadHash,
              createdAt: now(),
              expiresAt: now() + idempotencyTtlMs,
            });
            persistIdempotencyCache();
          }
          return outcome;
        }

        audit?.append('remote_write', {
          deviceId,
          role,
          method,
          ...spec.auditMeta,
          ok: false,
          error: errCode,
        });
        const outcome = { ok: false, error: errCode };
        const deterministicFailure =
          errCode === 'waiting_step_mismatch' || errCode === 'unsupported_interaction_case';
        if (cacheKey && deterministicFailure) {
          idempotencyCache.set(cacheKey, {
            ...outcome,
            payloadHash: spec.payloadHash,
            createdAt: now(),
            expiresAt: now() + idempotencyTtlMs,
          });
          persistIdempotencyCache();
        }
        return outcome;
      }
    })().finally(() => {
      const cur = inFlightWritesByDevice.get(deviceId) || 1;
      if (cur <= 1) inFlightWritesByDevice.delete(deviceId);
      else inFlightWritesByDevice.set(deviceId, cur - 1);
      if (cacheKey) idempotencyInFlight.delete(cacheKey);
    });

    if (cacheKey) {
      idempotencyInFlight.set(cacheKey, { promise: execPromise, payloadHash: spec.payloadHash });
    }

    const outcome = await execPromise;
    if (!client.closed) {
      client.sendJson({
        type: 'res',
        reqId,
        ok: Boolean(outcome.ok),
        ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
      });
    }
  }

  async function handleAuthenticatedMessage(client, msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      client.sendJson({ type: 'error', error: 'invalid_message_json' });
      return;
    }

    if (msg.type === 'ping') {
      client.sendJson({ type: 'pong', ts: msg.ts ?? Date.now() });
      return;
    }

    if (msg.type === 'pong') {
      client.awaitingPong = false;
      client.missedPongs = 0;
      return;
    }

    // Re-check both revocation and live role demotion before processing any RPC request
    const liveDevice = verifyClientDeviceLive(client);
    if (!liveDevice) {
      return;
    }

    if (msg.type !== 'req') {
      client.sendJson({ type: 'error', error: 'unsupported_message_type' });
      return;
    }

    const reqId = msg.reqId;
    if (reqId === undefined || reqId === null || (typeof reqId !== 'string' && typeof reqId !== 'number')) {
      client.sendJson({ type: 'error', error: 'missing_req_id' });
      return;
    }

    const method = typeof msg.method === 'string' ? msg.method.trim() : '';
    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};

    if (WRITE_METHODS.has(method)) {
      await handleWriteRpc(client, reqId, method, params, liveDevice);
      return;
    }

    if (!READ_METHODS.has(method)) {
      audit?.append('ws_forbidden_method', {
        deviceId: client.device?.deviceId,
        method,
        clientKey: client.clientKey,
      });
      client.sendJson({
        type: 'res',
        reqId,
        ok: false,
        error: 'method_not_supported',
      });
      return;
    }

    if (method === 'convo.list') {
      try {
        const result = await udsClient.request('convo.list', {
          includeSubagents: Boolean(params.includeSubagents),
        });
        if (!client.closed) client.sendJson({ type: 'res', reqId, ok: true, result });
      } catch (err) {
        if (!client.closed) {
          client.sendJson({ type: 'res', reqId, ok: false, error: err?.code || err?.message || 'uds_error' });
        }
      }
      return;
    }

    if (method === 'convo.snapshot') {
      const cascadeId = typeof params.cascadeId === 'string' ? params.cascadeId.trim() : '';
      if (!UUID_RE.test(cascadeId)) {
        client.sendJson({ type: 'res', reqId, ok: false, error: 'invalid_cascade_id' });
        return;
      }
      const reqParams = { cascadeId };
      if (Number.isInteger(params.beforeIdx) && params.beforeIdx >= 0) {
        reqParams.beforeIdx = params.beforeIdx;
      }
      try {
        const result = await udsClient.request('convo.snapshot', reqParams);
        if (!client.closed) client.sendJson({ type: 'res', reqId, ok: true, result });
      } catch (err) {
        if (!client.closed) {
          client.sendJson({ type: 'res', reqId, ok: false, error: err?.code || err?.message || 'uds_error' });
        }
      }
      return;
    }

    if (method === 'convo.watch') {
      const cascadeId = typeof params.cascadeId === 'string' ? params.cascadeId.trim() : '';
      if (!UUID_RE.test(cascadeId) || typeof params.watch !== 'boolean') {
        client.sendJson({ type: 'res', reqId, ok: false, error: 'invalid_watch_params' });
        return;
      }

      if (params.watch) {
        if (client.closed || client.socketDestroyed()) return;
        try {
          const result = await udsClient.request('convo.watch', { cascadeId, watch: true });
          // Guard disconnect during async UDS request to prevent orphaned watch on daemon
          if (client.closed || client.socketDestroyed()) {
            if ((watchRefCounts.get(cascadeId) || 0) === 0) {
              udsClient.request('convo.watch', { cascadeId, watch: false }).catch(() => {});
            }
            return;
          }
          if (!client.watchedCids.has(cascadeId)) {
            client.watchedCids.add(cascadeId);
            watchRefCounts.set(cascadeId, (watchRefCounts.get(cascadeId) || 0) + 1);
          }
          client.sendJson({ type: 'res', reqId, ok: true, result });
        } catch (err) {
          if (!client.closed) {
            client.sendJson({ type: 'res', reqId, ok: false, error: err?.code || err?.message || 'uds_error' });
          }
        }
      } else {
        const hadWatch = client.watchedCids.delete(cascadeId);
        let shouldForwardUnwatch = false;
        if (hadWatch) {
          const nextCount = (watchRefCounts.get(cascadeId) || 1) - 1;
          if (nextCount <= 0) {
            watchRefCounts.delete(cascadeId);
            shouldForwardUnwatch = true;
          } else {
            watchRefCounts.set(cascadeId, nextCount);
          }
        } else if (!watchRefCounts.has(cascadeId)) {
          shouldForwardUnwatch = true;
        }

        if (shouldForwardUnwatch) {
          try {
            const result = await udsClient.request('convo.watch', { cascadeId, watch: false });
            if (!client.closed) client.sendJson({ type: 'res', reqId, ok: true, result });
          } catch (err) {
            if (!client.closed) {
              client.sendJson({ type: 'res', reqId, ok: false, error: err?.code || err?.message || 'uds_error' });
            }
          }
        } else {
          client.sendJson({
            type: 'res',
            reqId,
            ok: true,
            result: { ok: true, watching: false, activeStreams: watchRefCounts.size },
          });
        }
      }
    }
  }

  function attachWsConnection(socket, head, clientKey) {
    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 15_000);

    let rxBuf = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let fragChunks = null;
    let fragBytes = 0;
    let closeSent = false;

    const client = {
      closed: false,
      cleanedUp: false,
      authenticated: false,
      bufferingWelcome: false,
      welcomeBuffer: [],
      awaitingPong: false,
      missedPongs: 0,
      activeWriteDispatches: 0,
      device: null,
      clientKey,
      watchedCids: new Set(),
      socketDestroyed: () => socket.destroyed,
      sendJson(obj) {
        if (client.closed || socket.destroyed || !socket.writable) return;
        if (socket.writableLength > maxWriteBufferBytes) {
          audit?.append('ws_backpressure_disconnect', {
            deviceId: client.device?.deviceId,
            clientKey,
            writableLength: socket.writableLength,
          });
          client.close(4002, 'backpressure_limit_exceeded');
          return;
        }
        try {
          socket.write(encodeWsFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')));
        } catch {}
      },
      sendServerPing() {
        if (client.closed || socket.destroyed || !socket.writable) return;
        if (client.awaitingPong) {
          client.missedPongs += 1;
          if (client.missedPongs >= 2) {
            audit?.append('ws_ping_timeout', { deviceId: client.device?.deviceId, clientKey });
            client.close(4002, 'ping_timeout');
            return;
          }
        }
        client.awaitingPong = true;
        try {
          socket.write(encodeWsFrame(0x9, Buffer.from('maga-hb', 'utf8')));
        } catch {}
      },
      close(code = 1000, reason = '') {
        if (client.closed) return;
        client.closed = true;
        if (!closeSent && !socket.destroyed && socket.writable) {
          closeSent = true;
          try {
            socket.write(encodeWsFrame(0x8, encodeClosePayload(code, reason)));
          } catch {}
        }
        cleanupClient();
        try {
          socket.destroy();
        } catch {}
      },
    };

    allConnections.add(client);

    const helloTimer = setTimeout(() => {
      if (!client.authenticated && !client.closed) {
        client.sendJson({ type: 'error', error: 'hello_timeout' });
        client.close(4008, 'hello_timeout');
      }
    }, helloTimeoutMs);
    helloTimer.unref?.();

    function cleanupClient() {
      if (client.cleanedUp) return;
      client.cleanedUp = true;
      clearTimeout(helloTimer);
      client.bufferingWelcome = false;
      client.welcomeBuffer = [];
      allConnections.delete(client);
      if (client.authenticated) {
        authenticatedClients.delete(client);
        releaseClientWatches(client);
        scheduleTapDeactivateIfIdle();
      }
    }

    function sendPong(payload) {
      if (client.closed || socket.destroyed || !socket.writable) return;
      try {
        socket.write(encodeWsFrame(0xA, payload.subarray(0, 125)));
      } catch {}
    }

    async function onTextFrame(utf8Text) {
      let parsed;
      try {
        parsed = JSON.parse(utf8Text);
      } catch {
        if (!client.authenticated) {
          client.sendJson({ type: 'error', error: 'invalid_hello_json' });
          client.close(1002, 'invalid_json');
        } else {
          client.sendJson({ type: 'error', error: 'invalid_json' });
        }
        return;
      }

      if (!client.authenticated) {
        clearTimeout(helloTimer);
        const res = auth.verifyHello(parsed, { clientKey });
        if (!res.ok) {
          client.sendJson({ type: 'error', error: res.error, retryAfterSec: res.retryAfterSec });
          const closeCode =
            res.error === 'device_revoked' || res.error === 'unknown_device'
              ? 4001
              : res.error === 'rate_limited'
                ? 4029
                : 1008;
          client.close(closeCode, res.error);
          return;
        }
        client.authenticated = true;
        client.device = res.device;
        await sendInitialSync(client, { lastSeq: res.lastSeq, lastEpoch: res.lastEpoch });
        return;
      }

      await handleAuthenticatedMessage(client, parsed);
    }

    let processing = Promise.resolve();
    function enqueueTextFrame(text) {
      if (client.authenticated) {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (parsed.type === 'ping') {
            client.sendJson({ type: 'pong', ts: parsed.ts ?? Date.now() });
            return;
          }
          if (parsed.type === 'pong') {
            client.awaitingPong = false;
            client.missedPongs = 0;
            return;
          }
          if (parsed.type === 'req' && WRITE_METHODS.has(String(parsed.method || '').trim())) {
            const maxClientWriteDispatches = Math.max(8, maxConcurrentWrites * 2);
            if (client.activeWriteDispatches >= maxClientWriteDispatches) {
              if (parsed.reqId !== undefined && parsed.reqId !== null) {
                client.sendJson({ type: 'res', reqId: parsed.reqId, ok: false, error: 'too_many_concurrent_writes' });
              }
              return;
            }
            client.activeWriteDispatches += 1;
            handleAuthenticatedMessage(client, parsed)
              .catch(() => {})
              .finally(() => {
                client.activeWriteDispatches = Math.max(0, client.activeWriteDispatches - 1);
              });
            return;
          }
        }
      }
      processing = processing.then(() => onTextFrame(text)).catch(() => {});
    }

    function consumeFrames() {
      while (rxBuf.length >= 2 && !client.closed) {
        const b0 = rxBuf[0];
        const b1 = rxBuf[1];
        const fin = (b0 & 0x80) !== 0;
        const rsv = b0 & 0x70;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;

        if (rsv !== 0 || !masked) {
          client.close(1002, 'protocol_error');
          return;
        }

        let offset = 2;
        let payloadLen = b1 & 0x7f;
        if (payloadLen === 126) {
          if (rxBuf.length < offset + 2) return;
          payloadLen = rxBuf.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLen === 127) {
          if (rxBuf.length < offset + 8) return;
          const bigLen = rxBuf.readBigUInt64BE(offset);
          if (bigLen > BigInt(maxFrameBytes)) {
            client.close(1009, 'frame_too_large');
            return;
          }
          payloadLen = Number(bigLen);
          offset += 8;
        }

        if (payloadLen > maxFrameBytes) {
          client.close(1009, 'frame_too_large');
          return;
        }

        const totalFrameLen = offset + 4 + payloadLen;
        if (rxBuf.length < totalFrameLen) return;

        const maskKey = rxBuf.subarray(offset, offset + 4);
        const rawPayload = rxBuf.subarray(offset + 4, totalFrameLen);
        rxBuf = rxBuf.subarray(totalFrameLen);

        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i += 1) {
          unmasked[i] = rawPayload[i] ^ maskKey[i & 3];
        }

        const isControl = (opcode & 0x08) !== 0;
        if (isControl) {
          if (!fin || payloadLen > 125) {
            client.close(1002, 'invalid_control_frame');
            return;
          }
          if (opcode === 0x8) {
            client.close(1000, 'normal_closure');
            return;
          }
          if (opcode === 0x9) {
            sendPong(unmasked);
          } else if (opcode === 0xA) {
            client.awaitingPong = false;
            client.missedPongs = 0;
          }
          continue;
        }

        if (opcode === 0x2) {
          client.close(1003, 'binary_unsupported');
          return;
        }

        if (opcode === 0x1) {
          if (fragChunks !== null) {
            client.close(1002, 'unexpected_text_during_fragment');
            return;
          }
          if (fin) {
            enqueueTextFrame(unmasked.toString('utf8'));
          } else {
            fragChunks = [unmasked];
            fragBytes = unmasked.length;
          }
          continue;
        }

        if (opcode === 0x0) {
          if (fragChunks === null) {
            client.close(1002, 'unexpected_continuation');
            return;
          }
          fragBytes += unmasked.length;
          if (fragBytes > maxFrameBytes) {
            fragChunks = null;
            client.close(1009, 'message_too_large');
            return;
          }
          fragChunks.push(unmasked);
          if (fin) {
            const full = Buffer.concat(fragChunks, fragBytes).toString('utf8');
            fragChunks = null;
            fragBytes = 0;
            enqueueTextFrame(full);
          }
          continue;
        }

        client.close(1002, 'unknown_opcode');
        return;
      }
    }

    socket.on('data', (chunk) => {
      if (client.closed) return;
      rxBuf = rxBuf.length > 0 ? Buffer.concat([rxBuf, chunk]) : chunk;
      consumeFrames();
    });

    socket.once('end', () => {
      client.closed = true;
      cleanupClient();
      try {
        socket.destroy();
      } catch {}
    });

    socket.once('close', () => {
      client.closed = true;
      cleanupClient();
    });

    socket.once('error', () => {
      client.closed = true;
      cleanupClient();
    });

    if (rxBuf.length > 0) {
      consumeFrames();
    }
  }

  async function handleUpgrade(req, socket, head) {
    if (closed) {
      writeHttpRejection(socket, 503, 'gateway_shutting_down');
      return;
    }

    const method = String(req?.method || '').toUpperCase();
    const upgradeHdr = String(req?.headers?.upgrade || '').toLowerCase();
    const connHdr = String(req?.headers?.connection || '').toLowerCase();
    const wsVersion = String(req?.headers?.['sec-websocket-version'] || '').trim();
    const wsKey = String(req?.headers?.['sec-websocket-key'] || '').trim();

    if (
      method !== 'GET' ||
      upgradeHdr !== 'websocket' ||
      !connHdr.split(',').some((t) => t.trim() === 'upgrade') ||
      wsVersion !== '13' ||
      !wsKey
    ) {
      writeHttpRejection(socket, 400, 'invalid_websocket_upgrade');
      return;
    }

    let keyBytes = 0;
    try {
      keyBytes = Buffer.from(wsKey, 'base64').length;
    } catch {
      keyBytes = 0;
    }
    if (keyBytes !== 16) {
      writeHttpRejection(socket, 400, 'invalid_websocket_key');
      return;
    }

    const check = await transportGuard.verifyUpgrade(req, { activePort: getActivePort() });
    if (!check.ok) {
      audit?.append('ws_upgrade_rejected', {
        error: check.error,
        remoteAddr: req?.socket?.remoteAddress,
      });
      writeHttpRejection(socket, check.status || 403, check.error);
      return;
    }

    const clientKey = transportGuard.getClientKey(req, check.edge);
    const acceptKey = crypto.createHash('sha1').update(`${wsKey}${WS_GUID}`, 'utf8').digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        '\r\n'
    );

    attachWsConnection(socket, head, clientKey);
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTapDeactivateTimer();
    if (pingTimer) clearInterval(pingTimer);
    if (revocationTimer) clearInterval(revocationTimer);
    try {
      dirWatcher?.close();
    } catch {}
    unsubTap();
    unsubConnect();
    for (const cid of watchRefCounts.keys()) {
      udsClient?.request('convo.watch', { cascadeId: cid, watch: false }).catch(() => {});
    }
    watchRefCounts.clear();
    if (tapActive) {
      tapActive = false;
      udsClient?.request('tap.setActive', { active: false }).catch(() => {});
    }
    for (const client of Array.from(allConnections)) {
      client.close(1001, 'gateway_shutdown');
    }
    allConnections.clear();
    authenticatedClients.clear();
  }

  return {
    epoch,
    handleUpgrade,
    kickRevokedClients,
    close,
    getStats: () => ({
      epoch,
      seq,
      ringSize: ring.length,
      connectedClients: authenticatedClients.size,
      totalConnections: allConnections.size,
      watchedCount: watchRefCounts.size,
      tapActive,
    }),
  };
}
