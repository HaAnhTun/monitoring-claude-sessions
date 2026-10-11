# 0023 No FTS5 in v3.0: bounded block-prefilter scan of transcripts with a coverage report

Status: Proposed (Phase 1, 2026-10-11). Owner: data/API design (`docs/design/03-data-api-realtime.md` sections 7.4, 7.5).

## Context
D10 says "FTS5 only if transcript search needs it (decide with evidence)". Brief 8.5 requires transcript search separate from metadata
search, pagination, limits, cancellation, and never claiming "entire transcript" unless true. ADR 0022 keeps text out of the DB.

## Decision
- Transcript content search scans the transcript files block by block (blocks = ranges between entry checkpoints), tests a
  case-insensitive prefilter regex on each block (the needle as it appears inside a JSON string, raw UTF-8 or `\uXXXX`-escaped), parses
  only blocks with a hit, and verifies matches with the legacy semantics.
- Bounded by a time budget (default 3 s, max 10 s), a match limit, at most 2 concurrent searches (`429 search_busy`), and client abort.
- Every response carries `SearchCoverage` (files and bytes in scope and scanned, missing/unreadable files, bytes not yet imported,
  `complete`, `stoppedBy`, a plain-English note).
- No FTS5 table.

## Consequences
- No copy of private text in the DB; no indexing cost on the write path.
- Searches over very large instances can end with `stoppedBy: 'time_budget'` and offer a continuation.
- Revisit when more than 10% of searches hit the time budget, or when search over transcripts already deleted by Claude Code is
  wanted (that needs stored content: new privacy profile, ADR 0022).

## Alternatives rejected
- FTS5 `unicode61`: token search does not reproduce the legacy substring semantics; still copies all text (1.54x the text size).
- FTS5 `trigram`: substring capable but 4.28x the text size and 5.3 MB/s indexing.
- Worker thread for the scan: per-chunk CPU is already at most 7 ms on 1 MiB reads, so async chunks keep the event loop responsive.

## Evidence
- 2026-10-11, `D:/mvp/private/scratch/mcs-v3/data-api/search-bench.mjs`, SQLite 3.53.4 (FTS5 compiled in), Node 24.14.1, synthetic
  text: 29 MB in 40,000 rows -> `unicode61` 44.6 MB, build 1.2 s (24 MB/s), queries 0.02-1.2 ms; `trigram` 124.4 MB, build 5.5 s
  (5.3 MB/s), queries <= 0.1 ms. Scan of 120 MB synthetic JSONL, warm cache: 950-1065 MB/s without matches, 521 MB/s with matches in
  70% of lines, max 4.5-7 ms per 1 MiB chunk; U+0110/U+0111 matched case-insensitively; raw byte `indexOf` 3170 MB/s.
- Cold-cache throughput: UNVERIFIED (plan in the design doc, open item O-1).
