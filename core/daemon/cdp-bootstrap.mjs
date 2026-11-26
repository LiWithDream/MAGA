/**
 * 2. macOS 2.33+ Cold-Boot `--remote-debugging-port=0` Bootstrap
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  HOME,
  NO_CDP_BOOTSTRAP,
  RELAUNCH_INTENT_FILE,
  RUN_ONCE,
  attachedTargets,
  readJsonOrFallback,
  readPort,
  runtimeState,
  writeAtomicUtf8
} from './env.mjs';
import { getActiveConfig, rebuildBundleIfNeeded } from './prefs-bundle.mjs';
import { startWinCdpBootstrap } from './cdp-bootstrap-win.mjs';

export const PRESERVED_RELAUNCH_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'GRPC_PROXY_EXP',
  'grpc_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE'
]);
const PRESERVED_RELAUNCH_ENV_SET = new Set(PRESERVED_RELAUNCH_ENV_KEYS);
const VALUE_TAKING_PROXY_FLAGS = new Set([
  '--proxy-server',
  '--proxy-bypass-list',
  '--proxy-pac-url',
  '--host-resolver-rules',
  '--ignore-certificate-errors-spki-list'
]);

export function sanitizePreservedEnv(envObj) {
  if (!envObj || typeof envObj !== 'object') return {};
  const out = {};
  for (const [k, rawVal] of Object.entries(envObj)) {
    if (!PRESERVED_RELAUNCH_ENV_SET.has(k)) continue;
    if (typeof rawVal !== 'string' || /[\0\r\n]/.test(rawVal)) continue;
    const trimmed = rawVal.trim();
    if (!trimmed) continue;
    out[k] = trimmed;
  }
  return out;
}

export function stripCredentialEnvForDisk(envObj) {
  const clean = sanitizePreservedEnv(envObj);
  const out = {};
  for (const [k, v] of Object.entries(clean)) {
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(v)) continue;
    out[k] = v;
  }
  return out;
}

export function extractPreservedEnvFromPsOutput(psEwwOutput, commandLine = '') {
  let raw = String(psEwwOutput || '').trim();
  if (!raw) return {};
  const trimmedCmd = String(commandLine || '').trim();
  if (trimmedCmd && raw.startsWith(trimmedCmd)) {
    const nextCh = raw.charAt(trimmedCmd.length);
    if (!nextCh || /\s/.test(nextCh)) {
      raw = raw.slice(trimmedCmd.length).trim();
    }
  }
  if (!raw) return {};
  const re = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g;
  const matches = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    matches.push({
      key: m[1],
      valStart: m.index + m[0].length,
      matchStart: m.index
    });
  }
  if (matches.length === 0) return {};
  const extracted = {};
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].matchStart : raw.length;
    extracted[cur.key] = raw.slice(cur.valStart, end).trim();
  }
  return sanitizePreservedEnv(extracted);
}

export function parseLaunchExtraArgs(cmd, mainBin = '') {
  const rawCmd = String(cmd || '');
  const rest = (mainBin && rawCmd.startsWith(mainBin) ? rawCmd.slice(mainBin.length) : rawCmd).trim();
  if (!rest) return { extraArgs: [], hasCustomProfile: false, hasAmbiguousArgs: false };
  const tokens = rest.split(/\s+/).filter(Boolean);
  const extraArgs = [];
  let hasCustomProfile = false;
  let hasAmbiguousArgs = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^-psn_/.test(tok)) continue;
    if (/^--remote-debugging-port(?:=|$)/.test(tok)) {
      if (!tok.includes('=') && i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) i += 1;
      continue;
    }
    if (/^--(user-data-dir|extensions-dir|profile-directory)(?:=|$)/.test(tok)) {
      hasCustomProfile = true;
      continue;
    }
    if (VALUE_TAKING_PROXY_FLAGS.has(tok) && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
      extraArgs.push(tok, tokens[i + 1]);
      i += 1;
      continue;
    }
    if (tok.startsWith('-')) {
      extraArgs.push(tok);
    } else if (fs.existsSync(tok)) {
      extraArgs.push(tok);
    } else {
      hasAmbiguousArgs = true;
    }
  }
  return { extraArgs, hasCustomProfile, hasAmbiguousArgs };
}

export function buildMacOpenArgs(appBundle, extraArgs = [], extraEnv = {}, useNewInstance = true) {
  const argv = useNewInstance ? ['-n', '-a', appBundle] : ['-a', appBundle];
  const cleanEnv = sanitizePreservedEnv(extraEnv);
  for (const [k, v] of Object.entries(cleanEnv)) {
    argv.push('--env', `${k}=${v}`);
  }
  argv.push('--args', ...(Array.isArray(extraArgs) ? extraArgs : []), '--remote-debugging-port=0');
  return argv;
}

function hasRecentConversationWalActivity(conversationsDir, withinMs = 15000) {
  try {
    if (!fs.existsSync(conversationsDir)) return false;
    const now = Date.now();
    for (const name of fs.readdirSync(conversationsDir)) {
      if (!name.endsWith('.db-wal')) continue;
      const st = fs.statSync(path.join(conversationsDir, name), { throwIfNoEntry: false });
      if (st && st.size > 0 && now - st.mtimeMs < withinMs) return true;
    }
  } catch {}
  return false;
}

/**
 * Wait for a terminated Antigravity process to exit and release its Electron `SingletonLock`,
 * checking both lock release and replacement processes across bounded retries so delayed lock
 * cleanup (e.g. ~900ms) never leaves the app closed.
 */
