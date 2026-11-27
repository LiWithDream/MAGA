# Changelog

All notable changes to **AGY Studio (`agy-studio`, formerly MAGA)** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-11-27

Added full **Windows 10/11** support (parity across desktop daemon, CDP bootstrap, installers, Release `.zip` packager, Remote Control Named Pipes & dual-platform GitHub Actions CI), consolidated Remote filesystem/process primitives into a shared zero-dependency module, and modularized the Opus Gate hook sentinel.

### Added
- **Windows 10/11 Desktop & Installer Support (`core/daemon/win-service.mjs`, `core/daemon/cdp-bootstrap-win.mjs`, `install.ps1`, `uninstall.ps1`, `studio/setup-hooks.mjs`, `test/windows.test.mjs`)**:
  - Added headless user-level Task Scheduler daemon management (`AGYStudioDaemon` via `conhost.exe --headless`, with automatic Startup `.vbs` fallback on restricted GPOs), optional Start Menu shortcut `Antigravity (AGY Studio)` (`--remote-debugging-port=0`), and gentle `WM_CLOSE` CDP cold-boot relaunch + Windows System Proxy diagnostics.
  - Added one-line PowerShell installers (`install.ps1` / `uninstall.ps1` supporting `-DryRun`, `-NoRules`, `-NoShortcut`, `-Purge`, `npm ci` + `--autostash`), Windows Junction `node_modules` links in `wt.mjs`, and `npm run release:pack:win` / `release:pack:all` generating `agy-studio-v*-windows.zip` with bundled `remote/pwa/dist`.
- **Shared Remote Filesystem & Process Layer (`remote/shared/fs-paths.mjs`)**:
  - Consolidated `resolveRemoteDir`, `resolveSockPath` (Windows Named Pipes `\\.\pipe\maga-rem-<hash>`), `getRemotePaths`, `renameWithWinRetry`, `isPosixPermsEnforced`, `ensureRemoteDir`, `writeAtomicFile`/`writeJsonAtomic`, `readJsonSafe`, `withDevicesLock`, `isPidAlive`, and cross-platform `readProcessCommandLineAsync`/`Sync` into one zero-dep module shared by Gateway, Daemon Bridge, Settings RPC, and CLI.
- **Dual-Platform CI (`.github/workflows/ci.yml`)**: Added GitHub Actions workflow running `npm run build:remote && npm test` on `macos-latest` and `windows-latest` (`Node 22`, `fail-fast: false`).

### Changed
- **Windows Remote Control Parity (`remote/gateway/`, `core/daemon/remote/`, `core/daemon/remote-bridge.mjs`, `studio/remote-cli.mjs`)**: Added Named Pipe IPC skipping stale-socket `unlink`/`chmod`, gated POSIX `0o077`/`0o600` permission checks on `isPosixPermsEnforced()`, added Windows PowerShell CIM process inspection + `schtasks` hints to `studio/remote-cli.mjs`, and implemented graceful IPC `{ type: 'shutdown' }` gateway termination before `SIGTERM`/`SIGKILL`.
- **Opus Gate Hook Modularization (`studio/plugin/maga-opus-gate/hooks/lib/git-landing.mjs`, `studio/daemon/opus-gate-service.mjs`)**: Extracted Git diff inspection, landing command parser (`detectLandingAction`), and worktree attribution helpers out of `hooks/gate-check.mjs` (`1,916` -> `~1,300` lines) and synced `hooks/lib/git-landing.mjs` in `opus-gate-service.mjs`.
- **Cross-Platform AI Install Docs (`README.md`, `README.zh-CN.md`, `docs/INSTALL_AGENT.md`)**: Unified macOS + Windows 10/11 instructions, idempotent clone-or-pull prompts, PowerShell `-ExecutionPolicy Bypass` guidance, prebuilt archive fallback, and self-termination safeguards.

## [1.4.2] - 2026-11-27

Hardened end-user & AI-assisted installation, refined `doctor` first-install status reporting, added `.gitattributes` line-ending hygiene, and removed personal default domains from Android/test fixtures.

