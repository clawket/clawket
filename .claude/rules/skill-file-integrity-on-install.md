# skill-file-integrity-on-install

## Purpose
6 PDD skill 은 `skills/<name>/SKILL.md` + `skills/<name>/RULE.md` 두 파일 단위로 구성된다 (총 12 파일). tarball 부분 추출 / 부분 release / 누락된 commit 으로 한 파일이라도 빠지면 `/pdd-plan`, `/qa-batch`, `/discover-loop` 등 진입점이 runtime 에 resolve 실패한다. `ensureInstalled` 의 fast-path 가 이 12 파일 존재를 강제로 검사해 "healthy" 오판을 막아야 한다.

## Prevents
- 부분 install (skills/ 디렉터리 누락) 이 `cliOk && daemonOk && webOk` 만으로 healthy 처리됨
- `RULE.md` 가 `EXPERIMENTAL` 라벨로 되돌아간 release 가 통과
- `SKILL.md` 만 있고 `RULE.md` 가 빠진 부분 누락
- 새 skill 추가 시 `verifyPddSkills` 의 array 갱신 누락 → 새 skill 누락이 silent

## Evidence
- `adapters/shared/claude-hooks.cjs:1052-1065` — `verifyPddSkills(pluginRoot)` 본체 (warn-only, 누락 파일마다 stderr + `ok = false`)
- `adapters/shared/claude-hooks.cjs:1053` — hardcoded skill list: `['pdd', 'scenario-author', 'qa-batch', 'discover-loop', 'scenario-refine', 'qa-fix']`
- `adapters/shared/claude-hooks.cjs:1092-1094` — fast-path 가 `skillsOk` 를 `cliOk/daemonOk/webOk` 와 동급 AND 조건으로 사용
- `tests/skills-integrity.test.cjs:26-35` — 6 PDD skill × 2 file 존재 검증
- `tests/skills-integrity.test.cjs:37-51` — 모든 RULE.md 가 `상태: STABLE — Clawket plugin 정본` 라벨 보유 강제

## Why not global
글로벌 룰에는 sub-repo 별 skill manifest 개념이 없다. 글로벌 `mechanical-overrides.md §10 "NO SEMANTIC SEARCH"` 는 grep 누락 회피 룰이지만, **manifest array + 디렉터리 + plugin.json#skillsList 셋의 동기화** 는 본 sub-repo 특화 contract 다.

## Enforcement gap
- `verifyPddSkills` 가 `ok=false` 일 때 fast-path 에서 `skillsOk` 가 false 가 되어 재설치 트리거 — 하지만 `runSetup` 자체는 skills/ 를 재배포하지 않는다 (binary + web bundle 만)
- `plugin.json#skillsList` 와 `verifyPddSkills` 의 hardcoded array 가 분리되어 있어 한쪽만 변경 가능 (현재 manual sync)
- `marketplace.json` 의 skills 배열도 별개 — 3-source 동기화 필요

## Rule body

### DO
- 새 PDD skill 추가 시 **3 곳을 한 commit 에서** 갱신:
  1. `skills/<new>/SKILL.md` + `skills/<new>/RULE.md` 두 파일 생성 (RULE.md 는 `상태: STABLE — Clawket plugin 정본` 라벨 포함)
  2. `adapters/shared/claude-hooks.cjs:1053` 의 `skills` 배열에 이름 추가
  3. `.claude-plugin/plugin.json#skillsList` 및 `.claude-plugin/marketplace.json` 의 plugins[0].skills 배열에 entry 추가 (`name` + `description` + `path`)
- skill 명을 rename 시 `tests/skills-integrity.test.cjs:17` 의 `PDD_SKILLS` 배열도 동시 변경
- release tarball 빌드 후 `tests/skills-integrity.test.cjs` 가 통과하는지 확인 — partial extract 검출
- `RULE.md` 의 STABLE 라벨은 plugin 정본 표시 — 다른 sub-repo 가 같은 룰을 별도로 보유하지 못하게 한다

### DON'T
- `verifyPddSkills` 를 warn-only 로 다시 약화시키지 마라 (현재 fast-path 가 `skillsOk` 를 hard AND 로 사용) — 약화하면 partial install 이 다시 silent 통과
- `skills/` 디렉터리에 SKILL.md / RULE.md 외 파일을 두지 마라 — 무결성 검사는 두 파일만 본다, 다른 파일은 release tarball 에서 임의로 dropped 될 수 있음
- skill array 를 `Object.keys()` 같은 dynamic source 로 바꾸지 마라 — hardcoded array 는 의도된 fail-loud 장치
- `RULE.md` 본문에 `~/.claude/rules/` 또는 `~/.claude/skills/` cross-link 를 추가하지 마라 (`tests/skills-integrity.test.cjs:53-62` 가 deny)
