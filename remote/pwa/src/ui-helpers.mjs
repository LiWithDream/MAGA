/**
 * AGY Studio Remote PWA — Safe DOM Builders, Formatters & State Selectors
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DESKTOP_BREAKPOINT_PX = 960;

export function resolveLayoutMode(pref, viewportWidth = 1024) {
  if (pref === 'desktop' || pref === 'mobile') return pref;
  const w = Number(viewportWidth);
  return Number.isFinite(w) && w >= DESKTOP_BREAKPOINT_PX ? 'desktop' : 'mobile';
}

export function formatResetCountdown(sec) {
  const total = Number(sec);
  if (!Number.isFinite(total) || total <= 0) return '';
  const mins = Math.ceil(total / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function copyTextWithFeedback(btn, text, { idleText = '复制', doneText = '已复制' } = {}) {
  const val = String(text ?? '');
  if (!val || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
  navigator.clipboard
    .writeText(val)
    .then(() => {
      if (!btn) return;
      btn.textContent = doneText;
      btn.setAttribute('data-copied', 'true');
      setTimeout(() => {
        btn.textContent = idleText;
        btn.removeAttribute('data-copied');
      }, 1400);
    })
    .catch(() => {});
}

/* Safe DOM helper — strictly textContent / setAttribute only */
export function el(tag, props = {}, ...children) {
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
  return appendNodes(node, ...children);
}

export function appendNodes(parent, ...items) {
  for (const child of items.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
    } else {
      parent.appendChild(child);
    }
  }
  return parent;
}

export function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export function formatTime(ts) {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function formatRelativeTime(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? ts : Date.parse(String(ts));
  if (!Number.isFinite(ms)) return '';
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function isRunningStatus(status) {
  if (status === 2 || status === 8) return true;
  const s = String(status || '').toUpperCase();
  return s.includes('RUNNING') || s.includes('WAITING');
}

export function normalizeRunStatus(status) {
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

export function normalizeStepStatus(status) {
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

export function isSafeNonTurboPreset(preset) {
  if (typeof preset === 'boolean' || preset === null || preset === undefined) return false;
  if (typeof preset === 'string' && !/^\d+$/.test(preset.trim())) return false;
  const n = Number(preset);
  return n === 1 || n === 2;
}

export function formatPresetBadge(preset) {
  if (typeof preset === 'boolean' || preset === null || preset === undefined) {
    return { label: 'Preset 未知', tone: 'warn' };
  }
  if (typeof preset === 'string' && !/^\d+$/.test(preset.trim())) {
    return { label: 'Preset 未知', tone: 'warn' };
  }
  const n = Number(preset);
  if (n === 3) return { label: 'TURBO (3)', tone: 'danger' };
  if (n === 2) return { label: 'REVIEW (2)', tone: 'ok' };
  if (n === 1) return { label: 'SAFE (1)', tone: 'ok' };
  if (n === 0) return { label: 'UNSPECIFIED (0)', tone: 'warn' };
  if (Number.isFinite(n)) return { label: `Preset ${n}`, tone: 'warn' };
  return { label: 'Preset 未知', tone: 'warn' };
}

export function normalizeWsStatus(status, detail = '') {
  switch (status) {
    case 'connected':
      return { label: '已连接', tone: 'ok' };
    case 'connecting':
      return { label: '握手连接中', tone: 'warn' };
    case 'reconnecting':
      return { label: detail || '重连中…', tone: 'warn' };
    case 'revoked':
      return { label: '设备已吊销', tone: 'danger' };
    case 'error':
      return { label: detail || '连接异常', tone: 'danger' };
    default:
      return { label: '未连接', tone: 'neutral' };
  }
}

export function shortFingerprint(fp) {
  const s = String(fp || '');
  if (!s) return '未知';
  if (s.length <= 20) return s;
  return `${s.slice(0, 10)}…${s.slice(-8)}`;
}

export function requiresTurboAck(preset) {
  return !isSafeNonTurboPreset(preset);
}

export function collectPendingApprovals(state) {
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

export function getEffectiveWaitingCount(state, convo) {
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

export function findConversationMeta(state, cascadeId) {
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

export function filterConversations(state) {
  const q = state.searchQuery.trim().toLowerCase();
  return state.conversations
    .filter((c) => {
      if (!state.includeSubagents && c.parentConversationId) return false;
      if (state.selectedProjectId) {
        const wtMeta = state.studioOverview?.worktreeByCid?.[c.id];
        const cidPid = String(c.projectId || wtMeta?.projectId || '');
        if (cidPid !== state.selectedProjectId) return false;
      }
      if (state.filter === 'running' && !isRunningStatus(c.status)) return false;
      if (state.filter === 'waiting' && getEffectiveWaitingCount(state, c) === 0) return false;
      if (q) {
        const hay = `${c.title || ''} ${c.summary || ''} ${c.id || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const wa = getEffectiveWaitingCount(state, a) > 0 ? 1 : 0;
      const wb = getEffectiveWaitingCount(state, b) > 0 ? 1 : 0;
      if (wa !== wb) return wb - wa;
      const ta = Number(a.lastModifiedTime || 0) || Date.parse(a.lastModifiedTime || 0) || 0;
      const tb = Number(b.lastModifiedTime || 0) || Date.parse(b.lastModifiedTime || 0) || 0;
      return tb - ta;
    });
}
