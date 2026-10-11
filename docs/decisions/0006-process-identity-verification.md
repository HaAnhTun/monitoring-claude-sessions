# 0006 Process identity before any kill: control-channel identity first, command-line marker as fallback

Status: Proposed (Phase 1, 2026-10-11). Owner: instances/config/ops design (`docs/design/01-instances-config-ops.md` sections 4.1, 4.8, 4.9).

## Context
D12 requires `stop` to verify the pid's command line before killing (pids are reused; the legacy CLI checks for `viewer.py`). On this
machine `wmic` no longer exists; the remaining command-line sources cost a PowerShell start.

## Decision
- Classification (`probeInstance`) never needs the command line: the control channel answers with `instanceId` and `pid`; when the
  channel is free, a live pid in `state.json` is by construction not our runtime (`foreign-pid`).
- A kill happens only in two cases: (a) the forced path of a Node runtime whose control channel is silent or that ignored shutdown:
  the command line must contain `/packages/server/dist/main.js` and `--mcs-instance=<instanceId>` (backslashes normalized,
  case-insensitive on Windows); (b) a legacy viewer: the command line must contain `viewer.py` (legacy rule).
- Command line source: `commandLineOf(pid)` of `platform/process.ts` (design 06 4.2, the one implementation; revision 2, critic issue
  I-06): Windows `powershell.exe` (Windows PowerShell 5.1, ships with Windows) with `-EncodedCommand` of the constant script
  `(Get-CimInstance Win32_Process -Filter 'ProcessId=<int>').CommandLine`, kind `powershell.cmdline`, 20 s timeout, 5 s cache per pid;
  Linux `/proc/<pid>/cmdline`; macOS `ps -o command= -p <pid>`. The pid is validated (`/^[1-9][0-9]{0,9}$/`) before building the script.
- Marker checks live in `platform/markers.ts` (`hasRuntimeMarker`, `hasLegacyMarker`), the only place outside `exec.ts`/`process.ts`
  that branches on the platform for this purpose (design 06 lint scope, I-34).
- The kill itself is `forceKill(pid)`: `process.kill(pid)` on Windows (TerminateProcess, the effect of `taskkill /F`, no child process)
  and `SIGKILL` on POSIX, followed by `waitForExit`.
- The server argv always carries the marker, also for the foreground `serve`.

## Consequences
- Normal `status`/`stop` cost about 60 ms; the forced path costs one CIM query (0.3-0.5 s).
- The legacy CLI cannot stop a Node runtime (no `viewer.py` in its command line); the Node runtime restores its deleted `state.json`.

## Alternatives rejected
- `wmic`: absent on current Windows 11 builds.
- `tasklist`: image name only, cannot tell instances apart.
- PowerShell 7 (`pwsh`): not installed by default; similar cost.
- Putting `viewer.py` into the Node argv to satisfy the legacy CLI: misleading, and the legacy stop would force-kill without a
  graceful shutdown.

## Evidence (2026-10-11, Windows 11 Pro 10.0.26200)
- `D:/mvp/private/scratch/mcs-v3/instances-ops/e2/cmdline-cost.mjs`: `wmic` absent; `Get-CimInstance` (PowerShell 5.1)
  539/358/308/314/269 ms; `Get-WmiObject` 305-1027 ms; pwsh 7 `Get-Process .CommandLine` 364-406 ms, `Get-CimInstance` 322-524 ms;
  `tasklist` 74-114 ms (image only); the `--mcs-instance=<uuid>` marker was found by all command-line methods.
- Legacy rule `src/backend/cli.py:58-66, 282-305` read 2026-10-11.
