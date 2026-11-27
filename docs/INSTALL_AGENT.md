# Agent Installation Guide (`INSTALL_AGENT.md`)

Use this guide when a user asks Antigravity or Claude Code to install **AGY Studio (`agy-studio`, formerly MAGA)** on **macOS**.

## Safety & Prerequisites

1. **Check OS**: Must be **macOS** (`uname -s` == `Darwin`). Do **not** run `bash ./install.sh` on Windows or Linux; native Windows 10/11 support is actively landing in `v1.5.0` (tracked on GitHub).
2. **Check Node.js**: Requires Node.js `>= 22` (`node -v`). If missing or `< 22`, stop and ask the user to install via `brew install node` (or switch via `nvm` / `fnm`).
3. **CRITICAL — Never Self-Terminate Antigravity**:
   - If you are executing inside **Antigravity Desktop**, **NEVER** quit, `kill`, `pkill`, or relaunch `Antigravity` yourself — doing so terminates your own active session mid-flight.
   - Finish installation, run `node studio/cli.mjs doctor`, and if `cdpStatus` is `"pending_restart"`, ask the user to manually quit and reopen Antigravity once.
4. **Preserve User State**:
   - Do **not** touch `/Applications/Antigravity.app` (AGY Studio never modifies the `.app` binary or signature).
   - Do **not** delete existing Antigravity chats, plugins, or `~/.gemini/antigravity/anti-claude/studio-prefs.json`.

## Preferred Install Flow (Idempotent)

1. Choose an install folder (for example `~/Developer/agy-studio` or `~/.local/share/agy-studio`). If `.git` already exists there, update it safely instead of failing on `git clone`:
   ```bash
   if [ -d ~/Developer/agy-studio/.git ]; then
     git -C ~/Developer/agy-studio pull --ff-only --autostash
   else
     git clone https://github.com/LiWithDream/agy-studio.git ~/Developer/agy-studio
   fi
   ```
   *(Prebuilt Release tarball fallback: if `npm ci` / `npm install` fails due to proxy or firewall restrictions downloading `esbuild`, download `agy-studio-v*-macos.tar.gz` from GitHub Releases and extract it — `install.sh` detects `user/custom.js` + `studio/prebuilt/studio-entry.js` and skips `npm` automatically.)*
2. Run the unified installer script from the directory:
   ```bash
   cd ~/Developer/agy-studio
   bash ./install.sh
   ```
   This installs dependencies cleanly (`npm ci` when `package-lock.json` is present, or skips `npm` in prebuilt tarballs), registers the local LaunchAgent daemon (`com.antigravity.anti-claude.daemon`), deploys the UI runtime into `~/.gemini/antigravity/anti-claude/user/`, and syncs the 7-line `fast-io` rules into `~/.gemini/AGENTS.md`.
3. Verify health before reporting back:
   ```bash
   node studio/cli.mjs doctor
   ```
   Confirm `ok: true`, `daemonPointsToStudio: true`, and `studioBundle.jsInjected: true`.

## Reporting to the User

Summarize:
- Installed directory path and Node version used.
- `doctor` output (`ok`, `cdpStatus`, `usageSummary.daysCount`, any `proxyDiagnostics.hint`).
- If `cdpStatus` is `"pending_restart"` (or `restartRequired: true`), tell the user clearly to manually quit and reopen Antigravity once so the background daemon can attach via CDP; otherwise note that UI changes hot-reload automatically.
