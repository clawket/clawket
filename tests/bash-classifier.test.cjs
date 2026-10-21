// PreToolUse Bash classification: destructive rules run on the commands that
// would execute, and the active-task fast paths require every executed
// command to be read-only / verification / clawket.
//
// Run: node --test tests/bash-classifier.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bc = require('../adapters/shared/bash-classifier.cjs');

const catalog = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'adapters', 'shared', 'destructive-patterns.json'), 'utf-8'),
);

// The literal is assembled so this file itself never contains the joined
// command text as one token stream.
const RH = ['git', 'reset', '--hard'].join(' ');

function verdict(cmd) {
  const a = bc.analyze(cmd);
  const hit = bc.detectDestructive(cmd, catalog.patterns, a);
  if (hit) return `deny:${hit.id}`;
  return bc.classify(cmd, a).kind;
}

const MATRIX = [
  // Text that only mentions a dangerous command is data, not a command.
  [`cat > probe.js <<'EOF'\nconst c = '${RH}';\nEOF`, 'mutating'],
  [`grep -rn "${RH}" docs/`, 'readonly'],
  [`git log --grep="${RH}"`, 'readonly'],
  [`echo 'never run ${RH}'`, 'readonly'],
  ['rg -n "DROP TABLE" migrations/', 'readonly'],
  ['git commit -m "docs: explain TRUNCATE semantics"', 'mutating'],
  ['printf "%s\\n" "rm -rf ~"', 'readonly'],

  // Executed dangerous commands stay denied, including evasions.
  [RH, 'deny:git-reset-hard'],
  [`cd repo && ${RH} HEAD~1`, 'deny:git-reset-hard'],
  [`bash -c "${RH}"`, 'deny:git-reset-hard'],
  ['git reset  --hard', 'deny:git-reset-hard'],
  ['git -C . reset --hard', 'deny:git-reset-hard'],
  ['git --no-pager -c x=y reset --hard', 'deny:git-reset-hard'],
  ['git reset --har""d', 'deny:git-reset-hard'],
  ["git reset '--hard'", 'deny:git-reset-hard'],
  [`eval "${RH}"`, 'deny:git-reset-hard'],
  [`echo a | xargs -I{} ${RH} {}`, 'deny:git-reset-hard'],
  [`env FOO=1 timeout 5 nice -n 5 ${RH}`, 'deny:git-reset-hard'],
  [`echo $(${RH})`, 'deny:git-reset-hard'],
  [`echo \`${RH}\``, 'deny:git-reset-hard'],
  [`cat <<EOF\n$(${RH})\nEOF`, 'deny:git-reset-hard'],
  [`bash <<EOF\n${RH}\nEOF`, 'deny:git-reset-hard'],
  [`echo "${RH}" | sh`, 'deny:git-reset-hard'],
  [`sh -lc '${RH}'`, 'deny:git-reset-hard'],
  [`(cd x; ${RH})`, 'deny:git-reset-hard'],
  [`ls\r${RH}`, 'deny:git-reset-hard'],
  ['find ~/.local/share/clawket -name "*.db" -delete', 'deny:find-delete-protected'],
  ['xargs rm -rf ~/.local/share/clawket < /dev/null', 'deny:rm-rf-clawket-data'],
  ['sudo rm -rf /', 'deny:rm-rf-bare-home-or-root'],
  ['echo "DROP TABLE x" | sqlite3 /tmp/a.db', 'deny:drop-table-standalone'],
  ['sqlite3 /tmp/a.db <<SQL\nTRUNCATE x;\nSQL', 'deny:truncate-any-table'],
  ['psql -c "ALTER TABLE t DROP COLUMN c"', 'deny:alter-drop-column-bare'],
  ['python3 -c "db.execute(\'DROP TABLE plans\')"', 'deny:drop-table-standalone'],
  ['cp /dev/null ~/.local/share/clawket/db.sqlite', 'deny:redirect-overwrite-clawket-db'],
  ['clawket plan delete PLAN-1 --force', 'deny:clawket-delete-force-aggregate'],

  // Mutations must reach the active-task gate.
  ['cat README.md; rm -rf src', 'mutating'],
  ['ls && rm -rf src', 'mutating'],
  ['ls || rm -rf src', 'mutating'],
  ['ls\nrm -rf src', 'mutating'],
  ["sed -i '' s/a/b/ f", 'mutating'],
  ['sed -n "s/a/b/w out.txt" f', 'mutating'],
  ['echo x | tee src/app.ts', 'mutating'],
  ['xargs rm < list', 'mutating'],
  ['node -e "require(\'fs\').rmSync(\'src\',{recursive:true})"', 'mutating'],
  ['python3 -c "open(\'f\',\'w\')"', 'mutating'],
  ['curl -o src/app.ts http://x', 'mutating'],
  ['curl -X POST http://x', 'mutating'],
  ['curl -d a=1 http://x', 'mutating'],
  ['wget http://x', 'mutating'],
  ['find . -name "*.ts" -delete', 'mutating'],
  ['find . -exec rm {} \\;', 'mutating'],
  ['git branch -D main', 'mutating'],
  ['git branch newbranch', 'mutating'],
  ['git tag v1', 'mutating'],
  ['git stash list; git stash drop', 'mutating'],
  ['git -c core.pager=rm log', 'mutating'],
  ['git diff --output=x.patch', 'mutating'],
  ['git config user.name x', 'mutating'],
  ['prettier --write .', 'mutating'],
  ['eslint --fix .', 'mutating'],
  ['cargo fmt', 'mutating'],
  ['cargo clippy --fix', 'mutating'],
  ['pnpm run lint:fix', 'mutating'],
  ['npm run deploy', 'mutating'],
  ['pnpm install', 'mutating'],
  ['sort -o out.txt in.txt', 'mutating'],
  ['awk \'{ print > "out" }\' f', 'mutating'],
  ['awk \'BEGIN { system("rm x") }\'', 'mutating'],
  ['rg --pre ./x foo', 'mutating'],
  ['sqlite3 db "delete from t"', 'mutating'],
  ['sqlite3 db < script.sql', 'mutating'],
  ['gh api -X POST repos/x', 'mutating'],
  ['gh api repos/x -f a=b', 'mutating'],
  ['gh pr merge 1', 'mutating'],
  ['rm -rf src # clawket ', 'mutating'],
  ['echo clawket && rm -rf src', 'mutating'],
  ['clawket task list > out.txt', 'mutating'],
  ['ls > out.txt', 'mutating'],
  ['ls >> out.txt', 'mutating'],
  ['ls &', 'mutating'],
  ['(ls; rm -rf src)', 'mutating'],
  ['{ ls; rm x; }', 'mutating'],
  ['((x=1))', 'unparseable'],
  ['bash -c "ls"', 'mutating'],
  ['eval ls', 'mutating'],
  ['source ./env.sh', 'mutating'],
  ['exec ls', 'mutating'],
  ['command ls', 'mutating'],
  ['bash script.sh', 'mutating'],
  ['cat <(ls)', 'mutating'],
  ['echo $(ls)', 'mutating'],
  ['env -S "rm -rf x"', 'mutating'],
  ['case x in a) ls;; esac', 'unparseable'],
  ['echo "unterminated', 'unparseable'],

  // Read-only commands pass without an active task.
  ['command -v jq', 'readonly'],
  ['command -V jq', 'readonly'],
  ['test -f package.json', 'readonly'],
  ['[ -d src ]', 'readonly'],
  ['nl -ba f', 'readonly'],
  ['shasum -a 256 f', 'readonly'],
  ['ps -axo pid,command', 'readonly'],
  ['git rev-parse HEAD', 'readonly'],
  ['git worktree list', 'readonly'],
  ['git -C sub status --short', 'readonly'],
  ['git diff --stat && git status', 'readonly'],
  ['git branch -a', 'readonly'],
  ['git branch --list "feat/*"', 'readonly'],
  ['git tag -l "v*"', 'readonly'],
  ['git config --get user.name', 'readonly'],
  ['git remote -v', 'readonly'],
  ['ls 2>/dev/null', 'readonly'],
  ['ls 2>&1 | head', 'readonly'],
  ['ls &>/dev/null', 'readonly'],
  ['cat <<EOF\nhello\nEOF', 'readonly'],
  ['grep -c x <<< "a x"', 'readonly'],
  ['find . -name "*.ts" | xargs grep foo', 'readonly'],
  ['find . -name "*.ts" -exec grep -l foo {} +', 'readonly'],
  ['sed -n 1,20p f', 'readonly'],
  ['awk \'{print $1}\' f', 'readonly'],
  ['jq .name package.json', 'readonly'],
  ['curl -sS http://127.0.0.1:1/health', 'readonly'],
  ['curl -s -o /dev/null -w "%{http_code}" http://x', 'readonly'],
  ['sqlite3 -readonly db.sqlite "select 1"', 'readonly'],
  ['sqlite3 db ".tables"', 'readonly'],
  ['sqlite3 db "SELECT count(*) FROM t; PRAGMA table_info(t)"', 'readonly'],
  ['gh pr view 1 --json title', 'readonly'],
  ['gh api repos/x/y', 'readonly'],
  ['env FOO=1 ls', 'readonly'],
  ['timeout 5 grep x f', 'readonly'],
  ['X=1', 'readonly'],
  ['if [ -f x ]; then cat x; fi', 'readonly'],
  ['for f in a b; do cat "$f"; done', 'readonly'],
  ['node --version', 'readonly'],
  ['cd /tmp && pwd', 'readonly'],
  ['(cat x 2>/dev/null || true)', 'readonly'],
  ['{ git status; git ls-remote origin; } 2>/dev/null', 'readonly'],
  ['[[ -d src && -f x ]]', 'readonly'],
  ['while read line; do echo "$line"; done < f', 'readonly'],
  ['git -c color.ui=always diff', 'readonly'],
  ['git hash-object f', 'readonly'],
  ['curl -sS -D - -o /dev/null http://127.0.0.1:1/', 'readonly'],
  // Execution-altering environment and path-qualified binaries.
  ['GIT_PAGER=./evil git log', 'mutating'],
  ['LD_PRELOAD=/tmp/x.so ls', 'mutating'],
  ['PATH=/tmp/evil:$PATH ls', 'mutating'],
  ['export PATH=/tmp/evil:$PATH; ls', 'mutating'],
  ['env GIT_EXTERNAL_DIFF=./x git diff', 'mutating'],
  ['for PATH in /tmp; do ls; done', 'mutating'],
  ['printf -v PATH /tmp', 'mutating'],
  ['./ls', 'mutating'],
  ['/tmp/evil/cat f', 'mutating'],
  ['$CMD f', 'mutating'],
  ['/usr/bin/grep x f', 'readonly'],
  ['GIT_PAGER=cat git log', 'readonly'],
  ['date 0101000020', 'mutating'],
  ['date +%s', 'readonly'],
  ['hostname evil', 'mutating'],
  ['file -C -m magic', 'mutating'],
  ["sed '1r other' f", 'mutating'],
  ['echo -delete | xargs find .', 'mutating'],
  ['sqlite3 -readonly db "select writefile(\'x\',\'y\')"', 'mutating'],
  ['git grep -Ovim foo', 'mutating'],
  ['git hash-object -w f', 'mutating'],
  ['', 'readonly'],

  // Verification commands: allowed and recorded.
  ['npm run build', 'verification'],
  ['pnpm test', 'verification'],
  ['pnpm -C web run typecheck', 'verification'],
  ['npm run test:unit', 'verification'],
  ['npx tsc --noEmit', 'verification'],
  ['pnpm exec vitest run', 'verification'],
  ['eslint . --quiet', 'verification'],
  ['prettier --check .', 'verification'],
  ['cargo test --all', 'verification'],
  ['cargo clippy --all-targets -- -D warnings', 'verification'],
  ['cargo fmt --all -- --check', 'verification'],
  ['node --test tests/*.test.cjs', 'verification'],
  ['go test ./...', 'verification'],

  // clawket calls — every executed command is clawket or read-only.
  ['clawket task list --format json', 'clawket'],
  ['clawket task list | jq .', 'clawket'],
  ['clawket dashboard --cwd . && clawket plan list', 'clawket'],
];

