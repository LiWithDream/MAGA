/**
 * Project Cockpit AI Conversation Suggestions Controller:
 * - Reads disk-cached suggestions first, then refreshes via Gemini 3.8 Flash when fingerprint changes
 * - Performs token-saving cold-start handoff (auto-switches Worktree + fills condensed anchor prompt)
 */
export function createProjectSuggestionsController(ctx) {
  const { FEAT, L, rtState, pState, pHooks } = ctx;

  function buildChatsBriefInput(project) {
    return (Array.isArray(project?.chats) ? project.chats : []).slice(0, 8).map((c) => ({
      id: c?.id || '',
      title: c?.title || '',
      updatedAt: Number(c?.updatedAt) || 0,
    }));
  }

  function renderIfViewingProject(projectId) {
    if (!rtState.disposed && rtState.projectsViewOpen && pState.activeProjectId === projectId) {
      pHooks.renderProjectsView?.();
    }
  }

  function runRefresh(project, { force = false } = {}) {
    const dirPath = project?.dirPath;
    if (!dirPath || typeof window.__agProjectCall !== 'function') return;
    if (pState.projectSuggestionsBusyDirs.has(dirPath)) return;
    pState.projectSuggestionsBusyDirs.add(dirPath);
    renderIfViewingProject(project.id);

    const lang = FEAT.i18n ? 'zh' : 'en';
    const chats = buildChatsBriefInput(project);
    Promise.resolve(
      window.__agProjectCall('getProjectSuggestions', { dirPath, chats, lang, cacheOnly: false, force }, 30000)
    )
      .then((res) => {
        pState.projectSuggestionsBusyDirs.delete(dirPath);
        if (rtState.disposed || !res || typeof res !== 'object') {
          renderIfViewingProject(project.id);
          return;
        }
        const prev = pState.projectSuggestionsMap[dirPath];
        if (!res.ok && (!Array.isArray(res.suggestions) || !res.suggestions.length) && prev?.suggestions?.length) {
          pState.projectSuggestionsMap[dirPath] = Object.assign({}, prev, {
            lastError: res.error || 'refresh_failed',
          });
        } else {
          pState.projectSuggestionsMap[dirPath] = Object.assign({}, res, {
            lastError: res.ok ? '' : res.error || 'refresh_failed',
          });
        }
        renderIfViewingProject(project.id);
      })
      .catch(() => {
        pState.projectSuggestionsBusyDirs.delete(dirPath);
        renderIfViewingProject(project.id);
      });
  }

  function loadProjectSuggestions(project, { force = false } = {}) {
    if (rtState.disposed || !project || !project.dirPath || typeof window.__agProjectCall !== 'function') return;
    if (force) {
      runRefresh(project, { force: true });
      return;
    }

    const dirPath = project.dirPath;
    const lang = FEAT.i18n ? 'zh' : 'en';
    const chats = buildChatsBriefInput(project);
    const prevSig = JSON.stringify(pState.projectSuggestionsMap[dirPath] || null);

    Promise.resolve(
      window.__agProjectCall('getProjectSuggestions', { dirPath, chats, lang, cacheOnly: true }, 6000)
    )
      .then((res) => {
        if (rtState.disposed || !res || typeof res !== 'object') return;
        pState.projectSuggestionsMap[dirPath] = res;
        if (JSON.stringify(res) !== prevSig) {
          renderIfViewingProject(project.id);
        }
        if (res.needsRefresh && res.hasApiKey && res.enabled && res.autoRefresh) {
          runRefresh(project, { force: false });
        }
      })
      .catch(() => {});
  }

  function applySuggestion({ suggestion, project, el, compInput, syncSend, dispatchPrompt, shiftKey, onRefreshStatus }) {
    if (!suggestion || !project) return;
    const promptText = String(suggestion.prompt || '');
    const targetWt = typeof suggestion.worktreePath === 'string' ? suggestion.worktreePath.trim() : '';
    const curWt = (project.dirPath && pState.pdActiveWorktreeByProj?.[project.dirPath]) || '';
    let switched = false;

    if (targetWt && project.dirPath && targetWt.toLowerCase() !== curWt.toLowerCase()) {
      pState.pdActiveWorktreeByProj[project.dirPath] = targetWt;
      pState.pdDirtyExpanded = false;
      pState.pdExpandedCommitHash = '';
      pState.pdWtConfirmRemovePath = '';
      switched = true;
      onRefreshStatus?.(targetWt, true);
      const branchLbl = suggestion.branch || targetWt.split(/[\\/]/).pop() || targetWt;
      pHooks.showProjectsFloatingNotice?.(
        L(`已切换到 Worktree：${branchLbl}`, `Switched worktree: ${branchLbl}`)
      );
    }

    pState.projectComposerDrafts.set(project.id, promptText);

    if (shiftKey) {
      if (compInput) {
        compInput.value = promptText;
        syncSend?.();
      }
      dispatchPrompt?.();
      return;
    }

    if (switched) {
      pHooks.renderProjectsView?.();
      const freshInput = el?.querySelector?.('#ag-pd-composer-input') || compInput;
      if (freshInput) {
        freshInput.focus();
        const len = freshInput.value.length;
        try {
          freshInput.setSelectionRange(len, len);
        } catch {}
      }
      return;
    }

    if (compInput) {
      compInput.value = promptText;
      syncSend?.();
      compInput.focus();
      const len = compInput.value.length;
      try {
        compInput.setSelectionRange(len, len);
      } catch {}
    }
  }

  return {
    loadProjectSuggestions,
    applySuggestion,
  };
}
