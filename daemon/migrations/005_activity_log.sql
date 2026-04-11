-- Lattice v5: Activity log for state change tracking
CREATE TABLE IF NOT EXISTS activity_log (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,  -- 'step', 'phase', 'bolt', 'plan'
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,  -- 'status_change', 'created', 'deleted', 'updated'
  field       TEXT,           -- which field changed (e.g. 'status', 'assignee')
  old_value   TEXT,
  new_value   TEXT,
  actor       TEXT,           -- agent name or 'human'
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_time ON activity_log(created_at DESC);

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (5, strftime('%s','now') * 1000);
