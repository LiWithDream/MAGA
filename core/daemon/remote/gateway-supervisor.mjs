/**
 * AGY Studio Remote Control — Gateway Child Process Supervisor & Orphan Reclaim
 */
import { execFile, fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, readJsonOrFallback } from '../env.mjs';
import { DEFAULT_REMOTE_CONFIG } from './disk-fallback.mjs';

const GATEWAY_RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

function readRemoteConfigSig(configFile) {
  try {
    return fs.readFileSync(configFile, 'utf8');
  } catch {
    return '';
  }
}

function readProcessCommandLineAsync(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'linux') {
      try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (raw) return resolve(raw.replace(/\0+/g, ' ').trim());
      } catch {}
    }
    if (process.platform === 'win32') {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', timeout: 1500 },
        (err, stdout) => resolve(err ? '' : String(stdout || '').trim())
      );
      return;
    }
    execFile('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1500 }, (err, stdout) =>
      resolve(err ? '' : String(stdout || '').trim())
    );
  });
}

export function stopGatewayChildSync(state) {
  if (!state?.gatewayChild) return;
  const child = state.gatewayChild;
  state.gatewayChild = null;
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = 0;
  }
  try {
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGTERM');
    }
  } catch {}
}

export async function stopGatewayChildGracefully(state) {
  if (!state?.gatewayChild) return;
  const child = state.gatewayChild;
  state.gatewayChild = null;
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = 0;
  }
  if (child.killed || child.exitCode !== null) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolve();
    };
    child.once('exit', finish);
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish();
    }, 3000);
    killTimer.unref?.();
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
    }
  });
}

export function reconcileGatewayProcess(state) {
  if (!state || state.shuttingDown) return;
  const rawConfig = readRemoteConfigSig(state.paths.configFile);
  let cfg = DEFAULT_REMOTE_CONFIG;
  if (rawConfig) {
    try {
      const parsed = JSON.parse(rawConfig);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;
    } catch {}
  }
  const enabled = Boolean(cfg && cfg.enabled === true);
  const gatewayScript = state.gatewayScript;

  if (!enabled || !fs.existsSync(gatewayScript)) {
    state.lastConfigRaw = rawConfig;
    if (state.gatewayChild) {
      stopGatewayChildGracefully(state).catch(() => {});
    }
    state.backoffIdx = 0;
    return;
  }

  if (state.gatewayChild && state.lastConfigRaw && rawConfig !== state.lastConfigRaw) {
    state.lastConfigRaw = rawConfig;
    state.backoffIdx = 0;
    stopGatewayChildGracefully(state)
      .then(() => reconcileGatewayProcess(state))
      .catch(() => {});
    return;
  }

  if (state.gatewayChild || state.restartTimer) return;
  state.lastConfigRaw = rawConfig;

  try {
    const child = fork(gatewayScript, [], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MAGA_REMOTE_STATE_DIR: state.paths.remoteDir,
        MAGA_REMOTE_SOCK_PATH: state.paths.sockPath
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    const startedAt = Date.now();
    state.gatewayChild = child;

    child.once('exit', () => {
      if (!state || state.gatewayChild !== child) return;
      state.gatewayChild = null;
      if (state.shuttingDown) return;
      const latest = readJsonOrFallback(state.paths.configFile, DEFAULT_REMOTE_CONFIG);
      if (!latest || latest.enabled !== true) {
        state.backoffIdx = 0;
        return;
      }
      if (Date.now() - startedAt > 10000) state.backoffIdx = 0;
      const delay = GATEWAY_RESTART_BACKOFF_MS[Math.min(state.backoffIdx, GATEWAY_RESTART_BACKOFF_MS.length - 1)];
      state.backoffIdx += 1;
      state.restartTimer = setTimeout(() => {
        if (!state || state.shuttingDown) return;
        state.restartTimer = 0;
        reconcileGatewayProcess(state);
      }, delay);
      state.restartTimer.unref?.();
    });
  } catch (err) {
    console.warn(`[Anti-Claude RemoteBridge] Failed to fork gateway: ${err?.message || err}`);
  }
}

export async function reclaimOrphanGateway(remoteDir) {
  const pidFile = path.join(remoteDir, 'gateway.pid');
  const pidObj = readJsonOrFallback(pidFile, null);
  const pid = Number(pidObj?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  const cmd = await readProcessCommandLineAsync(pid);
  if (!cmd || !/remote[\\/]+gateway[\\/]+server\.mjs/i.test(cmd)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 1800;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}
