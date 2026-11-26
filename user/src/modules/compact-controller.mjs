/**
 * Conversation /compact state detection, visual sync, draft-safe submission & poll lifecycle.
 * Extracted from metrics-quota.mjs to keep user/src modules well under the 2,000-line invariant.
 */
export function createCompactController(rt, deps = {}) {
  const { FEAT, state: rtState, hooks } = rt;
  const composerHasExistingDraft = (...args) => hooks.composerHasExistingDraft?.(...args) ?? false;
  const setComposerText = (...args) => hooks.setComposerText?.(...args);
  const renderOverviewPanel = (...args) => hooks.renderOverviewPanel?.(...args);
  const fmtCompactTokens = deps.fmtCompactTokens || ((n) => String(n || ''));
  const onRingVisuals = deps.onRingVisuals || (() => {});
  const onPopoverBody = deps.onPopoverBody || (() => {});

  let compactedStaleSigByCid = new Map();
  let compactedMetaByCid = new Map();
  let lastObservedCompactKey = '';
  let compactPollTimerId = null;

  function getActiveCascadeId() {
    const m = (window.location.pathname || '').match(/\/c\/([0-9a-f-]+)/i);
    if (m) return m[1];
    if (window.__ag_watched_cascade_id) return String(window.__ag_watched_cascade_id);
    const sel = document.querySelector('[data-testid="conversation-row-sidebar"][data-selected="true"]');
    return (sel && sel.getAttribute('data-cascade-id')) || '';
  }

  function getActiveInputBox(anchorEl) {
    if (anchorEl && anchorEl.closest) {
      const own = anchorEl.closest('[id="antigravity.agentSidePanelInputBox"]');
      if (own) return own;
      const view = anchorEl.closest('[data-testid="conversation-view"]');
      if (view) {
        const inView = view.querySelector('[id="antigravity.agentSidePanelInputBox"]');
        if (inView) return inView;
      }
    }
    const boxes = document.querySelectorAll('[id="antigravity.agentSidePanelInputBox"]');
    if (boxes.length <= 1) return boxes[0] || null;
    const ae = document.activeElement;
    if (ae && ae.closest) {
      const aeView = ae.closest('[data-testid="conversation-view"]');
      if (aeView) {
        const aeBox = aeView.querySelector('[id="antigravity.agentSidePanelInputBox"]');
        if (aeBox) return aeBox;
      }
    }
    const cid = getActiveCascadeId();
    if (cid) {
      for (const b of boxes) {
        const v = b.closest && b.closest('[data-testid="conversation-view"]');
        if (v && v.getAttribute('data-cascade-id') === cid) return b;
      }
    }
    return boxes[0] || null;
  }

  function discoverAgentInputProps(anchorEl) {
    const inputBox = getActiveInputBox(anchorEl);
    if (!inputBox) return null;
    const fk = Object.keys(inputBox).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? inputBox[fk] : null;
    for (let i = 0; i < 45 && f; i++, f = f.return) {
      const pr = f.memoizedProps;
      if (pr && typeof pr.handleSubmit === 'function') return pr;
    }
    return null;
  }

  function discoverComposerContextFromInputBox(anchorEl) {
    const inputBox = getActiveInputBox(anchorEl);
    if (!inputBox) return null;
    const fk = Object.keys(inputBox).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? inputBox[fk] : null;
    for (let i = 0; i < 45 && f; i++, f = f.return) {
      const pr = f.memoizedProps;
      if (pr && pr.value && pr.value.inputBoxRef) return pr.value;
      let dep = f.dependencies ? f.dependencies.firstContext : null;
      while (dep) {
        const v = dep.memoizedValue;
        if (v && typeof v === 'object' && v.inputBoxRef) return v;
        dep = dep.next;
      }
    }
    return null;
  }

  function isPaneCurrentlyRunning(agentPropsArg) {
    const pr = agentPropsArg !== undefined ? agentPropsArg : discoverAgentInputProps();
    if (pr && typeof pr.isRunning === 'boolean') return pr.isRunning;
    return Boolean(document.querySelector('button[data-testid="input-cancel-button"]'));
  }

  function isCompactUserStepObj(s) {
    if (!s || (s.type !== 14 && (!s.step || s.step.case !== 'userInput'))) return false;
    const val = s.step && s.step.value;
    if (!val) return false;
    if (/^\s*\/compact\b/i.test(String(val.userResponse || ''))) return true;
    if (Array.isArray(val.items)) {
      return val.items.some(
        (it) =>
          it &&
          it.chunk &&
          it.chunk.case === 'item' &&
          it.chunk.value &&
          it.chunk.value.scopeItem &&
          it.chunk.value.scopeItem.case === 'slashCommand' &&
          it.chunk.value.scopeItem.value &&
          it.chunk.value.scopeItem.value.info &&
          it.chunk.value.scopeItem.value.info.name === 'compact'
      );
    }
    return false;
  }

  function isDomCompactUserStep(stepEl) {
    if (!stepEl) return false;
    if (stepEl.querySelector('[data-uri="slashCommand:compact"]')) return true;
    const contentEl = stepEl.querySelector('[data-testid="user-message-content"]');
    const raw = ((contentEl || stepEl).textContent || '').trim();
    return /^\/?compact$/i.test(raw);
  }

  function domTurnHasAssistantContent(turnEl) {
    if (!turnEl) return false;
    return Boolean(
      turnEl.querySelector(
        'button[data-testid="worked-for-collapsible"], [data-testid="thinking-collapsible-trigger"], button[data-testid="tool-group-collapsible"], [data-testid="ephemeral-tool-status"], .prose, p, pre, ul, ol'
      )
    );
  }

  function currentCtxStaleSig() {
    if (!rtState.latestCtxState.hasData) return '';
    return `${rtState.latestCtxState.ratioText}|${rtState.latestCtxState.outText}|${rtState.latestCtxState.pct}`;
  }

  function parseTokenLabelToCount(label) {
    const m = String(label || '').trim().match(/^([\d.]+)\s*([kKmM])?$/);
    if (!m) return 0;
    const num = Number(m[1]);
    if (!Number.isFinite(num) || num <= 0) return 0;
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'm') return Math.round(num * 1000000);
    if (unit === 'k') return Math.round(num * 1000);
    return Math.round(num);
  }

  function extractCheckpointUsage(stepObj) {
    const meta = stepObj && stepObj.metadata;
    const usage =
      (meta && meta.modelUsage) ||
      (meta && Array.isArray(meta.retryInfos) && meta.retryInfos[0] && meta.retryInfos[0].usage) ||
      null;
    if (!usage) return { preTokens: 0, summaryTokens: 0 };
    const toTok = (v) => {
      const n = typeof v === 'bigint' ? Number(v) : Number(v || 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const preTokens = toTok(usage.inputTokens) + toTok(usage.cacheReadTokens);
    const respTok = toTok(usage.responseOutputTokens);
    const outTok = toTok(usage.outputTokens);
    return {
      preTokens,
      summaryTokens: respTok > 0 ? respTok : outTok
    };
  }

  /* Real-time /compact detector:
   * `daemon.mjs` reads `gen_metadata` (whose last row right after `/compact` is the summarization call itself, e.g. 483k/94%),
   * and `CHECKPOINT` (`step_type = 23`) writes no post-compact `gen_metadata` row until the user sends a new message.
   * Inspecting live `trajectorySlice` (with DOM fallback) lets the ring, popover & tooltip reflect `compacting` / `compacted` immediately. */
  function detectCompactStatus(curCidArg) {
    const curCid = curCidArg !== undefined ? curCidArg : getActiveCascadeId();
    const agentProps = discoverAgentInputProps();
    const running = isPaneCurrentlyRunning(agentProps);
    const cidKey = curCid || '__active__';
    const curSig = currentCtxStaleSig();

    const viewports = document.querySelectorAll('[data-testid="autoscroll-viewport"], .overflow-y-auto');
    for (const vp of viewports) {
      const fk = Object.keys(vp).find((k) => k.startsWith('__reactFiber$'));
      let f = fk ? vp[fk] : null;
      for (let i = 0; i < 35 && f; i++, f = f.return) {
        const p = f.memoizedProps;
        const slice = p && p.trajectorySlice;
        if (!slice || !Array.isArray(slice.stepsInSlice)) continue;
        if (curCid && slice.conversationId && slice.conversationId !== curCid) break;

        const arr = slice.stepsInSlice;
        let lastCompactUserIdx = -1;
        let lastCheckpointIdx = -1;
        let lastCheckpointStep = null;
        let lastRegularUserIdx = -1;
        let lastPlannerIdx = -1;

        for (let idx = 0; idx < arr.length; idx++) {
          const s = arr[idx];
          if (!s) continue;
          const sc = (s.step && s.step.case) || '';
          if (sc === 'checkpoint' || s.type === 23) {
            lastCheckpointIdx = idx;
            lastCheckpointStep = s;
          } else if (sc === 'userInput' || s.type === 14) {
            if (isCompactUserStepObj(s)) lastCompactUserIdx = idx;
            else lastRegularUserIdx = idx;
          } else if (sc === 'plannerResponse' || s.type === 15) {
            lastPlannerIdx = idx;
          }
        }

        const anchorIdx = Math.max(lastCompactUserIdx, lastCheckpointIdx);
        if (anchorIdx >= 0 && lastRegularUserIdx < anchorIdx && lastPlannerIdx < anchorIdx) {
          rtState.manualCompactPending = { cascadeId: '', startedAt: 0 };
          const cpStatus = lastCheckpointStep ? lastCheckpointStep.status : undefined;
          const cpFailed = Boolean(
            (lastCheckpointStep && lastCheckpointStep.step && lastCheckpointStep.step.value && lastCheckpointStep.step.value.modelSummarizationFailed) ||
              (typeof cpStatus === 'number' && cpStatus > 3)
          );
          if (cpFailed) {
            compactedStaleSigByCid.delete(cidKey);
            compactedMetaByCid.delete(cidKey);
            return 'idle';
          }
          if (running || (typeof cpStatus === 'number' && cpStatus > 0 && cpStatus < 3)) {
            if (lastCheckpointStep) {
              const cpUsage = extractCheckpointUsage(lastCheckpointStep);
              if (cpUsage.preTokens > 0 || cpUsage.summaryTokens > 0) {
                compactedMetaByCid.set(cidKey, cpUsage);
              }
            }
            return 'compacting';
          }
          if (curSig) compactedStaleSigByCid.set(cidKey, curSig);
          compactedMetaByCid.set(cidKey, extractCheckpointUsage(lastCheckpointStep));
          return 'compacted';
        }

        if (anchorIdx >= 0 && lastRegularUserIdx > anchorIdx) {
          const staleSig = compactedStaleSigByCid.get(cidKey);
          if (staleSig && curSig && staleSig === curSig && running) {
            return 'compacted';
          }
          if (staleSig && curSig && staleSig !== curSig) {
            compactedStaleSigByCid.delete(cidKey);
          }
          compactedMetaByCid.delete(cidKey);
        }

        if (
          rtState.manualCompactPending.cascadeId === cidKey &&
          Date.now() - rtState.manualCompactPending.startedAt < 15000
        ) {
          return 'compacting';
        }
        return 'idle';
      }
    }

    /* DOM fallback (covers jsdom unit tests & early mounts before trajectorySlice attaches) */
    const flowNodes = Array.from(
      document.querySelectorAll('[data-testid="user-input-step"], [data-testid="agent-response"]')
    );
    let lastUserFlowIdx = -1;
    for (let i = flowNodes.length - 1; i >= 0; i--) {
      if (flowNodes[i].getAttribute('data-testid') === 'user-input-step') {
        lastUserFlowIdx = i;
        break;
      }
    }
    if (lastUserFlowIdx >= 0 && isDomCompactUserStep(flowNodes[lastUserFlowIdx])) {
      const hasReplyAfter = flowNodes
        .slice(lastUserFlowIdx + 1)
        .some((el) => el.getAttribute('data-testid') === 'agent-response' && domTurnHasAssistantContent(el));
      if (!hasReplyAfter) {
        rtState.manualCompactPending = { cascadeId: '', startedAt: 0 };
        if (running) return 'compacting';
        if (curSig) compactedStaleSigByCid.set(cidKey, curSig);
        return 'compacted';
      }
    }

    const staleSig = compactedStaleSigByCid.get(cidKey);
    if (staleSig && curSig) {
      if (staleSig === curSig && running) return 'compacted';
      if (staleSig !== curSig) {
        compactedStaleSigByCid.delete(cidKey);
        compactedMetaByCid.delete(cidKey);
      }
    }

    if (
      rtState.manualCompactPending.cascadeId === cidKey &&
      Date.now() - rtState.manualCompactPending.startedAt < 15000
    ) {
      return 'compacting';
    }
    return 'idle';
  }

  function extractCompactLabels(ctxState, curCidArg) {
    const curCid = curCidArg !== undefined ? curCidArg : getActiveCascadeId();
    const cidKey = curCid || '__active__';
    const rawRatio = String((ctxState && ctxState.ratioText) || '');
    const parts = rawRatio.split('/');
    const preUsedFromRatio = (parts[0] || '').trim();
    const limitLabel = (parts[1] || '').trim();
    const limitTokens = parseTokenLabelToCount(limitLabel);
    const cpMeta = compactedMetaByCid.get(cidKey) || null;
    const preUsed =
      (cpMeta && cpMeta.preTokens > 0 ? fmtCompactTokens(cpMeta.preTokens) : '') || preUsedFromRatio;
    const summaryLabel =
      cpMeta && cpMeta.summaryTokens > 0 ? fmtCompactTokens(cpMeta.summaryTokens) : '';
    const summaryPct =
      cpMeta && cpMeta.summaryTokens > 0 && limitTokens > 0
        ? Math.max(1, Math.min(100, Math.round((cpMeta.summaryTokens / limitTokens) * 100)))
        : 0;
    return { preUsed, limitLabel, summaryLabel, summaryPct };
  }

  function ensureCompactPollTimer() {
    if (compactPollTimerId || rtState.disposed) return;
    compactPollTimerId = setInterval(() => {
      if (rtState.disposed) {
        clearInterval(compactPollTimerId);
        compactPollTimerId = null;
        return;
      }
      const st = detectCompactStatus();
      syncCompactVisualState(false);
      if (st !== 'compacting' && !rtState.quotaPopoverOpen) {
        clearInterval(compactPollTimerId);
        compactPollTimerId = null;
      }
    }, 500);
    if (compactPollTimerId && typeof compactPollTimerId.unref === 'function') {
      compactPollTimerId.unref();
    }
  }

  function syncCompactVisualState(forceRender) {
    if (rtState.disposed || (!FEAT.contextRing && !FEAT.overviewPanel)) return;
    const curCid = getActiveCascadeId();
    const st = detectCompactStatus(curCid);
    const running = isPaneCurrentlyRunning();
    const { summaryLabel } = extractCompactLabels(rtState.latestCtxState, curCid);
    const key = `${curCid}|${st}|${running ? '1' : '0'}|${summaryLabel}`;
    if (!forceRender && key === lastObservedCompactKey) return;
    lastObservedCompactKey = key;

    if (st === 'compacting') ensureCompactPollTimer();

    if (window.__ag_last_metrics && typeof window.__ag_render_metrics === 'function') {
      try {
        window.__ag_render_metrics(window.__ag_last_metrics);
        return;
      } catch {}
    }
    if (FEAT.contextRing) {
      onRingVisuals();
      if (rtState.quotaPopoverOpen) onPopoverBody();
    }
    if (FEAT.overviewPanel) renderOverviewPanel(false);
  }

  function hasLiveComposerDraft(boxArg) {
    const compCtx = discoverComposerContextFromInputBox(boxArg);
    if (compCtx && composerHasExistingDraft(compCtx)) return true;
    const box = boxArg || getActiveInputBox();
    const ed = box && box.querySelector('[data-lexical-editor="true"]');
    if (ed) {
      const txt = (ed.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      if (txt.length > 0) return true;
    }
    return false;
  }

  async function triggerConversationCompact(opts = {}) {
    if (rtState.disposed) return false;
    const expectedCid = opts && typeof opts.expectedCid === 'string' ? opts.expectedCid.trim() : '';
    const requireEmptyDraft = Boolean(opts && opts.requireEmptyDraft);
    const curCid = getActiveCascadeId();
    if (expectedCid && curCid !== expectedCid) return false;

    const cidKey = curCid || '__active__';
    const curStatus = detectCompactStatus(curCid);
    if (curStatus === 'compacting' || curStatus === 'compacted') return false;

    const box = getActiveInputBox();
    const agentProps = discoverAgentInputProps(box);
    if (expectedCid && agentProps && agentProps.cascadeId && agentProps.cascadeId !== expectedCid) {
      return false;
    }
    if (isPaneCurrentlyRunning(agentProps)) return false;
    if (requireEmptyDraft && hasLiveComposerDraft(box)) return false;

    try {
      if (agentProps && typeof agentProps.handleSubmit === 'function') {
        const hasSlashList = Array.isArray(agentProps.slashCommandItems);
        const slashItems = hasSlashList ? agentProps.slashCommandItems : [];
        const compactDef = slashItems.find(
          (x) => x && (x.title === 'compact' || (x.info && x.info.name === 'compact'))
        );
        if (!compactDef || !compactDef.info) {
          /* Never fabricate a hard-coded SlashCommandInfo proto if official /compact definition is absent */
          return false;
        }
        /* Synchronous final guard right before handleSubmit so a draft typed concurrently is never wiped */
        if (expectedCid && getActiveCascadeId() !== expectedCid) return false;
        if (isPaneCurrentlyRunning(agentProps)) return false;
        if (requireEmptyDraft && hasLiveComposerDraft(box)) return false;

        rtState.manualCompactPending = { cascadeId: cidKey, startedAt: Date.now() };
        syncCompactVisualState(true);
        ensureCompactPollTimer();

        const slashInfo = compactDef.info;
        const submitItems = [
          {
            $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
            chunk: {
              case: 'item',
              value: {
                $typeName: 'exa.codeium_common_pb.ContextScopeItem',
                scopeItem: {
                  case: 'slashCommand',
                  value: {
                    $typeName: 'exa.codeium_common_pb.SlashCommandScopeItem',
                    argumentValues: {},
                    info: slashInfo
                  }
                }
              }
            }
          },
          {
            $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
            chunk: {
              case: 'text',
              value: ' '
            }
          }
        ];
        await agentProps.handleSubmit(submitItems, [], () => {});
        syncCompactVisualState(true);
        return true;
      }

      const compCtx = discoverComposerContextFromInputBox(box);
      const ref = compCtx && compCtx.inputBoxRef && compCtx.inputBoxRef.current;
      if (compCtx && ref && typeof ref.submit === 'function' && !hasLiveComposerDraft(box)) {
        if (expectedCid && getActiveCascadeId() !== expectedCid) return false;
        rtState.manualCompactPending = { cascadeId: cidKey, startedAt: Date.now() };
        syncCompactVisualState(true);
        ensureCompactPollTimer();
        setComposerText(compCtx, '/compact ');
        ref.submit();
        syncCompactVisualState(true);
        return true;
      }
    } catch {}

    rtState.manualCompactPending = { cascadeId: '', startedAt: 0 };
    syncCompactVisualState(true);
    return false;
  }

  function dispose() {
    if (compactPollTimerId) {
      clearInterval(compactPollTimerId);
      compactPollTimerId = null;
    }
    compactedMetaByCid.clear();
    compactedStaleSigByCid.clear();
  }

  return {
    getActiveCascadeId,
    getActiveInputBox,
    discoverAgentInputProps,
    isPaneCurrentlyRunning,
    detectCompactStatus,
    extractCompactLabels,
    syncCompactVisualState,
    triggerConversationCompact,
    dispose,
  };
}
