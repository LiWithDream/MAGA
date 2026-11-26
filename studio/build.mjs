/**
 * Modular esbuild bundler & deployer for agy-studio.
 * Compiles studio/entry.mjs (ESM) + studio/styles/*.css into bounded blocks inside
 * ~/.gemini/antigravity/anti-claude/user/{custom.js,custom.css,config.json}.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPresentation } from '../vendor/agy-capsule/ui.mjs';
import { buildPickerShadowCss } from './modules/capsule-picker.mjs';
import { evaluateDeployGuard, writeDeployMeta } from './deploy-meta.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');
const VENDOR_CAPSULE = path.join(REPO_ROOT, 'vendor', 'agy-capsule');
const STYLES_DIR = path.join(__dirname, 'styles');
const ENTRY_FILE = path.join(__dirname, 'entry.mjs');
export const PREBUILT_STUDIO_ENTRY = path.join(__dirname, 'prebuilt', 'studio-entry.js');
const USER_ENTRY_FILE = path.join(REPO_ROOT, 'user', 'src', 'entry.mjs');
const REPO_USER_JS = path.join(REPO_ROOT, 'user', 'custom.js');
const REPO_USER_CSS = path.join(REPO_ROOT, 'user', 'custom.css');

let _esbuildPromise = null;
async function loadEsbuild() {
  if (!_esbuildPromise) {
    _esbuildPromise = import('esbuild').catch((err) => {
      _esbuildPromise = null;
      throw new Error(
        `esbuild is not installed (${err?.code || err?.message || 'missing'}). Run "npm install" or use a prebuilt release tarball.`
      );
    });
  }
  return _esbuildPromise;
}
const HOME = homedir();

export const STATE_DIR = path.join(HOME, '.gemini', 'antigravity', 'anti-claude');
export const TARGET_USER_DIR = path.join(STATE_DIR, 'user');
export const TARGET_CUSTOM_JS = path.join(TARGET_USER_DIR, 'custom.js');
export const TARGET_CUSTOM_CSS = path.join(TARGET_USER_DIR, 'custom.css');
export const TARGET_CONFIG_JSON = path.join(TARGET_USER_DIR, 'config.json');
export const TARGET_UI_PREFS_JSON = path.join(STATE_DIR, 'ui-prefs.json');
const STUDIO_PREFS_PATH = path.join(STATE_DIR, 'studio-prefs.json');

export const JS_BEGIN = '/* === BEGIN AGY-STUDIO === */';
export const JS_END = '/* === END AGY-STUDIO === */';
export const CSS_BEGIN = '/* === BEGIN AGY-STUDIO-CSS === */';
export const CSS_END = '/* === END AGY-STUDIO-CSS === */';

const STYLE_FILES = [
  'typography.css',
  'footer-capsules.css',
  'quota-popover.css',
  'overview-usage.css',
  'studio-settings.css',
];

