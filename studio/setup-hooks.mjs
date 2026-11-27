#!/usr/bin/env node
/**
 * Cross-platform Git hook installer (`npm run setup:hooks`).
 * Configures `core.hooksPath = .githooks` and applies executable bits on POSIX systems.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

if (process.platform !== 'win32') {
  for (const rel of ['pre-commit', 'pre-merge-commit', 'pre-push', 'guard-main-branch.mjs', 'guard-stale-merge.mjs', 'guard-release-tag.mjs']) {
    const abs = path.join(REPO_ROOT, '.githooks', rel);
    if (fs.existsSync(abs)) {
      fs.chmodSync(abs, 0o755);
    }
  }
}

console.log(JSON.stringify({ ok: true, hooksPath: '.githooks', platform: process.platform }));
