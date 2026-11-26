/**
 * MAGA Review Gate Cockpit Pill (#agy-opus-gate-pill) & Action Popover (#agy-opus-gate-menu):
 * - Single-observer MagaKernel citizen (zero standalone MutationObserver).
 * - Polls daemon `getOpusGateStatus` on route/turn-settle transitions to surface non-intrusive
 *   Row 1 proposal pills when `opusGateMode !== 'off'` and a checkpoint fires.
 * - Supports Carbon High (`gemini-4-carbon-high`) & Opus High (`claude-opus-5-5-high`) with live
 *   per-pool quota tracking, per-click popover override, in-turn `/swarm` audit,
 *   and on-demand invocation via `window.__agyOpusGateTrigger`.
 */
import { markOwn, setAttr, setLeafText } from '../core/dom.mjs';
import { getActiveRouteCid, isComposerRunning, isZhUi, L } from '../core/env.mjs';

const REVIEWER_META = Object.freeze({
  opus: Object.freeze({
    key: 'opus',
    modelId: 'claude-opus-5-5-high',
    shortLabel: 'Opus High',
    pool: 'claude',
    poolLabel: 'Claude',
  }),
  carbon: Object.freeze({
    key: 'carbon',
    modelId: 'gemini-4-carbon-high',
    shortLabel: 'Carbon High',
    pool: 'gemini',
    poolLabel: 'Gemini',
  }),
});

function normalizeReviewerModel(raw, fallback = 'opus') {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'carbon') return 'carbon';
  if (s === 'opus') return 'opus';
  return fallback === 'carbon' ? 'carbon' : 'opus';
}

