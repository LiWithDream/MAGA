/**
 * Delegated Events & RPC Helpers for AGY Studio Settings -> Remote Control View.
 */

const REMOTE_ERR_MESSAGES = {
  missing_cf_access_config: ['请先填写 Cloudflare Team Domain 与 AUD', 'Enter Cloudflare Team Domain & AUD first'],
  missing_tailscale_allowlist: ['请至少填写一个允许的 Tailscale 邮箱', 'Enter at least one allowed Tailscale user'],
  invalid_public_url: ['公网访问地址格式无效', 'Invalid public HTTPS URL'],
  public_url_must_be_https: ['外网地址必须使用 HTTPS', 'Public URL must use HTTPS'],
  invalid_port: ['端口需为 1024–65535 整数', 'Port must be between 1024 and 65535'],
  wildcard_forbidden: ['安全策略禁止通配符 * 或 0.0.0.0', 'Wildcard * or 0.0.0.0 is forbidden'],
};

function readRemoteDraftFromRoot(root, state) {
  const cur = state?.remoteStatus?.config || {};
  const draft = Object.assign({}, state?.remoteDraft || {});
  const transport = draft.transport || cur.transport || 'loopback';
  const portRaw = root.querySelector('[data-ms-remote-input="port"]')?.value?.trim();
  const port = portRaw ? Number(portRaw) : Number(draft.port ?? (cur.port || 18791));
  const publicUrlEl = root.querySelector('[data-ms-remote-input="publicUrl"]');
  const cfTeamEl = root.querySelector('[data-ms-remote-input="cfAccessTeamDomain"]');
  const cfAudEl = root.querySelector('[data-ms-remote-input="cfAccessAud"]');
  const tsUsersEl = root.querySelector('[data-ms-remote-input="tailscaleUsers"]');

  return {
    transport,
    port,
    ...(publicUrlEl ? { publicUrl: publicUrlEl.value.trim() } : draft.publicUrl !== undefined ? { publicUrl: draft.publicUrl } : {}),
    ...(cfTeamEl ? { cfAccessTeamDomain: cfTeamEl.value.trim() } : draft.cfAccessTeamDomain !== undefined ? { cfAccessTeamDomain: draft.cfAccessTeamDomain } : {}),
    ...(cfAudEl ? { cfAccessAud: cfAudEl.value.trim() } : draft.cfAccessAud !== undefined ? { cfAccessAud: draft.cfAccessAud } : {}),
    ...(tsUsersEl ? { tailscaleAllowedUsers: tsUsersEl.value.trim() } : draft.tailscaleUsers !== undefined ? { tailscaleAllowedUsers: draft.tailscaleUsers } : {}),
    ...(draft.allowLocalPairingWithoutEdge !== undefined ? { allowLocalPairingWithoutEdge: draft.allowLocalPairingWithoutEdge } : {}),
  };
}

function captureDraftFields(root, state) {
  const cur = state?.remoteDraft || {};
  const next = { ...cur };
  const portEl = root.querySelector('[data-ms-remote-input="port"]');
  const pubEl = root.querySelector('[data-ms-remote-input="publicUrl"]');
  const cfTeamEl = root.querySelector('[data-ms-remote-input="cfAccessTeamDomain"]');
  const cfAudEl = root.querySelector('[data-ms-remote-input="cfAccessAud"]');
  const tsUsersEl = root.querySelector('[data-ms-remote-input="tailscaleUsers"]');
  if (portEl && portEl.value.trim()) next.port = Number(portEl.value.trim());
  if (pubEl) next.publicUrl = pubEl.value.trim();
  if (cfTeamEl) next.cfAccessTeamDomain = cfTeamEl.value.trim();
  if (cfAudEl) next.cfAccessAud = cfAudEl.value.trim();
  if (tsUsersEl) next.tailscaleUsers = tsUsersEl.value.trim();
  state.remoteDraft = next;
}

async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(String(text));
      return true;
    }
  } catch {}
  return false;
}

