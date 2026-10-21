// PreToolUse workflow gate: project-scoped state, a pure decision with no
// task-state side effects, and one daemon round trip per gated call.
//
// Run: node --test tests/pre-tool-use-gate.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'adapters', 'claude', 'pre-tool-use.cjs');
const SHARED = path.join(ROOT, 'adapters', 'shared', 'claude-hooks.cjs');
const { __test__: H } = require(SHARED);

const task = (over) => ({
  id: 'TASK-1', ticket_number: 'LM-1', title: 'work', status: 'in_progress', cycle_id: 'CYC-1', tier: 'low', ...over,
});

function state(over = {}) {
  return {
    source: 'test',
    registered: true,
    project: { id: 'PROJ-A', key: 'LM', enabled: true },
    enabled: true,
    inProgress: [task()],
    blockedIds: new Set(),
    todoAssigned: [],
    activePlans: 1,
    activeCycles: 1,
    sessionRun: null,
    ...over,
  };
}

// ── pure decision ─────────────────────────────────────────────────────────
test('decideGate: unregistered cwd and disabled project allow', () => {
  assert.equal(H.decideGate({ toolName: 'Edit', state: state({ registered: false }) }).decision, 'allow');
  assert.equal(H.decideGate({ toolName: 'Edit', state: state({ enabled: false, inProgress: [] }) }).decision, 'allow');
});

test('decideGate: no in_progress task in the project denies', () => {
  const v = H.decideGate({ toolName: 'Edit', state: state({ inProgress: [] }) });
  assert.equal(v.decision, 'deny');
});

test('decideGate: active plan unknown or zero denies; cycle zero denies; cycle unknown passes', () => {
  assert.equal(H.decideGate({ toolName: 'Edit', state: state({ activePlans: null }) }).decision, 'deny');
  assert.equal(H.decideGate({ toolName: 'Edit', state: state({ activePlans: 0 }) }).decision, 'deny');
  assert.equal(H.decideGate({ toolName: 'Edit', state: state({ activeCycles: 0 }) }).decision, 'deny');
  assert.equal(H.decideGate({ toolName: 'Edit', state: state({ activeCycles: null }) }).decision, 'allow');
});

test('decideGate: all in_progress tasks blocked denies', () => {
  const v = H.decideGate({ toolName: 'Edit', state: state({ blockedIds: new Set(['TASK-1']) }) });
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /LM-1/);
});

test('decideGate: mutating tool requires a cycle assignment; agent tools do not', () => {
  const s = state({ inProgress: [task({ cycle_id: null, assignee: 'worker' })] });
  assert.equal(H.decideGate({ toolName: 'Write', state: s }).decision, 'deny');
  assert.equal(H.decideGate({ toolName: 'Agent', toolInput: { name: 'worker' }, state: s }).decision, 'allow');
});

test('decideGate: agent with a running task is bound to it', () => {
  const s = state({ inProgress: [task({ assignee: 'worker' })] });
  const v = H.decideGate({ toolName: 'Agent', toolInput: { name: 'worker' }, state: s });
  assert.equal(v.decision, 'allow');
  assert.equal(v.agentBinding.task.id, 'TASK-1');
  assert.match(v.context, /TASK-1/);
});

test('decideGate: agent whose task is still todo is denied with the explicit start command, state untouched', () => {
  const todo = task({ id: 'TASK-2', ticket_number: 'LM-2', status: 'todo', assignee: 'worker' });
  const s = state({ todoAssigned: [todo] });
  const before = JSON.stringify({ ...s, blockedIds: [...s.blockedIds] });
  const v = H.decideGate({ toolName: 'Agent', toolInput: { name: 'worker' }, state: s });
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /clawket task update LM-2 --status in_progress/);
  assert.equal(JSON.stringify({ ...s, blockedIds: [...s.blockedIds] }), before, 'decision must not mutate state');
  assert.equal(todo.status, 'todo');
});

test('decideGate: agent with no task at all gets the register hint', () => {
  const v = H.decideGate({ toolName: 'Agent', toolInput: { name: 'ghost' }, state: state() });
  assert.equal(v.decision, 'deny');
  assert.match(v.reason, /ghost/);
});

test('decideGate: tier gate uses the session run task when known', () => {
  const s = state({
    inProgress: [task(), task({ id: 'TASK-9', ticket_number: 'LM-9', tier: 'high' })],
    sessionRun: { id: 'RUN-1', task_id: 'TASK-9' },
  });
  const deny = H.decideGate({ toolName: 'Edit', state: s, modelId: 'claude-haiku-3' });
  assert.equal(deny.decision, 'deny');
  assert.match(deny.reason, /TASK-9/);
  const allow = H.decideGate({ toolName: 'Edit', state: s, modelId: 'claude-opus-4' });
  assert.equal(allow.decision, 'allow');
  assert.equal(allow.context, 'CLAWKET_TIER_USED=high');
});

