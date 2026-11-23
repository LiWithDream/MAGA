/**
 * Unified Footer Runtime Module:
 * 1. Syncs Context Ratio ("used / limit") + 0/60/75 3-tier warnings onto #ag-claude-ctx-ring
 *    and simplifies #ag-claude-quota-popover's context subtitle.
 * 2. Enhances #ag-live-metrics-pill with agy-capsule's live working indicator dot (active/recent/idle)
 *    and color-coded tok/s speed tiers (>=25 fast green, 10-24.9 mid amber, <10 slow red).
 */

export function createFooterUnifiedRuntime() {
  let disposed = false;
  let observedFooterEl = null;
  let footerResizeObs = null;
  const speedActivity = {
    running: false,
    coolUntil: 0,
    lastMetricsText: '',
  };

  function watchFooterResize(footer) {
    if (!footer || observedFooterEl === footer || typeof ResizeObserver !== 'function') return;
    if (footerResizeObs) footerResizeObs.disconnect();
    observedFooterEl = footer;
    footerResizeObs = new ResizeObserver(() => {
      if (!disposed) syncContextCapsule();
    });
    footerResizeObs.observe(footer);
  }

  function isZhUi() {
    return (
      (document.documentElement.lang || '').toLowerCase().startsWith('zh') ||
      document.documentElement.getAttribute('data-ag-ux-lang') === 'zh-CN'
    );
  }

  function syncContextCapsule() {
    const ring = document.getElementById('ag-claude-ctx-ring');
    const pop = document.getElementById('ag-claude-quota-popover');
    if (!ring) return;

    const footer = ring.closest('.agy-composer-footer');
    watchFooterResize(footer);
    const footerW = footer ? Math.round(footer.getBoundingClientRect().width) : 0;
    const footerSize = footerW > 0 && footerW < 305
      ? 'xs'
      : footerW > 0 && footerW < 550
        ? 'narrow'
        : 'wide';
    if (footer && footer.getAttribute('data-agy-footer-size') !== footerSize) {
      footer.setAttribute('data-agy-footer-size', footerSize);
    }

    // Keep #ag-live-metrics-pill inside leftGroup so CSS 2-row flex ordering aligns
    // Context (Row 2 left) and Speed (Row 2 right) symmetrically on narrow widths.
    const speedPill = document.getElementById('ag-live-metrics-pill');
    if (footer && speedPill) {
      const leftGroup = footer.children[0];
      if (leftGroup && (footerSize === 'narrow' || footerSize === 'xs' || footerW >= 550)) {
        if (speedPill.parentElement !== leftGroup) {
          leftGroup.appendChild(speedPill);
        }
        if (speedPill.getAttribute('data-ag-row-mode') !== 'middle') {
          speedPill.setAttribute('data-ag-row-mode', 'middle');
        }
        if (footer.getAttribute('data-ag-row-mode') !== 'middle') {
          footer.setAttribute('data-ag-row-mode', 'middle');
        }
      }
    }

    const cState = ring.getAttribute('data-compact-state');
    const title = ring.getAttribute('title') || '';

    let ratioText = '';
    const rm = title.match(/(\d+(?:\.\d+)?[kKmM]?\s*\/\s*\d+(?:\.\d+)?[kKmM]?)/);
    if (rm) ratioText = rm[1].replace(/\s*\/\s*/, ' / ');

    let pct = NaN;
    const m = title.match(/\((\d+(?:\.\d+)?)%/);
    if (m) pct = parseFloat(m[1]);
    if (!Number.isFinite(pct) && pop) {
      const pctEl = pop.querySelector('.ag-qp-item .ag-qp-pct');
      const pm = (pctEl?.textContent || '').match(/(\d+(?:\.\d+)?)%/);
      if (pm) pct = parseFloat(pm[1]);
    }
    if (!Number.isFinite(pct)) {
      const arc = ring.querySelector('.ag-ctx-ring-arc');
      const offset = parseFloat(arc?.style?.strokeDashoffset || '');
      if (Number.isFinite(offset)) {
        const circ = 2 * Math.PI * 7;
        pct = Math.max(0, Math.min(100, Math.round((1 - offset / circ) * 100)));
      }
    }

    let ratioSpan = ring.querySelector('.agy-ctx-ratio');
    if (!ratioSpan) {
      ratioSpan = document.createElement('span');
      ratioSpan.className = 'agy-ctx-ratio';
      ring.appendChild(ratioSpan);
    }

    if (cState === 'compacting') {
      const label = footerSize === 'xs' ? '' : isZhUi() ? '压缩中…' : 'Compacting…';
      if (ratioSpan.textContent !== label) ratioSpan.textContent = label;
      ratioSpan.hidden = !label;
      if (label) ring.setAttribute('data-agy-has-ratio', 'true');
      else ring.removeAttribute('data-agy-has-ratio');
      ring.removeAttribute('data-agy-ctx-tier');
      if (pop) pop.removeAttribute('data-agy-ctx-tier');
      return;
    }

    // Full "used / limit" in wide & narrow 2-row mode (Row 2 has plenty of space);
    // only condense to "%" on ultra-narrow (<305px) panes.
    let displayText = '';
    if (footerSize === 'xs') {
      displayText = Number.isFinite(pct) ? `${Math.round(pct)}%` : (ratioText ? ratioText.split('/')[0].trim() : '');
    } else {
      displayText = ratioText;
    }

    if (displayText) {
      if (ratioSpan.textContent !== displayText) ratioSpan.textContent = displayText;
      ratioSpan.hidden = false;
      ring.setAttribute('data-agy-has-ratio', 'true');
    } else {
      ratioSpan.textContent = '';
      ratioSpan.hidden = true;
      ring.removeAttribute('data-agy-has-ratio');
    }

    if (pop && ratioText) {
      const firstReset = pop.querySelector(':scope > .ag-qp-item .ag-qp-reset');
      if (firstReset && firstReset.textContent !== ratioText) {
        firstReset.textContent = ratioText;
      }
    }

    if (cState === 'compacted') {
      ring.removeAttribute('data-agy-ctx-tier');
      if (pop) pop.removeAttribute('data-agy-ctx-tier');
      return;
    }

    const tier = !Number.isFinite(pct) || pct < 60 ? 'cool' : pct >= 75 ? 'crit' : 'warn';
    if (ring.getAttribute('data-agy-ctx-tier') !== tier) {
      ring.setAttribute('data-agy-ctx-tier', tier);
    }
    if (pop && pop.getAttribute('data-agy-ctx-tier') !== tier) {
      pop.setAttribute('data-agy-ctx-tier', tier);
    }
  }

  function isComposerRunning() {
    const cancelBtns = document.querySelectorAll('.agy-composer-footer button[data-testid="input-cancel-button"]');
    for (const btn of cancelBtns) {
      if (btn.closest('[data-side-panel-composer], [data-testid="subagent-tab-composer"]')) continue;
      if (typeof btn.checkVisibility === 'function') {
        if (btn.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return true;
      } else if (btn.offsetParent !== null) {
        return true;
      }
    }
    return false;
  }

  function syncSpeedCapsule() {
    const pill = document.getElementById('ag-live-metrics-pill');
    if (!pill) return;
    const textEl = pill.querySelector('#ag-live-metrics-text');
    if (!textEl) return;

    let dot = pill.querySelector(':scope > .agy-speed-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'agy-speed-dot';
      dot.setAttribute('aria-hidden', 'true');
      pill.insertBefore(dot, pill.firstChild);
    }

    const now = Date.now();
    const running = isComposerRunning();
    const existingPlaceholder = textEl.querySelector('[data-agy-working-label="1"]');
    const hasRealContent = Array.from(textEl.children).some(
      (ch) => ch.getAttribute('data-agy-working-label') !== '1' && (ch.textContent || '').trim() !== ''
    );

    if (running && !hasRealContent) {
      const label = isZhUi() ? '生成中…' : 'Working…';
      if (!existingPlaceholder) {
        const span = document.createElement('span');
        span.setAttribute('data-agy-working-label', '1');
        span.textContent = label;
        textEl.appendChild(span);
      } else if (existingPlaceholder.textContent !== label) {
        existingPlaceholder.textContent = label;
      }
      pill.setAttribute('data-agy-working-placeholder', 'true');
    } else {
      if (existingPlaceholder) existingPlaceholder.remove();
      pill.removeAttribute('data-agy-working-placeholder');
    }

    let tps = NaN;
    for (const child of textEl.children) {
      const txt = (child.textContent || '').trim();
      const tm = txt.match(/^([\d.]+)\s*tok\/s$/i);
      if (tm) {
        tps = parseFloat(tm[1]);
        if (child.getAttribute('data-agy-speed-num') !== '1') {
          child.setAttribute('data-agy-speed-num', '1');
        }
      } else if (child.getAttribute('data-agy-speed-num') === '1') {
        child.removeAttribute('data-agy-speed-num');
      }
    }

    const currentText = hasRealContent ? (textEl.textContent || '').trim() : '';
    if (running) {
      speedActivity.coolUntil = 0;
    } else if (speedActivity.running) {
      speedActivity.coolUntil = now + 15000;
    } else if (currentText && speedActivity.lastMetricsText && currentText !== speedActivity.lastMetricsText) {
      speedActivity.coolUntil = Math.max(speedActivity.coolUntil, now + 15000);
    }
    speedActivity.running = running;
    if (currentText) speedActivity.lastMetricsText = currentText;

    const motion = running ? 'active' : speedActivity.coolUntil > now ? 'recent' : 'idle';
    const tier = !Number.isFinite(tps) || tps <= 0
      ? 'unknown'
      : tps >= 25
        ? 'fast'
        : tps >= 10
          ? 'mid'
          : 'slow';

    if (pill.getAttribute('data-agy-motion') !== motion) {
      pill.setAttribute('data-agy-motion', motion);
    }
    if (pill.getAttribute('data-agy-speed-tier') !== tier) {
      pill.setAttribute('data-agy-speed-tier', tier);
    }
  }

  function sync() {
    if (disposed) return;
    syncContextCapsule();
    syncSpeedCapsule();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (footerResizeObs) {
      footerResizeObs.disconnect();
      footerResizeObs = null;
    }
    observedFooterEl = null;
    document.querySelectorAll('.agy-composer-footer[data-agy-footer-size]').forEach((el) => {
      el.removeAttribute('data-agy-footer-size');
    });
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) {
      ring.removeAttribute('data-agy-ctx-tier');
      ring.removeAttribute('data-agy-has-ratio');
      ring.querySelector('.agy-ctx-ratio')?.remove();
    }
    document.getElementById('ag-claude-quota-popover')?.removeAttribute('data-agy-ctx-tier');
    const pill = document.getElementById('ag-live-metrics-pill');
    if (pill) {
      pill.removeAttribute('data-agy-motion');
      pill.removeAttribute('data-agy-speed-tier');
      pill.removeAttribute('data-agy-working-placeholder');
      pill.querySelector(':scope > .agy-speed-dot')?.remove();
      pill.querySelector('[data-agy-working-label="1"]')?.remove();
      pill.querySelectorAll('[data-agy-speed-num="1"]').forEach((el) => el.removeAttribute('data-agy-speed-num'));
    }
  }

  return { sync, dispose };
}
