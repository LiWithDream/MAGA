<!-- BEGIN maga-opus-gate-rule -->
## MAGA Review Gate

- **Skip**: Do nothing if running on Claude Opus, or on Carbon when configured reviewer is Carbon, or on trivial edits/Q&A.
- **Explicit User Request**: When the user asks for a review/checkpoint (Opus or Carbon), load `opus-gate` and run directly **without quota gating** (prefer the named model, or `claude-opus-5-5-high` if Opus was requested).
- **Hook Trigger**: On `[MAGA Review Gate]` / `[MAGA Opus Gate]` from `Stop`, load `opus-gate` and execute with the specified model and worker.
- **Semantic Self-Judgment** (even when diff/filename rules do not fire): consider loading `opus-gate` + running `gate-check.mjs --preflight --model "<current model>"` at high-ROI moments:
  - `plan`: finalizing a multi-module architecture, schema/API contract, or complex plan before coding.
  - `risk`: subtle concurrency/locking, state machine, auth/security, migration, or tricky invariants regardless of size.
  - `debug`: stuck after 2+ hypotheses/attempts without clear root cause.
  - `stop`: finishing a complex multi-step change with non-obvious regression surface.
- **Hard Guard**: Always run `opus-gate` preflight with `--model` before calling `swarm` on semantic triggers. Never call `swarm` spontaneously without an explicit request, Gate hook, active `/swarm`, or `"run_swarm"` preflight verdict.
<!-- END maga-opus-gate-rule -->
