# Vendor Policy & Tier Routing

This document defines Clawket's vendor scope, tier label semantics, and the routing rules that govern which agent tier may execute a given task tier.

## Vendor Scope

### v3 — Claude only

Clawket v3 ships with a **single-vendor adapter** targeting the Anthropic Claude family of models. No other LLM provider is wired in. The adapter is intentionally thin: it maps Clawket's three tier labels to concrete Claude model identifiers and nothing else.

| Tier label | Claude model class | Representative model |
|------------|-------------------|----------------------|
| `low` | Haiku-class (fast, cheap) | `claude-haiku-4-*` |
| `med` | Sonnet-class (balanced) | `claude-sonnet-4-*` |
| `high` | Opus-class (most capable) | `claude-opus-4-*` |

Model identifiers are resolved at runtime from the daemon's configuration. Hardcoded model strings in task metadata are **not** supported — use the tier label; the daemon resolves the concrete model.

### v4+ — Vendor-agnostic adapter (planned)

A vendor-agnostic adapter layer is planned for v4+. The interface will allow alternative providers (OpenAI, Gemini, local models) to register against the same three tier slots. The `components.json` field `"vendor_adapter"` is reserved as a `null` placeholder for this future extension. Do not populate it in v3.

```json
{
  "daemon": "v0.2.4",
  "cli":    "v0.2.6",
  "web":    "v0.1.0",
  "vendor_adapter": null
}
```

## Tier Label Semantics

A **tier label** (`low` / `med` / `high`) expresses the **minimum capability required** to correctly execute a task — not the maximum. The label travels with the task from creation through scheduling and is consulted by the agent spawner when selecting a model.

### low

- Scope: mechanical, well-defined transformations with no ambiguity.
- Examples: rename a symbol, apply a linting fix, generate boilerplate from a template, run a CLI command and capture output.
- Tolerance for error: very low — the task's Done definition is a binary check (type-check passes, diff matches expected).

### med

- Scope: design-level reasoning, multi-file coherence, trade-off evaluation.
- Examples: implement a new feature end-to-end, refactor a module boundary, write a targeted unit test suite, diagnose a structural defect.
- Tolerance for error: medium — the task's Done definition involves judgment (code review criteria, correctness of logic).

### high

- Scope: cross-cutting architectural decisions, ambiguous or novel problem spaces, tasks that require synthesizing large amounts of context.
- Examples: design a new subsystem, evaluate alternative architectures, produce a comprehensive migration plan, resolve a complex cascading failure.
- Tolerance for error: minimal — incorrect output here has broad blast radius.

## Tier Routing Rules

The tier routing rules define which agent tier (model class) may be assigned to a task of a given tier. The invariant is: **an agent must be at least as capable as the task requires**.

| Task tier | Permitted agent tiers | Rationale |
|-----------|----------------------|-----------|
| `low` | `low`, `med`, `high` | A more capable agent can always execute a low-tier task. |
| `med` | `med`, `high` | A low-tier agent risks producing subtly incorrect output on design-level tasks. |
| `high` | `high` only | Architectural tasks require the full reasoning budget; downgrading is prohibited. |

### Enforcement

In v3 the routing rules are **advisory** — the daemon validates the tier assignment and emits a warning if a `high`-tier task is assigned to a `low`-tier agent, but does not hard-block. Schema-level enforcement (reject assignments that violate routing) is planned for v4+ alongside the vendor-agnostic adapter.

### Overriding tier

A task's tier may be overridden by the user or a supervising agent with an explicit `--tier` flag. Override events are recorded in the `activity_log` table with `event_type = "task.tier_override"` so they remain auditable.

## Relationship to PDD (Plan-Driven Development)

When operating under the PDD workflow (`~/.claude/rules/pdd.md`), the tier label is set at Task creation time as part of the Task Quality Criteria (T6 — `code | test | doc | config | review | infra`). The combination of category label + tier label gives the scheduler enough signal to route the task to the right agent without human intervention for routine tasks.

## Changelog

| Version | Change |
|---------|--------|
| v3.0 | Initial Vendor Policy: Claude-only, three tier labels, advisory routing |
| v4.0 (planned) | Vendor-agnostic adapter, hard routing enforcement |
