/**
 * MAGA Remote Gateway — Configuration, State Paths, Device Lock & Atomic 0600 Storage
 * Zero third-party dependencies (Node >= 22 built-ins only).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export function resolveRemoteDir(overrideDir = null) {
  if (overrideDir && typeof overrideDir === 'string') {
    return path.resolve(overrideDir);
  }
  if (process.env.MAGA_REMOTE_STATE_DIR) {
    return path.resolve(process.env.MAGA_REMOTE_STATE_DIR);
  }
  const stateDir = process.env.ANTI_CLAUDE_STATE_DIR
    ? path.resolve(process.env.ANTI_CLAUDE_STATE_DIR)
    : path.join(os.homedir(), '.gemini', 'antigravity', 'anti-claude');
  return path.join(stateDir, 'remote');
}

export function resolveSockPath(remoteDir = resolveRemoteDir(), overrideSockPath = null) {
  if (overrideSockPath && typeof overrideSockPath === 'string') {
    return path.resolve(overrideSockPath);
  }
  if (process.env.MAGA_REMOTE_SOCK_PATH) {
    return path.resolve(process.env.MAGA_REMOTE_SOCK_PATH);
  }
  const resolvedDir = path.resolve(remoteDir);
  const candidate = path.join(resolvedDir, 'bridge.sock');
  if (Buffer.byteLength(candidate, 'utf8') > 95) {
    const hash12 = crypto.createHash('sha256').update(resolvedDir).digest('hex').slice(0, 12);
    return path.join(os.tmpdir(), `maga-rem-${hash12}.sock`);
  }
  return candidate;
}

export function getRemotePaths(overrideDir = null, overrideSockPath = null) {
  const remoteDir = resolveRemoteDir(overrideDir);
  return {
    remoteDir,
    configFile: path.join(remoteDir, 'config.json'),
    devicesFile: path.join(remoteDir, 'devices.json'),
    devicesLockFile: path.join(remoteDir, 'devices.json.lock'),
    deviceLastSeenFile: path.join(remoteDir, 'device-last-seen.json'),
    pairingFile: path.join(remoteDir, 'pairing.json'),
    pidFile: path.join(remoteDir, 'gateway.pid'),
    auditFile: path.join(remoteDir, 'audit.jsonl'),
    identityFile: path.join(remoteDir, 'gateway-identity.json'),
    sockPath: resolveSockPath(remoteDir, overrideSockPath),
  };
}

export function ensureRemoteDir(dirPath, mode = 0o700) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  try {
    fs.chmodSync(dirPath, mode);
  } catch {}
  return dirPath;
}

function rejectIfSymlink(targetPath) {
  try {
    const lst = fs.lstatSync(targetPath);
    if (lst.isSymbolicLink()) {
      throw new Error(`refusing_symlink_target:${targetPath}`);
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

export function writeAtomicFile(filePath, content, { mode = 0o600, dirMode = 0o700 } = {}) {
  const resolved = path.resolve(filePath);
  ensureRemoteDir(path.dirname(resolved), dirMode);
  rejectIfSymlink(resolved);
  const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    try {
      fs.chmodSync(tmp, mode);
    } catch {}
    fs.renameSync(tmp, resolved);
    try {
      fs.chmodSync(resolved, mode);
    } catch {}
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

export function writeJsonAtomic(filePath, data, opts = {}) {
  writeAtomicFile(filePath, `${JSON.stringify(data, null, 2)}\n`, opts);
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const lst = fs.lstatSync(filePath);
    if (lst.isSymbolicLink() || !lst.isFile()) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

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

export async function withDevicesLock(fn, { remoteDir = null, staleMs = 5000, timeoutMs = 3000 } = {}) {
  const { remoteDir: resolvedDir, devicesLockFile } = getRemotePaths(remoteDir);
  ensureRemoteDir(resolvedDir, 0o700);
  const deadline = Date.now() + timeoutMs;

  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(
        devicesLockFile,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600
      );
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      let healed = false;
      try {
        const st = fs.lstatSync(devicesLockFile);
        if (st.isSymbolicLink()) {
          fs.rmSync(devicesLockFile, { force: true });
          healed = true;
        } else {
          let lockTs = st.mtimeMs;
          try {
            const parsed = JSON.parse(fs.readFileSync(devicesLockFile, 'utf8'));
            if (typeof parsed?.ts === 'number' && Number.isFinite(parsed.ts)) {
              lockTs = parsed.ts;
            }
          } catch {}
          if (Date.now() - lockTs > staleMs) {
            fs.rmSync(devicesLockFile, { force: true });
            healed = true;
          }
        }
      } catch (statErr) {
        if (statErr && statErr.code === 'ENOENT') healed = true;
      }
      if (!healed && Date.now() >= deadline) {
        throw new Error('devices_lock_timeout');
      }
      if (!healed) {
        await new Promise((r) => setTimeout(r, 15));
      }
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(devicesLockFile, { force: true });
    } catch {}
  }
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
