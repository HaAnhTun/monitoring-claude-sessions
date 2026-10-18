# 0062 Self-contained skill folder, runtime layouts and the bundle-first launcher

Status: Accepted (V4, 2026-10-18). Owner: platform area (A). Amends 0007 (launcher: the bootstrap, the `RUNTIME_IN_USE` guard and the
npm resolution are removed), 0047 (stamps: the install stamp and the launcher's staleness check are removed; the build stamp stays
and gains a bundle form), 0006 (the runtime marker accepts two server entry suffixes). Related: 0061, 0063, 0064.

## Context
Owner decisions 3-5: a user machine needs only Node (floor 22.22.0), never runs `npm`, never builds; the runtime ships as a committed
bundle inside the skill folder. ADR 0007 built the web UI and installed dependencies on the user's machine under a mutex and refused
`npm ci` while a native addon was loaded. With a bundle and no native addon (0064) all of that disappears.

## Decision
1. **Skill folder** (`skillDir`; `<repo>/skills/monitoring-claude-sessions/` in a checkout, the plugin cache directory or
   `~/.claude/skills/monitoring-claude-sessions/` when installed):
   ```
   SKILL.md                      agent entry (0061)
   config/defaults.json          shared monitor defaults (22 keys)
   runtime/defaults.json         skill-level runtime defaults (`{ "schema_version": 1 }`; the label `runtime/defaults.json` of ConfigFileStatus)
   scripts/mcs.mjs               the launcher (`$MCS`); scripts/mcs-hook.mjs = the hook stub
   bundle/                       committed build output (0063): mcs-cli.mjs, mcs-server.mjs, mcs-hook.mjs, migrations/*.sql, web/**,
                                 .mcs-build.json, THIRD-PARTY-NOTICES.txt
   reference/                    agent reference docs
   ```
2. **Two runtime layouts, one resolver.** `engine/src/platform/layout.ts` is the only code that knows them. `runtimeDir` is "the folder
   that holds the server entry and `.mcs-build.json`":
   | | bundle layout (installed, or a checkout used through the bundle) | source layout (development) |
   |---|---|---|
   | `skillDir` | the skill folder | `<repo>/skills/monitoring-claude-sessions` |
   | `runtimeDir` | `<skillDir>/bundle` | `<repo>/runtime` |
   | server entry | `<runtimeDir>/mcs-server.mjs` | `<runtimeDir>/packages/server/dist/main.js` |
   | hook handler entry (the one locator of the hooks installer and the testkit) | `<runtimeDir>/mcs-hook.mjs` | `<runtimeDir>/packages/cli/dist/hook.js` |
   | web assets | `<runtimeDir>/web` | `<runtimeDir>/packages/web/dist` |
   | migrations | `<runtimeDir>/migrations` | `<runtimeDir>/packages/engine/migrations` |
   | build stamp | `<runtimeDir>/.mcs-build.json` | `<runtimeDir>/.mcs-build.json` |
   `layoutOfRuntimeDir(dir)` decides by the presence of `<dir>/mcs-server.mjs`; `layoutOfModule(import.meta.url)` finds the layout of a
   running module (a bundle entry sits directly in `bundle/`; a source or `dist` module has an ancestor with `packages/engine/package.json`).
   Anything that used `import.meta.url` + `../..` arithmetic (`defaultSkillDir`, the migrations folder, the server `main`) goes through it.
3. **Process identity.** The runtime marker of 0006 stays "the command line contains a server entry as a whole path ending and has
   `--mcs-instance=<id>` as an argument of its own". The accepted entry suffixes are `/packages/server/dist/main.js` (source layout) and
   `/mcs-server.mjs` (bundle layout); `listRuntimeProcesses(null)` lists runtimes of every folder, so `stop`, `repair` and the hung-runtime
   check still find a server that was started from a previous plugin version directory.
