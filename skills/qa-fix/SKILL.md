---
name: qa-fix
description: QA defect → fix task 처리 — 결함 해결 plan 의 Round R unit 에 fix task 등록 + 코드 수정. 발견-수렴 루프의 결함 처리 단계. Clawket plugin 정본 skill (v3.0). RULE.md (qa-flow.md v3.0 §3 #4) 적용.
---

# /qa-fix — QA Defect 결함 해결 task 처리

발견-수렴 루프의 결함 처리 인터페이스. `/discover-loop` 가 라운드 R 의
sub-agent 산출에서 `status=defect` row 를 발견하면 호출.

## 호출 컨텍스트

`/discover-loop` 의 3-way 수렴 판정 결과 `defect_count > 0` 일 때:

```
TSV row example (qa-flow §5):
  scenario_id: US-DAEMON-API-017
  status: defect
  reasoning: "GET /health 엔드포인트가 daemon이 아직 초기화 중일 때 200 대신
              503 을 반환해야 하는데, 현재 코드는 항상 200 을 반환한다."
  evidence: daemon/src/routes/health.rs:42
  defect_task: (새로 생성 예정)
```

## 입력

- 라운드 번호 R
- TSV 에서 `status=defect` 인 row 들 (scenario_id, reasoning, evidence)
- 결함 해결 Plan ID (`<도메인> QA 이슈 해결` plan — 없으면 생성)
- Round R Unit ID (결함 해결 plan 안의 해당 라운드 unit — 없으면 생성)
- 활성 Cycle ID

## 처리 절차

### 1. 결함 해결 Plan 확보

결함 해결 plan 은 **전 라운드 공유 단일 plan** (qa-flow §4).

```bash
# 기존 plan 확인
clawket plan list --project <PROJ_ID> | grep "<도메인> QA 이슈 해결"

# 없으면 신규 생성
clawket plan create "<도메인> QA 이슈 해결" --project <PROJ_ID>
clawket plan approve <FIX_PLAN_ID>
```

### 2. Round R Unit 확보

결함 해결 plan 안에 라운드별 unit 1개 (`Round N` 명):

```bash
# 기존 unit 확인
clawket unit list --plan <FIX_PLAN_ID> | grep "Round $R"

# 없으면 신규 생성
clawket unit create "Round $R" --plan <FIX_PLAN_ID> --mode sequential
```

### 3. Fix task 등록

각 defect row 마다 fix task 1개 생성:

```bash
clawket task create "FIX: <결함 한 줄 요약>" \
  --unit <FIX_UNIT_ID> \
  --cycle <FIX_CYCLE_ID> \
  --scenario-id <SCENARIO_ID> \
  --evidence "<evidence file:line>" \
  --type code \
  --body "<reasoning 본문>\n\n원본 QA task: <QA_TASK_ID>"
```

Task 품질 기준 (PDD T1~T8 통과):
- **T1**: 단일 동사구 시작 ("FIX: ...")
- **T3**: Done 정의 = 외부 검증 가능 명제 (예: "round R+1 에서 해당 시나리오 pass 확인")
- **T6**: type=code
- **T7**: scenario_id 채워짐 (결함의 원인 시나리오 ID)
- **T8**: evidence 채워짐 (file:line from TSV)

### 4. QA task 에 defect_task ID 연결

원본 QA task 에 fix task ID 를 코멘트로 연결:

```bash
clawket comment add --task <QA_TASK_ID> \
  --body "defect → fix task: <FIX_TASK_ID>\nevidence: <file:line>\nreasoning: <요약>"
```

### 5. 코드 수정 (fix task in_progress)

```bash
clawket task update <FIX_TASK_ID> --status in_progress
```

코드 수정 원칙:
- **QA plan 안에서 코드 수정 금지** (qa-flow §3 절대 규칙 #1). 코드 수정은
  이 fix task 안에서만.
- 수정 범위: evidence 의 file:line 부터 trace — 가능한 한 최소 범위
- 수정 후 Done 정의 검증: round R+1 에서 해당 시나리오가 pass 될 것인지
  코드 추론으로 확인

### 6. Fix task 완료

```bash
clawket task update <FIX_TASK_ID> --status done \
  --comment "수정 위치: <file:line>\n수정 내용: <한 줄>\nDone 검증: <코드 추론>"
```

## Round R+1 연계

모든 defect 에 대한 fix task 가 done 처리되면 `/discover-loop` 로 복귀 →
Round R+1 sub-agent dispatch. R+1 에서 동일 시나리오들이 새 task 로 재평가됨.

## Fix task 의 Done 정의 (T3)

fix task 의 Done 은 "수정 완료" 자기참조 금지 (PDD X4). 외부 검증 명제:
- "Round R+1 에서 `US-<DOMAIN>-<NNN>` 시나리오가 pass 판정"
- "코드 추론: Given → When → Then 도달 경로가 수정 후 명확"

## 자기 점검 체크리스트

- [ ] fix task 수 == defect row 수 (1:1 매핑)
- [ ] 각 fix task 의 `scenario_id` 채워짐 (X3)
- [ ] 각 fix task 의 `evidence` 채워짐 (X8)
- [ ] Done 정의가 외부 검증 명제 (X4 아님)
- [ ] 원본 QA task 에 fix task ID 코멘트 연결됨
- [ ] 결함 해결 plan 이 "<도메인> QA 이슈 해결" 이다 (단일 plan 공유)
- [ ] 결함 해결 unit 이 "Round R" 이다 (라운드별 1 unit)

## Anti-pattern 거부

- **QA plan 안에서 코드 수정** → 거부 (qa-flow §3 #1)
- **fix task 없이 직접 코드 수정** → 거부 (task 추적 불가)
- **Done = "코드 수정 완료"** → 외부 검증 명제로 재정의 (PDD X4)
- **scenario_id 없는 fix task** → 거부 (PDD X3)
- **evidence 없는 fix task** → 거부 (PDD X8)

## 자율 Run 정책 (PDD O8)

- 2.x 런타임 / DB DDL / git 작업 절대 금지
- 코드 수정은 fix task 활성 상태에서만 (Clawket hook 강제)
- ALTER TABLE ADD COLUMN (non-destructive) 만 허용

## 출력

- fix task 목록 (결함 해결 plan 의 Round R unit 에 등록됨)
- 원본 QA task ↔ fix task 매핑
- 다음 단계 (`/discover-loop` Round R+1 진입 신호)

## 관련 파일

- 룰 본체: `skills/qa-fix/RULE.md`
- 짝 skill: `/discover-loop` (호출 진입점), `/qa-batch` (defect 산출)
