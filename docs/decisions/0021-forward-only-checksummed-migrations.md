# 0021 Forward-only, checksummed SQL migrations, applied explicitly after a verified backup; a newer DB is refused

Status: Proposed (Phase 1, 2026-10-11). Owner: data/API design (`docs/design/03-data-api-realtime.md` section 4). Consumers:
`01-instances-config-ops.md` 4.4, 4.7, 5.4.

## Context
D10 requires numbered migrations with checksums and an automatic backup before any migration; D13 requires explicit upgrades and refusal
of a DB newer than the runtime. CCAM's ad-hoc `ALTER TABLE` migrations at import time were hard to test
(`docs/research/ccam-source-analysis.md` section 7). The upgrade command, its backup folder and its audit entry belong to design 01.

## Decision
- Plain SQL files `runtime/packages/engine/migrations/NNNN_name.sql` shipped next to `dist/`; header `-- mcs:migration version=N
  name=x`; optional `-- mcs:foreign_keys=off` for table rebuilds.
- Checksum = sha256 of the text with BOM removed and CRLF converted to LF; stored in `schema_migrations` (created by the runner);
  `PRAGMA user_version` mirrors the latest version.
- Functions for design 01: `peekDbSchemaVersion(path)` (no lock), `planDbMigrations(path)`, `migrateDb(path, { backupDone, ... })`;
  `openInstanceDb({ mode })` with the exit mapping identity 11, newer 15, older 16, other 14.
- Refusals: checksum mismatch, unknown or gapped versions, `db_newer_than_runtime` (file untouched), `backup_required` when a non-empty DB
  would be migrated without the caller's backup. The server creates a new DB at the latest version but never migrates an existing one.
- Each migration runs in its own `BEGIN IMMEDIATE` transaction with `PRAGMA foreign_key_check`; `foreign_keys = OFF` is set outside the
  transaction when a file asks for it.
- Forward-only: no down migrations; the pre-upgrade backup plus `mcs backup restore` (design 01) is the rollback path.

## Consequences
- A failed migration leaves the DB at the last good version and a backup on disk.
- Editing a shipped migration is detected, never auto-repaired.
- Every released schema version gets a fixture DB and a table-driven upgrade test.

## Alternatives rejected
- Auto-migrate on server start: conflicts with D13 and hides schema changes from the operator.
- Down migrations: rarely tested, risky with data; a verified backup is exact.
- Migrations as TypeScript string modules: hides the DDL from review tools; shipping `.sql` files costs nothing here.
- `user_version` alone: no checksums, no history.

## Evidence
- 2026-10-11, better-sqlite3 13.0.3 / SQLite 3.53.4 (`D:/mvp/private/scratch/mcs-v3/data-api/`): `ddl2-check.mjs` applied the bootstrap
  table and the final `0001_initial.sql` in one transaction in 9.4 ms with an empty `foreign_key_check`; `ddl-bench.mjs` online backup of
  a 196 MB DB 581 ms, `quick_check` 988 ms.
- `PRAGMA foreign_keys = OFF` inside `BEGIN ... COMMIT` was ignored (value stayed 1) and took effect outside a transaction (value 0):
  `node -e` probe, same date and versions.
