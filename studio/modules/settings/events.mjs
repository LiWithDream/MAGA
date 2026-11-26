/**
 * Delegated DOM Click & Change Event Wiring for MAGA Unified Settings Root.
 */
import { PREVIEW_SAMPLE_GROUPS, buildDefaultPreviewSelectionMap } from './constants.mjs';

export function loadAiSuggestionsConfigIfNeeded(state, viewName, onLoaded) {
  if (!state || (viewName !== 'workspace' && viewName !== 'workspace-ai-suggestions')) return;
  if (state.aiSuggestionsCfg || state.aiSuggestionsLoading) return;
  if (typeof window?.__agProjectCall !== 'function') return;
  state.aiSuggestionsLoading = true;
  Promise.resolve(window.__agProjectCall('getProjectSuggestionsConfig', {}, 4000))
    .then((res) => {
      state.aiSuggestionsLoading = false;
      if (res && res.ok) {
        state.aiSuggestionsCfg = res;
        onLoaded?.();
      }
    })
    .catch(() => {
      state.aiSuggestionsLoading = false;
    });
}

export function loadGitWorkflowStatusIfNeeded(state, viewName, onLoaded) {
  if (!state || (viewName !== 'workspace' && viewName !== 'workspace-git-workflow')) return;
  if (state.gitWorkflowStatus || state.gitWorkflowLoading) return;
  if (typeof window?.__agProjectCall !== 'function') return;
  state.gitWorkflowLoading = true;
  Promise.resolve(window.__agProjectCall('getGitWorkflowPolicy', {}, 4000))
    .then((res) => {
      state.gitWorkflowLoading = false;
      if (res && res.ok) {
        state.gitWorkflowStatus = res;
        onLoaded?.();
      }
    })
    .catch(() => {
      state.gitWorkflowLoading = false;
    });
}

function readAiSuggestionsInputs(root) {
  const apiKey = root.querySelector('[data-ms-ai-input="apiKey"]')?.value?.trim() || '';
  const model = root.querySelector('[data-ms-ai-input="model"]')?.value?.trim() || '';
  const baseUrl = root.querySelector('[data-ms-ai-input="baseUrl"]')?.value?.trim() || '';
  return { apiKey, model, baseUrl };
}

