/**
 * Dormant-by-default Renderer Tap for MAGA Remote Control.
 * Zero MutationObserver, zero DOM mutations. Discovers Redux store & lsClient
 * via duck-typed BFS from #root only when queried or enabled.
 */
import {
  CANONICAL_COMPACT_SLASH_INFO,
  MAX_FIELD_CHARS,
  buildMessageItemsWithSlashCommands,
  buildSlashCommandItems,
  computeSummarySig,
  computeWaitingStepHashAsync,
  extractStepRecord,
  isTurboLikePreset,
  normalizeByParent,
  normalizeGlobalPreset,
  normalizeIndexKeys,
  normalizeStepStatus,
  normalizeSummaryItem,
  normalizeSummaryStatus,
  normalizeWaitingSteps,
  sanitizeSlashCommands,
  toJsonSafe,
  truncateStr,
} from './remote-tap-helpers.mjs';

export function createRemoteTapModule(rt, modelApi = null) {
  const { state: rtState } = rt;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_BFS_NODES = 2500;
  const MAX_STREAMS = 3;
  const MAX_STEPS_SNAPSHOT = 200;
  const MAX_MEDIA_ITEMS = 4;
  const MAX_MEDIA_B64_ITEM = 620_000;
  const MAX_MEDIA_B64_TOTAL = 1_400_000;
  const ALLOWED_MEDIA_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const BASE64_RE = /^[A-Za-z0-9+/=]+$/;
  const EFFORT_LABEL_RE = /^(.*?)\s*\((Low|Medium|High|XHigh|Extra|Max)\)\s*$/i;
  const EFFORT_NORM = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', extra: 'XHigh', max: 'Max' };
  const EFFORT_DISPLAY = { XHigh: 'Extra' };
  const INVOKE_METHODS = new Set([
    'convo.owns',
    'convo.create',
    'convo.send',
    'convo.approve',
    'convo.cancel',
    'convo.compact',
    'models.list',
    'models.select',
  ]);

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
  let cachedSlashCommands = [];

  function safeCall(fn) {
    try {
      return fn();
    } catch {
      return undefined;
    }
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

  function isConversationActiveInDom(cid) {
    if (!cid || typeof window === 'undefined') return false;
    if (typeof window.location?.pathname === 'string' && window.location.pathname.includes(cid)) return true;
    if (window.__ag_watched_cascade_id === cid) return true;
    if (typeof document !== 'undefined') {
      const selCid = document
        .querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]')
        ?.getAttribute('data-cascade-id');
      if (selCid === cid) return true;
    }
    return false;
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
        createConversation: Boolean(
          typeof rt?.hooks?.startNewChatInProjectById === 'function' ||
            (typeof window !== 'undefined' && typeof window.__agClaudeUxBridge?.startNewChatInProjectById === 'function')
        ),
        cancel: Boolean(lsClient && typeof lsClient.cancelCascadeInvocation === 'function'),
        approval: Boolean(lsClient && typeof lsClient.handleCascadeUserInteraction === 'function'),
        compact: Boolean(
          (lsClient && typeof lsClient.sendUserCascadeMessage === 'function') ||
            (typeof window !== 'undefined' &&
              typeof window.__agClaudeUxBridge?.triggerConversationCompact === 'function')
        ),
        modelSelect: Boolean(store && typeof store.dispatch === 'function'),
        imageAttachments: Boolean(lsClient && typeof lsClient.sendUserCascadeMessage === 'function'),
        diskRead: true,
      },
      slashCommands: sanitizeSlashCommands(discoverSlashCommandItems()),
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

  function decodeBase64ToBytes(b64) {
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) {
        bytes[i] = bin.charCodeAt(i);
      }
      return bytes;
    }
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    throw new Error('base64_decode_unavailable');
  }

  function buildTapMediaObjects(rawMedia) {
    if (rawMedia === undefined || rawMedia === null) return { ok: true, media: [] };
    if (!Array.isArray(rawMedia)) return { ok: false, error: 'invalid_media' };
    if (rawMedia.length > MAX_MEDIA_ITEMS) return { ok: false, error: 'too_many_media_items' };
    let totalB64Len = 0;
    const out = [];
    const zeroTs = typeof BigInt === 'function' ? BigInt(0) : 0;
    for (const item of rawMedia) {
      if (!item || typeof item !== 'object') return { ok: false, error: 'invalid_media_item' };
      const mimeType = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
      if (!ALLOWED_MEDIA_MIMES.has(mimeType)) return { ok: false, error: 'unsupported_media_mime' };
      const b64 = typeof item.dataBase64 === 'string' ? item.dataBase64.trim() : '';
      if (!b64 || b64.length > MAX_MEDIA_B64_ITEM || !BASE64_RE.test(b64)) {
        return { ok: false, error: 'invalid_media_data' };
      }
      totalB64Len += b64.length;
      if (totalB64Len > MAX_MEDIA_B64_TOTAL) return { ok: false, error: 'media_payload_too_large' };
      const bytes = decodeBase64ToBytes(b64);
      if (!bytes.length) return { ok: false, error: 'invalid_media_data' };
      const name = String(item.name || 'remote-image.png').slice(0, 128);
      out.push({
        $typeName: 'exa.codeium_common_pb.Media',
        mimeType,
        description: name,
        payload: { case: 'inlineData', value: bytes },
        uri: '',
        thumbnail: bytes,
        durationSeconds: 0,
        mediaId: '',
        displayName: '',
        startTimeMs: zeroTs,
        endTimeMs: zeroTs,
        fps: 0,
        mediaResolution: 0,
        contentLayers: [],
        documentContentLayers: [],
        visibleCells: '',
        spreadsheetContentLayers: [],
      });
    }
    return { ok: true, media: out };
  }

  function parseEffortSuffix(rawLabel) {
    const normalized = String(rawLabel || '')
      .replace(/编排器\s*\(([^)]+)\)/g, 'Orchestrator ($1)')
      .replace(/\s*\(Extra High\)\s*$/i, ' (XHigh)');
    const m = normalized.match(EFFORT_LABEL_RE);
    const baseName = m ? m[1].trim() : normalized.trim();
    const effort = m ? EFFORT_NORM[m[2].toLowerCase()] || m[2] : null;
    return { baseName, effort };
  }

  function formatDisplayEffort(effort) {
    return (effort && EFFORT_DISPLAY[effort]) || effort || '';
  }

  function readReduxModelOptions(st) {
    const cfgData = st?.userStatus?.cascadeModelConfigData || null;
    const rawCfgs = Array.isArray(cfgData?.clientModelConfigs) ? cfgData.clientModelConfigs : [];
    const modelOptions = [];
    for (const c of rawCfgs) {
      if (!c || !c.label) continue;
      const val = c.modelOrAlias?.choice ? c.modelOrAlias.choice.value : c.value;
      if (val === undefined || val === null) continue;
      modelOptions.push({
        label: String(c.label),
        value: val,
        modelId: String(c.modelId || ''),
        disabled: Boolean(c.disabled),
        customLabel: '',
      });
    }
    const rawCustom = Array.isArray(st?.customModels?.models)
      ? st.customModels.models
      : Array.isArray(st?.customModels)
        ? st.customModels
        : [];
    const customModels = [];
    for (const c of rawCustom) {
      if (!c || !c.label || c.value === undefined || c.value === null) continue;
      customModels.push({
        label: String(c.label),
        value: c.value,
        modelId: String(c.modelId || ''),
        disabled: Boolean(c.disabled),
        customLabel: String(c.label),
      });
    }
    return { modelOptions, customModels };
  }

  function normalizeModelCatalog(store, cid = '') {
    const st = safeCall(() => store.getState()) || {};
    const api = safeCall(() => modelApi?.discoverModelSelectorApi?.()) || null;
    const familiesOut = [];
    const ms = st.modelSelection || {};
    const convPick = (cid && ms.byConversation && ms.byConversation[cid]) || ms.default || null;
    const convOrch =
      cid && ms.orchestratorByConversation && ms.orchestratorByConversation[cid] !== undefined
        ? ms.orchestratorByConversation[cid]
        : ms.orchestratorByConversation?.[''];

    let fallbackSelected = null;

    if (api && typeof modelApi?.buildModelCatalog === 'function') {
      const cat = safeCall(() => modelApi.buildModelCatalog(api));
      if (cat && (Array.isArray(cat.primaryFamilies) || Array.isArray(cat.moreFamilies))) {
        const pushFamily = (fam, group) => {
          if (!fam || !Array.isArray(fam.variants) || !fam.variants.length) return;
          const variants = [];
          for (const v of fam.variants) {
            const opt = v?.opt;
            if (!opt || opt.disabled || opt.value === undefined || opt.value === null) continue;
            const plannerOpt = v.plannerOpt || null;
            const effort = v.effort || null;
            variants.push({
              effort,
              displayEffort: formatDisplayEffort(effort),
              label: String(plannerOpt?.label || opt.label || fam.baseName),
              value: toJsonSafe(opt.value),
              customLabel: String(opt.customLabel || ''),
              plannerValue: plannerOpt && plannerOpt.value !== undefined ? toJsonSafe(plannerOpt.value) : null,
              modelId: String(plannerOpt?.modelId || opt.modelId || ''),
            });
          }
          if (variants.length > 0) {
            familiesOut.push({
              baseName: String(fam.baseName || variants[0].label),
              group,
              isOrchestrator: Boolean(fam.isOrchestratorFamily || group === 'orch'),
              variants,
            });
          }
        };
        for (const f of cat.primaryFamilies || []) pushFamily(f, 'primary');
        for (const entry of cat.moreFamilies || []) {
          pushFamily(entry?.fam || entry, entry?.group === 'orch' ? 'orch' : 'other');
        }
        if (cat.activeFamily && cat.activeVariant?.opt) {
          const ao = cat.activeVariant.opt;
          const ap = cat.activeVariant.plannerOpt || null;
          const eff = cat.activeVariant.effort || null;
          fallbackSelected = {
            label: String(ap?.label || ao.label || cat.activeFamily.baseName),
            baseName: String(cat.activeFamily.baseName || ''),
            effort: eff,
            displayEffort: formatDisplayEffort(eff),
            value: toJsonSafe(ao.value),
            customLabel: String(ao.customLabel || ''),
            modelId: String(ap?.modelId || ao.modelId || ''),
            isOrchestrator: Boolean(cat.activeFamily.isOrchestratorFamily),
            plannerValue: ap && ap.value !== undefined ? toJsonSafe(ap.value) : null,
            plannerLabel: ap?.label ? String(ap.label) : '',
          };
        }
      }
    }

    if (familiesOut.length === 0) {
      const { modelOptions, customModels } = readReduxModelOptions(st);
      const merged = modelOptions.concat(customModels).filter((o) => !o.disabled);
      const famMap = new Map();
      for (const opt of merged) {
        const parsed = parseEffortSuffix(opt.label);
        const base = parsed.baseName || opt.label;
        if (!famMap.has(base)) {
          famMap.set(base, {
            baseName: base,
            group: /orchestrator|编排器/i.test(base) ? 'orch' : 'primary',
            isOrchestrator: /orchestrator|编排器/i.test(base),
            variants: [],
          });
        }
        famMap.get(base).variants.push({
          effort: parsed.effort,
          displayEffort: formatDisplayEffort(parsed.effort),
          label: opt.label,
          value: toJsonSafe(opt.value),
          customLabel: opt.customLabel || '',
          plannerValue: null,
          modelId: opt.modelId || '',
        });
      }
      for (const fam of famMap.values()) familiesOut.push(fam);
    }

    let selected = null;
    const convModelVal = convPick && typeof convPick === 'object' ? convPick.model : convPick;
    const convCustomLbl = convPick && typeof convPick === 'object' ? String(convPick.customLabel || '') : '';
    const convOrchVal = convOrch && typeof convOrch === 'object' ? convOrch.model : convOrch;

    if (convModelVal !== undefined && convModelVal !== null) {
      for (const fam of familiesOut) {
        for (const v of fam.variants) {
          const valMatch = v.value === convModelVal || String(v.value) === String(convModelVal);
          const customOk = !convCustomLbl || v.customLabel === convCustomLbl || v.label === convCustomLbl;
          const plannerOk =
            !fam.isOrchestrator ||
            convOrchVal === undefined ||
            convOrchVal === null ||
            convOrchVal === 0 ||
            v.plannerValue === convOrchVal ||
            String(v.plannerValue) === String(convOrchVal);
          if (valMatch && customOk && plannerOk) {
            selected = {
              label: v.label,
              baseName: fam.baseName,
              effort: v.effort,
              displayEffort: v.displayEffort,
              value: v.value,
              customLabel: v.customLabel,
              modelId: v.modelId,
              isOrchestrator: fam.isOrchestrator,
              plannerValue: v.plannerValue,
              plannerLabel: fam.isOrchestrator ? v.label : '',
            };
            break;
          }
        }
        if (selected) break;
      }
    }

    if (!selected) {
      if (fallbackSelected) {
        selected = fallbackSelected;
      } else if (familiesOut.length > 0 && familiesOut[0].variants.length > 0) {
        const f0 = familiesOut[0];
        const v0 = f0.variants[0];
        selected = {
          label: v0.label,
          baseName: f0.baseName,
          effort: v0.effort,
          displayEffort: v0.displayEffort,
          value: v0.value,
          customLabel: v0.customLabel,
          modelId: v0.modelId,
          isOrchestrator: f0.isOrchestrator,
          plannerValue: v0.plannerValue,
          plannerLabel: f0.isOrchestrator ? v0.label : '',
        };
      }
    }

    return {
      ok: true,
      cascadeId: cid || '',
      selected,
      families: familiesOut,
    };
  }

  function listModels(payload = {}) {
    const rawCid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
    if (rawCid && !UUID_RE.test(rawCid)) {
      return { ok: false, error: 'invalid_cascade_id' };
    }
    let { store } = locateHandles();
    if (!store) ({ store } = locateHandles(true));
    if (!store) return { ok: false, error: 'store_unavailable' };
    const catalog = normalizeModelCatalog(store, rawCid);
    return {
      ...catalog,
      slashCommands: sanitizeSlashCommands(discoverSlashCommandItems()),
    };
  }

  function selectModel(payload = {}) {
    const rawCid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
    if (rawCid && !UUID_RE.test(rawCid)) {
      return { ok: false, error: 'invalid_cascade_id' };
    }
    const targetModel = payload?.model;
    const validTarget =
      (typeof targetModel === 'number' && Number.isFinite(targetModel)) ||
      (typeof targetModel === 'string' && targetModel.trim().length > 0 && targetModel.trim().length <= 128);
    if (!validTarget) return { ok: false, error: 'invalid_model' };

    const customLabel = typeof payload?.customLabel === 'string' ? payload.customLabel.trim().slice(0, 128) : '';
    const hasPlanner =
      payload?.plannerModel !== undefined && payload?.plannerModel !== null && payload?.plannerModel !== '';
    const plannerTarget = payload?.plannerModel;
    if (hasPlanner) {
      const validPlanner =
        (typeof plannerTarget === 'number' && Number.isFinite(plannerTarget)) ||
        (typeof plannerTarget === 'string' && plannerTarget.trim().length > 0 && plannerTarget.trim().length <= 128);
      if (!validPlanner) return { ok: false, error: 'invalid_planner_model' };
    }

    let { store } = locateHandles();
    if (!store) ({ store } = locateHandles(true));
    if (!store || typeof store.dispatch !== 'function') return { ok: false, error: 'store_unavailable' };

    const st = safeCall(() => store.getState()) || {};
    const api = safeCall(() => modelApi?.discoverModelSelectorApi?.()) || null;
    const reduxOpts = readReduxModelOptions(st);
    const allOpts = []
      .concat(Array.isArray(api?.modelOptions) ? api.modelOptions : reduxOpts.modelOptions)
      .concat(Array.isArray(api?.customModels) ? api.customModels : reduxOpts.customModels)
      .filter((o) => o && !o.disabled);

    const findMatch = (val, prefCustom) => {
      if (prefCustom) {
        const byCustom = allOpts.find(
          (o) =>
            (o.value === val || String(o.value) === String(val) || o.modelId === val) &&
            (o.customLabel === prefCustom || o.label === prefCustom)
        );
        if (byCustom) return byCustom;
      }
      return allOpts.find((o) => o.value === val || String(o.value) === String(val) || o.modelId === val) || null;
    };

    const matched = findMatch(targetModel, customLabel);
    if (!matched) return { ok: false, error: 'model_not_found' };

    let matchedPlanner = null;
    if (hasPlanner) {
      const plannerPool = Array.isArray(api?.orchestratorPlanners)
        ? api.orchestratorPlanners.filter((o) => o && !o.disabled)
        : allOpts;
      matchedPlanner =
        plannerPool.find(
          (o) => o.value === plannerTarget || String(o.value) === String(plannerTarget) || o.modelId === plannerTarget
        ) || null;
      if (!matchedPlanner) return { ok: false, error: 'model_not_found' };
    }

    const selCid =
      typeof document !== 'undefined'
        ? document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]')?.getAttribute('data-cascade-id')
        : '';
    const isActivePane =
      !rawCid ||
      (typeof window !== 'undefined' &&
        ((typeof window.location?.pathname === 'string' && window.location.pathname.includes(rawCid)) ||
          window.__ag_watched_cascade_id === rawCid ||
          selCid === rawCid));

    let appliedViaNative = false;
    if (isActivePane && api && typeof modelApi?.applyModelSelectionOption === 'function') {
      try {
        modelApi.applyModelSelectionOption(api, matched, matchedPlanner);
        appliedViaNative = true;
      } catch {}
    }

    if (!appliedViaNative || api?.isReduxFallback || rawCid) {
      if (matchedPlanner) {
        store.dispatch({
          type: 'modelSelection/orchestratorModelPicked',
          payload: {
            ...(rawCid ? { cascadeId: rawCid, conversationId: rawCid } : {}),
            model: matchedPlanner.value,
          },
        });
      }
      store.dispatch({
        type: 'modelSelection/modelPicked',
        payload: {
          ...(rawCid ? { cascadeId: rawCid, conversationId: rawCid } : {}),
          model: matched.value,
          ...(matched.customLabel || customLabel ? { customLabel: matched.customLabel || customLabel } : {}),
        },
      });
    }

    const catalog = normalizeModelCatalog(store, rawCid);
    return {
      ok: true,
      cascadeId: rawCid || '',
      selected: catalog.selected,
      catalog,
    };
  }

  function discoverSlashCommandItems() {
    if (typeof document !== 'undefined') {
      const boxes = document.querySelectorAll(
        '[id="antigravity.agentSidePanelInputBox"], [data-testid="agent-input-box"]'
      );
      for (const box of boxes) {
        const fk = Object.keys(box).find((k) => k.startsWith('__reactFiber$'));
        let f = fk ? box[fk] : null;
        for (let i = 0; i < 45 && f; i++, f = f.return) {
          const pr = f.memoizedProps;
          if (pr && typeof pr.handleSubmit === 'function' && Array.isArray(pr.slashCommandItems)) {
            const valid = pr.slashCommandItems.filter((x) => x && x.info && typeof x.info === 'object');
            if (valid.length > 0) {
              cachedSlashCommands = valid;
              return valid;
            }
          }
        }
      }
    }
    return cachedSlashCommands;
  }

  async function sendMessage(payload) {
    const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
    if (!UUID_RE.test(cid)) return { ok: false, error: 'invalid_cascade_id' };
    if (typeof payload?.text !== 'string') return { ok: false, error: 'invalid_text' };
    const text = payload.text;
    const mediaRes = buildTapMediaObjects(payload?.media);
    if (!mediaRes.ok) return { ok: false, error: mediaRes.error };
    const mediaObjs = mediaRes.media;
    if ((!text.trim() && mediaObjs.length === 0) || text.length > MAX_FIELD_CHARS) {
      return { ok: false, error: 'invalid_text_length' };
    }

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
      const built = buildMessageItemsWithSlashCommands(text, discoverSlashCommandItems());
      await lsClient.sendUserCascadeMessage({
        cascadeId: cid,
        items: built.items,
        ...(mediaObjs.length ? { media: mediaObjs } : {}),
      });
      if (built.matchedSlash === 'compact' && isConversationActiveInDom(cid)) {
        safeCall(() => window.__agClaudeUxBridge?.syncCompactVisualState?.(true));
      }
      return {
        ok: true,
        cascadeId: cid,
        globalPreset: globalPreset ?? null,
        mediaCount: mediaObjs.length,
        ...(built.matchedSlash ? { slashCommand: built.matchedSlash } : {}),
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err || 'send_failed') };
    }
  }

  async function approveInteraction(payload) {
    const cid = typeof payload?.cascadeId === 'string' ? payload.cascadeId.trim() : '';
    if (!UUID_RE.test(cid)) return { ok: false, error: 'invalid_cascade_id' };
    const decision = payload?.decision;
    const isPermDecision = decision === 'allow_once' || decision === 'deny';
    const isAskDecision = decision === 'answer_question' || decision === 'cancel_question';
    if (!isPermDecision && !isAskDecision) return { ok: false, error: 'invalid_decision' };
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

    const isAskStep = matched.interactionCase === 'askQuestion';
    if (isAskStep) {
      if (!isAskDecision) {
        return { ok: false, error: 'invalid_decision' };
      }
      const questions = Array.isArray(matched.questions) ? matched.questions : [];
      const cancelled = decision === 'cancel_question';
      const rawAnswers = Array.isArray(payload?.answers) ? payload.answers : [];
      const responses = questions.map((q, idx) => {
        if (cancelled) {
          return {
            question: q.question,
            options: q.options,
            isMultiSelect: Boolean(q.isMultiSelect),
            selectedOptionIds: [],
            writeInResponse: '',
            skipped: true,
          };
        }
        const ans = rawAnswers[idx] && typeof rawAnswers[idx] === 'object' ? rawAnswers[idx] : {};
        const validIds = new Set((q.options || []).map((o) => String(o.id)));
        const selIds = Array.isArray(ans.selectedOptionIds)
          ? ans.selectedOptionIds.map((x) => String(x)).filter((id) => (validIds.size > 0 ? validIds.has(id) : Boolean(id)))
          : [];
        const normalizedSel = q.isMultiSelect ? Array.from(new Set(selIds)) : selIds.slice(0, 1);
        const rawWriteIn = typeof ans.writeInResponse === 'string' ? ans.writeInResponse.trim().slice(0, 2000) : '';
        const writeIn = !q.isMultiSelect && normalizedSel.length > 0 ? '' : rawWriteIn;
        const skipped = Boolean(ans.skipped) || (normalizedSel.length === 0 && !writeIn);
        return {
          question: q.question,
          options: q.options,
          isMultiSelect: Boolean(q.isMultiSelect),
          selectedOptionIds: skipped ? [] : normalizedSel,
          writeInResponse: skipped ? '' : writeIn,
          skipped,
        };
      });
      try {
        await lsClient.handleCascadeUserInteraction(cid, {
          trajectoryId: matched.trajectoryId || '',
          stepIndex: matched.stepIndex,
          interaction: {
            case: 'askQuestion',
            value: {
              responses,
              cancelled,
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

    if (!isPermDecision) {
      return { ok: false, error: 'invalid_decision' };
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

    let { store, lsClient } = locateHandles();
    if (!lsClient || !store) {
      ({ store, lsClient } = locateHandles(true));
    }

    const st = store ? safeCall(() => store.getState()) : null;
    const sum = st?.trajectorySummaries?.summaries?.[cid] || null;
    if (sum) {
      const sumStatus = normalizeSummaryStatus(sum);
      const hasWaiting = Array.isArray(sum.waitingSteps) && sum.waitingSteps.length > 0;
      if (sumStatus === 'RUNNING' || sumStatus === 'WAITING' || hasWaiting) {
        return { ok: false, error: 'compact_rejected_or_busy' };
      }
    }
    const streamEntry = streams.get(cid);
    if (streamEntry && streamEntry.lastStatus === 'RUNNING') {
      return { ok: false, error: 'compact_rejected_or_busy' };
    }

    // Preferred path: native SlashCommandScopeItem RPC directly to target cascadeId
    // Works for both active and background conversations without touching desktop DOM drafts.
    if (lsClient && typeof lsClient.sendUserCascadeMessage === 'function') {
      const slashList = discoverSlashCommandItems();
      const compactDef = slashList.find((x) => {
        const name = String(x?.info?.name || x?.title || '').trim().toLowerCase();
        return name === 'compact';
      });
      const compactInfo = compactDef?.info || CANONICAL_COMPACT_SLASH_INFO;
      try {
        await lsClient.sendUserCascadeMessage({
          cascadeId: cid,
          items: buildSlashCommandItems(compactInfo),
        });
        if (isConversationActiveInDom(cid)) {
          safeCall(() => window.__agClaudeUxBridge?.syncCompactVisualState?.(true));
        }
        return { ok: true, cascadeId: cid, mode: 'rpc' };
      } catch (err) {
        return { ok: false, error: String(err?.message || err || 'compact_failed') };
      }
    }

    // Legacy fallback when lsClient RPC is unavailable: keep requireEmptyDraft: true to protect desktop drafts.
    const triggerFn =
      typeof window !== 'undefined' ? window.__agClaudeUxBridge?.triggerConversationCompact : null;
    if (typeof triggerFn !== 'function') {
      return { ok: false, error: 'compact_unavailable' };
    }
    if (!isConversationActiveInDom(cid)) {
      return { ok: false, error: 'compact_requires_active_pane' };
    }
    try {
      const ok = await triggerFn({ expectedCid: cid, requireEmptyDraft: true });
      if (!ok) {
        return { ok: false, error: 'compact_rejected_or_busy' };
      }
      return { ok: true, cascadeId: cid, mode: 'dom' };
    } catch (err) {
      return { ok: false, error: String(err?.message || err || 'compact_failed') };
    }
  }

  async function createConversation(payload) {
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!text.trim() || text.length > MAX_FIELD_CHARS) {
      return { ok: false, error: 'invalid_text_length' };
    }
    const projectId = typeof payload?.projectId === 'string' ? payload.projectId.trim() : '';
    if (projectId && !/^[A-Za-z0-9._:-]{1,128}$/.test(projectId)) {
      return { ok: false, error: 'invalid_project_id' };
    }

    let { store, prefStore } = locateHandles();
    if (!store) {
      ({ store, prefStore } = locateHandles(true));
    }
    const st = store ? safeCall(() => store.getState()) : null;
    const { globalPreset } = readPresetInfo(st, prefStore);
    if (isTurboLikePreset(globalPreset) && payload?.turboWriteConfirmed !== true) {
      return { ok: false, error: 'turbo_write_confirmation_required', globalPreset: globalPreset ?? null };
    }

    const starter =
      typeof rt?.hooks?.startNewChatInProjectById === 'function'
        ? rt.hooks.startNewChatInProjectById
        : typeof window !== 'undefined' && typeof window.__agClaudeUxBridge?.startNewChatInProjectById === 'function'
          ? window.__agClaudeUxBridge.startNewChatInProjectById
          : null;
    if (!starter) {
      return { ok: false, error: 'create_not_supported' };
    }

    const beforeIds = new Set(Object.keys(st?.trajectorySummaries?.summaries || {}));
    try {
      const started = starter(projectId || '', text);
      if (started === false) {
        return { ok: false, error: 'project_not_found' };
      }
    } catch (err) {
      return { ok: false, error: String(err?.message || err || 'create_failed') };
    }

    let createdCid = '';
    if (store && typeof store.getState === 'function') {
      const deadline = Date.now() + 3200;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 140));
        const cur = safeCall(() => store.getState()?.trajectorySummaries?.summaries) || {};
        for (const id of Object.keys(cur)) {
          if (UUID_RE.test(id) && !beforeIds.has(id)) {
            createdCid = id;
            break;
          }
        }
        if (createdCid) break;
      }
    }

    return {
      ok: true,
      cascadeId: createdCid,
      pending: !createdCid,
      projectId,
      globalPreset: globalPreset ?? null,
    };
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
    if (method === 'convo.create') return createConversation(payload);
    if (method === 'convo.send') return sendMessage(payload);
    if (method === 'convo.approve') return approveInteraction(payload);
    if (method === 'convo.cancel') return cancelConversation(payload);
    if (method === 'convo.compact') return compactConversation(payload);
    if (method === 'models.list') return listModels(payload);
    if (method === 'models.select') return selectModel(payload);
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
    cachedSlashCommands = [];
    if (typeof window !== 'undefined' && window.__agRemoteTap === api) {
      window.__agRemoteTap = null;
    }
  }

  return { dispose };
}
