/**
 * Active Conversation Topbar Project Breadcrumb & Quick Actions (`#agy-conv-project-bar`)
 *
 * Mounts inside the native `@container/titlebar` left slot whenever viewing a conversation
 * (`/c/<id>`) or project-scoped draft (`/?project=<id>`) belonging to a Project:
 * - Clickable `Projects / 📁 <Project> ▾` breadcrumb (1-click return to Project Cockpit)
 * - Portal switcher menu `#agy-conv-project-menu` on `document.body` (immune to titlebar overflow-hidden)
 * - Git branch / remote badge (click opens Finder or remote repository URL)
 * - `+ New chat` button scoped directly to the active Project
 */

const BAR_ID = 'agy-conv-project-bar';
const MENU_ID = 'agy-conv-project-menu';

const SVG_CPB_FOLDER =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.3a1.1 1.1 0 0 1 1.1-1.1h3.2l1.2 1.3h5.4A1.1 1.1 0 0 1 14 5.6v6.1a1.1 1.1 0 0 1-1.1 1.1H3.1A1.1 1.1 0 0 1 2 11.7V4.3z"/></svg>';
const SVG_CPB_GLOBE =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M2.4 8h11.2M8 2.2c1.7 1.6 2.6 3.6 2.6 5.8S9.7 12.2 8 13.8C6.3 12.2 5.4 10.2 5.4 8S6.3 3.8 8 2.2z"/></svg>';
const SVG_CPB_BRANCH =
  '<svg viewBox="0 0 16 16" width="11.5" height="11.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="4.2" r="1.7"/><circle cx="5" cy="11.8" r="1.7"/><circle cx="11.5" cy="6.2" r="1.7"/><path d="M5 5.9v4.2M11.5 7.9c0 2-1.5 2.4-3.8 2.4H6.7"/></svg>';
const SVG_CPB_CHEVRON =
  '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.2L8 9.8l3.5-3.6"/></svg>';
const SVG_CPB_PLUS =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" aria-hidden="true"><path d="M8 3.3v9.4M3.3 8h9.4"/></svg>';
const SVG_CPB_CHECK =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 8.4l3.1 3.1 6.5-6.8"/></svg>';

