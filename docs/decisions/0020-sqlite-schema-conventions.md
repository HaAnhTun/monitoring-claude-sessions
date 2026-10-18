# 0020 SQLite schema conventions: STRICT tables, epoch-ms time, owner-only foreign keys, enum CHECK policy, incremental auto-vacuum

Status: Amended by 0064 (proposed Phase 1, 2026-10-11). Owner: data/API design (`docs/design/03-data-api-realtime.md` sections 3.2-3.5).

## Context
D10 fixes SQLite in WAL mode with foreign keys, one writer per instance and epoch-ms timestamps. The schema must be safe (constraints
that catch bad writes), fast to write during bulk transcript imports, and cheap to evolve. Measurements were needed for index and
constraint costs on this machine.

## Decision
- All tables `STRICT`; booleans `INTEGER CHECK (x IN (0,1))`; timestamps `INTEGER` epoch ms UTC; JSON columns `TEXT` with
  `json_valid()` and a length cap; text columns length-checked.
- Small, stable enums (lifecycle and board states, statuses) use `CHECK ... IN (...)`; the high-volume `events.kind` has a format check
  only (`<domain>.<verb>`) and its value set is validated in code, so a new event kind never rebuilds the largest table.
- Hard foreign keys only to owners (`sessions(id) ON DELETE CASCADE`, `projects`, `work_items`); all other cross-row references are soft
  integer ids checked by the repository. Every FK child column leads an index.
- Pragmas: `journal_mode = WAL` (writer only, with BUSY retry 20 x 25 ms), `synchronous = NORMAL`, `foreign_keys = ON`,
  `temp_store = MEMORY`, `cache_size = -16000`, `journal_size_limit = 64 MiB`; `auto_vacuum = INCREMENTAL` on new files;
  `application_id = 1296253747` ("MCS3").
- Entities observed by clients carry `updated_seq` (events: `change_seq`) from the change log (ADR 0025).
- No per-row `instance_id` column: one database file per instance, identity checked at open and per repository call (design 03 C-1).
  The same holds for tables proposed by other designs, such as the chain-log attempts tables `attempt_sources`/`attempt_runs` of design
  06, which `0001_initial.sql` stores without it (revision 2, critic issue I-07).

## Consequences
- Bad writes fail at the DB (verified probes), not silently.
- `synchronous = NORMAL` can lose the last transactions on power loss; they are re-derived from the spool and transcript offsets.
- Space freed by cleanup is returned with `PRAGMA incremental_vacuum` without a full `VACUUM`.
- Soft references can dangle after cleanup; readers use `LEFT JOIN` and treat a missing row as absent.

## Alternatives rejected
- Non-STRICT tables: silently accept wrong types (`'yesterday'` in an INTEGER column).
- Foreign keys on every reference: each child column needs an index for cascades; secondary indexes are the dominant insert cost.
- `CHECK IN` on `events.kind`: every new hook event kind would need a rebuild of the biggest table.
- ISO text timestamps in the DB: larger, slower comparisons; D10 fixes epoch ms.

## Evidence
- better-sqlite3 13.0.3 / SQLite 3.53.4, Node 24.14.1, 2026-10-11, `D:/mvp/private/scratch/mcs-v3/data-api/`:
  `ddl-bench.mjs` (11 constraint probes rejected: CHECK, FOREIGNKEY, DATATYPE, UNIQUE), `insert-profile.mjs` (file DB with all event
  indexes about 30k rows/s, without secondary indexes 162k rows/s, without CHECK constraints 30.7k rows/s: CHECKs cost nothing
  measurable; `cache_size` 64 MiB no gain), `final-ddl-check.mjs` (`auto_vacuum = 2`; 21 MB freed by 3 `incremental_vacuum(2000)` steps
  in 74-76 ms), `verify-doc-ddl.mjs` (every FK child column indexed).
- `PRAGMA compile_options` of the bundled SQLite: `DEFAULT_FOREIGN_KEYS`, `DEFAULT_WAL_SYNCHRONOUS=1`, `OMIT_PROGRESS_CALLBACK`.
- Revision 2, 2026-10-11, `rev2/ddl3-check.mjs`: the final `0001` (28 tables, 52 indexes) executes, FK check empty, 19 of 19 probes on
  the attempts tables, the `.ndjson` spool segment rule and the `attempt` change kind behave.
- Final schema (aligned with design 02's entities), `ddl2-check.mjs` 2026-10-11: 28 tables, 47 indexes, empty `foreign_key_check`, every
  FK child column indexed, 10 constraint probes behave; event inserts with nine indexes about 16,000 rows/s (500-row transactions).
- Cold-start WAL race: `docs/research/stack-versions.md` section 2.2.
