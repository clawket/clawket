# Migrating from Clawket v2.3.x to v3.0

Clawket v3 is a coordinated breaking release across all components: plugin shell (`clawket-plugin`), CLI (`@clawket/cli`), daemon (`@clawket/daemon`), and web dashboard (`@clawket/web`). This guide covers the data, API, command, and hook contract changes — and the manual steps required to migrate an existing v2 installation.

> **Read first.** The daemon performs an automatic schema migration on its first v3 start. Once the migration runs, you cannot downgrade to v2.x with the same database. Back up `~/.local/share/clawket/db.sqlite` before upgrading.

## At a glance

| Layer | Breaking changes | Rollback path |
|---|---|---|
| Schema | 9 new migrations (011–019): `tasks.tier`, `cycles.unit_id NOT NULL`, drop `units.status`/`units.approval_*`, `qa_*` task fields, wiki tree, `audit_log`, scope reclassify, audit chain hash, project_cwds UNIQUE | Restore from pre-upgrade DB backup |
| Daemon API | ISO 8601 timestamps, `/plans/:id/counts`, single-active-plan 409, `scope=reference\|archive` writes rejected, sync embeddings, 3-score search | Pin v2 daemon binary |
| CLI | Removed `execute`, `task envelope`; removed 4 v11 MCP tools; added `completions` subcommand | Pin v2 CLI binary |
| Plugin shell | `schema_version: "v3"`, hooks added/removed, `/clawket` skill split into 7 sub-flows, locale chain, tier-mismatch policy gate | Pin plugin v2.3.12 |
| Web | New header (health/theme/palette), reactive SSE state, scope=rag wiki default | Pin web v2 bundle |
| Distribution | Canonical asset names, SHA256SUMS | n/a (additive on release infra) |

## Pre-flight checklist

1. Stop any running Claude Code session that has Clawket hooks active.
2. `clawket daemon stop` if the daemon is running.
3. `cp ~/.local/share/clawket/db.sqlite ~/.local/share/clawket/db.sqlite.v2-backup`
4. Optional: `clawket plan list --format json > ~/clawket-plans-v2.json` for a textual snapshot.
5. Update plugin to `3.0.0` (marketplace install or local link). Setup gate downloads matching v3 binaries.

The setup gate (`adapters/shared/claude-hooks.cjs::ensureInstalled`) will fail-closed if any required binary in `components.json` cannot be downloaded and SHA256-verified. There is no fallback to a partial install.

## Data layer

The daemon applies nine new migrations on first v3 start, in this order:

| Migration | Effect |
|---|---|
| `011_tier_column.sql` | `ALTER TABLE tasks ADD COLUMN tier TEXT CHECK(tier IN ('low','med','high'))` (nullable) |
| `012_cycles_unit_id.sql` | `ALTER TABLE cycles ADD COLUMN unit_id TEXT REFERENCES units(id)` + index. Existing cycles are bound to a synthetic "Default Unit" per plan; the migration logs a warning per orphaned cycle. PDD A4 / A8 enforcement starts at the daemon route layer. |
| `013_drop_unit_status_approval.sql` | Rebuilds `units` table without `status`, `approval_required`, `approved_at`, `approved_by`, `approver_note`, `last_status_at`. Unit becomes a pure grouping entity. |
| `014_qa_fields.sql` | `qa_status`, `scenario_id`, `defect_task`, `scenario_amendment` columns + indexes for QA workflow first-class tracking. |
| `015_wiki_tree.sql` | `wiki_idx`, `wiki_depth` columns on `artifacts` + BEFORE INSERT trigger guarding against self-parent and computing depth. |
| `016_audit_log.sql` | New `audit_log` table with `actor` and `op_type` enums. Existing rows in `activity_log` are migrated. `activity_log` is retained read-only for legacy rollup queries. |
| `017_artifact_scope_reclassify.sql` | Reclassifies legacy `scope=reference|archive` artifacts using a deterministic rule (legacy `archive` rows are dropped from `vec_artifacts`; `reference` rows that have a `task_id`/`unit_id`/`plan_id` parent are promoted to `rag`, others moved to a `legacy_archive` shadow table for one-shot review). |
| `018_audit_log_prev_hash.sql` | Adds `prev_hash TEXT` column + chain index to `audit_log`. Subsequent writes compute FNV-1a chain hash so audit-log tampering is detectable. |
| `019_project_cwd_unique.sql` | Recreates `project_cwds` with `UNIQUE(cwd)` constraint and de-duplicates existing rows by `(cwd)` taking earliest `created_at`. Prevents two projects from claiming the same working directory. |

