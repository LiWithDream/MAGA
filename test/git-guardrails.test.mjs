import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PROTECTED_BRANCHES,
  evaluateHookPayload,
  extractGitInvocations,
  resolveGitContext,
  splitShellSegments,
  tokenizeSegment,
} from '../.githooks/guard-main-branch.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, '.githooks', 'guard-main-branch.mjs');
const GITHOOKS_DIR = path.join(REPO_ROOT, '.githooks');

function git(cwd, args, extraEnv = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitResult(cwd, args, extraEnv = {}) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

function createTempRepo(branch = 'main') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-guardrails-')));
  execFileSync('git', ['init', '-b', branch, dir], { stdio: 'ignore' });
  git(dir, ['config', 'user.name', 'MAGA Test']);
  git(dir, ['config', 'user.email', 'test@maga.local']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# temp repo\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

test('shell segment splitter and tokenizer handle quotes, escapes, and operators', () => {
  const segments = splitShellSegments('echo "a && b" ; cd ../wt && git -C sub commit -m \'msg;ok\' | cat');
  assert.deepEqual(segments, [
    'echo "a && b"',
    'cd ../wt',
    "git -C sub commit -m 'msg;ok'",
    'cat',
  ]);

  assert.deepEqual(tokenizeSegment(`git commit -m "hello \\"world\\"" 'x y'`), [
    'git',
    'commit',
    '-m',
    'hello "world"',
    'x y',
  ]);
});

test('extractGitInvocations tracks cd, -C, and env prefixes', () => {
  const invocations = extractGitInvocations(
    'cd ../wt && MAGA_ALLOW_MAIN_COMMIT=1 git -C nested commit -m "ok"',
    '/tmp/base/main'
  );
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].targetDir, path.resolve('/tmp/base/wt/nested'));
  assert.equal(invocations[0].subcommand, 'commit');
  assert.deepEqual(invocations[0].subArgs, ['-m', 'ok']);
  assert.equal(invocations[0].env.MAGA_ALLOW_MAIN_COMMIT, '1');
  assert.equal(PROTECTED_BRANCHES.has('main'), true);
});

