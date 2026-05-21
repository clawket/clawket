# MCP-based Hook Enforcement (Considered, Not Adopted)

> **Status:** Considered design captured for the record. **Not adopted.** The
> deliberate single source of truth for hook enforcement in v3 is
> `adapters/shared/claude-hooks.cjs` (the cjs "fat handler" layer). This
> document describes the alternative MCP-tool design that was evaluated and
> deferred; nothing here is a roadmap commitment. The current cjs layer is
> pinned by the install gate, the skill integrity test, and the hook regression
> tests under `tests/`.

## Today's enforcement layout

Hook events from Claude Code (`SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `SubagentStart`, `SubagentStop`, plus the `PostToolUse +
ExitPlanMode` plan-sync branch) route through 2-line shims under
`adapters/claude/` into one of seven handlers in
`adapters/shared/claude-hooks.cjs`. Each handler is the **sole**
enforcement site for its gate; the daemon does not duplicate these checks.

| Gate | Enforced in | Daemon's role |
|---|---|---|
| Active-task gate (PreToolUse) | cjs `runPreToolUse` | none (cjs queries `task list`) |
| Destructive-command guard (LM-8 boundary) | cjs `detectDestructive` | none |
| PDD X3 / X7 / X8 / X9 (scenario_id, batch size, evidence, sync reasoning) | cjs helpers (`checkX3…`–`checkX9…`) | none |
| Tier gate (G2/G3) | cjs (writes `CLAWKET_TIER_USED`) | advisory only |
| Plan-strict validation (ExitPlanMode) | cjs `validateStrictPlan` (curl `/plans/import/strict`) | validates strict-plan shape |
| `task done` evidence | — | daemon `EVIDENCE_REQUIRED` (HTTP 400) |
| Cycle / plan / project invariants (FK, single-active, unit_id parity) | — | daemon DB constraints + `repo/*` `bail!`s |

The cjs and daemon layers are **complementary**, not duplicative. cjs decides
*whether a tool call may proceed* using read-only daemon queries; the daemon
enforces *whether a state mutation may persist*. Each gate lives in exactly one
place.

## Why this design (MCP `clawket.enforce`) was considered

A migration to a single MCP tool was sketched on the assumption that two
problems existed:

1. **Per-event cold start.** Each PreToolUse spawns Node and runs the handler.
2. **Duplicated gate logic** between cjs and the daemon.

On evaluation neither held up as written. (1) is real but the dominant cost is
not Node startup — it is the 3–5 `exec(${clawket} ...)` subprocess calls inside
the handler. A warm MCP process removes Node startup (~30–50 ms) but does not
remove the CLI exec cost; the same speedup is reachable by replacing the CLI
exec calls with direct HTTP from cjs, which is a much smaller change. (2) is
not the case: the table above shows each gate has exactly one home.

The MCP-tool path was therefore **deferred** in favor of preserving the cjs
layer as the deliberate single source of truth.

## Sketched design (for future reference)

The remainder of this document records the MCP design that was sketched, so a
future evaluation does not have to start from scratch. None of this is wired
today.

### Proposed MCP tool: `clawket.enforce`

```jsonc
{
  "name": "clawket.enforce",
  "description": "Gate tool invocations against active task/cycle/plan state.",
  "inputSchema": {
    "type": "object",
    "required": ["event"],
    "properties": {
      "event": { "enum": ["PreToolUse", "PostToolUse", "SessionStart",
                          "UserPromptSubmit", "Stop", "SubagentStart",
                          "SubagentStop", "PlanSync", "TaskCreated",
                          "TaskCompleted"] },
      "tool":  { "type": "string" },
      "cwd":   { "type": "string" },
      "agentId": { "type": "string" }
    }
  }
}
```

Return shape:

```jsonc
{
  "allow": false,
  "reason": "No active task. Run `clawket task update <ID> --status in_progress`."
}
```

### Sketched shim shape

If adopted, `adapters/claude/pre-tool-use.cjs` would reduce to:

```js
const mcp = require('./mcp-client');
module.exports = async function preToolUse(evt) {
  const r = await mcp.call('clawket.enforce', { event: 'PreToolUse', ...evt });
  if (!r.allow) {
    process.stderr.write(r.reason + '\n');
    process.exit(2);
  }
};
```

The MCP client would keep a stdio bridge open for the session, eliminating
Node startup per event.

### State ownership (proposed)

| State | Owner | Accessed by |
|---|---|---|
| Active task | daemon SQLite | MCP (read) |
| Cycle status | daemon SQLite | MCP (read) |
| Plan status | daemon SQLite | MCP (read) |
| Project cwd binding | daemon SQLite | MCP (read) |
| Agent binding | MCP process memory | MCP (read/write) |

### Migration path (if ever revisited)

Big-bang replacement is rejected — the hook layer is on the critical path of
every session and a regression bricks the user. Incremental per-event rollout
is the only acceptable shape:

1. Pilot on **PostToolUse** first. It is audit-only, has no `permissionDecision`,
   and a regression cannot deny tool calls.
2. Move PreToolUse last. Its 490-LOC handler is the largest blast radius and
   should only be migrated after every other handler has been observed stable
   for at least one plugin patch release.
3. Each migrated handler ships dual-path behind a feature flag
   (`CLAWKET_MCP_ENFORCE=<event>`) until its corresponding regression tests
   under `tests/` are rewritten against the MCP boundary.
4. The fat cjs path stays in the tree for one full minor release after each
   handler is migrated, so rollback is a flag flip rather than a redeploy.

The `Phase 6 — MCP rewrites in Rust` step from the original sketch is dropped
as out of scope; the cli MCP server (rmcp 1.5, in the `clawket/cli` sub-repo) already
runs Rust.

## Risks (if adopted)

- **MCP process lifecycle** is tied to the Claude Code session; if Claude
  restarts mid-session the warm state is lost. The shim must tolerate a cold
  MCP start.
- **Daemon unavailable** — enforcement would fail-closed (block tool) with a
  clear "daemon not reachable" message so users know to `clawket daemon start`.
  This is a behavior change from the current cjs layer, which fails-open with a
  stderr warning on daemon outages.
- **Schema drift** — the enforce tool's input schema must be versioned per
  plugin release and pinned by the `compat` matrix in
  [COMPATIBILITY.md](./COMPATIBILITY.md). Today the cjs handler is part of
  `pluginRoot` and is rebuilt by the install gate on every plugin bump; the MCP
  path would couple hook semantics to daemon release cadence instead.
- **LM-8 boundary** — moving gate logic from `pluginRoot` (cjs, deletable +
  rebuildable by install gate) into the daemon (user-data domain,
  schema-versioned, harder to roll back) inverts where the gate's "owner of
  truth" lives. The current placement is the safer side of LM-8.

## Reference

- Current SSoT: `adapters/shared/claude-hooks.cjs` (handlers
  `runSessionStart`, `runUserPromptSubmit`, `runPreToolUse`, `runPostToolUse`,
  `runPlanSync`, `runSubagentStart`, `runSubagentStop`).
- Existing MCP server (in `clawket/cli` sub-repo) — 5 read-only tools
  (`clawket_search_knowledge`, `clawket_search_tasks`,
  `clawket_find_similar_tasks`, `clawket_get_task_context`,
  `clawket_get_recent_decisions`). No `clawket.enforce` tool today.
- Daemon enforcement endpoints: `EVIDENCE_REQUIRED` at `daemon/src/repo/tasks.rs`,
  `PROJECT_HAS_ACTIVE_PLAN` / `PLAN_HAS_ACTIVE_CYCLES` at
  `daemon/src/routes/plans.rs`, cycle invariants at `daemon/src/repo/cycles.rs`.
- Regression tests pinning today's enforcement:
  `tests/pre-tool-use.e2e.test.cjs`,
  `tests/destructive-patterns.test.cjs`,
  `tests/exit-plan-mode-strict.test.cjs`,
  `tests/disabled-project-bypass.test.cjs`,
  `tests/skills-integrity.test.cjs`,
  `tests/data-loss-diagnostics.e2e.test.cjs`,
  `tests/plugin-reinstall.e2e.test.cjs`.
