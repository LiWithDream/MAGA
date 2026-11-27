/**
 * Windows Cold-Boot `--remote-debugging-port=0` Bootstrap
 * - CommandLineToArgvW-compatible tokenizer & round-trip quoter
 * - Low-CPU two-tier process probe (tasklist -> CIM query only when needed)
 * - Antigravity Desktop vs IDE disambiguation + electron child-process exclusion
 * - Graceful WM_CLOSE (`taskkill /PID`, never `/F`) + lockfile wait + breakaway relaunch
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import {
  HOME,
  NO_CDP_BOOTSTRAP,
  RELAUNCH_INTENT_FILE,
  RUN_ONCE,
  WIN_DAEMON_META_FILE,
  attachedTargets,
  readJsonOrFallback,
  readPort,
  runtimeState,
  writeAtomicUtf8,
} from './env.mjs';
import { getActiveConfig, rebuildBundleIfNeeded } from './prefs-bundle.mjs';
import {
  encodePowerShellBase64,
  ensureWinStudioShortcut,
  getWinShortcutPath,
  isAntigravityDesktopExe,
  psSingleQuote,
} from './win-service.mjs';

const VALUE_TAKING_PROXY_FLAGS = new Set([
  '--proxy-server',
  '--proxy-bypass-list',
  '--proxy-pac-url',
  '--host-resolver-rules',
  '--ignore-certificate-errors-spki-list',
]);

/**
 * Tokenize a Win32 command line following `CommandLineToArgvW` backslash/quote rules.
 * Backslashes NOT immediately preceding `"` are treated literally (so `C:\Program Files\` is preserved).
 */
export function tokenizeWinCommandLine(cmdLine) {
  const s = String(cmdLine || '');
  const tokens = [];
  const len = s.length;
  let i = 0;

  while (i < len) {
    while (i < len && (s[i] === ' ' || s[i] === '\t')) i += 1;
    if (i >= len) break;

    let arg = '';
    let inQuotes = false;

    while (i < len) {
      let bsCount = 0;
      while (i < len && s[i] === '\\') {
        bsCount += 1;
        i += 1;
      }

      if (i < len && s[i] === '"') {
        arg += '\\'.repeat(Math.floor(bsCount / 2));
        if (bsCount % 2 === 0) {
          if (inQuotes && s[i + 1] === '"') {
            arg += '"';
            i += 2;
          } else {
            inQuotes = !inQuotes;
            i += 1;
          }
        } else {
          arg += '"';
          i += 1;
        }
        continue;
      }

      if (bsCount > 0) {
        arg += '\\'.repeat(bsCount);
      }
      if (i >= len) break;
      if (!inQuotes && (s[i] === ' ' || s[i] === '\t')) break;
      arg += s[i];
      i += 1;
    }

    tokens.push(arg);
  }
  return tokens;
}

/**
 * Exact inverse of `tokenizeWinCommandLine` for Win32 `CreateProcess` / `Win32_Process.Create`.
 */
export function quoteWinArg(arg) {
  const s = String(arg ?? '');
  if (s.length > 0 && !/[\s\t"]/.test(s)) {
    return s;
  }
  let out = '"';
  let bsCount = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\') {
      bsCount += 1;
    } else if (ch === '"') {
      out += '\\'.repeat(bsCount * 2 + 1) + '"';
      bsCount = 0;
    } else {
      if (bsCount > 0) {
        out += '\\'.repeat(bsCount);
        bsCount = 0;
      }
      out += ch;
    }
  }
  if (bsCount > 0) {
    out += '\\'.repeat(bsCount * 2);
  }
  out += '"';
  return out;
}

export function quoteWinCommandLine(argv) {
  return (Array.isArray(argv) ? argv : []).map(quoteWinArg).join(' ');
}

