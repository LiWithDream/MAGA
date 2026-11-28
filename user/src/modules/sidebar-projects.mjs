/**
 * Sidebar Projects Smart Cap (default 4 per project / 8 total across Projects)
 * with priority protection (active/pending/running), fair water-filling allocation,
 * configurable sorting (`recent` / `fixed` / `name` / `usage`), and anti-jump cooldown.
 */
import {
  formatRunningBreakdownTooltip,
  formatRunningStatusTooltip,
  pickDominantRunningSubkind,
  renderRunningGlyphHtml,
} from './sidebar-status.mjs';

const COLLAPSED_PROJS_KEY = 'agy_sbp_collapsed_v1';
const COLLAPSED_SECS_KEY = 'agy_sbp_sec_collapsed_v1';
const SORT_PREFS_KEY = 'agy_sbp_sort_prefs_v1';
const DEFAULT_MAX_PER_PROJECT = 4;
const DEFAULT_MAX_TOTAL = 8;
const DEFAULT_STANDALONE_LIMIT = 8;
const DEFAULT_SORT_MODE = 'recent';
const DEFAULT_SORT_COOLDOWN_SEC = 300;
const VALID_SORT_MODES = new Set(['recent', 'fixed', 'name', 'usage']);
const VALID_SORT_COOLDOWNS = new Set([0, 60, 300]);
const USAGE_CACHE_TTL_MS = 25000;

const SvgFolder =
  '<svg viewBox="0 0 16 16" width="13.5" height="13.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.4A1.2 1.2 0 0 1 3.2 3.2h3.1l1.2 1.3h5.3a1.2 1.2 0 0 1 1.2 1.2v6.1a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8V4.4z"/></svg>';
const SvgChev =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.2L8 9.8l3.5-3.6"/></svg>';
const SvgCockpit =
  '<svg viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>';
const SvgPlus =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>';
const SvgSort =
  '<svg viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.2 3.2v9.6M5.2 3.2L3.2 5.2M5.2 3.2l2 2M10.8 12.8V3.2M10.8 12.8l-2-2M10.8 12.8l2-2"/></svg>';
const SvgRefresh =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 7.5A5 5 0 1 0 11.7 11.4"/><path d="M13.2 4.1v3.4H9.8"/></svg>';

function isPriorityChat(chat, activeId) {
  if (!chat) return false;
  if (activeId && chat.id === activeId) return true;
  const kind = chat.status && chat.status.kind;
  return kind === 'pending' || kind === 'running';
}

function selectVisibleChatsWithPriority(chats, limit, activeId) {
  const list = Array.isArray(chats) ? chats : [];
  const k = Math.min(list.length, Math.max(0, limit));
  if (k <= 0) return [];
  if (k >= list.length) return list.slice();

  const chosenIds = new Set(list.slice(0, k).map((c) => c.id));
  const urgentTail = list.slice(k).filter((c) => isPriorityChat(c, activeId));
  if (!urgentTail.length) return list.slice(0, k);

  // Replace lowest-priority tail slots inside head so urgent/active chats stay visible in natural order.
  let urgentCursor = 0;
  for (let i = k - 1; i >= 0 && urgentCursor < urgentTail.length; i--) {
    if (!isPriorityChat(list[i], activeId)) {
      chosenIds.delete(list[i].id);
      chosenIds.add(urgentTail[urgentCursor].id);
      urgentCursor += 1;
    }
  }
  return list.filter((c) => chosenIds.has(c.id));
}

/**
 * Pure two-pass water-filling allocator for expanded sidebar projects.
 * Guarantees every expanded project gets at least 1 visible chat (prioritizing urgent/active
 * projects if expanded project count > maxTotal), then fills round-robin up to maxPerProject
 * and maxTotal without letting one huge project starve sibling projects.
 */
