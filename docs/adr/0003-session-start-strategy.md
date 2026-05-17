# ADR-0003 — SessionStart 컨텍스트 복원 전략: priority stack + fallback

| Status | Owner task | Targets | Plan |
|---|---|---|---|
| **Proposed** (LM-246; LM-243 토큰 측정 폐기 결정 반영) | LM-246 | `adapters/shared/claude-hooks.cjs::runSessionStart`, 후속 LM-117 / LM-118 / LM-122 / LM-123 | v11 — Structured Task Contracts |

## Context

세션 간 컨텍스트는 한 세션의 LLM 응답 품질을 결정한다. SessionStart 가 부실하면 직전 세션의 결정·실패·진행 상황이 다음 세션에 전달되지 않고, LLM 은 같은 가정을 다시 세우고 같은 코드를 다시 짠다. v11 의 envelope·ancestor·decision 데이터를 만들어둔 이유의 절반은 이 부분을 닫기 위한 것이다.

LM-245 audit (`docs/session-start-audit.md`) 가 식별한 사실:

- 현재 SessionStart 는 (a) `clawket dashboard --show active` 출력, (b) `prompts/shared/rules.md`, (c) `prompts/claude/runtime.md` 세 가지만 주입한다.
- 활성 태스크 envelope·ancestors·descendants·recent decisions·similar tasks·recent runs·comments — 모두 데몬에는 있지만 hook 에서 호출하지 않는다.
- 누락의 결과: LLM 이 직전 결정을 모른 채 재논의, 부모 unit/plan 의 의도를 본문 한 줄로만 추정, 유사 과거 작업의 함정을 다시 밟음.

기존 가정이었던 "주입량을 토큰 budget 으로 통제한다" 는 LM-243 결정에 따라 폐기되었다. Anthropic 구독 환경에서 정확한 토큰 측정 수단이 없다(tokenizer / count_tokens API / char-approx 모두 부적합). 측정 불가가 전제이므로 byte/token 단위 budget allocation 도 의미 없다.

대안은 두 축이다:

1. **priority stack** — 측정 없이도 동작 가능한 결정적 우선순위. 절단(truncation) 은 항목별 cap 으로 한다.
2. **fallback** — 데몬이 죽었거나 데이터가 없을 때 SessionStart 가 어떻게 graceful 하게 진행할지.

이 ADR 은 그 둘만 다룬다.

## Decision

### (1) Priority stack — 8 단

SessionStart 는 다음 순서로 컨텍스트를 누적 주입한다. 각 단계는 cap 이 명확하고, 이전 단계가 비어 있어도 다음 단계가 채울 수 있다.

| # | 단계 | 출처 | Cap | 누락 시 |
|---|---|---|---|---|
| 1 | Active task envelope (resolved) | 데몬 `GET /tasks/:id/envelope?resolve=true` | 한 envelope 의 19 필드(=수 KB) | 활성 태스크가 없으면 단계 자체 skip + 사용자에게 활성 태스크 지정 권고 |
| 2 | Ancestors (Plan / Unit body) | 데몬 `/tasks/:id/ancestors` | Plan body 1건 + Unit body 1건 (각 ≤ 4kB) | 부모 없으면 skip |
| 3 | Active cycle co-tasks | dashboard 트리 | 같은 cycle 의 in_progress task title + ticket key (cap 5건) | cycle 1개만 활성 시 본인 외 0건 가능 |
| 4 | Descendants 진행 요약 | 데몬 `/tasks/:id/descendants` | 직접 자식 status 카운트만 (재귀 미주입) | 자식 없으면 skip |
| 5 | Recent decisions (RAG) | `clawket_get_recent_decisions` 동등 호출 | 최근 5건의 `type=decision` knowledge title + 1줄 요약 | 0건이면 skip |
| 6 | Similar tasks (KNN) | 데몬 sqlite-vec | top-K=3 (LM-117 의 p95 < 500ms 목표) | 인덱스 부재 / 매칭 0건이면 skip |
| 7 | Active task recent runs | 데몬 `/runs?task_id=&limit=3` | 최근 3 runs status + 마지막 stderr 100자 | 0건이면 skip |
| 8 | Active task comments | 데몬 `/comments?task_id=&limit=5` | 최근 5건 author + body 200자 | 0건이면 skip |

**규칙:**

