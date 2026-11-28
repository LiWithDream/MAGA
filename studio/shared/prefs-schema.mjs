/**
 * Single Source of Truth for AGY Studio (`agy-studio`) Preferences Schema & Sanitization.
 * Pure zero-dependency ESM safe for both Node (daemon/build) and Browser (esbuild bundle).
 */

export const DEFAULT_STUDIO_PREFS = Object.freeze({
  // Models & Thinking
  modelEffortPicker: true,
  showEffortBar: true,
  showModelDots: true,
  hideModelTags: true,
  hideDefaultEffort: true,
  customizeModelList: false,
  hiddenModels: [],
  defaultTierByFamily: { 'Gemini 4 Neon': 'high' },
  // Effort Bar & Orchestrator Visual Themes
  effortTheme: 'auto',
  geminiTheme: 'physical',
  claudeTheme: 'matrix',
  codexTheme: 'nebula',
  effortTicks: 'highlight',
  orchestratorMode: 'dock',
  orchestrator3dStyle: 'helix',
  orchestratorIcon: 'prism',
  // Conversation & Stream
  hideThinkingProse: true,
  resumeBannerEnabled: true,
  // Workspace & Panels
  overviewUsageEnabled: true,
  overviewUsageDefaultPeriod: 'day',
  subagentFooterEnabled: true,
  sidebarProjectCapEnabled: true,
  sidebarProjectMaxPerProject: 4,
  sidebarProjectMaxTotal: 8,
  sidebarProjectSortMode: 'recent',
  sidebarProjectSortCooldownSec: 300,
  // Review Gate (Carbon High / Opus High)
  opusGateMode: 'semi',
  opusGateModel: 'opus',
  opusGateMinQuota5hPct: 20,
  opusGateMinQuotaWeeklyPct: 15,
  opusGateMaxAutoPerSession: 2,
  opusGateCheckpoints: { plan: true, risk: true, debug: true, stop: true },
  // Auto-Compact
  autoCompactMode: 'semi',
  autoCompactThresholdPct: 50,
  autoCompactMinWaitSec: 300,
  autoCompactHighWaterPct: 0,
  autoCompactTriggers: { longTimer: true, modelRequest: true, highWater: false },
  // Anti-Drift Anchors & Locks
  anchorsMode: 'semi',
  // Appearance & Motion
  motionLevel: 'full',
  effortMotion: 'full',
});

export const STUDIO_PREFS_ENUMS = {
  effortTheme: new Set(['auto', 'gemini', 'claude', 'codex']),
  geminiTheme: new Set(['physical', 'ribbon', 'nebula']),
  claudeTheme: new Set(['matrix', 'bars', 'spark']),
  codexTheme: new Set(['nebula', 'beam', 'orb']),
  effortTicks: new Set(['highlight', 'dim', 'hidden']),
  orchestratorMode: new Set(['follow', 'dock', 'custom3d']),
  orchestrator3dStyle: new Set(['chamber', 'helix', 'orbital', 'c-matrix', 'c-louver', 'c-spark', 'nebula', 'beam', 'orb']),
  orchestratorIcon: new Set(['prism', 'gravity', 'semicircle', 'none']),
  overviewUsageDefaultPeriod: new Set(['day', 'week', 'month']),
  sidebarProjectSortMode: new Set(['recent', 'fixed', 'name', 'usage']),
  opusGateMode: new Set(['off', 'semi', 'auto']),
  opusGateModel: new Set(['carbon', 'opus']),
  autoCompactMode: new Set(['off', 'semi', 'auto']),
  anchorsMode: new Set(['off', 'semi']),
  motionLevel: new Set(['full', 'reduced', 'off']),
  effortMotion: new Set(['fast', 'full']),
};

export const VALID_EFFORT_TIERS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra', 'max']);

export function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function sanitizeSidebarCapInt(val, min, max, fallback) {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded <= 0) return 0;
  return Math.max(min, Math.min(max, rounded));
}

const VALID_SIDEBAR_SORT_COOLDOWN_SEC = new Set([0, 60, 300]);

export function sanitizeSidebarSortCooldownSec(val, fallback = 300) {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  return VALID_SIDEBAR_SORT_COOLDOWN_SEC.has(rounded) ? rounded : fallback;
}

export function sanitizeHighWaterPct(val, fallback) {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded <= 0) return 0;
  return Math.max(65, Math.min(95, rounded));
}

export function sanitizeOpusCheckpoints(raw, defaults = DEFAULT_STUDIO_PREFS) {
  const def = defaults?.opusGateCheckpoints || DEFAULT_STUDIO_PREFS.opusGateCheckpoints;
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    plan: typeof src.plan === 'boolean' ? src.plan : def.plan !== false,
    risk: typeof src.risk === 'boolean' ? src.risk : def.risk !== false,
    debug: typeof src.debug === 'boolean' ? src.debug : def.debug !== false,
    stop: typeof src.stop === 'boolean' ? src.stop : def.stop !== false,
  };
}

