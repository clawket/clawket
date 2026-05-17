---
name: scenario-author
description: atomic 사용자 시나리오 작성 — Given/When/Then 형식 강제, 도메인별 knowledge 산출. 발견-수렴 루프의 Phase 0 진입점. Clawket plugin 정본 skill. RULE.md (scenario-authoring.md) 적용.
---

# /scenario-author — Atomic 시나리오 작성

PDD 발견-수렴 루프의 Phase 0 (시나리오 사전 예비 설계) 를 담당. `skills/scenario-author/RULE.md` (scenario-authoring.md 룰) 의 운영 인터페이스. Phase 0 (`/scenario-author`) 산출 knowledge 를 입력으로 받아 Plan/Unit 골격을 박는다.

## 입력

다음 중 하나 이상:
- 도메인 명 + 메뉴/영역 (e.g., "Clawket Daemon API", "Chess 학습 메뉴")
- 출처 자료: 코드 위치, UI 라벨 inventory, 비즈니스 정책
- 기존 knowledge 갱신 요청 (`/scenario-refine` 가 호출하는 경로)

## 처리 절차

### 1. 출처 정리
- 현재 구현 (코드 + UI 라벨 + 메뉴 구조) 를 1차 단서로 사용 (출처 우선순위 §출처 규칙)
- 옛 docs 는 참고만 (변경분 누락 가능성)
- 출처 충돌 시: 사용자 직접 확정 > 현 구현 추론 > 옛 docs

### 2. atomic 시나리오 초안 작성
형식 강제:
```
US-<DOMAIN>-<NNN>: <한 줄 요약>

  As a <액터>
  I want <목표 행동>
  So that <달성하려는 가치>

  수용 기준
  - Given <상태>, When <트리거>, Then <기대 결과>
```

원칙:
- ID 도메인 prefix 강제 (예: `US-DAEMON-API-001`)
- 1 시나리오 = 1 testable assertion (작성 시점 atomic — 라운드 내 정련 가능)
- 다른 트리거 / 다른 결과 / 다른 조건 / 다른 분기 = 별도 시나리오
- 메뉴 1개당 50~수백 시나리오가 정상 (사전 예비 시점)

### 3. 금지 사항 검증
- file:line 인용 0 건 (시나리오는 의도 레벨)
- 모호 표현 ("구현됨", "동작한다", "처리된다") 0 건
- 결함/알려진 버그 언급 0 건 (의도된 형태만)
- 코드 스니펫 첨부 0 건
- 그룹 헤더로 묶어 As a/I want/So that 한 번에 처리 0 건
- changelog/변경 이력 흔적 0 건

### 4. knowledge 산출
- 위치: Clawket knowledge, `type=spec`
- 단위: 메뉴/화면/기능당 1 knowledge
- 시나리오 수 lower bound 명시 (라운드 내 정련으로 변동 가능)
- knowledge 명: `<도메인> <영역> 시나리오` (e.g., "Daemon API 시나리오")

### 5. PDD 연계
산출 후 `/pdd-plan` skill 로 넘어감 — Plan + Unit 사전 예비 설계 단계.

## 작성자 자기 점검 체크리스트

### 사전 예비 작성 시
- [ ] 모든 시나리오에 As a / I want / So that 3줄 + Given/When/Then 1건이 있다
- [ ] 1 시나리오에 Given/When/Then 이 2건 이상이면 분리했다
- [ ] file:line 인용이 0 건이다
- [ ] "구현됨" / "동작한다" 표현이 0 건이다
- [ ] 알려진 버그를 의도된 형태로 적었다 (현 동작 받아쓰기 안 했다)
- [ ] 모든 ID 가 unique 이다
- [ ] knowledge 에 changelog/변경 이력 흔적이 0 건이다 (현재 의도만)

## 출력

- knowledge 1개 (or 도메인이 큰 경우 N 개)
- knowledge ID 들
- 다음 단계 안내 (`/pdd-plan` 호출 권고)

## 관련 파일

- 룰 본체: `skills/scenario-author/RULE.md`
- 짝 skill: `/scenario-refine` (라운드 내 정련), `/pdd-plan` (다음 phase)
