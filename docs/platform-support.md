# Platform support

Results of the POSIX verification (V4 work package WP-87, ADR 0065 items 4 and 5, ADR 0005, ADR 0006). There is no hosted CI (ADR 0078). The Linux rows were
run in Docker with `runtime/scripts/docker-posix.mjs --worktree` (throw-away labelled containers, the unprivileged `node`
user, no host folder mounted). macOS needs a real macOS host: those rows stay UNVERIFIED until someone runs the gates on a Mac (ADR 0078).

## Matrix that was run

Run of 2026-10-18, `--worktree`, quick gates, linux/amd64 unless noted. "Own tests" are the POSIX tests of WP-87
(`posix-hosts`, `posix-processes`, `posix-control`, `hook-default-home`).

| Target                  | Image base              | npm ci     | build      | test       | Own tests                                               | Failures left in `npm test`                                                              |
| ----------------------- | ----------------------- | ---------- | ---------- | ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| node22                  | `node:22-bookworm-slim` | PASS       | PASS       | FAIL       | PASS                                                    | 5, none POSIX (see below)                                                                |
| node24                  | `node:24-bookworm-slim` | PASS       | PASS       | FAIL       | PASS (one test expectation fixed after this run)        | 13, none POSIX after the fixes                                                           |
| node26                  | `node:26-bookworm-slim` | PASS       | PASS       | FAIL       | PASS                                                    | 8, none POSIX                                                                            |
| alpine24 (musl)         | `node:24-alpine`        | PASS       | PASS       | FAIL       | PASS (same expectation fix)                             | 14, none POSIX after the fixes                                                           |
| node24-arm64 (emulated) | `node:24-bookworm-slim` | PASS       | PASS       | FAIL       | `posix-hosts` PASS; the process tests time out          | 213 tests in 47 files, almost all timeouts under QEMU (10x slower, no `MCS_PERF_FACTOR`) |
| floor                   | `node:20-alpine`        | -          | -          | -          | launcher prints the 22.22.0 floor message, exit 1: PASS | -                                                                                        |
| macOS (any)             | -                       | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED                                              | needs a macOS host                                                                       |

The `test` gate stays red for reasons outside the POSIX layer: work in progress of other packages (`envelope.test.ts` error
catalogue, `driver.test.ts` boundary scan finding `better-sqlite3` in `tests/tooling/bundle.test.ts`, `state-file.int.test.ts`,
`migrate-workspace.int.test.ts`), one test that also fails on
Windows (`ingest-service.int.test.ts`, T-HE-03 b) and timing budgets of a loaded container (`hook.int.test.ts` T-HK-10,
`stream-limits.int.test.ts`, 10 s timeouts in `ingest-service.int.test.ts` that pass on node22 and on Windows).

Gates of a quick run: `npm ci`, `npm run build`, `npm test` (unit, web, integration, isolation and resilience projects),
`node scripts/smoke.mjs --bundle`. The full gate (`npm run ci -- --offline`) was also started on amd64 for node22, node24,
node26 and alpine24; it stopped at `format:check` on files that other work in progress had left unformatted, so it proves
nothing about POSIX and the quick gates above are the evidence.

## POSIX branches and their tests

| Branch                                                                                                | Linux (Docker)                                                        | macOS                                       | Test                                                                                  |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| Control channel address: abstract socket `\0mcs-<id>` on Linux, `<tmp>/mcs-<uid>/<id>.sock` elsewhere | verified                                                              | UNVERIFIED (host-injected test only)        | `server/test/posix-control.int.test.ts`, `server/test/control.int.test.ts` (T-SEC-01) |
| No socket file left on Linux, `run/control.token` mode 0600, socket folder 0700                       | verified                                                              | UNVERIFIED                                  | `server/test/posix-control.int.test.ts`, T-SEC-01                                     |
| Graceful end on `SIGTERM` and `SIGHUP` (exit 0, `state.json` and token removed)                       | verified                                                              | UNVERIFIED                                  | `server/test/posix-control.int.test.ts`                                               |
| Mutex: abstract socket on Linux, lock files with stale-pid takeover elsewhere                         | verified (socket), host-injected (lock file)                          | UNVERIFIED                                  | `engine/test/platform/mutex.int.test.ts`, `engine/src/platform/posix-hosts.test.ts`   |
| Detached start in its own session                                                                     | verified                                                              | UNVERIFIED                                  | `engine/test/platform/posix-processes.int.test.ts`                                    |
| Process identity: `/proc/<pid>/cmdline` listing, marker match, `SIGKILL`                              | verified                                                              | UNVERIFIED (`ps -axo` parser host-injected) | `posix-processes.int.test.ts`, `posix-hosts.test.ts`                                  |
| `LC_ALL=C` in every child                                                                             | verified                                                              | UNVERIFIED                                  | `posix-processes.int.test.ts`, `posix-hosts.test.ts`                                  |
| Opener: `xdg-open` from `PATH`, `/usr/bin/open` on macOS, relative `PATH` entries ignored             | host-injected                                                         | UNVERIFIED                                  | `posix-hosts.test.ts`                                                                 |
| Case rules: case-sensitive on Linux, insensitive on macOS and Windows                                 | verified                                                              | UNVERIFIED                                  | `posix-hosts.test.ts`, `importer.test.ts`                                             |
| Watch hint: only Windows UNC roots are polled                                                         | host-injected                                                         | UNVERIFIED                                  | `posix-hosts.test.ts`                                                                 |
| Default `MCS_HOME`: `${XDG_STATE_HOME:-~/.local/state}/mcs`, the hook stub and the runtime agree      | verified                                                              | UNVERIFIED                                  | `cli/test/hook-default-home.int.test.ts`, `posix-hosts.test.ts`                       |
| Linux arm64                                                                                           | emulated run only: unit tests pass, process tests time out under QEMU | UNVERIFIED                                  | needs a native arm64 runner or a raised `MCS_PERF_FACTOR`                             |
| Node floor message on Node 20                                                                         | verified (`floor` target)                                             | not applicable                              | harness `floor` target                                                                |

## Defects the Docker runs found

- `openSqlite` on a folder: Linux opens a folder read-only and fails only on the first read (`db_io`), Windows refuses it
  (`db_cantopen`). The driver now refuses a folder up front with `db_cantopen` on every host (`engine/src/db/driver.ts`;
  regression test: `driver.test.ts`, "maps a directory to db_cantopen").
- Two tests assumed Windows rules: the transcript importer tests looked rows up by a lower-cased key (POSIX keys keep their
  case), the command-line test expected an unquoted backslash path (a POSIX shell needs it quoted and escaped), and the
  `serveForeground` signal test checked the forwarded signal one tick after it was sent, before the token read finished.

## Known gaps

- The timing budgets of the hook tests (`T-HK-10`) and a few 10 s test timeouts can miss in a container; they are host speed,
  not POSIX behaviour.
- File-system checks (atomic replace over an open file, symlink refusal, the watcher on the container file system) and the
  `start`/`SIGKILL`/recover lifecycle run are moved to WP-87b.
