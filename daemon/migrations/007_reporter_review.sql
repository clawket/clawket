-- Lattice v7: Reporter field and review status for approval workflow
ALTER TABLE steps ADD COLUMN reporter TEXT;

-- Update status check to include review, cancelled, superseded, deferred
-- SQLite doesn't support ALTER CHECK, but the app layer handles validation

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (7, strftime('%s','now') * 1000);
