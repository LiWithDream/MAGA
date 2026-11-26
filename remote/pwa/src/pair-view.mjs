/**
 * AGY Studio Remote PWA — Pairing View & WebCrypto Device Key Enrollment
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import {
  defaultDeviceName,
  generateDeviceKeyPair,
  saveDeviceIdentity,
} from './crypto-store.mjs';
import {
  clearNode,
  el,
  formatPresetBadge,
  requiresTurboAck,
  shortFingerprint,
} from './ui-helpers.mjs';
import { completeGatewayPairing, fetchGatewayHealth } from './ws-client.mjs';

export function createPairViewController({ state, rootEl, render, onPaired }) {
  let pairSubmitBtn = null;

  function computePairSubmitDisabled() {
    if (state.pairingBusy) return true;
    if (!state.pairingCode.trim()) return true;
    if (requiresTurboAck(state.health?.globalPreset) && !state.turboAcknowledged) return true;
    return false;
  }

  function updatePairSubmitButton() {
    const btn = pairSubmitBtn || document.getElementById('rc-pair-submit');
    if (btn) btn.disabled = computePairSubmitDisabled();
  }

  async function loadHealthForPairing() {
    try {
      const health = await fetchGatewayHealth();
      state.health = health;
      state.globalPreset = health.globalPreset ?? null;
      state.hostAttached = Boolean(health.hostAttached);
      state.capabilities = health.capabilities || null;
      state.pairingError = '';
    } catch (err) {
      state.pairingError = String(err?.message || '无法连接到 AGY Studio Remote 网关');
    }
    render();
  }

  async function handlePairSubmit(ev) {
    ev.preventDefault();
    if (state.pairingBusy) return;
    const code = state.pairingCode.trim();
    const deviceName = state.deviceName.trim() || defaultDeviceName();
    if (!code) {
      state.pairingError = '请输入一次性配对码';
      render();
      return;
    }

    state.pairingBusy = true;
    state.pairingError = '';
    render();

    try {
      // Re-check health immediately before pairing so TURBO / unknown preset cannot be bypassed
      const freshHealth = await fetchGatewayHealth();
      state.health = freshHealth;
      state.globalPreset = freshHealth.globalPreset ?? null;

      if (requiresTurboAck(freshHealth.globalPreset) && !state.turboAcknowledged) {
        state.pairingBusy = false;
        state.pairingError =
          Number(freshHealth.globalPreset) === 3
            ? '本机当前为 TURBO 权限模式，请先阅读安全告知并勾选确认框'
            : '未能确认本机安全预设（按 TURBO 最高风险门禁），请先阅读告知并勾选确认框';
        render();
        return;
      }

      const { privateKey, publicKeyJwk } = await generateDeviceKeyPair();
      const res = await completeGatewayPairing({
        code,
        deviceName,
        publicKeyJwk,
        turboAcknowledged: Boolean(state.turboAcknowledged),
      });

      const identity = await saveDeviceIdentity({
        deviceId: res.deviceId,
        deviceName,
        role: res.role || 'observe',
        gatewayFingerprint: res.gatewayFingerprint || freshHealth.gatewayFingerprint || '',
        privateKey,
        publicKeyJwk,
      });

      state.identity = identity;
      state.pairingCode = '';
      state.pairingBusy = false;
      onPaired();
    } catch (err) {
      state.pairingBusy = false;
      state.pairingError = String(err?.message || '配对失败');
      render();
    }
  }

  function renderPairingScreen() {
    clearNode(rootEl);
    rootEl.setAttribute('data-mobile-view', 'list');

    const preset = state.health?.globalPreset;
    const needTurboAck = requiresTurboAck(preset);
    const isExplicitTurbo = Number(preset) === 3;
    const presetInfo = formatPresetBadge(preset);
    const fp = state.health?.gatewayFingerprint || '';

    pairSubmitBtn = el('button', {
      id: 'rc-pair-submit',
      type: 'submit',
      className: 'rc-btn is-primary',
      disabled: computePairSubmitDisabled(),
      text: state.pairingBusy ? '正在生成不可导出密钥并配对…' : '生成设备密钥并完成配对',
    });

    const form = el(
      'form',
      { className: 'rc-pair-card', onSubmit: handlePairSubmit },
      el(
        'div',
        { className: 'rc-pair-brand' },
        el(
          'div',
          {},
          el('h1', { className: 'rc-pair-title', text: 'AGY Studio Remote' }),
          el('p', {
            className: 'rc-pair-sub',
            text: '设备密钥由浏览器 WebCrypto 生成且不可导出',
          })
        ),
        el(
          'button',
          {
            type: 'button',
            className: 'rc-btn is-sm',
            onClick: () => loadHealthForPairing(),
            text: '刷新状态',
          }
        )
      ),
      el(
        'div',
        { className: 'rc-meta-box' },
        el(
          'div',
          { className: 'rc-meta-row' },
          el('span', { text: '网关传输与宿主' }),
          el('span', {
            className: 'rc-pill',
            'data-tone': state.health?.hostAttached ? 'ok' : 'warn',
            text: state.health
              ? `${state.health.transport || 'loopback'} · ${state.health.hostAttached ? 'CDP 已挂载' : '宿主离线(磁盘只读)'}`
              : '检测中…',
          })
        ),
        el(
          'div',
          { className: 'rc-meta-row' },
          el('span', { text: '本机权限预设' }),
          el('span', {
            className: 'rc-pill',
            'data-tone': presetInfo.tone,
            text: presetInfo.label,
          })
        ),
        el(
          'div',
          { className: 'rc-meta-row' },
          el('span', { text: '网关指纹' }),
          el(
            'button',
            {
              type: 'button',
              className: 'rc-btn is-ghost is-sm rc-mono',
              onClick: () => {
                state.showFullFingerprint = !state.showFullFingerprint;
                render();
              },
              text: state.showFullFingerprint ? fp || '未知' : shortFingerprint(fp),
            }
          )
        )
      ),
      needTurboAck
        ? el(
            'div',
            { className: 'rc-turbo-alert', role: 'alert' },
            el('div', {
              className: 'rc-turbo-alert-title',
              text: isExplicitTurbo
                ? '⚠ 高危安全告知：本机当前为 TURBO 权限模式 (globalPreset = 3)'
                : '⚠ 安全告知：未能确认本机权限预设（按 TURBO 门禁处理）',
            }),
            el('div', {
              text: '若授予受控协作 (steer) 角色，远程发送指令在 TURBO 模式下会直接执行本机操作。请务必核对网关指纹，仅配对您本人完全信任的设备。',
            }),
            el(
              'label',
              { className: 'rc-turbo-check', for: 'rc-turbo-ack' },
              el('input', {
                id: 'rc-turbo-ack',
                type: 'checkbox',
                checked: state.turboAcknowledged,
                onChange: (ev) => {
                  state.turboAcknowledged = Boolean(ev.target.checked);
                  updatePairSubmitButton();
                },
              }),
              el('span', { text: '我已知晓本机当前为 TURBO 权限模式' })
            )
          )
        : null,
      el(
        'div',
        { className: 'rc-field' },
        el('label', { className: 'rc-label', for: 'rc-pair-code', text: '一次性配对码（在 Mac 端 AGY Studio 设置 → 远程控制 获取）' }),
        el('input', {
          id: 'rc-pair-code',
          className: 'rc-input is-code',
          type: 'text',
          autocomplete: 'one-time-code',
          placeholder: '输入配对码',
          value: state.pairingCode,
          onInput: (ev) => {
            state.pairingCode = ev.target.value;
            updatePairSubmitButton();
          },
        })
      ),
      el(
        'div',
        { className: 'rc-field' },
        el('label', { className: 'rc-label', for: 'rc-device-name', text: '设备备注名称' }),
        el('input', {
          id: 'rc-device-name',
          className: 'rc-input',
          type: 'text',
          maxlength: '48',
          placeholder: '例如：iPhone 16 Pro',
          value: state.deviceName,
          onInput: (ev) => {
            state.deviceName = ev.target.value;
          },
        })
      ),
      state.pairingError ? el('div', { className: 'rc-error-banner', text: state.pairingError }) : null,
      pairSubmitBtn
    );

    rootEl.appendChild(el('div', { className: 'rc-pair-wrap' }, form));
  }

  return {
    loadHealthForPairing,
    renderPairingScreen,
    updatePairSubmitButton,
  };
}
