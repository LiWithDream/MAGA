#!/usr/bin/env node
/**
 * Live Desktop Smoke Verification & GitHub Commit Status Reporter (`npm run smoke:live`).
 * Verifies local `doctor` health + live Antigravity CDP invariants (`observerCount === 1`,
 * `isUsingKernel === true`, `ownHasCount === 0`, Windows `--ag-win-top-bar` sync), then
 * optionally stamps `smoke/darwin` or `smoke/win32` Commit Status on GitHub via `gh api`.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateOnAntigravityPage } from './cdp-probe.mjs';
import { runDoctor } from './cli.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

export const SMOKE_CDP_EXPRESSION = `(() => {
  const observerCount = window.__agyMagaKernel?.getStats?.()?.observerCount ?? null;
  const isUsingKernel = window.__agClaudeUxKernelHooks?.isUsingKernel?.() ?? null;
  let ownHasCount = 0;
  const styleNodes = document.querySelectorAll(
    'style[data-maga-own], style[id*="maga"], style[id*="agy-"], style[id*="ag-claude"], style[id*="anti-claude"]'
  );
  for (const node of styleNodes) {
    const clean = String(node.textContent || '').replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');
    const hits = clean.match(/:has\\s*\\(/g);
    if (hits) ownHasCount += hits.length;
  }
  const winW = window.innerWidth || 0;
  let detectedTopBarPx = 0;
  for (const el of document.querySelectorAll('.bg-sidebar')) {
    const r = el.getBoundingClientRect();
    if (r && r.top >= -1 && r.top <= 4 && r.height >= 16 && r.height <= 56 && winW > 200 && r.width >= winW - 160) {
      detectedTopBarPx = Math.round(r.bottom);
      break;
    }
  }
  const rawTopVar = getComputedStyle(document.documentElement).getPropertyValue('--ag-win-top-bar').trim();
  const parsedTopVar = parseInt(rawTopVar, 10);
  const winTopBarCssPx = Number.isFinite(parsedTopVar) && parsedTopVar > 0 ? parsedTopVar : 0;
  return {
    observerCount,
    isUsingKernel,
    ownHasCount,
    detectedTopBarPx,
    winTopBarCssPx,
  };
})()`;

export function parseGitHubRepoSlug(remoteUrl) {
  const s = String(remoteUrl || '').trim();
  if (!s) return null;
  const m = s.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    slug: `${m[1]}/${m[2]}`,
  };
}

export function resolveSmokeContext(platform = process.platform) {
  if (platform === 'darwin') return 'smoke/darwin';
  if (platform === 'win32') return 'smoke/win32';
  return `smoke/${platform}`;
}

export function evaluateLiveSmokeResult({
  doctorReport = null,
  cdpResult = null,
  platform = process.platform,
  targetSha = '',
  allowShaMismatch = false,
} = {}) {
  const deployedSha = String(doctorReport?.deployedFrom?.sha || '').trim();
  const deployedDirty = Boolean(doctorReport?.deployedFrom?.dirty);
  const deployMatchesSha =
    allowShaMismatch ||
    !targetSha ||
    !deployedSha ||
    (deployedSha.toLowerCase() === String(targetSha).trim().toLowerCase() && !deployedDirty);

  const val = cdpResult?.ok && cdpResult.value && typeof cdpResult.value === 'object' ? cdpResult.value : null;
  const detectedTopBarPx = Number(val?.detectedTopBarPx || 0);
  const winTopBarCssPx = Number(val?.winTopBarCssPx || 0);
  const winTopBarAligned =
    platform !== 'win32' || detectedTopBarPx <= 0 || winTopBarCssPx === detectedTopBarPx;

  const checks = {
    doctorOk: Boolean(doctorReport?.ok),
    cdpReady: doctorReport?.cdpStatus === 'ready',
    daemonAligned: doctorReport?.daemonAlignedWithDeploy !== false,
    deployMatchesSha,
    cdpConnected: Boolean(cdpResult?.ok),
    observerCount: val?.observerCount === 1,
    isUsingKernel: val?.isUsingKernel === true,
    ownHasCount: val?.ownHasCount === 0,
    winTopBarAligned,
  };

  const failures = [];
  if (!checks.doctorOk) failures.push('doctor_failed');
  if (!checks.cdpReady) failures.push(`cdp_status_${doctorReport?.cdpStatus || 'unknown'}`);
  if (!checks.daemonAligned) failures.push('daemon_split_brain');
  if (!checks.deployMatchesSha) {
    failures.push(
      deployedDirty
        ? 'deployed_from_dirty_tree'
        : `deployed_sha_mismatch(${deployedSha.slice(0, 7)}!=${String(targetSha).slice(0, 7)})`
    );
  }
  if (!checks.cdpConnected) failures.push(`cdp_probe_failed(${cdpResult?.error || 'unknown'})`);
  else {
    if (!checks.observerCount) failures.push(`observer_count_${String(val?.observerCount)}`);
    if (!checks.isUsingKernel) failures.push(`using_kernel_${String(val?.isUsingKernel)}`);
    if (!checks.ownHasCount) failures.push(`own_has_count_${String(val?.ownHasCount)}`);
    if (!checks.winTopBarAligned) {
      failures.push(`win_top_bar_mismatch(css=${winTopBarCssPx}px,detected=${detectedTopBarPx}px)`);
    }
  }

  const ok = failures.length === 0;
  const rawDesc = ok
    ? `AGY Studio live smoke passed on ${platform} (doctor ok, observer=1, kernel=true, :has=0)`
    : `AGY Studio live smoke failed on ${platform}: ${failures.join(', ')}`;
  const description = rawDesc.length > 140 ? `${rawDesc.slice(0, 137)}...` : rawDesc;

  return { ok, checks, failures, description };
}

export function postGitHubCommitStatus({
  slug,
  sha,
  context,
  state,
  description,
  execFile = execFileSync,
} = {}) {
  if (!slug || !sha || !context || !state) {
    throw new Error('Missing required GitHub commit status fields (slug, sha, context, state)');
  }
  const safeDesc = String(description || '').slice(0, 140);
  const out = execFile(
    'gh',
    [
      'api',
      '-X',
      'POST',
      `repos/${slug}/statuses/${sha}`,
      '-f',
      `state=${state}`,
      '-f',
      `context=${context}`,
      '-f',
      `description=${safeDesc}`,
    ],
    {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  try {
    return JSON.parse(out);
  } catch {
    return { ok: true, raw: String(out || '').trim() };
  }
}

function readGitOutput(cwd, args, execFile) {
  try {
    return execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

export async function runLiveSmoke({
  cwd = REPO_ROOT,
  platform = process.platform,
  sha = '',
  remote = 'origin',
  noReport = false,
  dryRun = false,
  reportFailure = false,
  allowShaMismatch = false,
  timeoutMs = 5000,
  doctorFn = runDoctor,
  evaluateCdpFn = evaluateOnAntigravityPage,
  execFile = execFileSync,
} = {}) {
  const targetSha = String(sha || readGitOutput(cwd, ['rev-parse', 'HEAD'], execFile)).trim();
  const remoteUrl = readGitOutput(cwd, ['remote', 'get-url', remote], execFile);
  const parsedRepo = parseGitHubRepoSlug(remoteUrl);
  const repoSlug = parsedRepo?.slug || null;
  const context = resolveSmokeContext(platform);

  const doctorReport = await doctorFn();
  const cdpResult = await evaluateCdpFn(SMOKE_CDP_EXPRESSION, { timeoutMs });
  const evaluated = evaluateLiveSmokeResult({
    doctorReport,
    cdpResult,
    platform,
    targetSha,
    allowShaMismatch,
  });

  const reportPayload =
    repoSlug && targetSha
      ? {
          slug: repoSlug,
          sha: targetSha,
          context,
          state: evaluated.ok ? 'success' : 'failure',
          description: evaluated.description,
        }
      : null;

  let reported = false;
  let reportError = null;
  const shouldPost = Boolean(!noReport && !dryRun && reportPayload && (evaluated.ok || reportFailure));

  if (shouldPost) {
    try {
      postGitHubCommitStatus({ ...reportPayload, execFile });
      reported = true;
    } catch (err) {
      reportError = String(err?.stderr || err?.message || err || 'gh api failed').trim();
      evaluated.failures.push(`github_status_report_failed(${reportError})`);
      evaluated.ok = false;
    }
  }

  return {
    ok: evaluated.ok,
    platform,
    context,
    sha: targetSha || null,
    repoSlug,
    checks: evaluated.checks,
    failures: evaluated.failures,
    description: evaluated.description,
    reported,
    dryRun: Boolean(dryRun),
    ...(reportError ? { reportError } : {}),
    reportPayload,
    cdp: cdpResult,
    doctorSummary: {
      ok: Boolean(doctorReport?.ok),
      cdpStatus: doctorReport?.cdpStatus || null,
      daemonPointsToStudio: doctorReport?.daemonPointsToStudio ?? null,
      daemonAlignedWithDeploy: doctorReport?.daemonAlignedWithDeploy ?? null,
      deployedSha: doctorReport?.deployedFrom?.sha || null,
      deployedDirty: Boolean(doctorReport?.deployedFrom?.dirty),
    },
  };
}

function parseArgs(argv) {
  const opts = {
    sha: '',
    remote: 'origin',
    noReport: false,
    dryRun: false,
    reportFailure: false,
    allowShaMismatch: false,
    timeoutMs: 5000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-report') opts.noReport = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--report-failure') opts.reportFailure = true;
    else if (a === '--allow-sha-mismatch') opts.allowShaMismatch = true;
    else if (a === '--sha' && argv[i + 1]) opts.sha = String(argv[++i]).trim();
    else if (a === '--remote' && argv[i + 1]) opts.remote = String(argv[++i]).trim();
    else if (a === '--timeout' && argv[i + 1]) opts.timeoutMs = Math.max(1000, parseInt(argv[++i], 10) || 5000);
  }
  return opts;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const report = await runLiveSmoke(opts);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error('[AGY Studio smoke:live]', err?.message || err);
    process.exit(1);
  }
}
