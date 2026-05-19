#!/usr/bin/env bash
# Cross-repo label sync — Clawket org standard.
#
# Usage:
#   bash scripts/sync-labels.sh                  # dry-run, all 6 repos
#   bash scripts/sync-labels.sh --repo OWNER/REPO   # dry-run, single repo
#   bash scripts/sync-labels.sh --apply           # actually write to GitHub
#   bash scripts/sync-labels.sh --apply --repo OWNER/REPO
#
# Source of truth for the label set: scripts/labels.yml.
# This script keeps the same definition inline (TSV) so it has zero
# external dependencies beyond `gh` and a POSIX shell. If you change one,
# change the other — the docstring in docs/labels.md flags this.
#
# Idempotent: existing labels are edited (color + description re-applied),
# missing labels are created. Labels not in this list are NEVER deleted.
# Missing repos are skipped, not fatal.
#
# Requires: gh CLI authenticated with write access to the clawket org.

set -euo pipefail

REPOS=(
  clawket/clawket
  clawket/cli
  clawket/daemon
  clawket/mcp
  clawket/web
  clawket/landing
)

# Mirror of scripts/labels.yml. Format: name<TAB>color<TAB>description.
LABELS=$'good-first-issue\t7057ff\tGood for newcomers — well-scoped, < 50 LOC, fix path is clear
help-wanted\t008672\tMaintainer wants outside contribution
bug\td73a4a\tObserved behavior contradicts documented or expected behavior
feat\ta2eeef\tNew capability or non-trivial enhancement
docs\t0075ca\tDocumentation, examples, comments, or developer-facing copy
breaking\tb60205\tBackwards-incompatible change — triggers SemVer major bump'

apply=0
target=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) apply=1; shift ;;
    --repo)  target="${2:-}"; [[ -z "$target" ]] && { echo "missing value for --repo" >&2; exit 2; }; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found on PATH" >&2
  exit 3
fi

if [[ -n "$target" ]]; then
  REPOS=("$target")
fi

mode="DRY-RUN (no API writes)"
[[ $apply -eq 1 ]] && mode="APPLY (writing to GitHub)"
echo "Clawket label sync"
echo "  mode:  $mode"
echo "  repos: ${#REPOS[@]} (${REPOS[*]})"
echo

exit_code=0
for repo in "${REPOS[@]}"; do
  if ! gh repo view "$repo" >/dev/null 2>&1; then
    printf '  [SKIP] %s — repo not found or no access\n' "$repo"
    continue
  fi

  existing="$(gh label list --repo "$repo" --json name -q '.[].name' 2>/dev/null || true)"
  printf '  [REPO] %s\n' "$repo"

  while IFS=$'\t' read -r name color desc; do
    [[ -z "$name" ]] && continue
    action="create"
    if grep -qx -- "$name" <<<"$existing"; then
      action="edit"
    fi

    if [[ $apply -eq 1 ]]; then
      if [[ $action == "create" ]]; then
        gh label create "$name" --repo "$repo" --color "$color" --description "$desc" \
          >/dev/null 2>&1 \
          && printf '         + %-18s %s\n' "$name" "(#$color)" \
          || { printf '         ! %-18s create FAILED\n' "$name"; exit_code=1; }
      else
        gh label edit "$name" --repo "$repo" --color "$color" --description "$desc" \
          >/dev/null 2>&1 \
          && printf '         ~ %-18s %s\n' "$name" "(#$color)" \
          || { printf '         ! %-18s edit FAILED\n' "$name"; exit_code=1; }
      fi
    else
      sigil="+"; [[ $action == "edit" ]] && sigil="~"
      printf '         %s %-18s %s  %s\n' "$sigil" "$name" "(#$color)" "$desc"
    fi
  done <<<"$LABELS"
done

if [[ $apply -eq 0 ]]; then
  echo
  echo "Dry-run complete. Re-run with --apply to write changes."
fi

exit "$exit_code"
