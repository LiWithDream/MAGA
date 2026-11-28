/**
 * AGY Studio Self-Update Service (`studio/daemon/update-service.mjs`):
 * - Purely local install mode / channel / worktree / split-brain detection
 * - Manual-only GitHub Release + `git ls-remote` update checking with short TTL cache
 * - Strict eligibility guardrails (dirty/worktree/ahead/split-brain -> read-only fallback)
 * - Single-flight detached `update-worker.mjs` launcher & cross-restart status reader
 *
 * Security: Desktop-only RPC (`__agProjectCall`). Never expose to Remote Gateway.
 */
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, PID_FILE, REPO_ROOT, STATE_DIR, STOP_SIGNAL_FILE } from '../../core/daemon/env.mjs';
import { WIN_TASK_NAME } from '../../core/daemon/win-service.mjs';
import { readDeployMeta } from '../deploy-meta.mjs';
import { isAllowedDownloadUrl, writeStatusAtomic } from './update-worker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER_SOURCE = path.join(__dirname, 'update-worker.mjs');
const DEFAULT_REPO_SLUG = 'LiWithDream/agy-studio';
const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const CHECK_CACHE_TTL_MS = 120 * 1000;
const STALE_WORKER_MAX_AGE_MS = 10 * 60 * 1000;
const WORKER_START_GRACE_MS = 3000;
const FAST_IO_BEGIN = '<!-- BEGIN agy-fast-io-pruned -->';

export const STUDIO_UPDATE_RPC_ACTIONS = new Set([
  'getStudioVersionInfo',
  'checkStudioUpdate',
  'startStudioUpdate',
  'getStudioUpdateStatus',
]);

const checkCache = new Map();

export function clearUpdateCheckCache() {
  checkCache.clear();
}

function defaultExecFileAsync(bin, args, { cwd, timeout = 5000, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout,
        encoding: 'utf8',
        windowsHide: true,
        env: env || { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
        });
      }
    );
  });
}

function defaultIsPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizePathForCompare(p, platform = process.platform, fsImpl = fs) {
  if (!p) return '';
  let resolved = path.resolve(String(p));
  try {
    if (typeof fsImpl.realpathSync === 'function') {
      resolved = fsImpl.realpathSync(resolved);
    }
  } catch {}
  return platform === 'darwin' || platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function parseSemverParts(raw) {
  const clean = String(raw || '').trim().replace(/^v/i, '');
  const m = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

export function compareSemver(a, b) {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const maxLen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < maxLen; i += 1) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (ai !== bi) {
      return ai > bi ? 1 : -1;
    }
  }
  return 0;
}

export function parseReleaseNotesSummary(body, maxLines = 5) {
  const rawLines = String(body || '').split(/\r?\n/);
  const out = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed) || /^[-*_]{3,}$/.test(trimmed)) continue;
    let clean = trimmed
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) continue;
    if (clean.length > 160) clean = `${clean.slice(0, 157)}...`;
    out.push(clean);
    if (out.length >= maxLines) break;
  }
  return out;
}

