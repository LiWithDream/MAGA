/**
 * 3. Config, Studio Prefs & Bundle Hot-Reload Compiler
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALLOWED_UI_MODULE_KEYS,
  BASE_CONFIG_FILE,
  CORE_BASE_CSS_FILE,
  CORE_I18N_FILE,
  CORE_RUNTIME_FILE,
  PKG_FILE,
  STATE_DIR,
  STUDIO_PREFS_FILE,
  UI_PREFS_FILE,
  USER_DIR,
  VALID_CJK_SCALES,
  discoverEndpoints,
  readJsonOrFallback,
  readTextOrEmpty,
  statSig,
  writeAtomicUtf8
} from './env.mjs';

let lastBundleFilesSig = '';
let cachedRuntimeTemplate = '';
let cachedBootPayloadBase = null;
let cachedBundleHash = '';
let cachedVersion = '3.0.2';
let activeConfig = {
  enabled: true,
  contextLimit: 256000,
  contextLimitOverride: 0,
  modules: {},
  endpoints: []
};

export function getActiveConfig() {
  return activeConfig;
}

export function getBundleHash() {
  return cachedBundleHash;
}

export function getCachedVersion() {
  return cachedVersion;
}

export function getCachedBootPayload() {
  return cachedBootPayloadBase;
}

function sanitizeUiPrefs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const modules = {};
  if (raw.modules && typeof raw.modules === 'object' && !Array.isArray(raw.modules)) {
    for (const [k, v] of Object.entries(raw.modules)) {
      if (ALLOWED_UI_MODULE_KEYS.has(k) && typeof v === 'boolean') {
        modules[k] = v;
      }
    }
  }
  const rawScale = String(raw.cjkFontScale ?? '').trim().replace(/%$/, '');
  const cjkFontScale = VALID_CJK_SCALES.has(rawScale) ? rawScale : null;
  const uiState = {};
  if (raw.uiState && typeof raw.uiState === 'object' && !Array.isArray(raw.uiState)) {
    if (typeof raw.uiState.recentCollapsed === 'boolean') {
      uiState.recentCollapsed = raw.uiState.recentCollapsed;
    }
    if (typeof raw.uiState.unifiedRecentCollapsed === 'boolean') {
      uiState.unifiedRecentCollapsed = raw.uiState.unifiedRecentCollapsed;
    }
  }
  const updatedAt = Number(raw.updatedAt) > 0 ? Math.floor(Number(raw.updatedAt)) : 0;
  return { modules, cjkFontScale, uiState, updatedAt };
}

function resolveEffectiveUserConfig(userConfigFile, rawCfg) {
  const baseObj = rawCfg && typeof rawCfg === 'object' && !Array.isArray(rawCfg) ? rawCfg : {};
  const prefs = sanitizeUiPrefs(readJsonOrFallback(UI_PREFS_FILE, null));
  if (!prefs) return baseObj;

  let manualConfigNewer = false;
  if (prefs.updatedAt > 0) {
    try {
      const st = fs.statSync(userConfigFile, { throwIfNoEntry: false });
      if (st && st.mtimeMs > prefs.updatedAt + 500) {
        const userRaw = readTextOrEmpty(userConfigFile);
        const baseRaw = readTextOrEmpty(BASE_CONFIG_FILE);
        if (userRaw && userRaw !== baseRaw) {
          manualConfigNewer = true;
        }
      }
    } catch {}
  }

  const rawMods = baseObj.modules && typeof baseObj.modules === 'object' ? baseObj.modules : {};
  const mergedModules = manualConfigNewer
    ? Object.assign({}, prefs.modules, rawMods)
    : Object.assign({}, rawMods, prefs.modules);
  const mergedUiState = Object.assign(
    {},
    baseObj.uiState && typeof baseObj.uiState === 'object' ? baseObj.uiState : {},
    prefs.uiState
  );
  const out = Object.assign({}, baseObj, {
    modules: mergedModules,
    uiState: mergedUiState,
    uiPrefsUpdatedAt: prefs.updatedAt || Date.now()
  });
  if (prefs.cjkFontScale && (!manualConfigNewer || !baseObj.cjkFontScale)) {
    out.cjkFontScale = prefs.cjkFontScale;
  }
  return out;
}

export function saveUiPrefs(payload) {
  const cur = sanitizeUiPrefs(readJsonOrFallback(UI_PREFS_FILE, null)) || {
    modules: {},
    cjkFontScale: null,
    uiState: {},
    updatedAt: 0
  };
  const incoming = sanitizeUiPrefs(payload) || {
    modules: {},
    cjkFontScale: null,
    uiState: {},
    updatedAt: 0
  };
  const updatedAt = Math.max(Date.now(), cur.updatedAt + 1, incoming.updatedAt);
  const next = {
    schema: 1,
    updatedAt,
    modules: Object.assign({}, cur.modules, incoming.modules),
    ...(incoming.cjkFontScale || cur.cjkFontScale
      ? { cjkFontScale: incoming.cjkFontScale || cur.cjkFontScale }
      : {}),
    uiState: Object.assign({}, cur.uiState, incoming.uiState)
  };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  writeAtomicUtf8(UI_PREFS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return {
    ok: true,
    updatedAt,
    modules: next.modules,
    cjkFontScale: next.cjkFontScale || null,
    uiState: next.uiState
  };
}

export const DEFAULT_STUDIO_PREFS = Object.freeze({
  // 模型与思考
  modelEffortPicker: true,
  showEffortBar: true,
  showModelDots: true,
  hideModelTags: true,
  hideDefaultEffort: true,
  customizeModelList: false,
  hiddenModels: [],
  defaultTierByFamily: { 'Gemini 4 Neon': 'high' },
  // Effort Bar & Orchestrator 视觉主题
  effortTheme: 'auto',
  geminiTheme: 'physical',
  claudeTheme: 'matrix',
  codexTheme: 'nebula',
  effortTicks: 'highlight',
  orchestratorMode: 'dock',
  orchestrator3dStyle: 'helix',
  orchestratorIcon: 'prism',
  // 对话与过程流
  hideThinkingProse: true,
  resumeBannerEnabled: true,
  // 工作区与面板
  overviewUsageEnabled: true,
  overviewUsageDefaultPeriod: 'day',
  subagentFooterEnabled: true,
  // 外观与动效
  motionLevel: 'full',
  effortMotion: 'full',
});

const STUDIO_ENUMS = {
  effortTheme: new Set(['auto', 'gemini', 'claude', 'codex']),
  geminiTheme: new Set(['physical', 'ribbon', 'nebula']),
  claudeTheme: new Set(['matrix', 'bars', 'spark']),
  codexTheme: new Set(['nebula', 'beam', 'orb']),
  effortTicks: new Set(['highlight', 'dim', 'hidden']),
  orchestratorMode: new Set(['follow', 'dock', 'custom3d']),
  orchestrator3dStyle: new Set(['chamber', 'helix', 'orbital', 'c-matrix', 'c-louver', 'c-spark', 'nebula', 'beam', 'orb']),
  orchestratorIcon: new Set(['prism', 'gravity', 'semicircle', 'none']),
  overviewUsageDefaultPeriod: new Set(['day', 'week', 'month']),
  motionLevel: new Set(['full', 'reduced', 'off']),
  effortMotion: new Set(['fast', 'full']),
};
const VALID_EFFORT_TIERS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra', 'max']);

export function sanitizeStudioPrefs(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const boolOr = (k, def) => (typeof src[k] === 'boolean' ? src[k] : def);
  const enumOr = (k, def) => (STUDIO_ENUMS[k].has(src[k]) ? src[k] : def);

  const hiddenModels = [];
  if (Array.isArray(src.hiddenModels)) {
    const seen = new Set();
    for (const item of src.hiddenModels) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      hiddenModels.push(trimmed);
      if (hiddenModels.length >= 200) break;
    }
  }

  let defaultTierByFamily = { ...DEFAULT_STUDIO_PREFS.defaultTierByFamily };
  if (src.defaultTierByFamily && typeof src.defaultTierByFamily === 'object' && !Array.isArray(src.defaultTierByFamily)) {
    const cleaned = {};
    for (const [k, v] of Object.entries(src.defaultTierByFamily)) {
      const fam = String(k || '').trim();
      const tier = String(v || '').trim().toLowerCase();
      if (fam && VALID_EFFORT_TIERS.has(tier)) {
        cleaned[fam] = tier;
      }
    }
    defaultTierByFamily = cleaned;
  }

  const updatedAt = Number(src.updatedAt) > 0 ? Math.floor(Number(src.updatedAt)) : 0;

  return {
    schema: 1,
    updatedAt,
    modelEffortPicker: boolOr('modelEffortPicker', DEFAULT_STUDIO_PREFS.modelEffortPicker),
    showEffortBar: boolOr('showEffortBar', DEFAULT_STUDIO_PREFS.showEffortBar),
    showModelDots: boolOr('showModelDots', DEFAULT_STUDIO_PREFS.showModelDots),
    hideModelTags: boolOr('hideModelTags', DEFAULT_STUDIO_PREFS.hideModelTags),
    hideDefaultEffort: boolOr('hideDefaultEffort', DEFAULT_STUDIO_PREFS.hideDefaultEffort),
    customizeModelList: boolOr('customizeModelList', DEFAULT_STUDIO_PREFS.customizeModelList),
    hiddenModels,
    defaultTierByFamily,
    effortTheme: enumOr('effortTheme', DEFAULT_STUDIO_PREFS.effortTheme),
    geminiTheme: enumOr('geminiTheme', DEFAULT_STUDIO_PREFS.geminiTheme),
    claudeTheme: enumOr('claudeTheme', DEFAULT_STUDIO_PREFS.claudeTheme),
    codexTheme: enumOr('codexTheme', DEFAULT_STUDIO_PREFS.codexTheme),
    effortTicks: enumOr('effortTicks', DEFAULT_STUDIO_PREFS.effortTicks),
    orchestratorMode: enumOr('orchestratorMode', DEFAULT_STUDIO_PREFS.orchestratorMode),
    orchestrator3dStyle: enumOr('orchestrator3dStyle', DEFAULT_STUDIO_PREFS.orchestrator3dStyle),
    orchestratorIcon: enumOr('orchestratorIcon', DEFAULT_STUDIO_PREFS.orchestratorIcon),
    hideThinkingProse: boolOr('hideThinkingProse', DEFAULT_STUDIO_PREFS.hideThinkingProse),
    resumeBannerEnabled: boolOr('resumeBannerEnabled', DEFAULT_STUDIO_PREFS.resumeBannerEnabled),
    overviewUsageEnabled: boolOr('overviewUsageEnabled', DEFAULT_STUDIO_PREFS.overviewUsageEnabled),
    overviewUsageDefaultPeriod: enumOr('overviewUsageDefaultPeriod', DEFAULT_STUDIO_PREFS.overviewUsageDefaultPeriod),
    subagentFooterEnabled: boolOr('subagentFooterEnabled', DEFAULT_STUDIO_PREFS.subagentFooterEnabled),
    motionLevel: enumOr('motionLevel', DEFAULT_STUDIO_PREFS.motionLevel),
    effortMotion: enumOr('effortMotion', DEFAULT_STUDIO_PREFS.effortMotion),
  };
}

export function loadStudioPrefs(opts = {}) {
  const studioPrefsFile = opts.studioPrefsFile || STUDIO_PREFS_FILE;
  const existing = readJsonOrFallback(studioPrefsFile, null);
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return sanitizeStudioPrefs(existing);
  }
  return sanitizeStudioPrefs({ ...DEFAULT_STUDIO_PREFS });
}

export function saveStudioPrefs(payload, opts = {}) {
  const studioPrefsFile = opts.studioPrefsFile || STUDIO_PREFS_FILE;
  const cur = loadStudioPrefs(opts);
  const src = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  let merged;
  if (src.reset === true) {
    merged = {
      ...DEFAULT_STUDIO_PREFS,
      hiddenModels: [],
      defaultTierByFamily: { ...DEFAULT_STUDIO_PREFS.defaultTierByFamily },
    };
  } else if (src.replace === true) {
    const rawNext = src.prefs && typeof src.prefs === 'object' ? src.prefs : src;
    merged = { ...DEFAULT_STUDIO_PREFS, ...rawNext };
  } else {
    merged = { ...cur, ...src };
  }
  const incomingTs = Number(src.updatedAt) > 0 ? Math.floor(Number(src.updatedAt)) : 0;
  const updatedAt = Math.max(Date.now(), (cur.updatedAt || 0) + 1, incomingTs);
  const next = sanitizeStudioPrefs({ ...merged, updatedAt });
  fs.mkdirSync(path.dirname(studioPrefsFile), { recursive: true });
  writeAtomicUtf8(studioPrefsFile, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, prefs: next };
}

export function rebuildBundleIfNeeded() {
  const userConfigFile = path.join(USER_DIR, 'config.json');
  const userCssFile = path.join(USER_DIR, 'custom.css');
  const userJsFile = path.join(USER_DIR, 'custom.js');
  const userI18nFile = path.join(USER_DIR, 'i18n.override.json');

  const filesSig = [
    statSig(PKG_FILE),
    statSig(CORE_BASE_CSS_FILE),
    statSig(CORE_I18N_FILE),
    statSig(CORE_RUNTIME_FILE),
    statSig(userConfigFile),
    statSig(UI_PREFS_FILE),
    statSig(STUDIO_PREFS_FILE),
    statSig(userCssFile),
    statSig(userJsFile),
    statSig(userI18nFile)
  ].join('|');

  const endpoints = discoverEndpoints();
  activeConfig.endpoints = endpoints;

  if (filesSig === lastBundleFilesSig && cachedBootPayloadBase) {
    return false;
  }
  lastBundleFilesSig = filesSig;

  const pkg = readJsonOrFallback(PKG_FILE, {});
  cachedVersion = pkg?.version ? `anti-claude-${pkg.version}` : 'anti-claude-3.0.2';

  const diskCfg = readJsonOrFallback(userConfigFile, {});
  const rawCfg = resolveEffectiveUserConfig(userConfigFile, diskCfg);
  const enabled = rawCfg?.enabled !== false;
  const modules = Object.assign(
    {
      i18n: false,
      metrics: true,
      zoomShortcuts: true,
      customCss: true,
      customJs: true
    },
    rawCfg?.modules || {}
  );
  const themeVars = rawCfg?.themeVars && typeof rawCfg.themeVars === 'object' ? rawCfg.themeVars : {};
  const darkThemeVars = rawCfg?.darkThemeVars && typeof rawCfg.darkThemeVars === 'object' ? rawCfg.darkThemeVars : {};

  const coreDict = readJsonOrFallback(CORE_I18N_FILE, {});
  const overrideDict = readJsonOrFallback(userI18nFile, {});
  const mergedDict = Object.assign({}, coreDict, overrideDict);
  delete mergedDict._comment;

  const baseCss = readTextOrEmpty(CORE_BASE_CSS_FILE);
  const customCss = readTextOrEmpty(userCssFile);
  const customJs = readTextOrEmpty(userJsFile);
  cachedRuntimeTemplate = readTextOrEmpty(CORE_RUNTIME_FILE);

  activeConfig = {
    enabled,
    contextLimit: Number(rawCfg?.contextLimit) > 0 ? Number(rawCfg.contextLimit) : 256000,
    contextLimitOverride: Number(rawCfg?.contextLimitOverride) > 0 ? Number(rawCfg.contextLimitOverride) : 0,
    modules,
    endpoints
  };

  cachedBootPayloadBase = {
    version: cachedVersion,
    platform: process.platform,
    enabled,
    config: rawCfg || {},
    modules,
    studioPrefs: loadStudioPrefs(),
    themeVars,
    darkThemeVars,
    cssText: baseCss,
    customCss,
    customJs,
    dict: mergedDict
  };

  cachedBundleHash = crypto
    .createHash('sha1')
    .update(JSON.stringify(cachedBootPayloadBase))
    .update(cachedRuntimeTemplate)
    .digest('hex')
    .slice(0, 12);

  return true;
}

export function buildRuntimeScript(hostThemeMode = null, rpcToken = '', rpcSessionId = '') {
  if (!cachedRuntimeTemplate || !cachedBootPayloadBase) return '';
  const extra = {};
  if (hostThemeMode) extra.hostThemeMode = hostThemeMode;
  if (rpcToken) extra.rpcToken = rpcToken;
  if (rpcSessionId) extra.rpcSessionId = rpcSessionId;
  const payload = Object.keys(extra).length > 0 ? Object.assign({}, cachedBootPayloadBase, extra) : cachedBootPayloadBase;
  return cachedRuntimeTemplate.replace('(__AG_BOOT_PAYLOAD__);', () => `(${JSON.stringify(payload)});`);
}
