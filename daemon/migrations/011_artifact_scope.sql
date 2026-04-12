-- Lattice v11: Artifact scope for RAG filtering
-- scope: 'rag' (embed + searchable), 'reference' (no embed, explicit access), 'archive' (no LLM access)
ALTER TABLE artifacts ADD COLUMN scope TEXT NOT NULL DEFAULT 'reference';

CREATE INDEX IF NOT EXISTS idx_artifacts_scope ON artifacts(scope);

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (11, strftime('%s','now') * 1000);
