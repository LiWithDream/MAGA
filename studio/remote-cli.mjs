/**
 * AGY Studio Remote Control CLI — remote subcommands & doctor diagnostics.
 */
import crypto from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { REMOTE_PWA_DIST } from './build.mjs';
import { PID_FILE as DAEMON_PID_FILE, STATE_DIR } from '../core/daemon/env.mjs';
import { WIN_TASK_NAME, getWinStartupVbsPath, inspectWinCoreDaemon } from '../core/daemon/win-service.mjs';
import {
  getRemotePaths,
  isPidAlive,
  isPosixPermsEnforced,
  readJsonSafe,
  readProcessCommandLineSync,
  withDevicesLock,
  writeJsonAtomic,
} from '../remote/shared/fs-paths.mjs';

const REMOTE_PATHS = getRemotePaths(null, null, {
  env: process.env.ANTI_CLAUDE_STATE_DIR ? process.env : { ...process.env, ANTI_CLAUDE_STATE_DIR: STATE_DIR },
});
const REMOTE_DIR = REMOTE_PATHS.remoteDir;
const REMOTE_CONFIG_FILE = REMOTE_PATHS.configFile;
const REMOTE_PAIRING_FILE = REMOTE_PATHS.pairingFile;
const REMOTE_DEVICES_FILE = REMOTE_PATHS.devicesFile;
const REMOTE_LAST_SEEN_FILE = REMOTE_PATHS.deviceLastSeenFile;
const REMOTE_IDENTITY_FILE = REMOTE_PATHS.identityFile;
const REMOTE_PID_FILE = REMOTE_PATHS.pidFile;

const VALID_TRANSPORTS = new Set(['loopback', 'tailscale-serve', 'cloudflare-access']);
const VALID_ROLES = new Set(['observe', 'steer', 'admin']);
const DEFAULT_REMOTE_CONFIG = {
  enabled: false,
  port: 18791,
  transport: 'loopback',
  allowedHosts: ['127.0.0.1', 'localhost'],
  allowedOrigins: [],
  cfAccessTeamDomain: '',
  cfAccessAud: '',
  tailscaleAllowedUsers: [],
  allowLocalPairingWithoutEdge: true,
};

function writeSecretJson(filePath, obj) {
  writeJsonAtomic(filePath, obj, { mode: 0o600, dirMode: 0o700 });
}

function parseFlagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i];
    if (tok === flag && i + 1 < args.length) return args[i + 1];
    if (tok.startsWith(`${flag}=`)) return tok.slice(flag.length + 1);
  }
  return null;
}

function parseCsvFlag(args, flag) {
  const raw = parseFlagValue(args, flag);
  if (raw === null) return null;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readGatewayPidInfo() {
  if (!existsSync(REMOTE_PID_FILE)) {
    return { present: false, pid: null, port: null, startedAt: null, alive: false, matchesGateway: false };
  }
  let raw = '';
  try {
    raw = readFileSync(REMOTE_PID_FILE, 'utf8').trim();
  } catch {
    return { present: false, pid: null, port: null, startedAt: null, alive: false, matchesGateway: false };
  }
  let pid = null;
  let port = null;
  let startedAt = null;
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      pid = Number.isInteger(Number(parsed?.pid)) ? Number(parsed.pid) : null;
      port = Number.isInteger(Number(parsed?.port)) ? Number(parsed.port) : null;
      startedAt = parsed?.startedAt ?? null;
    } catch {}
  } else {
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n > 1) pid = n;
  }
  const alive = isPidAlive(pid);
  let matchesGateway = false;
  if (alive) {
    const cmd = readProcessCommandLineSync(pid);
    matchesGateway = Boolean(cmd && /remote[\\/]+gateway[\\/]+server\.mjs/i.test(cmd));
  }
  return { present: true, pid, port, startedAt, alive: alive && matchesGateway, matchesGateway };
}

function readRemoteConfig() {
  const saved = readJsonSafe(REMOTE_CONFIG_FILE);
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    return { ...DEFAULT_REMOTE_CONFIG, ...saved };
  }
  return { ...DEFAULT_REMOTE_CONFIG };
}

function readGatewayFingerprintFromIdentity(identity) {
  if (!identity || typeof identity !== 'object') return '';
  if (typeof identity.gatewayFingerprint === 'string' && identity.gatewayFingerprint.trim()) {
    return identity.gatewayFingerprint.trim();
  }
  if (typeof identity.fingerprint === 'string' && identity.fingerprint.trim()) {
    return identity.fingerprint.trim();
  }
  return '';
}

