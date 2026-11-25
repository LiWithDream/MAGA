/**
 * Composer Context Ring, Plan Usage Quota Popover & Metrics Pill wrapper.
 */
export function createMetricsQuotaModule(rt) {
  const { FEAT, L, state: rtState, frame, later, cancelLater, escapeHtml, hooks } = rt;
  const composerHasExistingDraft = (...args) => hooks.composerHasExistingDraft?.(...args) ?? false;
  const setComposerText = (...args) => hooks.setComposerText?.(...args);
  const renderOverviewPanel = (...args) => hooks.renderOverviewPanel?.(...args);

  /* ==========================================================================
   * 5. Claude-Style Composer Context Ring + Live Plan Quota Popover + Slim Pill
   *    - Strips `Ctx ...`, `Out ...` & `+N sub` from `#ag-live-metrics-pill` while keeping `tok/s · TTFT`
   *    - Transforms `#ag-live-metrics-tooltip` into a compact 272px two-section Claude popover (with TTFT)
   *    - Mounts radial context progress ring right beside the Model Selector
   *    - Clicking opens real-time Usage Popover (`retrieveUserQuotaSummary` 5h & weekly buckets)
   * ========================================================================== */
  const RING_CIRC = 2 * Math.PI * 7;
  const SVG_COMPACT_ICON =
    '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M4.5 2.75L8 6.25L11.5 2.75M4.5 13.25L8 9.75L11.5 13.25" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  const SVG_COMPACT_DONE =
    '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M3.5 8.3L6.6 11.4L12.6 4.8" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  const QUOTA_CACHE_STORAGE_KEY = 'ag_claude_ux_quota_cache_v1';
  function loadPersistedQuotaSnapshot() {
    try {
      const raw = typeof localStorage === 'object' && localStorage ? localStorage.getItem(QUOTA_CACHE_STORAGE_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.groups) || parsed.groups.length === 0) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  function serializeQuotaGroups(groups) {
    if (!Array.isArray(groups)) return [];
    return groups.map((g) => ({
      displayName: String(g.displayName || ''),
      buckets: Array.isArray(g.buckets)
        ? g.buckets.map((b) => ({
            displayName: b && b.displayName ? String(b.displayName) : '',
            window: b && b.window ? String(b.window) : '',
            description: b && b.description ? String(b.description) : '',
            remainingFraction:
              b && b.remaining && b.remaining.case === 'remainingFraction' && typeof b.remaining.value === 'number'
                ? b.remaining.value
                : b && typeof b.remainingFraction === 'number'
                  ? b.remainingFraction
                  : 1,
            resetTime:
              b && b.resetTime && b.resetTime.seconds !== undefined
                ? { seconds: String(b.resetTime.seconds) }
                : undefined
          }))
        : []
    }));
  }
  const initialQuotaSnap = loadPersistedQuotaSnapshot();
  let cachedQuotaSvc = null;
  rtState.cachedUserTierName = initialQuotaSnap ? String(initialQuotaSnap.tierName || '') : '';
  let cachedUserAccountKey = initialQuotaSnap ? String(initialQuotaSnap.accountKey || '') : '';
  rtState.cachedQuotaGroups = initialQuotaSnap ? initialQuotaSnap.groups : null;
  let lastQuotaFetchTs = 0;
  rtState.lastForceQuotaFetchTs = 0;
  let autoQuotaRefreshTimer = 0;
  let lastQuotaUsageSig = '';
  rtState.wasOvPaneGenerating = false;
  rtState.quotaFetchInFlight = null;
  let quotaHoldTimer = 0;
  let quotaWarmupDone = false;
  rtState.quotaPopoverOpen = false;
  let selectedQuotaGroupIdx = -1;
  function persistQuotaSnapshot() {
    if (!Array.isArray(rtState.cachedQuotaGroups) || rtState.cachedQuotaGroups.length === 0) return;
    try {
      if (typeof localStorage === 'object' && localStorage) {
        localStorage.setItem(
          QUOTA_CACHE_STORAGE_KEY,
          JSON.stringify({
            accountKey: cachedUserAccountKey || '',
            tierName: rtState.cachedUserTierName || '',
            ts: Date.now(),
            groups: serializeQuotaGroups(rtState.cachedQuotaGroups)
          })
        );
      }
    } catch {}
  }
  rtState.latestCtxState = { pct: 0, ratioText: '', outText: '', hasData: false, cascadeId: '' };
  rtState.manualCompactPending = { cascadeId: '', startedAt: 0 };
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
      updateComposerRingVisuals();
      if (rtState.quotaPopoverOpen) renderQuotaPopoverBody();
    }
    if (FEAT.overviewPanel) renderOverviewPanel(false);
  }

  async function triggerConversationCompact() {
    if (rtState.disposed) return false;
    const curCid = getActiveCascadeId();
    const cidKey = curCid || '__active__';
    const curStatus = detectCompactStatus(curCid);
    if (curStatus === 'compacting' || curStatus === 'compacted') return false;

    const agentProps = discoverAgentInputProps();
    if (isPaneCurrentlyRunning(agentProps)) return false;

    rtState.manualCompactPending = { cascadeId: cidKey, startedAt: Date.now() };
    syncCompactVisualState(true);
    ensureCompactPollTimer();

    try {
      if (agentProps && typeof agentProps.handleSubmit === 'function') {
        const hasSlashList = Array.isArray(agentProps.slashCommandItems);
        const slashItems = hasSlashList ? agentProps.slashCommandItems : [];
        const compactDef = slashItems.find(
          (x) => x && (x.title === 'compact' || (x.info && x.info.name === 'compact'))
        );
        if (!compactDef || !compactDef.info) {
          /* Never fabricate a hard-coded SlashCommandInfo proto if official /compact definition is absent */
          rtState.manualCompactPending = { cascadeId: '', startedAt: 0 };
          syncCompactVisualState(true);
          return false;
        }
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

      const compCtx = discoverComposerContextFromInputBox();
      if (compCtx && !composerHasExistingDraft(compCtx)) {
        setComposerText(compCtx, '/compact ');
        const ref = compCtx.inputBoxRef && compCtx.inputBoxRef.current;
        if (ref && typeof ref.submit === 'function') {
          ref.submit();
          syncCompactVisualState(true);
          return true;
        }
      }
    } catch {}

    rtState.manualCompactPending = { cascadeId: '', startedAt: 0 };
    syncCompactVisualState(true);
    return false;
  }

  function fmtCompactTokens(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1000) return String(Math.round(n));
    const k = n / 1000;
    return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '')) + 'k';
  }

  function fmtDurationSec(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '';
    if (sec >= 60) {
      const total = Math.round(sec);
      const mins = Math.floor(total / 60);
      const rem = total % 60;
      return `${mins}m ${rem}s`;
    }
    return `${sec.toFixed(1)}s`;
  }

  function cacheTierForRate(rate) {
    if (!Number.isFinite(rate)) return '';
    const pct = Math.round(rate);
    if (pct >= 90) return 'high';
    if (pct >= 85) return 'mid';
    return 'low';
  }

  function parseMetricsTooltipData(rawTooltip) {
    if (!rawTooltip || typeof rawTooltip !== 'string') return null;
    const tmp = document.createElement('div');
    tmp.innerHTML = rawTooltip;
    const data = {
      streamTps: NaN,
      isBuffered: false,
      ttftSec: NaN,
      isHold: false,
      stepDur: NaN,
      lastCacheRate: NaN,
      stepOut: NaN,
      turnSteps: 1,
      turnOut: NaN,
      turnDur: NaN,
      sessionTurns: 1,
      sessionCalls: 1,
      ctxRatio: '',
      ctxPct: '',
      sessionCacheRate: NaN,
      sessionTotalOut: '',
      subLabel: '',
      subSub: '',
      warnHtml: ''
    };

    const secHdr = tmp.querySelector('.ag-tt-hdr.ag-tt-sec');
    if (secHdr) {
      const m = (secHdr.textContent || '').match(/(\d+)\s*轮提问\s*\/\s*(\d+)\s*次/);
      if (m) {
        data.sessionTurns = Number(m[1]) || 1;
        data.sessionCalls = Number(m[2]) || 1;
      }
    }

    tmp.querySelectorAll('.ag-tt-row').forEach((row) => {
      const lbl = (row.querySelector('.ag-tt-lbl')?.textContent || '').trim();
      const val = (row.querySelector('.ag-tt-val')?.textContent || '').trim();
      if (!lbl) return;

      if (lbl === '生成速度') {
        const sm = val.match(/流式\s*([\d.]+)\s*tok\/s/i);
        if (sm) {
          data.streamTps = Number(sm[1]);
          data.isBuffered = false;
        } else {
          const em = val.match(/([\d.]+)\s*tok\/s/i);
          if (em) {
            data.streamTps = Number(em[1]);
            data.isBuffered = true;
          }
        }
      } else if (lbl === '响应耗时') {
        const fm = val.match(/(TTFT|等待)\s*([\d.]+)s/i);
        if (fm) {
          data.isHold = fm[1] === '等待';
          data.ttftSec = Number(fm[2]);
        }
        const tm = val.match(/总计\s*([\d.]+)s/i);
        if (tm) data.stepDur = Number(tm[1]);
      } else if (lbl === '当前上下文') {
        const cm = val.match(/,\s*([\d.]+)%\)/);
        if (cm) data.lastCacheRate = Number(cm[1]);
      } else if (lbl === '本步输出量') {
        const om = val.match(/^([\d,]+)/);
        if (om) data.stepOut = Number(om[1].replace(/,/g, ''));
      } else if (/^本轮合计/.test(lbl)) {
        const sm = lbl.match(/\((\d+)\s*步\)/);
        if (sm) data.turnSteps = Number(sm[1]) || 1;
        const om = val.match(/^输出\s*([\d,]+)/);
        if (om) data.turnOut = Number(om[1].replace(/,/g, ''));
        const dm = val.match(/耗时\s*([\d.]+)s/i);
        if (dm) data.turnDur = Number(dm[1]);
      } else if (lbl === '压缩水位线') {
        const wm = val.match(/^(.+?)\s*\((\d+%)\)/);
        if (wm) {
          data.ctxRatio = wm[1].trim();
          data.ctxPct = wm[2];
        }
      } else if (lbl === '累计输入量') {
        const hm = val.match(/命中率\s*([\d.]+)%/);
        if (hm) data.sessionCacheRate = Number(hm[1]);
      } else if (/^子\s*Agent/i.test(lbl)) {
        const cm = lbl.match(/\((\d+)/);
        const syncing = lbl.includes('同步中');
        if (cm) {
          data.subLabel = `+${cm[1]} 个`;
          const outM = val.match(/输出\s*([^\s·]+)/);
          if (outM) data.subSub = `输出 ${outM[1]}`;
          else if (syncing) data.subSub = '同步中';
        } else if (syncing) {
          data.subLabel = '同步中';
        }
      } else if (lbl === '累计输出量') {
        const om = val.match(/总计\s*([^\s(]+)/);
        if (om) data.sessionTotalOut = om[1];
      }
    });

    const warnEl = tmp.querySelector('.ag-tt-warn');
    if (warnEl) data.warnHtml = warnEl.outerHTML;

    if (!Number.isFinite(data.streamTps) && !data.ctxRatio) return null;
    return data;
  }

  function buildSlimMetricsTooltipHtml(d, ctxFallback, compactStatus) {
    const esc = (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const row = (lbl, valHtml) =>
      `<div class="ag-ux-tt-row"><span class="ag-ux-tt-lbl">${esc(lbl)}</span><span class="ag-ux-tt-val">${valHtml}</span></div>`;

    const steps = d.turnSteps > 1 ? d.turnSteps : 1;
    const durVal = Number.isFinite(d.turnDur) ? d.turnDur : d.stepDur;
    const outVal = Number.isFinite(d.turnOut) ? d.turnOut : d.stepOut;
    const tpsText =
      Number.isFinite(d.streamTps) && d.streamTps > 0
        ? d.streamTps < 1
          ? d.streamTps.toFixed(1)
          : String(Math.round(d.streamTps))
        : '';
    const speedHtml = tpsText
      ? `${tpsText} tok/s${d.isBuffered ? `<span class="ag-ux-tt-sub">${L('缓冲', 'buffered')}</span>` : ''}`
      : '—';
    const ttftHtml = Number.isFinite(d.ttftSec) ? fmtDurationSec(d.ttftSec) : '';
    const durHtml = fmtDurationSec(durVal) || '—';
    const outHtml = fmtCompactTokens(outVal) || '—';

    const ctxRatio = d.ctxRatio || ctxFallback.ratioText || '';
    const ctxPct = d.ctxPct || (ctxFallback.hasData ? `${ctxFallback.pct}%` : '');
    const { preUsed, limitLabel, summaryLabel } = extractCompactLabels(
      { ratioText: ctxRatio },
      ctxFallback && ctxFallback.cascadeId
    );
    let ctxHtml = '—';
    if (compactStatus === 'compacting') {
      ctxHtml = `${L('压缩中…', 'Compacting…')}${preUsed ? `<span class="ag-ux-tt-sub">${L('原 ', 'was ')}${esc(preUsed)}</span>` : ''}`;
    } else if (compactStatus === 'compacted') {
      ctxHtml =
        summaryLabel && limitLabel
          ? `${esc(summaryLabel)} / ${esc(limitLabel)}<span class="ag-ux-tt-sub">${L('已压缩', 'Compacted')}${preUsed ? ` · ${L('原 ', 'was ')}${esc(preUsed)}` : ''}</span>`
          : `${L('已压缩', 'Compacted')}${preUsed ? `<span class="ag-ux-tt-sub">${L('原 ', 'was ')}${esc(preUsed)}</span>` : ''}`;
    } else if (ctxRatio) {
      ctxHtml = `${esc(ctxRatio)}${ctxPct ? `<span class="ag-ux-tt-sub">${esc(ctxPct)}</span>` : ''}`;
    }

    const lastCache = Number.isFinite(d.lastCacheRate) ? `${Math.round(d.lastCacheRate)}%` : '';
    const lastTier = cacheTierForRate(d.lastCacheRate);
    const sessCache = Number.isFinite(d.sessionCacheRate) ? `${Math.round(d.sessionCacheRate)}%` : '';
    const sessTier = cacheTierForRate(d.sessionCacheRate);
    const cacheHtml = lastCache
      ? `<span class="ag-ux-tt-cache" data-cache-tier="${lastTier}">${lastCache}</span>${sessCache ? `<span class="ag-ux-tt-sub">${L('累计 ', 'avg ')}${sessCache}</span>` : ''}`
      : sessCache
        ? `<span class="ag-ux-tt-cache" data-cache-tier="${sessTier}">${sessCache}</span>`
        : '—';

    const sec1List = [row(L('生成速度', 'Speed'), speedHtml)];
    if (ttftHtml) {
      sec1List.push(row(d.isHold ? L('首包等待', 'Hold') : L('首字耗时', 'TTFT'), ttftHtml));
    }
    sec1List.push(row(L('本轮耗时', 'Duration'), durHtml), row(L('本轮输出', 'Output'), outHtml));

    const sec2List = [row(L('上下文', 'Context'), ctxHtml), row(L('缓存命中', 'Cache hit'), cacheHtml)];
    if ((d.sessionTurns > 1 || d.subLabel) && d.sessionTotalOut) {
      sec2List.push(row(L('累计输出', 'Total out'), esc(d.sessionTotalOut)));
    }
    if (d.subLabel) {
      const subDisplay = FEAT.i18n ? d.subLabel : d.subLabel.replace(/\s*个$/, '').replace('同步中', 'syncing');
      const subSubDisplay = FEAT.i18n ? d.subSub : String(d.subSub || '').replace(/^输出\s+/, 'out ').replace('同步中', 'syncing');
      sec2List.push(
        row(
          L('子 Agent', 'Subagents'),
          `${esc(subDisplay)}${subSubDisplay ? `<span class="ag-ux-tt-sub">${esc(subSubDisplay)}</span>` : ''}`
        )
      );
    }

    return (
      `<div class="ag-ux-tt">` +
      `<div class="ag-ux-tt-sec">` +
      `<div class="ag-ux-tt-hdr"><span class="ag-ux-tt-title">${L('本轮响应', 'This turn')}</span><span class="ag-ux-tt-badge">${FEAT.i18n ? `${steps} 步` : `${steps} ${steps === 1 ? 'step' : 'steps'}`}</span></div>` +
      sec1List.join('') +
      `</div>` +
      `<div class="ag-ux-tt-div"></div>` +
      `<div class="ag-ux-tt-sec">` +
      `<div class="ag-ux-tt-hdr"><span class="ag-ux-tt-title">${L('当前会话', 'Session')}</span><span class="ag-ux-tt-badge">${FEAT.i18n ? `${d.sessionTurns} 轮` : `${d.sessionTurns} ${d.sessionTurns === 1 ? 'turn' : 'turns'}`}</span></div>` +
      sec2List.join('') +
      `</div>` +
      (d.warnHtml || '') +
      `</div>`
    );
  }

  function parseAndSlimMetricsPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const rawInline = payload.__agOrigInlineHtml || payload.inlineHtml || '';
    const rawTooltip = payload.__agOrigTooltipHtml || payload.tooltipHtml || '';
    const curCid = getActiveCascadeId();

    /* Fast structured path (zero DOM innerHTML parsing) when daemon provides payload.metrics */
    if (
      payload.hasData &&
      payload.metrics &&
      typeof payload.metrics === 'object' &&
      (!curCid || payload.cascadeId === curCid)
    ) {
      const m = payload.metrics;
      const ratioText = String(m.ctxRatioStr || '');
      const pct = Math.max(0, Math.min(100, Number(m.ctxPct || 0)));
      const outTokNum = Number(m.outTok || 0);
      const outText = Number.isFinite(outTokNum) && outTokNum > 0 ? `Out ${fmtCompactTokens(outTokNum)}` : '';
      const useStream = Boolean(m.useStream);
      const dispTps = Number(m.displayTps);
      const streamTpsVal = useStream ? Number(m.rawStreamTps) : Number(m.e2eTps);
      const ttftNum = Number(m.ttft);
      const totDurNum = Number(m.totDur);
      const hasTurn = Number(m.turnSteps) > 1;
      const totalOutCombined = Number(m.childCount) > 0 ? Number(m.totalOut || 0) + Number(m.childOut || 0) : Number(m.totalOut || 0);
      let warnHtml = '';
      if (rawTooltip && rawTooltip.includes('ag-tt-warn')) {
        const tmpW = document.createElement('div');
        tmpW.innerHTML = rawTooltip;
        warnHtml = tmpW.querySelector('.ag-tt-warn')?.outerHTML || '';
      }

      const parsedTt = {
        streamTps: Number.isFinite(streamTpsVal) ? Number(streamTpsVal.toFixed(1)) : NaN,
        isBuffered: !useStream,
        ttftSec: Number.isFinite(ttftNum) ? Number(ttftNum.toFixed(2)) : NaN,
        isHold: !useStream,
        stepDur: Number.isFinite(totDurNum) ? Number(totDurNum.toFixed(2)) : NaN,
        lastCacheRate: Number(m.lastCacheRate),
        stepOut: outTokNum,
        turnSteps: hasTurn ? Number(m.turnSteps) : 1,
        turnOut: hasTurn ? Number(m.turnOut) : NaN,
        turnDur: hasTurn && Number.isFinite(Number(m.turnDur)) ? Number(Number(m.turnDur).toFixed(1)) : NaN,
        sessionTurns: Number(payload.stats?.turns) || 1,
        sessionCalls: Number(payload.stats?.calls) || 1,
        ctxRatio: ratioText,
        ctxPct: `${pct}%`,
        sessionCacheRate: Number(m.sessionCacheRate),
        sessionTotalOut: totalOutCombined > 0 ? fmtCompactTokens(totalOutCombined) : '',
        subLabel: Number(m.childCount) > 0 ? `+${Number(m.childCount)} 个` : '',
        subSub: Number(m.childCount) > 0 ? `输出 ${fmtCompactTokens(Number(m.childOut || 0))}` : '',
        warnHtml
      };

      const inlineSegs = [];
      if (Number.isFinite(dispTps) && dispTps > 0) {
        if (Math.round(dispTps) > 0) {
          inlineSegs.push(`<span>${Math.round(dispTps)} tok/s</span>`);
        } else if (parsedTt.streamTps > 0 && parsedTt.streamTps < 1) {
          inlineSegs.push(`<span>${parsedTt.streamTps.toFixed(1)} tok/s</span>`);
        }
      }
      if (Number.isFinite(ttftNum) && ttftNum >= 0) {
        const label = useStream ? 'TTFT' : 'Hold';
        const durStr = ttftNum >= 60 ? fmtDurationSec(ttftNum) : `${ttftNum.toFixed(1)}s`;
        inlineSegs.push(`<span>${label} ${durStr}</span>`);
      }

      rtState.latestCtxState = {
        pct,
        ratioText,
        outText,
        hasData: Boolean(ratioText),
        cascadeId: payload.cascadeId || curCid
      };

      const compactStatus = detectCompactStatus(curCid);
      const nextTooltipHtml = buildSlimMetricsTooltipHtml(parsedTt, rtState.latestCtxState, compactStatus);
      return Object.assign({}, payload, {
        __agOrigInlineHtml: rawInline,
        __agOrigTooltipHtml: rawTooltip,
        inlineHtml: inlineSegs.join('<span class="ag-sep">·</span>'),
        tooltipHtml: nextTooltipHtml
      });
    }

    if (payload.hasData && rawInline && (!curCid || payload.cascadeId === curCid)) {
      const parsedTt = parseMetricsTooltipData(rawTooltip);
      const tmp = document.createElement('div');
      tmp.innerHTML = rawInline;
      let ratioText = '';
      let pct = 0;
      let outText = '';

      const kids = Array.from(tmp.children);
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        const txt = (el.textContent || '').trim();
        if (/^0(?:\.0+)?\s*tok\/s$/i.test(txt)) {
          if (parsedTt && Number.isFinite(parsedTt.streamTps) && parsedTt.streamTps > 0 && parsedTt.streamTps < 1) {
            el.textContent = `${parsedTt.streamTps.toFixed(1)} tok/s`;
          } else {
            const next = el.nextElementSibling;
            if (next && next.classList.contains('ag-sep')) next.remove();
            else if (el.previousElementSibling && el.previousElementSibling.classList.contains('ag-sep')) {
              el.previousElementSibling.remove();
            }
            el.remove();
          }
        } else if (/^(TTFT|Hold)\s+([\d.]+)s$/i.test(txt)) {
          const dm = txt.match(/^(TTFT|Hold)\s+([\d.]+)s$/i);
          const sec = dm ? Number(dm[2]) : NaN;
          if (Number.isFinite(sec) && sec >= 60) {
            el.textContent = `${dm[1]} ${fmtDurationSec(sec)}`;
          }
        } else if (/^Ctx\b/i.test(txt)) {
          const m = txt.match(/Ctx\s+([^\s(]+)\s*(?:\((\d+)%\))?/i);
          if (m) {
            ratioText = m[1].replace('/', ' / ');
            pct = Math.max(0, Math.min(100, Number(m[2] || 0)));
          }
          const prev = el.previousElementSibling;
          if (prev && prev.classList.contains('ag-sep')) prev.remove();
          el.remove();
        } else if (/^Out\b/i.test(txt)) {
          outText = txt;
          const prev = el.previousElementSibling;
          if (prev && prev.classList.contains('ag-sep')) prev.remove();
          el.remove();
        } else if (el.classList.contains('ag-sub-badge') || /^\+?\d+\s*sub\b/i.test(txt)) {
          const prev = el.previousElementSibling;
          if (prev && prev.classList.contains('ag-sep')) prev.remove();
          el.remove();
        }
      }
      while (tmp.firstElementChild && tmp.firstElementChild.classList.contains('ag-sep')) {
        tmp.firstElementChild.remove();
      }

      rtState.latestCtxState = {
        pct,
        ratioText,
        outText,
        hasData: Boolean(ratioText),
        cascadeId: payload.cascadeId || curCid
      };

      const compactStatus = detectCompactStatus(curCid);
      const nextTooltipHtml = parsedTt
        ? buildSlimMetricsTooltipHtml(parsedTt, rtState.latestCtxState, compactStatus)
        : rawTooltip;
      const slimmed = Object.assign({}, payload, {
        __agOrigInlineHtml: rawInline,
        __agOrigTooltipHtml: rawTooltip,
        inlineHtml: tmp.innerHTML,
        tooltipHtml: nextTooltipHtml
      });
      return slimmed;
    }

    if (!curCid || payload.cascadeId !== curCid || !payload.hasData) {
      rtState.latestCtxState = { pct: 0, ratioText: '', outText: '', hasData: false, cascadeId: curCid };
    }
    return payload;
  }

  function positionMetricsTooltip(pill, tt) {
    if (!pill || !tt || !tt.querySelector('.ag-ux-tt')) return;
    const textEl = pill.querySelector('#ag-live-metrics-text');
    const anchor = textEl && textEl.offsetWidth > 0 ? textEl : pill;
    const r = anchor.getBoundingClientRect();
    const pillRect = pill.getBoundingClientRect();
    const ttWidth = 272;
    const isBottomRow = pill.getAttribute('data-ag-row-mode') === 'bottom';
    const idealLeft = isBottomRow ? r.left + r.width / 2 - ttWidth / 2 : r.left;
    const left = Math.round(Math.max(12, Math.min(idealLeft, window.innerWidth - ttWidth - 16)));
    const bottomPx = Math.round(
      Math.max(8, Math.min(window.innerHeight - pillRect.top + 8, window.innerHeight - (tt.offsetHeight || 220) - 12))
    );
    tt.style.left = `${left}px`;
    tt.style.bottom = `${bottomPx}px`;
  }

  const onMetricsPillMouseEnter = (e) => {
    if (rtState.disposed || !FEAT.contextRing) return;
    const pill = e.target && e.target.closest && e.target.closest('#ag-live-metrics-pill');
    if (!pill) return;
    const syncPos = () => {
      const tt = document.getElementById('ag-live-metrics-tooltip');
      if (tt) positionMetricsTooltip(pill, tt);
    };
    syncPos();
    queueMicrotask(syncPos);
  };

  const onMetricsPillMouseLeave = (e) => {
    if (rtState.disposed) return;
    const pill = e.target && e.target.closest && e.target.closest('#ag-live-metrics-pill');
    if (!pill) return;
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (tt && tt.getAttribute('data-ag-pinned') === '1') {
      tt.setAttribute('data-visible', '1');
    }
  };

  const onMetricsPillClick = (e) => {
    if (rtState.disposed || !FEAT.contextRing) return;
    const pill = e.target && e.target.closest && e.target.closest('#ag-live-metrics-pill');
    const tt = document.getElementById('ag-live-metrics-tooltip');
    if (!tt) return;
    if (pill) {
      e.preventDefault();
      e.stopPropagation();
      const willPin = tt.getAttribute('data-ag-pinned') !== '1';
      if (willPin) {
        positionMetricsTooltip(pill, tt);
        tt.setAttribute('data-ag-pinned', '1');
        tt.setAttribute('data-visible', '1');
      } else {
        tt.removeAttribute('data-ag-pinned');
        tt.removeAttribute('data-visible');
      }
      return;
    }
    if (tt.getAttribute('data-ag-pinned') === '1' && !tt.contains(e.target)) {
      tt.removeAttribute('data-ag-pinned');
      tt.removeAttribute('data-visible');
    }
  };

  document.addEventListener('mouseenter', onMetricsPillMouseEnter, true);
  document.addEventListener('mouseleave', onMetricsPillMouseLeave, true);
  document.addEventListener('click', onMetricsPillClick, true);

  /* Wrapped lazily (retried every sync) so load order vs. the upstream runtime does not matter.
     A stale wrapper left by an older instance is unwrapped first; after dispose or feature toggle-off ours restores original HTML. */
  let ownMetricsWrapper = null;
  function ensureMetricsWrapped() {
    let cur = window.__ag_render_metrics;
    if (typeof cur !== 'function' || cur === ownMetricsWrapper) return;
    while (cur && cur.__agSlimWrapped && typeof cur.__agOrig === 'function') cur = cur.__agOrig;
    const origRenderMetrics = cur;
    const wrappedRender = function (payload) {
      if (rtState.disposed || !FEAT.contextRing) {
        const rawPayload =
          payload && typeof payload === 'object'
            ? Object.assign({}, payload, {
                inlineHtml: payload.__agOrigInlineHtml !== undefined ? payload.__agOrigInlineHtml : payload.inlineHtml,
                tooltipHtml: payload.__agOrigTooltipHtml !== undefined ? payload.__agOrigTooltipHtml : payload.tooltipHtml
              })
            : payload;
        const ret = origRenderMetrics.call(this, rawPayload);
        if (!rtState.disposed && FEAT.overviewPanel) renderOverviewPanel(false);
        return ret;
      }
      const slimPayload = parseAndSlimMetricsPayload(payload);
      const ret = origRenderMetrics.call(this, slimPayload);
      const ttNow = document.getElementById('ag-live-metrics-tooltip');
      if (ttNow) {
        const hasUxTt = Boolean(ttNow.querySelector(':scope > .ag-ux-tt'));
        if (hasUxTt) {
          if (ttNow.getAttribute('data-ag-ux-tt') !== '1') ttNow.setAttribute('data-ag-ux-tt', '1');
        } else if (ttNow.hasAttribute('data-ag-ux-tt')) {
          ttNow.removeAttribute('data-ag-ux-tt');
        }
      }
      if (payload && payload.__agOrigInlineHtml === undefined && window.__ag_last_metrics === slimPayload) {
        window.__ag_last_metrics.__agOrigInlineHtml = payload.inlineHtml;
      }
      if (payload && payload.__agOrigTooltipHtml === undefined && window.__ag_last_metrics === slimPayload) {
        window.__ag_last_metrics.__agOrigTooltipHtml = payload.tooltipHtml;
      }
      updateComposerRingVisuals();
      if (rtState.quotaPopoverOpen) renderQuotaPopoverBody();
      if (FEAT.overviewPanel) renderOverviewPanel(false);
      if (payload && payload.hasData && payload.stats) {
        const nextUsageSig = `${payload.cascadeId || ''}:${payload.stats.calls || 0}:${payload.stats.turns || 0}:${payload.stats.childCalls || 0}`;
        const prevCid = lastQuotaUsageSig ? lastQuotaUsageSig.split(':')[0] : '';
        const curCidSig = String(payload.cascadeId || '');
        if (!lastQuotaUsageSig || prevCid !== curCidSig) {
          lastQuotaUsageSig = nextUsageSig;
          if ((isOverviewPanelVisible() || rtState.quotaPopoverOpen) && Date.now() - rtState.lastForceQuotaFetchTs >= 8000) {
            scheduleAutoQuotaRefresh(250, 5000);
          }
        } else if (nextUsageSig !== lastQuotaUsageSig) {
          lastQuotaUsageSig = nextUsageSig;
          if (FEAT.overviewPanel || FEAT.contextRing) {
            scheduleAutoQuotaRefresh(650, 4500);
          }
        }
      }
      return ret;
    };
    wrappedRender.__agSlimWrapped = true;
    wrappedRender.__agOrig = origRenderMetrics;
    ownMetricsWrapper = wrappedRender;
    window.__ag_render_metrics = wrappedRender;

    if (window.__ag_last_metrics) {
      window.__ag_render_metrics(window.__ag_last_metrics);
    }
  }
  ensureMetricsWrapped();

  let lastQuotaSvcMissTs = 0;
  function discoverQuotaService(refreshAccount = false) {
    if (!refreshAccount && cachedQuotaSvc && rtState.cachedUserTierName && cachedUserAccountKey) return cachedQuotaSvc;
    if (!refreshAccount && !cachedQuotaSvc && lastQuotaSvcMissTs && Date.now() - lastQuotaSvcMissTs < 5000) {
      return null;
    }
    const inputBox = getActiveInputBox();
    const fk = inputBox ? Object.keys(inputBox).find((k) => k.startsWith('__reactFiber$')) : null;
    let f = fk ? inputBox[fk] : null;
    const seen = new Set();
    let foundSvc = null;
    let foundTierName = '';
    let foundTierId = '';
    let foundEmail = '';

    const walkObj = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 4 || seen.has(obj)) return;
      seen.add(obj);
      try {
        if (!foundSvc && typeof obj.retrieveUserQuotaSummary === 'function') {
          foundSvc = obj;
        }
        if (!foundTierName && obj.userTier && typeof obj.userTier.name === 'string' && obj.userTier.name.trim()) {
          foundTierName = obj.userTier.name.trim();
          foundTierId = typeof obj.userTier.id === 'string' ? obj.userTier.id.trim() : '';
          foundEmail = typeof obj.email === 'string' ? obj.email : typeof obj.userEmail === 'string' ? obj.userEmail : '';
        }
      } catch {}
      let keys = [];
      try {
        keys = Object.keys(obj).slice(0, 40);
      } catch {}
      for (const k of keys) {
        try {
          const v = obj[k];
          if (v && typeof v === 'object') walkObj(v, depth + 1);
        } catch {}
      }
    };

    for (let n = 0; n < 45 && f; n++, f = f.return) {
      walkObj(f.memoizedProps, 0);
      walkObj(f.memoizedState, 0);
      let dep = f.dependencies ? f.dependencies.firstContext : null;
      while (dep) {
        walkObj(dep.memoizedValue, 0);
        dep = dep.next;
      }
      if ((!foundSvc || !foundTierName) && f.alternate) {
        walkObj(f.alternate.memoizedProps, 0);
        walkObj(f.alternate.memoizedState, 0);
        let altDep = f.alternate.dependencies ? f.alternate.dependencies.firstContext : null;
        while (altDep) {
          walkObj(altDep.memoizedValue, 0);
          altDep = altDep.next;
        }
      }
      if (foundSvc && foundTierName) break;
    }

    if (!foundSvc || !foundTierName) {
      const root = document.getElementById('root');
      const rfk = root && Object.keys(root).find((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
      if (rfk && root[rfk]) {
        const rq = [root[rfk]];
        const rSeen = new Set();
        while (rq.length && rSeen.size < 320 && (!foundSvc || !foundTierName)) {
          const rf = rq.shift();
          if (!rf || rSeen.has(rf)) continue;
          rSeen.add(rf);
          walkObj(rf.memoizedProps, 0);
          for (let dep = rf.dependencies && rf.dependencies.firstContext; dep; dep = dep.next) {
            walkObj(dep.memoizedValue, 0);
          }
          if (rf.child) rq.push(rf.child);
          if (rf.sibling) rq.push(rf.sibling);
        }
      }
    }

    if (foundSvc) {
      cachedQuotaSvc = foundSvc;
      lastQuotaSvcMissTs = 0;
    } else {
      lastQuotaSvcMissTs = Date.now();
    }
    if (foundTierName) {
      const nextAccountKey = `${foundEmail}|${foundTierId}|${foundTierName}`;
      if (cachedUserAccountKey && cachedUserAccountKey !== nextAccountKey) {
        rtState.cachedQuotaGroups = null;
        lastQuotaFetchTs = 0;
        selectedQuotaGroupIdx = -1;
      }
      rtState.cachedUserTierName = foundTierName;
      cachedUserAccountKey = nextAccountKey;
    }
    return cachedQuotaSvc;
  }

  function invokeQuotaSummaryRpc(svc, forceRefresh) {
    const fn = svc && svc.retrieveUserQuotaSummary;
    if (typeof fn !== 'function') return Promise.resolve(null);
    let wantsBool = Boolean(
      typeof svc.loadCodeAssist === 'function' || typeof svc.getUserAccountSettings === 'function'
    );
    if (!wantsBool && typeof svc.getUserStatus !== 'function') {
      try {
        const src = Function.prototype.toString.call(fn).trim();
        wantsBool =
          fn.length === 1 &&
          !/\.forceRefresh\b/.test(src) &&
          /^(?:async\s+)?(?:function\s*\w*\s*\(\s*forceRefresh\s*\)|(?:\(\s*)?forceRefresh(?:\s*\))?\s*=>)/.test(src);
      } catch {}
    }
    const arg = wantsBool ? Boolean(forceRefresh) : { forceRefresh: Boolean(forceRefresh) };
    return new Promise((resolve) => resolve(svc.retrieveUserQuotaSummary(arg)));
  }

  function isOverviewPanelVisible() {
    if (!FEAT.overviewPanel) return false;
    const panel = document.querySelector('[data-testid="overview-panel"]');
    return Boolean(panel && !panel.hidden && panel.getAttribute('aria-hidden') !== 'true');
  }

  function scheduleAutoQuotaRefresh(delayMs = 650, minGapMs = 5000) {
    if (rtState.disposed) return;
    if (autoQuotaRefreshTimer) {
      cancelLater(autoQuotaRefreshTimer);
      autoQuotaRefreshTimer = 0;
    }
    const sinceLast = Date.now() - rtState.lastForceQuotaFetchTs;
    const waitMs = Math.max(delayMs, rtState.lastForceQuotaFetchTs > 0 ? minGapMs - sinceLast : delayMs);
    autoQuotaRefreshTimer = later(() => {
      autoQuotaRefreshTimer = 0;
      if (rtState.disposed) return;
      if (typeof document.visibilityState === 'string' && document.visibilityState === 'hidden') return;
      if (discoverQuotaService(false)) {
        fetchQuotaSummary(true);
      }
    }, Math.max(60, waitMs));
  }

  function fetchQuotaSummary(forceRefresh = false) {
    const svc = discoverQuotaService();
    if (!svc) return Promise.resolve(rtState.cachedQuotaGroups || []);
    const now = Date.now();
    if (!forceRefresh && rtState.cachedQuotaGroups && now - lastQuotaFetchTs < 5000) {
      return Promise.resolve(rtState.cachedQuotaGroups);
    }
    if (rtState.quotaFetchInFlight) return rtState.quotaFetchInFlight;

    rtState.quotaFetchInFlight = invokeQuotaSummaryRpc(svc, forceRefresh)
      .then((res) => {
        if (rtState.disposed) return [];
        const rawGroups = (res && res.response && res.response.groups) || (res && res.groups) || [];
        rtState.cachedQuotaGroups = rawGroups.filter((g) => g && Array.isArray(g.buckets) && g.buckets.length > 0);
        lastQuotaFetchTs = Date.now();
        if (forceRefresh) rtState.lastForceQuotaFetchTs = lastQuotaFetchTs;
        persistQuotaSnapshot();
        if (quotaHoldTimer) {
          cancelLater(quotaHoldTimer);
          quotaHoldTimer = 0;
        }
        const popEl = document.getElementById('ag-claude-quota-popover');
        if (popEl) popEl.removeAttribute('data-loading-hold');
        if (rtState.quotaPopoverOpen) renderQuotaPopoverBody();
        if (FEAT.overviewPanel) renderOverviewPanel(false);
        updateComposerRingVisuals();
        return rtState.cachedQuotaGroups;
      })
      .catch(() => {
        cachedQuotaSvc = null; /* service object may belong to an unmounted tree: rediscover next time */
        if (quotaHoldTimer) {
          cancelLater(quotaHoldTimer);
          quotaHoldTimer = 0;
        }
        const popEl = document.getElementById('ag-claude-quota-popover');
        if (popEl) popEl.removeAttribute('data-loading-hold');
        return rtState.cachedQuotaGroups || [];
      })
      .finally(() => {
        rtState.quotaFetchInFlight = null;
      });
    return rtState.quotaFetchInFlight;
  }

  function formatResetLabel(bucket, usedPct) {
    const win = String(bucket.window || '').trim().toLowerCase();
    const secStr = bucket.resetTime && bucket.resetTime.seconds !== undefined ? String(bucket.resetTime.seconds) : '';
    const resetMs = secStr ? Number(secStr) * 1000 : 0;

    if (win === '5h' && usedPct === 0 && !bucket.description) {
      return L('从发送第一条消息时起算', 'Starts on first message');
    }
    if (!resetMs || Number.isNaN(resetMs)) {
      return usedPct === 0 ? L('从发送第一条消息时起算', 'Starts on first message') : '';
    }
    const diffMs = resetMs - Date.now();
    if (diffMs <= 60000) return L('即将重置', 'Resets soon');

    if (win === 'weekly') {
      const dt = new Date(resetMs);
      const weekdaysZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const weekdaysEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const hh = String(dt.getHours()).padStart(2, '0');
      const mm = String(dt.getMinutes()).padStart(2, '0');
      return FEAT.i18n ? `${weekdaysZh[dt.getDay()]} ${hh}:${mm} 重置` : `Resets ${weekdaysEn[dt.getDay()]} ${hh}:${mm}`;
    }

    const totalMins = Math.floor(diffMs / 60000);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hrs > 0) {
      if (FEAT.i18n) return mins > 0 ? `${hrs} 小时 ${mins} 分后重置` : `${hrs} 小时后重置`;
      return mins > 0 ? `Resets in ${hrs}h ${mins}m` : `Resets in ${hrs}h`;
    }
    const m = Math.max(1, mins);
    return FEAT.i18n ? `${m} 分钟后重置` : `Resets in ${m}m`;
  }

  function localizeGroupShortName(name) {
    const s = String(name || '').trim();
    if (!s) return L('全部模型', 'All models');
    if (/^gemini(?:\s+models?)?$/i.test(s)) return L('Gemini 模型', 'Gemini');
    if (/claude/i.test(s) && /gpt/i.test(s)) return 'Claude / GPT';
    if (/^claude(?:\s+models?)?$/i.test(s)) return L('Claude 模型', 'Claude');
    return s;
  }

  function detectDefaultGroupIndex(groups) {
    if (!groups || groups.length <= 1) return 0;
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    const trigger = inputBox && inputBox.querySelector('button[data-testid="model-selector-trigger"]');
    const txt = ((trigger ? trigger.textContent : inputBox ? inputBox.textContent : '') || '').trim().toLowerCase();
    const specificIdx = groups.findIndex((g) => {
      const dn = String(g.displayName || '').trim().toLowerCase();
      return dn && !/^gemini(?:\s+models?)?$/.test(dn) && !(/claude/.test(dn) && /gpt/.test(dn)) && txt.includes(dn);
    });
    if (specificIdx >= 0) return specificIdx;
    const want3p = /claude|sonnet|opus|gpt/i.test(txt);
    const exactFamilyIdx = groups.findIndex((g) => {
      const dn = String(g.displayName || '').trim();
      return want3p ? /claude|gpt/i.test(dn) : /^gemini(?:\s+models?)?$/i.test(dn);
    });
    if (exactFamilyIdx >= 0) return exactFamilyIdx;
    const broadIdx = groups.findIndex((g) =>
      want3p ? /claude|gpt/i.test(g.displayName || '') : /gemini/i.test(g.displayName || '')
    );
    return broadIdx >= 0 ? broadIdx : 0;
  }

  function readBucketRemaining(b) {
    if (b?.remaining?.case === 'remainingFraction' && typeof b.remaining.value === 'number') {
      return b.remaining.value;
    }
    return typeof b?.remainingFraction === 'number' ? b.remainingFraction : 1;
  }

  function barColorForPct(pct, warnAt = 70, critAt = 85) {
    if (pct >= critAt) return '#DC2626';
    if (pct >= warnAt) return '#D97706';
    return 'var(--primary, #2F75C3)';
  }

  function barColorForPoolPct(pct, displayName = '', warnAt = 75, critAt = 90) {
    if (pct >= critAt) return '#DC2626';
    if (pct >= warnAt) return '#D97706';
    if (/claude|opus|sonnet/i.test(String(displayName || ''))) return '#D97757';
    return 'var(--primary, #2F75C3)';
  }

  function ensureQuotaPopover() {
    let pop = document.getElementById('ag-claude-quota-popover');
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'ag-claude-quota-popover';
    pop.setAttribute('data-ag-i18n-ignore', '1');
    pop.setAttribute('data-open', 'false');
    pop.addEventListener('click', (e) => {
      const compactBtn = e.target.closest('[data-ag-qp-compact]');
      if (compactBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (!compactBtn.disabled) triggerConversationCompact();
        return;
      }
      const tabBtn = e.target.closest('[data-ag-quota-tab]');
      if (tabBtn) {
        e.stopPropagation();
        selectedQuotaGroupIdx = Number(tabBtn.getAttribute('data-ag-quota-tab')) || 0;
        renderQuotaPopoverBody();
        return;
      }
      const jumpBtn = e.target.closest('[data-ag-quota-jump]');
      if (jumpBtn) {
        e.stopPropagation();
        selectedQuotaGroupIdx = Number(jumpBtn.getAttribute('data-ag-quota-jump')) || 0;
        renderQuotaPopoverBody();
        return;
      }
      const viewAll = e.target.closest('[data-ag-quota-view-all]');
      if (viewAll) {
        e.stopPropagation();
        closeQuotaPopover();
        const settingsBtn = document.querySelector('button[data-testid="settings-button"]');
        if (settingsBtn) {
          settingsBtn.click();
          let tries = 0;
          const jumpModels = () => {
            const modelsBtn = document.querySelector('button[data-testid="settings-nav-item-Models"]');
            if (modelsBtn) {
              modelsBtn.click();
            } else if (++tries < 12) {
              frame(jumpModels);
            }
          };
          frame(jumpModels);
        }
      }
    });
    document.body.appendChild(pop);
    return pop;
  }

  function positionQuotaPopover() {
    const ring = document.getElementById('ag-claude-ctx-ring');
    const pop = document.getElementById('ag-claude-quota-popover');
    if (!ring || !pop) return;
    const r = ring.getBoundingClientRect();
    const popW = 344;
    const left = Math.max(12, Math.min(Math.round(r.left - 84), window.innerWidth - popW - 14));
    const bottom = Math.max(12, Math.round(window.innerHeight - r.top + 10));
    pop.style.left = `${left}px`;
    pop.style.bottom = `${bottom}px`;
  }

  function formatQuotaUsedPctStr(val) {
    const clamped = Math.max(0, Math.min(100, val));
    if (clamped <= 0) return '0';
    if (clamped >= 99.95) return '100';
    return clamped.toFixed(1).replace(/\.0$/, '');
  }

  function renderQuotaPopoverBody() {
    const pop = ensureQuotaPopover();
    const curCid = getActiveCascadeId();
    const hasCtx = Boolean(curCid && rtState.latestCtxState.cascadeId === curCid && rtState.latestCtxState.hasData);
    const compactStatus = detectCompactStatus(curCid);
    const paneRunning = isPaneCurrentlyRunning();
    const { preUsed, limitLabel, summaryLabel, summaryPct } = extractCompactLabels(rtState.latestCtxState, curCid);

    let ctxPct = hasCtx ? rtState.latestCtxState.pct : 0;
    let ctxPctLabel = `${ctxPct}%`;
    let ctxSub = hasCtx
      ? `${rtState.latestCtxState.ratioText}${rtState.latestCtxState.outText ? ` · ${rtState.latestCtxState.outText}` : ''}`
      : L('当前会话暂无消耗', 'No usage yet');
    let ctxColor = barColorForPct(ctxPct, 70, 85);
    let fillCompactingAttr = '';
    let compactBtnHtml = '';

    if (compactStatus === 'compacting') {
      ctxPct = 14;
      ctxPctLabel = '…';
      ctxSub = preUsed ? L(`正在压缩 ${preUsed}…`, `Compacting ${preUsed}…`) : L('正在生成压缩摘要…', 'Summarizing context…');
      ctxColor = 'var(--primary, #2F75C3)';
      fillCompactingAttr = ' data-compacting="true"';
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="compacting" disabled title="${escapeHtml(L('正在总结历史并压缩上下文…', 'Summarizing history and compacting context…'))}">${SVG_COMPACT_ICON}<span>${L('压缩中…', 'Compacting…')}</span></button>`;
    } else if (compactStatus === 'compacted') {
      if (summaryLabel && limitLabel) {
        ctxPct = Math.max(2, summaryPct);
        ctxPctLabel = `${summaryPct}%`;
        ctxSub = `${summaryLabel} / ${limitLabel}`;
      } else {
        ctxPct = hasCtx ? 2 : 0;
        ctxPctLabel = '—';
        ctxSub = L('已完成压缩 · 下轮刷新', 'Compacted · refreshes next turn');
      }
      ctxColor = 'var(--primary, #2F75C3)';
      const doneTitle =
        preUsed && summaryLabel
          ? L(
              `已将 ${preUsed} 上下文压缩为 ${summaryLabel} 摘要，发下一条消息即按新上下文计费`,
              `Compacted ${preUsed} into a ${summaryLabel} summary; refreshes on next message`
            )
          : L('当前对话历史已完成压缩，发下一条消息即按新上下文计费', 'Context compacted; refreshes on next message');
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="compacted" disabled title="${escapeHtml(doneTitle)}">${SVG_COMPACT_DONE}<span>${L('已压缩', 'Compacted')}</span></button>`;
    } else if (!hasCtx) {
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="empty" disabled title="${escapeHtml(L('当前会话暂无可压缩上下文', 'No context to compact yet'))}">${SVG_COMPACT_ICON}<span>${L('压缩', 'Compact')}</span></button>`;
    } else if (paneRunning) {
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="busy" disabled title="${escapeHtml(L('请等待当前回复结束后再压缩上下文', 'Wait for the current response to finish before compacting'))}">${SVG_COMPACT_ICON}<span>${L('压缩', 'Compact')}</span></button>`;
    } else {
      const urgentAttr = ctxPct >= 85 ? ' data-urgent="crit"' : ctxPct >= 70 ? ' data-urgent="warn"' : '';
      compactBtnHtml = `<button type="button" class="ag-qp-compact-btn" data-ag-qp-compact="true" data-state="ready"${urgentAttr} title="${escapeHtml(L('立即执行 /compact 压缩当前对话上下文', 'Run /compact to compress this conversation context'))}">${SVG_COMPACT_ICON}<span>${L('压缩', 'Compact')}</span></button>`;
    }

    discoverQuotaService();
    const tierShort = rtState.cachedUserTierName
      ? rtState.cachedUserTierName.replace(/^Google\s+AI\s+/i, '').trim() || rtState.cachedUserTierName
      : '';
    const tierSuffix = tierShort ? ` · ${escapeHtml(tierShort)}` : '';

    const groups = rtState.cachedQuotaGroups || [];
    if (groups.length > 0 && (selectedQuotaGroupIdx < 0 || selectedQuotaGroupIdx >= groups.length)) {
      selectedQuotaGroupIdx = detectDefaultGroupIndex(groups);
    }

    let tabsHtml = '';
    if (groups.length > 1) {
      tabsHtml = `<div class="ag-qp-tabs">${groups
        .map((g, idx) => {
          const active = idx === selectedQuotaGroupIdx ? ' data-active="true"' : '';
          return `<button type="button" class="ag-qp-tab" data-ag-quota-tab="${idx}"${active}>${escapeHtml(localizeGroupShortName(
            g.displayName
          ))}</button>`;
        })
        .join('')}</div>`;
    }

    let quotaRowsHtml = '';
    if (!rtState.cachedQuotaGroups && rtState.quotaFetchInFlight) {
      quotaRowsHtml = `<div class="ag-qp-empty">${L('正在读取实时套餐限额…', 'Loading plan usage…')}</div>`;
    } else if (groups.length === 0) {
      quotaRowsHtml = `<div class="ag-qp-empty">${L('暂无可用套餐限额数据', 'No plan usage data available')}</div>`;
    } else {
      const grp = groups[selectedQuotaGroupIdx] || groups[0];
      const grpShort = localizeGroupShortName(grp.displayName);
      const sortBuckets = (list) =>
        (list || []).slice().sort((a, b) => {
          const rank = (w) => (w === '5h' ? 0 : w === 'daily' ? 1 : 2);
          return rank(String(a.window || '').toLowerCase()) - rank(String(b.window || '').toLowerCase());
        });
      const sortedBuckets = sortBuckets(grp.buckets);

      quotaRowsHtml = sortedBuckets
        .map((b) => {
          const rem = readBucketRemaining(b);
          const usedRaw = Math.max(0, Math.min(100, (1 - rem) * 100));
          const usedPctStr = formatQuotaUsedPctStr(usedRaw);
          const win = String(b.window || '').trim().toLowerCase();
          const title =
            win === '5h'
              ? L('5 小时限额', '5-hour limit')
              : win === 'weekly'
                ? L(`每周 · ${grpShort}`, `Weekly · ${grpShort}`)
                : win === 'daily'
                  ? L(`每日 · ${grpShort}`, `Daily · ${grpShort}`)
                  : b.displayName || L('使用限额', 'Usage limit');
          const resetTxt = formatResetLabel(b, usedRaw);
          const fillCol = barColorForPoolPct(usedRaw, grp.displayName, 75, 90);
          return `<div class="ag-qp-item">
            <div class="ag-qp-row">
              <span class="ag-qp-title">${escapeHtml(title)}</span>
              <span class="ag-qp-meta"><span class="ag-qp-reset">${escapeHtml(resetTxt)}</span><span class="ag-qp-pct">${usedPctStr}%</span></span>
            </div>
            <div class="ag-qp-track"><div class="ag-qp-fill" style="width:${usedRaw.toFixed(1)}%;background:${fillCol}"></div></div>
          </div>`;
        })
        .join('');
    }

    let otherPoolsHtml = '';
    if (groups.length > 1) {
      const sortBuckets = (list) =>
        (list || []).slice().sort((a, b) => {
          const rank = (w) => (w === '5h' ? 0 : w === 'daily' ? 1 : 2);
          return rank(String(a.window || '').toLowerCase()) - rank(String(b.window || '').toLowerCase());
        });
      const items = [];
      groups.forEach((g, idx) => {
        if (idx === selectedQuotaGroupIdx) return;
        const gShort = localizeGroupShortName(g.displayName);
        const dotCol = barColorForPoolPct(0, g.displayName);
        const rows = sortBuckets(g.buckets)
          .map((b) => {
            const usedRaw = Math.max(0, Math.min(100, (1 - readBucketRemaining(b)) * 100));
            const usedPctStr = formatQuotaUsedPctStr(usedRaw);
            const win = String(b.window || '').trim().toLowerCase();
            const winLbl =
              win === '5h' ? '5h' : win === 'weekly' ? L('每周', 'Weekly') : win === 'daily' ? L('每日', 'Daily') : b.displayName || '';
            const resetTxt = formatResetLabel(b, usedRaw);
            const fillCol = barColorForPoolPct(usedRaw, g.displayName, 75, 90);
            return `<div class="ag-qp-other-row">
              <span class="ag-qp-other-lbl">${escapeHtml(winLbl)}</span>
              <span class="ag-qp-other-reset">${escapeHtml(resetTxt)}</span>
              <span class="ag-qp-other-meter">
                <span class="ag-qp-other-track"><span class="ag-qp-other-fill" style="width:${usedRaw.toFixed(1)}%;background:${fillCol}"></span></span>
                <span class="ag-qp-other-pct">${usedPctStr}%</span>
              </span>
            </div>`;
          })
          .join('');
        items.push(`<button type="button" class="ag-qp-other-pool" data-ag-quota-jump="${idx}">
          <div class="ag-qp-other-hdr"><i class="ag-qp-other-dot" style="background:${dotCol}"></i><span>${escapeHtml(gShort)}</span></div>
          ${rows}
        </button>`);
      });
      if (items.length > 0) {
        otherPoolsHtml = `<div class="ag-qp-divider"></div><div class="ag-qp-other-pools">${items.join('')}</div>`;
      }
    }

    pop.innerHTML = `
      <div class="ag-qp-hdr">
        <span class="ag-qp-tier">${L('套餐使用限额', 'Plan usage')}${tierSuffix}</span>
        <button type="button" class="ag-qp-all" data-ag-quota-view-all="true">
          <span>${L('查看全部', 'View all')}</span>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9m0 0L8.8 4.3M12.5 8l-3.7 3.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="ag-qp-item">
        <div class="ag-qp-row">
          <span class="ag-qp-title-group">
            <span class="ag-qp-title">${L('当前上下文', 'Context window')}</span>
            ${compactBtnHtml}
          </span>
          <span class="ag-qp-meta"><span class="ag-qp-reset">${escapeHtml(ctxSub)}</span><span class="ag-qp-pct">${escapeHtml(ctxPctLabel)}</span></span>
        </div>
        <div class="ag-qp-track"><div class="ag-qp-fill"${fillCompactingAttr} style="width:${ctxPct}%;background:${ctxColor}"></div></div>
      </div>
      <div class="ag-qp-divider"></div>
      ${tabsHtml}
      <div class="ag-qp-group-list">${quotaRowsHtml}</div>
      ${otherPoolsHtml}
    `;
    positionQuotaPopover();
    if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      try { window.dispatchEvent(new CustomEvent('agy:quota-popover-rendered')); } catch {}
    }
  }

  function openQuotaPopover() {
    rtState.quotaPopoverOpen = true;
    selectedQuotaGroupIdx = -1;
    discoverQuotaService(true);
    const needForce = !rtState.cachedQuotaGroups || Date.now() - rtState.lastForceQuotaFetchTs > 5000;
    fetchQuotaSummary(needForce);
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) ring.setAttribute('data-open', 'true');
    const pop = ensureQuotaPopover();
    if (!rtState.cachedQuotaGroups && rtState.quotaFetchInFlight) {
      pop.setAttribute('data-loading-hold', 'true');
      cancelLater(quotaHoldTimer);
      quotaHoldTimer = later(() => {
        quotaHoldTimer = 0;
        pop.removeAttribute('data-loading-hold');
      }, 90);
    } else {
      pop.removeAttribute('data-loading-hold');
    }
    renderQuotaPopoverBody();
    pop.setAttribute('data-open', 'true');
    positionQuotaPopover();
  }

  function closeQuotaPopover() {
    rtState.quotaPopoverOpen = false;
    cancelLater(quotaHoldTimer);
    quotaHoldTimer = 0;
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) ring.setAttribute('data-open', 'false');
    const pop = document.getElementById('ag-claude-quota-popover');
    if (pop) {
      pop.removeAttribute('data-loading-hold');
      pop.setAttribute('data-open', 'false');
    }
  }

  function formatRingQuotaSummary(groups) {
    if (!Array.isArray(groups) || groups.length === 0) return '';
    const sortRank = (w) => (w === '5h' ? 0 : w === 'daily' ? 1 : 2);
    const parts = [];
    for (const g of groups) {
      const buckets = Array.isArray(g?.buckets) ? g.buckets : [];
      if (!buckets.length) continue;
      const gShort = localizeGroupShortName(g.displayName);
      const winParts = buckets
        .slice()
        .sort((a, b) => sortRank(String(a.window || '').toLowerCase()) - sortRank(String(b.window || '').toLowerCase()))
        .map((b) => {
          const usedRaw = Math.max(0, Math.min(100, (1 - readBucketRemaining(b)) * 100));
          const pctStr = formatQuotaUsedPctStr(usedRaw);
          const win = String(b.window || '').trim().toLowerCase();
          const winLbl = win === '5h' ? '5h' : win === 'weekly' ? L('周', 'Wk') : win === 'daily' ? L('日', 'Day') : '';
          return `${winLbl ? `${winLbl} ` : ''}${pctStr}%`;
        });
      if (winParts.length) parts.push(`${gShort} ${winParts.join(', ')}`);
    }
    return parts.join(' · ');
  }

  function updateComposerRingVisuals() {
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (!ring) return;
    const curCid = getActiveCascadeId();
    const hasCtx = Boolean(curCid && rtState.latestCtxState.cascadeId === curCid && rtState.latestCtxState.hasData);
    const compactStatus = detectCompactStatus(curCid);
    const { preUsed, limitLabel, summaryLabel, summaryPct } = extractCompactLabels(rtState.latestCtxState, curCid);
    const arc = ring.querySelector('.ag-ctx-ring-arc');
    const quotaSummary = formatRingQuotaSummary(rtState.cachedQuotaGroups);
    const quotaSuffix = quotaSummary ? ` · ${quotaSummary}` : '';

    if (compactStatus === 'compacting') {
      const pct = 18;
      if (arc) {
        const nextOff = (RING_CIRC * (1 - pct / 100)).toFixed(2);
        if (arc.style.strokeDashoffset !== nextOff) arc.style.strokeDashoffset = nextOff;
        if (arc.style.strokeOpacity !== '1') arc.style.strokeOpacity = '1';
      }
      if (ring.getAttribute('data-level') !== 'normal') ring.setAttribute('data-level', 'normal');
      if (ring.getAttribute('data-compact-state') !== 'compacting') ring.setAttribute('data-compact-state', 'compacting');
      const nextTitle = preUsed
        ? L(`正在压缩上下文 (原 ${preUsed})… · 点击查看状态`, `Compacting context (was ${preUsed})… · Click for status`)
        : L('正在压缩上下文… · 点击查看状态', 'Compacting context… · Click for status');
      if (ring.title !== nextTitle) ring.title = nextTitle;
      return;
    }

    if (compactStatus === 'compacted') {
      const pct = summaryPct > 0 ? Math.max(2, summaryPct) : hasCtx ? 2 : 0;
      if (arc) {
        const nextOff = (RING_CIRC * (1 - pct / 100)).toFixed(2);
        const nextOp = pct <= 0 ? '0' : '1';
        if (arc.style.strokeDashoffset !== nextOff) arc.style.strokeDashoffset = nextOff;
        if (arc.style.strokeOpacity !== nextOp) arc.style.strokeOpacity = nextOp;
      }
      if (ring.getAttribute('data-level') !== 'normal') ring.setAttribute('data-level', 'normal');
      if (ring.getAttribute('data-compact-state') !== 'compacted') ring.setAttribute('data-compact-state', 'compacted');
      const nextTitle =
        (summaryLabel && limitLabel
          ? L(
              `当前上下文 ${summaryLabel} / ${limitLabel} (${summaryPct}%${preUsed ? ` · 原 ${preUsed} 已压缩` : ''}) · 点击查看套餐限额`,
              `Context ${summaryLabel} / ${limitLabel} (${summaryPct}%${preUsed ? ` · compacted from ${preUsed}` : ''}) · Click for plan usage`
            )
          : L('当前上下文已压缩 · 点击查看套餐限额', 'Context compacted · Click for plan usage')) + quotaSuffix;
      if (ring.title !== nextTitle) ring.title = nextTitle;
      return;
    }

    if (ring.hasAttribute('data-compact-state')) ring.removeAttribute('data-compact-state');
    const pct = hasCtx ? rtState.latestCtxState.pct : 0;
    if (arc) {
      const offset = (RING_CIRC * (1 - pct / 100)).toFixed(2);
      const nextOp = pct <= 0 ? '0' : '1';
      if (arc.style.strokeDashoffset !== offset) arc.style.strokeDashoffset = offset;
      if (arc.style.strokeOpacity !== nextOp) arc.style.strokeOpacity = nextOp;
      let level = 'normal';
      if (pct >= 85) level = 'crit';
      else if (pct >= 70) level = 'warn';
      if (ring.getAttribute('data-level') !== level) ring.setAttribute('data-level', level);
    }
    const nextTitle =
      (hasCtx
        ? L(
            `当前上下文 ${rtState.latestCtxState.ratioText} (${pct}%) · 点击查看套餐限额`,
            `Context ${rtState.latestCtxState.ratioText} (${pct}%) · Click for plan usage`
          )
        : L('当前会话暂无上下文消耗 · 点击查看套餐限额', 'No context usage yet · Click for plan usage')) + quotaSuffix;
    if (ring.title !== nextTitle) ring.title = nextTitle;
  }

  function ensureComposerContextRing() {
    const inputBox = getActiveInputBox();
    if (!inputBox) return;

    /* On the Home `/` screen, the composer has a top project/location row that ALSO matches
       `div.flex.min-w-0.flex-1.items-center`; anchor off `model-selector-trigger` first so the
       ring always mounts beside the model picker in the bottom toolbar instead of top-right. */
    const modelBtn = inputBox.querySelector('button[data-testid="model-selector-trigger"]');
    let modelWrap = null;
    if (modelBtn) {
      const bar = modelBtn.closest('div.flex.min-w-0.flex-1.items-center') || modelBtn.parentElement;
      if (bar) {
        let cur = modelBtn;
        while (cur && cur.parentElement && cur.parentElement !== bar) cur = cur.parentElement;
        if (cur && cur.parentElement === bar) modelWrap = cur;
      }
    }
    if (!modelWrap) {
      const leftGroup = inputBox.querySelector('div.flex.min-w-0.flex-1.items-center');
      if (leftGroup) {
        modelWrap = Array.from(leftGroup.children).find(
          (ch) => ch.tagName === 'DIV' && ch.id !== 'ag-live-metrics-pill' && ch.querySelector('button')
        );
      }
    }
    if (!modelWrap) return;

    let ring = document.getElementById('ag-claude-ctx-ring');
    let newlyInserted = false;
    if (!ring) {
      newlyInserted = true;
      ring = document.createElement('button');
      ring.id = 'ag-claude-ctx-ring';
      ring.type = 'button';
      ring.setAttribute('data-no-drag', '');
      ring.setAttribute('data-ag-i18n-ignore', '1');
      ring.setAttribute('data-open', rtState.quotaPopoverOpen ? 'true' : 'false');
      ring.setAttribute('aria-label', L('上下文与套餐使用限额', 'Context window & plan usage'));
      ring.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">' +
        '<circle class="ag-ctx-ring-track" cx="10" cy="10" r="7" fill="none" stroke-width="2.15"/>' +
        `<circle class="ag-ctx-ring-arc" cx="10" cy="10" r="7" fill="none" stroke-width="2.15" stroke-linecap="round" stroke-dasharray="${RING_CIRC.toFixed(
          2
        )}" stroke-dashoffset="${RING_CIRC.toFixed(2)}"/>` +
        '</svg>';
      ring.addEventListener('pointerenter', () => {
        if (!rtState.quotaPopoverOpen && (!rtState.cachedQuotaGroups || Date.now() - rtState.lastForceQuotaFetchTs > 10000)) {
          fetchQuotaSummary(true);
        }
      });
      ring.addEventListener('click', (e) => {
        e.stopPropagation();
        if (rtState.quotaPopoverOpen) {
          closeQuotaPopover();
        } else {
          openQuotaPopover();
        }
      });
    }

    if (modelWrap.nextElementSibling !== ring) {
      modelWrap.insertAdjacentElement('afterend', ring);
      newlyInserted = true;
    }

    updateComposerRingVisuals();

    if (!quotaWarmupDone && discoverQuotaService(false)) {
      quotaWarmupDone = true;
      later(() => {
        if (!rtState.disposed && FEAT.contextRing && (!rtState.cachedQuotaGroups || Date.now() - rtState.lastForceQuotaFetchTs > 10000)) {
          fetchQuotaSummary(true);
        }
      }, 120);
    }

    if (newlyInserted && typeof window.__ag_ensure_metrics_pill_fn === 'function') {
      frame(() => {
        if (typeof window.__ag_ensure_metrics_pill_fn === 'function') {
          window.__ag_ensure_metrics_pill_fn(true);
        }
      });
    }
  }

  const onOutsidePopoverPointerDown = (e) => {
    if (!rtState.quotaPopoverOpen) return;
    const pop = document.getElementById('ag-claude-quota-popover');
    const ring = document.getElementById('ag-claude-ctx-ring');
    if ((pop && pop.contains(e.target)) || (ring && ring.contains(e.target))) return;
    closeQuotaPopover();
  };
  const onPopoverKeyDown = (e) => {
    if (rtState.quotaPopoverOpen && e.key === 'Escape') {
      closeQuotaPopover();
    }
  };
  const onWindowResizePopover = () => {
    if (rtState.quotaPopoverOpen) positionQuotaPopover();
  };
  document.addEventListener('pointerdown', onOutsidePopoverPointerDown, true);
  document.addEventListener('keydown', onPopoverKeyDown, true);
  window.addEventListener('resize', onWindowResizePopover);


  function sync() {
    if (rtState.disposed) return;
    if (FEAT.contextRing || FEAT.overviewPanel) {
      ensureMetricsWrapped();
      syncCompactVisualState(false);
    }
    if (FEAT.contextRing) {
      ensureComposerContextRing();
    } else {
      const oldRing = document.getElementById('ag-claude-ctx-ring');
      if (oldRing) oldRing.remove();
      closeQuotaPopover();
    }
  }

  function dispose() {
    if (compactPollTimerId) {
      clearInterval(compactPollTimerId);
      compactPollTimerId = null;
    }
    compactedMetaByCid.clear();
    compactedStaleSigByCid.clear();
    document.removeEventListener('pointerdown', onOutsidePopoverPointerDown, true);
    document.removeEventListener('keydown', onPopoverKeyDown, true);
    document.removeEventListener('mouseenter', onMetricsPillMouseEnter, true);
    document.removeEventListener('mouseleave', onMetricsPillMouseLeave, true);
    document.removeEventListener('click', onMetricsPillClick, true);
    window.removeEventListener('resize', onWindowResizePopover);
    if (autoQuotaRefreshTimer) {
      cancelLater(autoQuotaRefreshTimer);
      autoQuotaRefreshTimer = 0;
    }
    const ttEl = document.getElementById('ag-live-metrics-tooltip');
    if (ttEl) {
      ttEl.removeAttribute('data-ag-pinned');
      ttEl.removeAttribute('data-visible');
    }
    if (ownMetricsWrapper && window.__ag_render_metrics === ownMetricsWrapper) {
      window.__ag_render_metrics = ownMetricsWrapper.__agOrig;
      if (window.__ag_last_metrics && typeof window.__ag_last_metrics === 'object') {
        if (window.__ag_last_metrics.__agOrigInlineHtml !== undefined) {
          window.__ag_last_metrics.inlineHtml = window.__ag_last_metrics.__agOrigInlineHtml;
        }
        if (window.__ag_last_metrics.__agOrigTooltipHtml !== undefined) {
          window.__ag_last_metrics.tooltipHtml = window.__ag_last_metrics.__agOrigTooltipHtml;
        }
      }
      if (typeof window.__ag_render_metrics === 'function' && window.__ag_last_metrics) {
        try {
          window.__ag_render_metrics(window.__ag_last_metrics);
        } catch {}
      }
    }
    document.querySelectorAll('#ag-claude-ctx-ring, #ag-claude-quota-popover').forEach((el) => el.remove());
  }

  return {
    SVG_COMPACT_ICON,
    SVG_COMPACT_DONE,
    sync,
    parseAndSlimMetricsPayload,
    cacheTierForRate,
    detectCompactStatus,
    triggerConversationCompact,
    ensureMetricsWrapped,
    syncCompactVisualState,
    ensureComposerContextRing,
    closeQuotaPopover,
    renderQuotaPopoverBody,
    updateComposerRingVisuals,
    discoverAgentInputProps,
    getActiveCascadeId,
    isPaneCurrentlyRunning,
    extractCompactLabels,
    fmtCompactTokens,
    discoverQuotaService,
    isOverviewPanelVisible,
    scheduleAutoQuotaRefresh,
    fetchQuotaSummary,
    formatResetLabel,
    localizeGroupShortName,
    detectDefaultGroupIndex,
    formatQuotaUsedPctStr,
    dispose,
  };
}
