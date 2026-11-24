/**
 * Subagent Footer, Side-Panel Linkage & Split-Pane Orchestration Module:
 * 1. Main Composer Subagent Entry Capsule (#agy-main-subagent-pill):
 *    - Semantic state tinting: Running (blue + breathing dot), Done/Standby (emerald green),
 *      Ended (neutral), plus active border ring when linked side panel is currently showing it.
 *    - True bidirectional linkage with Antigravity's auxiliary side panel ([data-testid="toggle-aux-sidebar"]):
 *      clicking opens the side panel AND switches to the subagent tab; clicking the already-open
 *      active subagent closes the side panel.
 * 2. Mutual Exclusion & 50/50 Default Split:
 *    - Overview panel ([data-testid="toggle-overview-panel"]) and Auxiliary side panel
 *      ([data-testid="toggle-aux-sidebar"]) are mutually exclusive: opening one closes the other.
 *    - Whenever the Auxiliary side panel opens from closed, defaults its split ratio to 50/50
 *      equal width via [data-testid="aux-pane-split"]'s native onResize/onDragEnd handlers
 *      (leaving manual sash dragging completely free afterwards).
 * 3. Side-Panel Subagent Composer ([data-testid="subagent-tab-composer"]):
 *    - Fetches live metrics via daemon RPC `getSubagentMetrics` and renders matching
 *      Model+Effort, Context (0/60/75%), and Speed+Live-Dot capsules with the same
 *      4-tier progressive compression (full / compact / tight / icon).
 */

