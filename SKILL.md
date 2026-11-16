---
name: antigravity-claude-ux
description: Deploy the 1:1 Claude Desktop (Code / Cowork) UI, typography, stratified model selector, live context & plan quota popover, interleaved step stream, and cross-turn auto-docking TodoWrite checklist card onto Google Antigravity Desktop 2.0 via non-invasive CDP runtime injection.
---

# Antigravity Claude UX — Agent Auto-Deployment Skill

When a user provides this repository URL or asks to install or update `antigravity-claude-ux`, execute the following non-invasive setup steps:

## Prerequisites
- Google Antigravity Desktop 2.0 (`v2.30+`, tested on `v2.32.1`) on macOS or Windows
- Node.js `>= 22`

## 1-Step Installation (Fresh Install or Update to Latest)
1. Clone this repository (or pull the latest `main` if already cloned) and run the installer:
   ```bash
   if [ -d "$HOME/Developer/antigravity-claude-ux/.git" ]; then
     git -C "$HOME/Developer/antigravity-claude-ux" pull --ff-only
   else
     git clone https://github.com/hongqi7/antigravity-claude-ux.git "$HOME/Developer/antigravity-claude-ux"
   fi
   node "$HOME/Developer/antigravity-claude-ux/install.mjs" install
   node "$HOME/Developer/antigravity-claude-ux/install.mjs" doctor
   ```
2. What `node install.mjs install` automatically handles:
   - Installs upstream `Anarcadia/chuanban-antigravity-theme-patch` (`~/.gemini/antigravity/theme-patch`) if not yet present;
   - Automatically copies official Anthropic variable fonts from `/Applications/Claude.app/Contents/Resources/fonts` on macOS if `Claude.app` is installed locally;
   - Backs up existing `theme-patch/user/` files to `.backup-before-claude-ux/` and deploys all 4 user-layer files (`config.json`, `custom.css`, `custom.js`, `i18n.override.json`);
   - Enables the 1:1 Claude stratified Model Selector (`模型 · 本次会话`, `1–4` quick keys, separate `思考强度 >` & `更多模型 >` flyouts), radial Context Progress Ring + live 5h/weekly Quota Popover, clean `tok/s · TTFT` pill (stripping `+sub` clutter), and Claude-matched Settings sidebar;
   - Unlocks Antigravity's hidden Developer Step Stream (`project4kMode = 1` / `PRODUCT_SKIN_DEVELOPER` + `verboseConversationSteps = true`) via live CDP and persistent config so intermediate tool & MCP calls are never wiped;
   - Prepends an idempotent `<!-- BEGIN antigravity-claude-ux -->` rule block to `~/.gemini/AGENTS.md` enabling Claude-style mid-turn progress updates and cross-turn auto-docking 3-state `- [ ]` / `- [/]` / `- [x]` live checklist cards;
   - Registers the `0-token` macOS `launchd` auto-sync watcher (`com.antigravity.claude-ux.autosync`) and triggers immediate hot-reload in the running Antigravity window without restarting the app.

## Clean Rollback
```bash
node "$HOME/Developer/antigravity-claude-ux/install.mjs" uninstall
```
Removes the auto-update watcher, restores backed-up `theme-patch/user/` files, removes the rule block from `~/.gemini/AGENTS.md`, and hot-reloads immediately. Never touches `/Applications/Antigravity.app/Contents/Resources/app.asar`.
