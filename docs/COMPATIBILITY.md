# Clawket Compatibility Matrix

The plugin shell (`clawket/clawket`) declares permitted version ranges for each independent
component in `package.json` (`compat` for external binaries and non-npm assets) and pins the
exact binary version per release in `components.json`. Bumping the plugin requires recording
the tested combination here.

## Components

| Component | Repo | Distribution | Declared in plugin |
|---|---|---|---|
| `@clawket/cli` | `clawket/cli` | GitHub Releases binary (Rust; `clawket` + embedded `clawket mcp`) | `compat` + `components.json.cli` |
| `@clawket/daemon` | `clawket/daemon` | GitHub Releases binary (Rust, axum + rusqlite) | `compat` + `components.json.daemon` |
| `@clawket/web` | `clawket/web` | GitHub Releases tarball (static SPA bundle) | `compat` + `components.json.web` |
| `@clawket/desktop` | `clawket/desktop` | GitHub Releases installer (Tauri 2: `.dmg` / `.msi` / `.AppImage`) | `compat` + `components.json.desktop` (`null` until first release) |
| `@clawket/landing` | `clawket/landing` | Cloudflare/GitHub Pages | n/a |
| `@clawket/mcp` (legacy) | `clawket/mcp` | npm (Node stdio server) | **archived in plugin v11 U4** (final deprecation commit `542c397`) — not installed since v2.3.2; replaced by `clawket mcp` subcommand |

## Matrix

