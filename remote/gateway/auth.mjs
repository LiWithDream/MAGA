/**
 * MAGA Remote Gateway — Pairing, Nonce Challenge, ECDSA P-256 Handshake, Device Lock & Lockout
 * Zero third-party dependencies (Node >= 22 built-ins only).
 */
import crypto from 'node:crypto';
import {
  ALLOWED_ROLE_SET,
  clearPairing,
  loadOrCreateGatewayIdentity,
  parseTimestampMs,
  readDevices,
  readPairing,
  updateDeviceLastSeen,
  withDevicesLock,
  writeDevices,
} from './config.mjs';

const MAX_CHALLENGES = 1024;
const MAX_FAILURES_ENTRIES = 2048;

function sanitizePublicKeyJwk(rawJwk) {
  if (!rawJwk || typeof rawJwk !== 'object' || Array.isArray(rawJwk)) {
    return null;
  }
  if (rawJwk.d !== undefined) {
    return null; // Reject any private key material
  }
  if (rawJwk.kty !== 'EC' || rawJwk.crv !== 'P-256') {
    return null;
  }
  if (typeof rawJwk.x !== 'string' || !rawJwk.x || typeof rawJwk.y !== 'string' || !rawJwk.y) {
    return null;
  }
  const clean = {
    kty: 'EC',
    crv: 'P-256',
    x: rawJwk.x,
    y: rawJwk.y,
  };
  try {
    const keyObj = crypto.createPublicKey({ key: clean, format: 'jwk' });
    if (keyObj.asymmetricKeyType !== 'ec') return null;
    return clean;
  } catch {
    return null;
  }
}

