/**
 * Delegated DOM Click & Change Event Wiring for MAGA Unified Settings Root.
 */
import { PREVIEW_SAMPLE_GROUPS, buildDefaultPreviewSelectionMap } from './constants.mjs';

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
      }
      return;
    }

    const segBtn = target.closest('[data-ms-seg-kind]');
    if (segBtn) {
      const kind = segBtn.getAttribute('data-ms-seg-kind');
      const key = segBtn.getAttribute('data-ms-seg-key');
      const val = segBtn.getAttribute('data-ms-seg-val');
      if (kind === 'studio') {
        studioPrefs.patch({ [key]: val });
        flashToast('✓ 已保存', '✓ Saved');
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
