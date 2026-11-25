/**
 * Interactive Shadow DOM Live Preview Controller for MAGA Settings (Effort Bar + Orchestrator + Capsule Pill).
 */
import {
  PREVIEW_MODEL_LIST,
  PREVIEW_SAMPLE_GROUPS,
  SVG_CHECK_SM,
  SVG_CHEV_R,
  SVG_DOWN_SM,
  TIER_NAMES,
  esc,
  extractPreviewTierName,
} from './constants.mjs';

export function createFxPreviewController({
  shadowCss,
  labelsByLang,
  mountEffortBar,
  mountOrchestratorSwitch,
  state,
  L,
  isZh,
  dotColorSafe,
  getActiveContainer,
}) {
  let fxPreview = null;

  function disposeFxPreview() {
    if (!fxPreview) return;
    try { fxPreview.orch?.dispose?.(); } catch {}
    try { fxPreview.bar?.setOpen?.(false); } catch {}
    try { fxPreview.hostEl?.remove?.(); } catch {}
    fxPreview = null;
  }

  function syncFxPreviewState() {
    if (!fxPreview) return;
    const activeName = PREVIEW_SAMPLE_GROUPS[state.fxPreviewModel] ? state.fxPreviewModel : 'Gemini 4 Neon';
    state.fxPreviewActiveModel = activeName;
    const grp = PREVIEW_SAMPLE_GROUPS[activeName];
    const selected = state.fxPreviewSelectedByModel[grp.name] || grp.items[0].label;
    const dict = (isZh() ? labelsByLang?.['zh-CN'] : labelsByLang?.en) || {};
    const caption = dict.effortLevel || L('思考强度', 'Effort level');
    const effortOptions = dict.effortBarOptions || null;

    fxPreview.bar?.refresh?.(grp, selected, null, caption, effortOptions);
    fxPreview.bar?.setOpen?.(true);
    fxPreview.orch?.setState?.({
      visible: true,
      disabled: false,
      ariaDisabled: false,
      checked: state.fxPreviewOrchOn,
      modelName: grp.name,
    });
    fxPreview.orch?.setOpen?.(true);
  }

  function ensureFxPreview() {
    if (fxPreview && fxPreview.hostEl) return fxPreview;
    if (typeof mountEffortBar !== 'function' || typeof mountOrchestratorSwitch !== 'function') return null;

    const hostEl = document.createElement('div');
    hostEl.setAttribute('data-agy-fx-preview', '1');
    const shadow = hostEl.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = [
      shadowCss || '',
      ':host { display: block; width: 100%; }',
      '.agy-fx-stage { display: flex; flex-direction: column; width: 100%; font-family: var(--font-sans, "Google Sans Flex", -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif); }',
      '.agy-fx-stage > :is(.agy-effort, .dk-orch-slot) { contain: inline-size; }',
      '.agy-fx-stage .dk-orch-slot { margin: 4px 0 2px !important; padding: 0 !important; }',
      '.agy-fx-stage .dk-orch-slot[data-style="dock"] { margin: 4px 0 0 !important; }',
      '.agy-fx-stage .agy-effort { margin: 0 !important; }',
      '.agy-fx-stage .ces-ag-effort-row { width: 100%; }',
    ].join('\n');

    const stage = document.createElement('div');
    stage.className = 'agy-fx-stage';

    const orch = mountOrchestratorSwitch(
      () => {
        state.fxPreviewOrchOn = !state.fxPreviewOrchOn;
        syncFxPreviewState();
      },
      null
    );
    const bar = mountEffortBar(
      (label) => {
        state.fxPreviewSelectedByModel[state.fxPreviewActiveModel] = label;
        syncFxPreviewState();
        const container = getActiveContainer();
        const m = /\((off|low|medium|high|extra|xhigh|max|minimal)(?:\s+thinking)?\)$/i.exec(label);
        if (m) {
          const pretty = TIER_NAMES[m[1].toLowerCase()] || m[1];
          const pillEff = container?.querySelector('.agy-ms-prev-pill .agy-ms-prev-effort');
          const rowTier = container?.querySelector('.agy-ms-prev-row.is-active .agy-ms-prev-tier');
          const subHdr = container?.querySelector('.agy-ms-preview-sub');
          if (pillEff) pillEff.textContent = pretty;
          if (rowTier) rowTier.textContent = pretty;
          if (subHdr) subHdr.textContent = `${state.fxPreviewActiveModel} · ${pretty}`;
        }
      },
      (info) => orch?.setContext?.(info?.baseName, info?.energy)
    );

    stage.append(orch.element, bar.element);
    shadow.append(styleEl, stage);

    fxPreview = { hostEl, shadow, orch, bar };
    return fxPreview;
  }

  function mountFxPreviewInto(root, selector = '.agy-ms-prev-fx-host') {
    const slot = root?.querySelector(selector);
    if (!slot) {
      disposeFxPreview();
      return;
    }
    const inst = ensureFxPreview();
    if (!inst) return;
    if (inst.hostEl.parentElement !== slot) {
      slot.replaceChildren(inst.hostEl);
    }
    syncFxPreviewState();
  }

  function detachBeforeRebuild(wantsFx) {
    if (wantsFx) {
      if (fxPreview?.hostEl?.parentElement) {
        fxPreview.hostEl.parentElement.removeChild(fxPreview.hostEl);
      }
    } else {
      disposeFxPreview();
    }
  }

  function renderCapsulePreviewHtml(p) {
    const activeModel = PREVIEW_SAMPLE_GROUPS[state.fxPreviewModel] ? state.fxPreviewModel : 'Gemini 4 Neon';
    const secondaryModel = activeModel === 'Claude Opus 5.5' ? 'Gemini 4 Neon' : 'Claude Opus 5.5';
    const activeAccent = dotColorSafe(activeModel);
    const secAccent = dotColorSafe(secondaryModel);
    const activeTier = extractPreviewTierName(state.fxPreviewSelectedByModel[activeModel], 'High');
    const secTier = extractPreviewTierName(state.fxPreviewSelectedByModel[secondaryModel], 'Medium');
    const showFxInPreview = Boolean(p.showEffortBar || state.fxStudioTab !== 'capsule');

    const railHtml = PREVIEW_MODEL_LIST.map(([name, shortLbl]) => {
      const accent = dotColorSafe(name);
      const isSelected = activeModel === name;
      return `<button type="button" class="agy-ms-model-chip" role="radio" data-ms-fx-model="${esc(name)}" aria-checked="${isSelected ? 'true' : 'false'}" style="--sample-accent:${esc(accent)}"><span class="agy-ms-fx-sample-dot" aria-hidden="true"></span><span>${esc(shortLbl)}</span></button>`;
    }).join('');

    return `
      <div class="agy-ms-preview-stage">
        <div class="agy-ms-preview-hdr">
          <span class="agy-ms-preview-cap">${esc(L('实时交互预览', 'Live Interactive Preview'))}</span>
          <span class="agy-ms-preview-sub">${esc(`${activeModel} · ${activeTier}`)}</span>
        </div>
        <div class="agy-ms-studio-split">
          <div class="agy-ms-model-rail" role="radiogroup" aria-label="${esc(L('预览模型元素', 'Preview model element'))}">${railHtml}</div>
          <div class="agy-ms-prev-col">
            <div class="agy-ms-prev-menu">
              <div class="agy-ms-prev-row is-active">
                <span class="agy-ms-prev-row-l">
                  ${p.showModelDots ? `<span class="agy-ms-prev-dot" style="--prev-accent:${esc(activeAccent)}" aria-hidden="true"></span>` : ''}
                  <span>${esc(activeModel)}</span>
                  ${!p.hideDefaultEffort ? `<span class="agy-ms-prev-tier" style="--prev-accent:${esc(activeAccent)}">${esc(activeTier)}</span>` : ''}
                  ${!p.hideModelTags ? '<span class="agy-ms-prev-badge">New</span>' : ''}
                </span>
                ${SVG_CHECK_SM}
              </div>
              <div class="agy-ms-prev-row">
                <span class="agy-ms-prev-row-l">
                  ${p.showModelDots ? `<span class="agy-ms-prev-dot" style="--prev-accent:${esc(secAccent)}" aria-hidden="true"></span>` : ''}
                  <span>${esc(secondaryModel)}</span>
                  ${!p.hideDefaultEffort ? `<span class="agy-ms-prev-tier" style="--prev-accent:${esc(secAccent)}">${esc(secTier)}</span>` : ''}
                </span>
                ${SVG_CHEV_R}
              </div>
              ${showFxInPreview ? '<div class="agy-ms-prev-fx-host agy-ms-fx-shadow-host"></div>' : ''}
              ${
                !p.showEffortBar && state.fxStudioTab !== 'capsule'
                  ? `<div class="agy-ms-prev-hint">${esc(L('已在菜单中隐藏，当前仅作预览', 'Hidden in menu · preview only'))}</div>`
                  : ''
              }
            </div>
            <div class="agy-ms-prev-pill" style="--prev-accent:${esc(activeAccent)}">
              ${p.showModelDots ? '<span class="agy-ms-prev-dot" aria-hidden="true"></span>' : ''}
              <span>${esc(activeModel)}</span>
              <span class="agy-ms-prev-effort">${esc(activeTier)}</span>
              ${SVG_DOWN_SM}
            </div>
          </div>
        </div>
      </div>`;
  }

  return {
    syncFxPreviewState,
    mountFxPreviewInto,
    detachBeforeRebuild,
    disposeFxPreview,
    renderCapsulePreviewHtml,
  };
}
