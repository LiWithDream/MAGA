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

export function createSubagentFooterRuntime({ motionThemes }) {
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

  function shortenModelName(name) {
    const raw = String(name || '').trim();
    if (!raw) return 'Model';
    const stripped = raw
      .replace(/^(?:Google\s+)?Gemini\s+\d+(?:\.\d+)?\s+/i, '')
      .replace(/^Claude\s+(?:\d+(?:\.\d+)?\s+)?/i, '')
      .replace(/^OpenAI\s+/i, '')
      .trim();
    if (stripped && stripped.length >= 2 && stripped.length < raw.length) return stripped;
    return raw.length > 10 ? raw.slice(0, 10) : raw;
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

  function setAuxSplitToEqualWidth() {
    const split = document.querySelector('[data-testid="aux-pane-split"]');
    if (!split) return false;
    const fk = Object.keys(split).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fk ? split[fk] : null;
    for (let i = 0; i < 6 && fiber; i++) {
      const props = fiber.memoizedProps;
      if (props && (typeof props.onResize === 'function' || typeof props.onDragEnd === 'function')) {
        try {
          if (typeof props.onResize === 'function') props.onResize(50);
          if (typeof props.onDragEnd === 'function') props.onDragEnd(50);
          return true;
        } catch {}
      }
      fiber = fiber.return;
    }
    return false;
  }

  function enforcePanelMutualExclusion() {
    const auxOpen = isAuxPanelOpen();
    const ovOpen = isOverviewOpen();
    const now = Date.now();

    if (prevAuxOpen === null || prevOvOpen === null) {
      prevAuxOpen = auxOpen;
      prevOvOpen = ovOpen;
      return;
    }

    const auxJustOpened = !prevAuxOpen && auxOpen;
    const ovJustOpened = !prevOvOpen && ovOpen;
    prevAuxOpen = auxOpen;
    prevOvOpen = ovOpen;

    if (now < mutualGuardUntil) {
      if (auxJustOpened) {
        setAuxSplitToEqualWidth();
        requestAnimationFrame(() => !disposed && isAuxPanelOpen() && setAuxSplitToEqualWidth());
      }
      return;
    }

    if (auxJustOpened) {
      if (ovOpen) {
        mutualGuardUntil = now + 350;
        const ovBtn = getOverviewToggleBtn();
        if (ovBtn) {
          ovBtn.click();
          prevOvOpen = false;
        }
      }
      // Reset aux split to 50/50 equal width when opening
      setAuxSplitToEqualWidth();
      requestAnimationFrame(() => !disposed && isAuxPanelOpen() && setAuxSplitToEqualWidth());
    } else if (ovJustOpened) {
      if (auxOpen) {
        mutualGuardUntil = now + 350;
        const auxBtn = getAuxToggleBtn();
        if (auxBtn) {
          auxBtn.click();
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

  function openOrToggleSubagentSidePanel(subagentId, { label = '', allowToggleClose = true } = {}) {
    if (!subagentId) return;
    const auxOpen = isAuxPanelOpen();
    const activeTabId = getActiveSubagentTabId();

    // Case 1: Side panel is already open on this exact subagent -> toggle it closed
    if (allowToggleClose && auxOpen && activeTabId === subagentId) {
      const auxBtn = getAuxToggleBtn();
      if (auxBtn) auxBtn.click();
      return;
    }

    // Case 2: Open / switch to target subagent & close Overview (mutual exclusion)
    if (isOverviewOpen()) {
      mutualGuardUntil = Date.now() + 400;
      const ovBtn = getOverviewToggleBtn();
      if (ovBtn) {
        ovBtn.click();
        prevOvOpen = false;
      }
    }

    // Prefer native sidebar subagent node (opens aux panel + initializes tab cleanly in React store)
    const nativeNode = findNativeSubagentNode(subagentId, label);
    if (nativeNode) {
      nativeNode.click();
    } else {
      // Fallback when left sidebar is collapsed or node isn't mounted: update URL tab + open aux panel
      try {
        const url = new URL(location.href);
        url.searchParams.set('tab', `subagent_convo__${subagentId}`);
        history.pushState(history.state, '', url.pathname + url.search + url.hash);
        window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      } catch {}
    }

    // Guarantee the auxiliary side panel is expanded AND set to 50/50 equal width
    const ensureOpenAndEqual = () => {
      if (disposed) return;
      if (!isAuxPanelOpen()) {
        const auxBtn = getAuxToggleBtn();
        if (auxBtn) auxBtn.click();
      }
      // Also make sure URL tab points to target subagent if native node didn't switch it
      if (getActiveSubagentTabId() !== subagentId) {
        try {
          const url = new URL(location.href);
          url.searchParams.set('tab', `subagent_convo__${subagentId}`);
          history.pushState(history.state, '', url.pathname + url.search + url.hash);
          window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
        } catch {}
      }
      setAuxSplitToEqualWidth();
      prevAuxOpen = isAuxPanelOpen();
      syncMainSubagentEntry();
    };

    requestAnimationFrame(() => {
      ensureOpenAndEqual();
      setTimeout(() => !disposed && isAuxPanelOpen() && setAuxSplitToEqualWidth(), 80);
    });
  }

  function getSubagentLabel(ch) {
    return String(ch?.agentName || ch?.title || ch?.id?.slice(0, 8) || 'subagent').trim();
  }

  function getSortedChildren() {
    const m = window.__ag_last_metrics;
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

  function openMenuFor(pill, children) {
    const el = ensureMenuEl();
    const auxOpen = isAuxPanelOpen();
    const activeTabId = auxOpen ? getActiveSubagentTabId() : '';
    const rowsHtml = children
      .map((ch) => {
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
      })
      .join('');
    el.innerHTML = `<div class="agy-sub-menu-hdr">${esc(L('子代理会话', 'Subagents'))} · ${children.length}</div><div class="agy-sub-menu-list">${rowsHtml}</div>`;
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
    // Immediate mutual exclusion reaction when user clicks native top-bar panel toggles
    const auxBtn = e.target?.closest?.('button[data-testid="toggle-aux-sidebar"]');
    const ovBtn = e.target?.closest?.('button[data-testid="toggle-overview-panel"]');
    const subNode = e.target?.closest?.('button[data-testid="subagent-node"]');
    if (ovBtn && isAuxPanelOpen() && !isOverviewOpen()) {
      // Close Aux immediately when opening Overview; if main pane was temporarily narrow during
      // the 500ms slide-out transition and Antigravity ignored the first click, finish opening Overview.
      mutualGuardUntil = Date.now() + 700;
      const a = getAuxToggleBtn();
      if (a) {
        a.click();
        prevAuxOpen = false;
      }
      setTimeout(() => {
        if (!disposed && !isAuxPanelOpen() && !isOverviewOpen()) {
          getOverviewToggleBtn()?.click();
        }
      }, 540);
    }
    if (auxBtn || ovBtn || subNode) {
      requestAnimationFrame(() => {
        if (!disposed) {
          enforcePanelMutualExclusion();
          syncMainSubagentEntry();
        }
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

    const hasNativeSubChip = Array.from(leftGroup.children).some((ch) => {
      if (ch.id === MAIN_PILL_ID || ch.id === 'agy-resume-pill') return false;
      if (ch.id === 'agy-capsule-picker-host' || ch.hasAttribute('data-agy-picker-host')) return false;
      if (ch.id === 'ag-claude-ctx-ring' || ch.id === 'ag-live-metrics-pill') return false;
      if (ch.tagName === 'INPUT' || ch.querySelector?.('button[data-deck-model-bubble="hidden"]')) return false;
      if (ch === leftGroup.querySelector(':scope > button:first-of-type')) return false;
      return ch.getBoundingClientRect().width > 1;
    });

    const children = getVisibleMainChildren();
    let pill = document.getElementById(MAIN_PILL_ID);

    if (hasNativeSubChip || children.length === 0) {
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
        const latest = getVisibleMainChildren();
        if (!latest.length) return;
        if (latest.length === 1) {
          closeMenu();
          openOrToggleSubagentSidePanel(latest[0].id, {
            label: getSubagentLabel(latest[0]),
            allowToggleClose: true,
          });
        } else if (menuOpen) {
          closeMenu();
        } else {
          openMenuFor(pill, latest);
        }
      });
    }

    if (pill.parentElement !== leftGroup) {
      leftGroup.appendChild(pill);
    }

    const isMultiple = children.length > 1;
    const primary = children[0];
    const anyRunning = children.some((c) => c.running);
    const auxOpen = isAuxPanelOpen();
    const activeTabId = auxOpen ? getActiveSubagentTabId() : '';
    const isLinkedOpen = Boolean(auxOpen && activeTabId && children.some((c) => c.id === activeTabId));
    const subState = anyRunning ? 'running' : 'done';
    const label = isMultiple ? L('子代理', 'Subagents') : getSubagentLabel(primary);
    const countBadge = isMultiple ? `<span class="agy-sub-count">${children.length}</span>` : '';
    const dotHtml = anyRunning ? '<span class="agy-sub-live-dot" aria-hidden="true"></span>' : '';
    const botSvg = '<svg class="agy-sub-ico" width="12.5" height="12.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6.2 8.8h.01M9.8 8.8h.01M6.2 11h3.6"/></svg>';

    const statusDesc = anyRunning
      ? L('工作中', 'Working')
      : L('已完成 / 待命', 'Done / Standby');
    const namesSummary = children.map(getSubagentLabel).join(', ');
    const tooltip = `${L('子代理', 'Subagent')}: ${namesSummary} · ${statusDesc} · ${
      isLinkedOpen ? L('点击收起侧栏', 'Click to close side panel') : L('点击联动打开侧栏', 'Click to open side panel')
    }`;

    const sig = `${label}|${children.length}|${subState}|${isLinkedOpen ? 1 : 0}`;
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

  function renderSubModelPill(el, data, dockTier) {
    const fullName = data.modelName || 'Subagent';
    const shortName = shortenModelName(fullName);
    let accent = '#7c5ce6';
    try {
      const c = motionThemes().dotColorFor(fullName);
      if (c) accent = c;
    } catch {}
    el.style.setProperty('--agy-model-accent', accent);
    const hasEffort = Boolean(data.effort);
    const effortHtml = hasEffort ? `<span class="agy-sub-effort">${esc(data.effort)}</span>` : '';
    const displayName = dockTier === 'full'
      ? fullName
      : dockTier === 'compact'
        ? shortName
        : hasEffort
          ? ''
          : shortName;
    const nameHtml = displayName ? `<span class="agy-sub-mname">${esc(displayName)}</span>` : '';
    const sig = `${displayName}|${data.effort || ''}|${accent}|${dockTier}`;
    if (el.getAttribute('data-sig') !== sig) {
      el.setAttribute('data-sig', sig);
      el.setAttribute('data-has-effort', hasEffort ? '1' : '0');
      el.title = `${fullName}${data.effort ? ` · ${data.effort}` : ''}`;
      el.innerHTML = `<span class="agy-sub-mdot" aria-hidden="true"></span>${nameHtml}${effortHtml}`;
    }
  }

  function renderSubCtxPill(el, data, dockTier) {
    const pct = Number.isFinite(data.pct) ? data.pct : 0;
    const tier = pct < 60 ? 'cool' : pct >= 75 ? 'crit' : 'warn';
    const ratio = `${fmtTok(data.contextTokens)} / ${fmtTok(data.maxContextTokens)}`;
    const display = dockTier === 'icon' ? '' : dockTier === 'tight' ? `${pct}%` : ratio;
    const dashOffset = Math.max(0, RING_CIRC * (1 - Math.max(0, Math.min(100, pct)) / 100));
    const sig = `${display}|${tier}|${pct}|${dockTier}`;
    if (el.getAttribute('data-sig') !== sig) {
      el.setAttribute('data-sig', sig);
      el.setAttribute('data-agy-ctx-tier', tier);
      el.setAttribute('data-agy-icon-only', display ? 'false' : 'true');
      el.title = `${L('子代理上下文', 'Subagent context')} ${ratio} (${pct}%)`;
      const txtHtml = display ? `<span class="agy-sub-ctx-txt">${esc(display)}</span>` : '';
      el.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><circle class="agy-sub-ring-track" cx="10" cy="10" r="7" fill="none" stroke-width="2.15"/><circle class="agy-sub-ring-arc" cx="10" cy="10" r="7" fill="none" stroke-width="2.15" stroke-linecap="round" stroke-dasharray="${RING_CIRC.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"/></svg>${txtHtml}`;
    }
  }

  function renderSubSpeedPill(el, data, dockTier) {
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

    const parts = [];
    if (dockTier === 'icon') {
      // Dot only
    } else if (dockTier === 'tight') {
      if (hasTps) parts.push(`<span class="agy-sub-spd-num">${Math.round(tps)}</span>`);
      else if (data.running) parts.push(`<span class="agy-sub-spd-num">…</span>`);
    } else if (dockTier === 'compact') {
      if (hasTps) parts.push(`<span class="agy-sub-spd-num">${Math.round(tps)} tok/s</span>`);
      else if (data.running) parts.push(`<span class="agy-sub-spd-num">${esc(L('生成中…', 'Working…'))}</span>`);
    } else {
      if (hasTps) parts.push(`<span class="agy-sub-spd-num">${Math.round(tps)} tok/s</span>`);
      if (ttftText) parts.push(`<span class="agy-sub-spd-sep">·</span><span class="agy-sub-spd-ttft">${esc(ttftText)}</span>`);
      if (!parts.length && data.running) {
        parts.push(`<span class="agy-sub-spd-num">${esc(L('生成中…', 'Working…'))}</span>`);
      }
    }

    const sig = `${parts.join('')}|${tier}|${motion}|${dockTier}`;
    if (el.getAttribute('data-sig') !== sig) {
      el.setAttribute('data-sig', sig);
      el.setAttribute('data-agy-speed-tier', tier);
      el.setAttribute('data-agy-motion', motion);
      el.setAttribute('data-agy-icon-only', parts.length === 0 ? 'true' : 'false');
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

    const dockTier = footer.getAttribute('data-agy-dock-tier') || 'compact';

    // Tag native subagent chip inside side panel composer with semantic running/done state
    for (const ch of leftGroup.children) {
      if (ch.hasAttribute(SUB_GROUP_ATTR) || ch.tagName === 'INPUT') continue;
      if (ch === leftGroup.querySelector(':scope > button:first-of-type')) continue;
      if (ch.querySelector?.('button[data-deck-model-bubble="hidden"]')) continue;
      ch.setAttribute('data-agy-sub-state', data.running ? 'running' : 'done');
      ch.setAttribute('data-agy-native-sub-chip', '1');
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

    renderSubModelPill(ensurePill('model', 'agy-sub-model'), data, dockTier);
    renderSubCtxPill(ensurePill('ctx', 'agy-sub-ctx'), data, dockTier);
    renderSubSpeedPill(ensurePill('speed', 'agy-sub-speed'), data, dockTier);
  }

  function sync() {
    if (disposed) return;
    enforcePanelMutualExclusion();
    syncTurnAdvanceRetirement();
    syncMainSubagentEntry();
    syncSidePanelSubagentFooter();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
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
