import { getDb } from './db.js';
import { newId, now, slugify } from './id.js';

// -------- Shared helpers --------

function buildWhere(filters) {
  const where = [];
  const vals = [];
  for (const [key, val] of Object.entries(filters)) {
    if (val != null) { where.push(`${key} = ?`); vals.push(val); }
  }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', vals };
}

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
    const rows = db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all();
    const allCwds = db.prepare(`SELECT project_id, cwd FROM project_cwds`).all();
    const cwdMap = {};
    for (const c of allCwds) (cwdMap[c.project_id] ||= []).push(c.cwd);
    return rows.map(r => ({ ...r, cwds: cwdMap[r.id] || [] }));
  },
  addCwd(id, cwd) {
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO project_cwds (project_id, cwd) VALUES (?, ?)`).run(id, cwd);
    return projects.get(id);
  },
  removeCwd(id, cwd) {
    const db = getDb();
    db.prepare(`DELETE FROM project_cwds WHERE project_id = ? AND cwd = ?`).run(id, cwd);
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
    const { clause, vals } = buildWhere({ project_id, status });
    return db.prepare(`SELECT * FROM plans ${clause} ORDER BY created_at DESC`).all(...vals);
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
    if ('status' in fields && (fields.status === 'approved' || fields.status === 'active')) {
      if ('approved_at' in fields) {
        sets.push('approved_at = ?');
        vals.push(fields.approved_at);
      } else if (fields.status === 'approved') {
        sets.push('approved_at = ?');
        vals.push(now());
      }
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
    const { clause, vals } = buildWhere({ plan_id, status });
    return db.prepare(`SELECT * FROM phases ${clause} ORDER BY plan_id, idx`).all(...vals);
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
      if (fields.status === 'completed') {
        // Block completion if any step is still todo/in_progress
        const phaseSteps = steps.list({ phase_id: id });
        const hasIncomplete = phaseSteps.some(s => s.status === 'todo' || s.status === 'in_progress');
        if (hasIncomplete) {
          throw Object.assign(new Error(`Cannot complete phase: ${phaseSteps.filter(s => s.status === 'todo' || s.status === 'in_progress').length} step(s) still incomplete`), { status: 400 });
        }
        sets.push('completed_at = ?'); vals.push(now());
      }
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
/** Auto-activate phase & plan when step is created or started under completed/pending ancestors */
function _autoActivateAncestors(db, phase_id) {
  const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(phase_id);
  if (!phase) return;
  // Activate phase if not active
  if (phase.status === 'completed' || phase.status === 'pending') {
    const ts = now();
    db.prepare(`UPDATE phases SET status = 'active', started_at = COALESCE(started_at, ?) WHERE id = ?`).run(ts, phase_id);
  }
  // Activate plan only if it was completed (re-open). Draft/approved require explicit approval flow.
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(phase.plan_id);
  if (plan && plan.status === 'completed') {
    db.prepare(`UPDATE plans SET status = 'active' WHERE id = ?`).run(phase.plan_id);
  }
}

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
           bolt_id = null, reporter = null, type = 'task' }) {
    if (!phase_id) {
      throw Object.assign(new Error('phase_id is required'), { status: 400 });
    }
    if (!bolt_id) {
      // Auto-resolve: find active bolt for this project via phase → plan → project
      const db0 = getDb();
      const phase = db0.prepare('SELECT * FROM phases WHERE id = ?').get(phase_id);
      if (phase) {
        const plan = db0.prepare('SELECT * FROM plans WHERE id = ?').get(phase.plan_id);
        if (plan) {
          const activeBolts = db0.prepare(
            "SELECT * FROM bolts WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC"
          ).all(plan.project_id);
          if (activeBolts.length === 1) {
            bolt_id = activeBolts[0].id;
          } else if (activeBolts.length > 1) {
            throw Object.assign(new Error(
              `Multiple active bolts found. Specify --bolt: ${activeBolts.map(b => b.id).join(', ')}`
            ), { status: 400 });
          }
        }
      }
      if (!bolt_id) {
        throw Object.assign(new Error('bolt_id is required. Create a bolt first: lattice bolt new "Sprint N" --project <PROJ-ID>'), { status: 400 });
      }
    }
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
         ticket_number, parent_step_id, priority, complexity, estimated_edits, bolt_id, reporter, type)
         VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, phase_id, finalIdx, title, body, ts, assignee,
            ticketNumber, parent_step_id, priority, complexity, estimated_edits, bolt_id, reporter, type);
      const insDep = db.prepare(`INSERT INTO step_depends_on (step_id, depends_on_id) VALUES (?, ?)`);
      for (const dep of depends_on) insDep.run(id, dep);
    });
    tx();

    // Auto-activate phase & plan when a new step is created under completed/pending phase/plan
    _autoActivateAncestors(db, phase_id);

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
    const allowed = ['title', 'status', 'assignee', 'priority', 'complexity', 'estimated_edits', 'parent_step_id', 'bolt_id', 'phase_id', 'reporter', 'type'];
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

    // Auto-activate phase & plan when step becomes in_progress
    if ('status' in fields && fields.status === 'in_progress') {
      const updatedStep = steps.get(id);
      if (updatedStep) {
        _autoActivateAncestors(db, updatedStep.phase_id);
      }
    }

    // Auto-complete phase & plan if ALL steps are terminal
    if ('status' in fields && ['done', 'cancelled', 'superseded'].includes(fields.status)) {
      const updatedStep = steps.get(id);
      if (updatedStep) {
        const phaseSteps = steps.list({ phase_id: updatedStep.phase_id });
        const terminalStatuses = new Set(['done', 'cancelled', 'superseded']);
        const allDone = phaseSteps.every(s => terminalStatuses.has(s.status));
        if (allDone && phaseSteps.length > 0) {
          const phase = phases.get(updatedStep.phase_id);
          if (phase && phase.status !== 'completed') {
            phases.update(updatedStep.phase_id, { status: 'completed' });
          }
          // Auto-complete plan if ALL phases are completed
          if (phase) {
            const planPhases = phases.list({ plan_id: phase.plan_id });
            const allPhasesCompleted = planPhases.every(p => p.status === 'completed');
            if (allPhasesCompleted && planPhases.length > 0) {
              const plan = plans.get(phase.plan_id);
              if (plan && plan.status !== 'completed') {
                plans.update(phase.plan_id, { status: 'completed' });
              }
            }
          }
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
  search(query, { limit = 20, mode = 'keyword' } = {}) {
    const db = getDb();

    if (mode === 'keyword' || mode === 'hybrid') {
      // FTS5 keyword search
      const ftsQuery = /[*":()]/.test(query)
        ? query
        : query.split(/\s+/).filter(Boolean).map(t => t + '*').join(' ');
      const ftsResults = db.prepare(
        `SELECT s.* FROM steps_fts f JOIN steps s ON s.rowid = f.rowid
         WHERE steps_fts MATCH ? ORDER BY rank LIMIT ?`
      ).all(ftsQuery, limit);

      if (mode === 'keyword') return ftsResults;

      // Hybrid: combine FTS + vector results (vector search handled async in server)
      return ftsResults;
    }

    // Semantic-only: handled in server.js (async embedding required)
    return [];
  },
  /** Vector search — call from server with pre-computed query embedding */
  vectorSearch(queryEmbedding, { limit = 20 } = {}) {
    const db = getDb();
    try {
      const rows = db.prepare(
        `SELECT step_id, distance FROM vec_steps
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
      ).all(new Float32Array(queryEmbedding), limit);
      return rows.map(r => {
        const step = steps.get(r.step_id);
        return step ? { ...step, _distance: r.distance } : null;
      }).filter(Boolean);
    } catch {
      return [];
    }
  },
  /** Store embedding for a step */
  storeEmbedding(stepId, embedding) {
    const db = getDb();
    try {
      db.prepare(`INSERT OR REPLACE INTO vec_steps (step_id, embedding) VALUES (?, ?)`).run(stepId, new Float32Array(embedding));
    } catch { /* vec not available */ }
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
    if (!project_id) {
      throw Object.assign(new Error('project_id is required'), { status: 400 });
    }
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
  create({ step_id = null, phase_id = null, plan_id = null, type, title, content = '', content_format = 'md', parent_id = null, scope = 'reference' }) {
    const db = getDb();
    const id = newId('ART');
    const ts = now();
    db.prepare(
      `INSERT INTO artifacts (id, step_id, phase_id, plan_id, type, title, content, content_format, created_at, parent_id, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, step_id, phase_id, plan_id, type, title, content, content_format, ts, parent_id, scope);
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
  storeEmbedding(artifactId, embedding) {
    const db = getDb();
    try {
      db.prepare(`INSERT OR REPLACE INTO vec_artifacts (artifact_id, embedding) VALUES (?, ?)`).run(artifactId, new Float32Array(embedding));
    } catch { /* vec not available */ }
  },
  vectorSearch(queryEmbedding, { limit = 20, scope = 'rag' } = {}) {
    const db = getDb();
    try {
      const rows = db.prepare(
        `SELECT artifact_id, distance FROM vec_artifacts
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
      ).all(new Float32Array(queryEmbedding), limit * 2);
      return rows.map(r => {
        const art = artifacts.get(r.artifact_id);
        if (!art || (scope && art.scope !== scope)) return null;
        return { ...art, _distance: r.distance };
      }).filter(Boolean).slice(0, limit);
    } catch {
      return [];
    }
  },
  update(id, { title, content, content_format, scope, created_by = null }) {
    const db = getDb();
    const existing = artifacts.get(id);
    if (!existing) return null;

    // Auto-snapshot current version before update
    if (content !== undefined && content !== existing.content) {
      artifactVersions.create({
        artifact_id: id,
        content: existing.content,
        content_format: existing.content_format,
        created_by,
      });
    }

    const sets = [];
    const vals = [];
    if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
    if (content !== undefined) { sets.push('content = ?'); vals.push(content); }
    if (content_format !== undefined) { sets.push('content_format = ?'); vals.push(content_format); }
    if (scope !== undefined) { sets.push('scope = ?'); vals.push(scope); }
    if (sets.length === 0) return existing;

    vals.push(id);
    db.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return artifacts.get(id);
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
  list({ step_id = null, session_id = null, project_id = null } = {}) {
    const db = getDb();
    if (project_id) {
      // Join through steps → phases → plans to filter by project
      const sql = `SELECT r.* FROM runs r
        JOIN steps s ON r.step_id = s.id
        JOIN phases ph ON s.phase_id = ph.id
        JOIN plans pl ON ph.plan_id = pl.id
        WHERE pl.project_id = ?
        ORDER BY r.started_at DESC`;
      return db.prepare(sql).all(project_id);
    }
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
    const { clause, vals } = buildWhere({ entity_type, entity_id });
    vals.push(limit);
    return db.prepare(`SELECT * FROM activity_log ${clause} ORDER BY created_at DESC LIMIT ?`).all(...vals);
  },
};

