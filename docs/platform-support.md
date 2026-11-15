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

## Terminal (Windows only)

The terminal of the application (ADR 0079, 0080, 0083) starts `claude` in a pseudo console, and that exists on Windows only. Everything else in this
document, the monitoring part, runs on every host named above. On a host without the terminal the application says why: the status carries the reason,
`create` is refused with `UNSUPPORTED_OS`, `NATIVE_MISSING` or `NATIVE_LOAD_FAILED`, and the UI says "not supported on this OS".

| Host                                                              | Terminal                | Reason reported      | Evidence                                                                                              |
| ----------------------------------------------------------------- | ----------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| Windows 10 1809 (build 17763) or newer, x64                       | supported               | none                 | measured on Windows 11 10.0.26200 (ADR 0080, 0083); unit tests of the backend choice and of the check |
| Windows 10 1809 (build 17763) or newer, arm64                     | supported, not executed | none                 | the prebuilt files are Microsoft's, pinned by sha256; no ARM64 machine has run them (ADR 0083)        |
| Windows before build 17763                                        | not supported           | `os-too-old`         | `default.test.ts`, `diagnose.test.ts`                                                                 |
| Windows on another architecture (ia32, ...)                       | not supported           | `unsupported-os`     | `default.test.ts`, `diagnose.test.ts`                                                                 |
| Linux, any architecture                                           | not supported           | `unsupported-os`     | `default.test.ts`, `diagnose.test.ts`                                                                 |
| macOS, any architecture                                           | not supported           | `unsupported-os`     | `default.test.ts`, `diagnose.test.ts` (macOS stays UNVERIFIED for the rest, see above)                |
| Windows x64 or arm64 with the addon files missing from the bundle | not supported           | `native-missing`     | `default.test.ts`, `diagnose.test.ts`                                                                 |
| Windows x64 or arm64 where the addon does not load                | not supported           | `native-load-failed` | `default.test.ts`, `diagnose.test.ts`                                                                 |

The branches that differ by platform in the terminal code (the program lookup, the folder rules, the environment, the data type of the output) already
exist for POSIX and are unit-tested with an injected platform, so the Linux Docker harness runs them. What Linux and macOS need to become supported is
listed in ADR 0083, decision 2: more prebuilt targets and pins, the execute bit of the helper, a process-group kill, start times from `/proc`, the
registry enabled and the real-terminal tests un-gated.

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