test('scopeTasksToProject drops tasks numbered under another project key', () => {
  const tasks = [task(), task({ id: 'TASK-X', ticket_number: 'OTHER-7' }), task({ id: 'TASK-N', ticket_number: null })];
  assert.deepEqual(H.scopeTasksToProject(tasks, { id: 'PROJ-A', key: 'LM' }).map((t) => t.id), ['TASK-1']);
  assert.equal(H.scopeTasksToProject(tasks, { id: 'PROJ-A', key: null }).length, 3);
});

test('normalizeGateState maps the endpoint contract', () => {
  const s = H.normalizeGateState({
    contract: 1,
    project: { id: 'PROJ-A', key: 'LM', name: 'a', enabled: false },
    in_progress: [task()],
    blocked_ids: ['TASK-1'],
    todo_assigned: [],
    active_plan_count: 2,
    active_cycle_count: 0,
    session_run: null,
  });
  assert.equal(s.registered, true);
  assert.equal(s.enabled, false);
  assert.equal(s.blockedIds.has('TASK-1'), true);
  assert.equal(s.activePlans, 2);
  assert.equal(s.activeCycles, 0);
  assert.equal(H.normalizeGateState({ contract: 1, project: null }).registered, false);
});

// ── e2e: real hook process against a fake daemon + fake CLI ──────────────
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawket-gate-'));
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const cliLog = path.join(dir, 'cli.log');
  const bin = path.join(dir, 'clawket');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(cliLog)}, JSON.stringify(args) + '\\n');
