[한국어](README.ko.md)

<p align="center">
  <img src="assets/main.png" width="600" alt="Clawket — LLM-native work management" />
</p>

<p align="center">LLM-native work management with local RAG and adapter-based runtimes for Claude Code and Codex</p>

Clawket is a structured state layer that replaces Jira + Confluence for LLM-driven development. It persists project plans, units, tasks, artifacts, and execution history across sessions via a local SQLite database and a lightweight daemon. Hook-based guardrails ensure the agent never works without a registered task — every action is tracked, every session has context.

On top of the state layer, Clawket ships a **local RAG stack** (sqlite-vec + on-device embeddings) and an **MCP stdio server** that lets Claude Code pull semantic context across sessions without shipping anything to an external vector DB.

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
- **Runtime Adapters** — Shared core with Claude Code adapter (primary) and Codex CLI adapter
- **Lifecycle Hooks** — Claude adapter keeps 10 hooks across 9 event types
- **Web Dashboard** — Summary, Plans, Board (Kanban), Backlog, Timeline, Wiki — 6 views
- **Agent Swimlane Timeline** — Per-agent horizontal bar chart with concurrent work visualization
- **Drag & Drop** — Kanban DnD for status changes, backlog DnD for cycle assignment
- **Wiki + Local RAG** — File-tree navigation, artifact versioning, hybrid search (FTS5 keyword + sqlite-vec semantic) over `scope=rag` artifacts
- **Auto-Embedding** — `scope=rag` artifacts and all tasks are embedded on create/update using on-device `all-MiniLM-L6-v2` (384d). Missing embeddings are backfilled at daemon startup.
- **MCP RAG Pull** — A separate stdio server (`clawket mcp`) exposes 5 read-only tools for Claude Code's tool_use, enforcing the `rag`-only scope boundary.
- **Hook Guardrails** — Blocks work without active task, injects project context per session
- **Ticket Numbers** — Human-readable IDs (CK-1, CK-2) with token-optimized output
- **CLI + Web** — Both LLM (CLI) and human (web UI) manage the same state

### Runtime Adapters

| Runtime | Integration model | Status |
|------|---------|-------------|
| **Claude Code** | Plugin + lifecycle hooks + skills + MCP stdio | Full support |
| **Codex CLI** | User-installed plugin hooks + optional wrapper launcher | Session context + PreToolUse guardrails |

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
| CLI | Rust (~10ms cold start), single static binary |
| Daemon | Node.js + Hono (Unix socket + TCP), better-sqlite3 |
| Storage | SQLite + sqlite-vec (vec0 virtual tables) |
| Embeddings | `@xenova/transformers` with `all-MiniLM-L6-v2` (384d, on-device, ~23MB first-run download) |
| MCP | `@modelcontextprotocol/sdk` stdio server, separate process |
| Web | React 19 + Vite + Tailwind + dnd-kit |
| Adapters | Claude (plugin + hooks + skills + `.mcp.json`) and Codex (plugin + hooks + optional wrapper) |

## Installation

```bash
# 1. Add marketplace
/plugin marketplace add Seungwoo321/clawket

# 2. Install plugin
/plugin install clawket@Seungwoo321-clawket
```

The setup hook installs daemon dependencies (`pnpm install`) and downloads the embedding model on first use. The MCP stdio server is registered automatically through the plugin's `.mcp.json`.

### Codex setup

Codex adapter activation is user-level — the repo-local marketplace is not enough by itself.

```bash
clawket codex install       # register repo-local marketplace in ~/.codex/config.toml
clawket codex uninstall     # remove it
clawket codex status        # check adapter health
```

Plain `codex` sessions then discover the Clawket plugin through the user's Codex config.

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 20+
- Rust toolchain (only needed to build the CLI from source — a prebuilt binary ships in `bin/`)

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

Clawket ships an MCP stdio server (`@clawket/mcp`) so Claude Code can **pull** context on demand (complementing SessionStart's push injection). It is a separate process, not part of the daemon — it auto-discovers the daemon's port from `~/.cache/clawket/clawketd.port` and calls the daemon's HTTP API. The plugin's `.mcp.json` registers `clawket mcp` as the stdio command.

| Tool | Purpose |
|------|---------|
| `clawket_search_artifacts` | Semantic/keyword/hybrid search over `scope=rag` artifacts |
| `clawket_search_tasks` | Semantic/keyword/hybrid search over tasks |
| `clawket_find_similar_tasks` | KNN neighbors of a seed task, with decisions/issues extracted from comments |
| `clawket_get_task_context` | Task + related artifacts / relations / comments / activity history |
| `clawket_get_recent_decisions` | `type=decision, scope=rag` artifacts in reverse chronological order |

Run manually: `clawket mcp` (stdio). Override dev path: `CLAWKET_MCP_PATH=/path/to/mcp/dist/index.js clawket mcp`.

**Scope boundary**: `archive` and `reference` artifacts are never returned — only `rag`-scoped knowledge is exposed to the LLM.

## Architecture

```
Claude Code
  ├─ plugin hooks ──────────────┐
  └─ .mcp.json → stdio child ─┐ │
                              │ │
                              ▼ ▼
                         @clawket/mcp (stdio server)
                              │ (HTTP, port auto-discovery)
                              ▼
Codex plugin/wrapper hooks ─▶ clawketd (Node.js + Hono)
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

```
clawket/
├── cli/                     # Rust CLI source + runtime launchers
├── daemon/                  # Node.js daemon (Hono) — HTTP API, RAG, sqlite-vec
│   └── src/                 # server.js, repo.js, db.js, embeddings.js
├── mcp/                     # @clawket/mcp — separate stdio server (pre-built in dist/)
├── web/                     # React 19 dashboard source (built output consumed by daemon)
├── adapters/
│   ├── shared/              # Shared runtime helper logic
│   ├── claude/              # Claude adapter entrypoints (10 hook .cjs handlers)
│   └── codex/               # Codex adapter (hook handlers + docs)
├── hooks/hooks.json         # Claude hook routing manifest
├── skills/clawket/          # /clawket skill (SKILL.md)
├── plugins/clawket/         # Repo-local Codex plugin (hooks + manifest)
├── .agents/plugins/         # Codex marketplace manifest (user-level registration target)
├── .claude-plugin/          # Claude plugin manifest + marketplace metadata
├── .mcp.json                # Registers `clawket mcp` as stdio server for Claude Code
├── scripts/                 # Compatibility shims for Claude hooks
├── prompts/                 # Shared + runtime-specific prompt fragments
├── bin/                     # Prebuilt CLI binary (Rust release)
├── assets/                  # Logo, mascot, branding
└── screenshots/             # Dashboard screenshots
```

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

### Runtime commands

```bash
clawket runtime list
clawket runtime doctor claude
clawket runtime doctor codex
clawket codex install
clawket codex uninstall
clawket codex status
clawket codex           # optional wrapper-launched Codex session
clawket codex stop
```

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

```bash
# Daemon
cd daemon && pnpm install && node src/index.js

# MCP (separate package)
cd mcp && pnpm install && pnpm build

# Web dashboard
cd web && pnpm install && pnpm dev

# CLI
cd cli && cargo build --release
```

## License

MIT
