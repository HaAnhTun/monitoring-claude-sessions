# 0024 Usage stored per file and per provider message key; per-field max with NULL as missing; owner = oldest file; delta rollups; covering time index for analytics

Status: Proposed (Phase 1, 2026-10-11). Owner: data/API design (`docs/design/03-data-api-realtime.md` sections 3.6, 3.7, 8.2). The
token rules themselves are normative in `02-ingestion-lifecycle.md` 6.2-6.3.

## Context
Claude Code writes one record per content block and repeats `usage`; subagent snapshots grow `output_tokens`; resumed sessions copy
records into new files (`docs/research/transcript-survey.md` section 3). Design 02 fixes the rules: per-file maximum per message key,
global maximum over files, missing values stay missing, owner = the oldest file, synthetic messages counted but not priced. CCAM's stored
totals with "baselines" inflated one session about 11x (`docs/research/ccam-docs-analysis.md` C9). The UI and the CLI need fast session
totals and fast time-window aggregates.

## Decision
- `usage_files (file_id, message_key)` holds the per-file values (nullable numbers, `legacy_*` integers for parity, `finalized`,
  `usage_source`, `synthetic`, counters); `usage (message_key UNIQUE)` holds the instance value: aggregate `max()` over its file rows
  (NULL only when every file misses the field), the owner file chosen by `birth_ms` (else first seen mtime) and path, and the owner
  session and agent.
- Session and agent rollup columns (sums plus per-field missing counts, messages, synthetic, unfinalized) are maintained by deltas in the
  same transaction; an owner change moves the contribution; `verifyRollups()` proves rollup = sum.
- Every time-window aggregate uses `INDEXED BY idx_usage_ts_cover` (`ts, model, session_id, four token columns, finalized, synthetic`);
  per-project aggregation groups by session first.
- Data retention re-runs the owner recompute for message keys that also exist in other sessions' files.

## Consequences
- Totals are idempotent under re-import, file order and resume copies; no baselines.
- Two writes per assistant record during import (both indexed).
- The planner's own choice for per-session aggregates is slower, so the index is named; a missing index fails loudly.

## Alternatives rejected
- One global row per message with first-writer attribution: depends on import order (the importer reads head, tail, backfill).
- Stored per-session totals with high-water baselines (CCAM): fragile under compaction and re-import.
- Summing per file: overcounts 2.4-4.0% on this machine's corpus (resume copies).
- Aggregating `usage_files` at query time: a `GROUP BY message_key` over all rows for every analytics request.

## Evidence
- 2026-10-11, `ddl2-check.mjs` on the final schema: the per-field upsert `coalesce(max(a, b), a, b)` kept NULL as missing; the global
  recompute returned the design-02 worked-example values for msg_C (input 3, output 420, cache read 1000, cache creation 200, finalized,
  2 files) with the older file as owner, through `idx_usage_files_key`; covering-index totals over 50,000 rows in a 7-day window 3.8 ms,
  per model 8.1 ms.
- 2026-10-11, `ddl-bench2.mjs`, `usage-plans*.mjs` on 150,000 rows: 30-day totals 185 ms with a `(ts, model)` index versus 18 ms covering;
  per model 218 -> 40 ms; per session top 20 129-190 ms (planner) versus 15.6 ms forced; per project 216 -> 11.8 ms.