test('SessionStart injects reminder on main and returns {} on feat branch', () => {
  const repo = createTempRepo('main');
  try {
    const mainRes = evaluateHookPayload({ hookEventName: 'SessionStart', cwd: repo });
    assert.ok(Array.isArray(mainRes.injectSteps) && mainRes.injectSteps.length === 1);
    assert.match(mainRes.injectSteps[0].systemMessage.systemMessage, /protected branch 'main'/);

    git(repo, ['checkout', '-b', 'feat/demo']);
    const featRes = evaluateHookPayload({ hookEventName: 'SessionStart', cwd: repo });
    assert.deepEqual(featRes, {});

    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-nongit-')));
    try {
      assert.deepEqual(evaluateHookPayload({ hookEventName: 'SessionStart', cwd: outside }), {});
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('PreToolUse file edits are blocked on main and allowed in branches, worktrees, artifacts, and merges', () => {
  const repo = createTempRepo('main');
  const wtParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wt-')));
  const wtDir = path.join(wtParent, 'feat-wt');
  const artifactDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-artifacts-')));

  try {
    // 1. Denied on main for edit_file & write_file (including non-existent nested subdir)
    const editMain = evaluateHookPayload({
      hookEventName: 'PreToolUse',
      cwd: repo,
      artifactDirectoryPath: artifactDir,
      toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'README.md') } },
    });
    assert.equal(editMain.decision, 'deny');
    assert.match(editMain.reason, /protected branch 'main'/);

    const writeNestedMain = evaluateHookPayload({
      hookEventName: 'PreToolUse',
      cwd: repo,
      artifactDirectoryPath: artifactDir,
      toolCall: { name: 'write_file', args: { Path: 'nested/deep/new-file.mjs' } },
    });
    assert.equal(writeNestedMain.decision, 'deny');

    // 2. Allowed in artifactDirectoryPath even when cwd is main
    const artifactEdit = evaluateHookPayload({
      hookEventName: 'PreToolUse',
      cwd: repo,
      artifactDirectoryPath: artifactDir,
      toolCall: { name: 'write_file', args: { Path: path.join(artifactDir, 'notes', 'plan.md') } },
    });
    assert.deepEqual(artifactEdit, { decision: 'allow' });

    // 3. Allowed inside sibling worktree on feat/wt even when cwd is main
    git(repo, ['worktree', 'add', '-b', 'feat/wt', wtDir, 'main']);
    const wtEdit = evaluateHookPayload({
      hookEventName: 'PreToolUse',
      cwd: repo,
      artifactDirectoryPath: artifactDir,
      toolCall: { name: 'edit_file', args: { Path: path.join(wtDir, 'README.md') } },
    });
    assert.deepEqual(wtEdit, { decision: 'allow' });

    // 4. Allowed when repo itself is on feat/demo
    git(repo, ['checkout', '-b', 'feat/demo']);
    const featEdit = evaluateHookPayload({
      hookEventName: 'PreToolUse',
      cwd: repo,
      toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'README.md') } },
    });
    assert.deepEqual(featEdit, { decision: 'allow' });

    // 5. Allowed on main when MERGE_HEAD exists (merge conflict resolution)
    git(repo, ['checkout', 'main']);
    const ctx = resolveGitContext(repo);
    assert.equal(ctx.branch, 'main');
    assert.equal(ctx.merging, false);
    fs.writeFileSync(path.join(ctx.gitDir, 'MERGE_HEAD'), `${git(repo, ['rev-parse', 'HEAD'])}\n`, 'utf8');
    try {
      const mergeEdit = evaluateHookPayload({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'README.md') } },
      });
      assert.deepEqual(mergeEdit, { decision: 'allow' });
    } finally {
      fs.rmSync(path.join(ctx.gitDir, 'MERGE_HEAD'), { force: true });
    }
  } finally {
    gitResult(repo, ['worktree', 'remove', '--force', wtDir]);
    fs.rmSync(wtParent, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('PreToolUse run_command enforces commit, force-push, and --tags guardrails', () => {
  const repo = createTempRepo('main');
  const wtParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wt-cmd-')));
  const wtDir = path.join(wtParent, 'feat-cmd');

  try {
    git(repo, ['worktree', 'add', '-b', 'feat/cmd', wtDir, 'main']);

    // Denied commits on main
    for (const cmd of ['git commit -m "x"', 'git commit --amend --no-edit']) {
      const res = evaluateHookPayload({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'run_command', args: { CommandLine: cmd } },
      });
      assert.equal(res.decision, 'deny', `expected deny for: ${cmd}`);
    }

    // Allowed commits in feature worktree from main cwd
    for (const cmd of [`git -C ${wtDir} commit -m "x"`, `cd ${wtDir} && git commit -m "x"`]) {
      const res = evaluateHookPayload({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'run_command', args: { CommandLine: cmd } },
      });
      assert.deepEqual(res, { decision: 'allow' }, `expected allow for: ${cmd}`);
    }

    // Allowed commit on main with MAGA_ALLOW_MAIN_COMMIT=1 or MERGE_HEAD
    assert.deepEqual(
      evaluateHookPayload({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'run_command', args: { CommandLine: 'MAGA_ALLOW_MAIN_COMMIT=1 git commit -m "hotfix"' } },
      }),
      { decision: 'allow' }
    );

    const ctx = resolveGitContext(repo);
    fs.writeFileSync(path.join(ctx.gitDir, 'MERGE_HEAD'), `${git(repo, ['rev-parse', 'HEAD'])}\n`, 'utf8');
    try {
      assert.deepEqual(
        evaluateHookPayload({
          hookEventName: 'PreToolUse',
          cwd: repo,
          toolCall: { name: 'run_command', args: { CommandLine: 'git commit -m "merge"' } },
        }),
        { decision: 'allow' }
      );
    } finally {
      fs.rmSync(path.join(ctx.gitDir, 'MERGE_HEAD'), { force: true });
    }

    // Safe non-commit commands on main allowed
    for (const cmd of ['git checkout -b fix/x', 'git merge --no-ff feat/x', 'npm test', 'echo "git commit"']) {
      assert.deepEqual(
        evaluateHookPayload({
          hookEventName: 'PreToolUse',
          cwd: repo,
          toolCall: { name: 'run_command', args: { CommandLine: cmd } },
        }),
        { decision: 'allow' },
        `expected allow for: ${cmd}`
      );
    }

    // Force-push to main blocked
    for (const cmd of ['git push --force origin main', 'git push -f', 'git push origin +HEAD:main']) {
      const res = evaluateHookPayload({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'run_command', args: { CommandLine: cmd } },
      });
      assert.equal(res.decision, 'deny', `expected deny for: ${cmd}`);
    }

    // --tags blocked on any branch; explicit tag allowed
    for (const dir of [repo, wtDir]) {
      const res = evaluateHookPayload({
        hookEventName: 'PreToolUse',
        cwd: dir,
        toolCall: { name: 'run_command', args: { CommandLine: 'git push --tags origin' } },
      });
      assert.equal(res.decision, 'deny');
    }
    assert.deepEqual(
      evaluateHookPayload({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'run_command', args: { CommandLine: 'git push origin v1.2.0' } },
      }),
      { decision: 'allow' }
    );
  } finally {
    gitResult(repo, ['worktree', 'remove', '--force', wtDir]);
    fs.rmSync(wtParent, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI subprocess reads stdin JSON and outputs expected decision JSON', () => {
  const repo = createTempRepo('main');
  try {
    const denyOut = execFileSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'README.md') } },
      }),
      encoding: 'utf8',
    });
    const denyJson = JSON.parse(denyOut);
    assert.equal(denyJson.decision, 'deny');

    const runAllowOut = execFileSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
      }),
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(runAllowOut), { decision: 'allow' });

    git(repo, ['checkout', '-b', 'feat/subproc']);
    const allowOut = execFileSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'README.md') } },
      }),
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(allowOut), { decision: 'allow' });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('Git .githooks pre-commit and pre-push enforce branch, merge, force-push, and tag policies', () => {
  const bareOrigin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-origin-')));
  const repo = createTempRepo('main');

  try {
    execFileSync('git', ['init', '--bare', '-b', 'main', bareOrigin], { stdio: 'ignore' });
    git(repo, ['remote', 'add', 'origin', bareOrigin]);
    git(repo, ['push', '-u', 'origin', 'main']);

    // Activate tracked hooks for this isolated test repo
    git(repo, ['config', 'core.hooksPath', GITHOOKS_DIR]);

    // 1. Direct commit on main rejected
    fs.writeFileSync(path.join(repo, 'README.md'), '# direct edit\n', 'utf8');
    git(repo, ['add', 'README.md']);
    const blockedCommit = gitResult(repo, ['commit', '-m', 'direct on main']);
    assert.notEqual(blockedCommit.status, 0);
    assert.match(blockedCommit.stderr, /MAGA pre-commit/);

    // 2. Override with MAGA_ALLOW_MAIN_COMMIT=1 succeeds
    const overrideCommit = gitResult(repo, ['commit', '-m', 'override on main'], {
      MAGA_ALLOW_MAIN_COMMIT: '1',
    });
    assert.equal(overrideCommit.status, 0, overrideCommit.stderr);

    // 3. Normal fast-forward push to main succeeds
    const ffPush = gitResult(repo, ['push', 'origin', 'main']);
    assert.equal(ffPush.status, 0, ffPush.stderr);

    // 4. Feature branch commit & --no-ff merge into main succeed (including MERGE_HEAD commit)
    git(repo, ['checkout', '-b', 'feat/demo']);
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'feat\n', 'utf8');
    git(repo, ['add', 'feature.txt']);
    const featCommit = gitResult(repo, ['commit', '-m', 'feat demo']);
    assert.equal(featCommit.status, 0, featCommit.stderr);

    git(repo, ['checkout', 'main']);
    const mergeNoCommit = gitResult(repo, ['merge', '--no-ff', '--no-commit', 'feat/demo']);
    assert.equal(mergeNoCommit.status, 0, mergeNoCommit.stderr);
    const mergeCommit = gitResult(repo, ['commit', '-m', 'merge feat/demo']);
    assert.equal(mergeCommit.status, 0, mergeCommit.stderr);
    git(repo, ['push', 'origin', 'main']);

    // 5. Force-push (non-fast-forward) to main rejected
    git(repo, ['reset', '--hard', 'HEAD~1']);
    fs.writeFileSync(path.join(repo, 'diverge.txt'), 'diverged\n', 'utf8');
    git(repo, ['add', 'diverge.txt']);
    git(repo, ['commit', '-m', 'diverged'], { MAGA_ALLOW_MAIN_COMMIT: '1' });
    const forcePush = gitResult(repo, ['push', '--force', 'origin', 'main']);
    assert.notEqual(forcePush.status, 0);
    assert.match(forcePush.stderr, /Non-fast-forward/);

    // Deleting main blocked
    const deletePush = gitResult(repo, ['push', 'origin', ':main']);
    assert.notEqual(deletePush.status, 0);
    assert.match(deletePush.stderr, /Deleting protected branch/);

    // Re-sync main with origin before tag checks
    git(repo, ['reset', '--hard', 'origin/main']);

    // 6. Bulk tag push (>=3 tags) rejected; single release tag succeeds
    git(repo, ['tag', 'v2.1.0']);
    git(repo, ['tag', 'v2.2.0']);
    git(repo, ['tag', 'v2.3.0']);
    const bulkTagsPush = gitResult(repo, ['push', '--tags', 'origin']);
    assert.notEqual(bulkTagsPush.status, 0);
    assert.match(bulkTagsPush.stderr, /tags at once is blocked/);

    git(repo, ['tag', '-a', 'v1.2.0', '-m', 'Release v1.2.0']);
    const singleTagPush = gitResult(repo, ['push', 'origin', 'v1.2.0']);
    assert.equal(singleTagPush.status, 0, singleTagPush.stderr);
  } finally {
    fs.rmSync(bareOrigin, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('repository guardrail scripts, permissions, package script, and .gitignore are properly configured', () => {
  for (const name of ['guard-main-branch.mjs', 'pre-commit', 'pre-push']) {
    const filePath = path.join(GITHOOKS_DIR, name);
    assert.equal(fs.existsSync(filePath), true, `${name} must exist in .githooks/`);
    assert.notEqual(fs.statSync(filePath).mode & 0o111, 0, `${name} must be executable`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(typeof pkg.scripts['setup:hooks'], 'string');
  assert.match(pkg.scripts['setup:hooks'], /core\.hooksPath\s+\.githooks/);

  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^node_modules$/m);
});
