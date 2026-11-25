/**
 * Shared Antigravity Redux/Fiber Model Catalog, PrefStore & Orchestrator Role discovery.
 * Used by Projects Detail / Scheduled Tasks modal and the Settings FX Orchestrator bridge.
 * (Legacy standalone #ag-claude-model-popover UI has been retired cleanly.)
 */
export function createModelApi(rt) {
  const { L, later, state, hooks } = rt;

  const EFFORT_LABEL_RE = /^(.*?)\s*\((Low|Medium|High|XHigh|Extra|Max)\)\s*$/i;
  const EFFORT_NORM = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', extra: 'XHigh', max: 'Max' };
  const EFFORT_DISPLAY = { XHigh: 'Extra' };
  const EFFORT_RANK = { Low: 0, Medium: 1, High: 2, XHigh: 3, Max: 4 };

  let cachedPrefStore = null;
  let prefStoreUnsub = null;
  let cachedExecutorRoleBaseIds = null;
  let executorRolesFetchInFlight = false;
  let executorRolesLastTryTs = 0;

  function displayEffortLabel(effort) {
    return (effort && EFFORT_DISPLAY[effort]) || effort;
  }

  function isOrchestratorModelOpt(opt) {
    if (!opt) return false;
    const id = typeof opt.modelId === 'string' ? opt.modelId : '';
    if (
      id === 'gemini-pro-coordinator' ||
      id === 'gemini-pro-orchestrator' ||
      id.startsWith('gemini-pro-orchestrator-')
    ) {
      return true;
    }
    return /orchestrator|编排器/i.test(String(opt.label || ''));
  }

  function parseModelLabelEffort(rawLabel) {
    const normalizedLabel = String(rawLabel || '')
      .replace(/编排器\s*\(([^)]+)\)/g, 'Orchestrator ($1)')
      .replace(/\s*\(Extra High\)\s*$/i, ' (XHigh)');
    const m = normalizedLabel.match(EFFORT_LABEL_RE);
    const baseName = m ? m[1].trim() : normalizedLabel.trim();
    const effort = m ? EFFORT_NORM[m[2].toLowerCase()] || m[2] : null;
    return { baseName, effort };
  }

  function modelCoreRank(name) {
    if (/carbon/i.test(name)) return 0;
    if (/neon/i.test(name)) return 1;
    if (/argon/i.test(name)) return 2;
    if (/hydrogen/i.test(name)) return 3;
    if (/flash/i.test(name)) return 4;
    return 10;
  }

  function sortFamilyVariants(variants) {
    return variants.sort((a, b) => {
      const ra = a.effort && EFFORT_RANK[a.effort] !== undefined ? EFFORT_RANK[a.effort] : 99;
      const rb = b.effort && EFFORT_RANK[b.effort] !== undefined ? EFFORT_RANK[b.effort] : 99;
      return ra - rb;
    });
  }

  function pickVariantForFamily(fam, desiredEffort) {
    if (!fam || !Array.isArray(fam.variants) || !fam.variants.length) return null;
    if (desiredEffort) {
      const exact = fam.variants.find((v) => v.effort === desiredEffort);
      if (exact) return exact;
      if (desiredEffort === 'XHigh' || desiredEffort === 'Max') {
        const high = fam.variants.find((v) => v.effort === 'High');
        if (high) return high;
      }
    }
    if (/\bneon\b/i.test(String(fam.baseName || fam.title || fam.name || fam.base || fam.variants[0]?.opt?.label || ''))) {
      const high = fam.variants.find((v) => v.effort === 'High');
      if (high) return high;
    }
    const med = fam.variants.find((v) => v.effort === 'Medium');
    return med || fam.variants[0];
  }

  function matchPlannerFromTriggerText(rawText, planners) {
    let txt = String(rawText || '').trim().replace(/\s+/g, ' ');
    if (!txt) return null;
    txt = txt
      .replace(/^Select model,\s*current:\s*/i, '')
      .replace(/\s*·\s*[^·]*$/, '')
      .trim();
    if (!/^(?:Orchestrator|编排器)\s+/i.test(txt)) return null;
    txt = txt.replace(/^(?:Orchestrator|编排器)\s+/i, '').trim();
    const m = txt.match(/^(.*?)\s+(Low|Medium|High|Extra High|XHigh|Extra|Max)$/i);
    const wantedBase = (m ? m[1] : txt).trim().toLowerCase();
    const rawEff = m ? m[2].toLowerCase() : '';
    const wantedEff = rawEff ? (rawEff === 'extra high' ? 'XHigh' : EFFORT_NORM[rawEff] || m[2]) : null;
    if (!wantedBase) return null;
    let baseMatch = null;
    for (const p of planners) {
      const parsed = parseModelLabelEffort(p.label);
      if (parsed.baseName.toLowerCase() !== wantedBase) continue;
      if (wantedEff && parsed.effort === wantedEff) return p;
      if (!baseMatch) baseMatch = p;
    }
    return baseMatch;
  }

  function resolveActiveOrchestratorPlanner(api, planners) {
    if (!Array.isArray(planners) || !planners.length) return null;
    const pickVal = api && api.orchestratorPick ? api.orchestratorPick.model : undefined;
    if (pickVal && pickVal !== 0) {
      const byPick = planners.find((p) => p.value === pickVal);
      if (byPick) return byPick;
    }
    const nativeBtn = document.querySelector('button[data-testid="model-selector-trigger"]');
    if (nativeBtn) {
      const candidates = [nativeBtn.getAttribute('aria-label'), nativeBtn.textContent];
      for (const raw of candidates) {
        const matched = matchPlannerFromTriggerText(raw, planners);
        if (matched) return matched;
      }
    }
    const defPlanner = api && api.orchestratorDefaultPlanner;
    if (defPlanner) {
      const byDef =
        planners.find(
          (p) =>
            (defPlanner.value !== undefined && p.value === defPlanner.value) ||
            (defPlanner.modelId && p.modelId === defPlanner.modelId) ||
            (defPlanner.label && p.label === defPlanner.label)
        ) || null;
      if (byDef) return byDef;
    }
    return planners[0];
  }

  function buildReduxModelSelectorApi() {
    try {
      const resolver = hooks.resolveProjectsStoreAndBindings;
      const { store } = typeof resolver === 'function' ? resolver() : { store: null };
      if (!store || typeof store.getState !== 'function') return null;
      const st = store.getState();
      const rawCfgs =
        (st && st.userStatus && st.userStatus.cascadeModelConfigData && st.userStatus.cascadeModelConfigData.clientModelConfigs) || [];
      if (!Array.isArray(rawCfgs) || rawCfgs.length === 0) return null;
      const modelOptions = [];
      for (const c of rawCfgs) {
        if (!c || !c.label) continue;
        const val = c.modelOrAlias && c.modelOrAlias.choice ? c.modelOrAlias.choice.value : c.value;
        modelOptions.push({
          label: c.label,
          value: val,
          modelId: c.modelId || '',
          disabled: Boolean(c.disabled),
        });
      }
      if (!modelOptions.length) return null;
      const rawCustom =
        st && st.customModels && Array.isArray(st.customModels.models)
          ? st.customModels.models
          : Array.isArray(st && st.customModels)
            ? st.customModels
            : [];
      const customModels = rawCustom
        .filter((c) => c && c.label)
        .map((c) => ({
          label: c.label,
          value: c.value,
          modelId: c.modelId || '',
          customLabel: c.label,
          disabled: Boolean(c.disabled),
        }));
      const def = (st && st.modelSelection && st.modelSelection.default) || null;
      const defVal = def && def.model;
      const selectedModel =
        (def && def.customLabel ? customModels.find((m) => m.value === defVal && m.label === def.customLabel) : null) ||
        modelOptions.find((m) => m.value === defVal) ||
        customModels.find((m) => m.value === defVal) ||
        modelOptions.find((m) => !m.disabled) ||
        modelOptions[0];
      const orchMap = (st && st.modelSelection && st.modelSelection.orchestratorByConversation) || {};
      const draftOrchModel = orchMap[''] !== undefined ? orchMap[''] : 0;
      return {
        isReduxFallback: true,
        modelOptions,
        customModels,
        selectedModel,
        open: false,
        setIsOpen: () => {},
        orchestratorPick: {
          model: draftOrchModel,
          select: (modelVal) => {
            if (modelVal === undefined || typeof store.dispatch !== 'function') return;
            store.dispatch({
              type: 'modelSelection/orchestratorModelPicked',
              payload: { model: modelVal },
            });
          },
        },
        setSelectedModel: (opt) => {
          if (!opt || opt.value === undefined || typeof store.dispatch !== 'function') return;
          store.dispatch({
            type: 'modelSelection/modelPicked',
            payload: {
              model: opt.value,
              ...(opt.customLabel ? { customLabel: opt.customLabel } : {}),
            },
          });
        },
      };
    } catch {
      return null;
    }
  }

  function discoverModelSelectorApi(btnEl) {
    const isProjectTrigger = Boolean(btnEl && btnEl.hasAttribute && btnEl.hasAttribute('data-ag-pd-model-trigger'));
    const nativeBtn = document.querySelector('button[data-testid="model-selector-trigger"]');
    const isValidApi = (obj) =>
      Boolean(obj && typeof obj === 'object' && typeof obj.setSelectedModel === 'function' && Array.isArray(obj.modelOptions) && obj.modelOptions.length > 0);
    const readNativeApi = (btn) => {
      if (!btn) return null;
      const fk = Object.keys(btn).find((k) => k.startsWith('__reactFiber$'));
      let f = fk ? btn[fk] : null;
      let fallback = null;
      for (let i = 0; i < 28 && f; i++, f = f.return) {
        const p = f.memoizedProps;
        if (!p) continue;
        if (isValidApi(p.value)) return p.value;
        if (!fallback && isValidApi(p)) fallback = p;
      }
      return fallback;
    };

    if (isProjectTrigger) {
      const reduxApi = buildReduxModelSelectorApi();
      const nativeApi = readNativeApi(nativeBtn);
      if (reduxApi) {
        if (nativeApi) {
          const reduxPick = reduxApi.orchestratorPick;
          const nativePick = nativeApi.orchestratorPick;
          const mergedPick =
            (reduxPick && typeof reduxPick.select === 'function') || (nativePick && typeof nativePick.select === 'function')
              ? {
                  model: (reduxPick && reduxPick.model) || (nativePick && nativePick.model) || 0,
                  select: (val) => {
                    try {
                      if (reduxPick && typeof reduxPick.select === 'function') reduxPick.select(val);
                    } catch {}
                    try {
                      if (nativePick && typeof nativePick.select === 'function') nativePick.select(val);
                    } catch {}
                  },
                }
              : undefined;
          return {
            ...reduxApi,
            orchestratorPlanners: nativeApi.orchestratorPlanners,
            orchestratorPlannerIndex: nativeApi.orchestratorPlannerIndex,
            orchestratorDefaultPlanner: nativeApi.orchestratorDefaultPlanner,
            ...(mergedPick ? { orchestratorPick: mergedPick } : {}),
            setSelectedModel: (opt) => {
              reduxApi.setSelectedModel(opt);
              const match = nativeApi.modelOptions.find(
                (o) => o && ((opt.value !== undefined && o.value === opt.value) || o.label === opt.label)
              );
              try {
                nativeApi.setSelectedModel(match || opt);
              } catch {}
            },
          };
        }
        return reduxApi;
      }
      if (nativeApi) return nativeApi;
      return null;
    }

    if (btnEl && btnEl.matches && btnEl.matches('button[data-testid="model-selector-trigger"]')) {
      const ownApi = readNativeApi(btnEl);
      if (ownApi) return ownApi;
      return buildReduxModelSelectorApi();
    }
    const candidates = [];
    if (btnEl) candidates.push(btnEl);
    if (nativeBtn && !candidates.includes(nativeBtn)) candidates.push(nativeBtn);
    for (const btn of candidates) {
      const api = readNativeApi(btn);
      if (api) return api;
    }
    return buildReduxModelSelectorApi();
  }

  function buildModelCatalog(api) {
    const rawOpts = (api.modelOptions || []).filter((o) => o && !o.disabled && o.label);
    const customOpts = Array.isArray(api.customModels)
      ? api.customModels.filter((o) => o && !o.disabled && o.label)
      : [];
    const allOpts = rawOpts.concat(customOpts);

    const rawOrchOpts = rawOpts.filter(isOrchestratorModelOpt);
    const canonicalOrchOpt =
      (api.selectedModel && !api.selectedModel.disabled && isOrchestratorModelOpt(api.selectedModel) ? api.selectedModel : null) ||
      rawOrchOpts[0] ||
      (api.modelOptions || []).find(isOrchestratorModelOpt) ||
      null;
    const orchPlanners = Array.isArray(api.orchestratorPlanners)
      ? api.orchestratorPlanners.filter((o) => o && !o.disabled && o.label)
      : [];
    const hasDynamicOrch = Boolean(
      orchPlanners.length > 0 &&
      canonicalOrchOpt &&
      api.orchestratorPick &&
      typeof api.orchestratorPick.select === 'function'
    );

    const familyMap = new Map();
    for (const opt of allOpts) {
      if (hasDynamicOrch && isOrchestratorModelOpt(opt)) continue;
      const parsed = parseModelLabelEffort(opt.label);
      const baseName = parsed.baseName;
      const effort = parsed.effort;
      let fam = familyMap.get(baseName);
      if (!fam) {
        fam = { baseName, variants: [] };
        familyMap.set(baseName, fam);
      }
      fam.variants.push({ effort, opt });
    }

    for (const fam of familyMap.values()) {
      sortFamilyVariants(fam.variants);
    }

    const orchFamilies = [];
    if (hasDynamicOrch) {
      const orchFamilyMap = new Map();
      for (const p of orchPlanners) {
        const parsed = parseModelLabelEffort(p.label);
        const famName = `Orchestrator · ${parsed.baseName}`;
        let fam = orchFamilyMap.get(famName);
        if (!fam) {
          fam = { baseName: famName, isOrchestratorFamily: true, variants: [] };
          orchFamilyMap.set(famName, fam);
        }
        fam.variants.push({ effort: parsed.effort, opt: canonicalOrchOpt, plannerOpt: p });
      }
      for (const fam of orchFamilyMap.values()) {
        sortFamilyVariants(fam.variants);
        orchFamilies.push(fam);
      }
    }

    const families = Array.from(familyMap.values());
    const isOrch = (f) => Boolean(f && (f.isOrchestratorFamily || /orchestrator/i.test(f.baseName)));
    const isCoreGemini = (f) => /^gemini\b/i.test(f.baseName) && !isOrch(f);

    let primaryFamilies = families
      .filter(isCoreGemini)
      .sort((a, b) => modelCoreRank(a.baseName) - modelCoreRank(b.baseName))
      .slice(0, 5);
    if (!primaryFamilies.length) {
      primaryFamilies = families.filter((f) => !isOrch(f)).slice(0, 5);
    }

    const primarySet = new Set(primaryFamilies);
    const nonPrimaryEntries = families
      .filter((f) => !primarySet.has(f))
      .map((f) => ({
        group: isOrch(f) ? 'orch' : 'other',
        fam: f,
      }));
    const orchEntries = hasDynamicOrch ? orchFamilies.map((f) => ({ group: 'orch', fam: f })) : [];
    const moreFamilies = orchEntries
      .concat(nonPrimaryEntries)
      .sort((a, b) => (a.group === b.group ? 0 : a.group === 'orch' ? -1 : 1));

    const sel = api.selectedModel || null;
    let activeFamily = null;
    let activeVariant = null;

    if (sel) {
      if (hasDynamicOrch && isOrchestratorModelOpt(sel)) {
        const activePlanner = resolveActiveOrchestratorPlanner(api, orchPlanners);
        if (activePlanner) {
          for (const fam of orchFamilies) {
            for (const v of fam.variants) {
              const p = v.plannerOpt;
              if (
                p &&
                ((activePlanner.value !== undefined && p.value === activePlanner.value) ||
                  (activePlanner.modelId && p.modelId === activePlanner.modelId) ||
                  p.label === activePlanner.label)
              ) {
                activeFamily = fam;
                activeVariant = v;
                break;
              }
            }
            if (activeFamily) break;
          }
        }
      }
      if (!activeFamily) {
        for (const fam of families) {
          for (const v of fam.variants) {
            if (
              (sel.value !== undefined && v.opt.value === sel.value) ||
              (sel.modelId && v.opt.modelId === sel.modelId) ||
              v.opt.label === sel.label
            ) {
              activeFamily = fam;
              activeVariant = v;
              break;
            }
          }
          if (activeFamily) break;
        }
      }
    }

    if (!activeFamily && primaryFamilies.length > 0) {
      activeFamily = primaryFamilies[0];
      activeVariant = activeFamily.variants[0] || null;
    }

    return {
      primaryFamilies,
      moreFamilies,
      activeFamily,
      activeVariant,
    };
  }

  function formatProjectComposerModelParts(api) {
    const resolvedApi = api || buildReduxModelSelectorApi() || discoverModelSelectorApi();
    if (resolvedApi) {
      const cat = buildModelCatalog(resolvedApi);
      if (cat.activeFamily) {
        const name = cat.activeFamily.baseName;
        const eff = cat.activeVariant && cat.activeVariant.effort ? displayEffortLabel(cat.activeVariant.effort) : '';
        return { name, effort: eff };
      }
    }
    const nativeBtn = document.querySelector('button[data-testid="model-selector-trigger"]');
    const raw = nativeBtn ? (nativeBtn.textContent || '').trim().replace(/\s+/g, ' ') : '';
    if (!raw) return { name: L('默认模型', 'Default model'), effort: '' };
    const m = raw.match(/^(.*?)\s+(Low|Medium|High|Extra High|XHigh|Extra|Minimal)$/i);
    if (m) return { name: m[1].trim(), effort: displayEffortLabel(EFFORT_NORM[m[2].toLowerCase()] || m[2]) };
    return { name: raw, effort: '' };
  }

  function syncProjectDetailModelTrigger() {
    const pdBtn = document.getElementById('ag-pd-model-btn');
    if (!pdBtn) return;
    const api = discoverModelSelectorApi(pdBtn);
    const parts = formatProjectComposerModelParts(api);
    const nameEl = pdBtn.querySelector('.ag-pd-model-name');
    const effEl = pdBtn.querySelector('.ag-pd-model-effort');
    if (nameEl) nameEl.textContent = parts.name;
    if (effEl) {
      effEl.textContent = parts.effort;
      effEl.style.display = parts.effort ? '' : 'none';
    }
  }

  function applyModelSelectionOption(api, targetOpt, orchestratorPlannerOpt) {
    if (!targetOpt) return;
    const isReduxFallback = Boolean(!api || api.isReduxFallback);
    const resolveStore = hooks.resolveProjectsStoreAndBindings;
    if (orchestratorPlannerOpt && orchestratorPlannerOpt.value !== undefined) {
      let calledNativeOrch = false;
      if (api && api.orchestratorPick && typeof api.orchestratorPick.select === 'function') {
        try {
          api.orchestratorPick.select(orchestratorPlannerOpt.value);
          calledNativeOrch = true;
        } catch {}
      }
      if (!calledNativeOrch || isReduxFallback) {
        try {
          const { store } = typeof resolveStore === 'function' ? resolveStore() : { store: null };
          if (store && typeof store.dispatch === 'function') {
            store.dispatch({
              type: 'modelSelection/orchestratorModelPicked',
              payload: { model: orchestratorPlannerOpt.value },
            });
          }
        } catch {}
      }
    }
    let calledNativeSelect = false;
    if (api && typeof api.setSelectedModel === 'function') {
      try {
        api.setSelectedModel(targetOpt);
        calledNativeSelect = true;
      } catch {}
    }
    if ((!calledNativeSelect || isReduxFallback) && targetOpt.value !== undefined) {
      try {
        const { store } = typeof resolveStore === 'function' ? resolveStore() : { store: null };
        if (store && typeof store.dispatch === 'function') {
          store.dispatch({
            type: 'modelSelection/modelPicked',
            payload: {
              model: targetOpt.value,
              ...(targetOpt.customLabel ? { customLabel: targetOpt.customLabel } : {}),
            },
          });
        }
      } catch {}
    }
    later(() => {
      syncProjectDetailModelTrigger();
    }, 30);
  }

  function bindPrefStoreSubscription(ps) {
    if (prefStoreUnsub) {
      try {
        prefStoreUnsub();
      } catch {}
      prefStoreUnsub = null;
    }
    if (ps && typeof ps.onDidChange === 'function') {
      try {
        const sub = ps.onDidChange(() => {});
        if (typeof sub === 'function') prefStoreUnsub = sub;
        else if (sub && typeof sub.dispose === 'function') prefStoreUnsub = () => sub.dispose();
      } catch {}
    }
  }

  function discoverPrefStore() {
    if (
      typeof window === 'object' &&
      window &&
      window.__ag_test_pref_store &&
      typeof window.__ag_test_pref_store.getState === 'function'
    ) {
      if (cachedPrefStore !== window.__ag_test_pref_store) {
        cachedPrefStore = window.__ag_test_pref_store;
        bindPrefStoreSubscription(cachedPrefStore);
      }
      return cachedPrefStore;
    }
    if (cachedPrefStore && typeof cachedPrefStore.getState === 'function') {
      try {
        const st = cachedPrefStore.getState();
        if (st && typeof st.getPrefValue === 'function' && typeof st.setPrefValue === 'function') {
          return cachedPrefStore;
        }
      } catch {}
    }
    const root = document.getElementById('root') || (document.body && document.body.firstElementChild);
    if (!root) return null;
    const fk = Object.keys(root).find((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
    const start = fk ? root[fk] : null;
    if (!start) return null;
    const queue = [start];
    const seen = new Set();
    let steps = 0;
    const isPrefStore = (cand) => {
      if (!cand || typeof cand.getState !== 'function') return false;
      try {
        const st = cand.getState();
        return Boolean(st && typeof st.getPrefValue === 'function' && typeof st.setPrefValue === 'function');
      } catch {
        return false;
      }
    };
    while (queue.length && steps < 600) {
      const f = queue.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      steps++;
      const mp = f.memoizedProps;
      if (mp && isPrefStore(mp.value)) {
        cachedPrefStore = mp.value;
        bindPrefStoreSubscription(mp.value);
        return mp.value;
      }
      for (let dep = f.dependencies && f.dependencies.firstContext; dep; dep = dep.next) {
        if (isPrefStore(dep.memoizedValue)) {
          cachedPrefStore = dep.memoizedValue;
          bindPrefStoreSubscription(dep.memoizedValue);
          return dep.memoizedValue;
        }
      }
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    return null;
  }

  function extractLsClientCandidate(cand) {
    if (!cand || typeof cand !== 'object') return null;
    if (typeof cand.getMendelFlags === 'function') return cand;
    if (cand.lsClient && typeof cand.lsClient.getMendelFlags === 'function') return cand.lsClient;
    if (cand.client && typeof cand.client.getMendelFlags === 'function') return cand.client;
    return null;
  }

  function ensureOrchestratorRolesLoaded() {
    if (typeof window === 'object' && window && Array.isArray(window.__ag_test_executor_roles)) {
      cachedExecutorRoleBaseIds = window.__ag_test_executor_roles.filter((s) => typeof s === 'string');
      return;
    }
    if (Array.isArray(cachedExecutorRoleBaseIds)) return;
    const now = Date.now();
    if (executorRolesFetchInFlight || now - executorRolesLastTryTs < 3000) return;

    const root = document.getElementById('root') || (document.body && document.body.firstElementChild);
    const fk = root && Object.keys(root).find((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
    if (!fk) return;
    const queue = [root[fk]];
    const seen = new Set();
    let lsClient = null;
    while (queue.length && seen.size < 600 && !lsClient) {
      const f = queue.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      const mp = f.memoizedProps;
      lsClient = extractLsClientCandidate(mp) || extractLsClientCandidate(mp && mp.value);
      if (!lsClient) {
        for (let dep = f.dependencies && f.dependencies.firstContext; dep; dep = dep.next) {
          lsClient = extractLsClientCandidate(dep.memoizedValue);
          if (lsClient) break;
        }
      }
      if (!lsClient && f.memoizedState) {
        let s = f.memoizedState;
        for (let k = 0; k < 15 && s && !lsClient; k++, s = s.next) {
          lsClient = extractLsClientCandidate(s.memoizedState);
        }
      }
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    if (!lsClient) return;
    executorRolesLastTryTs = now;
    executorRolesFetchInFlight = true;
    try {
      Promise.resolve(lsClient.getMendelFlags({}))
        .then((resp) => {
          executorRolesFetchInFlight = false;
          if (state.disposed) return;
          const exps = (resp && resp.experimentConfig && resp.experimentConfig.experiments) || [];
          const hit = Array.isArray(exps) ? exps.find((x) => x && x.keyString === 'orchestrator-model-roles') : null;
          const rawStr = hit && hit.payload && hit.payload.value;
          if (typeof rawStr === 'string' && rawStr) {
            const parsed = JSON.parse(rawStr);
            if (parsed && Array.isArray(parsed.executors) && parsed.executors.every((s) => typeof s === 'string')) {
              cachedExecutorRoleBaseIds = parsed.executors.slice();
            }
          }
        })
        .catch(() => {
          executorRolesFetchInFlight = false;
        });
    } catch {
      executorRolesFetchInFlight = false;
    }
  }

  function getExecutorBaseIds() {
    ensureOrchestratorRolesLoaded();
    return Array.isArray(cachedExecutorRoleBaseIds) ? cachedExecutorRoleBaseIds.slice() : null;
  }

  function dispose() {
    if (prefStoreUnsub) {
      try {
        prefStoreUnsub();
      } catch {}
      prefStoreUnsub = null;
    }
    cachedPrefStore = null;
    cachedExecutorRoleBaseIds = null;
    executorRolesFetchInFlight = false;
    executorRolesLastTryTs = 0;
  }

  return {
    EFFORT_NORM,
    EFFORT_DISPLAY,
    EFFORT_RANK,
    displayEffortLabel,
    isOrchestratorModelOpt,
    parseModelLabelEffort,
    modelCoreRank,
    sortFamilyVariants,
    matchPlannerFromTriggerText,
    resolveActiveOrchestratorPlanner,
    buildReduxModelSelectorApi,
    discoverModelSelectorApi,
    buildModelCatalog,
    pickVariantForFamily,
    formatProjectComposerModelParts,
    syncProjectDetailModelTrigger,
    applyModelSelectionOption,
    discoverPrefStore,
    extractLsClientCandidate,
    ensureOrchestratorRolesLoaded,
    getExecutorBaseIds,
    dispose,
  };
}
