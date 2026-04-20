# Clawket Compatibility Matrix

The plugin shell (`clawket/clawket`) declares permitted version ranges for each independent
component in `package.json` (`dependencies` for Node packages, `compat` for external binaries
and non-npm assets). Bumping the plugin requires recording the tested combination here.

## Components

| Component | Repo | Distribution | Declared in plugin |
|---|---|---|---|
| `@clawket/mcp` | `clawket/mcp` | npm (Node, transitional) | `dependencies` |
| `@clawket/cli` | `clawket/cli` | GitHub Releases binary (Rust) | `compat` |
| `@clawket/daemon` | `clawket/daemon` | GitHub Releases tarball (Node, transitional → Rust binary) | `compat` |
| `@clawket/web` | `clawket/web` | GitHub Releases tarball (static SPA bundle) | `compat` |
| `@clawket/landing` | `clawket/landing` | Cloudflare/GitHub Pages | n/a |

## Matrix

| Plugin | daemon | mcp | cli | web |
|---|---|---|---|---|
| `2.3.0` | `>=2.2.0 <3.0.0` | `>=0.1.0 <1.0.0` | `>=2.2.0 <3.0.0` | `>=2.2.0 <3.0.0` |

Ranges are SemVer — a major bump in any component triggers a plugin major bump.

## Release coordination

1. **Breaking change in a component** — bump component major, open a PR to plugin repo
   updating the compat range. Do not release plugin until integration CI passes.
2. **Additive changes** — component minor/patch bump, no plugin change required.
3. **CLI binary release** — plugin setup resolves binaries by reading
   `CLAWKET_CLI_VERSION` (default pinned in `adapters/shared/claude-hooks.cjs`). To roll
   CLI forward, bump that constant and cut a plugin patch.
4. **npm dep bump** — update plugin `package.json` and tag a plugin patch.

## Integration test responsibility

Each component repo owns unit tests for its surface. The plugin repo is the home of
integration tests that assemble the installed combination and exercise real hooks.

## Deprecation policy

A component keeps N-1 major support for 3 months after a new major ships. During that
window the plugin `compat` range spans both majors. After 3 months the plugin drops the
older major in a minor bump.
