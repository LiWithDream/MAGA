/**
 * Subagent Footer, Side-Panel Linkage & Split-Pane Orchestration Coordinator.
 * Delegates panel handoff choreography to `./subagent/panel-handoff.mjs` and
 * pill/menu rendering to `./subagent/pills.mjs`.
 */
import { OWN_FOOTER_PILL_IDS, markOwn } from '../core/dom.mjs';
import { getActiveRouteCid, isComposerRunning } from '../core/env.mjs';
import {
  createPanelHandoffController,
  getActiveSubagentTabId,
  isAuxPanelOpen,
} from './subagent/panel-handoff.mjs';
import {
  buildSubagentMenuHtml,
  getSubagentLabel,
  renderMainPill,
  renderSubCtxPill,
  renderSubModelPill,
  renderSubSpeedPill,
} from './subagent/pills.mjs';

export function createSubagentFooterRuntime({ motionThemes, shortenModelName, shortenEffortBadge, studioPrefs } = {}) {
  const MAIN_PILL_ID = 'agy-main-subagent-pill';
  const MENU_ID = 'agy-subagent-menu';
  const SUB_GROUP_ATTR = 'data-agy-sub-pill';
  const SEEN_STORAGE_KEY = 'agy_studio_subagent_seen_v1';
  const MAX_SEEN_ENTRIES = 200;

  let disposed = false;
  let menuEl = null;
  let menuOpen = false;
  let prevMainRunning = null;
  const subCache = { cid: '', ts: 0, data: null, inFlight: false };

  const isSubagentFooterEnabled = () => studioPrefs?.get?.()?.subagentFooterEnabled !== false;

  const handoff = createPanelHandoffController({
    studioPrefs,
    isDisposed: () => disposed,
    closeMenu,
    onAfterPanelSync: () => syncMainSubagentEntry(),
  });

  const offStudioPrefs = studioPrefs?.subscribe?.(() => {
    if (disposed) return;
    if (!isSubagentFooterEnabled()) {
      closeMenu();
      document.getElementById(MAIN_PILL_ID)?.remove();
      document.querySelectorAll(`[${SUB_GROUP_ATTR}]`).forEach((el) => el.remove());
    } else {
      sync();
      if (menuOpen && menuEl) {
        const pill = document.getElementById(MAIN_PILL_ID);
        const all = getSortedChildren();
        if (pill && all.length > 1) {
          openMenuFor(pill, all, getVisibleMainChildren());
        } else {
          closeMenu();
        }
      }
    }
  });

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
    seenMap.delete(ch.id);
    seenMap.set(ch.id, sig);
    persistSeenMap();
    return true;
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

  function getSortedChildren(cid = getActiveRouteCid()) {
    const m = window.__ag_last_metrics;
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

  function getVisibleMainChildren(cid = getActiveRouteCid()) {
    const all = getSortedChildren(cid);
    const auxOpen = isAuxPanelOpen();
    const activeTabId = auxOpen ? getActiveSubagentTabId() : '';

    if (auxOpen && activeTabId) {
      const viewed = all.find((ch) => ch.id === activeTabId);
      if (viewed && !viewed.running) markChildSeen(viewed);
    }

    return all.filter((ch) => {
      const isOpenInSide = Boolean(auxOpen && activeTabId && ch.id === activeTabId);
      if (isOpenInSide) return true;
      if (ch.killed) return false;
      if (ch.running) return true;
      return !isChildSeen(ch);
    });
  }

  function syncTurnAdvanceRetirement(runningArg) {
    const running = runningArg !== undefined ? runningArg : isComposerRunning();
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

  /* ---- Main Composer Subagent Entry Pill + Selector Menu ---- */

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
      markOwn(menuEl);
      menuEl.setAttribute('data-ag-i18n-ignore', '1');
      menuEl.addEventListener('click', (e) => {
        const row = e.target?.closest?.('button[data-agy-open-sub]');
        if (!row) return;
        e.stopPropagation();
        const cid = row.getAttribute('data-agy-open-sub');
        const lbl = row.getAttribute('data-agy-sub-label') || '';
        closeMenu();
        if (cid) handoff.openOrToggleSubagentSidePanel(cid, { label: lbl, allowToggleClose: true });
      });
      document.body.appendChild(menuEl);
    } else {
      markOwn(menuEl);
    }
    return menuEl;
  }

  function openMenuFor(pill, allChildren, activeChildren = null) {
    const el = ensureMenuEl();
    const auxOpen = isAuxPanelOpen();
    const activeTabId = auxOpen ? getActiveSubagentTabId() : '';
    const activeList = Array.isArray(activeChildren) ? activeChildren : getVisibleMainChildren();

    el.innerHTML = buildSubagentMenuHtml({
      allChildren,
      activeChildren: activeList,
      auxOpen,
      activeTabId,
    });
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
    if (handoff.handleToggleClick(e)) return;
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

  function syncMainSubagentEntry(mainBoxArg = null, cidArg = undefined) {
    if (!isSubagentFooterEnabled()) {
      document.getElementById(MAIN_PILL_ID)?.remove();
      closeMenu();
      return;
    }
    const mainBox = mainBoxArg || document.getElementById('antigravity.agentSidePanelInputBox')
      || document.querySelector('[data-testid="conversation-view"] [data-testid="agent-input-box"]');
    const footer = mainBox?.querySelector('.agy-composer-footer');
    const leftGroup = footer?.children?.[0];
    if (!footer || !leftGroup) return;

    const addCtxBtn = leftGroup.querySelector(':scope > button:first-of-type');
    const hasNativeSubChip = Array.from(leftGroup.children).some((ch) => {
      if (ch === addCtxBtn) return false;
      if (OWN_FOOTER_PILL_IDS.has(ch.id)) return false;
      if (ch.id === 'agy-capsule-picker-host' || ch.hasAttribute('data-agy-picker-host')) return false;
      if (ch.getAttribute?.('data-agy-model-wrap') === '1') return false;
      if (ch.tagName === 'INPUT' || ch.querySelector?.('button[data-deck-model-bubble="hidden"]')) return false;
      return ch.getBoundingClientRect().width > 1;
    });

    const cid = cidArg !== undefined ? cidArg : getActiveRouteCid();
    const all = getSortedChildren(cid);
    const active = getVisibleMainChildren(cid);
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
      markOwn(pill);
      pill.setAttribute('data-no-drag', '');
      pill.setAttribute('data-ag-i18n-ignore', '1');
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const latestAll = getSortedChildren();
        if (!latestAll.length) return;
        if (latestAll.length === 1) {
          closeMenu();
          handoff.openOrToggleSubagentSidePanel(latestAll[0].id, {
            label: getSubagentLabel(latestAll[0]),
            allowToggleClose: true,
          });
        } else if (menuOpen) {
          closeMenu();
        } else {
          openMenuFor(pill, latestAll, getVisibleMainChildren());
        }
      });
    } else {
      markOwn(pill);
    }

    if (pill.parentElement !== leftGroup) {
      leftGroup.appendChild(pill);
    }

    const auxOpen = isAuxPanelOpen();
    renderMainPill(pill, {
      all,
      active,
      auxOpen,
      activeTabId: auxOpen ? getActiveSubagentTabId() : '',
    });
  }

  /* ---- Side-Panel Subagent Composer 3 Capsules (4-Tier Responsive) ---- */

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

  function syncSidePanelSubagentFooter() {
    if (!isSubagentFooterEnabled()) {
      document.querySelectorAll(`[${SUB_GROUP_ATTR}]`).forEach((el) => el.remove());
      return;
    }
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
        markOwn(el);
        el.setAttribute(SUB_GROUP_ATTR, kind);
        el.setAttribute('data-ag-i18n-ignore', '1');
        el.className = `agy-sub-pill ${cls}`;
        leftGroup.appendChild(el);
      } else {
        markOwn(el);
      }
      return el;
    };

    renderSubModelPill(ensurePill('model', 'agy-sub-model'), data, {
      motionThemes,
      shortenModelName,
      shortenEffortBadge,
    });
    renderSubCtxPill(ensurePill('ctx', 'agy-sub-ctx'), data);
    renderSubSpeedPill(ensurePill('speed', 'agy-sub-speed'), data);
  }

  function read(snapshot = null) {
    if (disposed) return null;
    const cid = snapshot ? snapshot.cid : getActiveRouteCid();
    const isRunning = snapshot ? snapshot.isRunning : isComposerRunning();
    const mainBox = snapshot ? snapshot.mainBox : null;
    const subComp = document.querySelector('[data-testid="subagent-tab-composer"]');
    return { cid, isRunning, mainBox, subComp };
  }

  function write(snapshot = null, planArg = undefined) {
    if (disposed) return;
    const plan = planArg !== undefined ? planArg : read(snapshot);
    if (!plan) return;
    handoff.enforcePanelMutualExclusion();
    handoff.ensureDefaultOverviewOpen();
    syncTurnAdvanceRetirement(plan.isRunning);
    syncMainSubagentEntry(plan.mainBox, plan.cid);
    syncSidePanelSubagentFooter();
  }

  function sync() {
    if (disposed) return;
    write(null, read(null));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    offStudioPrefs?.();
    handoff.dispose();
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

  function openSubagent(id, label = '') {
    if (!id || disposed) return;
    closeMenu();
    handoff.openOrToggleSubagentSidePanel(id, { label, allowToggleClose: true });
  }

  return {
    topics: ['composer', 'subagent', 'metrics', 'route', 'overview', 'prefs'],
    read,
    write,
    sync,
    openSubagent,
    dispose,
  };
}
