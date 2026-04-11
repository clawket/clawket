[English](README.md)

# Lattice

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)용 LLM 네이티브 작업 관리 플러그인.

Lattice는 LLM 기반 개발을 위한 구조화된 상태 레이어로, Jira + Confluence를 대체합니다. 프로젝트 계획, 단계, 작업, 산출물, 실행 이력을 로컬 SQLite 데이터베이스와 경량 데몬을 통해 세션 간 영구 보존합니다.

## 아키텍처

```
Claude Code ──(훅)──→ latticed (Node.js 데몬)
           ──(CLI/Bash)─→ lattice (Rust 바이너리)
                              │
                              ▼
                     ~/.local/share/lattice/db.sqlite
```

- **lattice** — Rust CLI (~10ms 콜드 스타트). 모든 작업을 하나의 바이너리로.
- **latticed** — Node.js + Hono HTTP 데몬. 백그라운드에서 Unix 소켓 + TCP로 실행.
- **훅** — SessionStart 시 데몬 자동 시작 및 프로젝트 컨텍스트 주입.
- **스킬** — `/lattice` 스킬로 LLM에 명령어 레퍼런스 제공.

## 설치

```bash
claude plugins install Seungwoo321/lattice
```

플러그인의 Setup 훅이 첫 사용 시 CLI 바이너리와 데몬을 자동으로 설치합니다.

### 사전 요구사항

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 20+
- Rust 툴체인 (소스에서 CLI 빌드 시 필요, 또는 사전 빌드된 바이너리 사용)

## 엔티티 계층 구조

```
프로젝트 → 계획(Plan) → 단계(Phase) → 작업(Step)
                                        ├── 산출물(Artifact) — 문서, 결정, 와이어프레임
                                        ├── 실행(Run) — 에이전트/세션별 실행 기록
                                        └── depends_on — 작업 의존성
```

| 엔티티 | 용도 |
|--------|------|
| **Project** | 논리적 프로젝트 ID, 1개 이상의 작업 디렉토리에 매핑 |
| **Plan** | 상위 계획 (Claude Code 플랜 모드에서 가져오기) |
| **Phase** | 작업 그룹 (마일스톤), 승인 게이트 지원 |
| **Step** | 원자적 작업 단위 — "티켓" |
| **Artifact** | Step/Phase/Plan에 첨부된 산출물 (마크다운, YAML, JSON) |
| **Run** | 실행 기록 — 어떤 에이전트가 어떤 작업을, 언제 수행했는지 |
| **Question** | 의사결정 포인트 — LLM 또는 사람이 질문, 비동기로 답변 |

## 빠른 시작

```bash
# 데몬 상태 확인
lattice daemon status

# 프로젝트 대시보드 조회
lattice dashboard --cwd .

# 작업 목록 조회
lattice step list --phase-id PHASE-xxx

# 작업 상태 변경
lattice step update STEP-xxx --status in_progress

# 작업 검색
lattice step search "migration"

# 새 작업 생성
lattice step new "인증 버그 수정" --phase PHASE-xxx --body "설명"

# 실행 추적
lattice run start --step STEP-xxx --agent my-agent
lattice run finish RUN-xxx --result success --notes "완료"
```

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