Embeddings: the model changes from `all-MiniLM-L6-v2` (384-dim, English-biased) to `paraphrase-multilingual-MiniLM-L12-v2` (384-dim, 50+ languages). The vector dimension is unchanged so the `vec_knowledge` virtual table schema is preserved, but the embedding values are not comparable across versions. The daemon re-embeds a knowledge entry on its next read (lazy refresh) — no manual rebuild step is required.

### What you must adjust manually

- **Custom queries on `units.status`** — switch to `tasks` aggregation. The `/plans/:id/counts` endpoint returns per-unit task counts which is the supported replacement.
- **Custom queries on `cycles.unit_id IS NULL`** — those rows no longer exist after migration 012.
- **Reference / archive scope artifacts** — writes are rejected with `SCOPE_DEPRECATED`. Existing rows survive read-only. Migrate to `scope=rag` if they should remain LLM-visible; otherwise leave them and they are filtered out of all RAG endpoints.
- **`activity_log` writers** — must move to `audit_log`. The daemon's own writers have been migrated; only external scripts are at risk.

## Daemon API

### Timestamp format

Every timestamp field on every entity is now ISO 8601 (`2026-05-04T11:14:23.456Z`) instead of millisecond epoch. Fields affected: `created_at`, `updated_at`, `started_at`, `ended_at`, `last_activity_at`, `approved_at`, `last_status_at`, `embedded_at`, `audit_log.ts`. Both serialization (response) and deserialization (request body parsing) accept ISO 8601 only — millisecond integers are rejected with `INVALID_TIMESTAMP`.

### New endpoints

- `GET /plans/:id/counts` — returns `{ "plan_id": …, "total": N, "by_status": {…}, "units": [{ "unit_id": …, "total": N, "by_status": {…} }] }`. Replaces ad-hoc client-side aggregation.
- `GET /units/:id/counts` — returns `SingleUnitCounts` `{ "unit_id": …, "total": N, "by_status": {…} }`. Drill-down for a single unit.
- `GET /cycles/:id/counts` — returns `CycleCounts` `{ "cycle_id": …, "total": N, "by_status": {…} }`. Drill-down for a single cycle.
- `GET /knowledge/wiki/tree` — returns recursive wiki tree using SQLite recursive CTE. Respects `wiki_idx` ordering.
- `GET /audit` — read-only listing of audit-log entries with `actor` / `op_type` filters and ASC ordering. POST/PUT/DELETE/PATCH return 405 `AUDIT_IMMUTABLE`.
- `GET /events/replay` — finite SSE stream replaying audit-log entries from a given cursor for client recovery. Sends a `[DONE]` sentinel on completion.

### Modified contracts

