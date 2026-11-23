/**
 * Interrupted-Task Resume Capsule (#agy-resume-pill):
 * Detects when the active main conversation terminated abnormally mid-task (app quit/restart,
 * crash, mid-tool stop, manual cancel, or error) via daemon RPC `getResumeState` and surfaces
 * a calm, one-click `[ ▶ 继续任务 × ]` / `[ ▶ Resume × ]` capsule in the open left space of Row 1.
 * Automatically hides while running, whenever the user starts typing, or after dismissal.
 */

export function createResumeBannerRuntime() {
  const PILL_ID = 'agy-resume-pill';
  const DISMISS_STORAGE_KEY = 'agy_studio_resume_dismissed_v1';
  const MAX_DISMISSED = 120;

  let disposed = false;
  let prevCid = '';
  let prevRunning = null;
  let settleTimer = 0;
  let stateCache = { cid: '', ts: 0, inFlight: false, data: null };

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

  function isZh() {
    return (
      (document.documentElement.lang || '').toLowerCase().startsWith('zh') ||
      document.documentElement.getAttribute('data-ag-ux-lang') === 'zh-CN'
    );
  }

  function L(zh, en) {
    return isZh() ? zh : en;
  }

  function getActiveCid() {
    const m = String(location.pathname || '').match(/\/c\/([^/?#]+)/);
    return m ? m[1] : '';
  }

  function getMainBox() {
    return (
      document.getElementById('antigravity.agentSidePanelInputBox') ||
      document.querySelector('[data-testid="conversation-view"] [data-testid="agent-input-box"]')
    );
  }

  function isMainRunning() {
    const box = getMainBox();
    if (!box) return false;
    const cancelBtn = box.querySelector('.agy-composer-footer button[data-testid="input-cancel-button"]');
    if (!cancelBtn) return false;
    if (typeof cancelBtn.checkVisibility === 'function') {
      return cancelBtn.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    }
    return cancelBtn.offsetParent !== null;
  }

  function isEditorEmpty() {
    const box = getMainBox();
    const editor = box?.querySelector('[data-lexical-editor="true"]');
    if (!editor) return true;
    const text = (editor.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    return text.length === 0;
  }

  function reasonText(reason) {
    switch (reason) {
      case 'aborted':
        return L('上次任务在运行中意外中断', 'Previous task was interrupted mid-run');
      case 'mid_tool':
        return L('上次工具执行后未继续完成', 'Interrupted right after a tool step');
      case 'canceled':
        return L('上次执行被暂停', 'Previous run was stopped');
      case 'error':
        return L('上次执行遇到错误而停止', 'Previous run stopped due to an error');
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

  function triggerResume(cid, lastIdx) {
    const box = getMainBox();
    const editor = box?.querySelector('[data-lexical-editor="true"]');
    if (!box || !editor) return;

    dismissCurrent(cid, lastIdx);

    const prompt = L(
      '请从上次中断处继续完成剩余任务，先快速核对当前实际状态再接着执行。',
      'Please resume from where the task was interrupted — quickly verify the current state and continue the remaining steps.'
    );

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
      if (disposed || attempt > 8) return;
      const sendBtn = box.querySelector('.agy-composer-footer button[data-testid="input-send-button"]');
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        return;
      }
      setTimeout(() => clickSend(attempt + 1), 40);
    };
    requestAnimationFrame(() => clickSend(0));
  }

  function fetchResumeState(cid, { force = false } = {}) {
    if (!cid || disposed || typeof window.__agProjectCall !== 'function') return;
    const now = Date.now();
    if (!force && stateCache.cid === cid && (stateCache.inFlight || now - stateCache.ts < 3500)) return;
    if (stateCache.inFlight && stateCache.cid === cid) return;

    stateCache.cid = cid;
    stateCache.inFlight = true;
    Promise.resolve(window.__agProjectCall('getResumeState', { cascadeId: cid }, 3000))
      .then((res) => {
        if (disposed || stateCache.cid !== cid) return;
        if (res && res.ok) {
          stateCache.data = res;
          stateCache.ts = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => {
        if (stateCache.cid === cid) stateCache.inFlight = false;
        if (!disposed) render();
      });
  }

  function render() {
    if (disposed) return;
    const cid = getActiveCid();
    const box = getMainBox();
    const footer = box?.querySelector('.agy-composer-footer');
    const leftGroup = footer?.children?.[0];
    if (!cid || !footer || !leftGroup) {
      removePill();
      return;
    }

    const running = isMainRunning();
    if (running || !isEditorEmpty()) {
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
        const curCid = getActiveCid();
        const curData = stateCache.cid === curCid ? stateCache.data : null;
        if (curCid && curData) triggerResume(curCid, curData.lastIdx);
      });

      pill.querySelector('.agy-resume-dismiss')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const curCid = getActiveCid();
        const curData = stateCache.cid === curCid ? stateCache.data : null;
        if (curCid && curData) dismissCurrent(curCid, curData.lastIdx);
      });
    }

    if (pill.parentElement !== leftGroup) {
      leftGroup.insertBefore(pill, leftGroup.firstChild);
    }

    const label = L('继续任务', 'Resume');
    const tip = `${reasonText(data.reason)} · ${L('点击自动续跑', 'Click to resume')}`;
    const sig = `${key}|${label}|${tip}`;
    if (pill.getAttribute('data-sig') !== sig) {
      pill.setAttribute('data-sig', sig);
      const lblEl = pill.querySelector('.agy-resume-label');
      if (lblEl) lblEl.textContent = label;
      const goBtn = pill.querySelector('.agy-resume-go');
      if (goBtn) goBtn.title = tip;
      const disBtn = pill.querySelector('.agy-resume-dismiss');
      if (disBtn) disBtn.title = L('忽略提示', 'Dismiss');
    }
  }

  function sync() {
    if (disposed) return;
    const cid = getActiveCid();
    const running = isMainRunning();

    if (cid !== prevCid) {
      prevCid = cid;
      stateCache = { cid: '', ts: 0, inFlight: false, data: null };
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
      if (cid && !running) fetchResumeState(cid, { force: true });
    } else if (prevRunning === true && !running && cid) {
      // Wait briefly for Antigravity to flush the final SQLite step after stop/finish
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = 0;
        if (!disposed && !isMainRunning() && getActiveCid() === cid) {
          fetchResumeState(cid, { force: true });
        }
      }, 650);
    } else if (cid && !running && stateCache.cid !== cid) {
      fetchResumeState(cid);
    }

    prevRunning = running;
    render();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = 0;
    }
    removePill();
  }

  return { sync, dispose };
}
