/**
 * Authenticated WebSocket client for MAGA Remote Control (`maga-remote/1`).
 * Handles challenge-response ECDSA P-256 handshake, heartbeat, backoff reconnect,
 * seq delta replay, and automatic watch/unwatch tracking across reconnects.
 */
import { signChallengePayload } from './crypto-store.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PING_INTERVAL_MS = 15_000;
const STALE_TIMEOUT_MS = 40_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const RESUME_PROBE_MS = 2_500;
const BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 15_000;
const AUTH_EXPIRED_RETRY_MS = 30_000;

function isCloudflareAuthRedirectResponse(res) {
  if (!res) return false;
  if (res.type === 'opaqueredirect') return true;
  if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
    return true;
  }
  const url = String(res.url || '');
  if (res.redirected && /cloudflareaccess\.com|\/cdn-cgi\/access\//i.test(url)) {
    return true;
  }
  const ct = String(res.headers?.get?.('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) {
    return true;
  }
  return false;
}

export function createIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function fetchGatewayHealth() {
  const res = await fetch('/api/health', {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    throw new Error(data?.error || `健康检查失败 (HTTP ${res.status})`);
  }
  return data;
}

export async function completeGatewayPairing({ code, deviceName, publicKeyJwk, turboAcknowledged }) {
  const res = await fetch('/api/pair/complete', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      deviceName,
      publicKeyJwk,
      turboAcknowledged: Boolean(turboAcknowledged),
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    const err = new Error(data?.message || data?.error || `配对失败 (HTTP ${res.status})`);
    err.code = data?.error || `http_${res.status}`;
    err.status = res.status;
    throw err;
  }
  return data;
}

function normalizeDelta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.payload && typeof raw.payload === 'object') {
    return {
      seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : null,
      kind: raw.payload.kind || raw.kind || 'unknown',
      ts: raw.payload.ts || raw.ts || Date.now(),
      data: raw.payload.data !== undefined ? raw.payload.data : raw.data,
    };
  }
  return {
    seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : null,
    kind: raw.kind || 'unknown',
    ts: raw.ts || Date.now(),
    data: raw.data,
  };
}

