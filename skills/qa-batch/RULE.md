# QA 플로우 규칙 (Scenario-Based QA Flow, v3.0)

> **상태: STABLE — Clawket plugin 정본.** PDD `skills/pdd/RULE.md` v3.0 의
> 발견-수렴 루프와 통합 운영. 9000-태스크 자율 런 (Clawket v3 surface plan,
> 2026-04~05) 의 데이터 회고로 distill. 구 룰 (1 시나리오 = 1 task, 라운드별
> 새 plan/task, last-2-rounds-zero) 은 살리고, 룰엔 없던 sub-agent batch
> dispatch / TSV evidence / bulk sync transcription 을 정식 메커니즘으로
> 추가했다. 가장 큰 변화는 **scenario_error 처리를 §5 절대규칙 (예외) 에서
> §0 메인 수렴 메커니즘 (정식) 으로 격상** 한 것이다.

시나리오 기반 QA 를 수행할 때 적용하는 글로벌 규칙. `skills/scenario-author/RULE.md`
산출물 (시나리오 knowledge) 이 입력. PDD `skills/pdd/RULE.md` 와 한 쌍 —
발견-수렴 루프 안에서 시나리오·코드 공진화 메커니즘을 담당한다.

## 핵심 철학

**시나리오와 코드는 발견-수렴 루프 안에서 공진화한다.**

- 시나리오 ↔ 코드 차이 → defect (코드층) **또는** scenario_error (시나리오층)
- defect = 코드가 시나리오를 만족 못함 → 코드 수정
- scenario_error = 시나리오가 부적절 → 시나리오 정련 (atomic 분해 / 의도 재정의 / 삭제)
- **두 layer 가 동시에 0 으로 수렴할 때까지 라운드 반복**
- QA 는 UI 두드리기 아니라 **시나리오와 코드의 논리적 비교 추론**
- 시뮬레이터/실기기 수동 QA 는 코드 추론 QA 가 통과한 다음 단계 (별도 plan)

## §0 발견-수렴 루프 (메인 메커니즘, v3.0 신규)

scenario_error 는 **예외가 아니라 수렴 신호**다. agent 가 시나리오를 보고
"이건 한 시나리오에 두 가정이 섞였다, 분해해야 한다" 고 판정하면 그게 진보의
핵심 신호. 9000-런의 R3 에서 459 시나리오 reclassify 가 시나리오층 정련의
정상 패턴이었다.

```
Round R 시작
  ├─ Plan 자동 생성: "<도메인> Round R" (qa-flow §라운드별 새 plan 계승)
  ├─ Cycle 1개 활성화 (cross-unit 가능, PDD v3.0 A4 기각 반영)
  ├─ Sub-agent dispatch:
  │  ├─ N agents 병렬 (1 agent / 1 unit / ≤ 30 시나리오 — PDD A8 강제)
  │  ├─ 각 agent: scenario ↔ code reasoning (Given/When/Then 매핑)
  │  └─ TSV emit: scenario_id, status, reasoning, evidence, tier_used, batch_id
  ├─ Bulk sync TSV → DB task status (transcription only, ≠ reasoning)
  ├─ 수렴 판정 (3-way):
  │  ├─ defect > 0 → fix plan 의 Round R unit 으로 fix task 등록
  │  ├─ scenario_error > 0 → /scenario-refine 처리:
  │  │   ├─ atomic 분해 (1 → N 시나리오)
  │  │   ├─ 의도 재정의 (knowledge 갱신, ID 보존)
  │  │   └─ 삭제 (ID 영구 비움)
  │  │   → cancelled task comment + audit knowledge 기록
  │  └─ defect=0 + scenario_error=0 + R-1 도 0 → 수렴 종료
  └─ /loop ScheduleWakeup → Round R+1
```

### 수렴 조건 (v3.0)

- **수렴 종점**: defect=0 + scenario_error=0 + 마지막 2 라운드 연속 0
- 최소 3 라운드 권장 (라운드 1 결함 0 이어도 안전 마진)
- 라운드마다 결함 수가 단조 감소 안하면 회귀 분석 필수

## §1 사이클 다이어그램 (v3.0)

