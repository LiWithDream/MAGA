/**
 * Shared DOM primitives & zero-churn O(1) mutation helpers for MAGA.
 * All Studio-managed nodes carry `data-maga-own="1"` so the root MutationObserver
 * ignores self-writes without expensive multi-selector `.closest()` traversals.
 */

export const OWN_ATTR = 'data-maga-own';

export const OWN_HOST_IDS = new Set([
  'agy-capsule-picker-host',
  'agy-main-subagent-pill',
  'agy-subagent-menu',
  'agy-resume-pill',
  'agy-opus-gate-pill',
  'agy-opus-gate-menu',
  'agy-ov-usage-card',
  'agy-pd-usage-slot',
  'agy-pd-usage-card',
  'agy-pd-hero-usage',
  'agy-conv-project-bar',
  'agy-conv-project-menu',
  'agy-usage-tooltip',
  'agy-maga-settings-trigger',
  'agy-maga-settings-drawer',
  'agy-maga-settings-root',
  'ag-claude-projects-nav-btn',
  'ag-claude-projects-view',
  'ag-claude-project-modal',
  'ag-claude-ov-sections',
  'ag-claude-recent-section',
  'ag-claude-ctx-ring',
  'ag-claude-quota-popover',
  'ag-live-metrics-pill',
  'ag-live-metrics-tooltip',
  'ag-claude-ux-settings-nav',
  'ag-claude-ux-settings-panel',
]);

const OWN_HELPER_CLASSES = ['ag-elapsed-timer', 'ag-orbit-dots', 'ag-collapse-ghost', 'ag-claude-folder-badges'];

export function markOwn(el) {
  if (el && el.nodeType === 1 && el.getAttribute?.(OWN_ATTR) !== '1') {
    el.setAttribute(OWN_ATTR, '1');
  }
  return el;
}

export function isOwnNode(node, extraFallbackSel = '') {
  let cur = node && (node.nodeType === 1 ? node : node.parentElement);
  const body = typeof document !== 'undefined' ? document.body : null;
  const docEl = typeof document !== 'undefined' ? document.documentElement : null;
  while (cur && cur.nodeType === 1) {
    if (cur.hasAttribute?.(OWN_ATTR)) return true;
    if (cur.hasAttribute?.('data-agy-picker-host') || cur.hasAttribute?.('data-agy-sub-pill')) return true;
    if (cur.id && OWN_HOST_IDS.has(cur.id)) return true;
    const cn = cur.className;
    if (typeof cn === 'string' && cn.includes('ag-')) {
      const cls = cur.classList;
      if (cls) {
        for (let i = 0; i < OWN_HELPER_CLASSES.length; i++) {
          if (cls.contains(OWN_HELPER_CLASSES[i])) return true;
        }
      }
    }
    if (extraFallbackSel && cur.matches?.(extraFallbackSel)) return true;
    if (cur === body || cur === docEl) break;
    cur = cur.parentElement;
  }
  return false;
}

export function setLeafText(el, nextText) {
  if (!el) return false;
  const str = String(nextText ?? '');
  const first = el.firstChild;
  if (first && first.nodeType === 3 && el.childNodes && el.childNodes.length === 1) {
    if (first.nodeValue === str) return false;
    first.nodeValue = str;
    return true;
  }
  if (el.textContent === str) {
    if (!first && (!el.children || el.children.length === 0) && el.ownerDocument?.createTextNode && el.appendChild) {
      el.appendChild(el.ownerDocument.createTextNode(str));
    }
    return false;
  }
  if (!first && (!el.children || el.children.length === 0) && el.ownerDocument?.createTextNode && el.appendChild) {
    el.appendChild(el.ownerDocument.createTextNode(str));
    return true;
  }
  el.textContent = str;
  return true;
}

export function setAttr(el, name, val) {
  if (!el) return false;
  if (val == null) {
    if (el.hasAttribute?.(name)) {
      el.removeAttribute(name);
      return true;
    }
    return false;
  }
  const str = String(val);
  if (el.getAttribute?.(name) !== str) {
    el.setAttribute(name, str);
    return true;
  }
  return false;
}

export function setStyle(el, prop, val) {
  if (!el || !el.style) return false;
  const str = val == null ? '' : String(val);
  if (prop.startsWith('--') || prop.includes('-')) {
    if (el.style.getPropertyValue?.(prop) === str) return false;
    if (!str) el.style.removeProperty?.(prop);
    else el.style.setProperty?.(prop, str);
    return true;
  }
  if (el.style[prop] === str) return false;
  el.style[prop] = str;
  return true;
}

export function isVisibleFast(el) {
  if (!el || !el.isConnected) return false;
  if (el.hidden || el.style?.display === 'none' || el.style?.visibility === 'hidden') return false;
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }
  return el.offsetParent !== null;
}
