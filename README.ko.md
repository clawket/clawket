[English](README.md)

<p align="center">
  <img src="assets/main.png" width="600" alt="Clawket — LLM 네이티브 작업 관리" />
</p>

<p align="center">Claude Code와 Codex CLI를 위한 LLM 네이티브 작업 관리 + 로컬 RAG 플러그인</p>

Clawket은 LLM 기반 개발을 위한 구조화된 상태 레이어로, Jira + Confluence를 대체합니다. 프로젝트 계획, 유닛, 태스크, 산출물, 실행 이력을 로컬 SQLite + 경량 데몬으로 세션 간 영구 보존합니다. 훅 기반 가드레일이 에이전트가 등록된 태스크 없이 작업하지 못하게 보장합니다 — 모든 작업은 추적되고, 모든 세션은 컨텍스트를 가집니다.

상태 레이어 위에 **로컬 RAG 스택**(sqlite-vec + 온디바이스 임베딩)과 **MCP stdio 서버**를 제공하므로, 외부 벡터 DB로 데이터를 내보내지 않고도 세션 간에 의미 기반 컨텍스트를 pull 할 수 있습니다.

## 왜 Clawket인가

구조화된 상태 레이어 없이 Claude Code 세션은 무상태(stateless)입니다:

- **컨텍스트 소실** — 세션이 바뀌면 처음부터 시작. "어디까지 했더라?"에 답이 없음.
- **작업 미추적** — 에이전트가 뭘 바꿨는지, 언제, 왜 바꿨는지 기록 없음.
- **플랜 노후화** — Plan Mode 파일이 `~/.claude/plans/`에 방치됨.
- **서브에이전트 단절** — 병렬 에이전트가 프로젝트 상태를 공유하지 못함.
- **과거 결정 소실** — 이전 설계 근거를 다음 세션이 떠올리지 못함.

Clawket은 영구 DB, 로컬 벡터 RAG, MCP pull 인터페이스, 런타임 어댑터, 웹 대시보드로 이 문제를 해결합니다 — 전부 로컬 실행.

## 주요 기능

- **구조화된 워크플로우** — Project → Plan (approve) → Unit → Task → Cycle (activate)
- **런타임 어댑터** — 공용 코어 + Claude Code 어댑터(주력) + Codex CLI 어댑터
- **라이프사이클 훅** — Claude 어댑터가 9개 이벤트 타입에 10개 훅 배치
- **웹 대시보드** — 요약, 계획, 보드(칸반), 백로그, 타임라인, 위키 6개 뷰
- **에이전트 Swimlane 타임라인** — 에이전트별 수평 바 차트로 동시 작업 시각화
- **드래그 앤 드롭** — 칸반 DnD로 상태 변경, 백로그 DnD로 사이클 배정
- **위키 + 로컬 RAG** — 파일 트리 내비게이션, Artifact 버전 관리, `scope=rag` artifact에 대한 FTS5 키워드 + sqlite-vec 의미 검색 하이브리드
- **자동 임베딩** — `scope=rag` artifact와 모든 task가 생성/수정 시 자동 임베딩. 데몬 startup에 누락 분 백필.
- **MCP RAG Pull** — 별도 stdio 서버(`clawket mcp`)가 5개 read-only tool을 Claude Code tool_use로 노출. `rag` scope만 반환.
- **훅 가드레일** — 활성 태스크 없이 작업 불가, 세션마다 프로젝트 컨텍스트 자동 주입
- **티켓 번호** — 내부 ULID와 함께 사람이 읽을 수 있는 ID (CK-1, CK-2) + 토큰 최적화
- **CLI + Web** — LLM(CLI)과 사람(웹 UI)이 동일한 상태를 관리

### 런타임 어댑터

| 런타임 | 통합 방식 | 지원 범위 |
|------|---------|---------|
| **Claude Code** | 플러그인 + 라이프사이클 훅 + 스킬 + MCP stdio | 전체 지원 |
| **Codex CLI** | 사용자 설치형 플러그인 훅 + 선택적 wrapper 런처 | 세션 컨텍스트 + PreToolUse 가드레일 |

### Claude 훅

