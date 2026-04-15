[한국어](README.ko.md)

<p align="center">
  <img src="assets/main.png" width="600" alt="Clawket — LLM-native work management" />
</p>

<p align="center">LLM-native work management plugin for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a></p>

Clawket is a structured state layer that replaces Jira + Confluence for LLM-driven development. It persists project plans, units, tasks, artifacts, and execution history across sessions via a local SQLite database and a lightweight daemon.

## Features

- **Structured Workflow** — Project → Plan (approve) → Unit → Task → Cycle (activate)
- **Cycle Iterations** — Sprint-like iteration management (AIDLC cycle support)
- **Web Dashboard** — Summary, Plans, Board (Kanban), Backlog, Timeline, Wiki — 6 views
- **Agent Swimlane Timeline** — Per-agent horizontal bar chart with concurrent work visualization
- **Drag & Drop** — Kanban DnD for status changes, backlog DnD for cycle assignment
- **Wiki** — File tree navigation with configurable paths, artifact versioning, local RAG
- **Hook Enforcement** — Blocks work without active task, injects project context per session
- **Ticket Numbers** — Human-readable IDs (CK-1, CK-2) with token-optimized output
- **CLI + Web** — Both LLM (CLI) and human (web UI) can manage all entities

## Installation

```bash
# 1. Add marketplace
/plugin marketplace add Seungwoo321/clawket

# 2. Install plugin
/plugin install clawket@Seungwoo321-clawket
```

Setup hook automatically installs daemon dependencies (`pnpm install`) on first use.

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 20+
- Rust toolchain (for building CLI from source, or use prebuilt binary in `bin/`)

## Architecture

```
Claude Code ──(hooks)──→ clawketd (Node.js daemon)
           ──(CLI/Bash)─→ clawket (Rust binary)
                              │
                              ▼
                     ~/.local/share/clawket/db.sqlite

Web Dashboard (React) ──→ clawketd HTTP API (static file serving)
```

## Project Structure

```
clawket/
├── cli/              # Rust CLI source
├── daemon/           # Node.js daemon source + migrations
│   ├── src/          # Server, repo, db, embeddings
│   └── web/          # Built React dashboard (plugin bundle, optional)
├── web/              # React dashboard source (dev only)
├── scripts/          # Hook scripts (.cjs)
├── hooks/            # hooks.json
├── skills/           # /clawket skill
├── prompts/          # rules.md (SessionStart injection)
├── bin/              # CLI binary (prebuilt)
├── assets/           # Logo, mascot, branding
├── screenshots/      # Dashboard screenshots
└── .claude-plugin/   # Plugin metadata
```

## Web Dashboard

Access at `http://localhost:19400` when daemon is running. 6 views:

| View | Description |
|------|-------------|
| **Summary** | Project overview with progress, active agents, unit progress |
| **Plans** | Tree view with inline editing, bulk actions, checkbox selection |
| **Board** | Kanban board with drag-and-drop status changes |
| **Backlog** | Cycle-grouped backlog with drag-and-drop assignment |
| **Timeline** | Agent swimlane view (run bars per agent) + activity stream tab |
| **Wiki** | File tree with auto-extracted headings, artifact CRUD, GFM table support |

### Screenshots

| Summary | Plans |
|---------|-------|
| ![Summary](screenshots/01-summary.png) | ![Plans](screenshots/02-plans.png) |

| Board (Kanban) | Backlog |
|----------------|---------|
| ![Board](screenshots/03-board.png) | ![Backlog](screenshots/04-backlog.png) |

| Timeline | Wiki |
|----------|------|
| ![Timeline](screenshots/05-timeline.png) | ![Wiki](screenshots/06-wiki.png) |

## Usage

Clawket enforces a structured workflow. Claude cannot start working until a project, plan, and task are registered. The PreToolUse hook blocks all mutating operations (Edit, Write, Bash, Agent) until an active task exists.

### First-time setup

Every new directory needs a project registered first:

```
You: "Register this as a new project"

→ Claude runs: clawket project create "my-project" --cwd "."
→ Project appears in the web dashboard sidebar
```

### Planning work

Clawket is the source of truth for plans — not Claude's Plan Mode files (`~/.claude/plans/`). This is by design: plans live in the Clawket database, not as local files that can become stale or get polluted. Claude proposes plans in the conversation context, and after approval, registers them directly via CLI.