| Plugin | daemon | cli | web | desktop | mcp (legacy) |
|---|---|---|---|---|---|
| `2.3.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | `>=0.1.0 <1.0.0` (installed) |
| `2.3.1` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | `>=0.1.0 <1.0.0` (installed) |
| `2.3.2` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | removed from `dependencies` |
| `2.3.3` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | n/a — no auto-migration (warn-only) |
| `2.3.4` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | n/a |
| `2.3.5` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | n/a |
| `2.3.6` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | n/a |
| `2.3.7` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | n/a |
| `2.3.8` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | n/a |
| `2.3.9` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | n/a |
| `2.3.10` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | n/a |
| `2.3.11` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | n/a |
| `2.3.12` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | — | n/a |
| `3.0.4` | `>=0.2.0 <1.0.0` (pin: `v0.2.4`) | `>=0.2.0 <1.0.0` (pin: `v0.2.6`) | `>=0.1.0 <1.0.0` (pin: `v0.1.0`) | `>=3.0.0 <4.0.0` (pin: `null` — first release pending) | dropped (legacy MCP fully removed) |
| `3.0.5` | `>=0.2.0 <1.0.0` (pin: `v0.2.5`) | `>=0.2.0 <1.0.0` (pin: `v0.2.7`) | `>=0.1.0 <2.0.0` (pin: `v1.0.0`) | `>=3.0.0 <4.0.0` (pin: `null` — first release pending) | dropped (legacy MCP fully removed) |
| `3.0.6` | `>=0.2.0 <1.0.0` (pin: `v0.2.5`) | `>=0.2.0 <1.0.0` (pin: `v0.2.7`) | `>=0.1.0 <2.0.0` (pin: `v1.0.0`) | `>=3.0.0 <4.0.0` (pin: `null` — first release pending) | dropped (legacy MCP fully removed) |
| `3.0.7` | `>=0.2.0 <1.0.0` (pin: `v0.2.5`) | `>=0.2.0 <1.0.0` (pin: `v0.2.7`) | `>=0.1.0 <2.0.0` (pin: `v1.0.0`) | `>=3.0.0 <4.0.0` (pin: `null` — first release pending) | dropped (legacy MCP fully removed) |
| `3.0.8` | `>=0.2.0 <1.0.0` (pin: `v0.2.5`) | `>=0.2.0 <1.0.0` (pin: `v0.2.7`) | `>=0.1.0 <2.0.0` (pin: `v1.0.0`) | `>=3.0.0 <4.0.0` (pin: `null` — first release pending) | dropped (legacy MCP fully removed) |
| `3.0.9` | `>=0.2.0 <1.0.0` (pin: `v0.2.5`) | `>=0.2.0 <1.0.0` (pin: `v0.2.7`) | `>=0.1.0 <2.0.0` (pin: `v1.0.0`) | `>=3.0.0 <4.0.0` (pin: `null` — first release pending) | dropped (legacy MCP fully removed) |
| `3.1.0` | `>=0.2.0 <1.0.0` (pin: `v0.2.5`) | `>=0.2.0 <1.0.0` (pin: `v0.2.7`) | `>=0.1.0 <2.0.0` (pin: `v1.0.0`) | `>=3.0.0 <4.0.0` (pin: `null` — first release pending) | dropped (legacy MCP fully removed) |
| `3.1.1` | `>=0.2.0 <1.0.0` (pin: `v0.2.5`) | `>=0.2.0 <1.0.0` (pin: `v0.2.7`) | `>=0.1.0 <2.0.0` (pin: `v1.0.0`) | `>=3.0.0 <4.0.0` (pin: `null` — first release pending) | dropped (legacy MCP fully removed) |

Ranges are SemVer — a major bump in any component triggers a plugin major bump. Exact binary
versions consumed by setup live in `components.json` (current: `daemon: v0.2.5`, `cli: v0.2.7`, `web: v1.0.1`).
The `desktop` column entered the matrix in v3.0.0; the `—` for prior rows reflects that the
component did not exist. The v3.0.0 pin is `null` until the first `clawket/desktop` GitHub
Release lands — install gate treats `null` as a no-op skip.

## v3.0.0 breaking changes (summary)

The simultaneous major bump across plugin shell + cli + daemon + web in v3.0 is justified by
multiple cross-component contract breaks. See `MIGRATION-v2-to-v3.md` for the full guide.

- **Schema** — `tasks.tier`, `cycles.unit_id NOT NULL` + FK, `units` loses `status/approval_*`,
  `audit_log` table replaces `activity_log` semantics, QA workflow fields on `tasks`,
  `wiki_idx`/`wiki_depth` on knowledge, multilingual embedding model (re-embed required).
- **Daemon API** — ISO 8601 timestamps everywhere, `/plans/:id/counts` added, single-active-plan
  invariant returns 409, sync embedding on knowledge create/update, hybrid search returns
  3-score breakdown.
- **CLI** — removed `clawket execute`, `task envelope` subcommands (envelope contract retired);
  removed v11 MCP tools (`execute_task`, `walk_task_tree`, `decompose_task`, `validate_envelope`);
  added `clawket completions <shell>` for shell completion.
- **Plugin shell** — `hooks.json` `schema_version: "v3"`, dropped `TaskCreated/Completed/Stop`,
  added `ExitPlanMode` hook; `/clawket` skill restructured into 7 sub-flows; locale-aware hooks
  via `CLAWKET_LOCALE` chain; `CLAWKET_ALLOW_DESTRUCTIVE` bypass keyword removed; tier mismatch
  enforced as exit-code 3 (Policy).
- **Web** — daemon health indicator, theme toggle, command palette, knowledge default for wiki;
  bundle size 588 kB.
- **Distribution** — canonical asset names (`{cmd}-{os}-{arch}{.exe}`), SHA256SUMS published per
  release.

## v2 → v3 migration data path

The daemon’s automatic schema migration applies all pending migrations (011 onward; latest pinned in `daemon/src/db.rs`) on first start of v3. There
is no rollback — backup `~/.local/share/clawket/db.sqlite` before upgrading. The legacy
`activity_log` table is preserved for backward-compat rollup queries but is no longer written
to (writes go to `audit_log`). Embeddings are re-generated on first read of each knowledge entry
because the embedding model itself changed (the 384-dimensional vector schema is preserved, but values are not comparable across versions).

## Release coordination

1. **Breaking change in a component** — bump component major, open a PR to plugin repo
   updating the compat range. Do not release plugin until integration CI passes.
2. **Additive changes** — component minor/patch bump, no plugin change required.
3. **Binary release (CLI or daemon)** — cut a release in the component repo; an automated
   workflow updates `components.json` via a bump PR; merge triggers a plugin patch.

## Integration test responsibility

Each component repo owns unit tests for its surface. The plugin repo is the home of
integration tests that assemble the installed combination and exercise real hooks.

## Deprecation policy

A component keeps N-1 major support for 3 months after a new major ships. During that
window the plugin `compat` range spans both majors. After 3 months the plugin drops the
older major in a minor bump.