const DEFAULT_PREFS = {
  language: 'en',
  settingsLanguage: 'en',
  modelEffortPicker: true,
  showEffortBar: true,
  hideModelTags: true,
  hideDefaultEffort: true,
  customizeModelList: false,
  hiddenModels: [],
  defaultTierByFamily: { 'Gemini 4 Neon': 'high' },
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
  hideThinkingProse: true,
  resumeBannerEnabled: true,
  overviewUsageEnabled: true,
  overviewUsageDefaultPeriod: 'day',
  subagentFooterEnabled: true,
  opusGateMode: 'semi',
  opusGatePreferredTier: 'high',
  opusGateMinQuota5hPct: 20,
  opusGateMinQuotaWeeklyPct: 15,
  opusGateMaxAutoPerSession: 2,
  opusGateCheckpoints: { plan: true, risk: true, debug: true, stop: true },
  autoCompactMode: 'semi',
  autoCompactThresholdPct: 50,
  autoCompactMinWaitSec: 300,
  autoCompactHighWaterPct: 0,
  autoCompactTriggers: { longTimer: true, modelRequest: true, highWater: false },
  motionLevel: 'full',
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
    if (existsSync(STUDIO_PREFS_PATH)) {
      saved = JSON.parse(readFileSync(STUDIO_PREFS_PATH, 'utf8'));
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

export async function buildUserCustomJs({ writeToRepo = true, allowPrebuilt = false } = {}) {
  const preferPrebuilt = process.env.MAGA_USE_PREBUILT === '1';
  if (allowPrebuilt && existsSync(REPO_USER_JS)) {
    let esbuildMod = null;
    if (!preferPrebuilt) {
      try {
        esbuildMod = await loadEsbuild();
      } catch {
        esbuildMod = null;
      }
    }
    if (preferPrebuilt || !esbuildMod) {
      const code = readFileSync(REPO_USER_JS, 'utf8');
      if (code.trim()) {
        new Function('ctx', code);
        return { code, bytes: Buffer.byteLength(code, 'utf8'), prebuilt: true };
      }
    }
  }

  if (!existsSync(USER_ENTRY_FILE)) {
    throw new Error(`Missing user runtime entry point at ${USER_ENTRY_FILE}`);
  }
  const esbuild = await loadEsbuild();
  const bundled = await esbuild.build({
    entryPoints: [USER_ENTRY_FILE],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome126'],
    minify: false,
    keepNames: false,
    legalComments: 'none',
  });
  const compiled = (bundled.outputFiles?.[0]?.text || '').trim();
  if (!compiled) {
    throw new Error('esbuild produced an empty bundle for user/src/entry.mjs');
  }
  const banner = '/* Anti-Claude — user/custom.js (compiled from user/src/entry.mjs via esbuild; run `npm run build:user`) */';
  const code = `${banner}\n${compiled}\n`;
  // Validate standalone script compatibility with core/runtime.js and Chrome Desktop WebView
  new Function('ctx', code);
  if (writeToRepo) {
    writeFileSync(REPO_USER_JS, code, 'utf8');
  }
  return { code, bytes: Buffer.byteLength(code, 'utf8'), prebuilt: false };
}

export async function compileStudioCoreIife() {
  const esbuild = await loadEsbuild();
  const bundled = await esbuild.build({
    entryPoints: [ENTRY_FILE],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome126'],
    minify: false,
    keepNames: false,
    legalComments: 'none',
  });
  const compiledJs = (bundled.outputFiles?.[0]?.text || '').trim();
  if (!compiledJs) {
    throw new Error('esbuild produced an empty bundle for studio/entry.mjs');
  }
  return compiledJs;
}

export async function buildStudioBundle({ allowPrebuilt = true } = {}) {
  const imp = (file) => import(pathToFileURL(path.join(VENDOR_CAPSULE, file)).href);
  const [{ AGENT_ENTRY_CSS }, { EFFORT_BAR_CSS }] = await Promise.all([
    imp('agent_entry.mjs'),
    imp('effort_bar.mjs'),
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

  let coreIife = '';
  const preferPrebuilt = process.env.MAGA_USE_PREBUILT === '1';
  if (allowPrebuilt && existsSync(PREBUILT_STUDIO_ENTRY)) {
    let canUseEsbuild = !preferPrebuilt;
    if (canUseEsbuild) {
      try {
        await loadEsbuild();
      } catch {
        canUseEsbuild = false;
      }
    }
    if (!canUseEsbuild) {
      coreIife = readFileSync(PREBUILT_STUDIO_ENTRY, 'utf8').trim();
    }
  }
  if (!coreIife) {
    coreIife = await compileStudioCoreIife();
  }

  const wrappedJs = [
    '(function() {',
    `const __STUDIO_DEFAULT_PREFS__ = ${JSON.stringify(DEFAULT_PREFS)};`,
    `const __STUDIO_PREFS__ = ${JSON.stringify(prefs)};`,
    `const __STUDIO_LABELS__ = ${JSON.stringify(labelsByLang)};`,
    `const __PICKER_SHADOW_CSS__ = ${JSON.stringify(shadowCss)};`,
    coreIife,
    '})();',
  ].join('\n');

  const jsBlock = `${JS_BEGIN}\n${wrappedJs}\n${JS_END}\n`;

  // Fail fast if generated JS has any syntax issue before touching live files
  new Function('ctx', jsBlock);

  const combinedCss = STYLE_FILES.map((file) => {
    const body = readFileSync(path.join(STYLES_DIR, file), 'utf8').trim();
    return `/* --- studio/styles/${file} --- */\n${body}`;
  }).join('\n\n');

  const cssBlock = `${CSS_BEGIN}\n${combinedCss}\n${CSS_END}\n`;

  return { jsBlock, cssBlock, prefs };
}

function syncLiveConfigForStudio() {
  if (existsSync(TARGET_CONFIG_JSON)) {
    const raw = readFileSync(TARGET_CONFIG_JSON, 'utf8');
    const cfg = JSON.parse(raw);
    cfg.modules = cfg.modules && typeof cfg.modules === 'object' ? cfg.modules : {};
    let dirty = false;
    if (cfg.modules.claudeUxStepUnfold !== false) {
      cfg.modules.claudeUxStepUnfold = false;
      dirty = true;
    }
    if (cfg.cjkFontScale !== '100') {
      cfg.cjkFontScale = '100';
      dirty = true;
    }
    if (dirty) {
      writeFileSync(TARGET_CONFIG_JSON, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    }
  }
  if (existsSync(TARGET_UI_PREFS_JSON)) {
    try {
      const prefs = JSON.parse(readFileSync(TARGET_UI_PREFS_JSON, 'utf8'));
      if (prefs && typeof prefs === 'object') {
        prefs.modules = prefs.modules && typeof prefs.modules === 'object' ? prefs.modules : {};
        if (prefs.modules.claudeUxStepUnfold !== false) {
          prefs.modules.claudeUxStepUnfold = false;
          writeFileSync(TARGET_UI_PREFS_JSON, JSON.stringify(prefs, null, 2) + '\n', 'utf8');
        }
      }
    } catch {}
  }
}

export function stripStudioBlocksOnly() {
  if (existsSync(TARGET_CUSTOM_JS)) {
    const raw = stripBlock(readFileSync(TARGET_CUSTOM_JS, 'utf8'), JS_BEGIN, JS_END);
    writeFileSync(TARGET_CUSTOM_JS, raw, 'utf8');
  }
  if (existsSync(TARGET_CUSTOM_CSS)) {
    const raw = stripBlock(readFileSync(TARGET_CUSTOM_CSS, 'utf8'), CSS_BEGIN, CSS_END);
    writeFileSync(TARGET_CUSTOM_CSS, raw, 'utf8');
  }
}

export async function deployStudio({ allowNonMain = false, metaPath } = {}) {
  if (!existsSync(TARGET_CUSTOM_JS) || !existsSync(TARGET_CUSTOM_CSS)) {
    throw new Error(
      `Anti-Claude user directory not initialized at ${TARGET_USER_DIR}. Run "node studio/cli.mjs install" first.`
    );
  }

  const guard = evaluateDeployGuard(REPO_ROOT, { allowNonMain, metaPath });
  if (!guard.allowed) {
    throw new Error(guard.reason);
  }

  await buildUserCustomJs({ writeToRepo: true, allowPrebuilt: true });
  const { jsBlock, cssBlock, prefs } = await buildStudioBundle();

  let baseJs = existsSync(REPO_USER_JS) ? readFileSync(REPO_USER_JS, 'utf8') : readFileSync(TARGET_CUSTOM_JS, 'utf8');
  baseJs = stripBlock(baseJs, JS_BEGIN, JS_END);
  writeFileSync(TARGET_CUSTOM_JS, `${baseJs.replace(/\s+$/, '')}\n\n${jsBlock}`, 'utf8');

  let baseCss = existsSync(REPO_USER_CSS) ? readFileSync(REPO_USER_CSS, 'utf8') : readFileSync(TARGET_CUSTOM_CSS, 'utf8');
  baseCss = stripBlock(baseCss, CSS_BEGIN, CSS_END);
  writeFileSync(TARGET_CUSTOM_CSS, `${baseCss.replace(/\s+$/, '')}\n\n${cssBlock}`, 'utf8');

  syncLiveConfigForStudio();
  const deployedFrom = writeDeployMeta(REPO_ROOT, metaPath, { preview: Boolean(guard.preview) });

  return {
    ok: true,
    action: 'deployed',
    customJsPath: TARGET_CUSTOM_JS,
    customCssPath: TARGET_CUSTOM_CSS,
    configJsonPath: TARGET_CONFIG_JSON,
    jsBytes: Buffer.byteLength(jsBlock, 'utf8'),
    cssBytes: Buffer.byteLength(cssBlock, 'utf8'),
    deployedFrom,
    ...(guard.warnings.length ? { deployWarnings: guard.warnings } : {}),
    prefs,
  };
}

export function rollbackStudio() {
  stripStudioBlocksOnly();
  return { ok: true, action: 'rolled_back' };
}
