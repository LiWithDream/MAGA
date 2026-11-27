/**
 * Shared runtime context, feature state, async lifecycle & DOM primitives
 * for modular user/src/* runtime (compiled via esbuild to user/custom.js).
 */
export function createCustomRuntime(ctxArg) {
  const CFG_ROOT = (ctxArg && (ctxArg.config || ctxArg)) || {};
  const MODS = (ctxArg && (ctxArg.modules || (ctxArg.config && ctxArg.config.modules))) || {};
  const CFG_UI_STATE =
    CFG_ROOT.uiState && typeof CFG_ROOT.uiState === 'object' && !Array.isArray(CFG_ROOT.uiState)
      ? CFG_ROOT.uiState
      : {};
  const cfgUiPrefsTs = Number(CFG_ROOT.uiPrefsUpdatedAt) > 0 ? Number(CFG_ROOT.uiPrefsUpdatedAt) : 0;
  const MODULE_STORAGE_KEY = 'ag_claude_ux_modules_v1';
  const VALID_CJK_SCALES = ['94.5', '95', '100'];

  function normalizeCjkScale(v) {
    const s = String(v == null ? '' : v).trim().replace(/%$/, '');
    return VALID_CJK_SCALES.includes(s) ? s : null;
  }

  function loadLocalModuleOverrides() {
    try {
      const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(MODULE_STORAGE_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  const rawLocalModOverrides = loadLocalModuleOverrides();
  const localOverrideTs = Number(rawLocalModOverrides._ts) > 0 ? Number(rawLocalModOverrides._ts) : 0;
  const trustLocalOverrides = cfgUiPrefsTs === 0 || localOverrideTs >= cfgUiPrefsTs;
  const localModOverrides = trustLocalOverrides ? rawLocalModOverrides : {};
  if (!trustLocalOverrides) {
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.removeItem(MODULE_STORAGE_KEY);
        localStorage.removeItem('ag_claude_ux_recent_collapsed');
        localStorage.removeItem('ag_claude_ux_unified_recents_collapsed');
      }
    } catch {}
  }

  const needsInitialPrefsSync =
    trustLocalOverrides &&
    ((cfgUiPrefsTs === 0 && Object.keys(localModOverrides).some((k) => k !== '_ts')) ||
      (cfgUiPrefsTs > 0 && localOverrideTs > cfgUiPrefsTs));

  let currentCjkScale =
    normalizeCjkScale(localModOverrides.cjkFontScale) ||
    normalizeCjkScale(CFG_ROOT.cjkFontScale) ||
    '95';

  function effectiveModBool(key, defaultVal = true) {
    if (Object.prototype.hasOwnProperty.call(localModOverrides, key)) {
      return Boolean(localModOverrides[key]);
    }
    if (Object.prototype.hasOwnProperty.call(MODS, key)) {
      return Boolean(MODS[key]);
    }
    return defaultVal;
  }

  const FEAT = {
    i18n: effectiveModBool('i18n', false),
    stepUnfold: effectiveModBool('claudeUxStepUnfold', true),
    collapseAnim: effectiveModBool('claudeUxCollapseAnimation', true),
    runningTimer: effectiveModBool('claudeUxRunningTimer', true),
    contextRing: effectiveModBool('claudeUxContextRing', true),
    inlineUndo: effectiveModBool('claudeUxInlineUndo', true),
    folderStatus: effectiveModBool('claudeUxFolderStatus', true),
    recentSection: effectiveModBool('claudeUxRecentSection', false),
    projects: effectiveModBool('claudeUxProjects', true),
    hideSidebarProjects: effectiveModBool('claudeUxHideSidebarProjects', false),
    customizations: effectiveModBool('claudeUxCustomizations', true),
    codeFold: effectiveModBool('claudeUxCodeFold', true),
    overviewPanel: effectiveModBool('claudeUxOverviewPanel', true),
  };

  const L = (zh, en) => (FEAT.i18n ? zh : en);

  const navPlatform = typeof navigator !== 'undefined' && navigator ? String(navigator.platform || '') : '';
  const platform =
    (ctxArg && ctxArg.boot && ctxArg.boot.platform) ||
    (/Win/i.test(navPlatform) ? 'win32' : /Linux/i.test(navPlatform) ? 'linux' : 'darwin');
  const FILE_MANAGER_ZH = platform === 'win32' ? '资源管理器' : platform === 'linux' ? '文件管理器' : '访达';
  const FILE_MANAGER_EN = platform === 'win32' ? 'Explorer' : platform === 'linux' ? 'Files' : 'Finder';

  const docRoot = typeof document !== 'undefined' ? document.documentElement : null;
  const origDocLang = docRoot ? docRoot.getAttribute('lang') : null;
  const hadDocLang = docRoot ? docRoot.hasAttribute('lang') : false;

  const pendingRafs = new Set();
  const pendingTimeouts = new Set();

  const state = {
    disposed: false,
    lastSyncTs: 0,
    attachedKernel: null,
    // Shared cross-module runtime flags
    recentCollapsed: false,
    unifiedRecentCollapsed: false,
    recentLastSig: '',
    sidebarStoreRef: null,
    projectsViewOpen: false,
    projectsModalEl: null,
    projectsModalState: null,
    quotaPopoverOpen: false,
    quotaFetchInFlight: false,
    lastForceQuotaFetchTs: 0,
    wasOvPaneGenerating: false,
    cachedUserTierName: '',
    cachedQuotaGroups: null,
    manualCompactPending: false,
    latestCtxState: { cascadeId: '', hasData: false, pct: 0, ratioText: '', isStaleCompacted: false },
    activeInlineEdit: null,
  };

  function frame(fn) {
    if (state.disposed) return 0;
    const id = requestAnimationFrame((ts) => {
      pendingRafs.delete(id);
      if (!state.disposed) fn(ts);
    });
    pendingRafs.add(id);
    return id;
  }

  function later(fn, ms) {
    if (state.disposed) return 0;
    const id = setTimeout(() => {
      pendingTimeouts.delete(id);
      if (!state.disposed) fn();
    }, ms);
    pendingTimeouts.add(id);
    return id;
  }

  function cancelLater(id) {
    if (!id) return;
    clearTimeout(id);
    pendingTimeouts.delete(id);
  }

  function cleanupPendingAsync() {
    for (const id of pendingRafs) cancelAnimationFrame(id);
    pendingRafs.clear();
    for (const id of pendingTimeouts) clearTimeout(id);
    pendingTimeouts.clear();
  }

  function setLeafText(el, nextText) {
    if (!el) return;
    const str = String(nextText ?? '');
    const first = el.firstChild;
    if (first && first.nodeType === 3 && el.childNodes.length === 1) {
      if (first.nodeValue !== str) first.nodeValue = str;
      return;
    }
    if (el.textContent !== str) el.textContent = str;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function syncAttrTargetSet(attr, desiredSet) {
    document.querySelectorAll(`[${attr}]`).forEach((el) => {
      if (!desiredSet.has(el)) el.removeAttribute(attr);
    });
    for (const el of desiredSet) {
      if (el && el.getAttribute(attr) !== '1') el.setAttribute(attr, '1');
    }
  }

  const OWN_SEL =
    '[data-maga-own], .ag-collapse-ghost, .ag-orbit-dots, .ag-elapsed-timer, #ag-claude-ctx-ring, #ag-claude-quota-popover, .ag-claude-inline-editor, .ag-claude-folder-badges, #ag-claude-recent-section, #ag-recent-row-menu, #ag-project-action-menu, #ag-claude-ux-settings-nav, #ag-claude-ux-settings-panel, #ag-settings-stats-wrap, .ag-settings-subhdr-chev, #ag-claude-projects-nav-btn, #ag-claude-projects-view, #ag-claude-project-modal, .ag-code-fold-toggle, .ag-code-fold-bar, #ag-claude-ov-sections, [data-agy-picker-host="1"], #agy-capsule-picker-host, #agy-main-subagent-pill, #agy-subagent-menu, #agy-resume-pill, #agy-opus-gate-pill, #agy-opus-gate-menu, #agy-auto-compact-pill, #agy-anchors-pill, #agy-anchors-menu, [data-agy-sub-pill], #agy-ov-usage-card, #agy-pd-usage-slot, #agy-pd-usage-card, #agy-pd-hero-usage, #agy-conv-project-bar, #agy-conv-project-menu, #agy-usage-tooltip, #agy-maga-settings-trigger, #agy-maga-settings-drawer, #agy-maga-settings-root';
  const CLASS_WATCH_SEL =
    '[id="antigravity.agentSidePanelInputBox"], [data-testid="tool-group-collapsible"], [data-testid="worked-for-collapsible"], [data-testid="progress-updates-collapsible"], [data-testid="ephemeral-tool-status"]';

  function isOwnNode(n) {
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    return Boolean(el && el.closest && el.closest(OWN_SEL));
  }

  function isOwnChildListMutation(m) {
    if (isOwnNode(m.target)) return true;
    const total = m.addedNodes.length + m.removedNodes.length;
    if (!total) return true;
    for (const n of m.addedNodes) if (!isOwnNode(n)) return false;
    for (const n of m.removedNodes) if (!isOwnNode(n)) return false;
    return true;
  }

  const BRIDGED_MOD_FEAT_MAP = {
    i18n: 'i18n',
    claudeUxContextRing: 'contextRing',
    claudeUxStepUnfold: 'stepUnfold',
    claudeUxRunningTimer: 'runningTimer',
    claudeUxCollapseAnimation: 'collapseAnim',
    claudeUxCodeFold: 'codeFold',
    claudeUxInlineUndo: 'inlineUndo',
    claudeUxFolderStatus: 'folderStatus',
    claudeUxProjects: 'projects',
    claudeUxHideSidebarProjects: 'hideSidebarProjects',
    claudeUxCustomizations: 'customizations',
    claudeUxOverviewPanel: 'overviewPanel',
  };

  let prefsSyncRetryTimer = 0;
  function persistUiPrefsToDaemon(explicitTs = 0) {
    const updatedAt = explicitTs > 0 ? explicitTs : Date.now();
    localModOverrides._ts = updatedAt;
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.setItem(MODULE_STORAGE_KEY, JSON.stringify(localModOverrides));
      }
    } catch {}
    if (typeof window.__agProjectCall !== 'function') return;
    const modulesPayload = {};
    for (const [modKey, featKey] of Object.entries(BRIDGED_MOD_FEAT_MAP)) {
      modulesPayload[modKey] = Boolean(FEAT[featKey]);
    }
    const reqPayload = {
      updatedAt,
      modules: modulesPayload,
      cjkFontScale: currentCjkScale,
      uiState: {
        recentCollapsed: Boolean(state.recentCollapsed),
        unifiedRecentCollapsed: Boolean(state.unifiedRecentCollapsed),
      },
    };
    window
      .__agProjectCall('saveUiPrefs', reqPayload, 5000)
      .then((res) => {
        if (state.disposed) return;
        if (!res || !res.ok) {
          cancelLater(prefsSyncRetryTimer);
          prefsSyncRetryTimer = later(() => {
            if (!state.disposed && typeof window.__agProjectCall === 'function') {
              window.__agProjectCall('saveUiPrefs', reqPayload, 5000).catch(() => {});
            }
          }, 450);
        }
      })
      .catch(() => {});
  }

  const hooks = Object.create(null);

  function scheduleSync(topics = ['all'], urgent = false) {
    if (typeof hooks.scheduleSync === 'function') {
      hooks.scheduleSync(topics, urgent);
    }
  }

  function applyImmediateFeatureEffects(featKey, on) {
    if (featKey === 'i18n') {
      hooks.applyUiI18nState?.(on);
      hooks.updateSettingsNavLabel?.();
      hooks.syncSettingsStatsGroup?.();
      if (state.quotaPopoverOpen) hooks.renderQuotaPopoverBody?.();
      hooks.updateComposerRingVisuals?.();
      if (typeof window.__ag_render_metrics === 'function' && window.__ag_last_metrics) {
        try {
          window.__ag_render_metrics(window.__ag_last_metrics);
        } catch {}
      }
      state.recentLastSig = '';
      if (state.activeInlineEdit) hooks.renderInlineEditMeta?.(state.activeInlineEdit);
      hooks.refreshProjectsLanguageUi?.();
      hooks.syncCustomizationsEnhancement?.();
      hooks.renderOverviewPanel?.(true);
    } else if (featKey === 'projects') {
      if (!on) hooks.teardownProjectsWorkspace?.();
      else hooks.syncProjectsWorkspace?.();
    } else if (featKey === 'hideSidebarProjects') {
      hooks.syncSidebarHideNativeProjects?.();
    } else if (featKey === 'customizations') {
      if (!on) hooks.teardownCustomizationsEnhancement?.();
      else hooks.syncCustomizationsEnhancement?.();
    } else if (featKey === 'contextRing') {
      if (!on) {
        const ring = document.getElementById('ag-claude-ctx-ring');
        if (ring) ring.remove();
        hooks.closeQuotaPopover?.();
        const tt = document.getElementById('ag-live-metrics-tooltip');
        if (tt) tt.removeAttribute('data-ag-pinned');
      }
      if (typeof window.__ag_render_metrics === 'function' && window.__ag_last_metrics) {
        try {
          window.__ag_render_metrics(window.__ag_last_metrics);
        } catch {}
      }
    } else if (featKey === 'stepUnfold' && !on) {
      document.querySelectorAll('[data-ag-inline-stream]').forEach((el) => el.removeAttribute('data-ag-inline-stream'));
    } else if (featKey === 'runningTimer' && !on) {
      document.querySelectorAll('.ag-orbit-dots, .ag-elapsed-timer').forEach((n) => n.remove());
    } else if (featKey === 'inlineUndo' && !on) {
      hooks.closeInlineEdit?.(false);
    } else if (featKey === 'codeFold' && !on) {
      hooks.teardownCodeBlocks?.();
    } else if (featKey === 'overviewPanel') {
      if (!on) hooks.teardownOverviewPanel?.();
      else hooks.syncOverviewPanel?.(true);
    }
    hooks.syncSidebarEnhancements?.();
    scheduleSync(['all'], true);
  }

  function setCjkScaleOverride(rawScale) {
    const next = normalizeCjkScale(rawScale);
    if (!next) return;
    currentCjkScale = next;
    localModOverrides.cjkFontScale = next;
    persistUiPrefsToDaemon();
    if (docRoot) {
      docRoot.setAttribute('data-ag-cjk-scale', next);
    }
  }

  function setModuleOverride(modKey, featKey, nextBool) {
    localModOverrides[modKey] = Boolean(nextBool);
    FEAT[featKey] = Boolean(nextBool);
    persistUiPrefsToDaemon();
    applyImmediateFeatureEffects(featKey, FEAT[featKey]);
  }

  return {
    ctx: ctxArg,
    CFG_ROOT,
    MODS,
    CFG_UI_STATE,
    MODULE_STORAGE_KEY,
    VALID_CJK_SCALES,
    normalizeCjkScale,
    localModOverrides,
    localOverrideTs,
    trustLocalOverrides,
    needsInitialPrefsSync,
    getCjkScale: () => currentCjkScale,
    FEAT,
    L,
    platform,
    isWindows: platform === 'win32',
    FILE_MANAGER_ZH,
    FILE_MANAGER_EN,
    docRoot,
    origDocLang,
    hadDocLang,
    state,
    frame,
    later,
    cancelLater,
    cleanupPendingAsync,
    setLeafText,
    escapeHtml,
    syncAttrTargetSet,
    OWN_SEL,
    CLASS_WATCH_SEL,
    isOwnNode,
    isOwnChildListMutation,
    BRIDGED_MOD_FEAT_MAP,
    persistUiPrefsToDaemon,
    setCjkScaleOverride,
    setModuleOverride,
    hooks,
    scheduleSync,
  };
}
