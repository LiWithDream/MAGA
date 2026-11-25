# Changelog

All notable changes to **MAGA (`agy-studio`)** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-11-25

Upgrade the standalone **Projects Workspace** into a cohesive cockpit with per-project token usage analytics, an active-conversation project topbar, live Git diff/commit inspection, remote-only repository support, static Orchestrator folding, and clamped conversation scrollbars.

### Added
- **Per-Project Token Usage Card, Hero Badge & Grid Badges (`studio/modules/project-usage.mjs`, `studio/modules/usage-card-core.mjs`, `studio/daemon/usage-service.mjs`, `vendor/agy-capsule/usage_history.mjs`)**: Extracted shared Day/Week/Month stacked chart and tooltip core (`usage-card-core.mjs`) and added on-demand per-project token usage summaries (`#agy-pd-usage-card`, `#agy-pd-hero-usage`, `.ag-proj-card-usage`, per-chat badges, and `agy:projects-usage-updated` event) with monotonic request sequencing and zero extra disk scans.
- **Active Conversation Project Topbar & Switcher (`user/src/modules/projects/conv-topbar.mjs`, `user/src/modules/sidebar-recents.mjs`)**: Added `#agy-conv-project-bar` in the titlebar showing the active conversation's project breadcrumb, portal workspace switcher menu (`#agy-conv-project-menu`), Git branch/remote badge (reveal in Finder, open remote URL, or right-click copy), and one-click `+ New chat` action while deduplicating native project breadcrumb segments.
- **Git Dirty-Files & Commit-Detail Drawers + Remote-Only Repo Support (`core/daemon/overview-skills.mjs`, `core/daemon/projects.mjs`, `user/src/modules/projects/{workspace-ui,native-store}.mjs`)**:
  - Added `readGitCommitDetailAsync` (`readGitCommitDetail` RPC) with `^{commit}` validation, NUL-delimited `--numstat -z` parsing (`parseNumstatZ`), and expandable commit-detail & dirty-files drawers in the Project Detail cockpit (`+`/`-` stats, Finder reveal, `@file` mention insertion, and remote commit links).
  - Added remote-only project detection and normalization (`isRemote`, `normalizeGitRemoteUrl`, `openExternalUrl` http(s)-only guard) for GitHub/GitLab/Bitbucket and SSH remotes without a local clone.
- **Static Orchestrator Dock Folding & Locked Busy Banner (`vendor/agy-capsule/model_picker.mjs`, `user/src/core/model-api.mjs`)**: Folded remote/static `Orchestrator (<Family>)` options into the standalone Orchestrator dock toggle, added Redux-only Project Detail model catalog synthesis with account-switch signature invalidation, and surfaced a localized transient busy banner when model selection is locked mid-generation.
- **Overlay Scrollbar Clamp & Sidebar Proximity Spacing (`studio/modules/scrollbar-clamp.mjs`, `studio/styles/footer-capsules.css`, `user/custom.css`)**: Added `MagaKernel`-driven `requestAnimationFrame`-coalesced overlay scrollbar thumb & `ScrollTimeline` keyframe clamping, offset the conversation scrollbar left of the Overview gutter, cleared the `75cqh` bottom spacer, and tightened sidebar project-group vs. standalone conversation spacing.
- **Project Detail MAGA Model Capsule Integration (`studio/modules/capsule-picker.mjs`, `vendor/agy-capsule/model_picker.mjs`, `user/src/core/model-api.mjs`)**: Connected `#ag-claude-projects-view` composer to the Shadow DOM capsule runtime—bringing `hiddenModels` filtering, family color dots, custom effort bars, motion themes, `defaultTierByFamily`, Orchestrator Dock switching, and automatic downward popover placement when positioned in the upper half of the viewport.
- **Daemon On-Demand Workspace Status RPC (`core/daemon/overview-skills.mjs`)**: Added `readProjectWorkspaceStatusAsync` + `readProjectWorkspaceStatus` RPC with bounded 8s cache and in-flight deduplication returning Git branch, clean/dirty file counts & +/- diff stats, 3 recent commits, latest Git tag, `package.json` version, and npm scripts.
- **Projects Cockpit UI Module (`user/src/modules/projects/workspace-ui.mjs`)**:
  - Hero Header displaying version pill, copyable short path chip, Git branch/dirty indicator, chat count badge, Finder reveal, path copy, and manual refresh actions.
  - Clean Markdown preview for `AGENTS.md` Instructions (stripping raw `#`, `**`, backticks, and fences while preserving line count).
  - Compact `Repository` card inside `.ag-pd-sidecard` displaying branch, dirty diff badge, and recent commits.
  - Empty-state Quick Starters card with workspace readiness pills and 4 one-click starter prompt tiles that populate and focus the composer.
  - Inline `Recents` filter bar and conversation count badge when 4+ project chats exist.

