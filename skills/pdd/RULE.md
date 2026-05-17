# PDD 플로우 규칙 (Plan-Driven Development)

> **상태: STABLE — Clawket plugin 정본.** `skills/pdd/RULE.md` 가 정본.

솔로 프로덕트 오너(자기 제품을 자기가 만드는 1인 컨텍스트) 의 개발 방법론.
`scenario-authoring.md` / `qa-flow.md` 와 한 쌍 — 시나리오는 의도, QA 는 검증,
PDD 는 그 사이의 **실행 명세화** 를 담당한다. 셋은 단일 **발견-수렴 루프
(Discovery-Convergence Loop)** 로 통합 운영된다.

## 핵심 철학

**Plan = 결정의 결정체 + 실행 명세.** 솔로 PO 컨텍스트에서 결정·명세·실행이
모두 1인에게 있을 때, Plan 의 명료성이 곧 산출물의 완성도 상한이다.

- 일반 개발자(외부 요구사항 분리) → TDD 가 적합 (테스트가 spec 의 그릇)
- 솔로 PO = 개발자(요구사항을 본인이 결정) → **PDD** (Plan 이 spec 의 그릇)

### 시나리오·코드 공진화 가설

**시나리오와 코드는 공진화한다.** 시나리오는 사전-*완전* 이 아니라 사전-*예비*.
발견-수렴 루프 안에서 시나리오는 atomic 까지 분해되고, 코드는 시나리오를
만족할 때까지 회귀한다. **두 layer 가 동시에 0 으로 수렴**할 때 종료.

## 두 레이어 분리 (PDD 의 본질)

| 레이어 | 대상 | 가변성 | 결정 시점 |
|------|------|--------|----------|
| **의도 레이어** | 시나리오 / Plan / Unit | **사전 예비 설계 + 라운드 내 정련** | Plan 활성화 + 라운드 안에서 갱신 |
| **실행 레이어** | Cycle / Task | **단계적 생성 + sub-agent dispatch** | Cycle 활성화 시점 / 라운드별 batch 생성 |

**의도 레이어**: 큰 그림 + 도메인별 atomic 시나리오 초안은 사전 예비 설계로
박는다. 라운드 안에서 scenario_error 발견 시 atomic 분해 / 의도 재정의 /
삭제로 정련한다. 시나리오는 mutable 이지만 갱신 사유는 "의도 부적절" 에 한정
(qa-flow.md §scenario_error 참조).

**실행 레이어**: Cycle 활성화 시점에 Cycle 의 task 를 batch 로 생성. sub-agent
N 명이 1 unit 씩 분담해 시나리오를 reasoning 하고 TSV emit → 드라이버가
병렬 bulk sync 로 task DB 에 transcribe 한다. **batch 생성은 anti-pattern
아니다** — 시나리오 1:1 task 매핑이 보장되면.

## 4 레이어 모델 (Clawket 매핑)

```
Project ── 제품 1개
   │
   ▼
Plan ───── 산출물 본질 (사전 예비 + 라운드 내 갱신)
   │       — Done 정의 + 수렴 조건 명시
   │
   ▼
Unit ───── 도메인/메뉴 그룹 (사전 예비 + 라운드 내 갱신)
   │       — 한 Unit = 시나리오 그룹 1개 (메뉴/탭/영역)
   │       — 시나리오 수 lower bound + sub-area 분해 명시
   │
   ▼
Cycle ──── 1 라운드 (실행 단계, sub-agent dispatch 단위)
   │       — Cycle 은 Unit 1개에 묶이지 않아도 됨 (cross-unit 허용)
   │       — 라운드 단위 진행: Round R cycle 1개 + Round R+1 cycle 1개...
   │       — 동시 활성 cycle 가능 (병렬 라운드)
   │
   ▼
Task ───── 실행 단위 (Cycle 안에서 batch 생성)
           — 1 Task ↔ 1 시나리오 (또는 sub-spec) 환원 (A4)
           — scenario_id + evidence 필드 채워짐 (강제)
```

