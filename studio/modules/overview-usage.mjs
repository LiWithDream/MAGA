/**
 * Internalized Daily & Per-Model Token Usage Card for MAGA's Right Overview Panel.
 * Features:
 * - Slim, baseline-anchored stacked bars across Day (14d), Week (12w), and Month (12m)
 * - Instant floating interactive hover tooltip across chart bars, KPI tiles, and model rows
 * - Incremental SQLite usage history via unified daemon's getUsageStats action
 */

import { markOwn } from '../core/dom.mjs';
import { isZhUi, L } from '../core/env.mjs';
import {
  SPANS,
  esc,
  fmtTokens,
  localDay,
  computeTotals,
  createModelColorResolver,
  buildChevronSvg,
  buildRefreshIconSvg,
  buildUsageBodyHtml,
  createSharedUsageTooltip,
} from './usage-card-core.mjs';

export function createOverviewUsageRuntime({ motionThemes, studioPrefs } = {}) {
  const CARD_ID = 'agy-ov-usage-card';
  const STORAGE_KEY = 'agy_studio_usage_ui_v1';
  const CACHE_TTL_MS = 25000;

  let disposed = false;
  let cardEl = null;
  let usageData = null;
  let fetchInFlight = false;
  let lastFetchTs = 0;
  let lastRenderCtx = null;
  const lastTurnSigByCid = new Map();
  const colorForModel = createModelColorResolver(motionThemes);
  const tooltip = createSharedUsageTooltip();

  const defaultPeriodPref = () => {
    const p = studioPrefs?.get?.()?.overviewUsageDefaultPeriod;
    return SPANS[p] ? p : 'day';
  };
  let lastDefaultPeriod = defaultPeriodPref();
  let lastIsZh = isZhUi();
  const uiState = loadUiState();

  function loadUiState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        open: typeof parsed.open === 'boolean' ? parsed.open : true,
        period: SPANS[parsed.period] ? parsed.period : defaultPeriodPref(),
        shift: 0,
      };
    } catch {
      return { open: true, period: defaultPeriodPref(), shift: 0 };
    }
  }

  function saveUiState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: uiState.open, period: uiState.period }));
    } catch {}
  }

  const offStudioPrefs = studioPrefs?.subscribe?.((nextPrefs) => {
    if (disposed) return;
    if (nextPrefs.overviewUsageEnabled === false) {
      tooltip.hide();
      if (cardEl) {
        try { cardEl.remove(); } catch {}
        cardEl = null;
      }
      return;
    }
    const nextDef = SPANS[nextPrefs.overviewUsageDefaultPeriod] ? nextPrefs.overviewUsageDefaultPeriod : 'day';
    let needRerender = false;
    if (nextDef !== lastDefaultPeriod) {
      lastDefaultPeriod = nextDef;
      uiState.period = nextDef;
      uiState.shift = 0;
      saveUiState();
      needRerender = true;
    }
    const curZh = isZhUi();
    if (curZh !== lastIsZh) {
      lastIsZh = curZh;
      needRerender = true;
    }
    if (needRerender && cardEl) renderCard();
    sync();
  });

  function renderCard() {
    if (!cardEl) return;
    tooltip.hide();
    const today = localDay();
    let todayTotals = usageData ? computeTotals(usageData, today) : null;
    let bodyHtml = '';
    if (uiState.open) {
      const res = buildUsageBodyHtml({
        data: usageData,
        today,
        period: uiState.period,
        shift: uiState.shift,
        colorForModel,
      });
      todayTotals = res.totals;
      lastRenderCtx = res.renderCtx;
      bodyHtml = res.bodyHtml;
    }
    const todayBadge = usageData && todayTotals ? `${L('今日', 'Today')} ${fmtTokens(todayTotals.today)}` : L('读取中…', 'Loading…');

    cardEl.innerHTML = `<div class="ag-ov-card-hdr">
      <button type="button" class="ag-ov-hdr-toggle" data-agy-usage-action="toggle">
        ${buildChevronSvg(uiState.open)}
        <span>${esc(L('用量统计', 'Token Usage'))}</span>
      </button>
      <div class="agy-usage-hdr-right">
        <span class="ag-ov-muted ag-ov-tabular">${esc(todayBadge)}</span>
        <button type="button" class="ag-ov-icon-btn" data-agy-usage-action="refresh" title="${esc(L('刷新用量统计', 'Refresh usage stats'))}" aria-label="${esc(L('刷新用量统计', 'Refresh usage stats'))}">
          ${buildRefreshIconSvg(fetchInFlight)}
        </button>
      </div>
    </div>${bodyHtml}`;
  }

  function ensureCardElement() {
    if (cardEl) return cardEl;
    cardEl = document.createElement('section');
    cardEl.id = CARD_ID;
    cardEl.className = 'ag-ov-card agy-usage-card';
    markOwn(cardEl);
    cardEl.setAttribute('data-ov-card', 'usage');
    cardEl.setAttribute('data-ag-i18n-ignore', '1');

    cardEl.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button');
      if (!btn || !cardEl.contains(btn)) return;
      const action = btn.getAttribute('data-agy-usage-action');
      if (action === 'toggle') {
        uiState.open = !uiState.open;
        saveUiState();
        renderCard();
        if (uiState.open && !usageData) fetchUsage(false);
        return;
      }
      if (action === 'refresh') {
        fetchUsage(true);
        return;
      }
      const period = btn.getAttribute('data-agy-usage-period');
      if (period && SPANS[period]) {
        uiState.period = period;
        uiState.shift = 0;
        saveUiState();
        renderCard();
        return;
      }
      const shiftDelta = Number(btn.getAttribute('data-agy-usage-shift'));
      if (Number.isFinite(shiftDelta) && shiftDelta !== 0) {
        uiState.shift = Math.min(0, uiState.shift + shiftDelta);
        renderCard();
      }
    });

    tooltip.bindCardInteractions(cardEl, () => lastRenderCtx);
    renderCard();
    return cardEl;
  }

  function fetchUsage(force = false) {
    if (disposed || fetchInFlight) return;
    if (typeof window.__agProjectCall !== 'function') return;
    const now = Date.now();
    if (!force && usageData && now - lastFetchTs < CACHE_TTL_MS) return;

    fetchInFlight = true;
    renderCard();
    const activeId = window.__ag_last_metrics?.cascadeId || '';
    Promise.resolve(window.__agProjectCall('getUsageStats', { force, activeId }, 12000))
      .then((res) => {
        if (disposed) return;
        if (res && res.ok) {
          usageData = res;
          lastFetchTs = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => {
        fetchInFlight = false;
        if (!disposed) renderCard();
      });
  }

  function anchorCardInSections(sections) {
    if (!sections) return;
    const el = ensureCardElement();
    const quotaCard = sections.querySelector(':scope > [data-ov-card="quota"]');
    if (quotaCard) {
      if (el.parentElement !== sections || quotaCard.nextElementSibling !== el) {
        quotaCard.insertAdjacentElement('afterend', el);
      }
    } else if (el.parentElement !== sections) {
      sections.appendChild(el);
    }
  }

  const onOverviewRendered = () => {
    if (disposed || studioPrefs?.get?.()?.overviewUsageEnabled === false) return;
    const sections = document.getElementById('ag-claude-ov-sections');
    if (sections && sections.isConnected) {
      anchorCardInSections(sections);
    }
  };
  window.addEventListener('agy:overview-rendered', onOverviewRendered);

  function read(snapshot = null) {
    if (disposed) return null;
    const enabled = studioPrefs?.get?.()?.overviewUsageEnabled !== false;
    if (!enabled) return { enabled: false };
    const overviewOpen = snapshot
      ? snapshot.overviewOpen
      : (() => {
          const panel = document.querySelector('[data-testid="overview-panel"]');
          return Boolean(panel && !panel.hidden && panel.getAttribute('aria-hidden') !== 'true');
        })();
    if (!overviewOpen) return { enabled: true, overviewOpen: false };
    const sections = document.getElementById('ag-claude-ov-sections');
    const curZh = snapshot ? snapshot.isZh : isZhUi();
    const metrics = snapshot ? snapshot.metrics : (typeof window !== 'undefined' ? window.__ag_last_metrics || null : null);
    return { enabled: true, overviewOpen: true, sections, curZh, metrics, now: snapshot ? snapshot.now : Date.now() };
  }

  function write(snapshot = null, planArg = undefined) {
    if (disposed) return;
    const plan = planArg !== undefined ? planArg : read(snapshot);
    if (!plan) return;
    if (!plan.enabled) {
      tooltip.hide();
      if (cardEl) {
        try { cardEl.remove(); } catch {}
        cardEl = null;
      }
      return;
    }
    if (!plan.overviewOpen) {
      tooltip.hide();
      return;
    }
    if (plan.curZh !== lastIsZh) {
      lastIsZh = plan.curZh;
      if (cardEl) renderCard();
    }
    if (!plan.sections) return;

    anchorCardInSections(plan.sections);

    const m = plan.metrics;
    let turnChanged = false;
    if (m?.hasData && m?.stats) {
      const cid = String(m.cascadeId || '_default');
      const turnSig = `${m.stats.calls || 0}:${m.stats.turns || 0}:${m.stats.childCalls || 0}`;
      const prevSig = lastTurnSigByCid.get(cid);
      if (prevSig === undefined) {
        lastTurnSigByCid.set(cid, turnSig);
        if (m.stats.calls > 0 || m.stats.turns > 0) turnChanged = !usageData;
      } else if (prevSig !== turnSig) {
        lastTurnSigByCid.set(cid, turnSig);
        turnChanged = true;
      }
    }

    if (!usageData || turnChanged || plan.now - lastFetchTs >= CACHE_TTL_MS) {
      fetchUsage(turnChanged);
    }
  }

  function sync() {
    if (disposed) return;
    write(null, read(null));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    offStudioPrefs?.();
    window.removeEventListener('agy:overview-rendered', onOverviewRendered);
    tooltip.dispose();
    if (cardEl) {
      try { cardEl.remove(); } catch {}
      cardEl = null;
    }
  }

  return {
    topics: ['overview', 'route', 'metrics', 'prefs'],
    read,
    write,
    sync,
    dispose,
  };
}
