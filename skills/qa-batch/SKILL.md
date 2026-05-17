---
name: qa-batch
description: Sub-agent batch dispatch + TSV evidence emit + Python ThreadPoolExecutor 16-worker bulk sync transcription. 9000-태스크 자율 런 검증 패턴 캡슐화. PDD A8 운영 인터페이스. Clawket plugin 정본 skill (v3.0). RULE.md (qa-flow.md v3.0) 적용.
---

# /qa-batch — Sub-agent batch dispatch + bulk sync transcription

`/discover-loop` 의 Round R 안에서 호출되는 reasoning 단계. 9000-태스크 자율 런
회고에서 추출한 검증된 작업 패턴: **reasoning (sub-agent batch) ≠ sync (bulk
transcription)** 분리. 하나라도 섞이면 X9 anti-pattern.

## 핵심 모델

```
[reasoning 단계]                              [sync 단계]
  Sub-agent N개 병렬                  →        Python ThreadPoolExecutor 16-worker
  (1 agent / 1 unit / ≤ 30 시나리오)            (TSV → DB transcription only)
       ↓                                          ↓
  TSV evidence knowledge                         Clawket task DB
```

**불가침 분리**: sync 단계엔 reasoning 결정이 들어가지 않는다. status 매핑은
TSV 가 이미 결정한 것을 옮길 뿐.

## 입력

- 라운드 번호 R
- Cycle ID (활성)
- 처리할 Unit 목록 + 각 Unit 의 시나리오 knowledge ID + code paths
- batch size (기본 30, ≤ 30 강제)

## 1단계: Sub-agent batch dispatch (reasoning)

### 배치 분할

```python
for unit in units:
    scenarios = knowledge_load(unit.scenario_knowledge_id)
    batches = chunk(scenarios, size=30)   # PDD A8 강제: ≤ 30
    for batch in batches:
        batch_id = generate_ulid()
        spawn_agent(unit, batch, batch_id, R)
```

### Sub-agent 호출 (Claude Code Agent tool)

각 batch 마다 1 sub-agent. 입력으로 받는 것:

