/**
 * Modular bundler & deployer for agy-studio.
 * Composes vendor/agy-capsule + studio/modules + studio/styles into bounded blocks
 * inside ~/.gemini/antigravity/anti-claude/user/{custom.js,custom.css,config.json},
 * keeping upstream Anti-Claude user/* templates untouched for conflict-free upstream merges.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildPickerShadowCss, createCapsulePickerRuntime } from './modules/capsule-picker.mjs';
import { createFooterUnifiedRuntime } from './modules/footer-unified.mjs';
import { createOverviewUsageRuntime } from './modules/overview-usage.mjs';
import { createResumeBannerRuntime } from './modules/resume-banner.mjs';
import { createSubagentFooterRuntime } from './modules/subagent-footer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');
const VENDOR_CAPSULE = path.join(REPO_ROOT, 'vendor', 'agy-capsule');
const STYLES_DIR = path.join(__dirname, 'styles');
const HOME = homedir();

export const STATE_DIR = path.join(HOME, '.gemini', 'antigravity', 'anti-claude');
export const TARGET_USER_DIR = path.join(STATE_DIR, 'user');
export const TARGET_CUSTOM_JS = path.join(TARGET_USER_DIR, 'custom.js');
export const TARGET_CUSTOM_CSS = path.join(TARGET_USER_DIR, 'custom.css');
export const TARGET_CONFIG_JSON = path.join(TARGET_USER_DIR, 'config.json');
export const TARGET_UI_PREFS_JSON = path.join(STATE_DIR, 'ui-prefs.json');
const CAPSULE_SETTINGS_PATH = path.join(HOME, '.gemini', 'config', 'agy-capsule', 'settings.json');

export const JS_BEGIN = '/* === BEGIN AGY-STUDIO === */';
export const JS_END = '/* === END AGY-STUDIO === */';
export const CSS_BEGIN = '/* === BEGIN AGY-STUDIO-CSS === */';
export const CSS_END = '/* === END AGY-STUDIO-CSS === */';

// Legacy markers from pre-refactor single-file script (auto-cleaned on deploy/rollback)
const LEGACY_JS_MARKERS = ['/* === BEGIN AGY-CAPSULE MODEL PICKER === */', '/* === END AGY-CAPSULE MODEL PICKER === */'];
const LEGACY_CSS_MARKERS = ['/* === BEGIN AGY-FOOTER-POLISH === */', '/* === END AGY-FOOTER-POLISH === */'];

const STYLE_FILES = [
  'typography.css',
  'footer-capsules.css',
  'quota-popover.css',
  'overview-usage.css',
];

const DEFAULT_PREFS = {
  language: 'en',
  settingsLanguage: 'zh-CN',
  modelEffortPicker: true,
  showEffortBar: true,
  hideModelTags: true,
  hideDefaultEffort: true,
  customizeModelList: false,
  hiddenModels: [],
  showModelDots: true,
  effortMotion: 'full',
  effortTicks: 'highlight',
  effortTheme: 'auto',
  geminiTheme: 'physical',
  claudeTheme: 'matrix',
  codexTheme: 'nebula',
  orchestratorMode: 'dock',
  orchestrator3dStyle: 'helix',
  orchestratorIcon: 'prism',
};

