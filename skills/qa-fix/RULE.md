# QA Fix 규칙 (Defect Resolution, v3.0)

> **상태: STABLE — Clawket plugin 정본.** 본 파일은 `/qa-fix` skill 의 규칙
> 본체다. qa-flow v3.0 의 §3 절대 규칙 #4 (결함 fix task 는 별도 plan 의
> 라운드 unit 에 등록) 와 PDD v3.0 의 Task Quality Criteria (T1~T8) 를 운영
> 기준으로 삼는다.
>
> 전체 qa-flow 규칙은 `skills/qa-batch/RULE.md` 를 참조한다.

## 핵심 원칙

**QA 는 발견 전용, 수정은 별도 plan.**

qa-flow §3 절대 규칙 #1: QA plan 안에서 코드 수정 금지. 수정은 결함 해결 plan
의 fix task 안에서만. 이 분리가 "발견 이력" 과 "수정 이력" 을 라운드 단위로
명확히 추적 가능하게 한다.

## Fix Plan 규약 (qa-flow §4)

- **Plan 명**: `<도메인> QA 이슈 해결` (전 라운드 공유 단일 plan)
  - 예외: 분량 폭발 시 `<도메인> QA 이슈 해결 Round N` 으로 분리 (라운드별)
- **Unit 명**: `Round N` (라운드별 unit 1개)
  - Round 1 의 defect → unit `Round 1`
  - Round 2 의 defect → 같은 fix plan 에 unit `Round 2` 신규
- **Plan 공유**: 전 라운드의 fix task 가 하나의 plan 아래 라운드 unit 별로 묶여
  진행 이력 일괄 조회 가능

## Fix Task 품질 기준 (PDD T1~T8)

- **T1**: "FIX: <결함 한 줄 요약>" 동사구 시작
- **T2**: 영향 파일 ≤ 8 (초과 시 task 분리)
- **T3**: Done = "Round R+1 에서 `US-<DOMAIN>-<NNN>` pass 확인" (외부 검증)
- **T6**: type=code
- **T7**: scenario_id = 결함을 일으킨 시나리오 ID (NOT NULL)
- **T8**: evidence = defect row 의 file:line (NOT NULL)

## Defect Root-Cause 분석

결함 fix 전 반드시 root-cause 를 식별:

1. **Immediate cause**: 어느 file:line 에서 실패하는가 (TSV evidence)
2. **Structural cause**: 어떤 패턴/추상화가 이를 허용했는가
3. **Design cause**: 어떤 아키텍처 결정이 패턴을 만들었는가

권고 fix 는 Structural 또는 Design 수준. Band-aid 는 사용자 명시 요청 시에만
(qa-flow §8: 라운드 사이 결함 수가 늘어나면 Band-aid 누적 의심).

## Evidence 추적 불변 규칙

- fix task 의 `evidence` = TSV row 의 `evidence` 그대로 (file:line)
- 코드 수정 후 Done 검증 코멘트에 추가 file:line 기록 가능
- evidence 체인: TSV evidence → fix task evidence → done comment evidence
  (세 단계가 같은 시나리오 ID 로 추적 가능해야 함)

## 수렴 패턴 모니터링 (qa-flow §8)

- 라운드별 defect 수가 단조 감소해야 정상
- 증가 시: 이번 fix 가 새 결함을 만들었다 — root-cause 재분석 필수
- Opus tier escalation 권고: 회귀 라운드 root-cause analysis (qa-flow §2 #5)

## 자율 Run 정책 (PDD O8)

- 2.x 런타임 / DB DDL / git 작업 절대 금지
- 코드 수정은 fix task in_progress 상태에서만
- 수정 범위는 evidence file:line 에서 최소 trace — 무관한 리팩토링 금지
  (별도 task 필요)
- ALTER TABLE ADD COLUMN (non-destructive) 만 허용

## 라운드 데이터 참고 (9000-런)

| 라운드 | defect 수 | 비고 |
|--------|-----------|------|
| R2 | 458 | 초기 대규모 결함 발견 |
| R3 | 54 | -88% (정상 수렴) |
| R4 | 17 | -69% |
| R5 | 1 | -94% |
| R6 | 0 | 수렴 |
| R7 | 0 | 2 라운드 연속 0 → 완료 |

단조 감소 패턴 확인. R3 에서 420 scenario_error 가 발생한 것은 시나리오층
정련이 코드층 수렴보다 앞서 일어나는 자연 패턴.
