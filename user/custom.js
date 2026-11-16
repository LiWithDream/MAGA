/**
 * antigravity-claude-ux — user/custom.js
 * Non-invasive runtime UX extension for Google Antigravity Desktop 2.0:
 * 1. Unfolds outer `worked-for-collapsible` end-of-turn wrapper so interleaved narration & tool summaries stay inline.
 * 2. Adds smooth 190ms collapse transition when React unmounts finished `tool-group-collapsible` panels.
 * 3. Renders an in-place reactive Claude `TodoWrite` checklist card (`- [ ]` pending / `- [/]` active / `- [x]` completed),
 *    deduplicating and merging all checklist updates within the same turn into a single card.
 * 4. Attaches orbiting terracotta dots + live `1s / 2s...` elapsed timer exclusively to the actively executing step row.
 */
(function () {
  const userToggled = new WeakSet();
  const openSnapshots = new WeakMap();
  const runningTimers = new WeakMap();
  const paneLastActiveTs = new WeakMap();
  const paneUndockTimers = new WeakMap();
  let timerIntervalId = null;
  let rafPending = false;

  const SVG_PENDING =
    '<svg class="ag-todo-ico ag-todo-pending" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.6" stroke="currentColor" stroke-width="1.4"/></svg>';
  const SVG_ACTIVE =
    '<svg class="ag-todo-ico ag-todo-active" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.6" stroke="currentColor" stroke-opacity="0.22" stroke-width="1.5"/><path d="M8 1.4a6.6 6.6 0 0 1 6.6 6.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const SVG_DONE =
    '<svg class="ag-todo-ico ag-todo-done" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="currentColor"/><path class="ag-todo-done-check" d="M5.1 8.15l1.95 1.95 3.95-4.1" stroke="#FFFFFF" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const PAST_LABEL_RE = /^(?:Explored|Ran\b|Edited\b|Done\b|已探索|已运行|已编辑|已完成)/i;

  const onDocClick = (e) => {
    if (!e.isTrusted) return;
    const btn = e.target && e.target.closest && e.target.closest('button[data-testid="worked-for-collapsible"]');
    if (btn) userToggled.add(btn);
  };
  document.addEventListener('click', onDocClick, true);

  function captureOpenToolPanels() {
    const openBtns = document.querySelectorAll('button[data-testid="tool-group-collapsible"][aria-expanded="true"]');
    for (const btn of openBtns) {
      const panel = btn.nextElementSibling;
      if (!panel || panel.classList.contains('ag-collapse-ghost')) continue;
      const rect = panel.getBoundingClientRect();
      if (rect.height > 8) {
        openSnapshots.set(btn, {
          height: Math.min(rect.height, 360),
          html: panel.innerHTML,
          cls: panel.className
        });
      }
    }
  }

  function animateCollapseIfNeeded(btn) {
    const snap = openSnapshots.get(btn);
    if (!snap) return;
    openSnapshots.delete(btn);
    if (btn.getAttribute('aria-expanded') !== 'false') return;
    const parent = btn.parentElement;
    if (!parent || parent.querySelector(':scope > .ag-collapse-ghost')) return;

    const ghost = document.createElement('div');
    ghost.className = `${snap.cls} ag-collapse-ghost`;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.innerHTML = snap.html;
    ghost.style.cssText = [
      `max-height: ${snap.height}px`,
      'opacity: 1',
      'overflow: hidden',
      'pointer-events: none',
      'transform: translateY(0)',
      'transition: max-height 190ms cubic-bezier(0.16, 1, 0.3, 1), opacity 150ms ease-out, transform 190ms cubic-bezier(0.16, 1, 0.3, 1), margin 190ms ease'
    ].join(';');
    btn.insertAdjacentElement('afterend', ghost);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ghost.style.maxHeight = '0px';
        ghost.style.opacity = '0';
        ghost.style.transform = 'translateY(-4px)';
        ghost.style.marginTop = '0px';
        ghost.style.marginBottom = '0px';
      });
    });

    const cleanup = () => {
      if (ghost.parentNode) ghost.remove();
    };
    ghost.addEventListener('transitionend', cleanup, { once: true });
    setTimeout(cleanup, 240);
  }

  function parseTodoUl(ul) {
    if (!ul.classList || !ul.classList.contains('contains-task-list')) return null;
    if (ul.closest('pre, code, [data-testid="user-input-step"], .agy-user-bubble')) return null;
    if (ul.closest('[data-testid="tool-group-collapsible"] + div')) return null;

    const lis = Array.from(ul.children).filter((el) => el.tagName === 'LI' && el.classList.contains('task-list-item'));
    if (lis.length < 2 || lis.length > 15) return null;

    const items = [];
    for (const li of lis) {
      const iconBox = li.querySelector(':scope > div:first-child');
      let status = 'pending';
      if (li.classList.contains('task-checked')) {
        status = 'completed';
      } else if (iconBox && iconBox.classList.contains('bg-primary')) {
        status = 'in_progress';
      }
      const clone = li.cloneNode(true);
      const firstDiv = clone.querySelector(':scope > div:first-child');
      if (firstDiv) firstDiv.remove();
      const checkedSpan = clone.querySelector(':scope > span.task-checked-content');
      const labelHtml = (checkedSpan ? checkedSpan.innerHTML : clone.innerHTML).trim();
      if (!labelHtml) return null;
      items.push({ status, html: labelHtml });
    }
    return items;
  }

  function normalizeTodoText(html) {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isChecklistEvolution(prevItems, nextItems) {
    if (!prevItems || !nextItems) return false;
    const a = prevItems.map((it) => normalizeTodoText(it.html));
    const b = nextItems.map((it) => normalizeTodoText(it.html));
    let matches = 0;
    for (const txtB of b) {
      if (!txtB) continue;
      const hit = a.some(
        (txtA) =>
          txtA === txtB ||
          (txtA.length >= 6 && txtB.length >= 6 && (txtA.includes(txtB.slice(0, 6)) || txtB.includes(txtA.slice(0, 6))))
      );
      if (hit) matches += 1;
    }
    return matches >= Math.max(1, Math.ceil(Math.min(a.length, b.length) * 0.4));
  }

  function iconForStatus(status) {
    return status === 'completed' ? SVG_DONE : status === 'in_progress' ? SVG_ACTIVE : SVG_PENDING;
  }

  function patchCardDom(card, items) {
    const sig = JSON.stringify(items);
    if (card.getAttribute('data-ag-todo-sig') === sig) return;
    card.setAttribute('data-ag-todo-sig', sig);

    const existingRows = Array.from(card.children).filter((el) => el.classList.contains('ag-claude-todo-row'));
    if (existingRows.length === items.length) {
      for (let i = 0; i < items.length; i++) {
        const row = existingRows[i];
        const it = items[i];
        const prevStatus = row.getAttribute('data-status');
        if (prevStatus !== it.status) {
          row.setAttribute('data-status', it.status);
          const ico = row.querySelector(':scope > .ag-todo-ico');
          if (ico) {
            ico.outerHTML = iconForStatus(it.status);
          }
        }
        const lbl = row.querySelector(':scope > .ag-claude-todo-label');
        if (lbl && lbl.innerHTML !== it.html) {
          lbl.innerHTML = it.html;
        }
      }
      return;
    }

    card.innerHTML = items
      .map(
        (it) =>
          `<div class="ag-claude-todo-row" data-status="${it.status}">${iconForStatus(it.status)}<span class="ag-claude-todo-label">${it.html}</span></div>`
      )
      .join('');
  }

  function markMergedUl(ul) {
    ul.removeAttribute('data-ag-todo-primary');
    ul.setAttribute('data-ag-todo-merged', 'true');
    if (ul.nextElementSibling && ul.nextElementSibling.hasAttribute('data-ag-todo-mount')) {
      ul.nextElementSibling.remove();
    }
    const pWrap = ul.parentElement;
    if (pWrap && pWrap.children.length === 1) {
      pWrap.setAttribute('data-ag-todo-empty-wrap', 'true');
    }
  }

  function renderInlineTodoCard(anchorUl, items) {
    anchorUl.setAttribute('data-ag-todo-primary', 'true');
    anchorUl.removeAttribute('data-ag-todo-merged');
    let card = anchorUl.nextElementSibling;
    if (!card || !card.hasAttribute('data-ag-todo-mount')) {
      card = document.createElement('div');
      card.className = 'ag-claude-todo-card';
      card.setAttribute('data-ag-todo-mount', 'true');
      anchorUl.insertAdjacentElement('afterend', card);
    }
    patchCardDom(card, items);
  }

  function findPaneRoot(el) {
    let cur = el;
    for (let i = 0; i < 14 && cur; i++, cur = cur.parentElement) {
      if (
        cur.querySelector &&
        cur.querySelector('[id="antigravity.agentSidePanelInputBox"]') &&
        cur.querySelector('[data-testid="agent-response"]')
      ) {
        return cur;
      }
    }
    return null;
  }

  function isPaneActivelyGenerating(pane) {
    if (!pane) return false;
    const inputBox = pane.querySelector('[id="antigravity.agentSidePanelInputBox"]');
    if (!inputBox) return false;
    const hasCancel = Boolean(inputBox.querySelector('button[data-testid="input-cancel-button"]'));
    const now = Date.now();
    if (hasCancel) {
      paneLastActiveTs.set(pane, now);
      const pendingTimer = paneUndockTimers.get(pane);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        paneUndockTimers.delete(pane);
      }
      return true;
    }
    const lastTs = paneLastActiveTs.get(pane) || 0;
    if (now - lastTs < 280) {
      if (!paneUndockTimers.has(pane)) {
        const tid = setTimeout(() => {
          paneUndockTimers.delete(pane);
          scheduleSync();
        }, 300);
        paneUndockTimers.set(pane, tid);
      }
      return true;
    }
    return false;
  }

  function renderLiveDockedTodoCard(pane, items) {
    const inputBox = pane.querySelector('[id="antigravity.agentSidePanelInputBox"]');
    if (!inputBox || !inputBox.parentElement) return false;
    let dock = inputBox.parentElement.querySelector(':scope > [data-ag-todo-dock="true"]');
    if (!dock) {
      dock = document.createElement('div');
      dock.className = 'ag-claude-todo-live-dock';
      dock.setAttribute('data-ag-todo-dock', 'true');
      inputBox.insertAdjacentElement('beforebegin', dock);
    } else if (dock.nextElementSibling !== inputBox) {
      inputBox.insertAdjacentElement('beforebegin', dock);
    }
    let card = dock.querySelector(':scope > .ag-claude-todo-card');
    if (!card) {
      card = document.createElement('div');
      card.className = 'ag-claude-todo-card';
      card.setAttribute('data-ag-todo-mount', 'true');
      dock.appendChild(card);
    }
    patchCardDom(card, items);
    return dock;
  }

  function syncTodoCards() {
    const allTaskUls = document.querySelectorAll('ul.contains-task-list');
    const byTurn = new Map();
    let orphanIdx = 0;

    for (const ul of allTaskUls) {
      const items = parseTodoUl(ul);
      if (!items) continue;
      const turnEl = ul.closest('[data-testid="agent-response"]') || `orphan-${orphanIdx++}`;
      let list = byTurn.get(turnEl);
      if (!list) {
        list = [];
        byTurn.set(turnEl, list);
      }
      list.push({ ul, items });
    }

    const activeDocks = new Set();

    for (const [turnKey, entries] of byTurn.entries()) {
      const clusters = [];
      for (const entry of entries) {
        const lastCluster = clusters[clusters.length - 1];
        if (lastCluster && isChecklistEvolution(lastCluster.items, entry.items)) {
          lastCluster.lists.push(entry.ul);
          lastCluster.items = entry.items;
        } else {
          clusters.push({ lists: [entry.ul], items: entry.items });
        }
      }

      const isElementTurn = typeof turnKey !== 'string';
      const pane = isElementTurn ? findPaneRoot(turnKey) : null;
      let isLiveTurn = false;
      if (pane && isPaneActivelyGenerating(pane)) {
        const paneTurns = pane.querySelectorAll('[data-testid="agent-response"]');
        const latestPaneTurn = paneTurns.length ? paneTurns[paneTurns.length - 1] : null;
        if (latestPaneTurn === turnKey) {
          isLiveTurn = true;
        }
      }

      for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        const isDockedLiveCluster = isLiveTurn && i === clusters.length - 1;
        const mountedDock = isDockedLiveCluster ? renderLiveDockedTodoCard(pane, cluster.items) : null;

        if (mountedDock) {
          activeDocks.add(mountedDock);
          for (const ul of cluster.lists) {
            markMergedUl(ul);
          }
        } else {
          /* 轮次结束后停靠在该轮最后一次清单节点处（紧贴总结上方，不再缩回轮次最顶端） */
          const anchorUl = cluster.lists[cluster.lists.length - 1];
          for (let j = 0; j < cluster.lists.length - 1; j++) {
            markMergedUl(cluster.lists[j]);
          }
          renderInlineTodoCard(anchorUl, cluster.items);
        }
      }
    }

    const existingDocks = document.querySelectorAll('[data-ag-todo-dock="true"]');
    for (const dock of existingDocks) {
      if (!activeDocks.has(dock)) {
        dock.remove();
      }
    }
  }

  function isActivelyRunningRow(el, isLastCandidate, turnGenerating) {
    if (!turnGenerating || !isLastCandidate) return false;
    if (el.getAttribute('data-testid') === 'ephemeral-tool-status') return true;
    const span = el.querySelector(':scope > span[title], :scope > span[data-ag-orig-title]');
    const raw =
      (span && (span.getAttribute('data-ag-orig-title') || span.getAttribute('title'))) ||
      el.getAttribute('data-ag-orig-aria-label') ||
      el.getAttribute('aria-label') ||
      el.textContent ||
      '';
    return !PAST_LABEL_RE.test(raw.trim());
  }

  function syncRunningToolIndicators() {
    const candidates = Array.from(
      document.querySelectorAll('button[data-testid="tool-group-collapsible"], [data-testid="ephemeral-tool-status"]')
    );
    const turnGenerating = Boolean(document.querySelector('button[data-testid="input-cancel-button"]'));
    let activeCount = 0;
    const now = Date.now();

    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const isLast = i === candidates.length - 1;
      const isRunning = isActivelyRunningRow(el, isLast, turnGenerating);
      let orbit = el.querySelector(':scope > .ag-orbit-dots');
      let timerEl = el.querySelector(':scope > .ag-elapsed-timer');

      if (isRunning) {
        activeCount += 1;
        let startTs = runningTimers.get(el);
        if (!startTs) {
          startTs = now;
          runningTimers.set(el, startTs);
        }
        if (!orbit) {
          orbit = document.createElement('span');
          orbit.className = 'ag-orbit-dots';
          orbit.setAttribute('aria-hidden', 'true');
          orbit.innerHTML = '<i></i><i></i>';
          el.insertBefore(orbit, el.firstChild);
        }
        const secs = Math.max(1, Math.floor((now - startTs) / 1000));
        if (!timerEl) {
          timerEl = document.createElement('span');
          timerEl.className = 'ag-elapsed-timer';
          const chevron = el.querySelector(':scope > svg');
          if (chevron) {
            el.insertBefore(timerEl, chevron);
          } else {
            el.appendChild(timerEl);
          }
        }
        const txt = `${secs}s`;
        if (timerEl.textContent !== txt) timerEl.textContent = txt;
      } else {
        if (orbit) orbit.remove();
        if (timerEl) timerEl.remove();
        runningTimers.delete(el);
      }
    }

    if (activeCount > 0 && !timerIntervalId) {
      timerIntervalId = setInterval(syncRunningToolIndicators, 1000);
    } else if (activeCount === 0 && timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
  }

  function syncStepStream() {
    rafPending = false;
    const workedBtns = document.querySelectorAll('button[data-testid="worked-for-collapsible"]');
    for (const btn of workedBtns) {
      const wrap = btn.parentElement;
      if (wrap && !wrap.hasAttribute('data-ag-inline-stream')) {
        wrap.setAttribute('data-ag-inline-stream', 'true');
      }
      if (btn.getAttribute('aria-expanded') === 'false' && !userToggled.has(btn)) {
        btn.click();
      }
    }
    captureOpenToolPanels();
    syncTodoCards();
    syncRunningToolIndicators();
    ensureComposerContextRing();
  }

  /* ==========================================================================
   * 5. Claude-Style Composer Context Ring + Live Plan Quota Popover + Slim Pill
   *    - Strips `Ctx ...` & `Out ...` from center `#ag-live-metrics-pill` (keeps Speed + Time only)
   *    - Mounts radial context progress ring right beside the Model Selector
   *    - Clicking opens real-time Usage Popover (`retrieveUserQuotaSummary` 5h & weekly buckets)
   * ========================================================================== */
  const RING_CIRC = 2 * Math.PI * 7;
  let cachedQuotaSvc = null;
  let cachedUserTierName = '';
  let cachedQuotaGroups = null;
  let lastQuotaFetchTs = 0;
  let quotaFetchInFlight = null;
  let quotaPopoverOpen = false;
  let selectedQuotaGroupIdx = -1;
  let latestCtxState = { pct: 0, ratioText: '', outText: '', hasData: false, cascadeId: '' };

  function getActiveCascadeId() {
    const m = (window.location.pathname || '').match(/^\/c\/([0-9a-f-]+)/i);
    return m ? m[1] : '';
  }

  function parseAndSlimMetricsPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const rawInline = payload.__agOrigInlineHtml || payload.inlineHtml || '';
    const curCid = getActiveCascadeId();

    if (payload.hasData && rawInline && (!curCid || payload.cascadeId === curCid)) {
      const tmp = document.createElement('div');
      tmp.innerHTML = rawInline;
      let ratioText = '';
      let pct = 0;
      let outText = '';

      const kids = Array.from(tmp.children);
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        const txt = (el.textContent || '').trim();
        if (/^Ctx\b/i.test(txt)) {
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
        }
      }
      while (tmp.firstElementChild && tmp.firstElementChild.classList.contains('ag-sep')) {
        tmp.firstElementChild.remove();
      }

      latestCtxState = {
        pct,
        ratioText,
        outText,
        hasData: Boolean(ratioText),
        cascadeId: payload.cascadeId || curCid
      };

      const slimmed = Object.assign({}, payload, {
        __agOrigInlineHtml: rawInline,
        inlineHtml: tmp.innerHTML
      });
      return slimmed;
    }

    if (!curCid || payload.cascadeId !== curCid || !payload.hasData) {
      latestCtxState = { pct: 0, ratioText: '', outText: '', hasData: false, cascadeId: curCid };
    }
    return payload;
  }

  const origRenderMetrics = typeof window.__ag_render_metrics === 'function' ? window.__ag_render_metrics : null;
  if (origRenderMetrics && !origRenderMetrics.__agSlimWrapped) {
    const wrappedRender = function (payload) {
      const slimPayload = parseAndSlimMetricsPayload(payload);
      const ret = origRenderMetrics.call(this, slimPayload);
      if (payload && payload.__agOrigInlineHtml === undefined && window.__ag_last_metrics === slimPayload) {
        window.__ag_last_metrics.__agOrigInlineHtml = payload.inlineHtml;
      }
      updateComposerRingVisuals();
      if (quotaPopoverOpen) renderQuotaPopoverBody();
      return ret;
    };
    wrappedRender.__agSlimWrapped = true;
    wrappedRender.__agOrig = origRenderMetrics;
    window.__ag_render_metrics = wrappedRender;

    if (window.__ag_last_metrics) {
      window.__ag_render_metrics(window.__ag_last_metrics);
    }
  }

  function discoverQuotaService() {
    if (cachedQuotaSvc) return cachedQuotaSvc;
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!inputBox) return null;
    const fk = Object.keys(inputBox).find((k) => k.startsWith('__reactFiber$'));
    let f = fk ? inputBox[fk] : null;
    const seen = new Set();

    const walkObj = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 4 || seen.has(obj)) return;
      seen.add(obj);
      try {
        if (!cachedQuotaSvc && typeof obj.retrieveUserQuotaSummary === 'function') {
          cachedQuotaSvc = obj;
        }
        if (!cachedUserTierName && obj.userTier && typeof obj.userTier.name === 'string') {
          cachedUserTierName = obj.userTier.name;
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
      if (cachedQuotaSvc && cachedUserTierName) break;
    }
    return cachedQuotaSvc;
  }

  function fetchQuotaSummary(forceRefresh = false) {
    const svc = discoverQuotaService();
    if (!svc) return Promise.resolve(cachedQuotaGroups || []);
    const now = Date.now();
    if (!forceRefresh && cachedQuotaGroups && now - lastQuotaFetchTs < 15000) {
      return Promise.resolve(cachedQuotaGroups);
    }
    if (quotaFetchInFlight) return quotaFetchInFlight;

    quotaFetchInFlight = Promise.resolve(svc.retrieveUserQuotaSummary(Boolean(forceRefresh)))
      .then((res) => {
        const rawGroups = (res && res.response && res.response.groups) || (res && res.groups) || [];
        cachedQuotaGroups = rawGroups.filter((g) => g && Array.isArray(g.buckets) && g.buckets.length > 0);
        lastQuotaFetchTs = Date.now();
        if (quotaPopoverOpen) renderQuotaPopoverBody();
        return cachedQuotaGroups;
      })
      .catch(() => cachedQuotaGroups || [])
      .finally(() => {
        quotaFetchInFlight = null;
      });
    return quotaFetchInFlight;
  }

  function formatResetLabel(bucket, usedPct) {
    const win = String(bucket.window || '').trim().toLowerCase();
    const secStr = bucket.resetTime && bucket.resetTime.seconds !== undefined ? String(bucket.resetTime.seconds) : '';
    const resetMs = secStr ? Number(secStr) * 1000 : 0;

    if (win === '5h' && usedPct === 0 && !bucket.description) {
      return '从发送第一条消息时起算';
    }
    if (!resetMs || Number.isNaN(resetMs)) {
      return usedPct === 0 ? '从发送第一条消息时起算' : '';
    }
    const diffMs = resetMs - Date.now();
    if (diffMs <= 60000) return '即将重置';

    if (win === 'weekly') {
      const dt = new Date(resetMs);
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const hh = String(dt.getHours()).padStart(2, '0');
      const mm = String(dt.getMinutes()).padStart(2, '0');
      return `${weekdays[dt.getDay()]} ${hh}:${mm} 重置`;
    }

    const totalMins = Math.floor(diffMs / 60000);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hrs > 0) {
      return mins > 0 ? `${hrs} 小时 ${mins} 分后重置` : `${hrs} 小时后重置`;
    }
    return `${Math.max(1, mins)} 分钟后重置`;
  }

  function localizeGroupShortName(name) {
    const s = String(name || '').trim();
    if (/gemini/i.test(s)) return 'Gemini 模型';
    if (/claude/i.test(s) && /gpt/i.test(s)) return 'Claude / GPT';
    if (/claude/i.test(s)) return 'Claude 模型';
    return s || '全部模型';
  }

  function detectDefaultGroupIndex(groups) {
    if (!groups || groups.length <= 1) return 0;
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    const txt = inputBox ? inputBox.textContent || '' : '';
    const want3p = /claude|sonnet|opus|gpt/i.test(txt);
    const idx = groups.findIndex((g) =>
      want3p ? /claude|gpt/i.test(g.displayName || '') : /gemini/i.test(g.displayName || '')
    );
    return idx >= 0 ? idx : 0;
  }

  function barColorForPct(pct, warnAt = 70, critAt = 85) {
    if (pct >= critAt) return '#DC2626';
    if (pct >= warnAt) return '#D97706';
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
      const tabBtn = e.target.closest('[data-ag-quota-tab]');
      if (tabBtn) {
        e.stopPropagation();
        selectedQuotaGroupIdx = Number(tabBtn.getAttribute('data-ag-quota-tab')) || 0;
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
              requestAnimationFrame(jumpModels);
            }
          };
          requestAnimationFrame(jumpModels);
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

  function renderQuotaPopoverBody() {
    const pop = ensureQuotaPopover();
    const curCid = getActiveCascadeId();
    const hasCtx = Boolean(curCid && latestCtxState.hasData && latestCtxState.cascadeId === curCid);
    const ctxPct = hasCtx ? latestCtxState.pct : 0;
    const ctxSub = hasCtx
      ? `${latestCtxState.ratioText}${latestCtxState.outText ? ` · ${latestCtxState.outText}` : ''}`
      : '当前会话暂无消耗';

    discoverQuotaService();
    const tierShort = cachedUserTierName
      ? cachedUserTierName.replace(/^Google\s+AI\s+/i, '').trim() || cachedUserTierName
      : 'Pro';

    const groups = cachedQuotaGroups || [];
    if (selectedQuotaGroupIdx < 0 || selectedQuotaGroupIdx >= groups.length) {
      selectedQuotaGroupIdx = detectDefaultGroupIndex(groups);
    }

    let tabsHtml = '';
    if (groups.length > 1) {
      tabsHtml = `<div class="ag-qp-tabs">${groups
        .map((g, idx) => {
          const active = idx === selectedQuotaGroupIdx ? ' data-active="true"' : '';
          return `<button type="button" class="ag-qp-tab" data-ag-quota-tab="${idx}"${active}>${localizeGroupShortName(
            g.displayName
          )}</button>`;
        })
        .join('')}</div>`;
    }

    let quotaRowsHtml = '';
    if (!cachedQuotaGroups && quotaFetchInFlight) {
      quotaRowsHtml = '<div class="ag-qp-empty">正在读取实时套餐限额…</div>';
    } else if (groups.length === 0) {
      quotaRowsHtml = '<div class="ag-qp-empty">暂无可用套餐限额数据</div>';
    } else {
      const grp = groups[selectedQuotaGroupIdx] || groups[0];
      const grpShort = localizeGroupShortName(grp.displayName);
      const sortedBuckets = (grp.buckets || []).slice().sort((a, b) => {
        const rank = (w) => (w === '5h' ? 0 : w === 'daily' ? 1 : 2);
        return rank(String(a.window || '').toLowerCase()) - rank(String(b.window || '').toLowerCase());
      });

      quotaRowsHtml = sortedBuckets
        .map((b) => {
          const rem =
            b.remaining && b.remaining.case === 'remainingFraction' && typeof b.remaining.value === 'number'
              ? b.remaining.value
              : typeof b.remainingFraction === 'number'
                ? b.remainingFraction
                : 1;
          const usedPct = Math.max(0, Math.min(100, Math.round((1 - rem) * 100)));
          const win = String(b.window || '').trim().toLowerCase();
          const title =
            win === '5h'
              ? '5 小时限额'
              : win === 'weekly'
                ? `每周 · ${grpShort}`
                : win === 'daily'
                  ? `每日 · ${grpShort}`
                  : b.displayName || '使用限额';
          const resetTxt = formatResetLabel(b, usedPct);
          const fillCol = barColorForPct(usedPct, 75, 90);
          return `<div class="ag-qp-item">
            <div class="ag-qp-row">
              <span class="ag-qp-title">${title}</span>
              <span class="ag-qp-meta"><span class="ag-qp-reset">${resetTxt}</span><span class="ag-qp-pct">${usedPct}%</span></span>
            </div>
            <div class="ag-qp-track"><div class="ag-qp-fill" style="width:${usedPct}%;background:${fillCol}"></div></div>
          </div>`;
        })
        .join('');
    }

    const ctxColor = barColorForPct(ctxPct, 70, 85);
    pop.innerHTML = `
      <div class="ag-qp-hdr">
        <span class="ag-qp-tier">套餐使用限额 · ${tierShort}</span>
        <button type="button" class="ag-qp-all" data-ag-quota-view-all="true">
          <span>查看全部</span>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9m0 0L8.8 4.3M12.5 8l-3.7 3.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="ag-qp-item">
        <div class="ag-qp-row">
          <span class="ag-qp-title ag-qp-title-strong">当前上下文</span>
          <span class="ag-qp-meta"><span class="ag-qp-reset">${ctxSub}</span><span class="ag-qp-pct ag-qp-pct-strong">${ctxPct}%</span></span>
        </div>
        <div class="ag-qp-track"><div class="ag-qp-fill" style="width:${ctxPct}%;background:${ctxColor}"></div></div>
      </div>
      <div class="ag-qp-divider"></div>
      ${tabsHtml}
      <div class="ag-qp-group-list">${quotaRowsHtml}</div>
    `;
    positionQuotaPopover();
  }

  function openQuotaPopover() {
    quotaPopoverOpen = true;
    selectedQuotaGroupIdx = -1;
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) ring.setAttribute('data-open', 'true');
    const pop = ensureQuotaPopover();
    renderQuotaPopoverBody();
    pop.setAttribute('data-open', 'true');
    positionQuotaPopover();
    fetchQuotaSummary(false).then(() => {
      if (Date.now() - lastQuotaFetchTs > 12000) fetchQuotaSummary(true);
    });
  }

  function closeQuotaPopover() {
    quotaPopoverOpen = false;
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (ring) ring.setAttribute('data-open', 'false');
    const pop = document.getElementById('ag-claude-quota-popover');
    if (pop) pop.setAttribute('data-open', 'false');
  }

  function updateComposerRingVisuals() {
    const ring = document.getElementById('ag-claude-ctx-ring');
    if (!ring) return;
    const curCid = getActiveCascadeId();
    const hasCtx = Boolean(curCid && latestCtxState.hasData && latestCtxState.cascadeId === curCid);
    const pct = hasCtx ? latestCtxState.pct : 0;
    const arc = ring.querySelector('.ag-ctx-ring-arc');
    if (arc) {
      const offset = RING_CIRC * (1 - pct / 100);
      arc.style.strokeDashoffset = offset.toFixed(2);
      arc.style.strokeOpacity = pct <= 0 ? '0' : '1';
      let level = 'normal';
      if (pct >= 85) level = 'crit';
      else if (pct >= 70) level = 'warn';
      ring.setAttribute('data-level', level);
    }
    ring.title = hasCtx
      ? `当前上下文 ${latestCtxState.ratioText} (${pct}%) · 点击查看套餐限额`
      : '当前会话暂无上下文消耗 · 点击查看套餐限额';
  }

  function ensureComposerContextRing() {
    const inputBox = document.getElementById('antigravity.agentSidePanelInputBox');
    if (!inputBox) return;
    const leftGroup = inputBox.querySelector('div.flex.min-w-0.flex-1.items-center');
    if (!leftGroup) return;

    const modelWrap = Array.from(leftGroup.children).find(
      (ch) => ch.tagName === 'DIV' && ch.id !== 'ag-live-metrics-pill' && ch.querySelector('button')
    );
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
      ring.setAttribute('data-open', quotaPopoverOpen ? 'true' : 'false');
      ring.setAttribute('aria-label', '上下文与套餐使用限额');
      ring.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">' +
        '<circle class="ag-ctx-ring-track" cx="10" cy="10" r="7" fill="none" stroke-width="2.15"/>' +
        `<circle class="ag-ctx-ring-arc" cx="10" cy="10" r="7" fill="none" stroke-width="2.15" stroke-linecap="round" stroke-dasharray="${RING_CIRC.toFixed(
          2
        )}" stroke-dashoffset="${RING_CIRC.toFixed(2)}"/>` +
        '</svg>';
      ring.addEventListener('click', (e) => {
        e.stopPropagation();
        if (quotaPopoverOpen) {
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

    if (newlyInserted && typeof window.__ag_ensure_metrics_pill_fn === 'function') {
      requestAnimationFrame(() => {
        if (typeof window.__ag_ensure_metrics_pill_fn === 'function') {
          window.__ag_ensure_metrics_pill_fn(true);
        }
      });
    }
  }

  const onOutsidePopoverPointerDown = (e) => {
    if (!quotaPopoverOpen) return;
    const pop = document.getElementById('ag-claude-quota-popover');
    const ring = document.getElementById('ag-claude-ctx-ring');
    if ((pop && pop.contains(e.target)) || (ring && ring.contains(e.target))) return;
    closeQuotaPopover();
  };
  const onPopoverKeyDown = (e) => {
    if (quotaPopoverOpen && e.key === 'Escape') {
      closeQuotaPopover();
    }
  };
  const onWindowResizePopover = () => {
    if (quotaPopoverOpen) positionQuotaPopover();
  };
  document.addEventListener('pointerdown', onOutsidePopoverPointerDown, true);
  document.addEventListener('keydown', onPopoverKeyDown, true);
  window.addEventListener('resize', onWindowResizePopover);

  function scheduleSync() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(syncStepStream);
  }

  const observer = new MutationObserver((mutations) => {
    let needSync = false;
    for (const m of mutations) {
      if (
        m.type === 'attributes' &&
        m.attributeName === 'aria-expanded' &&
        m.target &&
        m.target.getAttribute &&
        m.target.getAttribute('data-testid') === 'tool-group-collapsible'
      ) {
        if (m.target.getAttribute('aria-expanded') === 'false') {
          animateCollapseIfNeeded(m.target);
          needSync = true;
        } else {
          needSync = true;
        }
      } else if (m.type === 'childList' || m.type === 'attributes') {
        needSync = true;
      }
    }
    if (needSync) scheduleSync();
  });

  if (document.body) {
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'class']
    });
    syncStepStream();
  }

  if (typeof ctx !== 'undefined' && ctx && typeof ctx.onCleanup === 'function') {
    ctx.onCleanup(() => {
      observer.disconnect();
      if (timerIntervalId) {
        clearInterval(timerIntervalId);
        timerIntervalId = null;
      }
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('pointerdown', onOutsidePopoverPointerDown, true);
      document.removeEventListener('keydown', onPopoverKeyDown, true);
      window.removeEventListener('resize', onWindowResizePopover);
      if (window.__ag_render_metrics && window.__ag_render_metrics.__agOrig) {
        window.__ag_render_metrics = window.__ag_render_metrics.__agOrig;
      }
      document
        .querySelectorAll(
          '.ag-collapse-ghost, .ag-orbit-dots, .ag-elapsed-timer, [data-ag-todo-mount], [data-ag-todo-dock], #ag-claude-ctx-ring, #ag-claude-quota-popover'
        )
        .forEach((el) => el.remove());
      document.querySelectorAll('[data-ag-todo-primary], [data-ag-todo-merged], [data-ag-todo-empty-wrap]').forEach((el) => {
        el.removeAttribute('data-ag-todo-primary');
        el.removeAttribute('data-ag-todo-merged');
        el.removeAttribute('data-ag-todo-empty-wrap');
      });
    });
  }
})();
