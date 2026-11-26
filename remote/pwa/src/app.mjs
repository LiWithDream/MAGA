/**
 * MAGA Remote Control Week-1 PWA Entry (Zero-XSS, strict CSP, mobile + desktop responsive).
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import {
  clearDeviceIdentity,
  defaultDeviceName,
  generateDeviceKeyPair,
  loadDeviceIdentity,
  saveDeviceIdentity,
} from './crypto-store.mjs';
import {
  completeGatewayPairing,
  createRemoteWsClient,
  fetchGatewayHealth,
} from './ws-client.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const rootEl = document.getElementById('app');

/* Safe DOM helper — strictly textContent / setAttribute only */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props || {})) {
    if (val === undefined || val === null || val === false) continue;
    if (key === 'className') {
      node.className = String(val);
    } else if (key === 'text') {
      node.textContent = String(val);
    } else if (key === 'onClick' && typeof val === 'function') {
      node.addEventListener('click', val);
    } else if (key === 'onInput' && typeof val === 'function') {
      node.addEventListener('input', val);
    } else if (key === 'onChange' && typeof val === 'function') {
      node.addEventListener('change', val);
    } else if (key === 'onSubmit' && typeof val === 'function') {
      node.addEventListener('submit', val);
    } else if (key === 'disabled') {
      node.disabled = Boolean(val);
    } else if (key === 'checked') {
      node.checked = Boolean(val);
    } else if (key === 'value') {
      node.value = String(val);
    } else if (key === 'open') {
      node.open = Boolean(val);
    } else {
      node.setAttribute(key, String(val));
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function formatTime(ts) {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? ts : Date.parse(String(ts));
  if (!Number.isFinite(ms)) return '';
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function isRunningStatus(status) {
  if (status === 2 || status === 8) return true;
  const s = String(status || '').toUpperCase();
  return s.includes('RUNNING') || s.includes('WAITING');
}

function normalizeRunStatus(status) {
  if (status === 2) return { label: '运行中', tone: 'info' };
  if (status === 8) return { label: '待处理', tone: 'warn' };
  if (status === 4 || status === 7) return { label: '错误', tone: 'danger' };
  if (status === 6) return { label: '已取消', tone: 'neutral' };
  const s = String(status || '').toUpperCase();
  if (s.includes('RUNNING')) return { label: '运行中', tone: 'info' };
  if (s.includes('ERROR') || s.includes('FAIL')) return { label: '错误', tone: 'danger' };
  if (s.includes('CANCEL')) return { label: '已取消', tone: 'neutral' };
  if (s.includes('IDLE') || status === 1 || status === 3) return { label: '空闲', tone: 'neutral' };
  return { label: s || '未知', tone: 'neutral' };
}

function normalizeStepStatus(status) {
  if (status === 1) return { label: 'QUEUED', tone: 'neutral' };
  if (status === 2) return { label: 'RUNNING', tone: 'info' };
  if (status === 3) return { label: 'DONE', tone: 'ok' };
  if (status === 4 || status === 7) return { label: 'ERROR', tone: 'danger' };
  if (status === 5) return { label: 'CLEARED', tone: 'neutral' };
  if (status === 6) return { label: 'CANCELED', tone: 'warn' };
  if (status === 8) return { label: 'WAITING', tone: 'warn' };
  const s = String(status || '').toUpperCase();
  if (s === 'DONE') return { label: 'DONE', tone: 'ok' };
  if (s === 'RUNNING') return { label: 'RUNNING', tone: 'info' };
  if (s === 'ERROR') return { label: 'ERROR', tone: 'danger' };
  return { label: s || 'STEP', tone: 'neutral' };
}

function formatPresetBadge(preset) {
  const n = Number(preset);
  if (n === 3) return { label: 'TURBO (3)', tone: 'danger' };
  if (n === 2) return { label: 'REVIEW (2)', tone: 'ok' };
  if (n === 1) return { label: 'SAFE (1)', tone: 'ok' };
  if (Number.isFinite(n)) return { label: `Preset ${n}`, tone: 'neutral' };
  return { label: 'Preset 未知', tone: 'neutral' };
}

function normalizeWsStatus(status) {
  switch (status) {
    case 'connected':
      return { label: '已连接', tone: 'ok' };
    case 'connecting':
      return { label: '握手连接中', tone: 'warn' };
    case 'reconnecting':
      return { label: state.wsDetail || '重连中…', tone: 'warn' };
    case 'revoked':
      return { label: '设备已吊销', tone: 'danger' };
    case 'error':
      return { label: state.wsDetail || '连接异常', tone: 'danger' };
    default:
      return { label: '未连接', tone: 'neutral' };
  }
}

function shortFingerprint(fp) {
  const s = String(fp || '');
  if (!s) return '未知';
  if (s.length <= 20) return s;
  return `${s.slice(0, 10)}…${s.slice(-8)}`;
}

function collectPendingApprovals() {
  const out = [];
  const seenKeys = new Set();
  const byId = new Map(state.conversations.map((c) => [c.id, c]));

  const pushWaiting = (cascadeId, title, parentTitle, isSubagent, w) => {
    if (!w || typeof w !== 'object') return;
    const key = `${cascadeId}:${w.stepIndex ?? ''}:${w.waitingStepHash || w.toolName || ''}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    out.push({
      cascadeId,
      title,
      parentTitle,
      isSubagent,
      ...w,
    });
  };

  for (const convo of state.conversations) {
    const parentTitle = convo.parentConversationId ? byId.get(convo.parentConversationId)?.title || null : null;
    const list = Array.isArray(convo.waitingSteps) ? convo.waitingSteps : [];
    for (const w of list) {
      pushWaiting(
        convo.id,
        convo.title || convo.summary || convo.id.slice(0, 8),
        parentTitle,
        Boolean(convo.parentConversationId),
        w
      );
    }

    const subList = Array.isArray(convo.waitingSubagents) ? convo.waitingSubagents : [];
    for (const sub of subList) {
      if (!sub || !sub.id) continue;
      const subTitle = sub.title || sub.summary || sub.id.slice(0, 8);
      const subWaiting = Array.isArray(sub.waitingSteps) ? sub.waitingSteps : [];
      for (const w of subWaiting) {
        pushWaiting(sub.id, subTitle, convo.title || convo.summary || convo.id.slice(0, 8), true, w);
      }
    }
  }
  return out;
}

function getEffectiveWaitingCount(convo) {
  let count = Array.isArray(convo.waitingSteps) ? convo.waitingSteps.length : 0;
  const countedSubIds = new Set();
  const subList = Array.isArray(convo.waitingSubagents) ? convo.waitingSubagents : [];
  for (const sub of subList) {
    if (!sub || !sub.id) continue;
    countedSubIds.add(sub.id);
    count += Array.isArray(sub.waitingSteps) ? sub.waitingSteps.length : 0;
  }
  for (const c of state.conversations) {
    if (c.parentConversationId === convo.id && !countedSubIds.has(c.id) && Array.isArray(c.waitingSteps)) {
      count += c.waitingSteps.length;
    }
  }
  return count;
}

function findConversationMeta(cascadeId) {
  if (!cascadeId) return null;
  const direct = state.conversations.find((c) => c.id === cascadeId);
  if (direct) return direct;
  for (const parent of state.conversations) {
    const subList = Array.isArray(parent.waitingSubagents) ? parent.waitingSubagents : [];
    const hit = subList.find((sub) => sub && sub.id === cascadeId);
    if (hit) {
      return {
        id: hit.id,
        title: hit.title || hit.summary || hit.id,
        summary: hit.summary || '',
        status: 'WAITING',
        parentConversationId: parent.id,
        waitingSteps: Array.isArray(hit.waitingSteps) ? hit.waitingSteps : [],
      };
    }
  }
  return null;
}

function filterConversations() {
  const q = state.searchQuery.trim().toLowerCase();
  return state.conversations
    .filter((c) => {
      if (!state.includeSubagents && c.parentConversationId) return false;
      if (state.filter === 'running' && !isRunningStatus(c.status)) return false;
      if (state.filter === 'waiting' && getEffectiveWaitingCount(c) === 0) return false;
      if (q) {
        const hay = `${c.title || ''} ${c.summary || ''} ${c.id || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const wa = getEffectiveWaitingCount(a) > 0 ? 1 : 0;
      const wb = getEffectiveWaitingCount(b) > 0 ? 1 : 0;
      if (wa !== wb) return wb - wa;
      const ta = Number(a.lastModifiedTime || 0) || Date.parse(a.lastModifiedTime || 0) || 0;
      const tb = Number(b.lastModifiedTime || 0) || Date.parse(b.lastModifiedTime || 0) || 0;
      return tb - ta;
    });
}

/* ---------------- Pairing Flow ---------------- */

async function loadHealthForPairing() {
  try {
    const health = await fetchGatewayHealth();
    state.health = health;
    state.globalPreset = health.globalPreset ?? null;
    state.hostAttached = Boolean(health.hostAttached);
    state.capabilities = health.capabilities || null;
    state.pairingError = '';
  } catch (err) {
    state.pairingError = String(err?.message || '无法连接到 AGY Studio Remote 网关');
  }
  render();
}

function requiresTurboAck(preset) {
  return preset === null || preset === undefined || Number(preset) === 3 || !Number.isFinite(Number(preset));
}

async function handlePairSubmit(ev) {
  ev.preventDefault();
  if (state.pairingBusy) return;
  const code = state.pairingCode.trim();
  const deviceName = state.deviceName.trim() || defaultDeviceName();
  if (!code) {
    state.pairingError = '请输入一次性配对码';
    render();
    return;
  }

  state.pairingBusy = true;
  state.pairingError = '';
  render();

  try {
    // Re-check health immediately before pairing so TURBO / unknown preset cannot be bypassed
    const freshHealth = await fetchGatewayHealth();
    state.health = freshHealth;
    state.globalPreset = freshHealth.globalPreset ?? null;

    if (requiresTurboAck(freshHealth.globalPreset) && !state.turboAcknowledged) {
      state.pairingBusy = false;
      state.pairingError =
        Number(freshHealth.globalPreset) === 3
          ? '本机当前为 TURBO 权限模式，请先阅读安全告知并勾选确认框'
          : '未能确认本机安全预设（按 TURBO 最高风险门禁），请先阅读告知并勾选确认框';
      render();
      return;
    }

    const { privateKey, publicKeyJwk } = await generateDeviceKeyPair();
    const res = await completeGatewayPairing({
      code,
      deviceName,
      publicKeyJwk,
      turboAcknowledged: Boolean(state.turboAcknowledged),
    });

    const identity = await saveDeviceIdentity({
      deviceId: res.deviceId,
      deviceName,
      role: res.role || 'observe',
      gatewayFingerprint: res.gatewayFingerprint || freshHealth.gatewayFingerprint || '',
      privateKey,
      publicKeyJwk,
    });

    state.identity = identity;
    state.pairingCode = '';
    state.pairingBusy = false;
    startWorkspaceSession();
  } catch (err) {
    state.pairingBusy = false;
    state.pairingError = String(err?.message || '配对失败');
    render();
  }
}

function renderPairingScreen() {
  clearNode(rootEl);
  rootEl.setAttribute('data-mobile-view', 'list');

  const preset = state.health?.globalPreset;
  const needTurboAck = requiresTurboAck(preset);
  const isExplicitTurbo = Number(preset) === 3;
  const presetInfo = formatPresetBadge(preset);
  const fp = state.health?.gatewayFingerprint || '';

  const form = el(
    'form',
    { className: 'rc-pair-card', onSubmit: handlePairSubmit },
    el(
      'div',
      { className: 'rc-pair-brand' },
      el(
        'div',
        {},
        el('h1', { className: 'rc-pair-title', text: 'AGY Studio Remote' }),
        el('p', {
          className: 'rc-pair-sub',
          text: '设备密钥由浏览器 WebCrypto 生成且不可导出',
        })
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'rc-btn is-sm',
          onClick: () => loadHealthForPairing(),
          text: '刷新状态',
        }
      )
    ),
    el(
      'div',
      { className: 'rc-meta-box' },
      el(
        'div',
        { className: 'rc-meta-row' },
        el('span', { text: '网关传输与宿主' }),
        el('span', {
          className: 'rc-pill',
          'data-tone': state.health?.hostAttached ? 'ok' : 'warn',
          text: state.health
            ? `${state.health.transport || 'loopback'} · ${state.health.hostAttached ? 'CDP 已挂载' : '宿主离线(磁盘只读)'}`
            : '检测中…',
        })
      ),
      el(
        'div',
        { className: 'rc-meta-row' },
        el('span', { text: '本机权限预设' }),
        el('span', {
          className: 'rc-pill',
          'data-tone': presetInfo.tone,
          text: presetInfo.label,
        })
      ),
      el(
        'div',
        { className: 'rc-meta-row' },
        el('span', { text: '网关指纹' }),
        el(
          'button',
          {
            type: 'button',
            className: 'rc-btn is-ghost is-sm rc-mono',
            onClick: () => {
              state.showFullFingerprint = !state.showFullFingerprint;
              render();
            },
            text: state.showFullFingerprint ? fp || '未知' : shortFingerprint(fp),
          }
        )
      )
    ),
    needTurboAck
      ? el(
          'div',
          { className: 'rc-turbo-alert', role: 'alert' },
          el('div', {
            className: 'rc-turbo-alert-title',
            text: isExplicitTurbo
              ? '⚠ 高危安全告知：本机当前为 TURBO 权限模式 (globalPreset = 3)'
              : '⚠ 安全告知：未能确认本机权限预设（按 TURBO 门禁处理）',
          }),
          el('div', {
            text: '在 TURBO 模式下，本机命令行与文件操作会自动执行而不会弹出审批弹窗。Week 1 为只读观察模式；后续开放写操作后，远程指令权限等同本机 Shell。请务必在核对网关指纹后，仅配对您本人完全信任的设备。',
          }),
          el(
            'label',
            { className: 'rc-turbo-check', for: 'rc-turbo-ack' },
            el('input', {
              id: 'rc-turbo-ack',
              type: 'checkbox',
              checked: state.turboAcknowledged,
              onChange: (ev) => {
                state.turboAcknowledged = Boolean(ev.target.checked);
                updatePairSubmitButton();
              },
            }),
            el('span', { text: '我已知晓本机当前为 TURBO 权限模式' })
          )
        )
      : null,
    el(
      'div',
      { className: 'rc-field' },
      el('label', { className: 'rc-label', for: 'rc-pair-code', text: '一次性配对码（Mac 端运行 maga remote pair 获取）' }),
      el('input', {
        id: 'rc-pair-code',
        className: 'rc-input is-code',
        type: 'text',
        autocomplete: 'one-time-code',
        placeholder: '输入配对码',
        value: state.pairingCode,
        onInput: (ev) => {
          state.pairingCode = ev.target.value;
          updatePairSubmitButton();
        },
      })
    ),
    el(
      'div',
      { className: 'rc-field' },
      el('label', { className: 'rc-label', for: 'rc-device-name', text: '设备备注名称' }),
      el('input', {
        id: 'rc-device-name',
        className: 'rc-input',
        type: 'text',
        maxlength: '48',
        placeholder: '例如：iPhone 16 Pro',
        value: state.deviceName,
        onInput: (ev) => {
          state.deviceName = ev.target.value;
        },
      })
    ),
    state.pairingError ? el('div', { className: 'rc-error-banner', text: state.pairingError }) : null,
    el('button', {
      id: 'rc-pair-submit',
      type: 'submit',
      className: 'rc-btn is-primary',
      disabled: computePairSubmitDisabled(),
      text: state.pairingBusy ? '正在生成不可导出密钥并配对…' : '生成设备密钥并完成配对',
    })
  );

  rootEl.appendChild(el('div', { className: 'rc-pair-wrap' }, form));
}

function computePairSubmitDisabled() {
  if (state.pairingBusy) return true;
  if (!state.pairingCode.trim()) return true;
  if (requiresTurboAck(state.health?.globalPreset) && !state.turboAcknowledged) return true;
  return false;
}

function updatePairSubmitButton() {
  const btn = document.getElementById('rc-pair-submit');
  if (btn) btn.disabled = computePairSubmitDisabled();
}

/* ---------------- Workspace Flow ---------------- */

let workspaceRefs = null;

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
      loadHealthForPairing();
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

  const wsInfo = normalizeWsStatus(state.wsStatus);
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
          loadHealthForPairing();
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

  const pendingCount = collectPendingApprovals().length;
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

  const pendingApprovals = collectPendingApprovals();
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

  const list = filterConversations();
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
    const waitCount = getEffectiveWaitingCount(c);
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

function renderStepCard(step) {
  const typeStr = String(step.type || 'STEP');
  const statusInfo = normalizeStepStatus(step.status);

  let roleLabel = typeStr;
  if (typeStr === 'USER_INPUT' || typeStr === '14') roleLabel = '用户';
  else if (typeStr === 'PLANNER_RESPONSE' || typeStr === '15') roleLabel = '助手';
  else if (typeStr === 'GENERIC' || typeStr === '132') roleLabel = '工具调用';
  else if (typeStr === 'ERROR_MESSAGE' || typeStr === '17') roleLabel = '错误';
  else if (typeStr === 'CHECKPOINT' || typeStr === '23') roleLabel = '压缩检查点';
  else if (typeStr === 'SYSTEM_MESSAGE' || typeStr === '101') roleLabel = '系统';

  const card = el(
    'article',
    { className: 'rc-step', 'data-type': typeStr },
    el(
      'div',
      { className: 'rc-step-head' },
      el('span', { className: 'rc-step-role', text: `${roleLabel} #${step.idx ?? '?'}` }),
      el(
        'div',
        { className: 'rc-dock-group' },
        step.createdAt ? el('span', { text: formatTime(step.createdAt) }) : null,
        el('span', { className: 'rc-pill', 'data-tone': statusInfo.tone, text: statusInfo.label })
      )
    )
  );

  if (step.thinking) {
    const thinkingText = String(step.thinking);
    card.appendChild(
      el(
        'details',
        { className: 'rc-details' },
        el('summary', { text: `Thinking 思考过程 (${thinkingText.length} 字符，点击展开)` }),
        el('div', { className: 'rc-details-body' }, el('pre', { className: 'rc-pre', text: thinkingText }))
      )
    );
  }

  if (step.text) {
    card.appendChild(el('div', { className: 'rc-step-text', text: String(step.text) }));
  }

  if (Array.isArray(step.toolCalls) && step.toolCalls.length > 0) {
    for (const tc of step.toolCalls) {
      const name = tc?.name || tc?.toolName || 'tool';
      const rawArgs = tc?.args ?? tc?.arguments ?? tc?.argumentsJson ?? '';
      const argsText =
        typeof rawArgs === 'string'
          ? rawArgs
          : rawArgs
            ? JSON.stringify(rawArgs, null, 2)
            : '';
      const outText =
        typeof tc?.output === 'string'
          ? tc.output
          : tc?.output
            ? JSON.stringify(tc.output, null, 2)
            : '';
      const tcId = tc?.id ?? tc?.callId ?? '';

      card.appendChild(
        el(
          'details',
          { className: 'rc-details' },
          el('summary', { text: `Tool · ${name}${tcId ? ` (${String(tcId).slice(0, 10)})` : ''}` }),
          el(
            'div',
            { className: 'rc-details-body' },
            argsText ? el('pre', { className: 'rc-pre', text: argsText }) : null,
            outText ? el('pre', { className: 'rc-pre', text: outText }) : null
          )
        )
      );
    }
  }

  if (step.error) {
    const errText = typeof step.error === 'string' ? step.error : JSON.stringify(step.error, null, 2);
    card.appendChild(el('pre', { className: 'rc-pre', text: errText }));
  }

  return card;
}

function renderWaitingCards(waitingSteps) {
  if (!Array.isArray(waitingSteps) || waitingSteps.length === 0) return [];
  return waitingSteps.map((w) =>
    el(
      'div',
      { className: 'rc-waiting-card' },
      el(
        'div',
        { className: 'rc-waiting-head' },
        el('span', { text: `⏳ 等待审批 · ${w.toolName || w.interactionCase || '操作确认'}` }),
        el('span', {
          className: 'rc-pill',
          'data-tone': 'warn',
          text: `step #${w.stepIndex ?? '?'}`,
        })
      ),
      w.commandLine ? el('pre', { className: 'rc-pre', text: String(w.commandLine) }) : null,
      w.action ? el('div', { className: 'rc-mono', text: `动作: ${w.action}` }) : null,
      el('div', {
        className: 'rc-convo-meta',
        text: `Week 1 只读态：请在 Mac 桌面端点击 Allow Once / Deny（远程审批将于 Week 2 开放）${w.waitingStepHash ? ` · hash:${String(w.waitingStepHash).slice(0, 8)}` : ''}`,
      })
    )
  );
}

function renderDetailTimeline() {
  const refs = ensureWorkspaceShell();
  const cid = state.selectedId;
  const convo = findConversationMeta(cid);
  const snap = cid ? state.snapshots.get(cid) : null;
  const streamEntry = cid ? state.streams.get(cid) : null;
  const streamText =
    typeof streamEntry === 'string'
      ? streamEntry
      : streamEntry?.text ?? streamEntry?.streamingText ?? snap?.streamingText ?? '';
  const streamThinking = typeof streamEntry === 'object' && streamEntry ? streamEntry.thinkingText || '' : '';

  if (!cid) {
    refs.detailTitle.textContent = '请选择一个会话';
    clearNode(refs.detailSub);
    clearNode(refs.timeline);
    refs.timeline.appendChild(
      el('div', { className: 'rc-empty', text: '从左侧选择一个会话以查看消息时间线、工具调用与实时流。' })
    );
    return;
  }

  refs.detailTitle.textContent = convo?.title || convo?.summary || cid;
  clearNode(refs.detailSub);
  const runInfo = normalizeRunStatus(snap?.status ?? convo?.status);
  refs.detailSub.append(
    el('span', { className: 'rc-pill', 'data-tone': runInfo.tone, text: runInfo.label }),
    el('span', { className: 'rc-mono', text: cid.slice(0, 13) }),
    snap?.source ? el('span', { text: `来源: ${snap.source}` }) : null
  );

  const wasNearBottom =
    refs.timeline.scrollHeight - refs.timeline.scrollTop - refs.timeline.clientHeight < 110;

  clearNode(refs.timeline);

  if (state.snapshotLoading && !snap) {
    refs.timeline.appendChild(el('div', { className: 'rc-empty', text: '正在加载会话快照…' }));
    return;
  }

  if (state.snapshotError && !snap) {
    refs.timeline.appendChild(el('div', { className: 'rc-error-banner', text: state.snapshotError }));
    return;
  }

  const waiting = snap?.waitingSteps?.length ? snap.waitingSteps : convo?.waitingSteps || [];
  for (const card of renderWaitingCards(waiting)) {
    refs.timeline.appendChild(card);
  }

  const subWaitingList = Array.isArray(convo?.waitingSubagents) ? convo.waitingSubagents : [];
  for (const sub of subWaitingList) {
    if (!sub || !sub.id || !Array.isArray(sub.waitingSteps) || sub.waitingSteps.length === 0) continue;
    const firstW = sub.waitingSteps[0];
    refs.timeline.appendChild(
      el(
        'div',
        { className: 'rc-waiting-card' },
        el(
          'div',
          { className: 'rc-waiting-head' },
          el('span', { text: `⏳ 子代理等待审批 · ${sub.title || sub.summary || sub.id.slice(0, 8)}` }),
          el('span', { className: 'rc-pill', 'data-tone': 'warn', text: `${sub.waitingSteps.length} 项` })
        ),
        firstW?.commandLine ? el('pre', { className: 'rc-pre', text: String(firstW.commandLine) }) : null,
        el(
          'div',
          { className: 'rc-dock-group' },
          el('button', {
            type: 'button',
            className: 'rc-btn is-sm',
            text: '查看并实时跟踪该子代理',
            onClick: () => selectConversation(sub.id),
          })
        )
      )
    );
  }

  const steps = Array.isArray(snap?.steps) ? snap.steps : [];
  if (steps.length === 0 && !streamText) {
    refs.timeline.appendChild(el('div', { className: 'rc-empty', text: '该会话暂无可显示步骤。' }));
  } else {
    for (const step of steps) {
      refs.timeline.appendChild(renderStepCard(step));
    }
  }

  if (streamText || streamThinking) {
    refs.timeline.appendChild(
      el(
        'div',
        { className: 'rc-stream-card' },
        el(
          'div',
          { className: 'rc-stream-head' },
          el('span', { className: 'rc-pulse' }),
          el('span', { text: '实时生成流' })
        ),
        streamThinking
          ? el(
              'details',
              { className: 'rc-details' },
              el('summary', { text: `实时 Thinking (${streamThinking.length} 字符)` }),
              el('div', { className: 'rc-details-body' }, el('pre', { className: 'rc-pre', text: streamThinking }))
            )
          : null,
        streamText ? el('div', { className: 'rc-step-text', text: String(streamText) }) : null
      )
    );
  }

  if (wasNearBottom) {
    refs.timeline.scrollTop = refs.timeline.scrollHeight;
  }
}

function renderWorkspace() {
  renderTopStatus();
  renderFilterChips();
  renderSidebarList();
  renderDetailTimeline();
}

function render() {
  if (!state.identity) {
    renderPairingScreen();
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

  await loadHealthForPairing();
}

boot();