### Changed
- **Install Guard Decoupling (`studio/deploy-meta.mjs`, `studio/build.mjs`, `studio/cli.mjs`)**: Added `mode: 'install'` to `evaluateDeployGuard` and `deployStudio` so end-user `install` commands are never blocked by dirty working trees (such as npm lockfile drift) or non-`main`/tag checkouts, while preserving strict `mode: 'deploy'` checks for contributors; also added Windows-safe atomic rename retry in `writeDeployMeta`.
- **Android Default Server Parameterization (`remote/android/app/build.gradle.kts`, `remote/android/app/src/main/AndroidManifest.xml`, `test/remote-phase2.test.mjs`)**: Replaced hardcoded personal URL/host with `AGY_SERVER_URL` / `agyServerUrl` Gradle property & `manifestPlaceholders["agyServerHost"]` (defaulting to `https://example.invalid`) and neutralized personal domain strings in test fixtures.
- **Idempotent Installer & Agent Docs (`install.sh`, `docs/INSTALL_AGENT.md`, `README.md`, `README.zh-CN.md`, `.gitattributes`)**: Switched `install.sh` to `git pull --ff-only --autostash` and `npm ci` (when `package-lock.json` is present), added `.gitattributes`, updated AI install prompts to handle existing clones cleanly, and forbade quitting/relaunching Antigravity from inside an active Antigravity session.

### Fixed
- **First-Install `doctor` Exit Status (`studio/cli.mjs`)**: Accepted `partial` status from `install.mjs doctor` without failing `studio/cli.mjs doctor`, and reported `cdpStatus: 'ready' | 'pending_restart'` with `restartRequired` + `restartHint` when `DevToolsActivePort` is not yet active.

## [1.4.1] - 2026-11-27

Cross-device state synchronization fixes, Android bridge origin isolation, and OTA updater reliability hardening (following a full Claude Opus 5.5 read-only audit).

### Fixed
- **Opus Gate Proposal Cross-Device Sync (`studio/plugin/maga-opus-gate/hooks/gate-check.mjs`, `remote/pwa/src/app.mjs`)**: Automatically mark consumed `hook` proposals (`plan`, `risk`/`stop`, `debug`) as `dismissed: true` when `PreToolUse` allows the paused action, `PostToolUse` succeeds, or a subsequent `Stop` turn completes cleanly; hide mobile `opusBanner` and `resumeBanner` while streaming (`isStreaming === true`) and force a fresh `studio.overview` pull on stream completion (`isFinished`).
- **PWA State Sync & Concurrency (`remote/pwa/src/`, `remote/gateway/ws-server.mjs`)**:
  - Clear both `state.resumeState` and cached `snapshot.resumeState` upon successful Resume/send, and avoid leaving stale `snap.resumeState` active on snapshot replacement.
  - Push `{ type: 'role_changed', role }` from Gateway to live WebSocket clients on role promotion without dropping the connection, and immediately refresh PWA composer controls on both `role_changed` and `welcome` role changes.
  - Trigger `refreshAllData()` via `onEpochReset` when daemon/gateway restarts with a new `epoch`, clear stale `state.streams` in `onWelcome`, key `approvingByCid` locks per conversation so approvals in one chat never block another, preserve newly typed in-flight drafts after `sendMessage`, and expose `window.__agyNativeKeepAliveChanged` so native keep-alive stops/timeouts sync immediately back into the PWA menu and status cache.
- **Android Bridge Isolation & OTA Updater Hardening (`remote/android/app/src/main/java/com/agystudio/remote/{MainActivity,AppUpdater}.kt`)**:
  - Replaced wildcard root-domain matching with exact `serverHost` verification (`isServerHost` / `isTrustedServerOrigin`) plus explicit IdP allowlisting during `cloudflareaccess.com` auth redirects, gating every `NativeBridge` method and `ACTION_VIEW` intent to trusted server origins.
  - Added Activity lifecycle cleanup (`WeakReference`, `onActivityDestroyed`), user-cancelable OTA downloads, and automatic SHA-256 re-verified APK install resume (`resumePendingInstall` in `onResume`) after granting unknown-sources permission.

