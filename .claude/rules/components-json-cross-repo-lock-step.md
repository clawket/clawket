# components-json-cross-repo-lock-step

## Purpose
`components.json` 은 cross-repo 버전 핀의 정본 (`daemon` / `cli` / `web` 각각의 정확한 release tag). 핀을 bump 하는 행위는 본 sub-repo 단독 변경이 아니라 **세 sub-repo 의 GitHub Release + COMPATIBILITY.md 매트릭스 + RELEASING.md 의 release order 4-step 계약** 의 한 step 이다. 한 step 만 진행되면 사용자의 다음 SessionStart 가 존재하지 않는 binary 를 다운로드하려다 실패한다.

## Prevents
- 핀 bump → `ensureInstalled` 가 GitHub Releases 에서 404
- 핀이 매트릭스 (`docs/COMPATIBILITY.md`) 의 범위를 벗어났는데 plugin major bump 누락
- 한 컴포넌트만 새 major 로 핀되어 다른 컴포넌트와의 wire contract 깨짐
- `releaseing order` (daemon → cli → web → plugin) 위반 → 먼저 핀된 컴포넌트가 미배포 release 를 가리킴

## Evidence
- `components.json:1-6` — 정본. 키는 `daemon` / `cli` / `web` (각각의 정확한 release tag) + `desktop: null` sentinel. 핀 값은 릴리즈마다 갱신되므로 파일을 직접 참조한다 (여기에 값을 복제하지 않는다).
- `clawket/CLAUDE.md:93-104` — 핀 변경 4-step 체크리스트 (Release 존재 / 매트릭스 / major bump / order)
- `clawket/CLAUDE.md:164-166` — 동반 변경 강제 (매트릭스 + major 판단 + Release 확인)
- `docs/COMPATIBILITY.md:21-36` — 매트릭스 표 (plugin 버전 × daemon/cli/web 호환 범위)
- `docs/COMPATIBILITY.md:72-78` — release coordination (component bump → plugin compat PR → plugin 패치)
- `docs/RELEASING.md` — release order / tag 규칙 정본

## Why not global
글로벌 룰에는 multi-repo monorepo / lock-step versioning 개념이 없다. 글로벌 `product-quality-first.md §5 SNAPSHOT-ONLY` 는 문서의 단일 시점 진실을 다루지만, **3-component pinning + matrix + release order** 의 4-축 동시 갱신 invariant 는 본 sub-repo (cross-repo SSoT 보유자) 만의 책임이다.

## Enforcement gap
- `components.json` diff 시 `docs/COMPATIBILITY.md` 의 plugin 행이 갱신되었는지 검사하는 pre-commit 없음
- 핀된 tag 가 GitHub Releases 에 실존하는지 자동 검증 없음 (현재 install 시 fail)
- 매트릭스 (`docs/COMPATIBILITY.md`) 자체의 SemVer range vs 핀 일관성 검사는 없음 (매트릭스가 release.yml 의 row-generation step 에 의해 append-only 로 갱신되므로 정본 갱신 시점에만 정합).
- **`compat.json` 의 schema (키 whitelist + SemVer range 문법) 와 `components.json` 의 핀 일관성 (예: `cli >=0.2.0 <1.0.0` 범위에 `v1.0.0` 핀 금지) 은 `scripts/validate-compat.cjs` 가 release.yml 의 `Configure Git` 직후 step 에서 검사**. typo / 비-SemVer 값 / pin·range drift 모두 release 전 차단됨 (테스트: `tests/validate-compat.test.cjs` 20개).
- plugin major bump (`package.json#version` + `.claude-plugin/plugin.json#version`) 동반 누락을 막는 lint 없음

## Rule body

### DO
- `components.json` 변경 PR 은 **단독 PR** 로 한다 — 다른 변경과 섞지 않음
- PR 본문에 4-step 체크리스트를 포함:
  1. 대상 GitHub Release 존재 확인 (`gh release view --repo clawket/<cli|daemon|web> <tag>`)
  2. 매트릭스 (`docs/COMPATIBILITY.md`) 의 해당 plugin 행 갱신 — 범위 (`>=X.Y.Z <…`) 가 새 핀을 포함하는지
  3. 범위 이탈 시 plugin major bump (`package.json#version` + `.claude-plugin/plugin.json#version`)
  4. release order (daemon → cli → web → plugin) 준수 — 먼저 bump 되는 컴포넌트의 release 가 publish 완료여야 함
- 매트릭스의 새 plugin 행 추가 시 SemVer range 표기를 기존 행과 동일 포맷 (`>=X.0.0 <(X+1).0.0`) 유지
- 새 핀을 메인 브랜치에 머지하기 전 `npm run dev:fresh-install` 로 실제 다운로드 / 무결성 검증

### DON'T
- `components.json` 만 단독 수정하지 마라 — 매트릭스 미갱신은 후속 사용자의 SessionStart 가 호환성 정보 없이 진행되게 함
- 매트릭스 표의 과거 행 (예: `2.3.0` 행) 을 편집하지 마라 (snapshot-only) — 새 행을 추가만 한다
- `desktop` 핀을 `clawket/desktop` 첫 release publish 전에 non-null 로 바꾸지 마라 — `null` 은 install gate 가 no-op skip 하는 sentinel (`clawket/CLAUDE.md` 컴포넌트 핀 행 참조)
- release order 를 우회해 plugin 을 먼저 publish 하지 마라 — 다음 사용자의 ensureInstalled 가 component 404 로 실패
- plugin 의 `compat` 범위 (`compat.json`) 와 매트릭스 가 어긋난 채로 머지하지 마라 — 둘 다 정본 표면이므로 동시 갱신
