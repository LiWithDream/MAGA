/**
 * AGY Studio Remote Control — Desktop Settings RPC Backend
 * Manages config.json, pairing.json, devices.json, diagnostics & immediate gateway reconcile.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, attachedTargets } from '../env.mjs';
import {
  DEFAULT_REMOTE_CONFIG,
  getRemotePaths,
  loadOrCreateGatewayIdentity,
  loadRemoteConfig,
  readDeviceLastSeen,
  readDevices,
  readJsonSafe,
  saveRemoteConfig,
  withDevicesLock,
  writeDevices,
  writePairing,
} from '../../../remote/gateway/config.mjs';

export const REMOTE_SETTINGS_RPC_ACTIONS = new Set([
  'getRemoteControlStatus',
  'saveRemoteControlConfig',
  'createRemotePairing',
  'revokeRemoteDevice',
  'updateRemoteDeviceRole',
  'runRemoteDiagnostics',
]);

const VALID_TRANSPORTS = new Set(['loopback', 'cloudflare-access', 'tailscale-serve']);
const VALID_PAIR_ROLES = new Set(['observe', 'steer']);
const DEFAULT_PWA_DIST_DIR = path.join(REPO_ROOT, 'remote', 'pwa', 'dist');

function execFileAsync(bin, args, timeoutMs = 1000) {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout || '').trim() });
    });
  });
}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 1) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultCheckGatewayCmdline(pid) {
  if (process.platform === 'win32') {
    const res = await execFileAsync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      1200
    );
    return res.stdout;
  }
  const res = await execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'command='], 1200);
  return res.stdout;
}

async function readGatewayRuntimeInfo(remoteDir, opts = {}) {
  const paths = getRemotePaths(remoteDir);
  const pidObj = readJsonSafe(paths.pidFile, null);
  const pid = Number.isInteger(Number(pidObj?.pid)) ? Number(pidObj.pid) : null;
  const port = Number.isInteger(Number(pidObj?.port)) ? Number(pidObj.port) : null;
  const startedAt = pidObj?.startedAt ?? null;

  if (!pid || !isPidAlive(pid)) {
    return { running: false, pid: null, port, startedAt, matchesGateway: false };
  }
  const cmdFn = typeof opts.checkProcessCmd === 'function' ? opts.checkProcessCmd : defaultCheckGatewayCmdline;
  const cmd = await cmdFn(pid).catch(() => '');
  const matchesGateway = Boolean(cmd && /remote[\\/]+gateway[\\/]+server\.mjs/i.test(cmd));
  return {
    running: matchesGateway,
    pid: matchesGateway ? pid : null,
    port,
    startedAt,
    matchesGateway,
  };
}

async function probeGatewayHealth(port, cfg, gwInfo, opts = {}) {
  if (!gwInfo.running) return 'stopped';
  if (typeof opts.fetchHealth === 'function') {
    return opts.fetchHealth({ port, config: cfg, gwInfo });
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(1200),
    });
    if (res.ok) return 'ok';
    if ((res.status === 401 || res.status === 403) && cfg.transport !== 'loopback') {
      return 'edge_auth_required';
    }
    return `http_${res.status}`;
  } catch {
    return 'unreachable';
  }
}

async function defaultCheckBinary(name) {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  const res = await execFileAsync(tool, [name], 800);
  return Boolean(res.ok && res.stdout);
}

function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

export function derivePublicBaseUrl(cfg) {
  const config = cfg && typeof cfg === 'object' ? cfg : DEFAULT_REMOTE_CONFIG;
  const port = Number(config.port || 18791);
  if (config.transport === 'cloudflare-access' || config.transport === 'tailscale-serve') {
    const origins = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [];
    for (const orig of origins) {
      try {
        const u = new URL(String(orig || '').trim());
        if (u.protocol === 'https:' && !isLoopbackHost(u.hostname)) {
          return u.origin;
        }
      } catch {}
    }
    const hosts = Array.isArray(config.allowedHosts) ? config.allowedHosts : [];
    for (const host of hosts) {
      const clean = String(host || '').trim().toLowerCase();
      if (clean && !isLoopbackHost(clean) && !clean.startsWith('127.0.0.1:') && !clean.startsWith('localhost:')) {
        return `https://${clean}`;
      }
    }
  }
  return `http://127.0.0.1:${port}`;
}

function normalizeCsvOrArray(val, lowercase = false) {
  let list = [];
  if (Array.isArray(val)) list = val.map((x) => String(x ?? '').trim());
  else if (typeof val === 'string') list = val.split(/[\s,]+/).map((x) => x.trim());
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item) continue;
    const norm = lowercase ? item.toLowerCase() : item;
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

function parsePublicUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return { empty: true, ok: true };
  if (/[\s*?]/.test(trimmed) || trimmed === '0.0.0.0') return { ok: false, error: 'invalid_public_url' };
  const candidate = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u;
  try {
    u = new URL(candidate);
  } catch {
    return { ok: false, error: 'invalid_public_url' };
  }
  const hostname = u.hostname.toLowerCase();
  if (!hostname || hostname === '*' || hostname === '0.0.0.0') {
    return { ok: false, error: 'invalid_public_url' };
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(hostname))) {
    return { ok: false, error: 'public_url_must_be_https' };
  }
  return {
    ok: true,
    empty: false,
    origin: u.origin.toLowerCase(),
    hostWithPort: u.host.toLowerCase(),
    hostname,
  };
}

function isPwaDistReady(pwaDistDir = DEFAULT_PWA_DIST_DIR) {
  return (
    fs.existsSync(path.join(pwaDistDir, 'index.html')) &&
    fs.existsSync(path.join(pwaDistDir, 'app.js'))
  );
}

function readHostAttachmentCount(opts = {}) {
  if (typeof opts.hostCount === 'number') return opts.hostCount;
  let count = 0;
  for (const [, entry] of attachedTargets.entries()) {
    if (entry?.hostConfirmed && entry.type === 'page') count += 1;
  }
  return count;
}

function loadSafeRemoteConfig(remoteDir) {
  try {
    return loadRemoteConfig({ remoteDir });
  } catch {
    return { ...DEFAULT_REMOTE_CONFIG };
  }
}

function inspectRemoteConfigAndPermissions(remoteDir, cfg, pwaDistDir, gwInfo, healthStatus) {
  const paths = getRemotePaths(remoteDir);
  const items = [];
  const pushItem = (id, level, code, message) => items.push({ id, level, code, message });

  if (!fs.existsSync(paths.configFile)) {
    pushItem('cfg', 'info', 'not_configured', 'config.json not created yet (using defaults)');
  }
  if (Array.isArray(cfg.allowedHosts) && cfg.allowedHosts.some((h) => h === '*' || h === '0.0.0.0')) {
    pushItem('hosts', 'error', 'wildcard_allowed_host', 'allowedHosts contains wildcard "*" or 0.0.0.0');
  }
  if (Array.isArray(cfg.allowedOrigins) && cfg.allowedOrigins.some((o) => o === '*')) {
    pushItem('origins', 'error', 'wildcard_allowed_origin', 'allowedOrigins contains wildcard "*"');
  }

  const edgeSev = cfg.enabled ? 'error' : 'warn';
  if (cfg.transport === 'cloudflare-access') {
    if (!String(cfg.cfAccessTeamDomain || '').trim() || !String(cfg.cfAccessAud || '').trim()) {
      pushItem('cf', edgeSev, 'missing_cf_access_config', 'Cloudflare Access requires Team Domain and AUD Tag');
    }
    const pub = derivePublicBaseUrl(cfg);
    if (!pub.startsWith('https://')) {
      pushItem('pub', 'warn', 'missing_public_url', 'No HTTPS custom domain set in allowedOrigins/allowedHosts');
    }
  } else if (cfg.transport === 'tailscale-serve') {
    if (!Array.isArray(cfg.tailscaleAllowedUsers) || cfg.tailscaleAllowedUsers.length === 0) {
      pushItem('ts', edgeSev, 'missing_tailscale_allowlist', 'Tailscale Serve requires at least one allowed user email');
    }
  }

  const pwaBuilt = isPwaDistReady(pwaDistDir);
  if (!pwaBuilt) {
    pushItem('pwa', cfg.enabled ? 'warn' : 'info', 'remote_pwa_not_built', 'Remote PWA dist missing; run "npm run build:remote"');
  }

  for (const [label, targetPath] of [
    ['remote_dir', paths.remoteDir],
    ['config.json', paths.configFile],
    ['devices.json', paths.devicesFile],
    ['pairing.json', paths.pairingFile],
  ]) {
    if (!fs.existsSync(targetPath)) continue;
    try {
      const mode = fs.lstatSync(targetPath).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        pushItem(`perm_${label}`, 'warn', 'permissive_file_permissions', `${label} has overly permissive mode 0o${mode.toString(8)}`);
      }
    } catch {}
  }

  if (cfg.enabled && !gwInfo.running) {
    pushItem('gw', 'warn', 'gateway_not_running', 'Gateway enabled in config but child process is not running');
  } else if (gwInfo.running && healthStatus === 'unreachable') {
    pushItem('health', 'error', 'health_unreachable', 'Gateway process is running but loopback /api/health is unreachable');
  }

  const hasError = items.some((x) => x.level === 'error');
  return { ok: !hasError, items, pwaBuilt };
}

export async function getRemoteControlStatus(opts = {}) {
  const remoteDir = opts.remoteDir || null;
  const pwaDistDir = opts.pwaDistDir || DEFAULT_PWA_DIST_DIR;
  const paths = getRemotePaths(remoteDir);
  const cfg = loadSafeRemoteConfig(remoteDir);
  const gwInfo = await readGatewayRuntimeInfo(remoteDir, opts);
  const effectivePort = gwInfo.port || cfg.port || 18791;
  const healthStatus = await probeGatewayHealth(effectivePort, cfg, gwInfo, opts);

  const identity = readJsonSafe(paths.identityFile, null);
  const gatewayFingerprint =
    typeof identity?.gatewayFingerprint === 'string' && identity.gatewayFingerprint.trim()
      ? identity.gatewayFingerprint.trim()
      : null;

  const rawDevices = readDevices({ remoteDir });
  const lastSeenMap = readDeviceLastSeen({ remoteDir });
  const devices = rawDevices.map((d) => ({
    deviceId: d.deviceId,
    name: String(d.name || d.deviceId.slice(0, 8)),
    role: String(d.role || 'observe'),
    createdAt: d.createdAt ?? null,
    lastSeenAt: lastSeenMap?.[d.deviceId] ?? d.lastSeenAt ?? null,
    revokedAt: d.revokedAt ?? null,
    turboAcknowledged: Boolean(d.turboAcknowledged),
  }));

  const activeDevices = devices.filter((d) => !d.revokedAt);
  const hostCount = readHostAttachmentCount(opts);
  const diag = inspectRemoteConfigAndPermissions(remoteDir, cfg, pwaDistDir, gwInfo, healthStatus);

  return {
    ok: true,
    configured: fs.existsSync(paths.configFile),
    config: {
      enabled: Boolean(cfg.enabled),
      port: Number(cfg.port || 18791),
      transport: String(cfg.transport || 'loopback'),
      allowedHosts: Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts : [...DEFAULT_REMOTE_CONFIG.allowedHosts],
      allowedOrigins: Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : [],
      cfAccessTeamDomain: String(cfg.cfAccessTeamDomain || ''),
      cfAccessAud: cfg.cfAccessAud ?? '',
      tailscaleAllowedUsers: Array.isArray(cfg.tailscaleAllowedUsers) ? cfg.tailscaleAllowedUsers : [],
      allowLocalPairingWithoutEdge: cfg.allowLocalPairingWithoutEdge !== false,
    },
    publicBaseUrl: derivePublicBaseUrl(cfg),
    gateway: {
      running: gwInfo.running,
      pid: gwInfo.pid,
      port: effectivePort,
      startedAt: gwInfo.startedAt,
      healthStatus,
    },
    hostAttached: hostCount > 0,
    hostCount,
    gatewayFingerprint,
    pwaBuilt: diag.pwaBuilt,
    devices,
    activeDeviceCount: activeDevices.length,
    revokedDeviceCount: devices.length - activeDevices.length,
    diagnostics: { ok: diag.ok, items: diag.items },
  };
}

export async function saveRemoteControlConfig(payload = {}, opts = {}) {
  const remoteDir = opts.remoteDir || null;
  const cur = loadSafeRemoteConfig(remoteDir);
  const next = {
    enabled: payload.enabled !== undefined ? Boolean(payload.enabled) : Boolean(cur.enabled),
    port: payload.port !== undefined ? Number(payload.port) : Number(cur.port || 18791),
    transport: payload.transport !== undefined ? String(payload.transport).trim() : String(cur.transport || 'loopback'),
    allowedHosts: [...(Array.isArray(cur.allowedHosts) ? cur.allowedHosts : DEFAULT_REMOTE_CONFIG.allowedHosts)],
    allowedOrigins: [...(Array.isArray(cur.allowedOrigins) ? cur.allowedOrigins : [])],
    cfAccessTeamDomain:
      payload.cfAccessTeamDomain !== undefined
        ? String(payload.cfAccessTeamDomain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase()
        : String(cur.cfAccessTeamDomain || ''),
    cfAccessAud: payload.cfAccessAud !== undefined ? String(payload.cfAccessAud || '').trim() : (cur.cfAccessAud ?? ''),
    tailscaleAllowedUsers:
      payload.tailscaleAllowedUsers !== undefined
        ? normalizeCsvOrArray(payload.tailscaleAllowedUsers, true)
        : [...(Array.isArray(cur.tailscaleAllowedUsers) ? cur.tailscaleAllowedUsers : [])],
    allowLocalPairingWithoutEdge:
      payload.allowLocalPairingWithoutEdge !== undefined
        ? Boolean(payload.allowLocalPairingWithoutEdge)
        : cur.allowLocalPairingWithoutEdge !== false,
  };

  if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65535) {
    return { ok: false, error: 'invalid_port' };
  }
  if (!VALID_TRANSPORTS.has(next.transport)) {
    return { ok: false, error: 'invalid_transport' };
  }

  if (payload.allowedHosts !== undefined) {
    next.allowedHosts = normalizeCsvOrArray(payload.allowedHosts, true);
  }
  if (payload.allowedOrigins !== undefined) {
    next.allowedOrigins = normalizeCsvOrArray(payload.allowedOrigins, false);
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'publicUrl')) {
    const parsed = parsePublicUrl(payload.publicUrl);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const extraHosts =
      payload.allowedHosts !== undefined
        ? next.allowedHosts
        : next.allowedHosts.filter((h) => isLoopbackHost(h.split(':')[0]));
    const extraOrigins = payload.allowedOrigins !== undefined ? next.allowedOrigins : [];
    const hostSet = new Set(['127.0.0.1', 'localhost', ...extraHosts]);
    const originSet = new Set(extraOrigins);
    if (!parsed.empty) {
      hostSet.add(parsed.hostname);
      if (parsed.hostWithPort !== parsed.hostname) hostSet.add(parsed.hostWithPort);
      originSet.add(parsed.origin);
    }
    next.allowedHosts = Array.from(hostSet);
    next.allowedOrigins = Array.from(originSet);
  }

  if (next.allowedHosts.some((h) => h === '*' || h === '0.0.0.0') || next.allowedOrigins.some((o) => o === '*')) {
    return { ok: false, error: 'wildcard_forbidden' };
  }

  if (next.enabled) {
    if (next.transport === 'cloudflare-access') {
      const hasAud = Array.isArray(next.cfAccessAud) ? next.cfAccessAud.length > 0 : Boolean(String(next.cfAccessAud || '').trim());
      if (!next.cfAccessTeamDomain || !hasAud) {
        return { ok: false, error: 'missing_cf_access_config' };
      }
    }
    if (next.transport === 'tailscale-serve' && next.tailscaleAllowedUsers.length === 0) {
      return { ok: false, error: 'missing_tailscale_allowlist' };
    }
  }

  saveRemoteConfig(next, { remoteDir });

  if (typeof opts.onConfigChanged === 'function') {
    await opts.onConfigChanged(next);
  } else {
    try {
      const { triggerRemoteGatewayReconcile } = await import('../remote-bridge.mjs');
      triggerRemoteGatewayReconcile();
    } catch {}
  }

  const status = await getRemoteControlStatus(opts);
  return { ...status, saved: true };
}

export async function createRemotePairing(payload = {}, opts = {}) {
  const remoteDir = opts.remoteDir || null;
  const role = typeof payload.role === 'string' ? payload.role.trim() : 'observe';
  if (!VALID_PAIR_ROLES.has(role)) {
    return { ok: false, error: 'invalid_role' };
  }
  const ttlRaw = payload.ttlSec !== undefined ? Number(payload.ttlSec) : 120;
  if (!Number.isInteger(ttlRaw) || ttlRaw < 30 || ttlRaw > 600) {
    return { ok: false, error: 'invalid_ttl' };
  }

  const nowTs = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const cfg = loadSafeRemoteConfig(remoteDir);
  const gwInfo = await readGatewayRuntimeInfo(remoteDir, opts);
  const identity = loadOrCreateGatewayIdentity({ remoteDir, now: () => nowTs });
  const code = crypto.randomBytes(8).toString('hex').toUpperCase();
  const expiresAt = nowTs + ttlRaw * 1000;

  writePairing(
    {
      code,
      expiresAt,
      role,
      gatewayFingerprint: identity.gatewayFingerprint,
      createdAt: nowTs,
    },
    { remoteDir }
  );

  const port = gwInfo.port || cfg.port || 18791;
  const localUrl = `http://127.0.0.1:${port}/#pair=${encodeURIComponent(code)}`;
  const publicBase = derivePublicBaseUrl(cfg);
  const pairingUrl =
    cfg.transport !== 'loopback' && publicBase.startsWith('https://')
      ? `${publicBase}/#pair=${encodeURIComponent(code)}`
      : localUrl;

  return {
    ok: true,
    code,
    role,
    ttlSec: ttlRaw,
    expiresAt,
    localUrl,
    pairingUrl,
    gatewayFingerprint: identity.gatewayFingerprint,
    gatewayRunning: gwInfo.running,
  };
}

export async function revokeRemoteDevice(payload = {}, opts = {}) {
  const remoteDir = opts.remoteDir || null;
  const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId.trim() : '';
  if (!deviceId) return { ok: false, error: 'invalid_device_id' };

  const nowTs = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const outcome = await withDevicesLock(
    () => {
      const devices = readDevices({ remoteDir });
      const target = devices.find((d) => d.deviceId === deviceId);
      if (!target) return { found: false };
      if (!target.revokedAt) target.revokedAt = nowTs;
      writeDevices(devices, { remoteDir });
      return { found: true, revokedAt: target.revokedAt };
    },
    { remoteDir }
  );

  if (!outcome.found) return { ok: false, error: 'device_not_found' };
  const status = await getRemoteControlStatus(opts);
  return { ...status, revokedDeviceId: deviceId, revokedAt: outcome.revokedAt };
}

export async function updateRemoteDeviceRole(payload = {}, opts = {}) {
  const remoteDir = opts.remoteDir || null;
  const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId.trim() : '';
  const role = typeof payload.role === 'string' ? payload.role.trim() : '';
  if (!deviceId) return { ok: false, error: 'invalid_device_id' };
  if (!VALID_PAIR_ROLES.has(role)) return { ok: false, error: 'invalid_role' };

  const outcome = await withDevicesLock(
    () => {
      const devices = readDevices({ remoteDir });
      const target = devices.find((d) => d.deviceId === deviceId);
      if (!target) return { ok: false, error: 'device_not_found' };
      if (target.revokedAt) return { ok: false, error: 'device_revoked' };
      target.role = role;
      writeDevices(devices, { remoteDir });
      return { ok: true };
    },
    { remoteDir }
  );

  if (!outcome.ok) return outcome;
  const status = await getRemoteControlStatus(opts);
  return { ...status, updatedDeviceId: deviceId, role };
}

export async function runRemoteDiagnostics(opts = {}) {
  const remoteDir = opts.remoteDir || null;
  const pwaDistDir = opts.pwaDistDir || DEFAULT_PWA_DIST_DIR;
  const cfg = loadSafeRemoteConfig(remoteDir);
  const gwInfo = await readGatewayRuntimeInfo(remoteDir, opts);
  const port = gwInfo.port || cfg.port || 18791;
  const healthStatus = await probeGatewayHealth(port, cfg, gwInfo, opts);
  const diag = inspectRemoteConfigAndPermissions(remoteDir, cfg, pwaDistDir, gwInfo, healthStatus);

  const checkBin = typeof opts.checkBinary === 'function' ? opts.checkBinary : defaultCheckBinary;
  const [cloudflared, tailscale] = await Promise.all([
    checkBin('cloudflared').catch(() => false),
    checkBin('tailscale').catch(() => false),
  ]);

  const items = [...diag.items];
  if (cfg.transport === 'cloudflare-access' && !cloudflared) {
    items.push({
      id: 'bin_cf',
      level: 'warn',
      code: 'cloudflared_missing',
      message: 'cloudflared CLI not found in PATH (brew install cloudflared)',
    });
  }
  if (cfg.transport === 'tailscale-serve' && !tailscale) {
    items.push({
      id: 'bin_ts',
      level: 'warn',
      code: 'tailscale_missing',
      message: 'tailscale CLI not found in PATH',
    });
  }

  return {
    ok: !items.some((x) => x.level === 'error'),
    items,
    binaries: { cloudflared: Boolean(cloudflared), tailscale: Boolean(tailscale) },
    healthStatus,
    gatewayRunning: gwInfo.running,
    pwaBuilt: diag.pwaBuilt,
  };
}

export async function handleRemoteSettingsRpc(action, payload = {}, opts = {}) {
  switch (action) {
    case 'getRemoteControlStatus':
      return getRemoteControlStatus(opts);
    case 'saveRemoteControlConfig':
      return saveRemoteControlConfig(payload, opts);
    case 'createRemotePairing':
      return createRemotePairing(payload, opts);
    case 'revokeRemoteDevice':
      return revokeRemoteDevice(payload, opts);
    case 'updateRemoteDeviceRole':
      return updateRemoteDeviceRole(payload, opts);
    case 'runRemoteDiagnostics':
      return runRemoteDiagnostics(opts);
    default:
      return { ok: false, error: `unknown_action:${action}` };
  }
}
