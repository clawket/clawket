[English](README.md)

<p align="center">
  <img src="logo.svg" width="80" alt="Lattice logo" />
</p>

<h1 align="center">Lattice</h1>

<p align="center"><a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>용 LLM 네이티브 작업 관리 플러그인</p>

Lattice는 LLM 기반 개발을 위한 구조화된 상태 레이어로, Jira + Confluence를 대체합니다. 프로젝트 계획, 단계, 작업, 산출물, 실행 이력을 로컬 SQLite 데이터베이스와 경량 데몬을 통해 세션 간 영구 보존합니다.

## 주요 기능

- **구조화된 작업 보드** — 프로젝트, 계획, 단계, 작업의 전체 CRUD
- **볼트 사이클** — 스프린트 형태의 이터레이션 관리 (AIDLC 볼트 사이클 지원)
- **볼트 자동 완료** — 볼트 내 모든 스텝 완료 시 자동 completed 전환
- **웹 대시보드** — 요약, 계획, 보드(칸반), 백로그, 타임라인, 위키 6개 뷰
- **에이전트 Swimlane 타임라인** — 에이전트별 수평 바 차트로 동시 작업 시각화
- **드래그 앤 드롭** — 칸반 DnD로 상태 변경, 백로그 DnD로 볼트 배정
- **인라인 편집** — Plans 뷰에서 Step 제목/상태 더블클릭 직접 편집
- **프로젝트 설정** — Summary 뷰에서 프로젝트명, 설명, 작업 디렉토리 편집
- **위키 파일 트리** — 폴더 기반 트리 내비게이션, heading 자동 추출 제목
- **로컬 RAG** — Artifact scope (rag/reference/archive), sqlite-vec 임베딩, 하이브리드 검색
- **Artifact 버전 관리** — content 수정 시 자동 스냅샷, 버전 이력 + 복원
- **벡터 검색** — FTS5 키워드 + sqlite-vec 시맨틱 하이브리드 검색
- **티켓 번호** — 내부 ULID와 함께 사람이 읽을 수 있는 ID (LAT-1, LAT-2)
- **CLI 단축 명령어** — `lattice s` (step), `lattice b` (bolt), `lattice d` (daemon) 등
- **자동 추론** — `step new` 시 현재 프로젝트에서 phase/bolt 자동 감지
- **훅 통합** — 모든 Claude Code 세션에 프로젝트 컨텍스트 자동 주입
- **스텝 등록 강제** — 활성 스텝 없이 작업 불가 (PreToolUse 훅)
- **자동 상태 동기화** — Stop 훅에서 Phase/Plan/Bolt 완료 상태 자동 전환
- **토큰 최적화** — done 스텝 숨김, ticket_number 사용 (-32% 토큰)
- **고정 포트** — 데몬 포트 19400 고정 (LATTICE_PORT로 변경 가능)
- **라이트/다크 테마** — 영구 저장되는 테마 전환

## 아키텍처

```
Claude Code ──(훅)──→ latticed (Node.js 데몬)
           ──(CLI/Bash)─→ lattice (Rust 바이너리)
                              │
                              ▼
                     ~/.local/share/lattice/db.sqlite

웹 대시보드 (React) ──→ latticed HTTP API
```

- **lattice** — Rust CLI (~10ms 콜드 스타트). 모든 작업을 하나의 바이너리로.
- **latticed** — Node.js + Hono HTTP 데몬. 백그라운드에서 Unix 소켓 + TCP로 실행.
- **훅** — SessionStart 시 데몬 자동 시작 및 프로젝트 컨텍스트 주입. PreToolUse로 스텝 등록 강제. PostToolUse로 파일 변경 기록. Stop 훅으로 실행 종료.
- **스킬** — `/lattice` 스킬로 LLM에 명령어 레퍼런스 제공.

## 설치

```bash
# 1. 마켓플레이스 추가
/plugin marketplace add Seungwoo321/lattice

# 2. 플러그인 설치
/plugin install lattice@Seungwoo321/lattice
```

