# ADR-0004 — `decomposition_policy` DSL

| Status | Owner task | Targets | Plan |
|---|---|---|---|
| **Accepted** (M0 schema-freeze, RL-U2-09 dogfood passed 2026-04-27 by LM-54) | LM-132 / RL-U2-04 | Envelope field 6 (required tier) | v11 — Structured Task Contracts |

## Context

The `decomposition_policy` field is the v11 envelope's answer to "**how is this task allowed to spawn sub-tasks, and when is its parent allowed to close?**" Without this constraint, the agent loop degenerates into one of two failure modes:

1. **Non-atomic leaves**: a "leaf" task contains 4 hidden sub-changes the agent silently smuggled in, breaking replay.
2. **Premature parent closure**: a parent task closes while sub-tasks are still in `todo`, breaking the `decompose → contract → execute` invariant.

Both are observable in v8 retros. v11 makes the policy declarative and mechanically enforceable.

## Decision

`decomposition_policy` is a **constrained DSL string** with four top-level shapes:

| Form | Semantics | Use when |
|---|---|---|
| `atomic` | Task may not have sub-tasks. Closing requires `verification_cmd` exit 0. | Leaf tasks. The default and most common shape. |
| `tree(max_depth=N)` | Task may have sub-tasks up to N levels deep. Cannot close while any descendant leaf is non-terminal. | Multi-level breakdowns (epic → story → task). |
| `linear(max_steps=N)` | Task may have at most N sequential sub-tasks. Each sub-task must close before the next starts. Cannot close while any sub-task is non-terminal. | Strictly ordered procedures (migration, rollout). |
| `custom(<expr>)` | Escape hatch. `<expr>` is a boolean DSL evaluated at close-time against the task's sub-tree state. Returns true == may close. | Non-standard policies — rare; review-required. |

### Grammar (EBNF)

```
policy        ::= atomic | tree | linear | custom
atomic        ::= "atomic"
tree          ::= "tree(max_depth=" integer ")"
linear        ::= "linear(max_steps=" integer ")"
custom        ::= "custom(" predicate ")"

predicate     ::= disjunction
disjunction   ::= conjunction ("||" conjunction)*
conjunction   ::= negation ("&&" negation)*
negation      ::= "!" atom | atom
atom          ::= "(" predicate ")" | comparison | bool_call
comparison    ::= field op value
field         ::= "leaves_open" | "leaves_total" | "depth" | "siblings_open" | "self_status"
op            ::= "==" | "!=" | "<" | "<=" | ">" | ">="
value         ::= integer | quoted_string
bool_call     ::= "all_leaves_done" | "all_descendants_terminal" | "no_blocked_descendants"

integer       ::= [0-9]+, range [0, 1024]
quoted_string ::= "\"" [^"]* "\""    # enum value for status comparison
```

### Validation regex (used in JSON Schema, ADR-0001 already applied)

```
^(atomic|tree\(max_depth=[0-9]+\)|linear\(max_steps=[0-9]+\)|custom\(.+\))$
```

The `custom(.+)` arm is parsed by a Rust DSL parser (in `daemon/src/policy/decomposition.rs` — new module under LM-20). The parser rejects any expression that doesn't match the EBNF above and produces a structured AST at envelope sign time. **Sign fails closed** if `custom` doesn't parse.

## Six violation classes (the reason DSL > YAML)

