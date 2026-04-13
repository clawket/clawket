#!/usr/bin/env node
// Lattice SessionStart hook: ensure daemon running + inject dashboard context + rules.
const { execSync } = require('child_process');
const { readFileSync } = require('fs');
const { resolve, dirname } = require('path');

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || resolve(dirname(__filename), '..');
const LATTICE = process.env.LATTICE_BIN || resolve(pluginRoot, 'bin', 'lattice');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function exec(cmd) {
  try { return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { return ''; }
}

function ensureDeps() {
  const daemonDir = resolve(pluginRoot, 'daemon');
  const nodeModules = resolve(daemonDir, 'node_modules');
  const { existsSync } = require('fs');
  if (existsSync(resolve(daemonDir, 'package.json')) && !existsSync(nodeModules)) {
    process.stderr.write(`[lattice] Installing daemon dependencies...\n`);
    try {
      execSync('pnpm --version', { stdio: 'pipe' });
      execSync('pnpm install --prod', { cwd: daemonDir, stdio: ['pipe', 'pipe', process.stderr], timeout: 120000 });
      process.stderr.write(`[lattice] Dependencies installed (pnpm)\n`);
    } catch {
      try {
        execSync('npm install --production', { cwd: daemonDir, stdio: ['pipe', 'pipe', process.stderr], timeout: 120000 });
        process.stderr.write(`[lattice] Dependencies installed (npm)\n`);
      } catch (e) {
        process.stderr.write(`[lattice] ERROR: Failed to install dependencies: ${e.message}\n`);
      }
    }
  }
}

function ensureDaemon() {
  ensureDeps();
  const status = exec(`${LATTICE} daemon status`);
  if (!status.includes('running')) {
    exec(`${LATTICE} daemon start`);
    for (let i = 0; i < 5; i++) {
      if (exec(`${LATTICE} daemon status`).includes('running')) return;
      execSync('sleep 0.5');
    }
  }
}

function buildSummary(context) {
  const done = (context.match(/^\s*\[x\]/gm) || []).length;
  const inProg = (context.match(/^\s*\[>\]/gm) || []).length;
  const todo = (context.match(/^\s*\[ \]/gm) || []).length;
  const blocked = (context.match(/^\s*\[!\]/gm) || []).length;
  const activePhases = (context.match(/— active/g) || []).length;

  const firstLine = context.split('\n')[0].replace(/^#\s*/, '').trim();
  const name = firstLine.length > 55 ? firstLine.slice(0, 52) + '...' : firstLine;

  const lines = [];
  lines.push(`${C.bold}${C.cyan}Lattice${C.reset} ${C.dim}${name}${C.reset}`);
  lines.push(
    `${C.green}✓ ${done} done${C.reset}  ` +
    `${C.yellow}◐ ${inProg} active${C.reset}  ` +
    `${C.blue}○ ${todo} todo${C.reset}  ` +
    (blocked > 0 ? `${C.red}⊘ ${blocked} blocked${C.reset}  ` : '') +
    `${C.gray}(${activePhases} active phase)${C.reset}`
  );

  // 1. In-progress steps (이어서 할 것) — Phase 목록에서만 수집, 특수 섹션 제외
  const contextLines = context.split('\n');
  let currentPhase = '';
  let inSpecialSection = false;
  const inProgressSteps = [];
  const seen = new Set();

  for (const line of contextLines) {
    if (line.startsWith('## Recent') || line.startsWith('## In Progress') || line.startsWith('## Pending Q') || line.startsWith('Commands:')) {
      inSpecialSection = true;
    } else if (line.startsWith('## ')) {
      inSpecialSection = false;
      currentPhase = line.replace(/^## /, '').replace(/\s*\(PHASE-.*$/, '').trim();
    }
    if (inSpecialSection) continue;

    const progMatch = line.match(/^\s*\[>\] (.+?) \(STEP-/);
    if (progMatch && !seen.has(progMatch[1])) {
      seen.add(progMatch[1]);
      inProgressSteps.push({ title: progMatch[1], phase: currentPhase });
    }
  }

  if (inProgressSteps.length > 0) {
    lines.push('');
    lines.push(`  ${C.bold}In Progress${C.reset}`);
    for (const s of inProgressSteps) {
      lines.push(`    ${C.yellow}◐${C.reset} ${C.dim}${s.phase}${C.reset} ${s.title}`);
    }
  }

  // 2. Recent activity (이전 세션에서 다룬 것)
  const recentSection = context.indexOf('## Recent Activity');
  if (recentSection !== -1) {
    const recentLines = context.slice(recentSection).split('\n').slice(1);
    const recentItems = [];
    for (const line of recentLines) {
      if (line.startsWith('##') || line.trim() === '') break;
      const match = line.match(/^\s*@(\S+) → (.+?) \[(.+?)\](.*)/);
      if (match) {
        const [, agent, title, status, notes] = match;
        recentItems.push({ agent, title: title.trim(), status, notes: notes.replace(/^ — /, '').trim() });
      }
    }
    if (recentItems.length > 0) {
      lines.push('');
      lines.push(`  ${C.bold}Recent${C.reset}`);
      for (const r of recentItems) {
        const statusColor = r.status.includes('done') ? C.green : C.yellow;
        const note = r.notes ? ` ${C.dim}${r.notes.slice(0, 50)}${C.reset}` : '';
        lines.push(`    ${statusColor}${r.status}${C.reset} ${r.title} ${C.gray}@${r.agent}${C.reset}${note}`);
      }
    }
  }

  return lines.join('\n');
}

// Load rules (static, injected once at SessionStart)
let rules = '';
try {
  rules = readFileSync(resolve(pluginRoot, 'prompts', 'rules.md'), 'utf-8').trim();
} catch {}

// Resolve web URL once
function getWebUrl() {
  try {
    const portFile = require('path').join(require('os').homedir(), '.cache', 'lattice', 'latticed.port');
    const port = readFileSync(portFile, 'utf-8').trim();
    return `http://localhost:${port}`;
  } catch { return ''; }
}

// Main
ensureDaemon();
const cwd = process.env.HOOK_CWD || process.cwd();

// Full context for Claude (show=all)
const context = exec(`${LATTICE} dashboard --cwd "${cwd}" --show all`);
const webUrl = getWebUrl();

if (!context) {
  const noProjectMsg = `Lattice: No project registered for this directory.\nRun: lattice project new "<name>" --cwd "${cwd}"`;
  const statusLine = webUrl
    ? `  ${C.dim}Web: ${C.reset}${C.cyan}${webUrl}${C.reset}`
    : '';
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: noProjectMsg + (rules ? '\n\n' + rules : '') },
    systemMessage: `${C.cyan}Lattice${C.reset} ${C.dim}active${C.reset} ${C.yellow}— no project for this directory${C.reset}` + (statusLine ? '\n' + statusLine : '')
  }));
  process.exit(0);
}

const summary = buildSummary(context);

const statusLine = webUrl
  ? `${C.dim}Daemon: ${C.reset}${C.green}running${C.reset} ${C.dim}Web: ${C.reset}${C.cyan}${webUrl}${C.reset}`
  : `${C.dim}Daemon: ${C.reset}${C.green}running${C.reset}`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context + (rules ? '\n\n' + rules : '')
  },
  systemMessage: summary + '\n' + statusLine
}));
