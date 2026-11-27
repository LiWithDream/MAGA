import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const realpathNative = fs.realpathSync.native || fs.realpathSync;

const {
  createRepoWorktreeCore,
  isAllowedLocalGovernanceFileRel,
  listRepoWorktreesPorcelainAsync,
  removeRepoWorktreeCore,
} = await import(
  pathToFileURL(path.join(REPO_ROOT, 'studio', 'plugin', 'maga-git-workflow', 'lib', 'worktree-core.mjs')).href
);

const { evaluateHookPayloadWithOptions } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'studio', 'plugin', 'maga-git-workflow', 'hooks', 'git-guard.mjs')).href
);

const {
  HOST_CONTRACTS,
  HOST_CONTRACT_TIERS,
  buildReadOnlyCdpContractProbeExpression,
  evaluateHostContractReport,
} = await import(pathToFileURL(path.join(REPO_ROOT, 'studio', 'host', 'contracts.mjs')).href);

const { inspectReadOnlyConversationSqlite, runHostContractProbe } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'studio', 'probe-host.mjs')).href
);

function git(cwd, args, extraEnv = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createTempRepo() {
  const dir = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-gov-wt-')));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  git(dir, ['config', 'user.name', 'MAGA Test']);
  git(dir, ['config', 'user.email', 'test@maga.local']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

test('worktree-core materializes untracked local governance as isolated copies, skips tracked/hooks, verifies SHA on clean, and blocks forged manifests', async () => {
  const repo = createTempRepo();
  const extDir = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-gov-ext-')));
  try {
    // Untracked local governance in primary checkout: AGENTS.md, ENV.md, symlinked GEMINI.md, .agents/skills, plus .agents/hooks (must NOT copy!)
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Local Governance\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'ENV.md'), 'CLUSTER_HOST=10.0.0.1\n', 'utf8');
    const sharedGemini = path.join(extDir, 'GEMINI.md');
    fs.writeFileSync(sharedGemini, '# Shared Research Constitution\n', 'utf8');
    if (process.platform !== 'win32') {
      fs.symlinkSync(sharedGemini, path.join(repo, 'GEMINI.md'));
    } else {
      fs.writeFileSync(path.join(repo, 'GEMINI.md'), '# Shared Research Constitution\n', 'utf8');
    }
    fs.mkdirSync(path.join(repo, '.agents', 'skills', 'demo-skill'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents', 'skills', 'demo-skill', 'SKILL.md'), '# Skill\n', 'utf8');
    fs.mkdirSync(path.join(repo, '.agents', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents', 'hooks.json'), '{"maga-git-guardrail":{}}\n', 'utf8');
    fs.writeFileSync(path.join(repo, '.agents', 'hooks', 'guard.mjs'), '// hook\n', 'utf8');
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '/AGENTS.md\n/ENV.md\n/GEMINI.md\n/.agents\n', 'utf8');

    const listed0 = await listRepoWorktreesPorcelainAsync(repo);
    const mainEntry = listed0.worktrees.find((w) => w.isMain);

    const created = await createRepoWorktreeCore(mainEntry, { branch: 'feat/gov-copy', commonDir: listed0.commonDir });
    assert.equal(created.ok, true);
    const wtPath = created.worktreePath;

    // 1. Governance files materialized as regular isolated files (zero symlinks -> zero write-through to main!)
    for (const rel of ['AGENTS.md', 'ENV.md', 'GEMINI.md', '.agents/skills/demo-skill/SKILL.md']) {
      const p = path.join(wtPath, ...rel.split('/'));
      const lst = fs.lstatSync(p);
      assert.equal(lst.isFile(), true, `${rel} must exist as regular file`);
      assert.equal(lst.isSymbolicLink(), false, `${rel} must NOT be a symlink`);
    }
    assert.equal(fs.existsSync(path.join(wtPath, '.agents', 'hooks.json')), false, '.agents/hooks.json must NOT be copied');
    assert.equal(fs.existsSync(path.join(wtPath, '.agents', 'hooks')), false, '.agents/hooks must NOT be copied');

    // Writing to <wt>/AGENTS.md does NOT mutate <main>/AGENTS.md
    fs.writeFileSync(path.join(wtPath, 'AGENTS.md'), '# Edited inside worktree\n', 'utf8');
    assert.equal(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), '# Local Governance\n');

    // git status inside worktree stays clean because exclude covers governance paths
    assert.equal(git(wtPath, ['status', '--porcelain']), '');

    // 2. Removing worktree while <wt>/AGENTS.md has unsaved modifications preserves it and refuses removal
    const listed1 = await listRepoWorktreesPorcelainAsync(repo);
    const failRm = await removeRepoWorktreeCore(mainEntry, listed1.worktrees, { worktreePath: wtPath });
    assert.equal(failRm.ok, false);
    assert.deepEqual(failRm.modifiedGovernanceFiles, ['AGENTS.md']);
    assert.equal(fs.existsSync(path.join(wtPath, '.agents', 'skills', 'demo-skill', 'SKILL.md')), true, 'unmodified files restored on failed remove');

    // 3. Forged manifest entries (`../README.md` or `.agents/hooks.json`) are rejected by allowlist
    assert.equal(isAllowedLocalGovernanceFileRel('../README.md'), false);
    assert.equal(isAllowedLocalGovernanceFileRel('README.md'), false);
    assert.equal(isAllowedLocalGovernanceFileRel('.agents/hooks.json'), false);
    assert.equal(isAllowedLocalGovernanceFileRel('.agents/rules/anchors.local.md'), true);

    // Restore original AGENTS.md content -> clean remove succeeds and deletes branch cleanly
    fs.writeFileSync(path.join(wtPath, 'AGENTS.md'), '# Local Governance\n', 'utf8');
    git(repo, ['merge', '--ff-only', 'feat/gov-copy']);
    const okRm = await removeRepoWorktreeCore(mainEntry, listed1.worktrees, {
      worktreePath: wtPath,
      deleteBranch: true,
    });
    assert.equal(okRm.ok, true);
    assert.equal(fs.existsSync(wtPath), false);

    // 4. Tracked AGENTS.md in Git is NEVER overwritten by local governance materializer
    git(repo, ['add', '-f', 'AGENTS.md']);
    git(repo, ['commit', '-m', 'track AGENTS.md']);
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Uncommitted local tweak\n', 'utf8');
    const createdTracked = await createRepoWorktreeCore(mainEntry, { branch: 'feat/tracked-agents', commonDir: listed0.commonDir });
    assert.equal(createdTracked.ok, true);
    assert.equal(
      fs.readFileSync(path.join(createdTracked.worktreePath, 'AGENTS.md'), 'utf8'),
      '# Local Governance\n',
      'tracked AGENTS.md comes from Git commit, not overwritten by dirty main file'
    );
    git(repo, ['checkout', '--', 'AGENTS.md']);
    const listed2 = await listRepoWorktreesPorcelainAsync(repo);
    const cleanTracked = await removeRepoWorktreeCore(mainEntry, listed2.worktrees, {
      worktreePath: createdTracked.worktreePath,
      deleteBranch: true,
    });
    assert.equal(cleanTracked.ok, true);
  } finally {
    fs.rmSync(`${repo}-wt`, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  }
});

test('git-guard blocks agent tampering with .agents/locks.json via file tools and shell redirects', () => {
  const repo = createTempRepo();
  const stateDir = realpathNative(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-locks-state-')));
  const pluginsDir = path.join(stateDir, 'plugins');
  try {
    fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents', 'locks.json'), '{"schema":1}\n', 'utf8');

    const editDeny = evaluateHookPayloadWithOptions(
      {
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'edit_file', args: { Path: path.join(repo, '.agents', 'locks.json') } },
      },
      { stateDir, pluginsDir }
    );
    assert.equal(editDeny.decision, 'deny');
    assert.match(editDeny.reason, /locks\.json/);

    const shellDeny = evaluateHookPayloadWithOptions(
      {
        hookEventName: 'PreToolUse',
        cwd: repo,
        toolCall: { name: 'run_command', args: { CommandLine: 'echo "{}" > .agents/locks.json' } },
      },
      { stateDir, pluginsDir }
    );
    assert.equal(shellDeny.decision, 'deny');
    assert.match(shellDeny.reason, /locks\.json/);

    // Inline and exported MAGA_ALLOW_LOCKS_EDIT=1 inside agent's own command MUST NOT self-authorize!
    for (const selfBypassCmd of [
      'MAGA_ALLOW_LOCKS_EDIT=1 echo "{}" > .agents/locks.json',
      'export MAGA_ALLOW_LOCKS_EDIT=1; echo "{}" > .agents/locks.json',
    ]) {
      const bypassAttempt = evaluateHookPayloadWithOptions(
        {
          hookEventName: 'PreToolUse',
          cwd: repo,
          toolCall: { name: 'run_command', args: { CommandLine: selfBypassCmd } },
        },
        { stateDir, pluginsDir }
      );
      assert.equal(bypassAttempt.decision, 'deny', `inline agent bypass must be denied: ${selfBypassCmd}`);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('studio/host/contracts.mjs & probe-host.mjs stay out of custom.js bundle and evaluate offline/mock-CDP/SQLite states cleanly', async () => {
  // 1. Registry schema & module path provenance
  assert.ok(HOST_CONTRACTS.length >= 10);
  for (const c of HOST_CONTRACTS) {
    assert.ok(HOST_CONTRACT_TIERS.includes(c.tier), `invalid tier on ${c.id}`);
    assert.ok(Array.isArray(c.modulePaths) && c.modulePaths.length >= 1, `missing modulePaths on ${c.id}`);
    for (const rel of c.modulePaths) {
      if (rel === 'studio/daemon/anchors-service.mjs') continue; // landing in Step 5
      assert.equal(fs.existsSync(path.join(REPO_ROOT, rel)), true, `contract ${c.id} references missing file ${rel}`);
    }
    if (c.tier === 'host_dispatch' || c.tier === 'hand_encoded_wire') {
      assert.equal(c.writePolicy, 'never_probed_live', `${c.id} must never execute live writes during probe`);
      assert.ok(c.precondition && c.postcondition);
    }
  }

  // 2. Must NOT be bundled into user/custom.js hot path
  const customJs = fs.readFileSync(path.join(REPO_ROOT, 'user', 'custom.js'), 'utf8');
  assert.equal(customJs.includes('HOST_CONTRACTS'), false, 'contracts registry must stay out of user/custom.js');

  // 3. Probe expression is strictly read-only
  const expr = buildReadOnlyCdpContractProbeExpression();
  assert.equal(/\bdispatch\s*\(|\bclick\s*\(|\bfetch\s*\(/.test(expr), false);

  // 4. SQLite read-only schema check + mock CDP evaluation
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
  } catch {}

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-probe-db-'));
  try {
    if (DatabaseSync) {
      const dbPath = path.join(tmpDir, '11111111-2222-3333-4444-555555555555.db');
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)');
      db.close();
      const sqOk = inspectReadOnlyConversationSqlite({ conversationsDir: tmpDir });
      assert.equal(sqOk.status, 'pass');
    }

    const fullPass = await runHostContractProbe({
      conversationsDir: tmpDir,
      detectAppFingerprintFn: () => ({ version: '2.35.2' }),
      evaluateFn: async () => ({
        ok: true,
        value: {
          hostVersion: '2.35.2',
          dom: {
            'dom.composer_input_box': true,
            'dom.conversation_list_sidebar': true,
            'dom.overview_panel_controls': true,
            'dom.aux_sidebar_toggle': true,
            'dom.sidebar_project_anchors': true,
          },
          fiber: { hasReactFiber: true, hasReduxStore: true },
        },
      }),
    });
    assert.equal(fullPass.ok, true);
    assert.equal(fullPass.status, 'verified');
    assert.equal(fullPass.hostVersion, '2.35.2');

    const degraded = evaluateHostContractReport({
      hostVersion: '2.36.0',
      cdpSnapshot: {
        dom: { 'dom.composer_input_box': true, 'dom.conversation_list_sidebar': false },
        fiber: { hasReactFiber: true, hasReduxStore: false },
      },
      sqliteReport: { status: 'pass' },
    });
    assert.equal(degraded.ok, true);
    assert.equal(degraded.status, 'degraded');

    const broken = evaluateHostContractReport({
      hostVersion: '2.36.0',
      cdpSnapshot: {
        dom: { 'dom.composer_input_box': false },
        fiber: { hasReactFiber: false, hasReduxStore: false },
      },
      sqliteReport: { status: 'pass' },
    });
    assert.equal(broken.ok, false);
    assert.equal(broken.status, 'broken');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