또는 로컬 개발 시:

```bash
claude --plugin-dir /path/to/lattice
```

setup 스크립트가 첫 설치 시 XDG 디렉토리를 자동 생성합니다.

### 사전 요구사항

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 20+
- Rust 툴체인 (소스에서 CLI 빌드 시 필요, 또는 사전 빌드된 바이너리 사용)

## 엔티티 계층 구조

```
프로젝트 → 계획(Plan) → 단계(Phase) → 작업(Step)
                  │                     ├── 산출물(Artifact) — 문서, 결정, 와이어프레임
                  │                     ├── 실행(Run) — 에이전트/세션별 실행 기록
                  │                     ├── 코멘트(StepComment) — 토론
                  │                     ├── depends_on — 작업 의존성
                  │                     └── parent_step_id — 무제한 깊이 계층
                  │
                  └── 볼트(Bolt) — 스프린트/이터레이션 사이클
```

| 엔티티 | 용도 |
|--------|------|
| **Project** | 논리적 프로젝트 ID, 1개 이상의 작업 디렉토리에 매핑 |
| **Plan** | 상위 계획 (Claude Code 플랜 모드에서 가져오기) |
| **Phase** | 작업 그룹 (마일스톤), 승인 게이트 지원 |
| **Step** | 원자적 작업 단위 — 우선순위, 복잡도, 티켓 번호 포함 "티켓" |
| **Bolt** | 스프린트/이터레이션 사이클 — 작업을 시간 제한된 그룹으로 묶음 |
| **Artifact** | Step/Phase/Plan에 첨부된 산출물 (마크다운, YAML, JSON) + 버전 관리 |
| **Run** | 실행 기록 — 어떤 에이전트가 어떤 작업을, 언제 수행했는지 |
| **Question** | 의사결정 포인트 — LLM 또는 사람이 질문, 비동기로 답변 |
| **StepComment** | 작업 내 토론 스레드 |

## 훅

Lattice는 다음 Claude Code 훅을 설치합니다:

| 훅 | 트리거 | 용도 |
|----|--------|------|
| **SessionStart** | 세션 시작 | 데몬 시작, 대시보드 컨텍스트 + 규칙 주입 |
| **UserPromptSubmit** | 사용자 메시지마다 | 활성 스텝 컨텍스트 주입, 활성 스텝 없으면 경고 |
| **PreToolUse** | Agent/Edit/Write/Bash 전 | 활성 스텝 없으면 작업 차단 |
| **PostToolUse** | Edit/Write 후 | 파일 변경 사항을 활성 실행에 기록 |
| **Stop** | 세션 종료 | 활성 실행 종료 + Phase/Plan/Bolt 상태 자동 동기화 |

## 빠른 시작

```bash
# 데몬 상태 확인
lattice daemon status

# 프로젝트 대시보드 조회
lattice dashboard --cwd .

# 대시보드 필터
lattice dashboard --cwd . --show active   # 활성 스텝만
lattice dashboard --cwd . --show all      # 전체

# 작업 목록 조회
lattice step list --phase-id PHASE-xxx

# 작업 상태 변경
lattice step update STEP-xxx --status in_progress

# 작업 검색
lattice step search "migration"

# 새 작업 생성
lattice step new "인증 버그 수정" --assignee main --body "설명"
# --phase, --bolt 생략 시 현재 프로젝트에서 자동 추론

# 단축 명령어
lattice s list --phase-id PHASE-xxx    # s = step
lattice b list --project-id PROJ-xxx   # b = bolt
lattice d status                        # d = daemon

# 작업 본문 추가
lattice step append-body STEP-xxx --text "추가 메모"

# 실행 추적
lattice run start --step STEP-xxx --agent my-agent
lattice run finish RUN-xxx --result success --notes "완료"

# 볼트 (스프린트) 관리
lattice bolt list --project-id PROJ-xxx
lattice bolt new "Sprint 1" --project PROJ-xxx
lattice bolt update BOLT-xxx --status active
```

