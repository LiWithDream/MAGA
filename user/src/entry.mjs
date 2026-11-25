/**
 * Modular entry point for user/custom.js (compiled via esbuild to standalone browser IIFE).
 * Integrates seamlessly with studio MagaKernel when loaded (single document.body MutationObserver),
 * and provides a lightweight fallback observer when run standalone (e.g., isolated tests).
 */
/* global ctx */
import { createCustomRuntime } from './core/runtime-ctx.mjs';
import { createModelApi } from './core/model-api.mjs';
import { createStepStreamModule } from './modules/step-stream.mjs';
import { createI18nModule } from './modules/i18n.mjs';
import { createInlineUndoModule } from './modules/inline-undo.mjs';
import { createMetricsQuotaModule } from './modules/metrics-quota.mjs';
import { createSidebarRecentsModule } from './modules/sidebar-recents.mjs';
import { createCustomizationsModule } from './modules/customizations.mjs';
import { createProjectsModule } from './modules/projects/index.mjs';
import { createOverviewPanelModule } from './modules/overview-panel.mjs';
import { createSettingsHostModule } from './modules/settings-host.mjs';

(function () {
  if (typeof window !== 'undefined' && typeof window.__agClaudeUxDispose === 'function') {
    try {
      window.__agClaudeUxDispose();
    } catch {}
  }

  const rt = createCustomRuntime(typeof ctx !== 'undefined' ? ctx : undefined);
  const { FEAT, docRoot, state: rtState, hooks } = rt;

  if (docRoot && rt.origDocLang !== 'zh-CN') {
    docRoot.setAttribute('lang', 'zh-CN');
  }
  if (docRoot) {
    docRoot.setAttribute('data-ag-ux-lang', FEAT.i18n ? 'zh' : 'en');
    docRoot.setAttribute('data-ag-cjk-scale', rt.getCjkScale());
  }

  const modelApi = createModelApi(rt);
  const stepStream = createStepStreamModule(rt);
  const i18n = createI18nModule(rt);
  const inlineUndo = createInlineUndoModule(rt);
  const metricsQuota = createMetricsQuotaModule(rt);
  const sidebarRecents = createSidebarRecentsModule(rt);

  // Register SVG icons & sidebar hooks before creating projects module
  Object.assign(hooks, {
    activeReactFiber: inlineUndo.activeReactFiber,
    composerHasExistingDraft: inlineUndo.composerHasExistingDraft,
    setComposerText: inlineUndo.setComposerText,
    closeInlineEdit: inlineUndo.closeInlineEdit,
    renderInlineEditMeta: inlineUndo.renderInlineEditMeta,

    discoverAgentInputProps: metricsQuota.discoverAgentInputProps,
    getActiveCascadeId: metricsQuota.getActiveCascadeId,
    closeQuotaPopover: metricsQuota.closeQuotaPopover,
    renderQuotaPopoverBody: metricsQuota.renderQuotaPopoverBody,
    updateComposerRingVisuals: metricsQuota.updateComposerRingVisuals,
    discoverQuotaService: metricsQuota.discoverQuotaService,
    fetchQuotaSummary: metricsQuota.fetchQuotaSummary,

    applyUiI18nState: i18n.applyUiI18nState,
    teardownCodeBlocks: stepStream.teardownCodeBlocks,

    RECENT_PIN_SVG: sidebarRecents.RECENT_PIN_SVG,
    RECENT_MORE_SVG: sidebarRecents.RECENT_MORE_SVG,
    RECENT_FOLDER_SVG: sidebarRecents.RECENT_FOLDER_SVG,
    RECENT_RENAME_SVG: sidebarRecents.RECENT_RENAME_SVG,
    RECENT_ARCHIVE_SVG: sidebarRecents.RECENT_ARCHIVE_SVG,
    RECENT_TRASH_SVG: sidebarRecents.RECENT_TRASH_SVG,
    syncSidebarEnhancements: sidebarRecents.syncSidebarEnhancements,
    syncSidebarHideNativeProjects: sidebarRecents.syncSidebarHideNativeProjects,
    isSummaryPinned: sidebarRecents.isSummaryPinned,
    isSidebarVisibleSummary: sidebarRecents.isSidebarVisibleSummary,
    protoSeconds: sidebarRecents.protoSeconds,
    findSidebarBindings: sidebarRecents.findSidebarBindings,
    getSidebarListHost: sidebarRecents.getSidebarListHost,
    navigateSidebarConversation: sidebarRecents.navigateSidebarConversation,
    closeRecentRowMenu: sidebarRecents.closeRecentRowMenu,
    syncRecentSection: sidebarRecents.syncRecentSection,
    scheduleSidebarSync: sidebarRecents.scheduleSidebarSync,
    hasDroppedContextPayload: sidebarRecents.hasDroppedContextPayload,
    extractDroppedContextMentions: sidebarRecents.extractDroppedContextMentions,
    attachConversationDragTransfer: sidebarRecents.attachConversationDragTransfer,
    attachFileDragTransfer: sidebarRecents.attachFileDragTransfer,
  });

  const customizations = createCustomizationsModule(rt);
  const projects = createProjectsModule(rt, modelApi);
  const overviewPanel = createOverviewPanelModule(rt, metricsQuota);
  const settingsHost = createSettingsHostModule(rt);

  Object.assign(hooks, {
    syncCustomizationsEnhancement: customizations.syncCustomizationsEnhancement,
    teardownCustomizationsEnhancement: customizations.teardownCustomizationsEnhancement,

    appendDroppedMentionsToPdComposer: projects.appendDroppedMentionsToPdComposer,
    decodeFileUriToPath: projects.decodeFileUriToPath,
    formatShortHomePath: projects.formatShortHomePath,
    resolveProjectsStoreAndBindings: projects.resolveProjectsStoreAndBindings,
    collectNativeProjects: projects.collectNativeProjects,
    openConversationFromProject: projects.openConversationFromProject,
    startNewChatInProjectById: projects.startNewChatInProjectById,
    syncConvProjectTopbar: projects.syncConvProjectTopbar,
    showProjectsFloatingNotice: projects.showProjectsFloatingNotice,
    openProjectInstructionsModal: projects.openProjectInstructionsModal,
    openProjectsView: projects.openProjectsView,
    closeProjectsView: projects.closeProjectsView,
    syncProjectsWorkspace: projects.syncProjectsWorkspace,
    teardownProjectsWorkspace: projects.teardownProjectsWorkspace,
    refreshProjectsLanguageUi: projects.refreshProjectsLanguageUi,
    ensureSharedModalEscBound: projects.ensureSharedModalEscBound,
    closeProjectsModal: projects.closeProjectsModal,
    getConversationBranchBadge: projects.getConversationBranchBadge,

    invalidateOverviewSnapshotCache: overviewPanel.invalidateOverviewSnapshotCache,
    renderOverviewPanel: overviewPanel.renderOverviewPanel,
    syncOverviewPanel: overviewPanel.syncOverviewPanel,
    teardownOverviewPanel: overviewPanel.teardownOverviewPanel,

    reconcileSettingsPanel: settingsHost.reconcileSettingsPanel,
    syncSettingsStatsGroup: settingsHost.syncSettingsStatsGroup,
    updateSettingsNavLabel: settingsHost.updateSettingsNavLabel,
  });

  let rafPending = false;
  let throttleTimer = 0;
  const MIN_SYNC_GAP_MS = 80;

  function syncStepStream() {
    rafPending = false;
    if (rtState.disposed) return;
    rtState.lastSyncTs = Date.now();
    stepStream.sync();
    metricsQuota.sync();
    sidebarRecents.syncSidebarEnhancements();
    projects.syncProjectsWorkspace();
    overviewPanel.syncOverviewPanel(false);
    settingsHost.reconcileSettingsPanel();
  }

  function syncByTopics(topicSetOrArray) {
    if (rtState.disposed) return;
    const topics =
      topicSetOrArray instanceof Set
        ? topicSetOrArray
        : new Set(Array.isArray(topicSetOrArray) ? topicSetOrArray : ['all']);
    if (!topics.size || topics.has('all')) {
      syncStepStream();
      return;
    }
    rtState.lastSyncTs = Date.now();
    const isRoute = topics.has('route');
    if (topics.has('stream')) {
      stepStream.sync();
    } else if (topics.has('composer') || topics.has('metrics')) {
      stepStream.syncCustomDomFlags();
    }
    if (topics.has('composer') || topics.has('metrics') || isRoute) {
      metricsQuota.sync();
    }
    if (topics.has('sidebar') || isRoute) {
      sidebarRecents.syncSidebarEnhancements();
      projects.syncProjectsWorkspace();
    }
    if (topics.has('overview') || isRoute) {
      overviewPanel.syncOverviewPanel(false);
    }
    if (topics.has('settings') || isRoute) {
      settingsHost.reconcileSettingsPanel();
    }
  }

  function scheduleSync(topics = ['all'], urgent = false) {
    if (rtState.disposed) return;
    if (rtState.attachedKernel && typeof rtState.attachedKernel.markDirty === 'function') {
      rtState.attachedKernel.markDirty(topics, urgent);
      return;
    }
    if (rafPending || throttleTimer) return;
    const wait = MIN_SYNC_GAP_MS - (Date.now() - rtState.lastSyncTs);
    if (wait > 0) {
      throttleTimer = rt.later(() => {
        throttleTimer = 0;
        scheduleSync(topics, urgent);
      }, wait);
      return;
    }
    rafPending = true;
    rt.frame(syncStepStream);
  }
  hooks.scheduleSync = scheduleSync;

  function handleImmediateMutation(mutations) {
    if (rtState.disposed || !Array.isArray(mutations)) return { needSync: false, sawChildList: false };
    let needSync = false;
    let sawChildList = false;
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (m.type === 'attributes') {
        const t = m.target;
        if (!t || !t.getAttribute) continue;
        if (m.attributeName === 'aria-expanded') {
          stepStream.handleAriaExpandedMutation(t);
          if (!rt.isOwnNode(t)) needSync = true;
        } else if (m.attributeName === 'class') {
          if (!rt.isOwnNode(t) && t.closest && t.closest(rt.CLASS_WATCH_SEL)) needSync = true;
        }
      } else if (m.type === 'childList') {
        if (!rt.isOwnChildListMutation(m)) {
          needSync = true;
          sawChildList = true;
        }
      }
    }
    /* Synchronously translate & reconcile Settings in the microtask BEFORE Frame 0 paints */
    if (sawChildList) {
      const sbNow = document.querySelector('[data-testid="settings-sidebar"]');
      if (sbNow !== settingsHost.getSidebarRef() || sbNow) {
        if (FEAT.i18n && sbNow) {
          const dlgRoot = sbNow.closest('[role="dialog"]') || sbNow.closest('[data-split-root]') || sbNow.parentElement || sbNow;
          i18n.uxTranslateSubtree(dlgRoot);
        }
        settingsHost.reconcileSettingsPanel();
      }
    }
    return { needSync, sawChildList };
  }

  let observer = null;
  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver((mutations) => {
      if (rtState.disposed || rtState.attachedKernel) return;
      const { needSync } = handleImmediateMutation(mutations);
      if (needSync) scheduleSync(['all'], false);
    });
  }

  let bodyEnhancementsMounted = false;
  let pendingBodyReadyCleanup = null;

  function mountBodyEnhancements() {
    if (rtState.disposed || bodyEnhancementsMounted || !document.body) return false;
    bodyEnhancementsMounted = true;
    window.__ag_custom_js_mounted = true;
    if (pendingBodyReadyCleanup) {
      pendingBodyReadyCleanup();
      pendingBodyReadyCleanup = null;
    }
    const staleThemeToggle = document.getElementById('ag-claude-topbar-theme');
    if (staleThemeToggle) staleThemeToggle.remove();
    document.querySelectorAll('[data-ag-todo-dock], [data-ag-todo-mount]').forEach((el) => el.remove());
    document
      .querySelectorAll('[data-ag-todo-primary], [data-ag-todo-merged], [data-ag-todo-empty-wrap], [data-ag-todo-marker-line]')
      .forEach((el) => {
        el.removeAttribute('data-ag-todo-primary');
        el.removeAttribute('data-ag-todo-merged');
        el.removeAttribute('data-ag-todo-empty-wrap');
        el.removeAttribute('data-ag-todo-marker-line');
      });
    i18n.applyUiI18nState(FEAT.i18n);
    if (rt.needsInitialPrefsSync) {
      rt.persistUiPrefsToDaemon(rt.localOverrideTs || Date.now());
    }
    if (observer && !rtState.attachedKernel) {
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-expanded', 'class'],
      });
    }
    syncStepStream();
    return true;
  }

  if (!mountBodyEnhancements()) {
    const onBodyReady = () => mountBodyEnhancements();
    window.addEventListener('DOMContentLoaded', onBodyReady, { once: true });
    document.addEventListener('readystatechange', onBodyReady);
    let docElObs = null;
    if (typeof MutationObserver === 'function' && document.documentElement) {
      docElObs = new MutationObserver(() => {
        if (document.body) mountBodyEnhancements();
      });
      docElObs.observe(document.documentElement, { childList: true });
    }
    pendingBodyReadyCleanup = () => {
      window.removeEventListener('DOMContentLoaded', onBodyReady);
      document.removeEventListener('readystatechange', onBodyReady);
      if (docElObs) {
        docElObs.disconnect();
        docElObs = null;
      }
    };
  }

  const kernelHooks = {
    attachKernel(kernel) {
      if (rtState.disposed || !kernel) return;
      rtState.attachedKernel = kernel;
      observer?.disconnect();
      if (throttleTimer) {
        rt.cancelLater(throttleTimer);
        throttleTimer = 0;
      }
      rafPending = false;
    },
    detachKernel() {
      rtState.attachedKernel = null;
    },
    handleImmediateMutation(mutations) {
      handleImmediateMutation(mutations);
    },
    syncByTopics,
    syncAll: syncStepStream,
    isUsingKernel() {
      return Boolean(rtState.attachedKernel && !rtState.disposed);
    },
  };

  function dispose() {
    if (rtState.disposed) return;
    rtState.disposed = true;
    rtState.attachedKernel = null;
    window.__ag_custom_js_mounted = false;
    if (pendingBodyReadyCleanup) {
      pendingBodyReadyCleanup();
      pendingBodyReadyCleanup = null;
    }
    observer?.disconnect();
    if (throttleTimer) {
      rt.cancelLater(throttleTimer);
      throttleTimer = 0;
    }
    rafPending = false;
    rt.cleanupPendingAsync();

    inlineUndo.dispose();
    sidebarRecents.dispose();
    customizations.dispose();
    projects.dispose();
    overviewPanel.dispose();
    settingsHost.detachSettingsPanel();
    metricsQuota.dispose();
    stepStream.dispose();
    modelApi.dispose();
    i18n.dispose();

    if (typeof window !== 'undefined') {
      if (window.__agClaudeUxDispose === dispose) window.__agClaudeUxDispose = null;
      if (window.__agClaudeUxBridge === agClaudeUxBridge) window.__agClaudeUxBridge = null;
      if (window.__agClaudeUxKernelHooks === kernelHooks) window.__agClaudeUxKernelHooks = null;
    }
  }

  const agClaudeUxBridge = {
    getState() {
      const modules = Object.create(null);
      for (const [modKey, featKey] of Object.entries(rt.BRIDGED_MOD_FEAT_MAP)) {
        modules[modKey] = Boolean(FEAT[featKey]);
      }
      return {
        modules,
        cjkFontScale: rt.getCjkScale(),
      };
    },
    setModule(modKey, nextBool) {
      const featKey = rt.BRIDGED_MOD_FEAT_MAP[modKey];
      if (!featKey) return false;
      rt.setModuleOverride(modKey, featKey, Boolean(nextBool));
      return true;
    },
    setCjkScale(rawScale) {
      rt.setCjkScaleOverride(rawScale);
      return rt.getCjkScale();
    },
    getExecutorBaseIds() {
      return modelApi.getExecutorBaseIds();
    },
    getProjectModelSelector(pdBtn) {
      return modelApi.discoverModelSelectorApi(pdBtn);
    },
    getOrchestratorPrefModel() {
      return modelApi.getOrchestratorPrefModel();
    },
  };

  if (typeof window !== 'undefined') {
    window.__agClaudeUxKernelHooks = kernelHooks;
    window.__agClaudeUxBridge = agClaudeUxBridge;
    window.__agClaudeUxDispose = dispose;
    if (window.__AG_ENABLE_TEST_HOOKS__) {
      window.__t = {
        scheduleSync,
        syncStepStream,
        dispose,
        parseAndSlimMetricsPayload: metricsQuota.parseAndSlimMetricsPayload,
        cacheTierForRate: metricsQuota.cacheTierForRate,
        detectCompactStatus: metricsQuota.detectCompactStatus,
        triggerConversationCompact: metricsQuota.triggerConversationCompact,
      };
    }
  }
  if (typeof ctx !== 'undefined' && ctx && typeof ctx.onCleanup === 'function') {
    ctx.onCleanup(dispose);
  }
})();