**Normal mode:**

```
You: "Plan the authentication refactor"

→ Claude analyzes the codebase and proposes a plan in chat
→ You review and approve
→ Claude registers via CLI:
  clawket plan create --project PROJ-xxx "Auth Refactor"
  clawket plan approve PLAN-xxx
  clawket unit create --plan PLAN-xxx "Unit 1 — OAuth Setup"
  clawket task create "Implement OAuth flow" --assignee main   # goes to backlog
  clawket cycle create --project PROJ-xxx "Sprint 1"
  clawket cycle activate CYC-xxx
  clawket task update TASK-xxx --cycle CYC-xxx                 # assign to cycle
```

**Plan mode (`/plan`):**

```
You: /plan
You: "Plan the authentication refactor"

→ Claude proposes the plan as conversation context (Write is blocked by hooks)
→ You approve via ExitPlanMode
→ Claude registers the approved plan in Clawket via CLI
```

### Working on tasks

```
You: "Fix the login bug on the settings page"

→ Claude registers a task under an existing plan/unit/cycle
→ Sets it to in_progress, works on it, marks it done
  (PreToolUse hook blocks work until a task exists)
```

### Checking progress

```
You: "What's the current status?"

→ Claude reads the dashboard (injected once at SessionStart)
→ Shows active tasks, cycle progress, blocked items
```

### Managing cycles (sprints)

```
You: "Start a new sprint for the API work"

→ Claude creates a cycle, assigns tasks, activates it
→ Board view shows the sprint's kanban
```

### Reviewing in the web dashboard

Open `http://localhost:19400` to see:
- **Board** — Kanban view of current sprint
- **Backlog** — All cycles with drag-and-drop assignment
- **Timeline** — Agent swimlane showing who did what and when
- **Wiki** — Project documents and artifacts

### Key concepts

| Concept | Description |
|---------|-------------|
| **Project** | A working directory registered with Clawket |
| **Plan** | High-level intent (roadmap). Must be approved before tasks can start |
| **Unit** | Pure grouping entity (no status). Organizes tasks within a plan |
| **Task** | Atomic task unit. Can be created without a cycle (goes to backlog) |
| **Cycle** | Sprint — time-boxed iteration. Tasks must be assigned to an active cycle to start |
| **Backlog** | Tasks without a cycle assignment. Drag to a cycle to schedule |

### Disabling Clawket for a project

You can temporarily disable Clawket management for a project without losing data. In the web dashboard, go to **Project Settings** and toggle **Clawket Management** off.

When disabled:
- Hooks treat the directory as if no project is registered — Claude works without constraints
- All existing data (plans, tasks, runs) is preserved
- Toggle it back on anytime to resume structured workflow

This is useful when you want to use Claude freely for exploration or quick fixes without registering tasks.

### State management

- **Plan**: `draft` → `active` (intentional approve) → `completed` (intentional end)
- **Unit**: No status — pure grouping
- **Cycle**: `planning` → `active` (intentional start) → `completed` (intentional end). Cannot be restarted.
- **Task**: `todo` → `in_progress` → `done`/`cancelled`. Requires active plan + active cycle to start.
- **Task statuses**: `todo`, `in_progress`, `blocked`, `done`, `cancelled`

### Prompt tips

| What you want | What to say |
|---------------|-------------|
| Register project | "Register this directory as a new project" |
| Plan work | "Plan the feature X — propose a plan and register it in Clawket" |
| Create a task | "Register a task for X and start working" |
| Check status | "Show me the current cycle progress" |
| Review work | "What was done in the last sprint?" |
| Search docs | "Search the wiki for authentication design" |
| Finish up | "Mark the current task as done" |

## Migration from Lattice

If upgrading from Lattice v1.x, the daemon automatically migrates your database on first start:
- `~/.local/share/lattice/db.sqlite` → `~/.local/share/clawket/db.sqlite`
- Schema migration 017 renames all entities (Phase→Unit, Step→Task, Bolt→Cycle)
- ID prefixes change: `PHASE-`→`UNIT-`, `STEP-`→`TASK-`, `BOLT-`→`CYC-`, `LAT-`→`CK-`

## Development

```bash
# Daemon
cd daemon && pnpm install

# Web dashboard
cd web && pnpm install && pnpm dev

# CLI
cd cli && cargo build
```

## License

MIT