function toastError(flashToast, code, fallbackZh, fallbackEn) {
  const pair = REMOTE_ERR_MESSAGES[code];
  if (pair) flashToast(pair[0], pair[1], 'error');
  else flashToast(fallbackZh, fallbackEn, 'error');
}

export function loadRemoteControlStatusIfNeeded(state, viewName, onLoaded) {
  if (!state || (viewName !== 'l1' && viewName !== 'remote')) return;
  if (state.remoteStatus || state.remoteLoading) return;
  if (typeof window?.__agProjectCall !== 'function') return;
  state.remoteLoading = true;
  Promise.resolve(window.__agProjectCall('getRemoteControlStatus', {}, 5000))
    .then((res) => {
      state.remoteLoading = false;
      if (res && res.ok) {
        state.remoteStatus = res;
        onLoaded?.();
      }
    })
    .catch(() => {
      state.remoteLoading = false;
    });
}

export async function handleRemoteSettingsClick(target, root, { state, renderActiveHost, flashToast }) {
  const callRpc = window?.__agProjectCall;

  const toggleBtn = target.closest('[data-ms-remote-toggle="enabled"]');
  if (toggleBtn && typeof callRpc === 'function') {
    const nextEnabled = toggleBtn.getAttribute('aria-checked') !== 'true';
    const formPayload = readRemoteDraftFromRoot(root, state);
    const res = await callRpc('saveRemoteControlConfig', { ...formPayload, enabled: nextEnabled }, 6000).catch(() => null);
    if (res?.ok) {
      state.remoteStatus = res;
      state.remoteDraft = null;
      renderActiveHost(true);
      flashToast(nextEnabled ? '✓ 远程网关已启用' : '✓ 远程网关已关闭', nextEnabled ? '✓ Remote enabled' : '✓ Remote disabled');
    } else {
      toastError(flashToast, res?.error, '切换网关状态失败', 'Failed to toggle gateway');
    }
    return true;
  }

  const localPairBtn = target.closest('[data-ms-kind="remote-local-pair"][data-ms-key="allowLocalPairingWithoutEdge"]');
  if (localPairBtn && typeof callRpc === 'function') {
    const nextVal = localPairBtn.getAttribute('aria-checked') !== 'true';
    const formPayload = readRemoteDraftFromRoot(root, state);
    const res = await callRpc('saveRemoteControlConfig', { ...formPayload, allowLocalPairingWithoutEdge: nextVal }, 5000).catch(() => null);
    if (res?.ok) {
      state.remoteStatus = res;
      if (state.remoteDraft) state.remoteDraft.allowLocalPairingWithoutEdge = nextVal;
      renderActiveHost(true);
      flashToast('✓ 已保存', '✓ Saved');
    } else {
      toastError(flashToast, res?.error, '保存失败', 'Save failed');
    }
    return true;
  }

  const transportBtn = target.closest('[data-ms-remote-transport]');
  if (transportBtn) {
    captureDraftFields(root, state);
    state.remoteDraft = Object.assign({}, state.remoteDraft || {}, {
      transport: transportBtn.getAttribute('data-ms-remote-transport') || 'loopback',
    });
    renderActiveHost(true);
    return true;
  }

  const pairRoleBtn = target.closest('[data-ms-remote-pair-role]');
  if (pairRoleBtn) {
    state.remotePairRole = pairRoleBtn.getAttribute('data-ms-remote-pair-role') || 'observe';
    renderActiveHost(true);
    return true;
  }

  const pairTtlBtn = target.closest('[data-ms-remote-pair-ttl]');
  if (pairTtlBtn) {
    const n = Number(pairTtlBtn.getAttribute('data-ms-remote-pair-ttl') || 120);
    if (Number.isInteger(n)) state.remotePairTtl = n;
    renderActiveHost(true);
    return true;
  }

  const roleSwitchBtn = target.closest('[data-ms-remote-device-id][data-ms-remote-device-role]');
  if (roleSwitchBtn && typeof callRpc === 'function') {
    const deviceId = roleSwitchBtn.getAttribute('data-ms-remote-device-id') || '';
    const role = roleSwitchBtn.getAttribute('data-ms-remote-device-role') || 'observe';
    const res = await callRpc('updateRemoteDeviceRole', { deviceId, role }, 5000).catch(() => null);
    if (res?.ok) {
      state.remoteStatus = res;
      renderActiveHost(true);
      flashToast('✓ 设备角色已更新', '✓ Device role updated');
    } else {
      flashToast('更新角色失败', 'Role update failed', 'error');
    }
    return true;
  }

  const revokeBtn = target.closest('[data-ms-remote-revoke]');
  if (revokeBtn && typeof callRpc === 'function') {
    const deviceId = revokeBtn.getAttribute('data-ms-remote-revoke') || '';
    const res = await callRpc('revokeRemoteDevice', { deviceId }, 5000).catch(() => null);
    if (res?.ok) {
      state.remoteStatus = res;
      renderActiveHost(true);
      flashToast('✓ 设备已吊销并下线', '✓ Device revoked');
    } else {
      flashToast('吊销失败', 'Revoke failed', 'error');
    }
    return true;
  }

  const remActBtn = target.closest('[data-ms-remote-action]');
  if (!remActBtn) return false;
  const act = remActBtn.getAttribute('data-ms-remote-action');

  if (act === 'refresh' && typeof callRpc === 'function') {
    const res = await callRpc('getRemoteControlStatus', {}, 5000).catch(() => null);
    if (res?.ok) {
      state.remoteStatus = res;
      renderActiveHost(true);
      flashToast('✓ 状态已刷新', '✓ Status refreshed');
    } else {
      flashToast('刷新失败', 'Refresh failed', 'error');
    }
  } else if (act === 'diagnose' && typeof callRpc === 'function') {
    const res = await callRpc('runRemoteDiagnostics', {}, 6000).catch(() => null);
    if (res && typeof res.ok === 'boolean') {
      state.remoteDiagnostics = res;
      renderActiveHost(true);
      flashToast(res.ok ? '✓ 诊断通过' : '发现配置/环境警告', res.ok ? '✓ Diagnostics passed' : 'Issues detected', res.ok ? 'ok' : 'error');
    } else {
      flashToast('运行诊断失败', 'Diagnostics failed', 'error');
    }
  } else if (act === 'save-config' && typeof callRpc === 'function') {
    const formPayload = readRemoteDraftFromRoot(root, state);
    const res = await callRpc('saveRemoteControlConfig', formPayload, 6000).catch(() => null);
    if (res?.ok) {
      state.remoteStatus = res;
      state.remoteDraft = null;
      state.remoteDiagnostics = null;
      renderActiveHost(true);
      flashToast('✓ 通道配置已保存', '✓ Transport saved');
    } else {
      toastError(flashToast, res?.error, '保存通道配置失败', 'Save failed');
    }
  } else if (act === 'pair' && typeof callRpc === 'function') {
    const role = state.remotePairRole || 'observe';
    const ttlSec = Number(state.remotePairTtl || 120);
    const res = await callRpc('createRemotePairing', { role, ttlSec }, 5000).catch(() => null);
    if (res?.ok) {
      state.remotePairing = res;
      renderActiveHost(true);
      flashToast('✓ 配对二维码已生成', '✓ Pairing QR ready');
    } else {
      flashToast('生成配对码失败', 'Failed to generate code', 'error');
    }
  } else if (act === 'copy-pair-url') {
    if (await copyText(state.remotePairing?.pairingUrl)) flashToast('✓ 已复制配对链接', '✓ Pairing URL copied');
  } else if (act === 'copy-pair-code') {
    if (await copyText(state.remotePairing?.code)) flashToast('✓ 已复制配对码', '✓ Code copied');
  } else if (act === 'copy-tunnel-target') {
    const portVal = root.querySelector('[data-ms-remote-input="port"]')?.value?.trim() || state.remoteStatus?.config?.port || 18791;
    if (await copyText(`http://127.0.0.1:${portVal}`)) flashToast('✓ 已复制本地源站地址', '✓ Tunnel origin copied');
  } else if (act === 'clear-pair') {
    state.remotePairing = null;
    renderActiveHost(true);
  }
  return true;
}
