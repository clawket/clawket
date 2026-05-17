---
name: pdd-plan
description: PDD Plan + Unit 사전 예비 설계 — Done 명제, Unit 분해, 의존성 그래프, 수렴 조건 박기. 발견-수렴 루프의 Phase 1 진입점. Clawket plugin 정본 skill. RULE.md (pdd.md) 적용.
---

# /pdd-plan — Plan + Unit 사전 예비 설계

발견-수렴 루프의 Phase 1 진입점. `skills/pdd/RULE.md` (pdd.md 룰) 의 운영 인터페이스. Phase 0 (`/scenario-author`) 산출 knowledge 를 입력으로 받아 Plan/Unit 골격을 박는다.

## 입력

- Phase 0 산출 knowledge (도메인별 시나리오 모음)
- Project ID (`clawket project list` 로 확인)
- 도메인 명 (Plan 명 도출용)

## 처리 절차

### 1. Plan 정체성 박기 (C1~C8 통과)

```
clawket plan create --project <PROJECT_ID> --description "<body>" "<TITLE>"
```

Plan body 필수 섹션:
1. **명** — 단일 명사구, 산출물 본질 압축 (C1)
2. **Done 정의** — 외부 검증 명제 N개 (C2). 수렴 조건 포함 (C6)
3. **Unit 분해** — 모든 시나리오 → 정확히 1 Unit 환원 (C3)
4. **Unit 별 시나리오 수 lower bound + sub-area** (C4)
5. **Unit 의존성 그래프** — 직렬/병렬 (C5)
6. **수렴 조건** — defect=0 + scenario_error=0 + 2 라운드 연속 (C6)
7. **롤백 트리거** — Plan blocked 전환 조건 (C7)
8. **진실 공급원** — Plan ID + knowledge 미러 위치 (C8)

### 2. Unit 분해 (U1~U4 통과)

```
clawket unit create --plan <PLAN_ID> --idx <N> --mode <sequential|parallel> --goal "<GOAL>" "<TITLE>"
```

각 Unit:
- **U1**. 명: `<도메인> <영역>` (예: `QA-Daemon API`)
- **U2**. 시나리오 수 명시 (knowledge 와 일치, 라운드 내 정련으로 변동 가능)
- **U3**. 다른 Unit 과의 의존 ID (없으면 "독립")
- **U4**. mode: `sequential` (순차) | `parallel` (sub-agent 병렬 가능)

### 3. Plan 승인 (draft → active)

```
clawket plan approve <PLAN_ID>
```

승인 전엔 task 시작 불가. 승인 후 발견-수렴 루프 진입 가능.

### 4. 검증 통과 체크

- [ ] Plan 명 = 단일 명사구
- [ ] Done 정의 = 외부 검증 명제 (수렴 조건 포함)
- [ ] 모든 시나리오가 Unit 으로 환원됨 (사전 예비 단계)
- [ ] Unit ≤ 12 (초과 시 명시적 예외 사유)
- [ ] Plan ≤ 1 활성 (전환기 ≤ 2 허용)

### 5. 다음 단계

`/discover-loop` skill 호출 → Round 1 cycle 활성화 + sub-agent dispatch.

## Anti-pattern 거부

작성 중 다음 중 하나라도 발견되면 즉시 거부:

- **X1**. "검토 / 분석 / 조사" 류 task → Plan 회귀
- **X2**. "유연하게 / 필요 시 / 추후 보강" → 의사결정 회피
- **X3**. 시나리오 환원 불가 task → spec 외
- **X4**. Done = "구현 완료" 자기참조 → 외부 명제로 재정의
- **X5**. 수렴 조건 부재 → 재분해
- **X6**. 시간 기반 종료 ("2주 후") → 산출물 기반 재정의

## 자율 Run 정책 (PDD O8)

자율 dispatch 시 불가침:
- 런타임 상태 수정 금지 (`~/.local/share/clawket`, `~/.cache/clawket`, `~/.config/clawket`, `~/.local/state/clawket`, `~/.claude/plugins/clawket-*`)
- DB DROP/DELETE/TRUNCATE 절대 금지
- git reset/commit/push/tag/release 절대 금지

## 출력

- Plan ID
- Unit ID 목록 + idx 매핑
- 다음 단계 안내 (`/discover-loop` 호출)

## /pdd-promote — EXPERIMENTAL → STABLE 승급 + cleanup (확인 프롬프트)

본 skill 은 **/pdd-promote** 서브-명령을 함께 노출한다. RULE.md 의 헤더 라벨을
`EXPERIMENTAL` 에서 `STABLE` 로 전환하고, 임시 user-scope skill / rule stub 을
정본 plugin 으로 일원화하는 manual gate. 자동 promote 는 PDD §실험 → 정본 승격
기준의 5개 체크박스 (lifecycle 완주, batch ≤30 강제, scenario_id + evidence
100%, scenario_error 자연 발생, X3/X7/X8/X9 hook 차단) 를 모두 충족해야 한다.

### 호출 형식

```
/pdd-promote <skill-name>
```

### 처리 절차

#### Step 1 — STABLE label transition

1. `skills/<skill-name>/RULE.md` 가 존재하는지 확인
2. 5개 체크박스 충족 증거를 표시 (lifecycle Plan ID, last 2 round defect=0,
   scenario_id+evidence 100% query, scenario_error 자연 발생 흔적, hook 차단
   로그)
3. RULE.md 라인 3 의 `상태: EXPERIMENTAL — ...` → `상태: STABLE — Clawket
   plugin 정본.` 으로 치환
