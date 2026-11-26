# Agent Installation Guide (`INSTALL_AGENT.md`)

Use this guide when a user asks Antigravity or Claude Code to install **AGY Studio (`agy-studio`, formerly MAGA)** on **macOS**.

## Safety & Prerequisites

1. **Check OS**: Must be **macOS** (`uname -s` == `Darwin`). Do not attempt on Windows or Linux; inform the user that Windows support is tracked on GitHub Issues.
2. **Check Node.js**: Requires Node.js `>= 22` (`node -v`). If missing, stop and ask the user to install via `brew install node`.
3. **Preserve User State**:
   - Do **not** touch `/Applications/Antigravity.app` (AGY Studio never modifies the `.app` binary or signature).
   - Do **not** delete existing Antigravity chats, plugins, or `~/.gemini/antigravity/anti-claude/studio-prefs.json`.
   - Do **not** force-kill running Antigravity windows unless the user asks or `doctor` reports a missing CDP debug port.

## Preferred Install Flow

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
   This handles dependency bootstrap (only if prebuilt files are absent), registers the local LaunchAgent daemon (`com.antigravity.anti-claude.daemon`), deploys the UI runtime into `~/.gemini/antigravity/anti-claude/user/`, and syncs the 7-line `fast-io` rules into `~/.gemini/AGENTS.md`.
3. Verify health before reporting back:
   ```bash
   node studio/cli.mjs doctor
   ```
   Confirm `ok: true`, `daemonPointsToStudio: true`, and `studioBundle.jsInjected: true`.

## Reporting to the User

Summarize:
- Installed directory path and Node version used.
- `doctor` output (`ok`, `usageSummary.daysCount`, any `proxyDiagnostics.hint`).
- Note that changes hot-reload into Antigravity automatically; if the client was started without `--remote-debugging-port=0`, the daemon will bootstrap CDP on next launch or when Antigravity restarts.
