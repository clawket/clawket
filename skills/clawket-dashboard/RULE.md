상태: STABLE — Clawket plugin 정본.

# clawket-dashboard

Deep-reference rules for the dashboard skill. See SKILL.md for the operational interface.

## Scope

This skill is the surface for human + agent task-board interaction in a Clawket-registered cwd. It must never duplicate logic that belongs to the daemon (state transitions, evidence enforcement, cycle exit gate) or to another skill (plan design, scenario authoring, verification rounds).

## Invariants enforced by the skill body

- The `start` flow MUST run both prechecks (cycle is `active`, no other in-progress task in the cycle) before issuing `clawket task update --status in_progress`.
- The `done` flow MUST pass `--evidence`. The daemon rejects `done` transitions with HTTP 400 `EVIDENCE_REQUIRED`; the skill surfaces this expectation up-front.
- The `new` flow MUST pass `--cycle <CYCLE-ID>`. Tasks without a cycle assignment are blocked by the `PreToolUse` hook's `gate.no_cycle_assignment` guard the moment they are started.
- Cycle / plan completion is NEVER auto-cascaded by this skill. When the daemon emits `completion-possible`, the operator runs `clawket cycle update --status completed` (and similarly for the plan) explicitly. This preserves the human review point at the cycle / plan boundary.

## Out of scope

- Plan or Unit creation beyond the `new` task wrapper. Use `clawket-plan-design`.
- Scenario authoring or refinement. Use `clawket-scenario-author` / `clawket-scenario-refine`.
- Verification round orchestration. Use `clawket-verify-loop` / `clawket-verify-batch`.
- Defect resolution workflow. Use `clawket-defect-fix`.

## Locale

This skill respects `CLAWKET_LOCALE` (overrides `LC_ALL` / `LANG`). Accepted values: `en` | `ko` | `ja`. Fallback chain: `ja → ko → en`, `ko → en`.
