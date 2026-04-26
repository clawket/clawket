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
| `@clawket/landing` | `clawket/landing` | Cloudflare/GitHub Pages | n/a |
| `@clawket/mcp` (legacy) | `clawket/mcp` | npm (Node stdio server) | **deprecated, scheduled for archive in plugin v11 U4** — not installed since v2.3.2 |

## Matrix

| Plugin | daemon | cli | web | mcp (legacy) |
|---|---|---|---|---|
| `2.3.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=0.1.0 <1.0.0` (installed) |
| `2.3.1` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=0.1.0 <1.0.0` (installed) |
| `2.3.2` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | removed from `dependencies` |
| `2.3.3` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | n/a — no auto-migration (warn-only) |
| `2.3.4` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | n/a |
| `2.3.5` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | n/a |
| `2.3.6` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | n/a |
| `2.3.7` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | n/a |
| `2.3.8` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | n/a |
| `2.3.9` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` | n/a |

Ranges are SemVer — a major bump in any component triggers a plugin major bump. Exact binary
versions consumed by setup live in `components.json` (e.g. `daemon: v0.2.0`, `cli: v0.2.0`).

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
