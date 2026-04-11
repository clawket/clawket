[한국어](README.ko.md)

# Lattice

LLM-native work management plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Lattice is a structured state layer that replaces Jira + Confluence for LLM-driven development. It persists project plans, phases, steps, artifacts, and execution history across sessions via a local SQLite database and a lightweight daemon.

## Architecture

```
Claude Code ──(hooks)──→ latticed (Node.js daemon)
           ──(CLI/Bash)─→ lattice (Rust binary)
                              │
                              ▼
                     ~/.local/share/lattice/db.sqlite
```

- **lattice** — Rust CLI (~10ms cold start). Single binary for all operations.
- **latticed** — Node.js + Hono HTTP daemon. Runs in the background over Unix socket + TCP.
- **Hooks** — SessionStart auto-starts the daemon and injects project context.
- **Skills** — `/lattice` skill provides command reference for the LLM.

## Installation

```bash
claude plugins install Seungwoo321/lattice
```

The plugin's Setup hook will automatically install the CLI binary and daemon on first use.

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 20+
- Rust toolchain (for building CLI from source, or use prebuilt binary)

## Entity Hierarchy

```
Project → Plan → Phase → Step
                          ├── Artifact (documents, decisions, wireframes)
                          ├── Run (execution log per agent/session)
                          └── depends_on (step dependencies)
```

| Entity | Purpose |
|--------|---------|
| **Project** | Logical project identity, maps to 1+ working directories |
| **Plan** | High-level plan (imported from Claude Code plan mode) |
| **Phase** | Milestone grouping of steps, supports approval gates |
| **Step** | Atomic work unit — the "ticket" |
| **Artifact** | Deliverable attached to step/phase/plan (markdown, YAML, JSON) |
| **Run** | Execution record — which agent worked on which step, when |
| **Question** | Decision point — asked by LLM or human, answered asynchronously |

## Quick Start

```bash
# Check daemon status
lattice daemon status

# View project dashboard
lattice dashboard --cwd .

# List steps
lattice step list --phase-id PHASE-xxx

# Update step status
lattice step update STEP-xxx --status in_progress

# Search across steps
lattice step search "migration"

# Create a new step
lattice step new "Fix auth bug" --phase PHASE-xxx --body "Description here"

# Track execution
lattice run start --step STEP-xxx --agent my-agent
lattice run finish RUN-xxx --result success --notes "Done"
```

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
