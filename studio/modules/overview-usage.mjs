/**
 * Internalized Daily & Per-Model Token Usage Card for Anti-Claude's Right Overview Panel.
 * Fetches incremental SQLite usage history from the unified daemon via window.__agProjectCall('getUsageStats')
 * and mounts a collapsible .ag-ov-card inside #ag-claude-ov-sections right after the Quota card.
 */

export function createOverviewUsageRuntime({ motionThemes }) {
  const CARD_ID = 'agy-ov-usage-card';
  const STORAGE_KEY = 'agy_studio_usage_ui_v1';
  const CACHE_TTL_MS = 25000;
  const COUNTERS = ['uncached', 'cacheRead', 'cacheWrite', 'output'];
  const SPANS = { day: 14, week: 8, month: 6 };
  const FALLBACK_PALETTE = ['#388bfd', '#e07b53', '#16a34a', '#d97706', '#8b5cf6', '#e14d67'];
  const TIER_LABEL = {
    off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium',
    high: 'High', xhigh: 'XHigh', extra: 'Extra', max: 'Max', thinking: 'Thinking',
  };
  const PAREN_TIER_RE = /^(.*?)\s*\((?:thinking[\s,/-]+)?(off|minimal|low|medium|high|xhigh|extra|max)(?:\s+thinking)?\)$/i;
  const PAREN_THINK_RE = /^(.*?)\s*\((thinking)\)$/i;
  const SLUG_TIER_RE = /^([^\s()]+?)(?:-thinking)?-(off|minimal|low|medium|high|xhigh|extra|max)(?:-thinking)?$/i;
  const SLUG_THINK_RE = /^([^\s()]+)-(thinking)$/i;

  let disposed = false;
  let cardEl = null;
  let usageData = null;
  let fetchInFlight = false;
  let lastFetchTs = 0;
  let lastTurnSig = '';

  const uiState = loadUiState();

  function loadUiState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        open: typeof parsed.open === 'boolean' ? parsed.open : true,
        period: SPANS[parsed.period] ? parsed.period : 'day',
        shift: 0,
      };
    } catch {
      return { open: true, period: 'day', shift: 0 };
    }
  }

  function saveUiState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: uiState.open, period: uiState.period }));
    } catch {}
  }

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

  function fmtTokens(n) {
    const v = Number(n || 0);
    if (!Number.isFinite(v) || v <= 0) return '0';
    if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 10e9 ? 1 : 2)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 100e6 ? 0 : v >= 10e6 ? 1 : 2)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 100e3 ? 0 : 1)}k`;
    return String(Math.round(v));
  }

  const exact = (v) => Number(v || 0).toLocaleString('en-US');
  const pad = (v) => String(v).padStart(2, '0');
  const toDate = (day) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
  const toDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const addDays = (day, n) => { const d = toDate(day); d.setUTCDate(d.getUTCDate() + n); return toDay(d); };
  const addMonths = (month, n) => { const d = toDate(`${month}-01`); d.setUTCMonth(d.getUTCMonth() + n); return toDay(d).slice(0, 7); };
  const weekStart = (day) => addDays(day, -((toDate(day).getUTCDay() + 6) % 7));
  const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const emptyParts = () => ({ requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  const addParts = (t, s = {}) => { t.requests += s.requests || 0; for (const k of COUNTERS) t[k] += s[k] || 0; };
  const tokensOf = (b = {}) => (b.uncached || 0) + (b.cacheRead || 0) + (b.cacheWrite || 0) + (b.output || 0);

  function splitModelName(raw) {
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

  function colorForModel(name, rankIdx) {
    try {
      const c = motionThemes().dotColorFor(name || '');
      if (c && c !== '#8e8e93') return c;
    } catch {}
    return FALLBACK_PALETTE[rankIdx % FALLBACK_PALETTE.length];
  }

  function breakdownTip(bucket) {
    const parts = [
      `${L('非缓存', 'Uncached')} ${exact(bucket.uncached)}`,
      `${L('缓存读', 'Cache read')} ${exact(bucket.cacheRead)}`,
      `${L('缓存写', 'Cache write')} ${exact(bucket.cacheWrite)}`,
      `${L('输出', 'Output')} ${exact(bucket.output)}`,
    ];
    return parts.join(' · ');
  }

  function computeTotals(data, today) {
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

  function buildPeriodSpans(today, period, shift) {
    const count = SPANS[period] || 14;
    if (period === 'month') {
      const last = addMonths(today.slice(0, 7), count * shift);
      return Array.from({ length: count }, (_, i) => {
        const m = addMonths(last, i - count + 1);
        return {
          from: `${m}-01`,
          to: addDays(`${addMonths(m, 1)}-01`, -1),
          name: m,
          label: `${Number(m.slice(5))}${L('月', '')}`,
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
        name: from === to ? from : `${from} – ${to}`,
        label: period === 'week' ? `${Number(from.slice(5, 7))}/${Number(from.slice(8))}` : String(Number(from.slice(8))),
      };
    });
  }

  function computeModelView(data, today, period, shift) {
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

    const bars = buildPeriodSpans(today, period, Math.min(0, shift)).map((s) => ({
      ...s,
      tokens: 0,
      requests: 0,
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
        bar.requests += m.requests || 0;
        addParts(pageParts, m);
        const entry = series[slot];
        addParts(entry, m);
        if (slot < MAX_SLOTS) {
          const tb = entry.tiersMap.get(parsed.tier) || emptyParts();
          addParts(tb, m);
          entry.tiersMap.set(parsed.tier, tb);
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

    return {
      bars,
      series,
      max: Math.max(...bars.map((b) => b.tokens), 0),
      tokens: tokensOf(pageParts),
      requests: pageParts.requests,
      parts: pageParts,
      models,
      range: `${start} – ${end}`,
      older: days.length > 0 && first.from > days[0].date,
      newer: shift < 0,
    };
  }

  function buildChevronSvg(open) {
    return `<svg class="ag-ov-chev" data-open="${open ? 'true' : 'false'}" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5L8 6L4.5 9.5"/></svg>`;
  }

  function renderCard() {
    if (!cardEl) return;
    const today = localDay();
    const totals = computeTotals(usageData, today);
    const todayBadge = usageData ? `${L('今日', 'Today')} ${fmtTokens(totals.today)}` : L('读取中…', 'Loading…');

    let bodyHtml = '';
    if (uiState.open) {
      if (!usageData) {
        bodyHtml = `<div class="ag-ov-card-body"><div class="agy-usage-empty">${esc(L('正在统计本机对话用量…', 'Scanning local conversations…'))}</div></div>`;
      } else if (!(usageData.days || []).length && !totals.all) {
        bodyHtml = `<div class="ag-ov-card-body"><div class="agy-usage-empty">${esc(L('暂无用量记录', 'No usage recorded yet'))}</div></div>`;
      } else {
        const view = computeModelView(usageData, today, uiState.period, uiState.shift);
        const nameOf = (e) => (e.name === null ? L('其他模型', 'Other') : e.name || L('未知模型', 'Unknown'));
        const reqFmt = (n) => (isZh() ? `${exact(n)} 次请求` : `${exact(n)} req`);

        const kpi = (label, val, part) => {
          const tip = val > 0 ? `${exact(val)} tokens · ${reqFmt(part.requests)}\n${breakdownTip(part)}` : '0 tokens';
          return `<div class="agy-usage-kpi" title="${esc(tip)}"><span class="agy-usage-kpi-lbl">${esc(label)}</span><span class="agy-usage-kpi-val">${esc(fmtTokens(val))}</span></div>`;
        };

        const stride = uiState.period === 'day' ? 2 : 1;
        const barsHtml = view.bars
          .map((item, idx) => {
            const pct = view.max > 0 && item.tokens > 0 ? Math.max(4, Math.round((item.tokens / view.max) * 100)) : 0;
            const tipLines = item.tokens
              ? [
                  `${item.name} · ${exact(item.tokens)} tokens · ${reqFmt(item.requests)}`,
                  ...item.parts
                    .map((tok, sIdx) => (tok ? `${nameOf(view.series[sIdx])}: ${fmtTokens(tok)}` : ''))
                    .filter(Boolean),
                ]
              : [item.name];
            const stackHtml = item.tokens
              ? `<div class="agy-usage-bar-stack" style="height:${pct}%">${item.parts
                  .map((tok, sIdx) =>
                    tok
                      ? `<i style="flex:${Math.max(1, Math.round((tok / item.tokens) * 1000))} 0 0;background:${view.series[sIdx].color}"></i>`
                      : ''
                  )
                  .join('')}</div>`
              : '';
            const showX = (view.bars.length - 1 - idx) % stride === 0;
            return `<div class="agy-usage-bar" title="${esc(tipLines.join('\n'))}"><div class="agy-usage-bar-track">${stackHtml}</div><span class="agy-usage-bar-x">${showX ? esc(item.label) : ''}</span></div>`;
          })
          .join('');

        const modelsHtml = view.models.length
          ? `<div class="agy-usage-models">${view.models
              .map((entry) => {
                const share = view.tokens > 0 ? Math.max(1, Math.round((entry.tokens / view.tokens) * 100)) : 0;
                const tipLines = [`${breakdownTip(entry)} · ${reqFmt(entry.requests)}`];
                if (entry.tiers.some((t) => t.tier)) {
                  for (const t of entry.tiers) {
                    const tp = Math.round((t.tokens / entry.tokens) * 100);
                    tipLines.push(`${t.tier || L('默认', 'Default')}: ${fmtTokens(t.tokens)} (${tp}%) · ${reqFmt(t.requests)}`);
                  }
                }
                return `<div class="agy-usage-model-row" title="${esc(tipLines.join('\n'))}">
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
          : `<div class="agy-usage-empty">${esc(L('当前区间暂无用量', 'No usage in this period'))}</div>`;

        const segHtml = [
          ['day', L('日', 'D')],
          ['week', L('周', 'W')],
          ['month', L('月', 'M')],
        ]
          .map(
            ([val, lbl]) =>
              `<button type="button" data-agy-usage-period="${val}" aria-pressed="${uiState.period === val ? 'true' : 'false'}">${esc(lbl)}</button>`
          )
          .join('');

        const periodTip = view.tokens > 0 ? `${exact(view.tokens)} tokens · ${reqFmt(view.requests)}\n${breakdownTip(view.parts)}` : '0 tokens';
        bodyHtml = `<div class="ag-ov-card-body">
          <div class="agy-usage-kpi-grid">
            ${kpi(L('今日', 'Today'), totals.today, totals.parts.today)}
            ${kpi(L('本周', 'Week'), totals.week, totals.parts.week)}
            ${kpi(L('本月', 'Month'), totals.month, totals.parts.month)}
          </div>
          <div class="agy-usage-toolbar">
            <span class="agy-usage-seg" role="group">${segHtml}</span>
            <span class="agy-usage-nav">
              <button type="button" data-agy-usage-shift="-1" aria-label="${esc(L('更早', 'Older'))}"${view.older ? '' : ' disabled'}>‹</button>
              <span class="agy-usage-range">${esc(view.range)}</span>
              <button type="button" data-agy-usage-shift="1" aria-label="${esc(L('更晚', 'Newer'))}"${view.newer ? '' : ' disabled'}>›</button>
            </span>
          </div>
          <div class="agy-usage-bars">${barsHtml}</div>
          ${modelsHtml}
          <div class="agy-usage-foot">
            <span title="${esc(periodTip)}">${esc(L('本期', 'Period'))} ${esc(fmtTokens(view.tokens))} · ${esc(reqFmt(view.requests))}</span>
            <span>${esc(L('累计', 'All'))} ${esc(fmtTokens(totals.all))}</span>
          </div>
        </div>`;
      }
    }

    cardEl.innerHTML = `<div class="ag-ov-card-hdr">
      <button type="button" class="ag-ov-hdr-toggle" data-agy-usage-action="toggle">
        ${buildChevronSvg(uiState.open)}
        <span>${esc(L('用量统计', 'Token Usage'))}</span>
      </button>
      <div class="agy-usage-hdr-right">
        <span class="ag-ov-muted ag-ov-tabular">${esc(todayBadge)}</span>
        <button type="button" class="ag-ov-icon-btn" data-agy-usage-action="refresh" title="${esc(L('刷新用量统计', 'Refresh usage stats'))}" aria-label="Refresh">
          <svg class="${fetchInFlight ? 'ag-ov-spinning' : ''}" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.35-3.6M13.5 2.5v2.9h-2.9"/></svg>
        </button>
      </div>
    </div>${bodyHtml}`;
  }

  function ensureCardElement() {
    if (cardEl) return cardEl;
    cardEl = document.createElement('section');
    cardEl.id = CARD_ID;
    cardEl.className = 'ag-ov-card';
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

  function sync() {
    if (disposed) return;
    const panel = document.querySelector('[data-testid="overview-panel"]');
    if (!panel || panel.hidden || panel.getAttribute('aria-hidden') === 'true') return;
    const sections = document.getElementById('ag-claude-ov-sections');
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

    const m = window.__ag_last_metrics;
    const turnSig = m?.hasData && m?.stats ? `${m.cascadeId || ''}:${m.stats.calls || 0}:${m.stats.turns || 0}` : '';
    const turnChanged = Boolean(turnSig && lastTurnSig && turnSig !== lastTurnSig);
    if (turnSig) lastTurnSig = turnSig;

    if (!usageData || turnChanged || Date.now() - lastFetchTs >= CACHE_TTL_MS) {
      fetchUsage(turnChanged);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (cardEl) {
      try { cardEl.remove(); } catch {}
      cardEl = null;
    }
  }

  return { sync, dispose };
}
