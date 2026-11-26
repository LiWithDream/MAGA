/**
 * Dormant-by-default Renderer Tap for MAGA Remote Control.
 * Zero MutationObserver, zero DOM mutations. Discovers Redux store & lsClient
 * via duck-typed BFS from #root only when queried or enabled.
 */
export function createRemoteTapModule(rt) {
  const { state: rtState } = rt;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_BFS_NODES = 2500;
  const MAX_STREAMS = 3;
  const MAX_STEPS_SNAPSHOT = 200;
  const MAX_FIELD_CHARS = 16384;
  const INVOKE_METHODS = new Set(['convo.owns', 'convo.send', 'convo.approve', 'convo.cancel', 'convo.compact']);

  let active = false;
  let rpcToken = '';
  let throttleMs = 150;
  let storeUnsub = null;
  let summaryTimer = 0;
  let lastSummaryEmitTs = 0;
  let lastPresetSig = '';
  let lastIndexesSig = '';
  const lastSummarySigs = new Map();
  const streams = new Map(); // cascadeId -> { refCount, ap, sub, timer, lastEmitTs, sentStepIdx, sentLen, lastText, lastThinkingLen, lastStatus, lastStepCount }

  let cachedStore = null;
  let cachedLsClient = null;
  let cachedPrefStore = null;

  function safeCall(fn) {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  function truncateStr(val, max = MAX_FIELD_CHARS) {
    const s = String(val ?? '');
    if (s.length <= max) return s;
    const prefix = '…(truncated)\n';
    const keep = Math.max(256, max - prefix.length);
    return `${prefix}${s.slice(-keep)}`;
  }

  function toJsonSafe(val, depth = 0) {
    if (val === null || val === undefined) return val === undefined ? null : val;
    const t = typeof val;
    if (t === 'bigint') return Number.isSafeInteger(Number(val)) ? Number(val) : val.toString();
    if (t === 'string' || t === 'number' || t === 'boolean') return val;
    if (t === 'function' || t === 'symbol') return undefined;
    if (depth > 8) return null;
    if (Array.isArray(val)) {
      const out = [];
      for (let i = 0; i < val.length; i++) out.push(toJsonSafe(val[i], depth + 1));
      return out;
    }
    if (val instanceof Set) return Array.from(val).map((x) => toJsonSafe(x, depth + 1));
    if (val instanceof Map) {
      const obj = {};
      for (const [k, v] of val.entries()) obj[String(k)] = toJsonSafe(v, depth + 1);
      return obj;
    }
    const out = {};
    for (const k of Object.keys(val)) {
      if (k === '$typeName') continue;
      const cleaned = toJsonSafe(val[k], depth + 1);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }

  function toIsoTime(ts) {
    if (!ts) return '';
    if (typeof ts === 'string') return ts;
    if (typeof ts === 'number' || typeof ts === 'bigint') {
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= 0) return '';
      const ms = n > 1e12 ? n : n * 1000;
      return new Date(ms).toISOString();
    }
    if (ts.seconds !== undefined && ts.seconds !== null) {
      const sec = Number(ts.seconds);
      const ns = Number(ts.nanos || 0);
      if (!Number.isFinite(sec) || sec <= 0) return '';
      return new Date(sec * 1000 + Math.floor(ns / 1e6)).toISOString();
    }
    return '';
  }

  function isValidStore(cand) {
    return Boolean(cand && typeof cand.getState === 'function' && typeof cand.subscribe === 'function');
  }

  function isValidLsClient(cand) {
    return Boolean(
      cand &&
        typeof cand === 'object' &&
        typeof cand.sendUserCascadeMessage === 'function' &&
        typeof cand.handleCascadeUserInteraction === 'function' &&
        typeof cand.createAgentStateProviderForConvo === 'function' &&
        typeof cand.getCascadeTrajectory === 'function'
    );
  }

  function isValidPrefStore(cand) {
    if (!cand || typeof cand.getState !== 'function') return false;
    const pst = safeCall(() => cand.getState());
    return Boolean(pst && typeof pst.getPrefValue === 'function');
  }

  function locateHandles(force = false) {
    if (!force && isValidStore(cachedStore) && isValidLsClient(cachedLsClient)) {
      return { store: cachedStore, lsClient: cachedLsClient, prefStore: cachedPrefStore };
    }
    let store = !force && isValidStore(cachedStore) ? cachedStore : null;
    let lsClient = !force && isValidLsClient(cachedLsClient) ? cachedLsClient : null;
    let prefStore = !force && isValidPrefStore(cachedPrefStore) ? cachedPrefStore : null;

    if (typeof document !== 'undefined') {
      const root = document.getElementById('root') || (document.body && document.body.firstElementChild);
      const fk = root && Object.keys(root).find((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
      const start = fk ? root[fk] : null;
      if (start) {
        const queue = [start];
        const seen = new Set();
        const inspectCandidate = (cand) => {
          if (!cand || typeof cand !== 'object') return;
          if (!store && isValidStore(cand.store)) store = cand.store;
          if (!store && isValidStore(cand) && safeCall(() => cand.getState()?.trajectorySummaries)) store = cand;
          if (!lsClient) {
            if (isValidLsClient(cand)) lsClient = cand;
            else if (isValidLsClient(cand.lsClient)) lsClient = cand.lsClient;
            else if (isValidLsClient(cand.client)) lsClient = cand.client;
          }
          if (!prefStore && isValidPrefStore(cand)) prefStore = cand;
        };

        while (queue.length && seen.size < MAX_BFS_NODES) {
          const f = queue.shift();
          if (!f || seen.has(f)) continue;
          seen.add(f);

          const mp = f.memoizedProps;
          if (mp) {
            inspectCandidate(mp);
            if (mp.value) inspectCandidate(mp.value);
          }
          for (let dep = f.dependencies && f.dependencies.firstContext; dep; dep = dep.next) {
            inspectCandidate(dep.memoizedValue);
          }
          if (f.memoizedState) {
            let s = f.memoizedState;
            for (let k = 0; k < 15 && s; k++, s = s.next) {
              inspectCandidate(s.memoizedState);
            }
          }
          if (store && lsClient && prefStore) break;
          if (f.child) queue.push(f.child);
          if (f.sibling) queue.push(f.sibling);
        }
      }
    }

    if (store) cachedStore = store;
    if (lsClient) cachedLsClient = lsClient;
    if (prefStore) cachedPrefStore = prefStore;
    return { store, lsClient, prefStore };
  }

  function normalizeGlobalPreset(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) return Number(s);
    if (/TURBO/i.test(s)) return 3;
    if (/REQUEST_REVIEW|REVIEW/i.test(s)) return 2;
    if (/AUTO|SAFE|DEFAULT/i.test(s)) return 1;
    if (/OFF|READ_ONLY|NONE/i.test(s)) return 0;
    return null;
  }

  function readPresetInfo(st, prefStore) {
    const rawPreset =
      st?.userStatus?.permissionSettings?.globalPreset ??
      st?.userStatus?.permissions?.globalPreset ??
      safeCall(() => prefStore?.getState?.()?.getPrefValue?.('globalPreset')) ??
      safeCall(() => prefStore?.getState?.()?.getPrefValue?.('permissionPreset')) ??
      null;
    const globalPreset = normalizeGlobalPreset(rawPreset);
    const adminControls = toJsonSafe(
      st?.userStatus?.adminControls ?? st?.userStatus?.permissions?.adminControls ?? null
    );
    return { globalPreset, adminControls };
  }

  function normalizeSummaryStatus(sum) {
    if (!sum) return 'IDLE';
    if (sum.killed) return 'KILLED';
    if (Array.isArray(sum.waitingSteps) && sum.waitingSteps.length > 0) return 'WAITING';
    const s = sum.status;
    if (typeof s === 'string') {
      if (/RUNNING|IN_PROGRESS|ACTIVE/i.test(s)) return 'RUNNING';
      if (/CANCEL/i.test(s)) return 'CANCELED';
      if (/ERROR/i.test(s)) return 'ERROR';
      if (/WAIT/i.test(s)) return 'WAITING';
      return 'IDLE';
    }
    if (s === 2 || s === 3 || s === 4 || sum.notFullyIdle || sum.hasRunningSubagents) return 'RUNNING';
    return 'IDLE';
  }

  function normalizeStepType(rawType, stepCase) {
    if (stepCase) {
      if (stepCase === 'userInput') return 'USER_INPUT';
      if (stepCase === 'plannerResponse') return 'PLANNER_RESPONSE';
      if (stepCase === 'errorMessage') return 'ERROR_MESSAGE';
      if (stepCase === 'systemMessage') return 'SYSTEM_MESSAGE';
      if (stepCase === 'checkpoint') return 'CHECKPOINT';
      if (stepCase === 'runCommand' || stepCase === 'generic') return 'TOOL_CALL';
    }
    if (rawType === 14) return 'USER_INPUT';
    if (rawType === 15) return 'PLANNER_RESPONSE';
    if (rawType === 17) return 'ERROR_MESSAGE';
    if (rawType === 23) return 'CHECKPOINT';
    if (rawType === 101) return 'SYSTEM_MESSAGE';
    if (rawType === 132) return 'TOOL_CALL';
    return typeof rawType === 'string' ? rawType : 'GENERIC';
  }

  function normalizeStepStatus(rawStatus) {
    if (typeof rawStatus === 'string') return rawStatus.toUpperCase();
    switch (rawStatus) {
      case 1:
        return 'PENDING';
      case 2:
      case 8:
        return 'RUNNING';
      case 3:
        return 'DONE';
      case 4:
      case 7:
        return 'ERROR';
      case 5:
        return 'CLEARED';
      case 6:
        return 'CANCELED';
      default:
        return 'IDLE';
    }
  }

  function normalizeWaitingSteps(cid, rawList) {
    if (!Array.isArray(rawList) || rawList.length === 0) return [];
    const out = [];
    for (let i = 0; i < rawList.length; i++) {
      const w = rawList[i];
      if (!w || typeof w !== 'object') continue;
      const step = w.step || w;
      const info = step?.metadata?.sourceTrajectoryStepInfo || {};
      const stepIndex = Number.isInteger(Number(w.stepIndex))
        ? Number(w.stepIndex)
        : Number.isInteger(Number(info.stepIndex))
          ? Number(info.stepIndex)
          : i;
      const trajectoryId = String(info.trajectoryId || '');
      const reqInt = step?.requestedInteraction?.interaction;
      const interactionCase = String(reqInt?.case || '');
      const permRes = reqInt?.value?.resource || null;
      const tc = step?.metadata?.toolCall || {};
      let argsObj = {};
      if (typeof tc.argumentsJson === 'string' && tc.argumentsJson) {
        try {
          argsObj = JSON.parse(tc.argumentsJson);
        } catch {}
      }
      const rawToolName = String(tc.name || step?.step?.case || '');
      const toolName = rawToolName.includes(':') ? rawToolName.split(':').pop() : rawToolName;
      const action = String(permRes?.action || step?.metadata?.toolAction || interactionCase || '');
      const commandLine = String(
        step?.step?.value?.commandLine ||
          reqInt?.value?.commandLine ||
          (action === 'command' ? permRes?.target : '') ||
          argsObj?.CommandLine ||
          argsObj?.command ||
          permRes?.target ||
          ''
      );
      out.push({
        stepIndex,
        toolName,
        action,
        commandLine,
        trajectoryId,
        interactionCase,
      });
    }
    return out;
  }

  function normalizeSummaryItem(cid, sum) {
    const meta = sum.trajectoryMetadata || {};
    const title = String(sum.annotations?.title || sum.summary || cid).trim();
    const waitingSteps = normalizeWaitingSteps(cid, sum.waitingSteps);
    return {
      id: cid,
      title,
      summary: String(sum.summary || '').trim(),
      status: normalizeSummaryStatus(sum),
      stepCount: Number(sum.stepCount || 0),
      lastModifiedTime: toIsoTime(sum.lastModifiedTime),
      projectId: String(meta.projectId || sum.projectId || ''),
      parentConversationId: String(meta.parentConversationId || ''),
      waitingSteps,
    };
  }

  function normalizeIndexKeys(idxCol) {
    if (!idxCol) return [];
    if (typeof idxCol.keys === 'function' && idxCol instanceof Set) return Array.from(idxCol);
    if (Array.isArray(idxCol)) return idxCol.slice();
    if (typeof idxCol === 'object') return Object.keys(idxCol).filter((k) => Boolean(idxCol[k]));
    return [];
  }

  function normalizeByParent(byParent) {
    const out = {};
    if (!byParent || typeof byParent !== 'object') return out;
    for (const parentId of Object.keys(byParent)) {
      const rawChildren = byParent[parentId];
      if (!rawChildren) continue;
      if (Array.isArray(rawChildren)) out[parentId] = rawChildren.slice();
      else if (typeof rawChildren[Symbol.iterator] === 'function') out[parentId] = Array.from(rawChildren);
      else if (typeof rawChildren === 'object') out[parentId] = Object.keys(rawChildren);
    }
    return out;
  }

  function emitEvent(kind, data) {
    if (!active || rtState.disposed || !rpcToken) return false;
    if (typeof window === 'undefined' || typeof window.__agRemoteTapEvent !== 'function') return false;
    try {
      window.__agRemoteTapEvent(
        JSON.stringify({
          token: rpcToken,
          kind,
          ts: Date.now(),
          data,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  function computeSummarySig(item) {
    const wSig = item.waitingSteps
      .map((w) => `${w.trajectoryId}:${w.stepIndex}:${w.interactionCase}:${w.toolName}:${w.commandLine}`)
      .join(',');
    return `${item.status}|${item.stepCount}|${item.lastModifiedTime}|${item.title}|${item.parentConversationId}|${item.projectId}|${wSig}`;
  }

  function flushSummaries(forceAll = false) {
    if (summaryTimer) {
      clearTimeout(summaryTimer);
      summaryTimer = 0;
    }
    if (!active || rtState.disposed) return;
    const { store, prefStore } = locateHandles();
    if (!store) return;
    const st = safeCall(() => store.getState());
    if (!st) return;

    const ts = st.trajectorySummaries || {};
    const rawSummaries = ts.summaries || {};
    const { globalPreset, adminControls } = readPresetInfo(st, prefStore);
    const hasWaitingSteps = normalizeIndexKeys(ts.indexes?.hasWaitingSteps);
    const byParent = normalizeByParent(ts.indexes?.byParent);

    const presetSig = `${globalPreset ?? ''}|${JSON.stringify(adminControls)}`;
    const indexesSig = `${hasWaitingSteps.join(',')}|${JSON.stringify(byParent)}`;
    const changed = [];
    const removed = [];
    const seen = new Set();

    for (const cid of Object.keys(rawSummaries)) {
      const raw = rawSummaries[cid];
      if (!raw) continue;
      seen.add(cid);
      const norm = normalizeSummaryItem(cid, raw);
      const sig = computeSummarySig(norm);
      if (forceAll || lastSummarySigs.get(cid) !== sig) {
        lastSummarySigs.set(cid, sig);
        changed.push(norm);
      }
    }
    for (const prevId of Array.from(lastSummarySigs.keys())) {
      if (!seen.has(prevId)) {
        lastSummarySigs.delete(prevId);
        removed.push(prevId);
      }
    }

    const presetChanged = presetSig !== lastPresetSig;
    const indexesChanged = indexesSig !== lastIndexesSig;
    if (forceAll || changed.length > 0 || removed.length > 0 || presetChanged || indexesChanged) {
      lastPresetSig = presetSig;
      lastIndexesSig = indexesSig;
      lastSummaryEmitTs = Date.now();
      emitEvent('summaries', {
        globalPreset,
        adminControls,
        changed,
        removed,
        hasWaitingSteps,
        byParent,
      });
    }
  }

  function scheduleSummaryFlush() {
    if (!active || rtState.disposed || summaryTimer) return;
    const elapsed = Date.now() - lastSummaryEmitTs;
    const delay = elapsed >= throttleMs ? 0 : Math.max(20, throttleMs - elapsed);
    summaryTimer = setTimeout(() => {
      summaryTimer = 0;
      flushSummaries(false);
    }, delay);
  }

  function extractStepRecord(s, idx) {
    const stepCase = s?.step?.case || '';
    const val = s?.step?.value || {};
    const type = normalizeStepType(s?.type, stepCase);
    const status = normalizeStepStatus(s?.status);
    const createdAt = toIsoTime(s?.metadata?.createdAt);
    let text = '';
    let thinking = '';
    const toolCalls = [];

    if (stepCase === 'userInput' || type === 'USER_INPUT') {
      if (typeof val.userResponse === 'string' && val.userResponse) {
        text = val.userResponse;
      } else if (Array.isArray(val.items)) {
        text = val.items
          .filter((it) => it && it.chunk && it.chunk.case === 'text')
          .map((it) => it.chunk.value || '')
          .join('');
      }
    } else if (stepCase === 'plannerResponse' || type === 'PLANNER_RESPONSE') {
      text = String(val.modifiedResponse || val.response || '');
      thinking = String(val.thinking || val.rawThinking || '');
      if (Array.isArray(val.toolCalls)) {
        for (const tc of val.toolCalls) {
          if (!tc) continue;
          const rawName = String(tc.name || '');
          toolCalls.push({
            id: String(tc.id || ''),
            name: rawName.includes(':') ? rawName.split(':').pop() : rawName,
            args: truncateStr(tc.argumentsJson || '', 4096),
          });
        }
      }
    } else if (stepCase === 'errorMessage' || type === 'ERROR_MESSAGE') {
      text = String(val.userMessage || val.message || s?.errorDetails?.message || '');
    } else if (stepCase === 'systemMessage' || type === 'SYSTEM_MESSAGE') {
      text = String(val.message || '');
    } else {
      const tc = s?.metadata?.toolCall || {};
      const rawName = String(tc.name || stepCase || '');
      const name = rawName.includes(':') ? rawName.split(':').pop() : rawName;
      const outText =
        val?.combinedOutput?.full || val?.stdout || val?.result?.output || val?.result?.text || val?.commandLine || '';
      if (name || tc.id || outText) {
        toolCalls.push({
          id: String(tc.id || ''),
          name: name || 'tool',
          args: truncateStr(tc.argumentsJson || (val?.args ? JSON.stringify(toJsonSafe(val.args)) : ''), 4096),
          output: truncateStr(typeof outText === 'string' ? outText : JSON.stringify(toJsonSafe(outText)), 8192),
        });
      }
      if (typeof val?.commandLine === 'string' && val.commandLine) {
        text = val.commandLine;
      }
    }

    const error = s?.errorDetails ? toJsonSafe(s.errorDetails) : null;
    return {
      idx,
      type,
      status,
      createdAt,
      text: truncateStr(text),
      thinking: truncateStr(thinking),
      toolCalls,
      error,
    };
  }

  const STREAM_CHUNK_LIMIT = 48 * 1024;

  function extractStreamState(as) {
    const steps = as?.trajectorySlice?.stepsInSlice || [];
    const last = steps.length > 0 ? steps[steps.length - 1] : null;
    const rawStepIdx = last?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
    const stepIdx = Number.isInteger(Number(rawStepIdx)) ? Number(rawStepIdx) : Math.max(0, steps.length - 1);
    const stepCase = last?.step?.case || '';
    const val = last?.step?.value || {};
    const fullText = stepCase === 'plannerResponse' ? String(val.modifiedResponse || val.response || '') : '';
    const thinking = stepCase === 'plannerResponse' ? String(val.thinking || val.rawThinking || '') : '';
    return {
      stepIdx,
      fullText,
      thinkingLen: thinking.length,
      status: normalizeStepStatus(as?.status),
      stepCount: steps.length,
    };
  }

  function flushStreamEntry(cid, entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = 0;
    }
    if (!active || rtState.disposed || !streams.has(cid)) return;
    const as = safeCall(() => entry.ap.getState());
    if (!as) return;
    const next = extractStreamState(as);
    const changed =
      next.stepIdx !== entry.sentStepIdx ||
      next.fullText.length !== entry.sentLen ||
      next.status !== entry.lastStatus ||
      next.thinkingLen !== entry.lastThinkingLen ||
      next.stepCount !== entry.lastStepCount;
    if (!changed) return;

    const isReset = next.stepIdx !== entry.sentStepIdx || next.fullText.length < entry.sentLen;
    const baseOffset = isReset ? 0 : entry.sentLen;
    const deltaText = isReset ? next.fullText : next.fullText.slice(entry.sentLen);

    entry.sentStepIdx = next.stepIdx;
    entry.sentLen = next.fullText.length;
    entry.lastText = next.fullText;
    entry.lastStatus = next.status;
    entry.lastThinkingLen = next.thinkingLen;
    entry.lastStepCount = next.stepCount;
    entry.lastEmitTs = Date.now();

    if (deltaText.length <= STREAM_CHUNK_LIMIT) {
      emitEvent('stream', {
        cascadeId: cid,
        stepIdx: next.stepIdx,
        offset: baseOffset,
        chunk: deltaText,
        reset: isReset,
        status: next.status,
        thinkingLen: next.thinkingLen,
        stepCount: next.stepCount,
        updatedAt: entry.lastEmitTs,
      });
      return;
    }

    for (let pos = 0; pos < deltaText.length; pos += STREAM_CHUNK_LIMIT) {
      const part = deltaText.slice(pos, pos + STREAM_CHUNK_LIMIT);
      emitEvent('stream', {
        cascadeId: cid,
        stepIdx: next.stepIdx,
        offset: baseOffset + pos,
        chunk: part,
        reset: isReset && pos === 0,
        status: next.status,
        thinkingLen: next.thinkingLen,
        stepCount: next.stepCount,
        updatedAt: entry.lastEmitTs,
      });
    }
  }

  function disposeStreamEntry(cid) {
    const entry = streams.get(cid);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = 0;
    }
    try {
      entry.sub?.dispose?.();
    } catch {}
    try {
      entry.ap?.dispose?.();
    } catch {}
    streams.delete(cid);
  }

  function enable(opts = {}) {
    if (rtState.disposed) return { ok: false, error: 'disposed' };
    const nextToken = typeof opts?.token === 'string' ? opts.token : '';
    if (!nextToken) return { ok: false, error: 'missing_token' };
    const nextThrottle = Number(opts?.throttleMs);
    if (Number.isFinite(nextThrottle)) {
      throttleMs = Math.max(100, Math.min(200, Math.round(nextThrottle)));
    }

    const { store } = locateHandles();
    if (!store) return { ok: false, error: 'store_unavailable' };

    rpcToken = nextToken;
    if (!active) {
      active = true;
      lastSummarySigs.clear();
      lastPresetSig = '';
      lastIndexesSig = '';
      try {
        storeUnsub = store.subscribe(() => {
          scheduleSummaryFlush();
        });
      } catch (err) {
        active = false;
        rpcToken = '';
        return { ok: false, error: String(err?.message || err) };
      }
      flushSummaries(true);
    }
    return {
      ok: true,
      active: true,
      activeStreams: Array.from(streams.keys()),
    };
  }

  function disable() {
    active = false;
    rpcToken = '';
    if (summaryTimer) {
      clearTimeout(summaryTimer);
      summaryTimer = 0;
    }
    if (typeof storeUnsub === 'function') {
      try {
        storeUnsub();
      } catch {}
    }
    storeUnsub = null;
    for (const cid of Array.from(streams.keys())) {
      disposeStreamEntry(cid);
    }
    lastSummarySigs.clear();
    lastPresetSig = '';
    lastIndexesSig = '';
    return { ok: true, active: false };
  }

  function watch(cid) {
    if (rtState.disposed) return { ok: false, error: 'disposed', activeStreams: [] };
    if (!UUID_RE.test(String(cid || ''))) {
      return { ok: false, error: 'invalid_cascade_id', activeStreams: Array.from(streams.keys()) };
    }
    if (!active) {
      return { ok: false, error: 'tap_not_active', activeStreams: Array.from(streams.keys()) };
    }
    const existing = streams.get(cid);
    if (existing) {
      existing.refCount += 1;
      return { ok: true, watching: true, activeStreams: Array.from(streams.keys()) };
    }
    if (streams.size >= MAX_STREAMS) {
      return { ok: false, error: 'max_streams_reached', activeStreams: Array.from(streams.keys()) };
    }

    const { lsClient } = locateHandles();
    if (!lsClient) {
      return { ok: false, error: 'ls_client_unavailable', activeStreams: Array.from(streams.keys()) };
    }

    let ap = null;
    let sub = null;
    try {
      ap = lsClient.createAgentStateProviderForConvo(cid, {});
      const entry = {
        refCount: 1,
        ap,
        sub: null,
        timer: 0,
        lastEmitTs: 0,
        sentStepIdx: -1,
        sentLen: 0,
        lastText: '',
        lastThinkingLen: 0,
        lastStatus: 'IDLE',
        lastStepCount: 0,
      };
      sub = ap.onDidChange(() => {
        if (!active || rtState.disposed || !streams.has(cid)) return;
        if (entry.timer) return;
        const elapsed = Date.now() - entry.lastEmitTs;
        const delay = elapsed >= 100 ? 0 : 100 - elapsed;
        entry.timer = setTimeout(() => {
          entry.timer = 0;
          flushStreamEntry(cid, entry);
        }, delay);
      });
      entry.sub = sub;
      streams.set(cid, entry);
      flushStreamEntry(cid, entry);
      return { ok: true, watching: true, activeStreams: Array.from(streams.keys()) };
    } catch (err) {
      try {
        sub?.dispose?.();
      } catch {}
      try {
        ap?.dispose?.();
      } catch {}
      streams.delete(cid);
      return { ok: false, error: String(err?.message || err), activeStreams: Array.from(streams.keys()) };
    }
  }

  function unwatch(cid, force = false) {
    if (!UUID_RE.test(String(cid || ''))) {
      return { ok: false, error: 'invalid_cascade_id', activeStreams: Array.from(streams.keys()) };
    }
    const entry = streams.get(cid);
    if (!entry) {
      return { ok: true, watching: false, activeStreams: Array.from(streams.keys()) };
    }
    entry.refCount -= 1;
    if (force || entry.refCount <= 0) {
      disposeStreamEntry(cid);
    }
    return { ok: true, watching: streams.has(cid), activeStreams: Array.from(streams.keys()) };
  }

  function getCapabilities() {
    if (rtState.disposed) return { ok: false, error: 'disposed' };
    const { store, lsClient, prefStore } = locateHandles();
    const st = store ? safeCall(() => store.getState()) : null;
    const { globalPreset, adminControls } = readPresetInfo(st, prefStore);
    const agVersion =
      typeof window !== 'undefined' && window.__APP_CONFIG__ && typeof window.__APP_CONFIG__.appVersion === 'string'
        ? window.__APP_CONFIG__.appVersion
        : null;
    return {
      ok: true,
      agVersion,
      globalPreset,
      adminControls,
      tapActive: active,
      activeStreams: Array.from(streams.keys()),
      capabilities: {
        reduxSummaries: Boolean(store && typeof store.getState === 'function'),
        agentStream: Boolean(lsClient && typeof lsClient.createAgentStateProviderForConvo === 'function'),
        sendMessage: Boolean(lsClient && typeof lsClient.sendUserCascadeMessage === 'function'),
        cancel: Boolean(lsClient && typeof lsClient.cancelCascadeInvocation === 'function'),
        approval: Boolean(lsClient && typeof lsClient.handleCascadeUserInteraction === 'function'),
        compact: Boolean(
          typeof window !== 'undefined' &&
            typeof window.__agClaudeUxBridge?.triggerConversationCompact === 'function'
        ),
        diskRead: true,
      },
    };
  }

  function listSummaries(opts = {}) {
    if (rtState.disposed) return { ok: false, error: 'disposed' };
    const includeSubagents = Boolean(opts && opts.includeSubagents);
    const { store, prefStore } = locateHandles();
    if (!store) return { ok: false, error: 'store_unavailable' };
    const st = safeCall(() => store.getState());
    if (!st) return { ok: false, error: 'state_unavailable' };
    const { globalPreset, adminControls } = readPresetInfo(st, prefStore);
    const rawSummaries = st.trajectorySummaries?.summaries || {};
    const byParent = normalizeByParent(st.trajectorySummaries?.indexes?.byParent);
    const conversations = [];

    const collectWaitingSubagents = (parentId) => {
      const out = [];
      const visited = new Set([parentId]);
      const queue = Array.isArray(byParent[parentId]) ? [...byParent[parentId]] : [];
      while (queue.length > 0) {
        const childId = queue.shift();
        if (!childId || visited.has(childId)) continue;
        visited.add(childId);
        const childSum = rawSummaries[childId];
        if (childSum && Array.isArray(childSum.waitingSteps) && childSum.waitingSteps.length > 0) {
          out.push({
            id: childId,
            title: String(childSum.annotations?.title || childSum.summary || childId).trim(),
            waitingSteps: normalizeWaitingSteps(childId, childSum.waitingSteps),
          });
        }
        const grand = byParent[childId];
        if (Array.isArray(grand)) {
          for (const g of grand) queue.push(g);
        }
      }
      return out;
    };

    for (const cid of Object.keys(rawSummaries)) {
      const sum = rawSummaries[cid];
      if (!sum) continue;
      if (!includeSubagents && sum.trajectoryMetadata?.parentConversationId) continue;
      const item = normalizeSummaryItem(cid, sum);
      const waitingSubagents = collectWaitingSubagents(cid);
      if (waitingSubagents.length > 0) item.waitingSubagents = waitingSubagents;
      conversations.push(item);
    }

    conversations.sort((a, b) => {
      const wa = a.waitingSteps.length > 0 || (a.waitingSubagents && a.waitingSubagents.length > 0) ? 1 : 0;
      const wb = b.waitingSteps.length > 0 || (b.waitingSubagents && b.waitingSubagents.length > 0) ? 1 : 0;
      if (wa !== wb) return wb - wa;
      return String(b.lastModifiedTime || '').localeCompare(String(a.lastModifiedTime || ''));
    });

    return {
      ok: true,
      source: 'cdp',
      globalPreset,
      adminControls,
      conversations,
      hasWaitingSteps: normalizeIndexKeys(st.trajectorySummaries?.indexes?.hasWaitingSteps),
      byParent,
    };
  }

  async function getSnapshot(cid, opts = {}) {
    if (rtState.disposed) return { ok: false, error: 'disposed' };
    if (!UUID_RE.test(String(cid || ''))) return { ok: false, error: 'invalid_cascade_id' };
    let { store, lsClient } = locateHandles();
    if (!lsClient) {
      ({ store, lsClient } = locateHandles(true));
    }
    if (!lsClient) return { ok: false, error: 'ls_client_unavailable' };

    let traj = null;
    try {
      traj = await lsClient.getCascadeTrajectory({ cascadeId: cid });
    } catch {
      ({ store, lsClient } = locateHandles(true));
      if (!lsClient) return { ok: false, error: 'ls_client_unavailable' };
      try {
        traj = await lsClient.getCascadeTrajectory({ cascadeId: cid });
      } catch (err) {
        return { ok: false, error: String(err?.message || err || 'trajectory_fetch_failed') };
      }
    }

    const st = store ? safeCall(() => store.getState()) : null;
    const sum = st?.trajectorySummaries?.summaries?.[cid] || null;
    const waitingSteps = sum ? normalizeWaitingSteps(cid, sum.waitingSteps) : [];

    const rawSteps = Array.isArray(traj?.trajectory?.steps) ? traj.trajectory.steps : [];
    const total = rawSteps.length;
    const beforeIdx = Number.isInteger(opts?.beforeIdx) && opts.beforeIdx >= 0 ? opts.beforeIdx : null;
    const endIdx = beforeIdx !== null ? Math.min(total, beforeIdx) : total;
    const startIdx = endIdx > MAX_STEPS_SNAPSHOT ? endIdx - MAX_STEPS_SNAPSHOT : 0;
    const steps = [];
    for (let i = startIdx; i < endIdx; i++) {
      steps.push(extractStepRecord(rawSteps[i], i));
    }

    const streamEntry = streams.get(cid);
    const status = sum
      ? normalizeSummaryStatus(sum)
      : waitingSteps.length > 0
        ? 'WAITING'
        : traj?.status === 2
          ? 'RUNNING'
          : 'IDLE';

    let streamingText =
      status === 'RUNNING' && streamEntry?.lastText ? truncateStr(streamEntry.lastText, 64 * 1024) : '';
    if (!streamingText && steps.length > 0) {
      const last = steps[steps.length - 1];
      if (last.type === 'PLANNER_RESPONSE' && last.status === 'RUNNING') {
        streamingText = last.text;
      }
    }

    return {
      ok: true,
      cascadeId: cid,
      source: 'cdp',
      status,
      steps,
      hasMore: startIdx > 0,
      nextBeforeIdx: startIdx > 0 ? startIdx : null,
      waitingSteps,
      streamingText,
    };
  }

  const PERMISSION_SCOPE_ONCE = 1;

  async function computeWaitingStepHashAsync(cascadeId, step) {
    const stepIndex = Number(step?.stepIndex ?? 0);
    const trajectoryId = String(step?.trajectoryId || '');
    const interactionCase = String(step?.interactionCase || '');
    const toolName = String(step?.toolName || '');
    const action = String(step?.action || '');
    const commandLine = String(step?.commandLine || '');
    const raw = `${cascadeId}|${trajectoryId}|${stepIndex}|${interactionCase}|${toolName}|${action}|${commandLine}`;
    const subtle =
      (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) ||
      (typeof window !== 'undefined' && window.crypto?.subtle) ||
      null;
    if (!subtle || typeof TextEncoder === 'undefined') return '';
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  }

  function isSafeNonTurboPreset(preset) {
    if (typeof preset === 'boolean' || preset === null || preset === undefined) return false;
    if (typeof preset === 'string' && !/^\d+$/.test(preset.trim())) return false;
    const n = Number(preset);
    return n === 1 || n === 2;
  }

  function isTurboLikePreset(preset) {
    return !isSafeNonTurboPreset(preset);
  }

  function checkOwnsConversation(payload) {
    const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
    if (!UUID_RE.test(cid)) return { ok: false, error: 'invalid_cascade_id' };
    const { store } = locateHandles();
    const st = store ? safeCall(() => store.getState()) : null;
    const owned = Boolean(st?.trajectorySummaries?.summaries?.[cid]);
    const active = Boolean(
      typeof window !== 'undefined' &&
        typeof window.location?.pathname === 'string' &&
        window.location.pathname.includes(cid)
    );
    return { ok: true, owned, active };
  }

  async function sendMessage(payload) {
    const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
    if (!UUID_RE.test(cid)) return { ok: false, error: 'invalid_cascade_id' };
    if (typeof payload?.text !== 'string') return { ok: false, error: 'invalid_text' };
    const text = payload.text;
    if (!text.trim() || text.length > MAX_FIELD_CHARS) return { ok: false, error: 'invalid_text_length' };

    let { store, lsClient, prefStore } = locateHandles();
    if (!lsClient) {
      ({ store, lsClient, prefStore } = locateHandles(true));
    }
    if (!lsClient || typeof lsClient.sendUserCascadeMessage !== 'function') {
      return { ok: false, error: 'send_not_supported' };
    }

    const st = store ? safeCall(() => store.getState()) : null;
    const { globalPreset } = readPresetInfo(st, prefStore);
    if (isTurboLikePreset(globalPreset) && payload?.turboWriteConfirmed !== true) {
      return { ok: false, error: 'turbo_write_confirmation_required', globalPreset: globalPreset ?? null };
    }

    try {
      await lsClient.sendUserCascadeMessage({
        cascadeId: cid,
        items: [{ chunk: { case: 'text', value: text } }],
      });
      return { ok: true, cascadeId: cid, globalPreset: globalPreset ?? null };
    } catch (err) {
      return { ok: false, error: String(err?.message || err || 'send_failed') };
    }
  }

  async function approveInteraction(payload) {
    const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
    if (!UUID_RE.test(cid)) return { ok: false, error: 'invalid_cascade_id' };
    const decision = payload?.decision;
    if (decision !== 'allow_once' && decision !== 'deny') return { ok: false, error: 'invalid_decision' };
    const stepIndex = payload?.stepIndex;
    if (!Number.isInteger(stepIndex) || stepIndex < 0) return { ok: false, error: 'invalid_step_index' };
    const expectedHash = typeof payload?.waitingStepHash === 'string' ? payload.waitingStepHash.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{16}$/.test(expectedHash)) return { ok: false, error: 'invalid_waiting_step_hash' };

    let { store, lsClient } = locateHandles();
    if (!store || !lsClient) {
      ({ store, lsClient } = locateHandles(true));
    }
    if (!store || typeof store.getState !== 'function') return { ok: false, error: 'store_unavailable' };
    if (!lsClient || typeof lsClient.handleCascadeUserInteraction !== 'function') {
      return { ok: false, error: 'approval_not_supported' };
    }

    const st = safeCall(() => store.getState());
    const sum = st?.trajectorySummaries?.summaries?.[cid] || null;
    if (!sum) return { ok: false, error: 'conversation_not_found' };

    const waiting = normalizeWaitingSteps(cid, sum.waitingSteps);
    let matched = null;
    for (const w of waiting) {
      if (w.stepIndex !== stepIndex) continue;
      const liveHash = await computeWaitingStepHashAsync(cid, w);
      if (liveHash && liveHash === expectedHash) {
        matched = w;
        break;
      }
    }
    if (!matched) {
      return { ok: false, error: 'waiting_step_mismatch' };
    }
    if (matched.interactionCase && matched.interactionCase !== 'permission') {
      return {
        ok: false,
        error: 'unsupported_interaction_case',
        interactionCase: matched.interactionCase,
      };
    }

    try {
      await lsClient.handleCascadeUserInteraction(cid, {
        trajectoryId: matched.trajectoryId || '',
        stepIndex: matched.stepIndex,
        interaction: {
          case: 'permission',
          value: {
            allow: decision === 'allow_once',
            scope: PERMISSION_SCOPE_ONCE,
          },
        },
      });
      return {
        ok: true,
        cascadeId: cid,
        stepIndex: matched.stepIndex,
        waitingStepHash: expectedHash,
        decision,
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err || 'approve_failed') };
    }
  }

  async function cancelConversation(payload) {
    const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
    if (!UUID_RE.test(cid)) return { ok: false, error: 'invalid_cascade_id' };
    let { lsClient } = locateHandles();
    if (!lsClient) {
      ({ lsClient } = locateHandles(true));
    }
    if (!lsClient || typeof lsClient.cancelCascadeInvocation !== 'function') {
      return { ok: false, error: 'cancel_not_supported' };
    }
    try {
      await lsClient.cancelCascadeInvocation({
        cascadeId: cid,
        killBackgroundTasks: Boolean(payload?.killBackgroundTasks),
      });
      return { ok: true, cascadeId: cid };
    } catch (err) {
      return { ok: false, error: String(err?.message || err || 'cancel_failed') };
    }
  }

  async function compactConversation(payload) {
    const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
    if (!UUID_RE.test(cid)) return { ok: false, error: 'invalid_cascade_id' };
    const triggerFn =
      typeof window !== 'undefined' ? window.__agClaudeUxBridge?.triggerConversationCompact : null;
    if (typeof triggerFn !== 'function') {
      return { ok: false, error: 'compact_unavailable' };
    }
    const selCid =
      typeof document !== 'undefined'
        ? document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]')?.getAttribute('data-cascade-id')
        : '';
    const isActive = Boolean(
      typeof window !== 'undefined' &&
        ((typeof window.location?.pathname === 'string' && window.location.pathname.includes(cid)) ||
          window.__ag_watched_cascade_id === cid ||
          selCid === cid)
    );
    if (!isActive) {
      return { ok: false, error: 'compact_requires_active_pane' };
    }
    try {
      const ok = await triggerFn({ expectedCid: cid, requireEmptyDraft: true });
      if (!ok) {
        return { ok: false, error: 'compact_rejected_or_busy' };
      }
      return { ok: true, cascadeId: cid };
    } catch (err) {
      return { ok: false, error: String(err?.message || err || 'compact_failed') };
    }
  }

  async function invoke(method, payload) {
    if (rtState.disposed) return { ok: false, error: 'disposed' };
    if (typeof method !== 'string' || !INVOKE_METHODS.has(method)) {
      return { ok: false, error: 'disallowed_invoke_method' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, error: 'invalid_invoke_payload' };
    }
    if (method === 'convo.owns') return checkOwnsConversation(payload);
    if (method === 'convo.send') return sendMessage(payload);
    if (method === 'convo.approve') return approveInteraction(payload);
    if (method === 'convo.cancel') return cancelConversation(payload);
    if (method === 'convo.compact') return compactConversation(payload);
    return { ok: false, error: 'disallowed_invoke_method' };
  }

  const api = {
    enable,
    disable,
    watch,
    unwatch,
    getCapabilities,
    listSummaries,
    getSnapshot,
    invoke,
  };

  if (typeof window !== 'undefined') {
    window.__agRemoteTap = api;
  }

  function dispose() {
    disable();
    cachedStore = null;
    cachedLsClient = null;
    cachedPrefStore = null;
    if (typeof window !== 'undefined' && window.__agRemoteTap === api) {
      window.__agRemoteTap = null;
    }
  }

  return { dispose };
}
