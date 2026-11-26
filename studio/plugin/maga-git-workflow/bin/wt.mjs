#!/usr/bin/env node
/**
 * Universal MAGA Git Worktree CLI (`~/.gemini/config/plugins/maga-git-workflow/bin/wt.mjs`).
 * Works in ANY local Git repository without requiring repo-local npm scripts or config files.
 * Note: `policy` subcommand is strictly read-only; policy changes happen via MAGA Cockpit / Settings.
 */
import os from 'node:os';
import path from 'node:path';
import {
  createRepoWorktreeCore,
  getProtectedBranchesForRepo,
  listRepoWorktreesPorcelainAsync,
  normalizeRealPath,
  removeRepoWorktreeCore,
  resolveCommonGitDirAsync,
} from '../lib/worktree-core.mjs';
import {
  readWorkflowPolicy,
  resolveEffectiveProjectPolicy,
  resolveGitContext,
} from '../hooks/git-guard.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--delete-branch' || tok === '--force-active' || tok === '--json') {
      flags.set(tok, true);
    } else if (
      (tok === '--base' || tok === '--repo' || tok === '--cid') &&
      i + 1 < argv.length
    ) {
      flags.set(tok, argv[++i]);
    } else if (!tok.startsWith('-')) {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

async function main() {
  const [sub = 'list', ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const repoDir = path.resolve(flags.get('--repo') || process.cwd());

  if (sub === 'list') {
    const res = await listRepoWorktreesPorcelainAsync(repoDir);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exit(1);
    return;
  }

  if (sub === 'new') {
    const target = positional[0] || '';
    if (!target) {
      console.error('Usage: node wt.mjs new <branch-or-slug> [--repo <dir>] [--base <branch>]');
      process.exit(1);
    }
    const listRes = await listRepoWorktreesPorcelainAsync(repoDir);
    if (!listRes.ok) {
      console.log(JSON.stringify(listRes, null, 2));
      process.exit(1);
    }
    const mainEntry = listRes.worktrees.find((w) => w.isMain) || listRes.worktrees[0];
    const baseBranch = flags.get('--base') || '';
    const gitCtx = await resolveCommonGitDirAsync(repoDir);
    const policy = readWorkflowPolicy();
    const eff = gitCtx ? resolveEffectiveProjectPolicy(gitCtx, policy) : null;
    const opts = target.includes('/')
      ? { branch: target, baseBranch, allowGenericBranch: true, commonDir: gitCtx?.commonDir || '', protectedBranches: eff ? Array.from(eff.protectedBranches) : null }
      : { type: 'feat', slug: target, baseBranch, commonDir: gitCtx?.commonDir || '', protectedBranches: eff ? Array.from(eff.protectedBranches) : null };
    const created = await createRepoWorktreeCore(mainEntry, opts);
    console.log(JSON.stringify(created, null, 2));
    if (!created.ok) process.exit(1);
    return;
  }

  if (sub === 'clean') {
    const target = positional[0] || '';
    if (!target) {
      console.error('Usage: node wt.mjs clean <branch-or-path> [--repo <dir>] [--delete-branch] [--force-active]');
      process.exit(1);
    }
    const listRes = await listRepoWorktreesPorcelainAsync(repoDir);
    if (!listRes.ok) {
      console.log(JSON.stringify(listRes, null, 2));
      process.exit(1);
    }
    const mainEntry = listRes.worktrees.find((w) => w.isMain) || listRes.worktrees[0];
    const targetNorm = normalizeRealPath(path.resolve(repoDir, target));
    const matched = listRes.worktrees.find(
      (w) =>
        w.branch === target ||
        normalizeRealPath(w.realPath) === targetNorm ||
        normalizeRealPath(w.path) === targetNorm
    );
    const worktreePath = matched ? matched.realPath : target;
    const removed = await removeRepoWorktreeCore(mainEntry, listRes.worktrees, {
      worktreePath,
      deleteBranch: Boolean(flags.get('--delete-branch')),
      forceActive: Boolean(flags.get('--force-active')),
      commonDir: listRes.commonDir,
    });
    console.log(JSON.stringify(removed, null, 2));
    if (!removed.ok) process.exit(1);
    return;
  }

  if (sub === 'policy') {
    const ctx = resolveGitContext(repoDir);
    const policy = readWorkflowPolicy();
    if (!ctx) {
      console.log(JSON.stringify({ ok: false, error: 'not_git_repo', defaultMode: policy.defaultMode }, null, 2));
      process.exit(1);
    }
    const eff = resolveEffectiveProjectPolicy(ctx, policy);
    const prot = Array.from(getProtectedBranchesForRepo(ctx.commonDir, Array.from(eff.protectedBranches)));
    console.log(
      JSON.stringify(
        {
          ok: true,
          readOnly: true,
          repoRoot: ctx.mainRoot,
          commonDirKey: ctx.commonDirKey,
          branch: ctx.branch,
          isLinkedWorktree: ctx.isLinkedWorktree,
          mode: eff.mode,
          source: eff.source,
          protectedBranches: prot,
          blockForcePushProtected: eff.blockForcePushProtected,
          blockPushTags: eff.blockPushTags,
          note: 'Change per-project mode via AGY Studio Projects Cockpit or AGY Studio Settings UI.',
        },
        null,
        2
      )
    );
    return;
  }

  console.error(`Unknown wt.mjs command: ${sub}. Expected list | new | clean | policy.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