4. **Launcher** `scripts/mcs.mjs`: plain ESM, `node:*` imports only, valid syntax for old Node versions so the floor message always prints.
   1. `process.versions.node` below 22.22.0: stderr `ERROR: Node >= 22.22.0 is required (found <version>); install the Node 24 LTS`, exit 1
      (`NODE_TOO_OLD`).
   2. `--version` / `version --short`: `mcs <version>` from `bundle/.mcs-build.json` (bundle) or `runtime/package.json` (source), no module load.
   3. Mode: `MCS_LAUNCHER_MODE=bundle|dev` forces a mode. Default: bundle when `bundle/mcs-cli.mjs` exists, else dev.
   4. Bundle mode: `await import(bundle/mcs-cli.mjs)` and `process.exitCode = await main(argv, { launcherPath, skillDir, runtimeDir: <skillDir>/bundle })`.
   5. Dev mode (only in a checkout: `<skillDir>/../..` holds `runtime/packages/cli/dist/main.js`): the same with the `dist` module and
      `runtimeDir = <repo>/runtime`. No `dist` and no bundle: `ERROR: no runtime found ...` with the two ways out (`npm ci && npm run build` in
      `runtime/`, or install the skill from a release), exit 1.
   6. Never `npm`, never a build, never a spawn, never a lock. Unexpected failure: `ERROR: internal launcher error: <message>`, exit 1
      (stack with `MCS_DEBUG=1`). The launcher never reads or writes a workspace.
   `MCS_LAUNCHER_NO_BOOTSTRAP` is accepted and ignored (there is nothing to bootstrap); it is removed by the cleanup area.
5. **Stamps.** The bundle's `.mcs-build.json` is deterministic (no timestamp, no Node version): `{ schemaVersion: 1, runtimeVersion,
   buildStamp (sha256 over the sorted relative paths and bytes of every other file in bundle/), codeStamp (first 10 hex), files: { <relative
   path>: { bytes, sha256 } } }`. `status` compares a running instance's boot `codeStamp` with the file on disk (unchanged rule of 0047),
   `doctor` recomputes the hashes for the integrity check. In the source layout `.mcs-build.json` is still written by `npm run build`
   (with `node` and `builtAt`) and `scripts/build-stamp.mjs` still computes the install and build stamps for developers.
6. **Hook stub** `scripts/mcs-hook.mjs` (zero dependencies, always exits 0 in hook mode): it imports the first existing of
   `../../../runtime/packages/cli/dist/hook.js` (checkout with a build: tests and development exercise fresh code) and `../bundle/mcs-hook.mjs`.
   `bundle/mcs-hook.mjs` has no relative imports and carries the whole install contract (silent exit 0, `MCS_HOOK_DISABLE`, hard exit within 1,200 ms, `--version`), so the hooks installer may copy that one file to a stable path under `MCS_HOME`; `layout.hookEntry` is the locator in both layouts.
7. **Plugin updates.** The folder path changes with every plugin version; no durable file stores it except hook commands (stable
   copy, hooks area). Running servers are unaffected (code and web assets are in memory); `status` shows `outdated: true`; `restart` moves them.

## Consequences
- Installing, updating and removing the skill is a folder copy; no step needs the network, a compiler or `npm`.
- The `RUNTIME_IN_USE`, `BOOTSTRAP_FAILED` error codes and the install stamp have no producer after the launcher change; the cleanup
  area removes the codes from `CLI_ERROR_CODES` (and `schemas/cli-envelope.v1.schema.json` is regenerated).
- A source checkout runs the committed bundle by default; developers use `MCS_LAUNCHER_MODE=dev` (or call `dist/main.js`) to run their own build.
- Tests that start real processes keep using `dist` (source layout); the bundle is exercised by the bundle smoke and the launcher tests.

## Alternatives rejected
- Keeping the bootstrap as a fallback in the launcher: it needs `npm` and the network on user machines, the very thing owner decision 3 removes.
- One `runtime/` folder for both layouts (bundle in `skills/.../runtime`): the name collides with the sources folder `<repo>/runtime`.
- Versioned install folders under `MCS_HOME`: a second copy of the bundle per version for no benefit; the plugin cache already versions the folder.
- A single huge `.mjs` for CLI, server and hook: the hook handler must start fast and be copyable on its own (28-58 KB).

## Evidence
- 2026-10-18 probe (planning notes, not published): the three bundles placed at `packages/{cli,server}/dist/main.js` of a mock skill
  ran `init`, `start` (pid, URL), `verify` ("health, instance, sessions (0), overview all valid"), `status` and `stop` against the real
  engine and server; `GET /` answered `200 text/html` from the copied web assets. The migrations folder and the `../../..` runtime
  folder arithmetic only worked because the probe mimicked the source layout: they are the code that `layout.ts` replaces.
- ADR 0007 evidence (E11: an imported `.mjs` can be deleted while its importer runs) holds for the bundle: replacing bundle files under a running server is safe.
