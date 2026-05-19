---
name: clawket-verify-batch
description: Use during a verification round to dispatch sub-agent batches that reason scenarios against code, emit per-batch TSV evidence, then transcribe the TSV into Clawket tasks via a 16-worker ThreadPoolExecutor. Invoked by `clawket-verify-loop` during round R dispatch.
---

# Sub-agent batch dispatch + bulk sync transcription

Two strictly separated phases. Mixing them collapses the audit trail.

```
[reasoning]                                    [sync]
  N sub-agents in parallel               →       Python ThreadPoolExecutor 16-worker
  (1 agent / 1 unit / ≤ 30 scenarios)            (TSV → DB transcription only)
       ↓                                          ↓
  TSV evidence knowledge                          Clawket task DB
```

**Invariant**: the sync phase carries zero reasoning. It transcribes the status decided by the TSV — nothing else.

## Inputs

- Round number `R`.
- Active cycle ID.
- Unit list with each Unit's scenario knowledge ID + code paths.
- Batch size (default 30, ≤ 30 enforced).

## Phase 1 — Sub-agent batch dispatch (reasoning)

### Batch split

```python
for unit in units:
    scenarios = knowledge_load(unit.scenario_knowledge_id)
    batches = chunk(scenarios, size=30)   # ≤ 30 per batch
    for batch in batches:
        batch_id = generate_ulid()
        spawn_agent(unit, batch, batch_id, R)
```

### Sub-agent dispatch (Claude Code Agent tool)

One sub-agent per batch. Inputs:

- The batch's scenarios (≤ 30).
- Code paths (the Unit's scope of impact).
- Round number `R`.
- `batch_id` (tracked in the TSV).
- Tier routing hint (see below).

Each sub-agent's reasoning procedure:

1. **Given** state → which code state / props / store / route param it maps to.
2. **When** trigger → which function / handler / event in code.
3. **Then** outcome → that function's actual return value / side-effect / render reachability.
4. Reached + correct → `pass`. Unreachable / wrong outcome / missing branch → `defect`. Scenario itself contradicts code intent → `scenario_error`.
5. Put the key `file:line` of the reasoning into the `evidence` field.

### Tier routing

- **default**: Sonnet (scenario-vs-code inference, 80–90% of cases).
- **ambiguous case**: Opus escalation (scenario_error candidates / unclear boundaries).
- **regression-round defect root-cause**: Opus by default.
- Every escalation MUST fill the `escalation_reason` field.

### TSV evidence schema (enforced)

Per batch:

```
qa-U<unit-idx>-r<R>-batch-<batch_id>.tsv
```

Row schema (7 fields, tab-separated):

```
scenario_id<TAB>status<TAB>reasoning<TAB>evidence<TAB>tier_used<TAB>batch_id<TAB>escalation_reason
```

Fields:

- `scenario_id` — must match `US-<DOMAIN>-<NNN>` (regex enforced).
- `status` — `pass` | `defect` | `scenario_error`.
- `reasoning` — code-trace body (Given → When → Then).
- `evidence` — `<file>:<line>`. Required for `defect` and `scenario_error`; recommended for `pass` (gives a baseline for regression diff).
- `tier_used` — `haiku` | `sonnet` | `opus`.
- `batch_id` — groups the rows of one batch.
- `escalation_reason` — required when `tier_used = opus`.

## Phase 2 — Bulk sync transcription (sync only)

### Python ThreadPoolExecutor pattern

```python
from concurrent.futures import ThreadPoolExecutor
import csv
import subprocess

def parse_tsv(path):
    with open(path) as f:
        reader = csv.reader(f, delimiter='\t')
        return [row for row in reader]

def status_to_clawket(status):
    # Pure mapping — no reasoning lives here.
    return {
        'pass': 'done',
        'defect': 'blocked',
        'scenario_error': 'cancelled',
    }[status]

def sync_one(row, target_unit_id):
    scenario_id, status, reasoning, evidence, tier, batch_id, *rest = row
    subprocess.run([
        'clawket', 'task', 'create',
        '--unit', target_unit_id,
        '--scenario-id', scenario_id,
        '--evidence', evidence,
        '--batch-id', batch_id,
        '--type', 'review',
        '--body', f"{reasoning}\n\n[tier={tier}]",
        f"QA-{scenario_id}",
    ], check=True)
    task_id = ...  # parse from create output
    subprocess.run([
        'clawket', 'task', 'update', task_id,
        '--status', status_to_clawket(status),
    ], check=True)

with ThreadPoolExecutor(max_workers=16) as ex:
    futures = [ex.submit(sync_one, row, target_unit_id) for row in all_rows]
    for f in futures:
        f.result()  # raise on error
```

### Sync-phase invariants

- ❌ Calling a sub-agent from inside the sync handler (reasoning inside sync).
- ❌ `if`/`else` branching that decides the status mapping (the TSV decided it).
- ❌ Mutating a row's status during sync (transcription only).
- ✅ Pure string mapping (`pass` → `done`, `defect` → `blocked`, `scenario_error` → `cancelled`).
- ✅ Retry on DB write failure (transcription is idempotent).

## Batch attention dispersion check

Batches larger than 30 scenarios show attention dilution; 30 is the upper bound for trustworthy reasoning.

Heuristic:

- Compare reliability of late-batch scenarios (position ≥ 70%) vs. early-batch (< 30%). If late-batch is materially worse, attention dispersion is suspected.
- Re-dispatch only the late half of the same batch (`batch_id` isolates the cohort).
- If suspicion remains with a batch size < 30, escalate the tier (Sonnet → Opus).

## Self-check

### Dispatch

- [ ] 1 agent / 1 unit / ≤ 30 scenarios.
- [ ] Tier routing chosen (default Sonnet, escalate to Opus when ambiguous).
- [ ] `batch_id` assigned (ULID).

### TSV emission

- [ ] All 7 fields populated.
- [ ] `evidence` (file:line) present for every `defect` and every `scenario_error` row.
- [ ] `scenario_id` matches the `US-<DOMAIN>-<NNN>` regex.

### Bulk sync

- [ ] `ThreadPoolExecutor max_workers ≤ 16`.
- [ ] Zero sub-agent calls inside the sync handler.
- [ ] Status mapping is a pure dict lookup.
- [ ] Failures are retried (transcription is idempotent).

### End of round

- [ ] All batch TSVs are synced to the DB.
- [ ] Task row count equals total TSV row count (1:1 mapping).
- [ ] Every task has `scenario_id`, `evidence`, `batch_id`.

## Reject — anti-patterns

- **Missing scenario_id on a task** — schema NOT NULL rejects it.
- **Batch > 30 scenarios** — dispatch refused (attention dispersion threshold).
- **Missing evidence on a `defect` or `scenario_error` row** — row rejected; re-run.
- **Reasoning called from inside bulk sync** — sync is transcription only; abort immediately.

## Autonomous-run boundary

- No runtime mutation / DB DDL / git ops.
- `ALTER TABLE ADD COLUMN` (non-destructive) is allowed.
- TSV evidence is persisted as `type=evidence, title=Round R evidence — <domain>`.
- Knowledge bodies hold the **current round only** — history goes to cancelled task comments and the audit knowledge.

## Output

- TSV evidence knowledge entries (per unit, per round).
- Clawket task DB rows (1:1 with TSV rows).
- `batch_id` tracking (to isolate suspected attention-dispersion cohorts).
- Hand control back to `clawket-verify-loop` for the convergence judgment.
