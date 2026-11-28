import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('install.sh / install.ps1 and uninstall --dry-run and pipe-mode isolation run cleanly against temp HOME', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'maga-home-dry-'));
  try {
    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
    };
    if (process.platform === 'win32') {
      const installOut = execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'install.ps1'), '-DryRun'],
        { cwd: REPO, env, encoding: 'utf8', windowsHide: true }
      );
      assert.match(installOut, /\[dry-run\] os=Windows/);
      assert.match(installOut, /\[dry-run\] mode=(prebuilt|source|source-bootstrap)/);
      assert.match(installOut, /studio\/cli\.mjs install/);

      const installPreviewOut = execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'install.ps1'), '-DryRun', '-Preview'],
        { cwd: REPO, env, encoding: 'utf8', windowsHide: true }
      );
      assert.match(installPreviewOut, /studio\/cli\.mjs install --preview/);
      assert.match(installPreviewOut, /\[dry-run\] channel=stable/);

      const installEdgeOut = execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'install.ps1'), '-DryRun', '-Channel', 'edge'],
        { cwd: REPO, env, encoding: 'utf8', windowsHide: true }
      );
      assert.match(installEdgeOut, /\[dry-run\] channel=edge/);

      const uninstallOut = execFileSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'uninstall.ps1'), '-DryRun'],
        { cwd: REPO, env, encoding: 'utf8', windowsHide: true }
      );
      assert.match(uninstallOut, /studio\/cli\.mjs rollback/);
      assert.match(uninstallOut, /install\.mjs uninstall/);
      assert.match(uninstallOut, /preserve:.*studio-prefs\.json/);
      assert.equal(existsSync(path.join(fakeHome, '.gemini')), false, 'dry-run must not mutate USERPROFILE/.gemini');
      return;
    }

    const installOut = execFileSync('bash', [path.join(REPO, 'install.sh'), '--dry-run'], {
      cwd: REPO,
      env,
      encoding: 'utf8',
    });
    assert.match(installOut, /\[dry-run\] os=Darwin/);
    assert.match(installOut, /\[dry-run\] channel=stable/);
    assert.match(installOut, /\[dry-run\] mode=(prebuilt|source|source-bootstrap)/);
    assert.match(installOut, /studio\/cli\.mjs install/);

    const installEdgeOut = execFileSync('bash', [path.join(REPO, 'install.sh'), '--dry-run', '--channel', 'edge'], {
      cwd: REPO,
      env,
      encoding: 'utf8',
    });
    assert.match(installEdgeOut, /\[dry-run\] channel=edge/);

    assert.throws(() => {
      execFileSync('bash', [path.join(REPO, 'install.sh'), '--dry-run', '--channel', 'bogus'], {
        cwd: REPO,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }, /non-zero|status 2|invalid --channel/i);

    const installNoRulesOut = execFileSync('bash', [path.join(REPO, 'install.sh'), '--dry-run', '--no-rules'], {
      cwd: REPO,
      env,
      encoding: 'utf8',
    });
    assert.match(installNoRulesOut, /studio\/cli\.mjs install --no-rules/);

    const installPreviewOut = execFileSync('bash', [path.join(REPO, 'install.sh'), '--dry-run', '--preview'], {
      cwd: REPO,
      env,
      encoding: 'utf8',
    });
    assert.match(installPreviewOut, /studio\/cli\.mjs install --preview/);

    // Piped stdin mode must NOT trust $PWD/studio/cli.mjs; it must route to remote-clone ($INSTALL_DIR).
    const pipedScript = readFileSync(path.join(REPO, 'install.sh'), 'utf8');
    const pipedOut = execFileSync('bash', ['-s', '--', '--dry-run'], {
      cwd: REPO,
      env,
      input: pipedScript,
      encoding: 'utf8',
    });
    assert.match(pipedOut, /\[dry-run\] channel=stable/);
    assert.match(pipedOut, /\[dry-run\] mode=remote-clone/);
    assert.match(pipedOut, /checkout --detach/);
    assert.match(pipedOut, /npm ci --no-audit --no-fund/);

    const pipedEdgeOut = execFileSync('bash', ['-s', '--', '--dry-run', '--channel', 'edge'], {
      cwd: REPO,
      env,
      input: pipedScript,
      encoding: 'utf8',
    });
    assert.match(pipedEdgeOut, /\[dry-run\] channel=edge/);
    assert.match(pipedEdgeOut, /checkout -B main origin\/main/);

    const uninstallOut = execFileSync('bash', [path.join(REPO, 'uninstall.sh'), '--dry-run'], {
      cwd: REPO,
      env,
      encoding: 'utf8',
    });
    assert.match(uninstallOut, /studio\/cli\.mjs rollback/);
    assert.match(uninstallOut, /install\.mjs uninstall/);
    assert.match(uninstallOut, /preserve:.*studio-prefs\.json/);

    assert.equal(existsSync(path.join(fakeHome, '.gemini')), false, 'dry-run must not mutate HOME/.gemini');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('packRelease builds zero-npm-install macOS tarball with valid SHA-256, zero personal prefs, and clean manifest', async () => {
  const distOut = mkdtempSync(path.join(tmpdir(), 'maga-dist-'));
  const unpackDir = mkdtempSync(path.join(tmpdir(), 'maga-unpack-'));
  try {
    const { packRelease } = await import(pathToFileURL(path.join(REPO, 'studio', 'pack-release.mjs')).href);
    const { buildUserCustomJs } = await import(pathToFileURL(path.join(REPO, 'studio', 'build.mjs')).href);
    const res = await packRelease({ outDir: distOut });
    assert.equal(res.ok, true);
    assert.equal(existsSync(res.archive), true);
    assert.equal(existsSync(res.sha256File), true);

    const expectedHash = crypto.createHash('sha256').update(readFileSync(res.archive)).digest('hex');
    assert.equal(res.sha256, expectedHash);
    const shaLine = readFileSync(res.sha256File, 'utf8').trim();
    assert.ok(shaLine.startsWith(`${expectedHash}  `));

    const tarList = execFileSync('tar', ['-tzf', res.archive], { encoding: 'utf8' });
    const tarEntries = tarList.split('\n').filter(Boolean);
    const forbidden = tarEntries.filter((e) =>
      /(^|\/)(node_modules|\.git|\.agents|test|DEVELOPMENT_HISTORY\.md|studio-prefs\.json|project-suggestions-config\.json|gateway-identity\.json|pairing\.json|devices\.json|gateway\.pid|bridge\.sock)(\/|$)/.test(
        e
      ) || /^[^/]+\/AGENTS\.md$/.test(e)
    );
    assert.deepEqual(forbidden, [], `Forbidden paths leaked into release tarball: ${forbidden.join(', ')}`);

    execFileSync('tar', ['-xzf', res.archive, '-C', unpackDir]);
    const extractedRoot = path.join(unpackDir, `agy-studio-v${res.version}-macos`);
    assert.equal(existsSync(path.join(extractedRoot, 'node_modules')), false, 'tarball must exclude node_modules');
    assert.equal(existsSync(path.join(extractedRoot, 'test')), false, 'tarball must exclude test/');
    assert.equal(existsSync(path.join(extractedRoot, 'user', 'custom.js')), true);
    assert.equal(existsSync(path.join(extractedRoot, 'studio', 'prebuilt', 'studio-entry.js')), true);
    assert.equal(existsSync(path.join(extractedRoot, 'remote', 'gateway', 'server.mjs')), true);
    for (const f of ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'sw.js']) {
      assert.equal(existsSync(path.join(extractedRoot, 'remote', 'pwa', 'dist', f)), true, `tarball missing remote/pwa/dist/${f}`);
    }
    assert.equal(existsSync(path.join(extractedRoot, 'install.sh')), true);
    assert.equal(existsSync(path.join(extractedRoot, 'docs', 'INSTALL_AGENT.md')), true);

    // Verify packaged user/custom.js matches a clean build (no personal prefs baked in)
    const freshUser = await buildUserCustomJs({ writeToRepo: false, allowPrebuilt: false });
    const packedUser = readFileSync(path.join(extractedRoot, 'user', 'custom.js'), 'utf8');
    assert.equal(packedUser, freshUser.code, 'Packaged user/custom.js must match clean default build');

    // Run extracted studio/build.mjs in an environment WITHOUT node_modules using MAGA_USE_PREBUILT=1
    const fakeHome = path.join(unpackDir, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    const verifyScript = `
      import { buildRemotePwa, buildStudioBundle, buildUserCustomJs } from './studio/build.mjs';
      const u = await buildUserCustomJs({ writeToRepo: false, allowPrebuilt: true });
      const b = await buildStudioBundle({ allowPrebuilt: true });
      const p = await buildRemotePwa({ allowPrebuilt: true });
      if (!u.prebuilt || u.bytes < 1000) throw new Error('Expected prebuilt user/custom.js');
      if (!p.prebuilt || !p.files?.['app.js']) throw new Error('Expected prebuilt remote PWA bundle');
      if (!b.jsBlock.includes('createMagaKernel') || !b.cssBlock.includes('studio-settings.css')) {
        throw new Error('Prebuilt studio bundle missing expected markers');
      }
      console.log(JSON.stringify({ ok: true, userBytes: u.bytes, studioBytes: b.jsBlock.length, remoteBytes: p.files['app.js'] }));
    `;
    const checkOut = execFileSync(process.execPath, ['--input-type=module', '-e', verifyScript], {
      cwd: extractedRoot,
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
        MAGA_USE_PREBUILT: '1',
      },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(checkOut.trim().split('\n').pop());
    assert.equal(parsed.ok, true);

    // Verify native installer --dry-run detects prebuilt mode inside unpacked archive
    const dryEnv = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
    };
    const dryOut =
      process.platform === 'win32'
        ? execFileSync(
            'powershell',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(extractedRoot, 'install.ps1'), '-DryRun'],
            { cwd: extractedRoot, env: dryEnv, encoding: 'utf8', windowsHide: true }
          )
        : execFileSync('bash', [path.join(extractedRoot, 'install.sh'), '--dry-run'], {
            cwd: extractedRoot,
            env: dryEnv,
            encoding: 'utf8',
          });
    assert.match(dryOut, /\[dry-run\] mode=prebuilt/);
  } finally {
    rmSync(distOut, { recursive: true, force: true });
    rmSync(unpackDir, { recursive: true, force: true });
    rmSync(path.join(REPO, 'studio', 'prebuilt'), { recursive: true, force: true });
  }
});

test('packRelease builds zero-npm-install Windows zip with remote PWA, shared fs-paths, and Android exclusions', async () => {
  const distOut = mkdtempSync(path.join(tmpdir(), 'maga-win-dist-'));
  const unpackDir = mkdtempSync(path.join(tmpdir(), 'maga-win-unpack-'));
  try {
    const { packRelease } = await import(pathToFileURL(path.join(REPO, 'studio', 'pack-release.mjs')).href);
    const res = await packRelease({ outDir: distOut, platform: 'windows' });
    assert.equal(res.ok, true);
    assert.equal(path.basename(res.archive), `agy-studio-v${res.version}-windows.zip`);
    assert.equal(existsSync(res.archive), true);
    assert.equal(existsSync(res.sha256File), true);

    const expectedHash = crypto.createHash('sha256').update(readFileSync(res.archive)).digest('hex');
    assert.equal(res.sha256, expectedHash);

    execFileSync('tar', ['-xf', res.archive, '-C', unpackDir]);
    const extractedRoot = path.join(unpackDir, `agy-studio-v${res.version}-windows`);
    assert.equal(existsSync(path.join(extractedRoot, 'install.ps1')), true);
    assert.equal(existsSync(path.join(extractedRoot, 'uninstall.ps1')), true);
    assert.equal(existsSync(path.join(extractedRoot, 'user', 'custom.js')), true);
    assert.equal(existsSync(path.join(extractedRoot, 'studio', 'prebuilt', 'studio-entry.js')), true);
    assert.equal(existsSync(path.join(extractedRoot, 'remote', 'shared', 'fs-paths.mjs')), true);
    assert.equal(existsSync(path.join(extractedRoot, 'remote', 'pwa', 'dist', 'app.js')), true);
    assert.equal(existsSync(path.join(extractedRoot, 'remote', 'android', '.gradle')), false);
    assert.equal(existsSync(path.join(extractedRoot, 'remote', 'android', 'app', 'build')), false);
    assert.equal(existsSync(path.join(extractedRoot, 'remote', 'android', 'local.properties')), false);
    assert.equal(existsSync(path.join(extractedRoot, 'node_modules')), false);
  } finally {
    rmSync(distOut, { recursive: true, force: true });
    rmSync(unpackDir, { recursive: true, force: true });
    rmSync(path.join(REPO, 'studio', 'prebuilt'), { recursive: true, force: true });
  }
});

test('studio/cli.mjs sync-rules and rollback cleanly strip fast-io rules while preserving user AGENTS.md content', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'agy-rollback-home-'));
  try {
    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
    };
    const geminiDir = path.join(fakeHome, '.gemini');
    const agentsMd = path.join(geminiDir, 'AGENTS.md');
    mkdirSync(geminiDir, { recursive: true });
    writeFileSync(agentsMd, '# User Custom Rules\n- Keep my custom workflow.\n', 'utf8');

    const syncOut = JSON.parse(
      execFileSync(process.execPath, [path.join(REPO, 'studio', 'cli.mjs'), 'sync-rules'], {
        cwd: REPO,
        env,
        encoding: 'utf8',
      })
    );
    assert.equal(syncOut.ok, true);
    assert.equal(syncOut.opusGatePlugin.pinned, true);
    assert.equal(syncOut.autoCompactPlugin.pinned, true);
    assert.equal(syncOut.gitWorkflowPlugin.pinned, true);
    const afterSync = readFileSync(agentsMd, 'utf8');
    assert.match(afterSync, /# User Custom Rules/);
    assert.match(afterSync, /<!-- BEGIN agy-fast-io-pruned -->/);

    const rbOut = JSON.parse(
      execFileSync(process.execPath, [path.join(REPO, 'studio', 'cli.mjs'), 'rollback'], {
        cwd: REPO,
        env,
        encoding: 'utf8',
      })
    );
    assert.equal(rbOut.ok, true);
    assert.equal(rbOut.rules.removed, true);
    assert.equal(rbOut.opusGatePlugin.installed, false);
    assert.equal(rbOut.autoCompactPlugin.installed, false);
    assert.equal(rbOut.gitWorkflowPlugin.installed, false);

    const afterRollback = readFileSync(agentsMd, 'utf8');
    assert.equal(afterRollback.includes('agy-fast-io-pruned'), false, 'rollback must strip fast-io rule block');
    assert.match(afterRollback, /# User Custom Rules/);
    assert.match(afterRollback, /Keep my custom workflow\./);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('public hygiene: no personal domains in tracked Android sources or test fixtures', () => {
  const checkedPaths = [
    path.join(REPO, 'remote', 'android', 'app', 'build.gradle.kts'),
    path.join(REPO, 'remote', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    path.join(REPO, 'test', 'remote-phase2.test.mjs'),
    path.join(REPO, 'test', 'fixtures', 'darwin', 'chrome-layout.json'),
    path.join(REPO, 'test', 'fixtures', 'win32', 'chrome-layout.json'),
  ];
  const personalDomain = ['agy.', 'miracle', 'li.com'].join('');
  const personalTenant = ['dark-unit', 'b0d1'].join('-');
  const personalRe = new RegExp(`${personalDomain.replace(/\./g, '\\.')}|${personalTenant}`, 'i');
  for (const filePath of checkedPaths) {
    const content = readFileSync(filePath, 'utf8');
    assert.equal(personalRe.test(content), false, `Personal domain found in ${path.relative(REPO, filePath)}`);
  }
});

test('android WebView keeps Cloudflare and IdP OAuth flows inside WebView and guards /cdn-cgi/access/ deep links', () => {
  const mainActivity = readFileSync(
    path.join(REPO, 'remote', 'android', 'app', 'src', 'main', 'java', 'com', 'agystudio', 'remote', 'MainActivity.kt'),
    'utf8'
  );
  assert.match(mainActivity, /target == "cloudflare\.com"\s*\|\|\s*target\.endsWith\("\.cloudflare\.com"\)/);
  assert.match(mainActivity, /onNonServerAuthPage/);
  assert.match(mainActivity, /fun isAccessCallbackPath\(/);
  assert.match(mainActivity, /path\.startsWith\("\/cdn-cgi\/access\/"\)/);
  assert.match(mainActivity, /isTrustedServerOrigin\(origin\)\s*&&\s*!isAccessCallbackPath\(url\)/);
  assert.match(mainActivity, /if\s*\(isAccessCallbackPath\(rawUrl\)\)/);
});

test('pack-release extractChangelogNotes and CI release workflow stay aligned for v* tags', async () => {
  const { extractChangelogNotes } = await import(pathToFileURL(path.join(REPO, 'studio', 'pack-release.mjs')).href);

  const sample = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '- draft',
    '',
    '## [1.5.10] - 2026-12-01',
    '### Fixed',
    '- future patch',
    '',
    '## [1.5.1] - 2026-11-27',
    '### Fixed',
    '- exact target fix',
    '',
    '## [1.5.0] - 2026-11-27',
    '- older release',
  ].join('\n');

  assert.equal(extractChangelogNotes(sample, 'v1.5.1'), '### Fixed\n- exact target fix');
  assert.equal(extractChangelogNotes(sample, '1.5.10'), '### Fixed\n- future patch');
  assert.equal(extractChangelogNotes(sample, '9.9.9'), '');

  const realChangelog = readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');
  const v151Notes = extractChangelogNotes(realChangelog, 'v1.5.1');
  assert.match(v151Notes, /chrome-geometry\.mjs/);
  assert.doesNotMatch(v151Notes, /## \[1\.5\.0\]/);

  const ciYml = readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ciYml, /if:\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)/);
  assert.match(ciYml, /needs:\s*\[stranded-branches,\s*test\]/);
  assert.match(ciYml, /contents:\s*write/);
  assert.match(ciYml, /npm run release:pack:all/);
  assert.match(ciYml, /sha256sum -c/);
  assert.doesNotMatch(ciYml, /\b(?:tar|unzip)\b[^\n]*\|\s*grep\s+[^\n]*-[a-zA-Z]*q/);
  assert.match(ciYml, /gh release upload "\$TAG" "\$\{ASSETS\[@\]\}" --clobber/);
  assert.match(ciYml, /\[\[ "\$TAG" == \*-\* \]\]/);
  assert.match(ciYml, /RELEASE_FLAGS\+\=\(--prerelease --latest=false\)/);
  assert.equal((ciYml.match(/gh release create "\$TAG"[^\n]*RELEASE_FLAGS/g) || []).length, 2);

  if (process.platform !== 'win32') {
    // Execute the exact Create or update GitHub Release bash block with a stub gh binary
    const stepMatch = ciYml.match(
      /- name: Create or update GitHub Release[\s\S]*?run: \|\n([\s\S]*?)(?:\n\s*- name:|\n*$)/
    );
    assert.ok(stepMatch, 'expected Create or update GitHub Release run block in ci.yml');
    const stepScript = stepMatch[1].replace(/^ {10}/gm, '');
    const ciTmp = mkdtempSync(path.join(tmpdir(), 'agy-ci-release-'));
    try {
      const binDir = path.join(ciTmp, 'bin');
      const workDir = path.join(ciTmp, 'work');
      const notesPath = path.join(ciTmp, 'release-notes.md');
      const ghLogPath = path.join(ciTmp, 'gh-calls.log');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(path.join(workDir, 'dist'), { recursive: true });

      const ghStub = path.join(binDir, 'gh');
      writeFileSync(
        ghStub,
        `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "release" && "\${2:-}" == "view" ]]; then
  if [[ "\${STUB_RELEASE_EXISTS:-0}" == "1" ]]; then
    exit 0
  fi
  exit 1
fi
printf '%s\\n' "$*" >> "${ghLogPath}"
`,
        { mode: 0o755 }
      );

      const isolatedScript = stepScript.replaceAll('/tmp/release-notes.md', notesPath);
      const runCase = (tag, withNotes, { exists = false } = {}) => {
        const ver = tag.replace(/^v/, '');
        for (const asset of [
          `agy-studio-v${ver}-macos.tar.gz`,
          `agy-studio-v${ver}-macos.tar.gz.sha256`,
          `agy-studio-v${ver}-windows.zip`,
          `agy-studio-v${ver}-windows.zip.sha256`,
        ]) {
          writeFileSync(path.join(workDir, 'dist', asset), 'stub\n');
        }
        rmSync(ghLogPath, { force: true });
        if (withNotes) writeFileSync(notesPath, '### Notes\n- test\n', 'utf8');
        else rmSync(notesPath, { force: true });

        execFileSync('bash', ['-euo', 'pipefail', '-c', isolatedScript], {
          cwd: workDir,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            GITHUB_REF_NAME: tag,
            GH_TOKEN: 'stub-token',
            STUB_RELEASE_EXISTS: exists ? '1' : '0',
          },
          encoding: 'utf8',
        });
        return readFileSync(ghLogPath, 'utf8').trim();
      };

      const rcWithNotes = runCase('v2.0.0-rc.1', true);
      assert.match(rcWithNotes, /^release create v2\.0\.0-rc\.1\b/);
      assert.match(rcWithNotes, /--notes-file/);
      assert.match(rcWithNotes, /--prerelease --latest=false$/);

      const rcExisting = runCase('v2.0.0-rc.1', true, { exists: true });
      assert.match(rcExisting, /^release edit v2\.0\.0-rc\.1 --prerelease --latest=false\nrelease upload v2\.0\.0-rc\.1\b/);

      const betaGenNotes = runCase('v2.0.0-beta.1', false);
      assert.match(betaGenNotes, /^release create v2\.0\.0-beta\.1\b/);
      assert.match(betaGenNotes, /--generate-notes/);
      assert.match(betaGenNotes, /--prerelease --latest=false$/);

      const stableWithNotes = runCase('v2.0.0', true);
      assert.match(stableWithNotes, /^release create v2\.0\.0\b/);
      assert.match(stableWithNotes, /--notes-file/);
      assert.doesNotMatch(stableWithNotes, /--prerelease/);
      assert.doesNotMatch(stableWithNotes, /--latest=false/);

      const stableExisting = runCase('v2.0.0', true, { exists: true });
      assert.match(stableExisting, /^release upload v2\.0\.0\b/);
      assert.doesNotMatch(stableExisting, /release edit/);
    } finally {
      rmSync(ciTmp, { recursive: true, force: true });
    }
  }
});

test('install.sh and install.ps1 git ls-remote stable fallback crosses major versions (1.6.0 -> 2.0.0) and excludes prereleases', () => {
  const installSh = readFileSync(path.join(REPO, 'install.sh'), 'utf8');
  const installPs1 = readFileSync(path.join(REPO, 'install.ps1'), 'utf8');
  assert.doesNotMatch(installSh, /expectedMajor|major > expectedMajor/);
  assert.doesNotMatch(installPs1, /expectedMajor|major > expectedMajor/);

  const psMatch = installPs1.match(/\$resolverJs = @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(psMatch, 'expected $resolverJs block in install.ps1');
  const psResolverJs = psMatch[1].replace(/\r\n/g, '\n');

  const tmp = mkdtempSync(path.join(tmpdir(), 'agy-installer-major-'));
  try {
    const bareDir = path.join(tmp, 'origin.git');
    const seedDir = path.join(tmp, 'seed');
    const cloneDir = path.join(tmp, 'clone');
    execFileSync('git', ['init', '--bare', '-b', 'main', bareDir], { stdio: 'ignore' });
    execFileSync('git', ['init', '-b', 'main', seedDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', seedDir, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', seedDir, 'config', 'user.email', 'test@example.local']);

    const commitAndTag = (version, tag) => {
      writeFileSync(path.join(seedDir, 'package.json'), JSON.stringify({ name: 'agy-studio', version }) + '\n');
      execFileSync('git', ['-C', seedDir, 'add', 'package.json']);
      execFileSync('git', ['-C', seedDir, 'commit', '-m', `rel ${tag}`], { stdio: 'ignore' });
      execFileSync('git', ['-C', seedDir, 'tag', '-a', tag, '-m', tag]);
    };

    commitAndTag('1.6.0', 'v1.6.0');
    commitAndTag('1.7.0', 'v1.7.0');
    commitAndTag('2.0.0-rc.1', 'v2.0.0-rc.1');
    commitAndTag('2.0.0', 'v2.0.0');
    commitAndTag('2.1.0-beta.1', 'v2.1.0-beta.1');
    execFileSync('git', ['-C', seedDir, 'push', bareDir, 'main', '--tags'], { stdio: 'ignore' });
    execFileSync('git', ['clone', bareDir, cloneDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', cloneDir, 'checkout', '--detach', 'refs/tags/v1.6.0'], { stdio: 'ignore' });

    const psResolved = execFileSync(process.execPath, ['--input-type=module', '-', cloneDir, bareDir], {
      input: psResolverJs,
      env: { ...process.env, AGY_STUDIO_RELEASE_TAG: '' },
      encoding: 'utf8',
    }).trim();
    assert.equal(psResolved, 'v2.0.0');

    if (process.platform !== 'win32') {
      const shFuncMatch = installSh.match(/resolve_stable_tag\(\) \{[\s\S]*?\nEOF\r?\n\}/);
      assert.ok(shFuncMatch, 'expected resolve_stable_tag function in install.sh');
      const shResolved = execFileSync(
        'bash',
        [
          '-euo',
          'pipefail',
          '-c',
          `NODE_BIN="${process.execPath}"\n${shFuncMatch[0]}\nresolve_stable_tag "$1" "$2"`,
          '--',
          cloneDir,
          bareDir,
        ],
        {
          env: { ...process.env, AGY_STUDIO_RELEASE_TAG: '' },
          encoding: 'utf8',
        }
      ).trim();
      assert.equal(shResolved, 'v2.0.0');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('OSS contributor docs (CONTRIBUTING.md and PR template) exist and separate external vs maintainer flows', () => {
  const contributing = readFileSync(path.join(REPO, 'CONTRIBUTING.md'), 'utf8');
  const prTemplate = readFileSync(path.join(REPO, '.github', 'pull_request_template.md'), 'utf8');
  assert.match(contributing, /npm run build:remote && npm test/);
  assert.match(contributing, /CHANGELOG\.md/);
  assert.match(contributing, /probe:host/);
  assert.match(contributing, /do \*\*not\*\* need to install local `\.githooks`/i);
  assert.match(contributing, /smoke\/darwin/);
  assert.match(prTemplate, /npm run build:remote && npm test/);
  assert.match(prTemplate, /CHANGELOG\.md/);
  assert.match(prTemplate, /npm run probe:host/);
});
