/**
 * 6. Main Sync Loop & `--verify-once` Live Inspector
 */
import {
  RUN_ONCE,
  USER_DIR,
  attachedTargets,
  fallbackBackoffUntil,
  readPort,
  runtimeState,
  skippedNonHostTargets,
  targetThemeModes
} from './env.mjs';
import { checkPidOwnership } from './pid.mjs';
import {
  getActiveConfig,
  getCachedVersion,
  rebuildBundleIfNeeded
} from './prefs-bundle.mjs';
import {
  attachTarget,
  fetchTargets,
  getOriginKey,
  isAllowedOrigin,
  isAntigravityFallbackPort
} from './cdp-attach.mjs';

let isSyncing = false;
let syncTickCount = 0;
const endpointConsecutiveFailures = new Map();

export async function sync(opts = {}) {
  const readOnly = Boolean(opts && opts.readOnly);
  checkPidOwnership();
  if (isSyncing) return;
  isSyncing = true;
  syncTickCount = (syncTickCount + 1) % 6000;
  try {
    const bundleChanged = rebuildBundleIfNeeded();
    const activeConfig = getActiveConfig();
    if (!readOnly && !activeConfig.enabled) targetThemeModes.clear();
    const shouldHeartbeatCheck = !readOnly && (bundleChanged || syncTickCount % 6 === 1);

    const activeTargetIds = new Set();
    const seenRawTargetIds = new Set();
    const authoritativeChannels = new Set();
    const pendingPages = [];
    const pendingIframes = [];
    const probedPorts = new Set();
    const nowMs = Date.now();

    for (const endpoint of activeConfig.endpoints) {
      const port = readPort(endpoint.portFile);
      let targets = [];
      let querySucceeded = false;
      let usedPort = 0;
      if (port && !probedPorts.has(port)) {
        probedPorts.add(port);
        const res = await fetchTargets(port);
        if (res.ok) {
          querySucceeded = true;
          targets = res.targets;
          if (targets.length > 0) usedPort = port;
        }
      }
      if (
        targets.length === 0 &&
        endpoint.fallbackPort &&
        !probedPorts.has(endpoint.fallbackPort) &&
        (RUN_ONCE || nowMs >= (fallbackBackoffUntil.get(endpoint.fallbackPort) || 0))
      ) {
        probedPorts.add(endpoint.fallbackPort);
        const isAgPort = await isAntigravityFallbackPort(endpoint.fallbackPort);
        if (isAgPort) {
          const res = await fetchTargets(endpoint.fallbackPort);
          if (res.ok) {
            querySucceeded = true;
            targets = res.targets;
          }
        }
        if (targets.length === 0) {
          fallbackBackoffUntil.set(endpoint.fallbackPort, nowMs + 10000);
        } else {
          fallbackBackoffUntil.delete(endpoint.fallbackPort);
          usedPort = endpoint.fallbackPort;
        }
      }
      if (querySucceeded) {
        endpointConsecutiveFailures.delete(endpoint.channel);
        authoritativeChannels.add(endpoint.channel);
      } else {
        endpointConsecutiveFailures.set(endpoint.channel, (endpointConsecutiveFailures.get(endpoint.channel) || 0) + 1);
      }
      if (targets.length === 0) continue;
      runtimeState.lastReachablePort = usedPort;

      for (const t of targets) {
        if (!t?.id) continue;
        seenRawTargetIds.add(t.id);
        const skipped = skippedNonHostTargets.get(t.id);
        if (
          skipped &&
          (!isAllowedOrigin(t.url) ||
            getOriginKey(t.url) !== skipped.origin ||
            (typeof skipped.expiresAt === 'number' && nowMs >= skipped.expiresAt))
        ) {
          skippedNonHostTargets.delete(t.id);
        }
      }

      const candidates = targets.filter(
        (t) =>
          (t.type === 'page' || (t.type === 'iframe' && String(t.url || '').startsWith('plugin://swarm--'))) &&
          t.webSocketDebuggerUrl &&
          !String(t.url || '').startsWith('devtools://') &&
          isAllowedOrigin(t.url) &&
          !String(t.title || '').includes('Launchpad') &&
          skippedNonHostTargets.get(t.id)?.origin !== getOriginKey(t.url)
      );

      for (const page of candidates) {
        activeTargetIds.add(page.id);
        if (page.type === 'iframe') pendingIframes.push({ page, endpoint });
        else pendingPages.push({ page, endpoint });
      }
    }

    const syncBatch = async (items) => {
      const attaches = [];
      for (const { page, endpoint } of items) {
        if (!attachedTargets.has(page.id)) {
          attaches.push(attachTarget(page, endpoint, { readOnly }));
        } else if (!readOnly) {
          const entry = attachedTargets.get(page.id);
          entry.endpoint = endpoint;
          entry.parentId = page.parentId || entry.parentId || null;
          entry.updateTargetUrl(page.url);
          if (entry.hostConfirmed) {
            if (bundleChanged) await entry.updateNewDocScript();
            if (shouldHeartbeatCheck) await entry.checkAndInject(bundleChanged);
            await entry.syncMetricsForSession(bundleChanged);
          }
        }
      }
      if (attaches.length > 0) await Promise.allSettled(attaches);
    };

    await syncBatch(pendingPages);
    await syncBatch(pendingIframes);

    for (const [id, entry] of attachedTargets.entries()) {
      if (activeTargetIds.has(id)) continue;
      const ch = entry.endpoint?.channel;
      const wsDead = entry.ws?.readyState !== WebSocket.OPEN;
      const fails = ch ? endpointConsecutiveFailures.get(ch) || 0 : 0;
      if (!wsDead && ch && !authoritativeChannels.has(ch) && fails < 3) {
        continue;
      }
      try {
        entry.ws.close();
      } catch {}
      if (attachedTargets.get(id) === entry) {
        attachedTargets.delete(id);
        targetThemeModes.delete(id);
      }
    }
    if (seenRawTargetIds.size > 0) {
      for (const id of skippedNonHostTargets.keys()) {
        if (!seenRawTargetIds.has(id)) skippedNonHostTargets.delete(id);
      }
    }
  } finally {
    isSyncing = false;
  }
}

