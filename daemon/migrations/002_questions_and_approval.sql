-- Lattice v2: questions + approval workflow
-- Design decisions:
--   - Questions are logged (not primary interaction). Claude asks via AskUserQuestion,
--     then writes to DB for future reference.
--   - Web can also create questions; Claude pulls pending on demand.
--   - Phase approval: approval_required flag + web approval blocks execution via polling.

-- Questions: attached to exactly one of plan/phase/step
CREATE TABLE IF NOT EXISTS questions (
  id             TEXT PRIMARY KEY,        -- Q-<ulid>
  plan_id        TEXT,
  phase_id       TEXT,
  step_id        TEXT,
  kind           TEXT NOT NULL,            -- clarification|decision|blocker|review
  origin         TEXT NOT NULL,            -- prompt|web|hook
  body           TEXT NOT NULL,
  asked_by       TEXT,                     -- main | human | skill:<name>
  created_at     INTEGER NOT NULL,
  -- answer at tail (volatile)
  answer         TEXT,
  answered_by    TEXT,                     -- main | human
  answered_at    INTEGER,
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE,
  FOREIGN KEY (phase_id) REFERENCES phases(id) ON DELETE CASCADE,
  FOREIGN KEY (step_id) REFERENCES steps(id) ON DELETE CASCADE,
  CHECK (
    (plan_id IS NOT NULL) OR
    (phase_id IS NOT NULL) OR
    (step_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_questions_plan ON questions(plan_id);
CREATE INDEX IF NOT EXISTS idx_questions_phase ON questions(phase_id);
CREATE INDEX IF NOT EXISTS idx_questions_step ON questions(step_id);
CREATE INDEX IF NOT EXISTS idx_questions_pending ON questions(answered_at) WHERE answered_at IS NULL;

-- Phase approval workflow
-- Status already covers pending|active|completed|blocked
-- New status: 'awaiting_approval' between active and completed
-- approval_required: whether this phase needs explicit approval to proceed
-- approved_by: who approved (human:<name> | agent:<name>)
ALTER TABLE phases ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE phases ADD COLUMN approved_by TEXT;
ALTER TABLE phases ADD COLUMN approved_at INTEGER;

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (2, strftime('%s','now') * 1000);
