[한국어](README.ko.md)

<p align="center">
  <img src="assets/main.png" width="600" alt="Clawket — LLM-native work management" />
</p>

<p align="center">LLM-native work management with local RAG for Claude Code</p>

Clawket is a structured state layer that replaces Jira + Confluence for LLM-driven development. It persists project plans, units, tasks, artifacts, and execution history across sessions via a local SQLite database and a lightweight daemon. Hook-based guardrails ensure the agent never works without a registered task — every action is tracked, every session has context.

On top of the state layer, Clawket ships a **local RAG stack** (sqlite-vec + on-device embeddings) and an **MCP stdio server** (embedded in the CLI binary via rmcp 1.5) that lets Claude Code pull semantic context across sessions without shipping anything to an external vector DB.

## Why Clawket

Without structured state, Claude Code sessions are stateless:

- **Context vanishes** — Each session starts from scratch. "Where was I?" has no answer.
- **Work goes untracked** — No record of what the agent changed, when, or why.
- **Plans become stale** — Plan Mode files sit in `~/.claude/plans/` and rot.
- **Sub-agents are blind** — Parallel agents have no shared visibility into project state.
- **Past decisions vanish** — Previous design rationale can't be recalled by the next session.

Clawket fixes this with a persistent database, local vector RAG, an MCP pull interface, runtime adapters, and a web dashboard — all running locally.

## Features

- **Structured Workflow** — Project → Plan (approve) → Unit → Task → Cycle (activate)
- **Lifecycle Hooks** — 10 hooks across 9 event types
- **Web Dashboard** — Summary, Plans, Board (Kanban), Backlog, Timeline, Wiki — 6 views
- **Agent Swimlane Timeline** — Per-agent horizontal bar chart with concurrent work visualization
- **Drag & Drop** — Kanban DnD for status changes, backlog DnD for cycle assignment
- **Wiki + Local RAG** — File-tree navigation, artifact versioning, hybrid search (FTS5 keyword + sqlite-vec semantic) over `scope=rag` artifacts
- **Auto-Embedding** — `scope=rag` artifacts and all tasks are embedded on create/update using on-device `all-MiniLM-L6-v2` (384d). Missing embeddings are backfilled at daemon startup.
- **MCP RAG Pull** — `clawket mcp` (stdio server embedded in the CLI binary) exposes 5 read-only tools for Claude Code's tool_use, enforcing the `rag`-only scope boundary.
- **Hook Guardrails** — Blocks work without active task, injects project context per session
- **Ticket Numbers** — Human-readable IDs (CK-1, CK-2) with token-optimized output
- **CLI + Web** — Both LLM (CLI) and human (web UI) manage the same state

### Claude Hooks

| Hook | Trigger | What it does |
|------|---------|-------------|
| **SessionStart** | New session (startup/clear/compact) | Ensures daemon is running, injects project dashboard + rules |
| **UserPromptSubmit** | Each prompt | Injects active task context, warns if no active task |
| **PreToolUse** | Edit/Write/Bash/Agent/TeamCreate/SendMessage | Blocks mutating tools unless an active task exists |
| **PostToolUse** | Edit/Write | Records file modifications to the active task |
| **PostToolUse** | ExitPlanMode | Prompts the agent to register Plan Mode output into Clawket |
| **SubagentStart** | Sub-agent spawned | Binds the agent to its assigned Clawket task |
| **SubagentStop** | Sub-agent finished | Appends result summary, auto-completes the task |
| **TaskCreated** | Team agent task created | Auto-starts matching todo task (todo → in_progress) |
| **TaskCompleted** | Team agent task completed | Auto-completes matching in_progress task (→ done) |
| **Stop** | Session end | Closes all active runs for the session |

When a task transitions to `done`/`cancelled`, the daemon auto-cascades completion to Unit, Plan, and Cycle if all their tasks are terminal.

### Stack

