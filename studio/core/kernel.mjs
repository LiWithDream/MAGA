/**
 * MagaKernel — Unified Single-Observer Scheduler & Two-Phase Frame Coordinator.
 *
 * Replaces ad-hoc observers and timers across Studio modules with:
 * 1. One root MutationObserver on document.body with O(1) data-maga-own filtering.
 * 2. Dirty-topic classification (`composer`, `stream`, `sidebar`, `overview`, `subagent`, `settings`, `route`, `metrics`, `prefs`, `all`).
 * 3. Single shared FrameSnapshot read-once per frame.
 * 4. Strict Two-Phase Read -> Write execution per frame + finally docObs.takeRecords().
 */
import { OWN_ATTR, OWN_HOST_IDS, isOwnNode } from './dom.mjs';
import { captureFrameSnapshot } from './snapshot.mjs';

const CLASS_WATCH_SEL =
  '[id="antigravity.agentSidePanelInputBox"], [data-testid="tool-group-collapsible"], [data-testid="worked-for-collapsible"], [data-testid="progress-updates-collapsible"], [data-testid="ephemeral-tool-status"]';

export function createMagaKernel({ ownFallbackSel = '', minStreamSyncGapMs = 120, fallbackPollMs = 15000 } = {}) {
  const features = [];
  const immediateMutationHandlers = [];
  const dirtyTopics = new Set();
  let disposed = false;
  let started = false;
  let rafId = 0;
  let throttleTimer = 0;
  let fallbackTimer = 0;
  let lastSyncTs = 0;
  let pendingUrgent = false;
  let bodyReadyCleanup = null;
  let docObs = null;

  const stats = {
    flushCount: 0,
    lastFlushMs: 0,
    maxFlushMs: 0,
    totalFlushMs: 0,
    lastTopics: [],
    observerCount: 0,
  };

  function isOwnMutation(m) {
    if (isOwnNode(m.target, ownFallbackSel)) return true;
    const added = m.addedNodes || [];
    const removed = m.removedNodes || [];
    if (!added.length && !removed.length) {
      // Attribute mutations on host elements (e.g., aria-expanded, aria-pressed, hidden) are relevant
      return m.type !== 'attributes';
    }
    for (let i = 0; i < added.length; i++) {
      if (!isOwnNode(added[i], ownFallbackSel)) return false;
    }
    for (let i = 0; i < removed.length; i++) {
      if (!isOwnNode(removed[i], ownFallbackSel)) return false;
    }
    return true;
  }

  function scanNodeForTopics(el, topics) {
    if (!el || el.nodeType !== 1) return;
    if (el.matches?.('.agy-composer-footer, [data-testid="agent-input-box"], [id="antigravity.agentSidePanelInputBox"], [data-testid="input-cancel-button"]') ||
        el.querySelector?.('.agy-composer-footer, [data-testid="input-cancel-button"]')) {
      topics.add('composer');
      topics.add('stream');
      topics.add('subagent');
    }
    if (el.matches?.('[data-testid="overview-panel"], [data-testid="toggle-overview-panel"]') ||
        el.querySelector?.('[data-testid="overview-panel"]')) {
      topics.add('overview');
      topics.add('settings');
      topics.add('subagent');
    }
    if (el.matches?.('[data-testid="aux-pane-split"], [data-testid="subagent-tab-composer"], [data-testid="toggle-aux-sidebar"]') ||
        el.querySelector?.('[data-testid="aux-pane-split"], [data-testid="subagent-tab-composer"]')) {
      topics.add('subagent');
      topics.add('composer');
    }
    if (el.matches?.('[data-testid="settings-sidebar"], #ag-claude-ux-settings-nav, #ag-claude-ux-settings-panel') ||
        el.querySelector?.('[data-testid="settings-sidebar"], #ag-claude-ux-settings-panel')) {
      topics.add('settings');
    }
  }

  function classifyMutation(m, topics) {
    if (m.type === 'attributes') {
      const t = m.target;
      if (m.attributeName === 'class') {
        if (!t?.closest?.(CLASS_WATCH_SEL)) return null;
        if (t.closest?.('[id="antigravity.agentSidePanelInputBox"]')) {
          topics.add('composer');
        }
        topics.add('stream');
        return false;
      }
      const tid = t?.getAttribute?.('data-testid') || '';
      if (tid === 'toggle-overview-panel' || tid === 'overview-panel') {
        topics.add('overview');
        topics.add('subagent');
        topics.add('settings');
        return true;
      }
      if (tid === 'toggle-aux-sidebar' || tid === 'aux-pane-split') {
        topics.add('subagent');
        topics.add('overview');
        topics.add('composer');
        return true;
      }
      if (t?.closest?.('.agy-composer-footer, [data-testid="agent-input-box"], [id="antigravity.agentSidePanelInputBox"]')) {
        topics.add('composer');
        return true;
      }
      if (t?.closest?.('[data-testid="settings-sidebar"]')) {
        topics.add('settings');
        return true;
      }
      topics.add('stream');
      return false;
    }

    const t = m.target && (m.target.nodeType === 1 ? m.target : m.target.parentElement);
    let urgent = false;

    if (t && t.closest) {
      if (t.closest('[data-testid="subagent-tab-composer"], [data-testid="subagent-tab-conversation"]')) {
        topics.add('subagent');
        topics.add('composer');
        urgent = true;
      } else if (t.closest('.agy-composer-footer, [data-testid="agent-input-box"], [id="antigravity.agentSidePanelInputBox"]')) {
        topics.add('composer');
        topics.add('stream');
        urgent = true;
      } else if (t.closest('[data-testid="overview-panel"], [data-testid="overview-panel-host"], [data-testid="toggle-overview-panel"]')) {
        topics.add('overview');
        topics.add('settings');
        topics.add('subagent');
        urgent = true;
      } else if (t.closest('[data-testid="aux-pane-split"], [data-testid="toggle-aux-sidebar"]')) {
        topics.add('subagent');
        topics.add('composer');
        urgent = true;
      } else if (t.closest('[data-testid="settings-sidebar"], [role="dialog"]')) {
        topics.add('settings');
        urgent = true;
      } else if (t.closest('[data-testid="autoscroll-viewport"], [data-testid="conversation-view"]')) {
        topics.add('stream');
      } else if (t.closest('aside, [data-testid="sidebar"], .bg-sidebar')) {
        topics.add('sidebar');
      } else {
        topics.add('all');
        urgent = true;
      }
    } else {
      topics.add('all');
      urgent = true;
    }

    const added = m.addedNodes || [];
    const removed = m.removedNodes || [];
    const cap = Math.min(added.length, 6);
    for (let i = 0; i < cap; i++) scanNodeForTopics(added[i], topics);
    const rCap = Math.min(removed.length, 6);
    for (let i = 0; i < rCap; i++) scanNodeForTopics(removed[i], topics);
    if (topics.has('composer') || topics.has('overview') || topics.has('subagent') || topics.has('settings')) {
      urgent = true;
    }
    return urgent;
  }

  function scheduleFlush(urgent = false) {
    if (disposed || !started) return;
    if (urgent) pendingUrgent = true;
    if (urgent) {
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = 0;
      }
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          flush();
        });
      }
      return;
    }
    if (rafId || throttleTimer) return;
    const wait = minStreamSyncGapMs - (Date.now() - lastSyncTs);
    if (wait > 0) {
      throttleTimer = setTimeout(() => {
        throttleTimer = 0;
        if (!disposed && !rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            flush();
          });
        }
      }, wait);
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      flush();
    });
  }

  function markDirty(topicOrList = 'all', urgent = false) {
    if (disposed) return;
    if (Array.isArray(topicOrList)) {
      for (const t of topicOrList) dirtyTopics.add(t);
    } else {
      dirtyTopics.add(topicOrList);
    }
    if (started) scheduleFlush(urgent);
  }

  function flush(forceAll = false) {
    if (disposed) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const topicsToRun = forceAll ? new Set(['all']) : new Set(dirtyTopics);
    dirtyTopics.clear();
    pendingUrgent = false;
    if (topicsToRun.size === 0) return;

    const t0 = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    lastSyncTs = Date.now();

    const activeFeatures = [];
    const runAll = topicsToRun.has('all');
    for (const f of features) {
      if (runAll || f.topicSet.has('all')) {
        activeFeatures.push(f);
        continue;
      }
      for (const t of topicsToRun) {
        if (f.topicSet.has(t)) {
          activeFeatures.push(f);
          break;
        }
      }
    }

    try {
      const snapshot = captureFrameSnapshot(topicsToRun);
      // Phase 1: Read-only measurements & plan preparation
      const plans = new Array(activeFeatures.length);
      for (let i = 0; i < activeFeatures.length; i++) {
        const f = activeFeatures[i];
        try {
          plans[i] = typeof f.read === 'function' ? f.read(snapshot) : undefined;
        } catch (err) {
          console.warn(`[agy-studio/${f.id}] read failed:`, err);
        }
      }
      // Phase 2: Idempotent DOM writes
      for (let i = 0; i < activeFeatures.length; i++) {
        const f = activeFeatures[i];
        try {
          if (typeof f.write === 'function') {
            f.write(snapshot, plans[i]);
          } else if (typeof f.sync === 'function') {
            f.sync(snapshot);
          }
        } catch (err) {
          console.warn(`[agy-studio/${f.id}] write failed:`, err);
        }
      }
    } finally {
      docObs?.takeRecords?.();
    }

    const dt = (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()) - t0;
    stats.flushCount += 1;
    stats.lastFlushMs = Math.round(dt * 100) / 100;
    if (stats.lastFlushMs > stats.maxFlushMs) stats.maxFlushMs = stats.lastFlushMs;
    stats.totalFlushMs += dt;
    stats.lastTopics = Array.from(topicsToRun);
  }

  function register(feature) {
    if (!feature || typeof feature !== 'object') return;
    const entry = {
      id: feature.id || `feature_${features.length}`,
      topicSet: new Set(Array.isArray(feature.topics) && feature.topics.length ? feature.topics : ['all']),
      mount: feature.mount,
      read: feature.read,
      write: feature.write,
      sync: feature.sync,
      dispose: feature.dispose,
    };
    features.push(entry);
    if (started && typeof entry.mount === 'function') {
      try {
        entry.mount({ markDirty, kernel: api });
      } catch (err) {
        console.warn(`[agy-studio/${entry.id}] mount failed:`, err);
      }
    }
  }

  const onVisibleSync = () => {
    if (typeof document !== 'undefined' && !document.hidden) {
      markDirty(['all'], true);
    }
  };
  const onNavSync = () => markDirty(['route', 'composer', 'subagent', 'overview', 'settings'], true);
  const onOverviewRendered = () => markDirty(['overview'], true);
  const onQuotaPopoverRendered = () => markDirty(['composer'], true);

  function bindBodyObserver() {
    if (disposed || !docObs || typeof document === 'undefined' || !document.body) return false;
    docObs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'aria-pressed', 'hidden', 'aria-hidden', 'class'],
    });
    stats.observerCount = 1;
    return true;
  }

  function registerImmediateMutationHandler(fn) {
    if (typeof fn !== 'function') return () => {};
    immediateMutationHandlers.push(fn);
    return () => {
      const idx = immediateMutationHandlers.indexOf(fn);
      if (idx !== -1) immediateMutationHandlers.splice(idx, 1);
    };
  }

  function start() {
    if (disposed || started) return api;
    started = true;

    for (const f of features) {
      if (typeof f.mount === 'function') {
        try {
          f.mount({ markDirty, kernel: api });
        } catch (err) {
          console.warn(`[agy-studio/${f.id}] mount failed:`, err);
        }
      }
    }

    if (typeof MutationObserver === 'function') {
      docObs = new MutationObserver((mutations) => {
        if (disposed) return;
        const mutTopics = new Set();
        const externalMuts = [];
        let urgent = pendingUrgent;
        let hasExternal = false;
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          if (isOwnMutation(m)) continue;
          const res = classifyMutation(m, mutTopics);
          if (res === null) continue;
          hasExternal = true;
          externalMuts.push(m);
          if (res) urgent = true;
        }
        if (!hasExternal) return;
        if (immediateMutationHandlers.length && externalMuts.length) {
          for (let i = 0; i < immediateMutationHandlers.length; i++) {
            try {
              immediateMutationHandlers[i](externalMuts);
            } catch {}
          }
          docObs?.takeRecords?.();
        }
        for (const t of mutTopics) dirtyTopics.add(t);
        scheduleFlush(urgent);
      });

      if (!bindBodyObserver() && typeof window !== 'undefined' && typeof document !== 'undefined') {
        const onReady = () => {
          if (bindBodyObserver()) {
            bodyReadyCleanup?.();
            bodyReadyCleanup = null;
            markDirty('all', true);
          }
        };
        window.addEventListener('DOMContentLoaded', onReady, { once: true });
        let elObs = null;
        if (document.documentElement) {
          elObs = new MutationObserver(() => onReady());
          elObs.observe(document.documentElement, { childList: true });
        }
        bodyReadyCleanup = () => {
          window.removeEventListener('DOMContentLoaded', onReady);
          elObs?.disconnect();
          elObs = null;
        };
      }
    }

    fallbackTimer = setInterval(() => {
      if (disposed || (typeof document !== 'undefined' && document.hidden)) return;
      if (Date.now() - lastSyncTs >= 10000) {
        markDirty(['composer', 'route'], false);
      }
    }, fallbackPollMs);
    if (fallbackTimer && typeof fallbackTimer.unref === 'function') fallbackTimer.unref();

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', onNavSync);
      window.addEventListener('popstate', onNavSync);
      window.addEventListener('agy:route-change', onNavSync);
      window.addEventListener('agy:overview-rendered', onOverviewRendered);
      window.addEventListener('agy:quota-popover-rendered', onQuotaPopoverRendered);
      window.__agyMagaKernel = api;
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibleSync);
    }

    flush(true);
    return api;
  }

  function getStats() {
    return {
      started,
      disposed,
      features: features.map((f) => f.id),
      featureCount: features.length,
      flushCount: stats.flushCount,
      lastFlushMs: stats.lastFlushMs,
      maxFlushMs: stats.maxFlushMs,
      avgFlushMs: stats.flushCount > 0 ? Math.round((stats.totalFlushMs / stats.flushCount) * 100) / 100 : 0,
      lastTopics: stats.lastTopics.slice(),
      observerCount: docObs ? stats.observerCount : 0,
      ownAttr: OWN_ATTR,
      ownHostIdCount: OWN_HOST_IDS.size,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = 0;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = 0;
    }
    bodyReadyCleanup?.();
    bodyReadyCleanup = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onNavSync);
      window.removeEventListener('popstate', onNavSync);
      window.removeEventListener('agy:route-change', onNavSync);
      window.removeEventListener('agy:overview-rendered', onOverviewRendered);
      window.removeEventListener('agy:quota-popover-rendered', onQuotaPopoverRendered);
      if (window.__agyMagaKernel === api) window.__agyMagaKernel = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibleSync);
    }
    docObs?.disconnect?.();
    stats.observerCount = 0;
    for (let i = features.length - 1; i >= 0; i--) {
      try {
        features[i].dispose?.();
      } catch {}
    }
    features.length = 0;
    immediateMutationHandlers.length = 0;
    dirtyTopics.clear();
  }

  const api = {
    register,
    registerImmediateMutationHandler,
    start,
    markDirty,
    flush,
    getStats,
    dispose,
  };
  return api;
}
