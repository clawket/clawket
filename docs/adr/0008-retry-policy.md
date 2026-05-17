# ADR-0008 — `retry_policy` Field

| Status | Owner task | Targets | Plan |
|---|---|---|---|
| **Accepted** (M0 schema-freeze, RL-U2-09 dogfood passed 2026-04-27 by LM-54) | LM-56 / RL-U2-11 | Envelope field 13 (optional tier) | v11 — Structured Task Contracts |

## Context

`retry_policy` is the v11 envelope's answer to "**when this task fails mid-execution, what does 'retry' mean?**" v8 retros surface four distinct retry-related failures:

1. **Infinite retry**: a transient API error caused the agent loop to retry 17 times in 90 seconds, draining `usd_cap` (per ADR-0007) before a real diagnosis emerged.
2. **No retry**: a one-shot transient failure (rate-limit) killed a 20-minute task that was on the cusp of completion. No automatic recovery, no checkpoint.
3. **Synchronized retry storms**: when a model is rate-limited, all 8 in-flight tasks in a Cycle retry simultaneously, hitting the rate-limit again. No jitter.
4. **Lost work on retry**: a retry restarts the task from scratch, discarding 15 minutes of partial output. No checkpointing semantics.

`retry_policy` constrains all four into a single declarative shape. The contract is what the runner does on **retryable failures** (transient API errors, rate-limits, network blips); non-retryable failures (precondition fail, postcondition fail, budget exhausted, user kill) are NOT subject to this policy and never retried automatically.

## Decision

`retry_policy` is an object with four required fields:

```json
{
  "retry_policy": {
    "max_attempts": 3,
    "backoff": "exponential",
    "jitter": 0.2,
    "checkpoint_interval": "per_file"
  }
}
```

| Field | Type | Range | Semantics |
|---|---|---|---|
| `max_attempts` | integer | 1 – 10 | Total attempts including the first. `1` == no retry. `10` is the hard ceiling — retros show beyond this is always a misconfig. |
| `backoff` | enum | `fixed` / `linear` / `exponential` | Wait between attempts. `fixed` = constant 1s. `linear` = N seconds. `exponential` = 2^N seconds, capped at 60s. |
| `jitter` | number | 0.0 – 1.0 | Multiplicative randomization factor. Wait = base × (1 ± jitter × random()). 0 == no jitter (deterministic, replay-friendly), 0.2 == ±20%. |
| `checkpoint_interval` | enum | `none` / `per_file` / `per_turn` | When the runner persists partial state. `none` == retry from scratch. `per_file` == retry resumes after the last completed file edit. `per_turn` == retry resumes after the last completed agent turn (most fine-grained). |

### Default (when `retry_policy` is `null` or absent)

```json
{
  "max_attempts": 3,
  "backoff": "exponential",
  "jitter": 0.2,
  "checkpoint_interval": "per_file"
}
```

This default is tuned for v11's most-common failure modes: API rate-limits (need backoff + jitter), agent-loop transient tool errors (need ≥ 3 attempts), and partial-progress preservation (need at least `per_file`).

## Backoff math

```
attempt 1: 0s wait (immediate)
attempt 2: base_wait[backoff] × (1 + jitter × U(-1, 1))
attempt 3: base_wait[backoff] × scale_factor × (1 + jitter × U(-1, 1))
...
```

| `backoff` | base_wait (attempt 2) | scale on attempt N |
|---|---|---|
| `fixed` | 1s | 1 (always 1s) |
| `linear` | 1s | N (1s, 2s, 3s, 4s, ...) |
| `exponential` | 1s | 2^(N-2) (1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, 60s, 60s) |

`exponential` caps at 60s. Above attempt 7 the wait stays at 60s. This prevents a 10-attempt run from waiting 17 minutes between attempts.

## Retryable vs non-retryable

| Failure | Retryable? | Reason |
|---|---|---|
| HTTP 429 / 503 from model API | Yes | Transient. Backoff + jitter are exactly what these are for. |
| HTTP 5xx other | Yes | Same. |
| Network timeout | Yes | Transient. |
| Tool execution error (shell exit non-zero from tool call) | **No** | The tool's command returning non-zero is a deliberate signal to the agent — wrapping it in retry would mask the signal. The agent loop handles this within its own logic. |
| `verification_cmd` fail | **No** | Postcondition failure. Re-running verification verbatim doesn't change the outcome; user must edit code or postcondition. |
| `precondition_failed` | **No** | Same as above. |
| `budget_exhausted` (ADR-0007) | **No** | More retries → more spend. Halt. |
| Out-of-context-window (token overflow) | **No** | Truncation is structural; retry will re-truncate. User must reduce inputs or pick larger ctx_in. |
| User kill (SIGTERM/SIGINT) | **No** | Explicit user intent. |
| Agent declared task complete but verification failed | **No** | Postcondition path. |

The list is finite by design — adding to "retryable" requires this ADR to be amended. The default is **non-retryable**: only the explicit list retries.

## Jitter rationale

When `n` tasks fail simultaneously (e.g., rate-limit hit Cycle-wide), `jitter > 0` desynchronizes their retries. Without jitter, all `n` tasks wait the same `base_wait`, retry simultaneously, and hit the rate-limit again — the storm propagates.

Default `0.2` (±20%) is sufficient to break the herd for cycles with up to ~50 concurrent tasks. Setting `jitter = 0` is allowed for replay-deterministic environments (CI, debugging) but **the dashboard surfaces a warning** when a Cycle has > 5 active tasks all with `jitter = 0`.

## Checkpoint semantics

