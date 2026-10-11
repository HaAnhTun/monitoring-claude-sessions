# 0004 Detached start on Windows: `detached` + `windowsHide`, file stdio, one spawn helper

Status: Proposed (Phase 1, 2026-10-11). Owner: instances/config/ops design (`docs/design/01-instances-config-ops.md` sections 4.2, 4.7, 4.15).

## Context
`mcs start` must launch a server that outlives the CLI and the agent's shell, shows no console window, and whose helper processes
(git, PowerShell, docker) never flash windows. The legacy engine used `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP` (a hidden console
inherited by children). Node exposes only `detached` and `windowsHide`; libuv maps `detached` to `DETACHED_PROCESS` (no console) and
assigns non-detached children to a kill-on-close job object.

## Decision
- Start the server with `spawn(process.execPath, [serverMain, 'serve', ...], { detached: true, windowsHide: true, stdio: ['ignore',
  bootLogFd, bootLogFd], cwd: workspace, env: {..., MCS_HOOK_DISABLE: '1'} })`, keep the handle until health is verified, then `unref()`.
- Every child process of the CLI or the server is created by one module (`platform/exec.ts`) with `shell: false`, `windowsHide: true`,
  argv arrays and timeouts; `stdio: 'inherit'` only for an interactive foreground CLI (`serve`, legacy delegation). Enforced by a lint
  rule and an AST test.
- Never spawn a `.cmd` shim; run JavaScript tools as `node <script>`.

## Consequences
- The server has no console at all; a child spawned without `windowsHide` (or with inherited stdio) from it would get a new visible
  console, so the single-helper rule is mandatory.
- Boot failures are visible in `logs/boot.log` (stdout/stderr of the detached process).

## Alternatives rejected
- `detached: false`: the server dies when the CLI exits (libuv job object), observed.
- `powershell Start-Process -WindowStyle Hidden` or `cmd /c start`: extra process, quoting hazards, behaviour depends on the default
  terminal application.
- A native helper to set `CREATE_NO_WINDOW` directly: new native dependency for no measured benefit.

## Evidence (2026-10-11, Windows 11 Pro 10.0.26200, Node v24.14.1)
- `D:/mvp/private/scratch/mcs-v3/instances-ops/e1/launch.mjs` variants: A (detached, file stdio) and C (detached, ignore) survived the
  launching shell; B (non-detached) died before its first heartbeat. `e1/probe-proc.ps1`: detached process `AttachConsole` error 6 (no
  console), `MainWindowHandle` 0; its `windowsHide:true` PowerShell child: `GetConsoleWindow()` 0, not visible.
- `e1/injob.ps1`: a Node process is in a job only after spawning a non-detached child; `e1/launch-after-helper.mjs` (A2): a launcher in
  that state still starts a detached server that survives it.
- `spawn('npm.cmd')` without a shell: `EINVAL` (E9).
- Not run on purpose: the negative control that would flash a window on the owner's desktop (planned on a CI runner).
