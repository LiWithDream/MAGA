/**
 * Shared token usage aggregation, Day/Week/Month stacked chart renderer,
 * and floating hover tooltip reused by Overview Usage and Project Detail Usage cards.
 */
import { markOwn } from '../core/dom.mjs';
import { isZhUi, L } from '../core/env.mjs';

export const TOOLTIP_ID = 'agy-usage-tooltip';
export const COUNTERS = ['uncached', 'cacheRead', 'cacheWrite', 'output'];
export const SPANS = { day: 14, week: 12, month: 12 };
export const KPI_TO_PERIOD = Object.freeze({ today: 'day', week: 'week', month: 'month' });
export const FALLBACK_PALETTE = ['#388bfd', '#e07b53', '#16a34a', '#d97706', '#8b5cf6', '#e14d67'];

const TIER_LABEL = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium',
  high: 'High', xhigh: 'XHigh', extra: 'Extra', max: 'Max', thinking: 'Thinking',
};
const PAREN_TIER_RE = /^(.*?)\s*\((?:thinking[\s,/-]+)?(off|minimal|low|medium|high|xhigh|extra|max)(?:\s+thinking)?\)$/i;
const PAREN_THINK_RE = /^(.*?)\s*\((thinking)\)$/i;
const SLUG_TIER_RE = /^([^\s()]+?)(?:-thinking)?-(off|minimal|low|medium|high|xhigh|extra|max)(?:-thinking)?$/i;
const SLUG_THINK_RE = /^([^\s()]+)-(thinking)$/i;

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtTokens(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 10e9 ? 1 : 2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 100e6 ? 0 : v >= 10e6 ? 1 : 2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 100e3 ? 0 : 1)}k`;
  return String(Math.round(v));
}

export const exact = (v) => Number(v || 0).toLocaleString('en-US');
const pad = (v) => String(v).padStart(2, '0');
const toDate = (day) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
const toDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (day, n) => { const d = toDate(day); d.setUTCDate(d.getUTCDate() + n); return toDay(d); };
const addMonths = (month, n) => { const d = toDate(`${month}-01`); d.setUTCMonth(d.getUTCMonth() + n); return toDay(d).slice(0, 7); };
const weekStart = (day) => addDays(day, -((toDate(day).getUTCDay() + 6) % 7));
export const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const emptyParts = () => ({ requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const addParts = (t, s = {}) => { t.requests += s.requests || 0; for (const k of COUNTERS) t[k] += s[k] || 0; };
export const tokensOf = (b = {}) => (b.uncached || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0) + (b.output || 0);
export const reqFmt = (n) => (isZhUi() ? `${exact(n)} 次请求` : `${exact(n)} req`);

export function splitModelName(raw) {
  const trimmed = String(raw || '').trim().replace(/^models\//i, '').trim();
  if (!trimmed) return { key: '', family: '', tier: '', isDisplay: false };
  let family = trimmed;
  let tier = '';
  let match = PAREN_TIER_RE.exec(trimmed) || PAREN_THINK_RE.exec(trimmed);
  if (match && match[1].trim()) {
    family = match[1].trim();
    tier = TIER_LABEL[match[2].toLowerCase()] || match[2];
  } else if (!/\s/.test(trimmed)) {
    match = SLUG_TIER_RE.exec(trimmed) || SLUG_THINK_RE.exec(trimmed);
    if (match && match[1].length >= 2) {
      family = match[1];
      tier = TIER_LABEL[match[2].toLowerCase()] || match[2];
    }
  }
  return {
    key: family.toLowerCase().replace(/[\s._-]+/g, '-'),
    family,
    tier,
    isDisplay: /\s|[A-Z]/.test(family),
  };
}

export function createModelColorResolver(motionThemes) {
  return function colorForModel(name, rankIdx) {
    try {
      const c = motionThemes().dotColorFor(name || '');
      if (c && c !== '#8e8e93') return c;
    } catch {}
    return FALLBACK_PALETTE[rankIdx % FALLBACK_PALETTE.length];
  };
}

export function computeTotals(data, today) {
  const week = weekStart(today);
  const month = today.slice(0, 7);
  const parts = { today: emptyParts(), week: emptyParts(), month: emptyParts(), all: emptyParts() };
  if (data?.undated) addParts(parts.all, data.undated);
  let since = '';
  for (const day of data?.days || []) {
    addParts(parts.all, day);
    since ||= day.date;
    if (day.date > today) continue;
    if (day.date === today) addParts(parts.today, day);
    if (day.date >= week) addParts(parts.week, day);
    if (day.date.slice(0, 7) === month) addParts(parts.month, day);
  }
  return {
    today: tokensOf(parts.today),
    week: tokensOf(parts.week),
    month: tokensOf(parts.month),
    all: tokensOf(parts.all),
    since,
    parts,
  };
}

export function buildPeriodSpans(today, period, shift) {
  const count = SPANS[period] || 14;
  if (period === 'month') {
    const last = addMonths(today.slice(0, 7), count * shift);
    return Array.from({ length: count }, (_, i) => {
      const m = addMonths(last, i - count + 1);
      return {
        from: `${m}-01`,
        to: addDays(`${addMonths(m, 1)}-01`, -1),
        name: m,
        label: `${Number(m.slice(5))}`,
      };
    });
  }
  const step = period === 'week' ? 7 : 1;
  const last = addDays(period === 'week' ? weekStart(today) : today, step * count * shift);
  return Array.from({ length: count }, (_, i) => {
    const from = addDays(last, step * (i - count + 1));
    const to = addDays(from, step - 1);
    return {
      from,
      to,
      name: from === to ? from : `${from.slice(5)} – ${to.slice(5)}`,
      fullName: from === to ? from : `${from} – ${to}`,
      label: period === 'week' ? `${Number(from.slice(5, 7))}/${Number(from.slice(8))}` : String(Number(from.slice(8))),
    };
  });
}

export function computeModelView(data, today, period, shift, colorForModel, selectedIndex = null) {
  const days = (data?.days || []).filter((d) => !(d.date > today));
  const allTime = new Map();
  const familyLabel = new Map();
  for (const day of days) {
    for (const m of day.models || []) {
      const parsed = splitModelName(m.name);
      allTime.set(parsed.key, (allTime.get(parsed.key) || 0) + tokensOf(m));
      const prev = familyLabel.get(parsed.key);
      if (!prev || (parsed.isDisplay && !prev.isDisplay) || (parsed.isDisplay === prev.isDisplay && parsed.family < prev.family)) {
        familyLabel.set(parsed.key, { name: parsed.family, isDisplay: parsed.isDisplay });
      }
    }
  }
  const ranked = [...allTime].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([k]) => k);
  const MAX_SLOTS = 6;
  const slotOf = new Map(ranked.map((k, idx) => [k, Math.min(idx, MAX_SLOTS)]));

  const series = Array.from({ length: MAX_SLOTS + 1 }, (_, idx) => {
    const key = idx < MAX_SLOTS ? ranked[idx] : null;
    const labelName = key === null ? null : (key === undefined ? undefined : familyLabel.get(key)?.name ?? '');
    return {
      key,
      name: labelName,
      color: key === null ? 'rgba(142, 142, 147, 0.65)' : colorForModel(labelName, idx),
      ...emptyParts(),
      tiersMap: new Map(),
    };
  });

  const safeShift = Math.min(0, Number(shift) || 0);
  const bars = buildPeriodSpans(today, period, safeShift).map((s) => ({
    ...s,
    tokens: 0,
    ...emptyParts(),
    parts: series.map(() => 0),
  }));
  const pageParts = emptyParts();

  for (const day of days) {
    const bar = bars.find((b) => b.from <= day.date && day.date <= b.to);
    if (!bar) continue;
    for (const m of day.models || []) {
      const parsed = splitModelName(m.name);
      const slot = slotOf.get(parsed.key);
      if (slot === undefined) continue;
      const tok = tokensOf(m);
      bar.parts[slot] += tok;
      bar.tokens += tok;
      addParts(bar, m);
      addParts(pageParts, m);
    }
  }

  let activeIndex;
  if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < bars.length) {
    activeIndex = selectedIndex;
  } else if (safeShift === 0) {
    activeIndex = Math.max(0, bars.length - 1);
  } else {
    let rightmostNonEmpty = -1;
    for (let i = bars.length - 1; i >= 0; i -= 1) {
      if (bars[i].tokens > 0) {
        rightmostNonEmpty = i;
        break;
      }
    }
    activeIndex = rightmostNonEmpty >= 0 ? rightmostNonEmpty : Math.max(0, bars.length - 1);
  }

  const activeBar = bars[activeIndex] || null;
  const isCurrentBucket = safeShift === 0 && activeIndex === bars.length - 1;

  if (activeBar) {
    for (const day of days) {
      if (day.date < activeBar.from || day.date > activeBar.to) continue;
      for (const m of day.models || []) {
        const parsed = splitModelName(m.name);
        const slot = slotOf.get(parsed.key);
        if (slot === undefined) continue;
        const entry = series[slot];
        addParts(entry, m);
        if (slot < MAX_SLOTS) {
          const tb = entry.tiersMap.get(parsed.tier) || emptyParts();
          addParts(tb, m);
          entry.tiersMap.set(parsed.tier, tb);
        }
      }
    }
  }

  const models = series
    .map((e) => ({
      name: e.name,
      color: e.color,
      requests: e.requests,
      uncached: e.uncached,
      cacheRead: e.cacheRead,
      cacheWrite: e.cacheWrite,
      output: e.output,
      tokens: tokensOf(e),
      tiers: [...e.tiersMap.entries()]
        .map(([tier, b]) => ({ tier, tokens: tokensOf(b), ...b }))
        .filter((t) => t.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens),
    }))
    .filter((e) => e.tokens > 0)
    .sort((a, b) => (a.name === null) - (b.name === null) || b.tokens - a.tokens);

  const first = bars[0];
  const last = bars[bars.length - 1];
  const start = period === 'month' ? first.name : first.from.slice(5);
  const end = period === 'month' ? last.name : last.to.slice(5);
  const activeParts = activeBar
    ? {
        requests: activeBar.requests,
        uncached: activeBar.uncached,
        cacheRead: activeBar.cacheRead,
        cacheWrite: activeBar.cacheWrite,
        output: activeBar.output,
      }
    : emptyParts();

  return {
    bars,
    series,
    max: Math.max(...bars.map((b) => b.tokens), 0),
    activeIndex,
    activeBar,
    isCurrentBucket,
    tokens: activeBar ? activeBar.tokens : 0,
    requests: activeBar ? activeBar.requests : 0,
    parts: activeParts,
    windowTokens: tokensOf(pageParts),
    windowRequests: pageParts.requests,
    windowParts: pageParts,
    models,
    range: `${start} – ${end}`,
    older: days.length > 0 && first.from > days[0].date,
    newer: safeShift < 0,
  };
}

export function resolveUsageInteraction(targetEl, cardEl) {
  if (!targetEl || (cardEl && !cardEl.contains(targetEl))) return null;
  const btn = targetEl.closest?.('button');
  if (btn && (!cardEl || cardEl.contains(btn))) {
    const action = btn.getAttribute('data-agy-usage-action');
    if (action === 'toggle') return { type: 'toggle' };
    if (action === 'refresh') return { type: 'refresh' };
    if (action === 'reset-current') return { type: 'reset' };
    const period = btn.getAttribute('data-agy-usage-period');
    if (period && SPANS[period]) return { type: 'period', period };
    const kpiKey = btn.getAttribute('data-agy-usage-kpi');
    if (kpiKey && KPI_TO_PERIOD[kpiKey]) return { type: 'kpi', period: KPI_TO_PERIOD[kpiKey] };
    const shiftRaw = btn.getAttribute('data-agy-usage-shift');
    if (shiftRaw !== null) {
      const delta = Number(shiftRaw);
      if (Number.isFinite(delta) && delta !== 0) return { type: 'shift', delta };
    }
    return null;
  }
  const barEl = targetEl.closest?.('[data-agy-usage-bar]');
  if (barEl && (!cardEl || cardEl.contains(barEl))) {
    const index = Number(barEl.getAttribute('data-agy-usage-bar'));
    if (Number.isInteger(index) && index >= 0) return { type: 'bar', index };
  }
  return null;
}

export function buildChevronSvg(open) {
  return `<svg class="ag-ov-chev" data-open="${open ? 'true' : 'false'}" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5L8 6L4.5 9.5"/></svg>`;
}

