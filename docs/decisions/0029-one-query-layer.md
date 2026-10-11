# 0029 One engine query layer for API routes, stream hydration and the CLI readers

Status: Proposed (Phase 1, 2026-10-11). Owner: data/API design (`docs/design/03-data-api-realtime.md` section 12). Consumer:
`01-instances-config-ops.md` 6.1 (`InstanceReader`).

## Context
Brief 11: do not duplicate business logic in the API, CLI and UI. D10: one writer (the server); the CLI opens the DB only while no server
runs. Design 01 defines an `InstanceReader` with an `ApiReader` (server running) and a `DbReader` (stopped) that must return identical
results. The stream must send the same entity shapes as the REST routes.

## Decision
- `createQueries(db, deps)` in `packages/engine/src/query` returns every read function (`listSessions`, `getSession`, `listEvents`,
  `usage`, transcript window and search, health, ...). Server routes, SSE frame hydration and the CLI `DbReader` call these functions;
  repositories are reachable only inside the engine (ESLint `no-restricted-imports`).
- Query input types are the parsed outputs of the route Zod schemas, so the CLI builds them from flags with the same schemas; outputs are
  validated with the same response schemas.
- The `ApiReader` calls the routes of the shared registry; the `DbReader` calls the functions; a contract test compares both on one
  fixture.

## Consequences
- One implementation per question and one shape per entity across API, stream, CLI and export.
- The read-only CLI cannot write the transcript entry index, so it computes that index in memory for the call.

## Alternatives rejected
- CLI always reads the DB directly, also while the server runs: two connections and two code paths for no gain, and design 01 forbids
  opening a running instance's DB.
- CLI always requires the server: agents could not inspect a stopped instance.
- Separate DTO mappers for the stream: shapes would drift from the REST routes.

## Evidence
- 2026-10-11, `ddl-bench.mjs`: a read-only better-sqlite3 connection opens a WAL DB after the writer closed (its `-wal`/`-shm` removed),
  refuses writes (`SQLITE_READONLY`) and sees commits of a concurrent writer, so the `DbReader` is safe; `ddl2-check.mjs`: the online
  backup API works from a read-only connection.
