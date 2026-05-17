---
name: clawket
schema_version: v3
description: Manage work dashboard — view/update tasks, plans, units, tasks. Use when you need to check current work status, update task progress, create new tasks, or manage project workflow.
allowed-tools:
  - Bash
---

<!-- locale: ${CLAWKET_LOCALE:-en} -->
<!-- I18N-140 / SKILL-160: skill copy locale marker. The hook layer reads
     CLAWKET_LOCALE first (then LC_ALL → LANG → en) and surfaces the chosen
     locale on stderr as `[clawket] locale=<x> (fallback chain: …)`. The
     fallback chain is ja→ko→en for Japanese, ko→en for Korean. Localized
     command output ships in `locales/<locale>.json`. -->

# Clawket Work Dashboard

Structured task board for Claude Code sessions. All state persists across sessions via SQLite.

> Locale: this skill respects `CLAWKET_LOCALE` (overrides `LC_ALL`/`LANG`).
> Set it to `en` | `ko` | `ja`. Fallback chain: ja→ko→en, ko→en.

## Current Status

```!
clawket dashboard --cwd .
```

## Instructions

If the user provided arguments (`$ARGUMENTS`), parse the first word as a sub-command keyword and execute the corresponding flow below. If no arguments, show this reference and the dashboard output above.

### Keyword sub-flows

#### `/clawket` or `/clawket dashboard`
Show the full work dashboard for the current directory.
```bash
clawket dashboard --cwd .
```

#### `/clawket start`
Mark a task as in-progress. Requires a task ID argument.

PDD lifecycle gate (v3): the PreToolUse hook will deny mutating tools when
the in-progress task lacks a `cycle_id`. Always assign the task to an active
cycle before starting it, otherwise edits/writes/bash will be blocked with
`gate.no_cycle_assignment`.

Run these prechecks BEFORE `clawket task update --status in_progress`. If
either fails, abort with the explicit message shown — do not start the task.

1. **SKILL-031 — cycle must be `active`.** A `planning` cycle cannot host
   in-progress work. If the precheck reports `planning`, stop and instruct
   the user to `clawket cycle activate <CYCLE>` first.
   ```bash
   CYCLE_STATUS=$(clawket cycle view $CYCLE_ID --format json | jq -r '.status')
   if [ "$CYCLE_STATUS" != "active" ]; then
     echo "Cycle $CYCLE_ID is $CYCLE_STATUS — activate it first: clawket cycle activate $CYCLE_ID"
     exit 1
   fi
   ```
2. **SKILL-032 — no concurrent in_progress task in the same cycle.** PDD A4
   forbids two tasks running concurrently inside one cycle. If any other
   `in_progress` task already lives in `$CYCLE_ID`, stop and instruct the
   user to `clawket task update <ID> --status todo` (or `done`) first.
   ```bash
   IN_PROGRESS=$(clawket task list --cycle $CYCLE_ID --status in_progress --format json | jq 'length')
   if [ "$IN_PROGRESS" != "0" ]; then
     echo "Another task is already in_progress in cycle $CYCLE_ID — finish or pause it first."
     exit 1
   fi
   ```
3. Now start the task:
   ```bash
   # Usage: /clawket start <TASK-ID>
   clawket task update $TASK_ID --cycle $CYCLE_ID --status in_progress
   clawket task view $TASK_ID
   ```

#### `/clawket done`
Mark the current in-progress task as done with an optional comment.

PDD lifecycle (v3): when the task transitions to done and its cycle's exit
gate is met, the daemon emits a `completion-possible` SSE event rather than
silently auto-completing the cycle/plan. Operators must run
`clawket cycle update <CYCLE-ID> --status completed` (and similarly for
plan) explicitly. This preserves the human review point at the cycle/plan
boundary required by PDD A6.

```bash
# Usage: /clawket done [<TASK-ID>] ["comment"]
clawket task update $TASK_ID --status done --comment "$COMMENT"
```

#### `/clawket new`
Create a new task in the active cycle. Prompts for title, unit, and priority.

PDD lifecycle gate (v3): always pass `--cycle <CYCLE-ID>` so the new task
inherits an active cycle. Tasks without a cycle assignment will be denied by
the PreToolUse `gate.no_cycle_assignment` guard the moment they are started.

```bash
# Usage: /clawket new "<title>" --unit <UNIT-ID> --cycle <CYCLE-ID> [--priority high|med|low]
clawket task create "$TITLE" --unit $UNIT_ID --cycle $CYCLE_ID --priority $PRIORITY
```

#### `/clawket scenario`
PDD intent layer — author or review user scenarios for a domain.

1. Read the current scenario knowledge for the domain (use `clawket knowledge list` to find it).
2. Follow `scenario-authoring.md` rules: each scenario has `As a / I want / So that` + `Given/When/Then`.
3. Write or update the scenario knowledge:
```bash
# Find existing scenario knowledge
clawket knowledge list --title "scenario"

# Create new scenario knowledge (first time)
clawket knowledge create --title "scenario-<DOMAIN>" --type note --body "$(cat /path/to/scenarios.md)"

# Update existing scenario knowledge
clawket knowledge update <KNOWLEDGE-ID> --body "$(cat /path/to/updated-scenarios.md)"
```

