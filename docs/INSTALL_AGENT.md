# Agent Installation Guide (`INSTALL_AGENT.md`)

Use this guide when a user asks Antigravity or Claude Code to install **AGY Studio (`agy-studio`, formerly MAGA)** on **macOS** or **Windows 10/11**.

## Safety & Prerequisites

1. **Check OS**: Supports **macOS** (`uname -s == Darwin`) and **Windows 10/11** (`$env:OS == Windows_NT`). Do not attempt on Linux; inform the user that Linux support is tracked on GitHub Issues.
2. **Check Node.js**: Requires Node.js `>= 22` (`node -v`).
   - macOS: if missing, ask the user to install via `brew install node`.
   - Windows: if missing, ask the user to install via `winget install OpenJS.NodeJS.LTS`.
3. **Preserve User State**:
   - Do **not** touch `/Applications/Antigravity.app` (macOS) or `Antigravity.exe` / `app.asar` (Windows) — AGY Studio never patches client binaries or signatures.
   - Do **not** delete existing Antigravity chats, plugins, or `~/.gemini/antigravity/anti-claude/studio-prefs.json`.
   - Do **not** force-kill (`kill -9` / `taskkill /F`) running Antigravity windows unless the user explicitly asks.

## Preferred Install Flow (macOS)

1. Choose an install folder (for example `~/Developer/agy-studio` or `~/.local/share/agy-studio`), clone the repo if not already present:
   ```bash
   git clone https://github.com/LiWithDream/agy-studio.git ~/Developer/agy-studio
   ```
   *(If upgrading an existing prebuilt Release folder, extract the tarball instead — `install.sh` skips `npm install` automatically when `user/custom.js` and `studio/prebuilt/studio-entry.js` are present.)*
2. Run the unified installer script from the directory:
   ```bash
   cd ~/Developer/agy-studio
   bash ./install.sh
   ```
   This registers the local LaunchAgent daemon (`com.antigravity.anti-claude.daemon`), deploys the UI runtime into `~/.gemini/antigravity/anti-claude/user/`, and syncs the 7-line `fast-io` rules into `~/.gemini/AGENTS.md`.
3. Verify health before reporting back:
   ```bash
   node studio/cli.mjs doctor
   ```

## Preferred Install Flow (Windows PowerShell)

1. Clone into a permanent folder (for example `%LOCALAPPDATA%\agy-studio` or `C:\Users\<you>\Developer\agy-studio`), or extract the `agy-studio-v*-windows.zip` Release bundle:
   ```powershell
   git clone https://github.com/LiWithDream/agy-studio.git "$env:LOCALAPPDATA\agy-studio"
   ```
2. Run the unified PowerShell installer from the directory:
   ```powershell
   cd "$env:LOCALAPPDATA\agy-studio"
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
   This registers the user-level Scheduled Task `AGYStudioDaemon` (running headlessly via `conhost.exe --headless`, with automatic Startup `.vbs` fallback on restricted GPOs), creates the optional Start Menu launcher `Antigravity (AGY Studio)` (`--remote-debugging-port=0`), deploys the UI runtime into `%USERPROFILE%\.gemini\antigravity\anti-claude\user\`, and syncs the `fast-io` rules into `%USERPROFILE%\.gemini\AGENTS.md`.
3. Verify health before reporting back:
   ```powershell
   node studio/cli.mjs doctor
   ```

## Reporting to the User

Confirm `ok: true`, `daemonPointsToStudio: true`, and `studioBundle.jsInjected: true`, and summarize:
- Installed directory path and Node version used.
- `doctor` output (`ok`, `usageSummary.daysCount`, `antigravityAppExe` on Windows, any `proxyDiagnostics.hint`).
- Note that changes hot-reload into Antigravity automatically; on Windows, you can also launch Antigravity from the **Antigravity (AGY Studio)** Start Menu shortcut or let the background daemon attach on fresh launch.