### Changed
- Changed `claudeUxHideSidebarProjects` default from `true` to `false` (`user/src/core/runtime-ctx.mjs`, `studio/modules/studio-prefs.mjs`, `user/config.json`) so native sidebar project groupings remain visible alongside MAGA Projects by default.
- Widened Projects Detail shell (`max-width: 1120px`, `1.55fr` / `300-360px` column balance) with refined Light/Dark focus states and zero global `:has()` rules.

## [1.0.0] - 2026-11-25

First official stable architecture baseline for **MAGA (`agy-studio`)**, built on a unified single-observer scheduler and modular codebase.

### Added
- **Unified `MagaKernel` Scheduler (`studio/core/`)**: Single root `MutationObserver` with `data-maga-own` + `OWN_HOST_IDS` self-mutation filtering, topic-routed dirty flags, and batched read/write animation frames across all 8 runtime features.
- **`MetricsBus` & `DomFlags` (`studio/core/`)**: In-place text leaf updates (`setLeafText`) for live speed/metrics slots and imperative class/attribute flags replacing expensive global CSS selectors.
- **Unified Settings Workbench (`studio/modules/studio-settings.mjs`, `studio/modules/settings/`, `studio/modules/studio-prefs.mjs`, `studio/styles/studio-settings.css`)**: Centralized MAGA preferences, 3-tab capsule/theme preview workbench, and persistent `studio-prefs.json` storage.
- **Modular `user/src/` & esbuild Pipeline**: Decomposed monolithic `user/custom.js` into 16 cohesive ESM modules (all `< 2,000` lines), including `user/src/modules/projects/{shared,mentions-media,native-store,modals,index}.mjs`, compiled on demand via `npm run build:user`.
- **Modular Daemon & Subagent Runtime**: Split `core/daemon.mjs` into thin entrypoint + `core/daemon/` submodules and `studio/modules/subagent-footer.mjs` into `studio/modules/subagent/` submodules.
- **Architectural Regression Guards (`test/studio.test.mjs`)**: Automated checks enforcing single-observer kernel routing, zero `:has()` CSS rules, `< 2,000`-line module cap in `user/src/`, untracked build artifacts, and zero legacy compatibility shims.

### Changed
- Eliminated all global CSS `:has()` rules and high-cost backdrop filters; switched footer capsules to GPU-composited animations and isolated containment.
- Excluded generated `user/custom.js` from Git tracking via `.gitignore`; `install-all`, `deploy`, and `test` build it automatically from `user/src/entry.mjs`.
- Standardized default thinking effort tiers (including Gemini 4 Neon defaulting to High) and smoothed Overview / Aux split-panel choreography.

### Removed
- Pre-1.0 compatibility shims (`claudeUxModelMenu`, legacy `capsule-settings.json` migration, `LEGACY_JS_MARKERS` / `LEGACY_CSS_MARKERS`, `sync-capsule`, `.ag-cux-settings-wrap`).
- Unused vendored UI modules (`vendor/agy-capsule/turn_ui.mjs`, `vendor/agy-capsule/usage_ui.mjs`).
