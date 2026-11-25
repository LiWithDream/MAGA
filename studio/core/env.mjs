/**
 * Shared environment & host-state readers for MAGA browser modules.
 * Single source of truth for locale, active route cid, running state & metrics validity.
 */
import { isVisibleFast } from './dom.mjs';

export function isZhUi() {
  if (typeof document === 'undefined') return false;
  return /^zh\b/i.test(document.documentElement?.getAttribute?.('data-ag-ux-lang') || '');
}

export function L(zh, en) {
  return isZhUi() ? zh : en;
}

export function getActiveRouteCid() {
  if (typeof location === 'undefined') return '';
  const m = String(location.pathname || '').match(/\/c\/([^/?#]+)/);
  return m ? m[1] : '';
}

export function isComposerRunning(scopeEl = null) {
  if (typeof document === 'undefined') return false;
  const root = scopeEl || document;
  const cancelBtns = root.querySelectorAll?.('.agy-composer-footer button[data-testid="input-cancel-button"]') || [];
  for (const btn of cancelBtns) {
    if (!scopeEl && btn.closest?.('[data-side-panel-composer], [data-testid="subagent-tab-composer"]')) continue;
    if (isVisibleFast(btn)) return true;
  }
  return false;
}

export function hasValidMetricsForCurrentChat(cid = getActiveRouteCid()) {
  if (typeof window === 'undefined') return false;
  const m = window.__ag_last_metrics;
  if (!m || !m.hasData) return false;
  if (!cid) return false;
  return !m.cascadeId || m.cascadeId === cid;
}

export function fmtDurationSec(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec >= 60) {
    const total = Math.round(sec);
    const mins = Math.floor(total / 60);
    const rem = total % 60;
    return `${mins}m ${rem}s`;
  }
  return `${sec.toFixed(1)}s`;
}
