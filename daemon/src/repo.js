import { getDb } from './db.js';
import { newId, now, slugify } from './id.js';

// -------- Projects --------

/** Generate a short uppercase key from a project name. */
function generateKeyFromName(name) {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 1) {
    // Single word: take up to 3 uppercase letters
    return words[0].slice(0, 3).toUpperCase();
  }
  // Multiple words: take first letter of each (up to 4)
  return words.slice(0, 4).map(w => w[0]).join('').toUpperCase();
}

export const projects = {
  create({ name, description = null, cwd = null, key = null }) {
    const db = getDb();
    const id = `PROJ-${slugify(name)}`;
    const ts = now();
    const finalKey = key ? key.toUpperCase() : generateKeyFromName(name);
    db.prepare(
      `INSERT INTO projects (id, name, description, created_at, updated_at, key)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, name, description, ts, ts, finalKey);
    if (cwd) {
      db.prepare(`INSERT INTO project_cwds (project_id, cwd) VALUES (?, ?)`).run(id, cwd);
    }
    return projects.get(id);
  },
  get(id) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
    if (!row) return null;
    row.cwds = db.prepare(`SELECT cwd FROM project_cwds WHERE project_id = ?`).all(id).map(r => r.cwd);
    return row;
  },
  getByName(name) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM projects WHERE name = ?`).get(name);
    return row ? projects.get(row.id) : null;
  },
  getByCwd(cwd) {
    const db = getDb();
    const row = db.prepare(
      `SELECT p.* FROM projects p JOIN project_cwds c ON c.project_id = p.id WHERE c.cwd = ? LIMIT 1`
    ).get(cwd);
    return row ? projects.get(row.id) : null;
  },
  list() {
    const db = getDb();
    return db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all()
      .map(r => ({ ...r, cwds: db.prepare(`SELECT cwd FROM project_cwds WHERE project_id = ?`).all(r.id).map(x => x.cwd) }));
  },
  addCwd(id, cwd) {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO project_cwds (project_id, cwd) VALUES (?, ?)`).run(id, cwd);
    return projects.get(id);
  },
  update(id, fields) {
    const db = getDb();
    const allowed = ['name', 'description', 'key'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in fields) {
        sets.push(`${k} = ?`);
        vals.push(k === 'key' && fields[k] ? fields[k].toUpperCase() : fields[k]);
      }
    }
    if (sets.length === 0) return projects.get(id);
    sets.push('updated_at = ?');
    vals.push(now(), id);
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return projects.get(id);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  },
};

// -------- Plans --------
export const plans = {
  create({ project_id, title, description = null, source = 'manual', source_path = null }) {
    const db = getDb();
    const id = newId('PLAN');
    const ts = now();
    db.prepare(
      `INSERT INTO plans (id, project_id, title, description, source, source_path, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`
    ).run(id, project_id, title, description, source, source_path, ts);
    return plans.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM plans WHERE id = ?`).get(id) ?? null;
  },
  list({ project_id = null, status = null } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (project_id) { where.push('project_id = ?'); vals.push(project_id); }
    if (status) { where.push('status = ?'); vals.push(status); }
    const sql = `SELECT * FROM plans ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return db.prepare(sql).all(...vals);
  },
  update(id, fields) {
    const db = getDb();
    const allowed = ['title', 'description', 'status'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in fields) {
        sets.push(`${k} = ?`);
        vals.push(fields[k]);
      }
    }
    if ('status' in fields && fields.status === 'approved') {
      sets.push('approved_at = ?');
      vals.push(now());
    }
    if (sets.length === 0) return plans.get(id);
    vals.push(id);
    db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return plans.get(id);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM plans WHERE id = ?`).run(id);
  },
};

