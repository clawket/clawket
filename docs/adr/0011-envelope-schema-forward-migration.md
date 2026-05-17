# ADR-0011 — Envelope Schema Forward-Migration Policy

| Status | Owner task | Targets | Plan |
|---|---|---|---|
| **Accepted** (M0 schema-freeze, RL-U2-09 dogfood passed 2026-04-27 by LM-54) | LM-59 / RL-U2-14 | Envelope `version` field (1) + storage in `task_envelopes` + replay | v11 — Structured Task Contracts |

## Context

The execution envelope (ADR-0001) is a contract attached to every task. Its 19 fields are pinned at v1 for M0 schema-freeze. Three forces will pressure the schema to evolve:

1. **New field demand**: e.g. retros surface that `flaky_quarantine_threshold` should accept a per-failure-type discriminator, not just `M/N`. Adds a field.
2. **Field semantic refinement**: e.g. `decomposition_policy` gains a `tree(max_depth=N, max_siblings=M)` shape (ADR-0004 OQ #2). Changes a field's grammar.
3. **Field deprecation**: e.g. `cross_project_rag` becomes redundant once cycle-level RAG scoping lands. Removes a field.

Without a policy, every change becomes a Big Decision: do we re-write all stored envelopes? Refuse old envelopes? Keep two parsers? v8 had no answer; v11 needs one before the first envelope is signed in production.

The policy below names how we evolve the schema **without invalidating already-signed envelopes** and **without forcing every task to re-sign**.

## Decision

The envelope schema follows three rules:

### Rule 1 — Schema versions are integers, monotonic, and stored

`task_envelopes.json.version` is an integer. M0 freezes at `version: 1`. The next bump is `version: 2`, then `3`, etc. No semver — there are no "minor" envelope versions. Every shape change is a major bump.

A new daemon binary supports **all prior versions** (read + replay) and **exactly one current version** (write). Authors signing a new envelope always get the current version.

The daemon's `task_envelopes` table accumulates envelopes across versions. Replay reads the version embedded in the JSON. There is no upgrade-on-read.

### Rule 2 — Field changes follow one of four kinds, each with explicit handling

| Change kind | Definition | Old envelopes | New envelopes | Migration |
|---|---|---|---|---|
| **Additive** | New optional field with default. | Continue to be valid. Default applied at read. | Use new field. | None. Daemon handles default at read time. |
| **Refining** | Existing field's grammar widens (e.g. new `decomposition_policy` shape) | Continue to be valid. Old grammar still parses. | Authors may use new shape. | None. Parser must remain backward-compatible. |
| **Constraining** | Existing field's grammar narrows (e.g. `intent` minLength bumps from 1 to 32) | **Continue to be valid as v(N-1).** Cannot be re-signed at v(N) without satisfying new constraint. | New constraint applies. | One-shot CLI: `clawket task envelope upgrade <id> --to v(N)` re-signs at the target version after author resolves the constraint violation. |
| **Removing** | A field is dropped. | Continue to be valid. The field is read-but-ignored on the v(N) parser. | New envelopes can't include the dropped field. | None on stored data. The author may run `--upgrade` to drop the field cleanly. |

Each schema bump's release notes specify which kind applies to each changed field. The schema file (`daemon/schemas/envelope-vN.schema.json`) is the source of truth — we ship one per version.

### Rule 3 — Replay is always against the envelope's own version

A run records `runs.envelope_id`. Replay reads the linked envelope, parses it as its `version`, and runs against **that** version's semantics. Even if a v3 daemon is running, a v1 envelope's `decomposition_policy` evaluator is the v1 evaluator.

This means the daemon ships **one parser + evaluator per version**, indefinitely. The cost is bounded by the number of versions × parser size. v1 parser is ~200 LOC; even at v10 the total is ~2k LOC, well under maintenance pressure.

Concretely: `daemon/src/policy/decomposition_v1.rs`, `decomposition_v2.rs`, etc. — version-pinned modules. Code duplication is preferred over conditional logic for the same reason ORMs prefer migration files: each version is its own observable artifact.

## Practical patterns

### Pattern A — Adding a field

```diff
  // daemon/schemas/envelope-v2.schema.json
  "properties": {
    "version": { "minimum": 1, "maximum": 2 },           // bump max
+   "tags": { "type": "array", "items": { "type": "string" }, "default": [] },
    ...
  }
```

Old envelopes (`version: 1`) continue to work; the v2 reader applies the default `[]` for `tags`. New envelopes (`version: 2`) may set `tags`. No migration tooling needed.

### Pattern B — Refining a field (widening)

ADR-0004 OQ #2: `tree(max_depth=N)` becomes `tree(max_depth=N, max_siblings=M)`. The regex widens:

```diff
- ^(atomic|tree\(max_depth=[0-9]+\)|linear\(max_steps=[0-9]+\)|custom\(.+\))$
+ ^(atomic|tree\(max_depth=[0-9]+(,max_siblings=[0-9]+)?\)|linear\(max_steps=[0-9]+\)|custom\(.+\))$
```

v1 envelopes still parse (the comma group is optional). v2 envelopes can use the new form. The v1 parser doesn't understand `max_siblings` and never sees it. The v2 parser handles both.

### Pattern C — Constraining a field

`intent` minLength bumps from 1 to 32:

```diff
- "intent": { "type": "string", "minLength": 1, "maxLength": 4096 },
+ "intent": { "type": "string", "minLength": 32, "maxLength": 4096 },
```

v1 envelopes with a 5-char `intent` continue to be valid as v1. They cannot be re-signed at v2 until the author edits to ≥ 32 chars. The CLI command:

```sh
clawket task envelope upgrade <task_id> --to 2
# Reads current envelope (v1), validates against v2 schema.
# If valid: re-signs at v2.
# If invalid: prints failures and exits non-zero.
#   Author edits the offending fields, then re-runs.
```

### Pattern D — Removing a field

`cross_project_rag` is dropped from v3:

- v1 + v2 envelopes can still set the field; v3 readers ignore it.
- v3 envelopes can't include it (`additionalProperties: false`).
- `clawket task envelope upgrade --to 3` strips the field automatically (no author input needed for this kind).

### Pattern E — Field semantic change without grammar change

Sometimes a field's grammar stays the same but its **meaning** changes. Example: `verification_cmd` exit code 77 starts meaning "skipped" (instead of "failed").

This is the most dangerous kind. Policy: **forbid** such changes. If a meaning changes, treat it as a new field (`verification_cmd_v2` or similar) and use Pattern A + Pattern D.

The reason: there's no syntactic signal. Replay against a v(N-1) envelope but with v(N) semantics would silently produce different outcomes from the original run. The version isolation in Rule 3 guards against this — if it's a different version, it's a different evaluator.

## Six rejected alternatives

| # | Alternative | Why rejected |
|---|---|---|
| 1 | **Auto-upgrade on read** (rewrite stored envelope to current version) | Replays diverge — the run was against v1; reading it as v2 gives different evaluator. Storage immutability is the foundation of replay. |
| 2 | **No versioning; just keep the schema flexible** | "Flexible schema" is YAML-pile decay in slow motion. v8 had this; retros showed every author wrote slightly different envelopes and replays were impossible to reproduce. |
| 3 | **Refuse to load old envelopes** | Forces every task to re-sign on every bump. Practically: bumps become political, tasks-in-flight die. Not viable. |
| 4 | **Single parser with conditional logic** | The parser becomes the spec. It rots. Per-version parsers (Rule 3) keep history honest. |
| 5 | **Semver (1.0.0 / 1.1.0 / 2.0.0)** | Implies that "patch" releases exist. They don't — every shape change is a contract change. Integer is honest. |
| 6 | **Migration scripts that mutate stored envelopes** (akin to SQL migrations) | Same critique as #1: replay against the un-migrated original is no longer reproducible. We migrate **the parser**, not the data. |

## Open issues

| # | Issue | Owner |
|---|---|---|
| O1 | When does v1 stop being supported? | Policy: forever, for already-signed envelopes. The parser-per-version cost is acceptable. **Re-evaluate** if total envelope-parser LOC exceeds 5k. |
| O2 | How do we communicate a bump? | Each bump ships with: ADR (this kind, justification), schema file, parser module, CHANGELOG entry, dashboard banner ("envelope schema v2 available — see ADR-NNNN"). |
| O3 | Can a single Cycle have envelopes of mixed versions? | Yes. Each task's envelope is independent. Cycle-level reporting aggregates across versions but does not require uniform version. |
| O4 | What if a constraint tightens and it would invalidate a stored envelope? | Rule 2 row "Constraining": stored envelope keeps its v(N-1) version forever. The v(N) constraint applies only to v(N)-versioned envelopes. Stored data is immutable. |
| O5 | Sub-task inheritance with version mismatch (parent v1, sub v2)? | LM-134 INHERIT_ONLY for `version` rejects this. Sub must match parent. To upgrade a tree, run `clawket task envelope upgrade --recursive` (M1 followup). |

## Implementation pointers

| Surface | Where | Owner |
|---|---|---|
| Schema files | `daemon/schemas/envelope-v1.schema.json` (done LM-131); `envelope-v2.schema.json` (when bump lands) | per-bump |
| Parser modules | `daemon/src/policy/decomposition_v1.rs` etc. — version-pinned. | per-bump |
| Validator dispatch | `daemon/src/policy/envelope.rs::validate(&Envelope)` reads `version` and delegates | LM-20 |
| Replay version selection | `daemon/src/runner/replay.rs::run` reads envelope's `version` and selects evaluator | LM-20 |
| CLI: `clawket task envelope upgrade` | `cli/src/commands/task.rs` | M1 (RL-U5-04) |
| Migration tooling for Pattern D (auto-strip) | bundled in `upgrade` command | M1 |
| Dashboard: version pill on task | "envelope: v1" badge + "v2 available — upgrade" prompt | M1 (RL-U7-04) |

## Backwards compatibility (what this ADR preserves)

This ADR's job is **to preserve compatibility**. The pattern catalog and rules are written so:

- A v1 envelope signed today will still parse and evaluate identically in v3, v4, ..., v∞.
- A v2 daemon reading a v1 envelope produces the same evaluation as a v1 daemon would have.
- Replay is reproducible across daemon upgrades.

The only situation where compatibility breaks is **Rule 2 row "Removing" combined with a field that was load-bearing for an old envelope's semantic** — and Pattern E forbids the dangerous variant of that.

## Verification

```sh
# 1. JSON Schema's version max bumps with each new schema:
jq '.properties.version.maximum' daemon/schemas/envelope-v1.schema.json
# Expect: 1

# 2. ADR enumerates all four change kinds:
grep -cE '\*\*(Additive|Refining|Constraining|Removing)\*\*' clawket/docs/adr/0011-envelope-schema-forward-migration.md
# Expect: ≥ 4

# 3. Six rejected alternatives:
grep -cE '^\| [1-6] \|' clawket/docs/adr/0011-envelope-schema-forward-migration.md
# Expect: ≥ 6
```

## Approval

Final approval gated by RL-U2-09 (LM-54). Dogfood pass: assign each of the four change-kind patterns (A/B/C/D) a real plausible bump scenario from open ADR issues (e.g. ADR-0004 OQ #2 = Pattern B; secret-rotation-handling = Pattern A; signed_by enforcement = Pattern C) and verify the parser-per-version model handles each. Until that passes, this ADR remains **Proposed**.
