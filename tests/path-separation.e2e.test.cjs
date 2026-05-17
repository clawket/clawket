// LM-8 — path separation invariant e2e.
//
// Asserts that both runtime entry points refuse a layout where Clawket user
// data resolves under Claude Code's plugin directory:
//
//   * `clawket doctor`  exits 1 and prints the structured remediation block
//   * `clawketd status` (any subcommand triggering Paths::resolve) bails with
//     the same invariant message via anyhow chain
//
// Skipped (with a clear console note, not a failure) when the debug binaries
// haven't been built yet — CI is responsible for `cargo build` before test.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_BIN = path.resolve(REPO_ROOT, 'cli', 'target', 'debug', 'clawket');
const DAEMON_BIN = path.resolve(REPO_ROOT, 'daemon', 'target', 'debug', 'clawketd');

const OVERLAP_DATA = '/tmp/lm8-fake-home/.claude/plugins/data/clawket-test';
const SAFE_SOCKET = '/tmp/lm8-test-sock-' + process.pid + '.sock';

function run(bin, args, env) {
  return spawnSync(bin, args, {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 15000,
  });
}

test('clawket doctor exits 1 when data dir overlaps plugin tree', { skip: !fs.existsSync(CLI_BIN) && 'cli debug binary not built' }, () => {
  const res = run(CLI_BIN, ['doctor'], {
    CLAWKET_DATA_DIR: OVERLAP_DATA,
    CLAWKET_SOCKET: SAFE_SOCKET,
  });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}.\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout, /Path separation invariant \(LM-8\)/);
  assert.match(res.stdout, /OVERLAP with \.claude\/plugins\//);
  assert.match(res.stderr, /CLAWKET_ALLOW_PLUGIN_OVERLAP=1 acknowledges the risk/);
});

test('clawket doctor exits 0 on safe XDG layout', { skip: !fs.existsSync(CLI_BIN) && 'cli debug binary not built' }, () => {
  // Use /tmp paths so the run is hermetic (won't write into the user's real
  // ~/.local/share/clawket). The doctor doesn't *create* dirs, only reports.
  const res = run(CLI_BIN, ['doctor'], {
    CLAWKET_DATA_DIR: '/tmp/lm8-safe/data',
    CLAWKET_CACHE_DIR: '/tmp/lm8-safe/cache',
    CLAWKET_CONFIG_DIR: '/tmp/lm8-safe/config',
    CLAWKET_STATE_DIR: '/tmp/lm8-safe/state',
    CLAWKET_SOCKET: SAFE_SOCKET,
  });
  // Daemon connectivity may fail in CI (no daemon running). We only assert the
  // invariant section passes, not the network probe.
  assert.match(res.stdout, /data path \/ plugin path separation: OK/, `stdout=${res.stdout}`);
  assert.notEqual(res.status, 1, `expected non-1 exit (overlap section passed), got ${res.status}`);
});

test('clawketd refuses to start when data dir overlaps plugin tree', { skip: !fs.existsSync(DAEMON_BIN) && 'daemon debug binary not built' }, () => {
  const res = run(DAEMON_BIN, ['status'], {
    CLAWKET_DATA_DIR: OVERLAP_DATA,
    CLAWKET_SOCKET: SAFE_SOCKET,
  });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}.\nstderr=${res.stderr}`);
  assert.match(res.stderr, /overlaps with Claude Code plugin dir/);
  assert.match(res.stderr, /CLAWKET_ALLOW_PLUGIN_OVERLAP=1/);
});

test('clawketd accepts overlap when CLAWKET_ALLOW_PLUGIN_OVERLAP=1', { skip: !fs.existsSync(DAEMON_BIN) && 'daemon debug binary not built' }, () => {
  const res = run(DAEMON_BIN, ['status'], {
    CLAWKET_DATA_DIR: OVERLAP_DATA,
    CLAWKET_SOCKET: SAFE_SOCKET,
    CLAWKET_ALLOW_PLUGIN_OVERLAP: '1',
  });
  // status sub-command may itself exit 0 (alive) or non-zero (no daemon) but
  // crucially must NOT bail on the invariant guard. We assert by stderr shape.
  assert.match(res.stderr, /CLAWKET_ALLOW_PLUGIN_OVERLAP is set so continuing/, `stderr=${res.stderr}`);
  assert.doesNotMatch(res.stderr, /Plugin reinstall will destroy this data\. Point CLAWKET_DATA_DIR/, 'invariant must not bail when bypass is set');
});
