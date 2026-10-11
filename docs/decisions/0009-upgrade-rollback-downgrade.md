# 0009 Explicit upgrades with backup first; start never migrates an existing DB; downgrade refusal rules

Status: Proposed (Phase 1, 2026-10-11). Owner: instances/config/ops design (`docs/design/01-instances-config-ops.md` sections 5.4-5.7).

## Context
D13: upgrades are explicit (backup, DB migrations, audit), config and audit are never rewritten, a DB newer than the runtime is
refused. D10: automatic backup before any migration. The legacy rule: no silent migration of configs. Users run several instances; the
owner hands off long unattended runs and needs predictable recovery.

## Decision
- `mcs upgrade --task S [--dry-run] [--yes] [--restart]`: version gates, plan, backup (`data/backups/<UTC>-upgrade/` with a sha256
  manifest), DB migrations (data design), file migrations (registry, empty in v1), `instance.json` version stamp, audit entry. A
  failure after the backup restores the DB from it. `mcs db migrate` is the DB-only subset (brief section 3 "run database migrations").
- `start` creates a new DB at the current schema but refuses an existing older DB (`DB_UPGRADE_REQUIRED`, exit 16) and a newer one
  (`DB_NEWER_THAN_RUNTIME`, exit 15).
- Backups of a running instance are made by the server over the control channel (it owns the writer connection); of a stopped one by
  the CLI with a read-only connection. Restore requires a stopped instance, verifies manifest, sha256 and `instanceId`, makes a
  pre-restore backup, removes stale `-wal`/`-shm` before swapping the DB, and never restores `config.json`, `task.json` or audit.
- Recovery of a corrupt or unwanted DB is `mcs db rebuild --task S --yes --confirm S` (revision 2, critic issue I-12): stopped instance
  only, the DB files are moved (no SQLite open) into a `db-rebuild` backup with `dbCopy: 'raw'`, `instance.json.dbSchemaVersion` = 0,
  audited; the next start creates a new DB and re-imports. `backup restore` of such a backup also restores its `-wal` file.
- Downgrade: higher DB or file schema -> refuse; higher `instance.json.runtimeVersion` with supported schemas -> run with a warning,
  but `upgrade` refuses (`DOWNGRADE_REFUSED`). Rollback = engine fallback to legacy, or older skill commit + restore of the pre-upgrade
  backup (manifest schema stays at 1).

## Consequences
- After a skill update with new migrations, `restart` fails with a clear hint until `upgrade` runs (one explicit, audited step).
- Every upgrade leaves a restorable backup; backups are pruned by `backup.keep` but the newest upgrade backup is kept.

## Alternatives rejected
- Automatic migration at server start: silent, unaudited, and a failed migration would take the instance down unattended.
- Migrating `config.json` in place to new versions: the legacy engine would refuse it (breaks coexistence and rollback).
- Restoring user-owned files from backups: could silently undo audited configuration changes.

## Evidence
- Foundations D10, D13 (`docs/design/00-foundations.md`), legacy schema gate `src/backend/config.py:122-127`, read 2026-10-11.
- `D:/mvp/private/scratch/mcs-v3/instances-ops/e5`: replace-by-rename needs retries on Windows (EPERM while a reader holds the file),
  applied to the DB swap in restore.
