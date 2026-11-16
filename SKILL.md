---
name: antigravity-claude-ux
description: Deploy the 1:1 Claude Desktop (Code / Cowork) UI, typography, interleaved step stream, animated step disclosures, and in-place live TodoWrite checklist card onto Google Antigravity Desktop 2.0 via non-invasive CDP runtime injection.
---

# Antigravity Claude UX — Agent Auto-Deployment Skill

When a user provides this repository URL or asks to install `antigravity-claude-ux`, execute the following non-invasive setup steps:

## Prerequisites
- Google Antigravity Desktop 2.0 (`v2.30+`, tested on `v2.32.1`) on macOS or Windows
- Node.js `>= 22`

## 1-Step Installation
1. Clone this repository to a local directory (e.g. `~/Developer/antigravity-claude-ux` or a temporary directory) and run:
   ```bash
   node install.mjs install
   node install.mjs doctor
   ```
2. What `node install.mjs install` automatically handles:
   - Installs upstream `Anarcadia/chuanban-antigravity-theme-patch` (`~/.gemini/antigravity/theme-patch`) if not yet present;
   - Automatically copies official Anthropic variable fonts from `/Applications/Claude.app/Contents/Resources/fonts` on macOS if `Claude.app` is installed locally;
   - Backs up existing `theme-patch/user/` files to `.backup-before-claude-ux/` and deploys `config.json`, `custom.css`, and `custom.js`;
   - Unlocks Antigravity's hidden Developer Step Stream (`project4kMode = 1` / `PRODUCT_SKIN_DEVELOPER` + `verboseConversationSteps = true`) via live CDP and persistent config so intermediate tool & MCP calls are never wiped;
   - Prepends an idempotent `<!-- BEGIN antigravity-claude-ux -->` rule block to `~/.gemini/AGENTS.md` enabling Claude-style mid-turn progress updates and 3-state `- [ ]` / `- [/]` / `- [x]` live checklist cards;
   - Triggers immediate hot-reload in the running Antigravity window without restarting the app.

## Clean Rollback
```bash
node install.mjs uninstall
```
Restores backed-up `theme-patch/user/` files, removes the rule block from `~/.gemini/AGENTS.md`, and hot-reloads immediately. Never touches `/Applications/Antigravity.app/Contents/Resources/app.asar`.
