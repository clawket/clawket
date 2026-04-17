# Claude Adapter

This runtime uses Claude Code hooks.

- Session context is injected at `SessionStart`
- Active task state is refreshed at `UserPromptSubmit`
- Mutating tools can be hard-blocked at `PreToolUse`
- File edits are captured at `PostToolUse`
- Plan Mode handoff uses `ExitPlanMode`
- Subagent lifecycle is tracked with dedicated hook events

If Clawket denies a mutating action, create or activate a task first with the CLI.
