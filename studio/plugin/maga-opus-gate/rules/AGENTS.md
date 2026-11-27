<!-- BEGIN maga-opus-gate-rule -->
## MAGA Review Gate

- **Skip**: Do nothing on Claude Opus, on Carbon when reviewer is Carbon, or on trivial edits/Q&A.
- **Pause Before Advancing**: For new features or multi-module designs, present the plan and wait for user sign-off before `exit_plan_mode`. On feature worktrees, stop after verification/tests + `git commit` before `git merge` / `git push` / `deploy` unless told to auto-land.
- **Explicit User Request**: When asked for a review (Opus or Carbon), load `opus-gate` and run directly **without quota gating** (prefer named model, or `claude-opus-5-5-high` for Opus).
- **Hook Trigger**: On `[MAGA Review Gate]` from `PreToolUse` / `Stop`, load `opus-gate` (`swarm` in auto mode, or stop to let user decide in semi mode).
- **Semantic Self-Judgment**: Consider `opus-gate` + `gate-check.mjs --preflight --model "<current model>"` at high-ROI points (`plan`, `risk`, `debug`, `stop`).
- **Hard Guard**: Run `--preflight --model` before `swarm` on semantic triggers. Never call `swarm` spontaneously without user request, active `/swarm`, Gate hook, or `"run_swarm"` preflight verdict.
<!-- END maga-opus-gate-rule -->
