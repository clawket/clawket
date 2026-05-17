# Contributing to Clawket

> *Decompose, contract, execute — the structured agent loop.*

Every contribution to Clawket — code, docs, plans, even bug reports — moves through these three steps in this order. Get the order right and the rest of the rules in this document become self-evident; get it wrong and the system rejects the work at the hook layer before it ever lands.

## How Clawket works

### 1. Decompose

Break the work into a tree of tasks until every leaf is something an agent can finish in one breath. Clawket's `decomposition_policy` gates this — a parent task cannot enter `done` while any leaf is still `todo`. If you find yourself wanting to "just start writing code" before there's a tree, you're skipping this step.

Practically: open the active plan, walk the unit, identify the leaf you'll work on. If a leaf doesn't exist, create it.

### 2. Contract

Sign each leaf with a structured task contract — the 19-field execution envelope defined by the v11 plan. At minimum the contract must name `scope`, `deliverables`, `success_metric`, and `acceptance_criteria`. The contract is what the agent reads, what tests gate on, and what the timeline replays. One source of truth across plan / run / review.

Free-form prompts ("just add this feature") are *not* contracts. They lack a verifiable success metric and so they cannot be replayed or audited.

### 3. Execute

Only now do you run code. Clawket's `PreToolUse` hook hard-blocks any mutating tool (`Edit`, `Write`, `Bash`, `Agent`, `TeamCreate`, `SendMessage`) when no active task is set — that is, when steps 1 and 2 weren't completed. The block is not optional and there is no flag to skip it; the correct response to a block is *go back and finish the contract*.

When the work lands, mark the task `done`. The daemon cascades the unit / plan / cycle automatically.

## Repository layout

Clawket lives across seven independent GitHub repositories under the `@clawket` org:

| Repo | Role | Tagline (hero) |
|---|---|---|
| [`clawket/clawket`](https://github.com/clawket/clawket) | Plugin shell (this repo) | Structured task contracts for LLM coding agents. |
| [`clawket/cli`](https://github.com/clawket/cli) | Rust CLI + embedded MCP | same |
| [`clawket/daemon`](https://github.com/clawket/daemon) | Axum daemon + SQLite + sqlite-vec | same |
| [`clawket/web`](https://github.com/clawket/web) | React 19 dashboard | same |
| [`clawket/landing`](https://github.com/clawket/landing) | Public landing page | same |
| [`clawket/tap`](https://github.com/clawket/tap) | Homebrew formulas | same |
| [`clawket/evals`](https://github.com/clawket/evals) | Contract compliance evaluation pipeline | same |

The hero tagline is propagated verbatim across all seven repos; do not paraphrase it. The forbidden-language list (variants that lose meaning under compression) is recorded in the Clawket project's U1 decision knowledge — pull it via `clawket knowledge search "U1 Tagline decision"`.

A wrapper that pins all seven locally for development lives at `lattice-mono/clawket/` (not a git repo itself).

## Dev environment

Component-specific dev instructions live in each repo's README. Cross-cutting links:

- Plugin install (consumer-facing): `README.md` → "Install" section
- Compatibility matrix (which CLI/daemon/web combos are supported): `docs/COMPATIBILITY.md`
- Release order across the seven repos: `docs/RELEASING.md`
- Hook enforcement architecture (why PreToolUse blocks): `docs/HOOK_ENFORCEMENT.md`
- Path separation invariant (LM-8) — why user data is never under `~/.claude/plugins/`: `CLAUDE.md` "Path separation invariant"

## Submitting changes

1. **Active task first.** No code edits without an active Clawket task. `clawket dashboard --cwd .` shows the current state. If there's no task, create or activate one before touching files.
2. **One leaf, one PR.** A PR should close exactly one task or one tightly coupled set of leaf tasks. PRs that span units are a sign step 1 (decompose) was skipped.
3. **Link the task.** PR description must reference the task ticket (e.g., `Closes LM-128`).
4. **No commits without explicit instruction.** Claude Code agents must not commit autonomously. Humans drive `git commit`.

## See also

- [`docs/COMPATIBILITY.md`](COMPATIBILITY.md) — compat matrix across plugin / CLI / daemon / web
- [`docs/RELEASING.md`](RELEASING.md) — seven-repo release order
- [`docs/HOOK_ENFORCEMENT.md`](HOOK_ENFORCEMENT.md) — why `PreToolUse` hard-blocks unstructured starts
- v11 plan (envelope 19-field schema, decomposition policy) — pull live from the Clawket DB: `clawket plan show --key v11` (the wrapper checkout also keeps a snapshot at `lattice-mono/clawket/plans/v11-structured-task-contracts.md`)
