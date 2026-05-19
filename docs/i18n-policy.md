# i18n policy

Clawket has a Korean-speaking primary maintainer and an English-speaking
target launch audience (HN, Reddit, awesome-claude-code, GitHub
discoverability). The dual reality leaks into every public knowledge —
README, CONTRIBUTING, landing copy, even commit messages — and produces
**drift**: the Korean side gets updated first, the English side rots,
and the launch ships behind a stale tagline.

This policy fixes the drift problem at the knowledge level (which file is
authoritative in which language) and at the timing level (how long a
mismatch is allowed to live before CI complains).

## Three axes: documentation, CLI runtime, landing runtime

This policy has three independent scopes:

1. **Documentation translation** (`*.md` files in any repo) — bilingual **English + Korean** only. Tracks drift via the `i18n-sync` workflow.
2. **CLI runtime locale strings** (CLI output, hook messages, daemon errors) — trilingual **English + Korean + Japanese**, resolved per-invocation through the `CLAWKET_LOCALE` env var with chained fallback. Not tracked for drift in the same way as documentation; missing keys fall back to the next locale in the chain.
3. **Landing runtime locale strings** (the public Vercel LP) — **20 locales** co-located in a single TypeScript dictionary, resolved per-visit through URL `?lang=` → `localStorage` → `navigator.language` → `'en'`. No file-based drift mechanism applies because every locale ships in the same commit; per-locale completeness is enforced by `landing/src/i18n/dict.test.ts` (TypeScript `Record<Locale, Dict>` makes a missing key a compile error, and the test suite asserts no blank values + matching `<code>` region counts across locales).

The CLI runtime axis lives in `clawket/locales/{en,ko,ja}.json`, `clawket/adapters/shared/locale.cjs`, and `clawket/destructive-patterns.json` (per-locale phrase tables). Adding a fourth CLI runtime locale is a code change (add the JSON bundle + extend `SUPPORTED`), not a documentation change.

The landing runtime axis lives in `landing/src/i18n/dict.ts` (typed dictionary) + `landing/src/i18n/locales.ts` (BCP47 codes, native names, text direction) + `landing/src/i18n/context.tsx` (provider + `useT` hook + `Trans` component for `<code>` regions). Locales shipped: `en` (source), `ko`, `ja`, `zh-Hans`, `zh-Hant`, `es`, `fr`, `de`, `pt-BR`, `ru`, `it`, `ar` (RTL), `hi`, `id`, `tr`, `vi`, `th`, `pl`, `nl`, `sv`. Adding a 21st locale is a `dict.ts` + `locales.ts` extension; `dict.test.ts` enforces completeness on the next CI run.

The documentation axis (below) is intentionally **not** extended to Japanese — there is no `*.ja.md` sibling track and no maintainer commitment to keep one in sync.

## Policy by knowledge (documentation axis)

The `landing/` Vercel LP is intentionally absent from this table — it is no longer translated as a `*.ko.html` sibling. The 20-locale runtime dictionary (axis 3 above) replaces the file-pair model for the LP, so the documentation-axis drift policy does not apply to it.

| Knowledge | Authoritative language | Translation | Drift policy |
|---|---|---|---|
| `*/README.md` | English | `*/README.ko.md` | Translation must exist for `clawket`, `cli`, `daemon`, `web`, `desktop` (the five user-facing repos). `mcp` is deprecated — README.ko optional. `landing`, `tap`, `evals` — translation optional. |
| `*/CONTRIBUTING.md` | English | none required | Internal contributors are bilingual. No `.ko` sibling needed. |
| `*/ROADMAP.md`, `*/CODE_OF_CONDUCT.md` | English | none required | Standard OSS docs in English only. |
| `clawket/CLAUDE.md`, `lattice-mono/**/CLAUDE.md` | Korean | none | Maintainer-internal operating notes. Translation explicitly **not** wanted (would drift). |
| `clawket/plans/*.md` | Korean | none | Internal planning. Same reason as CLAUDE.md. |
| Issue / PR templates | English | none | English-only — issues/PRs can be filed in either language but the form prompts are English. |
| Launch posts | language-of-the-channel | n/a | HN / Reddit / awesome-claude-code: English. r/Korean / dev.to KR / 한국어 SNS: Korean. Japanese: dev.to / Qiita posts when launched. No drift tracking — they are point-in-time. |
| Commit messages | English (Conventional Commits) | n/a | The release workflow auto-bumps SemVer from English prefixes (`feat:`, `fix:`); non-English commit subjects break that. |