## Axioms (불변 공리)

- **A1. Plan/Unit 은 spec 이다, idea 가 아니다.**
  모든 항목은 외부 관찰자가 동일하게 충족 여부를 판단 가능해야 한다.
- **A2. 의도는 사전 예비 설계 + 라운드 내 정련.**
  큰 그림과 atomic 시나리오 초안은 사전. scenario_error 발견 시 라운드 안에서
  amend / delete (사유: 의도 부적절). 갱신은 audit knowledge + cancelled task
  comment 양쪽에 영구 기록.
- **A3. 실행은 단계적 생성 + sub-agent batch.**
  Cycle 활성화 시점에 그 cycle 의 task 를 batch 생성. sub-agent N 명이 1 unit
  씩 분담 reasoning. 미리 모든 라운드 task 박지 않는다.
- **A4. 트레이서블 단방향 위계.**
  모든 Task → 정확히 1 시나리오(또는 sub-spec) 환원. 환원 불가 = 스펙 외, 거부.
  `tasks.scenario_id` 컬럼으로 schema 강제.
- **A5. Red-Green-Refactor 매핑.**
  - PDD Red = 라운드 R 의 미충족 시나리오 (cycle 활성 직후)
  - PDD Green = 라운드 R 통과 + 수렴 조건 충족
  - PDD Refactor = 시나리오 정련 (scenario_error → atomic 분해 / 의도 재정의 / 삭제)
