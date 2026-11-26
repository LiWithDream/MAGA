/**
 * AGY Studio Remote Control PWA Entry (Zero-XSS, strict CSP, mobile + desktop responsive).
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import {
  clearDeviceIdentity,
  defaultDeviceName,
  loadDeviceIdentity,
} from './crypto-store.mjs';
import { createPairViewController } from './pair-view.mjs';
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
} from './ui-helpers.mjs';
import { createRemoteWsClient } from './ws-client.mjs';

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
};

let wsClient = null;
let snapshotRefreshTimer = null;
let workspaceRefs = null;
const rootEl = document.getElementById('app');

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

  const readonlyBanner = el(
    'div',
    { className: 'rc-readonly-banner' },
    el('span', {
      text: 'Week 1 只读观察模式：可实时追踪消息、思考与待审批状态；续写、停止与审批操作将在 Week 2 开放。',
    }),
    el('span', { className: 'rc-pill', 'data-tone': 'info', text: 'READ-ONLY' })
  );

  const timeline = el('div', { className: 'rc-timeline' });

  const bottomDock = el(
    'footer',
    { className: 'rc-bottom-dock' },
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
    el(
      'div',
      { className: 'rc-dock-group' },
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm',
        disabled: true,
        title: '写操作将在 Week 2 开放',
        text: '续写 (Week 2)',
      }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm',
        disabled: true,
        title: '取消操作将在 Week 2 开放',
        text: '停止 (Week 2)',
      })
    )
  );

  const detail = el(
    'section',
    { className: 'rc-detail' },
    detailHead,
    readonlyBanner,
    timeline,
    bottomDock
  );

  const main = el('main', { className: 'rc-main' }, sidebar, detail);
  rootEl.append(topbar, noticeBar, main);

  workspaceRefs = {
    brandDot,
    wsPill,
    hostPill,
    presetPill,
    devicePill,
    noticeBar,
    filterRow,
    sidebarList,
    detailTitle,
    detailSub,
    timeline,
  };
  return workspaceRefs;
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
  });
}

function renderWorkspace() {
  renderTopStatus();
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
  if (result.globalPreset !== undefined) state.globalPreset = result.globalPreset;
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

function applySnapshot(cascadeId, snap) {
  if (!cascadeId || !snap) return;
  state.snapshots.set(cascadeId, snap);
  if (typeof snap.streamingText === 'string' && snap.streamingText) {
    const steps = Array.isArray(snap.steps) ? snap.steps : [];
    const lastIdx = steps.length > 0 ? steps[steps.length - 1].idx : 0;
    state.streams.set(cascadeId, {
      stepIdx: lastIdx,
      text: snap.streamingText,
      thinkingText: '',
      status: snap.status || '',
      stepCount: steps.length,
    });
  } else if (!isRunningStatus(snap.status)) {
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
    state.snapshotError = String(err?.message || '获取会话快照失败');
  } finally {
    state.snapshotLoading = false;
    if (state.selectedId === cascadeId) renderDetailTimeline();
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
  state.selectedId = cascadeId;
  state.mobileView = 'detail';
  state.snapshotError = '';
  state.snapshotLoading = !state.snapshots.has(cascadeId);
  renderWorkspace();

  if (!wsClient) return;
  try {
    const snap = await wsClient.watchConversation(cascadeId);
    if (snap && state.selectedId === cascadeId) {
      applySnapshot(cascadeId, snap);
      state.snapshotLoading = false;
      renderDetailTimeline();
    }
  } catch (err) {
    state.snapshotLoading = false;
    state.snapshotError = String(err?.message || '加载会话失败');
    if (state.selectedId === cascadeId) renderDetailTimeline();
  }
}

function refreshAllData() {
  if (!wsClient) return;
  wsClient.refreshList(state.includeSubagents).then(applyConvoListResult).catch(() => {});
  if (state.selectedId) {
    fetchAndRenderSnapshot(state.selectedId);
  }
}

function handleTapDelta(delta) {
  const { kind, data } = delta;
  if (!data || typeof data !== 'object') return;

  if (kind === 'host_status') {
    if ('hostAttached' in data) state.hostAttached = Boolean(data.hostAttached);
    if ('globalPreset' in data) state.globalPreset = data.globalPreset;
    if ('capabilities' in data) state.capabilities = data.capabilities;
    if ('source' in data) state.source = data.source;
    renderTopStatus();
    return;
  }

  if (kind === 'summaries') {
    if (data.globalPreset !== undefined) state.globalPreset = data.globalPreset;
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

    if (isFinished && !nextText && !nextThinking) {
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
      if (msg.health) {
        state.hostAttached = Boolean(msg.health.hostAttached);
        state.globalPreset = msg.health.globalPreset ?? state.globalPreset;
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
      renderTopStatus();
    },
    onDelta: handleTapDelta,
    onSnapshot: (cid, snap) => {
      applySnapshot(cid, snap);
      if (state.selectedId === cid) {
        state.snapshotLoading = false;
        renderDetailTimeline();
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
