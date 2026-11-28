/**
 * Renderer-side Milestone Handoff Resolver & Checked Launcher (`user/src/modules/projects/handoff-launch.mjs`).
 *
 * - Pure `verifyResourceSelectorScope` guarantees project/local-folder scope before native submission.
 * - `launchMilestoneHandoffChat` enforces preconditions, snapshots summaries `beforeIds`, handles
 *   outcome plumbing (`submitted` vs `scope_mismatch`/`nav_fail`/`submit_threw`), rolls back + restores
 *   unsent source draft ONLY on pre-submit failures, and surfaces `uncertain` on 4s postcondition timeout
 *   without ever double-submitting.
 */

function defaultDecodeFileUri(uri) {
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

function isCaseInsensitivePlatform() {
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform === 'darwin' || process.platform === 'win32';
  }
  if (typeof navigator !== 'undefined') {
    return /Mac|Win/i.test(String(navigator.platform || navigator.userAgent || ''));
  }
  return false;
}

function normalizeFolderForCompare(rawPath, decodeFn = defaultDecodeFileUri) {
  const raw = String(rawPath || '').trim();
  if (!raw) return '';
  const decoded = /^file:\/\//i.test(raw) ? (decodeFn || defaultDecodeFileUri)(raw) : raw;
  const cleaned = String(decoded || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!cleaned) return '';
  return isCaseInsensitivePlatform() ? cleaned.toLowerCase() : cleaned;
}

function hasIndexKey(col, id) {
  if (!col || !id) return false;
  if (typeof col.has === 'function') return col.has(id);
  if (Array.isArray(col)) return col.includes(id);
  if (typeof col === 'object') return Object.prototype.hasOwnProperty.call(col, id);
  return false;
}

/**
 * Verifies `store.getState().newConvoResourceSelector` matches the target scope before auto-submitting.
 * Fails closed on any mismatch or missing ad-hoc folder lock so a handoff never lands in the wrong project.
 */
export function verifyResourceSelectorScope(sel, { projectId = '', repoRoot = '', decodeFileUriToPath = null } = {}) {
  if (!sel || typeof sel !== 'object') {
    return { ok: false, reason: 'missing_resource_selector' };
  }
  if (sel.isMagicWorkspaceSelected === true) {
    return { ok: false, reason: 'magic_workspace_selected' };
  }
  const pid = String(projectId || '').trim();
  if (pid) {
    if (sel.isPseudoProjectSelected === true) {
      return { ok: false, reason: 'pseudo_project_selected' };
    }
    if (sel.lastSelectedProjectId !== pid) {
      return { ok: false, reason: 'project_id_mismatch' };
    }
    return { ok: true };
  }

  // Non-project / ad-hoc conversation: require clean unpinned project state AND exact folder match
  if (sel.lastSelectedProjectId && sel.isPseudoProjectSelected !== true) {
    return { ok: false, reason: 'sticky_project_selected' };
  }
  const localSel = sel.lastLocalSelection;
  if (localSel && typeof localSel === 'object' && localSel.kind === 'project') {
    return { ok: false, reason: 'local_selection_is_project' };
  }
  const targetFolder = normalizeFolderForCompare(repoRoot, decodeFileUriToPath || defaultDecodeFileUri);
  const localRaw =
    localSel && typeof localSel === 'object'
      ? localSel.path || localSel.uri || localSel.folderPath || localSel.workspaceFolderAbsoluteUri || ''
      : '';
  const selectedFolder = normalizeFolderForCompare(localRaw, decodeFileUriToPath || defaultDecodeFileUri);
  if (!targetFolder || !selectedFolder || selectedFolder !== targetFolder) {
    return { ok: false, reason: 'local_folder_mismatch' };
  }
  return { ok: true };
}