export function createAuthManager({
  remoteDir = null,
  audit = null,
  getHealth = async () => null,
  now = Date.now,
  maxFailures = 5,
  lockoutMs = 60_000,
  challengeTtlMs = 30_000,
} = {}) {
  const identity = loadOrCreateGatewayIdentity({ remoteDir, now });
  const gatewayPrivateKey = crypto.createPrivateKey({ key: identity.privateKeyJwk, format: 'jwk' });
  const challenges = new Map();
  const failures = new Map();
  let pairingLock = Promise.resolve();

  function pruneChallenges() {
    const ts = now();
    for (const [nonce, entry] of challenges.entries()) {
      if (ts > entry.expiresAt) {
        challenges.delete(nonce);
      }
    }
    while (challenges.size >= MAX_CHALLENGES) {
      const oldest = challenges.keys().next().value;
      if (oldest === undefined) break;
      challenges.delete(oldest);
    }
  }

  function pruneFailures() {
    const ts = now();
    for (const [k, entry] of failures.entries()) {
      if (entry.lockedUntil && ts >= entry.lockedUntil && entry.count >= maxFailures) {
        failures.delete(k);
      }
    }
    while (failures.size > MAX_FAILURES_ENTRIES) {
      const oldest = failures.keys().next().value;
      if (oldest === undefined) break;
      failures.delete(oldest);
    }
  }

  function checkLockout(clientKey) {
    const key = String(clientKey || 'default');
    const entry = failures.get(key);
    if (!entry) return { locked: false };
    const ts = now();
    if (entry.lockedUntil > ts) {
      return {
        locked: true,
        retryAfterSec: Math.max(1, Math.ceil((entry.lockedUntil - ts) / 1000)),
        lockedUntil: entry.lockedUntil,
      };
    }
    if (entry.lockedUntil > 0 && ts >= entry.lockedUntil) {
      failures.delete(key);
    }
    return { locked: false };
  }

  function recordFailure(clientKey, reason) {
    pruneFailures();
    const key = String(clientKey || 'default');
    const prev = failures.get(key) || { count: 0, lockedUntil: 0 };
    const count = prev.count + 1;
    let lockedUntil = prev.lockedUntil;
    if (count >= maxFailures) {
      lockedUntil = now() + lockoutMs;
      audit?.append('rate_limit_locked', { clientKey: key, reason, failedCount: count, lockedUntil });
    }
    failures.set(key, { count, lockedUntil });
    return { count, lockedUntil };
  }

  function clearFailures(clientKey) {
    failures.delete(String(clientKey || 'default'));
  }

  function issueChallenge(clientKey = 'default') {
    const lock = checkLockout(clientKey);
    if (lock.locked) {
      return { ok: false, status: 429, error: 'rate_limited', retryAfterSec: lock.retryAfterSec };
    }
    pruneChallenges();
    const nonce = crypto.randomBytes(24).toString('base64url');
    const expiresAt = now() + challengeTtlMs;
    challenges.set(nonce, { expiresAt, clientKey: String(clientKey || 'default') });
    return { ok: true, status: 200, nonce, expiresAt };
  }

  async function completePairingInternal(body, { clientKey = 'default', config = null } = {}) {
    if (config?.transport === 'loopback' && config?.allowLocalPairingWithoutEdge === false) {
      return { ok: false, status: 403, error: 'local_pairing_disabled_without_edge' };
    }

    const lock = checkLockout(clientKey);
    if (lock.locked) {
      return { ok: false, status: 429, error: 'rate_limited', retryAfterSec: lock.retryAfterSec };
    }

    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const deviceName = typeof body?.deviceName === 'string' ? body.deviceName.trim().slice(0, 64) : '';
    const cleanJwk = sanitizePublicKeyJwk(body?.publicKeyJwk);
    const turboAcknowledged = body?.turboAcknowledged === true;

    if (!code || !deviceName || !cleanJwk) {
      const f = recordFailure(clientKey, 'invalid_pairing_payload');
      audit?.append('pair_failed', { reason: 'invalid_pairing_payload', clientKey, failedCount: f.count });
      return { ok: false, status: 400, error: 'invalid_pairing_payload' };
    }

    const pairing = readPairing({ remoteDir });
    if (!pairing || typeof pairing.code !== 'string' || !pairing.code) {
      const f = recordFailure(clientKey, 'no_active_pairing');
      audit?.append('pair_failed', { reason: 'no_active_pairing', clientKey, failedCount: f.count });
      return { ok: false, status: 401, error: 'no_active_pairing' };
    }

    const expiresAtMs = parseTimestampMs(pairing.expiresAt);
    const ts = now();
    if (!Number.isFinite(expiresAtMs) || ts > expiresAtMs) {
      clearPairing({ remoteDir });
      const f = recordFailure(clientKey, 'pairing_expired');
      audit?.append('pair_failed', { reason: 'pairing_expired', clientKey, failedCount: f.count });
      return { ok: false, status: 401, error: 'pairing_expired' };
    }

    const providedDigest = crypto.createHash('sha256').update(code, 'utf8').digest();
    const expectedDigest = crypto.createHash('sha256').update(String(pairing.code).trim(), 'utf8').digest();
    if (!crypto.timingSafeEqual(providedDigest, expectedDigest)) {
      const f = recordFailure(clientKey, 'invalid_pairing_code');
      audit?.append('pair_failed', { reason: 'invalid_pairing_code', clientKey, failedCount: f.count });
      return { ok: false, status: 401, error: 'invalid_pairing_code' };
    }

    let health = null;
    try {
      health = await getHealth();
    } catch {
      health = null;
    }
    const preset = health?.globalPreset;
    const requiresTurboAck =
      !health || preset === null || preset === undefined || Number(preset) === 3;
    if (requiresTurboAck && !turboAcknowledged) {
      audit?.append('pair_rejected_turbo_unacknowledged', {
        clientKey,
        deviceName,
        globalPreset: preset ?? null,
      });
      return { ok: false, status: 400, error: 'turbo_acknowledgement_required' };
    }

    // Consume single-use pairing code immediately before writing device
    clearPairing({ remoteDir });

    const role = ALLOWED_ROLE_SET.has(pairing.role) ? pairing.role : 'observe';
    const device = {
      deviceId: crypto.randomUUID(),
      name: deviceName,
      role,
      publicKeyJwk: cleanJwk,
      createdAt: ts,
      lastSeenAt: ts,
      revokedAt: null,
      turboAcknowledged,
    };

    await withDevicesLock(
      () => {
        const existing = readDevices({ remoteDir });
        existing.push(device);
        writeDevices(existing, { remoteDir });
      },
      { remoteDir }
    );

    try {
      updateDeviceLastSeen(device.deviceId, ts, { remoteDir });
    } catch {}
    clearFailures(clientKey);

    audit?.append('pair_success', {
      deviceId: device.deviceId,
      name: device.name,
      role: device.role,
      clientKey,
      turboAcknowledged: device.turboAcknowledged,
    });

    return {
      ok: true,
      status: 200,
      deviceId: device.deviceId,
      role: device.role,
      gatewayFingerprint: identity.gatewayFingerprint,
    };
  }

  function completePairing(body, opts = {}) {
    const run = pairingLock.then(() => completePairingInternal(body, opts));
    pairingLock = run.catch(() => {});
    return run;
  }

  function verifyHello(msg, { clientKey = 'default' } = {}) {
    const normalizedKey = String(clientKey || 'default');
    const lock = checkLockout(normalizedKey);
    if (lock.locked) {
      return { ok: false, error: 'rate_limited', retryAfterSec: lock.retryAfterSec };
    }

    pruneChallenges();

    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      const f = recordFailure(normalizedKey, 'invalid_hello_payload');
      audit?.append('ws_auth_failed', { reason: 'invalid_hello_payload', clientKey: normalizedKey, failedCount: f.count });
      return { ok: false, error: 'invalid_hello_payload' };
    }

    if (msg.type !== 'hello' || msg.protocol !== 'maga-remote/1') {
      const f = recordFailure(normalizedKey, 'invalid_protocol_or_type');
      audit?.append('ws_auth_failed', { reason: 'invalid_protocol_or_type', clientKey: normalizedKey, failedCount: f.count });
      return { ok: false, error: 'invalid_protocol_or_type' };
    }

    const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId.trim() : '';
    const nonce = typeof msg.nonce === 'string' ? msg.nonce.trim() : '';
    const signature = typeof msg.signature === 'string' ? msg.signature.trim() : '';
    const rawLastSeq = msg.lastSeq;
    const validLastSeq =
      rawLastSeq === undefined ||
      rawLastSeq === null ||
      (typeof rawLastSeq === 'number' && Number.isInteger(rawLastSeq) && rawLastSeq >= 0);
    const rawLastEpoch = msg.lastEpoch;
    const validLastEpoch =
      rawLastEpoch === undefined ||
      rawLastEpoch === null ||
      (typeof rawLastEpoch === 'string' && rawLastEpoch.length <= 64);

    if (!deviceId || !nonce || !signature || !validLastSeq || !validLastEpoch) {
      if (nonce) challenges.delete(nonce);
      const f = recordFailure(normalizedKey, 'missing_hello_fields');
      audit?.append('ws_auth_failed', { reason: 'missing_hello_fields', clientKey: normalizedKey, deviceId, failedCount: f.count });
      return { ok: false, error: 'missing_hello_fields' };
    }

    // Consume nonce immediately so replay is impossible even on failure
    const challenge = challenges.get(nonce);
    challenges.delete(nonce);

    const ts = now();
    if (!challenge || ts > challenge.expiresAt) {
      const f = recordFailure(normalizedKey, 'invalid_or_expired_nonce');
      audit?.append('ws_auth_failed', { reason: 'invalid_or_expired_nonce', clientKey: normalizedKey, deviceId, failedCount: f.count });
      return { ok: false, error: 'invalid_or_expired_nonce' };
    }

    if (challenge.clientKey && challenge.clientKey !== normalizedKey) {
      const f = recordFailure(normalizedKey, 'challenge_client_mismatch');
      audit?.append('ws_auth_failed', { reason: 'challenge_client_mismatch', clientKey: normalizedKey, deviceId, failedCount: f.count });
      return { ok: false, error: 'invalid_or_expired_nonce' };
    }

    const devices = readDevices({ remoteDir });
    const device = devices.find((d) => d.deviceId === deviceId) || null;
    if (!device) {
      const f = recordFailure(normalizedKey, 'unknown_device');
      audit?.append('ws_auth_failed', { reason: 'unknown_device', clientKey: normalizedKey, deviceId, failedCount: f.count });
      return { ok: false, error: 'unknown_device' };
    }

    if (device.revokedAt) {
      const f = recordFailure(normalizedKey, 'device_revoked');
      audit?.append('device_revoked_rejected', { clientKey: normalizedKey, deviceId, failedCount: f.count });
      return { ok: false, error: 'device_revoked' };
    }

    const seqVal = rawLastSeq ?? 0;
    const epochVal = typeof rawLastEpoch === 'string' ? rawLastEpoch : '';
    const signedText = `maga-remote/1:hello:${nonce}:${deviceId}:${seqVal}:${epochVal}`;
    let sigValid = false;
    try {
      const sigBuf = Buffer.from(signature, 'base64url');
      if (sigBuf.length === 64) {
        const pubKey = crypto.createPublicKey({ key: device.publicKeyJwk, format: 'jwk' });
        sigValid = crypto.verify(
          'sha256',
          Buffer.from(signedText, 'utf8'),
          { key: pubKey, dsaEncoding: 'ieee-p1363' },
          sigBuf
        );
      }
    } catch {
      sigValid = false;
    }

    if (!sigValid) {
      const f = recordFailure(normalizedKey, 'invalid_signature');
      audit?.append('ws_auth_failed', { reason: 'invalid_signature', clientKey: normalizedKey, deviceId, failedCount: f.count });
      return { ok: false, error: 'invalid_signature' };
    }

    clearFailures(normalizedKey);
    // Persist lastSeenAt in dedicated device-last-seen.json so devices.json has single-writer lock safety
    try {
      updateDeviceLastSeen(device.deviceId, ts, { remoteDir });
    } catch {}
    audit?.append('ws_auth_success', { deviceId: device.deviceId, role: device.role, clientKey: normalizedKey });

    return { ok: true, device, lastSeq: seqVal, lastEpoch: epochVal };
  }

  function getActiveDevice(deviceId) {
    if (!deviceId || typeof deviceId !== 'string') return null;
    const devices = readDevices({ remoteDir });
    const device = devices.find((d) => d.deviceId === deviceId);
    if (!device || device.revokedAt) return null;
    return device;
  }

  function isDeviceActive(deviceId) {
    return Boolean(getActiveDevice(deviceId));
  }

  function signGatewayPayload(text) {
    return crypto
      .sign('sha256', Buffer.from(String(text), 'utf8'), {
        key: gatewayPrivateKey,
        dsaEncoding: 'ieee-p1363',
      })
      .toString('base64url');
  }

  return {
    gatewayFingerprint: identity.gatewayFingerprint,
    gatewayPublicKeyJwk: identity.publicKeyJwk,
    issueChallenge,
    completePairing,
    verifyHello,
    checkLockout,
    getActiveDevice,
    isDeviceActive,
    signGatewayPayload,
  };
}
