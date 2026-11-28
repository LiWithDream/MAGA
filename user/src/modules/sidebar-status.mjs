/**
 * Shared 5-State Running Status Classifier, Icons, Tooltips & On-Demand Background RPC Client.
 * Differentiates:
 *   1. orbit    : Primary agent active (status in {2, 3, 4})
 *   2. subagent : Waiting on subagent / Swarm / workflow
 *   3. command  : Background run_command active
 *   4. timer    : Waiting on schedule timer / Cron
 *   5. bg-wait  : Other background wait / fallback when SQLite unavailable
 */

export const RUNNING_SUBKIND_PRIORITY = Object.freeze({
  orbit: 5,
  subagent: 4,
  command: 3,
  timer: 2,
  'bg-wait': 1,
});

const SUBKIND_ORDER = ['orbit', 'subagent', 'command', 'timer', 'bg-wait'];

// Reuses the footer capsule bot glyph path from studio/modules/subagent/pills.mjs:39
export const RUN_BOT_SVG =
  '<svg class="ag-run-svg" width="12.5" height="12.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6.2 8.8h.01M9.8 8.8h.01M6.2 11h3.6"/></svg>';

export const RUN_CLOCK_SVG =
  '<svg class="ag-run-svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.3"/></svg>';

export const RUN_TERMINAL_SVG =
  '<svg class="ag-run-svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M4.8 6.5L7 8.3l-2.2 1.8M8.3 10.2h2.8"/></svg>';

export function pickDominantRunningSubkind(subkinds) {
  let best = '';
  let bestRank = -1;
  for (const raw of subkinds || []) {
    const k = typeof raw === 'string' ? raw : '';
    const rank = RUNNING_SUBKIND_PRIORITY[k] || 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = k;
    }
  }
  return best || 'orbit';
}

export function renderRunningGlyphHtml(subkind) {
  if (subkind === 'subagent') {
    return `<span class="ag-run-ico ag-run-ico-subagent" data-subkind="subagent" aria-hidden="true">${RUN_BOT_SVG}</span>`;
  }
  if (subkind === 'timer') {
    return `<span class="ag-run-ico ag-run-ico-timer" data-subkind="timer" aria-hidden="true">${RUN_CLOCK_SVG}</span>`;
  }
  if (subkind === 'command') {
    return `<span class="ag-run-ico ag-run-ico-command" data-subkind="command" aria-hidden="true">${RUN_TERMINAL_SVG}</span>`;
  }
  if (subkind === 'bg-wait') {
    return '<span class="ag-run-bg-dot" data-subkind="bg-wait" aria-hidden="true"></span>';
  }
  return '<span class="ag-folder-orbit" aria-hidden="true"></span>';
}

function hasActiveChildInRedux(id, state) {
  const summaries = state?.trajectorySummaries?.summaries;
  const byParent = state?.trajectorySummaries?.indexes?.byParent;
  const rawChildren = byParent && byParent[id];
  if (!rawChildren || !summaries) return false;
  const childIds =
    typeof rawChildren[Symbol.iterator] === 'function'
      ? rawChildren
      : typeof rawChildren === 'object'
        ? Object.keys(rawChildren)
        : [];
  for (const cid of childIds) {
    const ch = summaries[cid];
    if (!ch || ch.killed) continue;
    const cs = ch.status ?? 0;
    if (
      cs === 2 ||
      cs === 3 ||
      cs === 4 ||
      Boolean(ch.hasRunningSubagents) ||
      Boolean(ch.hasActiveChildren) ||
      Boolean(ch.notFullyIdle)
    ) {
      return true;
    }
  }
  return false;
}

export function classifyRunningSubkind(id, summary, state, bgTaskState = null) {
  if (!summary || summary.killed) return null;
  const status = summary.status ?? 0;
  if (status === 2 || status === 3 || status === 4) {
    return { subkind: 'orbit', detail: '', needsBgLookup: false };
  }
  if (
    Boolean(summary.hasRunningSubagents) ||
    Boolean(summary.hasActiveChildren) ||
    hasActiveChildInRedux(id, state)
  ) {
    return { subkind: 'subagent', detail: '', needsBgLookup: false };
  }
  if (Boolean(summary.notFullyIdle) || Number(summary.backgroundTaskCount || 0) > 0) {
    const kind = bgTaskState && typeof bgTaskState.kind === 'string' ? bgTaskState.kind : '';
    if (kind === 'subagent' || kind === 'command' || kind === 'timer' || kind === 'bg-wait') {
      return { subkind: kind, detail: String(bgTaskState.detail || ''), needsBgLookup: true };
    }
    return { subkind: 'bg-wait', detail: '', needsBgLookup: true };
  }
  return null;
}

export function getRunningSubkindLabel(subkind, L) {
  const tr = typeof L === 'function' ? L : (_zh, en) => en;
  if (subkind === 'subagent') return tr('等待子代理 / Swarm', 'Waiting on subagent / Swarm');
  if (subkind === 'timer') return tr('等待定时器 / Cron', 'Waiting on timer / Cron');
  if (subkind === 'command') return tr('后台命令运行中', 'Background command running');
  if (subkind === 'bg-wait') return tr('后台等待中', 'Waiting in background');
  return tr('主代理执行中', 'Agent running');
}

