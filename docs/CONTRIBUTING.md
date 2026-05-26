# Contributing to Clawket

> *Decompose, contract, execute — the structured agent loop.*

Every contribution to Clawket — code, docs, plans, even bug reports — moves through these three steps in this order. Get the order right and the rest of the rules in this document become self-evident; get it wrong and the system rejects the work at the hook layer before it ever lands.

## How Clawket works

### 1. Decompose

Break the work into Plans → Units → Tasks until every task is something an agent can finish in one breath. In v3, Plans hold the approved intent, Units are pure grouping (no status, no approval), and Tasks are the only entity worked directly. If you find yourself wanting to "just start writing code" before there's a tree, you're skipping this step.

Practically: open the active plan, walk the unit, identify the task you'll work on. If a task doesn't exist, create it under an existing unit (or create the unit first).

### 2. Contract

Sign each task with a structured execution envelope. The v3 envelope requires three fields at minimum: `intent` (what the task is for), `prompt_template` (how an agent should approach it), and `success_criteria` (the verifiable Done condition). The envelope is what the agent reads, what tests gate on, and what the timeline replays. One source of truth across plan / run / review.

Free-form prompts ("just add this feature") are *not* contracts. They lack a verifiable success criterion and so they cannot be replayed or audited. The daemon's envelope validator also rejects high-entropy values (looks like a secret) — keep envelope text short and human-readable.

### 3. Execute

Only now do you run code. Clawket's `PreToolUse` hook hard-blocks any mutating tool (`Edit`, `Write`, `Bash`, `Agent`, `TeamCreate`, `SendMessage`) when no active task is set — that is, when steps 1 and 2 weren't completed. The block is not optional and there is no flag to skip it; the correct response to a block is *go back and finish the contract*.

When the work lands, mark the task `done` with `--evidence` (the daemon enforces `EVIDENCE_REQUIRED` as HTTP 400). The daemon cascades the unit / cycle / plan automatically.

## Repository layout

Clawket lives across six active GitHub repositories under the `@clawket` org:

| Repo | Role | Notes |
|---|---|---|
| [`clawket/clawket`](https://github.com/clawket/clawket) | Plugin shell (this repo) | Hooks, install gate, skills, `components.json` SSoT |
| [`clawket/cli`](https://github.com/clawket/cli) | Rust CLI + embedded MCP | `clawket` binary with `clawket mcp` (rmcp 1.5 stdio) |
| [`clawket/daemon`](https://github.com/clawket/daemon) | Rust daemon | axum + rusqlite + sqlite-vec; owns user data under XDG |
| [`clawket/web`](https://github.com/clawket/web) | React 19 dashboard | Vite + Tailwind + dnd-kit |
| [`clawket/desktop`](https://github.com/clawket/desktop) | Tauri 2 desktop app | `null`-pinned in `components.json` until first release |
| [`clawket/landing`](https://github.com/clawket/landing) | Public landing + docs site | Vite + React Router; deployed on Vercel |

The hero tagline is propagated verbatim across all repos; do not paraphrase it. The forbidden-language list (variants that lose meaning under compression) is recorded in the Clawket project's tagline decision knowledge — pull it via `clawket_search_knowledge` (MCP) or `clawket knowledge search "Tagline decision"`.

A wrapper that pins all sub-repos locally for development lives at `~/dev/repository/github/clawket/` (not a git repo itself; sub-repo paths are described in the wrapper's `CLAUDE.md`).

## Dev environment

Component-specific dev instructions live in each repo's README. Cross-cutting links:

- Plugin install (consumer-facing): `README.md` → "Install" section
- Compatibility matrix (which CLI/daemon/web combos are supported): `docs/COMPATIBILITY.md`
- Release order across the six active repos: `docs/RELEASING.md`
- Hook enforcement architecture (why PreToolUse blocks): `docs/HOOK_ENFORCEMENT.md`
- Path separation invariant (LM-8) — why user data is never under `~/.claude/plugins/`: `CLAUDE.md` "경로 분리 invariant (LM-8)" section

## Submitting changes

1. **Active task first.** No code edits without an active Clawket task. `clawket dashboard --cwd .` shows the current state. If there's no task, create or activate one before touching files.
2. **One task, one PR.** A PR should close exactly one task or one tightly coupled set of tasks under the same unit. PRs that span units are a sign step 1 (decompose) was skipped.
3. **Link the task.** PR description must reference the task ticket (e.g., `Closes LM-128`).
4. **No commits without explicit instruction.** Claude Code agents must not commit autonomously. Humans drive `git commit`.

## See also

- [`docs/COMPATIBILITY.md`](COMPATIBILITY.md) — compat matrix across plugin / CLI / daemon / web / desktop
- [`docs/RELEASING.md`](RELEASING.md) — six-repo release order
- [`docs/HOOK_ENFORCEMENT.md`](HOOK_ENFORCEMENT.md) — why `PreToolUse` hard-blocks unstructured starts
- [`docs/i18n-policy.md`](i18n-policy.md) — bilingual docs + 20-locale landing dictionary policy
