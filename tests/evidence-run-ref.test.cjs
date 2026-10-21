// X8 evidence by reference: `run:<RUN-ID>` must resolve to a finished run
// with full provenance; unreferenced test claims are rejected; other free
// text keeps working.
//
// Run: node --test tests/evidence-run-ref.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SHARED = path.resolve(__dirname, '..', 'adapters', 'shared', 'claude-hooks.cjs');
const { __test__: H } = require(SHARED);

const COMPLETE = {
  id: 'RUN-OK', task_id: 'TASK-1', status: 'finished', command: 'pnpm test',
  input_hash: 'sha256:aa', exit_code: 0, report_hash: 'sha256:bb',
};

test('parseRunRefs extracts every run:<ID> token', () => {
  assert.deepEqual(H.parseRunRefs('see run:RUN-01ABC and run:RUN-2; a.rs:9'), ['RUN-01ABC', 'RUN-2']);
  assert.deepEqual(H.parseRunRefs('no refs here'), []);
});

test('runRecordProblem: complete run passes; missing fields or unfinished fail', () => {
  assert.equal(H.runRecordProblem('RUN-OK', COMPLETE), null);
  assert.match(H.runRecordProblem('RUN-X', null), /does not exist/);
  assert.match(H.runRecordProblem('RUN-X', { ...COMPLETE, status: 'started' }), /not finished/);
  assert.match(H.runRecordProblem('RUN-X', { ...COMPLETE, report_hash: '' }), /report_hash/);
  assert.match(H.runRecordProblem('RUN-X', { ...COMPLETE, exit_code: null }), /exit_code/);
  assert.match(H.runRecordProblem('RUN-X', { ...COMPLETE, command: undefined, input_hash: undefined }), /command, input_hash/);
});

test('isUnreferencedTestClaim: test-result claims need a run reference', () => {
  assert.equal(H.isUnreferencedTestClaim('all tests pass'), true);
  assert.equal(H.isUnreferencedTestClaim('cargo test green after fix'), true);
  assert.equal(H.isUnreferencedTestClaim('42 passed, 0 failed'), true);
  assert.equal(H.isUnreferencedTestClaim('tests pass: run:RUN-1'), false);
  assert.equal(H.isUnreferencedTestClaim('src/gate.rs:42 — scoped the lookup to the project'), false);
  assert.equal(H.isUnreferencedTestClaim('cancelled: scenario superseded by US-X-002'), false);
});

function runCheck(port, evidence) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawket-x8-'));
  fs.writeFileSync(path.join(dir, 'clawketd.port'), String(port));
  const script = `
    const { __test__ } = require(${JSON.stringify(SHARED)});
    const r = __test__.checkX8Evidence({ task: { id: 'TASK-1', evidence: ${JSON.stringify(evidence)} }, newStatus: 'done' });
    process.stdout.write(JSON.stringify(r));
  `;
  const env = { ...process.env, CLAWKET_CACHE_DIR: dir, CLAWKET_HOOK_LOG_DIR: dir, CLAWKET_QUIET: '1' };
  delete env.CLAWKET_ENFORCE_EVIDENCE;
  delete env.CLAWKET_BYPASS_HOOKS;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(JSON.parse(out));
    });
  });
}

async function withRuns(fn) {
  const runs = { 'RUN-OK': COMPLETE, 'RUN-BAD': { ...COMPLETE, id: 'RUN-BAD', report_hash: null } };
  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/runs\/([^/?]+)/);
    const run = m && runs[decodeURIComponent(m[1])];
    if (!run) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(run));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(server.address().port); } finally { await new Promise((r) => server.close(r)); }
}

test('checkX8Evidence: a valid run reference passes even though it is short', async () => {
  await withRuns(async (port) => {
    const r = await runCheck(port, 'run:RUN-OK');
    assert.equal(r.blocked, false, r.reason);
  });
});

test('checkX8Evidence: unknown or incomplete runs are blocked (strict default)', async () => {
  await withRuns(async (port) => {
    const missing = await runCheck(port, 'run:RUN-NOPE');
    assert.equal(missing.blocked, true);
    assert.match(missing.reason, /RUN-NOPE does not exist/);
    const incomplete = await runCheck(port, 'tests: run:RUN-BAD');
    assert.equal(incomplete.blocked, true);
    assert.match(incomplete.reason, /report_hash/);
  });
});

test('checkX8Evidence: unreferenced test claim is blocked; file:line free text passes', async () => {
  await withRuns(async (port) => {
    const claim = await runCheck(port, 'all tests pass locally after the change');
    assert.equal(claim.blocked, true);
    assert.match(claim.reason, /run reference/);
    const free = await runCheck(port, 'adapters/shared/claude-hooks.cjs:2100 scoped the lookup');
    assert.equal(free.blocked, false);
  });
});

test('checkX8Evidence: a malformed run reference is blocked, not treated as free text', async () => {
  assert.equal(H.malformedRunRef('tests pass: run:undefined'), 'undefined');
  assert.equal(H.malformedRunRef('(run:RUN-1) and run:RUN-2.'), null);
  await withRuns(async (port) => {
    const r = await runCheck(port, 'all checks: run:undefined');
    assert.equal(r.blocked, true);
    assert.match(r.reason, /not a run id/);
  });
});
