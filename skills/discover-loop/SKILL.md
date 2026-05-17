---
name: discover-loop
description: 발견-수렴 루프 메인 엔진 — Round R sub-agent dispatch + TSV evidence emit + bulk sync transcription + 3-way 수렴 판정 + 다음 라운드 schedule. Clawket plugin 정본 skill. RULE.md (pdd.md + qa-flow.md) 적용.
---

# /discover-loop — 발견-수렴 루프 메인 엔진

PDD + qa-flow 의 통합 운영 인터페이스. 발견-수렴 루프 본체.
`/scenario-author` (Phase 0) 와 `/pdd-plan` (Phase 1) 산출물을 입력으로 받아
Round R 사이클을 운영한다.

## 핵심 모델

```
Round R = 시나리오층 정련 + 코드층 검증 동시 진행.
양 layer 가 수렴 조건 (defect=0 + scenario_error=0 + 2 라운드 연속) 까지 공진화.
```

코드와 시나리오 중 어느 한쪽도 신성하지 않다 — 둘 다 의도와 어긋나면 갱신 대상.
시나리오 갱신 사유는 "의도 부적절" 한정 (qa-flow.md §3 #6).

## 입력

- 활성 Plan ID (`/pdd-plan` 산출)
- 활성 Cycle ID (`clawket cycle create` 후 `clawket cycle activate`)
- 라운드 번호 R
- 처리할 Unit 목록 + 각 Unit 의 시나리오 knowledge ID

## 처리 절차 (Round R 한 번 = 한 cycle)

### 1. Round R 진입 검증

```
- 활성 Plan 존재 확인
- 활성 Cycle 존재 확인 (없으면 새로 생성 + activate)
- 처리할 Unit 의 시나리오 knowledge 가 *현재 의도* 만 담고 있는지 spot-check
```

### 2. Sub-agent batch dispatch

각 Unit 마다 sub-agent 1개 dispatch. 1 agent ≤ 30 시나리오 (30 초과 시
attention dilution 위험).

```
for unit in units:
  scenarios = knowledge_load(unit.scenario_knowledge_id)
  batches = chunk(scenarios, size=30)   # ≤ 30 / batch
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

Sub-agent 의 reasoning 산출물은 즉시 sync 하지 않고 **TSV 로 batch evidence
knowledge 에 누적** (qa-flow.md §2).

### 3. TSV evidence schema (7 필드)

각 row = 1 시나리오 판정 결과:

```
scenario_id<TAB>status<TAB>reasoning<TAB>evidence<TAB>tier_used<TAB>batch_id<TAB>escalation_reason
```

필드 강제:
- `scenario_id`: `US-<DOMAIN>-<NNN>` 형식 (regex 검증, X3)
- `status`: `pass | defect | scenario_error` 중 하나
- `reasoning`: 코드 추론 본문 (Given→When→Then 트레이스). 항상 필수.
- `evidence`: `<file>:<line>` 또는 reasoning 요약. **모든 status 에 필수**
  (pass 도 회귀 비교 기준선 보존을 위해 file:line 인용).
- `tier_used`: agent tier (`haiku|sonnet|opus`) — 비용 추적용. 항상 채움.
- `batch_id`: `BATCH-<26-char-ULID>` — 동일 batch 묶음 추적용. 모든 row 에 필수.
- `escalation_reason`: `tier_used=opus` 일 때 필수 (qa-flow §2.5). sonnet/haiku
  에선 선택.

evidence 부재 = X8 anti-pattern (qa-flow §2). verify-tsv + sync 양쪽에서 거부.

### 3a. Hook policy (X3/X7/X8/X9 강제 — agent 측 설치)

Daemon 의 verify-tsv / dispatch-plan 은 schema 가드만 한다. **agent 측 `task-
created` / `task-updated` PostToolUse 후크가 anti-pattern 을 차단**한다:

| Code | Hook 차단 조건 | 처리 |
|------|---------------|------|
| X3 | `tasks.scenario_id` IS NULL 인 신규 task 생성 시도 | 즉시 cancel + comment |
| X7 | dispatch-plan manifest `x7_violation=true` (batch>30) | dispatch 중단 |
| X8 | TSV row 의 `evidence` 빈 칸 | sync 거부 (daemon 단에서) |
| X9 | bulk sync handler 안에서 reasoning 호출 시도 | code review/lint |

후크 본체는 `clawket/adapters/claude/` 에 추가. 우회는 사용자 명시 동의 시에만.

### 4. Bulk sync transcription (reasoning ≠ sync)

TSV evidence knowledge 가 모든 sub-agent 로부터 모이면, **별도 단계**로 bulk sync.

**권장 경로**: `clawket discover-loop sync <tsv> --unit U --cycle C` 한 번
호출 — 데몬이 status 매핑 (pass→done / defect→blocked / scenario_error→
cancelled) + scenario_amendment 추출 + escalation_reason persistence + retry
queue knowledge + Round R evidence knowledge 를 한 트랜잭션 안에서 처리.

**대규모 라운드 (≥1000 row)**: ThreadPoolExecutor 패턴은 1 sub-agent 가 30
시나리오 batch 를 마치자마자 바로 sync 하는 streaming 모드용. 하나의 큰 TSV
이면 위 단일 호출이 더 안전.

```python
# Streaming 모드 (옵셔널) — sub-agent 별 도착 즉시 sync
from concurrent.futures import ThreadPoolExecutor
import subprocess, pathlib

def sync_batch(tsv_path: pathlib.Path, unit_id: str, cycle_id: str):
    # X9 강제: 이 함수 안에 reasoning 결정 0줄. status 는 TSV 그대로.
    subprocess.run(
        ["clawket", "discover-loop", "sync", str(tsv_path),
         "--unit", unit_id, "--cycle", cycle_id],
        check=True,
    )

with ThreadPoolExecutor(max_workers=16) as ex:
    list(ex.map(lambda b: sync_batch(b.tsv, b.unit_id, b.cycle_id), batches))
```

**불가침**: bulk sync 안에서 reasoning 을 다시 호출하지 않는다 (X9 anti-pattern,
qa-flow §2). sync 는 transcription 전용. 데몬의 `bulk_sync` 는 status 매핑
이외의 분기를 가지지 않는다.

### 5. 3-way 수렴 판정

라운드 종료 시 `clawket discover-loop status --plan PLAN-...` 호출. 데몬은
**`tasks.qa_status` OR `tasks.status` fallback** 으로 카운트한다. 두 컬럼이
lock-step 이라 어느 컬럼이 부분 누락돼도 수치는 일관.

분기 (skill agent 가 status JSON 받아 결정):
- **defect ≥ 1** → `/qa-fix` 호출 (결함 해결 plan 의 라운드 R unit 에 fix task
  등록). fix task 가 done 으로 cascade 되면 QA task 가 자동 unblock.
- **scenario_error ≥ 1** → `/scenario-refine` 호출 자동 트리거. 처리 절차:
  1. cancelled QA task body 의 `scenario_amendment` 필드를 읽는다.
  2. 3-way 분기: atomic 분해 / 의도 재정의 / 삭제 결정.
  3. 시나리오 knowledge 갱신 (현재 의도만 — 히스토리 흔적 0).
  4. audit knowledge 에 누적 기록 (`type=note, title=scenario_error audit log <도메인>`).
- **defect=0 + scenario_error=0**:
  - `clawket discover-loop converged --plan PLAN-...` exit 0 → **수렴 종료**.
    Plan body 에 수렴 sub-section 자동 append (data: 라운드별 카운트, 마지막
    2 라운드 0 증명).
  - 그 외 → 다음 라운드 R+1.

### 5a. 회귀 감지 (regression auto-task)

라운드 R 의 defect 수가 R-1 보다 크면 (`status` 응답의 `regression=true`)
**즉시 fix plan 의 R unit 에 `[REGRESSION-INVESTIGATION]` 우선 task 자동
등록** 후 사용자 confirm 요청. 단조 감소가 정상 패턴, 증가는 결함 수정이 새
결함을 만든 신호.

### 6. 다음 라운드 schedule

수렴 미도달 시 `clawket discover-loop next-round --previous-plan PLAN-R` 호출.
데몬:
1. previous plan 의 active cycle 들을 자동 complete.
2. ALREADY_CONVERGED 가드 — converged plan 에 next-round 호출 시 400 거부.
3. inferred domain/areas 로 Round R+1 plan + cycle + units 생성.

```
ScheduleWakeup(
  delaySeconds=1200,   # 캐시 윈도 외, 1 라운드 R+1 준비
  prompt="/discover-loop",
  reason="round R+1 dispatch after defect/scenario_error processing"
)
```

또는 사용자 동기 진행 시 `/loop` 슬래시 명령으로 즉시 R+1.

## Agent-side procedures

데몬이 deterministic state 를 책임지고, **skill agent 가 LLM judgement 가 필요
한 영역**을 책임진다. 다음은 데몬이 *의도적으로* 구현하지 않는 항목들이다 —
sub-agent 가 직접 수행한다:

### A. Sub-agent dispatch (1 agent / 1 unit / ≤30 시나리오)

`clawket discover-loop dispatch-plan --plan PLAN-... --batch-size 30` 으로
manifest (batch_ids 포함) 를 받은 뒤, **Claude Code Agent tool 영역**에서:

```
for unit_info in manifest.units:
  for batch_id in unit_info.batch_ids:
    spawn_subagent(
      type="qa-reasoner",
      prompt=read_scenarios_for_batch(unit_info, batch_id),
      output_format="TSV (7 fields)",
    )
```

`x7_violation=true` 일 때 dispatch 중단 (X7).

### B. Attention-dilution 측정 + tier escalation

같은 batch 의 후반 row 가 전반 row 대비 결함률 Δ ≥ 0.15 인지 sub-agent 자가
점검. 의심 시 **Opus 로 escalation** + `escalation_reason="attention dilution
batch=<batch_id>"` TSV 7번째 컬럼에 박는다.

batch 크기 30 초과 시 attention dilution 위험 — 같은 batch 의 후반만 재 dispatch
(다른 sub-agent + Opus).

### C. /scenario-refine 자동 dispatch

`status` 응답의 `scenario_error_count > 0` 시 즉시 `/scenario-refine` 슬래시
호출. cancelled QA task 의 `scenario_amendment` 를 입력으로 받아 atomic
분해 / 의도 재정의 / 삭제 결정. 결정 사유는:
1. cancelled QA task comment (영구) — qa-flow §3 #5
2. audit knowledge (`type=note, title=scenario_error audit log <도메인>`) 누적

knowledge 본체에는 *현재 의도만* (history 흔적 금지).

### D. Plan body convergence 기록

`converged --plan PLAN-...` exit 0 시 plan body 에 다음 sub-section append:

```markdown
## 수렴 (Round <R> 종료)

- 마지막 2 라운드: R-1 (defect=0 / scenario_error=0), R (defect=0 / scenario_error=0)
- 증거: `clawket discover-loop rounds <PROJECT_ID>` 단조 감소 그래프
- 종료 시각: <ISO timestamp>
```

데몬은 plan.description 갱신 API 만 노출 (자동 채움 외엔 agent 가 판단).

### E. /loop ScheduleWakeup

수렴 미달 시 1200s delay 로 다음 라운드 dispatch. `claude-code` 의 wakeup
API 호출은 agent 측에서 수행. 데몬은 schedule 상태를 가지지 않는다 — 단순
stateless API.

## 라운드 종료 조건

- 단일 라운드 종료: 그 라운드의 모든 sub-agent batch TSV sync 완료 + 수렴 판정 완료
- Cycle 완료: 수렴 조건 만족 (defect=0 + scenario_error=0 + 2 라운드 연속)
- Plan 완료: 모든 Unit 의 cycle 이 done

## Anti-pattern 거부 (PDD + qa-flow 동기화)

- **X3** (PDD): scenario_id 환원 불가 task → schema 차원에서 NOT NULL 거부
- **X7** (qa-flow): batch > 30 시나리오 → dispatch 거부
- **X8** (qa-flow): evidence 부재 (defect/scenario_error 인데 file:line 누락) → row 거부
- **X9** (qa-flow): bulk sync 안에서 reasoning 호출 → 즉시 중단

## 자율 Run 정책 (PDD O8 — 절대 불가침)

자율 dispatch 중 다음은 절대 하지 않는다:
- 런타임 상태 수정 (`~/.local/share/clawket/`, `~/.cache/clawket/`,
  `~/.config/clawket/`, `~/.local/state/clawket/`, `~/.claude/plugins/clawket-*/`)
- DB DROP / DELETE / TRUNCATE
- git reset / commit / push / tag / release
- 사용자 데이터 영역 (`~/.local/share/clawket/db.sqlite`) 직접 SQL DDL

ALTER TABLE ADD COLUMN (non-destructive) 만 허용. 위반 시 즉시 사용자 confirm.

## 출력

- 라운드 R TSV evidence knowledge 1개 (`type=evidence, title=Round R evidence — <도메인>`)
- 라운드 R QA task 들 (cycle 안에 sync 완료)
- 수렴 판정 결과 (continue / converged / blocked)
- 다음 라운드 schedule (필요 시)

## 자기 점검 체크리스트

### 라운드 시작 시
- [ ] 활성 Plan + 활성 Cycle 둘 다 존재한다
- [ ] 처리할 Unit 의 시나리오 knowledge 가 현재 의도만 담는다 (히스토리 흔적 0)
- [ ] sub-agent batch 크기 ≤ 30 시나리오 / agent 이다

### 라운드 종료 시
- [ ] 모든 batch 의 TSV evidence row 가 schema 검증 통과 (7 필드)
- [ ] **모든 status** 의 row 에 evidence (file:line) 가 있다
- [ ] tier_used=opus row 는 escalation_reason 채워짐
- [ ] batch_id 가 모든 row 에 채워짐
- [ ] bulk sync 안에서 reasoning 호출 0 건이다
- [ ] 3-way 수렴 판정이 명시적으로 기록됐다 (`status` 응답 JSON 보존)
- [ ] regression 감지 시 `[REGRESSION-INVESTIGATION]` task 등록 + 사용자 confirm

## 관련 파일

- 룰 본체: `skills/discover-loop/RULE.md`
- 짝 skill: `/scenario-author`, `/pdd-plan`, `/scenario-refine`, `/qa-batch`,
  `/qa-fix` (결함 해결 plan 운영)
