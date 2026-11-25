/**
 * Shared state, SVG icons, and runtime/sidebar dependency adapters for Projects submodules.
 */
export function createProjectSharedContext(rt, modelApi) {
  const { FEAT, L, state: rtState, frame, later, escapeHtml, setLeafText, syncAttrTargetSet, hooks } = rt;
  const getSidebarHook = (name) => (...args) => hooks[name]?.(...args);

  const ICONS = {
    SVG_CLAUDE_PROJECTS_ICON:
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M5.25 2.75h5.5"/>' +
      '<path d="M3.75 5.25h8.5"/>' +
      '<path d="M2.6 7.75h10.8l-.68 4.8a1.4 1.4 0 0 1-1.39 1.2H4.67a1.4 1.4 0 0 1-1.39-1.2l-.68-4.8Z"/>' +
      '</svg>',
    SVG_PROJ_SEARCH_ICON:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7.2" cy="7.2" r="4.6"/><path d="M10.8 10.8l2.8 2.8"/></svg>',
    SVG_PROJ_SETTINGS:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1"/></svg>',
    SVG_PD_MENTION_FILE:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.2h5.2L12.5 5.5v8.3a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V3.2a1 1 0 0 1 1-1Z"/><path d="M9 2.2v3.4h3.4"/></svg>',
    SVG_PD_MENTION_RULE:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 2.6A1.4 1.4 0 0 1 4.6 1.2h8.2v12.2H4.6a1.4 1.4 0 0 0-1.4 1.4V2.6Z"/><path d="M3.2 13.4A1.4 1.4 0 0 1 4.6 12h8.2"/><path d="M6 4.8h4.2M6 7.4h4.2"/></svg>',
    SVG_PD_MENTION_CHAT:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H6.2L3.2 13.6V11H4a1.5 1.5 0 0 1-1.5-1.5v-6Z"/></svg>',
    SVG_PD_MENTION_PLUGIN:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.3 2.5a1.5 1.5 0 0 1 3 0v.9h2.2a1 1 0 0 1 1 1v2.2h.9a1.5 1.5 0 0 1 0 3h-.9v2.2a1 1 0 0 1-1 1H9.3v-.9a1.5 1.5 0 0 0-3 0v.9H3.5a1 1 0 0 1-1-1V9.6h.9a1.5 1.5 0 0 0 0-3h-.9V4.4a1 1 0 0 1 1-1h2.8v-.9Z"/></svg>',
    SVG_PD_MENTION_DRIVE:
      '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="#0066DA" d="M3.4 18.5l2.5 4.3c.3.5.7.9 1.2 1.1L12 15.5H2c0 .6.2 1.1.5 1.6l.9 1.4z"/><path fill="#00AC47" d="M12 7.2L7.1 15.5H2l6.9-12c.5-.3 1-.5 1.6-.5h3c.6 0 1.1.2 1.6.5L12 7.2z"/><path fill="#EA4335" d="M16.9 23.9c.5-.2.9-.6 1.2-1.1l3.4-5.9c.3-.5.5-1 .5-1.6h-10l4.9 8.6z"/><path fill="#00832D" d="M12 7.2l3.1-4.2c-.5-.3-1-.5-1.6-.5h-3c-.6 0-1.1.2-1.6.5L12 7.2z"/><path fill="#2684FC" d="M12 15.5h10l-3.1-5.4L15.8 15l-3.8.5z"/><path fill="#FFBA00" d="M22 15.5c0-.6-.2-1.1-.5-1.6L15.1 2.7c-.3-.5-.7-.9-1.2-1.1L12 7.2l4.9 8.3H22z"/></svg>',
    SVG_PROJ_CHEVRON:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.2L8 9.8l3.5-3.6"/></svg>',
    SVG_PROJ_FOLDER_ADD:
      '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.3 1.5h4.7A1.5 1.5 0 0 1 14 6v2.2M2 4.5v7A1.5 1.5 0 0 0 3.5 13H8"/><path d="M11.5 9.2v4.6M9.2 11.5h4.6"/></svg>',
    SVG_PROJ_SEND_ARROW:
      '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12.5V3.5M4 7.2L8 3.2l4 4"/></svg>',
    SVG_PROJ_FOLDER_OPEN:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.3 1.5h4.7A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z"/></svg>',
    SVG_PROJ_PLUS:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
    SVG_PROJ_EDIT:
      '<svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.2 2.4a1.4 1.4 0 0 1 2 2L5.5 12.1 2.7 13l.9-2.8 7.6-7.8Z"/></svg>',
    SVG_PROJ_GIT_BRANCH:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.2-2.2 3.2-7 3.2"/></svg>',
    SVG_PROJ_COPY:
      '<svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V3.9A1.4 1.4 0 0 0 9.1 2.5H3.9A1.4 1.4 0 0 0 2.5 3.9v5.2a1.4 1.4 0 0 0 1.4 1.4h1.6"/></svg>',
    SVG_PROJ_REFRESH:
      '<svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 7.4a5.2 5.2 0 1 0-1.1 4.1"/><path d="M13.5 3.8v3.7H9.8"/></svg>',
    SVG_PROJ_EXTERNAL:
      '<svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.2H3.8A1.3 1.3 0 0 0 2.5 4.5v7.7a1.3 1.3 0 0 0 1.3 1.3h7.7a1.3 1.3 0 0 0 1.3-1.3V9.5"/><path d="M9.5 2.5h4v4M13.3 2.7L7.5 8.5"/></svg>',
    RECENT_PIN_SVG: hooks.RECENT_PIN_SVG || '',
    RECENT_MORE_SVG: hooks.RECENT_MORE_SVG || '',
    RECENT_FOLDER_SVG: hooks.RECENT_FOLDER_SVG || '',
    RECENT_RENAME_SVG: hooks.RECENT_RENAME_SVG || '',
    RECENT_ARCHIVE_SVG: hooks.RECENT_ARCHIVE_SVG || '',
    RECENT_TRASH_SVG: hooks.RECENT_TRASH_SVG || '',
  };

  rtState.projectsViewOpen = false;
  rtState.projectsModalEl = null;
  rtState.projectsModalState = null;

  const pState = {
    activeProjectId: null,
    projectsSearchQuery: '',
    projectsSortMode: 'recent',
    projectsContextMap: {},
    projectsNativeMtimeMap: {},
    projectComposerDrafts: new Map(),
    projectComposerMentions: new Map(),
    projectComposerMedia: new Map(),
    pdMediaSeq: 0,
    cascadeRpcSvcRef: null,
    pdMentionState: {
      open: false,
      projectId: '',
      startIdx: -1,
      endIdx: -1,
      rawQuery: '',
      category: '',
      subQuery: '',
      items: [],
      activeIndex: 0,
      loading: false,
      reqSeq: 0,
    },
    pdMentionCache: {
      rulesByKey: new Map(),
      pluginsByKey: new Map(),
      hasDriveProvider: null,
    },
    projectsSidebarRo: null,
    projectsSidebarRoTarget: null,
    projectsViewEl: null,
    projectsDocListenerBound: false,
    projectsContextBusy: false,
    projectFolderDropdownOpen: false,
    projectFolderSearch: '',
    projectSelectedFolderPath: '',
    newProjectWatchCleanup: null,
    projectMgmtSvcRef: null,
    projectMenuState: null,
    projectMenuDocBound: false,
    pdModelMenuEl: null,
    pdModelMenuOpen: false,
    optimisticallyDeletedProjectIds: new Set(),
    optimisticallyArchivedProjectIds: new Map(),
    optimisticProjectNames: new Map(),
    projectsContextQueueByDir: new Map(),
    projectsWorkspaceStatusMap: {},
    projectsWorkspaceBusyDirs: new Set(),
    projectChatSearchQuery: '',
    pdDirtyExpanded: false,
    pdExpandedCommitHash: '',
    pdCommitDetailMap: {},
    pdCommitBusyKey: '',
    pdBreadcrumbMenuOpen: false,
    projectsUsageMap: {},
    repoWorktreesMap: {},
    repoWorktreesBusyKeys: new Set(),
    convWorktreeMap: {},
    convWorktreeMapFetchedAt: 0,
    convWorktreeMapInFlight: false,
    convWorktreeMapSig: '',
    pdActiveWorktreeByProj: {},
    pdWtCreateOpenByProj: {},
    pdWtConfirmRemovePath: '',
    pdWtBusyKey: '',
    projectSuggestionsMap: {},
    projectSuggestionsBusyDirs: new Set(),
  };

  const pHooks = Object.create(null);

  return {
    FEAT,
    L,
    rtState,
    frame,
    later,
    escapeHtml,
    setLeafText,
    syncAttrTargetSet,
    hooks,
    modelApi,
    ICONS,
    pState,
    pHooks,
    activeReactFiber: (...args) => hooks.activeReactFiber?.(...args),
    getActiveCascadeId: (...args) => hooks.getActiveCascadeId?.(...args) || '',
    syncSidebarHideNativeProjects: (...args) => hooks.syncSidebarHideNativeProjects?.(...args),
    syncCustomizationsEnhancement: (...args) => hooks.syncCustomizationsEnhancement?.(...args),
    teardownCustomizationsEnhancement: (...args) => hooks.teardownCustomizationsEnhancement?.(...args),
    invalidateOverviewSnapshotCache: (...args) => hooks.invalidateOverviewSnapshotCache?.(...args),
    isSidebarVisibleSummary: getSidebarHook('isSidebarVisibleSummary'),
    isSummaryPinned: getSidebarHook('isSummaryPinned'),
    protoSeconds: getSidebarHook('protoSeconds'),
    findSidebarBindings: getSidebarHook('findSidebarBindings'),
    scheduleSidebarSync: getSidebarHook('scheduleSidebarSync'),
    closeRecentRowMenu: getSidebarHook('closeRecentRowMenu'),
    navigateSidebarConversation: getSidebarHook('navigateSidebarConversation'),
    hasDroppedContextPayload: getSidebarHook('hasDroppedContextPayload'),
    extractDroppedContextMentions: getSidebarHook('extractDroppedContextMentions'),
    attachConversationDragTransfer: getSidebarHook('attachConversationDragTransfer'),
    attachFileDragTransfer: getSidebarHook('attachFileDragTransfer'),
    getSidebarListHost: getSidebarHook('getSidebarListHost'),
    syncRecentSection: getSidebarHook('syncRecentSection'),
  };
}