function safeDecodeSegment(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function hasIndexKey(col, id) {
  if (!col || !id) return false;
  if (typeof col.has === 'function') return col.has(id);
  if (Array.isArray(col)) return col.includes(id);
  if (typeof col === 'object') return Object.prototype.hasOwnProperty.call(col, id);
  return false;
}

export function createConvProjectTopbar(ctx) {
  const {
    FEAT,
    L,
    rtState,
    pState,
    escapeHtml,
    later,
    getActiveCascadeId,
    decodeFileUriToPath,
    formatShortHomePath,
    resolveProjectsStoreAndBindings,
    collectNativeProjects,
    openProjectsView,
    startNewChatInProject,
    showProjectsFloatingNotice,
    worktreeUi,
  } = ctx;

  let menuOpen = false;
  let menuDocBound = false;
  let lastSig = '';
  const warmedDirs = new Set();

  function findTitlebarMountSlot() {
    const announceSlot = document.querySelector('[data-testid="titlebar-service-announcement-slot"]');
    if (announceSlot && announceSlot.parentElement) {
      const prev = announceSlot.previousElementSibling;
      if (prev && prev.tagName === 'DIV') return prev;
      return announceSlot.parentElement;
    }
    const toolbar = document.querySelector('[data-testid="pane-titlebar-toolbar"]');
    if (toolbar && toolbar.parentElement) {
      const first = toolbar.parentElement.firstElementChild;
      if (first && first !== toolbar && first.tagName === 'DIV') return first;
      return toolbar.parentElement;
    }
    const tb = document.querySelector('[class*="@container/titlebar"]');
    if (tb) {
      const first = tb.firstElementChild;
      if (first && first.tagName === 'DIV') return first;
      return tb;
    }
    return null;
  }

  function resolveCurrentLocation(bindings) {
    const rLoc = bindings && bindings.router && bindings.router.state && bindings.router.state.location;
    const winPathname = typeof window !== 'undefined' && window.location ? String(window.location.pathname || '') : '';
    const winSearch = typeof window !== 'undefined' && window.location ? String(window.location.search || '') : '';
    const pathname = rLoc && typeof rLoc.pathname === 'string' && rLoc.pathname ? rLoc.pathname : winPathname || '/';
    let urlPid = '';
    if (rLoc && rLoc.search && typeof rLoc.search === 'object' && typeof rLoc.search.project === 'string') {
      urlPid = rLoc.search.project;
    }
    if (!urlPid && rLoc && typeof rLoc.searchStr === 'string' && rLoc.searchStr) {
      try {
        urlPid = new URLSearchParams(rLoc.searchStr).get('project') || '';
      } catch {}
    }
    if (!urlPid && winSearch) {
      try {
        urlPid = new URLSearchParams(winSearch).get('project') || '';
      } catch {}
    }
    const settingsOpen = /(?:^|[?&])settingsOpen=true(?:&|$)/i.test(winSearch);
    return { pathname, urlPid, settingsOpen };
  }

  function resolveActiveConversationProject() {
    const { store, bindings } = resolveProjectsStoreAndBindings();
    const { pathname, urlPid, settingsOpen } = resolveCurrentLocation(bindings);
    if (settingsOpen) return null;

    const hasRouterLoc = Boolean(bindings && bindings.router && bindings.router.state && bindings.router.state.location);
    const routeCidMatch = pathname.match(/^\/c\/([^/?#]+)/);
    const curCid = routeCidMatch
      ? safeDecodeSegment(routeCidMatch[1])
      : hasRouterLoc && (pathname === '/' || pathname === '')
        ? ''
        : getActiveCascadeId() || '';
    const isConvRoute = pathname.startsWith('/c/') || Boolean(curCid && !hasRouterLoc && pathname === '/');
    const isHomeRoute = pathname === '/' || pathname === '';
    if (!isConvRoute && !isHomeRoute) return null;

    const allProjects = collectNativeProjects();
    if (!allProjects.length) return null;

    const state = store && typeof store.getState === 'function' ? store.getState() : null;
    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const sum = curCid ? summaries[curCid] : null;
    const norm = (p) => String(p || '').replace(/\/+$/, '').toLowerCase();

    let pid = '';
    if (sum) {
      pid = String((sum.trajectoryMetadata && sum.trajectoryMetadata.projectId) || sum.projectId || '');
      if ((!pid || pid === 'outside-of-project') && curCid && state) {
        const byProject = state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.byProject;
        if (byProject && typeof byProject === 'object') {
          for (const [candPid, rawIds] of Object.entries(byProject)) {
            if (!candPid || candPid === 'outside-of-project') continue;
            if (hasIndexKey(rawIds, curCid)) {
              pid = candPid;
              break;
            }
          }
        }
      }
    } else if (isHomeRoute && urlPid && urlPid !== 'outside-of-project') {
      pid = urlPid;
    }

    let project = pid && pid !== 'outside-of-project' ? allProjects.find((p) => p.id === pid) || null : null;

    if (!project && sum) {
      const wsList = (sum.workspaces || []).concat((sum.trajectoryMetadata && sum.trajectoryMetadata.workspaces) || []);
      const rawUris = ((sum.trajectoryMetadata && sum.trajectoryMetadata.workspaceUris) || []).concat(
        wsList.map((ws) => ws && (ws.workspaceFolderAbsoluteUri || ws.uri || ws))
      );
      for (const rawUri of rawUris) {
        if (typeof rawUri !== 'string' || !rawUri.trim()) continue;
        const decoded = decodeFileUriToPath(rawUri).replace(/\/+$/, '');
        if (!decoded) continue;
        project = allProjects.find((p) => p.dirPath && norm(p.dirPath) === norm(decoded)) || null;
        if (project) break;
      }
    }

    if (!project) return null;
    const isDraft = !curCid && Boolean(urlPid && urlPid === project.id);
    return { project, allProjects, curCid, isDraft };
  }

  function closeMenu() {
    menuOpen = false;
    const menu = document.getElementById(MENU_ID);
    if (menu) menu.remove();
    const sw = document.querySelector(`#${BAR_ID} [data-ag-cpb-act="toggle-menu"]`);
    if (sw) sw.setAttribute('aria-expanded', 'false');
    if (menuDocBound) {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
      window.removeEventListener('resize', closeMenu);
      menuDocBound = false;
    }
  }

  function onDocMouseDown(ev) {
    const t = ev && ev.target;
    if (t && t.closest && t.closest(`#${MENU_ID}, #${BAR_ID} [data-ag-cpb-act="toggle-menu"]`)) return;
    closeMenu();
  }

  function onDocKeyDown(ev) {
    if (ev && ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
    }
  }

  function renderSwitcherMenu(activeProject, allProjects) {
    const anchor = document.querySelector(`#${BAR_ID} .ag-cpb-proj-capsule`);
    if (!anchor || !document.body) {
      closeMenu();
      return;
    }
    let menu = document.getElementById(MENU_ID);
    if (!menu) {
      menu = document.createElement('div');
      menu.id = MENU_ID;
      menu.setAttribute('data-maga-own', '1');
      menu.setAttribute('data-ag-i18n-ignore', '1');
      menu.setAttribute('role', 'menu');
      menu.addEventListener('click', (ev) => {
        const newInBtn = ev.target && ev.target.closest && ev.target.closest('[data-ag-cpb-new-in-proj]');
        if (newInBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const pid = newInBtn.getAttribute('data-ag-cpb-new-in-proj');
          const target = collectNativeProjects().find((p) => p.id === pid);
          closeMenu();
          if (target) focusOrStartNewChat(target);
          return;
        }
        const pickBtn = ev.target && ev.target.closest && ev.target.closest('[data-ag-cpb-pick-proj]');
        if (pickBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const pid = pickBtn.getAttribute('data-ag-cpb-pick-proj');
          closeMenu();
          if (pid) openProjectsView(pid);
          return;
        }
        const allBtn = ev.target && ev.target.closest && ev.target.closest('[data-ag-cpb-menu-all]');
        if (allBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          closeMenu();
          openProjectsView(null);
        }
      });
      document.body.appendChild(menu);
    }

    menu.innerHTML =
      `<div class="ag-cpb-menu-hdr">${escapeHtml(L('跳转项目工作区', 'Switch project workspace'))}</div>` +
      `<div class="ag-cpb-menu-list">${allProjects
        .map((p) => {
          const isCur = p.id === activeProject.id;
          const cnt = Array.isArray(p.chats) ? p.chats.length : 0;
          return `<div class="ag-cpb-menu-row"${isCur ? ' data-current="true"' : ''}>
            <button type="button" class="ag-cpb-menu-main" data-ag-cpb-pick-proj="${escapeHtml(p.id)}" role="menuitem">
              <span class="ag-cpb-menu-ico">${p.isRemote ? SVG_CPB_GLOBE : SVG_CPB_FOLDER}</span>
              <span class="ag-cpb-menu-name">${escapeHtml(p.name)}</span>
              ${cnt > 0 ? `<span class="ag-cpb-menu-cnt">${cnt}</span>` : ''}
              ${isCur ? `<span class="ag-cpb-menu-check">${SVG_CPB_CHECK}</span>` : ''}
            </button>
            <button type="button" class="ag-cpb-menu-new" data-ag-cpb-new-in-proj="${escapeHtml(p.id)}" title="${escapeHtml(L(`在「${p.name}」中新建对话`, `New chat in ${p.name}`))}" aria-label="${escapeHtml(L('在此项目新建对话', 'New chat in project'))}">${SVG_CPB_PLUS}</button>
          </div>`;
        })
        .join('')}</div>` +
      `<div class="ag-cpb-menu-sep"></div>` +
      `<button type="button" class="ag-cpb-menu-footer" data-ag-cpb-menu-all="true">${escapeHtml(L('查看全部项目…', 'View all projects…'))}</button>`;

    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth || 1200;
    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - 252));
    const top = Math.max(38, Math.round(r.bottom + 6));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${top}px`;

    if (!menuDocBound) {
      document.addEventListener('mousedown', onDocMouseDown, true);
      document.addEventListener('keydown', onDocKeyDown, true);
      window.addEventListener('resize', closeMenu);
      menuDocBound = true;
    }
  }

  function focusOrStartNewChat(project) {
    if (!project) return;
    const resolved = resolveActiveConversationProject();
    if (resolved && resolved.isDraft && resolved.project.id === project.id) {
      const box = document.getElementById('antigravity.agentSidePanelInputBox');
      const editable = box && (box.querySelector('[contenteditable="true"], textarea, input') || box);
      if (editable && typeof editable.focus === 'function') editable.focus();
      return;
    }
    startNewChatInProject(project);
    later(() => {
      const box = document.getElementById('antigravity.agentSidePanelInputBox');
      const editable = box && (box.querySelector('[contenteditable="true"], textarea, input') || box);
      if (editable && typeof editable.focus === 'function') editable.focus();
    }, 180);
  }

  function maybeWarmProjectContext(dirPath) {
    if (!dirPath || warmedDirs.has(dirPath) || pState.projectsContextMap[dirPath]) return;
    if (typeof window.__agProjectCall !== 'function') return;
    warmedDirs.add(dirPath);
    Promise.resolve(window.__agProjectCall('readContext', { dirPath }, 6000))
      .then((res) => {
        if (rtState.disposed) return;
        if (!res || !res.ok) {
          warmedDirs.delete(dirPath);
          return;
        }
        pState.projectsContextMap[dirPath] = res;
        lastSig = '';
        sync();
      })
      .catch(() => {
        warmedDirs.delete(dirPath);
      });
  }

  function clearHiddenNativeProjCrumbs() {
    document.querySelectorAll('[data-maga-hide-native-proj-crumb]').forEach((el) => {
      el.removeAttribute('data-maga-hide-native-proj-crumb');
    });
  }

  function syncNativeBreadcrumbDedup(slot) {
    let hasNativeConvCrumb = false;
    const nav = slot && slot.querySelector('nav[aria-label="Breadcrumb"]');
    const desiredHide = new Set();
    if (nav) {
      const items = nav.querySelectorAll('ol > li');
      for (const li of items) {
        const isProjSeg = Boolean(
          li.querySelector('a[href*="project="], [aria-label^="Project:"], [aria-label^="项目"]')
        );
        if (isProjSeg) {
          desiredHide.add(li);
        } else {
          hasNativeConvCrumb = true;
        }
      }
    }
    document.querySelectorAll('[data-maga-hide-native-proj-crumb]').forEach((el) => {
      if (!desiredHide.has(el)) el.removeAttribute('data-maga-hide-native-proj-crumb');
    });
    for (const li of desiredHide) {
      if (li.getAttribute('data-maga-hide-native-proj-crumb') !== '1') {
        li.setAttribute('data-maga-hide-native-proj-crumb', '1');
      }
    }
    return hasNativeConvCrumb;
  }

  function removeBar() {
    closeMenu();
    worktreeUi?.closeWorktreeMenu?.();
    clearHiddenNativeProjCrumbs();
    lastSig = '';
    const el = document.getElementById(BAR_ID);
    if (el) el.remove();
  }

  function handleBarClick(ev) {
    const btn = ev.target && ev.target.closest && ev.target.closest('[data-ag-cpb-act]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const act = btn.getAttribute('data-ag-cpb-act');
    const resolved = resolveActiveConversationProject();
    if (!resolved || !resolved.project) return;
    const { project, allProjects, curCid } = resolved;
    if (act === 'open-project') {
      closeMenu();
      worktreeUi?.closeWorktreeMenu?.();
      openProjectsView(project.id);
      return;
    }
    if (act === 'toggle-menu') {
      worktreeUi?.closeWorktreeMenu?.();
      if (menuOpen) {
        closeMenu();
      } else {
        menuOpen = true;
        btn.setAttribute('aria-expanded', 'true');
        renderSwitcherMenu(project, allProjects);
      }
      return;
    }
    if (act === 'new-chat') {
      closeMenu();
      worktreeUi?.closeWorktreeMenu?.();
      focusOrStartNewChat(project);
      return;
    }
    if (act === 'open-wt-menu') {
      closeMenu();
      if (project.dirPath && worktreeUi) {
        worktreeUi.openTopbarWorktreeMenu(btn, {
          project,
          curCid,
          onAfterChange: () => {
            lastSig = '';
            sync();
          },
        });
        return;
      }
    }
    if (act === 'open-repo' || act === 'open-wt-menu') {
      closeMenu();
      worktreeUi?.closeWorktreeMenu?.();
      const ctxData = project.dirPath ? pState.projectsContextMap[project.dirPath] : null;
      const wsData = project.dirPath ? pState.projectsWorkspaceStatusMap[project.dirPath] : null;
      const remoteUrl = (wsData && wsData.remoteUrl) || (ctxData && ctxData.remoteUrl) || project.remoteUrl || '';
      if (!project.dirPath && remoteUrl && typeof window.__agProjectCall === 'function') {
        Promise.resolve(window.__agProjectCall('openExternalUrl', { url: remoteUrl }, 5000)).catch(() => {});
      } else if (project.dirPath && typeof window.__agProjectCall === 'function') {
        const wtDisplay = worktreeUi ? worktreeUi.resolveConvWorktreeDisplay(project.dirPath, curCid) : null;
        const targetDir = (wtDisplay && wtDisplay.worktreePath) || project.dirPath;
        Promise.resolve(
          window.__agProjectCall('revealFile', { targetPath: targetDir, dirPath: project.dirPath, openFolder: true }, 5000)
        ).catch(() => {});
      }
    }
  }

  function handleBarContextMenu(ev) {
    const repoBtn = ev.target && ev.target.closest && ev.target.closest('[data-ag-cpb-act="open-repo"], [data-ag-cpb-act="open-wt-menu"]');
    if (!repoBtn) return;
    const resolved = resolveActiveConversationProject();
    if (!resolved || !resolved.project) return;
    const { project, curCid } = resolved;
    const wtDisplay = project.dirPath && worktreeUi ? worktreeUi.resolveConvWorktreeDisplay(project.dirPath, curCid) : null;
    const copyVal = (wtDisplay && wtDisplay.worktreePath) || project.dirPath || project.remoteUrl || '';
    if (!copyVal || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return;
    ev.preventDefault();
    ev.stopPropagation();
    const notice = project.dirPath
      ? L('已复制工作树路径', 'Worktree path copied')
      : L('已复制仓库链接', 'Repository URL copied');
    navigator.clipboard.writeText(copyVal).then(
      () => showProjectsFloatingNotice(notice),
      () => {}
    );
  }

  function sync() {
    if (rtState.disposed || !FEAT.projects || rtState.projectsViewOpen) {
      removeBar();
      return;
    }
    const slot = findTitlebarMountSlot();
    if (!slot) {
      removeBar();
      return;
    }
    const resolved = resolveActiveConversationProject();
    if (!resolved || !resolved.project) {
      removeBar();
      return;
    }

    const { project, allProjects, curCid, isDraft } = resolved;
    if (project.dirPath) maybeWarmProjectContext(project.dirPath);

    const ctxData = project.dirPath ? pState.projectsContextMap[project.dirPath] : null;
    const wsData = project.dirPath ? pState.projectsWorkspaceStatusMap[project.dirPath] : null;
    const wtDisplay = project.dirPath && worktreeUi ? worktreeUi.resolveConvWorktreeDisplay(project.dirPath, curCid) : null;
    const branch = String((wtDisplay && wtDisplay.branch) || (wsData && wsData.branch) || (ctxData && ctxData.gitBranch) || '').trim();
    const effectiveDirPath = (wtDisplay && wtDisplay.worktreePath) || project.dirPath || '';
    const remoteLabel = String((wsData && wsData.remoteLabel) || (ctxData && ctxData.remoteLabel) || project.remoteLabel || '').trim();
    const gitBadgeText = branch || (!project.dirPath && remoteLabel ? remoteLabel : '');

    const hasNativeConvCrumb = syncNativeBreadcrumbDedup(slot);

    let bar = document.getElementById(BAR_ID);
    if (!bar || bar.parentElement !== slot) {
      if (bar) bar.remove();
      bar = document.createElement('nav');
      bar.id = BAR_ID;
      bar.setAttribute('data-maga-own', '1');
      bar.setAttribute('data-ag-i18n-ignore', '1');
      bar.setAttribute('aria-label', L('当前对话所属项目', 'Conversation project'));
      bar.addEventListener('click', handleBarClick);
      bar.addEventListener('contextmenu', handleBarContextMenu);
      slot.insertBefore(bar, slot.firstChild);
      lastSig = '';
    } else if (slot.firstElementChild !== bar) {
      slot.insertBefore(bar, slot.firstChild);
    }

    const wtCount = wtDisplay ? wtDisplay.worktreeCount : 0;
    const isProtectedOnMain = Boolean(wtDisplay && wtDisplay.isProtected && wtCount > 1);
    const hasCollision = Boolean(wtDisplay && wtDisplay.collisionCids && wtDisplay.collisionCids.length > 0);
    const isLinkedWt = Boolean(wtDisplay && wtDisplay.isWorktree);
    const sig = `${FEAT.i18n ? 'zh' : 'en'}|${project.id}|${project.name}|${project.isRemote ? 1 : 0}|${allProjects.length}|${branch ? 1 : 0}|${gitBadgeText}|${effectiveDirPath}|${wtCount}|${isProtectedOnMain ? 1 : 0}|${hasCollision ? 1 : 0}|${isLinkedWt ? 1 : 0}|${isDraft ? 1 : 0}|${hasNativeConvCrumb ? 1 : 0}`;
    if (sig === lastSig) return;
    lastSig = sig;
    bar.setAttribute('aria-label', L('当前对话所属项目', 'Conversation project'));

    const switcherHtml =
      allProjects.length > 1
        ? `<button type="button" class="ag-cpb-switch" data-ag-cpb-act="toggle-menu" aria-expanded="${menuOpen ? 'true' : 'false'}" title="${escapeHtml(L('切换项目', 'Switch project'))}" aria-label="${escapeHtml(L('切换项目', 'Switch project'))}">${SVG_CPB_CHEVRON}</button>`
        : '';

    const shortPath = effectiveDirPath ? formatShortHomePath(effectiveDirPath) : project.remoteUrl || '';
    const repoTipParts = [];
    if (effectiveDirPath) {
      repoTipParts.push(shortPath);
      if (isProtectedOnMain) repoTipParts.push(L('受保护主干（建议切换到 worktree）', 'Protected main (switch to a worktree)'));
      if (hasCollision) repoTipParts.push(L('警告：另一场近期对话也在操作该 worktree', 'Advisory: shared with another active conversation'));
      repoTipParts.push(
        worktreeUi
          ? L('左键切换 Worktree，右键复制路径', 'Click to switch worktree, right-click to copy path')
          : L('左键在 Finder 中打开，右键复制路径', 'Click to reveal in Finder, right-click to copy')
      );
    } else if (remoteLabel) {
      repoTipParts.push(`${project.remoteUrl || remoteLabel} (${L('点击打开远程仓库', 'Click to open remote repository')})`);
    }
    const repoTip = repoTipParts.join(' · ');

    const gitAct = project.dirPath && worktreeUi ? 'open-wt-menu' : 'open-repo';
    const wtAttrs =
      (isProtectedOnMain ? ' data-protected="true"' : '') +
      (hasCollision ? ' data-collision="true"' : '') +
      (isLinkedWt ? ' data-worktree="true"' : '');
    const collisionDot = hasCollision ? '<span class="ag-cpb-dot" aria-hidden="true"></span>' : '';
    const gitHtml = gitBadgeText
      ? `<button type="button" class="ag-cpb-git" data-ag-cpb-act="${gitAct}"${wtAttrs} title="${escapeHtml(repoTip)}">${branch ? SVG_CPB_BRANCH : SVG_CPB_GLOBE}<span>${escapeHtml(gitBadgeText)}</span>${collisionDot}</button>`
      : '';

    const draftBadgeHtml = isDraft
      ? `<span class="ag-cpb-draft-tag">${escapeHtml(L('新对话', 'New draft'))}</span>`
      : '';

    const newBtnHtml = isDraft
      ? ''
      : `<button type="button" class="ag-cpb-new" data-ag-cpb-act="new-chat" title="${escapeHtml(L(`在「${project.name}」中新建对话`, `New conversation in ${project.name}`))}">${SVG_CPB_PLUS}<span class="ag-cpb-new-label">${escapeHtml(L('新对话', 'New chat'))}</span></button>`;

    const trailingSepHtml = hasNativeConvCrumb ? `<span class="ag-cpb-sep ag-cpb-trail-sep" aria-hidden="true">/</span>` : '';

    bar.innerHTML =
      `<div class="ag-cpb-proj-capsule">` +
      `<button type="button" class="ag-cpb-proj" data-ag-cpb-act="open-project" data-proj-id="${escapeHtml(project.id)}" title="${escapeHtml(L(`打开「${project.name}」项目主页`, `Open ${project.name} project`))}">${project.isRemote ? SVG_CPB_GLOBE : SVG_CPB_FOLDER}<span class="ag-cpb-proj-name">${escapeHtml(project.name)}</span></button>` +
      switcherHtml +
      `</div>` +
      gitHtml +
      draftBadgeHtml +
      newBtnHtml +
      trailingSepHtml;

    if (menuOpen) renderSwitcherMenu(project, allProjects);
  }

  function teardown() {
    removeBar();
    warmedDirs.clear();
  }

  return {
    sync,
    teardown,
    closeMenu,
  };
}
