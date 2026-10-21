# Clawket

LLM-native work management system. All work history is permanently stored in a local SQLite database.

## Why Clawket

- **Structured over ad-hoc**: Every task is tracked as a Task. No work without registration.
- **Session persistence**: Context survives across sessions. No more "where was I?"
- **Single source of truth**: Clawket DB is the canonical record, not Plan Mode files or local notes.

## Entity Relationships

```
Project
├── Plan (intent/roadmap — must be approved before work can start)
│   └── Unit (grouping — no status, pure organizational unit)
│       └── Task (atomic task — the only entity you manage directly)
│
└── Cycle (sprint — time-boxed iteration, cross-cutting)
    └── Tasks from ANY unit/plan in this project
```

### Two axes of organization

1. **Vertical (what):** Plan → Unit → Task — hierarchical grouping by scope
2. **Horizontal (when):** Cycle → Tasks — time-boxed iteration pulling tasks from any unit/plan

### Key rules

- A Task belongs to exactly one Unit AND one Cycle.
- A Cycle belongs to a Project, not a Plan. Tasks from different plans can coexist.
- Unit has no status — it is a pure grouping entity.
- Plan and Cycle require intentional approval/activation before work can start.

## Task Statuses

`todo` → `in_progress` → `done` | `cancelled`
`blocked` for external dependencies.

**Terminal (closed):** `done`, `cancelled`

## State Management

### Plan: `draft` → `active` → `completed`
- `draft` → `active`: Intentional approval via CLI (`clawket plan approve`) or web UI
- `active` → `completed`: Intentional, when all work is done
- Tasks can be created under draft plans as `todo`, but cannot be started (`in_progress`)
- `todo` tasks under draft plans can be hard-deleted (the only case where delete is allowed)

### Cycle: `planning` → `active` → `completed`
- `planning` → `active`: Intentional start via CLI (`clawket cycle activate`) or web UI
- `active` → `completed`: Intentional end — Cycle is a sprint, ended deliberately
- **Completed cycles cannot be restarted.** Create a new cycle instead.
- Tasks can only be started (`in_progress`) if their cycle is `active`
- Parallel cycles are supported — multiple active cycles per project

### Unit: No status
- Pure grouping. No state management needed.

### Task: Only entity managed directly
- Tasks can be created without a cycle (goes to backlog)
- Starting a task (`in_progress`) requires: Plan is `active` AND Cycle is assigned and `active`
- Both LLM (CLI) and human (web UI) can change task status

## Workflow

### Planning (do NOT use Plan Mode files)
1. Propose plan in conversation, get user approval
2. Register via CLI after approval
3. Use `clawket <command> --help` for detailed usage of each command

### Working
1. `clawket task update <ID> --status in_progress` (also before dispatching a sub-agent assigned to the task — dispatch never starts it)
2. `clawket task update <ID> --status done --evidence "<file:line | run:<RUN-ID>>"` (test results must cite a run recorded by `scripts/record-run.cjs`)
3. `clawket task update <ID> --status cancelled` (add comment with reason)

### Enforced by hooks
- No work without an active task (PreToolUse blocks Edit/Write/Bash/Agent)
- Tasks require a cycle assignment
- Cycles require a project
- Use `clawket` CLI only — never call the API directly