for (const [cmd, expected] of MATRIX) {
  test(`classify ${JSON.stringify(cmd)} → ${expected}`, () => {
    assert.equal(verdict(cmd), expected);
  });
}

test('lexer: quotes, escapes and ANSI-C strings dequote to argv', () => {
  const [item] = bc.parse(`git reset --har""d 'a b' "c\\"d" \\e $'x\\ty'`);
  const words = item.pipeline[0].words.map((w) => w.text);
  assert.deepEqual(words, ['git', 'reset', '--hard', 'a b', 'c"d', 'e', 'x\ty']);
});

test('lexer: heredoc body is attached to its redirect, not lexed as commands', () => {
  const items = bc.parse("cat <<'EOF' > out\nrm -rf /\nEOF\necho done");
  assert.equal(items.length, 2);
  const cat = items[0].pipeline[0];
  const heredoc = cat.redirs.find((r) => r.op === '<<');
  assert.equal(heredoc.body, 'rm -rf /');
  assert.equal(heredoc.delimQuoted, true);
  assert.equal(items[1].pipeline[0].words[0].text, 'echo');
});

test('lexer: <<- strips leading tabs from body and delimiter', () => {
  const [item] = bc.parse('cat <<-EOF\n\tline\n\tEOF');
  assert.equal(item.pipeline[0].redirs[0].body, 'line');
});