export function bindSettingsRootEvents(root, {
  studioPrefs,
  state,
  pushView,
  popView,
  closeDrawer,
  renderActiveHost,
  flashToast,
}) {
  if (!root || root.__agyMsBound) return;
  root.__agyMsBound = true;

  root.addEventListener('click', async (e) => {
    const target = e.target;
    if (!target || !target.closest) return;

    const fxBtn = target.closest('[data-ms-fx-model]');
    if (fxBtn) {
      const nextModel = fxBtn.getAttribute('data-ms-fx-model');
      if (nextModel && PREVIEW_SAMPLE_GROUPS[nextModel]) {
        state.fxPreviewModel = nextModel;
        renderActiveHost(true);
      }
      return;
    }

    const studioTabBtn = target.closest('[data-ms-studio-tab]');
    if (studioTabBtn) {
      const nextTab = studioTabBtn.getAttribute('data-ms-studio-tab');
      if (nextTab === 'capsule' || nextTab === 'slider' || nextTab === 'orch') {
        state.fxStudioTab = nextTab;
        renderActiveHost(true);
      }
      return;
    }

    const navBtn = target.closest('[data-ms-nav]');
    if (navBtn) {
      pushView(navBtn.getAttribute('data-ms-nav'));
      return;
    }

    const actionBtn = target.closest('[data-ms-action]');
    if (actionBtn) {
      const act = actionBtn.getAttribute('data-ms-action');
      if (act === 'back') {
        popView();
      } else if (act === 'close-drawer') {
        closeDrawer({ restore: true });
      } else if (act === 'export') {
        const payload = studioPrefs.exportConfig();
        const jsonText = JSON.stringify(payload, null, 2) + '\n';
        const blob = new Blob([jsonText], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `maga-config-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        flashToast('✓ 已导出配置 JSON', '✓ Exported JSON');
      } else if (act === 'import') {
        const input = root.querySelector('[data-ms-file-input]');
        if (input) {
          input.value = '';
          input.click();
        }
      } else if (act === 'reset-arm') {
        state.resetArmed = !state.resetArmed;
        renderActiveHost(true);
      } else if (act === 'reset-cancel') {
        state.resetArmed = false;
        renderActiveHost(true);
      } else if (act === 'reset-confirm') {
        state.resetArmed = false;
        await studioPrefs.resetAll();
        state.fxPreviewSelectedByModel = buildDefaultPreviewSelectionMap(studioPrefs.get().defaultTierByFamily);
        flashToast('✓ 已恢复默认设置', '✓ Defaults restored');
      } else if (act === 'show-all-models') {
        studioPrefs.patch({ hiddenModels: [], customizeModelList: false });
        flashToast('✓ 已恢复全部显示', '✓ All models shown');
      } else if (act === 'reset-tiers') {
        state.fxPreviewSelectedByModel = buildDefaultPreviewSelectionMap({ 'Gemini 4 Neon': 'high' });
        studioPrefs.patch({ defaultTierByFamily: { 'Gemini 4 Neon': 'high' } });
        flashToast('✓ 已恢复推荐档位', '✓ Tier defaults restored');
      } else if (act === 'sync-opus-plugin') {
        if (typeof window.__agProjectCall === 'function') {
          const res = await window.__agProjectCall('syncOpusGatePlugin', {}, 5000).catch(() => null);
          if (res?.ok) flashToast('✓ 已同步 Opus Gate 插件', '✓ Opus Gate plugin synced');
          else flashToast('同步插件失败', 'Plugin sync failed', 'error');
        }
      } else if (act === 'trigger-opus-gate') {
        closeDrawer({ restore: false });
        if (typeof window.__agyOpusGateTrigger === 'function') {
          window.__agyOpusGateTrigger('manual');
        }
      } else if (act === 'sync-auto-compact-plugin') {
        if (typeof window.__agProjectCall === 'function') {
          const res = await window.__agProjectCall('syncAutoCompactPlugin', {}, 5000).catch(() => null);
          if (res?.ok) flashToast('✓ 已同步 Auto-Compact 插件', '✓ Auto-Compact plugin synced');
          else flashToast('同步插件失败', 'Plugin sync failed', 'error');
        }
      } else if (act === 'sync-git-workflow-plugin') {
        if (typeof window.__agProjectCall === 'function') {
          const res = await window.__agProjectCall('syncGitWorkflowPlugin', {}, 5000).catch(() => null);
          if (res?.ok) {
            const st = await window.__agProjectCall('getGitWorkflowPolicy', {}, 4000).catch(() => null);
            if (st?.ok) state.gitWorkflowStatus = st;
            renderActiveHost(true);
            flashToast('✓ 已同步 Git 工作流插件', '✓ Git Workflow plugin synced');
          } else {
            flashToast('同步插件失败', 'Plugin sync failed', 'error');
          }
        }
      } else if (act === 'prune-git-workflow-stale') {
        if (typeof window.__agProjectCall === 'function') {
          const res = await window.__agProjectCall('setGitWorkflowPolicy', { pruneStale: true }, 5000).catch(() => null);
          if (res?.ok) {
            state.gitWorkflowStatus = res;
            renderActiveHost(true);
            flashToast('✓ 已清理失效项目策略', '✓ Pruned stale entries');
          } else {
            flashToast('清理失败', 'Prune failed', 'error');
          }
        }
      } else if (act === 'trigger-compact-now') {
        closeDrawer({ restore: false });
        const fn = window.__agClaudeUxBridge?.triggerConversationCompact;
        if (typeof fn === 'function') {
          const ok = await Promise.resolve(fn()).catch(() => false);
          if (!ok) flashToast('当前会话暂不可压缩', 'Cannot compact right now', 'error');
        }
      } else if (act === 'ai-sugg-save' && typeof window.__agProjectCall === 'function') {
        const { apiKey, model, baseUrl } = readAiSuggestionsInputs(root);
        const res = await window.__agProjectCall('saveProjectSuggestionsConfig', { apiKey, model, baseUrl }, 5000).catch(() => null);
        if (res?.ok) {
          state.aiSuggestionsCfg = res;
          state.aiSuggestionsTestStatus = null;
          renderActiveHost(true);
          flashToast('✓ 已保存 API 配置', '✓ API config saved');
        } else {
          flashToast('保存配置失败', 'Failed to save config', 'error');
        }
      } else if (act === 'ai-sugg-clear-key' && typeof window.__agProjectCall === 'function') {
        const res = await window.__agProjectCall('saveProjectSuggestionsConfig', { clearApiKey: true }, 5000).catch(() => null);
        if (res?.ok) {
          state.aiSuggestionsCfg = res;
          state.aiSuggestionsTestStatus = null;
          renderActiveHost(true);
          flashToast('✓ 已清除 API Key', '✓ API key cleared');
        } else {
          flashToast('清除失败', 'Failed to clear key', 'error');
        }
      } else if (act === 'ai-sugg-test' && typeof window.__agProjectCall === 'function') {
        const { apiKey, model, baseUrl } = readAiSuggestionsInputs(root);
        const isZh = document.documentElement?.getAttribute?.('data-ag-ux-lang') === 'zh';
        state.aiSuggestionsTestStatus = {
          busy: true,
          ok: false,
          message: isZh ? '正在测试连接…' : 'Testing connection…',
        };
        renderActiveHost(true);
        const res = await window.__agProjectCall('testProjectSuggestionsConfig', { apiKey, model, baseUrl }, 15000).catch(() => null);
        if (res?.ok) {
          state.aiSuggestionsTestStatus = {
            busy: false,
            ok: true,
            message: isZh
              ? `✓ 连接成功 (${res.model} · ${res.latencyMs || 0}ms)`
              : `✓ Connected (${res.model} · ${res.latencyMs || 0}ms)`,
          };
          flashToast('✓ 连接测试成功', '✓ Connection ok');
        } else {
          const errCode = res?.error || 'request_failed';
          state.aiSuggestionsTestStatus = {
            busy: false,
            ok: false,
            message: isZh ? `连接失败：${errCode}` : `Connection failed: ${errCode}`,
          };
          flashToast('连接测试失败', 'Connection failed', 'error');
        }
        renderActiveHost(true);
      }
      return;
    }

    const wfProjBtn = target.closest('[data-ms-wf-proj-dir][data-ms-wf-proj-mode]');
    if (wfProjBtn && typeof window.__agProjectCall === 'function') {
      const dirPath = wfProjBtn.getAttribute('data-ms-wf-proj-dir') || '';
      const mode = wfProjBtn.getAttribute('data-ms-wf-proj-mode') || 'default';
      if (!dirPath) return;
      const res = await window.__agProjectCall('setGitWorkflowPolicy', { dirPath, mode }, 5000).catch(() => null);
      if (res?.ok) {
        state.gitWorkflowStatus = res;
        renderActiveHost(true);
        flashToast('✓ 已更新项目护栏', '✓ Project workflow saved');
      } else {
        flashToast('更新项目护栏失败', 'Update failed', 'error');
      }
      return;
    }

    const aiPresetBtn = target.closest('[data-ms-ai-model-preset]');
    if (aiPresetBtn && typeof window.__agProjectCall === 'function') {
      const presetModel = aiPresetBtn.getAttribute('data-ms-ai-model-preset') || '';
      const modelInput = root.querySelector('[data-ms-ai-input="model"]');
      if (modelInput && presetModel) modelInput.value = presetModel;
      const res = await window.__agProjectCall('saveProjectSuggestionsConfig', { model: presetModel }, 5000).catch(() => null);
      if (res?.ok) {
        state.aiSuggestionsCfg = res;
        state.aiSuggestionsTestStatus = null;
        renderActiveHost(true);
        flashToast('✓ 已切换模型', '✓ Model updated');
      }
      return;
    }

    const swBtn = target.closest('[data-ms-kind][data-ms-key]');
    if (swBtn) {
      const kind = swBtn.getAttribute('data-ms-kind');
      const key = swBtn.getAttribute('data-ms-key');
      const nextVal = swBtn.getAttribute('aria-checked') !== 'true';
      if (kind === 'studio') {
        studioPrefs.patch({ [key]: nextVal });
        flashToast('✓ 已保存', '✓ Saved');
      } else if (kind === 'base') {
        studioPrefs.setBaseModule(key, nextVal);
        flashToast('✓ 已保存', '✓ Saved');
      } else if (kind === 'opus-cp') {
        const curCp = Object.assign({ plan: true, risk: true, debug: true, stop: true }, studioPrefs.get().opusGateCheckpoints || {});
        curCp[key] = nextVal;
        studioPrefs.patch({ opusGateCheckpoints: curCp });
        flashToast('✓ 已保存', '✓ Saved');
      } else if (kind === 'ac-trigger') {
        const curTr = Object.assign({ longTimer: true, modelRequest: true, highWater: false }, studioPrefs.get().autoCompactTriggers || {});
        curTr[key] = nextVal;
        studioPrefs.patch({ autoCompactTriggers: curTr });
        flashToast('✓ 已保存', '✓ Saved');
      } else if (kind === 'ai-sugg' && typeof window.__agProjectCall === 'function') {
        const res = await window.__agProjectCall('saveProjectSuggestionsConfig', { [key]: nextVal }, 5000).catch(() => null);
        if (res?.ok) {
          state.aiSuggestionsCfg = res;
          renderActiveHost(true);
          flashToast('✓ 已保存', '✓ Saved');
        }
      } else if (kind === 'wf-global' && typeof window.__agProjectCall === 'function') {
        const res = await window.__agProjectCall('setGitWorkflowPolicy', { [key]: nextVal }, 5000).catch(() => null);
        if (res?.ok) {
          state.gitWorkflowStatus = res;
          renderActiveHost(true);
          flashToast('✓ 已保存', '✓ Saved');
        }
      }
      return;
    }

    const segBtn = target.closest('[data-ms-seg-kind]');
    if (segBtn) {
      const kind = segBtn.getAttribute('data-ms-seg-kind');
      const key = segBtn.getAttribute('data-ms-seg-key');
      const val = segBtn.getAttribute('data-ms-seg-val');
      if (kind === 'wf-global' && typeof window.__agProjectCall === 'function') {
        const res = await window.__agProjectCall('setGitWorkflowPolicy', { [key]: val }, 5000).catch(() => null);
        if (res?.ok) {
          state.gitWorkflowStatus = res;
          renderActiveHost(true);
          flashToast('✓ 已保存', '✓ Saved');
        }
        return;
      } else if (kind === 'studio') {
        const prevMode = studioPrefs.get().opusGateMode;
        const prevAcMode = studioPrefs.get().autoCompactMode;
        studioPrefs.patch({ [key]: val });
        if (key === 'opusGateMode' && prevMode === 'off' && val !== 'off' && typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('syncOpusGatePlugin', {}, 5000).catch(() => {});
        }
        if (key === 'autoCompactMode' && prevAcMode === 'off' && val !== 'off' && typeof window.__agProjectCall === 'function') {
          window.__agProjectCall('syncAutoCompactPlugin', {}, 5000).catch(() => {});
        }
        flashToast('✓ 已保存', '✓ Saved');
      } else if (kind === 'studio-num') {
        const numVal = Number(val);
        if (Number.isFinite(numVal)) {
          studioPrefs.patch({ [key]: numVal });
          flashToast('✓ 已保存', '✓ Saved');
        }
      } else if (kind === 'cjk') {
        studioPrefs.setCjkScale(val);
        flashToast('✓ 已保存', '✓ Saved');
      } else if (kind === 'step') {
        await studioPrefs.setStepStreamMode(val);
        flashToast('✓ 已保存', '✓ Saved');
      } else if (kind === 'tier') {
        const curMap = Object.assign({}, studioPrefs.get().defaultTierByFamily || {});
        curMap[key] = val;
        if (PREVIEW_SAMPLE_GROUPS[key]) {
          const grp = PREVIEW_SAMPLE_GROUPS[key];
          const matched = grp.items.find((it) => it.tier.toLowerCase() === String(val).toLowerCase());
          if (matched) state.fxPreviewSelectedByModel[key] = matched.label;
        }
        studioPrefs.patch({ defaultTierByFamily: curMap });
        flashToast('✓ 已保存', '✓ Saved');
      }
      return;
    }

    const hideRow = target.closest('[data-ms-hide-model]');
    if (hideRow) {
      const name = hideRow.getAttribute('data-ms-hide-model');
      if (!name) return;
      const cur = studioPrefs.get();
      const set = new Set(cur.hiddenModels || []);
      const willHide = !set.has(name);
      if (willHide) set.add(name);
      else set.delete(name);
      studioPrefs.patch({
        customizeModelList: willHide ? true : cur.customizeModelList,
        hiddenModels: Array.from(set),
      });
      flashToast('✓ 已保存', '✓ Saved');
    }
  });

  root.addEventListener('change', async (e) => {
    const target = e.target;
    if (!target) return;
    if (target.matches?.('select[data-ms-host]')) {
      const hostKey = target.getAttribute('data-ms-host');
      const numVal = Number(target.value);
      if (hostKey && Number.isFinite(numVal)) {
        await studioPrefs.setHostPref(hostKey, numVal);
        flashToast('✓ 已同步宿主配置', '✓ Host preference saved');
      }
      return;
    }
    if (target.matches?.('input[data-ms-file-input]')) {
      const file = target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const res = await studioPrefs.importConfig(parsed);
        if (res.ok) {
          flashToast('✓ 已导入配置', '✓ Config imported');
        } else {
          flashToast('配置格式无效', 'Invalid config JSON', 'error');
        }
      } catch {
        flashToast('读取配置文件失败', 'Failed to read JSON file', 'error');
      }
    }
  });
}
