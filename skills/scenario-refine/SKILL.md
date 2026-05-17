---
name: scenario-refine
description: scenario_error 처리 — atomic 분해 / 의도 재정의 / 삭제 3-way 분기. cancelled QA task comment + audit knowledge 동시 기록. 발견-수렴 루프의 시나리오 정련 단계. Clawket plugin 정본 skill. RULE.md (scenario-authoring.md) 적용.
---

# /scenario-refine — 라운드 내 시나리오 정련

발견-수렴 루프의 시나리오층 정련 인터페이스. `/discover-loop` 가 라운드 R 의
sub-agent 산출에서 `status=scenario_error` row 를 발견하면 호출.

## 호출 컨텍스트

`/discover-loop` 의 3-way 수렴 판정 결과 `scenario_error_count > 0` 일 때:

```
TSV row example (qa-flow §5):
  scenario_id: US-DAEMON-API-042
  status: scenario_error
  reasoning: "Given 절에 두 가정이 섞임 — '데몬이 실행 중이고 socket 이 readable 함'.
              두 조건은 분리되어 검증 가능하므로 atomic 분해 필요"
  evidence: src/daemon/src/server.rs:120
  scenario_amendment: "split into US-DAEMON-API-042 (daemon 실행) + US-DAEMON-API-043 (socket readable)"
```

## 입력

- 대상 scenario_id 들 (TSV 에서 status=scenario_error 인 row 들)
- 각 row 의 `scenario_amendment` 제안
- 원본 시나리오 knowledge (`type=spec`)
- audit knowledge (`type=note, title=scenario_error audit log <도메인>`) — 없으면 생성

## 처리 절차

### 1. 갱신 사유 검증 (qa-flow §3 #6)

각 scenario_error 마다 다음 중 하나에 해당하는지 확인:

- ✅ **의도 부적절** — 두 가정이 섞임, expected result 가 비전과 어긋남, deferred 등
- ❌ **시간 / 비용 / 복잡도 / 영향 코드 큼** — 시나리오 약화 시도, 거부

거부 사유 발견 시 즉시 중단 + 사용자 confirm 요청. **시간/비용 사유로 시나리오를
약화하지 않는다** (PDD 원칙: 코드 영향 크면 영향 코드 모두 고치는 plan 등록).

### 2. 3-way 분기 결정

각 scenario_error 마다 정확히 1개 분기:

#### (a) atomic 분해 (1 → N 시나리오)

- 새 ID 부여: `US-<DOMAIN>-<NNN+1>`, `US-<DOMAIN>-<NNN+2>` (연속 번호)
- 원 ID = 비움 (재사용 금지)
- 새 시나리오들은 각각 독립 As a/I want/So that + Given/When/Then 1건
- 원본 ID 흔적: cancelled QA task comment 에 "이 ID 는 X, Y, Z 로 분해됨"

```
원본 (US-DAEMON-API-042):
  As a daemon operator
  I want 데몬 healthcheck
  So that 시스템 상태 확인
  Given 데몬이 실행 중이고 socket 이 readable 함, When ...

분해:
  US-DAEMON-API-042 → 영구 비움 (재사용 금지)
  US-DAEMON-API-043: 데몬 프로세스 실행 검증
    Given 데몬 PID 가 ~/.cache/clawket/clawketd.pid 에 있음, When ps -p <pid>, Then 0 exit
  US-DAEMON-API-044: socket readable 검증
    Given socket 파일이 존재함, When read syscall, Then EAGAIN 또는 데이터 수신
```

#### (b) 의도 재정의 (ID 보존)

- 같은 시나리오 ID 보존
- 본문 (As a / I want / So that / Given/When/Then) 갱신
- knowledge 의 해당 ID block 만 교체 (히스토리 흔적 X — 갱신 사유는 audit 으로)

```
원본 (US-CHESS-PUZZLE-007):
  Then 모든 정답 수가 표시된다  ← 제품 비전과 어긋남 (예: 3개 한정 표시)

재정의 (같은 ID):
  Then 정답 수 중 우선순위 상위 3개가 표시된다
```

#### (c) 삭제 (ID 영구 비움)

- 다음 major scope 으로 deferred / 기능 자체 폐기 등
- ID 는 영구 비움 (재사용 금지)
- 다른 knowledge 로 이관 시 새 ID 부여

```
US-CHESS-PUZZLE-019: 다음 major scope 으로 deferred → ID 영구 비움
새 knowledge "next-major chess scope" 에 새 ID `US-NEXT-CHESS-001` 로 이관
```

### 3. cancelled QA task comment 기록 (영구 흔적)

해당 라운드의 QA task (status=cancelled) 에 코멘트 추가:

```
clawket comment add --task <QA_TASK_ID> --body "<사유 본문>"
```

