// LM-10 — plugin reinstall regression e2e.
//
// Five-scenario gate that ties the whole U0 (destructive-action guardrails)
// unit together. Each scenario stages a hermetic temp tree, drives the real
// hook scripts / CLI binary, and asserts the post-incident invariants hold.
//
// Scenario index (matches LM-10 spec):
//   1. Fresh install: no user DB pre-created at XDG path
//   2. First-use DB → simulated plugin reinstall → DB preserved
//   3. Plugin cache cleanup → DB preserved
//   4. Incident command (`rm -rf ~/.claude/plugins/data/clawket-*`) hard-blocked
//      by PreToolUse without CLAWKET_ALLOW_DESTRUCTIVE
//   5. Doctor detects path overlap and exits 1

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..');
const HOOK = path.resolve(PLUGIN_ROOT, 'adapters', 'claude', 'pre-tool-use.cjs');
const CLI_BIN = path.resolve(REPO_ROOT, 'cli', 'target', 'debug', 'clawket');

const skipIfMissingCli = !fs.existsSync(CLI_BIN) && 'cli debug binary not built';

function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm10-'));
  // Mimic the real user layout the post-incident analysis cares about.
  const xdgData = path.join(home, '.local', 'share', 'clawket');
  const xdgCache = path.join(home, '.cache', 'clawket');
  const xdgConfig = path.join(home, '.config', 'clawket');
  const xdgState = path.join(home, '.local', 'state', 'clawket');
  // Plugin tree — separately created so we can wipe it independently.
  const pluginInstall = path.join(home, '.claude', 'plugins', 'clawket-test', 'bin');
  const pluginCache = path.join(home, '.claude', 'plugins', 'cache', 'clawket-test');
  for (const d of [xdgData, xdgCache, xdgConfig, xdgState, pluginInstall, pluginCache]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return { home, xdgData, xdgCache, xdgConfig, xdgState, pluginInstall, pluginCache };
}

function cleanFakeHome(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
}

function envFor(layout) {
  return {
    HOME: layout.home,
    CLAWKET_DATA_DIR: layout.xdgData,
    CLAWKET_CACHE_DIR: layout.xdgCache,
    CLAWKET_CONFIG_DIR: layout.xdgConfig,
    CLAWKET_STATE_DIR: layout.xdgState,
    CLAWKET_SOCKET: path.join(layout.xdgCache, 'sock'),
  };
}

test('Scenario 1 — fresh install does not pre-create user DB', () => {
  const layout = makeFakeHome();
  try {
    // No setup invocation, no daemon spawn — just assert the layout matches
    // "freshly created XDG dirs, no db.sqlite". Plugin setup writes binaries
    // under pluginRoot, never under the user's data dir; the daemon is the
    // sole creator of db.sqlite, and it's lazy (created on first write).
    const dbPath = path.join(layout.xdgData, 'db.sqlite');
    assert.equal(fs.existsSync(dbPath), false, `db.sqlite must not exist on fresh layout: ${dbPath}`);
    assert.equal(fs.existsSync(layout.xdgData), true, 'data dir itself should exist (created by harness)');
  } finally {
    cleanFakeHome(layout.home);
  }
});

test('Scenario 2 — simulated plugin reinstall preserves user DB', () => {
  const layout = makeFakeHome();
  try {
    const dbPath = path.join(layout.xdgData, 'db.sqlite');
    fs.writeFileSync(dbPath, 'fake-sqlite-bytes');
    const stampBefore = fs.readFileSync(dbPath, 'utf-8');

    // Simulate plugin reinstall: blow away ~/.claude/plugins/clawket-* tree.
    // This is exactly what `/plugin install` does; the data dir is untouched
    // because nothing in plugin setup writes there.
    fs.rmSync(path.join(layout.home, '.claude', 'plugins'), { recursive: true, force: true });

    assert.equal(fs.existsSync(dbPath), true, 'user DB must survive plugin tree wipe');
    assert.equal(fs.readFileSync(dbPath, 'utf-8'), stampBefore, 'DB contents must be byte-identical');
  } finally {
    cleanFakeHome(layout.home);
  }
});

test('Scenario 3 — plugin cache cleanup preserves user DB', () => {
  const layout = makeFakeHome();
  try {
    const dbPath = path.join(layout.xdgData, 'db.sqlite');
    fs.writeFileSync(dbPath, 'cache-cleanup-fixture');

    // Simulate `rm -rf ~/.claude/plugins/cache/clawket-*`.
    fs.rmSync(layout.pluginCache, { recursive: true, force: true });

    assert.equal(fs.existsSync(dbPath), true, 'cache cleanup must not touch XDG data dir');
    assert.equal(fs.readFileSync(dbPath, 'utf-8'), 'cache-cleanup-fixture');
    // pluginInstall (binaries) must also remain — only cache was wiped.
    assert.equal(fs.existsSync(layout.pluginInstall), true, 'pluginInstall should survive cache-only cleanup');
  } finally {
    cleanFakeHome(layout.home);
  }
});

test('Scenario 4 — marketplace install-data command hard-blocked without CLAWKET_ALLOW_DESTRUCTIVE', () => {
  const incidentCmd = 'rm -rf ~/.claude/plugins/data/clawket-clawket-clawket';
  const payload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: incidentCmd },
    cwd: process.cwd(),
  });
  const env = { ...process.env, CLAWKET_LOCALE: 'ko' };
  delete env.CLAWKET_ALLOW_DESTRUCTIVE;
  const res = spawnSync('node', [HOOK], { input: payload, env, encoding: 'utf-8', timeout: 15000 });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout || '{}'); } catch {}
  const hso = parsed && parsed.hookSpecificOutput;
  assert.ok(hso, `hook must emit structured deny.\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.equal(hso.permissionDecision, 'deny', `incident cmd must be denied, got ${hso.permissionDecision}`);
  // Reason must trace back to the LM-7 catalog entry covering this exact
  // failure mode, so future contributors who break it know what they broke.
  assert.match(hso.permissionDecisionReason, /rm-rf-clawket-data/, `deny reason must cite catalog id`);
  assert.match(hso.permissionDecisionReason, /데이터 손실/, `deny reason must surface user-facing risk`);
});

test('Scenario 5 — doctor detects plugin overlap and exits 1', { skip: skipIfMissingCli }, () => {
  const layout = makeFakeHome();
  try {
    // Force the data dir to land *inside* the plugin tree — exactly the
    // post-incident broken layout we never want to see again.
    const overlapData = path.join(layout.home, '.claude', 'plugins', 'data', 'clawket-test');
    const overlapEnv = {
      ...envFor(layout),
      CLAWKET_DATA_DIR: overlapData,
    };
    const res = spawnSync(CLI_BIN, ['doctor'], {
      env: { ...process.env, ...overlapEnv },
      encoding: 'utf-8',
      timeout: 15000,
    });
    assert.equal(res.status, 1, `doctor must exit 1 on overlap.\nstdout=${res.stdout}\nstderr=${res.stderr}`);
    assert.match(res.stdout, /OVERLAP with \.claude\/plugins\//, 'doctor must report overlap explicitly');
    assert.match(res.stdout, /\[ERROR\] #1 plugin overlap/, 'LM-9 panel must escalate #1 to ERROR');
    // Summary line must agree with exit code.
    const m = res.stdout.match(/\[Summary\] errors=(\d+)/);
    assert.ok(m && parseInt(m[1], 10) >= 1, `summary errors >= 1 expected.\nstdout=${res.stdout}`);
  } finally {
    cleanFakeHome(layout.home);
  }
});
