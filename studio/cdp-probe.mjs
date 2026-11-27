/**
 * Shared cross-platform CDP probe utilities for live Antigravity Desktop inspection
 * (used by `studio/capture-chrome-fixture.mjs` and `studio/smoke-live.mjs`).
 */
import { existsSync } from 'node:fs';
import { discoverEndpoints, readPort } from '../core/daemon/env.mjs';

export function resolveLiveCdpPort({
  endpoints = discoverEndpoints(),
  existsSyncFn = existsSync,
  readPortFn = readPort,
} = {}) {
  for (const ep of endpoints || []) {
    if (!ep?.portFile || !existsSyncFn(ep.portFile)) continue;
    const port = readPortFn(ep.portFile);
    if (port > 0) {
      return {
        port,
        channel: ep.channel || null,
        portFile: ep.portFile,
      };
    }
  }
  return { port: 0, channel: null, portFile: null };
}

export function selectWorkspacePage(pages) {
  if (!Array.isArray(pages)) return null;
  const candidates = pages.filter((p) => {
    if (!p || p.type !== 'page' || typeof p.webSocketDebuggerUrl !== 'string' || !p.webSocketDebuggerUrl) {
      return false;
    }
    const url = String(p.url || '').trim();
    return !/^(?:data:|devtools:|about:blank)/i.test(url);
  });
  if (candidates.length === 0) return null;
  const localAppPage = candidates.find((p) => /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(String(p.url || '')));
  return localAppPage || candidates[0];
}

export async function evaluateOnAntigravityPage(
  expression,
  {
    port = 0,
    timeoutMs = 5000,
    fetchImpl = fetch,
    WebSocketImpl = WebSocket,
    resolvePort = resolveLiveCdpPort,
  } = {}
) {
  const resolved = port > 0 ? { port, channel: null, portFile: null } : resolvePort();
  const targetPort = Number(resolved?.port || 0);
  if (!(targetPort > 0)) {
    return {
      ok: false,
      port: 0,
      error: 'Antigravity DevToolsActivePort not found or unreadable',
    };
  }

  let pages = null;
  try {
    const fetchOpts =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? { signal: AbortSignal.timeout(timeoutMs) }
        : undefined;
    const res = await fetchImpl(`http://127.0.0.1:${targetPort}/json/list`, fetchOpts);
    if (!res.ok) {
      return {
        ok: false,
        port: targetPort,
        error: `CDP /json/list returned HTTP ${res.status}`,
      };
    }
    pages = await res.json();
  } catch (err) {
    return {
      ok: false,
      port: targetPort,
      error: `Failed to query CDP /json/list on port ${targetPort}: ${err?.message || err}`,
    };
  }

  const page = selectWorkspacePage(pages);
  if (!page) {
    return {
      ok: false,
      port: targetPort,
      error: `No active Antigravity workspace page target found on CDP port ${targetPort}`,
    };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let ws = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws && typeof ws.close === 'function') ws.close();
      } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        port: targetPort,
        error: `CDP Runtime.evaluate timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    try {
      ws = new WebSocketImpl(page.webSocketDebuggerUrl);
    } catch (err) {
      finish({
        ok: false,
        port: targetPort,
        error: `Failed to open CDP WebSocket: ${err?.message || err}`,
      });
      return;
    }

    const onOpen = () => {
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression,
              returnByValue: true,
              awaitPromise: true,
            },
          })
        );
      } catch (err) {
        finish({
          ok: false,
          port: targetPort,
          error: `Failed to send CDP Runtime.evaluate: ${err?.message || err}`,
        });
      }
    };

    const onMessage = (event) => {
      let payload = null;
      try {
        const raw = typeof event === 'string' ? event : event?.data;
        payload = JSON.parse(String(raw || ''));
      } catch {
        return;
      }
      if (!payload || payload.id !== 1) return;
      if (payload.error) {
        finish({
          ok: false,
          port: targetPort,
          error: payload.error.message || JSON.stringify(payload.error),
        });
        return;
      }
      const evalRes = payload.result;
      if (evalRes?.exceptionDetails) {
        finish({
          ok: false,
          port: targetPort,
          error: evalRes.exceptionDetails.text || 'CDP evaluation threw an exception',
        });
        return;
      }
      finish({
        ok: true,
        port: targetPort,
        value: evalRes?.result?.value ?? null,
      });
    };

    const onError = (err) => {
      finish({
        ok: false,
        port: targetPort,
        error: `CDP WebSocket error: ${err?.message || err?.type || 'connection failed'}`,
      });
    };

    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', onError);
    } else {
      ws.onopen = onOpen;
      ws.onmessage = onMessage;
      ws.onerror = onError;
    }
  });
}
