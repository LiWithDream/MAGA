import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  buildWinCimCreateScript,
  parseWinLaunchExtraArgs,
  parseWinMainProcesses,
  quoteWinArg,
  quoteWinCommandLine,
  tokenizeWinCommandLine,
  waitForWinRelaunchReady,
} = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'cdp-bootstrap-win.mjs')).href);

const {
  WIN_TASK_NAME,
  buildWinScheduledTaskXml,
  buildWinStartupVbs,
  encodePowerShellBase64,
  encodeUtf16LeWithBom,
  ensureWinCoreDaemon,
  findWinAntigravityDesktopExe,
  getWinAntigravityFingerprint,
  inspectWinCoreDaemon,
  isAntigravityDesktopExe,
  parseWinInternetSettingsReg,
  parseWinScheduledTaskXml,
  parseWinStartupVbs,
  readVersionFromAsar,
  stableWinNodePath,
} = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'win-service.mjs')).href);

const { installWinHeadlessLogTee, renameWithWinRetry } = await import(
  pathToFileURL(path.join(REPO, 'core', 'daemon', 'env.mjs')).href
);

const {
  checkStopSignal,
  requestCooperativeStop,
} = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'pid.mjs')).href);

const {
  extractGitInvocations,
  extractInlineShellString,
  extractWriteRedirectTargets,
  getShellSegmentWriteInfo,
  isGitBinary,
  resolveDirectoryChange,
  splitShellSegments,
  tokenizeSegment,
} = await import(
  pathToFileURL(path.join(REPO, 'studio', 'plugin', 'maga-git-workflow', 'lib', 'shell-parser.mjs')).href
);

const {
  createRepoWorktreeCore,
  removeRepoWorktreeCore,
} = await import(
  pathToFileURL(path.join(REPO, 'studio', 'plugin', 'maga-git-workflow', 'lib', 'worktree-core.mjs')).href
);

const {
  buildPinnedHooksJsonForPlugin,
  extractPluginHookNodeBin,
  formatPinnedHookCommand,
} = await import(pathToFileURL(path.join(REPO, 'studio', 'daemon', 'plugin-sync.mjs')).href);

const { buildPinnedOpusGateHooksJson } = await import(
  pathToFileURL(path.join(REPO, 'studio', 'daemon', 'opus-gate-service.mjs')).href
);

const { evaluateHookEvent } = await import(
  pathToFileURL(path.join(REPO, 'studio', 'plugin', 'maga-opus-gate', 'hooks', 'gate-check.mjs')).href
);

const { evaluateDeployGuard } = await import(pathToFileURL(path.join(REPO, 'studio', 'deploy-meta.mjs')).href);

const { packRelease } = await import(pathToFileURL(path.join(REPO, 'studio', 'pack-release.mjs')).href);

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

function createTempGitRepo(branch = 'main') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-win-wt-repo-'));
  execFileSync('git', ['init', '-b', branch, dir], { stdio: 'ignore' });
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# hello\n', 'utf8');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return fs.realpathSync(dir);
}

test('Windows CommandLineToArgvW tokenizer and quoter round-trip complex paths & flags', () => {
  const cases = [
    [
      'C:\\Program Files (x86)\\Antigravity\\Antigravity.exe',
      '--proxy-server=http://127.0.0.1:7890',
      '--remote-debugging-port=0',
    ],
    [
      'C:\\Users\\张 三\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
      'C:\\repo with spaces\\trailing\\',
      'val"with"quotes',
      'meta%var^&!()',
      '',
    ],
  ];
  for (const argv of cases) {
    const cmdLine = quoteWinCommandLine(argv);
    const parsed = tokenizeWinCommandLine(cmdLine);
    assert.deepEqual(parsed, argv, `Round-trip failed for ${cmdLine}`);
  }
  assert.equal(quoteWinArg('C:\\no-spaces\\node.exe'), 'C:\\no-spaces\\node.exe');
});

test('parseWinLaunchExtraArgs strips exe and debug port while preserving proxy flags and detecting custom profiles', () => {
  const normal = parseWinLaunchExtraArgs(
    '"C:\\Program Files\\Antigravity\\Antigravity.exe" --proxy-server http://127.0.0.1:7890 --remote-debugging-port=9222'
  );
  assert.deepEqual(normal.extraArgs, ['--proxy-server', 'http://127.0.0.1:7890']);
  assert.equal(normal.hasCustomProfile, false);
  assert.equal(normal.hasAmbiguousArgs, false);

  const custom = parseWinLaunchExtraArgs(
    '"C:\\Program Files\\Antigravity\\Antigravity.exe" --user-data-dir="C:\\Temp\\prof"'
  );
  assert.equal(custom.hasCustomProfile, true);

  const amb = parseWinLaunchExtraArgs('"C:\\Program Files\\Antigravity\\Antigravity.exe" nonexistent-arg');
  assert.equal(amb.hasAmbiguousArgs, true);
});