// -------- Phases --------
export const phases = {
  create({ plan_id, title, goal = null, idx = null, approval_required = false }) {
    const db = getDb();
    const id = newId('PHASE');
    const ts = now();
    const finalIdx = idx ?? (db.prepare(`SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM phases WHERE plan_id = ?`).get(plan_id).next);
    db.prepare(
      `INSERT INTO phases (id, plan_id, idx, title, goal, created_at, status, approval_required)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(id, plan_id, finalIdx, title, goal, ts, approval_required ? 1 : 0);
    return phases.get(id);
  },
  approve(id, { by = 'human' } = {}) {
    const db = getDb();
    db.prepare(
      `UPDATE phases SET status = 'active', approved_by = ?, approved_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`
    ).run(by, now(), now(), id);
    return phases.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM phases WHERE id = ?`).get(id) ?? null;
  },
  list({ plan_id = null, status = null } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (plan_id) { where.push('plan_id = ?'); vals.push(plan_id); }
    if (status) { where.push('status = ?'); vals.push(status); }
    const sql = `SELECT * FROM phases ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY plan_id, idx`;
    return db.prepare(sql).all(...vals);
  },
  update(id, fields) {
    const db = getDb();
    const allowed = ['title', 'goal', 'status', 'approval_required'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in fields) {
        sets.push(`${k} = ?`);
        vals.push(k === 'approval_required' ? (fields[k] ? 1 : 0) : fields[k]);
      }
    }
    if ('status' in fields) {
      if (fields.status === 'active') { sets.push('started_at = COALESCE(started_at, ?)'); vals.push(now()); }
      if (fields.status === 'completed') { sets.push('completed_at = ?'); vals.push(now()); }
    }
    if (sets.length === 0) return phases.get(id);
    vals.push(id);
    db.prepare(`UPDATE phases SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return phases.get(id);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM phases WHERE id = ?`).run(id);
  },
};