| 훅 | 트리거 | 용도 |
|----|--------|------|
| **SessionStart** | 세션 시작(startup/clear/compact) | 데몬 시작 보장, 대시보드 컨텍스트 + 규칙 주입 |
| **UserPromptSubmit** | 사용자 메시지마다 | 활성 태스크 컨텍스트 주입, 활성 태스크 없으면 경고 |
| **PreToolUse** | Edit/Write/Bash/Agent/TeamCreate/SendMessage | 활성 태스크 없으면 변경 작업 차단 |
| **PostToolUse** | Edit/Write | 파일 변경을 활성 태스크에 기록 |
| **PostToolUse** | ExitPlanMode | Plan Mode 출력을 Clawket에 등록하도록 안내 |
| **SubagentStart** | 서브에이전트 시작 | 에이전트를 배정된 Clawket 태스크에 바인딩 |
| **SubagentStop** | 서브에이전트 종료 | 결과 요약 추가, 태스크 자동 완료 |
| **TaskCreated** | 팀 에이전트 태스크 생성 | 매칭되는 todo 태스크 자동 시작 (todo → in_progress) |
| **TaskCompleted** | 팀 에이전트 태스크 완료 | 매칭되는 in_progress 태스크 자동 완료 (→ done) |
| **Stop** | 세션 종료 | 해당 세션의 모든 활성 실행(Run) 종료 |

태스크가 `done`/`cancelled`로 전환되면, 데몬이 Unit/Plan/Cycle 완료를 자동 cascade 합니다.

### 기술 스택

| 레이어 | 기술 |
|---|---|
| CLI | Rust (~10ms 콜드 스타트), 단일 바이너리 |
| 데몬 | Node.js + Hono (Unix socket + TCP), better-sqlite3 |
| 저장소 | SQLite + sqlite-vec (vec0 virtual tables) |
| 임베딩 | `@xenova/transformers`의 `all-MiniLM-L6-v2` (384d, 온디바이스, 초기 1회 ~23MB 다운로드) |
| MCP | `@modelcontextprotocol/sdk` stdio 서버, 별도 프로세스 |
| 웹 | React 19 + Vite + Tailwind + dnd-kit |
| 어댑터 | Claude (plugin + hooks + skills + `.mcp.json`) / Codex (plugin + hooks + 선택 wrapper) |

## 설치

```bash
# 1. 마켓플레이스 추가
/plugin marketplace add Seungwoo321/clawket

# 2. 플러그인 설치
/plugin install clawket@Seungwoo321-clawket
```

첫 실행 시 setup 훅이 데몬 의존성(`pnpm install`)을 설치하고 임베딩 모델을 내려받습니다. MCP stdio 서버는 플러그인의 `.mcp.json`을 통해 자동 등록됩니다.

### Codex 설치

Codex 어댑터는 사용자 레벨 활성화가 필요합니다 — 레포 로컬 마켓플레이스만으로는 동작하지 않습니다.

```bash
clawket codex install       # ~/.codex/config.toml에 레포 로컬 마켓플레이스 등록
clawket codex uninstall     # 제거
clawket codex status        # 어댑터 상태 확인
```

이후 일반 `codex` 세션이 해당 설정을 통해 Clawket 플러그인을 자동 인식합니다.

### 사전 요구사항

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 20+
- Rust 툴체인은 **불필요** — 플러그인 setup 이 `clawket/cli` GitHub Releases 에서 사전 빌드된 `clawket` 바이너리를 자동 다운로드합니다. CLI 를 직접 개발할 때만 Rust 가 필요합니다.

## 로컬 RAG

Clawket의 RAG는 전적으로 데몬 내부에서 동작합니다. 외부로 아무것도 나가지 않습니다.

### 임베딩 대상

| 엔티티 | 트리거 | 임베딩 소스 텍스트 |
|---|---|---|
| Task | 생성/업데이트 시 매번, 누락 분은 데몬 startup에서 백필 | `title\nbody` |
| Artifact | 생성/업데이트 시, **단** `scope=rag` 이고 `content`가 있을 때만 | `title\ncontent` |

`reference`, `archive` artifact는 임베딩되지 않고 LLM에도 노출되지 않습니다.

### 벡터 저장

- `vec_tasks(task_id TEXT PRIMARY KEY, embedding float[384])`
- `vec_artifacts(artifact_id TEXT PRIMARY KEY, embedding float[384])`