const fx = JSON.parse(process.env.FAKE_CLI || '{}');
const key = args.slice(0, 2).join(' ');
if (key === 'project resolve') console.log(JSON.stringify(fx.project ?? null));
else if (key === 'dashboard') console.log(fx.dashboard ?? 'dashboard');
else if (key === 'task list') {
  const i = args.indexOf('--status');
  const want = i >= 0 ? args[i + 1].split(',') : null;
  console.log(JSON.stringify((fx.tasks || []).filter((t) => !want || want.includes(t.status))));
}
else if (key === 'plan list') console.log(JSON.stringify(fx.plans ?? [{ id: 'PLAN-1' }]));
else if (key === 'cycle list') console.log(JSON.stringify(fx.cycles ?? [{ id: 'CYC-1' }]));
else console.log('{}');
`);
  fs.chmodSync(bin, 0o755);
  return {
    dir,
    cache,
    bin,
    cliCalls() {
      try { return fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function withDaemon(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function runHook(sb, port, payload, fakeCli = {}) {
  if (port) fs.writeFileSync(path.join(sb.cache, 'clawketd.port'), String(port));
  const env = { ...process.env };
  for (const k of ['CODEX_PLUGIN_ROOT', 'CLAWKET_ROOT', 'CLAUDE_CODE_MODEL_ID', 'CLAUDE_MODEL', 'CLAWKET_SYNC_CONTEXT', 'CLAUDE_SESSION_ID']) delete env[k];
  Object.assign(env, {
    HOME: sb.dir,
    XDG_STATE_HOME: path.join(sb.dir, 'state'),
    CLAWKET_CACHE_DIR: sb.cache,
    CLAWKET_HOOK_LOG_DIR: path.join(sb.dir, 'log'),
    CLAWKET_BIN: sb.bin,
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAWKET_QUIET: '1',
    CLAWKET_MODEL_ID: 'claude-opus-4',
    FAKE_CLI: JSON.stringify(fakeCli),
  });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}
      resolve({ status, stdout, stderr, decision: parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision, parsed });
    });
    child.stdin.end(JSON.stringify({ cwd: '/work/proj', session_id: 'S1', ...payload }));
  });
}

function gateHandler(body, seen) {
  return (req, res) => {
    seen.push(req.url);
    if (req.url.startsWith('/gate/pre-tool-use')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  };
}

const GATE_BODY = {
  contract: 1,
  project: { id: 'PROJ-A', key: 'LM', name: 'a', enabled: true },
  in_progress: [task()],
  blocked_ids: [],
  todo_assigned: [],
  active_plan_count: 1,
  active_cycle_count: 1,
  session_run: null,
};

test('e2e: gated Edit uses one daemon call and zero CLI subprocesses', async () => {
  const sb = makeSandbox();
  const seen = [];
  try {
    const r = await withDaemon(gateHandler(GATE_BODY, seen), (port) => runHook(sb, port, { tool_name: 'Edit', tool_input: { file_path: 'x' } }));
    assert.equal(r.decision, 'allow', r.stdout + r.stderr);
    assert.equal(r.status, 0);
    assert.deepEqual(seen.map((u) => u.split('?')[0]), ['/gate/pre-tool-use']);
    assert.match(seen[0], /cwd=%2Fwork%2Fproj/);
    assert.match(seen[0], /session=S1/);
    assert.deepEqual(sb.cliCalls(), []);
  } finally { sb.cleanup(); }
});

test('e2e: endpoint with no in-project task denies (a foreign in_progress task does not count)', async () => {
  const sb = makeSandbox();
  try {
    const body = { ...GATE_BODY, in_progress: [] };
    const r = await withDaemon(gateHandler(body, []), (port) => runHook(sb, port, { tool_name: 'Write', tool_input: { file_path: 'x' } }));
    assert.equal(r.decision, 'deny');
    assert.equal(r.status, 0, 'deny must exit 0 so Claude Code reads the JSON decision');
  } finally { sb.cleanup(); }
});

test('e2e: Agent dispatch for a todo task is denied and never runs `task update`', async () => {
  const sb = makeSandbox();
  try {
    const body = { ...GATE_BODY, todo_assigned: [task({ id: 'TASK-2', ticket_number: 'LM-2', status: 'todo', assignee: 'worker' })] };
    const r = await withDaemon(gateHandler(body, []), (port) => runHook(sb, port, { tool_name: 'Agent', tool_input: { name: 'worker', prompt: 'go' } }));
    assert.equal(r.decision, 'deny');
    assert.match(r.parsed.hookSpecificOutput.permissionDecisionReason, /--status in_progress/);
    assert.equal(sb.cliCalls().filter((a) => a[0] === 'task' && a[1] === 'update').length, 0);
  } finally { sb.cleanup(); }
});

test('e2e: legacy fallback (daemon without the endpoint) scopes tasks to the project', async () => {
  const sb = makeSandbox();
  try {
    const fakeCli = {
      project: { id: 'PROJ-A', key: 'LM', enabled: 1 },
      tasks: [task({ id: 'TASK-X', ticket_number: 'OTHER-1' })],
    };
    // A daemon that predates the endpoint: every route 404s.
    const notFound = (req, res) => { res.writeHead(404); res.end(); };
    const r = await withDaemon(notFound, (port) => runHook(sb, port, { tool_name: 'Edit', tool_input: {} }, fakeCli));
    assert.equal(r.decision, 'deny', 'a task from another project must not satisfy the gate');
    const calls = sb.cliCalls();
    assert.ok(calls.length <= 5, `fallback should need at most 5 CLI calls, made ${calls.length}: ${JSON.stringify(calls)}`);
    const list = calls.find((a) => a[0] === 'task' && a[1] === 'list');
    assert.ok(list.includes('--project') && list.includes('PROJ-A'), 'task list must be project-filtered');
  } finally { sb.cleanup(); }
});

test('e2e: legacy fallback allows an in-project task', async () => {
  const sb = makeSandbox();
  try {
    const fakeCli = { project: { id: 'PROJ-A', key: 'LM', enabled: 1 }, tasks: [task()] };
    const r = await runHook(sb, null, { tool_name: 'Edit', tool_input: {} }, fakeCli);
    assert.equal(r.decision, 'allow', r.stdout + r.stderr);
  } finally { sb.cleanup(); }
});

test('e2e: Bash fast paths — chained mutation is gated, read-only and clawket pass', async () => {
  const sb = makeSandbox();
  try {
    const body = { ...GATE_BODY, in_progress: [] };
    await withDaemon(gateHandler(body, []), async (port) => {
      for (const cmd of ['cat README.md; rm -rf src', 'ls && rm -rf src', 'rm -rf src # clawket ', 'echo clawket && rm -rf src', 'sed -i s/a/b/ f']) {
        const r = await runHook(sb, port, { tool_name: 'Bash', tool_input: { command: cmd } });
        assert.equal(r.decision, 'deny', `${cmd} must reach the gate`);
      }
      for (const cmd of ['ls -la', 'git status && git diff --stat', 'clawket task list | jq .', 'command -v jq']) {
        const r = await runHook(sb, port, { tool_name: 'Bash', tool_input: { command: cmd } });
        assert.equal(r.decision, 'allow', `${cmd} is read-only: ${r.stdout}`);
      }
    });
  } finally { sb.cleanup(); }
});

test('e2e: verification commands are allowed without a task and recorded', async () => {
  const sb = makeSandbox();
  try {
    const body = { ...GATE_BODY, in_progress: [] };
    const r = await withDaemon(gateHandler(body, []), (port) => runHook(sb, port, { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }));
    assert.equal(r.decision, 'allow');
    const log = fs.readFileSync(path.join(sb.dir, 'log', 'hook.log'), 'utf8');
    assert.match(log, /"event":"verification_command"/);
    assert.match(log, /pnpm test/);
  } finally { sb.cleanup(); }
});

test('e2e: literal mention of a destructive command in a heredoc is not hard-denied', async () => {
  const sb = makeSandbox();
  try {
    const cmd = `cat > notes.md <<'EOF'\n${['git', 'reset', '--hard'].join(' ')}\nEOF`;
    const r = await withDaemon(gateHandler(GATE_BODY, []), (port) => runHook(sb, port, { tool_name: 'Bash', tool_input: { command: cmd } }));
    assert.equal(r.decision, 'allow', r.stdout);
  } finally { sb.cleanup(); }
});
