/**
 * Native Antigravity Settings host mount & collapsible "Stats / 统计" sidebar tree.
 * Provides the empty #ag-claude-ux-settings-nav / #ag-claude-ux-settings-panel host container
 * that studio/modules/studio-settings.mjs renders the unified MAGA settings UI into.
 * (Legacy standalone .ag-cux-settings-wrap / .ag-claude-switch toggle form has been retired.)
 */
export function createSettingsHostModule(rt) {
  const { escapeHtml, FEAT, L, state: rtState, syncAttrTargetSet, setLeafText } = rt;

  let settingsSidebarRef = null;
  let settingsRightRef = null;
  let settingsNavWrap = null;
  let settingsNavBtn = null;
  let settingsPanelEl = null;
  let settingsStatsOpen = false;
  let settingsStatsProjOpen = false;
  let settingsStatsUnlinkedOpen = false;
  let settingsStatsBtnWrap = null;

  const SVG_SETTINGS_CHEVRON =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.2L8 9.8l3.5-3.6"/></svg>';

  function syncSettingsDomFlags(sb) {
    const hosts = new Set();
    const wraps = new Set();
    if (sb) {
      const dlg = sb.closest('[role="dialog"]');
      if (dlg) hosts.add(dlg);
      const split = sb.closest('[data-split-root]');
      if (split) hosts.add(split);
      const p1 = sb.parentElement;
      if (p1 && p1.tagName === 'DIV') {
        wraps.add(p1);
        const p2 = p1.parentElement;
        if (p2 && p2.tagName === 'DIV') wraps.add(p2);
      }
    }
    syncAttrTargetSet('data-maga-settings-host', hosts);
    syncAttrTargetSet('data-maga-settings-wrap', wraps);

    const cardSplits = new Set();
    document.querySelectorAll('.agy-card > div > div.w-full.flex.justify-between').forEach((hdr) => {
      if (hdr.parentElement) cardSplits.add(hdr.parentElement);
    });
    syncAttrTargetSet('data-maga-card-split', cardSplits);
  }

  function cleanupSettingsStatsGroup(sb) {
    if (settingsStatsBtnWrap && settingsStatsBtnWrap.parentNode) settingsStatsBtnWrap.remove();
    settingsStatsBtnWrap = null;
    const root = sb || null;
    if (!root) return;
    root.removeAttribute('data-ag-stats-ready');
    root.querySelectorAll('.ag-settings-subhdr-chev').forEach((el) => el.remove());
    root
      .querySelectorAll(
        '[data-ag-stats-hidden], [data-ag-stats-subhdr], [data-ag-stats-list], [data-ag-stats-open], [data-ag-stats-active], [data-ag-stats-passthrough]'
      )
      .forEach((el) => {
        if (el.__agStatsHandlers) {
          el.removeEventListener('click', el.__agStatsHandlers.onClick);
          el.removeEventListener('keydown', el.__agStatsHandlers.onKeyDown);
          delete el.__agStatsHandlers;
        }
        delete el.__agStatsBound;
        el.removeAttribute('data-ag-stats-hidden');
        el.removeAttribute('data-ag-stats-subhdr');
        el.removeAttribute('data-ag-stats-list');
        el.removeAttribute('data-ag-stats-open');
        el.removeAttribute('data-ag-stats-active');
        el.removeAttribute('data-ag-stats-passthrough');
        el.removeAttribute('role');
        el.removeAttribute('tabindex');
        el.removeAttribute('aria-expanded');
      });
  }

  function syncSettingsStatsGroup(sb) {
    const sidebar = sb || settingsSidebarRef || document.querySelector('[data-testid="settings-sidebar"]');
    if (!sidebar || rtState.disposed) return;

    let projHdr = null;
    let projList = null;
    let unlinkedHdr = null;
    let unlinkedList = null;

    for (const h2 of sidebar.querySelectorAll('h2')) {
      const txt = (h2.textContent || '').trim();
      const wrap = h2.parentElement;
      if (!wrap || wrap === sidebar) continue;
      if (!projHdr && /^(Projects|项目)$/i.test(txt)) {
        wrap.removeAttribute('data-ag-stats-passthrough');
        projHdr = wrap;
        const next = wrap.nextElementSibling;
        if (next && !next.querySelector('h2')) {
          next.removeAttribute('data-ag-stats-passthrough');
          projList = next;
        }
      } else if (!unlinkedHdr && /^(Not in Project|Outside of Project|未关联项目)$/i.test(txt)) {
        wrap.removeAttribute('data-ag-stats-passthrough');
        unlinkedHdr = wrap;
        const next = wrap.nextElementSibling;
        if (next && !next.querySelector('h2')) {
          next.removeAttribute('data-ag-stats-passthrough');
          unlinkedList = next;
        }
      } else {
        wrap.setAttribute('data-ag-stats-passthrough', '1');
        const next = wrap.nextElementSibling;
        if (next && !next.querySelector('h2')) next.setAttribute('data-ag-stats-passthrough', '1');
      }
    }

    const firstAnchor = projHdr || unlinkedHdr;
    if (!firstAnchor || !firstAnchor.parentElement) {
      cleanupSettingsStatsGroup(sidebar);
      return;
    }
    if (sidebar.getAttribute('data-ag-stats-ready') !== '1') {
      sidebar.setAttribute('data-ag-stats-ready', '1');
    }

    const nativeNavBtn =
      sidebar.querySelector('button[data-testid="settings-nav-item-Browser"]') ||
      sidebar.querySelector('button[data-testid="settings-nav-item-Appearance"]') ||
      sidebar.querySelector('button[data-testid^="settings-nav-item-"]:not([data-testid="settings-nav-item-Stats"])');
    const navWrapCls = (nativeNavBtn && nativeNavBtn.parentElement && nativeNavBtn.parentElement.className) || 'relative group/nav-item mx-2';
    const navBtnCls = nativeNavBtn
      ? (nativeNavBtn.className || '').replace(/\bbg-sidebar-secondary\b/g, 'hover:bg-sidebar-muted')
      : '';

    if (!settingsStatsBtnWrap || !settingsStatsBtnWrap.isConnected || settingsStatsBtnWrap.parentElement !== firstAnchor.parentElement) {
      if (settingsStatsBtnWrap && settingsStatsBtnWrap.parentNode) settingsStatsBtnWrap.remove();
      const wrap = document.createElement('div');
      wrap.id = 'ag-settings-stats-wrap';
      wrap.setAttribute('data-ag-i18n-ignore', '1');
      wrap.className = navWrapCls;
      wrap.innerHTML = `<button type="button" id="ag-settings-stats-toggle" data-testid="settings-nav-item-Stats" class="${escapeHtml(navBtnCls)} ag-settings-stats-toggle" aria-expanded="${
        settingsStatsOpen ? 'true' : 'false'
      }"><span class="transition-colors select-none truncate flex-1 ag-settings-stats-lbl">${L('统计', 'Stats')}</span><span class="ag-settings-stats-chev" aria-hidden="true">${SVG_SETTINGS_CHEVRON}</span></button>`;
      wrap.querySelector('#ag-settings-stats-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        settingsStatsOpen = !settingsStatsOpen;
        syncSettingsStatsGroup(sidebar);
      });
      firstAnchor.insertAdjacentElement('beforebegin', wrap);
      settingsStatsBtnWrap = wrap;
    }

    const claudePaneOpen = sidebar.hasAttribute('data-ag-claude-nav-open');
    const projHasActive = !claudePaneOpen && Boolean(projList && projList.querySelector('.bg-sidebar-secondary'));
    const unlinkedHasActive = !claudePaneOpen && Boolean(unlinkedList && unlinkedList.querySelector('.bg-sidebar-secondary'));

    const statsToggle = settingsStatsBtnWrap.querySelector('#ag-settings-stats-toggle');
    if (statsToggle) {
      statsToggle.setAttribute('aria-expanded', settingsStatsOpen ? 'true' : 'false');
      statsToggle.setAttribute('data-open', settingsStatsOpen ? 'true' : 'false');
      statsToggle.classList.toggle('bg-sidebar-secondary', !settingsStatsOpen && (projHasActive || unlinkedHasActive));
      const lbl = statsToggle.querySelector('.ag-settings-stats-lbl');
      if (lbl) setLeafText(lbl, L('统计', 'Stats'));
    }

    const bindSubHdr = (hdrEl, isOpen, hasActiveChild, onToggle) => {
      if (!hdrEl) return;
      hdrEl.setAttribute('data-ag-stats-subhdr', '1');
      hdrEl.setAttribute('data-ag-stats-open', isOpen ? 'true' : 'false');
      hdrEl.setAttribute('data-ag-stats-active', !isOpen && hasActiveChild ? 'true' : 'false');
      hdrEl.setAttribute('role', 'button');
      hdrEl.setAttribute('tabindex', '0');
      hdrEl.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (!hdrEl.querySelector('.ag-settings-subhdr-chev')) {
        const chev = document.createElement('span');
        chev.className = 'ag-settings-subhdr-chev';
        chev.setAttribute('data-ag-i18n-ignore', '1');
        chev.setAttribute('aria-hidden', 'true');
        chev.innerHTML = SVG_SETTINGS_CHEVRON;
        hdrEl.appendChild(chev);
      }
      if (settingsStatsOpen) hdrEl.removeAttribute('data-ag-stats-hidden');
      else hdrEl.setAttribute('data-ag-stats-hidden', '1');
      if (!hdrEl.__agStatsBound) {
        hdrEl.__agStatsBound = true;
        const onClick = (e) => {
          if (e.target && e.target !== hdrEl && e.target.closest && e.target.closest('button, a, input, select')) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        };
        const onKeyDown = (e) => {
          if (e.target && e.target !== hdrEl && e.target.closest && e.target.closest('button, a, input, select')) {
            return;
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onToggle();
          }
        };
        hdrEl.__agStatsHandlers = { onClick, onKeyDown };
        hdrEl.addEventListener('click', onClick);
        hdrEl.addEventListener('keydown', onKeyDown);
      }
    };

    bindSubHdr(projHdr, settingsStatsProjOpen, projHasActive, () => {
      settingsStatsProjOpen = !settingsStatsProjOpen;
      syncSettingsStatsGroup(sidebar);
    });
    if (projList) {
      projList.setAttribute('data-ag-stats-list', '1');
      if (settingsStatsOpen && settingsStatsProjOpen) projList.removeAttribute('data-ag-stats-hidden');
      else projList.setAttribute('data-ag-stats-hidden', '1');
    }

    bindSubHdr(unlinkedHdr, settingsStatsUnlinkedOpen, unlinkedHasActive, () => {
      settingsStatsUnlinkedOpen = !settingsStatsUnlinkedOpen;
      syncSettingsStatsGroup(sidebar);
    });
    if (unlinkedList) {
      unlinkedList.setAttribute('data-ag-stats-list', '1');
      if (settingsStatsOpen && settingsStatsUnlinkedOpen) unlinkedList.removeAttribute('data-ag-stats-hidden');
      else unlinkedList.setAttribute('data-ag-stats-hidden', '1');
    }
  }

  function closeClaudeUxSettingsPane() {
    if (settingsRightRef) settingsRightRef.removeAttribute('data-ag-claude-settings-open');
    if (settingsSidebarRef) settingsSidebarRef.removeAttribute('data-ag-claude-nav-open');
    if (settingsNavBtn) {
      settingsNavBtn.classList.remove('bg-sidebar-secondary');
      settingsNavBtn.removeAttribute('aria-current');
    }
    if (settingsPanelEl) settingsPanelEl.hidden = true;
  }

  function onNativeSettingsNavClick(e) {
    if (
      e.target &&
      e.target.closest &&
      !e.target.closest('#ag-claude-ux-settings-nav, #ag-settings-stats-wrap, [data-ag-stats-subhdr="1"]') &&
      e.target.closest('button')
    ) {
      closeClaudeUxSettingsPane();
      requestAnimationFrame(() => syncSettingsStatsGroup());
    }
  }

  function openClaudeUxSettingsPane() {
    if (!settingsSidebarRef || !settingsRightRef || !settingsNavBtn) return;
    settingsSidebarRef.setAttribute('data-ag-claude-nav-open', 'true');
    settingsRightRef.setAttribute('data-ag-claude-settings-open', 'true');
    settingsNavBtn.classList.add('bg-sidebar-secondary');
    settingsNavBtn.setAttribute('aria-current', 'page');
    syncSettingsStatsGroup(settingsSidebarRef);

    if (!settingsPanelEl || settingsPanelEl.parentElement !== settingsRightRef) {
      if (settingsPanelEl) settingsPanelEl.remove();
      const panel = document.createElement('div');
      panel.id = 'ag-claude-ux-settings-panel';
      panel.setAttribute('data-ag-i18n-ignore', '1');
      panel.setAttribute('role', 'region');
      settingsRightRef.appendChild(panel);
      settingsPanelEl = panel;
    }
    settingsPanelEl.setAttribute('aria-label', L('界面增强设置', 'UI Enhancements Settings'));
    settingsPanelEl.hidden = false;
    settingsRightRef.scrollTop = 0;
    rt.scheduleSync(['settings'], true);
  }

  function updateSettingsNavLabel() {
    if (settingsNavBtn) {
      const span = settingsNavBtn.querySelector('span');
      if (span) setLeafText(span, L('界面增强', 'UI Enhancements'));
      else settingsNavBtn.innerHTML = `<span class="truncate">${L('界面增强', 'UI Enhancements')}</span>`;
    }
    if (settingsPanelEl) {
      settingsPanelEl.setAttribute('aria-label', L('界面增强设置', 'UI Enhancements Settings'));
    }
  }

  function detachSettingsPanel() {
    closeClaudeUxSettingsPane();
    cleanupSettingsStatsGroup(settingsSidebarRef || document.querySelector('[data-testid="settings-sidebar"]'));
    if (settingsSidebarRef) {
      settingsSidebarRef.removeEventListener('click', onNativeSettingsNavClick, true);
    }
    if (settingsNavWrap && settingsNavWrap.parentNode) settingsNavWrap.remove();
    if (settingsPanelEl && settingsPanelEl.parentNode) settingsPanelEl.remove();
    settingsSidebarRef = null;
    settingsRightRef = null;
    settingsNavWrap = null;
    settingsNavBtn = null;
    settingsPanelEl = null;
    syncSettingsDomFlags(document.querySelector('[data-testid="settings-sidebar"]'));
  }

  function reconcileSettingsPanel() {
    if (rtState.disposed) return;
    const sb = document.querySelector('[data-testid="settings-sidebar"]');
    if (!sb) {
      if (settingsSidebarRef || settingsStatsBtnWrap) {
        settingsStatsOpen = false;
        settingsStatsProjOpen = false;
        settingsStatsUnlinkedOpen = false;
        detachSettingsPanel();
      } else {
        syncSettingsDomFlags(null);
      }
      return;
    }
    syncSettingsDomFlags(sb);
    if (settingsNavWrap && settingsNavWrap.isConnected && settingsSidebarRef === sb) {
      if (!settingsRightRef || !settingsRightRef.isConnected) {
        const splitRootLive =
          sb.closest('[data-split-root="true"], [data-split-root]') ||
          (sb.parentElement && sb.parentElement.parentElement && sb.parentElement.parentElement.parentElement);
        const rightOuterLive =
          splitRootLive && splitRootLive.children && splitRootLive.children.length >= 2
            ? splitRootLive.children[splitRootLive.children.length - 1]
            : null;
        const rightContentLive = (rightOuterLive && rightOuterLive.firstElementChild) || rightOuterLive;
        if (rightContentLive) settingsRightRef = rightContentLive;
      }
      syncSettingsStatsGroup(sb);
      return;
    }
    if (settingsSidebarRef && settingsSidebarRef !== sb) {
      detachSettingsPanel();
    }

    const anchorBtn =
      sb.querySelector('button[data-testid="settings-nav-item-Appearance"]') ||
      sb.querySelector('button[data-testid="settings-nav-item-General"]') ||
      sb.querySelector('button[data-testid^="settings-nav-item-"]:not([data-testid="settings-nav-item-Stats"])');
    const splitRoot =
      sb.closest('[data-split-root="true"], [data-split-root]') ||
      (sb.parentElement && sb.parentElement.parentElement && sb.parentElement.parentElement.parentElement);
    const rightOuter = splitRoot && splitRoot.children && splitRoot.children.length >= 2 ? splitRoot.children[splitRoot.children.length - 1] : null;
    const rightContent = (rightOuter && rightOuter.firstElementChild) || rightOuter;
    if (!anchorBtn || !anchorBtn.parentElement || !anchorBtn.parentElement.parentElement || !rightContent) {
      syncSettingsStatsGroup(sb);
      return;
    }

    settingsSidebarRef = sb;
    settingsRightRef = rightContent;
    const navWrap = document.createElement('div');
    navWrap.id = 'ag-claude-ux-settings-nav';
    navWrap.setAttribute('data-ag-i18n-ignore', '1');
    navWrap.className = anchorBtn.parentElement.className || 'relative group/nav-item mx-2';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-testid', 'settings-nav-item-ClaudeUX');
    btn.className = (anchorBtn.className || '').replace(/\bbg-sidebar-secondary\b/g, 'hover:bg-sidebar-muted');
    btn.innerHTML = `<span class="truncate">${L('界面增强', 'UI Enhancements')}</span>`;
    btn.addEventListener('click', () => openClaudeUxSettingsPane());
    navWrap.appendChild(btn);

    anchorBtn.parentElement.insertAdjacentElement('afterend', navWrap);
    sb.addEventListener('click', onNativeSettingsNavClick, true);
    settingsNavWrap = navWrap;
    settingsNavBtn = btn;
    syncSettingsStatsGroup(sb);
  }

  return {
    getSidebarRef: () => settingsSidebarRef,
    reconcileSettingsPanel,
    detachSettingsPanel,
    syncSettingsStatsGroup,
    updateSettingsNavLabel,
  };
}
