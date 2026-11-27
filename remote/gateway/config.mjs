/**
 * MAGA Remote Gateway — Configuration, State Paths, Device Lock & Atomic 0600 Storage
 * Zero third-party dependencies (Node >= 22 built-ins only).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureRemoteDir,
  getRemotePaths,
  isPosixPermsEnforced,
  isWindowsNamedPipe,
  readJsonSafe,
  resolveRemoteDir,
  resolveSockPath,
  withDevicesLock,
  writeAtomicFile,
  writeJsonAtomic,
} from '../shared/fs-paths.mjs';

export {
  ensureRemoteDir,
  getRemotePaths,
  isPosixPermsEnforced,
  isWindowsNamedPipe,
  readJsonSafe,
  resolveRemoteDir,
  resolveSockPath,
  withDevicesLock,
  writeAtomicFile,
  writeJsonAtomic,
};

export const ALLOWED_TRANSPORTS = Object.freeze([
  'loopback',
  'tailscale-serve',
  'cloudflare-access',
]);
export const ALLOWED_TRANSPORT_SET = new Set(ALLOWED_TRANSPORTS);

export const ALLOWED_ROLES = Object.freeze(['observe', 'steer', 'admin']);
export const ALLOWED_ROLE_SET = new Set(ALLOWED_ROLES);

export const DEFAULT_REMOTE_CONFIG = Object.freeze({
  enabled: false,
  port: 18791,
  transport: 'loopback',
  allowedHosts: ['127.0.0.1', 'localhost'],
  allowedOrigins: [],
  cfAccessTeamDomain: '',
  cfAccessAud: '',
  tailscaleAllowedUsers: [],
  allowLocalPairingWithoutEdge: true,
});

export function parseTimestampMs(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    const parsed = Date.parse(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function normalizeStringArray(val, fallback = []) {
  if (!Array.isArray(val)) return [...fallback];
  return val
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

export function validateAndNormalizeConfig(raw = {}, overrides = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ov = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  const merged = { ...DEFAULT_REMOTE_CONFIG, ...src, ...ov };

  // Enforce strict 127.0.0.1 bind rule: reject any explicit non-127.0.0.1 host configuration
  const hostCandidates = [
    ov.host,
    ov.bindHost,
    ov.listenHost,
    ov.hostname,
    src.host,
    src.bindHost,
    src.listenHost,
    src.hostname,
    process.env.MAGA_REMOTE_HOST,
  ];
  for (const cand of hostCandidates) {
    if (cand !== undefined && cand !== null && String(cand).trim() !== '' && String(cand).trim() !== '127.0.0.1') {
      throw new Error(`refusing_non_loopback_bind:${String(cand)}`);
    }
  }

  const allowEphemeralPort = ov.port === 0;
  const port = Number(merged.port);
  if (!Number.isInteger(port) || (allowEphemeralPort ? port < 0 || port > 65535 : port < 1 || port > 65535)) {
    throw new Error(`invalid_port:${String(merged.port)}`);
  }

  const transport = String(merged.transport || 'loopback').trim();
  if (!ALLOWED_TRANSPORT_SET.has(transport)) {
    throw new Error(`invalid_transport:${transport}`);
  }

  const allowedHosts = normalizeStringArray(
    merged.allowedHosts,
    DEFAULT_REMOTE_CONFIG.allowedHosts
  ).map((h) => h.toLowerCase());
  const allowedOrigins = normalizeStringArray(merged.allowedOrigins, []);
  const tailscaleAllowedUsers = normalizeStringArray(merged.tailscaleAllowedUsers, []).map((u) => u.toLowerCase());

  const cfAccessTeamDomain = String(merged.cfAccessTeamDomain || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

  let cfAccessAud = '';
  if (Array.isArray(merged.cfAccessAud)) {
    cfAccessAud = merged.cfAccessAud.map((s) => String(s ?? '').trim()).filter(Boolean);
  } else {
    cfAccessAud = String(merged.cfAccessAud || '').trim();
  }

  const hasExplicitLocalPair =
    Object.prototype.hasOwnProperty.call(ov, 'allowLocalPairingWithoutEdge') ||
    Object.prototype.hasOwnProperty.call(src, 'allowLocalPairingWithoutEdge');
  const allowLocalPairingWithoutEdge = hasExplicitLocalPair
    ? merged.allowLocalPairingWithoutEdge !== false
    : transport === 'loopback';

  return {
    enabled: Boolean(merged.enabled),
    port,
    host: '127.0.0.1',
    transport,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : [...DEFAULT_REMOTE_CONFIG.allowedHosts],
    allowedOrigins,
    cfAccessTeamDomain,
    cfAccessAud,
    tailscaleAllowedUsers,
    allowLocalPairingWithoutEdge,
  };
}

export function loadRemoteConfig({ remoteDir = null, overrides = {} } = {}) {
  const { configFile } = getRemotePaths(remoteDir);
  const raw = readJsonSafe(configFile, {});
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('invalid_config_json');
  }
  return validateAndNormalizeConfig(raw || {}, overrides);
}

export function saveRemoteConfig(config, { remoteDir = null } = {}) {
  const { configFile } = getRemotePaths(remoteDir);
  const normalized = validateAndNormalizeConfig(config);
  const persisted = {
    enabled: normalized.enabled,
    port: normalized.port,
    transport: normalized.transport,
    allowedHosts: normalized.allowedHosts,
    allowedOrigins: normalized.allowedOrigins,
    cfAccessTeamDomain: normalized.cfAccessTeamDomain,
    cfAccessAud: normalized.cfAccessAud,
    tailscaleAllowedUsers: normalized.tailscaleAllowedUsers,
    allowLocalPairingWithoutEdge: normalized.allowLocalPairingWithoutEdge,
  };
  writeJsonAtomic(configFile, persisted, { mode: 0o600, dirMode: 0o700 });
  return persisted;
}

function isValidP256JwkPair(pubJwk, privJwk) {
  if (!pubJwk || !privJwk || typeof pubJwk !== 'object' || typeof privJwk !== 'object') return false;
  if (pubJwk.kty !== 'EC' || pubJwk.crv !== 'P-256' || privJwk.kty !== 'EC' || privJwk.crv !== 'P-256') return false;
  try {
    crypto.createPublicKey({ key: pubJwk, format: 'jwk' });
    crypto.createPrivateKey({ key: privJwk, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

export function loadOrCreateGatewayIdentity({ remoteDir = null, now = Date.now } = {}) {
  const { identityFile } = getRemotePaths(remoteDir);
  const existing = readJsonSafe(identityFile, null);
  const existingFp =
    typeof existing?.gatewayFingerprint === 'string'
      ? existing.gatewayFingerprint.trim()
      : typeof existing?.fingerprint === 'string'
        ? existing.fingerprint.trim()
        : '';

  if (existingFp && isValidP256JwkPair(existing?.publicKeyJwk, existing?.privateKeyJwk)) {
    return {
      gatewayFingerprint: existingFp,
      publicKeyJwk: existing.publicKeyJwk,
      privateKeyJwk: existing.privateKeyJwk,
      createdAt: parseTimestampMs(existing?.createdAt) || now(),
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKeyJwk = publicKey.export({ format: 'jwk' });
  const privateKeyJwk = privateKey.export({ format: 'jwk' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const gatewayFingerprint = existingFp || crypto.createHash('sha256').update(spkiDer).digest('hex');
  const identity = {
    gatewayFingerprint,
    publicKeyJwk,
    privateKeyJwk,
    createdAt: parseTimestampMs(existing?.createdAt) || now(),
  };
  writeJsonAtomic(identityFile, identity, { mode: 0o600, dirMode: 0o700 });
  return identity;
}

export function writeGatewayPid({ remoteDir = null, port, pid = process.pid, startedAt = Date.now() } = {}) {
  const { pidFile } = getRemotePaths(remoteDir);
  writeJsonAtomic(pidFile, { pid, startedAt, port }, { mode: 0o600, dirMode: 0o700 });
  return pidFile;
}

export function removeGatewayPid({ remoteDir = null, pid = process.pid } = {}) {
  const { pidFile } = getRemotePaths(remoteDir);
  try {
    const existing = readJsonSafe(pidFile, null);
    if (existing && typeof existing.pid === 'number' && existing.pid !== pid) {
      return false;
    }
    fs.rmSync(pidFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function readDevices({ remoteDir = null } = {}) {
  const { devicesFile } = getRemotePaths(remoteDir);
  const data = readJsonSafe(devicesFile, { devices: [] });
  const list = Array.isArray(data?.devices) ? data.devices : [];
  return list.filter((d) => d && typeof d === 'object' && typeof d.deviceId === 'string' && d.deviceId);
}

export function writeDevices(devices, { remoteDir = null } = {}) {
  const { devicesFile } = getRemotePaths(remoteDir);
  const clean = Array.isArray(devices) ? devices : [];
  writeJsonAtomic(devicesFile, { devices: clean }, { mode: 0o600, dirMode: 0o700 });
  return clean;
}

export function readDeviceLastSeen({ remoteDir = null } = {}) {
  const { deviceLastSeenFile } = getRemotePaths(remoteDir);
  const data = readJsonSafe(deviceLastSeenFile, { lastSeen: {} });
  if (!data || typeof data !== 'object' || typeof data.lastSeen !== 'object' || Array.isArray(data.lastSeen)) {
    return {};
  }
  return { ...data.lastSeen };
}

export function updateDeviceLastSeen(deviceId, ts, { remoteDir = null } = {}) {
  if (!deviceId || typeof deviceId !== 'string') return;
  const { deviceLastSeenFile } = getRemotePaths(remoteDir);
  const current = readDeviceLastSeen({ remoteDir });
  current[deviceId] = ts;
  writeJsonAtomic(deviceLastSeenFile, { lastSeen: current }, { mode: 0o600, dirMode: 0o700 });
}

export function readPairing({ remoteDir = null } = {}) {
  const { pairingFile } = getRemotePaths(remoteDir);
  const data = readJsonSafe(pairingFile, null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

export function writePairing(pairing, { remoteDir = null } = {}) {
  const { pairingFile } = getRemotePaths(remoteDir);
  writeJsonAtomic(pairingFile, pairing, { mode: 0o600, dirMode: 0o700 });
  return pairing;
}

export function clearPairing({ remoteDir = null } = {}) {
  const { pairingFile } = getRemotePaths(remoteDir);
  try {
    fs.rmSync(pairingFile, { force: true });
  } catch {}
}