- 1–4 는 "나는 무엇을 하기로 했는가" — **구조적 컨텍스트**.
- 5–6 은 "비슷한 결정·작업이 과거에 어떻게 끝났는가" — **유사 컨텍스트**.
- 7–8 은 "직전에 무엇이 일어났는가" — **직전 활동**.
- 단계 간 의존 없음 (선행 단계 실패가 후행 단계 skip 을 유발하지 않는다 — fallback 참고).
- 출력 슬롯 분배: 단계 1–4 → `additionalContext` 상단, 단계 5–8 → `additionalContext` 하단. `systemMessage` 한 줄은 기존 그대로(`buildSummary` 카운트).

**의도적으로 stack 에 넣지 않은 항목:**

- Drift warnings — LM-82 / `/tasks/:id/drift` 미구현. 별도 작업 후 추가.
- Decomposition warnings — LM-119 미구현. PreToolUse 가 적정 위치이므로 SessionStart 에는 두지 않는다.
- 전체 plan 트리 — dashboard 출력이 이미 활성 cycle 트리를 보여줌 (중복 회피).

### (2) Fallback — 4 모드

SessionStart 가 실패해도 세션은 시작될 수 있어야 한다. 절대 hook exit code 비제로로 차단하지 않는다.

| 모드 | 트리거 | 동작 |
|---|---|---|
| **F1. Daemon-missing** | `ensureDaemon()` 자동 기동 실패 (binary 없음 / port 점유 / 권한) | 단계 1–8 모두 skip. `additionalContext` 에는 (b)+(c) 정적 prompt 만. `systemMessage` 에 `clawket daemon` 미가용 경고 1줄. exit code 0. |
| **F2. Daemon-up but no active task** | 데몬 OK, `clawket task list --status in_progress` 0건 | 단계 1·2·4·7·8 skip. 단계 3·5·6 은 시도. `systemMessage` 에 "활성 태스크 없음 — 시작 전 지정" 권고 1줄. |
| **F3. Endpoint partial failure** | 단계 N 의 데몬 호출이 5xx / timeout (개별 단계당 750ms cap) | 해당 단계만 skip, 나머지는 진행. stderr 에 `[clawket session-start] step <N> degraded: <reason>` 한 줄. |
| **F4. Empty data** | 데몬 OK, 호출 OK, 결과 0건 (자식 없음 / 결정 없음 / 유사 없음) | 해당 단계 silent skip. 경고 미출력. |

**불변:**

- SessionStart 가 어떤 경우에도 30s 안에 종료한다. 단계별 cap 750ms × 8 = 6s 상한 + dashboard exec 여유.
- 데몬 호출 실패는 stderr 한 줄로만 보고, prompt 에는 노이즈로 들어가지 않는다.
- F1 모드에서도 `prompts/shared/rules.md` 와 `prompts/claude/runtime.md` 는 항상 주입 (정적 파일이므로 데몬 무관).

### (3) 절단(truncation) 규칙

토큰 측정 없이도 결정적이도록 항목 단위 cap 만 사용한다. byte/token cap 은 두지 않는다.

| 항목 | Cap |
|---|---|
| envelope 본문 | 19 필드 그대로 (필드별 길이 cap 은 ADR-0001 이 이미 명시) |
| Plan / Unit body | 각 4kB 로 trim, 초과 시 head 4kB + `…(trimmed)` 표식 |
| co-tasks | 최대 5건 |
| descendants | 직접 자식의 status 카운트만 (본문 미주입) |
| decisions | 최대 5건 (title + 1줄 요약) |
| similar tasks | top-K=3 |
| runs | 최근 3건, stderr 100자 tail |
| comments | 최근 5건, body 200자 head |

cap 초과 시 동작은 모두 "head/tail 자르고 `…(trimmed)` 표식". stack 단계 자체를 통째로 skip 하지 않는다.

## Re-open trigger

다음 중 하나가 발생하면 이 ADR 을 amendment 로 재검토한다.

1. **Anthropic 이 정확한 토큰 측정 수단을 공식 제공** — tokenizer 패키지 또는 count_tokens API 가 구독 플랜에서도 정확하다고 검증되면, 항목별 cap 위에 byte/token budget allocation 을 추가 검토.
2. **Drift / decomposition warnings 구현 (LM-82, LM-119) 완료** — stack 에 단계 추가 (현재는 의도적으로 제외).
3. **단계별 750ms cap 상시 초과** — p95 latency 측정에서 SessionStart 총 elapsed 가 8s 를 넘기는 환경이 다수 보고되면 stack 단계 수 또는 cap 재조정.