export function formatRunningStatusTooltip(statusOrSubkind, L) {
  const subkind = typeof statusOrSubkind === 'string' ? statusOrSubkind : statusOrSubkind?.subkind || 'orbit';
  const detail = typeof statusOrSubkind === 'object' && statusOrSubkind ? String(statusOrSubkind.detail || '').trim() : '';
  const base = getRunningSubkindLabel(subkind, L);
  return detail ? `${base} · ${detail}` : base;
}

export function formatRunningPillText(subkind, count, isMixed, L) {
  const tr = typeof L === 'function' ? L : (_zh, en) => en;
  const n = Math.max(1, Number(count) || 1);
  if (isMixed || !subkind || subkind === 'orbit') {
    return tr(`${n} 运行中`, `${n} running`);
  }
  if (subkind === 'subagent') return tr(`${n} 子代理`, `${n} subagent`);
  if (subkind === 'command') return tr(`${n} 后台命令`, `${n} command`);
  if (subkind === 'timer') return tr(`${n} 定时等待`, `${n} timer`);
  return tr(`${n} 后台等待`, `${n} waiting`);
}

export function formatRunningBreakdownTooltip(runningItems, L) {
  const tr = typeof L === 'function' ? L : (_zh, en) => en;
  const items = Array.isArray(runningItems) ? runningItems : [];
  if (!items.length) return '';
  const counts = Object.create(null);
  for (const it of items) {
    const k = RUNNING_SUBKIND_PRIORITY[it?.subkind] ? it.subkind : 'orbit';
    counts[k] = (counts[k] || 0) + 1;
  }
  const summaryParts = [];
  for (const k of SUBKIND_ORDER) {
    const c = counts[k] || 0;
    if (!c) continue;
    summaryParts.push(tr(`${c} 个${getRunningSubkindLabel(k, tr)}`, `${c} ${getRunningSubkindLabel(k, tr).toLowerCase()}`));
  }
  const detailLines = [];
  for (const it of items) {
    if (detailLines.length >= 3) break;
    const statusDesc = formatRunningStatusTooltip(it, tr);
    const line = it?.title ? `${it.title} · ${statusDesc}` : statusDesc;
    if (line) detailLines.push(line);
  }
  return detailLines.length > 0 && (items.length > 1 || items[0]?.detail || items[0]?.title)
    ? `${summaryParts.join(' · ')}\n${detailLines.join('\n')}`
    : summaryParts.join(' · ');
}

export function createBgTaskStatusClient({
  onUpdated,
  callRpc,
  nowFn = () => Date.now(),
  ttlMs = 6000,
} = {}) {
  const cache = new Map(); // cid -> { kind, detail, toolName, sig, fetchedAt }
  let inFlightKey = '';
  let pollTimer = 0;
  let lastCandidates = [];
  let disposed = false;

  function clearPollTimer() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }

  function schedulePoll() {
    clearPollTimer();
    if (disposed || !lastCandidates.length || typeof callRpc !== 'function') return;
    pollTimer = setTimeout(() => {
      pollTimer = 0;
      if (disposed || !lastCandidates.length) return;
      syncCandidates(lastCandidates);
    }, ttlMs);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function getCachedState(cid) {
    return cache.get(cid) || null;
  }

  function syncCandidates(rawCandidates) {
    if (disposed) return false;
    const candidates = Array.isArray(rawCandidates) ? rawCandidates.filter((c) => c && c.id) : [];
    lastCandidates = candidates;

    const activeIds = new Set(candidates.map((c) => c.id));
    for (const key of cache.keys()) {
      if (!activeIds.has(key)) cache.delete(key);
    }

    if (!candidates.length) {
      clearPollTimer();
      return false;
    }

    if (typeof callRpc !== 'function') return false;

    const now = nowFn();
    const toFetch = [];
    for (const c of candidates) {
      const hit = cache.get(c.id);
      if (!hit || hit.sig !== c.sig || now - hit.fetchedAt >= ttlMs) {
        toFetch.push(c);
      }
    }

    schedulePoll();
    if (!toFetch.length) return false;

    const batchKey = toFetch
      .map((c) => `${c.id}:${c.sig || ''}`)
      .sort()
      .join('|');
    if (inFlightKey === batchKey) return false;
    inFlightKey = batchKey;

    const cascadeIds = toFetch.map((c) => c.id);
    const sigById = new Map(toFetch.map((c) => [c.id, c.sig || '']));

    Promise.resolve(callRpc('getBackgroundTaskStates', { cascadeIds }, 3000))
      .then((res) => {
        if (disposed || !res || !res.ok || !res.states || typeof res.states !== 'object') return;
        let changed = false;
        const fetchedAt = nowFn();
        for (const cid of cascadeIds) {
          const next = res.states[cid];
          if (!next || typeof next !== 'object') continue;
          const nextKind = typeof next.kind === 'string' && next.kind ? next.kind : 'bg-wait';
          const nextDetail = String(next.detail || '');
          const nextTool = String(next.toolName || '');
          const prev = cache.get(cid);
          if (!prev || prev.kind !== nextKind || prev.detail !== nextDetail || prev.toolName !== nextTool) {
            changed = true;
          }
          cache.set(cid, {
            kind: nextKind,
            detail: nextDetail,
            toolName: nextTool,
            sig: sigById.get(cid) || '',
            fetchedAt,
          });
        }
        if (changed) onUpdated?.();
      })
      .catch(() => {})
      .finally(() => {
        if (inFlightKey === batchKey) inFlightKey = '';
      });

    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearPollTimer();
    cache.clear();
    lastCandidates = [];
    inFlightKey = '';
  }

  return {
    getCachedState,
    syncCandidates,
    dispose,
  };
}