- `POST /plans/:id/approve` and `PATCH /plans/:id` (`status=active`) — both check the single-active-plan invariant per project. A second active plan returns `409 Conflict` with `ALREADY_ACTIVE`. The previous active plan must be transitioned to `completed` or `draft` first.
- `POST /knowledge` and `PATCH /knowledge/:id` — reject `scope` values of `reference` or `archive` with `SCOPE_DEPRECATED`. Allowed values: `rag` only (with future expansion).
- `POST /knowledge` / `PATCH` — embedding generation is now synchronous. The HTTP response returns only after the embedding has been written to `vec_knowledge`. Latency increases by ~50–200 ms per write but RAG search consistency is now read-your-write.
- `GET /knowledge/search` — response now includes `bm25_score`, `vector_score`, `hybrid_score` per hit and `meta.truncated: bool` at top level. The `project_id` filter traverses `artifact → plan/unit/task → project`, so artifacts attached to a unit/task are correctly filtered.
- `PATCH /tasks/:id` — status transitions are wrapped in a single SQLite transaction: run lifecycle, audit log, and any cascading unit/plan completion are atomic. State-machine guards: `MISSING_CYCLE_ID` (400) when transitioning to `in_progress` without a cycle, `INVALID_TRANSITION` (400) for illegal transitions (e.g. `done → in_progress`), `BLOCKED_DEPENDENCIES` (409) when an upstream task is not yet done.
- `PATCH /plans/:id` (`status=completed`) — rejected with `INCOMPLETE_PLAN` if any task in the plan is not in `done|cancelled` or any cycle is not in `completed`.
- `POST /units/:id/approve` — **removed**. Units no longer have approval semantics.
- `unit.status` field — removed from all unit-shaped responses. Clients should not depend on it.
- `POST /projects` — returns `409 TICKET_KEY_CONFLICT` when the ticket key is already claimed and `409 CWD_ALREADY_REGISTERED` when the cwd is already bound to another project.
- `POST /runs` — returns `409 RUN_ALREADY_OPEN` when the parent task already has an in-flight run.
- `PATCH /comments/:id` — body update added.
- `DELETE /comments/:id` — soft-delete (prefixes the body with `[DELETED]` instead of removing the row). History is preserved.
- `POST /knowledge` (or `PATCH`) with `scope=reference|archive` — returns `400 INVALID_SCOPE` (was earlier named `SCOPE_DEPRECATED`; the canonical code in v3 final is `INVALID_SCOPE`).
- `GET /knowledge` — `scope=rag` is the default filter. Pass `?all_scopes=true` to include legacy `reference`/`archive` rows.

### Cycle ⊂ Unit (PDD A4) enforcement

`POST /cycles` requires `unit_id` (string ULID). Missing or empty → `400 MISSING_UNIT_ID`. Non-existent unit → `404 UNIT_NOT_FOUND`. The CLI's `clawket cycle create` reflects this with a required `--unit <UNIT>` flag (the older `--project` mode is retained for filtering only).

`PATCH /cycles/:id` (`status=active`) checks PDD A8 — a second active cycle in the same unit returns `409 UNIT_HAS_ACTIVE_CYCLE`. The previous cycle must be `completed` first; attempting to skip returns `409 PREVIOUS_CYCLE_OPEN`. Different units can have concurrent active cycles.

### TCP authentication (transport gate)

`/cycles`, `/tasks`, `/plans`, `/units`, `/knowledge`, `/audit`, `/events`, `/runs`, `/comments`, `/projects` over TCP require an `X-Clawket-Token: <token>` header. Missing or wrong token returns `401 AUTH_REQUIRED`. The token is generated on first start and stored mode-0600 at `~/.cache/clawket/clawketd.token`. Unix-socket clients are exempt (the socket is owner-only mode 0600). Set `CLAWKETD_TCP_AUTH=0` to opt out (development only).

### Audit log (immutable + chained)

Every mutation (status, title, body, priority, assignee, scope changes, plan/unit/cycle/task lifecycle) writes a row to `audit_log` with `prev_hash` linking to the previous entry's FNV-1a hash. Tampering is detectable by re-walking the chain. The route surface is read-only — only `GET /audit` is allowed; mutating verbs return `405 AUDIT_IMMUTABLE`. Existing `activity_log` rows are migrated on first start (migration 016).

## CLI

### Removed commands

| Removed | Replacement |
|---|---|
| `clawket execute <task>` | Use `clawket task update <id> --status in_progress` and run actual work in your editor. The execute envelope contract is retired. |
| `clawket task envelope <action>` | Removed entirely. The four sub-actions (`emit`, `validate`, `parse`, `dry-run`) had no callers after v11 migration. |

### New commands

