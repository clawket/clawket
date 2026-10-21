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

const bc = require('../adapters/shared/bash-classifier.cjs');

// Each rule is exercised through the same structural matcher the hook uses
// (commands the shell would execute), not by testing its regex on raw text.
function patternById(id) {
  const p = catalog.patterns.find((x) => x.id === id);
  if (!p) throw new Error(`pattern not in catalog: ${id}`);
  return { test: (cmd) => bc.matchPattern(p, cmd) };
}

function detectDestructive(cmd) {
  const hit = bc.detectDestructive(cmd, catalog.patterns);
  return hit ? hit.id : null;
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
  assert.ok(re.test('rm -rf ~/.claude/plugins/data/clawket-clawket-clawket'), 'rm -rf ~/.claude/plugins/data/clawket-clawket-clawket'); // marketplace install-data layout
  assert.ok(re.test('rm -rf ~/.local/share/clawket'), 'rm -rf ~/.local/share/clawket');
  assert.ok(re.test('rm -rf ~/.local/share/clawket/db.sqlite'), 'rm -rf ~/.local/share/clawket/db.sqlite');
  assert.ok(re.test('rm -rf ~/.cache/clawket/clawketd.sock'), 'rm -rf ~/.cache/clawket/clawketd.sock');
  assert.ok(re.test('rm -rf ~/.config/clawket'), 'rm -rf ~/.config/clawket');
  assert.ok(re.test('rm -rf ~/.local/state/clawket/logs'), 'rm -rf ~/.local/state/clawket/logs');
  assert.ok(re.test('rm -fr ~/.local/share/clawket'), 'rm -fr ~/.local/share/clawket'); // flag order swap
  assert.ok(re.test('rm -Rf ~/.local/share/clawket'), 'rm -Rf ~/.local/share/clawket'); // -R uppercase
  assert.ok(re.test('rm --recursive --force ~/.local/share/clawket'), 'rm --recursive --force ~/.local/share/clawket');
  assert.ok(re.test('rm --force --recursive ~/.local/share/clawket'), 'rm --force --recursive ~/.local/share/clawket');
  assert.ok(re.test('cd /tmp && rm -rf ~/.local/share/clawket'), 'cd /tmp && rm -rf ~/.local/share/clawket'); // chained command
});

test('rm-rf-clawket-data: negatives', () => {
  const re = patternById('rm-rf-clawket-data');
  assert.ok(!re.test('rm -rf /tmp/scratch'), 'rm -rf /tmp/scratch'); // non-protected path
  assert.ok(!re.test('rm -r ~/.local/share/clawket'), 'rm -r ~/.local/share/clawket'); // missing -f
  assert.ok(!re.test('rm -f ~/.local/share/clawket'), 'rm -f ~/.local/share/clawket'); // missing -r
  assert.ok(!re.test('ls ~/.local/share/clawket'), 'ls ~/.local/share/clawket');
  assert.ok(!re.test('rm -rf ~/Documents/clawket-export.tar'), 'rm -rf ~/Documents/clawket-export.tar'); // arbitrary user file
});

// ── rm-rf-bare-home-or-root ───────────────────────────────────────────────
test('rm-rf-bare-home-or-root: positives', () => {
  const re = patternById('rm-rf-bare-home-or-root');
  assert.ok(re.test('rm -rf ~'), 'rm -rf ~');
  assert.ok(re.test('rm -rf $HOME'), 'rm -rf $HOME');
  assert.ok(re.test('rm -rf ${HOME}'), 'rm -rf ${HOME}');
  assert.ok(re.test('rm -rf /'), 'rm -rf /');
  assert.ok(re.test('rm -rf /Users/jdoe'), 'rm -rf /Users/jdoe');
  assert.ok(re.test('rm -rf /home/jdoe'), 'rm -rf /home/jdoe');
});

test('rm-rf-bare-home-or-root: negatives', () => {
  const re = patternById('rm-rf-bare-home-or-root');
  assert.ok(!re.test('rm -rf ~/.cache/foo'), 'rm -rf ~/.cache/foo'); // subpath, not bare home
  assert.ok(!re.test('rm -rf /tmp/scratch'), 'rm -rf /tmp/scratch');
});

