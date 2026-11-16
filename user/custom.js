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
  }

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
      document
        .querySelectorAll('.ag-collapse-ghost, .ag-orbit-dots, .ag-elapsed-timer, [data-ag-todo-mount], [data-ag-todo-dock]')
        .forEach((el) => el.remove());
      document.querySelectorAll('[data-ag-todo-primary], [data-ag-todo-merged], [data-ag-todo-empty-wrap]').forEach((el) => {
        el.removeAttribute('data-ag-todo-primary');
        el.removeAttribute('data-ag-todo-merged');
        el.removeAttribute('data-ag-todo-empty-wrap');
      });
    });
  }
})();