| Layer | Tech |
|---|---|
| CLI | Rust, single static binary (`clawket` / `clawket mcp`) |
| Daemon | Rust (axum + rusqlite), Unix socket + TCP |
| Storage | SQLite + sqlite-vec (vec0 virtual tables) |
| Embeddings | `candle-core` with `all-MiniLM-L6-v2` (384d, on-device) |
| MCP | `rmcp` 1.5 stdio server, embedded in the CLI binary |
| Web | React 19 + Vite + Tailwind + dnd-kit |
| Adapter | Claude Code plugin + hooks + skills + `.mcp.json` |

## Installation

```bash
# 1. Add marketplace
/plugin marketplace add Seungwoo321/clawket

# 2. Install plugin
/plugin install clawket@Seungwoo321-clawket
```

The setup hook downloads the prebuilt `clawket` CLI and `clawketd` daemon binaries from GitHub Releases. The embedding model is fetched on first use by the daemon. The MCP stdio server is registered automatically through the plugin's `.mcp.json` as `clawket mcp`.

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 20+ (setup hook only)
- Rust toolchain is **not** required — the plugin setup downloads prebuilt `clawket` + `clawketd` binaries. Build from source only if you want to develop the CLI or daemon.

## Local RAG

Clawket's RAG lives entirely inside the daemon. Nothing leaves your machine.

### What gets embedded

| Entity | Trigger | Source text |
|---|---|---|
| Task | On create and on any update; missing rows backfilled at daemon startup | `title\nbody` |
| Artifact | On create and on update **only when** `scope=rag` and `content` is present | `title\ncontent` |

`reference` and `archive` artifacts are never embedded and never exposed to the LLM.

### Vector storage

- `vec_tasks(task_id TEXT PRIMARY KEY, embedding float[384])`
- `vec_artifacts(artifact_id TEXT PRIMARY KEY, embedding float[384])`

Both are sqlite-vec `vec0` virtual tables. Updates use `DELETE` + `INSERT` because vec0 does not support `INSERT OR REPLACE`.

### Hybrid search

The daemon exposes HTTP endpoints for keyword (FTS5), semantic (KNN over vec0), and hybrid search over tasks and artifacts. The same endpoints are reused by the web Wiki, the CLI `search` subcommands, and the MCP server.

## MCP Server