- **A6. 진실 공급원 단일.**
  Clawket Plan/Unit/Cycle/Task = 진실. 보조 문서 (knowledge, plans/*.md) = 미러.
- **A7. Tool-first, Automation-second.**
  Plan 의 자동화 항목은 수동 도구 신뢰성 입증 후에만 포함.
- **A8. Sub-agent batch reasoning + bulk sync transcription.**
  reasoning 은 sub-agent 가 batch 단위 (≤ 30 시나리오/agent) 로 수행, sync 는
  드라이버가 TSV → DB transcription 으로 분리. 두 단계는 명확히 구분되며
  sync 단계엔 evidence 가 동반되어야 한다.

## 발견-수렴 루프 (Discovery-Convergence Loop)

PDD lifecycle 의 본체. `qa-flow.md` 의 라운드 패턴과 통합되어 단일 루프로
운영된다.

```
Phase 0. 시나리오 사전 예비 설계 (scenario-authoring.md, /scenario-author skill)
   └─ 도메인별 시나리오 knowledge — atomic 초안

Phase 1. PDD plan + Unit 사전 예비 설계 (/pdd-plan skill)
   └─ Plan 1개 + Unit N개 (시나리오 그룹별)
   └─ Plan body 에 Done 명제 + 수렴 조건 명시

Phase 2. /discover-loop 발견-수렴 루프 (메인 엔진)
   └─ Round R 시작:
      ├─ Plan 자동 생성: "<도메인> Round R" (qa-flow §라운드별 새 plan)
      ├─ Cycle 1개 활성화 (cross-unit 가능)
      ├─ Sub-agent dispatch:
      │  ├─ N agents 병렬 (1 agent / 1 unit, 시나리오 ≤ 30/agent — A8 강제)
      │  ├─ 각 agent: scenario ↔ code reasoning (Given/When/Then 매핑)
      │  └─ TSV emit: scenario_id, status, reasoning, evidence(file:line)
      ├─ Bulk sync TSV → DB task status (transcription only)
      ├─ 수렴 판정 (3-way):
      │  ├─ defect > 0 → /qa-fix subagent → fix plan 의 Round R unit
      │  ├─ scenario_error > 0 → /scenario-refine subagent
      │  │   ├─ atomic 분해 (1 → N 시나리오)
      │  │   ├─ 의도 재정의 (knowledge 갱신, ID 보존)
      │  │   └─ 삭제 (ID 영구 비움)
      │  │   → cancelled task comment + audit knowledge 기록
      │  └─ defect=0 + scenario_error=0 + R-1 도 0 → 수렴, 종료
      └─ /loop ScheduleWakeup → Round R+1
```

### 수렴 종점

- defect → 0 (코드가 시나리오를 만족)
- scenario_error → 0 (시나리오가 더 이상 atomic 분해되지 않음)
- 두 조건이 **2 라운드 연속** (qa-flow.md last-2-rounds-zero 룰 계승)

이 종점 이전엔 시나리오와 코드가 **공진화** 한다.

## Sub-agent Dispatch 규약 (A8 운영)

1. **1 agent / 1 unit / ≤ 30 시나리오** (강제). 30 이하가 reasoning 품질 보장
   임계.
2. **TSV evidence 의무**. 모든 sub-agent 산출은 `qa-U##-r#.tsv` 형식으로 영속.
   필드: `scenario_id, status, reasoning, evidence(file:line), tier_used,
   batch_id`. evidence 빈 task = X3 anti-pattern.
3. **Bulk sync ≠ reasoning**. ThreadPoolExecutor 등 병렬 드라이버는 TSV → DB
   transcription 만 수행. reasoning 결정을 sync 단계에 끼워넣지 않는다. sync
   코드는 TSV 의 status 를 그대로 옮겨야 한다.
4. **batch_id 추적**. 같은 batch 산출의 task 들은 `tasks.batch_id` 로 묶인다.
   batch 의 attention 분산 의심 시 같은 batch 의 후반 task 만 재검증.

## Plan Quality Criteria

- **C1**. Plan 명: 단일 명사구, 산출물 본질 압축
- **C2**. Done 정의: 외부 관찰자 동일 판단 가능 명제
- **C3**. Unit 분해: 모든 시나리오 → 정확히 1 Unit 환원
- **C4**. Unit 별 시나리오 수 lower bound + sub-area 분해 명시
- **C5**. Unit 의존성 그래프 명시 (직렬/병렬)
- **C6**. 수렴 조건 명시 (defect=0 + scenario_error=0 + 2 라운드 연속)
- **C7**. 롤백 트리거: Plan blocked 전환 조건 명시
- **C8**. 진실 공급원 위치: Clawket Plan ID + knowledge 미러 위치

## Unit Quality Criteria

- **U1**. Unit 명: `<도메인> <영역>` (예: `QA-Chess 학습`)
- **U2**. Unit 안의 시나리오 수가 박혔다 (knowledge 의 시나리오 수와 일치, 단
  라운드 안에서 정련될 수 있음 — A2)
- **U3**. 다른 Unit 과의 의존 ID 명시 (없으면 "독립")
- **U4**. mode: `sequential` | `parallel` (sub-agent dispatch 시 병렬 여부)

## Task Quality Criteria

- **T1**. 단일 동사구 시작 (구현 또는 검증 액션)
- **T2**. 영향 파일 ≤ 8 (초과 → Task 분리 시그널)
- **T3**. Done 정의 = 단일 외부 검증 명제 (typecheck PASS / file diff exists 등)
- **T4**. 외부 의존 시 `blocked` + 의존 ID 명시
- **T5**. 추론 잔여물 금지 ("검토 / 분석 / 조사 / 방안 모색") — Plan 회귀
- **T6**. 산출물 카테고리 라벨: `code | test | doc | config | review | infra`
- **T7**. **시나리오 ID 환원 강제**: `tasks.scenario_id` 채워짐 (`US-<DOMAIN>-<NNN>`
  또는 sub-spec ID). schema 차원 NOT NULL 후보 (단계적 강제).
- **T8**. **evidence 강제**: pass/defect/scenario_error 모든 status 에 대해
  `tasks.evidence` 채워짐 (file:line 또는 reasoning 요약).

## Decomposition 상한

- **Task ≤ 8 / Cycle** (decomposition 미흡 시그널)
- **시나리오 ≤ 30 / sub-agent 호출** (A8 강제 — attention 분산 방지)
- **Cycle ≤ 라운드 N** (Unit 별 가변, 보통 1 + 결함 fix N)
- **Unit ≤ 12 / Plan** (메뉴 수 기준, 초과 시 Plan 분리 또는 명시적 예외 사유)
- **Plan ≤ 1 활성 / Project** (다중 활성 plan 금지) — *권고. 전환기엔 ≤ 2
  허용 (예: External-reported defects 와 신규 Plan 공존)*

상한 초과 = decomposition 미흡, 재분해 강제.

## Anti-patterns (Plan 단계에서 거부)

- **X1**. "검토 / 분석 / 조사" 류 Task → 비-실행, Plan 회귀
- **X2**. "유연하게 / 필요 시 / 추후 보강" 표현 → 의사결정 회피, 거부
- **X3**. **시나리오 환원 불가 Task (scenario_id NULL)** → 스펙 외, 거부.
  `task-created` hook 으로 scenario_id 패턴 검증.
- **X4**. Done 정의 = "구현 완료" 같은 자기참조 → 외부 검증 명제로 재정의
- **X5**. 수렴 조건 부재 → 재분해
- **X6**. 시간 기반 종료 조건 ("2주 후") → 산출물 기반 재정의
- **X7**. **Reasoning batch size > 30 / agent** → A8 위반.
  attention 분산 위험. 분할 dispatch 강제.
- **X8**. **TSV evidence 부재 sub-agent 산출** → A8 위반.
  reasoning 흔적이 영속화 안 됨. 재실행.
- **X9**. **Bulk sync 안에 reasoning 결정 끼워넣기** → A8 위반.
  sync 코드는 TSV → DB 매핑만. status 결정은 agent reasoning 산출이어야 함.

## Operational Rules (Clawket 통합)

- **O1**. Plan 생성 = `clawket plan create` + knowledge 미러
- **O2**. Unit 분해 = `clawket unit create` (시나리오 그룹별 1 Unit)
- **O3**. Cycle 활성화 = 라운드 단위. cross-unit 허용. 동시 활성 cycle 허용.
- **O4**. Task batch 생성 = sub-agent dispatch 후 TSV → bulk sync.
  단일 task 직접 생성도 허용 (소규모 cycle).
- **O5**. Task 시작 = 활성 Plan + 활성 Cycle 필수 (Clawket hook 강제)
- **O6**. Task 완료 = Done 명제 외부 검증 + evidence 채워짐 후 `--status done`
- **O7**. Plan blocked = 롤백 트리거 발동 시. 사유는 Task comment.
- **O8**. **런타임 불가침**.
  배포된 플러그인의 binary / daemon / cache / DB 는 절대 수정 / 삭제 금지.
  ALTER TABLE ADD COLUMN 같은 비파괴 가산만 허용. DROP / DELETE / TRUNCATE 절대
  금지. git reset / commit / push / tag / release 절대 금지 (사용자 명시 지시
  시에만).

## Lifecycle (단계별)

```
[1] Phase 0 — 시나리오 사전 예비 설계 (의도 레이어 초안)
    ├─ /scenario-author skill (atomic 시나리오 작성)
    └─ 도메인별 knowledge

[2] Phase 1 — Plan + Unit 사전 예비 설계 (의도 레이어 골격)
    ├─ /pdd-plan skill (Plan 1개 + Unit N개 + 수렴 조건)
    └─ knowledge 미러

[3] Phase 2 — 발견-수렴 루프 (메인 엔진)
    ├─ /discover-loop skill (메인 루프 본체)
    │  ├─ Round R cycle 활성화
    │  ├─ /qa-batch sub-agent dispatch (1 agent / 1 unit / ≤ 30 시나리오)
    │  ├─ TSV → bulk sync transcription
    │  ├─ 3-way 수렴 판정
    │  │  ├─ defect → /qa-fix
    │  │  └─ scenario_error → /scenario-refine
    │  └─ /loop ScheduleWakeup → R+1
    └─ 수렴 (defect=0 + scenario_error=0 + 2 라운드 연속) → Plan completed

[4] Phase 3 — 시뮬레이터 / 실기기 수동 QA (선택)
    └─ "<도메인> 수동 QA" plan (코드 추론 단계 통과 후)
```

## EXPERIMENTAL → STABLE 승격 기준

새 PDD 룰이 다음을 통과하면 Clawket plugin 정본 스킬로 승급한다:

- [ ] 1 프로젝트 이상에서 1개 Plan 전체 lifecycle 완주 (발견-수렴 루프 1 회 완주)
- [ ] Sub-agent batch dispatch 가 reasoning batch ≤ 30 강제 하에 완주
- [ ] 모든 task 의 `scenario_id` + `evidence` 채워짐 (100%)
- [ ] scenario_error 가 발견-수렴 루프 안에서 자연 발생 → /scenario-refine 자동
      처리됨
- [ ] anti-pattern X3 (scenario_id 부재) / X7 (batch > 30) / X8 (evidence 부재)
      / X9 (sync 안 reasoning) 가 hook 으로 차단됨

승격 후 산출물:
- `skills/pdd/`, `skills/scenario-author/`, `skills/qa-batch/`,
  `skills/discover-loop/`, `skills/scenario-refine/`, `skills/qa-fix/`
  (Clawket plugin 정본 — 본 위치가 SSoT)
- 룰 본체는 각 skill 의 `RULE.md` 가 정본
- Clawket hook 으로 X3/X7/X8/X9 강제 (PreToolUse / SubagentStart / PostToolUse
  매처 — adapters/shared/claude-hooks.cjs `checkX3`/`checkX7`/`checkX8`/`checkX9`)

## 작성자 자기 점검 (체크리스트)

### Plan 작성 후
- [ ] Plan 명이 단일 명사구이다
- [ ] Done 정의가 외부 검증 명제이다 (수렴 조건 포함)
- [ ] 모든 시나리오가 Unit 으로 환원됐다 (사전 예비 단계)
- [ ] 수렴 조건이 박혔다 (defect=0 + scenario_error=0 + 2 라운드 연속)

### Cycle 활성화 시
- [ ] 라운드 R 의 cycle 임이 명시됐다
- [ ] cross-unit cycle 이면 의존성 그래프가 reasoning 됐다
- [ ] sub-agent dispatch 계획이 박혔다 (몇 agent / agent 당 시나리오 수)

### Sub-agent 호출 시 (A8)
- [ ] reasoning batch size ≤ 30 시나리오/agent
- [ ] TSV 산출 형식 명시 (scenario_id, status, reasoning, evidence, tier_used,
      batch_id)
- [ ] evidence 채워짐 (file:line 또는 reasoning 요약)

### Task 작성 시
- [ ] 단일 동사구로 시작한다
- [ ] `scenario_id` 채워짐 (X3 anti-pattern 0)
- [ ] `evidence` 채워짐 (X8 anti-pattern 0)
- [ ] Done 정의가 외부 검증 명제이다

## 운영 노트

- PDD 는 솔로 PO 컨텍스트의 방법론.
- 시나리오 700~2000 개를 사전에 박는 것이 정상이지만, 라운드 안에서 정련된다.
- Cycle 수가 Unit 별로 다른 것이 정상 (Unit A = 1 cycle, Unit B = 4 cycle).
  의도가 가변이 아니라, 실행 라운드가 가변.
- Sub-agent reasoning batch size 30 은 attention 분산 방지를 위한 보수적 임계.
- 본 룰은 STABLE — Clawket plugin 정본. hook 강제는 PreToolUse / SubagentStart
  / PostToolUse 매처 조합으로 동작하며, 스키마 컬럼 (`scenario_id`, `evidence`,
  `batch_id`) 도 데몬 schema 에 포함된다.
