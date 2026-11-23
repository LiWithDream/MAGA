/**
 * Unified Footer Runtime Module:
 * 1. Manages responsive wide / narrow 2-row / xs footer sizing cleanly across main & side composers
 *    with zero DOM tug-of-war against core/runtime.js's ensureMetricsPill().
 * 2. Syncs Context Ratio ("used / limit") + unified 0/60/75 3-tier warnings across Footer,
 *    Quota Popover (+ Compact urgency + instant .ag-qp-reset sync), and Overview Context card.
 * 3. Enhances #ag-live-metrics-pill with live working indicator dot (active/recent/idle),
 *    accurate per-conversation Working… placeholder, and color-coded tok/s speed tiers.
 */

export function createFooterUnifiedRuntime() {
  let disposed = false;
  let footerResizeObs = null;
  const observedFooters = new Set();
  let popObs = null;
  let observedPop = null;
  let wrappedEnsureMetricsPill = null;

  const speedActivity = {
    running: false,
    coolUntil: 0,
    lastMetricsText: '',
    lastCid: '',
  };

  function isZhUi() {
    return (
      (document.documentElement.lang || '').toLowerCase().startsWith('zh') ||
      document.documentElement.getAttribute('data-ag-ux-lang') === 'zh-CN'
    );
  }

  function getActiveRouteCid() {
    const m = String(location.pathname || '').match(/\/c\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function hasValidMetricsForCurrentChat() {
    const m = window.__ag_last_metrics;
    if (!m || !m.hasData) return false;
    const cid = getActiveRouteCid();
    if (!cid) return false;
    return !m.cascadeId || m.cascadeId === cid;
  }

  function wrapEnsureMetricsPillOnce() {
    const cur = window.__ag_ensure_metrics_pill_fn;
    if (typeof cur !== 'function' || cur === wrappedEnsureMetricsPill) return;
    const orig = cur.__agyOrigEnsure || cur;
    const wrapped = function (...args) {
      const pill = orig.apply(this, args);
      if (!disposed && pill) {
        const footer = document.querySelector('#antigravity\\.agentSidePanelInputBox .agy-composer-footer')
          || document.querySelector('.agy-composer-footer');
        const leftGroup = footer?.children?.[0];
        if (leftGroup && pill.parentElement !== leftGroup) {
          leftGroup.appendChild(pill);
        }
        if (pill.getAttribute('data-ag-row-mode') !== 'middle') {
          pill.setAttribute('data-ag-row-mode', 'middle');
        }
        if (footer && footer.getAttribute('data-ag-row-mode') !== 'middle') {
          footer.setAttribute('data-ag-row-mode', 'middle');
        }
      }
      return pill;
    };
    wrapped.__agyOrigEnsure = orig;
    wrappedEnsureMetricsPill = wrapped;
    window.__ag_ensure_metrics_pill_fn = wrapped;
  }

  function repositionOpenQuotaPopover() {
    const pop = document.getElementById('ag-claude-quota-popover');
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (!pop || !ring || pop.getAttribute('data-open') !== 'true') return;
    const r = ring.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const popW = pop.offsetWidth || 296;
    const left = Math.round(Math.max(12, Math.min(r.left, window.innerWidth - popW - 14)));
    const bottom = Math.round(Math.max(10, window.innerHeight - r.top + 8));
    pop.style.left = `${left}px`;
    pop.style.bottom = `${bottom}px`;
  }

  function watchFooters(footers) {
    if (typeof ResizeObserver !== 'function') return;
    if (!footerResizeObs) {
      footerResizeObs = new ResizeObserver(() => {
        if (disposed) return;
        sync();
        repositionOpenQuotaPopover();
      });
    }
    for (const f of footers) {
      if (!observedFooters.has(f)) {
        observedFooters.add(f);
        footerResizeObs.observe(f);
      }
    }
    for (const f of Array.from(observedFooters)) {
      if (!f.isConnected) {
        try { footerResizeObs.unobserve(f); } catch {}
        observedFooters.delete(f);
      }
    }
  }

  function simplifyPopoverReset(pop, ratioText) {
    if (!pop || !ratioText) return;
    const firstReset = pop.querySelector(':scope > .ag-qp-item .ag-qp-reset');
    if (firstReset && firstReset.textContent !== ratioText) {
      firstReset.textContent = ratioText;
    }
  }

  function watchPopoverSync(pop, getRatioText) {
    if (!pop || observedPop === pop) return;
    if (popObs) popObs.disconnect();
    observedPop = pop;
    popObs = new MutationObserver(() => {
      if (disposed || !pop.isConnected) return;
      const ratioText = getRatioText();
      if (ratioText) simplifyPopoverReset(pop, ratioText);
    });
    popObs.observe(pop, { childList: true, subtree: true, characterData: true });
  }

  function hasExtraVisibleChip(leftGroup) {
    if (!leftGroup) return false;
    for (const ch of leftGroup.children) {
      if (ch.id === 'agy-capsule-picker-host' || ch.hasAttribute('data-agy-picker-host')) continue;
      if (ch.id === 'ag-claude-ctx-ring' || ch.id === 'ag-live-metrics-pill') continue;
      if (ch.tagName === 'INPUT') continue;
      if (ch.tagName === 'BUTTON' && ch === leftGroup.querySelector(':scope > button')) continue;
      if (ch.querySelector?.('button[data-deck-model-bubble="hidden"]')) continue;
      if (ch.getAttribute?.('data-deck-model-bubble') === 'hidden') continue;
      const r = ch.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) return true;
    }
    return false;
  }

  function syncFooterResponsiveLayout() {
    const excluded = '[data-testid="side-question-tab-content"], [data-testid="voice-dock-composer"]';
    const footers = Array.from(document.querySelectorAll('.agy-composer-footer')).filter(
      (f) => !f.closest(excluded)
    );
    watchFooters(footers);

    for (const footer of footers) {
      const footerW = Math.round(footer.getBoundingClientRect().width);
      if (footerW <= 0) continue;

      const leftGroup = footer.children[0];
      const ring = footer.querySelector('#ag-claude-ctx-ring');
      const speedPill = footer.querySelector('#ag-live-metrics-pill')
        || (footer.nextElementSibling?.id === 'ag-live-metrics-pill' ? footer.nextElementSibling : null);

      if (leftGroup && speedPill && speedPill.parentElement !== leftGroup) {
        leftGroup.appendChild(speedPill);
        speedPill.setAttribute('data-ag-row-mode', 'middle');
        footer.setAttribute('data-ag-row-mode', 'middle');
      }

      const speedVisible = Boolean(
        speedPill &&
        (speedPill.getAttribute('data-agy-working-placeholder') === 'true' ||
          (speedPill.style.display !== 'none' && getComputedStyle(speedPill).display !== 'none'))
      );
      const ringHasRatio = Boolean(ring && ring.getAttribute('data-agy-has-ratio') === 'true');
      const hasExtraChip = hasExtraVisibleChip(leftGroup);

      // Avoid wasted 2nd row + hairline divider on Home `/` when neither ratio nor speed nor chip is visible
      const hasRow2Content = ringHasRatio || speedVisible || hasExtraChip;
      const narrowThreshold = hasExtraChip ? 780 : 600;
      const compactCtxThreshold = hasExtraChip ? 440 : 315;

      const footerSize = !hasRow2Content
        ? 'wide'
        : footerW < compactCtxThreshold
          ? 'xs'
          : footerW < narrowThreshold
            ? 'narrow'
            : 'wide';

      if (footer.getAttribute('data-agy-footer-size') !== footerSize) {
        footer.setAttribute('data-agy-footer-size', footerSize);
      }
      const row2Attr = hasRow2Content && (footerSize === 'narrow' || footerSize === 'xs') ? 'true' : 'false';
      if (footer.getAttribute('data-agy-has-row2') !== row2Attr) {
        footer.setAttribute('data-agy-has-row2', row2Attr);
      }
    }
  }

  let lastRatioText = '';

  function syncContextCapsule() {
    const ring = document.getElementById('ag-claude-ctx-ring');
    const pop = document.getElementById('ag-claude-quota-popover');
    const ovCtxCard = document.querySelector('#ag-claude-ov-sections [data-ov-card="context"]');
    if (!ring) return;

    const footer = ring.closest('.agy-composer-footer');
    const footerSize = footer?.getAttribute('data-agy-footer-size') || 'wide';
    const cState = ring.getAttribute('data-compact-state');
    const title = ring.getAttribute('title') || '';

    let ratioText = '';
    const rm = title.match(/(\d+(?:\.\d+)?[kKmM]?\s*\/\s*\d+(?:\.\d+)?[kKmM]?)/);
    if (rm) ratioText = rm[1].replace(/\s*\/\s*/, ' / ');
    lastRatioText = ratioText;

    if (pop) watchPopoverSync(pop, () => lastRatioText);

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
      if (ovCtxCard) ovCtxCard.removeAttribute('data-agy-ctx-tier');
      return;
    }

    // Full "used / limit" in wide & narrow 2-row mode; condense to "%" only on ultra-narrow (<315px) panes
    const displayText = footerSize === 'xs'
      ? (Number.isFinite(pct) ? `${Math.round(pct)}%` : (ratioText ? ratioText.split('/')[0].trim() : ''))
      : ratioText;

    if (displayText) {
      if (ratioSpan.textContent !== displayText) ratioSpan.textContent = displayText;
      ratioSpan.hidden = false;
      ring.setAttribute('data-agy-has-ratio', 'true');
    } else {
      ratioSpan.textContent = '';
      ratioSpan.hidden = true;
      ring.removeAttribute('data-agy-has-ratio');
    }

    if (pop && ratioText) simplifyPopoverReset(pop, ratioText);

    if (cState === 'compacted') {
      ring.removeAttribute('data-agy-ctx-tier');
      if (pop) pop.removeAttribute('data-agy-ctx-tier');
      if (ovCtxCard) ovCtxCard.removeAttribute('data-agy-ctx-tier');
      return;
    }

    // Unified 3-tier thresholds (0 / 60% / 75%) across Footer, Quota Popover, and Overview Context card
    const tier = !Number.isFinite(pct) || pct < 60 ? 'cool' : pct >= 75 ? 'crit' : 'warn';
    if (ring.getAttribute('data-agy-ctx-tier') !== tier) ring.setAttribute('data-agy-ctx-tier', tier);
    if (pop && pop.getAttribute('data-agy-ctx-tier') !== tier) pop.setAttribute('data-agy-ctx-tier', tier);
    if (ovCtxCard && ovCtxCard.getAttribute('data-agy-ctx-tier') !== tier) {
      ovCtxCard.setAttribute('data-agy-ctx-tier', tier);
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
    const cid = getActiveRouteCid();
    if (cid !== speedActivity.lastCid) {
      speedActivity.lastCid = cid;
      speedActivity.coolUntil = 0;
      speedActivity.lastMetricsText = '';
    }

    const running = isComposerRunning();
    const validMetrics = hasValidMetricsForCurrentChat();

    // Clear stale spans from previous conversations so Working… works cleanly on every new chat
    if (!validMetrics) {
      for (const ch of Array.from(textEl.children)) {
        if (ch.getAttribute('data-agy-working-label') !== '1') ch.remove();
      }
      const tt = document.getElementById('ag-live-metrics-tooltip');
      if (tt) {
        tt.removeAttribute('data-visible');
        tt.removeAttribute('data-ag-pinned');
      }
    }

    const existingPlaceholder = textEl.querySelector('[data-agy-working-label="1"]');
    const hasRealContent = validMetrics && Array.from(textEl.children).some(
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
    if (hasRealContent) {
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
    wrapEnsureMetricsPillOnce();
    syncSpeedCapsule();
    syncContextCapsule();
    syncFooterResponsiveLayout();
    // Re-sync context display label in case footerSize just transitioned between wide/narrow/xs
    syncContextCapsule();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (wrappedEnsureMetricsPill && window.__ag_ensure_metrics_pill_fn === wrappedEnsureMetricsPill) {
      window.__ag_ensure_metrics_pill_fn = wrappedEnsureMetricsPill.__agyOrigEnsure;
    }
    wrappedEnsureMetricsPill = null;
    if (footerResizeObs) {
      footerResizeObs.disconnect();
      footerResizeObs = null;
    }
    observedFooters.clear();
    if (popObs) {
      popObs.disconnect();
      popObs = null;
    }
    observedPop = null;
    document.querySelectorAll('.agy-composer-footer[data-agy-footer-size]').forEach((el) => {
      el.removeAttribute('data-agy-footer-size');
      el.removeAttribute('data-agy-has-row2');
    });
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) {
      ring.removeAttribute('data-agy-ctx-tier');
      ring.removeAttribute('data-agy-has-ratio');
      ring.querySelector('.agy-ctx-ratio')?.remove();
    }
    document.getElementById('ag-claude-quota-popover')?.removeAttribute('data-agy-ctx-tier');
    document.querySelector('#ag-claude-ov-sections [data-ov-card="context"]')?.removeAttribute('data-agy-ctx-tier');
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
