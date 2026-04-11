-- Lattice v3: project keys, ticket numbers, step hierarchy, comments, artifact versions
-- All ALTER TABLE columns are NULL-able or have DEFAULTs for backward compatibility.

-- 1. projects.key: short uppercase project identifier (e.g. LAT, AF, WW)
ALTER TABLE projects ADD COLUMN key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_key ON projects(key) WHERE key IS NOT NULL;

-- 2. steps.ticket_number: human-readable sequential ID (e.g. LAT-1, LAT-2)
ALTER TABLE steps ADD COLUMN ticket_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_ticket_number ON steps(ticket_number) WHERE ticket_number IS NOT NULL;

-- 3. steps.parent_step_id: recursive step hierarchy
ALTER TABLE steps ADD COLUMN parent_step_id TEXT REFERENCES steps(id);

-- 4. steps.priority
ALTER TABLE steps ADD COLUMN priority TEXT DEFAULT 'medium';

-- 5. steps.complexity and estimated_edits
ALTER TABLE steps ADD COLUMN complexity TEXT;
ALTER TABLE steps ADD COLUMN estimated_edits INTEGER;

-- 7. step_comments table
CREATE TABLE IF NOT EXISTS step_comments (
  id         TEXT PRIMARY KEY,
  step_id    TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_step_comments_step ON step_comments(step_id);

-- 8. artifacts.parent_id: artifact hierarchy
ALTER TABLE artifacts ADD COLUMN parent_id TEXT REFERENCES artifacts(id);

-- 9. artifact_versions table
CREATE TABLE IF NOT EXISTS artifact_versions (
  id             TEXT PRIMARY KEY,
  artifact_id    TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  content        TEXT,
  content_format TEXT,
  created_at     INTEGER,
  created_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifact_id);

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (3, strftime('%s','now') * 1000);