## [1.4.0] - 2026-11-27

Introduced **AGY Studio Remote Control** and the companion **Native Android App (`com.agystudio.remote`)** for encrypted mobile & multi-pane remote supervision, alongside selectable cross-model review reviewers, PWA modularization, and cleaner release packaging.

### Added
- **AGY Studio Remote Control (`remote/gateway/`, `remote/pwa/`, `core/daemon/remote/`, `user/src/modules/remote-tap.mjs`, `studio/remote-cli.mjs`)**:
  - **Zero-Dep Loopback Gateway & Edge Security (`remote/gateway/`)**: Standalone 7-file Node gateway binding strictly to `127.0.0.1` (`18791`) with single-use pairing codes, ECDSA P-256 device handshake, device revocation (`4001`) and live role demotion (`4003`), strict CSP, and fail-closed `cloudflare-access` (JWKS RS256) / `tailscale-serve` / `loopback` transports.
  - **Controlled Write Loop & Dual-UI Console (`core/daemon/remote/`, `user/src/modules/remote-tap.mjs`, `remote/pwa/`)**: Remote permission approval (`convo.approve` with `PermissionScope.ONCE` and `waitingStepHash` CAS), interactive `askQuestion` single/multi-select cards, message sending (`convo.send`), new chat modal, cancellation (`convo.cancel`), `/compact` execution (`convo.compact`), interrupted-task `Resume`, per-cascade single-writer lock (`cascade-lock.mjs`), model/effort capsule + image paste/camera upload, per-conversation draft persistence, inline `/` slash command bar, live RTT & connection recovery notice bar, and sanitized Studio overview (`studio.overview`).
  - **Desktop Settings & Zero-Dep QR Pairing (`studio/modules/settings/{remote-view,remote-events,qr-svg}.mjs`, `core/daemon/remote/settings-rpc.mjs`)**: Added the `Remote Control` category inside AGY Studio Settings with instant gateway enable/disable, Cloudflare Access / Loopback / Tailscale configuration, local ISO 18004 SVG QR code pairing, device role/revocation controls, and CLI/packaging integration (`studio/cli.mjs remote`, `studio/pack-release.mjs`, `studio/build.mjs`).
- **Companion Native Android App & Self-Hosted OTA (`remote/android/`, `scripts/build-android-apk.mjs`, `remote/gateway/server.mjs`)**:
  - Added lightweight Kotlin edge-to-edge WebView client (`com.agystudio.remote`) featuring native notifications & haptics, Android share-sheet image upload, in-app OAuth, network-change (`NetworkCallback`) / foreground resume / `onRenderProcessGone` crash recovery, `FileProvider` camera capture, and `onWebReady` startup handshake.
  - Added optional foreground `KeepAliveService` (`dataSync`) and Cloudflare-Access-protected in-app OTA updater (`GET /api/android/latest`, `GET|HEAD /api/android/apk`, `npm run build:android`) with SHA-256 verification and atomic release staging.
- **Cross-Model Review Gate Enhancements (`studio/modules/opus-gate-pill.mjs`, `studio/plugin/maga-opus-gate/`, `remote/pwa/src/studio-panel.mjs`)**: Added selectable `claude-opus` / `gemini-4-carbon-high` reviewer paths, pre-landing `PreToolUse` checkpoint pause, and mobile Opus Gate live refresh + trigger parity.

### Changed
- **Remote PWA Modularization (`remote/pwa/src/{workspace-shell,convo-actions}.mjs`)**: Extracted the Pure-DOM workspace shell builder (`createWorkspaceShellDom`, `renderSidebarProjectsBar`) and conversation action handlers (`createConvoActionHandlers`) out of `remote/pwa/src/app.mjs` (`1,995` -> `1,326` lines) and enforced the `< 2,000`-line invariant across all `remote/pwa/src/*.mjs` files.
- **Release Packager Hygiene (`studio/pack-release.mjs`)**: Excluded `.gradle`, `local.properties`, `remote/android/**/build`, APK/JKS/keystore artifacts, and local Android update manifests from emitted macOS release tarballs.