// -------- Questions --------
export const questions = {
  create({ plan_id = null, phase_id = null, step_id = null, kind = 'clarification', origin = 'prompt', body, asked_by = 'main' }) {
    const db = getDb();
    const id = newId('Q');
    db.prepare(
      `INSERT INTO questions (id, plan_id, phase_id, step_id, kind, origin, body, asked_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, plan_id, phase_id, step_id, kind, origin, body, asked_by, now());
    return questions.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM questions WHERE id = ?`).get(id) ?? null;
  },
  list({ plan_id = null, phase_id = null, step_id = null, pending = null } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (plan_id) { where.push('plan_id = ?'); vals.push(plan_id); }
    if (phase_id) { where.push('phase_id = ?'); vals.push(phase_id); }
    if (step_id) { where.push('step_id = ?'); vals.push(step_id); }
    if (pending === true) where.push('answered_at IS NULL');
    if (pending === false) where.push('answered_at IS NOT NULL');
    const sql = `SELECT * FROM questions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return db.prepare(sql).all(...vals);
  },
  answer(id, { answer, answered_by = 'human' }) {
    getDb().prepare(
      `UPDATE questions SET answer = ?, answered_by = ?, answered_at = ? WHERE id = ?`
    ).run(answer, answered_by, now(), id);
    return questions.get(id);
  },
};

// -------- Steps --------
export const steps = {
  /** Resolve project key for a step by traversing phase -> plan -> project. */
  _resolveProjectKey(db, phase_id) {
    const row = db.prepare(
      `SELECT p.key FROM projects p
       JOIN plans pl ON pl.project_id = p.id
       JOIN phases ph ON ph.plan_id = pl.id
       WHERE ph.id = ?`
    ).get(phase_id);
    return row?.key ?? null;
  },

  /** Generate next ticket number for a project key. */
  _nextTicketNumber(db, projectKey) {
    if (!projectKey) return null;
    const prefix = projectKey + '-';
    const row = db.prepare(
      `SELECT ticket_number FROM steps
       WHERE ticket_number LIKE ? || '%'
       ORDER BY CAST(SUBSTR(ticket_number, LENGTH(?) + 1) AS INTEGER) DESC
       LIMIT 1`
    ).get(prefix, prefix);
    if (!row) return `${projectKey}-1`;
    const num = parseInt(row.ticket_number.slice(prefix.length), 10);
    return `${projectKey}-${num + 1}`;
  },

  create({ phase_id, title, body = '', assignee = null, idx = null, depends_on = [],
           parent_step_id = null, priority = 'medium', complexity = null, estimated_edits = null,
           bolt_id = null, reporter = null }) {
    const db = getDb();
    const id = newId('STEP');
    const ts = now();
    const finalIdx = idx ?? (db.prepare(`SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM steps WHERE phase_id = ?`).get(phase_id).next);

    // Auto-generate ticket_number from project key
    const projectKey = steps._resolveProjectKey(db, phase_id);
    const ticketNumber = steps._nextTicketNumber(db, projectKey);

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO steps (id, phase_id, idx, title, body, created_at, status, assignee,
         ticket_number, parent_step_id, priority, complexity, estimated_edits, bolt_id, reporter)
         VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, phase_id, finalIdx, title, body, ts, assignee,
            ticketNumber, parent_step_id, priority, complexity, estimated_edits, bolt_id, reporter);
      const insDep = db.prepare(`INSERT INTO step_depends_on (step_id, depends_on_id) VALUES (?, ?)`);
      for (const dep of depends_on) insDep.run(id, dep);
    });
    tx();
    return steps.get(id);
  },
  get(id) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM steps WHERE id = ?`).get(id);
    if (!row) return null;
    row.depends_on = db.prepare(`SELECT depends_on_id FROM step_depends_on WHERE step_id = ?`).all(id).map(r => r.depends_on_id);
    try {
      row.labels = db.prepare(`SELECT label FROM step_labels WHERE step_id = ?`).all(id).map(r => r.label);
    } catch { row.labels = []; }
    return row;
  },
  list({ phase_id = null, plan_id = null, status = null, bolt_id = null, parent_step_id = undefined } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    let sql = `SELECT s.* FROM steps s`;
    if (plan_id) {
      sql += ` JOIN phases p ON p.id = s.phase_id`;
      where.push('p.plan_id = ?');
      vals.push(plan_id);
    }
    if (phase_id) { where.push('s.phase_id = ?'); vals.push(phase_id); }
    if (status) { where.push('s.status = ?'); vals.push(status); }
    if (bolt_id) { where.push('s.bolt_id = ?'); vals.push(bolt_id); }
    if (parent_step_id !== undefined) {
      if (parent_step_id === null) {
        where.push('s.parent_step_id IS NULL');
      } else {
        where.push('s.parent_step_id = ?');
        vals.push(parent_step_id);
      }
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY s.phase_id, s.idx';
    return db.prepare(sql).all(...vals);
  },
  appendBody(id, text) {
    const db = getDb();
    db.prepare(`UPDATE steps SET body = body || ? WHERE id = ?`).run(text, id);
    return steps.get(id);
  },
  update(id, fields) {
    const db = getDb();
    const allowed = ['title', 'status', 'assignee', 'priority', 'complexity', 'estimated_edits', 'parent_step_id', 'bolt_id', 'phase_id', 'reporter'];
    const sets = [];
    const vals = [];

    // Capture old values for activity log
    const oldStep = steps.get(id);

    for (const k of allowed) {
      if (k in fields) {
        sets.push(`${k} = ?`);
        vals.push(fields[k]);
      }
    }
    if ('status' in fields) {
      if (fields.status === 'in_progress') { sets.push('started_at = COALESCE(started_at, ?)'); vals.push(now()); }
      if (['done', 'cancelled', 'superseded'].includes(fields.status)) { sets.push('completed_at = ?'); vals.push(now()); }
    }
    if (sets.length === 0) return steps.get(id);
    vals.push(id);
    db.prepare(`UPDATE steps SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    // Auto run management
    if ('status' in fields) {
      const sessionId = fields._session_id || null;
      const agent = fields._agent || fields.assignee || 'main';

      if (fields.status === 'in_progress') {
        // Start a new run if none active for this step
        const existing = runs.list({ step_id: id }).find(r => !r.ended_at);
        if (!existing) {
          runs.create({ step_id: id, session_id: sessionId, agent });
        }
      }
      if (['done', 'cancelled', 'superseded'].includes(fields.status)) {
        // Finish all active runs for this step
        const result = fields.status === 'done' ? 'success' : fields.status;
        for (const r of runs.list({ step_id: id })) {
          if (!r.ended_at) {
            runs.finish(r.id, { result, notes: null });
          }
        }
      }
    }

    // Record activity log for tracked fields
    if (oldStep) {
      const actor = fields._agent || fields.assignee || oldStep.assignee || 'system';
      for (const k of ['status', 'assignee', 'priority', 'bolt_id', 'phase_id']) {
        if (k in fields && String(fields[k]) !== String(oldStep[k])) {
          try {
            activityLog.record({
              entity_type: 'step',
              entity_id: id,
              action: k === 'status' ? 'status_change' : 'updated',
              field: k,
              old_value: oldStep[k] != null ? String(oldStep[k]) : null,
              new_value: fields[k] != null ? String(fields[k]) : null,
              actor,
            });
          } catch { /* ignore if activity_log table not yet migrated */ }
        }
      }
    }

    return steps.get(id);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM steps WHERE id = ?`).run(id);
  },
  /** Bulk update multiple steps with the same fields. Returns updated steps. */
  bulkUpdate(ids, fields) {
    return ids.map(id => steps.update(id, fields));
  },
  search(query, { limit = 20 } = {}) {
    const db = getDb();
    // Auto-prefix: each whitespace-separated term gets a trailing * unless user wrote fts5 operators
    const ftsQuery = /[*":()]/.test(query)
      ? query
      : query.split(/\s+/).filter(Boolean).map(t => t + '*').join(' ');
    return db.prepare(
      `SELECT s.* FROM steps_fts f JOIN steps s ON s.rowid = f.rowid
       WHERE steps_fts MATCH ? ORDER BY rank LIMIT ?`
    ).all(ftsQuery, limit);
  },
  addLabel(id, label) {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO step_labels (step_id, label) VALUES (?, ?)`).run(id, label.toLowerCase().trim());
    return steps.get(id);
  },
  removeLabel(id, label) {
    const db = getDb();
    db.prepare(`DELETE FROM step_labels WHERE step_id = ? AND label = ?`).run(id, label.toLowerCase().trim());
    return steps.get(id);
  },
  listByLabel(label) {
    const db = getDb();
    return db.prepare(
      `SELECT s.* FROM steps s JOIN step_labels l ON l.step_id = s.id WHERE l.label = ? ORDER BY s.phase_id, s.idx`
    ).all(label.toLowerCase().trim());
  },
};

// -------- Step Relations --------

export const stepRelations = {
  create({ source_step_id, target_step_id, relation_type }) {
    const db = getDb();
    const id = newId('REL');
    const ts = now();
    db.prepare(
      `INSERT INTO step_relations (id, source_step_id, target_step_id, relation_type, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, source_step_id, target_step_id, relation_type, ts);
    return { id, source_step_id, target_step_id, relation_type, created_at: ts };
  },
  list({ step_id = null, relation_type = null } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (step_id) {
      where.push('(source_step_id = ? OR target_step_id = ?)');
      vals.push(step_id, step_id);
    }
    if (relation_type) { where.push('relation_type = ?'); vals.push(relation_type); }
    const sql = `SELECT * FROM step_relations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return db.prepare(sql).all(...vals);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM step_relations WHERE id = ?`).run(id);
  },
};

