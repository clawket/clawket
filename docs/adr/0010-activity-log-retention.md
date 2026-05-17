# ADR-0010 — activity_log Retention, Rollup & Size Budget

| Status | Owner task | Targets | Plan |
|---|---|---|---|
| **Accepted** (M0 schema-freeze, RL-U3-16 implementation 2026-04-27) | LM-69 / RL-U3-16 | `activity_log` + new `activity_log_archive` + weekly rollup job + `clawket doctor` budget check | v11 — Structured Task Contracts |

## Context

`activity_log` is written on every state transition that the daemon, CLI, and Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart/Stop`) drive. The table is append-only by design — preserving history is the single most valuable property the daemon offers, and ad-hoc deletion would defeat the audit-chain purpose laid out in ADR-0001.

The append-only choice creates three pressures over time:

1. **Unbounded growth.** A single `Edit` tool call writes an `entity_type='task', action='updated'` row plus per-field child rows. A heavy session (50 edits + 100 hook events) writes ~150 rows. Across a year of regular use this is 50k–500k rows; not catastrophic, but the SQLite file size and query latency creep up linearly.
2. **VACUUM lag.** SQLite's default `auto_vacuum=NONE` never reclaims pages from deletes. If we ever do delete (which we will, see Rule 3 below), the file size only goes up.
3. **No diagnostic surface.** `clawket doctor` already inspects DB freshness and path separation, but has no eye on activity_log size. A user whose `db.sqlite` has grown to 8 GB will only notice when their plugin upgrade times out.

v8 had no policy here. v11 needs one because RL-U3-04 (audit hash chain) is about to triple the row count per mutating call.

## Decision

The activity_log retention policy follows **three rules**.

### Rule 1 — Three retention tiers: hot, warm, cold

| Tier | Window (default) | Storage | Query path |
|---|---|---|---|
| Hot | last 90 days | `activity_log` (uncompressed, indexed) | direct SELECT |
| Warm | 90 → 365 days | `activity_log_archive` (gzip JSON batches, one row per UTC day) + original `activity_log` row preserved | direct SELECT (still hot-indexed); archive blob is the durable copy |
| Cold | > 365 days | `activity_log_archive` only | future: `clawket activity restore --period <date>` (out of scope here) |

Why the warm tier keeps the original row instead of deleting on archive: callers (web Timeline, CLI history) MUST be able to read the last year without unzipping. The archive table is the durable copy that survives an aggressive size-budget prune.

### Rule 2 — `archived_at` is the rollup checkpoint

`activity_log` gains one column:

```sql
ALTER TABLE activity_log ADD COLUMN archived_at INTEGER NULL;
CREATE INDEX idx_activity_log_archived ON activity_log(archived_at);
```

The rollup job runs in two phases inside one transaction per UTC-day batch:

1. SELECT rows where `archived_at IS NULL AND created_at < hot_cutoff_ms`, grouped by `date(created_at/1000, 'unixepoch')`.
2. For each date batch: serialize as JSON, gzip, INSERT into `activity_log_archive(period_start, period_end, row_count, gzip_blob)`, then UPDATE `archived_at = now()` on the source rows.

If the daemon crashes between INSERT and UPDATE, the next run sees rows still with `archived_at IS NULL`, the date-bucketed INSERT is a no-op (idempotent: skip dates already present in archive for that period), and the UPDATE retries cleanly. If the daemon crashes after UPDATE but before COMMIT, SQLite rolls back the whole transaction — same retry behavior.

The cold-prune step runs separately: `DELETE FROM activity_log WHERE archived_at IS NOT NULL AND created_at < cold_cutoff_ms`. The archive table is untouched.

### Rule 3 — Size budget bounds the worst case

Three env vars override defaults:

| Var | Default | Effect |
|---|---|---|
| `CLAWKET_ACTIVITY_LOG_HOT_DAYS` | `90` | Hot window. Below this, rows are never archived. |
| `CLAWKET_ACTIVITY_LOG_TOTAL_DAYS` | `365` | Cold cutoff. Above this, rows are deleted from `activity_log` (archive blob persists). |
| `CLAWKET_ACTIVITY_LOG_MAX_MB` | `500` | Hard size cap on the SUM of `activity_log` + `activity_log_archive` byte size. When the sum exceeds the cap, the rollup runs an over-budget pass: `cold_cutoff` is shrunk inward (in 30-day increments) until the projected size fits. Below 30 days the daemon refuses to prune further and instead emits a sustained `tracing::warn!` until the user intervenes. |

`clawket doctor` adds a panel:

```
[activity_log retention (LM-69)]
  budget   = 500 MB
  current  = 412 MB (82%)
  hot rows = 48,210  (90 d window)
  archive  = 12 batches, oldest 2025-09-04
  ⚠ at 80% budget — consider lowering CLAWKET_ACTIVITY_LOG_TOTAL_DAYS