- `clawket completions <shell>` — emits shell completion script (bash, zsh, fish, powershell). Powered by `clap_complete`. Replaces the manual completion files distributed in v2.
- `clawket timeline`, `clawket board`, `clawket wiki`, `clawket summary` — read-only views matching the web dashboard tabs.
- `clawket watch` — live-tail SSE events (filterable by entity type) for terminal users.
- `clawket replay --from <cursor>` — replays audit-log entries as text (companion to the daemon's `/events/replay` SSE endpoint).
- `clawket backup [--out <path>]`, `clawket restore <path>`, `clawket migrate` — explicit DB lifecycle helpers (the daemon already runs migrations on start, but `migrate` allows preflight).
- `clawket config get|set` — read/write a small client-side config (locale, daemon endpoint).
- `clawket update`, `clawket version-check` — checks GitHub Releases for newer plugin/binary versions.
- `clawket find-similar <task-id>`, `clawket get-task-context <id>`, `clawket get-recent-decisions` — terminal mirrors of the read-only MCP tools.
- `clawket daemon log [-f]` — tails `~/.local/state/clawket/clawketd.log`.
- Global flags `--no-color`, `--label <k=v>`, `--project <id>` are now accepted on all subcommands.

### Removed MCP tools

The CLI's embedded MCP server (`clawket mcp`) drops these v11-era tools that depended on the execute envelope:

- `execute_task`
- `walk_task_tree`
- `decompose_task`
- `validate_envelope`

The five remaining tools (`clawket_search_knowledge`, `clawket_search_tasks`, `clawket_find_similar_tasks`, `clawket_get_task_context`, `clawket_get_recent_decisions`) are unchanged and remain read-only.

### New flags

- `clawket task create --tier <low|med|high>` — explicit tier assignment. Optional; default behaves as before (no tier). Also surfaces on `clawket task update --tier <…>` to retag an existing task. Wire-format: `tier` appears on `POST /tasks` and `PATCH /tasks/{id}` JSON bodies (daemon migration `011_tier_column.sql` already accepts the column; v3.0 CLI just surfaces it).
- `clawket cycle create --unit <UNIT>` — required, see schema change.
- `clawket task create --scenario-id <ID> --qa-status <pending|pass|defect|scenario_error> --defect-task <TASK> --scenario-amendment <text>` — QA workflow first-class fields.
- **Global flags** — `clawket --locale <bcp47>` propagates to subcommands and the daemon via `CLAWKET_LOCALE` env; `clawket --tier <low|med|high>` is the default tier policy that subcommand `--tier` flags can override (env `CLAWKET_TIER`). Both are global (`global = true`) and visible in any subcommand's `--help`.

### Doctor sections

`clawket doctor` adds five new sections:

1. `[Tier distribution]` — reports the tier breakdown across active tasks (low / med / high / null).
2. `[Escalation rate]` — reports tier escalations in the last 7 days (G3 escalations from G2 etc.).
3. `[Plugin install]` — verifies binary paths under `~/.claude/plugins/clawket-*/` and SHA256 against `components.json` pins.
4. `[i18n]` — resolves the locale chain and reports the active locale (`en`, `ko`, `ja`).
5. `[Skills]` — lists installed skill files and verifies `/clawket` skill is intact.

The `[Path separation invariant (LM-8)]` section now checks **5 paths** (added `db` to data/cache/config/state) and exits non-zero on any overlap. There is no `--allow-overlap` flag.

`clawket doctor --json` emits machine-readable output. Output prefixes use `ERROR:` (uppercase) consistently; the legacy lowercase `error:` form is removed.

## Plugin shell (Claude Code adapter)

### `hooks/hooks.json`

- `schema_version: "v3"` (was `"v1"` implicitly).
- **Removed events**: `TaskCreated`, `TaskCompleted`, `Stop` — these were Claude Code event names that no longer exist or that we no longer hook.
- **Added top-level event**: `ExitPlanMode` — fires when the user transitions out of plan mode and the plan body is auto-synced to a Clawket Plan via `clawket plan create`.
- The `PreToolUse` matcher list adds `TaskCreate`, `TaskUpdate` (Claude Code internal task tools) so they go through the install gate. They are not blocked.

### `/clawket` skill

The single SKILL.md is restructured into 7 sub-flow sections (each invocable as `/clawket scenario`, `/clawket qa`, etc.):

1. `scenario` — scenario authoring loop per `scenario-authoring.md`
2. `qa` — code-reasoning QA round per `qa-flow.md`
3. `decompose` — Plan/Unit decomposition assistant per `pdd.md`
4. `retro` — round retrospective + audit log review
5. `start` — start the active task with PDD lifecycle gates
6. `done` — close the active task with done-criterion verification
7. `new` — register a fresh project

`allowed-tools: [Bash]` — the skill itself does not call file edit tools; the user's main agent handles that.

`schema_version: "v3"` is recorded in the skill front-matter for compatibility with future skill manifest validators.

### `adapters/shared/claude-hooks.cjs`

This is the canonical helper module shared by all hooks. v3 changes:

- **`withInstallLock()`** — wraps `ensureInstalled` with a `flock(2)`-style lock so concurrent Claude Code sessions cannot race the install.
- **`atomicCopyBin(src, dst)`** / **`atomicExtractDir(tarball, dst)`** — write to a temp path and rename atomically. Half-installed binaries can no longer be observed by readers.
- **`fetchSha256Sums(tag)` / `downloadAndVerify(url, sha256)`** — every binary is verified against the SHA256SUMS file published with each component release. A mismatch raises and aborts the install.
- **`runSetup` aggregate** — collects all setup-stage errors and throws a single aggregate at the end instead of fail-fast. Operators can see all gaps in one pass.
- **PDD lifecycle gates (3 new)** — `PreToolUse` rejects `Edit/Write/Bash` if (a) no active plan, (b) no active cycle in a plan-required scope, (c) tier mismatch on the active task. Tier mismatch exits with code `3` (Policy).
- **`runPlanSync()`** — auto-call `clawket plan create` from `ExitPlanMode` event. Plan body is the user's plan-mode output.
- **`runSubagentStart()`** — every subagent gets a child Clawket task auto-created, parented to the dispatcher's active task, with the subagent's prompt injected as the task body.

### Locale chain

`adapters/shared/locale.cjs` resolves locale via:

1. `process.env.CLAWKET_LOCALE` (explicit override)
2. `process.env.LC_ALL` parsed for language code
3. `process.env.LANG` parsed for language code
4. fallback `en`

Supported: `en`, `ko`, `ja`. Translation function `t(key, vars)` reads from `locales/<lc>.json` (12 keys per language).

### Destructive patterns

`adapters/shared/destructive-patterns.json` has:

- `reasons` is now a `{ en, ko, ja }` map per pattern.
- The keyword `CLAWKET_ALLOW_DESTRUCTIVE` no longer bypasses the gate — destructive patterns are blocked unconditionally. A separate `clawket policy override` workflow is planned for cases where the user genuinely needs to run a destructive command (e.g. test cleanup); until then, the user must run those commands outside Claude Code.

## Web dashboard

`@clawket/web` v3 ships a SPA bundle of 588 kB (gzipped 156 kB). It is served by the daemon at `http://localhost:19400` and consumed by the plugin's web view.

### New components

- `Header.tsx` — daemon health indicator (10 s polling with 3 s timeout), theme toggle (light/dark, persisted to `localStorage`), Cmd+K command palette trigger.
- `CommandPalette.tsx` — fuzzy search across plans / units / tasks / artifacts.
- `Toast.tsx` + `lib/toast.ts` — non-blocking notification system for SSE-pushed events.
- `useDaemonHealth.ts` — health polling hook returning `{ healthy, version, schema_version, latencyMs }`.
- `lib/theme.ts` — theme persistence + system-pref detection.

### Reactive state

`App.tsx` replaces the previous `setTreeKey` hack (which forced full subtree remount on every SSE event) with `sseReducer` — a typed reducer that applies SSE patches to a `taskPatches: Map<TaskId, TaskPatch>` prop threaded through `PlanTree`. Re-renders are now per-task, not per-tree.

### Wiki view

`WikiView.tsx`:

- Default scope filter is `rag` (was: all). The `archive` toggle re-enables the legacy view.
- Search filters by title / body / labels using debounced full-text scoring against the `/knowledge/search` endpoint.
- Markdown rendering uses `marked` + `highlight.js` for code-fence syntax highlighting.

### API client

`web/src/api.ts` adds:

- `getPlanCounts(planId): Promise<PlanCounts>` — calls the new endpoint.
- `UnitTaskCounts` type — matches `daemon::models::UnitCounts`.

## Distribution and release

- **Asset names** — every release uses canonical names: `clawket-darwin-x64`, `clawket-darwin-arm64`, `clawket-linux-x64`, `clawket-linux-arm64`, `clawket-windows-x64.exe` (and analogously for `clawketd`). The setup gate reads `components.json` for the tag, then downloads `<cmd>-<os>-<arch>{.exe}`.
- **SHA256SUMS** — every component release publishes a `SHA256SUMS` file alongside binaries. The plugin verifies download integrity against this file before accepting an install.
- **Web bundle** — `clawket-web-v<tag>.tar.gz` is published on the web repo's release page. The setup gate extracts it under `~/.claude/plugins/clawket-*/web/`.

## Privacy and telemetry

`clawket/clawket/PRIVACY.md` and the new "Privacy" / "Telemetry" sections in `README.md` and `README.ko.md` document:

- No network telemetry is ever emitted by the daemon, CLI, or plugin shell.
- The only outbound HTTP requests are: setup-time GitHub Releases downloads, and SHA256SUMS fetch.
- All work history is local-only in `~/.local/share/clawket/db.sqlite`.

## Vendor adapter (forward-looking)

`docs/VENDOR_POLICY.md` documents the tier semantics + routing rules for future agent vendor adapters. `components.json` includes a `vendor_adapter: null` placeholder which will be filled in when the first vendor adapter ships (probably v3.1).

## Known incompatibilities

These are NOT addressed by automatic migration. Operators must take explicit action:

1. **Custom shell completion files** — distributions (AUR, etc.) that ship pre-baked completion files for v2 will see them collide with `clawket completions` output. Drop the pre-baked files and let users run `clawket completions <shell>` from their dotfiles instead.
2. **CI scripts that call `clawket execute`** — must be rewritten to `clawket task update`.
3. **Hooks that read `unit.status`** — the field is no longer in responses; switch to `/plans/:id/counts`.
4. **External MCP clients that called `execute_task` etc.** — the four removed tools no longer appear in the `tools/list` response. The client error path should already handle "tool not found".
5. **Custom queries on `cycles.unit_id IS NULL`** — those rows no longer exist post-migration.
6. **Embeddings cache** — if you have an external `vec_knowledge` mirror, it must be discarded; the embedding values changed.

## Phase E — STABLE label transition and user-scope cleanup

The seven Clawket skills (`clawket-dashboard`, `clawket-plan-design`, `clawket-scenario-author`, `clawket-verify-batch`, `clawket-verify-loop`, `clawket-scenario-refine`, `clawket-defect-fix`) ship in v3 with `상태: STABLE — Clawket plugin 정본.` in every `RULE.md`. v2 sites that staged the same flows under `~/.claude/skills/` with `상태: EXPERIMENTAL` headers need a one-time, manually-gated cleanup so the plugin remains the single source of truth. Phase E is that cleanup. It is **not automatic** — the operator must consent before any file is removed.

### Pre-conditions

Run Phase E only after the five v3 readiness checks succeed for the project:

1. At least one full Plan lifecycle (`draft → active → completed`) has run on v3 without manual schema patches.
2. The last two verification rounds emitted `defect = 0` rows. (`clawket task list --status done --since <round-start>` shows defect tasks all closed.)
3. Every closed task carries `scenario_id` and `--evidence`. The daemon rejects `done` without `--evidence` (HTTP 400 `EVIDENCE_REQUIRED`); a sample query against `tasks` confirms 100 % coverage.
4. `scenario_error` rows occurred organically in at least one round and were dispositioned via `clawket-scenario-refine` (atomic split / intent redefinition / deletion).
5. `PreToolUse` hook enforcement is active (`hooks/hooks.json` matchers covering `Edit | Write | Bash | Agent | TeamCreate | SendMessage`) and the audit log contains at least one blocked call attributable to the active-task gate or the destructive-pattern guard.

If any check fails, do not run Phase E. The skills remain STABLE in the plugin regardless; only the user-scope cleanup is gated.

### Step 1 — STABLE label transition (informational)

v3 ships with `상태: STABLE — Clawket plugin 정본.` already set in every shipped `skills/<name>/RULE.md`. Operators upgrading from a hand-edited v2 install where the RULE.md was patched to `상태: EXPERIMENTAL` should let the v3 install gate replace the file (the file is part of the plugin tree under `~/.claude/plugins/clawket-*/skills/`, which `/plugin install` overwrites). No manual edit is required.

`tests/skills-integrity.test.cjs` enforces the STABLE label on every shipped `RULE.md` and rejects any reintroduction of `상태: EXPERIMENTAL`. A release tarball that ships with the experimental label fails the integrity test.

### Step 2 — Cleanup confirmation prompt

Before removing anything under `~/.claude/`, present the operator with this prompt verbatim and wait for an explicit response:

```
EXPERIMENTAL → STABLE promotion is complete in the plugin tree.
Proceed with user-scope cleanup of the v2 staging copies?
  - Remove ~/.claude/skills/{pdd-plan,scenario-author,qa-batch,discover-loop,scenario-refine}/
  - Replace ~/.claude/rules/{pdd,scenario-authoring,qa-flow}.md with one-line stubs
Proceed? [y/N]:
```

The default is `N` (skip). Only `y` / `yes` routes to Step 3. Any other input (empty, `n`, `no`, no response) routes to Step 4. Phase E is not run by autonomous sub-agents — the confirmation must come from an interactive session.

### Step 3 — Confirmed branch (response = `y`)

Once the plugin's STABLE skills are in place, the v2 staging copies under `~/.claude/` are duplicates of the plugin's canonical files. Run the following idempotent operations in order. Any step that finds the target already absent or already a stub is a no-op.

1. Remove `~/.claude/skills/pdd-plan/` recursively.
2. Remove `~/.claude/skills/scenario-author/` recursively.
3. Remove `~/.claude/skills/qa-batch/` recursively.
4. Remove `~/.claude/skills/discover-loop/` recursively.
5. Remove `~/.claude/skills/scenario-refine/` recursively.
6. Replace `~/.claude/rules/pdd.md` with the one-line stub:
   `# moved to plugin: clawket/skills/clawket-plan-design/RULE.md`
7. Replace `~/.claude/rules/scenario-authoring.md` with the one-line stub:
   `# moved to plugin: clawket/skills/clawket-scenario-author/RULE.md`
8. Replace `~/.claude/rules/qa-flow.md` with the one-line stub:
   `# moved to plugin: clawket/skills/clawket-verify-batch/RULE.md`

Cleanup is restricted to `~/.claude/skills/` and `~/.claude/rules/`. The user data trees (`~/.local/share/clawket/`, `~/.cache/clawket/`, `~/.config/clawket/`, `~/.local/state/clawket/`) are **never** touched — this matches the LM-8 path separation invariant enforced at runtime by the daemon's `paths::ensure_no_plugin_overlap` and by `clawket doctor`.

### Step 4 — Skip branch (response ≠ `y`)

Leave `~/.claude/skills/*` and `~/.claude/rules/*.md` untouched. The plugin's STABLE skills are already active because Claude Code's skill resolution prefers plugin-scope over user-scope, but the user-scope copies will diverge from the plugin canon over time. Surface this once and move on:

```
Cleanup skipped. The user-scope copies under ~/.claude/skills/ and ~/.claude/rules/
may drift from the plugin canon. Re-run Phase E in a later session, or delete the
staging files manually when convenient.
```

### Why Phase E is manual

Phase E mutates files outside the plugin tree (`~/.claude/skills/`, `~/.claude/rules/`). The plugin install gate (`adapters/shared/claude-hooks.cjs::ensureInstalled`) deliberately writes only under `pluginRoot` (`~/.claude/plugins/clawket-*/`) — the LM-8 invariant. Step 3 crosses that boundary on the operator's behalf, so it is gated behind an explicit confirm and is not invoked by any hook, sub-agent, or CI script. The autonomous-run policy mirrors the broader Clawket guardrail: no commit, push, tag, release, or user-scope mutation without explicit user instruction.

## Rollback

Stop the v3 daemon, restore the pre-upgrade backup, downgrade binaries:

```bash
clawket daemon stop
cp ~/.local/share/clawket/db.sqlite.v2-backup ~/.local/share/clawket/db.sqlite
# Reinstall v2 binaries via your package manager or by pinning components.json
```

There is no in-place v3 → v2 schema migration. Rollback requires a database restore.