### Fixed
- **Mobile WebView, Service Worker & Control Flow**: Fixed standalone PWA viewport height docking, Android back-gesture History API navigation, model popover outside-click handling, draft-safe service worker `controllerchange` reloads, shared media `previewUrl`/`dataBase64` mapping, keep-alive status cache deduplication while disabled, and mobile Opus Gate `sendMessage` argument ordering + overview refresh throttling.

## [1.3.0] - 2026-11-26

Consolidated parallel feature development into a unified, hardened release: added Cache-Aware Auto-Compact and Global Tiered Git Workflow guardrails, centralized plugin syncing and preferences schemas, hardened Resume detection and footer capsule coexistence, and aligned UI/plugin branding to **AGY Studio**.

### Added
- **Cache-Aware Auto-Compact (`studio/plugin/maga-auto-compact/`, `studio/daemon/auto-compact-service.mjs`, `studio/modules/auto-compact.mjs`, `user/src/modules/compact-controller.mjs`)**: Detects long scheduled waits (`schedule` step decoder) and context usage thresholds, coordinating automatic `/compact` via 30s `O_EXCL`-locked CAS leases or `#agy-auto-compact-pill` while protecting live composer drafts and prompt cache warmth.
- **Global Tiered Git Workflow Guardrails & Policy UI (`studio/plugin/maga-git-workflow/`, `studio/daemon/git-workflow-service.mjs`, `studio/plugin/maga-git-workflow/bin/wt.mjs`, `studio/modules/settings/views.mjs`)**: Enforces centralized per-repo policies (`observe` / `protect-main` / `worktree-only`) with shared worktree core (`lib/worktree-core.mjs`), universal `wt.mjs`, per-conversation worktree attribution, and deny telemetry without polluting repositories.

### Changed
- **Unified Plugin Sync & Shared Preferences Schema (`studio/daemon/plugin-sync.mjs`, `studio/shared/prefs-schema.mjs`)**: Consolidated Node-executable pinning, `chmod 0755`, stale-file pruning, and runtime verification across all three managed plugins (`maga-opus-gate`, `maga-auto-compact`, `maga-git-workflow`), and extracted a single canonical preferences schema shared by `studio/build.mjs`, `core/daemon/prefs-bundle.mjs`, and `studio/modules/studio-prefs.mjs`.
- **Shell Parser Split & Repo-Wide `< 2,000`-Line Invariant (`studio/plugin/maga-git-workflow/lib/shell-parser.mjs`, `test/studio.test.mjs`)**: Extracted shell segmentation, tokenization, and redirect parsing from `hooks/git-guard.mjs` (`2,017` -> `1,352` lines) and extended the `< 2,000`-line syntax check across `studio/` and `core/`.
- **Unified `AGY Studio` UI & Plugin Branding**: Aligned user-facing Settings labels, plugin `displayName` fields, CLI hints, and Git workflow notices to `AGY Studio` while preserving internal compatibility identifiers (`com.antigravity.anti-claude.daemon`, `maga-*` plugin slugs, `MAGA_ALLOW_*`).

### Fixed
- **Footer Capsule Coexistence & Live Speed Pill Stability (`studio/core/dom.mjs`, `studio/modules/subagent-footer.mjs`, `studio/modules/footer-unified.mjs`)**: Exported shared `OWN_FOOTER_PILL_IDS` and `OWN_ROW1_PILL_IDS` so `#agy-auto-compact-pill` coexists cleanly with `#agy-main-subagent-pill`, and prevented `#ag-live-metrics-pill` detachment or duplicate `tok/s` displays.
- **Preserve User `cjkFontScale` on Deploy (`studio/build.mjs`)**: Fixed `syncLiveConfigForStudio` overwriting user-selected `'94.5'` / `'100'` optical scales; now initializes `'95'` only when missing or invalid.
- **Interrupted-Task Resume Detection Hardening (`studio/daemon/resume-detector.mjs`, `studio/modules/resume-banner.mjs`)**: Eliminated waiting/background false positives, added `-wal`/`-shm` concurrency retries and malformed protobuf safety, expanded tail meta-step scanning (`LIMIT 24`), and added `reqGen` stale-response cancellation.
- **Complete `rollback` Cleanup & `deploy` / `doctor` Parity (`studio/cli.mjs`)**: `rollback` now strips `<!-- BEGIN agy-fast-io-pruned -->` rules from `~/.gemini/AGENTS.md` without disturbing surrounding user rules; `deploy` now syncs `maga-opus-gate`, and `doctor` checks `opusGateHookNode`.

