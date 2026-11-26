---
name: git-workflow
description: Zero-config parallel Git worktree & tiered branch protection workflow (`observe` | `protect-main` | `worktree-only`) across any Antigravity project using MAGA's universal `wt.mjs` CLI.
---

# MAGA Parallel Git Workflow (`git-workflow`)

Safely isolate concurrent tasks into sibling Git worktrees (`<repo>-wt/<slug>`) across **any** local Git repository without needing per-repo scripts or config files.

## Policy Tiers (Configured per project in MAGA Cockpit / Settings)
- **`observe`** *(default)*: Zero friction; blocks force-push to protected branches (`main`, `master`, `origin/HEAD`) and auto-tracks linked worktrees per conversation in MAGA UI.
- **`protect-main`**: Blocks direct file edits & `git commit` on protected branches while allowing feature branches or worktrees.
- **`worktree-only`**: Locks primary checkout to clean main branch; all changes occur inside `<repo>-wt/<slug>` worktrees.

## Quick Commands (Works in Any Git Repo)
```bash
WT="$HOME/.gemini/config/plugins/maga-git-workflow/bin/wt.mjs"

# Check effective policy (read-only) & existing worktrees
node "$WT" policy --repo "$(pwd)"
node "$WT" list --repo "$(pwd)"

# Create an isolated worktree (supports feat/<slug> or custom branch names)
node "$WT" new feat/my-task --repo "$(pwd)"

# After merging cleanly via `git merge --no-ff <branch>`, remove clean worktree + merged branch
node "$WT" clean feat/my-task --repo "$(pwd)" --delete-branch
```

## Notes & Boundaries
- **Dependency handling**: When a repo contains `node_modules`, creating a worktree symlinks `node_modules` and writes `/node_modules` into untracked repo metadata (`.git/info/exclude`); Python/Rust/Go/LaTeX repos are left completely untouched.
- **Soft safety rail**: Client-side hooks prevent accidental local edits and force-pushes; keep remote server branch protection enabled on critical repositories.
- **Emergency escape hatches**: `MAGA_ALLOW_MAIN_COMMIT=1` (explicit commit on protected branch) and `MAGA_ALLOW_PRIMARY_CHECKOUT=1` (e.g., `git bisect` on primary checkout).
