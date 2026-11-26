/**
 * AGY Studio Remote PWA — Conversation Timeline, Step Cards & Waiting Step Cards
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import {
  clearNode,
  el,
  findConversationMeta,
  formatTime,
  normalizeRunStatus,
  normalizeStepStatus,
} from './ui-helpers.mjs';

export function renderStepCard(step) {
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

export function renderWaitingCards(
  waitingSteps,
  { canWrite = false, hostAttached = false, busyHash = '', onApprove = null } = {}
) {
  if (!Array.isArray(waitingSteps) || waitingSteps.length === 0) return [];
  return waitingSteps.map((w) => {
    const hash = String(w.waitingStepHash || '');
    const isBusy = Boolean(busyHash && hash && busyHash === hash);
    const isPermission = !w.interactionCase || w.interactionCase === 'permission';

    let footerEl;
    if (!canWrite) {
      footerEl = el('div', {
        className: 'rc-convo-meta',
        text: `只读观察模式 (observe)：请在 Mac 桌面端点击 Allow Once / Deny，或以 --role steer 重新配对${hash ? ` · hash:${hash.slice(0, 8)}` : ''}`,
      });
    } else if (!isPermission) {
      footerEl = el('div', {
        className: 'rc-convo-meta',
        text: `该交互类型 (${w.interactionCase}) 暂请在桌面端完成${hash ? ` · hash:${hash.slice(0, 8)}` : ''}`,
      });
    } else if (!hostAttached) {
      footerEl = el(
        'div',
        { className: 'rc-waiting-actions' },
        el('button', { type: 'button', className: 'rc-btn is-sm is-primary', disabled: true, text: '仅本次允许 (Allow Once)' }),
        el('button', { type: 'button', className: 'rc-btn is-sm is-danger', disabled: true, text: '拒绝 (Deny)' }),
        el('span', { className: 'rc-convo-meta', text: '宿主离线，无法提交审批' })
      );
    } else {
      footerEl = el(
        'div',
        { className: 'rc-waiting-actions' },
        el('button', {
          type: 'button',
          className: 'rc-btn is-sm is-primary',
          disabled: isBusy || !hash,
          text: isBusy ? '提交中…' : '仅本次允许 (Allow Once)',
          onClick: () => onApprove?.(w, 'allow_once'),
        }),
        el('button', {
          type: 'button',
          className: 'rc-btn is-sm is-danger',
          disabled: isBusy || !hash,
          text: '拒绝 (Deny)',
          onClick: () => onApprove?.(w, 'deny'),
        }),
        hash ? el('span', { className: 'rc-mono', text: `hash:${hash.slice(0, 8)}` }) : null
      );
    }

    return el(
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
      footerEl
    );
  });
}

export function renderDetailTimeline({
  state,
  refs,
  onSelectConversation,
  onApprove = null,
}) {
  const cid = state.selectedId;
  const convo = findConversationMeta(state, cid);
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
  const wtMeta = state.studioOverview?.worktreeByCid?.[cid] || null;
  refs.detailSub.append(
    el('span', { className: 'rc-pill', 'data-tone': runInfo.tone, text: runInfo.label }),
    el('span', { className: 'rc-mono', text: cid.slice(0, 13) }),
    wtMeta?.branch ? el('span', { className: 'rc-pill', 'data-tone': 'info', text: `⎇ ${wtMeta.branch}` }) : null,
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

  const role = state.identity?.role || 'observe';
  const canWrite = role === 'steer' || role === 'admin';
  const waiting = snap?.waitingSteps?.length ? snap.waitingSteps : convo?.waitingSteps || [];
  for (const card of renderWaitingCards(waiting, {
    canWrite,
    hostAttached: Boolean(state.hostAttached && state.wsStatus === 'connected'),
    busyHash: state.approvingHash || '',
    onApprove,
  })) {
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
            onClick: () => onSelectConversation(sub.id),
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