export function createSubagentFooterRuntime({ motionThemes, shortenModelName, shortenEffortBadge }) {
  const MAIN_PILL_ID = 'agy-main-subagent-pill';
  const MENU_ID = 'agy-subagent-menu';
  const SUB_GROUP_ATTR = 'data-agy-sub-pill';
  const SEEN_STORAGE_KEY = 'agy_studio_subagent_seen_v1';
  const MAX_SEEN_ENTRIES = 200;
  const RING_CIRC = 2 * Math.PI * 7;

  let disposed = false;
  let menuEl = null;
  let menuOpen = false;
  let subCache = { cid: '', ts: 0, data: null, inFlight: false };

  let prevAuxOpen = null;
  let prevOvOpen = null;
  let prevMainRunning = null;
  let mutualGuardUntil = 0;
  let restoreOverviewForCid = '';
  const autoOpenedOverviewCids = new Set();

  const activeTimers = new Set();
  const handoffTimers = new Set();
  const activeRafs = new Set();
  let replayingPanelClick = false;
  let bootedPreArm = false;
  let preArmCloseTimer = 0;
  let subSwitchTimer = 0;

  function prefersReducedMotion() {
    try {
      return Boolean(
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)')?.matches
      );
    } catch {
      return false;
    }
  }

  function trackTimeout(fn, ms, pool = activeTimers) {
    const id = setTimeout(() => {
      pool.delete(id);
      if (!disposed) fn();
    }, ms);
    pool.add(id);
    return id;
  }

  function trackRaf(fn) {
    const id = requestAnimationFrame(() => {
      activeRafs.delete(id);
      if (!disposed) fn();
    });
    activeRafs.add(id);
    return id;
  }

  function clearHandoffTimers() {
    for (const id of handoffTimers) clearTimeout(id);
    handoffTimers.clear();
  }

  function clearHandoffState() {
    clearHandoffTimers();
    const root = document.documentElement;
    if (!root) return;
    root.removeAttribute?.('data-agy-panel-handoff');
    try {
      if (typeof root.style?.removeProperty === 'function') {
        root.style.removeProperty('--agy-hold-ov-reserve');
        root.style.removeProperty('--agy-hold-ov-gutter');
      } else {
        root.style?.setProperty?.('--agy-hold-ov-reserve', '');
        root.style?.setProperty?.('--agy-hold-ov-gutter', '');
      }
    } catch {}
  }

  function safeNativeClick(el) {
    if (!el || typeof el.click !== 'function') return;
    replayingPanelClick = true;
    try {
      el.click();
    } finally {
      replayingPanelClick = false;
    }
  }

  /* ---- Persistent Watermark Store (id -> "calls:outTok") ---- */
  const seenMap = new Map();
  try {
    const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(SEEN_STORAGE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const pair of parsed) {
          if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
            seenMap.set(pair[0], pair[1]);
          }
        }
      }
    }
  } catch {}

  function persistSeenMap() {
    try {
      if (typeof localStorage !== 'object' || !localStorage) return;
      const entries = Array.from(seenMap.entries());
      const trimmed = entries.length > MAX_SEEN_ENTRIES ? entries.slice(-MAX_SEEN_ENTRIES) : entries;
      localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {}
  }

  function getChildSig(ch) {
    return `${Number(ch?.calls || 0)}:${Number(ch?.outTok || 0)}`;
  }

  function isChildSeen(ch) {
    if (!ch || !ch.id) return true;
    return seenMap.get(ch.id) === getChildSig(ch);
  }

  function markChildSeen(ch) {
    if (!ch || !ch.id || ch.running) return false;
    const sig = getChildSig(ch);
    if (seenMap.get(ch.id) === sig) return false;
    seenMap.delete(ch.id); // refresh recency order
    seenMap.set(ch.id, sig);
    persistSeenMap();
    return true;
  }

  function isMainComposerRunning() {
    const cancelBtns = document.querySelectorAll('.agy-composer-footer button[data-testid="input-cancel-button"]');
    for (const btn of cancelBtns) {
      if (btn.closest('[data-side-panel-composer], [data-testid="subagent-tab-composer"]')) continue;
      if (typeof btn.checkVisibility === 'function') {
        if (btn.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return true;
      } else if (btn.offsetParent !== null) {
        return true;
      }
    }
    return false;
  }

  function markIdleSubagentsSeenOnTurnAdvance() {
    const auxOpen = isAuxPanelOpen();
    const activeTabId = auxOpen ? getActiveSubagentTabId() : '';
    let changed = false;
    for (const ch of getSortedChildren()) {
      if (ch.running) continue;
      if (auxOpen && activeTabId && ch.id === activeTabId) continue;
      if (markChildSeen(ch)) changed = true;
    }
    return changed;
  }

  function isZh() {
    return document.documentElement.getAttribute('data-ag-ux-lang') === 'zh-CN';
  }

  function L(zh, en) {
    return isZh() ? zh : en;
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTok(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v) || v <= 0) return '0';
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 10e6 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return String(Math.round(v));
  }

  /* ---- Auxiliary Side Panel & Overview Mutual Exclusion + 50/50 Split ---- */

  function getAuxToggleBtn() {
    return document.querySelector('button[data-testid="toggle-aux-sidebar"]');
  }

  function getOverviewToggleBtn() {
    return document.querySelector('button[data-testid="toggle-overview-panel"]');
  }

  function isAuxPanelOpen() {
    const btn = getAuxToggleBtn();
    if (btn) return btn.getAttribute('aria-expanded') === 'true';
    const split = document.querySelector('[data-testid="aux-pane-split"]');
    const auxPane = split?.children?.[2];
    return Boolean(auxPane && auxPane.getBoundingClientRect().width > 40);
  }

  function isOverviewOpen() {
    const btn = getOverviewToggleBtn();
    return Boolean(btn && btn.getAttribute('aria-pressed') === 'true');
  }

  function currentRouteKey() {
    return getActiveRouteCid() || '__current__';
  }

  function getOverviewContextInfo() {
    const host = document.querySelector('[data-testid="overview-panel-host"]');
    if (!host) return null;
    const fk = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fk ? host[fk] : null;
    for (let i = 0; i < 14 && fiber; i++, fiber = fiber.return) {
      const v = fiber.memoizedProps?.value;
      if (v && typeof v === 'object' && 'breakpoint' in v && 'presentation' in v) {
        return {
          breakpoint: v.breakpoint,
          presentation: v.presentation,
          cascadeId: v.cascadeId,
          hydrated: v.hydrated !== false,
          isOpen: Boolean(v.isOpen),
          isPanelVisible: Boolean(v.isPanelVisible),
        };
      }
    }
    return null;
  }

  function getAuxSplitFiberInfo() {
    const split = document.querySelector('[data-testid="aux-pane-split"]');
    if (!split) return null;
    const fk = Object.keys(split).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fk ? split[fk] : null;
    let onResize = null;
    let unit = '%';
    let hasExplicitUnit = false;
    let explicitSidePanelWidth = null;
    let fallbackSizingWidth = null;

    for (let i = 0; i < 16 && fiber; i++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      if (!onResize && typeof props.onResize === 'function') {
        onResize = props.onResize;
      }
      if (!hasExplicitUnit && typeof props.auxPaneWidthUnit === 'string' && props.auxPaneWidthUnit) {
        unit = props.auxPaneWidthUnit;
        hasExplicitUnit = true;
      } else if (!hasExplicitUnit && typeof props.baseSizing?.unit === 'string' && props.baseSizing.unit) {
        unit = props.baseSizing.unit;
      }
      if (
        explicitSidePanelWidth === null &&
        typeof props.sidePanelWidth === 'number' &&
        Number.isFinite(props.sidePanelWidth)
      ) {
        explicitSidePanelWidth = props.sidePanelWidth;
      }
      if (
        fallbackSizingWidth === null &&
        typeof props.baseSizing?.size === 'number' &&
        Number.isFinite(props.baseSizing.size) &&
        props.baseSizing.size > 0
      ) {
        fallbackSizingWidth = props.baseSizing.size;
      }
    }

    const currentWidth = explicitSidePanelWidth !== null ? explicitSidePanelWidth : fallbackSizingWidth;
    const targetWidth = unit === '%'
      ? 50
      : (Math.round((split.getBoundingClientRect?.().width || 0) / 2) || 480);
    const needsResize = typeof onResize === 'function' && (currentWidth === null || Math.abs(currentWidth - targetWidth) >= 0.5);
    return { split, onResize, unit, currentWidth, targetWidth, needsResize };
  }

  function preArmAuxEqualWidth() {
    const info = getAuxSplitFiberInfo();
    if (!info || !info.needsResize || isAuxPanelOpen() || info.split.hasAttribute('data-split-transition')) {
      return false;
    }
    try {
      info.onResize(info.targetWidth);
      return true;
    } catch {
      return false;
    }
  }

  function schedulePreArmAfterClose() {
    if (preArmCloseTimer) {
      clearTimeout(preArmCloseTimer);
      activeTimers.delete(preArmCloseTimer);
      preArmCloseTimer = 0;
    }
    preArmCloseTimer = trackTimeout(() => {
      preArmCloseTimer = 0;
      const split = document.querySelector('[data-testid="aux-pane-split"]');
      if (!isAuxPanelOpen() && !split?.hasAttribute('data-split-transition')) {
        preArmAuxEqualWidth();
      }
    }, 560);
  }

  function runOverviewToAuxHandoff(openAction) {
    clearHandoffTimers();
    const root = document.documentElement;
    const host = document.querySelector('[data-testid="overview-panel-host"]');
    let reserve = '0px';
    let gutter = '0px';
    if (host) {
      let hostCs = null;
      try {
        hostCs = typeof getComputedStyle === 'function' ? getComputedStyle(host) : null;
      } catch {}
      reserve = (host.style?.getPropertyValue?.('--overview-panel-reserve')
        || hostCs?.getPropertyValue?.('--overview-panel-reserve')
        || '').trim() || '0px';
      gutter = (host.style?.getPropertyValue?.('--overview-panel-gutter-reserve')
        || hostCs?.getPropertyValue?.('--overview-panel-gutter-reserve')
        || '').trim() || '0px';
    }

    if (root) {
      try {
        root.style?.setProperty?.('--agy-hold-ov-reserve', reserve);
        root.style?.setProperty?.('--agy-hold-ov-gutter', gutter);
      } catch {}
      root.setAttribute?.('data-agy-panel-handoff', 'ov-to-aux-closing');
    }

    mutualGuardUntil = Date.now() + 750;
    const ovBtn = getOverviewToggleBtn();
    if (ovBtn && isOverviewOpen()) {
      restoreOverviewForCid = currentRouteKey();
      safeNativeClick(ovBtn);
      prevOvOpen = false;
    }

    // Pre-arm 50/50 split while aux is still closed so React transition flag settles before phase 2 opens
    preArmAuxEqualWidth();

    const reduced = prefersReducedMotion();
    const phase2Delay = reduced ? 0 : 120;
    const cleanupDelay = reduced ? 60 : 640;

    trackTimeout(() => {
      if (root) {
        root.setAttribute?.('data-agy-panel-handoff', 'ov-to-aux-opening');
      }
      if (typeof openAction === 'function') openAction();
    }, phase2Delay, handoffTimers);

    trackTimeout(() => {
      clearHandoffState();
    }, cleanupDelay, handoffTimers);
  }

  function scheduleOverviewRestoreIfNeeded() {
    const routeKey = currentRouteKey();
    if (!restoreOverviewForCid) return false;
    if (restoreOverviewForCid !== routeKey) {
      restoreOverviewForCid = '';
      return false;
    }
    if (isOverviewOpen()) {
      restoreOverviewForCid = '';
      return false;
    }

    mutualGuardUntil = Date.now() + 750;
    clearHandoffTimers();
    const replayDelay = prefersReducedMotion() ? 0 : 240;

    trackTimeout(() => {
      if (!isAuxPanelOpen() && currentRouteKey() === routeKey) {
        if (!isOverviewOpen()) {
          const ovBtn = getOverviewToggleBtn();
          if (ovBtn && !ovBtn.disabled) {
            safeNativeClick(ovBtn);
            prevOvOpen = isOverviewOpen();
          }
        }
        if (isOverviewOpen()) {
          restoreOverviewForCid = '';
        }
      }
    }, replayDelay, handoffTimers);

    trackTimeout(() => {
      if (!isAuxPanelOpen() && currentRouteKey() === routeKey && !isOverviewOpen()) {
        const ovBtn = getOverviewToggleBtn();
        if (ovBtn && !ovBtn.disabled) {
          safeNativeClick(ovBtn);
          prevOvOpen = isOverviewOpen();
        }
      }
      restoreOverviewForCid = '';
    }, 540, handoffTimers);

    return true;
  }

  function ensureDefaultOverviewOpen({ ignoreGuard = false } = {}) {
    const cid = getActiveRouteCid();
    if (!cid || autoOpenedOverviewCids.has(cid)) return;
    if (isAuxPanelOpen()) return;
    if (!ignoreGuard && Date.now() < mutualGuardUntil) return;
    if (handoffTimers.size > 0) return;
    if (document.documentElement?.hasAttribute?.('data-agy-panel-handoff')) return;
    if (document.querySelector('[data-testid="aux-pane-split"][data-split-transition]')) return;

    const ovBtn = getOverviewToggleBtn();
    if (!ovBtn || ovBtn.disabled) return;

    const ctx = getOverviewContextInfo();
    if (ctx) {
      if (ctx.cascadeId && ctx.cascadeId !== cid) return;
      if (!ctx.hydrated) return;
      if (ctx.presentation === 'dropdown' || ctx.breakpoint === 'small') return;
    }

    if (isOverviewOpen()) {
      autoOpenedOverviewCids.add(cid);
      return;
    }

    autoOpenedOverviewCids.add(cid);
    safeNativeClick(ovBtn);
    prevOvOpen = isOverviewOpen();
  }

  function enforcePanelMutualExclusion() {
    const auxOpen = isAuxPanelOpen();
    const ovOpen = isOverviewOpen();
    const now = Date.now();

    if (prevAuxOpen === null || prevOvOpen === null) {
      prevAuxOpen = auxOpen;
      prevOvOpen = ovOpen;
      if (!auxOpen && !bootedPreArm) {
        bootedPreArm = true;
        preArmAuxEqualWidth();
      }
      return;
    }

    const auxJustOpened = !prevAuxOpen && auxOpen;
    const auxJustClosed = prevAuxOpen && !auxOpen;
    const ovJustOpened = !prevOvOpen && ovOpen;
    const ovJustClosed = prevOvOpen && !ovOpen;
    prevAuxOpen = auxOpen;
    prevOvOpen = ovOpen;

    if (ovJustClosed && now >= mutualGuardUntil && !restoreOverviewForCid) {
      const cid = getActiveRouteCid();
      if (cid) autoOpenedOverviewCids.add(cid);
    }

    if (auxJustClosed) {
      schedulePreArmAfterClose();
      const restored = scheduleOverviewRestoreIfNeeded();
      if (!restored) {
        const cid = getActiveRouteCid();
        if (cid && !autoOpenedOverviewCids.has(cid)) {
          const reduced = prefersReducedMotion();
          mutualGuardUntil = Math.max(mutualGuardUntil, now + (reduced ? 0 : 280));
          trackTimeout(() => {
            ensureDefaultOverviewOpen({ ignoreGuard: true });
          }, reduced ? 0 : 280);
        }
      }
    }

    if (now < mutualGuardUntil) {
      return;
    }

    if (auxJustOpened) {
      if (ovOpen) {
        mutualGuardUntil = now + 500;
        const ovBtn = getOverviewToggleBtn();
        if (ovBtn) {
          restoreOverviewForCid = currentRouteKey();
          safeNativeClick(ovBtn);
          prevOvOpen = false;
        }
      }
    } else if (ovJustOpened) {
      if (auxOpen) {
        mutualGuardUntil = now + 500;
        const auxBtn = getAuxToggleBtn();
        if (auxBtn) {
          safeNativeClick(auxBtn);
          prevAuxOpen = false;
        }
      }
    }
  }

  function getActiveSubagentTabId() {
    try {
      const tab = new URLSearchParams(location.search).get('tab') || '';
      const m = tab.match(/^subagent_convo__(.+)$/);
      return m ? m[1] : '';
    } catch {
      return '';
    }
  }

  function findNativeSubagentNode(subagentId, label) {
    const nodes = document.querySelectorAll('button[data-testid="subagent-node"]');
    for (const node of nodes) {
      const fk = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
      let fiber = fk ? node[fk] : null;
      for (let i = 0; i < 6 && fiber; i++) {
        const p = fiber.memoizedProps || {};
        if (p.conversationId === subagentId || p.cascadeId === subagentId || p.id === subagentId) {
          return node;
        }
        fiber = fiber.return;
      }
    }
    if (label) {
      const lower = label.toLowerCase();
      for (const node of nodes) {
        const txt = (node.textContent || '').trim().toLowerCase();
        if (txt === lower || txt.includes(`(${lower})`)) return node;
      }
    }
    return null;
  }

  function pushSubagentTab(subagentId) {
    try {
      const url = new URL(location.href);
      url.searchParams.set('tab', `subagent_convo__${subagentId}`);
      history.pushState(history.state, '', url.pathname + url.search + url.hash);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    } catch {}
  }

  function pulseSubagentSwitch() {
    const conv = document.querySelector('[data-testid="subagent-tab-conversation"]');
    if (!conv) return;
    conv.removeAttribute('data-agy-sub-switching');
    try { void conv.offsetWidth; } catch {}
    conv.setAttribute('data-agy-sub-switching', '1');
    if (subSwitchTimer) {
      clearTimeout(subSwitchTimer);
      activeTimers.delete(subSwitchTimer);
      subSwitchTimer = 0;
    }
    subSwitchTimer = trackTimeout(() => {
      subSwitchTimer = 0;
      conv.removeAttribute?.('data-agy-sub-switching');
    }, 200);
  }

  function performOpenSubagent(subagentId, label = '') {
    const nativeNode = findNativeSubagentNode(subagentId, label);
    if (nativeNode) {
      safeNativeClick(nativeNode);
    } else {
      pushSubagentTab(subagentId);
      if (!isAuxPanelOpen()) {
        const auxBtn = getAuxToggleBtn();
        if (auxBtn) safeNativeClick(auxBtn);
      }
    }

    trackRaf(() => {
      if (!isAuxPanelOpen()) {
        const auxBtn = getAuxToggleBtn();
        if (auxBtn) safeNativeClick(auxBtn);
      }
      if (getActiveSubagentTabId() !== subagentId) {
        pushSubagentTab(subagentId);
      }
      prevAuxOpen = isAuxPanelOpen();
      syncMainSubagentEntry();
    });
  }

  function openOrToggleSubagentSidePanel(subagentId, { label = '', allowToggleClose = true } = {}) {
    if (!subagentId) return;
    const auxOpen = isAuxPanelOpen();
    const activeTabId = getActiveSubagentTabId();

    // Case 1: Side panel is already open on this exact subagent -> toggle it closed
    if (allowToggleClose && auxOpen && activeTabId === subagentId) {
      clearHandoffState();
      const auxBtn = getAuxToggleBtn();
      if (auxBtn) {
        safeNativeClick(auxBtn);
        trackRaf(() => {
          enforcePanelMutualExclusion();
          syncMainSubagentEntry();
        });
      }
      return;
    }

    // Case 2: Side panel already open on another subagent -> switch smoothly without re-animating split
    if (auxOpen) {
      const nativeNode = findNativeSubagentNode(subagentId, label);
      if (nativeNode) {
        safeNativeClick(nativeNode);
      } else {
        pushSubagentTab(subagentId);
      }
      pulseSubagentSwitch();
      trackRaf(() => {
        if (getActiveSubagentTabId() !== subagentId) {
          pushSubagentTab(subagentId);
        }
        syncMainSubagentEntry();
      });
      return;
    }

    // Case 3: Overview is open -> choreographed handoff prevents 3-pane collision & sliding card jump
    if (isOverviewOpen()) {
      runOverviewToAuxHandoff(() => performOpenSubagent(subagentId, label));
      return;
    }

    // Case 4: Both closed -> pre-arm 50/50 split only if needed, then open smoothly
    clearHandoffState();
    if (preArmAuxEqualWidth()) {
      trackRaf(() => {
        trackRaf(() => {
          performOpenSubagent(subagentId, label);
        });
      });
    } else {
      performOpenSubagent(subagentId, label);
    }
  }

  function getSubagentLabel(ch) {
    return String(ch?.agentName || ch?.title || ch?.id?.slice(0, 8) || 'subagent').trim();
  }

  function getActiveRouteCid() {
    const m = String(location.pathname || '').match(/\/c\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function getSortedChildren() {
    const m = window.__ag_last_metrics;
    const cid = getActiveRouteCid();
    if (!cid || !m || (m.cascadeId && m.cascadeId !== cid)) return [];
    const raw = Array.isArray(m?.stats?.children) ? m.stats.children : [];
    const seen = new Set();
    const list = [];
    for (let i = raw.length - 1; i >= 0; i--) {
      const ch = raw[i];
      if (!ch || !ch.id || seen.has(ch.id)) continue;
      seen.add(ch.id);
      list.push(ch);
    }
    return list.sort((a, b) => {
      const score = (x) => (x.running ? 3 : !x.killed ? 2 : 1);
      return score(b) - score(a);
    });
  }

  function getVisibleMainChildren() {
    const all = getSortedChildren();
    const auxOpen = isAuxPanelOpen();
    const activeTabId = auxOpen ? getActiveSubagentTabId() : '';

    // Record watermark for whichever completed subagent the user is actively viewing in the side panel,
    // while keeping it visible & highlighted until the side panel closes or switches away.
    if (auxOpen && activeTabId) {
      const viewed = all.find((ch) => ch.id === activeTabId);
      if (viewed && !viewed.running) markChildSeen(viewed);
    }

    return all.filter((ch) => {
      const isOpenInSide = Boolean(auxOpen && activeTabId && ch.id === activeTabId);
      if (isOpenInSide) return true; // Rule 3: currently open in side panel -> always show
      if (ch.killed) return false;   // Rule 1: destroyed -> hidden unless explicitly opened from history
      if (ch.running) return true;   // Rule 2: actively working -> always show
      return !isChildSeen(ch);       // Rule 4: completed/standby -> show while unread
    });
  }

  function syncTurnAdvanceRetirement() {
    const running = isMainComposerRunning();
    if (prevMainRunning === null) {
      prevMainRunning = running;
      return;
    }
    const justStartedTurn = !prevMainRunning && running;
    prevMainRunning = running;
    if (justStartedTurn) {
      markIdleSubagentsSeenOnTurnAdvance();
    }
  }

  /* ---- Part A: Main Composer Subagent Entry Pill + Selector Menu ---- */

  function closeMenu() {
    menuOpen = false;
    if (menuEl) menuEl.removeAttribute('data-open');
  }

  function ensureMenuEl() {
    if (menuEl && menuEl.isConnected) return menuEl;
    menuEl = document.getElementById(MENU_ID);
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.id = MENU_ID;
      menuEl.setAttribute('data-ag-i18n-ignore', '1');
      menuEl.addEventListener('click', (e) => {
        const row = e.target?.closest?.('button[data-agy-open-sub]');
        if (!row) return;
        e.stopPropagation();
        const cid = row.getAttribute('data-agy-open-sub');
        const lbl = row.getAttribute('data-agy-sub-label') || '';
        closeMenu();
        if (cid) openOrToggleSubagentSidePanel(cid, { label: lbl, allowToggleClose: true });
      });
      document.body.appendChild(menuEl);
    }
    return menuEl;
  }

  function openMenuFor(pill, allChildren, activeChildren = null) {
    const el = ensureMenuEl();
    const auxOpen = isAuxPanelOpen();
    const activeTabId = auxOpen ? getActiveSubagentTabId() : '';
    const activeList = Array.isArray(activeChildren) ? activeChildren : getVisibleMainChildren();
    const activeIds = new Set(activeList.map((c) => c.id));
    const activeItems = allChildren.filter((c) => activeIds.has(c.id));
    const historyItems = allChildren.filter((c) => !activeIds.has(c.id));

    const renderRow = (ch) => {
      const name = getSubagentLabel(ch);
      const isCurrent = auxOpen && ch.id === activeTabId;
      const stateCls = ch.running ? 'is-run' : ch.killed ? 'is-killed' : 'is-ready';
      const stateTxt = ch.running
        ? L('工作中', 'Working')
        : ch.killed
          ? L('已完成', 'Done')
          : L('待命', 'Standby');
      return `<button type="button" class="agy-sub-menu-row${isCurrent ? ' is-active' : ''}" data-agy-open-sub="${esc(ch.id)}" data-agy-sub-label="${esc(name)}">
        <span class="agy-sub-menu-left">
          <span class="agy-sub-menu-dot ${stateCls}"></span>
          <span class="agy-sub-menu-name">${esc(name)}</span>
        </span>
        <span class="agy-sub-menu-meta">${esc(stateTxt)}${isCurrent ? ' ✓' : ''}</span>
      </button>`;
    };

    let rowsHtml = activeItems.map(renderRow).join('');
    if (historyItems.length > 0) {
      rowsHtml += `<div class="agy-sub-menu-sep">${esc(L('历史会话', 'History'))}</div>`;
      rowsHtml += historyItems.map(renderRow).join('');
    }

    el.innerHTML = `<div class="agy-sub-menu-hdr">${esc(L('子代理会话', 'Subagents'))} · ${allChildren.length}</div><div class="agy-sub-menu-list">${rowsHtml}</div>`;
    el.setAttribute('data-open', '1');
    menuOpen = true;

    const r = pill.getBoundingClientRect();
    const mw = el.offsetWidth || 216;
    const left = Math.round(Math.max(10, Math.min(r.left, window.innerWidth - mw - 12)));
    const bottom = Math.round(Math.max(10, window.innerHeight - r.top + 8));
    el.style.left = `${left}px`;
    el.style.bottom = `${bottom}px`;
  }

  const onDocClick = (e) => {
    if (replayingPanelClick) return;

    // Immediate mutual exclusion & choreographed handoff when user clicks native top-bar toggles
    const auxBtn = e.target?.closest?.('button[data-testid="toggle-aux-sidebar"]');
    const ovBtn = e.target?.closest?.('button[data-testid="toggle-overview-panel"]');
    const subNode = e.target?.closest?.('button[data-testid="subagent-node"]');

    if (ovBtn && isAuxPanelOpen() && !isOverviewOpen()) {
      // Aux open -> Overview requested: collapse Aux cleanly first so Overview never mounts inside narrow split
      e.preventDefault?.();
      e.stopPropagation?.();
      if (menuOpen) closeMenu();
      restoreOverviewForCid = '';
      clearHandoffState();
      mutualGuardUntil = Date.now() + 750;
      const a = getAuxToggleBtn();
      if (a) {
        safeNativeClick(a);
        prevAuxOpen = false;
      }
      const replayDelay = prefersReducedMotion() ? 0 : 240;
      trackTimeout(() => {
        if (!isOverviewOpen()) {
          safeNativeClick(getOverviewToggleBtn());
        }
      }, replayDelay, handoffTimers);
      trackTimeout(() => {
        if (!isAuxPanelOpen() && !isOverviewOpen()) {
          safeNativeClick(getOverviewToggleBtn());
        }
      }, 540, handoffTimers);
      return;
    }

    if (ovBtn && isOverviewOpen()) {
      const cid = getActiveRouteCid();
      if (cid) autoOpenedOverviewCids.add(cid);
      restoreOverviewForCid = '';
      clearHandoffTimers();
    }

    if ((auxBtn || subNode) && isOverviewOpen() && !isAuxPanelOpen()) {
      const targetBtn = auxBtn || subNode;
      e.preventDefault?.();
      e.stopPropagation?.();
      if (menuOpen) closeMenu();
      runOverviewToAuxHandoff(() => safeNativeClick(targetBtn));
      return;
    }

    if (auxBtn || ovBtn || subNode) {
      trackRaf(() => {
        enforcePanelMutualExclusion();
        syncMainSubagentEntry();
      });
    }

    if (!menuOpen) return;
    if (menuEl?.contains(e.target)) return;
    if (e.target?.closest?.(`#${MAIN_PILL_ID}`)) return;
    closeMenu();
  };
  const onDocKey = (e) => {
    if (menuOpen && e.key === 'Escape') closeMenu();
  };
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onDocKey, true);

  function syncMainSubagentEntry() {
    const mainBox = document.getElementById('antigravity.agentSidePanelInputBox')
      || document.querySelector('[data-testid="conversation-view"] [data-testid="agent-input-box"]');
    const footer = mainBox?.querySelector('.agy-composer-footer');
    const leftGroup = footer?.children?.[0];
    if (!footer || !leftGroup) return;

    const addCtxBtn = leftGroup.querySelector(':scope > button:first-of-type');
    const hasNativeSubChip = Array.from(leftGroup.children).some((ch) => {
      if (ch === addCtxBtn) return false;
      if (ch.id === MAIN_PILL_ID || ch.id === 'agy-resume-pill') return false;
      if (ch.id === 'agy-capsule-picker-host' || ch.hasAttribute('data-agy-picker-host')) return false;
      if (ch.getAttribute?.('data-agy-model-wrap') === '1') return false;
      if (ch.id === 'ag-claude-ctx-ring' || ch.id === 'ag-live-metrics-pill') return false;
      if (ch.tagName === 'INPUT' || ch.querySelector?.('button[data-deck-model-bubble="hidden"]')) return false;
      return ch.getBoundingClientRect().width > 1;
    });

    const all = getSortedChildren();
    const active = getVisibleMainChildren();
    let pill = document.getElementById(MAIN_PILL_ID);

    if (hasNativeSubChip || all.length === 0) {
      if (pill) pill.remove();
      closeMenu();
      return;
    }

    if (!pill) {
      pill = document.createElement('button');
      pill.id = MAIN_PILL_ID;
      pill.type = 'button';
      pill.setAttribute('data-no-drag', '');
      pill.setAttribute('data-ag-i18n-ignore', '1');
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const latestAll = getSortedChildren();
        if (!latestAll.length) return;
        if (latestAll.length === 1) {
          closeMenu();
          openOrToggleSubagentSidePanel(latestAll[0].id, {
            label: getSubagentLabel(latestAll[0]),
            allowToggleClose: true,
          });
        } else if (menuOpen) {
          closeMenu();
        } else {
          openMenuFor(pill, latestAll, getVisibleMainChildren());
        }
      });
    }

    if (pill.parentElement !== leftGroup) {
      leftGroup.appendChild(pill);
    }

    const displayList = active.length > 0 ? active : all;
    const isMultiple = all.length > 1;
    const primary = displayList[0];
    const anyRunning = active.some((c) => c.running);
    const auxOpen = isAuxPanelOpen();
    const activeTabId = auxOpen ? getActiveSubagentTabId() : '';
    const isLinkedOpen = Boolean(auxOpen && activeTabId && all.some((c) => c.id === activeTabId));
    const subState = active.length === 0 ? 'ended' : anyRunning ? 'running' : 'done';
    const label = displayList.length > 1 ? L('子代理', 'Subagents') : getSubagentLabel(primary);
    const countBadge = isMultiple ? `<span class="agy-sub-count">${all.length}</span>` : '';
    const dotHtml = anyRunning ? '<span class="agy-sub-live-dot" aria-hidden="true"></span>' : '';
    const botSvg = '<svg class="agy-sub-ico" width="12.5" height="12.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6.2 8.8h.01M9.8 8.8h.01M6.2 11h3.6"/></svg>';

    const statusDesc = active.length === 0
      ? L('历史会话', 'Past sessions')
      : anyRunning
        ? L('工作中', 'Working')
        : L('已完成 / 待命', 'Done / Standby');
    const namesSummary = displayList.map(getSubagentLabel).join(', ');
    const tooltip = `${L('子代理', 'Subagent')}: ${namesSummary} · ${statusDesc} · ${
      isLinkedOpen ? L('点击收起侧栏', 'Click to close side panel') : L('点击联动打开侧栏', 'Click to open side panel')
    }`;

    const sig = `${label}|${active.length}|${all.length}|${subState}|${isLinkedOpen ? 1 : 0}`;
    if (pill.getAttribute('data-sig') !== sig) {
      pill.setAttribute('data-sig', sig);
      pill.setAttribute('data-agy-sub-state', subState);
      pill.setAttribute('data-active', isLinkedOpen ? 'true' : 'false');
      pill.title = tooltip;
      pill.innerHTML = `${dotHtml}${botSvg}<span class="agy-sub-name">${esc(label)}</span>${countBadge}`;
    }
  }

  /* ---- Part B: Side-Panel Subagent Composer 3 Capsules (4-Tier Responsive) ---- */

  function fetchSubagentMetrics(cid) {
    if (!cid || disposed || typeof window.__agProjectCall !== 'function') return;
    const now = Date.now();
    const ttl = subCache.data?.running ? 1400 : 3500;
    if (subCache.cid === cid && (subCache.inFlight || now - subCache.ts < ttl)) return;

    subCache.cid = cid;
    subCache.inFlight = true;
    Promise.resolve(window.__agProjectCall('getSubagentMetrics', { cascadeId: cid }, 4000))
      .then((res) => {
        if (disposed || subCache.cid !== cid) return;
        if (res && res.ok) {
          subCache.data = res;
          subCache.ts = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => {
        if (subCache.cid === cid) subCache.inFlight = false;
        if (!disposed) syncSidePanelSubagentFooter();
      });
  }

  function renderSubModelPill(el, data) {
    const fullName = data.modelName || 'Subagent';
    const shortName = typeof shortenModelName === 'function' ? shortenModelName(fullName, isZh()) : fullName;
    let accent = '#7c5ce6';
    try {
      const c = motionThemes().dotColorFor(fullName);
      if (c) accent = c;
    } catch {}
    if (el.style.getPropertyValue('--agy-model-accent') !== accent) {
      el.style.setProperty('--agy-model-accent', accent);
    }
    const rawEffort = String(data.effort || '').trim();
    const effortText = rawEffort
      ? (typeof shortenEffortBadge === 'function' ? shortenEffortBadge(rawEffort) : rawEffort)
      : '';
    const hasEffort = Boolean(effortText);
    const effortHtml = hasEffort ? `<span class="agy-sub-effort">${esc(effortText)}</span>` : '';
    const sig = `${fullName}|${shortName}|${effortText}|${accent}`;
    if (el.getAttribute('data-sig') !== sig) {
      el.setAttribute('data-sig', sig);
      el.setAttribute('data-has-effort', hasEffort ? '1' : '0');
      el.title = `${fullName}${rawEffort ? ` · ${rawEffort}` : ''}`;
      el.innerHTML = `<span class="agy-sub-mdot" aria-hidden="true"></span><span class="agy-sub-mname agy-sub-mname-full">${esc(fullName)}</span><span class="agy-sub-mname agy-sub-mname-short">${esc(shortName)}</span>${effortHtml}`;
    }
  }

  function renderSubCtxPill(el, data) {
    const pct = Number.isFinite(data.pct) ? Math.max(0, Math.min(100, Math.round(data.pct))) : 0;
    const tier = pct < 60 ? 'cool' : pct >= 75 ? 'crit' : 'warn';
    const ratio = `${fmtTok(data.contextTokens)} / ${fmtTok(data.maxContextTokens)}`;
    const pctText = `${pct}%`;
    const dashOffset = Math.max(0, RING_CIRC * (1 - pct / 100));
    const sig = `${ratio}|${pctText}|${tier}`;
    if (el.getAttribute('data-sig') !== sig) {
      el.setAttribute('data-sig', sig);
      el.setAttribute('data-agy-ctx-tier', tier);
      el.title = `${L('子代理上下文', 'Subagent context')} ${ratio} (${pct}%)`;
      el.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><circle class="agy-sub-ring-track" cx="10" cy="10" r="7" fill="none" stroke-width="2.15"/><circle class="agy-sub-ring-arc" cx="10" cy="10" r="7" fill="none" stroke-width="2.15" stroke-linecap="round" stroke-dasharray="${RING_CIRC.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"/></svg><span class="agy-sub-ctx-txt agy-sub-ctx-full">${esc(ratio)}</span><span class="agy-sub-ctx-txt agy-sub-ctx-pct">${esc(pctText)}</span>`;
    }
  }

  function renderSubSpeedPill(el, data) {
    const tps = Number(data.tps);
    const hasTps = Number.isFinite(tps) && tps > 0;
    const tier = !hasTps ? 'unknown' : tps >= 25 ? 'fast' : tps >= 10 ? 'mid' : 'slow';
    const motion = data.running ? 'active' : 'idle';
    const ttftText = Number.isFinite(data.ttft)
      ? `${data.isHold ? 'Hold' : 'TTFT'} ${data.ttft.toFixed(1)}s`
      : '';
    const fullTip = [hasTps ? `${Math.round(tps)} tok/s` : '', ttftText].filter(Boolean).join(' · ')
      || (data.running ? L('生成中…', 'Working…') : '');

    if (!fullTip) {
      el.hidden = true;
      return;
    }
    el.hidden = false;

    const fullLabel = hasTps
      ? `${Math.round(tps)} tok/s`
      : data.running
        ? L('生成中…', 'Working…')
        : '';
    const tightLabel = hasTps
      ? `${Math.round(tps)}`
      : data.running
        ? '…'
        : '';

    const parts = [];
    if (fullLabel) {
      parts.push(`<span class="agy-sub-spd-num agy-sub-spd-full">${esc(fullLabel)}</span>`);
      parts.push(`<span class="agy-sub-spd-num agy-sub-spd-tight">${esc(tightLabel)}</span>`);
      if (ttftText) {
        parts.push(`<span class="agy-sub-spd-sep">·</span><span class="agy-sub-spd-ttft">${esc(ttftText)}</span>`);
      }
    } else if (ttftText) {
      parts.push(`<span class="agy-sub-spd-ttft">${esc(ttftText)}</span>`);
    }

    const sig = `${fullLabel}|${tightLabel}|${ttftText}|${tier}|${motion}`;
    if (el.getAttribute('data-sig') !== sig) {
      el.setAttribute('data-sig', sig);
      el.setAttribute('data-agy-speed-tier', tier);
      el.setAttribute('data-agy-motion', motion);
      el.title = fullTip;
      const txtHtml = parts.length ? `<span class="agy-sub-stxt">${parts.join('')}</span>` : '';
      el.innerHTML = `<span class="agy-sub-sdot" aria-hidden="true"></span>${txtHtml}`;
    }
  }

  function syncSidePanelSubagentFooter() {
    const comp = document.querySelector('[data-testid="subagent-tab-composer"]');
    const footer = comp?.querySelector('.agy-composer-footer');
    const leftGroup = footer?.children?.[0];
    if (!footer || !leftGroup) return;

    const cid = getActiveSubagentTabId();
    if (!cid) return;

    fetchSubagentMetrics(cid);
    const data = subCache.cid === cid ? subCache.data : null;
    if (!data || !data.hasData) return;

    const stateAttr = data.running ? 'running' : 'done';
    // Tag native subagent chip inside side panel composer with semantic running/done state
    for (const ch of leftGroup.children) {
      if (ch.hasAttribute(SUB_GROUP_ATTR) || ch.tagName === 'INPUT') continue;
      if (ch === leftGroup.querySelector(':scope > button:first-of-type')) continue;
      if (ch.querySelector?.('button[data-deck-model-bubble="hidden"]')) continue;
      if (ch.getAttribute('data-agy-sub-state') !== stateAttr) {
        ch.setAttribute('data-agy-sub-state', stateAttr);
      }
      if (ch.getAttribute('data-agy-native-sub-chip') !== '1') {
        ch.setAttribute('data-agy-native-sub-chip', '1');
      }
    }

    const ensurePill = (kind, cls) => {
      let el = leftGroup.querySelector(`:scope > [${SUB_GROUP_ATTR}="${kind}"]`);
      if (!el) {
        el = document.createElement('span');
        el.setAttribute(SUB_GROUP_ATTR, kind);
        el.setAttribute('data-ag-i18n-ignore', '1');
        el.className = `agy-sub-pill ${cls}`;
        leftGroup.appendChild(el);
      }
      return el;
    };

    renderSubModelPill(ensurePill('model', 'agy-sub-model'), data);
    renderSubCtxPill(ensurePill('ctx', 'agy-sub-ctx'), data);
    renderSubSpeedPill(ensurePill('speed', 'agy-sub-speed'), data);
  }

  function sync() {
    if (disposed) return;
    enforcePanelMutualExclusion();
    ensureDefaultOverviewOpen();
    syncTurnAdvanceRetirement();
    syncMainSubagentEntry();
    syncSidePanelSubagentFooter();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    restoreOverviewForCid = '';
    autoOpenedOverviewCids.clear();
    clearHandoffState();
    for (const id of activeTimers) clearTimeout(id);
    activeTimers.clear();
    for (const id of activeRafs) cancelAnimationFrame(id);
    activeRafs.clear();
    preArmCloseTimer = 0;
    subSwitchTimer = 0;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onDocKey, true);
    closeMenu();
    if (menuEl) {
      try { menuEl.remove(); } catch {}
      menuEl = null;
    }
    document.getElementById(MAIN_PILL_ID)?.remove();
    document.querySelectorAll(`[${SUB_GROUP_ATTR}]`).forEach((el) => el.remove());
  }

  return { sync, dispose };
}