둘 다 sqlite-vec `vec0` 가상 테이블입니다. `vec0`는 `INSERT OR REPLACE`를 지원하지 않으므로 업데이트는 `DELETE` + `INSERT` 패턴을 씁니다.

### 하이브리드 검색

데몬이 task와 artifact에 대해 키워드(FTS5), 의미(vec0 KNN), 하이브리드 검색 HTTP 엔드포인트를 제공합니다. 웹 위키, CLI `search` 서브커맨드, MCP 서버가 동일 엔드포인트를 재사용합니다.

## MCP 서버

Clawket은 MCP stdio 서버(`@clawket/mcp`)를 제공해 Claude Code가 필요할 때 컨텍스트를 **pull** 할 수 있게 합니다(SessionStart의 push 주입을 보완). 데몬이 아니라 **별도 프로세스**로 동작하며, `~/.cache/clawket/clawketd.port`에서 포트를 자동 탐지해 데몬 HTTP API를 호출합니다. 플러그인 `.mcp.json`이 `clawket mcp`를 stdio 명령으로 등록합니다.

| 도구 | 용도 |
|------|------|
| `clawket_search_artifacts` | `scope=rag` artifact에 대한 의미/키워드/하이브리드 검색 |
| `clawket_search_tasks` | task에 대한 의미/키워드/하이브리드 검색 |
| `clawket_find_similar_tasks` | 시드 task의 KNN 이웃, 코멘트에서 결정사항/이슈 추출 |
| `clawket_get_task_context` | task + 연관 artifact / 관계 / 코멘트 / 활동 이력 |
| `clawket_get_recent_decisions` | `type=decision, scope=rag` artifact를 최근 순으로 반환 |

수동 실행: `clawket mcp` (stdio). 개발 경로 override: `CLAWKET_MCP_PATH=/path/to/mcp/dist/index.js clawket mcp`.

**Scope 경계**: `archive`, `reference` artifact는 절대 반환되지 않습니다 — `rag` scope 지식만 LLM에 노출됩니다.

## 아키텍처

```
Claude Code
  ├─ 플러그인 훅 ────────────────┐
  └─ .mcp.json → stdio 자식 ──┐ │
                              │ │
                              ▼ ▼
                         @clawket/mcp (stdio 서버)
                              │ (HTTP, 포트 자동 탐지)
                              ▼
Codex 플러그인/wrapper 훅 ──▶ clawketd (Node.js + Hono)
                              │   ├─ Unix socket: ~/.cache/clawket/clawketd.sock
                              │   ├─ TCP: http://127.0.0.1:<port>
                              │   ├─ SSE 이벤트 버스 (/events)
                              │   ├─ POST/PATCH 시 auto-embed (scope=rag)
                              │   └─ Startup 백필 (누락된 vec_tasks)
                              ▼
                        SQLite + sqlite-vec
                      ~/.local/share/clawket/db.sqlite

웹 대시보드 (React 19) ─────▶ clawketd HTTP API + SSE
```

### 데이터 저장 경로 (XDG)

| 경로 | 용도 | 오버라이드 |
|---|---|---|
| `~/.local/share/clawket/` | SQLite DB | `CLAWKET_DATA_DIR` |
| `~/.cache/clawket/` | Unix socket, pid, port, 런타임 상태 | `CLAWKET_CACHE_DIR` |
| `~/.config/clawket/` | 설정 | `CLAWKET_CONFIG_DIR` |
| `~/.local/state/clawket/` | 로그 | `CLAWKET_STATE_DIR` |

## 디렉토리 구조

**v2.3.0** 부터 이 레포는 얇은 플러그인 쉘입니다. cli/daemon/mcp/web 소스는 `clawket`
GitHub 조직의 형제 레포로 이관되었고, setup 이 빌드 산출물을 받아옵니다.

