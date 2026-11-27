/**
 * Centralized O(1) DOM state attribute marker (eliminates global CSS `:has()` selectors).
 * Runs inside MagaKernel Read -> Write phases so Blink style invalidation remains O(1) per node.
 */
import { setAttr } from './dom.mjs';

const MANAGED_MAGA_ATTRS = [
  'data-maga-footer-shell',
  'data-maga-editor-wrap',
  'data-maga-has-tools',
  'data-maga-q-icon',
  'data-maga-native-elapsed',
  'data-maga-has-browser-hole',
  'data-maga-sub-sidebar-wrap',
  'data-maga-sub-conv-wrap',
  'data-maga-sub-conv-outer',
  'data-maga-settings-host',
  'data-maga-settings-wrap',
  'data-maga-card-split',
  'data-maga-pin-glyph',
];

function syncAttrSet(attr, desiredSet) {
  if (typeof document === 'undefined' || !desiredSet) return;
  const existing = document.querySelectorAll?.(`[${attr}]`) || [];
  for (let i = 0; i < existing.length; i += 1) {
    const el = existing[i];
    if (!desiredSet.has(el)) el.removeAttribute?.(attr);
  }
  for (const el of desiredSet) {
    if (el) setAttr(el, attr, '1');
  }
}

function safeQsa(root, selector) {
  try {
    return root && typeof root.querySelectorAll === 'function' ? root.querySelectorAll(selector) : [];
  } catch {
    return [];
  }
}

