# ADR-0001 — Execution Envelope: 19-Field Task Contract

| Status | Owner task | Targets | Plan |
|---|---|---|---|
| **Accepted** (M0 schema-freeze, RL-U2-09 dogfood passed 2026-04-27 by LM-54; LM-242 hardening folded in) | LM-130 / RL-U2-02 | All v11 task storage, runtime, and replay surfaces | v11 — Structured Task Contracts |

## Context

Today's `tasks` row (see `plans/artifacts/u2-task-schema-inventory.md`, LM-129) holds 18 unconstrained columns and one append-only `body` blob. The body is the **only** place a user can encode intent, success criteria, scope, retry, secrets, or rollback plan — and even then it's free-form prose with no schema, no validation, no replayability.

This is the structural source of every v11 pain:

- **Free-form drift** — "Add the auth flow" has no `success_metric` to gate on.
- **Replay gaps** — runs are not keyed to a contract; "what did the agent agree to do?" has no answer.
- **Cross-session amnesia** — the next session cannot reconstruct what the prior session signed up for.

ADR-0001 introduces the **Execution Envelope**: a typed, schema-validated, version-stamped JSON document attached to each task that *replaces the intent half of `body`* and becomes the single source of truth that plan, run, and review all consult.

## Decision

The Execution Envelope is a **19-field JSON object** stored in a sidecar `task_envelopes` table (one envelope per task per version), referenced by the task row via `envelope_id`. The 19 fields divide into a **required tier (7)** and an **optional tier (12)**.

### Required tier (7) — must be present at envelope sign

