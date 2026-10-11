# ADR 0015: Transcript tailer identity rules and main-thread time-sliced scheduling

Status: Proposed (Phase 1 design, 2026-10-11). Answers foundations open question 4. Design reference: sections 5.3-5.5.

## Context

Transcripts are append-only JSONL up to 70 MB, lines up to 1.3 MB, written while being read. The legacy reader uses two cursors
(tail window first, usage from byte 0 within a time budget) and threads; Node is single-threaded, and a synchronous 4 MiB parse
loop would stall HTTP and SSE (current-state F.6). CCAM loses a torn last line and misses rewrites that grow the file.

## Decision

- One `JsonlTailer` for transcripts and the spool. Identity = decimal string of `stat({bigint:true}).ino` + sha256 of the first
  (up to) 256 bytes; reset when the inode changes, the head hash changes, or the size drops below a consumed cursor. On reset,
  the file's per-file rows are recomputed; lifecycle facts are not rolled back.
- Lines are split on byte 0x0A before decoding (no UTF-8 split), one trailing CR stripped, a BOM at offset 0 stripped, empty
  lines skipped, invalid UTF-8 counted. An unterminated tail is never consumed, except (transcripts only, legacy parity) when it
  already parses as a complete JSON object. Lines above 64 MiB are skipped and counted.
- Cursors persisted per file in the same transaction as derived rows: `head_end` (401 lines / 16 MiB), `tail_start` (last 8 MiB),
  `tail_offset` (follows growth), `backfill_offset` (fills `[head_end, tail_start)`, skipped above 512 MiB). Order: head, tail,
  backfill.
- Parsing runs on the main thread: async reads of 1 MiB chunks, cooperative 20 ms slices with `setImmediate` yields, priorities
  spool > tail > head > backfill, backfill limited to 25% of wall time. No worker thread until production health shows an
  event-loop delay p99 above 50 ms.

## Consequences

- Newest state appears first; history and exact usage fill in behind it. Usage max-merge and the fact semilattice make the
  reading order irrelevant to results.
- Event-loop stalls are bounded by one slice plus one line's parse (measured max 13 ms on real files).
- 64-bit inodes must be stored as strings (Number would lose precision).

## Alternatives rejected

- Worker thread pool now: serialization overhead and complexity without a measured need.
- Line reader via `readline`: no control of byte offsets for persisted cursors, decodes before splitting.
- Full re-read on every change (no persisted cursor, CCAM after restart): re-parses tens of MB per restart.

## Evidence

- E3 `D:/mvp/private/scratch/mcs-v3/ingestion/e3/{gen,tailer}.mjs`, 2026-10-11, Node 24.14.1: synthetic 100 MB, 315-404 MB/s,
  JSON.parse 555 MB/s, partial tail of 88 bytes kept, event-loop delay max 3.0 / 4.9 / 12.1 ms for 256 KiB / 1 MiB / 4 MiB chunks.
- E4 same script on the three largest real transcripts (66.8, 31, 22.7 MB): 243-371 MB/s, delay max 4.4-13.3 ms, 0 invalid lines.
- E5 `e5/identity.mjs`, NTFS: append and truncate keep the inode; replace-by-rename, copy, delete-recreate change it.
- `docs/research/transcript-survey.md` section 5 (append-only, line and file sizes), `current-state-backend.md` C.2 (legacy rules),
  `ccam-source-analysis.md` section 13 (torn-line loss reproduced).

## Requirements covered

Master brief MEGA-PROMT-V3 sections 5 (transcript import: large files, growth while reading, incomplete final lines, truncation/rotation/identity changes, UTF-8, offsets, recovery, bounded caches, freshness), 12 (malformed JSONL never crashes), foundations open question 4.

## Open items

OI-8 (worker-thread need, measured by health in real use). Plans: design `02-ingestion-lifecycle.md` section 12.

## Phase 2+ task slices

I-3 (tailer), I-8 (scheduler, importer). Slice table: design section 13.
