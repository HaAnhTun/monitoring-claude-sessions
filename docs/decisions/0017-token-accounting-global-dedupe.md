# ADR 0017: Token accounting: per-file max, global dedupe by message id, explicit missing and lower bounds

Status: Proposed (Phase 1 design, 2026-10-11). Version-sensitive (transcript format of Claude Code 2.1.270-2.1.296).
Design reference: section 6.

## Context

One API message is written as several records with the same `message.id`; subagent files grow only `output_tokens` and 38-53% of
their ids never get a final record; 2 ids had zeroed top-level usage with real numbers in `iterations[0]`; resumed sessions copy
earlier records into a new file (808 ids in two files); summing per file over-counts by 2.4-4.0%. The legacy engine dedupes per
file with a per-field max. Hooks carry no usage (D8).

## Decision

- Store per (file, message key) the per-field max of the effective values (top-level, or `iterations[0]` when the four top-level
  fields are all zero/missing and it has a positive value) plus the legacy top-level values, `finalized`, `usage_source`,
  `synthetic`, timestamps.
- Count each message key once per instance (per-field max across files); attribute it to the file created first
  (birth time, else first-seen mtime, then path).
- Report per field `sum` and `missing` (messages without a valid value); zero is a value. Flag `outputIsLowerBound` when any counted
  message is not finalized and `complete: false` while any file is not fully scanned.
- Cache read and cache creation (5m/1h) separate; thinking is part of output; `<synthetic>` messages counted (legacy turns) but
  excluded from model breakdowns. `cost-state` is kept as supplementary provider-reported data, never summed.
- A legacy projection reproduces the Python per-file numbers for parity tests.

## Consequences

- New totals differ from the legacy engine exactly by the iterations fallback and by excluding resume copies (documented,
  worked example in design 6.4).
- Re-import, replays and resets are idempotent (upsert-max, keyed rows).
- No double counting between hooks and transcripts is possible (hooks contribute zero).

## Alternatives rejected

- Per-file sums (legacy): over-counts resumed sessions.
- `cost-state` as the source: it is cumulative per process and includes calls absent from transcripts (inputs off by orders of
  magnitude in some sessions).
- CCAM's baseline/high-water scheme: preserves past over-counts forever.

## Evidence

- `docs/research/transcript-survey.md` sections 3.1-3.6 (snapshot 2026-10-11 06:41:56Z; methods A and B agree to the token on 5
  sessions; corpus over-count percentages).
- `docs/research/current-state-backend.md` C.3 (legacy rule), `ccam-source-analysis.md` section 6 (issue #293 inflation).

## Requirements covered

Master brief MEGA-PROMT-V3 sections 8.7 (source and schema of usage, compaction and cumulative usage, no duplicate accounting, missing vs zero, estimated vs provider cost, no hook/transcript double counting), 4 (token isolation per instance).

## Open items

OI-9 (file birth time on Linux/macOS; falls back to first-seen mtime). Plans: design `02-ingestion-lifecycle.md` section 12.

## Phase 2+ task slices

I-6 (token accounting and legacy projection). Slice table: design section 13.
