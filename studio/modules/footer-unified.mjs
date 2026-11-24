/**
 * Unified Footer Runtime Module:
 * 1. Drives the permanent 2-row composer footer architecture across main & side-panel composers:
 *      Row 1 (above hairline): [ + ] ... [ Turbo ] [ Mic ] [ Send/Stop ]
 *      Row 2 (below hairline): [ Model ] [ Context ] [ Speed ] [ Subagent ]  (left-aligned)
 * 2. Computes deterministic 4-tier progressive compression (`full | compact | tight | icon`)
 *    via ResizeObserver (`data-agy-dock-tier`) with zero wrapping or clipping.
 * 3. Syncs Context Ratio + unified 0/60/75 3-tier warnings across Footer, Quota Popover,
 *    and Overview Context card.
 * 4. Enhances #ag-live-metrics-pill with live working indicator dot, color-coded tok/s
 *    tiers, and progressive compression spans (full -> no TTFT -> number only -> dot only).
 */

export function createFooterUnifiedRuntime({ onTierChange } = {}) {
  let disposed = false;
  let footerResizeObs = null;
  let resizeRafId = 0;
  let transitionSettleTimer = 0;
  const observedFooters = new Set();
  const observedWidths = new WeakMap();
  const layoutSigCache = new WeakMap();
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
    return document.documentElement.getAttribute('data-ag-ux-lang') === 'zh-CN';
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
      footerResizeObs = new ResizeObserver((entries) => {
        if (disposed) return;
        for (const entry of entries || []) {
          const w = Math.round(entry?.contentRect?.width || 0);
          if (w > 0 && entry.target) observedWidths.set(entry.target, w);
        }
        if (resizeRafId) return;
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = 0;
          if (disposed) return;
          sync();
          repositionOpenQuotaPopover();
          if (document.querySelector('[data-testid="aux-pane-split"][data-split-transition]')) {
            if (transitionSettleTimer) clearTimeout(transitionSettleTimer);
            transitionSettleTimer = setTimeout(() => {
              transitionSettleTimer = 0;
              if (!disposed) {
                sync();
                repositionOpenQuotaPopover();
              }
            }, 160);
          }
        });
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

  function hasExtraVisibleChip(leftGroup, addCtxBtnArg) {
    if (!leftGroup) return false;
    const addCtxBtn = addCtxBtnArg !== undefined ? addCtxBtnArg : leftGroup.querySelector(':scope > button:first-of-type');
    for (const ch of leftGroup.children) {
      if (ch.id === 'agy-capsule-picker-host' || ch.hasAttribute('data-agy-picker-host')) continue;
      if (ch.getAttribute?.('data-agy-model-wrap') === '1') continue;
      if (ch.id === 'ag-claude-ctx-ring' || ch.id === 'ag-live-metrics-pill' || ch.id === 'agy-resume-pill') continue;
      if (ch.hasAttribute('data-agy-sub-pill')) continue;
      if (ch.tagName === 'INPUT') continue;
      if (ch === addCtxBtn) continue;
      if (ch.getAttribute?.('data-deck-model-bubble') === 'hidden' || ch.querySelector?.('button[data-deck-model-bubble="hidden"]')) continue;
      const r = ch.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) return true;
    }
    return false;
  }

  const DOCK_TIERS = ['full', 'compact', 'tight', 'icon'];

  function computeDockTier(footerW, hasSubChip) {
    if (hasSubChip) {
      if (footerW >= 575) return 'full';
      if (footerW >= 445) return 'compact';
      if (footerW >= 305) return 'tight';
      return 'icon';
    }
    if (footerW >= 465) return 'full';
    if (footerW >= 355) return 'compact';
    if (footerW >= 255) return 'tight';
    return 'icon';
  }

  function applyDockTier(footer, leftGroup, dockTier) {
    if (footer.getAttribute('data-agy-has-row2') !== 'true') {
      footer.setAttribute('data-agy-has-row2', 'true');
    }
    if (footer.getAttribute('data-agy-dock-tier') !== dockTier) {
      footer.setAttribute('data-agy-dock-tier', dockTier);
    }
    const pickerHost = leftGroup?.querySelector(':scope > [data-agy-picker-host="1"]');
    if (pickerHost) {
      if (pickerHost.getAttribute('data-agy-dock-tier') !== dockTier) {
        pickerHost.setAttribute('data-agy-dock-tier', dockTier);
      }
      const strip = pickerHost.shadowRoot?.getElementById('deck-metrics-strip');
      if (strip && strip.getAttribute('data-dock-tier') !== dockTier) {
        strip.setAttribute('data-dock-tier', dockTier);
      }
    }
  }

  function isRow2Overflowing(footer, leftGroup, footerW, addCtxBtnArg) {
    if (!leftGroup) return false;
    const addCtxBtn = addCtxBtnArg !== undefined ? addCtxBtnArg : leftGroup.querySelector(':scope > button:first-of-type');
    const rects = [];

    const pickerHost = leftGroup.querySelector(':scope > [data-agy-picker-host="1"]');
    const modelBtn = pickerHost?.shadowRoot?.querySelector('button.dk-pill[data-el="modelPicker"]');
    if (modelBtn) {
      const mr = modelBtn.getBoundingClientRect();
      if (mr.width > 1 && mr.height > 1) rects.push(mr);
    }

    for (const ch of leftGroup.children) {
      if (ch === addCtxBtn || ch.id === 'agy-resume-pill') continue;
      if (ch.tagName === 'INPUT' || ch.hasAttribute('data-agy-picker-host') || ch.getAttribute?.('data-agy-model-wrap') === '1') continue;
      if (ch.getAttribute?.('data-deck-model-bubble') === 'hidden' || ch.querySelector?.('button[data-deck-model-bubble="hidden"]')) continue;
      const r = ch.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) rects.push(r);
    }

    if (rects.length <= 1) return false;
    const minTop = Math.min(...rects.map((r) => r.top));
    if (rects.some((r) => r.top - minTop > 10)) return true;
    const totalW = rects.reduce((sum, r) => sum + r.width, 0) + (rects.length - 1) * 5;
    return totalW > footerW - 2;
  }

  function buildFooterLayoutSig(footer, leftGroup, footerW, hasSubChip, addCtxBtn, speedPill, targetTier = '') {
    const pickerHost = leftGroup?.querySelector(':scope > [data-agy-picker-host="1"]');
    const strip = pickerHost?.shadowRoot?.getElementById('deck-metrics-strip');
    const modelBtn = strip?.querySelector('button.dk-pill[data-el="modelPicker"]');
    const modelLabel = modelBtn?.dataset?.label || '';
    const modelOrch = modelBtn?.getAttribute('data-is-orch') || '';
    const modelEffort = modelBtn?.querySelector('.dk-mp-effort')?.textContent || '';

    const ring = footer.querySelector('#ag-claude-ctx-ring');
    const ringHasRatio = ring?.getAttribute('data-agy-has-ratio') || '';
    const ringCompacting = ring?.getAttribute('data-agy-ctx-compacting') || '';
    const ringFullText = ring?.querySelector('.agy-ctx-full')?.textContent || '';

    const spd = speedPill || footer.querySelector('#ag-live-metrics-pill');
    const spdHidden = spd ? (spd.hidden ? '1' : '0') : '';
    const spdPlaceholder = spd?.getAttribute('data-agy-working-placeholder') || '';
    const spdTextLen = spd ? (spd.querySelector('#ag-live-metrics-text')?.textContent?.length || 0) : 0;

    const pillSigs = [];
    if (leftGroup) {
      for (const ch of leftGroup.children) {
        if (ch.hasAttribute('data-agy-sub-pill') || ch.id === 'agy-main-subagent-pill' || ch.id === 'agy-resume-pill') {
          pillSigs.push(`${ch.getAttribute('data-agy-sub-pill') || ch.id}:${ch.hidden ? '1' : '0'}:${ch.getAttribute('data-sig') || ''}`);
        } else if (
          ch.id !== 'agy-capsule-picker-host' &&
          !ch.hasAttribute('data-agy-picker-host') &&
          ch.id !== 'ag-claude-ctx-ring' &&
          ch.id !== 'ag-live-metrics-pill' &&
          ch.tagName !== 'INPUT' &&
          ch !== addCtxBtn &&
          ch.getAttribute?.('data-deck-model-bubble') !== 'hidden' &&
          !ch.querySelector?.('button[data-deck-model-bubble="hidden"]')
        ) {
          pillSigs.push(`extra:${ch.getAttribute('data-sig') || ch.textContent?.trim() || ''}`);
        }
      }
    }

    const lang = document.documentElement.getAttribute('data-ag-ux-lang') || '';
    const addLabel = addCtxBtn?.getAttribute('aria-label') || '';
    const curTier = footer.getAttribute('data-agy-dock-tier') || '';
    const stripTier = strip?.getAttribute('data-dock-tier') || '';
    const hasRow2 = footer.getAttribute('data-agy-has-row2') || '';

    return [
      footerW,
      hasSubChip ? 1 : 0,
      modelLabel,
      modelOrch,
      modelEffort,
      ringHasRatio,
      ringCompacting,
      ringFullText,
      spdHidden,
      spdPlaceholder,
      spdTextLen,
      pillSigs.join(';'),
      lang,
      addLabel,
      curTier,
      stripTier,
      hasRow2,
      targetTier,
    ].join('|');
  }

  function syncFooterResponsiveLayout() {
    const excluded = '[data-testid="side-question-tab-content"], [data-testid="voice-dock-composer"]';
    const footers = Array.from(document.querySelectorAll('.agy-composer-footer')).filter(
      (f) => !f.closest(excluded)
    );
    watchFooters(footers);
    const splitAnimating = Boolean(document.querySelector('[data-testid="aux-pane-split"][data-split-transition]'));

    for (const footer of footers) {
      const cachedW = observedWidths.get(footer);
      const footerW = cachedW > 0 ? cachedW : Math.round(footer.getBoundingClientRect().width);
      if (footerW <= 0) continue;

      const leftGroup = footer.children[0];
      // Disable redundant hover tooltip on [+ Add context] button (button itself displays the label)
      const addCtxBtn = leftGroup?.querySelector(':scope > button:first-of-type');
      if (addCtxBtn) {
        const tipId = addCtxBtn.getAttribute('data-tooltip-id');
        if (tipId) {
          addCtxBtn.setAttribute('data-agy-suppressed-tip', tipId);
          addCtxBtn.removeAttribute('data-tooltip-id');
        }
        if (addCtxBtn.hasAttribute('title')) addCtxBtn.removeAttribute('title');
        const suppressed = addCtxBtn.getAttribute('data-agy-suppressed-tip');
        if (suppressed) {
          const tipNode = document.getElementById(suppressed);
          if (tipNode && tipNode.style.display !== 'none') tipNode.style.display = 'none';
        }
      }
      const speedPill = footer.querySelector('#ag-live-metrics-pill')
        || (footer.nextElementSibling?.id === 'ag-live-metrics-pill' ? footer.nextElementSibling : null);

      if (leftGroup && speedPill && speedPill.parentElement !== leftGroup) {
        leftGroup.appendChild(speedPill);
        if (speedPill.getAttribute('data-ag-row-mode') !== 'middle') {
          speedPill.setAttribute('data-ag-row-mode', 'middle');
        }
        if (footer.getAttribute('data-ag-row-mode') !== 'middle') {
          footer.setAttribute('data-ag-row-mode', 'middle');
        }
      }

      const hasSubChip = hasExtraVisibleChip(leftGroup, addCtxBtn);
      const targetTier = computeDockTier(footerW, hasSubChip);
      const sigW = splitAnimating ? Math.floor(footerW / 24) * 24 : footerW;
      const prevSig = buildFooterLayoutSig(footer, leftGroup, sigW, hasSubChip, addCtxBtn, speedPill, targetTier);
      if (layoutSigCache.get(footer) === prevSig) {
        continue;
      }

      const prevTier = footer.getAttribute('data-agy-dock-tier') || '';
      let tierIdx = DOCK_TIERS.indexOf(targetTier);
      if (tierIdx < 0) tierIdx = 0;

      applyDockTier(footer, leftGroup, DOCK_TIERS[tierIdx]);
      while (tierIdx < DOCK_TIERS.length - 1 && isRow2Overflowing(footer, leftGroup, footerW, addCtxBtn)) {
        tierIdx += 1;
        applyDockTier(footer, leftGroup, DOCK_TIERS[tierIdx]);
      }

      layoutSigCache.set(
        footer,
        buildFooterLayoutSig(footer, leftGroup, sigW, hasSubChip, addCtxBtn, speedPill, targetTier)
      );

      if (DOCK_TIERS[tierIdx] !== prevTier && typeof onTierChange === 'function') {
        onTierChange();
      }
    }
  }

  let lastRatioText = '';

  function syncContextCapsule() {
    const ring = document.getElementById('ag-claude-ctx-ring');
    const pop = document.getElementById('ag-claude-quota-popover');
    const ovCtxCard = document.querySelector('#ag-claude-ov-sections [data-ov-card="context"]');
    if (!ring) return;

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
    let pm = null;
    if (!Number.isFinite(pct) && pop) {
      const pctEl = pop.querySelector('.ag-qp-item .ag-qp-pct');
      pm = (pctEl?.textContent || '').match(/(\d+(?:\.\d+)?)%/);
      if (pm) pct = parseFloat(pm[1]);
    }
    const arc = ring.querySelector('.ag-ctx-ring-arc');
    let hasArcPct = false;
    if (!Number.isFinite(pct)) {
      const offset = parseFloat(arc?.style?.strokeDashoffset || '');
      if (Number.isFinite(offset)) {
        const circ = 2 * Math.PI * 7;
        pct = Math.max(0, Math.min(100, Math.round((1 - offset / circ) * 100)));
        hasArcPct = arc?.style?.strokeOpacity !== '0';
      }
    }

    let ratioSpan = ring.querySelector('.agy-ctx-ratio');
    if (!ratioSpan) {
      ratioSpan = document.createElement('span');
      ratioSpan.className = 'agy-ctx-ratio';
      ring.appendChild(ratioSpan);
    }
    let fullSpan = ratioSpan.querySelector('.agy-ctx-full');
    if (!fullSpan) {
      fullSpan = document.createElement('span');
      fullSpan.className = 'agy-ctx-full';
      ratioSpan.appendChild(fullSpan);
    }
    let tightSpan = ratioSpan.querySelector('.agy-ctx-tight');
    if (!tightSpan) {
      tightSpan = document.createElement('span');
      tightSpan.className = 'agy-ctx-tight';
      ratioSpan.appendChild(tightSpan);
    }

    const isCompacting = cState === 'compacting';
    const compactingAttr = isCompacting ? '1' : '0';
    if (ring.getAttribute('data-agy-ctx-compacting') !== compactingAttr) {
      ring.setAttribute('data-agy-ctx-compacting', compactingAttr);
    }

    let fullText = '';
    let tightText = '';
    if (isCompacting) {
      fullText = isZhUi() ? '压缩中…' : 'Compacting…';
      tightText = '';
    } else {
      fullText = ratioText;
      const hasPctSource = Boolean(ratioText || m || pm || hasArcPct);
      tightText = hasPctSource && Number.isFinite(pct)
        ? `${Math.round(pct)}%`
        : (ratioText ? ratioText.split('/')[0].trim() : '');
    }

    if (fullSpan.textContent !== fullText) fullSpan.textContent = fullText;
    if (tightSpan.textContent !== tightText) tightSpan.textContent = tightText;

    const hasRatio = Boolean(fullText || tightText);
    if (ratioSpan.hidden !== !hasRatio) ratioSpan.hidden = !hasRatio;
    if (hasRatio) {
      if (ring.getAttribute('data-agy-has-ratio') !== 'true') {
        ring.setAttribute('data-agy-has-ratio', 'true');
      }
    } else if (ring.hasAttribute('data-agy-has-ratio')) {
      ring.removeAttribute('data-agy-has-ratio');
    }

    if (isCompacting) {
      if (ring.hasAttribute('data-agy-ctx-tier')) ring.removeAttribute('data-agy-ctx-tier');
      if (pop && pop.hasAttribute('data-agy-ctx-tier')) pop.removeAttribute('data-agy-ctx-tier');
      if (ovCtxCard && ovCtxCard.hasAttribute('data-agy-ctx-tier')) ovCtxCard.removeAttribute('data-agy-ctx-tier');
      return;
    }

    if (pop && ratioText) simplifyPopoverReset(pop, ratioText);

    if (cState === 'compacted') {
      if (ring.hasAttribute('data-agy-ctx-tier')) ring.removeAttribute('data-agy-ctx-tier');
      if (pop && pop.hasAttribute('data-agy-ctx-tier')) pop.removeAttribute('data-agy-ctx-tier');
      if (ovCtxCard && ovCtxCard.hasAttribute('data-agy-ctx-tier')) ovCtxCard.removeAttribute('data-agy-ctx-tier');
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
      (ch) =>
        ch.getAttribute('data-agy-working-label') !== '1' &&
        ch.getAttribute('data-agy-speed-short') !== '1' &&
        (ch.textContent || '').trim() !== ''
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
      if (pill.getAttribute('data-agy-working-placeholder') !== 'true') {
        pill.setAttribute('data-agy-working-placeholder', 'true');
      }
    } else {
      if (existingPlaceholder) existingPlaceholder.remove();
      if (pill.hasAttribute('data-agy-working-placeholder')) {
        pill.removeAttribute('data-agy-working-placeholder');
      }
    }

    let tps = NaN;
    let speedNumStr = '';
    const fullParts = [];
    if (hasRealContent) {
      for (const child of Array.from(textEl.children)) {
        if (child.getAttribute('data-agy-speed-short') === '1') continue;
        if (child.getAttribute('data-agy-working-label') === '1') continue;
        const txt = (child.textContent || '').trim();
        if (txt) fullParts.push(txt);
        const tm = txt.match(/^([\d.]+)\s*tok\/s$/i);
        if (tm) {
          tps = parseFloat(tm[1]);
          speedNumStr = String(Math.round(tps));
          if (child.getAttribute('data-agy-speed-num') !== '1') {
            child.setAttribute('data-agy-speed-num', '1');
          }
          if (child.hasAttribute('data-agy-speed-extra')) {
            child.removeAttribute('data-agy-speed-extra');
          }
        } else {
          if (child.getAttribute('data-agy-speed-num') === '1') {
            child.removeAttribute('data-agy-speed-num');
          }
          // Tag separator & TTFT spans so compact/tight tiers can cleanly hide them via CSS
          if (child.getAttribute('data-agy-speed-extra') !== '1') {
            child.setAttribute('data-agy-speed-extra', '1');
          }
        }
      }
    }

    // Maintain a compact number-only span ("108") for `tight` tier without touching runtime.js spans
    let shortSpan = textEl.querySelector('[data-agy-speed-short="1"]');
    if (speedNumStr) {
      if (!shortSpan) {
        shortSpan = document.createElement('span');
        shortSpan.setAttribute('data-agy-speed-short', '1');
        textEl.insertBefore(shortSpan, textEl.firstChild);
      }
      if (shortSpan.textContent !== speedNumStr) shortSpan.textContent = speedNumStr;
    } else if (shortSpan) {
      shortSpan.remove();
    }

    const currentText = fullParts.join(' ');
    if (currentText && pill.title !== currentText) {
      pill.title = currentText;
    }

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
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (wrappedEnsureMetricsPill && window.__ag_ensure_metrics_pill_fn === wrappedEnsureMetricsPill) {
      window.__ag_ensure_metrics_pill_fn = wrappedEnsureMetricsPill.__agyOrigEnsure;
    }
    wrappedEnsureMetricsPill = null;
    if (resizeRafId) {
      cancelAnimationFrame(resizeRafId);
      resizeRafId = 0;
    }
    if (transitionSettleTimer) {
      clearTimeout(transitionSettleTimer);
      transitionSettleTimer = 0;
    }
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
    document.querySelectorAll('.agy-composer-footer[data-agy-dock-tier]').forEach((el) => {
      el.removeAttribute('data-agy-dock-tier');
      el.removeAttribute('data-agy-has-row2');
    });
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) {
      ring.removeAttribute('data-agy-ctx-tier');
      ring.removeAttribute('data-agy-ctx-compacting');
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
      pill.querySelector('[data-agy-speed-short="1"]')?.remove();
      pill.querySelectorAll('[data-agy-speed-num="1"]').forEach((el) => el.removeAttribute('data-agy-speed-num'));
      pill.querySelectorAll('[data-agy-speed-extra="1"]').forEach((el) => el.removeAttribute('data-agy-speed-extra'));
    }
  }

  return { sync, dispose };
}
