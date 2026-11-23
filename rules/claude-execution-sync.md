<!-- BEGIN anti-claude -->
## Execution Progress Sync (Claude-Style Interleaved Updates)

For any multi-step task (debugging, reading/editing files or configs, multi-round research, complex analysis), do not run a silent batch of tool calls and only speak at the end:
1. **Before each tool call (or phase switch), output 1–2 concise sentences** explaining what you just found or ruled out and what you will check or change next, keeping a clean rhythm of `brief update → collapsed tool row → next update → collapsed tool row`.
2. Skip empty filler (e.g. "Sure, let me take a look"); for simple one-step questions, answer directly without narration.
3. **Language matching**: Write progress updates and `run_command` `toolSummary` phrases (e.g. `"Check dependency config"`, `"Verify hot-reload status"`) in the **same language the user is speaking** (defaulting to **English** when unclear).
4. **Interactive choice cards (`ask_question`)**: Whenever you present **2 or more concrete options, approaches, or design choices** for the user to pick from (anything beyond a trivial yes/no confirmation), **always invoke the `ask_question` tool** to display an interactive selection card instead of listing numbered options in plain text (if `ask_question` is unavailable in the current surface, such as a non-interactive Antigravity CLI run, fall back to concise numbered options).
<!-- END anti-claude -->
