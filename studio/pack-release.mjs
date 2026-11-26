#!/usr/bin/env node
/**
 * Release Packager for AGY Studio (`agy-studio`).
 * Pre-compiles browser bundles (`user/custom.js` + `studio/prebuilt/studio-entry.js`)
 * and emits a zero-`npm-install` macOS Release tarball + SHA-256 checksum under `dist/`.
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out-dir' && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    } else if (a === '--version' && argv[i + 1]) {
      versionOverride = argv[++i].replace(/^v/, '').trim();
    }
  }
  return { outDir, versionOverride };
}

export async function packRelease({ outDir = DIST_DIR, versionOverride = '' } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const version = versionOverride || String(pkg.version || '0.0.0').trim();
  const rootName = `agy-studio-v${version}-macos`;
  const archiveName = `${rootName}.tar.gz`;

  // 1. Pre-compile both runtime bundles so end users do NOT need `npm install` or `esbuild`.
  await buildUserCustomJs({ writeToRepo: true });
  const studioIife = await compileStudioCoreIife();
  mkdirSync(path.dirname(PREBUILT_STUDIO_ENTRY), { recursive: true });
  writeFileSync(PREBUILT_STUDIO_ENTRY, `${studioIife}\n`, 'utf8');

  mkdirSync(outDir, { recursive: true });
  const archivePath = path.join(outDir, archiveName);
  const shaPath = `${archivePath}.sha256`;

  const stageParent = mkdtempSync(path.join(tmpdir(), 'maga-release-'));
  const stageRoot = path.join(stageParent, rootName);

  try {
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

    execFileSync('tar', ['-czf', archivePath, '-C', stageParent, rootName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const buf = readFileSync(archivePath);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    writeFileSync(shaPath, `${sha256}  ${archiveName}\n`, 'utf8');

    return {
      ok: true,
      version,
      archive: archivePath,
      sha256File: shaPath,
      sha256,
      bytes: statSync(archivePath).size,
    };
  } finally {
    rmSync(stageParent, { recursive: true, force: true });
  }
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
