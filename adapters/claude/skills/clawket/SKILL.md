---
name: clawket
description: Manage work dashboard — view/update tasks, plans, units, tasks. Use when you need to check current work status, update task progress, create new tasks, or manage project workflow.
---

# Clawket Work Dashboard

Structured task board for Claude Code sessions. All state persists across sessions via SQLite.

## Current Status

```!
clawket dashboard --cwd .
```

## Instructions

If the user provided arguments (`$ARGUMENTS`), execute the corresponding clawket CLI command via Bash:
- `/clawket dashboard` → run `clawket dashboard --cwd .`
- `/clawket task list` → run `clawket task list`
- `/clawket task new "title" --unit UNIT-xxx` → run `clawket task new "title" --unit UNIT-xxx`
- Any other argument → run `clawket $ARGUMENTS`

If no arguments, show this reference and the dashboard output above.

## Quick Reference

### Dashboard
```bash
clawket dashboard --cwd .
```

### Task Operations
```bash
clawket task new "title" --unit <UNIT-ID> --assignee main
clawket task update <TASK-ID> --status in_progress|done|cancelled
clawket task list --unit-id <UNIT-ID>
clawket task show <TASK-ID>
clawket task search "keyword"
clawket comment new --task <TASK-ID> --body "comment"
```

### Unit / Plan / Cycle
```bash
clawket unit list --plan-id <PLAN-ID>
clawket unit approve <UNIT-ID>
clawket plan list --project-id <PROJ-ID>
clawket cycle list --project-id <PROJ-ID>
```

### Daemon
```bash
clawket daemon status
clawket daemon restart
```

## Output Format

All commands return JSON. Use `--format table` for human-readable output.
