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
| 6 | `clawket/landing`  | Public landing + docs site | Vercel (Git integration auto-builds on `main` push) |

`clawket/desktop` slots between `web` and the plugin shell because it consumes the `web` tarball at build time (Tauri bundles the SPA into the renderer). During the v3.0.0 window the desktop pin is `null` (sentinel — sub-repo + first release pending), and the install gate treats that as a no-op skip; the order step is enforced only when the pin becomes a string tag.

`clawket/mcp` (legacy Node MCP server) is no longer part of the release chain — removed from plugin dependencies in v2.3.2 and archived (the GitHub repo is read-only and remains as the npm replacement pointer).

`clawket/landing` is downstream of the plugin tag, not the binary components. The plugin `release.yml` dispatches `repository_dispatch{event_type: baseline-bumped, client_payload.tag: vX.Y.Z}` to `clawket/landing` after each successful tag (see `Notify clawket/landing of baseline bump` step). The landing repo's `.github/workflows/auto-update.yml` consumes that event, derives the hero label as `vMAJOR.MINOR`, runs `scripts/update-version-label.sh`, and opens an `auto-update/<tag>` PR. A daily `0 6 * * *` cron sweep on the landing side fetches the latest `clawket/clawket` release tag as a fallback if the dispatch was lost (PAT scope, transient API failure, etc.); `workflow_dispatch` with `dry_run=true` produces a diff-only preview. Landing builds remain deterministic and offline — the version is propagated by PR, not by build-time fetch.

## How a plugin patch happens automatically

1. `clawket/cli` or `clawket/daemon` cuts a release.
2. An automated workflow opens a "bump cli/daemon to vX.Y.Z" PR against `clawket/clawket`, updating `components.json`.
3. PR merges. `release.yml` (see top-level `RELEASING.md`) detects the `fix:` / `chore:` commits and decides whether to cut a plugin patch.
4. If cut, the workflow:
   - bumps `package.json` + `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`
   - appends a row to `docs/COMPATIBILITY.md`
   - tags `vX.Y.Z` on `main` and creates a GitHub Release

## Normal deployment flow (per sub-repo)

The end-to-end loop a contributor follows when shipping a sub-repo (`cli` / `daemon` / `web`) change. Plugin shell follows the same skeleton but the bump-manifest PR step is skipped (the plugin **receives** those PRs from upstream sub-repos).