export function buildRefreshIconSvg(spinning) {
  return `<svg class="${spinning ? 'ag-ov-spinning' : ''}" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.35-3.6M13.5 2.5v2.9h-2.9"/></svg>`;
}

export function formatShareLabel(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) return '';
  if (pct < 1) return '<1%';
  return `${Math.min(100, Math.round(pct))}%`;
}

export function buildUsageBodyHtml({
  data,
  today,
  period,
  shift,
  selectedBarIdx = null,
  colorForModel,
  emptyText,
  loadingText,
  shareOfGlobalPct = null,
}) {
  const totals = computeTotals(data, today);
  if (!data) {
    return {
      totals,
      renderCtx: null,
      bodyHtml: `<div class="ag-ov-card-body"><div class="agy-usage-empty">${esc(loadingText || L('正在统计本机对话用量…', 'Scanning local conversations…'))}</div></div>`,
    };
  }
  if (!(data.days || []).length && !totals.all) {
    return {
      totals,
      renderCtx: null,
      bodyHtml: `<div class="ag-ov-card-body"><div class="agy-usage-empty">${esc(emptyText || L('暂无用量记录', 'No usage recorded yet'))}</div></div>`,
    };
  }

  const view = computeModelView(data, today, period, shift, colorForModel, selectedBarIdx);
  const nameOf = (e) => (e.name === null ? L('其他模型', 'Other') : e.name || L('未知模型', 'Unknown'));
  const renderCtx = { totals, view, nameOf };
  const zh = isZhUi();

  const kpi = (key, label, val) => {
    const isActive = view.isCurrentBucket && KPI_TO_PERIOD[key] === period;
    return `<button type="button" class="agy-usage-kpi" data-agy-usage-kpi="${key}" data-agy-tip-kpi="${key}" aria-pressed="${isActive ? 'true' : 'false'}"><span class="agy-usage-kpi-lbl">${esc(label)}</span><span class="agy-usage-kpi-val">${esc(fmtTokens(val))}</span></button>`;
  };

  const stride = period === 'week' ? 3 : 2;
  const barsHtml = view.bars
    .map((item, idx) => {
      const pct = view.max > 0 && item.tokens > 0 ? Math.max(7, Math.round((item.tokens / view.max) * 100)) : 0;
      const colHtml = item.tokens
        ? `<div class="agy-usage-bar-stack" style="height:${pct}%">${item.parts
            .map((tok, sIdx) =>
              tok
                ? `<i style="flex:${Math.max(1, Math.round((tok / item.tokens) * 1000))} 0 0;background:${view.series[sIdx].color}"></i>`
                : ''
            )
            .join('')}</div>`
        : `<span class="agy-usage-bar-zero"></span>`;
      const showX = (view.bars.length - 1 - idx) % stride === 0;
      const xLabel = showX
        ? (period === 'month' && zh ? `${item.label}月` : item.label)
        : '';
      const isActive = idx === view.activeIndex;
      const barAria = item.fullName || item.name || '';
      return `<div class="agy-usage-bar" role="button" tabindex="0" data-agy-usage-bar="${idx}" data-agy-tip-bar="${idx}" aria-label="${esc(barAria)}" aria-pressed="${isActive ? 'true' : 'false'}"${isActive ? ' data-agy-active="1"' : ''}><div class="agy-usage-bar-track">${colHtml}</div><span class="agy-usage-bar-x">${esc(xLabel)}</span></div>`;
    })
    .join('');

  const activeBar = view.activeBar;
  let breakdownTitle = '';
  let breakdownRightHtml = '';
  if (view.isCurrentBucket) {
    breakdownTitle = period === 'day'
      ? L('今日明细', 'Today')
      : period === 'week'
        ? L('本周明细', 'This Week')
        : L('本月明细', 'This Month');
    const currentDateMeta = activeBar
      ? (period === 'day' ? activeBar.from.slice(5) : activeBar.name)
      : '';
    if (currentDateMeta) {
      breakdownRightHtml = `<span class="agy-usage-breakdown-meta">${esc(currentDateMeta)}</span>`;
    }
  } else {
    const slotTag = activeBar
      ? (period === 'day' ? (zh ? activeBar.from.slice(5) : activeBar.from) : activeBar.name)
      : '';
    breakdownTitle = slotTag
      ? (zh ? `${slotTag} 明细` : slotTag)
      : L('区间明细', 'Selection');
    const resetLabel = period === 'day'
      ? L('回到今日', 'Today')
      : period === 'week'
        ? L('回到本周', 'This week')
        : L('回到本月', 'This month');
    breakdownRightHtml = `<button type="button" class="agy-usage-reset-btn" data-agy-usage-action="reset-current">${esc(resetLabel)}</button>`;
  }

  const emptyBucketMsg = view.isCurrentBucket
    ? (period === 'day'
        ? L('今日暂无用量', 'No usage today')
        : period === 'week'
          ? L('本周暂无用量', 'No usage this week')
          : L('本月暂无用量', 'No usage this month'))
    : L('该时段暂无用量', 'No usage in this slot');

  const modelsHtml = view.models.length
    ? `<div class="agy-usage-models">${view.models
        .map((entry, idx) => {
          const share = view.tokens > 0 ? Math.max(1, Math.round((entry.tokens / view.tokens) * 100)) : 0;
          return `<div class="agy-usage-model-row" data-agy-tip-model="${idx}">
            <div class="agy-usage-model-top">
              <span class="agy-usage-model-left">
                <span class="agy-usage-dot" style="background:${entry.color}"></span>
                <span class="agy-usage-model-name">${esc(nameOf(entry))}</span>
              </span>
              <span class="agy-usage-model-right">
                <span class="agy-usage-model-share">${share}%</span>
                <span class="agy-usage-model-tok">${esc(fmtTokens(entry.tokens))}</span>
              </span>
            </div>
            <div class="agy-usage-model-track"><div class="agy-usage-model-fill" style="width:${share}%;background:${entry.color}"></div></div>
          </div>`;
        })
        .join('')}</div>`
    : `<div class="agy-usage-empty">${esc(emptyBucketMsg)}</div>`;

  const breakdownHtml = `<div class="agy-usage-breakdown">
    <div class="agy-usage-breakdown-hdr">
      <span class="agy-usage-breakdown-title">${esc(breakdownTitle)}</span>
      ${breakdownRightHtml}
    </div>
    ${modelsHtml}
  </div>`;

  const segHtml = [
    ['day', L('按日', 'D')],
    ['week', L('按周', 'W')],
    ['month', L('按月', 'M')],
  ]
    .map(
      ([val, lbl]) =>
        `<button type="button" data-agy-usage-period="${val}" aria-pressed="${period === val ? 'true' : 'false'}">${esc(lbl)}</button>`
    )
    .join('');

  const shareLbl = totals.all > 0 ? formatShareLabel(shareOfGlobalPct) : '';
  const shareHtml = shareLbl
    ? `<span class="agy-usage-share-tag"> · ${esc(zh ? `占全局 ${shareLbl}` : `${shareLbl} of all`)}</span>`
    : '';

  const footScope = view.isCurrentBucket
    ? (period === 'day' ? L('今日', 'Today') : period === 'week' ? L('本周', 'Week') : L('本月', 'Month'))
    : L('已选', 'Selected');

  const bodyHtml = `<div class="ag-ov-card-body">
    <div class="agy-usage-kpi-grid">
      ${kpi('today', L('今日', 'Today'), totals.today)}
      ${kpi('week', L('本周', 'Week'), totals.week)}
      ${kpi('month', L('本月', 'Month'), totals.month)}
    </div>
    <div class="agy-usage-toolbar">
      <span class="agy-usage-seg" data-lang="${zh ? 'zh' : 'en'}" role="group">${segHtml}</span>
      <span class="agy-usage-nav">
        <button type="button" data-agy-usage-shift="-1" aria-label="${esc(L('更早', 'Older'))}"${view.older ? '' : ' disabled'}>‹</button>
        <span class="agy-usage-range">${esc(view.range)}</span>
        <button type="button" data-agy-usage-shift="1" aria-label="${esc(L('更晚', 'Newer'))}"${view.newer ? '' : ' disabled'}>›</button>
      </span>
    </div>
    <div class="agy-usage-chart" data-period="${period}">
      <div class="agy-usage-chart-meta"><span class="agy-usage-ymax">${view.max > 0 ? esc(fmtTokens(view.max)) : ''}</span></div>
      <div class="agy-usage-plot">
        <div class="agy-usage-grid" aria-hidden="true">
          <span class="agy-usage-grid-line"></span>
          <span class="agy-usage-grid-line"></span>
          <span class="agy-usage-grid-line is-base"></span>
        </div>
        <div class="agy-usage-bars">${barsHtml}</div>
      </div>
    </div>
    ${breakdownHtml}
    <div class="agy-usage-foot">
      <span>${esc(footScope)} ${esc(fmtTokens(view.tokens))} · ${esc(reqFmt(view.requests))}</span>
      <span data-agy-tip-kpi="all">${esc(L('累计', 'All'))} ${esc(fmtTokens(totals.all))}${shareHtml}</span>
    </div>
  </div>`;

  return { totals, renderCtx, bodyHtml };
}

