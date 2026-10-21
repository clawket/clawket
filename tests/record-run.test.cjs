// scripts/record-run.cjs records a verification run with the provenance the
// daemon requires before `run:<ID>` counts as evidence.
//
// Run: node --test tests/record-run.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'record-run.cjs');

async function recordRun(command) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawket-run-'));
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, 'clawketd.token'), 'tok');
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, token: req.headers['x-clawket-token'], body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'RUN-T1', status: req.url.endsWith('/finish') ? 'finished' : 'started' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(cache, 'clawketd.port'), String(server.address().port));
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, '--task', 'TASK-1', '--', ...command], {
        cwd: dir,
        env: { ...process.env, CLAWKET_CACHE_DIR: cache },
      });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('close', (status) => resolve({ status, stdout }));
    });
    return { ...result, requests, dir };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('record-run: records command, input hash, exit code and report hash', async () => {
  const r = await recordRun([process.execPath, '-e', 'console.log("ok")']);
  try {
    assert.equal(r.status, 0);
    assert.match(r.stdout, /run:RUN-T1\s*$/);
    const [create, finish] = r.requests;
    assert.equal(create.url, '/runs');
    assert.equal(create.token, 'tok');
    assert.equal(create.body.task_id, 'TASK-1');
    assert.match(create.body.command, /console\.log/);
    assert.match(create.body.input_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(finish.url, '/runs/RUN-T1/finish');
    assert.equal(finish.body.exit_code, 0);
    assert.equal(finish.body.result, 'success');
    const report = fs.readFileSync(path.join(r.dir, '.local', 'clawket-runs', 'RUN-T1.log'));
    assert.equal(finish.body.report_hash, `sha256:${crypto.createHash('sha256').update(report).digest('hex')}`);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('record-run: a failing command is recorded as failure and its exit code is propagated', async () => {
  const r = await recordRun([process.execPath, '-e', 'process.exit(3)']);
  try {
    assert.equal(r.status, 3);
    const finish = r.requests[1];
    assert.equal(finish.body.exit_code, 3);
    assert.equal(finish.body.result, 'failure');
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});
