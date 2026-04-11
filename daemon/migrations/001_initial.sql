-- Lattice Phase 1 schema
-- Design principles:
--   P5 Cache-first: append-only body, volatile fields (status, assignee) at tail
--   P2 Structured: no LLM summaries, deterministic queries via FTS5
--   P4 Isolation: step_id is the pull unit for sub-agents

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Projects: logical name, 1:N cwds
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,           -- PROJ-<slug>
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_cwds (
  project_id   TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  PRIMARY KEY (project_id, cwd),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_cwds_cwd ON project_cwds(cwd);

-- Plans: Plan mode artifact, permanent
CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,          -- PLAN-<ulid>
  project_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  source        TEXT NOT NULL,             -- plan-mode | manual | aidlc | import
  source_path   TEXT,                      -- source plan file path if imported
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER,
  -- volatile fields at tail (P5)
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft|approved|executing|done|abandoned
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project_id);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);

-- Phases: approval unit, aidlc bolt = 1 Phase
CREATE TABLE IF NOT EXISTS phases (
  id            TEXT PRIMARY KEY,          -- PHASE-<ulid>
  plan_id       TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  goal          TEXT,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER,
  -- volatile
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|active|completed|blocked
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  UNIQUE (plan_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_phases_plan ON phases(plan_id);

-- Steps: execution unit, sub-agent delegation unit (pull target)
CREATE TABLE IF NOT EXISTS steps (
  id            TEXT PRIMARY KEY,          -- STEP-<ulid>
  phase_id      TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',  -- append-only work order
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER,
  -- volatile
  status        TEXT NOT NULL DEFAULT 'todo',  -- todo|in_progress|blocked|done|cancelled
  assignee      TEXT,                       -- main | sub-agent:<type> | human
  FOREIGN KEY (phase_id) REFERENCES phases(id) ON DELETE CASCADE,
  UNIQUE (phase_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_steps_phase ON steps(phase_id);
CREATE INDEX IF NOT EXISTS idx_steps_status ON steps(status);

-- Step dependencies (minimal graph)
CREATE TABLE IF NOT EXISTS step_depends_on (
  step_id       TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  PRIMARY KEY (step_id, depends_on_id),
  FOREIGN KEY (step_id) REFERENCES steps(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_id) REFERENCES steps(id) ON DELETE CASCADE,
  CHECK (step_id != depends_on_id)
);

-- Artifacts: decisions, designs, wireframes, ADRs, notes, links
-- Attached to step OR phase OR plan (at least one parent required)
CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,          -- ART-<ulid>
  step_id       TEXT,
  phase_id      TEXT,
  plan_id       TEXT,
  type          TEXT NOT NULL,             -- decision|design|wireframe|adr|note|link
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',  -- md|json|yaml (content_format below)
  content_format TEXT NOT NULL DEFAULT 'md',
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (step_id) REFERENCES steps(id) ON DELETE CASCADE,
  FOREIGN KEY (phase_id) REFERENCES phases(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  CHECK (
    (step_id IS NOT NULL) OR
    (phase_id IS NOT NULL) OR
    (plan_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_artifacts_step ON artifacts(step_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_phase ON artifacts(phase_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_plan ON artifacts(plan_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);

-- Runs: execution log, one per sub-agent/session invocation on a step
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,          -- RUN-<ulid>
  step_id       TEXT NOT NULL,
  session_id    TEXT,                      -- Claude Code hook session_id
  agent         TEXT NOT NULL,             -- main | claude-sub:<type> | skill:<name>
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  -- volatile
  result        TEXT,                      -- success|fail|aborted
  notes         TEXT,
  FOREIGN KEY (step_id) REFERENCES steps(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_step ON runs(step_id);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);

-- FTS5 virtual tables for deterministic search (no vectors, no LLM)
CREATE VIRTUAL TABLE IF NOT EXISTS steps_fts USING fts5(
  title, body,
  content='steps',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  title, content,
  content='artifacts',
  content_rowid='rowid',
  tokenize='unicode61'
);

-- FTS sync triggers
CREATE TRIGGER IF NOT EXISTS steps_ai AFTER INSERT ON steps BEGIN
  INSERT INTO steps_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS steps_ad AFTER DELETE ON steps BEGIN
  INSERT INTO steps_fts(steps_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS steps_au AFTER UPDATE ON steps BEGIN
  INSERT INTO steps_fts(steps_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
  INSERT INTO steps_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS artifacts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
  INSERT INTO artifacts_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

-- Schema version
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, strftime('%s','now') * 1000);
