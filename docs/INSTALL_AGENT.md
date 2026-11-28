# Agent Installation Guide (`INSTALL_AGENT.md`)

Use this guide when a user asks Antigravity or Claude Code to install **AGY Studio (`agy-studio`, formerly MAGA)** on **macOS** or **Windows 10/11**.

## Safety & Prerequisites

1. **Check OS**: Supports **macOS** (`uname -s == Darwin`) and **Windows 10/11** (`$env:OS == Windows_NT`). Do **not** run `bash ./install.sh` on Windows, and do not attempt on Linux (tracked on GitHub Issues).
2. **Check Node.js**: Requires Node.js `>= 22` (`node -v`).
   - macOS: if missing or `< 22`, ask the user to install via `brew install node` (or switch via `nvm` / `fnm`).
   - Windows: if missing or `< 22`, ask the user to install via `winget install OpenJS.NodeJS.LTS`.
3. **CRITICAL — Never Self-Terminate Antigravity**:
   - If you are executing inside **Antigravity Desktop**, **NEVER** quit, `kill`, `pkill`, `taskkill`, or relaunch `Antigravity` yourself — doing so terminates your own active session mid-flight.
   - Finish installation, run `node studio/cli.mjs doctor`, and if `cdpStatus` is `"pending_restart"`, ask the user to manually quit and reopen Antigravity once.
4. **Preserve User State**:
   - Do **not** touch `/Applications/Antigravity.app` (macOS) or `Antigravity.exe` / `app.asar` (Windows) — AGY Studio never patches client binaries or signatures.
   - Do **not** delete existing Antigravity chats, plugins, or `~/.gemini/antigravity/anti-claude/studio-prefs.json`.

## Preferred Install Flow (macOS — Idempotent & Channel-Safe)

1. Choose an install folder (for example `~/.local/share/agy-studio` or `~/Developer/agy-studio`). **Do not run `git pull --ff-only` directly** — stable installs check out detached Release tags (`vX.Y.Z`). Delegate channel sync to `install.sh` (`--channel stable` is the default; pass `--channel edge` only if the user explicitly asks for `main`):
   ```bash
   if [ -d ~/Developer/agy-studio/.git ]; then
     cd ~/Developer/agy-studio && bash ./install.sh --channel stable
   elif [ -d ~/.local/share/agy-studio/.git ]; then
     cd ~/.local/share/agy-studio && bash ./install.sh --channel stable
   else
     curl -fsSL https://raw.githubusercontent.com/LiWithDream/agy-studio/main/install.sh | bash
   fi
   ```
   *(Prebuilt Release tarball fallback: if `npm ci` / `npm install` fails due to proxy or firewall restrictions downloading `esbuild`, download `agy-studio-v*-macos.tar.gz` from GitHub Releases and extract it — `install.sh` detects `user/custom.js` + `studio/prebuilt/studio-entry.js` and skips `npm` automatically.)*
2. What `install.sh` performs automatically: resolves the latest GitHub Release tag (on `stable`), installs dependencies cleanly (`npm ci` when `package-lock.json` is present, or skips `npm` in prebuilt tarballs), registers the local LaunchAgent daemon (`com.antigravity.anti-claude.daemon`), deploys the UI runtime into `~/.gemini/antigravity/anti-claude/user/`, and syncs the 7-line `fast-io` rules into `~/.gemini/AGENTS.md`.
3. Verify health from the installed directory before reporting back:
   ```bash
   node studio/cli.mjs doctor
   ```

## Preferred Install Flow (Windows PowerShell — Idempotent & Channel-Safe)

1. Choose a permanent folder (for example `%LOCALAPPDATA%\agy-studio`). **Do not run `git pull --ff-only` directly** — stable installs check out detached Release tags (`vX.Y.Z`). Delegate channel sync to `install.ps1` (`-Channel stable` is the default; pass `-Channel edge` only if the user explicitly asks for `main`):
   ```powershell
   $dest = "$env:LOCALAPPDATA\agy-studio"
   if (Test-Path (Join-Path $dest '.git')) {
     Set-Location $dest
     powershell -ExecutionPolicy Bypass -File .\install.ps1 -Channel stable
   } else {
     irm https://raw.githubusercontent.com/LiWithDream/agy-studio/main/install.ps1 | iex
   }
   ```
   *(Prebuilt Release zip fallback: if `npm ci` / `npm install` fails due to proxy or firewall restrictions downloading `esbuild`, download `agy-studio-v*-windows.zip` from GitHub Releases and extract it — `install.ps1` detects `user\custom.js` + `studio\prebuilt\studio-entry.js` and skips `npm` automatically.)*
2. What `install.ps1` performs automatically (using `-ExecutionPolicy Bypass` on PowerShell 5.1): resolves the latest GitHub Release tag (on `stable`), installs dependencies cleanly (`npm ci` when `package-lock.json` is present, or skips `npm` in prebuilt zips), registers the user-level Scheduled Task `AGYStudioDaemon` (running headlessly via `conhost.exe --headless`, with automatic Startup `.vbs` fallback on restricted GPOs), creates the optional Start Menu launcher `Antigravity (AGY Studio)` (`--remote-debugging-port=0`), deploys the UI runtime into `%USERPROFILE%\.gemini\antigravity\anti-claude\user\`, and syncs the `fast-io` rules into `%USERPROFILE%\.gemini\AGENTS.md`.
3. Verify health from the installed directory before reporting back:
   ```powershell
   node studio/cli.mjs doctor
   ```

## Reporting to the User

Confirm `ok: true`, `daemonPointsToStudio: true`, and `studioBundle.jsInjected: true`, and summarize:
- Installed directory path and Node version used.
- `doctor` output (`ok`, `cdpStatus`, `usageSummary.daysCount`, `antigravityAppExe` on Windows, any `proxyDiagnostics.hint`).
- If `cdpStatus` is `"pending_restart"` (or `restartRequired: true`), tell the user clearly to manually quit and reopen Antigravity once (on Windows, they can also launch from the **Antigravity (AGY Studio)** Start Menu shortcut) so the background daemon can attach via CDP; otherwise note that UI changes hot-reload automatically.
