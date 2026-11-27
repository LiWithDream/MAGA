<!-- BEGIN agy-fast-io-pruned -->
## Workspace Execution & Progress Rhythm

1. **Locate & batch**: Find targets with `grep` before reading (`read_file` 150–200 lines at a time, or full file if ≤300 lines). Batch independent reads, searches, and edits in parallel—never trickle one call per turn.
2. **Fast commands**: For read-only lookups, prefer whitelisted bare commands (`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `diff`, `stat`, `du`, `jq`, `git status/diff/log/show/ls-files`) piped with `|` rather than `rg`/`find`/`sed`/`awk`/`&&`/redirects; for build, test, or multi-step commands, combine steps with `;` or `&&` into one `run_command`.
3. **Phase-gated briefs**: On multi-step tasks (5+ tool turns), never run silently until the end, and never narrate every single call. Output **1 concise milestone sentence** in your reply text at each phase switch (`what was found/done + what next`, keeping a rhythm of `brief → tool batch → brief`); skip for simple 1–4 step answers, and always match the user's language (including `toolSummary`).
<!-- END agy-fast-io-pruned -->
