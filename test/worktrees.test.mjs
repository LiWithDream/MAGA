import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TEST_DIR, '..');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {}

const skipDom = !JSDOM;

function gitSync(cwd, args, extraEnv = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createTempGitRepo(initialBranch = 'main') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wt-repo-')));
  gitSync(dir, ['init', '-b', initialBranch]);
  gitSync(dir, ['config', 'user.email', 'test@maga.local']);
  gitSync(dir, ['config', 'user.name', 'MAGA Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'user/custom.js\n', 'utf8');
  gitSync(dir, ['add', 'README.md', '.gitignore']);
  gitSync(dir, ['commit', '-m', 'init']);
  return dir;
}

function createNativeProjectFile(nativeProjectsDir, projName, folderPath) {
  fs.mkdirSync(nativeProjectsDir, { recursive: true });
  const rec = {
    name: projName,
    projectResources: {
      resources: [{ gitFolder: { folderUri: pathToFileURL(folderPath).href } }],
    },
  };
  fs.writeFileSync(path.join(nativeProjectsDir, `${projName}.json`), JSON.stringify(rec), 'utf8');
}

function settle(ms = 35) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('worktrees.mjs: porcelain -z parser, native projects discovery, stats gating, collision & pin precedence', async () => {
  const {
    getAuthorizedProjectDirs,
    listRepoWorktreesAsync,
    parseWorktreeListPorcelainZ,
    resolveConversationWorktreeAsync,
    setConversationWorktreeBindingAsync,
  } = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'worktrees.mjs')).href);

  // 1. parseWorktreeListPorcelainZ parses main, linked, detached, locked, prunable, bare entries
  const samplePorcelain =
    [
      'worktree /tmp/repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /tmp/repo-wt/feat-a',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feat/a',
      'locked reason here',
      '',
      'worktree /tmp/repo-wt/detached',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\0') + '\0';

  const parsed = parseWorktreeListPorcelainZ(samplePorcelain);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].isMain, true);
  assert.equal(parsed[0].branch, 'main');
  assert.equal(parsed[0].isProtected, true);
  assert.equal(parsed[1].isMain, false);
  assert.equal(parsed[1].branch, 'feat/a');
  assert.equal(parsed[1].locked, true);
  assert.equal(parsed[2].detached, true);
  assert.equal(parsed[2].prunable, true);

  // 2. Real git repo + native projects discovery + stats gating + precedence + collision
  const mainRepo = createTempGitRepo('main');
  const wtParent = `${mainRepo}-wt`;
  const wtAlpha = path.join(wtParent, 'alpha');
  const wtBeta = path.join(wtParent, 'beta');
  const wtDetached = path.join(wtParent, 'detached');
  const stateTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wt-state-')));
  const convWtDir = path.join(stateTmp, 'conv-worktrees');
  const nativeProjectsDir = path.join(stateTmp, 'native-projects');
  const regFile = path.join(stateTmp, 'missing-registry.json');

  try {
    fs.mkdirSync(wtParent, { recursive: true });
    gitSync(mainRepo, ['worktree', 'add', '-b', 'feat/alpha', '--', wtAlpha, 'main']);
    gitSync(mainRepo, ['worktree', 'add', '-b', 'feat/beta', '--', wtBeta, 'main']);
    gitSync(mainRepo, ['worktree', 'add', '--detach', '--', wtDetached, 'HEAD']);

    // Modify wtAlpha and add 1 commit ahead on wtBeta
    fs.writeFileSync(path.join(wtAlpha, 'README.md'), '# Demo edited\n', 'utf8');
    fs.writeFileSync(path.join(wtBeta, 'beta.txt'), 'beta\n', 'utf8');
    gitSync(wtBeta, ['add', 'beta.txt']);
    gitSync(wtBeta, ['commit', '-m', 'beta ahead']);

    // Native projects dir works even when projects-registry.json does not exist
    createNativeProjectFile(nativeProjectsDir, 'demo', mainRepo);
    const authDirs = getAuthorizedProjectDirs({ registryFile: regFile, nativeProjectsDir });
    assert.equal(authDirs.includes(mainRepo), true, 'authorizes project discovered in NATIVE_PROJECTS_DIR');

    // Hook files for 2 convs in wtAlpha -> collision detection
    fs.mkdirSync(convWtDir, { recursive: true });
    const cid1 = 'conv-alpha-111111';
    const cid2 = 'conv-alpha-222222';
    const now = Date.now();
    for (const c of [cid1, cid2]) {
      fs.writeFileSync(
        path.join(convWtDir, `${c}.json`),
        JSON.stringify({
          schema: 1,
          cid: c,
          worktreePath: wtAlpha,
          branch: 'feat/alpha',
          repoRoot: mainRepo,
          source: 'hook',
          updatedAt: now,
        }),
        'utf8'
      );
    }

    // Gated stats: includeStats: false only populates stats for activeWorktreePath
    const gatedList = await listRepoWorktreesAsync(mainRepo, {
      force: true,
      includeStats: false,
      activeWorktreePath: wtAlpha,
      convWtDir,
    });
    assert.equal(gatedList.ok, true);
    assert.equal(gatedList.mainDirPath, mainRepo);
    assert.equal(gatedList.worktrees.length, 4);
    const gatedAlpha = gatedList.worktrees.find((w) => w.realPath === wtAlpha);
    const gatedBeta = gatedList.worktrees.find((w) => w.realPath === wtBeta);
    assert.ok(gatedAlpha.git && gatedAlpha.git.changedFiles >= 1);
    assert.equal(gatedBeta.git, null, 'skips non-active worktree stats when includeStats is false');
    assert.deepEqual(gatedAlpha.collisionCids.sort(), [cid1, cid2].sort());

    // Full stats: includeStats: true computes ahead count on wtBeta & detached state
    const fullList = await listRepoWorktreesAsync(mainRepo, {
      force: true,
      includeStats: true,
      convWtDir,
    });
    const fullBeta = fullList.worktrees.find((w) => w.realPath === wtBeta);
    assert.equal(fullBeta.ahead, 1, 'reports ahead commits vs main base branch');

    // Hook resolution returns wtAlpha initially
    const hookRes = await resolveConversationWorktreeAsync(mainRepo, cid1, { convWtDir });
    assert.equal(hookRes.worktreePath, wtAlpha);
    assert.equal(hookRes.branch, 'feat/alpha');
    assert.equal(hookRes.isWorktree, true);
    assert.equal(hookRes.source, 'hook');
    assert.equal(hookRes.collisionCids.includes(cid2), true);

    // Manual pin overrides hook mapping
    const pinRes = await setConversationWorktreeBindingAsync(mainRepo, cid1, wtBeta, { convWtDir });
    assert.equal(pinRes.ok, true);
    assert.equal(pinRes.mode, 'manual');
    assert.equal(pinRes.branch, 'feat/beta');

    const pinnedResolve = await resolveConversationWorktreeAsync(mainRepo, cid1, { convWtDir });
    assert.equal(pinnedResolve.worktreePath, wtBeta);
    assert.equal(pinnedResolve.branch, 'feat/beta');
    assert.equal(pinnedResolve.source, 'manual');

    // Manual pin to detached HEAD resolves HEAD branch cleanly
    const pinDetached = await setConversationWorktreeBindingAsync(mainRepo, cid1, wtDetached, { convWtDir });
    assert.equal(pinDetached.ok, true);
    const detachedResolve = await resolveConversationWorktreeAsync(mainRepo, cid1, { convWtDir });
    assert.equal(detachedResolve.branch, 'HEAD');
    assert.equal(detachedResolve.isWorktree, true);

    // Reset back to auto mode falls back to hook mapping (wtAlpha)
    const unpinRes = await setConversationWorktreeBindingAsync(mainRepo, cid1, '', { convWtDir });
    assert.equal(unpinRes.ok, true);
    assert.equal(unpinRes.mode, 'auto');
    const afterUnpin = await resolveConversationWorktreeAsync(mainRepo, cid1, { convWtDir });
    assert.equal(afterUnpin.worktreePath, wtAlpha);
    assert.equal(afterUnpin.source, 'hook');

    // Stale manual pin whose folder vanished gracefully falls back to hook mapping
    fs.writeFileSync(
      path.join(convWtDir, 'pins.json'),
      JSON.stringify({
        schema: 1,
        pins: { [cid1]: { worktreePath: path.join(wtParent, 'deleted-wt'), branch: 'feat/gone', repoRoot: mainRepo, updatedAt: Date.now() } },
      }),
      'utf8'
    );
    const stalePinFallback = await resolveConversationWorktreeAsync(mainRepo, cid1, { convWtDir });
    assert.equal(stalePinFallback.worktreePath, wtAlpha);
    assert.equal(stalePinFallback.source, 'hook');
  } finally {
    fs.rmSync(wtParent, { recursive: true, force: true });
    fs.rmSync(mainRepo, { recursive: true, force: true });
    fs.rmSync(stateTmp, { recursive: true, force: true });
  }
});

