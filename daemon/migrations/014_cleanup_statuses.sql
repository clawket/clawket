-- Migrate legacy step statuses to the simplified 5-status model
UPDATE steps SET status = 'cancelled' WHERE status IN ('superseded', 'deferred');
UPDATE steps SET status = 'in_progress' WHERE status = 'review';

-- Migrate legacy bolt statuses
UPDATE bolts SET status = 'active' WHERE status = 'review';

-- Migrate legacy plan statuses
UPDATE plans SET status = 'active' WHERE status = 'approved';
UPDATE plans SET status = 'completed' WHERE status = 'archived';

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (14, strftime('%s','now') * 1000);
