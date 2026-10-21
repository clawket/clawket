'use strict';
// Shell command analysis for the PreToolUse Bash gate.
//
// The gate needs two answers about a Bash command string:
//   1. Would any command that actually executes match a destructive rule?
//   2. Is every executed command read-only (or a recorded verification
//      command, or a `clawket` call), so the active-task gate can be skipped?
//
// Both questions are about what the shell will *execute*, not about the raw
// text, so the string is lexed (quotes, escapes, heredocs, substitutions) and
// parsed into simple commands first. Quoted arguments and heredoc bodies are
// data unless they are handed to something that executes them (`bash -c`,
// `eval`, a shell or SQL client reading stdin, `xargs`, `find -exec`,
// command substitution), in which case they are parsed recursively.
//
// Unsupported syntax (`case`, function definitions, unbalanced quotes) makes
// the parse fail. Callers must then fall back to the conservative behaviour:
// destructive rules run their legacy raw-text regex, and the command is never
// classified as read-only.

const path = require('path');

class ParseError extends Error {}

const MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

function readBalanced(src, i, open, close) {
  // `i` points just past the opening delimiter. Returns [inner, indexAfterClose].
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === "'") {
      const k = src.indexOf("'", j + 1);
      if (k < 0) throw new ParseError('unterminated single quote');
      j = k + 1;
      continue;
    }
    if (c === '"') {
      j = skipDouble(src, j + 1);
      continue;
    }
    if (c === '`') {
      const k = findBacktickEnd(src, j + 1);
      j = k + 1;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return [src.slice(i, j), j + 1];
    }
    j++;
  }
  throw new ParseError(`unterminated ${open}${close}`);
}

function skipDouble(src, j) {
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '"') return j + 1;
    if (c === '$' && src[j + 1] === '(') {
      j = readBalanced(src, j + 2, '(', ')')[1];
      continue;
    }
    if (c === '`') { j = findBacktickEnd(src, j + 1) + 1; continue; }
    j++;
  }
  throw new ParseError('unterminated double quote');
}

function findBacktickEnd(src, j) {
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === '`') return j;
    j++;
  }
  throw new ParseError('unterminated backtick');
}

