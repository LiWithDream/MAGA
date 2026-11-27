/**
 * AGY Studio Remote PWA — Mobile Enhancements:
 * - New Conversation Modal (Project selector + prompt + TURBO ack)
 * - Completion & Pending-Approval Alert Manager (Title badge + Haptics + Web Notification)
 * - Collapsible Per-Session TURBO Confirmation UI Helper
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import { appendNodes, clearNode, el, isRunningStatus } from './ui-helpers.mjs';

const ALERTS_STORAGE_KEY = 'rc:alertsEnabled';

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
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern);
      }
    } catch {}
  };

  const fireWebNotification = (title, body, tag) => {
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
      if (isDocHidden()) {
        fireWebNotification('等待桌面端审批', `${approvals[0].title} 需要确认操作`, `agy-wait-${approvals[0].id}`);
      }
    } else if (completed.length > 0) {
      if (isDocHidden()) {
        setDocTitle(`✓ 已完成 · ${baseTitle}`);
        fireWebNotification('任务已完成', completed[0].title, `agy-done-${completed[0].id}`);
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
  clearNode(container);
  if (!open) {
    container.classList.add('rc-hidden');
    return;
  }
  container.classList.remove('rc-hidden');

  const selectEl = el(
    'select',
    {
      className: 'rc-select',
      disabled: busy,
      onChange: (ev) => onProjectChange?.(ev.target.value),
    },
    el('option', { value: '', text: '默认独立会话（不绑定项目）' }),
    ...(Array.isArray(projects)
      ? projects.map((p) =>
          el('option', {
            value: String(p.id || ''),
            text: p.name || p.shortPath || p.id || 'Project',
          })
        )
      : [])
  );
  selectEl.value = String(selectedProjectId || '');

  const textareaEl = el('textarea', {
    className: 'rc-modal-textarea',
    rows: '4',
    placeholder: '输入首条指令，直接启动新会话…',
    disabled: busy,
    value: promptText,
    onInput: (ev) => onPromptChange?.(ev.target.value),
  });
  textareaEl.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      onSubmit?.();
    }
  });

  const submitDisabled =
    !online || busy || !String(promptText || '').trim() || (needTurboConfirm && !turboConfirmed);

  const turboRow = needTurboConfirm
    ? el(
        'label',
        { className: 'rc-turbo-inline', 'data-confirmed': turboConfirmed ? 'true' : 'false' },
        el('input', {
          type: 'checkbox',
          checked: turboConfirmed,
          disabled: busy,
          onChange: (ev) => onTurboChange?.(Boolean(ev.target.checked)),
        }),
        el('span', {
          text: turboConfirmed
            ? 'TURBO 新会话已确认'
            : 'TURBO 自动执行确认（启动新会话将直接执行本机操作）',
        })
      )
    : null;

  const card = el(
    'div',
    {
      className: 'rc-modal-card',
      onClick: (ev) => ev?.stopPropagation?.(),
    },
    el(
      'div',
      { className: 'rc-model-pop-head' },
      el('strong', { text: '新建会话' }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm is-ghost',
        disabled: busy,
        text: '关闭',
        onClick: () => onClose?.(),
      })
    ),
    el(
      'div',
      { className: 'rc-modal-field' },
      el('label', { className: 'rc-modal-label', text: '所属项目' }),
      selectEl
    ),
    el(
      'div',
      { className: 'rc-modal-field' },
      el('label', { className: 'rc-modal-label', text: '首条指令' }),
      textareaEl
    ),
    turboRow,
    errorText ? el('div', { className: 'rc-action-banner', 'data-tone': 'danger', text: errorText }) : null,
    el(
      'div',
      { className: 'rc-modal-actions' },
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm',
        disabled: busy,
        text: '取消',
        onClick: () => onClose?.(),
      }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm is-primary rc-new-chat-submit',
        disabled: submitDisabled,
        text: busy ? '创建中…' : '开始对话',
        onClick: () => onSubmit?.(),
      })
    )
  );

  const backdrop = el(
    'div',
    {
      className: 'rc-modal-backdrop',
      onClick: () => {
        if (!busy) onClose?.();
      },
    },
    card
  );

  appendNodes(container, backdrop);
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
          btn.disabled =
            !online ||
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
