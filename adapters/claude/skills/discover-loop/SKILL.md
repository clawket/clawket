---
name: discover-loop
description: 발견-수렴 루프 메인 엔진 — Round R sub-agent dispatch + TSV evidence emit + bulk sync transcription + 3-way 수렴 판정 + 다음 라운드 schedule. PDD-cycle skill 대체. ~/.claude/rules/pdd.md + qa-flow.md v3.0 distill 룰을 적용.
---

# /discover-loop — 발견-수렴 루프 메인 엔진

PDD v3.0 + qa-flow v3.0 의 통합 운영 인터페이스. `clawket discover-loop` (alias: `dl`)
CLI 서브커맨드로 자동화된다.

## CLI 명령 시그니처

```bash
# A. Plan/cycle/unit 자동 생성 (DOGFOOD-001~010)
clawket discover-loop start \
  --project <PROJECT_ID> \
  --domain "Dogfood" \
  --round 1 \
  --areas "대시보드,CLI,Daemon" \
  [--description "optional"]

clawket discover-loop next-round \
  --previous-plan <PLAN_ID> \
  [--domain <override>] \
  [--areas "area1,area2"] \
  [--round <N>]

# B. Dispatch 메타데이터 + TSV schema 검증 (DOGFOOD-011~020)
clawket discover-loop dispatch-plan \
  --plan <PLAN_ID> \
  [--batch-size 30]          # PDD A8 cap: 30

clawket discover-loop verify-tsv <path/to/qa-U01-r1.tsv>
# exits 0 = valid, 1 = validation errors

clawket discover-loop batch-id
# → { "batch_id": "BATCH-<26-char-ULID>" }

# C. Bulk sync transcription (DOGFOOD-021~030)
clawket discover-loop sync <path/to/qa-U01-r1.tsv> \
  --unit <UNIT_ID> \
  --cycle <CYCLE_ID> \
  [--assignee "sub-agent-1"]

# D. 3-way 수렴 판정 (DOGFOOD-031~040)
clawket discover-loop status \
  [--plan <PLAN_ID>] \
  [--project <PROJECT_ID>]

clawket discover-loop converged \
  [--plan <PLAN_ID>] \
  [--project <PROJECT_ID>]
# exits 0 = converged (2 consecutive zero rounds), 1 = not converged

clawket discover-loop rounds <PROJECT_ID>
# → rounds list with per-round counts (monotone-decrease graph)
```

## TSV Evidence Schema (v3.0 — 7 fields, TAB-separated)

```
scenario_id<TAB>status<TAB>reasoning<TAB>evidence<TAB>tier_used<TAB>batch_id<TAB>escalation_reason
```

| Field | 형식 | 필수 조건 |
|-------|------|-----------|
| scenario_id | `US-<DOMAIN>-<NNN>` | 항상 필수 (X3) |
| status | `pass\|defect\|scenario_error` | 항상 필수 |
| reasoning | free text | 항상 필수 |
| evidence | `file:line` or summary | **모든 status 에 필수** (R2 DOGFOOD-043) |
| tier_used | `haiku\|sonnet\|opus` | 항상 채움 (비용 추적) |
| batch_id | `BATCH-<26-char-ULID>` | 항상 필수 (R2 DOGFOOD-044) |
| escalation_reason | free text | `tier_used=opus` 일 때 필수 (qa-flow §2.5) |

6 필드 legacy TSV 도 backward-compat 으로 받지만 verify-tsv 가 schema_version
경고를 emit. 신규 sub-agent 는 7 컬럼 emit 강제.

## 상태 매핑 (X9 anti-pattern 방지 — sync 안에서 reasoning 0)

| TSV status | task.status | task.qa_status |
|------------|-------------|----------------|
| pass | done | pass |
| defect | blocked | defect |
| scenario_error | cancelled | scenario_error |

## 수렴 조건 (qa-flow §7)

- defect = 0 + scenario_error = 0 + 2 라운드 연속
- `clawket discover-loop converged` → exit 0 (수렴) / exit 1 (미수렴)

## 발견-수렴 루프 운영 절차

### Phase 2 — Round R 한 번

