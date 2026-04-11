// Web dashboard — single HTML page served from /web
// All data fetched from the same server via /api/* endpoints

export function webDashboardHtml(baseUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lattice Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --text-muted: #8b949e; --text-dim: #484f58;
    --accent: #58a6ff; --green: #3fb950; --yellow: #d29922;
    --red: #f85149; --purple: #bc8cff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.5;
    padding: 24px; max-width: 1200px; margin: 0 auto;
  }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 16px; color: var(--accent); }
  h2 { font-size: 16px; font-weight: 600; margin: 20px 0 8px; color: var(--text); }
  h3 { font-size: 14px; font-weight: 600; margin: 12px 0 6px; color: var(--text-muted); }

  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
  .header h1 { margin: 0; }
  .status-badge {
    padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 500;
  }
  .status-badge.online { background: rgba(63,185,80,0.15); color: var(--green); }
  .status-badge.offline { background: rgba(248,81,73,0.15); color: var(--red); }

  .project-selector { margin-bottom: 20px; }
  .project-selector select {
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    padding: 6px 12px; border-radius: 6px; font-size: 14px;
  }

  .plan-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px; margin-bottom: 12px;
  }
  .plan-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .plan-title { font-weight: 600; font-size: 15px; }
  .plan-status {
    font-size: 11px; padding: 2px 8px; border-radius: 8px; font-weight: 500;
  }
  .plan-status.draft { background: rgba(139,148,158,0.15); color: var(--text-muted); }
  .plan-status.active, .plan-status.approved { background: rgba(63,185,80,0.15); color: var(--green); }
  .plan-status.completed { background: rgba(88,166,255,0.15); color: var(--accent); }

  .phase-card {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px; margin: 8px 0;
  }
  .phase-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .phase-title { font-weight: 600; font-size: 14px; }
  .approval-badge {
    font-size: 11px; padding: 2px 8px; border-radius: 8px;
    background: rgba(210,153,34,0.15); color: var(--yellow); cursor: pointer;
  }
  .approval-badge:hover { background: rgba(210,153,34,0.3); }
  .approval-badge.approved { background: rgba(63,185,80,0.15); color: var(--green); cursor: default; }

  .progress-bar {
    height: 4px; background: var(--border); border-radius: 2px; margin: 6px 0; overflow: hidden;
  }
  .progress-fill { height: 100%; background: var(--green); border-radius: 2px; transition: width 0.3s; }

  .step-list { list-style: none; }
  .step-item {
    display: flex; align-items: center; gap: 8px; padding: 6px 0;
    border-bottom: 1px solid var(--border); font-size: 13px;
  }
  .step-item:last-child { border-bottom: none; }
  .step-icon { width: 18px; text-align: center; flex-shrink: 0; }
  .step-icon.todo { color: var(--text-dim); }
  .step-icon.in_progress { color: var(--yellow); }
  .step-icon.done { color: var(--green); }
  .step-icon.blocked { color: var(--red); }
  .step-title { flex: 1; }
  .step-id { color: var(--text-dim); font-size: 11px; font-family: monospace; }
  .step-assignee { color: var(--purple); font-size: 11px; }

  .step-status-btn {
    font-size: 11px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text-muted); cursor: pointer;
  }
  .step-status-btn:hover { border-color: var(--accent); color: var(--accent); }
  .step-status-btn select {
    background: transparent; color: inherit; border: none; font-size: inherit; cursor: pointer;
  }

  .questions-section { margin-top: 20px; }
  .question-item {
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 10px; margin: 6px 0; font-size: 13px;
  }
  .question-body { margin-bottom: 4px; }
  .question-meta { color: var(--text-dim); font-size: 11px; }

  .empty-state { color: var(--text-dim); font-style: italic; padding: 20px; text-align: center; }
  .refresh-btn {
    background: var(--surface); color: var(--accent); border: 1px solid var(--border);
    padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;
  }
  .refresh-btn:hover { background: var(--border); }
  .id-mono { font-family: monospace; font-size: 11px; color: var(--text-dim); }
</style>
</head>
<body>

<div class="header">
  <h1>Lattice</h1>
  <div style="display:flex;gap:8px;align-items:center">
    <span id="daemon-status" class="status-badge online">connected</span>
    <button class="refresh-btn" onclick="loadAll()">Refresh</button>
  </div>
</div>

<div class="project-selector">
  <select id="project-select" onchange="loadProject(this.value)">
    <option value="">Select project...</option>
  </select>
</div>

<div id="content">
  <div class="empty-state">Select a project to view dashboard</div>
</div>

<script>
const API = '';

async function api(path) {
  try {
    const res = await fetch(API + path);
    return await res.json();
  } catch(e) {
    document.getElementById('daemon-status').className = 'status-badge offline';
    document.getElementById('daemon-status').textContent = 'disconnected';
    throw e;
  }
}