export function createRemoteWsClient(identity, handlers = {}) {
  let ws = null;
  let connectInFlight = false;
  let disposed = false;
  let reconnectTimer = null;
  let pingTimer = null;
  let handshakeTimer = null;
  let resumeProbeTimer = null;
  let attempt = 0;
  let lastSeq = 0;
  let lastEpoch = '';
  let lastActivityAt = 0;
  let lastPingSentAt = 0;
  let lastRttMs = null;
  let networkOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  let lastTransport = '';
  let connected = false;
  let desiredWatchId = null;
  let activeWatchId = null;
  let reqSeq = 0;
  const pending = new Map();

  const emitStatus = (status, detail = '') => {
    try {
      handlers.onStatus?.(status, detail);
    } catch {}
  };

  const emitRtt = (rttMs) => {
    lastRttMs = rttMs;
    try {
      handlers.onRtt?.(rttMs);
    } catch {}
  };

  const clearHandshakeTimer = () => {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  };

  const clearResumeProbeTimer = () => {
    if (resumeProbeTimer) {
      clearTimeout(resumeProbeTimer);
      resumeProbeTimer = null;
    }
  };

  const clearTimers = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    clearHandshakeTimer();
    clearResumeProbeTimer();
  };

  const rejectAllPending = (reason) => {
    for (const [reqId, item] of pending.entries()) {
      clearTimeout(item.timer);
      item.reject(new Error(reason));
      pending.delete(reqId);
    }
  };

  const sendJson = (obj) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  };

  const sendPing = () => {
    const now = Date.now();
    lastPingSentAt = now;
    return sendJson({ type: 'ping', ts: now });
  };

  const startHeartbeat = () => {
    if (pingTimer) clearInterval(pingTimer);
    lastActivityAt = Date.now();
    pingTimer = setInterval(() => {
      if (disposed || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastActivityAt > STALE_TIMEOUT_MS) {
        try {
          ws.close(4000, 'heartbeat_timeout');
        } catch {}
        return;
      }
      sendPing();
    }, PING_INTERVAL_MS);
  };

  const scheduleReconnect = (overrideDelayMs = null, detail = '') => {
    if (disposed) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay =
      overrideDelayMs !== null
        ? overrideDelayMs
        : Math.min(
            MAX_BACKOFF_MS,
            Math.round(BASE_BACKOFF_MS * Math.pow(1.7, attempt) * (0.85 + Math.random() * 0.3))
          );
    attempt += 1;
    emitStatus('reconnecting', detail || `${Math.max(1, Math.round(delay / 1000))}s 后重连`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const request = (method, params = {}, timeoutMs = 12_000) => {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new Error('client_disposed'));
        return;
      }
      if (!ws || ws.readyState !== WebSocket.OPEN || !connected) {
        reject(new Error('ws_not_connected'));
        return;
      }
      reqSeq += 1;
      const reqId = `r${Date.now().toString(36)}-${reqSeq}`;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`请求超时: ${method}`));
      }, timeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      if (!sendJson({ type: 'req', reqId, method, params })) {
        clearTimeout(timer);
        pending.delete(reqId);
        reject(new Error('ws_send_failed'));
      }
    });
  };

  const syncWatchOnServer = async () => {
    if (!desiredWatchId || !UUID_RE.test(desiredWatchId) || !connected) return;
    activeWatchId = desiredWatchId;
    try {
      await request('convo.watch', { cascadeId: desiredWatchId, watch: true });
    } catch {}
    try {
      const snap = await request('convo.snapshot', { cascadeId: desiredWatchId });
      handlers.onSnapshot?.(desiredWatchId, snap);
    } catch (err) {
      handlers.onError?.(err);
    }
  };

  const handleMessage = (rawData) => {
    lastActivityAt = Date.now();
    clearResumeProbeTimer();
    let msg = null;
    try {
      msg = JSON.parse(String(rawData || ''));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ping') {
      sendJson({ type: 'pong', ts: msg.ts || Date.now() });
      return;
    }
    if (msg.type === 'pong') {
      const sentAt = Number(msg.ts) || lastPingSentAt;
      if (sentAt > 0) {
        const rtt = Math.max(1, Date.now() - sentAt);
        if (rtt < 60_000) emitRtt(rtt);
      }
      return;
    }

    if (msg.type === 'res') {
      const entry = pending.get(msg.reqId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(msg.reqId);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        const err = new Error(msg.error?.message || msg.error || '请求失败');
        err.code = msg.error?.code || msg.error;
        entry.reject(err);
      }
      return;
    }

    if (msg.type === 'welcome') {
      clearHandshakeTimer();
      if (typeof msg.epoch === 'string') {
        lastEpoch = msg.epoch;
      }
      if (Number.isFinite(Number(msg.seq))) {
        lastSeq = Number(msg.seq);
      }
      connected = true;
      attempt = 0;
      startHeartbeat();
      sendPing();
      emitStatus('connected', '');
      handlers.onWelcome?.(msg);
      if (desiredWatchId) {
        syncWatchOnServer();
      }
      return;
    }

    if (msg.type === 'deltas') {
      const msgEpoch = typeof msg.epoch === 'string' ? msg.epoch : '';
      if (msgEpoch && lastEpoch && msgEpoch !== lastEpoch) {
        lastEpoch = msgEpoch;
        lastSeq = Number.isFinite(Number(msg.seq)) ? Number(msg.seq) : 0;
        if (connected) {
          refreshList(false).catch(() => {});
        }
      } else {
        if (msgEpoch) lastEpoch = msgEpoch;
        if (Number.isFinite(Number(msg.seq))) {
          lastSeq = Number(msg.seq);
        }
      }
      if (!connected) {
        connected = true;
        attempt = 0;
        startHeartbeat();
        emitStatus('connected', '');
        if (desiredWatchId) {
          syncWatchOnServer();
        }
      }
      if (msg.health && typeof msg.health === 'object') {
        handlers.onHealth?.(msg.health);
      }
      const items = Array.isArray(msg.items) ? msg.items : [];
      for (const item of items) {
        const norm = normalizeDelta(item);
        if (norm) {
          if (norm.seq !== null && norm.seq > lastSeq) lastSeq = norm.seq;
          handlers.onDelta?.(norm);
        }
      }
      return;
    }

    if (msg.type === 'delta') {
      const msgEpoch = typeof msg.epoch === 'string' ? msg.epoch : '';
      if (msgEpoch && lastEpoch && msgEpoch !== lastEpoch) {
        lastEpoch = msgEpoch;
        lastSeq = 0;
      } else if (msgEpoch && !lastEpoch) {
        lastEpoch = msgEpoch;
      }
      const norm = normalizeDelta(msg);
      if (norm) {
        if (norm.seq !== null && norm.seq > lastSeq && (!msgEpoch || msgEpoch === lastEpoch)) {
          lastSeq = norm.seq;
        }
        handlers.onDelta?.(norm);
      }
      return;
    }

    if (msg.type === 'error') {
      const code = String(msg.error || msg.code || '');
      if (/revoked|unknown_device|fingerprint|demoted/i.test(code)) {
        disposed = true;
        clearTimers();
        const label =
          code === 'device_role_demoted'
            ? '设备权限已降级，请重新配对或刷新权限'
            : code === 'device_revoked'
              ? '设备已被吊销'
              : msg.message || code;
        emitStatus('revoked', label);
        try {
          ws?.close(code === 'device_role_demoted' ? 4003 : 4001, code);
        } catch {}
        return;
      }
      handlers.onError?.(new Error(msg.message || code || '网关错误'));
    }
  };

  async function connect() {
    if (disposed || connectInFlight) return;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }
    if (!networkOnline) {
      emitStatus('offline', '网络已断开，等待恢复');
      return;
    }
    connectInFlight = true;
    connected = false;
    emitStatus(attempt === 0 ? 'connecting' : 'reconnecting', '');

    try {
      let challenge = null;
      try {
        const res = await fetch('/api/auth/challenge', {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'manual',
        });
        if (isCloudflareAuthRedirectResponse(res)) {
          emitStatus('auth_expired', 'Cloudflare Access 登录态已过期');
          scheduleReconnect(AUTH_EXPIRED_RETRY_MS, '等待重新登录');
          return;
        }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.nonce) {
          if (res.status === 401 || res.status === 403) {
            if (!data || !data.error || /access|login|cloudflare/i.test(String(data.error))) {
              emitStatus('auth_expired', 'Cloudflare Access 登录态已过期');
              scheduleReconnect(AUTH_EXPIRED_RETRY_MS, '等待重新登录');
              return;
            }
            emitStatus('error', data?.error || `鉴权拒绝 (HTTP ${res.status})`);
            scheduleReconnect(8_000, '等待认证恢复');
            return;
          }
          if (res.status === 429) {
            emitStatus('error', '鉴权失败次数过多，已暂时锁定');
            scheduleReconnect(20_000, '已限流，20s 后重试');
            return;
          }
          throw new Error(data?.error || `获取 challenge 失败 (HTTP ${res.status})`);
        }
        challenge = data;
      } catch (err) {
        handlers.onError?.(err);
        if (!networkOnline) {
          emitStatus('offline', '网络已断开，等待恢复');
          return;
        }
        scheduleReconnect(null, String(err?.message || '网络不可达'));
        return;
      }

      let signature = '';
      const helloSeq = lastEpoch ? lastSeq : 0;
      const helloEpoch = lastEpoch || '';
      try {
        signature = await signChallengePayload({
          privateKey: identity.privateKey,
          nonce: challenge.nonce,
          deviceId: identity.deviceId,
          lastSeq: helloSeq,
          lastEpoch: helloEpoch,
        });
      } catch (err) {
        disposed = true;
        emitStatus('revoked', String(err?.message || '设备签名失败'));
        return;
      }

      if (disposed) return;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${proto}//${window.location.host}/ws`);
      ws = socket;
      clearHandshakeTimer();
      handshakeTimer = setTimeout(() => {
        handshakeTimer = null;
        if (disposed || ws !== socket || connected) return;
        try {
          socket.close(4000, 'handshake_timeout');
        } catch {}
      }, HANDSHAKE_TIMEOUT_MS);

      socket.addEventListener('open', () => {
        if (ws !== socket || disposed) return;
        lastActivityAt = Date.now();
        sendJson({
          type: 'hello',
          protocol: 'maga-remote/1',
          deviceId: identity.deviceId,
          nonce: challenge.nonce,
          signature,
          lastSeq: helloSeq,
          lastEpoch: helloEpoch,
        });
      });

      socket.addEventListener('message', (ev) => {
        if (ws !== socket || disposed) return;
        handleMessage(ev.data);
      });

      socket.addEventListener('close', (ev) => {
        if (ws !== socket) return;
        ws = null;
        connected = false;
        activeWatchId = null;
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        clearHandshakeTimer();
        clearResumeProbeTimer();
        rejectAllPending('connection_closed');
        if (disposed) return;

        const reason = String(ev.reason || '');
        const isTimeoutOrNonce = /timeout|nonce/i.test(reason);
        if (
          (ev.code === 4001 && !isTimeoutOrNonce) ||
          ev.code === 4003 ||
          ev.code === 4401 ||
          ev.code === 4403 ||
          /revoked|unknown_device|fingerprint/i.test(reason)
        ) {
          disposed = true;
          const msg =
            ev.code === 4003 || reason === 'device_role_demoted'
              ? '设备权限已降级，请重新配对或刷新权限'
              : reason === 'device_revoked' || ev.code === 4001
                ? '设备已被吊销，请重新配对'
                : reason || '设备已吊销或网关身份已变更';
          emitStatus('revoked', msg);
          return;
        }
        if (!networkOnline) {
          emitStatus('offline', '网络已断开，等待恢复');
          return;
        }
        if (reason === 'resume_probe_timeout' || reason === 'network_switch') {
          attempt = 0;
          scheduleReconnect(200, '网络切换恢复中');
          return;
        }
        scheduleReconnect(null, reason || `连接已断开 (${ev.code || 1006})`);
      });

      socket.addEventListener('error', () => {
        // close event handles reconnect transition
      });
    } finally {
      connectInFlight = false;
    }
  }

  const probeOrReconnect = ({ forceProbe = false, closeReason = 'resume_probe_timeout' } = {}) => {
    if (disposed) return;
    if (!networkOnline) {
      emitStatus('offline', '网络已断开，等待恢复');
      return;
    }
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      if (connectInFlight) return;
      attempt = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connect();
      return;
    }
    if (ws.readyState === WebSocket.CONNECTING) {
      if (forceProbe) {
        try {
          ws.close(4000, closeReason);
        } catch {}
      }
      return;
    }
    if (ws.readyState === WebSocket.OPEN && connected) {
      sendPing();
      if (!resumeProbeTimer) {
        resumeProbeTimer = setTimeout(() => {
          resumeProbeTimer = null;
          if (disposed || !ws || ws.readyState !== WebSocket.OPEN) return;
          try {
            ws.close(4000, closeReason);
          } catch {}
        }, RESUME_PROBE_MS);
      }
    }
  };

  const onVisibilityOrOnline = () => {
    if (disposed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    networkOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    probeOrReconnect({ forceProbe: false });
  };

  const handleNetworkChange = ({ online = true, transport = '' } = {}) => {
    if (disposed) return;
    const nextOnline = Boolean(online);
    const nextTransport = String(transport || '').trim();
    const wasOffline = !networkOnline;
    const transportChanged = Boolean(nextTransport && lastTransport && nextTransport !== lastTransport);
    networkOnline = nextOnline;
    if (nextTransport) lastTransport = nextTransport;

    if (!nextOnline) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (!connected) {
        emitStatus('offline', '网络已断开，等待恢复');
      } else if (ws && ws.readyState === WebSocket.OPEN) {
        sendPing();
        if (!resumeProbeTimer) {
          resumeProbeTimer = setTimeout(() => {
            resumeProbeTimer = null;
            if (disposed || !ws || ws.readyState !== WebSocket.OPEN) return;
            try {
              ws.close(4000, 'network_lost');
            } catch {}
          }, RESUME_PROBE_MS);
        }
      }
      return;
    }

    if (wasOffline || transportChanged || !connected) {
      probeOrReconnect({ forceProbe: wasOffline || transportChanged, closeReason: 'network_switch' });
    }
  };

  const handleNativeResume = () => {
    if (disposed) return;
    networkOnline = true;
    probeOrReconnect({ forceProbe: false, closeReason: 'resume_probe_timeout' });
  };

  const onBrowserOffline = () => {
    handleNetworkChange({ online: false });
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('online', onVisibilityOrOnline);
    window.addEventListener('offline', onBrowserOffline);
    window.addEventListener('pageshow', onVisibilityOrOnline);
    window.addEventListener('focus', onVisibilityOrOnline);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityOrOnline);
  }

  async function watchConversation(cascadeId) {
    const nextId = cascadeId && UUID_RE.test(cascadeId) ? cascadeId : null;
    const prevId = activeWatchId;
    desiredWatchId = nextId;

    if (prevId && prevId !== nextId && connected) {
      activeWatchId = null;
      request('convo.watch', { cascadeId: prevId, watch: false }).catch(() => {});
    }

    if (!nextId) return null;
    if (!connected) return null;

    activeWatchId = nextId;
    try {
      await request('convo.watch', { cascadeId: nextId, watch: true });
    } catch {}
    return request('convo.snapshot', { cascadeId: nextId });
  }

  function refreshList(includeSubagents = false) {
    return request('convo.list', { includeSubagents: Boolean(includeSubagents) });
  }

  function fetchSnapshot(cascadeId) {
    if (!cascadeId || !UUID_RE.test(cascadeId)) {
      return Promise.reject(new Error('invalid_cascade_id'));
    }
    return request('convo.snapshot', { cascadeId });
  }

  function sendMessage(
    cascadeId,
    text = '',
    { idempotencyKey = createIdempotencyKey(), turboWriteConfirmed = false, media = [] } = {}
  ) {
    if (!cascadeId || !UUID_RE.test(cascadeId)) {
      return Promise.reject(new Error('invalid_cascade_id'));
    }
    const cleanText = typeof text === 'string' ? text : '';
    const cleanMedia = Array.isArray(media)
      ? media
          .filter((m) => m && typeof m.dataBase64 === 'string' && typeof m.mimeType === 'string')
          .slice(0, 4)
          .map((m) => ({
            name: String(m.name || 'remote-image.png').slice(0, 128),
            mimeType: String(m.mimeType),
            dataBase64: String(m.dataBase64),
          }))
      : [];
    if (!cleanText.trim() && cleanMedia.length === 0) {
      return Promise.reject(new Error('empty_message'));
    }
    return request(
      'convo.send',
      {
        cascadeId,
        text: cleanText,
        ...(cleanMedia.length ? { media: cleanMedia } : {}),
        idempotencyKey,
        turboWriteConfirmed: Boolean(turboWriteConfirmed),
      },
      cleanMedia.length ? 30_000 : 25_000
    );
  }

  function fetchModels(cascadeId = '') {
    const cid = typeof cascadeId === 'string' && UUID_RE.test(cascadeId.trim()) ? cascadeId.trim() : '';
    return request('models.list', cid ? { cascadeId: cid } : {}, 8_000);
  }

  function selectModel({
    cascadeId = '',
    model,
    plannerModel = null,
    customLabel = '',
    idempotencyKey = createIdempotencyKey(),
  } = {}) {
    const cid = typeof cascadeId === 'string' && UUID_RE.test(cascadeId.trim()) ? cascadeId.trim() : '';
    if (model === undefined || model === null || model === '') {
      return Promise.reject(new Error('invalid_model'));
    }
    return request(
      'models.select',
      {
        ...(cid ? { cascadeId: cid } : {}),
        model,
        ...(plannerModel !== undefined && plannerModel !== null && plannerModel !== '' ? { plannerModel } : {}),
        ...(customLabel ? { customLabel: String(customLabel) } : {}),
        idempotencyKey,
      },
      12_000
    );
  }

  function approveWaitingStep(
    cascadeId,
    { stepIndex, waitingStepHash, decision, answers = null, idempotencyKey = createIdempotencyKey() } = {}
  ) {
    if (!cascadeId || !UUID_RE.test(cascadeId)) {
      return Promise.reject(new Error('invalid_cascade_id'));
    }
    const validDecision =
      decision === 'allow_once' ||
      decision === 'deny' ||
      decision === 'answer_question' ||
      decision === 'cancel_question';
    if (!validDecision) {
      return Promise.reject(new Error('invalid_decision'));
    }
    const payload = {
      cascadeId,
      stepIndex,
      waitingStepHash,
      decision,
      idempotencyKey,
    };
    if (decision === 'answer_question' && Array.isArray(answers)) {
      payload.answers = answers;
    }
    return request('convo.approve', payload, 22_000);
  }

  function cancelConversation(cascadeId, { killBackgroundTasks = false, idempotencyKey = createIdempotencyKey() } = {}) {
    if (!cascadeId || !UUID_RE.test(cascadeId)) {
      return Promise.reject(new Error('invalid_cascade_id'));
    }
    return request(
      'convo.cancel',
      {
        cascadeId,
        killBackgroundTasks: Boolean(killBackgroundTasks),
        idempotencyKey,
      },
      18_000
    );
  }

  function fetchStudioOverview(cascadeId = '') {
    const cid = typeof cascadeId === 'string' && UUID_RE.test(cascadeId.trim()) ? cascadeId.trim() : '';
    return request('studio.overview', cid ? { cascadeId: cid } : {}, 10_000);
  }

  function fetchResumeState(cascadeId) {
    if (!cascadeId || !UUID_RE.test(cascadeId)) {
      return Promise.reject(new Error('invalid_cascade_id'));
    }
    return request('convo.resumeState', { cascadeId }, 8_000);
  }

  function resumeConversation(
    cascadeId,
    { expectedLastIdx, turboWriteConfirmed = false, idempotencyKey = createIdempotencyKey() } = {}
  ) {
    if (!cascadeId || !UUID_RE.test(cascadeId)) {
      return Promise.reject(new Error('invalid_cascade_id'));
    }
    if (!Number.isInteger(expectedLastIdx) || expectedLastIdx < 0) {
      return Promise.reject(new Error('invalid_expected_last_idx'));
    }
    return request(
      'convo.resume',
      {
        cascadeId,
        expectedLastIdx,
        turboWriteConfirmed: Boolean(turboWriteConfirmed),
        idempotencyKey,
      },
      25_000
    );
  }

  function compactConversation(cascadeId, { idempotencyKey = createIdempotencyKey() } = {}) {
    if (!cascadeId || !UUID_RE.test(cascadeId)) {
      return Promise.reject(new Error('invalid_cascade_id'));
    }
    return request('convo.compact', { cascadeId, idempotencyKey }, 18_000);
  }

  function dismissOpusProposal(cascadeId, proposalId, { ts, idempotencyKey = createIdempotencyKey() } = {}) {
    if (!cascadeId || !UUID_RE.test(cascadeId)) {
      return Promise.reject(new Error('invalid_cascade_id'));
    }
    if (!proposalId || typeof proposalId !== 'string') {
      return Promise.reject(new Error('invalid_proposal_id'));
    }
    return request(
      'opus.dismiss',
      {
        cascadeId,
        proposalId,
        ...(Number.isFinite(Number(ts)) && Number(ts) > 0 ? { ts: Number(ts) } : {}),
        idempotencyKey,
      },
      12_000
    );
  }

  function createConversation({ projectId = '', text = '', idempotencyKey = '', turboWriteConfirmed = false } = {}) {
    if (!text || !String(text).trim()) {
      return Promise.reject(new Error('invalid_text_length'));
    }
    return request(
      'convo.create',
      {
        text: String(text),
        ...(projectId ? { projectId: String(projectId) } : {}),
        idempotencyKey: idempotencyKey || `create-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        turboWriteConfirmed: Boolean(turboWriteConfirmed),
      },
      20_000
    );
  }

  function dispose() {
    disposed = true;
    clearTimers();
    rejectAllPending('disposed');
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onVisibilityOrOnline);
      window.removeEventListener('offline', onBrowserOffline);
      window.removeEventListener('pageshow', onVisibilityOrOnline);
      window.removeEventListener('focus', onVisibilityOrOnline);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityOrOnline);
    }
    if (ws) {
      if (activeWatchId && connected) {
        try {
          sendJson({
            type: 'req',
            reqId: `unwatch-${Date.now()}`,
            method: 'convo.watch',
            params: { cascadeId: activeWatchId, watch: false },
          });
        } catch {}
      }
      try {
        ws.close(1000, 'client_dispose');
      } catch {}
      ws = null;
    }
    connected = false;
    emitStatus('disconnected', '');
  }

  connect();

  return {
    request,
    watchConversation,
    refreshList,
    fetchSnapshot,
    createConversation,
    sendMessage,
    approveWaitingStep,
    cancelConversation,
    fetchStudioOverview,
    fetchResumeState,
    resumeConversation,
    compactConversation,
    dismissOpusProposal,
    fetchModels,
    selectModel,
    handleNetworkChange,
    handleNativeResume,
    getStats: () => ({
      connected,
      lastRttMs,
      lastSeq,
      attempt,
      networkOnline,
      lastTransport,
    }),
    reconnectNow: () => {
      if (!disposed) {
        networkOnline = true;
        attempt = 0;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          try {
            ws.close(4000, 'network_switch');
          } catch {}
          return;
        }
        connect();
      }
    },
    dispose,
  };
}
