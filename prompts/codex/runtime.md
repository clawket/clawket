# Codex Adapter

This runtime uses native Codex plugin hooks after a one-time `clawket codex install`, plus the optional `clawket codex` launcher.

- SessionStart injects the Clawket dashboard context into Codex startup
- Active task enforcement is hard-blocked at PreToolUse for mutating Codex tools
- Use `clawket task create` or `clawket task update <ID> --status in_progress` before implementation work
- Use `clawket codex install` if plain `codex` sessions are not loading Clawket
- Use `clawket codex status` to inspect optional wrapper session state
- Use `clawket codex stop` to close open runs if a wrapper-managed session ends unexpectedly

When operating inside Codex, treat the active Clawket task as the source of truth for implementation work.
