/**
 * Internalized agy-capsule model picker module (Shadow DOM isolated, zero sidecar).
 * Harmonizes the footer model+effort trigger into a cohesive model-tinted capsule
 * matching the Context and Speed pills in both Light and Dark modes.
 */

export function buildPickerShadowCss({ effortBarCss, agentEntryCss }) {
  return `
#deck-metrics-strip, #deck-metrics-strip * { box-sizing: border-box; }
#deck-metrics-strip {
  display: inline-flex;
  align-items: center;
  flex: 0 1 auto;
  order: var(--agy-model-order, 0);
  min-width: 0;
  max-width: 100%;
  gap: 0;
  margin: 0;
  font-size: 12.5px;
  font-weight: 400;
  line-height: normal;
  color: var(--secondary-foreground, var(--foreground, #3f3f46));
  user-select: none;
  position: relative;
  -webkit-font-smoothing: antialiased;
}
#deck-metrics-strip .dk-pill {
  font: inherit;
  color: inherit;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 5px;
  border-radius: 6px;
  cursor: default;
  position: relative;
  background: transparent;
  border: none;
  white-space: nowrap;
  transition: background 0.14s ease, box-shadow 0.14s ease, color 0.14s ease;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"],
.dk-model-options,
.dk-model-sub,
.dk-model-tiers,
.dk-model-tip {
  font-family: var(--font-sans, "Google Sans Flex", -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif);
  font-size: 12.5px;
  font-weight: 400;
  line-height: 16px;
  letter-spacing: 0;
  -webkit-font-smoothing: antialiased;
}

/* Pill 1: Unified Model + Effort Capsule (harmonized with Context & Speed pills) */
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] {
  --agy-model-accent: #7c5ce6;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  min-width: 0;
  max-width: min(22em, 100%);
  padding: 0 6.5px 0 7.5px;
  margin-right: 0;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  color: var(--foreground, #1C1C1A);
  background: color-mix(in srgb, var(--agy-model-accent) 7%, var(--agy-pill-bg, rgba(128, 128, 128, 0.06)));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agy-model-accent) 20%, var(--agy-pill-border, rgba(128, 128, 128, 0.12)));
  transition: background-color 140ms ease, box-shadow 140ms ease, color 140ms ease;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"]:hover,
#deck-metrics-strip button.dk-pill[data-el="modelPicker"]:focus-visible {
  background: color-mix(in srgb, var(--agy-model-accent) 13%, var(--agy-pill-bg-hover, rgba(128, 128, 128, 0.11)));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agy-model-accent) 34%, var(--agy-pill-border-hover, rgba(128, 128, 128, 0.2)));
  color: var(--foreground, #141413);
  outline: none;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .agy-mp-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background-color: var(--agy-model-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--agy-model-accent) 18%, transparent);
  transition: background-color 180ms ease, box-shadow 180ms ease, transform 140ms ease;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"]:hover .agy-mp-dot {
  transform: scale(1.1);
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .dk-mp-text {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .dk-mp-name {
  color: inherit;
  font-weight: 450;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .dk-mp-effort {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  height: 17px;
  padding: 0 5.5px;
  margin-left: 5px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--agy-model-accent) 14%, transparent);
  color: color-mix(in srgb, var(--agy-model-accent) 72%, var(--foreground, #1C1C1A)) !important;
  opacity: 1;
  font-size: 11px;
  font-weight: 500 !important;
  line-height: 17px;
  letter-spacing: 0.01em;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .dk-mp-effort:empty {
  display: none !important;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .dk-mp-down {
  width: 12.5px;
  height: 12.5px;
  flex-shrink: 0;
  display: block;
  color: var(--muted-foreground, #787774);
  opacity: 0.85;
  margin-left: -1px;
}

/* Popover cards */
.dk-model-options,
.dk-model-sub,
.dk-model-tiers,
.dk-model-tip {
  position: fixed;
  inset: auto;
  margin: 0;
  padding: 6px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--foreground, #141413) 10%, transparent);
  background: var(--card, var(--background, rgb(255, 255, 255)));
  backdrop-filter: blur(22px);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--foreground, #fff) 8%, transparent) inset, 0 18px 40px -10px rgba(0, 0, 0, 0.20), 0 4px 12px -2px rgba(0, 0, 0, 0.10);
  color: var(--foreground, CanvasText);
}
.dk-model-options {
  min-width: 172px;
  width: max-content;
  max-width: min(290px, calc(100vw - 12px));
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
}
.dk-model-options::-webkit-scrollbar { display: none; }
.dk-model-options:has(> .agy-effort) { min-width: min(228px, calc(100vw - 12px)); }
.dk-model-options > :is(.agy-effort, .dk-orch-slot) { contain: inline-size; }
.dk-model-options > .agy-effort { margin: 6px 0 2px; }
${effortBarCss}
${agentEntryCss}
.dk-model-list { display: flex; flex-direction: column; gap: 2px; }
.dk-model-row,
.dk-model-sub-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 9px;
  min-height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--secondary-foreground, var(--foreground, CanvasText));
  font-family: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
  outline: none;
  transition: background 0.12s ease, color 0.12s ease;
}
.dk-model-row.dk-model-disabled { opacity: 0.5; cursor: not-allowed; }
.dk-model-sub-item { font-size: 13px; line-height: 18.57px; }
.dk-model-row:not(.dk-model-disabled):hover:not(:disabled),
.dk-model-row:not(.dk-model-disabled):focus-visible:not(:disabled),
.dk-model-row[data-sub-open="true"],
.dk-model-sub-item[data-sub-open="true"],
.dk-model-sub-item:hover:not(:disabled),
.dk-model-sub-item:focus-visible:not(:disabled) {
  background: var(--secondary, rgba(128, 128, 128, 0.14));
  color: var(--foreground, CanvasText);
}
.dk-model-row[aria-pressed="true"],
.dk-model-sub-item[aria-pressed="true"] {
  color: var(--foreground, CanvasText);
}
.dk-model-options[data-effort-mode="true"] .dk-model-row[aria-pressed="true"] {
  background: var(--secondary, rgba(128, 128, 145, 0.14));
}
.dk-model-row:disabled,
.dk-model-sub-item:disabled { opacity: 0.55; cursor: progress; }
.dk-model-main { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.dk-mp-dot { width: 5.5px; height: 5.5px; border-radius: 50%; flex-shrink: 0; opacity: 0.72; transition: opacity 0.12s ease, transform 0.12s ease; }
.dk-model-row:hover .dk-mp-dot,
.dk-model-row[aria-pressed="true"] .dk-mp-dot { opacity: 1; transform: scale(1.18); }
.dk-model-main .dk-mp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dk-model-main .dk-mp-effort { flex-shrink: 0; color: inherit; opacity: 0.7; font-weight: 400; }
.dk-mp-tier { display: inline-grid; white-space: nowrap; }
.dk-mp-tier > span { grid-area: 1 / 1; }
.dk-mp-tier > [data-size-tier] { visibility: hidden; }
.dk-mp-tier > [data-size-tier]::before { content: attr(data-size-tier); }
.dk-model-options[data-effort-mode="true"] [data-size-tier] { font-weight: 600; }
.dk-model-main .dk-mp-orchestrator { flex-shrink: 0; }
.dk-model-main .dk-mp-planner { flex-shrink: 1; min-width: 0; }
.dk-mp-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--secondary, rgba(128, 128, 128, 0.16));
  color: inherit;
  opacity: 0.7;
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
}
.dk-mp-info { display: inline-flex; align-items: center; flex-shrink: 0; color: inherit; opacity: 0.75; }
.dk-mp-badge .dk-mp-info { opacity: 1; }
.dk-mp-info:hover { opacity: 1; }
.dk-mp-info-svg { width: 12px; height: 12px; display: block; }
.dk-mp-end { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--muted-foreground, #8e8e93); }
.dk-model-row > .dk-mp-end { width: 14px; }
.dk-model-row[aria-pressed="true"] .dk-mp-end,
.dk-model-sub-item[aria-pressed="true"] .dk-mp-end { color: var(--foreground, CanvasText); }
.dk-mp-check { width: 14px; height: 14px; display: block; }
.dk-mp-chev { width: 14px; height: 14px; display: block; opacity: 0.7; }
.dk-model-sub, .dk-model-tiers {
  min-width: min(160px, calc(100vw - 12px));
  flex-direction: column;
  gap: 1px;
  max-width: calc(100vw - 12px);
}
.dk-model-sub:has([data-planner]) { min-width: min(205px, calc(100vw - 12px)); }
.dk-model-sub:popover-open, .dk-model-tiers:popover-open { display: flex; }
.dk-model-tip {
  max-width: 220px;
  padding: 6px 10px;
  border-radius: 10px;
  color: var(--secondary-foreground, var(--foreground, CanvasText));
  pointer-events: none;
  white-space: normal;
  overflow-wrap: break-word;
}
.dk-model-options [role="status"] { padding: 6px 8px 2px; color: #e06c75; font-size: 12px; }
.dk-model-options [role="status"]:empty { display: none; }

/* Sleek 18px effort slider & refined Orchestrator dock proportions */
.dk-orch-slot[data-style="dock"] { margin: 6px 0 0 !important; }
.dk-orch-btn[data-style="dock"] {
  min-height: 30px !important;
  padding: 5px 10px !important;
}
.dk-orch-btn .dk-orch-label {
  font-size: 12.5px !important;
  font-weight: 500 !important;
}
.ces-ag-effort-head {
  align-items: baseline !important;
  line-height: 16px !important;
}
.ces-ag-effort-title,
.ces-ag-effort-value {
  font-size: 12.5px !important;
  line-height: 16px !important;
  font-weight: 500 !important;
}
.ces-inline {
  padding-top: 0 !important;
}
.dk-orch-slot[data-style="dock"]:has(+ .agy-effort) .dk-orch-btn[data-style="dock"] {
  box-shadow: inset 1px 0 0 rgba(var(--orch-core-rgb, 139, 92, 246), 0.28),
              inset -1px 0 0 rgba(var(--orch-core-rgb, 139, 92, 246), 0.28),
              inset 0 1px 0 rgba(var(--orch-core-rgb, 139, 92, 246), 0.28),
              inset 0 -1px 0 rgba(var(--orch-core-rgb, 139, 92, 246), 0.14) !important;
}
.dk-orch-slot[data-style="dock"]:not([hidden]) + .agy-effort .ces-ag-effort-row {
  padding: 9px 10px 10px !important;
  gap: 9px !important;
  box-shadow: inset 1px 0 0 rgba(var(--orch-core-rgb, 139, 92, 246), 0.28),
              inset -1px 0 0 rgba(var(--orch-core-rgb, 139, 92, 246), 0.28),
              inset 0 -1px 0 rgba(var(--orch-core-rgb, 139, 92, 246), 0.28),
              0 4px 12px -4px rgba(var(--orch-core-rgb, 139, 92, 246), 0.22) !important;
}
.ces-track {
  height: 18px !important;
}
.ces-fill,
.ces-energy,
.ces-stars,
.ces-root[data-theme='gemini'] .ces-claude-canvas,
.ces-inline[data-theme='gemini'] .ces-claude-canvas {
  border-radius: 9px 0 0 9px !important;
}
.ces-knob {
  width: 18px !important;
  height: 18px !important;
  margin: -9px 0 0 -9px !important;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.32), 0 0 0 0.5px rgba(0, 0, 0, 0.08) !important;
}
.ces-tick {
  width: 2.5px !important;
  height: 2.5px !important;
  margin: -1.25px 0 0 -1.25px !important;
}
.ces-root[data-theme='claude'] .ces-track,
.ces-inline[data-theme='claude'] .ces-track {
  height: 18px !important;
  border-radius: 6px !important;
}
.ces-root[data-theme='claude'] .ces-fill,
.ces-inline[data-theme='claude'] .ces-fill {
  border-radius: 6px 0 0 6px !important;
}
.ces-root[data-theme='claude'] .ces-knob,
.ces-inline[data-theme='claude'] .ces-knob {
  width: 16px !important;
  height: 20px !important;
  margin: -10px 0 0 -8px !important;
  border-radius: 5px !important;
}
.ces-knob-notch {
  height: 7px !important;
}
`;
}

