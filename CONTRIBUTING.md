# Contributing to `clawket/clawket`

The Claude Code plugin shell — manifest, hooks, skills, and the install gate
that fetches the cli + daemon binaries on first session start. The actual
CLI/daemon lives in [`clawket/cli`](https://github.com/clawket/cli) and
[`clawket/daemon`](https://github.com/clawket/daemon); this repo is the
distribution surface that wires them into Claude Code.

## Local setup

```bash
git clone https://github.com/clawket/clawket
cd clawket
# Plugin assets are pre-built — no install step needed for hook editing.
# To exercise the install gate end-to-end, drop this dir into
# ~/.claude/plugins/clawket-clawket/ (or symlink it) and start a session.
```

The hook handlers run on Node (Claude Code's bundled runtime). They use only
built-in modules — no `npm install` step is required.

## Run tests

```bash
node --test adapters/         # exercises hook stubs (when present)
node scripts/lint-manifest.mjs  # plugin manifest schema check
```

When adding a new hook, add a stub fixture under `adapters/__fixtures__/` and
extend the `node --test` runner. The CI workflow (`.github/workflows/ci.yml`)
runs both checks on every PR.

## Pull requests

- Branch off `main`. PRs target `main` only — there is no `develop` branch.
- One concern per PR: hook change, manifest bump, and skill update each get
  their own diff so reviewers can revert independently.
- Update [`components.json`](./components.json) only via the auto-bump PR
  flow (the cli/daemon release workflows open it). Do not edit pinned
  versions by hand.
- If your change crosses the [path separation invariant](./CLAUDE.md#path-separation-invariant-lm-8),
  call it out in the PR description — that boundary is enforced at runtime.

## Commit convention

Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `refactor:`,
`test:`). The cli/daemon releases auto-bump SemVer from `feat`/`fix`/`perf`;
this repo does not auto-release, but consistent messages make changelog
generation easier later.

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) (or the [v11 plan in
Clawket](https://github.com/clawket/clawket/blob/main/plans/v11-structured-task-contracts.md))
for the cross-repo milestones (M5 distribution, M7 contract compliance).
