# xdg-path-separation-invariant-lm8

## Purpose
플러그인 코드 (이 sub-repo 의 어떤 파일도) 는 **사용자 데이터 경로** (`~/.local/share/clawket/`, `~/.cache/clawket/`, `~/.config/clawket/`, `~/.local/state/clawket/`) 에 직접 write 하지 않는다. 플러그인이 다루는 file system 은 오직 `pluginRoot` (`~/.claude/plugins/clawket-*/`) 뿐이다. 사용자 상태는 daemon 만 소유하며, write 가 필요하면 daemon HTTP/MCP 를 경유한다. 이 경계는 plugin reinstall 시 사용자 데이터 손실을 막는 핵심 invariant (LM-8).

## Prevents
- plugin reinstall (`/plugin install`) 이 `~/.claude/plugins/clawket-*` 를 지울 때 사용자 데이터가 함께 삭제됨 (post-incident 회귀)
- helper 함수가 무심코 `~/.local/share/clawket/` 에 fixture / cache 를 write
- 새 hook 핸들러가 audit log 를 사용자 데이터 경로에 직접 작성 (현재 `hook.log` 는 XDG state 사용 — 우회 위험)
- 사용자가 `~/.claude/plugins/data/clawket-*` 같은 잘못된 경로에 데이터를 두고 안전하다고 착각

## Evidence
- `clawket/CLAUDE.md:66-92` — LM-8 invariant 본문 + 두 단계 강제 (Runtime guard / Doctor 진단)
- `clawket/CLAUDE.md:157-159` — AI 가드레일: 플러그인 코드 어디서도 XDG 사용자 데이터에 write 금지
- `adapters/shared/claude-hooks.cjs:945-1003` — `withInstallLock` 이 `cacheDir()` 의 `install.lock` 만 사용 (XDG cache; 데이터/설정/상태 아님)
- `adapters/shared/claude-hooks.cjs:1146-1158` — `appendHookLog` 가 XDG state (`~/.local/state/clawket/hook.log`) 를 의도적으로 선택한 이유 (audit trail = state, not cache)
- `adapters/shared/claude-hooks.cjs:2761-2790` — `runSetup` 이 `pluginRoot` 아래 `bin/`, `daemon/bin/`, `web/dist/` 만 write
- `tests/path-separation.e2e.test.cjs:34-69` — `clawket doctor` exit 1 on overlap + `clawketd` 기동 거부 검증
- `tests/plugin-reinstall.e2e.test.cjs` Scenario 2-3 — plugin tree wipe / cache cleanup 후 사용자 DB 보존 검증

## Why not global
글로벌 `clawket-context-management.md` 의 "활성 태스크 없이 변경 금지" 는 hook 우회 룰이고, 글로벌 `product-quality-first.md §1 "OUT-OF-SCOPE INTOLERANCE"` 도 fs 쓰기 경계를 잡지 않는다. **plugin reinstall 가 destroy 가능한 경로 vs 보존 경로의 binary 분리** 는 본 sub-repo (install gate 보유자) 만의 책임. daemon sub-repo 는 runtime guard 측을, 본 sub-repo 는 write 행위 측을 책임진다.

## Enforcement gap
- 새 helper 가 `path.join(homedir(), '.local', 'share', 'clawket')` 같은 패턴을 도입하는 것을 static 으로 막는 lint 없음
- `fs.writeFileSync` / `fs.appendFileSync` / `fs.createWriteStream` call 의 target path 가 `pluginRoot` 하위인지 검사하는 ESLint rule 없음
- runtime guard 는 daemon side (`paths::ensure_no_plugin_overlap`) — plugin shim 의 write 자체는 거기서 catch 되지 않음

## Rule body

### DO
- 플러그인이 write 가 필요할 때 대상은 항상 `pluginRoot` 하위 (`bin/`, `daemon/bin/`, `web/`)
- audit / log / state 가 필요하면 `appendHookLog` 처럼 XDG state (`stateDir()`) 사용 — 단 데이터/설정 경로는 데몬 소유
- install lock 같은 단명 file 은 `cacheDir()` 만 사용 (`withInstallLock` 패턴)
- 사용자 데이터 mutation 이 필요하면 daemon HTTP (`/tasks`, `/plans`, ...) 또는 MCP tool 을 경유 — 직접 SQLite 접근 금지
- 새 path helper 추가 시 `clawket/CLAUDE.md:66-92` 의 표 (영역 / 용도 / 재설치 시 운명) 를 동시 갱신
- 변경 후 `tests/path-separation.e2e.test.cjs` + `tests/plugin-reinstall.e2e.test.cjs` 통과 확인

### DON'T
- `~/.local/share/clawket/`, `~/.cache/clawket/`, `~/.config/clawket/`, `~/.local/state/clawket/` 에 직접 write 하지 마라 (state dir 는 `appendHookLog` 단일 통로만 예외)
- 사용자 데이터를 `~/.claude/plugins/clawket-*/data/` 같은 plugin tree 안으로 옮기지 마라 — `clawket doctor` 가 exit 1 로 거부 (`tests/path-separation.e2e.test.cjs:34-43`)
- `CLAWKET_ALLOW_PLUGIN_OVERLAP=1` 를 install / setup script 에서 set 하지 마라 — 이 env-var 는 사용자가 명시적으로 위험 인지한 escape valve 전용
- `homedir()` 로 path 를 직접 조립하지 마라 — `dataDir()`, `cacheDir()`, `configDir()`, `stateDir()` 헬퍼 경유 (XDG override 도 일관 적용)
- 새 hook 이 사용자 데이터에 write 가 필요한 시나리오를 발견하면 daemon API extension 으로 PR 하라 — plugin 측의 직접 write 우회는 invariant 위반
