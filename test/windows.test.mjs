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
  stableWinNodePath,
} = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'win-service.mjs')).href);

const { renameWithWinRetry } = await import(
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
      userDir,
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
  assert.match(installPs1, /\[dry-run\] os=Windows/);
  assert.match(installPs1, /MAGA_USE_PREBUILT = '1'/);
  assert.match(installPs1, /\$ScriptSource = \$PSCommandPath/);
  assert.match(installPs1, /&\s*\{/);
  assert.match(uninstallPs1, /\[switch\]\$DryRun/);
  assert.match(uninstallPs1, /\[switch\]\$Purge/);
  assert.match(uninstallPs1, /studio\/cli\.mjs rollback/);
  assert.match(uninstallPs1, /install\.mjs uninstall/);
  assert.match(uninstallPs1, /\$ScriptSource = \$PSCommandPath/);
  assert.match(uninstallPs1, /&\s*\{/);
});