## 웹 대시보드

웹 대시보드는 6개 뷰를 제공합니다:

| 뷰 | 설명 |
|----|------|
| **요약** | 프로젝트 전체 현황 — 진행률, 활성 에이전트, 단계 상태 |
| **계획** | 트리 뷰 — 인라인 편집, 일괄 액션, 체크박스 선택 |
| **보드** | 칸반 보드 — 드래그 앤 드롭 상태 변경 |
| **백로그** | 볼트별 그룹화 — 드래그 앤 드롭 배정 |
| **타임라인** | 에이전트 Swimlane 뷰 (Run 바 차트) + 활동 스트림 탭 |
| **위키** | 파일 트리 (heading 자동 추출), Artifact CRUD, GFM 테이블 지원 |

데몬 실행 중 `http://localhost:19400`에서 접근할 수 있습니다.

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

## 설계 원칙

1. **이중 소비자 저장소** — 하나의 저장소, 두 개의 뷰. LLM은 CLI로, 사람은 웹 대시보드로 조회. LLM이 웹 DOM을 직접 조작하지 않음.
2. **구조화된 포맷만** — JSON/YAML/마크다운 프론트매터. 쓰기 경로에 LLM 요약 없음. sqlite-vec 벡터 검색 지원.
3. **상태 레이어** — 저장소 + API만 제공. 비즈니스 로직 없음. 하네스 로직은 Claude Code에 유지.
4. **Step 단위 격리** — 서브에이전트 위임 단위는 Step(세션 아님).
5. **캐시 우선** — Step body는 append-only. 가변 필드(status, assignee)는 꼬리에 배치하여 프롬프트 캐시 프리픽스 보존.
6. **자동 주입 없음** — 새 세션은 깨끗하게 시작. 과거 컨텍스트는 명시적 쿼리로만.

## 데이터 저장 경로 (XDG)

| 경로 | 용도 |
|------|------|
| `~/.local/share/lattice/` | SQLite 데이터베이스 |
| `~/.cache/lattice/` | 소켓, PID, 포트 파일 |
| `~/.config/lattice/` | 설정 |
| `~/.local/state/lattice/` | 로그 |

모든 경로는 `LATTICE_{DATA,CACHE,CONFIG,STATE}_DIR` 환경변수로 오버라이드 가능.

## 사용법

Lattice는 구조화된 워크플로우를 강제합니다. 프로젝트, 플랜, 스텝이 등록되어 있어야 작업을 시작할 수 있습니다. PreToolUse 훅이 활성 스텝 없이 모든 변경 작업(Edit, Write, Bash, Agent)을 차단합니다.

### 처음 시작하기

새 디렉토리에서 먼저 프로젝트를 등록해야 합니다:

```
사용자: "이 디렉토리를 새 프로젝트로 등록해줘"

→ Claude가 실행: lattice project new "my-project" --cwd "."
→ 웹 대시보드 사이드바에 프로젝트 표시
```

### 작업 계획

Lattice가 플랜의 source of truth입니다 — Claude의 Plan Mode 파일(`~/.claude/plans/`)이 아닙니다. 이것은 의도된 설계입니다: 플랜은 Lattice DB에 보관되며, 로컬 파일로 관리하지 않아 파일 오염이나 동기화 문제가 없습니다.

**일반 모드:**

```
사용자: "인증 리팩토링 계획 세워줘"

→ Claude가 코드베이스 분석 후 대화에서 플랜 제안
→ 사용자가 검토/승인
→ Claude가 CLI로 등록:
  lattice plan new --project PROJ-xxx "인증 리팩토링"
  lattice phase new --plan PLAN-xxx "Phase 1 — OAuth 설정"
  lattice bolt new --project PROJ-xxx "Sprint 1"
  lattice step new "OAuth 흐름 구현" --phase PHASE-xxx --bolt BOLT-xxx --assignee main
```