```
시나리오 사전 예비 설계 (scenario-authoring.md, /scenario-author skill)
    │
    ▼
PDD plan + Unit 사전 예비 설계 (pdd.md, /pdd-plan skill)
    │
    ▼
[발견-수렴 루프 (§0)]
    │
    ▼
Round R plan ── "<도메인> Round R" (라운드마다 새 plan, qa-flow §3 절대 규칙 #2)
  ├─ 1 시나리오 = 1 task (qa-flow §3 절대 규칙 #3)
  ├─ Sub-agent batch dispatch (1 agent / 1 unit / ≤ 30 시나리오, A8)
  ├─ TSV evidence emit + bulk sync transcription
  └─ defect / scenario_error 분기:
     ├─ defect → 결함 해결 plan 의 "Round R" unit 에 fix task
     └─ scenario_error → /scenario-refine 즉시 처리 (knowledge 갱신)
    │
    ▼ (defect=0 + scenario_error=0 + 2 라운드 연속까지 반복)
    │
시뮬레이터 / 실기기 수동 QA ── plan: "<도메인> 수동 QA" (선택)
```

## §2 Sub-agent Batch Dispatch (v3.0 정식 메커니즘)

PDD A8 운영 규약. 9000-런이 작동한 핵심 동력으로, 구 룰엔 한 줄도 없었지만
실제 엔진이었다.

### Dispatch 규약

1. **1 agent / 1 unit / ≤ 30 시나리오** (PDD A8 강제)
   - 9000-런의 87/agent 배치는 attention 분산 위험 (R4 large unit 결과 신뢰도
     저하 가능성)
   - 30 이하가 reasoning 품질 보장 임계 (보수적, 향후 데이터로 보정)
2. **TSV evidence 의무**
   - 모든 sub-agent 산출은 `qa-U##-r#.tsv` 형식 영속
   - 필드: `scenario_id, status, reasoning, evidence, tier_used, batch_id`
   - `evidence` 빈 task = X8 anti-pattern (PDD)
3. **Bulk sync ≠ reasoning**
   - Python ThreadPoolExecutor 16-worker 등 드라이버는 TSV → DB transcription 만
   - reasoning 결정을 sync 코드에 끼워넣지 않는다 (X9 anti-pattern)
   - sync 는 status 매핑 (pass→done, defect→blocked, scenario_error→cancelled) 만
4. **batch_id 추적**
   - 같은 batch 산출의 task 들은 `tasks.batch_id` 로 묶임
   - attention 분산 의심 시 같은 batch 의 후반 task 만 재검증 가능
5. **Tier 라우팅** (v3 plan §6 G3 계승)
   - default: Sonnet (시나리오 vs 코드 비교 추론, 80~90% case)
   - 모호 case (scenario_error 후보 / 경계 불명확) → Opus escalation
   - 회귀 라운드 결함 root-cause analysis: Opus 우선
   - `tier_used` 필드 + escalation 시 `escalation_reason` 명시

## §3 절대 규칙 (살림 + v3.0 갱신)

1. **QA 중 코드 수정 금지.** 발견 + 결함 task 등록만. 수정은 별도 결함 수정
   plan 에서.
2. **시나리오 임의 스킵 / task 재사용 금지.** 라운드마다 전체 시나리오 재실행
   + task 전체 새로 생성. 라운드별 판정 이력은 plan 단위로 영구 보존된다 —
   재사용은 히스토리 손실.
3. **1 시나리오 = 1 task 매핑 유지.** sub-agent batch reasoning 으로 묶어 추론
   해도 task 는 1:1 매핑. 부분 통과/부분 실패 흐려짐 방지.
4. **결함 fix task 는 별도 plan 의 라운드 unit 에 등록.** QA plan 자체는 "발견
   전용" — defect 발견 시 QA task 는 status=blocked. 동일 결함을 결함 해결
   plan (`<도메인> QA 이슈 해결` — 전 라운드 공유 단일 plan) 의 "Round R" unit
   안에 fix task 로 새로 만든다.
5. **시나리오 자체 오류 (scenario_error) 는 §0 메인 메커니즘으로 처리** (구
   §5 절대규칙에서 격상). 절차:
   - (a) 현 라운드 QA task 에 **코멘트로 사유/근거 기록** — *왜 부적절했는지*
     영구 보존
   - (b) QA task `status=cancelled` (defect 와 구분, blocked 아님)
   - (c) /scenario-refine skill 실행:
     - **atomic 분해**: 1 시나리오에 두 가정 섞임 → N 개 atomic 시나리오로
     - **의도 재정의**: 시나리오 ID 보존, 본문만 갱신
     - **삭제**: ID 영구 비움 (재사용 금지)
   - (d) knowledge 갱신 — 항상 *현재 의도* 만 (히스토리 보존 금지, 그건 cancelled
     task comment 와 audit knowledge 에 영구)
   - (e) 다음 라운드는 갱신된 knowledge 기반으로 task 등록
