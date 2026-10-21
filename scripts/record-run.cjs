#!/usr/bin/env node
// Run a verification command and record it as a Clawket run, so task
// evidence can cite it as `run:<RUN-ID>` instead of a free-text claim.
//
//   node scripts/record-run.cjs --task <TASK-ID> [--agent <name>] [--report <file>] -- <command...>
//
// The run record carries the four provenance fields the daemon requires
// before a run counts as evidence:
//   command      the exact command line that ran
//   input_hash   sha256 over the git state it ran against (HEAD, porcelain
//                status including untracked files, binary diff against HEAD);
//                outside a git work tree, sha256 over cwd + command
//   exit_code    the command's exit status
//   report_hash  sha256 of the captured stdout+stderr report file
//
// The report is written to `.local/clawket-runs/<RUN-ID>.log` under cwd unless
// --report names another file. Prints `run:<RUN-ID>` as the last stdout line
// and exits with the command's exit code.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { cacheDir } = require('../adapters/shared/common.cjs');

function usage(msg) {
  if (msg) process.stderr.write(`record-run: ${msg}\n`);
  process.stderr.write('usage: record-run.cjs --task <TASK-ID> [--agent <name>] [--report <file>] -- <command...>\n');
  process.exit(64);
}

function parseArgs(argv) {
  const opts = { agent: 'verify', report: null, task: null, command: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { opts.command = argv.slice(i + 1); break; }
    if (a === '--task') opts.task = argv[++i];
    else if (a === '--agent') opts.agent = argv[++i];
    else if (a === '--report') opts.report = argv[++i];
    else usage(`unknown option ${a}`);
  }
  if (!opts.task) usage('--task is required');
  if (!opts.command.length) usage('missing command after --');
  return opts;
}

function sha256(buf) {
  return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function inputHash(cwd, commandLine) {
  const head = git(['rev-parse', 'HEAD'], cwd);
  if (head === null) return sha256(Buffer.from(`nogit\0${cwd}\0${commandLine}`));
  const h = crypto.createHash('sha256');
  h.update(head);
  h.update('\0');
  h.update(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd) || Buffer.alloc(0));
  h.update('\0');
  h.update(git(['diff', 'HEAD', '--binary'], cwd) || Buffer.alloc(0));
  // Untracked file contents are part of the input the command saw.
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
  if (untracked) {
    for (const rel of untracked.toString('utf8').split('\0').filter(Boolean).sort()) {
      h.update('\0');
      h.update(rel);
      try { h.update(fs.readFileSync(path.join(cwd, rel))); } catch {}
    }
  }
  return `sha256:${h.digest('hex')}`;
}

function shellQuote(s) {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function daemonRequest(method, pathname, body) {
  let port;
  try { port = fs.readFileSync(path.join(cacheDir(), 'clawketd.port'), 'utf-8').trim(); } catch {}
  if (!port) return Promise.reject(new Error('clawketd is not running (no port file); start it with `clawket daemon start`'));
  let token = null;
  try { token = fs.readFileSync(path.join(cacheDir(), 'clawketd.token'), 'utf-8').trim() || null; } catch {}
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (token) headers['X-Clawket-Token'] = token;
    const req = http.request(`http://127.0.0.1:${port}${pathname}`, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(`${method} ${pathname} → HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const commandLine = opts.command.length === 1 ? opts.command[0] : opts.command.map(shellQuote).join(' ');

  const run = await daemonRequest('POST', '/runs', {
    task_id: opts.task,
    agent: opts.agent,
    command: commandLine,
    input_hash: inputHash(cwd, commandLine),
  });
  if (!run || !run.id) throw new Error('daemon did not return a run id');

  const res = opts.command.length === 1
    ? spawnSync('/bin/sh', ['-c', opts.command[0]], { cwd, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 })
    : spawnSync(opts.command[0], opts.command.slice(1), { cwd, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
  const stdout = res.stdout || Buffer.alloc(0);
  const stderr = res.stderr || Buffer.alloc(0);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const exitCode = typeof res.status === 'number' ? res.status : 128 + (res.signal ? 1 : 0);

  const report = Buffer.concat([
    Buffer.from(`$ ${commandLine}\n# cwd ${cwd}\n# exit ${exitCode}\n--- stdout ---\n`), stdout,
    Buffer.from('\n--- stderr ---\n'), stderr,
  ]);
  const reportPath = path.resolve(cwd, opts.report || path.join('.local', 'clawket-runs', `${run.id}.log`));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);

  await daemonRequest('POST', `/runs/${encodeURIComponent(run.id)}/finish`, {
    result: exitCode === 0 ? 'success' : 'failure',
    notes: `report: ${reportPath}`,
    exit_code: exitCode,
    report_hash: sha256(report),
  });
  process.stdout.write(`\nrun:${run.id}\n`);
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`record-run: ${err.message}\n`);
  process.exit(70);
});
