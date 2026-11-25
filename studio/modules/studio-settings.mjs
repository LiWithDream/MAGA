/**
 * MAGA Unified Settings UI (Stacked L1 -> L2 -> L3 Drill-down):
 * 1. Overview top-bar Lucide cogwheel trigger (#agy-maga-settings-trigger) -> smooth right drawer (#agy-maga-settings-drawer)
 *    with automatic Overview hide/restore symmetry and Esc step-back navigation.
 * 2. Embedded unified `MAGA` pane inside Antigravity Settings (#ag-claude-ux-settings-nav / #ag-claude-ux-settings-panel).
 * 3. Delegates constants, live Shadow DOM preview & HTML templates to `./settings/{constants,preview,views}.mjs`.
 */

import { markOwn, setAttr, setLeafText } from '../core/dom.mjs';
import { getActiveRouteCid, isZhUi } from '../core/env.mjs';
import {
  DRAWER_ID,
  NAV_WRAP_ID,
  PANEL_ID,
  ROOT_ID,
  SVG_BACK,
  SVG_CLOSE,
  SVG_GEAR,
  TRIGGER_ID,
  buildDefaultPreviewSelectionMap,
  esc,
} from './settings/constants.mjs';
import { bindSettingsRootEvents } from './settings/events.mjs';
import { createFxPreviewController } from './settings/preview.mjs';
import {
  getViewMeta,
  renderL1,
  renderL2Appearance,
  renderL2Models,
  renderL2Stream,
  renderL2Workspace,
  renderL3HiddenModels,
  renderL3ModelTiers,
  renderL3OpusGate,
} from './settings/views.mjs';

