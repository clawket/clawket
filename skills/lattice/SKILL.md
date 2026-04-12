---
name: lattice
description: Manage work dashboard — view/update tasks, plans, phases, steps. Use when you need to check current work status, update step progress, create new tasks, or manage project workflow.
---

# Lattice Work Dashboard

Structured task board for Claude Code sessions. All state persists across sessions via SQLite.

## Current Status

```!
lattice dashboard --cwd .
```

## Instructions

If the user provided arguments (`$ARGUMENTS`), execute the corresponding lattice CLI command via Bash:
- `/lattice dashboard` → run `lattice dashboard --cwd .`
- `/lattice step list` → run `lattice step list`
- `/lattice step new "title" --phase PHASE-xxx` → run `lattice step new "title" --phase PHASE-xxx`
- Any other argument → run `lattice $ARGUMENTS`

If no arguments, show this reference and the dashboard output above.

## Quick Reference

### Dashboard
```bash
lattice dashboard --cwd .
```

### Step Operations
```bash
lattice step new "title" --phase <PHASE-ID> --assignee main
lattice step update <STEP-ID> --status in_progress|done|cancelled
lattice step list --phase-id <PHASE-ID>
lattice step show <STEP-ID>
lattice step search "keyword"
lattice comment new --step <STEP-ID> --body "comment"
```

### Phase / Plan / Bolt
```bash
lattice phase list --plan-id <PLAN-ID>
lattice phase approve <PHASE-ID>
lattice plan list --project-id <PROJ-ID>
lattice bolt list --project-id <PROJ-ID>
```

### Daemon
```bash
lattice daemon status
lattice daemon restart
```

## Output Format

All commands return JSON. Use `--format table` for human-readable output.
