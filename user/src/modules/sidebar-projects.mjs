/**
 * Sidebar Projects Smart Cap (default 4 per project / 8 total across Projects)
 * with priority protection (active/pending/running) and fair water-filling allocation.
 */

const COLLAPSED_PROJS_KEY = 'agy_sbp_collapsed_v1';
const COLLAPSED_SECS_KEY = 'agy_sbp_sec_collapsed_v1';
const DEFAULT_MAX_PER_PROJECT = 4;
const DEFAULT_MAX_TOTAL = 8;
const DEFAULT_STANDALONE_LIMIT = 8;

const SvgFolder =
  '<svg viewBox="0 0 16 16" width="13.5" height="13.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.4A1.2 1.2 0 0 1 3.2 3.2h3.1l1.2 1.3h5.3a1.2 1.2 0 0 1 1.2 1.2v6.1a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8V4.4z"/></svg>';
const SvgChev =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.2L8 9.8l3.5-3.6"/></svg>';
const SvgCockpit =
  '<svg viewBox="0 0 16 16" width="12.5" height="12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>';
const SvgPlus =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>';

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

function hasIndexKey(idxCol, id) {
  if (!idxCol || !id) return false;
  if (typeof idxCol.has === 'function') return idxCol.has(id);
  if (Array.isArray(idxCol)) return idxCol.includes(id);
  if (typeof idxCol === 'object') return Object.prototype.hasOwnProperty.call(idxCol, id);
  return false;
}

