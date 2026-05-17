# ADR-0007 — `token_budget` Field [SUPERSEDED]

| Status | Owner task | Targets | Plan |
|---|---|---|---|
| **Superseded** by [`0007-assigned-model.md`](./0007-assigned-model.md) on 2026-04-27 (LM-242 audit) | LM-55 / RL-U2-10 | Envelope field 12 (optional tier) | v11 — Structured Task Contracts |

> **READ FIRST** — this ADR is preserved for audit trail. The `token_budget` design proposed below is **vaporware**: a runtime "pre-call gate" cannot exist in clawket's architecture (clawket is a hook/MCP under Claude Code; it does not own the LLM call). The replacement ADR (`0007-assigned-model.md`) keeps only the enforceable signal: a single declarative `assigned_model` enum + cycle-level `allowed_models` whitelist. Do not re-propose `usd_cap` until clawket has a Claude Code hook that exposes per-call cost data; until then, all "budget enforcement" claims here are unsubstantiated.

## Context

The `token_budget` field is the v11 envelope's answer to "**how much is this task allowed to cost, and on which model?**" v8 had no per-task model selection or cost cap; the agent picked whatever model the global Claude Code session ran with, and cost surfaced only in retro reviews. v11 retros surface three failure modes:

1. **Cost runaway**: a 30-minute `claude code` session burns $20 because nobody specified a cap; the user only notices at month-end billing.
2. **Model miscast**: a "fix this typo" task runs on opus 4.7 because the session was already at opus; same task on haiku would cost 1/30th.
3. **Context-window starvation**: a large repo task sets `ctx_in` too low and the agent silently truncates the system prompt + tool descriptions, producing nonsense.

`token_budget` makes the **model + the per-call ceilings + the dollar cap** part of the contract. The runtime refuses to start a task whose allotted model can't fit the planned context, and the runner halts with a structured error when usd_cap is reached.

## Decision

`token_budget` is an object `{model, ctx_in, ctx_out, usd_cap}`, all four fields **required when the field is present**.

```json
{
  "token_budget": {
    "model": "sonnet",
    "ctx_in": 150000,
    "ctx_out": 20000,
    "usd_cap": 0.50
  }
}
```

Field semantics:

| Field | Type | Range | Notes |
|---|---|---|---|
| `model` | enum | `haiku` / `sonnet` / `opus` (or pinned `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-7`) | Model rank: haiku < sonnet < opus. Inheritance allows tightening (sub may pick smaller). |
| `ctx_in` | integer | ≥ 1024 | Max input tokens per call. Sum across system prompt + tools + history + user message. Hard ceiling enforced by SDK. |
| `ctx_out` | integer | ≥ 256 | Max output tokens per call. SDK `max_tokens`. |
| `usd_cap` | number | > 0 | Lifetime dollar cap for this task across all retries. **Stops the runner mid-task** when reached. |

### Defaults (when `token_budget` is `null` or absent)

```
haiku:  ctx_in=50000   ctx_out=10000  usd_cap=$0.10
sonnet: ctx_in=150000  ctx_out=20000  usd_cap=$0.50  ← v11 task default
opus:   ctx_in=200000  ctx_out=40000  usd_cap=$3.00
```

The default model is `sonnet` per v11. Selection bias: haiku for trivial mechanical tasks (renames, single-file edits with clear pattern), sonnet for default coding work, opus for architectural/multi-file refactors and review.

## Per-model defaults (rationale)

| Model | ctx_in | ctx_out | usd_cap | Why |
|---|---|---|---|---|
| haiku-4.5 | 50,000 | 10,000 | $0.10 | Haiku 4.5 input is ~$1/M, output ~$5/M. 50k+10k = ~$0.10 ceiling matches the price/value frontier. Tasks that need more should escalate to sonnet. |
| sonnet-4.6 | 150,000 | 20,000 | $0.50 | Sonnet 4.6 input ~$3/M, output ~$15/M. 150k+20k = ~$0.75 worst-case; cap at $0.50 forces "are you sure this is sonnet-shaped?" before going over. |
| opus-4.7 | 200,000 | 40,000 | $3.00 | Opus is reserved. The cap is intentionally high — opus runs are rare, and we want them to complete rather than die mid-trace. The signal is **needing opus at all**, not the dollar amount. |

These defaults are tuned for **single-task** work. Multi-task plans (a Cycle running 20 tasks) should set per-task budgets at the envelope level so the cycle's aggregate cost is predictable.

## Enforcement points

| When | Where | Action |
|---|---|---|
| Sign-time | `daemon/src/policy/budget.rs::validate_envelope` (new module under LM-20) | Reject if `ctx_in > model_max_in[model]` (e.g., haiku capped at 200k context). Reject if `ctx_out > ctx_in / 4` (heuristic: outputs > 25% of input is almost always a misconfig). |
| Pre-call | runner before each LLM call | If projected call cost (current_spend + estimated_call) > `usd_cap`, abort the run with `budget_exhausted`. |
| Per-call | runner after each call | Update `runs.usd_spent` ; if cumulative exceeds `usd_cap`, mark run `budget_exhausted` and stop. |
| Inheritance | sub-task envelope sign | TIGHTEN_ONLY: sub may decrease any of `ctx_in`/`ctx_out`/`usd_cap` and pick a model of equal-or-lower rank. See LM-134. |

