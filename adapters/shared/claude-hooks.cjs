const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const {
  cacheDir,
  clawketBin,
  ensureXdgDirs,
  exec,
  readHookInput,
  readJson,
  readPromptFiles,
  resolvePluginRoot,
  writeJson,
} = require('./common.cjs');
const { buildSummary, parseInProgressTasks } = require('./session-context.cjs');

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

function readOnlyBashPatterns() {
  return [
    /^(npx\s+)?tsc(\s|$)/,
    /^(npx\s+)?eslint(\s|$)/,
    /^(npx\s+)?prettier(\s|$)/,
    /^(npm|pnpm|yarn|bun)\s+test/,
    /^(npm|pnpm|yarn|bun)\s+run\s+(test|lint|check|typecheck|build)/,
    /^(npx|pnpm\s+exec)\s+vitest/,
    /^(npx|pnpm\s+exec)\s+jest/,
    /^git\s+(status|log|diff|show|branch|stash\s+list|remote|tag)/,
    /^(ls|pwd|wc|du|df|which|where|type|file|stat)\b/,
    /^(cat|head|tail|less|more)\s/,
    /^(curl|wget)\s/,
    /^(node|python3?|ruby)\s+-e\s/,
    /^echo\s/,
    /^(docker|podman)\s+(ps|images|logs|inspect)/,
    /^cargo\s+(check|test|clippy)/,
    /^lsof\s/,
  ];
}

function installModule(modDir, label) {
  const nodeModules = path.resolve(modDir, 'node_modules');
  if (!fs.existsSync(path.resolve(modDir, 'package.json'))) return;
  if (fs.existsSync(nodeModules)) return;
  process.stderr.write(`[clawket] Installing ${label} dependencies...\n`);
  const npmrc = path.resolve(modDir, '.npmrc');
  if (!fs.existsSync(npmrc)) {
    fs.writeFileSync(npmrc, 'node-linker=hoisted\n');
  }
  try {
    exec('pnpm --version');
    exec('pnpm install --prod', { cwd: modDir, stdio: ['pipe', 'pipe', process.stderr], timeout: 120000 });
    process.stderr.write(`[clawket] ${label} dependencies installed (pnpm)\n`);
  } catch {
    try {
      exec('npm install --production', { cwd: modDir, stdio: ['pipe', 'pipe', process.stderr], timeout: 120000 });
      process.stderr.write(`[clawket] ${label} dependencies installed (npm)\n`);
    } catch (error) {
      process.stderr.write(`[clawket] ERROR: Failed to install ${label} dependencies: ${error.message}\n`);
    }
  }
}

function ensureDeps(pluginRoot) {
  installModule(path.resolve(pluginRoot, 'daemon'), 'daemon');
  installModule(path.resolve(pluginRoot, 'mcp'), 'mcp');
}

function ensureDaemon(clawket, pluginRoot) {
  ensureDeps(pluginRoot);
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

function apiPost(port, pathname, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

function runSessionStart() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  ensureDaemon(clawket, pluginRoot);

  const cwd = process.env.HOOK_CWD || process.cwd();
  const context = exec(`${clawket} dashboard --cwd "${cwd}" --show active`);
  const rules = readPromptFiles(pluginRoot, ['prompts/shared/rules.md', 'prompts/claude/runtime.md']);
  const webUrl = getWebUrl();

  if (!context) {
    const noProjectMsg = `Clawket: No project registered for this directory.\nRun: clawket project create "<name>" --cwd "${cwd}"`;
    const statusLine = webUrl ? `  Web: ${webUrl}` : '';
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: noProjectMsg + (rules ? `\n\n${rules}` : ''),
      },
      systemMessage: `Clawket active — no project for this directory${statusLine ? `\n${statusLine}` : ''}`,
    }));
    process.exit(0);
  }

  const summary = buildSummary(context);
  const statusLine = webUrl ? `Daemon: running Web: ${webUrl}` : 'Daemon: running';
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context + (rules ? `\n\n${rules}` : ''),
    },
    systemMessage: `${summary}\n${statusLine}`,
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
  if (inProgressTasks.length > 0) {
    const taskList = inProgressTasks
      .map((task) => `- [${task.id}] ${task.title}${task.meta ? ` (${task.meta})` : ''}`)
      .join('\n');
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `# Active Clawket Tasks\n${taskList}`,
      },
    }));
    return;
  }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: '# Clawket: 활성 태스크 없음 — 작업 전 태스크 등록 필요',
    },
  }));
}