export function createStudioSettingsRuntime({
  studioPrefs,
  mountEffortBar,
  mountOrchestratorSwitch,
  motionThemes,
  shadowCss = '',
  labelsByLang = null,
} = {}) {
  let disposed = false;
  let drawerEl = null;
  let drawerOpen = false;
  let restoreOverviewOnClose = false;
  let restoreRouteCid = '';
  let restoreTimer = 0;
  let toastTimer = 0;
  let toastVisible = false;
  let toastText = '';
  let toastTone = 'ok';
  let navDir = '';
  let lastRoutePath = typeof location === 'object' ? String(location.pathname || '') : '';
  let viewStack = [{ view: 'l1' }];

  const state = {
    resetArmed: false,
    fxStudioTab: 'capsule',
    fxPreviewModel: 'Gemini 4 Neon',
    fxPreviewActiveModel: 'Gemini 4 Neon',
    fxPreviewSelectedByModel: buildDefaultPreviewSelectionMap(studioPrefs?.get?.()?.defaultTierByFamily),
    fxPreviewOrchOn: true,
  };

  const isZh = () => isZhUi();
  const L = (zh, en) => (isZh() ? zh : en);
  const getActiveCid = () => getActiveRouteCid();
  const getOvToggleBtn = () => document.querySelector('button[data-testid="toggle-overview-panel"]');
  const getAuxToggleBtn = () => document.querySelector('button[data-testid="toggle-aux-sidebar"]');
  const isOverviewOpen = () => getOvToggleBtn()?.getAttribute('aria-pressed') === 'true';
  const isAuxOpen = () => getAuxToggleBtn()?.getAttribute('aria-expanded') === 'true';

  function dotColorSafe(name) {
    try {
      const c = typeof motionThemes === 'function' ? motionThemes().dotColorFor(name) : '';
      return c || '#7c5ce6';
    } catch {
      return '#7c5ce6';
    }
  }

  function prefersReducedMotion() {
    const ml = studioPrefs?.get?.()?.motionLevel || document.documentElement?.getAttribute?.('data-agy-motion');
    if (ml === 'reduced' || ml === 'off') return true;
    try {
      return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    } catch {
      return false;
    }
  }

  function getActiveEmbeddedPanel() {
    const panel = document.getElementById(PANEL_ID);
    return panel && !panel.hidden ? panel : null;
  }

  function getActiveContainer() {
    if (drawerOpen && drawerEl) return drawerEl;
    const panel = getActiveEmbeddedPanel();
    return panel?.querySelector(`#${ROOT_ID}`) ? panel : null;
  }

  const fxController = createFxPreviewController({
    shadowCss,
    labelsByLang,
    mountEffortBar,
    mountOrchestratorSwitch,
    state,
    L,
    isZh,
    dotColorSafe,
    getActiveContainer,
  });

  function currentView() {
    return viewStack[viewStack.length - 1] || { view: 'l1' };
  }

  function pushView(view, meta = null) {
    navDir = 'forward';
    state.resetArmed = false;
    let targetView = view;
    if (targetView === 'models-theme') {
      targetView = 'models';
      state.fxStudioTab = 'slider';
    }
    viewStack.push(meta ? { view: targetView, meta } : { view: targetView });
    renderActiveHost(false);
  }

  function popView() {
    if (viewStack.length <= 1) return false;
    navDir = 'back';
    state.resetArmed = false;
    viewStack.pop();
    renderActiveHost(false);
    return true;
  }

  function flashToast(msgZh, msgEn, tone = 'ok') {
    toastText = L(msgZh, msgEn);
    toastTone = tone;
    toastVisible = true;
    const toastEl = getActiveContainer()?.querySelector('.agy-ms-toast');
    if (toastEl) {
      toastEl.textContent = toastText;
      toastEl.setAttribute('data-tone', tone);
      toastEl.setAttribute('data-visible', '1');
    }
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = 0;
      toastVisible = false;
      const el = getActiveContainer()?.querySelector('.agy-ms-toast');
      if (el) el.setAttribute('data-visible', '0');
    }, 1500);
  }

  /* ---- Drawer Lifecycle ---- */

  function ensureDrawerEl() {
    if (drawerEl && drawerEl.isConnected) return drawerEl;
    drawerEl = document.getElementById(DRAWER_ID);
    if (!drawerEl) {
      drawerEl = document.createElement('aside');
      drawerEl.id = DRAWER_ID;
      markOwn(drawerEl);
      drawerEl.setAttribute('role', 'dialog');
      drawerEl.setAttribute('aria-modal', 'false');
      drawerEl.setAttribute('data-ag-i18n-ignore', '1');
      drawerEl.setAttribute('data-no-drag', '');
      document.body.appendChild(drawerEl);
    } else {
      markOwn(drawerEl);
    }
    return drawerEl;
  }

  function updateTriggerState() {
    const btn = document.getElementById(TRIGGER_ID);
    if (!btn) return;
    const exp = drawerOpen ? 'true' : 'false';
    setAttr(btn, 'aria-expanded', exp);
    const lbl = L('MAGA 设置', 'MAGA Settings');
    setAttr(btn, 'aria-label', lbl);
    if (btn.title !== lbl) btn.title = lbl;
  }

  function openDrawer() {
    if (disposed || drawerOpen) return;
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      restoreTimer = 0;
    }
    restoreOverviewOnClose = isOverviewOpen();
    restoreRouteCid = getActiveCid();
    document.documentElement.setAttribute('data-agy-maga-settings-open', '1');

    if (isAuxOpen()) {
      try { getAuxToggleBtn()?.click?.(); } catch {}
    }
    if (restoreOverviewOnClose) {
      try { getOvToggleBtn()?.click?.(); } catch {}
    }

    drawerOpen = true;
    viewStack = [{ view: 'l1' }];
    navDir = '';
    state.resetArmed = false;
    const el = ensureDrawerEl();
    renderInto(el, 'drawer', false);
    try { void el.offsetWidth; } catch {}
    el.setAttribute('data-open', '1');
    updateTriggerState();
  }

  function closeDrawer({ restore = true } = {}) {
    if (!drawerOpen && !document.documentElement?.hasAttribute?.('data-agy-maga-settings-open')) return;
    const shouldRestore = restore && restoreOverviewOnClose && restoreRouteCid && restoreRouteCid === getActiveCid();
    const targetCid = restoreRouteCid;
    drawerOpen = false;
    restoreOverviewOnClose = false;
    restoreRouteCid = '';
    state.resetArmed = false;
    updateTriggerState();
    fxController.disposeFxPreview();

    if (drawerEl) drawerEl.removeAttribute('data-open');

    const finish = () => {
      restoreTimer = 0;
      if (disposed || drawerOpen) return;
      document.documentElement.removeAttribute('data-agy-maga-settings-open');
      if (shouldRestore && targetCid === getActiveCid() && !isAuxOpen() && !isOverviewOpen()) {
        const ovBtn = getOvToggleBtn();
        if (ovBtn && !ovBtn.disabled) {
          try { ovBtn.click(); } catch {}
        }
      }
    };

    if (restoreTimer) clearTimeout(restoreTimer);
    if (!restore || prefersReducedMotion()) {
      finish();
    } else {
      restoreTimer = setTimeout(finish, 180);
    }
  }

  function renderActiveHost(preserveScroll = true) {
    if (disposed) return;
    if (drawerOpen && drawerEl) {
      renderInto(drawerEl, 'drawer', preserveScroll);
    }
    const panel = getActiveEmbeddedPanel();
    if (panel) {
      renderInto(panel, 'page', preserveScroll);
    }
  }

  function renderInto(hostEl, mode, preserveScroll = true) {
    if (!hostEl || disposed) return;
    let root = hostEl.querySelector(`#${ROOT_ID}`);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      markOwn(root);
      root.setAttribute('data-ag-i18n-ignore', '1');
      if (mode === 'drawer') {
        hostEl.replaceChildren(root);
      } else {
        setAttr(hostEl, 'data-agy-maga-host', '1');
        hostEl.appendChild(root);
      }
      bindRootEvents(root);
    } else {
      markOwn(root);
      if (mode === 'page') setAttr(hostEl, 'data-agy-maga-host', '1');
    }
    const nextRootClass = mode === 'drawer' ? 'is-drawer' : 'is-page';
    if (root.className !== nextRootClass) root.className = nextRootClass;

    const prevBody = root.querySelector('.agy-ms-body');
    const prevScrollTop = preserveScroll && prevBody ? prevBody.scrollTop : 0;

    const p = studioPrefs.get();
    const base = studioPrefs.getBaseState();
    const catalog = studioPrefs.getModelCatalog();
    const cur = currentView();
    const meta = getViewMeta(cur.view, L);
    const viewCtx = {
      studioPrefs,
      state,
      L,
      renderCapsulePreviewHtml: fxController.renderCapsulePreviewHtml,
    };

    const wantsFx = cur.view === 'models' && (p.showEffortBar || state.fxStudioTab !== 'capsule');
    let bodyHtml = '';
    if (cur.view === 'l1') bodyHtml = renderL1(p, base, catalog, viewCtx);
    else if (cur.view === 'models') bodyHtml = renderL2Models(p, catalog, viewCtx);
    else if (cur.view === 'models-tiers') bodyHtml = renderL3ModelTiers(p, catalog, viewCtx);
    else if (cur.view === 'models-hidden') bodyHtml = renderL3HiddenModels(p, catalog, viewCtx);
    else if (cur.view === 'models-opus-gate') bodyHtml = renderL3OpusGate(p, viewCtx);
    else if (cur.view === 'stream') bodyHtml = renderL2Stream(p, base, viewCtx);
    else if (cur.view === 'workspace') bodyHtml = renderL2Workspace(p, base, viewCtx);
    else if (cur.view === 'appearance') bodyHtml = renderL2Appearance(p, base, viewCtx);

    const canBack = viewStack.length > 1;
    const headerHtml = `
      <div class="agy-ms-header">
        <div class="agy-ms-header-left">
          ${
            canBack
              ? `<button type="button" class="agy-ms-back" data-ms-action="back">${SVG_BACK}<span>${esc(L('返回', 'Back'))}</span></button>`
              : ''
          }
          <div style="min-width:0">
            ${canBack && meta.parent ? `<div class="agy-ms-crumb">${esc(meta.parent)}</div>` : ''}
            <h2 class="agy-ms-title">${esc(meta.title)}</h2>
          </div>
        </div>
        <div class="agy-ms-header-right">
          <span class="agy-ms-toast" data-tone="${esc(toastTone)}" data-visible="${toastVisible ? '1' : '0'}">${esc(toastText)}</span>
          ${
            mode === 'drawer'
              ? `<button type="button" class="agy-ms-close" data-ms-action="close-drawer" aria-label="${esc(L('关闭设置', 'Close settings'))}">${SVG_CLOSE}</button>`
              : ''
          }
        </div>
      </div>`;

    const dirAttr = navDir ? ` data-nav-dir="${navDir}"` : '';
    navDir = '';
    const nextHtml = `${headerHtml}<div class="agy-ms-body"${dirAttr}>${bodyHtml}</div>`;

    if (
      !dirAttr &&
      root.__agyLastHtml === nextHtml &&
      root.querySelector('.agy-ms-body') &&
      (!wantsFx || root.querySelector('.agy-ms-prev-fx-host [data-agy-fx-preview]'))
    ) {
      return;
    }

    fxController.detachBeforeRebuild(wantsFx);
    root.__agyLastHtml = nextHtml;
    root.innerHTML = nextHtml;

    if (wantsFx) {
      fxController.mountFxPreviewInto(root, '.agy-ms-prev-fx-host');
    }

    const nextBody = root.querySelector('.agy-ms-body');
    if (nextBody && prevScrollTop > 0) {
      nextBody.scrollTop = prevScrollTop;
    }
  }

  /* ---- Root Event Delegation ---- */

  function bindRootEvents(root) {
    bindSettingsRootEvents(root, {
      studioPrefs,
      state,
      pushView,
      popView,
      closeDrawer,
      renderActiveHost,
      flashToast,
    });
  }

  /* ---- Host Mounting & Native Event Integration ---- */

  function syncOverviewTrigger() {
    const ov = document.querySelector('[data-testid="overview-panel"]');
    const customizeBtn = ov?.querySelector('button[data-testid="overview-panel-customize-trigger"]');
    const rightGroup = customizeBtn?.parentElement;
    if (!rightGroup) return;

    let btn = document.getElementById(TRIGGER_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = TRIGGER_ID;
      btn.type = 'button';
      markOwn(btn);
      btn.setAttribute('data-ag-i18n-ignore', '1');
      btn.setAttribute('data-no-drag', '');
      btn.innerHTML = SVG_GEAR;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (drawerOpen) closeDrawer({ restore: true });
        else openDrawer();
      });
    } else {
      markOwn(btn);
    }
    if (btn.parentElement !== rightGroup || btn.nextElementSibling !== customizeBtn) {
      rightGroup.insertBefore(btn, customizeBtn);
    }
    updateTriggerState();
  }

  function syncNativeSettingsHost() {
    const navWrap = document.getElementById(NAV_WRAP_ID);
    const navBtn = navWrap?.querySelector('button');
    if (navBtn) {
      const span = navBtn.querySelector('span');
      if (span) setLeafText(span, 'MAGA');
      setAttr(navBtn, 'aria-label', 'MAGA');
      if (!navBtn.__agyMagaBound) {
        navBtn.__agyMagaBound = true;
        navBtn.addEventListener('click', () => {
          requestAnimationFrame(() => syncNativeSettingsHost());
        });
      }
    }

    const panel = getActiveEmbeddedPanel();
    if (panel) {
      renderInto(panel, 'page', true);
    }
  }

  const onDocKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    if (drawerOpen) {
      e.preventDefault();
      e.stopPropagation();
      if (!popView()) closeDrawer({ restore: true });
      return;
    }
    const panel = getActiveEmbeddedPanel();
    if (panel && viewStack.length > 1) {
      e.preventDefault();
      e.stopPropagation();
      popView();
    }
  };

  const onDocClickCapture = (e) => {
    if (!drawerOpen) return;
    if (drawerEl?.contains(e.target)) return;
    if (e.target?.closest?.(`#${TRIGGER_ID}`)) return;
    const toggleHit = e.target?.closest?.('button[data-testid="toggle-overview-panel"], button[data-testid="toggle-aux-sidebar"]');
    if (toggleHit) {
      closeDrawer({ restore: false });
    }
  };

  document.addEventListener('keydown', onDocKeyDown, true);
  document.addEventListener('click', onDocClickCapture, true);

  const offPrefsSub = studioPrefs?.subscribe?.(() => {
    if (disposed) return;
    updateTriggerState();
    renderActiveHost(true);
  });

  function read(snapshot = null) {
    if (disposed) return null;
    const curPath = snapshot ? snapshot.pathname : String(location.pathname || '');
    const ov = snapshot ? snapshot.ovPanel : document.querySelector('[data-testid="overview-panel"]');
    const customizeBtn = ov?.querySelector?.('button[data-testid="overview-panel-customize-trigger"]') || null;
    const navWrap = document.getElementById(NAV_WRAP_ID);
    const activePanel = getActiveEmbeddedPanel();
    return { curPath, customizeBtn, navWrap, activePanel };
  }

  function write(snapshot = null, planArg = undefined) {
    if (disposed) return;
    const plan = planArg !== undefined ? planArg : read(snapshot);
    if (!plan) return;
    if (plan.curPath !== lastRoutePath) {
      lastRoutePath = plan.curPath;
      if (drawerOpen) closeDrawer({ restore: false });
    }
    if (plan.customizeBtn) syncOverviewTrigger();
    if (plan.navWrap || plan.activePanel) syncNativeSettingsHost();
  }

  function sync() {
    if (disposed) return;
    write(null, read(null));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    offPrefsSub?.();
    fxController.disposeFxPreview();
    if (restoreTimer) clearTimeout(restoreTimer);
    if (toastTimer) clearTimeout(toastTimer);
    document.removeEventListener('keydown', onDocKeyDown, true);
    document.removeEventListener('click', onDocClickCapture, true);
    document.documentElement?.removeAttribute?.('data-agy-maga-settings-open');
    document.getElementById(TRIGGER_ID)?.remove();
    document.getElementById(DRAWER_ID)?.remove();
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.removeAttribute('data-agy-maga-host');
      panel.querySelector(`#${ROOT_ID}`)?.remove();
    }
    if (typeof window === 'object' && window.__agyStudioSettings === api) {
      window.__agyStudioSettings = null;
    }
  }

  const api = {
    topics: ['settings', 'overview', 'route', 'prefs'],
    openDrawer,
    closeDrawer,
    pushView,
    popView,
    read,
    write,
    sync,
    dispose,
    isDrawerOpen: () => drawerOpen,
  };

  if (typeof window === 'object' && window) {
    window.__agyStudioSettings = api;
  }

  return api;
}
