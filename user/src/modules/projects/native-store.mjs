/**
 * Native Redux/Fiber store bindings, project CRUD RPCs, context/file deltas & project action menu.
 */
export function createProjectNativeStore(ctx) {
  const { FEAT, L, FILE_MANAGER_ZH, FILE_MANAGER_EN, rtState, escapeHtml, setLeafText, pState, ICONS, pHooks, activeReactFiber, invalidateOverviewSnapshotCache, isSidebarVisibleSummary, isSummaryPinned, protoSeconds, findSidebarBindings, scheduleSidebarSync, closeRecentRowMenu } = ctx;
  const { SVG_CLAUDE_PROJECTS_ICON, SVG_PROJ_SETTINGS, RECENT_FOLDER_SVG, RECENT_RENAME_SVG, RECENT_ARCHIVE_SVG, RECENT_TRASH_SVG } = ICONS;
  const renderProjectsView = (...args) => pHooks.renderProjectsView?.(...args);
  const closeProjectsModal = (...args) => pHooks.closeProjectsModal?.(...args);
  const showProjectsFloatingNotice = (...args) => pHooks.showProjectsFloatingNotice?.(...args);

  function clearNewProjectWatcher() {
    if (typeof pState.newProjectWatchCleanup === 'function') {
      const fn = pState.newProjectWatchCleanup;
      pState.newProjectWatchCleanup = null;
      try {
        fn();
      } catch {}
    }
  }







  function decodeFileUriToPath(uri) {
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

  function formatShortHomePath(absPath) {
    const p = String(absPath || '').trim();
    if (!p) return '';
    return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~');
  }

  function normalizeRemoteGitUrl(raw) {
    const s = String(raw || '').trim();
    if (!s || /[\r\n\0\s]/.test(s) || /^file:\/\//i.test(s)) return null;
    let candidate = '';
    const scpM = s.match(/^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):([^/].+)$/);
    if (scpM && !/^[a-zA-Z]+:\/\//.test(s)) {
      candidate = `https://${scpM[1]}/${scpM[2].replace(/^\/+/, '')}`;
    } else if (/^(?:ssh|git):\/\//i.test(s)) {
      const protoM = s.match(/^(?:ssh|git):\/\/(?:[^/@]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
      if (protoM) candidate = `https://${protoM[1]}/${protoM[2].replace(/^\/+/, '')}`;
    } else if (/^https?:\/\//i.test(s)) {
      candidate = s;
    } else {
      return null;
    }
    try {
      const u = new URL(candidate);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      const cleanPath = u.pathname.replace(/\.git$/i, '').replace(/\/+$/, '');
      const href = `${u.protocol}//${u.host}${cleanPath}`;
      const trimmed = cleanPath.replace(/^\/+/, '');
      const hostLower = u.hostname.toLowerCase();
      const label =
        trimmed && (hostLower === 'github.com' || hostLower === 'gitlab.com' || hostLower === 'bitbucket.org')
          ? trimmed
          : trimmed
            ? `${u.host}/${trimmed}`
            : u.host;
      return { remoteUrl: href, remoteLabel: label };
    } catch {
      return null;
    }
  }

  function extractProjectRemoteInfo(rawProj, rawRecord = null) {
    const tryValue = (val) => {
      if (!val) return null;
      if (typeof val === 'string') return normalizeRemoteGitUrl(val);
      if (typeof val !== 'object') return null;
      for (const key of ['remoteUrl', 'repoUrl', 'repositoryUrl', 'gitUrl', 'githubUrl', 'htmlUrl', 'url', 'uri', 'cloneUrl', 'sshUrl']) {
        if (typeof val[key] === 'string') {
          const hit = normalizeRemoteGitUrl(val[key]);
          if (hit) return hit;
        }
      }
      if (typeof val.owner === 'string' && typeof (val.repo || val.name) === 'string') {
        const slug = `${val.owner.trim()}/${String(val.repo || val.name).trim()}`;
        const hit = normalizeRemoteGitUrl(`https://github.com/${slug}`);
        if (hit) return hit;
      }
      if (typeof val.githubRepo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(val.githubRepo.trim())) {
        const hit = normalizeRemoteGitUrl(`https://github.com/${val.githubRepo.trim()}`);
        if (hit) return hit;
      }
      return null;
    };

    const uris = Array.isArray(rawProj?.folderUris) ? rawProj.folderUris : [];
    for (const u of uris) {
      const hit = normalizeRemoteGitUrl(u);
      if (hit) return hit;
    }
    const directHit = tryValue(rawProj);
    if (directHit) return directHit;

    const rec = rawRecord || null;
    const recHit = tryValue(rec);
    if (recHit) return recHit;

    const resources = Array.isArray(rec?.projectResources?.resources) ? rec.projectResources.resources : [];
    for (const r of resources) {
      if (!r || typeof r !== 'object') continue;
      for (const nested of [r, r.gitRepo, r.repository, r.remoteRepo, r.githubRepository, r.gitFolder, r.repo]) {
        const hit = tryValue(nested);
        if (hit) return hit;
      }
    }
    return { remoteUrl: '', remoteLabel: '' };
  }

  function formatProjectTimeAgo(sec) {
    const s = Number(sec) || 0;
    if (!s) return '';
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - s);
    if (diff < 60) return L('刚刚', 'now');
    if (diff < 3600) {
      const mins = Math.floor(diff / 60);
      return FEAT.i18n ? `${mins} 分钟前` : `${mins}m`;
    }
    if (diff < 86400) {
      const hrs = Math.floor(diff / 3600);
      return FEAT.i18n ? `${hrs} 小时前` : `${hrs}h`;
    }
    const days = Math.floor(diff / 86400);
    if (days < 30) return FEAT.i18n ? `${days} 天前` : `${days}d ago`;
    const dt = new Date(s * 1000);
    return FEAT.i18n ? `${dt.getMonth() + 1}月${dt.getDate()}日` : `${dt.getMonth() + 1}/${dt.getDate()}`;
  }

  function resolveProjectsStoreAndBindings() {
    let bindings = findSidebarBindings();
    let store = (bindings && bindings.store) || rtState.sidebarStoreRef || null;
    let router = (bindings && bindings.router) || null;
    if (!store || !router) {
      const rootEl = document.getElementById('root');
      const anchors = [
        document.querySelector('[data-testid="project-header"]'),
        document.querySelector('[data-testid="automations-button"]'),
        document.querySelector('[data-testid="conversation-list-sidebar"]'),
        document.querySelector('.bg-sidebar'),
        rootEl && rootEl.firstElementChild
      ];
      for (const anchor of anchors) {
        let f = anchor ? activeReactFiber(anchor) : null;
        for (let d = 0; f && d < 42 && (!store || !router); d++, f = f.return) {
          const mp = f.memoizedProps;
          if (!store && mp && mp.sidebarStore && typeof mp.sidebarStore.getState === 'function') {
            store = mp.sidebarStore;
          }
          if (!router && mp && mp.sidebarRouter && typeof mp.sidebarRouter.navigate === 'function') {
            router = mp.sidebarRouter;
          }
          if (!router && mp && mp.value && typeof mp.value.navigate === 'function' && mp.value.state && mp.value.state.location) {
            router = mp.value;
          }
          for (let dep = f.dependencies && f.dependencies.firstContext; dep; dep = dep.next) {
            const mv = dep.memoizedValue;
            if (!store && mv && mv.store && typeof mv.store.getState === 'function') {
              store = mv.store;
            }
            if (!router && mv && typeof mv.navigate === 'function' && mv.state && mv.state.location) {
              router = mv;
            }
          }
        }
        if (store && router) break;
      }
    }
    if (!bindings && (store || router)) {
      bindings = { store, router, stepHandler: null, actionsCtx: null, groupsById: new Map(), projectLabels: new Map() };
    } else if (bindings && router && !bindings.router) {
      bindings = Object.assign({}, bindings, { router });
    }
    return { store, bindings };
  }

  function collectProjectConversations(project, state) {
    if (!project || !state) return [];
    const summaries = (state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const byProject = state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.byProject;
    const rawIds = byProject && byProject[project.id];
    const candidateIds = new Set();

    if (rawIds) {
      const arr =
        typeof rawIds[Symbol.iterator] === 'function'
          ? Array.from(rawIds)
          : typeof rawIds === 'object'
            ? Object.keys(rawIds)
            : [];
      for (const id of arr) candidateIds.add(id);
    }

    const normDir = String(project.dirPath || '').replace(/\/+$/, '');
    for (const [cid, sum] of Object.entries(summaries)) {
      if (!sum) continue;
      const pid = sum.projectId || (sum.trajectoryMetadata && sum.trajectoryMetadata.projectId) || '';
      if (pid === project.id) {
        candidateIds.add(cid);
        continue;
      }
      if (normDir) {
        const wsList = (sum.workspaces || []).concat((sum.trajectoryMetadata && sum.trajectoryMetadata.workspaces) || []);
        for (const ws of wsList) {
          const rawUri = ws && (ws.workspaceFolderAbsoluteUri || ws.uri || ws);
          const norm = typeof rawUri === 'string' ? decodeFileUriToPath(rawUri).replace(/\/+$/, '') : '';
          if (norm && norm === normDir) {
            candidateIds.add(cid);
            break;
          }
        }
      }
    }

    const items = [];
    for (const cid of candidateIds) {
      const sum = summaries[cid];
      if (!sum || !isSidebarVisibleSummary(cid, sum, state)) continue;
      const title = String((sum.annotations && sum.annotations.title) || sum.summary || '').trim();
      if (!title) continue;
      const lastSec = protoSeconds(sum.lastModifiedTime);
      const status = sum.status ?? 0;
      const waiting = Boolean(sum.waitingSteps && sum.waitingSteps.length);
      const running = !sum.killed && (status === 2 || status === 3 || status === 4 || Boolean(sum.hasRunningSubagents));
      items.push({
        id: cid,
        title,
        lastSec,
        pinned: isSummaryPinned(cid, sum, state),
        waiting,
        running
      });
    }
    items.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.lastSec - a.lastSec));
    return items;
  }

  function resolveProjectManagementService() {
    if (pState.projectMgmtSvcRef && typeof pState.projectMgmtSvcRef.deleteProject === 'function') {
      return pState.projectMgmtSvcRef;
    }
    const rootEl = document.getElementById('root');
    const anchors = [
      document.querySelector('[data-testid="conversation-list-sidebar"]'),
      document.querySelector('[data-testid="automations-button"]'),
      document.querySelector('[data-testid="project-header"]'),
      document.querySelector('.bg-sidebar'),
      rootEl && rootEl.firstElementChild
    ];
    const pickSvc = (val) => {
      if (!val || typeof val !== 'object') return null;
      if (val.core && val.core.projectManagementService && typeof val.core.projectManagementService.deleteProject === 'function') {
        return val.core.projectManagementService;
      }
      if (typeof val.deleteProject === 'function') return val;
      return null;
    };
    for (const anchor of anchors) {
      let cur = anchor ? activeReactFiber(anchor) : null;
      for (let d = 0; cur && d < 42; d++, cur = cur.return) {
        const fromProps = pickSvc(cur.memoizedProps && cur.memoizedProps.value);
        if (fromProps) {
          pState.projectMgmtSvcRef = fromProps;
          return fromProps;
        }
        for (let dep = cur.dependencies && cur.dependencies.firstContext; dep; dep = dep.next) {
          const fromDep = pickSvc(dep.memoizedValue);
          if (fromDep) {
            pState.projectMgmtSvcRef = fromDep;
            return fromDep;
          }
        }
      }
    }
    return null;
  }

  function getRawNativeProjectRecord(projectId, svc) {
    const pm = svc || resolveProjectManagementService();
    if (pm && typeof pm.getProjectStateProvider === 'function') {
      try {
        const prov = pm.getProjectStateProvider(projectId);
        const st = prov && typeof prov.getState === 'function' ? prov.getState() : null;
        if (st && st.project && typeof st.project === 'object') return st.project;
      } catch {}
    }
    if (pm && pm.projectsStateProvider && typeof pm.projectsStateProvider.getState === 'function') {
      try {
        const list = pm.projectsStateProvider.getState() || [];
        const hit = list.find((item) => item && item.project && item.project.id === projectId);
        if (hit && hit.project) return hit.project;
      } catch {}
    }
    return null;
  }


  async function renameNativeProject(project, nextName) {
    const trimmed = String(nextName || '').trim();
    if (!project || !project.id || project.isBuiltin || !trimmed) return { ok: false, error: 'invalid_name' };
    const pm = resolveProjectManagementService();
    if (!pm || typeof pm.updateProject !== 'function') return { ok: false, error: 'service_unavailable' };
    const raw = getRawNativeProjectRecord(project.id, pm);
    if (!raw) return { ok: false, error: 'project_record_unavailable' };
    pState.optimisticProjectNames.set(project.id, trimmed);
    if (rtState.projectsViewOpen) renderProjectsView();
    try {
      await pm.updateProject(Object.assign({}, raw, { name: trimmed }));
      if (!rtState.disposed) {
        if (rtState.projectsViewOpen) renderProjectsView();
        scheduleSidebarSync();
      }
      return { ok: true };
    } catch (err) {
      pState.optimisticProjectNames.delete(project.id);
      if (!rtState.disposed && rtState.projectsViewOpen) renderProjectsView();
      return { ok: false, error: String((err && err.message) || err || 'rename_failed') };
    }
  }

  async function archiveNativeProject(project) {
    if (!project || !project.id || project.isBuiltin) return false;
    const pm = resolveProjectManagementService();
    if (!pm || typeof pm.updateProject !== 'function') return false;
    const raw = getRawNativeProjectRecord(project.id, pm);
    if (!raw) return false;
    pState.optimisticallyArchivedProjectIds.set(project.id, Date.now());
    if (pState.activeProjectId === project.id) {
      pState.activeProjectId = null;
      pState.projectSelectedFolderPath = '';
    }
    if (rtState.projectsViewOpen) renderProjectsView();
    try {
      await pm.updateProject(Object.assign({}, raw, { archived: true }));
      if (!rtState.disposed) {
        if (rtState.projectsViewOpen) renderProjectsView();
        scheduleSidebarSync();
      }
      return true;
    } catch {
      pState.optimisticallyArchivedProjectIds.delete(project.id);
      if (!rtState.disposed && rtState.projectsViewOpen) renderProjectsView();
      return false;
    }
  }

  async function deleteNativeProject(project) {
    if (!project || !project.id || project.isBuiltin) return false;
    const pm = resolveProjectManagementService();
    if (!pm || typeof pm.deleteProject !== 'function') return false;
    const { bindings } = resolveProjectsStoreAndBindings();
    pState.optimisticallyDeletedProjectIds.add(project.id);
    pState.optimisticProjectNames.delete(project.id);
    pState.projectComposerDrafts.delete(project.id);
    if (pState.activeProjectId === project.id) {
      pState.activeProjectId = null;
      pState.projectFolderDropdownOpen = false;
      pState.projectFolderSearch = '';
      pState.projectSelectedFolderPath = '';
    }
    if (rtState.projectsViewOpen) renderProjectsView();
    try {
      await pm.deleteProject(project.id);
      const router = bindings && bindings.router;
      const loc = router && router.state && router.state.location;
      if (router && typeof router.navigate === 'function' && loc && loc.search && loc.search.project === project.id) {
        try {
          router.navigate({
            to: loc.pathname || '/',
            search: (prev) => {
              const next = Object.assign({}, prev || {});
              delete next.project;
              return next;
            },
            replace: true
          });
        } catch {}
      }
      if (!rtState.disposed) {
        if (rtState.projectsViewOpen) renderProjectsView();
        scheduleSidebarSync();
      }
      return true;
    } catch {
      pState.optimisticallyDeletedProjectIds.delete(project.id);
      if (!rtState.disposed && rtState.projectsViewOpen) renderProjectsView();
      return false;
    }
  }

  function openNativeProjectSettings(project) {
    if (!project || !project.id || project.isBuiltin) return;
    const { bindings } = resolveProjectsStoreAndBindings();
    const router = bindings && bindings.router;
    if (router && typeof router.navigate === 'function') {
      try {
        router.navigate({
          search: (prev) =>
            Object.assign({}, prev || {}, {
              settingsOpen: 'true',
              settingsProjectId: project.id
            })
        });
        return;
      } catch {}
    }
    const settingsBtn = document.querySelector('[data-testid="settings-button"]');
    if (settingsBtn) settingsBtn.click();
  }

  function closeProjectActionMenu() {
    pState.projectMenuState = null;
    const menu = document.getElementById('ag-project-action-menu');
    if (menu) menu.remove();
    document.querySelectorAll('[data-ag-proj-menu][data-menu-open], [data-ag-pd-proj-menu][data-menu-open]').forEach((b) => {
      b.removeAttribute('data-menu-open');
    });
    if (pState.projectMenuDocBound) {
      document.removeEventListener('mousedown', onProjectMenuDocDown, true);
      window.removeEventListener('resize', closeProjectActionMenu);
      pState.projectMenuDocBound = false;
    }
  }

  function onProjectMenuDocDown(ev) {
    const t = ev && ev.target;
    if (t && t.closest && t.closest('#ag-project-action-menu, [data-ag-proj-menu], [data-ag-pd-proj-menu]')) return;
    closeProjectActionMenu();
  }

  function renderProjectActionMenu() {
    const st = pState.projectMenuState;
    if (!st || !st.project) {
      closeProjectActionMenu();
      return;
    }
    let menu = document.getElementById('ag-project-action-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'ag-project-action-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-ag-i18n-ignore', '1');
      menu.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest && ev.target.closest('[data-ag-pm-act]');
        if (!btn || !pState.projectMenuState) return;
        ev.preventDefault();
        ev.stopPropagation();
        const act = btn.getAttribute('data-ag-pm-act');
        const cur = pState.projectMenuState;
        const proj = cur.project;
        if (act === 'rename') {
          closeProjectActionMenu();
          openRenameProjectModal(proj);
          return;
        }
        if (act === 'reveal') {
          closeProjectActionMenu();
          if (proj.dirPath && typeof window.__agProjectCall === 'function') {
            window.__agProjectCall('revealFile', { dirPath: proj.dirPath, targetPath: proj.dirPath }, 8000);
          }
          return;
        }
        if (act === 'settings') {
          closeProjectActionMenu();
          openNativeProjectSettings(proj);
          return;
        }
        if (act === 'archive') {
          closeProjectActionMenu();
          archiveNativeProject(proj);
          return;
        }
        if (act === 'delete') {
          if (!cur.confirmDelete) {
            cur.confirmDelete = true;
            renderProjectActionMenu();
            return;
          }
          closeProjectActionMenu();
          deleteNativeProject(proj);
        }
      });
      document.body.appendChild(menu);
    }

    const proj = st.project;
    const pm = resolveProjectManagementService();
    const canUpdate = Boolean(!proj.isBuiltin && pm && typeof pm.updateProject === 'function');
    const canDelete = Boolean(!proj.isBuiltin && pm && typeof pm.deleteProject === 'function');
    const canReveal = Boolean(proj.dirPath && typeof window.__agProjectCall === 'function');
    const revealLabel = L(`在${FILE_MANAGER_ZH}中显示`, FILE_MANAGER_EN === 'Explorer' ? 'Show in Explorer' : `Reveal in ${FILE_MANAGER_EN}`);
    const delLabel = st.confirmDelete
      ? L('确认删除？（保留本地文件）', 'Confirm delete? (keeps files)')
      : L('删除项目', 'Delete project');

    let itemsHtml = '';
    itemsHtml += `<button type="button" class="ag-rm-item" data-ag-pm-act="rename"${canUpdate ? '' : ' disabled'}>${RECENT_RENAME_SVG}<span class="ag-rm-label">${escapeHtml(L('重命名项目', 'Rename project'))}</span></button>`;
    if (proj.dirPath) {
      itemsHtml += `<button type="button" class="ag-rm-item" data-ag-pm-act="reveal"${canReveal ? '' : ' disabled'}>${RECENT_FOLDER_SVG}<span class="ag-rm-label">${escapeHtml(revealLabel)}</span></button>`;
    }
    itemsHtml += `<button type="button" class="ag-rm-item" data-ag-pm-act="settings"${!proj.isBuiltin ? '' : ' disabled'}>${SVG_PROJ_SETTINGS}<span class="ag-rm-label">${escapeHtml(L('项目权限设置', 'Project settings'))}</span></button>`;
    if (canUpdate && getRawNativeProjectRecord(proj.id, pm)) {
      itemsHtml += `<button type="button" class="ag-rm-item" data-ag-pm-act="archive">${RECENT_ARCHIVE_SVG}<span class="ag-rm-label">${escapeHtml(L('归档项目', 'Archive project'))}</span></button>`;
    }
    itemsHtml += `<div class="ag-rm-sep"></div>`;
    itemsHtml += `<button type="button" class="ag-rm-item ag-rm-danger" data-ag-pm-act="delete" data-confirm="${st.confirmDelete ? '1' : '0'}"${canDelete ? '' : ' disabled'}>${RECENT_TRASH_SVG}<span class="ag-rm-label">${escapeHtml(delLabel)}</span></button>`;

    menu.innerHTML = itemsHtml;

    const menuW = 216;
    const menuH = Math.max(140, menu.offsetHeight || 168);
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const left = Math.min(Math.max(8, st.x), Math.max(8, vw - menuW - 8));
    const top = st.y + menuH > vh - 8 ? Math.max(8, st.y - menuH) : Math.max(8, st.y);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    if (!pState.projectMenuDocBound) {
      document.addEventListener('mousedown', onProjectMenuDocDown, true);
      window.addEventListener('resize', closeProjectActionMenu);
      pState.projectMenuDocBound = true;
    }
  }

  function openProjectActionMenu(project, x, y, triggerBtn = null) {
    if (!project || !project.id || project.isBuiltin) return;
    closeRecentRowMenu();
    if (pState.projectMenuState && pState.projectMenuState.project && pState.projectMenuState.project.id === project.id && triggerBtn) {
      closeProjectActionMenu();
      return;
    }
    closeProjectActionMenu();
    if (triggerBtn) triggerBtn.setAttribute('data-menu-open', 'true');
    pState.projectMenuState = { project, x, y, confirmDelete: false };
    renderProjectActionMenu();
  }

  function openRenameProjectModal(project) {
    if (!project || !project.id || project.isBuiltin) return;
    closeProjectsModal();
    rtState.projectsModalState = {
      kind: 'renameProject',
      project,
      name: project.name || '',
      saving: false,
      error: ''
    };
    renderRenameProjectModal();
  }

  function renderRenameProjectModal() {
    if (!rtState.projectsModalState || rtState.projectsModalState.kind !== 'renameProject') return;
    if (!rtState.projectsModalEl || !rtState.projectsModalEl.isConnected) {
      rtState.projectsModalEl = document.createElement('div');
      rtState.projectsModalEl.id = 'ag-claude-project-modal';
      rtState.projectsModalEl.setAttribute('data-ag-i18n-ignore', '1');
      rtState.projectsModalEl.addEventListener('click', (e) => {
        if (e.target === rtState.projectsModalEl) closeProjectsModal();
      });
      document.body.appendChild(rtState.projectsModalEl);
    }
    const st = rtState.projectsModalState;
    const errHtml = st.error ? `<div class="ag-pm-error">${escapeHtml(st.error)}</div>` : '';
    rtState.projectsModalEl.innerHTML = `
      <div class="ag-pm-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(L('重命名项目', 'Rename project'))}">
        <div class="ag-pm-hdr">
          <div class="ag-pm-title-wrap">
            <span class="ag-pm-icon">${SVG_CLAUDE_PROJECTS_ICON}</span>
            <h2 class="ag-pm-title">${escapeHtml(L('重命名项目', 'Rename project'))}</h2>
          </div>
          <button type="button" class="ag-pm-close" data-ag-pm-close="true" aria-label="${escapeHtml(L('关闭', 'Close'))}">×</button>
        </div>
        <div class="ag-pm-field">
          <input id="ag-pm-rename-input" class="ag-pm-input" type="text" value="${escapeHtml(st.name)}" placeholder="${escapeHtml(L('输入项目名称…', 'Enter project name…'))}" />
        </div>
        ${errHtml}
        <div class="ag-pm-footer">
          <button type="button" class="ag-pm-secondary-btn" data-ag-pm-close="true">${L('取消', 'Cancel')}</button>
          <button type="button" class="ag-pm-primary-btn" data-ag-pm-rename-save="true" ${st.saving || !String(st.name || '').trim() ? 'disabled' : ''}>${
            st.saving ? L('保存中…', 'Saving…') : L('保存', 'Save')
          }</button>
        </div>
      </div>
    `;
    const input = rtState.projectsModalEl.querySelector('#ag-pm-rename-input');
    const saveBtn = rtState.projectsModalEl.querySelector('[data-ag-pm-rename-save]');
    const doSubmit = async () => {
      const modalRef = rtState.projectsModalState;
      if (!modalRef || modalRef.kind !== 'renameProject' || modalRef.saving) return;
      const nextName = String(modalRef.name || '').trim();
      if (!nextName) return;
      if (nextName === st.project.name) {
        closeProjectsModal();
        return;
      }
      modalRef.saving = true;
      modalRef.error = '';
      renderRenameProjectModal();
      const res = await renameNativeProject(st.project, nextName);
      if (rtState.disposed || rtState.projectsModalState !== modalRef) return;
      if (res && res.ok) {
        closeProjectsModal();
      } else {
        modalRef.saving = false;
        modalRef.error = L('重命名失败：', 'Rename failed: ') + String((res && res.error) || 'unknown');
        renderRenameProjectModal();
      }
    };
    if (input) {
      input.focus();
      try {
        input.select();
      } catch {}
      input.addEventListener('input', () => {
        if (!rtState.projectsModalState || rtState.projectsModalState.kind !== 'renameProject') return;
        rtState.projectsModalState.name = input.value;
        if (saveBtn) saveBtn.disabled = !input.value.trim();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          doSubmit();
        }
      });
    }
    rtState.projectsModalEl.querySelectorAll('[data-ag-pm-close]').forEach((b) => {
      b.addEventListener('click', () => closeProjectsModal());
    });
    if (saveBtn) {
      saveBtn.addEventListener('click', () => doSubmit());
    }
  }

  function collectNativeProjects() {
    const { store } = resolveProjectsStoreAndBindings();
    const state = store ? store.getState() : null;
    const rawProjects = (state && state.sidebarProjects && state.sidebarProjects.projects) || [];
    const presentRawIds = new Set();
    const out = [];
    const nowArchMs = Date.now();
    const pm = resolveProjectManagementService();
    for (const p of rawProjects) {
      if (!p || !p.id) continue;
      presentRawIds.add(p.id);
      if (p.archived) {
        /* Once Redux reflects archived: true, release optimistic archive mask so un-archiving reappears immediately */
        pState.optimisticallyArchivedProjectIds.delete(p.id);
        continue;
      }
      const optArchTs = pState.optimisticallyArchivedProjectIds.get(p.id);
      if (optArchTs !== undefined) {
        if (nowArchMs - optArchTs < 10000) continue;
        pState.optimisticallyArchivedProjectIds.delete(p.id);
      }
      if (pState.optimisticallyDeletedProjectIds.has(p.id)) continue;
      const rawName = String(p.name || '').trim();
      if (!rawName || rawName === 'swarm/swarm_board' || p.id === 'outside-of-project') continue;
      const isCliProject = p.id === 'default-cli-project';
      const uris = Array.isArray(p.folderUris) ? p.folderUris : [];
      const firstLocalUri = uris.find((u) => /^file:\/\//i.test(String(u || '').trim()) || (typeof u === 'string' && u.startsWith('/')));
      const dirPath = firstLocalUri ? decodeFileUriToPath(firstLocalUri) : '';
      const rawRec = !dirPath && !uris.some((u) => /^https?:\/\//i.test(String(u || ''))) ? getRawNativeProjectRecord(p.id, pm) : null;
      const remoteInfo = isCliProject ? { remoteUrl: '', remoteLabel: '' } : extractProjectRemoteInfo(p, rawRec);
      const optName = pState.optimisticProjectNames.get(p.id);
      if (optName && optName === rawName) pState.optimisticProjectNames.delete(p.id);
      const name = isCliProject ? L('CLI 项目', 'CLI Project') : optName || rawName;
      const base = {
        id: p.id,
        name,
        dirPath,
        shortPath: formatShortHomePath(dirPath),
        remoteUrl: remoteInfo.remoteUrl,
        remoteLabel: remoteInfo.remoteLabel,
        isRemote: Boolean(!dirPath && remoteInfo.remoteUrl),
        isVirtual: !dirPath && !remoteInfo.remoteUrl,
        isCliProject,
        isBuiltin: isCliProject
      };
      const chats = collectProjectConversations(base, state);
      out.push({
        ...base,
        chats,
        chatCount: chats.length,
        lastSec: chats.length ? chats[0].lastSec : 0
      });
    }
    for (const delId of [...pState.optimisticallyDeletedProjectIds]) {
      if (!presentRawIds.has(delId)) pState.optimisticallyDeletedProjectIds.delete(delId);
    }
    return out;
  }



  async function saveProjectContextDelta(project, mutator) {
    if (!project || !project.dirPath || typeof window.__agProjectCall !== 'function') {
      return { ok: false, error: 'unavailable' };
    }
    const dirKey = project.dirPath;
    const prevTail = pState.projectsContextQueueByDir.get(dirKey) || Promise.resolve();
    const runTask = async () => {
      if (rtState.disposed) return { ok: false, error: 'disposed' };
      pState.projectsContextBusy = true;
      try {
        let cur = pState.projectsContextMap[dirKey];
        if (!cur || !cur.ok) {
          cur = await window.__agProjectCall('readContext', { dirPath: dirKey }, 8000);
        }
        /* Never submit a full replacement save if current context failed to load (prevents wiping attachments/instructions) */
        if (!cur || !cur.ok) {
          const errMsg = (cur && cur.error) || 'context_read_failed';
          showProjectsFloatingNotice(
            L(`读取项目上下文失败（${errMsg}），已中止保存以防丢失现有文件。`, `Failed to load project context (${errMsg}); save aborted to protect existing files.`)
          );
          return { ok: false, error: errMsg };
        }
        const existingFiles = (Array.isArray(cur.files) ? cur.files : []).map((f) => ({
          action: 'keep',
          relPath: f.relPath,
          name: f.name,
          absPath: f.absPath
        }));
        const existingFolders = (Array.isArray(cur.extraFolders) ? cur.extraFolders : []).map((f) => ({
          name: f.name,
          absPath: f.absPath
        }));
        const draft = {
          instructions: cur.instructions || '',
          files: existingFiles,
          extraFolders: existingFolders
        };
        const updated =
          typeof mutator === 'function'
            ? mutator(draft)
            : mutator && typeof mutator === 'object'
              ? Object.assign({}, draft, mutator)
              : null;
        if (!updated) return { ok: true, skipped: true };
        const saved = await window.__agProjectCall(
          'saveContext',
          {
            dirPath: dirKey,
            instructions: updated.instructions,
            files: updated.files.map((x) =>
              x.action === 'keep'
                ? { action: 'keep', relPath: x.relPath, name: x.name }
                : x.action === 'add'
                  ? { action: 'add', sourcePath: x.sourcePath, name: x.name }
                  : { action: 'addContent', name: x.name, base64: x.base64 }
            ),
            extraFolders: updated.extraFolders
          },
          30000
        );
        if (!rtState.disposed && saved && saved.ok) {
          pState.projectsContextMap[dirKey] = saved;
          if (rtState.projectsViewOpen) renderProjectsView();
          invalidateOverviewSnapshotCache();
        }
        return saved || { ok: false, error: 'save_failed' };
      } finally {
        pState.projectsContextBusy = false;
      }
    };
    const nextPromise = prevTail.catch(() => {}).then(runTask);
    pState.projectsContextQueueByDir.set(dirKey, nextPromise);
    nextPromise.finally(() => {
      if (pState.projectsContextQueueByDir.get(dirKey) === nextPromise) {
        pState.projectsContextQueueByDir.delete(dirKey);
      }
    });
    return nextPromise;
  }

  async function saveFilesDeltaForProject(project, mutator) {
    return saveProjectContextDelta(project, (draft) => {
      const nextFiles = mutator(draft.files);
      if (!nextFiles) return null;
      return Object.assign({}, draft, { files: nextFiles });
    });
  }

  async function pickAndAddFolderToProject(project) {
    if (!project || !project.dirPath || typeof window.__agProjectCall !== 'function') return;
    const picked = await window.__agProjectCall('pickFolder', {}, 120000);
    if (rtState.disposed || !picked || !picked.ok || picked.canceled || !picked.folderPath) return;
    const fp = picked.folderPath;
    if (fp === project.dirPath) {
      pState.projectSelectedFolderPath = fp;
      pState.projectFolderDropdownOpen = false;
      if (rtState.projectsViewOpen) renderProjectsView();
      return;
    }
    await saveProjectContextDelta(project, (draft) => {
      const next = draft.extraFolders.slice();
      if (!next.some((f) => f.absPath === fp)) {
        next.push({ name: picked.name || fp.split(/[\\/]/).pop() || fp, absPath: fp });
      }
      return Object.assign({}, draft, { extraFolders: next });
    });
    pState.projectSelectedFolderPath = fp;
    pState.projectFolderDropdownOpen = false;
    if (rtState.projectsViewOpen) renderProjectsView();
  }

  async function removeExtraFolderFromProject(project, absPath) {
    if (!project || !absPath) return;
    if (pState.projectSelectedFolderPath === absPath) pState.projectSelectedFolderPath = project.dirPath;
    await saveProjectContextDelta(project, (draft) =>
      Object.assign({}, draft, { extraFolders: draft.extraFolders.filter((f) => f.absPath !== absPath) })
    );
  }

  function openInstantNativeFilePicker(project) {
    if (!project || !project.dirPath || !document.body) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
    document.body.appendChild(input);
    const cleanup = () => {
      try {
        input.remove();
      } catch {}
    };
    input.addEventListener(
      'change',
      () => {
        const files = input.files;
        cleanup();
        if (!rtState.disposed && files && files.length) {
          addDroppedFilesToProject(project, files);
        }
      },
      { once: true }
    );
    input.addEventListener('cancel', cleanup, { once: true });
    input.click();
  }

  async function pickAndAddFilesToProject(project) {
    if (!project || !project.dirPath) return;
    const en = window.electronNative;
    if (en && typeof en.getPathForFile === 'function') {
      openInstantNativeFilePicker(project);
      return;
    }
    if (typeof window.__agProjectCall === 'function') {
      const picked = await window.__agProjectCall('pickFiles', {}, 120000);
      if (rtState.disposed) return;
      if (picked && picked.ok) {
        if (!Array.isArray(picked.paths) || !picked.paths.length) return;
        await saveFilesDeltaForProject(project, (ops) => {
          const next = ops.slice();
          for (const p of picked.paths) {
            if (!next.some((x) => x.absPath === p || x.sourcePath === p)) {
              next.push({ action: 'add', sourcePath: p, name: p.split(/[\\/]/).pop() || p });
            }
          }
          return next;
        });
        return;
      }
    }
    openInstantNativeFilePicker(project);
  }

  async function addDroppedFilesToProject(project, fileList) {
    if (!project || !project.dirPath || !fileList || !fileList.length) return;
    const en = window.electronNative;
    const additions = [];
    for (const f of Array.from(fileList)) {
      if (!f) continue;
      let realPath = '';
      if (en && typeof en.getPathForFile === 'function') {
        try {
          realPath = en.getPathForFile(f) || '';
        } catch {}
      }
      if (!realPath && typeof f.path === 'string' && f.path) realPath = f.path;
      if (realPath) {
        additions.push({ action: 'add', sourcePath: realPath, name: f.name || realPath.split(/[\\/]/).pop() });
      } else if (typeof FileReader !== 'undefined' && f.size <= 25 * 1024 * 1024) {
        const b64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const s = String(reader.result || '');
            const i = s.indexOf(',');
            resolve(i >= 0 ? s.slice(i + 1) : '');
          };
          reader.onerror = () => resolve('');
          reader.readAsDataURL(f);
        });
        if (b64) additions.push({ action: 'addContent', name: f.name, base64: b64 });
      }
    }
    if (!additions.length) return;
    await saveFilesDeltaForProject(project, (ops) => {
      const next = ops.slice();
      for (const item of additions) {
        const p = item.sourcePath;
        if (p && next.some((x) => x.absPath === p || x.sourcePath === p)) continue;
        next.push(item);
      }
      return next;
    });
  }

  async function removeFileFromProject(project, relPath) {
    if (!project || !relPath) return;
    await saveFilesDeltaForProject(project, (ops) => ops.filter((x) => x.relPath !== relPath));
  }

  async function refreshProjectsContexts(projects) {
    if (typeof window.__agProjectCall !== 'function') return;
    const paths = projects.map((p) => p.dirPath).filter(Boolean);
    const projectIds = projects.map((p) => p.id).filter(Boolean);
    if (!paths.length && !projectIds.length) return;
    const res = await window.__agProjectCall('listContexts', { paths, projectIds }, 8000);
    if (rtState.disposed || !res || !res.ok) return;
    if (res.contexts) pState.projectsContextMap = Object.assign({}, pState.projectsContextMap, res.contexts);
    if (res.projectMtimes) pState.projectsNativeMtimeMap = Object.assign({}, pState.projectsNativeMtimeMap, res.projectMtimes);
    if (rtState.projectsViewOpen) renderProjectsView();
  }


  return {
    clearNewProjectWatcher,
    decodeFileUriToPath,
    formatShortHomePath,
    formatProjectTimeAgo,
    resolveProjectsStoreAndBindings,
    collectProjectConversations,
    resolveProjectManagementService,
    getRawNativeProjectRecord,
    renameNativeProject,
    archiveNativeProject,
    deleteNativeProject,
    openNativeProjectSettings,
    closeProjectActionMenu,
    renderProjectActionMenu,
    openProjectActionMenu,
    openRenameProjectModal,
    renderRenameProjectModal,
    collectNativeProjects,
    saveProjectContextDelta,
    saveFilesDeltaForProject,
    pickAndAddFolderToProject,
    removeExtraFolderFromProject,
    openInstantNativeFilePicker,
    pickAndAddFilesToProject,
    addDroppedFilesToProject,
    removeFileFromProject,
    refreshProjectsContexts,
  };
}