export function stripBlock(content, beginMarker, endMarker) {
  const start = content.indexOf(beginMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return content;
  const before = content.slice(0, start).replace(/\s+$/, '');
  const after = content.slice(end + endMarker.length).replace(/^\s+/, '');
  return after ? `${before}\n\n${after}\n` : `${before}\n`;
}

function loadUserCapsulePrefs() {
  let saved = {};
  try {
    if (existsSync(CAPSULE_SETTINGS_PATH)) {
      saved = JSON.parse(readFileSync(CAPSULE_SETTINGS_PATH, 'utf8'));
    }
  } catch {}
  return {
    ...DEFAULT_PREFS,
    ...Object.fromEntries(
      Object.keys(DEFAULT_PREFS)
        .filter((k) => k in saved)
        .map((k) => [k, saved[k]])
    ),
    modelEffortPicker: true,
  };
}

export async function buildStudioBundle() {
  const imp = (file) => import(pathToFileURL(path.join(VENDOR_CAPSULE, file)).href);
  const [
    { resolveInheritedLabel, readPickerState, syncModelPicker },
    { readAgentState, AGENT_ENTRY_CSS, renderAgentEntry },
    { createMotionThemes, motionThemes },
    { createUpstreamEffort },
    { EFFORT_BAR_CSS, effortEffects, mountEffortBar, mountOrchestratorSwitch },
    { createPresentation },
  ] = await Promise.all([
    imp('model_picker.mjs'),
    imp('agent_entry.mjs'),
    imp('motion_themes.mjs'),
    imp('effort_upstream.mjs'),
    imp('effort_bar.mjs'),
    imp('ui.mjs'),
  ]);

  const prefs = loadUserCapsulePrefs();
  const presentation = createPresentation();
  const pickDict = (lang) => {
    const d = presentation.dictionaries[lang] || presentation.dictionaries.en;
    return {
      modelEffortPicker: d.modelEffortPicker,
      effortLevel: d.effortLevel,
      modelPickerUnconfirmed: d.modelPickerUnconfirmed,
      effortBarOptions: d.effortBarOptions,
    };
  };
  const labelsByLang = {
    en: pickDict('en'),
    'zh-CN': pickDict('zh-CN'),
  };

  const shadowCss = buildPickerShadowCss({
    effortBarCss: EFFORT_BAR_CSS,
    agentEntryCss: AGENT_ENTRY_CSS,
  });

  // Scale effort slider canvas constants cleanly to 18px track & knob (fail fast if vendor code changes)
  const EFFORT_REPLACEMENTS = [
    ['var TRACK_HEIGHT = 28;', 'var TRACK_HEIGHT = 18;'],
    ['var KNOB_SIZE = 28;', 'var KNOB_SIZE = 18;'],
    ['var CLAUDE_CELL = 28 / 6;', 'var CLAUDE_CELL = 18 / 6;'],
    ['var CLAUDE_KNOB_W = 24;', 'var CLAUDE_KNOB_W = 16;'],
    ['var CLAUDE_KNOB_H = 30;', 'var CLAUDE_KNOB_H = 20;'],
    ['var CLAUDE_KNOB_R = 7;', 'var CLAUDE_KNOB_R = 5;'],
  ];
  let scaledCreateUpstreamEffort = createUpstreamEffort.toString();
  for (const [from, to] of EFFORT_REPLACEMENTS) {
    if (!scaledCreateUpstreamEffort.includes(from)) {
      throw new Error(`Expected effort slider constant not found in vendor/agy-capsule/effort_upstream.mjs: ${from}`);
    }
    scaledCreateUpstreamEffort = scaledCreateUpstreamEffort.replace(from, to);
  }

  const vendorFns = [
    createMotionThemes.toString(),
    motionThemes.toString(),
    scaledCreateUpstreamEffort,
    effortEffects.toString(),
    mountEffortBar.toString(),
    mountOrchestratorSwitch.toString(),
    readAgentState.toString(),
    renderAgentEntry.toString(),
    resolveInheritedLabel.toString(),
    readPickerState.toString(),
    syncModelPicker.toString(),
  ].join('\n\n');

  const moduleFns = [
    createCapsulePickerRuntime.toString(),
    createFooterUnifiedRuntime.toString(),
    createOverviewUsageRuntime.toString(),
    createResumeBannerRuntime.toString(),
    createSubagentFooterRuntime.toString(),
  ].join('\n\n');

  const jsBlock = `${JS_BEGIN}
(function () {
  if (typeof window.__agyStudioDispose === 'function') {
    try { window.__agyStudioDispose(); } catch {}
  }
  if (typeof window.__agyCapsulePickerDispose === 'function') {
    try { window.__agyCapsulePickerDispose(); } catch {}
  }

  const STUDIO_PREFS = ${JSON.stringify(prefs, null, 2)};
  const STUDIO_LABELS = ${JSON.stringify(labelsByLang, null, 2)};
  const PICKER_SHADOW_CSS = ${JSON.stringify(shadowCss)};
  const CFG_MODS =
    (typeof ctx !== 'undefined' && ctx && (ctx.modules || (ctx.config && ctx.config.modules))) || {};

${vendorFns}

${moduleFns}

  let disposed = false;
  let rafId = 0;

  const picker = createCapsulePickerRuntime({
    prefs: STUDIO_PREFS,
    labelsByLang: STUDIO_LABELS,
    shadowCss: PICKER_SHADOW_CSS,
    cfgMods: CFG_MODS,
    syncModelPicker,
    effortEffects,
    motionThemes,
  });
  const footer = createFooterUnifiedRuntime({ onTierChange: () => scheduleSync() });
  const usage = createOverviewUsageRuntime({ motionThemes });
  const resumeBanner = createResumeBannerRuntime();
  const subagentFooter = createSubagentFooterRuntime({ motionThemes });

  function syncAll() {
    if (disposed) return;
    subagentFooter.sync();
    resumeBanner.sync();
    footer.sync();
    picker.sync(scheduleSync);
    usage.sync();
  }

  function scheduleSync() {
    if (disposed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      syncAll();
    });
  }

  const docObs = new MutationObserver(() => scheduleSync());
  if (document.body) {
    docObs.observe(document.body, { childList: true, subtree: true });
  }
  const pollTimer = setInterval(syncAll, 900);
  window.addEventListener('storage', scheduleSync);

  syncAll();

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    clearInterval(pollTimer);
    window.removeEventListener('storage', scheduleSync);
    docObs.disconnect();
    picker.dispose();
    footer.dispose();
    resumeBanner.dispose();
    subagentFooter.dispose();
    usage.dispose();
    if (window.__agyStudioDispose === dispose) {
      window.__agyStudioDispose = null;
    }
  }

  window.__agyStudioDispose = dispose;
  if (typeof ctx !== 'undefined' && ctx && typeof ctx.onCleanup === 'function') {
    ctx.onCleanup(dispose);
  }
})();
${JS_END}
`;

  // Fail fast if generated JS has any syntax issue before touching live files
  new Function('ctx', jsBlock);

  const combinedCss = STYLE_FILES.map((file) => {
    const body = readFileSync(path.join(STYLES_DIR, file), 'utf8').trim();
    return `/* --- studio/styles/${file} --- */\n${body}`;
  }).join('\n\n');

  const cssBlock = `${CSS_BEGIN}\n${combinedCss}\n${CSS_END}\n`;

  return { jsBlock, cssBlock, prefs };
}

function updateConfigJson({ claudeUxModelMenu }) {
  if (existsSync(TARGET_CONFIG_JSON)) {
    const cfg = JSON.parse(readFileSync(TARGET_CONFIG_JSON, 'utf8'));
    cfg.modules = cfg.modules && typeof cfg.modules === 'object' ? cfg.modules : {};
    cfg.modules.claudeUxModelMenu = claudeUxModelMenu;
    if (!claudeUxModelMenu) {
      cfg.modules.claudeUxStepUnfold = false;
      cfg.cjkFontScale = '100';
    } else {
      cfg.modules.claudeUxStepUnfold = true;
      delete cfg.cjkFontScale;
    }
    writeFileSync(TARGET_CONFIG_JSON, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  }
  // Keep daemon's ui-prefs.json synchronized so Anti-Claude Settings toggles cannot
  // overwrite claudeUxModelMenu back to stale state and tear down the studio picker.
  if (existsSync(TARGET_UI_PREFS_JSON)) {
    try {
      const prefs = JSON.parse(readFileSync(TARGET_UI_PREFS_JSON, 'utf8'));
      if (prefs && typeof prefs === 'object') {
        prefs.modules = prefs.modules && typeof prefs.modules === 'object' ? prefs.modules : {};
        prefs.modules.claudeUxModelMenu = claudeUxModelMenu;
        if (!claudeUxModelMenu) {
          prefs.modules.claudeUxStepUnfold = false;
        }
        writeFileSync(TARGET_UI_PREFS_JSON, JSON.stringify(prefs, null, 2) + '\n', 'utf8');
      }
    } catch {}
  }
}

export function stripStudioBlocksOnly() {
  if (existsSync(TARGET_CUSTOM_JS)) {
    let raw = readFileSync(TARGET_CUSTOM_JS, 'utf8');
    raw = stripBlock(raw, LEGACY_JS_MARKERS[0], LEGACY_JS_MARKERS[1]);
    raw = stripBlock(raw, JS_BEGIN, JS_END);
    writeFileSync(TARGET_CUSTOM_JS, raw, 'utf8');
  }
  if (existsSync(TARGET_CUSTOM_CSS)) {
    let raw = readFileSync(TARGET_CUSTOM_CSS, 'utf8');
    raw = stripBlock(raw, LEGACY_CSS_MARKERS[0], LEGACY_CSS_MARKERS[1]);
    raw = stripBlock(raw, CSS_BEGIN, CSS_END);
    writeFileSync(TARGET_CUSTOM_CSS, raw, 'utf8');
  }
}

export async function deployStudio() {
  if (!existsSync(TARGET_CUSTOM_JS) || !existsSync(TARGET_CUSTOM_CSS)) {
    throw new Error(
      `Anti-Claude user directory not initialized at ${TARGET_USER_DIR}. Run "node studio/cli.mjs install" first.`
    );
  }

  const { jsBlock, cssBlock, prefs } = await buildStudioBundle();

  let baseJs = readFileSync(TARGET_CUSTOM_JS, 'utf8');
  baseJs = stripBlock(baseJs, LEGACY_JS_MARKERS[0], LEGACY_JS_MARKERS[1]);
  baseJs = stripBlock(baseJs, JS_BEGIN, JS_END);
  writeFileSync(TARGET_CUSTOM_JS, `${baseJs.replace(/\s+$/, '')}\n\n${jsBlock}`, 'utf8');

  let baseCss = readFileSync(TARGET_CUSTOM_CSS, 'utf8');
  baseCss = stripBlock(baseCss, LEGACY_CSS_MARKERS[0], LEGACY_CSS_MARKERS[1]);
  baseCss = stripBlock(baseCss, CSS_BEGIN, CSS_END);
  writeFileSync(TARGET_CUSTOM_CSS, `${baseCss.replace(/\s+$/, '')}\n\n${cssBlock}`, 'utf8');

  updateConfigJson({ claudeUxModelMenu: false });

  return {
    ok: true,
    action: 'deployed',
    customJsPath: TARGET_CUSTOM_JS,
    customCssPath: TARGET_CUSTOM_CSS,
    configJsonPath: TARGET_CONFIG_JSON,
    jsBytes: Buffer.byteLength(jsBlock, 'utf8'),
    cssBytes: Buffer.byteLength(cssBlock, 'utf8'),
    prefs,
  };
}

export function rollbackStudio() {
  stripStudioBlocksOnly();
  updateConfigJson({ claudeUxModelMenu: true });
  return { ok: true, action: 'rolled_back', claudeUxModelMenu: true };
}