// -------- Bolts (Sprint / AIDLC Bolt cycle) --------

export const bolts = {
  create({ project_id, title, goal = null, idx = null }) {
    const db = getDb();
    const id = newId('BOLT');
    const ts = now();
    const finalIdx = idx ?? (db.prepare(`SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM bolts WHERE project_id = ?`).get(project_id).next);
    db.prepare(
      `INSERT INTO bolts (id, project_id, title, goal, idx, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'planning')`
    ).run(id, project_id, title, goal, finalIdx, ts);
    return bolts.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM bolts WHERE id = ?`).get(id) ?? null;
  },
  list({ project_id = null, status = null } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (project_id) { where.push('project_id = ?'); vals.push(project_id); }
    if (status) { where.push('status = ?'); vals.push(status); }
    const sql = `SELECT * FROM bolts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY idx`;
    return db.prepare(sql).all(...vals);
  },
  update(id, fields) {
    const db = getDb();
    const allowed = ['title', 'goal', 'status'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
    }
    if ('status' in fields) {
      if (fields.status === 'active') { sets.push('started_at = COALESCE(started_at, ?)'); vals.push(now()); }
      if (['review', 'completed'].includes(fields.status)) { sets.push('ended_at = ?'); vals.push(now()); }
    }
    if (sets.length === 0) return bolts.get(id);
    vals.push(id);
    db.prepare(`UPDATE bolts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return bolts.get(id);
  },
  delete(id) {
    // Unassign steps from this bolt before deleting
    getDb().prepare(`UPDATE steps SET bolt_id = NULL WHERE bolt_id = ?`).run(id);
    getDb().prepare(`DELETE FROM bolts WHERE id = ?`).run(id);
  },
  /** List steps assigned to this bolt. */
  steps(id) {
    return getDb().prepare(`SELECT * FROM steps WHERE bolt_id = ? ORDER BY idx`).all(id);
  },
  /** List backlog steps (not assigned to any bolt) for a project. */
  backlog(project_id) {
    return getDb().prepare(
      `SELECT s.* FROM steps s
       JOIN phases ph ON ph.id = s.phase_id
       JOIN plans pl ON pl.id = ph.plan_id
       WHERE pl.project_id = ? AND s.bolt_id IS NULL
       ORDER BY s.created_at`
    ).all(project_id);
  },
};