## Drift detection

The drift guard treats each `*.ko.md` file as a "translation of its
sibling `*.md`". Drift is defined as a structural mismatch (header
counts, link counts, code-block counts) **or** a lateness gap (the
English side has commits the Korean side has not caught up to).

```bash
bash scripts/check-i18n-sync.sh                    # whole repo, dry-run
bash scripts/check-i18n-sync.sh --repo .          # explicit repo path
bash scripts/check-i18n-sync.sh --dry-run         # alias for default
bash scripts/check-i18n-sync.sh --strict          # treat warnings as failures
```

The script exits with:

- `0` — no drift, or drift only at warning level
- `1` — at least one file is past the fail threshold, or a `.ko.md`
  has no English sibling, or `--strict` was passed and any warning fired
- `2` — invocation error (missing flag, no git repo, etc.)

### Thresholds (provisional)

The current numbers are first-cut defaults. They will be revised after
M6 (post-launch) when we have observed actual drift patterns and can
pick a number based on data instead of intuition. The decision will be
recorded in an ADR in `daemon/docs/adr/` (since the daemon is the only
repo with an ADR home today).

| Signal | Warning | Fail |
|---|---|---|
| English commits since last `.ko.md` update | 14 days | 21 days |
| `^## ` header count mismatch | 0 | always fail |
| Fenced code-block count mismatch | 0 | always fail |
| Outbound link URL set mismatch (URL set, not link text) | warn at any difference | fail when ≥ 5 URLs differ |
| Missing `.ko.md` sibling for a "must-translate" repo (clawket, cli, daemon, web, desktop) | n/a | always fail |

A header count mismatch fails immediately because that almost always
means a section was added on the English side without translation, and
the file becomes confusing rather than just stale.

A URL set mismatch warns at first difference because translations
naturally rephrase but should still link to the same external sources.
The threshold of 5 was chosen so that a single restructuring commit
(e.g. swapping the GitHub repo URL) does not blow up CI on every PR.

## CI integration

Each repo with a `.ko.md` translation gets a workflow:

```yaml
# .github/workflows/i18n-sync.yml
name: i18n-sync
on:
  pull_request:
    paths:
      - '**/*.md'
      - '**/*.ko.md'
  push:
    branches: [main]
jobs:
  drift-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # required for `git log` age detection
      - run: |
          curl -fsSL \
            https://raw.githubusercontent.com/clawket/clawket/main/scripts/check-i18n-sync.sh \
            -o /tmp/check-i18n-sync.sh
          bash /tmp/check-i18n-sync.sh --repo .
```

The workflow downloads the canonical script from the meta repo so that
we maintain it in **one** place. Each repo installs only the small YAML
file. When we change the policy, only the meta repo's script needs to
update — every other repo picks up the change on next CI run.

The "must-translate" repo list is held inside the script
(`MUST_TRANSLATE_REPOS`); a repo lookup uses `git remote get-url
origin` to resolve which classification applies. If the script can't
identify the repo, it falls back to **warn-only** mode.

## Migration

When this policy is rolled out (per-repo subtasks LM-225..232):

1. Add the `i18n-sync.yml` workflow to each "must-translate" repo.
2. If the repo has a `README.md` but no `README.ko.md`, generate a
   skeleton `README.ko.md` with the same headers (untranslated) and a
   `<!-- TODO: translate -->` marker per section. CI will warn but not
   fail until the next 14d window.
3. Backfill the `<!-- en-sha: <sha> -->` marker at the top of every
   `*.ko.md` to record the English sibling SHA at the time of last
   sync. The script uses this marker as a fallback when `git log` times
   are noisy.

## Why not a translation framework

A real i18n framework (i18next, Crowdin, Tolgee, etc.) is overkill for
six README files. The cost of the framework — build pipeline, lock file
churn, vendor lock-in for a single-maintainer project — exceeds the
cost of a 200-line bash script. If the project ever grows past 50
translated knowledge or adds a third language, revisit this decision.
