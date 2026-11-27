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
  recordConversationWorktree,
  resolveGitContext,
  splitShellSegments,
  tokenizeSegment,
} from '../.githooks/guard-main-branch.mjs';
import { checkStaleMerge } from '../.githooks/guard-stale-merge.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const realpathNative = fs.realpathSync.native || fs.realpathSync;
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
  const dir = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-guardrails-')));
  execFileSync('git', ['init', '-b', branch, dir], { stdio: 'ignore' });
  git(dir, ['config', 'user.name', 'MAGA Test']);
  git(dir, ['config', 'user.email', 'test@maga.local']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# temp repo\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

test('shell segment splitter and tokenizer handle quotes, escapes, and operators', () => {
  const segments = splitShellSegments('echo "a && b" ; cd ../wt && git -C sub commit -m \'msg;ok\' | cat', 'darwin');
  assert.deepEqual(segments, [
    'echo "a && b"',
    'cd ../wt',
    "git -C sub commit -m 'msg;ok'",
    'cat',
  ]);

  assert.deepEqual(tokenizeSegment(`git commit -m "hello \\"world\\"" 'x y'`, null, 'darwin'), [
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

test('SessionStart enforces Worktree-Only policy on primary checkout and stays quiet inside linked worktrees', () => {
  const repo = createTempRepo('main');
  const wtParent = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wt-ss-')));
  const wtDir = path.join(wtParent, 'feat-ss');
  try {
    const mainRes = evaluateHookPayload({ hookEventName: 'SessionStart', cwd: repo });
    assert.ok(Array.isArray(mainRes.injectSteps) && mainRes.injectSteps.length === 1);
    assert.match(mainRes.injectSteps[0].systemMessage.systemMessage, /protected branch 'main'/);
    assert.match(mainRes.injectSteps[0].systemMessage.systemMessage, /wt:new/);

    // Primary checkout drifted onto feat/demo STILL injects Worktree Policy warning
    git(repo, ['checkout', '-b', 'feat/demo']);
    const driftedRes = evaluateHookPayload({ hookEventName: 'SessionStart', cwd: repo });
    assert.ok(Array.isArray(driftedRes.injectSteps) && driftedRes.injectSteps.length === 1);
    assert.match(driftedRes.injectSteps[0].systemMessage.systemMessage, /drifted onto 'feat\/demo'/);

    // Linked worktree on a feature branch returns {}
    git(repo, ['checkout', 'main']);
    git(repo, ['worktree', 'add', '-b', 'feat/ss', wtDir, 'main']);
    const wtRes = evaluateHookPayload({ hookEventName: 'SessionStart', cwd: wtDir });
    assert.deepEqual(wtRes, {});

    const outside = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-nongit-')));
    try {
      assert.deepEqual(evaluateHookPayload({ hookEventName: 'SessionStart', cwd: outside }), {});
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    gitResult(repo, ['worktree', 'remove', '--force', wtDir]);
    fs.rmSync(wtParent, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('PreToolUse file edits are blocked in primary checkout (even on feat branch) and allowed in linked worktrees, local-only rules, artifacts, and merges', () => {
  const repo = createTempRepo('main');
  const wtParent = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wt-')));
  const wtDir = path.join(wtParent, 'feat-wt');
  const artifactDir = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-artifacts-')));

  try {
    // 1. Denied in primary checkout on main for edit_file & write_file (including non-existent nested subdir)
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

    // 2. Allowed in artifactDirectoryPath and local-only excluded files (AGENTS.md, .agents/**) on primary checkout
    const artifactEdit = evaluateHookPayload({
      hookEventName: 'PreToolUse',
      cwd: repo,
      artifactDirectoryPath: artifactDir,
      toolCall: { name: 'write_file', args: { Path: path.join(artifactDir, 'notes', 'plan.md') } },
    });
    assert.deepEqual(artifactEdit, { decision: 'allow' });

    for (const localPath of [
      path.join(repo, 'AGENTS.md'),
      path.join(repo, 'docs', 'DEVELOPMENT_HISTORY.md'),
      path.join(repo, '.agents', 'skills', 'demo', 'SKILL.md'),
    ]) {
      assert.deepEqual(
        evaluateHookPayload({
          hookEventName: 'PreToolUse',
          cwd: repo,
          toolCall: { name: 'edit_file', args: { Path: localPath } },
        }),
        { decision: 'allow' },
        `expected allow for local-only path: ${localPath}`
      );
    }

    // Anti-tamper rule (Option A): .agents/hooks.json and .agents/hooks/** are DENIED in enforced repos
    for (const tamperedHookPath of [
      path.join(repo, '.agents', 'hooks.json'),
      path.join(repo, '.agents', 'hooks', 'guard-main-branch.mjs'),
    ]) {
      const tamperRes = evaluateHookPayload({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'edit_file', args: { Path: tamperedHookPath } },
      });
      assert.equal(tamperRes.decision, 'deny', `expected deny for hook tamper path: ${tamperedHookPath}`);
    }

    // 3. Allowed inside sibling worktree on feat/wt even when cwd is main
    git(repo, ['worktree', 'add', '-b', 'feat/wt', wtDir, 'main']);
    const wtEdit = evaluateHookPayload({
      hookEventName: 'PreToolUse',
      cwd: repo,
      artifactDirectoryPath: artifactDir,
      toolCall: { name: 'edit_file', args: { Path: path.join(wtDir, 'README.md') } },
    });
    assert.deepEqual(wtEdit, { decision: 'allow' });

    // 4. Primary checkout STILL blocks repo edits even if drifted onto feat/demo (Worktree-Only Policy)
    git(repo, ['checkout', '-b', 'feat/demo']);
    const featPrimaryEdit = evaluateHookPayload({
      hookEventName: 'PreToolUse',
      cwd: repo,
      toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'README.md') } },
    });
    assert.equal(featPrimaryEdit.decision, 'deny');
    assert.match(featPrimaryEdit.reason, /Worktree Policy/);

    // 5. Allowed on main when MERGE_HEAD exists (merge conflict resolution)
    git(repo, ['checkout', 'main']);
    const ctx = resolveGitContext(repo);
    assert.equal(ctx.branch, 'main');
    assert.equal(ctx.merging, false);
    assert.equal(ctx.isLinkedWorktree, false);
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
  const wtParent = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wt-cmd-')));
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

    // Denied branch creation / switching in primary checkout (Worktree-Only Policy)
    for (const cmd of [
      'git checkout -b fix/x',
      'git switch -c feat/x',
      'git checkout feat/cmd',
      'git switch feat/cmd',
      'git switch --track origin/feat/cmd',
      'git switch -t origin/feat/cmd',
      'git switch -',
      'git checkout -',
    ]) {
      const res = evaluateHookPayload({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'run_command', args: { CommandLine: cmd } },
      });
      assert.equal(res.decision, 'deny', `expected primary checkout branch-switch deny for: ${cmd}`);
    }

    // Safe non-commit commands and explicit main/restore/worktree commands on primary checkout allowed
    for (const cmd of [
      'git checkout main',
      'git switch main',
      'git checkout -- README.md',
      'git checkout HEAD -- README.md',
      'git checkout .',
      `git -C ${wtDir} checkout -b fix/inside-wt`,
      'git worktree add -b fix/x ../wt-x main',
      'MAGA_ALLOW_PRIMARY_CHECKOUT=1 git checkout -b temp/hotfix',
      'git merge --no-ff feat/x',
      'npm test',
      'echo "git commit"',
    ]) {
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
  const wtParent = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wt-sub-')));
  const wtDir = path.join(wtParent, 'feat-subproc');
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

    // Even if primary checkout drifted onto a feature branch, edits inside primary checkout are denied
    git(repo, ['checkout', '-b', 'feat/subproc-primary']);
    const primaryFeatDeny = execFileSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'README.md') } },
      }),
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(primaryFeatDeny).decision, 'deny');

    // Inside linked worktree, edit_file is allowed
    git(repo, ['checkout', 'main']);
    git(repo, ['worktree', 'add', '-b', 'feat/subproc-wt', wtDir, 'main']);
    const allowOut = execFileSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'edit_file', args: { Path: path.join(wtDir, 'README.md') } },
      }),
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(allowOut), { decision: 'allow' });
  } finally {
    gitResult(repo, ['worktree', 'remove', '--force', wtDir]);
    fs.rmSync(wtParent, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('Git .githooks pre-commit and pre-push enforce branch, merge, force-push, and tag policies', () => {
  const bareOrigin = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-origin-')));
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
  for (const name of ['guard-main-branch.mjs', 'guard-stale-merge.mjs', 'pre-commit', 'pre-merge-commit', 'pre-push']) {
    const filePath = path.join(GITHOOKS_DIR, name);
    assert.equal(fs.existsSync(filePath), true, `${name} must exist in .githooks/`);
    if (process.platform !== 'win32') {
      assert.notEqual(fs.statSync(filePath).mode & 0o111, 0, `${name} must be executable`);
    }
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(typeof pkg.scripts['setup:hooks'], 'string');
  assert.match(pkg.scripts['setup:hooks'], /(?:core\.hooksPath\s+\.githooks|studio\/setup-hooks\.mjs)/);
  if (pkg.scripts['setup:hooks'].includes('setup-hooks.mjs')) {
    const setupScript = fs.readFileSync(path.join(REPO_ROOT, 'studio', 'setup-hooks.mjs'), 'utf8');
    assert.match(setupScript, /'core\.hooksPath',\s*'\.githooks'/);
  }

  const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^node_modules$/m);
});

test('PreToolUse hook expands $VAR/${VAR} safely across standalone assignments, quotes, prefix env, pipelines, and records worktrees', () => {
  const mainRepo = createTempRepo('main');
  const wtParent = `${mainRepo}-wt`;
  const wtDir = path.join(wtParent, 'feat-vars');
  const fakeHome = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-hook-home-')));
  const stateDir = path.join(fakeHome, '.gemini', 'antigravity', 'anti-claude');

  try {
    fs.mkdirSync(wtParent, { recursive: true });
    git(mainRepo, ['worktree', 'add', '-b', 'feat/vars', '--', wtDir, 'main']);

    // 1. Standalone $VAR & ${VAR} expansion into protected main denies git commit
    const denyVar = evaluateHookPayload({
      hookEventName: 'PreToolUse',
      cwd: wtDir,
      toolCall: {
        name: 'run_command',
        args: { CommandLine: `REPO=${mainRepo}; cd "$REPO" && git commit -m "blocked"` },
      },
    });
    assert.equal(denyVar.decision, 'deny');

    const denyBrace = evaluateHookPayload({
      hookEventName: 'PreToolUse',
      cwd: wtDir,
      toolCall: {
        name: 'run_command',
        args: { CommandLine: `export REPO=${mainRepo}; git -C "\${REPO}" commit -m "blocked"` },
      },
    });
    assert.equal(denyBrace.decision, 'deny');

    // 2. Prefix env assignment expands earlier $VAR cleanly without polluting current shellVars
    const denyPrefix = evaluateHookPayload({
      hookEventName: 'PreToolUse',
      cwd: wtDir,
      toolCall: {
        name: 'run_command',
        args: { CommandLine: `REPO=${mainRepo}; FOO=bar git -C "$REPO" commit -m "blocked"` },
      },
    });
    assert.equal(denyPrefix.decision, 'deny');

    // 3. Single quotes do NOT expand $REPO (stays literal in wtDir)
    const singleQuoteTokens = tokenizeSegment(`git -C '$REPO' status`, new Map([['REPO', mainRepo]]));
    assert.deepEqual(singleQuoteTokens, ['git', '-C', '$REPO', 'status']);

    const singleQuoteInv = extractGitInvocations(
      `REPO=${mainRepo}; git -C '$REPO' status && git status`,
      wtDir
    );
    assert.equal(singleQuoteInv.length, 2);
    assert.equal(singleQuoteInv[0].targetDir, path.join(wtDir, '$REPO'));
    assert.equal(singleQuoteInv[1].targetDir, wtDir);

    // 4. Pipeline segment isolation: assignment/cd inside pipeline does not leak to outer cwd
    const pipeInv = extractGitInvocations(
      `WT=${mainRepo} | echo ok; echo ok | cd "${mainRepo}" && git status`,
      wtDir
    );
    assert.equal(pipeInv.length, 1);
    assert.equal(pipeInv[0].targetDir, wtDir);

    // 5. Unknown variable leaves literal token safely
    const unknownTokens = tokenizeSegment(`echo $UNSET_VAR "\${ALSO_UNSET}"`, new Map([['OTHER', '1']]));
    assert.deepEqual(unknownTokens, ['echo', '$UNSET_VAR', '${ALSO_UNSET}']);

    // 6. recordConversationWorktree unit tests: direct cid, artifactDirectoryPath fallback, 30s throttle, protected & invalid skips
    const cidA = 'conv-wt-aaaa1111';
    const wtCtx = resolveGitContext(wtDir);
    assert.ok(wtCtx && wtCtx.branch === 'feat/vars');

    const rec1 = recordConversationWorktree({ conversationId: cidA }, wtCtx, { stateDir });
    assert.equal(rec1.recorded, true);
    const saved1 = JSON.parse(fs.readFileSync(rec1.filePath, 'utf8'));
    assert.equal(saved1.cid, cidA);
    assert.equal(saved1.branch, 'feat/vars');
    assert.equal(saved1.worktreePath, wtDir);
    assert.equal(saved1.repoRoot, mainRepo);
    assert.equal(saved1.source, 'hook');

    // Immediate second call with identical worktree + branch throttled
    const recThrottled = recordConversationWorktree({ conversationId: cidA }, wtCtx, { stateDir });
    assert.equal(recThrottled.recorded, false);
    assert.equal(recThrottled.reason, 'throttled');

    // Expiring mtime > 30s allows re-recording
    const oldDate = new Date(Date.now() - 35_000);
    fs.utimesSync(rec1.filePath, oldDate, oldDate);
    const recAfterExpire = recordConversationWorktree({ conversationId: cidA }, wtCtx, { stateDir });
    assert.equal(recAfterExpire.recorded, true);

    // Fallback to basename(artifactDirectoryPath) when conversationId is omitted
    const cidB = '11112222-3333-4444-8555-666677778888';
    const recFallback = recordConversationWorktree(
      { artifactDirectoryPath: `/tmp/brain/${cidB}` },
      wtCtx,
      { stateDir }
    );
    assert.equal(recFallback.recorded, true);
    assert.equal(recFallback.record.cid, cidB);

    // Skips protected branches, drifted primary checkout (non-linked), and missing/invalid cid
    const mainCtx = resolveGitContext(mainRepo);
    assert.equal(recordConversationWorktree({ conversationId: cidA }, mainCtx, { stateDir }).reason, 'not_worktree');
    git(mainRepo, ['checkout', '-b', 'feat/drifted-primary']);
    const driftedPrimaryCtx = resolveGitContext(mainRepo);
    assert.equal(driftedPrimaryCtx.isLinkedWorktree, false);
    assert.equal(
      recordConversationWorktree({ conversationId: cidA }, driftedPrimaryCtx, { stateDir }).reason,
      'not_linked_worktree'
    );
    git(mainRepo, ['checkout', 'main']);
    assert.equal(recordConversationWorktree({ conversationId: '../bad' }, wtCtx, { stateDir }).reason, 'missing_cid');

    // Read-only `git -C <wtDir> status` executed from primary checkout does NOT hijack or create attribution
    const roCid = 'readonly-inspect-55667788';
    const roOut = execFileSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: roCid,
        cwd: mainRepo,
        toolCall: { name: 'run_command', args: { CommandLine: `git -C "${wtDir}" status` } },
      }),
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
      },
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(roOut), { decision: 'allow' });
    assert.equal(
      fs.existsSync(path.join(stateDir, 'conv-worktrees', `${roCid}.json`)),
      false,
      'read-only git -C inspection from primary checkout does not hijack conv-worktrees attribution'
    );

    // 7. Subprocess execution records worktree when running allowed command inside worktree
    const subCid = 'subproc-conv-99887766';
    const subOut = execFileSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: subCid,
        cwd: mainRepo,
        toolCall: {
          name: 'run_command',
          args: { CommandLine: `WT=${wtDir}; cd "$WT" && git status` },
        },
      }),
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
      },
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(subOut), { decision: 'allow' });
    const subFile = path.join(stateDir, 'conv-worktrees', `${subCid}.json`);
    assert.equal(fs.existsSync(subFile), true, 'subprocess hook writes conv-worktrees/<cid>.json');
    const subSaved = JSON.parse(fs.readFileSync(subFile, 'utf8'));
    assert.equal(subSaved.branch, 'feat/vars');
    assert.equal(subSaved.worktreePath, wtDir);
    assert.equal(subSaved.repoRoot, mainRepo);
  } finally {
    fs.rmSync(wtParent, { recursive: true, force: true });
    fs.rmSync(mainRepo, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('guard-stale-merge blocks stale or diverged origin refs while allowing synced, ahead, local-only, and overridden merges', () => {
  const bareOrigin = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-stale-origin-')));
  const devA = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-stale-deva-')));
  const devB = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-stale-devb-')));

  const setupClone = (dir) => {
    git(dir, ['config', 'user.name', 'MAGA Test']);
    git(dir, ['config', 'user.email', 'test@maga.local']);
    git(dir, ['config', 'core.hooksPath', GITHOOKS_DIR]);
  };

  try {
    execFileSync('git', ['init', '--bare', '-b', 'main', bareOrigin], { stdio: 'ignore' });
    execFileSync('git', ['clone', bareOrigin, devA], { stdio: 'ignore' });
    setupClone(devA);
    git(devA, ['checkout', '-B', 'main']);
    fs.writeFileSync(path.join(devA, 'README.md'), '# origin\n', 'utf8');
    git(devA, ['add', 'README.md']);
    git(devA, ['commit', '-m', 'init main'], { MAGA_ALLOW_MAIN_COMMIT: '1' });
    git(devA, ['push', '-u', 'origin', 'main']);

    // devA pushes feat/shared v1
    git(devA, ['checkout', '-b', 'feat/shared']);
    fs.writeFileSync(path.join(devA, 'shared.txt'), 'v1\n', 'utf8');
    git(devA, ['add', 'shared.txt']);
    git(devA, ['commit', '-m', 'shared v1']);
    git(devA, ['push', '-u', 'origin', 'feat/shared']);

    // devB clones and tracks feat/shared at v1
    execFileSync('git', ['clone', bareOrigin, devB], { stdio: 'ignore' });
    setupClone(devB);
    git(devB, ['checkout', '-b', 'feat/shared', 'origin/feat/shared']);
    git(devB, ['checkout', 'main']);

    // 3. Local branch matches remote -> ALLOWED
    const syncedMerge = gitResult(devB, ['merge', '--no-ff', '-m', 'merge synced feat/shared', 'feat/shared']);
    assert.equal(syncedMerge.status, 0, syncedMerge.stderr);
    git(devB, ['reset', '--hard', 'origin/main']);

    // devA pushes v2 to origin/feat/shared while devB remains stale at v1
    fs.writeFileSync(path.join(devA, 'shared.txt'), 'v1\nv2\n', 'utf8');
    git(devA, ['add', 'shared.txt']);
    git(devA, ['commit', '-m', 'shared v2']);
    git(devA, ['push', 'origin', 'feat/shared']);

    // 1. Remote branch ahead & unfetched locally -> BLOCKED (pre-merge-commit & pre-commit w/ MERGE_HEAD)
    const staleMerge = gitResult(devB, ['merge', '--no-ff', '-m', 'merge stale feat/shared', 'feat/shared']);
    assert.notEqual(staleMerge.status, 0);
    assert.match(staleMerge.stderr, /Blocked stale merge/);
    assert.match(staleMerge.stderr, /feat\/shared/);

    const directUnitBlock = checkStaleMerge({ cwd: devB });
    assert.equal(directUnitBlock.allowed, false);
    assert.equal(directUnitBlock.reason, 'stale_merge');

    const staleCommitRetry = gitResult(devB, ['commit', '-m', 'commit stale merge']);
    assert.notEqual(staleCommitRetry.status, 0);
    assert.match(staleCommitRetry.stderr, /Blocked stale merge/);

    // 6. MAGA_ALLOW_STALE_MERGE=1 override -> ALLOWED
    const overrideMergeCommit = gitResult(devB, ['commit', '-m', 'override stale merge'], {
      MAGA_ALLOW_STALE_MERGE: '1',
    });
    assert.equal(overrideMergeCommit.status, 0, overrideMergeCommit.stderr);
    git(devB, ['reset', '--hard', 'origin/main']);

    // 2. Remote branch diverged -> BLOCKED
    git(devB, ['checkout', 'feat/shared']);
    fs.writeFileSync(path.join(devB, 'diverged.txt'), 'div\n', 'utf8');
    git(devB, ['add', 'diverged.txt']);
    git(devB, ['commit', '-m', 'diverged local commit']);
    git(devB, ['checkout', 'main']);

    const divergedMerge = gitResult(devB, ['merge', '--no-ff', '-m', 'merge diverged', 'feat/shared']);
    assert.notEqual(divergedMerge.status, 0);
    assert.match(divergedMerge.stderr, /Blocked stale merge/);
    git(devB, ['merge', '--abort']);

    // 4. Local branch strictly ahead of remote -> ALLOWED
    git(devB, ['fetch', 'origin']);
    git(devB, ['checkout', 'feat/shared']);
    git(devB, ['reset', '--hard', 'origin/feat/shared']);
    fs.writeFileSync(path.join(devB, 'ahead.txt'), 'v3\n', 'utf8');
    git(devB, ['add', 'ahead.txt']);
    git(devB, ['commit', '-m', 'shared v3 ahead']);
    git(devB, ['checkout', 'main']);

    const aheadMerge = gitResult(devB, ['merge', '--no-ff', '-m', 'merge ahead feat/shared', 'feat/shared']);
    assert.equal(aheadMerge.status, 0, aheadMerge.stderr);
    git(devB, ['reset', '--hard', 'origin/main']);

    // 5. Local-only branch absent from origin -> ALLOWED
    git(devB, ['checkout', '-b', 'feat/local-only']);
    fs.writeFileSync(path.join(devB, 'local.txt'), 'local\n', 'utf8');
    git(devB, ['add', 'local.txt']);
    git(devB, ['commit', '-m', 'local only commit']);
    git(devB, ['checkout', 'main']);

    const localOnlyMerge = gitResult(devB, ['merge', '--no-ff', '-m', 'merge local-only', 'feat/local-only']);
    assert.equal(localOnlyMerge.status, 0, localOnlyMerge.stderr);
  } finally {
    fs.rmSync(bareOrigin, { recursive: true, force: true });
    fs.rmSync(devA, { recursive: true, force: true });
    fs.rmSync(devB, { recursive: true, force: true });
  }
});
