[한국어](README.ko.md)

<p align="center">
  <img src="logo.svg" width="80" alt="Lattice logo" />
</p>

<h1 align="center">Lattice</h1>

<p align="center">LLM-native work management plugin for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a></p>

Lattice is a structured state layer that replaces Jira + Confluence for LLM-driven development. It persists project plans, phases, steps, artifacts, and execution history across sessions via a local SQLite database and a lightweight daemon.

## Features

- **Structured Task Board** — Projects, Plans, Phases, Steps with full CRUD
- **Bolt Cycles** — Sprint-like iteration management (AIDLC bolt cycle support)
- **Web Dashboard** — Summary, Plans, Board (Kanban), Backlog, Timeline, and Wiki views
- **Drag & Drop** — Kanban DnD for status changes, backlog DnD for bolt assignment
- **Artifact Wiki** — Markdown/JSON/YAML document management with version history
- **Ticket Numbers** — Human-readable IDs (LAT-1, LAT-2) alongside internal ULIDs
- **Hook Integration** — Auto-injects project context into every Claude Code session
- **Step Enforcement** — Blocks work unless a step is registered (PreToolUse hook)
- **Run Tracking** — Automatic execution logging per agent/session
- **Light/Dark Theme** — Theme toggle with persistent preference

## Architecture

```
Claude Code ──(hooks)──→ latticed (Node.js daemon)
           ──(CLI/Bash)─→ lattice (Rust binary)
                              │
                              ▼
                     ~/.local/share/lattice/db.sqlite

Web Dashboard (React) ──→ latticed HTTP API
```

- **lattice** — Rust CLI (~10ms cold start). Single binary for all operations.
- **latticed** — Node.js + Hono HTTP daemon. Runs in the background over Unix socket + TCP.
- **Hooks** — SessionStart auto-starts the daemon and injects project context. PreToolUse enforces step registration. PostToolUse records file changes. Stop hook finalizes runs.
- **Skills** — `/lattice` skill provides command reference for the LLM.

## Installation

```bash
claude plugin install Seungwoo321/lattice
```

The plugin's setup hook will automatically install the CLI binary and daemon on first use.

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 20+
- Rust toolchain (for building CLI from source, or use prebuilt binary)

## Entity Hierarchy

```
Project → Plan → Phase → Step
                   │       ├── Artifact (documents, decisions, wireframes)
                   │       ├── Run (execution log per agent/session)
                   │       ├── StepComment (discussion)
                   │       ├── depends_on (step dependencies)
                   │       └── parent_step_id (unlimited nesting)
                   │
                   └── Bolt (sprint/iteration cycle)
```

| Entity | Purpose |
|--------|---------|
| **Project** | Logical project identity, maps to 1+ working directories |
| **Plan** | High-level plan (imported from Claude Code plan mode) |
| **Phase** | Milestone grouping of steps, supports approval gates |
| **Step** | Atomic work unit — the "ticket" with priority, complexity, ticket_number |
| **Bolt** | Sprint/iteration cycle — groups steps into time-boxed work |
| **Artifact** | Deliverable attached to step/phase/plan (markdown, YAML, JSON) with versioning |
| **Run** | Execution record — which agent worked on which step, when |
| **Question** | Decision point — asked by LLM or human, answered asynchronously |
| **StepComment** | Discussion thread on a step |

## Hooks

Lattice installs the following Claude Code hooks:

| Hook | Trigger | Purpose |
|------|---------|---------|
| **SessionStart** | Session begin | Start daemon, inject dashboard context + rules |
| **UserPromptSubmit** | Each user message | Inject active step context, warn if no active steps |
| **PreToolUse** | Before Agent/Edit/Write/Bash | Block work if no active step registered |
| **PostToolUse** | After Edit/Write | Record file modifications to active run |
| **Stop** | Session end | Finalize active runs |

## Quick Start

```bash
# Check daemon status
lattice daemon status

# View project dashboard
lattice dashboard --cwd .

# Dashboard with filter
lattice dashboard --cwd . --show active   # active steps only
lattice dashboard --cwd . --show all      # full view

# List steps
lattice step list --phase-id PHASE-xxx

# Update step status
lattice step update STEP-xxx --status in_progress

# Search across steps
lattice step search "migration"

# Create a new step
lattice step new "Fix auth bug" --phase PHASE-xxx --assignee main --body "Description"

# Append to step body
lattice step append-body STEP-xxx --text "Additional notes"

# Track execution
lattice run start --step STEP-xxx --agent my-agent
lattice run finish RUN-xxx --result success --notes "Done"

# Bolt (sprint) management
lattice bolt list --project-id PROJ-xxx
lattice bolt new "Sprint 1" --project PROJ-xxx
lattice bolt update BOLT-xxx --status active
```

## Web Dashboard

The web dashboard provides 6 views:

| View | Description |
|------|-------------|
| **Summary** | Project overview with progress, active agents, phase status |
| **Plans** | Tree view with inline editing, bulk actions, checkbox selection |
| **Board** | Kanban board with drag-and-drop status changes |
| **Backlog** | Bolt-grouped backlog with drag-and-drop assignment |
| **Timeline** | Chronological/agent/phase-grouped activity with gantt bars |
| **Wiki** | Artifact browser with markdown/JSON/YAML rendering and version history |

Access the dashboard at `http://localhost:<port>` when the daemon is running.

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

## Design Principles

1. **Dual-consumer storage** — One store, two views. LLM reads via CLI, humans read via web dashboard. LLM never drives web DOM.
2. **Structured format only** — JSON/YAML/Markdown frontmatter. No LLM summaries on write path. No vector DB.
3. **State layer** — Storage + API only. No business logic. Harness logic stays in Claude Code.
4. **Isolation by step** — Sub-agent delegation unit is step, not session.
5. **Cache-first** — Step body is append-only. Volatile fields (status, assignee) at tail to preserve prompt cache prefix.
6. **No auto-injection** — New sessions start clean. Past context only via explicit query.

## Data Storage (XDG)

| Path | Purpose |
|------|---------|
| `~/.local/share/lattice/` | SQLite database |
| `~/.cache/lattice/` | Socket, PID, port files |
| `~/.config/lattice/` | Configuration |
| `~/.local/state/lattice/` | Logs |

All paths can be overridden via `LATTICE_{DATA,CACHE,CONFIG,STATE}_DIR` environment variables.

## Development

The source code is in a separate private repository ([lattice-dev](https://github.com/Seungwoo321/lattice-dev)).

## License

MIT
