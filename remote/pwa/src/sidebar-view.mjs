/**
 * AGY Studio Remote PWA — Sidebar Filter Chips, Approvals Queue & Conversation List
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import {
  clearNode,
  collectPendingApprovals,
  el,
  filterConversations,
  formatRelativeTime,
  getEffectiveWaitingCount,
  isRunningStatus,
  normalizeRunStatus,
} from './ui-helpers.mjs';

function resolveConversationProjectName(state, c) {
  const wtMeta = state.studioOverview?.worktreeByCid?.[c.id] || null;
  if (wtMeta?.repoName) return wtMeta.repoName;
  const projects = Array.isArray(state.studioOverview?.projects) ? state.studioOverview.projects : [];
  const pid = String(c.projectId || wtMeta?.projectId || '');
  if (pid) {
    const match = projects.find((p) => p.id === pid);
    if (match?.name) return match.name;
  }
  return '独立会话';
}

function buildConversationRow(state, c, onSelectConversation) {
  const waitCount = getEffectiveWaitingCount(state, c);
  const statusInfo = normalizeRunStatus(c.status);
  const isSelected = state.selectedId === c.id;
  const wtMeta = state.studioOverview?.worktreeByCid?.[c.id] || null;
  return el(
    'button',
    {
      type: 'button',
      className: 'rc-convo-item',
      'data-selected': isSelected ? 'true' : 'false',
      'data-waiting': waitCount > 0 ? 'true' : 'false',
      onClick: () => onSelectConversation?.(c.id),
    },
    el(
      'div',
      { className: 'rc-convo-top' },
      el('span', { className: 'rc-convo-dot', 'data-tone': waitCount > 0 ? 'warn' : statusInfo.tone }),
      el('span', { className: 'rc-convo-title', text: c.title || c.summary || c.id.slice(0, 8) }),
      waitCount > 0
        ? el('span', { className: 'rc-pill rc-convo-status', 'data-tone': 'warn', text: `待审批 ${waitCount}` })
        : el('span', { className: 'rc-pill rc-convo-status', 'data-tone': statusInfo.tone, text: statusInfo.label }),
      c.lastModifiedTime
        ? el('span', { className: 'rc-convo-time', text: formatRelativeTime(c.lastModifiedTime) })
        : null
    ),
    el(
      'div',
      { className: 'rc-convo-meta' },
      c.parentConversationId ? el('span', { className: 'rc-pill', text: 'Subagent' }) : null,
      wtMeta?.branch ? el('span', { className: 'rc-pill', 'data-tone': 'info', text: `⎇ ${wtMeta.branch}` }) : null,
      el('span', { text: `${c.stepCount ?? 0} steps` }),
      c.lastModifiedTime
        ? el('span', { className: 'rc-convo-meta-time', text: `· ${formatRelativeTime(c.lastModifiedTime)}` })
        : null
    )
  );
}

export function renderFilterChipsView({
  state,
  refs,
  onSelectFilter,
  onSelectGroupBy,
  onToggleSubagents,
}) {
  clearNode(refs.filterRow);
  clearNode(refs.groupRow);

  const pendingCount = collectPendingApprovals(state).length;
  const runningCount = state.conversations.filter(
    (c) => (state.includeSubagents || !c.parentConversationId) && isRunningStatus(c.status)
  ).length;

  refs.navApprovalsBadge.textContent = String(pendingCount);
  if (pendingCount > 0) {
    refs.navApprovalsBadge.classList.remove('rc-hidden');
  } else {
    refs.navApprovalsBadge.classList.add('rc-hidden');
  }

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
        onClick: () => onSelectFilter?.(f.id),
      })
    );
  }

  refs.groupRow.appendChild(el('span', { className: 'rc-group-label', text: '排列' }));
  for (const grp of [
    { id: 'recent', label: '时间流' },
    { id: 'project', label: '按项目' },
  ]) {
    refs.groupRow.appendChild(
      el('button', {
        type: 'button',
        className: 'rc-chip is-compact',
        'aria-pressed': state.sidebarGroupBy === grp.id ? 'true' : 'false',
        text: grp.label,
        onClick: () => onSelectGroupBy?.(grp.id),
      })
    );
  }

  refs.groupRow.appendChild(
    el('button', {
      type: 'button',
      className: 'rc-chip is-compact rc-group-subagent',
      'aria-pressed': state.includeSubagents ? 'true' : 'false',
      text: '含子代理',
      onClick: () => onToggleSubagents?.(),
    })
  );
}

export function renderSidebarListView({
  state,
  refs,
  resolvedLayoutMode,
  onSelectConversation,
}) {
  clearNode(refs.sidebarList);

  const pendingApprovals = collectPendingApprovals(state);
  const mobileApprovalsOnly = resolvedLayoutMode === 'mobile' && state.mobileTab === 'approvals';

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
            onClick: () => onSelectConversation?.(item.cascadeId),
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
  } else if (mobileApprovalsOnly) {
    refs.sidebarList.appendChild(
      el('div', { className: 'rc-empty', text: '当前没有等待审批的桌面端操作。' })
    );
    return;
  }

  if (mobileApprovalsOnly) {
    return;
  }

  const list = filterConversations(state);
  if (list.length === 0) {
    refs.sidebarList.appendChild(
      el('div', { className: 'rc-sec-label', text: '会话列表 (0)' })
    );
    refs.sidebarList.appendChild(
      el('div', { className: 'rc-empty', text: '当前筛选条件下没有会话' })
    );
    return;
  }

  if (state.sidebarGroupBy === 'project') {
    const groups = new Map();
    for (const c of list) {
      const label = resolveConversationProjectName(state, c);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(c);
    }
    for (const [projLabel, items] of groups.entries()) {
      refs.sidebarList.appendChild(
        el('div', { className: 'rc-sec-label', text: `${projLabel} (${items.length})` })
      );
      for (const c of items) {
        refs.sidebarList.appendChild(buildConversationRow(state, c, onSelectConversation));
      }
    }
    return;
  }

  refs.sidebarList.appendChild(
    el('div', { className: 'rc-sec-label', text: `会话列表 (${list.length})` })
  );
  for (const c of list) {
    refs.sidebarList.appendChild(buildConversationRow(state, c, onSelectConversation));
  }
}