test('worktrees.mjs: security guards, symlinked -wt block, node_modules clean remove, overview-skills & revealFile', async () => {
  const {
    collectAuthorizedWorktreeRootsAsync,
    createRepoWorktreeAsync,
    isAuthorizedWorktreePathAsync,
    removeRepoWorktreeAsync,
  } = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'worktrees.mjs')).href);
  const {
    collectOverviewSnapshotAsync,
    handleProjectRpcRequest,
    readProjectWorkspaceStatusAsync,
  } = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'overview-skills.mjs')).href);

  const mainRepo = createTempGitRepo('main');
  const wtParent = `${mainRepo}-wt`;
  const fakeEnvRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-wt-sec-')));
  const convWtDir = path.join(fakeEnvRoot, 'conv-worktrees');
  const nativeProjectsDir = path.join(fakeEnvRoot, 'native-projects');
  const symlinkParentRepo = createTempGitRepo('main');
  const outsideTarget = path.join(fakeEnvRoot, 'outside-dir');

  try {
    fs.mkdirSync(path.join(mainRepo, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(mainRepo, 'node_modules', 'dep', 'index.js'), 'export {};\n', 'utf8');
    fs.writeFileSync(path.join(mainRepo, 'AGENTS.md'), '# Main Local Rules\n', 'utf8');
    createNativeProjectFile(nativeProjectsDir, 'mainrepo', mainRepo);

    // 1. Authorization & validation rejections
    const unreg = await createRepoWorktreeAsync(mainRepo, {
      type: 'feat',
      slug: 'ok-slug',
      authorizedDirs: [],
      nativeProjectsDir: path.join(fakeEnvRoot, 'empty-native'),
      convWtDir,
    });
    assert.equal(unreg.ok, false);
    assert.equal(unreg.error, 'unregistered_project_dir');

    for (const [badOpts, expectedErr] of [
      [{ type: 'bogus', slug: 'ok' }, 'invalid_worktree_type'],
      [{ type: 'feat', slug: '../escape' }, 'invalid_worktree_slug'],
      [{ type: 'feat', slug: 'bad.lock' }, 'invalid_worktree_slug'],
      [{ type: 'feat', slug: '.hidden' }, 'invalid_worktree_slug'],
      [{ branch: 'feat/x', slug: 'x' }, null],
      [{ branch: 'notslashed' }, 'invalid_branch_format'],
      [{ type: 'feat', slug: 'flagbase', baseBranch: '--upload-pack=evil' }, 'invalid_base_branch'],
    ]) {
      if (!expectedErr) continue;
      const res = await createRepoWorktreeAsync(mainRepo, {
        ...badOpts,
        allowUnregistered: true,
        convWtDir,
      });
      assert.equal(res.ok, false);
      assert.equal(res.error, expectedErr);
    }

    // 2. Symlinked `<repo>-wt` parent blocked cleanly (`unsafe_worktree_parent`)
    fs.mkdirSync(outsideTarget, { recursive: true });
    fs.symlinkSync(outsideTarget, `${symlinkParentRepo}-wt`);
    const symlinkRes = await createRepoWorktreeAsync(symlinkParentRepo, {
      type: 'feat',
      slug: 'sym-test',
      allowUnregistered: true,
      convWtDir,
    });
    assert.equal(symlinkRes.ok, false);
    assert.equal(symlinkRes.error, 'unsafe_worktree_parent');

    // 3. Happy create + pin + Overview snapshot (worktree git + main AGENTS.md) + workspace status
    const cid = 'cid-sec-test-123456';
    const created = await createRepoWorktreeAsync(mainRepo, {
      type: 'feat',
      slug: 'clean-wt',
      cid,
      nativeProjectsDir,
      convWtDir,
    });
    assert.equal(created.ok, true);
    assert.equal(created.branch, 'feat/clean-wt');
    assert.equal(fs.lstatSync(path.join(created.worktreePath, 'node_modules')).isSymbolicLink(), true);

    // Write gitignored bundle user/custom.js + dirty tracked README inside worktree
    fs.mkdirSync(path.join(created.worktreePath, 'user'), { recursive: true });
    fs.writeFileSync(path.join(created.worktreePath, 'user', 'custom.js'), '// built\n', 'utf8');
    fs.writeFileSync(path.join(created.worktreePath, 'README.md'), '# Edited inside WT\n', 'utf8');

    const geminiDir = path.join(fakeEnvRoot, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const snap = await collectOverviewSnapshotAsync(
      { dirPath: mainRepo, cid, force: true },
      {
        convWtDir,
        homeDir: fakeEnvRoot,
        geminiDir,
        configDir: path.join(geminiDir, 'config'),
        skillsDir: path.join(geminiDir, 'skills'),
        agentsDir: path.join(geminiDir, 'agents'),
        builtinSkillsDir: path.join(geminiDir, 'builtin'),
      }
    );
    assert.equal(snap.ok, true);
    assert.equal(snap.workspace.dirPath, created.worktreePath);
    assert.equal(snap.workspace.mainDirPath, mainRepo);
    assert.equal(snap.workspace.isWorktree, true);
    assert.equal(snap.workspace.git.branch, 'feat/clean-wt');
    assert.equal(snap.workspace.git.changedFiles, 1);
    assert.ok(
      snap.rules.some((r) => r.scope === 'project' && r.path === path.join(mainRepo, 'AGENTS.md')),
      'scans project AGENTS.md from main repo even when local-only file is absent in worktree'
    );

    const wsStatus = await readProjectWorkspaceStatusAsync(mainRepo, {
      force: true,
      worktreePath: created.worktreePath,
      convWtDir,
    });
    assert.equal(wsStatus.ok, true);
    assert.equal(wsStatus.git.branch, 'feat/clean-wt');
    assert.equal(wsStatus.activeWorktreePath, created.worktreePath);
    assert.equal(wsStatus.dirtyFiles.length, 1);

    // Authorization check accepts worktree and rejects outside path
    const wtRoots = await collectAuthorizedWorktreeRootsAsync('', { authorizedDirs: [], nativeProjectsDir, convWtDir });
    assert.equal(wtRoots.includes(created.worktreePath), true);
    assert.equal(
      await isAuthorizedWorktreePathAsync(created.worktreePath, { authorizedDirs: [], nativeProjectsDir, convWtDir }),
      true
    );
    assert.equal(
      await isAuthorizedWorktreePathAsync('/etc', { authorizedDirs: [], nativeProjectsDir, convWtDir }),
      false
    );

    const revealDenied = JSON.parse(
      JSON.stringify(
        await handleProjectRpcRequest(
          JSON.stringify({ reqId: 'r1', action: 'revealFile', payload: { targetPath: '/etc/hosts' } })
        )
      )
    );
    assert.equal(revealDenied.result.ok, false);
    assert.equal(revealDenied.result.error, 'path_outside_project');

    // 4. Removal guards: cannot remove main, cannot remove dirty, cannot remove active without forceActive
    const rmMain = await removeRepoWorktreeAsync(mainRepo, { worktreePath: mainRepo, nativeProjectsDir, convWtDir });
    assert.equal(rmMain.ok, false);
    assert.equal(rmMain.error, 'cannot_remove_main_worktree');

    const rmActive = await removeRepoWorktreeAsync(mainRepo, { worktreePath: created.worktreePath, nativeProjectsDir, convWtDir });
    assert.equal(rmActive.ok, false);
    assert.equal(rmActive.error, 'worktree_active_in_conversation');

    const rmDirty = await removeRepoWorktreeAsync(mainRepo, {
      worktreePath: created.worktreePath,
      forceActive: true,
      nativeProjectsDir,
      convWtDir,
    });
    assert.equal(rmDirty.ok, false);
    assert.equal(rmDirty.error, 'git_worktree_remove_failed');

    // Clean tracked file (keeping symlinked node_modules + gitignored user/custom.js) -> plain remove succeeds WITHOUT --force
    gitSync(created.worktreePath, ['checkout', '--', 'README.md']);
    const rmClean = await removeRepoWorktreeAsync(mainRepo, {
      worktreePath: created.worktreePath,
      deleteBranch: true,
      forceActive: true,
      nativeProjectsDir,
      convWtDir,
    });
    assert.equal(rmClean.ok, true, rmClean.detail || rmClean.error);
    assert.equal(rmClean.branchDeleted, true);
    assert.equal(fs.existsSync(created.worktreePath), false);

    // Pin pointing to removed worktree was pruned
    const pinsJson = JSON.parse(fs.readFileSync(path.join(convWtDir, 'pins.json'), 'utf8'));
    assert.equal(pinsJson.pins[cid], undefined);
  } finally {
    fs.rmSync(wtParent, { recursive: true, force: true });
    fs.rmSync(`${symlinkParentRepo}-wt`, { recursive: true, force: true });
    fs.rmSync(mainRepo, { recursive: true, force: true });
    fs.rmSync(symlinkParentRepo, { recursive: true, force: true });
    fs.rmSync(fakeEnvRoot, { recursive: true, force: true });
  }
});