export async function runVerifyOnce() {
  await sync({ readOnly: true });
  const activeConfig = getActiveConfig();
  const inspectLiveStyles = async () => {
    let themeStyle = { present: false, length: 0 };
    let customStyle = { present: false, length: 0 };
    let hostPages = 0;

    for (const [, entry] of attachedTargets.entries()) {
      if (!entry.hostConfirmed || entry.type !== 'page') continue;
      hostPages += 1;
      const r = await entry
        .send('Runtime.evaluate', {
          expression: `(function () {
            const s1 = document.getElementById('ag-custom-fonts');
            const s2 = document.getElementById('antigravity-user-custom-style');
            return {
              themeStyle: { present: Boolean(s1), length: s1 ? (s1.textContent || '').length : 0 },
              customStyle: { present: Boolean(s2), length: s2 ? (s2.textContent || '').length : 0 }
            };
          })()`,
          returnByValue: true
        })
        .catch(() => null);
      const val = r?.result?.result?.value;
      if (val?.themeStyle?.present) themeStyle = val.themeStyle;
      if (val?.customStyle?.present) customStyle = val.customStyle;
    }
    return { themeStyle, customStyle, hostPages };
  };

  let { themeStyle, customStyle, hostPages } = await inspectLiveStyles();
  const stylesReady = () => themeStyle.present && (!activeConfig.modules.customCss || customStyle.present);
  if (hostPages > 0 && activeConfig.enabled && !stylesReady()) {
    for (let i = 0; i < 4 && !stylesReady(); i++) {
      await new Promise((r) => setTimeout(r, 350));
      ({ themeStyle, customStyle, hostPages } = await inspectLiveStyles());
    }
    if (!stylesReady()) {
      for (const [, entry] of attachedTargets.entries()) {
        if (entry.hostConfirmed && entry.type === 'page') {
          await entry.injectNow(false);
        }
      }
      ({ themeStyle, customStyle, hostPages } = await inspectLiveStyles());
    }
  }

  for (const [, entry] of attachedTargets.entries()) {
    try {
      entry.ws.close();
    } catch {}
  }

  const reachable = hostPages > 0;
  const ok =
    reachable &&
    (!activeConfig.enabled ||
      (themeStyle.present && (!activeConfig.modules.customCss || customStyle.present)));

  console.log(
    JSON.stringify(
      {
        ok,
        version: getCachedVersion(),
        userDir: USER_DIR,
        themeStyle,
        customStyle,
        live: {
          reachable,
          port: runtimeState.lastReachablePort || null,
          targets: hostPages
        }
      },
      null,
      2
    )
  );
  process.exit(ok ? 0 : 1);
}
