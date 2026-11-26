/**
 * Overview <-> Auxiliary Side-Panel Choreography, Mutual Exclusion & 50/50 Split Pre-Arming.
 */
import { getActiveRouteCid } from '../../core/env.mjs';

export function getAuxToggleBtn() {
  return document.querySelector('button[data-testid="toggle-aux-sidebar"]');
}

export function getOverviewToggleBtn() {
  return document.querySelector('button[data-testid="toggle-overview-panel"]');
}

export function isAuxPanelOpen() {
  const btn = getAuxToggleBtn();
  if (btn) return btn.getAttribute('aria-expanded') === 'true';
  const split = document.querySelector('[data-testid="aux-pane-split"]');
  const auxPane = split?.children?.[2];
  return Boolean(auxPane && auxPane.getBoundingClientRect().width > 40);
}

export function isOverviewOpen() {
  const btn = getOverviewToggleBtn();
  return Boolean(btn && btn.getAttribute('aria-pressed') === 'true');
}

export function getActiveSubagentTabId() {
  try {
    const tab = new URLSearchParams(location.search).get('tab') || '';
    const m = tab.match(/^subagent_convo__(.+)$/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

export function findNativeSubagentNode(subagentId, label) {
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

export function pushSubagentTab(subagentId) {
  try {
    const url = new URL(location.href);
    url.searchParams.set('tab', `subagent_convo__${subagentId}`);
    history.pushState(history.state, '', url.pathname + url.search + url.hash);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  } catch {}
}

export function createPanelHandoffController({
  studioPrefs,
  isDisposed,
  closeMenu,
  onAfterPanelSync,
}) {
  let prevAuxOpen = null;
  let prevOvOpen = null;
  let mutualGuardUntil = 0;
  let restoreOverviewForCid = '';
  let restoreHoldReserve = '0px';
  let restoreHoldGutter = '0px';
  const autoOpenedOverviewCids = new Set();

  const activeTimers = new Set();
  const handoffTimers = new Set();
  const activeRafs = new Set();
  let replayingPanelClick = false;
  let bootedPreArm = false;
  let preArmCloseTimer = 0;
  let subSwitchTimer = 0;

  const isMagaDrawerOpen = () => Boolean(document.documentElement?.hasAttribute?.('data-agy-maga-settings-open'));
  const currentRouteKey = () => getActiveRouteCid() || '__current__';

  function prefersReducedMotion() {
    const ml = studioPrefs?.get?.()?.motionLevel || document.documentElement?.getAttribute?.('data-agy-motion');
    if (ml === 'reduced' || ml === 'off') return true;
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
      if (!isDisposed()) fn();
    }, ms);
    pool.add(id);
    return id;
  }

  function trackRaf(fn) {
    const id = requestAnimationFrame(() => {
      activeRafs.delete(id);
      if (!isDisposed()) fn();
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

  function readHostOverviewHold() {
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
    return { reserve, gutter };
  }

  function armAuxToOvHold({ allowFallback = false } = {}) {
    if (prefersReducedMotion()) return false;
    let res = restoreHoldReserve || '0px';
    let gut = restoreHoldGutter || '0px';
    if (res === '0px' && gut === '0px' && allowFallback) {
      const splitW =
        document.querySelector('[data-testid="aux-pane-split"]')?.getBoundingClientRect?.().width ||
        (typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0);
      if (splitW >= 960) gut = '336px';
    }
    if (res === '0px' && gut === '0px') return false;
    const root = document.documentElement;
    if (root) {
      try {
        root.style?.setProperty?.('--agy-hold-ov-reserve', res);
        root.style?.setProperty?.('--agy-hold-ov-gutter', gut);
      } catch {}
      root.setAttribute?.('data-agy-panel-handoff', 'aux-to-ov-closing');
    }
    return true;
  }

  function runOverviewToAuxHandoff(openAction) {
    clearHandoffTimers();
    const root = document.documentElement;
    const { reserve, gutter } = readHostOverviewHold();
    restoreHoldReserve = reserve;
    restoreHoldGutter = gutter;

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
    if (isMagaDrawerOpen()) return false;
    const routeKey = currentRouteKey();
    if (!restoreOverviewForCid) return false;
    if (restoreOverviewForCid !== routeKey) {
      restoreOverviewForCid = '';
      restoreHoldReserve = '0px';
      restoreHoldGutter = '0px';
      return false;
    }
    if (isOverviewOpen()) {
      restoreOverviewForCid = '';
      restoreHoldReserve = '0px';
      restoreHoldGutter = '0px';
      return false;
    }

    mutualGuardUntil = Date.now() + 750;
    clearHandoffTimers();
    const held = armAuxToOvHold({ allowFallback: false });
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
      restoreHoldReserve = '0px';
      restoreHoldGutter = '0px';
      if (held) clearHandoffState();
    }, 540, handoffTimers);

    return true;
  }

  function ensureDefaultOverviewOpen({ ignoreGuard = false } = {}) {
    if (isMagaDrawerOpen()) return;
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

    if (isMagaDrawerOpen()) return;

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
      if (document.documentElement?.getAttribute?.('data-agy-panel-handoff') === 'aux-to-ov-closing') {
        clearHandoffState();
      }
      if (ovOpen) {
        mutualGuardUntil = now + 500;
        const { reserve, gutter } = readHostOverviewHold();
        restoreHoldReserve = reserve;
        restoreHoldGutter = gutter;
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
      onAfterPanelSync?.();
    });
  }

  function openOrToggleSubagentSidePanel(subagentId, { label = '', allowToggleClose = true } = {}) {
    if (!subagentId) return;
    const auxOpen = isAuxPanelOpen();
    const activeTabId = getActiveSubagentTabId();

    if (allowToggleClose && auxOpen && activeTabId === subagentId) {
      clearHandoffState();
      const auxBtn = getAuxToggleBtn();
      if (auxBtn) {
        safeNativeClick(auxBtn);
        trackRaf(() => {
          enforcePanelMutualExclusion();
          onAfterPanelSync?.();
        });
      }
      return;
    }

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
        onAfterPanelSync?.();
      });
      return;
    }

    if (isOverviewOpen()) {
      runOverviewToAuxHandoff(() => performOpenSubagent(subagentId, label));
      return;
    }

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

  function handleToggleClick(e) {
    if (replayingPanelClick) return true;

    const auxBtn = e.target?.closest?.('button[data-testid="toggle-aux-sidebar"]');
    const ovBtn = e.target?.closest?.('button[data-testid="toggle-overview-panel"]');
    const subNode = e.target?.closest?.('button[data-testid="subagent-node"]');

    if (ovBtn && isAuxPanelOpen() && !isOverviewOpen()) {
      e.preventDefault?.();
      e.stopPropagation?.();
      closeMenu?.();
      restoreOverviewForCid = '';
      clearHandoffState();
      const held = armAuxToOvHold({ allowFallback: true });
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
        restoreHoldReserve = '0px';
        restoreHoldGutter = '0px';
        if (held) clearHandoffState();
      }, 540, handoffTimers);
      return true;
    }

    if (ovBtn && isOverviewOpen()) {
      const cid = getActiveRouteCid();
      if (cid) autoOpenedOverviewCids.add(cid);
      restoreOverviewForCid = '';
      restoreHoldReserve = '0px';
      restoreHoldGutter = '0px';
      clearHandoffTimers();
    }

    if ((auxBtn || subNode) && isOverviewOpen() && !isAuxPanelOpen()) {
      const targetBtn = auxBtn || subNode;
      e.preventDefault?.();
      e.stopPropagation?.();
      closeMenu?.();
      runOverviewToAuxHandoff(() => safeNativeClick(targetBtn));
      return true;
    }

    if (auxBtn || ovBtn || subNode) {
      trackRaf(() => {
        enforcePanelMutualExclusion();
        onAfterPanelSync?.();
      });
    }
    return false;
  }

  function dispose() {
    restoreOverviewForCid = '';
    restoreHoldReserve = '0px';
    restoreHoldGutter = '0px';
    autoOpenedOverviewCids.clear();
    clearHandoffState();
    for (const id of activeTimers) clearTimeout(id);
    activeTimers.clear();
    for (const id of activeRafs) cancelAnimationFrame(id);
    activeRafs.clear();
    preArmCloseTimer = 0;
    subSwitchTimer = 0;
  }

  return {
    enforcePanelMutualExclusion,
    ensureDefaultOverviewOpen,
    openOrToggleSubagentSidePanel,
    handleToggleClick,
    dispose,
  };
}
