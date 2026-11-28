/**
 * Claude-Style Projects Workspace Orchestrator (#ag-claude-projects-view Grid & Detail).
 */
import { createProjectSharedContext } from './shared.mjs';
import { createProjectMentionsMedia } from './mentions-media.mjs';
import { createProjectNativeStore } from './native-store.mjs';
import { createProjectModals } from './modals.mjs';
import { createProjectWorkspaceUi } from './workspace-ui.mjs';
import { createConvProjectTopbar } from './conv-topbar.mjs';
import { createWorktreeUiController } from './worktree-ui.mjs';
import { createProjectSuggestionsController } from './suggestions-ui.mjs';
import { createHandoffLaunchHelper } from './handoff-launch.mjs';
import {
  computeProjectsOverlayMetrics,
  findLeftSidebarEl,
  findLeftSidebarTrackEl,
  measureTopMenuBarHeight,
  syncWinTopBarCssVar,
} from './chrome-geometry.mjs';

export function createProjectsModule(rt, modelApi) {
  const ctx = createProjectSharedContext(rt, modelApi);
  const {
    FEAT,
    L,
    rtState,
    frame,
    later,
    escapeHtml,
    setLeafText,
    syncAttrTargetSet,
    pState,
    ICONS,
    pHooks,
    activeReactFiber,
    getActiveCascadeId,
    syncSidebarHideNativeProjects,
    syncCustomizationsEnhancement,
    teardownCustomizationsEnhancement,
    invalidateOverviewSnapshotCache,
    hasDroppedContextPayload,
    extractDroppedContextMentions,
    attachConversationDragTransfer,
    attachFileDragTransfer,
    navigateSidebarConversation,
  } = ctx;
  const {
    SVG_CLAUDE_PROJECTS_ICON,
    SVG_PROJ_SEARCH_ICON,
    SVG_PROJ_CHEVRON,
    SVG_PROJ_FOLDER_ADD,
    SVG_PROJ_SEND_ARROW,
    SVG_PROJ_FOLDER_OPEN,
    SVG_PROJ_PLUS,
    SVG_PROJ_EDIT,
    RECENT_PIN_SVG,
    RECENT_MORE_SVG,
  } = ICONS;
  const {
    displayEffortLabel,
    buildReduxModelSelectorApi,
    discoverModelSelectorApi,
    buildModelCatalog,
    pickVariantForFamily,
    formatProjectComposerModelParts,
    syncProjectDetailModelTrigger,
    applyModelSelectionOption,
  } = modelApi;

  const nativeStore = createProjectNativeStore(ctx);
  const mentionsMedia = createProjectMentionsMedia(ctx);
  const modals = createProjectModals(ctx);
  const workspaceUi = createProjectWorkspaceUi(ctx);
  const worktreeUi = createWorktreeUiController(ctx);
  const suggestionsUi = createProjectSuggestionsController(ctx);

  const {
    clearNewProjectWatcher,
    decodeFileUriToPath,
    formatShortHomePath,
    formatProjectTimeAgo,
    resolveProjectsStoreAndBindings,
    collectNativeProjects,
    closeProjectActionMenu,
    renderProjectActionMenu,
    openProjectActionMenu,
    renderRenameProjectModal,
    saveProjectContextDelta,
    pickAndAddFolderToProject,
    removeExtraFolderFromProject,
    pickAndAddFilesToProject,
    addDroppedFilesToProject,
    removeFileFromProject,
    refreshProjectsContexts,
  } = nativeStore;

  const {
    getProjectMentionMap,
    closePdMentionMenu,
    renderPdMentionPopover,
    syncPdMentionPills,
    getProjectMediaList,
    extractComposerImageFiles,
    stagePdComposerImageFiles,
    syncPdMediaStrip,
    movePdMentionSelection,
    applyPdMentionSelection,
    appendDroppedMentionsToPdComposer,
    openUrlAtTextareaCaret,
    updatePdMentionMenuForInput,
    buildComposerSubmitChunks,
  } = mentionsMedia;

  const {
    openProjectInstructionsModal,
    renderProjectContextModal,
    runProjectScheduledTask,
    deleteProjectScheduledTaskFromUi,
    openProjectScheduledModal,
    renderProjectScheduledModal,
  } = modals;

  const {
    emitProjectsEvent,
    fetchProjectWorkspaceStatus,
    bindProjectWorkspaceEvents,
    formatInstructionsPreview,
    buildTopbarHtml,
    buildProjectHeroHtml,
    buildWorkspacePulseSectionHtml,
    buildQuickActionsStripHtml,
    buildQuickStartersHtml,
    buildRecentsHeaderHtml,
    buildProjectsGridViewHtml,
    buildDetailChatsHtml,
    buildDetailFilesHtml,
    buildDetailScheduledHtml,
    buildFolderMenuHtml,
  } = workspaceUi;

  function positionProjectsOverlay() {
    const topBarPx = measureTopMenuBarHeight();
    syncWinTopBarCssVar(topBarPx);
    if (!pState.projectsViewEl || !rtState.projectsViewOpen) return;
    const sidebar = findLeftSidebarEl();
    const track = sidebar ? findLeftSidebarTrackEl(sidebar) : null;
    const winW = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0;
    const sidebarRect = sidebar && typeof sidebar.getBoundingClientRect === 'function' ? sidebar.getBoundingClientRect() : null;
    const trackRect =
      track && track !== sidebar && typeof track.getBoundingClientRect === 'function'
        ? track.getBoundingClientRect()
        : null;
    const { leftPx, topPx, collapsed, safeLeftPad } = computeProjectsOverlayMetrics({
      sidebarRect,
      trackRect,
      topBarPx,
      winW,
    });
    if (topPx > 0) syncWinTopBarCssVar(topPx);
    pState.projectsViewEl.style.left = `${leftPx}px`;
    pState.projectsViewEl.style.setProperty('--ag-proj-top', `${topPx}px`);
    pState.projectsViewEl.setAttribute('data-sidebar-collapsed', collapsed ? 'true' : 'false');
    pState.projectsViewEl.style.setProperty('--ag-proj-topbar-pl', `${safeLeftPad}px`);
  }

  function ensureProjectsSidebarObserver() {
    if (typeof ResizeObserver === 'undefined') return;
    const sb = findLeftSidebarEl();
    const track = sb ? findLeftSidebarTrackEl(sb) : null;
    if (!sb || (pState.projectsSidebarRoTarget === sb && pState.projectsSidebarRoTrack === track)) return;
    if (pState.projectsSidebarRo) {
      try {
        pState.projectsSidebarRo.disconnect();
      } catch {}
    }
    pState.projectsSidebarRoTarget = sb;
    pState.projectsSidebarRoTrack = track;
    pState.projectsSidebarRo = new ResizeObserver(() => positionProjectsOverlay());
    try {
      pState.projectsSidebarRo.observe(sb);
      if (track && track !== sb) pState.projectsSidebarRo.observe(track);
    } catch {}
  }

  function updateProjectsNavActiveVisual() {
    const btn = document.getElementById('ag-claude-projects-nav-btn');
    if (!btn) return;
    const actStr = rtState.projectsViewOpen ? 'true' : 'false';
    const curStr = rtState.projectsViewOpen ? 'page' : 'false';
    if (btn.getAttribute('data-active') !== actStr) btn.setAttribute('data-active', actStr);
    if (btn.getAttribute('aria-current') !== curStr) btn.setAttribute('aria-current', curStr);
    const lbl = btn.querySelector('.ag-proj-nav-label');
    const nextLbl = L('项目', 'Projects');
    if (lbl) setLeafText(lbl, nextLbl);
  }

  let projectsOpenedPathname = '';
  let sharedModalEscBound = false;

  function isCustomizationsModalKind(st) {
    return Boolean(st && (st.kind === 'addSkill' || st.kind === 'addAgent'));
  }

  function onSharedModalEscKeyDown(e) {
    if (rtState.disposed || e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
    if (!rtState.projectsModalEl || !rtState.projectsModalEl.isConnected) return;
    if (pState.projectsDocListenerBound) return; // handled by onProjectsGlobalKeyDown when Projects is enabled
    e.preventDefault();
    e.stopPropagation();
    closeProjectsModal();
  }

  function ensureSharedModalEscBound() {
    if (sharedModalEscBound) return;
    sharedModalEscBound = true;
    document.addEventListener('keydown', onSharedModalEscKeyDown, true);
  }

  function closeProjectsModal() {
    rtState.projectsModalState = null;
    if (rtState.projectsModalEl) {
      rtState.projectsModalEl.remove();
      rtState.projectsModalEl = null;
    }
  }

  function closePdModelMenu() {
    pState.pdModelMenuOpen = false;
    if (pState.pdModelMenuEl) {
      pState.pdModelMenuEl.remove();
      pState.pdModelMenuEl = null;
    }
    const btn = document.getElementById('ag-pd-model-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('data-ag-model-open');
    }
  }

  function renderPdModelMenu(pdBtn) {
    const api = discoverModelSelectorApi(pdBtn);
    if (!api) return;
    const cat = buildModelCatalog(api);
    const activeFamName = cat.activeFamily ? cat.activeFamily.baseName : '';
    const activeEffort = (cat.activeVariant && cat.activeVariant.effort) || 'Medium';

    if (pState.pdModelMenuEl) pState.pdModelMenuEl.remove();
    const menu = document.createElement('div');
    menu.id = 'ag-pd-model-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('data-open', 'true');
    menu.setAttribute('data-ag-i18n-ignore', '1');

    const addRow = (fam) => {
      const isAct = fam.baseName === activeFamName;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ag-pd-mm-row';
      row.setAttribute('role', 'menuitem');
      row.setAttribute('data-ag-pd-model-family', fam.baseName);
      row.setAttribute('data-active', isAct ? 'true' : 'false');
      const v = pickVariantForFamily(fam, activeEffort);
      const effText = v && v.effort ? displayEffortLabel(v.effort) : '';
      row.innerHTML =
        `<span class="ag-pd-mm-name">${escapeHtml(fam.baseName)}</span>` +
        `<span class="ag-pd-mm-meta">${effText ? escapeHtml(effText) : ''}${isAct ? '<span class="ag-pd-mm-check" aria-hidden="true">✓</span>' : ''}</span>`;
      row.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const chosen = pickVariantForFamily(fam, activeEffort);
        if (chosen && chosen.opt) applyModelSelectionOption(api, chosen.opt, chosen.plannerOpt);
        closePdModelMenu();
        syncProjectDetailModelTrigger();
      });
      menu.appendChild(row);
    };

    for (const fam of cat.primaryFamilies) addRow(fam);
    if (cat.moreFamilies.length) {
      const div = document.createElement('div');
      div.className = 'ag-pd-mm-sep';
      menu.appendChild(div);
      for (const entry of cat.moreFamilies) addRow(entry.fam);
    }

    if (cat.activeFamily && cat.activeFamily.variants.length > 1) {
      const effWrap = document.createElement('div');
      effWrap.className = 'ag-pd-mm-effs';
      for (const v of cat.activeFamily.variants) {
        if (!v.effort) continue;
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'ag-pd-mm-eff';
        pill.setAttribute('data-active', v.effort === activeEffort ? 'true' : 'false');
        pill.textContent = displayEffortLabel(v.effort);
        pill.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          applyModelSelectionOption(api, v.opt, v.plannerOpt);
          closePdModelMenu();
          syncProjectDetailModelTrigger();
        });
        effWrap.appendChild(pill);
      }
      if (effWrap.childElementCount) menu.appendChild(effWrap);
    }

    const host = pdBtn.closest('.ag-pd-composer-right') || pdBtn.parentElement || pState.projectsViewEl;
    if (!host) return;
    host.appendChild(menu);
    pState.pdModelMenuEl = menu;
    pState.pdModelMenuOpen = true;
    pdBtn.setAttribute('aria-expanded', 'true');
    pdBtn.setAttribute('data-ag-model-open', 'true');
  }

  function togglePdModelMenu(pdBtn) {
    if (pState.pdModelMenuOpen) {
      closePdModelMenu();
    } else {
      renderPdModelMenu(pdBtn);
    }
  }

  const convTopbar = createConvProjectTopbar({
    FEAT,
    L,
    rtState,
    pState,
    escapeHtml,
    later,
    getActiveCascadeId,
    decodeFileUriToPath,
    formatShortHomePath,
    resolveProjectsStoreAndBindings,
    collectNativeProjects,
    openProjectsView: (...args) => openProjectsView(...args),
    startNewChatInProject: (...args) => startNewChatInProject(...args),
    showProjectsFloatingNotice: (...args) => showProjectsFloatingNotice(...args),
    worktreeUi,
  });

  function closeProjectsView(opts = {}) {
    clearNewProjectWatcher();
    closeProjectActionMenu();
    closePdMentionMenu();
    closePdModelMenu();
    const keepCustModal = !opts.forceCloseAllModals && isCustomizationsModalKind(rtState.projectsModalState);
    if (!rtState.projectsViewOpen && (keepCustModal || !rtState.projectsModalEl)) return;
    if (!keepCustModal) closeProjectsModal();
    pState.projectFolderDropdownOpen = false;
    pState.projectFolderSearch = '';
    pState.pdDirtyExpanded = false;
    pState.pdExpandedCommitHash = '';
    pState.pdBreadcrumbMenuOpen = false;
    rtState.projectsViewOpen = false;
    projectsOpenedPathname = '';
    if (pState.projectsViewEl) {
      pState.projectsViewEl.setAttribute('data-open', 'false');
    }
    emitProjectsEvent('agy:projects-rendered');
    if (typeof window !== 'undefined') window.__agyMagaKernel?.markDirty?.(['composer'], false);
    updateProjectsNavActiveVisual();
    convTopbar.sync();
  }

  function isNativeModalDialogOpen() {
    const dialogs = document.querySelectorAll('[role="dialog"], .agy-dialog, [role="menu"], [role="listbox"], [data-popover-popup]');
    for (const el of dialogs) {
      if (
        !el ||
        !el.isConnected ||
        el.closest(
          '#ag-claude-project-modal, #ag-claude-projects-view, #ag-claude-quota-popover, #ag-recent-row-menu, #ag-project-action-menu, #agy-conv-project-menu'
        )
      ) {
        continue;
      }
      if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) continue;
      try {
        const cs = window.getComputedStyle(el);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) continue;
      } catch {}
      return true;
    }
    return false;
  }

  function onProjectsGlobalClick(e) {
    if (!rtState.projectsViewOpen) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-testid="sidebar-toggle"]')) {
      frame(() => {
        ensureProjectsSidebarObserver();
        positionProjectsOverlay();
      });
      later(() => {
        ensureProjectsSidebarObserver();
        positionProjectsOverlay();
      }, 160);
      later(() => {
        ensureProjectsSidebarObserver();
        positionProjectsOverlay();
      }, 320);
      return;
    }
    if (pState.pdMentionState.open && !t.closest('.ag-pd-composer-anchor, #ag-pd-mention-popover')) {
      closePdMentionMenu();
    }
    if (pState.pdModelMenuOpen && !t.closest('#ag-pd-model-menu, #ag-pd-model-btn')) {
      closePdModelMenu();
    }
    if (pState.pdBreadcrumbMenuOpen && !t.closest('.ag-pd-crumb-wrap')) {
      pState.pdBreadcrumbMenuOpen = false;
      renderProjectsView();
    }
    if (pState.projectFolderDropdownOpen && !t.closest('[data-ag-pd-folder-menu], [data-ag-pd-folder-toggle]')) {
      pState.projectFolderDropdownOpen = false;
      pState.projectFolderSearch = '';
      if (pState.projectsViewEl) {
        const openMenu = pState.projectsViewEl.querySelector('[data-ag-pd-folder-menu]');
        if (openMenu) openMenu.remove();
        const toggleBtn = pState.projectsViewEl.querySelector('[data-ag-pd-folder-toggle]');
        if (toggleBtn) toggleBtn.setAttribute('data-open', 'false');
      }
    }
    if (
      t.closest(
        '#ag-claude-projects-nav-btn, #ag-claude-projects-view, #ag-claude-project-modal, #ag-recent-row-menu, #ag-project-action-menu, .agy-dialog, [role="dialog"]'
      )
    ) {
      return;
    }
    if (
      t.closest(
        'a[href="/"], [data-testid="new-conversation-button"], [data-testid="automations-button"], a[href="/customizations"], [data-testid="settings-button"], [data-testid="conversation-row-sidebar"], #ag-claude-recent-section [data-ag-recent-new], #ag-claude-sidebar-projects [data-ag-sbp-new-chat]'
      ) ||
      (t.closest('#ag-claude-recent-section .ag-recent-row') &&
        !t.closest('[data-ag-recent-pin], [data-ag-recent-menu], [data-ag-recent-rename-input]')) ||
      (t.closest('#ag-claude-sidebar-projects .ag-sbp-row') &&
        !t.closest('[data-ag-sbp-pin], [data-ag-sbp-menu]'))
    ) {
      closeProjectsView();
    }
  }

  function onProjectsGlobalKeyDown(e) {
    if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
    /* Let sidebar inline rename, recent row menu, model/quota popovers handle Escape first */
    if (
      (e.target && e.target.closest && e.target.closest('[data-ag-recent-rename-input]')) ||
      document.getElementById('ag-recent-row-menu') ||
      rtState.quotaPopoverOpen
    ) {
      return;
    }
    if (pState.pdModelMenuOpen) {
      e.preventDefault();
      e.stopPropagation();
      closePdModelMenu();
    } else if (pState.pdMentionState.open) {
      e.preventDefault();
      e.stopPropagation();
      closePdMentionMenu();
    } else if (pState.projectMenuState) {
      e.preventDefault();
      e.stopPropagation();
      closeProjectActionMenu();
    } else if (rtState.projectsModalEl && rtState.projectsModalEl.isConnected) {
      e.preventDefault();
      e.stopPropagation();
      closeProjectsModal();
    } else if (isNativeModalDialogOpen()) {
      return;
    } else if (pState.pdBreadcrumbMenuOpen) {
      e.preventDefault();
      e.stopPropagation();
      pState.pdBreadcrumbMenuOpen = false;
      renderProjectsView();
    } else if (pState.projectFolderDropdownOpen) {
      e.preventDefault();
      e.stopPropagation();
      pState.projectFolderDropdownOpen = false;
      pState.projectFolderSearch = '';
      renderProjectsView();
    } else if (rtState.projectsViewOpen && pState.activeProjectId) {
      e.preventDefault();
      e.stopPropagation();
      pState.activeProjectId = null;
      pState.projectSelectedFolderPath = '';
      renderProjectsView();
    } else if (rtState.projectsViewOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeProjectsView();
    }
  }

  function findNativeNewProjectEntryAction(addBtn) {
    if (!addBtn) return null;
    let f = activeReactFiber(addBtn);
    for (let d = 0; f && d < 24; d++, f = f.return) {
      for (let h = f.memoizedState; h; h = h.next) {
        const ms = h.memoizedState;
        const list = Array.isArray(ms) && Array.isArray(ms[0]) ? ms[0] : Array.isArray(ms) ? ms : null;
        if (!list || !list.length) continue;
        for (const it of list) {
          if (!it || typeof it !== 'object' || it.disabled || typeof it.onClick !== 'function') continue;
          const lbl = String(it.label || it.title || '').trim();
          if (
            it.type === 'NEW_PROJECT' ||
            /^(new project|create(?: new)? project|新建项目)$/i.test(lbl)
          ) {
            return () => it.onClick();
          }
        }
      }
    }
    return null;
  }

  function armNewProjectCompletionWatcher(store, bindings) {
    clearNewProjectWatcher();
    if (!rtState.projectsViewOpen || !store || typeof store.subscribe !== 'function' || typeof store.getState !== 'function') {
      return;
    }
    const beforeIds = new Set(collectNativeProjects().map((p) => p.id));
    const readSearchProj = () => {
      const loc = bindings && bindings.router && bindings.router.state && bindings.router.state.location;
      return (loc && loc.search && loc.search.project) || '';
    };
    const beforeSearchProj = readSearchProj();
    let sawDialogOpen = false;
    let closeGraceTimer = 0;
    let lastWatchSig = '';

    const focusProjectInOverlay = (proj) => {
      clearNewProjectWatcher();
      if (rtState.disposed || !rtState.projectsViewOpen || !proj) return;
      pState.activeProjectId = proj.id;
      pState.projectSelectedFolderPath = proj.dirPath || '';
      renderProjectsView();
      refreshProjectsContexts([proj]);
    };

    const unsub = store.subscribe(() => {
      if (rtState.disposed || !rtState.projectsViewOpen) {
        clearNewProjectWatcher();
        return;
      }
      const st = store.getState();
      const rawList = (st && st.sidebarProjects && st.sidebarProjects.projects) || [];
      const isOpen = Boolean((st && st.newProject && st.newProject.isOpen) || isNativeModalDialogOpen());
      const nextSearchProj = readSearchProj();
      const watchSig = `${isOpen ? 1 : 0}|${nextSearchProj}|${rawList.length}|${rawList.map((p) => (p && p.id) || '').join(',')}`;
      if (watchSig === lastWatchSig) return;
      lastWatchSig = watchSig;

      if (isOpen) {
        sawDialogOpen = true;
        if (closeGraceTimer) {
          clearTimeout(closeGraceTimer);
          closeGraceTimer = 0;
        }
      }
      const curProjects = collectNativeProjects();
      const created = curProjects.find((p) => p.id && !beforeIds.has(p.id));
      if (created) {
        focusProjectInOverlay(created);
        return;
      }
      if (sawDialogOpen && !isOpen && nextSearchProj && nextSearchProj !== beforeSearchProj) {
        const selectedExisting = curProjects.find((p) => p.id === nextSearchProj);
        if (selectedExisting) {
          focusProjectInOverlay(selectedExisting);
          return;
        }
      }
      if (sawDialogOpen && !isOpen && !closeGraceTimer) {
        closeGraceTimer = later(() => {
          clearNewProjectWatcher();
        }, 2500);
      }
    });

    const maxTimer = later(() => {
      clearNewProjectWatcher();
    }, 60000);

    pState.newProjectWatchCleanup = () => {
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer);
        closeGraceTimer = 0;
      }
      if (maxTimer) clearTimeout(maxTimer);
      if (typeof unsub === 'function') unsub();
    };
  }

  function triggerNativeNewProject() {
    const addBtn = document.querySelector('[data-testid="sidebar-add-project-button"]');
    const { store, bindings } = resolveProjectsStoreAndBindings();
    const directEntryAction = findNativeNewProjectEntryAction(addBtn);
    const st = store && typeof store.getState === 'function' ? store.getState() : null;
    const hasNewProjectSlice = Boolean(
      st && st.newProject && typeof st.newProject === 'object' && store && typeof store.dispatch === 'function'
    );

    if (directEntryAction) {
      armNewProjectCompletionWatcher(store, bindings);
      directEntryAction();
      return;
    }

    if (hasNewProjectSlice) {
      armNewProjectCompletionWatcher(store, bindings);
      store.dispatch({ type: 'newProject/reset' });
      store.dispatch({ type: 'newProject/setStep', payload: 'folderSelection' });
      store.dispatch({ type: 'newProject/setIsOpen', payload: true });
      return;
    }

    if (!addBtn) return;

    const isMultiMenuTrigger =
      addBtn.hasAttribute('data-base-ui-click-trigger') ||
      addBtn.getAttribute('aria-haspopup') === 'dialog' ||
      addBtn.getAttribute('aria-haspopup') === 'menu';

    if (isMultiMenuTrigger) {
      armNewProjectCompletionWatcher(store, bindings);
      addBtn.click();
      later(() => {
        if (rtState.disposed) return;
        const popups = document.querySelectorAll('[data-popover-popup], [role="menu"], [role="dialog"]');
        for (const pop of popups) {
          if (!pop || pop.closest('#ag-claude-project-modal, #ag-claude-projects-view, .agy-dialog')) continue;
          const items = pop.querySelectorAll('button, [role="menuitem"], [role="option"], .main-row-trigger');
          for (const item of items) {
            const txt = String(item.textContent || '').trim();
            if (/^(new project|create(?: new)? project|新建项目)$/i.test(txt)) {
              item.click();
              return;
            }
          }
        }
      }, 24);
      return;
    }

    closeProjectsView();
    addBtn.click();
  }

  function openConversationFromProject(cid) {
    const { bindings } = resolveProjectsStoreAndBindings();
    closeProjectsView();
    if (cid) navigateSidebarConversation(cid, bindings);
  }

  function buildFallbackMediaObjects(mediaList) {
    const zeroTs = typeof BigInt === 'function' ? BigInt(0) : 0;
    return mediaList.map((m) => ({
      $typeName: 'exa.codeium_common_pb.Media',
      mimeType: m.mimeType || 'image/png',
      description: m.name || 'pasted-image.png',
      payload: { case: 'inlineData', value: m.bytes || new Uint8Array(0) },
      uri: '',
      thumbnail: m.bytes || new Uint8Array(0),
      durationSeconds: 0,
      mediaId: '',
      displayName: '',
      startTimeMs: zeroTs,
      endTimeMs: zeroTs,
      fps: 0,
      mediaResolution: 0,
      contentLayers: [],
      documentContentLayers: [],
      visibleCells: '',
      spreadsheetContentLayers: []
    }));
  }

  function showProjectsFloatingNotice(msg) {
    if (rtState.disposed || !document.body || !msg) return;
    const old = document.getElementById('ag-projects-float-toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.id = 'ag-projects-float-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('data-ag-i18n-ignore', '1');
    toast.style.cssText =
      'position:fixed;bottom:24px;right:24px;z-index:2147483000;max-width:360px;padding:10px 14px;border-radius:10px;background:rgba(30,30,30,0.92);color:#fff;font-size:13px;line-height:1.4;box-shadow:0 8px 24px rgba(0,0,0,0.28);pointer-events:none;';
    toast.textContent = msg;
    document.body.appendChild(toast);
    later(() => {
      if (toast.isConnected) toast.remove();
    }, 4500);
  }

  function startNewChatInProject(project, initialPrompt = '', mentionEntries = [], mediaEntries = [], rollbackDraft = null, launchOpts = null) {
    const { store, bindings } = resolveProjectsStoreAndBindings();
    const prompt = String(initialPrompt || '').trim();
    const submitChunks = buildComposerSubmitChunks(prompt, mentionEntries);
    const mediaList = Array.isArray(mediaEntries) ? mediaEntries.filter(Boolean) : [];
    const prevInputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    const prevPath =
      bindings && bindings.router && bindings.router.state && bindings.router.state.location
        ? bindings.router.state.location.pathname
        : '';
    const wasOnHome = prevPath === '/';

    const restoreComposerDraftOnFailure = () => {
      if (!rollbackDraft || !project || !project.id) return;
      if (rollbackDraft.raw) pState.projectComposerDrafts.set(project.id, rollbackDraft.raw);
      if (Array.isArray(rollbackDraft.mediaArr) && rollbackDraft.mediaArr.length) {
        pState.projectComposerMedia.set(project.id, rollbackDraft.mediaArr.slice());
      }
      if (Array.isArray(rollbackDraft.mentionEntries) && rollbackDraft.mentionEntries.length) {
        const mMap = getProjectMentionMap(project.id, true);
        for (const en of rollbackDraft.mentionEntries) {
          if (en && en.token) mMap.set(en.token, en);
        }
      }
      showProjectsFloatingNotice(
        L('未能找到主输入框，消息与附件已保留在项目草稿中，请重试。', 'Composer unavailable — your draft and attachments were preserved.')
      );
    };

    if (store && typeof store.dispatch === 'function' && project && project.id) {
      try {
        store.dispatch({ type: 'newConvoResourceSelector/setMagicWorkspaceSelected', payload: false });
        store.dispatch({ type: 'newConvoResourceSelector/setPseudoProjectSelected', payload: false });
        store.dispatch({ type: 'newConvoResourceSelector/setLastSelectedProject', payload: project.id });
      } catch {}
    }
    closeProjectsView();
    if (bindings && bindings.router && typeof bindings.router.navigate === 'function') {
      try {
        bindings.router.navigate({
          to: '/',
          search: project && project.id ? { project: project.id } : {}
        });
      } catch {}
    } else {
      const newBtn = document.querySelector('[data-testid="new-conversation-button"]');
      if (newBtn) newBtn.click();
    }

    if (!submitChunks.length && !mediaList.length) return;
    let tries = 0;
    let landedAtTry = -1;
    let submitting = false;
    const trySubmit = () => {
      if (rtState.disposed || submitting) return;
      const loc = bindings && bindings.router && bindings.router.state && bindings.router.state.location;
      const atHome = !loc || loc.pathname === '/';
      const projectMatched = !loc || !project || !project.id || (loc.search && loc.search.project === project.id);
      const box = document.getElementById('antigravity.agentSidePanelInputBox');
      const readyDom = Boolean(box && (wasOnHome || box !== prevInputBox || tries >= 16));
      if (!atHome || !projectMatched || !readyDom) {
        if (++tries < 35) later(trySubmit, 70);
        else {
          restoreComposerDraftOnFailure();
          launchOpts?.onOutcome?.({ phase: 'nav_fail', error: 'composer_unavailable' });
        }
        return;
      }
      /* Give the newly mounted Home composer one extra tick so its project & workspace hooks settle */
      if (landedAtTry === -1) {
        landedAtTry = tries;
        later(trySubmit, 140);
        return;
      }
      let handleSubmit = null;
      let inputBoxRef = null;
      let f = activeReactFiber(box);
      for (let d = 0; f && d < 36 && (!handleSubmit || !inputBoxRef); d++, f = f.return) {
        const mp = f.memoizedProps;
        if (!handleSubmit && mp && typeof mp.handleSubmit === 'function') {
          handleSubmit = mp.handleSubmit;
        }
        if (!inputBoxRef && mp && mp.inputBoxRef && mp.inputBoxRef.current) {
          inputBoxRef = mp.inputBoxRef.current;
        }
      }
      if (handleSubmit) {
        const scopeRes = typeof launchOpts?.scopeGuard === 'function' ? launchOpts.scopeGuard() : { ok: true };
        if (scopeRes && scopeRes.ok === false) {
          launchOpts?.onOutcome?.({ phase: 'scope_mismatch', error: scopeRes.reason || 'scope_mismatch' });
          return;
        }
        submitting = true;
        (async () => {
          let resolvedMedia = [];
          if (mediaList.length) {
            if (
              inputBoxRef &&
              typeof inputBoxRef.attachFiles === 'function' &&
              typeof inputBoxRef.getMediaAttachments === 'function'
            ) {
              try {
                if (typeof inputBoxRef.setMediaAttachments === 'function') {
                  inputBoxRef.setMediaAttachments([]);
                }
                const filesToAttach = mediaList.map((m) =>
                  typeof File === 'function' && !(m.file instanceof File)
                    ? new File([m.bytes || new Uint8Array(0)], m.name || 'pasted-image.png', {
                        type: m.mimeType || 'image/png'
                      })
                    : m.file
                );
                await inputBoxRef.attachFiles(filesToAttach);
                const deadline = Date.now() + 1500;
                while (Date.now() < deadline) {
                  const curAtt = inputBoxRef.getMediaAttachments() || [];
                  if (curAtt.length >= filesToAttach.length && curAtt.every((a) => Boolean(a && a.uri))) {
                    break;
                  }
                  await new Promise((r) => setTimeout(r, 40));
                }
                resolvedMedia = (inputBoxRef.getMediaAttachments() || []).slice();
              } catch {}
            }
            if (!resolvedMedia.length) {
              resolvedMedia = buildFallbackMediaObjects(mediaList);
            }
          }
          const clearEditor = () => {
            if (inputBoxRef && typeof inputBoxRef.setMediaAttachments === 'function') {
              try {
                inputBoxRef.setMediaAttachments([]);
                if (typeof inputBoxRef.forgetTrackedUploads === 'function') {
                  inputBoxRef.forgetTrackedUploads();
                }
              } catch {}
            }
          };
          try {
            await handleSubmit(submitChunks, resolvedMedia, clearEditor);
            launchOpts?.onOutcome?.({ phase: 'submitted' });
          } catch (err) {
            restoreComposerDraftOnFailure();
            launchOpts?.onOutcome?.({ phase: 'submit_threw', error: String(err?.message || err || 'submit_failed') });
          } finally {
            if (mediaList.length) clearEditor();
          }
        })();
        return;
      }
      if (++tries < 35) later(trySubmit, 70);
      else {
        restoreComposerDraftOnFailure();
        launchOpts?.onOutcome?.({ phase: 'nav_fail', error: 'handle_submit_unavailable' });
      }
    };
    later(trySubmit, 110);
  }

  function startNewChatInProjectById(projectId, initialPrompt = '') {
    const prompt = String(initialPrompt || '').trim();
    if (!projectId) {
      startNewChatInProject(null, prompt);
      return true;
    }
    const proj = collectNativeProjects().find((p) => p.id === projectId);
    if (!proj) return false;
    startNewChatInProject(proj, prompt);
    return true;
  }

  function syncConvProjectTopbar() {
    convTopbar.sync();
  }

  function ensureProjectsViewEl() {
    if (pState.projectsViewEl && pState.projectsViewEl.isConnected) return pState.projectsViewEl;
    const el = document.createElement('section');
    el.id = 'ag-claude-projects-view';
    el.setAttribute('data-ag-i18n-ignore', '1');
    el.setAttribute('data-open', 'false');
    el.setAttribute('aria-label', L('项目工作区', 'Projects Workspace'));
    document.body.appendChild(el);
    pState.projectsViewEl = el;
    return el;
  }

  function enterProjectWorkspace(proj) {
    if (!proj) return;
    pState.activeProjectId = proj.id;
    pState.projectChatSearchQuery = '';
    pState.pdDirtyExpanded = false;
    pState.pdExpandedCommitHash = '';
    pState.pdBreadcrumbMenuOpen = false;
    pState.projectSelectedFolderPath = '';
    renderProjectsView();
    worktreeUi.warmConvWorktreeMap(false);
    if (proj.dirPath) {
      worktreeUi.warmRepoWorktrees(proj.dirPath, { includeStats: true });
      fetchProjectWorkspaceStatus(proj.dirPath);
      suggestionsUi.loadProjectSuggestions(proj, { force: false });
    }
    if (proj.dirPath && typeof window.__agProjectCall === 'function') {
      const prevSig = JSON.stringify(pState.projectsContextMap[proj.dirPath] || null);
      window.__agProjectCall('readContext', { dirPath: proj.dirPath }, 8000).then((fresh) => {
        if (!rtState.disposed && fresh && fresh.ok) {
          pState.projectsContextMap[proj.dirPath] = fresh;
          if (rtState.projectsViewOpen && pState.activeProjectId === proj.id && JSON.stringify(fresh) !== prevSig) {
            renderProjectsView();
          }
        }
      });
    }
  }

  function renderProjectDetailView(el, project, allProjects = []) {
    const hasLocalDir = Boolean(project.dirPath);
    const ctx = hasLocalDir ? pState.projectsContextMap[project.dirPath] : null;
    const activeWtPath = hasLocalDir ? (pState.pdActiveWorktreeByProj[project.dirPath] || '') : '';
    const wsStatusKey = hasLocalDir ? (activeWtPath ? `${project.dirPath}::${activeWtPath}` : project.dirPath) : '';
    const wsStatus = hasLocalDir
      ? (pState.projectsWorkspaceStatusMap[wsStatusKey] || pState.projectsWorkspaceStatusMap[project.dirPath] || null)
      : null;
    const isLoadingWs = Boolean(
      hasLocalDir && (pState.projectsWorkspaceBusyDirs.has(wsStatusKey) || pState.projectsWorkspaceBusyDirs.has(project.dirPath))
    );
    const instructions = ctx && typeof ctx.instructions === 'string' ? ctx.instructions.trim() : '';
    const files = ctx && Array.isArray(ctx.files) ? ctx.files : [];
    const extraFolders = ctx && Array.isArray(ctx.extraFolders) ? ctx.extraFolders : [];
    const allFolders = hasLocalDir
      ? [
          { name: project.name, absPath: project.dirPath, primary: true },
          ...extraFolders.map((f) => ({ name: f.name || f.absPath.split(/[\\/]/).pop(), absPath: f.absPath, primary: false }))
        ]
      : [];
    const activeFolder = allFolders.length
      ? allFolders.find((f) => f.absPath === pState.projectSelectedFolderPath) || allFolders[0]
      : { name: project.name, absPath: '', primary: true };
    const folderTriggerLabel =
      extraFolders.length > 0 && activeFolder.primary
        ? FEAT.i18n
          ? `${activeFolder.name}（+${extraFolders.length} 个文件夹）`
          : `${activeFolder.name} (+${extraFolders.length})`
        : activeFolder.name;

    const modelParts = formatProjectComposerModelParts(buildReduxModelSelectorApi() || discoverModelSelectorApi());

    const chatQueryRaw = pState.projectChatSearchQuery || '';
    const chatsHtml = buildDetailChatsHtml({
      project,
      hasLocalDir,
      wsStatus,
      instructions,
      filesCount: files.length,
      chatQueryRaw,
      formatProjectTimeAgo,
    });

    const agentsFilePath = hasLocalDir ? `${String(project.dirPath).replace(/[\\/]+$/, '')}/AGENTS.md` : '';
    const instPreview = instructions ? formatInstructionsPreview(instructions) : null;
    const instBodyHtml = instPreview
      ? instPreview.html
      : `<div class="ag-pd-card-muted">${L(
          '编写项目指令，保存后直接生成或更新项目根目录下的 AGENTS.md',
          'Write project instructions — saved directly to root AGENTS.md'
        )}</div>`;

    const filesBodyHtml = buildDetailFilesHtml({ files });
    const scheduledTasks = ctx && Array.isArray(ctx.scheduledTasks) ? ctx.scheduledTasks : [];
    const scheduledBodyHtml = buildDetailScheduledHtml({ scheduledTasks });
    const folderMenuHtml = buildFolderMenuHtml({ allFolders, activeFolder });

    const prevFmSearch = el.querySelector('#ag-pd-fm-search-input');
    const hadFmFocus = prevFmSearch && document.activeElement === prevFmSearch;
    const fmSelStart = hadFmFocus ? prevFmSearch.selectionStart : null;

    const prevChatSearch = el.querySelector('#ag-pd-chat-search');
    const hadChatSearchFocus = prevChatSearch && document.activeElement === prevChatSearch;
    const chatSelStart = hadChatSearchFocus ? prevChatSearch.selectionStart : null;

    const prevComp = el.getAttribute('data-ag-pd-proj-id') === project.id ? el.querySelector('#ag-pd-composer-input') : null;
    const hadCompFocus = Boolean(prevComp && document.activeElement === prevComp);
    const compSelStart = hadCompFocus ? prevComp.selectionStart : null;
    const compSelEnd = hadCompFocus ? prevComp.selectionEnd : null;
    if (prevComp) {
      if (prevComp.value) pState.projectComposerDrafts.set(project.id, prevComp.value);
      else pState.projectComposerDrafts.delete(project.id);
    }
    const savedDraft = pState.projectComposerDrafts.get(project.id) || '';
    el.setAttribute('data-ag-pd-proj-id', project.id);

    const topbarHtml = buildTopbarHtml({ project, allProjects });
    const heroHtml = buildProjectHeroHtml({
      project,
      wsStatus,
      hasLocalDir,
      shortPath: hasLocalDir ? formatShortHomePath(project.dirPath) : '',
    });
    const repoSectionHtml = buildWorkspacePulseSectionHtml({
      project,
      hasLocalDir,
      wsStatus,
      isLoading: isLoadingWs,
    });
    const aiSuggestionsState = hasLocalDir ? (pState.projectSuggestionsMap[project.dirPath] || null) : null;
    const isLoadingAi = Boolean(hasLocalDir && pState.projectSuggestionsBusyDirs.has(project.dirPath));
    const quickStripHtml = buildQuickActionsStripHtml({
      project,
      hasLocalDir,
      wsStatus,
      instructions,
      aiSuggestionsState,
      isLoadingAi,
    });
    const pdChatIds = (Array.isArray(project.chats) ? project.chats : []).map((c) => c && c.id).filter(Boolean);

    el.innerHTML = `
      ${topbarHtml}
      <div class="ag-pd-shell">
        <div class="ag-pd-columns">
          <div class="ag-pd-left">
            ${heroHtml}
            <div class="ag-pd-composer-anchor">
              <div class="ag-pd-composer-wrap">
                <div class="ag-pd-composer-box" data-ag-pd-composer-box="true">
                  <div id="ag-pd-media-strip" class="ag-pd-media-strip" style="display:none"></div>
                  <div id="ag-pd-mention-pills" class="ag-pd-mention-pills" style="display:none"></div>
                  <textarea id="ag-pd-composer-input" class="ag-pd-composer-input" rows="2" placeholder="${escapeHtml(
                    L('想在这个项目里处理什么？（输入 @ 引用，支持直接粘贴图片）', 'What would you like to work on? (Type @ to mention, paste images directly)')
                  )}">${escapeHtml(savedDraft)}</textarea>
                  <div class="ag-pd-composer-foot">
                    ${
                      hasLocalDir
                        ? `<button type="button" class="ag-pd-composer-add" data-ag-pd-composer-add="true" title="${escapeHtml(L('添加参考文件到本项目', 'Add context files to project'))}" aria-label="${escapeHtml(L('添加参考文件', 'Add files'))}">${SVG_PROJ_PLUS}</button>`
                        : '<span></span>'
                    }
                    <div class="ag-pd-composer-right">
                      <button type="button" id="ag-pd-model-btn" class="ag-pd-model-btn" data-ag-pd-model-trigger="true" aria-haspopup="menu" aria-expanded="false">
                        <span class="ag-pd-model-name">${escapeHtml(modelParts.name)}</span>
                        <span class="ag-pd-model-effort"${modelParts.effort ? '' : ' style="display:none"'}>${escapeHtml(modelParts.effort)}</span>
                        <span class="ag-pd-model-chev">${SVG_PROJ_CHEVRON}</span>
                      </button>
                      <button type="button" class="ag-pd-send-btn" data-ag-pd-send="true" aria-label="${escapeHtml(L('发送', 'Send'))}" disabled>${SVG_PROJ_SEND_ARROW}</button>
                    </div>
                  </div>
                </div>
                ${
                  hasLocalDir
                    ? `<div class="ag-pd-folder-bar">
                        <button type="button" class="ag-pd-folder-trigger" data-ag-pd-folder-toggle="true" data-open="${pState.projectFolderDropdownOpen ? 'true' : 'false'}" title="${escapeHtml(activeFolder.absPath)}">
                          <span class="ag-pd-folder-strip-icon">${SVG_CLAUDE_PROJECTS_ICON}</span>
                          <span class="ag-pd-folder-strip-path">${escapeHtml(folderTriggerLabel)}</span>
                          <span class="ag-pd-folder-chevron">${SVG_PROJ_CHEVRON}</span>
                        </button>
                      </div>`
                    : `<div class="ag-pd-folder-bar">
                        <span class="ag-pd-virtual-note">${SVG_CLAUDE_PROJECTS_ICON}<span>${
                          project.isCliProject
                            ? L('终端 CLI 会话分组（未绑定本地文件夹）', 'CLI session container (no local folder)')
                            : L('未绑定本地文件夹', 'No local folder linked')
                        }</span></span>
                      </div>`
                }
              </div>
              ${hasLocalDir ? folderMenuHtml : ''}
              <div id="ag-pd-mention-popover" class="ag-pd-mention-popover" role="listbox" data-open="false"></div>
            </div>

            ${quickStripHtml}

            <div class="ag-pd-recents">
              ${buildRecentsHeaderHtml({ totalCount: project.chats.length, query: chatQueryRaw })}
              <div class="ag-pd-chat-list">${chatsHtml}</div>
            </div>
          </div>

          <aside class="ag-pd-right">
            <div class="ag-pd-sidecard">
              <div class="ag-pd-section"${hasLocalDir ? ' data-ag-pd-inst-sec="true"' : ''}>
                <div class="ag-pd-sec-hdr">
                  <span class="ag-pd-sec-title">${L('项目指令', 'Instructions')} <span class="ag-pd-sec-file-tag"${agentsFilePath ? ` title="${escapeHtml(agentsFilePath)}"` : ''}>AGENTS.md</span>${
                    instPreview ? `<span class="ag-pd-sec-file-tag">${instPreview.lineCount} ${L('行', 'L')}</span>` : ''
                  }</span>
                  ${
                    hasLocalDir
                      ? `<button type="button" class="ag-pd-sec-btn" data-ag-pd-edit-inst="true" aria-label="${escapeHtml(L('编辑 AGENTS.md', 'Edit AGENTS.md'))}">${
                          instructions ? SVG_PROJ_EDIT : SVG_PROJ_PLUS
                        }</button>`
                      : ''
                  }
                </div>
                ${
                  hasLocalDir
                    ? instBodyHtml
                    : `<div class="ag-pd-card-muted">${L('该分组无对应本地文件夹，暂不支持写入项目级 AGENTS.md。', 'Virtual container without a local folder.')}</div>`
                }
              </div>

              ${repoSectionHtml}

              <div class="ag-pd-section${hasLocalDir ? ' ag-pd-drop-sec' : ''}"${hasLocalDir ? ' data-ag-pd-ctx-drop="true"' : ''}>
                <div class="ag-pd-sec-hdr">
                  <span class="ag-pd-sec-title">${L('参考文件', 'Context')}</span>
                  ${
                    hasLocalDir
                      ? `<button type="button" class="ag-pd-sec-btn" data-ag-pd-add-files="true" aria-label="${escapeHtml(L('添加参考文件', 'Add context files'))}">${SVG_PROJ_PLUS}</button>`
                      : ''
                  }
                </div>
                ${
                  hasLocalDir
                    ? filesBodyHtml
                    : `<div class="ag-pd-card-muted">${L('仅绑定本地文件夹的项目支持添加参考文件。', 'Available for projects linked to a local folder.')}</div>`
                }
              </div>

              <div class="ag-pd-section" data-ag-pd-sched-sec="true">
                <div class="ag-pd-sec-hdr">
                  <span class="ag-pd-sec-title">${L('定时任务', 'Scheduled')}</span>
                  ${
                    hasLocalDir
                      ? `<button type="button" class="ag-pd-sec-btn" data-ag-pd-add-sched="true" aria-label="${escapeHtml(L('创建定时任务', 'Create scheduled task'))}">${SVG_PROJ_PLUS}</button>`
                      : ''
                  }
                </div>
                ${
                  hasLocalDir
                    ? scheduledBodyHtml
                    : `<div class="ag-pd-card-muted">${L('仅绑定本地文件夹的项目支持创建项目定时任务。', 'Available for projects linked to a local folder.')}</div>`
                }
              </div>
            </div>
            <div id="agy-pd-usage-slot" data-maga-own="1" data-ag-pd-proj-id="${escapeHtml(project.id)}" data-ag-pd-chat-ids="${escapeHtml(pdChatIds.join(','))}"></div>
          </aside>
        </div>
      </div>
    `;

    const backBtn = el.querySelector('[data-ag-pd-back]');
    if (backBtn) {
      backBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeProjectActionMenu();
        closePdMentionMenu();
        pState.activeProjectId = null;
        pState.projectChatSearchQuery = '';
        pState.projectFolderDropdownOpen = false;
        pState.projectFolderSearch = '';
        pState.projectSelectedFolderPath = '';
        pState.pdDirtyExpanded = false;
        pState.pdExpandedCommitHash = '';
        pState.pdBreadcrumbMenuOpen = false;
        renderProjectsView();
      });
    }

    bindProjectWorkspaceEvents({
      el,
      project,
      hadChatSearchFocus,
      chatSelStart,
      onSwitchProject: (nextId) => {
        const nextProj = (allProjects || []).find((p) => p.id === nextId);
        if (nextProj) enterProjectWorkspace(nextProj);
      },
    });

    const pdTitleRow = el.querySelector('.ag-pd-title-row');
    if (pdTitleRow && !project.isBuiltin) {
      pdTitleRow.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openProjectActionMenu(project, e.clientX, e.clientY);
      });
    }

    const pdMoreBtn = el.querySelector('[data-ag-pd-proj-menu]');
    if (pdMoreBtn && !project.isBuiltin) {
      pdMoreBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = pdMoreBtn.getBoundingClientRect();
        openProjectActionMenu(project, Math.max(8, Math.round(r.right - 216)), Math.round(r.bottom + 6), pdMoreBtn);
      });
    }

    const folderToggleBtn = el.querySelector('[data-ag-pd-folder-toggle]');
    if (folderToggleBtn) {
      folderToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pState.projectFolderDropdownOpen = !pState.projectFolderDropdownOpen;
        if (!pState.projectFolderDropdownOpen) pState.projectFolderSearch = '';
        renderProjectsView();
      });
    }

    const fmSearchInput = el.querySelector('#ag-pd-fm-search-input');
    if (fmSearchInput) {
      if (hadFmFocus) {
        fmSearchInput.focus();
        if (typeof fmSelStart === 'number') {
          try {
            fmSearchInput.setSelectionRange(fmSelStart, fmSelStart);
          } catch {}
        }
      }
      fmSearchInput.addEventListener('input', () => {
        pState.projectFolderSearch = fmSearchInput.value || '';
        renderProjectsView();
      });
    }

    el.querySelectorAll('[data-ag-pd-select-folder]').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        pState.projectSelectedFolderPath = item.getAttribute('data-ag-pd-select-folder') || project.dirPath;
        pState.projectFolderDropdownOpen = false;
        pState.projectFolderSearch = '';
        renderProjectsView();
      });
    });

    el.querySelectorAll('[data-ag-pd-add-folder]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        pickAndAddFolderToProject(project);
      });
    });

    el.querySelectorAll('[data-ag-pd-rm-folder]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        removeExtraFolderFromProject(project, b.getAttribute('data-ag-pd-rm-folder'));
      });
    });

    const compAddBtn = el.querySelector('[data-ag-pd-composer-add]');
    if (compAddBtn) {
      compAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pickAndAddFilesToProject(project);
      });
    }

    const compBox = el.querySelector('[data-ag-pd-composer-box]');
    const compInput = el.querySelector('#ag-pd-composer-input');
    const sendBtn = el.querySelector('[data-ag-pd-send]');
    const dispatchPrompt = () => {
      const raw = ((compInput && compInput.value) || '').trim();
      const mediaArr = (getProjectMediaList(project.id, false) || []).slice();
      if (!raw && !mediaArr.length) return;
      const mMap = getProjectMentionMap(project.id, false);
      const mentionEntries = mMap ? [...mMap.values()] : [];
      const rollbackDraft = { raw, mentionEntries: mentionEntries.slice(), mediaArr: mediaArr.slice() };
      if (compInput) compInput.value = '';
      pState.projectComposerDrafts.delete(project.id);
      pState.projectComposerMedia.delete(project.id);
      if (mMap) mMap.clear();
      closePdMentionMenu();
      const finalPrompt =
        activeFolder && !activeFolder.primary && activeFolder.absPath
          ? raw
            ? `[${L('关联文件夹', 'Linked folder')}: ${activeFolder.absPath}]\n${raw}`
            : `[${L('关联文件夹', 'Linked folder')}: ${activeFolder.absPath}]`
          : raw;
      startNewChatInProject(project, finalPrompt, mentionEntries, mediaArr, rollbackDraft);
    };
    if (compInput && sendBtn) {
      if (compInput.value !== savedDraft) compInput.value = savedDraft;
      const syncSend = () => {
        if (compInput.value) pState.projectComposerDrafts.set(project.id, compInput.value);
        else pState.projectComposerDrafts.delete(project.id);
        const hasMedia = Boolean((getProjectMediaList(project.id, false) || []).length);
        sendBtn.disabled = !compInput.value.trim() && !hasMedia;
        syncPdMediaStrip(project, () => {
          const stillHasMedia = Boolean((getProjectMediaList(project.id, false) || []).length);
          sendBtn.disabled = !compInput.value.trim() && !stillHasMedia;
        });
        syncPdMentionPills(project, compInput);
        compInput.style.height = 'auto';
        compInput.style.height = `${Math.min(180, Math.max(48, compInput.scrollHeight))}px`;
      };
      syncSend();
      if (hadCompFocus && !hadFmFocus && !hadChatSearchFocus) {
        compInput.focus();
        if (typeof compSelStart === 'number' && typeof compSelEnd === 'number') {
          try {
            compInput.setSelectionRange(compSelStart, compSelEnd);
          } catch {}
        }
      }
      el.querySelectorAll('[data-ag-pd-starter-prompt]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const tpl = btn.getAttribute('data-ag-pd-starter-prompt') || '';
          compInput.value = tpl;
          syncSend();
          if (e.shiftKey) {
            dispatchPrompt();
            return;
          }
          compInput.focus();
          const len = compInput.value.length;
          try {
            compInput.setSelectionRange(len, len);
          } catch {}
        });
      });
      el.querySelectorAll('[data-ag-pd-ai-sugg-idx]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const idx = Number(btn.getAttribute('data-ag-pd-ai-sugg-idx'));
          const sugg = project.dirPath ? pState.projectSuggestionsMap[project.dirPath]?.suggestions?.[idx] : null;
          if (!sugg) return;
          suggestionsUi.applySuggestion({
            suggestion: sugg,
            project,
            el,
            compInput,
            syncSend,
            dispatchPrompt,
            shiftKey: Boolean(e.shiftKey),
            onRefreshStatus: (wtPath, force) => fetchProjectWorkspaceStatus(project.dirPath, { worktreePath: wtPath, force }),
          });
        });
      });
      const suggRefreshBtn = el.querySelector('[data-ag-pd-sugg-refresh]');
      if (suggRefreshBtn) {
        suggRefreshBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          suggestionsUi.loadProjectSuggestions(project, { force: true });
        });
      }
      if (pState.pdMentionState.open && pState.pdMentionState.projectId === project.id) {
        renderPdMentionPopover();
      }
      compInput.addEventListener('input', () => {
        syncSend();
        updatePdMentionMenuForInput(project, compInput);
      });
      compInput.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey) {
          if (openUrlAtTextareaCaret(compInput)) {
            e.preventDefault();
            return;
          }
        }
        updatePdMentionMenuForInput(project, compInput);
      });
      compInput.addEventListener('paste', (e) => {
        const imgs = extractComposerImageFiles(e.clipboardData);
        if (!imgs.length) return;
        e.preventDefault();
        e.stopPropagation();
        stagePdComposerImageFiles(project, imgs, syncSend);
      });
      if (compBox) {
        compBox.addEventListener('dragover', (e) => {
          const dt = e.dataTransfer;
          if (
            dt &&
            (Array.from(dt.types || []).includes('Files') || hasDroppedContextPayload(dt))
          ) {
            e.preventDefault();
            try {
              dt.dropEffect = 'copy';
            } catch {}
            compBox.setAttribute('data-drag', 'true');
          }
        });
        compBox.addEventListener('dragleave', (e) => {
          if (!compBox.contains(e.relatedTarget)) {
            compBox.removeAttribute('data-drag');
          }
        });
        compBox.addEventListener('drop', (e) => {
          compBox.removeAttribute('data-drag');
          const droppedMentions = extractDroppedContextMentions(e.dataTransfer);
          if (droppedMentions.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            appendDroppedMentionsToPdComposer(project, compInput, droppedMentions);
            return;
          }
          const imgs = extractComposerImageFiles(e.dataTransfer);
          if (!imgs.length) return;
          e.preventDefault();
          e.stopPropagation();
          stagePdComposerImageFiles(project, imgs, syncSend);
        });
      }
      compInput.addEventListener('keydown', (e) => {
        if (pState.pdMentionState.open && !e.isComposing) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            movePdMentionSelection(1);
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            movePdMentionSelection(-1);
            return;
          }
          if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
            if (pState.pdMentionState.items.length > 0) {
              e.preventDefault();
              e.stopPropagation();
              applyPdMentionSelection(pState.pdMentionState.activeIndex);
              return;
            }
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closePdMentionMenu();
            return;
          }
        }
        const hasMedia = Boolean((getProjectMediaList(project.id, false) || []).length);
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (compInput.value.trim() || hasMedia)) {
          e.preventDefault();
          dispatchPrompt();
        }
      });
      sendBtn.addEventListener('click', dispatchPrompt);
      const pdModelBtn = el.querySelector('#ag-pd-model-btn');
      if (pdModelBtn) {
        pdModelBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          togglePdModelMenu(pdModelBtn);
        });
      }
    }

    let pdLastDragEndTs = 0;
    el.querySelectorAll('[data-ag-pd-chat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (Date.now() - pdLastDragEndTs < 260) return;
        openConversationFromProject(btn.getAttribute('data-ag-pd-chat'));
      });
      btn.addEventListener('dragstart', (e) => {
        const cid = btn.getAttribute('data-ag-pd-chat');
        const title = btn.getAttribute('data-ag-pd-chat-title') || '';
        attachConversationDragTransfer(e.dataTransfer, cid, title);
        btn.setAttribute('data-dragging', 'true');
      });
      btn.addEventListener('dragend', () => {
        pdLastDragEndTs = Date.now();
        btn.removeAttribute('data-dragging');
      });
    });

    el.querySelectorAll('[data-ag-pd-drag-file]').forEach((row) => {
      row.addEventListener('dragstart', (e) => {
        if (e.target && e.target.closest && e.target.closest('[data-ag-pd-rm-file]')) {
          e.preventDefault();
          return;
        }
        const abs = row.getAttribute('data-ag-pd-drag-file');
        if (!abs) {
          e.preventDefault();
          return;
        }
        attachFileDragTransfer(e.dataTransfer, abs);
      });
    });

    const editInstBtn = el.querySelector('[data-ag-pd-edit-inst]');
    const instSec = el.querySelector('[data-ag-pd-inst-sec]');
    const openInst = () => openProjectInstructionsModal(project);
    if (editInstBtn) editInstBtn.addEventListener('click', (e) => (e.stopPropagation(), openInst()));
    if (instSec) {
      instSec.addEventListener('click', (e) => {
        if (!e.target.closest('button')) openInst();
      });
    }

    const addFilesBtn = el.querySelector('[data-ag-pd-add-files]');
    if (addFilesBtn) {
      addFilesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pickAndAddFilesToProject(project);
      });
    }

    const dropSec = el.querySelector('[data-ag-pd-ctx-drop]');
    if (dropSec) {
      dropSec.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropSec.setAttribute('data-drag', 'true');
      });
      dropSec.addEventListener('dragleave', () => dropSec.removeAttribute('data-drag'));
      dropSec.addEventListener('drop', (e) => {
        e.preventDefault();
        dropSec.removeAttribute('data-drag');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          addDroppedFilesToProject(project, e.dataTransfer.files);
        }
      });
    }

    el.querySelectorAll('[data-ag-pd-reveal-file]').forEach((b) => {
      b.addEventListener('click', () => {
        const p = b.getAttribute('data-ag-pd-reveal-file');
        if (p && typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('revealFile', { dirPath: project.dirPath, targetPath: p }, 5000);
        }
      });
    });

    el.querySelectorAll('[data-ag-pd-rm-file]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFileFromProject(project, b.getAttribute('data-ag-pd-rm-file'));
      });
    });

    const addSchedBtn = el.querySelector('[data-ag-pd-add-sched]');
    if (addSchedBtn) {
      addSchedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openProjectScheduledModal(project, null);
      });
    }

    const schedById = new Map(scheduledTasks.map((t) => [t.id, t]));
    el.querySelectorAll('[data-ag-pd-edit-sched]').forEach((b) => {
      b.addEventListener('click', () => {
        const task = schedById.get(b.getAttribute('data-ag-pd-edit-sched'));
        if (task) openProjectScheduledModal(project, task);
      });
    });

    el.querySelectorAll('[data-ag-pd-run-sched]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const task = schedById.get(b.getAttribute('data-ag-pd-run-sched'));
        if (task) runProjectScheduledTask(project, task);
      });
    });

    el.querySelectorAll('[data-ag-pd-del-sched]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const task = schedById.get(b.getAttribute('data-ag-pd-del-sched'));
        if (!task) return;
        if (b.getAttribute('data-confirm') !== '1') {
          b.setAttribute('data-confirm', '1');
          b.textContent = task.externalSidecar ? L('确认删官方任务?', 'Delete native?') : L('确认?', 'Confirm?');
          b.style.width = 'auto';
          b.style.padding = '0 6px';
          b.style.fontSize = '11px';
          later(() => {
            if (b.isConnected && b.getAttribute('data-confirm') === '1') {
              b.removeAttribute('data-confirm');
              b.textContent = '×';
              b.style.width = '';
              b.style.padding = '';
              b.style.fontSize = '';
            }
          }, 3500);
          return;
        }
        b.disabled = true;
        const res = await deleteProjectScheduledTaskFromUi(project, task);
        if (res && !res.ok && b.isConnected) {
          b.disabled = false;
          b.removeAttribute('data-confirm');
          b.textContent = '×';
          b.style.width = '';
          b.style.padding = '';
          b.style.fontSize = '';
          showProjectsFloatingNotice(
            L('删除定时任务失败：', 'Failed to delete task: ') + String(res.error || 'unknown')
          );
        }
      });
    });

    const openAutoBtn = el.querySelector('[data-ag-pd-open-automations]');
    if (openAutoBtn) {
      openAutoBtn.addEventListener('click', () => {
        closeProjectsView();
        const autoNav = document.querySelector('[data-testid="automations-button"]');
        if (autoNav) autoNav.click();
      });
    }
  }

  function renderProjectsView() {
    const el = ensureProjectsViewEl();
    const prevProjId = el.getAttribute('data-ag-pd-proj-id');
    const prevComp = prevProjId ? el.querySelector('#ag-pd-composer-input') : null;
    if (prevProjId && prevComp) {
      if (prevComp.value) pState.projectComposerDrafts.set(prevProjId, prevComp.value);
      else pState.projectComposerDrafts.delete(prevProjId);
    }
    const allProjects = collectNativeProjects();
    if (pState.activeProjectId) {
      const target = allProjects.find((p) => p.id === pState.activeProjectId);
      if (target) {
        renderProjectDetailView(el, target, allProjects);
        emitProjectsEvent('agy:projects-rendered');
        if (typeof window !== 'undefined') window.__agyMagaKernel?.markDirty?.(['composer'], false);
        return;
      }
      pState.activeProjectId = null;
    }
    el.removeAttribute('data-ag-pd-proj-id');

    const prevSearchEl = el.querySelector('#ag-proj-search-input');
    const hadSearchFocus = prevSearchEl && document.activeElement === prevSearchEl;
    const selStart = hadSearchFocus ? prevSearchEl.selectionStart : null;

    el.innerHTML = buildProjectsGridViewHtml({
      allProjects,
      FEAT,
      RECENT_MORE_SVG,
      formatProjectTimeAgo,
    });

    const searchInput = el.querySelector('#ag-proj-search-input');
    if (searchInput) {
      if (hadSearchFocus) {
        searchInput.focus();
        if (typeof selStart === 'number') {
          try {
            searchInput.setSelectionRange(selStart, selStart);
          } catch {}
        }
      }
      searchInput.addEventListener('input', () => {
        pState.projectsSearchQuery = searchInput.value || '';
        renderProjectsView();
      });
    }

    const sortBtn = el.querySelector('[data-ag-proj-sort]');
    if (sortBtn) {
      sortBtn.addEventListener('click', () => {
        pState.projectsSortMode =
          pState.projectsSortMode === 'recent'
            ? 'usage'
            : pState.projectsSortMode === 'usage'
              ? 'name'
              : 'recent';
        renderProjectsView();
      });
    }

    const newBtn = el.querySelector('[data-ag-proj-new]');
    if (newBtn) {
      newBtn.addEventListener('click', () => triggerNativeNewProject());
    }

    const byId = new Map(allProjects.map((p) => [p.id, p]));
    const enterProject = (proj) => enterProjectWorkspace(proj);

    el.querySelectorAll('.ag-proj-card').forEach((card) => {
      const proj = byId.get(card.getAttribute('data-ag-proj-id'));
      if (!proj) return;
      card.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('[data-ag-proj-menu]')) return;
        closeProjectActionMenu();
        enterProject(proj);
      });
      if (!proj.isBuiltin) {
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openProjectActionMenu(proj, e.clientX, e.clientY);
        });
        const moreBtn = card.querySelector('[data-ag-proj-menu]');
        if (moreBtn) {
          moreBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const r = moreBtn.getBoundingClientRect();
            openProjectActionMenu(proj, Math.max(8, Math.round(r.right - 216)), Math.round(r.bottom + 6), moreBtn);
          });
        }
      }
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !(e.target && e.target.closest && e.target.closest('[data-ag-proj-menu]'))) {
          e.preventDefault();
          closeProjectActionMenu();
          enterProject(proj);
        }
      });
    });
    emitProjectsEvent('agy:projects-rendered');
    if (typeof window !== 'undefined') window.__agyMagaKernel?.markDirty?.(['composer'], false);
  }


  const onProjectsUsageUpdated = (e) => {
    if (rtState.disposed) return;
    const next = e?.detail?.byProject;
    if (!next || typeof next !== 'object') return;
    Object.assign(pState.projectsUsageMap, next);
    if (rtState.projectsViewOpen && !pState.activeProjectId && pState.projectsSortMode === 'usage') {
      renderProjectsView();
    }
  };
  let projectsUsageListenerBound = false;

  function openProjectsView(targetProjectId) {
    if (!projectsUsageListenerBound) {
      projectsUsageListenerBound = true;
      window.addEventListener('agy:projects-usage-updated', onProjectsUsageUpdated);
    }
    rtState.projectsViewOpen = true;
    projectsOpenedPathname = String((window.location && window.location.pathname) || '');
    pState.activeProjectId = typeof targetProjectId === 'string' && targetProjectId ? targetProjectId : null;
    pState.projectChatSearchQuery = '';
    pState.projectSelectedFolderPath = '';
    pState.pdDirtyExpanded = false;
    pState.pdExpandedCommitHash = '';
    pState.pdBreadcrumbMenuOpen = false;
    convTopbar.teardown();
    ensureProjectsSidebarObserver();
    const el = ensureProjectsViewEl();
    positionProjectsOverlay();
    el.setAttribute('data-open', 'true');
    renderProjectsView();
    updateProjectsNavActiveVisual();
    const nativeProjects = collectNativeProjects();
    refreshProjectsContexts(nativeProjects);
    worktreeUi.warmConvWorktreeMap(false);
    if (pState.activeProjectId) {
      const target = nativeProjects.find((p) => p.id === pState.activeProjectId);
      if (target && target.dirPath) {
        worktreeUi.warmRepoWorktrees(target.dirPath, { includeStats: true });
        fetchProjectWorkspaceStatus(target.dirPath);
        suggestionsUi.loadProjectSuggestions(target, { force: false });
      }
    }
  }

  function toggleProjectsView() {
    if (rtState.projectsViewOpen && pState.activeProjectId) {
      pState.activeProjectId = null;
      pState.projectChatSearchQuery = '';
      pState.pdDirtyExpanded = false;
      pState.pdExpandedCommitHash = '';
      pState.pdBreadcrumbMenuOpen = false;
      pState.projectFolderDropdownOpen = false;
      pState.projectFolderSearch = '';
      pState.projectSelectedFolderPath = '';
      renderProjectsView();
    } else if (rtState.projectsViewOpen) {
      closeProjectsView();
    } else {
      openProjectsView();
    }
  }

  function refreshProjectsLanguageUi() {
    updateProjectsNavActiveVisual();
    convTopbar.sync();
    if (rtState.projectsViewOpen) renderProjectsView();
    if (pState.projectMenuState) renderProjectActionMenu();
    if (rtState.projectsModalState) {
      if (rtState.projectsModalState.kind === 'scheduled') renderProjectScheduledModal();
      else if (rtState.projectsModalState.kind === 'renameProject') renderRenameProjectModal();
      else renderProjectContextModal();
    }
  }

  function teardownProjectsWorkspace(opts = {}) {
    convTopbar.teardown();
    worktreeUi.teardown();
    closeProjectsView({ forceCloseAllModals: Boolean(opts.forceCloseAllModals) });
    if (projectsUsageListenerBound) {
      window.removeEventListener('agy:projects-usage-updated', onProjectsUsageUpdated);
      projectsUsageListenerBound = false;
    }
    pState.pdCommitDetailMap = {};
    pState.pdCommitBusyKey = '';
    pState.projectsUsageMap = {};
    pState.projectMgmtSvcRef = null;
    pState.cascadeRpcSvcRef = null;
    pState.projectComposerMentions.clear();
    pState.projectComposerMedia.clear();
    pState.pdMentionCache.rulesByKey.clear();
    pState.pdMentionCache.pluginsByKey.clear();
    pState.optimisticallyDeletedProjectIds.clear();
    pState.optimisticallyArchivedProjectIds.clear();
    pState.optimisticProjectNames.clear();
    pState.projectsWorkspaceBusyDirs.clear();
    pState.projectChatSearchQuery = '';
    const btn = document.getElementById('ag-claude-projects-nav-btn');
    if (btn) btn.remove();
    if (pState.projectsViewEl) {
      pState.projectsViewEl.remove();
      pState.projectsViewEl = null;
    }
    if (pState.projectsSidebarRo) {
      try {
        pState.projectsSidebarRo.disconnect();
      } catch {}
      pState.projectsSidebarRo = null;
      pState.projectsSidebarRoTarget = null;
      pState.projectsSidebarRoTrack = null;
    }
    document.documentElement?.style?.removeProperty?.('--ag-win-top-bar');
    if (pState.projectsDocListenerBound) {
      document.removeEventListener('click', onProjectsGlobalClick, true);
      document.removeEventListener('keydown', onProjectsGlobalKeyDown, true);
      window.removeEventListener('resize', positionProjectsOverlay);
      window.removeEventListener('popstate', onProjectsNavRouteChange);
      pState.projectsDocListenerBound = false;
    }
  }

  function onProjectsNavRouteChange() {
    if (rtState.projectsViewOpen) {
      const curPath = String((window.location && window.location.pathname) || '');
      const curSearch = String((window.location && window.location.search) || '');
      if (curPath !== projectsOpenedPathname || /(?:^|[?&])settingsOpen=true(?:&|$)/i.test(curSearch)) {
        closeProjectsView();
      }
    }
    convTopbar.sync();
  }

  function syncProjectsWorkspace() {
    if (!projectsUsageListenerBound) {
      projectsUsageListenerBound = true;
      window.addEventListener('agy:projects-usage-updated', onProjectsUsageUpdated);
    }
    syncSidebarHideNativeProjects();
    syncCustomizationsEnhancement();
    if (!FEAT.projects) {
      if (rtState.projectsViewOpen || pState.projectsViewEl || pState.projectsDocListenerBound || document.getElementById('ag-claude-projects-nav-btn')) {
        teardownProjectsWorkspace();
      }
      return;
    }
    syncWinTopBarCssVar();
    if (rtState.projectsViewOpen) {
      onProjectsNavRouteChange();
    }
    convTopbar.sync();
    const autoBtn = document.querySelector('[data-testid="automations-button"]');
    if (!autoBtn || !autoBtn.parentElement) return;
    let navBtn = document.getElementById('ag-claude-projects-nav-btn');
    if (!navBtn) {
      navBtn = document.createElement('button');
      navBtn.type = 'button';
      navBtn.id = 'ag-claude-projects-nav-btn';
      navBtn.setAttribute('data-testid', 'claude-projects-nav-button');
      navBtn.setAttribute('data-ag-i18n-ignore', '1');
      navBtn.className = autoBtn.className;
      navBtn.innerHTML =
        `<span class="shrink-0 flex items-center">${SVG_CLAUDE_PROJECTS_ICON}</span>` +
        `<span class="truncate ag-proj-nav-label">${L('项目', 'Projects')}</span>`;
      navBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleProjectsView();
      });
    }
    /* Keep positioned directly between Automations (`automations-button`) and Skills (`/customizations`) */
    if (navBtn.previousElementSibling !== autoBtn) {
      autoBtn.insertAdjacentElement('afterend', navBtn);
    }
    updateProjectsNavActiveVisual();
    if (!pState.projectsDocListenerBound) {
      pState.projectsDocListenerBound = true;
      document.addEventListener('click', onProjectsGlobalClick, true);
      document.addEventListener('keydown', onProjectsGlobalKeyDown, true);
      window.addEventListener('resize', positionProjectsOverlay);
      window.addEventListener('popstate', onProjectsNavRouteChange);
    }
    if (rtState.projectsViewOpen) {
      ensureProjectsSidebarObserver();
      positionProjectsOverlay();
    }
  }

  Object.assign(pHooks, {
    resolveProjectsStoreAndBindings,
    collectNativeProjects,
    decodeFileUriToPath,
    formatShortHomePath,
    formatProjectTimeAgo,
    saveProjectContextDelta,
    renderProjectsView,
    closeProjectsModal,
    showProjectsFloatingNotice,
    startNewChatInProject,
    appendDroppedMentionsToPdComposer,
    openProjectsView,
    onWorktreeMapChanged: () => {
      convTopbar.sync();
      if (rtState.projectsViewOpen) renderProjectsView();
    },
    buildCockpitWorktreeStripHtml: worktreeUi.buildCockpitWorktreeStripHtml,
    bindCockpitWorktreeEvents: worktreeUi.bindCockpitWorktreeEvents,
    getConversationBranchBadge: worktreeUi.getConversationBranchBadge,
  });

  const handoffLaunch = createHandoffLaunchHelper({ rtState, hooks: ctx.hooks, activeReactFiber, getActiveCascadeId, decodeFileUriToPath, resolveProjectsStoreAndBindings, collectNativeProjects, startNewChatInProject, openConversationFromProject });

  function dispose() {
    pState.projectComposerDrafts.clear();
    if (projectsUsageListenerBound) {
      window.removeEventListener('agy:projects-usage-updated', onProjectsUsageUpdated);
      projectsUsageListenerBound = false;
    }
    teardownProjectsWorkspace({ forceCloseAllModals: true });
    if (sharedModalEscBound) {
      document.removeEventListener('keydown', onSharedModalEscKeyDown, true);
      sharedModalEscBound = false;
    }
    const floatToast = document.getElementById('ag-projects-float-toast');
    if (floatToast) floatToast.remove();
  }

  return {
    syncProjectsWorkspace,
    teardownProjectsWorkspace,
    appendDroppedMentionsToPdComposer,
    decodeFileUriToPath,
    formatShortHomePath,
    resolveProjectsStoreAndBindings,
    collectNativeProjects,
    openConversationFromProject,
    startNewChatInProjectById,
    syncConvProjectTopbar,
    showProjectsFloatingNotice,
    openProjectInstructionsModal,
    openProjectsView,
    closeProjectsView,
    triggerNativeNewProject,
    refreshProjectsLanguageUi,
    ensureSharedModalEscBound,
    closeProjectsModal,
    getConversationBranchBadge: worktreeUi.getConversationBranchBadge,
    ...handoffLaunch,
    dispose,
  };
}
