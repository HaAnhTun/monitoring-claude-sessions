# ADR 0012: Hourly append-only spool segments, offsets in the DB, and a data-free nudge

Status: Proposed (Phase 1 design, 2026-10-11; revised the same day by the Phase 1 reconciliation, issues I-02, I-04, I-29). Design reference: sections 2.7, 2.8, 4.4, 4.6.

## Context

D8 makes the spool the write-ahead log of hook events, drained by the server with offsets in the DB, at-least-once and
idempotent. Many handler processes write concurrently; the server may be stopped; rotation must not race with writers; the
handler must not wait for a slow server.

## Decision

- Segment files `<workspace>/data/spool/hooks-<YYYYMMDD>T<HH>Z.ndjson` named by the UTC hour of `received_at`
  (`SPOOL_SEGMENT_EXT = '.ndjson'`; content is JSON Lines, only the extension avoids `.jsonl`, which the legacy `audit` treats as
  a forbidden transcript copy). Handlers only append,
  one `writeSync` per line on an fd opened with flag `a`; nobody renames or rewrites a segment, so rotation needs no coordination.
- Soft cap 64 MiB per segment (minimal envelopes), hard cap 256 MiB (drop + handler log).
- The server tails segments with the shared `JsonlTailer` (never consumes a partial line) and commits the cursor
  (`spool_cursor`: offset, size, inode, head hash, sealed) in the same transaction as the rows derived from those lines.
  Segments are sealed after hour end + 120 s and deleted 24 h after sealing.
- Dedupe: UNIQUE (`instance_id`, `event_uid`), exact natural keys for events with ids (`tool_use_id`, PostToolBatch id hash,
  `task_id`), and a 2 s content-hash window for the rest.
- After appending, the handler POSTs `{"instanceId"}` to `POST /api/v3/ingest/nudge` and exits on response, flush, error or 300 ms,
  whichever is first. The endpoint carries no data, needs no token, refuses requests with an `Origin` header
  (`403 origin_not_allowed`, codes from the shared `ErrorCode` catalogue of design 03), and only schedules a drain; a 500 ms poll
  makes the nudge an optimization.
- Replay resets cursors in one `withWriteTx` (stopped instance: maintenance DB open; running: control operation through the
  writer queue); the CLI command `mcs ingest replay --task S [--from SEGMENT] [--yes]` belongs to the CLI design.

## Consequences

- No event is lost when the server is down; downtime is visible (`runtime_unavailable` reconciliation from the backlog).
- Replays (`mcs ingest replay`) and crash re-reads are no-ops.
- Latency hook-to-commit is bounded by the nudge path (a few ms of drain) or the 500 ms poll.

## Alternatives rejected

- One spool file rotated by rename: on Windows a rename races with open handles of in-flight handlers.
- One file per event: thousands of files per hour, slow directory scans.
- The `.jsonl` extension (D3's first wording): the legacy `audit`/`doctor` exit 1 for any `*.jsonl` in a workspace, which would
  break the legacy fallback and cutover gate G8.
- POSTing the envelope as the primary path: two delivery paths and authentication would be needed; losses when the server is down.
- A token on the nudge: protects nothing because the request causes no state change beyond reading the instance's own spool.

## Evidence

- E2 `D:/mvp/private/scratch/mcs-v3/ingestion/e2/append-race.mjs`, 2026-10-11, NTFS, Node 24.14.1: 16 concurrent processes,
  lines of 1 KB to 4 MB, 0 torn, 0 lost.
- E1b `e1/bench2.mjs`: exit-on-flush 92 ms median against a hanging server, 15 of 15 nudges received; waiting for the response
  costs 377 ms.
- E8 `e8/zod-sqlite.mjs` (better-sqlite3 13.0.3): replaying 20,000 duplicate `event_uid` rows inserts 0 at 483k rows/s.
- CCAM lost events while its dashboard was down and broadcast before commit: `docs/research/ccam-source-analysis.md` sections 2, 4.
- Critic experiment X1 (`docs/design/99-requirements-matrix.md` section 4), 2026-10-11, Python 3.14.3: legacy
  `viewer.py audit` exits 1 with `data/spool/hooks-20261011T14Z.jsonl` and 0 after renaming it to `.ndjson`; the rule is the
  `.jsonl` check of the audit loop in `src/backend/tasks.py` (re-read 2026-10-11).

## Requirements covered

Master brief MEGA-PROMT-V3 sections 5 (fail safely when monitoring is unavailable, no exactly-once claim, duplicates and out-of-order), 10 item 3 (persist before publish), 12 (request size limits, timeouts).

## Open items

OI-3 (identical stdin bytes for duplicate registrations; entities stay correct either way). Plans: design `02-ingestion-lifecycle.md` section 12.

## Phase 2+ task slices

I-1 (`SPOOL_SEGMENT_EXT`, `spoolSegmentName`), I-2 (spool writer, nudge), I-4 (writer, dedupe, drainer, cursors, retention,
replay engine). Slice table: design section 13.
