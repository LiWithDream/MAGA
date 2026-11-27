/**
 * AGY Studio Remote Control — Shared Zero-Dependency Paths, Windows Named Pipes,
 * Atomic Writes (with Win32 retry), File Locks & Cross-Platform Process Inspection.
 * Node >= 22 built-ins only.
 */
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN_RETRY_SLEEP_BUF =
  typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

export function isPosixPermsEnforced(platform = process.platform) {
  return platform !== 'win32';
}

export function isWindowsNamedPipe(sockPath) {
  return typeof sockPath === 'string' && /^\\\\\.\\pipe\\/i.test(sockPath);
}

export function resolveRemoteDir(overrideDir = null, env = process.env) {
  if (overrideDir && typeof overrideDir === 'string') {
    return path.resolve(overrideDir);
  }
  if (typeof env?.MAGA_REMOTE_STATE_DIR === 'string' && env.MAGA_REMOTE_STATE_DIR.trim()) {
    return path.resolve(env.MAGA_REMOTE_STATE_DIR.trim());
  }
  const stateDir =
    typeof env?.ANTI_CLAUDE_STATE_DIR === 'string' && env.ANTI_CLAUDE_STATE_DIR.trim()
      ? path.resolve(env.ANTI_CLAUDE_STATE_DIR.trim())
      : path.join(os.homedir(), '.gemini', 'antigravity', 'anti-claude');
  return path.join(stateDir, 'remote');
}

