# 0028 Export `mcs.export/1` (metadata by default, opt-in content) from a consistent snapshot; `backupDb`; automatic bookkeeping retention; data retention only through the CLI

Status: Proposed (Phase 1, 2026-10-11). Owner: data/API design (`docs/design/03-data-api-realtime.md` sections 3.8, 4.4, 11). The
commands, backup folders, manifests, restore and confirmations belong to `01-instances-config-ops.md` 5.5 and 6.4.

## Context
Brief 7 and 8.10 require explicit export, backup, retention and cleanup; destructive cleanup needs clear scope and confirmation and must
never touch another instance. CCAM's export is capped at 25 MiB and its clear-data has no server-side confirmation
(`docs/research/ccam-source-analysis.md` section 10). Design 01 asked for `backupDb(src, dest)`, `applyRetention(db, policy, {dryRun})`
and the export format with an `--include-content` option.

## Decision
- Export `mcs.export/1`: streamed JSONL (header, typed records using the API schemas, trailer with counts and sha256), metadata only by
  default; `includeContent` adds transcript display entries for files still on disk, is never default and is refused with `strict`
  redaction. With a running server the route exports from an online-backup copy in `data/exports/.tmp-*`, so the export is a consistent
  snapshot; no size cap; no import in v3.
- `backupDb(src, dest)`: SQLite online backup API from the server's writer or from a read-only connection, followed by `quick_check`,
  identity and schema checks of the copy.
- Automatic retention in the server touches only bookkeeping (change log, ingest error rows, resolved alerts, instance reconciliations,
  orphan rows of retired files).
- `applyRetention(db, ctx, policy, { dryRun })` deletes old sessions and/or old timeline rows only when design 01's `cleanup --scope
  data` runs it on a stopped instance after its backup; active and pinned sessions are never eligible; transcript file rows stay as
  `retired` tombstones so nothing is re-imported; messages shared with remaining files are re-owned.

## Consequences
- No server API accepts a path; all files stay inside the instance folder.
- An export with content is clearly marked as confidential in its header.
- Export from a backup copy costs temporary disk equal to the DB size.

## Alternatives rejected
- `VACUUM INTO` for backups: similar speed but one long read transaction.
- JSON single-document export: not streamable, needs a size cap.
- Automatic deletion of session data by the server: destructive without the CLI's dry run and confirmation.

## Evidence
- 2026-10-11, `ddl-bench.mjs` on a 196 MB DB: online backup 581 ms, `VACUUM INTO` 640 ms, `quick_check` 988 ms, `integrity_check`
  7,623 ms; cascade delete of 50 sessions (about 10k events) 1.1 s in one transaction (hence batches of 10); `final-ddl-check.mjs`:
  incremental vacuum reclaimed 21 MB in 74-76 ms; `ddl2-check.mjs`: backup of a 38.9 MB DB from a read-only connection 124 ms, copy
  `quick_check ok`.