이 외의 사유 — 예: "더 많은 컨텍스트를 넣고 싶다" — 만으로는 amendment 하지 않는다. priority stack 의 단계 수가 늘어나는 것은 항상 새 데이터 종류가 생겼을 때만이다.

## Out of scope

- **byte / token 단위 budget allocation** — 측정 수단 부재(LM-243). 항목별 cap 으로 갈음.
- **2500 하드캡** — 가설 자체 폐기.
- **다른 hook (UserPromptSubmit, PreToolUse, PostToolUse) 의 컨텍스트 주입** — 본 ADR 은 SessionStart 만 다룬다. 다른 hook 의 주입은 LM-117 / LM-118 / LM-119 가 별도 결정.
- **동적 우선순위 (사용자 선호 / 학습 기반)** — priority stack 은 결정적이어야 한다. 동적 변형은 별도 ADR.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **byte / token budget allocation per section** | 측정 불가. 부정확한 추정으로 결정을 내리면 항목 누락이 무작위로 일어나 재현성 깨짐. |
| **2500 자 / 토큰 하드캡** | 가설이 측정 수단 부재 위에 서 있음 (LM-243). |
| **stack 없이 dashboard 출력만 강화** | dashboard 출력을 BLOB 처럼 키우면 단계별 fallback 이 불가능해진다 (한 호출 실패가 전체 부재로 번짐). |
| **데몬 호출 실패 시 hook exit 1** | 세션 자체를 막는다. SessionStart 는 best-effort 여야 한다 (F1 fallback 참고). |
| **stack 단계 우선순위를 사용자별로 동적 조정** | 결정적이지 않으면 재현성 / 디버깅 / E2E 테스트가 불가능. 동적 변형은 별도 ADR 로 격리. |
| **모든 단계 병렬 호출** | 좋은 아이디어처럼 보이지만 sqlite-vec 단일 connection 경합·hook 가독성 트레이드오프가 큼. LM-117 의 p95 < 500ms 측정이 직렬로도 충족 가능하면 직렬 유지. 측정 후 amendment. |

## Consequences

### Positive

- 측정 수단 없이도 결정적·재현 가능한 SessionStart.
- 데몬 부재·데이터 부재가 hook 실패로 번지지 않음.
- LM-117 / LM-118 / LM-122 / LM-123 의 구현 범위가 priority stack 8 단으로 명확히 묶임.

### Negative

- 단계별 cap 이 작아 환경 따라 컨텍스트가 부족할 수 있다 — 측정 수단이 생기면 amendment 로 boost.
- 직렬 호출 합산 latency 가 환경에 따라 6s 를 넘길 가능성. F3 (개별 단계 timeout) 로 상한은 보장되지만 사용자 체감은 느릴 수 있음.

### Neutral / deferred

- Drift / decomposition warnings 위치는 본 ADR 에서 의도적으로 보류. 후속 ADR.
- Stack 의 출력 슬롯 분배(상단/하단) 가 LLM 응답 품질에 미치는 영향은 측정 후 조정 가능.

## Implementation pointers

| Surface | Where | Owner |
|---|---|---|
| Stack 구현 | `adapters/shared/claude-hooks.cjs::runSessionStart` (단계 1–8 helper 분해) | LM-117 |
| Envelope 상속 체인 결합 | 단계 1·2 helper | LM-118 |
| Daemon-missing fallback | `ensureDaemon()` 실패 분기 + (b)(c) 정적 prompt path | LM-123 |
| Hook 계약 문서 (사용자/플러그인 작성자용) | `docs/SESSION_START_CONTRACT.md` (LM-122) — 이 ADR 의 priority stack/fallback 표를 참조 | LM-122 |
| 단계별 latency 측정 | `clawket doctor` 4 metric 확장 | LM-121 / LM-234 |

## Approval

본 ADR 은 LM-246 의 산출물이며, 다음 시점에 **Accepted** 로 승격된다:

1. LM-117 이 priority stack 1–6 을 구현하여 dogfood (env 1 세션) 에서 누락 없이 동작 확인.
2. LM-123 이 F1·F2 fallback 을 구현하여 daemon-down 환경에서 hook 가 exit 0 으로 종료 확인.
3. LM-122 가 `SESSION_START_CONTRACT.md` 에 본 ADR 을 정본으로 참조.

그 전까지는 **Proposed**.
