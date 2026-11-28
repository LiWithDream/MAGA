/**
 * Per-Project Token Usage Card & Grid Badge Runtime (#agy-pd-usage-card & .ag-proj-card-usage).
 * Reuses shared aggregation/chart/tooltip core from usage-card-core.mjs with zero extra disk scans
 * and zero background polling (on-demand per open/refresh via unified daemon getUsageStats).
 */
import { markOwn, setAttr, setStyle } from '../core/dom.mjs';
import { isZhUi, L } from '../core/env.mjs';
import {
  SPANS,
  esc,
  fmtTokens,
  exact,
  localDay,
  reqFmt,
  computeTotals,
  createModelColorResolver,
  buildChevronSvg,
  buildRefreshIconSvg,
  formatShareLabel,
  buildUsageBodyHtml,
  createSharedUsageTooltip,
} from './usage-card-core.mjs';

export function classifyUsageTier(totalTokens) {
  const n = Number(totalTokens || 0);
  if (!Number.isFinite(n) || n <= 0) return 'none';
  if (n < 1_000_000) return 'light';
  if (n < 50_000_000) return 'mid';
  if (n < 500_000_000) return 'heavy';
  return 'flagship';
}

export function computeLogUsageRatio(totalTokens, maxTokens) {
  const v = Number(totalTokens || 0);
  const m = Number(maxTokens || 0);
  if (!Number.isFinite(v) || !Number.isFinite(m) || v <= 0 || m <= 0) return 0;
  const num = Math.log10(v / 1000 + 1);
  const den = Math.log10(m / 1000 + 1);
  if (!(den > 0)) return 0;
  return Math.max(0.08, Math.min(1, Number((num / den).toFixed(3))));
}