async function apiPost(path, body) {
  const res = await fetch(API + path, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify(body)
  });
  return res.json();
}

async function apiPatch(path, body) {
  const res = await fetch(API + path, {
    method: 'PATCH', headers: {'content-type': 'application/json'},
    body: JSON.stringify(body)
  });
  return res.json();
}

async function loadAll() {
  document.getElementById('daemon-status').className = 'status-badge online';
  document.getElementById('daemon-status').textContent = 'connected';

  const projects = await api('/projects');
  const sel = document.getElementById('project-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">Select project...</option>';
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + (p.cwds?.length ? ' (' + p.cwds[0] + ')' : '');
    if (p.id === current) opt.selected = true;
    sel.appendChild(opt);
  }
  if (current) loadProject(current);
}

async function loadProject(projectId) {
  if (!projectId) {
    document.getElementById('content').innerHTML = '<div class="empty-state">Select a project</div>';
    return;
  }

  const plans = await api('/plans?project_id=' + projectId);
  if (plans.length === 0) {
    document.getElementById('content').innerHTML = '<div class="empty-state">No plans in this project</div>';
    return;
  }

  let html = '';
  for (const plan of plans) {
    html += await renderPlan(plan);
  }

  // Questions
  const qs = await api('/questions?pending=true');
  if (qs.length > 0) {
    html += '<div class="questions-section"><h2>Pending Questions</h2>';
    for (const q of qs) {
      html += '<div class="question-item">' +
        '<div class="question-body">' + esc(q.body) + '</div>' +
        '<div class="question-meta">' + esc(q.kind) + ' &middot; ' + esc(q.id) + ' &middot; ' + timeAgo(q.created_at) + '</div>' +
        '</div>';
    }
    html += '</div>';
  }

  document.getElementById('content').innerHTML = html;
}

async function renderPlan(plan) {
  const phs = await api('/phases?plan_id=' + plan.id);
  let html = '<div class="plan-card">';
  html += '<div class="plan-header">';
  html += '<span class="plan-title">' + esc(plan.title) + '</span>';
  html += '<span class="plan-status ' + plan.status + '">' + plan.status + '</span>';
  html += '<span class="id-mono">' + plan.id + '</span>';
  html += '</div>';

  for (const phase of phs) {
    html += await renderPhase(phase);
  }

  html += '</div>';
  return html;
}

async function renderPhase(phase) {
  const sts = await api('/steps?phase_id=' + phase.id);
  const done = sts.filter(s => s.status === 'done').length;
  const pct = sts.length > 0 ? Math.round(done / sts.length * 100) : 0;

  let html = '<div class="phase-card">';
  html += '<div class="phase-header">';
  html += '<span class="phase-title">' + esc(phase.title) + '</span>';
  html += '<span class="plan-status ' + phase.status + '">' + phase.status + '</span>';

  if (phase.approval_required && !phase.approved_at) {
    html += '<span class="approval-badge" onclick="approvePhase(\\''+phase.id+'\\')">needs approval</span>';
  } else if (phase.approved_at) {
    html += '<span class="approval-badge approved">approved</span>';
  }

  html += '<span class="id-mono">' + phase.id + '</span>';
  html += '</div>';

  if (sts.length > 0) {
    html += '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">' + done + '/' + sts.length + ' steps done</div>';
    html += '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
  }

  html += '<ul class="step-list">';
  for (const step of sts) {
    const icons = {todo: '○', in_progress: '◐', done: '●', blocked: '⊘'};
    html += '<li class="step-item">';
    html += '<span class="step-icon ' + step.status + '">' + (icons[step.status] || '○') + '</span>';
    html += '<span class="step-title">' + esc(step.title) + '</span>';
    if (step.assignee) html += '<span class="step-assignee">@' + esc(step.assignee) + '</span>';
    html += '<span class="step-id">' + step.id + '</span>';
    html += '<select class="step-status-btn" onchange="updateStep(\\''+step.id+'\\', this.value)">';
    for (const s of ['todo','in_progress','done','blocked']) {
      html += '<option value="'+s+'"'+(step.status===s?' selected':'')+'>'+s+'</option>';
    }
    html += '</select>';
    html += '</li>';
  }
  html += '</ul></div>';
  return html;
}

async function updateStep(id, status) {
  await apiPatch('/steps/' + id, {status});
  const sel = document.getElementById('project-select');
  loadProject(sel.value);
}

async function approvePhase(id) {
  await apiPost('/phases/' + id + '/approve', {by: 'human'});
  const sel = document.getElementById('project-select');
  loadProject(sel.value);
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d/60000) + 'm ago';
  if (d < 86400000) return Math.floor(d/3600000) + 'h ago';
  return Math.floor(d/86400000) + 'd ago';
}

loadAll();
setInterval(loadAll, 10000);
</script>
</body>
</html>`;
}
