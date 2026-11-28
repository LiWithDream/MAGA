#!/usr/bin/env node
/**
 * Standalone AGY Studio Git Worktree Lifecycle CLI (`npm run wt:list|wt:new|wt:clean`).
 * Repo-local companion to the universal global plugin CLI (`studio/plugin/maga-git-workflow/bin/wt.mjs`).
 */
import path from 'node:path';
import { REPO_ROOT } from '../core/daemon/env.mjs';
import {
  createRepoWorktreeAsync,
  listRepoWorktreesAsync,
  normalizeRealPath,
  removeRepoWorktreeAsync,
} from '../core/daemon/worktrees.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--delete-branch' || tok === '--force-active' || tok === '--json') {
      flags.set(tok, true);
    } else if ((tok === '--base' || tok === '--repo' || tok === '--cid') && i + 1 < argv.length) {
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
  const repoDir = flags.get('--repo') ? path.resolve(flags.get('--repo')) : REPO_ROOT;

  if (sub === 'list') {
    const res = await listRepoWorktreesAsync(repoDir, { includeStats: true, force: true });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exit(1);
    return;
  }

  if (sub === 'new') {
    const target = positional[0] || '';
    if (!target) {
      console.error('Usage: node studio/wt-cli.mjs new <type/slug|slug> [--base <branch>]');
      process.exit(1);
    }
    const baseBranch = flags.get('--base') || '';
    const opts = target.includes('/')
      ? { branch: target, baseBranch, allowUnregistered: true }
      : { type: 'feat', slug: target, baseBranch, allowUnregistered: true };
    const res = await createRepoWorktreeAsync(repoDir, opts);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exit(1);
    return;
  }

  if (sub === 'clean') {
    const target = positional[0] || '';
    if (!target) {
      console.error('Usage: node studio/wt-cli.mjs clean <branch-or-path> [--delete-branch] [--force-active]');
      process.exit(1);
    }
    const listRes = await listRepoWorktreesAsync(repoDir, { force: true });
    if (!listRes.ok) {
      console.log(JSON.stringify(listRes, null, 2));
      process.exit(1);
    }
    const targetNorm = normalizeRealPath(path.resolve(repoDir, target));
    const matched = listRes.worktrees.find(
      (w) =>
        w.branch === target ||
        normalizeRealPath(w.realPath) === targetNorm ||
        normalizeRealPath(w.path) === targetNorm
    );
    const worktreePath = matched ? matched.realPath : target;
    const callerCid = String(flags.get('--cid') || process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
    const res = await removeRepoWorktreeAsync(repoDir, {
      worktreePath,
      deleteBranch: Boolean(flags.get('--delete-branch')),
      forceActive: Boolean(flags.get('--force-active')),
      callerCid,
      allowUnregistered: true,
    });
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exit(1);
    return;
  }

  console.error(`Unknown wt-cli command: ${sub}. Expected list | new | clean.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
