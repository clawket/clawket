# Changelog

## [3.0.0] — 2026-05-05

### Major: PDD v3.0 skill 승급 + plugin major bump

R1 promote cluster (45 fix) 의 skills 마이그레이션 작업 + R2 promote cluster
(32 fix) 의 STABLE 라벨 + manifest 메타 + hook X3/X7/X8/X9 enforcement
정합화. 임시 `~/.claude/skills/` 에 있던 5 PDD skill 을 plugin 정본
(`skills/`) 으로 승급하고, qa-fix skill 을 신규 생성. 룰 본체 (`~/.claude/rules/*.md`)
를 각 skill 의 `RULE.md` 로 이주.

### R2 promote 결과 (32 fix)

- 6 PDD RULE.md 헤더가 `EXPERIMENTAL → STABLE — Clawket plugin 정본` 으로 일괄
  전환 (PROMOTE-001/005/050).
- pdd/RULE.md, scenario-author/RULE.md, scenario-refine/RULE.md 에서 임시
  경로 (`~/.claude/skills/`, `~/.claude/rules/`) 참조 모두 제거 — plugin 자기
  완결 (PROMOTE-008/010).
- `plugin.json` 의 `skillsList` 가 `{name, path, description}` 객체 배열로
  재구조화 + `commands` 배열 신규 추가 (7 슬래시 명령 명시) — PROMOTE-012/015/016.
- `marketplace.json` 의 `skills` 가 `{name, description}` 객체 배열로 재구조화
  — PROMOTE-014.
- `/pdd-promote` 슬래시 명령 정의 + `skills/pdd/SKILL.md` 에 confirm-prompt
  흐름 명세 추가 — PROMOTE-040.
- Hook routing manifest 에 X3/X7/X8/X9 enforcement matrix 명시 (`hooks.json`
  description 본문 + `adapters/claude/README.md` 표) — PROMOTE-017/021/022/023/024/045.
  - X3 = `PreToolUse(Bash:clawket task) + PostToolUse(Edit/Write) + SubagentStart` →
    `checkX3ScenarioId`
  - X7 = `PreToolUse(Agent/TeamCreate/SendMessage) + SubagentStart` →
    `checkX7BatchSize`
  - X8 = `PreToolUse(Bash:task update) + SubagentStop` → `checkX8Evidence`
  - X9 = `PreToolUse(Bash + Agent dispatch) + SubagentStart` →
    `checkX9SyncReasoning`
  실제 enforcement 코드는 R1 에서 이미 `adapters/shared/claude-hooks.cjs`
  내부에 구현되어 있었으나 routing matrix 가 어디에도 문서화되지 않아 R2
  sub-agent grep 이 false-positive defect 다수 발생. R2 fix 는 **route 표
  명문화** 가 핵심.
- `appendHookLog` 가 `cacheDir() → hookLogDir()` 로 전환 (XDG-state preferred,
  cache-dir fallback). `CLAWKET_HOOK_LOG_DIR` env override 지원. cache 는
  evictable 이라 audit 트레일 의도와 충돌 — PROMOTE-029.
- `CLAWKET_BYPASS_HOOKS=1` 우회 사용 시 `appendHookLog` 로 audit 엔트리
  자동 emit (anti-pattern + uid + ci flag) — PROMOTE-030.
- `ensureInstalled` 가 6 PDD skill 의 SKILL.md/RULE.md 12 파일 무결성 검사
  추가 (`verifyPddSkills`). 누락 발견 시 stderr 경고 + 재설치 트리거 —
  PROMOTE-018.
- SessionStart 시 v2→v3 마이그레이션 stderr 노티스 (`checkV2ToV3Migration`)
  추가 — PROMOTE-043.
- `tests/skills-integrity.test.cjs` 신규 (7 회귀 테스트: 디렉토리 존재, 파일
  쌍, STABLE 라벨, cross-link 부재, plugin.json/marketplace.json 메타 검증) —
  PROMOTE-044.
- `qa-fix/RULE.md` 헤더에 `STABLE — Clawket plugin 정본` 라벨 명시 추가 (R1
  에서 라벨 자체가 부재) — PROMOTE-050 부수 fix.

