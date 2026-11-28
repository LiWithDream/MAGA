import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TEST_DIR, '..');
const realpathNative = fs.realpathSync.native || fs.realpathSync;

const workerMod = await import(pathToFileURL(path.join(REPO, 'studio', 'daemon', 'update-worker.mjs')).href);
const serviceMod = await import(pathToFileURL(path.join(REPO, 'studio', 'daemon', 'update-service.mjs')).href);
const updateViewMod = await import(pathToFileURL(path.join(REPO, 'studio', 'modules', 'settings', 'update-view.mjs')).href);
const updateEventsMod = await import(
  pathToFileURL(path.join(REPO, 'studio', 'modules', 'settings', 'update-events.mjs')).href
);
const viewsMod = await import(pathToFileURL(path.join(REPO, 'studio', 'modules', 'settings', 'views.mjs')).href);

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeTempDir(prefix) {
  return realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function createFakeRepoFiles(dir, { version = '1.6.0', prebuilt = false } = {}) {
  fs.mkdirSync(path.join(dir, 'studio'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'user'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agy-studio', version }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'studio', 'cli.mjs'), '// cli\n');
  if (prebuilt) {
    fs.mkdirSync(path.join(dir, 'studio', 'prebuilt'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'studio', 'prebuilt', 'studio-entry.js'), '// prebuilt\n');
    fs.writeFileSync(path.join(dir, 'user', 'custom.js'), '// custom\n');
  }
}

function createBareAndClone(tmpBase, { version = '1.6.0', tag = 'v1.6.0' } = {}) {
  const bareDir = path.join(tmpBase, 'origin.git');
  const seedDir = path.join(tmpBase, 'seed');
  const cloneDir = path.join(tmpBase, 'clone');
  execFileSync('git', ['init', '--bare', '-b', 'main', bareDir], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', seedDir], { stdio: 'ignore' });
  git(seedDir, ['config', 'user.name', 'Test']);
  git(seedDir, ['config', 'user.email', 'test@example.local']);
  createFakeRepoFiles(seedDir, { version, prebuilt: false });
  fs.writeFileSync(path.join(seedDir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git(seedDir, ['add', '.']);
  git(seedDir, ['commit', '-m', `release ${tag}`]);
  if (tag) git(seedDir, ['tag', '-a', tag, '-m', tag]);
  git(seedDir, ['remote', 'add', 'origin', bareDir]);
  git(seedDir, ['push', 'origin', 'main', '--tags']);

  execFileSync('git', ['clone', bareDir, cloneDir], { stdio: 'ignore' });
  git(cloneDir, ['config', 'user.name', 'Test']);
  git(cloneDir, ['config', 'user.email', 'test@example.local']);
  return { bareDir, seedDir, cloneDir };
}

test('pure helpers: compareSemver, parseSha256File, isAllowedDownloadUrl, parseReleaseNotesSummary, resolveNpmInvocation', () => {
  assert.equal(serviceMod.compareSemver('1.7.0', '1.6.0'), 1);
  assert.equal(serviceMod.compareSemver('2.0.0', '1.6.0'), 1);
  assert.equal(serviceMod.compareSemver('v1.10.0', 'v1.9.9'), 1);
  assert.equal(serviceMod.compareSemver('1.6.0', '1.6.0'), 0);
  assert.equal(serviceMod.compareSemver('1.7.0-rc.1', '1.7.0'), -1);
  assert.equal(serviceMod.compareSemver('1.7.0-beta', '1.7.0-alpha'), 1);

  assert.deepEqual(
    serviceMod.pickLatestStableTagFromLsRemote(
      [
        '1111111111111111111111111111111111111111\trefs/tags/v1.6.0',
        '2222222222222222222222222222222222222222\trefs/tags/v1.10.0',
        '3333333333333333333333333333333333333333\trefs/tags/v2.0.0-rc.1',
        '4444444444444444444444444444444444444444\trefs/tags/v2.0.0',
        '5555555555555555555555555555555555555555\trefs/tags/v2.1.0-beta.1',
        '6666666666666666666666666666666666666666\trefs/tags/nested/v9.9.9',
      ].join('\n')
    ),
    { tag: 'v2.0.0', version: '2.0.0' }
  );
  assert.equal(
    serviceMod.pickLatestStableTagFromLsRemote(
      '1111111111111111111111111111111111111111\trefs/tags/v2.0.0-rc.1\n' +
        '2222222222222222222222222222222222222222\trefs/tags/v2.1.0-alpha.1\n'
    ),
    null
  );

  assert.equal(
    workerMod.parseSha256File('a'.repeat(64) + '  agy-studio-v1.7.0-macos.tar.gz\n', 'agy-studio-v1.7.0-macos.tar.gz'),
    'a'.repeat(64)
  );
  assert.equal(
    workerMod.parseSha256File('b'.repeat(64) + '  other.zip\n', 'agy-studio-v1.7.0-macos.tar.gz'),
    null
  );
  assert.equal(workerMod.parseSha256File('C'.repeat(64) + '\n', 'any.zip'), 'c'.repeat(64));

  assert.equal(
    workerMod.isAllowedDownloadUrl(
      'https://github.com/LiWithDream/agy-studio/releases/download/v1.7.0/agy-studio-v1.7.0-macos.tar.gz',
      { initial: true }
    ),
    true
  );
  assert.equal(
    workerMod.isAllowedDownloadUrl('https://objects.githubusercontent.com/github-production-release-asset/123', {
      initial: false,
    }),
    true
  );
  assert.equal(
    workerMod.isAllowedDownloadUrl('https://github.com/evil/repo/releases/download/v1/a.tar.gz', { initial: true }),
    false
  );
  assert.equal(
    workerMod.isAllowedDownloadUrl('http://github.com/LiWithDream/agy-studio/releases/download/v1/a.tar.gz', {
      initial: true,
    }),
    false
  );
  assert.equal(workerMod.isAllowedDownloadUrl('https://evil.example.com/payload.tar.gz', { initial: false }), false);

  const notes = serviceMod.parseReleaseNotesSummary(
    '## Added\n- **Fast** update (`update-service.mjs`)\n- [Docs](https://example.com) link\n---\n1. Third item\n',
    2
  );
  assert.deepEqual(notes, ['Fast update (update-service.mjs)', 'Docs link']);

  // resolveNpmInvocation on both darwin & win32 with injected fs
  const fakeWinFs = {
    existsSync: (p) => /npm-cli\.js$/i.test(p),
  };
  const winNpm = workerMod.resolveNpmInvocation('C:\\Program Files\\nodejs\\node.exe', 'win32', fakeWinFs);
  assert.equal(winNpm.bin, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(winNpm.prefixArgs, ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js']);
  assert.equal(winNpm.shell, false);

  const fakeWinFallbackFs = { existsSync: () => false };
  const winCmdNpm = workerMod.resolveNpmInvocation('C:\\Program Files\\nodejs\\node.exe', 'win32', fakeWinFallbackFs);
  assert.equal(winCmdNpm.bin, 'npm.cmd');
  assert.equal(winCmdNpm.shell, true);

  const posixNpm = workerMod.resolveNpmInvocation('/opt/homebrew/bin/node', 'darwin', fakeWinFs);
  assert.equal(posixNpm.bin, '/opt/homebrew/bin/node');
  assert.ok(posixNpm.prefixArgs[0].endsWith(path.join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')));
});

test('detectInstallState & evaluateSelfUpdateEligibility enforce prebuilt, stable, edge & safety guardrails', async () => {
  const tmp = makeTempDir('maga-upd-elig-');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    // 1. Prebuilt install
    const prebuiltDir = path.join(tmp, 'prebuilt');
    createFakeRepoFiles(prebuiltDir, { version: '1.6.0', prebuilt: true });
    const prebuiltLocal = await serviceMod.detectInstallState({
      repoRoot: prebuiltDir,
      stateDir,
      platform: 'darwin',
      readDeployMetaFn: () => ({ present: false, meta: null }),
    });
    assert.equal(prebuiltLocal.channel, 'prebuilt');
    assert.equal(prebuiltLocal.installMode, 'prebuilt');
    assert.deepEqual(serviceMod.evaluateSelfUpdateEligibility(prebuiltLocal), {
      canSelfUpdate: true,
      blockReason: null,
    });

    // Missing release asset blocks prebuilt self-update cleanly
    assert.deepEqual(serviceMod.evaluateSelfUpdateEligibility(prebuiltLocal, { assetMissing: true }), {
      canSelfUpdate: false,
      blockReason: 'missing_release_asset',
    });

    // 2. Git detached tag (stable), edge (main), dirty, ahead, custom branch, linked worktree, split-brain
    const gitBase = path.join(tmp, 'git');
    const { cloneDir } = createBareAndClone(gitBase, { version: '1.6.0', tag: 'v1.6.0' });

    // Edge on main (clean, 0 ahead)
    const edgeLocal = await serviceMod.detectInstallState({
      repoRoot: cloneDir,
      stateDir,
      platform: 'win32',
      readDeployMetaFn: () => ({ present: false, meta: null }),
    });
    assert.equal(edgeLocal.channel, 'edge');
    assert.equal(edgeLocal.installMode, 'git-edge');
    assert.equal(serviceMod.evaluateSelfUpdateEligibility(edgeLocal).canSelfUpdate, true);
    assert.match(serviceMod.buildManualUpdateCommand(edgeLocal), /install\.ps1 -Channel edge/);

    // Local ahead commit on main -> blocked
    fs.writeFileSync(path.join(cloneDir, 'local.txt'), 'unpushed\n');
    git(cloneDir, ['add', 'local.txt']);
    git(cloneDir, ['commit', '-m', 'local ahead']);
    const aheadLocal = await serviceMod.detectInstallState({
      repoRoot: cloneDir,
      stateDir,
      platform: 'darwin',
      readDeployMetaFn: () => ({ present: false, meta: null }),
    });
    assert.equal(aheadLocal.aheadCount, 1);
    assert.equal(serviceMod.evaluateSelfUpdateEligibility(aheadLocal).blockReason, 'local_ahead_commits');

    // Detached tag -> stable
    git(cloneDir, ['checkout', '--detach', 'refs/tags/v1.6.0']);
    const stableLocal = await serviceMod.detectInstallState({
      repoRoot: cloneDir,
      stateDir,
      platform: 'darwin',
      readDeployMetaFn: () => ({ present: false, meta: null }),
    });
    assert.equal(stableLocal.channel, 'stable');
    assert.equal(stableLocal.installMode, 'git-stable');
    assert.equal(stableLocal.releaseTag, 'v1.6.0');
    assert.equal(serviceMod.evaluateSelfUpdateEligibility(stableLocal).canSelfUpdate, true);

    // Dirty worktree -> blocked
    fs.writeFileSync(path.join(cloneDir, 'dirty.txt'), 'dirty\n');
    const dirtyLocal = await serviceMod.detectInstallState({
      repoRoot: cloneDir,
      stateDir,
      platform: 'darwin',
      readDeployMetaFn: () => ({ present: false, meta: null }),
    });
    assert.equal(serviceMod.evaluateSelfUpdateEligibility(dirtyLocal).blockReason, 'dirty_worktree');
    fs.rmSync(path.join(cloneDir, 'dirty.txt'));

    // Custom branch -> blocked
    git(cloneDir, ['checkout', '-b', 'feat/custom']);
    const customLocal = await serviceMod.detectInstallState({
      repoRoot: cloneDir,
      stateDir,
      platform: 'darwin',
      readDeployMetaFn: () => ({ present: false, meta: null }),
    });
    assert.equal(serviceMod.evaluateSelfUpdateEligibility(customLocal).blockReason, 'non_release_branch');

    // Linked worktree -> blocked
    const wtDir = path.join(gitBase, 'linked-wt');
    git(cloneDir, ['checkout', '--detach', 'refs/tags/v1.6.0']);
    git(cloneDir, ['worktree', 'add', '-b', 'feat/wt-test', wtDir]);
    const wtLocal = await serviceMod.detectInstallState({
      repoRoot: wtDir,
      stateDir,
      platform: 'darwin',
      readDeployMetaFn: () => ({ present: false, meta: null }),
    });
    assert.equal(wtLocal.isLinkedWorktree, true);
    assert.equal(serviceMod.evaluateSelfUpdateEligibility(wtLocal).blockReason, 'linked_worktree');

    // Split-brain / preview deploy-meta -> blocked
    const splitLocal = await serviceMod.detectInstallState({
      repoRoot: cloneDir,
      stateDir,
      platform: 'darwin',
      readDeployMetaFn: () => ({
        present: true,
        meta: { branch: 'main', worktreePath: path.join(tmp, 'other-checkout'), preview: false },
      }),
    });
    assert.equal(splitLocal.splitBrain, true);
    assert.equal(serviceMod.evaluateSelfUpdateEligibility(splitLocal).blockReason, 'deploy_mismatch');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkStudioUpdate handles stable/prebuilt, caching, rate-limit git ls-remote fallback, and edge commit checks', async () => {
  serviceMod.clearUpdateCheckCache();
  const tmp = makeTempDir('maga-upd-check-');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    const prebuiltWin = path.join(tmp, 'prebuilt-win');
    createFakeRepoFiles(prebuiltWin, { version: '1.6.0', prebuilt: true });

    let fetchCalls = 0;
    const okFetch = async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v1.7.0',
          draft: false,
          prerelease: false,
          html_url: 'https://github.com/LiWithDream/agy-studio/releases/tag/v1.7.0',
          published_at: '2026-11-28T12:00:00Z',
          body: '## Added\n- Self-update support\n- Windows parity',
          assets: [
            {
              name: 'agy-studio-v1.7.0-windows.zip',
              browser_download_url:
                'https://github.com/LiWithDream/agy-studio/releases/download/v1.7.0/agy-studio-v1.7.0-windows.zip',
            },
            {
              name: 'agy-studio-v1.7.0-windows.zip.sha256',
              browser_download_url:
                'https://github.com/LiWithDream/agy-studio/releases/download/v1.7.0/agy-studio-v1.7.0-windows.zip.sha256',
            },
          ],
        }),
      };
    };

    let clock = 10000;
    const first = await serviceMod.checkStudioUpdate(
      {},
      {
        repoRoot: prebuiltWin,
        stateDir,
        platform: 'win32',
        fetchImpl: okFetch,
        now: () => clock,
        readDeployMetaFn: () => ({ present: false, meta: null }),
      }
    );
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    assert.equal(first.check.updateAvailable, true);
    assert.equal(first.check.latestVersion, '1.7.0');
    assert.equal(first.check.archiveName, 'agy-studio-v1.7.0-windows.zip');
    assert.equal(first.eligibility.canSelfUpdate, true);
    assert.equal(fetchCalls, 1);

    // Within 2m TTL -> returns cached without hitting fetch
    clock += 30000;
    const second = await serviceMod.checkStudioUpdate(
      {},
      {
        repoRoot: prebuiltWin,
        stateDir,
        platform: 'win32',
        fetchImpl: okFetch,
        now: () => clock,
        readDeployMetaFn: () => ({ present: false, meta: null }),
      }
    );
    assert.equal(second.cached, true);
    assert.equal(fetchCalls, 1);

    // Rate-limited prebuilt -> structured rate_limited error
    const rateLimitFetch = async () => ({
      ok: false,
      status: 403,
      headers: { get: (k) => (k === 'x-ratelimit-reset' ? '1800000000' : null) },
    });
    const rlPrebuilt = await serviceMod.checkStudioUpdate(
      { force: true },
      {
        repoRoot: prebuiltWin,
        stateDir,
        platform: 'darwin',
        fetchImpl: rateLimitFetch,
        readDeployMetaFn: () => ({ present: false, meta: null }),
      }
    );
    assert.equal(rlPrebuilt.ok, false);
    assert.equal(rlPrebuilt.error, 'rate_limited');
    assert.equal(rlPrebuilt.rateLimitResetAt, 1800000000 * 1000);

    // Git repo: push v1.7.0 to local bare origin, verify rate-limit falls back to git ls-remote!
    const gitBase = path.join(tmp, 'git');
    const { seedDir, cloneDir } = createBareAndClone(gitBase, { version: '1.6.0', tag: 'v1.6.0' });
    fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'agy-studio', version: '1.7.0' }) + '\n');
    git(seedDir, ['add', 'package.json']);
    git(seedDir, ['commit', '-m', 'bump 1.7.0']);
    git(seedDir, ['tag', '-a', 'v1.7.0', '-m', 'v1.7.0']);
    git(seedDir, ['push', 'origin', 'main', '--tags']);
    const remoteHeadSha = git(seedDir, ['rev-parse', 'HEAD']);

    // Edge check on main detects new remote SHA
    const edgeCheck = await serviceMod.checkStudioUpdate(
      { force: true },
      {
        repoRoot: cloneDir,
        stateDir,
        platform: 'darwin',
        fetchImpl: okFetch,
        readDeployMetaFn: () => ({ present: false, meta: null }),
      }
    );
    assert.equal(edgeCheck.ok, true);
    assert.equal(edgeCheck.check.channel, 'edge');
    assert.equal(edgeCheck.check.updateAvailable, true);
    assert.equal(edgeCheck.check.targetSha, remoteHeadSha);
    assert.equal(edgeCheck.check.latestTag, 'v1.7.0');

    // Detached v1.6.0 stable check under GitHub 403 rate limit falls back to git ls-remote
    git(cloneDir, ['checkout', '--detach', 'refs/tags/v1.6.0']);
    const stableFallback = await serviceMod.checkStudioUpdate(
      { force: true },
      {
        repoRoot: cloneDir,
        stateDir,
        platform: 'darwin',
        fetchImpl: rateLimitFetch,
        readDeployMetaFn: () => ({ present: false, meta: null }),
      }
    );
    assert.equal(stableFallback.ok, true);
    assert.equal(stableFallback.check.source, 'git-ls-remote');
    assert.equal(stableFallback.check.latestTag, 'v1.7.0');
    assert.equal(stableFallback.check.updateAvailable, true);

    // Cross-major fallback (1.6.0 -> 2.0.0) while ignoring prerelease tags (v2.0.0-rc.1 / v2.1.0-beta.1)
    for (const [ver, tag] of [
      ['2.0.0-rc.1', 'v2.0.0-rc.1'],
      ['2.0.0', 'v2.0.0'],
      ['2.1.0-beta.1', 'v2.1.0-beta.1'],
    ]) {
      fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'agy-studio', version: ver }) + '\n');
      git(seedDir, ['add', 'package.json']);
      git(seedDir, ['commit', '-m', `bump ${ver}`]);
      git(seedDir, ['tag', '-a', tag, '-m', tag]);
    }
    git(seedDir, ['push', 'origin', 'main', '--tags']);

    const crossMajorFallback = await serviceMod.checkStudioUpdate(
      { force: true },
      {
        repoRoot: cloneDir,
        stateDir,
        platform: 'darwin',
        fetchImpl: rateLimitFetch,
        readDeployMetaFn: () => ({ present: false, meta: null }),
      }
    );
    assert.equal(crossMajorFallback.ok, true);
    assert.equal(crossMajorFallback.check.source, 'git-ls-remote');
    assert.equal(crossMajorFallback.check.latestTag, 'v2.0.0');
    assert.equal(crossMajorFallback.check.latestVersion, '2.0.0');
    assert.equal(crossMajorFallback.check.updateAvailable, true);
  } finally {
    serviceMod.clearUpdateCheckCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('update-worker prebuilt flow: verifies SHA-256 over redirect, swaps atomically, blocks tampering, and rolls back on install failure', async () => {
  const tmp = makeTempDir('maga-upd-prebuilt-');
  const stateDir = path.join(tmp, 'state');
  const dlTmp = path.join(tmp, 'dl-tmp');
  const stageSrc = path.join(tmp, 'src-archive');
  const repoRoot = path.join(tmp, 'install-root');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(dlTmp, { recursive: true });
  try {
    createFakeRepoFiles(repoRoot, { version: '1.6.0', prebuilt: true });
    const newTree = path.join(stageSrc, 'agy-studio-v1.7.0-macos');
    createFakeRepoFiles(newTree, { version: '1.7.0', prebuilt: true });
    const archivePath = path.join(stageSrc, 'agy-studio-v1.7.0-macos.tar.gz');
    execFileSync('tar', ['-czf', archivePath, '-C', stageSrc, 'agy-studio-v1.7.0-macos']);
    const archiveBuf = fs.readFileSync(archivePath);
    const validSha = crypto.createHash('sha256').update(archiveBuf).digest('hex');

    const archiveUrl =
      'https://github.com/LiWithDream/agy-studio/releases/download/v1.7.0/agy-studio-v1.7.0-macos.tar.gz';
    const shaUrl = `${archiveUrl}.sha256`;

    const mockFetch = async (url) => {
      if (url === archiveUrl) {
        return {
          status: 302,
          ok: false,
          headers: { get: (k) => (k === 'location' ? 'https://objects.githubusercontent.com/asset/1.7.0.tar.gz' : null) },
        };
      }
      if (url === 'https://objects.githubusercontent.com/asset/1.7.0.tar.gz') {
        return { status: 200, ok: true, arrayBuffer: async () => archiveBuf };
      }
      if (url === shaUrl) {
        return {
          status: 200,
          ok: true,
          arrayBuffer: async () => Buffer.from(`${validSha}  agy-studio-v1.7.0-macos.tar.gz\n`, 'utf8'),
        };
      }
      return { status: 404, ok: false };
    };

    const recordedCalls = [];
    const execOk = (bin, args, opts) => {
      if (bin === 'tar') return execFileSync(bin, args, opts);
      recordedCalls.push({ bin, args, env: opts?.env });
      return '{"ok":true}';
    };

    const statusFile = path.join(stateDir, 'update-status.json');
    const baseJob = {
      jobId: 'job-ok',
      repoRoot,
      stateDir,
      platform: 'darwin',
      nodeBin: process.execPath,
      installMode: 'prebuilt',
      fromVersion: '1.6.0',
      toVersion: '1.7.0',
      targetTag: 'v1.7.0',
      archiveName: 'agy-studio-v1.7.0-macos.tar.gz',
      archiveUrl,
      sha256Url: shaUrl,
      preserveNoRules: true,
      plistPath: path.join(tmp, 'nonexistent.plist'),
      pidFile: path.join(stateDir, 'daemon.pid'),
      statusFile,
    };

    // 1. Tampered SHA -> fails in verifying, keeps repoRoot untouched at 1.6.0
    const badFetch = async (url) => {
      if (url === shaUrl) {
        return {
          status: 200,
          ok: true,
          arrayBuffer: async () => Buffer.from(`${'0'.repeat(64)}  agy-studio-v1.7.0-macos.tar.gz\n`, 'utf8'),
        };
      }
      return mockFetch(url);
    };
    const tamperedRes = await workerMod.runUpdateJob(
      { ...baseJob, jobId: 'job-badsha' },
      { fetchImpl: badFetch, execFileSyncFn: execOk, tmpDir: dlTmp }
    );
    assert.equal(tamperedRes.phase, 'failed');
    assert.match(tamperedRes.error, /sha256_mismatch/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version, '1.6.0');
    assert.equal(recordedCalls.length, 0, 'daemon/install must NOT run when SHA mismatches');

    // 2. Failing cli.mjs install after swap -> rolls back cleanly to 1.6.0!
    let installAttempt = 0;
    const execFailThenRollback = (bin, args, opts) => {
      if (bin === 'tar') return execFileSync(bin, args, opts);
      if (args[1] === 'install') {
        installAttempt += 1;
        if (installAttempt === 1) throw new Error('install_boom');
      }
      return '{"ok":true}';
    };
    const rollbackRes = await workerMod.runUpdateJob(
      { ...baseJob, jobId: 'job-rb' },
      { fetchImpl: mockFetch, execFileSyncFn: execFailThenRollback, tmpDir: dlTmp }
    );
    assert.equal(rollbackRes.phase, 'failed');
    assert.equal(rollbackRes.rolledBack, true);
    assert.equal(installAttempt, 2, 'rollback should re-run install on restored 1.6.0 tree');
    assert.equal(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version, '1.6.0');

    // 3. Happy path -> upgrades to 1.7.0, passes MAGA_USE_PREBUILT=1 & --no-rules
    const okRes = await workerMod.runUpdateJob(baseJob, {
      fetchImpl: mockFetch,
      execFileSyncFn: execOk,
      tmpDir: dlTmp,
    });
    assert.equal(okRes.phase, 'succeeded');
    assert.equal(okRes.inProgress, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version, '1.7.0');
    const installCall = recordedCalls.find((c) => c.bin === process.execPath && c.args[1] === 'install');
    assert.ok(installCall);
    assert.equal(installCall.env.MAGA_USE_PREBUILT, '1');
    assert.ok(installCall.args.includes('--no-rules'));
    assert.equal(fs.existsSync(path.join(tmp, `.agy-studio-bak-job-ok`)), false);

    // 4. Windows prebuilt flow (tar.exe -> Expand-Archive fallback, stopSignalFile + schtasks /End)
    const winRepo = path.join(tmp, 'win-install-root');
    createFakeRepoFiles(winRepo, { version: '1.6.0', prebuilt: true });
    const winArchiveUrl =
      'https://github.com/LiWithDream/agy-studio/releases/download/v1.7.0/agy-studio-v1.7.0-windows.zip';
    const winShaUrl = `${winArchiveUrl}.sha256`;
    const winZipBytes = Buffer.from('PK-FAKE-ZIP-BYTES');
    const winZipSha = crypto.createHash('sha256').update(winZipBytes).digest('hex');
    const winCalls = [];
    const winFetch = async (url) => {
      if (url === winArchiveUrl) return { status: 200, ok: true, arrayBuffer: async () => winZipBytes };
      if (url === winShaUrl) {
        return {
          status: 200,
          ok: true,
          arrayBuffer: async () => Buffer.from(`${winZipSha}  agy-studio-v1.7.0-windows.zip\n`, 'utf8'),
        };
      }
      return { status: 404, ok: false };
    };
    const winExec = (bin, args) => {
      winCalls.push({ bin, args });
      if (bin === 'tar.exe') throw new Error('bsdtar_unavailable');
      if (bin === 'powershell') {
        const m = String(args[2] || '').match(/DestinationPath '([^']+)'/);
        if (m) createFakeRepoFiles(path.join(m[1], 'agy-studio-v1.7.0-windows'), { version: '1.7.0', prebuilt: true });
      }
      return '{"ok":true}';
    };
    const stopSig = path.join(stateDir, 'daemon-stop.signal');
    const winRes = await workerMod.runUpdateJob(
      {
        jobId: 'win-ok',
        repoRoot: winRepo,
        stateDir,
        platform: 'win32',
        nodeBin: process.execPath,
        installMode: 'prebuilt',
        fromVersion: '1.6.0',
        toVersion: '1.7.0',
        targetTag: 'v1.7.0',
        archiveName: 'agy-studio-v1.7.0-windows.zip',
        archiveUrl: winArchiveUrl,
        sha256Url: winShaUrl,
        taskName: 'AGYStudioDaemon',
        pidFile: path.join(stateDir, 'daemon.pid'),
        stopSignalFile: stopSig,
        statusFile,
      },
      { fetchImpl: winFetch, execFileSyncFn: winExec, tmpDir: dlTmp }
    );
    assert.equal(winRes.phase, 'succeeded');
    assert.equal(JSON.parse(fs.readFileSync(path.join(winRepo, 'package.json'), 'utf8')).version, '1.7.0');
    assert.equal(fs.existsSync(stopSig), true, 'Windows prebuilt flow must emit cooperative stop signal');
    assert.equal(winCalls.some((c) => c.bin === 'powershell'), true);
    assert.equal(winCalls.some((c) => c.bin === 'schtasks' && c.args.includes('/End')), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('update-worker git-stable & git-edge flows: conditional npm ci, fast-forward sync, and rollback on install error', async () => {
  const tmp = makeTempDir('maga-upd-git-');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    const { seedDir, cloneDir } = createBareAndClone(tmp, { version: '1.6.0', tag: 'v1.6.0' });
    // Put dummy node_modules/esbuild in clone so npm ci is skipped when lockfile unchanged
    fs.mkdirSync(path.join(cloneDir, 'node_modules', 'esbuild'), { recursive: true });

    // Create v1.7.0 with SAME package-lock.json
    fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'agy-studio', version: '1.7.0' }) + '\n');
    git(seedDir, ['add', 'package.json']);
    git(seedDir, ['commit', '-m', 'v1.7.0']);
    git(seedDir, ['tag', '-a', 'v1.7.0', '-m', 'v1.7.0']);
    git(seedDir, ['push', 'origin', 'main', '--tags']);

    // Detach clone at v1.6.0
    git(cloneDir, ['checkout', '--detach', 'refs/tags/v1.6.0']);
    const prevSha = git(cloneDir, ['rev-parse', 'HEAD']);

    const calls = [];
    const execWrapper = (bin, args, opts) => {
      if (bin === 'git') return execFileSync(bin, args, opts);
      calls.push({ bin, args });
      if (args.includes('install') && opts?.failOnInstall) throw new Error('cli_fail');
      return '{"ok":true}';
    };

    const statusFile = path.join(stateDir, 'update-status.json');
    const stableRes = await workerMod.runUpdateJob(
      {
        jobId: 'git-st-ok',
        repoRoot: cloneDir,
        stateDir,
        platform: 'darwin',
        nodeBin: process.execPath,
        installMode: 'git-stable',
        fromVersion: '1.6.0',
        toVersion: '1.7.0',
        targetTag: 'v1.7.0',
        preserveNoRules: false,
        statusFile,
      },
      { execFileSyncFn: execWrapper }
    );
    assert.equal(stableRes.phase, 'succeeded');
    assert.equal(JSON.parse(fs.readFileSync(path.join(cloneDir, 'package.json'), 'utf8')).version, '1.7.0');
    assert.equal(
      calls.some((c) => c.args.includes('ci')),
      false,
      'npm ci should be skipped when lockfile hash is unchanged and esbuild exists'
    );

    // Push v1.8.0 with CHANGED package-lock.json and simulate cli.mjs install failure -> triggers npm ci & git rollback
    fs.writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'agy-studio', version: '1.8.0' }) + '\n');
    fs.writeFileSync(path.join(seedDir, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    git(seedDir, ['add', 'package.json', 'package-lock.json']);
    git(seedDir, ['commit', '-m', 'v1.8.0']);
    git(seedDir, ['tag', '-a', 'v1.8.0', '-m', 'v1.8.0']);
    git(seedDir, ['push', 'origin', 'main', '--tags']);

    const sha170 = git(cloneDir, ['rev-parse', 'HEAD']);
    const failCalls = [];
    let installTries = 0;
    const execWithFail = (bin, args, opts) => {
      if (bin === 'git') return execFileSync(bin, args, opts);
      failCalls.push({ bin, args });
      if (args[1] === 'install') {
        installTries += 1;
        if (installTries === 1) throw new Error('boom_install');
      }
      return '{"ok":true}';
    };
    const failRes = await workerMod.runUpdateJob(
      {
        jobId: 'git-st-fail',
        repoRoot: cloneDir,
        stateDir,
        platform: 'darwin',
        nodeBin: process.execPath,
        installMode: 'git-stable',
        fromVersion: '1.7.0',
        toVersion: '1.8.0',
        targetTag: 'v1.8.0',
        statusFile,
      },
      { execFileSyncFn: execWithFail }
    );
    assert.equal(failRes.phase, 'failed');
    assert.equal(failRes.rolledBack, true);
    assert.equal(git(cloneDir, ['rev-parse', 'HEAD']), sha170, 'git HEAD must roll back to v1.7.0');
    assert.equal(
      failCalls.some((c) => c.args.includes('ci')),
      true,
      'npm ci must run when package-lock.json changes'
    );

    // Edge flow on main from v1.6.0 commit -> fast-forwards to v1.8.0 commit
    git(cloneDir, ['checkout', '-B', 'main', prevSha]);
    const edgeRes = await workerMod.runUpdateJob(
      {
        jobId: 'git-edge-ok',
        repoRoot: cloneDir,
        stateDir,
        platform: 'darwin',
        nodeBin: process.execPath,
        installMode: 'git-edge',
        fromVersion: '1.6.0',
        toVersion: '1.8.0',
        statusFile,
      },
      { execFileSyncFn: execWrapper }
    );
    assert.equal(edgeRes.phase, 'succeeded');
    assert.equal(JSON.parse(fs.readFileSync(path.join(cloneDir, 'package.json'), 'utf8')).version, '1.8.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('startStudioUpdate enforces single-flight lock, preserves --no-rules, and getStudioUpdateStatus reconciles dead workers', async () => {
  serviceMod.clearUpdateCheckCache();
  const tmp = makeTempDir('maga-upd-start-');
  const homeDir = path.join(tmp, 'home');
  const stateDir = path.join(tmp, 'state');
  const tmpWorkerDir = path.join(tmp, 'wtmp');
  const repoRoot = path.join(tmp, 'prebuilt');
  fs.mkdirSync(path.join(homeDir, '.gemini'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  createFakeRepoFiles(repoRoot, { version: '1.6.0', prebuilt: true });

  // No fast-io block in AGENTS.md -> preserveNoRules should be true
  fs.writeFileSync(path.join(homeDir, '.gemini', 'AGENTS.md'), '# Custom user rules\n', 'utf8');

  const fetchNew = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: 'v1.7.0',
      draft: false,
      prerelease: false,
      html_url: 'https://github.com/LiWithDream/agy-studio/releases/tag/v1.7.0',
      body: '- Improved update flow',
      assets: [
        {
          name: 'agy-studio-v1.7.0-macos.tar.gz',
          browser_download_url:
            'https://github.com/LiWithDream/agy-studio/releases/download/v1.7.0/agy-studio-v1.7.0-macos.tar.gz',
        },
        {
          name: 'agy-studio-v1.7.0-macos.tar.gz.sha256',
          browser_download_url:
            'https://github.com/LiWithDream/agy-studio/releases/download/v1.7.0/agy-studio-v1.7.0-macos.tar.gz.sha256',
        },
      ],
    }),
  });

  const spawned = [];
  const spawnMock = (bin, args, opts) => {
    spawned.push({ bin, args, opts });
    return { pid: 999991, unref: () => {} };
  };

  let alive = true;
  let clock = 100000;
  const commonOpts = {
    repoRoot,
    stateDir,
    home: homeDir,
    tmpDir: tmpWorkerDir,
    platform: 'darwin',
    nodeBin: process.execPath,
    fetchImpl: fetchNew,
    spawnImpl: spawnMock,
    isPidAliveFn: () => alive,
    now: () => clock,
    readDeployMetaFn: () => ({ present: false, meta: null }),
  };

  try {
    const startRes = await serviceMod.startStudioUpdate({}, commonOpts);
    assert.equal(startRes.ok, true);
    assert.equal(startRes.started, true);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].opts.detached, true);
    assert.equal(fs.existsSync(spawned[0].args[0]), true, 'worker copied to tmpDir');
    const jobJson = JSON.parse(fs.readFileSync(spawned[0].args[1], 'utf8'));
    assert.equal(jobJson.preserveNoRules, true);
    assert.equal(jobJson.toVersion, '1.7.0');

    // Second concurrent call -> single-flight lock rejects
    const secondRes = await serviceMod.startStudioUpdate({}, commonOpts);
    assert.equal(secondRes.ok, false);
    assert.equal(secondRes.error, 'update_in_progress');

    // Advance past 3s grace & mark worker dead -> status reconciles to failed
    clock += 5000;
    alive = false;
    const statusRes = await serviceMod.getStudioUpdateStatus(commonOpts);
    assert.equal(statusRes.status.inProgress, false);
    assert.equal(statusRes.status.phase, 'failed');
    assert.equal(statusRes.status.error, 'worker_exited_unexpectedly');
  } finally {
    serviceMod.clearUpdateCheckCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Settings UI update-view & update-events: XSS escape, inline confirm flow, and cross-restart polling reconnect tolerance', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
  });
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });

  try {
    const L = (zh, en) => en;
    const state = {
      resetArmed: false,
      updateArmed: false,
      updateVersionInfo: {
        ok: true,
        local: { version: '1.6.0', channel: 'prebuilt', platform: 'darwin' },
        eligibility: { canSelfUpdate: true, blockReason: null },
        manualCommand: 'curl -fsSL https://raw.githubusercontent.com/LiWithDream/agy-studio/main/install.sh | bash',
      },
      updateCheck: {
        ok: true,
        local: { version: '1.6.0', channel: 'prebuilt', platform: 'darwin' },
        eligibility: { canSelfUpdate: true, blockReason: null },
        manualCommand: 'curl -fsSL https://raw.githubusercontent.com/LiWithDream/agy-studio/main/install.sh | bash',
        check: {
          channel: 'prebuilt',
          updateAvailable: true,
          latestVersion: '1.7.0',
          latestTag: 'v1.7.0',
          notes: ['<img src=x onerror=alert(1)> safe note'],
          releasePageUrl: 'https://github.com/LiWithDream/agy-studio/releases/tag/v1.7.0',
        },
      },
      updateJob: null,
      updateChecking: false,
      updatePollTimer: 0,
      updateDisconnectCount: 0,
    };

    const root = dom.window.document.getElementById('root');
    const rerender = () => {
      root.innerHTML = viewsMod.renderL1(
        { customizeModelList: false, hiddenModels: [], hideThinkingProse: false, overviewUsageEnabled: true, motionLevel: 'full' },
        { modules: { i18n: false, claudeUxHideSidebarProjects: false }, cjkFontScale: '95' },
        { executors: [] },
        { studioPrefs: { getHostPref: () => 0, getStepStreamMode: () => 'compact' }, state, L }
      );
    };
    rerender();

    assert.equal(root.innerHTML.includes('<img src=x'), false, 'release notes HTML must be escaped');
    assert.ok(root.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(root.textContent.includes('Update to v1.7.0'));

    let pollTick = 0;
    const toasts = [];
    const mockRpc = async (action) => {
      if (action === 'startStudioUpdate') {
        return {
          ok: true,
          started: true,
          jobId: 'j1',
          status: { inProgress: true, phase: 'restarting', installMode: 'prebuilt', fromVersion: '1.6.0', toVersion: '1.7.0' },
        };
      }
      if (action === 'getStudioUpdateStatus') {
        pollTick += 1;
        if (pollTick <= 2) return null; // Simulate 2 transient daemon restart disconnects
        return {
          ok: true,
          local: { version: '1.7.0', channel: 'prebuilt', platform: 'darwin' },
          status: { inProgress: false, phase: 'succeeded', installMode: 'prebuilt', fromVersion: '1.6.0', toVersion: '1.7.0' },
        };
      }
      return { ok: false };
    };

    // Click Update -> opens inline confirm
    const armBtn = root.querySelector('[data-ms-action="update-arm"]');
    await updateEventsMod.handleUpdateSettingsClick(armBtn, {
      state,
      renderActiveHost: rerender,
      flashToast: (zh, en) => toasts.push(en),
      callRpc: mockRpc,
    });
    assert.equal(state.updateArmed, true);
    assert.ok(root.querySelector('[data-ms-action="update-confirm"]'));

    // Click Confirm -> starts detached update and polls across 2 disconnects
    const confirmBtn = root.querySelector('[data-ms-action="update-confirm"]');
    await updateEventsMod.handleUpdateSettingsClick(confirmBtn, {
      state,
      renderActiveHost: rerender,
      flashToast: (zh, en) => toasts.push(en),
      callRpc: mockRpc,
    });
    updateEventsMod.stopUpdateStatusPolling(state);

    // Exercise cross-restart polling directly with fast interval
    await new Promise((resolve) => {
      updateEventsMod.startUpdateStatusPolling(state, {
        renderActiveHost: () => {
          rerender();
          if (state.updateJob?.phase === 'succeeded') resolve();
        },
        flashToast: (zh, en) => toasts.push(en),
        callRpc: mockRpc,
        pollIntervalMs: 15,
        maxDisconnectTicks: 5,
      });
    });

    assert.equal(pollTick, 3);
    assert.equal(state.updateVersionInfo.local.version, '1.7.0');
    assert.equal(state.updateJob.phase, 'succeeded');
    assert.ok(root.textContent.includes('Updated to v1.7.0'));
    assert.ok(updateViewMod.renderUpdateCard(state, L).includes('AGY Studio v1.7.0'));
  } finally {
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete globalThis.window;
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    dom.window.close();
  }
});

