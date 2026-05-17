# adapter-shim-delegation-pattern

## Purpose
`adapters/claude/*.cjs` 는 Claude Code hook event 별 진입점으로 **2-5 line thin shim** 이어야 한다. 비즈니스 로직은 전부 `adapters/shared/claude-hooks.cjs` 에 모이고, shim 은 그 export 된 함수를 호출만 한다. 이 분리가 (a) 테스트 가능성 (shared 함수 단위 테스트), (b) 미래 vendor adapter (e.g. Cursor, Codex) 와의 로직 공유, (c) hook crash 회복 (`hook-handler-error-safety.md`) 을 가능케 한다.

## Prevents
- shim 안에 분기 / 조건 / 상태 로직 → 테스트 불가능 (해당 entry point 가 hook subprocess 로만 호출됨)
- 같은 로직이 미래 vendor adapter (Cursor / Codex / 자체 SDK) 에 복사됨
- shared 함수의 unit test 가 shim 의 행동을 cover 한다고 착각하게 됨
- shim 길이가 점진적으로 늘어 hook-handler-error-safety 의 wrap pattern 이 모호해짐

## Evidence
- `adapters/claude/pre-tool-use.cjs:1-3` — 2 라인 shim (`require(...).runPreToolUse()`)
- `adapters/claude/post-tool-use.cjs:1-3`, `subagent-start.cjs:1-3`, `subagent-stop.cjs:1-3`, `user-prompt-submit.cjs:1-3`, `plan-sync.cjs:1-2`, `stop.cjs:1-2`, `setup.cjs:1-2`, `task-created.cjs:1-2`, `task-completed.cjs:1-2` — 모두 2 라인
- `adapters/claude/session-start.cjs:1-5` — 5 라인 (try/catch wrap 포함; 최대 허용)
- `adapters/shared/claude-hooks.cjs:2809-2840` — `module.exports` 가 모든 `runXxx` 함수와 `ensure<X>Binary` / `runSetup` 등을 노출
- `clawket/CLAUDE.md:167-169` — 2-line shim 룰 (AI 가드레일 정본)

## Why not global
글로벌 `mechanical-overrides.md §3 "SENIOR DEV OVERRIDE"` 는 architecture 결함 수정을 요구하지만, **hook subprocess 진입점의 thin-shim 분리** 는 plugin manifest (`hooks/hooks.json`) 의 라우팅 표면과 vendor adapter 확장점을 동시에 보호하는 sub-repo 특화 패턴이다.

## Enforcement gap
- 각 shim 의 라인 수 / AST 분기문 검사하는 lint 없음
- `require('../shared/claude-hooks.cjs').runXxx(...)` 패턴 외 호출을 deny 하는 검사 없음
- shared 함수의 unit test coverage 가 shim 도 cover 한다고 잘못 가정되기 쉬움

## Rule body

### DO
- 새 hook event 진입점을 추가하면 다음 형태로 작성:
  ```js
  #!/usr/bin/env node
  require('../shared/claude-hooks.cjs').runXxx();
  ```
  (또는 async + .catch wrap — `hook-handler-error-safety.md` 참조)
- 모든 로직 / 분기 / state 는 `adapters/shared/claude-hooks.cjs` 에 함수로 옮기고 `module.exports` 에 추가
- 새 vendor adapter (예: `adapters/cursor/`) 가 추가될 때 같은 shared 함수를 호출하도록 설계
- shared 함수의 unit test 를 `tests/*.test.cjs` 에 추가 — shim 호출이 아니라 shared 함수를 직접 import 해 검증

### DON'T
- shim 에 `if`, `try` 외 분기를 두지 마라 (try/catch wrap 1단만 허용; 나머지는 shared 안에서)
- shim 에서 `process.env` 를 읽어 동작을 바꾸지 마라 — env 분기는 shared 함수 안
- shim 에서 file system / network 호출을 하지 마라 — 모두 shared 함수
- shim 라인 수가 5 를 초과하면 그것은 shared 로 이동할 신호다 (current max: `session-start.cjs` 5 라인)
- shim 마다 다른 wrap pattern 을 쓰지 마라 — wrap 은 모두 동일한 `.catch((err) => { stderr; exit(0); })` 형태
- shared 함수를 export 하지 않은 채 shim 에서 internal 함수에 접근하지 마라 (`require` 의 캐시 부작용)