function runPreToolUse() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const toolName = hookInput.tool_name || process.env.HOOK_TOOL_NAME || '';
  const toolInput = hookInput.tool_input || {};

  const readOnly = new Set([
    'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
    'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
    'ToolSearch', 'Skill', 'ScheduleWakeup',
    'mcp__playwright__browser_snapshot', 'mcp__playwright__browser_take_screenshot',
    'mcp__playwright__browser_navigate', 'mcp__playwright__browser_click',
    'mcp__playwright__browser_console_messages', 'mcp__playwright__browser_resize',
  ]);
  const taskTools = new Set(['TaskCreate', 'TaskUpdate']);
  const agentTools = new Set(['Agent', 'TeamCreate', 'SendMessage']);
  const mutatingTools = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit']);

  if (readOnly.has(toolName)) allow();
  if (!agentTools.has(toolName) && !mutatingTools.has(toolName) && !taskTools.has(toolName)) allow();

  if (toolName === 'Bash') {
    const cmd = (toolInput.command || '').trim();
    if (cmd.startsWith('clawket ') || cmd.includes('clawket ')) allow();
    if (readOnlyBashPatterns().some((re) => re.test(cmd))) allow();
  }

  const cwd = hookInput.cwd || process.env.HOOK_CWD || process.cwd();
  const context = exec(`${clawket} dashboard --cwd "${cwd}" --show active`);
  if (!context) allow();

  const tasksJson = exec(`${clawket} task list --status in_progress`);
  let inProgressTasks = [];
  try { inProgressTasks = JSON.parse(tasksJson || '[]'); } catch {}

  if (inProgressTasks.length === 0) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Clawket: 활성 태스크가 없습니다. 작업 전 `clawket task create` 또는 `clawket task update <ID> --status in_progress`를 실행하세요.',
      },
    }));
    process.exit(0);
  }

  if (agentTools.has(toolName)) {
    const agentName = toolInput.name || '';
    if (agentName) {
      let taskForAgent = inProgressTasks.find((task) => task.assignee === agentName);
      if (!taskForAgent) {
        const todoJson = exec(`${clawket} task list --status todo`);
        let todoTasks = [];
        try { todoTasks = JSON.parse(todoJson || '[]'); } catch {}
        const todoForAgent = todoTasks.find((task) => task.assignee === agentName);
        if (todoForAgent) {
          exec(`${clawket} task update "${todoForAgent.id}" --status in_progress`);
          taskForAgent = todoForAgent;
        } else {
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `Clawket: "${agentName}"에 대한 태스크가 없습니다. \`clawket task create --assignee ${agentName}\`으로 먼저 등록하세요.`,
            },
          }));
          process.exit(0);
        }
      }

      const pendingFile = path.join(cacheDir(), 'agent-pending.json');
      const pending = readJson(pendingFile, []);
      pending.push({
        name: agentName,
        task_id: taskForAgent.id,
        subagent_type: toolInput.subagent_type || 'general-purpose',
        ts: Date.now(),
      });
      writeJson(pendingFile, pending);

      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `\n\n---\n[Clawket] 작업 티켓: ${taskForAgent.ticket_number} — ${taskForAgent.title}\nTask ID: ${taskForAgent.id}`,
        },
      }));
      process.exit(0);
    }
  }

  allow();
}

function runPostToolUse() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const sessionId = process.env.CLAUDE_SESSION_ID || '';
  const hookInput = readHookInput();
  const toolName = hookInput.tool_name || '';
  const toolInput = hookInput.tool_input || {};

  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = toolInput.file_path || '';
    if (!filePath || !sessionId) process.exit(0);
    try {
      const runsJson = exec(`${clawket} run list --session-id "${sessionId}"`);
      const runs = JSON.parse(runsJson || '[]');
      const activeRun = runs.find((run) => !run.ended_at);
      if (activeRun) {
        exec(`${clawket} task append-body "${activeRun.task_id}" --text "\n[${toolName}] ${filePath}"`);
      } else {
        const portFile = path.join(cacheDir(), 'clawketd.port');
        const port = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf-8').trim() : null;
        if (port) {
          apiPost(port, '/activity', {
            entity_type: 'task',
            entity_id: 'session',
            action: 'updated',
            field: 'file_edit',
            new_value: `[${toolName}] ${filePath}`,
            actor: 'main',
          });
        }
      }
    } catch {}
  }
}

function runPlanSync() {
  const plansDir = path.resolve(os.homedir(), '.claude', 'plans');
  const now = Date.now();
  const files = (() => {
    try {
      return fs.readdirSync(plansDir)
        .filter((file) => file.endsWith('.md'))
        .map((file) => ({ path: path.resolve(plansDir, file), mtime: fs.statSync(path.resolve(plansDir, file)).mtimeMs }))
        .filter((file) => now - file.mtime < 120_000)
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  })();

  if (!files.length) allow();

  const planFile = files[0].path;
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `# Clawket: Plan Mode 종료 — 클라켓에 등록 필요

ExitPlanMode로 승인된 플랜 파일: \`${planFile}\`

이 플랜을 클라켓에 등록하세요:
1. \`clawket plan create\` 또는 기존 플랜에 Unit/Task 추가
2. \`clawket unit create\` — 각 Unit 등록
3. \`clawket task create\` — 각 Task 등록 (--assignee, --priority 포함)
4. 모든 Task는 active Cycle에 배정

플랜 파일을 직접 Read해서 내용을 파악하고, clawket CLI로 등록하세요.
파일을 파싱하지 않고 당신이 직접 이해해서 구조화하세요.`,
    },
  }));
}

