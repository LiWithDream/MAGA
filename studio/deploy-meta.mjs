/**
 * Deployment Provenance Recorder for agy-studio (`~/.gemini/antigravity/anti-claude/deploy-meta.json`).
 * Atomic write; never modifies studio-prefs.json.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameWithWinRetry } from '../core/daemon/env.mjs';

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

const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

export function isReleaseTagRef(ref) {
  return RELEASE_TAG_RE.test(String(ref || '').trim());
}

function pickExactReleaseTag(repoRoot) {
  const raw = runGitRead(repoRoot, ['tag', '--points-at', 'HEAD']);
  if (!raw) return '';
  const tags = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((t) => RELEASE_TAG_RE.test(t));
  if (!tags.length) return '';
  tags.sort((a, b) => {
    const ma = a.match(RELEASE_TAG_RE);
    const mb = b.match(RELEASE_TAG_RE);
    for (let i = 1; i <= 3; i += 1) {
      const diff = Number(mb[i]) - Number(ma[i]);
      if (diff !== 0) return diff;
    }
    const aPre = a.includes('-');
    const bPre = b.includes('-');
    if (aPre !== bPre) return aPre ? 1 : -1;
    return b.localeCompare(a);
  });
  return tags[0];
}

export function collectGitDeployProvenance(repoRoot) {
  const absRoot = path.resolve(String(repoRoot || process.cwd()));
  let branch = runGitRead(absRoot, ['symbolic-ref', '--short', 'HEAD']);
  const sha = runGitRead(absRoot, ['rev-parse', 'HEAD']);
  const shortSha = runGitRead(absRoot, ['rev-parse', '--short', 'HEAD']);
  const topLevel = runGitRead(absRoot, ['rev-parse', '--show-toplevel']) || absRoot;
  const releaseTag = sha ? pickExactReleaseTag(absRoot) : '';
  if (!branch && sha) branch = releaseTag || 'HEAD';
  const statusOut = runGitRead(absRoot, ['status', '--porcelain']);
  let isLinkedWorktree = false;
  try {
    isLinkedWorktree = fs.lstatSync(path.join(topLevel, '.git')).isFile();
  } catch {}
  return {
    schema: 1,
    branch,
    releaseTag,
    sha,
    shortSha,
    worktreePath: topLevel,
    isLinkedWorktree,
    dirty: Boolean(statusOut),
    deployedAt: Date.now(),
  };
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
    const releaseTag = String(meta.releaseTag || '').trim();
    const isMainOrTag =
      branch === 'main' || branch === 'master' || isReleaseTagRef(releaseTag || branch);
    const nonMainWarning =
      branch && !isMainOrTag
        ? `Live bundle was deployed from branch '${branch}' (${meta.worktreePath || 'unknown'}), not 'main'.`
        : null;
    return { present: true, meta, nonMainWarning };
  } catch {
    return { present: false, meta: null, nonMainWarning: null };
  }
}

export function evaluateDeployGuard(
  repoRoot,
  { allowNonMain = false, mode = 'deploy', metaPath = DEPLOY_META_PATH, platform = process.platform } = {}
) {
  const daemonLabel =
    platform === 'darwin' ? 'LaunchAgent daemon' : platform === 'win32' ? 'Windows daemon' : 'systemd daemon';
  const provenance = collectGitDeployProvenance(repoRoot);
  const live = readDeployMeta(metaPath);
  const isExactReleaseTag = Boolean(provenance.releaseTag && isReleaseTagRef(provenance.releaseTag));
  const isNonMainBranch = Boolean(
    provenance.branch && provenance.branch !== 'main' && provenance.branch !== 'master' && !isExactReleaseTag
  );
  const needsBranchOrWtGuard = provenance.isLinkedWorktree || isNonMainBranch;
  const needsGuard = needsBranchOrWtGuard || provenance.dirty;

  const liveBranch = live.present && live.meta?.branch ? live.meta.branch : '';
  const liveWorktree = live.present && live.meta?.worktreePath ? live.meta.worktreePath : '';
  const liveSummary = liveBranch
    ? `Currently live bundle was deployed from '${liveBranch}' (${liveWorktree || 'unknown'}).`
    : '';

  if (mode === 'install' && (!provenance.isLinkedWorktree || allowNonMain)) {
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
        `Blocked deploy from ${srcDesc}: Antigravity Desktop shares a single live runtime (~/.gemini/antigravity/anti-claude/user/) while the ${daemonLabel} runs core/daemon.mjs from the primary checkout, so deploying from a feature worktree clobbers other live features and risks UI/daemon split-brain.`
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
      `Preview deploy from '${provenance.branch || 'unknown'}' (${provenance.worktreePath}): ${daemonLabel} still serves core/daemon.mjs from primary checkout (UI/daemon split-brain risk).`
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
