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

/* Pill 1: Unified Model + Effort Capsule (harmonized with Context, Speed & Subagent pills) */
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] {
  --agy-model-accent: #7c5ce6;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  min-width: 0;
  max-width: min(20em, 100%);
  padding: 0 6.5px 0 7.5px;
  margin-right: 0;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
  font-size: 12px;
  color: var(--foreground, #1C1C1A);
  background: color-mix(in srgb, var(--agy-model-accent) 7%, var(--agy-pill-bg, rgba(128, 128, 128, 0.06)));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agy-model-accent) 20%, var(--agy-pill-border, rgba(128, 128, 128, 0.12)));
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms ease, transform 110ms cubic-bezier(0.22, 1, 0.36, 1);
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"]:active {
  transform: scale(0.97);
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
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .dk-mp-name,
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .agy-mp-short {
  color: inherit;
  font-weight: 450;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .agy-mp-short {
  display: none;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .dk-mp-effort,
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .agy-mp-effort-short {
  display: inline-block;
  vertical-align: middle;
  min-width: 0;
  max-width: 11.5em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
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
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .agy-mp-effort-short {
  display: none;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .dk-mp-effort:empty,
#deck-metrics-strip button.dk-pill[data-el="modelPicker"] .agy-mp-effort-short:empty {
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

/* Always keep Orchestrator planner badge compact even in full tier */
#deck-metrics-strip button.dk-pill[data-el="modelPicker"][data-is-orch="1"] .dk-mp-effort {
  display: none;
}
#deck-metrics-strip button.dk-pill[data-el="modelPicker"][data-is-orch="1"] .agy-mp-effort-short {
  display: inline-block;
}

/* 4-Tier Progressive Compression for Model Capsule */
#deck-metrics-strip[data-dock-tier="compact"] button.dk-pill[data-el="modelPicker"] {
  max-width: min(16em, 100%);
}
#deck-metrics-strip[data-dock-tier="compact"] button.dk-pill[data-el="modelPicker"] .dk-mp-name,
#deck-metrics-strip[data-dock-tier="compact"] button.dk-pill[data-el="modelPicker"] .dk-mp-effort {
  display: none;
}
#deck-metrics-strip[data-dock-tier="compact"] button.dk-pill[data-el="modelPicker"] .agy-mp-short {
  display: inline;
}
#deck-metrics-strip[data-dock-tier="compact"] button.dk-pill[data-el="modelPicker"] .agy-mp-effort-short {
  display: inline-block;
}

