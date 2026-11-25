---
name: opus-gate
description: Quota-guarded cross-model Claude Opus checkpoint workflow via swarm for plan review, high-risk diffs, repeated debugging failures, and pre-completion audits.
---

# MAGA Opus Gate (`opus-gate`)

Run a lean, high-signal Claude Opus checkpoint inside an existing Gemini session by explicitly calling the `swarm` tool.

## Procedure

### Fast-Path: Explicit User Request
- If the user explicitly asks for an Opus review or checkpoint, **skip Step 0 Preflight AND skip `swarm{action: "models"}` quota threshold gating**.
- Launch `claude-opus-5-5-high` directly (unless the user named another Opus tier) via Step 2. Only fall back or notify if the runtime returns an actual quota exhaustion or model error.

0. **Step 0: Preflight Gate (Required for Model-Initiated Semantic Checkpoints)**:
   - Run this preflight check **before** calling `swarm` whenever you initiate an Opus Gate via semantic self-judgment. (Skip Step 0 on explicit user requests OR `[MAGA Opus Gate]` `Stop` auto-continue hooks.)
   - Execute:
     ```bash
     node ~/.gemini/config/plugins/maga-opus-gate/hooks/gate-check.mjs --preflight --kind <plan|risk|debug|stop> --reason "<concise 1-line summary>" --cid "<Conversation ID>" [--files "<comma-separated paths>"]
     ```
     (Omit `--cid` only if no conversation ID is available in your context.)
   - Branch strictly on the returned JSON `action`:
     - `"skip"` → Do **NOT** call `swarm`; proceed silently.
     - `"propose"` → Do **NOT** call `swarm`; add a concise 1-line note at the end of your reply stating that an Opus Gate suggestion is queued in the MAGA bottom-bar pill (`✦ 请 Opus 把关`) for user confirmation (and mention quota/cap downgrade if `downgradedReason` is set).
     - `"run_swarm"` → Proceed to **Steps 1–4** using the returned `recommendedModelId` / `recommendedTier`.

1. **Live Quota Check (Hook & Semantic Auto Paths Only)**:
   - On `[MAGA Opus Gate]` hooks or `"run_swarm"` preflight results, call `swarm` with `action: "models", all: true` to confirm live `quota_remaining` for `claude-opus-5-5-high` / `claude-opus-5-5-medium`.
   - Follow the Gate's target tier (`high` or `medium`). If Claude `quota_remaining` is exhausted or critically below threshold, skip spawning Opus, note the quota guard, and continue on your current model.

2. **Spawn or Reuse One Lean Worker (`opus-gate`)**:
   - Do **NOT** add `narrator` or `monitor` workers.
   - If this conversation already has a `waiting` `opus-gate` worker (`swarm{action: "status"}` only if a swarm is already active), wake it incrementally with `post_message` (`@opus-gate ...`) to preserve prompt cache.
   - Otherwise spawn one worker:
     ```
     swarm{
       action: "add",
       name: "opus-gate",
       model: "<selected-opus-model>",
       brief: "..."
     }
     ```
   - **Evidence-First Brief & Exploration Budget**:
     - Omit `fork` for `plan`, `risk`, `stop`, and `review` gates; pass `fork: "coordinator"` **only** for `debug` escalation when warm multi-turn failure context is essential.
     - Include the **exact active worktree absolute path** (and base branch if diffing), what is already verified (passing tests / invariants), specific review questions, and either a compact plan summary + artifact path (`plan`) or a bounded inline `git diff -U3` (<= 250 lines) of key changed files (`risk`/`stop`).
     - Require `opus-gate` to batch parallel `read_file` / combined read-only shell checks within a **<= 3 tool-call turn budget** and keep its output under **500 words**.

3. **Mandatory Read-Only + `post_message` Brief Contract**:
   - Forbid file edits, writes, and destructive shell commands.
   - Require the worker to call `post_message` starting with `@coordinator [done]` — **never** write *"Do NOT call any tools"*, because `post_message` is a tool!
   - Required worker output template:
     - **Verdict**: `APPROVE` | `REVISE` | `HOLD`
     - **P0 / P1 / P2**: concise `file:line`, failure scenario, minimal fix sketch.

4. **Warm Reuse, Summary, Retire & Clear**:
   - Remember board tools (`post_message`, `read_board`, `swarm_wait`) arrive one turn *after* the first `swarm add` — end your turn with the exact `open_board` line returned by `swarm add` so its `@coordinator` post wakes you.
   - When `@coordinator [done]` arrives, present a concise summary of Opus's Verdict and which P0/P1 findings are adopted or deferred.
   - **Warm reuse**: If P0/P1 fix-ups require re-verification, keep the `waiting` `opus-gate` worker alive and send only the fix diff delta via `post_message` instead of spawning a new worker.
   - When the checkpoint series is finished: call `swarm{action: "kill", name: "opus-gate"}` AND run:
     ```bash
     node ~/.gemini/config/plugins/maga-opus-gate/hooks/gate-check.mjs --clear --cid "<Conversation ID>" --dir "<active worktree path>"
     ```
