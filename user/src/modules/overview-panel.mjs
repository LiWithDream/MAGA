/**
 * Enhanced Right Overview Panel (compact shortcuts, live context & cache, dual-window quotas, subagents & skills).
 */
export function createOverviewPanelModule(rt, metricsQuota) {
  const { FEAT, L, state: rtState, later, cancelLater, escapeHtml, hooks } = rt;
  const {
    SVG_COMPACT_ICON,
    SVG_COMPACT_DONE,
    detectCompactStatus,
    triggerConversationCompact,
    fmtCompactTokens,
    getActiveCascadeId,
    isPaneCurrentlyRunning,
    extractCompactLabels,
    discoverQuotaService,
    isOverviewPanelVisible,
    scheduleAutoQuotaRefresh,
    fetchQuotaSummary,
    formatResetLabel,
    localizeGroupShortName,
    detectDefaultGroupIndex,
    formatQuotaUsedPctStr,
  } = metricsQuota;

  const resolveProjectsStoreAndBindings = (...args) => hooks.resolveProjectsStoreAndBindings?.(...args) || {};
  const collectNativeProjects = (...args) => hooks.collectNativeProjects?.(...args) || [];
  const decodeFileUriToPath = (...args) => hooks.decodeFileUriToPath?.(...args) || '';
  const formatShortHomePath = (...args) => hooks.formatShortHomePath?.(...args) || '';
  const showProjectsFloatingNotice = (...args) => hooks.showProjectsFloatingNotice?.(...args);
  const openProjectInstructionsModal = (...args) => hooks.openProjectInstructionsModal?.(...args);
  const openConversationFromProject = (...args) => hooks.openConversationFromProject?.(...args);

  /* ==========================================================================
   * 11. Enhanced Right Overview Panel (`claudeUxOverviewPanel`)
   *     - Re-styles native quick shortcuts into a 4-tile toolbar via CSS `order: 0`
   *     - Keeps native Artifact section right below shortcuts (`order: 1`)
   *     - Appends `#ag-claude-ov-sections` as last DOM child (`order: 2`, React-safe)
   *     - Combines Environment, T3 Context/Cache breakdown + Compact, Google Blue
   *       dual-window Used-% Quotas + time cursor, Side chats, and Connectors list
   * ========================================================================== */
  const OV_COLLAPSE_STORAGE_KEY = 'ag_claude_ov_collapse_v2';
  const OV_DEFAULT_OPEN = {
    environment: true,
    context: true,
    quota: true,
    otherPools: true,
    sidechats: true,
    connectors: false,
    invMemory: false,
    invSkills: false,
    invAgents: false,
    connectorsExtra: false
  };
  let ovCollapseState = (() => {
    try {
      const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(OV_COLLAPSE_STORAGE_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') return Object.assign({}, OV_DEFAULT_OPEN, parsed);
    } catch {}
    return Object.assign({}, OV_DEFAULT_OPEN);
  })();
  function persistOvCollapseState() {
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.setItem(OV_COLLAPSE_STORAGE_KEY, JSON.stringify(ovCollapseState));
      }
    } catch {}
  }

  const ovSnapshotCache = new Map(); // dirKey -> { ts, data }
  const ovSnapshotInFlight = new Map(); // dirKey -> Promise
  let ovLastQuotaAutoTryTs = 0;
  let ovQuotaSpinTimer = 0;
  let ovRefreshSpinUntil = 0;
  let ovMinuteTickerId = null;
  let ovWorkspaceMemo = { ts: 0, key: '', value: null };
  let ovCompactMemo = { ts: 0, key: '', status: 'idle' };

  function invalidateOverviewSnapshotCache() {
    ovSnapshotCache.clear();
    ovWorkspaceMemo = { ts: 0, key: '', value: null };
    if (!rtState.disposed && FEAT.overviewPanel) {
      const sec = document.getElementById('ag-claude-ov-sections');
      if (sec) sec.removeAttribute('data-render-sig');
      renderOverviewPanel(true);
    }
  }

  function fmtOvTokens(n) {
    const v = Number(n) || 0;
    if (!Number.isFinite(v) || v <= 0) return '0';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
    if (v >= 1000) return fmtCompactTokens(v);
    return String(Math.round(v));
  }

  function ovQuotaUsedColor(usedPct) {
    if (usedPct >= 90) return '#DC2626';
    if (usedPct >= 75) return '#D97706';
    return 'var(--ag-ov-blue, #2F75C3)';
  }

  function localizeQuotaWindowTag(rawWin, fallbackName = '') {
    const win = String(rawWin || '').trim().toLowerCase();
    if (win === '5h') return L('5 小时', '5h');
    if (win === 'weekly') return L('每周', 'Weekly');
    if (win === 'daily') return L('每日', 'Daily');
    return fallbackName || L('配额', 'Quota');
  }

  function readOverviewModelLabel() {
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    const trigger = inputBox && inputBox.querySelector('button[data-testid="model-selector-trigger"]');
    return ((trigger ? trigger.textContent : '') || '').trim();
  }

  function computeWindowElapsedPct(bucket, usedPct) {
    const win = String(bucket?.window || '').trim().toLowerCase();
    if (win === '5h' && usedPct === 0 && !bucket?.description) return null;
    const secStr = bucket?.resetTime && bucket.resetTime.seconds !== undefined ? String(bucket.resetTime.seconds) : '';
    const resetSec = secStr ? Number(secStr) : 0;
    if (!resetSec || Number.isNaN(resetSec)) return null;
    const totalSec = win === '5h' ? 5 * 3600 : win === 'daily' ? 86400 : win === 'weekly' ? 7 * 86400 : 0;
    if (!totalSec) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const remSec = Math.max(0, Math.min(totalSec, resetSec - nowSec));
    const elapsedFrac = Math.max(0, Math.min(1, 1 - remSec / totalSec));
    return Math.round(elapsedFrac * 100);
  }

  function resolveActiveOverviewWorkspace(force = false) {
    const curCid = getActiveCascadeId();
    const locSearch = String(window.location.search || '');
    const memoKey = `${curCid}|${locSearch}`;
    const now = Date.now();
    if (!force && ovWorkspaceMemo.value && ovWorkspaceMemo.key === memoKey && now - ovWorkspaceMemo.ts < 400) {
      return ovWorkspaceMemo.value;
    }

    let urlPid = '';
    try {
      urlPid = new URLSearchParams(locSearch).get('project') || '';
    } catch {}
    const { store } = resolveProjectsStoreAndBindings();
    const state = store && typeof store.getState === 'function' ? store.getState() : null;
    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const sum = curCid ? summaries[curCid] : null;
    const projects = typeof collectNativeProjects === 'function' ? collectNativeProjects() : [];
    const norm = (p) => String(p || '').replace(/\/+$/, '').toLowerCase();

    const pid = (sum && (sum.projectId || (sum.trajectoryMetadata && sum.trajectoryMetadata.projectId))) || urlPid || '';
    let wsDir = '';
    if (sum) {
      const wsList = (sum.workspaces || []).concat((sum.trajectoryMetadata && sum.trajectoryMetadata.workspaces) || []);
      for (const ws of wsList) {
        const rawUri = ws && (ws.workspaceFolderAbsoluteUri || ws.uri || ws);
        if (typeof rawUri === 'string' && rawUri.trim()) {
          const decoded = decodeFileUriToPath(rawUri).replace(/\/+$/, '');
          if (decoded) {
            wsDir = decoded;
            break;
          }
        }
      }
    }

    let matchedProj = pid ? projects.find((p) => p.id === pid) : null;
    if (!matchedProj && wsDir) {
      matchedProj = projects.find((p) => norm(p.dirPath) === norm(wsDir)) || null;
    }
    const dirPath = (matchedProj && matchedProj.dirPath) || wsDir || '';
    const project = matchedProj || (dirPath ? { id: '', name: dirPath.split(/[\\/]/).filter(Boolean).pop() || dirPath, dirPath } : null);
    const result = { cid: curCid, dirPath, project, state, summaries };
    ovWorkspaceMemo = { ts: now, key: memoKey, value: result };
    return result;
  }

  function getOverviewCompactStatus(curCid, force = false) {
    const key = `${curCid}|${rtState.manualCompactPending.cascadeId}:${rtState.manualCompactPending.startedAt}`;
    const now = Date.now();
    if (!force && ovCompactMemo.key === key && now - ovCompactMemo.ts < 350) {
      return ovCompactMemo.status;
    }
    const status = detectCompactStatus(curCid);
    ovCompactMemo = { ts: now, key, status };
    return status;
  }

  function ensureOverviewSnapshot(dirPath, force = false) {
    if (typeof window.__agProjectCall !== 'function') return null;
    const key = String(dirPath || '').trim() || '__global__';
    const now = Date.now();
    const cached = ovSnapshotCache.get(key);
    if (!force && cached && now - cached.ts < 15000) return cached.data;
    if (!ovSnapshotInFlight.has(key)) {
      const p = Promise.resolve(window.__agProjectCall('getOverviewSnapshot', { dirPath: dirPath || '' }, 6000))
        .then((res) => {
          if (rtState.disposed || !res || !res.ok) return;
          ovSnapshotCache.set(key, { ts: Date.now(), data: res });
          if (FEAT.overviewPanel) renderOverviewPanel(false);
        })
        .catch(() => {})
        .finally(() => {
          ovSnapshotInFlight.delete(key);
        });
      ovSnapshotInFlight.set(key, p);
    }
    return cached ? cached.data : null;
  }

  function collectMergedSidechats(curCid, stats, summaries) {
    const byId = new Map();
    if (stats && Array.isArray(stats.children)) {
      for (const ch of stats.children) {
        if (!ch || !ch.id) continue;
        byId.set(ch.id, Object.assign({}, ch));
      }
    }
    if (curCid && summaries && typeof summaries === 'object') {
      for (const [id, sum] of Object.entries(summaries)) {
        if (!sum || id === curCid) continue;
        const parentId = sum.parentConversationId || (sum.trajectoryMetadata && sum.trajectoryMetadata.parentConversationId) || '';
        if (parentId !== curCid) continue;
        const title = String((sum.annotations && sum.annotations.title) || sum.summary || '').trim();
        const agentName = String(sum.agentName || (sum.trajectoryMetadata && sum.trajectoryMetadata.agentName) || '').trim();
        const status = sum.status ?? '';
        const running = Boolean(
          !sum.killed &&
            (Boolean(sum.notFullyIdle) ||
              status === 2 ||
              status === 3 ||
              status === 4 ||
              /RUNNING|IN_PROGRESS|ACTIVE/i.test(String(status)))
        );
        const prev = byId.get(id) || { id, calls: 0, outTok: 0 };
        byId.set(id, Object.assign({}, prev, {
          title: title || prev.title || '',
          agentName: agentName || prev.agentName || '',
          running: running || Boolean(prev.running),
          killed: Boolean(sum.killed || prev.killed)
        }));
      }
    }
    return Array.from(byId.values()).slice(0, 12);
  }

  function buildOvChevronSvg(isOpen) {
    return `<svg class="ag-ov-chev" data-open="${isOpen ? 'true' : 'false'}" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function onOverviewSectionsClick(e) {
    if (rtState.disposed || !FEAT.overviewPanel) return;
    const collapseBtn = e.target.closest('[data-ag-ov-collapse]');
    if (collapseBtn) {
      e.preventDefault();
      e.stopPropagation();
      const key = collapseBtn.getAttribute('data-ag-ov-collapse');
      if (key) {
        ovCollapseState[key] = !ovCollapseState[key];
        persistOvCollapseState();
        renderOverviewPanel(true);
      }
      return;
    }

    const actionEl = e.target.closest('[data-ag-ov-action]');
    if (!actionEl) return;
    e.preventDefault();
    e.stopPropagation();
    const action = actionEl.getAttribute('data-ag-ov-action');
    const ws = resolveActiveOverviewWorkspace(true);

    if (action === 'finder') {
      if (ws.dirPath && typeof window.__agProjectCall === 'function') {
        window.__agProjectCall('revealFile', { targetPath: ws.dirPath, dirPath: ws.dirPath, openFolder: true }, 5000);
      }
    } else if (action === 'copy-path') {
      if (ws.dirPath && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(ws.dirPath).then(
          () => showProjectsFloatingNotice(L('已复制工作区路径', 'Workspace path copied')),
          () => {}
        );
      }
    } else if (action === 'edit-rules') {
      if (ws.project && ws.project.dirPath) {
        openProjectInstructionsModal(ws.project);
      } else {
        const globalPath = actionEl.getAttribute('data-path') || '';
        if (globalPath && typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('revealFile', { targetPath: globalPath, dirPath: '' }, 5000);
        }
      }
    } else if (action === 'compact') {
      if (!actionEl.disabled) {
        ovCompactMemo = { ts: 0, key: '', status: 'idle' };
        triggerConversationCompact();
      }
    } else if (action === 'refresh-quota') {
      ovRefreshSpinUntil = Date.now() + 600;
      const icon = actionEl.querySelector('svg');
      if (icon) {
        icon.classList.remove('ag-ov-spinning');
        void icon.offsetWidth;
        icon.classList.add('ag-ov-spinning');
      }
      cancelLater(ovQuotaSpinTimer);
      ovQuotaSpinTimer = later(() => {
        ovQuotaSpinTimer = 0;
        ovRefreshSpinUntil = 0;
        const curIcon = document.querySelector('#ag-claude-ov-sections [data-ag-ov-action="refresh-quota"] svg');
        if (curIcon) curIcon.classList.remove('ag-ov-spinning');
      }, 620);
      discoverQuotaService(true);
      fetchQuotaSummary(true);
    } else if (action === 'sidechat') {
      const cid = actionEl.getAttribute('data-cid') || '';
      if (cid) openConversationFromProject(cid);
    } else if (action === 'reveal-path') {
      const targetPath = actionEl.getAttribute('data-path') || '';
      if (targetPath && typeof window.__agProjectCall === 'function') {
        window.__agProjectCall('revealFile', { targetPath, dirPath: ws.dirPath || '' }, 5000);
      }
    } else if (action === 'open-plugins') {
      const pluginsBtn = document.querySelector('button[data-testid="overview-panel-row-plugins"]');
      if (pluginsBtn) pluginsBtn.click();
    } else if (action === 'open-skills-dir') {
      if (typeof window.__agProjectCall === 'function') {
        window.__agProjectCall('openSkillsDir', {}, 5000);
      }
    } else if (action === 'open-agents-dir') {
      if (typeof window.__agProjectCall === 'function') {
        window.__agProjectCall('openAgentsDir', {}, 5000);
      }
    } else if (action === 'toggle-connectors-more') {
      ovCollapseState.connectorsExtra = !ovCollapseState.connectorsExtra;
      persistOvCollapseState();
      renderOverviewPanel(true);
    }
  }

  function renderOverviewPanel(force = false) {
    if (rtState.disposed || !FEAT.overviewPanel) return;
    const sectionsEl = document.getElementById('ag-claude-ov-sections');
    if (!sectionsEl) return;

    const ws = resolveActiveOverviewWorkspace(force);
    const snap = ensureOverviewSnapshot(ws.dirPath, false);
    const curCid = ws.cid;
    const rawM = window.__ag_last_metrics;
    const hasCtx = Boolean(rawM && rawM.hasData && (!curCid || rawM.cascadeId === curCid) && rawM.stats);
    const stats = hasCtx ? rawM.stats : null;
    const compactStatus = getOverviewCompactStatus(curCid, force);
    const paneRunning = isPaneCurrentlyRunning();
    if (rtState.wasOvPaneGenerating && !paneRunning) {
      scheduleAutoQuotaRefresh(500, 3000);
    }
    rtState.wasOvPaneGenerating = paneRunning;
    const { preUsed, limitLabel, summaryLabel, summaryPct } = extractCompactLabels(rtState.latestCtxState, curCid);

    const groups = rtState.cachedQuotaGroups || [];
    const curModelLabel = readOverviewModelLabel();
    const ovPrimaryIdx = groups.length > 0 ? detectDefaultGroupIndex(groups) : 0;
    const minuteBucket = Math.floor(Date.now() / 60000);

    const mergedChildren = collectMergedSidechats(curCid, stats, ws.summaries);
    const snapSig = snap
      ? `${snap.workspace?.dirPath}|${snap.workspace?.git?.branch}:${snap.workspace?.git?.added}:${snap.workspace?.git?.deleted}:${snap.workspace?.git?.changedFiles}|r${snap.rules?.length}|s${snap.skills?.total}|a${snap.agents?.total}|c${snap.connectors?.length}`
      : 'nosnap';
    const ctxSig = stats
      ? `${stats.ctx}/${stats.limit}|${stats.cached}|${stats.uncached}|${stats.lastCacheRate}|${stats.sessionCacheRate}|${stats.turns}/${stats.calls}|${stats.totalThink}|${stats.totalResp}|${compactStatus}|${paneRunning ? 1 : 0}|${summaryLabel}`
      : `noctx|${compactStatus}|${paneRunning ? 1 : 0}`;
    const quotaSig = `${rtState.cachedUserTierName}|${ovPrimaryIdx}|${curModelLabel}|m${minuteBucket}|${groups
      .map((g) => `${g.displayName}:${(g.buckets || []).map((b) => `${b.window}=${b.remaining?.value ?? b.remainingFraction}:${b.resetTime?.seconds ?? ''}`).join(',')}`)
      .join(';')}`;
    const subSig = mergedChildren.map((c) => `${c.id}:${c.running ? 1 : 0}:${c.title}:${c.calls}`).join('|');
    const colSig = Object.keys(OV_DEFAULT_OPEN)
      .map((k) => (ovCollapseState[k] ? '1' : '0'))
      .join('');
    const renderSig = `${FEAT.i18n ? 'zh' : 'en'}||${curCid}||${ws.dirPath}||${snapSig}||${ctxSig}||${quotaSig}||${subSig}||${colSig}`;

    if (!force && sectionsEl.getAttribute('data-render-sig') === renderSig) return;
    sectionsEl.setAttribute('data-render-sig', renderSig);

    /* ---- 1. Environment Card ---- */
    const git = snap && snap.workspace && snap.workspace.git ? snap.workspace.git : null;
    const gitPillHtml = git
      ? `<span class="ag-ov-git-pill">${escapeHtml(git.branch)}${
          git.added > 0 || git.deleted > 0
            ? ` · <span class="ag-ov-git-add">+${git.added}</span> <span class="ag-ov-git-del">-${git.deleted}</span>`
            : git.changedFiles > 0
              ? ` · <span class="ag-ov-muted">${git.changedFiles} ${L('变更', 'chg')}</span>`
              : ''
        }</span>`
      : '';
    const dirName = (ws.project && ws.project.name) || (snap && snap.workspace && snap.workspace.name) || '';
    const shortDir = ws.dirPath ? formatShortHomePath(ws.dirPath) : '';
    const folderRowHtml = ws.dirPath
      ? `<button type="button" class="ag-ov-row-btn ag-ov-folder-btn" data-ag-ov-action="copy-path" title="${escapeHtml(ws.dirPath)}">
          <span class="ag-ov-row-left">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 4.2a1 1 0 0 1 1-1h3.5l1.3 1.4H13a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.2z"/></svg>
            <span class="ag-ov-row-title">${escapeHtml(dirName)}</span>
          </span>
          <span class="ag-ov-mono-muted">${escapeHtml(shortDir)}</span>
        </button>`
      : `<div class="ag-ov-empty-inline ag-ov-env-pad">${L('未绑定项目目录', 'No workspace folder bound')}</div>`;

    const rulesList = (snap && Array.isArray(snap.rules) && snap.rules) || [];
    const hasGlobalRule = rulesList.some((r) => r.scope === 'global');
    const hasProjRule = rulesList.some((r) => r.scope === 'project');
    const hasPluginRule = rulesList.some((r) => r.scope === 'plugin');
    const globalRulePath = (rulesList.find((r) => r.scope === 'global') || {}).path || '';
    const scopeParts = [];
    if (hasGlobalRule) scopeParts.push(L('全局', 'Global'));
    if (hasProjRule) scopeParts.push(L('项目', 'Project'));
    if (hasPluginRule) scopeParts.push(L('插件', 'Plugin'));
    const ruleSummary = scopeParts.length
      ? `${scopeParts.join(' + ')} · ${L(`${rulesList.length} 份`, String(rulesList.length))}`
      : L('未配置', 'None');
    const canEditRules = Boolean((ws.project && ws.project.dirPath) || globalRulePath);

    const envCardHtml = `
      <section class="ag-ov-card" data-ov-card="environment">
        <div class="ag-ov-card-hdr">
          <button type="button" class="ag-ov-hdr-toggle" data-ag-ov-collapse="environment">
            ${buildOvChevronSvg(ovCollapseState.environment)}
            <span>${L('工作环境', 'Environment')}</span>
          </button>
          ${
            ws.dirPath
              ? `<button type="button" class="ag-ov-hdr-action" data-ag-ov-action="finder">Finder ↗</button>`
              : ''
          }
        </div>
        ${
          ovCollapseState.environment
            ? `<div class="ag-ov-card-body ag-ov-env-body">
                <div class="ag-ov-kv-row ag-ov-env-pad">
                  <span class="ag-ov-row-left">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.4"/><path d="M5.5 13.5h5M8 11v2.5" stroke-linecap="round"/></svg>
                    <span>${L('本机工作区', 'This computer')}</span>
                  </span>
                  ${gitPillHtml}
                </div>
                ${folderRowHtml}
                <div class="ag-ov-rule-pill">
                  <span class="ag-ov-row-left">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 2h5.2l3.3 3.3V14H4V2z"/><path d="M9 2v3.5h3.5M6 8.5h4M6 11h3" stroke-linecap="round"/></svg>
                    <span class="ag-ov-mono">AGENTS.md</span>
                    <span class="ag-ov-muted ag-ov-trunc">${escapeHtml(ruleSummary)}</span>
                  </span>
                  ${
                    canEditRules
                      ? `<button type="button" class="ag-ov-mini-btn" data-ag-ov-action="edit-rules" data-path="${escapeHtml(globalRulePath)}">${ws.project && ws.project.dirPath ? L('编辑', 'Edit') : L('查看', 'Open')}</button>`
                      : ''
                  }
                </div>
              </div>`
            : ''
        }
      </section>`;

    /* ---- 2. Context Card (T3 Style) ---- */
    let topPctText = hasCtx ? `${stats.pct}% ${L('已用', 'used')}` : L('暂无消耗', 'No data');
    let topRatioText = hasCtx ? `${fmtOvTokens(stats.ctx)} / ${stats.limitStr}` : '';
    let topPctLevel = '';
    if (stats) {
      if (stats.pct >= 90) topPctLevel = 'crit';
      else if (stats.pct >= 75) topPctLevel = 'warn';
    }

    const limitTok = stats ? Math.max(1, Number(stats.limit) || 1) : 1;
    const shareDenom = stats
      ? Math.max(limitTok, Number(stats.ctx || 0), Number(stats.cached || 0) + Number(stats.uncached || 0))
      : 1;
    let cachedBarW = stats ? Math.min(100, (Number(stats.cached || 0) / shareDenom) * 100) : 0;
    let uncachedBarW = stats ? Math.min(100 - cachedBarW, (Number(stats.uncached || 0) / shareDenom) * 100) : 0;
    let compactBtnHtml = '';

    if (compactStatus === 'compacting') {
      topPctText = preUsed ? L(`正在压缩 ${preUsed}…`, `Compacting ${preUsed}…`) : L('正在压缩…', 'Compacting…');
      topRatioText = '';
      topPctLevel = '';
      cachedBarW = 14;
      uncachedBarW = 0;
      compactBtnHtml = `<button type="button" class="ag-ov-compact-btn" data-ag-ov-action="compact" data-state="compacting" disabled>${SVG_COMPACT_ICON}<span>${L('压缩中…', 'Compacting…')}</span></button>`;
    } else if (compactStatus === 'compacted') {
      topPctText = summaryLabel && limitLabel ? `${summaryPct}% ${L('已用', 'used')}` : L('已完成压缩', 'Compacted');
      topRatioText = summaryLabel && limitLabel ? `${summaryLabel} / ${limitLabel}` : L('下轮刷新', 'Next turn');
      topPctLevel = '';
      cachedBarW = summaryPct > 0 ? Math.max(2, summaryPct) : 2;
      uncachedBarW = 0;
      compactBtnHtml = `<button type="button" class="ag-ov-compact-btn" data-ag-ov-action="compact" data-state="compacted" disabled>${SVG_COMPACT_DONE}<span>${L('已压缩', 'Compacted')}</span></button>`;
    } else if (!hasCtx) {
      compactBtnHtml = `<button type="button" class="ag-ov-compact-btn" data-ag-ov-action="compact" data-state="empty" disabled>${SVG_COMPACT_ICON}<span>${L('压缩', 'Compact')}</span></button>`;
    } else if (paneRunning) {
      compactBtnHtml = `<button type="button" class="ag-ov-compact-btn" data-ag-ov-action="compact" data-state="busy" disabled title="${escapeHtml(L('请等待当前回复结束后压缩', 'Wait for response to finish'))}">${SVG_COMPACT_ICON}<span>${L('压缩', 'Compact')}</span></button>`;
    } else {
      const urgAttr = stats.pct >= 85 ? ' data-urgent="crit"' : stats.pct >= 70 ? ' data-urgent="warn"' : '';
      compactBtnHtml = `<button type="button" class="ag-ov-compact-btn" data-ag-ov-action="compact" data-state="ready"${urgAttr} title="${escapeHtml(L('立即执行 /compact 压缩上下文', 'Run /compact'))}">${SVG_COMPACT_ICON}<span>${L('压缩', 'Compact')}</span></button>`;
    }

    const cachedPctStr = stats ? ((Number(stats.cached || 0) / shareDenom) * 100).toFixed(1) : '0.0';
    const uncachedPctStr = stats ? ((Number(stats.uncached || 0) / shareDenom) * 100).toFixed(1) : '0.0';
    const freePctVal = stats ? Math.max(0, 100 - Number(cachedPctStr) - Number(uncachedPctStr)) : 100;
    const freePctStr = freePctVal.toFixed(1);

    const ctxCardHtml = `
      <section class="ag-ov-card" data-ov-card="context">
        <div class="ag-ov-card-hdr">
          <button type="button" class="ag-ov-hdr-toggle" data-ag-ov-collapse="context">
            ${buildOvChevronSvg(ovCollapseState.context)}
            <span>${L('上下文', 'Context')}</span>
          </button>
          <div class="ag-ov-ctx-hdr-meta">
            <span class="ag-ov-ctx-pct" data-level="${topPctLevel}">${escapeHtml(topPctText)}</span>
            ${topRatioText ? `<span class="ag-ov-muted">${escapeHtml(topRatioText)}</span>` : ''}
          </div>
        </div>
        ${
          ovCollapseState.context
            ? `<div class="ag-ov-card-body">
                <div class="ag-ov-stacked-bar">
                  <div class="ag-ov-bar-cached" style="width:${cachedBarW.toFixed(2)}%"></div>
                  <div class="ag-ov-bar-uncached" style="width:${uncachedBarW.toFixed(2)}%"></div>
                </div>
                ${
                  stats
                    ? `<div class="ag-ov-breakdown">
                        <div class="ag-ov-bd-row">
                          <span class="ag-ov-bd-lbl"><i class="ag-ov-dot ag-ov-dot-blue"></i><span>${L('缓存上下文', 'Cached context')}</span></span>
                          <span class="ag-ov-bd-vals"><span>${escapeHtml(fmtOvTokens(stats.cached))}</span><span class="ag-ov-muted ag-ov-pct-w">${cachedPctStr}%</span></span>
                        </div>
                        <div class="ag-ov-bd-row">
                          <span class="ag-ov-bd-lbl"><i class="ag-ov-dot ag-ov-dot-amber"></i><span>${L('新增上下文', 'Uncached context')}</span></span>
                          <span class="ag-ov-bd-vals"><span>${escapeHtml(fmtOvTokens(stats.uncached))}</span><span class="ag-ov-muted ag-ov-pct-w">${uncachedPctStr}%</span></span>
                        </div>
                        <div class="ag-ov-bd-row">
                          <span class="ag-ov-bd-lbl"><i class="ag-ov-dot ag-ov-dot-free"></i><span class="ag-ov-muted">${L('剩余空间', 'Free space')}</span></span>
                          <span class="ag-ov-bd-vals ag-ov-muted"><span>${escapeHtml(fmtOvTokens(stats.remain))}</span><span class="ag-ov-pct-w">${freePctStr}%</span></span>
                        </div>
                      </div>
                      <div class="ag-ov-submetrics">
                        <div class="ag-ov-kv-row">
                          <span class="ag-ov-muted">${L('缓存命中率', 'Prompt cache')}</span>
                          <span><strong class="ag-ov-blue-txt">${stats.lastCacheRate}%</strong> <span class="ag-ov-muted">${L('· 累计', '· avg')} ${stats.sessionCacheRate}%</span></span>
                        </div>
                        <div class="ag-ov-kv-row">
                          <span class="ag-ov-muted">${L('累计输出', 'Output split')}</span>
                          <span>${L('思考', 'Think')} ${escapeHtml(fmtOvTokens(stats.totalThink))} · ${L('正文', 'Resp')} ${escapeHtml(fmtOvTokens(stats.totalResp))}</span>
                        </div>
                      </div>`
                    : `<div class="ag-ov-empty-inline">${L('发送消息后将显示实时上下文与缓存拆解', 'Context and cache telemetry appear after the first turn')}</div>`
                }
                <div class="ag-ov-ctx-footer">
                  <span class="ag-ov-muted">${stats ? `${stats.turns} ${L('轮', 'turns')} · ${stats.calls} ${L('次调用', 'calls')}` : ''}</span>
                  ${compactBtnHtml}
                </div>
              </div>`
            : ''
        }
      </section>`;

    /* ---- 3. Quota Card (Google Blue + Used % aligned with elapsed time cursor) ---- */
    const tierDisplay = rtState.cachedUserTierName ? rtState.cachedUserTierName.trim() : '';
    const isQuotaSpinning = Date.now() < ovRefreshSpinUntil;
    let quotaInnerHtml = '';
    if (groups.length === 0) {
      quotaInnerHtml = `<div class="ag-ov-empty-inline">${
        rtState.quotaFetchInFlight ? L('正在读取实时套餐限额…', 'Loading plan quotas…') : L('点击右上角刷新读取实时配额', 'Click refresh to load plan quotas')
      }</div>`;
    } else {
      const pIdx = ovPrimaryIdx >= 0 && ovPrimaryIdx < groups.length ? ovPrimaryIdx : 0;
      const primaryGrp = groups[pIdx];
      const pShort = localizeGroupShortName(primaryGrp.displayName);
      const sortBuckets = (list) =>
        (list || []).slice().sort((a, b) => {
          const r = (w) => (w === '5h' ? 0 : w === 'daily' ? 1 : 2);
          return r(String(a.window || '').toLowerCase()) - r(String(b.window || '').toLowerCase());
        });
      const primaryBuckets = sortBuckets(primaryGrp.buckets);

      const fmtOvQuotaPct = formatQuotaUsedPctStr;

      const primaryHtml = primaryBuckets
        .map((b) => {
          const rem =
            b.remaining && b.remaining.case === 'remainingFraction' && typeof b.remaining.value === 'number'
              ? b.remaining.value
              : typeof b.remainingFraction === 'number'
                ? b.remainingFraction
                : 1;
          const usedRaw = Math.max(0, Math.min(100, (1 - rem) * 100));
          const usedPct = Math.round(usedRaw);
          const usedPctStr = fmtOvQuotaPct(usedRaw);
          const remPctStr = fmtOvQuotaPct(100 - usedRaw);
          const winTag = localizeQuotaWindowTag(b.window, b.displayName || '');
          const col = ovQuotaUsedColor(usedRaw);
          const litCount = usedRaw <= 0 ? 0 : Math.min(20, Math.max(1, Math.round(usedRaw / 5)));
          const segsHtml = Array.from({ length: 20 }, (_, i) =>
            `<span class="ag-ov-seg" style="background:${i < litCount ? col : 'var(--ag-ov-track)'}"></span>`
          ).join('');
          const elapsedPct = computeWindowElapsedPct(b, usedRaw);
          const cursorHtml =
            elapsedPct !== null
              ? `<div class="ag-ov-time-track" title="${escapeHtml(L(`窗口时间已流逝 ${elapsedPct}%`, `Window elapsed ${elapsedPct}%`))}">
                  <div class="ag-ov-time-fill" style="width:${elapsedPct}%"></div>
                  <span class="ag-ov-time-cursor" style="left:${elapsedPct}%"></span>
                </div>`
              : '';
          const resetTxt = formatResetLabel(b, usedRaw);
          return `<div class="ag-ov-quota-box" title="${escapeHtml(L(`已用 ${usedPctStr}% · 剩余 ${remPctStr}%`, `${usedPctStr}% used · ${remPctStr}% left`))}">
            <div class="ag-ov-kv-row">
              <span class="ag-ov-row-left">
                <i class="ag-ov-qdot" style="background:${col}"></i>
                <span class="ag-ov-qtitle">${escapeHtml(pShort)} · ${escapeHtml(winTag)}</span>
              </span>
              <span class="ag-ov-qpct">${usedPctStr}% ${L('已用', 'used')}</span>
            </div>
            <div class="ag-ov-seg-bar">${segsHtml}</div>
            ${cursorHtml}
            ${resetTxt ? `<div class="ag-ov-reset-txt">${escapeHtml(resetTxt)}</div>` : ''}
          </div>`;
        })
        .join('');

      const otherRows = [];
      groups.forEach((g, idx) => {
        if (idx === pIdx) return;
        const gShort = localizeGroupShortName(g.displayName);
        for (const b of sortBuckets(g.buckets)) {
          const rem =
            b.remaining && b.remaining.case === 'remainingFraction' && typeof b.remaining.value === 'number'
              ? b.remaining.value
              : typeof b.remainingFraction === 'number'
                ? b.remainingFraction
                : 1;
          const usedRaw = Math.max(0, Math.min(100, (1 - rem) * 100));
          const usedPctStr = fmtOvQuotaPct(usedRaw);
          const remPctStr = fmtOvQuotaPct(100 - usedRaw);
          const winTag = localizeQuotaWindowTag(b.window, b.displayName || '');
          const col = ovQuotaUsedColor(usedRaw);
          otherRows.push(`<div class="ag-ov-other-pool-row" title="${escapeHtml(L(`已用 ${usedPctStr}% · 剩余 ${remPctStr}%`, `${usedPctStr}% used · ${remPctStr}% left`))}">
            <span class="ag-ov-muted ag-ov-trunc">${escapeHtml(gShort)}${winTag ? ` · ${escapeHtml(winTag)}` : ''}</span>
            <span class="ag-ov-mini-meter-wrap">
              <span class="ag-ov-mini-track"><span class="ag-ov-mini-fill" style="width:${usedRaw.toFixed(1)}%;background:${col}"></span></span>
              <span class="ag-ov-mini-pct">${usedPctStr}%</span>
            </span>
          </div>`);
        }
      });

      const otherHtml =
        otherRows.length > 0
          ? `<div class="ag-ov-other-pools">
              <button type="button" class="ag-ov-sub-toggle" data-ag-ov-collapse="otherPools">
                <span class="ag-ov-row-left">
                  ${buildOvChevronSvg(ovCollapseState.otherPools)}
                  <span class="ag-ov-muted">${L('其他模型池', 'Other model pools')}</span>
                </span>
                <span class="ag-ov-muted">${otherRows.length}</span>
              </button>
              ${ovCollapseState.otherPools ? `<div class="ag-ov-other-pools-list">${otherRows.join('')}</div>` : ''}
            </div>`
          : '';

      quotaInnerHtml = `${primaryHtml}${otherHtml}`;
    }

    const quotaCardHtml = `
      <section class="ag-ov-card" data-ov-card="quota">
        <div class="ag-ov-card-hdr">
          <button type="button" class="ag-ov-hdr-toggle" data-ag-ov-collapse="quota">
            ${buildOvChevronSvg(ovCollapseState.quota)}
            <span>Antigravity</span>
            ${tierDisplay ? `<span class="ag-ov-tier-pill">${escapeHtml(tierDisplay)}</span>` : ''}
          </button>
          <div class="ag-ov-hdr-actions">
            <button type="button" class="ag-ov-icon-btn" data-ag-ov-action="refresh-quota" title="${escapeHtml(L('刷新实时配额', 'Refresh quota'))}" aria-label="${escapeHtml(L('刷新配额', 'Refresh quota'))}">
              <svg class="${isQuotaSpinning ? 'ag-ov-spinning' : ''}" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.4-3.55" stroke-linecap="round"/><path d="M13.4 2.5v2.6h-2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>
        ${ovCollapseState.quota ? `<div class="ag-ov-card-body ag-ov-quota-body">${quotaInnerHtml}</div>` : ''}
      </section>`;

    /* ---- 4. Side chats / Subagents (Rendered only when children exist) ---- */
    const sidechatsCardHtml =
      mergedChildren.length > 0
        ? `<section class="ag-ov-card" data-ov-card="sidechats">
            <div class="ag-ov-card-hdr">
              <button type="button" class="ag-ov-hdr-toggle" data-ag-ov-collapse="sidechats">
                ${buildOvChevronSvg(ovCollapseState.sidechats)}
                <span>${L('子智能体', 'Side chats')}</span>
              </button>
              <span class="ag-ov-count-pill">${mergedChildren.length}</span>
            </div>
            ${
              ovCollapseState.sidechats
                ? `<div class="ag-ov-list-body">
                    ${mergedChildren
                      .map((ch) => {
                        const label = ch.title || ch.agentName || ch.id.slice(0, 8);
                        const statusHtml = ch.running
                          ? `<span class="ag-ov-status-run">${L('运行中', 'Running')}</span>`
                          : `<span class="ag-ov-muted">${L('已完成', 'Done')}</span>`;
                        const iconHtml = ch.running
                          ? `<i class="ag-ov-dot-live"></i>`
                          : `<svg width="13" height="13" class="ag-ov-muted ag-ov-shrink0" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3.5 8.2 6.5 11.2 12.5 4.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
                        return `<button type="button" class="ag-ov-row-btn" data-ag-ov-action="sidechat" data-cid="${escapeHtml(ch.id)}">
                          <span class="ag-ov-row-left">${iconHtml}<span class="ag-ov-trunc">${escapeHtml(label)}</span></span>
                          ${statusHtml}
                        </button>`;
                      })
                      .join('')}
                  </div>`
                : ''
            }
          </section>`
        : '';

    /* ---- 5. Connectors & Inventory (Claude Code Style, Default Collapsed) ---- */
    const skillsData = (snap && snap.skills) || { total: 0, userCount: 0, items: [] };
    const agentsData = (snap && snap.agents) || { total: 0, items: [] };
    const connList = (snap && Array.isArray(snap.connectors) && snap.connectors) || [];
    const shownConns = ovCollapseState.connectorsExtra ? connList : connList.slice(0, 5);
    const hiddenConnCount = Math.max(0, connList.length - 5);

    const connectorsCardHtml = `
      <section class="ag-ov-card" data-ov-card="connectors">
        <div class="ag-ov-card-hdr">
          <button type="button" class="ag-ov-hdr-toggle" data-ag-ov-collapse="connectors">
            ${buildOvChevronSvg(ovCollapseState.connectors)}
            <span>${L('连接器与能力', 'Connectors & Skills')}</span>
          </button>
          <span class="ag-ov-muted ag-ov-tabular">${L(`${connList.length} MCP · ${skillsData.total} 技能`, `${connList.length} MCP · ${skillsData.total} Skills`)}</span>
        </div>
        ${
          ovCollapseState.connectors
            ? `<div class="ag-ov-card-body ag-ov-conn-wrap">
                <div class="ag-ov-inv-group">
                  <button type="button" class="ag-ov-inv-toggle" data-ag-ov-collapse="invMemory">
                    <span class="ag-ov-row-left">${buildOvChevronSvg(ovCollapseState.invMemory)}<span>${L('记忆与规则', 'Memory / Rules')}</span></span>
                    <span class="ag-ov-muted ag-ov-tabular">${rulesList.length}</span>
                  </button>
                  ${
                    ovCollapseState.invMemory
                      ? `<div class="ag-ov-inv-items">
                          ${
                            rulesList.length > 0
                              ? rulesList
                                  .map(
                                    (r) =>
                                      `<button type="button" class="ag-ov-inv-link" data-ag-ov-action="${r.scope === 'project' ? 'edit-rules' : 'reveal-path'}" data-path="${escapeHtml(r.path)}">${escapeHtml(r.label)}</button>`
                                  )
                                  .join('')
                              : `<div class="ag-ov-empty-inline">${L('暂无规则文件', 'No rule files')}</div>`
                          }
                        </div>`
                      : ''
                  }

                  <button type="button" class="ag-ov-inv-toggle" data-ag-ov-collapse="invSkills">
                    <span class="ag-ov-row-left">${buildOvChevronSvg(ovCollapseState.invSkills)}<span>${L('技能清单', 'Skills')}</span></span>
                    <span class="ag-ov-muted ag-ov-tabular">${skillsData.total}</span>
                  </button>
                  ${
                    ovCollapseState.invSkills
                      ? `<div class="ag-ov-inv-items">
                          ${skillsData.items
                            .slice(0, 12)
                            .map(
                              (s) =>
                                `<button type="button" class="ag-ov-inv-link" data-ag-ov-action="reveal-path" data-path="${escapeHtml(s.path)}" title="${escapeHtml(s.source)}">${escapeHtml(s.name)}</button>`
                            )
                            .join('')}
                          ${
                            skillsData.total > 12
                              ? `<button type="button" class="ag-ov-inv-more" data-ag-ov-action="open-skills-dir">${L(`… 其余 ${skillsData.total - 12} 项（打开技能目录）`, `… ${skillsData.total - 12} more (open folder)`)}</button>`
                              : ''
                          }
                        </div>`
                      : ''
                  }

                  <button type="button" class="ag-ov-inv-toggle" data-ag-ov-collapse="invAgents">
                    <span class="ag-ov-row-left">${buildOvChevronSvg(ovCollapseState.invAgents)}<span>${L('自定义子 Agent', 'Custom agents')}</span></span>
                    <span class="ag-ov-muted ag-ov-tabular">${agentsData.total}</span>
                  </button>
                  ${
                    ovCollapseState.invAgents
                      ? `<div class="ag-ov-inv-items">
                          ${
                            agentsData.items.length > 0
                              ? agentsData.items
                                  .map(
                                    (a) =>
                                      `<button type="button" class="ag-ov-inv-link" data-ag-ov-action="reveal-path" data-path="${escapeHtml(a.path)}">${escapeHtml(a.name)}</button>`
                                  )
                                  .join('')
                              : `<button type="button" class="ag-ov-inv-more" data-ag-ov-action="open-agents-dir">${L('暂无自定义 Agent · 打开目录', 'None yet · open folder')}</button>`
                          }
                        </div>`
                      : ''
                  }
                </div>

                <div class="ag-ov-conn-sub">
                  <div class="ag-ov-conn-title">${L('已连接服务', 'Connectors')}</div>
                  ${
                    shownConns.length > 0
                      ? shownConns
                          .map((c) => {
                            const letterMatch = String(c.name || c.id || 'M').match(/[A-Za-z0-9]/);
                            const mono = letterMatch ? letterMatch[0].toUpperCase() : 'M';
                            return `<button type="button" class="ag-ov-conn-row" data-ag-ov-action="open-plugins" title="${escapeHtml(L('打开扩展插件管理', 'Open Extensions & Plugins'))}">
                              <span class="ag-ov-row-left">
                                <span class="ag-ov-monogram">${escapeHtml(mono)}</span>
                                <span class="ag-ov-trunc">${escapeHtml(c.name)}</span>
                              </span>
                              <i class="ag-ov-dot ag-ov-dot-green"></i>
                            </button>`;
                          })
                          .join('')
                      : `<div class="ag-ov-empty-inline">${L('暂无已配置的 MCP 连接器', 'No MCP connectors configured')}</div>`
                  }
                  ${
                    hiddenConnCount > 0
                      ? `<button type="button" class="ag-ov-show-more" data-ag-ov-action="toggle-connectors-more">${
                          ovCollapseState.connectorsExtra ? L('收起', 'Show less') : L(`展开更多 (${hiddenConnCount})`, `Show more (${hiddenConnCount})`)
                        }</button>`
                      : ''
                  }
                </div>
              </div>`
            : ''
        }
      </section>`;

    sectionsEl.innerHTML = `${envCardHtml}${ctxCardHtml}${quotaCardHtml}${sidechatsCardHtml}${connectorsCardHtml}`;
    if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      try { window.dispatchEvent(new CustomEvent('agy:overview-rendered')); } catch {}
    }
  }

  function isNativeArtifactOverviewBlock(el) {
    if (!el || !el.querySelector) return false;
    if (el.querySelector('[data-testid="artifact-row"], [data-testid*="artifact"]')) return true;
    const hdrLbl = el.querySelector('span.agy-hover-label');
    const txt = hdrLbl ? String(hdrLbl.textContent || '').trim() : '';
    return /^(?:artifacts?|产物)$/i.test(txt);
  }

  const OV_LIVE_POLL_MS = 12000;

  function onQuotaVisibilityOrFocus() {
    if (rtState.disposed) return;
    if (typeof document.visibilityState === 'string' && document.visibilityState === 'hidden') return;
    if ((isOverviewPanelVisible() || rtState.quotaPopoverOpen) && Date.now() - rtState.lastForceQuotaFetchTs >= 5000) {
      scheduleAutoQuotaRefresh(150, 4000);
    }
  }
  window.addEventListener('focus', onQuotaVisibilityOrFocus);
  document.addEventListener('visibilitychange', onQuotaVisibilityOrFocus);

  function stopOverviewMinuteTicker() {
    if (ovMinuteTickerId) {
      clearInterval(ovMinuteTickerId);
      ovMinuteTickerId = null;
    }
  }

  function ensureOverviewMinuteTicker() {
    if (ovMinuteTickerId || rtState.disposed) return;
    ovMinuteTickerId = setInterval(() => {
      if (rtState.disposed || !FEAT.overviewPanel || !isOverviewPanelVisible()) {
        stopOverviewMinuteTicker();
        return;
      }
      if (
        (typeof document.visibilityState !== 'string' || document.visibilityState !== 'hidden') &&
        Date.now() - rtState.lastForceQuotaFetchTs >= OV_LIVE_POLL_MS
      ) {
        if (discoverQuotaService(false)) fetchQuotaSummary(true);
      }
      renderOverviewPanel(false);
    }, OV_LIVE_POLL_MS);
    if (ovMinuteTickerId && typeof ovMinuteTickerId.unref === 'function') {
      ovMinuteTickerId.unref();
    }
  }

  function syncOverviewPanel(force = false) {
    if (rtState.disposed || !FEAT.overviewPanel) {
      teardownOverviewPanel();
      return;
    }
    const panel = document.querySelector('[data-testid="overview-panel"]');
    if (!panel || panel.hidden || panel.getAttribute('aria-hidden') === 'true') {
      stopOverviewMinuteTicker();
      return;
    }

    if (panel.getAttribute('data-ag-ov-enhanced') !== '1') {
      panel.setAttribute('data-ag-ov-enhanced', '1');
    }

    const scrollBody =
      Array.from(panel.children).find((ch) => ch.classList && ch.classList.contains('overflow-y-auto')) || panel.children[1];
    if (!scrollBody) return;

    let sectionsEl = document.getElementById('ag-claude-ov-sections');
    if (sectionsEl && sectionsEl.parentElement !== scrollBody) {
      sectionsEl.remove();
      sectionsEl = null;
    }

    for (const child of Array.from(scrollBody.children)) {
      if (child.id === 'ag-claude-ov-sections') continue;
      if (child.querySelector && child.querySelector('button[data-testid^="overview-panel-row-"]')) {
        if (child.getAttribute('data-ag-ov-shortcuts') !== '1') child.setAttribute('data-ag-ov-shortcuts', '1');
        if (child.hasAttribute('data-ag-ov-native-artifact')) child.removeAttribute('data-ag-ov-native-artifact');
        if (child.hasAttribute('data-ag-ov-native-tail')) child.removeAttribute('data-ag-ov-native-tail');
      } else if (isNativeArtifactOverviewBlock(child)) {
        if (child.getAttribute('data-ag-ov-native-artifact') !== '1') child.setAttribute('data-ag-ov-native-artifact', '1');
        if (child.hasAttribute('data-ag-ov-shortcuts')) child.removeAttribute('data-ag-ov-shortcuts');
        if (child.hasAttribute('data-ag-ov-native-tail')) child.removeAttribute('data-ag-ov-native-tail');
      } else {
        if (child.getAttribute('data-ag-ov-native-tail') !== '1') child.setAttribute('data-ag-ov-native-tail', '1');
        if (child.hasAttribute('data-ag-ov-shortcuts')) child.removeAttribute('data-ag-ov-shortcuts');
        if (child.hasAttribute('data-ag-ov-native-artifact')) child.removeAttribute('data-ag-ov-native-artifact');
      }
    }

    const reviewBtn = panel.querySelector('button[data-testid="overview-panel-row-review"]');
    if (reviewBtn) {
      const reviewDetail = Array.from(reviewBtn.children || []).find(
        (c) => c.getAttribute && c.getAttribute('data-testid') === 'overview-panel-row-review-detail'
      );
      const hasDetail = Boolean(reviewDetail && String(reviewDetail.textContent || '').trim());
      if (hasDetail) {
        if (reviewBtn.getAttribute('data-ag-has-detail') !== '1') reviewBtn.setAttribute('data-ag-has-detail', '1');
      } else if (reviewBtn.hasAttribute('data-ag-has-detail')) {
        reviewBtn.removeAttribute('data-ag-has-detail');
      }
    }

    if (!sectionsEl) {
      sectionsEl = document.createElement('div');
      sectionsEl.id = 'ag-claude-ov-sections';
      sectionsEl.setAttribute('data-ag-i18n-ignore', '1');
      sectionsEl.addEventListener('click', onOverviewSectionsClick);
      scrollBody.appendChild(sectionsEl);
    }

    ensureOverviewMinuteTicker();

    const now = Date.now();
    if ((!rtState.cachedQuotaGroups || now - rtState.lastForceQuotaFetchTs >= OV_LIVE_POLL_MS) && now - ovLastQuotaAutoTryTs > 4000) {
      ovLastQuotaAutoTryTs = now;
      if (discoverQuotaService(false)) fetchQuotaSummary(true);
    }

    renderOverviewPanel(force);
  }

  function teardownOverviewPanel() {
    stopOverviewMinuteTicker();
    if (ovQuotaSpinTimer) {
      cancelLater(ovQuotaSpinTimer);
      ovQuotaSpinTimer = 0;
    }
    ovRefreshSpinUntil = 0;
    ovSnapshotCache.clear();
    ovWorkspaceMemo = { ts: 0, key: '', value: null };
    ovCompactMemo = { ts: 0, key: '', status: 'idle' };
    const sectionsEl = document.getElementById('ag-claude-ov-sections');
    if (sectionsEl) sectionsEl.remove();
    document.querySelectorAll('[data-ag-ov-enhanced]').forEach((el) => el.removeAttribute('data-ag-ov-enhanced'));
    document.querySelectorAll('[data-ag-ov-shortcuts]').forEach((el) => el.removeAttribute('data-ag-ov-shortcuts'));
    document.querySelectorAll('[data-ag-ov-native-artifact]').forEach((el) => el.removeAttribute('data-ag-ov-native-artifact'));
    document.querySelectorAll('[data-ag-ov-native-tail]').forEach((el) => el.removeAttribute('data-ag-ov-native-tail'));
  }


  function dispose() {
    window.removeEventListener('focus', onQuotaVisibilityOrFocus);
    document.removeEventListener('visibilitychange', onQuotaVisibilityOrFocus);
    teardownOverviewPanel();
  }

  return {
    invalidateOverviewSnapshotCache,
    renderOverviewPanel,
    syncOverviewPanel,
    teardownOverviewPanel,
    dispose,
  };
}