export function parseWinLaunchExtraArgs(cmdLine, exePath = '') {
  const tokens = tokenizeWinCommandLine(cmdLine);
  if (tokens.length === 0) {
    return { extraArgs: [], hasCustomProfile: false, hasAmbiguousArgs: false };
  }
  let rest = tokens.slice(1);
  if (exePath && tokens[0].replace(/\\/g, '/').toLowerCase() !== String(exePath).replace(/\\/g, '/').toLowerCase()) {
    // Even if argv[0] differs slightly (e.g. short path vs full path), argv[0] is still the executable token.
    rest = tokens.slice(1);
  }
  const extraArgs = [];
  let hasCustomProfile = false;
  let hasAmbiguousArgs = false;

  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (!tok) continue;
    if (/^--remote-debugging-port(?:=|$)/i.test(tok)) {
      if (!tok.includes('=') && i + 1 < rest.length && /^\d+$/.test(rest[i + 1])) i += 1;
      continue;
    }
    if (/^--(user-data-dir|extensions-dir|profile-directory)(?:=|$)/i.test(tok)) {
      hasCustomProfile = true;
      continue;
    }
    const lowerTok = tok.toLowerCase();
    if (VALUE_TAKING_PROXY_FLAGS.has(lowerTok) && i + 1 < rest.length && !rest[i + 1].startsWith('-')) {
      extraArgs.push(tok, rest[i + 1]);
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

export function parseWinMainProcesses(rawJson, { nowMs = Date.now(), isDesktopExeFn = isAntigravityDesktopExe } = {}) {
  let rows = [];
  if (typeof rawJson === 'string') {
    const trimmed = rawJson.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
    } catch {
      return [];
    }
  } else if (Array.isArray(rawJson)) {
    rows = rawJson;
  } else if (rawJson && typeof rawJson === 'object') {
    rows = [rawJson];
  }

  const list = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const pid = Number(row.ProcessId);
    const exePath = typeof row.ExecutablePath === 'string' ? row.ExecutablePath.trim() : '';
    const cmd = typeof row.CommandLine === 'string' ? row.CommandLine.trim() : '';
    if (!Number.isInteger(pid) || pid <= 0 || !exePath || !cmd) continue;
    if (/(?:^|\s)--type=/i.test(cmd)) continue;
    if (!isDesktopExeFn(exePath)) continue;
    const createdMs = Number(row.CreatedMs);
    const age = Number.isFinite(createdMs) && createdMs > 0 ? Math.max(0, (nowMs - createdMs) / 1000) : Infinity;
    const argInfo = parseWinLaunchExtraArgs(cmd, exePath);
    list.push({
      pid,
      age,
      exePath,
      cmd,
      hasCdp: /--remote-debugging-port(?:=|\s|$)/i.test(cmd),
      ...argInfo,
    });
  }
  return list;
}

