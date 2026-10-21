# Claude Adapter

Claude integration is implemented as a thin adapter layer over shared Clawket runtime helpers.

- `.claude-plugin/` — Claude plugin manifest + marketplace metadata
- `.mcp.json` — registers `clawket mcp` (stdio); invokes the `clawket` CLI directly
- `hooks/hooks.json` — Claude hook routing manifest (7 standard Claude Code events; v3 schema)
- `scripts/setup.cjs` — manual / CI setup entry; delegates to `adapters/claude/setup.cjs` → `adapters/shared/claude-hooks.cjs::ensureInstalled`
- `adapters/claude/*.cjs` — Claude adapter hook entrypoints (one per hook event; each is a 2-line shim that delegates to the shared helper)
- `adapters/shared/claude-hooks.cjs` — single source of truth for install gate (`ensureInstalled`), daemon discovery / start, **PDD anti-pattern enforcement (X3/X7/X8/X9)**, and shared hook glue used by Claude now and future adapters later
- `adapters/shared/destructive-patterns.json` — catalogued shell patterns hard-blocked by `PreToolUse` (LM-7, post-incident guard)

## PDD anti-pattern hook enforcement (X3/X7/X8/X9)

The shared helper enforces four PDD v3.0 anti-patterns at the corresponding Claude hook event. Each check is gated by a per-anti-pattern env-var (`strict|warn|off`, default `strict` for X3 & X8, `warn` for X7 & X9 unless overridden). Daemon-unavailable is graceful skip (writes a stderr line, returns `blocked:false`). All blocks are logged best-effort to `hook.log` (path: `cacheDir() + /hook.log`).

| Anti-pattern | Hook event | Check function | Env override |
|---|---|---|---|
| X3 — `scenario_id` NULL/format violation | `PreToolUse` (Bash `clawket task ...`), `PostToolUse` (Edit/Write), `SubagentStart` | `checkX3ScenarioId` | `CLAWKET_ENFORCE_SCENARIO_ID=strict\|warn\|off` |
| X7 — sub-agent reasoning batch size > 30 | `PreToolUse` (Agent/TeamCreate/SendMessage), `SubagentStart` | `checkX7BatchSize` | `CLAWKET_ENFORCE_BATCH=strict\|warn\|off` |
| X8 — `evidence` NULL / placeholder on status transition, a test-result claim without `run:<RUN-ID>`, or a `run:` reference that is not a finished run with command, input hash, exit code and report hash (record one with `scripts/record-run.cjs`) | `PreToolUse` (`clawket task update`), `SubagentStop` | `checkX8Evidence` | `CLAWKET_ENFORCE_EVIDENCE=strict\|warn\|off` |
| X9 — sync-context Agent dispatch (reasoning inside bulk sync) | `PreToolUse` (Bash + Agent dispatch), `SubagentStart` | `checkX9SyncReasoning` | `CLAWKET_ENFORCE_SYNC_PURITY=strict\|warn\|off` |

Global bypass: `CLAWKET_BYPASS_HOOKS=1` skips all four checks. The bypass is intentionally unauthenticated (no UID/root gate) — this is a developer-loop escape valve and must not be used to circumvent enforcement in routine work. Audit logs still record the bypass attempt at the hook entry point.

## Destructive shell guardrail (PreToolUse hard-block)

`PreToolUse` parses every Bash command (`adapters/shared/bash-classifier.cjs`) and runs the catalog in `destructive-patterns.json` against each command the shell would actually execute, *before* any auto-allow path. A match denies the call with a structured `permissionDecision: deny` plus a localized reason and remediation; the same message is also written to stderr.

- Quoted arguments and heredoc bodies are data: `grep "git reset --hard"`, a commit message mentioning `TRUNCATE`, or a heredoc written to a file never match.
- Code that executes is unwrapped and matched: `bash -c`, `eval`, `xargs`, `find -exec`, `env`/`timeout`/`nice`/`sudo` wrappers, `$(…)`/backticks, heredocs fed to a shell, and SQL handed to a SQL client or interpreter (arguments, heredoc, here-string or a piped `echo`).
- Rules are structural: `git -C . reset --hard` and `git reset --har""d` match `git-reset-hard` because global options are skipped and quotes are removed before matching.
- Input the parser cannot model (`case`, function definitions, unbalanced quotes) falls back to each entry's raw `regex`, so the guard fails closed.

