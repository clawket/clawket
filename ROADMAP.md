# Clawket Roadmap

Cross-repo milestone view for the `@clawket` GitHub organization. Each repo
(`clawket`, `cli`, `daemon`, `web`, `landing`, `tap`, `evals`)
ships independently — this document tracks the **shared milestones** that
those repos coordinate around.

For the day-to-day execution plan that drives this roadmap, see the
versioned plan documents under
[`plans/`](https://github.com/clawket/clawket/tree/main/plans). The plan
bodies inside Clawket itself (the local SQLite store under each user's
`~/.local/share/clawket/`) are the source of truth; the markdown snapshots
in `plans/` exist for newcomers who want to read the rationale without
running the daemon.

## Snapshot

| Version | Theme | Status |
|---|---|---|
| v7 | Multi-repo split (`cli`, `daemon`, `web`, `mcp`, `landing` separated from the original monorepo) | completed |
| v8 | Reproducibility layer (envelope groundwork, install/distribution polish) | superseded by v11 |
| v10 | XDG path policy + plugin/data separation invariant (LM-8) | completed |
| **v11** | **Structured Task Contracts** — execution envelope + tree decomposition + MCP execute + timeline replay | **active (draft, M5 in flight)** |
| v12 | Distributed orchestration — cross-host sync, remote-readable artifacts | planned |
| v13 | Multi-client polish — Cursor / Aider / Continue.dev parity for the embedded MCP server | planned |
| v14 | Agent governance — action budgets, audit trails, multi-tenant isolation | considering |

## Active milestones (v11)

v11 is split into nine milestones (M1–M7 + two web IA addenda). The cycle
breakdown lives in the plan body. Public-facing checkpoints:

| Milestone | Scope | What ships |
|---|---|---|
| M1 — Envelope core | `daemon`, `cli` | 19-field execution envelope as first-class task fields, migration 002, `clawket execute` |
| M2 — Tree decomposition | `daemon`, `cli` | `decomposition_policy`, `atomic_size_hint`, PreToolUse split enforcement, infinite-depth task trees |
| M3 — MCP integration | `cli` (absorbs `mcp`) | `clawket mcp` rmcp 1.5 stdio server with 5 read-only knowledge tools; `@clawket/mcp` npm deprecated |
| M4 — Web envelope + tree UI | `web` | Envelope editor, tree visualization, Timeline Replay |
| **M5 — Distribution & community** | **`landing`, `tap`, all repos** | **Homebrew tap, install.sh, Vercel landing, CONTRIBUTING/CODE_OF_CONDUCT/ROADMAP, label strategy, i18n drift guard, launch posts** |
| M6 — SessionStart redesign | `clawket`, `daemon` | Tree + vector + 4 metrics + p95 < 500 ms + degraded mode |
| M7 — Contract Compliance pipeline | `evals` (new repo) | Eval harness measuring how often a contract is enough for haiku to complete the task without escalation |
| Addendum A — Web IA tier 1 | `web` | Sidebar 3-tier, Cmd-K global search, dashboard flow redesign |
| Addendum B — Web IA tier 2 | `web`, `daemon` | Plan/Unit narrative model, virtualization, graph view, visual regression |

The current cycle (v11 M5 — community readiness) covers ROADMAP.md,
CODE_OF_CONDUCT.md, the per-repo `gh label` sync, the README.ko drift
guards, and the launch posts. Credential-gated launch tasks (HN / Reddit /
awesome-claude-code / GitHub issue rebuttal) are deferred to a follow-up
batch once write access is in place.

## v11 acceptance gates

- **Envelope adoption**: `>= 80%` of new tasks are created with all 19
  envelope fields populated (measured via `clawket task list --format
  json | envelope-coverage`).
- **Decomposition discipline**: tasks above `atomic_size_hint` cannot be
  started — PreToolUse hook hard-blocks until the task has children.
- **Reproducibility (side-effect)**: the M7 eval pipeline shows that the
  same envelope produces the same `verification_cmd` exit code across
  haiku / sonnet / opus on a 30-task fixture.
- **Distribution**: `brew install clawket/tap/clawket` and
  `curl -fsSL https://landing-seungwoo321s-projects.vercel.app/install.sh | sh` both yield a working
  daemon + CLI in a clean VM.

## Next 3 versions (preview)

These are tentative — they will be re-scoped after v11 ships.

### v12 — Distributed orchestration

**Why**: the local-first model breaks down when a single user runs Claude
Code on a laptop and an always-on agent on a workstation. Today they each
have a private SQLite — no shared task state.

**Likely shape**:
- Read-replica daemon mode: a designated host runs the writable daemon;
  others mount via signed HTTPS over Tailscale / Cloudflare Tunnel.
- Knowledge entries become globally addressable so RAG queries see all
  hosts' embeddings.
- New CLI subcommands: `clawket sync attach <url>`,
  `clawket sync status`.
- Explicit non-goal: multi-user authorization. Still single-user, just
  multi-host.

### v13 — Multi-client MCP polish

**Why**: the MCP stdio server already works in Cursor / Aider /
Continue.dev (anywhere with an `.mcp.json` slot), but the prompts, error
shapes, and progress streaming were tuned for Claude Code only.

**Likely shape**:
- Per-client capability negotiation via the MCP `initialize` handshake.
- Streaming progress events for long-running `clawket_search_*` calls
  (sub-second time-to-first-result).
- Recipes / templates that ship with the plugin so non-Claude clients get
  a working `.mcp.json` snippet without copy-pasting from docs.

### v14 — Agent governance (under consideration)

**Why**: as agent fleets grow (10+ parallel team agents), accidental
work-stealing and runaway turn budgets become real risks. Today the only
safeguard is the per-task `max_turns` field; there is no fleet-level
budget or audit.

**Likely shape**:
- Fleet-wide action budgets (turns / tokens / external calls per cycle).
- Audit trail with redacted prompts, persisted alongside `runs`.
- Multi-tenant isolation — separate SQLite databases per tenant, single
  daemon process. (Still **not** multi-user authorization; this is for
  isolating side projects from each other.)

The shape of v14 is intentionally fuzzy — it depends on what real fleets
break first.

## Backlog ideas (not scheduled)

These came up during v8 / v11 discussion and are worth keeping visible.
None are scheduled until a use case forces the decision.

- **Forward-only schema migrations as ADRs** — every `migrations/NNN.sql`
  links to an ADR explaining why no rollback exists (partial groundwork
  in `daemon/docs/adr`).
- **`clawket plan export`** — single-file plan dump for review / archive,
  separate from the `plans/` markdown snapshots (currently planned in
  v11 U5, may move to v12 if cross-host sync changes the format).
- **Web `Cmd-K` deep-link mode** — paste a `LM-NNN` ticket and jump
  straight to the task detail panel from any page (planned in Addendum A,
  may slip).
- **Hook authoring SDK** — third-party Claude Code plugins reuse
  `adapters/shared/claude-hooks.cjs` install gate semantics. Currently a
  single file inside this repo; would need extraction + versioning.
- **Self-hosted embeddings model swap** — swap `paraphrase-multilingual-MiniLM-L12-v2` for a
  larger model when `CLAWKET_EMBED_MODEL` is set. Requires the daemon to
  re-embed all existing tasks lazily.
- **Automatic task envelope linting** — daemon-side linter that flags a
  task as `low-contract-quality` when key envelope fields (`success_criteria`,
  `verification_cmd`, `rollback_plan`) are empty.

## How this document gets updated

- **Milestone table** is updated when a v-cycle starts or ends, by the
  cycle owner.
- **Backlog ideas** are append-only — items move to a v-cycle table when
  they are scheduled. They are never silently deleted; an idea that is
  rejected gets a `(declined: <reason>)` suffix and stays.
- **Next-3-versions** is rewritten end-to-end at the start of each
  v-cycle. The previous text is preserved in `git log`.

The ground truth for in-flight work is always Clawket itself
(`clawket dashboard`, `clawket plan list`); this markdown is a
human-readable index, not a tracker.
