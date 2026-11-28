#!/usr/bin/env node
/**
 * Detached Self-Update Worker for AGY Studio (`agy-studio`).
 *
 * CRITICAL: Copied to `os.tmpdir()` and executed detached so it holds zero open
 * file locks inside `repoRoot` during directory swaps or daemon restarts.
 * Must use Node built-in modules ONLY (zero relative imports).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_SLUG = 'LiWithDream/agy-studio';
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const WIN_SLEEP_BUF =
  typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

function defaultSleepSync(ms) {
  const wait = Math.max(0, Math.min(2000, Math.round(Number(ms) || 0)));
  if (wait <= 0) return;
  if (WIN_SLEEP_BUF) {
    try {
      Atomics.wait(WIN_SLEEP_BUF, 0, 0, wait);
      return;
    } catch {}
  }
  const until = Date.now() + wait;
  while (Date.now() < until) {
    /* busy wait fallback */
  }
}

export function renameWithRetry(
  src,
  dst,
  { fsImpl = fs, platform = process.platform, maxAttempts = 12, backoffMs = 40, sleepFn = defaultSleepSync } = {}
) {
  if (platform !== 'win32') {
    fsImpl.renameSync(src, dst);
    return;
  }
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  for (let i = 0; i < attempts; i += 1) {
    try {
      fsImpl.renameSync(src, dst);
      return;
    } catch (err) {
      const code = err?.code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retryable || i === attempts - 1) throw err;
      sleepFn(Math.min(300, Math.round(backoffMs * Math.pow(1.5, i))));
    }
  }
}

export function writeStatusAtomic(
  statusFile,
  statusObj,
  { fsImpl = fs, platform = process.platform, sleepFn = defaultSleepSync } = {}
) {
  if (!statusFile) return;
  fsImpl.mkdirSync(path.dirname(statusFile), { recursive: true });
  const tmp = `${statusFile}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fsImpl.writeFileSync(tmp, `${JSON.stringify(statusObj, null, 2)}\n`, 'utf8');
    renameWithRetry(tmp, statusFile, { fsImpl, platform, sleepFn });
  } catch (err) {
    try {
      fsImpl.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

export function parseSha256File(text, expectedFilename = '') {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const targetBase = expectedFilename ? path.basename(String(expectedFilename)).toLowerCase() : '';
  const entries = [];
  for (const line of lines) {
    const withFile = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (withFile) {
      entries.push({
        hash: withFile[1].toLowerCase(),
        file: path.basename(withFile[2].trim()).toLowerCase(),
      });
      continue;
    }
    const bare = line.match(/^([a-fA-F0-9]{64})$/);
    if (bare) {
      entries.push({ hash: bare[1].toLowerCase(), file: '' });
    }
  }
  if (entries.length === 0) return null;
  if (targetBase) {
    const exact = entries.find((e) => e.file === targetBase);
    if (exact) return exact.hash;
    if (entries.length === 1 && !entries[0].file) return entries[0].hash;
    return null;
  }
  return entries[0].hash;
}

export function isAllowedDownloadUrl(rawUrl, { initial = false, repoSlug = DEFAULT_REPO_SLUG } = {}) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) return false;
    const cleanSlug = String(repoSlug || DEFAULT_REPO_SLUG).replace(/^\/+|\/+$/g, '');
    if (initial) {
      if (host !== 'github.com') return false;
      if (!u.pathname.startsWith(`/${cleanSlug}/releases/download/`)) return false;
    } else if (host === 'github.com') {
      if (!u.pathname.startsWith(`/${cleanSlug}/releases/`)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveNpmInvocation(nodeBin, platform = process.platform, fsImpl = fs) {
  const safeNode = String(nodeBin || process.execPath || 'node').trim();
  const nodeDir = platform === 'win32' ? path.win32.dirname(safeNode) : path.dirname(safeNode);

  if (platform === 'win32') {
    const winCli = path.win32.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fsImpl.existsSync(winCli)) {
      return { bin: safeNode, prefixArgs: [winCli], shell: false };
    }
    const npmCmd = path.win32.join(nodeDir, 'npm.cmd');
    return {
      bin: fsImpl.existsSync(npmCmd) ? npmCmd : 'npm.cmd',
      prefixArgs: [],
      shell: true,
    };
  }

  const posixCliCandidates = [
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const cand of posixCliCandidates) {
    if (fsImpl.existsSync(cand)) {
      return { bin: safeNode, prefixArgs: [cand], shell: false };
    }
  }
  const siblingNpm = path.join(nodeDir, 'npm');
  return {
    bin: fsImpl.existsSync(siblingNpm) ? siblingNpm : 'npm',
    prefixArgs: [],
    shell: false,
  };
}

export async function downloadAllowedFile(
  url,
  destPath,
  {
    fetchImpl = globalThis.fetch,
    fsImpl = fs,
    repoSlug = DEFAULT_REPO_SLUG,
    maxRedirects = 5,
    timeoutMs = 45000,
    initial = true,
  } = {}
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable');
  }
  let currentUrl = String(url || '').trim();
  if (!isAllowedDownloadUrl(currentUrl, { initial, repoSlug })) {
    throw new Error(`disallowed_download_url: ${currentUrl}`);
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await fetchImpl(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'agy-studio-updater' },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.get?.('location') || '';
      if (!loc) throw new Error(`redirect_missing_location (${res.status})`);
      const resolved = new URL(loc, currentUrl).toString();
      if (!isAllowedDownloadUrl(resolved, { initial: false, repoSlug })) {
        throw new Error(`disallowed_redirect_url: ${resolved}`);
      }
      currentUrl = resolved;
      continue;
    }
    if (!res.ok) {
      throw new Error(`download_http_${res.status}: ${currentUrl}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
    fsImpl.writeFileSync(destPath, buf);
    return { bytes: buf.length, finalUrl: currentUrl };
  }
  throw new Error('too_many_redirects');
}

