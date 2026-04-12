-- Lattice v10: Step type field for work classification
ALTER TABLE steps ADD COLUMN type TEXT DEFAULT 'task';
-- Valid types: task, bug, feature, enhancement, refactor, docs, test, chore

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (10, strftime('%s','now') * 1000);