test('isAntigravityDesktopExe & parseWinMainProcesses distinguish Desktop from IDE and child processes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-win-app-'));
  try {
    const desktopDir = path.join(tmp, 'Local', 'Programs', 'Antigravity');
    const desktopExe = path.join(desktopDir, 'Antigravity.exe');
    fs.mkdirSync(path.join(desktopDir, 'resources'), { recursive: true });
    fs.writeFileSync(desktopExe, 'mz', 'utf8');
    fs.writeFileSync(path.join(desktopDir, 'resources', 'app.asar'), 'asar', 'utf8');
    fs.writeFileSync(path.join(desktopDir, 'resources', 'app-update.yml'), 'version: 2.33.1\n', 'utf8');

    const ideDir = path.join(tmp, 'IDE', 'Antigravity');
    const ideExe = path.join(ideDir, 'Antigravity.exe');
    fs.mkdirSync(path.join(ideDir, 'resources', 'app', 'out', 'vs'), { recursive: true });
    fs.writeFileSync(ideExe, 'mz', 'utf8');
    fs.writeFileSync(path.join(ideDir, 'resources', 'app', 'product.json'), '{"nameShort":"Antigravity"}', 'utf8');

    assert.equal(isAntigravityDesktopExe(desktopExe), true);
    assert.equal(isAntigravityDesktopExe(ideExe), false);
    assert.equal(
      isAntigravityDesktopExe(ideExe, { env: { AGY_APP_EXE: ideExe } }),
      true,
      'explicit AGY_APP_EXE override is honored'
    );

    const found = findWinAntigravityDesktopExe({
      home: tmp,
      env: { LOCALAPPDATA: path.join(tmp, 'Local'), ProgramFiles: path.join(tmp, 'PF') },
    });
    assert.equal(found, desktopExe);

    const fp = getWinAntigravityFingerprint({
      home: tmp,
      env: { LOCALAPPDATA: path.join(tmp, 'Local'), ProgramFiles: path.join(tmp, 'PF') },
    });
    assert.equal(fp.version, '2.33.1');
    assert.equal(fp.exePath, desktopExe);
    assert.match(fp.sig, /^2\.33\.1\|\d+:\d+$/);

    const nowMs = 1_700_000_050_000;
    const rawJson = JSON.stringify([
      {
        ProcessId: 101,
        ExecutablePath: ideExe,
        CommandLine: `"${ideExe}"`,
        CreatedMs: nowMs - 5000,
      },
      {
        ProcessId: 102,
        ExecutablePath: desktopExe,
        CommandLine: `"${desktopExe}" --type=renderer --field=1`,
        CreatedMs: nowMs - 5000,
      },
      {
        ProcessId: 103,
        ExecutablePath: desktopExe,
        CommandLine: `"${desktopExe}" --proxy-server=http://127.0.0.1:7890`,
        CreatedMs: nowMs - 6000,
      },
    ]);
    const procs = parseWinMainProcesses(rawJson, { nowMs });
    assert.equal(procs.length, 1);
    assert.equal(procs[0].pid, 103);
    assert.equal(procs[0].hasCdp, false);
    assert.equal(Math.round(procs[0].age), 6);
    assert.deepEqual(procs[0].extraArgs, ['--proxy-server=http://127.0.0.1:7890']);

    // Single object JSON returned by PowerShell ConvertTo-Json when only 1 process matches
    const single = parseWinMainProcesses(
      JSON.stringify({
        ProcessId: 204,
        ExecutablePath: desktopExe,
        CommandLine: `"${desktopExe}" --remote-debugging-port=0`,
        CreatedMs: nowMs - 4000,
      }),
      { nowMs }
    );
    assert.equal(single.length, 1);
    assert.equal(single[0].pid, 204);
    assert.equal(single[0].hasCdp, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('waitForWinRelaunchReady waits for exit & lockfile release, and launches anyway if lockfile times out', async () => {
  let aliveChecks = 0;
  let lockChecks = 0;
  let opened = 0;
  const ok = await waitForWinRelaunchReady({
    targetPid: 4242,
    isProcessAlive: () => ++aliveChecks < 2,
    listMainProcs: async () => [],
    hasLockfile: () => ++lockChecks < 3,
    onReadyToOpen: async () => {
      opened += 1;
      return true;
    },
    sleepFn: async () => {},
    pollMs: 1,
    initialSettleMs: 0,
  });
  assert.deepEqual(ok, { relaunched: true });
  assert.equal(opened, 1);

  const lockedTimeout = await waitForWinRelaunchReady({
    targetPid: 4242,
    isProcessAlive: () => false,
    listMainProcs: async () => [],
    hasLockfile: () => true,
    onReadyToOpen: async () => {
      opened += 1;
      return true;
    },
    sleepFn: async () => {},
    nowFn: (() => {
      let t = 0;
      return () => (t += 3000);
    })(),
    lockTimeoutMs: 5000,
    pollMs: 1,
    initialSettleMs: 0,
  });
  assert.deepEqual(lockedTimeout, { relaunched: true, reason: 'lockfile_timeout_launched' });
  assert.equal(opened, 2);

  const exitTimeout = await waitForWinRelaunchReady({
    targetPid: 4242,
    isProcessAlive: () => true,
    listMainProcs: async () => [],
    hasLockfile: () => true,
    onReadyToOpen: async () => {
      opened += 1;
      return true;
    },
    sleepFn: async () => {},
    nowFn: (() => {
      let t = 0;
      return () => (t += 5000);
    })(),
    exitTimeoutMs: 4000,
    pollMs: 1,
    initialSettleMs: 0,
  });
  assert.deepEqual(exitTimeout, { relaunched: false, reason: 'exit_timeout' });
  assert.equal(opened, 2, 'must not launch duplicate instance when target process never exited');
});

test('Windows Scheduled Task XML, UTF-16LE BOM, VBS parser, CIM script, and Proxy reg parser work cleanly', () => {
  const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
  const daemonScript = 'C:\\Users\\张三\\AppData\\Local\\agy-studio\\core\\daemon.mjs';
  const userDir = 'C:\\Users\\张三\\.gemini\\antigravity\\anti-claude\\user';

  const xml = buildWinScheduledTaskXml({
    nodePath,
    daemonScript,
    userDir,
    userId: 'PC\\张三',
  });
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /<Interval>PT5M<\/Interval>/);
  assert.match(xml, /<Command>%SystemRoot%\\System32\\conhost\.exe<\/Command>/);
  assert.match(xml, /--headless &quot;/);

  const bomBuf = encodeUtf16LeWithBom(xml);
  assert.equal(bomBuf[0], 0xff);
  assert.equal(bomBuf[1], 0xfe);
  assert.equal(bomBuf.subarray(2).toString('utf16le'), xml);

  const parsedXml = parseWinScheduledTaskXml(xml);
  assert.equal(parsedXml.nodePath, nodePath);
  assert.equal(parsedXml.scriptPath, daemonScript);
  assert.equal(parsedXml.userDir, userDir);

  const vbs = buildWinStartupVbs(nodePath, daemonScript, userDir);
  const parsedVbs = parseWinStartupVbs(vbs);
  assert.equal(parsedVbs.nodePath, nodePath);
  assert.equal(parsedVbs.scriptPath, daemonScript);
  assert.equal(parsedVbs.userDir, userDir);

  const cimScript = buildWinCimCreateScript('"C:\\App\\Antigravity.exe" --remote-debugging-port=0', "C:\\O'Brien\\App");
  assert.match(cimScript, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(cimScript, /C:\\O''Brien\\App/);
  const b64 = encodePowerShellBase64(cimScript);
  assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), cimScript);

  const regOut = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7890
    AutoConfigURL  REG_SZ    http://127.0.0.1:7891/pac.js
`;
  assert.deepEqual(parseWinInternetSettingsReg(regOut), {
    httpEnabled: true,
    httpsEnabled: true,
    socksEnabled: false,
    pacEnabled: true,
    proxyServer: '127.0.0.1:7890',
    pacUrl: 'http://127.0.0.1:7891/pac.js',
  });
  assert.equal(WIN_TASK_NAME, 'AGYStudioDaemon');

  // Volta stable node path preference
  const fakeVoltaExec = 'C:\\Users\\alice\\AppData\\Local\\Volta\\tools\\image\\node\\22.14.0\\node.exe';
  const fakeVoltaShim = 'C:\\Users\\alice\\AppData\\Local\\Volta\\bin\\node.exe';
  assert.equal(
    stableWinNodePath(fakeVoltaExec, {
      env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
      existsSync: (p) => p === fakeVoltaShim,
      realpathSync: (p) => p,
    }),
    fakeVoltaShim
  );

  // fnm ephemeral multishell junction must resolve to persistent realExec
  const fnmEphemeral = 'C:\\Users\\alice\\AppData\\Local\\fnm_multishells\\12345_1700000\\node.exe';
  const fnmReal = 'C:\\Users\\alice\\AppData\\Roaming\\fnm\\node-versions\\v22.14.0\\installation\\node.exe';
  assert.equal(
    stableWinNodePath(fnmEphemeral, {
      env: {},
      existsSync: () => false,
      realpathSync: (p) => (p === fnmEphemeral ? fnmReal : p),
    }),
    fnmReal
  );

  // ensureWinCoreDaemon ends lingering Running task before /Run and falls back if no PID appears
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-win-svc-'));
  try {
    const calls = [];
    const res = ensureWinCoreDaemon({
      nodePath,
      daemonScript,
      userDir: path.join(dir, 'user'),
      stateDir: dir,
      pidFile: path.join(dir, 'daemon.pid'),
      stopFile: path.join(dir, 'daemon-stop.signal'),
      metaFile: path.join(dir, 'win-daemon-meta.json'),
      vbsPath: path.join(dir, 'Daemon.vbs'),
      shortcutPath: path.join(dir, 'Shortcut.lnk'),
      createShortcut: false,
      waitPidTimeoutMs: 0,
      sleepFn: () => {},
      execFileSyncFn: (_cmd, args) => {
        calls.push(args[0]);
      },
      spawnDetachedFn: () => 9876,
    });
    assert.deepEqual(calls, ['/Create', '/End', '/Run']);
    assert.equal(res.pid, 9876);

    // inspectWinCoreDaemon recovers from OEM codepage replacement chars (\uFFFD) via meta fallback
    const goodMeta = path.join(dir, 'meta-oem.json');
    const fakeNode = path.join(dir, 'node.exe');
    const fakeDaemon = path.join(dir, 'daemon.mjs');
    fs.writeFileSync(fakeNode, '', 'utf8');
    fs.writeFileSync(fakeDaemon, '', 'utf8');
    fs.writeFileSync(
      goodMeta,
      JSON.stringify({ mode: 'schtasks', nodePath: fakeNode, scriptPath: fakeDaemon, userDir }),
      'utf8'
    );
    const mangledXml = xml.replace(daemonScript, 'C:\\Users\\\uFFFD\uFFFD\\daemon.mjs');
    const inspected = inspectWinCoreDaemon({
      pidFile: path.join(dir, 'missing.pid'),
      metaFile: goodMeta,
      vbsPath: path.join(dir, 'missing.vbs'),
      execFileSyncFn: () => mangledXml,
    });
    assert.equal(inspected.scriptPath, fakeDaemon);
    assert.equal(inspected.scriptExists, true);

    // renameWithWinRetry default maxAttempts (10) survives brief Defender locks
    let renameTries = 0;
    renameWithWinRetry('a', 'b', {
      platform: 'win32',
      backoffMs: 1,
      renameFn: () => {
        renameTries += 1;
        if (renameTries < 8) {
          const e = new Error('locked');
          e.code = 'EBUSY';
          throw e;
        }
      },
    });
    assert.equal(renameTries, 8);

    // fsImpl injection allows testing raw Win32 paths without touching host disk, while uninjected POSIX calls reject C:\ paths
    const memFiles = new Map();
    const mockFs = {
      existsSync: (p) => memFiles.has(p),
      mkdirSync: () => {},
      writeFileSync: (p, c) => memFiles.set(p, c),
      readFileSync: (p) => memFiles.get(p) || '',
      rmSync: (p) => memFiles.delete(p),
      readdirSync: () => [],
    };
    const mockRes = ensureWinCoreDaemon({
      nodePath,
      daemonScript,
      userDir,
      stateDir: 'C:\\Users\\张三\\.gemini\\antigravity\\anti-claude',
      pidFile: 'C:\\Users\\张三\\.gemini\\antigravity\\anti-claude\\daemon.pid',
      stopFile: 'C:\\Users\\张三\\.gemini\\antigravity\\anti-claude\\daemon-stop.signal',
      metaFile: 'C:\\Users\\张三\\.gemini\\antigravity\\anti-claude\\win-daemon-meta.json',
      vbsPath: 'C:\\Users\\张三\\Startup\\Daemon.vbs',
      shortcutPath: 'C:\\Users\\张三\\Start Menu\\AGY.lnk',
      createShortcut: false,
      waitPidTimeoutMs: 0,
      sleepFn: () => {},
      execFileSyncFn: () => {},
      spawnDetachedFn: () => 5555,
      fsImpl: mockFs,
    });
    assert.equal(mockRes.ok, true);
    assert.equal(mockRes.pid, 5555);
    assert.equal(memFiles.has('C:\\Users\\张三\\.gemini\\antigravity\\anti-claude\\win-daemon-meta.json'), true);

    if (process.platform !== 'win32') {
      assert.throws(
        () =>
          ensureWinCoreDaemon({
            nodePath,
            daemonScript,
            userDir,
            stateDir: 'C:\\Users\\张三\\.gemini\\antigravity\\anti-claude',
          }),
        /Refusing to write Windows path/
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cooperative stop signal matches target PID and invokes graceful stop handler', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-win-stop-'));
  try {
    const stopFile = path.join(dir, 'daemon-stop.signal');
    const pidFile = path.join(dir, 'daemon.pid');
    let stoppedCount = 0;

    requestCooperativeStop(99999999, { stopFile });
    assert.equal(
      checkStopSignal({
        stopFile,
        pidFile,
        onStop: () => {
          stoppedCount += 1;
        },
      }),
      false,
      'mismatched targetPid must be ignored'
    );
    assert.equal(fs.existsSync(stopFile), true);
    assert.equal(stoppedCount, 0);

    requestCooperativeStop(process.pid, { stopFile });
    assert.equal(
      checkStopSignal({
        stopFile,
        pidFile,
        onStop: () => {
          stoppedCount += 1;
        },
      }),
      true
    );
    assert.equal(stoppedCount, 1);
    assert.equal(fs.existsSync(stopFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shell-parser Windows dialect preserves backslashes, catches cmd/powershell inline git, and detects Windows mutators', () => {
  const winTokens = tokenizeSegment('"C:\\Users\\alice\\my repo\\" && git.exe status', null, 'win32');
  assert.equal(winTokens[0], 'C:\\Users\\alice\\my repo\\');

  const segs = splitShellSegments('cd /d "C:\\Users\\alice\\repo\\" && git.exe push --force origin main', 'win32');
  assert.equal(segs.length, 2);
  assert.equal(segs[0], 'cd /d "C:\\Users\\alice\\repo\\"');

  const invCmd = extractGitInvocations(
    'cmd.exe /d /c "git.exe push --force origin main"',
    'C:\\Users\\alice\\repo',
    'win32'
  );
  assert.equal(invCmd.length, 1);
  assert.equal(invCmd[0].subcommand, 'push');
  assert.deepEqual(invCmd[0].subArgs, ['--force', 'origin', 'main']);

  const psEncoded = encodePowerShellBase64('git reset --hard HEAD~1');
  const invPsEnc = extractGitInvocations(
    `powershell.exe -NoProfile -EncodedCommand ${psEncoded}`,
    'C:\\Users\\alice\\repo',
    'win32'
  );
  assert.equal(invPsEnc.length, 1);
  assert.equal(invPsEnc[0].subcommand, 'reset');

  assert.equal(isGitBinary('C:\\Program Files\\Git\\cmd\\git.exe', 'win32'), true);
  assert.equal(
    extractInlineShellString(['powershell.exe', '-NoProfile', '-Command', 'git status'], 'win32'),
    'git status'
  );
  assert.equal(getShellSegmentWriteInfo(['del', '/Q', 'foo.txt'], 'del /Q foo.txt', 'win32').mutating, true);
  assert.equal(
    getShellSegmentWriteInfo(['Remove-Item', '-Force', 'foo.txt'], 'Remove-Item -Force foo.txt', 'win32').mutating,
    true
  );
  assert.equal(
    getShellSegmentWriteInfo(['Set-Content', 'foo.txt', 'bar'], 'Set-Content foo.txt bar', 'win32').mutating,
    true
  );
  assert.deepEqual(extractWriteRedirectTargets('echo hi > C:\\temp\\out.txt > NUL', 'win32'), ['C:\\temp\\out.txt']);
});

test('removeRepoWorktreeCore unlinks node_modules link before git worktree remove and restores on failure', async () => {
  const mainRepo = createTempGitRepo('main');
  const wtParent = `${mainRepo}-wt`;
  try {
    const nmDir = path.join(mainRepo, 'node_modules', 'dummy-pkg');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'export default 1;\n', 'utf8');

    const mainEntry = { realPath: mainRepo, branch: 'main', isMain: true };
    const created = await createRepoWorktreeCore(mainEntry, {
      type: 'feat',
      slug: 'safe-nm',
      baseBranch: 'main',
    });
    assert.equal(created.ok, true, created.error);

    const wtNm = path.join(created.worktreePath, 'node_modules');
    assert.equal(fs.lstatSync(wtNm).isSymbolicLink(), true);

    // Dirty worktree -> removeRepoWorktreeCore fails, but MUST restore node_modules link
    fs.writeFileSync(path.join(created.worktreePath, 'dirty.txt'), 'dirty\n', 'utf8');
    const failedRm = await removeRepoWorktreeCore(
      mainEntry,
      [{ realPath: created.worktreePath, path: created.worktreePath, branch: 'feat/safe-nm', isMain: false }],
      { worktreePath: created.worktreePath }
    );
    assert.equal(failedRm.ok, false);
    assert.equal(fs.lstatSync(wtNm).isSymbolicLink(), true, 'junction/symlink restored when remove fails');

    // Clean worktree -> remove succeeds and primary node_modules remains completely intact
    fs.rmSync(path.join(created.worktreePath, 'dirty.txt'), { force: true });
    const okRm = await removeRepoWorktreeCore(
      mainEntry,
      [{ realPath: created.worktreePath, path: created.worktreePath, branch: 'feat/safe-nm', isMain: false }],
      { worktreePath: created.worktreePath, deleteBranch: true }
    );
    assert.equal(okRm.ok, true, okRm.detail);
    assert.equal(fs.existsSync(path.join(nmDir, 'index.js')), true, 'primary node_modules untouched');
  } finally {
    fs.rmSync(wtParent, { recursive: true, force: true });
    fs.rmSync(mainRepo, { recursive: true, force: true });
  }
});

test('plugin-sync & opus-gate handle Windows paths with spaces, parens, and backslashes cleanly', () => {
  const shortCmd = formatPinnedHookCommand(
    'node ./hooks/gate-check.mjs',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    {
      platform: 'win32',
      resolveShortPathFn: () => 'C:\\PROGRA~2\\nodejs\\node.exe',
    }
  );
  assert.equal(shortCmd, 'C:\\PROGRA~2\\nodejs\\node.exe ./hooks/gate-check.mjs');
  assert.equal(
    extractPluginHookNodeBin('maga-opus-gate', {
      'maga-opus-gate': { Stop: [{ type: 'command', command: shortCmd }] },
    }),
    'C:\\PROGRA~2\\nodejs\\node.exe'
  );

  const quotedCmd = formatPinnedHookCommand(
    'node ./hooks/gate-check.mjs',
    'C:\\Program Files\\nodejs\\node.exe',
    { platform: 'win32', resolveShortPathFn: null }
  );
  assert.equal(quotedCmd, '"C:\\Program Files\\nodejs\\node.exe" ./hooks/gate-check.mjs');
  assert.equal(
    extractPluginHookNodeBin('maga-opus-gate', {
      'maga-opus-gate': { Stop: [{ type: 'command', command: quotedCmd }] },
    }),
    'C:\\Program Files\\nodejs\\node.exe'
  );

  const rawHooks = fs.readFileSync(path.join(REPO, 'studio', 'plugin', 'maga-opus-gate', 'hooks.json'), 'utf8');
  const pinnedHooks = JSON.parse(buildPinnedOpusGateHooksJson(rawHooks, 'C:\\nodejs\\node.exe'));
  assert.match(pinnedHooks['maga-opus-gate'].Stop[0].command, /node\.exe.*gate-check\.mjs/);
});

test('packRelease builds Windows zip archive with PowerShell installers and prebuilt bundles', async () => {
  const distOut = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-win-dist-'));
  try {
    const res = await packRelease({ outDir: distOut, platform: 'windows' });
    assert.equal(res.ok, true);
    assert.equal(res.platform, 'windows');
    assert.ok(res.archive.endsWith('-windows.zip'));
    assert.equal(fs.existsSync(res.archive), true);
    assert.equal(fs.existsSync(res.sha256File), true);
    assert.ok(res.bytes > 10000);

    // Inspect zip entries via tar (bsdtar on Windows/macOS lists zip archives cleanly) or unzip -l
    let listOut = '';
    if (process.platform === 'win32') {
      listOut = execFileSync('tar', ['-tf', res.archive], { encoding: 'utf8', windowsHide: true });
    } else {
      listOut = execFileSync('unzip', ['-Z1', res.archive], { encoding: 'utf8' });
    }
    const entries = listOut.split(/\r?\n/).filter(Boolean);
    assert.ok(entries.some((e) => e.endsWith('/install.ps1')), 'zip contains install.ps1');
    assert.ok(entries.some((e) => e.endsWith('/uninstall.ps1')), 'zip contains uninstall.ps1');
    assert.ok(entries.some((e) => e.endsWith('/user/custom.js')), 'zip contains prebuilt user/custom.js');
    assert.ok(entries.some((e) => e.endsWith('/studio/prebuilt/studio-entry.js')), 'zip contains prebuilt studio-entry.js');
    assert.equal(
      entries.some((e) => /(^|\/)(node_modules|\.git|test|studio-prefs\.json)(\/|$)/.test(e)),
      false,
      'zip excludes dev/test/personal files'
    );
  } finally {
    fs.rmSync(distOut, { recursive: true, force: true });
    fs.rmSync(path.join(REPO, 'studio', 'prebuilt'), { recursive: true, force: true });
  }
});

test('install.ps1 and uninstall.ps1 isolate scope via & { } and guard exit for irm | iex execution', () => {
  const installPs1 = fs.readFileSync(path.join(REPO, 'install.ps1'), 'utf8');
  const uninstallPs1 = fs.readFileSync(path.join(REPO, 'uninstall.ps1'), 'utf8');
  assert.match(installPs1, /\[switch\]\$DryRun/);
  assert.match(installPs1, /\[switch\]\$NoRules/);
  assert.match(installPs1, /\[switch\]\$NoShortcut/);
  assert.match(installPs1, /\[switch\]\$Preview/);
  assert.match(installPs1, /\[switch\]\$Force/);
  assert.match(installPs1, /\[string\]\$Channel/);
  assert.match(installPs1, /AGY_STUDIO_RELEASE_TAG/);
  assert.match(installPs1, /STABLE_TAG_RE\s*=\s*\/\^v\(\\d\+\)\\\.\(\\d\+\)\\\.\(\\d\+\)\$\//);
  assert.doesNotMatch(installPs1, /expectedMajor|major > expectedMajor/);
  assert.match(installPs1, /releases\/latest/);
  assert.match(installPs1, /checkout --detach/);
  assert.match(installPs1, /checkout -B/);
  assert.doesNotMatch(installPs1, /'pull',\s*'--ff-only'/);
  assert.match(installPs1, /\[dry-run\] os=Windows/);
  assert.match(installPs1, /\[dry-run\] channel=/);
  assert.match(installPs1, /MAGA_USE_PREBUILT = '1'/);
  assert.match(installPs1, /\$ScriptSource = \$PSCommandPath/);
  assert.match(installPs1, /&\s*\{/);
  assert.match(uninstallPs1, /\[switch\]\$DryRun/);
  assert.match(uninstallPs1, /\[switch\]\$Purge/);
  assert.match(uninstallPs1, /studio\/cli\.mjs rollback/);
  assert.match(uninstallPs1, /install\.mjs uninstall/);
  assert.match(uninstallPs1, /\$ScriptSource = \$PSCommandPath/);
  assert.match(uninstallPs1, /&\s*\{/);

  const tmpRepo = createTempGitRepo('feat/win-preview-msg');
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-deploy-msg-'));
  try {
    const metaPath = path.join(tmpState, 'deploy-meta.json');
    const winGuard = evaluateDeployGuard(tmpRepo, { platform: 'win32', metaPath });
    assert.equal(winGuard.allowed, false);
    assert.match(winGuard.reason || '', /Windows daemon/);

    const macGuard = evaluateDeployGuard(tmpRepo, { platform: 'darwin', metaPath });
    assert.equal(macGuard.allowed, false);
    assert.match(macGuard.reason || '', /LaunchAgent daemon/);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

test('installWinHeadlessLogTee writes and rotates daemon.log on win32 without mutating global console', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-win-logtee-'));
  const logFile = path.join(dir, 'daemon.log');
  try {
    const fakeConsole = { log: () => {}, warn: () => {}, error: () => {} };
    assert.equal(
      installWinHeadlessLogTee({ platform: 'darwin', logFile, targetConsole: fakeConsole }),
      false
    );
    assert.equal(fs.existsSync(logFile), false);

    const installed = installWinHeadlessLogTee({
      platform: 'win32',
      logFile,
      maxBytes: 64,
      targetConsole: fakeConsole,
    });
    assert.equal(installed, true);
    fakeConsole.log('[win-logtee-test]', 'hello');
    fakeConsole.warn('[win-logtee-test]', 'careful');
    fakeConsole.error('[win-logtee-test]', new Error('boom'));
    const content = fs.readFileSync(logFile, 'utf8');
    assert.match(content, /\[INFO\] \[win-logtee-test\] hello/);
    assert.match(content, /\[WARN\] \[win-logtee-test\] careful/);
    assert.match(content, /\[ERROR\] \[win-logtee-test\] .*boom/);

    // Exceeding maxBytes triggers rotation to daemon.log.prev on next install call
    fakeConsole.log('padding-line-to-exceed-64-bytes-threshold-for-rotation-check');
    const rotated = installWinHeadlessLogTee({
      platform: 'win32',
      logFile,
      maxBytes: 64,
      targetConsole: fakeConsole,
    });
    assert.equal(rotated, true);
    assert.equal(fs.existsSync(`${logFile}.prev`), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readVersionFromAsar and getWinAntigravityFingerprint extract version from non-Squirrel app.asar safely', () => {
  const buildTestAsar = (filesMap) => {
    const chunks = [];
    let offset = 0;
    const files = {};
    for (const [name, content] of Object.entries(filesMap)) {
      const buf = Buffer.from(content, 'utf8');
      files[name] = { size: buf.length, offset: String(offset) };
      chunks.push(buf);
      offset += buf.length;
    }
    const headerJson = Buffer.from(JSON.stringify({ files }), 'utf8');
    const alignedLen = Math.ceil(headerJson.length / 4) * 4;
    const headerPickleSize = 8 + alignedLen;
    const hdr = Buffer.alloc(16);
    hdr.writeUInt32LE(4, 0);
    hdr.writeUInt32LE(headerPickleSize, 4);
    hdr.writeUInt32LE(headerPickleSize - 4, 8);
    hdr.writeUInt32LE(headerJson.length, 12);
    return Buffer.concat([hdr, headerJson, Buffer.alloc(alignedLen - headerJson.length), ...chunks]);
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-win-asar-'));
  try {
    const appDir = path.join(tmp, 'Local', 'Programs', 'Antigravity');
    const exePath = path.join(appDir, 'Antigravity.exe');
    const resDir = path.join(appDir, 'resources');
    const asarPath = path.join(resDir, 'app.asar');
    fs.mkdirSync(resDir, { recursive: true });
    fs.writeFileSync(exePath, 'mz', 'utf8');
    fs.writeFileSync(path.join(resDir, 'app-update.yml'), 'provider: generic\nurl: https://example.com\n', 'utf8');
    fs.writeFileSync(asarPath, buildTestAsar({ 'package.json': JSON.stringify({ name: 'antigravity', version: '2.34.0' }) }));

    const fp = getWinAntigravityFingerprint({
      home: tmp,
      env: { LOCALAPPDATA: path.join(tmp, 'Local'), ProgramFiles: path.join(tmp, 'PF') },
    });
    assert.equal(fp.version, '2.34.0');
    assert.match(fp.sig, /^2\.34\.0\|\d+:\d+$/);

    const badAsar = path.join(tmp, 'corrupt.asar');
    fs.writeFileSync(badAsar, 'asar', 'utf8');
    assert.equal(readVersionFromAsar(badAsar), null);
    assert.equal(readVersionFromAsar(path.join(tmp, 'missing.asar')), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('maga-opus-gate matches Windows backslash plan and high-risk paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-win-opus-'));
  const stateDir = path.join(root, 'state');
  const proposalsDir = path.join(stateDir, 'opus-gate-proposals');
  const pluginDataDir = path.join(stateDir, 'opus-gate-data');
  const studioPrefsFile = path.join(stateDir, 'studio-prefs.json');
  const quotaStateFile = path.join(stateDir, 'quota-state.json');
  try {
    fs.mkdirSync(proposalsDir, { recursive: true });
    fs.mkdirSync(pluginDataDir, { recursive: true });
    fs.writeFileSync(studioPrefsFile, JSON.stringify({ opusGateMode: 'semi' }), 'utf8');
    fs.writeFileSync(
      quotaStateFile,
      JSON.stringify({ schema: 1, updatedAt: 500_000, claude: { fiveHourRemainingPct: 80, weeklyRemainingPct: 80 } }),
      'utf8'
    );
    const opts = { stateDir, proposalsDir, pluginDataDir, studioPrefsFile, quotaStateFile, now: 1_000_000 };

    const planCid = 'win_plan_gate_01';
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: planCid,
        cwd: root,
        toolCall: {
          name: 'write_file',
          args: { Path: 'C:\\workspace\\proj\\implementation_plan.md', Content: '# Windows Plan' },
        },
      },
      opts
    );
    const planProp = JSON.parse(fs.readFileSync(path.join(proposalsDir, `${planCid}.json`), 'utf8'));
    assert.equal(planProp.kind, 'plan');
    assert.ok(planProp.planFiles.some((p) => p.includes('implementation_plan.md')));

    const riskCid = 'win_risk_gate_02';
    evaluateHookEvent(
      {
        hookEventName: 'PostToolUse',
        conversationId: riskCid,
        cwd: root,
        toolCall: {
          name: 'write_file',
          args: { Path: 'C:\\workspace\\proj\\core\\daemon.mjs', Content: 'export const ok = true;\n' },
        },
      },
      opts
    );
    evaluateHookEvent(
      { hookEventName: 'Stop', conversationId: riskCid, terminationReason: 'NO_TOOL_CALL' },
      { ...opts, gitSummary: { changedFiles: 1, changedLines: 12, gitHighRisk: [], diffHash: 'win-risk-1' } }
    );
    const riskProp = JSON.parse(fs.readFileSync(path.join(proposalsDir, `${riskCid}.json`), 'utf8'));
    assert.equal(riskProp.kind, 'risk');
    assert.ok(riskProp.highRiskFiles.some((f) => f.endsWith('daemon.mjs')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shell-parser resolveDirectoryChange handles cd /d, Set-Location -Path, sl -LiteralPath, and Push-Location on win32', () => {
  assert.deepEqual(
    resolveDirectoryChange(['cd', '/d', 'D:\\Work\\repo'], 'C:\\Users\\alice', 'C:\\Prev', { platform: 'win32' }),
    { nextDir: 'D:\\Work\\repo', prevDir: 'C:\\Users\\alice' }
  );
  assert.deepEqual(
    resolveDirectoryChange(['Set-Location', '-Path', 'D:'], 'C:\\Users\\alice', 'C:\\Prev', { platform: 'win32' }),
    { nextDir: 'D:\\', prevDir: 'C:\\Users\\alice' }
  );
  assert.deepEqual(
    resolveDirectoryChange(['sl', '-LiteralPath', 'C:\\Temp\\proj\\..'], 'C:\\Users\\alice', 'C:\\Prev', {
      platform: 'win32',
    }),
    { nextDir: 'C:\\Temp', prevDir: 'C:\\Users\\alice' }
  );
  assert.deepEqual(
    resolveDirectoryChange(['Push-Location', 'C:\\Repo\\sub'], 'C:\\Users\\alice', 'C:\\Prev', { platform: 'win32' }),
    { nextDir: 'C:\\Repo\\sub', prevDir: 'C:\\Users\\alice' }
  );

  const psInv = extractGitInvocations(
    'Set-Location -Path "C:\\Users\\alice\\repo"; git status',
    'C:\\Users\\alice',
    'win32'
  );
  assert.equal(psInv.length, 1);
  assert.equal(psInv[0].targetDir, 'C:\\Users\\alice\\repo');
  assert.equal(psInv[0].subcommand, 'status');
});

test('projects chrome-geometry pure helpers distinguish Windows top menu bar and track sliver vs macOS layout', async () => {
  const { isTopMenuBarRect, isTopMenuBarAnchorRect, computeProjectsOverlayMetrics } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'projects', 'chrome-geometry.mjs')).href
  );

  // Win32 full-width top menu bar (.bg-sidebar) vs left sidebar
  const winTopBar = { left: 0, top: 0, width: 1920, height: 30, right: 1920, bottom: 30 };
  const winSidebar = { left: 0, top: 30, width: 256, height: 1002, right: 256, bottom: 1032 };
  assert.equal(isTopMenuBarRect(winTopBar, 1920), true);
  assert.equal(isTopMenuBarAnchorRect(winTopBar, 1920), true);
  assert.equal(isTopMenuBarRect(winSidebar, 1920), false);
  assert.equal(isTopMenuBarAnchorRect(winSidebar, 1920), false);

  // macOS: no full-width top bar, full-height sidebar starts at top=0
  const macSidebar = { left: 0, top: 0, width: 260, height: 1000, right: 260, bottom: 1000 };
  assert.deepEqual(
    computeProjectsOverlayMetrics({ sidebarRect: macSidebar, topBarPx: 0, winW: 1440 }),
    { leftPx: 260, topPx: 0, collapsed: false, safeLeftPad: 24 }
  );

  // Win32 expanded: topPx=30, leftPx=256
  assert.deepEqual(
    computeProjectsOverlayMetrics({ sidebarRect: winSidebar, trackRect: winSidebar, topBarPx: 30, winW: 1920 }),
    { leftPx: 256, topPx: 30, collapsed: false, safeLeftPad: 24 }
  );

  // Win32 collapsing/collapsed sliver (track width <= 8px while inner sidebar still 256px) snaps cleanly to leftPx=0
  const winCollapsedTrack = { left: 0, top: 30, width: 3, height: 1002, right: 3, bottom: 1032 };
  assert.deepEqual(
    computeProjectsOverlayMetrics({ sidebarRect: winSidebar, trackRect: winCollapsedTrack, topBarPx: 30, winW: 1920 }),
    { leftPx: 0, topPx: 30, collapsed: true, safeLeftPad: 224 }
  );
});

function buildDomFromChromeFixture(fixture, { JSDOM, includeAnchors = true, trackWidthOverride = null, includeOverviewHost = true, includeToggleBtns = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const { window } = dom;
  const { document } = window;
  Object.defineProperty(window, 'innerWidth', { value: fixture.viewport.innerWidth, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: fixture.viewport.innerHeight, configurable: true });

  const patchRect = (el, r) => {
    const safe = r || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    el.getBoundingClientRect = () => ({ ...safe, x: safe.left, y: safe.top });
  };

  const sidebarNodes = [];
  for (const item of fixture.bgSidebars || []) {
    const sb = document.createElement(String(item.tag || 'div').toLowerCase());
    sb.className = (item.classes || ['bg-sidebar']).join(' ');
    if (item.testId) sb.setAttribute('data-testid', item.testId);
    patchRect(sb, item.rect);

    if (includeAnchors && item.anchors) {
      if (item.anchors.hasProjectsNav) {
        const nav = document.createElement('button');
        nav.id = 'ag-claude-projects-nav-btn';
        sb.appendChild(nav);
      }
      if (item.anchors.hasAutomationsBtn) {
        const btn = document.createElement('button');
        btn.setAttribute('data-testid', 'automations-button');
        sb.appendChild(btn);
      }
      if (item.anchors.hasProjectHeader) {
        const hdr = document.createElement('div');
        hdr.setAttribute('data-testid', 'project-header');
        sb.appendChild(hdr);
      }
    }

    let root = sb;
    for (const parentMeta of item.parentChain || []) {
      const wrap = document.createElement(String(parentMeta.tag || 'div').toLowerCase());
      if (parentMeta.overflow) wrap.style.overflow = parentMeta.overflow;
      if (parentMeta.overflowX) wrap.style.overflowX = parentMeta.overflowX;
      if (parentMeta.transition) wrap.style.transition = parentMeta.transition;
      const isTrack =
        parentMeta.overflow === 'hidden' ||
        parentMeta.overflowX === 'hidden' ||
        String(parentMeta.transition || '').includes('width');
      const rect =
        isTrack && typeof trackWidthOverride === 'number' && parentMeta.rect
          ? {
              ...parentMeta.rect,
              width: trackWidthOverride,
              right: parentMeta.rect.left + trackWidthOverride,
            }
          : parentMeta.rect;
      patchRect(wrap, rect);
      wrap.appendChild(root);
      root = wrap;
    }

    document.body.appendChild(root);
    sidebarNodes.push(sb);
  }

  let ovBtn = null;
  let auxBtn = null;
  if (includeToggleBtns && fixture.controls?.overviewToggleRect) {
    ovBtn = document.createElement('button');
    ovBtn.setAttribute('data-testid', 'toggle-overview-panel');
    patchRect(ovBtn, fixture.controls.overviewToggleRect);
    document.body.appendChild(ovBtn);
  }
  if (includeToggleBtns && fixture.controls?.auxToggleRect) {
    auxBtn = document.createElement('button');
    auxBtn.setAttribute('data-testid', 'toggle-aux-sidebar');
    patchRect(auxBtn, fixture.controls.auxToggleRect);
    document.body.appendChild(auxBtn);
  }
  if (includeOverviewHost && fixture.controls?.overviewPanelHostRect) {
    const host = document.createElement('div');
    host.setAttribute('data-testid', 'overview-panel-host');
    patchRect(host, fixture.controls.overviewPanelHostRect);
    document.body.appendChild(host);
  }

  return { dom, window, document, sidebarNodes, ovBtn, auxBtn };
}

test('dual-OS Chrome DOM geometry fixtures pass privacy hygiene and end-to-end JSDOM layout regression checks', async () => {
  const { JSDOM } = await import('jsdom');
  const geom = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'projects', 'chrome-geometry.mjs')).href
  );
  const { computeSettingsDrawerTopInset } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'modules', 'settings', 'constants.mjs')).href
  );

  const darwinPath = path.join(REPO, 'test', 'fixtures', 'darwin', 'chrome-layout.json');
  const win32Path = path.join(REPO, 'test', 'fixtures', 'win32', 'chrome-layout.json');
  const darwinRaw = fs.readFileSync(darwinPath, 'utf8');
  const win32Raw = fs.readFileSync(win32Path, 'utf8');

  // Strict privacy hygiene on committed fixtures
  const personalTokenRe = new RegExp(['miracle', 'li'].join('') + '|' + ['dark-unit', 'b0d1'].join('-') + '|/Users/|C:\\\\Users\\\\', 'i');
  for (const [label, raw] of [['darwin', darwinRaw], ['win32', win32Raw]]) {
    assert.equal(personalTokenRe.test(raw), false, `${label} fixture must not contain personal identifiers or home paths`);
  }

  const darwinFixture = JSON.parse(darwinRaw);
  const win32Fixture = JSON.parse(win32Raw);
  assert.equal(darwinFixture.schema, 1);
  assert.equal(darwinFixture.platform, 'darwin');
  assert.match(darwinFixture.hostVersion, /^\d+\.\d+/);
  assert.equal(win32Fixture.schema, 1);
  assert.equal(win32Fixture.platform, 'win32');
  assert.match(win32Fixture.hostVersion, /^\d+\.\d+/);

  // 1. Real macOS live fixture regression
  {
    const { window, document, ovBtn, auxBtn } = buildDomFromChromeFixture(darwinFixture, { JSDOM });
    assert.equal(geom.measureTopMenuBarHeight(document, window), 0);
    geom.syncWinTopBarCssVar(undefined, document, window);
    assert.equal(document.documentElement.style.getPropertyValue('--ag-win-top-bar'), '');

    const sb = geom.findLeftSidebarEl(document, window);
    assert.ok(sb, 'darwin fixture must resolve a left sidebar element');
    assert.equal(sb.getBoundingClientRect().top, 0);
    assert.ok(sb.getBoundingClientRect().width >= 200);
    assert.equal(sb.getBoundingClientRect().height, darwinFixture.viewport.innerHeight);

    const track = geom.findLeftSidebarTrackEl(sb, document, window);
    assert.ok(track && track !== sb, 'darwin fixture must resolve the width-animating ancestor track');
    assert.equal(
      geom.computeProjectsOverlayMetrics({
        sidebarRect: sb.getBoundingClientRect(),
        trackRect: track.getBoundingClientRect(),
        topBarPx: 0,
        winW: window.innerWidth,
      }).topPx,
      0
    );

    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    globalThis.document = document;
    globalThis.window = window;
    try {
      const inset = computeSettingsDrawerTopInset(ovBtn, auxBtn);
      assert.ok(inset >= 48 && inset <= 96, `unexpected macOS settings drawer inset: ${inset}`);
    } finally {
      globalThis.document = prevDoc;
      globalThis.window = prevWin;
    }
  }

  // 2. Windows 10/11 top-menu-bar fixture regression (anchors, fallback, collapsing track sliver, settings drawer)
  {
    const { window, document, ovBtn, auxBtn } = buildDomFromChromeFixture(win32Fixture, { JSDOM });
    assert.equal(geom.measureTopMenuBarHeight(document, window), 30);
    geom.syncWinTopBarCssVar(undefined, document, window);
    assert.equal(document.documentElement.style.getPropertyValue('--ag-win-top-bar'), '30px');

    const sb = geom.findLeftSidebarEl(document, window);
    assert.ok(sb, 'win32 fixture must resolve left sidebar rather than top menu bar');
    assert.equal(sb.getBoundingClientRect().top, 30);
    assert.equal(sb.getBoundingClientRect().width, 256);

    const track = geom.findLeftSidebarTrackEl(sb, document, window);
    assert.ok(track && track !== sb, 'win32 fixture must resolve width-animating sidebar track');
    assert.deepEqual(
      geom.computeProjectsOverlayMetrics({
        sidebarRect: sb.getBoundingClientRect(),
        trackRect: track.getBoundingClientRect(),
        topBarPx: geom.measureTopMenuBarHeight(document, window),
        winW: window.innerWidth,
      }),
      { leftPx: 256, topPx: 30, collapsed: false, safeLeftPad: 24 }
    );

    // Fallback path when anchor nodes are absent must still skip bgSidebars[0] (top menu bar)
    const noAnchors = buildDomFromChromeFixture(win32Fixture, { JSDOM, includeAnchors: false });
    const fallbackSb = geom.findLeftSidebarEl(noAnchors.document, noAnchors.window);
    assert.equal(fallbackSb?.getBoundingClientRect().width, 256);
    assert.equal(fallbackSb?.getBoundingClientRect().top, 30);

    // Collapsing track sliver (width=3px) snaps Projects overlay cleanly to leftPx=0 while preserving topPx=30
    const sliver = buildDomFromChromeFixture(win32Fixture, { JSDOM, trackWidthOverride: 3 });
    const sliverSb = geom.findLeftSidebarEl(sliver.document, sliver.window);
    const sliverTrack = geom.findLeftSidebarTrackEl(sliverSb, sliver.document, sliver.window);
    assert.deepEqual(
      geom.computeProjectsOverlayMetrics({
        sidebarRect: sliverSb.getBoundingClientRect(),
        trackRect: sliverTrack.getBoundingClientRect(),
        topBarPx: 30,
        winW: sliver.window.innerWidth,
      }),
      { leftPx: 0, topPx: 30, collapsed: true, safeLeftPad: 224 }
    );

    // Settings drawer top inset clears Windows 30px top bar across host, toggle-btn, and bare-topbar fallback modes
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    try {
      globalThis.document = document;
      globalThis.window = window;
      assert.equal(computeSettingsDrawerTopInset(ovBtn, auxBtn), 84);

      const toggleOnly = buildDomFromChromeFixture(win32Fixture, { JSDOM, includeOverviewHost: false });
      globalThis.document = toggleOnly.document;
      globalThis.window = toggleOnly.window;
      assert.equal(computeSettingsDrawerTopInset(toggleOnly.ovBtn, toggleOnly.auxBtn), 78);

      const barOnly = buildDomFromChromeFixture(win32Fixture, {
        JSDOM,
        includeOverviewHost: false,
        includeToggleBtns: false,
      });
      globalThis.document = barOnly.document;
      globalThis.window = barOnly.window;
      assert.equal(computeSettingsDrawerTopInset(null, null), 78);
    } finally {
      globalThis.document = prevDoc;
      globalThis.window = prevWin;
    }
  }
});

test('cdp-probe and capture-chrome-fixture sanitize untrusted fields and skip non-workspace targets', async () => {
  const { selectWorkspacePage, resolveLiveCdpPort } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'cdp-probe.mjs')).href
  );
  const { sanitizeFixtureSnapshot } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'capture-chrome-fixture.mjs')).href
  );

  const picked = selectWorkspacePage([
    { type: 'page', url: 'data:text/html,splash', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/splash' },
    { type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/dt' },
    { type: 'service_worker', url: 'https://127.0.0.1:60000/sw.js', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/sw' },
    { type: 'page', url: 'https://127.0.0.1:60000/c/conv-1', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/app' },
  ]);
  assert.equal(picked?.webSocketDebuggerUrl, 'ws://127.0.0.1:9222/app');
  assert.equal(selectWorkspacePage([{ type: 'page', url: 'data:text/html,only', webSocketDebuggerUrl: 'ws://x' }]), null);

  const resolved = resolveLiveCdpPort({
    endpoints: [
      { channel: 'darwin', portFile: '/missing/port' },
      { channel: 'win32', portFile: '/valid/port' },
    ],
    existsSyncFn: (p) => p === '/valid/port',
    readPortFn: (p) => (p === '/valid/port' ? 60123 : 0),
  });
  assert.deepEqual(resolved, { port: 60123, channel: 'win32', portFile: '/valid/port' });

  const sanitized = sanitizeFixtureSnapshot(
    {
      viewport: { innerWidth: 1440.4, innerHeight: 900.2, devicePixelRatio: 2 },
      cssVars: {
        winTopBar: '30px',
        projTop: 'javascript:alert(1)',
        drawerTop: 'calc(var(--ag-win-top-bar, 0px) + 48px)',
        ovEffectiveReserve: '/Users/secret/path',
      },
      bgSidebars: [
        {
          tag: 'div',
          testId: 'secret-project-name',
          classes: ['bg-sidebar', 'flex-col', 'user-secret-class'],
          rect: { left: 0.2, top: 29.8, right: 256.1, bottom: 1032, width: 256.1, height: 1002.2 },
          anchors: { hasProjectsNav: 1 },
          parentChain: [
            {
              tag: 'div',
              overflow: 'hidden',
              overflowX: 'evil',
              transition: 'background url(file:///Users/alice/x.png)',
              rect: { left: 0, top: 30, right: 256, bottom: 1032, width: 256, height: 1002 },
            },
          ],
        },
      ],
      secretLeakedField: 'should-be-dropped',
    },
    { platform: 'win32', source: 'unit-test' }
  );
  assert.equal(sanitized.secretLeakedField, undefined);
  assert.equal(sanitized.hostVersion, 'unknown');
  assert.equal(
    sanitizeFixtureSnapshot({ hostVersion: '2.35.2' }, { platform: 'darwin', source: 'unit' }).hostVersion,
    '2.35.2'
  );
  assert.equal(
    sanitizeFixtureSnapshot({ hostVersion: 'file:///Users/alice/bad' }, { platform: 'darwin', source: 'unit' }).hostVersion,
    'unknown'
  );
  assert.equal(sanitized.cssVars.winTopBar, '30px');
  assert.equal(sanitized.cssVars.projTop, '');
  assert.equal(sanitized.cssVars.ovEffectiveReserve, '');
  assert.equal(sanitized.bgSidebars[0].testId, null);
  assert.deepEqual(sanitized.bgSidebars[0].classes, ['bg-sidebar', 'flex-col']);
  assert.equal(sanitized.bgSidebars[0].parentChain[0].overflowX, 'visible');
  assert.equal(sanitized.bgSidebars[0].parentChain[0].transition, 'all');
});