export async function waitForMacRelaunchReady({
  targetPid,
  isProcessAlive,
  listMainProcs,
  hasLock,
  tryClearStaleLock = () => false,
  onReadyToOpen,
  nowFn = () => Date.now(),
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  exitTimeoutMs = 8000,
  lockTimeoutMs = 6000,
  pollMs = 120,
  initialSettleMs = 350
}) {
  const exitDeadline = nowFn() + exitTimeoutMs;
  await sleepFn(pollMs);
  while (isProcessAlive(targetPid)) {
    if (nowFn() >= exitDeadline) {
      return { relaunched: false, reason: 'exit_timeout' };
    }
    await sleepFn(pollMs);
  }

  if (initialSettleMs > 0) {
    await sleepFn(initialSettleMs);
  }

  const lockDeadline = nowFn() + lockTimeoutMs;
  while (true) {
    const afterProcs = await listMainProcs();
    if (Array.isArray(afterProcs) && afterProcs.length > 0) {
      return { relaunched: false, reason: 'replaced_by_other_instance' };
    }
    if (!hasLock()) {
      await onReadyToOpen();
      return { relaunched: true };
    }
    if (nowFn() >= lockDeadline) {
      if (tryClearStaleLock(targetPid) && !hasLock()) {
        await onReadyToOpen();
        return { relaunched: true, staleLockCleared: true };
      }
      return { relaunched: false, reason: 'singleton_lock_held' };
    }
    await sleepFn(pollMs);
  }
}

