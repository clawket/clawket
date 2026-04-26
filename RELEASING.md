# Releasing

Plugin releases are automated by `.github/workflows/release.yml`. The workflow runs on every push to `main` and decides whether to release based on Conventional Commits since the last tag.

## Cadence

Triggered automatically when a PR with one of the following commit prefixes lands on `main`:

| Prefix | Bump |
|---|---|
| `feat!:` / `fix!:` / `BREAKING CHANGE:` body | major |
| `feat:` | minor |
| `fix:` / `perf:` | patch |
| `chore:` / `docs:` / `ci:` / `refactor:` / `test:` / `style:` / `build:` | no release |

## What the workflow does

1. Resolves the next version by walking commits since the last `v*` tag.
2. Updates the three version sources atomically:
   - `package.json`
   - `.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json` (`plugins[].version`)
3. Appends a row to `docs/COMPATIBILITY.md` (best-effort, idempotent on re-runs).
4. Commits with `[skip ci]`, tags `v${VERSION}`, and pushes atomically.
5. Creates a GitHub Release with auto-generated notes.

## Manual override

Use `workflow_dispatch` with the `bump` input (`patch`/`minor`/`major`) to force a release regardless of commit messages.

## Required secrets

- `CLAWKET_RELEASE_PAT` — fine-grained PAT with `contents: write` + `pull_requests: write` on `clawket/clawket`.

## Why we still tag

Claude Code marketplace install reads `marketplace.json` from `main` HEAD, so technically tags are not required for distribution. We keep them for:

- Regression bisection (`git checkout v2.3.7 -- .`)
- Rollback path (users can pin via `gitCommitSha` in `installed_plugins.json`)
- Human-readable release notes on GitHub
- Parity with `clawket/cli` and `clawket/daemon`, which both auto-release

## Troubleshooting

**The workflow ran but no release was created.**
The commit subjects on `main` since the last tag did not match any release-worthy prefix. Add a `feat:` / `fix:` commit, or trigger `workflow_dispatch` with an explicit bump.

**Two PRs merged in quick succession; only one release.**
That is intended. The workflow bumps once per `main` push that contains release-worthy commits since the last tag. The combined commits get folded into a single release with auto-generated notes covering all of them.