#### `/clawket qa`
Run a scenario-based QA round (code-inference mode).

1. Load the scenario knowledge for the domain.
2. Create a QA round plan: `clawket plan create "<DOMAIN> QA 라운드 N (코드 추론)"`.
3. For each scenario, create one QA task and evaluate code-vs-scenario.
4. Defects → register as fix tasks in the `<DOMAIN> QA 이슈 해결` plan.

```bash
# Create QA round plan
clawket plan create "<DOMAIN> QA 라운드 N (코드 추론)" --project $PROJ_ID

# Create QA unit per domain area
clawket unit create "QA-<DOMAIN> <영역>" --plan $PLAN_ID --mode parallel

# Create one task per scenario
clawket task create "QA-<SCENARIO-ID>: <scenario title>" --unit $UNIT_ID --cycle $CYCLE_ID

# Register defect fix task in separate plan
clawket task create "FIX: <description>" --unit $FIX_UNIT_ID --cycle $FIX_CYCLE_ID

# Task output format (put in task body/comment):
# status: pass | defect | scenario_error
# reasoning: <code trace>
# evidence: file:line (for defect/scenario_error)
# defect_task: <TASK-ID> (if defect)
```

#### `/clawket decompose`
PDD execution layer — decompose a Unit into Cycle tasks (run at Cycle activation time only).

Per PDD axiom A3, tasks are created only when the cycle is activated — not before.
The first task in any cycle must be "scope 확정 + 나머지 task 생성".

```bash
# Activate a cycle for a unit
clawket cycle create --unit $UNIT_ID --title "라운드 1" --plan $PLAN_ID
clawket cycle update $CYCLE_ID --status active

# First task: scope + decompose
clawket task create "이번 cycle scope 확정 + 나머지 task 생성" --cycle $CYCLE_ID --unit $UNIT_ID --priority high

# Remaining tasks (created by the first task above)
clawket task create "<verb phrase>" --cycle $CYCLE_ID --unit $UNIT_ID --priority $PRI

# Task quality: T1 verb phrase, T2 ≤8 files, T3 external verifiable Done, T6 label, T7 scenario ID
```

#### `/clawket retro`
Retrospective — review a completed cycle and record decisions.

1. List all done tasks in the cycle.
2. Identify structural patterns or decisions made.
3. Record decisions as `type=decision` knowledge.

```bash
# List completed cycle tasks
clawket task list --cycle $CYCLE_ID --status done

# Record decision knowledge
clawket knowledge create --title "decision-<DOMAIN>-<slug>" --type decision \
  --body "## Context\n<why>\n\n## Decision\n<what>\n\n## Consequences\n<impact>"

# Mark cycle done
clawket cycle update $CYCLE_ID --status completed
```

## Quick Reference

### Dashboard
```bash
clawket dashboard --cwd .
```

### Task Operations
```bash
clawket task create "<title>" --unit <UNIT-ID> --cycle <CYCLE-ID> --priority high|med|low
clawket task update <TASK-ID> --status in_progress|done|cancelled
clawket task list --cycle <CYCLE-ID>
clawket task view <TASK-ID>
clawket task search "<keyword>"
clawket comment create --task <TASK-ID> --body "<comment>"
```

### Plan / Unit / Cycle
```bash
clawket plan create "<title>" --project <PROJ-ID>
clawket plan list --project <PROJ-ID>
clawket unit create "<title>" --plan <PLAN-ID>
clawket unit list --plan <PLAN-ID>
clawket cycle create --unit <UNIT-ID> --title "<title>" --plan <PLAN-ID>
clawket cycle list --plan <PLAN-ID>
clawket cycle update <CYCLE-ID> --status active|completed
```

### Knowledge (RAG)
```bash
clawket knowledge create --title "<title>" --type note|decision --body "<body>"
clawket knowledge list
clawket knowledge update <KNOWLEDGE-ID> --body "<updated body>"
```

### Daemon
```bash
clawket daemon status
clawket daemon restart
clawket doctor
```

## Output Format

All commands return JSON by default. Use `--format table` for human-readable output.

## PDD Lifecycle Reference (v3)

```
[1] Intent layer (immutable)
    scenario-authoring → Plan → Unit (all pre-designed)

[2] Execution layer (incremental, per Cycle activation)
    Cycle activate → first Task = "scope + decompose" → execute → Cycle Exit Gate

[3] QA round (separate Plan per round)
    1 scenario = 1 QA task → defects → fix plan → next round
    Convergence: min 3 rounds + last 2 rounds zero defects
```

Anti-patterns blocked by this plugin (PDD §Anti-patterns):
- X1: analysis/review tasks (no executable verb)
- X3: task not traceable to a scenario ID
- X4: Done = "implemented" (self-referential)
- X7: cross-unit cycle
- X8: same-unit concurrent active cycles
- X9: pre-creating tasks before cycle activation
