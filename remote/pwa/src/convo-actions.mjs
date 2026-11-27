/**
 * AGY Studio Remote PWA — Conversation Write & Model Action Handlers
 * Pure logic controller; avoids any HTML injection or DOM globals beyond callbacks.
 */
import { compressImageFile } from './composer-bar.mjs';
import { formatWriteError, saveConversationDraft } from './mobile-enhancements.mjs';
import { requiresTurboAck } from './ui-helpers.mjs';

export function createConvoActionHandlers({
  state,
  getWsClient,
  canSteer,
  createIdempotencyKey,
  setActionNotice,
  syncComposerControls,
  renderDetailTimeline,
  fetchAndRenderSnapshot,
  refreshAllData,
}) {
  let cancelConfirmTimer = null;

  function resetCancelConfirm() {
    state.cancelConfirmArmedCid = '';
    if (cancelConfirmTimer) {
      clearTimeout(cancelConfirmTimer);
      cancelConfirmTimer = null;
    }
  }

  async function attachImageFiles(files) {
    if (!canSteer()) return;
    const list = Array.isArray(files) ? files : [];
    for (const file of list) {
      if (state.draftMedia.length >= 4) {
        state.actionError = '单次最多附带 4 张图片';
        break;
      }
      try {
        const processed = await compressImageFile(file);
        state.draftMedia = state.draftMedia.concat(processed);
        state.draftIdempotencyKey = createIdempotencyKey();
        state.actionError = '';
      } catch (err) {
        state.actionError = formatWriteError(err);
      }
    }
    syncComposerControls();
  }

  async function handleSelectModelOption(opt) {
    const wsClient = getWsClient();
    if (!wsClient || !canSteer() || state.modelSelectBusy || !opt) return;
    state.modelSelectBusy = true;
    state.modelPopoverOpen = false;
    state.actionError = '';
    state.actionNotice = '';
    syncComposerControls();
    try {
      const res = await wsClient.selectModel({
        cascadeId: state.selectedId || '',
        model: opt.model,
        plannerModel: opt.plannerModel ?? null,
        customLabel: opt.customLabel || '',
      });
      if (res?.catalog) {
        state.modelCatalog = res.catalog;
      } else if (res?.selected && state.modelCatalog) {
        state.modelCatalog = { ...state.modelCatalog, selected: res.selected };
      }
      state.actionNotice = '';
      setActionNotice(res?.selected?.label ? `已切换为 ${res.selected.label}` : '模型已切换');
    } catch (err) {
      state.actionError = formatWriteError(err);
    } finally {
      state.modelSelectBusy = false;
      syncComposerControls();
    }
  }

  async function handleSendDraft() {
    const wsClient = getWsClient();
    if (!wsClient || !state.selectedId || !canSteer() || state.sendBusy) return;
    if (!state.draftText.trim() && state.draftMedia.length === 0) return;
    const turboAckShown = requiresTurboAck(state.globalPreset);
    const confirmed = Boolean(turboAckShown && state.turboWriteConfirmed);
    if (turboAckShown && !confirmed) {
      state.actionError = '请先勾选 TURBO / 未知权限高危确认框';
      state.actionNotice = '';
      syncComposerControls();
      return;
    }
    const targetCid = state.selectedId;
    const textSnapshot = state.draftText;
    const mediaSnapshot = state.draftMedia.slice();
    const keySnapshot = state.draftIdempotencyKey;
    state.sendBusy = true;
    state.actionError = '';
    state.actionNotice = '';
    syncComposerControls();
    try {
      await wsClient.sendMessage(targetCid, textSnapshot, {
        idempotencyKey: keySnapshot,
        turboWriteConfirmed: confirmed,
        media: mediaSnapshot,
      });
      if (state.selectedId === targetCid) {
        if (state.draftText === textSnapshot) {
          state.draftText = '';
        }
        if (state.draftMedia.length === mediaSnapshot.length) {
          state.draftMedia = [];
        }
        state.draftIdempotencyKey = createIdempotencyKey();
        setActionNotice(mediaSnapshot.length > 0 ? '指令与图片已发送至桌面端' : '指令已发送至桌面端');
      }
      saveConversationDraft(targetCid, '');
      fetchAndRenderSnapshot(targetCid);
    } catch (err) {
      if (err?.code === 'idempotency_key_conflict' || err?.code === 'outcome_unknown') {
        state.draftIdempotencyKey = createIdempotencyKey();
        if (err?.code === 'outcome_unknown') {
          fetchAndRenderSnapshot(targetCid);
        }
      }
      if (err?.code === 'turbo_write_confirmation_required') {
        state.turboWriteConfirmed = false;
      }
      if (state.selectedId === targetCid) {
        state.actionError = formatWriteError(err);
      }
    } finally {
      state.sendBusy = false;
      syncComposerControls();
    }
  }

  async function handleApproveStep(w, decision, extra = null) {
    const wsClient = getWsClient();
    if (!wsClient || !state.selectedId || !canSteer() || state.approvingHash) return;
    const targetCid = state.selectedId;
    const waitingHash = String(w?.waitingStepHash || '');
    const ansSig = extra?.answers ? JSON.stringify(extra.answers) : '';
    const approveMapKey = `${targetCid}:${w?.stepIndex ?? ''}:${waitingHash}:${decision}:${ansSig}`;
    let approveKey = state.pendingApproveKeys.get(approveMapKey);
    if (!approveKey) {
      approveKey = createIdempotencyKey();
      state.pendingApproveKeys.set(approveMapKey, approveKey);
    }
    state.approvingHash = waitingHash;
    state.actionError = '';
    state.actionNotice = '';
    renderDetailTimeline();
    syncComposerControls();
    try {
      await wsClient.approveWaitingStep(targetCid, {
        stepIndex: w.stepIndex,
        waitingStepHash: waitingHash,
        decision,
        answers: extra?.answers || null,
        idempotencyKey: approveKey,
      });
      state.pendingApproveKeys.delete(approveMapKey);
      if (state.selectedId === targetCid) {
        const notices = {
          allow_once: '已允许本次执行 (Allow Once)',
          answer_question: '已提交你的选择',
          cancel_question: '已取消提问',
        };
        setActionNotice(notices[decision] || '已拒绝该操作 (Deny)');
      }
      refreshAllData();
    } catch (err) {
      const code = err?.code;
      if (code === 'waiting_step_mismatch' || code === 'idempotency_key_conflict' || code === 'outcome_unknown') {
        state.pendingApproveKeys.delete(approveMapKey);
        if (code === 'waiting_step_mismatch' || code === 'outcome_unknown') {
          refreshAllData();
        }
      }
      if (state.selectedId === targetCid) {
        state.actionError = formatWriteError(err);
      }
    } finally {
      state.approvingHash = '';
      renderDetailTimeline();
      syncComposerControls();
    }
  }

  async function handleCancelConvo() {
    const wsClient = getWsClient();
    if (!wsClient || !state.selectedId || !canSteer() || state.cancelBusy) return;
    const targetCid = state.selectedId;
    if (state.cancelConfirmArmedCid !== targetCid) {
      resetCancelConfirm();
      state.cancelConfirmArmedCid = targetCid;
      cancelConfirmTimer = setTimeout(() => {
        if (state.cancelConfirmArmedCid === targetCid) {
          state.cancelConfirmArmedCid = '';
          cancelConfirmTimer = null;
          syncComposerControls();
        }
      }, 4000);
      syncComposerControls();
      return;
    }
    resetCancelConfirm();
    state.cancelBusy = true;
    state.actionError = '';
    state.actionNotice = '';
    syncComposerControls();
    try {
      await wsClient.cancelConversation(targetCid, { killBackgroundTasks: false });
      if (state.selectedId === targetCid) {
        setActionNotice('已发送停止指令');
      }
      refreshAllData();
    } catch (err) {
      if (err?.code === 'outcome_unknown') {
        refreshAllData();
      }
      if (state.selectedId === targetCid) {
        state.actionError = formatWriteError(err);
      }
    } finally {
      state.cancelBusy = false;
      syncComposerControls();
    }
  }

  async function handleResumeConvo(rs) {
    const wsClient = getWsClient();
    if (!wsClient || !state.selectedId || !canSteer() || state.resumeBusy) return;
    const targetCid = state.selectedId;
    const expectedLastIdx = rs?.lastIdx;
    if (!Number.isInteger(expectedLastIdx) || expectedLastIdx < 0) return;
    const turboAckShown = requiresTurboAck(state.globalPreset);
    const confirmed = Boolean(turboAckShown && state.turboWriteConfirmed);
    if (turboAckShown && !confirmed) {
      state.actionError = '请先勾选 TURBO / 未知权限高危确认框';
      state.actionNotice = '';
      syncComposerControls();
      return;
    }
    const mapKey = `${targetCid}:${expectedLastIdx}`;
    let idempotencyKey = state.pendingResumeKeys.get(mapKey);
    if (!idempotencyKey) {
      idempotencyKey = createIdempotencyKey();
      state.pendingResumeKeys.set(mapKey, idempotencyKey);
    }
    state.resumeBusy = true;
    state.actionError = '';
    state.actionNotice = '';
    syncComposerControls();
    try {
      await wsClient.resumeConversation(targetCid, {
        expectedLastIdx,
        turboWriteConfirmed: confirmed,
        idempotencyKey,
      });
      state.pendingResumeKeys.delete(mapKey);
      if (state.selectedId === targetCid) {
        state.resumeState = null;
        setActionNotice('已静默触发继续任务 (Resume)');
      }
      refreshAllData();
    } catch (err) {
      const code = err?.code;
      if (code === 'resume_state_changed' || code === 'idempotency_key_conflict' || code === 'outcome_unknown') {
        state.pendingResumeKeys.delete(mapKey);
        if (code === 'resume_state_changed' || code === 'outcome_unknown') {
          refreshAllData();
          wsClient
            .fetchResumeState(targetCid)
            .then((fresh) => {
              if (state.selectedId === targetCid) {
                state.resumeState = fresh;
                syncComposerControls();
              }
            })
            .catch(() => {});
        }
      }
      if (state.selectedId === targetCid) {
        state.actionError = formatWriteError(err);
      }
    } finally {
      state.resumeBusy = false;
      syncComposerControls();
    }
  }

  async function handleCompactConvo() {
    const wsClient = getWsClient();
    if (!wsClient || !state.selectedId || !canSteer() || state.compactBusy) return;
    const targetCid = state.selectedId;
    state.contextPopoverOpen = false;
    state.compactBusy = true;
    state.actionError = '';
    state.actionNotice = '';
    syncComposerControls();
    try {
      await wsClient.compactConversation(targetCid);
      if (state.selectedId === targetCid) {
        setActionNotice('已触发上下文压缩 (/compact)');
      }
      refreshAllData();
    } catch (err) {
      if (err?.code === 'outcome_unknown') refreshAllData();
      if (state.selectedId === targetCid) {
        state.actionError = formatWriteError(err);
      }
    } finally {
      state.compactBusy = false;
      syncComposerControls();
    }
  }

  return {
    resetCancelConfirm,
    attachImageFiles,
    handleSelectModelOption,
    handleSendDraft,
    handleApproveStep,
    handleCancelConvo,
    handleResumeConvo,
    handleCompactConvo,
  };
}