export function createDomFlagsFeature() {
  let disposed = false;

  function readComposerAndMetrics(snapshot) {
    const footerShells = new Set();
    const footers = snapshot?.footers || Array.from(safeQsa(document, '.agy-composer-footer'));
    for (let i = 0; i < footers.length; i += 1) {
      const f = footers[i];
      if (!f || f.closest?.('[data-testid="voice-dock-composer"], [data-testid="side-question-tab-content"]')) continue;
      if (f.closest?.('[data-testid="agent-input-box"]') && f.parentElement?.tagName === 'DIV') {
        footerShells.add(f.parentElement);
      }
    }

    const editorWraps = new Set();
    const eds = safeQsa(document, '#antigravity\\.agentSidePanelInputBox [data-lexical-editor="true"]');
    for (let i = 0; i < eds.length; i += 1) {
      const p = eds[i]?.parentElement;
      if (p && p.tagName === 'DIV') editorWraps.add(p);
    }

    const ttEl = typeof document !== 'undefined' ? document.getElementById('ag-live-metrics-tooltip') : null;
    const hasUxTt = Boolean(
      ttEl && Array.from(ttEl.children || []).some((ch) => ch.classList?.contains?.('ag-ux-tt'))
    );

    return { footerShells, editorWraps, ttEl, hasUxTt };
  }

  function readStreamFlags() {
    const hasToolsRows = new Set();
    const stepRows = safeQsa(document, '[data-step-rows="true"]');
    for (let i = 0; i < stepRows.length; i += 1) {
      const row = stepRows[i];
      if (row?.querySelector?.('[data-testid="tool-group-collapsible"]')) {
        hasToolsRows.add(row);
      }
    }

    const qIcons = new Set();
    const qPaths = safeQsa(document, '.rounded-xl.border > div.border-b > svg > path[d^="M477.92-295.77"]');
    for (let i = 0; i < qPaths.length; i += 1) {
      const svg = qPaths[i]?.parentElement;
      if (svg) qIcons.add(svg);
    }

    const nativeElapsed = new Set();
    const toolRows = safeQsa(document, '[data-testid="tool-group-collapsible"]');
    for (let i = 0; i < toolRows.length; i += 1) {
      const row = toolRows[i];
      if (row?.querySelector?.('[data-testid="tool-group-elapsed"]')) {
        nativeElapsed.add(row);
      }
    }

    const browserHoles = new Set();
    const holeEls = safeQsa(document, '[data-browser-hole="true"]');
    for (let i = 0; i < holeEls.length; i += 1) {
      const container = holeEls[i]?.closest?.('[data-main-content-body], [data-side-panel-body]');
      if (container) browserHoles.add(container);
    }

    return { hasToolsRows, qIcons, nativeElapsed, browserHoles };
  }

  function readSubagentFlags(snapshot) {
    const subSidebarWraps = new Set();
    const subConvWraps = new Set();
    const subConvOuters = new Set();

    const split = snapshot?.auxSplit || document.querySelector?.('[data-testid="aux-pane-split"]');
    const splitChildren = split?.children ? Array.from(split.children) : [];
    const pane = splitChildren.length > 0 ? splitChildren[splitChildren.length - 1] : null;
    if (pane) {
      const sidebars = safeQsa(pane, '[data-testid="subagent-tab-sidebar"]');
      for (let i = 0; i < sidebars.length; i += 1) {
        let el = sidebars[i]?.parentElement;
        while (el && el !== pane) {
          if (el.tagName === 'DIV' && !el.querySelector?.('[data-testid="subagent-tab-conversation"]')) {
            subSidebarWraps.add(el);
          }
          el = el.parentElement;
        }
      }
      const convs = safeQsa(pane, '[data-testid="subagent-tab-conversation"]');
      for (let i = 0; i < convs.length; i += 1) {
        const p1 = convs[i]?.parentElement;
        if (p1 && p1 !== pane && p1.tagName === 'DIV') {
          subConvWraps.add(p1);
          const p2 = p1.parentElement;
          if (p2 && p2 !== pane && p2.tagName === 'DIV') {
            subConvOuters.add(p2);
          }
        }
      }
    }

    return { subSidebarWraps, subConvWraps, subConvOuters };
  }

  function readSettingsFlags(snapshot) {
    const settingsHosts = new Set();
    const settingsWraps = new Set();
    const sb = snapshot?.settingsSidebar || document.querySelector?.('[data-testid="settings-sidebar"]');
    if (sb) {
      const dialog = sb.closest?.('[role="dialog"]');
      if (dialog) settingsHosts.add(dialog);
      const splitRoot = sb.closest?.('[data-split-root]');
      if (splitRoot) settingsHosts.add(splitRoot);
      const p1 = sb.parentElement;
      if (p1 && p1.tagName === 'DIV') {
        settingsWraps.add(p1);
        const p2 = p1.parentElement;
        if (p2 && p2.tagName === 'DIV') settingsWraps.add(p2);
      }
    }

    const cardSplits = new Set();
    const splitHeaders = safeQsa(document, '.agy-card > div > div.w-full.flex.justify-between');
    for (let i = 0; i < splitHeaders.length; i += 1) {
      const cardChild = splitHeaders[i]?.parentElement;
      if (cardChild) cardSplits.add(cardChild);
    }

    return { settingsHosts, settingsWraps, cardSplits };
  }

  function readSidebarFlags() {
    const pinGlyphs = new Set();
    const glyphs = safeQsa(document, '[data-testid="conversation-row-sidebar"][data-pinned="true"] span > svg[data-project-glyph]');
    for (let i = 0; i < glyphs.length; i += 1) {
      const span = glyphs[i]?.parentElement;
      if (span) pinGlyphs.add(span);
    }

    const recentSec = typeof document !== 'undefined' ? document.getElementById('ag-claude-recent-section') : null;
    const recentCollapsed = Boolean(
      recentSec &&
        Array.from(recentSec.children || []).some((ch) => {
          if (ch.classList?.contains?.('ag-recent-hdr') && ch.getAttribute?.('aria-expanded') === 'false') return true;
          if (ch.classList?.contains?.('ag-recent-hdr-bar')) {
            return Array.from(ch.children || []).some(
              (sub) => sub.classList?.contains?.('ag-recent-hdr') && sub.getAttribute?.('aria-expanded') === 'false'
            );
          }
          return false;
        })
    );

    return { pinGlyphs, recentSec, recentCollapsed };
  }

  function readOverviewFlags(snapshot) {
    const reviewDetailBtns = new Set();
    const ovPanel = snapshot?.ovPanel || document.querySelector?.('[data-testid="overview-panel"]');
    if (ovPanel) {
      const btns = safeQsa(ovPanel, 'button[data-testid="overview-panel-row-review"]');
      for (let i = 0; i < btns.length; i += 1) {
        const btn = btns[i];
        const children = Array.from(btn?.children || []);
        const detail = children.find((c) => c.getAttribute?.('data-testid') === 'overview-panel-row-review-detail');
        if (detail && String(detail.textContent || '').trim()) {
          reviewDetailBtns.add(btn);
        }
      }
    }

    return { reviewDetailBtns };
  }

  function read(snapshot = null) {
    if (disposed || typeof document === 'undefined') return null;
    const topics = snapshot?.topics;
    const runAll = !topics || topics.has('all') || topics.has('route');

    const plan = {};
    if (runAll || topics.has('composer') || topics.has('metrics')) {
      plan.composer = readComposerAndMetrics(snapshot);
    }
    if (runAll || topics.has('stream')) {
      plan.stream = readStreamFlags();
    }
    if (runAll || topics.has('subagent') || topics.has('composer')) {
      plan.subagent = readSubagentFlags(snapshot);
    }
    if (runAll || topics.has('settings') || topics.has('overview')) {
      plan.settings = readSettingsFlags(snapshot);
    }
    if (runAll || topics.has('sidebar')) {
      plan.sidebar = readSidebarFlags();
    }
    if (runAll || topics.has('overview')) {
      plan.overview = readOverviewFlags(snapshot);
    }
    return plan;
  }

  function write(snapshot = null, planArg = undefined) {
    if (disposed || typeof document === 'undefined') return;
    const plan = planArg !== undefined ? planArg : read(snapshot);
    if (!plan) return;

    if (plan.composer) {
      syncAttrSet('data-maga-footer-shell', plan.composer.footerShells);
      syncAttrSet('data-maga-editor-wrap', plan.composer.editorWraps);
      if (plan.composer.ttEl) {
        setAttr(plan.composer.ttEl, 'data-ag-ux-tt', plan.composer.hasUxTt ? '1' : null);
      }
    }
    if (plan.stream) {
      syncAttrSet('data-maga-has-tools', plan.stream.hasToolsRows);
      syncAttrSet('data-maga-q-icon', plan.stream.qIcons);
      syncAttrSet('data-maga-native-elapsed', plan.stream.nativeElapsed);
      syncAttrSet('data-maga-has-browser-hole', plan.stream.browserHoles);
    }
    if (plan.subagent) {
      syncAttrSet('data-maga-sub-sidebar-wrap', plan.subagent.subSidebarWraps);
      syncAttrSet('data-maga-sub-conv-wrap', plan.subagent.subConvWraps);
      syncAttrSet('data-maga-sub-conv-outer', plan.subagent.subConvOuters);
    }
    if (plan.settings) {
      syncAttrSet('data-maga-settings-host', plan.settings.settingsHosts);
      syncAttrSet('data-maga-settings-wrap', plan.settings.settingsWraps);
      syncAttrSet('data-maga-card-split', plan.settings.cardSplits);
    }
    if (plan.sidebar) {
      syncAttrSet('data-maga-pin-glyph', plan.sidebar.pinGlyphs);
      if (plan.sidebar.recentSec) {
        setAttr(plan.sidebar.recentSec, 'data-collapsed', plan.sidebar.recentCollapsed ? '1' : null);
      }
    }
    if (plan.overview) {
      syncAttrSet('data-ag-has-detail', plan.overview.reviewDetailBtns);
    }
  }

  function sync() {
    if (disposed) return;
    write(null, read(null));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (typeof document === 'undefined') return;
    for (let i = 0; i < MANAGED_MAGA_ATTRS.length; i += 1) {
      const attr = MANAGED_MAGA_ATTRS[i];
      const els = safeQsa(document, `[${attr}]`);
      for (let j = 0; j < els.length; j += 1) {
        els[j]?.removeAttribute?.(attr);
      }
    }
  }

  return {
    topics: ['composer', 'stream', 'sidebar', 'overview', 'subagent', 'settings', 'metrics', 'route', 'all'],
    read,
    write,
    sync,
    dispose,
  };
}