export function createProjectUsageRuntime({ motionThemes, studioPrefs } = {}) {
  const CARD_ID = 'agy-pd-usage-card';
  const SLOT_ID = 'agy-pd-usage-slot';
  const HERO_BADGE_ID = 'agy-pd-hero-usage';
  const STORAGE_KEY = 'agy_studio_project_usage_ui_v1';
  const CACHE_TTL_MS = 25000;
  const EMPTY_DATA = Object.freeze({
    ok: true,
    days: [],
    undated: { requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    globalTotalTokens: 0,
  });

  let disposed = false;
  let detailCardEl = null;
  let lastRenderCtx = null;
  let activeDetailKey = '';
  let activeProjectId = '';

  const detailCache = new Map();
  const detailInFlight = new Set();
  const gridCache = {
    byProject: Object.create(null),
    sigByProj: new Map(),
    ts: 0,
  };
  let gridInFlightSig = '';
  let gridReqSeq = 0;

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

  function readActiveDetailTarget() {
    const view = document.getElementById('ag-claude-projects-view');
    if (!view || view.getAttribute('data-open') !== 'true') return null;
    const slot = view.querySelector(`#${SLOT_ID}`);
    if (!slot) return null;
    const projectId = slot.getAttribute('data-ag-pd-proj-id') || '';
    const rawChatIds = slot.getAttribute('data-ag-pd-chat-ids') || '';
    const chatIds = rawChatIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      view,
      slot,
      projectId,
      rawChatIds,
      chatIds,
      cacheKey: `${projectId}|${rawChatIds}`,
    };
  }

  function ensureDetailCard(slot) {
    if (!detailCardEl) {
      detailCardEl = document.createElement('section');
      detailCardEl.id = CARD_ID;
      detailCardEl.className = 'ag-pd-usage-card agy-usage-card';
      markOwn(detailCardEl);
      detailCardEl.setAttribute('data-ag-i18n-ignore', '1');

      detailCardEl.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button');
        if (!btn || !detailCardEl.contains(btn)) return;
        const target = readActiveDetailTarget();
        const action = btn.getAttribute('data-agy-usage-action');
        if (action === 'toggle') {
          uiState.open = !uiState.open;
          saveUiState();
          if (target) {
            renderDetailCard(target);
            if (uiState.open && target.chatIds.length > 0 && !detailCache.has(target.cacheKey)) {
              fetchDetailUsage(target, false);
            }
          }
          return;
        }
        if (action === 'refresh') {
          if (target) fetchDetailUsage(target, true);
          return;
        }
        const period = btn.getAttribute('data-agy-usage-period');
        if (period && SPANS[period]) {
          uiState.period = period;
          uiState.shift = 0;
          saveUiState();
          if (target) renderDetailCard(target);
          return;
        }
        const shiftDelta = Number(btn.getAttribute('data-agy-usage-shift'));
        if (Number.isFinite(shiftDelta) && shiftDelta !== 0) {
          uiState.shift = Math.min(0, uiState.shift + shiftDelta);
          if (target) renderDetailCard(target);
        }
      });

      tooltip.bindCardInteractions(detailCardEl, () => lastRenderCtx);
    }

    if (detailCardEl.parentElement !== slot) {
      slot.textContent = '';
      slot.appendChild(detailCardEl);
    }
    return detailCardEl;
  }

  function syncChatUsageBadges(view, byChat) {
    if (!view) return;
    const badges = view.querySelectorAll('.ag-pd-chat-row [data-ag-pd-chat-usage]');
    for (const badge of badges) {
      markOwn(badge);
      const cid = badge.getAttribute('data-ag-pd-chat-usage') || '';
      const entry = cid && byChat ? byChat[cid] : null;
      if (!entry || !entry.totalTokens) {
        badge.hidden = true;
        if (badge.textContent) badge.textContent = '';
        continue;
      }
      const nextText = fmtTokens(entry.totalTokens);
      if (badge.textContent !== nextText) badge.textContent = nextText;
      setAttr(badge, 'title', `${exact(entry.totalTokens)} tokens · ${reqFmt(entry.requests || 0)}`);
      badge.hidden = false;
    }
  }

  function syncHeroBadge(view, data, totals) {
    const badge = view?.querySelector?.(`#${HERO_BADGE_ID}`);
    if (!badge) return;
    markOwn(badge);
    if (!data || !totals || totals.all <= 0) {
      badge.hidden = true;
      if (badge.textContent) badge.textContent = '';
      return;
    }
    const globalTotal = Number(data.globalTotalTokens || 0);
    const sharePct = globalTotal > 0 ? (totals.all / globalTotal) * 100 : null;
    const shareLbl = sharePct !== null ? formatShareLabel(sharePct) : '';
    const nextText = `${L('用量', 'Usage')} ${fmtTokens(totals.all)}`;
    if (badge.textContent !== nextText) badge.textContent = nextText;
    const tipTitle = `${L('项目累计用量', 'Project total')}: ${exact(totals.all)} tokens · ${reqFmt(totals.parts.all.requests)}${
      shareLbl ? ` (${L('占全局', 'of all')} ${shareLbl})` : ''
    }`;
    setAttr(badge, 'title', tipTitle);
    badge.hidden = false;
  }

  function renderDetailCard(target) {
    if (!target || disposed) return;
    tooltip.hide();
    const card = ensureDetailCard(target.slot);
    const isEmptyChats = target.chatIds.length === 0;
    const cached = isEmptyChats ? { data: EMPTY_DATA } : detailCache.get(target.cacheKey);
    const data = cached?.data || null;
    const busy = detailInFlight.has(target.cacheKey);
    const today = localDay();
    const totals = data ? computeTotals(data, today) : null;
    const globalTotal = Number(data?.globalTotalTokens || 0);
    const shareOfGlobalPct = data && totals && totals.all > 0 && globalTotal > 0 ? (totals.all / globalTotal) * 100 : null;

    let bodyHtml = '';
    if (uiState.open) {
      const res = buildUsageBodyHtml({
        data,
        today,
        period: uiState.period,
        shift: uiState.shift,
        colorForModel,
        loadingText: L('正在汇总本项目用量…', 'Aggregating project token usage…'),
        emptyText: isEmptyChats
          ? L('本项目暂无对话用量，发起对话后将自动统计', 'No usage for this project yet. Start a chat to track tokens.')
          : L('所选对话暂无 Token 用量记录', 'No token usage recorded for this project yet.'),
        shareOfGlobalPct,
      });
      lastRenderCtx = res.renderCtx;
      bodyHtml = res.bodyHtml;
    } else {
      lastRenderCtx = null;
    }

    let badgeText = L('读取中…', 'Loading…');
    if (data && totals) {
      if (totals.today > 0) badgeText = `${L('今日', 'Today')} ${fmtTokens(totals.today)}`;
      else if (totals.all > 0) badgeText = `${L('累计', 'All')} ${fmtTokens(totals.all)}`;
      else badgeText = L('暂无', 'Empty');
    }

    const shareLabel = shareOfGlobalPct !== null ? formatShareLabel(shareOfGlobalPct) : '';
    const sharePillHtml = shareLabel ? `<span class="agy-usage-share-pill">${esc(shareLabel)}</span>` : '';

    setAttr(card, 'data-empty', isEmptyChats || (data && totals?.all === 0) ? 'true' : 'false');
    card.innerHTML = `<div class="ag-ov-card-hdr">
      <button type="button" class="ag-ov-hdr-toggle" data-agy-usage-action="toggle">
        ${buildChevronSvg(uiState.open)}
        <span>${esc(L('项目用量', 'Project Usage'))}</span>
      </button>
      <div class="agy-usage-hdr-right">
        ${sharePillHtml}
        <span class="ag-ov-muted ag-ov-tabular">${esc(badgeText)}</span>
        ${
          isEmptyChats
            ? ''
            : `<button type="button" class="ag-ov-icon-btn" data-agy-usage-action="refresh" title="${esc(L('刷新项目用量', 'Refresh project usage'))}" aria-label="${esc(L('刷新项目用量', 'Refresh project usage'))}">${buildRefreshIconSvg(busy)}</button>`
        }
      </div>
    </div>${bodyHtml}`;

    syncHeroBadge(target.view, data, totals);
    syncChatUsageBadges(target.view, data?.byChat);
  }

  function fetchDetailUsage(target, force = false) {
    if (disposed || !target || target.chatIds.length === 0) return;
    if (typeof window.__agProjectCall !== 'function') return;
    const { cacheKey, chatIds } = target;
    if (detailInFlight.has(cacheKey)) return;
    const now = Date.now();
    const cached = detailCache.get(cacheKey);
    if (!force && cached && now - cached.ts < CACHE_TTL_MS) return;

    detailInFlight.add(cacheKey);
    const liveBefore = readActiveDetailTarget();
    if (liveBefore && liveBefore.cacheKey === cacheKey) renderDetailCard(liveBefore);

    const activeId = window.__ag_last_metrics?.cascadeId || '';
    Promise.resolve(window.__agProjectCall('getUsageStats', { conversationIds: chatIds, force, activeId }, 12000))
      .then((res) => {
        if (disposed) return;
        if (res && res.ok) {
          if (!detailCache.has(cacheKey) && detailCache.size >= 32) {
            detailCache.delete(detailCache.keys().next().value);
          }
          detailCache.set(cacheKey, { data: res, ts: Date.now() });
        }
      })
      .catch(() => {})
      .finally(() => {
        detailInFlight.delete(cacheKey);
        if (disposed) return;
        const liveAfter = readActiveDetailTarget();
        if (liveAfter && liveAfter.cacheKey === cacheKey) renderDetailCard(liveAfter);
      });
  }

  function applyGridBadges(view) {
    const cards = Array.from(view.querySelectorAll('.ag-proj-card[data-ag-proj-id]'));
    let maxTokens = 0;
    let sumTokens = 0;
    for (const card of cards) {
      const pid = card.getAttribute('data-ag-proj-id') || '';
      const entry = pid ? gridCache.byProject[pid] : null;
      const tot = Number(entry?.totalTokens || 0);
      if (tot > 0) {
        sumTokens += tot;
        if (tot > maxTokens) maxTokens = tot;
      }
    }

    for (const card of cards) {
      const pid = card.getAttribute('data-ag-proj-id') || '';
      const badge = card.querySelector(`[data-ag-proj-usage-badge]`);
      const entry = pid ? gridCache.byProject[pid] : null;
      const tot = Number(entry?.totalTokens || 0);
      const tier = classifyUsageTier(tot);
      const ratio = computeLogUsageRatio(tot, maxTokens);
      setAttr(card, 'data-usage-tier', tier);
      setStyle(card, '--ag-usage-ratio', String(ratio));
      if (!badge) continue;
      markOwn(badge);
      setAttr(badge, 'data-usage-tier', tier);
      if (!entry || !tot) {
        badge.hidden = true;
        if (badge.textContent) badge.textContent = '';
        continue;
      }
      const nextText = fmtTokens(tot);
      if (badge.textContent !== nextText) badge.textContent = nextText;
      const sharePct = sumTokens > 0 ? (tot / sumTokens) * 100 : null;
      const shareLbl = sharePct !== null ? formatShareLabel(sharePct) : '';
      setAttr(
        badge,
        'title',
        `${exact(tot)} tokens · ${reqFmt(entry.requests || 0)}${shareLbl ? ` (${L('占比', 'share')} ${shareLbl})` : ''}`
      );
      badge.hidden = false;
    }

    const totalEl = view.querySelector('[data-ag-proj-total-usage]');
    if (totalEl) {
      markOwn(totalEl);
      if (sumTokens > 0) {
        const nextTotal = `${L('累计', 'Total')} ${fmtTokens(sumTokens)} tokens`;
        if (totalEl.textContent !== nextTotal) totalEl.textContent = nextTotal;
        setAttr(totalEl, 'title', `${exact(sumTokens)} tokens`);
        totalEl.hidden = false;
      } else {
        totalEl.hidden = true;
        if (totalEl.textContent) totalEl.textContent = '';
      }
    }
  }

  function syncGridUsage(view, now) {
    tooltip.hide();
    activeDetailKey = '';
    activeProjectId = '';

    const cards = view.querySelectorAll('.ag-proj-card[data-ag-proj-id]');
    if (!cards.length) return;

    const projectGroups = {};
    const sigParts = [];
    let hasAnyIds = false;
    let missingOrChanged = false;
    for (const card of cards) {
      const pid = card.getAttribute('data-ag-proj-id') || '';
      if (!pid) continue;
      const rawIds = card.getAttribute('data-ag-proj-chat-ids') || '';
      const chatIds = rawIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const joined = chatIds.join(',');
      projectGroups[pid] = chatIds;
      sigParts.push(`${pid}:${joined}`);
      if (chatIds.length > 0) {
        hasAnyIds = true;
        if (gridCache.sigByProj.get(pid) !== joined) missingOrChanged = true;
      } else {
        gridCache.byProject[pid] = { totalTokens: 0, requests: 0 };
        gridCache.sigByProj.set(pid, '');
      }
    }

    applyGridBadges(view);

    if (!hasAnyIds || typeof window.__agProjectCall !== 'function') return;
    const stale = now - gridCache.ts >= CACHE_TTL_MS;
    if (!missingOrChanged && !stale) return;

    sigParts.sort();
    const sig = sigParts.join('|');
    if (gridInFlightSig === sig) return;
    gridInFlightSig = sig;
    const seq = ++gridReqSeq;

    const activeId = window.__ag_last_metrics?.cascadeId || '';
    Promise.resolve(window.__agProjectCall('getUsageStats', { projectGroups, activeId }, 12000))
      .then((res) => {
        if (disposed || seq !== gridReqSeq || !res || !res.ok || !res.byProject) return;
        for (const [pid, stat] of Object.entries(res.byProject)) {
          gridCache.byProject[pid] = stat;
        }
        for (const [pid, ids] of Object.entries(projectGroups)) {
          gridCache.sigByProj.set(pid, ids.join(','));
        }
        gridCache.ts = Date.now();
        try {
          const Ctor = window.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
          if (Ctor) {
            window.dispatchEvent(new Ctor('agy:projects-usage-updated', { detail: { byProject: { ...gridCache.byProject } } }));
          }
        } catch {}
        const curView = document.getElementById('ag-claude-projects-view');
        if (curView && curView.getAttribute('data-open') === 'true' && !curView.querySelector(`#${SLOT_ID}`)) {
          applyGridBadges(curView);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (seq === gridReqSeq && gridInFlightSig === sig) gridInFlightSig = '';
      });
  }

  const offStudioPrefs = studioPrefs?.subscribe?.((nextPrefs) => {
    if (disposed) return;
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
    if (needRerender) {
      const target = readActiveDetailTarget();
      if (target) renderDetailCard(target);
    }
    sync();
  });

  function read(snapshot = null) {
    if (disposed) return null;
    const view = document.getElementById('ag-claude-projects-view');
    const open = Boolean(view && view.getAttribute('data-open') === 'true');
    if (!open) return { open: false };
    const slot = view.querySelector(`#${SLOT_ID}`);
    const hasGrid = !slot && Boolean(view.querySelector('.ag-proj-grid'));
    const curZh = snapshot ? snapshot.isZh : isZhUi();
    return { open: true, view, slot, hasGrid, curZh, now: snapshot ? snapshot.now : Date.now() };
  }

  function write(snapshot = null, planArg = undefined) {
    if (disposed) return;
    const plan = planArg !== undefined ? planArg : read(snapshot);
    if (!plan) return;
    const langChanged = typeof plan.curZh === 'boolean' && plan.curZh !== lastIsZh;
    if (langChanged) {
      lastIsZh = plan.curZh;
    }
    if (!plan.open) {
      tooltip.hide();
      activeDetailKey = '';
      activeProjectId = '';
      return;
    }
    if (plan.slot) {
      const projectId = plan.slot.getAttribute('data-ag-pd-proj-id') || '';
      const rawChatIds = plan.slot.getAttribute('data-ag-pd-chat-ids') || '';
      const chatIds = rawChatIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const cacheKey = `${projectId}|${rawChatIds}`;
      if (projectId !== activeProjectId) {
        activeProjectId = projectId;
        uiState.shift = 0;
      }
      const target = { view: plan.view, slot: plan.slot, projectId, rawChatIds, chatIds, cacheKey };
      const cached = detailCache.get(cacheKey);
      const needsRender =
        langChanged ||
        cacheKey !== activeDetailKey ||
        !detailCardEl ||
        detailCardEl.parentElement !== plan.slot ||
        !detailCardEl.isConnected;
      activeDetailKey = cacheKey;
      if (needsRender) renderDetailCard(target);
      else syncChatUsageBadges(plan.view, (chatIds.length === 0 ? EMPTY_DATA : cached?.data)?.byChat);
      if (chatIds.length > 0 && (!cached || plan.now - cached.ts >= CACHE_TTL_MS)) {
        fetchDetailUsage(target, false);
      }
      return;
    }
    if (plan.hasGrid) {
      syncGridUsage(plan.view, plan.now);
    }
  }

  function sync() {
    if (disposed) return;
    write(null, read(null));
  }

  const onProjectsRendered = () => sync();
  const onProjectUsageRefresh = () => {
    if (disposed) return;
    const target = readActiveDetailTarget();
    if (target && target.chatIds.length > 0) fetchDetailUsage(target, true);
  };
  window.addEventListener('agy:projects-rendered', onProjectsRendered);
  window.addEventListener('agy:project-usage-refresh', onProjectUsageRefresh);

  function dispose() {
    if (disposed) return;
    disposed = true;
    gridReqSeq += 1;
    gridInFlightSig = '';
    offStudioPrefs?.();
    window.removeEventListener('agy:projects-rendered', onProjectsRendered);
    window.removeEventListener('agy:project-usage-refresh', onProjectUsageRefresh);
    tooltip.dispose();
    if (detailCardEl) {
      try { detailCardEl.remove(); } catch {}
      detailCardEl = null;
    }
  }

  return {
    topics: ['composer', 'route', 'prefs'],
    read,
    write,
    sync,
    dispose,
  };
}
