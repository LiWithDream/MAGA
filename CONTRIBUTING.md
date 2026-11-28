# Contributing to AGY Studio

Thank you for contributing to **AGY Studio (`agy-studio`)**!

This repository uses **Trunk-Based Development**: `main` is the single integration branch, while end-user installs default to the latest GitHub Release tag (`--channel stable`).

---

## External Contributors (Fork & Pull Request)

1. **Fork & Branch**: Fork the repository, create a short-lived branch from `main` (for example `feat/my-fix` or `fix/windows-path`), and open a Pull Request targeting **`main`**.
2. **Prerequisites**: Node.js `>= 22`, then run `npm ci`.
3. **Verify Locally**:
   ```bash
   npm run build:remote && npm test
   ```
   All tests must pass with **0 failures and 0 skipped**.
4. **Update `CHANGELOG.md`**: Add a concise scoped entry under `## [Unreleased]` (`[cross]`, `[mac]`, `[win]`, or `[remote]`).
5. **Host Coupling Check** *(only if editing selectors, React fiber lookups, SQLite/Protobuf decoders, or RPC payloads)*:
   Run `npm run probe:host` against a local Antigravity Desktop instance and summarize the output in your PR.
6. **What You Do NOT Need**:
   - You do **not** need to install local `.githooks`, create sibling worktrees via `npm run wt:new`, or report `smoke/darwin` / `smoke/win32` commit statuses. Those run on maintainer machines post-merge before tagging a release.
   - Maintainers typically merge external PRs via **Squash Merge**.

---

## Non-Negotiable Engineering Invariants

Automated tests in `test/` enforce these invariants directly:

- **Zero binary patches**: Never touch `/Applications/Antigravity.app` or `Antigravity.exe` / `app.asar`.
- **Single root DOM observer**: Register UI features with `MagaKernel` (`studio/core/kernel.mjs`) and tag injected DOM containers with `data-maga-own="1"` (plus `OWN_HOST_IDS` / `OWN_ROW1_PILL_IDS`). Top-level Row 1 pill wrappers must be `<div>` containers, never `<button>`.
- **Zero global CSS `:has(...)`**: Use imperative DOM flags (`studio/core/dom-flags.mjs`), scoped CSS, and leaf text updates (`studio/core/metrics-bus.mjs`).
- **Module size cap**: Keep source files under `< 2,000` lines (`test/size-baseline.json` ratchets existing legacy stylesheets). Keep `user/custom.js`, `remote/pwa/dist`, and `dist/` untracked.
- **Hermetic tests**: Never write to `~/.gemini` or real home state in tests; inject `fs` / `stateDir` / `platform` and isolate inside `mkdtemp`.
- **Dual-OS parity & strict CSP**: Support both macOS (`darwin`) and Windows 10/11 (`win32`), and build `remote/pwa/src/` with Pure DOM + CSSOM (no `innerHTML` or inline `style="..."`).

---

## Maintainer Workflow

Maintainers running the live local daemon from the primary `main` checkout follow a stricter local workflow:

- **Isolated Worktrees**: Create sibling worktrees (`npm run wt:new -- <type>/<slug>`) and keep the primary checkout permanently on clean `main`. Merge maintainer branches with `git merge --no-ff`.
- **Live Deploy & Smoke**: After merging to clean `main`, run `npm run deploy`, restart the local daemon if `core/daemon/` or `studio/daemon/` changed, and run `npm run doctor && npm run smoke:live` (`smoke/darwin` / `smoke/win32`).
- **Releases & Hotfixes**: Align `package.json` and `CHANGELOG.md`, push an explicit annotated tag `git push origin vX.Y.Z` (never `git push --tags`). If cherry-picking a hotfix onto a historical release branch (`release/vX.Y.x`), delete the remote hotfix branch before pushing the tag so `stranded-branches` stays green (the tag preserves commit history).