```bash
# 1. Round R plan + cycle + units 자동 생성
clawket discover-loop start \
  --project PROJ-xxx --domain "Dogfood" --round 1 \
  --areas "대시보드,CLI,Daemon"

# 2. dispatch-plan 으로 batch manifest 확인
clawket discover-loop dispatch-plan --plan PLAN-xxx --batch-size 30
# → batch_ids 목록 (sub-agent 에 전달)

# 3. Sub-agent dispatch (Claude Code agent tool 영역)
#    각 agent → TSV evidence emit (qa-U01-r1.tsv, qa-U02-r1.tsv, ...)
#    1 agent / 1 unit / ≤ 30 scenarios (PDD A8)

# 4. TSV 검증
clawket discover-loop verify-tsv qa-U01-r1.tsv

# 5. Bulk sync transcription (reasoning ≠ sync, X9 방지)
clawket discover-loop sync qa-U01-r1.tsv \
  --unit UNIT-xxx --cycle CYC-xxx

# 6. 수렴 판정
clawket discover-loop status --plan PLAN-xxx
clawket discover-loop converged --plan PLAN-xxx || \
  clawket discover-loop next-round --previous-plan PLAN-xxx
```

## Anti-pattern 거부

| Code | 설명 | 방어 위치 |
|------|------|-----------|
| X3 | scenario_id NULL task 생성 | agent task-created hook 차단 |
| X7 | batch_size > 30 (A8 위반) | dispatch-plan manifest에 x7_violation 플래그 |
| X8 | evidence 부재 (모든 status) | verify-tsv + sync 양쪽 거부 (R2 DOGFOOD-043) |
| X9 | sync 안에서 reasoning | sync handler 에 reasoning 코드 0 |

## Agent-side procedures (R2 DOGFOOD distill)

데몬이 deterministic state, **agent 가 LLM judgement** 영역. 데몬이 의도적으로
구현하지 않는 항목들 — sub-agent / skill 이 직접 수행:

- **A. Sub-agent dispatch**: dispatch-plan manifest 의 batch_ids 로 Agent tool
  spawn (1 agent / 1 unit / ≤30 시나리오). x7_violation 시 dispatch 중단.
- **B. Attention-dilution**: 같은 batch 후반/전반 결함률 Δ ≥ 0.15 시 Opus
  escalation + escalation_reason TSV 7번째 컬럼 채움.
- **C. /scenario-refine 자동**: status 응답에 scenario_error_count > 0 즉시
  슬래시 호출. cancelled task body 의 scenario_amendment 를 입력으로 atomic
  분해 / 의도 재정의 / 삭제 결정.
- **D. Plan body convergence**: converged exit 0 시 plan body 에 수렴
  sub-section append (R-1, R 카운트 + ISO timestamp).
- **E. /loop ScheduleWakeup**: 1200s delay R+1 dispatch. 데몬은 schedule
  상태 보유 안함.
- **F. Regression auto-task**: status.regression=true 시 fix plan R unit 에
  `[REGRESSION-INVESTIGATION]` task 등록 + 사용자 confirm.

## 자율 Run 정책 (PDD O8)

discover-loop 자동화 중 절대 하지 않는다:
- DB DROP / DELETE / TRUNCATE
- git reset / commit / push / tag / release
- 2.x 런타임 상태 수정 (`~/.local/share/clawket/` 등)

## Daemon API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/discover-loop/start` | Plan + cycle + units 자동 생성 |
| POST | `/discover-loop/next-round` | 다음 라운드 plan 자동 생성 |
| GET | `/discover-loop/dispatch-plan` | Batch manifest 출력 |
| POST | `/discover-loop/verify-tsv` | TSV schema 검증 |
| POST | `/discover-loop/batch-id` | BATCH-ULID 생성 |
| POST | `/discover-loop/sync` | TSV → DB 벌크 sync |
| GET | `/discover-loop/status` | 수렴 상태 + regression 감지 |
| GET | `/discover-loop/converged` | last-2-rounds-zero 판정 |
| GET | `/discover-loop/rounds/:project_id` | 라운드별 카운트 목록 |
