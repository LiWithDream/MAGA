/**
 * 5. CDP Target Discovery, Host Verification & Session Attachment
 */
import crypto from 'node:crypto';
import {
  UUID_RE,
  attachedTargets,
  runtimeState,
  skippedNonHostTargets,
  targetThemeModes
} from './env.mjs';
import { parseConversationMetrics } from './metrics-db.mjs';
import { handleProjectRpcRequest } from './overview-skills.mjs';
import { buildRuntimeScript, getActiveConfig, getBundleHash } from './prefs-bundle.mjs';

const NON_HOST_SKIP_TTL_MS = 15000;

export function isAllowedOrigin(rawUrl) {
  const s = String(rawUrl || '');
  if (!s || s === 'about:blank') return false;
  if (s.startsWith('plugin://swarm--') || s.startsWith('vscode-file://')) return true;
  if (s.startsWith('file://')) {
    return /\/Antigravity\.app\/|\/antigravity\/resources\/|\/workbench\.html\b|\/jetski\b/i.test(s);
  }
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

export function getOriginKey(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(rawUrl || '');
  }
}

export async function fetchTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, targets: [] };
    const list = await res.json();
    return { ok: true, targets: Array.isArray(list) ? list : [] };
  } catch {
    return { ok: false, targets: [] };
  }
}

export async function isAntigravityFallbackPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return false;
    const info = await res.json();
    const ua = String(info?.['User-Agent'] || '');
    const browser = String(info?.Browser || '');
    return /\bAntigravity\b|\bElectron\//i.test(`${ua} ${browser}`);
  } catch {
    return false;
  }
}

export const HOST_IDENTITY_PROBE_EXPR = `(function () {
  var loc = (typeof window !== 'undefined' && window.location) || {};
  if (loc.protocol === 'plugin:' && /^swarm--/i.test(loc.hostname || '')) return 'swarm';
  if (/^plugin:\\/\\/swarm--/i.test(loc.href || '')) return 'swarm';
  if (loc.protocol === 'vscode-file:') return 'host';
  if (loc.protocol === 'file:' && /\\/Antigravity\\.app\\/|\\/antigravity\\/resources\\//i.test(loc.href || '')) return 'host';
  var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  var isElectronHost = /\\bElectron\\//i.test(ua);
  if (!isElectronHost) return 'non_host';
  /* Require the genuine non-configurable, frozen contextBridge preload object rather than page-forgeable DOM or globals */
  var en = typeof window !== 'undefined' ? window.electronNative : null;
  if (en && typeof en === 'object' && Object.isFrozen(en)) {
    var desc = Object.getOwnPropertyDescriptor(window, 'electronNative');
    var lockedOnWindow = Boolean(desc && desc.configurable === false && desc.writable === false);
    var isNativeFn = function (fn) {
      if (typeof fn !== 'function') return false;
      var name = String(fn.name || '');
      if (name.indexOf('bound ') === 0) return false;
      try { return Function.prototype.toString.call(fn).indexOf('[native code]') !== -1; } catch (_) { return false; }
    };
    if (lockedOnWindow && isNativeFn(en.getZoomLevel) && isNativeFn(en.setTitleBarOverlay) && isNativeFn(en.openExternal)) {
      return 'host';
    }
  }
  if (document.readyState === 'loading') return 'loading';
  return 'non_host';
})()`;

function resolveParentHostTheme(page) {
  if (page.parentId && targetThemeModes.has(page.parentId)) {
    return targetThemeModes.get(page.parentId);
  }
  for (const [, mode] of targetThemeModes.entries()) {
    if (mode === 'dark' || mode === 'light') return mode;
  }
  return null;
}

