/**
 * 1. Single-Instance PID Management
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  PID_FILE,
  RUN_ONCE,
  STATE_DIR,
  attachedTargets,
  runtimeState
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
      return execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }
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
function removeOwnPidFile(pidFile = PID_FILE) {
  try {
    if (!fs.existsSync(pidFile)) return;
    const owner = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (owner === process.pid) {
      fs.rmSync(pidFile, { force: true });
    }
  } catch {}
}

export function claimPidFile({
  pidFile = PID_FILE,
  stateDir = STATE_DIR,
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
    fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
    if (bindExit && !pidCleanupBound && pidFile === PID_FILE) {
      pidCleanupBound = true;
      process.on('exit', () => removeOwnPidFile(PID_FILE));
      for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => {
          if (runtimeState.shuttingDown) return;
          runtimeState.shuttingDown = true;
          const finish = () => {
            removeOwnPidFile(PID_FILE);
            process.exit(0);
          };
          if (runtimeState.activeRelaunchPromise) {
            Promise.race([runtimeState.activeRelaunchPromise, new Promise((r) => setTimeout(r, 6000))]).finally(finish);
          } else {
            finish();
          }
        });
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