export function sanitizeAutoCompactTriggers(raw, defaults = DEFAULT_STUDIO_PREFS) {
  const def = defaults?.autoCompactTriggers || DEFAULT_STUDIO_PREFS.autoCompactTriggers;
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    longTimer: typeof src.longTimer === 'boolean' ? src.longTimer : def.longTimer !== false,
    modelRequest: typeof src.modelRequest === 'boolean' ? src.modelRequest : def.modelRequest !== false,
    highWater: typeof src.highWater === 'boolean' ? src.highWater : Boolean(def.highWater),
  };
}

export function sanitizeStudioPrefs(raw, defaults = DEFAULT_STUDIO_PREFS) {
  const def = defaults && typeof defaults === 'object' ? defaults : DEFAULT_STUDIO_PREFS;
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const boolOr = (k, fallback) => (typeof src[k] === 'boolean' ? src[k] : fallback);
  const enumOr = (k, fallback) => (STUDIO_PREFS_ENUMS[k].has(src[k]) ? src[k] : fallback);

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

  let defaultTierByFamily = { ...(def.defaultTierByFamily || DEFAULT_STUDIO_PREFS.defaultTierByFamily) };
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
    modelEffortPicker: boolOr('modelEffortPicker', def.modelEffortPicker),
    showEffortBar: boolOr('showEffortBar', def.showEffortBar),
    showModelDots: boolOr('showModelDots', def.showModelDots),
    hideModelTags: boolOr('hideModelTags', def.hideModelTags),
    hideDefaultEffort: boolOr('hideDefaultEffort', def.hideDefaultEffort),
    customizeModelList: boolOr('customizeModelList', def.customizeModelList),
    hiddenModels,
    defaultTierByFamily,
    effortTheme: enumOr('effortTheme', def.effortTheme),
    geminiTheme: enumOr('geminiTheme', def.geminiTheme),
    claudeTheme: enumOr('claudeTheme', def.claudeTheme),
    codexTheme: enumOr('codexTheme', def.codexTheme),
    effortTicks: enumOr('effortTicks', def.effortTicks),
    orchestratorMode: enumOr('orchestratorMode', def.orchestratorMode),
    orchestrator3dStyle: enumOr('orchestrator3dStyle', def.orchestrator3dStyle),
    orchestratorIcon: enumOr('orchestratorIcon', def.orchestratorIcon),
    hideThinkingProse: boolOr('hideThinkingProse', def.hideThinkingProse),
    resumeBannerEnabled: boolOr('resumeBannerEnabled', def.resumeBannerEnabled),
    overviewUsageEnabled: boolOr('overviewUsageEnabled', def.overviewUsageEnabled),
    overviewUsageDefaultPeriod: enumOr('overviewUsageDefaultPeriod', def.overviewUsageDefaultPeriod),
    subagentFooterEnabled: boolOr('subagentFooterEnabled', def.subagentFooterEnabled),
    sidebarProjectCapEnabled: boolOr('sidebarProjectCapEnabled', def.sidebarProjectCapEnabled),
    sidebarProjectMaxPerProject: sanitizeSidebarCapInt(src.sidebarProjectMaxPerProject, 1, 20, def.sidebarProjectMaxPerProject),
    sidebarProjectMaxTotal: sanitizeSidebarCapInt(src.sidebarProjectMaxTotal, 2, 40, def.sidebarProjectMaxTotal),
    sidebarProjectSortMode: enumOr('sidebarProjectSortMode', def.sidebarProjectSortMode ?? 'recent'),
    sidebarProjectSortCooldownSec: sanitizeSidebarSortCooldownSec(
      src.sidebarProjectSortCooldownSec,
      def.sidebarProjectSortCooldownSec ?? 300
    ),
    opusGateMode: enumOr('opusGateMode', def.opusGateMode),
    opusGateModel: enumOr('opusGateModel', def.opusGateModel),
    opusGateMinQuota5hPct: clampInt(src.opusGateMinQuota5hPct, 5, 80, def.opusGateMinQuota5hPct),
    opusGateMinQuotaWeeklyPct: clampInt(src.opusGateMinQuotaWeeklyPct, 5, 60, def.opusGateMinQuotaWeeklyPct),
    opusGateMaxAutoPerSession: clampInt(src.opusGateMaxAutoPerSession, 1, 5, def.opusGateMaxAutoPerSession),
    opusGateCheckpoints: sanitizeOpusCheckpoints(src.opusGateCheckpoints, def),
    autoCompactMode: enumOr('autoCompactMode', def.autoCompactMode),
    autoCompactThresholdPct: clampInt(src.autoCompactThresholdPct, 25, 85, def.autoCompactThresholdPct),
    autoCompactMinWaitSec: clampInt(src.autoCompactMinWaitSec, 60, 3600, def.autoCompactMinWaitSec),
    autoCompactHighWaterPct: sanitizeHighWaterPct(src.autoCompactHighWaterPct, def.autoCompactHighWaterPct),
    autoCompactTriggers: sanitizeAutoCompactTriggers(src.autoCompactTriggers, def),
    anchorsMode: enumOr('anchorsMode', def.anchorsMode ?? 'semi'),
    motionLevel: enumOr('motionLevel', def.motionLevel),
    effortMotion: enumOr('effortMotion', def.effortMotion),
  };
}
