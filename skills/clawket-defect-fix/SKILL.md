---
name: clawket-defect-fix
description: Use when a verification round reports defect rows — register a fix task per defect under the defect-resolution plan's Round R Unit, apply the code change there (never in the QA plan), and verify the Done proposition is externally checkable. Invoked by `clawket-verify-loop` when defect rows are present in the round's TSV.
---

# Defect → fix-task

Invoked by `clawket-verify-loop` when defect rows are present in the round's TSV.

## Call context

Round R produced TSV rows like:

```
scenario_id: US-DAEMON-API-017
status: defect
reasoning: "GET /health should return 503 (not 200) while the daemon is still initializing, but the current code always returns 200."
evidence: daemon/src/routes/health.rs:42
defect_task: (to be created)
```

## Inputs

- Round number `R`.
- TSV rows where `status = defect` (each row carries `scenario_id`, `reasoning`, `evidence`).
- The defect-resolution Plan ID (`<domain> QA 이슈 해결` plan — created if absent).
- The Round R Unit ID inside that fix plan (created if absent).
- Active Cycle ID.

## Procedure

### 1. Secure the defect-resolution Plan

The fix plan is **shared across all rounds** (one plan per domain — not per round).

```bash
clawket plan list --project <PROJ_ID> | grep "<도메인> QA 이슈 해결"

# If absent
clawket plan create "<도메인> QA 이슈 해결" --project <PROJ_ID>
clawket plan approve <FIX_PLAN_ID>
```

### 2. Secure the Round R Unit

One unit per round inside the fix plan (`Round N` title):

```bash
clawket unit list --plan <FIX_PLAN_ID> | grep "Round $R"

# If absent
clawket unit create "Round $R" --plan <FIX_PLAN_ID> --mode sequential
```

### 3. Register a fix task (one per defect row)

```bash
clawket task create "FIX: <one-line defect summary>" \
  --unit <FIX_UNIT_ID> \
  --cycle <FIX_CYCLE_ID> \
  --scenario-id <SCENARIO_ID> \
  --evidence "<evidence file:line>" \
  --type code \
  --body "<reasoning body>\n\n원본 QA task: <QA_TASK_ID>"
```

Task quality rules (applied here):

- Title starts with a single verb phrase (`FIX: …`).
- Done definition is externally verifiable — e.g., "in Round R+1, the matching scenario judgment is `pass`".
- `type = code`.
- `scenario_id` is required (the scenario whose intent is violated).
- `evidence` is required (`file:line` lifted from the TSV).

### 4. Link the fix-task ID into the original QA task

```bash
clawket comment add --task <QA_TASK_ID> \
  --body "defect → fix task: <FIX_TASK_ID>\nevidence: <file:line>\nreasoning: <summary>"
```

### 5. Code change (fix task in_progress)

```bash
clawket task update <FIX_TASK_ID> --status in_progress
```

Code-change discipline:

- **No code change inside the QA plan.** The QA plan is reasoning-only. All code edits happen inside this fix task.
- Smallest reasonable scope: start from the evidence `file:line` and trace outward only as needed.
- After the change, verify the Done proposition by code inference — would Round R+1 judge this scenario as `pass`?

### 6. Close the fix task

```bash
clawket task update <FIX_TASK_ID> --status done \
  --evidence "<file:line of the fix>" \
  --comment "수정 위치: <file:line>\n수정 내용: <한 줄>\nDone 검증: <code inference>"
```

## Hand-off to Round R+1

When every defect's fix task is `done`, return control to `clawket-verify-loop` for Round R+1 sub-agent dispatch. R+1 re-evaluates the same scenarios as fresh tasks.

## Fix-task Done definition

The Done proposition must not be self-referential. Reject "fix complete" / "implementation done"; restate as an external proposition:

- "Round R+1 judges `US-<DOMAIN>-<NNN>` as `pass`."
- "After the change, the Given → When → Then trace reaches the expected outcome cleanly."

## Self-check

- [ ] One fix task per defect row (1:1).
- [ ] Each fix task has `scenario_id`.
- [ ] Each fix task has `evidence` (`file:line`).
- [ ] Done definition is externally verifiable (not self-referential).
- [ ] The original QA task has a comment linking to the fix task ID.
- [ ] Fix plan title is `<domain> QA 이슈 해결` (one shared plan).
- [ ] Fix unit title is `Round R` (one unit per round).

## Reject — anti-patterns

- Code change inside the QA plan → rejected.
- Code change without a tracking fix task → rejected (no audit trail).
- Done = "code change complete" → rejected (restate as an external proposition).
- Fix task missing `scenario_id` → rejected.
- Fix task missing `evidence` → rejected.

## Autonomous-run boundary

- No runtime / DB DDL / git operations.
- Code edits happen only while the fix task is `in_progress` (the Clawket hook enforces this).
- `ALTER TABLE ADD COLUMN` (non-destructive) is allowed.

## Output

- List of fix tasks (registered in the defect-resolution plan's Round R Unit).
- Original QA task ↔ fix task mapping.
- Signal back to `clawket-verify-loop` for Round R+1.
