// LM-7 — destructive shell pattern catalog regression tests.
//
// Run: node --test tests/destructive-patterns.test.cjs
//
// Each pattern entry is exercised with at least one positive case (must MATCH
// → block) and at least one negative case (must NOT match → false positive
// avoidance). The marketplace install-data command (`rm -rf
// ~/.claude/plugins/data/clawket-clawket-clawket`) appears verbatim in the
// rm-rf-clawket-data positives — its match is the LM-7 success metric.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const catalog = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'adapters', 'shared', 'destructive-patterns.json'), 'utf-8'),
);

function patternById(id) {
  const p = catalog.patterns.find((x) => x.id === id);
  if (!p) throw new Error(`pattern not in catalog: ${id}`);
  return new RegExp(p.regex, p.flags || '');
}

function detectDestructive(cmd) {
  for (const p of catalog.patterns) {
    if (new RegExp(p.regex, p.flags || '').test(cmd)) return p.id;
  }
  return null;
}

test('catalog has at least 7 patterns (LM-7 acceptance)', () => {
  assert.ok(catalog.patterns.length >= 7, `expected >=7, got ${catalog.patterns.length}`);
});

test('catalog has unique pattern ids', () => {
  const ids = catalog.patterns.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate id detected');
});

function hasLocalizedValue(field) {
  if (typeof field === 'string') return field.length > 0;
  if (field && typeof field === 'object') {
    return Object.values(field).some((v) => typeof v === 'string' && v.length > 0);
  }
  return false;
}

test('every pattern carries reason + remediation', () => {
  for (const p of catalog.patterns) {
    assert.ok(hasLocalizedValue(p.reason), `${p.id} missing reason`);
    assert.ok(hasLocalizedValue(p.remediation), `${p.id} missing remediation`);
  }
});

// ── rm-rf-clawket-data ────────────────────────────────────────────────────
test('rm-rf-clawket-data: positives', () => {
  const re = patternById('rm-rf-clawket-data');
  assert.match('rm -rf ~/.claude/plugins/data/clawket-clawket-clawket', re); // marketplace install-data layout
  assert.match('rm -rf ~/.local/share/clawket', re);
  assert.match('rm -rf ~/.local/share/clawket/db.sqlite', re);
  assert.match('rm -rf ~/.cache/clawket/clawketd.sock', re);
  assert.match('rm -rf ~/.config/clawket', re);
  assert.match('rm -rf ~/.local/state/clawket/logs', re);
  assert.match('rm -fr ~/.local/share/clawket', re); // flag order swap
  assert.match('rm -Rf ~/.local/share/clawket', re); // -R uppercase
  assert.match('rm --recursive --force ~/.local/share/clawket', re);
  assert.match('rm --force --recursive ~/.local/share/clawket', re);
  assert.match('cd /tmp && rm -rf ~/.local/share/clawket', re); // chained command
});

test('rm-rf-clawket-data: negatives', () => {
  const re = patternById('rm-rf-clawket-data');
  assert.doesNotMatch('rm -rf /tmp/scratch', re); // non-protected path
  assert.doesNotMatch('rm -r ~/.local/share/clawket', re); // missing -f
  assert.doesNotMatch('rm -f ~/.local/share/clawket', re); // missing -r
  assert.doesNotMatch('ls ~/.local/share/clawket', re);
  assert.doesNotMatch('rm -rf ~/Documents/clawket-export.tar', re); // arbitrary user file
});

// ── rm-rf-bare-home-or-root ───────────────────────────────────────────────
test('rm-rf-bare-home-or-root: positives', () => {
  const re = patternById('rm-rf-bare-home-or-root');
  assert.match('rm -rf ~', re);
  assert.match('rm -rf $HOME', re);
  assert.match('rm -rf ${HOME}', re);
  assert.match('rm -rf /', re);
  assert.match('rm -rf /Users/jdoe', re);
  assert.match('rm -rf /home/jdoe', re);
});

test('rm-rf-bare-home-or-root: negatives', () => {
  const re = patternById('rm-rf-bare-home-or-root');
  assert.doesNotMatch('rm -rf ~/.cache/foo', re); // subpath, not bare home
  assert.doesNotMatch('rm -rf /tmp/scratch', re);
});

// ── sqlite-destructive-clawket-db ─────────────────────────────────────────
test('sqlite-destructive-clawket-db: positives', () => {
  const re = patternById('sqlite-destructive-clawket-db');
  assert.match('sqlite3 ~/.local/share/clawket/db.sqlite "DROP TABLE plans"', re);
  assert.match('sqlite3 ~/.local/share/clawket/db.sqlite "DELETE FROM tasks"', re);
  assert.match('sqlite3 ~/.local/share/clawket/db.sqlite "drop table plans"', re); // case insensitive
});

test('sqlite-destructive-clawket-db: stdin-redirected SQL is a known limitation', () => {
  // The pattern only inspects the visible command; SQL piped via < file.sql is
  // not analysed (would require reading the file). Document the gap so it is
  // not mistaken for a regression.
  const re = patternById('sqlite-destructive-clawket-db');
  assert.doesNotMatch('sqlite3 ~/.local/share/clawket/db.sqlite < drop.sql', re);
});

