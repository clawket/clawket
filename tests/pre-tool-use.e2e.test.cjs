// LM-7 — PreToolUse e2e: actually spawn the hook script with the same stdin
// envelope Claude Code uses, then assert on the JSON the hook prints.
//
// We require an active task to exist so that we exercise the destructive-block
// path specifically (no-active-task deny path is already covered elsewhere).
// For test isolation we set CLAWKET_ALLOW_DESTRUCTIVE=1 in the bypass case
// and unset it (default) in the block case.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const HOOK = path.resolve(__dirname, '..', 'adapters', 'claude', 'pre-tool-use.cjs');

function callHook(toolInput, toolName = 'Bash', extraEnv = {}) {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    cwd: process.cwd(),
  });
  const res = spawnSync('node', [HOOK], {
    input: payload,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf-8',
    timeout: 15000,
  });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout || '{}'); } catch {}
  return { stdout: res.stdout, stderr: res.stderr, status: res.status, parsed };
}

test('e2e: marketplace install-data command is hard-blocked with structured deny', () => {
  const cmd = 'rm -rf ~/.claude/plugins/data/clawket-clawket-clawket';
  const res = callHook({ command: cmd });
  const hso = res.parsed && res.parsed.hookSpecificOutput;
  assert.ok(hso, `expected hookSpecificOutput, got: ${res.stdout}`);
  assert.equal(hso.hookEventName, 'PreToolUse');
  assert.equal(hso.permissionDecision, 'deny');
  assert.match(hso.permissionDecisionReason, /rm-rf-clawket-data/);
  assert.match(res.stderr, /rm-rf-clawket-data/); // also written to stderr
});

test('e2e: clawket plan delete --force is hard-blocked despite clawket prefix auto-allow', () => {
  // Critical: this case proves that the destructive check fires BEFORE the
  // `cmd.startsWith('clawket ')` auto-allow path, otherwise this would slip
  // through.
  const res = callHook({ command: 'clawket plan delete PLAN-XXX --force' });
  const hso = res.parsed && res.parsed.hookSpecificOutput;
  assert.ok(hso, `expected hookSpecificOutput, got: ${res.stdout}`);
  assert.equal(hso.permissionDecision, 'deny');
  assert.match(hso.permissionDecisionReason, /clawket-delete-force-aggregate/);
});

test('e2e: CLAWKET_ALLOW_DESTRUCTIVE=1 env var must NOT bypass (v3 removed the bypass)', () => {
  const cmd = 'rm -rf ~/.claude/plugins/data/clawket-clawket-clawket';
  const res = callHook({ command: cmd }, 'Bash', { CLAWKET_ALLOW_DESTRUCTIVE: '1' });
  const hso = res.parsed && res.parsed.hookSpecificOutput;
  assert.ok(hso, `expected hookSpecificOutput, got: ${res.stdout}`);
  assert.equal(hso.permissionDecision, 'deny', 'v3 must deny regardless of env var');
  assert.match(hso.permissionDecisionReason, /rm-rf-clawket-data/);
});

test('e2e: safe command (ls) is allowed', () => {
  const res = callHook({ command: 'ls -la' });
  // safe Bash → either allowed (empty {}) or denied for unrelated reason.
  // The point: not denied for destructive pattern.
  if (res.parsed && res.parsed.hookSpecificOutput) {
    const hso = res.parsed.hookSpecificOutput;
    if (hso.permissionDecision === 'deny') {
      assert.doesNotMatch(
        hso.permissionDecisionReason || '',
        /(rm-rf|sqlite-destructive|clawket-delete-force|git-reset-hard|docker-rm-volumes|chmod-zero|find-delete|redirect-overwrite)/,
      );
    }
  }
});