function pickExactReleaseTag(rawTags) {
  const tags = String(rawTags || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((t) => RELEASE_TAG_RE.test(t));
  if (tags.length === 0) return '';
  tags.sort((a, b) => compareSemver(b, a));
  return tags[0];
}

function resolveCtx(opts = {}) {
  const repoRoot = path.resolve(opts.repoRoot || REPO_ROOT);
  const stateDir = path.resolve(opts.stateDir || STATE_DIR);
  const home = path.resolve(opts.home || HOME);
  const platform = opts.platform || process.platform;
  const nodeBin = opts.nodeBin || process.execPath;
  const fsImpl = opts.fsImpl || fs;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const execFileAsyncImpl = opts.execFileAsyncImpl || defaultExecFileAsync;
  const spawnImpl = opts.spawnImpl || spawn;
  const now = opts.now || (() => Date.now());
  const isPidAliveFn = opts.isPidAliveFn || defaultIsPidAlive;
  const readDeployMetaFn = opts.readDeployMetaFn || readDeployMeta;
  const repoSlug = String(opts.repoSlug || DEFAULT_REPO_SLUG).replace(/^\/+|\/+$/g, '');
  const tmpDir = path.resolve(opts.tmpDir || os.tmpdir());
  const workerSourcePath = opts.workerSourcePath || DEFAULT_WORKER_SOURCE;
  const plistPath =
    opts.plistPath || path.join(home, 'Library', 'LaunchAgents', 'com.antigravity.anti-claude.daemon.plist');
  const taskName = opts.taskName || WIN_TASK_NAME;
  const pidFile = opts.pidFile || (opts.stateDir ? path.join(stateDir, 'daemon.pid') : PID_FILE);
  const stopSignalFile =
    opts.stopSignalFile || (opts.stateDir ? path.join(stateDir, 'daemon-stop.signal') : STOP_SIGNAL_FILE);
  const statusFile = opts.statusFile || path.join(stateDir, 'update-status.json');
  return {
    repoRoot,
    stateDir,
    home,
    platform,
    nodeBin,
    fsImpl,
    fetchImpl,
    execFileAsyncImpl,
    spawnImpl,
    now,
    isPidAliveFn,
    readDeployMetaFn,
    repoSlug,
    tmpDir,
    workerSourcePath,
    plistPath,
    taskName,
    pidFile,
    stopSignalFile,
    statusFile,
  };
}

async function execGit(repoRoot, args, ctx, timeout = 3000) {
  return ctx.execFileAsyncImpl('git', ['-C', repoRoot, ...args], {
    cwd: repoRoot,
    timeout,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

export async function detectInstallState(opts = {}) {
  const ctx = resolveCtx(opts);
  const { repoRoot, stateDir, platform, fsImpl, readDeployMetaFn } = ctx;

  let version = '0.0.0';
  try {
    const pkg = JSON.parse(fsImpl.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    if (pkg?.version) version = String(pkg.version).trim().replace(/^v/i, '');
  } catch {}

  const gitEntryPath = path.join(repoRoot, '.git');
  const hasGit = fsImpl.existsSync(gitEntryPath);
  const hasPrebuiltFiles =
    fsImpl.existsSync(path.join(repoRoot, 'studio', 'prebuilt', 'studio-entry.js')) &&
    fsImpl.existsSync(path.join(repoRoot, 'user', 'custom.js'));
  const isPrebuilt = !hasGit && hasPrebuiltFiles;

  let branch = '';
  let sha = '';
  let shortSha = '';
  let releaseTag = '';
  let dirty = false;
  let isLinkedWorktree = false;
  let aheadCount = 0;

  if (hasGit) {
    try {
      isLinkedWorktree = Boolean(fsImpl.lstatSync(gitEntryPath).isFile());
    } catch {}
    const [brRes, shaRes, tagRes, stRes] = await Promise.all([
      execGit(repoRoot, ['symbolic-ref', '--short', 'HEAD'], ctx),
      execGit(repoRoot, ['rev-parse', 'HEAD'], ctx),
      execGit(repoRoot, ['tag', '--points-at', 'HEAD'], ctx),
      execGit(repoRoot, ['status', '--porcelain'], ctx),
    ]);
    branch = brRes.ok ? brRes.stdout : '';
    sha = shaRes.ok ? shaRes.stdout : '';
    shortSha = sha ? sha.slice(0, 7) : '';
    releaseTag = tagRes.ok ? pickExactReleaseTag(tagRes.stdout) : '';
    dirty = stRes.ok ? Boolean(stRes.stdout) : false;

    if (branch === 'main') {
      const aheadRes = await execGit(repoRoot, ['rev-list', '--count', 'origin/main..HEAD'], ctx);
      if (aheadRes.ok && /^\d+$/.test(aheadRes.stdout)) {
        aheadCount = Number(aheadRes.stdout);
      }
    }
  }

  let channel = 'unknown';
  if (isPrebuilt) {
    channel = 'prebuilt';
  } else if (hasGit) {
    if (branch === 'main') {
      channel = 'edge';
    } else if (!branch && RELEASE_TAG_RE.test(releaseTag)) {
      channel = 'stable';
    } else {
      channel = 'custom';
    }
  }

  let installMode = 'unsupported';
  if (channel === 'prebuilt') installMode = 'prebuilt';
  else if (channel === 'stable') installMode = 'git-stable';
  else if (channel === 'edge') installMode = 'git-edge';

  let splitBrain = false;
  let deployMeta = null;
  try {
    const dm = readDeployMetaFn(path.join(stateDir, 'deploy-meta.json'));
    deployMeta = dm?.meta || null;
    if (dm?.present && deployMeta) {
      if (deployMeta.preview === true) {
        splitBrain = true;
      } else if (deployMeta.worktreePath) {
        const normDeployed = normalizePathForCompare(deployMeta.worktreePath, platform, fsImpl);
        const normRepo = normalizePathForCompare(repoRoot, platform, fsImpl);
        if (normDeployed && normRepo && normDeployed !== normRepo) {
          splitBrain = true;
        }
      }
    }
  } catch {}

  let parentDirWritable = true;
  if (installMode === 'prebuilt') {
    if (typeof fsImpl.accessSync === 'function') {
      try {
        fsImpl.accessSync(path.dirname(repoRoot), fs.constants.W_OK);
      } catch {
        parentDirWritable = false;
      }
    }
  }

  return {
    version,
    platform,
    repoRoot,
    hasGit,
    isPrebuilt,
    channel,
    installMode,
    branch,
    sha,
    shortSha,
    releaseTag,
    dirty,
    isLinkedWorktree,
    aheadCount,
    splitBrain,
    parentDirWritable,
  };
}

export function evaluateSelfUpdateEligibility(local, { assetMissing = false } = {}) {
  if (!local || typeof local !== 'object') {
    return { canSelfUpdate: false, blockReason: 'unsupported_install_mode' };
  }
  if (local.dirty) {
    return { canSelfUpdate: false, blockReason: 'dirty_worktree' };
  }
  if (local.isLinkedWorktree) {
    return { canSelfUpdate: false, blockReason: 'linked_worktree' };
  }
  if (local.channel === 'custom') {
    return { canSelfUpdate: false, blockReason: 'non_release_branch' };
  }
  if (local.installMode === 'unsupported') {
    return { canSelfUpdate: false, blockReason: 'unsupported_install_mode' };
  }
  if (local.channel === 'edge' && Number(local.aheadCount || 0) > 0) {
    return { canSelfUpdate: false, blockReason: 'local_ahead_commits' };
  }
  if (local.splitBrain) {
    return { canSelfUpdate: false, blockReason: 'deploy_mismatch' };
  }
  if (local.installMode === 'prebuilt' && local.parentDirWritable === false) {
    return { canSelfUpdate: false, blockReason: 'parent_dir_not_writable' };
  }
  if (local.installMode === 'prebuilt' && assetMissing) {
    return { canSelfUpdate: false, blockReason: 'missing_release_asset' };
  }
  return { canSelfUpdate: true, blockReason: null };
}

export function buildManualUpdateCommand(local, { repoSlug = DEFAULT_REPO_SLUG } = {}) {
  const platform = local?.platform || process.platform;
  const channel = local?.channel === 'edge' ? 'edge' : 'stable';
  const repoRoot = local?.repoRoot || '';
  const hasGit = Boolean(local?.hasGit);

  if (platform === 'win32') {
    if (hasGit && repoRoot) {
      return `Set-Location "${repoRoot}"; powershell -ExecutionPolicy Bypass -File .\\install.ps1 -Channel ${channel}`;
    }
    return `irm https://raw.githubusercontent.com/${repoSlug}/main/install.ps1 | iex`;
  }

  if (hasGit && repoRoot) {
    return `cd "${repoRoot}" && bash ./install.sh --channel ${channel}`;
  }
  return `curl -fsSL https://raw.githubusercontent.com/${repoSlug}/main/install.sh | bash`;
}

function readUpdateStatusFile(statusFile, fsImpl) {
  try {
    if (!statusFile || !fsImpl.existsSync(statusFile)) return null;
    const raw = JSON.parse(fsImpl.readFileSync(statusFile, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function reconcileStatusWithLocal(status, local, ctx) {
  if (!status || !status.inProgress) return status;
  const nowMs = ctx.now();
  const age = nowMs - Number(status.updatedAt || status.startedAt || 0);
  const startAge = nowMs - Number(status.startedAt || 0);
  const workerAlive = status.workerPid > 0 ? ctx.isPidAliveFn(status.workerPid) : true;
  const workerExited = status.workerPid > 0 && startAge > WORKER_START_GRACE_MS && !workerAlive;
  const expired = age > STALE_WORKER_MAX_AGE_MS;

  if (!workerExited && !expired) return status;

  const reachedTarget =
    (status.installMode === 'git-edge' && status.targetSha && local?.sha === status.targetSha) ||
    (status.installMode !== 'git-edge' && status.toVersion && local?.version === status.toVersion);

  const reconciled = {
    ...status,
    inProgress: false,
    phase: reachedTarget ? 'succeeded' : 'failed',
    updatedAt: nowMs,
    error: reachedTarget ? null : expired ? 'update_timed_out' : 'worker_exited_unexpectedly',
  };
  try {
    writeStatusAtomic(ctx.statusFile, reconciled, { fsImpl: ctx.fsImpl, platform: ctx.platform });
  } catch {}
  return reconciled;
}

export function pickLatestStableTagFromLsRemote(stdout) {
  const parsed = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.trim().match(/\trefs\/tags\/(v\d+\.\d+\.\d+)$/);
    if (!m) continue;
    const tag = m[1];
    parsed.push({ tag, version: tag.slice(1) });
  }
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => compareSemver(b.version, a.version));
  return parsed[0];
}

async function resolveLatestTagViaGitLsRemote(local, ctx) {
  const lsRes = await execGit(local.repoRoot, ['ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v*'], ctx, 6000);
  if (!lsRes.ok || !lsRes.stdout) return null;
  return pickLatestStableTagFromLsRemote(lsRes.stdout);
}

async function fetchLatestGithubRelease(ctx, local) {
  const apiUrl = `https://api.github.com/repos/${ctx.repoSlug}/releases/latest`;
  let rateLimited = false;
  let rateLimitResetAt = null;
  let errorCode = 'network_error';
  let errorMessage = '';

  if (typeof ctx.fetchImpl === 'function') {
    try {
      const res = await ctx.fetchImpl(apiUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'agy-studio-updater',
        },
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(5000) : undefined,
      });
      if (res.ok) {
        const data = await res.json();
        const tag = String(data?.tag_name || '').trim();
        if (data && !data.draft && !data.prerelease && RELEASE_TAG_RE.test(tag)) {
          const latestVersion = tag.replace(/^v/i, '');
          const platformSuffix = ctx.platform === 'win32' ? 'windows.zip' : 'macos.tar.gz';
          const expectedArchiveName = `agy-studio-v${latestVersion}-${platformSuffix}`;
          const expectedShaName = `${expectedArchiveName}.sha256`;
          const assets = Array.isArray(data.assets) ? data.assets : [];
          const archiveAsset = assets.find((a) => a?.name === expectedArchiveName);
          const shaAsset = assets.find((a) => a?.name === expectedShaName);
          const rawArchiveUrl = archiveAsset?.browser_download_url || '';
          const rawShaUrl = shaAsset?.browser_download_url || '';
          const archiveUrl = isAllowedDownloadUrl(rawArchiveUrl, { initial: true, repoSlug: ctx.repoSlug })
            ? rawArchiveUrl
            : '';
          const sha256Url = isAllowedDownloadUrl(rawShaUrl, { initial: true, repoSlug: ctx.repoSlug })
            ? rawShaUrl
            : '';
          return {
            ok: true,
            source: 'github-api',
            latestTag: tag,
            latestVersion,
            publishedAt: data.published_at || '',
            releasePageUrl:
              typeof data.html_url === 'string' && data.html_url.startsWith('https://github.com/')
                ? data.html_url
                : `https://github.com/${ctx.repoSlug}/releases/tag/${tag}`,
            notes: parseReleaseNotesSummary(data.body, 5),
            archiveName: expectedArchiveName,
            archiveUrl,
            sha256Url,
          };
        }
        errorCode = 'invalid_release_payload';
      } else {
        if (res.status === 403 || res.status === 429) {
          rateLimited = true;
          errorCode = 'rate_limited';
          const resetHdr = res.headers?.get?.('x-ratelimit-reset');
          if (resetHdr && /^\d+$/.test(resetHdr)) {
            rateLimitResetAt = Number(resetHdr) * 1000;
          }
        } else {
          errorCode = `http_${res.status}`;
        }
        errorMessage = `GitHub API returned HTTP ${res.status}`;
      }
    } catch (err) {
      errorCode = err?.name === 'TimeoutError' ? 'network_timeout' : 'network_error';
      errorMessage = String(err?.message || err);
    }
  }

  if (local.hasGit) {
    const tagHit = await resolveLatestTagViaGitLsRemote(local, ctx);
    if (tagHit) {
      return {
        ok: true,
        source: 'git-ls-remote',
        latestTag: tagHit.tag,
        latestVersion: tagHit.version,
        publishedAt: '',
        releasePageUrl: `https://github.com/${ctx.repoSlug}/releases/tag/${tagHit.tag}`,
        notes: [],
        archiveName: '',
        archiveUrl: '',
        sha256Url: '',
      };
    }
  }

  return {
    ok: false,
    error: rateLimited ? 'rate_limited' : errorCode,
    rateLimitResetAt,
    message: errorMessage || errorCode,
    releasePageUrl: `https://github.com/${ctx.repoSlug}/releases/latest`,
  };
}

export async function getStudioVersionInfo(opts = {}) {
  const ctx = resolveCtx(opts);
  const local = await detectInstallState(opts);
  const eligibility = evaluateSelfUpdateEligibility(local);
  const manualCommand = buildManualUpdateCommand(local, { repoSlug: ctx.repoSlug });
  const rawStatus = readUpdateStatusFile(ctx.statusFile, ctx.fsImpl);
  const status = reconcileStatusWithLocal(rawStatus, local, ctx);
  const cacheKey = `${ctx.repoRoot}|${ctx.platform}|${local.channel}|${local.version}|${local.sha}`;
  const cached = checkCache.get(cacheKey);
  const lastCheck = cached && ctx.now() - cached.checkedAt < CHECK_CACHE_TTL_MS ? cached.result : null;

  return {
    ok: true,
    local,
    eligibility,
    manualCommand,
    releasePageUrl: `https://github.com/${ctx.repoSlug}/releases/latest`,
    status,
    lastCheck,
  };
}

export async function checkStudioUpdate(payload = {}, opts = {}) {
  const ctx = resolveCtx(opts);
  const local = await detectInstallState(opts);
  const manualCommand = buildManualUpdateCommand(local, { repoSlug: ctx.repoSlug });
  const force = Boolean(payload?.force);
  const cacheKey = `${ctx.repoRoot}|${ctx.platform}|${local.channel}|${local.version}|${local.sha}`;

  if (!force && !opts.disableCache) {
    const hit = checkCache.get(cacheKey);
    if (hit && ctx.now() - hit.checkedAt < CHECK_CACHE_TTL_MS) {
      return { ...hit.result, cached: true };
    }
  }

  const release = await fetchLatestGithubRelease(ctx, local);

  if (local.channel === 'edge') {
    const mainLs = await execGit(local.repoRoot, ['ls-remote', 'origin', 'refs/heads/main'], ctx, 6000);
    if (!mainLs.ok || !mainLs.stdout) {
      return {
        ok: false,
        error: release.ok ? 'git_remote_unreachable' : release.error,
        message: mainLs.stderr || release.message || 'Unable to reach origin/main',
        local,
        eligibility: evaluateSelfUpdateEligibility(local),
        manualCommand,
        releasePageUrl: release.releasePageUrl || `https://github.com/${ctx.repoSlug}/releases/latest`,
      };
    }
    const remoteSha = (mainLs.stdout.split(/\s+/)[0] || '').trim();
    const updateAvailable = Boolean(remoteSha && local.sha && remoteSha !== local.sha);
    let behindCount = null;
    if (updateAvailable) {
      const cntRes = await execGit(local.repoRoot, ['rev-list', '--count', `HEAD..${remoteSha}`], ctx, 1500);
      if (cntRes.ok && /^\d+$/.test(cntRes.stdout)) {
        behindCount = Number(cntRes.stdout);
      }
    }
    const eligibility = evaluateSelfUpdateEligibility(local);
    const result = {
      ok: true,
      checkedAt: ctx.now(),
      cached: false,
      local,
      eligibility,
      manualCommand,
      check: {
        channel: 'edge',
        updateAvailable,
        source: release.ok ? release.source : 'git-ls-remote',
        targetSha: remoteSha,
        targetShortSha: remoteSha.slice(0, 7),
        behindCount,
        latestTag: release.ok ? release.latestTag : '',
        latestVersion: release.ok ? release.latestVersion : '',
        notes: release.ok ? release.notes : [],
        releasePageUrl: release.ok
          ? release.releasePageUrl
          : `https://github.com/${ctx.repoSlug}/releases/latest`,
      },
    };
    if (!opts.disableCache) checkCache.set(cacheKey, { checkedAt: ctx.now(), result });
    return result;
  }

  if (!release.ok) {
    return {
      ok: false,
      error: release.error,
      rateLimitResetAt: release.rateLimitResetAt || null,
      message: release.message,
      local,
      eligibility: evaluateSelfUpdateEligibility(local),
      manualCommand,
      releasePageUrl: release.releasePageUrl,
    };
  }

  const updateAvailable = compareSemver(release.latestVersion, local.version) > 0;
  const assetMissing =
    local.installMode === 'prebuilt' && updateAvailable && (!release.archiveUrl || !release.sha256Url);
  const eligibility = evaluateSelfUpdateEligibility(local, { assetMissing });

  const result = {
    ok: true,
    checkedAt: ctx.now(),
    cached: false,
    local,
    eligibility,
    manualCommand,
    check: {
      channel: local.channel,
      updateAvailable,
      source: release.source,
      latestTag: release.latestTag,
      latestVersion: release.latestVersion,
      publishedAt: release.publishedAt,
      notes: release.notes,
      releasePageUrl: release.releasePageUrl,
      archiveName: release.archiveName,
      archiveUrl: release.archiveUrl,
      sha256Url: release.sha256Url,
    },
  };
  if (!opts.disableCache) checkCache.set(cacheKey, { checkedAt: ctx.now(), result });
  return result;
}

export async function startStudioUpdate(payload = {}, opts = {}) {
  const ctx = resolveCtx(opts);
  const local = await detectInstallState(opts);

  const existingRaw = readUpdateStatusFile(ctx.statusFile, ctx.fsImpl);
  const existing = reconcileStatusWithLocal(existingRaw, local, ctx);
  if (existing?.inProgress) {
    return { ok: false, error: 'update_in_progress', status: existing };
  }

  const checkRes = await checkStudioUpdate({ force: Boolean(payload?.forceCheck) }, opts);
  if (!checkRes.ok) {
    return checkRes;
  }
  if (!checkRes.check?.updateAvailable) {
    return { ok: false, error: 'already_up_to_date', local: checkRes.local, check: checkRes.check };
  }
  if (!checkRes.eligibility?.canSelfUpdate) {
    return {
      ok: false,
      error: checkRes.eligibility?.blockReason || 'self_update_blocked',
      local: checkRes.local,
      eligibility: checkRes.eligibility,
      manualCommand: checkRes.manualCommand,
      releasePageUrl: checkRes.check?.releasePageUrl,
    };
  }

  const agentsMdPath = path.join(ctx.home, '.gemini', 'AGENTS.md');
  let preserveNoRules = false;
  try {
    if (!ctx.fsImpl.existsSync(agentsMdPath)) {
      preserveNoRules = true;
    } else {
      const agentsText = ctx.fsImpl.readFileSync(agentsMdPath, 'utf8');
      preserveNoRules = !agentsText.includes(FAST_IO_BEGIN);
    }
  } catch {
    preserveNoRules = false;
  }

  const nowMs = ctx.now();
  const jobId = `${nowMs}-${crypto.randomBytes(3).toString('hex')}`;
  const workerCopyPath = path.join(ctx.tmpDir, `agy-studio-updater-${jobId}.mjs`);
  const jobFilePath = path.join(ctx.tmpDir, `agy-studio-update-job-${jobId}.json`);

  ctx.fsImpl.mkdirSync(ctx.tmpDir, { recursive: true });
  ctx.fsImpl.copyFileSync(ctx.workerSourcePath, workerCopyPath);

  const job = {
    jobId,
    repoSlug: ctx.repoSlug,
    repoRoot: ctx.repoRoot,
    stateDir: ctx.stateDir,
    platform: ctx.platform,
    nodeBin: ctx.nodeBin,
    installMode: checkRes.local.installMode,
    fromVersion: checkRes.local.version,
    toVersion: checkRes.check.latestVersion || checkRes.local.version,
    targetTag: checkRes.check.latestTag || '',
    targetSha: checkRes.check.targetSha || '',
    archiveUrl: checkRes.check.archiveUrl || '',
    sha256Url: checkRes.check.sha256Url || '',
    archiveName: checkRes.check.archiveName || '',
    preserveNoRules,
    plistPath: ctx.plistPath,
    taskName: ctx.taskName,
    pidFile: ctx.pidFile,
    stopSignalFile: ctx.stopSignalFile,
    statusFile: ctx.statusFile,
    startedAt: nowMs,
  };

  ctx.fsImpl.writeFileSync(jobFilePath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');

  const initialStatus = {
    schema: 1,
    jobId,
    inProgress: true,
    phase: 'downloading',
    installMode: job.installMode,
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
    targetTag: job.targetTag,
    targetSha: job.targetSha,
    startedAt: nowMs,
    updatedAt: nowMs,
    workerPid: 0,
    error: null,
    rolledBack: false,
    logTail: '',
  };
  writeStatusAtomic(ctx.statusFile, initialStatus, { fsImpl: ctx.fsImpl, platform: ctx.platform });

  const child = ctx.spawnImpl(ctx.nodeBin, [workerCopyPath, jobFilePath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: ctx.tmpDir,
  });
  child?.unref?.();

  if (child && Number(child.pid) > 0) {
    initialStatus.workerPid = Number(child.pid);
    try {
      writeStatusAtomic(ctx.statusFile, initialStatus, { fsImpl: ctx.fsImpl, platform: ctx.platform });
    } catch {}
  }

  return {
    ok: true,
    started: true,
    jobId,
    status: initialStatus,
  };
}

export async function getStudioUpdateStatus(opts = {}) {
  const ctx = resolveCtx(opts);
  const local = await detectInstallState(opts);
  const eligibility = evaluateSelfUpdateEligibility(local);
  const manualCommand = buildManualUpdateCommand(local, { repoSlug: ctx.repoSlug });
  const rawStatus = readUpdateStatusFile(ctx.statusFile, ctx.fsImpl);
  const status = reconcileStatusWithLocal(rawStatus, local, ctx);
  const cacheKey = `${ctx.repoRoot}|${ctx.platform}|${local.channel}|${local.version}|${local.sha}`;
  const cached = checkCache.get(cacheKey);
  const lastCheck = cached && ctx.now() - cached.checkedAt < CHECK_CACHE_TTL_MS ? cached.result : null;

  return {
    ok: true,
    local,
    eligibility,
    manualCommand,
    status,
    lastCheck,
  };
}

export async function handleStudioUpdateRpc(action, payload = {}, opts = {}) {
  switch (action) {
    case 'getStudioVersionInfo':
      return getStudioVersionInfo(opts);
    case 'checkStudioUpdate':
      return checkStudioUpdate(payload, opts);
    case 'startStudioUpdate':
      return startStudioUpdate(payload, opts);
    case 'getStudioUpdateStatus':
      return getStudioUpdateStatus(opts);
    default:
      return { ok: false, error: 'unknown_studio_update_action' };
  }
}
