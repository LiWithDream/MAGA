import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const GLOBAL_GUARD_SCRIPT = path.join(REPO_ROOT, 'studio', 'plugin', 'maga-git-workflow', 'hooks', 'git-guard.mjs');
const WT_UNIVERSAL_CLI = path.join(REPO_ROOT, 'studio', 'plugin', 'maga-git-workflow', 'bin', 'wt.mjs');

const {
  evaluateHookPayloadWithOptions,
  hasValidLocalGuardrail,
  recordGuardDenyEvent,
  resolveGitContext,
} = await import(pathToFileURL(GLOBAL_GUARD_SCRIPT).href);

const {
  normalizePolicyKey,
} = await import(pathToFileURL(path.join(REPO_ROOT, 'studio', 'plugin', 'maga-git-workflow', 'lib', 'worktree-core.mjs')).href);

const {
  handleGitWorkflowRpc,
  isGitWorkflowPluginInstalled,
  loadGitWorkflowPolicy,
  setGitWorkflowPolicy,
  syncGitWorkflowPlugin,
  verifyGitWorkflowHookNodeRuntime,
} = await import(pathToFileURL(path.join(REPO_ROOT, 'studio', 'daemon', 'git-workflow-service.mjs')).href);

function git(cwd, args, extraEnv = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createTempRepo(branch = 'main', withInitialCommit = true) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wf-repo-')));
  execFileSync('git', ['init', '-b', branch, dir], { stdio: 'ignore' });
  git(dir, ['config', 'user.name', 'MAGA Test']);
  git(dir, ['config', 'user.email', 'test@maga.local']);
  if (withInitialCommit) {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    git(dir, ['add', 'README.md']);
    git(dir, ['commit', '-m', 'init']);
  }
  return dir;
}

function writePolicy(stateDir, doc) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'git-workflow-policy.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

function createNativeProj(nativeProjectsDir, name, dirPath) {
  fs.mkdirSync(nativeProjectsDir, { recursive: true });
  fs.writeFileSync(
    path.join(nativeProjectsDir, `${name}.json`),
    JSON.stringify({
      name,
      projectResources: { resources: [{ gitFolder: { folderUri: pathToFileURL(dirPath).href } }] },
    }),
    'utf8'
  );
}

