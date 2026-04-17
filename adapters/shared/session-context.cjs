const { readPromptFiles } = require('./common.cjs');

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

function parseInProgressTasks(context) {
  const tasks = [];
  for (const line of context.split('\n')) {
    const match = line.match(/^\s*\[>\]\s+(.+?)\s+\(TASK-(\S+)\)\s*(.*)$/);
    if (match) {
      tasks.push({
        title: match[1].trim(),
        id: `TASK-${match[2]}`,
        meta: match[3].trim(),
      });
    }
  }
  return tasks;
}

function buildSummary(context, options = {}) {
  const ansi = options.ansi !== false;
  const color = (value, token) => (ansi ? `${token}${value}${C.reset}` : value);

  const done = (context.match(/^\s*\[x\]/gm) || []).length;
  const inProg = (context.match(/^\s*\[>\]/gm) || []).length;
  const todo = (context.match(/^\s*\[ \]/gm) || []).length;
  const blocked = (context.match(/^\s*\[!\]/gm) || []).length;
  const activeUnits = (context.match(/— active/g) || []).length;

  const firstLine = context.split('\n')[0].replace(/^#\s*/, '').trim();
  const name = firstLine.length > 55 ? firstLine.slice(0, 52) + '...' : firstLine;

  const lines = [];
  lines.push(`${color('Clawket', `${C.bold}${C.cyan}`)} ${color(name, C.dim)}`);
  lines.push(
    `${color(`✓ ${done} done`, C.green)}  ` +
    `${color(`◐ ${inProg} active`, C.yellow)}  ` +
    `${color(`○ ${todo} todo`, C.blue)}  ` +
    (blocked > 0 ? `${color(`⊘ ${blocked} blocked`, C.red)}  ` : '') +
    `${color(`(${activeUnits} active unit)`, C.gray)}`
  );

  const contextLines = context.split('\n');
  let currentUnit = '';
  let inSpecialSection = false;
  const inProgressTasks = [];
  const seen = new Set();

  for (const line of contextLines) {
    if (line.startsWith('## Recent') || line.startsWith('## In Progress') || line.startsWith('## Pending Q') || line.startsWith('Commands:')) {
      inSpecialSection = true;
    } else if (line.startsWith('## ')) {
      inSpecialSection = false;
      currentUnit = line.replace(/^## /, '').replace(/\s*\(UNIT-.*$/, '').trim();
    }
    if (inSpecialSection) continue;

    const progMatch = line.match(/^\s*\[>\] (.+?) \(TASK-/);
    if (progMatch && !seen.has(progMatch[1])) {
      seen.add(progMatch[1]);
      inProgressTasks.push({ title: progMatch[1], unit: currentUnit });
    }
  }

  if (inProgressTasks.length > 0) {
    lines.push('');
    lines.push(`  ${color('In Progress', C.bold)}`);
    for (const task of inProgressTasks) {
      lines.push(`    ${color('◐', C.yellow)} ${color(task.unit, C.dim)} ${task.title}`);
    }
  }

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
      lines.push(`  ${color('Recent', C.bold)}`);
      for (const item of recentItems) {
        const statusColor = item.status.includes('done') ? C.green : C.yellow;
        const note = item.notes ? ` ${color(item.notes.slice(0, 50), C.dim)}` : '';
        lines.push(`    ${color(item.status, statusColor)} ${item.title} ${color(`@${item.agent}`, C.gray)}${note}`);
      }
    }
  }

  return lines.join('\n');
}

function loadRuntimePrompt(pluginRoot, runtimeName) {
  return readPromptFiles(pluginRoot, [
    'prompts/shared/rules.md',
    `prompts/${runtimeName}/runtime.md`,
  ]);
}

function buildCodexBootstrap(pluginRoot, cwd, context) {
  const runtimePrompt = loadRuntimePrompt(pluginRoot, 'codex');
  const header = context
    ? `# Active Clawket Context\n\n${context}`
    : `# Clawket\n\nNo project is registered for \`${cwd}\`.\nRegister one with:\n\n\`clawket project create "<name>" --cwd "${cwd}"\``;
  return [header, runtimePrompt].filter(Boolean).join('\n\n');
}

module.exports = {
  buildCodexBootstrap,
  buildSummary,
  loadRuntimePrompt,
  parseInProgressTasks,
};
