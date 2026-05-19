---
name: clawket-verify-loop
description: Use to run a verification round end-to-end — dispatch sub-agent batches, collect 7-field TSV evidence, transcribe into Clawket tasks, render the 3-way convergence judgment, and either schedule the next round or close the loop. Verification round runner — sub-agent dispatch + convergence judgment.
---

# Verification round runner

Run Round `R` for an active Plan + Cycle. Inputs come from `clawket-scenario-author` (intent) and `clawket-plan-design` (Plan + Units).

## Model

```
Round R = scenario refinement + code verification, evolving together.
Both layers converge when defect = 0 AND scenario_error = 0 for 2 consecutive rounds.
```

Neither code nor scenarios are sacred — either may be updated when intent and behavior diverge. The only legitimate amendment reason for a scenario is **intent mismatch**; time / cost / complexity / code-impact size are rejected.

## Inputs

- Active Plan ID (from `clawket-plan-design`).
- Active Cycle ID (`clawket cycle create` + `clawket cycle activate`).
- Round number `R`.
- Unit list + each Unit's scenario knowledge ID.

## Procedure

### 1. Round entry checks

- Active Plan exists.
- Active Cycle exists (if not, create + activate).
- Spot-check that each Unit's scenario knowledge holds **only the current intent** (no history bleed, no changelog).

### 2. Sub-agent batch dispatch

One sub-agent per batch; batch size ≤ 30 scenarios (above 30, attention dilution sets in).

```
for unit in units:
  scenarios = knowledge_load(unit.scenario_knowledge_id)
  batches = chunk(scenarios, size=30)
  for batch in batches:
    batch_id = generate_ulid()
    spawn_subagent(
      type="qa-reasoner",
      input={
        "scenarios": batch,
        "code_paths": unit.code_paths,
        "round": R,
        "unit_id": unit.id,
        "batch_id": batch_id,
      },
      output_format="TSV",
    )
```

Sub-agent output is **never synced immediately** — it accumulates into TSV evidence knowledge per batch.

### 3. TSV evidence schema (7 fields)

One row per scenario judgment:

```
scenario_id<TAB>status<TAB>reasoning<TAB>evidence<TAB>tier_used<TAB>batch_id<TAB>escalation_reason
```

Enforced:

- `scenario_id` — `US-<DOMAIN>-<NNN>` (regex). Reject any task missing a scenario_id.
- `status` — `pass` | `defect` | `scenario_error`.
- `reasoning` — Given → When → Then code trace. Always required.
- `evidence` — `<file>:<line>`. Required for every row (even `pass`, to give regression baseline).
- `tier_used` — `haiku` | `sonnet` | `opus`. Always populated.
- `batch_id` — `BATCH-<26-char-ULID>`. Required on every row.
- `escalation_reason` — required when `tier_used = opus`.

Reject any batch over 30 scenarios. Reject any `defect` or `scenario_error` row without evidence. Sync code MUST NOT contain reasoning — the TSV decided status; sync only transcribes.

### 3a. Hook policy (agent-side enforcement)

The daemon's `verify-tsv` / `dispatch-plan` endpoints do schema-level guards only. Agent-side `task-created` / `task-updated` PostToolUse hooks block the operational anti-patterns:

| Condition | Action |
|---|---|
| `tasks.scenario_id IS NULL` on a new task | cancel + comment |
| `dispatch-plan` manifest reports `x7_violation=true` (batch > 30) | abort dispatch |
| TSV row missing `evidence` | sync rejected by daemon |
| Reasoning called inside bulk-sync handler | caught by code review / lint |

Hooks live in `clawket/adapters/claude/`. Bypass requires explicit user consent.

### 4. Bulk sync transcription (reasoning ≠ sync)

When all sub-agent TSVs have arrived, sync **separately** — no reasoning in this phase.

**Recommended path**: one call.

```
clawket discover-loop sync <tsv> --unit U --cycle C
```

The daemon does the status mapping (`pass → done` / `defect → blocked` / `scenario_error → cancelled`), extracts `scenario_amendment`, persists `escalation_reason`, produces a retry queue knowledge, and writes the Round R evidence knowledge — all in one transaction.

**Streaming mode (large rounds, ≥ 1000 rows)** — sync each 30-scenario batch as soon as its TSV arrives:

```python
from concurrent.futures import ThreadPoolExecutor
import subprocess, pathlib

def sync_batch(tsv_path: pathlib.Path, unit_id: str, cycle_id: str):
    # No reasoning here. Status comes from the TSV, untouched.
    subprocess.run(
        ["clawket", "discover-loop", "sync", str(tsv_path),
         "--unit", unit_id, "--cycle", cycle_id],
        check=True,
    )

with ThreadPoolExecutor(max_workers=16) as ex:
    list(ex.map(lambda b: sync_batch(b.tsv, b.unit_id, b.cycle_id), batches))
```

The daemon's `bulk_sync` has no branching beyond the status mapping.

For the operational pattern (dispatch + sync), delegate to `clawket-verify-batch`.

### 5. 3-way convergence judgment

At round end:

```
clawket discover-loop status --plan PLAN-...
```