function sha256File(filePath, fsImpl = fs) {
  const buf = fsImpl.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

function readPidAlive(pidFile, fsImpl, killProbe) {
  try {
    if (!pidFile || !fsImpl.existsSync(pidFile)) return { pid: 0, alive: false };
    const pid = parseInt(fsImpl.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return { pid: 0, alive: false };
    try {
      killProbe(pid, 0);
      return { pid, alive: true };
    } catch {
      return { pid, alive: false };
    }
  } catch {
    return { pid: 0, alive: false };
  }
}

function stopDaemonForUpdate(job, { fsImpl, execFileSyncFn, sleepFn, killProbe }) {
  const platform = job.platform || process.platform;
  if (platform === 'darwin') {
    if (job.plistPath && typeof process.getuid === 'function') {
      try {
        execFileSyncFn('launchctl', ['bootout', `gui/${process.getuid()}`, job.plistPath], {
          stdio: 'ignore',
          timeout: 4000,
        });
      } catch {}
    }
    const { pid, alive } = readPidAlive(job.pidFile, fsImpl, killProbe);
    if (alive && pid > 0) {
      try {
        killProbe(pid, 'SIGTERM');
      } catch {}
    }
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      if (!readPidAlive(job.pidFile, fsImpl, killProbe).alive) break;
      sleepFn(150);
    }
    return;
  }

  if (platform === 'win32') {
    if (job.stopSignalFile) {
      try {
        writeStatusAtomic(
          job.stopSignalFile,
          { targetPid: 0, requestedAt: Date.now(), reason: 'self_update' },
          { fsImpl, platform, sleepFn }
        );
      } catch {}
    }
    if (job.taskName) {
      try {
        execFileSyncFn('schtasks', ['/End', '/TN', job.taskName], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 4000,
        });
      } catch {}
    }
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      if (!readPidAlive(job.pidFile, fsImpl, killProbe).alive) break;
      sleepFn(150);
    }
  }
}

