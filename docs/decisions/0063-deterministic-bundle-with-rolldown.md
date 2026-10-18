# 0063 Deterministic bundle with rolldown, committed output, bundle check and third-party notices

Status: Accepted (V4, 2026-10-18). Owner: platform area (A). Amends 0041 (adds one exact-pinned root devDependency, `rolldown`), 0040
(the shipping artefact is the bundle; `tsc -b` stays for development, tests and type information) and 0039 (the web build is served from
`bundle/web` in the bundle layout). Related: 0062.

## Context
Owner decision 5: server, CLI and hook handler are bundled into a few `.mjs` files plus the prebuilt web assets, the output is committed
inside the skill folder, and a check proves that the committed bundle equals a fresh build of the sources. Developers build from
`runtime/`; users never build. Owner decision 7: public release with MIT and third-party notices for bundled code. The question was which bundler.
`esbuild` is not installed. `rolldown` 1.2.13 (MIT) is installed already: Vite 8.3.4 depends on `rolldown ~1.2.12`, and Vite builds the web UI with it.

## Decision
1. **Bundler**: `rolldown`, added as a direct, exact-pinned root devDependency at the version already in the lockfile (`1.2.13`) through the
   lead's npm barrier. No other new package; the lockfile gains only the root edge. The scripts import it dynamically so a missing install gives a clear message.
2. **Entries** (one rolldown `build` per entry, so no shared chunks and a fixed file list): `mcs-cli` (`packages/cli/src/main.ts`),
   `mcs-server` (`packages/server/src/main.ts`), `mcs-hook` (`packages/cli/src/hook.ts`). Entry list is one constant in `scripts/bundle.mjs`
   (the MCP area adds an entry there). Bundled from the TypeScript sources through the `@mcs/source` export condition, not from `dist`.
3. **Options** (each one is covered by a test): `platform: 'node'`, ESM, `output.entryFileNames: '[name].mjs'`, `output.codeSplitting: false`
   (dynamic `import()` of command modules is inlined), `external: [/^node:/]` (no package stays external: no `node_modules` at run time),
   `treeshake: true`, no minification, no source maps. **`resolve.conditionNames` is `['@mcs/source', 'node', 'module']` and must not name
   `import` or `require`**: pinning `import` makes `require('is-promise')` (Express 5) return the ES module namespace and every request
   fails with `isPromise is not a function` (probe, same defect as CR-WP-08-1). Rolldown adds `import`/`require` per import kind.
4. **Determinism**: no timestamps, no absolute paths (region comments use repository-relative paths), files written with `\n`, a fixed file
   list, a sorted manifest. `scripts/bundle.mjs --check [--against <dir>]` builds into a temp folder and compares every file byte for
   byte with the committed folder (or `--against`), prints the differing, missing and extra paths, never writes to the repository, exit 1 on any difference.
5. **Web assets** are the output of `npm run build -w @mcs/web` (`packages/web/dist`, without `.vite/`) copied to `bundle/web/`; the
   script refuses to run when `dist` is missing ("run npm run build first"). `check` compares them too. Migrations (`packages/engine/migrations/*.sql`)
   are copied to `bundle/migrations/`.
6. **Notices**: `bundle/THIRD-PARTY-NOTICES.txt` lists every third-party package that is part of a bundle (the modules rolldown reports for
   the three Node entries plus the production dependency closure of `@mcs/web` from the lockfile) with name, version, SPDX licence and licence
   text, sorted, LF, no dates. A licence outside the allow list (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, BlueOak-1.0.0, CC0-1.0,
   Unlicense) fails the build; a package without licence text file is listed with its SPDX id and a marker line.
7. **Ownership and cadence**: the work package that creates the pipeline commits the first bundle. After that the bundle is lead-owned
   output, regenerated at milestone ends (`npm run build && npm run bundle && npm run bundle:check` in `runtime/`) in a commit of its own.
   `npm run ci` does not check freshness (the bundle is stale between regenerations by design); `npm run ci -- --bundle` adds
   `bundle:check` and a smoke run through the bundle, and the GitHub workflow (0065) runs that variant.
8. `.gitattributes` marks `skills/*/bundle/**` as `linguist-generated=true`.

## Consequences
- Output size, unminified: about 1.4 MB CLI, 2.1 MB server, 58 KB hook, plus 0.65 MB web assets and the notices (about 4 MB per regeneration in git).
  Minifying would give about 2 MB; it is not done because readable bundles give honest stack traces and reviewable diffs, and the size is no problem for a plugin copy.
- A dependency added to any bundled package is bundled automatically; its licence is checked by the same build.
- The bundle depends on rolldown's output format: a rolldown upgrade changes the bundle and is an ADR-sized event (exact pin).
- Native addons cannot be bundled; this works because the SQLite driver is `node:sqlite` (0064).

## Alternatives rejected
- `esbuild`: not installed, a second native binary per platform, no advantage for this graph.
- Vite SSR / library mode for the Node entries: ties the Node bundles to the web package's Vite config; externalisation rules differ from the bundler we want to control.
- Shipping `dist/` plus `npm ci --omit=dev`: needs `npm` and the network on the user's machine.
- Single-executable applications (`node --experimental-sea-config`, `pkg`): one binary per OS and architecture; owner decision 3 asks only for Node.
- Splitting chunks with hashed names: a variable file list and noisy diffs.
- Minified output: see Consequences.

## Evidence
- 2026-10-18, Node 24.14.1, Windows 11, rolldown 1.2.13 from `runtime/node_modules` (read only), probe (planning notes, not published)
  bundling the real sources: three entries in 0.09-0.85 s; sizes cli 1,356,003 / server 2,106,521 / hook 57,695 bytes (minified 719,750 / 1,212,859 / 28,884);
  two builds gave the identical SHA-256 over all files (`64de063a5b145718`); no drive letter or user folder in any file; the first attempt with `import`
  in `conditionNames` booted a server whose every request failed with `isPromise is not a function`; with `['@mcs/source','node','module']`
  `init`, `start`, `verify`, `stop` passed and `GET /` served the web index (see 0062). Dynamic imports without `codeSplitting: false` produced 18 hashed `.js` chunks.
- Cross-OS and cross-Node determinism is a gate of the M1 milestone (consolidation, plan section 9.2): after the lead has regenerated the committed bundle on Windows, `bundle:check` runs inside Linux x64/arm64 (glibc, musl) containers on Node 22, 24 and 26 with the harness flag `--ref HEAD --bundle`. The POSIX work package itself runs its Docker gates on the uncommitted tree (`--worktree`, where the committed bundle is stale by design) and therefore does not claim determinism.
