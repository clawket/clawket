# Clawket

LLM-native work management system. All work history is permanently stored in a local SQLite database.

## Core Workflow

- Register the working directory as a Project before structured work begins.
- Plans are the source of truth for approved intent.
- Units group tasks. Tasks are the only entity worked directly.
- Cycles are time-boxed execution containers across units and plans.

## Core Rules

- No implementation work without an active task.
- Use `clawket` CLI instead of calling the daemon API directly.
- Starting a task requires an active plan and an active cycle.
- Cancelled work should preserve history with comments instead of destructive deletion.

## Task Lifecycle

`todo` → `in_progress` → `done` | `cancelled`

`blocked` is allowed for external dependencies.

## Operating Norms

- Check current state with `clawket dashboard --cwd .`
- Create or transition tasks explicitly with the CLI
- Preserve execution history through runs, comments, and task body updates
