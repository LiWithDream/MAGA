/**
 * AGY Studio Remote PWA — Right Overview Panel (Studio Workbench + Mobile Overview Tab)
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import { formatCompactTokens } from './studio-panel.mjs';
import {
  appendNodes,
  clearNode,
  copyTextWithFeedback,
  el,
  formatPresetBadge,
  formatResetCountdown,
  normalizeRunStatus,
  normalizeWsStatus,
} from './ui-helpers.mjs';

function buildMeterRow(label, pct, { resetSec = null, tone = 'blue' } = {}) {
  const validPct = pct !== null && pct !== undefined && Number.isFinite(Number(pct));
  const clamped = validPct ? Math.max(0, Math.min(100, Math.round(Number(pct)))) : 0;
  const resetText = formatResetCountdown(resetSec);
  const metaText = validPct
    ? `${clamped}%${resetText ? ` · ${resetText}` : ''}`
    : '--';

  return el(
    'div',
    { className: 'rc-meter-row' },
    el(
      'div',
      { className: 'rc-meter-top' },
      el('span', { className: 'rc-meter-label', text: label }),
      el('span', { className: 'rc-meter-val', text: metaText })
    ),
    el(
      'div',
      { className: 'rc-meter-track' },
      el('div', {
        className: 'rc-meter-fill',
        'data-tone': validPct && clamped <= 15 ? 'warn' : tone,
        style: `width: ${clamped}%;`,
      })
    )
  );
}

function renderQuotaCard(quota) {
  const headerChildren = [el('strong', { className: 'rc-ov-card-title', text: '配额与窗口' })];
  if (quota?.tierName) {
    headerChildren.push(el('span', { className: 'rc-pill', 'data-tone': 'info', text: quota.tierName }));
  }

  const body = el('div', { className: 'rc-ov-card-stack' });
  const hasClaude =
    quota?.claude &&
    (quota.claude.fiveHourRemainingPct !== null || quota.claude.weeklyRemainingPct !== null);
  const hasGemini =
    quota?.gemini &&
    (quota.gemini.fiveHourRemainingPct !== null || quota.gemini.weeklyRemainingPct !== null);

  if (hasClaude) {
    body.appendChild(
      el(
        'div',
        { className: 'rc-ov-pool' },
        el('div', { className: 'rc-ov-pool-name', text: 'Claude' }),
        buildMeterRow('5 小时剩余', quota.claude.fiveHourRemainingPct, {
          resetSec: quota.claude.fiveHourResetSec,
          tone: 'accent',
        }),
        buildMeterRow('周配额剩余', quota.claude.weeklyRemainingPct, {
          resetSec: quota.claude.weeklyResetSec,
          tone: 'accent',
        })
      )
    );
  }

  if (hasGemini) {
    body.appendChild(
      el(
        'div',
        { className: 'rc-ov-pool' },
        el('div', { className: 'rc-ov-pool-name', text: 'Gemini' }),
        buildMeterRow('5 小时剩余', quota.gemini.fiveHourRemainingPct, {
          resetSec: quota.gemini.fiveHourResetSec,
          tone: 'blue',
        }),
        buildMeterRow('周配额剩余', quota.gemini.weeklyRemainingPct, {
          resetSec: quota.gemini.weeklyResetSec,
          tone: 'blue',
        })
      )
    );
  }

  if (!hasClaude && !hasGemini) {
    body.appendChild(el('div', { className: 'rc-convo-meta', text: '等待宿主同步模型配额…' }));
  }

  return el(
    'section',
    { className: 'rc-ov-card' },
    el('div', { className: 'rc-ov-card-head' }, ...headerChildren),
    body
  );
}

function renderUsageCard(todayUsage) {
  const tu = todayUsage || {};
  const totalTokens = Number(tu.totalTokens || 0);
  const requests = Number(tu.requests || 0);
  const uncached = Number(tu.uncached || 0);
  const cacheRead = Number(tu.cacheRead || 0);
  const output = Number(tu.output || 0);
  const inputTotal = uncached + cacheRead;
  const hitPct = inputTotal > 0 ? Math.round((cacheRead / inputTotal) * 100) : 0;

  const denom = Math.max(1, uncached + cacheRead + output);
  const cacheWidth = Math.round((cacheRead / denom) * 100);
  const uncachedWidth = Math.round((uncached / denom) * 100);
  const outputWidth = Math.max(0, 100 - cacheWidth - uncachedWidth);

  return el(
    'section',
    { className: 'rc-ov-card' },
    el(
      'div',
      { className: 'rc-ov-card-head' },
      el('strong', { className: 'rc-ov-card-title', text: '今日用量' }),
      el('span', { className: 'rc-ov-muted', text: tu.date || '今天' })
    ),
    el(
      'div',
      { className: 'rc-ov-kpi-row' },
      el('span', { className: 'rc-ov-kpi', text: `${formatCompactTokens(totalTokens)} tok` }),
      el(
        'span',
        { className: 'rc-ov-muted', text: `${requests} req${inputTotal > 0 ? ` · 缓存 ${hitPct}%` : ''}` }
      )
    ),
    el(
      'div',
      { className: 'rc-usage-bar' },
      el('div', { className: 'rc-usage-seg is-cache', style: `width: ${totalTokens > 0 ? cacheWidth : 0}%;` }),
      el('div', { className: 'rc-usage-seg is-uncached', style: `width: ${totalTokens > 0 ? uncachedWidth : 0}%;` }),
      el('div', { className: 'rc-usage-seg is-output', style: `width: ${totalTokens > 0 ? outputWidth : 0}%;` })
    ),
    el(
      'div',
      { className: 'rc-ov-legend' },
      el('span', { className: 'rc-ov-legend-item', text: `缓存读 ${formatCompactTokens(cacheRead)}` }),
      el('span', { className: 'rc-ov-legend-item', text: `未缓存 ${formatCompactTokens(uncached)}` }),
      el('span', { className: 'rc-ov-legend-item', text: `输出 ${formatCompactTokens(output)}` })
    )
  );
}

function renderActiveSessionCard({
  overview,
  selectedConvo,
  snapshot,
  wsStatus,
  hostAttached,
  globalPreset,
  deviceName,
  role,
  onCopyId,
}) {
  const cid = selectedConvo?.id || snapshot?.cascadeId || '';
  if (!cid) {
    const wsInfo = normalizeWsStatus(wsStatus);
    const presetInfo = formatPresetBadge(globalPreset);
    return el(
      'section',
      { className: 'rc-ov-card' },
      el(
        'div',
        { className: 'rc-ov-card-head' },
        el('strong', { className: 'rc-ov-card-title', text: '终端连接与宿主' }),
        el('span', { className: 'rc-pill', 'data-tone': wsInfo.tone, text: wsInfo.label })
      ),
      el(
        'div',
        { className: 'rc-ov-kv-list' },
        el('div', { className: 'rc-ov-kv' }, el('span', { text: '宿主' }), el('span', { text: hostAttached ? 'CDP 在线' : '磁盘只读' })),
        el('div', { className: 'rc-ov-kv' }, el('span', { text: '权限策略' }), el('span', { text: presetInfo.label })),
        el('div', { className: 'rc-ov-kv' }, el('span', { text: '本机角色' }), el('span', { text: `${deviceName || '已配对设备'} (${role || 'observe'})` }))
      )
    );
  }

  const runInfo = normalizeRunStatus(snapshot?.status ?? selectedConvo?.status);
  const wtMeta = overview?.worktreeByCid?.[cid] || null;
  const activeMeta =
    overview?.activeCascade?.cascadeId === cid ? overview.activeCascade : null;
  const stepsCount = Array.isArray(snapshot?.steps)
    ? snapshot.steps.length
    : Number(selectedConvo?.stepCount || 0);

  const copyBtn = el('button', {
    type: 'button',
    className: 'rc-code-copy',
    text: '复制 ID',
    onClick: () => {
      if (typeof onCopyId === 'function') {
        onCopyId(cid, copyBtn);
      } else {
        copyTextWithFeedback(copyBtn, cid, { idleText: '复制 ID', doneText: '已复制' });
      }
    },
  });

  const pills = el(
    'div',
    { className: 'rc-studio-pills' },
    el('span', { className: 'rc-pill', 'data-tone': runInfo.tone, text: runInfo.label }),
    el('span', { className: 'rc-pill', text: `${stepsCount} 步` }),
    snapshot?.source ? el('span', { className: 'rc-pill', text: snapshot.source }) : null,
    wtMeta?.branch ? el('span', { className: 'rc-pill', 'data-tone': 'info', text: `⎇ ${wtMeta.branch}` }) : null,
    activeMeta?.opusGate?.proposal
      ? el('span', { className: 'rc-pill', 'data-tone': 'warn', text: 'Opus Gate 待核' })
      : null,
    activeMeta?.autoCompact?.pending
      ? el('span', { className: 'rc-pill', 'data-tone': 'warn', text: '待 Compact' })
      : null
  );

  return el(
    'section',
    { className: 'rc-ov-card' },
    el(
      'div',
      { className: 'rc-ov-card-head' },
      el('strong', { className: 'rc-ov-card-title', text: '当前会话' }),
      copyBtn
    ),
    el('div', { className: 'rc-ov-session-title', text: selectedConvo?.title || selectedConvo?.summary || cid }),
    el('div', { className: 'rc-mono rc-ov-muted', text: cid.slice(0, 18) }),
    pills,
    wtMeta?.repoName ? el('div', { className: 'rc-convo-meta', text: `仓库: ${wtMeta.repoName}` }) : null
  );
}

function renderProjectsOverviewCard({ overview, selectedProjectId = '', onSelectProject }) {
  const projects = Array.isArray(overview?.projects) ? overview.projects : [];
  const headActions = [];
  if (selectedProjectId) {
    headActions.push(
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm',
        text: '清除筛选',
        onClick: () => onSelectProject?.(''),
      })
    );
  }

  const card = el(
    'section',
    { className: 'rc-ov-card' },
    el(
      'div',
      { className: 'rc-ov-card-head' },
      el('strong', { className: 'rc-ov-card-title', text: `项目与 Worktree (${projects.length})` }),
      ...headActions
    )
  );

  if (projects.length === 0) {
    card.appendChild(el('div', { className: 'rc-convo-meta', text: '暂未发现已授权项目目录。' }));
    return card;
  }

  const list = el('div', { className: 'rc-ov-proj-list' });
  for (const proj of projects) {
    const isSelected = Boolean(selectedProjectId && selectedProjectId === proj.id);
    const wtList = Array.isArray(proj.worktrees) ? proj.worktrees : [];
    const wtChips = el('div', { className: 'rc-studio-pills' });
    for (const wt of wtList.slice(0, 4)) {
      const label = wt.branch || wt.name || 'worktree';
      wtChips.appendChild(
        el('span', {
          className: 'rc-pill',
          'data-tone': wt.isMain ? 'neutral' : 'info',
          text: wt.isMain ? `${label} (main)` : label,
        })
      );
    }
    if (wtList.length > 4) {
      wtChips.appendChild(el('span', { className: 'rc-pill', text: `+${wtList.length - 4}` }));
    }

    list.appendChild(
      el(
        'div',
        { className: 'rc-ov-proj-item', 'data-selected': isSelected ? 'true' : 'false' },
        el(
          'div',
          { className: 'rc-convo-top' },
          el('span', { className: 'rc-ov-proj-name', text: proj.name || 'Project' }),
          el('button', {
            type: 'button',
            className: 'rc-btn is-sm',
            text: isSelected ? '取消' : '筛选',
            onClick: () => onSelectProject?.(isSelected ? '' : proj.id),
          })
        ),
        proj.shortPath ? el('div', { className: 'rc-mono rc-ov-muted', text: proj.shortPath }) : null,
        wtList.length > 0 ? wtChips : null
      )
    );
  }
  card.appendChild(list);
  return card;
}

export function renderOverviewPanel(
  container,
  {
    overview = null,
    selectedConvo = null,
    snapshot = null,
    wsStatus = 'disconnected',
    hostAttached = false,
    globalPreset = null,
    deviceName = '',
    role = 'observe',
    selectedProjectId = '',
    onSelectProject = null,
    onCopyId = null,
  } = {}
) {
  if (!container) return;
  clearNode(container);

  const body = el('div', { className: 'rc-overview-body' });
  appendNodes(
    body,
    renderQuotaCard(overview?.quota || null),
    renderUsageCard(overview?.todayUsage || null),
    renderActiveSessionCard({
      overview,
      selectedConvo,
      snapshot,
      wsStatus,
      hostAttached,
      globalPreset,
      deviceName,
      role,
      onCopyId,
    }),
    renderProjectsOverviewCard({ overview, selectedProjectId, onSelectProject })
  );
  container.appendChild(body);
}