/**
 * Self-contained browser runtime factory serialized cleanly by studio/build.mjs.
 * Relies on vendored agy-capsule helpers already in scope inside the bundle.
 */
export function createCapsulePickerRuntime({
  prefs,
  labelsByLang,
  shadowCss,
  cfgMods,
  syncModelPicker,
  effortEffects,
  motionThemes,
}) {
  const HOST_ID = 'agy-capsule-picker-host';
  const NATIVE_STYLE_ID = 'agy-capsule-picker-native-layout';
  const EFFORT_STORAGE_KEY = 'agy-capsule.effort-bar.v1';

  let disposed = false;
  let hostEl = null;
  let rootEl = null;
  let footerObs = null;
  let observedFooter = null;
  let seededPrefs = false;

  function isClaudeModelMenuEnabled() {
    try {
      const raw = typeof localStorage === 'object' && localStorage
        ? localStorage.getItem('ag_claude_ux_modules_v1')
        : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.claudeUxModelMenu === 'boolean') return parsed.claudeUxModelMenu;
      }
    } catch {}
    return cfgMods.claudeUxModelMenu === true;
  }

  function findFooterLeft() {
    let main = null;
    let newComposer = null;
    const nonMain = '[data-side-panel-composer], [data-testid="side-question-tab-content"], [data-testid="subagent-tab-composer"], [data-testid="voice-dock-composer"]';
    for (const el of document.querySelectorAll('.agy-composer-footer > div:first-child')) {
      if (el.closest(nonMain)) continue;
      const view = el.closest('[data-testid="conversation-view"]');
      if (!view && !el.closest('[data-testid="agent-input-box"]')?.closest('[data-media-drop-scope]')) continue;
      // When narrow-mode uses `display: contents` on div:first-child, measure its visible footer box instead
      const boxEl = getComputedStyle(el).display === 'contents' ? el.parentElement : el;
      if (!boxEl || !boxEl.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = boxEl.getBoundingClientRect();
      if (
        Math.min(r.bottom, innerHeight) <= Math.max(r.top, 0) ||
        Math.min(r.right, innerWidth) <= Math.max(r.left, 0)
      ) continue;
      if (view) {
        const pane = view.closest('[data-pane-id]');
        if (pane && !pane.hasAttribute('data-pane-unfocused')) return el;
        main ??= el;
      } else {
        newComposer ??= el;
      }
    }
    return main ?? newComposer;
  }

  function ensureNativeStyle() {
    let style = document.getElementById(NATIVE_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = NATIVE_STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = [
      '.agy-composer-footer button[data-deck-model-bubble="hidden"],',
      '#antigravity\\.agentSidePanelInputBox button[data-deck-model-bubble="hidden"] {',
      '  position: absolute !important; width: 0 !important; min-width: 0 !important; max-width: 0 !important;',
      '  height: 0 !important; overflow: hidden !important; padding: 0 !important; margin: 0 !important;',
      '  border: 0 !important; opacity: 0 !important; pointer-events: none !important;',
      '}',
      '[data-deck-agent-tag="on"] [data-testid="selected-agent-chip"] { display: none !important; }',
    ].join('\n');
  }

  function teardownHost() {
    if (footerObs) {
      footerObs.disconnect();
      footerObs = null;
    }
    observedFooter = null;
    if (rootEl && rootEl._modelPicker) {
      try { rootEl._modelPicker.dispose(); } catch {}
    }
    if (hostEl) {
      try { hostEl.remove(); } catch {}
      hostEl = null;
    }
    rootEl = null;
    document.querySelectorAll('button[data-deck-model-bubble]').forEach((b) => {
      b.removeAttribute('data-deck-model-bubble');
    });
  }

  function ensureHost(footerLeft) {
    const trigger = footerLeft.querySelector('button[data-testid="model-selector-trigger"]');
    if (!trigger) return null;

    let modelWrap = trigger;
    while (modelWrap && modelWrap.parentElement && modelWrap.parentElement !== footerLeft) {
      modelWrap = modelWrap.parentElement;
    }
    if (!modelWrap || modelWrap.parentElement !== footerLeft) modelWrap = null;

    if (!hostEl || !hostEl.isConnected) {
      hostEl = document.getElementById(HOST_ID);
    }
    if (!hostEl) {
      hostEl = document.createElement('span');
      hostEl.id = HOST_ID;
      hostEl.setAttribute('data-ag-i18n-ignore', '1');
      hostEl.setAttribute('data-no-drag', '');
      hostEl.style.display = 'contents';
      const shadow = hostEl.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = shadowCss;
      rootEl = document.createElement('div');
      rootEl.id = 'deck-metrics-strip';
      shadow.append(style, rootEl);
    } else if (!rootEl && hostEl.shadowRoot) {
      rootEl = hostEl.shadowRoot.getElementById('deck-metrics-strip');
    }

    if (modelWrap) {
      if (hostEl.parentElement !== footerLeft || hostEl.nextElementSibling !== modelWrap) {
        modelWrap.insertAdjacentElement('beforebegin', hostEl);
      }
    } else if (hostEl.parentElement !== footerLeft) {
      footerLeft.appendChild(hostEl);
    }
    return rootEl;
  }

  function decorateModelCapsule(root) {
    const btn = root?.querySelector('button.dk-pill[data-el="modelPicker"]');
    if (!btn) return;

    let dot = btn.querySelector('.agy-mp-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'agy-mp-dot';
      dot.setAttribute('aria-hidden', 'true');
      btn.insertBefore(dot, btn.firstChild);
    }

    const nameEl = btn.querySelector('.dk-mp-name');
    const effortEl = btn.querySelector('.dk-mp-effort');
    if (effortEl) {
      const trimmed = (effortEl.textContent || '').trim();
      if (effortEl.textContent !== trimmed) effortEl.textContent = trimmed;
    }
    const modelName = (nameEl?.textContent || btn.textContent || '').trim();
    let accent = '#7c5ce6';
    try {
      const c = motionThemes().dotColorFor(modelName);
      if (c) accent = c;
    } catch {}
    if (btn.style.getPropertyValue('--agy-model-accent') !== accent) {
      btn.style.setProperty('--agy-model-accent', accent);
    }
  }

  function seedEffortPrefsOnce() {
    if (seededPrefs) return;
    seededPrefs = true;
    try {
      const existing = typeof localStorage === 'object' && localStorage
        ? localStorage.getItem(EFFORT_STORAGE_KEY)
        : null;
      if (!existing) effortEffects().applySidecarPrefs(prefs, window);
    } catch {}
  }

  function getActiveLabels() {
    const isZh =
      (document.documentElement.lang || '').toLowerCase().startsWith('zh') ||
      document.documentElement.getAttribute('data-ag-ux-lang') === 'zh-CN';
    const labels = isZh ? labelsByLang['zh-CN'] : (labelsByLang[prefs.language] || labelsByLang.en);
    const settingsLabels = labelsByLang[prefs.settingsLanguage] || labelsByLang['zh-CN'] || labels;
    return { labels, settingsLabels };
  }

  function sync(scheduleParent) {
    if (disposed) return;
    if (isClaudeModelMenuEnabled()) {
      if (hostEl || document.querySelector('button[data-deck-model-bubble]')) teardownHost();
      return;
    }

    ensureNativeStyle();
    seedEffortPrefsOnce();

    const footerLeft = findFooterLeft();
    if (!footerLeft) return;

    const root = ensureHost(footerLeft);
    if (!root) return;

    const { labels, settingsLabels } = getActiveLabels();
    try {
      syncModelPicker(root, footerLeft, prefs, labels, findFooterLeft, settingsLabels);
      if (root._modelPicker) root._modelPicker.setBubble(true);
      decorateModelCapsule(root);
    } catch (err) {
      console.warn('[agy-studio/picker] sync failed:', err);
    }

    if (observedFooter !== footerLeft) {
      if (footerObs) footerObs.disconnect();
      observedFooter = footerLeft;
      footerObs = new MutationObserver((mutations) => {
        if (mutations.every((m) => hostEl && hostEl.contains(m.target))) return;
        scheduleParent();
      });
      footerObs.observe(footerLeft, { subtree: true, characterData: true, childList: true });
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    teardownHost();
    document.getElementById(NATIVE_STYLE_ID)?.remove();
  }

  return { sync, dispose };
}
