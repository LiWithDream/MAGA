/**
 * Subagent Footer & Main Composer Subagent Entry Module:
 * 1. Main Composer: adds a cohesive subagent entry capsule (#agy-main-subagent-pill) after the
 *    Speed capsule whenever the current conversation has child subagents; clicking opens the
 *    subagent side-panel (or pops a compact selector menu when multiple subagents exist).
 * 2. Side-Panel Subagent Composer ([data-testid="subagent-tab-composer"]): fetches live metrics
 *    for the active `?tab=subagent_convo__<uuid>` via daemon RPC `getSubagentMetrics` and mounts
 *    matching Model+Effort, Context (0/60/75%), and Speed+Live-Dot capsules alongside the native
 *    subagent chip.
 */

export function createSubagentFooterRuntime({ motionThemes }) {
  const MAIN_PILL_ID = 'agy-main-subagent-pill';
  const MENU_ID = 'agy-subagent-menu';
  const SUB_GROUP_ATTR = 'data-agy-sub-pill';
  const RING_CIRC = 2 * Math.PI * 7;

  let disposed = false;
  let menuEl = null;
  let menuOpen = false;
  let subCache = { cid: '', ts: 0, data: null, inFlight: false };

  function isZh() {
    return (
      (document.documentElement.lang || '').toLowerCase().startsWith('zh') ||
      document.documentElement.getAttribute('data-ag-ux-lang') === 'zh-CN'
    );
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

  function getActiveSubagentTabId() {
    try {
      const tab = new URLSearchParams(location.search).get('tab') || '';
      const m = tab.match(/^subagent_convo__(.+)$/);
      return m ? m[1] : '';
    } catch {
      return '';
    }
  }

  function openSubagentSidePanel(subagentId) {
    if (!subagentId) return;
    // Try clicking an already-rendered native subagent node if its label matches,
    // and always push the `?tab=subagent_convo__<id>` route cleanly via React Router popstate.
    try {
      const url = new URL(location.href);
      const targetTab = `subagent_convo__${subagentId}`;
      if (url.searchParams.get('tab') === targetTab) {
        url.searchParams.delete('tab');
      } else {
        url.searchParams.set('tab', targetTab);
      }
      history.pushState(history.state, '', url.pathname + url.search + url.hash);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    } catch {}
  }

  function getSubagentLabel(ch) {
    return String(ch?.agentName || ch?.title || ch?.id?.slice(0, 8) || 'subagent').trim();
  }

  function getSortedChildren() {
    const m = window.__ag_last_metrics;
    const raw = Array.isArray(m?.stats?.children) ? m.stats.children : [];
    const seen = new Set();
    const list = [];
    // Walk newest-first so recently spawned subagents appear ahead of older ones
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
        closeMenu();
        if (cid) openSubagentSidePanel(cid);
      });
      document.body.appendChild(menuEl);
    }
    return menuEl;
  }

  function openMenuFor(pill, children) {
    const el = ensureMenuEl();
    const activeTabId = getActiveSubagentTabId();
    const rowsHtml = children
      .map((ch) => {
        const name = getSubagentLabel(ch);
        const isCurrent = ch.id === activeTabId;
        const stateCls = ch.running ? 'is-run' : ch.killed ? 'is-killed' : 'is-ready';
        const stateTxt = ch.running
          ? L('运行中', 'Running')
          : ch.killed
            ? L('已结束', 'Ended')
            : L('待命', 'Standby');
        return `<button type="button" class="agy-sub-menu-row${isCurrent ? ' is-active' : ''}" data-agy-open-sub="${esc(ch.id)}">
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

    // If this composer already has a native subagent chip (e.g. Full View of a subagent), do not duplicate
    const hasNativeSubChip = Array.from(leftGroup.children).some((ch) => {
      if (ch.id === MAIN_PILL_ID) return false;
      if (ch.id === 'agy-capsule-picker-host' || ch.hasAttribute('data-agy-picker-host')) return false;
      if (ch.id === 'ag-claude-ctx-ring' || ch.id === 'ag-live-metrics-pill') return false;
      if (ch.tagName === 'INPUT' || ch.querySelector?.('button[data-deck-model-bubble="hidden"]')) return false;
      if (ch === leftGroup.querySelector(':scope > button:first-of-type')) return false;
      return ch.getBoundingClientRect().width > 1;
    });

    const children = getSortedChildren();
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
        const latest = getSortedChildren();
        if (!latest.length) return;
        const alive = latest.filter((x) => !x.killed);
        if (latest.length === 1) {
          closeMenu();
          openSubagentSidePanel(latest[0].id);
        } else if (alive.length === 1 && !menuOpen) {
          // One live subagent + historical ones: toggle menu so user can pick any, or direct-open if Shift
          openMenuFor(pill, latest);
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

    const primary = children[0];
    const anyRunning = children.some((c) => c.running);
    const activeTabId = getActiveSubagentTabId();
    const isTabOpen = Boolean(activeTabId && children.some((c) => c.id === activeTabId));
    const label = getSubagentLabel(primary);
    const countBadge = children.length > 1 ? `<span class="agy-sub-count">${children.length}</span>` : '';
    const dotHtml = anyRunning ? '<span class="agy-sub-live-dot" aria-hidden="true"></span>' : '';
    const botSvg = '<svg class="agy-sub-ico" width="12.5" height="12.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6.2 8.8h.01M9.8 8.8h.01M6.2 11h3.6"/></svg>';

    const sig = `${label}|${children.length}|${anyRunning ? 1 : 0}|${isTabOpen ? 1 : 0}`;
    if (pill.getAttribute('data-sig') !== sig) {
      pill.setAttribute('data-sig', sig);
      pill.setAttribute('data-active', isTabOpen ? 'true' : 'false');
      pill.title = L('查看/切换子代理侧栏', 'Open or switch subagent side panel');
      pill.innerHTML = `${dotHtml}${botSvg}<span class="agy-sub-name">${esc(label)}</span>${countBadge}`;
    }
  }

  /* ---- Part B: Side-Panel Subagent Composer 3 Capsules ---- */

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
    const name = data.modelName || 'Subagent';
    let accent = '#7c5ce6';
    try {
      const c = motionThemes().dotColorFor(name);
      if (c) accent = c;
    } catch {}
    el.style.setProperty('--agy-model-accent', accent);
    const effortHtml = data.effort ? `<span class="agy-sub-effort">${esc(data.effort)}</span>` : '';
    const sig = `${name}|${data.effort || ''}|${accent}`;
    if (el.getAttribute('data-sig') !== sig) {
      el.setAttribute('data-sig', sig);
      el.innerHTML = `<span class="agy-sub-mdot" aria-hidden="true"></span><span class="agy-sub-mname">${esc(name)}</span>${effortHtml}`;
    }
  }

  function renderSubCtxPill(el, data, isXs) {
    const pct = Number.isFinite(data.pct) ? data.pct : 0;
    const tier = pct < 60 ? 'cool' : pct >= 75 ? 'crit' : 'warn';
    const ratio = `${fmtTok(data.contextTokens)} / ${fmtTok(data.maxContextTokens)}`;
    const display = isXs ? `${pct}%` : ratio;
    const dashOffset = Math.max(0, RING_CIRC * (1 - Math.max(0, Math.min(100, pct)) / 100));
    const sig = `${display}|${tier}|${pct}`;
    if (el.getAttribute('data-sig') !== sig) {
      el.setAttribute('data-sig', sig);
      el.setAttribute('data-agy-ctx-tier', tier);
      el.title = `${L('子代理上下文', 'Subagent context')} ${ratio} (${pct}%)`;
      el.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><circle class="agy-sub-ring-track" cx="10" cy="10" r="7" fill="none" stroke-width="2.15"/><circle class="agy-sub-ring-arc" cx="10" cy="10" r="7" fill="none" stroke-width="2.15" stroke-linecap="round" stroke-dasharray="${RING_CIRC.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"/></svg><span class="agy-sub-ctx-txt">${esc(display)}</span>`;
    }
  }

  function renderSubSpeedPill(el, data) {
    const tps = Number(data.tps);
    const hasTps = Number.isFinite(tps) && tps > 0;
    const tier = !hasTps ? 'unknown' : tps >= 25 ? 'fast' : tps >= 10 ? 'mid' : 'slow';
    const motion = data.running ? 'active' : 'idle';
    const parts = [];
    if (hasTps) parts.push(`<span class="agy-sub-spd-num">${Math.round(tps)} tok/s</span>`);
    if (Number.isFinite(data.ttft)) {
      parts.push(`<span class="agy-sub-spd-sep">·</span><span class="agy-sub-spd-ttft">${data.isHold ? 'Hold' : 'TTFT'} ${data.ttft.toFixed(1)}s</span>`);
    }
    if (!parts.length && data.running) {
      parts.push(`<span class="agy-sub-spd-num">${esc(L('生成中…', 'Working…'))}</span>`);
    }
    el.hidden = parts.length === 0;
    if (el.hidden) return;
    const sig = `${parts.join('')}|${tier}|${motion}`;
    if (el.getAttribute('data-sig') !== sig) {
      el.setAttribute('data-sig', sig);
      el.setAttribute('data-agy-speed-tier', tier);
      el.setAttribute('data-agy-motion', motion);
      el.innerHTML = `<span class="agy-sub-sdot" aria-hidden="true"></span><span class="agy-sub-stxt">${parts.join('')}</span>`;
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

    const footerW = Math.round(footer.getBoundingClientRect().width);
    const isXs = footerW > 0 && footerW < 420;

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
    renderSubCtxPill(ensurePill('ctx', 'agy-sub-ctx'), data, isXs);
    renderSubSpeedPill(ensurePill('speed', 'agy-sub-speed'), data);
  }

  function sync() {
    if (disposed) return;
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
