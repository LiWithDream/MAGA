/**
 * Per-frame read-only DOM/state snapshot captured once during MagaKernel Phase 1 (Read).
 */
import { getActiveRouteCid, hasValidMetricsForCurrentChat, isComposerRunning, isZhUi } from './env.mjs';

export function captureFrameSnapshot(topics = new Set(['all'])) {
  const now = Date.now();
  const hasDoc = typeof document !== 'undefined';
  const hidden = hasDoc ? Boolean(document.hidden) : false;
  const pathname = typeof location !== 'undefined' ? String(location.pathname || '') : '';
  const search = typeof location !== 'undefined' ? String(location.search || '') : '';
  const cid = getActiveRouteCid();
  const isZh = isZhUi();
  const langTag = isZh ? 'zh' : 'en';

  const mainBox = hasDoc
    ? document.getElementById('antigravity.agentSidePanelInputBox') ||
      document.querySelector('[data-testid="conversation-view"] [data-testid="agent-input-box"]') ||
      null
    : null;

  const excludedFooter = '[data-testid="side-question-tab-content"], [data-testid="voice-dock-composer"]';
  const footers = hasDoc
    ? Array.from(document.querySelectorAll('.agy-composer-footer') || []).filter((f) => !f.closest?.(excludedFooter))
    : [];

  const isRunning = isComposerRunning();
  const ovPanel = hasDoc ? document.querySelector('[data-testid="overview-panel"]') : null;
  const overviewOpen = Boolean(ovPanel && !ovPanel.hidden && ovPanel.getAttribute?.('aria-hidden') !== 'true');
  const auxSplit = hasDoc ? document.querySelector('[data-testid="aux-pane-split"]') : null;
  const splitAnimating = Boolean(auxSplit && auxSplit.hasAttribute?.('data-split-transition'));
  const settingsSidebar = hasDoc ? document.querySelector('[data-testid="settings-sidebar"]') : null;
  const metrics = typeof window !== 'undefined' ? window.__ag_last_metrics || null : null;
  const validMetrics = hasValidMetricsForCurrentChat(cid);

  return {
    now,
    hidden,
    pathname,
    search,
    cid,
    isZh,
    langTag,
    mainBox,
    footers,
    isRunning,
    ovPanel,
    overviewOpen,
    auxSplit,
    splitAnimating,
    settingsSidebar,
    metrics,
    validMetrics,
    topics,
  };
}