test('sqlite-destructive-clawket-db: negatives', () => {
  const re = patternById('sqlite-destructive-clawket-db');
  assert.doesNotMatch('sqlite3 ~/.local/share/clawket/db.sqlite "SELECT * FROM plans"', re);
  assert.doesNotMatch('sqlite3 /tmp/test.db "DROP TABLE x"', re); // non-clawket DB
  assert.doesNotMatch('sqlite3 ~/.local/share/clawket/db.sqlite ".tables"', re);
});

// ── clawket-delete-force-aggregate ────────────────────────────────────────
test('clawket-delete-force-aggregate: positives', () => {
  const re = patternById('clawket-delete-force-aggregate');
  assert.match('clawket plan delete PLAN-XXX --force', re);
  assert.match('clawket unit delete UNIT-XXX --force', re);
  assert.match('clawket cycle delete CYC-XXX --force', re);
  assert.match('clawket project delete PROJ-XXX --force', re);
});

test('clawket-delete-force-aggregate: negatives', () => {
  const re = patternById('clawket-delete-force-aggregate');
  assert.doesNotMatch('clawket task delete TASK-XXX --force', re); // task allowed (cancel preferred but not catastrophic)
  assert.doesNotMatch('clawket plan delete PLAN-XXX', re); // no --force
  assert.doesNotMatch('clawket plan view PLAN-XXX', re);
});

// ── git-reset-hard ────────────────────────────────────────────────────────
test('git-reset-hard: positives', () => {
  const re = patternById('git-reset-hard');
  assert.match('git reset --hard', re);
  assert.match('git reset --hard HEAD~1', re);
  assert.match('git reset --hard origin/main', re);
});

test('git-reset-hard: negatives', () => {
  const re = patternById('git-reset-hard');
  assert.doesNotMatch('git reset HEAD~1', re); // soft reset
  assert.doesNotMatch('git reset --soft HEAD~1', re);
  assert.doesNotMatch('git status', re);
});

// ── docker-rm-volumes ─────────────────────────────────────────────────────
test('docker-rm-volumes: positives', () => {
  const re = patternById('docker-rm-volumes');
  assert.match('docker rm -v container1', re);
  assert.match('docker rm --volumes container1', re);
  assert.match('docker rm -fv container1', re);
});

test('docker-rm-volumes: negatives', () => {
  const re = patternById('docker-rm-volumes');
  assert.doesNotMatch('docker rm container1', re); // no -v
  assert.doesNotMatch('docker ps', re);
  assert.doesNotMatch('docker rm -f container1', re); // -f only, no -v
});

// ── chmod-zero-lockout ────────────────────────────────────────────────────
test('chmod-zero-lockout: positives', () => {
  const re = patternById('chmod-zero-lockout');
  assert.match('chmod 000 file.txt', re);
  assert.match('chmod 0 file.txt', re);
});

test('chmod-zero-lockout: negatives', () => {
  const re = patternById('chmod-zero-lockout');
  assert.doesNotMatch('chmod 600 file.txt', re);
  assert.doesNotMatch('chmod 0644 file.txt', re); // 0644 is not 0/000
  assert.doesNotMatch('chmod +x script.sh', re);
});

// ── find-delete-protected ─────────────────────────────────────────────────
test('find-delete-protected: positives', () => {
  const re = patternById('find-delete-protected');
  assert.match('find ~/.local/share/clawket -name "*.log" -delete', re);
  assert.match('find ~/.cache/clawket -mtime +30 -delete', re);
  assert.match('find ~/.claude/plugins/data -name "*.tmp" -delete', re);
});

test('find-delete-protected: negatives', () => {
  const re = patternById('find-delete-protected');
  assert.doesNotMatch('find /tmp -name "*.log" -delete', re); // non-protected
  assert.doesNotMatch('find ~/.local/share/clawket -name "*.log"', re); // no -delete
});

// ── redirect-overwrite-clawket-db ─────────────────────────────────────────
test('redirect-overwrite-clawket-db: positives', () => {
  const re = patternById('redirect-overwrite-clawket-db');
  assert.match('echo "" > ~/.local/share/clawket/db.sqlite', re);
  assert.match('cat /dev/null >~/.local/share/clawket/db.sqlite', re);
});

test('redirect-overwrite-clawket-db: negatives', () => {
  const re = patternById('redirect-overwrite-clawket-db');
  assert.doesNotMatch('cat ~/.local/share/clawket/db.sqlite', re); // read only
  assert.doesNotMatch('echo "" > /tmp/log.txt', re);
});

// ── integration: detectDestructive aggregate behaviour ────────────────────
test('detectDestructive: marketplace install-data command is matched', () => {
  // rm -rf against the marketplace install-data path under .claude/plugins/data/.
  assert.equal(
    detectDestructive('rm -rf ~/.claude/plugins/data/clawket-clawket-clawket'),
    'rm-rf-clawket-data',
  );
});

test('detectDestructive: safe commands return null', () => {
  assert.equal(detectDestructive('ls -la'), null);
  assert.equal(detectDestructive('clawket task list'), null);
  assert.equal(detectDestructive('git status'), null);
  assert.equal(detectDestructive('npm run build'), null);
  assert.equal(detectDestructive(''), null);
});

test('detectDestructive: clawket task delete (non-aggregate) is allowed', () => {
  // tasks are cancelable; only plan/unit/cycle/project --force is hard-blocked.
  assert.equal(detectDestructive('clawket task delete TASK-XXX --force'), null);
});