#deck-metrics-strip[data-dock-tier="tight"] button.dk-pill[data-el="modelPicker"],
#deck-metrics-strip[data-dock-tier="icon"] button.dk-pill[data-el="modelPicker"] {
  padding: 0 5.5px 0 6.5px;
  gap: 4.5px;
}
#deck-metrics-strip[data-dock-tier="tight"] button.dk-pill[data-el="modelPicker"] {
  max-width: min(11.5em, 100%);
}
#deck-metrics-strip[data-dock-tier="icon"] button.dk-pill[data-el="modelPicker"] {
  max-width: min(8.5em, 100%);
}
#deck-metrics-strip[data-dock-tier="tight"] button.dk-pill[data-el="modelPicker"] .dk-mp-name,
#deck-metrics-strip[data-dock-tier="icon"] button.dk-pill[data-el="modelPicker"] .dk-mp-name,
#deck-metrics-strip[data-dock-tier="tight"] button.dk-pill[data-el="modelPicker"] .dk-mp-effort,
#deck-metrics-strip[data-dock-tier="icon"] button.dk-pill[data-el="modelPicker"] .dk-mp-effort {
  display: none;
}
#deck-metrics-strip[data-dock-tier="tight"] button.dk-pill[data-el="modelPicker"] .agy-mp-effort-short,
#deck-metrics-strip[data-dock-tier="icon"] button.dk-pill[data-el="modelPicker"] .agy-mp-effort-short {
  display: inline-block;
}
#deck-metrics-strip[data-dock-tier="tight"] button.dk-pill[data-el="modelPicker"] .agy-mp-effort-short {
  max-width: 8.5em;
}
#deck-metrics-strip[data-dock-tier="icon"] button.dk-pill[data-el="modelPicker"] .agy-mp-effort-short {
  max-width: 6.2em;
}
#deck-metrics-strip[data-dock-tier="tight"] button.dk-pill[data-el="modelPicker"][data-has-effort="1"] .agy-mp-short,
#deck-metrics-strip[data-dock-tier="icon"] button.dk-pill[data-el="modelPicker"][data-has-effort="1"] .agy-mp-short {
  display: none;
}
#deck-metrics-strip[data-dock-tier="tight"] button.dk-pill[data-el="modelPicker"][data-has-effort="1"] .dk-mp-effort,
#deck-metrics-strip[data-dock-tier="icon"] button.dk-pill[data-el="modelPicker"][data-has-effort="1"] .dk-mp-effort,
#deck-metrics-strip[data-dock-tier="tight"] button.dk-pill[data-el="modelPicker"][data-has-effort="1"] .agy-mp-effort-short,
#deck-metrics-strip[data-dock-tier="icon"] button.dk-pill[data-el="modelPicker"][data-has-effort="1"] .agy-mp-effort-short {
  margin-left: 0;
}
/* Fallback for models without effort tiers: display short model name instead of empty button */
#deck-metrics-strip[data-dock-tier="tight"] button.dk-pill[data-el="modelPicker"][data-has-effort="0"] .agy-mp-short,
#deck-metrics-strip[data-dock-tier="icon"] button.dk-pill[data-el="modelPicker"][data-has-effort="0"] .agy-mp-short {
  display: inline;
  max-width: 5.5em;
}
#deck-metrics-strip[data-dock-tier="icon"] button.dk-pill[data-el="modelPicker"] .dk-mp-down {
  display: none;
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
  backdrop-filter: blur(12px) saturate(160%);
  contain: layout style;
  box-shadow: 0 1px 0 color-mix(in srgb, var(--foreground, #fff) 8%, transparent) inset, 0 18px 40px -10px rgba(0, 0, 0, 0.20), 0 4px 12px -2px rgba(0, 0, 0, 0.10);
  color: var(--foreground, CanvasText);
}
@keyframes dkPopIn {
  from {
    opacity: 0;
    transform: translate3d(0, 4px, 0) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}
.dk-model-options:popover-open,
.dk-model-sub:popover-open,
.dk-model-tiers:popover-open {
  animation: dkPopIn 130ms cubic-bezier(0.22, 1, 0.36, 1) both;
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
  transition: background 0.12s ease, color 0.12s ease, transform 0.1s cubic-bezier(0.22, 1, 0.36, 1);
}
.dk-model-row:not(.dk-model-disabled):active:not(:disabled),
.dk-model-sub-item:active:not(:disabled) {
  transform: scale(0.985);
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
  background: color-mix(in srgb, var(--foreground, #1C1C1A) 32%, transparent) !important;
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
@media (prefers-reduced-motion: reduce) {
  #deck-metrics-strip button.dk-pill[data-el="modelPicker"],
  .dk-model-row,
  .dk-model-sub-item {
    transition: none !important;
  }
  .dk-model-options:popover-open,
  .dk-model-sub:popover-open,
  .dk-model-tiers:popover-open {
    animation: none !important;
  }
}
`;
}

export function shortenModelName(name, isZh = false) {
  const raw = String(name || '').trim();
  if (!raw) return 'Model';
  if (/^orchestrator$/i.test(raw)) return isZh ? '路由' : 'Orch';
  const stripped = raw
    .replace(/^(?:Google\s+)?Gemini\s+\d+(?:\.\d+)?\s+/i, '')
    .replace(/^Claude\s+(?:\d+(?:\.\d+)?\s+)?/i, '')
    .replace(/^OpenAI\s+/i, '')
    .trim();
  if (stripped && stripped.length >= 2 && stripped.length < raw.length) return stripped;
  return raw;
}

export function shortenEffortBadge(effortText) {
  const raw = String(effortText || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^(?:Google\s+)?Gemini\s+(?:v?\d+(?:\.\d+)?\s+)?/i, '')
    .replace(/^Claude\s+(?:v?\d+(?:\.\d+)?\s+)?/i, '')
    .replace(/(\b(?:Opus|Sonnet|Haiku))\s+v?\d+(?:\.\d+)?(?=\s|$)/i, '$1')
    .replace(/^OpenAI\s+/i, '')
    .replace(/\bExtra\s+High\b/i, 'XHigh')
    .replace(/\bMedium\b/i, 'Med')
    .replace(/\bMinimal\b/i, 'Min')
    .trim();
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
  shortenModelName,
  shortenEffortBadge,
}) {
  const HOST_ID = 'agy-capsule-picker-host';
  const HOST_ATTR = 'data-agy-picker-host';
  const MODEL_WRAP_ATTR = 'data-agy-model-wrap';
  const NATIVE_STYLE_ID = 'agy-capsule-picker-native-layout';
  const EFFORT_STORAGE_KEY = 'agy-capsule.effort-bar.v1';
  const MODS_STORAGE_KEY = 'ag_claude_ux_modules_v1';
  const NATIVE_STYLE_CSS = [
    '.agy-composer-footer button[data-deck-model-bubble="hidden"],',
    '#antigravity\\.agentSidePanelInputBox button[data-deck-model-bubble="hidden"],',
    `.agy-composer-footer > div:first-child > [${MODEL_WRAP_ATTR}="1"] {`,
    '  position: absolute !important; width: 0 !important; min-width: 0 !important; max-width: 0 !important;',
    '  height: 0 !important; overflow: hidden !important; padding: 0 !important; margin: 0 !important;',
    '  border: 0 !important; opacity: 0 !important; pointer-events: none !important;',
    '}',
    '[data-deck-agent-tag="on"] [data-testid="selected-agent-chip"] { display: none !important; }',
  ].join('\n');

  let disposed = false;
  let seededPrefs = false;
  const instances = new Map(); // footerLeft -> { hostEl, rootEl, footerObs, modelWrap, ... }

  // Synchronize stale pre-studio localStorage override once on boot if config disables claudeUxModelMenu
  if (cfgMods.claudeUxModelMenu === false) {
    try {
      const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(MODS_STORAGE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.claudeUxModelMenu === true) {
          parsed.claudeUxModelMenu = false;
          localStorage.setItem(MODS_STORAGE_KEY, JSON.stringify(parsed));
        }
      }
    } catch {}
  }

  function isClaudeModelMenuEnabled() {
    try {
      const raw = typeof localStorage === 'object' && localStorage
        ? localStorage.getItem(MODS_STORAGE_KEY)
        : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.claudeUxModelMenu === 'boolean') return parsed.claudeUxModelMenu;
      }
    } catch {}
    return cfgMods.claudeUxModelMenu === true;
  }

  function isFooterLeftVisible(el) {
    if (!el || !el.isConnected) return false;
    // Narrow 2-row mode sets `display: contents` on div:first-child; measure its visible footer parent instead.
    const parentHasRow2 = el.parentElement?.getAttribute?.('data-agy-has-row2') === 'true';
    const boxEl = parentHasRow2 || getComputedStyle(el).display === 'contents' ? el.parentElement : el;
    if (!boxEl || !boxEl.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = boxEl.getBoundingClientRect();
    return !(
      Math.min(r.bottom, innerHeight) <= Math.max(r.top, 0) ||
      Math.min(r.right, innerWidth) <= Math.max(r.left, 0)
    );
  }

  function findEligibleFooterLefts() {
    const excluded = '[data-testid="side-question-tab-content"], [data-testid="voice-dock-composer"]';
    const results = [];
    for (const el of document.querySelectorAll('.agy-composer-footer > div:first-child')) {
      if (el.closest(excluded)) continue;
      if (!el.querySelector('button[data-testid="model-selector-trigger"]')) continue;
      if (!isFooterLeftVisible(el)) continue;
      const isSide = Boolean(el.closest('[data-side-panel-composer], [data-testid="subagent-tab-composer"]'));
      const view = el.closest('[data-testid="conversation-view"]');
      if (!isSide && !view && !el.closest('[data-testid="agent-input-box"]')?.closest('[data-media-drop-scope]')) continue;
      results.push({ el, isSide });
    }
    return results;
  }

  function ensureNativeStyle() {
    let style = document.getElementById(NATIVE_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = NATIVE_STYLE_ID;
      document.head.appendChild(style);
    }
    if (style.textContent !== NATIVE_STYLE_CSS) {
      style.textContent = NATIVE_STYLE_CSS;
    }
  }

  function teardownInstance(footerLeft) {
    const inst = instances.get(footerLeft);
    if (!inst) return;
    instances.delete(footerLeft);
    if (inst.footerObs) {
      try { inst.footerObs.disconnect(); } catch {}
    }
    if (inst.rootEl && inst.rootEl._modelPicker) {
      try { inst.rootEl._modelPicker.dispose(); } catch {}
    }
    if (inst.hostEl) {
      try { inst.hostEl.remove(); } catch {}
    }
    if (inst.modelWrap && inst.modelWrap.removeAttribute) {
      try { inst.modelWrap.removeAttribute(MODEL_WRAP_ATTR); } catch {}
    }
    if (footerLeft && footerLeft.isConnected) {
      footerLeft.querySelectorAll('button[data-deck-model-bubble]').forEach((b) => {
        b.removeAttribute('data-deck-model-bubble');
      });
      footerLeft.querySelectorAll(`[${MODEL_WRAP_ATTR}]`).forEach((w) => {
        w.removeAttribute(MODEL_WRAP_ATTR);
      });
    }
  }

  function teardownAll() {
    for (const footerLeft of Array.from(instances.keys())) {
      teardownInstance(footerLeft);
    }
    document.querySelectorAll(`[${HOST_ATTR}="1"], #${HOST_ID}`).forEach((n) => {
      try { n.remove(); } catch {}
    });
    document.querySelectorAll('button[data-deck-model-bubble]').forEach((b) => {
      b.removeAttribute('data-deck-model-bubble');
    });
    document.querySelectorAll(`[${MODEL_WRAP_ATTR}]`).forEach((w) => {
      w.removeAttribute(MODEL_WRAP_ATTR);
    });
  }

  function ensureHostFor(footerLeft, isSide) {
    const trigger = footerLeft.querySelector('button[data-testid="model-selector-trigger"]');
    if (!trigger) return null;

    let modelWrap = trigger;
    while (modelWrap && modelWrap.parentElement && modelWrap.parentElement !== footerLeft) {
      modelWrap = modelWrap.parentElement;
    }
    if (!modelWrap || modelWrap.parentElement !== footerLeft) modelWrap = null;

    let inst = instances.get(footerLeft);
    if (!inst || !inst.hostEl || !inst.hostEl.isConnected) {
      const existing = footerLeft.querySelector(`:scope > [${HOST_ATTR}="1"]`);
      let hostEl = existing;
      let rootEl = existing?.shadowRoot?.getElementById('deck-metrics-strip') || null;
      if (!hostEl) {
        hostEl = document.createElement('span');
        if (!isSide && !document.getElementById(HOST_ID)) hostEl.id = HOST_ID;
        hostEl.setAttribute(HOST_ATTR, '1');
        hostEl.setAttribute('data-ag-i18n-ignore', '1');
        hostEl.setAttribute('data-no-drag', '');
        hostEl.style.display = 'contents';
        const markDirty = () => {
          const cur = instances.get(hostEl.parentElement);
          if (cur) cur.dirty = true;
        };
        hostEl.addEventListener('pointerdown', markDirty, true);
        hostEl.addEventListener('focusin', markDirty, true);
        const shadow = hostEl.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = shadowCss;
        rootEl = document.createElement('div');
        rootEl.id = 'deck-metrics-strip';
        shadow.append(style, rootEl);
      }
      inst = {
        hostEl,
        rootEl,
        footerObs: inst?.footerObs || null,
        modelWrap: null,
        dirty: true,
        lastTrigger: null,
        lastTriggerText: '',
        lastRoute: '',
        lastLang: '',
        lastPickerSyncTs: 0,
      };
      instances.set(footerLeft, inst);
    }

    if (modelWrap) {
      if (modelWrap.getAttribute(MODEL_WRAP_ATTR) !== '1') {
        modelWrap.setAttribute(MODEL_WRAP_ATTR, '1');
      }
      inst.modelWrap = modelWrap;
      if (inst.hostEl.parentElement !== footerLeft || inst.hostEl.nextElementSibling !== modelWrap) {
        modelWrap.insertAdjacentElement('beforebegin', inst.hostEl);
      }
    } else if (inst.hostEl.parentElement !== footerLeft) {
      footerLeft.appendChild(inst.hostEl);
    }
    return inst;
  }

  function decorateModelCapsule(root, footerLeft) {
    const btn = root?.querySelector('button.dk-pill[data-el="modelPicker"]');
    if (!btn) return;

    const footer = footerLeft?.closest?.('.agy-composer-footer');
    const dockTier = footer?.getAttribute('data-agy-dock-tier') || 'full';
    if (root.getAttribute('data-dock-tier') !== dockTier) {
      root.setAttribute('data-dock-tier', dockTier);
    }

    let dot = btn.querySelector('.agy-mp-dot');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'agy-mp-dot';
      dot.setAttribute('aria-hidden', 'true');
      btn.insertBefore(dot, btn.firstChild);
    }

    const textWrap = btn.querySelector('.dk-mp-text');
    let nameEl = btn.querySelector('.dk-mp-name');
    const effortEl = btn.querySelector('.dk-mp-effort');
    if (textWrap && !nameEl && !effortEl) {
      const rawLabel = (textWrap.textContent || '').trim();
      nameEl = document.createElement('span');
      nameEl.className = 'dk-mp-name';
      nameEl.textContent = rawLabel;
      textWrap.replaceChildren(nameEl);
    }
    let effortText = '';
    if (effortEl) {
      effortText = (effortEl.textContent || '').trim();
      if (effortEl.textContent !== effortText) effortEl.textContent = effortText;
    }

    const isZh = document.documentElement.getAttribute('data-ag-ux-lang') === 'zh-CN';
    const modelName = (nameEl?.textContent || '').trim();
    const isOrch = /^orchestrator$/i.test(modelName);
    const shortName = shortenModelName(modelName, isZh);
    if (textWrap && nameEl) {
      let shortEl = textWrap.querySelector('.agy-mp-short');
      if (!shortEl) {
        shortEl = document.createElement('span');
        shortEl.className = 'agy-mp-short';
        shortEl.setAttribute('aria-hidden', 'true');
        nameEl.insertAdjacentElement('afterend', shortEl);
      } else if (shortEl.getAttribute('aria-hidden') !== 'true') {
        shortEl.setAttribute('aria-hidden', 'true');
      }
      if (shortEl.textContent !== shortName) shortEl.textContent = shortName;
    }

    const effortShort = shortenEffortBadge(effortText);
    let effortShortEl = textWrap?.querySelector('.agy-mp-effort-short');
    if (textWrap && effortEl) {
      if (!effortShortEl) {
        effortShortEl = document.createElement('span');
        effortShortEl.className = 'agy-mp-effort-short';
        effortShortEl.setAttribute('aria-hidden', 'true');
        effortEl.insertAdjacentElement('afterend', effortShortEl);
      } else if (effortShortEl.getAttribute('aria-hidden') !== 'true') {
        effortShortEl.setAttribute('aria-hidden', 'true');
      }
      if (effortShortEl.textContent !== effortShort) effortShortEl.textContent = effortShort;
    } else if (effortShortEl) {
      effortShortEl.textContent = '';
    }

    const orchAttr = isOrch ? '1' : '0';
    if (btn.getAttribute('data-is-orch') !== orchAttr) {
      btn.setAttribute('data-is-orch', orchAttr);
    }

    const hasEffort = effortText.length > 0 ? '1' : '0';
    if (btn.getAttribute('data-has-effort') !== hasEffort) {
      btn.setAttribute('data-has-effort', hasEffort);
    }
    const fullTitle = `${modelName}${effortText ? ` · ${effortText}` : ''}`.trim();
    if (fullTitle && btn.title !== fullTitle) {
      btn.title = fullTitle;
    }
    const { labels } = getActiveLabels();
    const caption = (typeof labels === 'string' ? labels : labels?.modelEffortPicker) || 'Enhanced model capsule';
    const cleanText = `${modelName}${effortText ? ` ${effortText}` : ''}`.trim();
    const nextAria = cleanText ? `${caption}: ${cleanText}` : caption;
    if (btn.getAttribute('aria-label') !== nextAria) {
      btn.setAttribute('aria-label', nextAria);
    }

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
    const isZh = document.documentElement.getAttribute('data-ag-ux-lang') === 'zh-CN';
    const labels = isZh ? labelsByLang['zh-CN'] : labelsByLang.en;
    const settingsLabels = isZh ? labelsByLang['zh-CN'] : labelsByLang.en;
    return { labels, settingsLabels };
  }

  function sync(scheduleParent) {
    if (disposed) return;
    if (isClaudeModelMenuEnabled()) {
      if (instances.size > 0 || document.querySelector('button[data-deck-model-bubble]')) {
        teardownAll();
      }
      return;
    }

    ensureNativeStyle();
    seedEffortPrefsOnce();

    const eligible = findEligibleFooterLefts();
    const activeSet = new Set(eligible.map((item) => item.el));
    for (const prevFooter of Array.from(instances.keys())) {
      if (!activeSet.has(prevFooter)) teardownInstance(prevFooter);
    }

    const { labels, settingsLabels } = getActiveLabels();
    const curRoute = typeof location !== 'undefined' ? String(location.pathname || '') : '';
    const curLang = document.documentElement.getAttribute('data-ag-ux-lang') || '';
    const now = Date.now();

    for (const { el: footerLeft, isSide } of eligible) {
      const inst = ensureHostFor(footerLeft, isSide);
      if (!inst || !inst.rootEl) continue;

      const trigger = footerLeft.querySelector('button[data-testid="model-selector-trigger"]');
      const triggerText = trigger ? (trigger.textContent || '').trim() : '';
      let panelOpen = false;
      try {
        panelOpen = Boolean(inst.rootEl.querySelector?.('.dk-model-options')?.matches?.(':popover-open'));
      } catch {}

      const needsPickerSync =
        !inst.rootEl._modelPicker ||
        inst.dirty ||
        inst.lastTrigger !== trigger ||
        inst.lastTriggerText !== triggerText ||
        inst.lastRoute !== curRoute ||
        inst.lastLang !== curLang ||
        panelOpen ||
        now - inst.lastPickerSyncTs >= 2500;

      if (needsPickerSync) {
        const scopedFind = () => (isFooterLeftVisible(footerLeft) ? footerLeft : null);
        try {
          syncModelPicker(inst.rootEl, footerLeft, prefs, labels, scopedFind, settingsLabels);
          if (inst.rootEl._modelPicker) inst.rootEl._modelPicker.setBubble(true);
          decorateModelCapsule(inst.rootEl, footerLeft);
        } catch (err) {
          console.warn('[agy-studio/picker] sync failed:', err);
        }
        inst.dirty = false;
        inst.lastTrigger = trigger;
        inst.lastTriggerText = triggerText;
        inst.lastRoute = curRoute;
        inst.lastLang = curLang;
        inst.lastPickerSyncTs = now;
      } else {
        const footer = footerLeft?.closest?.('.agy-composer-footer');
        const dockTier = footer?.getAttribute?.('data-agy-dock-tier') || 'full';
        if (inst.rootEl.getAttribute('data-dock-tier') !== dockTier) {
          inst.rootEl.setAttribute('data-dock-tier', dockTier);
        }
      }

      if (!inst.footerObs) {
        inst.footerObs = new MutationObserver((mutations) => {
          if (mutations.every((m) => inst.hostEl && (inst.hostEl === m.target || inst.hostEl.contains(m.target)))) return;
          inst.dirty = true;
          scheduleParent();
        });
        inst.footerObs.observe(footerLeft, { subtree: true, characterData: true, childList: true });
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    teardownAll();
    document.getElementById(NATIVE_STYLE_ID)?.remove();
  }

  return { sync, dispose };
}