export function createHandoffLaunchHelper(deps) {
  const {
    rtState,
    hooks,
    activeReactFiber,
    getActiveCascadeId,
    decodeFileUriToPath,
    resolveProjectsStoreAndBindings,
    collectNativeProjects,
    startNewChatInProject,
    openConversationFromProject,
  } = deps;

  function readLiveComposerDraft() {
    if (typeof document === 'undefined') return '';
    const box =
      document.getElementById('antigravity.agentSidePanelInputBox') ||
      document.querySelector('[data-testid="conversation-view"] [data-testid="agent-input-box"]');
    const editor = box?.querySelector?.('[data-lexical-editor="true"]');
    if (!editor) return '';
    return String(editor.textContent || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim();
  }

  function findInputContextOnBox(box) {
    if (!box || typeof activeReactFiber !== 'function') return null;
    let f = activeReactFiber(box);
    for (let d = 0; f && d < 40; d += 1, f = f.return) {
      const mp = f.memoizedProps;
      if (mp && mp.inputBoxRef && mp.inputBoxRef.current) return { inputBoxRef: mp.inputBoxRef };
      for (let dep = f.dependencies?.firstContext; dep; dep = dep.next) {
        const val = dep.memoizedValue;
        if (val && val.inputBoxRef && val.inputBoxRef.current) return val;
      }
    }
    return null;
  }

  function resolveActiveConversationContext(cidOverride = '') {
    const { store, bindings } = resolveProjectsStoreAndBindings();
    const rPath = bindings?.router?.state?.location?.pathname || '';
    const winPath = typeof window !== 'undefined' && window.location ? String(window.location.pathname || '') : '';
    const routeMatch = (rPath || winPath).match(/^\/c\/([^/?#]+)/);
    const cid = String(cidOverride || (routeMatch ? decodeURIComponent(routeMatch[1]) : '') || getActiveCascadeId() || '').trim();

    const state = store && typeof store.getState === 'function' ? store.getState() : null;
    const summaries = state?.trajectorySummaries?.summaries || {};
    const sum = cid ? summaries[cid] : null;
    const allProjects = collectNativeProjects() || [];

    let pid = '';
    if (sum) {
      pid = String((sum.trajectoryMetadata && sum.trajectoryMetadata.projectId) || sum.projectId || '');
      if ((!pid || pid === 'outside-of-project') && cid && state) {
        const byProject = state.trajectorySummaries?.indexes?.byProject;
        if (byProject && typeof byProject === 'object') {
          for (const [candPid, rawIds] of Object.entries(byProject)) {
            if (!candPid || candPid === 'outside-of-project') continue;
            if (hasIndexKey(rawIds, cid)) {
              pid = candPid;
              break;
            }
          }
        }
      }
    }

    let project = pid && pid !== 'outside-of-project' ? allProjects.find((p) => p.id === pid) || null : null;
    let repoRoot = project?.dirPath || '';

    if (sum) {
      const wsList = (sum.workspaces || []).concat((sum.trajectoryMetadata && sum.trajectoryMetadata.workspaces) || []);
      const rawUris = ((sum.trajectoryMetadata && sum.trajectoryMetadata.workspaceUris) || []).concat(
        wsList.map((ws) => ws && (ws.workspaceFolderAbsoluteUri || ws.uri || ws))
      );
      for (const rawUri of rawUris) {
        if (typeof rawUri !== 'string' || !rawUri.trim()) continue;
        const decoded = (decodeFileUriToPath || defaultDecodeFileUri)(rawUri).replace(/\/+$/, '');
        if (!decoded) continue;
        if (!repoRoot) repoRoot = decoded;
        if (!project) {
          const normDecoded = normalizeFolderForCompare(decoded, decodeFileUriToPath);
          project =
            allProjects.find((p) => p.dirPath && normalizeFolderForCompare(p.dirPath, decodeFileUriToPath) === normDecoded) ||
            null;
          if (project) break;
        }
      }
    }

    return {
      cid,
      projectId: project?.id || '',
      projectName: project?.name || '',
      repoRoot: repoRoot || project?.dirPath || '',
      composerDraft: readLiveComposerDraft(),
    };
  }

  async function launchMilestoneHandoffChat({
    projectId = '',
    repoRoot = '',
    prompt = '',
    expectedFromCid = '',
    postconditionTimeoutMs = 4000,
    pollIntervalMs = 120,
    navTimeoutMs = 6000,
  } = {}) {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
      return { ok: false, status: 'failed', phase: 'precondition', error: 'empty_prompt' };
    }
    if (typeof document !== 'undefined') {
      const cancelBtns = document.querySelectorAll('.agy-composer-footer button[data-testid="input-cancel-button"]');
      for (const btn of cancelBtns) {
        if (btn.closest?.('[data-side-panel-composer], [data-testid="subagent-tab-composer"]')) continue;
        if (!btn.hidden && btn.style?.display !== 'none') {
          return { ok: false, status: 'failed', phase: 'precondition', error: 'composer_running' };
        }
      }
    }

    const { store, bindings } = resolveProjectsStoreAndBindings();
    const targetPid = String(projectId || '').trim();
    const targetProj = targetPid ? (collectNativeProjects() || []).find((p) => p.id === targetPid) || null : null;
    if (targetPid && !targetProj) {
      return { ok: false, status: 'failed', phase: 'precondition', error: 'project_not_found' };
    }

    const fromCid = String(expectedFromCid || getActiveCascadeId() || '').trim();
    const beforeIds = new Set(Object.keys((store && store.getState?.()?.trajectorySummaries?.summaries) || {}));
    const savedDraft = readLiveComposerDraft();

    const rollbackToSource = async () => {
      if (rtState?.disposed) return;
      if (fromCid) openConversationFromProject(fromCid);
      if (!savedDraft || typeof document === 'undefined') return;
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline && !rtState?.disposed) {
        const box = document.getElementById('antigravity.agentSidePanelInputBox');
        const editor = box?.querySelector?.('[data-lexical-editor="true"]');
        if (box && editor) {
          const curText = String(editor.textContent || '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .trim();
          if (!curText) {
            const ctx = findInputContextOnBox(box);
            if (ctx && typeof hooks?.setComposerText === 'function') {
              hooks.setComposerText(ctx, savedDraft);
            } else {
              editor.textContent = savedDraft;
            }
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 60));
      }
    };

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(guardTimer);
        resolve(res);
      };
      const guardTimer = setTimeout(() => {
        done({ phase: 'nav_fail', error: 'launch_timeout' });
      }, Math.max(100, Number(navTimeoutMs) || 6000));

      startNewChatInProject(targetProj || null, cleanPrompt, [], [], null, {
        scopeGuard: () => {
          if (settled) return { ok: false, reason: 'launch_cancelled' };
          const sel = store && typeof store.getState === 'function' ? store.getState()?.newConvoResourceSelector : null;
          return verifyResourceSelectorScope(sel, {
            projectId: targetPid,
            repoRoot,
            decodeFileUriToPath,
          });
        },
        onOutcome: (ev) => done(ev || { phase: 'nav_fail', error: 'unknown_outcome' }),
      });
    });

    if (outcome.phase !== 'submitted') {
      await rollbackToSource();
      return {
        ok: false,
        status: 'failed',
        phase: outcome.phase || 'nav_fail',
        error: outcome.error || outcome.phase || 'handoff_launch_failed',
      };
    }

    // Submitted cleanly: wait up to 4s for postcondition read-back (beforeIds diff or `/c/<newCid>`); NEVER auto-resubmit!
    const deadline = Date.now() + Math.max(20, Number(postconditionTimeoutMs) || 4000);
    const stepMs = Math.max(10, Number(pollIntervalMs) || 120);
    let newCid = '';
    while (Date.now() < deadline && !rtState?.disposed) {
      const summaries = (store && typeof store.getState === 'function' ? store.getState()?.trajectorySummaries?.summaries : null) || {};
      for (const id of Object.keys(summaries)) {
        if (!beforeIds.has(id) && id !== fromCid) {
          newCid = id;
          break;
        }
      }
      if (!newCid) {
        const curPath =
          bindings?.router?.state?.location?.pathname ||
          (typeof window !== 'undefined' && window.location ? String(window.location.pathname || '') : '');
        const m = curPath.match(/^\/c\/([^/?#]+)/);
        if (m) {
          const cand = decodeURIComponent(m[1]);
          if (cand && cand !== fromCid) newCid = cand;
        }
      }
      if (newCid) break;
      await new Promise((r) => setTimeout(r, stepMs));
    }

    if (!newCid) {
      return {
        ok: false,
        status: 'uncertain',
        phase: 'submitted',
        error: 'postcondition_timeout',
      };
    }

    const activePath =
      bindings?.router?.state?.location?.pathname ||
      (typeof window !== 'undefined' && window.location ? String(window.location.pathname || '') : '');
    if (!activePath.includes(`/c/${newCid}`)) {
      openConversationFromProject(newCid);
    }
    return {
      ok: true,
      status: 'created',
      newConversationId: newCid,
      projectId: targetPid,
    };
  }

  return {
    resolveActiveConversationContext,
    launchMilestoneHandoffChat,
  };
}
