# ADR-0007 — `assigned_model` Field

| Status | Owner task | Targets | Plan |
|---|---|---|---|
| **Accepted** (M0 — supersedes earlier "Token Budget" draft; RL-U2-09 dogfood passed 2026-04-27 by LM-54; LM-242 audit confirmed) | LM-55 / RL-U2-10 (revised by LM-242) | Envelope field 12 (optional tier) | v11 — Structured Task Contracts |

## Context

Earlier draft of this ADR proposed a `token_budget = {model, ctx_in, ctx_out, usd_cap}` field with a runtime "pre-call gate" that would abort tasks before they exceeded a USD cap. **That mechanism is not implementable in the current clawket architecture** (audit on 2026-04-27, LM-242):

| Mechanism | Verdict | Why |
|---|---|---|
| Pre-call USD gate | **Impossible** | clawket is a hook/MCP under Claude Code. The LLM call is made by Claude Code itself; clawket has no callback at "pre-call" time. |
| Cumulative USD tracking on `runs` | **Impossible** | Claude Code does not expose token-usage / cost data to its hooks. `runs` table has no token columns and no source to populate them from. |
| Auto-abort on cap | **Impossible** | Same root cause — clawket cannot interrupt a Claude Code session it doesn't own. |
| Sign-time validation of `ctx_in` against model max | Possible (model max is a static constant) — but irrelevant if the cap can't be enforced at runtime. |
| Subscription-tier users (Claude.ai Pro/Max) have no per-token USD cost | n/a | Monthly flat rate; the entire premise of `usd_cap` is moot for them. |

The prior draft was vaporware. It is replaced by this ADR.

## Decision

`token_budget` (4-field object) is replaced by `assigned_model` (single string enum) — the **only** budget-related signal the envelope can credibly carry.

```json
{
  "assigned_model": "sonnet"
}
```

| Field | Type | Range | Semantics |
|---|---|---|---|
| `assigned_model` | enum | `haiku` / `sonnet` / `opus` (or pinned `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-7`) | The model class **assumed** for this task. Declarative; not enforced at the LLM-call layer. |

Default when absent: `null` ≡ "unspecified" (the dashboard renders as "—").

## What this field does (and doesn't)

### Does

1. **Documents author intent.** "I assumed sonnet was sufficient for this task." Reviewable in the dashboard, comparable across runs.
2. **Constrains via plan/cycle whitelists.** A Cycle can declare `allowed_models = ["haiku", "sonnet"]`; a task's envelope with `assigned_model: "opus"` fails sign. **This** is enforceable, because cycle/plan policy checks happen at envelope-sign in the daemon. See *Cycle whitelist* below.
3. **Inheritance signal.** Sub-task may pick equal-or-lower-rank model (TIGHTEN_ONLY per LM-134). Catches the "child escalates to opus" smell.
4. **Replay annotation.** "This run was supposed to use sonnet" — useful even if we can't verify it actually did.

### Does NOT

1. **Force the runtime to use this model.** Claude Code picks the model based on its session settings; clawket cannot override that.
2. **Track cost.** No data source.
3. **Abort on overspend.** Same.
4. **Validate `ctx_in` against per-model limits.** Model context limits change per release; the SDK enforces them anyway. Author doesn't need to set this.

## Cycle whitelist (the enforceable companion)

To make `assigned_model` mean something at sign-time, cycles gain an optional `allowed_models` array:

```json
// On a Cycle
{
  "allowed_models": ["haiku", "sonnet"]
}
```

When a task in this cycle signs an envelope with `assigned_model: "opus"`, the daemon rejects:

```
400 model_not_allowed
  cycle.allowed_models = ["haiku", "sonnet"]
  envelope.assigned_model = "opus"
```

If the cycle has no `allowed_models` (or `null`), all models pass — backward-compatible default.

This is the **only enforcement layer** for model selection. It works because cycle policy is owned by the daemon, evaluated at sign-time on the daemon's own data. Unlike a runtime call gate, no external coordination is needed.

The cycle column lands in **migration 003** (post-M0). Until then, `allowed_models` is a future hook; v1 envelopes work without it.

## Cost monitoring (separate from this ADR)

If clawket later integrates with a Claude Code hook that exposes token usage post-call (e.g. a hypothetical `PostMessageHook` with `usage` payload), the runner can populate a new `runs.tokens_in` / `tokens_out` column and surface a "this task ran at X tokens against assigned_model=Y" badge. That's a **monitoring** feature, not enforcement, and lives under a separate task (filed as: future RL-U10 hook expansion). It does not change `assigned_model`.

## Six rejected alternatives (revised)

