-- Lattice v6: Labels/tags for step classification
CREATE TABLE IF NOT EXISTS step_labels (
  step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  label   TEXT NOT NULL,
  PRIMARY KEY (step_id, label)
);

CREATE INDEX IF NOT EXISTS idx_step_labels_label ON step_labels(label);

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (6, strftime('%s','now') * 1000);