## Bash fast paths (no active task required)

After the destructive check, a Bash command skips the active-task gate only when every executed command falls in one class:

| Class | Meaning | Examples |
|---|---|---|
| read-only | per-command option tables prove no write and no runtime-chosen code | `ls`, `git status`, `git branch -a`, `sed -n 1,20p f`, `curl -sS URL`, `sqlite3 -readonly db "select …"` |
| verification (recorded) | build / test / lint / typecheck whose writes are confined to regenerable outputs; logged as `verification_command` in `hook.log` | `pnpm test`, `npm run build`, `cargo clippy`, `cargo fmt --check`, `tsc --noEmit` |
| clawket | every command is the `clawket` CLI or read-only | `clawket task list \| jq .` |

Writers such as `sed -i`, `tee`, `sort -o`, `find -delete`, `git branch -D`, `curl -o`, `node -e`, `prettier --write` and `eslint --fix` are gated. So are command substitution, background jobs, `eval`/`exec`/`source`/`bash -c`, write redirects other than `/dev/null`, execution-altering assignments (`GIT_PAGER=`, `LD_PRELOAD=`, `PATH=`), path-qualified binaries outside the system directories, and expansions that could become options. The read-only rules are kept in agreement with the SDI plugin's shared corpus (`tests/bash-classifier.test.cjs`).

## Workflow gate state

Gated calls read their state from one daemon call, `GET /gate/pre-tool-use?cwd=&session=`: the project resolved for cwd (and its enabled flag), that project's in_progress / blocked / assigned-todo tasks, and its active plan and cycle counts. Every task lookup is scoped to the project, so a task left in_progress elsewhere never satisfies the gate. Daemons without the endpoint are served by the CLI with the same project scoping. The gate decision has no side effects: an `Agent` dispatch for a task that is still `todo` is denied with the explicit `clawket task update <id> --status in_progress` command.

Catalogued categories:

- `data-loss` — `rm -rf` on Clawket data dirs (`~/.local/share/clawket`, `~/.cache/clawket`, `~/.config/clawket`, `~/.local/state/clawket`, `.claude/plugins/data/clawket`); `find ... -delete` against the same dirs; output redirect (`>`) overwriting `db.sqlite`; `docker rm -v`.
- `catastrophic` — `rm -rf` against bare home (`~`, `$HOME`, `/Users/<id>`, `/home/<id>`) or root (`/`).
- `history-loss` — `clawket {plan,unit,cycle,project} delete --force` (cascades wipe child tasks/runs).
- `uncommitted-loss` — `git reset --hard` (any target).
- `lockout` — `chmod 000` / `chmod 0`.

### Bypass: removed in v3 (US-053)

The v2 `CLAWKET_ALLOW_DESTRUCTIVE=1` env-var bypass was removed in plugin v3. There is no in-process bypass: when a destructive pattern matches, the command is denied unconditionally. Operators who genuinely need the dangerous command must obtain explicit user approval out-of-band and run it via a non-Claude shell. Pattern false-positives should be filed against `destructive-patterns.json` instead of being unblocked locally.

### Audit trail

Every block is best-effort logged to the daemon `/activity` endpoint (`action=destructive_blocked`, `field=<pattern_id>`). Logging failure is non-fatal — the deny itself is the primary guard.

### Adding patterns

1. Add a new entry to `adapters/shared/destructive-patterns.json` with a unique `id`, a structural `match` rule (fields documented in the catalog's `description`), a raw-text fallback `regex` with optional `flags`, plus user-facing `reason` + `remediation`.
2. Add a positive-case + negative-case test to `tests/destructive-patterns.test.cjs` (cases run through the structural matcher), including a case where the dangerous text appears only as data.
3. Run `node --test tests/`. All cases must pass before shipping.
