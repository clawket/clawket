---
name: clawket-scenario-refine
description: Use when a verification round reports scenario_error rows — decide atomic-split / intent-redefinition / deletion for each scenario, then update the spec knowledge and the audit trail. Scenario refinement for scenario_error rows (atomic split / intent redefinition / deletion).
---

# In-round scenario refinement

Invoked by `clawket-verify-loop` when scenario_error rows are present in the round's TSV.

## Call context

Round R produced TSV rows like:

```
scenario_id: US-DAEMON-API-042
status: scenario_error
reasoning: "The Given clause mixes two assumptions — 'daemon is running' AND 'socket is readable'.
            The two can be checked independently, so an atomic split is required."
evidence: src/daemon/src/server.rs:120
scenario_amendment: "split into US-DAEMON-API-042 (daemon running) + US-DAEMON-API-043 (socket readable)"
```

## Inputs

- Target `scenario_id`s (TSV rows where `status = scenario_error`).
- Each row's `scenario_amendment` proposal.
- The source scenario knowledge (`type=spec`).
- The audit knowledge (`type=note, title=scenario_error audit log <domain>`) — created if absent.

## Procedure

### 1. Validate the amendment reason

The only legitimate reason is **intent mismatch**:

- Accept: two assumptions mixed in one scenario, expected outcome contradicts product vision, scenario was deferred.
- Reject: time / cost / complexity / code-impact size (these are scenario-weakening attempts).

Reasons motivated by time or cost stop the refinement — request user confirmation. Time / cost are not grounds for weakening a scenario; if the code impact is large, register a separate fix plan that covers all affected code paths.

### 2. Three-way disposition (exactly one per scenario)

#### (a) Atomic split (1 → N scenarios)

- Issue new IDs continuing the sequence: `US-<DOMAIN>-<NNN+1>`, `US-<DOMAIN>-<NNN+2>`.
- The original ID is permanently retired (never reused).
- Each new scenario gets its own `As a / I want / So that` + one `Given/When/Then`.
- Trace of the original ID lives only in the cancelled QA task comment.

```
Original (US-DAEMON-API-042):
  As a daemon operator
  I want daemon healthcheck
  So that system state is observable
  Given daemon is running AND socket is readable, When ..., Then ...

After split:
  US-DAEMON-API-042 → permanently retired (no reuse).
  US-DAEMON-API-043: verify daemon process is running.
    Given the daemon PID exists at ~/.cache/clawket/clawketd.pid, When `ps -p <pid>`, Then exit 0.
  US-DAEMON-API-044: verify socket is readable.
    Given the socket file exists, When `read` syscall, Then EAGAIN or data received.
```

#### (b) Intent redefinition (ID preserved)

- Keep the same scenario ID.
- Replace the body (`As a / I want / So that / Given/When/Then`).
- Only the matching ID block in the knowledge changes — no history bleed into the body (the reason goes to the audit knowledge).

```
Original (US-CHESS-PUZZLE-007):
  Then all correct moves are displayed  ← conflicts with product vision (only top-3)

Redefined (same ID):
  Then the top-3 correct moves by priority are displayed
```

#### (c) Deletion (ID permanently retired)

- Deferred to a later major scope / feature dropped.
- The ID is permanently retired (never reused).
- If migrated elsewhere, the new location issues a fresh ID.

```
US-CHESS-PUZZLE-019: deferred to next major scope → ID retired
New knowledge "next-major chess scope" → new ID `US-NEXT-CHESS-001`
```

### 3. Record on the cancelled QA task (permanent trail)

Add a comment to the round's cancelled QA task:

```bash
clawket comment add --task <QA_TASK_ID> --body "<reason body>"
```

Comment format:

```
scenario_error 처리 — <yyyy-mm-dd>
원본 시나리오 ID: US-DAEMON-API-042
분기: atomic 분해 (또는 의도 재정의 / 삭제)
사유: <one line — the specific "intent mismatch" reason>
산출:
- US-DAEMON-API-042 → 영구 비움 (atomic 분해)
- 신규 US-DAEMON-API-043 (데몬 프로세스 실행 검증)
- 신규 US-DAEMON-API-044 (socket readable 검증)
근거 reasoning: <sub-agent reasoning quote>
근거 evidence: src/daemon/src/server.rs:120
```

### 4. Append to the audit knowledge

The audit knowledge accumulates one row per refinement decision (append-only, never edited):

```bash
clawket knowledge create --project <PROJ> --type note --title "scenario_error audit log <도메인>" ...
```

Body row format:

```
| Round | 원본 ID | 분기 | 사유 | 신규 ID(들) | reasoning 인용 |
|---|---|---|---|---|---|
| R3 | US-DAEMON-API-042 | atomic 분해 | 두 가정 섞임 | 043, 044 | sub-agent reasoning |
| R3 | US-CHESS-PUZZLE-007 | 의도 재정의 | 제품 비전 불일치 | (preserved) | ... |
| R3 | US-CHESS-PUZZLE-019 | 삭제 | next major scope 으로 deferred | (none) | ... |
```

### 5. Update the spec knowledge (current intent only)

Edit the source scenario knowledge:

- Atomic split → remove the original ID block, add the new ID blocks.
- Intent redefinition → replace the matching ID block only.
- Deletion → remove the ID block.

The knowledge body never carries a changelog. History lives in the cancelled task comment + the audit knowledge.

### 6. Next round

Hand control back to `clawket-verify-loop` for Round R+1. The refined scenarios are re-evaluated as new tasks in R+1.

## ID integrity (absolute)

- A scenario ID is assigned once and never reused (`US-<DOMAIN>-<NNN>` — the NNN is permanent).
- IDs that were deleted or replaced by an atomic split stay retired (preserves traceability between rounds).
- An atomic split uses the next consecutive NNN after the current maximum.

## Self-check

- [ ] Amendment reason is **intent mismatch** (time / cost / complexity reasons were rejected).
- [ ] Exactly one of the three dispositions was applied.
- [ ] The cancelled QA task has the reason + disposition + new IDs in a comment.
- [ ] The audit knowledge has a new row appended (per round, append-only).
- [ ] The spec knowledge body carries current intent only (zero history bleed).
- [ ] Retired / split-from IDs are permanently empty (never reused).
- [ ] Atomic-split new IDs are consecutive.

## Reject — anti-patterns

- **Merging scenarios under time pressure** → rejected.
- **Weakening a scenario to save tokens** → rejected.
- **Weakening a scenario because the code impact is large** → rejected (register a fix plan that covers the affected code instead).
- **Adding a changelog to the knowledge body** → rejected (use the audit knowledge).
- **Reusing a retired ID** → rejected (NNN is permanent).

## Autonomous-run boundary

- The amendment reason must be **intent mismatch** (never time / cost).
- Any suspicious amendment requires user confirmation.
- No runtime / DB DDL / git operations.

## Output

- Updated spec knowledge (current intent only).
- Audit knowledge (append-only).
- Cancelled QA task comment.
- Signal back to `clawket-verify-loop` for Round R+1.