function buildTokenGridHtml(bucket) {
  return `<div class="agy-utt-grid">
    <div class="agy-utt-kv"><span class="agy-utt-k">${esc(L('非缓存', 'Uncached'))}</span><span class="agy-utt-v">${esc(fmtTokens(bucket.uncached))}</span></div>
    <div class="agy-utt-kv"><span class="agy-utt-k">${esc(L('缓存读', 'Cache rd'))}</span><span class="agy-utt-v">${esc(fmtTokens(bucket.cacheRead))}</span></div>
    <div class="agy-utt-kv"><span class="agy-utt-k">${esc(L('缓存写', 'Cache wr'))}</span><span class="agy-utt-v">${esc(fmtTokens(bucket.cacheWrite))}</span></div>
    <div class="agy-utt-kv"><span class="agy-utt-k">${esc(L('输出', 'Output'))}</span><span class="agy-utt-v">${esc(fmtTokens(bucket.output))}</span></div>
  </div>`;
}

function buildTooltipHtml(targetEl, renderCtx) {
  if (!renderCtx) return '';
  const { totals, view, nameOf } = renderCtx;

  const barIdx = targetEl.getAttribute('data-agy-tip-bar');
  if (barIdx !== null) {
    const item = view.bars[Number(barIdx)];
    if (!item) return '';
    const heading = item.fullName || item.name;
    if (!item.tokens) {
      return `<div class="agy-utt-hdr"><span class="agy-utt-title">${esc(heading)}</span></div>
        <div class="agy-utt-empty">${esc(L('该时段无用量记录', 'No token usage recorded'))}</div>`;
    }
    const rows = item.parts
      .map((tok, sIdx) => ({ tok, s: view.series[sIdx] }))
      .filter((x) => x.tok > 0)
      .sort((a, b) => b.tok - a.tok)
      .map(({ tok, s }) => {
        const pct = Math.max(1, Math.round((tok / item.tokens) * 100));
        return `<div class="agy-utt-row">
          <span class="agy-utt-row-l"><span class="agy-utt-dot" style="background:${s.color}"></span><span class="agy-utt-name">${esc(nameOf(s))}</span></span>
          <span class="agy-utt-val"><strong>${esc(fmtTokens(tok))}</strong> · ${pct}%</span>
        </div>`;
      })
      .join('');
    return `<div class="agy-utt-hdr"><span class="agy-utt-title">${esc(heading)}</span><span class="agy-utt-sub">${esc(reqFmt(item.requests))}</span></div>
      <div class="agy-utt-total"><b>${esc(fmtTokens(item.tokens))}</b><span class="agy-utt-sub">${esc(exact(item.tokens))} tokens</span></div>
      ${rows ? `<div class="agy-utt-list">${rows}</div>` : ''}
      ${buildTokenGridHtml(item)}`;
  }

  const kpiKey = targetEl.getAttribute('data-agy-tip-kpi');
  if (kpiKey && totals.parts[kpiKey]) {
    const part = totals.parts[kpiKey];
    const val = totals[kpiKey] || 0;
    const titles = {
      today: L('今日用量', 'Today'),
      week: L('本周用量', 'This Week'),
      month: L('本月用量', 'This Month'),
      all: L('累计用量', 'All Time'),
    };
    return `<div class="agy-utt-hdr"><span class="agy-utt-title">${esc(titles[kpiKey] || kpiKey)}</span><span class="agy-utt-sub">${esc(reqFmt(part.requests))}</span></div>
      <div class="agy-utt-total"><b>${esc(fmtTokens(val))}</b><span class="agy-utt-sub">${esc(exact(val))} tokens</span></div>
      ${buildTokenGridHtml(part)}`;
  }

  const modelIdx = targetEl.getAttribute('data-agy-tip-model');
  if (modelIdx !== null) {
    const entry = view.models[Number(modelIdx)];
    if (!entry) return '';
    const tierRows = entry.tiers
      .filter((t) => t.tier || entry.tiers.length > 1)
      .map((t) => {
        const pct = Math.max(1, Math.round((t.tokens / entry.tokens) * 100));
        return `<div class="agy-utt-row">
          <span class="agy-utt-row-l"><span class="agy-utt-dot" style="background:${entry.color};opacity:.75"></span><span class="agy-utt-name">${esc(t.tier || L('默认', 'Default'))}</span></span>
          <span class="agy-utt-val"><strong>${esc(fmtTokens(t.tokens))}</strong> · ${pct}%</span>
        </div>`;
      })
      .join('');
    return `<div class="agy-utt-hdr"><span class="agy-utt-title">${esc(nameOf(entry))}</span><span class="agy-utt-sub">${esc(reqFmt(entry.requests))}</span></div>
      <div class="agy-utt-total"><b>${esc(fmtTokens(entry.tokens))}</b><span class="agy-utt-sub">${esc(exact(entry.tokens))} tokens</span></div>
      ${tierRows ? `<div class="agy-utt-list">${tierRows}</div>` : ''}
      ${buildTokenGridHtml(entry)}`;
  }

  return '';
}