function makeWinPipePath(seed) {
  const hash16 = crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\maga-rem-${hash16}`;
}

export function resolveSockPath(
  remoteDir = resolveRemoteDir(),
  overrideSockPath = null,
  { env = process.env, platform = process.platform } = {}
) {
  const rawOverride =
    typeof overrideSockPath === 'string' && overrideSockPath.trim()
      ? overrideSockPath.trim()
      : typeof env?.MAGA_REMOTE_SOCK_PATH === 'string' && env.MAGA_REMOTE_SOCK_PATH.trim()
        ? env.MAGA_REMOTE_SOCK_PATH.trim()
        : '';

  if (rawOverride) {
    if (isWindowsNamedPipe(rawOverride)) {
      return rawOverride;
    }
    const resolved = path.resolve(rawOverride);
    if (platform === 'win32') {
      return makeWinPipePath(resolved);
    }
    return resolved;
  }

  const resolvedDir = path.resolve(remoteDir);
  if (platform === 'win32') {
    return makeWinPipePath(resolvedDir);
  }
  const candidate = path.join(resolvedDir, 'bridge.sock');
  if (Buffer.byteLength(candidate, 'utf8') > 95) {
    const hash12 = crypto.createHash('sha256').update(resolvedDir).digest('hex').slice(0, 12);
    return path.join(os.tmpdir(), `maga-rem-${hash12}.sock`);
  }
  return candidate;
}

export function getRemotePaths(overrideDir = null, overrideSockPath = null, opts = {}) {
  const env = opts?.env || process.env;
  const remoteDir = resolveRemoteDir(overrideDir, env);
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
    sockPath: resolveSockPath(remoteDir, overrideSockPath, opts),
  };
}

export function renameWithWinRetry(
  src,
  dst,
  { platform = process.platform, maxAttempts = 6, backoffMs = 20, renameFn = fs.renameSync } = {}
) {
  if (platform !== 'win32') {
    renameFn(src, dst);
    return;
  }
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  for (let i = 0; i < attempts; i += 1) {
    try {
      renameFn(src, dst);
      return;
    } catch (err) {
      const code = err?.code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retryable || i === attempts - 1) throw err;
      if (WIN_RETRY_SLEEP_BUF) {
        try {
          const delayMs = Math.min(200, Math.round(backoffMs * Math.pow(1.6, i)));
          Atomics.wait(WIN_RETRY_SLEEP_BUF, 0, 0, delayMs);
        } catch {}
      }
    }
  }
}

export function ensureRemoteDir(dirPath, mode = 0o700, { platform = process.platform } = {}) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  if (isPosixPermsEnforced(platform)) {
    try {
      fs.chmodSync(dirPath, mode);
    } catch {}
  }
  return dirPath;
}

export function rejectIfSymlink(targetPath) {
  try {
    const lst = fs.lstatSync(targetPath);
    if (lst.isSymbolicLink()) {
      throw new Error(`refusing_symlink_target:${targetPath}`);
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

export function writeAtomicFile(
  filePath,
  content,
  { mode = 0o600, dirMode = 0o700, platform = process.platform } = {}
) {
  const resolved = path.resolve(filePath);
  ensureRemoteDir(path.dirname(resolved), dirMode, { platform });
  rejectIfSymlink(resolved);
  const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    if (isPosixPermsEnforced(platform)) {
      try {
        fs.chmodSync(tmp, mode);
      } catch {}
    }
    renameWithWinRetry(tmp, resolved, { platform });
    if (isPosixPermsEnforced(platform)) {
      try {
        fs.chmodSync(resolved, mode);
      } catch {}
    }
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

export async function withDevicesLock(
  fn,
  { remoteDir = null, lockFile = null, staleMs = 5000, timeoutMs = 3000 } = {}
) {
  const paths = getRemotePaths(remoteDir);
  const resolvedDir = lockFile ? path.dirname(path.resolve(lockFile)) : paths.remoteDir;
  const targetLockFile = lockFile ? path.resolve(lockFile) : paths.devicesLockFile;
  ensureRemoteDir(resolvedDir, 0o700);
  const deadline = Date.now() + timeoutMs;

  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(
        targetLockFile,
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
        const st = fs.lstatSync(targetLockFile);
        if (st.isSymbolicLink()) {
          fs.rmSync(targetLockFile, { force: true });
          healed = true;
        } else {
          let lockTs = Math.max(st.mtimeMs, st.ctimeMs);
          try {
            const parsed = JSON.parse(fs.readFileSync(targetLockFile, 'utf8'));
            if (typeof parsed?.ts === 'number' && Number.isFinite(parsed.ts)) {
              lockTs = parsed.ts;
            }
          } catch {}
          if (Date.now() - lockTs > staleMs) {
            fs.rmSync(targetLockFile, { force: true });
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
      fs.rmSync(targetLockFile, { force: true });
    } catch {}
  }
}

export function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 1) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch {
    return false;
  }
}

export function readProcessCommandLineAsync(pid, { platform = process.platform, timeoutMs } = {}) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return Promise.resolve('');
  return new Promise((resolve) => {
    if (platform === 'linux') {
      try {
        const raw = fs.readFileSync(`/proc/${num}/cmdline`, 'utf8');
        if (raw) return resolve(raw.replace(/\0+/g, ' ').trim());
      } catch {}
    }
    if (platform === 'win32') {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${num}").CommandLine`],
        { encoding: 'utf8', timeout: timeoutMs || 3000, windowsHide: true },
        (err, stdout) => resolve(err ? '' : String(stdout || '').trim())
      );
      return;
    }
    execFile(
      'ps',
      ['-ww', '-p', String(num), '-o', 'command='],
      { encoding: 'utf8', timeout: timeoutMs || 1500 },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim())
    );
  });
}

export function readProcessCommandLineSync(pid, { platform = process.platform, timeoutMs } = {}) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return '';
  try {
    if (platform === 'linux') {
      try {
        const raw = fs.readFileSync(`/proc/${num}/cmdline`, 'utf8');
        if (raw) return raw.replace(/\0+/g, ' ').trim();
      } catch {}
    }
    if (platform === 'win32') {
      return execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${num}").CommandLine`],
        {
          encoding: 'utf8',
          timeout: timeoutMs || 3000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim();
    }
    return execFileSync('ps', ['-ww', '-p', String(num), '-o', 'command='], {
      encoding: 'utf8',
      timeout: timeoutMs || 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}
