/**
 * Delegated Events & Cross-Restart Polling State Machine for Settings -> Version & Updates.
 */

const DEFAULT_POLL_INTERVAL_MS = 1200;
const DEFAULT_MAX_DISCONNECT_TICKS = 25;

async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(String(text));
      return true;
    }
  } catch {}
  try {
    if (typeof document !== 'undefined') {
      const ta = document.createElement('textarea');
      ta.value = String(text);
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.('copy') === true;
      ta.remove();
      return ok;
    }
  } catch {}
  return false;
}

export function stopUpdateStatusPolling(state) {
  if (!state) return;
  if (state.updatePollTimer) {
    clearTimeout(state.updatePollTimer);
    state.updatePollTimer = 0;
  }
}

function didReachUpdateTarget(status, local) {
  if (!status || !local) return false;
  if (!status.inProgress && status.phase === 'succeeded') return true;
  if (status.inProgress && status.phase === 'restarting') {
    if (status.installMode === 'git-edge' && status.targetSha && local.sha === status.targetSha) {
      return true;
    }
    if (status.installMode !== 'git-edge' && status.toVersion && local.version === status.toVersion) {
      return true;
    }
  }
  return false;
}

export function startUpdateStatusPolling(
  state,
  {
    renderActiveHost,
    flashToast,
    callRpc,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxDisconnectTicks = DEFAULT_MAX_DISCONNECT_TICKS,
  } = {}
) {
  if (!state) return;
  stopUpdateStatusPolling(state);

  const scheduleNext = () => {
    state.updatePollTimer = setTimeout(tick, pollIntervalMs);
  };

  const tick = async () => {
    state.updatePollTimer = 0;
    const rpc = callRpc || (typeof window !== 'undefined' ? window.__agProjectCall : null);
    if (typeof rpc !== 'function') return;

    let res = null;
    try {
      res = await rpc('getStudioUpdateStatus', {}, 4000);
    } catch {
      res = null;
    }

    if (!res || !res.ok) {
      state.updateDisconnectCount = Number(state.updateDisconnectCount || 0) + 1;
      if (state.updateDisconnectCount <= maxDisconnectTicks) {
        renderActiveHost?.(true);
        scheduleNext();
      } else {
        state.updateJob = {
          ...(state.updateJob || {}),
          inProgress: false,
          phase: 'failed',
          error: 'reconnect_timeout',
        };
        flashToast?.('守护进程重连超时', 'Daemon reconnect timed out', 'error');
        renderActiveHost?.(true);
      }
      return;
    }

    state.updateDisconnectCount = 0;
    state.updateVersionInfo = res;
    const st = res.status || null;
    state.updateJob = st;

    if (didReachUpdateTarget(st, res.local)) {
      state.updateJob = { ...(st || {}), inProgress: false, phase: 'succeeded' };
      state.updateCheck = null;
      state.updateArmed = false;
      flashToast?.('✓ AGY Studio 已更新至最新版本', '✓ AGY Studio updated');
      renderActiveHost?.(true);
      return;
    }

    if (st && !st.inProgress && st.phase === 'failed') {
      state.updateArmed = false;
      flashToast?.('更新失败', 'Update failed', 'error');
      renderActiveHost?.(true);
      return;
    }

    if (st?.inProgress) {
      renderActiveHost?.(true);
      scheduleNext();
      return;
    }

    renderActiveHost?.(true);
  };

  scheduleNext();
}

export function loadStudioVersionInfoIfNeeded(state, viewName, onLoaded, callRpc) {
  if (!state || viewName !== 'l1') return;
  if (state.updateVersionInfo || state.updateVersionLoading) return;
  const rpc = callRpc || (typeof window !== 'undefined' ? window.__agProjectCall : null);
  if (typeof rpc !== 'function') return;

  state.updateVersionLoading = true;
  Promise.resolve(rpc('getStudioVersionInfo', {}, 5000))
    .then((res) => {
      state.updateVersionLoading = false;
      if (res && res.ok) {
        state.updateVersionInfo = res;
        state.updateJob = res.status || null;
        if (res.lastCheck && !state.updateCheck) {
          state.updateCheck = res.lastCheck;
        }
        if (res.status?.inProgress && !state.updatePollTimer) {
          startUpdateStatusPolling(state, { renderActiveHost: onLoaded, callRpc: rpc });
        }
        onLoaded?.();
      }
    })
    .catch(() => {
      state.updateVersionLoading = false;
    });
}