test('security & packaging invariants: zero relative imports in update-worker, desktop-only RPC, and out of custom.js', () => {
  const workerSrc = fs.readFileSync(path.join(REPO, 'studio', 'daemon', 'update-worker.mjs'), 'utf8');
  const importMatches = workerSrc.match(/^\s*import\s+[^;]+;/gm) || [];
  for (const imp of importMatches) {
    assert.match(imp, /from\s+['"]node:[^'"]+['"]/, `update-worker.mjs must only import node: built-ins: ${imp}`);
  }

  // Must NOT be exposed to Remote Gateway / Remote RPC
  const remoteFiles = [
    path.join(REPO, 'remote', 'gateway', 'ws-server.mjs'),
    path.join(REPO, 'core', 'daemon', 'remote-bridge.mjs'),
    path.join(REPO, 'core', 'daemon', 'remote', 'settings-rpc.mjs'),
  ];
  for (const f of remoteFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const act of serviceMod.STUDIO_UPDATE_RPC_ACTIONS) {
      assert.equal(src.includes(act), false, `${path.relative(REPO, f)} must never expose ${act}`);
    }
  }

  // Must NOT be bundled into user/custom.js
  const customJs = fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  assert.equal(customJs.includes('update-worker.mjs'), false);
  assert.equal(customJs.includes('STUDIO_UPDATE_RPC_ACTIONS'), false);
});
