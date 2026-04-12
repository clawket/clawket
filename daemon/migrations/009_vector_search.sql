-- Lattice v9: Vector search tables (sqlite-vec)
-- These are virtual tables created programmatically after loading sqlite-vec extension.
-- This migration only records the schema version.

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (9, strftime('%s','now') * 1000);