4. CHANGELOG.md 에 `[<version>] PDD <skill-name> promoted EXPERIMENTAL → STABLE`
   entry 추가

#### Step 2 — Cleanup confirm prompt (필수)

STABLE 라벨 전환 직후, 다음 프롬프트를 사용자에게 출력한다:

```
EXPERIMENTAL → STABLE 승급이 완료되었습니다.
이어서 user-scope 임시 skill / rule 의 cleanup 을 수행하시겠습니까?
  - ~/.claude/skills/{pdd-plan,scenario-author,qa-batch,discover-loop,scenario-refine}/ 삭제
  - ~/.claude/rules/{pdd,scenario-authoring,qa-flow}.md → 1-line stub 대체
진행하시겠습니까? [y/N]:
```

기본값은 `N` (skip). 명시적 `y` / `yes` 입력만 cleanup 으로 진행한다. 그 외
모든 응답 (빈 입력, `n`, `no`, 무응답) 은 Step 4 (skip 분기) 로 라우팅.

#### Step 3 — Confirm 분기 (사용자 응답 = `y`)

PDD plugin 정본 skill 들이 STABLE 로 승급되면, user-scope `~/.claude/skills/*`
의 임시 사본은 plugin 정본과 중복된다. 동일하게 `~/.claude/rules/*.md` 룰
파일 본문은 plugin 의 `skills/<name>/RULE.md` 가 정본이 된다. 다음 cleanup 을
순서대로 수행한다:

3a. `~/.claude/skills/pdd-plan/` 디렉터리 전체 삭제
3b. `~/.claude/skills/scenario-author/` 디렉터리 전체 삭제
3c. `~/.claude/skills/qa-batch/` 디렉터리 전체 삭제
3d. `~/.claude/skills/discover-loop/` 디렉터리 전체 삭제
3e. `~/.claude/skills/scenario-refine/` 디렉터리 전체 삭제
3f. `~/.claude/rules/pdd.md` 본문을 1-line stub 으로 치환:
    `# moved to plugin: clawket/skills/pdd/RULE.md`
3g. `~/.claude/rules/scenario-authoring.md` 본문을 1-line stub 으로 치환:
    `# moved to plugin: clawket/skills/scenario-author/RULE.md`
3h. `~/.claude/rules/qa-flow.md` 본문을 1-line stub 으로 치환:
    `# moved to plugin: clawket/skills/qa-batch/RULE.md`

각 단계는 idempotent 여야 한다 — 이미 삭제됐거나 이미 stub 인 경우 no-op.
경로 invariant: cleanup 대상은 `~/.claude/skills/`, `~/.claude/rules/` 두 트리에
국한. `~/.local/share/clawket/`, `~/.cache/clawket/`, `~/.config/clawket/`,
`~/.local/state/clawket/` 사용자 데이터는 절대 건드리지 않는다 (PDD O8 / LM-8
path separation invariant).

#### Step 4 — Skip 분기 (사용자 응답 ≠ `y`)

cleanup 을 생략하고 Step 1 의 STABLE label 전환만 유지한다. user-scope skill /
rule 은 그대로 남으며, plugin 정본과 user-scope 사본이 공존한다. Claude Code
의 skill 우선순위 규칙 (plugin > user) 으로 정본이 선택되지만, user-scope
사본은 stale 본이 될 수 있음을 사용자에게 1줄로 고지한다:

```
cleanup 을 생략했습니다. user-scope 사본은 stale 본이 될 수 있으므로
다음 라운드에서 /pdd-promote 재호출 또는 수동 정리를 권장합니다.
```

### 출처 / 근거

- **Step 1 STABLE 전환**: PDD RULE.md `## 실험 → 정본 승격 기준` 5 체크박스
- **Step 2 confirm prompt**: PDD O8 manual gate 정책 — 자동 mutation 금지,
  명시적 동의만 허용
- **Step 3 cleanup 대상 경로**: 본 plugin 의 정본 skill 5개 (pdd-plan,
  scenario-author, qa-batch, discover-loop, scenario-refine) 가 모두
  `~/.claude/skills/<name>/` 에 임시로 존재하며 STABLE 승급 후 중복. RULE 파일
  3개 (pdd.md, scenario-authoring.md, qa-flow.md) 는 PDD RULE.md `## 실험 →
  정본 승격 기준` 의 "정본 plugin 의 `skills/<name>/RULE.md` 로 이주" 항목에
  의해 stub 대체.
- **Step 3 path separation**: LM-8 invariant — `~/.local/share/clawket`,
  `~/.cache/clawket`, `~/.config/clawket`, `~/.local/state/clawket` 사용자
  데이터 트리는 cleanup 대상 아님.
- **Step 4 skip rationale**: 자율 라운드는 mutation 권한이 없을 수 있으며,
  manual gate 의 부동의 응답은 항상 안전한 기본값 (no-op) 으로 라우팅.

### 자율 Run 정책

자동 promote / 자동 cleanup 금지 — 사용자 명시적 confirm 없이는 라벨 변경 0건,
파일/디렉터리 삭제 0건, stub 치환 0건. PDD O8 의 "git commit/push/tag/release
절대 금지" 와 같은 manual gate 정책 적용. 자율 sub-agent 는 본 정의 본문을
*검증* 할 수 있을 뿐 (정의의 step 가 명시되어 있는지 reasoning) 실제 mutation
은 사용자 confirm 이 들어온 인터랙티브 세션에서만 수행한다.

## 관련 파일

- 룰 본체: `skills/pdd/RULE.md`
- 짝 skill: `/scenario-author` (Phase 0), `/discover-loop` (Phase 2)
