-- Lattice v4: Bolt entity (Sprint/AIDLC Bolt cycle)
-- Bolt = time-boxed execution unit (Sprint equivalent)
-- Phase = logical grouping (domain/feature)
-- A Step belongs to a Phase AND optionally to a Bolt.
-- Backlog = steps where bolt_id IS NULL.

-- 1. bolts table
CREATE TABLE IF NOT EXISTS bolts (
  id            TEXT PRIMARY KEY,           -- BOLT-<ulid>
  project_id    TEXT NOT NULL,
  title         TEXT NOT NULL,              -- "Bolt #3 — Design System"
  goal          TEXT,                       -- sprint goal
  idx           INTEGER NOT NULL DEFAULT 0, -- ordering within project
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  -- volatile
  status        TEXT NOT NULL DEFAULT 'planning', -- planning|active|review|completed
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bolts_project ON bolts(project_id);
CREATE INDEX IF NOT EXISTS idx_bolts_status ON bolts(status);

-- 2. steps.bolt_id: optional assignment to a bolt
ALTER TABLE steps ADD COLUMN bolt_id TEXT REFERENCES bolts(id);
CREATE INDEX IF NOT EXISTS idx_steps_bolt ON steps(bolt_id);

-- 3. Schema version
INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (4, strftime('%s','now') * 1000);
