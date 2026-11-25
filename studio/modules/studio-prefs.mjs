/**
 * Unified runtime preferences store & 3-way synchronization center for MAGA (agy-studio).
 * Bridges:
 * 1. MAGA studioPrefs -> daemon RPC (`getStudioPrefs` / `saveStudioPrefs` -> studio-prefs.json) + local cache
 * 2. Anti-Claude base modules (`window.__agClaudeUxBridge` -> ui-prefs.json)
 * 3. Antigravity host native React `prefStore` (`orchestratorModel`, `orchestratorExecutorModel`, `verboseConversationSteps`)
 */

export function createStudioPrefsRuntime({ initialPrefs, defaultPrefs, effortEffects, cfgMods } = {}) {
  const PREFS_CACHE_KEY = 'agy_studio_prefs_cache_v1';
  const MODEL_CATALOG_CACHE_KEY = 'agy_studio_model_catalog_v1';
  const EFFORT_STORAGE_KEY = 'agy-capsule.effort-bar.v1';
  const MODS_STORAGE_KEY = 'ag_claude_ux_modules_v1';
  const EFFORT_EVENT = 'agy-capsule:effort-bar';

  const FALLBACK_DEFAULTS = {
    modelEffortPicker: true,
    showEffortBar: true,
    showModelDots: true,
    hideModelTags: true,
    hideDefaultEffort: true,
    customizeModelList: false,
    hiddenModels: [],
    defaultTierByFamily: { 'Gemini 4 Neon': 'high' },
    effortTheme: 'auto',
    geminiTheme: 'physical',
    claudeTheme: 'matrix',
    codexTheme: 'nebula',
    effortTicks: 'highlight',
    orchestratorMode: 'dock',
    orchestrator3dStyle: 'helix',
    orchestratorIcon: 'prism',
    hideThinkingProse: true,
    resumeBannerEnabled: true,
    overviewUsageEnabled: true,
    overviewUsageDefaultPeriod: 'day',
    subagentFooterEnabled: true,
    motionLevel: 'full',
    effortMotion: 'full',
  };

  const DEFAULTS = Object.assign({}, FALLBACK_DEFAULTS, defaultPrefs || {});
  const VALID_ENUMS = {
    effortTheme: ['auto', 'gemini', 'claude', 'codex'],
    geminiTheme: ['physical', 'ribbon', 'nebula'],
    claudeTheme: ['matrix', 'bars', 'spark'],
    codexTheme: ['nebula', 'beam', 'orb'],
    effortTicks: ['highlight', 'dim', 'hidden'],
    orchestratorMode: ['follow', 'dock', 'custom3d'],
    orchestrator3dStyle: ['chamber', 'helix', 'orbital', 'c-matrix', 'c-louver', 'c-spark', 'nebula', 'beam', 'orb'],
    orchestratorIcon: ['prism', 'gravity', 'semicircle', 'none'],
    overviewUsageDefaultPeriod: ['day', 'week', 'month'],
    motionLevel: ['full', 'reduced', 'off'],
    effortMotion: ['fast', 'full'],
  };
  const VALID_TIERS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra', 'max']);
  const EFFORT_KEYS = [
    'effortTheme',
    'geminiTheme',
    'claudeTheme',
    'codexTheme',
    'effortTicks',
    'orchestratorMode',
    'orchestrator3dStyle',
    'orchestratorIcon',
    'effortMotion',
  ];
  const EFFORT_LOCAL_TO_PREF = {
    theme: 'effortTheme',
    geminiTheme: 'geminiTheme',
    claudeTheme: 'claudeTheme',
    codexTheme: 'codexTheme',
    ticks: 'effortTicks',
    orchestratorMode: 'orchestratorMode',
    orchestrator3dStyle: 'orchestrator3dStyle',
    orchestratorIcon: 'orchestratorIcon',
    motion: 'effortMotion',
  };
  const BASE_MODULE_DEFAULTS = {
    i18n: false,
    claudeUxStepUnfold: false,
    claudeUxCodeFold: true,
    claudeUxHideSidebarProjects: true,
    claudeUxContextRing: true,
    claudeUxProjects: true,
    claudeUxCustomizations: true,
  };
  const DEFAULT_HOST_ORCHESTRATOR_MODEL = 1532; // Gemini 4 Neon (High)

  let disposed = false;
  let applyingSidecar = false;
  let saveTimer = 0;
  let retryTimer = 0;
  let cachedHostPrefStore = null;
  let toastListenersBound = false;
  const listeners = new Set();

  function cloneJson(v) {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return v;
    }
  }

  function sanitizeLocal(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const boolOr = (k, def) => (typeof src[k] === 'boolean' ? src[k] : def);
    const enumOr = (k, def) => (VALID_ENUMS[k].includes(src[k]) ? src[k] : def);

    const hiddenModels = [];
    if (Array.isArray(src.hiddenModels)) {
      const seen = new Set();
      for (const item of src.hiddenModels) {
        if (typeof item !== 'string') continue;
        const t = item.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        hiddenModels.push(t);
        if (hiddenModels.length >= 200) break;
      }
    }

    let defaultTierByFamily = Object.assign({}, DEFAULTS.defaultTierByFamily);
    if (src.defaultTierByFamily && typeof src.defaultTierByFamily === 'object' && !Array.isArray(src.defaultTierByFamily)) {
      const cleaned = {};
      for (const [k, v] of Object.entries(src.defaultTierByFamily)) {
        const fam = String(k || '').trim();
        const tier = String(v || '').trim().toLowerCase();
        if (fam && VALID_TIERS.has(tier)) cleaned[fam] = tier;
      }
      defaultTierByFamily = cleaned;
    }

    return {
      schema: 1,
      updatedAt: Number(src.updatedAt) > 0 ? Math.floor(Number(src.updatedAt)) : 0,
      modelEffortPicker: boolOr('modelEffortPicker', DEFAULTS.modelEffortPicker),
      showEffortBar: boolOr('showEffortBar', DEFAULTS.showEffortBar),
      showModelDots: boolOr('showModelDots', DEFAULTS.showModelDots),
      hideModelTags: boolOr('hideModelTags', DEFAULTS.hideModelTags),
      hideDefaultEffort: boolOr('hideDefaultEffort', DEFAULTS.hideDefaultEffort),
      customizeModelList: boolOr('customizeModelList', DEFAULTS.customizeModelList),
      hiddenModels,
      defaultTierByFamily,
      effortTheme: enumOr('effortTheme', DEFAULTS.effortTheme),
      geminiTheme: enumOr('geminiTheme', DEFAULTS.geminiTheme),
      claudeTheme: enumOr('claudeTheme', DEFAULTS.claudeTheme),
      codexTheme: enumOr('codexTheme', DEFAULTS.codexTheme),
      effortTicks: enumOr('effortTicks', DEFAULTS.effortTicks),
      orchestratorMode: enumOr('orchestratorMode', DEFAULTS.orchestratorMode),
      orchestrator3dStyle: enumOr('orchestrator3dStyle', DEFAULTS.orchestrator3dStyle),
      orchestratorIcon: enumOr('orchestratorIcon', DEFAULTS.orchestratorIcon),
      hideThinkingProse: boolOr('hideThinkingProse', DEFAULTS.hideThinkingProse),
      resumeBannerEnabled: boolOr('resumeBannerEnabled', DEFAULTS.resumeBannerEnabled),
      overviewUsageEnabled: boolOr('overviewUsageEnabled', DEFAULTS.overviewUsageEnabled),
      overviewUsageDefaultPeriod: enumOr('overviewUsageDefaultPeriod', DEFAULTS.overviewUsageDefaultPeriod),
      subagentFooterEnabled: boolOr('subagentFooterEnabled', DEFAULTS.subagentFooterEnabled),
      motionLevel: enumOr('motionLevel', DEFAULTS.motionLevel),
      effortMotion: enumOr('effortMotion', DEFAULTS.effortMotion),
    };
  }

  function readLocalCache() {
    try {
      if (typeof localStorage !== 'object' || !localStorage) return null;
      const raw = localStorage.getItem(PREFS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? sanitizeLocal(parsed) : null;
    } catch {
      return null;
    }
  }

  function writeLocalCache(cur) {
    try {
      if (typeof localStorage !== 'object' || !localStorage) return;
      localStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(cur));
    } catch {}
  }

  function applyDomEffects(cur) {
    const docRoot = typeof document === 'object' ? document.documentElement : null;
    if (!docRoot) return;
    if (cur.hideThinkingProse === false) {
      if (docRoot.getAttribute('data-agy-show-thinking') !== '1') {
        docRoot.setAttribute('data-agy-show-thinking', '1');
      }
    } else if (docRoot.hasAttribute('data-agy-show-thinking')) {
      docRoot.removeAttribute('data-agy-show-thinking');
    }
    const motionVal = cur.motionLevel || 'full';
    if (docRoot.getAttribute('data-agy-motion') !== motionVal) {
      docRoot.setAttribute('data-agy-motion', motionVal);
    }
  }

  function pushSidecarPrefs(cur) {
    if (typeof effortEffects !== 'function') return;
    applyingSidecar = true;
    try {
      effortEffects().applySidecarPrefs(cur, window);
    } catch {} finally {
      applyingSidecar = false;
    }
  }

  // Hydrate initial state preferring whichever has newer updatedAt between daemon snapshot and local cache
  const initSanitized = sanitizeLocal(initialPrefs || DEFAULTS);
  const cachedSanitized = readLocalCache();
  let state =
    cachedSanitized && cachedSanitized.updatedAt > initSanitized.updatedAt
      ? cachedSanitized
      : initSanitized;
  writeLocalCache(state);
  applyDomEffects(state);

  // Sync effort sidecar on startup if no effort localStorage yet or daemon snapshot already carries saved state
  try {
    const hasEffortLocal = typeof localStorage === 'object' && localStorage && localStorage.getItem(EFFORT_STORAGE_KEY);
    if (!hasEffortLocal || state.updatedAt > 0) {
      pushSidecarPrefs(state);
    }
  } catch {}

  function notify(reason = 'change') {
    const snap = cloneJson(state);
    for (const fn of Array.from(listeners)) {
      try {
        fn(snap, reason);
      } catch {}
    }
  }

  function sendSaveRpc(payload) {
    if (disposed || typeof window !== 'object' || typeof window.__agProjectCall !== 'function') return;
    Promise.resolve(window.__agProjectCall('saveStudioPrefs', payload, 5000))
      .then((res) => {
        if (disposed) return;
        if (!res || !res.ok) {
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            retryTimer = 0;
            if (!disposed && typeof window.__agProjectCall === 'function') {
              window.__agProjectCall('saveStudioPrefs', payload, 5000).catch(() => {});
            }
          }, 450);
          return;
        }
        if (res.prefs && typeof res.prefs === 'object') {
          const confirmed = sanitizeLocal(res.prefs);
          if (confirmed.updatedAt >= state.updatedAt) {
            state = confirmed;
            writeLocalCache(state);
          }
        }
      })
      .catch(() => {});
  }

  function scheduleDaemonSave(payload, immediate = false) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    if (immediate) {
      sendSaveRpc(payload);
      return;
    }
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      sendSaveRpc(payload);
    }, 60);
  }

  function hasEffortChanges(obj) {
    return EFFORT_KEYS.some((k) => k in obj);
  }

  function get() {
    return state;
  }

  function patch(partial, { skipDaemon = false, immediate = false, reason = 'patch' } = {}) {
    if (!partial || typeof partial !== 'object') return state;
    const rawPatch = Object.assign({}, partial);
    if ('motionLevel' in rawPatch && !('effortMotion' in rawPatch)) {
      rawPatch.effortMotion =
        rawPatch.motionLevel === 'reduced' || rawPatch.motionLevel === 'off' ? 'fast' : 'full';
    }
    const nextTs = Math.max(Date.now(), (state.updatedAt || 0) + 1);
    const next = sanitizeLocal(Object.assign({}, state, rawPatch, { updatedAt: nextTs }));
    state = next;
    writeLocalCache(state);
    applyDomEffects(state);
    if (hasEffortChanges(rawPatch)) pushSidecarPrefs(state);
    notify(reason);
    if (!skipDaemon) {
      scheduleDaemonSave(Object.assign({}, rawPatch, { updatedAt: nextTs }), immediate);
    }
    return state;
  }

  function replaceAll(nextRaw, { reason = 'replace' } = {}) {
    const nextTs = Math.max(Date.now(), (state.updatedAt || 0) + 1);
    const next = sanitizeLocal(Object.assign({}, DEFAULTS, nextRaw || {}, { updatedAt: nextTs }));
    state = next;
    writeLocalCache(state);
    applyDomEffects(state);
    pushSidecarPrefs(state);
    notify(reason);
    sendSaveRpc({ replace: true, prefs: next, updatedAt: nextTs });
    return state;
  }

  function reset({ reason = 'reset' } = {}) {
    const nextTs = Math.max(Date.now(), (state.updatedAt || 0) + 1);
    state = sanitizeLocal(
      Object.assign({}, DEFAULTS, {
        hiddenModels: [],
        defaultTierByFamily: Object.assign({}, DEFAULTS.defaultTierByFamily),
        updatedAt: nextTs,
      })
    );
    writeLocalCache(state);
    applyDomEffects(state);
    pushSidecarPrefs(state);
    notify(reason);
    sendSaveRpc({ reset: true, updatedAt: nextTs });
    return state;
  }

  async function resetAll() {
    reset({ reason: 'reset-all' });
    for (const [k, defVal] of Object.entries(BASE_MODULE_DEFAULTS)) {
      setBaseModule(k, defVal);
    }
    setCjkScale('95');
    await setHostPref('orchestratorModel', DEFAULT_HOST_ORCHESTRATOR_MODEL);
    await setHostPref('orchestratorExecutorModel', 0);
    await setHostPref('verboseConversationSteps', false);
    notify('reset-all');
    return true;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // Bidirectional sync when user edits Effort Bar settings via its right-click menu
  function onSidecarEffortEvent(event) {
    if (disposed || applyingSidecar) return;
    const detail = event?.detail;
    if (!detail || typeof detail !== 'object') return;
    const delta = {};
    for (const [localKey, prefKey] of Object.entries(EFFORT_LOCAL_TO_PREF)) {
      if (localKey in detail && detail[localKey] !== state[prefKey]) {
        delta[prefKey] = detail[localKey];
      }
    }
    if (Object.keys(delta).length > 0) {
      patch(delta, { reason: 'effort-sidecar' });
    }
  }
  if (typeof window === 'object' && window && typeof window.addEventListener === 'function') {
    window.addEventListener(EFFORT_EVENT, onSidecarEffortEvent);
    toastListenersBound = true;
  }

  // Pull latest daemon snapshot once shortly after boot in case another tab saved recently
  let hydrateTimer = 0;
  function hydrateFromDaemon() {
    if (disposed || typeof window !== 'object' || typeof window.__agProjectCall !== 'function') return;
    Promise.resolve(window.__agProjectCall('getStudioPrefs', {}, 4000))
      .then((res) => {
        if (disposed || !res || !res.ok || !res.prefs) return;
        const remote = sanitizeLocal(res.prefs);
        if (remote.updatedAt > state.updatedAt) {
          state = remote;
          writeLocalCache(state);
          applyDomEffects(state);
          pushSidecarPrefs(state);
          notify('daemon-hydrate');
        } else if (state.updatedAt > remote.updatedAt) {
          sendSaveRpc({ replace: true, prefs: state, updatedAt: state.updatedAt });
        }
      })
      .catch(() => {});
  }
  if (typeof window === 'object' && window) {
    hydrateTimer = setTimeout(() => {
      hydrateTimer = 0;
      hydrateFromDaemon();
    }, 350);
  }

  /* ---- Anti-Claude Base Bridge ---- */

  function getBaseState() {
    const bridge = typeof window === 'object' ? window.__agClaudeUxBridge : null;
    if (bridge && typeof bridge.getState === 'function') {
      try {
        const res = bridge.getState();
        if (res && res.modules) return res;
      } catch {}
    }
    const modules = Object.assign({}, BASE_MODULE_DEFAULTS);
    try {
      const cfg = cfgMods && typeof cfgMods === 'object' ? cfgMods : {};
      for (const k of Object.keys(modules)) {
        if (k in cfg) modules[k] = Boolean(cfg[k]);
      }
      const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(MODS_STORAGE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const k of Object.keys(modules)) {
          if (typeof parsed?.[k] === 'boolean') modules[k] = parsed[k];
        }
      }
    } catch {}
    const scaleAttr = typeof document === 'object' ? document.documentElement?.getAttribute?.('data-ag-cjk-scale') : '';
    return {
      modules,
      cjkFontScale: scaleAttr === '94.5' || scaleAttr === '95' || scaleAttr === '100' ? scaleAttr : '95',
    };
  }

  function setBaseModule(modKey, nextBool) {
    const val = Boolean(nextBool);
    const bridge = typeof window === 'object' ? window.__agClaudeUxBridge : null;
    if (bridge && typeof bridge.setModule === 'function') {
      try {
        bridge.setModule(modKey, val);
        notify('base-module');
        return true;
      } catch {}
    }
    try {
      if (typeof localStorage === 'object' && localStorage) {
        const raw = localStorage.getItem(MODS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        parsed[modKey] = val;
        parsed._ts = Date.now();
        localStorage.setItem(MODS_STORAGE_KEY, JSON.stringify(parsed));
      }
      if (typeof window.__agProjectCall === 'function') {
        window.__agProjectCall('saveUiPrefs', { updatedAt: Date.now(), modules: { [modKey]: val } }, 4000).catch(() => {});
      }
    } catch {}
    notify('base-module');
    return true;
  }

  function setCjkScale(rawScale) {
    const bridge = typeof window === 'object' ? window.__agClaudeUxBridge : null;
    if (bridge && typeof bridge.setCjkScale === 'function') {
      try {
        bridge.setCjkScale(rawScale);
        notify('cjk-scale');
        return true;
      } catch {}
    }
    return false;
  }

  /* ---- Host Native React PrefStore Bridge ---- */

  function isPrefStore(cand) {
    if (!cand || typeof cand.getState !== 'function') return false;
    try {
      const st = cand.getState();
      return Boolean(st && typeof st.getPrefValue === 'function' && typeof st.setPrefValue === 'function');
    } catch {
      return false;
    }
  }

  function discoverHostPrefStore() {
    if (typeof window === 'object' && window?.__ag_test_pref_store && isPrefStore(window.__ag_test_pref_store)) {
      cachedHostPrefStore = window.__ag_test_pref_store;
      return cachedHostPrefStore;
    }
    if (isPrefStore(cachedHostPrefStore)) return cachedHostPrefStore;
    const root =
      (typeof document === 'object' &&
        (document.getElementById('root') || (document.body && document.body.firstElementChild))) ||
      null;
    if (!root) return null;
    const fk = Object.keys(root).find((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
    const start = fk ? root[fk] : null;
    if (!start) return null;
    const queue = [start];
    const seen = new Set();
    let steps = 0;
    while (queue.length && steps < 700) {
      const f = queue.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      steps++;
      const mp = f.memoizedProps;
      if (mp && isPrefStore(mp.value)) {
        cachedHostPrefStore = mp.value;
        return mp.value;
      }
      for (let dep = f.dependencies && f.dependencies.firstContext; dep; dep = dep.next) {
        if (isPrefStore(dep.memoizedValue)) {
          cachedHostPrefStore = dep.memoizedValue;
          return dep.memoizedValue;
        }
      }
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    return null;
  }

  function getHostPref(key) {
    const store = discoverHostPrefStore();
    if (!store) return undefined;
    try {
      return store.getState().getPrefValue(key);
    } catch {
      return undefined;
    }
  }

  async function setHostPref(key, value) {
    const store = discoverHostPrefStore();
    if (!store) return false;
    try {
      await store.getState().setPrefValue(key, value);
      notify('host-pref');
      return true;
    } catch {
      return false;
    }
  }

  function getStepStreamMode() {
    const base = getBaseState();
    const hostVerbose = getHostPref('verboseConversationSteps');
    return hostVerbose === true || base?.modules?.claudeUxStepUnfold === true ? 'expanded' : 'compact';
  }

  async function setStepStreamMode(mode) {
    const expanded = mode === 'expanded';
    await setHostPref('verboseConversationSteps', expanded);
    setBaseModule('claudeUxStepUnfold', expanded);
    notify('step-stream');
    return true;
  }

  /* ---- Dynamic Account Model Catalog Discovery + Cache ---- */

  function getModelCatalog() {
    const tierRe = /^(.*?)\s*\((off|low|medium|high|extra|xhigh|max|minimal)(?:\s+thinking)?\)$/i;
    const isOrchestratorOpt = (opt) =>
      /^(gemini-pro-coordinator|gemini-pro-orchestrator(?:-.+)?)$/.test(opt?.modelId || '');
    const execSuffixRe = /-(off|minimal|low|medium|high|xhigh|extra|max)$/i;
    const TIER_RANK = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, extra: 6, max: 7 };

    const sortGroupItemsAsc = (items) => {
      if (!Array.isArray(items) || items.length <= 1) return Array.isArray(items) ? items : [];
      return items
        .map((item, idx) => {
          const t = typeof item?.tier === 'string' ? item.tier.toLowerCase() : '';
          const rank = t && Object.prototype.hasOwnProperty.call(TIER_RANK, t) ? TIER_RANK[t] : 99;
          return { item, idx, rank };
        })
        .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
        .map((x) => x.item);
    };

    const sortOptionsByFamilyAndTierDesc = (list) => {
      if (!Array.isArray(list) || list.length <= 1) return Array.isArray(list) ? list : [];
      const famOrder = new Map();
      const annotated = list.map((item, idx) => {
        const m = tierRe.exec(String(item?.label || ''));
        const famName = (m ? m[1] : String(item?.label || '')).trim().toLowerCase();
        const tierKey = m ? m[2].toLowerCase() : '';
        const rank = tierKey && Object.prototype.hasOwnProperty.call(TIER_RANK, tierKey) ? TIER_RANK[tierKey] : -1;
        if (!famOrder.has(famName)) famOrder.set(famName, famOrder.size);
        return { item, idx, famIdx: famOrder.get(famName), rank };
      });
      annotated.sort((a, b) => a.famIdx - b.famIdx || b.rank - a.rank || a.idx - b.idx);
      return annotated.map((x) => x.item);
    };

    const triggers =
      typeof document === 'object' ? document.querySelectorAll('button[data-testid="model-selector-trigger"]') : [];
    let selector = null;
    for (const trig of triggers) {
      const fk = Object.keys(trig).find((k) => k.startsWith('__reactFiber$'));
      for (let node = fk ? trig[fk] : null; node; node = node.return) {
        const p = node.memoizedProps;
        const cand = p?.value && typeof p.value === 'object' ? p.value : p;
        if (cand && typeof cand.setSelectedModel === 'function' && Array.isArray(cand.modelOptions)) {
          selector = cand;
          break;
        }
      }
      if (selector) break;
    }

    if (!selector) {
      try {
        const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(MODEL_CATALOG_CACHE_KEY) : null;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.families)) {
            return {
              families: parsed.families.map((grp) => ({
                ...grp,
                items: sortGroupItemsAsc(grp?.items),
              })),
              planners: sortOptionsByFamilyAndTierDesc(parsed.planners),
              executors: sortOptionsByFamilyAndTierDesc(parsed.executors),
              orchestratorDefaultPlanner: parsed.orchestratorDefaultPlanner || null,
            };
          }
        }
      } catch {}
      return { families: [], planners: [], executors: [], orchestratorDefaultPlanner: null };
    }

    const usable = (selector.modelOptions || []).filter(
      (o) => o && !o.disabled && !o.isDisabled && o.isAvailable !== false && !o.isHidden && typeof o.label === 'string' && o.label.trim()
    );

    const famMap = new Map();
    for (const opt of usable) {
      if (isOrchestratorOpt(opt)) continue;
      const m = tierRe.exec(opt.label);
      const famName = m ? m[1].trim() : opt.label.trim();
      const tier = m ? m[2].toLowerCase() : null;
      let grp = famMap.get(famName);
      if (!grp) {
        grp = { name: famName, displayName: famName, items: [], isMultiTier: false, tagTitle: opt.tagTitle || '' };
        famMap.set(famName, grp);
      }
      grp.items.push({ label: opt.label, tier, value: opt.value, modelId: opt.modelId || '' });
    }
    const families = [];
    for (const grp of famMap.values()) {
      const tieredCount = grp.items.filter((i) => Boolean(i.tier)).length;
      grp.isMultiTier = tieredCount >= 2;
      if (grp.isMultiTier) grp.items = sortGroupItemsAsc(grp.items);
      grp.displayName = grp.isMultiTier ? grp.name : grp.items[0].label;
      families.push(grp);
    }

    const planners = sortOptionsByFamilyAndTierDesc(
      (selector.orchestratorPlanners || [])
        .filter((o) => o && !o.disabled && !o.isDisabled && o.isAvailable !== false && !o.isHidden)
        .map((o) => ({ label: o.label, modelId: o.modelId || '', value: o.value }))
    );

    const execBaseIds = window.__agClaudeUxBridge?.getExecutorBaseIds?.() || null;
    const execSet = Array.isArray(execBaseIds) && execBaseIds.length > 0 ? new Set(execBaseIds) : null;
    const executors = sortOptionsByFamilyAndTierDesc(
      usable
        .filter((o) => {
          if (isOrchestratorOpt(o) || o.isCustom) return false;
          if (execSet && o.modelId) {
            return execSet.has(o.modelId.replace(execSuffixRe, ''));
          }
          return /\b(?:flash|sonnet|hydrogen|mini|haiku|oss)\b/i.test(`${o.label} ${o.modelId || ''}`);
        })
        .map((o) => ({ label: o.label, modelId: o.modelId || '', value: o.value }))
    );

    const catalog = {
      families,
      planners,
      executors,
      orchestratorDefaultPlanner: selector.orchestratorDefaultPlanner
        ? { label: selector.orchestratorDefaultPlanner.label, value: selector.orchestratorDefaultPlanner.value }
        : null,
    };
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.setItem(MODEL_CATALOG_CACHE_KEY, JSON.stringify(catalog));
      }
    } catch {}
    return catalog;
  }

  /* ---- Export / Import Full Config ---- */

  function exportConfig() {
    const base = getBaseState();
    const exportedBaseMods = {};
    for (const k of Object.keys(BASE_MODULE_DEFAULTS)) {
      if (k in (base.modules || {})) exportedBaseMods[k] = Boolean(base.modules[k]);
    }
    const orch = getHostPref('orchestratorModel');
    const exec = getHostPref('orchestratorExecutorModel');
    const verb = getHostPref('verboseConversationSteps');
    const hostPrefs = {};
    if (typeof orch === 'number') hostPrefs.orchestratorModel = orch;
    if (typeof exec === 'number') hostPrefs.orchestratorExecutorModel = exec;
    if (typeof verb === 'boolean') hostPrefs.verboseConversationSteps = verb;

    return {
      schema: 'agy-studio-config-v1',
      exportedAt: new Date().toISOString(),
      studioPrefs: cloneJson(state),
      baseModules: exportedBaseMods,
      cjkFontScale: base.cjkFontScale || '95',
      hostPrefs,
    };
  }

  async function importConfig(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'invalid_json' };
    }
    const incomingStudio =
      raw.studioPrefs && typeof raw.studioPrefs === 'object'
        ? raw.studioPrefs
        : typeof raw.showEffortBar === 'boolean' || typeof raw.hideThinkingProse === 'boolean'
          ? raw
          : null;
    if (!incomingStudio) return { ok: false, error: 'missing_studio_prefs' };

    replaceAll(incomingStudio, { reason: 'import' });

    if (raw.baseModules && typeof raw.baseModules === 'object') {
      for (const k of Object.keys(BASE_MODULE_DEFAULTS)) {
        if (typeof raw.baseModules[k] === 'boolean') {
          setBaseModule(k, raw.baseModules[k]);
        }
      }
    }
    if (typeof raw.cjkFontScale === 'string') {
      setCjkScale(raw.cjkFontScale);
    }
    if (raw.hostPrefs && typeof raw.hostPrefs === 'object') {
      if (typeof raw.hostPrefs.orchestratorModel === 'number' && Number.isFinite(raw.hostPrefs.orchestratorModel)) {
        await setHostPref('orchestratorModel', raw.hostPrefs.orchestratorModel);
      }
      if (
        typeof raw.hostPrefs.orchestratorExecutorModel === 'number' &&
        Number.isFinite(raw.hostPrefs.orchestratorExecutorModel)
      ) {
        await setHostPref('orchestratorExecutorModel', raw.hostPrefs.orchestratorExecutorModel);
      }
      if (typeof raw.hostPrefs.verboseConversationSteps === 'boolean') {
        await setHostPref('verboseConversationSteps', raw.hostPrefs.verboseConversationSteps);
      }
    }
    notify('import');
    return { ok: true };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = 0;
    }
    if (hydrateTimer) {
      clearTimeout(hydrateTimer);
      hydrateTimer = 0;
    }
    if (toastListenersBound && typeof window === 'object' && window?.removeEventListener) {
      window.removeEventListener(EFFORT_EVENT, onSidecarEffortEvent);
      toastListenersBound = false;
    }
    listeners.clear();
    if (typeof window === 'object' && window && window.__agyStudioPrefs === api) {
      window.__agyStudioPrefs = null;
    }
  }

  const api = {
    get,
    patch,
    replaceAll,
    reset,
    resetAll,
    subscribe,
    getBaseState,
    setBaseModule,
    setCjkScale,
    discoverHostPrefStore,
    getHostPref,
    setHostPref,
    getStepStreamMode,
    setStepStreamMode,
    getModelCatalog,
    exportConfig,
    importConfig,
    hydrateFromDaemon,
    sanitizeLocal,
    dispose,
    DEFAULTS,
  };

  if (typeof window === 'object' && window) {
    window.__agyStudioPrefs = api;
  }

  return api;
}
