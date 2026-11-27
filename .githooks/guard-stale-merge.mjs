#!/usr/bin/env node
/**
 * Stale-Merge Guardrail (.githooks/guard-stale-merge.mjs).
 * Blocks commits/merges whose MERGE_HEAD points at a branch tip that is behind
 * or diverged from live `origin/refs/heads/<branch>` queried via `git ls-remote`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHA40_RE = /^[0-9a-f]{40}$/i;
const realpathNative = fs.realpathSync.native || fs.realpathSync;

function normExecPath(p) {
  const s = String(p || '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function buildChildEnv(env) {
  return {
    ...process.env,
    ...(env || {}),
    GIT_TERMINAL_PROMPT: '0',
  };
}

function resolveGitPath(cwd, gitFile, { execFile, childEnv }) {
  try {
    const out = execFile('git', ['-C', cwd, 'rev-parse', '--git-path', gitFile], {
      encoding: 'utf8',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out ? path.resolve(cwd, out) : '';
  } catch {
    return '';
  }
}

function collectBranchesForMergeSha(cwd, mergeSha, isPrimary, mergeMsgPath, { execFile, childEnv }) {
  const branches = new Set();
  try {
    const refsOut = execFile(
      'git',
      ['-C', cwd, 'for-each-ref', '--points-at', mergeSha, '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'],
      {
        encoding: 'utf8',
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    for (const rawLine of refsOut.split(/\r?\n/)) {
      const ref = rawLine.trim();
      if (!ref) continue;
      if (ref.startsWith('refs/heads/')) {
        const name = ref.slice('refs/heads/'.length);
        if (name) branches.add(name);
      } else if (ref.startsWith('refs/remotes/origin/')) {
        const name = ref.slice('refs/remotes/origin/'.length);
        if (name && name !== 'HEAD') branches.add(name);
      }
    }
  } catch {}

  if (isPrimary && mergeMsgPath && fs.existsSync(mergeMsgPath)) {
    try {
      const firstLine = fs.readFileSync(mergeMsgPath, 'utf8').split(/\r?\n/)[0] || '';
      const m = firstLine.match(/Merge\s+(?:remote-tracking\s+)?branch\s+'(?:origin\/)?([^']+)'/);
      if (m && m[1] && m[1] !== 'HEAD') {
        branches.add(m[1]);
      }
    } catch {}
  }

  return Array.from(branches);
}

export function checkStaleMerge({ cwd = process.cwd(), env = process.env, execFile = execFileSync } = {}) {
  const effectiveEnv = { ...process.env, ...(env || {}) };
  if (effectiveEnv.MAGA_ALLOW_STALE_MERGE === '1') {
    return { allowed: true, reason: 'override' };
  }

  const childEnv = buildChildEnv(effectiveEnv);
  const mergeHeadPath = resolveGitPath(cwd, 'MERGE_HEAD', { execFile, childEnv });
  if (!mergeHeadPath || !fs.existsSync(mergeHeadPath)) {
    return { allowed: true, reason: 'no_merge_head' };
  }

  const mergeShas = fs
    .readFileSync(mergeHeadPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => SHA40_RE.test(line))
    .map((line) => line.toLowerCase());
  if (mergeShas.length === 0) {
    return { allowed: true, reason: 'no_merge_head' };
  }

  let originUrl = '';
  try {
    originUrl = execFile('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    originUrl = '';
  }
  if (!originUrl) {
    return { allowed: true, reason: 'no_origin' };
  }

  const mergeMsgPath = resolveGitPath(cwd, 'MERGE_MSG', { execFile, childEnv });
  const branchToMergeShas = new Map();
  mergeShas.forEach((mergeSha, idx) => {
    const candidates = collectBranchesForMergeSha(cwd, mergeSha, idx === 0, mergeMsgPath, { execFile, childEnv });
    for (const branch of candidates) {
      if (!branchToMergeShas.has(branch)) branchToMergeShas.set(branch, new Set());
      branchToMergeShas.get(branch).add(mergeSha);
    }
  });

  const candidateBranches = Array.from(branchToMergeShas.keys());
  if (candidateBranches.length === 0) {
    return { allowed: true, reason: 'no_branch_refs' };
  }

  let lsRemoteOut = '';
  try {
    lsRemoteOut = execFile(
      'git',
      ['-C', cwd, 'ls-remote', '--heads', 'origin', ...candidateBranches.map((b) => `refs/heads/${b}`)],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch (err) {
    const errMsg = String(err?.stderr || err?.message || err || 'unknown git ls-remote error').trim();
    if (effectiveEnv.MAGA_STRICT_REMOTE === '1') {
      return {
        allowed: false,
        reason: 'remote_unreachable',
        message: `[MAGA stale-merge guard] Failed to reach origin via git ls-remote while MAGA_STRICT_REMOTE=1 (${errMsg}). Run \`git fetch origin --prune\` or retry when online.`,
      };
    }
    return {
      allowed: true,
      reason: 'remote_unreachable_warn',
      warning: `[MAGA stale-merge guard] Warning: could not verify live origin refs (${errMsg}); proceeding offline.`,
    };
  }

  const remoteByBranch = new Map();
  for (const rawLine of lsRemoteOut.split(/\r?\n/)) {
    const m = rawLine.trim().match(/^([0-9a-f]{40})\trefs\/heads\/(.+)$/i);
    if (m) {
      remoteByBranch.set(m[2], m[1].toLowerCase());
    }
  }

  const mismatches = [];
  for (const [branch, shaSet] of branchToMergeShas.entries()) {
    const remoteSha = remoteByBranch.get(branch);
    if (!remoteSha) continue;
    for (const mergeSha of shaSet) {
      if (remoteSha === mergeSha) continue;
      let isAhead = false;
      try {
        execFile('git', ['-C', cwd, 'merge-base', '--is-ancestor', remoteSha, mergeSha], {
          encoding: 'utf8',
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        isAhead = true;
      } catch {
        isAhead = false;
      }
      if (!isAhead) {
        mismatches.push({ branch, mergeSha, remoteSha });
      }
    }
  }

  if (mismatches.length > 0) {
    const details = mismatches
      .map(
        (m) =>
          `  - '${m.branch}': local MERGE_HEAD ${m.mergeSha.slice(0, 7)} is behind or diverged from origin/${m.branch} (${m.remoteSha.slice(0, 7)})`
      )
      .join('\n');
    const message = [
      `[MAGA stale-merge guard] Blocked stale merge against outdated remote ref(s):`,
      details,
      `Run \`git merge --abort\` (if needed) and \`git fetch origin --prune\`, then merge the updated remote tip.`,
      `To override intentionally: MAGA_ALLOW_STALE_MERGE=1 git ...`,
    ].join('\n');
    return { allowed: false, reason: 'stale_merge', mismatches, message };
  }

  return { allowed: true, reason: 'verified' };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    return (
      normExecPath(realpathNative(fileURLToPath(import.meta.url))) ===
      normExecPath(realpathNative(path.resolve(process.argv[1])))
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const res = checkStaleMerge();
  if (res.warning) {
    console.error(res.warning);
  }
  if (!res.allowed) {
    console.error(res.message);
    process.exit(1);
  }
}
