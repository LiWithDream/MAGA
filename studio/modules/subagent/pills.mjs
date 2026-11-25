/**
 * Pure Formatting & Pill / Menu HTML Renderers for Subagent Footer & Side-Panel Composer.
 */
import { setAttr } from '../../core/dom.mjs';
import { isZhUi, L } from '../../core/env.mjs';

const RING_CIRC = 2 * Math.PI * 7;

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtTok(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 10e6 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

export function getSubagentLabel(ch) {
  return String(ch?.agentName || ch?.title || ch?.id?.slice(0, 8) || 'subagent').trim();
}

export function renderMainPill(pill, { all, active, auxOpen, activeTabId }) {
  const displayList = active.length > 0 ? active : all;
  const isMultiple = all.length > 1;
  const primary = displayList[0];
  const anyRunning = active.some((c) => c.running);
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

  const langTag = isZhUi() ? 'zh' : 'en';
  const sig = `${langTag}|${label}|${active.length}|${all.length}|${subState}|${isLinkedOpen ? 1 : 0}`;
  if (pill.getAttribute('data-sig') !== sig) {
    setAttr(pill, 'data-sig', sig);
    setAttr(pill, 'data-agy-sub-state', subState);
    setAttr(pill, 'data-active', isLinkedOpen ? 'true' : 'false');
    if (pill.title !== tooltip) pill.title = tooltip;
    pill.innerHTML = `${dotHtml}${botSvg}<span class="agy-sub-name">${esc(label)}</span>${countBadge}`;
  }
}

export function buildSubagentMenuHtml({ allChildren, activeChildren, auxOpen, activeTabId }) {
  const activeIds = new Set(activeChildren.map((c) => c.id));
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
  return `<div class="agy-sub-menu-hdr">${esc(L('子代理会话', 'Subagents'))} · ${allChildren.length}</div><div class="agy-sub-menu-list">${rowsHtml}</div>`;
}

export function renderSubModelPill(el, data, { motionThemes, shortenModelName, shortenEffortBadge }) {
  const isZh = isZhUi();
  const langTag = isZh ? 'zh' : 'en';
  const fullName = data.modelName || L('子代理', 'Subagent');
  const shortName = typeof shortenModelName === 'function' ? shortenModelName(fullName, isZh) : fullName;
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
  const sig = `${langTag}|${fullName}|${shortName}|${effortText}|${accent}`;
  if (el.getAttribute('data-sig') !== sig) {
    el.setAttribute('data-sig', sig);
    el.setAttribute('data-has-effort', hasEffort ? '1' : '0');
    el.title = `${fullName}${rawEffort ? ` · ${rawEffort}` : ''}`;
    el.innerHTML = `<span class="agy-sub-mdot" aria-hidden="true"></span><span class="agy-sub-mname agy-sub-mname-full">${esc(fullName)}</span><span class="agy-sub-mname agy-sub-mname-short">${esc(shortName)}</span>${effortHtml}`;
  }
}

export function renderSubCtxPill(el, data) {
  const langTag = isZhUi() ? 'zh' : 'en';
  const pct = Number.isFinite(data.pct) ? Math.max(0, Math.min(100, Math.round(data.pct))) : 0;
  const tier = pct < 60 ? 'cool' : pct >= 75 ? 'crit' : 'warn';
  const ratio = `${fmtTok(data.contextTokens)} / ${fmtTok(data.maxContextTokens)}`;
  const pctText = `${pct}%`;
  const dashOffset = Math.max(0, RING_CIRC * (1 - pct / 100));
  const sig = `${langTag}|${ratio}|${pctText}|${tier}`;
  if (el.getAttribute('data-sig') !== sig) {
    el.setAttribute('data-sig', sig);
    el.setAttribute('data-agy-ctx-tier', tier);
    el.title = `${L('子代理上下文', 'Subagent context')} ${ratio} (${pct}%)`;
    el.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true"><circle class="agy-sub-ring-track" cx="10" cy="10" r="7" fill="none" stroke-width="2.15"/><circle class="agy-sub-ring-arc" cx="10" cy="10" r="7" fill="none" stroke-width="2.15" stroke-linecap="round" stroke-dasharray="${RING_CIRC.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"/></svg><span class="agy-sub-ctx-txt agy-sub-ctx-full">${esc(ratio)}</span><span class="agy-sub-ctx-txt agy-sub-ctx-pct">${esc(pctText)}</span>`;
  }
}

export function renderSubSpeedPill(el, data) {
  const langTag = isZhUi() ? 'zh' : 'en';
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

  const sig = `${langTag}|${fullLabel}|${tightLabel}|${ttftText}|${tier}|${motion}`;
  if (el.getAttribute('data-sig') !== sig) {
    el.setAttribute('data-sig', sig);
    el.setAttribute('data-agy-speed-tier', tier);
    el.setAttribute('data-agy-motion', motion);
    el.title = fullTip;
    const txtHtml = parts.length ? `<span class="agy-sub-stxt">${parts.join('')}</span>` : '';
    el.innerHTML = `<span class="agy-sub-sdot" aria-hidden="true"></span>${txtHtml}`;
  }
}