The triage pass (LM-51 / RL-U1-08, OQ #4) decided DSL because YAML alone would degenerate into a per-rule parser. The six distinct violations the DSL must catch are:

| # | Violation | DSL detection | Why YAML alone fails |
|---|---|---|---|
| 1 | **Atomic-with-children**: leaf task spawns a sub-task. | At sub-task create: parent's policy is `atomic` → reject. | YAML would need a per-rule field `disallow_children: true`; doesn't compose with other rules. |
| 2 | **Premature-parent-close**: close attempt with open leaves. | At close attempt: evaluate `all_leaves_done` → false → reject. | YAML cannot express "must be evaluated against the sub-tree at close time". |
| 3 | **Depth-overflow**: sub-task creation at depth ≥ N+1 under `tree(max_depth=N)`. | At sub-task create: evaluate `depth < N` against parent → false → reject. | YAML would need `max_depth` as a separate field that doesn't compose. |
| 4 | **Linear-parallelism**: two sub-tasks under `linear` are simultaneously `in_progress`. | At sub-task `in_progress` transition: evaluate `siblings_open == 0` → false → reject. | YAML cannot express the negative ("only one in flight"). |
| 5 | **Step-count-overflow**: sub-task creation when `linear(max_steps=N)` already has N. | At sub-task create: count siblings, reject if ≥ N. | Composes with #3 but YAML treats both as separate shapes. |
| 6 | **Blocked-descendant-on-close**: parent close attempted with a `blocked` descendant. | At close attempt: evaluate `no_blocked_descendants` → false → reject. | YAML cannot express the *negative across a sub-tree*. |

The DSL collapses these into one parser + one evaluator. The alternative (YAML) would need 6 disjoint rule types, each with its own evaluation hook — high maintenance, low expressivity.

## Evaluation

Two hook points:

1. **At sub-task create** (`POST /tasks` with `parent_task_id`): parent's policy is fetched, evaluated against `{depth: parent.depth + 1, siblings_open: count_open_siblings(parent_id)}`. Fail-closed.
2. **At close attempt** (`PATCH /tasks/:id status=done`): self's policy is fetched, evaluated against `{leaves_open: count_open_leaves(self_id), leaves_total: count_leaves(self_id), no_blocked_descendants: ...}`. Fail-closed.

Evaluation is **synchronous + transactional** — the rejection happens inside the same DB transaction as the requested transition. No partial state.

## Defaults

- New tasks created without explicit `decomposition_policy` get `atomic`. This matches the "leaf is the default" v11 invariant.
- Tasks promoted to parent (sub-task created under them) get *automatically* upgraded to `tree(max_depth=4)` by the daemon, with a warning surfaced to the dashboard ("policy auto-upgraded — review and pin explicitly"). This avoids the silent bypass where someone forgets to set policy.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **YAML rule list** | 6 disjoint rule types per the violation table. Maintenance overhead grows linearly with new rules. |
| **No DSL — drop the field** | OQ #4 explicitly rejected this. The 6 violation classes are real and observed in v8 retros. |
| **Free-form predicate (Rego, CEL)** | Overkill for 6 violation classes + adds a runtime dependency. Custom DSL is ~200 LOC of nom-style parser. |
| **Per-violation column on `tasks`** | Same as YAML, just denormalized. No composition. |
| **Hooks-only enforcement** (no DSL, just pre-write hooks) | Hooks already handle Plan/Cycle/active-task gates. Decomposition policy is *envelope state*, not a runtime gate — it must travel with the envelope across replay. |

## Examples

### Atomic leaf
```
atomic
```
Cannot have children. Closes when `verification_cmd` exits 0.

### Two-level epic
```
tree(max_depth=2)
```
Allows: parent → child. Disallows: parent → child → grandchild.

### Sequential migration
```
linear(max_steps=5)
```
Up to 5 sub-tasks, executed in order. Cannot close until all 5 are terminal.

### Custom: "may close only when no descendant is blocked AND at least 3 leaves are done"
```
custom(no_blocked_descendants && leaves_total - leaves_open >= 3)
```

### Custom: "tree but with depth ≤ 3 AND no blocked descendants"
```
custom(depth <= 3 && no_blocked_descendants)
```
Note: this is equivalent to `tree(max_depth=3)` plus a blocking-check; usually prefer `tree(max_depth=3)` and let the close-time `no_blocked_descendants` be implicit per ADR's blocked-descendant default.

## Implementation pointers

| Surface | Where | Owner |
|---|---|---|
| Parser | `daemon/src/policy/decomposition.rs` (new module) | LM-20 |
| Evaluator | `daemon/src/policy/decomposition.rs::evaluate(&Ast, &TreeState)` | LM-20 |
| Tree state query | `daemon/src/repo/tasks.rs::tree_state(parent_id)` (new fn) | LM-20 |
| Hook: sub-task create | `daemon/src/routes/tasks.rs::create` | LM-20 |
| Hook: close attempt | `daemon/src/routes/tasks.rs::update_status` | LM-20 |
| CLI flag | `clawket task envelope edit --decomposition-policy '...'` | M1 (RL-U5-04) |
| Schema validation | `daemon/schemas/envelope-v1.schema.json` already applies the regex | LM-131 ✓ |

## Backwards compatibility

Existing tasks at migration-002 time: `active_envelope_id = NULL`, so policy is *not enforced* on them. They are surfaced in the dashboard as "legacy (no decomposition policy)" and can be optionally upgraded.

## Open issues

| # | Issue | Owner |
|---|---|---|
| O1 | Whether `custom(...)` should require code review (a flag in plan-config) before envelope sign accepts it. | M1 (RL-U5-02b) |
| O2 | Whether `tree(max_depth=N)` should also bound `siblings` per node (currently unbounded). | If retros find sibling-bloat, add `tree(max_depth=N, max_siblings=M)` in v2. |

## Approval

Final approval gated by RL-U2-09 (LM-54). Dogfood pass: assign each of the 6 violation classes a real failing-task example and verify the parser + evaluator catches them. Until that passes, this ADR remains **Proposed**.