test('unparseable input falls back to the raw regex (fail closed)', () => {
  const hit = bc.detectDestructive(`case x in a) ${RH};; esac`, catalog.patterns);
  assert.equal(hit && hit.id, 'git-reset-hard');
});

test('catalog entries without a structural rule keep raw-regex semantics', () => {
  const custom = [{ id: 'custom', regex: 'forbidden-token' }];
  assert.equal(bc.detectDestructive('echo forbidden-token', custom).id, 'custom');
  assert.equal(bc.detectDestructive('echo fine', custom), null);
});

test('every catalog entry has a structural match rule and a fallback regex', () => {
  for (const p of catalog.patterns) {
    assert.ok(p.match, `${p.id} missing match`);
    assert.doesNotThrow(() => new RegExp(p.regex, p.flags || ''), `${p.id} fallback regex`);
  }
});

// The SDI plugin ships its own shell classifier with a shared read-only
// corpus. When that corpus is present, both classifiers must agree on every
// entry so the two gates never disagree about the same command.
const TOOL_SPECIFIC = new Set(['sdi', 'sdid', 'cmux', 'clawket']);
const SDI_CORPUS = path.join(os.homedir(), 'dev', 'repository', 'github', 'Seungwoo321', 'scenario-driven',
  'sdi-plugin', 'plugin', 'tests', 'fixtures', 'bash-readonly-corpus.json');

