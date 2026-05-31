// #52 — X9 (sync-purity) must only enforce inside an explicitly-marked
// bulk-sync block (CLAWKET_SYNC_CONTEXT). Without that marker the command
// surface is not scanned, so ordinary multi-update scripts and unrelated
// commands that merely mention sync tokens must NOT be blocked.
//
// getDaemonPort() early-skips X9 when no daemon port file exists, so we point
// cacheDir() at a temp dir (CLAWKET_CACHE_DIR) holding a fake clawketd.port —
// this exercises the real guard logic instead of the daemon-down skip path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-x9-'));
process.env.CLAWKET_CACHE_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'clawketd.port'), '19400');
process.env.CLAWKET_ENFORCE_SYNC_PURITY = 'strict';
delete process.env.CLAWKET_BYPASS_HOOKS;

const { checkX9SyncReasoning } = require('../adapters/shared/claude-hooks.cjs').__test__;

test('#52: multi-update script + summary without sync marker is not blocked', () => {
  delete process.env.CLAWKET_SYNC_CONTEXT;
  const cmd = [
    'clawket task update T1 --status done --evidence a:1',
    'clawket task update T2 --status done --evidence b:2',
    `python3 -c "print('done=2 todo=0')"`,
  ].join(' && ');
  const r = checkX9SyncReasoning(cmd, { toolName: 'Bash' });
  assert.equal(r.blocked, false, 'a plain multi-update script must not trip X9');
});

test('#52: gh issue body mentioning sync tokens is not blocked', () => {
  delete process.env.CLAWKET_SYNC_CONTEXT;
  // Body deliberately contains every trigger token: "bulk-sync", "TSV",
  // "task update", and reasoning words. Surface scan must NOT fire without a
  // sync marker — reporting the bug must not itself be blocked.
  const cmd =
    'gh issue create --title x --body "bulk-sync must only transcribe TSV->DB; ' +
    'do not embed reasoning/decide/classify in task update sync"';
  const r = checkX9SyncReasoning(cmd, { toolName: 'Bash' });
  assert.equal(r.blocked, false, 'reporting the bug must not be blocked by surface scan');
});

test('X9 still enforces reasoning embedded inside an active sync context', () => {
  process.env.CLAWKET_SYNC_CONTEXT = 'bulk-sync';
  const cmd =
    `python3 -c "for r in rows: status='done' if decide(r) else 'blocked'; task_update(r, status)"`;
  const r = checkX9SyncReasoning(cmd, { toolName: 'Bash' });
  assert.equal(r.blocked, true, 'real sync driver embedding reasoning must still be blocked');
  delete process.env.CLAWKET_SYNC_CONTEXT;
});

test('X9 allows a pure transcription sync driver (no reasoning) in sync context', () => {
  process.env.CLAWKET_SYNC_CONTEXT = 'bulk-sync';
  // Reads TSV.status and writes it through — no reasoning keyword, no status branch.
  const cmd = `python3 -c "for r in tsv: task_update(r.id, r.status)"`;
  const r = checkX9SyncReasoning(cmd, { toolName: 'Bash' });
  assert.equal(r.blocked, false, 'pure TSV->DB transcription must pass even in sync context');
  delete process.env.CLAWKET_SYNC_CONTEXT;
});