export async function handleUpdateSettingsClick(
  target,
  { state, renderActiveHost, flashToast, callRpc } = {}
) {
  const actionBtn = target?.closest?.('[data-ms-action]');
  if (!actionBtn) return false;
  const act = actionBtn.getAttribute('data-ms-action');
  if (
    act !== 'update-check' &&
    act !== 'update-arm' &&
    act !== 'update-cancel' &&
    act !== 'update-confirm' &&
    act !== 'update-copy-cmd'
  ) {
    return false;
  }

  const rpc = callRpc || (typeof window !== 'undefined' ? window.__agProjectCall : null);

  if (act === 'update-copy-cmd') {
    const cmd = state?.updateCheck?.manualCommand || state?.updateVersionInfo?.manualCommand || '';
    const ok = await copyText(cmd);
    if (ok) flashToast?.('✓ 已复制更新命令', '✓ Update command copied');
    else flashToast?.('复制失败，请手动复制', 'Copy failed', 'error');
    return true;
  }

  if (act === 'update-arm') {
    state.updateArmed = !state.updateArmed;
    renderActiveHost?.(true);
    return true;
  }

  if (act === 'update-cancel') {
    state.updateArmed = false;
    renderActiveHost?.(true);
    return true;
  }

  if (typeof rpc !== 'function') {
    flashToast?.('守护进程未连接', 'Daemon not connected', 'error');
    return true;
  }

  if (act === 'update-check') {
    if (state.updateChecking || state.updateJob?.inProgress) return true;
    state.updateChecking = true;
    state.updateArmed = false;
    if (state.updateJob && !state.updateJob.inProgress) {
      state.updateJob = null;
    }
    renderActiveHost?.(true);

    const res = await Promise.resolve(rpc('checkStudioUpdate', { force: true }, 15000)).catch(() => null);
    state.updateChecking = false;
    if (res) {
      state.updateCheck = res;
      if (res.local) {
        state.updateVersionInfo = { ...(state.updateVersionInfo || {}), ...res };
      }
      if (!res.ok) {
        flashToast?.('检查更新失败', 'Update check failed', 'error');
      } else if (res.check?.updateAvailable) {
        flashToast?.('发现可用更新', 'Update available');
      } else {
        flashToast?.('✓ 已是最新版本', '✓ Already up to date');
      }
    } else {
      state.updateCheck = { ok: false, error: 'network_error' };
      flashToast?.('检查更新失败', 'Update check failed', 'error');
    }
    renderActiveHost?.(true);
    return true;
  }

  if (act === 'update-confirm') {
    state.updateArmed = false;
    state.updateDisconnectCount = 0;
    const res = await Promise.resolve(rpc('startStudioUpdate', {}, 15000)).catch(() => null);
    if (res?.ok && res.started) {
      state.updateJob = res.status;
      renderActiveHost?.(true);
      startUpdateStatusPolling(state, { renderActiveHost, flashToast, callRpc: rpc });
      flashToast?.('已启动后台更新…', 'Update started…');
    } else {
      const errCode = res?.error || 'update_start_failed';
      if (res?.status?.inProgress) {
        state.updateJob = res.status;
        startUpdateStatusPolling(state, { renderActiveHost, flashToast, callRpc: rpc });
      } else {
        state.updateJob = { inProgress: false, phase: 'failed', error: errCode, rolledBack: false };
      }
      flashToast?.('无法启动更新', 'Cannot start update', 'error');
      renderActiveHost?.(true);
    }
    return true;
  }

  return false;
}