export async function attachTarget(page, endpoint, opts = {}) {
  const readOnly = Boolean(opts && opts.readOnly);
  const wsUrl = String(page.webSocketDebuggerUrl || '').replace(/^ws:\/\/localhost:/i, 'ws://127.0.0.1:');
  if (!wsUrl) return;

  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    return;
  }

  let nextId = 1;
  let closed = false;
  const pending = new Map();

  const failAll = (reason) => {
    closed = true;
    for (const [, p] of pending) p.reject(new Error(reason));
    pending.clear();
  };

  const send = (method, params = {}, timeoutMs = 4000) =>
    new Promise((resolve, reject) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return reject(new Error('ws_not_open'));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`cdp_timeout:${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e))
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });

  const entry = {
    id: page.id,
    type: page.type,
    url: page.url,
    parentId: page.parentId || null,
    endpoint,
    ws,
    send,
    hostConfirmed: false,
    mainFrameId: null,
    trustedContextId: null,
    rpcToken: '',
    rpcSessionId: '',
    navGen: 0,
    contextMeta: new Map(),
    defaultContextByFrame: new Map(),
    newDocScriptId: null,
    injectedBundleHash: '',
    watchedCascadeId: '',
    lastMetricsSig: '',
    revokeHostAuth() {
      entry.hostConfirmed = false;
      entry.trustedContextId = null;
      entry.rpcToken = '';
      entry.rpcSessionId = '';
      entry.injectedBundleHash = '';
    },
    isAuthorizedBindingCaller(executionContextId) {
      if (!entry.hostConfirmed) return false;
      if (entry.trustedContextId !== null) {
        return executionContextId === entry.trustedContextId;
      }
      if (typeof executionContextId === 'number' && entry.contextMeta.size > 0) {
        const meta = entry.contextMeta.get(executionContextId);
        if (!meta || !meta.isDefault) return false;
        if (entry.mainFrameId && meta.frameId && meta.frameId !== entry.mainFrameId) return false;
        if (meta.origin && meta.origin !== '://' && !isAllowedOrigin(meta.origin)) return false;
        return true;
      }
      return entry.contextMeta.size === 0;
    },
    updateTargetUrl(nextUrl) {
      entry.url = nextUrl;
      const m = String(nextUrl || '').match(/\/c\/([0-9a-f-]{36})/i);
      if (m && m[1] !== entry.watchedCascadeId) {
        entry.watchedCascadeId = m[1];
        entry.lastMetricsSig = '';
      }
    }
  };

  entry.updateTargetUrl(page.url);

  const evalInHostContext = (expression, returnByValue = false) => {
    const params = { expression, returnByValue };
    if (entry.trustedContextId !== null) params.contextId = entry.trustedContextId;
    return send('Runtime.evaluate', params);
  };

  const probeHostKind = async (contextId = null) => {
    let probeKind = 'non_host';
    for (let attempt = 0; attempt < 3; attempt++) {
      const evalParams = { expression: HOST_IDENTITY_PROBE_EXPR, returnByValue: true };
      if (contextId !== null) evalParams.contextId = contextId;
      const probeRes = await send('Runtime.evaluate', evalParams).catch(() => null);
      if (!probeRes) return 'error';
      probeKind = probeRes?.result?.result?.value || 'non_host';
      if (probeKind !== 'loading') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return probeKind;
  };

  const pushMetricsToTarget = async (cascadeId, force = false) => {
    const activeConfig = getActiveConfig();
    if (!entry.hostConfirmed || !activeConfig.enabled || activeConfig.modules.metrics === false || page.type === 'iframe') return;
    const cid = cascadeId || entry.watchedCascadeId;
    if (!cid || !UUID_RE.test(cid)) return;
    const payload = parseConversationMetrics(cid, entry.endpoint.conversationsDir);
    if (!payload) return;
    if (payload.transientError) {
      if (force && payload.cachedPayload) {
        await evalInHostContext(
          `window.__ag_render_metrics && window.__ag_render_metrics(${JSON.stringify(payload.cachedPayload)})`,
          false
        ).catch(() => {});
      }
      return;
    }
    if (!force && payload.sig && payload.sig === entry.lastMetricsSig) return;
    entry.lastMetricsSig = payload.sig || '';
    await evalInHostContext(
      `window.__ag_render_metrics && window.__ag_render_metrics(${JSON.stringify(payload)})`,
      false
    ).catch(() => {});
  };

  entry.syncMetricsForSession = async (force = false) => {
    const activeConfig = getActiveConfig();
    if (!entry.hostConfirmed || page.type === 'iframe' || !activeConfig.enabled) return;
    if (!entry.watchedCascadeId) {
      const r = await evalInHostContext('window.__ag_watched_cascade_id || ""', true).catch(() => null);
      const cid = r?.result?.result?.value;
      if (cid && UUID_RE.test(cid)) entry.watchedCascadeId = cid;
    }
    if (entry.watchedCascadeId) {
      await pushMetricsToTarget(entry.watchedCascadeId, force);
    }
  };

  entry.updateNewDocScript = async () => {
    if (!entry.hostConfirmed) return;
    const activeConfig = getActiveConfig();
    if (entry.newDocScriptId) {
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.newDocScriptId }).catch(() => {});
      entry.newDocScriptId = null;
    }
    if (!activeConfig.enabled) return;
    const hostMode = page.type === 'iframe' ? resolveParentHostTheme(page) : null;
    const scriptSource = buildRuntimeScript(hostMode, '');
    if (!scriptSource) return;
    const res = await send('Page.addScriptToEvaluateOnNewDocument', { source: scriptSource }).catch(() => null);
    entry.newDocScriptId = res?.result?.identifier || null;
  };

  entry.injectNow = async (issueRpcAuth = true) => {
    if (!entry.hostConfirmed) return;
    const hostMode = page.type === 'iframe' ? resolveParentHostTheme(page) : null;
    if (issueRpcAuth && page.type === 'page') {
      if (!entry.rpcToken) entry.rpcToken = crypto.randomBytes(24).toString('hex');
      if (!entry.rpcSessionId) entry.rpcSessionId = crypto.randomBytes(12).toString('hex');
    }
    const scriptSource = buildRuntimeScript(
      hostMode,
      issueRpcAuth && page.type === 'page' ? entry.rpcToken : '',
      issueRpcAuth && page.type === 'page' ? entry.rpcSessionId : ''
    );
    if (!scriptSource) return;
    const evalRes = await evalInHostContext(scriptSource, true).catch(() => null);
    entry.injectedBundleHash = getBundleHash();
    const resolvedMode = evalRes?.result?.result?.value;
    if (page.type === 'page' && (resolvedMode === 'dark' || resolvedMode === 'light')) {
      targetThemeModes.set(page.id, resolvedMode);
    }
  };

  entry.checkAndInject = async (force = false) => {
    if (!entry.hostConfirmed) return;
    if (force || entry.injectedBundleHash !== getBundleHash()) {
      await entry.injectNow();
      return;
    }
    const activeConfig = getActiveConfig();
    if (!activeConfig.enabled) return;
    const needCustomJs = page.type === 'page' && activeConfig.modules.customJs !== false;
    const sessionCheck =
      page.type === 'page' && entry.rpcSessionId
        ? ` && window.__ag_rpc_session_id === ${JSON.stringify(entry.rpcSessionId)}`
        : '';
    const probe = await evalInHostContext(
      `Boolean(document.getElementById("ag-custom-fonts"))${sessionCheck} && (!document.body || !${needCustomJs} || Boolean(window.__ag_custom_js_mounted))`,
      true
    ).catch(() => null);
    if (probe?.result?.result?.value === false) {
      await entry.injectNow();
    }
  };

  const bindHostBindings = async () => {
    if (page.type !== 'page') return;
    const bindParams = (name) =>
      entry.trustedContextId !== null ? { name, executionContextId: entry.trustedContextId } : { name };
    for (const name of ['__agRequestMetrics', '__agSyncHostThemeMode', '__agProjectRpc']) {
      await send('Runtime.addBinding', bindParams(name)).catch(() =>
        send('Runtime.addBinding', { name }).catch(() => {})
      );
    }
  };

  entry.reverifyAfterNavigation = async (gen) => {
    if (closed || gen !== entry.navGen) return;
    if (!isAllowedOrigin(entry.url)) {
      skippedNonHostTargets.set(page.id, { origin: getOriginKey(entry.url), expiresAt: Date.now() + NON_HOST_SKIP_TTL_MS });
      try {
        ws.close();
      } catch {}
      return;
    }
    const candidateCtxId = (entry.mainFrameId && entry.defaultContextByFrame.get(entry.mainFrameId)) || null;
    const probeKind = await probeHostKind(candidateCtxId);
    if (closed || gen !== entry.navGen) return;
    if (probeKind === 'loading') {
      setTimeout(() => entry.reverifyAfterNavigation(gen).catch(() => {}), 200).unref?.();
      return;
    }
    if (probeKind !== 'host' && probeKind !== 'swarm') {
      skippedNonHostTargets.set(page.id, { origin: getOriginKey(entry.url), expiresAt: Date.now() + NON_HOST_SKIP_TTL_MS });
      try {
        ws.close();
      } catch {}
      return;
    }
    entry.trustedContextId =
      (entry.mainFrameId && entry.defaultContextByFrame.get(entry.mainFrameId)) ?? candidateCtxId ?? null;
    entry.hostConfirmed = true;
    if (readOnly) return;
    entry.rpcToken = page.type === 'page' ? crypto.randomBytes(24).toString('hex') : '';
    entry.rpcSessionId = page.type === 'page' ? crypto.randomBytes(12).toString('hex') : '';
    await bindHostBindings();
    await entry.injectNow();
    await entry.syncMetricsForSession(true);
  };

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.resolve(msg);
      }
      return;
    }
    if (msg.method === 'Runtime.executionContextCreated') {
      const ctx = msg.params?.context;
      if (ctx && typeof ctx.id === 'number') {
        const frameId = ctx.auxData?.frameId || null;
        const isDefault = ctx.auxData?.isDefault !== false && (!ctx.auxData?.type || ctx.auxData.type === 'default');
        entry.contextMeta.set(ctx.id, { frameId, isDefault, origin: String(ctx.origin || '') });
        if (isDefault && frameId) {
          entry.defaultContextByFrame.set(frameId, ctx.id);
          if (!entry.mainFrameId) entry.mainFrameId = frameId;
        }
      }
      return;
    }
    if (msg.method === 'Runtime.executionContextDestroyed') {
      const cid = msg.params?.executionContextId;
      if (typeof cid === 'number') {
        const meta = entry.contextMeta.get(cid);
        if (meta?.frameId && entry.defaultContextByFrame.get(meta.frameId) === cid) {
          entry.defaultContextByFrame.delete(meta.frameId);
        }
        entry.contextMeta.delete(cid);
        if (entry.trustedContextId === cid) {
          entry.revokeHostAuth();
        }
      }
      return;
    }
    if (msg.method === 'Runtime.executionContextsCleared') {
      entry.contextMeta.clear();
      entry.defaultContextByFrame.clear();
      entry.revokeHostAuth();
      return;
    }
    if (msg.method === 'Page.frameNavigated' && !msg.params?.frame?.parentId) {
      entry.revokeHostAuth();
      const nextFrameId = msg.params?.frame?.id;
      if (nextFrameId) entry.mainFrameId = nextFrameId;
      entry.updateTargetUrl(msg.params?.frame?.url || entry.url);
      const gen = ++entry.navGen;
      setTimeout(() => {
        entry.reverifyAfterNavigation(gen).catch(() => {});
      }, 60);
      return;
    }
    if (!entry.hostConfirmed) return;
    if (msg.method === 'Runtime.bindingCalled') {
      const { name, payload, executionContextId } = msg.params || {};
      if (!entry.isAuthorizedBindingCaller(executionContextId)) return;
      if (name === '__agRequestMetrics' && payload && UUID_RE.test(payload)) {
        entry.watchedCascadeId = payload;
        entry.lastMetricsSig = '';
        pushMetricsToTarget(payload, true).catch(() => {});
      } else if (name === '__agSyncHostThemeMode' && (payload === 'dark' || payload === 'light')) {
        targetThemeModes.set(page.id, payload);
        for (const [, other] of attachedTargets.entries()) {
          if (other.type === 'iframe' && other.hostConfirmed) {
            other
              .send('Runtime.evaluate', {
                expression: `window.__ag_set_host_theme_mode && window.__ag_set_host_theme_mode(${JSON.stringify(payload)})`,
                returnByValue: false
              })
              .catch(() => {});
          }
        }
      } else if (name === '__agProjectRpc' && payload) {
        let parsedEnv = null;
        try {
          parsedEnv = JSON.parse(String(payload));
        } catch {
          return;
        }
        if (!entry.rpcToken || !parsedEnv || parsedEnv.token !== entry.rpcToken) {
          if (parsedEnv?.reqId) {
            evalInHostContext(
              `window.__ag_project_rpc_resolve && window.__ag_project_rpc_resolve(${JSON.stringify(parsedEnv.reqId)}, { ok: false, error: "unauthorized_context" })`,
              false
            ).catch(() => {});
          }
          return;
        }
        const expectedContextId = entry.trustedContextId;
        const expectedToken = entry.rpcToken;
        handleProjectRpcRequest(payload, entry)
          .then((reply) => {
            if (!reply || !entry.hostConfirmed || entry.rpcToken !== expectedToken || entry.trustedContextId !== expectedContextId) {
              return;
            }
            return evalInHostContext(
              `window.__ag_project_rpc_resolve && window.__ag_project_rpc_resolve(${JSON.stringify(reply.reqId)}, ${JSON.stringify(reply.result)})`,
              false
            ).catch(() => {});
          })
          .catch(() => {});
      }
    }
  });

  ws.addEventListener('close', () => {
    failAll('ws_closed');
    if (attachedTargets.get(page.id) === entry) {
      attachedTargets.delete(page.id);
      targetThemeModes.delete(page.id);
      if (attachedTargets.size === 0 && typeof runtimeState.wakeMacBootstrap === 'function') {
        runtimeState.wakeMacBootstrap();
      }
    }
  });
  ws.addEventListener('error', () => failAll('ws_error'));

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws_open_timeout')), 2000);
      ws.addEventListener('open', () => (clearTimeout(t), resolve()), { once: true });
      ws.addEventListener('close', () => (clearTimeout(t), reject(new Error('ws_closed'))), { once: true });
      ws.addEventListener('error', () => (clearTimeout(t), reject(new Error('ws_error'))), { once: true });
    });

    await send('Page.enable').catch(() => {});
    const frameTreeRes = await send('Page.getFrameTree').catch(() => null);
    const rootFrameId = frameTreeRes?.result?.frameTree?.frame?.id || null;
    if (rootFrameId) entry.mainFrameId = rootFrameId;

    await send('Runtime.enable');

    const candidateCtxId = (entry.mainFrameId && entry.defaultContextByFrame.get(entry.mainFrameId)) || null;
    const probeKind = await probeHostKind(candidateCtxId);

    if (probeKind === 'loading') {
      try {
        ws.close();
      } catch {}
      return;
    }

    if (probeKind !== 'host' && probeKind !== 'swarm') {
      skippedNonHostTargets.set(page.id, { origin: getOriginKey(page.url), expiresAt: Date.now() + NON_HOST_SKIP_TTL_MS });
      try {
        ws.close();
      } catch {}
      return;
    }

    entry.trustedContextId =
      (entry.mainFrameId && entry.defaultContextByFrame.get(entry.mainFrameId)) ?? candidateCtxId ?? null;
    entry.hostConfirmed = true;
    attachedTargets.set(page.id, entry);

    if (readOnly) return;

    entry.rpcToken = page.type === 'page' ? crypto.randomBytes(24).toString('hex') : '';
    entry.rpcSessionId = page.type === 'page' ? crypto.randomBytes(12).toString('hex') : '';

    await bindHostBindings();

    await entry.updateNewDocScript();
    await entry.injectNow();
    await entry.syncMetricsForSession(true);
  } catch {
    if (attachedTargets.get(page.id) === entry) {
      attachedTargets.delete(page.id);
      targetThemeModes.delete(page.id);
    }
    try {
      ws.close();
    } catch {}
  }
}