| # | Alternative | Why rejected |
|---|---|---|
| 1 | **Keep `token_budget` with USD cap** | Vaporware. Cap can't be enforced (audit above). |
| 2 | **Drop the field entirely (18-field envelope)** | The model assumption is genuine signal; authors care about it. Removing forces every retro to ask "which model did this assume?" with no answer. |
| 3 | **Per-call cost tracking via Claude Code hook** | No such hook exists today. Future hook-spec issue, not envelope shape. |
| 4 | **Token cap (ctx_in/ctx_out)** | Authors don't write these correctly (they're SDK-level limits, not author-level). The SDK enforces them; envelope doesn't need to. |
| 5 | **Free-form model string** | "opus", "Opus", "claude-opus", "claude-3-opus" — drift inevitable. Enum + pinned IDs = canonical names. |
| 6 | **Auto-pick model from task complexity** | Over-engineering. The author knows; the envelope captures their intent. |

## Open issues

| # | Issue | Owner |
|---|---|---|
| O1 | Should `assigned_model` be required (not optional) when a task has `decomposition_policy != atomic`? | Defer to dogfood. The current design says optional/nullable — the author is encouraged but not forced. |
| O2 | When does the cycle `allowed_models` whitelist land? | Migration 003 + cycle endpoint update. Filed as future RL-U2-15+ task. |
| O3 | Is the model-rank ordering (haiku < sonnet < opus) the right one for inheritance TIGHTEN_ONLY? | Documented in LM-134 as `model_rank()`. Stable across model families; updated when new families ship. |
| O4 | Should we record the `actual_model_used` if a hook ever surfaces it? | Yes, as a separate `runs.actual_model` column. Not part of envelope. |

## Implementation pointers

| Surface | Where | Owner |
|---|---|---|
| JSON Schema | `daemon/schemas/envelope-v1.schema.json` — `assigned_model` enum, default `null` | LM-242 (this task) |
| Validator | `daemon/src/policy/model.rs::validate_assigned_model` (new) | LM-20 |
| Cycle whitelist check | `daemon/src/routes/envelopes.rs::sign` reads cycle.allowed_models, rejects mismatch | LM-20 (after migration 003) |
| Inheritance: TIGHTEN_ONLY | `daemon/src/policy/inheritance.rs::is_tighter_or_equal` ranks haiku ≤ sonnet ≤ opus | LM-20 (spec at LM-134) |
| CLI display | `clawket task envelope view` shows `assigned_model` | M1 |
| Dashboard pill | "sonnet" badge on task card; cycle "allowed: haiku,sonnet" pill | M1 (RL-U7-04) |

## Backwards compatibility

Existing envelopes with the prior `token_budget` shape (none in production yet — M0 hasn't rolled out) are not migrated; the field is replaced before any v1 envelope is signed in production. Dev DBs with experimental `token_budget` rows are wiped via `clawket daemon stop && rm ~/.local/share/clawket/clawket.sqlite-experimental*` per dev workflow.

Once M0 rolls out, future model additions are Pattern A (Additive — extend the enum) per ADR-0011.

## Honesty note

This ADR was rewritten because the prior draft proposed runtime mechanics that the architecture cannot support. The lesson: **don't ship contracts that the runtime can't enforce**. The replacement keeps only the enforceable signal (`assigned_model` declarative + cycle whitelist) and explicitly disclaims the rest.

The `runs.tokens_in/out` and cost-aware features remain interesting but are blocked on Claude Code exposing usage data to hooks. Filed as a future enhancement, not promised here.

## Verification

```sh
# 1. JSON Schema reflects the simplified shape:
python3 -c "
import json
s = json.load(open('daemon/schemas/envelope-v1.schema.json'))
am = s['properties']['assigned_model']
print('type:', am['type'])
print('enum:', am['enum'])
"
# Expect: type allows null, enum has 6 values (3 short + 3 pinned)

# 2. token_budget is GONE from the schema:
python3 -c "
import json
s = json.load(open('daemon/schemas/envelope-v1.schema.json'))
assert 'token_budget' not in s['properties'], 'token_budget should be removed'
assert 'assigned_model' in s['properties']
print('schema: token_budget removed, assigned_model present OK')
"

# 3. Six rejected alternatives:
grep -cE '^\| [1-6] \|' clawket/docs/adr/0007-assigned-model.md
# Expect: 6
```

## Approval

Final approval gated by RL-U2-09 (LM-54). Dogfood pass: assert that (a) `assigned_model` is honestly described as declarative, (b) cycle whitelist is the only enforceable lever, (c) the prior `token_budget` USD cap was correctly identified as unenforceable. The dogfood already happened in the LM-242 audit.
