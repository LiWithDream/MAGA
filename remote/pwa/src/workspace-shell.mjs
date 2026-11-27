/**
 * AGY Studio Remote PWA — Workspace Shell DOM Builder & Project Filter Strip
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import { clearNode, el } from './ui-helpers.mjs';

export function createWorkspaceShellDom({ rootEl, state, layoutButtonLabel, handlers = {} }) {
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
    onClick: () => handlers.onToggleSidebar?.(),
  });

  const layoutModeBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm rc-desktop-only',
    title: '切换桌面 / 移动视图适配模式',
    text: layoutButtonLabel(state.layoutPref),
    onClick: () => handlers.onCycleLayoutMode?.(),
  });

  const overviewToggleBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm rc-desktop-only',
    title: '折叠或展开右侧 Overview 面板',
    text: '概览',
    onClick: () => handlers.onToggleOverview?.(),
  });

  const refreshBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm rc-desktop-only',
    text: '刷新',
    onClick: () => handlers.onRefreshAll?.(),
  });

  const unpairBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-danger rc-desktop-only',
    text: '重配对',
    onClick: () => handlers.onUnpair?.(),
  });

  const mobileRefreshBtn = el('button', {
    type: 'button',
    className: 'rc-icon-btn rc-mobile-only',
    'aria-label': '刷新',
    title: '刷新',
    text: '↻',
    onClick: () => handlers.onRefreshAll?.(),
  });

  const mobileMoreBtn = el('button', {
    type: 'button',
    className: 'rc-icon-btn rc-mobile-only',
    'aria-label': '更多选项',
    title: '更多选项',
    text: '⋯',
    onClick: (ev) => handlers.onToggleMoreMenu?.(ev),
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
    onInput: (ev) => handlers.onSearchInput?.(ev.target.value),
  });

  const newChatBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-primary rc-new-chat-btn',
    title: '新建会话',
    text: '+ 新会话',
    onClick: () => handlers.onOpenNewChat?.(),
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
    onClick: () => handlers.onBackToList?.(),
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
        text: '文档',
        title: '查看当前会话 Markdown 文档 (Artifacts)',
        onClick: () => handlers.onOpenArtifacts?.(),
      }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm rc-desktop-only',
        text: 'Git',
        title: '查看仓库 Git 变更与 Diff',
        onClick: () => handlers.onOpenGitDiff?.(),
      }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm rc-desktop-only',
        text: '拉取快照',
        onClick: () => handlers.onRefreshSelectedSnapshot?.(),
      }),
      el('button', {
        type: 'button',
        className: 'rc-icon-btn rc-mobile-only',
        'aria-label': '文档与代码变更',
        title: '文档与 Git Diff',
        text: '📄',
        onClick: () => handlers.onOpenArtifacts?.(),
      }),
      el('button', {
        type: 'button',
        className: 'rc-icon-btn rc-mobile-only',
        'aria-label': '刷新快照',
        title: '刷新快照',
        text: '↻',
        onClick: () => handlers.onRefreshSelectedSnapshot?.(),
      }),
      el('button', {
        type: 'button',
        className: 'rc-icon-btn rc-mobile-only',
        'aria-label': '更多选项',
        title: '更多选项',
        text: '⋯',
        onClick: (ev) => handlers.onToggleMoreMenu?.(ev),
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
    onClick: () => handlers.onDismissActionBanner?.(),
  });
  const turboWriteCheckbox = el('input', {
    id: 'rc-turbo-write-ack',
    type: 'checkbox',
    checked: state.turboWriteConfirmed,
    onChange: (ev) => handlers.onToggleTurboWrite?.(Boolean(ev.target.checked)),
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
    onInput: (ev) => handlers.onDraftInput?.(ev.target.value, ev.target),
  });
  draftInput.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      handlers.onSendDraft?.();
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
      handlers.onAttachImageFiles?.(files);
    }
  });

  const mediaFileInput = el('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp,image/gif',
    multiple: 'true',
    className: 'rc-hidden',
    onChange: (ev) => {
      const files = ev.target?.files ? Array.from(ev.target.files) : [];
      if (files.length > 0) handlers.onAttachImageFiles?.(files);
      if (ev.target) ev.target.value = '';
    },
  });

  const sendBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-primary rc-send-btn',
    text: '发送',
    onClick: () => handlers.onSendDraft?.(),
  });
  const cancelBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-danger rc-cancel-btn',
    text: '停止',
    onClick: () => handlers.onCancelConvo?.(),
  });
  const composerRow = el('div', { className: 'rc-composer-row' }, draftInput, sendBtn, cancelBtn);
  const slashBar = el('div', { className: 'rc-slash-bar rc-hidden' });
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
    slashBar,
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

  const navChatsBtn = el('button', {
    type: 'button',
    className: 'rc-mobile-nav-btn',
    text: '会话',
    onClick: () => handlers.onSwitchMobileTab?.('chats'),
  });
  const navApprovalsBadge = el('span', { className: 'rc-nav-badge rc-hidden', text: '0' });
  const navApprovalsBtn = el(
    'button',
    {
      type: 'button',
      className: 'rc-mobile-nav-btn',
      onClick: () => handlers.onSwitchMobileTab?.('approvals'),
    },
    el('span', { text: '待审批' }),
    navApprovalsBadge
  );
  const navOverviewBtn = el('button', {
    type: 'button',
    className: 'rc-mobile-nav-btn',
    text: '概览',
    onClick: () => handlers.onSwitchMobileTab?.('overview'),
  });
  const mobileNav = el(
    'nav',
    { className: 'rc-mobile-nav', 'aria-label': '移动端主导航' },
    navChatsBtn,
    navApprovalsBtn,
    navOverviewBtn
  );

  const newChatModal = el('div', { className: 'rc-new-chat-host rc-hidden' });
  const viewerDrawer = el('div', { className: 'rc-viewer-host rc-hidden' });
  const main = el('main', { className: 'rc-main' }, sidebar, detail, overviewPane);
  rootEl.append(topbar, moreMenu, noticeBar, studioStrip, projectsDrawer, main, mobileNav, newChatModal, viewerDrawer);

  return {
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
    slashBar,
    draftInput,
    sendBtn,
    cancelBtn,
    searchInput,
    newChatBtn,
    newChatModal,
    viewerDrawer,
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
}

export function renderSidebarProjectsBar(refs, state, { onSelectProject } = {}) {
  if (!refs?.sidebarProjects) return;
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
      onClick: () => onSelectProject?.(''),
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
        onClick: () => onSelectProject?.(active ? '' : proj.id),
      })
    );
  }
}
