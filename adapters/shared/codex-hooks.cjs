const fs = require('fs');
const path = require('path');

const {
  cacheDir,
  clawketBin,
  ensureXdgDirs,
  exec,
  readHookInput,
  resolvePluginRoot,
} = require('./common.cjs');
const { buildSummary, parseInProgressTasks, loadRuntimePrompt } = require('./session-context.cjs');

function runtime(pluginRoot) {
  return {
    pluginRoot,
    clawket: clawketBin(pluginRoot),
  };
}

function allow() {
  console.log(JSON.stringify({}));
  process.exit(0);
}

function sessionIdFrom(hookInput) {
  return (
    hookInput.session_id
    || hookInput.thread_id
    || process.env.CODEX_SESSION_ID
    || process.env.CLAWKET_SESSION_ID
    || ''
  );
}

function ensureDaemon(clawket, pluginRoot) {
  ensureXdgDirs();
  const daemonDir = path.resolve(pluginRoot, 'daemon');
  const nodeModules = path.resolve(daemonDir, 'node_modules');
  if (fs.existsSync(path.resolve(daemonDir, 'package.json')) && !fs.existsSync(nodeModules)) {
    process.stderr.write('[clawket] Installing daemon dependencies...\n');
    try {
      exec('pnpm --version');
      exec('pnpm install --prod', { cwd: daemonDir, stdio: ['pipe', 'pipe', process.stderr], timeout: 120000 });
    } catch {
      try {
        exec('npm install --production', { cwd: daemonDir, stdio: ['pipe', 'pipe', process.stderr], timeout: 120000 });
      } catch {}
    }
  }

  const status = exec(`${clawket} daemon status`);
  if (!status.includes('running')) {
    exec(`${clawket} daemon start`);
    for (let i = 0; i < 5; i += 1) {
      if (exec(`${clawket} daemon status`).includes('running')) return;
      exec('sleep 0.5');
    }
  }
}

function getWebUrl() {
  try {
    const portFile = path.join(cacheDir(), 'clawketd.port');
    const port = fs.readFileSync(portFile, 'utf-8').trim();
    return `http://localhost:${port}`;
  } catch {
    return '';
  }
}

function readOnlyBashPatterns() {
  return [
    /^(ls|pwd|wc|du|df|which|where|type|file|stat)\b/,
    /^(cat|head|tail|less|more|sed|awk|cut|sort|uniq)\b/,
    /^(find|rg|grep)\b/,
    /^git\s+(status|log|diff|show|branch|stash\s+list|remote|tag)\b/,
    /^cargo\s+(check|test|clippy)\b/,
    /^(npx\s+)?tsc(\s|$)/,
    /^(npx\s+)?eslint(\s|$)/,
    /^(npx\s+)?prettier(\s|$)/,
    /^(npm|pnpm|yarn|bun)\s+(test|lint)\b/,
    /^(npm|pnpm|yarn|bun)\s+run\s+(test|lint|check|typecheck|build)\b/,
    /^(npx|pnpm\s+exec)\s+(vitest|jest)\b/,
    /^(curl|wget)\b/,
    /^echo\b/,
    /^lsof\b/,
  ];
}

function runSessionStart() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  ensureDaemon(clawket, pluginRoot);

  const hookInput = readHookInput();
  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();
  const context = exec(`${clawket} dashboard --cwd "${cwd}" --show active`);
  const rules = loadRuntimePrompt(pluginRoot, 'codex');
  const webUrl = getWebUrl();

  if (!context) {
    const noProjectMsg = `Clawket: No project registered for this directory.\nRun: clawket project create "<name>" --cwd "${cwd}"`;
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: noProjectMsg + (rules ? `\n\n${rules}` : ''),
      },
      systemMessage: `Clawket active — no project for this directory${webUrl ? `\nWeb: ${webUrl}` : ''}`,
    }));
    process.exit(0);
  }

  const summary = buildSummary(context);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context + (rules ? `\n\n${rules}` : ''),
    },
    systemMessage: `${summary}\nDaemon: running${webUrl ? ` Web: ${webUrl}` : ''}`,
  }));
}

function runUserPromptSubmit() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();
  const context = exec(`${clawket} dashboard --cwd "${cwd}" --show active`);

  if (!context) allow();

  const inProgressTasks = parseInProgressTasks(context);
  if (inProgressTasks.length === 0) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '# Clawket: 활성 태스크 없음 — 작업 전 태스크 등록 필요',
      },
    }));
    return;
  }

  const taskList = inProgressTasks
    .map((task) => `- [${task.id}] ${task.title}${task.meta ? ` (${task.meta})` : ''}`)
    .join('\n');
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `# Active Clawket Tasks\n${taskList}`,
    },
  }));
}

function runPreToolUse() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const toolName = hookInput.tool_name || '';
  const toolInput = hookInput.tool_input || {};

  const guardedTools = new Set(['Bash']);
  if (!guardedTools.has(toolName)) allow();

  const cmd = (toolInput.command || '').trim();
  if (!cmd) allow();
  if (cmd.startsWith('clawket ') || cmd.includes(' clawket ')) allow();
  if (readOnlyBashPatterns().some((re) => re.test(cmd))) allow();

  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();
  const context = exec(`${clawket} dashboard --cwd "${cwd}" --show active`);
  if (!context) allow();

  let inProgressTasks = [];
  try {
    inProgressTasks = JSON.parse(exec(`${clawket} task list --status in_progress`) || '[]');
  } catch {}

  if (inProgressTasks.length > 0) allow();

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Clawket: 활성 태스크가 없습니다. 작업 전 `clawket task create` 또는 `clawket task update <ID> --status in_progress`를 실행하세요.',
    },
  }));
  process.exit(0);
}

function finishOpenRuns(clawket, sessionId) {
  if (!sessionId) return;
  let runs = [];
  try {
    runs = JSON.parse(exec(`${clawket} run list --session-id "${sessionId}"`) || '[]');
  } catch {}
  for (const run of runs) {
    if (!run.ended_at) {
      exec(`${clawket} run finish "${run.id}" --result session_ended --notes "Auto-closed by Codex Stop hook"`);
    }
  }
}

function runPostToolUse() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const sessionId = sessionIdFrom(hookInput);
  if (!sessionId) process.exit(0);

  const toolName = hookInput.tool_name || '';
  if (toolName !== 'Bash') process.exit(0);
  const cmd = (hookInput.tool_input?.command || '').trim();
  if (!cmd.includes('apply_patch')) process.exit(0);

  let runs = [];
  try {
    runs = JSON.parse(exec(`${clawket} run list --session-id "${sessionId}"`) || '[]');
  } catch {}
  const activeRun = runs.find((run) => !run.ended_at);
  if (!activeRun) process.exit(0);

  exec(`${clawket} task append-body "${activeRun.task_id}" --text "\n[apply_patch] Codex patch applied"`);
}

function runStop() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  finishOpenRuns(clawket, sessionIdFrom(hookInput));
}

module.exports = {
  runPostToolUse,
  runPreToolUse,
  runSessionStart,
  runStop,
  runUserPromptSubmit,
};