function isPrebuiltTreeValid(rootDir, fsImpl) {
  return (
    fsImpl.existsSync(path.join(rootDir, 'package.json')) &&
    fsImpl.existsSync(path.join(rootDir, 'studio', 'cli.mjs')) &&
    fsImpl.existsSync(path.join(rootDir, 'studio', 'prebuilt', 'studio-entry.js')) &&
    fsImpl.existsSync(path.join(rootDir, 'user', 'custom.js'))
  );
}

function findExtractedPrebuiltRoot(stageParent, fsImpl) {
  if (isPrebuiltTreeValid(stageParent, fsImpl)) return stageParent;
  const entries = fsImpl.readdirSync(stageParent, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory?.()) continue;
    const cand = path.join(stageParent, ent.name);
    if (isPrebuiltTreeValid(cand, fsImpl)) return cand;
  }
  return null;
}

function extractArchiveToStage(archivePath, stageParent, platform, { execFileSyncFn, fsImpl }) {
  fsImpl.rmSync(stageParent, { recursive: true, force: true });
  fsImpl.mkdirSync(stageParent, { recursive: true });
  if (platform === 'win32' || /\.zip$/i.test(archivePath)) {
    try {
      execFileSyncFn('tar.exe', ['-xf', archivePath, '-C', stageParent], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 45000,
      });
    } catch (tarErr) {
      if (platform !== 'win32') throw tarErr;
      const srcExpr = archivePath.replace(/'/g, "''");
      const dstExpr = stageParent.replace(/'/g, "''");
      execFileSyncFn(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${srcExpr}' -DestinationPath '${dstExpr}' -Force`],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60000,
        }
      );
    }
  } else {
    execFileSyncFn('tar', ['-xzf', archivePath, '-C', stageParent], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 45000,
    });
  }
  const root = findExtractedPrebuiltRoot(stageParent, fsImpl);
  if (!root) {
    throw new Error('invalid_prebuilt_archive_structure');
  }
  return root;
}

