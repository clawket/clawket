# `clawket/.claude/rules/`

Clawket plugin shell sub-repo (`github.com/clawket/clawket`) 특화 가드레일. 글로벌 룰 (`~/.claude/rules/`) 이 잡지 못하는 plugin-shell-only invariant 만 담는다. 글로벌과 중복 금지.

본 sub-repo 는 cross-repo 좌표의 SSoT 보유자다 — `components.json` (컴포넌트 핀), `docs/COMPATIBILITY.md` (호환성 매트릭스), `docs/RELEASING.md` (릴리즈 order) 이 여기에 있고, 다른 sub-repo 의 CLAUDE.md 는 이 위치들을 가리킨다. 본 디렉터리의 룰 중 `components-json-cross-repo-lock-step.md` 는 그 좌표 정본의 동기화 invariant 를 강제한다.

## Index

| Rule | One-liner |
|---|---|
| `install-gate-idempotency.md` | `ensureInstalled` fast-path 4-step (manifest / version marker / skill integrity / daemon health) 의 lock-free 통과를 보장 — 매 세션 재다운로드 방지 |
| `hook-handler-error-safety.md` | 7 hook shim 의 unhandled throw 가 Claude Code 세션을 brick 하지 않도록 wrap pattern 통일 |
| `skill-file-integrity-on-install.md` | 6 PDD skill × 2 file (SKILL.md + RULE.md) 무결성을 fast-path 가 강제로 검사 — partial release 차단 |
| `components-json-cross-repo-lock-step.md` | 컴포넌트 핀 bump 시 GitHub Release + COMPATIBILITY.md + plugin major 의 4-step 동시 갱신 강제 |
| `xdg-path-separation-invariant-lm8.md` | 플러그인 코드 어디서도 사용자 데이터 (`~/.local/share/clawket/` 등) 에 write 금지 — plugin reinstall 시 데이터 손실 방지 (LM-8) |

## 적용 범위

이 룰들은 본 sub-repo cwd 에서의 모든 작업에 적용된다. 다른 sub-repo (`cli/`, `daemon/`, `web/`, `landing/`) 는 자체 `.claude/rules/` 를 보유하거나 보유 예정이며, 그 sub-repo 의 invariant 만 다룬다.

새 룰 추가 / 기존 룰 수정 시 `clawket/CLAUDE.md` 의 AI 가드레일 섹션과 일관성 유지. 변경 이력은 본 README 본문에 남기지 않고 git 커밋 메시지 / ADR 로 분리한다 (SNAPSHOT-ONLY).