Clawket ships an MCP stdio server so Claude Code can **pull** context on demand (complementing SessionStart's push injection). It is implemented in Rust via `rmcp` 1.5 and **embedded in the `clawket` CLI binary** — invoked as `clawket mcp` (stdio). It auto-discovers the daemon's port from `~/.cache/clawket/clawketd.port` and calls the daemon's HTTP API. The plugin's `.mcp.json` wires it into Claude Code.

| Tool | Purpose |
|------|---------|
| `clawket_search_artifacts` | Semantic/keyword/hybrid search over `scope=rag` artifacts |
| `clawket_search_tasks` | Semantic/keyword/hybrid search over tasks |
| `clawket_find_similar_tasks` | KNN neighbors of a seed task, with decisions/issues extracted from comments |
| `clawket_get_task_context` | Task + related artifacts / relations / comments / activity history |
| `clawket_get_recent_decisions` | `type=decision, scope=rag` artifacts in reverse chronological order |

Run manually: `clawket mcp` (stdio).

**Scope boundary**: `archive` and `reference` artifacts are never returned — only `rag`-scoped knowledge is exposed to the LLM.

> The legacy `@clawket/mcp` npm package (Node stdio server) is no longer registered in `.mcp.json` and will be archived in plugin v11 U4.

## Architecture

```
Claude Code
  ├─ plugin hooks ──────────────┐
  └─ .mcp.json → stdio child ─┐ │
                              │ │
                              ▼ ▼
                        clawket mcp (rmcp stdio, embedded in CLI)
                              │ (HTTP, port auto-discovery)
                              ▼
                         clawketd (Rust: axum + rusqlite)
                              │   ├─ Unix socket: ~/.cache/clawket/clawketd.sock
                              │   ├─ TCP: http://127.0.0.1:<port>
                              │   ├─ SSE event bus (/events)
                              │   ├─ Auto-embed on POST/PATCH (scope=rag)
                              │   └─ Startup backfill (missing vec_tasks)
                              ▼
                        SQLite + sqlite-vec
                      ~/.local/share/clawket/db.sqlite

Web Dashboard (React 19) ──────▶ clawketd HTTP API + SSE
```

### XDG paths

| Path | Purpose | Override |
|---|---|---|
| `~/.local/share/clawket/` | SQLite database | `CLAWKET_DATA_DIR` |
| `~/.cache/clawket/` | Unix socket, pid, port, runtime state | `CLAWKET_CACHE_DIR` |
| `~/.config/clawket/` | Configuration | `CLAWKET_CONFIG_DIR` |
| `~/.local/state/clawket/` | Logs | `CLAWKET_STATE_DIR` |

## Project Structure

Since **v2.3.0** this repo is a thin plugin shell — source code for cli/daemon/web
lives in sibling repos under the `clawket` GitHub org. Setup pulls compiled binaries
(`clawket`, `clawketd`) from GitHub Releases; no npm install happens at plugin
install time since **v2.3.2**.

```
clawket/
├── .claude-plugin/          # Claude plugin manifest + marketplace metadata
├── .mcp.json                # Registers `clawket mcp` as stdio server for Claude Code
├── hooks/hooks.json         # Claude hook routing manifest
├── skills/clawket/          # /clawket skill (SKILL.md)
├── prompts/                 # Shared + runtime-specific prompt fragments
├── adapters/
│   ├── shared/              # Shared runtime helper logic + setup downloader
│   └── claude/              # Claude adapter entrypoints (hook .cjs handlers)
├── scripts/                 # Compatibility shims for Claude hooks
├── docs/                    # COMPATIBILITY.md + RELEASING.md + HOOK_ENFORCEMENT.md
├── assets/                  # Logo, mascot, branding
├── screenshots/             # Dashboard screenshots
└── bin/                     # (created by setup) downloaded clawket CLI binary
```

### Separate repos

| Repo | Content | Consumed as |
|---|---|---|
| [`clawket/cli`](https://github.com/clawket/cli) | Rust CLI + embedded `clawket mcp` (rmcp 1.5) | GitHub Releases binary |
| [`clawket/daemon`](https://github.com/clawket/daemon) | Rust daemon (axum + rusqlite + sqlite-vec + candle-core) | GitHub Releases binary |
| [`clawket/web`](https://github.com/clawket/web) | React dashboard | GitHub Releases tarball |
| [`clawket/landing`](https://github.com/clawket/landing) | Public landing page | Cloudflare Pages |
| [`clawket/mcp`](https://github.com/clawket/mcp) | Legacy Node MCP server | **deprecated** — scheduled for archive in plugin v11 U4 |

See `docs/COMPATIBILITY.md` for version range guarantees.

## Web Dashboard

Access at `http://localhost:19400` when the daemon is running. Six views, real-time updates via SSE.

| View | Description |
|------|-------------|
| **Summary** | Project overview with progress, active agents, unit progress |
| **Plans** | Tree view with inline editing, bulk actions, checkbox selection |
| **Board** | Kanban board with drag-and-drop status changes |
| **Backlog** | Cycle-grouped backlog with drag-and-drop cycle assignment |
| **Timeline** | Agent swimlane (run bars per agent) + activity stream tab |
| **Wiki** | File-tree navigation, artifact CRUD with version history, FTS5 + semantic search, GFM tables |

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

Clawket enforces a structured workflow. The agent cannot start mutating work until a project, an active plan, and an active task all exist. The PreToolUse hook blocks all mutating tools (Edit, Write, Bash, Agent, TeamCreate, SendMessage) until an active task exists.

### First-time setup

Every new directory needs a project registered first:

```
You: "Register this as a new project"

→ Agent runs: clawket project create "my-project" --cwd "."
→ Project appears in the web dashboard sidebar
```

### Planning work

Clawket is the source of truth for plans — not Claude's Plan Mode files (`~/.claude/plans/`). Plans live in the Clawket database, not as local files that can become stale. The agent proposes plans in conversation, and after approval registers them via CLI.

**Normal mode:**

```
You: "Plan the authentication refactor"

→ Agent analyzes the codebase and proposes a plan in chat
→ You review and approve
→ Agent registers via CLI:
  clawket plan create --project PROJ-xxx "Auth Refactor"
  clawket plan approve PLAN-xxx
  clawket unit create --plan PLAN-xxx "Unit 1 — OAuth Setup"
  clawket task create "Implement OAuth flow"
  clawket cycle create --project PROJ-xxx "Sprint 1"
  clawket cycle activate CYC-xxx
  clawket task update TASK-xxx --cycle CYC-xxx
```

**Plan mode (`/plan`):**

```
You: /plan
You: "Plan the authentication refactor"

→ Agent proposes the plan as conversation context (Write is blocked by hooks)
→ You approve via ExitPlanMode
→ Agent registers the approved plan in Clawket via CLI
```

### Working on tasks

```
You: "Fix the login bug on the settings page"

→ Agent registers a task under an existing plan/unit/cycle
→ Sets it to in_progress, works on it, marks it done
  (PreToolUse hook blocks work until a task exists)
```

### Retrieving past context (MCP pull)

```
You: "Find any past decisions about auth retry policy"

→ Agent calls clawket_search_artifacts / clawket_get_recent_decisions
→ Returns only scope=rag artifacts with semantic relevance
```

### Reviewing in the web dashboard

Open `http://localhost:19400` to see Board (current sprint), Backlog, Timeline (agent swimlane), and Wiki (documents + artifacts).

### Key concepts

| Concept | Description |
|---------|-------------|
| **Project** | A working directory registered with Clawket |
| **Plan** | High-level intent (roadmap). Must be approved before tasks can start |
| **Unit** | Pure grouping entity (no status). Organizes tasks within a plan |
| **Task** | Atomic task unit. Can be created without a cycle (goes to backlog) |
| **Cycle** | Sprint — time-boxed iteration. Tasks must be assigned to an active cycle to start |
| **Artifact** | Attached document with versioning. `scope` ∈ {`rag`, `reference`, `archive`}. Only `rag` is embedded and exposed to LLM. |
| **Backlog** | Tasks without a cycle assignment. Drag to a cycle to schedule |

### State management

- **Plan**: `draft` → `active` (intentional approve) → `completed` (intentional end)
- **Unit**: No status — pure grouping
- **Cycle**: `planning` → `active` (intentional start) → `completed` (intentional end). Cannot be restarted.
- **Task**: `todo` → `in_progress` → `done`/`cancelled`. Requires active plan + active cycle to start. `blocked` is also valid.

### Disabling Clawket for a project

In the web dashboard, go to **Project Settings** and toggle **Clawket Management** off. Hooks then treat the directory as unregistered — the agent works without constraints, all existing data is preserved, and you can re-enable any time.

### Prompt tips

| What you want | What to say |
|---------------|-------------|
| Register project | "Register this directory as a new project" |
| Plan work | "Plan feature X — propose a plan and register it in Clawket" |
| Create a task | "Register a task for X and start working" |
| Check status | "Show me the current cycle progress" |
| Review work | "What was done in the last sprint?" |
| Search past decisions | "Search the wiki for authentication design decisions" |
| Finish up | "Mark the current task as done" |

## Development

Each component lives in its own repo under the `clawket` org.

```bash
# CLI (+ embedded MCP)
cd cli && cargo build --release
./target/release/clawket mcp    # run embedded MCP stdio locally

# Daemon
cd daemon && cargo build --release
./target/release/clawketd

# Web dashboard
cd web && pnpm install && pnpm dev
```

## License

MIT
