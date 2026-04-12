#!/usr/bin/env node
// Lattice Stop hook: finalize active runs + auto-sync Phase/Plan status.
// No LLM calls — structured state recording only.
const { execSync } = require('child_process');
const { resolve, dirname, join } = require('path');
const { readFileSync } = require('fs');
const http = require('http');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || resolve(dirname(__filename), '..');
const LATTICE = process.env.LATTICE_BIN || resolve(pluginRoot, 'bin', 'lattice');
const sessionId = process.env.CLAUDE_SESSION_ID || '';

if (!sessionId) process.exit(0);

function exec(cmd) {
  try { return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { return ''; }
}

function apiGet(port, path) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

function apiPatch(port, path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:${port}${path}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'superseded', 'deferred']);

async function main() {
  // 1) Finalize active runs for this session
  try {
    const runsJson = exec(`${LATTICE} run list --session-id "${sessionId}"`);
    const runs = JSON.parse(runsJson || '[]');
    for (const run of runs) {
      if (!run.ended_at) {
        exec(`${LATTICE} run finish "${run.id}" --result session_ended --notes "Auto-closed by Stop hook"`);
      }
    }
  } catch {}

  // 2) Auto-sync Phase/Plan status — current project only (not all projects)
  let port;
  try {
    const portFile = join(require('os').homedir(), '.cache', 'lattice', 'latticed.port');
    port = readFileSync(portFile, 'utf-8').trim();
  } catch { return; }

  const cwd = process.env.HOOK_CWD || process.cwd();
  const project = await apiGet(port, `/projects/by-cwd/${encodeURIComponent(cwd)}`);
  if (!project || project.error) return;

  const plans = await apiGet(port, `/plans?project_id=${project.id}`);
  if (!plans || !Array.isArray(plans)) return;

  for (const plan of plans) {
    if (plan.status === 'completed') continue;

    const phases = await apiGet(port, `/phases?plan_id=${plan.id}`);
    if (!phases || !Array.isArray(phases)) continue;

    let allPhasesCompleted = phases.length > 0;

    for (const phase of phases) {
      if (phase.status === 'completed') continue;

      const steps = await apiGet(port, `/steps?phase_id=${phase.id}`);
      if (!steps || !Array.isArray(steps) || steps.length === 0) {
        allPhasesCompleted = false;
        continue;
      }

      const allDone = steps.every(s => TERMINAL_STATUSES.has(s.status));
      if (allDone) {
        await apiPatch(port, `/phases/${phase.id}`, { status: 'completed' });
      } else {
        allPhasesCompleted = false;
      }
    }

    if (allPhasesCompleted && plan.status !== 'completed') {
      await apiPatch(port, `/plans/${plan.id}`, { status: 'completed' });
    }
  }

  // 3) Auto-complete Bolts — all steps done/deferred/cancelled → completed
  const bolts = await apiGet(port, `/bolts?project_id=${project.id}`);
  if (bolts && Array.isArray(bolts)) {
    for (const bolt of bolts) {
      if (bolt.status === 'completed') continue;

      const boltSteps = await apiGet(port, `/bolts/${bolt.id}/steps`);
      if (!boltSteps || !Array.isArray(boltSteps) || boltSteps.length === 0) continue;

      const allDone = boltSteps.every(s => TERMINAL_STATUSES.has(s.status));
      if (allDone) {
        await apiPatch(port, `/bolts/${bolt.id}`, { status: 'completed' });
      }
    }
  }
}

main().catch(() => {});