export function createOpusGatePillRuntime({ studioPrefs } = {}) {
  const PILL_ID = 'agy-opus-gate-pill';
  const MENU_ID = 'agy-opus-gate-menu';
  const DISMISS_STORAGE_KEY = 'agy_studio_opus_gate_dismissed_v1';
  const MAX_DISMISSED = 120;

  let disposed = false;
  let prevCid = '';
  let prevRunning = null;
  let settleTimer = 0;
  let menuOpen = false;
  let menuEl = null;
  let activeMenuKind = 'review';
  let activeMenuProp = null;
  let selectedMenuModel = 'opus';
  let statusCache = { cid: '', ts: 0, inFlight: false, data: null };
  const fallbackTimers = new Set();

  const isEnabled = () => (studioPrefs?.get?.()?.opusGateMode || 'semi') !== 'off';
  const getDefaultReviewerModel = () => normalizeReviewerModel(studioPrefs?.get?.()?.opusGateModel, 'opus');

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

  function proposalKey(cid, prop) {
    if (!cid || !prop) return '';
    return `${cid}:${prop.kind || 'review'}:${prop.diffHash || prop.ts || 0}`;
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

  function decodeFileUri(uri) {
    const s = String(uri || '').trim();
    if (!s) return '';
    if (!/^file:\/\//i.test(s)) return s;
    try {
      let p = decodeURIComponent(new URL(s).pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return p;
    } catch {
      return '';
    }
  }

  function resolveActiveDirPath() {
    const cid = getActiveRouteCid();
    if (!cid) return '';
    const anchors = [
      document.querySelector('.bg-sidebar'),
      document.getElementById('root')?.firstElementChild,
    ].filter(Boolean);
    for (const anchor of anchors) {
      const fk = Object.keys(anchor).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
      let f = fk ? anchor[fk] : null;
      for (let i = 0; i < 40 && f; i++, f = f.return) {
        const mp = f.memoizedProps;
        const candStore = mp?.sidebarStore || mp?.store || mp?.value?.store;
        if (candStore && typeof candStore.getState === 'function') {
          try {
            const st = candStore.getState();
            const sum = st?.trajectorySummaries?.summaries?.[cid];
            const wsList = (sum?.workspaces || []).concat(sum?.trajectoryMetadata?.workspaces || []);
            for (const ws of wsList) {
              const rawUri = ws?.workspaceFolderAbsoluteUri || ws?.uri || ws;
              if (typeof rawUri === 'string' && rawUri.trim()) {
                const decoded = decodeFileUri(rawUri);
                if (decoded) return decoded;
              }
            }
          } catch {}
        }
      }
    }
    return '';
  }

  function findAgentHandleSubmit(box) {
    if (!box) return null;
    const fk = Object.keys(box).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fk ? box[fk] : null;
    for (let i = 0; i < 12 && fiber; i++) {
      const fn = fiber.memoizedProps?.handleSubmit;
      if (typeof fn === 'function') return fn;
      fiber = fiber.return;
    }
    return null;
  }

  function findSendButton(box) {
    return (
      box?.querySelector(
        '.agy-composer-footer button[data-testid="input-send-button"]:not(:disabled), ' +
        '.agy-composer-footer button[data-testid="send-button"]:not(:disabled), ' +
        '.agy-composer-footer button[aria-label="Send"]:not(:disabled), ' +
        '.agy-composer-footer button[aria-label="Send message"]:not(:disabled), ' +
        '.agy-composer-footer button[aria-label*="发送"]:not(:disabled)'
      ) || null
    );
  }

  function submitPromptIntoBox(box, promptText) {
    const prompt = String(promptText || '').trim();
    if (!box || !prompt) return false;
    const handleSubmit = findAgentHandleSubmit(box);
    if (handleSubmit) {
      try {
        const res = handleSubmit([{ chunk: { case: 'text', value: prompt } }], [], () => {});
        Promise.resolve(res).catch(() => {});
        return true;
      } catch {}
    }
    const editor = box.querySelector('[data-lexical-editor="true"]');
    if (!editor) return false;
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
    trackTimer(() => {
      const btn = findSendButton(box);
      if (btn) btn.click();
    }, 60);
    return true;
  }

  function closeMenu() {
    menuOpen = false;
    activeMenuProp = null;
    if (menuEl) menuEl.removeAttribute('data-open');
  }

  function removePill() {
    closeMenu();
    document.getElementById(PILL_ID)?.remove();
  }

  function dismissCurrent(cid, prop) {
    const key = proposalKey(cid, prop);
    if (key) {
      dismissedSet.add(key);
      persistDismissed();
    }
    if (statusCache.cid === cid && statusCache.data) {
      statusCache.data = { ...statusCache.data, proposal: null };
    }
    removePill();
    if (cid && typeof window.__agProjectCall === 'function') {
      window.__agProjectCall('dismissOpusGateProposal', { cascadeId: cid, diffHash: prop?.diffHash || '' }, 3000).catch(() => {});
    }
  }

  async function runPathASwarm(kind, modelOverride) {
    closeMenu();
    const cid = getActiveRouteCid();
    const curProp = statusCache.cid === cid ? statusCache.data?.proposal : null;
    const box = getMainBox();
    if (!box || typeof window.__agProjectCall !== 'function') return;
    const model = normalizeReviewerModel(modelOverride, getDefaultReviewerModel());
    const res = await window
      .__agProjectCall('buildOpusHandoffBrief', { cascadeId: cid, dirPath: resolveActiveDirPath(), kind, model }, 6000)
      .catch(() => null);
    if (disposed || !res?.ok || !res.swarmPrompt) return;
    submitPromptIntoBox(box, res.swarmPrompt);
    if (cid && curProp) dismissCurrent(cid, curProp);
  }

  function kindLabel(kind) {
    switch (kind) {
      case 'debug':
        return L('连续报错排障', 'Debug Escalation');
      case 'risk':
        return L('高风险变更', 'High-Risk Diff');
      case 'stop':
        return L('收尾终审', 'Final Audit');
      case 'plan':
        return L('方案定型', 'Plan Review');
      default:
        return L('手动把关', 'On-Demand Check');
    }
  }

  function computeLivePoolState(modelKey, quotaState, prop) {
    const key = normalizeReviewerModel(modelKey, 'opus');
    const spec = REVIEWER_META[key];
    const prefs = studioPrefs?.get?.() || {};
    const min5h = Number(prefs.opusGateMinQuota5hPct ?? 20);
    const minWeekly = Number(prefs.opusGateMinQuotaWeeklyPct ?? 15);
    const livePool = quotaState?.[spec.pool] || null;
    const live5h = livePool?.fiveHourRemainingPct ?? null;
    const liveWeekly = livePool?.weeklyRemainingPct ?? null;
    const fallback5h =
      spec.pool === 'gemini'
        ? (prop?.quotaPool === 'gemini' ? prop?.pool5hPct : null) ?? prop?.gemini5hPct ?? null
        : (prop?.quotaPool === 'claude' || !prop?.quotaPool ? prop?.pool5hPct : null) ?? prop?.claude5hPct ?? null;
    const fallbackWeekly =
      spec.pool === 'gemini'
        ? (prop?.quotaPool === 'gemini' ? prop?.poolWeeklyPct : null) ?? prop?.geminiWeeklyPct ?? null
        : (prop?.quotaPool === 'claude' || !prop?.quotaPool ? prop?.poolWeeklyPct : null) ?? prop?.claudeWeeklyPct ?? null;
    const hasLivePool = live5h !== null || liveWeekly !== null;
    const fiveHourPct = live5h ?? fallback5h;
    const weeklyPct = liveWeekly ?? fallbackWeekly;
    const samePoolAsProp = prop?.quotaPool ? prop.quotaPool === spec.pool : spec.pool === 'claude';
    const quotaBlocked = hasLivePool
      ? (fiveHourPct !== null && fiveHourPct < min5h) || (weeklyPct !== null && weeklyPct < minWeekly)
      : fiveHourPct !== null || weeklyPct !== null
        ? (fiveHourPct !== null && fiveHourPct < min5h) || (weeklyPct !== null && weeklyPct < minWeekly)
        : samePoolAsProp
          ? Boolean(prop?.quotaBlocked)
          : false;
    const parts = [];
    if (fiveHourPct !== null && fiveHourPct !== undefined) parts.push(`5h ${Math.round(fiveHourPct)}%`);
    if (weeklyPct !== null && weeklyPct !== undefined) parts.push(`${L('周', 'Wk')} ${Math.round(weeklyPct)}%`);
    const quotaText = parts.length ? `${spec.poolLabel} ${parts.join(' · ')}` : spec.shortLabel;
    return { spec, fiveHourPct, weeklyPct, quotaBlocked, quotaText };
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureMenuEl() {
    if (menuEl && menuEl.isConnected) return menuEl;
    menuEl = document.getElementById(MENU_ID);
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.id = MENU_ID;
      markOwn(menuEl);
      menuEl.setAttribute('data-ag-i18n-ignore', '1');
      menuEl.addEventListener('click', (e) => {
        const modelBtn = e.target?.closest?.('button[data-agy-opus-model]');
        if (modelBtn) {
          e.preventDefault();
          e.stopPropagation();
          const nextModel = normalizeReviewerModel(modelBtn.getAttribute('data-agy-opus-model'), selectedMenuModel);
          if (nextModel !== selectedMenuModel) {
            selectedMenuModel = nextModel;
            renderMenuContent(menuEl, activeMenuProp);
          }
          return;
        }
        const btn = e.target?.closest?.('button[data-agy-opus-action]');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const act = btn.getAttribute('data-agy-opus-action');
        if (act === 'swarm') runPathASwarm(activeMenuKind, selectedMenuModel);
      });
      document.body.appendChild(menuEl);
    } else {
      markOwn(menuEl);
    }
    return menuEl;
  }

  function renderMenuContent(el, prop = activeMenuProp) {
    const quota = statusCache.data?.quotaState || null;
    const live = computeLivePoolState(selectedMenuModel, quota, prop);
    const reason = prop?.reason || L('调度高阶审查模型对当前工作区进行结构化只读把关', 'Run a quota-guarded high-tier checkpoint review');
    const warnHtml = live.quotaBlocked
      ? `<div class="agy-opus-menu-warn">${esc(L(`${live.spec.poolLabel} 配额已低于熔断水位，自动把关已暂停（仍可手动放行）`, `${live.spec.poolLabel} quota below breaker floor; manual confirmation required`))}</div>`
      : '';
    const switchHtml =
      `<div class="agy-opus-model-switch" role="group" aria-label="${esc(L('审查模型', 'Review Model'))}">` +
        ['carbon', 'opus']
          .map((key) => {
            const m = REVIEWER_META[key];
            const active = selectedMenuModel === key;
            return (
              `<button type="button" class="agy-opus-model-opt${active ? ' is-active' : ''}" data-agy-opus-model="${key}" aria-pressed="${active ? 'true' : 'false'}">` +
                `${esc(m.shortLabel)}` +
              `</button>`
            );
          })
          .join('') +
      `</div>`;

    setAttr(el, 'data-reviewer-model', selectedMenuModel);
    el.innerHTML =
      `<div class="agy-opus-menu-hdr">` +
        `<span class="agy-opus-menu-title">✦ ${esc(L('审查关卡', 'Review Gate'))} · ${esc(live.spec.shortLabel)}</span>` +
        `<span class="agy-opus-menu-quota">${esc(live.quotaText)}</span>` +
      `</div>` +
      switchHtml +
      `<div class="agy-opus-menu-meta">` +
        `<span class="agy-opus-menu-badge">${esc(kindLabel(activeMenuKind))}</span>` +
        `<span class="agy-opus-menu-reason">${esc(reason)}</span>` +
      `</div>` +
      warnHtml +
      `<div class="agy-opus-menu-actions">` +
        `<button type="button" class="agy-opus-act is-primary" data-agy-opus-action="swarm">` +
          `<span class="agy-opus-act-t">${esc(L(`当前对话 /swarm 请 ${live.spec.shortLabel} 审查`, `Audit in-turn via /swarm (${live.spec.shortLabel})`))}</span>` +
          `<span class="agy-opus-act-d">${esc(L(`拉起单兵只读 ${live.spec.shortLabel} 并自动回传当前线程`, `Spawns 1 read-only ${live.spec.shortLabel} worker & returns verdict here`))}</span>` +
        `</button>` +
      `</div>`;
  }

  function openMenuFor(anchorEl, kind = 'review', prop = null) {
    if (!anchorEl) return;
    activeMenuKind = kind || prop?.kind || 'review';
    activeMenuProp = prop || null;
    selectedMenuModel = getDefaultReviewerModel();
    const el = ensureMenuEl();
    renderMenuContent(el, activeMenuProp);

    el.setAttribute('data-open', '1');
    menuOpen = true;
    const r = anchorEl.getBoundingClientRect();
    const mw = el.offsetWidth || 276;
    const left = Math.round(Math.max(10, Math.min(r.left, window.innerWidth - mw - 12)));
    const bottom = Math.round(Math.max(10, window.innerHeight - r.top + 8));
    el.style.left = `${left}px`;
    el.style.bottom = `${bottom}px`;
  }

  function openManualMenu(kind = 'manual') {
    if (!isEnabled() || disposed) return;
    const cid = getActiveRouteCid();
    const prop = statusCache.cid === cid ? statusCache.data?.proposal || null : null;
    const anchor =
      document.getElementById(PILL_ID) ||
      document.getElementById('ag-claude-ctx-ring') ||
      getMainBox()?.querySelector('.agy-composer-footer');
    if (anchor) openMenuFor(anchor, prop?.kind || kind, prop);
  }

  if (typeof window === 'object' && window) {
    window.__agyOpusGateTrigger = openManualMenu;
  }

  const onDocClick = (e) => {
    if (!menuOpen) return;
    if (menuEl?.contains(e.target)) return;
    if (e.target?.closest?.(`#${PILL_ID}`)) return;
    closeMenu();
  };
  const onDocKey = (e) => {
    if (menuOpen && e.key === 'Escape') closeMenu();
  };
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onDocKey, true);

  function fetchStatus(cid, { force = false } = {}) {
    if (!cid || disposed || typeof window.__agProjectCall !== 'function') return;
    const now = Date.now();
    if (!force && statusCache.cid === cid && (statusCache.inFlight || now - statusCache.ts < 4000)) return;
    if (statusCache.inFlight && statusCache.cid === cid) return;

    statusCache.cid = cid;
    statusCache.inFlight = true;
    Promise.resolve(window.__agProjectCall('getOpusGateStatus', { cascadeId: cid }, 3000))
      .then((res) => {
        if (disposed || statusCache.cid !== cid) return;
        if (res && res.ok) {
          statusCache.data = res;
          statusCache.ts = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => {
        if (statusCache.cid === cid) statusCache.inFlight = false;
        if (!disposed) render();
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

    const running = plan ? plan.running : isComposerRunning();
    const editorEmpty = plan ? plan.editorEmpty : isEditorEmpty(box);
    if (running || !editorEmpty) {
      removePill();
      return;
    }

    const prop = statusCache.cid === cid ? statusCache.data?.proposal : null;
    if (!prop || prop.dismissed) {
      removePill();
      return;
    }

    const key = proposalKey(cid, prop);
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
        '<button type="button" class="agy-opus-go">' +
          '<span class="agy-opus-star" aria-hidden="true">✦</span>' +
          '<span class="agy-opus-label"></span>' +
        '</button>' +
        '<button type="button" class="agy-opus-dismiss" aria-label="Dismiss">' +
          '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>' +
        '</button>';

      pill.querySelector('.agy-opus-go')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const curCid = getActiveRouteCid();
        const curProp = statusCache.cid === curCid ? statusCache.data?.proposal : null;
        if (menuOpen) closeMenu();
        else if (curProp) openMenuFor(pill, curProp.kind || 'review', curProp);
      });

      pill.querySelector('.agy-opus-dismiss')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const curCid = getActiveRouteCid();
        const curProp = statusCache.cid === curCid ? statusCache.data?.proposal : null;
        if (curCid && curProp) dismissCurrent(curCid, curProp);
      });
    } else {
      markOwn(pill);
    }

    if (pill.parentElement !== leftGroup) {
      const resumeEl = document.getElementById('agy-resume-pill');
      if (resumeEl && resumeEl.parentElement === leftGroup) {
        resumeEl.insertAdjacentElement('afterend', pill);
      } else {
        leftGroup.insertBefore(pill, leftGroup.firstChild);
      }
    }

    const defaultModel = getDefaultReviewerModel();
    const live = computeLivePoolState(defaultModel, statusCache.data?.quotaState, prop);
    const label = live.quotaBlocked
      ? L('审查配额紧', 'Review · Low Quota')
      : L('请求审查', 'Review');
    const langTag = plan ? plan.langTag : (isZhUi() ? 'zh' : 'en');
    const tip = `${kindLabel(prop.kind)}: ${prop.reason || ''} · ${live.spec.shortLabel} · ${live.quotaText}`;
    const sig = `${key}|${langTag}|${defaultModel}|${label}|${live.quotaBlocked ? 1 : 0}|${live.quotaText}`;
    if (pill.getAttribute('data-sig') !== sig) {
      setAttr(pill, 'data-sig', sig);
      setAttr(pill, 'data-reviewer-model', defaultModel);
      setAttr(pill, 'data-quota-blocked', live.quotaBlocked ? '1' : '0');
      const lblEl = pill.querySelector('.agy-opus-label');
      if (lblEl) setLeafText(lblEl, label);
      const goBtn = pill.querySelector('.agy-opus-go');
      if (goBtn && goBtn.title !== tip) goBtn.title = tip;
      const disBtn = pill.querySelector('.agy-opus-dismiss');
      const dismissLbl = L('忽略提示', 'Dismiss');
      if (disBtn) {
        if (disBtn.title !== dismissLbl) disBtn.title = dismissLbl;
        setAttr(disBtn, 'aria-label', dismissLbl);
      }
    }
  }

  const offStudioPrefs = studioPrefs?.subscribe?.(() => {
    if (disposed) return;
    if (!isEnabled()) removePill();
    else render();
  });

  function read(snapshot = null) {
    if (disposed) return null;
    const enabled = isEnabled();
    const cid = snapshot ? snapshot.cid : getActiveRouteCid();
    const box = snapshot ? snapshot.mainBox : getMainBox();
    const footer = box?.querySelector?.('.agy-composer-footer') || null;
    const leftGroup = footer?.children?.[0] || null;
    const running = snapshot ? snapshot.isRunning : isComposerRunning();
    const editorEmpty = enabled && cid && leftGroup ? isEditorEmpty(box) : true;
    const langTag = snapshot ? snapshot.langTag : (isZhUi() ? 'zh' : 'en');
    return { enabled, cid, box, footer, leftGroup, running, editorEmpty, langTag };
  }

  function write(snapshot = null, planArg = undefined) {
    if (disposed) return;
    const plan = planArg !== undefined ? planArg : read(snapshot);
    if (!plan) return;
    if (!plan.enabled) {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
      removePill();
      return;
    }

    const { cid, running } = plan;
    if (cid !== prevCid) {
      prevCid = cid;
      statusCache = { cid: '', ts: 0, inFlight: false, data: null };
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
      if (cid && !running) fetchStatus(cid, { force: true });
    } else if (prevRunning === true && !running && cid) {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = 0;
        if (!disposed && isEnabled() && !isComposerRunning() && getActiveRouteCid() === cid) {
          fetchStatus(cid, { force: true });
        }
      }, 650);
    } else if (cid && !running && statusCache.cid !== cid) {
      fetchStatus(cid);
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
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = 0;
    }
    for (const id of fallbackTimers) clearTimeout(id);
    fallbackTimers.clear();
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onDocKey, true);
    removePill();
    if (menuEl) {
      try { menuEl.remove(); } catch {}
      menuEl = null;
    }
    if (typeof window === 'object' && window.__agyOpusGateTrigger === openManualMenu) {
      window.__agyOpusGateTrigger = null;
    }
  }

  return {
    topics: ['composer', 'route', 'prefs'],
    read,
    write,
    sync,
    dispose,
  };
}
