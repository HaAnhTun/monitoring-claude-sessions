# ADR 0018: Lifecycle as a fact semilattice with priority decision tables

Status: Amended by 0069 (proposed Phase 1 design, 2026-10-11). Answers foundations open question 1. Design reference: section 7.

## Context

D9 requires distinct states (running, working, waiting for input, waiting for tool or child, turn ended, completed, failed,
stale, unknown) with basis, evidence and confidence; Stop is not SessionEnd; subagent ends never complete the parent; missing
events never imply success; out-of-order events never regress terminal states; idempotent transitions; a transition table with
property tests; legacy five states derivable. Inputs arrive from two sources with retries, duplicates, async jitter, downtime
backlogs and backfills read in any order. CCAM's imperative transitions flip on reordering.

## Decision

- Every source is reduced into facts made only of join-semilattice registers (max/min stamps, last-writer-wins by stamp,
  boolean or, pointwise maps) plus per-key rows with the same property (tool calls, turns, agents, workflow runs).
- The visible state is a pure function `derive(facts, rows, now, cfg)` given as a priority-ordered decision table for sessions
  (S-1..S-10), agents (A-1..A-10) and workflow runs (W-1..W-7), returning `{state, presence, waitReason, staleKind, endReason,
  turnOutcome, basis, confidence, ruleId, evidence[], since, nextCheckAt}`.
- Turn boundaries come from synchronous hooks (UserPromptSubmit, Stop/StopFailure) when hooks know the latest boundary, else from
  the transcript; transcript interrupts end turns. Completed/failed come only from SessionEnd (with StopFailure/API error for
  failed), daemon job state, or attempts rows; process-gone (dead pid without SessionEnd) is `stale`, never `completed`.
- Retraction is expressed inside the semilattice: `external.attempt_cleared` writes the value `null` into the `attempt` LWW
  register, stamped by the publication time of the attempts tick (rank 0, below a same-tick republish at rank 1), so a config
  rebuild removes stale COMPLETED/FAILED evidence and a republish in the same or a later tick restores it (design 4.3, 7.3,
  transitions C1-C3). `explainCompletion` (design 7.13) reports a terminal outcome only for an observed basis.
- A sweeper re-derives rows whose `nextCheckAt` passed (stale, abandoned, tool grace) without new events; only changes of the key
  fields are published; evidence wording is rendered at read time.
- Legacy mapping: sessions without hook evidence use an exact port of the legacy classifier (parity); others map the new states
  to RUNNING/IDLE/COMPLETED/FAILED/UNKNOWN.

## Consequences

- Idempotence, order independence and duplicate tolerance hold by construction and are checked by seeded property tests P1-P9.
- Late or replayed events can never regress a terminal state; genuinely later activity after SessionEnd reopens the session only
  with an explicit `activity_after_end` reconciliation record.
- Facts are small; bulky history lives in rows.

## Alternatives rejected

- Imperative `reduce(state, event)` in arrival order (CCAM): order-dependent, needs special cases for late events.
- Full event-log replay per change: correct but O(history) per event.
- Inferring completion from Stop or silence: forbidden by D9 and the brief.

## Evidence

- `docs/research/ccam-source-analysis.md` section 5 (CCAM transitions and their reorder weaknesses).
- `docs/research/claude-code-hooks.md` sections 1, 5, 8 (event order in `-p`, Stop vs SessionEnd, no Stop on interrupt, async
  cancellation; Claude Code 2.1.289, 2026-10-11).
- `docs/research/transcript-survey.md` sections 4.1-4.4 (turn-end markers, pending counts, task-notification statuses,
  interrupt markers, API error shape).
- `docs/research/current-state-backend.md` C.1 (legacy classifier, the parity target).

## Requirements covered

Master brief MEGA-PROMT-V3 sections 6 (all required semantics and rules, transition table, tests for normal/failed/duplicated/missing/delayed/out-of-order inputs), 8.6 (board states from explicit derivation rules), foundations open question 1.

## Open items

OI-4 (prompt_id of background/cron turns; rules compare stamps, not ids), OI-6 (daemon job failure state names). Plans: design `02-ingestion-lifecycle.md` section 12.

## Phase 2+ task slices

I-7 (facts, merges, decision tables, legacy mapping, work items), I-8 (writer integration, sweeper). Slice table: design section 13.
