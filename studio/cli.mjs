#!/usr/bin/env node
/**
 * MAGA (agy-studio) CLI — unified manager for daemon installation, hot-deploy, rules & diagnostics.
 *
 * Commands:
 *   node studio/cli.mjs install         Build & install daemon from this repo + deploy studio + sync fast-io rules
 *   node studio/cli.mjs deploy          Rebuild & hot-deploy studio JS/CSS bundle into live user/ directory
 *   node studio/cli.mjs sync-rules      Sync critically pruned fast-io rules into ~/.gemini/AGENTS.md
 *   node studio/cli.mjs doctor          Verify daemon, plist, CDP, usage stats, bundle markers & config
 *   node studio/cli.mjs rollback        Strip studio blocks and restore stock defaults
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSS_BEGIN,
  JS_BEGIN,
  REMOTE_PWA_DIST,
  REPO_ROOT,
  TARGET_CUSTOM_CSS,
  TARGET_CUSTOM_JS,
  buildUserCustomJs,
  deployStudio,
  rollbackStudio,
  stripBlock,
  stripStudioBlocksOnly,
} from './build.mjs';
import { PID_FILE as DAEMON_PID_FILE, QUOTA_STATE_FILE, STATE_DIR } from '../core/daemon/env.mjs';
import { collectUsageStatsAsync } from './daemon/usage-service.mjs';
import {
  isOpusGatePluginInstalled,
  syncOpusGatePlugin,
  verifyOpusGateHookNodeRuntime,
} from './daemon/opus-gate-service.mjs';
import {
  isAutoCompactPluginInstalled,
  syncAutoCompactPlugin,
  verifyInstalledHookNodeRuntime,
  verifyLiveScheduleStepDecoder,
} from './daemon/auto-compact-service.mjs';
import {
  findStalePolicyProjects,
  isGitWorkflowPluginInstalled,
  loadGitWorkflowPolicy,
  syncGitWorkflowPlugin,
  verifyGitWorkflowHookNodeRuntime,
} from './daemon/git-workflow-service.mjs';
import { evaluateDeployGuard, readDeployMeta } from './deploy-meta.mjs';

const HOME = homedir();
const AGENTS_MD = path.join(HOME, '.gemini', 'AGENTS.md');
const AGY_CONFIG_JSON = path.join(HOME, '.gemini', 'config', 'config.json');
const DAEMON_PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'com.antigravity.anti-claude.daemon.plist');
const RULES_SRC = path.join(REPO_ROOT, 'studio', 'rules', 'fast-io.md');

const RULE_BEGIN = '<!-- BEGIN agy-fast-io-pruned -->';
const RULE_END = '<!-- END agy-fast-io-pruned -->';
const DEFAULT_ORCHESTRATOR_MODEL_ID = 1532; // Gemini 4 Neon (High)
const DEFAULT_ORCHESTRATOR_MODEL_ENUM = 'MODEL_PLACEHOLDER_M532';

const REMOTE_DIR = path.resolve(process.env.MAGA_REMOTE_STATE_DIR || path.join(STATE_DIR, 'remote'));
const REMOTE_CONFIG_FILE = path.join(REMOTE_DIR, 'config.json');
const REMOTE_PAIRING_FILE = path.join(REMOTE_DIR, 'pairing.json');
const REMOTE_DEVICES_FILE = path.join(REMOTE_DIR, 'devices.json');
const REMOTE_LAST_SEEN_FILE = path.join(REMOTE_DIR, 'device-last-seen.json');
const REMOTE_DEVICES_LOCK_FILE = `${REMOTE_DEVICES_FILE}.lock`;
const REMOTE_IDENTITY_FILE = path.join(REMOTE_DIR, 'gateway-identity.json');
const REMOTE_PID_FILE = path.join(REMOTE_DIR, 'gateway.pid');

const DEVICES_LOCK_STALE_MS = 5000;
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

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureRemoteDir() {
  mkdirSync(REMOTE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(REMOTE_DIR, 0o700);
}

function writeSecretJson(filePath, obj) {
  ensureRemoteDir();
  const dir = path.dirname(filePath);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o600);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
  return dir;
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

async function withDevicesLock(fn) {
  ensureRemoteDir();
  const deadline = Date.now() + 3000;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(
        REMOTE_DEVICES_LOCK_FILE,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      );
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } finally {
        closeSync(fd);
      }
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      let healed = false;
      try {
        const st = lstatSync(REMOTE_DEVICES_LOCK_FILE);
        if (st.isSymbolicLink()) {
          rmSync(REMOTE_DEVICES_LOCK_FILE, { force: true });
          healed = true;
        } else {
          let lockTs = Math.max(st.mtimeMs, st.ctimeMs);
          try {
            const parsed = JSON.parse(readFileSync(REMOTE_DEVICES_LOCK_FILE, 'utf8'));
            if (typeof parsed?.ts === 'number' && Number.isFinite(parsed.ts)) {
              lockTs = parsed.ts;
            }
          } catch {}
          if (Date.now() - lockTs > DEVICES_LOCK_STALE_MS) {
            rmSync(REMOTE_DEVICES_LOCK_FILE, { force: true });
            healed = true;
          }
        }
      } catch (statErr) {
        if (statErr?.code === 'ENOENT') healed = true;
      }
      if (!healed) await sleepMs(20);
    }
  }
  if (!acquired) {
    throw new Error('Timed out acquiring devices.json.lock');
  }
  try {
    return await fn();
  } finally {
    try {
      rmSync(REMOTE_DEVICES_LOCK_FILE, { force: true });
    } catch {}
  }
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

function readProcessCmdline(pid) {
  try {
    return execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
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
    const cmd = readProcessCmdline(pid);
    matchesGateway = Boolean(cmd && /remote[\\/]gateway[\\/]server\.mjs/i.test(cmd));
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
    const cmd = readProcessCmdline(pid);
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

async function handleRemoteCommand(subArgs) {
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
      hints.push(`Daemon is not running; start with: launchctl kickstart -k "gui/${uid}/com.antigravity.anti-claude.daemon"`);
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
    const result = await withDevicesLock(() => {
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
    });
    return result;
  }

  throw new Error(`Unknown remote subcommand: ${sub}\nUse: on | off | status | pair | devices | revoke`);
}

function syncFastIoRules() {
  const block = readFileSync(RULES_SRC, 'utf8').trim();
  const existing = existsSync(AGENTS_MD) ? readFileSync(AGENTS_MD, 'utf8') : '';
  const cleaned = stripBlock(existing, RULE_BEGIN, RULE_END).trim();
  const next = cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`;
  mkdirSync(path.dirname(AGENTS_MD), { recursive: true });
  writeFileSync(AGENTS_MD, next, 'utf8');
  return { ok: true, path: AGENTS_MD };
}

function removeFastIoRules(agentsMdPath = AGENTS_MD) {
  if (!existsSync(agentsMdPath)) {
    return { ok: true, removed: false, path: agentsMdPath };
  }
  const existing = readFileSync(agentsMdPath, 'utf8');
  if (!existing.includes(RULE_BEGIN)) {
    return { ok: true, removed: false, path: agentsMdPath };
  }
  const cleaned = stripBlock(existing, RULE_BEGIN, RULE_END).trim();
  writeFileSync(agentsMdPath, cleaned ? `${cleaned}\n` : '', 'utf8');
  return { ok: true, removed: true, path: agentsMdPath };
}

async function applyCollapsedStepsPreference() {
  // Persist verboseConversationSteps: false on disk AND push into live React pref store via CDP
  // so running Antigravity does not overwrite the disk edit on exit.
  if (existsSync(AGY_CONFIG_JSON)) {
    const cfg = readJsonSafe(AGY_CONFIG_JSON);
    if (cfg && typeof cfg === 'object') {
      cfg.userSettings = cfg.userSettings || {};
      if (cfg.userSettings.verboseConversationSteps !== false) {
        cfg.userSettings.verboseConversationSteps = false;
        writeFileSync(AGY_CONFIG_JSON, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      }
    }
  }
  try {
    const { cdpPrefs } = await import(path.join(REPO_ROOT, 'install.mjs'));
    if (typeof cdpPrefs === 'function') {
      await cdpPrefs({ project4kMode: 1, verboseConversationSteps: false });
    }
  } catch {}
}

async function applyDefaultOrchestratorModelPreference() {
  // Default Orchestrator planner to Gemini 4 Neon (High) only when unset, preserving explicit user overrides.
  let cdpHandled = false;
  try {
    const { cdpPrefs } = await import(path.join(REPO_ROOT, 'install.mjs'));
    if (typeof cdpPrefs === 'function') {
      const live = await cdpPrefs(null, ['orchestratorModel']);
      if (live?.ok) {
        cdpHandled = true;
        const current = live.after?.orchestratorModel;
        if (current === 0 || current === undefined || current === null) {
          await cdpPrefs({ orchestratorModel: DEFAULT_ORCHESTRATOR_MODEL_ID });
        }
      }
    }
  } catch {}
  if (!cdpHandled && existsSync(AGY_CONFIG_JSON)) {
    const cfg = readJsonSafe(AGY_CONFIG_JSON);
    if (cfg && typeof cfg === 'object') {
      cfg.userSettings = cfg.userSettings || {};
      const cur = cfg.userSettings.orchestratorModel;
      if (cur === undefined || cur === null || cur === '' || cur === 0 || cur === 'MODEL_UNSPECIFIED') {
        cfg.userSettings.orchestratorModel = DEFAULT_ORCHESTRATOR_MODEL_ENUM;
        writeFileSync(AGY_CONFIG_JSON, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      }
    }
  }
}

async function runAntiClaudeInstall() {
  await buildUserCustomJs({ writeToRepo: true, allowPrebuilt: true });
  // Strip studio blocks before base install so base custom.{js,css} installs cleanly
  stripStudioBlocksOnly();
  const installScript = path.join(REPO_ROOT, 'install.mjs');
  execFileSync(
    process.execPath,
    [installScript, 'install', '--no-auto-update', '--no-agents-rule', '--no-step-unlock'],
    { stdio: 'inherit', cwd: REPO_ROOT }
  );
  await applyCollapsedStepsPreference();
  await applyDefaultOrchestratorModelPreference();
}

async function runDoctor() {
  let baseDoctor = null;
  try {
    const out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'install.mjs'), 'doctor'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    baseDoctor = JSON.parse(out);
  } catch (err) {
    baseDoctor = { ok: false, error: String(err?.message || err) };
  }

  const plistText = existsSync(DAEMON_PLIST) ? readFileSync(DAEMON_PLIST, 'utf8') : '';
  const pointsToStudio = plistText.includes(path.join(REPO_ROOT, 'core', 'daemon.mjs'));
  const plistDaemonMatch = plistText.match(/<string>([^<]*[\\/]core[\\/]daemon\.mjs)<\/string>/);
  const daemonRepoDir = plistDaemonMatch ? path.dirname(path.dirname(plistDaemonMatch[1].trim())) : null;
  const hasJsMarker = existsSync(TARGET_CUSTOM_JS) && readFileSync(TARGET_CUSTOM_JS, 'utf8').includes(JS_BEGIN);
  const hasCssMarker = existsSync(TARGET_CUSTOM_CSS) && readFileSync(TARGET_CUSTOM_CSS, 'utf8').includes(CSS_BEGIN);
  const agyCfg = readJsonSafe(AGY_CONFIG_JSON);
  const hasFastIo = existsSync(AGENTS_MD) && readFileSync(AGENTS_MD, 'utf8').includes(RULE_BEGIN);
  const usage = await collectUsageStatsAsync({ force: true });
  const deployMeta = readDeployMeta();
  const remoteControl = collectRemoteControlDiagnostics();

  let daemonAlignedWithDeploy = true;
  if (daemonRepoDir && deployMeta.present && deployMeta.meta?.worktreePath) {
    try {
      const a = realpathSync(deployMeta.meta.worktreePath);
      const b = realpathSync(daemonRepoDir);
      daemonAlignedWithDeploy = process.platform === 'darwin' || process.platform === 'win32'
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
    } catch {
      daemonAlignedWithDeploy = deployMeta.meta.worktreePath === daemonRepoDir;
    }
  }
  const daemonSplitBrainWarning =
    !daemonAlignedWithDeploy && deployMeta.meta
      ? `UI/daemon split-brain: live bundle deployed from '${deployMeta.meta.branch || 'unknown'}' (${deployMeta.meta.worktreePath}), while LaunchAgent daemon runs core/daemon.mjs from '${daemonRepoDir}'.`
      : null;

  return {
    ok: Boolean(
      baseDoctor?.ok &&
      pointsToStudio &&
      hasJsMarker &&
      hasCssMarker &&
      usage?.ok &&
      remoteControl.ok
    ),
    repoRoot: REPO_ROOT,
    daemonRepoDir,
    daemonAlignedWithDeploy,
    ...(daemonSplitBrainWarning ? { daemonSplitBrainWarning } : {}),
    deployedFrom: deployMeta.meta,
    ...(deployMeta.nonMainWarning ? { deployedFromWarning: deployMeta.nonMainWarning } : {}),
    daemonPointsToStudio: pointsToStudio,
    studioBundle: { jsInjected: hasJsMarker, cssInjected: hasCssMarker },
    remoteControlEnabled: agyCfg?.userSettings?.remoteControlEnabled ?? agyCfg?.remoteControlEnabled ?? null,
    remoteControl,
    verboseConversationSteps: agyCfg?.userSettings?.verboseConversationSteps ?? null,
    orchestratorModel: agyCfg?.userSettings?.orchestratorModel ?? null,
    fastIoRuleInstalled: hasFastIo,
    opusGatePluginInstalled: isOpusGatePluginInstalled(),
    opusGateHookNode: verifyOpusGateHookNodeRuntime(),
    opusGateQuotaStatePresent: existsSync(QUOTA_STATE_FILE),
    autoCompactPluginInstalled: isAutoCompactPluginInstalled(),
    autoCompactHookNode: verifyInstalledHookNodeRuntime(),
    autoCompactDecoder: verifyLiveScheduleStepDecoder(),
    gitWorkflowPluginInstalled: isGitWorkflowPluginInstalled(),
    gitWorkflowHookNode: verifyGitWorkflowHookNodeRuntime(),
    gitWorkflowStaleProjects: findStalePolicyProjects(loadGitWorkflowPolicy()),
    proxyDiagnostics: collectProxyDiagnostics(),
    usageSummary: {
      daysCount: usage.days.length,
      unread: usage.unread,
      latestDay: usage.days.at(-1)?.date || null,
    },
    baseDoctor,
  };
}

function collectProxyDiagnostics() {
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const shellProxyEnvKeys = proxyKeys.filter((k) => {
    const v = process.env[k];
    return typeof v === 'string' && v.trim().length > 0;
  });
  let systemProxy = null;
  let hint = null;
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 });
      systemProxy = {
        httpEnabled: /\bHTTPEnable\s*:\s*1\b/.test(raw),
        httpsEnabled: /\bHTTPSEnable\s*:\s*1\b/.test(raw),
        socksEnabled: /\bSOCKSEnable\s*:\s*1\b/.test(raw),
        pacEnabled: /\bProxyAutoConfigEnable\s*:\s*1\b/.test(raw),
      };
      const anySysProxy = systemProxy.httpEnabled || systemProxy.httpsEnabled || systemProxy.socksEnabled || systemProxy.pacEnabled;
      if (shellProxyEnvKeys.length > 0 && !anySysProxy) {
        hint = 'Shell proxy env vars detected while macOS System Proxy is disabled; AGY Studio auto-forwards proxy env vars during CDP relaunch, and enabling System Proxy or TUN mode is recommended if Antigravity language_server reports loadCodeAssist: EOF.';
      }
    } catch {
      systemProxy = null;
    }
  }
  return { shellProxyEnvKeys, systemProxy, hint };
}

const isMainModule = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const [cmd = 'deploy', ...cliArgs] = process.argv.slice(2);
  const allowNonMainDeploy =
    cliArgs.includes('--preview') ||
    cliArgs.includes('--force') ||
    process.env.MAGA_DEPLOY_ALLOW_NON_MAIN === '1';
  const skipRulesSync = cliArgs.includes('--no-rules');

  try {
    if (cmd === 'install') {
      const installGuard = evaluateDeployGuard(REPO_ROOT, { allowNonMain: allowNonMainDeploy });
      if (!installGuard.allowed) {
        throw new Error(installGuard.reason);
      }
      await runAntiClaudeInstall();
      const deployRes = await deployStudio({ allowNonMain: allowNonMainDeploy });
      const rulesRes = skipRulesSync
        ? { ok: true, skipped: true, reason: '--no-rules' }
        : syncFastIoRules();
      const pluginRes = syncOpusGatePlugin();
      const compactPluginRes = syncAutoCompactPlugin();
      const gitWorkflowPluginRes = syncGitWorkflowPlugin();
      console.log(JSON.stringify({ ok: true, command: 'install', deploy: deployRes, rules: rulesRes, opusGatePlugin: pluginRes, autoCompactPlugin: compactPluginRes, gitWorkflowPlugin: gitWorkflowPluginRes }, null, 2));
    } else if (cmd === 'deploy') {
      const res = await deployStudio({ allowNonMain: allowNonMainDeploy });
      await applyDefaultOrchestratorModelPreference();
      const shouldSyncPlugins = Boolean(res?.ok && !allowNonMainDeploy && !res?.deployedFrom?.preview);
      const opusGatePluginRes = shouldSyncPlugins
        ? syncOpusGatePlugin()
        : { ok: true, skipped: true, reason: 'preview_deploy' };
      const compactPluginRes = shouldSyncPlugins
        ? syncAutoCompactPlugin()
        : { ok: true, skipped: true, reason: 'preview_deploy' };
      const gitWorkflowPluginRes = shouldSyncPlugins
        ? syncGitWorkflowPlugin()
        : { ok: true, skipped: true, reason: 'preview_deploy' };
      console.log(JSON.stringify({ ...res, opusGatePlugin: opusGatePluginRes, autoCompactPlugin: compactPluginRes, gitWorkflowPlugin: gitWorkflowPluginRes }, null, 2));
    } else if (cmd === 'sync-rules') {
      const rulesRes = syncFastIoRules();
      const pluginRes = syncOpusGatePlugin();
      const compactPluginRes = syncAutoCompactPlugin();
      const gitWorkflowPluginRes = syncGitWorkflowPlugin();
      console.log(JSON.stringify({ ...rulesRes, opusGatePlugin: pluginRes, autoCompactPlugin: compactPluginRes, gitWorkflowPlugin: gitWorkflowPluginRes }, null, 2));
    } else if (cmd === 'doctor') {
      const report = await runDoctor();
      console.log(JSON.stringify(report, null, 2));
      process.exit(report.ok ? 0 : 1);
    } else if (cmd === 'rollback') {
      const rollbackRes = rollbackStudio();
      const rulesRes = removeFastIoRules();
      const pluginRes = syncOpusGatePlugin({ remove: true });
      const compactPluginRes = syncAutoCompactPlugin({ remove: true });
      const gitWorkflowPluginRes = syncGitWorkflowPlugin({ remove: true });
      console.log(JSON.stringify({ ...rollbackRes, rules: rulesRes, opusGatePlugin: pluginRes, autoCompactPlugin: compactPluginRes, gitWorkflowPlugin: gitWorkflowPluginRes }, null, 2));
    } else if (cmd === 'remote') {
      const res = await handleRemoteCommand(cliArgs);
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.error(`Unknown command: ${cmd}\nUse: install | deploy | sync-rules | doctor | rollback | remote`);
      process.exit(1);
    }
  } catch (err) {
    console.error('[AGY Studio]', err?.message || err);
    process.exit(1);
  }
}