## [1.2.0] - 2026-11-26

Rebranded from **MAGA** to **AGY Studio (`agy-studio`)**, added Git Worktree workspace management, quota-guarded Claude Opus Gate, Git-history-grounded AI chat suggestions, and zero-`npm-install` macOS Release packaging.

### Added
- **Rebrand to AGY Studio (`agy-studio`)**: Renamed the public project, Release tarball prefix (`agy-studio-v*-macos.tar.gz`), installer defaults (`~/.local/share/agy-studio`), and documentation while preserving internal compatibility identifiers (`com.antigravity.anti-claude.daemon`, `studio-prefs.json`).
- **Git Worktree UI, Per-Conversation Tracking & `wt` CLI (`user/src/modules/projects/worktree-ui.mjs`, `user/src/modules/projects/conv-topbar.mjs`, `studio/wt-cli.mjs`, `studio/deploy-meta.mjs`, `core/daemon/git-exec.mjs`)**: Manage sibling worktrees from the Projects workspace strip, track per-conversation worktrees with live branch/dirty pills, create/clean worktrees via `npm run wt:new` / `wt:clean`, and enforce single-desktop deploy provenance.
- **Quota-Guarded Claude Opus Gate (`studio/daemon/opus-gate-service.mjs`, `studio/modules/opus-gate-pill.mjs`, `studio/plugin/maga-opus-gate/`)**: Added semi-auto (`✦ 请 Opus 把关` dock pill) and quota-guarded auto Claude Opus checkpoints (`plan` / `risk` / `debug` / `stop`), plus Claude/GPT dual-pool quota tracking across Overview and project usage cards.
- **History-Aware Project AI Chat Suggestions & Redesigned Repo Header (`studio/daemon/project-suggestions.mjs`, `user/src/modules/projects/suggestions-ui.mjs`, `user/src/modules/projects/workspace-ui.mjs`)**: Added optional Gemini 3.8 Flash follow-up prompt pills grounded in recent git history and refined 3-column strip layout, plus redesigned single-line repository status pills.
- **Zero-Dependency Release Packager & One-Line Installer (`install.sh`, `uninstall.sh`, `studio/pack-release.mjs`, `docs/INSTALL_AGENT.md`)**: Added prebuilt browser bundle support (`studio/prebuilt/studio-entry.js` + `user/custom.js`), `npm run release:pack` tarball + SHA-256 emitter, `--dry-run` safe `install.sh` / `uninstall.sh` with automatic `npm install` fallback for fresh clones, and an Ask-Agent installation guide.
- **Proxy Diagnostics in `npm run doctor` (`studio/cli.mjs`)**: Added non-blocking `proxyDiagnostics` reporting (active proxy env key names without exposing values, plus macOS `scutil --proxy` status and troubleshooting hint when shell proxy vars are set without System Proxy).

### Fixed
- **macOS CDP Auto-Relaunch Proxy & TLS Compatibility (`core/daemon/cdp-bootstrap.mjs`)**: Preserve allowlisted proxy/TLS environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `GRPC_PROXY_EXP`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, and lowercase variants) via `/usr/bin/open --env` and space-separated `--proxy-*` CLI flags across macOS cold-boot CDP relaunches without logging secrets or persisting credential-bearing URLs to `relaunch-intent.json`.
- **Fresh-Clone Installer Dependency Gap**: Fixed fresh-clone installs failing with `ERR_MODULE_NOT_FOUND: esbuild` when `node_modules` had not yet been installed.

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
