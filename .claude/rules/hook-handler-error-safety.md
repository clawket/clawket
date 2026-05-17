# hook-handler-error-safety

## Purpose
`adapters/claude/*.cjs` shim 에서 미잡힌 예외 (`throw`, unhandled promise rejection) 는 Claude Code 의 hook 핸들러를 비정상 종료시켜 세션을 brick 시킬 수 있다. 모든 shim 은 위임 호출을 try/catch 또는 `.catch()` 로 감싸고, stderr 로 actionable message 를 흘리되 exit code 는 0 (allow) 로 끝낸다.

## Prevents
- `runSessionStart` 내부 throw 가 hook 을 죽이고 세션이 시작 자체 안 됨
- `runPreToolUse` 의 unhandled exception 이 모든 tool call 을 deny 처럼 보이게 만듦
- async handler 의 unhandled rejection 이 Node 22+ 에서 process 종료
- 사용자가 "왜 안 되는지" 알 길 없이 hook 만 silent fail

## Evidence
- `adapters/claude/session-start.cjs:2-5` — 유일하게 `.catch()` + `process.exit(0)` wrap 보유
- `adapters/claude/pre-tool-use.cjs:1-3` — wrap 없는 직접 호출 (현재 `runPreToolUse` 가 동기 함수라 unhandled throw 위험)
- `adapters/claude/post-tool-use.cjs:1-3`, `adapters/claude/subagent-start.cjs:1-3`, `adapters/claude/subagent-stop.cjs:1-3`, `adapters/claude/user-prompt-submit.cjs:1-3`, `adapters/claude/plan-sync.cjs:1-2` — 모두 wrap 없음
- `adapters/shared/claude-hooks.cjs:1715` — `runPreToolUse` 본체 (긴 함수; 내부 throw 가 shim 까지 전파됨)

## Why not global
글로벌 `mechanical-overrides.md §4 "FORCED VERIFICATION"` 은 컴파일/lint 단계 검증이고, 글로벌 `clawket-context-management.md` 의 "hook 우회 금지" 는 의도된 deny 를 우회하지 말라는 룰이다. **의도하지 않은 hook crash 로 세션 brick** 은 본 sub-repo 의 7개 shim 만이 짊어진 책임 — 다른 sub-repo 에는 동일한 shim 표면이 없다.

## Enforcement gap
- shim 라인 수 (≤5) 만 보고 wrap 유무를 판정하는 lint 없음
- async shared 함수의 unhandled rejection 을 강제로 잡는 `process.on('unhandledRejection')` 핸들러 부재
- 새 shim 추가 시 wrap pattern 의 동일성 (`.catch((err) => { stderr.write; exit(0); })`) 검사 없음

## Rule body

### DO
- 새 shim 을 추가하면 `session-start.cjs` 의 5-line wrap pattern 을 그대로 복제한다:
  ```js
  #!/usr/bin/env node
  require('../shared/claude-hooks.cjs').runXxx().catch((err) => {
    process.stderr.write(`[clawket] Xxx failed: ${err.message}\n`);
    process.exit(0);
  });
  ```
- shared 함수가 동기여서 `.catch()` 를 못 거는 경우 try/catch + `process.exit(0)` 로 감싼다 — exit code 는 항상 0 (Claude Code 가 hook 실패 시 deny 로 해석하지 않도록)
- 의도된 deny 는 `console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', ... } }))` 로 명시한다 (현재 `runPreToolUse` 패턴)
- 새 shim 도입 시 `tests/` 에 brick 시나리오 회귀 테스트 추가

### DON'T
- shim 안에 비즈니스 로직을 넣지 마라 (별도 `adapter-shim-delegation-pattern.md` 참조) — 로직이 들어가는 순간 error path 가 늘어나 wrap 만으로 충분하지 않게 된다
- shared 함수에서 `process.exit(non-zero)` 를 호출하지 마라 — 의도된 deny 라도 exit code 가 아닌 `permissionDecision: 'deny'` JSON 으로 표현
- `unhandledRejection` 핸들러를 shim 마다 다르게 설치하지 마라 — pattern 통일이 brick 회귀 추적을 가능하게 한다
- 예외 메시지를 swallow 하지 마라 — `[clawket] <hook> failed: ${err.message}` 같은 actionable prefix 와 함께 stderr 로 흘린다
