# 0007 Launcher `scripts/mcs.mjs`: stamp check, serialized bootstrap, in-process CLI

Status: Amended by 0062 and 0064 (proposed Phase 1, 2026-10-11). Owner: instances/config/ops design (`docs/design/01-instances-config-ops.md` section 5.1).
Stamp formats and hash inputs: `docs/design/05-tooling-testing-security.md` (scaffold `runtime/scripts/build-stamp.mjs`).

## Context
D6: a zero-dependency launcher checks Node, bootstraps (`npm ci` + build) when `dist` is missing or stale, then runs the CLI. Several
agents may invoke it at once; on Windows `.cmd` shims cannot be spawned without a shell; a loaded native addon cannot be deleted.

## Decision
- One Node floor, 22.22.0, checked first: `ERROR: Node >= 22.22.0 is required (found <v>); install the Node 24 LTS`, exit 1
  (`NODE_TOO_OLD`); no warning branch (revision 2, critic issue I-05). The launcher builds the web package on the user's machine and
  React Router 8.4.0 declares `engines.node >= 22.22.0`, so a lower floor would only move the failure into `npm ci`. Foundations D7
  ("22.12") is annotated by the lead.
- Fast path: `staleness()` from `runtime/scripts/build-stamp.mjs` (about 10 ms); nothing stale -> import `packages/cli/dist/main.js`
  in-process and call `main(argv)`.
- Bootstrap under an OS-released mutex `mutexName('bootstrap', realpath(runtimeDir))` (ADR 0005 primitive); re-check staleness after
  acquiring. ADR 0047 / design 05 3.3.4 reference the same name (critic issue I-24; a `mkdir` lock would stay held after a crashed
  bootstrap). The launcher carries zero-dependency copies of the mutex, the runtime listing and a `shell:false`, `windowsHide:true`
  spawn wrapper, because it runs before `@mcs/engine` is built; a parity test keeps the copies equal to `platform/{mutex,markers}.ts`.
- Before `npm ci`, list running runtimes of this install (command lines containing this runtime's server path); any -> refuse with
  `RUNTIME_IN_USE` and the list of instances to stop. A build without `npm ci` is allowed while runtimes run.
- npm is run as `node <npm-cli.js>` (from `npm_execpath` or next to `node.exe`), output appended to `runtime/.mcs-bootstrap.log`,
  progress on stderr. `MCS_LAUNCHER_NO_BOOTSTRAP=1` turns a stale build into an error (CI, tests).
- `mcs --version` answers from `runtime/package.json` without building.

## Consequences
- Concurrent first runs do the work once; a failed bootstrap never leaves a half-deleted `node_modules` because of a running instance.
- Running servers keep their loaded code and in-memory UI assets; `status` reports `outdated` until restarted.

## Alternatives rejected
- Spawning the CLI as a second process: +67 ms per command and loses the terminal's Ctrl+C handling.
- `npm.cmd` / `shell: true`: `EINVAL` without a shell on Node 24; quoting hazards with a shell.
- Versioned install folders per code stamp (copying `node_modules`): avoids the lock problem but costs tens of MB per version.

## Evidence (2026-10-11, Windows 11, Node v24.14.1, npm 11.11.0)
- `npm view react-router@8.4.0 engines` -> `{"node": ">=22.22.0"}` (design 05 C-1, checked 2026-10-11).
- `spawn('npm.cmd', ['--version'])` -> `EINVAL`; `node <node dir>/node_modules/npm/bin/npm-cli.js --version` -> 11.11.0 in 246 ms.
- `staleness()` on the scaffold (`D:/mvp/private/scratch/mcs-v3/scaffold-check/runtime`, 57 source files): 8-13 ms.
- `D:/mvp/private/scratch/mcs-v3/instances-ops/e11/run2`: loaded `better_sqlite3` addon -> unlink `EPERM`, package removal `EPERM`;
  an imported `.mjs` can be deleted while its importer runs.
- `e3/mutex.mjs`: five contenders, one holder at a time.