// -------- Step Comments --------
export const stepComments = {
  create({ step_id, author, body }) {
    const db = getDb();
    const id = newId('CMT');
    const ts = now();
    db.prepare(
      `INSERT INTO step_comments (id, step_id, author, body, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, step_id, author, body, ts);
    return stepComments.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM step_comments WHERE id = ?`).get(id) ?? null;
  },
  list({ step_id }) {
    return getDb().prepare(
      `SELECT * FROM step_comments WHERE step_id = ? ORDER BY created_at ASC`
    ).all(step_id);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM step_comments WHERE id = ?`).run(id);
  },
};

// -------- Artifacts --------
export const artifacts = {
  create({ step_id = null, phase_id = null, plan_id = null, type, title, content = '', content_format = 'md', parent_id = null }) {
    const db = getDb();
    const id = newId('ART');
    const ts = now();
    db.prepare(
      `INSERT INTO artifacts (id, step_id, phase_id, plan_id, type, title, content, content_format, created_at, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, step_id, phase_id, plan_id, type, title, content, content_format, ts, parent_id);
    return artifacts.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) ?? null;
  },
  list({ step_id = null, phase_id = null, plan_id = null, type = null } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (step_id) { where.push('step_id = ?'); vals.push(step_id); }
    if (phase_id) { where.push('phase_id = ?'); vals.push(phase_id); }
    if (plan_id) { where.push('plan_id = ?'); vals.push(plan_id); }
    if (type) { where.push('type = ?'); vals.push(type); }
    const sql = `SELECT * FROM artifacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return db.prepare(sql).all(...vals);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
  },
};

// -------- Artifact Versions --------
export const artifactVersions = {
  create({ artifact_id, content = null, content_format = null, created_by = null }) {
    const db = getDb();
    const id = newId('ARTV');
    const ts = now();
    // Auto-increment version number per artifact
    const row = db.prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifact_versions WHERE artifact_id = ?`
    ).get(artifact_id);
    const version = row.next;
    db.prepare(
      `INSERT INTO artifact_versions (id, artifact_id, version, content, content_format, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, artifact_id, version, content, content_format, ts, created_by);
    return artifactVersions.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM artifact_versions WHERE id = ?`).get(id) ?? null;
  },
  list({ artifact_id }) {
    return getDb().prepare(
      `SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version ASC`
    ).all(artifact_id);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM artifact_versions WHERE id = ?`).run(id);
  },
};

// -------- Runs --------
export const runs = {
  create({ step_id, session_id = null, agent = 'main' }) {
    const db = getDb();
    const id = newId('RUN');
    db.prepare(
      `INSERT INTO runs (id, step_id, session_id, agent, started_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, step_id, session_id, agent, now());
    return runs.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) ?? null;
  },
  list({ step_id = null, session_id = null } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (step_id) { where.push('step_id = ?'); vals.push(step_id); }
    if (session_id) { where.push('session_id = ?'); vals.push(session_id); }
    const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC`;
    return db.prepare(sql).all(...vals);
  },
  finish(id, { result, notes = null }) {
    getDb().prepare(`UPDATE runs SET ended_at = ?, result = ?, notes = ? WHERE id = ?`)
      .run(now(), result, notes, id);
    return runs.get(id);
  },
};

// -------- Activity Log --------

export const activityLog = {
  record({ entity_type, entity_id, action, field = null, old_value = null, new_value = null, actor = null }) {
    const db = getDb();
    const id = newId('LOG');
    const ts = now();
    db.prepare(
      `INSERT INTO activity_log (id, entity_type, entity_id, action, field, old_value, new_value, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, entity_type, entity_id, action, field, old_value, new_value, actor, ts);
    return { id, entity_type, entity_id, action, field, old_value, new_value, actor, created_at: ts };
  },
  list({ entity_type = null, entity_id = null, limit = 50 } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (entity_type) { where.push('entity_type = ?'); vals.push(entity_type); }
    if (entity_id) { where.push('entity_id = ?'); vals.push(entity_id); }
    const sql = `SELECT * FROM activity_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
    vals.push(limit);
    return db.prepare(sql).all(...vals);
  },
};