export function computeSidebarProjectAllocation(
  projects,
  { maxPerProject = DEFAULT_MAX_PER_PROJECT, maxTotal = DEFAULT_MAX_TOTAL, activeId = '' } = {}
) {
  const list = Array.isArray(projects) ? projects : [];
  const perCap = Number(maxPerProject) > 0 ? Math.floor(Number(maxPerProject)) : Infinity;
  const totCap = Number(maxTotal) > 0 ? Math.floor(Number(maxTotal)) : Infinity;

  const eligible = list.filter((p) => p && !p.collapsed && !p.expandedOverride && Array.isArray(p.chats) && p.chats.length > 0);
  const allocMap = new Map();
  let used = 0;

  // Pass 1a: prioritize expanded projects holding active/pending/running conversations.
  for (const p of eligible) {
    if (used >= totCap && !p.chats.some((c) => isPriorityChat(c, activeId))) continue;
    if (p.chats.some((c) => isPriorityChat(c, activeId))) {
      allocMap.set(p.id, 1);
      used += 1;
    }
  }
  // Pass 1b: give remaining expanded non-empty projects at least 1 row while budget remains.
  for (const p of eligible) {
    if (used >= totCap) break;
    if (allocMap.has(p.id)) continue;
    allocMap.set(p.id, 1);
    used += 1;
  }

  // Pass 2: round-robin water-fill up to perCap & totCap.
  while (used < totCap) {
    let progressed = false;
    for (const p of eligible) {
      if (used >= totCap) break;
      const cur = allocMap.get(p.id) || 0;
      const maxForProj = Math.min(p.chats.length, perCap);
      if (cur < maxForProj) {
        allocMap.set(p.id, cur + 1);
        used += 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  let totalVisible = 0;
  let totalChats = 0;
  let hiddenTotal = 0;

  const items = list.map((p) => {
    const chats = Array.isArray(p?.chats) ? p.chats : [];
    totalChats += chats.length;
    if (!p || p.collapsed) {
      return { ...p, visibleChats: [], hiddenCount: 0 };
    }
    if (p.expandedOverride) {
      totalVisible += chats.length;
      return { ...p, visibleChats: chats.slice(), hiddenCount: 0 };
    }
    const alloc = allocMap.get(p.id) || 0;
    const visibleChats = selectVisibleChatsWithPriority(chats, alloc, activeId);
    const hiddenCount = Math.max(0, chats.length - visibleChats.length);
    totalVisible += visibleChats.length;
    hiddenTotal += hiddenCount;
    return { ...p, visibleChats, hiddenCount };
  });

  return { items, totalVisible, totalChats, hiddenTotal };
}

/**
 * Pure project ordering resolver with anti-jump cooldown snapshot for `recent` mode.
 */
export function resolveSidebarProjectOrder(projects, snapshot = null, opts = {}) {
  const list = Array.isArray(projects) ? projects.slice() : [];
  const sortMode = VALID_SORT_MODES.has(opts.sortMode) ? opts.sortMode : DEFAULT_SORT_MODE;
  const rawCd = opts.cooldownSec === undefined || opts.cooldownSec === null ? DEFAULT_SORT_COOLDOWN_SEC : Number(opts.cooldownSec);
  const cooldownSec = Number.isFinite(rawCd) && VALID_SORT_COOLDOWNS.has(Math.round(rawCd))
    ? Math.round(rawCd)
    : DEFAULT_SORT_COOLDOWN_SEC;
  const usageByProject = opts.usageByProject && typeof opts.usageByProject === 'object' ? opts.usageByProject : null;
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const forceRefresh = Boolean(opts.forceRefresh);

  if (sortMode === 'fixed') {
    const ordered = list.sort((a, b) => (a.origIdx ?? 0) - (b.origIdx ?? 0));
    return {
      orderedProjects: ordered,
      nextSnapshot: { mode: 'fixed', orderIds: ordered.map((p) => p.id), lastSortedAt: nowMs },
      didReorder: true,
      hasPendingDrift: false,
    };
  }

  if (sortMode === 'name') {
    const ordered = list.sort(
      (a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN') ||
        (a.origIdx ?? 0) - (b.origIdx ?? 0)
    );
    return {
      orderedProjects: ordered,
      nextSnapshot: { mode: 'name', orderIds: ordered.map((p) => p.id), lastSortedAt: nowMs },
      didReorder: true,
      hasPendingDrift: false,
    };
  }

  if (sortMode === 'usage') {
    const ordered = list.sort((a, b) => {
      const uA = Number(usageByProject?.[a.id]?.totalTokens || 0);
      const uB = Number(usageByProject?.[b.id]?.totalTokens || 0);
      if (uB !== uA) return uB - uA;
      return (a.origIdx ?? 0) - (b.origIdx ?? 0);
    });
    return {
      orderedProjects: ordered,
      nextSnapshot: { mode: 'usage', orderIds: ordered.map((p) => p.id), lastSortedAt: nowMs },
      didReorder: true,
      hasPendingDrift: false,
    };
  }

  // `recent` mode with anti-jump order snapshot
  const fresh = list.sort((a, b) => {
    const ta = a.chats?.[0]?.updatedAt || 0;
    const tb = b.chats?.[0]?.updatedAt || 0;
    if (tb !== ta) return tb - ta;
    return (a.origIdx ?? 0) - (b.origIdx ?? 0);
  });
  const freshIds = fresh.map((p) => p.id);
  const prevIds = Array.isArray(snapshot?.orderIds) ? snapshot.orderIds : [];
  const prevSet = new Set(prevIds);
  const sameSet =
    snapshot?.mode === 'recent' &&
    prevIds.length === freshIds.length &&
    freshIds.every((id) => prevSet.has(id));
  const cooldownExpired =
    cooldownSec > 0 &&
    Number.isFinite(snapshot?.lastSortedAt) &&
    nowMs - snapshot.lastSortedAt >= cooldownSec * 1000;

  if (forceRefresh || !sameSet || cooldownExpired) {
    return {
      orderedProjects: fresh,
      nextSnapshot: { mode: 'recent', orderIds: freshIds, lastSortedAt: nowMs },
      didReorder: true,
      hasPendingDrift: false,
    };
  }

  const byId = new Map(fresh.map((p) => [p.id, p]));
  const locked = prevIds.map((id) => byId.get(id)).filter(Boolean);
  const hasPendingDrift = freshIds.join(',') !== prevIds.join(',');
  return {
    orderedProjects: locked,
    nextSnapshot: snapshot,
    didReorder: false,
    hasPendingDrift,
  };
}

function hasIndexKey(idxCol, id) {
  if (!idxCol || !id) return false;
  if (typeof idxCol.has === 'function') return idxCol.has(id);
  if (Array.isArray(idxCol)) return idxCol.includes(id);
  if (typeof idxCol === 'object') return Object.prototype.hasOwnProperty.call(idxCol, id);
  return false;
}

export function createSidebarProjectsModule(rt) {
  const { FEAT, L, docRoot, state: rtState, escapeHtml, frame, hooks } = rt;

  let lastSig = '';
  let lastDragEndTs = 0;
  let renamingId = '';
  let standaloneLimit = DEFAULT_STANDALONE_LIMIT;
  let itemsById = new Map();
  let seededNativeCollapsed = false;
  let sortSnapshot = null;
  let forceSortRefresh = false;
  let sortMenuOpen = false;
  let sortMenuDocBound = false;
  let sidebarUsageMap = Object.create(null);
  let usageFetchedAt = 0;
  let usageFetchSig = '';
  let usageInFlightSig = '';
  const expandedProjectIds = new Set();

  function loadJsonSet(key, fallback) {
    try {
      const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(key) : null;
      if (!raw) return new Set(fallback);
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set(fallback);
    } catch {
      return new Set(fallback);
    }
  }

  function saveJsonSet(key, set) {
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.setItem(key, JSON.stringify(Array.from(set)));
      }
    } catch {}
  }

  const collapsedProjects = loadJsonSet(COLLAPSED_PROJS_KEY, []);
  const collapsedSections = loadJsonSet(COLLAPSED_SECS_KEY, []);

  function readCapPrefs() {
    const attrOn = docRoot?.getAttribute?.('data-agy-sb-cap');
    const enabled = attrOn !== '0';
    const rawPer = docRoot?.getAttribute?.('data-agy-sb-cap-per');
    const rawTot = docRoot?.getAttribute?.('data-agy-sb-cap-total');
    const maxPerProject = rawPer !== null && rawPer !== '' && Number.isFinite(Number(rawPer))
      ? Math.max(0, Math.round(Number(rawPer)))
      : DEFAULT_MAX_PER_PROJECT;
    const maxTotal = rawTot !== null && rawTot !== '' && Number.isFinite(Number(rawTot))
      ? Math.max(0, Math.round(Number(rawTot)))
      : DEFAULT_MAX_TOTAL;
    return { enabled, maxPerProject, maxTotal };
  }

  function readSortPrefs() {
    let localParsed = null;
    try {
      const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(SORT_PREFS_KEY) : null;
      if (raw) localParsed = JSON.parse(raw);
    } catch {}

    const attrMode = docRoot?.getAttribute?.('data-agy-sb-sort');
    const attrCd = docRoot?.getAttribute?.('data-agy-sb-sort-cd');
    const sortMode = VALID_SORT_MODES.has(attrMode)
      ? attrMode
      : VALID_SORT_MODES.has(localParsed?.sortMode)
        ? localParsed.sortMode
        : DEFAULT_SORT_MODE;

    const parseCd = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) && VALID_SORT_COOLDOWNS.has(Math.round(n)) ? Math.round(n) : null;
    };
    const cooldownSec = parseCd(attrCd) ?? parseCd(localParsed?.cooldownSec) ?? DEFAULT_SORT_COOLDOWN_SEC;
    return { sortMode, cooldownSec };
  }

  function persistLocalSortPrefs(sortMode, cooldownSec) {
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.setItem(SORT_PREFS_KEY, JSON.stringify({ sortMode, cooldownSec }));
      }
    } catch {}
    if (docRoot) {
      docRoot.setAttribute('data-agy-sb-sort', sortMode);
      docRoot.setAttribute('data-agy-sb-sort-cd', String(cooldownSec));
    }
  }

  function applySortPrefUpdate({ sortMode, cooldownSec } = {}) {
    const cur = readSortPrefs();
    const nextMode = VALID_SORT_MODES.has(sortMode) ? sortMode : cur.sortMode;
    const nextCd = VALID_SORT_COOLDOWNS.has(cooldownSec) ? cooldownSec : cur.cooldownSec;
    persistLocalSortPrefs(nextMode, nextCd);
    try {
      if (typeof window === 'object' && window.__agyStudioPrefs && typeof window.__agyStudioPrefs.patch === 'function') {
        window.__agyStudioPrefs.patch({
          sidebarProjectSortMode: nextMode,
          sidebarProjectSortCooldownSec: nextCd,
        });
      }
    } catch {}
    forceSortRefresh = true;
    lastSig = '';
    if (sortMenuOpen) renderSortMenu();
    hooks.scheduleSidebarSync?.();
  }

  function isCapActive() {
    return !FEAT.hideSidebarProjects && readCapPrefs().enabled;
  }

  function hasNativeVirtualizedSidebar(scrollBox) {
    const list = scrollBox && scrollBox.firstElementChild;
    if (!list) return false;
    if (list.dataset?.agCutIdx !== undefined) return true;
    const KEPT_RE = /^(pinned|置顶对话|coordinators|协调器|编排器)$/i;
    for (const child of list.children || []) {
      if (child.getAttribute?.('data-index') === null || !child.hasAttribute?.('data-index')) continue;
      if (child.querySelector?.('[data-testid="sidebar-add-project-button"]')) return true;
      const sh = child.querySelector?.('[data-testid="section-header"]');
      if (sh) {
        const isKept = Boolean(
          sh.querySelector?.('[data-testid="pinned-section-header"], [data-testid="coordinator-section-header"]') ||
            KEPT_RE.test(String(sh.getAttribute?.('data-title') || '').trim()) ||
            KEPT_RE.test(String(sh.textContent || '').trim())
        );
        if (!isKept) return true;
      }
    }
    return false;
  }

  function seedCollapsedFromNative(sidebar) {
    if (seededNativeCollapsed || !sidebar) return;
    const headers = sidebar.querySelectorAll?.('button[data-testid="project-header"]');
    if (!headers || !headers.length) return;
    seededNativeCollapsed = true;
    let changed = false;
    for (const hdr of headers) {
      const drop = hdr.closest?.('[data-sidebar-section-drop-id]');
      const pid = drop?.getAttribute?.('data-sidebar-section-drop-id');
      if (pid && hdr.getAttribute?.('aria-expanded') === 'false' && !collapsedProjects.has(pid)) {
        collapsedProjects.add(pid);
        changed = true;
      }
    }
    if (changed) saveJsonSet(COLLAPSED_PROJS_KEY, collapsedProjects);
  }

  function closeSortMenu() {
    sortMenuOpen = false;
    if (typeof document !== 'undefined') {
      const menu = document.getElementById('ag-sbp-sort-menu');
      if (menu) menu.remove();
      const btn = document.querySelector('#ag-claude-sidebar-projects [data-ag-sbp-sort-toggle]');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
    if (sortMenuDocBound && typeof document !== 'undefined') {
      document.removeEventListener('mousedown', onSortMenuDocDown, true);
      document.removeEventListener('keydown', onSortMenuDocKey, true);
      if (typeof window !== 'undefined') window.removeEventListener('resize', closeSortMenu);
      sortMenuDocBound = false;
    }
  }

  function onSortMenuDocDown(ev) {
    const t = ev && ev.target;
    if (t && t.closest && t.closest('#ag-sbp-sort-menu, [data-ag-sbp-sort-toggle]')) return;
    closeSortMenu();
  }

  function onSortMenuDocKey(ev) {
    if (ev && ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeSortMenu();
    }
  }

  function renderSortMenu(anchorBtn = null) {
    if (typeof document === 'undefined' || !document.body) return;
    const trigger = anchorBtn || document.querySelector('#ag-claude-sidebar-projects [data-ag-sbp-sort-toggle]');
    if (!trigger) {
      closeSortMenu();
      return;
    }
    let menu = document.getElementById('ag-sbp-sort-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'ag-sbp-sort-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-maga-own', '1');
      menu.setAttribute('data-ag-i18n-ignore', '1');
      menu.addEventListener('click', (ev) => {
        const modeBtn = ev.target?.closest?.('[data-ag-sbp-sort-mode]');
        if (modeBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const nextMode = modeBtn.getAttribute('data-ag-sbp-sort-mode');
          applySortPrefUpdate({ sortMode: nextMode });
          closeSortMenu();
          return;
        }
        const cdBtn = ev.target?.closest?.('[data-ag-sbp-sort-cd]');
        if (cdBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const nextCd = Number(cdBtn.getAttribute('data-ag-sbp-sort-cd'));
          if (VALID_SORT_COOLDOWNS.has(nextCd)) {
            applySortPrefUpdate({ cooldownSec: nextCd });
          }
          return;
        }
        const refreshNow = ev.target?.closest?.('[data-ag-sbp-menu-refresh]');
        if (refreshNow) {
          ev.preventDefault();
          ev.stopPropagation();
          forceSortRefresh = true;
          usageFetchedAt = 0;
          lastSig = '';
          closeSortMenu();
          hooks.scheduleSidebarSync?.();
        }
      });
      document.body.appendChild(menu);
    }

    const { sortMode, cooldownSec } = readSortPrefs();
    const modeOpts = [
      ['recent', L('最近活跃', 'Recent activity')],
      ['fixed', L('固定顺序', 'Fixed order')],
      ['name', L('按名称 (A–Z)', 'Name (A–Z)')],
      ['usage', L('按用量 (Token)', 'Token usage')],
    ];
    const itemsHtml = modeOpts
      .map(([val, lbl]) => {
        const active = sortMode === val;
        return `<button type="button" class="ag-sbp-sm-item" role="menuitemradio" aria-checked="${active ? 'true' : 'false'}" data-ag-sbp-sort-mode="${val}"><span>${escapeHtml(lbl)}</span><span class="ag-sbp-sm-check" aria-hidden="true">${active ? '✓' : ''}</span></button>`;
      })
      .join('');

    const cdHtml =
      sortMode === 'recent'
        ? `<div class="ag-sbp-sm-sep"></div>` +
          `<div class="ag-sbp-sm-cd-wrap">` +
          `<div class="ag-sbp-sm-cd-hdr"><span>${escapeHtml(L('重排冷却', 'Reorder cooldown'))}</span><button type="button" class="ag-sbp-sm-now" data-ag-sbp-menu-refresh="1">${escapeHtml(L('立即重排', 'Refresh'))}</button></div>` +
          `<div class="ag-sbp-sm-cd-pills">${[
            [60, '1m'],
            [300, '5m'],
            [0, L('仅手动', 'Manual')],
          ]
            .map(
              ([val, lbl]) =>
                `<button type="button" class="ag-sbp-sm-cd-pill" data-active="${cooldownSec === val ? 'true' : 'false'}" data-ag-sbp-sort-cd="${val}">${escapeHtml(lbl)}</button>`
            )
            .join('')}</div></div>`
        : '';

    menu.innerHTML = `<div class="ag-sbp-sm-hdr">${escapeHtml(L('项目排序', 'Sort Projects'))}</div>${itemsHtml}${cdHtml}`;

    const r = trigger.getBoundingClientRect ? trigger.getBoundingClientRect() : { left: 16, right: 180, bottom: 40 };
    const menuW = 196;
    const menuH = Math.max(132, menu.offsetHeight || 168);
    const vw = typeof window !== 'undefined' ? window.innerWidth || 1200 : 1200;
    const vh = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
    const left = Math.min(Math.max(8, (r.right || 180) - menuW), Math.max(8, vw - menuW - 8));
    const top = (r.bottom || 40) + 4 + menuH > vh - 8 ? Math.max(8, (r.top || 40) - menuH - 4) : Math.max(8, (r.bottom || 40) + 4);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    trigger.setAttribute('aria-expanded', 'true');

    if (!sortMenuDocBound) {
      document.addEventListener('mousedown', onSortMenuDocDown, true);
      document.addEventListener('keydown', onSortMenuDocKey, true);
      if (typeof window !== 'undefined') window.addEventListener('resize', closeSortMenu);
      sortMenuDocBound = true;
    }
  }

  function toggleSortMenu(btn) {
    if (sortMenuOpen) {
      closeSortMenu();
    } else {
      sortMenuOpen = true;
      renderSortMenu(btn);
    }
  }

  function ensureSidebarUsageIfNeeded(projects, force = false) {
    if (typeof window === 'undefined' || typeof window.__agProjectCall !== 'function') return;
    const projectGroups = {};
    const sigParts = [];
    let hasIds = false;
    for (const p of projects || []) {
      const ids = Array.isArray(p?.chats) ? p.chats.map((c) => c.id).filter(Boolean) : [];
      projectGroups[p.id] = ids;
      sigParts.push(`${p.id}:${ids.join(',')}`);
      if (ids.length > 0) hasIds = true;
    }
    if (!hasIds) return;
    sigParts.sort();
    const sig = sigParts.join('|');
    const now = Date.now();
    if (!force && sig === usageFetchSig && now - usageFetchedAt < USAGE_CACHE_TTL_MS) return;
    if (usageInFlightSig === sig) return;
    usageInFlightSig = sig;
    const activeId = hooks.getActiveCascadeId?.() || '';
    Promise.resolve(window.__agProjectCall('getUsageStats', { projectGroups, activeId, force }, 12000))
      .then((res) => {
        if (rtState.disposed || !res || !res.ok || !res.byProject) return;
        Object.assign(sidebarUsageMap, res.byProject);
        usageFetchSig = sig;
        usageFetchedAt = Date.now();
        lastSig = '';
        hooks.scheduleSidebarSync?.();
      })
      .catch(() => {})
      .finally(() => {
        if (usageInFlightSig === sig) usageInFlightSig = '';
      });
  }

  function remove() {
    closeSortMenu();
    hooks.closeRecentRowMenu?.('sbp');
    renamingId = '';
    const el = typeof document !== 'undefined' ? document.getElementById('ag-claude-sidebar-projects') : null;
    if (el) el.remove();
    lastSig = '';
    sortSnapshot = null;
    itemsById.clear();
  }

  function startInlineRename(id) {
    if (!id) return;
    hooks.closeRecentRowMenu?.();
    renamingId = id;
    lastSig = '';
    hooks.syncSidebarEnhancements?.();
    frame?.(() => {
      const input =
        typeof document !== 'undefined'
          ? document.querySelector('#ag-claude-sidebar-projects [data-ag-sbp-rename-input]')
          : null;
      if (input) {
        input.focus();
        try {
          input.select();
        } catch {}
      }
    });
  }

  function commitInlineRename(input, commit) {
    if (!input || !renamingId || input.dataset?.agSbpCommitted === '1') return;
    if (input.dataset) input.dataset.agSbpCommitted = '1';
    const id = input.getAttribute('data-ag-sbp-rename-input') || renamingId;
    const orig = input.getAttribute('data-orig-title') || '';
    const nextVal = String(input.value || '').trim();
    renamingId = '';
    lastSig = '';
    if (commit && id && nextVal && nextVal !== orig) {
      hooks.mutateRecentConversationAnnotation?.(id, { title: nextVal }, hooks.findSidebarBindings?.());
    }
    hooks.syncSidebarEnhancements?.();
    hooks.scheduleSidebarSync?.();
  }

  function collectSectionsData(bindings, state, activeId, hasFocus) {
    const rawProjects = (state && state.sidebarProjects && state.sidebarProjects.projects) || [];
    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const indexes = (state && state.trajectorySummaries && state.trajectorySummaries.indexes) || {};
    const byProject = indexes.byProject || {};
    const idxCoord = indexes.coordinator;

    const projectMap = new Map();
    const projects = [];
    const folderToProjId = new Map();
    const decodePath = (u) => {
      if (hooks.decodeFileUriToPath) return hooks.decodeFileUriToPath(u);
      const s = String(u || '').trim();
      if (!s) return '';
      if (!/^file:\/\//i.test(s)) return s;
      try {
        return decodeURIComponent(new URL(s).pathname).replace(/^\/([A-Za-z]:)/, '$1');
      } catch {
        return '';
      }
    };

    rawProjects.forEach((p, idx) => {
      if (!p || !p.id || p.archived) return;
      const rawName = String(p.name || '').trim();
      if (!rawName || rawName === 'swarm/swarm_board' || p.id === 'outside-of-project') return;
      const isCli = p.id === 'default-cli-project';
      const label = isCli ? L('CLI 项目', 'CLI Project') : (bindings.projectLabels?.get(p.id) || rawName);
      const uris = Array.isArray(p.folderUris) ? p.folderUris : [];
      for (const u of uris) {
        const norm = decodePath(u).replace(/[\\/]+$/, '').toLowerCase();
        if (norm && !folderToProjId.has(norm)) folderToProjId.set(norm, p.id);
      }
      const entry = {
        id: p.id,
        name: label,
        origIdx: idx,
        collapsed: collapsedProjects.has(p.id),
        expandedOverride: expandedProjectIds.has(p.id),
        chats: [],
      };
      projectMap.set(p.id, entry);
      projects.push(entry);
    });

    const cidToByProj = new Map();
    for (const [pid, rawIds] of Object.entries(byProject)) {
      if (!projectMap.has(pid) || !rawIds) continue;
      const arr =
        typeof rawIds[Symbol.iterator] === 'function'
          ? Array.from(rawIds)
          : typeof rawIds === 'object'
            ? Object.keys(rawIds)
            : [];
      for (const cid of arr) {
        if (cid && !cidToByProj.has(cid)) cidToByProj.set(cid, pid);
      }
    }

    const standaloneChats = [];
    const protoSec = (ts) => (hooks.protoSeconds ? hooks.protoSeconds(ts) : Number(ts?.seconds ?? ts ?? 0) || 0);

    for (const [cid, summary] of Object.entries(summaries)) {
      if (!summary || !hooks.isSidebarVisibleSummary?.(cid, summary, state)) continue;
      if (hooks.isSummaryPinned?.(cid, summary, state)) continue;

      const status = hooks.classifySidebarConversation?.(cid, summary, state, activeId, hasFocus) || null;
      const rawTitle = (summary.annotations && summary.annotations.title) || summary.summary;
      const isLiveOrActiveUntitled =
        !rawTitle &&
        (cid === activeId ||
          (status && (status.kind === 'running' || status.kind === 'pending')) ||
          Number(summary.stepCount || 0) > 0);
      if (!rawTitle && !isLiveOrActiveUntitled) continue;

      const title = rawTitle ? String(rawTitle) : L('新对话', 'New conversation');
      const updatedAt = Math.max(protoSec(summary.lastModifiedTime), protoSec(summary.createdTime));

      const meta = summary.trajectoryMetadata || {};
      let ownerPid = String(meta.projectId || summary.projectId || '');
      if (!projectMap.has(ownerPid)) ownerPid = cidToByProj.get(cid) || '';
      if (!ownerPid && folderToProjId.size) {
        const wsList = (summary.workspaces || []).concat(meta.workspaces || []);
        for (const ws of wsList) {
          const rawUri = ws && (ws.workspaceFolderAbsoluteUri || ws.uri || ws);
          const norm = rawUri ? decodePath(rawUri).replace(/[\\/]+$/, '').toLowerCase() : '';
          if (norm && folderToProjId.has(norm)) {
            ownerPid = folderToProjId.get(norm);
            break;
          }
        }
      }

      const item = {
        id: cid,
        title,
        projectId: projectMap.has(ownerPid) ? ownerPid : '',
        project: projectMap.has(ownerPid) ? projectMap.get(ownerPid).name : '',
        updatedAt,
        status,
      };

      if (item.projectId) {
        projectMap.get(item.projectId).chats.push(item);
      } else if (!hasIndexKey(idxCoord, cid)) {
        standaloneChats.push(item);
      }
    }

    for (const proj of projects) {
      proj.chats.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    standaloneChats.sort((a, b) => b.updatedAt - a.updatedAt);

    return { projects, standaloneChats };
  }

  function renderSideHtml(item, nowSec) {
    const age = hooks.formatRelativeAge ? hooks.formatRelativeAge(item.updatedAt, nowSec) : '';
    if (item.status && item.status.kind === 'pending') {
      const svg = hooks.pendingGlyphSvg ? hooks.pendingGlyphSvg(item.status.subkind) : '!';
      return `<span class="ag-claude-folder-badge" data-kind="pending">${svg}</span>`;
    }
    if (item.status && item.status.kind === 'running') {
      return hooks.renderRunningGlyphHtml
        ? hooks.renderRunningGlyphHtml(item.status.subkind)
        : renderRunningGlyphHtml(item.status.subkind);
    }
    if (item.status && item.status.kind === 'unread') {
      return `<span class="ag-claude-unread-dot"></span>${age ? `<span>${escapeHtml(age)}</span>` : ''}`;
    }
    return age ? `<span>${escapeHtml(age)}</span>` : '';
  }

  function renderCollapsedProjBadgesHtml(chats) {
    const counts = { pending: 0, running: 0, unread: 0, subkind: null };
    const runSubkinds = [];
    for (const c of chats) {
      const k = c.status?.kind;
      if (k === 'pending') {
        counts.pending += 1;
        if (!counts.subkind) counts.subkind = c.status.subkind;
      } else if (k === 'running') {
        counts.running += 1;
        runSubkinds.push(c.status.subkind || 'orbit');
      } else if (k === 'unread') {
        counts.unread += 1;
      }
    }
    const parts = [];
    if (counts.pending > 0) {
      const svg = hooks.pendingGlyphSvg ? hooks.pendingGlyphSvg(counts.subkind) : '!';
      parts.push(`<span class="ag-claude-folder-badge" data-kind="pending">${svg}<span>${counts.pending}</span></span>`);
    }
    if (counts.running > 0) {
      const domSub = (hooks.pickDominantRunningSubkind || pickDominantRunningSubkind)(runSubkinds);
      const glyph = (hooks.renderRunningGlyphHtml || renderRunningGlyphHtml)(domSub);
      parts.push(`<span class="ag-claude-folder-badge" data-kind="running" data-subkind="${escapeHtml(domSub)}">${glyph}<span>${counts.running}</span></span>`);
    }
    if (counts.unread > 0 && parts.length < 2) {
      parts.push(`<span class="ag-claude-folder-badge" data-kind="unread"><span class="ag-claude-unread-dot"></span><span>${counts.unread}</span></span>`);
    }
    return parts.slice(0, 2).join('');
  }

  function buildCollapsedProjHeaderTitle(p) {
    const base = `${p.name} (${p.chats.length})`;
    if (!p.collapsed) return base;
    const runningItems = [];
    let pendingCount = 0;
    for (const c of p.chats) {
      if (c.status?.kind === 'running') {
        runningItems.push({ subkind: c.status.subkind || 'orbit', detail: c.status.detail || '', title: c.title });
      } else if (c.status?.kind === 'pending') {
        pendingCount += 1;
      }
    }
    if (!runningItems.length && !pendingCount) return base;
    const runTip = runningItems.length
      ? (hooks.formatRunningBreakdownTooltip || formatRunningBreakdownTooltip)(runningItems, L)
      : '';
    const parts = [base];
    if (pendingCount > 0) parts.push(L(`${pendingCount} 个待确认`, `${pendingCount} pending`));
    if (runTip) parts.push(runTip);
    return parts.join('\n');
  }

  function renderRowHtml(it, activeId, nowSec, indented) {
    const isAct = it.id === activeId;
    const isRenaming = Boolean(renamingId && renamingId === it.id);
    const wtBranch = hooks.getConversationBranchBadge?.(it.id) || '';
    const sideHtml = renderSideHtml(it, nowSec);
    const tipParts = [it.title];
    if (it.status && it.status.kind === 'running') {
      tipParts.push((hooks.formatRunningStatusTooltip || formatRunningStatusTooltip)(it.status, L));
    }
    if (it.project) tipParts.push(`${L('所属项目：', 'Project: ')}${it.project}`);
    if (wtBranch) tipParts.push(`Worktree: ${wtBranch}`);
    const pinSvg = hooks.RECENT_PIN_SVG || '';
    const moreSvg = hooks.RECENT_MORE_SVG || '⋯';
    const mainInner = isRenaming
      ? `<input type="text" class="ag-sbp-rename-input" data-ag-sbp-rename-input="${escapeHtml(it.id)}" data-orig-title="${escapeHtml(it.title)}" value="${escapeHtml(it.title)}" />`
      : `<div class="ag-sbp-title">${escapeHtml(it.title)}</div>`;
    const tailHtml = isRenaming
      ? ''
      : `<div class="ag-sbp-side">${sideHtml}</div>` +
        `<div class="ag-sbp-actions">` +
        `<button type="button" class="ag-sbp-act-btn" data-ag-sbp-pin="${escapeHtml(it.id)}" title="${escapeHtml(L('置顶对话', 'Pin'))}" aria-label="${escapeHtml(L('置顶对话', 'Pin'))}">${pinSvg}</button>` +
        `<button type="button" class="ag-sbp-act-btn" data-ag-sbp-menu="${escapeHtml(it.id)}" title="${escapeHtml(L('更多选项', 'More options'))}" aria-label="${escapeHtml(L('更多选项', 'More options'))}">${moreSvg}</button>` +
        `</div>`;
    return (
      `<div class="ag-sbp-row${indented ? ' is-indented' : ''}" role="button" tabindex="0"${isRenaming ? '' : ' draggable="true"'}` +
      ` data-ag-sbp-id="${escapeHtml(it.id)}" data-ag-sbp-title="${escapeHtml(it.title)}"` +
      ` data-active="${isAct ? 'true' : 'false'}"${isRenaming ? ' data-renaming="true"' : ''} title="${escapeHtml(tipParts.join('\n'))}">` +
      `<div class="ag-sbp-main">${mainInner}</div>${tailHtml}</div>`
    );
  }

  function sync(bindings, state, activeId, hasFocus) {
    if (rtState.disposed || !bindings || !isCapActive()) {
      remove();
      return false;
    }
    const { host: sbParent, container: sbGrand } = hooks.getSidebarListHost?.(bindings.sidebar) || {};
    if (!sbParent || !sbGrand) {
      remove();
      return false;
    }
    if (!hasNativeVirtualizedSidebar(bindings.sidebar)) {
      remove();
      return false;
    }
    seedCollapsedFromNative(bindings.sidebar);

    const existingSec = typeof document !== 'undefined' ? document.getElementById('ag-claude-sidebar-projects') : null;
    if (renamingId && existingSec && existingSec.querySelector('[data-ag-sbp-rename-input]')) {
      return true;
    }

    const { maxPerProject, maxTotal } = readCapPrefs();
    const { sortMode, cooldownSec } = readSortPrefs();
    const { projects: rawProjects, standaloneChats } = collectSectionsData(bindings, state, activeId, hasFocus);
    if (!rawProjects.length && !standaloneChats.length) {
      remove();
      return false;
    }

    if (sortMode === 'usage') {
      ensureSidebarUsageIfNeeded(rawProjects, forceSortRefresh);
    }

    const orderRes = resolveSidebarProjectOrder(rawProjects, sortSnapshot, {
      sortMode,
      cooldownSec,
      usageByProject: sidebarUsageMap,
      nowMs: Date.now(),
      forceRefresh: forceSortRefresh,
    });
    sortSnapshot = orderRes.nextSnapshot;
    forceSortRefresh = false;

    const allocated = computeSidebarProjectAllocation(orderRes.orderedProjects, {
      maxPerProject,
      maxTotal,
      activeId,
    });
    const standaloneShown = standaloneChats.slice(0, standaloneLimit);

    itemsById = new Map();
    for (const p of allocated.items) {
      for (const c of p.chats) itemsById.set(c.id, c);
    }
    for (const c of standaloneChats) itemsById.set(c.id, c);

    const nowBucket = Math.floor(Date.now() / 30000);
    const nowSec = Math.floor(Date.now() / 1000);
    const projSecCollapsed = collapsedSections.has('projects');
    const convSecCollapsed = collapsedSections.has('conversations');

    const sig = [
      FEAT.i18n ? 1 : 0,
      maxPerProject,
      maxTotal,
      sortMode,
      cooldownSec,
      orderRes.hasPendingDrift ? 1 : 0,
      projSecCollapsed ? 1 : 0,
      convSecCollapsed ? 1 : 0,
      standaloneLimit,
      renamingId,
      activeId,
      nowBucket,
      allocated.items
        .map((p) =>
          `${p.id}:${p.name}:${p.collapsed ? 1 : 0}:${p.expandedOverride ? 1 : 0}:${p.hiddenCount}:${p.visibleChats
            .map((c) => `${c.id}:${c.title}:${hooks.getConversationBranchBadge?.(c.id) || ''}:${c.status ? `${c.status.kind}-${c.status.subkind}-${c.status.detail || ''}` : 'idle'}:${Math.floor(c.updatedAt / 60)}`)
            .join(',')}`
        )
        .join('|'),
      `${standaloneChats.length}:${standaloneShown
        .map((c) => `${c.id}:${c.title}:${hooks.getConversationBranchBadge?.(c.id) || ''}:${c.status ? `${c.status.kind}-${c.status.subkind}-${c.status.detail || ''}` : 'idle'}:${Math.floor(c.updatedAt / 60)}`)
        .join(',')}`,
    ].join('||');

    let sec = document.getElementById('ag-claude-sidebar-projects');
    const wrongParent = !sec || sec.parentElement !== sbGrand;
    const wrongPosition = sec && sec.parentElement === sbGrand && sec.previousSibling !== sbParent;

    if (wrongParent) {
      if (sec) sec.remove();
      sec = document.createElement('section');
      sec.id = 'ag-claude-sidebar-projects';
      sec.setAttribute('data-maga-own', '1');
      sec.setAttribute('data-ag-i18n-ignore', '1');
      sec.setAttribute('aria-label', L('项目与对话', 'Projects & Conversations'));
      sec.addEventListener('click', (ev) => {
        const t = ev.target;
        if (!t || !t.closest) return;

        const secToggle = t.closest('[data-ag-sbp-sec-toggle]');
        if (secToggle) {
          ev.preventDefault();
          ev.stopPropagation();
          const secKey = secToggle.getAttribute('data-ag-sbp-sec-toggle');
          if (collapsedSections.has(secKey)) collapsedSections.delete(secKey);
          else collapsedSections.add(secKey);
          saveJsonSet(COLLAPSED_SECS_KEY, collapsedSections);
          lastSig = '';
          hooks.scheduleSidebarSync?.();
          return;
        }

        const sortRefreshBtn = t.closest('[data-ag-sbp-sort-refresh]');
        if (sortRefreshBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          closeSortMenu();
          forceSortRefresh = true;
          usageFetchedAt = 0;
          lastSig = '';
          hooks.scheduleSidebarSync?.();
          return;
        }

        const sortToggleBtn = t.closest('[data-ag-sbp-sort-toggle]');
        if (sortToggleBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          hooks.closeRecentRowMenu?.();
          toggleSortMenu(sortToggleBtn);
          return;
        }

        const newProjBtn = t.closest('[data-ag-sbp-new-proj]');
        if (newProjBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          closeSortMenu();
          hooks.closeRecentRowMenu?.();
          hooks.triggerNativeNewProject?.();
          return;
        }

        const newConvBtn = t.closest('[data-ag-sbp-new-chat]');
        if (newConvBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          closeSortMenu();
          hooks.closeRecentRowMenu?.();
          if (rtState.projectsViewOpen) hooks.closeProjectsView?.();
          hooks.triggerNewConversationFromSidebar?.(hooks.findSidebarBindings?.() || bindings);
          return;
        }

        const newInProjBtn = t.closest('[data-ag-sbp-proj-new]');
        if (newInProjBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const pid = newInProjBtn.getAttribute('data-ag-sbp-proj-new');
          hooks.closeRecentRowMenu?.();
          if (pid) hooks.startNewChatInProjectById?.(pid);
          return;
        }

        const openCockpitBtn = t.closest('[data-ag-sbp-proj-open]');
        if (openCockpitBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const pid = openCockpitBtn.getAttribute('data-ag-sbp-proj-open');
          hooks.closeRecentRowMenu?.();
          if (pid && FEAT.projects) hooks.openProjectsView?.(pid);
          return;
        }

        const projHdr = t.closest('[data-ag-sbp-proj-toggle]');
        if (projHdr) {
          ev.preventDefault();
          ev.stopPropagation();
          const pid = projHdr.getAttribute('data-ag-sbp-proj-toggle');
          if (pid) {
            if (collapsedProjects.has(pid)) collapsedProjects.delete(pid);
            else collapsedProjects.add(pid);
            saveJsonSet(COLLAPSED_PROJS_KEY, collapsedProjects);
            lastSig = '';
            hooks.scheduleSidebarSync?.();
          }
          return;
        }

        const moreProj = t.closest('[data-ag-sbp-more-proj]');
        if (moreProj) {
          ev.preventDefault();
          ev.stopPropagation();
          const pid = moreProj.getAttribute('data-ag-sbp-more-proj');
          if (pid) {
            expandedProjectIds.add(pid);
            lastSig = '';
            hooks.scheduleSidebarSync?.();
          }
          return;
        }

        const lessProj = t.closest('[data-ag-sbp-less-proj]');
        if (lessProj) {
          ev.preventDefault();
          ev.stopPropagation();
          const pid = lessProj.getAttribute('data-ag-sbp-less-proj');
          if (pid) {
            expandedProjectIds.delete(pid);
            lastSig = '';
            hooks.scheduleSidebarSync?.();
          }
          return;
        }

        const moreStandalone = t.closest('[data-ag-sbp-more-chats]');
        if (moreStandalone) {
          ev.preventDefault();
          ev.stopPropagation();
          standaloneLimit += 20;
          lastSig = '';
          hooks.scheduleSidebarSync?.();
          return;
        }

        const pinBtn = t.closest('[data-ag-sbp-pin]');
        if (pinBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          hooks.closeRecentRowMenu?.();
          const cid = pinBtn.getAttribute('data-ag-sbp-pin');
          hooks.mutateRecentConversationAnnotation?.(cid, { pinned: true }, hooks.findSidebarBindings?.() || bindings);
          return;
        }

        const menuBtn = t.closest('[data-ag-sbp-menu]');
        if (menuBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          closeSortMenu();
          const cid = menuBtn.getAttribute('data-ag-sbp-menu');
          const item = itemsById.get(cid);
          const r = menuBtn.getBoundingClientRect();
          if (item) hooks.openRecentRowMenu?.(item, r.right + 4, r.bottom + 4, 'sbp');
          return;
        }

        if (t.closest('[data-ag-sbp-rename-input]')) {
          ev.stopPropagation();
          return;
        }

        const row = t.closest('[data-ag-sbp-id]');
        if (row) {
          if (Date.now() - lastDragEndTs < 260) return;
          const cid = row.getAttribute('data-ag-sbp-id');
          if (renamingId && renamingId === cid) return;
          hooks.closeRecentRowMenu?.();
          if (rtState.projectsViewOpen) hooks.closeProjectsView?.();
          hooks.navigateSidebarConversation?.(cid, hooks.findSidebarBindings?.() || bindings);
          hooks.scheduleSidebarSync?.();
        }
      });

      sec.addEventListener('contextmenu', (ev) => {
        const row = ev.target?.closest?.('[data-ag-sbp-id]');
        if (!row) return;
        const cid = row.getAttribute('data-ag-sbp-id');
        if (renamingId && renamingId === cid) return;
        const item = itemsById.get(cid);
        if (!item) return;
        ev.preventDefault();
        ev.stopPropagation();
        closeSortMenu();
        hooks.openRecentRowMenu?.(item, ev.clientX + 2, ev.clientY + 2, 'sbp');
      });

      sec.addEventListener('dragstart', (ev) => {
        if (ev.target?.closest?.('[data-ag-sbp-pin], [data-ag-sbp-menu], [data-ag-sbp-rename-input]')) {
          ev.preventDefault();
          return;
        }
        const row = ev.target?.closest?.('[data-ag-sbp-id]');
        if (!row) return;
        const cid = row.getAttribute('data-ag-sbp-id');
        if (!cid || (renamingId && renamingId === cid)) {
          ev.preventDefault();
          return;
        }
        const item = itemsById.get(cid);
        const title = (item && item.title) || row.getAttribute('data-ag-sbp-title') || '';
        hooks.attachConversationDragTransfer?.(ev.dataTransfer, cid, title);
        row.setAttribute('data-dragging', 'true');
      });

      sec.addEventListener('dragend', (ev) => {
        lastDragEndTs = Date.now();
        const row = ev.target?.closest?.('[data-ag-sbp-id]');
        if (row) row.removeAttribute('data-dragging');
        sec.querySelectorAll('[data-dragging="true"]').forEach((n) => n.removeAttribute('data-dragging'));
      });

      sec.addEventListener('keydown', (ev) => {
        const input = ev.target?.closest?.('[data-ag-sbp-rename-input]');
        if (input) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            ev.stopPropagation();
            commitInlineRename(input, true);
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            commitInlineRename(input, false);
          }
          return;
        }
        const row = ev.target?.closest?.('[data-ag-sbp-id]');
        if (row && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          if (rtState.projectsViewOpen) hooks.closeProjectsView?.();
          const cid = row.getAttribute('data-ag-sbp-id');
          hooks.navigateSidebarConversation?.(cid, hooks.findSidebarBindings?.() || bindings);
          hooks.scheduleSidebarSync?.();
        }
      });

      sec.addEventListener(
        'blur',
        (ev) => {
          const input = ev.target?.closest?.('[data-ag-sbp-rename-input]');
          if (input) commitInlineRename(input, true);
        },
        true
      );

      sbGrand.insertBefore(sec, sbParent.nextSibling);
      lastSig = '';
    } else if (wrongPosition) {
      sbGrand.insertBefore(sec, sbParent.nextSibling);
      lastSig = '';
    }

    if (sig === lastSig) return true;
    lastSig = sig;

    const projCountHint =
      allocated.hiddenTotal > 0
        ? `<span class="ag-sbp-budget-pill" title="${escapeHtml(
            L(
              `项目区上限：单项目 ${maxPerProject || '∞'} · 合计 ${maxTotal || '∞'}（当前展示 ${allocated.totalVisible}/${allocated.totalChats}）`,
              `Sidebar cap: ${maxPerProject || '∞'}/project · ${maxTotal || '∞'} total (${allocated.totalVisible}/${allocated.totalChats} shown)`
            )
          )}">${allocated.totalVisible}/${allocated.totalChats}</span>`
        : '';

    const projectsBodyHtml = projSecCollapsed
      ? ''
      : allocated.items
          .map((p) => {
            const collapsedAttr = p.collapsed ? 'true' : 'false';
            const badgesHtml = p.collapsed && FEAT.folderStatus ? renderCollapsedProjBadgesHtml(p.chats) : '';
            const cockpitBtnHtml = FEAT.projects
              ? `<button type="button" class="ag-sbp-act-btn" data-ag-sbp-proj-open="${escapeHtml(p.id)}" title="${escapeHtml(L('在项目页打开', 'Open in Projects'))}" aria-label="${escapeHtml(L('在项目页打开', 'Open in Projects'))}">${SvgCockpit}</button>`
              : '';
            const hdrTitle = buildCollapsedProjHeaderTitle(p);
            const hdrHtml =
              `<div class="ag-sbp-proj-hdr-wrap" data-collapsed="${collapsedAttr}">` +
              `<button type="button" class="ag-sbp-proj-hdr" data-ag-sbp-proj-toggle="${escapeHtml(p.id)}" aria-expanded="${p.collapsed ? 'false' : 'true'}" title="${escapeHtml(hdrTitle)}">` +
              `<span class="ag-sbp-proj-chev">${SvgChev}</span>` +
              `<span class="ag-sbp-proj-ico">${SvgFolder}</span>` +
              `<span class="ag-sbp-proj-name">${escapeHtml(p.name)}</span>` +
              `</button>` +
              `${badgesHtml ? `<div class="ag-sbp-proj-badges" aria-hidden="true">${badgesHtml}</div>` : ''}` +
              `<div class="ag-sbp-proj-actions">` +
              `${cockpitBtnHtml}` +
              `<button type="button" class="ag-sbp-act-btn" data-ag-sbp-proj-new="${escapeHtml(p.id)}" title="${escapeHtml(L('在项目中新建对话', 'New chat in project'))}" aria-label="${escapeHtml(L('在项目中新建对话', 'New chat in project'))}">${SvgPlus}</button>` +
              `</div></div>`;

            let childrenHtml = '';
            if (!p.collapsed) {
              const rows = p.visibleChats.map((c) => renderRowHtml(c, activeId, nowSec, true)).join('');
              let footerToggle = '';
              if (p.hiddenCount > 0) {
                footerToggle = `<button type="button" class="ag-sbp-more-btn is-indented" data-ag-sbp-more-proj="${escapeHtml(p.id)}">${escapeHtml(
                  FEAT.i18n ? `展开余下 ${p.hiddenCount} 条` : `Show ${p.hiddenCount} more`
                )}</button>`;
              } else if (p.expandedOverride && p.chats.length > (maxPerProject || DEFAULT_MAX_PER_PROJECT)) {
                footerToggle = `<button type="button" class="ag-sbp-more-btn is-indented" data-ag-sbp-less-proj="${escapeHtml(p.id)}">${escapeHtml(
                  L('收起至精简视图', 'Show less')
                )}</button>`;
              }
              childrenHtml = rows || footerToggle ? `<div class="ag-sbp-proj-rows">${rows}${footerToggle}</div>` : '';
            }
            return `<div class="ag-sbp-proj-block" data-proj-id="${escapeHtml(p.id)}">${hdrHtml}${childrenHtml}</div>`;
          })
          .join('');

    const sortModeLabel =
      sortMode === 'fixed'
        ? L('固定顺序', 'Fixed')
        : sortMode === 'name'
          ? L('按名称', 'Name')
          : sortMode === 'usage'
            ? L('按用量', 'Usage')
            : L('最近活跃', 'Recent');
    const refreshTip =
      sortMode === 'usage'
        ? L('刷新项目用量排序', 'Refresh usage sort')
        : orderRes.hasPendingDrift
          ? L('有新的活跃项目 · 点击立即重排', 'Recent activity changed · Click to reorder now')
          : L('手动刷新项目排序', 'Refresh project order');
    const refreshBtnHtml =
      sortMode === 'recent' || sortMode === 'usage'
        ? `<button type="button" class="ag-sbp-sec-tool ag-sbp-refresh-btn" data-ag-sbp-sort-refresh="1" data-stale="${orderRes.hasPendingDrift ? '1' : '0'}" title="${escapeHtml(refreshTip)}" aria-label="${escapeHtml(refreshTip)}">${SvgRefresh}</button>`
        : '';
    const sortBtnHtml = `<button type="button" class="ag-sbp-sec-tool ag-sbp-sort-btn" data-ag-sbp-sort-toggle="1" data-sort-mode="${escapeHtml(sortMode)}" aria-haspopup="menu" aria-expanded="${sortMenuOpen ? 'true' : 'false'}" title="${escapeHtml(L(`排序方式：${sortModeLabel}`, `Sort: ${sortModeLabel}`))}" aria-label="${escapeHtml(L('切换项目排序方式', 'Sort projects'))}">${SvgSort}</button>`;

    const projectsSecHtml = allocated.items.length
      ? `<div class="ag-sbp-section" data-section="projects" data-collapsed="${projSecCollapsed ? '1' : '0'}">` +
        `<div class="ag-sbp-sec-hdr-bar">` +
        `<button type="button" class="ag-sbp-sec-hdr" data-ag-sbp-sec-toggle="projects" aria-expanded="${!projSecCollapsed}">` +
        `<span>${escapeHtml(L('项目', 'Projects'))}</span>${projCountHint}<span class="ag-sbp-sec-chev">${SvgChev}</span>` +
        `</button>` +
        `<div class="ag-sbp-sec-tools">${refreshBtnHtml}${sortBtnHtml}` +
        `<button type="button" class="ag-sbp-sec-add" data-ag-sbp-new-proj="1" title="${escapeHtml(L('新建项目', 'New project'))}" aria-label="${escapeHtml(L('新建项目', 'New project'))}">${SvgPlus}</button>` +
        `</div></div>` +
        `<div class="ag-sbp-proj-list">${projectsBodyHtml}</div></div>`
      : '';

    const standaloneMoreHtml =
      !convSecCollapsed && standaloneChats.length > standaloneShown.length
        ? `<button type="button" class="ag-sbp-more-btn" data-ag-sbp-more-chats="1">${escapeHtml(
            FEAT.i18n
              ? `显示更多（还有 ${standaloneChats.length - standaloneShown.length} 条）`
              : `Show more (${standaloneChats.length - standaloneShown.length} left)`
          )}</button>`
        : '';

    const standaloneSecHtml = standaloneChats.length
      ? `<div class="ag-sbp-section" data-section="conversations" data-collapsed="${convSecCollapsed ? '1' : '0'}">` +
        `<div class="ag-sbp-sec-hdr-bar">` +
        `<button type="button" class="ag-sbp-sec-hdr" data-ag-sbp-sec-toggle="conversations" aria-expanded="${!convSecCollapsed}">` +
        `<span>${escapeHtml(L('对话', 'Conversations'))}</span><span class="ag-sbp-sec-chev">${SvgChev}</span>` +
        `</button>` +
        `<button type="button" class="ag-sbp-sec-add" data-ag-sbp-new-chat="1" title="${escapeHtml(L('新建对话', 'New conversation'))}" aria-label="${escapeHtml(L('新建对话', 'New conversation'))}">${SvgPlus}</button>` +
        `</div>` +
        (convSecCollapsed
          ? ''
          : `<div class="ag-sbp-conv-list">${standaloneShown.map((c) => renderRowHtml(c, activeId, nowSec, false)).join('')}${standaloneMoreHtml}</div>`) +
        `</div>`
      : '';

    sec.innerHTML = `${projectsSecHtml}${standaloneSecHtml}`;
    if (sortMenuOpen) renderSortMenu();
    return true;
  }

  const onPrefsChanged = () => {
    forceSortRefresh = true;
    lastSig = '';
    if (sortMenuOpen) renderSortMenu();
    hooks.scheduleSidebarSync?.();
    hooks.syncSidebarHideNativeProjects?.();
  };
  const onProjectsUsageUpdated = (e) => {
    const next = e?.detail?.byProject;
    if (!next || typeof next !== 'object') return;
    Object.assign(sidebarUsageMap, next);
    usageFetchedAt = Date.now();
    if (readSortPrefs().sortMode === 'usage') {
      lastSig = '';
      hooks.scheduleSidebarSync?.();
    }
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('agy:sidebar-cap-prefs-changed', onPrefsChanged);
    window.addEventListener('agy:projects-usage-updated', onProjectsUsageUpdated);
  }

  function dispose() {
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('agy:sidebar-cap-prefs-changed', onPrefsChanged);
      window.removeEventListener('agy:projects-usage-updated', onProjectsUsageUpdated);
    }
    remove();
  }

  return {
    isCapActive,
    sync,
    remove,
    dispose,
    startInlineRename,
  };
}