export function buildWinCimCreateScript(commandLine, workingDir) {
  return [
    `$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psSingleQuote(commandLine)}; CurrentDirectory = ${psSingleQuote(workingDir)} }`,
    `if ($null -eq $res -or $res.ReturnValue -ne 0) { exit 1 }`,
  ].join('; ');
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

export async function waitForWinRelaunchReady({
  targetPid,
  isProcessAlive,
  listMainProcs,
  hasLockfile,
  onReadyToOpen,
  nowFn = () => Date.now(),
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  exitTimeoutMs = 8000,
  lockTimeoutMs = 6000,
  pollMs = 150,
  initialSettleMs = 350,
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
    if (!hasLockfile()) {
      const launched = await onReadyToOpen();
      return launched === false ? { relaunched: false, reason: 'launch_failed' } : { relaunched: true };
    }
    if (nowFn() >= lockDeadline) {
      // Target PID already exited after WM_CLOSE; launch anyway rather than leaving Antigravity gone.
      // Chromium single-instance lock either cleans stale lockfiles or forwards to any live holder.
      const launched = await onReadyToOpen();
      return launched === false
        ? { relaunched: false, reason: 'lockfile_held_launch_failed' }
        : { relaunched: true, reason: 'lockfile_timeout_launched' };
    }
    await sleepFn(pollMs);
  }
}

export function startWinCdpBootstrap() {
  if (process.platform !== 'win32' || RUN_ONCE || NO_CDP_BOOTSTRAP) return;
  const appDataDir = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  const agyAppData = path.join(appDataDir, 'Antigravity');
  const portFile = path.join(agyAppData, 'DevToolsActivePort');
  const lockfile = path.join(agyAppData, 'lockfile');
  const convDir = path.join(HOME, '.gemini', 'antigravity', 'conversations');

  let busy = false;
  let lastAttemptAt = 0;
  const attemptedPids = new Map();
  let recentAttempts = [];

  const hasLockfile = () => {
    try {
      return fs.existsSync(lockfile);
    } catch {
      return false;
    }
  };

  const hasTasklistAntigravity = () =>
    new Promise((resolve) => {
      execFile(
        'tasklist',
        ['/FI', 'IMAGENAME eq Antigravity.exe', '/FO', 'CSV', '/NH'],
        { timeout: 2000, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => {
          if (err || !stdout) return resolve(false);
          resolve(/"antigravity\.exe"/i.test(stdout));
        }
      );
    });

  const queryMainProcs = async () => {
    const present = await hasTasklistAntigravity();
    if (!present) return [];
    const ps = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      `$procs = @(Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" | Select-Object ProcessId,ExecutablePath,CommandLine,@{N='CreatedMs';E={[int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}})`,
      '$procs | ConvertTo-Json -Compress',
    ].join('; ');
    return new Promise((resolve) => {
      execFile(
        'powershell',
        ['-NoProfile', '-EncodedCommand', encodePowerShellBase64(ps)],
        { timeout: 4500, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => {
          resolve(!err && stdout ? parseWinMainProcesses(stdout) : []);
        }
      );
    });
  };

  const waitPortAndSync = (triesLeft = 40) => {
    if (readPort(portFile) > 0) {
      runtimeState.syncFn?.().catch(() => {});
      return;
    }
    if (triesLeft > 0) {
      setTimeout(() => waitPortAndSync(triesLeft - 1), 150).unref();
    }
  };

  const launchWinAppBreakaway = async (exePath, extraArgs = []) => {
    try {
      fs.rmSync(portFile, { force: true });
    } catch {}
    const cleanArgs = Array.isArray(extraArgs) ? extraArgs : [];
    const shortcutPath = getWinShortcutPath();
    let meta = readJsonOrFallback(WIN_DAEMON_META_FILE, null);
    const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
    if (
      meta &&
      typeof meta.shortcutExePath === 'string' &&
      norm(meta.shortcutExePath) !== norm(exePath) &&
      fs.existsSync(meta.shortcutPath || shortcutPath)
    ) {
      const targetShortcut = meta.shortcutPath || shortcutPath;
      const refreshed = ensureWinStudioShortcut({ exePath, shortcutPath: targetShortcut, enabled: true });
      if (refreshed.ok) {
        meta = { ...meta, shortcutPath: targetShortcut, shortcutExePath: exePath, updatedAt: Date.now() };
        try {
          writeAtomicUtf8(WIN_DAEMON_META_FILE, `${JSON.stringify(meta, null, 2)}\n`);
        } catch {}
      }
    }
    const canUseShortcut =
      cleanArgs.length === 0 &&
      fs.existsSync(shortcutPath) &&
      typeof meta?.shortcutExePath === 'string' &&
      norm(meta.shortcutExePath) === norm(exePath);

    if (canUseShortcut) {
      const ok = await new Promise((resolve) => {
        execFile('explorer.exe', [shortcutPath], { timeout: 5000, windowsHide: true }, (err) => {
          // explorer.exe often exits with code 1 even after delegating shell launch; verify asynchronously below
          resolve(!err || err.code === 1);
        });
      });
      if (ok) {
        waitPortAndSync(45);
        return true;
      }
    }

    const cmdLine = quoteWinCommandLine([exePath, ...cleanArgs, '--remote-debugging-port=0']);
    const cimScript = buildWinCimCreateScript(cmdLine, path.dirname(exePath));
    const cimOk = await new Promise((resolve) => {
      execFile(
        'powershell',
        ['-NoProfile', '-EncodedCommand', encodePowerShellBase64(cimScript)],
        { timeout: 6000, windowsHide: true },
        (err) => resolve(!err)
      );
    });
    if (cimOk) {
      waitPortAndSync(45);
      return true;
    }

    try {
      const child = spawn(exePath, [...cleanArgs, '--remote-debugging-port=0'], {
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
      });
      child.unref();
      waitPortAndSync(45);
      return Boolean(child.pid);
    } catch {
      return false;
    }
  };

  const clearRelaunchIntent = () => {
    try {
      fs.rmSync(RELAUNCH_INTENT_FILE, { force: true });
    } catch {}
  };

  const recoverInterruptedWinRelaunch = async () => {
    const intent = readJsonOrFallback(RELAUNCH_INTENT_FILE, null);
    if (!intent || typeof intent.startedAt !== 'number' || intent.platform !== 'win32') return;
    clearRelaunchIntent();
    if (Date.now() - intent.startedAt > 30000) return;
    const procs = await queryMainProcs();
    if (procs.length > 0) return;
    if (typeof intent.exePath !== 'string' || !fs.existsSync(intent.exePath)) return;
    console.log(`[Anti-Claude Daemon] Recovering interrupted Windows relaunch for ${intent.exePath}`);
    await launchWinAppBreakaway(intent.exePath, Array.isArray(intent.extraArgs) ? intent.extraArgs : []);
  };

  let emptyStreak = 0;
  let pollTimer = null;

  const scheduleNext = (delayMs) => {
    if (runtimeState.shuttingDown) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(checkFreshLaunch, delayMs);
    pollTimer.unref?.();
  };

  const computeNextDelay = (procs) => {
    const activeConfig = getActiveConfig();
    if (!activeConfig.enabled || attachedTargets.size > 0) return 15000;
    if (procs.some((p) => p.hasCdp)) return 6000;
    if (procs.length === 0) {
      emptyStreak = Math.min(emptyStreak + 1, 6);
      if (emptyStreak <= 2) return 1500;
      if (emptyStreak <= 4) return 2500;
      return 4000;
    }
    emptyStreak = 0;
    return 1000;
  };

  const requestWmClose = async (targetPid) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ok = await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(targetPid)], { timeout: 3000, windowsHide: true }, (err) => resolve(!err));
      });
      if (ok) return true;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
    }
    return false;
  };

  const checkFreshLaunch = () => {
    if (busy || runtimeState.shuttingDown) return;
    rebuildBundleIfNeeded();
    const activeConfig = getActiveConfig();
    if (!activeConfig.enabled || attachedTargets.size > 0) {
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
          console.log(`[Anti-Claude Daemon] Skipping Windows auto-relaunch for PID ${candidate.pid} (custom launch arguments detected)`);
          return;
        }
        if (candidate.age < 3) {
          nextDelay = Math.max(700, Math.ceil((3 - candidate.age) * 1000));
          return;
        }
        if (candidate.age > 15 && hasRecentConversationWalActivity(convDir, 8000)) return;

        const targetPid = candidate.pid;
        const exePath = candidate.exePath;
        const extraArgs = Array.isArray(candidate.extraArgs) ? candidate.extraArgs : [];
        const startTs = Date.now();
        lastAttemptAt = startTs;
        attemptedPids.set(targetPid, startTs);
        recentAttempts.push(startTs);

        console.log(
          `[Anti-Claude Daemon] Relaunching fresh Windows Antigravity (PID ${targetPid}, age=${candidate.age.toFixed(1)}s) with --remote-debugging-port=0`
        );

        const doRelaunch = async () => {
          try {
            writeAtomicUtf8(
              RELAUNCH_INTENT_FILE,
              `${JSON.stringify({ platform: 'win32', targetPid, exePath, extraArgs, startedAt: Date.now() })}\n`
            );
          } catch {}

          const closeSent = await requestWmClose(targetPid);
          if (!closeSent) {
            clearRelaunchIntent();
            console.warn(`[Anti-Claude Daemon] Graceful WM_CLOSE did not succeed for PID ${targetPid}; leaving Antigravity running`);
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

          const outcome = await waitForWinRelaunchReady({
            targetPid,
            isProcessAlive: isPidAlive,
            listMainProcs: queryMainProcs,
            hasLockfile,
            onReadyToOpen: () => launchWinAppBreakaway(exePath, extraArgs),
          });

          clearRelaunchIntent();
          if (!outcome.relaunched) {
            console.warn(`[Anti-Claude Daemon] Windows relaunch did not complete for PID ${targetPid} (reason=${outcome.reason || 'unknown'})`);
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

  recoverInterruptedWinRelaunch()
    .catch(() => {})
    .finally(() => checkFreshLaunch());
}
