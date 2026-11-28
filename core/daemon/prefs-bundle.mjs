/**
 * 3. Config, Studio Prefs & Bundle Hot-Reload Compiler
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_STUDIO_PREFS, sanitizeStudioPrefs } from '../../studio/shared/prefs-schema.mjs';
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
  const stepUnfoldDefaultMigrated = raw.stepUnfoldDefaultMigrated === true;
  return { modules, cjkFontScale, uiState, updatedAt, stepUnfoldDefaultMigrated };
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
    stepUnfoldDefaultMigrated: true,
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

export { DEFAULT_STUDIO_PREFS, sanitizeStudioPrefs };

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
