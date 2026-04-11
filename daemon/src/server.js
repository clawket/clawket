import { createServer } from 'node:http';
import { writeFileSync, unlinkSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getRequestListener, serve } from '@hono/node-server';

import { paths, ensureDirs } from './paths.js';
import { getDb, closeDb } from './db.js';
import { projects, plans, phases, steps, bolts, artifacts, runs, questions, stepComments, artifactVersions, activityLog, stepRelations } from './repo.js';
import { importPlanFile } from './import-plan.js';
import { webDashboardHtml } from './web.js';
import { formatOutput } from './format.js';

const VERSION = '0.1.0';

export function startServer() {
  ensureDirs();
  getDb();

  if (existsSync(paths.socket)) {
    try { unlinkSync(paths.socket); } catch {}
  }

  const startTime = Date.now();
  const app = new Hono();

  app.onError((err, c) => {
    const status = err.status || 500;
    return c.json({ error: err.message, stack: process.env.LATTICE_DEBUG ? err.stack : undefined }, status);
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
    if (!p) return c.json({ error: 'not found' }, 404);
    return c.json(p);
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
  app.get('/projects/by-cwd/:cwd{.+}', (c) => {
    const cwd = decodeURIComponent(c.req.param('cwd'));
    const p = projects.getByCwd(cwd);
    if (!p) return c.json({ error: 'not found' }, 404);
    return c.json(p);
  });

  // ========== Plans ==========
  app.get('/plans', (c) => {
    const q = c.req.query();
    return c.json(plans.list({ project_id: q.project_id || null, status: q.status || null }));
  });
  app.post('/plans', async (c) => c.json(plans.create(await c.req.json())));
  app.get('/plans/:id', (c) => {
    const p = plans.get(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    return c.json(p);
  });
  app.patch('/plans/:id', async (c) => c.json(plans.update(c.req.param('id'), await c.req.json())));
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

  // ========== Phases ==========
  app.get('/phases', (c) => {
    const q = c.req.query();
    return c.json(phases.list({ plan_id: q.plan_id || null, status: q.status || null }));
  });
  app.post('/phases', async (c) => c.json(phases.create(await c.req.json())));
  app.get('/phases/:id', (c) => {
    const p = phases.get(c.req.param('id'));
    if (!p) return c.json({ error: 'not found' }, 404);
    return c.json(p);
  });
  app.patch('/phases/:id', async (c) => c.json(phases.update(c.req.param('id'), await c.req.json())));
  app.delete('/phases/:id', (c) => {
    phases.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });
  app.post('/phases/:id/approve', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(phases.approve(c.req.param('id'), { by: body.by || 'human' }));
  });
  app.get('/phases/:id/events', (c) => {
    const id = c.req.param('id');
    const timeoutSec = Number(c.req.query('timeout') || 600);
    const intervalMs = Number(c.req.query('interval') || 1000);
    const deadline = Date.now() + timeoutSec * 1000;

    return streamSSE(c, async (stream) => {
      const initial = phases.get(id);
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
        const p = phases.get(id);
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

  // ========== Steps ==========
  app.get('/steps', (c) => {
    const q = c.req.query();
    return c.json(steps.list({
      phase_id: q.phase_id || null,
      plan_id: q.plan_id || null,
      status: q.status || null,
      parent_step_id: q.parent_step_id !== undefined ? (q.parent_step_id || null) : undefined,
    }));
  });
  app.post('/steps', async (c) => c.json(steps.create(await c.req.json())));
  app.get('/steps/search', (c) => {
    const query = c.req.query('q') || '';
    const limit = Number(c.req.query('limit') || 20);
    return c.json(steps.search(query, { limit }));
  });
  app.get('/steps/:id', (c) => {
    const s = steps.get(c.req.param('id'));
    if (!s) return c.json({ error: 'not found' }, 404);
    return c.json(s);
  });
  app.patch('/steps/:id', async (c) => c.json(steps.update(c.req.param('id'), await c.req.json())));
  app.delete('/steps/:id', (c) => {
    steps.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });
  // Bulk update steps
  app.post('/steps/bulk-update', async (c) => {
    const { ids, fields } = await c.req.json();
    if (!ids || !Array.isArray(ids)) return c.json({ error: 'ids array required' }, 400);
    return c.json(steps.bulkUpdate(ids, fields));
  });

  app.post('/steps/:id/body', async (c) => {
    const { text } = await c.req.json();
    return c.json(steps.appendBody(c.req.param('id'), '\n' + text));
  });

  // ========== Step Comments ==========
  app.get('/steps/:id/comments', (c) => {
    return c.json(stepComments.list({ step_id: c.req.param('id') }));
  });
  app.post('/steps/:id/comments', async (c) => {
    const body = await c.req.json();
    return c.json(stepComments.create({
      step_id: c.req.param('id'),
      author: body.author,
      body: body.body,
    }));
  });
  app.delete('/comments/:id', (c) => {
    stepComments.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });

  // ========== Step Labels ==========
  app.post('/steps/:id/labels', async (c) => {
    const body = await c.req.json();
    return c.json(steps.addLabel(c.req.param('id'), body.label));
  });
  app.delete('/steps/:id/labels/:label', (c) => {
    return c.json(steps.removeLabel(c.req.param('id'), c.req.param('label')));
  });
  app.get('/labels/:label/steps', (c) => {
    return c.json(steps.listByLabel(c.req.param('label')));
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

  // ========== Step Relations ==========
  app.get('/steps/:id/relations', (c) => {
    return c.json(stepRelations.list({ step_id: c.req.param('id') }));
  });
  app.post('/steps/:id/relations', async (c) => {
    const body = await c.req.json();
    return c.json(stepRelations.create({
      source_step_id: c.req.param('id'),
      target_step_id: body.target_step_id,
      relation_type: body.relation_type,
    }));
  });
  app.delete('/relations/:id', (c) => {
    stepRelations.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });

  // ========== Bolts ==========
  app.get('/bolts', (c) => {
    const q = c.req.query();
    return c.json(bolts.list({ project_id: q.project_id || null, status: q.status || null }));
  });
  app.post('/bolts', async (c) => c.json(bolts.create(await c.req.json())));
  app.get('/bolts/:id', (c) => {
    const b = bolts.get(c.req.param('id'));
    if (!b) return c.json({ error: 'not found' }, 404);
    return c.json(b);
  });
  app.patch('/bolts/:id', async (c) => c.json(bolts.update(c.req.param('id'), await c.req.json())));
  app.delete('/bolts/:id', (c) => {
    bolts.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
  });
  app.get('/bolts/:id/steps', (c) => {
    return c.json(bolts.steps(c.req.param('id')));
  });

  // ========== Backlog (steps with no bolt) ==========
  app.get('/backlog', (c) => {
    const projectId = c.req.query('project_id');
    if (!projectId) return c.json({ error: 'project_id query param required' }, 400);
    return c.json(bolts.backlog(projectId));
  });

  // ========== Artifacts ==========
  app.get('/artifacts', (c) => {
    const q = c.req.query();
    return c.json(artifacts.list({
      step_id: q.step_id || null,
      phase_id: q.phase_id || null,
      plan_id: q.plan_id || null,
      type: q.type || null,
    }));
  });
  app.post('/artifacts', async (c) => c.json(artifacts.create(await c.req.json())));
  app.get('/artifacts/:id', (c) => {
    const a = artifacts.get(c.req.param('id'));
    if (!a) return c.json({ error: 'not found' }, 404);
    return c.json(a);
  });
  app.delete('/artifacts/:id', (c) => {
    artifacts.delete(c.req.param('id'));
    return c.json({ deleted: c.req.param('id') });
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
    return c.json(runs.list({ step_id: q.step_id || null, session_id: q.session_id || null }));
  });
  app.post('/runs', async (c) => c.json(runs.create(await c.req.json())));
  app.get('/runs/:id', (c) => {
    const r = runs.get(c.req.param('id'));
    if (!r) return c.json({ error: 'not found' }, 404);
    return c.json(r);
  });
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
      phase_id: q.phase_id || null,
      step_id: q.step_id || null,
      pending,
    }));
  });
  app.post('/questions', async (c) => c.json(questions.create(await c.req.json())));
  app.get('/questions/:id', (c) => {
    const q = questions.get(c.req.param('id'));
    if (!q) return c.json({ error: 'not found' }, 404);
    return c.json(q);
  });
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

  // ========== Web Dashboard ==========
  app.get('/web', (c) => c.html(webDashboardHtml('')));

  // ========== Dashboard (SessionStart context injection) ==========
  app.get('/dashboard', (c) => {
    const cwd = c.req.query('cwd') || null;
    const show = c.req.query('show') || 'all'; // active | next | all

    // Find project by cwd or return empty
    let project = null;
    if (cwd) project = projects.getByCwd(cwd);
    if (!project) {
      const all = projects.list();
      if (all.length === 1) project = all[0];
    }
    if (!project) {
      return c.json({ context: '', project: null });
    }

    // Find active plan
    const allPlans = plans.list({ project_id: project.id });
    const activePlan = allPlans.find(p => ['active', 'approved', 'draft'].includes(p.status));
    if (!activePlan) {
      return c.json({
        context: `# Lattice: ${project.name}\nNo active plan.`,
        project: project.id,
      });
    }

    // Filter phases by show mode
    const allPhases = phases.list({ plan_id: activePlan.id });
    let visiblePhases;
    if (show === 'active') {
      visiblePhases = allPhases.filter(p => p.status === 'active');
    } else if (show === 'next') {
      const activeIdx = allPhases.findIndex(p => p.status === 'active');
      const nextPending = allPhases.find((p, i) => i > activeIdx && p.status === 'pending');
      visiblePhases = allPhases.filter(p =>
        p.status === 'active' || (nextPending && p.id === nextPending.id)
      );
    } else {
      visiblePhases = allPhases;
    }

    // Build compact index
    const lines = [];
    lines.push(`# Lattice: ${project.name} — ${activePlan.title} (${activePlan.id})`);
    lines.push(`Status: ${activePlan.status}`);
    lines.push('');

    for (const phase of visiblePhases) {
      const approval = (phase.approval_required && !phase.approved_at) ? ' [needs approval]' : '';
      lines.push(`## ${phase.title} (${phase.id}) — ${phase.status}${approval}`);

      const allSteps = steps.list({ phase_id: phase.id });
      const done = allSteps.filter(s => s.status === 'done').length;
      if (allSteps.length > 0) {
        lines.push(`  Progress: ${done}/${allSteps.length}`);
      }

      for (const step of allSteps) {
        const icon = { todo: '[ ]', in_progress: '[>]', done: '[x]', blocked: '[!]' }[step.status] || '[ ]';
        const assignee = step.assignee ? ` @${step.assignee}` : '';
        lines.push(`  ${icon} ${step.title} (${step.id})${assignee}`);
      }
      lines.push('');
    }

    // Show summary of filtered-out phases
    if (visiblePhases.length < allPhases.length) {
      const hidden = allPhases.length - visiblePhases.length;
      lines.push(`(${hidden} more phases hidden — use show=all to see all)`);
      lines.push('');
    }

    // Recent activity (last session context)
    const recentRuns = runs.list({}).slice(0, 5);
    if (recentRuns.length > 0) {
      lines.push('## Recent Activity');
      for (const r of recentRuns) {
        const status = r.ended_at ? `done (${r.result || 'ok'})` : 'running';
        const step = steps.get(r.step_id);
        const stepTitle = step ? step.title : r.step_id;
        const ticket = step?.ticket_number ? `${step.ticket_number} ` : '';
        const notes = r.notes ? ` — ${r.notes.slice(0, 60)}` : '';
        lines.push(`  @${r.agent} → ${ticket}${stepTitle} [${status}]${notes}`);
      }
      lines.push('');
    }

    // In-progress steps (carry-over from last session)
    const inProgress = allPhases.flatMap(ph => steps.list({ phase_id: ph.id }))
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

    lines.push('Commands: lattice step show <ID> | lattice step update <ID> --status <s> | lattice phase approve <ID>');

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

    const SCAN_DIRS = ['docs', 'wiki', 'documentation', '.claude', '.github'];
    const MD_EXTS = new Set(['.md', '.mdx']);
    const MAX_SIZE = 512 * 1024; // 512KB max per file
    const results = [];

    function scanDir(dir, depth = 0) {
      if (depth > 3) return;
      try {
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith('.') && entry !== '.claude') continue;
          const full = join(dir, entry);
          try {
            const stat = statSync(full);
            if (stat.isDirectory()) {
              scanDir(full, depth + 1);
            } else if (MD_EXTS.has(extname(entry).toLowerCase()) && stat.size < MAX_SIZE) {
              results.push({
                path: relative(cwd, full),
                name: basename(entry, extname(entry)),
                size: stat.size,
                modified_at: stat.mtimeMs,
              });
            }
          } catch { /* permission error, skip */ }
        }
      } catch { /* dir not readable */ }
    }

    // Scan known doc directories
    for (const dir of SCAN_DIRS) {
      const full = join(cwd, dir);
      if (existsSync(full)) scanDir(full);
    }

    // Also include root-level .md files (README, CHANGELOG, etc.)
    try {
      for (const entry of readdirSync(cwd)) {
        if (MD_EXTS.has(extname(entry).toLowerCase())) {
          const full = join(cwd, entry);
          const stat = statSync(full);
          if (stat.isFile() && stat.size < MAX_SIZE) {
            results.push({
              path: entry,
              name: basename(entry, extname(entry)),
              size: stat.size,
              modified_at: stat.mtimeMs,
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
    if (!cwd || !filePath) return c.json({ error: 'cwd and path required' }, 400);

    const full = join(cwd, filePath);
    // Security: ensure resolved path is within cwd
    if (!full.startsWith(cwd)) return c.json({ error: 'path outside project' }, 403);
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
    const allPhases = phases.list({ plan_id: activePlan.id });
    const allSteps = allPhases.flatMap(ph => steps.list({ phase_id: ph.id }));
    const done = allSteps.filter(s => s.status === 'done').length;
    const total = allSteps.length;

    lines.push(`## Status: ${done}/${total} steps complete (${total > 0 ? Math.round(done/total*100) : 0}%)`);
    lines.push('');

    // Completed phases
    const completedPhases = allPhases.filter(p => p.status === 'completed');
    if (completedPhases.length > 0) {
      lines.push('## Completed');
      for (const ph of completedPhases) {
        lines.push(`- [x] ${ph.title}`);
      }
      lines.push('');
    }

    // In progress
    const inProgress = allSteps.filter(s => s.status === 'in_progress');
    if (inProgress.length > 0) {
      lines.push('## In Progress');
      for (const s of inProgress) {
        const a = s.assignee ? ` (@${s.assignee})` : '';
        lines.push(`- [ ] ${s.title}${a}`);
      }
      lines.push('');
    }

    // Blocked
    const blocked = allSteps.filter(s => s.status === 'blocked');
    if (blocked.length > 0) {
      lines.push('## Blocked');
      for (const s of blocked) {
        lines.push(`- [!] ${s.title}`);
      }
      lines.push('');
    }

    // Next up (todo from active/next phase)
    const activePhases = allPhases.filter(p => p.status === 'active' || p.status === 'pending');
    const nextTodo = activePhases.flatMap(ph => steps.list({ phase_id: ph.id }))
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
    process.stderr.write(`latticed: unix socket listening at ${paths.socket}\n`);
  });

  const tcpServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
    writeFileSync(paths.portFile, String(info.port));
    process.stderr.write(`latticed: tcp listening at http://127.0.0.1:${info.port}\n`);
  });

  writeFileSync(paths.pidFile, String(process.pid));

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`latticed: ${signal} received, shutting down\n`);
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