// ── sqlite-destructive-clawket-db ─────────────────────────────────────────
test('sqlite-destructive-clawket-db: positives', () => {
  const re = patternById('sqlite-destructive-clawket-db');
  assert.ok(re.test('sqlite3 ~/.local/share/clawket/db.sqlite "DROP TABLE plans"'), 'sqlite3 ~/.local/share/clawket/db.sqlite "DROP TABLE plans"');
  assert.ok(re.test('sqlite3 ~/.local/share/clawket/db.sqlite "DELETE FROM tasks"'), 'sqlite3 ~/.local/share/clawket/db.sqlite "DELETE FROM tasks"');
  assert.ok(re.test('sqlite3 ~/.local/share/clawket/db.sqlite "drop table plans"'), 'sqlite3 ~/.local/share/clawket/db.sqlite "drop table plans"'); // case insensitive
});

test('sqlite-destructive-clawket-db: stdin-redirected SQL is a known limitation', () => {
  // SQL read from a file (< file.sql) is not analysed — that would require
  // reading the file. Document the gap so it is not mistaken for a regression.
  // (Heredoc, here-string and piped literal SQL ARE analysed; see
  // tests/bash-classifier.test.cjs.)
  const re = patternById('sqlite-destructive-clawket-db');
  assert.ok(!re.test('sqlite3 ~/.local/share/clawket/db.sqlite < drop.sql'), 'sqlite3 ~/.local/share/clawket/db.sqlite < drop.sql');
});

test('sqlite-destructive-clawket-db: negatives', () => {
  const re = patternById('sqlite-destructive-clawket-db');
  assert.ok(!re.test('sqlite3 ~/.local/share/clawket/db.sqlite "SELECT * FROM plans"'), 'sqlite3 ~/.local/share/clawket/db.sqlite "SELECT * FROM plans"');
  assert.ok(!re.test('sqlite3 /tmp/test.db "DROP TABLE x"'), 'sqlite3 /tmp/test.db "DROP TABLE x"'); // non-clawket DB
  assert.ok(!re.test('sqlite3 ~/.local/share/clawket/db.sqlite ".tables"'), 'sqlite3 ~/.local/share/clawket/db.sqlite ".tables"');
});

// ── clawket-delete-force-aggregate ────────────────────────────────────────
test('clawket-delete-force-aggregate: positives', () => {
  const re = patternById('clawket-delete-force-aggregate');
  assert.ok(re.test('clawket plan delete PLAN-XXX --force'), 'clawket plan delete PLAN-XXX --force');
  assert.ok(re.test('clawket unit delete UNIT-XXX --force'), 'clawket unit delete UNIT-XXX --force');
  assert.ok(re.test('clawket cycle delete CYC-XXX --force'), 'clawket cycle delete CYC-XXX --force');
  assert.ok(re.test('clawket project delete PROJ-XXX --force'), 'clawket project delete PROJ-XXX --force');
});

test('clawket-delete-force-aggregate: negatives', () => {
  const re = patternById('clawket-delete-force-aggregate');
  assert.ok(!re.test('clawket task delete TASK-XXX --force'), 'clawket task delete TASK-XXX --force'); // task allowed (cancel preferred but not catastrophic)
  assert.ok(!re.test('clawket plan delete PLAN-XXX'), 'clawket plan delete PLAN-XXX'); // no --force
  assert.ok(!re.test('clawket plan view PLAN-XXX'), 'clawket plan view PLAN-XXX');
});

// ── git-reset-hard ────────────────────────────────────────────────────────
test('git-reset-hard: positives', () => {
  const re = patternById('git-reset-hard');
  assert.ok(re.test('git reset --hard'), 'git reset --hard');
  assert.ok(re.test('git reset --hard HEAD~1'), 'git reset --hard HEAD~1');
  assert.ok(re.test('git reset --hard origin/main'), 'git reset --hard origin/main');
});

test('git-reset-hard: negatives', () => {
  const re = patternById('git-reset-hard');
  assert.ok(!re.test('git reset HEAD~1'), 'git reset HEAD~1'); // soft reset
  assert.ok(!re.test('git reset --soft HEAD~1'), 'git reset --soft HEAD~1');
  assert.ok(!re.test('git status'), 'git status');
});

// ── docker-rm-volumes ─────────────────────────────────────────────────────
test('docker-rm-volumes: positives', () => {
  const re = patternById('docker-rm-volumes');
  assert.ok(re.test('docker rm -v container1'), 'docker rm -v container1');
  assert.ok(re.test('docker rm --volumes container1'), 'docker rm --volumes container1');
  assert.ok(re.test('docker rm -fv container1'), 'docker rm -fv container1');
});

