# Lattice

LLM-native work management system. All work history is permanently stored in a local SQLite database.

## Why Lattice

- **Structured over ad-hoc**: Every task is tracked as a Step. No work without registration.
- **Session persistence**: Context survives across sessions. No more "where was I?"
- **Automated transitions**: Phase/Plan/Bolt states update automatically based on step completion.
- **Single source of truth**: Lattice DB is the canonical record, not Plan Mode files or local notes.

## Entity Relationships

```
Project
├── Plan (roadmap/intent — hierarchical grouping)
│   └── Phase (epic — logical grouping within a plan)
│       └── Step (atomic task — the unit you actually work on)
│
└── Bolt (sprint — time-boxed iteration, cross-cutting)
    └── Steps from ANY phase/plan in this project
```

### Two axes of organization

1. **Vertical (what):** Plan → Phase → Step
   - Hierarchical grouping by scope. A Plan is a roadmap, Phases are epics within it, Steps are tasks within a phase.
   - Steps have an order (idx) within their phase.

2. **Horizontal (when):** Bolt → Steps
   - Time-boxed iteration (sprint). A Bolt pulls steps from any phase/plan in the same project.
   - One Bolt = "what we're doing this cycle." Steps from different plans can coexist in the same Bolt.

### Key rules

- A Step belongs to exactly one Phase AND one Bolt.
- A Bolt belongs to a Project, not a Plan. It can contain steps from multiple plans.
- Plan/Phase/Bolt states are automatic — only Step status is managed manually.
- A Plan must be approved (`lattice plan approve <ID>`) before steps can be created under it. Draft plans cannot have steps.

## Step Statuses

`todo` → `in_progress` → `done` | `cancelled`
`blocked` for external dependencies.

**Terminal (closed):** `done`, `cancelled`

## Automatic State Transitions

- **Step → in_progress**: Parent Phase/Plan become `active`. Parent Bolt becomes `active` if it was `completed`.
- **All steps terminal**: Phase → `completed`, Plan → `completed`, Bolt → `completed`.
- **New step created under completed Phase/Plan**: They reopen to `active`.
- **Bolt**: `planning` → `active` is manual (intentional start). `active` → `completed` is automatic.

## Workflow

### Planning (do NOT use Plan Mode files)
1. Propose plan in conversation, get user approval
2. Register via CLI after approval
3. Use `lattice <command> --help` for detailed usage of each command

### Working
1. `lattice step update <ID> --status in_progress`
2. `lattice step update <ID> --status done`
3. `lattice step update <ID> --status cancelled` (add comment with reason)

### Enforced by hooks
- No work without an active step (PreToolUse blocks Edit/Write/Bash/Agent)
- Steps require a bolt assignment
- Bolts require a project
- Use `lattice` CLI only — never call the API directly