function ensureGatewayIdentity() {
  const existing = readJsonSafe(REMOTE_IDENTITY_FILE);
  const existingFp = readGatewayFingerprintFromIdentity(existing);
  if (existingFp && existing?.publicKeyJwk && existing?.privateKeyJwk) {
    return { ...existing, gatewayFingerprint: existingFp };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKeyJwk = publicKey.export({ format: 'jwk' });
  const privateKeyJwk = privateKey.export({ format: 'jwk' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const identity = {
    gatewayFingerprint: existingFp || crypto.createHash('sha256').update(spkiDer).digest('hex'),
    publicKeyJwk,
    privateKeyJwk,
    createdAt: existing?.createdAt || Date.now(),
  };
  writeSecretJson(REMOTE_IDENTITY_FILE, identity);
  return identity;
}

function isDaemonRunning() {
  if (!existsSync(DAEMON_PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(DAEMON_PID_FILE, 'utf8').trim(), 10);
    if (!isPidAlive(pid)) return false;
    const cmd = readProcessCommandLineSync(pid);
    return !cmd || /daemon\.mjs/i.test(cmd);
  } catch {
    return false;
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function collectRemoteControlDiagnostics() {
  const cfgExists = existsSync(REMOTE_CONFIG_FILE);
  const rawCfg = cfgExists ? readJsonSafe(REMOTE_CONFIG_FILE) : null;
  const cfg = rawCfg && typeof rawCfg === 'object' && !Array.isArray(rawCfg)
    ? { ...DEFAULT_REMOTE_CONFIG, ...rawCfg }
    : { ...DEFAULT_REMOTE_CONFIG };
  const pidInfo = readGatewayPidInfo();
  const devicesDoc = readJsonSafe(REMOTE_DEVICES_FILE);
  const devices = Array.isArray(devicesDoc?.devices) ? devicesDoc.devices : [];
  const activeDevices = devices.filter((d) => !d?.revokedAt);
  const pwaBuilt =
    existsSync(path.join(REMOTE_PWA_DIST, 'index.html')) &&
    existsSync(path.join(REMOTE_PWA_DIST, 'app.js'));

  const dangerousIssues = [];
  const bindHost = String(rawCfg?.bindHost || rawCfg?.host || rawCfg?.listenHost || rawCfg?.hostname || '127.0.0.1').trim();
  if (bindHost !== '127.0.0.1') {
    dangerousIssues.push({
      level: 'error',
      code: 'non_loopback_bind',
      message: `Remote gateway bindHost must strictly be 127.0.0.1, found "${bindHost}"`,
    });
  }

  const transport = String(cfg.transport || 'loopback');
  if (!VALID_TRANSPORTS.has(transport)) {
    dangerousIssues.push({
      level: 'error',
      code: 'invalid_transport',
      message: `Unknown or unsupported remote transport "${transport}"`,
    });
  }

  if (Array.isArray(cfg.allowedHosts) && cfg.allowedHosts.some((h) => h === '*' || h === '0.0.0.0')) {
    dangerousIssues.push({
      level: 'error',
      code: 'wildcard_allowed_host',
      message: 'allowedHosts contains wildcard or 0.0.0.0',
    });
  }
  if (Array.isArray(cfg.allowedOrigins) && cfg.allowedOrigins.some((o) => o === '*')) {
    dangerousIssues.push({
      level: 'error',
      code: 'wildcard_allowed_origin',
      message: 'allowedOrigins contains wildcard "*"',
    });
  }

  const sev = cfg.enabled ? 'error' : 'warn';
  if (transport === 'tailscale-serve' && (!Array.isArray(cfg.tailscaleAllowedUsers) || cfg.tailscaleAllowedUsers.length === 0)) {
    dangerousIssues.push({
      level: sev,
      code: 'missing_tailscale_allowlist',
      message: 'tailscale-serve transport has empty tailscaleAllowedUsers allowlist (fail-closed will deny requests)',
    });
  }
  if (transport === 'cloudflare-access' && (!String(cfg.cfAccessTeamDomain || '').trim() || !String(cfg.cfAccessAud || '').trim())) {
    dangerousIssues.push({
      level: sev,
      code: 'missing_cf_access_config',
      message: 'cloudflare-access transport requires cfAccessTeamDomain and cfAccessAud',
    });
  }
  if (cfg.enabled && !pwaBuilt) {
    dangerousIssues.push({
      level: 'warn',
      code: 'remote_pwa_not_built',
      message: 'Remote PWA dist bundle is missing; run "npm run build:remote"',
    });
  }

  if (isPosixPermsEnforced()) {
    for (const [label, targetPath, expectedMask] of [
      ['remote_dir', REMOTE_DIR, 0o077],
      ['config.json', REMOTE_CONFIG_FILE, 0o077],
      ['devices.json', REMOTE_DEVICES_FILE, 0o077],
      ['pairing.json', REMOTE_PAIRING_FILE, 0o077],
    ]) {
      if (!existsSync(targetPath)) continue;
      try {
        const mode = lstatSync(targetPath).mode & 0o777;
        if ((mode & expectedMask) !== 0) {
          dangerousIssues.push({
            level: 'warn',
            code: 'permissive_file_permissions',
            message: `${label} has overly permissive mode 0o${mode.toString(8)}`,
          });
        }
      } catch {}
    }
  }

  return {
    ok: dangerousIssues.filter((x) => x.level === 'error').length === 0,
    stateDir: REMOTE_DIR,
    configured: cfgExists,
    enabled: Boolean(cfg.enabled),
    transport,
    port: Number(cfg.port || 18791),
    bindHost,
    gatewayRunning: pidInfo.alive,
    gatewayPid: pidInfo.alive ? pidInfo.pid : null,
    pwaBuilt,
    deviceCount: devices.length,
    activeDeviceCount: activeDevices.length,
    dangerousIssues,
  };
}

export async function handleRemoteCommand(subArgs) {
  const [sub = 'status', ...rest] = subArgs;

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    return {
      ok: true,
      usage: [
        'node studio/cli.mjs remote on [--port <p>] [--transport <loopback|tailscale-serve|cloudflare-access>] [--allow-hosts <h1,h2>] [--allow-origins <o1,o2>] [--tailscale-users <u1,u2>] [--cf-team-domain <domain>] [--cf-aud <aud>]',
        'node studio/cli.mjs remote off',
        'node studio/cli.mjs remote status',
        'node studio/cli.mjs remote pair [--role <observe|steer|admin>] [--ttl <sec>]',
        'node studio/cli.mjs remote devices',
        'node studio/cli.mjs remote revoke <deviceId>',
      ],
    };
  }

  if (sub === 'on') {
    const portRaw = parseFlagValue(rest, '--port');
    const transportRaw = parseFlagValue(rest, '--transport');
    const allowHostsRaw = parseCsvFlag(rest, '--allow-hosts');
    const allowOriginsRaw = parseCsvFlag(rest, '--allow-origins');
    const tailscaleUsersRaw = parseCsvFlag(rest, '--tailscale-users');
    const cfTeamDomainRaw = parseFlagValue(rest, '--cf-team-domain');
    const cfAudRaw = parseFlagValue(rest, '--cf-aud');
    const nextCfg = readRemoteConfig();
    delete nextCfg.cfMtlsAllowedFingerprints;

    if (portRaw !== null) {
      const portNum = Number(portRaw);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        throw new Error(`Invalid --port "${portRaw}" (expected integer 1..65535)`);
      }
      nextCfg.port = portNum;
    }
    if (transportRaw !== null) {
      if (!VALID_TRANSPORTS.has(transportRaw)) {
        throw new Error(`Invalid --transport "${transportRaw}" (expected: ${Array.from(VALID_TRANSPORTS).join(' | ')})`);
      }
      nextCfg.transport = transportRaw;
    }
    if (allowHostsRaw !== null) {
      if (allowHostsRaw.some((h) => h === '*' || h === '0.0.0.0')) {
        throw new Error('Invalid --allow-hosts: wildcard "*" or "0.0.0.0" is forbidden');
      }
      nextCfg.allowedHosts = allowHostsRaw.length > 0 ? allowHostsRaw.map((h) => h.toLowerCase()) : ['127.0.0.1', 'localhost'];
    }
    if (allowOriginsRaw !== null) {
      if (allowOriginsRaw.some((o) => o === '*')) {
        throw new Error('Invalid --allow-origins: wildcard "*" is forbidden');
      }
      nextCfg.allowedOrigins = allowOriginsRaw;
    }
    if (tailscaleUsersRaw !== null) {
      nextCfg.tailscaleAllowedUsers = tailscaleUsersRaw.map((u) => u.toLowerCase());
    }
    if (cfTeamDomainRaw !== null) {
      nextCfg.cfAccessTeamDomain = cfTeamDomainRaw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    }
    if (cfAudRaw !== null) {
      nextCfg.cfAccessAud = cfAudRaw.trim();
    }

    if (nextCfg.transport === 'tailscale-serve' && (!Array.isArray(nextCfg.tailscaleAllowedUsers) || nextCfg.tailscaleAllowedUsers.length === 0)) {
      throw new Error('tailscale-serve transport requires --tailscale-users <user1,user2> (fail-closed)');
    }
    if (nextCfg.transport === 'cloudflare-access' && (!String(nextCfg.cfAccessTeamDomain || '').trim() || !String(nextCfg.cfAccessAud || '').trim())) {
      throw new Error('cloudflare-access transport requires --cf-team-domain <domain> and --cf-aud <aud> (fail-closed)');
    }

    nextCfg.enabled = true;
    writeSecretJson(REMOTE_CONFIG_FILE, nextCfg);

    const daemonRunning = isDaemonRunning();
    const diag = collectRemoteControlDiagnostics();
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const hints = [];
    if (!daemonRunning) {
      if (process.platform === 'win32') {
        let winDiag = null;
        try {
          winDiag = inspectWinCoreDaemon();
        } catch {}
        if (winDiag?.mode === 'vbs' || (!winDiag?.installed && existsSync(getWinStartupVbsPath()))) {
          const vbs = winDiag?.startupVbs || getWinStartupVbsPath();
          hints.push(`Daemon is not running; start with: wscript "${vbs}" (or re-run powershell -ExecutionPolicy Bypass -File .\\install.ps1)`);
        } else {
          const tn = winDiag?.taskName || WIN_TASK_NAME;
          hints.push(`Daemon is not running; start with: schtasks /run /tn ${tn} (or re-run powershell -ExecutionPolicy Bypass -File .\\install.ps1)`);
        }
      } else if (process.platform === 'darwin') {
        hints.push(`Daemon is not running; start with: launchctl kickstart -k "gui/${uid}/com.antigravity.anti-claude.daemon"`);
      } else {
        hints.push('Daemon is not running; start with: systemctl --user restart anti-claude-daemon.service');
      }
    }
    if (!diag.pwaBuilt) {
      hints.push('Remote PWA dist is missing; run: npm run build:remote');
    }

    return {
      ok: true,
      command: 'remote on',
      configPath: REMOTE_CONFIG_FILE,
      config: nextCfg,
      daemonRunning,
      pwaBuilt: diag.pwaBuilt,
      warnings: diag.dangerousIssues,
      hint: hints.join(' | ') || 'Remote Control enabled; daemon will supervise gateway startup.',
    };
  }

  if (sub === 'off') {
    const nextCfg = readRemoteConfig();
    nextCfg.enabled = false;
    writeSecretJson(REMOTE_CONFIG_FILE, nextCfg);

    const pidInfo = readGatewayPidInfo();
    let signalSent = false;
    let stopped = false;
    if (pidInfo.alive && pidInfo.pid) {
      try {
        process.kill(pidInfo.pid, 'SIGTERM');
        signalSent = true;
        for (let i = 0; i < 15; i += 1) {
          await sleepMs(100);
          if (!isPidAlive(pidInfo.pid)) {
            stopped = true;
            break;
          }
        }
        if (stopped && existsSync(REMOTE_PID_FILE)) {
          try {
            rmSync(REMOTE_PID_FILE, { force: true });
          } catch {}
        }
      } catch (err) {
        throw new Error(`Failed to SIGTERM gateway pid ${pidInfo.pid}: ${err?.message || err}`);
      }
    }

    return {
      ok: true,
      command: 'remote off',
      configPath: REMOTE_CONFIG_FILE,
      enabled: false,
      pid: pidInfo.pid,
      signalSent,
      stopped,
    };
  }

  if (sub === 'status') {
    const cfg = readRemoteConfig();
    const pidInfo = readGatewayPidInfo();
    const identity = readJsonSafe(REMOTE_IDENTITY_FILE);
    const devicesDoc = readJsonSafe(REMOTE_DEVICES_FILE);
    const devices = Array.isArray(devicesDoc?.devices) ? devicesDoc.devices : [];
    const port = pidInfo.port || cfg.port || 18791;

    let healthStatus = pidInfo.alive ? 'checking' : 'stopped';
    let health = null;
    let note = null;

    if (pidInfo.alive) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          health = await res.json().catch(() => null);
          healthStatus = 'ok';
        } else if (res.status === 401 || res.status === 403) {
          healthStatus = 'edge_auth_required';
          note = `Gateway is running on 127.0.0.1:${port}, protected by fail-closed edge transport (${cfg.transport}).`;
        } else {
          healthStatus = `http_${res.status}`;
        }
      } catch (err) {
        healthStatus = 'unreachable';
        note = String(err?.message || 'Health endpoint unreachable');
      }
    }

    return {
      ok: true,
      command: 'remote status',
      stateDir: REMOTE_DIR,
      configExists: existsSync(REMOTE_CONFIG_FILE),
      config: cfg,
      gateway: {
        running: pidInfo.alive,
        pid: pidInfo.alive ? pidInfo.pid : null,
        startedAt: pidInfo.startedAt,
        port,
        healthStatus,
        health,
        note,
      },
      gatewayFingerprint: readGatewayFingerprintFromIdentity(identity) || null,
      deviceCount: devices.length,
      activeDeviceCount: devices.filter((d) => !d?.revokedAt).length,
      diagnostics: collectRemoteControlDiagnostics(),
    };
  }

  if (sub === 'pair') {
    const roleRaw = parseFlagValue(rest, '--role') || 'observe';
    const ttlRaw = parseFlagValue(rest, '--ttl');
    if (!VALID_ROLES.has(roleRaw)) {
      throw new Error(`Invalid --role "${roleRaw}" (expected: ${Array.from(VALID_ROLES).join(' | ')})`);
    }
    let ttlSec = 60;
    if (ttlRaw !== null) {
      const n = Number(ttlRaw);
      if (!Number.isInteger(n) || n < 10 || n > 3600) {
        throw new Error(`Invalid --ttl "${ttlRaw}" (expected integer 10..3600 seconds)`);
      }
      ttlSec = n;
    }

    const cfg = readRemoteConfig();
    const pidInfo = readGatewayPidInfo();
    const port = pidInfo.port || cfg.port || 18791;
    const identity = ensureGatewayIdentity();
    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    const now = Date.now();
    const pairing = {
      code,
      expiresAt: now + ttlSec * 1000,
      role: roleRaw,
      gatewayFingerprint: identity.gatewayFingerprint,
      createdAt: now,
    };
    writeSecretJson(REMOTE_PAIRING_FILE, pairing);

    return {
      ok: true,
      command: 'remote pair',
      code,
      role: roleRaw,
      ttlSec,
      expiresAt: pairing.expiresAt,
      gatewayFingerprint: identity.gatewayFingerprint,
      localUrl: `http://127.0.0.1:${port}/#pair=${encodeURIComponent(code)}`,
      pairingFile: REMOTE_PAIRING_FILE,
      gatewayRunning: pidInfo.alive,
      hint: pidInfo.alive
        ? `Open localUrl (or enter code ${code} manually) within ${ttlSec}s.`
        : `Code saved (valid ${ttlSec}s). Gateway is not running; run "node studio/cli.mjs remote on" and ensure daemon is active.`,
    };
  }

  if (sub === 'devices') {
    const doc = readJsonSafe(REMOTE_DEVICES_FILE);
    const lastSeenMap = readJsonSafe(REMOTE_LAST_SEEN_FILE);
    const devices = (Array.isArray(doc?.devices) ? doc.devices : []).map((d) => ({
      deviceId: d.deviceId,
      name: d.name || '',
      role: d.role || 'observe',
      createdAt: d.createdAt ?? null,
      lastSeenAt: lastSeenMap?.[d.deviceId] ?? d.lastSeenAt ?? null,
      revokedAt: d.revokedAt ?? null,
      turboAcknowledged: Boolean(d.turboAcknowledged),
    }));
    return {
      ok: true,
      command: 'remote devices',
      devicesFile: REMOTE_DEVICES_FILE,
      total: devices.length,
      active: devices.filter((d) => !d.revokedAt).length,
      revoked: devices.filter((d) => Boolean(d.revokedAt)).length,
      devices,
    };
  }

  if (sub === 'revoke') {
    const targetId = (rest.find((tok) => !tok.startsWith('-')) || '').trim();
    if (!targetId) {
      throw new Error('Usage: node studio/cli.mjs remote revoke <deviceId>');
    }
    const result = await withDevicesLock(
      () => {
        const doc = readJsonSafe(REMOTE_DEVICES_FILE);
        const devices = Array.isArray(doc?.devices) ? doc.devices : [];
        const target = devices.find((d) => d && d.deviceId === targetId);
        if (!target) {
          throw new Error(`Device not found: ${targetId}`);
        }
        if (!target.revokedAt) {
          target.revokedAt = Date.now();
        }
        writeSecretJson(REMOTE_DEVICES_FILE, { ...(doc && typeof doc === 'object' ? doc : {}), devices });
        return {
          ok: true,
          command: 'remote revoke',
          deviceId: target.deviceId,
          name: target.name || '',
          revokedAt: target.revokedAt,
          message: '已吊销，网关将踢下线',
        };
      },
      { remoteDir: REMOTE_DIR }
    );
    return result;
  }

  throw new Error(`Unknown remote subcommand: ${sub}\nUse: on | off | status | pair | devices | revoke`);
}
