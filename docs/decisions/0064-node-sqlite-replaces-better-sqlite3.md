# 0064 `node:sqlite` replaces better-sqlite3 behind the single driver seam

Status: Accepted (V4, 2026-10-18). Owner: platform area (A). Amends 0041 ("native code is limited to better-sqlite3 prebuilds" becomes "no
native production dependency"), 0020 and 0021 (the evidence lines name better-sqlite3 13.0.3; the schema rules are unchanged), 0007 (E11, the
locked addon, no longer applies). Related: 0062, 0063.

## Context
`runtime/packages/engine/src/db/driver.ts` is the only module that imports the SQLite binding (lint rule and a grep test). Owner decision 4:
switch it to Node's built-in `node:sqlite`, remove better-sqlite3 afterwards, suppress the ExperimentalWarning in our processes only.
A native addon cannot be bundled, needs prebuilds for eight platform/libc pairs (about 16.5 MB) and made a running server block `npm ci` on Windows.

## Decision
1. `driver.ts` keeps its public surface (`SqlDriver`, `Stmt`, `SqlValue`, `SqlParams`, `openSqlite`, `toDbError`, `pragmaValue`,
   `pragmaNumber`, `STATEMENT_CACHE_SIZE`, `BUSY_TIMEOUT_MS`); only the inside changes. Callers do not change.
2. **Loading**: `createRequire(import.meta.url)('node:sqlite')` inside a function that swaps `process.emitWarning` for the duration of the
   call and drops only `ExperimentalWarning` messages that start with `SQLite`; everything else is forwarded. Types come from
   `import type { DatabaseSync, StatementSync } from 'node:sqlite'` (`@types/node` 24.19.2 has them). Nothing outside `driver.ts`
   mentions `node:sqlite`; the ESLint `no-restricted-imports` entries and the boundary test move from `better-sqlite3` to `node:sqlite`, and
   `better-sqlite3` stays banned so the dependency cannot come back.
3. **Open**: `new DatabaseSync(path, { readOnly, timeout })` (`timeout` since 22.16). `fileMustExist` has no equivalent (the constructor
   creates the file): for `fileMustExist` and a read-write connection the driver checks `existsSync` first and throws a `DbError` built
   exactly like a `SQLITE_CANTOPEN` failure; a read-only open of a missing file fails natively with `errcode` 14.
4. **Statements**: `prepare(sql)` -> `StatementSync`; `run/get/all` take the positional array spread or the named object (bare names, `@`, `:` and
   `$` prefixed SQL all verified); the LRU cache of 200 and the `Stmt` wrapper stay. `run()` returns `{ changes, lastInsertRowid }` (both numbers). Rows
   are null-prototype objects: the wrapper returns them unchanged unless the whole DB suite shows a caller that needs a plain object. Integers above 2^53
   throw `RangeError ERR_OUT_OF_RANGE` instead of rounding (no column holds one); there are no BLOB columns.
5. **Transactions** (hand written, same contract as before: synchronous callback, refusal of a returned promise with a `TypeError` and rollback):
   outside a transaction `BEGIN DEFERRED|IMMEDIATE` ... `COMMIT`; when `raw.isTransaction` is true `SAVEPOINT mcs_<depth>` ... `RELEASE`; on a throw
   `ROLLBACK` or `ROLLBACK TO` + `RELEASE`, then rethrow the original error; a failing rollback never hides the original error.
6. **Pragmas**: `pragma(text)` = `prepare('PRAGMA ' + text).all()` (a setter answers `[]`, a getter one row, as verified); WAL, the connection pragmas and
   `wal_checkpoint(PASSIVE)` go through it unchanged.
7. **Backup**: `backup(source, dest, { rate: 100, progress })` of `node:sqlite` (since 22.16); `progress` receives `{ totalPages, remainingPages }`
   and returns nothing; the wrapper maps failures through `toDbError`.
