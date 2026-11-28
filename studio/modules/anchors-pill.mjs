/**
 * Anti-Drift Anchors & Milestone Handoff Cockpit Pill (`#agy-anchors-pill`) & Popover (`#agy-anchors-menu`).
 * - Single-observer MagaKernel module (`topics: ['composer', 'metrics']`), zero standalone MutationObserver.
 * - Surfaces human approval cards pairing verbatim user corrections with redacted model `thinking`
 *   comprehension previews (`Accept` / `Edit` / `Reject` + Evict-to-Admit under 400-token cap).
 * - Surfaces `G >= 3` compaction handoff pill & 1-click Milestone Handoff prompt copy/launch.
 */
import { markOwn, setAttr, setLeafText } from '../core/dom.mjs';
import { getActiveRouteCid, isComposerRunning, isZhUi, L } from '../core/env.mjs';

export function createAnchorsPillRuntime({ studioPrefs } = {}) {
  const PILL_ID = 'agy-anchors-pill';
  const MENU_ID = 'agy-anchors-menu';

  let disposed = false;
  let menuOpen = false;
  let menuEl = null;
  let prevCid = '';
  let prevRunning = null;
  let settleTimer = 0;
  let statusCache = { cid: '', ts: 0, inFlight: false, data: null };
  let handoffInFlight = false;
  const nextStepByCid = new Map();
  let handoffFeedback = { cid: '', tone: '', text: '' };
  let handoffFeedbackTimer = 0;

  const isEnabled = () => (studioPrefs?.get?.()?.anchorsMode || 'semi') !== 'off';

  function readMetricsGenForCid(cid) {
    if (!cid || typeof window === 'undefined') return 0;
    const m = window.__ag_last_metrics;
    if (!m || (m.cascadeId && m.cascadeId !== cid)) return 0;
    return Math.max(0, Number(m.metrics?.compactionCount || m.stats?.compactions || 0));
  }

  function getMainBox() {
    return (
      document.getElementById('antigravity.agentSidePanelInputBox') ||
      document.querySelector('[data-testid="conversation-view"] [data-testid="agent-input-box"]')
    );
  }

  function decodeFileUri(uri) {
    const s = String(uri || '').trim();
    if (!s) return '';
    if (!/^file:\/\//i.test(s)) return s;
    try {
      let p = decodeURIComponent(new URL(s).pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return p;
    } catch {
      return '';
    }
  }

  function detectActiveWorkspaceRoot(cid) {
    const box = getMainBox();
    if (!box) return '';
    const fk = Object.keys(box).find((k) => k.startsWith('__reactFiber$'));
    let cur = fk ? box[fk] : null;
    for (let d = 0; d < 32 && cur; d += 1, cur = cur.return) {
      for (let dep = cur.dependencies?.firstContext; dep; dep = dep.next) {
        const st = dep.memoizedValue?.store?.getState?.();
        const sum = st?.trajectorySummaries?.summaries?.[cid];
        const wsList = (sum?.workspaces || []).concat(sum?.trajectoryMetadata?.workspaces || []);
        for (const ws of wsList) {
          const rawUri = ws?.workspaceFolderAbsoluteUri || ws?.uri || ws;
          if (typeof rawUri === 'string' && rawUri.trim()) {
            const decoded = decodeFileUri(rawUri);
            if (decoded) return decoded;
          }
        }
      }
    }
    return '';
  }

  function setHandoffFeedback(cid, tone, text, ttlMs = 5000) {
    if (handoffFeedbackTimer) {
      clearTimeout(handoffFeedbackTimer);
      handoffFeedbackTimer = 0;
    }
    handoffFeedback = { cid: cid || '', tone: tone || 'ok', text: text || '' };
    if (text && ttlMs > 0) {
      handoffFeedbackTimer = setTimeout(() => {
        handoffFeedbackTimer = 0;
        handoffFeedback = { cid: '', tone: '', text: '' };
        if (menuOpen && !disposed) renderMenuContents({ force: false });
      }, ttlMs);
    }
  }

  function resolveHandoffContext(cid) {
    const base =
      typeof window !== 'undefined' && typeof window.__agClaudeUxBridge?.resolveActiveConversationContext === 'function'
        ? window.__agClaudeUxBridge.resolveActiveConversationContext(cid)
        : null;
    const repoRoot = String(base?.repoRoot || detectActiveWorkspaceRoot(cid) || '').trim();
    return {
      cid: String(base?.cid || cid || ''),
      projectId: String(base?.projectId || ''),
      projectName: String(base?.projectName || ''),
      repoRoot,
      composerDraft: String(base?.composerDraft || ''),
    };
  }

  function fetchStatus(cid, force = false) {
    if (disposed || !cid || typeof window.__agProjectCall !== 'function') return;
    const now = Date.now();
    if (!force && statusCache.cid === cid && (statusCache.inFlight || now - statusCache.ts < 3500)) return;
    statusCache = { cid, ts: now, inFlight: true, data: statusCache.cid === cid ? statusCache.data : null };
    const repoRoot = detectActiveWorkspaceRoot(cid);
    window
      .__agProjectCall('getAnchorsStatus', { cascadeId: cid, repoRoot }, 3000)
      .then((res) => {
        if (disposed || statusCache.cid !== cid) return;
        statusCache = { cid, ts: Date.now(), inFlight: false, data: res?.ok ? res : null };
        syncPillDom();
        if (menuOpen) renderMenuContents({ force: false });
      })
      .catch(() => {
        if (statusCache.cid === cid) statusCache.inFlight = false;
      });
  }

  function closeMenu() {
    menuOpen = false;
    if (menuEl) menuEl.removeAttribute('data-open');
  }

  function ensureMenuEl() {
    if (menuEl && menuEl.isConnected) return menuEl;
    menuEl = document.getElementById(MENU_ID);
    if (!menuEl) {
      menuEl = document.createElement('div');
      menuEl.id = MENU_ID;
      menuEl.className = 'agy-anchors-popover';
      markOwn(menuEl);
      document.body.appendChild(menuEl);
    }
    return menuEl;
  }

  function positionMenu(anchorPill) {
    const pop = ensureMenuEl();
    if (!anchorPill) return;
    const r = anchorPill.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return;
    const popW = 368;
    const left = Math.round(Math.max(12, Math.min(r.left, window.innerWidth - popW - 14)));
    const bottom = Math.round(Math.max(12, window.innerHeight - r.top + 8));
    pop.style.left = `${left}px`;
    pop.style.bottom = `${bottom}px`;
  }

  async function executeHandoffAction({ cid, hCtx, repoRoot, copyOnly }) {
    if (disposed || handoffInFlight || !cid || typeof window.__agProjectCall !== 'function') return;
    const runningNow = !copyOnly && isComposerRunning();
    if (runningNow) {
      setHandoffFeedback(
        cid,
        'warn',
        L('当前对话仍在生成中，请等待完成后再换窗。', 'Wait for the active reply to finish before handing off.')
      );
      renderMenuContents({ force: true });
      return;
    }

    handoffInFlight = true;
    renderMenuContents({ force: true });

    const nextStep = String(nextStepByCid.get(cid) || '').trim();
    const idleNow = !isComposerRunning();
    const copyToClipboard = async (text) => {
      if (!text || !navigator?.clipboard?.writeText) return false;
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    };

    try {
      const daemonRes = await window.__agProjectCall(
        'createMilestoneHandoff',
        {
          cascadeId: cid,
          repoRoot: repoRoot || hCtx.repoRoot || '',
          projectId: hCtx.projectId || '',
          userInitiated: true,
          nextStep,
          flushAnchors: Boolean(idleNow && !copyOnly),
          promptOnly: Boolean(copyOnly),
          preferRendererLaunch: Boolean(
            !copyOnly && typeof window.__agClaudeUxBridge?.launchMilestoneHandoffChat === 'function'
          ),
        },
        6000
      );
      if (disposed) return;
      if (!daemonRes?.ok || !daemonRes.handoffPrompt) {
        setHandoffFeedback(
          cid,
          'error',
          L(
            `生成交接单失败：${daemonRes?.error || 'unknown'}`,
            `Failed to build handoff: ${daemonRes?.error || 'unknown'}`
          )
        );
        return;
      }

      if (copyOnly) {
        const copied = await copyToClipboard(daemonRes.handoffPrompt);
        setHandoffFeedback(
          cid,
          copied ? 'ok' : 'warn',
          copied
            ? L('已复制无损交接单到剪贴板 ✓', 'Copied lossless handoff prompt ✓')
            : L('交接单已生成，但剪贴板写入受限。', 'Handoff built, but clipboard write failed.')
        );
        return;
      }

      // Path A: Daemon already created conversation cleanly (e.g. headless mode)
      if (daemonRes.mode === 'created' && daemonRes.newConversationId) {
        nextStepByCid.delete(cid);
        await copyToClipboard(daemonRes.handoffPrompt);
        window.__agClaudeUxBridge?.openConversationFromProject?.(daemonRes.newConversationId);
        window.__agClaudeUxBridge?.showProjectsFloatingNotice?.(
          L('已完成里程碑换窗交接 ✓', 'Milestone handoff chat started ✓')
        );
        closeMenu();
        return;
      }

      // Path B: Desktop renderer native launcher
      const launcher = window.__agClaudeUxBridge?.launchMilestoneHandoffChat;
      if (typeof launcher !== 'function') {
        await copyToClipboard(daemonRes.handoffPrompt);
        setHandoffFeedback(
          cid,
          'warn',
          L(
            '桌面建窗桥接不可用，已复制无损交接单到剪贴板 ✓',
            'Desktop launcher unavailable; copied handoff prompt ✓'
          )
        );
        return;
      }

      const launchRes = await launcher({
        projectId: hCtx.projectId || '',
        repoRoot: repoRoot || hCtx.repoRoot || daemonRes.repoRoot || '',
        prompt: daemonRes.handoffPrompt,
        expectedFromCid: cid,
      });
      if (disposed) return;

      if (launchRes?.ok && launchRes?.status === 'created') {
        nextStepByCid.delete(cid);
        closeMenu();
        window.__agClaudeUxBridge?.showProjectsFloatingNotice?.(
          L('已新建并切换到交接窗口 ✓', 'Switched to new handoff chat ✓')
        );
        return;
      }

      await copyToClipboard(daemonRes.handoffPrompt);
      if (launchRes?.status === 'uncertain') {
        setHandoffFeedback(
          cid,
          'warn',
          L(
            '交接已提交但新会话尚未确认出现，请先查看侧边栏避免重复创建；交接单已备份到剪贴板。',
            'Handoff submitted; check the sidebar before pasting to avoid duplicate chats (prompt copied).'
          ),
          8000
        );
      } else if (launchRes?.phase === 'scope_mismatch') {
        setHandoffFeedback(
          cid,
          'warn',
          L(
            '当前会话未绑定项目（或选择器仍指向其他项目/目录），已安全中止并复制交接单到剪贴板 ✓',
            'Aborted due to workspace/project scope mismatch; handoff prompt copied ✓'
          ),
          8000
        );
      } else {
        setHandoffFeedback(
          cid,
          'warn',
          L(
            `自动新建未完成（${launchRes?.error || 'unknown'}），已复制交接单到剪贴板 ✓`,
            `Auto-launch fell back (${launchRes?.error || 'unknown'}); handoff prompt copied ✓`
          ),
          6000
        );
      }
    } catch (err) {
      setHandoffFeedback(
        cid,
        'error',
        L(`换窗请求失败：${String(err?.message || err)}`, `Handoff error: ${String(err?.message || err)}`)
      );
    } finally {
      handoffInFlight = false;
      if (menuOpen && !disposed) renderMenuContents({ force: true });
    }
  }

  function renderMenuContents({ force = false } = {}) {
    if (disposed || typeof document === 'undefined') return;
    const pop = ensureMenuEl();
    if (!force && menuEl && menuEl.contains(document.activeElement) && document.activeElement?.matches?.('input, textarea, select')) {
      return;
    }
    const cid = getActiveRouteCid();
    const metricsGen = readMetricsGenForCid(cid);
    const cached = statusCache.cid === cid ? statusCache.data : null;
    const hCtx = resolveHandoffContext(cid);
    const data =
      cached ||
      (cid && metricsGen >= 1
        ? {
            compactionCount: metricsGen,
            proposals: [],
            activeAnchors: [],
            tokenBudget: { usedTokens: 0, maxTokens: 400 },
            repoRoot: hCtx.repoRoot,
          }
        : null);
    pop.replaceChildren();
    if (!data) return;
    if (!cached && cid) fetchStatus(cid, false);

    const hdr = document.createElement('div');
    hdr.className = 'agy-anc-hdr';
    const title = document.createElement('span');
    title.className = 'agy-anc-title';
    setLeafText(
      title,
      L(
        `抗漂移锚点 · 预算 ${data.tokenBudget?.usedTokens || 0}/${data.tokenBudget?.maxTokens || 400} tok`,
        `Anti-Drift Anchors · ${data.tokenBudget?.usedTokens || 0}/${data.tokenBudget?.maxTokens || 400} tok`
      )
    );
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'agy-anc-close';
    setLeafText(closeBtn, '×');
    closeBtn.addEventListener('click', () => closeMenu());
    hdr.append(title, closeBtn);
    pop.appendChild(hdr);

    const proposals = Array.isArray(data.proposals) ? data.proposals : [];
    const activeAnchors = Array.isArray(data.activeAnchors) ? data.activeAnchors : [];
    const budgetNearFull = (data.tokenBudget?.usedTokens || 0) >= (data.tokenBudget?.maxTokens || 400) - 45;

    if (proposals.length > 0) {
      for (const prop of proposals) {
        const card = document.createElement('div');
        card.className = 'agy-anc-card';

        const lblQuote = document.createElement('div');
        lblQuote.className = 'agy-anc-sub';
        setLeafText(lblQuote, L('你的原话约束（可微调后签发）', 'Your Verbatim Constraint (editable)'));

        const input = document.createElement('textarea');
        input.className = 'agy-anc-input';
        input.rows = 2;
        input.value = prop.verbatimQuote || '';

        card.append(lblQuote, input);

        if (prop.thinkingPreview) {
          const cotWrap = document.createElement('div');
          cotWrap.className = 'agy-anc-cot';
          const cotLbl = document.createElement('span');
          cotLbl.className = 'agy-anc-cot-lbl';
          setLeafText(cotLbl, L('模型当时思维链理解核对（仅预览，绝不入库）：', 'Model CoT Comprehension Check (preview only):'));
          const cotBody = document.createElement('div');
          cotBody.className = 'agy-anc-cot-body';
          setLeafText(cotBody, prop.thinkingPreview);
          cotWrap.append(cotLbl, cotBody);
          card.appendChild(cotWrap);
        }

        let evictSelect = null;
        if (budgetNearFull && activeAnchors.length > 0) {
          evictSelect = document.createElement('select');
          evictSelect.className = 'agy-anc-evict';
          const opt0 = document.createElement('option');
          opt0.value = '';
          setLeafText(opt0, L('若超 400 tok 上限，选择淘汰哪条旧锚点…', 'Select old anchor to evict if >400 tok…'));
          evictSelect.appendChild(opt0);
          for (const a of activeAnchors) {
            const opt = document.createElement('option');
            opt.value = a.id;
            setLeafText(opt, `[${a.id}] ${String(a.text || '').slice(0, 42)}`);
            evictSelect.appendChild(opt);
          }
          card.appendChild(evictSelect);
        }

        const actions = document.createElement('div');
        actions.className = 'agy-anc-actions';

        const acceptBtn = document.createElement('button');
        acceptBtn.type = 'button';
        acceptBtn.className = 'agy-anc-btn agy-anc-accept';
        setLeafText(acceptBtn, L('签发固化', 'Accept Anchor'));
        acceptBtn.addEventListener('click', () => {
          const idle = !isComposerRunning();
          window
            .__agProjectCall(
              'acceptAnchorProposal',
              {
                cascadeId: cid,
                proposalId: prop.id,
                editedText: input.value,
                repoRoot: data.repoRoot || prop.repoRoot,
                evictId: evictSelect ? evictSelect.value : '',
                flushNow: idle,
              },
              4000
            )
            .then(() => fetchStatus(cid, true))
            .catch(() => {});
        });

        const rejectBtn = document.createElement('button');
        rejectBtn.type = 'button';
        rejectBtn.className = 'agy-anc-btn agy-anc-reject';
        setLeafText(rejectBtn, L('忽略且不再提示', 'Reject & Mute'));
        rejectBtn.addEventListener('click', () => {
          window
            .__agProjectCall('rejectAnchorProposal', { cascadeId: cid, proposalId: prop.id }, 3000)
            .then(() => fetchStatus(cid, true))
            .catch(() => {});
        });

        actions.append(acceptBtn, rejectBtn);
        card.appendChild(actions);
        pop.appendChild(card);
      }
    }

    const genCount = Math.max(Number(data.compactionCount || 0), metricsGen);
    if (genCount >= 1) {
      const handoffBox = document.createElement('div');
      handoffBox.className = 'agy-anc-handoff';
      const scopeLabel = hCtx.projectName || (data.repoRoot ? String(data.repoRoot).split(/[\\/]/).filter(Boolean).pop() : '');
      const info = document.createElement('div');
      info.className = 'agy-anc-handoff-txt';
      setLeafText(
        info,
        genCount >= 3
          ? L(
              `当前已历经 G=${genCount} 次压缩（未固化约束半衰期 2–3 次）${scopeLabel ? ` · ${scopeLabel}` : ''}，建议交接至全新里程碑会话。`,
              `Compaction G=${genCount} (>=3 decay threshold)${scopeLabel ? ` · ${scopeLabel}` : ''}. Recommended: hand off to a fresh chat.`
            )
          : L(
              `当前压缩代数：G=${genCount}${scopeLabel ? ` · ${scopeLabel}` : ''}`,
              `Compaction generation: G=${genCount}${scopeLabel ? ` · ${scopeLabel}` : ''}`
            )
      );

      const curNextStep = nextStepByCid.get(cid) || '';
      const nextInput = document.createElement('input');
      nextInput.type = 'text';
      nextInput.className = 'agy-anc-next-input';
      nextInput.maxLength = 500;
      nextInput.placeholder = L(
        '新窗口接着做什么？（可选，留空则接管后待命）',
        'Next instruction for new chat (optional; blank = standby)'
      );
      nextInput.value = curNextStep;
      nextInput.disabled = handoffInFlight;
      nextInput.addEventListener('input', () => {
        nextStepByCid.set(cid, nextInput.value);
      });

      const runningNow = isComposerRunning();
      const actionRow = document.createElement('div');
      actionRow.className = 'agy-anc-handoff-actions';

      const handoffBtn = document.createElement('button');
      handoffBtn.type = 'button';
      handoffBtn.className = 'agy-anc-btn agy-anc-handoff-btn agy-anc-handoff-primary';
      handoffBtn.disabled = handoffInFlight || runningNow;
      setLeafText(
        handoffBtn,
        handoffInFlight
          ? L('正在新建并交接…', 'Handing off…')
          : runningNow
            ? L('请等待回复完成再换窗', 'Wait for reply to finish')
            : L('一键新建并交接', 'Start Handoff Chat')
      );
      handoffBtn.addEventListener('click', () => {
        executeHandoffAction({ cid, hCtx, repoRoot: data.repoRoot || hCtx.repoRoot, copyOnly: false });
      });

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'agy-anc-btn agy-anc-handoff-copy';
      copyBtn.disabled = handoffInFlight;
      setLeafText(copyBtn, L('仅复制', 'Copy Only'));
      copyBtn.addEventListener('click', () => {
        executeHandoffAction({ cid, hCtx, repoRoot: data.repoRoot || hCtx.repoRoot, copyOnly: true });
      });

      nextInput.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          if (!handoffBtn.disabled) handoffBtn.click();
        }
      });

      actionRow.append(handoffBtn, copyBtn);
      handoffBox.append(info, nextInput);

      if (hCtx.composerDraft && hCtx.composerDraft !== curNextStep.trim()) {
        const draftChip = document.createElement('button');
        draftChip.type = 'button';
        draftChip.className = 'agy-anc-draft-chip';
        setLeafText(draftChip, L('带入当前草稿', 'Use unsent draft'));
        draftChip.addEventListener('click', () => {
          nextStepByCid.set(cid, hCtx.composerDraft.slice(0, 500));
          renderMenuContents({ force: true });
          menuEl?.querySelector('.agy-anc-next-input')?.focus?.();
        });
        handoffBox.appendChild(draftChip);
      }

      handoffBox.appendChild(actionRow);

      if (handoffFeedback.cid === cid && handoffFeedback.text) {
        const fbEl = document.createElement('div');
        fbEl.className = 'agy-anc-handoff-feedback';
        setAttr(fbEl, 'data-tone', handoffFeedback.tone || 'ok');
        setLeafText(fbEl, handoffFeedback.text);
        handoffBox.appendChild(fbEl);
      }

      pop.appendChild(handoffBox);
    }
  }

  function syncPillDom() {
    if (disposed || typeof document === 'undefined') return;
    const cid = getActiveRouteCid();
    const box = getMainBox();
    const footer = box?.querySelector('.agy-composer-footer');
    const leftGroup = footer?.children?.[0] || null;
    let existing = document.getElementById(PILL_ID);
    if (existing && existing.tagName !== 'DIV') {
      // Defensive hot-reload migration: top-level Row 1 pills MUST be <div> so they never steal
      // `:scope > button:first-of-type` from Antigravity's native `+ Add context` button.
      existing.remove();
      existing = null;
    }

    if (!isEnabled() || !cid || !leftGroup) {
      if (existing) existing.hidden = true;
      closeMenu();
      return;
    }

    const data = statusCache.cid === cid ? statusCache.data : null;
    const propCount = Array.isArray(data?.proposals) ? data.proposals.length : 0;
    const metricsGen = readMetricsGenForCid(cid);
    const genCount = Math.max(Number(data?.compactionCount || 0), metricsGen);
    const shouldShow = propCount > 0 || genCount >= 3;

    if (!shouldShow) {
      if (existing) existing.hidden = true;
      if (menuOpen) closeMenu();
      return;
    }

    let pill = existing;
    if (!pill) {
      pill = document.createElement('div');
      pill.id = PILL_ID;
      pill.className = 'agy-anchors-pill';
      markOwn(pill);
      const goBtn = document.createElement('button');
      goBtn.type = 'button';
      goBtn.className = 'agy-anchors-go';
      const ico = document.createElement('span');
      ico.className = 'agy-anchors-icon';
      ico.setAttribute('aria-hidden', 'true');
      setLeafText(ico, '⚓');
      const txt = document.createElement('span');
      txt.className = 'agy-anchors-pill-lbl';
      goBtn.append(ico, txt);
      pill.appendChild(goBtn);
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (menuOpen) {
          closeMenu();
        } else {
          menuOpen = true;
          const pop = ensureMenuEl();
          renderMenuContents({ force: true });
          positionMenu(pill);
          setAttr(pop, 'data-open', 'true');
        }
      });
    } else {
      markOwn(pill);
    }

    if (pill.parentElement !== leftGroup) {
      const acEl = document.getElementById('agy-auto-compact-pill');
      const opusEl = document.getElementById('agy-opus-gate-pill');
      const resumeEl = document.getElementById('agy-resume-pill');
      const anchor =
        acEl?.parentElement === leftGroup
          ? acEl
          : opusEl?.parentElement === leftGroup
            ? opusEl
            : resumeEl?.parentElement === leftGroup
              ? resumeEl
              : null;
      if (anchor) {
        anchor.insertAdjacentElement('afterend', pill);
      } else {
        leftGroup.insertBefore(pill, leftGroup.firstChild);
      }
    }
    pill.hidden = false;
    setAttr(pill, 'data-warn', genCount >= 3 ? '1' : '0');
    const lblEl = pill.querySelector('.agy-anchors-pill-lbl');
    const goBtn = pill.querySelector('.agy-anchors-go');
    const labelText =
      propCount > 0
        ? L(`锚点待签 (${propCount})`, `Anchors (${propCount})`)
        : L(`G${genCount} · 建议换窗`, `G${genCount} · Handoff`);
    if (lblEl) setLeafText(lblEl, labelText);
    const tipText =
      propCount > 0
        ? L(`有 ${propCount} 条约束锚点待人工签发`, `${propCount} anchor constraint(s) awaiting approval`)
        : L(
            `已历经 G=${genCount} 次压缩，点击打开无损里程碑交接面板`,
            `Compaction generation G=${genCount}; click to open Milestone Handoff`
          );
    if (goBtn) {
      if (goBtn.title !== tipText) goBtn.title = tipText;
      setAttr(goBtn, 'aria-label', labelText);
    }
  }

  const onDocClick = (e) => {
    if (!menuOpen || !menuEl) return;
    const pill = document.getElementById(PILL_ID);
    if (menuEl.contains(e.target) || pill?.contains(e.target)) return;
    closeMenu();
  };
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('mousedown', onDocClick, true);
  }

  const offStudioPrefs = studioPrefs?.subscribe?.(() => {
    if (disposed) return;
    if (!isEnabled()) {
      syncPillDom();
      return;
    }
    const curCid = getActiveRouteCid();
    if (curCid && statusCache.cid !== curCid) fetchStatus(curCid, true);
    syncPillDom();
  });

  return {
    topics: ['composer', 'metrics'],
    read(snapshot) {
      const cid = snapshot ? snapshot.cid : getActiveRouteCid();
      const running = snapshot ? snapshot.isRunning : isComposerRunning();
      return { cid, running };
    },
    write(_snapshot, plan) {
      if (disposed || !plan) return;
      const { cid, running } = plan;
      if (cid !== prevCid) {
        prevCid = cid;
        closeMenu();
        if (cid && isEnabled()) fetchStatus(cid, true);
      } else if (prevRunning === true && running === false && cid && isEnabled()) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = 0;
          if (!disposed) fetchStatus(cid, true);
        }, 450);
      }
      prevRunning = running;
      syncPillDom();
    },
    dispose() {
      disposed = true;
      offStudioPrefs?.();
      handoffInFlight = false;
      nextStepByCid.clear();
      handoffFeedback = { cid: '', tone: '', text: '' };
      if (handoffFeedbackTimer) clearTimeout(handoffFeedbackTimer);
      if (settleTimer) clearTimeout(settleTimer);
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('mousedown', onDocClick, true);
      }
      document.getElementById(PILL_ID)?.remove();
      document.getElementById(MENU_ID)?.remove();
    },
  };
}
