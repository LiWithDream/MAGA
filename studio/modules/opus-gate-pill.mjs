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

export function createOpusGatePillRuntime({ studioPrefs, motionThemes, openSubagent } = {}) {
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
  let fxRaf = 0;
  let fxActiveModel = '';
  let fxClock = 0;
  let fxFlow = 0;
  let fxLastTs = 0;
  let fxCanvas = null;

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

  function stopFxLoop() {
    if (fxRaf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(fxRaf);
    }
    fxRaf = 0;
    fxActiveModel = '';
    fxLastTs = 0;
    fxCanvas = null;
  }

  function findActiveReviewChild(cid = getActiveRouteCid()) {
    const m = typeof window === 'object' ? window.__ag_last_metrics : null;
    if (!cid || !m || (m.cascadeId && m.cascadeId !== cid)) return null;
    const raw = Array.isArray(m?.stats?.children) ? m.stats.children : [];
    for (let i = raw.length - 1; i >= 0; i--) {
      const ch = raw[i];
      if (!ch || !ch.id || ch.running !== true || ch.killed) continue;
      const rawName = String(ch.agentName || ch.title || '').trim();
      if (!/(?:^|[\s@_-])(?:opus|carbon|review)(?:[\s_-]|$)/i.test(rawName)) continue;
      const hint = `${rawName} ${ch.modelName || ''} ${ch.model || ''}`;
      let model = getDefaultReviewerModel();
      if (/carbon|gemini/i.test(hint)) model = 'carbon';
      else if (/opus|claude/i.test(hint)) model = 'opus';
      return { id: ch.id, label: rawName, model };
    }
    return null;
  }

  function paintFxFrame(canvas, model) {
    if (disposed || !canvas) return false;
    let mt = null;
    try {
      mt = typeof motionThemes === 'function' ? motionThemes() : motionThemes;
    } catch {
      mt = null;
    }
    if (!mt) return false;
    let ctx = null;
    try {
      ctx = canvas.getContext?.('2d') || null;
    } catch {
      ctx = null;
    }
    if (!ctx) return false;

    const rect = canvas.parentElement?.getBoundingClientRect?.() || canvas.getBoundingClientRect?.() || { width: 0, height: 0 };
    const w = rect.width > 0 ? Math.round(rect.width) : 116;
    const h = rect.height > 0 ? Math.round(rect.height) : 28;
    const dpr = Math.min((typeof window === 'object' && window.devicePixelRatio) || 1, 2);
    const pxW = Math.max(1, Math.round(w * dpr));
    const pxH = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const prefs = studioPrefs?.get?.() || {};
    const pal = model === 'carbon' ? mt.GEMINI_PALETTES?.carbon : mt.CLAUDE_PALETTES?.opus;
    if (model === 'carbon' && typeof mt.paintGeminiSlider === 'function') {
      mt.paintGeminiSlider(ctx, pal, prefs.geminiTheme || 'physical', w, h, fxFlow, fxClock, 0.92, { isLight: false });
    } else if (typeof mt.paintClaudeSlider === 'function') {
      mt.paintClaudeSlider(ctx, pal, prefs.claudeTheme || 'matrix', w, h, fxFlow, fxClock, 0.92, { isLight: false });
    }
    return { mt, pal, prefs };
  }

  function startFxLoop(canvas, model) {
    if (disposed || !canvas) return;
    const prefs = studioPrefs?.get?.() || {};
    const motionLevel = prefs.motionLevel || 'full';
    const effortMotion = prefs.effortMotion || 'full';
    const mediaReduced = Boolean(typeof window === 'object' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    const staticOnly = motionLevel === 'off' || effortMotion === 'off' || mediaReduced;

    if (fxCanvas === canvas && fxActiveModel === model && (fxRaf || staticOnly)) {
      if (staticOnly) paintFxFrame(canvas, model);
      return;
    }

    stopFxLoop();
    const painted = paintFxFrame(canvas, model);
    if (!painted || staticOnly || typeof requestAnimationFrame !== 'function') return;

    fxCanvas = canvas;
    fxActiveModel = model;
    fxLastTs = 0;

    const tickFx = (ts) => {
      if (disposed || fxCanvas !== canvas || !canvas.isConnected) {
        stopFxLoop();
        return;
      }
      const curPrefs = studioPrefs?.get?.() || {};
      const curMotion = curPrefs.motionLevel || 'full';
      const curEffort = curPrefs.effortMotion || 'full';
      if (curMotion === 'off' || curEffort === 'off') {
        paintFxFrame(canvas, fxActiveModel);
        stopFxLoop();
        return;
      }
      const dt = fxLastTs > 0 ? Math.min(0.05, Math.max(0.001, (ts - fxLastTs) / 1000)) : 0.016;
      fxLastTs = ts;
      const slow = curMotion === 'reduced' ? 0.45 : 1;
      const speedMul = Number(painted.pal?.speedMul || 1);
      fxClock += dt * slow;
      fxFlow += dt * slow * speedMul;
      paintFxFrame(canvas, fxActiveModel);
      fxRaf = requestAnimationFrame(tickFx);
    };
    fxRaf = requestAnimationFrame(tickFx);
  }

  function removePill() {
    stopFxLoop();
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

  function formatReason(rawReason) {
    const raw = String(rawReason || '').trim();
    if (!raw) return L('对当前工作区发起只读审查', 'Run a focused read-only review');
    if (!isZhUi()) return raw;
    const actMap = { merge: '合并', push: '推送', deploy: '部署' };
    let m = raw.match(/^Pre-(merge|push|deploy) high-risk changes \((.+)\)$/i);
    if (m) return `${actMap[m[1].toLowerCase()] || m[1]}前涉及高风险文件：${m[2]}`;
    m = raw.match(/^Pre-(merge|push|deploy) review \((\d+) files?, (\d+) lines?\)$/i);
    if (m) return `${actMap[m[1].toLowerCase()] || m[1]}前待审 · ${m[2]} 个文件，约 ${m[3]} 行`;
    m = raw.match(/^Plan artifact pending review before coding \((.+)\)$/i);
    if (m) return `方案文档待确认：${m[1]}`;
    m = raw.match(/^Substantial workspace diff \((\d+) files?, (\d+) lines?\)$/i);
    if (m) return `工作区较大改动 · ${m[1]} 个文件，约 ${m[2]} 行`;
    m = raw.match(/^High-risk file changes \((.+)\)$/i);
    if (m) return `涉及高风险文件：${m[1]}`;
    m = raw.match(/^Consecutive command failures \((\d+)\)$/i);
    if (m) return `命令连续失败 ${m[1]} 次`;
    if (/^Plan finalized via exit_plan_mode$/i.test(raw)) return '执行计划已定型';
    m = raw.match(/^Plan artifact updated \((.+)\)$/i);
    if (m) return `方案文档已更新：${m[1]}`;
    if (/^Plan artifact ready for review$/i.test(raw)) return '方案已就绪';
    return raw;
  }

  function renderMenuContent(el, prop = activeMenuProp) {
    const quota = statusCache.data?.quotaState || null;
    const live = computeLivePoolState(selectedMenuModel, quota, prop);
    const reason = formatReason(prop?.reason);
    const warnHtml = live.quotaBlocked
      ? `<div class="agy-opus-menu-warn">${esc(L(`${live.spec.poolLabel} 配额已低于熔断水位，自动把关已暂停（仍可手动放行）`, `${live.spec.poolLabel} quota below breaker floor; manual confirmation required`))}</div>`
      : '';
    const quotaRows = [];
    if (live.fiveHourPct !== null && live.fiveHourPct !== undefined) {
      quotaRows.push(
        `<span class="agy-opus-menu-qrow">` +
          `<span class="agy-opus-menu-qlbl">5h</span>` +
          `<span class="agy-opus-menu-qval">${Math.round(live.fiveHourPct)}%</span>` +
        `</span>`
      );
    }
    if (live.weeklyPct !== null && live.weeklyPct !== undefined) {
      quotaRows.push(
        `<span class="agy-opus-menu-qrow">` +
          `<span class="agy-opus-menu-qlbl">${esc(L('每周', 'Wk'))}</span>` +
          `<span class="agy-opus-menu-qval">${Math.round(live.weeklyPct)}%</span>` +
        `</span>`
      );
    }
    const quotaRowsHtml = quotaRows.length
      ? quotaRows.join('')
      : `<span class="agy-opus-menu-qrow"><span class="agy-opus-menu-qlbl">${esc(live.spec.poolLabel)}</span></span>`;
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
        `<div class="agy-opus-menu-id">` +
          `<span class="agy-opus-menu-title">✦ ${esc(L('审查关卡', 'Review Gate'))}</span>` +
          `<span class="agy-opus-menu-model">${esc(live.spec.shortLabel)}</span>` +
        `</div>` +
        `<div class="agy-opus-menu-quota">${quotaRowsHtml}</div>` +
      `</div>` +
      switchHtml +
      `<div class="agy-opus-menu-meta">` +
        `<span class="agy-opus-menu-badge">${esc(kindLabel(activeMenuKind))}</span>` +
        `<span class="agy-opus-menu-reason">${esc(reason)}</span>` +
      `</div>` +
      warnHtml +
      `<div class="agy-opus-menu-actions">` +
        `<button type="button" class="agy-opus-act is-primary" data-agy-opus-action="swarm">` +
          `<span class="agy-opus-act-t">${esc(L(`发起 ${live.spec.shortLabel} 审查`, `Review with ${live.spec.shortLabel}`))}</span>` +
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
    const mw = el.offsetWidth || 240;
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

    const activeReview = findActiveReviewChild(cid);
    const running = plan ? plan.running : isComposerRunning();
    const editorEmpty = plan ? plan.editorEmpty : isEditorEmpty(box);
    if (activeReview) {
      if (!editorEmpty) {
        removePill();
        return;
      }
      closeMenu();
    } else {
      stopFxLoop();
      if (running || !editorEmpty) {
        removePill();
        return;
      }
    }

    const prop = activeReview ? null : statusCache.cid === cid ? statusCache.data?.proposal : null;
    if (!activeReview && (!prop || prop.dismissed)) {
      removePill();
      return;
    }

    const key = activeReview ? `reviewing:${activeReview.id}:${activeReview.model}` : proposalKey(cid, prop);
    if (!activeReview && dismissedSet.has(key)) {
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
        '<canvas class="agy-opus-fx" aria-hidden="true"></canvas>' +
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
        const liveRev = findActiveReviewChild(curCid);
        if (liveRev) {
          closeMenu();
          if (typeof openSubagent === 'function') {
            openSubagent(liveRev.id, liveRev.label);
          } else {
            document.getElementById('agy-main-subagent-pill')?.click?.();
          }
          return;
        }
        const curProp = statusCache.cid === curCid ? statusCache.data?.proposal : null;
        if (menuOpen) closeMenu();
        else if (curProp) openMenuFor(pill, curProp.kind || 'review', curProp);
      });

      pill.querySelector('.agy-opus-dismiss')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const curCid = getActiveRouteCid();
        if (findActiveReviewChild(curCid)) return;
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

    const langTag = plan ? plan.langTag : (isZhUi() ? 'zh' : 'en');
    if (activeReview) {
      const label =
        activeReview.model === 'carbon'
          ? L('Carbon 审查中', 'Carbon Reviewing')
          : L('Opus 审查中', 'Opus Reviewing');
      const tip = L('点击查看审查子代理进度', 'Click to view active reviewer');
      const sig = `${key}|${langTag}|reviewing|${label}`;
      if (pill.getAttribute('data-sig') !== sig) {
        setAttr(pill, 'data-sig', sig);
        setAttr(pill, 'data-reviewing', '1');
        setAttr(pill, 'data-reviewer-model', activeReview.model);
        setAttr(pill, 'data-quota-blocked', '0');
        const lblEl = pill.querySelector('.agy-opus-label');
        if (lblEl) setLeafText(lblEl, label);
        const goBtn = pill.querySelector('.agy-opus-go');
        if (goBtn && goBtn.title !== tip) goBtn.title = tip;
      }
      startFxLoop(pill.querySelector('.agy-opus-fx'), activeReview.model);
      return;
    }

    const defaultModel = getDefaultReviewerModel();
    const live = computeLivePoolState(defaultModel, statusCache.data?.quotaState, prop);
    const label = live.quotaBlocked
      ? L('审查配额紧', 'Review · Low Quota')
      : L('请求审查', 'Review');
    const tip = `${kindLabel(prop.kind)}: ${prop.reason || ''} · ${live.spec.shortLabel} · ${live.quotaText}`;
    const sig = `${key}|${langTag}|${defaultModel}|${label}|${live.quotaBlocked ? 1 : 0}|${live.quotaText}`;
    if (pill.getAttribute('data-sig') !== sig) {
      setAttr(pill, 'data-sig', sig);
      setAttr(pill, 'data-reviewing', '0');
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
    topics: ['composer', 'route', 'prefs', 'metrics', 'subagent'],
    read,
    write,
    sync,
    dispose,
  };
}
