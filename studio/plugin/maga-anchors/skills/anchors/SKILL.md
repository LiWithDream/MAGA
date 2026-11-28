---
name: anchors
description: Inspect or author deterministic .agents/locks.json experiment/engineering locks and understand AGY Studio's Anti-Drift Anchors & Milestone Handoff workflow.
---

# AGY Studio Anti-Drift Anchors & Locks (`maga-anchors`)

Keep long-horizon research and engineering sessions immune to multi-compaction drift without polluting prompt context or autonomously mutating `AGENTS.md`.

## 1. Three Pillars
1. **Compaction Generation (`G`) & Milestone Handoff**: Tracks `step_type = 23` compactions (`G`). Because unrestated constraints decay with a half-life of ~2–3 compactions, consider handing off to a fresh milestone conversation once `G >= 3`.
2. **Human-Signed Verbatim Anchors (`.agents/rules/anchors.local.md`)**: Out-of-band `Stop` proposals pair verbatim user corrections with a redacted CoT comprehension check. Only human-accepted user quotes are flushed at turn boundaries (`<= 400` tokens, evict-to-admit). Never edit `AGENTS.md` or `.agents/rules/*.md` silently.
3. **Deterministic Locks (`.agents/locks.json`)**: Zero-LLM `PreToolUse` `force_ask` guard protecting locked files, budgets, and falsified dead ends (`Tombstones`). Note: `.agents/locks.json` is user-managed (`git-guard` blocks agent self-edits).

## 2. `.agents/locks.json` Schema
```json
{
  "schema": 1,
  "lockedFiles": [
    {
      "id": "auth-verify",
      "path": "src/auth/verify.ts",
      "quote": "Do not modify token verification logic without security review",
      "source": "turn#12"
    }
  ],
  "paramLocks": [
    {
      "id": "node-env",
      "key": "NODE_ENV",
      "expected": "production",
      "quote": "Keep release build strictly in production mode",
      "source": "turn#12"
    }
  ],
  "bannedPatterns": [
    {
      "id": "no-force-reset",
      "appliesTo": ["shell"],
      "pattern": "db:reset\\s+--force",
      "quote": "Destructive database reset is disabled in this workspace",
      "source": "turn#19",
      "reopenIf": "dedicated ephemeral staging DB"
    },
    {
      "id": "no-private-ip",
      "appliesTo": ["file"],
      "excludeFiles": ["ENV.md"],
      "pattern": "\\b10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b",
      "quote": "Do not write private network IPs into tracked files",
      "source": "turn#22"
    }
  ]
}
```

- Domain workflows (such as experiment harnesses using `tombstone_rules` / `locked_files` / `param_locks` / `exclude_files` aliases) share the exact same schema.
- `excludeFiles` matches both repo-relative paths and basenames (e.g. `"ENV.md"` exempts `ENV.md` at any depth; keep exempted files untracked).