export function startMacCdpBootstrap() {
  if (process.platform !== 'darwin' || RUN_ONCE || NO_CDP_BOOTSTRAP) return;
  const appDataDir = path.join(HOME, 'Library', 'Application Support', 'Antigravity');
  const portFile = path.join(appDataDir, 'DevToolsActivePort');
  const singletonLock = path.join(appDataDir, 'SingletonLock');
  const convDir = path.join(HOME, '.gemini', 'antigravity', 'conversations');
  const candidateApps = [
    '/Applications/Antigravity.app',
    path.join(HOME, 'Applications', 'Antigravity.app')
  ];
  let busy = false;
  let lastAttemptAt = 0;
  const attemptedPids = new Map();
  let recentAttempts = [];

  const parseEtimeSec = (raw) => {
    const s = String(raw || '').trim();
    let days = 0;
    let rest = s;
    if (s.includes('-')) {
      const [d, r] = s.split('-', 2);
      days = parseInt(d, 10) || 0;
      rest = r;
    }
    const parts = rest.split(':').map((x) => parseInt(x, 10) || 0);
    if (parts.length === 3) return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1];
    return Infinity;
  };

  const parseMainProcesses = (stdout) => {
    const list = [];
    for (const line of String(stdout || '').split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const age = parseEtimeSec(m[2]);
      const cmd = m[3];
      for (const appBundle of candidateApps) {
        const mainBin = path.join(appBundle, 'Contents', 'MacOS', 'Antigravity');
        if (cmd === mainBin || cmd.startsWith(mainBin + ' ')) {
          const argInfo = parseLaunchExtraArgs(cmd, mainBin);
          list.push({
            pid,
            age,
            appBundle,
            cmd,
            hasCdp: cmd.includes('--remote-debugging-port'),
            ...argInfo
          });
          break;
        }
      }
    }
    return list;
  };

  const hasSingletonLock = () => {
    try {
      fs.lstatSync(singletonLock);
      return true;
    } catch {
      return false;
    }
  };

  const tryClearStaleSingletonLock = (expectedDeadPid) => {
    try {
      const linkTarget = fs.readlinkSync(singletonLock);
      const m = String(linkTarget || '').match(/-(\d+)$/);
      if (!m) return false;
      const lockPid = Number(m[1]);
      if (!lockPid) return false;
      if (lockPid !== expectedDeadPid) {
        try {
          process.kill(lockPid, 0);
          return false;
        } catch {}
      }
      fs.rmSync(singletonLock, { force: true });
      return true;
    } catch {
      return false;
    }
  };

  const psEnv = Object.assign({}, process.env);
  delete psEnv.COLUMNS;

  const queryMainProcs = () =>
    new Promise((resolve) => {
      execFile(
        'ps',
        ['-axww', '-o', 'pid=,etime=,command='],
        { timeout: 2500, maxBuffer: 16 * 1024 * 1024, env: psEnv },
        (err, stdout) => {
          resolve(!err && stdout ? parseMainProcesses(stdout) : []);
        }
      );
    });

  const queryProcessPreservedEnv = (pid, commandLine = '') =>
    new Promise((resolve) => {
      if (!pid) return resolve({});
      execFile(
        'ps',
        ['eww', '-p', String(pid), '-o', 'command='],
        { timeout: 1500, maxBuffer: 4 * 1024 * 1024, env: psEnv },
        (err, stdout) => {
          resolve(!err && stdout ? extractPreservedEnvFromPsOutput(stdout, commandLine) : {});
        }
      );
    });

  const waitPortAndSync = (triesLeft = 40) => {
    if (readPort(portFile) > 0) {
      runtimeState.syncFn?.().catch(() => {});
      return;
    }
    if (triesLeft > 0) {
      setTimeout(() => waitPortAndSync(triesLeft - 1), 150).unref();
    }
  };

  const openAppWithRetry = async (appBundle, extraArgs = [], extraEnv = {}) => {
    try {
      fs.rmSync(portFile, { force: true });
    } catch {}
    const sanitizedEnv = sanitizePreservedEnv(extraEnv);
    const hasExtraEnv = Object.keys(sanitizedEnv).length > 0;
    const openEnv = hasExtraEnv ? { ...process.env, ...sanitizedEnv } : process.env;
    const attempts = [true, true, false];
    for (let i = 0; i < attempts.length; i++) {
      const useNewInstance = attempts[i];
      const openArgs = buildMacOpenArgs(appBundle, extraArgs, sanitizedEnv, useNewInstance);
      let err = await new Promise((resolve) => {
        execFile('/usr/bin/open', openArgs, { timeout: 10000, env: openEnv }, (e, _stdout, stderr) => {
          if (!e) return resolve(null);
          if (stderr && !e.stderr) e.stderr = stderr;
          resolve(e);
        });
      });
      if (err && hasExtraEnv && /(?:unrecognized|unknown|illegal)\s+option/i.test(`${err.stderr || ''} ${err.message || ''}`)) {
        const fallbackArgs = buildMacOpenArgs(appBundle, extraArgs, {}, useNewInstance);
        err = await new Promise((resolve) => {
          execFile('/usr/bin/open', fallbackArgs, { timeout: 10000, env: openEnv }, (e) => resolve(e || null));
        });
      }
      if (!err) {
        waitPortAndSync(40);
        return true;
      }
      console.warn(`[Anti-Claude Daemon] open attempt ${i + 1} failed for ${appBundle}: ${err.message || err}`);
      if (i < attempts.length - 1) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    return false;
  };

  const clearRelaunchIntent = () => {
    try {
      fs.rmSync(RELAUNCH_INTENT_FILE, { force: true });
    } catch {}
  };

  const recoverInterruptedRelaunch = async () => {
    const intent = readJsonOrFallback(RELAUNCH_INTENT_FILE, null);
    if (!intent || typeof intent.startedAt !== 'number') return;
    clearRelaunchIntent();
    if (Date.now() - intent.startedAt > 30000) return;
    const procs = await queryMainProcs();
    if (procs.length > 0) return;
    const bundle =
      (typeof intent.appBundle === 'string' && fs.existsSync(intent.appBundle) && intent.appBundle) ||
      candidateApps.find((p) => fs.existsSync(p)) ||
      candidateApps[0];
    console.log(`[Anti-Claude Daemon] Recovering interrupted relaunch for ${bundle}`);
    await openAppWithRetry(
      bundle,
      Array.isArray(intent.extraArgs) ? intent.extraArgs : [],
      sanitizePreservedEnv(intent.extraEnv)
    );
  };

  let emptyStreak = 0;
  let pollTimer = null;

  const scheduleNext = (delayMs) => {
    if (runtimeState.shuttingDown) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(checkFreshLaunch, delayMs);
    pollTimer.unref?.();
  };

  runtimeState.wakeMacBootstrap = () => {
    emptyStreak = 0;
    if (!busy && !runtimeState.shuttingDown) scheduleNext(750);
  };

  const computeNextDelay = (procs) => {
    const activeConfig = getActiveConfig();
    if (!activeConfig.enabled || attachedTargets.size > 0) return 15000;
    if (procs.some((p) => p.hasCdp)) return 6000;
    if (procs.length === 0) {
      emptyStreak = Math.min(emptyStreak + 1, 6);
      if (emptyStreak <= 2) return 1200;
      if (emptyStreak <= 4) return 2200;
      return 3500;
    }
    emptyStreak = 0;
    return 750;
  };

  const checkFreshLaunch = () => {
    if (busy || runtimeState.shuttingDown) return;
    rebuildBundleIfNeeded();
    const activeConfig = getActiveConfig();
    if (!activeConfig.enabled) {
      scheduleNext(15000);
      return;
    }
    if (attachedTargets.size > 0) {
      scheduleNext(15000);
      return;
    }
    const now = Date.now();
    if (now - lastAttemptAt < 2500) {
      scheduleNext(1000);
      return;
    }

    for (const [pid, ts] of attemptedPids.entries()) {
      if (now - ts > 120000) attemptedPids.delete(pid);
    }
    recentAttempts = recentAttempts.filter((ts) => now - ts < 45000);
    if (recentAttempts.length >= 3) {
      scheduleNext(5000);
      return;
    }

    busy = true;
    queryMainProcs().then(async (procs) => {
      let nextDelay = computeNextDelay(procs);
      try {
        if (procs.some((p) => p.hasCdp)) {
          if (readPort(portFile) > 0 && attachedTargets.size === 0) {
            runtimeState.syncFn?.().catch(() => {});
          }
          return;
        }

        if (procs.some((p) => !p.hasCdp && p.age > 35)) {
          nextDelay = 10000;
          return;
        }

        const candidate = procs.find((p) => !p.hasCdp && !attemptedPids.has(p.pid) && p.age <= 35);
        if (!candidate) return;
        if (candidate.hasCustomProfile || candidate.hasAmbiguousArgs) {
          attemptedPids.set(candidate.pid, Date.now());
          console.log(`[Anti-Claude Daemon] Skipping auto-relaunch for PID ${candidate.pid} (custom launch arguments detected)`);
          return;
        }
        if (candidate.age < 1) {
          nextDelay = 900;
          return;
        }
        if (candidate.age > 15 && hasRecentConversationWalActivity(convDir, 8000)) return;

        const targetPid = candidate.pid;
        const appBundle = candidate.appBundle || candidateApps.find((p) => fs.existsSync(p)) || candidateApps[0];
        const extraArgs = Array.isArray(candidate.extraArgs) ? candidate.extraArgs : [];
        const extraEnv = await queryProcessPreservedEnv(targetPid, candidate.cmd);
        const preservedEnvKeys = Object.keys(extraEnv);
        const startTs = Date.now();
        lastAttemptAt = startTs;
        attemptedPids.set(targetPid, startTs);
        recentAttempts.push(startTs);
        const envNote = preservedEnvKeys.length > 0 ? `, preserving env keys=[${preservedEnvKeys.join(', ')}]` : '';
        console.log(
          `[Anti-Claude Daemon] Relaunching fresh Antigravity (PID ${targetPid}, age=${candidate.age}s${envNote}) with --remote-debugging-port=0`
        );

        const doRelaunch = async () => {
          const persistedEnv = stripCredentialEnvForDisk(extraEnv);
          try {
            writeAtomicUtf8(
              RELAUNCH_INTENT_FILE,
              `${JSON.stringify({
                targetPid,
                appBundle,
                extraArgs,
                ...(Object.keys(persistedEnv).length > 0 ? { extraEnv: persistedEnv } : {}),
                startedAt: Date.now()
              })}\n`
            );
          } catch {}

          try {
            process.kill(targetPid, 'SIGTERM');
          } catch {
            clearRelaunchIntent();
            return;
          }

          const isPidAlive = (pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          };

          let outcome = await waitForMacRelaunchReady({
            targetPid,
            isProcessAlive: isPidAlive,
            listMainProcs: queryMainProcs,
            hasLock: hasSingletonLock,
            tryClearStaleLock: tryClearStaleSingletonLock,
            onReadyToOpen: () => openAppWithRetry(appBundle, extraArgs, extraEnv)
          });

          if (!outcome.relaunched && outcome.reason === 'exit_timeout') {
            await new Promise((r) => setTimeout(r, 1500));
            if (!isPidAlive(targetPid)) {
              const lingering = await queryMainProcs();
              if (lingering.length === 0) {
                if (hasSingletonLock()) tryClearStaleSingletonLock(targetPid);
                if (!hasSingletonLock()) {
                  await openAppWithRetry(appBundle, extraArgs, extraEnv);
                  outcome = { relaunched: true, lateExitRecovered: true };
                }
              }
            }
          } else if (!outcome.relaunched && outcome.reason === 'singleton_lock_held') {
            await new Promise((r) => setTimeout(r, 1500));
            const lingering = await queryMainProcs();
            if (lingering.length === 0 && tryClearStaleSingletonLock(targetPid) && !hasSingletonLock()) {
              await openAppWithRetry(appBundle, extraArgs, extraEnv);
              outcome = { relaunched: true, staleLockCleared: true };
            }
          }

          clearRelaunchIntent();
          if (!outcome.relaunched) {
            console.warn(
              `[Anti-Claude Daemon] Relaunch did not complete for PID ${targetPid} (reason=${outcome.reason || 'unknown'})`
            );
          }
        };

        runtimeState.activeRelaunchPromise = doRelaunch().finally(() => {
          runtimeState.activeRelaunchPromise = null;
        });
        await runtimeState.activeRelaunchPromise;
        nextDelay = 1200;
      } finally {
        busy = false;
        scheduleNext(nextDelay);
      }
    });
  };

  recoverInterruptedRelaunch()
    .catch(() => {})
    .finally(() => checkFreshLaunch());
}

export function startCdpBootstrap() {
  if (process.platform === 'darwin') return startMacCdpBootstrap();
  if (process.platform === 'win32') return startWinCdpBootstrap();
}
