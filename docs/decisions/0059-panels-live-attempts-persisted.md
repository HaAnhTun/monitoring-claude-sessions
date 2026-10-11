# ADR 0059: Panel data is sampled live; attempts runs are persisted lifecycle evidence

Status: Proposed (Phase 1, 2026-10-11; amended after the critic review, issues I-07 and I-18). Design reference:
`docs/design/06-panels-parity-platform.md` sections 3.1, 3.4, 3.5, 3.10.

## Context
The legacy engine recomputes every panel on request behind TTL caches. The new runtime has a database (D10) and SSE (D11). Machine, git,
log and ledger values are snapshots with no history value; the attempts table is the only source of COMPLETED/FAILED for top-level
sessions (D9) and the legacy version reads only a 4,000-line tail of the chain log.

## Decision
- Machine, git, ledger, chain-log tail and live-log panels: computed on request (`GET /api/v3/panels/:key`) through per-source
  single-flight, stale-while-revalidate caches with fixed TTLs; never stored in the database, never pushed over SSE; the response carries
  per-source `status` and `sampledAt`.
- Attempts: the chain log is ingested incrementally (02 tailer primitives, byte offsets, identity generations) into design 03's tables
  `attempt_sources` and `attempt_runs` (`0001_initial.sql`, no per-row `instance_id`); rows are matched to sessions by the legacy rule;
  ended rows publish design 02's `external.attempt` event in the same transaction (persist before publish); a config change rebuilds
  the rows and clears published evidence (`external.attempt_cleared`, 02 4.3).
- The events carry `observedAt` = a strictly increasing publication stamp (not the chain-log END time), so the LWW join of 02 7.2
  keeps the latest derivation: a clear never hides re-published evidence, and the latest START wins even when an earlier START ended later.

## Consequences
- No database growth from panel snapshots; no work without clients.
- Attempts history survives restarts and log growth; lifecycle states derived from attempts are reproducible.

## Alternatives rejected
- Persisting machine/git snapshots for charts: no stated need (brief 16: no custom analytics without demonstrated need).
- Computing attempts on request like legacy: loses rows beyond the tail window and makes lifecycle evidence depend on a poll.

## Evidence
Legacy behaviour `panels.py:30-84`, `server.py:30-60`, `current-state-backend.md` C.5; 02 `external.attempt` event and rule S-1
(`02-ingestion-lifecycle.md` 4.3, 7.4); cost measurements E4, E16, E19 (design section 2).

## Requirements covered
Brief 7 (persistence where it matters), 8.1, 10 (no stale UI from cached snapshots: per-source freshness).

## Open items
None owned here; the tables are design 03's (critic I-07) and the clear event design 02's (critic I-18).

## Phase 2+ task slices
PP5, PP7. Slice table: design section 13.
