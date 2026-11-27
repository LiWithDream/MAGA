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
      "id": "eval-harness",
      "path": "scripts/eval.py",
      "quote": "严禁修改评测脚本刷分",
      "source": "turn#74"
    }
  ],
  "paramLocks": [
    {
      "id": "max-epochs",
      "key": "MAX_EPOCHS",
      "expected": "3",
      "quote": "不能改最大epoch，必须同赛道3个epoch对比",
      "source": "turn#74"
    }
  ],
  "bannedPatterns": [
    {
      "id": "tombstone-res-640",
      "pattern": "(?:--image-size|--resolution|IMG_SIZE)[=\\s]+640\\b",
      "quote": "640分辨率已经证伪掉点，不要再跑",
      "source": "turn#108",
      "reopenIf": "new multi-scale pos-embed recipe"
    }
  ]
}
```