The **pre-call** check is the critical one — it prevents the well-known failure where a single oversized call consumes the entire remaining budget and produces a partial-output that's worse than no output.

## Cost model

```
estimated_call_cost = (input_tokens * input_price[model]) + (max_output_tokens * output_price[model])
projected_total     = run.usd_spent_so_far + estimated_call_cost
if projected_total > envelope.token_budget.usd_cap: abort
```

Prices are pinned in `daemon/src/policy/pricing.rs::PRICES` (new module). Sourced from Anthropic public pricing; updated alongside model release. Pricing changes are **not** envelope-breaking — they affect cost projection only, not the envelope shape.

## Six rejected alternatives

| # | Alternative | Why rejected |
|---|---|---|
| 1 | **Single global cap** (per-machine setting, not per-envelope) | Cost is per-task; a user has no reasonable way to set a single number that covers "small fix" and "epic refactor" both. |
| 2 | **Cap only, no model field** | Model selection IS budget — picking sonnet over opus is the largest cost lever available. Hiding it would force every author to "just use opus" defensively. |
| 3 | **Per-call cap (instead of lifetime)** | Lifetime is what the user actually cares about. Per-call without lifetime allows "death by a thousand cuts" (50 cheap retries == one expensive call). Lifetime alone is sufficient because per-call is bounded by ctx_in/ctx_out. |
| 4 | **Token cap (no dollars)** | Tokens are a leaky abstraction across models — 100k haiku tokens ≠ 100k opus tokens in business value or cost. Dollars are what the user pays. |
| 5 | **Auto-downgrade on cap approach** (haiku → sonnet → halt) | Ambiguous behavior. The author signed for `model = sonnet`; silently switching to haiku 90% through the run produces a hybrid output that's hard to reason about. Prefer halt-and-let-author-decide. |
| 6 | **Soft cap (warn, don't halt)** | If the cap doesn't halt, it's a vibe, not a contract. v11 envelopes are contracts. |

## Open issues

| # | Issue | Owner |
|---|---|---|
| O1 | Should `usd_cap` accept a "stretch" cap (`{hard: 0.5, halt: 1.0}`) for tasks that occasionally bloat? | Considered; rejected for v1 (cap-of-cap is just the higher number). Reopen if retros find legitimate need. |
| O2 | How does `token_budget` interact with cached prompt tokens (Anthropic prompt cache)? | Cost calc uses cached pricing tier when SDK reports cache hit. Pricing module owns the math; envelope shape unchanged. |
| O3 | Multi-model inside a single run (e.g., "use haiku for tools, sonnet for synthesis")? | Out of scope for v1. If retros pressure this, ADR-0011 schema bump introduces `token_budget.calls[]` array. |

## Implementation pointers

| Surface | Where | Owner |
|---|---|---|
| Validator | `daemon/src/policy/budget.rs::validate_envelope` (new) | LM-20 |
| Pricing table | `daemon/src/policy/pricing.rs::PRICES` (new) | LM-20 |
| Pre-call gate | runner spawn loop in `cli/src/run/spawn.rs` (or wherever the run loop lives) | LM-20 |
| Cumulative spend tracking | `runs.usd_spent` column (new — migration 003 candidate) | LM-20 (003 owned by RL-U2-14) |
| Inheritance: TIGHTEN_ONLY | `daemon/src/policy/inheritance.rs::is_tighter_or_equal` | LM-20 (spec at LM-134) |
| CLI display | `clawket task envelope view` shows model/cap/spent | M1 (RL-U5-04) |
| Dashboard pill | "Sonnet · $0.32 / $0.50" badge on task card | M1 (RL-U7-04) |

## Backwards compatibility

Existing tasks at migration-002 time have `active_envelope_id = NULL`. They run with **no enforcement** (legacy behavior preserved) and are surfaced in the dashboard as "legacy (no budget)". Authors can optionally upgrade by signing an envelope.

When a task gains an envelope mid-life, `runs.usd_spent` resets to 0 — the prior runs were not budget-tracked, and reading them retroactively against the cap would be misleading. The dashboard surfaces this as "budget started at envelope-sign".

## Verification

```sh
# 1. JSON Schema requires all 4 fields when present:
python3 -c "
import json, jsonschema
s = json.load(open('daemon/schemas/envelope-v1.schema.json'))
b = s['properties']['token_budget']
print('required:', b['required'])
print('null allowed:', 'null' in b['type'])
"
# Expect: required: ['model', 'ctx_in', 'ctx_out', 'usd_cap']; null allowed: True

# 2. Six rejected alternatives documented:
grep -cE '^\| [1-6] \|' clawket/docs/adr/0007-token-budget.md
# Expect: ≥ 6
```

## Approval

Final approval gated by RL-U2-09 (LM-54). Dogfood pass: assign each of the three failure modes (cost runaway, model miscast, context starvation) a real failing-task example and verify the validator + pre-call gate catches them. Until that passes, this ADR remains **Proposed**.
