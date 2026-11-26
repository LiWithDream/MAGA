/**
 * Non-exportable WebCrypto ECDSA P-256 device identity & IndexedDB storage.
 */
const DB_NAME = 'maga-remote-crypto';
const DB_VERSION = 1;
const STORE_NAME = 'identities';
const ACTIVE_KEY = 'current';

export function encodeBase64Url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function defaultDeviceName() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/iPhone/i.test(ua)) return 'iPhone Safari';
  if (/iPad/i.test(ua)) return 'iPad Safari';
  if (/Android/i.test(ua)) return 'Android Mobile';
  if (/Windows/i.test(ua)) return 'Windows Browser';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac Browser';
  return 'MAGA Remote Device';
}

function openCryptoDb() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前浏览器环境不支持 IndexedDB'));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('无法打开 IndexedDB'));
  });
}

export async function generateDeviceKeyPair() {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前上下文不支持 WebCrypto（请使用 HTTPS 或 localhost 访问）');
  }
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify']
  );
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKeyJwk,
  };
}

export async function signChallengePayload({ privateKey, nonce, deviceId, lastSeq = 0, lastEpoch = '' }) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前上下文不支持 WebCrypto 签名');
  }
  if (!privateKey || !nonce || !deviceId) {
    throw new Error('缺少签名所需密钥或设备上下文');
  }
  const msg = `maga-remote/1:hello:${nonce}:${deviceId}:${lastSeq ?? 0}:${lastEpoch || ''}`;
  const encoded = new TextEncoder().encode(msg);
  const sigBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoded
  );
  return encodeBase64Url(sigBuffer);
}

export async function loadDeviceIdentity() {
  const db = await openCryptoDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(ACTIVE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('读取设备密钥失败'));
    });
  } finally {
    db.close();
  }
}

export async function saveDeviceIdentity({
  deviceId,
  deviceName,
  role,
  gatewayFingerprint,
  privateKey,
  publicKeyJwk,
}) {
  const db = await openCryptoDb();
  try {
    const record = {
      id: ACTIVE_KEY,
      deviceId,
      deviceName,
      role,
      gatewayFingerprint,
      privateKey,
      publicKeyJwk,
      updatedAt: Date.now(),
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('保存设备密钥失败'));
    });
    return record;
  } finally {
    db.close();
  }
}

export async function clearDeviceIdentity() {
  const db = await openCryptoDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(ACTIVE_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('清除设备密钥失败'));
    });
  } finally {
    db.close();
  }
}