The daemon counts using `tasks.qa_status` OR `tasks.status` (lock-step, so partial column drift doesn't skew the count).

Branch on the result:

- **`defect ≥ 1`** → hand defect rows to `clawket-defect-fix` (the defect → fix-task skill). When the fix tasks transition to `done`, the original QA tasks auto-unblock.
- **`scenario_error ≥ 1`** → hand scenario_error rows to `clawket-scenario-refine` (the 3-way scenario refinement skill). Procedure:
  1. Read the cancelled QA task body's `scenario_amendment` field.
  2. Decide one of: atomic split / intent redefinition / deletion.
  3. Update the scenario knowledge (current intent only — zero history bleed).
  4. Append to the audit knowledge (`type=note, title=scenario_error audit log <domain>`).
- **`defect = 0` AND `scenario_error = 0`**:
  - `clawket discover-loop converged --plan PLAN-...` returns exit 0 → **loop done**. The Plan body gets a convergence sub-section auto-appended (per-round counts; proof of two consecutive zero-rounds).
  - Otherwise → schedule Round `R+1`.

### 5a. Regression detection (auto-task)

If Round R's defect count exceeds Round R-1's (the status response reports `regression=true`), **immediately register a priority `[REGRESSION-INVESTIGATION]` task** in the fix plan's Round R Unit and request user confirmation. Monotone decrease is the healthy pattern; an increase signals that a fix introduced new defects.

### 6. Schedule the next round

```
clawket discover-loop next-round --previous-plan PLAN-R
```

The daemon:

1. Auto-completes the previous Plan's active cycles.
2. Guards against re-running on a converged Plan (400 `ALREADY_CONVERGED`).
3. Creates Round `R+1` plan + cycle + Units using the inferred domain / areas.

```
ScheduleWakeup(
  delaySeconds=1200,
  prompt="clawket-verify-loop",
  reason="round R+1 dispatch after defect/scenario_error processing"
)
```

For synchronous progression, use `/loop`.

## Agent-side procedures

The daemon owns deterministic state; this skill owns the LLM-judgment areas.

### A. Sub-agent dispatch (1 agent / 1 unit / ≤ 30 scenarios)

After `clawket discover-loop dispatch-plan --plan PLAN-... --batch-size 30` returns the manifest (with batch_ids), spawn sub-agents:

```
for unit_info in manifest.units:
  for batch_id in unit_info.batch_ids:
    spawn_subagent(
      type="qa-reasoner",
      prompt=read_scenarios_for_batch(unit_info, batch_id),
      output_format="TSV (7 fields)",
    )
```

Abort dispatch when the manifest reports `x7_violation=true` (batch > 30).

### B. Attention-dilution self-check + tier escalation

The sub-agent self-checks whether late-batch rows show a defect-rate delta ≥ 0.15 vs. early-batch rows. On suspicion, **escalate to Opus** and write `escalation_reason="attention dilution batch=<batch_id>"` into the TSV's 7th column.

When the batch size exceeds 30 (which shouldn't happen but is a guard), the late half is re-dispatched on a different sub-agent at Opus tier.

### C. Auto-dispatch to `clawket-scenario-refine`

When the `status` response reports `scenario_error_count > 0`, immediately invoke `clawket-scenario-refine`. Its input is the cancelled QA task's `scenario_amendment` field. The decision rationale gets recorded in two places:

1. Cancelled QA task comment (permanent).
2. Audit knowledge (`type=note, title=scenario_error audit log <domain>`), append-only across rounds.

The scenario knowledge body itself carries the **current intent only** — no history.

### D. Plan body convergence record

When `converged --plan PLAN-...` exits 0, append this sub-section to the Plan body:

```markdown
## Convergence (Round <R> closed)

- Last two rounds: R-1 (defect=0 / scenario_error=0), R (defect=0 / scenario_error=0)
- Evidence: `clawket discover-loop rounds <PROJECT_ID>` shows a monotone-decreasing curve.
- Closed at: <ISO timestamp>
```

The daemon only exposes the `plan.description` update API; the wording is the agent's responsibility.

### E. `/loop` ScheduleWakeup

When convergence is not yet reached, schedule the next dispatch with a 1200s delay. The wakeup API call is on the agent side — the daemon holds no schedule state.

## Round termination

- **Single round done**: all sub-agent batch TSVs are synced AND the convergence judgment is recorded.
- **Cycle done**: convergence condition met (defect = 0 AND scenario_error = 0 for 2 consecutive rounds).
- **Plan done**: every Unit's cycle is `done`.

## Reject — anti-patterns

- Task missing `scenario_id` → schema NOT NULL.
- Batch > 30 scenarios → dispatch refused.
- `defect` or `scenario_error` row missing `evidence` (file:line) → row rejected.
- Reasoning inside the bulk-sync handler → abort.

## Autonomous-run boundary

- No writes to user-data paths (`~/.local/share/clawket/`, `~/.cache/clawket/`, `~/.config/clawket/`, `~/.local/state/clawket/`, `~/.claude/plugins/clawket-*/`).
- No `DB DROP` / `DELETE` / `TRUNCATE`.
- No `git reset` / `commit` / `push` / `tag` / `release`.
- No direct SQL DDL on `~/.local/share/clawket/db.sqlite`.
- `ALTER TABLE ADD COLUMN` (non-destructive) is allowed. Any violation requires user confirmation.

## Output

- Round `R` TSV evidence knowledge (`type=evidence, title=Round R evidence — <domain>`).
- Round `R` QA tasks (synced into the cycle).
- Convergence verdict: `continue` | `converged` | `blocked`.
- Schedule for Round `R+1` (when needed).

## Self-check

### Round start

- [ ] Active Plan + active Cycle both exist.
- [ ] Scenario knowledge holds current intent only (zero history bleed).
- [ ] Sub-agent batch size ≤ 30 scenarios.

### Round end

- [ ] Every TSV row passes the 7-field schema.
- [ ] Every row has `evidence` (`file:line`).
- [ ] Every `tier_used = opus` row has `escalation_reason`.
- [ ] Every row has `batch_id`.
- [ ] Zero reasoning calls inside the bulk-sync handler.
- [ ] The 3-way convergence verdict was recorded (the `status` response JSON is preserved).
- [ ] On regression, the `[REGRESSION-INVESTIGATION]` task is registered and user confirmation is requested.