```
┌─ sub-repo (cli / daemon / web)  ─────────────────────────────────────┐
│                                                                       │
│  1. git pull --rebase                        # always start from main │
│  2. <implement change>                                                │
│  3. Conventional Commit (feat: / fix: / chore: …)                     │
│     - feat: → minor   fix: → patch   feat!: / BREAKING → major        │
│  4. push branch → PR → review → merge                                 │
│  5. Auto-release workflow on main:                                    │
│     - cli/daemon: release-it bumps Cargo.toml + tag + GitHub Release  │
│     - web:        release-it bumps package.json + tag + Release       │
│  6. release.yml dispatches bump-manifest PR → clawket/clawket         │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ clawket/clawket (plugin shell)  ─────────────────────────────────────┐
│                                                                       │
│  7. Auto-PR: "bump <component> to vX.Y.Z" (updates components.json)   │
│  8. PR CI green? (skills-integrity / pre-tool-use.e2e / path-sep …)   │
│  9. Merge to main                                                     │
│  10. main CI green?                                                   │
│  11. release.yml decides plugin bump from commit prefix:              │
│      - chore(deps): … → no plugin release                             │
│      - fix: … → plugin patch                                          │
│      - feat: … → plugin minor                                         │
│  12. (if released) plugin tag pushed + GitHub Release published       │
│  13. release.yml dispatches `baseline-bumped` → clawket/landing       │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ Verification (always, even when no plugin release fired) ───────────┐
│                                                                       │
│  14. git pull on the affected sub-repo + plugin (state sync)          │
│  15. `gh release view --repo clawket/<sub-repo> vX.Y.Z` exists?       │
│  16. `gh run list --repo clawket/<sub-repo> --branch main --limit 1`  │
│      shows success?                                                   │
│  17. (plugin) `gh release view --repo clawket/clawket vA.B.C` exists  │
│      and components.json pins the new sub-repo tag?                   │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Step-by-step (sub-repo author perspective)

1. **Sync first** — `git pull --rebase` on the sub-repo branch. Never edit on a stale tree; the auto-release workflow rejects diverged history.
2. **Commit with intent** — Conventional Commit prefix decides the bump:
   - `feat: …` → minor (new capability)
   - `fix: …` → patch (bug fix)
   - `chore: / docs: / refactor: / test: / style: / build:` → no release
   - Append `!` or `BREAKING CHANGE:` in body for a major.
3. **PR → review → merge** to the sub-repo's `main`. Do not skip CI (`--no-verify`); a failing pre-commit hook signals a real regression in the bump pipeline.
4. **Auto-release fires on main** — release-it (cli/daemon use `cargo set-version` inside the same workflow; web uses release-it pure) bumps the version, tags, pushes, and creates the GitHub Release with auto-generated notes.
5. **Bump-manifest PR opens against `clawket/clawket`** — title format: `chore(deps): bump <component> to vX.Y.Z`. The PR body lists the upstream release notes verbatim.
6. **Verify the PR content** before merge:
   - `components.json` diff shows exactly one key changed (`cli` / `daemon` / `web`) with the expected tag.
   - No drive-by changes to `package.json` / `plugin.json` / `marketplace.json` (those bump on the *next* step, not in the manifest PR).
   - CI green: `skills-integrity`, `pre-tool-use.e2e`, `path-separation.e2e`, `plugin-reinstall.e2e`, `data-loss-diagnostics.e2e`.
7. **Merge the manifest PR** — let `release.yml` decide whether the resulting `chore(deps)` commit triggers a plugin bump. `chore(deps)` alone does **not** cut a plugin release (by design — manifest pin changes are no-op for users until paired with a `fix:` / `feat:` commit).
8. **Verify main CI** after merge:
   ```bash
   gh run list --repo clawket/clawket --branch main --limit 1
   gh run view <run-id> --repo clawket/clawket --log-failed   # if red
   ```
9. **Verify the upstream Release exists**:
   ```bash
   gh release view vX.Y.Z --repo clawket/<cli|daemon|web>
   ```
   If the tag exists but no Release page, the sub-repo's `release.yml` likely failed mid-flight — investigate before declaring the deployment done.
10. **Verify plugin Release** (only if a plugin bump was expected):
    ```bash
    gh release view vA.B.C --repo clawket/clawket
    git -C clawket/clawket pull --rebase
    jq . clawket/clawket/components.json   # confirm new pin
    ```

### Invariants

- **One sub-repo at a time** — coordinate multi-component releases via the `Cross-component release order` table above. Manifest PRs cannot stack safely if multiple sub-repos race their auto-release in the same window.
- **Pull before edit** — every step that touches a local working copy starts with `git pull --rebase`. Stale state is the #1 cause of failed manifest PRs.
- **No force-push, no revert** — if a Release is wrong, cut a new patch with the correct fix. Force-push and revert leave artifacts that confuse the install gate's `.clawket-version` marker reconciliation.
- **Hands off the plugin repo for sub-repo bumps** — the plugin shell receives bump-manifest PRs only. Direct edits to `components.json` from a contributor's branch bypass the auto-release verification chain.
- **Manifest PR is the contract** — if the auto-PR does not appear within ~5 minutes of the upstream Release being published, the dispatch failed (PAT scope / API hiccup). Re-run the upstream `release.yml` workflow's "dispatch bump" step rather than hand-crafting the PR.

## Version pinning surfaces

| Surface | What it pins | Editor |
|---|---|---|
| `package.json` `compat` | SemVer ranges per component | Bumped manually only when a component majors |
| `components.json` | Exact `vX.Y.Z` of each binary consumed at install | Bumped automatically by component-bump PRs |
| `adapters/shared/claude-hooks.cjs` env vars (`CLAWKET_CLI_VERSION`, `CLAWKET_DAEMON_VERSION`) | Local-dev override only | Not edited — env-only |
| `docs/COMPATIBILITY.md` matrix row | Tested combination per plugin release | Appended automatically by `release.yml` |
| `clawket/landing` `src/App.tsx` hero (`clawket — vMAJOR.MINOR`) | Public landing version label | Bumped automatically by `landing/.github/workflows/auto-update.yml` on `baseline-bumped` dispatch / daily cron |

### Required tokens for the landing dispatch chain

- `clawket/clawket` secret `CLAWKET_RELEASE_PAT` — used by `release.yml` to call `repos/clawket/landing/dispatches`. This is a cross-repo write (firing `repository_dispatch` on a different repository) which the built-in `GITHUB_TOKEN` cannot authorize, so it requires a PAT. Required scopes: `repository_dispatch:write` (or fine-grained `contents:write`) on `clawket/landing`, in addition to the existing `clawket/clawket` scopes. If a dispatch step logs a permission error, the daily 06:00 UTC sweep on the consumer side still catches up — no plugin release is blocked.
- Consumer side (`clawket/landing` `auto-update.yml`) — **uses the workflow's default `GITHUB_TOKEN`**. The workflow does only same-repo writes (checkout, push branch, open PR) and public-repo reads (release metadata on `clawket/clawket`, `clawket/cli`, `clawket/daemon`). The job-level `permissions: { contents: write, pull-requests: write }` block grants the necessary scopes. No PAT is required on consumer repos.

`CLAWKET_CLI_VERSION` lives only as an env-var fallback inside `claude-hooks.cjs` for local dev; in normal flow `components.json` is the single pinning source.

## Manual override

Use `workflow_dispatch` on `release.yml` with the `bump` input (`patch`/`minor`/`major`) to force a plugin release regardless of commit messages. See top-level `RELEASING.md`.

## Rollback

The plugin no longer runs `npm install` on user machines (since v2.3.2). To roll a user back:

- `gitCommitSha` pin in `~/.claude/installed_plugins.json` to a previous tag, or
- retag the plugin with the previous compat ranges; already-installed users stay on the old plugin until they re-install.

The install gate (`adapters/shared/claude-hooks.cjs::ensureInstalled`) re-checks marker files against `components.json` on each session, so downgrading the plugin tarball automatically re-downloads the matching binaries on the next `SessionStart`.
