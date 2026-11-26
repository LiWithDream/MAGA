/**
 * Interrupted-Task Resume Capsule (#agy-resume-pill) & Subtle Timeline Divider:
 * 1. Detects when the active main conversation terminated abnormally mid-task via daemon
 *    RPC `getResumeState` and surfaces a calm `[ ▶ Resume × ]` capsule on Row 1 left.
 * 2. Suppresses false positives during intentional waiting states (subagents, timers,
 *    swarm_wait, user approval) via live DOM status, subagent metrics, and React store.
 * 3. Eliminates missed detections via busy->idle settle retries, pendingForce queueing,
 *    store subscription, metrics change detection, and visibilitychange recovery.
 * 4. Silent submit & Style B timeline divider (`─── ▸ Resumed ───`).
 */
import { isVisibleFast, markOwn, setAttr, setLeafText } from '../core/dom.mjs';
import { getActiveRouteCid, isComposerRunning, isZhUi, L } from '../core/env.mjs';

const ABNORMAL_TERM_REASONS = new Set([1, 2, 3, 6, 11]);

export function createResumeBannerRuntime({ studioPrefs } = {}) {
  const PILL_ID = 'agy-resume-pill';
  const DISMISS_STORAGE_KEY = 'agy_studio_resume_dismissed_v1';
  const MAX_DISMISSED = 120;
  const RESUME_SENTINEL = '\u2063\u200B\u2063';
  const LEGACY_RESUME_RE = /^(?:\u2063\u200B\u2063)?(?:请从上次中断处继续完成剩余任务|Please resume from where the task was interrupted)/;

  let disposed = false;
  let prevCid = '';
  let prevBusy = null;
  let lastMetricsSig = '';
  let lastLiveSig = '';
  let lastSubStoreSig = '';
  let settleTimer = 0;
  let kernelMarkDirty = null;
  let subscribedStore = null;
  let unsubStore = null;
  let visibilityBound = false;
  let reqSeq = 0;
  let stateCache = { cid: '', ts: 0, reqGen: 0, inFlight: false, pendingForce: false, pendingOpts: null, data: null };
  const scannedSteps = new WeakSet();
  const fallbackTimers = new Set();

  const isEnabled = () => studioPrefs?.get?.()?.resumeBannerEnabled !== false;
  const offStudioPrefs = studioPrefs?.subscribe?.(() => {
    if (disposed) return;
    if (!isEnabled()) removePill();
    else render();
  });

  function trackTimer(fn, ms) {
    if (disposed) return 0;
    const id = setTimeout(() => {
      fallbackTimers.delete(id);
      if (!disposed) fn();
    }, ms);
    fallbackTimers.add(id);
    return id;
  }

  const dismissedSet = new Set();
  try {
    const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(DISMISS_STORAGE_KEY) : null;
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const k of arr) if (typeof k === 'string') dismissedSet.add(k);
      }
    }
  } catch {}

  function persistDismissed() {
    try {
      if (typeof localStorage !== 'object' || !localStorage) return;
      const arr = Array.from(dismissedSet);
      const trimmed = arr.length > MAX_DISMISSED ? arr.slice(-MAX_DISMISSED) : arr;
      localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {}
  }

  function getMainBox() {
    return (
      document.getElementById('antigravity.agentSidePanelInputBox') ||
      document.querySelector('[data-testid="conversation-view"] [data-testid="agent-input-box"]')
    );
  }

  function isEditorEmpty(box = getMainBox()) {
    const editor = box?.querySelector('[data-lexical-editor="true"]');
    if (!editor) return true;
    const text = (editor.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    return text.length === 0;
  }

  function findLiveStore() {
    if (typeof document === 'undefined') return null;
    const rootEl = document.getElementById('root');
    const anchors = [
      document.querySelector?.('.bg-sidebar'),
      rootEl?.firstElementChild || rootEl?.children?.[0],
      document.body,
    ].filter(Boolean);
    for (const anchor of anchors) {
      const fk = Object.keys(anchor).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$')
      );
      let f = fk ? anchor[fk] : null;
      for (let i = 0; i < 40 && f; i++, f = f.return) {
        const mp = f.memoizedProps;
        const candStore = mp?.sidebarStore || mp?.store || mp?.value?.store;
        if (candStore && typeof candStore.getState === 'function') {
          try {
            const st = candStore.getState();
            if (st && st.trajectorySummaries && typeof st.trajectorySummaries.summaries === 'object') {
              return candStore;
            }
          } catch {}
        }
      }
    }
    return null;
  }

  function readSummaryFromStore(store, cid) {
    if (!store || !cid) return null;
    try {
      const st = store.getState?.();
      const sum = st?.trajectorySummaries?.summaries?.[cid];
      if (!sum || typeof sum !== 'object') return null;
      const status = Number(sum.status ?? 0);
      const notFullyIdle = Boolean(sum.notFullyIdle);
      const killed = Boolean(sum.killed);
      const hasRunningSubagents = Boolean(sum.hasRunningSubagents);
      const hasActiveChildren = Boolean(sum.hasActiveChildren);
      const backgroundTaskCount = Number(sum.backgroundTaskCount || 0);
      const waitingCount = Array.isArray(sum.waitingSteps) ? sum.waitingSteps.length : 0;
      const interrupted = Boolean(sum.interrupted);
      const termReason = Number(sum.latestExecutorTerminationReason ?? 0);
      const stepCount = Number(sum.stepCount ?? 0);
      const isBusy = Boolean(
        !killed &&
          (status === 2 ||
            status === 3 ||
            status === 4 ||
            notFullyIdle ||
            hasRunningSubagents ||
            hasActiveChildren ||
            backgroundTaskCount > 0 ||
            waitingCount > 0)
      );
      const isFullyIdle = Boolean(
        !killed &&
          status === 1 &&
          !notFullyIdle &&
          !hasRunningSubagents &&
          !hasActiveChildren &&
          backgroundTaskCount === 0 &&
          waitingCount === 0
      );
      const sig = `${status}|${notFullyIdle ? 1 : 0}|${killed ? 1 : 0}|${hasRunningSubagents ? 1 : 0}|${hasActiveChildren ? 1 : 0}|${backgroundTaskCount}|${waitingCount}|${interrupted ? 1 : 0}|${termReason}|${stepCount}`;
      return {
        status,
        notFullyIdle,
        killed,
        hasRunningSubagents,
        hasActiveChildren,
        backgroundTaskCount,
        waitingCount,
        interrupted,
        termReason,
        stepCount,
        isBusy,
        isFullyIdle,
        sig,
      };
    } catch {
      return null;
    }
  }

  function readLiveConversationSummary(cid) {
    if (!cid) return null;
    const store = subscribedStore || findLiveStore();
    return readSummaryFromStore(store, cid);
  }

  function ensureStoreSubscription() {
    if (disposed) return;
    const store = findLiveStore();
    if (!store || typeof store.subscribe !== 'function') return;
    if (subscribedStore === store && unsubStore) return;
    unsubStore?.();
    unsubStore = null;
    subscribedStore = store;
    lastSubStoreSig = '';
    try {
      const maybeUnsub = store.subscribe(() => {
        if (disposed) return;
        const curCid = getActiveRouteCid();
        if (!curCid) return;
        const summary = readSummaryFromStore(store, curCid);
        const sig = summary ? `${curCid}:${summary.sig}` : `${curCid}:none`;
        if (sig !== lastSubStoreSig) {
          lastSubStoreSig = sig;
          if (kernelMarkDirty) kernelMarkDirty(['composer'], true);
          else sync();
        }
      });
      if (typeof maybeUnsub === 'function') unsubStore = maybeUnsub;
    } catch {}
  }

  function hasVisibleIdleStatusText() {
    if (typeof document === 'undefined') return false;
    const nodes = document.querySelectorAll?.('[data-testid="conversation-view"] [data-testid="idle-status-text"]') || [];
    for (const el of nodes) {
      if (isVisibleFast(el)) return true;
    }
    return false;
  }

  function hasRunningSubagentFromMetrics(cid) {
    if (typeof window === 'undefined' || !cid) return false;
    const m = window.__ag_last_metrics;
    if (!m || (m.cascadeId && m.cascadeId !== cid)) return false;
    const children = m?.stats?.children;
    if (!Array.isArray(children) || !children.length) return false;
    return children.some((c) => c && c.running && !c.killed);
  }

  function getMetricsSig(cid) {
    if (typeof window === 'undefined' || !cid) return '';
    const m = window.__ag_last_metrics;
    if (!m || (m.cascadeId && m.cascadeId !== cid)) return '';
    const st = m.stats || {};
    const mk = m.metrics || {};
    const children = Array.isArray(st.children) ? st.children : [];
    const runningCnt = children.filter((c) => c && c.running && !c.killed).length;
    if (!m.hasData && children.length === 0 && st.turns == null && st.calls == null && mk.genIdx == null) return '';
    return `${st.turns ?? ''}|${st.calls ?? ''}|${mk.genIdx ?? ''}|${children.length}|${runningCnt}`;
  }

  function getLiveBusyFlags(cid = getActiveRouteCid()) {
    const running = isComposerRunning();
    const idleStatusWaiting = hasVisibleIdleStatusText();
    const subagentRunning = hasRunningSubagentFromMetrics(cid);
    const liveSummary = cid ? readLiveConversationSummary(cid) : null;
    const busy = Boolean(running || idleStatusWaiting || subagentRunning || liveSummary?.isBusy);
    const liveIdle = Boolean(!running && !idleStatusWaiting && !subagentRunning && liveSummary?.isFullyIdle);
    return { running, idleStatusWaiting, subagentRunning, liveSummary, busy, liveIdle };
  }

  function reasonText(reason) {
    switch (reason) {
      case 'aborted':
        return L('上次任务在运行中意外中断', 'Previous task was interrupted mid-run');
      case 'mid_tool':
        return L('上次工具执行后未继续完成', 'Interrupted right after a tool step');
      case 'canceled':
        return L('上次执行被暂停', 'Previous run was stopped');
      case 'interrupted':
        return L('上次执行被中断', 'Previous run was interrupted');
      case 'error':
        return L('上次执行遇到错误而停止', 'Previous run stopped due to an error');
      case 'max_steps':
        return L('上次任务达到步数或额度上限而停止', 'Previous run stopped at step/budget limit');
      case 'unanswered':
        return L('上一条指令尚未得到回复', 'Last message did not receive a reply');
      default:
        return L('检测到未完成任务，点击继续', 'Unfinished task detected — click to resume');
    }
  }

  function dismissCurrent(cid, lastIdx) {
    if (!cid || lastIdx < 0) return;
    dismissedSet.add(`${cid}:${lastIdx}`);
    persistDismissed();
    removePill();
  }

  function removePill() {
    document.getElementById(PILL_ID)?.remove();
  }

  function findAgentHandleSubmit(box) {
    if (!box) return null;
    const fk = Object.keys(box).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fk ? box[fk] : null;
    for (let i = 0; i < 8 && fiber; i++) {
      const fn = fiber.memoizedProps?.handleSubmit;
      if (typeof fn === 'function') return fn;
      fiber = fiber.return;
    }
    return null;
  }

  function findSendButton(box) {
    const direct = box.querySelector(
      '.agy-composer-footer button[data-testid="input-send-button"]:not(:disabled), ' +
      '.agy-composer-footer button[data-testid="send-button"]:not(:disabled), ' +
      '.agy-composer-footer button[aria-label="Send"]:not(:disabled), ' +
      '.agy-composer-footer button[aria-label="Send message"]:not(:disabled), ' +
      '.agy-composer-footer button[aria-label*="发送"]:not(:disabled), ' +
      '.agy-composer-footer button[data-tooltip-id*="send"]:not([data-tooltip-id*="record"]):not([data-tooltip-id*="cancel"]):not(:disabled)'
    );
    if (direct) return direct;
    const rightBtns = Array.from(box.querySelectorAll('.agy-composer-footer > div:last-child button'));
    const last = rightBtns[rightBtns.length - 1];
    if (!last || last.disabled) return null;
    const tid = last.getAttribute('data-testid') || '';
    const aria = (last.getAttribute('aria-label') || '').toLowerCase();
    if (tid === 'input-cancel-button' || tid === 'voice-start-button' || tid === 'permissions-selector-trigger') return null;
    if (aria.includes('record') || aria.includes('voice') || aria.includes('cancel')) return null;
    return last;
  }

  function submitViaEditorFallback(box, prompt) {
    const editor = box?.querySelector('[data-lexical-editor="true"]');
    if (!box || !editor) return;
    try {
      editor.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      document.execCommand('insertText', false, prompt);
    } catch {}

    const clickSend = (attempt = 0) => {
      if (disposed || isComposerRunning(box) || isEditorEmpty(box)) return;
      const sendBtn = findSendButton(box);
      if (sendBtn) {
        sendBtn.click();
        return;
      }
      if (attempt >= 12) {
        try {
          editor.focus();
          editor.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
            })
          );
        } catch {}
        return;
      }
      trackTimer(() => clickSend(attempt + 1), 45);
    };
    trackTimer(() => clickSend(0), 60);
  }

  function triggerResume(cid, lastIdx) {
    const box = getMainBox();
    if (!box) return;

    dismissCurrent(cid, lastIdx);

    const prompt = `${RESUME_SENTINEL}Please resume from where the task was interrupted — quickly verify the current state and continue the remaining steps.`;

    const handleSubmit = findAgentHandleSubmit(box);
    if (handleSubmit) {
      try {
        const res = handleSubmit(
          [{ chunk: { case: 'text', value: prompt } }],
          [],
          () => {},
          undefined,
          undefined,
          undefined
        );
        Promise.resolve(res).catch(() => {});
        trackTimer(() => {
          if (!disposed && !isComposerRunning() && getActiveRouteCid() === cid) {
            submitViaEditorFallback(box, prompt);
          }
        }, 450);
        return;
      } catch {}
    }

    submitViaEditorFallback(box, prompt);
  }

  function readStepTags() {
    const steps = document.querySelectorAll('[data-testid="conversation-view"] [data-testid="user-input-step"]');
    const dividerLabel = L('已从中断处继续', 'Resumed');
    const updates = [];
    for (const step of steps) {
      if (scannedSteps.has(step)) continue;
      if (step.getAttribute('data-agy-resumed-step') === '1') {
        updates.push({ step, label: dividerLabel });
        continue;
      }
      const content = step.querySelector('[data-testid="user-message-content"]');
      if (!content) continue;
      const txt = content.textContent || '';
      if (txt.startsWith(RESUME_SENTINEL) || LEGACY_RESUME_RE.test(txt.trim())) {
        updates.push({ step, label: dividerLabel });
      } else if (txt.trim()) {
        scannedSteps.add(step);
      }
    }
    return updates;
  }

  function writeStepTags(updates) {
    if (!updates || !updates.length) return;
    for (const { step, label } of updates) {
      setAttr(step, 'data-agy-resumed-step', '1');
      setAttr(step, 'data-agy-resumed-label', label);
    }
  }

  function scheduleSettleRetry(cid, delayMs, nextRetryLeft, retryOnClean = false) {
    if (disposed || !cid) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      if (disposed || !isEnabled() || getActiveRouteCid() !== cid) return;
      const flags = getLiveBusyFlags(cid);
      if (!flags.busy) {
        fetchResumeState(cid, {
          force: true,
          liveIdle: flags.liveIdle,
          retryLeft: nextRetryLeft,
          retryOnClean,
        });
      }
    }, delayMs);
  }

  function fetchResumeState(cid, { force = false, liveIdle = false, retryLeft = 0, retryOnClean = false } = {}) {
    if (!cid || disposed || typeof window.__agProjectCall !== 'function') return;
    const now = Date.now();
    if (!force && stateCache.cid === cid && (stateCache.inFlight || now - stateCache.ts < 3500)) return;
    if (stateCache.inFlight && stateCache.cid === cid) {
      if (force) {
        stateCache.pendingForce = true;
        stateCache.pendingOpts = {
          liveIdle: Boolean(liveIdle || stateCache.pendingOpts?.liveIdle),
          retryLeft: Math.max(retryLeft, stateCache.pendingOpts?.retryLeft || 0),
          retryOnClean: Boolean(retryOnClean || stateCache.pendingOpts?.retryOnClean),
        };
      }
      return;
    }

    const myGen = ++reqSeq;
    stateCache.cid = cid;
    stateCache.reqGen = myGen;
    stateCache.inFlight = true;
    stateCache.pendingForce = false;
    stateCache.pendingOpts = null;

    let resolvedRes = null;
    const rpcPayload = liveIdle ? { cascadeId: cid, liveIdle: true } : { cascadeId: cid };
    Promise.resolve(window.__agProjectCall('getResumeState', rpcPayload, 3000))
      .then((res) => {
        if (disposed || stateCache.cid !== cid || stateCache.reqGen !== myGen) return;
        resolvedRes = res;
        if (res && res.ok && !getLiveBusyFlags(cid).busy) {
          stateCache.data = res;
          stateCache.ts = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => {
        const sameReq = stateCache.cid === cid && stateCache.reqGen === myGen;
        if (!sameReq) return;
        const pendingForce = stateCache.pendingForce;
        const pendingOpts = stateCache.pendingOpts;
        stateCache.inFlight = false;
        stateCache.pendingForce = false;
        stateCache.pendingOpts = null;
        if (disposed) return;

        if (pendingForce && getActiveRouteCid() === cid) {
          const flags = getLiveBusyFlags(cid);
          if (!flags.busy) {
            fetchResumeState(cid, {
              force: true,
              liveIdle: Boolean(pendingOpts?.liveIdle || flags.liveIdle),
              retryLeft: pendingOpts?.retryLeft ?? retryLeft,
              retryOnClean: Boolean(pendingOpts?.retryOnClean),
            });
          }
          render();
          return;
        }

        if (retryLeft > 0 && getActiveRouteCid() === cid && isEnabled()) {
          const flags = getLiveBusyFlags(cid);
          if (!flags.busy) {
            const res = resolvedRes;
            const needRetry =
              !res ||
              !res.ok ||
              res.active === true ||
              (!res.interrupted &&
                flags.liveSummary &&
                (flags.liveSummary.stepCount > (res.lastIdx ?? -1) + 1 ||
                  flags.liveSummary.interrupted ||
                  ABNORMAL_TERM_REASONS.has(flags.liveSummary.termReason))) ||
              (!res.interrupted && retryOnClean);
            if (needRetry) {
              const delayMs = retryLeft >= 2 ? 750 : 1500;
              scheduleSettleRetry(cid, delayMs, retryLeft - 1, false);
            }
          }
        }

        render();
      });
  }

  function render(plan = null) {
    if (disposed) return;
    if (!isEnabled()) {
      removePill();
      return;
    }

    const cid = plan ? plan.cid : getActiveRouteCid();
    const box = plan ? plan.box : getMainBox();
    const footer = plan ? plan.footer : box?.querySelector('.agy-composer-footer');
    const leftGroup = plan ? plan.leftGroup : footer?.children?.[0];
    if (!cid || !footer || !leftGroup) {
      removePill();
      return;
    }

    const busy = plan ? plan.busy : getLiveBusyFlags(cid).busy;
    const editorEmpty = plan ? plan.editorEmpty : isEditorEmpty(box);
    if (busy || !editorEmpty) {
      removePill();
      return;
    }

    const data = stateCache.cid === cid ? stateCache.data : null;
    if (!data || !data.interrupted) {
      removePill();
      return;
    }

    const key = `${cid}:${data.lastIdx}`;
    if (dismissedSet.has(key)) {
      removePill();
      return;
    }

    let pill = document.getElementById(PILL_ID);
    if (!pill) {
      pill = document.createElement('div');
      pill.id = PILL_ID;
      markOwn(pill);
      pill.setAttribute('data-no-drag', '');
      pill.setAttribute('data-ag-i18n-ignore', '1');
      pill.innerHTML =
        '<button type="button" class="agy-resume-go">' +
          '<svg class="agy-resume-ico" width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 2.15a.65.65 0 0 1 .98-.56l6.1 3.85a.65.65 0 0 1 0 1.12l-6.1 3.85A.65.65 0 0 1 3 9.85V2.15Z"/></svg>' +
          '<span class="agy-resume-label"></span>' +
        '</button>' +
        '<button type="button" class="agy-resume-dismiss" aria-label="Dismiss">' +
          '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>' +
        '</button>';

      pill.querySelector('.agy-resume-go')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const curCid = getActiveRouteCid();
        const curData = stateCache.cid === curCid ? stateCache.data : null;
        if (curCid && curData) triggerResume(curCid, curData.lastIdx);
      });

      pill.querySelector('.agy-resume-dismiss')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const curCid = getActiveRouteCid();
        const curData = stateCache.cid === curCid ? stateCache.data : null;
        if (curCid && curData) dismissCurrent(curCid, curData.lastIdx);
      });
    } else {
      markOwn(pill);
    }

    if (pill.parentElement !== leftGroup) {
      leftGroup.insertBefore(pill, leftGroup.firstChild);
    }

    const label = L('继续任务', 'Resume');
    const tip = `${reasonText(data.reason)} · ${L('点击自动续跑', 'Click to resume')}`;
    const langTag = plan ? plan.langTag : (isZhUi() ? 'zh' : 'en');
    const sig = `${key}|${langTag}|${label}|${tip}`;
    if (pill.getAttribute('data-sig') !== sig) {
      setAttr(pill, 'data-sig', sig);
      const lblEl = pill.querySelector('.agy-resume-label');
      if (lblEl) setLeafText(lblEl, label);
      const goBtn = pill.querySelector('.agy-resume-go');
      if (goBtn && goBtn.title !== tip) goBtn.title = tip;
      const disBtn = pill.querySelector('.agy-resume-dismiss');
      const dismissLbl = L('忽略提示', 'Dismiss');
      if (disBtn) {
        if (disBtn.title !== dismissLbl) disBtn.title = dismissLbl;
        setAttr(disBtn, 'aria-label', dismissLbl);
      }
    }
  }

  const onVisibilityChange = () => {
    if (disposed || typeof document === 'undefined' || document.hidden) return;
    const cid = getActiveRouteCid();
    if (!cid || !isEnabled()) return;
    if (kernelMarkDirty) {
      kernelMarkDirty(['composer'], true);
    } else {
      const flags = getLiveBusyFlags(cid);
      if (!flags.busy) fetchResumeState(cid, { force: true, liveIdle: flags.liveIdle, retryLeft: 1 });
    }
  };

  function mount({ markDirty } = {}) {
    if (disposed) return;
    if (typeof markDirty === 'function') kernelMarkDirty = markDirty;
    if (!visibilityBound && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      visibilityBound = true;
    }
    ensureStoreSubscription();
  }

  function read(snapshot = null) {
    if (disposed) return null;
    const topics = snapshot?.topics;
    const shouldScanSteps =
      !topics || topics.has('all') || topics.has('stream') || topics.has('route') || topics.has('prefs');
    const stepTags = shouldScanSteps ? readStepTags() : null;
    const enabled = isEnabled();
    const cid = snapshot ? snapshot.cid : getActiveRouteCid();
    const box = snapshot ? snapshot.mainBox : getMainBox();
    const footer = box?.querySelector?.('.agy-composer-footer') || null;
    const leftGroup = footer?.children?.[0] || null;
    const running = snapshot ? snapshot.isRunning : isComposerRunning();
    const idleStatusWaiting = hasVisibleIdleStatusText();
    const subagentRunning = hasRunningSubagentFromMetrics(cid);
    const liveSummary = cid ? readLiveConversationSummary(cid) : null;
    const busy = Boolean(running || idleStatusWaiting || subagentRunning || liveSummary?.isBusy);
    const liveIdle = Boolean(!running && !idleStatusWaiting && !subagentRunning && liveSummary?.isFullyIdle);
    const metricsSig = getMetricsSig(cid);
    const liveSig = liveSummary?.sig || '';
    const editorEmpty = enabled && cid && leftGroup ? isEditorEmpty(box) : true;
    const langTag = snapshot ? snapshot.langTag : (isZhUi() ? 'zh' : 'en');
    return {
      enabled,
      cid,
      box,
      footer,
      leftGroup,
      running,
      busy,
      liveIdle,
      metricsSig,
      liveSig,
      editorEmpty,
      langTag,
      stepTags,
    };
  }

  function write(snapshot = null, planArg = undefined) {
    if (disposed) return;
    const plan = planArg !== undefined ? planArg : read(snapshot);
    if (!plan) return;
    writeStepTags(plan.stepTags);
    ensureStoreSubscription();

    if (!plan.enabled) {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
      removePill();
      return;
    }

    const { cid, busy, liveIdle, metricsSig, liveSig } = plan;
    if (cid !== prevCid) {
      prevCid = cid;
      prevBusy = null;
      lastMetricsSig = '';
      lastLiveSig = '';
      reqSeq += 1;
      stateCache = { cid: '', ts: 0, reqGen: 0, inFlight: false, pendingForce: false, pendingOpts: null, data: null };
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
      if (cid && !busy) {
        fetchResumeState(cid, { force: true, liveIdle, retryLeft: 1 });
      }
    } else if (busy) {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
      if (stateCache.cid === cid) {
        reqSeq += 1;
        stateCache.reqGen = 0;
        stateCache.inFlight = false;
        stateCache.data = null;
        stateCache.pendingForce = false;
        stateCache.pendingOpts = null;
      }
    } else if (prevBusy === true && !busy && cid) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = 0;
        if (disposed || !isEnabled() || getActiveRouteCid() !== cid) return;
        const flags = getLiveBusyFlags(cid);
        if (!flags.busy) {
          fetchResumeState(cid, {
            force: true,
            liveIdle: flags.liveIdle,
            retryLeft: 2,
            retryOnClean: true,
          });
        }
      }, 350);
    } else if (cid && !busy) {
      if (stateCache.cid !== cid) {
        fetchResumeState(cid, { force: true, liveIdle, retryLeft: 1 });
      } else if (!settleTimer && ((metricsSig && metricsSig !== lastMetricsSig) || (liveSig && liveSig !== lastLiveSig))) {
        fetchResumeState(cid, { force: true, liveIdle, retryLeft: 1 });
      }
    }

    prevBusy = busy;
    lastMetricsSig = metricsSig;
    lastLiveSig = liveSig;
    render(plan);
  }

  function sync() {
    if (disposed) return;
    write(null, read(null));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    reqSeq += 1;
    stateCache = { cid: '', ts: 0, reqGen: 0, inFlight: false, pendingForce: false, pendingOpts: null, data: null };
    offStudioPrefs?.();
    unsubStore?.();
    unsubStore = null;
    subscribedStore = null;
    if (visibilityBound && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      visibilityBound = false;
    }
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = 0;
    }
    for (const id of fallbackTimers) clearTimeout(id);
    fallbackTimers.clear();
    removePill();
    document.querySelectorAll('[data-agy-resumed-step="1"]').forEach((el) => {
      el.removeAttribute('data-agy-resumed-step');
      el.removeAttribute('data-agy-resumed-label');
    });
  }

  return {
    topics: ['composer', 'stream', 'route', 'metrics', 'subagent', 'prefs'],
    mount,
    read,
    write,
    sync,
    dispose,
  };
}