코멘트 본문 형식:
```
scenario_error 처리 — <yyyy-mm-dd>
원본 시나리오 ID: US-DAEMON-API-042
분기: atomic 분해 (또는 의도 재정의 / 삭제)
사유: <한 줄 — 의도 부적절 의 구체적 사유>
산출:
- US-DAEMON-API-042 → 영구 비움 (atomic 분해)
- 신규 US-DAEMON-API-043 (데몬 프로세스 실행 검증)
- 신규 US-DAEMON-API-044 (socket readable 검증)
근거 reasoning: <sub-agent reasoning 인용>
근거 evidence: src/daemon/src/server.rs:120
```

### 4. audit knowledge 누적 기록

`skills/scenario-author/RULE.md` §갱신 규칙: cancelled task comment +
audit knowledge **양쪽** 에 기록 (knowledge 본체엔 히스토리 흔적 X).

audit knowledge 형식 (`type=note, title=scenario_error audit log <도메인>`):

```
clawket knowledge create --project <PROJ> --type note --title "scenario_error audit log <도메인>" ...
```

본문 누적 row:
```
| Round | 원본 ID | 분기 | 사유 | 신규 ID(들) | reasoning 인용 |
|---|---|---|---|---|---|
| R3 | US-DAEMON-API-042 | atomic 분해 | 두 가정 섞임 | 043, 044 | sub-agent reasoning 인용 |
| R3 | US-CHESS-PUZZLE-007 | 의도 재정의 | 제품 비전 불일치 | (보존) | ... |
| R3 | US-CHESS-PUZZLE-019 | 삭제 | 다음 major scope 으로 deferred | (없음) | ... |
```

라운드를 거치며 누적 (절대 갱신 X — append-only).

### 5. spec knowledge 갱신 (현재 의도만)

원본 시나리오 knowledge 를 갱신:
- atomic 분해 → 원 ID block 제거 + 신규 ID block 추가
- 의도 재정의 → 같은 ID block 만 교체
- 삭제 → 해당 ID block 제거

knowledge 본체엔 changelog / 변경 이력 남기지 않는다 (히스토리는 cancelled task
comment + audit knowledge 에).

### 6. 다음 라운드 R+1 진입

`/discover-loop` 로 복귀 → 갱신된 knowledge 기반으로 R+1 sub-agent dispatch.
정련된 시나리오들은 R+1 에서 새 task 로 평가받는다.

## ID 무결성 (절대 규칙)

- 시나리오 ID 는 한 번 부여 후 재할당 금지 (`US-<DOMAIN>-<NNN>` 의 NNN 영구)
- 삭제 / atomic 분해된 ID 는 비워둔다 (재사용 금지) — 라운드별 QA task 와의
  추적 무결성 보장
- atomic 분해 시 새 ID 는 마지막 NNN 다음 연속 번호로 부여

## 자기 점검 체크리스트

- [ ] 갱신 사유가 "의도 부적절" 이다 (시간/비용/복잡도 사유 거부됨)
- [ ] 3-way 분기 (atomic 분해 / 의도 재정의 / 삭제) 중 정확히 1개로 처리됨
- [ ] cancelled QA task comment 에 사유 + 분기 + 신규 ID 기록됨
- [ ] audit knowledge 에 row append 됨 (라운드 누적)
- [ ] spec knowledge 본체엔 *현재 의도* 만 (히스토리 흔적 0)
- [ ] 삭제된 ID / 분해된 원 ID 는 영구 비움 (재사용 X)
- [ ] atomic 분해 시 신규 ID 가 연속 번호로 부여됨

## Anti-pattern 거부

- **시간 압박으로 시나리오 합치기** → 거부 (qa-flow §3 #6 ❌)
- **토큰 비용으로 시나리오 약화** → 거부
- **코드 영향 크다고 시나리오 약화** → 거부 (대신 영향 코드 plan/task 등록)
- **knowledge 본체에 changelog 추가** → 거부 (audit knowledge 로 분리)
- **삭제된 ID 재사용** → 거부 (NNN 영구 비움)

## 자율 Run 정책 (PDD O8)

자율 처리 시 불가침:
- 시나리오 amend / delete 가 "의도 부적절" 사유 임을 명시 (시간/비용 사유 X)
- 의심스러운 amendment 는 사용자 confirm
- 런타임 / DB DDL / git 작업 절대 금지

## 출력

- 갱신된 spec knowledge (현재 의도만)
- audit knowledge (누적)
- cancelled QA task comment 기록
- 다음 라운드 R+1 진입 신호 (`/discover-loop` 호출)

## 관련 파일

- 룰 본체: `skills/scenario-refine/RULE.md`
- 룰 본체: `skills/qa-batch/RULE.md` (§3 절대 규칙 #5, #6)
- 짝 skill: `/scenario-author` (Phase 0 작성), `/discover-loop` (호출 진입점)