// -------- Project Timeline (unified event stream) --------

export const timeline = {
  /**
   * Unified timeline for a project — aggregates activity_log, step_comments,
   * artifacts, runs, and questions into a single chronological feed.
   */
  list({ project_id, limit = 100, offset = 0, types = null }) {
    const db = getDb();
    const typeSet = types ? new Set(types.split(',').map(t => t.trim())) : null;

    const parts = [];
    const allVals = [];

    // 1) activity_log → steps → phases → plans → project
    if (!typeSet || typeSet.has('status_change') || typeSet.has('created') || typeSet.has('updated') || typeSet.has('assignment')) {
      parts.push(`
        SELECT
          al.id,
          CASE
            WHEN al.field = 'assignee' THEN 'assignment'
            ELSE al.action
          END AS event_type,
          al.entity_type,
          al.entity_id,
          COALESCE(s.title, '') AS entity_title,
          al.actor,
          al.created_at,
          al.field AS detail_field,
          al.old_value AS detail_old_value,
          al.new_value AS detail_new_value,
          NULL AS detail_body,
          NULL AS detail_artifact_type,
          NULL AS detail_agent,
          NULL AS detail_duration_ms,
          NULL AS detail_result
        FROM activity_log al
        LEFT JOIN steps s ON al.entity_type = 'step' AND al.entity_id = s.id
        LEFT JOIN phases ph ON s.phase_id = ph.id
        LEFT JOIN plans pl ON ph.plan_id = pl.id
        WHERE pl.project_id = ?
      `);
      allVals.push(project_id);
    }

    // 2) step_comments
    if (!typeSet || typeSet.has('comment')) {
      parts.push(`
        SELECT
          cmt.id,
          'comment' AS event_type,
          'step' AS entity_type,
          cmt.step_id AS entity_id,
          COALESCE(s.title, '') AS entity_title,
          cmt.author AS actor,
          cmt.created_at,
          NULL AS detail_field,
          NULL AS detail_old_value,
          NULL AS detail_new_value,
          cmt.body AS detail_body,
          NULL AS detail_artifact_type,
          NULL AS detail_agent,
          NULL AS detail_duration_ms,
          NULL AS detail_result
        FROM step_comments cmt
        JOIN steps s ON cmt.step_id = s.id
        JOIN phases ph ON s.phase_id = ph.id
        JOIN plans pl ON ph.plan_id = pl.id
        WHERE pl.project_id = ?
      `);
      allVals.push(project_id);
    }

    // 3) artifacts (step/phase/plan level)
    if (!typeSet || typeSet.has('artifact')) {
      parts.push(`
        SELECT
          art.id,
          'artifact' AS event_type,
          'step' AS entity_type,
          COALESCE(art.step_id, art.phase_id, art.plan_id) AS entity_id,
          COALESCE(s.title, ph2.title, pl2.title, '') AS entity_title,
          NULL AS actor,
          art.created_at,
          NULL AS detail_field,
          NULL AS detail_old_value,
          NULL AS detail_new_value,
          art.title AS detail_body,
          art.type AS detail_artifact_type,
          NULL AS detail_agent,
          NULL AS detail_duration_ms,
          NULL AS detail_result
        FROM artifacts art
        LEFT JOIN steps s ON art.step_id = s.id
        LEFT JOIN phases ph ON s.phase_id = ph.id
        LEFT JOIN plans pl ON ph.plan_id = pl.id
        LEFT JOIN phases ph2 ON art.phase_id = ph2.id
        LEFT JOIN plans pl2 ON COALESCE(ph2.plan_id, art.plan_id) = pl2.id
        WHERE COALESCE(pl.project_id, pl2.project_id) = ?
      `);
      allVals.push(project_id);
    }

    // 4) runs — emit run_start and run_end as separate events
    if (!typeSet || typeSet.has('run')) {
      parts.push(`
        SELECT
          r.id || ':start' AS id,
          'run_start' AS event_type,
          'step' AS entity_type,
          r.step_id AS entity_id,
          COALESCE(s.title, '') AS entity_title,
          r.agent AS actor,
          r.started_at AS created_at,
          NULL AS detail_field,
          NULL AS detail_old_value,
          NULL AS detail_new_value,
          NULL AS detail_body,
          NULL AS detail_artifact_type,
          r.agent AS detail_agent,
          NULL AS detail_duration_ms,
          NULL AS detail_result
        FROM runs r
        JOIN steps s ON r.step_id = s.id
        JOIN phases ph ON s.phase_id = ph.id
        JOIN plans pl ON ph.plan_id = pl.id
        WHERE pl.project_id = ?
      `);
      allVals.push(project_id);

      parts.push(`
        SELECT
          r.id || ':end' AS id,
          'run_end' AS event_type,
          'step' AS entity_type,
          r.step_id AS entity_id,
          COALESCE(s.title, '') AS entity_title,
          r.agent AS actor,
          r.ended_at AS created_at,
          NULL AS detail_field,
          NULL AS detail_old_value,
          NULL AS detail_new_value,
          NULL AS detail_body,
          NULL AS detail_artifact_type,
          r.agent AS detail_agent,
          (r.ended_at - r.started_at) AS detail_duration_ms,
          r.result AS detail_result
        FROM runs r
        JOIN steps s ON r.step_id = s.id
        JOIN phases ph ON s.phase_id = ph.id
        JOIN plans pl ON ph.plan_id = pl.id
        WHERE pl.project_id = ? AND r.ended_at IS NOT NULL
      `);
      allVals.push(project_id);
    }

    // 5) questions
    if (!typeSet || typeSet.has('question')) {
      parts.push(`
        SELECT
          q.id,
          'question' AS event_type,
          CASE
            WHEN q.step_id IS NOT NULL THEN 'step'
            WHEN q.phase_id IS NOT NULL THEN 'phase'
            ELSE 'plan'
          END AS entity_type,
          COALESCE(q.step_id, q.phase_id, q.plan_id) AS entity_id,
          COALESCE(s.title, ph2.title, pl2.title, '') AS entity_title,
          q.asked_by AS actor,
          q.created_at,
          NULL AS detail_field,
          NULL AS detail_old_value,
          NULL AS detail_new_value,
          q.body AS detail_body,
          NULL AS detail_artifact_type,
          NULL AS detail_agent,
          NULL AS detail_duration_ms,
          NULL AS detail_result
        FROM questions q
        LEFT JOIN steps s ON q.step_id = s.id
        LEFT JOIN phases ph ON s.phase_id = ph.id
        LEFT JOIN plans pl ON ph.plan_id = pl.id
        LEFT JOIN phases ph2 ON q.phase_id = ph2.id
        LEFT JOIN plans pl2 ON COALESCE(ph2.plan_id, q.plan_id) = pl2.id
        WHERE COALESCE(pl.project_id, pl2.project_id) = ?
      `);
      allVals.push(project_id);
    }

    if (parts.length === 0) return [];

    const sql = parts.join('\nUNION ALL\n') + `\nORDER BY created_at DESC\nLIMIT ? OFFSET ?`;
    allVals.push(limit, offset);

    const rows = db.prepare(sql).all(...allVals);

    return rows.map(r => ({
      id: r.id,
      event_type: r.event_type,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      entity_title: r.entity_title,
      actor: r.actor,
      created_at: r.created_at,
      detail: {
        ...(r.detail_field && { field: r.detail_field }),
        ...(r.detail_old_value && { old_value: r.detail_old_value }),
        ...(r.detail_new_value && { new_value: r.detail_new_value }),
        ...(r.detail_body && { body: r.detail_body }),
        ...(r.detail_artifact_type && { artifact_type: r.detail_artifact_type }),
        ...(r.detail_agent && { agent: r.detail_agent }),
        ...(r.detail_duration_ms != null && { duration_ms: r.detail_duration_ms }),
        ...(r.detail_result && { result: r.detail_result }),
      },
    }));
  },
};