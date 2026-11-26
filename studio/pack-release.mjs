#!/usr/bin/env node
/**
 * Release Packager for AGY Studio (`agy-studio`).
 * Pre-compiles browser bundles (`user/custom.js` + `studio/prebuilt/studio-entry.js`)
 * and emits zero-`npm-install` Release archives (`.tar.gz` for macOS, `.zip` for Windows)
 * + SHA-256 checksums under `dist/`.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREBUILT_STUDIO_ENTRY,
  REPO_ROOT,
  buildUserCustomJs,
  compileStudioCoreIife,
} from './build.mjs';

const __filename = fileURLToPath(import.meta.url);
const DIST_DIR = path.join(REPO_ROOT, 'dist');

const INCLUDE_FILES = [
  'package.json',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'install.mjs',
  'install.sh',
  'uninstall.sh',
  'install.ps1',
  'uninstall.ps1',
];

const INCLUDE_DIRS = [
  'core',
  'cli',
  'rules',
  'assets',
  'vendor',
  'studio',
  'user',
];

function parseCliOpts(argv) {
  let outDir = DIST_DIR;
  let versionOverride = '';
  let platform = 'macos';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out-dir' && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    } else if (a === '--version' && argv[i + 1]) {
      versionOverride = argv[++i].replace(/^v/, '').trim();
    } else if (a === '--platform' && argv[i + 1]) {
      platform = String(argv[++i]).trim().toLowerCase();
    }
  }
  return { outDir, versionOverride, platform };
}

function createZipArchive(stageParent, rootName, archivePath) {
  if (process.platform === 'win32') {
    const srcExpr = path.join(stageParent, rootName).replace(/'/g, "''");
    const dstExpr = archivePath.replace(/'/g, "''");
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${srcExpr}' -DestinationPath '${dstExpr}' -Force`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return;
  }
  try {
    execFileSync('zip', ['-rq', archivePath, rootName], {
      cwd: stageParent,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return;
  } catch (err) {
    if (process.platform === 'darwin') {
      execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', path.join(stageParent, rootName), archivePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return;
    }
    throw err;
  }
}

function stagePackageTree(stageRoot) {
  mkdirSync(stageRoot, { recursive: true });

  for (const rel of INCLUDE_FILES) {
    const src = path.join(REPO_ROOT, rel);
    if (existsSync(src)) {
      cpSync(src, path.join(stageRoot, rel));
    }
  }

  for (const dir of INCLUDE_DIRS) {
    const src = path.join(REPO_ROOT, dir);
    if (existsSync(src)) {
      cpSync(src, path.join(stageRoot, dir), {
        recursive: true,
        filter: (srcPath) => {
          const base = path.basename(srcPath);
          if (base === '.DS_Store' || base.endsWith('.log') || base.endsWith('.tmp') || base.startsWith('.env')) {
            return false;
          }
          if (base === 'studio-prefs.json' || base === 'project-suggestions-config.json') {
            return false;
          }
          return true;
        },
      });
    }
  }

  const installAgentDoc = path.join(REPO_ROOT, 'docs', 'INSTALL_AGENT.md');
  if (existsSync(installAgentDoc)) {
    mkdirSync(path.join(stageRoot, 'docs'), { recursive: true });
    cpSync(installAgentDoc, path.join(stageRoot, 'docs', 'INSTALL_AGENT.md'));
  }
}

export async function packRelease({ outDir = DIST_DIR, versionOverride = '', platform = 'macos' } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const version = versionOverride || String(pkg.version || '0.0.0').trim();
  const requested = String(platform || 'macos').toLowerCase();
  const targets = requested === 'all' ? ['macos', 'windows'] : [requested];
  for (const t of targets) {
    if (t !== 'macos' && t !== 'windows') {
      throw new Error(`Unsupported release platform '${t}'. Expected macos | windows | all.`);
    }
  }

  // 1. Pre-compile both runtime bundles so end users do NOT need `npm install` or `esbuild`.
  await buildUserCustomJs({ writeToRepo: true });
  const studioIife = await compileStudioCoreIife();
  mkdirSync(path.dirname(PREBUILT_STUDIO_ENTRY), { recursive: true });
  writeFileSync(PREBUILT_STUDIO_ENTRY, `${studioIife}\n`, 'utf8');

  mkdirSync(outDir, { recursive: true });
  const artifacts = [];

  for (const target of targets) {
    const rootName = `agy-studio-v${version}-${target}`;
    const archiveName = target === 'windows' ? `${rootName}.zip` : `${rootName}.tar.gz`;
    const archivePath = path.join(outDir, archiveName);
    const shaPath = `${archivePath}.sha256`;

    const stageParent = mkdtempSync(path.join(tmpdir(), 'maga-release-'));
    const stageRoot = path.join(stageParent, rootName);

    try {
      stagePackageTree(stageRoot);
      if (target === 'windows') {
        createZipArchive(stageParent, rootName, archivePath);
      } else {
        execFileSync('tar', ['-czf', archivePath, '-C', stageParent, rootName], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }

      const buf = readFileSync(archivePath);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      writeFileSync(shaPath, `${sha256}  ${archiveName}\n`, 'utf8');

      artifacts.push({
        platform: target,
        archive: archivePath,
        sha256File: shaPath,
        sha256,
        bytes: statSync(archivePath).size,
      });
    } finally {
      rmSync(stageParent, { recursive: true, force: true });
    }
  }

  const primary = artifacts[0];
  return {
    ok: true,
    version,
    platform: requested,
    archive: primary.archive,
    sha256File: primary.sha256File,
    sha256: primary.sha256,
    bytes: primary.bytes,
    artifacts,
  };
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);
  } catch {
    return false;
  }
})();

if (isMain) {
  const opts = parseCliOpts(process.argv.slice(2));
  const result = await packRelease(opts);
  console.log(JSON.stringify(result, null, 2));
}
