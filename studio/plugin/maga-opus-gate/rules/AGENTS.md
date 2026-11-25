<!-- BEGIN maga-opus-gate-rule -->
## MAGA Opus Gate

- **Skip**: Do nothing if already running on Claude Opus, or on trivial Q&A, formatting, or small straightforward edits.
- **Explicit User Request**: When the user explicitly asks for an Opus review or checkpoint, load `opus-gate` and run it directly **without quota gating** (prefer `claude-opus-5-5-high` unless specified otherwise).
- **Hook Trigger**: When receiving `[MAGA Opus Gate]` from a `Stop` hook, load `opus-gate` and execute the checkpoint.
- **Semantic Self-Judgment** (even when diff/filename rules do not fire): consider loading `opus-gate` + running its **Preflight Gate** (`gate-check.mjs --preflight`) at high-ROI moments:
  - `plan`: finalizing a multi-module architecture, schema/API contract, or complex plan before coding.
  - `risk`: subtle concurrency/locking, state machine, auth/security, migration, or tricky invariants regardless of filename/size.
  - `debug`: stuck after 2+ hypotheses/attempts without clear root cause (even without command exit errors).
  - `stop`: finishing a complex multi-step change with non-obvious regression surface.
- **Hard Guard**: Always run `opus-gate` preflight *before* calling `swarm` on semantic triggers. Never call `swarm` spontaneously without an explicit user request, `[MAGA Opus Gate]` hook, active `/swarm` session, or `"run_swarm"` preflight verdict.
<!-- END maga-opus-gate-rule -->
