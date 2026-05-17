#!/usr/bin/env bash
# Cross-repo Korean ↔ English drift guard for `*.ko.md` translations.
#
# Usage:
#   bash scripts/check-i18n-sync.sh                  # current repo
#   bash scripts/check-i18n-sync.sh --repo PATH      # repo at PATH
#   bash scripts/check-i18n-sync.sh --strict         # warnings -> failures
#   bash scripts/check-i18n-sync.sh --dry-run        # alias for default
#
# Policy: docs/i18n-policy.md (in the meta repo).
# Exit codes: 0 ok / warns, 1 failure, 2 invocation error.
#
# Detection rules:
#   - Find every *.ko.md tracked by git.
#   - For each, derive English sibling by stripping .ko (foo.ko.md -> foo.md).
#   - Sibling missing -> FAIL.
#   - Header (`^## `) count mismatch -> FAIL.
#   - Fenced code-block (` ``` `) count mismatch -> FAIL.
#   - Outbound URL set mismatch -> WARN (or FAIL if >=5 URLs differ).
#   - English sibling has commits newer than the .ko.md by >14d -> WARN, >21d -> FAIL.
#   - Must-translate repo has no .ko.md for a top-level README.md -> FAIL.
#
# Repo classification (must-translate ⇒ README.ko.md required):
#   clawket, cli, daemon, web    : must-translate
#   landing, mcp, tap, evals     : optional

set -euo pipefail

WARN_DAYS=14
FAIL_DAYS=21
URL_DIFF_FAIL=5
MUST_TRANSLATE=("clawket" "cli" "daemon" "web")

repo_path="."
strict=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo_path="${2:-}"; [[ -z "$repo_path" ]] && { echo "missing value for --repo" >&2; exit 2; }; shift 2 ;;
    --strict) strict=1; shift ;;
    --dry-run) shift ;;   # default mode; flag accepted for symmetry with sync-labels
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -d "$repo_path/.git" ]] && ! git -C "$repo_path" rev-parse --git-dir >/dev/null 2>&1; then
  echo "not a git repo: $repo_path" >&2
  exit 2
fi

cd "$repo_path"

# Identify repo via origin URL → bucket.
origin="$(git remote get-url origin 2>/dev/null || echo "")"
repo_name=""
case "$origin" in
  *clawket/clawket*) repo_name="clawket" ;;
  *clawket/cli*)     repo_name="cli" ;;
  *clawket/daemon*)  repo_name="daemon" ;;
  *clawket/web*)     repo_name="web" ;;
  *clawket/mcp*)     repo_name="mcp" ;;
  *clawket/landing*) repo_name="landing" ;;
  *clawket/tap*)     repo_name="tap" ;;
  *clawket/evals*)   repo_name="evals" ;;
  *) repo_name="(unknown)" ;;
esac

is_must_translate=0
for r in "${MUST_TRANSLATE[@]}"; do
  [[ "$repo_name" == "$r" ]] && { is_must_translate=1; break; }
done

echo "i18n-sync drift check"
echo "  repo:    $repo_name (path: $repo_path, origin: ${origin:-none})"
printf "  policy:  %s\n" "$([[ $is_must_translate -eq 1 ]] && echo "MUST translate (README.ko.md required)" || echo "optional translation")"
echo "  strict:  $([[ $strict -eq 1 ]] && echo "yes (warnings -> failures)" || echo "no")"
echo

fail_count=0
warn_count=0

count_lines() {  # count_lines <pattern> <file>
  # grep -c prints the count to stdout AND exits 1 when zero matches.
  # `|| echo 0` would then append a second "0", producing "0\n0" — which
  # later breaks `[[ "$h_ko" -ne "$h_en" ]]` with a syntax error. Suppress
  # the non-zero exit instead of falling through to echo.
  grep -cE "$1" "$2" 2>/dev/null; true
}

extract_urls() {  # print sorted unique URLs from markdown links
  # `set -euo pipefail` (top of file) makes any failing pipe command kill the
  # script. When a markdown file has no links at all, the leading grep returns
  # exit 1 with no output. Without `|| true` on each grep, the function aborts
  # the entire script silently for any link-free file.
  { grep -oE '\]\([^)]+\)' "$1" 2>/dev/null || true; } \
    | sed -E 's/^\]\(//; s/\)$//' \
    | { grep -E '^https?://' || true; } \
    | sort -u
}

