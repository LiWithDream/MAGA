/**
 * AGY Studio Remote PWA — Mobile Enhancements:
 * - New Conversation Modal (Project selector + prompt + TURBO ack)
 * - Completion & Pending-Approval Alert Manager (Title badge + Haptics + Web Notification)
 * - Collapsible Per-Session TURBO Confirmation UI Helper
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import { appendNodes, clearNode, el, isRunningStatus } from './ui-helpers.mjs';
import {
  bindNativeAndroidBridge,
  isNativeAndroidApp,
  openNativeSettingsDialog,
  requestNativeNotificationPermission,
  sendNativeNotification,
  vibrateNative,
} from './native-bridge.mjs';
export { bindNativeAndroidBridge };

const ALERTS_STORAGE_KEY = 'rc:alertsEnabled';

export const STORAGE_KEYS = {
  layoutPref: 'agy_remote_layout_mode',
  sidebarCollapsed: 'agy_remote_sidebar_collapsed',
  overviewCollapsed: 'agy_remote_overview_collapsed',
  sidebarGroupBy: 'agy_remote_sidebar_group',
};

export function readStoredPref(key, fallback) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback;
    const val = window.localStorage.getItem(key);
    return val === null ? fallback : val;
  } catch {
    return fallback;
  }
}

export function writeStoredPref(key, value) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(key, String(value));
  } catch {}
}

export function defaultOverviewCollapsed() {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < 1180;
}

export function bindViewportHeightSync() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  let rafId = 0;
  const apply = () => {
    rafId = 0;
    const innerH = Number(window.innerHeight || 0);
    const vvH = Number(window.visualViewport?.height || 0);
    const h = vvH > 0 && innerH > 0 ? Math.min(innerH, vvH) : vvH || innerH;
    if (h > 100) {
      document.documentElement.style.setProperty('--rc-app-h', `${Math.round(h)}px`);
    }
  };
  const schedule = () => {
    if (rafId) return;
    if (typeof window.requestAnimationFrame === 'function') {
      rafId = window.requestAnimationFrame(apply);
    } else {
      apply();
    }
  };
  const darkMql =
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const syncThemeMeta = () => {
    try {
      const dark = Boolean(darkMql?.matches);
      const color = dark ? '#212120' : '#ffffff';
      let liveMeta = document.getElementById('rc-theme-color-live');
      if (!liveMeta && document.head) {
        liveMeta = document.createElement('meta');
        liveMeta.id = 'rc-theme-color-live';
        liveMeta.setAttribute('name', 'theme-color');
        document.head.appendChild(liveMeta);
      }
      if (liveMeta) liveMeta.setAttribute('content', color);
    } catch {}
  };
  apply();
  syncThemeMeta();
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  if (darkMql && typeof darkMql.addEventListener === 'function') {
    darkMql.addEventListener('change', syncThemeMeta);
  }
  if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
    window.visualViewport.addEventListener('resize', schedule);
  }
  return () => {
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    if (darkMql && typeof darkMql.removeEventListener === 'function') {
      darkMql.removeEventListener('change', syncThemeMeta);
    }
    if (window.visualViewport && typeof window.visualViewport.removeEventListener === 'function') {
      window.visualViewport.removeEventListener('resize', schedule);
    }
  };
}

function readAlertsPref() {
  try {
    const raw = window.localStorage.getItem(ALERTS_STORAGE_KEY);
    if (raw === 'false') return false;
    return true;
  } catch {
    return true;
  }
}

function writeAlertsPref(enabled) {
  try {
    window.localStorage.setItem(ALERTS_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {}
}

export function createAlertManager({ baseTitle = 'AGY Studio Remote' } = {}) {
  let enabled = readAlertsPref();
  let seeded = false;
  const prevStateById = new Map(); // id -> { running, waitingCount }

  const isDocHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

  const vibratePattern = (pattern) => {
    if (vibrateNative(pattern)) return;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern);
      }
    } catch {}
  };

  const fireWebNotification = (title, body, tag, { category = 'completed', cascadeId = '' } = {}) => {
    if (sendNativeNotification({ title, body, tag, category, cascadeId })) return;
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      new Notification(title, { body, tag, silent: false });
    } catch {}
  };

  const setDocTitle = (nextTitle) => {
    try {
      if (typeof document !== 'undefined') document.title = nextTitle;
    } catch {}
  };

  const clearTitleBadge = () => {
    setDocTitle(baseTitle);
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!isDocHidden()) clearTitleBadge();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => clearTitleBadge());
  }

  function observeConversations(conversations = []) {
    if (!Array.isArray(conversations)) return { completed: [], approvals: [] };
    const completed = [];
    const approvals = [];
    const seenIds = new Set();

    for (const c of conversations) {
      if (!c || !c.id) continue;
      seenIds.add(c.id);
      const running = isRunningStatus(c.status);
      const waitingCount = Array.isArray(c.waitingSteps) ? c.waitingSteps.length : 0;
      const prev = prevStateById.get(c.id);
      if (seeded && prev) {
        if (waitingCount > prev.waitingCount) {
          approvals.push({
            id: c.id,
            title: c.title || c.summary || c.id.slice(0, 8),
            count: waitingCount,
          });
        } else if (prev.running && !running && waitingCount === 0) {
          completed.push({
            id: c.id,
            title: c.title || c.summary || c.id.slice(0, 8),
          });
        }
      }
      prevStateById.set(c.id, { running, waitingCount });
    }

    for (const id of Array.from(prevStateById.keys())) {
      if (!seenIds.has(id)) prevStateById.delete(id);
    }

    if (!seeded) {
      seeded = true;
      return { completed: [], approvals: [] };
    }

    if (!enabled) return { completed, approvals };

    if (approvals.length > 0) {
      const total = approvals.reduce((acc, a) => acc + a.count, 0);
      setDocTitle(`⏳ 待审批 (${total}) · ${baseTitle}`);
      vibratePattern([80, 60, 80]);
      if (isDocHidden() || isNativeAndroidApp()) {
        fireWebNotification('等待桌面端审批', `${approvals[0].title} 需要确认操作`, `agy-wait-${approvals[0].id}`, {
          category: 'approval',
          cascadeId: approvals[0].id,
        });
      }
    } else if (completed.length > 0) {
      if (isDocHidden() || isNativeAndroidApp()) {
        setDocTitle(`✓ 已完成 · ${baseTitle}`);
        fireWebNotification('任务已完成', completed[0].title, `agy-done-${completed[0].id}`, {
          category: 'completed',
          cascadeId: completed[0].id,
        });
      }
      vibratePattern([35, 50, 35]);
    }
    return { completed, approvals };
  }

  function toggleAlerts() {
    enabled = !enabled;
    writeAlertsPref(enabled);
    if (!enabled) {
      clearTitleBadge();
    } else {
      requestNativeNotificationPermission();
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
          Promise.resolve(Notification.requestPermission()).catch(() => {});
        }
      } catch {}
    }
    return enabled;
  }

  function getAlertLabel() {
    return enabled ? '完成与审批提醒：已开启' : '完成与审批提醒：已关闭';
  }

  function reset() {
    seeded = false;
    prevStateById.clear();
    clearTitleBadge();
  }

  return {
    isEnabled: () => enabled,
    getAlertLabel,
    toggleAlerts,
    observeConversations,
    clearTitleBadge,
    reset,
  };
}

export function syncTurboConfirmBar(labelEl, checkboxEl, textEl, { writable = false, needTurboConfirm = false, confirmed = false, busy = false } = {}) {
  if (!labelEl || !checkboxEl) return;
  const active = Boolean(writable && needTurboConfirm);
  checkboxEl.checked = Boolean(active && confirmed);
  checkboxEl.disabled = Boolean(busy);
  if (!active) {
    labelEl.classList.add('rc-hidden');
    labelEl.setAttribute('data-confirmed', 'false');
    return;
  }
  labelEl.classList.remove('rc-hidden');
  labelEl.setAttribute('data-confirmed', confirmed ? 'true' : 'false');
  if (textEl) {
    textEl.textContent = confirmed
      ? 'TURBO 本会话已确认（点击可撤销）'
      : 'TURBO 自动执行确认（远程发送将直接执行本机操作）';
  }
}

const newChatModalDom = new WeakMap();

export function renderNewChatModal(
  container,
  {
    open = false,
    projects = [],
    selectedProjectId = '',
    promptText = '',
    busy = false,
    errorText = '',
    needTurboConfirm = false,
    turboConfirmed = false,
    online = false,
    onProjectChange = null,
    onPromptChange = null,
    onTurboChange = null,
    onSubmit = null,
    onClose = null,
  } = {}
) {
  if (!container) return;
  if (!open) {
    if (newChatModalDom.has(container) || container.childNodes.length > 0) {
      clearNode(container);
      newChatModalDom.delete(container);
    }
    container.classList.add('rc-hidden');
    return;
  }
  container.classList.remove('rc-hidden');

  let dom = newChatModalDom.get(container);
  if (!dom || !dom.backdrop || dom.backdrop.parentNode !== container) {
    const handlers = {
      busy: false,
      onProjectChange: null,
      onPromptChange: null,
      onTurboChange: null,
      onSubmit: null,
      onClose: null,
    };

    const selectEl = el('select', {
      className: 'rc-select',
      onChange: (ev) => handlers.onProjectChange?.(ev.target.value),
    });

    const textareaEl = el('textarea', {
      className: 'rc-modal-textarea',
      rows: '4',
      placeholder: '输入首条指令，直接启动新会话…',
      onInput: (ev) => handlers.onPromptChange?.(ev.target.value),
    });
    textareaEl.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
        ev.preventDefault();
        handlers.onSubmit?.();
      }
    });

    const turboCheckbox = el('input', {
      type: 'checkbox',
      onChange: (ev) => handlers.onTurboChange?.(Boolean(ev.target.checked)),
    });
    const turboText = el('span');
    const turboRow = el('label', { className: 'rc-turbo-inline rc-hidden' }, turboCheckbox, turboText);

    const errorEl = el('div', { className: 'rc-action-banner rc-hidden', 'data-tone': 'danger' });

    const closeBtn = el('button', {
      type: 'button',
      className: 'rc-btn is-sm is-ghost',
      text: '关闭',
      onClick: () => handlers.onClose?.(),
    });
    const cancelBtn = el('button', {
      type: 'button',
      className: 'rc-btn is-sm',
      text: '取消',
      onClick: () => handlers.onClose?.(),
    });
    const submitBtn = el('button', {
      type: 'button',
      className: 'rc-btn is-sm is-primary rc-new-chat-submit',
      text: '开始对话',
      onClick: () => handlers.onSubmit?.(),
    });

    const card = el(
      'div',
      {
        className: 'rc-modal-card',
        onClick: (ev) => ev?.stopPropagation?.(),
      },
      el('div', { className: 'rc-model-pop-head' }, el('strong', { text: '新建会话' }), closeBtn),
      el('div', { className: 'rc-modal-field' }, el('label', { className: 'rc-modal-label', text: '所属项目' }), selectEl),
      el('div', { className: 'rc-modal-field' }, el('label', { className: 'rc-modal-label', text: '首条指令' }), textareaEl),
      turboRow,
      errorEl,
      el('div', { className: 'rc-modal-actions' }, cancelBtn, submitBtn)
    );

    const backdrop = el(
      'div',
      {
        className: 'rc-modal-backdrop',
        onClick: () => {
          if (!handlers.busy) handlers.onClose?.();
        },
      },
      card
    );

    clearNode(container);
    appendNodes(container, backdrop);
    dom = {
      handlers,
      backdrop,
      selectEl,
      textareaEl,
      turboRow,
      turboCheckbox,
      turboText,
      errorEl,
      closeBtn,
      cancelBtn,
      submitBtn,
      projectsSig: null,
    };
    newChatModalDom.set(container, dom);
  }

  dom.handlers.busy = Boolean(busy);
  dom.handlers.onProjectChange = onProjectChange;
  dom.handlers.onPromptChange = onPromptChange;
  dom.handlers.onTurboChange = onTurboChange;
  dom.handlers.onSubmit = onSubmit;
  dom.handlers.onClose = onClose;

  const doc = container.ownerDocument;
  const activeEl = doc?.activeElement || null;

  const projectList = Array.isArray(projects) ? projects : [];
  const projectsSig = projectList
    .map((p) => `${String(p?.id || '')}\u0000${String(p?.name || p?.shortPath || p?.id || 'Project')}`)
    .join('\u0001');
  if (dom.projectsSig !== projectsSig && activeEl !== dom.selectEl) {
    clearNode(dom.selectEl);
    appendNodes(
      dom.selectEl,
      el('option', { value: '', text: '默认独立会话（不绑定项目）' }),
      ...projectList.map((p) =>
        el('option', {
          value: String(p.id || ''),
          text: p.name || p.shortPath || p.id || 'Project',
        })
      )
    );
    dom.projectsSig = projectsSig;
  }
  const nextProjectId = String(selectedProjectId || '');
  dom.selectEl.disabled = Boolean(busy);
  if (dom.selectEl.value !== nextProjectId && activeEl !== dom.selectEl) {
    dom.selectEl.value = nextProjectId;
  }

  const nextPrompt = String(promptText || '');
  dom.textareaEl.disabled = Boolean(busy);
  if (dom.textareaEl.value !== nextPrompt && (activeEl !== dom.textareaEl || nextPrompt === '')) {
    dom.textareaEl.value = nextPrompt;
  }

  dom.turboRow.classList.toggle('rc-hidden', !needTurboConfirm);
  dom.turboRow.setAttribute('data-confirmed', turboConfirmed ? 'true' : 'false');
  dom.turboCheckbox.checked = Boolean(needTurboConfirm && turboConfirmed);
  dom.turboCheckbox.disabled = Boolean(busy);
  const nextTurboText = turboConfirmed
    ? 'TURBO 新会话已确认'
    : 'TURBO 自动执行确认（启动新会话将直接执行本机操作）';
  if (dom.turboText.textContent !== nextTurboText) {
    dom.turboText.textContent = nextTurboText;
  }

  const nextError = String(errorText || '');
  dom.errorEl.classList.toggle('rc-hidden', !nextError);
  if (dom.errorEl.textContent !== nextError) {
    dom.errorEl.textContent = nextError;
  }

  const submitDisabled =
    !online || busy || !nextPrompt.trim() || (needTurboConfirm && !turboConfirmed);
  dom.closeBtn.disabled = Boolean(busy);
  dom.cancelBtn.disabled = Boolean(busy);
  dom.submitBtn.disabled = submitDisabled;
  const nextSubmitText = busy ? '创建中…' : '开始对话';
  if (dom.submitBtn.textContent !== nextSubmitText) {
    dom.submitBtn.textContent = nextSubmitText;
  }
}

export function formatWriteError(err) {
  const code = String(err?.code || err?.message || '操作失败');
  if (code === 'forbidden_role_observe') return '当前设备为只读角色 (observe)，无法执行远程写操作';
  if (code === 'host_not_attached' || code === 'host_offline') return 'Antigravity 桌面宿主未连接，无法执行写操作';
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
  if (code === 'create_not_supported') return '当前宿主版本暂不支持远程新建会话，请重启桌面端后重试';
  if (code === 'project_not_found') return '未找到目标项目，请刷新后重试';
  if (code === 'model_not_found' || code === 'invalid_model') return '未找到目标模型选项，已保持当前模型';
  if (code === 'unsupported_media_mime') return '仅支持 PNG / JPEG / WebP / GIF 格式图片';
  if (code === 'media_payload_too_large' || code === 'image_too_large') return '图片附件体积过大，请减少张数或换小尺寸截图';
  if (code === 'too_many_media_items') return '单次最多附带 4 张图片';
  return code;
}

export function createNewChatController({
  state,
  getRefs,
  getWsClient,
  canSteer,
  isTurboPreset,
  createIdempotencyKey,
  uuidRe,
  setActionNotice,
  selectConversation,
  refreshAllData,
  onRequestClose,
}) {
  function render() {
    const refs = getRefs();
    if (!refs?.newChatModal) return;
    const online = Boolean(state.hostAttached && state.wsStatus === 'connected');
    renderNewChatModal(refs.newChatModal, {
      open: state.newChatOpen && canSteer(),
      projects: state.studioOverview?.projects || [],
      selectedProjectId: state.newChatProjectId,
      promptText: state.newChatPrompt,
      busy: state.newChatBusy,
      errorText: state.newChatError,
      needTurboConfirm: isTurboPreset(state.globalPreset),
      turboConfirmed: state.newChatTurboConfirmed,
      online,
      onProjectChange: (pid) => {
        state.newChatProjectId = pid;
      },
      onPromptChange: (txt) => {
        state.newChatPrompt = txt;
        state.newChatError = '';
        const btn = refs.newChatModal.querySelector('.rc-new-chat-submit');
        if (btn) {
          const isOnline = Boolean(state.hostAttached && state.wsStatus === 'connected');
          btn.disabled =
            !isOnline ||
            state.newChatBusy ||
            !String(txt || '').trim() ||
            (isTurboPreset(state.globalPreset) && !state.newChatTurboConfirmed);
        }
      },
      onTurboChange: (checked) => {
        state.newChatTurboConfirmed = checked;
        render();
      },
      onSubmit: submit,
      onClose: () => {
        if (state.newChatBusy) return;
        if (typeof onRequestClose === 'function') {
          onRequestClose();
          return;
        }
        state.newChatOpen = false;
        state.newChatError = '';
        render();
      },
    });
  }

  async function submit() {
    const wsClient = getWsClient();
    if (!wsClient || !canSteer() || state.newChatBusy) return;
    const text = String(state.newChatPrompt || '').trim();
    if (!text) return;
    const needTurbo = isTurboPreset(state.globalPreset);
    if (needTurbo && !state.newChatTurboConfirmed) return;
    state.newChatBusy = true;
    state.newChatError = '';
    render();
    try {
      const res = await wsClient.createConversation({
        projectId: state.newChatProjectId || '',
        text,
        idempotencyKey: createIdempotencyKey(),
        turboWriteConfirmed: Boolean(needTurbo && state.newChatTurboConfirmed),
      });
      state.newChatOpen = false;
      state.newChatPrompt = '';
      state.newChatTurboConfirmed = false;
      setActionNotice('新会话已启动');
      if (res?.cascadeId && uuidRe.test(res.cascadeId)) {
        selectConversation(res.cascadeId);
      }
      refreshAllData();
    } catch (err) {
      state.newChatError = formatWriteError(err);
    } finally {
      state.newChatBusy = false;
      render();
    }
  }

  return { render, submit };
}

export function createMobileHistoryController({
  state,
  getLayoutMode,
  onNavigateToList,
  onNavigateToDetail,
  onCloseOverlays,
  onCloseModal,
}) {
  let bound = false;

  const isMobile = () => getLayoutMode() === 'mobile';
  const hasHistory = () => typeof window !== 'undefined' && window.history && typeof window.history.pushState === 'function';

  function ensureBaseState() {
    if (!hasHistory()) return;
    try {
      const cur = window.history.state;
      if (!cur || !cur.rcView) {
        window.history.replaceState({ rcView: 'list' }, '');
      }
    } catch {}
  }

  function enterDetail(cid) {
    if (!isMobile() || !hasHistory() || !cid) return;
    try {
      ensureBaseState();
      const cur = window.history.state;
      if (cur && cur.rcView === 'detail') {
        window.history.replaceState({ rcView: 'detail', cid }, '');
      } else {
        window.history.pushState({ rcView: 'detail', cid }, '');
      }
    } catch {}
  }

  function leaveDetail() {
    if (isMobile() && hasHistory() && window.history.state?.rcView === 'detail') {
      try {
        window.history.back();
        return;
      } catch {}
    }
    onNavigateToList?.();
  }

  function enterModal() {
    if (!isMobile() || !hasHistory()) return;
    try {
      ensureBaseState();
      if (window.history.state?.rcView !== 'modal') {
        window.history.pushState(
          { rcView: 'modal', fromView: state.mobileView || 'list', cid: state.selectedId || '' },
          ''
        );
      }
    } catch {}
  }

  function leaveModal() {
    if (isMobile() && hasHistory() && window.history.state?.rcView === 'modal') {
      try {
        window.history.back();
        return;
      } catch {}
    }
    onCloseModal?.();
  }

  function handlePopState(ev) {
    if (!isMobile()) return;
    const nextState = ev?.state || {};
    const hadOverlay = Boolean(state.modelPopoverOpen || state.contextPopoverOpen || state.moreMenuOpen);

    // 1. If a bottom popover or overflow menu is open, back gesture closes it first without leaving detail view
    if (hadOverlay) {
      onCloseOverlays?.();
      if (state.mobileView === 'detail' && state.selectedId && nextState.rcView !== 'detail') {
        try {
          window.history.pushState({ rcView: 'detail', cid: state.selectedId }, '');
        } catch {}
      }
      return;
    }

    // 2. If new-chat modal is open, back gesture closes the modal cleanly
    if (state.newChatOpen && nextState.rcView !== 'modal') {
      onCloseModal?.();
      return;
    }

    // 3. Forward/restore into detail view
    if (nextState.rcView === 'detail' && nextState.cid) {
      onNavigateToDetail?.(nextState.cid);
      return;
    }

    // 4. Back from detail view -> return to conversation list instead of exiting PWA
    if (state.mobileView === 'detail') {
      onNavigateToList?.();
    }
  }

  function bind() {
    if (bound || typeof window === 'undefined') return;
    bound = true;
    ensureBaseState();
    window.addEventListener('popstate', handlePopState);
  }

  return {
    bind,
    enterDetail,
    leaveDetail,
    enterModal,
    leaveModal,
    handlePopState,
    closeOverlays: () => onCloseOverlays?.(),
    closeModal: () => onCloseModal?.(),
    navigateToList: () => onNavigateToList?.(),
  };
}

export function createOpusGateActions({
  state,
  getWsClient,
  canSteer,
  requiresTurboAck,
  createIdempotencyKey,
  buildPrompt,
  setActionNotice,
  syncComposerControls,
  refreshStudioOverview,
  refreshAllData,
}) {
  async function dismiss(prop) {
    const wsClient = getWsClient();
    if (!wsClient || !state.selectedId || !canSteer() || state.opusDismissBusy || !prop?.id) return;
    const targetCid = state.selectedId;
    state.opusDismissBusy = true;
    state.actionError = '';
    state.actionNotice = '';
    syncComposerControls();
    try {
      await wsClient.dismissOpusProposal(targetCid, prop.id, { ts: prop.ts });
      if (state.selectedId === targetCid) setActionNotice('已忽略 Opus Gate 检查点建议');
      refreshStudioOverview(targetCid);
    } catch (err) {
      if (state.selectedId === targetCid) state.actionError = formatWriteError(err);
    } finally {
      state.opusDismissBusy = false;
      syncComposerControls();
    }
  }

  async function triggerReview(prop, reviewerModel = 'carbon') {
    const wsClient = getWsClient();
    if (!wsClient || !state.selectedId || !canSteer() || state.opusDismissBusy || !prop?.id) return;
    const targetCid = state.selectedId;
    const needTurbo = requiresTurboAck(state.globalPreset);
    const confirmed = Boolean(needTurbo && state.turboWriteConfirmed);
    if (needTurbo && !confirmed) {
      state.actionError = '请先勾选 TURBO / 未知权限高危确认框后再发起审查';
      state.actionNotice = '';
      syncComposerControls();
      return;
    }
    state.opusDismissBusy = true;
    state.actionError = '';
    state.actionNotice = '';
    syncComposerControls();
    try {
      const prompt = buildPrompt(prop, reviewerModel);
      await wsClient.sendMessage(targetCid, {
        text: prompt,
        turboWriteConfirmed: confirmed,
        idempotencyKey: createIdempotencyKey(),
      });
      await wsClient.dismissOpusProposal(targetCid, prop.id, { ts: prop.ts }).catch(() => {});
      if (state.selectedId === targetCid) {
        setActionNotice(reviewerModel === 'opus' ? '已发起 Opus High 审查' : '已发起 Carbon High 审查');
      }
      refreshAllData();
    } catch (err) {
      if (state.selectedId === targetCid) state.actionError = formatWriteError(err);
    } finally {
      state.opusDismissBusy = false;
      syncComposerControls();
    }
  }

  return { dismiss, triggerReview };
}

const DRAFTS_STORAGE_KEY = 'agy_remote_drafts_v1';
const AUTH_RELOAD_TS_KEY = 'agy_remote_auth_reload_ts';
const MAX_SAVED_DRAFTS = 30;
const MAX_DRAFT_CHARS = 8000;
const SLASH_COMMANDS = [
  { cmd: '/compact', desc: '压缩上下文', trailingSpace: false },
  { cmd: '/plan', desc: '先规划方案', trailingSpace: true },
  { cmd: '/goal', desc: '持续执行到底', trailingSpace: true },
  { cmd: '/grill-me', desc: '交互式对齐需求', trailingSpace: true },
  { cmd: '/boost', desc: '深度分析与验证', trailingSpace: true },
  { cmd: '/teamwork', desc: '多智能体协作', trailingSpace: true },
];

function readDraftStore() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {};
    const raw = window.localStorage.getItem(DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function loadConversationDraft(cascadeId) {
  if (!cascadeId) return '';
  const store = readDraftStore();
  const entry = store[cascadeId];
  return typeof entry?.text === 'string' ? entry.text : '';
}

export function saveConversationDraft(cascadeId, text) {
  if (!cascadeId) return;
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const store = readDraftStore();
    const clean = String(text || '');
    if (!clean.trim()) {
      if (!(cascadeId in store)) return;
      delete store[cascadeId];
    } else {
      store[cascadeId] = {
        text: clean.slice(0, MAX_DRAFT_CHARS),
        ts: Date.now(),
      };
      const entries = Object.entries(store);
      if (entries.length > MAX_SAVED_DRAFTS) {
        entries.sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0));
        const pruned = Object.fromEntries(entries.slice(0, MAX_SAVED_DRAFTS));
        window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(pruned));
        return;
      }
    }
    window.localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(store));
  } catch {}
}

export function triggerGuardedAuthReload({ hasUnsentDraft = false } = {}) {
  if (hasUnsentDraft || typeof window === 'undefined') return false;
  try {
    const now = Date.now();
    const last = Number(window.sessionStorage?.getItem(AUTH_RELOAD_TS_KEY) || 0);
    if (Number.isFinite(last) && now - last < 60_000) return false;
    window.sessionStorage?.setItem(AUTH_RELOAD_TS_KEY, String(now));
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

export function renderConnectionNoticeBar(noticeBar, { state, onRepair, onReconnect, onRelogin } = {}) {
  if (!noticeBar || !state) return;
  clearNode(noticeBar);
  if (state.wsStatus === 'revoked') {
    noticeBar.classList.remove('rc-hidden');
    noticeBar.setAttribute('data-tone', 'danger');
    noticeBar.append(
      el('span', { text: `当前设备密钥已吊销或网关身份已变更（${state.wsDetail || '请重新配对'}）。` }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm is-primary',
        text: '重新配对',
        onClick: () => onRepair?.(),
      })
    );
  } else if (state.wsStatus === 'auth_expired') {
    noticeBar.classList.remove('rc-hidden');
    noticeBar.setAttribute('data-tone', 'danger');
    noticeBar.append(
      el('span', { text: 'Cloudflare Access 登录会话已过期，需要重新验证后恢复连接。' }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm is-primary',
        text: '重新登录',
        onClick: () => onRelogin?.(),
      })
    );
  } else if (state.wsStatus === 'offline') {
    noticeBar.classList.remove('rc-hidden');
    noticeBar.setAttribute('data-tone', 'warn');
    noticeBar.append(
      el('span', { text: '当前网络已断开，网络恢复后将自动重连。' }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm',
        text: '立即重试',
        onClick: () => onReconnect?.(),
      })
    );
  } else if (state.wsStatus === 'reconnecting' || state.wsStatus === 'error') {
    noticeBar.classList.remove('rc-hidden');
    noticeBar.setAttribute('data-tone', state.wsStatus === 'error' ? 'danger' : 'warn');
    noticeBar.append(
      el('span', { text: `远程连接中断（${state.wsDetail || '正在自动重连…'}）。` }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm',
        text: '立即重连',
        onClick: () => onReconnect?.(),
      })
    );
  } else if (!state.hostAttached && state.wsStatus === 'connected') {
    noticeBar.classList.remove('rc-hidden');
    noticeBar.setAttribute('data-tone', 'warn');
    noticeBar.append(
      el('span', {
        text: 'Antigravity 桌面窗口当前未挂载 CDP，已自动降级为 SQLite / Transcript 只读历史模式（无实时流与审批态）。',
      })
    );
  } else {
    noticeBar.classList.add('rc-hidden');
  }
}

export function renderSlashCommandBar(container, { draftText = '', writable = false, online = false, onPick = null } = {}) {
  if (!container) return;
  const raw = String(draftText || '');
  const show = Boolean(writable && online && raw.startsWith('/') && !raw.includes('\n') && raw.length <= 16);
  if (!show) {
    if (!container.classList.contains('rc-hidden')) {
      clearNode(container);
      container.classList.add('rc-hidden');
    }
    return;
  }
  const needle = raw.trim().toLowerCase();
  const matches = SLASH_COMMANDS.filter((item) => item.cmd.startsWith(needle) && item.cmd !== needle);
  if (matches.length === 0) {
    clearNode(container);
    container.classList.add('rc-hidden');
    return;
  }
  clearNode(container);
  container.classList.remove('rc-hidden');
  for (const item of matches) {
    container.appendChild(
      el(
        'button',
        {
          type: 'button',
          className: 'rc-slash-chip',
          onClick: () => onPick?.(item.trailingSpace ? `${item.cmd} ` : item.cmd),
        },
        el('span', { className: 'rc-slash-cmd', text: item.cmd }),
        el('span', { className: 'rc-slash-desc', text: item.desc })
      )
    );
  }
}

export function createMoreMenuController({
  state,
  getMenuEl,
  getWsClient,
  renderMenu,
  formatPresetBadge,
  layoutButtonLabel,
  alertManager,
  setActionNotice,
  writeLayoutPref,
  applyLayoutAttrs,
  renderSidebarList,
  renderStudioPanels,
  refreshAllData,
  handleUnpairDevice,
}) {
  function render() {
    const rttSuffix = state.wsStatus === 'connected' && state.wsRttMs > 0 ? ` · ${state.wsRttMs}ms` : '';
    const baseHostLine = state.hostAttached ? `CDP 在线 (${state.source || 'cdp'})` : '宿主离线 · 只读';
    renderMenu(getMenuEl(), {
      open: state.moreMenuOpen,
      hostLine: `${baseHostLine}${rttSuffix}`,
      role: state.identity?.role || 'observe',
      presetLabel: formatPresetBadge(state.globalPreset).label,
      layoutLabel: layoutButtonLabel(state.layoutPref),
      alertLabel: alertManager.getAlertLabel(),
      onReconnectNow:
        state.wsStatus !== 'connected'
          ? () => {
              state.moreMenuOpen = false;
              render();
              if (state.wsStatus === 'auth_expired') {
                try {
                  window.location.reload();
                } catch {}
              } else {
                getWsClient?.()?.reconnectNow?.();
              }
            }
          : null,
      onToggleAlerts: () => {
        const next = alertManager.toggleAlerts();
        render();
        setActionNotice(next ? '已开启完成与审批提醒' : '已关闭完成与审批提醒');
      },
      onCycleLayout: () => {
        const order = ['auto', 'desktop', 'mobile'];
        const next = order[(order.indexOf(state.layoutPref) + 1) % order.length];
        state.layoutPref = next;
        writeLayoutPref(next);
        state.moreMenuOpen = false;
        applyLayoutAttrs();
        renderSidebarList();
      },
      onOpenOverview: () => {
        state.moreMenuOpen = false;
        state.mobileTab = 'overview';
        state.mobileView = 'list';
        applyLayoutAttrs();
        renderStudioPanels();
      },
      onRefreshAll: () => {
        state.moreMenuOpen = false;
        render();
        refreshAllData();
      },
      onOpenNativeSettings: isNativeAndroidApp()
        ? () => {
            state.moreMenuOpen = false;
            render();
            openNativeSettingsDialog();
          }
        : null,
      onUnpair: () => handleUnpairDevice(),
    });
  }
  return { render };
}
