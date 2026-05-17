# 시나리오 작성 규칙 (User Scenario Authoring)

> **참조**: 본 파일은 `skills/scenario-author/RULE.md` 와 동일한 scenario-authoring
> 룰 본체다. `/scenario-refine` skill 은 특히 **§갱신 규칙** 과 **§라운드 내
> 정련** 섹션을 운영 인터페이스로 사용한다.

> **상태: STABLE — Clawket plugin 정본.** PDD `skills/pdd/RULE.md` 발견-수렴
> 루프와 통합. atomic 분해는 결과물(작성 시점에 끝내는 것)이 아니라 과정(루프
> 안에서 진행되는 것). 시나리오는 사전-*완전* 이 아니라 사전-*예비* + 라운드
> 내 정련.

사용자 시나리오 / 사용자 스토리를 작성할 때 적용하는 글로벌 규칙.
`skills/pdd/RULE.md` / `skills/qa-batch/RULE.md` 와 한 쌍 — 시나리오는 의도,
PDD 는 실행 명세화, qa-flow 는 검증. 세 룰은 단일 발견-수렴 루프 안에서
통합 운영된다.

## 핵심 철학

**시나리오는 "의도(intent)" 의 명시적 기록이지, 코드 동작의 받아쓰기가
아니다.**

- 코드는 의도를 실현하려고 만들어진 결과물 — 의도와 일치할 수도, 어긋날 수도
  (=버그) 있다
- 시나리오는 의도 그 자체를 박는다. 그래야 코드 검증의 기준선(spec)이 된다
- 코드를 그대로 transcribe 하면 버그도 정상으로 박제되어 QA 의미가 0 이 된다

### 시나리오는 mutable

시나리오는 사전-*완전* 이 아니다. **사전-예비 (큰 그림 + atomic 시나리오 초안)**
+ **라운드 내 정련 (scenario_error 처리)** 의 두 단계로 구성된다. 시나리오
mutability 의 갱신 사유는 **"의도 부적절"** 에 한정 (qa-flow.md §3 규칙 #6
참조).

## 출처 규칙 (Source of Truth)

1. **현재 구현(implementation)을 단서로 의도를 추론한다.** 코드 + UI 라벨 +
   메뉴 구조 + 명명 + 비즈니스 정책. 누적된 결정의 manifest 이므로 최신.
2. **이미 알려진 버그 / 모호 동작은 의도가 아니다.** 시나리오에는 의도된
   형태로 기록. 코드가 어긋나면 자동으로 결함.
3. **옛 기획 문서는 진실 기준이 아니다.** 그 후 추가/변경된 부분이 누락되어
   있을 수 있음 — 참고만.
4. **출처 충돌 시 우선순위**: 사용자(PM) 직접 확정 > 현 구현 추론 > 옛 docs.

## 형식 (필수)

```
US-<DOMAIN>-<NNN>: <한 줄 요약>

  As a <액터>
  I want <목표 행동>
  So that <달성하려는 가치>

  수용 기준
  - Given <상태>, When <트리거>, Then <기대 결과>
```

- ID 는 unique. 도메인 prefix 사용 (예: `US-CHESS-PUZZLE-001`)
- `As a / I want / So that` 세 줄 모두 필수. 같은 goal 이 여러 시나리오에
  반복돼도 OK (각 시나리오는 독립 검증 단위)
- 수용 기준은 반드시 Given/When/Then 형식

## 입자 규칙 (Atomicity — 결과물이 아니라 과정)

**1 시나리오 = 1 testable assertion.** atomic 분해는 *작성 시점에 끝내야 하는
결과물* 이 아니라 *발견-수렴 루프 안에서 도달하는 과정*.

### 작성 시점 (사전 예비)

- 한 시나리오의 수용 기준은 원칙적으로 Given/When/Then 1건
- 분리 불가능한 단언만 `And` 로 보조 가능 (예: 한 액션의 두 부수효과가 원자적
  으로 함께 발생)
- 다른 트리거 / 다른 결과 / 다른 조건 / 다른 분기는 별도 시나리오로 분리
- 메뉴 1개당 시나리오 수 50~수백 개가 정상 — QA 에서 1 시나리오 = 1 task 매핑
  가능 조건

### 라운드 내 정련

- 작성 시점에 atomic 이 보장 안 되도 OK — 발견-수렴 루프의 sub-agent 가
  reasoning 중 비-atomic 시나리오 (한 시나리오에 두 가정 섞임) 발견 시
  `scenario_error` 로 마킹
- /scenario-refine skill 이 처리:
  - **atomic 분해**: 1 → N 시나리오 (새 ID 부여)
  - **의도 재정의**: 시나리오 ID 보존, 본문만 갱신
  - **삭제**: ID 영구 비움
- 라운드를 거치며 시나리오가 점진적으로 atomic 으로 수렴

## 금지 사항

- **file:line 인용 금지.** 시나리오는 의도 레벨 — 코드 매뉴얼이 아니다.
  (file:line 은 QA 단계의 결함 task 산출물로만 등장 — qa-flow.md §5)
- **모호 표현 금지.** "구현됨", "동작한다", "처리된다", "정상 표시된다" 등
  검증 불가능한 동사 사용 금지. 관찰 가능한 사실로 서술.
- **결함 / 알려진 버그 언급 금지.** 시나리오 본문에 "현재 X 가 안 된다" 같은
  표현 금지 — 의도된 형태만 기록한다. 결함은 QA 산출물에서 분리 관리.
- **코드 스니펫 첨부 금지.**
- **그룹 헤더로 묶어 As a/I want/So that 한 번에 처리 금지.** 각 원자 시나리오는
  자신의 As a/I want/So that 을 가진다.