last_commit_unix() {  # last commit unix time for file
  git log -1 --format=%ct -- "$1" 2>/dev/null || echo 0
}

# 1) must-translate guard: README.ko.md must exist.
if [[ $is_must_translate -eq 1 ]]; then
  if [[ -f README.md && ! -f README.ko.md ]]; then
    printf "  [FAIL] README.ko.md missing in must-translate repo (%s)\n" "$repo_name"
    fail_count=$((fail_count + 1))
  fi
fi

# 2) walk every *.ko.md tracked OR newly-added (untracked, not gitignored).
# Tracked: handles the post-commit / CI case.
# Untracked + not-ignored: handles the "PR author just dropped the file in"
# local-verification case so `verify --dry-run` does not silently skip work.
ko_files=()
while IFS= read -r f; do
  [[ -n "$f" ]] && ko_files+=("$f")
done < <(
  {
    git ls-files '*.ko.md'
    git ls-files --others --exclude-standard '*.ko.md'
  } 2>/dev/null | sort -u
)

if [[ ${#ko_files[@]} -eq 0 ]]; then
  echo "  no *.ko.md files tracked. nothing to check."
else
  for ko in "${ko_files[@]}"; do
    en="${ko%.ko.md}.md"

    if [[ ! -f "$en" ]]; then
      printf "  [FAIL] %s — English sibling missing (%s)\n" "$ko" "$en"
      fail_count=$((fail_count + 1))
      continue
    fi

    # structural diffs
    h_ko=$(count_lines '^## ' "$ko")
    h_en=$(count_lines '^## ' "$en")
    cb_ko=$(count_lines '^```' "$ko")
    cb_en=$(count_lines '^```' "$en")

    file_failed=0

    if [[ "$h_ko" -ne "$h_en" ]]; then
      printf "  [FAIL] %s — header count mismatch (ko=%s, en=%s)\n" "$ko" "$h_ko" "$h_en"
      fail_count=$((fail_count + 1))
      file_failed=1
    fi

    if [[ "$cb_ko" -ne "$cb_en" ]]; then
      printf "  [FAIL] %s — code block count mismatch (ko=%s, en=%s)\n" "$ko" "$cb_ko" "$cb_en"
      fail_count=$((fail_count + 1))
      file_failed=1
    fi

    # URL set diff
    urls_ko="$(extract_urls "$ko")"
    urls_en="$(extract_urls "$en")"
    diff_count=$(diff <(echo "$urls_ko") <(echo "$urls_en") | grep -cE '^[<>]' || true)
    if [[ "$diff_count" -gt 0 ]]; then
      if [[ "$diff_count" -ge "$URL_DIFF_FAIL" ]]; then
        printf "  [FAIL] %s — URL set differs by %s entries (>=%s)\n" "$ko" "$diff_count" "$URL_DIFF_FAIL"
        fail_count=$((fail_count + 1))
        file_failed=1
      else
        printf "  [WARN] %s — URL set differs by %s entries\n" "$ko" "$diff_count"
        warn_count=$((warn_count + 1))
      fi
    fi

    # age drift
    t_ko=$(last_commit_unix "$ko")
    t_en=$(last_commit_unix "$en")
    if [[ "$t_en" -gt "$t_ko" && "$t_ko" -gt 0 ]]; then
      gap_days=$(( (t_en - t_ko) / 86400 ))
      if [[ "$gap_days" -gt "$FAIL_DAYS" ]]; then
        printf "  [FAIL] %s — English sibling is %sd ahead (>%sd)\n" "$ko" "$gap_days" "$FAIL_DAYS"
        fail_count=$((fail_count + 1))
        file_failed=1
      elif [[ "$gap_days" -gt "$WARN_DAYS" ]]; then
        printf "  [WARN] %s — English sibling is %sd ahead (>%sd)\n" "$ko" "$gap_days" "$WARN_DAYS"
        warn_count=$((warn_count + 1))
      fi
    fi

    [[ $file_failed -eq 0 ]] && printf "  [ ok ] %s\n" "$ko"
  done
fi

echo
echo "summary: ${#ko_files[@]} translated file(s), $fail_count failure(s), $warn_count warning(s)"

if [[ $fail_count -gt 0 ]]; then
  exit 1
fi
if [[ $strict -eq 1 && $warn_count -gt 0 ]]; then
  echo "strict mode: warnings count as failures."
  exit 1
fi
exit 0