- batch 의 시나리오들 (≤ 30)
- code paths (Unit 의 영향 범위)
- 라운드 번호 R
- batch_id (TSV 에 박힐 추적 ID)
- tier 라우팅 hint (qa-flow §2 #5)

Sub-agent 의 reasoning 절차 (qa-flow §6):
1. Given 상태 → 코드의 어느 state / props / store / route param 매핑
2. When 트리거 → 코드의 어느 함수 / 핸들러 / 이벤트
3. Then 결과 → 그 함수의 실제 반환 / 부수효과 / 화면 렌더 도달 가능성
4. 도달 + 정확 = `pass`. 도달 불가 / 잘못된 결과 / 누락 분기 = `defect`.
   시나리오 자체가 코드 의도와 어긋남 = `scenario_error`
5. evidence 필드에 reasoning 핵심 file:line 박기

### Tier 라우팅 (qa-flow §2 #5)

- **default**: Sonnet (시나리오 vs 코드 비교 추론, 80~90% case)
- **모호 case**: Opus escalation (scenario_error 후보 / 경계 불명확)
- **회귀 라운드 결함 root-cause**: Opus 우선
- 모든 escalation 은 `escalation_reason` 필드에 명시

### TSV evidence schema (강제)

각 batch 산출:

```
qa-U<unit-idx>-r<R>-batch-<batch_id>.tsv
```

행 schema (PDD T7 + T8 강제):
```
scenario_id<TAB>status<TAB>reasoning<TAB>evidence<TAB>tier_used<TAB>batch_id<TAB>escalation_reason
```

필드:
- `scenario_id` — `US-<DOMAIN>-<NNN>` 형식 강제 (regex)
- `status` — `pass | defect | scenario_error`
- `reasoning` — 코드 추론 본문 (Given→When→Then 트레이스)
- `evidence` — `<file>:<line>` (defect / scenario_error 필수, pass 선택)
- `tier_used` — `haiku | sonnet | opus`
- `batch_id` — 같은 batch 묶음
- `escalation_reason` — tier 상향 시만

evidence 부재 = X8 anti-pattern → 거부 + 재실행.

## 2단계: Bulk sync transcription (sync only)

### Python ThreadPoolExecutor 패턴 (9000-런 검증됨)

```python
from concurrent.futures import ThreadPoolExecutor
import csv
import subprocess

def parse_tsv(path):
    with open(path) as f:
        reader = csv.reader(f, delimiter='\t')
        return [row for row in reader]

def status_to_clawket(status):
    # 단순 매핑 — reasoning 결정 X
    return {
        'pass': 'done',
        'defect': 'blocked',
        'scenario_error': 'cancelled',
    }[status]

def sync_one(row, target_unit_id):
    scenario_id, status, reasoning, evidence, tier, batch_id, *rest = row
    subprocess.run([
        'clawket', 'task', 'create',
        '--unit', target_unit_id,
        '--scenario-id', scenario_id,
        '--evidence', evidence,
        '--batch-id', batch_id,
        '--type', 'review',
        '--body', f"{reasoning}\n\n[tier={tier}]",
        f"QA-{scenario_id}",
    ], check=True)
    # 그 다음 status 전환
    task_id = ...  # parse from create output
    subprocess.run([
        'clawket', 'task', 'update', task_id,
        '--status', status_to_clawket(status),
    ], check=True)

with ThreadPoolExecutor(max_workers=16) as ex:
    futures = [ex.submit(sync_one, row, target_unit_id) for row in all_rows]
    for f in futures:
        f.result()  # raise on error
```

### Sync 단계 불가침 (X9 anti-pattern 방지)

- ❌ sync 안에서 다시 sub-agent 호출 (reasoning 끼워넣기)
- ❌ status 매핑 결정을 코드 if/else 로 분기 (TSV 가 결정한 것을 옮길 뿐)
- ❌ TSV row 의 status 를 sync 가 변경 (transcription 만)
- ✅ 단순 status 문자열 매핑 (pass→done, defect→blocked, scenario_error→cancelled)
- ✅ DB 쓰기 실패 시 retry (transcription 자체는 idempotent)

## Batch attention 분산 검증

9000-런 회고: 87 시나리오/agent 배치는 attention dilution 위험.
30 이하가 reasoning 품질 보장 임계.

검증 휴리스틱:
- 한 batch 의 후반 시나리오 (배치 위치 ≥ 70%) 결과 신뢰도가 전반 (위치 < 30%)
  보다 낮으면 attention 분산 의심
- 의심 시: 같은 batch 의 후반 시나리오만 재 dispatch (`batch_id` 추적으로
  격리 가능)
- batch 크기 < 30 인데도 분산 의심 시: tier 상향 (Sonnet → Opus)

## 자기 점검 체크리스트

### Dispatch 시
- [ ] 1 agent / 1 unit / ≤ 30 시나리오 (PDD A8 강제)
- [ ] tier 라우팅 결정 (default Sonnet, 모호 시 Opus)
- [ ] batch_id 부여 (ULID)

### TSV 산출 시
- [ ] 7 필드 모두 채워짐 (scenario_id, status, reasoning, evidence, tier_used,
      batch_id, escalation_reason)
- [ ] defect / scenario_error row 의 evidence (file:line) 채워짐
- [ ] scenario_id regex 검증 통과 (`US-<DOMAIN>-<NNN>`)

### Bulk sync 시
- [ ] ThreadPoolExecutor max_workers ≤ 16
- [ ] sync 안에서 sub-agent 호출 0 건 (X9)
- [ ] status 매핑이 단순 dict lookup
- [ ] 실패 시 retry (transcription idempotent)

### 라운드 종료 시
- [ ] 모든 batch 의 TSV → DB 동기 완료
- [ ] task DB row 수 = TSV row 합계 (1:1 매핑)
- [ ] 각 task 의 `scenario_id`, `evidence`, `batch_id` 채워짐

## Anti-pattern 거부

- **X3** (PDD): scenario_id 부재 task → schema NOT NULL 거부
- **X7** (qa-flow): batch > 30 시나리오 → dispatch 거부
- **X8** (qa-flow): evidence 부재 (defect/scenario_error) → row 거부 + 재실행
- **X9** (qa-flow): bulk sync 안에서 reasoning 호출 → 즉시 중단

## 자율 Run 정책 (PDD O8)

- 2.x 런타임 / DB DDL / git 작업 절대 금지
- ALTER TABLE ADD COLUMN (non-destructive) 만 허용
- TSV knowledge 는 영속 (`type=evidence, title=Round R evidence — <도메인>`)
- knowledge 본체는 *현재 라운드* 만 (히스토리는 cancelled task comment + audit
  knowledge 에)

## 출력

- TSV evidence knowledge 들 (라운드 R, unit 별)
- Clawket task DB rows (1:1 매핑)
- batch_id 추적 메타 (attention dilution 의심 시 격리 가능)
- 다음 단계 (`/discover-loop` 의 3-way 수렴 판정으로 복귀)

## 9000-런 검증 데이터 (참고)

- R2: 458 defect / 29 scenario_error
- R3: 54 defect / 420 scenario_error (390 reclassify 발생) → R4 안정
- R4-R7: defect 17 → 1 → 0 → 0 (수렴)
- 1218 시나리오 / 14 unit / 7 라운드 — 87 시나리오/agent 배치는 attention 분산
  관찰됨, 30 이하로 보수 조정

## 관련 파일

- 룰 본체: `skills/qa-batch/RULE.md`
- 짝 skill: `/discover-loop` (호출 진입점), `/scenario-refine` (scenario_error
  처리), `/qa-fix` (defect 처리)
