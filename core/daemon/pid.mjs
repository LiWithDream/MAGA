/**
 * 1. Single-Instance PID Management
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PID_FILE,
  RUN_ONCE,
  STATE_DIR,
  STOP_SIGNAL_FILE,
  attachedTargets,
  readJsonOrFallback,
  runtimeState,
  writeAtomicUtf8
} from './env.mjs';

function readProcessCommandLine(pid) {
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (raw) return raw.replace(/\0+/g, ' ').trim();
    } catch {}
  }
  if (process.platform === 'win32') {
    try {
      const ps = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`;
      return execFileSync(
        'powershell',
        ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
    } catch {
      return '';
    }
  }
  try {
    return execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return '';
  }
}

export function isOwnDaemonProcess(pid, { commandReader = readProcessCommandLine, killProbe = process.kill } = {}) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  if (num === process.pid) return true;
  try {
    killProbe(num, 0);
  } catch {
    return false;
  }
  const cmd = String(commandReader(num) || '');
  if (!cmd) return false;
  return /(?:^|[\\/ "'])daemon\.mjs(?:\s|$|["'])|anti-claude[\\/]+core[\\/]+daemon\.mjs/i.test(cmd);
}

let pidCleanupBound = false;
let stopWatcherHandle = null;

function removeOwnPidFile(pidFile = PID_FILE) {
  try {
    if (!fs.existsSync(pidFile)) return;
    const owner = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (owner === process.pid) {
      fs.rmSync(pidFile, { force: true });
    }
  } catch {}
}

function triggerGracefulShutdown(pidFile = PID_FILE, { onStop = null } = {}) {
  if (typeof onStop === 'function') {
    onStop();
    return;
  }
  if (runtimeState.shuttingDown) return;
  runtimeState.shuttingDown = true;
  if (stopWatcherHandle) {
    try {
      stopWatcherHandle.stop();
    } catch {}
    stopWatcherHandle = null;
  }
  const finish = () => {
    for (const [, entry] of attachedTargets.entries()) {
      try {
        entry.ws.close();
      } catch {}
    }
    removeOwnPidFile(pidFile);
    process.exit(0);
  };
  if (runtimeState.activeRelaunchPromise) {
    Promise.race([runtimeState.activeRelaunchPromise, new Promise((r) => setTimeout(r, 6000))]).finally(finish);
  } else {
    finish();
  }
}

export function requestCooperativeStop(targetPid = 0, { stopFile = STOP_SIGNAL_FILE } = {}) {
  const payload = {
    targetPid: Number(targetPid) > 0 ? Number(targetPid) : 0,
    requestedAt: Date.now()
  };
  writeAtomicUtf8(stopFile, `${JSON.stringify(payload)}\n`);
  return payload;
}

export function checkStopSignal({ stopFile = STOP_SIGNAL_FILE, pidFile = PID_FILE, onStop = null } = {}) {
  try {
    if (!stopFile || !fs.existsSync(stopFile)) return false;
    const doc = readJsonOrFallback(stopFile, null);
    if (!doc || typeof doc !== 'object') return false;
    const targetPid = Number(doc.targetPid) || 0;
    if (targetPid !== 0 && targetPid !== process.pid) return false;
    try {
      fs.rmSync(stopFile, { force: true });
    } catch {}
    triggerGracefulShutdown(pidFile, { onStop });
    return true;
  } catch {
    return false;
  }
}

export function startStopSignalWatcher({
  stateDir = STATE_DIR,
  stopFile = STOP_SIGNAL_FILE,
  pidFile = PID_FILE,
  onStop = null,
  pollMs = 500
} = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const targetName = path.basename(stopFile).toLowerCase();
  let watcher = null;
  let stopped = false;

  const check = () => {
    if (stopped) return;
    checkStopSignal({ stopFile, pidFile, onStop });
  };

  try {
    watcher = fs.watch(stateDir, (_eventType, filename) => {
      if (!filename || String(filename).toLowerCase() === targetName) {
        check();
      }
    });
    watcher.unref?.();
  } catch {}

  const interval = setInterval(check, Math.max(100, Number(pollMs) || 500));
  interval.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
      if (watcher) {
        try {
          watcher.close();
        } catch {}
        watcher = null;
      }
    }
  };
}

export function claimPidFile({
  pidFile = PID_FILE,
  stateDir = STATE_DIR,
  stopFile = STOP_SIGNAL_FILE,
  runOnce = RUN_ONCE,
  isDaemonFn = isOwnDaemonProcess,
  killFn = process.kill,
  bindExit = true
} = {}) {
  if (runOnce) return;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    if (fs.existsSync(pidFile)) {
      const prevPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (prevPid > 0 && prevPid !== process.pid && isDaemonFn(prevPid)) {
        try {
          killFn(prevPid, 'SIGTERM');
        } catch {}
      }
    }
    if (stopFile && fs.existsSync(stopFile)) {
      const stale = readJsonOrFallback(stopFile, null);
      const staleTarget = Number(stale?.targetPid) || 0;
      if (staleTarget !== process.pid) {
        try {
          fs.rmSync(stopFile, { force: true });
        } catch {}
      }
    }
    fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
    if (bindExit && !pidCleanupBound && pidFile === PID_FILE) {
      pidCleanupBound = true;
      process.on('exit', () => removeOwnPidFile(PID_FILE));
      if (process.platform === 'win32' && !stopWatcherHandle) {
        stopWatcherHandle = startStopSignalWatcher({ stateDir, stopFile, pidFile: PID_FILE });
      }
      for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => triggerGracefulShutdown(PID_FILE));
      }
    }
  } catch {}
}

export function checkPidOwnership({
  pidFile = PID_FILE,
  stateDir = STATE_DIR,
  runOnce = RUN_ONCE,
  isDaemonFn = isOwnDaemonProcess,
  onSuperseded = null
} = {}) {
  if (runOnce) return 'once';
  try {
    if (!fs.existsSync(pidFile)) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
      return 'reclaimed_missing';
    }
    const owner = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (owner === process.pid) return 'owned';
    if (owner > 0 && isDaemonFn(owner)) {
      if (typeof onSuperseded === 'function') {
        onSuperseded(owner);
        return 'superseded';
      }
      /* A newer verified daemon took over PID_FILE; exit cleanly */
      for (const [, entry] of attachedTargets.entries()) {
        try {
          entry.ws.close();
        } catch {}
      }
      process.exit(0);
    }
    /* Stale or reused non-daemon PID: reclaim ownership rather than exiting */
    fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
    return 'reclaimed_stale';
  } catch {
    return 'error';
  }
}
