# ADR 0051: Child processes: one helper with kinds, executable resolution, a 2-slot semaphore and spawn statistics

Status: Proposed (Phase 1, 2026-10-11; amended after the critic review, issue I-06). Design reference:
`docs/design/06-panels-parity-platform.md` sections 3.6 and 4.2. Builds on design 05 S-PROC, which stays the owner of the security
rules. The `ChildSpec`/`ChildResult` signature below is the only `execFileText`; design 01 4.2 imports it.

## Context
The panels and lifecycle helpers spawn `powershell.exe`, `git`, `docker`, `ps` and, for command-line checks, PowerShell CIM. The legacy
engine routed every call through `proc.run` with `CREATE_NO_WINDOW` and a source-grep test. Children can hang (docker daemon), flood
output, take the git index lock, or be resolved to `.cmd` shims that need a shell. Child CPU is invisible to `process.cpuUsage()`.

## Decision
- Every short-lived spawn goes through `execFileText(spec, signal?)` in `engine/src/platform/exec.ts`; `spawnDetached` and
  `spawnForeground` (design 01 4.2 signatures) live in the same file for long-lived children. The spec has `kind` (closed union
  `powershell.processes | powershell.cmdline | git | docker | ps | taskkill | node | python | icacls`), `maxOutputBytes`, `encoding`, result fields
  `error` (`ENOENT | EACCES | TIMEOUT | OUTPUT_LIMIT | NONZERO_EXIT | SPAWN_FAILED | QUEUE_FULL | ABORTED`), `truncated`, `durationMs`; the
  function never throws.
- `platform/process.ts` (same owner): `pidAlive`, `commandLineOf` (`-EncodedCommand` constant script, 5 s cache), `forceKill`,
  `waitForExit`, `listRuntimeProcesses`; the earlier `killPid` is dropped.
- `resolveExecutable(name)`: fixed `%SystemRoot%` paths for `powershell.exe`/`taskkill.exe`/`icacls.exe`, `process.execPath` for `node`; PATH search for `git.exe`/`docker.exe`,
  with the Git `cmd\git.exe` shim swapped for `mingw64\bin\git.exe`; cached 10 min (null 5 min).
- A per-process semaphore: 2 running children, FIFO queue of 8, beyond that `QUEUE_FULL`.
- `childStats()` per kind (spawned, failed, timedOut, totalMs) exposed as `HealthReport.children` (design 03 6.2, critic I-21).
- Environment: 05's allow-list + `MCS_HOOK_DISABLE=1`; git adds `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`; docker passes
  `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG` when set (requested from 05).

## Consequences
- A stuck tool cannot pile up processes; the worst case per instance is 2 children plus a bounded queue.
- Benchmarks compute child CPU as spawn counts times a calibrated per-kind cost (design 8.2).

## Alternatives rejected
- A second helper module for panels, or 01's `execFileText(file, args, opts)` form beside this one: two policies to audit. Unbounded concurrency: N tabs times slow children. Inheriting the full
  environment: leaks variables such as `GIT_DIR` into git (CCAM issue #323 cited by 05).

## Evidence
2026-10-11, Node 24.14.1, Windows 11: `envtest.mjs` (E23: docker, PowerShell, git exit 0 under 05's allow-list), `hidden-console.mjs`
(E9: no console windows), `measure-git.ps1` (E16: shim hides the real git's CPU), `spawn-cost2.mjs` (E2). Design 05 E12: `.cmd` with
`shell:false` throws `EINVAL` synchronously.

## Requirements covered
Brief 12 (safe subprocess argument handling, timeouts and resource limits, no arbitrary command execution).

## Open items
OI-5 (docker variables in 05 S-PROC).

## Phase 2+ task slices
PP1. Slice table: design section 13.
