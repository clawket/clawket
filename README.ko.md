[English](README.md)

# Lattice

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)용 LLM 네이티브 작업 관리 플러그인.

Lattice는 LLM 기반 개발을 위한 구조화된 상태 레이어로, Jira + Confluence를 대체합니다. 프로젝트 계획, 단계, 작업, 산출물, 실행 이력을 로컬 SQLite 데이터베이스와 경량 데몬을 통해 세션 간 영구 보존합니다.

## 주요 기능

- **구조화된 작업 보드** — 프로젝트, 계획, 단계, 작업의 전체 CRUD
- **볼트 사이클** — 스프린트 형태의 이터레이션 관리 (AIDLC 볼트 사이클 지원)
- **웹 대시보드** — 요약, 계획, 보드(칸반), 백로그, 타임라인, 위키 6개 뷰
- **드래그 앤 드롭** — 칸반 DnD로 상태 변경, 백로그 DnD로 볼트 배정
- **Artifact 위키** — 마크다운/JSON/YAML 문서 관리 및 버전 이력
- **티켓 번호** — 내부 ULID와 함께 사람이 읽을 수 있는 ID (LAT-1, LAT-2)
- **훅 통합** — 모든 Claude Code 세션에 프로젝트 컨텍스트 자동 주입
- **스텝 등록 강제** — 활성 스텝 없이 작업 불가 (PreToolUse 훅)
- **실행 추적** — 에이전트/세션별 자동 실행 기록
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
claude plugin install Seungwoo321/lattice
```

플러그인의 setup 스크립트가 첫 설치 시 CLI 바이너리와 데몬을 자동으로 설정합니다.

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
| **Stop** | 세션 종료 | 활성 실행 종료 처리 |

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
lattice step new "인증 버그 수정" --phase PHASE-xxx --assignee main --body "설명"

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
| **타임라인** | 시간순/에이전트별/단계별 활동 이력 + 간트 바 |
| **위키** | Artifact 브라우저 — 마크다운/JSON/YAML 렌더링 및 버전 이력 |

데몬 실행 중 `http://localhost:<port>`에서 접근할 수 있습니다.

## 설계 원칙

1. **이중 소비자 저장소** — 하나의 저장소, 두 개의 뷰. LLM은 CLI로, 사람은 웹 대시보드로 조회. LLM이 웹 DOM을 직접 조작하지 않음.
2. **구조화된 포맷만** — JSON/YAML/마크다운 프론트매터. 쓰기 경로에 LLM 요약 없음. 벡터 DB 없음.
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

## 개발

소스 코드는 별도의 비공개 저장소([lattice-dev](https://github.com/Seungwoo321/lattice-dev))에 있습니다.

## 라이선스

MIT