test('deploy-meta provenance, single-desktop deploy guard & standalone studio/wt-cli.mjs lifecycle work end-to-end', async () => {
  const { evaluateDeployGuard, readDeployMeta, writeDeployMeta } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'deploy-meta.mjs')).href
  );

  const mainRepo = createTempGitRepo('main');
  const wtParent = `${mainRepo}-wt`;
  const tmpState = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maga-deploy-meta-')));
  const metaPath = path.join(tmpState, 'deploy-meta.json');
  const wtCliPath = path.join(REPO, 'studio', 'wt-cli.mjs');

  try {
    // 1. Clean primary checkout on main passes deploy guard with zero warnings
    const guardMain = evaluateDeployGuard(mainRepo, { metaPath });
    assert.equal(guardMain.allowed, true);
    assert.equal(guardMain.preview, false);
    assert.deepEqual(guardMain.warnings, []);

    const mainMeta = writeDeployMeta(mainRepo, metaPath);
    assert.equal(mainMeta.branch, 'main');
    assert.equal(mainMeta.isLinkedWorktree, false);
    assert.equal(mainMeta.dirty, false);
    const readMain = readDeployMeta(metaPath);
    assert.equal(readMain.present, true);
    assert.equal(readMain.nonMainWarning, null);

    // 2. wt-cli.mjs new -> list -> deploy guard blocks linked worktree unless allowNonMain -> preview warns on split-brain & clobber -> wt-cli.mjs clean
    const createdOut = execFileSync(
      process.execPath,
      [wtCliPath, 'new', 'fix/cli-smoke', '--repo', mainRepo],
      { encoding: 'utf8' }
    );
    const createdJson = JSON.parse(createdOut);
    assert.equal(createdJson.ok, true);
    assert.equal(createdJson.branch, 'fix/cli-smoke');

    const blockedWtGuard = evaluateDeployGuard(createdJson.worktreePath, { metaPath });
    assert.equal(blockedWtGuard.allowed, false);
    assert.match(blockedWtGuard.reason || '', /LaunchAgent daemon|split-brain/i);
    assert.match(blockedWtGuard.reason || '', /Currently live bundle was deployed from 'main'/);
    assert.match(blockedWtGuard.reason || '', /--preview/);

    // Explicit preview flag permits deploy with daemon split-brain warning & previous-live notice
    const previewGuard = evaluateDeployGuard(createdJson.worktreePath, { allowNonMain: true, metaPath });
    assert.equal(previewGuard.allowed, true);
    assert.equal(previewGuard.preview, true);
    assert.equal(previewGuard.warnings.length, 2);

    const wtMeta = writeDeployMeta(createdJson.worktreePath, metaPath, { preview: true });
    assert.equal(wtMeta.branch, 'fix/cli-smoke');
    assert.equal(wtMeta.isLinkedWorktree, true);
    assert.equal(wtMeta.preview, true);
    const readWt = readDeployMeta(metaPath);
    assert.equal(readWt.present, true);
    assert.match(readWt.nonMainWarning || '', /fix\/cli-smoke/);

    // Drifted primary checkout on non-main branch also blocked by default
    gitSync(mainRepo, ['checkout', '-b', 'feat/drifted']);
    const driftedGuard = evaluateDeployGuard(mainRepo, { metaPath });
    assert.equal(driftedGuard.allowed, false);
    assert.match(driftedGuard.reason || '', /feat\/drifted/);
    gitSync(mainRepo, ['checkout', 'main']);

    const listOut = execFileSync(process.execPath, [wtCliPath, 'list', '--repo', mainRepo], { encoding: 'utf8' });
    const listJson = JSON.parse(listOut);
    assert.equal(listJson.ok, true);
    assert.equal(listJson.worktrees.length, 2);

    const cleanOut = execFileSync(
      process.execPath,
      [wtCliPath, 'clean', 'fix/cli-smoke', '--repo', mainRepo, '--delete-branch'],
      { encoding: 'utf8' }
    );
    const cleanJson = JSON.parse(cleanOut);
    assert.equal(cleanJson.ok, true);
    assert.equal(cleanJson.branchDeleted, true);
    assert.equal(fs.existsSync(createdJson.worktreePath), false);
  } finally {
    fs.rmSync(wtParent, { recursive: true, force: true });
    fs.rmSync(mainRepo, { recursive: true, force: true });
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

test('worktree UI (Topbar, #agy-wt-menu, Cockpit strip, chat badges) & compiled Overview + Sidebar Recents', { skip: skipDom }, async () => {
  const { buildUserCustomJs } = await import(pathToFileURL(path.join(REPO, 'studio', 'build.mjs')).href);
  const { createProjectsModule } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'projects', 'index.mjs')).href
  );

  // Build bundle once to ensure Overview & Sidebar Recents test uses fresh user/custom.js + CSS invariants hold
  const built = await buildUserCustomJs();
  assert.ok(built && built.bytes > 0);
  const customCss = fs.readFileSync(path.join(REPO, 'user', 'custom.css'), 'utf8');
  assert.doesNotMatch(customCss, /:has\(/, 'zero global CSS :has() selectors');
  const recentBranchCssMatch = customCss.match(/#ag-claude-recent-section\s+\.ag-recent-branch\s*\{[^}]*\}/s);
  assert.ok(recentBranchCssMatch && /flex-shrink:\s*0/.test(recentBranchCssMatch[0]), '.ag-recent-branch sets flex-shrink: 0');

  // --- Part A: Direct createProjectsModule interactive flows ---
  const cid = 'conv-ui-11112222';
  const mainPath = '/tmp/maga-ui-repo';
  const wt1Path = '/tmp/maga-ui-repo-wt/wt-1';
  const wt2Path = '/tmp/maga-ui-repo-wt/wt-2';
  const wt3Path = '/tmp/maga-ui-repo-wt/race';

  const domA = new JSDOM(
    `<!doctype html><html><body>
      <div class="bg-sidebar">
        <div class="sb-grand"><div class="sb-parent">
          <div data-testid="conversation-list-sidebar"><div></div></div>
        </div></div>
        <button data-testid="automations-button">Automations</button>
        <a href="/customizations">Skills</a>
      </div>
      <div class="main-pane">
        <div class="flex w-full min-w-0 items-center justify-between overflow-hidden @container/titlebar">
          <div id="native-tb-left">
            <nav aria-label="Breadcrumb"><ol>
              <li><a href="/?project=proj-maga">MAGA</a></li>
              <li><span>Worktree Task</span></li>
            </ol></nav>
          </div>
        </div>
        <div id="antigravity.agentSidePanelInputBox"><textarea></textarea></div>
      </div>
    </body></html>`,
    { url: `http://127.0.0.1/c/${cid}`, pretendToBeVisual: true }
  );

  const w = domA.window;
  const d = w.document;
  const keys = ['window', 'document', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'Node', 'HTMLElement'];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.window = w;
  globalThis.document = d;
  globalThis.location = w.location;
  globalThis.requestAnimationFrame = w.requestAnimationFrame.bind(w);
  globalThis.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  globalThis.Node = w.Node;
  globalThis.HTMLElement = w.HTMLElement;

  try {
    const rpcCalls = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const mockState = {
      sidebarProjects: {
        projects: [{ id: 'proj-maga', name: 'MAGA', folderUris: [`file://${mainPath}`] }],
      },
      trajectorySummaries: {
        summaries: {
          [cid]: {
            annotations: { title: 'Worktree Task' },
            lastModifiedTime: { seconds: nowSec - 10 },
            trajectoryMetadata: { projectId: 'proj-maga' },
            status: 1,
          },
        },
        indexes: { byProject: { 'proj-maga': [cid] } },
      },
    };
    const routerLoc = { pathname: `/c/${cid}`, search: {} };
    const sb = d.querySelector('[data-testid="conversation-list-sidebar"]');
    sb.firstElementChild.__reactFiber$sb = {
      memoizedProps: {
        sidebarStore: { getState: () => mockState, dispatch: () => {}, subscribe: () => () => {} },
        sidebarRouter: { state: { location: routerLoc }, navigate: () => {} },
      },
    };

    let worktreeList = [
      { path: mainPath, realPath: mainPath, branch: 'main', isMain: true, isProtected: true, boundCids: [], collisionCids: [], git: { branch: 'main', changedFiles: 0, added: 0, deleted: 0 }, ahead: 0 },
      { path: wt1Path, realPath: wt1Path, branch: 'feat/wt-1', isMain: false, isProtected: false, boundCids: [{ cid, updatedAt: Date.now() }, { cid: 'peer-cid', updatedAt: Date.now() }], collisionCids: [cid, 'peer-cid'], git: { branch: 'feat/wt-1', changedFiles: 2, added: 5, deleted: 1 }, ahead: 1 },
      { path: wt2Path, realPath: wt2Path, branch: 'feat/wt-2', isMain: false, isProtected: false, boundCids: [], collisionCids: [], git: { branch: 'feat/wt-2', changedFiles: 0, added: 0, deleted: 0 }, ahead: 0 },
    ];
    let convMap = {
      [cid]: { cid, worktreePath: wt1Path, branch: 'feat/wt-1', repoRoot: mainPath, source: 'hook', updatedAt: Date.now() },
    };

    w.__agProjectCall = async (action, payload) => {
      rpcCalls.push({ action, payload });
      if (action === 'getConvWorktreeMap') return { ok: true, entries: convMap };
      if (action === 'listRepoWorktrees') return { ok: true, mainDirPath: mainPath, baseBranch: 'main', worktrees: worktreeList };
      if (action === 'bindConversationWorktree') {
        if (!payload.worktreePath) {
          delete convMap[payload.cid];
          return { ok: true, cid: payload.cid, mode: 'auto', worktreePath: '' };
        }
        const matched = worktreeList.find((x) => x.realPath === payload.worktreePath);
        convMap[payload.cid] = { cid: payload.cid, worktreePath: matched.realPath, branch: matched.branch, repoRoot: mainPath, source: 'manual', updatedAt: Date.now() };
        return { ok: true, cid: payload.cid, mode: 'manual', worktreePath: matched.realPath, branch: matched.branch };
      }
      if (action === 'createRepoWorktree') {
        const branch = `${payload.type}/${payload.slug}`;
        const nw = { path: wt3Path, realPath: wt3Path, branch, isMain: false, isProtected: false, boundCids: [], collisionCids: [], git: { branch, changedFiles: 0, added: 0, deleted: 0 }, ahead: 0 };
        worktreeList = [...worktreeList, nw];
        return { ok: true, worktreePath: wt3Path, branch, baseBranch: 'main', mainDirPath: mainPath };
      }
      if (action === 'removeRepoWorktree') {
        worktreeList = worktreeList.filter((x) => x.realPath !== payload.worktreePath);
        return { ok: true, removedPath: payload.worktreePath, branch: 'feat/wt-2', branchDeleted: false };
      }
      if (action === 'readContext') {
        return { ok: true, dirPath: payload.dirPath, gitBranch: 'main', instructions: '# Rules', files: [], extraFolders: [], scheduledTasks: [] };
      }
      if (action === 'listContexts') {
        return { ok: true, contexts: { [mainPath]: { ok: true, dirPath: mainPath, gitBranch: 'main', instructions: '# Rules', files: [], extraFolders: [], scheduledTasks: [] } }, projectMtimes: {} };
      }
      if (action === 'readProjectWorkspaceStatus') {
        const target = payload.worktreePath || payload.dirPath;
        const wt = worktreeList.find((x) => x.realPath === target) || worktreeList[0];
        return {
          ok: true,
          dirPath: payload.dirPath,
          activeWorktreePath: target,
          git: wt.git,
          worktrees: worktreeList,
          dirtyFiles: [],
          recentCommits: [{ hash: '1234abc', fullHash: '1234abc', subject: 'wt commit', relTime: '1m ago' }],
          scripts: ['test'],
          fetchedAt: Date.now(),
        };
      }
      return { ok: true };
    };

    const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    let scheduledSidebars = 0;
    const rt = {
      FEAT: { projects: true, i18n: false },
      L: (_zh, en) => en,
      state: { disposed: false, projectsViewOpen: false },
      frame: (cb) => setTimeout(cb, 0),
      later: (cb, ms) => setTimeout(cb, ms),
      escapeHtml,
      setLeafText: (el, txt) => { if (el) el.textContent = txt; },
      syncAttrTargetSet: () => {},
      hooks: {
        activeReactFiber: () => null,
        findSidebarBindings: () => ({
          store: { getState: () => mockState, dispatch: () => {}, subscribe: () => () => {} },
          router: { state: { location: routerLoc }, navigate: () => {} },
        }),
        isSidebarVisibleSummary: () => true,
        isSummaryPinned: () => false,
        protoSeconds: (v) => Number(v?.seconds || 0),
        scheduleSidebarSync: () => { scheduledSidebars += 1; },
      },
    };
    const modelApi = {
      displayEffortLabel: (e) => e,
      buildReduxModelSelectorApi: () => null,
      discoverModelSelectorApi: () => null,
      buildModelCatalog: () => ({ primaryFamilies: [], moreFamilies: [] }),
      pickVariantForFamily: () => null,
      formatProjectComposerModelParts: () => ({ name: 'Sonnet', effort: 'High' }),
      syncProjectDetailModelTrigger: () => {},
      applyModelSelectionOption: () => {},
    };

    const projMod = createProjectsModule(rt, modelApi);
    projMod.syncConvProjectTopbar();
    await settle(40);
    projMod.syncConvProjectTopbar();
    await settle(20);

    const gitBtn = d.querySelector('#agy-conv-project-bar .ag-cpb-git');
    assert.ok(gitBtn);
    assert.equal(gitBtn.textContent.trim(), 'feat/wt-1');
    assert.equal(gitBtn.getAttribute('data-worktree'), 'true');
    assert.equal(gitBtn.getAttribute('data-collision'), 'true');
    assert.equal(projMod.getConversationBranchBadge(cid), 'feat/wt-1');

    // Open #agy-wt-menu portal, inspect advisory warning, switch to feat/wt-2
    gitBtn.click();
    const wtMenu = d.getElementById('agy-wt-menu');
    assert.ok(wtMenu && wtMenu.parentElement === d.body);
    assert.equal(wtMenu.getAttribute('data-maga-own'), '1');
    assert.ok(wtMenu.querySelector('.ag-wt-warn'), 'renders advisory collision banner');
    wtMenu.querySelector(`[data-ag-wt-bind="${wt2Path}"]`).click();
    await settle(40);

    const gitBtnAfterBind = d.querySelector('#agy-conv-project-bar .ag-cpb-git');
    assert.equal(gitBtnAfterBind.textContent.trim(), 'feat/wt-2');
    assert.equal(gitBtnAfterBind.hasAttribute('data-collision'), false);
    assert.equal(projMod.getConversationBranchBadge(cid), 'feat/wt-2');

    // Re-opening menu after manual pin exposes Auto tracking reset button
    gitBtnAfterBind.click();
    const wtMenu2 = d.getElementById('agy-wt-menu');
    assert.ok(wtMenu2.querySelector('[data-ag-wt-auto]'), 'manual pin shows Auto reset button');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(d.getElementById('agy-wt-menu'), null);

    // Open Projects Cockpit: check Active Worktrees strip, switch chip, create & 2-step clean, chat branch badge
    projMod.openProjectsView('proj-maga');
    await settle(40);
    const pdView = d.getElementById('ag-claude-projects-view');
    assert.ok(pdView.querySelector('[data-ag-pd-wt-wrap]'), 'mounts Active Worktrees strip');
    assert.equal(pdView.querySelector('.ag-pd-chat-branch')?.textContent.trim(), 'feat/wt-2', 'chat row renders branch micro-badge');

    // Select wt-2 chip -> sends worktreePath to readProjectWorkspaceStatus
    pdView.querySelector(`[data-ag-pd-wt-select="${wt2Path}"]`).click();
    await settle(30);
    assert.ok(
      rpcCalls.some((c) => c.action === 'readProjectWorkspaceStatus' && c.payload?.worktreePath === wt2Path),
      'clicking worktree chip fetches status for selected worktree'
    );

    // Create new worktree via inline form
    pdView.querySelector('[data-ag-pd-wt-create-toggle]').click();
    const form = pdView.querySelector('[data-ag-pd-wt-form]');
    assert.ok(form);
    form.querySelector('[data-ag-pd-wt-type]').value = 'fix';
    form.querySelector('[data-ag-pd-wt-slug]').value = 'race';
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await settle(40);
    assert.ok(
      rpcCalls.some((c) => c.action === 'createRepoWorktree' && c.payload?.type === 'fix' && c.payload?.slug === 'race'),
      'submitting + Worktree form dispatches createRepoWorktree RPC'
    );

    // Two-step clean remove on clean non-bound wt-2 (or wait: cid is now pinned to wt2, let's check wt1/wt2 or confirm)
    // Unbind cid back to wt1 via convMap cleanup so wt-2 has no active conv, then test two-step remove
    convMap[cid] = { cid, worktreePath: wt1Path, branch: 'feat/wt-1', source: 'hook', updatedAt: Date.now() };
    worktreeList = worktreeList.map((x) => (x.realPath === wt2Path ? { ...x, boundCids: [] } : x));
    pdView.querySelector('[data-ag-pd-wt-del="' + wt2Path + '"]').click();
    const confirmBtn = pdView.querySelector('[data-ag-pd-wt-del-confirm="' + wt2Path + '"]');
    assert.ok(confirmBtn, 'two-step delete requires confirmation click');
    confirmBtn.click();
    await settle(40);
    assert.ok(
      rpcCalls.some((c) => c.action === 'removeRepoWorktree' && c.payload?.worktreePath === wt2Path),
      'confirming removal calls removeRepoWorktree RPC'
    );
    assert.ok(scheduledSidebars >= 1);
    projMod.dispose();
  } finally {
    domA.window.close();
    for (const [k, desc] of prev) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  }

  // --- Part B: Compiled user/custom.js bundle verifies Overview Worktree + Sidebar Recents badge ---
  const cidOvA = 'aaaaaaaa-1111-4222-8333-444444444441';
  const cidOvB = 'bbbbbbbb-1111-4222-8333-444444444442';
  const projDir = '/tmp/ov-wt-main';
  const wtDir = '/tmp/ov-wt-main-wt/ov-wt';

  const domB = new JSDOM(
    `<!doctype html><html><body><div id="root">
      <div class="bg-sidebar">
        <div class="sb-grand flex-1"><div class="sb-parent">
          <div data-testid="conversation-list-sidebar"><div></div></div>
        </div></div>
      </div>
      <div id="antigravity.agentSidePanelInputBox">
        <button type="button" data-testid="model-selector-trigger">Gemini 4 Neon</button>
      </div>
      <div data-testid="overview-panel" class="flex flex-auto w-full min-h-0 flex-col">
        <div class="flex shrink-0 flex-col px-1 pt-1 pb-px"><span>Overview</span></div>
        <div class="flex flex-col overflow-y-auto w-full flex-grow min-h-0">
          <div class="flex flex-col gap-px px-1 pb-1">
            <button type="button" data-testid="overview-panel-row-review"><span>Review</span><span data-testid="overview-panel-row-review-detail"></span></button>
            <button type="button" data-testid="overview-panel-row-files"><span>Files</span></button>
            <button type="button" data-testid="overview-panel-row-terminal"><span>Terminal</span></button>
            <button type="button" data-testid="overview-panel-row-plugins"><span>Plugins</span></button>
          </div>
          <div class="p-1"><span class="agy-hover-label">Artifact</span></div>
        </div>
      </div>
    </div></body></html>`,
    { url: `https://127.0.0.1:62683/c/${cidOvA}`, pretendToBeVisual: true, runScripts: 'outside-only' }
  );

  try {
    const bw = domB.window;
    const bd = bw.document;
    bw.localStorage.setItem(
      'ag_claude_ux_modules_v1',
      JSON.stringify({ claudeUxHideSidebarProjects: true, claudeUxRecentSection: true, claudeUxOverviewPanel: true })
    );
    const nowSec = Math.floor(Date.now() / 1000);
    const sbStore = {
      getState: () => ({
        sidebarProjects: { projects: [{ id: 'proj-ov', name: 'DemoProj', folderUris: [`file://${projDir}`], archived: false }] },
        trajectorySummaries: {
          summaries: {
            [cidOvA]: { annotations: { title: 'WT Chat A' }, lastModifiedTime: { seconds: nowSec - 10 }, trajectoryMetadata: { projectId: 'proj-ov' }, status: 1 },
            [cidOvB]: { annotations: { title: 'Main Chat B' }, lastModifiedTime: { seconds: nowSec - 50 }, trajectoryMetadata: { projectId: 'proj-ov' }, status: 1 },
          },
        },
      }),
      subscribe: () => () => {},
      dispatch: () => {},
    };
    bd.querySelector('.bg-sidebar').__reactFiber$s = { memoizedProps: { sidebarStore: sbStore }, return: null };
    bd.querySelector('[data-testid="conversation-list-sidebar"]').firstElementChild.__reactFiber$list = {
      memoizedProps: { sidebarStore: sbStore, sidebarRouter: { state: { location: { pathname: `/c/${cidOvA}` } }, navigate: () => {} } },
      return: null,
    };

    const ovCalls = [];
    bw.__agProjectCall = async (action, payload) => {
      ovCalls.push({ action, payload });
      if (action === 'getConvWorktreeMap') {
        return {
          ok: true,
          entries: {
            [cidOvA]: { cid: cidOvA, worktreePath: wtDir, branch: 'feat/ov-wt', repoRoot: projDir, source: 'hook', updatedAt: Date.now() },
          },
        };
      }
      if (action === 'getOverviewSnapshot') {
        return {
          ok: true,
          workspace: {
            dirPath: payload.cid === cidOvA ? wtDir : projDir,
            mainDirPath: projDir,
            worktreePath: payload.cid === cidOvA ? wtDir : projDir,
            isWorktree: payload.cid === cidOvA,
            worktreeSource: payload.cid === cidOvA ? 'hook' : 'default',
            worktreeCount: 2,
            collisionCids: [],
            name: 'DemoProj',
            git: {
              branch: payload.cid === cidOvA ? 'feat/ov-wt' : 'main',
              added: payload.cid === cidOvA ? 7 : 0,
              deleted: payload.cid === cidOvA ? 2 : 0,
              changedFiles: payload.cid === cidOvA ? 1 : 0,
            },
          },
          rules: [{ label: 'AGENTS.md', path: `${projDir}/AGENTS.md`, scope: 'project', bytes: 64 }],
          skills: { total: 0, userCount: 0, items: [] },
          agents: { total: 0, items: [] },
          connectors: [],
        };
      }
      return { ok: true };
    };
    bw.__ag_render_metrics = () => {};
    bw.eval(fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8'));
    bw.__ag_render_metrics({ cascadeId: cidOvA, hasData: false, inlineHtml: '', tooltipHtml: '' });
    await settle(60);

    // 1. Overview shows worktree `wt` badge, worktree path, and keeps AGENTS.md edit button on main repo
    const ovSec = bd.getElementById('ag-claude-ov-sections');
    assert.ok(ovSec, 'Overview sections mounted');
    assert.equal(ovSec.querySelector('.ag-ov-wt-tag')?.textContent.trim(), 'wt');
    assert.match(ovSec.querySelector('.ag-ov-git-pill')?.textContent || '', /feat\/ov-wt/);
    assert.equal(ovSec.querySelector('[data-ag-ov-action="copy-path"]')?.getAttribute('title'), wtDir);
    assert.ok(ovSec.querySelector('[data-ag-ov-action="edit-rules"]'), 'retains Edit AGENTS.md on main repo');

    // Cache isolation per (dirPath, cid): navigating to cidOvB sends a fresh getOverviewSnapshot with cidOvB
    bw.history.pushState(null, '', `/c/${cidOvB}`);
    bw.__ag_render_metrics({ cascadeId: cidOvB, hasData: false, inlineHtml: '', tooltipHtml: '' });
    await settle(60);
    assert.ok(ovCalls.some((c) => c.action === 'getOverviewSnapshot' && c.payload?.cid === cidOvA));
    assert.ok(ovCalls.some((c) => c.action === 'getOverviewSnapshot' && c.payload?.cid === cidOvB));
    assert.equal(ovSec.querySelector('.ag-ov-wt-tag'), null, 'main conversation omits wt tag');
    assert.match(ovSec.querySelector('.ag-ov-git-pill')?.textContent || '', /main/);

    // 2. Sidebar unified Recents shows `.ag-recent-branch` ONLY on worktree conversation (zero per-row RPCs)
    const rowA = bd.querySelector(`#ag-claude-recent-section [data-ag-recent-id="${cidOvA}"]`);
    const rowB = bd.querySelector(`#ag-claude-recent-section [data-ag-recent-id="${cidOvB}"]`);
    assert.ok(rowA && rowB);
    assert.equal(rowA.querySelector('.ag-recent-branch')?.textContent.trim(), 'feat/ov-wt');
    assert.equal(rowB.querySelector('.ag-recent-branch'), null, 'main-branch chat omits branch micro-badge in Recents');
    assert.equal(ovCalls.filter((c) => c.action === 'getConvWorktreeMap').length <= 1, true, 'zero per-row worktree RPCs');

    bw.__agClaudeUxDispose?.();
  } finally {
    domB.window.close();
  }
});
