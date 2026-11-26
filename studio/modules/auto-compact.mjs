/**
 * MAGA Auto-Compact Runtime (#agy-auto-compact-pill & Zero-Intervention Auto Execution):
 * - Single-observer MagaKernel citizen (zero standalone MutationObserver).
 * - Polls daemon `getAutoCompactStatus` after turn-settle (`prevRunning: true -> false`) or route switch.
 * - Uses live `studioPrefs.get().autoCompactMode` (never stale request snapshot):
 *   - `'auto'`: acquires 30s CAS lease (`claimAutoCompactRequest`), submits plain `/compact ` via
 *     `__agClaudeUxBridge.triggerConversationCompact({ expectedCid, requireEmptyDraft: true })`,
 *     then commits or releases lease (downgrading cleanly to `#agy-auto-compact-pill` on decline).
 *   - `'semi'`: mounts non-intrusive Row 1 pill (`⚡ 建议压缩 (XX%)`) for one-click execution.
 *   - `'off'`: immediately dismisses any queued request and stays hidden.
 */
import { markOwn, setAttr, setLeafText } from '../core/dom.mjs';
import { getActiveRouteCid, isComposerRunning, isZhUi, L } from '../core/env.mjs';

export function createAutoCompactRuntime({
  studioPrefs,
  settleDelayMs = 750,
  retryDelayMs = 1050,
  commitRetryDelayMs = 150,
} = {}) {
  const PILL_ID = 'agy-auto-compact-pill';
  const DISMISS_STORAGE_KEY = 'agy_studio_auto_compact_dismissed_v1';
  const MAX_DISMISSED = 120;

  let disposed = false;
  let prevCid = '';
  let prevRunning = null;
  let settleTimer = 0;
  let retryTimer = 0;
  let inFlightClaim = false;
  let statusCache = { cid: '', ts: 0, inFlight: false, data: null };
  const handledRequestIds = new Set();
  const resyncedIds = new Set();
  const fallbackPillIds = new Set();
  const dismissedSet = new Set();

  try {
    const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(DISMISS_STORAGE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const k of parsed) if (typeof k === 'string') dismissedSet.add(k);
      }
    }
  } catch {}

  function persistDismissed() {
    try {
      if (typeof localStorage !== 'object' || !localStorage) return;
      const arr = Array.from(dismissedSet);
      localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(arr.slice(-MAX_DISMISSED)));
    } catch {}
  }

  function getLiveMode() {
    const m = studioPrefs?.get?.()?.autoCompactMode;
    return m === 'auto' || m === 'semi' || m === 'off' ? m : 'semi';
  }

  function requestKey(cid, req) {
    if (!cid || !req) return '';
    return `${cid}:${req.id || req.ts || 0}`;
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

  function getBridgeCompactStatus(cid) {
    try {
      const fn = typeof window !== 'undefined' ? window.__agClaudeUxBridge?.detectCompactStatus : null;
      if (typeof fn === 'function') return fn(cid) || 'idle';
    } catch {}
    return 'idle';
  }

  function removePill() {
    const pill = document.getElementById(PILL_ID);
    if (pill) {
      try {
        pill.remove();
      } catch {}
    }
  }

  function clearCachedRequest(cid, reqId) {
    if (statusCache.cid === cid && statusCache.data?.request?.id === reqId) {
      statusCache.data = { ...statusCache.data, request: null };
    }
  }

  function dismissRequest(cid, req, { persist = true } = {}) {
    if (!cid || !req) return;
    if (persist) {
      const key = requestKey(cid, req);
      if (key) {
        dismissedSet.add(key);
        persistDismissed();
      }
    }
    clearCachedRequest(cid, req.id);
    removePill();
    if (typeof window?.__agProjectCall === 'function') {
      Promise.resolve(
        window.__agProjectCall('dismissAutoCompactRequest', { cascadeId: cid, requestId: req.id || '' }, 3000)
      ).catch(() => {});
    }
  }

  async function executeClaimAndCompact(cid, req) {
    if (disposed || inFlightClaim || !cid || !req || !req.id) return false;
    if (typeof window?.__agProjectCall !== 'function') return false;
    const bridgeTrigger = window.__agClaudeUxBridge?.triggerConversationCompact;
    if (typeof bridgeTrigger !== 'function') return false;

    inFlightClaim = true;
    try {
      const claimRes = await window.__agProjectCall(
        'claimAutoCompactRequest',
        { cascadeId: cid, requestId: req.id },
        3000
      );
      if (disposed || !claimRes?.matched || !claimRes?.claimToken) {
        clearCachedRequest(cid, req.id);
        if (!disposed && !resyncedIds.has(req.id) && !isComposerRunning() && getActiveRouteCid() === cid) {
          if (resyncedIds.size >= 200) resyncedIds.clear();
          resyncedIds.add(req.id);
          fetchStatus(cid, { force: true, allowRetry: false });
        }
        return false;
      }

      const token = claimRes.claimToken;
      if (getLiveMode() === 'off') {
        await window.__agProjectCall('dismissAutoCompactRequest', { cascadeId: cid, requestId: req.id }, 3000).catch(() => {});
        clearCachedRequest(cid, req.id);
        removePill();
        return false;
      }

      if (getActiveRouteCid() !== cid || isComposerRunning()) {
        await window.__agProjectCall(
          'releaseAutoCompactRequest',
          { cascadeId: cid, requestId: req.id, claimToken: token },
          3000
        ).catch(() => {});
        return false;
      }

      if (getBridgeCompactStatus(cid) !== 'idle') {
        await window.__agProjectCall('dismissAutoCompactRequest', { cascadeId: cid, requestId: req.id }, 3000).catch(() => {});
        clearCachedRequest(cid, req.id);
        removePill();
        return false;
      }

      const submitted = await Promise.resolve(
        bridgeTrigger({ expectedCid: cid, requireEmptyDraft: true })
      ).catch(() => false);

      if (submitted) {
        handledRequestIds.add(req.id);
        let commitRes = await window.__agProjectCall(
          'commitAutoCompactRequest',
          { cascadeId: cid, requestId: req.id, claimToken: token },
          3000
        ).catch(() => null);
        if (!disposed && !commitRes?.matched) {
          await new Promise((r) => setTimeout(r, commitRetryDelayMs));
          if (!disposed) {
            await window.__agProjectCall(
              'commitAutoCompactRequest',
              { cascadeId: cid, requestId: req.id, claimToken: token },
              3000
            ).catch(() => null);
          }
        }
        clearCachedRequest(cid, req.id);
        removePill();
        return true;
      }

      await window.__agProjectCall(
        'releaseAutoCompactRequest',
        { cascadeId: cid, requestId: req.id, claimToken: token },
        3000
      ).catch(() => {});
      fallbackPillIds.add(req.id);
      render();
      return false;
    } finally {
      inFlightClaim = false;
    }
  }

  function processFetchedRequest(cid, req) {
    if (disposed || !cid || !req || req.consumed || req.dismissed) return;
    const mode = getLiveMode();
    if (mode === 'off') {
      dismissRequest(cid, req, { persist: false });
      return;
    }
    if (getBridgeCompactStatus(cid) !== 'idle') {
      dismissRequest(cid, req, { persist: false });
      return;
    }
    if (dismissedSet.has(requestKey(cid, req))) return;

    if (
      mode === 'auto' &&
      !fallbackPillIds.has(req.id) &&
      !handledRequestIds.has(req.id) &&
      !inFlightClaim &&
      getActiveRouteCid() === cid &&
      !isComposerRunning() &&
      isEditorEmpty(getMainBox())
    ) {
      void executeClaimAndCompact(cid, req);
    }
  }

  function fetchStatus(cid, { force = false, allowRetry = false } = {}) {
    if (disposed || !cid || typeof window?.__agProjectCall !== 'function') return;
    const mode = getLiveMode();
    if (
      !force &&
      statusCache.cid === cid &&
      Date.now() - statusCache.ts < 8000 &&
      !statusCache.inFlight
    ) {
      return;
    }
    if (statusCache.inFlight && statusCache.cid === cid) return;

    statusCache.cid = cid;
    statusCache.inFlight = true;
    Promise.resolve(window.__agProjectCall('getAutoCompactStatus', { cascadeId: cid }, 3000))
      .then((res) => {
        if (statusCache.cid === cid) statusCache.inFlight = false;
        if (disposed || statusCache.cid !== cid) return;
        if (res && res.ok) {
          statusCache.data = res;
          statusCache.ts = Date.now();
          if (res.request) {
            processFetchedRequest(cid, res.request);
          } else if (allowRetry && retryDelayMs > 0 && mode !== 'off' && !retryTimer) {
            retryTimer = setTimeout(() => {
              retryTimer = 0;
              if (!disposed && getLiveMode() !== 'off' && !isComposerRunning() && getActiveRouteCid() === cid) {
                fetchStatus(cid, { force: true, allowRetry: false });
              }
            }, retryDelayMs);
          }
        }
      })
      .catch(() => {
        if (statusCache.cid === cid) statusCache.inFlight = false;
      })
      .finally(() => {
        if (statusCache.cid === cid) statusCache.inFlight = false;
        if (!disposed) render();
      });
  }

  function formatTooltip(req) {
    const pct = Number(req?.ctxPct || 0);
    const kind = String(req?.kind || '');
    if (kind === 'long_timer') {
      const min = Math.max(1, Math.round(Number(req?.waitSec || 0) / 60));
      return L(
        `检测到 ${min}m 长定时器且上下文已达 ${pct}%，点击趁热执行 /compact`,
        `Active ${min}m timer at ${pct}% context · click to run /compact while cache is warm`
      );
    }
    if (kind === 'model_request') {
      return L(
        `模型建议压缩上下文 (${pct}%)：${req?.reason || ''}`,
        `Agent requested /compact (${pct}%): ${req?.reason || ''}`
      );
    }
    return L(
      `上下文已达 ${pct}%，点击立即执行 /compact`,
      `Context reached ${pct}% · click to run /compact`
    );
  }

  function render(plan = null) {
    if (disposed) return;
    const mode = getLiveMode();
    if (mode === 'off') {
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

    const running = plan ? plan.running : isComposerRunning();
    const editorEmpty = plan ? plan.editorEmpty : isEditorEmpty(box);
    if (running || !editorEmpty) {
      removePill();
      return;
    }

    const req = statusCache.cid === cid ? statusCache.data?.request : null;
    if (!req || req.consumed || req.dismissed) {
      removePill();
      return;
    }

    if (getBridgeCompactStatus(cid) !== 'idle') {
      dismissRequest(cid, req, { persist: false });
      return;
    }

    const key = requestKey(cid, req);
    if (dismissedSet.has(key)) {
      removePill();
      return;
    }

    if (mode === 'auto' && !fallbackPillIds.has(req.id)) {
      if (!handledRequestIds.has(req.id) && !inFlightClaim) {
        void executeClaimAndCompact(cid, req);
      }
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
        '<button type="button" class="agy-ac-go">' +
          '<span class="agy-ac-bolt" aria-hidden="true">⚡</span>' +
          '<span class="agy-ac-label"></span>' +
        '</button>' +
        '<button type="button" class="agy-ac-dismiss" aria-label="Dismiss">' +
          '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>' +
        '</button>';

      pill.querySelector('.agy-ac-go')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const curCid = getActiveRouteCid();
        const curReq = statusCache.cid === curCid ? statusCache.data?.request : null;
        if (curCid && curReq && !inFlightClaim) {
          void executeClaimAndCompact(curCid, curReq);
        }
      });

      pill.querySelector('.agy-ac-dismiss')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const curCid = getActiveRouteCid();
        const curReq = statusCache.cid === curCid ? statusCache.data?.request : null;
        if (curCid && curReq) dismissRequest(curCid, curReq, { persist: true });
      });
    } else {
      markOwn(pill);
    }

    if (pill.parentElement !== leftGroup) {
      const opusEl = document.getElementById('agy-opus-gate-pill');
      const resumeEl = document.getElementById('agy-resume-pill');
      const anchor = opusEl?.parentElement === leftGroup ? opusEl : resumeEl?.parentElement === leftGroup ? resumeEl : null;
      if (anchor) {
        anchor.insertAdjacentElement('afterend', pill);
      } else {
        leftGroup.insertBefore(pill, leftGroup.firstChild);
      }
    }

    const pct = Number(req.ctxPct || 0);
    const label = pct > 0 ? L(`建议压缩 (${pct}%)`, `Compact (${pct}%)`) : L('建议压缩', 'Compact');
    const langTag = plan ? plan.langTag : isZhUi() ? 'zh' : 'en';
    const tip = formatTooltip(req);
    const sig = `${key}|${langTag}|${label}`;
    if (pill.getAttribute('data-sig') !== sig) {
      setAttr(pill, 'data-sig', sig);
      const lblEl = pill.querySelector('.agy-ac-label');
      if (lblEl) setLeafText(lblEl, label);
      const goBtn = pill.querySelector('.agy-ac-go');
      if (goBtn && goBtn.title !== tip) goBtn.title = tip;
      const disBtn = pill.querySelector('.agy-ac-dismiss');
      const dismissLbl = L('忽略提示', 'Dismiss');
      if (disBtn) {
        if (disBtn.title !== dismissLbl) disBtn.title = dismissLbl;
        setAttr(disBtn, 'aria-label', dismissLbl);
      }
    }
  }

  const offStudioPrefs = studioPrefs?.subscribe?.(() => {
    if (disposed) return;
    const mode = getLiveMode();
    const curCid = getActiveRouteCid();
    const curReq = statusCache.cid === curCid ? statusCache.data?.request : null;
    if (mode === 'off') {
      if (curCid && curReq) dismissRequest(curCid, curReq, { persist: false });
      else removePill();
      return;
    }
    if (curCid && curReq) processFetchedRequest(curCid, curReq);
    render();
  });

  function read(snapshot = null) {
    if (disposed) return null;
    const mode = getLiveMode();
    const enabled = mode !== 'off';
    const cid = snapshot ? snapshot.cid : getActiveRouteCid();
    const box = snapshot ? snapshot.mainBox : getMainBox();
    const footer = box?.querySelector?.('.agy-composer-footer') || null;
    const leftGroup = footer?.children?.[0] || null;
    const running = snapshot ? snapshot.isRunning : isComposerRunning();
    const editorEmpty = enabled && cid && leftGroup ? isEditorEmpty(box) : true;
    const langTag = snapshot ? snapshot.langTag : isZhUi() ? 'zh' : 'en';
    return { enabled, mode, cid, box, footer, leftGroup, running, editorEmpty, langTag };
  }

  function clearTimers() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = 0;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = 0;
    }
  }

  function write(snapshot = null, planArg = undefined) {
    if (disposed) return;
    const plan = planArg !== undefined ? planArg : read(snapshot);
    if (!plan) return;
    if (!plan.enabled) {
      clearTimers();
      removePill();
      return;
    }

    const { cid, running } = plan;
    if (cid !== prevCid) {
      prevCid = cid;
      statusCache = { cid: '', ts: 0, inFlight: false, data: null };
      clearTimers();
      if (cid && !running) fetchStatus(cid, { force: true, allowRetry: false });
    } else if (prevRunning === true && !running && cid) {
      clearTimers();
      settleTimer = setTimeout(() => {
        settleTimer = 0;
        if (!disposed && getLiveMode() !== 'off' && !isComposerRunning() && getActiveRouteCid() === cid) {
          fetchStatus(cid, { force: true, allowRetry: true });
        }
      }, settleDelayMs);
    } else if (cid && !running && statusCache.cid !== cid) {
      fetchStatus(cid, { force: false, allowRetry: false });
    } else if (cid && !running && statusCache.cid === cid && statusCache.data?.request) {
      processFetchedRequest(cid, statusCache.data.request);
    }

    prevRunning = running;
    render(plan);
  }

  function sync() {
    if (disposed) return;
    write(null, read(null));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    offStudioPrefs?.();
    clearTimers();
    removePill();
  }

  return {
    topics: ['composer', 'route', 'prefs'],
    read,
    write,
    sync,
    dispose,
  };
}