function runSubagentStart() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const agentId = hookInput.agent_id || '';
  const agentType = hookInput.agent_type || 'general-purpose';
  if (!agentId) process.exit(0);

  const pendingFile = path.join(cacheDir(), 'agent-pending.json');
  const pending = readJson(pendingFile, []);
  if (!pending.length) process.exit(0);

  const idx = pending.findIndex((entry) => (entry.subagent_type || 'general-purpose') === (agentType || 'general-purpose'));
  if (idx === -1) process.exit(0);
  const matched = pending.splice(idx, 1)[0];
  if (pending.length) writeJson(pendingFile, pending);
  else if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);
  exec(`${clawket} task update "${matched.task_id}" --agent-id "${agentId}"`);
}

function runSubagentStop() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const agentId = hookInput.agent_id || '';
  if (!agentId) process.exit(0);

  let tasks = [];
  try { tasks = JSON.parse(exec(`${clawket} task list --status in_progress --agent-id "${agentId}"`) || '[]'); } catch {}
  if (!tasks.length) process.exit(0);

  const task = tasks[0];
  const lastMsg = hookInput.last_assistant_message || '';
  const summary = lastMsg.length > 500 ? `${lastMsg.slice(0, 500)}...` : lastMsg;
  if (summary) exec(`${clawket} task append-body "${task.id}" --text "\n[SubagentStop] ${summary.replace(/"/g, '\\"')}"`);
  exec(`${clawket} task update "${task.id}" --status done --comment "자동 완료: 에이전트 종료 (agent_id: ${agentId})"`);
}

function runTaskCreated() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const teammateName = hookInput.teammate_name || '';
  if (!teammateName) process.exit(0);
  let tasks = [];
  try { tasks = JSON.parse(exec(`${clawket} task list --status todo`) || '[]'); } catch {}
  const task = tasks.find((item) => item.assignee === teammateName);
  if (task) exec(`${clawket} task update "${task.id}" --status in_progress --comment "자동 시작: 팀 에이전트 ${teammateName} 태스크 생성"`);
}

function runTaskCompleted() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const hookInput = readHookInput();
  const teammateName = hookInput.teammate_name || '';
  if (!teammateName) process.exit(0);
  let tasks = [];
  try { tasks = JSON.parse(exec(`${clawket} task list --status in_progress`) || '[]'); } catch {}
  const task = tasks.find((item) => item.assignee === teammateName);
  if (task) exec(`${clawket} task update "${task.id}" --status done --comment "자동 완료: 팀 에이전트 ${teammateName} 태스크 완료"`);
}

function runStop() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  const { clawket } = runtime(pluginRoot);
  const sessionId = process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) process.exit(0);

  try {
    const runs = JSON.parse(exec(`${clawket} run list --session-id "${sessionId}"`) || '[]');
    for (const run of runs) {
      if (!run.ended_at) exec(`${clawket} run finish "${run.id}" --result session_ended --notes "Auto-closed by Stop hook"`);
    }
  } catch {}
}

function runSetup() {
  const pluginRoot = resolvePluginRoot(path.dirname(__filename));
  ensureXdgDirs();
  ensureDeps(pluginRoot);

  const binDir = path.resolve(pluginRoot, 'bin');
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
  const cliBin = path.resolve(binDir, 'clawket');
  if (fs.existsSync(cliBin)) {
    process.stderr.write('[clawket-setup] CLI binary found\n');
    return;
  }

  const cliDir = path.resolve(pluginRoot, 'cli');
  if (fs.existsSync(path.resolve(cliDir, 'Cargo.toml'))) {
    try {
      exec('cargo --version');
      process.stderr.write('[clawket-setup] Building CLI from source...\n');
      exec('cargo build --release', { cwd: cliDir, timeout: 300000 });
      const built = path.resolve(cliDir, 'target', 'release', 'clawket');
      if (fs.existsSync(built)) {
        fs.copyFileSync(built, cliBin);
        fs.chmodSync(cliBin, 0o755);
        process.stderr.write('[clawket-setup] CLI binary built\n');
      }
    } catch {
      process.stderr.write('[clawket-setup] WARNING: Rust not available. Place clawket binary in bin/\n');
    }
  }
}

module.exports = {
  runPlanSync,
  runPostToolUse,
  runPreToolUse,
  runSessionStart,
  runSetup,
  runStop,
  runSubagentStart,
  runSubagentStop,
  runTaskCompleted,
  runTaskCreated,
  runUserPromptSubmit,
};
