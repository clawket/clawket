---
name: clawket-plan-design
description: Use when designing a Clawket Plan + Units from authored scenarios — pins the Done proposition, decomposes scenarios into Units, declares the Unit dependency graph, and sets the convergence condition before any work begins. The work loop's Plan + Unit pre-design entry point.
---

# Plan + Unit pre-design

Take the scenario knowledge produced by `clawket-scenario-author` and pin the Plan / Unit skeleton in Clawket before any task is created.

## Inputs

- Scenario knowledge per domain (from `clawket-scenario-author`).
- Project ID (`clawket project list`).
- Domain name (used for the Plan title).

## Procedure

### 1. Pin the Plan identity (8 mandatory body sections)

```
clawket plan create --project <PROJECT_ID> --description "<body>" "<TITLE>"
```

Plan body must contain these 8 sections, in order:

1. **Title** — a single noun phrase capturing the essence of the deliverable.
2. **Done definition** — an externally-verifiable proposition (NOT "implementation complete"). Must include the convergence condition from §6.
3. **Unit decomposition** — every scenario reduces to exactly one Unit.
4. **Per-Unit scenario lower bound + sub-area** — each Unit declares how many scenarios it carries (lower bound, may evolve within a round) and its sub-area.
5. **Unit dependency graph** — sequential vs. parallel, with explicit dependency IDs (or "independent").
6. **Convergence condition** — `defect = 0` AND `scenario_error = 0` AND two consecutive rounds satisfy both.
7. **Rollback trigger** — the condition that flips the Plan to `blocked` (e.g., regression detected, dependency removed).
8. **Single source of truth** — Plan ID + the knowledge mirror location (where the authoritative scenario knowledge lives).

### 2. Decompose into Units

```
clawket unit create --plan <PLAN_ID> --idx <N> --mode <sequential|parallel> --goal "<GOAL>" "<TITLE>"
```

Each Unit:

1. **Title** — `<domain> <sub-area>` (e.g., `QA-Daemon API`).
2. **Scenario count** — must match the scenario knowledge (lower bound; can shift during round refinement).
3. **Dependency** — IDs of other Units this one depends on, or "independent".
4. **Mode** — `sequential` (run in order) | `parallel` (sub-agent dispatch allowed).

### 3. Approve the Plan (draft → active)

```
clawket plan approve <PLAN_ID>
```

Tasks cannot be started until the Plan is `active`. Only one Plan may be `active` per project (transition window may briefly hold two — flip the predecessor to `completed` or `draft` first).

### 4. Validation checklist

- [ ] Plan title is a single noun phrase.
- [ ] Done definition is an externally-verifiable proposition AND includes the convergence condition.
- [ ] Every scenario reduces to exactly one Unit.
- [ ] Unit count ≤ 12 (exceptions must be justified in the Plan body).
- [ ] Only one active Plan in the project (or ≤ 2 during a transition).

### 5. Next step

After approval, proceed with `clawket-verify-loop` to dispatch Round 1.

## Anti-patterns (reject immediately)

If you find any of these during plan design, stop and reshape the Plan:

- **Review / analyze / investigate task** lacking an executable verb → re-state as a deliverable verb phrase, or push back to the Plan layer.
- **"Flexibly / as needed / to be refined later"** → indecision; force a decision now.
- **Task that cannot be traced to a scenario ID** → out of spec; either author the scenario first or drop the task.
- **Done = "implementation complete"** (self-referential) → restate as an externally-verifiable proposition.
- **Convergence condition missing** → re-decompose the Plan body.
- **Time-based exit** ("after two weeks") → restate in terms of deliverables.

## Autonomous-run boundary

When this skill is invoked by an autonomous loop, the following are forbidden:

- Writing to user-data paths (`~/.local/share/clawket`, `~/.cache/clawket`, `~/.config/clawket`, `~/.local/state/clawket`, `~/.claude/plugins/clawket-*`).
- DB DROP / DELETE / TRUNCATE.
- `git reset` / `commit` / `push` / `tag` / `release`.

## Output

- Plan ID.
- Unit ID list + `idx` mapping.
- Pointer to the next step (`clawket-verify-loop`).
