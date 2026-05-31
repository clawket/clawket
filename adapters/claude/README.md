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
| X8 — `evidence` NULL on status transition | `PreToolUse` (`clawket task update`), `SubagentStop` | `checkX8Evidence` | `CLAWKET_ENFORCE_EVIDENCE=strict\|warn\|off` |
| X9 — sync-context Agent dispatch (reasoning inside bulk sync) | `PreToolUse` (Bash + Agent dispatch), `SubagentStart` | `checkX9SyncReasoning` | `CLAWKET_ENFORCE_SYNC_PURITY=strict\|warn\|off` |

Global bypass: `CLAWKET_BYPASS_HOOKS=1` skips all four checks. The bypass is intentionally unauthenticated (no UID/root gate) — this is a developer-loop escape valve and must not be used to circumvent enforcement in routine work. Audit logs still record the bypass attempt at the hook entry point.

## Destructive shell guardrail (PreToolUse hard-block)

`PreToolUse` runs every Bash command through the catalog in `destructive-patterns.json` *before* any auto-allow path. A match denies the call with a structured `permissionDecision: deny` plus a Korean reason and remediation; the same message is also written to stderr.

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

1. Add a new entry to `adapters/shared/destructive-patterns.json` with a unique `id`, a single `regex`, optional `flags`, plus user-facing `reason` + `remediation`.
2. Add a positive-case + negative-case test to `tests/destructive-patterns.test.cjs`.
3. Run `node --test tests/`. All cases must pass before shipping.
