---
name: clawket-scenario-author
description: Use when authoring atomic user scenarios for a new domain or menu area — produces per-domain spec knowledge in the strict As-a / I-want / So-that + Given/When/Then format. Domain scenario authoring (work-loop entry).
---

# Atomic scenario authoring

Produce per-domain scenario knowledge that captures **intent only** (no code citations, no implementation status). The output feeds `clawket-plan-design`.

## Inputs

At least one of:

- Domain + menu / sub-area (e.g., "Clawket Daemon API", "Chess learning menu").
- Source material: code locations, UI label inventory, business policy.
- An existing scenario knowledge to amend (called by `clawket-scenario-refine`).

## Procedure

### 1. Triage the sources

- Use the current implementation (code + UI labels + menu structure) as the primary clue.
- Old docs are reference only — they may be stale.
- On conflict, the order is: explicit user decision > current implementation > old docs.

### 2. Draft atomic scenarios (strict format)

```
US-<DOMAIN>-<NNN>: <one-line summary>

  As a <actor>
  I want <goal action>
  So that <value being delivered>

  Acceptance
  - Given <state>, When <trigger>, Then <expected outcome>
```

Rules:

- ID prefix must include the domain (e.g., `US-DAEMON-API-001`).
- 1 scenario = 1 testable assertion. Atomic at authoring time (refinement is allowed inside a round).
- A different trigger / different outcome / different precondition / different branch is a separate scenario.
- 50 to several hundred scenarios per menu is normal at pre-design time.

### 3. Forbidden content (must be zero)

- `file:line` citations (scenarios are at the intent level — never reference code).
- Vague phrases ("implemented", "works", "is handled").
- Mentions of known defects / bugs (record only the intended behavior).
- Code snippets.
- Group headers that bundle `As a / I want / So that` once for several scenarios.
- Changelog / change history entries.

### 4. Persist as knowledge

- Location: Clawket knowledge, `type=spec`.
- Granularity: one knowledge per menu / screen / feature.
- Declare a scenario lower bound (refinement may shift the count within a round).
- Title format: `<domain> <sub-area> 시나리오` (e.g., `Daemon API 시나리오`).

```bash
clawket knowledge create --type spec \
  --title "<도메인> <영역> 시나리오" \
  --body "$(cat /path/to/scenarios.md)"
```

### 5. Next step

After authoring, proceed with `clawket-plan-design` to define the Plan + Units.

## Self-check (authoring)

- [ ] Every scenario has the 3-line `As a / I want / So that` + exactly one `Given/When/Then`.
- [ ] If a scenario had 2+ `Given/When/Then` clauses, it has been split.
- [ ] Zero `file:line` citations.
- [ ] Zero phrases like "implemented" / "works" / "is handled".
- [ ] Known bugs are restated as intended behavior (not transcribed from current code).
- [ ] All IDs are unique.
- [ ] No changelog / change-history bleed into the knowledge body.

## Update rules (when called by `clawket-scenario-refine`)

The only legitimate amendment reason is **intent mismatch** (e.g., two assumptions mixed in one scenario, expected outcome contradicts product vision, scenario was deferred). Amendments motivated by time / cost / complexity / code-impact size are **rejected** — register a separate fix plan instead of weakening the scenario.

Three-way disposition for an amendment (see `clawket-scenario-refine` for the full flow):

- **Atomic split** (1 → N): the original ID is permanently retired; new IDs continue the sequence.
- **Intent redefinition**: the ID is kept; only the body changes.
- **Deletion**: the ID is permanently retired; if migrated elsewhere, a new ID is issued.

In all three cases the knowledge body carries **only the current intent** — history goes to the cancelled QA task comment and to the audit knowledge (`type=note, title=scenario_error audit log <domain>`).

## Output

- One knowledge per domain area (or N for larger domains).
- Knowledge IDs.
- Pointer to the next step (`clawket-plan-design`).
