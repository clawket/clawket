# install-gate-idempotency

## Purpose
`ensureInstalled` 은 매 SessionStart 마다 호출된다. 이미 핀된 버전이 설치되어 있고 PDD skill 무결성이 OK 이면 lock 도 잡지 않고 즉시 반환해야 한다 — 그렇지 않으면 사용자는 매 세션마다 GitHub Releases 재다운로드를 본다.

## Prevents
- 두 번째 SessionStart 가 binary 를 다시 받음
- `withInstallLock` 이 매 세션마다 cache lock 을 잡았다 풀었다 → race / zombie lock 빈도 상승
- `.clawket-version` 마커가 silently 핀 외 값으로 남아 fast-path 가 영원히 miss
- 부분 설치 (예: tarball 이 `skills/` 누락) 가 "healthy" 로 보고됨

## Evidence
- `adapters/shared/claude-hooks.cjs:1067` — `ensureInstalled(pluginRoot)` 진입
- `adapters/shared/claude-hooks.cjs:1083-1094` — `cliOk && daemonOk && webOk && skillsOk` 가 모두 true 이면 lock 없이 `return true`
- `adapters/shared/claude-hooks.cjs:1097` — fast-path miss 시에만 `withInstallLock(() => runSetup())`
- `adapters/shared/claude-hooks.cjs:945` — `withInstallLock` 은 `cacheDir()` 의 `install.lock` 사용 (pluginRoot 아님)
- `tests/plugin-reinstall.e2e.test.cjs` — 다섯 시나리오 모두 fast-path / lock 경로의 invariant 검증

## Why not global
글로벌 `clawket-context-management.md` 는 hook 우회 금지만 다룬다. 글로벌 `mechanical-overrides.md §1 "STEP 0"` 도 idempotent install 의 4-step 계약 (manifest load → version marker check → skill integrity → daemon /health) 을 강제하지 않는다. 이 4-step 의 순서·축 어느 하나라도 빠뜨리면 install gate 가 부서지는 것은 본 sub-repo 특화 invariant 다.

## Enforcement gap
- 새 fast-path 분기 추가 시 마커 mismatch 시나리오 테스트가 강제되지 않는다
- `runSetup` 호출 후 daemon `/health` 검증 누락 (`adapters/shared/claude-hooks.cjs:1104-1117`) 을 catch 하는 test 없음
- `verifyPddSkills` 가 새 skill 추가 시 갱신되었는지 검사하는 lint 없음

## Rule body

### DO
- 새 install component 를 추가하면 (1) `loadComponentsManifest` 가 그 키를 읽고, (2) fast-path 의 `<x>Ok` 검사에 포함되고, (3) `runSetup` 의 `ensure<X>Binary` 단계에 포함되고, (4) post-install daemon /health 검증을 통과해야 한다 — 넷 모두를 한 번에 변경한다
- `ensureInstalled` 의 return 값을 honor 하라. `false` 면 context injection (`runSessionStart` 의 dashboard 호출) 을 skip 한다 (현재 `adapters/shared/claude-hooks.cjs:1621-1629`)
- `.clawket-version` 마커 형식·경로를 바꾸면 `bin/`, `daemon/bin/`, `web/` 세 위치를 동시에 갱신한다
- fast-path 분기 변경 시 `tests/plugin-reinstall.e2e.test.cjs` 의 5 시나리오를 모두 통과시킨다

### DON'T
- `ensureInstalled` 우회 install 진입점을 만들지 마라 — `scripts/setup.cjs` / `adapters/claude/setup.cjs` 도 같은 함수에 위임만 한다
- 새 진입점 (예: CI script, /command) 에서 `ensureCliBinary` / `ensureDaemonBinary` 를 직접 호출하지 마라 — 항상 `ensureInstalled` 또는 `runSetup` 을 거친다
- fast-path 의 `verifyPddSkills` 호출을 빼지 마라 — partial install 을 "healthy" 로 잘못 판정한다
- post-install `/health` ping 실패 시 daemon 마커 무효화 (`fs.unlinkSync(daemonMarker)`) 를 생략하지 마라 — 다음 세션이 영원히 broken binary 를 trust 한다
- `withInstallLock` 의 lock 파일 위치를 `cacheDir()` 외 (특히 pluginRoot 또는 사용자 데이터 경로) 로 옮기지 마라 — LM-8 경계 위반
