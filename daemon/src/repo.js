import { getDb } from './db.js';
import { newId, now, slugify } from './id.js';

// -------- Constants --------
const TERMINAL_TASK_STATUSES = new Set(['done', 'cancelled']);

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
    try { row.wiki_paths = JSON.parse(row.wiki_paths); } catch { row.wiki_paths = ['docs']; }
    return row;
  },
  getByName(name) {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM projects WHERE name = ?`).get(name);
    return row ? projects.get(row.id) : null;
  },
  getByCwd(cwd, { enabledOnly = false } = {}) {
    const db = getDb();
    // Exact match first
    const exactSql = enabledOnly
      ? `SELECT p.* FROM projects p JOIN project_cwds c ON c.project_id = p.id WHERE c.cwd = ? AND p.enabled = 1 LIMIT 1`
      : `SELECT p.* FROM projects p JOIN project_cwds c ON c.project_id = p.id WHERE c.cwd = ? LIMIT 1`;
    const exact = db.prepare(exactSql).get(cwd);
    if (exact) return projects.get(exact.id);
    // Subdirectory match: cwd starts with a registered project cwd + '/'
    const prefixSql = enabledOnly
      ? `SELECT p.* FROM projects p JOIN project_cwds c ON c.project_id = p.id WHERE ? LIKE c.cwd || '/%' AND p.enabled = 1 ORDER BY LENGTH(c.cwd) DESC LIMIT 1`
      : `SELECT p.* FROM projects p JOIN project_cwds c ON c.project_id = p.id WHERE ? LIKE c.cwd || '/%' ORDER BY LENGTH(c.cwd) DESC LIMIT 1`;
    const prefix = db.prepare(prefixSql).get(cwd);
    return prefix ? projects.get(prefix.id) : null;
  },
  list() {
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all();
    const allCwds = db.prepare(`SELECT project_id, cwd FROM project_cwds`).all();
    const cwdMap = {};
    for (const c of allCwds) (cwdMap[c.project_id] ||= []).push(c.cwd);
    return rows.map(r => {
      let wp;
      try { wp = JSON.parse(r.wiki_paths); } catch { wp = ['docs']; }
      return { ...r, cwds: cwdMap[r.id] || [], wiki_paths: wp };
    });
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
    const allowed = ['name', 'description', 'key', 'enabled', 'wiki_paths'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in fields) {
        sets.push(`${k} = ?`);
        let val = fields[k];
        if (k === 'key' && val) val = val.toUpperCase();
        if (k === 'wiki_paths' && Array.isArray(val)) val = JSON.stringify(val);
        vals.push(val);
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
    if ('status' in fields) {
      const VALID = new Set(['draft', 'active', 'completed']);
      if (!VALID.has(fields.status)) {
        throw Object.assign(new Error(`Invalid plan status: "${fields.status}". Valid: ${[...VALID].join(', ')}`), { status: 400 });
      }
    }
    const allowed = ['title', 'description', 'status'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in fields) {
        sets.push(`${k} = ?`);
        vals.push(fields[k]);
      }
    }
    if ('status' in fields && fields.status === 'active') {
      if ('approved_at' in fields) {
        sets.push('approved_at = ?');
        vals.push(fields.approved_at);
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

// -------- Units --------
export const units = {
  create({ plan_id, title, goal = null, idx = null, approval_required = false, execution_mode = 'sequential' }) {
    const db = getDb();
    const id = newId('UNIT');
    const ts = now();
    const finalIdx = idx ?? (db.prepare(`SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM units WHERE plan_id = ?`).get(plan_id).next);
    db.prepare(
      `INSERT INTO units (id, plan_id, idx, title, goal, created_at, status, approval_required, execution_mode)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(id, plan_id, finalIdx, title, goal, ts, approval_required ? 1 : 0, execution_mode);
    return units.get(id);
  },
  approve(id, { by = 'human' } = {}) {
    const db = getDb();
    db.prepare(
      `UPDATE units SET status = 'active', approved_by = ?, approved_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`
    ).run(by, now(), now(), id);
    return units.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM units WHERE id = ?`).get(id) ?? null;
  },
  list({ plan_id = null, status = null } = {}) {
    const db = getDb();
    const { clause, vals } = buildWhere({ plan_id, status });
    return db.prepare(`SELECT * FROM units ${clause} ORDER BY plan_id, idx`).all(...vals);
  },
  update(id, fields) {
    const db = getDb();
    const allowed = ['title', 'goal', 'status', 'execution_mode'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in fields) {
        sets.push(`${k} = ?`);
        vals.push(fields[k]);
      }
    }
    if (sets.length === 0) return units.get(id);
    vals.push(id);
    db.prepare(`UPDATE units SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return units.get(id);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM units WHERE id = ?`).run(id);
  },
};

// -------- Questions --------
export const questions = {
  create({ plan_id = null, unit_id = null, task_id = null, kind = 'clarification', origin = 'prompt', body, asked_by = 'main' }) {
    const db = getDb();
    const id = newId('Q');
    db.prepare(
      `INSERT INTO questions (id, plan_id, unit_id, task_id, kind, origin, body, asked_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, plan_id, unit_id, task_id, kind, origin, body, asked_by, now());
    return questions.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM questions WHERE id = ?`).get(id) ?? null;
  },
  list({ plan_id = null, unit_id = null, task_id = null, pending = null } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (plan_id) { where.push('plan_id = ?'); vals.push(plan_id); }
    if (unit_id) { where.push('unit_id = ?'); vals.push(unit_id); }
    if (task_id) { where.push('task_id = ?'); vals.push(task_id); }
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

// -------- Tasks --------
export const tasks = {
  /** Resolve user-provided id to canonical TASK-ULID. Accepts either TASK-ULID or ticket_number (e.g. CK-285). Returns null if not found. */
  _resolveId(db, id) {
    if (!id) return null;
    const row = db.prepare(`SELECT id FROM tasks WHERE id = ? OR ticket_number = ?`).get(id, id);
    return row?.id ?? null;
  },

  /** Resolve project key for a task by traversing unit -> plan -> project. */
  _resolveProjectKey(db, unit_id) {
    const row = db.prepare(
      `SELECT p.key FROM projects p
       JOIN plans pl ON pl.project_id = p.id
       JOIN units ph ON ph.plan_id = pl.id
       WHERE ph.id = ?`
    ).get(unit_id);
    return row?.key ?? null;
  },

  /** Generate next ticket number for a project key. */
  _nextTicketNumber(db, projectKey) {
    if (!projectKey) return null;
    const prefix = projectKey + '-';
    const row = db.prepare(
      `SELECT ticket_number FROM tasks
       WHERE ticket_number LIKE ? || '%'
       ORDER BY CAST(SUBSTR(ticket_number, LENGTH(?) + 1) AS INTEGER) DESC
       LIMIT 1`
    ).get(prefix, prefix);
    if (!row) return `${projectKey}-1`;
    const num = parseInt(row.ticket_number.slice(prefix.length), 10);
    return `${projectKey}-${num + 1}`;
  },

  create({ unit_id, title, body = '', assignee = null, idx = null, depends_on = [],
           parent_task_id = null, priority = 'medium', complexity = null, estimated_edits = null,
           cycle_id = null, reporter = null, type = 'task' }) {
    if (!unit_id) {
      throw Object.assign(new Error('unit_id is required'), { status: 400 });
    }
    // Reject tasks under unapproved (draft) plans
    {
      const db0 = getDb();
      const unit = db0.prepare('SELECT * FROM units WHERE id = ?').get(unit_id);
      if (unit) {
        const plan = db0.prepare('SELECT * FROM plans WHERE id = ?').get(unit.plan_id);
        if (plan && plan.status === 'draft') {
          throw Object.assign(new Error(
            `Cannot create tasks under draft plan "${plan.title}" (${plan.id}). Approve it first: clawket plan approve ${plan.id}`
          ), { status: 400 });
        }
      }
    }
    if (!cycle_id) {
      // Auto-resolve: find active cycle for this project via unit → plan → project
      const db0 = getDb();
      const unit = db0.prepare('SELECT * FROM units WHERE id = ?').get(unit_id);
      if (unit) {
        const plan = db0.prepare('SELECT * FROM plans WHERE id = ?').get(unit.plan_id);
        if (plan) {
          const activeCycles = db0.prepare(
            "SELECT * FROM cycles WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC"
          ).all(plan.project_id);
          if (activeCycles.length === 1) {
            cycle_id = activeCycles[0].id;
          } else if (activeCycles.length > 1) {
            throw Object.assign(new Error(
              `Multiple active cycles found. Specify --cycle: ${activeCycles.map(b => b.id).join(', ')}`
            ), { status: 400 });
          }
        }
      }
      // cycle_id is optional — tasks without a cycle go to backlog
    }
    const db = getDb();
    const id = newId('TASK');
    const ts = now();
    const finalIdx = idx ?? (db.prepare(`SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM tasks WHERE unit_id = ?`).get(unit_id).next);

    // Auto-generate ticket_number from project key
    const projectKey = tasks._resolveProjectKey(db, unit_id);
    const ticketNumber = tasks._nextTicketNumber(db, projectKey);

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO tasks (id, unit_id, idx, title, body, created_at, status, assignee,
         ticket_number, parent_task_id, priority, complexity, estimated_edits, cycle_id, reporter, type)
         VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, unit_id, finalIdx, title, body, ts, assignee,
            ticketNumber, parent_task_id, priority, complexity, estimated_edits, cycle_id, reporter, type);
      const insDep = db.prepare(`INSERT INTO task_depends_on (task_id, depends_on_task_id) VALUES (?, ?)`);
      for (const dep of depends_on) insDep.run(id, dep);
    });
    tx();

    return tasks.get(id);
  },
  get(id) {
    const db = getDb();
    const canonical = tasks._resolveId(db, id);
    if (!canonical) return null;
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(canonical);
    if (!row) return null;
    row.depends_on = db.prepare(`SELECT depends_on_task_id FROM task_depends_on WHERE task_id = ?`).all(canonical).map(r => r.depends_on_task_id);
    try {
      row.labels = db.prepare(`SELECT label FROM task_labels WHERE task_id = ?`).all(canonical).map(r => r.label);
    } catch { row.labels = []; }
    return row;
  },
  list({ unit_id = null, plan_id = null, status = null, cycle_id = null, assignee = null, agent_id = null, parent_task_id = undefined } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    let sql = `SELECT s.* FROM tasks s`;
    if (plan_id) {
      sql += ` JOIN units p ON p.id = s.unit_id`;
      where.push('p.plan_id = ?');
      vals.push(plan_id);
    }
    if (unit_id) { where.push('s.unit_id = ?'); vals.push(unit_id); }
    if (status) { where.push('s.status = ?'); vals.push(status); }
    if (cycle_id) { where.push('s.cycle_id = ?'); vals.push(cycle_id); }
    if (assignee) { where.push('s.assignee = ?'); vals.push(assignee); }
    if (agent_id) { where.push('s.agent_id = ?'); vals.push(agent_id); }
    if (parent_task_id !== undefined) {
      if (parent_task_id === null) {
        where.push('s.parent_task_id IS NULL');
      } else {
        where.push('s.parent_task_id = ?');
        vals.push(parent_task_id);
      }
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY s.unit_id, s.idx';
    return db.prepare(sql).all(...vals);
  },
  appendBody(id, text) {
    const db = getDb();
    const canonical = tasks._resolveId(db, id);
    if (!canonical) return null;
    db.prepare(`UPDATE tasks SET body = body || ? WHERE id = ?`).run(text, canonical);
    return tasks.get(canonical);
  },
  update(id, fields) {
    const db = getDb();
    // Resolve to canonical TASK-ULID (accepts either TASK-ULID or ticket_number like CK-285)
    const canonical = tasks._resolveId(db, id);
    if (!canonical) {
      throw Object.assign(new Error(`Task not found: ${id}`), { status: 404 });
    }
    id = canonical;

    const allowed = ['title', 'body', 'status', 'assignee', 'priority', 'complexity', 'estimated_edits', 'parent_task_id', 'cycle_id', 'unit_id', 'reporter', 'type', 'agent_id'];
    const nullable = new Set(['cycle_id', 'parent_task_id', 'assignee', 'agent_id', 'complexity', 'estimated_edits', 'reporter', 'body']);
    const sets = [];
    const vals = [];

    // Capture old values for activity log
    const oldTask = tasks.get(id);

    for (const k of allowed) {
      if (k in fields) {
        let v = fields[k];
        // Normalize empty string to null for nullable FK/text fields (enables detach-to-backlog via CLI)
        if (v === '' && nullable.has(k)) v = null;
        sets.push(`${k} = ?`);
        vals.push(v);
      }
    }
    if ('status' in fields) {
      const VALID_STATUSES = new Set(['todo', 'in_progress', 'done', 'blocked', 'cancelled']);
      if (!VALID_STATUSES.has(fields.status)) {
        throw Object.assign(new Error(`Invalid task status: "${fields.status}". Valid: ${[...VALID_STATUSES].join(', ')}`), { status: 400 });
      }
      if (fields.status === 'in_progress') { sets.push('started_at = COALESCE(started_at, ?)'); vals.push(now()); }
      if (['done', 'cancelled'].includes(fields.status)) { sets.push('completed_at = ?'); vals.push(now()); }
    }
    if (sets.length === 0) return tasks.get(id);
    vals.push(id);
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    // Auto run management
    if ('status' in fields) {
      const sessionId = fields._session_id || null;
      const agent = fields._agent || fields.assignee || 'main';

      if (fields.status === 'in_progress') {
        // Start a new run if none active for this task
        const existing = runs.list({ task_id: id }).find(r => !r.ended_at);
        if (!existing) {
          runs.create({ task_id: id, session_id: sessionId, agent });
        }
      }
      if (['done', 'cancelled'].includes(fields.status)) {
        // Finish all active runs for this task
        const result = fields.status === 'done' ? 'success' : fields.status;
        for (const r of runs.list({ task_id: id })) {
          if (!r.ended_at) {
            runs.finish(r.id, { result, notes: null });
          }
        }
      }
    }

    // Record activity log for tracked fields
    if (oldTask) {
      const actor = fields._agent || fields.assignee || oldTask.assignee || 'system';
      for (const k of ['status', 'assignee', 'priority', 'cycle_id', 'unit_id']) {
        if (k in fields && String(fields[k]) !== String(oldTask[k])) {
          try {
            activityLog.record({
              entity_type: 'task',
              entity_id: id,
              action: k === 'status' ? 'status_change' : 'updated',
              field: k,
              old_value: oldTask[k] != null ? String(oldTask[k]) : null,
              new_value: fields[k] != null ? String(fields[k]) : null,
              actor,
            });
          } catch { /* ignore if activity_log table not yet migrated */ }
        }
      }
    }

    // Enforce: in_progress requires active plan + active cycle
    if ('status' in fields && fields.status === 'in_progress') {
      const updatedTask = tasks.get(id);
      if (updatedTask) {
        // Check plan is active
        const unit = units.get(updatedTask.unit_id);
        if (unit) {
          const plan = plans.get(unit.plan_id);
          if (plan && plan.status !== 'active') {
            throw Object.assign(new Error(
              `Cannot start task: plan "${plan.title}" is ${plan.status}. Approve it first: clawket plan approve ${plan.id}`
            ), { status: 400 });
          }
          // Auto-promote unit: pending → active when a task starts
          if (unit.status === 'pending') {
            units.update(updatedTask.unit_id, { status: 'active' });
          }
        }
        // Check cycle is assigned and active
        if (!updatedTask.cycle_id) {
          throw Object.assign(new Error(
            `Cannot start task: no cycle assigned. Assign to a cycle first: clawket task update ${id} --cycle <CYC-ID>`
          ), { status: 400 });
        }
        const cycle = cycles.get(updatedTask.cycle_id);
        if (cycle && cycle.status !== 'active') {
          throw Object.assign(new Error(
            `Cannot start task: cycle "${cycle.title}" is ${cycle.status}. Activate it first: clawket cycle activate ${cycle.id}`
          ), { status: 400 });
        }
      }
    }

    // Auto-cascade: terminal task → check unit/plan/cycle completion
    if ('status' in fields && TERMINAL_TASK_STATUSES.has(fields.status)) {
      const updatedTask = tasks.get(id);
      if (updatedTask) {
        // Unit auto-complete: all tasks in unit are terminal → unit completed
        if (updatedTask.unit_id) {
          const unitTasks = tasks.list({ unit_id: updatedTask.unit_id });
          if (unitTasks.length > 0 && unitTasks.every(s => TERMINAL_TASK_STATUSES.has(s.status))) {
            const unit = units.get(updatedTask.unit_id);
            if (unit && unit.status !== 'completed') {
              units.update(updatedTask.unit_id, { status: 'completed' });

              // Plan auto-complete: all units in plan are completed → plan completed
              const planUnits = units.list({ plan_id: unit.plan_id });
              if (planUnits.length > 0 && planUnits.every(p => p.status === 'completed')) {
                const plan = plans.get(unit.plan_id);
                if (plan && plan.status === 'active') {
                  plans.update(unit.plan_id, { status: 'completed' });
                }
              }
            }
          }
        }

        // Cycle auto-complete: all tasks in cycle are terminal → cycle completed
        if (updatedTask.cycle_id) {
          const cycleTasks = cycles.tasks(updatedTask.cycle_id);
          if (cycleTasks.length > 0 && cycleTasks.every(s => TERMINAL_TASK_STATUSES.has(s.status))) {
            const cycle = cycles.get(updatedTask.cycle_id);
            if (cycle && cycle.status === 'active') {
              cycles.update(updatedTask.cycle_id, { status: 'completed' });
            }
          }
        }
      }
    }

    return tasks.get(id);
  },
  delete(id) {
    const db = getDb();
    const canonical = tasks._resolveId(db, id);
    if (!canonical) return;
    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(canonical);
  },
  /** Bulk update multiple tasks with the same fields. Returns updated tasks. */
  bulkUpdate(ids, fields) {
    return ids.map(id => tasks.update(id, fields));
  },
  search(query, { limit = 20, mode = 'keyword' } = {}) {
    const db = getDb();

    if (mode === 'keyword' || mode === 'hybrid') {
      // FTS5 keyword search
      const ftsQuery = /[*":()]/.test(query)
        ? query
        : query.split(/\s+/).filter(Boolean).map(t => t + '*').join(' ');
      const ftsResults = db.prepare(
        `SELECT s.* FROM tasks_fts f JOIN tasks s ON s.rowid = f.rowid
         WHERE tasks_fts MATCH ? ORDER BY rank LIMIT ?`
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
        `SELECT task_id, distance FROM vec_tasks
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
      ).all(new Float32Array(queryEmbedding), limit);
      return rows.map(r => {
        const task = tasks.get(r.task_id);
        return task ? { ...task, _distance: r.distance } : null;
      }).filter(Boolean);
    } catch {
      return [];
    }
  },
  /** Store embedding for a task. sqlite-vec vec0 does not support INSERT OR REPLACE — must DELETE then INSERT to update. */
  storeEmbedding(taskId, embedding) {
    const db = getDb();
    const vec = new Float32Array(embedding);
    try {
      db.prepare(`DELETE FROM vec_tasks WHERE task_id = ?`).run(taskId);
      db.prepare(`INSERT INTO vec_tasks (task_id, embedding) VALUES (?, ?)`).run(taskId, vec);
    } catch { /* vec not available */ }
  },
  addLabel(id, label) {
    const db = getDb();
    const canonical = tasks._resolveId(db, id);
    if (!canonical) return null;
    db.prepare(`INSERT OR IGNORE INTO task_labels (task_id, label) VALUES (?, ?)`).run(canonical, label.toLowerCase().trim());
    return tasks.get(canonical);
  },
  removeLabel(id, label) {
    const db = getDb();
    const canonical = tasks._resolveId(db, id);
    if (!canonical) return null;
    db.prepare(`DELETE FROM task_labels WHERE task_id = ? AND label = ?`).run(canonical, label.toLowerCase().trim());
    return tasks.get(canonical);
  },
  listByLabel(label) {
    const db = getDb();
    return db.prepare(
      `SELECT s.* FROM tasks s JOIN task_labels l ON l.task_id = s.id WHERE l.label = ? ORDER BY s.unit_id, s.idx`
    ).all(label.toLowerCase().trim());
  },
};

