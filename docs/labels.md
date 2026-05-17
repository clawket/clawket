# Cross-repo label standard

Every `@clawket` repository (`clawket`, `cli`, `daemon`, `mcp`, `web`,
`landing`, `evals`, `tap`) ships the same six issue/PR labels so that
contributors can move across repos without relearning the taxonomy.

## The six labels

| Label | Color | Hex | When to use |
|---|---|---|---|
| `good-first-issue` | purple | `7057ff` | Self-contained issue suitable for a first contribution. Maintainer has confirmed the diagnosis, the fix path is clear, and the change touches < 50 LOC. Always pair with one of the other labels (`bug`, `feat`, `docs`). |
| `help-wanted` | teal | `008672` | Maintainer wants outside contribution. Larger or more open-ended than `good-first-issue`. Implies the maintainer will not get to it soon. |
| `bug` | red | `d73a4a` | Reports observed behavior that contradicts a documented or reasonably expected behavior. Issue/PR templates auto-apply this. |
| `feat` | sky | `a2eeef` | New capability or non-trivial enhancement. Issue/PR templates auto-apply this. |
| `docs` | blue | `0075ca` | Documentation, examples, comments, or developer-facing copy. Issue/PR templates auto-apply this. |
| `breaking` | dark red | `b60205` | Backwards-incompatible change — CLI flag rename, removed daemon endpoint, schema migration without forward-compat. Triggers the SemVer major bump rule in the cli/daemon release workflows. |

These six are the **only** org-wide labels. Repo-specific labels (e.g.
`area/sse` in `daemon`, `area/wiki` in `web`) live in each repo and are
not enforced cross-repo.

## Auto-labeling

The label is applied at issue/PR creation time:

- **Issues**: each form in `.github/ISSUE_TEMPLATE/` declares its label
  in `labels: [...]`. Bug/feat/docs forms pre-fill `bug` / `feat` /
  `docs` respectively.
- **PRs**: the PR template does not auto-label. Reviewers add the
  appropriate label during review. The `breaking` label must be added
  manually whenever a Conventional Commit body contains
  `BREAKING CHANGE:` or the title is `feat!:` / `fix!:`.
- **`good-first-issue` and `help-wanted`** are added by maintainers, not
  by templates. Adding `good-first-issue` is a maintainer-only action
  because it implies a triage decision (the issue is well-scoped enough
  for a first-timer).

## Sync mechanism

The labels live as a single source of truth in
[`scripts/labels.yml`](../scripts/labels.yml) (data) and the sync logic
is in [`scripts/sync-labels.sh`](../scripts/sync-labels.sh) (dry-run by
default).

```bash
# preview — no API writes
bash scripts/sync-labels.sh

# preview a single repo
bash scripts/sync-labels.sh --repo clawket/cli

# apply across all 8 repos (requires gh auth + write on the org)
bash scripts/sync-labels.sh --apply
```

The script is idempotent: existing labels with the same name are
**edited** (color + description re-applied), missing labels are
**created**. Labels not in `labels.yml` are left alone — the script
never deletes labels.

If a repo is missing (e.g. `clawket/evals` is not yet created at the
time of writing), the script logs a `SKIP` line and continues.

## Verification

```bash
for r in clawket cli daemon mcp web landing evals tap; do
  echo "== $r =="
  gh label list --repo clawket/$r | grep -E '^(good-first-issue|help-wanted|bug|feat|docs|breaking)\b' || echo "  MISSING"
done
```

The expected output is six lines per repo. If a label is missing or has
drifted (different color or description), re-run `sync-labels.sh
--apply`.

## Why this set is small

We deliberately avoid the typical 20+ label sprawl (`triage/needs-info`,
`status/blocked`, `priority/p0` …) because triage state lives in
**Clawket task statuses**, not in GitHub labels. GitHub labels here only
classify the *kind* of change. Workflow state (in progress, blocked,
done, cycle assignment) is tracked in the local SQLite database via
`clawket task` — labels would duplicate that and drift.

If a future workflow genuinely needs a new label across all 8 repos,
add it to `labels.yml` + this document in the same PR. Per-repo labels
do not need this update.
