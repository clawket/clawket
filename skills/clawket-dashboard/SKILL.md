---
name: clawket-dashboard
description: Use when checking work status, starting or finishing tasks, or creating tasks in the Clawket work board. Shows the current plan / unit / cycle / task view for the working directory and routes `start` / `done` / `new` sub-commands through the lifecycle gates.
allowed-tools:
  - Bash
---

# Clawket Work Dashboard

Structured work board for Claude Code sessions. State persists across sessions via local SQLite.

Locale: this skill respects `CLAWKET_LOCALE` (overrides `LC_ALL` / `LANG`). Accepted values: `en` | `ko` | `ja`. Fallback chain: `ja → ko → en`, `ko → en`.

## Current status

```!
clawket dashboard --cwd .
```

## Routing

Parse the first word of `$ARGUMENTS` as a sub-command. If no argument is given, show the dashboard above and the Quick Reference at the bottom.

### `dashboard` (or empty)

```bash
clawket dashboard --cwd .
```

### `start <TASK-ID>`

Start a task. Run BOTH prechecks first. If either fails, abort with the explicit message — do not start the task.

1. **Cycle must be `active`.** A `planning` cycle cannot host work; tell the user to run `clawket cycle activate <CYCLE>` first.

   ```bash
   CYCLE_STATUS=$(clawket cycle view $CYCLE_ID --format json | jq -r '.status')
   if [ "$CYCLE_STATUS" != "active" ]; then
     echo "Cycle $CYCLE_ID is $CYCLE_STATUS — activate it first: clawket cycle activate $CYCLE_ID"
     exit 1
   fi
   ```

2. **Only one task may be `in_progress` per cycle.** If another task is already running in the cycle, finish or pause it first.

   ```bash
   IN_PROGRESS=$(clawket task list --cycle $CYCLE_ID --status in_progress --format json | jq 'length')
   if [ "$IN_PROGRESS" != "0" ]; then
     echo "Another task is already in_progress in cycle $CYCLE_ID — finish or pause it first."
     exit 1
   fi
   ```

3. Start the task:

   ```bash
   # Usage: start <TASK-ID>
   clawket task update $TASK_ID --cycle $CYCLE_ID --status in_progress
   clawket task view $TASK_ID
   ```

The `PreToolUse` hook denies mutating tools when the in-progress task lacks a `cycle_id`. Always assign the task to an active cycle before starting; otherwise Edit / Write / Bash will be blocked with `gate.no_cycle_assignment`.

### `done [<TASK-ID>] ["comment"]`

Close a task. Evidence is required by the daemon (HTTP 400 `EVIDENCE_REQUIRED` if absent).

```bash
# Usage: done [<TASK-ID>] ["comment"]
clawket task update $TASK_ID --status done --evidence "<file:line or external check>" --comment "$COMMENT"
```

When the task transitions to `done`, the daemon auto-cascades unit / cycle / plan completion: once every child of a unit (and every unit of a cycle, and every cycle of a plan) is terminal, the parent is marked completed automatically. You do not run `cycle update --status completed` by hand for the normal path.

### `new "<title>" --unit <UNIT-ID> --cycle <CYCLE-ID> [--priority critical|high|medium|low]`

Create a new task in the active cycle. Always pass `--cycle <CYCLE-ID>` so the new task inherits an active cycle. The daemon requires the execution envelope, so `--intent`, `--prompt-template`, and `--success-criteria` are mandatory (`ENVELOPE_REQUIRED_FIELDS_MISSING` → HTTP 400 otherwise).

```bash
# Usage: new "<title>" --unit <UNIT-ID> --cycle <CYCLE-ID> [--priority critical|high|medium|low]
clawket task create "$TITLE" --unit $UNIT_ID --cycle $CYCLE_ID \
  --intent "$INTENT" \
  --prompt-template "$PROMPT_TEMPLATE" \
  --success-criteria "$SUCCESS_CRITERIA" \
  --priority $PRIORITY
```

## Quick reference

### Dashboard

```bash
clawket dashboard --cwd .
```

### Task

```bash
clawket task create "<title>" --unit <UNIT-ID> --cycle <CYCLE-ID> \
  --intent "<one-sentence intent>" \
  --prompt-template "<how an agent should approach it>" \
  --success-criteria "<verifiable Done condition>" \
  [--priority critical|high|medium|low]
clawket task update <TASK-ID> --status in_progress|done|cancelled [--evidence "<text>"]
clawket task list --cycle <CYCLE-ID>
clawket task view <TASK-ID>
clawket task search "<keyword>"
clawket comment create "<comment>" --task <TASK-ID>
```

### Plan / Unit / Cycle

```bash
clawket plan create "<title>" --project <PROJ-ID>
clawket plan list --project <PROJ-ID>
clawket plan approve <PLAN-ID>           # draft → active (required before starting tasks)
clawket unit create "<title>" --plan <PLAN-ID>
clawket unit list --plan <PLAN-ID>
clawket cycle create --project <PROJ-ID> --unit <UNIT-ID> "<title>"
clawket cycle list --plan <PLAN-ID>
clawket cycle activate <CYCLE-ID>        # planning → active
clawket cycle update <CYCLE-ID> --status completed
```

### Knowledge (RAG)

```bash
clawket knowledge create --title "<title>" --type note|decision|spec --body "<body>"
clawket knowledge list
clawket knowledge update <KNOWLEDGE-ID> --body "<updated body>"
```

### Daemon

```bash
clawket daemon status
clawket daemon restart
clawket doctor
```

## Output format

Commands return JSON by default. Use `--format table` for human-readable output.
