---
name: opus-gate
description: Quota-guarded cross-model Claude Opus checkpoint workflow via swarm for plan review, high-risk diffs, repeated debugging failures, and pre-completion audits.
---

# MAGA Opus Gate (`opus-gate`)

Run a lean, quota-aware Claude Opus checkpoint inside an existing Gemini session by explicitly calling the `swarm` tool.

## Procedure

1. **Check Live Opus Quotas**:
   - Call `swarm` with `action: "models", all: true`.
   - Locate the latest Claude Opus High model (e.g. `claude-opus-5-5-high`) and Medium fallback (`claude-opus-5-5-medium`), and inspect `quota_remaining`.
   - Follow the Gate's target tier (`high` or `medium`). If Claude `quota_remaining` is critically low (below threshold or exhausted), skip spawning Opus, note the quota guard in your reply, and continue cleanly on your current model.

2. **Spawn or Reuse One Lean Worker (`opus-gate`)**:
   - Do **NOT** add `narrator` or `monitor` workers.
   - If this conversation already has a `waiting` `opus-gate` worker (`swarm{action: "status"}` only if a swarm is already active in this conversation), wake it incrementally with `post_message` (`@opus-gate ...`) to preserve prompt cache.
   - Otherwise spawn one worker:
     ```
     swarm{
       action: "add",
       name: "opus-gate",
       model: "<selected-opus-model>",
       brief: "..."
     }
     ```
   - **Context Rule**: Omit `fork` for `plan`, `risk`, `stop`, and `review` gates (supply a compact brief with goal, `git diff --stat`, touched `file:line` anchors, and test status). Pass `fork: "coordinator"` **only** for `debug` escalation when warm multi-turn failure context is essential.

3. **Mandatory Read-Only + `post_message` Brief Contract**:
   - Always forbid file edits, writes, and destructive shell commands.
   - Always require the worker to call `post_message` to wake you (`@coordinator [done] ...`) — **never** write *"Do NOT call any tools"*, because `post_message` is a tool!
   - Required worker output template:
     - **Verdict**: `APPROVE` | `REVISE` | `HOLD`
     - **P0 / P1 / P2**: concise `file:line`, failure scenario, minimal fix sketch.

4. **Wait, Integrate & Retire**:
   - Remember board tools (`post_message`, `read_board`, `swarm_wait`) arrive one turn *after* the first `swarm add` — end your turn cleanly after adding `opus-gate` so its `@coordinator` post wakes you.
   - Resolve every P0/P1 finding before concluding. When the checkpoint series is complete, call `swarm{action: "kill", name: "opus-gate"}` so no stale worker remains.