```

Severity ladder:
- `< 80%` → Severity::Ok
- `80% ≤ x < 95%` → Severity::Warn
- `≥ 95%` → Severity::Error (exit code 1)

The panel reads byte size via `PRAGMA page_count * PRAGMA page_size` for the two tables (close enough for budgeting; precise to within one page).

### Migration housekeeping

The migration sets `PRAGMA auto_vacuum=INCREMENTAL` so deletes from `activity_log` actually return pages. The rollup job calls `PRAGMA incremental_vacuum(N)` at the end of each pass (N pages, capped). A weekly full `VACUUM` is **not** scheduled — it requires exclusive DB lock and the daemon is the sole writer, so cumulative `incremental_vacuum` after each rollup is sufficient and avoids long lock windows. If we observe page fragmentation in operations, we can add an opt-in `clawket daemon vacuum` subcommand later.

## Practical patterns

### Pattern A — Reading recent history (no change for callers)

```rust
// repo/activity_log.rs continues to SELECT from activity_log directly.
// Hot tier: <90d, fast index lookup.
// Warm tier: 90–365d, still in activity_log (slower scan, acceptable).
list(&conn, ListFilter { entity_type: Some("task"), entity_id: Some(task_id), limit: Some(50) })
```

No caller code changes. The archive table is implementation detail.

### Pattern B — Scheduled rollup

```rust
// daemon/src/jobs/activity_log_rollup.rs
pub fn run_once(conn: &mut Connection, policy: &RetentionPolicy, now: i64) -> Result<RollupReport>
```

Called from `main.rs` once at startup (catch-up) and then every 24h. The 24h period is intentional: the daemon is single-process and a user's cumulative day-of-work is one batch.

### Pattern C — Doctor budget check

```rust
// cli/src/doctor.rs adds run_activity_log_budget_check(...).
// Reads byte size via PRAGMA, compares to env-overridden cap, pushes Severity into tally.
```

## Tradeoffs

- **Storage doubling in warm window.** A row in [90d, 365d] lives both inline (uncompressed) and in archive (gzipped). Worst case the warm tier is ~1.05× the size of a delete-on-archive design. We accept this for the read-without-unzip property; the size budget caps the absolute worst case anyway.
- **No automatic VACUUM.** Page reclamation depends on `incremental_vacuum` running per rollup. If the daemon crashes during rollup, fragmentation persists until the next clean run. Acceptable: the alternative (full VACUUM) blocks all writers for seconds and we'd rather lose page-density than block a user's `clawket task update`.
- **`archived_at` index cost.** ~16 bytes per row. At the projected scale (50–500k rows/year) this is 0.8–8 MB. Not material relative to the 500 MB budget.
- **Cold-cutoff inside-out shrink under budget pressure.** Aggressive: a user blowing past 500 MB gets less history. The alternative (refuse to prune, let DB grow forever) is worse because it eventually breaks the daemon entirely. The doctor warns at 80% so the user has runway to bump `CLAWKET_ACTIVITY_LOG_MAX_MB` before the retention window narrows.

## Open questions

- **OQ-0010-1**: Should the archive blob be portable across daemon versions? Right now the JSON shape is `Vec<ActivityLogEntry>` serde-default. Future schema changes to ActivityLogEntry will require a per-version reader (mirroring ADR-0011). Defer until the second activity_log column shape change.
- **OQ-0010-2**: Should we expose the archive table to the web Timeline as a "load older" pagination hook? Out of scope for v11; the warm tier already keeps a year inline, which covers all known user stories.

## Verification

```bash
test -f clawket/docs/adr/0010-activity-log-retention.md
grep -q 'CLAWKET_ACTIVITY_LOG_MAX_MB' daemon/src/jobs/activity_log_rollup.rs
cargo test --manifest-path daemon/Cargo.toml jobs::activity_log_rollup
cargo test --manifest-path daemon/Cargo.toml --test doctor_budget
```