// -------- Task Relations --------

export const taskRelations = {
  create({ source_task_id, target_task_id, relation_type }) {
    const db = getDb();
    const id = newId('REL');
    const ts = now();
    db.prepare(
      `INSERT INTO task_relations (id, source_task_id, target_task_id, relation_type, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, source_task_id, target_task_id, relation_type, ts);
    return { id, source_task_id, target_task_id, relation_type, created_at: ts };
  },
  list({ task_id = null, relation_type = null } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (task_id) {
      where.push('(source_task_id = ? OR target_task_id = ?)');
      vals.push(task_id, task_id);
    }
    if (relation_type) { where.push('relation_type = ?'); vals.push(relation_type); }
    const sql = `SELECT * FROM task_relations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return db.prepare(sql).all(...vals);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM task_relations WHERE id = ?`).run(id);
  },
};

// -------- Cycles (Sprint — time-boxed iteration, cross-cutting) --------

export const cycles = {
  create({ project_id, title, goal = null, idx = null }) {
    if (!project_id) {
      throw Object.assign(new Error('project_id is required'), { status: 400 });
    }
    const db = getDb();
    const id = newId('CYC');
    const ts = now();
    const finalIdx = idx ?? (db.prepare(`SELECT COALESCE(MAX(idx), -1) + 1 AS next FROM cycles WHERE project_id = ?`).get(project_id).next);
    db.prepare(
      `INSERT INTO cycles (id, project_id, title, goal, idx, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'planning')`
    ).run(id, project_id, title, goal, finalIdx, ts);
    return cycles.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM cycles WHERE id = ?`).get(id) ?? null;
  },
  list({ project_id = null, status = null } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (project_id) { where.push('project_id = ?'); vals.push(project_id); }
    if (status) { where.push('status = ?'); vals.push(status); }
    const sql = `SELECT * FROM cycles ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY idx`;
    return db.prepare(sql).all(...vals);
  },
  update(id, fields) {
    const db = getDb();
    if ('status' in fields) {
      const VALID = new Set(['planning', 'active', 'completed']);
      if (!VALID.has(fields.status)) {
        throw Object.assign(new Error(`Invalid cycle status: "${fields.status}". Valid: ${[...VALID].join(', ')}`), { status: 400 });
      }
    }
    const allowed = ['title', 'goal', 'status'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = ?`); vals.push(fields[k]); }
    }
    if ('status' in fields) {
      // Completed cycles cannot be restarted — create a new cycle instead
      const currentCycle = cycles.get(id);
      if (currentCycle && currentCycle.status === 'completed' && fields.status !== 'completed') {
        throw Object.assign(new Error(
          `Cycle "${currentCycle.title}" is completed and cannot be restarted. Create a new cycle instead.`
        ), { status: 400 });
      }
      if (fields.status === 'active') { sets.push('started_at = COALESCE(started_at, ?)'); vals.push(now()); }
      if (fields.status === 'completed') { sets.push('ended_at = ?'); vals.push(now()); }
    }
    if (sets.length === 0) return cycles.get(id);
    vals.push(id);
    db.prepare(`UPDATE cycles SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return cycles.get(id);
  },
  delete(id) {
    // Unassign tasks from this cycle before deleting
    getDb().prepare(`UPDATE tasks SET cycle_id = NULL WHERE cycle_id = ?`).run(id);
    getDb().prepare(`DELETE FROM cycles WHERE id = ?`).run(id);
  },
  /** List tasks assigned to this cycle. */
  tasks(id) {
    return getDb().prepare(`SELECT * FROM tasks WHERE cycle_id = ? ORDER BY idx`).all(id);
  },
  /** List backlog tasks (not assigned to any cycle) for a project. */
  backlog(project_id) {
    return getDb().prepare(
      `SELECT s.* FROM tasks s
       JOIN units ph ON ph.id = s.unit_id
       JOIN plans pl ON pl.id = ph.plan_id
       WHERE pl.project_id = ? AND s.cycle_id IS NULL
       ORDER BY s.created_at`
    ).all(project_id);
  },
};

// -------- Task Comments --------
export const taskComments = {
  create({ task_id, author, body }) {
    const db = getDb();
    const id = newId('CMT');
    const ts = now();
    db.prepare(
      `INSERT INTO task_comments (id, task_id, author, body, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, task_id, author, body, ts);
    return taskComments.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM task_comments WHERE id = ?`).get(id) ?? null;
  },
  list({ task_id }) {
    return getDb().prepare(
      `SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC`
    ).all(task_id);
  },
  delete(id) {
    getDb().prepare(`DELETE FROM task_comments WHERE id = ?`).run(id);
  },
};

// -------- Artifacts --------
export const artifacts = {
  create({ task_id = null, unit_id = null, plan_id = null, type, title, content = '', content_format = 'md', parent_id = null, scope = 'reference' }) {
    const db = getDb();
    const id = newId('ART');
    const ts = now();
    db.prepare(
      `INSERT INTO artifacts (id, task_id, unit_id, plan_id, type, title, content, content_format, created_at, parent_id, scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, task_id, unit_id, plan_id, type, title, content, content_format, ts, parent_id, scope);
    return artifacts.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) ?? null;
  },
  list({ task_id = null, unit_id = null, plan_id = null, type = null } = {}) {
    const db = getDb();
    const where = [];
    const vals = [];
    if (task_id) { where.push('task_id = ?'); vals.push(task_id); }
    if (unit_id) { where.push('unit_id = ?'); vals.push(unit_id); }
    if (plan_id) { where.push('plan_id = ?'); vals.push(plan_id); }
    if (type) { where.push('type = ?'); vals.push(type); }
    const sql = `SELECT * FROM artifacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return db.prepare(sql).all(...vals);
  },
  storeEmbedding(artifactId, embedding) {
    const db = getDb();
    const vec = new Float32Array(embedding);
    try {
      db.prepare(`DELETE FROM vec_artifacts WHERE artifact_id = ?`).run(artifactId);
      db.prepare(`INSERT INTO vec_artifacts (artifact_id, embedding) VALUES (?, ?)`).run(artifactId, vec);
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
  create({ task_id, session_id = null, agent = 'main' }) {
    const db = getDb();
    const id = newId('RUN');
    db.prepare(
      `INSERT INTO runs (id, task_id, session_id, agent, started_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, task_id, session_id, agent, now());
    return runs.get(id);
  },
  get(id) {
    return getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) ?? null;
  },
  list({ task_id = null, session_id = null, project_id = null } = {}) {
    const db = getDb();
    if (project_id) {
      // Join through tasks → units → plans to filter by project
      const sql = `SELECT r.* FROM runs r
        JOIN tasks s ON r.task_id = s.id
        JOIN units ph ON s.unit_id = ph.id
        JOIN plans pl ON ph.plan_id = pl.id
        WHERE pl.project_id = ?
        ORDER BY r.started_at DESC`;
      return db.prepare(sql).all(project_id);
    }
    const where = [];
    const vals = [];
    if (task_id) { where.push('task_id = ?'); vals.push(task_id); }
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
   * Unified timeline for a project — aggregates activity_log, task_comments,
   * artifacts, runs, and questions into a single chronological feed.
   */
  list({ project_id, limit = 100, offset = 0, types = null }) {
    const db = getDb();
    const typeSet = types ? new Set(types.split(',').map(t => t.trim())) : null;

    const parts = [];
    const allVals = [];

    // 1) activity_log → tasks → units → plans → project
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
        LEFT JOIN tasks s ON al.entity_type = 'task' AND al.entity_id = s.id
        LEFT JOIN units ph ON s.unit_id = ph.id
        LEFT JOIN plans pl ON ph.plan_id = pl.id
        WHERE pl.project_id = ?
      `);
      allVals.push(project_id);
    }

    // 2) task_comments
    if (!typeSet || typeSet.has('comment')) {
      parts.push(`
        SELECT
          cmt.id,
          'comment' AS event_type,
          'task' AS entity_type,
          cmt.task_id AS entity_id,
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
        FROM task_comments cmt
        JOIN tasks s ON cmt.task_id = s.id
        JOIN units ph ON s.unit_id = ph.id
        JOIN plans pl ON ph.plan_id = pl.id
        WHERE pl.project_id = ?
      `);
      allVals.push(project_id);
    }

    // 3) artifacts (task/unit/plan level)
    if (!typeSet || typeSet.has('artifact')) {
      parts.push(`
        SELECT
          art.id,
          'artifact' AS event_type,
          'task' AS entity_type,
          COALESCE(art.task_id, art.unit_id, art.plan_id) AS entity_id,
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
        LEFT JOIN tasks s ON art.task_id = s.id
        LEFT JOIN units ph ON s.unit_id = ph.id
        LEFT JOIN plans pl ON ph.plan_id = pl.id
        LEFT JOIN units ph2 ON art.unit_id = ph2.id
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
          'task' AS entity_type,
          r.task_id AS entity_id,
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
        JOIN tasks s ON r.task_id = s.id
        JOIN units ph ON s.unit_id = ph.id
        JOIN plans pl ON ph.plan_id = pl.id
        WHERE pl.project_id = ?
      `);
      allVals.push(project_id);

      parts.push(`
        SELECT
          r.id || ':end' AS id,
          'run_end' AS event_type,
          'task' AS entity_type,
          r.task_id AS entity_id,
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
        JOIN tasks s ON r.task_id = s.id
        JOIN units ph ON s.unit_id = ph.id
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
            WHEN q.task_id IS NOT NULL THEN 'task'
            WHEN q.unit_id IS NOT NULL THEN 'unit'
            ELSE 'plan'
          END AS entity_type,
          COALESCE(q.task_id, q.unit_id, q.plan_id) AS entity_id,
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
        LEFT JOIN tasks s ON q.task_id = s.id
        LEFT JOIN units ph ON s.unit_id = ph.id
        LEFT JOIN plans pl ON ph.plan_id = pl.id
        LEFT JOIN units ph2 ON q.unit_id = ph2.id
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