- **변경 이력 / changelog 흔적 금지** (갱신 규칙 §아래 참조)

## 산출물

- 위치: 프로젝트의 단일 진실 공급원 (예: Clawket knowledge)
- 한 메뉴 / 한 화면 / 한 기능 단위당 1 knowledge (시나리오 모음)
- 결함 task / QA 산출물과는 별개 knowledge 로 분리

## 갱신 규칙 (/scenario-refine 인터페이스)

**knowledge 는 항상 *현재 의도* 만 담는다 — 히스토리/변경 로그 보존 금지.**

### /scenario-refine 처리 절차 (qa-flow.md §3 규칙 #5 와 동기화)

1. QA 라운드 중 sub-agent 가 `scenario_error` 마킹 → /scenario-refine skill
   호출
2. 3-way 분기:
   - **atomic 분해**: 새 ID `US-<DOMAIN>-<NNN+1>`, `US-<DOMAIN>-<NNN+2>` 등
     부여. 원 ID 는 cancelled QA task comment 에 "이 ID 는 X, Y 로 분해됨"
     으로 흔적만.
   - **의도 재정의**: 같은 ID 보존. 본문 갱신.
   - **삭제**: ID 영구 비움 (재사용 금지). cancelled QA task comment 에 삭제
     사유 흔적 남김.
3. knowledge 갱신 — 현재 의도만 보존
4. 변경의 *역사* 는 그 시나리오를 cancelled 처리한 QA task 의 코멘트 (qa-flow.md
   §3 규칙 #5) + audit 보고서 knowledge (`type=note, title=
   scenario_error audit log <도메인>`) 양쪽에 영구 보존 — 두 곳에 두고 knowledge
   에는 두지 않는다.

### ID 무결성

- 시나리오 ID 는 한 번 부여하면 재할당하지 않는다 (`US-<DOMAIN>-<NNN>` 의 NNN
  은 영구)
- 시나리오를 삭제하면 그 번호는 비워둔다 (재사용 금지) — 라운드별 QA task 와의
  추적 무결성을 위해
- atomic 분해 시 새 ID 부여 (NNN+1, NNN+2 식으로 연속 번호)

### 갱신 가능 기준 (qa-flow.md §3 규칙 #6 동기화)

시장-정합 아키텍처 / 제품 완성도 관점에서 시나리오의 **의도 자체가 부적절**
한 경우에 한해 amend / delete:

- ✅ 가능: "이 시나리오는 두 가정이 섞임 — atomic 분해 필요"
- ✅ 가능: "이 시나리오의 expected result 가 제품 비전과 어긋남 — 의도 재정의"
- ✅ 가능: "이 기능은 다음 major scope 으로 deferred — 시나리오 삭제, 새 knowledge 로 이관"
- ❌ 불가: "이 시나리오 만족하려면 코드 영향 너무 큼 — 시나리오 약화"
- ❌ 불가: "토큰 비용이 많이 듦 — 시나리오 합치자"
- ❌ 불가: "지금 라운드 안에 시간이 부족 — 시나리오 수 줄이자"

코드 영향이 크면 시나리오를 고치지 말고 **모든 영향 코드를 고치는 plan/task
를 등록** (PDD 원칙).

## 작성자 자기 점검 (체크리스트)

### 사전 예비 작성 시
- [ ] 모든 시나리오에 As a / I want / So that 3줄 + Given/When/Then 1건이 있다
- [ ] 1 시나리오에 Given/When/Then 이 2건 이상이면 분리했다 (사전 예비 시점에
      가능한 한 atomic)
- [ ] file:line 인용이 0 건이다
- [ ] "구현됨" / "동작한다" 표현이 0 건이다
- [ ] 알려진 버그를 의도된 형태로 적었다 (현 동작 받아쓰기 안 했다)
- [ ] 모든 ID 가 unique 이다

### 라운드 내 정련 시 (/scenario-refine 호출 시)
- [ ] 갱신 사유가 "의도 부적절" 이다 (시간/비용/복잡도 사유 아님)
- [ ] cancelled QA task comment 에 사유 영구 기록
- [ ] audit 보고서 knowledge 에 누적 기록
- [ ] knowledge 에는 *현재 의도* 만 (히스토리 흔적 금지)
- [ ] 삭제된 ID 는 비워둠 (재사용 금지)
- [ ] atomic 분해 시 새 ID 부여 (연속 번호)

## /scenario-author skill 인터페이스

본 룰은 Clawket plugin 정본 skill `skills/scenario-author/` 의 RULE 본체. skill 은
다음 입력으로 호출된다:

- 도메인 명 (e.g., "Chess 학습", "Daemon API")
- 메뉴/영역 단위 (knowledge 1개 단위)
- 출처 자료 (코드 위치, UI 라벨 inventory, 비즈니스 정책 문서)

산출물:
- knowledge (`type=spec`) — 시나리오 모음
- 시나리오 수 lower bound (라운드 내 정련 통해 변동 가능)

## 운영 노트

- 시나리오층과 코드층은 시간차로 안정화되는 게 자연 패턴 — 시나리오층 정련이
  먼저 수렴하고, 코드층은 그 후 라운드를 통해 수렴
- atomic 분해 결과물이 작성 시점에 보장 안 돼도 정상. 발견-수렴 루프가 보장
- "메뉴 1개당 50~수백 시나리오" 는 사전 예비 시점 가이드. 라운드 내 정련을
  거치면 늘어나거나 줄어듦
- /scenario-refine 호출 빈도가 라운드를 거치며 줄어드는 게 시나리오층 수렴
  신호