function runCliInstall(job, { execFileSyncFn, extraEnv = {} }) {
  const cliScript = path.join(job.repoRoot, 'studio', 'cli.mjs');
  const args = [cliScript, 'install'];
  if (job.preserveNoRules) args.push('--no-rules');
  const out = execFileSyncFn(job.nodeBin, args, {
    cwd: job.repoRoot,
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
  return String(out || '').trim();
}

function runGit(repoRoot, args, execFileSyncFn, timeout = 45000) {
  return String(
    execFileSyncFn('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    }) || ''
  ).trim();
}

function formatLogTail(text, maxChars = 600) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length > maxChars ? s.slice(-maxChars) : s;
}

export async function runUpdateJob(job, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const execFileSyncFn = deps.execFileSyncFn || execFileSync;
  const sleepFn = deps.sleepFn || defaultSleepSync;
  const killProbe = deps.killProbe || process.kill.bind(process);
  const tmpBaseDir = deps.tmpDir || os.tmpdir();
  const nowFn = deps.now || (() => Date.now());
  const platform = job.platform || process.platform;
  const repoSlug = job.repoSlug || DEFAULT_REPO_SLUG;

  const statusFile = job.statusFile || path.join(job.stateDir, 'update-status.json');
  const startedAt = Number(job.startedAt) || nowFn();
  const baseStatus = {
    schema: 1,
    jobId: job.jobId,
    inProgress: true,
    phase: 'downloading',
    installMode: job.installMode,
    fromVersion: job.fromVersion || '',
    toVersion: job.toVersion || '',
    targetTag: job.targetTag || '',
    targetSha: job.targetSha || '',
    startedAt,
    updatedAt: startedAt,
    workerPid: process.pid,
    error: null,
    rolledBack: false,
    logTail: '',
  };

  const setPhase = (phase, extra = {}) => {
    Object.assign(baseStatus, {
      phase,
      updatedAt: nowFn(),
      ...extra,
    });
    writeStatusAtomic(statusFile, baseStatus, { fsImpl, platform, sleepFn });
  };

  setPhase('downloading');

  if (job.installMode === 'prebuilt') {
    const dlDir = path.join(tmpBaseDir, `agy-studio-dl-${job.jobId}`);
    const repoParent = path.dirname(job.repoRoot);
    const stageParent = path.join(repoParent, `.agy-studio-stage-${job.jobId}`);
    const backupDir = path.join(repoParent, `.agy-studio-bak-${job.jobId}`);
    let swapped = false;

    try {
      const archiveName = job.archiveName || path.basename(new URL(job.archiveUrl).pathname);
      const archivePath = path.join(dlDir, archiveName);
      const shaPath = path.join(dlDir, `${archiveName}.sha256`);

      await downloadAllowedFile(job.archiveUrl, archivePath, { fetchImpl, fsImpl, repoSlug, initial: true });
      await downloadAllowedFile(job.sha256Url, shaPath, { fetchImpl, fsImpl, repoSlug, initial: true });

      setPhase('verifying');
      const expectedSha = parseSha256File(fsImpl.readFileSync(shaPath, 'utf8'), archiveName);
      if (!expectedSha) {
        throw new Error('invalid_sha256_manifest');
      }
      const actualSha = sha256File(archivePath, fsImpl);
      if (actualSha !== expectedSha) {
        throw new Error(`sha256_mismatch: expected ${expectedSha}, got ${actualSha}`);
      }

      setPhase('staging');
      const extractedRoot = extractArchiveToStage(archivePath, stageParent, platform, {
        execFileSyncFn,
        fsImpl,
      });

      setPhase('applying');
      stopDaemonForUpdate(job, { fsImpl, execFileSyncFn, sleepFn, killProbe });
      fsImpl.rmSync(backupDir, { recursive: true, force: true });
      if (fsImpl.existsSync(job.repoRoot)) {
        renameWithRetry(job.repoRoot, backupDir, { fsImpl, platform, sleepFn });
      }
      renameWithRetry(extractedRoot, job.repoRoot, { fsImpl, platform, sleepFn });
      swapped = true;

      setPhase('installing');
      setPhase('restarting');
      const installOut = runCliInstall(job, {
        execFileSyncFn,
        extraEnv: { MAGA_USE_PREBUILT: '1' },
      });

      try {
        fsImpl.rmSync(backupDir, { recursive: true, force: true });
        fsImpl.rmSync(stageParent, { recursive: true, force: true });
        fsImpl.rmSync(dlDir, { recursive: true, force: true });
      } catch {}

      setPhase('succeeded', {
        inProgress: false,
        logTail: formatLogTail(installOut),
      });
      return baseStatus;
    } catch (err) {
      let rolledBack = false;
      if (swapped && fsImpl.existsSync(backupDir)) {
        try {
          if (fsImpl.existsSync(job.repoRoot)) {
            fsImpl.rmSync(job.repoRoot, { recursive: true, force: true });
          }
          renameWithRetry(backupDir, job.repoRoot, { fsImpl, platform, sleepFn });
          try {
            runCliInstall(job, { execFileSyncFn, extraEnv: { MAGA_USE_PREBUILT: '1' } });
          } catch {}
          rolledBack = true;
        } catch {}
      }
      try {
        fsImpl.rmSync(stageParent, { recursive: true, force: true });
        fsImpl.rmSync(dlDir, { recursive: true, force: true });
      } catch {}
      setPhase('failed', {
        inProgress: false,
        rolledBack,
        error: String(err?.stderr || err?.message || err).trim(),
      });
      return baseStatus;
    }
  }

  if (job.installMode === 'git-stable' || job.installMode === 'git-edge') {
    let prevSha = '';
    let prevBranch = '';
    let prevLockHash = '';
    let checkedOut = false;
    let installStarted = false;

    try {
      prevSha = runGit(job.repoRoot, ['rev-parse', 'HEAD'], execFileSyncFn);
      try {
        prevBranch = runGit(job.repoRoot, ['symbolic-ref', '--short', 'HEAD'], execFileSyncFn);
      } catch {
        prevBranch = '';
      }
      const lockPath = path.join(job.repoRoot, 'package-lock.json');
      if (fsImpl.existsSync(lockPath)) {
        prevLockHash = sha256File(lockPath, fsImpl);
      }

      if (job.installMode === 'git-stable') {
        if (!RELEASE_TAG_RE.test(String(job.targetTag || ''))) {
          throw new Error(`invalid_release_tag: ${job.targetTag}`);
        }
        runGit(
          job.repoRoot,
          ['fetch', '--prune', 'origin', `refs/tags/${job.targetTag}:refs/tags/${job.targetTag}`],
          execFileSyncFn
        );
        setPhase('applying');
        runGit(job.repoRoot, ['checkout', '--detach', `refs/tags/${job.targetTag}`], execFileSyncFn);
        checkedOut = true;
      } else {
        runGit(job.repoRoot, ['fetch', '--prune', 'origin', 'main'], execFileSyncFn);
        setPhase('applying');
        runGit(job.repoRoot, ['merge', '--ff-only', 'origin/main'], execFileSyncFn);
        checkedOut = true;
      }

      const nextLockHash = fsImpl.existsSync(lockPath) ? sha256File(lockPath, fsImpl) : '';
      const hasEsbuild = fsImpl.existsSync(path.join(job.repoRoot, 'node_modules', 'esbuild'));
      if (!hasEsbuild || (nextLockHash && nextLockHash !== prevLockHash)) {
        setPhase('installing');
        const npmCmd = resolveNpmInvocation(job.nodeBin, platform, fsImpl);
        const npmSub = fsImpl.existsSync(lockPath) ? 'ci' : 'install';
        execFileSyncFn(
          npmCmd.bin,
          [...npmCmd.prefixArgs, npmSub, '--no-audit', '--no-fund'],
          {
            cwd: job.repoRoot,
            windowsHide: true,
            shell: Boolean(npmCmd.shell),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 180000,
          }
        );
      }

      setPhase('restarting');
      installStarted = true;
      const installOut = runCliInstall(job, { execFileSyncFn });
      const finalSha = runGit(job.repoRoot, ['rev-parse', 'HEAD'], execFileSyncFn);
      setPhase('succeeded', {
        inProgress: false,
        targetSha: finalSha || baseStatus.targetSha,
        logTail: formatLogTail(installOut),
      });
      return baseStatus;
    } catch (err) {
      let rolledBack = false;
      if (checkedOut && prevSha) {
        try {
          if (prevBranch) {
            runGit(job.repoRoot, ['checkout', prevBranch], execFileSyncFn);
            runGit(job.repoRoot, ['reset', '--hard', prevSha], execFileSyncFn);
          } else {
            runGit(job.repoRoot, ['checkout', '--detach', prevSha], execFileSyncFn);
          }
          if (installStarted) {
            try {
              runCliInstall(job, { execFileSyncFn });
            } catch {}
          }
          rolledBack = true;
        } catch {}
      }
      setPhase('failed', {
        inProgress: false,
        rolledBack,
        error: String(err?.stderr || err?.message || err).trim(),
      });
      return baseStatus;
    }
  }

  setPhase('failed', {
    inProgress: false,
    rolledBack: false,
    error: `unsupported_install_mode: ${job.installMode}`,
  });
  return baseStatus;
}

const isMainModule = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const jobPath = process.argv[2];
  if (!jobPath || !fs.existsSync(jobPath)) {
    process.exit(1);
  }
  try {
    const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
    const result = await runUpdateJob(job);
    if (result?.phase === 'failed') {
      process.exitCode = 1;
    }
  } catch {
    process.exitCode = 1;
  } finally {
    try {
      fs.rmSync(jobPath, { force: true });
    } catch {}
    try {
      fs.rmSync(fileURLToPath(import.meta.url), { force: true });
    } catch {}
  }
}
