-- Lattice v8: Step relations with typed relationships
CREATE TABLE IF NOT EXISTS step_relations (
  id              TEXT PRIMARY KEY,
  source_step_id  TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  target_step_id  TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL,  -- 'depends_on', 'blocks', 'supersedes', 'relates_to', 'duplicates'
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_step_relations_source ON step_relations(source_step_id);
CREATE INDEX IF NOT EXISTS idx_step_relations_target ON step_relations(target_step_id);
CREATE INDEX IF NOT EXISTS idx_step_relations_type ON step_relations(relation_type);

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (8, strftime('%s','now') * 1000);