export function createSidebarProjectsModule(rt) {
  const { FEAT, L, docRoot, state: rtState, escapeHtml, hooks } = rt;

  let lastSig = '';
  let lastDragEndTs = 0;
  let standaloneLimit = DEFAULT_STANDALONE_LIMIT;
  let itemsById = new Map();
  let seededNativeCollapsed = false;
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

  function remove() {
    const el = typeof document !== 'undefined' ? document.getElementById('ag-claude-sidebar-projects') : null;
    if (el) el.remove();
    lastSig = '';
    itemsById.clear();
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
    projects.sort((a, b) => {
      const ta = a.chats[0]?.updatedAt || 0;
      const tb = b.chats[0]?.updatedAt || 0;
      if (tb !== ta) return tb - ta;
      return a.origIdx - b.origIdx;
    });
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
      return '<span class="ag-folder-orbit"></span>';
    }
    if (item.status && item.status.kind === 'unread') {
      return `<span class="ag-claude-unread-dot"></span>${age ? `<span>${escapeHtml(age)}</span>` : ''}`;
    }
    return age ? `<span>${escapeHtml(age)}</span>` : '';
  }

  function renderCollapsedProjBadgesHtml(chats) {
    const counts = { pending: 0, running: 0, unread: 0, subkind: null };
    for (const c of chats) {
      const k = c.status?.kind;
      if (k === 'pending') {
        counts.pending += 1;
        if (!counts.subkind) counts.subkind = c.status.subkind;
      } else if (k === 'running') {
        counts.running += 1;
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
      parts.push(`<span class="ag-claude-folder-badge" data-kind="running"><span class="ag-folder-orbit"></span><span>${counts.running}</span></span>`);
    }
    if (counts.unread > 0 && parts.length < 2) {
      parts.push(`<span class="ag-claude-folder-badge" data-kind="unread"><span class="ag-claude-unread-dot"></span><span>${counts.unread}</span></span>`);
    }
    return parts.slice(0, 2).join('');
  }

  function renderRowHtml(it, activeId, nowSec, indented) {
    const isAct = it.id === activeId;
    const wtBranch = hooks.getConversationBranchBadge?.(it.id) || '';
    const branchPillHtml = wtBranch ? `<span class="ag-sbp-branch">${escapeHtml(wtBranch)}</span>` : '';
    const sideHtml = renderSideHtml(it, nowSec);
    const tipParts = [it.title];
    if (it.project) tipParts.push(`${L('所属项目：', 'Project: ')}${it.project}`);
    if (wtBranch) tipParts.push(`Worktree: ${wtBranch}`);
    const pinSvg = hooks.RECENT_PIN_SVG || '';
    const moreSvg = hooks.RECENT_MORE_SVG || '⋯';
    return (
      `<div class="ag-sbp-row${indented ? ' is-indented' : ''}" role="button" tabindex="0" draggable="true"` +
      ` data-ag-sbp-id="${escapeHtml(it.id)}" data-ag-sbp-title="${escapeHtml(it.title)}"` +
      ` data-active="${isAct ? 'true' : 'false'}" title="${escapeHtml(tipParts.join('\n'))}">` +
      `<div class="ag-sbp-main"><div class="ag-sbp-title">${escapeHtml(it.title)}</div>${branchPillHtml}</div>` +
      `<div class="ag-sbp-side">${sideHtml}</div>` +
      `<div class="ag-sbp-actions">` +
      `<button type="button" class="ag-sbp-act-btn" data-ag-sbp-pin="${escapeHtml(it.id)}" title="${escapeHtml(L('置顶对话', 'Pin'))}" aria-label="${escapeHtml(L('置顶对话', 'Pin'))}">${pinSvg}</button>` +
      `<button type="button" class="ag-sbp-act-btn" data-ag-sbp-menu="${escapeHtml(it.id)}" title="${escapeHtml(L('更多选项', 'More options'))}" aria-label="${escapeHtml(L('更多选项', 'More options'))}">${moreSvg}</button>` +
      `</div></div>`
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

    const { maxPerProject, maxTotal } = readCapPrefs();
    const { projects, standaloneChats } = collectSectionsData(bindings, state, activeId, hasFocus);
    if (!projects.length && !standaloneChats.length) {
      remove();
      return false;
    }

    const allocated = computeSidebarProjectAllocation(projects, { maxPerProject, maxTotal, activeId });
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
      projSecCollapsed ? 1 : 0,
      convSecCollapsed ? 1 : 0,
      standaloneLimit,
      activeId,
      nowBucket,
      allocated.items
        .map((p) =>
          `${p.id}:${p.name}:${p.collapsed ? 1 : 0}:${p.expandedOverride ? 1 : 0}:${p.hiddenCount}:${p.visibleChats
            .map((c) => `${c.id}:${c.title}:${hooks.getConversationBranchBadge?.(c.id) || ''}:${c.status ? `${c.status.kind}-${c.status.subkind}` : 'idle'}:${Math.floor(c.updatedAt / 60)}`)
            .join(',')}`
        )
        .join('|'),
      `${standaloneChats.length}:${standaloneShown
        .map((c) => `${c.id}:${c.title}:${hooks.getConversationBranchBadge?.(c.id) || ''}:${c.status ? `${c.status.kind}-${c.status.subkind}` : 'idle'}:${Math.floor(c.updatedAt / 60)}`)
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

        const newProjBtn = t.closest('[data-ag-sbp-new-proj]');
        if (newProjBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          hooks.closeRecentRowMenu?.();
          hooks.triggerNativeNewProject?.();
          return;
        }

        const newConvBtn = t.closest('[data-ag-sbp-new-chat]');
        if (newConvBtn) {
          ev.preventDefault();
          ev.stopPropagation();
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
          const cid = menuBtn.getAttribute('data-ag-sbp-menu');
          const item = itemsById.get(cid);
          const r = menuBtn.getBoundingClientRect();
          if (item) hooks.openRecentRowMenu?.(item, r.right + 4, r.bottom + 4);
          return;
        }

        const row = t.closest('[data-ag-sbp-id]');
        if (row) {
          if (Date.now() - lastDragEndTs < 260) return;
          const cid = row.getAttribute('data-ag-sbp-id');
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
        const item = itemsById.get(cid);
        if (!item) return;
        ev.preventDefault();
        ev.stopPropagation();
        hooks.openRecentRowMenu?.(item, ev.clientX + 2, ev.clientY + 2);
      });

      sec.addEventListener('dragstart', (ev) => {
        if (ev.target?.closest?.('[data-ag-sbp-pin], [data-ag-sbp-menu]')) {
          ev.preventDefault();
          return;
        }
        const row = ev.target?.closest?.('[data-ag-sbp-id]');
        if (!row) return;
        const cid = row.getAttribute('data-ag-sbp-id');
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
        const row = ev.target?.closest?.('[data-ag-sbp-id]');
        if (row && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          if (rtState.projectsViewOpen) hooks.closeProjectsView?.();
          const cid = row.getAttribute('data-ag-sbp-id');
          hooks.navigateSidebarConversation?.(cid, hooks.findSidebarBindings?.() || bindings);
          hooks.scheduleSidebarSync?.();
        }
      });

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
            const hdrHtml =
              `<div class="ag-sbp-proj-hdr-wrap" data-collapsed="${collapsedAttr}">` +
              `<button type="button" class="ag-sbp-proj-hdr" data-ag-sbp-proj-toggle="${escapeHtml(p.id)}" aria-expanded="${p.collapsed ? 'false' : 'true'}" title="${escapeHtml(`${p.name} (${p.chats.length})`)}">` +
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

    const projectsSecHtml = allocated.items.length
      ? `<div class="ag-sbp-section" data-section="projects" data-collapsed="${projSecCollapsed ? '1' : '0'}">` +
        `<div class="ag-sbp-sec-hdr-bar">` +
        `<button type="button" class="ag-sbp-sec-hdr" data-ag-sbp-sec-toggle="projects" aria-expanded="${!projSecCollapsed}">` +
        `<span>${escapeHtml(L('项目', 'Projects'))}</span>${projCountHint}<span class="ag-sbp-sec-chev">${SvgChev}</span>` +
        `</button>` +
        `<button type="button" class="ag-sbp-sec-add" data-ag-sbp-new-proj="1" title="${escapeHtml(L('新建项目', 'New project'))}" aria-label="${escapeHtml(L('新建项目', 'New project'))}">${SvgPlus}</button>` +
        `</div>` +
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
    return true;
  }

  const onPrefsChanged = () => {
    lastSig = '';
    hooks.scheduleSidebarSync?.();
    hooks.syncSidebarHideNativeProjects?.();
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('agy:sidebar-cap-prefs-changed', onPrefsChanged);
  }

  function dispose() {
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('agy:sidebar-cap-prefs-changed', onPrefsChanged);
    }
    remove();
  }

  return {
    isCapActive,
    sync,
    remove,
    dispose,
  };
}
