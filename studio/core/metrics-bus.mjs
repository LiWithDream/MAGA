/**
 * Structured Metrics Bus & Zero-innerHTML Speed Capsule Slot Renderer.
 * Eliminates the 3-way HTML overwrite chain across daemon -> custom.js -> runtime.js -> footer-unified.mjs.
 */
import { markOwn, setLeafText } from './dom.mjs';
import { fmtDurationSec, getActiveRouteCid, hasValidMetricsForCurrentChat, isComposerRunning, isZhUi } from './env.mjs';

const SLOT_INIT_ATTR = 'data-agy-speed-slots';

function stripHtmlInlineSegments(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return [];
  return rawHtml
    .replace(/<\/(?:span|div|b|strong|i)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseSpeedFromPayload(payload, cid = getActiveRouteCid()) {
  if (!payload || !payload.hasData) return null;
  if (cid && payload.cascadeId && payload.cascadeId !== cid) return null;

  let displayTps = NaN;
  let useStream = true;
  let ttft = NaN;

  const m = payload.metrics;
  if (m && typeof m === 'object') {
    displayTps = Number(m.displayTps);
    useStream = Boolean(m.useStream);
    ttft = Number(m.ttft);
  } else {
    const segs = stripHtmlInlineSegments(payload.inlineHtml || '');
    for (const seg of segs) {
      const tm = seg.match(/^([\d.]+)\s*tok\/s$/i);
      if (tm) {
        displayTps = parseFloat(tm[1]);
        continue;
      }
      const dm = seg.match(/^(TTFT|Hold)\s+([\d.]+)\s*s$/i);
      if (dm) {
        useStream = dm[1].toUpperCase() === 'TTFT';
        ttft = parseFloat(dm[2]);
        continue;
      }
      const hm = seg.match(/^(TTFT|Hold)\s+(\d+)m\s*(\d+)s$/i);
      if (hm) {
        useStream = hm[1].toUpperCase() === 'TTFT';
        ttft = Number(hm[2]) * 60 + Number(hm[3]);
      }
    }
  }

  let speedNumText = '';
  let speedShortText = '';
  let tps = NaN;
  if (Number.isFinite(displayTps) && displayTps > 0) {
    if (Math.round(displayTps) > 0) {
      tps = displayTps;
      speedNumText = `${Math.round(displayTps)} tok/s`;
      speedShortText = String(Math.round(displayTps));
    } else if (displayTps < 1) {
      tps = displayTps;
      speedNumText = `${displayTps.toFixed(1)} tok/s`;
      speedShortText = displayTps.toFixed(1);
    }
  }

  let extraText = '';
  if (Number.isFinite(ttft) && ttft >= 0) {
    const durStr = ttft >= 60 ? fmtDurationSec(ttft) : `${ttft.toFixed(1)}s`;
    extraText = `${useStream ? 'TTFT' : 'Hold'} ${durStr}`;
  }

  const sepText = speedNumText && extraText ? '·' : '';
  const fullText = [speedNumText, sepText, extraText].filter(Boolean).join(' ');
  const hasRealContent = Boolean(speedNumText || extraText);

  return {
    tps,
    speedNumText,
    speedShortText,
    sepText,
    extraText,
    fullText,
    hasRealContent,
  };
}

export function ensureSpeedSlots(textEl) {
  if (!textEl) return null;
  if (textEl.getAttribute?.(SLOT_INIT_ATTR) === '1' && textEl._agySlots) {
    return textEl._agySlots;
  }

  const doc = textEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;

  const mkSlot = (slotName, attrs = {}, cls = '') => {
    const span = doc.createElement('span');
    span.setAttribute('data-agy-speed-slot', slotName);
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    if (cls) span.className = cls;
    if (typeof doc.createTextNode === 'function' && span.appendChild) {
      span.appendChild(doc.createTextNode(''));
    }
    return span;
  };

  let slots = null;
  if (textEl.getAttribute?.(SLOT_INIT_ATTR) === '1') {
    const bySlot = (name) => textEl.querySelector?.(`[data-agy-speed-slot="${name}"]`) || null;
    const short = bySlot('short');
    const num = bySlot('num');
    const sep = bySlot('sep');
    const extra = bySlot('extra');
    const working = bySlot('working');
    if (short && num && sep && extra && working) {
      slots = { short, num, sep, extra, working };
    }
  }

  if (!slots) {
    slots = {
      short: mkSlot('short', { 'data-agy-speed-short': '1' }),
      num: mkSlot('num', { 'data-agy-speed-num': '1' }),
      sep: mkSlot('sep', { 'data-agy-speed-extra': '1' }, 'ag-sep'),
      extra: mkSlot('extra', { 'data-agy-speed-extra': '1' }),
      working: mkSlot('working', { 'data-agy-working-label': '1' }),
    };
    textEl.replaceChildren?.(slots.short, slots.num, slots.sep, slots.extra, slots.working);
    textEl.setAttribute?.(SLOT_INIT_ATTR, '1');
  }

  textEl._agySlots = slots;
  return slots;
}

export function renderSpeedSlots(pill, textEl, payload, { cid = getActiveRouteCid(), running = isComposerRunning(), isZh = isZhUi() } = {}) {
  if (!pill || !textEl) return { parsed: null, validMetrics: false };
  markOwn(pill);

  let dot = pill.querySelector?.(':scope > .agy-speed-dot');
  if (!dot) {
    const doc = pill.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (doc) {
      dot = doc.createElement('span');
      dot.className = 'agy-speed-dot';
      dot.setAttribute('aria-hidden', 'true');
      pill.insertBefore(dot, pill.firstChild);
    }
  }

  const validMetrics = Boolean(
    payload ? payload.hasData && (!cid || !payload.cascadeId || payload.cascadeId === cid) : hasValidMetricsForCurrentChat(cid)
  );
  const effectivePayload = validMetrics ? payload || (typeof window !== 'undefined' ? window.__ag_last_metrics : null) : null;
  const parsed = effectivePayload ? parseSpeedFromPayload(effectivePayload, cid) : null;
  const hasRealContent = Boolean(parsed && parsed.hasRealContent);
  const showWorking = Boolean(running && !hasRealContent);

  const slots = ensureSpeedSlots(textEl);
  const hasSpeedNum = Boolean(hasRealContent && parsed.speedNumText);
  if (slots) {
    const hideShort = !hasRealContent || !parsed.speedShortText;
    setLeafText(slots.short, hideShort ? '' : parsed.speedShortText);
    if (slots.short.hidden !== hideShort) slots.short.hidden = hideShort;

    setLeafText(slots.num, hasRealContent ? parsed.speedNumText : '');
    const hideNum = !hasRealContent || !parsed.speedNumText;
    if (slots.num.hidden !== hideNum) slots.num.hidden = hideNum;

    setLeafText(slots.sep, hasRealContent ? parsed.sepText : '');
    const hideSep = !hasRealContent || !parsed.sepText;
    if (slots.sep.hidden !== hideSep) slots.sep.hidden = hideSep;

    setLeafText(slots.extra, hasRealContent ? parsed.extraText : '');
    const hideExtra = !hasRealContent || !parsed.extraText;
    if (slots.extra.hidden !== hideExtra) slots.extra.hidden = hideExtra;

    const workingLabel = showWorking ? (isZh ? '生成中…' : 'Working…') : '';
    setLeafText(slots.working, workingLabel);
    if (slots.working.hidden !== !showWorking) slots.working.hidden = !showWorking;
  }

  const nextHasNum = hasSpeedNum ? '1' : '0';
  if (pill.getAttribute('data-agy-has-speed-num') !== nextHasNum) {
    pill.setAttribute('data-agy-has-speed-num', nextHasNum);
  }

  const nextWp = showWorking ? 'true' : null;
  if (nextWp) {
    if (pill.getAttribute('data-agy-working-placeholder') !== 'true') {
      pill.setAttribute('data-agy-working-placeholder', 'true');
    }
  } else if (pill.hasAttribute('data-agy-working-placeholder')) {
    pill.removeAttribute('data-agy-working-placeholder');
  }

  if (validMetrics && hasRealContent) {
    if (pill.style.display !== 'inline-flex') {
      pill.style.display = 'inline-flex';
    }
  } else if (!showWorking) {
    if (pill.style.display !== 'none') {
      pill.style.display = 'none';
    }
  }

  return { parsed, validMetrics, showWorking };
}

export function installMetricsBus({ onMetrics } = {}) {
  if (typeof window === 'undefined') return () => {};
  const renderer = (payload, pill, textEl) => {
    try {
      renderSpeedSlots(pill, textEl, payload);
    } catch {}
    if (typeof onMetrics === 'function') {
      onMetrics(payload);
    }
  };
  window.__agyStudioMetricsRenderer = renderer;

  // Immediately hydrate existing metrics pill once on mount
  if (typeof document !== 'undefined') {
    const pill = document.getElementById('ag-live-metrics-pill');
    const textEl = pill?.querySelector?.('#ag-live-metrics-text');
    if (pill && textEl && window.__ag_last_metrics) {
      renderSpeedSlots(pill, textEl, window.__ag_last_metrics);
    }
  }

  return () => {
    if (window.__agyStudioMetricsRenderer === renderer) {
      window.__agyStudioMetricsRenderer = null;
    }
  };
}