test('docker-rm-volumes: negatives', () => {
  const re = patternById('docker-rm-volumes');
  assert.ok(!re.test('docker rm container1'), 'docker rm container1'); // no -v
  assert.ok(!re.test('docker ps'), 'docker ps');
  assert.ok(!re.test('docker rm -f container1'), 'docker rm -f container1'); // -f only, no -v
});

// ── chmod-zero-lockout ────────────────────────────────────────────────────
test('chmod-zero-lockout: positives', () => {
  const re = patternById('chmod-zero-lockout');
  assert.ok(re.test('chmod 000 file.txt'), 'chmod 000 file.txt');
  assert.ok(re.test('chmod 0 file.txt'), 'chmod 0 file.txt');
});

test('chmod-zero-lockout: negatives', () => {
  const re = patternById('chmod-zero-lockout');
  assert.ok(!re.test('chmod 600 file.txt'), 'chmod 600 file.txt');
  assert.ok(!re.test('chmod 0644 file.txt'), 'chmod 0644 file.txt'); // 0644 is not 0/000
  assert.ok(!re.test('chmod +x script.sh'), 'chmod +x script.sh');
});

// ── find-delete-protected ─────────────────────────────────────────────────
test('find-delete-protected: positives', () => {
  const re = patternById('find-delete-protected');
  assert.ok(re.test('find ~/.local/share/clawket -name "*.log" -delete'), 'find ~/.local/share/clawket -name "*.log" -delete');
  assert.ok(re.test('find ~/.cache/clawket -mtime +30 -delete'), 'find ~/.cache/clawket -mtime +30 -delete');
  assert.ok(re.test('find ~/.claude/plugins/data -name "*.tmp" -delete'), 'find ~/.claude/plugins/data -name "*.tmp" -delete');
});

test('find-delete-protected: negatives', () => {
  const re = patternById('find-delete-protected');
  assert.ok(!re.test('find /tmp -name "*.log" -delete'), 'find /tmp -name "*.log" -delete'); // non-protected
  assert.ok(!re.test('find ~/.local/share/clawket -name "*.log"'), 'find ~/.local/share/clawket -name "*.log"'); // no -delete
});

// ── redirect-overwrite-clawket-db ─────────────────────────────────────────
test('redirect-overwrite-clawket-db: positives', () => {
  const re = patternById('redirect-overwrite-clawket-db');
  assert.ok(re.test('echo "" > ~/.local/share/clawket/db.sqlite'), 'echo "" > ~/.local/share/clawket/db.sqlite');
  assert.ok(re.test('cat /dev/null >~/.local/share/clawket/db.sqlite'), 'cat /dev/null >~/.local/share/clawket/db.sqlite');
});

test('redirect-overwrite-clawket-db: negatives', () => {
  const re = patternById('redirect-overwrite-clawket-db');
  assert.ok(!re.test('cat ~/.local/share/clawket/db.sqlite'), 'cat ~/.local/share/clawket/db.sqlite'); // read only
  assert.ok(!re.test('echo "" > /tmp/log.txt'), 'echo "" > /tmp/log.txt');
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

// ── literal text is data, executed text is a command (structural matching) ─
const RH = ['git', 'reset', '--hard'].join(' ');

test('detectDestructive: mentions inside data are not commands', () => {
  assert.equal(detectDestructive(`grep -rn "${RH}" docs/`), null);
  assert.equal(detectDestructive(`git log --grep="${RH}"`), null);
  assert.equal(detectDestructive(`echo 'never run ${RH}'`), null);
  assert.equal(detectDestructive(`cat > notes.md <<'EOF'\n${RH}\nEOF`), null);
  assert.equal(detectDestructive('git commit -m "docs: explain TRUNCATE semantics"'), null);
  assert.equal(detectDestructive('rg -n "DROP TABLE" migrations/'), null);
});

test('detectDestructive: evasions of the raw-text rules are caught', () => {
  assert.equal(detectDestructive(['git', '-C', '.', 'reset', '--hard'].join(' ')), 'git-reset-hard');
  assert.equal(detectDestructive('git reset --har""d'), 'git-reset-hard');
  assert.equal(detectDestructive(`bash -c "${RH}"`), 'git-reset-hard');
  assert.equal(detectDestructive('docker container rm -v c1'), 'docker-rm-volumes');
  assert.equal(detectDestructive('env X=1 rm -rf "$HOME"'), 'rm-rf-bare-home-or-root');
});
