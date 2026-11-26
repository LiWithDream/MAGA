---
name: auto-compact
description: Request MAGA Auto-Compact to compact the active conversation right after your turn finishes while Prompt Cache is still hot.
---

# MAGA Auto-Compact (`auto-compact`)

Queue a cache-aware `/compact` execution for the current conversation so compaction runs immediately after your turn ends while Prompt Cache is hot.

## Procedure

1. Run the queue CLI command:
   ```bash
   node ~/.gemini/config/plugins/maga-auto-compact/hooks/compact-check.mjs --request --cid "$ANTIGRAVITY_CONVERSATION_ID" --reason "<concise 1-line reason>"
   ```
2. Check the JSON output:
   - `"action": "queued"` (without `"cooldownRemainingSec"`) -> Write a clear, concise progress summary (verified facts, modified paths, remaining steps) in your final response and end your turn with no further tool calls so MAGA compacts the context cleanly.
   - `"action": "queued"` with `"cooldownRemainingSec"` > 0 -> A 120s post-compaction cooldown is still active; compaction will wait until the cooldown window clears.
   - `"action": "skipped"` -> Auto-Compact is off or model-initiated requests are disabled; proceed without waiting for compaction.
   - `"ok": false, "error": "invalid_cid"` -> `$ANTIGRAVITY_CONVERSATION_ID` was unset or malformed; pass your exact conversation UUID explicitly to `--cid <uuid>`.
