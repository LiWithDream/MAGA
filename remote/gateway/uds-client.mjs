/**
 * MAGA Remote Gateway — UDS NDJSON RPC & Tap Event Client (O(n) Buffer framing)
 * Zero third-party dependencies (Node >= 22 built-ins only).
 */
import net from 'node:net';
import { resolveSockPath } from './config.mjs';

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024; // 8MB line guard

export function createUdsClient({
  sockPath = resolveSockPath(),
  connectTimeoutMs = 1500,
  requestTimeoutMs = 5000,
  initialReconnectMs = 250,
  maxReconnectMs = 5000,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  autoConnect = true,
} = {}) {
  let socket = null;
  let connected = false;
  let closed = false;
  let nextId = 1;
  let rxBuf = Buffer.alloc(0);
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let connectPromise = null;
  let backoffUntil = 0;

  const pending = new Map();
  const tapListeners = new Set();
  const connectListeners = new Set();
  const disconnectListeners = new Set();

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function rejectPending(err) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id !== undefined && msg.id !== null) {
      const key = String(msg.id);
      const req = pending.get(key);
      if (!req) return;
      pending.delete(key);
      clearTimeout(req.timer);
      if (msg.ok) {
        req.resolve(msg.result);
      } else {
        const errCode = typeof msg.error === 'string' ? msg.error : msg.error?.message || 'uds_rpc_error';
        const err = new Error(errCode);
        err.code = errCode;
        err.detail = msg.error;
        req.reject(err);
      }
      return;
    }
    if (msg.event === 'tap') {
      for (const fn of tapListeners) {
        try {
          fn(msg.payload);
        } catch {}
      }
    }
  }

  function processChunk(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    rxBuf = rxBuf.length > 0 ? Buffer.concat([rxBuf, buf]) : buf;
    if (rxBuf.length > maxLineBytes) {
      rxBuf = Buffer.alloc(0);
      try {
        socket?.destroy(new Error('uds_line_too_large'));
      } catch {}
      return;
    }
    let idx;
    while ((idx = rxBuf.indexOf(0x0a)) !== -1) {
      const line = rxBuf.subarray(0, idx).toString('utf8').trim();
      rxBuf = rxBuf.subarray(idx + 1);
      if (!line) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      handleMessage(parsed);
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.min(maxReconnectMs, initialReconnectMs * Math.pow(2, Math.min(reconnectAttempts, 6)));
    reconnectAttempts += 1;
    backoffUntil = Date.now() + delay;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) {
        connect().catch(() => {});
      }
    }, delay);
    reconnectTimer.unref?.();
  }

  function connect() {
    if (closed) return Promise.reject(new Error('uds_closed'));
    if (connected && socket && !socket.destroyed) return Promise.resolve();
    if (connectPromise) return connectPromise;

    clearReconnectTimer();
    connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const conn = net.createConnection({ path: sockPath });
      socket = conn;
      rxBuf = Buffer.alloc(0);

      const connTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          connectPromise = null;
          try {
            conn.destroy(new Error('uds_connect_timeout'));
          } catch {}
          scheduleReconnect();
          reject(new Error('uds_connect_timeout'));
        }
      }, connectTimeoutMs);
      connTimer.unref?.();

      conn.once('connect', () => {
        clearTimeout(connTimer);
        if (closed) {
          try {
            conn.destroy();
          } catch {}
          if (!settled) {
            settled = true;
            connectPromise = null;
            reject(new Error('uds_closed'));
          }
          return;
        }
        connected = true;
        reconnectAttempts = 0;
        backoffUntil = 0;
        if (!settled) {
          settled = true;
          connectPromise = null;
          resolve();
        }
        for (const fn of connectListeners) {
          try {
            fn();
          } catch {}
        }
      });

      conn.on('data', processChunk);

      const handleDown = (reason) => {
        clearTimeout(connTimer);
        const wasConnected = connected;
        connected = false;
        if (socket === conn) {
          socket = null;
        }
        rxBuf = Buffer.alloc(0);
        rejectPending(new Error(reason));
        if (!settled) {
          settled = true;
          connectPromise = null;
          if (!closed) scheduleReconnect();
          reject(new Error(reason));
          return;
        }
        if (wasConnected) {
          for (const fn of disconnectListeners) {
            try {
              fn(reason);
            } catch {}
          }
        }
        if (!closed) scheduleReconnect();
      };

      conn.once('error', (err) => {
        handleDown(err?.code || err?.message || 'uds_error');
      });

      conn.once('close', () => {
        handleDown('uds_disconnected');
      });
    });

    return connectPromise;
  }

  async function request(method, params = {}, opts = {}) {
    if (closed) throw new Error('uds_closed');
    if (!connected || !socket || socket.destroyed) {
      if (Date.now() < backoffUntil && !opts.forceReconnect) {
        throw new Error('uds_unavailable');
      }
      await connect().catch(() => {
        throw new Error('uds_unavailable');
      });
    }
    if (!connected || !socket || socket.destroyed) {
      throw new Error('uds_unavailable');
    }

    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : requestTimeoutMs;
    const id = String(nextId++);
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`uds_timeout:${method}`));
      }, timeoutMs);
      timer.unref?.();

      pending.set(id, { resolve, reject, timer });
      try {
        socket.write(payload, 'utf8', (err) => {
          if (err && pending.has(id)) {
            pending.delete(id);
            clearTimeout(timer);
            reject(err);
          }
        });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function onTap(listener) {
    if (typeof listener !== 'function') return () => {};
    tapListeners.add(listener);
    return () => tapListeners.delete(listener);
  }

  function onConnect(listener) {
    if (typeof listener !== 'function') return () => {};
    connectListeners.add(listener);
    return () => connectListeners.delete(listener);
  }

  function onDisconnect(listener) {
    if (typeof listener !== 'function') return () => {};
    disconnectListeners.add(listener);
    return () => disconnectListeners.delete(listener);
  }

  function close() {
    if (closed) return;
    closed = true;
    connected = false;
    clearReconnectTimer();
    rejectPending(new Error('uds_closed'));
    if (socket) {
      try {
        socket.destroy();
      } catch {}
      socket = null;
    }
    rxBuf = Buffer.alloc(0);
    tapListeners.clear();
    connectListeners.clear();
    disconnectListeners.clear();
  }

  if (autoConnect) {
    connect().catch(() => {});
  }

  return {
    sockPath,
    connect,
    request,
    onTap,
    onConnect,
    onDisconnect,
    isConnected: () => connected,
    close,
  };
}
