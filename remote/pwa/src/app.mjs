/**
 * AGY Studio Remote Control PWA Entry (Zero-XSS, strict CSP, mobile + desktop responsive).
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import {
  autoResizeTextarea,
  compressImageFile,
  renderComposerFooterBar,
  renderMediaPreviewStrip,
} from './composer-bar.mjs';
import {
  clearDeviceIdentity,
  defaultDeviceName,
  loadDeviceIdentity,
  saveDeviceIdentity,
} from './crypto-store.mjs';
import { renderOverviewPanel } from './overview-panel.mjs';
import { createPairViewController } from './pair-view.mjs';
import {
  renderFilterChipsView,
  renderSidebarListView,
} from './sidebar-view.mjs';
import {
  renderMobileMoreMenu,
  renderOpusGateBanner,
  renderResumeBanner,
} from './studio-panel.mjs';
import {
  STORAGE_KEYS,
  createAlertManager,
  createMobileHistoryController,
  createMoreMenuController,
  createNewChatController,
  defaultOverviewCollapsed,
  formatWriteError,
  readStoredPref,
  syncTurboConfirmBar,
  writeStoredPref,
} from './mobile-enhancements.mjs';
import { renderDetailTimeline as renderTimelineView } from './timeline-view.mjs';
import {
  DESKTOP_BREAKPOINT_PX,
  UUID_RE,
  clearNode,
  copyTextWithFeedback,
  el,
  formatPresetBadge,
  isRunningStatus,
  mergeSummariesDelta,
  normalizeWsStatus,
  requiresTurboAck,
  resolveLayoutMode,
} from './ui-helpers.mjs';
import { createIdempotencyKey, createRemoteWsClient } from './ws-client.mjs';

const storedLayoutPref = readStoredPref(STORAGE_KEYS.layoutPref, 'auto');
const initialLayoutPref =
  storedLayoutPref === 'desktop' || storedLayoutPref === 'mobile' ? storedLayoutPref : 'auto';
const storedGroupBy = readStoredPref(STORAGE_KEYS.sidebarGroupBy, 'recent');
const storedOverviewCol = readStoredPref(STORAGE_KEYS.overviewCollapsed, '');

const state = {
  identity: null,
  health: null,
  pairingCode: '',
  deviceName: defaultDeviceName(),
  turboAcknowledged: false,
  pairingBusy: false,
  pairingError: '',
  showFullFingerprint: false,
  wsStatus: 'disconnected',
  wsDetail: '',
  hostAttached: false,
  source: 'cdp',
  globalPreset: null,
  capabilities: null,
  conversations: [],
  filter: 'all', // all | running | waiting
  includeSubagents: false,
  searchQuery: '',
  selectedId: null,
  snapshots: new Map(), // cascadeId -> snapshot object
  streams: new Map(), // cascadeId -> streaming text string
  snapshotLoading: false,
  snapshotError: '',
  mobileView: 'list', // list | detail
  mobileTab: 'chats', // chats | approvals | overview
  layoutPref: initialLayoutPref, // auto | desktop | mobile
  sidebarCollapsed: readStoredPref(STORAGE_KEYS.sidebarCollapsed, 'false') === 'true',
  overviewCollapsed:
    storedOverviewCol === 'true' || storedOverviewCol === 'false'
      ? storedOverviewCol === 'true'
      : defaultOverviewCollapsed(),
  sidebarGroupBy: storedGroupBy === 'project' ? 'project' : 'recent',
  draftText: '',
  draftMedia: [],
  draftIdempotencyKey: createIdempotencyKey(),
  turboWriteConfirmed: false,
  pendingApproveKeys: new Map(),
  pendingResumeKeys: new Map(),
  cancelConfirmArmedCid: '',
  studioOverview: null,
  studioDrawerOpen: false,
  moreMenuOpen: false,
  selectedProjectId: '',
  resumeState: null,
  modelCatalog: null,
  modelPopoverOpen: false,
  contextPopoverOpen: false,
  showHiddenModels: false,
  modelSelectBusy: false,
  streamStartedAt: 0,
  sendBusy: false,
  cancelBusy: false,
  resumeBusy: false,
  compactBusy: false,
  opusDismissBusy: false,
  approvingHash: '',
  actionError: '',
  actionNotice: '',
  newChatOpen: false,
  newChatBusy: false,
  newChatProjectId: '',
  newChatPrompt: '',
  newChatTurboConfirmed: false,
  newChatError: '',
};

const alertManager = createAlertManager();

let wsClient = null;
let snapshotRefreshTimer = null;
let studioOverviewSeq = 0;
let modelReqSeq = 0;
let studioOverviewRetryTimer = null;
let streamTickTimer = null;
let cancelConfirmTimer = null;
let actionNoticeTimer = null;
let swReloading = false;
let workspaceRefs = null;
let globalListenersBound = false;
const rootEl = document.getElementById('app');

function setActionNotice(msg) {
  state.actionNotice = String(msg || '');
  if (actionNoticeTimer) {
    clearTimeout(actionNoticeTimer);
    actionNoticeTimer = null;
  }
  if (state.actionNotice) {
    actionNoticeTimer = setTimeout(() => {
      actionNoticeTimer = null;
      if (state.actionNotice && state.identity && workspaceRefs) {
        state.actionNotice = '';
        syncComposerControls();
      }
    }, 3400);
  }
}

function clearStreamTickTimer() {
  if (streamTickTimer) {
    clearInterval(streamTickTimer);
    streamTickTimer = null;
  }
}

function syncStreamTimer(isStreaming) {
  if (isStreaming) {
    if (!state.streamStartedAt) state.streamStartedAt = Date.now();
    if (!streamTickTimer) {
      streamTickTimer = setInterval(() => {
        if (!state.identity || !workspaceRefs) {
          clearStreamTickTimer();
          return;
        }
        syncComposerControls();
      }, 1000);
    }
  } else {
    state.streamStartedAt = 0;
    clearStreamTickTimer();
  }
}

function clearStudioOverviewRetry() {
  if (studioOverviewRetryTimer) {
    clearTimeout(studioOverviewRetryTimer);
    studioOverviewRetryTimer = null;
  }
}

function getResolvedLayoutMode() {
  const w = typeof window !== 'undefined' ? window.innerWidth : DESKTOP_BREAKPOINT_PX;
  return resolveLayoutMode(state.layoutPref, w);
}

function layoutButtonLabel(pref) {
  if (pref === 'desktop') return '视图: 桌面';
  if (pref === 'mobile') return '视图: 移动';
  return '视图: 自动';
}

function applyLayoutAttrs() {
  if (!rootEl) return;
  const resolvedMode = getResolvedLayoutMode();
  rootEl.setAttribute('data-layout-mode', resolvedMode);
  rootEl.setAttribute('data-mobile-view', state.mobileView);
  rootEl.setAttribute('data-mobile-tab', state.mobileTab);
  rootEl.setAttribute('data-sidebar-collapsed', state.sidebarCollapsed ? 'true' : 'false');
  rootEl.setAttribute('data-overview-collapsed', state.overviewCollapsed ? 'true' : 'false');

  if (workspaceRefs && rootEl.contains(workspaceRefs.topbar)) {
    workspaceRefs.layoutModeBtn.textContent = layoutButtonLabel(state.layoutPref);
    workspaceRefs.sidebarToggleBtn.setAttribute('aria-pressed', state.sidebarCollapsed ? 'false' : 'true');
    workspaceRefs.overviewToggleBtn.setAttribute('aria-pressed', state.overviewCollapsed ? 'false' : 'true');
    workspaceRefs.navChatsBtn.setAttribute('aria-pressed', state.mobileTab === 'chats' ? 'true' : 'false');
    workspaceRefs.navApprovalsBtn.setAttribute('aria-pressed', state.mobileTab === 'approvals' ? 'true' : 'false');
    workspaceRefs.navOverviewBtn.setAttribute('aria-pressed', state.mobileTab === 'overview' ? 'true' : 'false');
    workspaceRefs.draftInput.placeholder =
      resolvedMode === 'mobile'
        ? '输入指令…'
        : '输入指令继续当前会话（Ctrl/Cmd + Enter 发送，可 Ctrl/Cmd+V 粘贴截图）…';
    workspaceRefs.searchInput.placeholder =
      resolvedMode === 'mobile' ? '搜索会话 / ID…' : '搜索会话 (⌘K) / ID…';
    renderMoreMenu();
  }
}

function ensureGlobalUiListeners() {
  if (globalListenersBound || typeof window === 'undefined') return;
  globalListenersBound = true;
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = window.requestAnimationFrame(() => {
      resizeRaf = 0;
      applyLayoutAttrs();
    });
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && (state.modelPopoverOpen || state.contextPopoverOpen || state.moreMenuOpen || state.newChatOpen)) {
      state.modelPopoverOpen = false;
      state.contextPopoverOpen = false;
      state.moreMenuOpen = false;
      if (!state.newChatBusy) state.newChatOpen = false;
      renderMoreMenu();
      renderNewChatOverlay();
      syncComposerControls();
      return;
    }
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
    if (!state.identity || !workspaceRefs || !rootEl?.contains(workspaceRefs.topbar)) return;
    const key = String(ev.key || '').toLowerCase();
    if (key === 'k') {
      ev.preventDefault();
      if (getResolvedLayoutMode() === 'desktop' && state.sidebarCollapsed) {
        state.sidebarCollapsed = false;
        writeStoredPref(STORAGE_KEYS.sidebarCollapsed, 'false');
        applyLayoutAttrs();
      } else if (getResolvedLayoutMode() === 'mobile') {
        state.mobileTab = 'chats';
        state.mobileView = 'list';
        applyLayoutAttrs();
        renderSidebarList();
      }
      workspaceRefs.searchInput?.focus();
    } else if (key === 'b' && !ev.shiftKey) {
      if (getResolvedLayoutMode() !== 'desktop') return;
      ev.preventDefault();
      state.sidebarCollapsed = !state.sidebarCollapsed;
      writeStoredPref(STORAGE_KEYS.sidebarCollapsed, state.sidebarCollapsed ? 'true' : 'false');
      applyLayoutAttrs();
    }
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (ev) => {
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      if (state.moreMenuOpen && workspaceRefs?.moreMenu) {
        const insideMenu =
          path.includes(workspaceRefs.moreMenu) || workspaceRefs.moreMenu.contains(ev.target);
        if (!insideMenu) {
          state.moreMenuOpen = false;
          renderMoreMenu();
        }
      }
      if ((!state.modelPopoverOpen && !state.contextPopoverOpen) || !workspaceRefs?.composerCard) return;
      if (path.includes(workspaceRefs.composerCard) || workspaceRefs.composerCard.contains(ev.target)) {
        return;
      }
      state.modelPopoverOpen = false;
      state.contextPopoverOpen = false;
      syncComposerControls();
    });
  }
}

function updateGlobalPreset(nextPreset) {
  if (nextPreset === undefined) return;
  if (nextPreset !== state.globalPreset) {
    state.globalPreset = nextPreset;
    state.turboWriteConfirmed = false;
  }
}

function resetCancelConfirm() {
  state.cancelConfirmArmedCid = '';
  if (cancelConfirmTimer) {
    clearTimeout(cancelConfirmTimer);
    cancelConfirmTimer = null;
  }
}

const pairView = createPairViewController({
  state,
  rootEl,
  render,
  onPaired: () => startWorkspaceSession(),
});

async function handleUnpairDevice() {
  state.moreMenuOpen = false;
  if (wsClient) {
    wsClient.dispose();
    wsClient = null;
  }
  await clearDeviceIdentity().catch(() => {});
  state.identity = null;
  state.conversations = [];
  state.snapshots.clear();
  state.streams.clear();
  state.selectedId = null;
  state.mobileView = 'list';
  state.mobileTab = 'chats';
  state.turboAcknowledged = false;
  state.turboWriteConfirmed = false;
  state.draftMedia = [];
  state.draftIdempotencyKey = createIdempotencyKey();
  state.pendingApproveKeys.clear();
  state.pendingResumeKeys.clear();
  state.studioOverview = null;
  state.studioDrawerOpen = false;
  state.selectedProjectId = '';
  state.resumeState = null;
  state.modelCatalog = null;
  state.modelPopoverOpen = false;
  state.contextPopoverOpen = false;
  state.newChatOpen = false;
  state.newChatBusy = false;
  state.newChatTurboConfirmed = false;
  alertManager.reset();
  state.showHiddenModels = false;
  state.modelSelectBusy = false;
  state.streamStartedAt = 0;
  setActionNotice('');
  clearStreamTickTimer();
  clearStudioOverviewRetry();
  resetCancelConfirm();
  workspaceRefs = null;
  pairView.loadHealthForPairing();
}

const moreMenuCtrl = createMoreMenuController({
  state,
  getMenuEl: () => workspaceRefs?.moreMenu,
  renderMenu: renderMobileMoreMenu,
  formatPresetBadge,
  layoutButtonLabel,
  alertManager,
  setActionNotice,
  writeLayoutPref: (v) => writeStoredPref(STORAGE_KEYS.layoutPref, v),
  applyLayoutAttrs,
  renderSidebarList,
  renderStudioPanels,
  refreshAllData,
  handleUnpairDevice,
});
const renderMoreMenu = () => moreMenuCtrl.render();

function ensureWorkspaceShell() {
  if (workspaceRefs && rootEl.contains(workspaceRefs.topbar)) {
    return workspaceRefs;
  }
  clearNode(rootEl);

  const brandDot = el('span', { className: 'rc-brand-dot' });
  const wsPill = el('span', { className: 'rc-pill' });
  const hostPill = el('span', { className: 'rc-pill rc-desktop-only' });
  const presetPill = el('span', { className: 'rc-pill rc-desktop-only' });
  const devicePill = el('span', { className: 'rc-pill rc-desktop-only' });

  const sidebarToggleBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-ghost rc-desktop-only',
    title: '折叠或展开会话栏 (Cmd/Ctrl+B)',
    text: '☰',
    onClick: () => {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      writeStoredPref(STORAGE_KEYS.sidebarCollapsed, state.sidebarCollapsed ? 'true' : 'false');
      applyLayoutAttrs();
    },
  });

  const layoutModeBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm rc-desktop-only',
    title: '切换桌面 / 移动视图适配模式',
    text: layoutButtonLabel(state.layoutPref),
    onClick: () => {
      const order = ['auto', 'desktop', 'mobile'];
      const next = order[(order.indexOf(state.layoutPref) + 1) % order.length];
      state.layoutPref = next;
      writeStoredPref(STORAGE_KEYS.layoutPref, next);
      applyLayoutAttrs();
      renderSidebarList();
    },
  });

  const overviewToggleBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm rc-desktop-only',
    title: '折叠或展开右侧 Overview 面板',
    text: '概览',
    onClick: () => {
      state.overviewCollapsed = !state.overviewCollapsed;
      writeStoredPref(STORAGE_KEYS.overviewCollapsed, state.overviewCollapsed ? 'true' : 'false');
      applyLayoutAttrs();
    },
  });

  const refreshBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm rc-desktop-only',
    text: '刷新',
    onClick: () => refreshAllData(),
  });

  const unpairBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-danger rc-desktop-only',
    text: '重配对',
    onClick: () => handleUnpairDevice(),
  });

  const toggleMoreMenu = (ev) => {
    ev?.stopPropagation?.();
    state.moreMenuOpen = !state.moreMenuOpen;
    if (state.moreMenuOpen && (state.modelPopoverOpen || state.contextPopoverOpen)) {
      state.modelPopoverOpen = false;
      state.contextPopoverOpen = false;
      syncComposerControls();
    }
    renderMoreMenu();
  };

  const mobileRefreshBtn = el('button', {
    type: 'button',
    className: 'rc-icon-btn rc-mobile-only',
    'aria-label': '刷新',
    title: '刷新',
    text: '↻',
    onClick: () => refreshAllData(),
  });

  const mobileMoreBtn = el('button', {
    type: 'button',
    className: 'rc-icon-btn rc-mobile-only',
    'aria-label': '更多选项',
    title: '更多选项',
    text: '⋯',
    onClick: toggleMoreMenu,
  });

  const moreMenu = el('div', { className: 'rc-more-menu rc-hidden', role: 'menu' });

  const topbar = el(
    'header',
    { className: 'rc-topbar' },
    el(
      'div',
      { className: 'rc-topbar-left' },
      sidebarToggleBtn,
      brandDot,
      el('span', { className: 'rc-topbar-title', text: 'AGY Studio' }),
      wsPill,
      hostPill,
      presetPill
    ),
    el(
      'div',
      { className: 'rc-topbar-right' },
      devicePill,
      layoutModeBtn,
      refreshBtn,
      overviewToggleBtn,
      unpairBtn,
      mobileRefreshBtn,
      mobileMoreBtn
    )
  );

  const noticeBar = el('div', { className: 'rc-notice-bar rc-hidden' });
  const studioStrip = el('div', { className: 'rc-studio-strip rc-hidden' });
  const projectsDrawer = el('div', { className: 'rc-projects-drawer rc-hidden' });

  const searchInput = el('input', {
    className: 'rc-search',
    type: 'search',
    placeholder: '搜索会话 (⌘K) / ID…',
    value: state.searchQuery,
    onInput: (ev) => {
      state.searchQuery = ev.target.value;
      renderSidebarList();
    },
  });

  const newChatBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-primary rc-new-chat-btn',
    title: '新建会话',
    text: '+ 新会话',
    onClick: () => {
      state.newChatOpen = true;
      state.newChatProjectId = state.selectedProjectId || '';
      state.newChatError = '';
      state.newChatTurboConfirmed = false;
      mobileHistory.enterModal();
      renderNewChatOverlay();
    },
  });
  const searchRow = el('div', { className: 'rc-search-row' }, searchInput, newChatBtn);
  const filterRow = el('div', { className: 'rc-filter-row' });
  const groupRow = el('div', { className: 'rc-group-row' });
  const sidebarList = el('div', { className: 'rc-scroll-list' });
  const sidebarProjects = el('div', { className: 'rc-sidebar-projects rc-hidden' });
  const sidebar = el(
    'aside',
    { className: 'rc-sidebar' },
    el('div', { className: 'rc-sidebar-head' }, searchRow, filterRow, groupRow),
    sidebarList,
    sidebarProjects
  );

  const detailTitle = el('h2', { className: 'rc-detail-title', text: '请选择一个会话' });
  const detailSub = el('div', { className: 'rc-detail-sub' });
  const backBtn = el('button', {
    type: 'button',
    className: 'rc-icon-btn rc-back-btn rc-mobile-only',
    'aria-label': '返回会话列表',
    title: '返回会话列表',
    text: '‹',
    onClick: () => mobileHistory.leaveDetail(),
  });

  const detailHead = el(
    'div',
    { className: 'rc-detail-head' },
    backBtn,
    el('div', { className: 'rc-detail-title-wrap' }, detailTitle, detailSub),
    el(
      'div',
      { className: 'rc-detail-actions' },
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm rc-desktop-only',
        text: '拉取快照',
        onClick: () => {
          if (state.selectedId) fetchAndRenderSnapshot(state.selectedId);
        },
      }),
      el('button', {
        type: 'button',
        className: 'rc-icon-btn rc-mobile-only',
        'aria-label': '刷新快照',
        title: '刷新快照',
        text: '↻',
        onClick: () => {
          if (state.selectedId) fetchAndRenderSnapshot(state.selectedId);
        },
      }),
      el('button', {
        type: 'button',
        className: 'rc-icon-btn rc-mobile-only',
        'aria-label': '更多选项',
        title: '更多选项',
        text: '⋯',
        onClick: toggleMoreMenu,
      })
    )
  );

  const roleBanner = el('div', { className: 'rc-readonly-banner' });
  const roleBannerText = el('span', { text: '' });
  const roleBannerPill = el('span', { className: 'rc-pill', 'data-tone': 'info', text: 'OBSERVE' });
  roleBanner.append(roleBannerText, roleBannerPill);

  const timeline = el('div', { className: 'rc-timeline' });
  const scrollFab = el('button', {
    type: 'button',
    className: 'rc-scroll-fab rc-hidden',
    'aria-label': '回到底部',
    title: '回到底部',
    text: '↓',
    onClick: () => {
      timeline.scrollTop = timeline.scrollHeight;
      scrollFab.classList.add('rc-hidden');
    },
  });
  timeline.addEventListener('scroll', () => {
    const gap = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    if (gap > 140) {
      scrollFab.classList.remove('rc-hidden');
    } else {
      scrollFab.classList.add('rc-hidden');
    }
  });
  const timelineWrap = el('div', { className: 'rc-timeline-wrap' }, timeline, scrollFab);

  const resumeBanner = el('div', { className: 'rc-resume-card rc-hidden' });
  const opusBanner = el('div', { className: 'rc-opus-card rc-hidden' });
  const actionBanner = el('div', {
    className: 'rc-action-banner rc-hidden',
    title: '点击关闭提示',
    onClick: () => {
      state.actionError = '';
      setActionNotice('');
      syncComposerControls();
    },
  });
  const turboWriteCheckbox = el('input', {
    id: 'rc-turbo-write-ack',
    type: 'checkbox',
    checked: state.turboWriteConfirmed,
    onChange: (ev) => {
      state.turboWriteConfirmed = Boolean(ev.target.checked);
      syncComposerControls();
    },
  });
  const turboWriteText = el('span', { text: 'TURBO 自动执行确认（远程发送将直接执行本机操作）' });
  const turboWriteLabel = el(
    'label',
    { className: 'rc-turbo-inline rc-hidden', for: 'rc-turbo-write-ack' },
    turboWriteCheckbox,
    turboWriteText
  );

  const draftInput = el('textarea', {
    className: 'rc-composer-input',
    rows: '1',
    placeholder: '输入指令继续当前会话（Ctrl/Cmd + Enter 发送，可 Ctrl/Cmd+V 粘贴截图）…',
    value: state.draftText,
    onInput: (ev) => {
      state.draftText = ev.target.value;
      state.draftIdempotencyKey = createIdempotencyKey();
      state.actionError = '';
      autoResizeTextarea(ev.target);
      syncComposerControls();
    },
  });
  draftInput.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      handleSendDraft();
    }
  });
  draftInput.addEventListener('paste', (ev) => {
    const items = ev.clipboardData?.items;
    if (!items || !items.length) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file' && String(item.type || '').startsWith('image/')) {
        const f = item.getAsFile?.();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      ev.preventDefault();
      attachImageFiles(files);
    }
  });

  const mediaFileInput = el('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp,image/gif',
    multiple: 'true',
    className: 'rc-hidden',
    onChange: (ev) => {
      const files = ev.target?.files ? Array.from(ev.target.files) : [];
      if (files.length > 0) attachImageFiles(files);
      if (ev.target) ev.target.value = '';
    },
  });

  const sendBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-primary rc-send-btn',
    text: '发送',
    onClick: () => handleSendDraft(),
  });
  const cancelBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-danger rc-cancel-btn',
    text: '停止',
    onClick: () => handleCancelConvo(),
  });
  const composerRow = el('div', { className: 'rc-composer-row' }, draftInput, sendBtn, cancelBtn);
  const mediaStrip = el('div', { className: 'rc-media-strip rc-hidden' });
  const modelPopover = el('div', { className: 'rc-model-popover rc-hidden' });
  const contextPopover = el('div', { className: 'rc-ctx-popover rc-hidden' });
  const composerFooter = el('div', { className: 'rc-composer-footer' });

  const composerCard = el(
    'div',
    { className: 'rc-composer-card' },
    modelPopover,
    contextPopover,
    mediaStrip,
    turboWriteLabel,
    composerRow,
    composerFooter,
    mediaFileInput
  );
  const bottomDock = el(
    'footer',
    { className: 'rc-bottom-dock is-composer' },
    el(
      'div',
      { className: 'rc-composer-shell' },
      resumeBanner,
      opusBanner,
      actionBanner,
      composerCard
    )
  );

  const detail = el(
    'section',
    { className: 'rc-detail' },
    detailHead,
    roleBanner,
    timelineWrap,
    bottomDock
  );

  const overviewPane = el('aside', { className: 'rc-overview' });

  const switchMobileTab = (tab) => {
    state.mobileTab = tab;
    state.mobileView = 'list';
    applyLayoutAttrs();
    renderSidebarList();
    if (tab === 'overview') {
      renderStudioPanels();
    }
  };
  const navChatsBtn = el('button', {
    type: 'button',
    className: 'rc-mobile-nav-btn',
    text: '会话',
    onClick: () => switchMobileTab('chats'),
  });
  const navApprovalsBadge = el('span', { className: 'rc-nav-badge rc-hidden', text: '0' });
  const navApprovalsBtn = el(
    'button',
    {
      type: 'button',
      className: 'rc-mobile-nav-btn',
      onClick: () => switchMobileTab('approvals'),
    },
    el('span', { text: '待审批' }),
    navApprovalsBadge
  );
  const navOverviewBtn = el('button', {
    type: 'button',
    className: 'rc-mobile-nav-btn',
    text: '概览',
    onClick: () => switchMobileTab('overview'),
  });
  const mobileNav = el(
    'nav',
    { className: 'rc-mobile-nav', 'aria-label': '移动端主导航' },
    navChatsBtn,
    navApprovalsBtn,
    navOverviewBtn
  );

  const newChatModal = el('div', { className: 'rc-new-chat-host rc-hidden' });
  const main = el('main', { className: 'rc-main' }, sidebar, detail, overviewPane);
  rootEl.append(topbar, moreMenu, noticeBar, studioStrip, projectsDrawer, main, mobileNav, newChatModal);

  workspaceRefs = {
    topbar,
    moreMenu,
    sidebarToggleBtn,
    layoutModeBtn,
    overviewToggleBtn,
    brandDot,
    wsPill,
    hostPill,
    presetPill,
    devicePill,
    noticeBar,
    studioStrip,
    projectsDrawer,
    roleBanner,
    roleBannerText,
    roleBannerPill,
    resumeBanner,
    opusBanner,
    actionBanner,
    composerCard,
    modelPopover,
    contextPopover,
    mediaStrip,
    mediaFileInput,
    composerFooter,
    turboWriteLabel,
    turboWriteText,
    turboWriteCheckbox,
    composerRow,
    draftInput,
    sendBtn,
    cancelBtn,
    searchInput,
    newChatBtn,
    newChatModal,
    filterRow,
    groupRow,
    sidebarList,
    sidebarProjects,
    detailTitle,
    detailSub,
    timeline,
    scrollFab,
    overviewPane,
    mobileNav,
    navChatsBtn,
    navApprovalsBtn,
    navApprovalsBadge,
    navOverviewBtn,
  };
  applyLayoutAttrs();
  return workspaceRefs;
}

function canSteer() {
  const role = state.identity?.role || 'observe';
  return role === 'steer' || role === 'admin';
}

const newChatCtrl = createNewChatController({
  state,
  getRefs: () => workspaceRefs,
  getWsClient: () => wsClient,
  canSteer,
  isTurboPreset: requiresTurboAck,
  createIdempotencyKey,
  uuidRe: UUID_RE,
  setActionNotice,
  selectConversation,
  refreshAllData,
  onRequestClose: () => mobileHistory.leaveModal(),
});
const renderNewChatOverlay = () => newChatCtrl.render();
const mobileHistory = createMobileHistoryController({
  state,
  getLayoutMode: getResolvedLayoutMode,
  onNavigateToList: () => {
    state.mobileView = 'list';
    state.moreMenuOpen = state.modelPopoverOpen = state.contextPopoverOpen = false;
    renderMoreMenu();
    applyLayoutAttrs();
    syncComposerControls();
  },
  onNavigateToDetail: (cid) => {
    if (cid && UUID_RE.test(cid)) selectConversation(cid, { skipHistoryPush: true });
  },
  onCloseOverlays: () => {
    state.moreMenuOpen = state.modelPopoverOpen = state.contextPopoverOpen = false;
    renderMoreMenu();
    syncComposerControls();
  },
  onCloseModal: () => {
    if (state.newChatBusy) return;
    state.newChatOpen = false;
    state.newChatError = '';
    renderNewChatOverlay();
  },
});

async function attachImageFiles(files) {
  if (!canSteer()) return;
  const list = Array.isArray(files) ? files : [];
  for (const file of list) {
    if (state.draftMedia.length >= 4) {
      state.actionError = '单次最多附带 4 张图片';
      break;
    }
    try {
      const processed = await compressImageFile(file);
      state.draftMedia = state.draftMedia.concat(processed);
      state.draftIdempotencyKey = createIdempotencyKey();
      state.actionError = '';
    } catch (err) {
      state.actionError = formatWriteError(err);
    }
  }
  syncComposerControls();
}

function refreshModels(cascadeId = state.selectedId) {
  if (!wsClient) return;
  const seq = ++modelReqSeq;
  const reqCid = cascadeId || '';
  wsClient
    .fetchModels(reqCid)
    .then((res) => {
      if (!res?.ok || !wsClient || seq !== modelReqSeq) return;
      if (reqCid && state.selectedId !== reqCid) return;
      state.modelCatalog = res;
      if (state.identity) syncComposerControls();
    })
    .catch(() => {});
}

async function handleSelectModelOption(opt) {
  if (!wsClient || !canSteer() || state.modelSelectBusy || !opt) return;
  state.modelSelectBusy = true;
  state.modelPopoverOpen = false;
  state.actionError = '';
  state.actionNotice = '';
  syncComposerControls();
  try {
    const res = await wsClient.selectModel({
      cascadeId: state.selectedId || '',
      model: opt.model,
      plannerModel: opt.plannerModel ?? null,
      customLabel: opt.customLabel || '',
    });
    if (res?.catalog) {
      state.modelCatalog = res.catalog;
    } else if (res?.selected && state.modelCatalog) {
      state.modelCatalog = { ...state.modelCatalog, selected: res.selected };
    }
    state.actionNotice = '';
    setActionNotice(res?.selected?.label ? `已切换为 ${res.selected.label}` : '模型已切换');
  } catch (err) {
    state.actionError = formatWriteError(err);
  } finally {
    state.modelSelectBusy = false;
    syncComposerControls();
  }
}

function getEffectiveResumeState(cid) {
  if (!cid) return null;
  const snap = state.snapshots.get(cid);
  const direct = state.resumeState && state.resumeState.cascadeId === cid ? state.resumeState : null;
  const rs = direct || snap?.resumeState || null;
  if (!rs || rs.interrupted !== true || rs.active === true) return null;
  const convo = state.conversations.find((c) => c.id === cid);
  const statusStr = String(snap?.status ?? convo?.status ?? '');
  if (/RUNNING|BUSY|CANCEL|WAIT/i.test(statusStr)) return null;
  if ((snap?.waitingSteps?.length || 0) > 0 || (convo?.waitingSteps?.length || 0) > 0) return null;
  return rs;
}

function renderSidebarProjectsBar() {
  const refs = ensureWorkspaceShell();
  clearNode(refs.sidebarProjects);
  const projects = Array.isArray(state.studioOverview?.projects) ? state.studioOverview.projects : [];
  if (projects.length === 0) {
    refs.sidebarProjects.classList.add('rc-hidden');
    return;
  }
  refs.sidebarProjects.classList.remove('rc-hidden');
  refs.sidebarProjects.appendChild(
    el('button', {
      type: 'button',
      className: 'rc-chip',
      'aria-pressed': !state.selectedProjectId ? 'true' : 'false',
      text: '全部项目',
      onClick: () => {
        state.selectedProjectId = '';
        renderStudioPanels();
        renderSidebarList();
      },
    })
  );
  for (const proj of projects) {
    const active = state.selectedProjectId === proj.id;
    refs.sidebarProjects.appendChild(
      el('button', {
        type: 'button',
        className: 'rc-chip',
        'aria-pressed': active ? 'true' : 'false',
        text: proj.name || 'Project',
        onClick: () => {
          state.selectedProjectId = active ? '' : proj.id;
          renderStudioPanels();
          renderSidebarList();
        },
      })
    );
  }
}

function renderStudioPanels() {
  const refs = ensureWorkspaceShell();
  const selectedConvo =
    state.selectedId ? state.conversations.find((c) => c.id === state.selectedId) || null : null;
  const snapshot = state.selectedId ? state.snapshots.get(state.selectedId) || null : null;
  renderOverviewPanel(refs.overviewPane, {
    overview: state.studioOverview,
    selectedConvo,
    snapshot,
    wsStatus: state.wsStatus,
    hostAttached: state.hostAttached,
    globalPreset: state.globalPreset,
    deviceName: state.identity?.deviceName || '',
    role: state.identity?.role || 'observe',
    selectedProjectId: state.selectedProjectId,
    onSelectProject: (nextPid) => {
      state.selectedProjectId = nextPid || '';
      renderStudioPanels();
      renderSidebarList();
    },
    onCopyId: (cid, btn) => copyTextWithFeedback(btn, cid, { idleText: '复制 ID', doneText: '已复制' }),
  });
  renderSidebarProjectsBar();
}

function syncComposerControls() {
  const refs = ensureWorkspaceShell();
  const writable = canSteer();
  const online = Boolean(state.hostAttached && state.wsStatus === 'connected');
  const hasSelection = Boolean(state.selectedId);
  const needTurboConfirm = requiresTurboAck(state.globalPreset);

  refs.composerCard.setAttribute('data-writable', writable ? 'true' : 'false');
  refs.composerCard.setAttribute('data-has-selection', hasSelection ? 'true' : 'false');
  refs.roleBanner.setAttribute('data-writable', writable ? 'true' : 'false');
  if (writable) {
    refs.roleBannerText.textContent = '受控远程操控模式：支持远程发送消息、停止当前任务与仅本次 (Allow Once) / 拒绝审批。';
    refs.roleBannerPill.setAttribute('data-tone', 'ok');
    refs.roleBannerPill.textContent = String(state.identity?.role || 'steer').toUpperCase();
    refs.composerRow.classList.remove('rc-hidden');
  } else {
    refs.roleBannerText.textContent = '只读观察模式 (observe)：如需远程发送、停止或审批，请在 Mac 桌面端「AGY Studio 设置 → 远程控制」将此设备一键升为协作 (steer) 或重新配对。';
    refs.roleBannerPill.setAttribute('data-tone', 'info');
    refs.roleBannerPill.textContent = 'READ-ONLY';
    refs.composerRow.classList.add('rc-hidden');
  }

  syncTurboConfirmBar(refs.turboWriteLabel, refs.turboWriteCheckbox, refs.turboWriteText, {
    writable,
    needTurboConfirm,
    confirmed: state.turboWriteConfirmed,
    busy: state.sendBusy || state.resumeBusy,
  });
  if (refs.newChatBtn) {
    refs.newChatBtn.classList.toggle('rc-hidden', !writable);
    refs.newChatBtn.disabled = !online || state.newChatBusy;
  }
  renderNewChatOverlay();

  renderResumeBanner(refs.resumeBanner, {
    resumeState: getEffectiveResumeState(state.selectedId),
    canWrite: writable,
    online,
    needTurboConfirm,
    turboConfirmed: state.turboWriteConfirmed,
    busy: state.resumeBusy,
    onResume: handleResumeConvo,
  });

  const activeOpusGate =
    state.selectedId && state.studioOverview?.activeCascade?.cascadeId === state.selectedId
      ? state.studioOverview.activeCascade.opusGate
      : null;
  renderOpusGateBanner(refs.opusBanner, {
    opusGate: activeOpusGate,
    canWrite: writable,
    busy: state.opusDismissBusy,
    onDismiss: handleDismissOpus,
  });

  renderMediaPreviewStrip(refs.mediaStrip, state.draftMedia, {
    disabled: state.sendBusy,
    onRemove: (imgId) => {
      state.draftMedia = state.draftMedia.filter((m) => m.id !== imgId);
      state.draftIdempotencyKey = createIdempotencyKey();
      syncComposerControls();
    },
  });

  if (refs.draftInput.value !== state.draftText) {
    refs.draftInput.value = state.draftText;
  }
  autoResizeTextarea(refs.draftInput);
  refs.draftInput.disabled = !writable || !online || !hasSelection || state.sendBusy;
  refs.sendBtn.textContent = state.sendBusy ? '发送中…' : '发送';
  const hasDraftPayload = Boolean(state.draftText.trim()) || state.draftMedia.length > 0;
  refs.sendBtn.disabled =
    !writable ||
    !online ||
    !hasSelection ||
    state.sendBusy ||
    !hasDraftPayload ||
    (needTurboConfirm && !state.turboWriteConfirmed);
  if (state.cancelBusy) {
    refs.cancelBtn.textContent = '停止中…';
  } else if (state.cancelConfirmArmedCid && state.cancelConfirmArmedCid === state.selectedId) {
    refs.cancelBtn.textContent = '确认停止？';
  } else {
    refs.cancelBtn.textContent = '停止';
  }
  refs.cancelBtn.disabled = !writable || !online || !hasSelection || state.cancelBusy;

  const activeConvo = hasSelection ? state.conversations.find((c) => c.id === state.selectedId) || null : null;
  const activeSnap = hasSelection ? state.snapshots.get(state.selectedId) || null : null;
  const streamEntry = hasSelection ? state.streams.get(state.selectedId) || null : null;
  const streamText = typeof streamEntry === 'string' ? streamEntry : streamEntry?.text ?? '';
  const isStreaming = Boolean(
    hasSelection &&
      (isRunningStatus(activeSnap?.status ?? activeConvo?.status) ||
        (typeof streamEntry === 'object' && streamEntry && isRunningStatus(streamEntry.status)))
  );
  const showCancelControl = Boolean(
    isStreaming || state.cancelBusy || (state.cancelConfirmArmedCid && state.cancelConfirmArmedCid === state.selectedId)
  );
  refs.composerCard.setAttribute('data-streaming', showCancelControl ? 'true' : 'false');
  syncStreamTimer(isStreaming);
  const streamElapsedSec = state.streamStartedAt ? Math.floor((Date.now() - state.streamStartedAt) / 1000) : 0;
  const activeMetrics =
    hasSelection && state.studioOverview?.activeCascade?.cascadeId === state.selectedId
      ? state.studioOverview.activeCascade.metrics || null
      : null;

  renderComposerFooterBar(refs, {
    catalog: state.modelCatalog,
    studioPrefs: state.studioOverview?.studioPrefs || state.modelCatalog?.studioPrefs || null,
    modelPopoverOpen: state.modelPopoverOpen,
    contextPopoverOpen: state.contextPopoverOpen,
    showHiddenModels: state.showHiddenModels,
    modelBusy: state.modelSelectBusy,
    metrics: activeMetrics,
    isStreaming,
    streamElapsedSec,
    streamChars: streamText.length,
    canWrite: writable,
    online,
    hasSelection,
    sendBusy: state.sendBusy,
    compactBusy: state.compactBusy,
    compactSupported: state.capabilities?.compact !== false,
    mediaCount: state.draftMedia.length,
    onToggleModelPopover: () => {
      state.modelPopoverOpen = !state.modelPopoverOpen;
      if (state.modelPopoverOpen) state.contextPopoverOpen = false;
      if (!state.modelPopoverOpen) state.showHiddenModels = false;
      if (state.modelPopoverOpen && (!state.modelCatalog || !state.modelCatalog.families?.length)) {
        refreshModels(state.selectedId);
      }
      syncComposerControls();
    },
    onToggleContextPopover: () => {
      state.contextPopoverOpen = !state.contextPopoverOpen;
      if (state.contextPopoverOpen) {
        state.modelPopoverOpen = false;
        state.showHiddenModels = false;
      }
      syncComposerControls();
    },
    onToggleShowHiddenModels: () => {
      state.showHiddenModels = !state.showHiddenModels;
      syncComposerControls();
    },
    onSelectModelOption: handleSelectModelOption,
    onCloseModelPopover: () => {
      state.modelPopoverOpen = false;
      state.showHiddenModels = false;
      syncComposerControls();
    },
    onCloseContextPopover: () => {
      state.contextPopoverOpen = false;
      syncComposerControls();
    },
    onCompact: handleCompactConvo,
    onPickImages: () => refs.mediaFileInput?.click(),
    onScrollBottom: (act) => {
      if (act === 'back') {
        state.mobileView = 'list';
        applyLayoutAttrs();
      } else {
        refs.timeline.scrollTop = refs.timeline.scrollHeight;
      }
    },
  });

  if (state.actionError) {
    refs.actionBanner.classList.remove('rc-hidden');
    refs.actionBanner.setAttribute('data-tone', 'danger');
    refs.actionBanner.textContent = state.actionError;
  } else if (state.actionNotice) {
    refs.actionBanner.classList.remove('rc-hidden');
    refs.actionBanner.setAttribute('data-tone', 'ok');
    refs.actionBanner.textContent = state.actionNotice;
  } else {
    refs.actionBanner.classList.add('rc-hidden');
    refs.actionBanner.textContent = '';
  }
}

async function handleSendDraft() {
  if (!wsClient || !state.selectedId || !canSteer() || state.sendBusy) return;
  if (!state.draftText.trim() && state.draftMedia.length === 0) return;
  const turboAckShown = requiresTurboAck(state.globalPreset);
  const confirmed = Boolean(turboAckShown && state.turboWriteConfirmed);
  if (turboAckShown && !confirmed) {
    state.actionError = '请先勾选 TURBO / 未知权限高危确认框';
    state.actionNotice = '';
    syncComposerControls();
    return;
  }
  const targetCid = state.selectedId;
  const textSnapshot = state.draftText;
  const mediaSnapshot = state.draftMedia.slice();
  const keySnapshot = state.draftIdempotencyKey;
  state.sendBusy = true;
  state.actionError = '';
  state.actionNotice = '';
  syncComposerControls();
  try {
    await wsClient.sendMessage(targetCid, textSnapshot, {
      idempotencyKey: keySnapshot,
      turboWriteConfirmed: confirmed,
      media: mediaSnapshot,
    });
    if (state.selectedId === targetCid) {
      if (state.draftText === textSnapshot) {
        state.draftText = '';
      }
      if (state.draftMedia.length === mediaSnapshot.length) {
        state.draftMedia = [];
      }
      state.draftIdempotencyKey = createIdempotencyKey();
      setActionNotice(mediaSnapshot.length > 0 ? '指令与图片已发送至桌面端' : '指令已发送至桌面端');
    }
    fetchAndRenderSnapshot(targetCid);
  } catch (err) {
    if (err?.code === 'idempotency_key_conflict' || err?.code === 'outcome_unknown') {
      state.draftIdempotencyKey = createIdempotencyKey();
      if (err?.code === 'outcome_unknown') {
        fetchAndRenderSnapshot(targetCid);
      }
    }
    if (err?.code === 'turbo_write_confirmation_required') {
      state.turboWriteConfirmed = false;
    }
    if (state.selectedId === targetCid) {
      state.actionError = formatWriteError(err);
    }
  } finally {
    state.sendBusy = false;
    syncComposerControls();
  }
}

async function handleApproveStep(w, decision) {
  if (!wsClient || !state.selectedId || !canSteer() || state.approvingHash) return;
  const targetCid = state.selectedId;
  const waitingHash = String(w?.waitingStepHash || '');
  const approveMapKey = `${targetCid}:${w?.stepIndex ?? ''}:${waitingHash}:${decision}`;
  let approveKey = state.pendingApproveKeys.get(approveMapKey);
  if (!approveKey) {
    approveKey = createIdempotencyKey();
    state.pendingApproveKeys.set(approveMapKey, approveKey);
  }
  state.approvingHash = waitingHash;
  state.actionError = '';
  state.actionNotice = '';
  renderDetailTimeline();
  syncComposerControls();
  try {
    await wsClient.approveWaitingStep(targetCid, {
      stepIndex: w.stepIndex,
      waitingStepHash: waitingHash,
      decision,
      idempotencyKey: approveKey,
    });
    state.pendingApproveKeys.delete(approveMapKey);
    if (state.selectedId === targetCid) {
      setActionNotice(decision === 'allow_once' ? '已允许本次执行 (Allow Once)' : '已拒绝该操作 (Deny)');
    }
    refreshAllData();
  } catch (err) {
    const code = err?.code;
    if (code === 'waiting_step_mismatch' || code === 'idempotency_key_conflict' || code === 'outcome_unknown') {
      state.pendingApproveKeys.delete(approveMapKey);
      if (code === 'waiting_step_mismatch' || code === 'outcome_unknown') {
        refreshAllData();
      }
    }
    if (state.selectedId === targetCid) {
      state.actionError = formatWriteError(err);
    }
  } finally {
    state.approvingHash = '';
    renderDetailTimeline();
    syncComposerControls();
  }
}

async function handleCancelConvo() {
  if (!wsClient || !state.selectedId || !canSteer() || state.cancelBusy) return;
  const targetCid = state.selectedId;
  if (state.cancelConfirmArmedCid !== targetCid) {
    resetCancelConfirm();
    state.cancelConfirmArmedCid = targetCid;
    cancelConfirmTimer = setTimeout(() => {
      if (state.cancelConfirmArmedCid === targetCid) {
        state.cancelConfirmArmedCid = '';
        cancelConfirmTimer = null;
        syncComposerControls();
      }
    }, 4000);
    syncComposerControls();
    return;
  }
  resetCancelConfirm();
  state.cancelBusy = true;
  state.actionError = '';
  state.actionNotice = '';
  syncComposerControls();
  try {
    await wsClient.cancelConversation(targetCid, { killBackgroundTasks: false });
    if (state.selectedId === targetCid) {
      setActionNotice('已发送停止指令');
    }
    refreshAllData();
  } catch (err) {
    if (err?.code === 'outcome_unknown') {
      refreshAllData();
    }
    if (state.selectedId === targetCid) {
      state.actionError = formatWriteError(err);
    }
  } finally {
    state.cancelBusy = false;
    syncComposerControls();
  }
}

async function handleResumeConvo(rs) {
  if (!wsClient || !state.selectedId || !canSteer() || state.resumeBusy) return;
  const targetCid = state.selectedId;
  const expectedLastIdx = rs?.lastIdx;
  if (!Number.isInteger(expectedLastIdx) || expectedLastIdx < 0) return;
  const turboAckShown = requiresTurboAck(state.globalPreset);
  const confirmed = Boolean(turboAckShown && state.turboWriteConfirmed);
  if (turboAckShown && !confirmed) {
    state.actionError = '请先勾选 TURBO / 未知权限高危确认框';
    state.actionNotice = '';
    syncComposerControls();
    return;
  }
  const mapKey = `${targetCid}:${expectedLastIdx}`;
  let idempotencyKey = state.pendingResumeKeys.get(mapKey);
  if (!idempotencyKey) {
    idempotencyKey = createIdempotencyKey();
    state.pendingResumeKeys.set(mapKey, idempotencyKey);
  }
  state.resumeBusy = true;
  state.actionError = '';
  state.actionNotice = '';
  syncComposerControls();
  try {
    await wsClient.resumeConversation(targetCid, {
      expectedLastIdx,
      turboWriteConfirmed: confirmed,
      idempotencyKey,
    });
    state.pendingResumeKeys.delete(mapKey);
    if (state.selectedId === targetCid) {
      state.resumeState = null;
      setActionNotice('已静默触发继续任务 (Resume)');
    }
    refreshAllData();
  } catch (err) {
    const code = err?.code;
    if (code === 'resume_state_changed' || code === 'idempotency_key_conflict' || code === 'outcome_unknown') {
      state.pendingResumeKeys.delete(mapKey);
      if (code === 'resume_state_changed' || code === 'outcome_unknown') {
        refreshAllData();
        wsClient.fetchResumeState(targetCid).then((fresh) => {
          if (state.selectedId === targetCid) {
            state.resumeState = fresh;
            syncComposerControls();
          }
        }).catch(() => {});
      }
    }
    if (state.selectedId === targetCid) {
      state.actionError = formatWriteError(err);
    }
  } finally {
    state.resumeBusy = false;
    syncComposerControls();
  }
}

async function handleCompactConvo() {
  if (!wsClient || !state.selectedId || !canSteer() || state.compactBusy) return;
  const targetCid = state.selectedId;
  state.contextPopoverOpen = false;
  state.compactBusy = true;
  state.actionError = '';
  state.actionNotice = '';
  syncComposerControls();
  try {
    await wsClient.compactConversation(targetCid);
    if (state.selectedId === targetCid) {
      setActionNotice('已触发上下文压缩 (/compact)');
    }
    refreshAllData();
  } catch (err) {
    if (err?.code === 'outcome_unknown') refreshAllData();
    if (state.selectedId === targetCid) {
      state.actionError = formatWriteError(err);
    }
  } finally {
    state.compactBusy = false;
    syncComposerControls();
  }
}

async function handleDismissOpus(prop) {
  if (!wsClient || !state.selectedId || !canSteer() || state.opusDismissBusy || !prop?.id) return;
  const targetCid = state.selectedId;
  state.opusDismissBusy = true;
  state.actionError = '';
  state.actionNotice = '';
  syncComposerControls();
  try {
    await wsClient.dismissOpusProposal(targetCid, prop.id, { ts: prop.ts });
    if (state.selectedId === targetCid) {
      setActionNotice('已忽略 Opus Gate 检查点建议');
    }
    refreshStudioOverview(targetCid);
  } catch (err) {
    if (state.selectedId === targetCid) {
      state.actionError = formatWriteError(err);
    }
  } finally {
    state.opusDismissBusy = false;
    syncComposerControls();
  }
}

function renderTopStatus() {
  const refs = ensureWorkspaceShell();
  applyLayoutAttrs();

  const wsInfo = normalizeWsStatus(state.wsStatus, state.wsDetail);
  refs.brandDot.setAttribute('data-state', state.wsStatus);
  refs.wsPill.setAttribute('data-tone', wsInfo.tone);
  refs.wsPill.textContent = wsInfo.label;

  refs.hostPill.setAttribute('data-tone', state.hostAttached ? 'ok' : 'warn');
  refs.hostPill.textContent = state.hostAttached
    ? `CDP 实时 (${state.source || 'cdp'})`
    : '宿主离线 · 磁盘只读';

  const presetInfo = formatPresetBadge(state.globalPreset);
  refs.presetPill.setAttribute('data-tone', presetInfo.tone);
  refs.presetPill.textContent = presetInfo.label;

  const devName = state.identity?.deviceName || '已配对设备';
  const role = state.identity?.role || 'observe';
  refs.devicePill.textContent = `${devName} (${role})`;

  clearNode(refs.noticeBar);
  if (state.wsStatus === 'revoked') {
    refs.noticeBar.classList.remove('rc-hidden');
    refs.noticeBar.setAttribute('data-tone', 'danger');
    refs.noticeBar.append(
      el('span', { text: `当前设备密钥已吊销或网关身份已变更（${state.wsDetail || '请重新配对'}）。` }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm is-primary',
        text: '重新配对',
        onClick: async () => {
          await clearDeviceIdentity().catch(() => {});
          state.identity = null;
          state.turboWriteConfirmed = false;
          state.pendingApproveKeys.clear();
          state.pendingResumeKeys.clear();
          state.studioOverview = null;
          state.studioDrawerOpen = false;
          state.selectedProjectId = '';
          state.resumeState = null;
          resetCancelConfirm();
          workspaceRefs = null;
          pairView.loadHealthForPairing();
        },
      })
    );
  } else if (!state.hostAttached && state.wsStatus === 'connected') {
    refs.noticeBar.classList.remove('rc-hidden');
    refs.noticeBar.setAttribute('data-tone', 'warn');
    refs.noticeBar.append(
      el('span', {
        text: 'Antigravity 桌面窗口当前未挂载 CDP，已自动降级为 SQLite / Transcript 只读历史模式（无实时流与审批态）。',
      })
    );
  } else {
    refs.noticeBar.classList.add('rc-hidden');
  }
  syncComposerControls();
}

function renderFilterChips() {
  renderFilterChipsView({
    state,
    refs: ensureWorkspaceShell(),
    onSelectFilter: (id) => {
      state.filter = id;
      renderFilterChips();
      renderSidebarList();
    },
    onSelectGroupBy: (id) => {
      state.sidebarGroupBy = id;
      writeStoredPref(STORAGE_KEYS.sidebarGroupBy, id);
      renderFilterChips();
      renderSidebarList();
    },
    onToggleSubagents: () => {
      state.includeSubagents = !state.includeSubagents;
      renderFilterChips();
      renderSidebarList();
      if (wsClient) {
        wsClient.refreshList(state.includeSubagents).then(applyConvoListResult).catch(() => {});
      }
    },
  });
}

function renderSidebarList() {
  renderSidebarListView({
    state,
    refs: ensureWorkspaceShell(),
    resolvedLayoutMode: getResolvedLayoutMode(),
    onSelectConversation: selectConversation,
  });
}

function renderDetailTimeline() {
  renderTimelineView({
    state,
    refs: ensureWorkspaceShell(),
    onSelectConversation: selectConversation,
    onApprove: handleApproveStep,
  });
}

function renderWorkspace() {
  renderTopStatus();
  renderStudioPanels();
  renderFilterChips();
  renderSidebarList();
  renderDetailTimeline();
}

function render() {
  if (!state.identity) {
    pairView.renderPairingScreen();
  } else {
    renderWorkspace();
  }
}

function applyConvoListResult(result) {
  if (!result || typeof result !== 'object') return;
  if (result.source) state.source = result.source;
  if (result.globalPreset !== undefined) updateGlobalPreset(result.globalPreset);
  if (Array.isArray(result.conversations)) {
    state.conversations = result.conversations;
    alertManager.observeConversations(state.conversations);
    if (!state.selectedId && result.conversations.length > 0 && getResolvedLayoutMode() === 'desktop') {
      const firstTop = result.conversations.find((c) => !c.parentConversationId) || result.conversations[0];
      if (firstTop && UUID_RE.test(firstTop.id)) {
        selectConversation(firstTop.id);
        return;
      }
    }
  }
  renderWorkspace();
}

function refreshStudioOverview(cascadeId = state.selectedId) {
  if (!wsClient) return;
  const reqSeq = ++studioOverviewSeq;
  const reqCid = cascadeId || '';
  wsClient
    .fetchStudioOverview(reqCid)
    .then((ov) => {
      if (!ov || !wsClient || reqSeq !== studioOverviewSeq) return;
      if (reqCid && state.selectedId !== reqCid) return;
      clearStudioOverviewRetry();
      state.studioOverview = ov;
      if (state.identity) {
        renderStudioPanels();
        renderSidebarList();
        renderDetailTimeline();
        syncComposerControls();
      }
    })
    .catch(() => {
      if (!wsClient || !state.identity || state.studioOverview || state.wsStatus !== 'connected') return;
      if (!studioOverviewRetryTimer) {
        studioOverviewRetryTimer = setTimeout(() => {
          studioOverviewRetryTimer = null;
          if (wsClient && state.identity && state.wsStatus === 'connected') {
            refreshStudioOverview(state.selectedId);
          }
        }, 2000);
      }
    });
}

function applySnapshot(cascadeId, snap) {
  if (!cascadeId || !snap) return;
  state.snapshots.set(cascadeId, snap);
  if (snap.resumeState && state.selectedId === cascadeId) {
    state.resumeState = snap.resumeState;
  }
  if (isRunningStatus(snap.status) && typeof snap.streamingText === 'string' && snap.streamingText) {
    const steps = Array.isArray(snap.steps) ? snap.steps : [];
    const lastIdx = steps.length > 0 ? steps[steps.length - 1].idx : 0;
    state.streams.set(cascadeId, {
      stepIdx: lastIdx,
      text: snap.streamingText,
      thinkingText: '',
      status: snap.status || '',
      stepCount: steps.length,
    });
  } else {
    state.streams.delete(cascadeId);
  }
}

async function fetchAndRenderSnapshot(cascadeId) {
  if (!wsClient || !cascadeId) return;
  state.snapshotLoading = true;
  state.snapshotError = '';
  if (state.selectedId === cascadeId) renderDetailTimeline();
  try {
    const snap = await wsClient.fetchSnapshot(cascadeId);
    applySnapshot(cascadeId, snap);
  } catch (err) {
    if (state.selectedId === cascadeId) {
      state.snapshotError = String(err?.message || '获取会话快照失败');
    }
  } finally {
    if (state.selectedId === cascadeId) {
      state.snapshotLoading = false;
      renderDetailTimeline();
      renderStudioPanels();
    }
  }
}

function scheduleSelectedSnapshotRefresh() {
  if (!state.selectedId || snapshotRefreshTimer) return;
  snapshotRefreshTimer = setTimeout(() => {
    snapshotRefreshTimer = null;
    if (state.selectedId && wsClient) {
      const targetId = state.selectedId;
      wsClient
        .fetchSnapshot(targetId)
        .then((snap) => {
          applySnapshot(targetId, snap);
          if (state.selectedId === targetId) renderDetailTimeline();
        })
        .catch(() => {});
    }
  }, 450);
}

async function selectConversation(cascadeId, { skipHistoryPush = false } = {}) {
  if (!cascadeId || !UUID_RE.test(cascadeId)) return;
  if (state.selectedId !== cascadeId) {
    state.draftIdempotencyKey = createIdempotencyKey();
    state.draftMedia = [];
    state.turboWriteConfirmed = false;
    state.resumeState = null;
    state.modelPopoverOpen = false;
    state.contextPopoverOpen = false;
    state.streamStartedAt = 0;
    clearStreamTickTimer();
    state.actionError = '';
    state.actionNotice = '';
    resetCancelConfirm();
  }
  state.selectedId = cascadeId;
  state.mobileView = 'detail';
  if (!skipHistoryPush) mobileHistory.enterDetail(cascadeId);
  state.snapshotError = '';
  state.snapshotLoading = !state.snapshots.has(cascadeId);
  renderWorkspace();

  if (!wsClient) return;
  refreshStudioOverview(cascadeId);
  refreshModels(cascadeId);
  wsClient
    .fetchResumeState(cascadeId)
    .then((rs) => {
      if (state.selectedId === cascadeId && rs) {
        state.resumeState = rs;
        syncComposerControls();
      }
    })
    .catch(() => {});
  try {
    const snap = await wsClient.watchConversation(cascadeId);
    if (snap && state.selectedId === cascadeId) {
      applySnapshot(cascadeId, snap);
      state.snapshotLoading = false;
      renderDetailTimeline();
      syncComposerControls();
    }
  } catch (err) {
    if (state.selectedId === cascadeId) {
      state.snapshotLoading = false;
      state.snapshotError = String(err?.message || '加载会话失败');
      renderDetailTimeline();
    }
  }
}

function refreshAllData() {
  if (!wsClient) return;
  wsClient.refreshList(state.includeSubagents).then(applyConvoListResult).catch(() => {});
  refreshStudioOverview(state.selectedId);
  refreshModels(state.selectedId);
  if (state.selectedId) {
    fetchAndRenderSnapshot(state.selectedId);
  }
}

function handleTapDelta(delta) {
  const { kind, data } = delta;
  if (!data || typeof data !== 'object') return;

  if (kind === 'host_status') {
    const wasAttached = state.hostAttached;
    if ('hostAttached' in data) state.hostAttached = Boolean(data.hostAttached);
    if ('globalPreset' in data) updateGlobalPreset(data.globalPreset);
    if ('capabilities' in data) state.capabilities = data.capabilities;
    if ('source' in data) state.source = data.source;
    renderTopStatus();
    renderStudioPanels();
    if (!wasAttached && state.hostAttached) {
      refreshAllData();
    }
    return;
  }

  if (kind === 'summaries') {
    if (data.globalPreset !== undefined) updateGlobalPreset(data.globalPreset);
    if (data.source) state.source = data.source;
    state.conversations = mergeSummariesDelta(state.conversations, data);
    alertManager.observeConversations(state.conversations);
    renderTopStatus();
    renderFilterChips();
    renderSidebarList();
    if (state.selectedId) {
      scheduleSelectedSnapshotRefresh();
    }
    return;
  }

  if (kind === 'stream') {
    const cid = data.cascadeId;
    if (!cid) return;
    const prev = state.streams.get(cid);
    const prevText = typeof prev === 'string' ? prev : prev?.text ?? prev?.streamingText ?? '';
    const prevStepIdx = typeof prev === 'object' && prev ? prev.stepIdx : null;
    const incomingStepIdx = Number.isInteger(data.stepIdx) ? data.stepIdx : prevStepIdx;
    let nextText = prevText;
    let gapDetected = false;

    if (typeof data.chunk === 'string' && Number.isInteger(data.offset)) {
      const sameStep = prevStepIdx !== null && prevStepIdx === incomingStepIdx;
      if (data.reset || !sameStep) {
        if (data.offset === 0) {
          nextText = data.chunk;
        } else {
          nextText = data.chunk;
          gapDetected = true;
        }
      } else if (data.offset === prevText.length) {
        nextText = prevText + data.chunk;
      } else if (data.offset >= 0 && data.offset < prevText.length) {
        nextText = prevText.slice(0, data.offset) + data.chunk;
      } else {
        gapDetected = true;
        nextText = prevText + data.chunk;
      }
    } else if (typeof data.streamingText === 'string') {
      nextText = data.streamingText;
    } else if (typeof data.text === 'string') {
      nextText = data.text;
    }

    const nextThinking = typeof data.thinkingText === 'string' ? data.thinkingText : '';
    const stUpper = String(data.status || '').toUpperCase();
    const isFinished =
      Boolean(data.completed || data.stepDone) ||
      stUpper === 'DONE' ||
      stUpper === 'IDLE' ||
      stUpper === 'ERROR' ||
      stUpper === 'CANCELED';

    if (isFinished) {
      state.streams.delete(cid);
    } else {
      state.streams.set(cid, {
        stepIdx: incomingStepIdx,
        text: nextText,
        thinkingText: nextThinking,
        status: data.status || '',
        stepCount: Number.isFinite(Number(data.stepCount)) ? Number(data.stepCount) : null,
      });
    }
    if (cid === state.selectedId) {
      const snap = state.snapshots.get(cid);
      const stepAdvanced = Number.isFinite(Number(data.stepCount)) && snap && data.stepCount > (snap.steps?.length || 0);
      if (gapDetected || isFinished || stepAdvanced) {
        scheduleSelectedSnapshotRefresh();
      } else {
        renderDetailTimeline();
      }
    }
  }
}

function startWorkspaceSession() {
  ensureGlobalUiListeners();
  mobileHistory.bind();
  clearStudioOverviewRetry();
  if (wsClient) {
    wsClient.dispose();
    wsClient = null;
  }
  renderWorkspace();
  wsClient = createRemoteWsClient(state.identity, {
    onStatus: (status, detail) => {
      state.wsStatus = status;
      state.wsDetail = detail || '';
      if (state.identity) {
        renderTopStatus();
        renderStudioPanels();
      }
    },
    onHealth: (health) => {
      if (!health || typeof health !== 'object') return;
      const wasAttached = state.hostAttached;
      if ('hostAttached' in health) state.hostAttached = Boolean(health.hostAttached);
      if (health.globalPreset !== undefined) updateGlobalPreset(health.globalPreset);
      if (health.capabilities) state.capabilities = health.capabilities;
      state.source = state.hostAttached ? 'cdp' : 'disk';
      if (state.identity) {
        renderTopStatus();
        renderStudioPanels();
        if (!wasAttached && state.hostAttached) {
          refreshAllData();
        }
      }
    },
    onWelcome: (msg) => {
      if (msg.deviceRole && state.identity && state.identity.role !== msg.deviceRole) {
        state.identity.role = msg.deviceRole;
        saveDeviceIdentity(state.identity).catch(() => {});
      }
      if (msg.health) {
        state.hostAttached = Boolean(msg.health.hostAttached);
        if (msg.health.globalPreset !== undefined) updateGlobalPreset(msg.health.globalPreset);
        state.capabilities = msg.health.capabilities ?? state.capabilities;
      }
      if (Array.isArray(msg.conversations)) {
        applyConvoListResult({
          conversations: msg.conversations,
          source: msg.health?.hostAttached ? 'cdp' : 'disk',
          globalPreset: msg.health?.globalPreset,
        });
      } else {
        wsClient.refreshList(state.includeSubagents).then(applyConvoListResult).catch(() => {});
      }
      refreshStudioOverview(state.selectedId);
      refreshModels(state.selectedId);
      renderTopStatus();
    },
    onDelta: handleTapDelta,
    onSnapshot: (cid, snap) => {
      applySnapshot(cid, snap);
      if (state.selectedId === cid) {
        state.snapshotLoading = false;
        renderDetailTimeline();
        renderStudioPanels();
        syncComposerControls();
      }
    },
    onError: () => {},
  });
}

async function boot() {
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    if (typeof navigator.serviceWorker.addEventListener === 'function') {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || swReloading) return;
        if (
          state.pairingCode ||
          state.pairingBusy ||
          state.sendBusy ||
          (state.draftText && state.draftText.trim()) ||
          (Array.isArray(state.draftMedia) && state.draftMedia.length > 0)
        ) {
          return;
        }
        swReloading = true;
        try {
          window.location.reload();
        } catch {}
      });
    }
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((reg) => reg?.update?.().catch(() => {}))
      .catch(() => {});
  }

  const rawHash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const hashParams = new URLSearchParams(rawHash);
  const pairParam = (hashParams.get('pair') || '').trim();
  if (pairParam) {
    state.pairingCode = pairParam;
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    } catch {}
  }

  let stored = null;
  try {
    stored = await loadDeviceIdentity();
  } catch (err) {
    state.pairingError = String(err?.message || '初始化本地密钥存储失败');
  }

  if (stored && stored.deviceId && stored.privateKey && !pairParam) {
    state.identity = stored;
    startWorkspaceSession();
    return;
  }

  // If #pair= was provided while already paired, allow pairing new code cleanly
  if (stored && pairParam) {
    state.identity = null;
  }

  await pairView.loadHealthForPairing();
}

boot();
