/**
 * Inline Undo & Edit (Claude-style in-bubble message re-edit with revert previews).
 */
export function createInlineUndoModule(rt) {
  const { FEAT, L, state: rtState, frame, later, escapeHtml, hooks, platform } = rt;
  const discoverAgentInputProps = (...args) => hooks.discoverAgentInputProps?.(...args);

  /* ==========================================================================
   * 7. Inline Undo & Edit (Claude-Style Message In-Bubble Re-Edit)
   *    - Intercepts `button[data-testid="revert-button"]` to expand a clean
   *      in-bubble editor without wiping downstream turns until confirmed.
   *    - 100% delegates file revert previews & Lexical state to native host.
   * ========================================================================== */
  rtState.activeInlineEdit = null;
  let inlineUndoBusy = false;

  function activeReactFiber(el) {
    if (!el) return null;
    const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let fiber = fk ? el[fk] : null;
    let top = fiber;
    while (top && top.return) top = top.return;
    if (top && top.stateNode && top.stateNode.current && top.stateNode.current !== top) {
      fiber = (fiber && fiber.alternate) || fiber;
    }
    return fiber;
  }

  function resolveNativeRevertTarget(button) {
    let state = null;
    let context = null;
    let session;
    let index;
    let text;
    let rawItems = null;
    for (let f = activeReactFiber(button), depth = 0; f && depth < 65; f = f.return, depth++) {
      const props = f.memoizedProps;
      if (!state && props && props.revertState) state = props.revertState;
      if (session === undefined && props && typeof props.cascadeId === 'string') session = props.cascadeId;
      if (index === undefined && props && Number.isInteger(props.userStepIndex)) index = props.userStepIndex;
      if (text === undefined && props && Array.isArray(props.items)) {
        rawItems = props.items.slice();
        text = props.items
          .filter((it) => it && it.chunk && it.chunk.case === 'text')
          .map((it) => it.chunk.value || '')
          .join('');
      }
      for (let d = f.dependencies && f.dependencies.firstContext; d; d = d.next) {
        const val = d.memoizedValue;
        if (!context && val && val.stepHandler && val.stepHandler.getRevertPreviews && val.inputBoxRef) {
          context = val;
        }
      }
      if (state && context && session && index !== undefined && text !== undefined) break;
    }
    if (!state || !state.canRevert || !state.revertPreviewState || !state.revertPreviewState.revert || !context || !session || index === undefined) {
      return null;
    }
    const stepEl = button.closest && button.closest('[data-testid="user-input-step"]');
    if (text === undefined) {
      const q =
        stepEl &&
        stepEl.querySelector('[data-testid="user-message-content"] [data-quotable="true"], [data-testid="user-message-content"]');
      text = (q && q.textContent) || '';
    }
    const nonTextItems = Array.isArray(rawItems)
      ? rawItems.filter((it) => it && it.chunk && it.chunk.case === 'item')
      : [];
    const hasDomRichItems = Boolean(
      stepEl &&
        stepEl.querySelector('[data-uri], bdi.context-scope-mention, [data-testid="skill-scope-item-pill"], [data-testid="context-scope-item-cider"]')
    );
    const hasRichItems = nonTextItems.length > 0 || hasDomRichItems;
    return { state: state.revertPreviewState, context, session, index, text, rawItems, nonTextItems, hasRichItems, stepEl };
  }

  function getComposerLexicalRoot(context) {
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    return ref && ref.lexicalRef && ref.lexicalRef.current && ref.lexicalRef.current.getRootElement
      ? ref.lexicalRef.current.getRootElement()
      : null;
  }

  function composerHasExistingDraft(context) {
    const rootEl = getComposerLexicalRoot(context);
    if (rootEl && (rootEl.textContent || '').trim()) return true;
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    const media = ref && typeof ref.getMediaAttachments === 'function' ? ref.getMediaAttachments() : null;
    return Boolean(media && media.length);
  }

  function setComposerText(context, text) {
    const value = String(text ?? '');
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    const ed = ref && ref.lexicalRef && ref.lexicalRef.current;
    if (ed && ed._nodes && typeof ed.update === 'function') {
      const ParaNode = ed._nodes.get('paragraph') && ed._nodes.get('paragraph').klass;
      const TextNode = ed._nodes.get('text') && ed._nodes.get('text').klass;
      const LineBreakNode = ed._nodes.get('linebreak') && ed._nodes.get('linebreak').klass;
      if (ParaNode && TextNode) {
        ed.update(
          () => {
            const rootNode = ed.getEditorState()._nodeMap.get('root')?.getWritable?.();
            if (!rootNode) return;
            rootNode.clear();
            const p = new ParaNode();
            value.split(/\r?\n/).forEach((line, i) => {
              if (i > 0 && LineBreakNode) p.append(new LineBreakNode());
              if (line) p.append(new TextNode(line));
            });
            rootNode.append(p);
            if (typeof p.selectEnd === 'function') p.selectEnd();
          },
          { discrete: true }
        );
        return;
      }
    }
    const el = getComposerLexicalRoot(context);
    if (el) el.textContent = value;
  }

  function buildRebuiltRichItems(rawItems, nextText) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
    const preserved = rawItems.filter((it) => it && it.chunk && it.chunk.case !== 'text');
    if (preserved.length === 0) return null;
    const out = preserved.slice();
    const val = String(nextText ?? '');
    if (val) {
      out.push({
        $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
        chunk: { case: 'text', value: val }
      });
    }
    return out;
  }

  async function performNativeRevert(target) {
    const handler = target.context.stepHandler;
    const orig = handler.revertToIndex;
    let pending = null;
    let resolveCalled = null;
    const calledPromise = new Promise((r) => {
      resolveCalled = r;
    });
    const wrapped = function (...args) {
      const res = orig.apply(this, args);
      if (args[0] === target.session && args[1] === target.index - 1) {
        pending = Promise.resolve(res);
        resolveCalled(true);
      }
      return res;
    };
    handler.revertToIndex = wrapped;
    try {
      const ret = target.state.revert();
      if (ret && typeof ret.then === 'function') {
        await ret;
      }
      if (!pending) {
        /* Support async native revert implementations that call revertToIndex on a later microtask/tick */
        await Promise.race([calledPromise, new Promise((r) => setTimeout(r, 250))]);
      }
    } finally {
      if (handler.revertToIndex === wrapped) {
        handler.revertToIndex = orig;
      }
    }
    if (pending) {
      await pending;
      await new Promise((r) => setTimeout(r, 0));
      return;
    }
    if (target.stepEl && !target.stepEl.isConnected) {
      await new Promise((r) => setTimeout(r, 0));
      return;
    }
    throw new Error('revert_not_dispatched');
  }

  async function submitComposerAfterRevert(context, composerEl) {
    await new Promise((r) => setTimeout(r, 360));
    if (rtState.disposed) return;
    const ref = context && context.inputBoxRef && context.inputBoxRef.current;
    if (ref && typeof ref.submit === 'function') {
      ref.submit();
      return;
    }
    const scope =
      (getComposerLexicalRoot(context) && getComposerLexicalRoot(context).closest('[data-testid="agent-input-box"]')) ||
      composerEl ||
      document;
    const sendBtn = scope.querySelector(
      'button[data-testid="input-send-button"]:not(:disabled), button[aria-label="Send message"]:not(:disabled), button[aria-label*="发送"]:not(:disabled)'
    );
    if (sendBtn) sendBtn.click();
  }

  function closeInlineEdit(restoreFocus) {
    if (!rtState.activeInlineEdit) return;
    const { button, bubble, contentEl, hosts, editorBox } = rtState.activeInlineEdit;
    rtState.activeInlineEdit = null;
    inlineUndoBusy = false;
    if (editorBox && editorBox.parentNode) editorBox.remove();
    if (bubble) bubble.classList.remove('ag-claude-editing-bubble');
    if (hosts) hosts.forEach((h) => h.classList.remove('ag-claude-editing-host'));
    if (contentEl) {
      contentEl.hidden = false;
      contentEl.classList.remove('ag-claude-inline-hidden');
    }
    if (restoreFocus && button && button.isConnected && typeof button.focus === 'function') {
      button.focus({ preventScroll: true });
    }
  }

  function renderInlineEditMeta(stObj) {
    if (!stObj || rtState.activeInlineEdit !== stObj) return;
    const { editorBox, button } = stObj;
    const metaEl = editorBox.querySelector('[data-ag-inline-meta]');
    const filesEl = editorBox.querySelector('[data-ag-inline-files]');
    if (!metaEl) return;
    const cur = resolveNativeRevertTarget(button) || stObj.target;
    const rState = cur.state;
    const convOnly = stObj.conversationOnly !== undefined ? stObj.conversationOnly : Boolean(rState.conversationOnly);
    const loading = !convOnly && stObj.preview === null && !stObj.previewError;
    const fileSummary = convOnly
      ? L('仅撤回对话 · 保留文件修改', 'Chat only · keep file edits')
      : loading
        ? L('正在检查变更文件…', 'Checking modified files…')
        : stObj.previewError
          ? L('文件预览获取失败', 'Failed to preview file changes')
          : stObj.preview && stObj.preview.length
            ? L(`还原 ${stObj.preview.length} 个文件`, `Revert ${stObj.preview.length} ${stObj.preview.length === 1 ? 'file' : 'files'}`)
            : L('无关联文件变更', 'No modified files');
    const hasMedia = Boolean(
      stObj.bubble && stObj.bubble.querySelector('.agy-user-bubble-header, img, [data-testid*="attachment"], [data-testid*="media"]')
    );
    const hasRichRefs = Boolean(cur && cur.hasRichItems);
    const isMac = !platform || platform === 'darwin';
    metaEl.innerHTML =
      (rState.conversationOnlyRevertEnabled
        ? `<button type="button" class="ag-claude-switch" role="switch" data-ag-revert-files-switch aria-label="${escapeHtml(L('同步撤回文件修改', 'Revert modified files'))}" aria-checked="${!convOnly}"><span></span></button><span>${L('同步撤回文件', 'Revert files')}</span><span style="opacity:0.45">·</span>`
        : '') +
      `<span>${escapeHtml(fileSummary)}</span>` +
      (hasRichRefs
        ? `<span style="opacity:0.75" title="${escapeHtml(L(`自动保留原消息中的 @ 引用、斜杠命令与技能胶囊；按住 ${isMac ? '⌥' : 'Alt'} 点撤回可打开官方撤回界面`, `Preserves original @ mentions, slash commands & skills; ${isMac ? 'Option' : 'Alt'}+click Revert for native UI`))}">· ${L('保留原引用', 'Keep mentions')}</span>`
        : '') +
      (hasMedia
        ? `<span style="opacity:0.75" title="${escapeHtml(L('重发时自动保留原消息图片/附件；如需增删附件请点「移至底栏」', 'Keeps original attachments on resend; click Move to input to edit attachments'))}">· ${L('保留原附件', 'Keep attachments')}</span>`
        : '');

    if (filesEl) {
      if (!convOnly && !loading && !stObj.previewError && stObj.preview && stObj.preview.length) {
        const chips = stObj.preview
          .slice(0, 8)
          .map((p) => {
            const raw = String(p.fileUri || p.uri || 'file');
            const base = decodeURIComponent(raw.split('/').pop() || raw);
            return `<span class="ag-claude-inline-file-chip">${escapeHtml(base)}</span>`;
          })
          .join('');
        const extra = stObj.preview.length > 8 ? `<span class="ag-claude-inline-file-chip">+${stObj.preview.length - 8}</span>` : '';
        filesEl.innerHTML = `<div>${L(`撤回此步将一并还原以下 ${stObj.preview.length} 个文件至提问前状态：`, `Reverting will restore these ${stObj.preview.length} ${stObj.preview.length === 1 ? 'file' : 'files'}:`)}</div><div class="ag-claude-inline-file-chips">${chips}${extra}</div>`;
      } else {
        filesEl.innerHTML = '';
      }
    }

    const sw = metaEl.querySelector('[data-ag-revert-files-switch]');
    if (sw) {
      sw.addEventListener('click', () => {
        const latest = resolveNativeRevertTarget(button) || stObj.target;
        const nextConvOnly = !(stObj.conversationOnly ?? Boolean(latest.state.conversationOnly));
        stObj.conversationOnly = nextConvOnly;
        if (typeof latest.state.setConversationOnly === 'function') {
          latest.state.setConversationOnly(nextConvOnly);
        }
        if (!nextConvOnly && !stObj.previewLoaded && !stObj.previewError) {
          stObj.preview = null;
          renderInlineEditMeta(stObj);
          loadInlineRevertPreview(stObj);
          return;
        }
        renderInlineEditMeta(stObj);
      });
    }
  }

  async function loadInlineRevertPreview(stObj) {
    if (!stObj || stObj.previewLoading) return;
    stObj.previewLoading = true;
    try {
      const preview = await stObj.target.context.stepHandler.getRevertPreviews(stObj.target.session, stObj.target.index - 1);
      if (rtState.activeInlineEdit !== stObj) return;
      stObj.preview = Array.isArray(preview) ? preview : [];
      stObj.previewLoaded = true;
    } catch (err) {
      if (rtState.activeInlineEdit !== stObj) return;
      stObj.previewError = String((err && err.message) || err);
    } finally {
      stObj.previewLoading = false;
    }
    renderInlineEditMeta(stObj);
  }

  async function applyInlineUndo(shouldSubmit) {
    const stObj = rtState.activeInlineEdit;
    if (!stObj || inlineUndoBusy) return;
    let current = resolveNativeRevertTarget(stObj.button) || stObj.target;
    if (!current) return;
    inlineUndoBusy = true;
    const { editorBox } = stObj;
    const ta = editorBox.querySelector('.ag-claude-inline-textarea');
    if (ta) {
      stObj.draftText = ta.value;
      ta.disabled = true;
    }
    editorBox.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    const warnEl = editorBox.querySelector('[data-ag-inline-warn]');
    if (warnEl) warnEl.textContent = shouldSubmit ? L('正在撤回并重发…', 'Reverting and resending…') : L('正在移至底栏…', 'Moving to composer…');

    const rootEl = getComposerLexicalRoot(current.context);
    const composerEl = (rootEl && rootEl.closest('[data-testid="agent-input-box"]')) || null;
    try {
      if (
        current.state &&
        current.state.conversationOnlyRevertEnabled &&
        stObj.conversationOnly !== undefined &&
        current.state.conversationOnly !== stObj.conversationOnly
      ) {
        current.state.setConversationOnly(stObj.conversationOnly);
        await new Promise((r) => setTimeout(r, 30));
        current = resolveNativeRevertTarget(stObj.button) || current;
      }
      await performNativeRevert(current);
      if (rtState.disposed || rtState.activeInlineEdit !== stObj) return;
      const textUnchanged = stObj.draftText === (stObj.target.text || '');
      const rebuiltRichItems =
        shouldSubmit && current.hasRichItems ? buildRebuiltRichItems(current.rawItems, stObj.draftText) : null;
      const agentPropsForRich = rebuiltRichItems ? discoverAgentInputProps(composerEl || rootEl) : null;
      if (rebuiltRichItems && agentPropsForRich && typeof agentPropsForRich.handleSubmit === 'function') {
        const ref = current.context && current.context.inputBoxRef && current.context.inputBoxRef.current;
        const media = ref && typeof ref.getMediaAttachments === 'function' ? ref.getMediaAttachments() : [];
        closeInlineEdit(false);
        await new Promise((r) => setTimeout(r, 360));
        if (rtState.disposed) return;
        await agentPropsForRich.handleSubmit(rebuiltRichItems, Array.isArray(media) ? media : [], () => {});
        return;
      }
      /* Preserve rich Lexical mention/slash/skill nodes restored by native revert when text was not modified */
      if (!(current.hasRichItems && textUnchanged)) {
        setComposerText(current.context, stObj.draftText);
      }
      closeInlineEdit(false);
      if (shouldSubmit) {
        await submitComposerAfterRevert(current.context, composerEl);
      } else {
        const nextRoot = getComposerLexicalRoot(current.context);
        if (nextRoot && typeof nextRoot.focus === 'function') nextRoot.focus();
      }
    } catch (err) {
      inlineUndoBusy = false;
      if (rtState.activeInlineEdit !== stObj) return;
      if (ta) ta.disabled = false;
      editorBox.querySelectorAll('button').forEach((b) => {
        b.disabled = false;
      });
      if (warnEl) warnEl.textContent = L('撤回失败，请重试', 'Revert failed, please try again');
    }
  }

  function openInlineEdit(button, target) {
    const stepEl = button.closest && button.closest('[data-testid="user-input-step"]');
    const bubble = (stepEl && stepEl.querySelector('[data-testid="user-message-bubble"]')) || button.parentElement;
    if (!bubble) return;
    const contentEl = bubble.querySelector('[data-testid="user-message-content"]');
    const hosts = [];
    for (let el = bubble.parentElement; el && el !== stepEl; el = el.parentElement) {
      const cls = String(el.className || '');
      if (el.classList.contains('agy-user-bubble-frame') || cls.includes('max-w-')) {
        hosts.push(el);
      }
    }
    bubble.classList.add('ag-claude-editing-bubble');
    hosts.forEach((h) => h.classList.add('ag-claude-editing-host'));
    if (contentEl) {
      contentEl.hidden = true;
      contentEl.classList.add('ag-claude-inline-hidden');
    }

    const editorBox = document.createElement('div');
    editorBox.className = 'ag-claude-inline-editor';
    editorBox.setAttribute('data-ag-i18n-ignore', '1');
    editorBox.setAttribute('role', 'region');
    editorBox.setAttribute('aria-label', L('原地编辑消息', 'Edit message inline'));
    editorBox.addEventListener('click', (ev) => ev.stopPropagation());

    const convOnly = Boolean(target.state && target.state.conversationOnly);
    const stObj = {
      button,
      target,
      bubble,
      contentEl,
      hosts,
      editorBox,
      draftText: target.text || '',
      conversationOnly: convOnly,
      preview: convOnly ? [] : null,
      previewError: '',
      previewLoaded: convOnly,
      previewLoading: false
    };
    rtState.activeInlineEdit = stObj;

    editorBox.innerHTML = `
      <textarea class="ag-claude-inline-textarea" aria-label="${escapeHtml(L('编辑消息内容', 'Edit message'))}" rows="1"></textarea>
      <div class="ag-claude-inline-files" data-ag-inline-files></div>
      <div class="ag-claude-inline-footer">
        <div class="ag-claude-inline-meta">
          <span data-ag-inline-meta style="display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap"></span>
          <span class="ag-claude-inline-warn" data-ag-inline-warn role="status"></span>
        </div>
        <div class="ag-claude-inline-actions">
          <button type="button" class="ag-claude-inline-btn" data-ag-inline-cancel>${L('取消', 'Cancel')}</button>
          <button type="button" class="ag-claude-inline-btn" data-ag-inline-bottom title="${escapeHtml(L('撤回并移回底部输入框（可增删图片附件或切换模型）', 'Revert and move to bottom input (to edit attachments or switch model)'))}">${L('移至底栏', 'Move to input')}</button>
          <button type="button" class="ag-claude-inline-btn" data-primary="true" data-ag-inline-send>${L('重发', 'Resend')}</button>
        </div>
      </div>
    `;
    bubble.appendChild(editorBox);

    const ta = editorBox.querySelector('.ag-claude-inline-textarea');
    ta.value = stObj.draftText;
    const autoResize = () => {
      ta.style.height = 'auto';
      const h = Number(ta.scrollHeight) || 26;
      ta.style.height = `${Math.min(240, Math.max(26, h))}px`;
    };
    autoResize();
    ta.addEventListener('input', () => {
      stObj.draftText = ta.value;
      autoResize();
    });
    ta.addEventListener('keydown', (ev) => {
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        ev.stopPropagation();
        applyInlineUndo(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeInlineEdit(true);
      }
    });
    editorBox.querySelector('[data-ag-inline-cancel]').addEventListener('click', () => closeInlineEdit(true));
    editorBox.querySelector('[data-ag-inline-bottom]').addEventListener('click', () => applyInlineUndo(false));
    editorBox.querySelector('[data-ag-inline-send]').addEventListener('click', () => applyInlineUndo(true));

    renderInlineEditMeta(stObj);
    if (composerHasExistingDraft(target.context)) {
      const warnEl = editorBox.querySelector('[data-ag-inline-warn]');
      if (warnEl) warnEl.textContent = L('将覆盖底栏现有草稿', 'Will replace current composer draft');
    }
    if (typeof ta.focus === 'function') {
      ta.focus({ preventScroll: true });
      const len = ta.value.length;
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(len, len);
    }
    if (!convOnly) loadInlineRevertPreview(stObj);
  }

  const onRevertButtonClick = (e) => {
    if (rtState.disposed || !FEAT.inlineUndo || e.altKey) return;
    const btn = e.target && e.target.closest && e.target.closest('button[data-testid="revert-button"]');
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
    const target = resolveNativeRevertTarget(btn);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (inlineUndoBusy) return;
    if (rtState.activeInlineEdit && rtState.activeInlineEdit.button === btn) {
      closeInlineEdit(true);
      return;
    }
    closeInlineEdit(false);
    openInlineEdit(btn, target);
  };

  const onInlineEditDocKeyDown = (e) => {
    if (rtState.disposed || !rtState.activeInlineEdit || inlineUndoBusy) return;
    if (!rtState.activeInlineEdit.editorBox || !rtState.activeInlineEdit.editorBox.isConnected) {
      closeInlineEdit(false);
      return;
    }
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      closeInlineEdit(true);
    }
  };

  document.addEventListener('click', onRevertButtonClick, true);
  document.addEventListener('keydown', onInlineEditDocKeyDown, true);


  function dispose() {
    document.removeEventListener('click', onRevertButtonClick, true);
    document.removeEventListener('keydown', onInlineEditDocKeyDown, true);
    closeInlineEdit(false);
  }

  return {
    activeReactFiber,
    composerHasExistingDraft,
    setComposerText,
    closeInlineEdit,
    renderInlineEditMeta,
    dispose,
  };
}
