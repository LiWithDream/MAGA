# Changelog

All notable changes to **MAGA (`agy-studio`)** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