| Level | What's persisted between attempts | Resume behavior |
|---|---|---|
| `none` | Nothing. Each attempt starts at the envelope's `intent` with empty history. | Pure retry. Use only for short or read-only tasks. |
| `per_file` (default) | The list of files edited in the prior attempts + their post-edit contents. | New attempt sees "you have already edited X, Y, Z" in its context and continues from there. |
| `per_turn` | Full agent message history + tool calls + tool results from the prior attempt. | New attempt resumes mid-conversation, with the failure presented as the most recent message. Most fine-grained; uses most context tokens. |

`per_turn` is the most expensive option in tokens (the full prior history is replayed into context). Use it for tasks where re-doing tool calls is destructive (e.g. tasks that POST to external APIs — replaying would create duplicates).

`none` is cheapest but throws away progress. Use it for:
- Tasks that complete in < 60 seconds (re-running is faster than checkpoint overhead).
- Read-only tasks (research, search) where progress isn't meaningful.

## Six rejected alternatives

| # | Alternative | Why rejected |
|---|---|---|
| 1 | **Boolean `retry: true/false`** | Doesn't capture how-many or how-fast. Two tasks with different rate-limit envelopes need different policies. |
| 2 | **Per-error-type policies** (`retry_policy: {429: 5x, 503: 3x, ...}`) | Combinatorial; users won't write it. The whitelist of retryable errors (above) covers the discrimination need. |
| 3 | **No jitter (deterministic)** | Causes synchronized retry storms for n-task Cycles. Replay-determinism is preserved by allowing `jitter=0` opt-in, not by removing the feature. |
| 4 | **Unbounded `max_attempts`** | "Eventually it'll work" is a fantasy. Hard ceiling at 10 forces author to reckon with cost — even though clawket can't track it (see ADR-0007), an unbounded retry loop on a Pro/Max plan still consumes wall-clock and rate-limit budget. |
| 5 | **Continuous (real-valued) backoff function** (e.g. user-supplied formula) | Author error surface explodes; debugging becomes "why is wait time 47.3s?". Three named curves cover all observed needs. |
| 6 | **Global retry policy (per-machine)** | Same critique as `assigned_model`: per-task, not per-user. The author of "deploy to production" wants different retries than "rename a variable". |

## Open issues

| # | Issue | Owner |
|---|---|---|
| O1 | Should `checkpoint_interval = per_file` persist via Git stash or via in-memory daemon state? | LM-20 implementation. Git stash is replay-friendly; in-memory is faster. Decide at impl time, not at ADR time. |
| O2 | Multi-tenant rate-limit awareness: when daemon sees rate-limit from one task, should other in-flight tasks proactively backoff? | Out of scope for v1. Possible v2 enhancement; the current per-task jitter handles most observable cases. |
| O3 | Interaction with `blocked` status: if a task hits max_attempts, should it move to `blocked` instead of `done`? | Yes — runner sets task status to `blocked` with a comment "max retries exhausted". Specced; implementation owned by LM-20. |
| O4 | Replay determinism with `jitter > 0`: do we record the random seed per attempt? | Yes. `runs.events` row for each attempt records `wait_seconds` (post-jitter). Replay uses the recorded value, not a fresh roll. |

## Implementation pointers

| Surface | Where | Owner |
|---|---|---|
| Validator | `daemon/src/policy/retry.rs::validate` (new) | LM-20 |
| Wait calculator | `daemon/src/runner/retry.rs::compute_wait` (new) | LM-20 |
| Checkpoint persistence | `daemon/src/runner/checkpoint.rs::save / restore` (new) | LM-20 |
| Retryable-error classifier | `daemon/src/runner/retry.rs::is_retryable(&Error)` | LM-20 |
| `runs.events` records `wait_seconds` per attempt | already there as JSON event | done |
| Inheritance: TIGHTEN_ONLY | `daemon/src/policy/inheritance.rs::is_tighter_or_equal` | LM-20 (spec at LM-134) |
| CLI display | `clawket task envelope view` shows policy + attempts-so-far | M1 |
| Dashboard pill | "3/3 attempts · exp · per_file" badge on task | M1 (RL-U7-04) |

## Backwards compatibility

Existing tasks at migration-002 time have `active_envelope_id = NULL`. They use the **legacy** behavior: max 1 attempt, no checkpoint, no backoff. Authors can opt in by signing an envelope.

Tasks that gained an envelope mid-life: prior runs are *not* counted toward `max_attempts`. The retry counter starts at 0 from the envelope-sign forward. Dashboard surfaces this as "retry tracking started at envelope-sign".

## Verification

```sh
# 1. JSON Schema required-fields covers all 4:
python3 -c "
import json
s = json.load(open('daemon/schemas/envelope-v1.schema.json'))
print('required:', s['properties']['retry_policy']['required'])
"
# Expect: ['max_attempts', 'backoff', 'jitter', 'checkpoint_interval']

# 2. Six rejected alternatives:
grep -cE '^\| [1-6] \|' clawket/docs/adr/0008-retry-policy.md
# Expect: ≥ 6

# 3. Retryable list has at least 3 yes / 7 no entries:
grep -cE '\| Yes \|' clawket/docs/adr/0008-retry-policy.md
grep -cE '\| \*\*No\*\* \|' clawket/docs/adr/0008-retry-policy.md
# Expect: 3 / 7
```

## Approval

Final approval gated by RL-U2-09 (LM-54). Dogfood pass: assign each of the four failure modes (infinite retry, no retry, sync storm, lost work) a real failing-task example and verify the policy + classifier + checkpoint catches them. Until that passes, this ADR remains **Proposed**.
