/**
 * Unified Footer Runtime Module:
 * 1. Drives the permanent 2-row composer footer architecture across main & side-panel composers:
 *      Row 1 (above hairline): [ + ] ... [ Turbo ] [ Mic ] [ Send/Stop ]
 *      Row 2 (below hairline): [ Model ] [ Context ] [ Speed ] [ Subagent ]  (left-aligned)
 * 2. Computes deterministic 4-tier progressive compression (`full | compact | tight | icon`)
 *    via ResizeObserver (`data-agy-dock-tier`) with zero wrapping or clipping.
 * 3. Syncs Context Ratio + unified 0/60/75 3-tier warnings across Footer, Quota Popover,
 *    and Overview Context card.
 * 4. Enhances #ag-live-metrics-pill with permanent child slots (0 innerHTML / 0 childList churn),
 *    live working dot, color-coded tok/s tiers, and progressive compression.
 */
import { markOwn, setAttr, setLeafText } from '../core/dom.mjs';
import { getActiveRouteCid, isComposerRunning, isZhUi } from '../core/env.mjs';
import { installMetricsBus, renderSpeedSlots } from '../core/metrics-bus.mjs';

export function createFooterUnifiedRuntime({ onTierChange, kernel } = {}) {
  let disposed = false;
  let footerResizeObs = null;
  let resizeRafId = 0;
  let transitionSettleTimer = 0;
  const observedFooters = new Set();
  const observedWidths = new WeakMap();
  const layoutSigCache = new WeakMap();
  let wrappedEnsureMetricsPill = null;
  let metricsBusCleanup = null;

  const speedActivity = {
    running: false,
    coolUntil: 0,
    lastMetricsText: '',
    lastCid: '',
  };

  function wrapEnsureMetricsPillOnce() {
    if (typeof window === 'undefined') return;
    const cur = window.__ag_ensure_metrics_pill_fn;
    if (typeof cur !== 'function' || cur === wrappedEnsureMetricsPill) return;
    const orig = cur.__agyOrigEnsure || cur;
    const wrapped = function (...args) {
      const pill = orig.apply(this, args);
      if (!disposed && pill) {
        markOwn(pill);
        const footer = document.querySelector('#antigravity\\.agentSidePanelInputBox .agy-composer-footer')
          || document.querySelector('.agy-composer-footer');
        const leftGroup = footer?.children?.[0];
        if (leftGroup && pill.parentElement !== leftGroup) {
          leftGroup.appendChild(pill);
        }
        setAttr(pill, 'data-ag-row-mode', 'middle');
        if (footer) setAttr(footer, 'data-ag-row-mode', 'middle');
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
    if (firstReset) setLeafText(firstReset, ratioText);
  }

  let lastRatioText = '';
  const onQuotaPopRendered = () => {
    if (disposed || !lastRatioText) return;
    const pop = document.getElementById('ag-claude-quota-popover');
    if (pop) simplifyPopoverReset(pop, lastRatioText);
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('agy:quota-popover-rendered', onQuotaPopRendered);
  }

  function hasExtraVisibleChip(leftGroup, addCtxBtnArg) {
    if (!leftGroup) return false;
    const addCtxBtn = addCtxBtnArg !== undefined ? addCtxBtnArg : leftGroup.querySelector(':scope > button:first-of-type');
    for (const ch of leftGroup.children) {
      if (ch.id === 'agy-capsule-picker-host' || ch.hasAttribute('data-agy-picker-host')) continue;
      if (ch.getAttribute?.('data-agy-model-wrap') === '1') continue;
      if (ch.id === 'ag-claude-ctx-ring' || ch.id === 'ag-live-metrics-pill' || ch.id === 'agy-resume-pill' || ch.id === 'agy-opus-gate-pill' || ch.id === 'agy-auto-compact-pill') continue;
      if (ch.hasAttribute('data-agy-sub-pill')) continue;
      if (ch.id === 'agy-main-subagent-pill') {
        if (!ch.hidden && ch.style.display !== 'none') return true;
        continue;
      }
      if (ch.tagName === 'INPUT') continue;
      if (ch === addCtxBtn) continue;
      if (ch.getAttribute?.('data-deck-model-bubble') === 'hidden' || ch.querySelector?.('button[data-deck-model-bubble="hidden"]')) continue;
      if (ch.hidden || ch.style.display === 'none') continue;
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
    setAttr(footer, 'data-agy-has-row2', 'true');
    setAttr(footer, 'data-agy-dock-tier', dockTier);
    const pickerHost = leftGroup?.querySelector(':scope > [data-agy-picker-host="1"]');
    if (pickerHost) {
      setAttr(pickerHost, 'data-agy-dock-tier', dockTier);
      const strip = pickerHost.shadowRoot?.getElementById('deck-metrics-strip');
      if (strip) setAttr(strip, 'data-dock-tier', dockTier);
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
      if (ch === addCtxBtn || ch.id === 'agy-resume-pill' || ch.id === 'agy-opus-gate-pill' || ch.id === 'agy-auto-compact-pill') continue;
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
    const ringHasTight = ring?.getAttribute('data-agy-has-tight') || '';
    const ringCompacting = ring?.getAttribute('data-agy-ctx-compacting') || '';
    const ringFullText = ring?.querySelector('.agy-ctx-full')?.textContent || '';

    const spd = speedPill || footer.querySelector('#ag-live-metrics-pill');
    const spdHidden = spd ? (spd.hidden ? '1' : '0') : '';
    const spdPlaceholder = spd?.getAttribute('data-agy-working-placeholder') || '';
    const spdTextLen = spd ? (spd.querySelector('#ag-live-metrics-text')?.textContent?.length || 0) : 0;

    const pillSigs = [];
    if (leftGroup) {
      for (const ch of leftGroup.children) {
        if (ch.hasAttribute('data-agy-sub-pill') || ch.id === 'agy-main-subagent-pill' || ch.id === 'agy-resume-pill' || ch.id === 'agy-opus-gate-pill' || ch.id === 'agy-auto-compact-pill') {
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
      ringHasTight,
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

  function readContextData(snapshot) {
    const ring = document.getElementById('ag-claude-ctx-ring');
    const pop = document.getElementById('ag-claude-quota-popover');
    const ovCtxCard = document.querySelector('#ag-claude-ov-sections [data-ov-card="context"]');
    if (!ring) return null;

    const cState = ring.getAttribute('data-compact-state');
    const title = ring.getAttribute('title') || '';
    let ratioText = '';
    const rm = title.match(/(\d+(?:\.\d+)?[kKmM]?\s*\/\s*\d+(?:\.\d+)?[kKmM]?)/);
    if (rm) ratioText = rm[1].replace(/\s*\/\s*/, ' / ');

    let pct = NaN;
    const m = title.match(/\((\d+(?:\.\d+)?)%/);
    if (m) pct = parseFloat(m[1]);
    let pm = null;
    if (!Number.isFinite(pct) && ratioText && pop && pop.getAttribute('data-open') === 'true') {
      const pctEl = pop.querySelector('.ag-qp-item .ag-qp-pct');
      pm = (pctEl?.textContent || '').match(/(\d+(?:\.\d+)?)%/);
      if (pm) pct = parseFloat(pm[1]);
    }
    const arc = ring.querySelector('.ag-ctx-ring-arc');
    let hasArcPct = false;
    if (!Number.isFinite(pct) && cState !== 'compacted') {
      const offset = parseFloat(arc?.style?.strokeDashoffset || '');
      if (Number.isFinite(offset)) {
        const circ = 2 * Math.PI * 7;
        const arcPct = Math.max(0, Math.min(100, Math.round((1 - offset / circ) * 100)));
        if (arc?.style?.strokeOpacity !== '0' && arcPct > 0) {
          pct = arcPct;
          hasArcPct = true;
        }
      }
    }

    const isZh = snapshot ? snapshot.isZh : isZhUi();
    const isCompacting = cState === 'compacting';
    let fullText = '';
    let tightText = '';
    if (isCompacting) {
      fullText = isZh ? '压缩中…' : 'Compacting…';
      tightText = '';
    } else {
      const hasPctSource = Boolean(ratioText || m || pm || hasArcPct);
      tightText = hasPctSource && Number.isFinite(pct)
        ? `${Math.round(pct)}%`
        : (ratioText ? ratioText.split('/')[0].trim() : '');
      fullText = ratioText || tightText;
    }
    const hasRatio = Boolean(fullText || tightText);
    const hasTight = Boolean(tightText);
    const tier = isCompacting || cState === 'compacted'
      ? null
      : (!Number.isFinite(pct) || pct < 60 ? 'cool' : pct >= 75 ? 'crit' : 'warn');

    return {
      ring,
      pop,
      ovCtxCard,
      ratioText,
      isCompacting,
      compactingAttr: isCompacting ? '1' : '0',
      fullText,
      tightText,
      hasRatio,
      hasTight,
      tier,
    };
  }

  function writeContextData(ctx) {
    if (!ctx || !ctx.ring) return;
    const { ring, pop, ovCtxCard, ratioText, isCompacting, compactingAttr, fullText, tightText, hasRatio, hasTight, tier } = ctx;
    markOwn(ring);
    lastRatioText = ratioText;

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

    setAttr(ring, 'data-agy-ctx-compacting', compactingAttr);
    setLeafText(fullSpan, fullText);
    setLeafText(tightSpan, tightText);

    if (ratioSpan.hidden !== !hasRatio) ratioSpan.hidden = !hasRatio;
    setAttr(ring, 'data-agy-has-ratio', hasRatio ? 'true' : null);
    setAttr(ring, 'data-agy-has-tight', hasTight ? '1' : '0');

    if (!isCompacting && pop && ratioText && pop.getAttribute('data-open') === 'true') simplifyPopoverReset(pop, ratioText);
    setAttr(ring, 'data-agy-ctx-tier', tier);
    if (pop) setAttr(pop, 'data-agy-ctx-tier', tier);
    if (ovCtxCard) setAttr(ovCtxCard, 'data-agy-ctx-tier', tier);
  }

  function readFootersLayout(snapshot) {
    const excluded = '[data-testid="side-question-tab-content"], [data-testid="voice-dock-composer"]';
    const footers = snapshot
      ? snapshot.footers
      : Array.from(document.querySelectorAll('.agy-composer-footer')).filter((f) => !f.closest(excluded));
    const splitAnimating = snapshot
      ? snapshot.splitAnimating
      : Boolean(document.querySelector('[data-testid="aux-pane-split"][data-split-transition]'));

    const items = [];
    for (const footer of footers) {
      const cachedW = observedWidths.get(footer);
      const footerW = cachedW > 0 ? cachedW : Math.round(footer.getBoundingClientRect().width);
      if (footerW <= 0) continue;
      const leftGroup = footer.children[0];
      const addCtxBtn = leftGroup?.querySelector(':scope > button:first-of-type') || null;
      const speedPill = footer.querySelector('#ag-live-metrics-pill')
        || (footer.nextElementSibling?.id === 'ag-live-metrics-pill' ? footer.nextElementSibling : null);
      const hasSubChip = hasExtraVisibleChip(leftGroup, addCtxBtn);
      const targetTier = computeDockTier(footerW, hasSubChip);
      const sigW = splitAnimating ? Math.floor(footerW / 24) * 24 : footerW;
      items.push({ footer, leftGroup, addCtxBtn, speedPill, footerW, sigW, hasSubChip, targetTier });
    }
    return { footers, items };
  }

  function writeFootersLayout(layoutData) {
    if (!layoutData) return;
    watchFooters(layoutData.footers);

    for (const item of layoutData.items) {
      const { footer, leftGroup, addCtxBtn, speedPill, footerW, sigW, hasSubChip, targetTier } = item;
      const shell = footer.parentElement;
      if (shell && shell.tagName === 'DIV' && footer.closest?.('[data-testid="agent-input-box"]')) {
        setAttr(shell, 'data-maga-footer-shell', '1');
      }
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

      if (leftGroup && speedPill && speedPill.parentElement !== leftGroup) {
        leftGroup.appendChild(speedPill);
        setAttr(speedPill, 'data-ag-row-mode', 'middle');
        setAttr(footer, 'data-ag-row-mode', 'middle');
      }

      const prevSig = buildFooterLayoutSig(footer, leftGroup, sigW, hasSubChip, addCtxBtn, speedPill, targetTier);
      if (layoutSigCache.get(footer) === prevSig) continue;

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

  function writeSpeedCapsule(speedData) {
    if (!speedData || !speedData.pill || !speedData.textEl) return;
    const { pill, textEl, cid, running, isZh, now, payload } = speedData;
    const { parsed } = renderSpeedSlots(pill, textEl, payload, { cid, running, isZh });

    if (!parsed) {
      const tt = document.getElementById('ag-live-metrics-tooltip');
      if (tt) {
        tt.removeAttribute('data-visible');
        tt.removeAttribute('data-ag-pinned');
      }
    }

    if (cid !== speedActivity.lastCid) {
      speedActivity.lastCid = cid;
      speedActivity.coolUntil = 0;
      speedActivity.lastMetricsText = '';
    }

    const currentText = parsed?.fullText || '';
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
    const tps = parsed ? parsed.tps : NaN;
    const tier = !Number.isFinite(tps) || tps <= 0
      ? 'unknown'
      : tps >= 25
        ? 'fast'
        : tps >= 10
          ? 'mid'
          : 'slow';

    setAttr(pill, 'data-agy-motion', motion);
    setAttr(pill, 'data-agy-speed-tier', tier);
  }

  function read(snapshot = null) {
    if (disposed) return null;
    const pill = document.getElementById('ag-live-metrics-pill');
    const textEl = pill?.querySelector('#ag-live-metrics-text') || null;
    const cid = snapshot ? snapshot.cid : getActiveRouteCid();
    const running = snapshot ? snapshot.isRunning : isComposerRunning();
    const isZh = snapshot ? snapshot.isZh : isZhUi();
    const now = snapshot ? snapshot.now : Date.now();
    const payload = snapshot ? snapshot.metrics : (typeof window !== 'undefined' ? window.__ag_last_metrics || null : null);

    return {
      speedData: pill && textEl ? { pill, textEl, cid, running, isZh, now, payload } : null,
      contextData: readContextData(snapshot),
      layoutData: readFootersLayout(snapshot),
    };
  }

  function write(snapshot = null, planArg = undefined) {
    if (disposed) return;
    wrapEnsureMetricsPillOnce();
    const plan = planArg !== undefined ? planArg : read(snapshot);
    if (!plan) return;
    writeSpeedCapsule(plan.speedData);
    writeContextData(plan.contextData);
    writeFootersLayout(plan.layoutData);
  }

  function mount() {
    if (disposed || metricsBusCleanup) return;
    if (typeof window !== 'undefined' && window.__ag_metrics_ro) {
      try { window.__ag_metrics_ro.disconnect(); } catch {}
      window.__ag_metrics_ro = null;
    }
    metricsBusCleanup = installMetricsBus({
      onMetrics: () => {
        if (!disposed) kernel?.markDirty('metrics', true);
      },
    });
  }

  function sync() {
    if (disposed) return;
    write(null, read(null));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    metricsBusCleanup?.();
    metricsBusCleanup = null;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('agy:quota-popover-rendered', onQuotaPopRendered);
    }
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
    document.querySelectorAll('.agy-composer-footer[data-agy-dock-tier]').forEach((el) => {
      el.removeAttribute('data-agy-dock-tier');
      el.removeAttribute('data-agy-has-row2');
    });
    document.querySelectorAll('[data-maga-footer-shell]').forEach((el) => {
      el.removeAttribute('data-maga-footer-shell');
    });
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) {
      ring.removeAttribute('data-agy-ctx-tier');
      ring.removeAttribute('data-agy-ctx-compacting');
      ring.removeAttribute('data-agy-has-ratio');
      ring.removeAttribute('data-agy-has-tight');
      ring.querySelector('.agy-ctx-ratio')?.remove();
    }
    document.getElementById('ag-claude-quota-popover')?.removeAttribute('data-agy-ctx-tier');
    document.querySelector('#ag-claude-ov-sections [data-ov-card="context"]')?.removeAttribute('data-agy-ctx-tier');
    const pill = document.getElementById('ag-live-metrics-pill');
    if (pill) {
      pill.removeAttribute('data-agy-motion');
      pill.removeAttribute('data-agy-speed-tier');
      pill.removeAttribute('data-agy-has-speed-num');
      pill.removeAttribute('data-agy-working-placeholder');
      pill.querySelector(':scope > .agy-speed-dot')?.remove();
      const textEl = pill.querySelector('#ag-live-metrics-text');
      if (textEl) {
        textEl.removeAttribute('data-agy-speed-slots');
        delete textEl._agySlots;
      }
      pill.querySelector('[data-agy-working-label="1"]')?.remove();
      pill.querySelector('[data-agy-speed-short="1"]')?.remove();
      pill.querySelectorAll('[data-agy-speed-num="1"]').forEach((el) => el.removeAttribute('data-agy-speed-num'));
      pill.querySelectorAll('[data-agy-speed-extra="1"]').forEach((el) => el.removeAttribute('data-agy-speed-extra'));
    }
  }

  return {
    topics: ['composer', 'metrics', 'route', 'prefs', 'subagent'],
    mount,
    read,
    write,
    sync,
    dispose,
  };
}