6. **scenario_error 갱신 가능 기준** (강화)
   - 시장-정합 아키텍처 / 제품 완성도 관점에서 시나리오의 **의도 자체가 부적절**
     한 경우에 한해 amend / delete
   - 시간 / 코드 복잡도 / 영향 파일 수 / 토큰 비용은 amend 사유가 될 수 없다
   - 코드 영향이 큰 경우는 시나리오를 고치지 말고 **모든 영향 코드를 고치는
     plan/task 등록** (PDD 원칙)
   - 컴퓨터 결정론 원칙: 외부 PM 게이트 없이도 코드 reasoning 증거 강도 충분
     하면 진행. 약하면 `defect` 강등 + 시나리오 미수정.
7. **증거 기록 의무** (강화)
   - 모든 task 의 `tasks.evidence` 채워짐 (file:line 또는 reasoning 요약)
   - scenario_error 갱신 사유는 (a) cancelled QA task 코멘트 + (b) audit
     보고서 knowledge (`type=note, title=scenario_error audit log
     <도메인>`) 양쪽에 영구 보존. 보고서는 라운드별 누적.

## §4 Plan / Unit 명명 규약

- QA 라운드 plan: `<도메인> Round N` (N=1) 또는 `<도메인> Round N (회귀)` (N≥2)
- QA 라운드 unit: 시나리오 영역 단위 — `QA-<도메인> <영역>` (예: `QA-Chess
  학습`). Unit `mode=parallel` 권장 (sub-agent dispatch 시 병렬 OK)
- 결함 해결 plan: `<도메인> QA 이슈 해결` (단일 plan, 전 라운드 공유). 분량
  폭발 시 예외적 분리: `<도메인> QA 이슈 해결 Round N`
- 결함 해결 unit: `Round N` (라운드별 unit 1개)
- 수동 QA plan: `<도메인> 수동 QA` (시뮬/실기기 단계)

## §5 QA task 산출물 형식 (TSV row 와 동일 스키마)

```
QA-<scenario-id>:
  scenario_id: US-<DOMAIN>-<NNN>            (강제 — PDD T7)
  status: pass | defect | scenario_error
  reasoning: 코드 추론 근거                   (모든 status 에 강제 — PDD T8)
  evidence: file:line                       (defect / scenario_error 시 강제)
  tier_used: opus | sonnet | haiku          (sub-agent 사용 모델)
  batch_id: BATCH-<ULID>                    (sub-agent invocation 식별)
  defect_task: <결함 task ID>                (status=defect 일 때만)
  scenario_amendment: <수정 제안>           (status=scenario_error 일 때만)
  escalation_reason: <사유>                 (tier escalation 발생 시만)
```

- `pass` 도 reasoning 을 남긴다 (다음 라운드 regression 비교 기준)
- `defect` 시 코드 file:line 인용 — 결함 위치 추적용 (시나리오에는 file:line
  금지, QA 산출물엔 필수)
- `scenario_error` 는 코드는 옳고 시나리오가 틀렸을 때
- TSV ↔ Clawket task 1:1 매핑 (bulk sync 가 transcribe)

## §6 QA 방법론 (1 task 처리 절차, sub-agent 가 수행)

1. 시나리오의 Given 상태를 코드의 어떤 상태(state / props / store / 라우트
   파라미터) 로 매핑 가능한지 식별
2. When 트리거가 코드의 어떤 함수 / 핸들러 / 이벤트를 호출하는지 식별
3. Then 결과가 그 함수의 실제 반환 / 부수효과 / 화면 렌더로 도달 가능한지 코드
   흐름을 따라간다
4. 도달 가능 + 정확한 결과 = `pass`. 도달 불가능 / 잘못된 결과 / 누락된 분기 =
   `defect`. 시나리오 자체가 코드 의도와 어긋남 = `scenario_error`
5. evidence 필드에 reasoning 의 핵심 file:line 박는다 (sub-agent 가 다음 batch
   호출 / 향후 라운드에서 참조 가능)

## §7 라운드 종료 조건

- 한 QA 라운드 plan 의 모든 시나리오 `status=done` (= pass) → QA 라운드 plan
  완료
- 결함 1건이라도 → 결함 해결 plan 의 "Round N" unit 진행 → Round N+1 plan 시작
- 라운드 N 결함 0 이어도 **최소 3 라운드 + 마지막 2 라운드 연속 0** 까지 회귀
  계속
- 위 수렴 조건 만족 → 시뮬레이터 / 실기기 수동 QA plan 으로 진행 (선택)

## §8 운영 노트 (9000-런 회고 반영)

