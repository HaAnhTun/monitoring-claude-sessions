# 0047 Separate install and build stamps shared by the build and the launcher

Status: Amended by 0062 (proposed Phase 1, 2026-10-11). Owner: tooling design (05 section 3.3); consumer: launcher `scripts/mcs.mjs` (design 01).

## Context
D6: the launcher runs `npm ci` + build once when `dist` is missing or stale (stamp of lockfile + sources). `npm ci` takes 7-16 s; a build
takes 2-5 s. With `ignore-scripts=true`, npm runs no root lifecycle scripts, so nothing can be hooked into `npm ci`.

## Decision
- `runtime/scripts/build-stamp.mjs` (zero-dependency ESM) exports `computeStamps`, `staleness`, file names and schema version.
- Install stamp = `<platform>-<arch>-node<major>:` + SHA-256 over (`package-lock.json`, `.npmrc`), stored in
  `node_modules/.mcs-install.json`, written by the launcher after a successful `npm ci`.
- Build stamp = SHA-256 over sorted relative POSIX paths and bytes of production inputs (root manifests and tsconfigs, each package's
  manifest, tsconfigs, `vite.config.ts`, `index.html`, `src/**` except tests, web `public/**`), stored in `runtime/.mcs-build.json` with
  `codeStamp` (first 10 hex), written as the last step of `npm run build`.
- Stamps are written atomically and only after success; the launcher serialises bootstrap with
  `acquireMutex(mutexName('bootstrap', realpath(runtimeDir)), { timeoutMs: 15 min })`, the OS-released `ProcessMutex` of design 01
  (ADR 0005/0007; named pipe on Windows), using its own zero-dependency copy of the primitive because the engine is not built yet.
  Revision 2026-10-11 (critic issue I-24): this replaces a `mkdir` lock folder with a 10 min staleness rule.

- Revision 2026-10-11 (registry C29, C30): the launcher's steps, messages, npm resolution and `RUNTIME_IN_USE` guard are design 01's
  (section 5.1, ADR 0007); this ADR fixes only the stamp contract. `outdated` compares a running instance's boot `codeStamp` with the
  `codeStamp` in `runtime/.mcs-build.json` (built code), never with a stamp computed from the source tree (01 section 5.3).

## Consequences
- Source edits rebuild without reinstalling; lockfile/platform/Node-major changes reinstall and rebuild; test edits do neither.
- The stamp is path-independent, so moving the skill folder does not force a rebuild.

## Alternatives rejected
- One combined stamp: reinstalls on every source edit.
- mtime-based staleness: unreliable across git checkouts and copies.
- A `mkdir` lock folder (`runtime/.mcs-bootstrap.lock`): survives a crashed or force-killed bootstrap and needs a staleness guess
  (10 min) that either blocks the next launcher or breaks a slow but live install; the pipe-based mutex is released by the OS.
- A `postinstall` script: never runs under `ignore-scripts`.

## Evidence
- 2026-10-11: `build-stamp.mjs check` 9 ms warm, 103 ms cold; identical stamp in two copies; test edit -> `build: false`, source edit ->
  `build: true`, `.npmrc` edit -> `install: true` (design 05 E18); `npm ci` 6.8-7.2 s warm, 15.7 s cold (E2, E3).
- 2026-10-11, Node 24.14.1, Windows 11: named-pipe mutex, five contenders never more than one holder, released immediately after
  `taskkill /F` of the holder (design 01 E3, E10).
