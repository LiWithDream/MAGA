/**
 * AGY Studio Remote Control PWA Entry (Zero-XSS, strict CSP, mobile + desktop responsive).
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import {
  clearDeviceIdentity,
  defaultDeviceName,
  loadDeviceIdentity,
  saveDeviceIdentity,
} from './crypto-store.mjs';
import { createPairViewController } from './pair-view.mjs';
import {
  renderOpusGateBanner,
  renderProjectsDrawer,
  renderResumeBanner,
  renderStudioStrip,
} from './studio-panel.mjs';
import { renderDetailTimeline as renderTimelineView } from './timeline-view.mjs';
import {
  UUID_RE,
  clearNode,
  collectPendingApprovals,
  el,
  filterConversations,
  formatPresetBadge,
  formatRelativeTime,
  getEffectiveWaitingCount,
  isRunningStatus,
  normalizeRunStatus,
  normalizeWsStatus,
  requiresTurboAck,
} from './ui-helpers.mjs';
import { createIdempotencyKey, createRemoteWsClient } from './ws-client.mjs';

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
  draftText: '',
  draftIdempotencyKey: createIdempotencyKey(),
  turboWriteConfirmed: false,
  pendingApproveKeys: new Map(),
  pendingResumeKeys: new Map(),
  cancelConfirmArmedCid: '',
  studioOverview: null,
  studioDrawerOpen: false,
  selectedProjectId: '',
  resumeState: null,
  sendBusy: false,
  cancelBusy: false,
  resumeBusy: false,
  compactBusy: false,
  opusDismissBusy: false,
  approvingHash: '',
  actionError: '',
  actionNotice: '',
};

let wsClient = null;
let snapshotRefreshTimer = null;
let studioOverviewSeq = 0;
let cancelConfirmTimer = null;
let workspaceRefs = null;
const rootEl = document.getElementById('app');

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

function ensureWorkspaceShell() {
  if (workspaceRefs && rootEl.contains(workspaceRefs.topbar)) {
    return workspaceRefs;
  }
  clearNode(rootEl);

  const brandDot = el('span', { className: 'rc-brand-dot' });
  const wsPill = el('span', { className: 'rc-pill' });
  const hostPill = el('span', { className: 'rc-pill' });
  const presetPill = el('span', { className: 'rc-pill' });
  const devicePill = el('span', { className: 'rc-pill' });

  const refreshBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm',
    text: '刷新',
    onClick: () => refreshAllData(),
  });

  const unpairBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-danger',
    text: '重配对',
    onClick: async () => {
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
      state.turboAcknowledged = false;
      state.turboWriteConfirmed = false;
      state.draftIdempotencyKey = createIdempotencyKey();
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
  });

  const topbar = el(
    'header',
    { className: 'rc-topbar' },
    el(
      'div',
      { className: 'rc-topbar-left' },
      brandDot,
      el('span', { className: 'rc-topbar-title', text: 'AGY Studio Remote' }),
      wsPill,
      hostPill,
      presetPill
    ),
    el('div', { className: 'rc-topbar-right' }, devicePill, refreshBtn, unpairBtn)
  );

  const noticeBar = el('div', { className: 'rc-notice-bar rc-hidden' });
  const studioStrip = el('div', { className: 'rc-studio-strip rc-hidden' });
  const projectsDrawer = el('div', { className: 'rc-projects-drawer rc-hidden' });

  const searchInput = el('input', {
    className: 'rc-search',
    type: 'search',
    placeholder: '搜索会话标题 / ID…',
    value: state.searchQuery,
    onInput: (ev) => {
      state.searchQuery = ev.target.value;
      renderSidebarList();
    },
  });

  const filterRow = el('div', { className: 'rc-filter-row' });
  const sidebarList = el('div', { className: 'rc-scroll-list' });
  const sidebar = el(
    'aside',
    { className: 'rc-sidebar' },
    el('div', { className: 'rc-sidebar-head' }, searchInput, filterRow),
    sidebarList
  );

  const detailTitle = el('h2', { className: 'rc-detail-title', text: '请选择一个会话' });
  const detailSub = el('div', { className: 'rc-detail-sub' });
  const backBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm rc-mobile-only',
    text: '← 列表',
    onClick: () => {
      state.mobileView = 'list';
      rootEl.setAttribute('data-mobile-view', 'list');
    },
  });

  const detailHead = el(
    'div',
    { className: 'rc-detail-head' },
    backBtn,
    el('div', { className: 'rc-detail-title-wrap' }, detailTitle, detailSub),
    el(
      'button',
      {
        type: 'button',
        className: 'rc-btn is-sm',
        text: '拉取快照',
        onClick: () => {
          if (state.selectedId) fetchAndRenderSnapshot(state.selectedId);
        },
      }
    )
  );

  const roleBanner = el('div', { className: 'rc-readonly-banner' });
  const roleBannerText = el('span', { text: '' });
  const roleBannerPill = el('span', { className: 'rc-pill', 'data-tone': 'info', text: 'OBSERVE' });
  roleBanner.append(roleBannerText, roleBannerPill);

  const timeline = el('div', { className: 'rc-timeline' });

  const resumeBanner = el('div', { className: 'rc-resume-card rc-hidden' });
  const opusBanner = el('div', { className: 'rc-opus-card rc-hidden' });
  const actionBanner = el('div', { className: 'rc-action-banner rc-hidden' });
  const turboWriteCheckbox = el('input', {
    id: 'rc-turbo-write-ack',
    type: 'checkbox',
    checked: state.turboWriteConfirmed,
    onChange: (ev) => {
      state.turboWriteConfirmed = Boolean(ev.target.checked);
      syncComposerControls();
    },
  });
  const turboWriteLabel = el(
    'label',
    { className: 'rc-turbo-inline rc-hidden', for: 'rc-turbo-write-ack' },
    turboWriteCheckbox,
    el('span', { text: 'TURBO / 未知权限高危确认：我确认远程发送将自动执行本机操作' })
  );

  const draftInput = el('textarea', {
    className: 'rc-composer-input',
    rows: '2',
    placeholder: '输入指令继续当前会话（Ctrl/Cmd + Enter 发送）…',
    value: state.draftText,
    onInput: (ev) => {
      state.draftText = ev.target.value;
      state.draftIdempotencyKey = createIdempotencyKey();
      state.actionError = '';
      syncComposerControls();
    },
  });
  draftInput.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      handleSendDraft();
    }
  });

  const sendBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-primary',
    text: '发送',
    onClick: () => handleSendDraft(),
  });
  const cancelBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-danger',
    text: '停止',
    onClick: () => handleCancelConvo(),
  });
  const composerRow = el('div', { className: 'rc-composer-row' }, draftInput, sendBtn, cancelBtn);
  const compactBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm rc-hidden',
    text: '/compact',
    onClick: () => handleCompactConvo(),
  });
  const auxDockRow = el(
    'div',
    { className: 'rc-dock-aux' },
    el(
      'div',
      { className: 'rc-dock-group' },
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm rc-mobile-only',
        text: '← 返回列表',
        onClick: () => {
          state.mobileView = 'list';
          rootEl.setAttribute('data-mobile-view', 'list');
        },
      }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm',
        text: '回到底部',
        onClick: () => {
          timeline.scrollTop = timeline.scrollHeight;
        },
      })
    ),
    el('div', { className: 'rc-dock-group' }, compactBtn)
  );

  const bottomDock = el(
    'footer',
    { className: 'rc-bottom-dock is-composer' },
    resumeBanner,
    opusBanner,
    actionBanner,
    turboWriteLabel,
    composerRow,
    auxDockRow
  );

  const detail = el(
    'section',
    { className: 'rc-detail' },
    detailHead,
    roleBanner,
    timeline,
    bottomDock
  );

  const main = el('main', { className: 'rc-main' }, sidebar, detail);
  rootEl.append(topbar, noticeBar, studioStrip, projectsDrawer, main);

  workspaceRefs = {
    topbar,
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
    turboWriteLabel,
    turboWriteCheckbox,
    composerRow,
    draftInput,
    sendBtn,
    cancelBtn,
    compactBtn,
    filterRow,
    sidebarList,
    detailTitle,
    detailSub,
    timeline,
  };
  return workspaceRefs;
}

function canSteer() {
  const role = state.identity?.role || 'observe';
  return role === 'steer' || role === 'admin';
}

function formatWriteError(err) {
  const code = String(err?.code || err?.message || '操作失败');
  if (code === 'forbidden_role_observe') return '当前设备为只读角色 (observe)，无法执行远程写操作';
  if (code === 'host_not_attached') return 'Antigravity 桌面宿主未连接，无法执行写操作';
  if (code === 'turbo_write_confirmation_required') return '本机处于 TURBO 或未知权限模式，请先勾选高危确认框后再发送';
  if (code === 'waiting_step_mismatch') return '目标审批步骤已变化或已失效，已自动刷新最新状态';
  if (code === 'write_rate_limited') return '写操作过于频繁，请稍后再试';
  if (code === 'too_many_concurrent_writes') return '并发写请求过多，请等待当前操作完成';
  if (code === 'idempotency_key_conflict') return '请求幂等键冲突，已重置请求标识，请重新确认后发送';
  if (code === 'outcome_unknown') return '远端执行结果未知（请求超时或连接中断），已自动刷新会话状态，请确认是否已生效后再决定是否重发';
  if (code === 'cascade_write_busy') return '桌面端或另一请求正在操作该会话，请稍后再试';
  if (code === 'resume_state_changed') return '会话状态已更新，当前无需续跑，已自动刷新状态';
  if (code === 'compact_requires_active_pane') return '请先在桌面端激活对应会话窗口，或使用发送框触发压缩';
  if (code === 'compact_rejected_or_busy') return '当前无法执行上下文压缩（可能正在运行、已压缩或输入框仍有草稿）';
  if (code === 'compact_unavailable') return '当前宿主版本暂不支持远程触发 /compact';
  return code;
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

function renderStudioPanels() {
  const refs = ensureWorkspaceShell();
  renderStudioStrip(refs.studioStrip, {
    overview: state.studioOverview,
    open: state.studioDrawerOpen,
    selectedProjectId: state.selectedProjectId,
    onToggleProjects: () => {
      state.studioDrawerOpen = !state.studioDrawerOpen;
      renderStudioPanels();
    },
  });
  renderProjectsDrawer(refs.projectsDrawer, {
    overview: state.studioOverview,
    open: state.studioDrawerOpen,
    selectedProjectId: state.selectedProjectId,
    onSelectProject: (nextPid) => {
      state.selectedProjectId = nextPid || '';
      renderStudioPanels();
      renderSidebarList();
    },
    onClose: () => {
      state.studioDrawerOpen = false;
      renderStudioPanels();
    },
  });
}

function syncComposerControls() {
  const refs = ensureWorkspaceShell();
  const writable = canSteer();
  const online = Boolean(state.hostAttached && state.wsStatus === 'connected');
  const hasSelection = Boolean(state.selectedId);
  const needTurboConfirm = requiresTurboAck(state.globalPreset);

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

  refs.turboWriteCheckbox.checked = Boolean(needTurboConfirm && state.turboWriteConfirmed);
  if (writable && needTurboConfirm) {
    refs.turboWriteLabel.classList.remove('rc-hidden');
    refs.turboWriteCheckbox.disabled = state.sendBusy || state.resumeBusy;
  } else {
    refs.turboWriteLabel.classList.add('rc-hidden');
  }

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

  if (writable && hasSelection) {
    refs.compactBtn.classList.remove('rc-hidden');
  } else {
    refs.compactBtn.classList.add('rc-hidden');
  }
  refs.compactBtn.textContent = state.compactBusy ? '压缩中…' : '/compact';
  refs.compactBtn.disabled =
    !writable || !online || !hasSelection || state.compactBusy || state.capabilities?.compact === false;

  if (refs.draftInput.value !== state.draftText) {
    refs.draftInput.value = state.draftText;
  }
  refs.draftInput.disabled = !writable || !online || !hasSelection || state.sendBusy;
  refs.sendBtn.textContent = state.sendBusy ? '发送中…' : '发送';
  refs.sendBtn.disabled =
    !writable ||
    !online ||
    !hasSelection ||
    state.sendBusy ||
    !state.draftText.trim() ||
    (needTurboConfirm && !state.turboWriteConfirmed);
  if (state.cancelBusy) {
    refs.cancelBtn.textContent = '停止中…';
  } else if (state.cancelConfirmArmedCid && state.cancelConfirmArmedCid === state.selectedId) {
    refs.cancelBtn.textContent = '确认停止？';
  } else {
    refs.cancelBtn.textContent = '停止';
  }
  refs.cancelBtn.disabled = !writable || !online || !hasSelection || state.cancelBusy;

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
  if (!state.draftText.trim()) return;
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
  const keySnapshot = state.draftIdempotencyKey;
  state.sendBusy = true;
  state.actionError = '';
  state.actionNotice = '';
  syncComposerControls();
  try {
    await wsClient.sendMessage(targetCid, textSnapshot, {
      idempotencyKey: keySnapshot,
      turboWriteConfirmed: confirmed,
    });
    if (state.selectedId === targetCid) {
      if (state.draftText === textSnapshot) {
        state.draftText = '';
      }
      state.draftIdempotencyKey = createIdempotencyKey();
      state.actionNotice = '指令已发送至桌面端';
    }
    fetchAndRenderSnapshot(targetCid);
  } catch (err) {
    if (err?.code === 'idempotency_key_conflict' || err?.code === 'outcome_unknown') {
      state.draftIdempotencyKey = createIdempotencyKey();
      if (err?.code === 'outcome_unknown') {
        fetchAndRenderSnapshot(targetCid);
      }
    }
    if (state.selectedId === targetCid) {
      state.actionError = formatWriteError(err);
    }
  } finally {
    state.turboWriteConfirmed = false;
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
      state.actionNotice = decision === 'allow_once' ? '已允许本次执行 (Allow Once)' : '已拒绝该操作 (Deny)';
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
      state.actionNotice = '已发送停止指令';
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
      state.actionNotice = '已静默触发继续任务 (Resume)';
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
    state.turboWriteConfirmed = false;
    state.resumeBusy = false;
    syncComposerControls();
  }
}

async function handleCompactConvo() {
  if (!wsClient || !state.selectedId || !canSteer() || state.compactBusy) return;
  const targetCid = state.selectedId;
  state.compactBusy = true;
  state.actionError = '';
  state.actionNotice = '';
  syncComposerControls();
  try {
    await wsClient.compactConversation(targetCid);
    if (state.selectedId === targetCid) {
      state.actionNotice = '已触发上下文压缩 (/compact)';
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
      state.actionNotice = '已忽略 Opus Gate 检查点建议';
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
  rootEl.setAttribute('data-mobile-view', state.mobileView);

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
  const refs = ensureWorkspaceShell();
  clearNode(refs.filterRow);

  const pendingCount = collectPendingApprovals(state).length;
  const runningCount = state.conversations.filter(
    (c) => (state.includeSubagents || !c.parentConversationId) && isRunningStatus(c.status)
  ).length;

  const filters = [
    { id: 'all', label: `全部 (${state.conversations.filter((c) => state.includeSubagents || !c.parentConversationId).length})` },
    { id: 'waiting', label: `待审批 (${pendingCount})` },
    { id: 'running', label: `运行中 (${runningCount})` },
  ];

  for (const f of filters) {
    refs.filterRow.appendChild(
      el('button', {
        type: 'button',
        className: 'rc-chip',
        'aria-pressed': state.filter === f.id ? 'true' : 'false',
        text: f.label,
        onClick: () => {
          state.filter = f.id;
          renderFilterChips();
          renderSidebarList();
        },
      })
    );
  }

  refs.filterRow.appendChild(
    el('button', {
      type: 'button',
      className: 'rc-chip',
      'aria-pressed': state.includeSubagents ? 'true' : 'false',
      text: '含子代理',
      onClick: () => {
        state.includeSubagents = !state.includeSubagents;
        renderFilterChips();
        renderSidebarList();
        if (wsClient) {
          wsClient.refreshList(state.includeSubagents).then(applyConvoListResult).catch(() => {});
        }
      },
    })
  );
}

function renderSidebarList() {
  const refs = ensureWorkspaceShell();
  clearNode(refs.sidebarList);

  const pendingApprovals = collectPendingApprovals(state);
  if (pendingApprovals.length > 0) {
    refs.sidebarList.appendChild(
      el('div', { className: 'rc-sec-label', text: `待审批队列 (${pendingApprovals.length})` })
    );
    for (const item of pendingApprovals) {
      const preview = item.commandLine || item.action || item.interactionCase || '等待确认';
      refs.sidebarList.appendChild(
        el(
          'button',
          {
            type: 'button',
            className: 'rc-approval-item',
            onClick: () => selectConversation(item.cascadeId),
          },
          el(
            'div',
            { className: 'rc-convo-top' },
            el('span', {
              className: 'rc-convo-title',
              text: item.parentTitle ? `[子代理] ${item.title}` : item.title,
            }),
            el('span', { className: 'rc-pill', 'data-tone': 'warn', text: item.toolName || '审批' })
          ),
          el('div', { className: 'rc-mono', text: preview })
        )
      );
    }
  }

  const list = filterConversations(state);
  refs.sidebarList.appendChild(
    el('div', { className: 'rc-sec-label', text: `会话列表 (${list.length})` })
  );

  if (list.length === 0) {
    refs.sidebarList.appendChild(
      el('div', { className: 'rc-empty', text: '当前筛选条件下没有会话' })
    );
    return;
  }

  for (const c of list) {
    const waitCount = getEffectiveWaitingCount(state, c);
    const statusInfo = normalizeRunStatus(c.status);
    const isSelected = state.selectedId === c.id;
    const wtMeta = state.studioOverview?.worktreeByCid?.[c.id] || null;
    const itemBtn = el(
      'button',
      {
        type: 'button',
        className: 'rc-convo-item',
        'data-selected': isSelected ? 'true' : 'false',
        'data-waiting': waitCount > 0 ? 'true' : 'false',
        onClick: () => selectConversation(c.id),
      },
      el(
        'div',
        { className: 'rc-convo-top' },
        el('span', { className: 'rc-convo-title', text: c.title || c.summary || c.id.slice(0, 8) }),
        waitCount > 0
          ? el('span', { className: 'rc-pill', 'data-tone': 'warn', text: `待审批 ${waitCount}` })
          : el('span', { className: 'rc-pill', 'data-tone': statusInfo.tone, text: statusInfo.label })
      ),
      el(
        'div',
        { className: 'rc-convo-meta' },
        c.parentConversationId ? el('span', { className: 'rc-pill', text: 'Subagent' }) : null,
        wtMeta?.branch ? el('span', { className: 'rc-pill', 'data-tone': 'info', text: `⎇ ${wtMeta.branch}` }) : null,
        el('span', { text: `${c.stepCount ?? 0} steps` }),
        c.lastModifiedTime ? el('span', { text: `· ${formatRelativeTime(c.lastModifiedTime)}` }) : null
      )
    );
    refs.sidebarList.appendChild(itemBtn);
  }
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
    if (!state.selectedId && result.conversations.length > 0 && window.innerWidth >= 840) {
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
      state.studioOverview = ov;
      if (state.identity) {
        renderStudioPanels();
        renderSidebarList();
        renderDetailTimeline();
        syncComposerControls();
      }
    })
    .catch(() => {});
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

async function selectConversation(cascadeId) {
  if (!cascadeId || !UUID_RE.test(cascadeId)) return;
  if (state.selectedId !== cascadeId) {
    state.draftIdempotencyKey = createIdempotencyKey();
    state.turboWriteConfirmed = false;
    state.resumeState = null;
    state.actionError = '';
    state.actionNotice = '';
    resetCancelConfirm();
  }
  state.selectedId = cascadeId;
  state.mobileView = 'detail';
  state.snapshotError = '';
  state.snapshotLoading = !state.snapshots.has(cascadeId);
  renderWorkspace();

  if (!wsClient) return;
  refreshStudioOverview(cascadeId);
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
  if (state.selectedId) {
    fetchAndRenderSnapshot(state.selectedId);
  }
}

function handleTapDelta(delta) {
  const { kind, data } = delta;
  if (!data || typeof data !== 'object') return;

  if (kind === 'host_status') {
    if ('hostAttached' in data) state.hostAttached = Boolean(data.hostAttached);
    if ('globalPreset' in data) updateGlobalPreset(data.globalPreset);
    if ('capabilities' in data) state.capabilities = data.capabilities;
    if ('source' in data) state.source = data.source;
    renderTopStatus();
    return;
  }

  if (kind === 'summaries') {
    if (data.globalPreset !== undefined) updateGlobalPreset(data.globalPreset);
    if (data.source) state.source = data.source;
    if (Array.isArray(data.conversations)) {
      state.conversations = data.conversations;
    } else {
      const next = new Map(state.conversations.map((c) => [c.id, c]));
      if (Array.isArray(data.changed)) {
        for (const item of data.changed) {
          if (item && item.id) {
            const prevItem = next.get(item.id) || {};
            const merged = { ...prevItem, ...item };
            if ('waitingSteps' in item && !('waitingSubagents' in item)) {
              merged.waitingSubagents = Array.isArray(prevItem.waitingSubagents) ? prevItem.waitingSubagents : [];
            }
            next.set(item.id, merged);
          }
        }
      }
      if (Array.isArray(data.removed)) {
        for (const rmId of data.removed) {
          next.delete(rmId);
        }
      }
      if (data.summaries && typeof data.summaries === 'object') {
        for (const [cid, patch] of Object.entries(data.summaries)) {
          if (patch === null) next.delete(cid);
          else next.set(cid, { ...(next.get(cid) || { id: cid }), ...patch, id: cid });
        }
      }
      if (data.byParent && typeof data.byParent === 'object') {
        const changedIds = new Set(Array.isArray(data.changed) ? data.changed.map((x) => x?.id).filter(Boolean) : []);
        const removedIds = new Set(Array.isArray(data.removed) ? data.removed : []);
        for (const [pid, conv] of next.entries()) {
          if (!conv) continue;
          const prevSubMap = new Map(
            (Array.isArray(conv.waitingSubagents) ? conv.waitingSubagents : [])
              .filter((s) => s && s.id && !removedIds.has(s.id))
              .map((s) => [s.id, s])
          );
          const queue = Array.isArray(data.byParent[pid]) ? [...data.byParent[pid]] : [];
          if (queue.length === 0) {
            if (!changedIds.has(pid) || !Array.isArray(conv.waitingSubagents)) {
              conv.waitingSubagents = [];
            }
            continue;
          }
          const seen = new Set([pid]);
          const wSubs = [];
          while (queue.length > 0) {
            const childId = queue.shift();
            if (!childId || seen.has(childId)) continue;
            seen.add(childId);
            const child = next.get(childId);
            if (child) {
              if (Array.isArray(child.waitingSteps) && child.waitingSteps.length > 0) {
                wSubs.push({
                  id: child.id,
                  title: child.title || child.summary || child.id,
                  waitingSteps: child.waitingSteps,
                });
              }
            } else if (prevSubMap.has(childId)) {
              const prevSub = prevSubMap.get(childId);
              if (Array.isArray(prevSub.waitingSteps) && prevSub.waitingSteps.length > 0) {
                wSubs.push(prevSub);
              }
            }
            const grand = data.byParent[childId];
            if (Array.isArray(grand)) {
              for (const g of grand) queue.push(g);
            }
          }
          conv.waitingSubagents = wSubs;
        }
      }
      state.conversations = Array.from(next.values());
    }
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
  if (wsClient) {
    wsClient.dispose();
    wsClient = null;
  }
  renderWorkspace();
  wsClient = createRemoteWsClient(state.identity, {
    onStatus: (status, detail) => {
      state.wsStatus = status;
      state.wsDetail = detail || '';
      if (state.identity) renderTopStatus();
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
      renderTopStatus();
    },
    onDelta: handleTapDelta,
    onSnapshot: (cid, snap) => {
      applySnapshot(cid, snap);
      if (state.selectedId === cid) {
        state.snapshotLoading = false;
        renderDetailTimeline();
        syncComposerControls();
      }
    },
    onError: () => {},
  });
}

async function boot() {
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
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
