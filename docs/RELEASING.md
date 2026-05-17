# Releasing

Two release mechanisms live in this repo. Both are automated; manual steps only on rollback.

> Top-level `RELEASING.md` documents the **plugin** release workflow (Conventional Commit driven). This file documents **cross-component release order** when more than one component is moving together.

## Cross-component release order

Each component has its own repo and its own auto-release workflow. When a coordinated change spans more than one component, release in this order so the plugin always pins versions that are already published.

| # | Component | Repo | Distribution |
|---|---|---|---|
| 1 | `clawket/daemon`   | Rust daemon | GitHub Releases (5 platform binaries) |
| 2 | `clawket/cli`      | Rust CLI + embedded `clawket mcp` | GitHub Releases (5 platform binaries) |
| 3 | `clawket/web`      | React dashboard | GitHub Releases tarball |
| 4 | `clawket/desktop`  | Tauri 2 desktop app (depends on web bundle for renderer assets) | GitHub Releases installer (`.dmg` / `.msi` / `.AppImage`) — `null`-pinned in `components.json` until first release |
| 5 | `clawket/clawket`  | Plugin shell | Marketplace install (`marketplace.json` on `main` HEAD) + git tag |
| 6 | `clawket/landing`  | Public landing page | Cloudflare Pages |

`clawket/desktop` slots between `web` and the plugin shell because it consumes the `web` tarball at build time (Tauri bundles the SPA into the renderer). During the v3.0.0 window the desktop pin is `null` (sentinel — sub-repo + first release pending), and the install gate treats that as a no-op skip; the order step is enforced only when the pin becomes a string tag.

`clawket/mcp` (legacy Node MCP server) is no longer part of the release chain — removed from plugin dependencies in v2.3.2 and **archived** in plugin v11 U4 (final deprecation commit `542c397`; the local working copy was removed, the GitHub repo is read-only and remains as the npm replacement pointer).

`clawket/landing` is downstream of the plugin tag, not the binary components. The plugin `release.yml` dispatches `repository_dispatch{event_type: baseline-bumped, client_payload.tag: vX.Y.Z}` to `clawket/landing` after each successful tag (see `Notify clawket/landing of baseline bump` step). The landing repo's `.github/workflows/auto-update.yml` consumes that event, derives the hero label as `vMAJOR.MINOR`, runs `scripts/update-version-label.sh`, and opens an `auto-update/<tag>` PR. A daily `0 6 * * *` cron sweep on the landing side fetches the latest `clawket/clawket` release tag as a fallback if the dispatch was lost (PAT scope, transient API failure, etc.); `workflow_dispatch` with `dry_run=true` produces a diff-only preview. Landing builds remain deterministic and offline — the version is propagated by PR, not by build-time fetch.

## How a plugin patch happens automatically

1. `clawket/cli` or `clawket/daemon` cuts a release.
2. An automated workflow opens a "bump cli/daemon to vX.Y.Z" PR against `clawket/clawket`, updating `components.json`.
3. PR merges. `release.yml` (see top-level `RELEASING.md`) detects the `fix:` / `chore:` commits and decides whether to cut a plugin patch.
4. If cut, the workflow:
   - bumps `package.json` + `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`
   - appends a row to `docs/COMPATIBILITY.md`
   - tags `vX.Y.Z` on `main` and creates a GitHub Release

## Version pinning surfaces

| Surface | What it pins | Editor |
|---|---|---|
| `package.json` `compat` | SemVer ranges per component | Bumped manually only when a component majors |
| `components.json` | Exact `vX.Y.Z` of each binary consumed at install | Bumped automatically by component-bump PRs |
| `adapters/shared/claude-hooks.cjs` env vars (`CLAWKET_CLI_VERSION`, `CLAWKET_DAEMON_VERSION`) | Local-dev override only | Not edited — env-only |
| `docs/COMPATIBILITY.md` matrix row | Tested combination per plugin release | Appended automatically by `release.yml` |
| `clawket/landing` `src/App.tsx` hero (`clawket — vMAJOR.MINOR`) | Public landing version label | Bumped automatically by `landing/.github/workflows/auto-update.yml` on `baseline-bumped` dispatch / daily cron |

### Required tokens for the landing dispatch chain

- `clawket/clawket` secret `CLAWKET_RELEASE_PAT` — used by `release.yml` to call `repos/clawket/landing/dispatches`; the PAT must include `repository_dispatch:write` (or fine-grained `contents:write`) on `clawket/landing` in addition to its existing `clawket/clawket` scopes. If the dispatch step logs a permission error, the daily 06:00 UTC sweep on the landing side still catches up — no plugin release is blocked.
- `clawket/landing` secret `GH_PAT` — used by `auto-update.yml` to checkout, push the `auto-update/<tag>` branch, open the PR, and (during sweep) read the latest `clawket/clawket` release tag.

`CLAWKET_CLI_VERSION` lives only as an env-var fallback inside `claude-hooks.cjs` for local dev; in normal flow `components.json` is the single pinning source.

## Manual override

Use `workflow_dispatch` on `release.yml` with the `bump` input (`patch`/`minor`/`major`) to force a plugin release regardless of commit messages. See top-level `RELEASING.md`.

## Rollback

The plugin no longer runs `npm install` on user machines (since v2.3.2). To roll a user back:

- `gitCommitSha` pin in `~/.claude/installed_plugins.json` to a previous tag, or
- retag the plugin with the previous compat ranges; already-installed users stay on the old plugin until they re-install.

The install gate (`adapters/shared/claude-hooks.cjs::ensureInstalled`) re-checks marker files against `components.json` on each session, so downgrading the plugin tarball automatically re-downloads the matching binaries on the next `SessionStart`.