function unescapeBacktick(s) {
  return s.replace(/\\([`\\$])/g, '$1');
}

function decodeAnsiC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/g, (m, e) => {
    const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
    if (e in map) return map[e];
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return m;
  });
}

// Handles one `$...` expansion starting at src[i] === '$'. Appends to `word`
// and returns the index after the expansion.
function lexDollar(src, i, word) {
  const next = src[i + 1];
  if (next === '(' && src[i + 2] === '(') {
    // Arithmetic expansion. It executes nothing itself, but may nest `$(...)`.
    const [inner, end] = readBalanced(src, i + 3, '(', ')');
    if (src[end] !== ')') throw new ParseError('unterminated arithmetic expansion');
    word.raw += src.slice(i, end + 1);
    word.text += src.slice(i, end + 1);
    word.expansion = true;
    for (const s of extractSubs(inner)) word.subs.push(s);
    return end + 1;
  }
  if (next === '(') {
    const [inner, end] = readBalanced(src, i + 2, '(', ')');
    word.subs.push(inner);
    word.raw += src.slice(i, end);
    word.text += src.slice(i, end);
    word.expansion = true;
    return end;
  }
  if (next === '{') {
    const [inner, end] = readBalanced(src, i + 2, '{', '}');
    for (const s of extractSubs(inner)) word.subs.push(s);
    word.raw += src.slice(i, end);
    word.text += src.slice(i, end);
    word.expansion = true;
    return end;
  }
  const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-])/.exec(src.slice(i));
  if (m) {
    word.raw += m[0];
    word.text += m[0];
    word.expansion = true;
    return i + m[0].length;
  }
  word.raw += '$';
  word.text += '$';
  return i + 1;
}

// Finds command substitutions inside text that the shell expands the way it
// expands a double-quoted string (unquoted heredoc bodies, `${...}` bodies).
function extractSubs(text) {
  const subs = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '$' && text[i + 1] === '(') {
      if (text[i + 2] === '(') {
        const [inner, end] = readBalanced(text, i + 3, '(', ')');
        subs.push(...extractSubs(inner));
        i = end + 1;
        continue;
      }
      const [inner, end] = readBalanced(text, i + 2, '(', ')');
      subs.push(inner);
      i = end;
      continue;
    }
    if (c === '`') {
      const end = findBacktickEnd(text, i + 1);
      subs.push(unescapeBacktick(text.slice(i + 1, end)));
      i = end + 1;
      continue;
    }
    i++;
  }
  return subs;
}

const REDIR_OPS = ['<<<', '<<-', '&>>', '<<', '<&', '<>', '>>', '>|', '>&', '&>', '<', '>'];

function newWord() {
  return { type: 'word', text: '', raw: '', quoted: false, subs: [], expansion: false, procSub: false };
}

function lex(src) {
  const toks = [];
  const pending = []; // heredoc redirect tokens waiting for their body
  let word = null;
  let i = 0;
  const n = src.length;
  // Inside `[[ … ]]`, `&&` `||` `(` `)` `<` `>` are test operators, not shell
  // control operators or redirections.
  let inTest = false;

  const startWord = () => { if (!word) word = newWord(); };
  const endWord = () => {
    if (!word) return;
    const prev = toks[toks.length - 1];
    if (prev && prev.type === 'redir' && prev.heredoc && prev.delim === undefined) {
      prev.delim = word.text;
      prev.delimQuoted = word.quoted;
      pending.push(prev);
    }
    if (!word.quoted && word.text === '[[') inTest = true;
    else if (!word.quoted && word.text === ']]') inTest = false;
    toks.push(word);
    word = null;
  };

  const readHeredocBodies = (pos) => {
    for (const tok of pending) {
      const lines = [];
      let found = false;
      while (pos < n) {
        let nl = src.indexOf('\n', pos);
        if (nl < 0) nl = n;
        let line = src.slice(pos, nl);
        pos = nl + 1;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const cmp = tok.op === '<<-' ? line.replace(/^\t+/, '') : line;
        if (cmp === tok.delim) { found = true; break; }
        lines.push(tok.op === '<<-' ? cmp : line);
      }
      tok.body = lines.join('\n');
      tok.terminated = found;
    }
    pending.length = 0;
    return pos;
  };

  while (i < n) {
    const c = src[i];

    if (c === '\n' || c === '\r') {
      endWord();
      toks.push({ type: 'op', value: '\n' });
      i += (c === '\r' && src[i + 1] === '\n') ? 2 : 1;
      if (pending.length) i = readHeredocBodies(i);
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '#' && !word) {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (src[i + 1] === '\r' && src[i + 2] === '\n') { i += 3; continue; }
      startWord();
      if (i + 1 < n) {
        word.text += src[i + 1];
        word.raw += src.slice(i, i + 2);
        word.quoted = true;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      startWord();
      const k = src.indexOf("'", i + 1);
      if (k < 0) throw new ParseError('unterminated single quote');
      word.text += src.slice(i + 1, k);
      word.raw += src.slice(i, k + 1);
      word.quoted = true;
      i = k + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      startWord();
      let k = i + 2;
      while (k < n && src[k] !== "'") k += src[k] === '\\' ? 2 : 1;
      if (k >= n) throw new ParseError('unterminated $\' quote');
      word.text += decodeAnsiC(src.slice(i + 2, k));
      word.raw += src.slice(i, k + 1);
      word.quoted = true;
      i = k + 1;
      continue;
    }
    if (c === '"') {
      startWord();
      word.quoted = true;
      const startRaw = i;
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new ParseError('unterminated double quote');
        const d = src[j];
        if (d === '"') { j++; break; }
        if (d === '\\') {
          const e = src[j + 1];
          if (e === '\n') { j += 2; continue; }
          if (e === '$' || e === '`' || e === '"' || e === '\\') { word.text += e; j += 2; continue; }
          word.text += '\\';
          j++;
          continue;
        }
        if (d === '$') {
          const tmp = newWord();
          j = lexDollar(src, j, tmp);
          word.text += tmp.text;
          word.subs.push(...tmp.subs);
          if (tmp.expansion) word.expansion = true;
          continue;
        }
        if (d === '`') {
          const end = findBacktickEnd(src, j + 1);
          word.subs.push(unescapeBacktick(src.slice(j + 1, end)));
          word.text += src.slice(j, end + 1);
          word.expansion = true;
          j = end + 1;
          continue;
        }
        word.text += d;
        j++;
      }
      word.raw += src.slice(startRaw, j);
      i = j;
      continue;
    }
    if (c === '$') {
      startWord();
      i = lexDollar(src, i, word);
      continue;
    }
    if (c === '`') {
      startWord();
      const end = findBacktickEnd(src, i + 1);
      word.subs.push(unescapeBacktick(src.slice(i + 1, end)));
      word.text += src.slice(i, end + 1);
      word.raw += src.slice(i, end + 1);
      word.expansion = true;
      i = end + 1;
      continue;
    }
    if (inTest && '&|()<>!='.includes(c)) {
      const testOp = ['&&', '||', '==', '!=', '=~', '(', ')', '<', '>', '!', '='].find((o) => src.startsWith(o, i));
      if (testOp && !(testOp === '=' && word) && !(testOp === '!' && word)) {
        endWord();
        toks.push({ ...newWord(), text: testOp, raw: testOp });
        i += testOp.length;
        continue;
      }
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(' && !word) {
      const [inner, end] = readBalanced(src, i + 2, '(', ')');
      word = newWord();
      word.procSub = true;
      word.subs.push(inner);
      word.text = src.slice(i, end);
      word.raw = word.text;
      word.expansion = true;
      i = end;
      endWord();
      continue;
    }

    // Redirections (optionally preceded by an unquoted fd number).
    if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
      let fd = null;
      if (word && !word.quoted && /^\d+$/.test(word.raw)) { fd = word.raw; word = null; }
      endWord();
      const op = REDIR_OPS.find((o) => src.startsWith(o, i));
      toks.push({ type: 'redir', op, fd, heredoc: op === '<<' || op === '<<-' });
      i += op.length;
      continue;
    }

    // Control operators.
    const ops = ['&&', '||', ';;', ';&', '|&', ';', '|', '&', '(', ')'];
    const op = ops.find((o) => src.startsWith(o, i));
    if (op) {
      endWord();
      toks.push({ type: 'op', value: op });
      i += op.length;
      continue;
    }

    startWord();
    word.text += c;
    word.raw += c;
    i++;
  }
  endWord();
  if (pending.length) {
    // Heredoc on the last line with no body: the body is empty.
    for (const tok of pending) { tok.body = ''; tok.terminated = false; }
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseTokens(toks) {
  let pos = 0;
  const isOp = (t, v) => t && t.type === 'op' && t.value === v;
  const isCloseBrace = (t) => t && t.type === 'word' && !t.quoted && t.text === '}';

  function parseList(closer) {
    const items = [];
    while (pos < toks.length) {
      const t = toks[pos];
      if (isOp(t, '\n') || isOp(t, ';')) { pos++; continue; }
      if (closer === ')' && isOp(t, ')')) return items;
      if (closer === '}' && isCloseBrace(t)) return items;
      const pipeline = parsePipeline(closer);
      const s = toks[pos];
      let sep = null;
      if (s && s.type === 'op' && ['&&', '||', ';', '&', '\n'].includes(s.value)) { sep = s.value; pos++; }
      else if (s && s.type === 'op' && (s.value === ';;' || s.value === ';&')) throw new ParseError('case clauses are not supported');
      items.push({ pipeline, sep });
    }
    if (closer) throw new ParseError(`missing ${closer}`);
    return items;
  }

  function parsePipeline(closer) {
    const cmds = [parseCommand(closer)];
    while (isOp(toks[pos], '|') || isOp(toks[pos], '|&')) {
      pos++;
      while (isOp(toks[pos], '\n')) pos++;
      cmds.push(parseCommand(closer));
    }
    return cmds;
  }

  function parseRedirs() {
    const redirs = [];
    while (toks[pos] && toks[pos].type === 'redir') {
      const r = toks[pos++];
      const target = toks[pos];
      if (!target || target.type !== 'word') throw new ParseError('redirection without target');
      pos++;
      redirs.push({ op: r.op, fd: r.fd, target, body: r.body, delimQuoted: r.delimQuoted });
    }
    return redirs;
  }

  function parseCommand(closer) {
    const t = toks[pos];
    if (!t) throw new ParseError('expected a command');
    if (isOp(t, '(') && isOp(toks[pos + 1], '(')) throw new ParseError('arithmetic commands are not supported');
    if (isOp(t, '(')) {
      pos++;
      const body = parseList(')');
      pos++;
      return { kind: 'subshell', body, redirs: parseRedirs() };
    }
    if (t.type === 'op') throw new ParseError(`unexpected ${JSON.stringify(t.value)}`);
    if (t.type === 'word' && !t.quoted && t.text === '{') {
      pos++;
      const body = parseList('}');
      pos++;
      return { kind: 'group', body, redirs: parseRedirs() };
    }
    if (t.type === 'word' && !t.quoted && (t.text === 'case' || t.text === 'function' || t.text === 'select' || t.text === 'coproc')) {
      throw new ParseError(`${t.text} is not supported`);
    }
    const cmd = { kind: 'simple', assigns: [], words: [], redirs: [] };
    while (pos < toks.length) {
      const u = toks[pos];
      if (u.type === 'op') {
        if (u.value === '(') throw new ParseError('function definitions are not supported');
        break;
      }
      if (u.type === 'redir') { cmd.redirs.push(...parseRedirs()); continue; }
      if (closer === '}' && isCloseBrace(u) && cmd.words.length === 0 && cmd.assigns.length === 0) break;
      if (cmd.words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(u.raw)) {
        cmd.assigns.push(u);
        pos++;
        continue;
      }
      cmd.words.push(u);
      pos++;
    }
    if (!cmd.words.length && !cmd.assigns.length && !cmd.redirs.length) throw new ParseError('empty command');
    return cmd;
  }

  return parseList(null);
}

function parse(src) {
  return parseTokens(lex(String(src)));
}

// ---------------------------------------------------------------------------
// Execution model: flatten a script into the commands that would execute
// ---------------------------------------------------------------------------

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const SQL_CLIENTS = new Set(['sqlite3', 'sqlite', 'psql', 'mysql', 'mariadb', 'duckdb', 'sqlcmd', 'clickhouse-client']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun']);
// Builtins whose resolution does not consult PATH.
const PATH_INDEPENDENT = new Set(['cd', 'pushd', 'popd', 'export', 'unset', 'set', 'echo', 'printf', 'test', '[', '[[', ']]',
  'type', 'command', 'builtin', 'true', 'false', ':', 'pwd', 'read', 'declare', 'typeset', 'local', 'readonly']);
const SYSTEM_BIN_DIRS = new Set(['/bin', '/usr/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin']);
const PREFIX_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time']);
const END_KEYWORDS = new Set(['fi', 'done', 'esac', '}']);
const WRITE_REDIRS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
const SAFE_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

function base(name) {
  return path.basename(String(name || ''));
}

// Strip transparent and privileged wrappers. Returns the wrapped argv plus the
// wrapper names. `opaque` is set when the wrapped command cannot be known.
function unwrap(argv) {
  const wrappers = [];
  const envAssigns = [];
  let a = argv.slice();
  for (let guard = 0; guard < 16 && a.length; guard++) {
    const name = base(a[0]);
    let i = 1;
    if (name === 'env') {
      while (i < a.length) {
        const x = a[i];
        if (['-i', '--ignore-environment', '-0', '--null', '-v', '--debug', '-'].includes(x)) i++;
        else if (['-u', '--unset', '-C', '--chdir'].includes(x)) i += 2;
        else if (/^--(unset|chdir)=/.test(x)) i++;
        else if (x === '-S' || x.startsWith('--split-string') || /^-[a-zA-Z]*S/.test(x)) return { argv: a, wrappers, opaque: 'env -S' };
        else if (x === '--') { i++; break; }
        else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) {
          const eq = x.indexOf('=');
          envAssigns.push({ name: x.slice(0, eq), value: x.slice(eq + 1), dynamic: /[$`]/.test(x) });
          i++;
        }
        else break;
      }
      if (i >= a.length) return { argv: ['env'], wrappers, envAssigns };
      wrappers.push('env');
      a = a.slice(i);
      continue;
    }
    if (name === 'nice') {
      if (a[1] === '-n') i = 3;
      else if (/^(-n?-?\d+|--adjustment=.*)$/.test(a[1] || '')) i = 2;
      wrappers.push('nice');
      a = a.slice(i);
      continue;
    }
    if (name === 'timeout') {
      while (i < a.length && a[i].startsWith('-')) i += ['-s', '--signal', '-k', '--kill-after'].includes(a[i]) ? 2 : 1;
      i++; // duration
      wrappers.push('timeout');
      a = a.slice(i);
      continue;
    }
    if (name === 'nohup' || name === 'time' || name === 'builtin') {
      if (name === 'time') while (i < a.length && a[i].startsWith('-')) i++;
      wrappers.push(name);
      a = a.slice(i);
      continue;
    }
    if (name === 'stdbuf') {
      while (i < a.length && a[i].startsWith('-')) i += a[i].length === 2 ? 2 : 1;
      wrappers.push('stdbuf');
      a = a.slice(i);
      continue;
    }
    if (name === 'sudo' || name === 'doas') {
      while (i < a.length && a[i].startsWith('-')) {
        if (a[i] === '--') { i++; break; }
        i += ['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '-T', '-D'].includes(a[i]) ? 2 : 1;
      }
      wrappers.push(name);
      a = a.slice(i);
      continue;
    }
    if (name === 'command') {
      if (a[1] === '-v' || a[1] === '-V') return { argv: a, wrappers, envAssigns };
      while (i < a.length && a[i] === '-p') i++;
      wrappers.push('command');
      a = a.slice(i);
      continue;
    }
    if (name === 'exec') {
      while (i < a.length && a[i].startsWith('-')) i += a[i] === '-a' ? 2 : 1;
      wrappers.push('exec');
      a = a.slice(i);
      continue;
    }
    if (name === 'xargs') {
      const valued = ['-I', '-n', '-L', '-P', '-s', '-d', '-E', '-a', '-l'];
      while (i < a.length && a[i].startsWith('-')) {
        const x = a[i];
        if (x === '--') { i++; break; }
        if (valued.includes(x)) { i += 2; continue; }
        i++;
      }
      wrappers.push('xargs');
      a = i < a.length ? a.slice(i) : ['echo'];
      continue;
    }
    if (name === 'npx' || name === 'bunx') {
      while (i < a.length && a[i].startsWith('-')) {
        if (a[i] === '--') { i++; break; }
        if (a[i] === '-c' || a[i] === '--call') return { argv: a, wrappers, opaque: `${name} -c` };
        i += ['-p', '--package'].includes(a[i]) ? 2 : 1;
      }
      wrappers.push(name);
      a = a.slice(i);
      continue;
    }
    if (['pnpm', 'npm', 'yarn', 'bun'].includes(name)) {
      const rest = pkgSplit(a);
      const sub = rest[0];
      if (sub === 'exec' || sub === 'dlx' || sub === 'x') {
        let k = 1;
        while (k < rest.length && rest[k].startsWith('-')) {
          if (rest[k] === '--') { k++; break; }
          if (rest[k] === '-c' || rest[k] === '--call') return { argv: a, wrappers, opaque: `${name} ${sub} -c` };
          k += ['-p', '--package'].includes(rest[k]) ? 2 : 1;
        }
        wrappers.push(`${name} ${sub}`);
        a = rest.slice(k);
        continue;
      }
    }
    break;
  }
  return { argv: a, wrappers, envAssigns };
}

function shellScriptArg(argv) {
  // Returns { mode: 'c', script } | { mode: 'file' } | { mode: 'stdin' }.
  let i = 1;
  let hasC = false;
  while (i < argv.length) {
    const x = argv[i];
    if (x === '--') { i++; break; }
    if (!/^[-+]/.test(x) || x === '-' || x === '+') break;
    if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(x)) { i += 2; continue; }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(x)) hasC = true;
    i++;
  }
  if (hasC) return { mode: 'c', script: argv[i] === undefined ? '' : argv[i] };
  if (i < argv.length && argv[i] !== '-') return { mode: 'file' };
  return { mode: 'stdin' };
}

function stdinTexts(rec) {
  const out = [];
  for (const r of rec.redirs) {
    if (r.op === '<<' || r.op === '<<-') out.push(r.body || '');
    else if (r.op === '<<<') out.push(r.target.text);
  }
  if (rec.stdinLiteral != null) out.push(rec.stdinLiteral);
  return out;
}

function literalOutput(cmd) {
  // Text a pipeline stage writes to stdout when it is a literal producer
  // (echo / printf / cat <<EOF). `null` when unknown.
  if (!cmd || cmd.kind !== 'simple' || !cmd.words.length) return null;
  const { argv } = unwrap(cmd.words.map((w) => w.text));
  const name = base(argv[0]);
  if (name === 'echo') return argv.slice(1).filter((x) => !/^-[neE]+$/.test(x)).join(' ');
  if (name === 'printf') return argv.slice(1).join(' ');
  if (name === 'cat' && argv.length === 1) {
    const texts = [];
    for (const r of cmd.redirs) {
      if (r.op === '<<' || r.op === '<<-') texts.push(r.body || '');
      else if (r.op === '<<<') texts.push(r.target.text);
    }
    return texts.length ? texts.join('\n') : null;
  }
  return null;
}

function newAnalysis() {
  return { ok: true, records: [], constructs: [], fragments: [] };
}

function addConstruct(out, kind, detail) {
  out.constructs.push(detail ? { kind, detail } : { kind });
}

function collectSubstitution(text, out, depth, kind) {
  addConstruct(out, kind);
  collectScript(text, out, depth + 1);
}

function collectScript(text, out, depth) {
  if (depth > MAX_DEPTH) {
    out.fragments.push(text);
    addConstruct(out, 'too-deep');
    return;
  }
  let items;
  try {
    items = parse(text);
  } catch (err) {
    // A nested fragment we cannot parse: remember it so destructive detection
    // can fall back to raw-text rules for that part only.
    out.fragments.push(text);
    addConstruct(out, 'unparseable', err.message);
    return;
  }
  collectItems(items, out, depth);
}

function collectItems(items, out, depth) {
  for (const item of items) {
    if (item.sep === '&') addConstruct(out, 'background');
    item.pipeline.forEach((cmd, index) => {
      const prev = index > 0 ? item.pipeline[index - 1] : null;
      collectCommand(cmd, { index, prev }, out, depth);
    });
  }
}

function collectWordSubs(word, out, depth) {
  for (const s of word.subs) collectSubstitution(s, out, depth, word.procSub ? 'process-substitution' : 'substitution');
}

function collectCommand(cmd, meta, out, depth) {
  if (cmd.kind === 'subshell' || cmd.kind === 'group') {
    addConstruct(out, cmd.kind);
    collectItems(cmd.body, out, depth);
    if (cmd.redirs.length) pushRecord({ argv: [], redirs: cmd.redirs, wrappers: [] }, out, depth);
    return;
  }
  for (const w of [...cmd.assigns, ...cmd.words]) collectWordSubs(w, out, depth);
  for (const r of cmd.redirs) {
    collectWordSubs(r.target, out, depth);
    if ((r.op === '<<' || r.op === '<<-') && !r.delimQuoted && r.body) {
      let subs = [];
      try { subs = extractSubs(r.body); } catch { out.fragments.push(r.body); addConstruct(out, 'unparseable', 'heredoc'); }
      for (const s of subs) collectSubstitution(s, out, depth, 'substitution');
    }
  }

  let words = cmd.words;
  while (words.length && !words[0].quoted && PREFIX_KEYWORDS.has(words[0].text)) words = words.slice(1);
  if (words.length && !words[0].quoted && END_KEYWORDS.has(words[0].text)) words = [];
  if (words.length && !words[0].quoted && words[0].text === 'for') {
    // `for x in a b c` — the header is data; the loop body is separate items.
    // The loop variable is an assignment, so it is checked like one.
    if (words[1]) assignmentCheck({ name: words[1].text, value: '', dynamic: true }, null, out);
    words = [];
  }
  const assigns = cmd.assigns.map(parseAssignment);
  const argv = words.map((w) => w.text);

  const stdinLiteral = meta.index > 0 ? literalOutput(meta.prev) : null;
  const stdinUnknown = meta.index > 0 && stdinLiteral == null;
  emitExec(argv, cmd.redirs, {
    stdinLiteral,
    stdinUnknown,
    assigns,
    head: words[0] || null,
    words,
  }, out, depth);
}

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=/;
// Variables that change what a later command executes (pagers, git hooks into
// external programs, dynamic-linker injection, shell start-up files, …).
const DANGEROUS_ENV_RE = /^(PAGER|MANPAGER|GH_PAGER|GIT_.*|LD_.*|DYLD_.*|BASH_ENV|ENV|PS4|PROMPT_COMMAND|NODE_OPTIONS|IFS|SHELLOPTS|BASHOPTS|LESSOPEN|LESSCLOSE|BROWSER|GH_BROWSER|EDITOR|VISUAL|PERL5OPT|RUBYOPT|PYTHONSTARTUP|BASH_FUNC_.*)$/;
const PAGER_VARS = new Set(['PAGER', 'MANPAGER', 'GH_PAGER', 'GIT_PAGER']);
const SAFE_PAGER_VALUES = new Set(['', 'cat', 'less', 'more']);

function parseAssignment(word) {
  const m = ASSIGN_RE.exec(word.raw) || ASSIGN_RE.exec(word.text);
  const name = m ? m[1] : word.text.split('=')[0];
  const eq = word.text.indexOf('=');
  return { name, value: eq < 0 ? '' : word.text.slice(eq + 1), dynamic: word.expansion };
}

// `command` is the command the assignment prefixes, or null when it is
// standalone / exported (then it affects every later command).
function assignmentCheck(a, command, out) {
  if (DANGEROUS_ENV_RE.test(a.name)) {
    if (PAGER_VARS.has(a.name) && !a.dynamic && SAFE_PAGER_VALUES.has(a.value)) return;
    addConstruct(out, 'dangerous-assign', `${a.name}= changes what commands execute`);
    return;
  }
  if (a.name === 'PATH') {
    if (command === null) out.pathModified = true;
    else if (command !== 'clawket') addConstruct(out, 'dangerous-assign', 'PATH= changes which binary runs');
  }
}

function dynamicOptionArgs(words, argv) {
  if (!words.length || argv.length > words.length) return [];
  const tail = words.slice(words.length - argv.length);
  if (!tail.every((w, k) => w.text === argv[k])) return [];
  return tail.slice(1).filter((w) => w.expansion && /^[-$]/.test(w.text)).map((w) => w.raw);
}

function emitExec(argv, redirs, meta, out, depth) {
  const assigns = meta.assigns || [];
  if (!argv.length) {
    for (const a of assigns) assignmentCheck(a, null, out);
    pushRecord({ argv: [], redirs, wrappers: [], assignsOnly: assigns.length > 0 }, out, depth);
    return;
  }
  const u = unwrap(argv);
  const rec = {
    argv: u.argv,
    redirs,
    wrappers: u.wrappers,
    stdinLiteral: meta.stdinLiteral,
    stdinUnknown: meta.stdinUnknown,
    headDynamic: !!(meta.head && meta.head.expansion),
    headPath: u.argv[0] || '',
    // Arguments that are expansions able to turn into an option: dynamic
    // words (unquoted or double-quoted `$…`) whose text starts with `-` or
    // `$`. The unwrapped argv is a suffix of the original words.
    dynamicOptionArgs: dynamicOptionArgs(meta.words || [], u.argv),
    anyDynamicArg: (meta.words || []).slice(1).some((w) => w.expansion),
  };
  const finalName = base(u.argv[0]);
  for (const a of [...assigns, ...(u.envAssigns || [])]) assignmentCheck(a, finalName, out);
  if (finalName === 'export' || finalName === 'declare' || finalName === 'typeset' || finalName === 'local' || finalName === 'readonly') {
    for (const x of u.argv.slice(1)) {
      if (x.startsWith('-')) continue;
      const eq = x.indexOf('=');
      assignmentCheck({ name: eq < 0 ? x : x.slice(0, eq), value: eq < 0 ? '' : x.slice(eq + 1), dynamic: /[$`]/.test(x) }, null, out);
    }
  }
  if (finalName === 'read') {
    for (const x of operands(u.argv.slice(1))) assignmentCheck({ name: x, value: '', dynamic: true }, null, out);
  }
  if (out.pathModified && finalName !== 'clawket' && !PATH_INDEPENDENT.has(finalName)) {
    addConstruct(out, 'dangerous-assign', `PATH was changed earlier; ${finalName} could resolve to any binary`);
  }
  if (u.opaque) addConstruct(out, 'opaque', u.opaque);
  for (const w of u.wrappers) if (['sudo', 'doas', 'exec', 'command', 'builtin'].includes(w)) addConstruct(out, w);
  if (!rec.argv.length) {
    pushRecord(rec, out, depth);
    return;
  }
  const name = base(rec.argv[0]);

  if (SHELLS.has(name)) {
    const s = shellScriptArg(rec.argv);
    if (s.mode === 'c') {
      addConstruct(out, 'shell-c');
      collectScript(s.script, out, depth + 1);
    } else if (s.mode === 'file') {
      addConstruct(out, 'opaque', `${name} script file`);
    } else {
      addConstruct(out, 'shell-stdin');
      const texts = stdinTexts(rec);
      for (const tx of texts) collectScript(tx, out, depth + 1);
      if (!texts.length || rec.stdinUnknown) addConstruct(out, 'opaque', `${name} reading unknown stdin`);
    }
  } else if (name === 'eval') {
    addConstruct(out, 'eval');
    collectScript(rec.argv.slice(1).join(' '), out, depth + 1);
  } else if (name === 'source' || name === '.') {
    addConstruct(out, 'source');
  } else if (name === 'find') {
    const a = rec.argv;
    for (let i = 1; i < a.length; i++) {
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(a[i])) {
        let j = i + 1;
        while (j < a.length && a[j] !== ';' && a[j] !== '+') j++;
        const inner = a.slice(i + 1, j);
        if (inner.length) emitExec(inner, [], { stdinLiteral: null, stdinUnknown: false }, out, depth);
        i = j;
      }
    }
  }
  pushRecord(rec, out, depth);
}

function pushRecord(rec, out, depth) {
  rec.name = rec.argv.length ? base(rec.argv[0]) : '';
  rec.depth = depth;
  out.records.push(rec);
}

function analyze(src) {
  const out = newAnalysis();
  let items;
  try {
    items = parse(String(src || ''));
  } catch (err) {
    return { ok: false, error: err.message, records: [], constructs: [], fragments: [] };
  }
  collectItems(items, out, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function optionArgs(args) {
  const out = [];
  for (const a of args) {
    if (a === '--') break;
    if (a.startsWith('-') && a !== '-') out.push(a);
  }
  return out;
}

function operands(args) {
  const out = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a.startsWith('-') && a !== '-') continue;
    out.push(a);
  }
  return out;
}

function hasFlag(args, alternatives) {
  const opts = optionArgs(args);
  return alternatives.some((alt) => {
    if (alt.startsWith('--')) return opts.some((o) => o === alt || o.startsWith(`${alt}=`));
    if (alt.startsWith('-') && alt.length > 2) return opts.includes(alt);
    const letter = alt.replace(/^-/, '');
    return opts.some((o) => !o.startsWith('--') && /^-[A-Za-z0-9]+$/.test(o) && o.includes(letter));
  });
}

function writeRedirectTargets(rec) {
  const out = [];
  for (const r of rec.redirs) {
    const t = r.target.text;
    if (WRITE_REDIRS.has(r.op)) out.push({ op: r.op, target: t });
    else if (r.op === '>&' && !/^(\d+|-)$/.test(t)) out.push({ op: '>', target: t });
  }
  return out;
}

function gitSplit(argv) {
  const rest = argv.slice(1);
  const globals = [];
  let i = 0;
  const valued = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--list-cmds'];
  const flags = ['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs',
    '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--exec-path',
    '--html-path', '--man-path', '--info-path', '--no-lazy-fetch', '--no-advice', '--version', '--help'];
  while (i < rest.length) {
    const a = rest[i];
    if (valued.includes(a)) { globals.push(a, rest[i + 1]); i += 2; continue; }
    if (a.startsWith('--') && a.includes('=')) { globals.push(a); i++; continue; }
    if (flags.includes(a)) { globals.push(a); i++; continue; }
    if (/^-[Cc]./.test(a)) { globals.push(a); i++; continue; }
    break;
  }
  return { globals, path: rest.slice(i) };
}

function dockerSplit(argv) {
  const rest = argv.slice(1);
  let i = 0;
  const valued = ['-H', '--host', '--context', '-c', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey'];
  while (i < rest.length) {
    const a = rest[i];
    if (valued.includes(a)) { i += 2; continue; }
    if (a.startsWith('--') && a.includes('=')) { i++; continue; }
    if (['-D', '--debug', '--tls', '--tlsverify'].includes(a)) { i++; continue; }
    break;
  }
  return rest.slice(i);
}

function pkgSplit(argv) {
  const rest = argv.slice(1);
  let i = 0;
  const valued = ['-C', '--dir', '--prefix', '--filter', '-F', '--workspace', '--cwd'];
  const flags = ['-w', '-W', '-r', '--recursive', '-s', '--silent', '--workspace-root', '--if-present', '-q', '--quiet', '--stream', '--parallel'];
  while (i < rest.length) {
    const a = rest[i];
    if (valued.includes(a)) { i += 2; continue; }
    if (a.startsWith('--') && a.includes('=') && !a.startsWith('--version')) { i++; continue; }
    if (flags.includes(a)) { i++; continue; }
    break;
  }
  return rest.slice(i);
}

function cargoSplit(argv) {
  const rest = argv.slice(1);
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a.startsWith('+')) { i++; continue; }
    if (['-Z', '--color', '-C', '--config'].includes(a)) { i += 2; continue; }
    if (['-q', '--quiet', '-v', '-vv', '--verbose', '--locked', '--offline', '--frozen'].includes(a)) { i++; continue; }
    break;
  }
  return rest.slice(i);
}

function subcommandPath(rec) {
  const name = rec.name;
  if (name === 'git') return gitSplit(rec.argv).path;
  if (name === 'docker' || name === 'podman') return dockerSplit(rec.argv);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return pkgSplit(rec.argv);
  if (name === 'cargo') return cargoSplit(rec.argv);
  return rec.argv.slice(1);
}

function sqlTexts(rec) {
  const name = rec.name;
  if (SQL_CLIENTS.has(name)) return [...rec.argv.slice(1), ...stdinTexts(rec)];
  if (INTERPRETERS.has(name)) {
    const out = [];
    const a = rec.argv;
    for (let i = 1; i < a.length; i++) {
      if (['-c', '-e', '-E', '-r', '-p', '--eval', '--print'].includes(a[i]) && i + 1 < a.length) { out.push(a[i + 1]); i++; }
      else if (/^--(eval|print)=/.test(a[i])) out.push(a[i].replace(/^--(eval|print)=/, ''));
    }
    const hasScriptFile = operands(a.slice(1)).some((x) => !out.includes(x) && x !== '-');
    if (!hasScriptFile) out.push(...stdinTexts(rec));
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Destructive rule matching
// ---------------------------------------------------------------------------

function compile(re, flags) {
  return re instanceof RegExp ? re : new RegExp(re, flags || '');
}

function matchAlternative(alt, rec, reFlags) {
  if (alt.command && !alt.command.includes(rec.name)) return false;
  if (!alt.command && !alt.writeRedirectPattern && !rec.name) return false;
  const args = rec.argv.slice(1);
  if (alt.subcommand) {
    const p = subcommandPath(rec);
    const ok = alt.subcommand.some((want) => want.every((w, k) => {
      const alts = Array.isArray(w) ? w : [w];
      return alts.includes(p[k]);
    }));
    if (!ok) return false;
  }
  if (alt.flags && !alt.flags.every((group) => hasFlag(args, group))) return false;
  if (alt.arg && !args.some((a) => alt.arg.includes(a))) return false;
  if (alt.argPattern) {
    const re = compile(alt.argPattern, reFlags);
    if (!args.some((a) => re.test(a))) return false;
  }
  if (alt.operandPattern) {
    const re = compile(alt.operandPattern, reFlags);
    if (!operands(args).some((a) => re.test(a))) return false;
  }
  if (alt.firstOperandPattern) {
    const first = operands(args)[0];
    if (first === undefined || !compile(alt.firstOperandPattern, reFlags).test(first)) return false;
  }
  if (alt.sqlPattern) {
    const re = compile(alt.sqlPattern, reFlags);
    if (!sqlTexts(rec).some((t) => re.test(t))) return false;
  }
  if (alt.writeRedirectPattern) {
    const re = compile(alt.writeRedirectPattern, reFlags);
    const ops = alt.writeRedirectOps || ['>', '>|', '&>'];
    if (!writeRedirectTargets(rec).some((r) => ops.includes(r.op) && re.test(r.target))) return false;
  }
  return true;
}

function patternMatchesRecord(pattern, rec) {
  const alts = Array.isArray(pattern.match) ? pattern.match : [pattern.match];
  const reFlags = pattern.match_flags || pattern.flags || '';
  return alts.some((alt) => matchAlternative(alt, rec, reFlags));
}

function legacyRegex(pattern) {
  if (!pattern.regex) return null;
  if (!pattern._legacy) pattern._legacy = new RegExp(pattern.regex, pattern.flags || '');
  return pattern._legacy;
}

// Returns the first matching pattern, or null. `analysis` may be passed to
// avoid re-parsing.
function detectDestructive(src, patterns, analysis) {
  if (!src || typeof src !== 'string') return null;
  const a = analysis || analyze(src);
  for (const p of patterns) {
    if (!p.match) {
      // Catalog entries without a structural rule keep raw-text semantics.
      const re = legacyRegex(p);
      if (re && re.test(src)) return p;
      continue;
    }
    if (!a.ok) {
      const re = legacyRegex(p);
      if (re && re.test(src)) return p;
      continue;
    }
    if (a.records.some((rec) => patternMatchesRecord(p, rec))) return p;
    for (const frag of a.fragments) {
      const re = legacyRegex(p);
      if (re && re.test(frag)) return p;
    }
  }
  return null;
}

function matchPattern(pattern, src) {
  return detectDestructive(src, [pattern]) === pattern;
}

// ---------------------------------------------------------------------------
// Read-only / verification classification
// ---------------------------------------------------------------------------

const RO = 'readonly';
const VERIFY = 'verification';
const CLAWKET = 'clawket';
const MUT = 'mutating';

const ALWAYS_READONLY = new Set([
  'ls', 'pwd', 'wc', 'du', 'df', 'which', 'whereis', 'type', 'file', 'stat', 'cat', 'head', 'tail', 'less',
  'more', 'nl', 'shasum', 'sha1sum', 'sha224sum', 'sha256sum', 'sha384sum', 'sha512sum', 'md5', 'md5sum',
  'cksum', 'b2sum', 'ps', 'pgrep', 'test', '[', '[[', ']]', 'true', 'false', ':', 'echo', 'printf', 'uname',
  'whoami', 'id', 'basename', 'dirname', 'realpath', 'readlink', 'grep', 'egrep', 'fgrep', 'ag',
  'ack', 'tr', 'cut', 'comm', 'paste', 'diff', 'cmp', 'jq', 'hexdump', 'od', 'column', 'fold', 'rev', 'tac',
  'strings', 'lsof', 'printenv', 'locale', 'sw_vers', 'uptime', 'tty', 'seq', 'sleep', 'cd', 'pushd', 'popd',
  'dirs', 'getconf', 'nproc', 'arch', 'env', 'expand', 'unexpand', 'look', 'cal', 'groups', 'users', 'who',
  'w', 'last', 'vm_stat', 'sysctl', 'top', 'htop', 'pstree', 'lsblk', 'free', 'iostat', 'netstat', 'ss',
  'ifconfig', 'dig', 'nslookup', 'host', 'ping', 'otool', 'nm', 'ldd', 'codesign', 'spctl', 'mdls',
]);

function sedScriptWrites(script) {
  const cmd = /(^|[;\n{}])\s*(\d+|\$|\/(?:[^/\\]|\\.)*\/)?\s*(,\s*(\d+|\$|\/(?:[^/\\]|\\.)*\/))?\s*!?\s*[wWe](\s|$)/;
  const subst = /s([^\w\s\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpiImM0-9]*[we]/;
  // `r` / `R` splice in arbitrary files; treated like the writers so the
  // print-only contract stays simple.
  const read = /(^|[;\n{}])\s*(\d+|\$|\/(?:[^/\\]|\\.)*\/)?\s*(,\s*(\d+|\$|\/(?:[^/\\]|\\.)*\/))?\s*!?\s*[rR]\s*\S/;
  return cmd.test(script) || subst.test(script) || read.test(script);
}

function classifySed(args) {
  const scripts = [];
  let hasExplicit = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--in-place' || a.startsWith('--in-place=')) return [MUT, 'sed in-place edit'];
    if (/^-[a-zA-Z]*[iI]/.test(a) && !a.startsWith('--')) return [MUT, 'sed in-place edit'];
    if (a === '-f' || a === '--file' || a.startsWith('--file=')) return [MUT, 'sed script file'];
    if (a === '-e' || a === '--expression') { scripts.push(args[i + 1] || ''); hasExplicit = true; i++; continue; }
    if (a.startsWith('--expression=')) { scripts.push(a.slice(13)); hasExplicit = true; }
  }
  if (!hasExplicit) {
    const ops = operands(args);
    if (ops.length) scripts.push(ops[0]);
  }
  if (scripts.some(sedScriptWrites)) return [MUT, 'sed script writes or executes'];
  return [RO];
}

function classifyAwk(args) {
  let program = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-i' || a.startsWith('--include') || a === '-f' || a.startsWith('--file')) return [MUT, 'awk include/program file'];
    if (a === '-v' || a === '-F') { i++; continue; }
    if (a === '-e' || a === '--source') { program = (program || '') + (args[i + 1] || ''); i++; continue; }
    if (a.startsWith('-')) continue;
    if (program === null) { program = a; }
  }
  if (program && /\bsystem\s*\(|\|\s*getline|\|&|\bprint[f]?\b[^;{}]*[>|]|\bclose\s*\(/.test(program)) {
    return [MUT, 'awk program writes or executes'];
  }
  return [RO];
}

function classifyGit(rec) {
  const { globals, path: p } = gitSplit(rec.argv);
  // `-c` can point core.pager / diff.external / aliases at any program;
  // only cosmetic keys are read-only.
  const COSMETIC = /^(color\.[A-Za-z0-9.-]+|core\.quotepath)=/i;
  for (let i = 0; i < globals.length; i++) {
    const g = globals[i];
    if (g === '-c') {
      if (!COSMETIC.test(globals[i + 1] || '')) return [MUT, 'git -c can run configured commands'];
      i++;
      continue;
    }
    if (/^-c./.test(g) && !COSMETIC.test(g.slice(2))) return [MUT, 'git -c can run configured commands'];
    if (g === '--config-env' || g.startsWith('--config-env=') || g.startsWith('--exec-path=')) return [MUT, 'git global option runs configured commands'];
  }
  const [sub, ...a] = p;
  if (!sub) return [RO];
  if (a.some((x) => x === '--output' || x.startsWith('--output=') || x === '--ext-diff' || (sub === 'grep' && /^-[a-zA-Z]*O/.test(x)) || x.startsWith('--open-files-in-pager'))) {
    return [MUT, `git ${sub} writes output or runs an external program`];
  }
  const readonlySubs = new Set(['status', 'log', 'show', 'diff', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote',
    'cat-file', 'blame', 'annotate', 'describe', 'shortlog', 'grep', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref',
    'count-objects', 'var', 'check-ignore', 'check-attr', 'check-ref-format', 'cherry', 'whatchanged', 'version', 'help',
    'show-branch', 'range-diff', 'diff-tree', 'diff-files', 'diff-index', 'verify-commit', 'verify-tag']);
  if (readonlySubs.has(sub)) return [RO];
  if (sub === 'hash-object') return a.some((x) => x === '-w' || /^-[a-zA-Z]*w/.test(x) || x === '--stdin-paths') ? [MUT, 'git hash-object -w writes objects'] : [RO];
  const first = a.find((x) => !x.startsWith('-'));
  switch (sub) {
    case 'worktree': return a[0] === 'list' ? [RO] : [MUT, 'git worktree mutation'];
    case 'stash': return ['list', 'show'].includes(a[0]) ? [RO] : [MUT, 'git stash mutation'];
    case 'remote':
      if (a.every((x) => x === '-v' || x === '--verbose') || ['show', 'get-url'].includes(a[0])) return [RO];
      return [MUT, 'git remote mutation'];
    case 'reflog':
      if (!a.length || a[0] === 'show' || (a[0].startsWith('-'))) return [RO];
      return [MUT, 'git reflog mutation'];
    case 'notes': return ['list', 'show'].includes(a[0]) ? [RO] : [MUT, 'git notes mutation'];
    case 'submodule': return ['status', 'summary'].includes(a[0]) ? [RO] : [MUT, 'git submodule mutation'];
    case 'config': {
      const writes = ['--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit'];
      if (a.some((x) => writes.includes(x)) || ['set', 'unset', 'edit', 'rename-section', 'remove-section'].includes(first)) {
        return [MUT, 'git config write'];
      }
      const reads = ['--get', '--get-all', '--get-regexp', '--list', '-l', '--get-urlmatch', '--get-color', '--get-colorbool'];
      if (a.some((x) => reads.includes(x)) || ['get', 'list'].includes(first)) return [RO];
      return operands(a).length === 1 ? [RO] : [MUT, 'git config write'];
    }
    case 'branch': return listOnly(a, {
      flags: ['-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '-vv', '--verbose', '--show-current', '-i',
        '--ignore-case', '--no-color', '--color', '--no-column', '--column', '--omit-empty', '--no-abbrev', '--abbrev'],
      shortLetters: 'arlvi',
      valued: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'],
    }) ? [RO] : [MUT, 'git branch mutation'];
    case 'tag': return listOnly(a, {
      flags: ['-l', '--list', '-i', '--ignore-case', '--column', '--no-column', '--color', '--no-color'],
      shortLetters: 'li',
      nPattern: /^-n\d*$/,
      valued: ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'],
    }) ? [RO] : [MUT, 'git tag mutation'];
    default: return [MUT, `git ${sub}`];
  }
}

function listOnly(args, spec) {
  let listMode = false;
  const ops = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === '-l' || x === '--list') listMode = true;
    if (spec.valued.includes(x)) { i++; continue; }
    if (spec.valued.some((v) => x.startsWith(`${v}=`))) continue;
    if (spec.flags.includes(x) || (spec.nPattern && spec.nPattern.test(x))) continue;
    if (x.startsWith('--') && x.includes('=') && spec.flags.includes(x.split('=')[0])) continue;
    if (/^-[a-zA-Z]+$/.test(x) && [...x.slice(1)].every((ch) => spec.shortLetters.includes(ch))) {
      if (x.includes('l')) listMode = true;
      continue;
    }
    if (x.startsWith('-')) return false;
    ops.push(x);
  }
  return ops.length === 0 || listMode;
}

function classifyGh(rec) {
  const [g, s, ...rest] = rec.argv.slice(1);
  if (!g) return [RO];
  if (g === 'api') {
    const a = rec.argv.slice(2);
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '-X' || x === '--method') {
        if (!/^(GET|HEAD)$/i.test(a[i + 1] || '')) return [MUT, 'gh api non-GET'];
        i++;
        continue;
      }
      if (/^-X./.test(x) && !/^-X(GET|HEAD)$/i.test(x)) return [MUT, 'gh api non-GET'];
      if (x.startsWith('--method=') && !/^--method=(GET|HEAD)$/i.test(x)) return [MUT, 'gh api non-GET'];
      if (['-f', '-F', '--field', '--raw-field', '--input'].includes(x) || /^--(field|raw-field|input)=/.test(x) || /^-[fF]./.test(x)) {
        return [MUT, 'gh api with request body'];
      }
    }
    return [RO];
  }
  const table = {
    pr: ['view', 'list', 'diff', 'status', 'checks'],
    issue: ['view', 'list', 'status'],
    repo: ['view', 'list'],
    run: ['view', 'list', 'watch'],
    release: ['view', 'list'],
    workflow: ['view', 'list'],
    label: ['list'],
    auth: ['status'],
    cache: ['list'],
    secret: ['list'],
    variable: ['list', 'get'],
    gist: ['view', 'list'],
    ruleset: ['view', 'list', 'check'],
    project: ['view', 'list', 'field-list', 'item-list'],
  };
  if (g === 'search' || g === 'status' || g === '--version' || g === 'version' || g === 'help') return [RO];
  if (table[g] && table[g].includes(s)) return [RO];
  void rest;
  return [MUT, `gh ${g} ${s || ''}`.trim()];
}

const SQLITE_READONLY_DOT = /^\.(schema|tables|table|indexes|indices|headers|header|mode|dump|width|show|databases|fullschema|lint|dbinfo|help|nullvalue|separator|timer|echo|eqp|stats|print|changes|bail)\b/i;

function sqlStatementReadonly(stmt, readonlyDb) {
  const s = stmt.trim();
  if (!s) return true;
  if (s.startsWith('.')) return SQLITE_READONLY_DOT.test(s);
  if (readonlyDb) return true;
  if (/^(select|with|explain|values)\b/i.test(s) && !/\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|truncate)\b/i.test(s)) return true;
  if (/^pragma\s+[\w.]+\s*(\(\s*[\w"'.]*\s*\))?\s*$/i.test(s)) return true;
  return false;
}

function classifySqlite(rec) {
  const args = rec.argv.slice(1);
  let readonlyDb = false;
  let db = null;
  const sql = [];
  const valued = ['-separator', '-newline', '-nullvalue', '-vfs', '-mmap', '-pagecache', '-lookaside', '-heap', '-maxsize', '-escape'];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-readonly' || a === '--readonly') { readonlyDb = true; continue; }
    if (a === '-cmd' || a === '--cmd') { sql.push(args[i + 1] || ''); i++; continue; }
    if (a === '-init' || a === '--init') return [MUT, 'sqlite3 init script'];
    if (valued.includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    if (db === null) db = a;
    else sql.push(a);
  }
  if (rec.redirs.some((r) => r.op === '<')) return [MUT, 'sqlite3 reads SQL from a file'];
  if ([...sql, ...stdinTexts(rec)].some((t) => /\b(load_extension|writefile|edit)\s*\(/i.test(t))) {
    return [MUT, 'sqlite3 function writes files or loads code'];
  }
  if (rec.stdinUnknown) return [MUT, 'sqlite3 reads SQL from a pipe'];
  sql.push(...stdinTexts(rec));
  if (!sql.length) return [MUT, 'interactive sqlite3'];
  const stmts = sql.flatMap((t) => t.split(/;|\n/));
  return stmts.every((st) => sqlStatementReadonly(st, readonlyDb)) ? [RO] : [MUT, 'sqlite3 statement may write'];
}

const CURL_FLAG_LETTERS = 'sSfLIivkgN#46qlj';
const CURL_VALUED_LETTERS = 'HwmAeuXorxbdcD';

function classifyCurl(args) {
  const longFlags = new Set(['--head', '--compressed', '--silent', '--show-error', '--fail', '--fail-with-body',
    '--location', '--include', '--verbose', '--insecure', '--globoff', '--no-buffer', '--progress-bar', '--http1.1',
    '--http2', '--raw', '--no-progress-meter', '--ipv4', '--ipv6', '--location-trusted', '--get']);
  const longValued = new Set(['--header', '--write-out', '--max-time', '--connect-timeout', '--user-agent', '--retry',
    '--retry-delay', '--retry-max-time', '--referer', '--user', '--request', '--output', '--resolve', '--cacert',
    '--cookie', '--url', '--range', '--limit-rate', '--max-filesize', '--proxy', '--oauth2-bearer', '--dump-header']);
  const checkValue = (opt, val) => {
    if (opt === 'X' || opt === '--request') return /^(GET|HEAD)$/i.test(val || '');
    if (opt === 'o' || opt === '--output' || opt === 'D' || opt === '--dump-header') return val === '/dev/null' || val === '-';
    return !['d', 'c'].includes(opt);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') continue;
    if (a.startsWith('--')) {
      const [name, inline] = a.split(/=(.*)/s);
      if (longFlags.has(name)) continue;
      if (longValued.has(name)) {
        const val = inline !== undefined ? inline : args[++i];
        if (!checkValue(name, val)) return [MUT, `curl ${name}`];
        continue;
      }
      return [MUT, `curl ${name}`];
    }
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const ch = letters[k];
      if (CURL_FLAG_LETTERS.includes(ch)) continue;
      if (CURL_VALUED_LETTERS.includes(ch)) {
        const val = k < letters.length - 1 ? letters.slice(k + 1) : args[++i];
        if (!checkValue(ch, val) || ch === 'd' || ch === 'c') return [MUT, `curl -${ch}`];
        break;
      }
      return [MUT, `curl -${ch}`];
    }
  }
  return [RO];
}

const MUTATING_SCRIPT = /(fix|format|fmt|write|clean|publish|release|deploy|install|prepare|migrate|seed|reset|generate|codegen|update|upgrade|bump)/i;
const VERIFY_SCRIPT = /^(test|tests|lint|check|checks|typecheck|type-check|types|tsc|build|verify|validate|ci|e2e|coverage|spec|compile|bench)([:._-].*)?$/i;
const PNPM_BUILTINS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'link', 'unlink',
  'publish', 'pack', 'prune', 'rebuild', 'store', 'init', 'import', 'patch', 'patch-commit', 'audit', 'outdated', 'list', 'ls',
  'll', 'why', 'view', 'info', 'show', 'config', 'env', 'create', 'deploy', 'fetch', 'setup', 'dedupe', 'run', 'run-script',
  'test', 't', 'tst', 'exec', 'dlx', 'x', 'root', 'bin', 'prefix', 'help', 'explain', 'doctor', 'cache', 'version', 'set',
  'licenses', 'approve-builds', 'self-update', 'ci', 'pkg', 'login', 'logout', 'whoami', 'search', 'start', 'stop', 'restart']);

function classifyScriptName(script) {
  if (!script) return [RO]; // `npm run` alone lists scripts
  if (MUTATING_SCRIPT.test(script)) return [MUT, `script ${script}`];
  if (VERIFY_SCRIPT.test(script)) return [VERIFY];
  return [MUT, `script ${script}`];
}

function classifyPkg(rec) {
  const p = pkgSplit(rec.argv);
  const [sub, ...rest] = p;
  if (!sub || ['-v', '--version', 'help', '--help', '-h'].includes(sub)) return [RO];
  if (['test', 't', 'tst'].includes(sub)) return [VERIFY];
  if (sub === 'run' || sub === 'run-script') return classifyScriptName(rest.find((x) => !x.startsWith('-')));
  if (['ls', 'list', 'll', 'la', 'view', 'info', 'show', 'why', 'outdated', 'explain', 'root', 'bin', 'prefix', 'licenses', 'whoami', 'search'].includes(sub)) return [RO];
  if (sub === 'audit') return rest.includes('fix') || rest.includes('--fix') ? [MUT, 'audit fix'] : [RO];
  if (sub === 'config') return ['get', 'list', 'ls'].includes(rest[0]) ? [RO] : [MUT, 'config write'];
  if (rec.name !== 'npm' && !PNPM_BUILTINS.has(sub)) return classifyScriptName(sub);
  return [MUT, `${rec.name} ${sub}`];
}

function classifyCargo(rec) {
  const [sub, ...rest] = cargoSplit(rec.argv);
  if (!sub || ['--version', '-V', 'version', 'help', '--help', 'metadata', 'tree', 'search', 'locate-project', 'pkgid', 'read-manifest', 'verify-project', '--list'].includes(sub)) return [RO];
  if (sub === 'fmt') return rest.includes('--check') ? [VERIFY] : [MUT, 'cargo fmt writes'];
  if (sub === 'clippy') return rest.some((x) => x === '--fix' || x.startsWith('--fix')) ? [MUT, 'cargo clippy --fix'] : [VERIFY];
  if (['check', 'c', 'test', 't', 'build', 'b', 'bench', 'doc', 'd', 'nextest'].includes(sub)) {
    if (sub === 'doc' && rest.includes('--open')) return [VERIFY];
    return [VERIFY];
  }
  return [MUT, `cargo ${sub}`];
}

function classifyInterpreter(rec) {
  const args = rec.argv.slice(1);
  if (args.length === 1 && ['--version', '-v', '-V', '--help', '-h'].includes(args[0])) return [RO];
  if (rec.name === 'node' && args.includes('--test')) return [VERIFY];
  if (/^python/.test(rec.name) && args[0] === '-m' && ['pytest', 'unittest'].includes(args[1])) return [VERIFY];
  return [MUT, `${rec.name} executes arbitrary code`];
}

function classifyRecord(rec) {
  if (!rec.name) return [RO]; // assignment / redirect-only; redirects are checked separately
  const name = rec.name;
  const args = rec.argv.slice(1);
  if (name === 'clawket') return [CLAWKET];
  if (name === 'command') return (args[0] === '-v' || args[0] === '-V') ? [RO] : [MUT, 'command'];
  if (name === 'date') {
    if (hasFlag(args, ['s', '--set'])) return [MUT, 'date --set'];
    // `date MMDDhhmm` sets the clock; only `+FORMAT` operands are read-only.
    const valued = ['-r', '-d', '--date', '-f', '--file', '-z', '-j'];
    const ops = [];
    for (let i = 0; i < args.length; i++) {
      if (valued.includes(args[i])) { i++; continue; }
      if (args[i].startsWith('-')) continue;
      ops.push(args[i]);
    }
    return ops.every((o) => o.startsWith('+')) ? [RO] : [MUT, 'date sets the clock'];
  }
  if (name === 'hostname') {
    const readOpts = ['-s', '-f', '-d', '-i', '-I', '-a', '-A', '-y', '--short', '--fqdn', '--long', '--domain',
      '--ip-address', '--all-ip-addresses', '--all-fqdns', '--alias', '--nis', '--help', '--version'];
    return args.every((a) => readOpts.includes(a)) ? [RO] : [MUT, 'hostname sets the host name'];
  }
  if (name === 'file') return hasFlag(args, ['C', '--compile']) ? [MUT, 'file -C compiles a magic file'] : [RO];
  if (name === 'printf') return args[0] === '-v' ? [MUT, 'printf -v assigns a shell variable'] : [RO];
  if (['read', 'export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'set', 'shopt'].includes(name)) {
    // Shell-state only; assignments to execution-altering variables are
    // rejected separately (dangerous-assign).
    return [RO];
  }
  if (ALWAYS_READONLY.has(name)) return [RO];
  switch (name) {
    case 'find': {
      const writer = args.find((a) => ['-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(a));
      return writer ? [MUT, `find ${writer}`] : [RO];
    }
    case 'rg': case 'ripgrep':
      return args.some((a) => a === '--pre' || a.startsWith('--pre=')) ? [MUT, 'rg --pre runs a command'] : [RO];
    case 'sort':
      return args.some((a) => a.startsWith('--output') || (/^-[a-zA-Z]*o/.test(a) && !a.startsWith('--'))) ? [MUT, 'sort -o'] : [RO];
    case 'tree': return args.includes('-o') ? [MUT, 'tree -o'] : [RO];
    case 'uniq': return operands(args).length >= 2 ? [MUT, 'uniq output file'] : [RO];
    case 'xxd': return operands(args).length >= 2 ? [MUT, 'xxd output file'] : [RO];
    case 'base64': return (hasFlag(args, ['o', '--output']) || operands(args).length >= 2) ? [MUT, 'base64 output file'] : [RO];
    case 'yq': return hasFlag(args, ['i', '--inplace']) ? [MUT, 'yq in-place'] : [RO];
    case 'sed': case 'gsed': return classifySed(args);
    case 'awk': case 'gawk': case 'mawk': case 'nawk': return classifyAwk(args);
    case 'git': return classifyGit(rec);
    case 'gh': return classifyGh(rec);
    case 'sqlite3': case 'sqlite': return classifySqlite(rec);
    case 'curl': return classifyCurl(args);
    case 'docker': case 'podman': {
      const p = dockerSplit(rec.argv);
      const ro = [['ps'], ['images'], ['logs'], ['inspect'], ['version'], ['info'], ['container', 'ls'], ['container', 'ps'],
        ['container', 'inspect'], ['container', 'logs'], ['image', 'ls'], ['image', 'inspect'], ['compose', 'ps'],
        ['compose', 'logs'], ['compose', 'config'], ['compose', 'ls'], ['--version']];
      return ro.some((want) => want.every((w, k) => p[k] === w)) ? [RO] : [MUT, `${name} ${p[0] || ''}`.trim()];
    }
    case 'npm': case 'pnpm': case 'yarn': case 'bun': return classifyPkg(rec);
    case 'cargo': return classifyCargo(rec);
    case 'rustc': return args.length === 1 && ['--version', '-V'].includes(args[0]) ? [RO] : [MUT, 'rustc'];
    case 'rustfmt': return args.includes('--check') ? [VERIFY] : [MUT, 'rustfmt writes'];
    case 'rustup': {
      const ro = [['show'], ['--version'], ['-V'], ['toolchain', 'list'], ['target', 'list'], ['component', 'list'], ['which']];
      return ro.some((want) => want.every((w, k) => args[k] === w)) ? [RO] : [MUT, `rustup ${args[0] || ''}`.trim()];
    }
    case 'security':
      return ['find-identity', 'find-certificate', 'list-keychains', 'show-keychain-info', 'default-keychain'].includes(args[0]) && !(args[0] === 'default-keychain' && args.includes('-s'))
        ? [RO] : [MUT, `security ${args[0] || ''}`.trim()];
    case 'tsc': case 'vue-tsc': return args.includes('--init') ? [MUT, 'tsc --init'] : [VERIFY];
    case 'eslint':
      return args.some((a) => a === '--fix' || a === '--init' || a === '-o' || a.startsWith('--output-file') || a.startsWith('--fix-type'))
        ? [MUT, 'eslint writes files'] : [VERIFY];
    case 'prettier':
      return hasFlag(args, ['--write', 'w']) ? [MUT, 'prettier --write'] : [VERIFY];
    case 'vitest': case 'jest': case 'mocha': case 'pytest': case 'ava': case 'tap':
      return hasFlag(args, ['u', '--update', '--updateSnapshot', '--update-snapshots']) ? [MUT, `${name} updates snapshots`] : [VERIFY];
    case 'playwright':
      return args[0] === 'test' && !hasFlag(args, ['u', '--update-snapshots']) ? [VERIFY] : [MUT, `playwright ${args[0] || ''}`.trim()];
    case 'go': {
      if (['test', 'vet', 'build'].includes(args[0])) return [VERIFY];
      if (['version', 'env', 'list', 'doc'].includes(args[0]) && !(args[0] === 'env' && args.includes('-w'))) return [RO];
      return [MUT, `go ${args[0] || ''}`.trim()];
    }
    default:
      if (INTERPRETERS.has(name)) return classifyInterpreter(rec);
      return [MUT, name];
  }
}

// Subshells, brace groups and loops are not blockers: their commands are
// collected and judged one by one, so they are read-only iff every part is.
const FAST_PATH_BLOCKERS = new Set(['substitution', 'process-substitution', 'background',
  'eval', 'exec', 'source', 'shell-c', 'shell-stdin', 'opaque', 'sudo', 'doas', 'command', 'builtin',
  'unparseable', 'too-deep', 'dangerous-assign']);

// A path-qualified command runs whatever file sits at that path; only the
// system binary directories (and the plugin's own `bin/clawket`) are trusted.
function headProblem(rec) {
  if (rec.headDynamic) return `command name ${rec.headPath} is a variable expansion`;
  const p = rec.headPath;
  if (!p.includes('/')) return null;
  const dir = p.slice(0, p.lastIndexOf('/'));
  if (SYSTEM_BIN_DIRS.has(dir)) return null;
  if (rec.name === 'clawket' && /\/\.claude\/plugins\/.+\/bin$/.test(dir)) return null;
  return `path-qualified command ${p} is not a known system binary`;
}


// Commands whose arguments are programs: an expansion makes the program unknown.
const SCRIPT_TAKING = new Set(['sed', 'gsed', 'awk', 'gawk', 'mawk', 'nawk', 'sqlite3', 'sqlite']);

// Commands whose read-only verdict does not depend on their arguments, so
// `xargs` may append input-derived arguments to them and expansions in their
// arguments are harmless.
const XARGS_SAFE = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'ls', 'stat', 'du', 'basename',
  'dirname', 'realpath', 'readlink', 'echo', 'shasum', 'sha1sum', 'sha256sum', 'sha512sum', 'md5', 'md5sum', 'cksum',
  'nl', 'test', 'strings', 'od', 'hexdump', 'jq']);

/**
 * Classify a Bash command for the PreToolUse fast paths.
 *
 * kind:
 *   'readonly'     — every executed command is read-only
 *   'verification' — read-only plus build/test/lint commands whose writes are
 *                    limited to regenerable outputs; allowed and recorded
 *   'clawket'      — read-only plus `clawket` CLI calls (no other commands)
 *   'mutating'     — anything else (the active-task gate applies)
 *   'unparseable'  — the parser could not model the command (gate applies)
 */
function classify(src, analysis) {
  const a = analysis || analyze(src);
  if (!a.ok) return { kind: 'unparseable', reasons: [a.error], commands: [] };
  const reasons = [];
  for (const c of a.constructs) {
    if (FAST_PATH_BLOCKERS.has(c.kind)) reasons.push(c.detail ? `${c.kind}: ${c.detail}` : c.kind);
  }
  for (const rec of a.records) {
    for (const w of writeRedirectTargets(rec)) {
      if (!SAFE_SINKS.has(w.target)) reasons.push(`redirect ${w.op} ${w.target}`);
    }
  }
  const classes = a.records.map((rec) => {
    const head = rec.name ? headProblem(rec) : null;
    if (head) {
      reasons.push(head);
      return { name: rec.name, cls: MUT };
    }
    if (rec.wrappers.includes('xargs') && rec.name && !XARGS_SAFE.has(rec.name)) {
      reasons.push(`xargs appends input-derived arguments; ${rec.name} is read-only only for fixed arguments`);
      return { name: rec.name, cls: MUT };
    }
    // An expansion can become an option (`$PAT` → `--pre=./x`, `"$D"` →
    // `-delete`), so option-sensitive commands need literal arguments.
    // clawket keeps its fast path unless the call could be a delete.
    if (rec.anyDynamicArg && SCRIPT_TAKING.has(rec.name)) {
      reasons.push(`${rec.name} program text contains an expansion`);
      return { name: rec.name, cls: MUT };
    }
    const dynamicArg = (rec.dynamicOptionArgs || [])[0];
    if (dynamicArg && rec.name && !XARGS_SAFE.has(rec.name)
      && !(rec.name === 'clawket' && !rec.argv.includes('delete'))) {
      reasons.push(`argument ${dynamicArg} is an expansion that could be an option of ${rec.name}`);
      return { name: rec.name, cls: MUT };
    }
    const [cls, why] = classifyRecord(rec);
    if (cls === MUT) reasons.push(why || rec.name);
    return { name: rec.name, cls };
  });
  const commands = classes.filter((c) => c.name).map((c) => c.name);
  if (reasons.length) return { kind: MUT, reasons, commands };
  if (classes.some((c) => c.cls === VERIFY)) return { kind: VERIFY, reasons, commands };
  if (classes.some((c) => c.cls === CLAWKET)) return { kind: CLAWKET, reasons, commands };
  return { kind: RO, reasons, commands };
}

module.exports = {
  ParseError,
  analyze,
  classify,
  detectDestructive,
  lex,
  matchPattern,
  parse,
  // exposed for tests
  __test__: { unwrap, subcommandPath, sqlTexts, gitSplit, classifyRecord, extractSubs },
};
