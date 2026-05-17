# ADR-0009 — `secrets_ref` Field

| Status | Owner task | Targets | Plan |
|---|---|---|---|
| **Accepted** (M0 schema-freeze, RL-U2-09 dogfood passed 2026-04-27 by LM-54; F1/F2 hardening tracked in `plans/artifacts/u2-f1-envelope-signing.md` and `u2-f2-body-secret-guard.md`) | LM-57 / RL-U2-12 | Envelope field 14 (optional tier) | v11 — Structured Task Contracts |

## Context

`secrets_ref` is the v11 envelope's answer to "**which secrets does this task need access to, and where do they come from?**" v8 retros surface five distinct secrets-related failures:

1. **Plaintext-in-envelope**: an author pasted `OPENAI_API_KEY=sk-...` directly into a task body. Stored in SQLite, replayed across sessions, leaked into RAG search results.
2. **Source ambiguity**: a task referenced `$STRIPE_KEY` but the agent looked in `~/.zshrc`, then `os.environ`, then a co-worker's `1password://` URL. Different machines resolved to different secrets.
3. **Silent log leak**: the agent's tool output included `Authorization: Bearer sk-abc...` and that line ended up in `runs.events` JSON, queryable forever.
4. **Cross-task secret bleed**: task A's secret resolution succeeded; task B (no `secrets_ref`) inherited the resolved env var because it ran in the same shell.
5. **Untrackable rotation**: a secret was rotated but no surface tells the user "tasks signed before rotation may fail".

`secrets_ref` constrains all five into a per-secret declarative reference. The contract:

- The envelope **never** contains the secret value — only a *reference*.
- The reference is a **lookup chain** (ordered list of sources). The runner walks it at run-time.
- Resolved values are **redacted** in `runs.events` (regex-replaced before persist).
- A task without `secrets_ref` for a name **cannot** read that name from the environment (sandbox).

## Decision

`secrets_ref` is an array of secret references. Each reference declares the secret's logical name and the ordered chain of sources to try.

```json
{
  "secrets_ref": [
    {
      "name": "ANTHROPIC_API_KEY",
      "lookup_order": ["user_config", "keyring", "env", "1password"]
    },
    {
      "name": "GITHUB_TOKEN",
      "lookup_order": ["keyring", "env"]
    }
  ]
}
```

| Field | Type | Constraint | Notes |
|---|---|---|---|
| `name` | string | `^[A-Z][A-Z0-9_]{0,127}$` | The logical secret name. Used as the env var name when injected into the task's runtime. |
| `lookup_order` | array | 1–4 items, no duplicates | Ordered list. First successful resolution wins. |

### Source semantics

| Source | Meaning | Storage | Notes |
|---|---|---|---|
| `user_config` | Read from `~/.config/clawket/secrets.toml` | Plain TOML on disk | First in default order; fastest. File mode is enforced 0600 by `clawket secret set` (CLI command, M1). |
| `keyring` | Read from OS keychain (macOS Keychain / GNOME Keyring / Windows Credential Manager) | OS-managed | Most secure for long-lived secrets. Requires user unlock prompt on macOS. |
| `env` | Read from process environment | Process memory | Useful for CI / containerized contexts. The runner reads `os::environ` at task-spawn time only — secrets aren't held in daemon memory. |
| `1password` | Resolve via `op://` URI through `op` CLI | 1Password CLI | Requires `op` binary on PATH and authenticated session. Most expensive (process spawn). |

### Default lookup order (when an item omits its order)

```
[user_config, keyring, env, 1password]
```

Cheapest-and-safest first. The default order matches the JSON Schema's `description` line.

## Resolution algorithm

```
fn resolve(name: &str, chain: &[Source]) -> Result<Option<SecretValue>> {
    for source in chain {
        match read_from(source, name)? {
            Some(value) => return Ok(Some(value)),
            None => continue,
        }
    }
    Ok(None)
}
```

The runner calls `resolve` for each entry in `secrets_ref` exactly once at task-spawn time. The map `{name → value}` is stashed in the run's secret-bag (memory only, never persisted) and injected as env vars into the task's child processes — but **only those names**. The agent's child shell does not inherit the daemon's full environment.

Failed resolution (no source returned a value) is reported per-secret. The task's `precondition` (LM-133) can include `env.SECRET != null` to gate on resolution success.

## Redaction

Every secret value resolved during a run is added to a per-run **redaction set**. Before any `stdout`/`stderr` event is persisted to `runs.events`, the daemon string-replaces all members of the redaction set with `[REDACTED]`.

Redaction is **post-hoc** on stored output, not pre-emptive sanitization of program input — the task's child process sees real values; only the persistence layer scrubs.

Implementation note: the redaction set is built once per run, kept in memory, and its values are zeroed when the run ends (`zeroize` crate). The set itself never enters SQLite.

## Sandbox

By default, the task's child process inherits **none** of the parent's environment except:

- `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TERM` (the OS minimum)
- `CLAWKET_*` env vars (so the spawned `clawket` CLI knows where the daemon is)
- `RUST_LOG` (for daemon-aware children)
- The names declared in `secrets_ref`, with values from resolution

This means a parent shell's `OPENAI_API_KEY` is *not* visible to the child unless the envelope has a corresponding `secrets_ref` entry — even if the daemon's parent process inherited it. **Cross-task bleed is closed by the sandbox**, not by hoping the child doesn't read `os::environ`.

The minimum env list lives in `daemon/src/runner/env.rs::SAFE_ENV_NAMES` (new under LM-20). Adding to this list requires this ADR amendment.