**플랜 모드 (`/plan`):**

```
사용자: /plan
사용자: "인증 리팩토링 계획 세워줘"

→ Claude가 대화 컨텍스트로 플랜 제안 (Write가 훅에 의해 차단됨)
→ 사용자가 ExitPlanMode로 승인
→ Claude가 승인된 내용을 래티스 CLI로 등록
```

### 새 작업 시작

```
사용자: "설정 페이지 로그인 버그 수정해줘"

→ Claude가 기존 plan/phase/bolt 하위에 스텝 등록
→ in_progress로 전환, 작업 수행, done 처리
  (PreToolUse 훅이 스텝 없이 작업하는 것을 차단)
```

### 진행 상황 확인

```
사용자: "지금 진행 상황 알려줘"

→ Claude가 대시보드 읽고 (세션 시작 시 1회 주입) 답변
→ 활성 스텝, 볼트 진척도, 블로킹 항목 표시
```

### 볼트(스프린트) 관리

```
사용자: "API 작업용 새 스프린트 시작해"

→ Claude가 볼트 생성, 스텝 배정, active 설정
→ 보드 뷰에서 스프린트 칸반 확인
```

### 웹 대시보드에서 확인

`http://localhost:19400`에서:
- **보드** — 현재 스프린트의 칸반 뷰
- **백로그** — 전체 볼트 + 드래그 앤 드롭 배정
- **타임라인** — 에이전트 Swimlane (누가 언제 뭘 했는지)
- **위키** — 프로젝트 문서 및 아티팩트

### 핵심 개념

| 개념 | 설명 |
|------|------|
| **Project** | Lattice에 등록된 작업 디렉토리 |
| **Plan** | 상위 의도 (로드맵). CLI로 생성, Plan Mode 파일 아님 |
| **Phase** | 플랜 내 에픽 단위 그룹 |
| **Bolt** | 스프린트 — 시간 제한된 이터레이션 사이클 |
| **Step** | 원자적 작업 단위. 작업 시작 전 반드시 존재해야 함 |

### 프로젝트 비활성화

데이터를 유지하면서 래티스 관리를 일시적으로 해제할 수 있습니다. 웹 대시보드에서 **Project Settings → Lattice Management** 토글을 끄면 됩니다.

비활성 시:
- 훅이 해당 디렉토리를 프로젝트 미등록 상태로 인식 — Claude가 제약 없이 동작
- 기존 데이터(플랜, 스텝, 실행 기록)는 모두 보존
- 언제든 다시 켜면 구조화된 워크플로우 재개

탐색이나 빠른 수정처럼 스텝 등록 없이 Claude를 자유롭게 사용하고 싶을 때 유용합니다.

### 자동 상태 전이

- **Phase/Plan 활성화** — 하위 스텝이 `in_progress`가 되면 자동 전환
- **Phase/Plan 완료** — 모든 스텝이 종료 상태(`done`, `cancelled`, `superseded`)면 자동 전환
- **Bolt** — 수동 관리 (`active` / `completed`)

### 프롬프트 팁

| 하고 싶은 것 | 이렇게 말하세요 |
|-------------|---------------|
| 프로젝트 등록 | "이 디렉토리를 새 프로젝트로 등록해줘" |
| 작업 계획 | "X 기능 플랜 세우고 래티스에 등록해줘" |
| 작업 생성 | "X에 대한 스텝 등록하고 작업 시작해" |
| 상태 확인 | "현재 볼트 진행 상황 보여줘" |
| 작업 리뷰 | "지난 스프린트에서 뭘 했어?" |
| 문서 검색 | "위키에서 인증 설계 검색해" |
| 작업 완료 | "현재 스텝 완료 처리해" |

## 개발

```bash
# Daemon
cd daemon && pnpm install

# Web dashboard
cd web && pnpm install && pnpm dev

# CLI
cd cli && cargo build
```

## 라이선스

MIT
