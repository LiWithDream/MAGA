/**
 * Deployment Provenance Recorder for agy-studio (`~/.gemini/antigravity/anti-claude/deploy-meta.json`).
 * Atomic write; never modifies studio-prefs.json.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR = path.resolve(
  process.env.ANTI_CLAUDE_STATE_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'anti-claude')
);
export const DEPLOY_META_PATH = path.join(STATE_DIR, 'deploy-meta.json');

function runGitRead(repoRoot, args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      timeout: 1500,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

export function collectGitDeployProvenance(repoRoot) {
  const absRoot = path.resolve(String(repoRoot || process.cwd()));
  let branch = runGitRead(absRoot, ['symbolic-ref', '--short', 'HEAD']);
  const sha = runGitRead(absRoot, ['rev-parse', 'HEAD']);
  const shortSha = runGitRead(absRoot, ['rev-parse', '--short', 'HEAD']);
  const topLevel = runGitRead(absRoot, ['rev-parse', '--show-toplevel']) || absRoot;
  if (!branch && sha) branch = 'HEAD';
  const statusOut = runGitRead(absRoot, ['status', '--porcelain']);
  return {
    schema: 1,
    branch,
    sha,
    shortSha,
    worktreePath: topLevel,
    dirty: Boolean(statusOut),
    deployedAt: Date.now(),
  };
}

export function writeDeployMeta(repoRoot, metaPath = DEPLOY_META_PATH) {
  const provenance = collectGitDeployProvenance(repoRoot);
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  const tmp = `${metaPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, metaPath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
  return provenance;
}

export function readDeployMeta(metaPath = DEPLOY_META_PATH) {
  try {
    if (!metaPath || !fs.existsSync(metaPath)) {
      return { present: false, meta: null, nonMainWarning: null };
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (!meta || typeof meta !== 'object') {
      return { present: false, meta: null, nonMainWarning: null };
    }
    const branch = String(meta.branch || '').trim();
    const nonMainWarning =
      branch && branch !== 'main' && branch !== 'master'
        ? `Live bundle was deployed from branch '${branch}' (${meta.worktreePath || 'unknown'}), not 'main'.`
        : null;
    return { present: true, meta, nonMainWarning };
  } catch {
    return { present: false, meta: null, nonMainWarning: null };
  }
}
