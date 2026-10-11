# ADR 0052: Transcript change detection: stat polling is the truth, recursive fs.watch is only a hint

Status: Proposed (Phase 1, 2026-10-11). Design reference: `docs/design/06-panels-parity-platform.md` section 4.4; scheduler in
`docs/design/02-ingestion-lifecycle.md` 5.4 (ADR 0015).

## Context
Low latency suggests `fs.watch`; correctness needs every append. On Windows, change notifications depend on how the writer writes.

## Decision
- Design 02's `ImportScheduler` polls (`statTick` 1000 ms, discovery 5000 ms); that polling alone must keep the data correct.
- `engine/src/platform/watch-hint.ts` `createWatchHint(root, onHint, { debounceMs: 100 })`: one recursive, non-persistent watcher per
  transcripts root; an event marks the path for the next slice (and discovery for unknown paths). On error: close, count, retry after
  60 s, health `ingest.watchHint = 'off'`. Disabled for UNC roots, `MCS_FS_WATCH=0`, Linux `ENOSPC`.

## Consequences
- Worst-case latency is the poll interval when hints fail; typical latency is about 100 ms for current Claude Code writes.
- No correctness test may depend on a watch event.

## Alternatives rejected
- Watch-only ingestion: misses appends through an open handle (E7) until the writer closes.
- Polling only: correct but adds up to 1 s latency; the hint is cheap.

## Evidence
2026-10-11, Node 24.14.1, NTFS: `fswatch-append.mjs` (E7: open-append-close writer 20/20 events; one-handle writer 0/20 events until
close; `statSync().size` correct 20/20), `fswatch-live.mjs` (E8: 4 growing live transcripts, watch events 6/4/12/5 vs size changes 5/4/10/4).

## Requirements covered
Brief 5 (transcript import of changing files), 10 (freshness), 12 (reliability).

## Open items
None (Linux/macOS watcher behaviour UNVERIFIED; correctness does not depend on it).

## Phase 2+ task slices
PP1 (`watch-hint.ts`); 02's I-8 consumes it. Slice table: design section 13.
