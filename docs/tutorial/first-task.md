# Your first task — 5 minute walkthrough

Goal: from a fresh install, you'll have a registered project, an active plan, an active cycle, and a task you can run `clawket task update --status done` against. Total time: 5 minutes.

## Prerequisites

You have the `clawket` CLI installed:

```sh
# Download from https://github.com/clawket/cli/releases
clawket --version
```

The daemon starts itself on first command. If you want to verify it's healthy:

```sh
clawket doctor
```

## 1. Register your working directory as a project (30 sec)

`cd` into any folder — a real repo, an empty test folder, anywhere. Clawket binds work to the directory you're in.

```sh
mkdir -p /tmp/clawket-tutorial && cd /tmp/clawket-tutorial
clawket project create "Hello Clawket" --cwd .
```

Expected output (abbreviated): `{ "id": "PROJ-...", "name": "Hello Clawket", "ticket_key": "HC", ... }`.

Save the project id — you'll see it referred to as `$PROJECT_ID` below.

## 2. Create a plan and approve it (45 sec)

Plans are the source of truth for approved intent. **You cannot start a task on a draft plan** — approve gates the work.

```sh
PROJECT_ID=PROJ-...   # paste from step 1
clawket plan create --project $PROJECT_ID "First plan"
clawket plan approve PLAN-...
```

The plan transitions `draft → active`.

## 3. Create a unit (15 sec)

Units group related tasks. They're a pure grouping entity — no status, no approval.

```sh
clawket unit create --plan PLAN-... "Onboarding"
```

## 4. Create and activate a cycle (30 sec)

Cycles are time-boxed execution containers. **Tasks can only be started inside an active cycle.**

```sh
clawket cycle create --project $PROJECT_ID "Sprint 0"
clawket cycle activate CYC-...
```

## 5. Create your first task (30 sec)

Tasks are the only entity you work directly. They start in `todo`.

```sh
clawket task create "Read the README" \
  --unit UNIT-... \
  --cycle CYC-... \
  --priority high \
  --type docs
```

You'll get a `TASK-...` id and a human-friendly ticket number like `HC-1`.

## 6. Start the task (10 sec)

Transition `todo → in_progress`. The daemon refuses this if the cycle isn't active or the plan isn't approved — that's intentional, those are the rails.

```sh
clawket task update TASK-... --status in_progress
```

## 7. Do the work, then close it (variable)

Open the README, read it, then:

```sh
clawket task update TASK-... --status done \
  --comment "Read README. Got the structured agent loop: Decompose → Contract → Execute."
```

The daemon writes a `runs` row, an `activity_log` audit row, and (if this was the last open task in the cycle) cascades the cycle to `completed`. None of this requires you to do anything extra.

## 8. See what just happened

```sh
clawket dashboard --cwd .
```

You'll see your project, plan, unit, cycle, and the closed task with its full audit trail.

## Where to go next

- **Decompose a task tree** — `clawket task decompose TASK-... --strategy rule` splits a task into structured leaves with envelopes inherited from the parent.
- **Run a task with claude** — `clawket execute TASK-... --dry-run` prints the assembled envelope-to-prompt payload; drop `--dry-run` to spawn `claude -p` against it.
- **Replay a run** — `clawket run replay RUN-...` reconstructs the full execution timeline from the audit log.

## Cleanup

```sh
# Drop everything for the tutorial project (audit log preserved):
clawket project delete $PROJECT_ID
```

## What you just experienced

You moved through Clawket's full lifecycle: **Project → Plan(approve) → Unit → Cycle(activate) → Task(start → done)**. Every transition was guarded by a pre-condition the daemon enforces (no task without active cycle; no cycle restart after completion; no destructive deletion of plan with open tasks). That's the structured agent loop — the same one your LLM agent will follow when it picks up tasks in this project.
