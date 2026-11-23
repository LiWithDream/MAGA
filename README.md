# MAGA — Make Antigravity Great Again

Personal unified enhancement layer for **Google Antigravity Desktop 2.0**, combining [`hongqi7/Anti-Claude`](https://github.com/hongqi7/Anti-Claude) (CDP daemon, Claude-style UI, right Overview panel) with internalized zero-sidecar modules from [`Lumidarin/agy-capsule`](https://github.com/Lumidarin/agy-capsule) (model/effort picker, live speed activity indicator, daily & per-model Token usage stats) and custom visual polish.

## Architecture

Designed for clean separation and conflict-free upstream pulls:

- `core/` & `user/` — Upstream Anti-Claude base (only a 5-line lazy hook in `core/daemon.mjs` registers `getUsageStats`; upstream `user/custom.{js,css}` remain untouched).
- `vendor/agy-capsule/` — Vendored zero-dependency modules from `agy-capsule` + `VERSION.json` commit manifest.
- `studio/` — Modular custom layer:
  - `daemon/usage-reader.mjs` & `daemon/usage-service.mjs` — Incremental mtime/WAL-cached SQLite usage scanner running inside the single Anti-Claude daemon.
  - `modules/capsule-picker.mjs` — Shadow-DOM model picker, 18px animated effort slider, Orchestrator dock, and model-tinted footer capsule.
  - `modules/footer-unified.mjs` — Context ratio (`used / limit`) + 3-tier `0/60/75%` warnings + live working indicator dot & `tok/s` speed tiers (`fast / mid / slow`).
  - `modules/overview-usage.mjs` — Collapsible `用量统计 / Token Usage` card embedded inside the right Overview panel (Today/Week/Month KPIs, Day/Week/Month stacked bar chart, per-model breakdown with effort-tier tooltips).
  - `styles/` — Focused stylesheets (`typography.css`, `footer-capsules.css`, `quota-popover.css`, `overview-usage.css`).
  - `rules/fast-io.md` — Critically pruned fast-io rules (search/read/whitelist efficiency without restricting response depth).
  - `build.mjs` & `cli.mjs` — Syntax-validated bundler and single CLI entrypoint.

## Quick Commands

```bash
# Full installation (switches LaunchAgent daemon to this repo + deploys bundle + syncs fast-io rules)
npm run install-all

# Hot-reload bundle after editing anything under studio/
npm run deploy

# Health check (daemon, plist path, CDP, usage stats, remoteControlEnabled, AGENTS.md)
npm run doctor

# Pull updated agy-capsule files from a local clone and re-deploy
npm run sync-capsule -- ~/agy-capsule

# Roll back studio layer to stock Anti-Claude
npm run rollback
```

## Pulling Upstream Updates

```bash
# 1. Pull latest Anti-Claude upstream
git fetch upstream-anti-claude
git merge upstream-anti-claude/main

# 2. (Optional) Refresh vendored agy-capsule modules
git -C ~/agy-capsule pull
npm run sync-capsule -- ~/agy-capsule

# 3. Re-install / hot-deploy
npm run install-all
npm run doctor
```
