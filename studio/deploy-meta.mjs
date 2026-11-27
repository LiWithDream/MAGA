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
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function normalizeFsPath(p) {
  if (!p) return '';
  let resolved = path.resolve(String(p));
  try {
    resolved = fs.realpathSync(resolved);
  } catch {}
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

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
  let isLinkedWorktree = false;
  try {
    isLinkedWorktree = fs.lstatSync(path.join(topLevel, '.git')).isFile();
  } catch {}
  return {
    schema: 1,
    branch,
    sha,
    shortSha,
    worktreePath: topLevel,
    isLinkedWorktree,
    dirty: Boolean(statusOut),
    deployedAt: Date.now(),
  };
}

const WIN_RETRY_SLEEP_BUF =
  typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

function renameWithWinRetry(src, dst) {
  if (process.platform !== 'win32') {
    fs.renameSync(src, dst);
    return;
  }
  for (let i = 0; i < 6; i += 1) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (err) {
      const code = err?.code;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || i === 5) {
        throw err;
      }
      if (WIN_RETRY_SLEEP_BUF) {
        try {
          Atomics.wait(WIN_RETRY_SLEEP_BUF, 0, 0, Math.min(200, Math.round(20 * Math.pow(1.6, i))));
        } catch {}
      }
    }
  }
}

export function writeDeployMeta(repoRoot, metaPath = DEPLOY_META_PATH, extra = {}) {
  const provenance = {
    ...collectGitDeployProvenance(repoRoot),
    ...(extra && typeof extra.preview === 'boolean' ? { preview: extra.preview } : {}),
  };
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  const tmp = `${metaPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
    renameWithWinRetry(tmp, metaPath);
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

export function evaluateDeployGuard(
  repoRoot,
  { allowNonMain = false, mode = 'deploy', metaPath = DEPLOY_META_PATH } = {}
) {
  const provenance = collectGitDeployProvenance(repoRoot);
  const live = readDeployMeta(metaPath);
  const isNonMainBranch = Boolean(provenance.branch && provenance.branch !== 'main' && provenance.branch !== 'master');
  const needsBranchOrWtGuard = provenance.isLinkedWorktree || isNonMainBranch;
  const needsGuard = needsBranchOrWtGuard || provenance.dirty;

  const liveBranch = live.present && live.meta?.branch ? live.meta.branch : '';
  const liveWorktree = live.present && live.meta?.worktreePath ? live.meta.worktreePath : '';
  const liveSummary = liveBranch
    ? `Currently live bundle was deployed from '${liveBranch}' (${liveWorktree || 'unknown'}).`
    : '';

  if (mode === 'install') {
    const warnings = [];
    if (needsBranchOrWtGuard) {
      warnings.push(
        `Installing from '${provenance.branch || 'unknown'}' (${provenance.worktreePath}).`
      );
    }
    if (liveWorktree && normalizeFsPath(liveWorktree) !== normalizeFsPath(provenance.worktreePath)) {
      warnings.push(
        `Replacing previous live bundle deployed from '${liveBranch || 'unknown'}' (${liveWorktree}).`
      );
    }
    if (provenance.dirty) {
      warnings.push(
        `Installing from a checkout with local uncommitted changes at '${provenance.worktreePath}'.`
      );
    }
    return {
      allowed: true,
      preview: false,
      warnings,
      provenance,
      live: live.meta,
      reason: null,
    };
  }

  if (needsGuard && !allowNonMain) {
    const parts = [];
    if (needsBranchOrWtGuard) {
      const srcDesc = provenance.isLinkedWorktree
        ? `linked worktree '${provenance.worktreePath}' (branch '${provenance.branch || 'unknown'}')`
        : `non-main branch '${provenance.branch}'`;
      parts.push(
        `Blocked deploy from ${srcDesc}: Antigravity Desktop shares a single live runtime (~/.gemini/antigravity/anti-claude/user/) while the LaunchAgent daemon runs core/daemon.mjs from the primary checkout, so deploying from a feature worktree clobbers other live features and risks UI/daemon split-brain.`
      );
      if (liveSummary) parts.push(liveSummary);
      parts.push(
        `Recommended: run 'npm test' here, merge '${provenance.branch || 'feature'}' into 'main' via --no-ff, and deploy from clean 'main'. For intentional single-feature live preview, pass '--preview' (npm run deploy -- --preview).`
      );
    } else {
      parts.push(
        `Blocked deploy from dirty primary '${provenance.branch || 'main'}' (${provenance.worktreePath}): commit or isolate uncommitted changes into a worktree before deploying so temporary edits do not leak to desktop runtime (or pass '--force' / '--preview' explicitly).`
      );
      if (liveSummary) parts.push(liveSummary);
    }
    return {
      allowed: false,
      preview: false,
      warnings: [],
      provenance,
      live: live.meta,
      reason: parts.join(' '),
    };
  }

  const warnings = [];
  if (needsBranchOrWtGuard) {
    warnings.push(
      `Preview deploy from '${provenance.branch || 'unknown'}' (${provenance.worktreePath}): LaunchAgent daemon still serves core/daemon.mjs from primary checkout (UI/daemon split-brain risk).`
    );
    if (liveWorktree && normalizeFsPath(liveWorktree) !== normalizeFsPath(provenance.worktreePath)) {
      warnings.push(`Replacing previous live bundle deployed from '${liveBranch || 'unknown'}' (${liveWorktree}).`);
    }
  }
  if (provenance.dirty) {
    warnings.push(`Deploying from dirty working tree at '${provenance.worktreePath}'.`);
  }

  return {
    allowed: true,
    preview: Boolean(needsGuard),
    warnings,
    provenance,
    live: live.meta,
    reason: null,
  };
}
