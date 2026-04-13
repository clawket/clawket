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
- **Bolt Auto-Complete** — Bolts automatically completed when all steps are done
- **Web Dashboard** — Summary, Plans, Board (Kanban), Backlog, Timeline, and Wiki views
- **Agent Swimlane Timeline** — Horizontal bar chart per agent showing concurrent work over time
- **Drag & Drop** — Kanban DnD for status changes, backlog DnD for bolt assignment
- **Inline Editing** — Double-click step titles/status in Plans view to edit directly
- **Project Settings** — Edit project name, description, and working directories from Summary view
- **Wiki with File Tree** — Folder-based tree navigation, auto-extracted headings as titles
- **Local RAG** — Artifact scope (rag/reference/archive), sqlite-vec embeddings, hybrid search
- **Artifact Versioning** — Auto-snapshot on content update, version history with restore
- **Vector Search** — FTS5 keyword + sqlite-vec semantic hybrid search
- **Ticket Numbers** — Human-readable IDs (LAT-1, LAT-2) alongside internal ULIDs
- **CLI Shortcuts** — `lattice s` (step), `lattice b` (bolt), `lattice d` (daemon), etc.
- **Auto-Inference** — `step new` auto-detects phase and bolt from current project
- **Hook Integration** — Auto-injects project context into every Claude Code session
- **Step Enforcement** — Blocks work unless a step is registered (PreToolUse hook)
- **Plan Mode Compatible** — Auto-imports plans on ExitPlanMode
- **Auto Status Sync** — Stop hook auto-completes Phases/Plans/Bolts when all steps are done
- **Token Optimization** — Done steps hidden, ticket numbers instead of ULIDs (-32% tokens)
- **Fixed Port** — Daemon runs on port 19400 (configurable via LATTICE_PORT)
- **Light/Dark Theme** — Theme toggle with persistent preference

## Installation

```bash
# 1. Add marketplace
/plugin marketplace add Seungwoo321/lattice

# 2. Install plugin
/plugin install lattice@Seungwoo321-lattice
```

Setup hook automatically installs daemon dependencies (`pnpm install`) on first use.

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 20+
- Rust toolchain (for building CLI from source, or use prebuilt binary in `bin/`)

## Architecture

```
Claude Code ──(hooks)──→ latticed (Node.js daemon)
           ──(CLI/Bash)─→ lattice (Rust binary)
                              │
                              ▼
                     ~/.local/share/lattice/db.sqlite

Web Dashboard (React) ──→ latticed HTTP API (static file serving)
```

## Project Structure

```
lattice/
├── cli/              # Rust CLI source
├── daemon/           # Node.js daemon source + migrations
│   ├── src/          # Server, repo, db, embeddings
│   └── web/          # Built React dashboard (plugin bundle, optional)
├── web/              # React dashboard source (dev only)
├── scripts/          # Hook scripts (.cjs)
├── hooks/            # hooks.json
├── skills/           # /lattice skill
├── prompts/          # rules.md (SessionStart injection)
├── bin/              # CLI binary (prebuilt)
├── screenshots/      # Dashboard screenshots
└── .claude-plugin/   # Plugin metadata
```

## Web Dashboard

Access at `http://localhost:19400` when daemon is running. 6 views:

| View | Description |
|------|-------------|
| **Summary** | Project overview with progress, active agents, phase status |
| **Plans** | Tree view with inline editing, bulk actions, checkbox selection |
| **Board** | Kanban board with drag-and-drop status changes |
| **Backlog** | Bolt-grouped backlog with drag-and-drop assignment |
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

Lattice enforces a structured workflow. Claude cannot start working until a project, plan, and step are registered. The PreToolUse hook blocks all mutating operations (Edit, Write, Bash, Agent) until an active step exists.

### First-time setup

Every new directory needs a project registered first:

```
You: "Register this as a new project"

→ Claude runs: lattice project new "my-project" --cwd "."
→ Project appears in the web dashboard sidebar
```

### Planning work

Lattice is the source of truth for plans — not Claude's Plan Mode files (`~/.claude/plans/`). This is by design: plans live in the Lattice database, not as local files that can become stale or get polluted. Claude proposes plans in the conversation context, and after approval, registers them directly via CLI.

**Normal mode:**

```
You: "Plan the authentication refactor"

→ Claude analyzes the codebase and proposes a plan in chat
→ You review and approve
→ Claude registers via CLI:
  lattice plan new --project PROJ-xxx "Auth Refactor"
  lattice phase new --plan PLAN-xxx "Phase 1 — OAuth Setup"
  lattice bolt new --project PROJ-xxx "Sprint 1"
  lattice step new "Implement OAuth flow" --phase PHASE-xxx --bolt BOLT-xxx --assignee main
```

**Plan mode (`/plan`):**

```
You: /plan
You: "Plan the authentication refactor"

→ Claude proposes the plan as conversation context (Write is blocked by hooks)
→ You approve via ExitPlanMode
→ Claude registers the approved plan in Lattice via CLI
```

### Working on tasks

```
You: "Fix the login bug on the settings page"

→ Claude registers a step under an existing plan/phase/bolt
→ Sets it to in_progress, works on it, marks it done
  (PreToolUse hook blocks work until a step exists)
```

### Checking progress

```
You: "What's the current status?"

→ Claude reads the dashboard (injected once at SessionStart)
→ Shows active steps, bolt progress, blocked items
```

### Managing bolts (sprints)

```
You: "Start a new sprint for the API work"

→ Claude creates a bolt, assigns steps, activates it
→ Board view shows the sprint's kanban
```

### Reviewing in the web dashboard

Open `http://localhost:19400` to see:
- **Board** — Kanban view of current sprint
- **Backlog** — All bolts with drag-and-drop assignment
- **Timeline** — Agent swimlane showing who did what and when
- **Wiki** — Project documents and artifacts

### Key concepts

| Concept | Description |
|---------|-------------|
| **Project** | A working directory registered with Lattice |
| **Plan** | High-level intent (roadmap). Created via CLI, not Plan Mode files |
| **Phase** | Epic-level grouping within a plan |
| **Bolt** | Sprint — time-boxed iteration cycle |
| **Step** | Atomic task unit. Must exist before any work can start |

### Disabling Lattice for a project

You can temporarily disable Lattice management for a project without losing data. In the web dashboard, go to **Project Settings** and toggle **Lattice Management** off.

When disabled:
- Hooks treat the directory as if no project is registered — Claude works without constraints
- All existing data (plans, steps, runs) is preserved
- Toggle it back on anytime to resume structured workflow

This is useful when you want to use Claude freely for exploration or quick fixes without registering steps.

### Auto state transitions

- **Phase/Plan activate** automatically when a step becomes `in_progress`
- **Phase/Plan complete** automatically when all steps reach terminal status (`done`, `cancelled`, `superseded`)
- **Bolt** status is managed manually (`active` / `completed`)

### Prompt tips

| What you want | What to say |
|---------------|-------------|
| Register project | "Register this directory as a new project" |
| Plan work | "Plan the feature X — propose a plan and register it in Lattice" |
| Create a task | "Register a step for X and start working" |
| Check status | "Show me the current bolt progress" |
| Review work | "What was done in the last sprint?" |
| Search docs | "Search the wiki for authentication design" |
| Finish up | "Mark the current step as done" |

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
