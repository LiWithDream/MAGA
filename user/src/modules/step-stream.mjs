/**
 * Conversation step stream unfold, 190ms collapse ghost, live orbiting running timer,
 * CJK inline-pill boundary hygiene, long code block folding & sticky headers, and custom DOM flags.
 */
export function createStepStreamModule(rt) {
  const { FEAT, L, frame, state: rtState, setLeafText, syncAttrTargetSet } = rt;

  const userToggled = new WeakSet();
  const autoExpandBurst = new WeakMap();
  const workedKind = new WeakMap();
  const workedSummary = new WeakMap();
  const pendingProbes = new WeakSet();
  const openSnapshots = new WeakMap();
  const runningTimers = new WeakMap();
  let timerIntervalId = null;

  function resolveWorkedStreamHost(btn) {
    if (!btn || !btn.parentElement) return null;
    const p = btn.parentElement;
    if (p.nextElementSibling && !p.classList.contains('flex')) return p;
    if (p.parentElement && p.parentElement.tagName === 'DIV' && p.nextElementSibling) {
      return p.parentElement;
    }
    return p;
  }

  function resolveWorkedPanel(btn) {
    if (!btn || !btn.parentElement) return null;
    const p = btn.parentElement;
    return p.classList.contains('flex') ? p.nextElementSibling : btn.nextElementSibling;
  }

  function panelHasIntermediateProse(panel) {
    if (!panel || !panel.querySelectorAll) return false;
    const nodes = panel.querySelectorAll(
      '[data-testid="planner-response-text"], [data-markdown-root], .select-text, .prose, .markdown'
    );
    for (const el of nodes) {
      if (!(el.textContent || '').trim()) continue;
      const btnAncestor = el.closest('button');
      if (btnAncestor && panel.contains(btnAncestor)) continue;
      const sys = el.closest('[data-testid="system-message-row"]');
      if (sys && panel.contains(sys)) continue;
      const thinkPanel = el.closest('[data-testid="thinking-collapsible-trigger"] + div');
      if (thinkPanel && panel.contains(thinkPanel)) continue;
      const toolPanel = el.closest('[data-testid="tool-group-collapsible"] + div');
      if (toolPanel && panel.contains(toolPanel)) continue;
      return true;
    }
    return false;
  }

  function extractWorkedToolsSummary(panel) {
    if (!panel || !panel.querySelectorAll) return '';
    let els = Array.from(panel.querySelectorAll('[data-testid="tool-group-collapsible"]'));
    if (!els.length) {
      els = Array.from(panel.querySelectorAll('[data-testid="system-message-row"] button'));
    }
    const seen = new Set();
    const parts = [];
    for (const el of els) {
      let txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      txt = txt.replace(/\s*\d+[ms](?:\s+\d+s)?$/, '').trim();
      if (!txt || seen.has(txt)) continue;
      seen.add(txt);
      parts.push(txt);
    }
    if (!parts.length) return '';
    const joined = parts.join(' · ');
    return joined.length > 46 ? `${joined.slice(0, 45).trimEnd()}…` : joined;
  }

  function applyWorkedInlineSummary(btn, summaryText) {
    if (!btn) return;
    let span = btn.querySelector(':scope > .ag-worked-inline-summary');
    const clean = String(summaryText || '').trim();
    if (!clean) {
      if (btn.hasAttribute('data-ag-has-summary')) btn.removeAttribute('data-ag-has-summary');
      if (span) span.remove();
      return;
    }
    const nativeSpan = Array.from(btn.children || []).find(
      (ch) => ch.tagName === 'SPAN' && !ch.classList.contains('ag-worked-inline-summary')
    );
    const nativeText = nativeSpan
      ? nativeSpan.textContent || ''
      : Array.from(btn.childNodes || [])
          .filter((n) => n !== span && !(n.classList && n.classList.contains('ag-worked-inline-summary')))
          .map((n) => n.textContent || '')
          .join(' ');
    const durMatch = nativeText.match(/\b(\d+[hms](?:\s+\d+s)?)\b/);
    const duration = durMatch ? durMatch[1] : '';
    const finalSummary = duration ? `${clean} · ${duration}` : clean;
    if (btn.getAttribute('data-ag-has-summary') !== '1') {
      btn.setAttribute('data-ag-has-summary', '1');
    }
    if (!span) {
      span = document.createElement('span');
      span.className = 'ag-worked-inline-summary';
      if (typeof rt.markOwn === 'function') rt.markOwn(span);
      else span.setAttribute('data-maga-own', '1');
      const chevron = btn.querySelector(':scope > svg:last-of-type');
      if (chevron) btn.insertBefore(span, chevron);
      else btn.appendChild(span);
    }
    setLeafText(span, finalSummary);
  }

  function isWorkedTurnActive(btn, panel, panesArg) {
    if (panel && panel.querySelector && panel.querySelector('[data-testid="ephemeral-tool-status"], .ag-orbit-dots')) {
      return true;
    }
    const resp = btn && btn.closest ? btn.closest('[data-testid="agent-response"]') : null;
    if (!resp) return false;
    const panes = panesArg || collectPanes();
    for (const p of panes) {
      if (!p.root.contains(resp)) continue;
      const turns = p.root.querySelectorAll('[data-testid="agent-response"]');
      if (!turns.length || turns[turns.length - 1] !== resp) return false;
      return (
        Boolean(document.querySelector('button[data-testid="input-cancel-button"]')) ||
        paneHasWorkingHeading(p.root)
      );
    }
    return false;
  }

  function tryToggleWorkedBtn(btn) {
    if (rtState.disposed || !FEAT.stepUnfold || !btn || !btn.isConnected) return false;
    const now = Date.now();
    const prev = autoExpandBurst.get(btn);
    const count = prev && now - prev.lastTs < 1500 ? prev.count : 0;
    if (count >= 6) return false;
    autoExpandBurst.set(btn, { count: count + 1, lastTs: now });
    btn.click();
    return true;
  }

  function classifyAndReconcileWorkedBtn(btn, panesArg) {
    if (rtState.disposed || !FEAT.stepUnfold || !btn || !btn.isConnected) return;
    if (btn.getAttribute('aria-expanded') !== 'true') return;
    const wrap = resolveWorkedStreamHost(btn);
    const panel = resolveWorkedPanel(btn);
    if (panelHasIntermediateProse(panel)) {
      workedKind.set(btn, 'prose');
      if (wrap && wrap.getAttribute('data-ag-inline-kind') !== 'prose') {
        wrap.setAttribute('data-ag-inline-kind', 'prose');
      }
      applyWorkedInlineSummary(btn, '');
      return;
    }
    if (isWorkedTurnActive(btn, panel, panesArg)) {
      workedKind.delete(btn);
      applyWorkedInlineSummary(btn, '');
      if (wrap && wrap.hasAttribute('data-ag-inline-kind')) wrap.removeAttribute('data-ag-inline-kind');
      return;
    }
    const summary = extractWorkedToolsSummary(panel);
    if (summary) workedSummary.set(btn, summary);
    const finalSummary = workedSummary.get(btn) || '';
    applyWorkedInlineSummary(btn, finalSummary);
    workedKind.set(btn, 'tools');
    if (wrap && wrap.getAttribute('data-ag-inline-kind') !== 'tools') {
      wrap.setAttribute('data-ag-inline-kind', 'tools');
    }
    if (!userToggled.has(btn)) {
      tryToggleWorkedBtn(btn);
    }
  }

  const PAST_LABEL_RE =
    /^(?:Explored|Ran\b|Edited\b|Done\b|Read\b|Searched|Listed|Viewed|Checked|Found\b|Created|Updated|Deleted|Wrote\b|Written|Built\b|Tested|Installed|Fetched|Analyzed|Reviewed|Thought\b|Worked\b|Completed|Finished|Failed|Stopped|Cancelled|Canceled|Skipped|已探索|已运行|已编辑|已完成|已读取|已搜索|已查看|已检查|已创建|已更新|已删除|已写入|已构建|已测试|已失败|已取消|完成了|思考了)/i;

  const isTrustedClick = typeof rt.isTrustedClick === 'function' ? rt.isTrustedClick : (e) => Boolean(e && e.isTrusted);
  const onDocClick = (e) => {
    if (!isTrustedClick(e)) return;
    const btn = e.target && e.target.closest && e.target.closest('button[data-testid="worked-for-collapsible"]');
    if (btn) userToggled.add(btn);
  };
  document.addEventListener('click', onDocClick, true);

  function captureOpenToolPanels() {
    /* Keep a reference to the live panel node (no innerHTML serialisation per frame).
       It is cloned only at the moment React collapses it. */
    const openBtns = document.querySelectorAll('button[data-testid="tool-group-collapsible"][aria-expanded="true"]');
    for (const btn of openBtns) {
      const panel = btn.nextElementSibling;
      if (!panel || panel.classList.contains('ag-collapse-ghost')) continue;
      const snap = openSnapshots.get(btn);
      if (!snap || snap.panel !== panel) openSnapshots.set(btn, { panel });
    }
  }

  function animateCollapseIfNeeded(btn) {
    const snap = openSnapshots.get(btn);
    if (!snap) return;
    openSnapshots.delete(btn);
    if (btn.getAttribute('aria-expanded') !== 'false') return;
    const parent = btn.parentElement;
    if (!parent || parent.querySelector(':scope > .ag-collapse-ghost')) return;
    const src = snap.panel;
    if (!src || !src.firstChild) return;

    const ghost = document.createElement('div');
    ghost.className = `${src.className} ag-collapse-ghost`;
    ghost.setAttribute('aria-hidden', 'true');
    for (const n of Array.from(src.childNodes)) ghost.appendChild(n.cloneNode(true));
    ghost.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    ghost.style.opacity = '1';
    ghost.style.transform = 'translateY(0)';
    btn.insertAdjacentElement('afterend', ghost);

    const rectH = ghost.getBoundingClientRect ? ghost.getBoundingClientRect().height : 0;
    const height = Math.min(Math.ceil(rectH || ghost.scrollHeight || 0), 360);
    if (height <= 8) {
      ghost.remove();
      return;
    }
    ghost.style.maxHeight = `${height}px`;
    /* Commit starting box in the same frame so collapse begins immediately with zero 2-frame stall */
    void ghost.offsetHeight;
    ghost.classList.add('is-collapsing');

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      ghost.removeEventListener('transitionend', onEnd);
      if (ghost.parentNode) ghost.remove();
    };
    const onEnd = (ev) => {
      if (ev && ev.target === ghost && ev.propertyName === 'max-height') cleanup();
    };
    ghost.addEventListener('transitionend', onEnd);
    setTimeout(cleanup, 220); /* intentionally untracked: must also run after dispose */
  }

  /* One pane = one composer input box + its conversation. Computed once per sync (panes are few). */
  const INPUT_BOX_SEL = '[id="antigravity.agentSidePanelInputBox"]';
  function collectPanes() {
    const panes = [];
    for (const inputBox of document.querySelectorAll(INPUT_BOX_SEL)) {
      let cur = inputBox.parentElement;
      for (let i = 0; i < 16 && cur; i++, cur = cur.parentElement) {
        if (cur.querySelector('[data-testid="agent-response"]')) {
          if (cur.querySelectorAll(INPUT_BOX_SEL).length === 1) panes.push({ root: cur, inputBox });
          break;
        }
      }
    }
    return panes;
  }

  function paneFor(el, panes) {
    for (const p of panes) if (p.root.contains(el)) return p;
    return null;
  }

  const AGENT_WORKING_H6_RE = /^(?:Agent\s+working|Agent\s*正在执行|Agent\s*正在工作|正在工作)$/i;
  function paneHasWorkingHeading(root) {
    if (!root || !root.querySelectorAll) return false;
    const turns = root.querySelectorAll('[data-testid="agent-response"]');
    if (!turns.length) return false;
    const lastTurn = turns[turns.length - 1];
    const h6 = lastTurn.querySelector(':scope > h6.sr-only, :scope > h6');
    if (!h6) return false;
    const origMap = window.__ag_orig_text_map;
    const raw =
      (origMap && h6.firstChild && origMap.get(h6.firstChild) && origMap.get(h6.firstChild).origRaw) ||
      h6.textContent ||
      '';
    return AGENT_WORKING_H6_RE.test(raw.trim());
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

  function syncRunningToolIndicators(panesArg) {
    if (rtState.disposed) return;
    const candidates = FEAT.runningTimer
      ? Array.from(document.querySelectorAll('button[data-testid="tool-group-collapsible"], [data-testid="ephemeral-tool-status"]'))
      : [];
    const panes = panesArg || collectPanes();
    const globalGenerating =
      Boolean(document.querySelector('button[data-testid="input-cancel-button"]')) ||
      panes.some((p) => paneHasWorkingHeading(p.root));

    /* "last row" and "generating" are evaluated per pane, so a busy pane never lights up another one */
    const lastInPane = new Map();
    const paneOfEl = new Map();
    for (const el of candidates) {
      const pane = paneFor(el, panes);
      paneOfEl.set(el, pane);
      lastInPane.set(pane, el);
    }
    const generatingCache = new Map();
    const paneGenerating = (pane) => {
      if (!pane) return panes.length === 0 && globalGenerating;
      if (!generatingCache.has(pane)) {
        generatingCache.set(
          pane,
          Boolean(pane.inputBox.querySelector('button[data-testid="input-cancel-button"]')) ||
            paneHasWorkingHeading(pane.root)
        );
      }
      return generatingCache.get(pane);
    };

    let activeCount = 0;
    const now = Date.now();
    for (const el of candidates) {
      const pane = paneOfEl.get(el);
      const isRunning = isActivelyRunningRow(el, lastInPane.get(pane) === el, paneGenerating(pane));
      const hasNativeElapsed = Boolean(el.querySelector('[data-testid="tool-group-elapsed"]'));
      if (hasNativeElapsed) {
        if (el.getAttribute('data-maga-native-elapsed') !== '1') el.setAttribute('data-maga-native-elapsed', '1');
      } else if (el.hasAttribute('data-maga-native-elapsed')) {
        el.removeAttribute('data-maga-native-elapsed');
      }
      let orbit = el.querySelector(':scope > .ag-orbit-dots');
      let timerEl = el.querySelector(':scope > .ag-elapsed-timer');

      if (isRunning) {
        if (el.getAttribute('data-maga-running') !== '1') el.setAttribute('data-maga-running', '1');
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
        if (hasNativeElapsed) {
          if (timerEl) timerEl.remove();
        } else {
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
          setLeafText(timerEl, txt);
        }
      } else {
        if (el.hasAttribute('data-maga-running')) el.removeAttribute('data-maga-running');
        if (orbit) orbit.remove();
        if (timerEl) timerEl.remove();
        runningTimers.delete(el);
      }
    }
    /* stale indicators on rows that are no longer candidates */
    if (!FEAT.runningTimer) {
      document.querySelectorAll('.ag-orbit-dots, .ag-elapsed-timer').forEach((n) => n.remove());
      document.querySelectorAll('[data-maga-running]').forEach((el) => el.removeAttribute('data-maga-running'));
    }

    const keepPolling = activeCount > 0;
    if (keepPolling && !timerIntervalId) {
      timerIntervalId = setInterval(() => {
        if (document.hidden) return;
        const ps = collectPanes();
        syncRunningToolIndicators(ps);
      }, 500);
    } else if (!keepPolling && timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
  }

  /* Inline code & file-mention pill CJK boundary hygiene:
   * 1. Strips redundant ASCII spaces (`" "`) between boxed pills (`:not(pre) > code`, `bdi.context-scope-mention`)
   *    and adjacent CJK characters / fullwidth punctuation so pills don't push `，。；：（）` away with double gaps.
   * 2. Attaches U+2060 WORD JOINER between atomic inline pills (`inline-flex` file mentions) and adjacent CJK
   *    closing/middle punctuation (`、，。！？；：）》」』】`) or opening brackets (`（《「『【`) so punctuation never wraps to line start.
   * Mutates `Text.nodeValue` only (zero childList mutations, zero React Fiber interference) and restores on `dispose()`. */
  const pillSiblingEdits = new WeakMap();
  const pillBoundaryState = new WeakMap();
  const WORD_JOINER = '\u2060';
  const CJK_OR_FULL_PUNCT_END_SPACE_RE = /([\u4e00-\u9fff\u3000-\u303f\uff01-\uff60“‘])([ \t]+)$/;
  const CJK_OR_FULL_PUNCT_LEAD_SPACE_RE = /^([ \t]+)([\u4e00-\u9fff\u3000-\u303f\uff01-\uff60”’])/;
  const CJK_OPEN_PUNCT_END_RE = /[（《「『【〈“‘]$/;
  const CJK_CLOSE_OR_MID_PUNCT_START_RE = /^[、，。！？；：）》」』】〉”’—…]/;

  function syncInlinePillBoundaries() {
    if (rtState.disposed) return;
    const pills = document.querySelectorAll(
      '[data-testid="planner-response-text"] :is(:not(pre) > code, bdi.context-scope-mention), ' +
        '[data-markdown-root] :is(:not(pre) > code, bdi.context-scope-mention), ' +
        '.select-text :is(:not(pre) > code, bdi.context-scope-mention), ' +
        '.prose :is(:not(pre) > code, bdi.context-scope-mention)'
    );
    for (const pill of pills) {
      const prev = pill.previousSibling;
      const fol = pill.nextSibling;
      const prevCur = prev && prev.nodeType === 3 ? prev.nodeValue || '' : null;
      const folCur = fol && fol.nodeType === 3 ? fol.nodeValue || '' : null;
      const cached = pillBoundaryState.get(pill);
      if (cached && cached.prev === prev && cached.prevTxt === prevCur && cached.fol === fol && cached.folTxt === folCur) {
        continue;
      }

      if (pill.closest('[contenteditable="true"], [data-lexical-editor="true"], pre, ul.contains-task-list')) {
        pillBoundaryState.set(pill, { prev, prevTxt: prevCur, fol, folTxt: folCur });
        continue;
      }

      let nextPrevTxt = prevCur;
      if (prev && prev.nodeType === 3) {
        const cur = prevCur || '';
        const spaceMatch = cur.match(CJK_OR_FULL_PUNCT_END_SPACE_RE);
        let next = spaceMatch ? cur.slice(0, cur.length - spaceMatch[2].length) : cur;
        let addedTrailWj = false;
        if (CJK_OPEN_PUNCT_END_RE.test(next) && !next.endsWith(WORD_JOINER)) {
          next += WORD_JOINER;
          addedTrailWj = true;
        }
        if (next !== cur) {
          const rec = pillSiblingEdits.get(prev) || {};
          if (spaceMatch && !rec.strippedTrailSpace) rec.strippedTrailSpace = spaceMatch[2];
          if (addedTrailWj) rec.addedTrailWj = true;
          pillSiblingEdits.set(prev, rec);
          prev.nodeValue = next;
        }
        nextPrevTxt = next;
      }

      let nextFolTxt = folCur;
      if (fol && fol.nodeType === 3) {
        const cur = folCur || '';
        const hadWj = cur.startsWith(WORD_JOINER);
        const withoutWj = hadWj ? cur.slice(1) : cur;
        const spaceMatch = withoutWj.match(CJK_OR_FULL_PUNCT_LEAD_SPACE_RE);
        let next = spaceMatch ? withoutWj.slice(spaceMatch[1].length) : withoutWj;
        let addedLeadWj = false;
        if (CJK_CLOSE_OR_MID_PUNCT_START_RE.test(next)) {
          next = WORD_JOINER + next;
          addedLeadWj = true;
        }
        if (next !== cur) {
          const rec = pillSiblingEdits.get(fol) || {};
          if (spaceMatch && !rec.strippedLeadSpace) rec.strippedLeadSpace = spaceMatch[1];
          if (addedLeadWj) rec.addedLeadWj = true;
          pillSiblingEdits.set(fol, rec);
          fol.nodeValue = next;
        }
        nextFolTxt = next;
      }

      pillBoundaryState.set(pill, { prev, prevTxt: nextPrevTxt, fol, folTxt: nextFolTxt });
    }
  }

  function restoreInlinePillBoundaries() {
    const pills = document.querySelectorAll(':not(pre) > code, bdi.context-scope-mention');
    for (const pill of pills) {
      pillBoundaryState.delete(pill);
      for (const node of [pill.previousSibling, pill.nextSibling]) {
        if (!node || node.nodeType !== 3 || !pillSiblingEdits.has(node)) continue;
        const rec = pillSiblingEdits.get(node);
        let val = node.nodeValue || '';
        if (rec.addedLeadWj && val.startsWith(WORD_JOINER)) val = val.slice(1);
        if (rec.strippedLeadSpace && !val.startsWith(rec.strippedLeadSpace)) val = rec.strippedLeadSpace + val;
        if (rec.addedTrailWj && val.endsWith(WORD_JOINER)) val = val.slice(0, -1);
        if (rec.strippedTrailSpace && !val.endsWith(rec.strippedTrailSpace)) val = val + rec.strippedTrailSpace;
        node.nodeValue = val;
        pillSiblingEdits.delete(node);
      }
    }
  }

  /* ==========================================================================
   * 4b. Long Code Block Folding & Sticky Header (claudeUxCodeFold)
   *     - Sticks native code block headers while scrolling long responses
   *     - Collapses blocks with >= 40 lines to a preview by default, remembering
   *       user expand/collapse choices across React virtualized remounts
   * ========================================================================== */
  const CODE_FOLD_MIN_LINES = 40;
  const CODE_FOLD_KEYS_MAX = 300;
  const codeFoldUserState = new Map();
  const codeBlockMetricCache = new WeakMap();
  const SVG_CODE_FOLD_CHEVRON =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  function findNativeCodeBlocks() {
    const blocks = [];
    const codeEls = document.querySelectorAll('div.code-block');
    for (const codeEl of codeEls) {
      if (codeEl.classList.contains('overflow-y-auto')) continue;
      const body = codeEl.parentElement;
      if (!body || !body.classList || !body.classList.contains('p-3')) continue;
      const wrap = body.parentElement;
      if (!wrap) continue;
      const header = wrap.firstElementChild;
      if (!header || header === body || !header.classList) continue;
      if (!header.classList.contains('min-h-7') || !header.classList.contains('border-b')) continue;
      blocks.push({ wrap, header, body, codeEl });
    }
    return blocks;
  }

  function hashTextFnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function getCodeBlockMetrics(header, codeEl) {
    if (!codeEl) return { lines: 0, key: '' };
    const langEl = header && header.firstElementChild;
    const lang = langEl && langEl.textContent ? langEl.textContent.trim() : '';
    const childCount = codeEl.childNodes ? codeEl.childNodes.length : 0;
    const firstNode = codeEl.firstChild;
    const lastNode = codeEl.lastChild;
    const cached = codeBlockMetricCache.get(codeEl);
    if (
      cached &&
      cached.lang === lang &&
      cached.childCount === childCount &&
      cached.firstNode === firstNode &&
      cached.lastNode === lastNode &&
      (childCount > 1 || (firstNode && firstNode.nodeValue === cached.singleText))
    ) {
      return cached;
    }
    const lineNodes = codeEl.querySelectorAll('.code-line');
    const txt = codeEl.textContent || '';
    const lines = lineNodes.length > 0 ? lineNodes.length : txt ? txt.split('\n').length : 0;
    const key = `${lang}|${txt.length}|${hashTextFnv1a(txt)}`;
    const next = {
      lang,
      childCount,
      firstNode,
      lastNode,
      singleText: childCount <= 1 && firstNode ? firstNode.nodeValue : undefined,
      lines,
      key
    };
    codeBlockMetricCache.set(codeEl, next);
    return next;
  }

  function codeBlockKey(header, codeEl) {
    return getCodeBlockMetrics(header, codeEl).key;
  }

  function rememberCodeFoldState(key, stateVal) {
    if (codeFoldUserState.has(key)) codeFoldUserState.delete(key);
    codeFoldUserState.set(key, stateVal);
    if (codeFoldUserState.size > CODE_FOLD_KEYS_MAX) {
      codeFoldUserState.delete(codeFoldUserState.keys().next().value);
    }
  }

  function findCodeBlockScrollContainer(el) {
    let cur = el ? el.parentElement : null;
    for (let i = 0; i < 25 && cur && cur !== document.documentElement; i++, cur = cur.parentElement) {
      if (typeof getComputedStyle === 'function') {
        const ov = getComputedStyle(cur).overflowY;
        if (ov === 'auto' || ov === 'scroll') return cur;
      }
    }
    return null;
  }

  function onCodeFoldClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const trigger = e.currentTarget;
    const wrap = trigger && trigger.closest ? trigger.closest('[data-ag-code-wrap]') : null;
    if (wrap) toggleCodeFold(wrap);
  }

  function syncSingleCodeBlock(wrap, header, codeEl) {
    if (!wrap || !header || !codeEl) return;
    if (wrap.getAttribute('data-ag-code-wrap') !== 'true') {
      wrap.setAttribute('data-ag-code-wrap', 'true');
    }
    const { lines, key } = getCodeBlockMetrics(header, codeEl);
    if (lines >= CODE_FOLD_MIN_LINES) {
      if (wrap.getAttribute('data-ag-code-long') !== 'true') {
        wrap.setAttribute('data-ag-code-long', 'true');
      }
      const collapsed = codeFoldUserState.get(key) !== 'expanded';
      const nextAttr = collapsed ? 'true' : 'false';
      if (wrap.getAttribute('data-ag-code-collapsed') !== nextAttr) {
        wrap.setAttribute('data-ag-code-collapsed', nextAttr);
      }

      let toggleBtn = header.querySelector('.ag-code-fold-toggle');
      if (!toggleBtn) {
        toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className =
          'ag-code-fold-toggle appearance-none bg-transparent border-0 p-0 cursor-pointer text-secondary-foreground hover:text-foreground transition-colors';
        toggleBtn.setAttribute('data-ag-i18n-ignore', '1');
        toggleBtn.innerHTML = SVG_CODE_FOLD_CHEVRON;
        toggleBtn.addEventListener('click', onCodeFoldClick);
        const btnGroup =
          header.lastElementChild && header.lastElementChild !== header.firstElementChild
            ? header.lastElementChild
            : header;
        btnGroup.insertBefore(toggleBtn, btnGroup.firstChild);
      }
      const toggleLabel = collapsed ? L('展开代码', 'Expand code') : L('收起代码', 'Collapse code');
      if (toggleBtn.getAttribute('aria-label') !== toggleLabel) {
        toggleBtn.setAttribute('aria-label', toggleLabel);
      }
      if (toggleBtn.getAttribute('title') !== toggleLabel) {
        toggleBtn.setAttribute('title', toggleLabel);
      }

      let bar = null;
      for (const ch of wrap.children) {
        if (ch.classList && ch.classList.contains('ag-code-fold-bar')) {
          bar = ch;
          break;
        }
      }
      if (!bar) {
        bar = document.createElement('button');
        bar.type = 'button';
        bar.className = 'ag-code-fold-bar';
        bar.setAttribute('data-ag-i18n-ignore', '1');
        bar.addEventListener('click', onCodeFoldClick);
        wrap.appendChild(bar);
      }
      const barText = collapsed
        ? L(`展开全部 · 共 ${lines} 行`, `Show all ${lines} lines`)
        : L('收起代码', 'Collapse code');
      if (bar.textContent !== barText) {
        bar.textContent = barText;
      }
    } else {
      if (wrap.hasAttribute('data-ag-code-long')) wrap.removeAttribute('data-ag-code-long');
      if (wrap.hasAttribute('data-ag-code-collapsed')) wrap.removeAttribute('data-ag-code-collapsed');
      header.querySelectorAll('.ag-code-fold-toggle').forEach((n) => n.remove());
      for (const ch of Array.from(wrap.children)) {
        if (ch.classList && ch.classList.contains('ag-code-fold-bar')) ch.remove();
      }
    }
  }

  function toggleCodeFold(wrap) {
    const header = wrap.firstElementChild;
    const codeEl = wrap.querySelector(':scope > div.p-3 > div.code-block');
    if (!header || !codeEl) return;
    const key = codeBlockKey(header, codeEl);
    const nextCollapsed = wrap.getAttribute('data-ag-code-collapsed') !== 'true';
    rememberCodeFoldState(key, nextCollapsed ? 'collapsed' : 'expanded');
    syncSingleCodeBlock(wrap, header, codeEl);
    if (nextCollapsed) {
      try {
        const scroller = findCodeBlockScrollContainer(wrap);
        const minTop = scroller ? scroller.getBoundingClientRect().top : 0;
        if (wrap.getBoundingClientRect().top < minTop) {
          wrap.scrollIntoView({ block: 'start', behavior: 'auto' });
        }
      } catch {}
    }
  }

  function syncCodeBlocks() {
    if (!FEAT.codeFold) return;
    for (const { wrap, header, codeEl } of findNativeCodeBlocks()) {
      syncSingleCodeBlock(wrap, header, codeEl);
    }
  }

  function teardownCodeBlocks() {
    document.querySelectorAll('[data-ag-code-wrap]').forEach((wrap) => {
      wrap.removeAttribute('data-ag-code-wrap');
      wrap.removeAttribute('data-ag-code-long');
      wrap.removeAttribute('data-ag-code-collapsed');
    });
    document.querySelectorAll('.ag-code-fold-toggle, .ag-code-fold-bar').forEach((el) => el.remove());
  }

  function syncCustomDomFlags() {
    const editorWraps = new Set();
    document.querySelectorAll('#antigravity\\.agentSidePanelInputBox [data-lexical-editor="true"]').forEach((ed) => {
      if (ed.parentElement && ed.parentElement.tagName === 'DIV') editorWraps.add(ed.parentElement);
    });
    syncAttrTargetSet('data-maga-editor-wrap', editorWraps);

    const qIcons = new Set();
    document.querySelectorAll('.rounded-xl.border > div.border-b > svg > path[d^="M477.92-295.77"]').forEach((p) => {
      if (p.parentElement) qIcons.add(p.parentElement);
    });
    syncAttrTargetSet('data-maga-q-icon', qIcons);

    const hasToolsRows = new Set();
    document.querySelectorAll('[data-step-rows="true"]').forEach((row) => {
      if (row.querySelector('[data-testid="tool-group-collapsible"]')) hasToolsRows.add(row);
    });
    syncAttrTargetSet('data-maga-has-tools', hasToolsRows);

    const browserHoles = new Set();
    document.querySelectorAll('[data-browser-hole="true"]').forEach((hole) => {
      const host = hole.closest('[data-main-content-body], [data-side-panel-body]');
      if (host) browserHoles.add(host);
    });
    syncAttrTargetSet('data-maga-has-browser-hole', browserHoles);

    const actionCards = new Set();
    const actionCardWraps = new Set();
    const CHROME_RE = /\b(?:border|rounded-(?:md|lg|xl)|bg-(?:muted|secondary|card|accent|background|zinc|neutral|stone|slate))\b/;
    const ACTION_CARD_RE = /(?:^|\b)(?:Ran|Running)\b|已运行|正在运行|Exited with code/i;
    document.querySelectorAll('[data-testid="agent-response"] button').forEach((btn) => {
      if (btn.hasAttribute('data-maga-own')) return;
      const tid = btn.getAttribute('data-testid');
      if (
        tid === 'worked-for-collapsible' ||
        tid === 'tool-group-collapsible' ||
        tid === 'step-plan-chip' ||
        tid === 'changed-files-card-review' ||
        tid === 'markdown-table-menu' ||
        tid === 'thinking-collapsible-trigger'
      ) {
        return;
      }
      if (btn.matches('[role="combobox"], [aria-haspopup]')) return;
      if (
        btn.closest(
          '[data-markdown-root], [data-testid="planner-response-text"], .context-scope-mention, [data-maga-own], [data-testid="changed-files-card"]'
        )
      ) {
        return;
      }
      if (btn.querySelector('pre, table')) return;
      const cls = typeof btn.className === 'string' ? btn.className : '';
      const p = btn.parentElement;
      const pCls = p && typeof p.className === 'string' ? p.className : '';
      const hasCardChrome = CHROME_RE.test(cls) || CHROME_RE.test(pCls);
      if (!hasCardChrome) return;
      const txt = (btn.textContent || '').trim();
      if (!txt || txt.length > 240 || !ACTION_CARD_RE.test(txt)) return;
      actionCards.add(btn);
      if (
        p &&
        p.tagName === 'DIV' &&
        !p.hasAttribute('data-maga-own') &&
        p.children &&
        p.children.length === 1 &&
        btn.getAttribute('aria-expanded') !== 'true' &&
        CHROME_RE.test(pCls) &&
        !p.querySelector(
          'p, pre, [data-markdown-root], [data-testid="planner-response-text"], [data-testid="changed-files-card"]'
        )
      ) {
        actionCardWraps.add(p);
      }
    });
    syncAttrTargetSet('data-maga-action-card', actionCards);
    syncAttrTargetSet('data-maga-action-card-wrap', actionCardWraps);
  }

  function handleAriaExpandedMutation(t) {
    if (!t || !t.getAttribute) return;
    const testid = t.getAttribute('data-testid');
    if (testid === 'worked-for-collapsible') {
      if (FEAT.stepUnfold && t.getAttribute('aria-expanded') === 'false' && !userToggled.has(t)) {
        if (workedKind.get(t) === 'tools') {
          applyWorkedInlineSummary(t, workedSummary.get(t) || '');
          return;
        }
        frame(() => {
          if (rtState.disposed || !FEAT.stepUnfold || !t.isConnected) return;
          if (t.getAttribute('aria-expanded') !== 'false' || userToggled.has(t)) return;
          const kind = workedKind.get(t);
          if (kind === 'tools') {
            applyWorkedInlineSummary(t, workedSummary.get(t) || '');
            return;
          }
          if (kind === 'prose') {
            tryToggleWorkedBtn(t);
            return;
          }
          if (!pendingProbes.has(t)) {
            pendingProbes.add(t);
            if (tryToggleWorkedBtn(t)) {
              frame(() => {
                pendingProbes.delete(t);
                if (!rtState.disposed && FEAT.stepUnfold && t.isConnected) classifyAndReconcileWorkedBtn(t);
              });
            } else {
              pendingProbes.delete(t);
            }
          }
        });
      }
      return;
    }
    if (!FEAT.collapseAnim || testid !== 'tool-group-collapsible') return;
    const exp = t.getAttribute('aria-expanded');
    if (exp === 'false') {
      animateCollapseIfNeeded(t);
    } else if (exp === 'true' && t.parentElement) {
      t.parentElement.querySelectorAll(':scope > .ag-collapse-ghost').forEach((g) => g.remove());
    }
  }

  function teardownWorkedInlineState() {
    document.querySelectorAll('.ag-worked-inline-summary').forEach((el) => el.remove());
    document.querySelectorAll('[data-ag-inline-stream]').forEach((el) => {
      el.removeAttribute('data-ag-inline-stream');
      el.removeAttribute('data-ag-inline-kind');
      el.removeAttribute('data-ag-has-plan-chip');
    });
    document.querySelectorAll('[data-ag-inline-worked]').forEach((el) => el.removeAttribute('data-ag-inline-worked'));
    document.querySelectorAll('[data-ag-has-summary]').forEach((el) => el.removeAttribute('data-ag-has-summary'));
  }

  function sync() {
    if (rtState.disposed) return;
    const panes = collectPanes();
    if (FEAT.stepUnfold) {
      const workedBtns = document.querySelectorAll('button[data-testid="worked-for-collapsible"]');
      for (const btn of workedBtns) {
        const wrap = resolveWorkedStreamHost(btn);
        if (wrap) {
          if (!wrap.hasAttribute('data-ag-inline-stream')) {
            wrap.setAttribute('data-ag-inline-stream', 'true');
          }
          const hasPlanChip = Boolean(wrap.querySelector('button[data-testid="step-plan-chip"]'));
          if (hasPlanChip) {
            if (!wrap.hasAttribute('data-ag-has-plan-chip')) wrap.setAttribute('data-ag-has-plan-chip', 'true');
          } else if (wrap.hasAttribute('data-ag-has-plan-chip')) {
            wrap.removeAttribute('data-ag-has-plan-chip');
          }
        }
        if (!btn.hasAttribute('data-ag-inline-worked')) {
          btn.setAttribute('data-ag-inline-worked', 'true');
        }
        if (btn.getAttribute('aria-expanded') === 'true') {
          classifyAndReconcileWorkedBtn(btn, panes);
        } else {
          const kind = workedKind.get(btn);
          if (userToggled.has(btn) || kind === 'tools') {
            if (kind === 'tools') {
              if (wrap && wrap.getAttribute('data-ag-inline-kind') !== 'tools') {
                wrap.setAttribute('data-ag-inline-kind', 'tools');
              }
              applyWorkedInlineSummary(btn, workedSummary.get(btn) || '');
            }
          } else if (kind === 'prose') {
            tryToggleWorkedBtn(btn);
          } else if (!pendingProbes.has(btn)) {
            pendingProbes.add(btn);
            if (tryToggleWorkedBtn(btn)) {
              frame(() => {
                pendingProbes.delete(btn);
                if (!rtState.disposed && FEAT.stepUnfold && btn.isConnected) {
                  classifyAndReconcileWorkedBtn(btn, panes);
                }
              });
            } else {
              pendingProbes.delete(btn);
            }
          }
        }
      }
    } else {
      teardownWorkedInlineState();
    }
    if (FEAT.collapseAnim) captureOpenToolPanels();
    syncRunningToolIndicators(panes);
    syncInlinePillBoundaries();
    syncCodeBlocks();
    syncCustomDomFlags();
  }

  function dispose() {
    try {
      teardownCodeBlocks();
    } catch {}
    if (timerIntervalId) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
    document.removeEventListener('click', onDocClick, true);
    restoreInlinePillBoundaries();
    document.querySelectorAll('.ag-collapse-ghost, .ag-orbit-dots, .ag-elapsed-timer').forEach((el) => el.remove());
    document.querySelectorAll('[data-maga-action-card]').forEach((el) => el.removeAttribute('data-maga-action-card'));
    document.querySelectorAll('[data-maga-action-card-wrap]').forEach((el) => el.removeAttribute('data-maga-action-card-wrap'));
    document.querySelectorAll('[data-maga-running]').forEach((el) => el.removeAttribute('data-maga-running'));
    teardownWorkedInlineState();
  }

  return {
    sync,
    syncCustomDomFlags,
    collectPanes,
    syncRunningToolIndicators,
    handleAriaExpandedMutation,
    teardownCodeBlocks,
    restoreInlinePillBoundaries,
    dispose,
  };
}