#### 신규 skills (6개, `skills/<name>/{SKILL,RULE}.md`)

| skill | 설명 | RULE 출처 |
|---|---|---|
| `pdd` | PDD Plan + Unit 사전 예비 설계 (Phase 1) | `pdd.md` v3.0 전문 |
| `scenario-author` | atomic 시나리오 작성 (Phase 0) | `scenario-authoring.md` v3.0 전문 |
| `qa-batch` | Sub-agent batch dispatch + TSV bulk sync | `qa-flow.md` v3.0 전문 |
| `discover-loop` | 발견-수렴 루프 메인 엔진 (Round R) | `qa-flow.md` v3.0 전문 |
| `scenario-refine` | scenario_error 3-way 처리 | `scenario-authoring.md` v3.0 전문 |
| `qa-fix` | defect → fix task 등록 + 코드 수정 | `qa-flow.md` §3 #4 + PDD T1~T8 |

#### plugin.json

- `version`: `2.3.12` → `3.0.0`
- `skills`: 경로 `./adapters/claude/skills/` → `./skills/`
- `skillsList`: 7 skill 배열 추가 (`clawket` + 6 신규)
- `keywords`: `pdd`, `discover-loop` 추가

#### marketplace.json

- `version`: `2.3.12` → `3.0.0`
- `skills`: 7 skill 배열 추가

#### components.json (기존 확인 — 변경 없음)

- `daemon`, `cli`, `web` 모두 `v3.0.0` 핀 (R1 D7 pass 이미 반영됨)

### 변경 없는 항목 (PDD O8 준수)

- `~/.claude/skills/` 임시 skill 삭제 안 함 (사용자 명시 지시 시에만 — PDD O8
  자율 run 정책. 임시 skill 제거는 manual gate.) — PROMOTE-031~035 영향.
- `~/.claude/rules/*.md` 보존 (stub 전환은 사용자 결정 — 위와 같은 사유) —
  PROMOTE-036~038 영향.
- `~/.claude/plugins/clawket-*` 런타임 일절 미수정.
- git commit / push 없음 (명시적 지시 없음).
- Hook enforcement (X3/X7/X8/X9) 의 코드는 R1 부터 `adapters/shared/claude-hooks.cjs`
  안에 이미 구현되어 있다 (PROMOTE-021/022/023/024 의 R2 reasoning 은 2-line
  shim 만 grep 한 false-positive). R2 fix 는 routing matrix 의 명문화 +
  bypass audit + log 경로 정정 + skill integrity verify 추가에 한정.

### 마이그레이션 노트

임시 skill 과 plugin 정본 skill 의 관계:

| 임시 위치 | plugin 정본 |
|---|---|
| `~/.claude/skills/pdd-plan/SKILL.md` | `skills/pdd/SKILL.md` |
| `~/.claude/skills/scenario-author/SKILL.md` | `skills/scenario-author/SKILL.md` |
| `~/.claude/skills/qa-batch/SKILL.md` | `skills/qa-batch/SKILL.md` |
| `~/.claude/skills/discover-loop/SKILL.md` | `skills/discover-loop/SKILL.md` |
| `~/.claude/skills/scenario-refine/SKILL.md` | `skills/scenario-refine/SKILL.md` |
| (없음) | `skills/qa-fix/SKILL.md` (신규) |
| `~/.claude/rules/pdd.md` | `skills/pdd/RULE.md` |
| `~/.claude/rules/scenario-authoring.md` | `skills/scenario-author/RULE.md` + `skills/scenario-refine/RULE.md` |
| `~/.claude/rules/qa-flow.md` | `skills/qa-batch/RULE.md` + `skills/discover-loop/RULE.md` |
| `~/.claude/rules/qa-flow.md` §3 #4 | `skills/qa-fix/RULE.md` |

---

## [2.3.12] 이전

이전 버전 이력은 각 컴포넌트 레포의 CHANGELOG 참조:
- `cli/` — github.com/clawket/cli
- `daemon/` — github.com/clawket/daemon
- `web/` — github.com/clawket/web
