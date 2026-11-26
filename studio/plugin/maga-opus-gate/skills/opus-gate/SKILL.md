---
name: opus-gate
description: Quota-guarded high-tier (Gemini 4 Carbon / Claude Opus 5.5) checkpoint workflow via swarm for plan review, high-risk diffs, repeated debugging failures, and pre-completion audits.
---

# MAGA Review Gate (`opus-gate`)

Run a lean, high-signal checkpoint review inside an existing session by explicitly calling the `swarm` tool with the target high-tier reviewer (`gemini-4-carbon-high` or `claude-opus-5-5-high`; never `medium`).

## Procedure

### Fast-Path: Explicit User Request
- If the user explicitly asks for a review or checkpoint, **skip Step 0 Preflight AND skip `swarm{action: "models"}` quota threshold gating**.
- Launch `claude-opus-5-5-high` (worker `review-opus`) if the user asked for Opus, `gemini-4-carbon-high` (worker `review-carbon`) if the user asked for Carbon, or the configured `opusGateModel` from Step 2. Only fall back or notify if the runtime returns an actual quota exhaustion or model error.

0. **Step 0: Preflight Gate (Required for Model-Initiated Semantic Checkpoints)**:
   - Run this preflight check **before** calling `swarm` whenever you initiate a Review Gate via semantic self-judgment. (Skip Step 0 on explicit user requests OR `[MAGA Review Gate]` / `[MAGA Opus Gate]` `Stop` auto-continue hooks.)
   - Always pass `--model` with your active session model name/id so anti-downgrade self-skip works accurately:
     ```bash
     node ~/.gemini/config/plugins/maga-opus-gate/hooks/gate-check.mjs --preflight --kind <plan|risk|debug|stop> --model "<your current model name or id>" --reason "<concise 1-line summary>" --cid "<Conversation ID>" [--files "<comma-separated paths>"]
     ```
     (Omit `--cid` only if no conversation ID is available in your context.)
   - Branch strictly on the returned JSON `action`:
     - `"skip"` → Do **NOT** call `swarm`; proceed silently.
     - `"propose"` → Do **NOT** call `swarm`; add a concise 1-line note at the end of your reply stating that a Review Gate suggestion is queued in the MAGA bottom-bar pill (`✦ 请求审查`) for user confirmation (and mention quota/cap downgrade if `downgradedReason` is set).
     - `"run_swarm"` → Proceed to **Steps 1–4** using the returned `recommendedModelId` and `workerName`.

1. **Live Quota Check (Hook & Semantic Auto Paths Only)**:
   - On `[MAGA Review Gate]` / `[MAGA Opus Gate]` hooks or `"run_swarm"` preflight results, call `swarm` with `action: "models", all: true` to confirm live `quota_remaining` for the target model (`gemini-4-carbon-high` or `claude-opus-5-5-high`; always `High` effort).
   - If the target model's `quota_remaining` is exhausted or critically below threshold, skip spawning the reviewer, note the quota guard, and continue on your current model.

2. **Spawn or Reuse One Model-Scoped Worker (`review-carbon` or `review-opus`)**:
   - Do **NOT** add `narrator` or `monitor` workers.
   - Always scope the worker name to the selected model:
     - `gemini-4-carbon-high` → `name: "review-carbon"`
     - `claude-opus-5-5-high` → `name: "review-opus"`
   - If this conversation already has a `waiting` worker whose name matches the **target** `workerName` (`review-carbon` or `review-opus`), check via `swarm{action: "status"}` (only if a swarm is already active) and wake it incrementally with `post_message` to preserve prompt cache. **Never** reuse a `review-carbon` worker for Opus, or a `review-opus` / legacy `opus-gate` worker for Carbon!
   - Otherwise spawn one worker:
     ```
     swarm{
       action: "add",
       name: "<review-carbon | review-opus>",
       model: "<gemini-4-carbon-high | claude-opus-5-5-high>",
       brief: "..."
     }
     ```
   - **Evidence-First Brief & Exploration Budget**:
     - Omit `fork` for `plan`, `risk`, `stop`, and `review` gates; pass `fork: "coordinator"` **only** for `debug` escalation when warm multi-turn failure context is essential.
     - Include the **exact active worktree absolute path** (and base branch if diffing), what is already verified (passing tests / invariants), specific review questions, and either a compact plan summary + artifact path (`plan`) or a bounded inline `git diff -U3` (<= 250 lines) of key changed files (`risk`/`stop`).
     - Require the worker to batch parallel `read_file` / combined read-only shell checks within a **<= 3 tool-call turn budget** and keep its output under **500 words**.

3. **Mandatory Read-Only + `post_message` Brief Contract**:
   - Forbid file edits, writes, and destructive shell commands.
   - Require the worker to call `post_message` starting with `@coordinator [done]` — **never** write *"Do NOT call any tools"*, because `post_message` is a tool!
   - Required worker output template:
     - **Verdict**: `APPROVE` | `REVISE` | `HOLD`
     - **P0 / P1 / P2**: concise `file:line`, failure scenario, minimal fix sketch.

4. **Warm Reuse, Summary, Retire & Clear**:
   - Remember board tools (`post_message`, `read_board`, `swarm_wait`) arrive one turn *after* the first `swarm add` — end your turn with the exact `open_board` line returned by `swarm add` so its `@coordinator` post wakes you.
   - When `@coordinator [done]` arrives, present a concise summary of the reviewer's Verdict and which P0/P1 findings are adopted or deferred.
   - **Warm reuse**: If P0/P1 fix-ups require re-verification with the same model, keep that `waiting` worker alive and send only the fix diff delta via `post_message` instead of spawning a new worker.
   - When the checkpoint series is finished: call `swarm{action: "kill", name: "<review-carbon | review-opus>"}` AND run:
     ```bash
     node ~/.gemini/config/plugins/maga-opus-gate/hooks/gate-check.mjs --clear --cid "<Conversation ID>" --dir "<active worktree path>"
     ```