| # | Field | Type | Defined by | Purpose |
|---|---|---|---|---|
| 1 | `version` | integer ≥ 1 | this ADR | Schema version (bumped per ADR-0011 forward-migration). |
| 2 | `intent` | string (markdown, ≤ 4kB) | this ADR | One-paragraph statement of *what this task changes and why*. Replaces the intent half of legacy `body`. |
| 3 | `target_repo` | string (`<org>/<repo>` or local path) | this ADR | Where the change lands. PreToolUse hooks gate any mutation against this. |
| 4 | `success_criteria` | array of strings, length ≥ 1 | this ADR | Declarative outcomes; each entry must be checkable (link, command, or assertion). |
| 5 | `verification_cmd` | string (shell) | this ADR | Single command whose exit code 0 == success. Captured stdout/stderr is attached to the run. |
| 6 | `decomposition_policy` | DSL expression | RL-U2-04 → ADR-0004 | One of {`atomic`, `tree(max_depth=N)`, `linear(max_steps=N)`, `custom(...)`}. Refuses parents from closing while leaves are open. |
| 7 | `context_refs` | array of `{kind, id, sha?}` | RL-U3-02 (v1 schema, OQ #3) | Stable references to artifacts/tasks/decisions the agent may consult. v1 schema frozen by RL-U3-02 before M1. |

### Optional tier (12) — defaults defined; presence is not gating

| # | Field | Type | Defined by | Default |
|---|---|---|---|---|
| 8 | `acceptance_criteria` | array of strings | this ADR | `[]` (subset of success_criteria when set) |
| 9 | `precondition` | DSL expression | RL-U2-05 → LM-133 | `true` |
| 10 | `postcondition` | DSL expression | RL-U2-05 → LM-133 | `verification_cmd exit == 0` |
| 11 | `rollback_plan` | object `{steps: [...], verify: cmd}` | RL-U2-08 → LM-53 | `null` (no automated rollback) |
| 12 | `assigned_model` | enum string `haiku` / `sonnet` / `opus` (or pinned `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-7`) | RL-U2-10 → ADR-0007 (revised by LM-242) | `null` (unspecified) — declarative; runtime enforcement via `cycle.allowed_models` whitelist only |
| 13 | `retry_policy` | object `{max_attempts, backoff, jitter, checkpoint_interval}` | RL-U2-11 → ADR-0008 | `{3, exp_base=2, jitter=0.2, checkpoint_interval=per_file}` |
| 14 | `secrets_ref` | array of `{name, lookup_order: [user_config, keyring, env, 1password]}` | RL-U2-12 → ADR-0009 | `[]` |
| 15 | `planned_sha` | string (git SHA, 40-hex) | this ADR | `null` until envelope sign-time; captured by hook. |
| 16 | `superseded_by` | string (envelope id) | RL-U2-14 → ADR-0011 | `null` |
| 17 | `supersedes` | string (envelope id) | RL-U2-14 → ADR-0011 | `null` |
| 18 | `cross_project_rag` | boolean | OQ #5 → ADR-0010 (new) | `false` (privacy default) |
| 19 | `flaky_quarantine_threshold` | string `"M/N"` | OQ #9 → ADR-0012 (new) | `"2/3"` (provisional) |

**Total = 19**. Field count is structural — every additional field needs an ADR amendment.

## Storage

```sql
-- Migration 002 (LM-20 / RL-U2-07b)
CREATE TABLE task_envelopes (
  id          TEXT PRIMARY KEY,                 -- ENV-<ulid>
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  json        TEXT NOT NULL,                    -- 19-field document
  signed_at   INTEGER NOT NULL,
  signed_by   TEXT NOT NULL,                    -- author / agent_id
  superseded_by TEXT REFERENCES task_envelopes(id),
  CHECK (json_valid(json)),
  UNIQUE (task_id, version)
);
CREATE INDEX idx_envelopes_task ON task_envelopes(task_id);
CREATE INDEX idx_envelopes_active ON task_envelopes(task_id) WHERE superseded_by IS NULL;

ALTER TABLE tasks ADD COLUMN active_envelope_id TEXT REFERENCES task_envelopes(id);
```

**Why sidecar (not single JSON column on tasks)**:

1. Versioning is first-class — superseded envelopes are kept (not lost) for replay (per ADR-0011).
2. Existing tasks unaffected at migration 002 time (`active_envelope_id = NULL` until envelope is added).
3. JSON Schema validation (LM-131) gates inserts via `CHECK (json_valid(json))` + Rust-side schema validation in the daemon insert path.
4. Run history can be joined against envelope versions cleanly (run.envelope_id → envelopes.id).

## Validation

JSON Schema (LM-131) is the authoritative validator. Insert-time checks:

1. **Structural**: all 7 required-tier fields present, types correct, lengths within bounds.
2. **Referential**: `target_repo` matches a registered project; `context_refs` entries resolve to existing artifacts/tasks/decisions.
3. **Policy**: `decomposition_policy` parses (RL-U2-04 DSL); `precondition`/`postcondition` parse (RL-U2-05 DSL).
4. **Model**: `assigned_model` is either `null` or one of the enum values; if a parent cycle declares `allowed_models`, the value is in that set (ADR-0007 §"Cycle whitelist").
5. **Forward-compat**: `version <= MAX_KNOWN_VERSION`; envelopes with newer version are rejected with a clear "upgrade clawket" message (ADR-0011 owns reverse direction).

## Required vs optional rationale

The 7 required fields are the ones whose **absence makes the contract meaningless**:

- Without `intent` and `success_criteria`, there is no contract.
- Without `target_repo` and `verification_cmd`, the contract cannot be enforced.
- Without `decomposition_policy`, sub-tasks are unbounded.
- Without `context_refs`, replayability is broken.
- Without `version`, forward-migration is impossible.

The 12 optional fields are **policy decorators**: useful for production maturity, but a v11 envelope with `assigned_model=null` is still a valid envelope. We would rather ship envelopes with sensible defaults than gate launch on every field being explicitly set.

## Backwards compatibility

- **Existing tasks** at migration-002 time: `active_envelope_id = NULL`. Dashboard surfaces these as "legacy (no contract)" with a one-click "draft envelope" prompt.
- **PreToolUse hook**: continues to require an active task, *and* emits a soft-warn (not block) for legacy tasks until M1 cutover (ADR-0011 owns the cutover date).
- **Run records** created against legacy tasks have `envelope_id = NULL`. Timeline replay degrades gracefully with a "no envelope captured" badge.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Single JSON column on `tasks`** | Versioning would either lose superseded envelopes or smuggle them into JSON history (replay-hostile). Sidecar table is the same write cost with first-class versioning. |
| **Per-field columns (denormalized)** | 19 fields × type drift across schema versions = migration churn. JSON column with JSON Schema validation gives the same query power (json_extract) at far lower migration cost. |
| **Free-form markdown contract (rich body)** | Indistinguishable from today's pain. Free-form is what we are leaving. |
| **YAML envelopes on disk** | Off-DB state is replay-hostile (no atomic transitions, no FK to runs). |
| **Fewer fields (e.g. 7 only)** | The 12 optional decorators are policy surfaces other ADRs already need a field for (assigned_model needs ADR-0007, retry_policy needs ADR-0008, etc.). Forcing them into JSON-blob `metadata` would lose JSON Schema validation. |
| **More fields (e.g. 25+)** | Each additional field is an ongoing maintenance liability. The 19 are the minimum that close the v11 pain bullets. New fields require an ADR amendment. |

## Consequences

### Positive

- **Replayability**: every run keys to envelope_id. Replay reconstructs the contract the agent was operating under.
- **Validation**: schema rejects malformed envelopes before insert. No more `priority='nonsense'`-style smell.
- **Forward migration**: `version` field + `superseded_by` chain gives ADR-0011 a clean upgrade path.
- **Dashboard surface**: contract artefact appears in the UI as a first-class object (LM-50 GIF demonstrates this).

### Negative

- **One more table**: `task_envelopes` is FK-cascaded but adds one join to most read paths.
- **JSON in SQL**: SQLite json_* functions are required for queries; existing rusqlite usage already does this elsewhere (artifacts.content), so no new dependency.
- **Migration 002**: existing rows get NULL `active_envelope_id`. Dashboard rendering must handle this case (handled in M1).

### Neutral / deferred

- **secrets_ref redaction**: ADR-0009 + RL-U2-13 audit own the redaction surface; ADR-0001 just declares the field exists.
- **cross_project_rag default**: ADR-0010 owns the privacy decision; ADR-0001 just declares the field exists with a privacy-first default.
- **flaky_quarantine_threshold**: ADR-0012 owns the policy; ADR-0001 just declares the field with a provisional 2/3 default.

## Open issues

| # | Issue | Owner |
|---|---|---|
| O1 | `acceptance_criteria` overlap with `success_criteria` — collapse or formalize subset semantics. | RL-U2-02 (this task), follow-up before final approval |
| O2 | `cross_project_rag` field placement — envelope vs project-config — currently on envelope per privacy granularity argument. | ADR-0010 |
| O3 | Whether `planned_sha` should be required after the agent's first commit (auto-promoted from optional). | M1 (RL-U5-02a hook gate) |

These are not blockers for ADR-0001 final approval (RL-U2-09); they are tracked tweaks that may add a `version=2` envelope before M9.

## Implementation pointers

| Surface | Where | Owner |
|---|---|---|
| SQL migration 002 | `daemon/migrations/002_envelope.sql` | LM-20 / RL-U2-07b |
| Rust struct | `daemon/src/models.rs::Envelope` (new) | LM-20 |
| JSON Schema | `daemon/schemas/envelope-v1.schema.json` (new) | LM-131 / RL-U2-03 |
| Daemon route | `POST /tasks/:id/envelope`, `GET /tasks/:id/envelope` | M1 (RL-U3-02) |
| CLI | `clawket task envelope create / edit / view` | M1 (RL-U5-04) |
| Hook gate | PreToolUse soft-warn for legacy, hard-block for required-tier missing | M1 (RL-U5-02a/02b) |

## Approval

Final approval is gated by RL-U2-09 (LM-54). RL-U2-09 dogfoods this ADR by drafting an actual envelope for an existing v11 task and verifying:

1. All 7 required fields fill in coherently for a real task.
2. The envelope JSON validates against the schema (LM-131).
3. The envelope round-trips through migration 002 dry-run (LM-20).
4. No field is unused and no obvious gap is missing.

Until RL-U2-09 finishes that dogfood pass, this ADR remains **Proposed**.