```
clawket/
├── .claude-plugin/          # Claude 플러그인 매니페스트 + 마켓플레이스 메타
├── .mcp.json                # Claude Code가 읽는 MCP stdio 서버 등록 파일
├── hooks/hooks.json         # Claude 훅 라우팅 매니페스트
├── skills/clawket/          # /clawket 스킬 (SKILL.md)
├── prompts/                 # 공용 + 런타임별 프롬프트 조각
├── adapters/
│   ├── shared/              # 공용 런타임 헬퍼 + setup 다운로더
│   └── claude/              # Claude 어댑터 엔트리포인트 (훅 .cjs 핸들러)
├── scripts/                 # Claude 훅 호환 shim
├── docs/                    # COMPATIBILITY.md + RELEASING.md + HOOK_ENFORCEMENT.md
├── assets/                  # 로고, 마스코트, 브랜딩
├── screenshots/             # 대시보드 스크린샷
└── bin/                     # (setup 이 생성) 다운로드한 clawket CLI 바이너리
```

### 분리 레포

| 레포 | 내용 | 소비 방식 |
|---|---|---|
| [`clawket/cli`](https://github.com/clawket/cli) | Rust CLI 소스 | GitHub Releases 바이너리 |
| [`clawket/daemon`](https://github.com/clawket/daemon) | Node 데몬 (+ Rust scaffold) | `@clawket/daemon` npm |
| [`clawket/mcp`](https://github.com/clawket/mcp) | MCP stdio 서버 | `@clawket/mcp` npm |
| [`clawket/web`](https://github.com/clawket/web) | React 대시보드 | npm (빌드 산출물) |
| [`clawket/landing`](https://github.com/clawket/landing) | 공개 랜딩 페이지 | Cloudflare Pages |

버전 호환 범위는 `docs/COMPATIBILITY.md` 참조.

## 웹 대시보드

데몬 실행 중 `http://localhost:19400`에서 접근할 수 있습니다. 6개 뷰, SSE 실시간 반영.

| 뷰 | 설명 |
|----|------|
| **요약** | 프로젝트 진행률, 활성 에이전트, 유닛 상태 |
| **계획** | 트리 뷰 — 인라인 편집, 일괄 액션, 체크박스 선택 |
| **보드** | 칸반 보드 — 드래그 앤 드롭 상태 변경 |
| **백로그** | 사이클별 그룹화 — 드래그 앤 드롭 배정 |
| **타임라인** | 에이전트 Swimlane (Run 바 차트) + 활동 스트림 탭 |
| **위키** | 파일 트리, Artifact CRUD + 버전 이력, FTS5 + 의미 검색, GFM 테이블 |

### 스크린샷

| 요약 | 계획 |
|------|------|
| ![Summary](screenshots/01-summary.png) | ![Plans](screenshots/02-plans.png) |

| 보드 (칸반) | 백로그 |
|-------------|--------|
| ![Board](screenshots/03-board.png) | ![Backlog](screenshots/04-backlog.png) |

| 타임라인 | 위키 |
|----------|------|
| ![Timeline](screenshots/05-timeline.png) | ![Wiki](screenshots/06-wiki.png) |

## 사용법

Clawket은 구조화된 워크플로우를 강제합니다. 프로젝트 + 활성 플랜 + 활성 태스크가 모두 존재해야 에이전트가 변경 작업을 시작할 수 있습니다. PreToolUse 훅이 활성 태스크 없이 Edit/Write/Bash/Agent/TeamCreate/SendMessage 호출을 차단합니다.

### 런타임 명령

```bash
clawket runtime list
clawket runtime doctor claude
clawket runtime doctor codex
clawket codex install
clawket codex uninstall
clawket codex status
clawket codex           # 선택적 wrapper 기반 Codex 세션 런처
clawket codex stop
```

### 처음 시작하기

새 디렉토리에서 먼저 프로젝트를 등록해야 합니다:

```
사용자: "이 디렉토리를 새 프로젝트로 등록해줘"

→ 에이전트 실행: clawket project create "my-project" --cwd "."
→ 웹 대시보드 사이드바에 프로젝트 표시
```

### 작업 계획

Clawket이 플랜의 source of truth입니다 — Claude의 Plan Mode 파일(`~/.claude/plans/`)이 아닙니다. 로컬 파일로 관리하지 않아 파일 오염·동기화 문제가 없습니다.

**일반 모드:**

```
사용자: "인증 리팩토링 계획 세워줘"

→ 에이전트가 코드베이스 분석 후 대화에서 플랜 제안
→ 사용자 검토/승인
→ 에이전트가 CLI로 등록:
  clawket plan create --project PROJ-xxx "인증 리팩토링"
  clawket plan approve PLAN-xxx
  clawket unit create --plan PLAN-xxx "Unit 1 — OAuth 설정"
  clawket task create "OAuth 흐름 구현"
  clawket cycle create --project PROJ-xxx "Sprint 1"
  clawket cycle activate CYC-xxx
  clawket task update TASK-xxx --cycle CYC-xxx
```

**플랜 모드 (`/plan`):**

```
사용자: /plan
사용자: "인증 리팩토링 계획 세워줘"

→ 에이전트가 대화 컨텍스트로 플랜 제안 (Write는 훅에 의해 차단됨)
→ 사용자가 ExitPlanMode로 승인
→ 에이전트가 승인된 내용을 CLI로 등록
```

### 새 작업 시작

```
사용자: "설정 페이지 로그인 버그 수정해줘"

→ 에이전트가 기존 plan/unit/cycle 하위에 태스크 등록
→ in_progress → done 처리
  (PreToolUse 훅이 태스크 없이 작업하는 것을 차단)
```

### 과거 컨텍스트 pull (MCP)

```
사용자: "과거에 인증 재시도 정책에 대한 결정 있었어?"

→ 에이전트가 clawket_search_artifacts / clawket_get_recent_decisions 호출
→ scope=rag artifact만 의미 유사도로 반환
```

### 웹 대시보드에서 리뷰

`http://localhost:19400` 에서 보드(현재 스프린트), 백로그, 타임라인(에이전트 swimlane), 위키(문서 + artifact)를 확인할 수 있습니다.

### 핵심 개념

| 개념 | 설명 |
|------|------|
| **Project** | Clawket에 등록된 작업 디렉토리 |
| **Plan** | 상위 의도 (로드맵). approve 후에만 task를 시작할 수 있음 |
| **Unit** | 플랜 내 순수 그룹핑 엔티티 (상태 없음) |
| **Task** | 원자적 작업 단위. 사이클 없이 생성 가능 (백로그로 이동) |
| **Cycle** | 스프린트 — 시간 제한 이터레이션. 활성 사이클에 배정돼야 시작 가능 |
| **Artifact** | 버전 관리되는 첨부 문서. `scope` ∈ {`rag`, `reference`, `archive`}. `rag`만 임베딩되고 LLM에 노출됨 |
| **Backlog** | 사이클 미배정 태스크. 드래그로 사이클에 배정 |

### 상태 관리

- **Plan**: `draft` → `active`(approve로 의도적 활성화) → `completed`(의도적 종료)
- **Unit**: 상태 없음 — 순수 그룹
- **Cycle**: `planning` → `active`(의도적 시작) → `completed`(의도적 종료). 재시작 불가.
- **Task**: `todo` → `in_progress` → `done`/`cancelled`. 시작하려면 활성 플랜 + 활성 사이클 필요. `blocked`도 유효.

### 프로젝트 비활성화

웹 대시보드에서 **Project Settings → Clawket Management** 토글을 끄면, 훅이 해당 디렉토리를 미등록 상태로 인식합니다. 기존 데이터는 보존되며, 언제든 다시 켜서 구조화된 워크플로우를 재개할 수 있습니다.

### 프롬프트 팁

| 하고 싶은 것 | 이렇게 말하세요 |
|-------------|---------------|
| 프로젝트 등록 | "이 디렉토리를 새 프로젝트로 등록해줘" |
| 작업 계획 | "X 기능 플랜 세우고 클라켓에 등록해줘" |
| 작업 생성 | "X에 대한 태스크 등록하고 작업 시작해" |
| 상태 확인 | "현재 사이클 진행 상황 보여줘" |
| 작업 리뷰 | "지난 스프린트에서 뭘 했어?" |
| 과거 결정 검색 | "위키에서 인증 설계 결정 찾아줘" |
| 작업 완료 | "현재 태스크 완료 처리해" |

## 개발

```bash
# 데몬
cd daemon && pnpm install && node src/index.js

# MCP (별도 패키지)
cd mcp && pnpm install && pnpm build

# 웹 대시보드
cd web && pnpm install && pnpm dev

# CLI
cd cli && cargo build --release
```

## 라이선스

MIT
