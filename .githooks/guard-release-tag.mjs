#!/usr/bin/env node
/**
 * Release Tag Pre-Push Guardrail (.githooks/guard-release-tag.mjs).
 * Enforces three mechanical checks whenever pushing a `refs/tags/v*` release tag:
 *   1. Target commit is an ancestor of remote `<remote>/main` (or local `main` when offline),
 *      blocking unmerged branch tags or non-main historical tags (override: `MAGA_ALLOW_NON_MAIN_TAG=1`).
 *   2. No stranded unmerged remote branches outside `main`, `master`, or `wip/*`
 *      (live `git ls-remote --heads <remote>`, override: `MAGA_ALLOW_STRANDED_TAG=1`).
 *   3. Both `smoke/darwin` and `smoke/win32` GitHub Commit Statuses are `success` on the
 *      dereferenced target commit SHA (GitHub remotes only; override: `MAGA_SKIP_SMOKE=1`).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ZERO_SHA = '0000000000000000000000000000000000000000';
export const REQUIRED_SMOKE_CONTEXTS = ['smoke/darwin', 'smoke/win32'];

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

export function parseGitHubRepoSlug(remoteUrl) {
  const s = String(remoteUrl || '').trim();
  if (!s) return null;
  const m = s.match(/^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    slug: `${m[1]}/${m[2]}`,
  };
}

export function parsePrePushLines(stdinText) {
  const refs = [];
  for (const rawLine of String(stdinText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    refs.push({
      localRef: parts[0],
      localSha: parts[1],
      remoteRef: parts[2],
      remoteSha: parts[3],
    });
  }
  return refs;
}

function isExemptRemoteBranch(branch) {
  return branch === 'main' || branch === 'master' || branch.startsWith('wip/');
}

function resolveCommitSha(cwd, sha, { execFile, childEnv }) {
  try {
    const out = execFile('git', ['-C', cwd, 'rev-parse', `${sha}^{commit}`], {
      encoding: 'utf8',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (/^[0-9a-f]{40}$/i.test(out)) return out.toLowerCase();
  } catch {}
  return String(sha || '').trim().toLowerCase();
}

function resolveRemoteUrl(cwd, remoteName, fallbackUrl, { execFile, childEnv }) {
  if (fallbackUrl && String(fallbackUrl).trim()) return String(fallbackUrl).trim();
  try {
    return execFile('git', ['-C', cwd, 'remote', 'get-url', remoteName], {
      encoding: 'utf8',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function fetchRemoteHeads({ cwd, remoteName, strictRemote, execFile, childEnv }) {
  let lsRemoteOut = '';
  try {
    lsRemoteOut = execFile('git', ['-C', cwd, 'ls-remote', '--heads', remoteName], {
      encoding: 'utf8',
      timeout: 5000,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const errMsg = String(err?.stderr || err?.message || err || 'unknown git ls-remote error').trim();
    if (strictRemote) {
      return {
        ok: false,
        reason: 'remote_unreachable',
        message: `[MAGA release-tag guard] Failed to reach '${remoteName}' via git ls-remote while MAGA_STRICT_REMOTE=1 (${errMsg}).`,
      };
    }
    return {
      ok: true,
      reachable: false,
      heads: [],
      mainSha: '',
      warning: `[MAGA release-tag guard] Warning: could not verify remote branches on '${remoteName}' (${errMsg}); proceeding offline.`,
    };
  }

  const heads = [];
  let mainSha = '';
  for (const rawLine of lsRemoteOut.split(/\r?\n/)) {
    const m = rawLine.trim().match(/^([0-9a-f]{40})\trefs\/heads\/(.+)$/i);
    if (!m) continue;
    const remoteSha = m[1].toLowerCase();
    const branch = m[2];
    heads.push({ branch, remoteSha });
    if (branch === 'main') mainSha = remoteSha;
  }
  return { ok: true, reachable: true, heads, mainSha };
}

function resolveLocalMainRef(cwd, remoteName, { execFile, childEnv }) {
  const candidates = [
    { label: `${remoteName}/main`, ref: `refs/remotes/${remoteName}/main` },
    { label: 'main', ref: 'refs/heads/main' },
    { label: `${remoteName}/master`, ref: `refs/remotes/${remoteName}/master` },
    { label: 'master', ref: 'refs/heads/master' },
  ];
  for (const cand of candidates) {
    try {
      const sha = execFile('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `${cand.ref}^{commit}`], {
        encoding: 'utf8',
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .trim()
        .toLowerCase();
      if (/^[0-9a-f]{40}$/i.test(sha)) {
        return { label: cand.label, sha };
      }
    } catch {}
  }
  return null;
}

function isCommitAncestor(cwd, ancestorSha, descendantSha, { execFile, childEnv }) {
  try {
    execFile('git', ['-C', cwd, 'merge-base', '--is-ancestor', ancestorSha, descendantSha], {
      encoding: 'utf8',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function checkMainAncestryForCommit({ cwd, remoteName, tagName, targetCommitSha, remoteHeadsRes, execFile, childEnv }) {
  let mainRef = '';
  let mainSha = '';

  if (remoteHeadsRes?.reachable && remoteHeadsRes.mainSha) {
    mainRef = `${remoteName}/main`;
    mainSha = remoteHeadsRes.mainSha;
    let hasRemoteMainObj = false;
    try {
      execFile('git', ['-C', cwd, 'cat-file', '-e', `${mainSha}^{commit}`], {
        encoding: 'utf8',
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      hasRemoteMainObj = true;
    } catch {
      hasRemoteMainObj = false;
    }
    if (!hasRemoteMainObj) {
      return {
        ok: false,
        reason: 'main_ref_not_fetched',
        mainRef,
        mainSha,
        message: [
          `[MAGA release-tag guard] Remote '${mainRef}' (${mainSha.slice(0, 7)}) is not present in local git objects; cannot verify '${tagName}' (${targetCommitSha.slice(0, 7)}) ancestry.`,
          `Run \`git fetch ${remoteName} main\` and retry.`,
          `To override intentionally: MAGA_ALLOW_NON_MAIN_TAG=1 git push ${remoteName} ${tagName}`,
        ].join('\n'),
      };
    }
  } else {
    const localMain = resolveLocalMainRef(cwd, remoteName, { execFile, childEnv });
    if (!localMain) {
      return {
        ok: false,
        reason: 'main_branch_missing',
        message: [
          `[MAGA release-tag guard] Refusing to push release tag '${tagName}' (${targetCommitSha.slice(0, 7)}): could not resolve '${remoteName}/main' or local 'main' to verify ancestry.`,
          `To override intentionally: MAGA_ALLOW_NON_MAIN_TAG=1 git push ${remoteName} ${tagName}`,
        ].join('\n'),
      };
    }
    mainRef = localMain.label;
    mainSha = localMain.sha;
  }

  if (!isCommitAncestor(cwd, targetCommitSha, mainSha, { execFile, childEnv })) {
    return {
      ok: false,
      reason: 'tag_not_on_main',
      mainRef,
      mainSha,
      message: [
        `[MAGA release-tag guard] Refusing to push release tag '${tagName}' (${targetCommitSha.slice(0, 7)}): commit is not reachable from ${mainRef} (${mainSha.slice(0, 7)}).`,
        `Release tags must point to commits merged into 'main' (prevents pushing unmerged branches or non-main historical tags).`,
        `To override intentionally: MAGA_ALLOW_NON_MAIN_TAG=1 git push ${remoteName} ${tagName}`,
      ].join('\n'),
    };
  }

  return { ok: true, mainRef, mainSha };
}

function checkStrandedBranchesForCommit({ cwd, remoteName, tagName, targetCommitSha, remoteHeadsRes, execFile, childEnv }) {
  const stranded = [];
  for (const { branch, remoteSha } of remoteHeadsRes?.heads || []) {
    if (isExemptRemoteBranch(branch)) continue;
    if (!isCommitAncestor(cwd, remoteSha, targetCommitSha, { execFile, childEnv })) {
      stranded.push({ branch, remoteSha });
    }
  }

  if (stranded.length > 0) {
    const details = stranded
      .map((s) => `  - ${remoteName}/${s.branch} (${s.remoteSha.slice(0, 7)}) is not an ancestor of ${tagName} (${targetCommitSha.slice(0, 7)})`)
      .join('\n');
    return {
      ok: false,
      reason: 'stranded_branches',
      stranded,
      message: [
        `[MAGA release-tag guard] Refusing to push release tag '${tagName}' while unmerged remote branches exist:`,
        details,
        `Run \`git fetch ${remoteName} --prune && git branch -r --no-merged ${tagName}\` to merge or clean them up (or rename unfinished work to wip/*).`,
        `To override intentionally: MAGA_ALLOW_STRANDED_TAG=1 git push ${remoteName} ${tagName}`,
      ].join('\n'),
    };
  }

  return { ok: true };
}

function checkSmokeStatusesForCommit({ slug, remoteName, tagName, targetCommitSha, execFile, childEnv }) {
  let rawJson = '';
  try {
    rawJson = execFile('gh', ['api', `repos/${slug}/commits/${targetCommitSha}/status`], {
      encoding: 'utf8',
      timeout: 8000,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const errMsg = String(err?.stderr || err?.message || err || 'gh api failed').trim();
    return {
      ok: false,
      reason: 'smoke_check_unreachable',
      message: [
        `[MAGA release-tag guard] Failed to query GitHub smoke statuses for ${slug}@${targetCommitSha.slice(0, 7)} (${errMsg}).`,
        `Ensure commit ${targetCommitSha.slice(0, 7)} is pushed to '${remoteName}', check \`gh auth status\`, and run \`npm run smoke:live\` on macOS & Windows.`,
        `To override intentionally: MAGA_SKIP_SMOKE=1 git push ${remoteName} ${tagName}`,
      ].join('\n'),
    };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      ok: false,
      reason: 'smoke_status_invalid_json',
      message: `[MAGA release-tag guard] Unexpected non-JSON response from 'gh api repos/${slug}/commits/${targetCommitSha}/status'.`,
    };
  }

  const statuses = Array.isArray(parsed?.statuses) ? parsed.statuses : [];
  const stateByContext = new Map();
  for (const st of statuses) {
    if (!st || typeof st.context !== 'string') continue;
    if (!stateByContext.has(st.context)) {
      stateByContext.set(st.context, String(st.state || 'missing').toLowerCase());
    }
  }

  const missingOrFailed = [];
  for (const ctx of REQUIRED_SMOKE_CONTEXTS) {
    const st = stateByContext.get(ctx) || 'missing';
    if (st !== 'success') {
      missingOrFailed.push({ context: ctx, state: st });
    }
  }

  if (missingOrFailed.length > 0) {
    const lines = REQUIRED_SMOKE_CONTEXTS.map((ctx) => {
      const st = stateByContext.get(ctx) || 'missing';
      return `  - ${ctx}: ${st}`;
    });
    return {
      ok: false,
      reason: 'smoke_status_missing',
      missingOrFailed,
      message: [
        `[MAGA release-tag guard] Refusing to push release tag '${tagName}' (${targetCommitSha.slice(0, 7)}) until both macOS and Windows live smoke checks pass:`,
        ...lines,
        `Run \`npm run smoke:live\` on each missing platform after deploying ${targetCommitSha.slice(0, 7)}.`,
        `To override intentionally: MAGA_SKIP_SMOKE=1 git push ${remoteName} ${tagName}`,
      ].join('\n'),
    };
  }

  return { ok: true };
}

export function checkReleaseTagPush({
  cwd = process.cwd(),
  remoteName = 'origin',
  remoteUrl = '',
  pushedRefs = [],
  env = process.env,
  execFile = execFileSync,
} = {}) {
  const effectiveEnv = { ...process.env, ...(env || {}) };
  const releaseTags = (pushedRefs || []).filter(
    (r) => r && typeof r.remoteRef === 'string' && r.remoteRef.startsWith('refs/tags/v') && r.localSha && r.localSha !== ZERO_SHA
  );

  if (releaseTags.length === 0) {
    return { allowed: true, reason: 'no_release_tag', warnings: [] };
  }

  const childEnv = buildChildEnv(effectiveEnv);
  const strictRemote = effectiveEnv.MAGA_STRICT_REMOTE === '1';
  const resolvedUrl = resolveRemoteUrl(cwd, remoteName, remoteUrl, { execFile, childEnv });
  const slug =
    String(effectiveEnv.MAGA_SMOKE_REPO || '').trim() ||
    parseGitHubRepoSlug(resolvedUrl)?.slug ||
    '';

  const warnings = [];
  const allowNonMainTag = effectiveEnv.MAGA_ALLOW_NON_MAIN_TAG === '1';
  const allowStrandedTag = effectiveEnv.MAGA_ALLOW_STRANDED_TAG === '1';
  let remoteHeadsRes = null;
  if (!allowNonMainTag || !allowStrandedTag) {
    remoteHeadsRes = fetchRemoteHeads({ cwd, remoteName, strictRemote, execFile, childEnv });
    if (remoteHeadsRes.warning) warnings.push(remoteHeadsRes.warning);
    if (!remoteHeadsRes.ok) {
      return {
        allowed: false,
        reason: remoteHeadsRes.reason,
        warnings,
        message: remoteHeadsRes.message,
      };
    }
  }

  for (const ref of releaseTags) {
    const tagName = ref.remoteRef.slice('refs/tags/'.length);
    const targetCommitSha = resolveCommitSha(cwd, ref.localSha, { execFile, childEnv });

    if (!allowNonMainTag) {
      const mainRes = checkMainAncestryForCommit({
        cwd,
        remoteName,
        tagName,
        targetCommitSha,
        remoteHeadsRes,
        execFile,
        childEnv,
      });
      if (!mainRes.ok) {
        return {
          allowed: false,
          reason: mainRes.reason,
          tagName,
          targetCommitSha,
          warnings,
          message: mainRes.message,
          ...(mainRes.mainRef ? { mainRef: mainRes.mainRef, mainSha: mainRes.mainSha } : {}),
        };
      }
    }

    if (!allowStrandedTag) {
      const strandedRes = checkStrandedBranchesForCommit({
        cwd,
        remoteName,
        tagName,
        targetCommitSha,
        remoteHeadsRes,
        execFile,
        childEnv,
      });
      if (!strandedRes.ok) {
        return {
          allowed: false,
          reason: strandedRes.reason,
          tagName,
          targetCommitSha,
          warnings,
          message: strandedRes.message,
          ...(strandedRes.stranded ? { stranded: strandedRes.stranded } : {}),
        };
      }
    }

    if (slug && effectiveEnv.MAGA_SKIP_SMOKE !== '1') {
      const smokeRes = checkSmokeStatusesForCommit({
        slug,
        remoteName,
        tagName,
        targetCommitSha,
        execFile,
        childEnv,
      });
      if (smokeRes.warning) warnings.push(smokeRes.warning);
      if (!smokeRes.ok) {
        return {
          allowed: false,
          reason: smokeRes.reason,
          tagName,
          targetCommitSha,
          warnings,
          message: smokeRes.message,
          ...(smokeRes.missingOrFailed ? { missingOrFailed: smokeRes.missingOrFailed } : {}),
        };
      }
    }
  }

  return { allowed: true, reason: 'verified', warnings };
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
  const remoteName = process.argv[2] || 'origin';
  const remoteUrl = process.argv[3] || '';
  let stdinText = '';
  try {
    stdinText = fs.readFileSync(0, 'utf8');
  } catch {
    stdinText = '';
  }
  const pushedRefs = parsePrePushLines(stdinText);
  const res = checkReleaseTagPush({ remoteName, remoteUrl, pushedRefs });
  for (const w of res.warnings || []) {
    console.error(w);
  }
  if (!res.allowed) {
    console.error(res.message);
    process.exit(1);
  }
}
