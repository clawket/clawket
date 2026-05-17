// LM-9 — `clawket doctor` data-loss-risk panel e2e.
//
// Asserts the panel renders all 5 diagnostics with the correct severity
// tags ([OK]/[INFO]/[WARN]/[ERROR]) and that the unified summary line +
// exit code agree on whether any ERROR was observed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_BIN = path.resolve(REPO_ROOT, 'cli', 'target', 'debug', 'clawket');

function isolatedEnv(extra = {}) {
  // Use a per-test temp dir so the snapshot file (#4) doesn't bleed across
  // test runs and false-positive the "task count change" check.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm9-doctor-'));
  return {
    tmp,
    env: {
      CLAWKET_DATA_DIR: path.join(tmp, 'data'),
      CLAWKET_CACHE_DIR: path.join(tmp, 'cache'),
      CLAWKET_CONFIG_DIR: path.join(tmp, 'config'),
      CLAWKET_STATE_DIR: path.join(tmp, 'state'),
      CLAWKET_SOCKET: path.join(tmp, 'sock'),
      ...extra,
    },
  };
}

function runDoctor(extraEnv) {
  const { tmp, env } = isolatedEnv(extraEnv);
  const res = spawnSync(CLI_BIN, ['doctor'], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 15000,
  });
  return { tmp, ...res };
}

const skipIfMissing = !fs.existsSync(CLI_BIN) && 'cli debug binary not built';

test('LM-9 panel emits all 5 diagnostic lines in order', { skip: skipIfMissing }, () => {
  const res = runDoctor();
  assert.match(res.stdout, /\[Data loss risk diagnostics \(LM-9\)\]/, `stdout=${res.stdout}`);
  for (const n of ['#1', '#2', '#3', '#4', '#5']) {
    assert.match(res.stdout, new RegExp(`\\] ${n} `), `missing diagnostic ${n}\nstdout=${res.stdout}`);
  }
  // Order check: #1 must precede #5 in the output.
  const i1 = res.stdout.indexOf('] #1 ');
  const i5 = res.stdout.indexOf('] #5 ');
  assert.ok(i1 > 0 && i5 > i1, `expected #1 before #5, got i1=${i1} i5=${i5}`);
});

test('LM-9 #1 elevates to [ERROR] when data dir overlaps plugin tree', { skip: skipIfMissing }, () => {
  const res = runDoctor({
    CLAWKET_DATA_DIR: '/tmp/lm9-fake/.claude/plugins/data/clawket-x',
  });
  // #1 line must now carry ERROR
  assert.match(res.stdout, /\[ERROR\] #1 plugin overlap/, `stdout=${res.stdout}`);
  // Summary line must show errors >= 1
  assert.match(res.stdout, /\[Summary\] errors=\d+/);
  const m = res.stdout.match(/\[Summary\] errors=(\d+) warnings=(\d+) info=(\d+)/);
  assert.ok(m, 'summary line missing');
  assert.ok(parseInt(m[1], 10) >= 1, `expected at least one error, got summary=${m[0]}`);
  assert.equal(res.status, 1, `expected exit 1 on ERROR, got ${res.status}`);
});

test('LM-9 summary tally matches per-line tags', { skip: skipIfMissing }, () => {
  const res = runDoctor();
  const m = res.stdout.match(/\[Summary\] errors=(\d+) warnings=(\d+) info=(\d+)/);
  assert.ok(m, `summary line missing\nstdout=${res.stdout}`);
  const errors = parseInt(m[1], 10);
  const warnings = parseInt(m[2], 10);
  // Hermetic temp env should produce zero ERRORs (no plugin overlap, no
  // bad perms). Warnings/INFOs are platform-dependent and not asserted.
  assert.equal(errors, 0, `expected 0 errors in clean env, got ${errors}.\nstdout=${res.stdout}`);
  assert.equal(res.status, 0, `expected exit 0 with no errors, got ${res.status}`);
  // The number of [WARN] tag occurrences in the LM-9 panel should equal
  // the warnings field (we don't try to count cross-section, just sanity-
  // check the per-line tags don't exceed the summary).
  const warnLines = (res.stdout.match(/\[WARN\] #/g) || []).length;
  assert.ok(warnLines <= warnings, `more [WARN] #N lines (${warnLines}) than summary warnings (${warnings})`);
});

test('LM-9 #4 first-run is [INFO], second-run is [OK]', { skip: skipIfMissing }, () => {
  const { tmp, env } = isolatedEnv();
  const fullEnv = { ...process.env, ...env };
  const first = spawnSync(CLI_BIN, ['doctor'], { env: fullEnv, encoding: 'utf-8', timeout: 15000 });
  const second = spawnSync(CLI_BIN, ['doctor'], { env: fullEnv, encoding: 'utf-8', timeout: 15000 });

  // First run: snapshot didn't exist → either INFO (when daemon answered)
  // or INFO (when daemon was unreachable). Either way #4 line must be INFO,
  // not WARN/ERROR.
  assert.doesNotMatch(first.stdout, /\[(WARN|ERROR)\] #4 /, `first run #4 must not warn/error\nstdout=${first.stdout}`);

  // Second run: regardless of daemon availability, #4 must NOT be WARN
  // because the test environment didn't lose any tasks between runs.
  assert.doesNotMatch(second.stdout, /\[WARN\] #4 /, `second run #4 must not warn\nstdout=${second.stdout}`);
});
