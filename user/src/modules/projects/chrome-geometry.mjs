/**
 * Pure geometry & DOM lookup helpers for positioning the Projects overlay
 * and synchronizing `--ag-win-top-bar` across macOS and Windows Electron shells.
 */

export function isTopMenuBarRect(rect, winW = 0) {
  return Boolean(rect && rect.height > 0 && rect.height <= 64 && winW > 200 && rect.width >= winW - 160);
}

export function isTopMenuBarAnchorRect(rect, winW = 0) {
  return Boolean(
    rect && rect.top >= -1 && rect.top <= 4 && rect.height >= 16 && rect.height <= 56 && winW > 200 && rect.width >= winW - 160
  );
}

export function computeProjectsOverlayMetrics({
  sidebarRect = null,
  trackRect = null,
  topBarPx = 0,
  winW = 0,
} = {}) {
  let r = sidebarRect;
  if (trackRect && trackRect.height > 80 && (!winW || trackRect.width < winW - 160)) {
    r = trackRect;
  }
  let leftPx = 0;
  let topPx = 0;
  if (r) {
    if (r.width > 8 && r.right > 8 && (!winW || r.right < winW - 160)) {
      leftPx = Math.round(r.right);
    }
    if (r.height > 80 && r.top >= 16 && r.top <= 56) {
      topPx = Math.round(r.top);
    }
  }
  if (!topPx && topBarPx > 0) {
    topPx = Math.round(topBarPx);
  }
  const collapsed = leftPx < 220;
  const safeLeftPad = collapsed ? Math.max(24, 224 - leftPx) : 24;
  return { leftPx, topPx, collapsed, safeLeftPad };
}

export function isTopMenuBarBgSidebar(el, win = typeof window !== 'undefined' ? window : null) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const winW = win && win.innerWidth ? win.innerWidth : 0;
  return isTopMenuBarRect(el.getBoundingClientRect(), winW);
}

export function findLeftSidebarEl(
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null
) {
  if (!doc) return null;
  const anchors = [
    doc.getElementById('ag-claude-projects-nav-btn'),
    doc.querySelector('[data-testid="automations-button"]'),
    doc.querySelector('[data-testid="project-header"]'),
  ];
  for (const anchor of anchors) {
    const sb = anchor && typeof anchor.closest === 'function' ? anchor.closest('.bg-sidebar') : null;
    if (sb && !isTopMenuBarBgSidebar(sb, win)) return sb;
  }
  const cands = doc.querySelectorAll('.bg-sidebar');
  const winW = win && win.innerWidth ? win.innerWidth : 0;
  for (let i = 0; i < cands.length; i += 1) {
    const sb = cands[i];
    const r = sb.getBoundingClientRect();
    if (r.width > 20 && r.height > 80 && r.right > 0 && (!winW || r.right < winW - 160)) {
      return sb;
    }
  }
  for (let i = 0; i < cands.length; i += 1) {
    const sb = cands[i];
    if (sb.tagName === 'ASIDE' || (sb.classList && sb.classList.contains('flex-col'))) return sb;
  }
  return cands[0] || null;
}

export function findLeftSidebarTrackEl(
  sb,
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null
) {
  const getStyle =
    win && typeof win.getComputedStyle === 'function'
      ? win.getComputedStyle.bind(win)
      : typeof getComputedStyle === 'function'
        ? getComputedStyle
        : null;
  if (!sb || !doc || !getStyle) return sb || null;
  const winW = win && win.innerWidth ? win.innerWidth : 0;
  let cur = sb.parentElement;
  for (let i = 0; i < 4 && cur && cur !== doc.body; i += 1, cur = cur.parentElement) {
    let cs = null;
    try {
      cs = getStyle(cur);
    } catch {}
    const clip =
      cs && (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || String(cs.transition || '').includes('width'));
    if (clip && typeof cur.getBoundingClientRect === 'function') {
      const r = cur.getBoundingClientRect();
      if (r.height > 80 && (!winW || r.width < winW - 160)) return cur;
    }
  }
  return sb;
}

export function measureTopMenuBarHeight(
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null
) {
  if (!doc) return 0;
  const cands = doc.querySelectorAll('.bg-sidebar');
  const winW = win && win.innerWidth ? win.innerWidth : 0;
  for (let i = 0; i < cands.length; i += 1) {
    const r = cands[i].getBoundingClientRect();
    if (isTopMenuBarAnchorRect(r, winW)) {
      return Math.round(r.bottom);
    }
  }
  return 0;
}

export function syncWinTopBarCssVar(
  topPx,
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null
) {
  const resolvedTop = typeof topPx === 'number' ? topPx : measureTopMenuBarHeight(doc, win);
  const root = doc ? doc.documentElement : null;
  if (!root || !root.style) return;
  if (resolvedTop > 0) root.style.setProperty('--ag-win-top-bar', `${resolvedTop}px`);
  else root.style.removeProperty('--ag-win-top-bar');
}
