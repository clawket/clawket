import { createServer } from 'node:http';
import { writeFileSync, unlinkSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, extname, basename } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getRequestListener, serve } from '@hono/node-server';

import { paths, ensureDirs } from './paths.js';
import { getDb, closeDb } from './db.js';
import { projects, plans, units, tasks, cycles, artifacts, runs, questions, taskComments, artifactVersions, activityLog, taskRelations, timeline } from './repo.js';
import { importPlanFile } from './import-plan.js';
import { formatOutput } from './format.js';

const VERSION = (() => {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(new URL('.', import.meta.url).pathname, '..', '..');
    const pkg = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
})();

// Background backfill: embed tasks that have no vec_tasks row (runs once on startup after server is listening).
async function backfillMissingEmbeddings() {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT s.id, s.title, s.body FROM tasks s
      WHERE NOT EXISTS (SELECT 1 FROM vec_tasks v WHERE v.task_id = s.id)
    `).all();
    if (rows.length === 0) return;
    process.stderr.write(`[clawket] Backfilling embeddings for ${rows.length} tasks...\n`);
    const { embed } = await import('./embeddings.js');
    let done = 0, failed = 0;
    for (const row of rows) {
      try {
        const vec = await embed(`${row.title}\n${row.body || ''}`);
        if (vec) { tasks.storeEmbedding(row.id, Array.from(vec)); done++; }
        else failed++;
      } catch { failed++; }
    }
    process.stderr.write(`[clawket] Backfill complete: ${done} embedded, ${failed} failed\n`);
  } catch (err) {
    process.stderr.write(`[clawket] Backfill error: ${err.message}\n`);
  }
}

export function startServer() {
  ensureDirs();
  getDb();

  if (existsSync(paths.socket)) {
    try { unlinkSync(paths.socket); } catch {}
  }

  const startTime = Date.now();
  const app = new Hono();

  function jsonOr404(c, entity) {
    if (!entity) return c.json({ error: 'not found' }, 404);
    return c.json(entity);
  }

  // SSE event bus for real-time updates
  const sseClients = new Set();

  function broadcastEvent(event, data) {
    for (const client of sseClients) {
      try { client({ event, data }); } catch { sseClients.delete(client); }
    }
  }

  app.get('/events', (c) => {
    return streamSSE(c, async (stream) => {
      const send = ({ event, data }) => {
        stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      sseClients.add(send);

      // Keep alive
      const keepAlive = setInterval(() => {
        try { stream.writeSSE({ event: 'ping', data: '' }); }
        catch { clearInterval(keepAlive); sseClients.delete(send); }
      }, 30000);

      stream.onAbort(() => {
        clearInterval(keepAlive);
        sseClients.delete(send);
      });

      // Block until client disconnects
      await new Promise(() => {});
    });
  });

  app.onError((err, c) => {
    const status = err.status || 500;
    return c.json({ error: err.message, stack: process.env.CLAWKET_DEBUG ? err.stack : undefined }, status);
  });

  // ========== Health ==========
  app.get('/health', (c) =>
    c.json({ ok: true, version: VERSION, pid: process.pid, uptime_ms: Date.now() - startTime })
  );

  // ========== Projects ==========
  app.get('/projects', (c) => c.json(projects.list()));
  app.post('/projects', async (c) => c.json(projects.create(await c.req.json())));
  app.get('/projects/:id', (c) => {
    const id = c.req.param('id');
    const p = id.startsWith('PROJ-') ? projects.get(id) : projects.getByName(id);
    return jsonOr404(c, p);
  });
  app.patch('/projects/:id', async (c) => c.json(projects.update(c.req.param('id'), await c.req.json())));
  app.delete('/projects/:id', (c) => {
    projects.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });
  app.post('/projects/:id/cwds', async (c) => {
    const { cwd } = await c.req.json();
    return c.json(projects.addCwd(c.req.param('id'), cwd));
  });
  app.delete('/projects/:id/cwds', async (c) => {
    const { cwd } = await c.req.json();
    return c.json(projects.removeCwd(c.req.param('id'), cwd));
  });
  app.get('/projects/by-cwd/:cwd{.+}', (c) => {
    const cwd = decodeURIComponent(c.req.param('cwd'));
    const p = projects.getByCwd(cwd);
    return jsonOr404(c, p);
  });

  // ========== Project Timeline ==========
  app.get('/projects/:id/timeline', (c) => {
    const q = c.req.query();
    return c.json(timeline.list({
      project_id: c.req.param('id'),
      limit: q.limit ? parseInt(q.limit) : 100,
      offset: q.offset ? parseInt(q.offset) : 0,
      types: q.types || null,
    }));
  });

  // ========== Plans ==========
  app.get('/plans', (c) => {
    const q = c.req.query();
    return c.json(plans.list({ project_id: q.project_id || null, status: q.status || null }));
  });
  app.post('/plans', async (c) => c.json(plans.create(await c.req.json())));
  app.get('/plans/:id', (c) => jsonOr404(c, plans.get(c.req.param('id'))));
  app.patch('/plans/:id', async (c) => {
    const body = await c.req.json();
    // Block draft→active without approval (use POST /plans/:id/approve instead)
    if (body.status === 'active') {
      const existing = plans.get(c.req.param('id'));
      if (existing && existing.status === 'draft') {
        return c.json({ error: 'Use POST /plans/:id/approve to activate a draft plan' }, 400);
      }
    }
    const r = plans.update(c.req.param('id'), body);
    broadcastEvent('plan:updated', { id: c.req.param('id') });
    return c.json(r);
  });
  app.post('/plans/:id/approve', async (c) => {
    const plan = plans.get(c.req.param('id'));
    if (!plan) return c.json({ error: 'not found' }, 404);
    if (plan.status !== 'draft') return c.json({ error: 'Only draft plans can be approved' }, 400);
    const r = plans.update(c.req.param('id'), { status: 'active', approved_at: Date.now() });
    broadcastEvent('plan:updated', { id: c.req.param('id') });
    return c.json(r);
  });
  app.delete('/plans/:id', (c) => {
    plans.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });
  app.post('/plans/import', async (c) => {
    const body = await c.req.json();
    const result = importPlanFile(body.file, {
      projectName: body.project || null,
      cwd: body.cwd || null,
      source: body.source || 'import',
      dryRun: body.dryRun === true,
    });
    return c.json(result);
  });

  // ========== Units ==========
  app.get('/units', (c) => {
    const q = c.req.query();
    return c.json(units.list({ plan_id: q.plan_id || null, status: q.status || null }));
  });
  app.post('/units', async (c) => c.json(units.create(await c.req.json())));
  app.get('/units/:id', (c) => jsonOr404(c, units.get(c.req.param('id'))));
  app.patch('/units/:id', async (c) => { const r = units.update(c.req.param('id'), await c.req.json()); broadcastEvent('unit:updated', { id: c.req.param('id') }); return c.json(r); });
  app.delete('/units/:id', (c) => {
    units.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });
  app.post('/units/:id/approve', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(units.approve(c.req.param('id'), { by: body.by || 'human' }));
  });
  app.get('/units/:id/events', (c) => {
    const id = c.req.param('id');
    const timeoutSec = Number(c.req.query('timeout') || 600);
    const intervalMs = Number(c.req.query('interval') || 1000);
    const deadline = Date.now() + timeoutSec * 1000;

    return streamSSE(c, async (stream) => {
      const initial = units.get(id);
      if (!initial) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'not found', id }) });
        return;
      }
      if (initial.approved_at) {
        await stream.writeSSE({
          event: 'approved',
          data: JSON.stringify({ id, approved_by: initial.approved_by, approved_at: initial.approved_at }),
        });
        return;
      }
      await stream.writeSSE({ event: 'waiting', data: JSON.stringify({ id, timeout_sec: timeoutSec }) });
      while (Date.now() < deadline) {
        if (stream.aborted) return;
        const p = units.get(id);
        if (p?.approved_at) {
          await stream.writeSSE({
            event: 'approved',
            data: JSON.stringify({ id, approved_by: p.approved_by, approved_at: p.approved_at }),
          });
          return;
        }
        await stream.sleep(intervalMs);
      }
      await stream.writeSSE({ event: 'timeout', data: JSON.stringify({ id }) });
    });
  });

  // ========== Tasks ==========
  app.get('/tasks', (c) => {
    const q = c.req.query();
    return c.json(tasks.list({
      unit_id: q.unit_id || null,
      plan_id: q.plan_id || null,
      status: q.status || null,
      assignee: q.assignee || null,
      agent_id: q.agent_id || null,
      cycle_id: q.cycle_id || null,
      parent_task_id: q.parent_task_id !== undefined ? (q.parent_task_id || null) : undefined,
    }));
  });
  app.post('/tasks', async (c) => {
    const body = await c.req.json();

    // Auto-infer unit_id if not provided (first non-completed unit of active plan)
    if (!body.unit_id && body.cwd) {
      const proj = projects.getByCwd(body.cwd);
      if (proj) {
        const planList = plans.list({ project_id: proj.id, status: 'active' });
        const plan = planList[0] || plans.list({ project_id: proj.id })[0];
        if (plan) {
          const unitList = units.list({ plan_id: plan.id });
          const unit = unitList.find(p => p.status !== 'completed') || unitList[0];
          if (unit) body.unit_id = unit.id;
        }
      }
    }

    // Auto-infer cycle_id if not provided (first active cycle of project)
    if (!body.cycle_id && body.cwd) {
      const proj = projects.getByCwd(body.cwd);
      if (proj) {
        const cycleList = cycles.list({ project_id: proj.id });
        const cycle = cycleList.find(b => b.status === 'active') || cycleList.find(b => b.status !== 'completed');
        if (cycle) body.cycle_id = cycle.id;
      }
    }

    delete body.cwd; // Don't pass cwd to create
    const result = tasks.create(body);
    if (result && result.title) {
      import('./embeddings.js').then(({ embed }) =>
        embed(`${result.title}\n${result.body || ''}`).then(vec => { if (vec) tasks.storeEmbedding(result.id, Array.from(vec)); })
      ).catch(() => {});
    }
    broadcastEvent('task:created', { id: result.id });
    return c.json(result);
  });
  app.get('/tasks/search', async (c) => {
    const query = c.req.query('q') || '';
    const limit = Number(c.req.query('limit') || 20);
    const mode = c.req.query('mode') || 'keyword'; // keyword | semantic | hybrid

    if (mode === 'semantic' || mode === 'hybrid') {
      try {
        const { embed } = await import('./embeddings.js');
        const queryEmbedding = await embed(query);
        if (queryEmbedding) {
          const vecResults = tasks.vectorSearch(Array.from(queryEmbedding), { limit });
          if (mode === 'semantic') return c.json(vecResults);

          // Hybrid: merge FTS + vector, deduplicate by ID
          const ftsResults = tasks.search(query, { limit, mode: 'keyword' });
          const seen = new Set();
          const merged = [];
          for (const s of [...ftsResults, ...vecResults]) {
            if (!seen.has(s.id)) { seen.add(s.id); merged.push(s); }
          }
          return c.json(merged.slice(0, limit));
        }
      } catch {
        // Fallback to keyword if vector search fails
      }
    }

    return c.json(tasks.search(query, { limit, mode: 'keyword' }));
  });
  app.get('/tasks/:id', (c) => jsonOr404(c, tasks.get(c.req.param('id'))));
  app.patch('/tasks/:id', async (c) => {
    const body = await c.req.json();
    const result = tasks.update(c.req.param('id'), body);
    if (result && (body.title !== undefined || body.body !== undefined)) {
      import('./embeddings.js').then(({ embed }) =>
        embed(`${result.title}\n${result.body || ''}`).then(vec => { if (vec) tasks.storeEmbedding(result.id, Array.from(vec)); })
      ).catch(() => {});
    }
    broadcastEvent('task:updated', { id: c.req.param('id') });
    return c.json(result);
  });
  app.delete('/tasks/:id', async (c) => {
    const rawId = c.req.param('id');
    const task = tasks.get(rawId);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const id = task.id; // canonical TASK-ULID

    // Only todo tasks under draft plans can be hard-deleted
    if (task.status === 'todo') {
      const unit = units.get(task.unit_id);
      const plan = unit ? plans.get(unit.plan_id) : null;
      if (plan && plan.status === 'draft') {
        tasks.delete(id);
        broadcastEvent('task:deleted', { id });
        return c.json({ deleted: id });
      }
    }

    // Otherwise: soft delete (cancelled + comment)
    const body = await c.req.json().catch(() => ({}));
    const reason = body.reason || 'Cancelled via delete';
    const result = tasks.update(id, { status: 'cancelled' });
    taskComments.create({ task_id: id, author: 'system', body: `[Cancelled] ${reason}` });
    broadcastEvent('task:updated', { id });
    return c.json(result);
  });
  // Bulk update tasks
  app.post('/tasks/bulk-update', async (c) => {
    const { ids, fields } = await c.req.json();
    if (!ids || !Array.isArray(ids)) return c.json({ error: 'ids array required' }, 400);
    return c.json(tasks.bulkUpdate(ids, fields));
  });

  app.post('/tasks/:id/body', async (c) => {
    const { text } = await c.req.json();
    return c.json(tasks.appendBody(c.req.param('id'), '\n' + text));
  });

  // Helper: resolve CK-XXX ticket_number or TASK-ULID to canonical TASK-ULID
  const resolveTaskId = (id) => tasks._resolveId(getDb(), id) || id;

  // ========== Task Comments ==========
  app.get('/tasks/:id/comments', (c) => {
    return c.json(taskComments.list({ task_id: resolveTaskId(c.req.param('id')) }));
  });
  app.post('/tasks/:id/comments', async (c) => {
    const body = await c.req.json();
    return c.json(taskComments.create({
      task_id: resolveTaskId(c.req.param('id')),
      author: body.author,
      body: body.body,
    }));
  });
  app.delete('/comments/:id', (c) => {
    taskComments.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });

  // ========== Task Labels ==========
  app.post('/tasks/:id/labels', async (c) => {
    const body = await c.req.json();
    return c.json(tasks.addLabel(c.req.param('id'), body.label));
  });
  app.delete('/tasks/:id/labels/:label', (c) => {
    return c.json(tasks.removeLabel(c.req.param('id'), c.req.param('label')));
  });
  app.get('/labels/:label/tasks', (c) => {
    return c.json(tasks.listByLabel(c.req.param('label')));
  });

  // ========== Activity Log ==========
  app.get('/activity', (c) => {
    const q = c.req.query();
    return c.json(activityLog.list({
      entity_type: q.entity_type || null,
      entity_id: q.entity_id || null,
      limit: q.limit ? parseInt(q.limit) : 50,
    }));
  });

  app.post('/activity', async (c) => {
    const body = await c.req.json();
    return c.json(activityLog.record(body));
  });

  // ========== Task Relations ==========
  app.get('/tasks/:id/relations', (c) => {
    return c.json(taskRelations.list({ task_id: resolveTaskId(c.req.param('id')) }));
  });
  app.post('/tasks/:id/relations', async (c) => {
    const body = await c.req.json();
    return c.json(taskRelations.create({
      source_task_id: resolveTaskId(c.req.param('id')),
      target_task_id: resolveTaskId(body.target_task_id),
      relation_type: body.relation_type,
    }));
  });
  app.delete('/relations/:id', (c) => {
    taskRelations.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });

  // ========== Task Similarity ==========
  // Seed-task vector search: embed source task's title+body, return nearest neighbors.
  // Source task itself is excluded from results.
  app.get('/tasks/:id/similar', async (c) => {
    const rawId = c.req.param('id');
    const canonical = resolveTaskId(rawId);
    const task = tasks.get(canonical);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const limit = Math.min(Number(c.req.query('limit') || 10), 30);
    const statusFilter = c.req.query('status'); // optional single status
    try {
      const { embed } = await import('./embeddings.js');
      const vec = await embed(`${task.title}\n${task.body || ''}`);
      if (!vec) return c.json([]);
      // over-fetch to compensate for self-exclusion and status filtering
      const results = tasks.vectorSearch(Array.from(vec), { limit: limit + 5 });
      const filtered = results
        .filter(t => t.id !== task.id)
        .filter(t => !statusFilter || t.status === statusFilter)
        .slice(0, limit);
      return c.json(filtered);
    } catch {
      return c.json([]);
    }
  });

  // ========== Cycles ==========
  app.get('/cycles', (c) => {
    const q = c.req.query();
    return c.json(cycles.list({ project_id: q.project_id || null, status: q.status || null }));
  });
  app.post('/cycles', async (c) => c.json(cycles.create(await c.req.json())));
  app.get('/cycles/:id', (c) => jsonOr404(c, cycles.get(c.req.param('id'))));
  app.patch('/cycles/:id', async (c) => {
    const body = await c.req.json();
    // Block planning→active without approval
    if (body.status === 'active') {
      const existing = cycles.get(c.req.param('id'));
      if (existing && existing.status === 'planning') {
        return c.json({ error: 'Use POST /cycles/:id/activate to start a planning cycle' }, 400);
      }
    }
    const r = cycles.update(c.req.param('id'), body);
    broadcastEvent('cycle:updated', { id: c.req.param('id') });
    return c.json(r);
  });
  app.post('/cycles/:id/activate', async (c) => {
    const cycle = cycles.get(c.req.param('id'));
    if (!cycle) return c.json({ error: 'not found' }, 404);
    if (cycle.status !== 'planning') return c.json({ error: 'Only planning cycles can be activated' }, 400);
    const r = cycles.update(c.req.param('id'), { status: 'active', started_at: Date.now() });
    broadcastEvent('cycle:updated', { id: c.req.param('id') });
    return c.json(r);
  });
  app.delete('/cycles/:id', (c) => {
    cycles.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });
  app.get('/cycles/:id/tasks', (c) => {
    return c.json(cycles.tasks(c.req.param('id')));
  });

  // ========== Backlog (tasks with no cycle) ==========
  app.get('/backlog', (c) => {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: 'project_id query param required' }, 400);
    return c.json(cycles.backlog(projectId));
  });

  // ========== Artifacts ==========
  app.get('/artifacts', (c) => {
    const q = c.req.query();
    return c.json(artifacts.list({
      task_id: q.task_id || null,
      unit_id: q.unit_id || null,
      plan_id: q.plan_id || null,
      type: q.type || null,
    }));
  });
  app.post('/artifacts', async (c) => {
    const art = artifacts.create(await c.req.json());
    // Auto-embed if scope=rag
    if (art.scope === 'rag' && art.content) {
      import('./embeddings.js').then(({ embed }) =>
        embed(`${art.title}\n${art.content}`).then(vec => { if (vec) artifacts.storeEmbedding(art.id, Array.from(vec)); })
      ).catch(() => {});
    }
    return c.json(art);
  });
  app.get('/artifacts/search', async (c) => {
    const query = c.req.query('q') || '';
    const limit = Number(c.req.query('limit') || 20);
    const mode = c.req.query('mode') || 'hybrid';
    const scope = c.req.query('scope') || 'rag';

    if (mode === 'semantic' || mode === 'hybrid') {
      try {
        const { embed } = await import('./embeddings.js');
        const queryEmbedding = await embed(query);
        if (queryEmbedding) {
          const vecResults = artifacts.vectorSearch(Array.from(queryEmbedding), { limit, scope });
          if (mode === 'semantic') return c.json(vecResults);

          // Hybrid: FTS on artifacts_fts + vector
          const ftsResults = (() => {
            try {
              return getDb().prepare(
                `SELECT a.* FROM artifacts a JOIN artifacts_fts f ON a.id = f.rowid
                 WHERE artifacts_fts MATCH ? AND a.scope = ? ORDER BY rank LIMIT ?`
              ).all(query, scope, limit);
            } catch { return []; }
          })();
          const seen = new Set();
          const merged = [];
          for (const a of [...ftsResults, ...vecResults]) {
            if (!seen.has(a.id)) { seen.add(a.id); merged.push(a); }
          }
          return c.json(merged.slice(0, limit));
        }
      } catch {}
    }

    // Keyword-only fallback
    try {
      const results = getDb().prepare(
        `SELECT a.* FROM artifacts a JOIN artifacts_fts f ON a.id = f.rowid
         WHERE artifacts_fts MATCH ? AND a.scope = ? ORDER BY rank LIMIT ?`
      ).all(query, scope, limit);
      return c.json(results);
    } catch {
      return c.json([]);
    }
  });
  app.get('/artifacts/:id', (c) => jsonOr404(c, artifacts.get(c.req.param('id'))));
  app.patch('/artifacts/:id', async (c) => {
    const body = await c.req.json();
    const result = artifacts.update(c.req.param('id'), body);
    // Re-embed if scope=rag and either content changed or scope was promoted to rag.
    // body.scope === 'rag' covers both promotion (reference→rag) and idempotent re-tag;
    // storeEmbedding uses INSERT OR REPLACE so redundant runs are safe.
    if (result && result.scope === 'rag' && (body.content !== undefined || body.scope === 'rag')) {
      import('./embeddings.js').then(({ embed }) =>
        embed(`${result.title}\n${result.content}`).then(vec => { if (vec) artifacts.storeEmbedding(result.id, Array.from(vec)); })
      ).catch(() => {});
    }
    return jsonOr404(c, result);
  });
  app.delete('/artifacts/:id', (c) => {
    artifacts.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });

  // ========== Artifact Import (wiki paths → Artifact) ==========
  app.post('/artifacts/import', async (c) => {
    const { cwd, plan_id = null, unit_id = null, scope = 'reference', dry_run = false, project_id = null } = await c.req.json();
    if (!cwd || !existsSync(cwd)) return c.json({ error: 'cwd required' }, 400);

    const MD_EXTS = new Set(['.md', '.mdx']);
    const MAX_SIZE = 512 * 1024;
    const imported = [];
    const skipped = [];

    // Get existing artifact titles to avoid duplicates
    const existing = new Set(
      artifacts.list({ plan_id, unit_id }).map(a => a.title)
    );

    function scanDir(dir, depth = 0) {
      if (depth > 3) return;
      try {
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith('.') || entry === 'node_modules') continue;
          const full = join(dir, entry);
          try {
            const stat = statSync(full);
            if (stat.isDirectory()) {
              scanDir(full, depth + 1);
            } else if (MD_EXTS.has(extname(entry).toLowerCase()) && stat.size < MAX_SIZE) {
              const content = readFileSync(full, 'utf-8');
              const headingMatch = content.match(/^#\s+(.+)$/m);
              const title = headingMatch ? headingMatch[1].trim() : basename(entry, extname(entry));
              const relPath = relative(cwd, full);

              if (existing.has(title)) {
                skipped.push({ path: relPath, title, reason: 'duplicate' });
                continue;
              }

              if (!dry_run) {
                const art = artifacts.create({
                  plan_id, unit_id,
                  type: 'document',
                  title,
                  content,
                  content_format: extname(entry) === '.mdx' ? 'mdx' : 'md',
                  scope,
                });
                imported.push({ id: art.id, path: relPath, title });
              } else {
                imported.push({ path: relPath, title });
              }
              existing.add(title);
            }
          } catch { /* skip */ }
        }
      } catch { /* dir not readable */ }
    }

    const importProject = project_id ? projects.get(project_id) : null;
    const importWikiPaths = importProject?.wiki_paths || ['docs'];
    for (const wp of importWikiPaths) {
      const wikiDir = wp.startsWith('/') ? wp : join(cwd, wp);
      if (existsSync(wikiDir)) scanDir(wikiDir);
    }

    return c.json({ imported: imported.length, skipped: skipped.length, items: imported, skippedItems: skipped, dry_run });
  });

  // ========== Artifact Export (Artifact → docs/) ==========
  app.post('/artifacts/export', async (c) => {
    const { cwd, plan_id = null, unit_id = null, project_id = null } = await c.req.json();
    if (!cwd) return c.json({ error: 'cwd required' }, 400);

    const exportProject = project_id ? projects.get(project_id) : null;
    const exportPath = exportProject?.wiki_paths?.[0] || 'docs';
    const docsDir = exportPath.startsWith('/') ? exportPath : join(cwd, exportPath);
    const { mkdirSync, writeFileSync: writeFS } = require('fs');
    mkdirSync(docsDir, { recursive: true });

    const allArtifacts = artifacts.list({ plan_id, unit_id });
    const exported = [];

    for (const art of allArtifacts) {
      if (!art.content) continue;
      const slug = art.title.replace(/[^a-zA-Z0-9가-힣\s-]/g, '').replace(/\s+/g, '-').toLowerCase();
      const ext = art.content_format === 'json' ? '.json' : art.content_format === 'yaml' ? '.yaml' : '.md';
      const filePath = join(docsDir, `${slug}${ext}`);
      writeFS(filePath, art.content, 'utf-8');
      exported.push({ id: art.id, title: art.title, path: relative(cwd, filePath) });
    }

    return c.json({ exported: exported.length, items: exported });
  });

  // ========== Artifact Versions ==========
  app.get('/artifacts/:id/versions', (c) => {
    return c.json(artifactVersions.list({ artifact_id: c.req.param('id') }));
  });
  app.post('/artifacts/:id/versions', async (c) => {
    const body = await c.req.json();
    return c.json(artifactVersions.create({
      artifact_id: c.req.param('id'),
      content: body.content || null,
      content_format: body.content_format || null,
      created_by: body.created_by || null,
    }));
  });

  // ========== Runs ==========
  app.get('/runs', (c) => {
    const q = c.req.query();
    return c.json(runs.list({ task_id: q.task_id || null, session_id: q.session_id || null, project_id: q.project_id || null }));
  });
  app.post('/runs', async (c) => c.json(runs.create(await c.req.json())));
  app.get('/runs/:id', (c) => jsonOr404(c, runs.get(c.req.param('id'))));
  app.post('/runs/:id/finish', async (c) => {
    const body = await c.req.json();
    return c.json(runs.finish(c.req.param('id'), { result: body.result, notes: body.notes || null }));
  });

  // ========== Questions ==========
  app.get('/questions', (c) => {
    const q = c.req.query();
    const pending = q.pending === 'true' ? true : q.pending === 'false' ? false : null;
    return c.json(questions.list({
      plan_id: q.plan_id || null,
      unit_id: q.unit_id || null,
      task_id: q.task_id || null,
      pending,
    }));
  });
  app.post('/questions', async (c) => c.json(questions.create(await c.req.json())));
  app.get('/questions/:id', (c) => jsonOr404(c, questions.get(c.req.param('id'))));
  app.post('/questions/:id/answer', async (c) => {
    const body = await c.req.json();
    return c.json(questions.answer(c.req.param('id'), {
      answer: body.answer,
      answered_by: body.answered_by || 'human',
    }));
  });

  // ========== Agents (distinct agent names from runs) ==========
  app.get('/agents', (c) => {
    const db = getDb();
    const rows = db.prepare(
      `SELECT DISTINCT agent FROM runs WHERE agent IS NOT NULL ORDER BY agent`
    ).all();
    return c.json(rows.map(r => r.agent));
  });

  // ========== Web Dashboard (static file serving) ==========
  const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
    '.ico': 'image/x-icon',
  };

  // Resolve web directory: prefer web/dist (dev build), fallback to daemon/web (plugin bundle)
  const DAEMON_ROOT = join(import.meta.dirname, '..');
  const WEB_DIR_CANDIDATES = [
    join(DAEMON_ROOT, '..', 'web', 'dist'),      // dev: clawket/web/dist/
    join(DAEMON_ROOT, 'web'),                    // plugin bundle: daemon/web/
  ];
  const WEB_DIR = WEB_DIR_CANDIDATES.find(d => existsSync(join(d, 'index.html'))) || WEB_DIR_CANDIDATES[0];

  function serveStaticFile(c, filePath) {
    if (!existsSync(filePath)) return null;
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const content = readFileSync(filePath);
    return c.body(content, 200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
  }

  function dashboardNotBuiltHtml() {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Clawket</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;padding:40px;max-width:640px;margin:0 auto;line-height:1.6}h1{color:#58a6ff;font-size:20px;margin-bottom:16px}code{background:#161b22;padding:2px 6px;border-radius:4px;font-size:13px}pre{background:#161b22;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px}</style>
</head><body>
<h1>Clawket dashboard not built</h1>
<p>The daemon is running but <code>web/dist/index.html</code> was not found.</p>
<p>Build the React dashboard from the repo root:</p>
<pre>cd web &amp;&amp; pnpm install &amp;&amp; pnpm build</pre>
<p>API is available at <code>/projects</code>, <code>/plans</code>, <code>/units</code>, <code>/tasks</code>, <code>/cycles</code>.</p>
</body></html>`;
  }

  // Serve static assets (JS, CSS, SVG, etc.)
  app.get('/assets/*', (c) => {
    const assetPath = join(WEB_DIR, c.req.path);
    const res = serveStaticFile(c, assetPath);
    if (res) return res;
    return c.text('Not Found', 404);
  });

  app.get('/favicon.svg', (c) => {
    const res = serveStaticFile(c, join(WEB_DIR, 'favicon.svg'));
    if (res) return res;
    return c.text('Not Found', 404);
  });

  app.get('/icons.svg', (c) => {
    const res = serveStaticFile(c, join(WEB_DIR, 'icons.svg'));
    if (res) return res;
    return c.text('Not Found', 404);
  });

  // SPA fallback: serve index.html for all non-API routes
  app.get('/', (c) => {
    const indexPath = join(WEB_DIR, 'index.html');
    if (existsSync(indexPath)) {
      const html = readFileSync(indexPath, 'utf-8');
      return c.html(html);
    }
    return c.html(dashboardNotBuiltHtml(), 503);
  });

  app.get('/web', (c) => c.redirect('/', 301));

  // ========== Dashboard (SessionStart context injection) ==========
  app.get('/dashboard', (c) => {
    const cwd = c.req.query('cwd') || null;
    const show = c.req.query('show') || 'all'; // active | next | all

    // Find enabled project by cwd or return empty
    let project = null;
    if (cwd) project = projects.getByCwd(cwd, { enabledOnly: true });
    if (!project) {
      const all = projects.list().filter(p => p.enabled);
      if (all.length === 1) project = all[0];
    }
    if (!project) {
      return c.json({ context: '', project: null });
    }

    // Find visible plans: non-completed + any completed plan that has in_progress tasks
    const allPlans = plans.list({ project_id: project.id });
    const visiblePlans = allPlans.filter(p => {
      if (['active', 'approved', 'draft'].includes(p.status)) return true;
      // Include completed plans that still have in_progress tasks (defensive)
      if (p.status === 'completed') {
        const planUnits = units.list({ plan_id: p.id });
        return planUnits.some(ph =>
          tasks.list({ unit_id: ph.id }).some(s => s.status === 'in_progress')
        );
      }
      return false;
    });
    if (visiblePlans.length === 0) {
      return c.json({
        context: `# Clawket: ${project.name}\nNo active plan.`,
        project: project.id,
      });
    }

    // Build compact index — show all non-completed plans
    const lines = [];
    lines.push(`# Clawket: ${project.name} (${visiblePlans.length} plan${visiblePlans.length > 1 ? 's' : ''})`);
    lines.push('');

    // Use first active plan as primary (for backward compat)
    const activePlan = visiblePlans.find(p => p.status === 'active') || visiblePlans[0];

    for (const plan of visiblePlans) {
      const isActive = plan.id === activePlan.id;
      lines.push(`## Plan: ${plan.title} (${plan.id}) [${plan.status}]${isActive ? ' ← active' : ''}`);

      const allUnits = units.list({ plan_id: plan.id });
      let visibleUnits;
      if (show === 'active') {
        visibleUnits = allUnits.filter(p => p.status === 'active');
      } else if (show === 'next') {
        const activeIdx = allUnits.findIndex(p => p.status === 'active');
        const nextPending = allUnits.find((p, i) => i > activeIdx && p.status === 'pending');
        visibleUnits = allUnits.filter(p =>
          p.status === 'active' || (nextPending && p.id === nextPending.id)
        );
      } else {
        visibleUnits = allUnits;
      }

    for (const unit of visibleUnits) {
      const approval = (unit.approval_required && !unit.approved_at) ? ' [needs approval]' : '';
      lines.push(`## ${unit.title} (${unit.id}) — ${unit.status}${approval}`);

      const allTasks = tasks.list({ unit_id: unit.id });
      const done = allTasks.filter(s => s.status === 'done').length;
      if (allTasks.length > 0) {
        lines.push(`  Progress: ${done}/${allTasks.length}`);
      }

      // Completed units: summary only (save tokens)
      if (unit.status === 'completed') {
        const nonDone = allTasks.filter(s => s.status !== 'done');
        if (nonDone.length > 0) {
          for (const task of nonDone) {
            const icon = { todo: '[ ]', in_progress: '[>]', blocked: '[!]', cancelled: '[-]', done: '[x]' }[task.status] || '[ ]';
            const assignee = task.assignee ? ` @${task.assignee}` : '';
            const ref = task.ticket_number || task.id;
            lines.push(`  ${icon} ${task.title} (${ref})${assignee}`);
          }
        }
        lines.push('');
        continue;
      }

      // Active units: show non-done tasks only (save tokens), use ticket_number
      const nonDoneTasks = allTasks.filter(s => s.status !== 'done');
      for (const task of nonDoneTasks) {
        const icon = { todo: '[ ]', in_progress: '[>]', blocked: '[!]', cancelled: '[-]', done: '[x]' }[task.status] || '[ ]';
        const assignee = task.assignee ? ` @${task.assignee}` : '';
        const ref = task.ticket_number || task.id;
        lines.push(`  ${icon} ${task.title} (${ref})${assignee}`);
      }
      lines.push('');
    }

      // Show summary of filtered-out units
      if (visibleUnits.length < allUnits.length) {
        const hidden = allUnits.length - visibleUnits.length;
        lines.push(`(${hidden} more units hidden — use show=all to see all)`);
        lines.push('');
      }
    } // end plan loop

    // Recent activity (last session context)
    const recentRuns = runs.list({ project_id: project.id }).slice(0, 5);
    if (recentRuns.length > 0) {
      lines.push('## Recent Activity');
      for (const r of recentRuns) {
        const status = r.ended_at ? `done (${r.result || 'ok'})` : 'running';
        const task = tasks.get(r.task_id);
        const taskTitle = task ? task.title : r.task_id;
        const ticket = task?.ticket_number ? `${task.ticket_number} ` : '';
        const notes = r.notes ? ` — ${r.notes.slice(0, 60)}` : '';
        lines.push(`  @${r.agent} → ${ticket}${taskTitle} [${status}]${notes}`);
      }
      lines.push('');
    }

    // In-progress tasks (carry-over from last session)
    const allUnitsFlat = visiblePlans.flatMap(p => units.list({ plan_id: p.id }));
    const inProgress = allUnitsFlat.flatMap(ph => tasks.list({ unit_id: ph.id }))
      .filter(s => s.status === 'in_progress');
    if (inProgress.length > 0) {
      lines.push('## In Progress (carry-over)');
      for (const s of inProgress) {
        const assignee = s.assignee ? ` @${s.assignee}` : '';
        lines.push(`  [>] ${s.title} (${s.id})${assignee}`);
      }
      lines.push('');
    }

    // Pending questions
    const pendingQs = questions.list({ plan_id: activePlan.id, pending: true });
    if (pendingQs.length > 0) {
      lines.push(`## Pending Questions (${pendingQs.length})`);
      for (const q of pendingQs) {
        lines.push(`  ? ${q.body} (${q.id})`);
      }
      lines.push('');
    }

    lines.push('Commands: clawket task view <ID> | clawket task update <ID> --status <s> | clawket unit approve <ID>');

    return c.json({
      context: lines.join('\n'),
      project: project.id,
      plan: activePlan.id,
    });
  });

  // ========== Wiki Files (project cwd file scanner) ==========
  app.get('/wiki/files', (c) => {
    const cwd = c.req.query('cwd') || null;
    if (!cwd || !existsSync(cwd)) return c.json([]);

    const MD_EXTS = new Set(['.md', '.mdx']);
    const MAX_SIZE = 512 * 1024; // 512KB max per file
    const results = [];

    function scanDir(dir, wikiRoot, depth = 0) {
      if (depth > 3) return;
      try {
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith('.')) continue;
          if (entry === 'node_modules') continue;
          const full = join(dir, entry);
          try {
            const stat = statSync(full);
            if (stat.isDirectory()) {
              scanDir(full, wikiRoot, depth + 1);
            } else if (MD_EXTS.has(extname(entry).toLowerCase()) && stat.size < MAX_SIZE) {
              let title = basename(entry, extname(entry));
              try {
                const head = readFileSync(full, 'utf-8').slice(0, 500);
                const headingMatch = head.match(/^#\s+(.+)$/m);
                if (headingMatch) title = headingMatch[1].trim();
              } catch {}
              results.push({
                path: relative(cwd, full),
                name: basename(entry, extname(entry)),
                title,
                size: stat.size,
                modified_at: stat.mtimeMs,
                wiki_root: wikiRoot,
              });
            }
          } catch { /* permission error, skip */ }
        }
      } catch { /* dir not readable */ }
    }

    // Scan wiki paths (from project settings, default: ["docs"])
    const projectId = c.req.query('project_id') || null;
    const project = projectId ? projects.get(projectId) : null;
    const wikiPaths = project?.wiki_paths || ['docs'];
    for (const wp of wikiPaths) {
      const wikiDir = wp.startsWith('/') ? wp : join(cwd, wp);
      if (existsSync(wikiDir)) {
        scanDir(wikiDir, wp);
      }
    }

    // Also include root-level .md files (README, CHANGELOG, etc.)
    try {
      for (const entry of readdirSync(cwd)) {
        if (MD_EXTS.has(extname(entry).toLowerCase())) {
          const full = join(cwd, entry);
          const stat = statSync(full);
          if (stat.isFile() && stat.size < MAX_SIZE) {
            let title = basename(entry, extname(entry));
            try {
              const head = readFileSync(full, 'utf-8').slice(0, 500);
              const headingMatch = head.match(/^#\s+(.+)$/m);
              if (headingMatch) title = headingMatch[1].trim();
            } catch {}
            results.push({
              path: entry,
              name: basename(entry, extname(entry)),
              title,
              size: stat.size,
              modified_at: stat.mtimeMs,
              wiki_root: '.',
            });
          }
        }
      }
    } catch {}

    return c.json(results);
  });

  app.get('/wiki/file', (c) => {
    const cwd = c.req.query('cwd') || '';
    const filePath = c.req.query('path') || '';
    const projectId = c.req.query('project_id') || null;
    if (!cwd || !filePath) return c.json({ error: 'cwd and path required' }, 400);

    const full = resolve(cwd, filePath);
    // Security: ensure resolved path is within cwd or any configured wiki_path
    const project = projectId ? projects.get(projectId) : null;
    const wikiPaths = project?.wiki_paths || ['docs'];
    const allowedRoots = [cwd, ...wikiPaths.map(wp => wp.startsWith('/') ? wp : join(cwd, wp))];
    const isAllowed = allowedRoots.some(root => full.startsWith(resolve(root)));
    if (!isAllowed) return c.json({ error: 'path outside allowed wiki roots' }, 403);
    if (!existsSync(full)) return c.json({ error: 'file not found' }, 404);

    try {
      const content = readFileSync(full, 'utf-8');
      const stat = statSync(full);
      return c.json({
        path: filePath,
        name: basename(filePath, extname(filePath)),
        content,
        content_format: 'markdown',
        size: stat.size,
        modified_at: stat.mtimeMs,
      });
    } catch (e) {
      return c.json({ error: e.message }, 500);
    }
  });

  // ========== Handoff ==========
  app.get('/handoff', (c) => {
    const cwd = c.req.query('cwd') || null;
    let project = null;
    if (cwd) project = projects.getByCwd(cwd);
    if (!project) {
      const all = projects.list();
      if (all.length === 1) project = all[0];
    }
    if (!project) return c.json({ content: '# No project found' });

    const allPlans = plans.list({ project_id: project.id });
    const activePlan = allPlans.find(p => ['active', 'approved', 'draft'].includes(p.status));

    const lines = [];
    lines.push(`# HANDOFF: ${project.name}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    if (!activePlan) {
      lines.push('No active plan.');
      return c.json({ content: lines.join('\n') });
    }

    // Project status
    const allUnits = units.list({ plan_id: activePlan.id });
    const allTasks = allUnits.flatMap(ph => tasks.list({ unit_id: ph.id }));
    const done = allTasks.filter(s => s.status === 'done').length;
    const total = allTasks.length;

    lines.push(`## Status: ${done}/${total} tasks complete (${total > 0 ? Math.round(done/total*100) : 0}%)`);
    lines.push('');

    // Completed units
    const completedUnits = allUnits.filter(p => p.status === 'completed');
    if (completedUnits.length > 0) {
      lines.push('## Completed');
      for (const ph of completedUnits) {
        lines.push(`- [x] ${ph.title}`);
      }
      lines.push('');
    }

    // In progress
    const inProgress = allTasks.filter(s => s.status === 'in_progress');
    if (inProgress.length > 0) {
      lines.push('## In Progress');
      for (const s of inProgress) {
        const a = s.assignee ? ` (@${s.assignee})` : '';
        lines.push(`- [ ] ${s.title}${a}`);
      }
      lines.push('');
    }

    // Blocked
    const blocked = allTasks.filter(s => s.status === 'blocked');
    if (blocked.length > 0) {
      lines.push('## Blocked');
      for (const s of blocked) {
        lines.push(`- [!] ${s.title}`);
      }
      lines.push('');
    }

    // Next up (todo from active/next unit)
    const activeUnits = allUnits.filter(p => p.status === 'active' || p.status === 'pending');
    const nextTodo = activeUnits.flatMap(ph => tasks.list({ unit_id: ph.id }))
      .filter(s => s.status === 'todo').slice(0, 10);
    if (nextTodo.length > 0) {
      lines.push('## Next Up');
      for (const s of nextTodo) {
        lines.push(`- ${s.title}`);
      }
      lines.push('');
    }

    // Open questions
    const openQs = questions.list({ plan_id: activePlan.id, pending: true });
    if (openQs.length > 0) {
      lines.push('## Open Questions');
      for (const q of openQs) {
        lines.push(`- ${q.body}`);
      }
      lines.push('');
    }

    // Design decisions (artifacts of type decision)
    const decisions = artifacts.list({ plan_id: activePlan.id }).filter(a => a.type === 'decision');
    if (decisions.length > 0) {
      lines.push('## Design Decisions');
      for (const d of decisions) {
        lines.push(`- **${d.title}**: ${d.content.slice(0, 120)}`);
      }
      lines.push('');
    }

    return c.json({ content: lines.join('\n') });
  });

  // ========== Dual listener ==========
  const sockServer = createServer(getRequestListener(app.fetch));
  sockServer.listen(paths.socket, () => {
    process.stderr.write(`clawketd: unix socket listening at ${paths.socket}\n`);
  });

  const CLAWKET_PORT = Number(process.env.CLAWKET_PORT) || 19400;
  const tcpServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: CLAWKET_PORT }, (info) => {
    writeFileSync(paths.portFile, String(info.port));
    process.stderr.write(`clawketd: tcp listening at http://127.0.0.1:${info.port}\n`);
  });

  writeFileSync(paths.pidFile, String(process.pid));

  backfillMissingEmbeddings();

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`clawketd: ${signal} received, shutting down\n`);
    sockServer.close();
    tcpServer.close();
    closeDb();
    for (const f of [paths.socket, paths.pidFile, paths.portFile]) {
      try { unlinkSync(f); } catch {}
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { sockServer, tcpServer, app };
}
