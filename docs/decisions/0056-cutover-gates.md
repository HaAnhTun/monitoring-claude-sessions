# ADR 0056: Cutover gates before the Node engine becomes primary; Python stays the documented fallback

Status: Proposed (Phase 1, 2026-10-11). Design reference: `docs/design/06-panels-parity-platform.md` section 5.9.

## Context
A live monitor runs on the legacy engine and SKILL.md tells agents to call `template/viewer.py`. The brief requires a fallback until the
new runtime passes the regression checks, and never claiming checks that did not run.

## Decision
SKILL.md may name the Node engine primary only when gates G1-G10 all hold, each with a recorded run in the migration report:
G1 parity suites and `capture_golden.py --check` clean; G2 three live shadow comparisons (`npm run parity:shadow`) at least 1 h apart,
one during a running chain step and one after an ended step, `unexplained == 0`; G3 lifecycle table and property tests; G4 E2E list of
brief section 14; G5 budgets B1-B7; G6 two-instance isolation and temp-only hook installer tests; G7 rollback rehearsal on a copy of a
real workspace (legacy starts on it, shared files byte-identical) in under 2 minutes; G8 every existing task opens in Node with
`config.json`, `task.json`, `audit/*` byte-identical; G9 docs; G10 explicit owner approval in a user message.
After cutover, SKILL.md keeps a "Fallback: legacy Python engine" section; the legacy code stays unchanged for at least one minor runtime
release and 30 days without a rollback; removing it needs a new ADR.

## Consequences
- The switch is reversible per task at any time (`$MCS stop` then `viewer.py start`).
- Agents cannot flip the primary engine on their own.

## Alternatives rejected
- Cut over when unit tests pass: misses real-data drift (shadow) and rollback safety.
- Remove the Python engine at cutover: no fallback while the new runtime is young.

## Evidence
Foundations C1, C5, D3 (`config.json` stays legacy-valid); `current-state-backend.md` F.4-F.5 (cross-engine `state.json` risks);
E12 (legacy read-only capture feasible); shadow tool design (5.6).

## Requirements covered
Brief 13 Phase 6 ("maintain a fallback path until the new runtime passes the required regression checks"), 17, 18.

## Open items
None.

## Phase 2+ task slices
PP9 (shadow), PP10 (benchmarks), PP11 (docs). Slice table: design section 13.
