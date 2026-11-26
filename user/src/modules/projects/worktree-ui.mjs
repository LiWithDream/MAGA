/**
 * Worktree UI Controller for Topbar Switcher (#agy-wt-menu), Cockpit Worktrees Strip,
 * and Cached Per-Conversation Branch Badges (Zero per-row RPCs).
 */
const WT_MENU_ID = 'agy-wt-menu';
const CONV_MAP_TTL_MS = 8000;
const REPO_WT_TTL_MS = 10000;

const SVG_WT_BRANCH =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="4.2" r="1.7"/><circle cx="5" cy="11.8" r="1.7"/><circle cx="11.5" cy="6.2" r="1.7"/><path d="M5 5.9v4.2M11.5 7.9c0 2-1.5 2.4-3.8 2.4H6.7"/></svg>';
const SVG_WT_CHECK =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 8.4l3.1 3.1 6.5-6.8"/></svg>';
const SVG_WT_COPY =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V3.9A1.4 1.4 0 0 0 9.1 2.5H3.9A1.4 1.4 0 0 0 2.5 3.9v5.2a1.4 1.4 0 0 0 1.4 1.4h1.6"/></svg>';
const SVG_WT_FINDER =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.3a1.1 1.1 0 0 1 1.1-1.1h3.2l1.2 1.3h5.4A1.1 1.1 0 0 1 14 5.6v6.1a1.1 1.1 0 0 1-1.1 1.1H3.1A1.1 1.1 0 0 1 2 11.7V4.3z"/></svg>';

function normPathKey(p) {
  return String(p || '').replace(/[\\/]+$/, '').toLowerCase();
}