test('global git-guard enforces 3 tiers (observe, protect-main, worktree-only), unborn HEAD, origin/HEAD, and detached bisect override', () => {
  const repo = createTempRepo('main', true);
  const unbornRepo = createTempRepo('main', false);
  const trunkRepo = createTempRepo('trunk', true);
  const wtParent = `${repo}-wt`;
  const wtDir = path.join(wtParent, 'feat-one');
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wf-env-')));
  const stateDir = path.join(tmpRoot, 'state');
  const pluginsDir = path.join(tmpRoot, 'plugins');

  try {
    fs.mkdirSync(wtParent, { recursive: true });
    git(repo, ['worktree', 'add', '-b', 'feat/one', '--', wtDir, 'main']);
    const repoCtx = resolveGitContext(repo);

    // Tier 0 (observe default): silent SessionStart, allows main edit/commit, blocks force-push, records linked worktree
    assert.deepEqual(
      evaluateHookPayloadWithOptions({ hookEventName: 'SessionStart', cwd: repo }, { stateDir, pluginsDir }),
      {}
    );
    assert.deepEqual(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: repo, toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'README.md') } } },
        { stateDir, pluginsDir }
      ),
      { decision: 'allow' }
    );
    assert.equal(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: repo, toolCall: { name: 'run_command', args: { CommandLine: 'git push --force origin main' } } },
        { stateDir, pluginsDir }
      ).decision,
      'deny'
    );

    // Tier 1 (protect-main): blocks edits/commits on main, allows branch creation, allows unborn HEAD initial commit
    writePolicy(stateDir, {
      schema: 1,
      defaultMode: 'observe',
      blockForcePushProtected: true,
      blockPushTags: false,
      projects: {
        [repoCtx.commonDirKey]: { mode: 'protect-main', displayRoot: repo, commonDir: repoCtx.commonDir },
        [normalizePolicyKey(path.join(unbornRepo, '.git'))]: { mode: 'protect-main', displayRoot: unbornRepo },
      },
    });

    const ssProtect = evaluateHookPayloadWithOptions({ hookEventName: 'SessionStart', cwd: repo }, { stateDir, pluginsDir });
    assert.match(ssProtect.injectSteps?.[0]?.systemMessage?.systemMessage || '', /protect-main/);
    assert.equal(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: repo, toolCall: { name: 'edit_file', args: { Path: path.join(repo, 'README.md') } } },
        { stateDir, pluginsDir }
      ).decision,
      'deny'
    );
    assert.deepEqual(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: repo, toolCall: { name: 'run_command', args: { CommandLine: 'git checkout -b feat/local' } } },
        { stateDir, pluginsDir }
      ),
      { decision: 'allow' }
    );
    // Unborn HEAD (0 commits) allows initial edit & commit cleanly
    assert.deepEqual(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: unbornRepo, toolCall: { name: 'write_file', args: { Path: path.join(unbornRepo, 'init.txt') } } },
        { stateDir, pluginsDir }
      ),
      { decision: 'allow' }
    );
    assert.deepEqual(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: unbornRepo, toolCall: { name: 'run_command', args: { CommandLine: 'git commit -m "first"' } } },
        { stateDir, pluginsDir }
      ),
      { decision: 'allow' }
    );

    // Auto-detected origin/HEAD (`trunk`) is protected when policy resolves `protect-main`
    const trunkCtx = resolveGitContext(trunkRepo);
    fs.mkdirSync(path.join(trunkCtx.commonDir, 'refs', 'remotes', 'origin'), { recursive: true });
    fs.writeFileSync(path.join(trunkCtx.commonDir, 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/trunk\n', 'utf8');
    writePolicy(stateDir, {
      schema: 1,
      defaultMode: 'observe',
      blockForcePushProtected: true,
      projects: { [trunkCtx.commonDirKey]: { mode: 'protect-main', displayRoot: trunkRepo } },
    });
    assert.equal(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: trunkRepo, toolCall: { name: 'edit_file', args: { Path: path.join(trunkRepo, 'README.md') } } },
        { stateDir, pluginsDir }
      ).decision,
      'deny'
    );

    // Tier 2 (worktree-only): primary checkout locked even on detached HEAD (git bisect allowed via MAGA_ALLOW_PRIMARY_CHECKOUT=1)
    writePolicy(stateDir, {
      schema: 1,
      defaultMode: 'observe',
      blockForcePushProtected: true,
      projects: { [repoCtx.commonDirKey]: { mode: 'worktree-only', displayRoot: repo } },
    });
    const detachedPrimaryDeny = evaluateHookPayloadWithOptions(
      { hookEventName: 'PreToolUse', cwd: repo, toolCall: { name: 'run_command', args: { CommandLine: 'git checkout --detach HEAD' } } },
      { stateDir, pluginsDir }
    );
    assert.equal(detachedPrimaryDeny.decision, 'deny');
    assert.match(detachedPrimaryDeny.reason, /MAGA_ALLOW_PRIMARY_CHECKOUT=1/);
    assert.deepEqual(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: repo, toolCall: { name: 'run_command', args: { CommandLine: 'MAGA_ALLOW_PRIMARY_CHECKOUT=1 git checkout --detach HEAD' } } },
        { stateDir, pluginsDir }
      ),
      { decision: 'allow' }
    );
    // Linked worktree edits allowed
    assert.deepEqual(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: wtDir, toolCall: { name: 'edit_file', args: { Path: path.join(wtDir, 'README.md') } } },
        { stateDir, pluginsDir }
      ),
      { decision: 'allow' }
    );
  } finally {
    fs.rmSync(wtParent, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(unbornRepo, { recursive: true, force: true });
    fs.rmSync(trunkRepo, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('self-tampering, anti-forgery defer check, submodule separation, parser hardening, args.Cwd, and deny ring buffer', () => {
  const mainRepo = createTempRepo('main', true);
  const subSource = createTempRepo('main', true);
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wf-sec-')));
  const stateDir = path.join(tmpRoot, 'state');
  const pluginsDir = path.join(tmpRoot, 'plugins');

  try {
    const installedPluginFile = path.join(pluginsDir, 'maga-git-workflow', 'hooks', 'git-guard.mjs');
    const policyFile = path.join(stateDir, 'git-workflow-policy.json');
    fs.mkdirSync(path.dirname(installedPluginFile), { recursive: true });
    fs.writeFileSync(installedPluginFile, '// live\n', 'utf8');

    // 1. Even in `observe`, agent CANNOT edit policy file or live installed plugin dir
    for (const forbidden of [policyFile, `${policyFile}.tmp`, installedPluginFile]) {
      const res = evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: mainRepo, toolCall: { name: 'write_file', args: { Path: forbidden } } },
        { stateDir, pluginsDir }
      );
      assert.equal(res.decision, 'deny', `must deny self-tamper path: ${forbidden}`);
    }

    // Wait: MAGA source files inside a repo worktree ARE allowed in observe/linked-wt (distinct from pluginsDir)
    const devSourcePath = path.join(mainRepo, 'studio', 'plugin', 'maga-git-workflow', 'hooks', 'git-guard.mjs');
    assert.deepEqual(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: mainRepo, toolCall: { name: 'write_file', args: { Path: devSourcePath } } },
        { stateDir, pluginsDir }
      ),
      { decision: 'allow' }
    );

    // 2. Anti-forgery defer check: genuine local guardrail defers; forged `/bin/true` or missing engine import stays enforced!
    const mainCtx = resolveGitContext(mainRepo);
    writePolicy(stateDir, {
      schema: 1,
      defaultMode: 'observe',
      blockForcePushProtected: true,
      projects: { [mainCtx.commonDirKey]: { mode: 'protect-main', displayRoot: mainRepo } },
    });

    // Forged pointing outside `.agents/hooks/`
    fs.mkdirSync(path.join(mainRepo, '.agents', 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepo, '.agents', 'hooks.json'),
      JSON.stringify({ 'maga-git-guardrail': { PreToolUse: [{ hooks: [{ command: '/usr/bin/true' }] }] } }),
      'utf8'
    );
    assert.equal(hasValidLocalGuardrail(mainRepo), false);
    assert.equal(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: mainRepo, toolCall: { name: 'edit_file', args: { Path: path.join(mainRepo, 'README.md') } } },
        { stateDir, pluginsDir }
      ).decision,
      'deny',
      'forged /usr/bin/true defer marker must NOT bypass enforcement'
    );

    // Forged script inside `.agents/hooks/` without canonical engine import
    fs.writeFileSync(
      path.join(mainRepo, '.agents', 'hooks.json'),
      JSON.stringify({ 'maga-git-guardrail': { PreToolUse: [{ hooks: [{ command: 'node ./hooks/noop.mjs' }] }] } }),
      'utf8'
    );
    fs.writeFileSync(path.join(mainRepo, '.agents', 'hooks', 'noop.mjs'), 'console.log("{decision:\\"allow\\"}")\n', 'utf8');
    assert.equal(hasValidLocalGuardrail(mainRepo), false);

    // Valid local guardrail importing canonical engine passes hasValidLocalGuardrail -> global hook defers
    fs.writeFileSync(
      path.join(mainRepo, '.agents', 'hooks', 'noop.mjs'),
      "import '../studio/plugin/maga-git-workflow/hooks/git-guard.mjs';\n",
      'utf8'
    );
    assert.equal(hasValidLocalGuardrail(mainRepo), true);
    assert.deepEqual(
      evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: mainRepo, toolCall: { name: 'edit_file', args: { Path: path.join(mainRepo, 'README.md') } } },
        { stateDir, pluginsDir }
      ),
      { decision: 'allow' }
    );
    fs.rmSync(path.join(mainRepo, '.agents'), { recursive: true, force: true });

    // 3. Submodule checkout has `.git` file, MUST report `isLinkedWorktree === false`
    execFileSync('git', ['-C', mainRepo, '-c', 'protocol.file.allow=always', 'submodule', 'add', subSource, 'vendor/sub'], {
      stdio: 'ignore',
    });
    const subCtx = resolveGitContext(path.join(mainRepo, 'vendor', 'sub'));
    assert.ok(subCtx);
    assert.equal(fs.lstatSync(path.join(mainRepo, 'vendor', 'sub', '.git')).isFile(), true);
    assert.equal(subCtx.isLinkedWorktree, false, 'submodule is NOT misclassified as a linked worktree');

    // 4. Parser hardening & multi-workspace args.Cwd
    for (const cmd of [
      '(git push -f origin main)',
      '{ git push --force origin main; }',
      'sudo git push -f origin main',
      'bash -c "git push --force origin main"',
    ]) {
      const res = evaluateHookPayloadWithOptions(
        { hookEventName: 'PreToolUse', cwd: tmpRoot, toolCall: { name: 'run_command', args: { Cwd: mainRepo, CommandLine: cmd } } },
        { stateDir, pluginsDir }
      );
      assert.equal(res.decision, 'deny', `parser must catch: ${cmd}`);
    }

    // 5. Subprocess hook writes deny ring buffer ONLY on deny (never on allow), capped at 200
    const cid = 'conv-ring-123456';
    const allowOut = execFileSync(process.execPath, [GLOBAL_GUARD_SCRIPT], {
      input: JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: cid,
        cwd: mainRepo,
        toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
      }),
      env: { ...process.env, ANTI_CLAUDE_STATE_DIR: stateDir, ANTI_CLAUDE_PLUGINS_DIR: pluginsDir },
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(allowOut), { decision: 'allow' });
    const eventsPath = path.join(stateDir, 'git-workflow-events.json');
    assert.equal(fs.existsSync(eventsPath), false, 'allow hot path does not write events file');

    for (let i = 0; i < 205; i += 1) {
      recordGuardDenyEvent({ cid, repo: mainRepo, mode: 'protect-main', tool: 'edit_file', reason: `err-${i}` }, { stateDir });
    }
    const savedEvents = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
    assert.equal(savedEvents.events.length, 200, 'events ring buffer capped at 200');
    assert.equal(savedEvents.events[0].reason, 'err-5');
    assert.equal(savedEvents.events[199].reason, 'err-204');
  } finally {
    fs.rmSync(mainRepo, { recursive: true, force: true });
    fs.rmSync(subSource, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('git-workflow-service syncs plugin with pinned Node, manages policy atomically, and wt.mjs works across non-Node & Node repos', async () => {
  const pyRepo = createTempRepo('main', true);
  const nodeRepo = createTempRepo('main', true);
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wf-svc-')));
  const stateDir = path.join(tmpRoot, 'state');
  const pluginsDir = path.join(tmpRoot, 'plugins');
  const nativeProjectsDir = path.join(tmpRoot, 'native-projects');
  const policyFile = path.join(stateDir, 'git-workflow-policy.json');
  const eventsFile = path.join(stateDir, 'git-workflow-events.json');

  try {
    fs.writeFileSync(path.join(pyRepo, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');
    fs.writeFileSync(path.join(nodeRepo, 'package.json'), '{"name":"demo"}\n', 'utf8');
    fs.mkdirSync(path.join(nodeRepo, 'node_modules', 'pkg'), { recursive: true });
    createNativeProj(nativeProjectsDir, 'pyproj', pyRepo);

    // 1. Plugin sync + pinned node verification + removal
    const syncRes = syncGitWorkflowPlugin({}, { pluginsDir });
    assert.equal(syncRes.ok, true);
    assert.equal(isGitWorkflowPluginInstalled({ pluginsDir }), true);
    const syncedHooks = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'maga-git-workflow', 'hooks.json'), 'utf8'));
    assert.match(syncedHooks['maga-git-workflow'].SessionStart[0].command, /git-guard\.mjs/);
    assert.notEqual(syncedHooks['maga-git-workflow'].SessionStart[0].command.startsWith('node '), true);
    assert.equal(verifyGitWorkflowHookNodeRuntime({ pluginsDir }).ok, true);

    // 2. Policy CRUD via daemon service / RPC handler
    const upd = await setGitWorkflowPolicy(
      { dirPath: pyRepo, mode: 'protect-main', defaultMode: 'observe', blockPushTags: true },
      { stateDir, pluginsDir, policyFile, eventsFile, nativeProjectsDir }
    );
    assert.equal(upd.ok, true);
    assert.equal(upd.projectsSummary.find((p) => p.dirPath === pyRepo)?.mode, 'protect-main');

    const rpcSt = await handleGitWorkflowRpc('getGitWorkflowPolicy', {}, { stateDir, pluginsDir, policyFile, eventsFile, nativeProjectsDir });
    assert.equal(rpcSt.ok, true);
    assert.equal(loadGitWorkflowPolicy({ policyFile }).blockPushTags, true);

    // Unauthorized directory rejected
    const unauth = await setGitWorkflowPolicy(
      { dirPath: nodeRepo, mode: 'worktree-only' },
      { stateDir, pluginsDir, policyFile, eventsFile, nativeProjectsDir }
    );
    assert.equal(unauth.ok, false);
    assert.equal(unauth.error, 'unregistered_project_dir');

    // 3. Universal wt.mjs CLI on non-Node Python repo: supports generic branch names & NEVER touches .git/info/exclude
    const pyCreated = JSON.parse(
      execFileSync(process.execPath, [WT_UNIVERSAL_CLI, 'new', 'experiment-ablation', '--repo', pyRepo], { encoding: 'utf8' })
    );
    assert.equal(pyCreated.ok, true);
    const excludeFilePy = path.join(pyRepo, '.git', 'info', 'exclude');
    const excludeBodyPy = fs.existsSync(excludeFilePy) ? fs.readFileSync(excludeFilePy, 'utf8') : '';
    assert.equal(excludeBodyPy.includes('/node_modules'), false, 'non-Node repo keeps .git/info/exclude free of /node_modules');

    const pyClean = JSON.parse(
      execFileSync(process.execPath, [WT_UNIVERSAL_CLI, 'clean', 'feat/experiment-ablation', '--repo', pyRepo, '--delete-branch'], {
        encoding: 'utf8',
      })
    );
    assert.equal(pyClean.ok, true);
    assert.equal(pyClean.branchDeleted, true);

    // Generic plain-branch creation works too (`my/custom-branch`)
    const customBranchWt = JSON.parse(
      execFileSync(process.execPath, [WT_UNIVERSAL_CLI, 'new', 'custom/ablation-2', '--repo', pyRepo], { encoding: 'utf8' })
    );
    assert.equal(customBranchWt.ok, true);
    assert.equal(customBranchWt.branch, 'custom/ablation-2');

    // Read-only `policy` prints active tier without mutating
    const polOut = JSON.parse(
      execFileSync(process.execPath, [WT_UNIVERSAL_CLI, 'policy', '--repo', pyRepo], {
        env: { ...process.env, ANTI_CLAUDE_STATE_DIR: stateDir },
        encoding: 'utf8',
      })
    );
    assert.equal(polOut.ok, true);
    assert.equal(polOut.readOnly, true);
    assert.equal(polOut.mode, 'protect-main');

    // Node repo DOES symlink node_modules & write /node_modules exclude
    const nodeCreated = JSON.parse(
      execFileSync(process.execPath, [WT_UNIVERSAL_CLI, 'new', 'feat/ui-tweak', '--repo', nodeRepo], { encoding: 'utf8' })
    );
    assert.equal(nodeCreated.ok, true);
    assert.equal(fs.lstatSync(path.join(nodeCreated.worktreePath, 'node_modules')).isSymbolicLink(), true);
    assert.match(fs.readFileSync(path.join(nodeRepo, '.git', 'info', 'exclude'), 'utf8'), /^\/node_modules$/m);

    // Remove plugin cleanly
    syncGitWorkflowPlugin({ remove: true }, { pluginsDir });
    assert.equal(isGitWorkflowPluginInstalled({ pluginsDir }), false);

    // 4. Settings views render L2 drill-down, L3 guard inactive banner, project list, events & CSS zero :has()
    const { renderL2Workspace, renderL3GitWorkflow } = await import(
      pathToFileURL(path.join(REPO_ROOT, 'studio', 'modules', 'settings', 'views.mjs')).href
    );
    const L = (_zh, en) => en;
    const l2Html = renderL2Workspace(
      { overviewUsageEnabled: true, overviewUsageDefaultPeriod: 'day', subagentFooterEnabled: true },
      { modules: {} },
      { state: {}, L }
    );
    assert.match(l2Html, /data-ms-nav="workspace-git-workflow"/);

    const l3InactiveHtml = renderL3GitWorkflow(
      {
        gitWorkflowStatus: {
          ok: true,
          pluginInstalled: false,
          hookNode: { ok: false, nodeBin: '/missing/node' },
          guardActive: false,
          policy: { defaultMode: 'observe', blockForcePushProtected: true, blockPushTags: false, projects: {} },
          projectsSummary: [
            { name: 'pyRepo', dirPath: pyRepo, mode: 'protect-main', overrideMode: 'protect-main', localGuardrailActive: false },
            { name: 'magaRepo', dirPath: '/tmp/maga', mode: 'worktree-only', overrideMode: '', localGuardrailActive: true },
          ],
          staleProjects: [{ commonDirKey: '/tmp/gone/.git', displayRoot: '/tmp/gone', mode: 'worktree-only' }],
          denyCount24h: 1,
          recentEvents: [{ ts: Date.now(), repoName: 'pyRepo', mode: 'protect-main', reason: 'Blocked edit on main' }],
        },
      },
      { L }
    );
    assert.match(l3InactiveHtml, /data-ms-wf-warn="true"/);
    assert.match(l3InactiveHtml, /Guard inactive/);
    assert.match(l3InactiveHtml, /Worktree · Repo Guard/);
    assert.match(l3InactiveHtml, /prune-git-workflow-stale/);
    assert.match(l3InactiveHtml, /Blocked edit on main/);

    const settingsCss = fs.readFileSync(path.join(REPO_ROOT, 'studio', 'styles', 'studio-settings.css'), 'utf8');
    assert.equal(settingsCss.includes(':has('), false, 'studio-settings.css has zero :has()');
  } finally {
    fs.rmSync(`${pyRepo}-wt`, { recursive: true, force: true });
    fs.rmSync(`${nodeRepo}-wt`, { recursive: true, force: true });
    fs.rmSync(pyRepo, { recursive: true, force: true });
    fs.rmSync(nodeRepo, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