8. **Errors**: `node:sqlite` throws `Error` with `code: 'ERR_SQLITE_ERROR'`, numeric `errcode` (the extended result code) and `errstr`; the message
   can name data and is never copied. `toDbError` classifies by `errcode`: primary code `errcode & 0xff` (5 BUSY, 6 LOCKED, 8 READONLY, 10 IOERR,
   11 CORRUPT, 13 FULL, 14 CANTOPEN, 19 CONSTRAINT, 26 NOTADB, everything else `db_io`) and, for 19, the extended code: 275 CHECK, 787 FOREIGNKEY,
   1299 NOTNULL, 1555 PRIMARYKEY, 2067 UNIQUE, 2579 ROWID, 3091 DATATYPE (others `other`). `DbError.sqliteCode` keeps a `SQLITE_*` name derived from the
   code so diagnostics and tests read as before. Errors from `ERR_INVALID_STATE` (closed database) and `ERR_OUT_OF_RANGE` are programming errors and pass through.
9. **Close** is idempotent (the driver tracks it; the native close of a closed database throws); `prepare` after `close` throws.
10. Removal: after the driver work package is verified, the lead removes `better-sqlite3` and `@types/better-sqlite3` from
    `packages/engine/package.json` and the lockfile at an npm barrier. No native production dependency remains.

## Consequences
- The Node floor 22.22.0 contains every API used (verified on 22.23.3): `timeout`, `isTransaction`, `backup`, `readOnly`, named parameters.
- `node:sqlite` is still experimental on Node 22 (stability 1.1) and prints a warning there; on Node 24.22 and 26.12 no warning is printed (verified).
  A future Node change stays inside `driver.ts`; the Docker harness matrix (22, 24, 26; ADR 0065 item 4, ADR 0078) is the early warning.
- The bundled SQLite differs per Node: 3.51.2 (24.14.1), 3.51.3 (22.23.3), 3.53.4 (24.22.0), 3.54.0 (26.12.0). The schema uses only features present in all (STRICT, `json_valid`, WAL).
- Performance is in the same range (see Evidence); the benchmark budgets B1-B7 of the benchmark work package decide.
- `RUNTIME_IN_USE` and the install-time addon problems disappear (0062).

## Alternatives rejected
- Keep better-sqlite3: native prebuilds (16.5 MB, eight platform/libc pairs), cannot be bundled, locked files on Windows during `npm ci`.
- Both drivers behind the seam with a fallback: two code paths to test forever for one platform that has no prebuild.
- `sql.js` (WASM): no WAL, no files on disk without copying whole databases through memory.
- `libsql`/`@libsql/client`: another native package.

## Evidence
- 2026-10-18, probe (planning notes, not published) (about 60 checks) run on Node v24.14.1 (Windows) and in containers: v22.23.3, v24.22.0,
  v26.12.0 (bookworm-slim) and v24.22.0 alpine, plus linux/arm64 emulation for v24.22.0 alpine and v22.23.3 bookworm: identical results except
  the `errcode` of "open a directory" (526 vs 14, same primary code), the key order of `run()` results, the extra exports of Node 24+/26, and the
  warning (present on 22.23.3 and 24.14.1, absent on 24.22.0 and 26.12.0). Verified: error codes above for each constraint kind, `errcode` 5 for a busy
  `BEGIN IMMEDIATE`, 8 for a write on a read-only connection, 26 for a garbage file, `isTransaction`, savepoints, `PRAGMA` getter and setter rows, WAL, `backup`
  (502 pages in 5 steps, a failing destination rejects with `errcode` 14 and leaves the source usable), `close()` twice throws `ERR_INVALID_STATE`.
- Benchmark (100,000 inserts in one transaction, WAL, indexed STRICT table with CHECKs; 20,000 `count(*)` point reads): better-sqlite3 13.0.3 409-467 k inserts/s and
  24 k reads/s; `node:sqlite` 549-576 k inserts/s and 14-15 k reads/s.
- `grep -in blob runtime/packages/engine/migrations/0001_initial.sql` finds no BLOB column.
