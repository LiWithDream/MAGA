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
  let cachedOrchestratorRoleBaseIds = null;
  let cachedNativeMeta = null;
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

  function matchModelBaseId(modelId, baseIds) {
    if (typeof modelId !== 'string' || !modelId || !Array.isArray(baseIds) || !baseIds.length) return false;
    const lower = modelId.toLowerCase();
    return baseIds.some((base) => {
      const b = String(base || '').trim().toLowerCase();
      return Boolean(b && (lower === b || lower.startsWith(`${b}-`)));
    });
  }

  function synthesizeReduxOrchestratorPlanners(modelOptions, orchOpts) {
    if (!Array.isArray(modelOptions) || !modelOptions.length) return [];
    if (!Array.isArray(orchOpts) || !orchOpts.length) return [];
    const usableNonOrch = modelOptions.filter((o) => o && !o.disabled && !isOrchestratorModelOpt(o));
    if (!usableNonOrch.length) return [];

    // 1. Prefer cached native planner list re-bound to fresh Redux option objects
    if (cachedNativeMeta && Array.isArray(cachedNativeMeta.orchestratorPlanners) && cachedNativeMeta.orchestratorPlanners.length) {
      const byVal = new Map();
      const byLabel = new Map();
      for (const o of usableNonOrch) {
        if (o.value !== undefined && !byVal.has(o.value)) byVal.set(o.value, o);
        if (o.label && !byLabel.has(o.label)) byLabel.set(o.label, o);
      }
      const rebound = [];
      const seen = new Set();
      for (const p of cachedNativeMeta.orchestratorPlanners) {
        if (!p) continue;
        const hit = (p.value !== undefined && byVal.get(p.value)) || (p.label && byLabel.get(p.label)) || null;
        if (hit && !seen.has(hit)) {
          seen.add(hit);
          rebound.push(hit);
        }
      }
      if (rebound.length) return rebound;
    }

    // 2. Exact match from Mendel orchestrator-model-roles.orchestrators
    ensureOrchestratorRolesLoaded();
    if (Array.isArray(cachedOrchestratorRoleBaseIds) && cachedOrchestratorRoleBaseIds.length) {
      const byMendel = usableNonOrch.filter((o) => matchModelBaseId(o.modelId, cachedOrchestratorRoleBaseIds));
      if (byMendel.length) return byMendel;
    }

    // 3. Cold-start deterministic fallback before async Mendel resolves:
    //    match family tokens advertised by Orchestrator (<Family>) entries + Claude Opus,
    //    while excluding known executors (Hydrogen / Flash / Sonnet / GPT-OSS / Mendel executors).
    const advertisedTokens = new Set();
    for (const o of orchOpts) {
      const m = String(o.label || '').match(/\(([^)]+)\)/);
      if (m && m[1]) advertisedTokens.add(m[1].trim().toLowerCase());
      const idMatch = String(o.modelId || '').match(/^gemini-pro-orchestrator-(.+)$/i);
      if (idMatch && idMatch[1]) advertisedTokens.add(idMatch[1].trim().toLowerCase());
    }
    const isLikelyExecutor = (o) =>
      matchModelBaseId(o.modelId, cachedExecutorRoleBaseIds) ||
      /\b(hydrogen|flash|sonnet|gpt-oss)\b/i.test(`${o.modelId || ''} ${o.label || ''}`);
    const inferred = usableNonOrch.filter((o) => {
      if (isLikelyExecutor(o)) return false;
      const hay = `${o.modelId || ''} ${o.label || ''}`.toLowerCase();
      if (/\bopus\b/.test(hay)) return true;
      for (const tok of advertisedTokens) {
        if (tok && hay.includes(tok)) return true;
      }
      return false;
    });
    return inferred.length ? inferred : usableNonOrch.filter((o) => !isLikelyExecutor(o));
  }

  function getReduxCascadeConfigData() {
    try {
      const resolver = hooks.resolveProjectsStoreAndBindings;
      const { store } = typeof resolver === 'function' ? resolver() : { store: null };
      if (!store || typeof store.getState !== 'function') return { store: null, st: null, cfgData: null };
      const st = store.getState();
      const cfgData = (st && st.userStatus && st.userStatus.cascadeModelConfigData) || null;
      return { store, st, cfgData };
    } catch {
      return { store: null, st: null, cfgData: null };
    }
  }

  function computeReduxOptionsSignature(cfgData) {
    if (!cfgData || typeof cfgData !== 'object') return '';
    const rawCfgs = Array.isArray(cfgData.clientModelConfigs) ? cfgData.clientModelConfigs : [];
    const labels = [];
    for (const c of rawCfgs) {
      if (c && c.label) labels.push(String(c.label));
    }
    const overrideVal = cfgData.defaultOverrideModelConfig?.modelOrAlias?.choice?.value;
    if (!labels.length && overrideVal === undefined) return '';
    return `${overrideVal === undefined ? '' : String(overrideVal)}|${labels.join('\x1f')}`;
  }

  function invalidateNativeMetaIfReduxChanged(cfgData, hasStore = true) {
    if (!hasStore) return '';
    const sig = computeReduxOptionsSignature(cfgData);
    if (cachedNativeMeta && cachedNativeMeta.reduxSig !== sig) {
      cachedNativeMeta = null;
    }
    return sig;
  }

  function buildReduxModelSelectorApi() {
    try {
      const { store, st, cfgData } = getReduxCascadeConfigData();
      if (!store) return null;
      invalidateNativeMetaIfReduxChanged(cfgData, true);
      const rawCfgs = (cfgData && cfgData.clientModelConfigs) || [];
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
          tagTitle: typeof c.tagTitle === 'string' ? c.tagTitle : '',
          tagDescription: typeof c.tagDescription === 'string' ? c.tagDescription : '',
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
      const hasDraftOrchPick = orchMap[''] !== undefined;
      const draftOrchModel = hasDraftOrchPick ? orchMap[''] : 0;

      // Build groups in native shape ({ title, options }) so model_picker always resolves hostRoot
      const optByLabel = new Map(modelOptions.map((o) => [o.label, o]));
      const rawSortGroups = cfgData && Array.isArray(cfgData.clientModelSorts) ? cfgData.clientModelSorts[0]?.groups : null;
      const reduxGroups =
        Array.isArray(rawSortGroups) && rawSortGroups.length
          ? rawSortGroups
              .map((g) => ({
                title: g && typeof g.groupName === 'string' ? g.groupName : '',
                options: (Array.isArray(g && g.modelLabels) ? g.modelLabels : [])
                  .map((lbl) => optByLabel.get(lbl))
                  .filter(Boolean),
              }))
              .filter((g) => g.options.length > 0)
          : [{ title: '', options: modelOptions }];
      const orchOpts = modelOptions.filter((o) => !o.disabled && isOrchestratorModelOpt(o));
      const orchestratorPlanners = synthesizeReduxOrchestratorPlanners(modelOptions, orchOpts);
      const overrideVal = cfgData?.defaultOverrideModelConfig?.modelOrAlias?.choice?.value;
      const cachedDef = cachedNativeMeta?.orchestratorDefaultPlanner;
      const orchestratorDefaultPlanner =
        (cachedDef &&
          orchestratorPlanners.find(
            (p) =>
              (cachedDef.value !== undefined && p.value === cachedDef.value) ||
              (cachedDef.label && p.label === cachedDef.label)
          )) ||
        (overrideVal !== undefined && orchestratorPlanners.find((p) => p.value === overrideVal)) ||
        orchestratorPlanners[0] ||
        null;

      return {
        isReduxFallback: true,
        hasDraftOrchPick,
        modelOptions,
        customModels,
        selectedModel,
        groups: reduxGroups,
        ...(orchestratorPlanners.length ? { orchestratorPlanners } : {}),
        ...(orchestratorDefaultPlanner ? { orchestratorDefaultPlanner } : {}),
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

  function snapshotNativeMeta(nativeApi) {
    if (!nativeApi || typeof nativeApi !== 'object') return;
    const hasGroups = Array.isArray(nativeApi.groups) && nativeApi.groups.length > 0;
    const hasPlanners = Array.isArray(nativeApi.orchestratorPlanners) && nativeApi.orchestratorPlanners.length > 0;
    if (!hasGroups && !hasPlanners && !Array.isArray(nativeApi.modelOptions)) return;
    const { store, cfgData } = getReduxCascadeConfigData();
    const reduxSig = store ? computeReduxOptionsSignature(cfgData) : cachedNativeMeta?.reduxSig || '';
    const prev = cachedNativeMeta && cachedNativeMeta.reduxSig === reduxSig ? cachedNativeMeta : {};
    cachedNativeMeta = {
      reduxSig,
      groups: hasGroups ? nativeApi.groups : prev.groups,
      modelSorts: Array.isArray(nativeApi.modelSorts) && nativeApi.modelSorts.length ? nativeApi.modelSorts : prev.modelSorts,
      bestOfNConfig: nativeApi.bestOfNConfig ?? prev.bestOfNConfig,
      orchestratorPlanners: hasPlanners ? nativeApi.orchestratorPlanners : prev.orchestratorPlanners,
      orchestratorPlannerIndex: nativeApi.orchestratorPlannerIndex ?? prev.orchestratorPlannerIndex,
      orchestratorDefaultPlanner: nativeApi.orchestratorDefaultPlanner || prev.orchestratorDefaultPlanner || null,
      modelOptions: Array.isArray(nativeApi.modelOptions) && nativeApi.modelOptions.length ? nativeApi.modelOptions : prev.modelOptions,
    };
  }

  function discoverModelSelectorApi(btnEl) {
    const { store: reduxStore, cfgData: reduxCfgData } = getReduxCascadeConfigData();
    invalidateNativeMetaIfReduxChanged(reduxCfgData, Boolean(reduxStore));
    const isProjectTrigger = Boolean(btnEl && btnEl.hasAttribute && btnEl.hasAttribute('data-ag-pd-model-trigger'));
    const nativeBtn = document.querySelector('button[data-testid="model-selector-trigger"]');
    const isValidApi = (obj) =>
      Boolean(obj && typeof obj === 'object' && typeof obj.setSelectedModel === 'function' && Array.isArray(obj.modelOptions) && obj.modelOptions.length > 0);
    const readNativeApi = (btn) => {
      if (!btn) return null;
      const fk = Object.keys(btn).find((k) => k.startsWith('__reactFiber$'));
      let f = fk ? btn[fk] : null;
      if (f && f.alternate) {
        let root = f;
        while (root.return) root = root.return;
        if (root.stateNode && root.stateNode.current && root !== root.stateNode.current) f = f.alternate;
      }
      let fallback = null;
      for (let i = 0; i < 40 && f; i++, f = f.return) {
        const p = f.memoizedProps;
        if (!p) continue;
        if (isValidApi(p.value)) return p.value;
        if (!fallback && isValidApi(p)) fallback = p;
      }
      return fallback;
    };

    if (isProjectTrigger) {
      const nativeApi = readNativeApi(nativeBtn);
      if (nativeApi) snapshotNativeMeta(nativeApi);
      const reduxApi = buildReduxModelSelectorApi();
      if (reduxApi) {
        const metaSrc = nativeApi || cachedNativeMeta;
        const enrichOptions = (baseOptions, refOptions) => {
          if (!Array.isArray(refOptions) || !refOptions.length) return baseOptions;
          const refByVal = new Map();
          const refByLabel = new Map();
          for (const opt of refOptions) {
            if (!opt) continue;
            if (opt.value !== undefined && !refByVal.has(opt.value)) refByVal.set(opt.value, opt);
            if (opt.label && !refByLabel.has(opt.label)) refByLabel.set(opt.label, opt);
          }
          return baseOptions.map((opt) => {
            const nat =
              (opt.value !== undefined && refByVal.get(opt.value)) ||
              (opt.label && refByLabel.get(opt.label)) ||
              null;
            return nat
              ? {
                  ...opt,
                  tagTitle: typeof nat.tagTitle === 'string' ? nat.tagTitle : opt.tagTitle || '',
                  tagDescription: typeof nat.tagDescription === 'string' ? nat.tagDescription : opt.tagDescription || '',
                  isDisabled: Boolean(nat.isDisabled),
                  isAvailable: nat.isAvailable !== false,
                  isHidden: Boolean(nat.isHidden),
                }
              : opt;
          });
        };
        const enrichedOptions = metaSrc ? enrichOptions(reduxApi.modelOptions, metaSrc.modelOptions) : reduxApi.modelOptions;
        const mergedGroups =
          (Array.isArray(nativeApi?.groups) && nativeApi.groups.length && nativeApi.groups) ||
          (Array.isArray(cachedNativeMeta?.groups) && cachedNativeMeta.groups.length && cachedNativeMeta.groups) ||
          reduxApi.groups;
        const mergedPlanners =
          (Array.isArray(nativeApi?.orchestratorPlanners) && nativeApi.orchestratorPlanners.length && nativeApi.orchestratorPlanners) ||
          reduxApi.orchestratorPlanners;
        const mergedDefaultPlanner =
          nativeApi?.orchestratorDefaultPlanner ||
          reduxApi.orchestratorDefaultPlanner ||
          cachedNativeMeta?.orchestratorDefaultPlanner ||
          null;
        const mergedModelSorts =
          (Array.isArray(nativeApi?.modelSorts) && nativeApi.modelSorts.length && nativeApi.modelSorts) ||
          cachedNativeMeta?.modelSorts;
        const mergedBestOfN = nativeApi?.bestOfNConfig ?? cachedNativeMeta?.bestOfNConfig;

        if (nativeApi) {
          const reduxPick = reduxApi.orchestratorPick;
          const nativePick = nativeApi.orchestratorPick;
          const mergedPickModel = reduxApi.hasDraftOrchPick
            ? reduxPick?.model ?? 0
            : (reduxPick && reduxPick.model) || (nativePick && nativePick.model) || 0;
          const mergedPick =
            (reduxPick && typeof reduxPick.select === 'function') || (nativePick && typeof nativePick.select === 'function')
              ? {
                  model: mergedPickModel,
                  select: (val) => {
                    try {
                      if (reduxPick && typeof reduxPick.select === 'function') reduxPick.select(val);
                    } catch {}
                    try {
                      if (nativePick && typeof nativePick.select === 'function') nativePick.select(val);
                    } catch {}
                    later(() => {
                      syncProjectDetailModelTrigger();
                    }, 20);
                  },
                }
              : undefined;
          return {
            ...reduxApi,
            modelOptions: enrichedOptions,
            groups: mergedGroups,
            ...(mergedModelSorts ? { modelSorts: mergedModelSorts } : {}),
            ...(mergedBestOfN ? { bestOfNConfig: mergedBestOfN } : {}),
            ...(mergedPlanners ? { orchestratorPlanners: mergedPlanners } : {}),
            orchestratorPlannerIndex: nativeApi.orchestratorPlannerIndex ?? cachedNativeMeta?.orchestratorPlannerIndex,
            ...(mergedDefaultPlanner ? { orchestratorDefaultPlanner: mergedDefaultPlanner } : {}),
            ...(mergedPick ? { orchestratorPick: mergedPick } : {}),
            setSelectedModel: (opt) => {
              reduxApi.setSelectedModel(opt);
              const match = nativeApi.modelOptions.find(
                (o) => o && ((opt.value !== undefined && o.value === opt.value) || o.label === opt.label)
              );
              try {
                nativeApi.setSelectedModel(match || opt);
              } catch {}
              later(() => {
                syncProjectDetailModelTrigger();
              }, 20);
            },
          };
        }
        const origOrchSelect = reduxApi.orchestratorPick?.select;
        return {
          ...reduxApi,
          modelOptions: enrichedOptions,
          groups: mergedGroups,
          ...(mergedModelSorts ? { modelSorts: mergedModelSorts } : {}),
          ...(mergedBestOfN ? { bestOfNConfig: mergedBestOfN } : {}),
          ...(mergedPlanners ? { orchestratorPlanners: mergedPlanners } : {}),
          ...(mergedDefaultPlanner ? { orchestratorDefaultPlanner: mergedDefaultPlanner } : {}),
          ...(origOrchSelect
            ? {
                orchestratorPick: {
                  ...reduxApi.orchestratorPick,
                  select: (val) => {
                    origOrchSelect(val);
                    later(() => {
                      syncProjectDetailModelTrigger();
                    }, 20);
                  },
                },
              }
            : {}),
          setSelectedModel: (opt) => {
            reduxApi.setSelectedModel(opt);
            later(() => {
              syncProjectDetailModelTrigger();
            }, 20);
          },
        };
      }
      if (nativeApi) return nativeApi;
      return null;
    }

    if (btnEl && btnEl.matches && btnEl.matches('button[data-testid="model-selector-trigger"]')) {
      const ownApi = readNativeApi(btnEl);
      if (ownApi) {
        snapshotNativeMeta(ownApi);
        return ownApi;
      }
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
      if (Array.isArray(window.__ag_test_orchestrator_roles)) {
        cachedOrchestratorRoleBaseIds = window.__ag_test_orchestrator_roles.filter((s) => typeof s === 'string');
      }
      return;
    }
    if (Array.isArray(cachedExecutorRoleBaseIds) && Array.isArray(cachedOrchestratorRoleBaseIds)) return;
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
            let rolesChanged = false;
            if (parsed && Array.isArray(parsed.executors) && parsed.executors.every((s) => typeof s === 'string')) {
              cachedExecutorRoleBaseIds = parsed.executors.slice();
              rolesChanged = true;
            }
            if (parsed && Array.isArray(parsed.orchestrators) && parsed.orchestrators.every((s) => typeof s === 'string')) {
              cachedOrchestratorRoleBaseIds = parsed.orchestrators.slice();
              rolesChanged = true;
            }
            if (rolesChanged) {
              try { syncProjectDetailModelTrigger(); } catch {}
              try { if (typeof hooks.scheduleSync === 'function') hooks.scheduleSync('composer'); } catch {}
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

  function getOrchestratorPrefModel() {
    try {
      const ps = discoverPrefStore();
      return ps?.getState?.()?.getPrefValue?.('orchestratorModel');
    } catch {
      return undefined;
    }
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
    cachedOrchestratorRoleBaseIds = null;
    cachedNativeMeta = null;
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
    getOrchestratorPrefModel,
    dispose,
  };
}