- 라운드 1 → 2 → 3 으로 갈수록 결함 수가 줄어야 한다. 늘어나면 결함 수정이 새
  결함을 만든다는 신호 — 회귀 분석 필요.
- 9000-런 데이터: R2 = 458 defect / R3 = 54 / R4 = 17 / R5 = 1 / R6 = 0 / R7 = 0
  (수렴). 단조 감소 패턴이 정상.
- 9000-런 데이터: R2 = 29 scenario_error / R3 = 420 (390 reclassify 발생) → R4
  이후 안정. 시나리오층 정련은 R2-R3 에서 일어나고, 코드층 수렴은 R4-R7 에서
  일어나는 패턴이 자연.
- Sub-agent batch reasoning 으로 1 라운드 1218 시나리오를 14 sub-agent ×
  ≤30시나리오 = 약 5 batch 호출/agent 로 처리 가능. 시간을 이유로 task 묶기 /
  스킵 / 재사용은 여전히 금지.
- QA agent 는 도메인 지식 없이도 시나리오 + 코드만 보고 판정 가능해야 한다
  (그래야 시나리오 품질이 검증된다)
- 라운드별 새 plan 의 task 가 시나리오 수만큼 동일하게 생성되는 것이 정상
- 결함 해결 plan 은 **단일 plan + 라운드 unit** 으로 시작. 라운드 N fix task
  분량이 너무 커서 plan 가독성을 해치면 그 라운드만 별도 plan 분리 허용 (예외)
- 9000-런이 사후 1227 task bulk reclassification 을 요한 사유: status mapping
  결정 (`defect → blocked` 의 의미가 "일시정지" 와 충돌) 이 사전에 어긋났음.
  v3.0 부터: defect → blocked (수정 대기), scenario_error → cancelled (의도
  부적절), pass → done. 의미를 사전에 단단히 박아 일괄 정정 사후 처리를 막는다.

## §9 점검 (체크리스트, v3.0)

### Round R plan 작성 후
- [ ] 라운드 N 은 별도 plan 으로 시작됐다
- [ ] QA task 수 == 시나리오 수 (라운드 plan 안에서)
- [ ] 코드 수정이 0 건이다 (QA plan 내에서)

### Sub-agent dispatch 시 (PDD A8)
- [ ] 1 agent / 1 unit / ≤ 30 시나리오 강제
- [ ] TSV 산출 형식 6 필드 (scenario_id, status, reasoning, evidence,
      tier_used, batch_id) 모두 채워짐
- [ ] Bulk sync 코드는 transcription 만 수행 (reasoning 결정 끼워넣지 않음)

### scenario_error 처리 시
- [ ] cancelled task comment 에 사유 영구 기록
- [ ] knowledge 갱신 = *현재 의도* 만 (히스토리 흔적 금지)
- [ ] audit 보고서 knowledge 에 누적 기록
- [ ] 갱신 사유가 "의도 부적절" (시간/비용/복잡도 사유 아님)

### 라운드 종료 시
- [ ] 결함은 모두 결함 해결 plan 의 Round N unit 에 fix task 로 등록됐다
- [ ] 회귀 라운드 plan 에서 이전 통과 시나리오도 task 새로 만들어 재평가됐다
- [ ] 최소 3 라운드 수행 (또는 결함=0 + scenario_error=0 + 2 라운드 연속 0)

## §10 자율 Run 정책 (PDD v3.0 O8 계승)

발견-수렴 루프 자율 run 시 불가침 (사용자 명시 지시 시에만 우회):

- 2.x 런타임 상태 수정 금지 (~/.local/share/clawket, ~/.cache, ~/.config,
  ~/.local/state, ~/.claude/plugins/clawket-*)
- DB DROP / DELETE / TRUNCATE 절대 금지 (ALTER TABLE ADD COLUMN 비파괴 가산만
  허용)
- git reset / commit / push / tag / release 절대 금지
- knowledge 갱신 시 "현재 의도" 만 (history 보존 금지 — 그건 task
  comment 와 audit knowledge 에 영구)

## §11 PDD ↔ qa-flow 통합 매핑

| PDD A6 (Red-Green-Refactor) | qa-flow 메커니즘 |
|---|---|
| Red | Round R 시작 직후 미충족 시나리오 |
| Green | Round R 통과 + 수렴 조건 |
| Refactor | scenario_error → /scenario-refine 처리 |

| PDD axiom | qa-flow 운영 |
|---|---|
| A1 spec | scenario knowledge 가 spec |
| A4 시나리오 환원 | tasks.scenario_id 강제 |
| A5 R-G-R | 위 표 |
| A8 sub-agent batch + bulk sync | §2 Dispatch 규약 |
