# Codex Adapter

Codex integration supports two entry paths:

- plain `codex` sessions after a one-time `clawket codex install`
- optional wrapper-managed sessions through `clawket codex`

Current behavior:

- SessionStart injects the active dashboard summary and Clawket rules into Codex startup
- UserPromptSubmit refreshes active task context on each turn
- PreToolUse hard-blocks `exec_command`, `apply_patch`, and `write_stdin` when no task is active
- wrapper state, when used, is stored under `~/.cache/clawket/codex/`
- runtime checks are exposed through `clawket runtime doctor codex` and `clawket codex status`

Activation model:

- The repo stores the marketplace manifest under `.agents/plugins/marketplace.json`
- `clawket codex install` registers that repo-local marketplace in the user's `~/.codex/config.toml`
- plain `codex` then discovers the Clawket plugin through the user's Codex config