export function createWorktreeUiController(ctx) {
  const {
    L,
    rtState,
    pState,
    pHooks,
    escapeHtml,
    hooks,
  } = ctx;

  const formatShortHomePath = (...args) => pHooks.formatShortHomePath?.(...args) || String(args[0] || '');
  const resolveProjectsStoreAndBindings = (...args) => pHooks.resolveProjectsStoreAndBindings?.(...args) || {};
  const showProjectsFloatingNotice = (...args) => pHooks.showProjectsFloatingNotice?.(...args);
  const invalidateOverviewSnapshotCache = (...args) => ctx.invalidateOverviewSnapshotCache?.(...args);
  const scheduleSidebarSync = (...args) => hooks?.scheduleSidebarSync?.(...args);

  let menuOpen = false;
  let menuDocBound = false;
  let activeMenuContext = null;

  function notifyWorktreeChanged() {
    pHooks.onWorktreeMapChanged?.();
    scheduleSidebarSync();
  }

  function warmConvWorktreeMap(force = false) {
    if (rtState.disposed || typeof window.__agProjectCall !== 'function') return;
    const now = Date.now();
    if (!force && pState.convWorktreeMapFetchedAt && now - pState.convWorktreeMapFetchedAt < CONV_MAP_TTL_MS) return;
    if (pState.convWorktreeMapInFlight) return;
    pState.convWorktreeMapInFlight = true;
    Promise.resolve(window.__agProjectCall('getConvWorktreeMap', {}, 4000))
      .then((res) => {
        pState.convWorktreeMapInFlight = false;
        if (rtState.disposed || !res || !res.ok) return;
        const entries = res.entries && typeof res.entries === 'object' ? res.entries : {};
        pState.convWorktreeMapFetchedAt = Date.now();
        const sig = JSON.stringify(entries);
        if (sig !== pState.convWorktreeMapSig) {
          pState.convWorktreeMapSig = sig;
          pState.convWorktreeMap = entries;
          notifyWorktreeChanged();
        }
      })
      .catch(() => {
        pState.convWorktreeMapInFlight = false;
      });
  }

  function warmRepoWorktrees(dirPath, { includeStats = false, force = false } = {}) {
    if (rtState.disposed || !dirPath || typeof window.__agProjectCall !== 'function') return;
    const cached = pState.repoWorktreesMap[dirPath];
    const now = Date.now();
    if (!force && cached && (!includeStats || cached.hasStats) && now - cached.ts < REPO_WT_TTL_MS) {
      return;
    }
    const busyKey = `${dirPath}|${includeStats ? 1 : 0}`;
    if (pState.repoWorktreesBusyKeys.has(busyKey)) return;
    pState.repoWorktreesBusyKeys.add(busyKey);

    Promise.resolve(
      window.__agProjectCall('listRepoWorktrees', { dirPath, includeStats, force }, 6000)
    )
      .then((res) => {
        pState.repoWorktreesBusyKeys.delete(busyKey);
        if (rtState.disposed || !res || !res.ok) return;
        const prevStr = JSON.stringify(cached?.data?.worktrees || null);
        const nextStr = JSON.stringify(res.worktrees || null);
        pState.repoWorktreesMap[dirPath] = {
          ts: Date.now(),
          hasStats: includeStats || Boolean(cached?.hasStats),
          data: res,
        };
        if (force || prevStr !== nextStr) {
          notifyWorktreeChanged();
          if (menuOpen && activeMenuContext && activeMenuContext.project?.dirPath === dirPath) {
            renderTopbarWorktreeMenu(activeMenuContext.anchorEl, activeMenuContext);
          }
        }
      })
      .catch(() => {
        pState.repoWorktreesBusyKeys.delete(busyKey);
      });
  }

  function getConversationBranchBadge(cid) {
    if (!cid) return '';
    warmConvWorktreeMap(false);
    const rec = pState.convWorktreeMap && pState.convWorktreeMap[cid];
    const branch = rec && typeof rec.branch === 'string' ? rec.branch.trim() : '';
    if (!branch || branch === 'main' || branch === 'master') return '';
    return branch;
  }

  function filterAdvisoryCollisions(rawCids, curCid) {
    if (!Array.isArray(rawCids) || rawCids.length < 2) return [];
    const { store } = resolveProjectsStoreAndBindings();
    const state = store && typeof store.getState === 'function' ? store.getState() : null;
    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const curSum = curCid ? summaries[curCid] : null;
    const curParent =
      (curSum && (curSum.parentConversationId || curSum.trajectoryMetadata?.parentConversationId)) || '';

    return rawCids.filter((otherCid) => {
      if (!otherCid || otherCid === curCid) return false;
      if (curParent && otherCid === curParent) return false;
      const otherSum = summaries[otherCid];
      const otherParent =
        (otherSum && (otherSum.parentConversationId || otherSum.trajectoryMetadata?.parentConversationId)) || '';
      if (otherParent && (otherParent === curCid || (curParent && otherParent === curParent))) return false;
      return true;
    });
  }

  function resolveConvWorktreeDisplay(projectDir, cid) {
    warmConvWorktreeMap(false);
    if (projectDir) warmRepoWorktrees(projectDir, { includeStats: false });

    const repoData = projectDir ? pState.repoWorktreesMap[projectDir]?.data || null : null;
    const worktrees = Array.isArray(repoData?.worktrees) ? repoData.worktrees.filter((w) => !w.prunable) : [];
    const mainWt = worktrees.find((w) => w.isMain) || worktrees[0] || null;
    const convRec = cid && pState.convWorktreeMap ? pState.convWorktreeMap[cid] || null : null;

    let matchedWt = null;
    if (convRec && convRec.worktreePath) {
      if (worktrees.length > 0) {
        const wanted = normPathKey(convRec.worktreePath);
        matchedWt = worktrees.find((w) => normPathKey(w.realPath || w.path) === wanted) || null;
      } else {
        matchedWt = {
          realPath: convRec.worktreePath,
          path: convRec.worktreePath,
          branch: convRec.branch || '',
          isMain: false,
          isProtected: convRec.branch === 'main' || convRec.branch === 'master',
          collisionCids: [],
        };
      }
    }

    const activeWt = matchedWt || mainWt;
    const branch = String((activeWt && activeWt.branch) || (convRec && convRec.branch) || '').trim();
    const worktreePath = String((activeWt && (activeWt.realPath || activeWt.path)) || projectDir || '').trim();
    const isWorktree = Boolean(activeWt && !activeWt.isMain && worktreePath && normPathKey(worktreePath) !== normPathKey(projectDir));
    const isProtected = branch === 'main' || branch === 'master';
    const collisionCids = activeWt && !activeWt.isMain ? filterAdvisoryCollisions(activeWt.collisionCids, cid) : [];

    return {
      branch,
      worktreePath,
      mainDirPath: (repoData && repoData.mainDirPath) || projectDir || '',
      isWorktree,
      isProtected,
      source: convRec ? convRec.source : 'default',
      worktreeCount: worktrees.length,
      collisionCids,
      worktrees,
    };
  }

  function closeWorktreeMenu() {
    menuOpen = false;
    activeMenuContext = null;
    const menu = document.getElementById(WT_MENU_ID);
    if (menu) menu.remove();
    if (menuDocBound) {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onDocKeyDown, true);
      window.removeEventListener('resize', closeWorktreeMenu);
      menuDocBound = false;
    }
  }

  function onDocMouseDown(ev) {
    const t = ev && ev.target;
    if (t && t.closest && t.closest(`#${WT_MENU_ID}, #agy-conv-project-bar [data-ag-cpb-act="open-wt-menu"]`)) return;
    closeWorktreeMenu();
  }

  function onDocKeyDown(ev) {
    if (ev && ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeWorktreeMenu();
    }
  }

  function bindConvToWorktree(projectDir, cid, worktreePath, onAfterChange) {
    if (!projectDir || !cid || typeof window.__agProjectCall !== 'function') return;
    Promise.resolve(
      window.__agProjectCall('bindConversationWorktree', { dirPath: projectDir, cid, worktreePath }, 5000)
    )
      .then((res) => {
        if (rtState.disposed || !res || !res.ok) return;
        const nextMap = { ...pState.convWorktreeMap };
        if (!worktreePath) {
          delete nextMap[cid];
        } else {
          nextMap[cid] = {
            cid,
            worktreePath: res.worktreePath || worktreePath,
            branch: res.branch || '',
            repoRoot: projectDir,
            source: 'manual',
            updatedAt: Date.now(),
          };
        }
        pState.convWorktreeMap = nextMap;
        pState.convWorktreeMapSig = JSON.stringify(nextMap);
        pState.convWorktreeMapFetchedAt = Date.now();
        invalidateOverviewSnapshotCache();
        notifyWorktreeChanged();
        warmConvWorktreeMap(true);
        warmRepoWorktrees(projectDir, { includeStats: true, force: true });
        onAfterChange?.();
      })
      .catch(() => {});
  }

  function renderTopbarWorktreeMenu(anchorEl, opts) {
    const { project, curCid, onAfterChange } = opts;
    if (!anchorEl || !project?.dirPath || !document.body) {
      closeWorktreeMenu();
      return;
    }

    const display = resolveConvWorktreeDisplay(project.dirPath, curCid);
    const worktrees = display.worktrees || [];
    const activeNorm = normPathKey(display.worktreePath);

    let menu = document.getElementById(WT_MENU_ID);
    if (!menu) {
      menu = document.createElement('div');
      menu.id = WT_MENU_ID;
      menu.setAttribute('data-maga-own', '1');
      menu.setAttribute('data-ag-i18n-ignore', '1');
      menu.setAttribute('role', 'menu');
      menu.addEventListener('click', (ev) => {
        const autoBtn = ev.target?.closest?.('[data-ag-wt-auto]');
        if (autoBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          closeWorktreeMenu();
          bindConvToWorktree(project.dirPath, curCid, '', onAfterChange);
          return;
        }
        const finderBtn = ev.target?.closest?.('[data-ag-wt-finder]');
        if (finderBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const targetPath = finderBtn.getAttribute('data-ag-wt-finder') || '';
          closeWorktreeMenu();
          if (targetPath && typeof window.__agProjectCall === 'function') {
            window.__agProjectCall('revealFile', { dirPath: project.dirPath, targetPath, openFolder: true }, 5000);
          }
          return;
        }
        const copyBtn = ev.target?.closest?.('[data-ag-wt-copy]');
        if (copyBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const targetPath = copyBtn.getAttribute('data-ag-wt-copy') || '';
          closeWorktreeMenu();
          if (targetPath && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(targetPath).then(
              () => showProjectsFloatingNotice(L('已复制工作树路径', 'Worktree path copied')),
              () => {}
            );
          }
          return;
        }
        const pickBtn = ev.target?.closest?.('[data-ag-wt-bind]');
        if (pickBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const targetPath = pickBtn.getAttribute('data-ag-wt-bind') || '';
          closeWorktreeMenu();
          if (targetPath && curCid) {
            bindConvToWorktree(project.dirPath, curCid, targetPath, onAfterChange);
          }
          return;
        }
        const cockpitBtn = ev.target?.closest?.('[data-ag-wt-cockpit]');
        if (cockpitBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          closeWorktreeMenu();
          pHooks.openProjectsView?.(project.id);
        }
      });
      document.body.appendChild(menu);
    }

    const autoBtnHtml =
      curCid && display.source === 'manual'
        ? `<button type="button" class="ag-wt-auto-btn" data-ag-wt-auto="true" title="${escapeHtml(L('恢复按工具调用自动追踪', 'Restore automatic hook tracking'))}">${escapeHtml(L('自动追踪', 'Auto'))}</button>`
        : '';

    const rowsHtml = worktrees.length
      ? worktrees
          .map((wt) => {
            const wtPath = wt.realPath || wt.path;
            const isCur = normPathKey(wtPath) === activeNorm;
            const branchLabel = wt.branch || (wt.detached ? 'HEAD' : 'detached');
            const dirtyCount = Number(wt.git?.changedFiles || 0);
            const boundCount = Array.isArray(wt.boundCids) ? wt.boundCids.length : 0;
            const metaParts = [formatShortHomePath(wtPath)];
            if (wt.isProtected) metaParts.push(L('受保护主干', 'protected'));
            if (dirtyCount > 0) metaParts.push(L(`${dirtyCount} 修改`, `${dirtyCount} dirty`));
            if (wt.ahead > 0) metaParts.push(`↑${wt.ahead}`);
            if (boundCount > 0) metaParts.push(L(`${boundCount} 对话`, `${boundCount} chat${boundCount > 1 ? 's' : ''}`));

            return `<div class="ag-wt-row" data-current="${isCur ? 'true' : 'false'}" data-protected="${wt.isProtected ? 'true' : 'false'}">
              <button type="button" class="ag-wt-main" data-ag-wt-bind="${escapeHtml(wtPath)}" role="menuitem"${!curCid ? ' disabled' : ''}>
                <span class="ag-wt-ico">${SVG_WT_BRANCH}</span>
                <span class="ag-wt-info">
                  <span class="ag-wt-branch">${escapeHtml(branchLabel)}</span>
                  <span class="ag-wt-meta">${escapeHtml(metaParts.join(' · '))}</span>
                </span>
                ${isCur ? `<span class="ag-wt-check">${SVG_WT_CHECK}</span>` : ''}
              </button>
              <button type="button" class="ag-wt-act" data-ag-wt-finder="${escapeHtml(wtPath)}" title="${escapeHtml(L('在访达中打开', 'Reveal in Finder'))}" aria-label="${escapeHtml(L('在访达中打开', 'Reveal in Finder'))}">${SVG_WT_FINDER}</button>
              <button type="button" class="ag-wt-act" data-ag-wt-copy="${escapeHtml(wtPath)}" title="${escapeHtml(L('复制路径', 'Copy path'))}" aria-label="${escapeHtml(L('复制路径', 'Copy path'))}">${SVG_WT_COPY}</button>
            </div>`;
          })
          .join('')
      : `<div class="ag-wt-empty">${escapeHtml(L('正在读取 Git Worktrees…', 'Loading Git worktrees…'))}</div>`;

    const collisionBanner = display.collisionCids.length
      ? `<div class="ag-wt-warn">${escapeHtml(L('提示：另一场近期对话也在操作同一 worktree', 'Advisory: another active conversation shares this worktree'))}</div>`
      : '';

    menu.innerHTML =
      `<div class="ag-wt-hdr"><span>${escapeHtml(L('切换工作树 (Worktree)', 'Worktrees'))}</span>${autoBtnHtml}</div>` +
      collisionBanner +
      `<div class="ag-wt-list">${rowsHtml}</div>` +
      `<div class="ag-cpb-menu-sep"></div>` +
      `<button type="button" class="ag-cpb-menu-footer" data-ag-wt-cockpit="true">${escapeHtml(L('在项目驾驶舱管理 Worktrees…', 'Manage in Project Cockpit…'))}</button>`;

    const r = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth || 1200;
    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - 316));
    const top = Math.max(38, Math.round(r.bottom + 6));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${top}px`;

    if (!menuDocBound) {
      document.addEventListener('mousedown', onDocMouseDown, true);
      document.addEventListener('keydown', onDocKeyDown, true);
      window.addEventListener('resize', closeWorktreeMenu);
      menuDocBound = true;
    }
  }

  function openTopbarWorktreeMenu(anchorEl, opts) {
    if (!anchorEl || !opts?.project?.dirPath) return;
    if (menuOpen && activeMenuContext?.anchorEl === anchorEl) {
      closeWorktreeMenu();
      return;
    }
    menuOpen = true;
    activeMenuContext = { anchorEl, ...opts };
    renderTopbarWorktreeMenu(anchorEl, opts);
    warmRepoWorktrees(opts.project.dirPath, { includeStats: true, force: true });
  }

  function buildCockpitWorktreeStripHtml({ project, wsStatus }) {
    if (!project?.dirPath) return '';
    const repoCached = pState.repoWorktreesMap[project.dirPath]?.data;
    const worktrees = (
      Array.isArray(wsStatus?.worktrees) && wsStatus.worktrees.length
        ? wsStatus.worktrees
        : Array.isArray(repoCached?.worktrees)
          ? repoCached.worktrees
          : []
    ).filter((w) => !w.prunable);
    if (!worktrees.length) return '';

    const activePath =
      pState.pdActiveWorktreeByProj[project.dirPath] ||
      wsStatus?.activeWorktreePath ||
      project.dirPath;
    const activeNorm = normPathKey(activePath);
    const createOpen = Boolean(pState.pdWtCreateOpenByProj[project.dirPath]);
    const busy = Boolean(pState.pdWtBusyKey === project.dirPath);

    const chipsHtml = worktrees
      .map((wt) => {
        const wtPath = wt.realPath || wt.path;
        const isSel = normPathKey(wtPath) === activeNorm;
        const label = wt.branch || (wt.detached ? 'HEAD' : 'detached');
        const dirty = Number(wt.git?.changedFiles || 0);
        const ahead = Number(wt.ahead || 0);
        const boundCnt = Array.isArray(wt.boundCids) ? wt.boundCids.length : 0;
        const now = Date.now();
        const hasRecentBound = Array.isArray(wt.boundCids) && wt.boundCids.some((b) => b.updatedAt > 0 && now - b.updatedAt <= 600000);
        const canRemove = !wt.isMain && !wt.locked && !hasRecentBound;
        const isConfirming = pState.pdWtConfirmRemovePath && normPathKey(pState.pdWtConfirmRemovePath) === normPathKey(wtPath);

        const badges = [];
        if (dirty > 0) badges.push(`<span class="ag-pd-wt-dirty">${dirty}</span>`);
        if (ahead > 0) badges.push(`<span class="ag-pd-wt-ahead">↑${ahead}</span>`);
        if (boundCnt > 0) badges.push(`<span class="ag-pd-wt-bound">${boundCnt}c</span>`);

        const removeHtml = canRemove
          ? isConfirming
            ? `<button type="button" class="ag-pd-wt-del-confirm" data-ag-pd-wt-del-confirm="${escapeHtml(wtPath)}" title="${escapeHtml(L('确认删除此干净 worktree', 'Confirm remove clean worktree'))}"${busy ? ' disabled' : ''}>${escapeHtml(L('确认删', 'Confirm'))}</button>` +
              `<button type="button" class="ag-pd-wt-del-cancel" data-ag-pd-wt-del-cancel="true" title="${escapeHtml(L('取消', 'Cancel'))}">×</button>`
            : `<button type="button" class="ag-pd-wt-del" data-ag-pd-wt-del="${escapeHtml(wtPath)}" title="${escapeHtml(L('清理此 worktree', 'Remove worktree'))}" aria-label="${escapeHtml(L('清理 worktree', 'Remove worktree'))}">×</button>`
          : '';

        return `<div class="ag-pd-wt-chip-wrap" data-active="${isSel ? 'true' : 'false'}">
          <button type="button" class="ag-pd-wt-chip" data-ag-pd-wt-select="${escapeHtml(wtPath)}" data-active="${isSel ? 'true' : 'false'}" title="${escapeHtml(wtPath)}">
            ${SVG_WT_BRANCH}
            <span>${escapeHtml(label)}</span>
            ${badges.join('')}
          </button>
          ${removeHtml}
        </div>`;
      })
      .join('');

    const createFormHtml = createOpen
      ? `<form class="ag-pd-wt-create" data-ag-pd-wt-form="true">
          <select class="ag-pd-wt-type" data-ag-pd-wt-type="true" aria-label="Worktree branch type">
            <option value="feat">feat/</option>
            <option value="fix">fix/</option>
            <option value="perf">perf/</option>
            <option value="refactor">refactor/</option>
            <option value="docs">docs/</option>
            <option value="chore">chore/</option>
          </select>
          <input type="text" class="ag-pd-wt-slug" data-ag-pd-wt-slug="true" placeholder="${escapeHtml(L('输入分支 slug（如 auth-fix）', 'branch-slug'))}" maxlength="48" />
          <button type="submit" class="ag-pd-git-act-btn is-primary"${busy ? ' disabled' : ''}>${escapeHtml(busy ? L('创建中…', 'Creating…') : L('创建', 'Create'))}</button>
          <button type="button" class="ag-pd-git-act-btn" data-ag-pd-wt-create-cancel="true">${escapeHtml(L('取消', 'Cancel'))}</button>
        </form>`
      : '';

    const wfPolicy =
      pState.pdWorkflowPolicyByProj?.[project.dirPath] ||
      wsStatus?.workflowPolicy ||
      null;
    const curMode = wfPolicy?.mode || 'observe';
    const localGuard = Boolean(wfPolicy?.localGuardrailActive);

    const policyControlHtml = localGuard
      ? `<span class="ag-pd-wt-policy-lock" title="${escapeHtml(L('由仓库 .agents/hooks.json 接管强制保护', 'Enforced by repository .agents/hooks.json'))}">${escapeHtml(L('工作树 · 仓库护栏', 'Worktree · Repo Guard'))}</span>`
      : `<div class="ag-pd-wt-policy-seg" role="radiogroup" aria-label="${escapeHtml(L('Git 工作流保护级别', 'Git Workflow tier'))}">
          ${[
            ['observe', L('观察', 'Observe')],
            ['protect-main', L('护主干', 'Protect Main')],
            ['worktree-only', L('工作树', 'Worktree')],
          ]
            .map(
              ([m, lbl]) =>
                `<button type="button" class="ag-pd-wt-policy-btn" role="radio" data-ag-pd-wf-mode="${m}" aria-checked="${curMode === m ? 'true' : 'false'}"${busy ? ' disabled' : ''}>${escapeHtml(lbl)}</button>`
            )
            .join('')}
        </div>`;

    const policyBarHtml = `<div class="ag-pd-wt-policy-row" data-ag-pd-wf-policy="true">
      <span class="ag-pd-wt-policy-lbl">${escapeHtml(L('护栏策略', 'Guard'))}</span>
      ${policyControlHtml}
    </div>`;

    const showNudge =
      !localGuard &&
      curMode === 'observe' &&
      worktrees.length >= 2 &&
      !pState.pdWtNudgeDismissedByProj?.[project.dirPath];
    const nudgeHtml = showNudge
      ? `<div class="ag-pd-wt-nudge" data-ag-pd-wf-nudge="true">
          <span class="ag-pd-wt-nudge-txt">${escapeHtml(L('检测到多个并行 Worktree，建议开启护主干防误改', 'Multiple worktrees detected — protect main from accidental edits?'))}</span>
          <div class="ag-pd-wt-nudge-acts">
            <button type="button" class="ag-pd-wt-nudge-btn" data-ag-pd-wf-mode="protect-main">${escapeHtml(L('护主干', 'Protect Main'))}</button>
            <button type="button" class="ag-pd-wt-nudge-btn is-strong" data-ag-pd-wf-mode="worktree-only">${escapeHtml(L('工作树隔离', 'Worktree-Only'))}</button>
            <button type="button" class="ag-pd-wt-nudge-close" data-ag-pd-wf-nudge-dismiss="true" aria-label="${escapeHtml(L('忽略提示', 'Dismiss'))}">×</button>
          </div>
        </div>`
      : '';

    return `<div class="ag-pd-wt-wrap" data-ag-pd-wt-wrap="true">
      <div class="ag-pd-wt-bar">
        ${chipsHtml}
        <button type="button" class="ag-pd-wt-add" data-ag-pd-wt-create-toggle="true" title="${escapeHtml(L('新建隔离 worktree', 'New isolated worktree'))}">+ Worktree</button>
      </div>
      ${policyBarHtml}
      ${nudgeHtml}
      ${createFormHtml}
    </div>`;
  }

  function bindCockpitWorktreeEvents({ el, project, onRefreshStatus }) {
    if (!el || !project?.dirPath) return;

    el.querySelectorAll('[data-ag-pd-wt-select]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wtPath = btn.getAttribute('data-ag-pd-wt-select') || '';
        if (!wtPath) return;
        pState.pdActiveWorktreeByProj[project.dirPath] = wtPath;
        pState.pdDirtyExpanded = false;
        pState.pdExpandedCommitHash = '';
        pState.pdWtConfirmRemovePath = '';
        pHooks.renderProjectsView?.();
        onRefreshStatus?.(wtPath, true);
      });
    });

    const toggleCreate = el.querySelector('[data-ag-pd-wt-create-toggle]');
    if (toggleCreate) {
      toggleCreate.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pState.pdWtCreateOpenByProj[project.dirPath] = !pState.pdWtCreateOpenByProj[project.dirPath];
        pState.pdWtConfirmRemovePath = '';
        pHooks.renderProjectsView?.();
        if (pState.pdWtCreateOpenByProj[project.dirPath]) {
          el.querySelector('[data-ag-pd-wt-slug]')?.focus?.();
        }
      });
    }

    const cancelCreate = el.querySelector('[data-ag-pd-wt-create-cancel]');
    if (cancelCreate) {
      cancelCreate.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pState.pdWtCreateOpenByProj[project.dirPath] = false;
        pHooks.renderProjectsView?.();
      });
    }

    const createForm = el.querySelector('[data-ag-pd-wt-form]');
    if (createForm) {
      createForm.addEventListener('submit', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pState.pdWtBusyKey || typeof window.__agProjectCall !== 'function') return;
        const type = createForm.querySelector('[data-ag-pd-wt-type]')?.value || 'feat';
        const slug = String(createForm.querySelector('[data-ag-pd-wt-slug]')?.value || '').trim().toLowerCase();
        if (!slug) {
          showProjectsFloatingNotice(L('请输入有效的分支 slug', 'Enter a branch slug'));
          return;
        }
        pState.pdWtBusyKey = project.dirPath;
        pHooks.renderProjectsView?.();
        Promise.resolve(
          window.__agProjectCall('createRepoWorktree', { dirPath: project.dirPath, type, slug }, 10000)
        )
          .then((res) => {
            pState.pdWtBusyKey = '';
            if (rtState.disposed) return;
            if (!res || !res.ok) {
              showProjectsFloatingNotice(res?.detail || res?.error || L('创建 worktree 失败', 'Failed to create worktree'));
              pHooks.renderProjectsView?.();
              return;
            }
            pState.pdWtCreateOpenByProj[project.dirPath] = false;
            pState.pdActiveWorktreeByProj[project.dirPath] = res.worktreePath;
            showProjectsFloatingNotice(L(`已创建 ${res.branch}`, `Created ${res.branch}`));
            warmRepoWorktrees(project.dirPath, { includeStats: true, force: true });
            onRefreshStatus?.(res.worktreePath, true);
            pHooks.renderProjectsView?.();
          })
          .catch(() => {
            pState.pdWtBusyKey = '';
            pHooks.renderProjectsView?.();
          });
      });
    }

    el.querySelectorAll('[data-ag-pd-wt-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pState.pdWtConfirmRemovePath = btn.getAttribute('data-ag-pd-wt-del') || '';
        pHooks.renderProjectsView?.();
      });
    });

    el.querySelectorAll('[data-ag-pd-wt-del-cancel]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pState.pdWtConfirmRemovePath = '';
        pHooks.renderProjectsView?.();
      });
    });

    el.querySelectorAll('[data-ag-pd-wf-mode]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const mode = btn.getAttribute('data-ag-pd-wf-mode') || '';
        if (!mode || pState.pdWtBusyKey || typeof window.__agProjectCall !== 'function') return;
        pState.pdWtBusyKey = project.dirPath;
        pHooks.renderProjectsView?.();
        Promise.resolve(
          window.__agProjectCall('setGitWorkflowPolicy', { dirPath: project.dirPath, mode }, 5000)
        )
          .then((res) => {
            pState.pdWtBusyKey = '';
            if (rtState.disposed) return;
            if (!res || !res.ok) {
              const errMsg =
                res?.error === 'policy_locked' || res?.retryable
                  ? L('策略配置正忙（锁冲突），请重试', 'Policy busy (locked), please retry')
                  : res?.error || L('切换工作流策略失败', 'Failed to update workflow mode');
              showProjectsFloatingNotice(errMsg);
              pHooks.renderProjectsView?.();
              return;
            }
            pState.pdWorkflowPolicyByProj[project.dirPath] = {
              mode,
              source: 'project',
              localGuardrailActive: false,
            };
            const modeLbl =
              mode === 'worktree-only'
                ? L('工作树隔离', 'Worktree-Only')
                : mode === 'protect-main'
                  ? L('护主干', 'Protect Main')
                  : L('观察', 'Observe');
            showProjectsFloatingNotice(L(`Git 护栏：${modeLbl}`, `Git guard: ${modeLbl}`));
            onRefreshStatus?.('', true);
            pHooks.renderProjectsView?.();
          })
          .catch(() => {
            pState.pdWtBusyKey = '';
            pHooks.renderProjectsView?.();
          });
      });
    });

    el.querySelectorAll('[data-ag-pd-wf-nudge-dismiss]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pState.pdWtNudgeDismissedByProj[project.dirPath] = true;
        pHooks.renderProjectsView?.();
      });
    });

    el.querySelectorAll('[data-ag-pd-wt-del-confirm]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wtPath = btn.getAttribute('data-ag-pd-wt-del-confirm') || '';
        if (!wtPath || pState.pdWtBusyKey || typeof window.__agProjectCall !== 'function') return;
        pState.pdWtBusyKey = project.dirPath;
        pHooks.renderProjectsView?.();
        Promise.resolve(
          window.__agProjectCall(
            'removeRepoWorktree',
            { dirPath: project.dirPath, worktreePath: wtPath, deleteBranch: true },
            10000
          )
        )
          .then((res) => {
            pState.pdWtBusyKey = '';
            pState.pdWtConfirmRemovePath = '';
            if (rtState.disposed) return;
            if (!res || !res.ok) {
              showProjectsFloatingNotice(res?.detail || res?.error || L('删除 worktree 失败（可能存在未提交改动）', 'Failed to remove worktree'));
              pHooks.renderProjectsView?.();
              return;
            }
            if (normPathKey(pState.pdActiveWorktreeByProj[project.dirPath]) === normPathKey(wtPath)) {
              delete pState.pdActiveWorktreeByProj[project.dirPath];
            }
            showProjectsFloatingNotice(L(`已移除 ${res.branch || 'worktree'}`, `Removed ${res.branch || 'worktree'}`));
            warmRepoWorktrees(project.dirPath, { includeStats: true, force: true });
            onRefreshStatus?.(project.dirPath, true);
            pHooks.renderProjectsView?.();
          })
          .catch(() => {
            pState.pdWtBusyKey = '';
            pState.pdWtConfirmRemovePath = '';
            pHooks.renderProjectsView?.();
          });
      });
    });
  }

  function teardown() {
    closeWorktreeMenu();
    pState.repoWorktreesBusyKeys?.clear?.();
    pState.convWorktreeMapInFlight = false;
    pState.pdWtBusyKey = '';
    pState.pdWtConfirmRemovePath = '';
  }

  return {
    warmConvWorktreeMap,
    warmRepoWorktrees,
    getConversationBranchBadge,
    resolveConvWorktreeDisplay,
    openTopbarWorktreeMenu,
    closeWorktreeMenu,
    buildCockpitWorktreeStripHtml,
    bindCockpitWorktreeEvents,
    teardown,
  };
}