export function createSharedUsageTooltip() {
  let tooltipEl = null;

  function ensureTooltipEl() {
    if (tooltipEl && tooltipEl.isConnected) return tooltipEl;
    tooltipEl = document.getElementById(TOOLTIP_ID);
    if (!tooltipEl && document.body) {
      tooltipEl = document.createElement('div');
      tooltipEl.id = TOOLTIP_ID;
      tooltipEl.setAttribute('data-ag-i18n-ignore', '1');
      document.body.appendChild(tooltipEl);
    }
    if (tooltipEl) markOwn(tooltipEl);
    return tooltipEl;
  }

  function hide() {
    const el = tooltipEl || document.getElementById(TOOLTIP_ID);
    if (el) el.removeAttribute('data-visible');
  }

  const onViewportChange = () => hide();
  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewportChange);

  function showFor(targetEl, renderCtx) {
    const html = buildTooltipHtml(targetEl, renderCtx);
    if (!html) {
      hide();
      return;
    }
    const tt = ensureTooltipEl();
    if (!tt) return;
    tt.innerHTML = html;

    const r = targetEl.getBoundingClientRect();
    const ttW = tt.offsetWidth || 248;
    const ttH = tt.offsetHeight || 136;
    const margin = 12;

    let left = Math.round(r.left + r.width / 2 - ttW / 2);
    left = Math.max(margin, Math.min(left, window.innerWidth - ttW - margin));

    let top = Math.round(r.top - ttH - 8);
    if (top < margin) {
      top = Math.min(window.innerHeight - ttH - margin, Math.round(r.bottom + 8));
    }

    tt.style.setProperty('--agy-tt-x', `${left}px`);
    tt.style.setProperty('--agy-tt-y', `${top}px`);
    tt.setAttribute('data-visible', '1');
  }

  function bindCardInteractions(cardEl, getRenderCtx) {
    let activeTipTarget = null;
    cardEl.addEventListener('pointerover', (e) => {
      const target = e.target?.closest?.('[data-agy-tip-bar], [data-agy-tip-kpi], [data-agy-tip-model]');
      if (!target || !cardEl.contains(target)) {
        if (activeTipTarget) {
          activeTipTarget = null;
          hide();
        }
        return;
      }
      if (target !== activeTipTarget) {
        activeTipTarget = target;
        showFor(target, getRenderCtx());
      }
    });
    cardEl.addEventListener('pointerleave', () => {
      activeTipTarget = null;
      hide();
    });
  }

  function dispose() {
    window.removeEventListener('scroll', onViewportChange, { capture: true });
    window.removeEventListener('resize', onViewportChange);
    hide();
    if (tooltipEl) {
      try { tooltipEl.remove(); } catch {}
      tooltipEl = null;
    }
  }

  return { hide, showFor, bindCardInteractions, dispose };
}
