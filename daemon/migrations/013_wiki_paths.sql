-- Add wiki_paths to projects (JSON array of relative/absolute paths, default: ["docs"])
ALTER TABLE projects ADD COLUMN wiki_paths TEXT NOT NULL DEFAULT '["docs"]';

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (13, strftime('%s','now') * 1000);