## Six rejected alternatives

| # | Alternative | Why rejected |
|---|---|---|
| 1 | **Plaintext value in envelope** | The whole problem. Stored, replayed, RAG-searchable. Not a contract — a leak. |
| 2 | **Single source per secret (no chain)** | Real users have secrets in mixed locations (`ANTHROPIC_API_KEY` in keyring, `GITHUB_TOKEN` in env on CI). Forcing one source means CI and dev diverge. |
| 3 | **Path-style references** (`secret://keyring/ANTHROPIC_API_KEY`) | Looks tidy but composes badly with chains and adds parser surface. The structured `{name, lookup_order}` is plainer. |
| 4 | **Pre-emptive value sanitization** (replace before exec) | The agent often legitimately needs the secret in output (`echo "Auth ok: ${TOKEN:0:6}..."`). Pre-sanitization breaks that. Post-hoc redaction in `runs.events` is the right layer. |
| 5 | **Inherit full process env by default** | Cross-task bleed; impossible to reason about which task got which secret. |
| 6 | **Per-call resolution (re-resolve every LLM call)** | Slow (1Password CLI is process-spawn) and racy (rotation mid-task). Resolve once at task-spawn and cache for the run is the right tradeoff. |

## Open issues (some moved to LM-58 audit)

| # | Issue | Owner |
|---|---|---|
| O1 | Threat model for `user_config` (TOML at 0600) — what if user's home dir is shared? | LM-58 (RL-U2-13 audit) |
| O2 | Should `keyring` access be auditable (e.g. log "ANTHROPIC_API_KEY accessed at TS by task X")? | LM-58 — yes; runs.events records `secret_resolved: {name: "ANTHROPIC_API_KEY", source: "keyring", at: TS}` (no value). |
| O3 | Rotation handling: when a secret rotates, old runs that recorded the un-redacted hash become stale. Do we expire old runs' redaction sets? | LM-58 — out of scope for v1; recorded as "redacted" forever, no diff. |
| O4 | Inheritance behavior across parent/sub envelopes | LM-134 (already done): MERGE_UNION; sub may add but not remove. |
| O5 | `1password` source — what's the `op://` URI format we expect in `user_config`? | Defer to 1Password CLI docs; we shell out, not parse. |

## Implementation pointers

| Surface | Where | Owner |
|---|---|---|
| Validator | `daemon/src/policy/secrets.rs::validate` (new) | LM-20 |
| Resolver | `daemon/src/runner/secrets.rs::resolve_chain` (new) | LM-20 |
| Source: user_config | parses TOML at `~/.config/clawket/secrets.toml` | LM-20 |
| Source: keyring | `keyring` crate (Rust) | LM-20 |
| Source: env | `std::env::var` at task-spawn | LM-20 |
| Source: 1password | shell out to `op read <uri>` | LM-20 |
| Redaction set | `daemon/src/runner/redact.rs::RedactionSet` (new) | LM-20 |
| Sandbox env builder | `daemon/src/runner/env.rs::build_child_env` (new) | LM-20 |
| Inheritance: MERGE_UNION | `daemon/src/policy/inheritance.rs` | LM-20 (spec at LM-134) |
| CLI: `clawket secret set/get/list` | `cli/src/commands/secret.rs` (new) | M1 (RL-U5-04) |
| Dashboard: secret-presence indicator | "ANTHROPIC_API_KEY: keyring ✓ / env –" | M1 (RL-U7-04) |

## Backwards compatibility

Existing tasks at migration-002 time have `active_envelope_id = NULL`. They run under the **legacy sandbox** (full env inherited from daemon process) — preserved for compat but flagged in dashboard as "legacy (no secret sandbox)". Authors opt in to sandboxing by signing an envelope with `secrets_ref`.

The first envelope sign for a legacy task is a behavior change moment: any tool the task ran that depended on un-declared env vars will break. This is intentional — the upgrade is the point. CLI surfaces a warning before sign:

```
$ clawket task envelope sign TASK-foo
WARNING: signing this envelope enables the secret sandbox.
The task currently uses 12 environment variables not declared in secrets_ref.
Either declare them or run `clawket task envelope sign --legacy-env-passthrough`.
```

`--legacy-env-passthrough` is an escape hatch for migration; it's logged loudly and the dashboard shows a "secret-bleed risk" badge.

## Verification

```sh
# 1. JSON Schema enforces name pattern + lookup_order constraints:
python3 -c "
import json
s = json.load(open('daemon/schemas/envelope-v1.schema.json'))
sr = s['properties']['secrets_ref']
print('item required:', sr['items']['required'])
print('name pattern:', sr['items']['properties']['name']['pattern'])
print('lookup_order:', sr['items']['properties']['lookup_order']['items']['enum'])
"
# Expect: required=['name', 'lookup_order'], pattern=^[A-Z][A-Z0-9_]{0,127}$, enum has 4 sources

# 2. Six rejected alternatives:
grep -cE '^\| [1-6] \|' clawket/docs/adr/0009-secrets-reference.md
# Expect: ≥ 6
```

## Approval

Final approval gated by RL-U2-09 (LM-54). Dogfood pass: assign each of the five failure modes (plaintext, source ambiguity, log leak, bleed, untrackable rotation) a real failing-task example and verify the validator + resolver + sandbox + redaction catch them. The threat model + audit are covered by LM-58 (RL-U2-13). Until those pass, this ADR remains **Proposed**.