test('agrees with the SDI read-only corpus when present', { skip: !fs.existsSync(SDI_CORPUS) && 'SDI corpus not present' }, () => {
  const corpus = JSON.parse(fs.readFileSync(SDI_CORPUS, 'utf-8'));
  const entries = Array.isArray(corpus) ? corpus : (corpus.cases || corpus.entries || []);
  assert.ok(entries.length > 0, 'corpus has no entries');
  const disagreements = [];
  for (const e of entries) {
    const cmd = e.command ?? e.cmd;
    const expectReadonly = e.readOnly ?? e.readonly ?? e.read_only ?? (e.expected === 'readonly' || e.expected === 'read-only' || e.class === 'readonly');
    if (typeof cmd !== 'string' || typeof expectReadonly !== 'boolean') continue;
    // Each gate allows its own CLI (and SDI the cmux terminal CLI it drives);
    // those allowances are tool policy, not shell semantics, so they are
    // compared only where both tools share the meaning.
    const a = bc.analyze(cmd);
    if (a.ok && a.records.some((r) => TOOL_SPECIFIC.has(r.name))) continue;
    const kind = verdict(cmd);
    // Verification commands (build/test/lint) are Clawket's separate
    // allowed-and-recorded class; the corpus compares read-only semantics.
    if (kind === 'verification') continue;
    const isReadonly = kind === 'readonly' || kind === 'clawket';
    if (isReadonly !== expectReadonly) disagreements.push(`${JSON.stringify(cmd)}: sdi=${expectReadonly} clawket=${kind}`);
  }
  assert.deepEqual(disagreements, []);
});
