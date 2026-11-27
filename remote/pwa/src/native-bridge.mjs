/**
 * AGY Studio Remote PWA — Native Android Shell Bridge (`window.__agyNative`).
 * No-ops gracefully when running in normal web / PWA browsers.
 */
export function getNativeBridge() {
  try {
    if (typeof window !== 'undefined' && window.__agyNative && typeof window.__agyNative.isNative === 'function') {
      return window.__agyNative;
    }
  } catch {}
  return null;
}

export function isNativeAndroidApp() {
  const b = getNativeBridge();
  try {
    return Boolean(b && b.isNative());
  } catch {
    return false;
  }
}

export function sendNativeNotification({ title = '', body = '', tag = '', category = 'completed', cascadeId = '' } = {}) {
  const b = getNativeBridge();
  if (!b || typeof b.notify !== 'function') return false;
  try {
    b.notify(String(title || ''), String(body || ''), String(tag || ''), String(category || ''), String(cascadeId || ''));
    return true;
  } catch {
    return false;
  }
}

export function vibrateNative(pattern) {
  const b = getNativeBridge();
  if (!b || typeof b.vibrate !== 'function') return false;
  try {
    const arr = Array.isArray(pattern) ? pattern : [Number(pattern) || 35];
    b.vibrate(JSON.stringify(arr));
    return true;
  } catch {
    return false;
  }
}

export function requestNativeNotificationPermission() {
  const b = getNativeBridge();
  if (!b || typeof b.requestNotificationPermission !== 'function') return false;
  try {
    b.requestNotificationPermission();
    return true;
  } catch {
    return false;
  }
}

export function openNativeSettingsDialog() {
  const b = getNativeBridge();
  if (!b || typeof b.openNativeSettings !== 'function') return false;
  try {
    b.openNativeSettings();
    return true;
  } catch {
    return false;
  }
}

export function getNativeAppVersion() {
  const b = getNativeBridge();
  if (!b || typeof b.getAppVersion !== 'function') return '';
  try {
    return String(b.getAppVersion() || '').trim();
  } catch {
    return '';
  }
}

export function isNativeKeepAliveEnabled() {
  const b = getNativeBridge();
  if (!b || typeof b.isKeepAliveEnabled !== 'function') return false;
  try {
    return Boolean(b.isKeepAliveEnabled());
  } catch {
    return false;
  }
}

export function setNativeKeepAliveEnabled(enabled) {
  const b = getNativeBridge();
  if (!b || typeof b.setKeepAliveEnabled !== 'function') return false;
  try {
    return Boolean(b.setKeepAliveEnabled(Boolean(enabled)));
  } catch {
    return false;
  }
}

let lastKeepAliveBridgeRef = null;
let lastKeepAliveStatusText = '';

export function updateNativeKeepAliveStatus(text) {
  const b = getNativeBridge();
  if (!b || typeof b.updateKeepAliveStatus !== 'function') return false;
  const clean = String(text || '').trim().slice(0, 120);
  if (!clean) return false;
  if (b === lastKeepAliveBridgeRef && clean === lastKeepAliveStatusText) return false;
  lastKeepAliveBridgeRef = b;
  lastKeepAliveStatusText = clean;
  try {
    b.updateKeepAliveStatus(clean);
    return true;
  } catch {
    return false;
  }
}

export function checkNativeAppUpdate(silent = false) {
  const b = getNativeBridge();
  if (!b || typeof b.checkForUpdate !== 'function') return false;
  try {
    b.checkForUpdate(Boolean(silent));
    return true;
  } catch {
    return false;
  }
}

export function applyNativeInsets(insets) {
  if (typeof document === 'undefined' || !insets || typeof insets !== 'object') return;
  const root = document.documentElement;
  const toPx = (v) => `${Math.max(0, Math.round(Number(v) || 0))}px`;
  root.style.setProperty('--rc-inset-top', toPx(insets.top));
  root.style.setProperty('--rc-inset-bottom', toPx(insets.bottom));
  root.style.setProperty('--rc-inset-left', toPx(insets.left));
  root.style.setProperty('--rc-inset-right', toPx(insets.right));
  root.setAttribute('data-native-android', '1');
}

export function bindNativeAndroidBridge({
  state,
  canSteer,
  createIdempotencyKey,
  uuidRe,
  selectConversation,
  syncComposerControls,
  setActionNotice,
  onCloseOverlays,
  onCloseModal,
  onNavigateToList,
  onNativeResume,
  onNativeNetworkChange,
} = {}) {
  if (typeof window === 'undefined') return () => {};
  const native = getNativeBridge();
  if (native && typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-native-android', '1');
  }

  window.__agyApplyNativeInsets = (insets) => {
    applyNativeInsets(insets);
  };

  window.__agyNativeResume = () => {
    try {
      onNativeResume?.();
      return true;
    } catch {
      return false;
    }
  };

  window.__agyNativeNetworkChange = (info) => {
    try {
      onNativeNetworkChange?.(info && typeof info === 'object' ? info : { online: true });
      return true;
    } catch {
      return false;
    }
  };

  window.__agyNativeBack = () => {
    if (!state) return false;
    if (state.modelPopoverOpen || state.contextPopoverOpen || state.moreMenuOpen) {
      onCloseOverlays?.();
      return true;
    }
    if (state.newChatOpen && !state.newChatBusy) {
      onCloseModal?.();
      return true;
    }
    if (state.mobileView === 'detail') {
      onNavigateToList?.();
      return true;
    }
    return false;
  };

  window.__agyFocusConversation = (cid) => {
    const id = String(cid || '').trim();
    if (!id) return false;
    if (uuidRe && !uuidRe.test(id)) return false;
    selectConversation?.(id);
    return true;
  };

  window.__agyReceiveSharedMedia = (items) => {
    if (!state || !Array.isArray(items) || items.length === 0) return 0;
    if (typeof canSteer === 'function' && !canSteer()) {
      setActionNotice?.('当前为只读模式，无法附带分享图片');
      return 0;
    }
    const existing = Array.isArray(state.draftMedia) ? state.draftMedia : [];
    const remain = Math.max(0, 4 - existing.length);
    if (remain <= 0) {
      setActionNotice?.('单次最多附带 4 张图片');
      return 0;
    }
    const added = [];
    for (const raw of items.slice(0, remain)) {
      const dataUrl = String(raw?.dataUrl || '');
      const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
      if (!m) continue;
      const mimeType = m[1].toLowerCase();
      const base64Data = m[2];
      const approxBytes = Math.floor((base64Data.length * 3) / 4);
      added.push({
        id: `share_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: String(raw?.name || 'shared-image.jpg').slice(0, 80),
        mimeType,
        dataUrl,
        previewUrl: dataUrl,
        dataBase64: base64Data,
        base64Data,
        size: approxBytes,
        sizeBytes: approxBytes,
      });
    }
    if (added.length > 0) {
      state.draftMedia = existing.concat(added);
      if (typeof createIdempotencyKey === 'function') {
        state.draftIdempotencyKey = createIdempotencyKey();
      }
      state.actionError = '';
      setActionNotice?.(`已接收 ${added.length} 张系统分享图片`);
      syncComposerControls?.();
    }
    return added.length;
  };

  try {
    if (native && typeof native.onWebReady === 'function') {
      native.onWebReady();
    }
  } catch {}

  return () => {
    delete window.__agyApplyNativeInsets;
    delete window.__agyNativeResume;
    delete window.__agyNativeNetworkChange;
    delete window.__agyNativeBack;
    delete window.__agyFocusConversation;
    delete window.__agyReceiveSharedMedia;
  };
}
