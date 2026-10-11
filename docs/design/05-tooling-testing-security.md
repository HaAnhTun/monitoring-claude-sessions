# 05 Tooling, testing, security and documentation

Status: Phase 1 design, 2026-10-11. Owner: tooling/testing/security designer. ADR range 0040-0049.
Scope (master brief sections 3, 12, 14, 15, 16, 18; foundations D6, D7, C2, C3, C5, C6; open question 6): monorepo tooling, quality
gates, test strategy, security model, documentation plan, release gates, CI.
Machine for every experiment: Windows 11, Git Bash, Node 24.14.1, npm 11.11.0, Python 3.14.3, Chrome 155; Node 22.23.3 and 26.11.1
from `D:/mvp/private/scratch/mcs-v3/nodes`. Scratch: `D:/mvp/private/scratch/mcs-v3/{scaffold-check,security-probe,parity-probe,tooling-fix}`.
Revision 2026-10-11 (critic issues I-09, I-14, I-22..I-26 and the aligned I-02, I-04, I-05, I-06, I-11, I-13, I-17, I-27, I-36): shapes
owned by designs 01, 02, 03, 04 and 06 adopted where named; experiments E22-E23 added.
Revision 2, 2026-10-11 (second critic N-02, N-07, N-13, I-22, I-26, I-34, I-36; the contract registry `98-contract-registry.md` is the
arbiter of names, its rows C27-C36, C38, C45, C46, C54, C55 adopted): the smoke gate drives the real CLI (`init`/`start`/`stop`) or
reports SKIPPED, the Playwright config is 04's (A.28 withdrawn), `Clock` comes from 01's `shared/src/time.ts`, id regexes from 02's
protocol module, the platform-branching lint rule of 06 section 4 is in A.9, T-ISO test files belong to the 01 slices, testkit exports
`./legacy`. Experiment E24 added.
Reconciliation, 2026-10-11 (phase 1b residuals; no section renumbered): S-ING-3 cites 02's two line caps (`ENVELOPE_MAX_BYTES`,
`MAX_LINE_BYTES`, I-32) instead of a value of its own; S-PROC-2 and SEC-19 list 06's `ChildKind` executables (`icacls`, `python`,
`opener`) and its `.exe`/`.com` rule (I-06); 4.2 and 7.4 use 02's `T-LF-*` ids (N-12); the scaffold `health.ts` stub is labelled (C51).
Every file in Appendix A was built, linted, type-checked, tested and run in `scaffold-check` (section 9 has the exact outputs).

Read order for an implementer: section 0 (decisions), then only the sections your slice names (section 13). Appendix A (scaffold
file contents) sits before the closing sections 11-13.

---

## 0. Decisions at a glance

| # | Decision | ADR |
|---|---|---|
| T1 | npm workspaces under `runtime/` with six packages: the five of D1 plus a dev-only `@mcs/testkit`. No build orchestrator (no turbo/nx/lerna). | 0040 |
| T2 | One custom export condition `@mcs/source` maps every workspace package to its TypeScript sources. Type-check, Vitest, Vite and dev mode use it, so nothing needs a prior build; `tsc -b` (no condition) builds `dist/` for shipping. | 0040 |
| T3 | TypeScript 6.0.3, `tsconfig.base.json` with the strict flag set of section 2.4; per package a `tsconfig.json` (check, `noEmit`) and a `tsconfig.build.json` (composite emit). Web is type-checked only; Vite builds it. | 0040 |
| T4 | Exact pins only, one lockfile, `.npmrc` `ignore-scripts=true` + `save-exact=true`; one `overrides` entry (jsx-a11y); a zero-dependency `check-deps` gate proves every import is declared and every version exact. | 0041 |
| T5 | ESLint 10.12.0 flat config with typed linting (`strictTypeChecked` + `stylisticTypeChecked`); layering and safety enforced with core rules only (`no-restricted-imports`, `no-restricted-syntax`, `no-restricted-properties`, `no-restricted-globals`). No eslint-plugin-import/boundaries. | 0042 |
| T6 | Vitest 5.0.3 root config with projects `unit`, `integration`, `isolation`, `resilience`, `security`, `parity`, `tooling`, plus `web` (own config file). Coverage v8 with global and per-module thresholds. Zero retries. | 0043 |
| T7 | Cross-engine parity: the Python engine is the oracle, run read-only. Capture is design 06's frozen-clock generator (`tests/legacy-parity/tools/capture_golden.py`, ADR 0053) storing raw legacy responses; this design owns the Node-side projections, normalisation, the Python runner and the `npm run parity:capture` wrapper; two modes (live = fresh capture into a temp dir, golden = committed goldens). | 0044 |
| T8 | Local server security: 127.0.0.1 only, exact Host and Origin allow-lists, `Sec-Fetch-Site` check, mutating requests need JSON + custom header, no CORS, strict CSP; the hook POST carries no event data (spool is the only ingest channel). | 0045 |
| T9 | Untrusted text never reaches a terminal raw: one CLI output module escapes C0/C1/DEL/bidi/line-separator characters in text and JSON modes. | 0046 |
| T10 | Two stamps: install stamp (lockfile, `.npmrc`, platform, Node major) and build stamp (production sources); file formats and staleness algorithm shared by `npm run build` and the launcher. | 0047 |
| T11 | `npm run ci` (zero-dependency `scripts/ci.mjs`) is the single gate runner; a GitHub Actions workflow is shipped inactive at `runtime/ci/github-actions-ci.yml` with SHA-pinned actions. | 0048 |
| T12 | Final docs use lowercase-kebab names in `docs/`; legacy docs move to `docs/legacy/`; every doc answers a fixed question set (section 6.3). | 0049 |

---

## 1. Scope, ownership and assumptions

### 1.1 Files this design owns (implementation slices in section 13)

| Path (skill root relative) | Content |
|---|---|
| `runtime/package.json`, `runtime/package-lock.json`, `runtime/.npmrc` | workspace root, scripts, pins, overrides |
| `runtime/tsconfig.base.json`, `runtime/tsconfig.check.json`, `runtime/tsconfig.build.json` | compiler settings |
| `runtime/eslint.config.js`, `runtime/.prettierrc.json`, `runtime/.prettierignore`, `runtime/.editorconfig` | static checks and format |
| `runtime/vitest.config.ts` | test projects, coverage |
| `runtime/scripts/*.mjs` | repository scripts (section 3.2) |
| `runtime/ci/github-actions-ci.yml` | inactive CI workflow |
| `runtime/packages/*/package.json`, `runtime/packages/*/tsconfig*.json` | package manifests (code inside packages is owned by the package designs) |
| `runtime/packages/testkit/**` | fixture library (section 4.4) |
| `runtime/tests/**` | cross-package suites: isolation (only `_setup.ts`; each `isolation/*.test.ts` belongs to the 01 slice of its T-ISO rows, `hook-routing-isolation.test.ts` to 02; critic N-07), resilience, security, parity (base modules only, see next row; `*.golden.test.ts` are 01 S2/S3), tooling |
| `runtime/tests/parity/{projections,normalize,run-python}.ts`, `runtime/scripts/parity-capture.mjs` | Node side of the parity harness (section 4.11). `tests/legacy-parity/tools/**` and `tests/legacy-parity/golden/**` are owned by design 06 (slice PP2); the `*.parity.test.ts` files by 06 PP4/PP8 |
| `.gitignore` additions | section 2.9 |
| `docs/testing.md` (Phase 6) and the docs plan | section 6 |

Security primitives that several designs call are specified here (section 5) and implemented in slice S6 unless the owning package design
specifies the same file: `packages/engine/src/security/paths.ts`, `packages/engine/src/log/logger.ts`,
`packages/cli/src/io/terminal.ts`, `packages/server/src/http/guards.ts`. If another design specifies one of them, that design's API wins and
the tests in section 5.7 still apply unchanged. `packages/engine/src/platform/exec.ts` and `platform/process.ts` are owned by design 06
(slice PP1; `ChildSpec`/`ChildResult` of 06 section 3.6 are the authoritative signature, critic issue I-06); the security rules S-PROC 1-5
(5.3) stay normative for that file and `security/subprocess.test.ts` (S7) verifies them through the 06 API.

### 1.2 Owned elsewhere (this design depends on them)

| Item | Owner | What this design assumes (shape) |
|---|---|---|
| Launcher `scripts/mcs.mjs` | design 01 (launcher/CLI/instances) | calls `staleness()` / writes stamps as in section 3.3; owns the bootstrap steps (01 section 5.1) and relies on the stamp contract of section 3.3.4 |
| CLI command names | design 01 | `mcs init --slug <slug> --name <name> --repo <path> [--port <n>]`, `start`, `stop`, `status`, `verify`, `doctor`, `diagnostics`, `db migrate`, `upgrade`, `hooks install|verify|uninstall|status` (installer modules in `engine/src/hooks/installer/`, called by `ops.hooks.*`, critic N-11); other commands take `--task <slug> --repo <path>`; exit 0 ok, 1 failure, 2 usage (legacy convention) |
| `MCS_HOME` | design 02 section 2.6.1 (layout of `routes/`, `logs/`, `hooks/`, `backups/`, `locks/`), design 01 (the rest) | the per-user state folder, resolved by `resolveMcsHome(env)`: `env.MCS_HOME` if non-empty and absolute; else win32 `%LOCALAPPDATA%/mcs`, POSIX `${XDG_STATE_HOME:-~/.local/state}/mcs`. Tests always set `MCS_HOME` to a temp dir so nothing touches the real per-user folder |
| `Clock` interface | design 01 (`@mcs/shared` `src/time.ts`, 01 section 4.4a, slice 01 S1; critic issue I-36, registry C27) | `interface Clock { now(): number }` (epoch ms) and `systemClock: Clock` (same file: `isoSecondsZ`, `isoMsZ`). This design declares no clock module; testkit `FakeClock` (4.4) imports `type Clock` from `@mcs/shared` and implements it. Modules of 02/03/06 that take a bare `now: () => number` receive `() => clock.now()` |
| DB layout, `meta.instance_id`, migrations | design 03 (sections 3-4) | `PRAGMA integrity_check`, a `meta` table, numbered migrations, backup before migration (D10); the only `better-sqlite3` importer is `packages/engine/src/db/driver.ts` (03 section 4.5) |
| Hook handler, spool format, routing | design 02 (sections 2.1-2.7) | installed command `node --no-warnings <skill>/scripts/mcs-hook.mjs --mcs-hook <Event> [--async]` (zero-dependency stub that imports `runtime/packages/cli/dist/hook.js`, emitted from the entry `cli/src/hook.ts`); spool segments `<workspace>/data/spool/hooks-<YYYYMMDD>T<HH>Z.ndjson` (extension constant `SPOOL_SEGMENT_EXT = '.ndjson'` in `shared/src/protocol/hook-envelope.ts`; not `.jsonl`, which the legacy audit flags, critic issue I-02); event list `INSTALLED_HOOK_EVENTS` (21 events) in `shared/src/protocol/hook-events.ts`; `MCS_HOOK_DISABLE=1` honoured first |
| API v3 endpoints, SSE, error codes | design 03 (sections 5-6, 9) | `/api/v3/health`, `/api/v3/stream`, error envelope `{ error: { code, message, requestId, details? } }` with `ErrorCode` from `packages/shared/src/api/errors.ts` (03 section 5.2 catalogue, authoritative, critic issue I-04); the security suite imports that type and never spells codes of its own |
| UI tests, Playwright specs, `packages/web/vite.config.ts`, `packages/web/vitest.config.ts` contents | design 04 (`04-ui.md` sections 11, 12) | this design owns their conventions (ports, determinism, flake policy) and the root wiring |

---

## 2. Monorepo scaffold

### 2.1 Tree

```
<skill root>/
  .gitignore                  + runtime entries (2.9)        .gitattributes   unchanged: "* text=auto eol=lf"
  scripts/mcs.mjs             launcher (design 01)
  runtime/
    package.json  package-lock.json  .npmrc  .editorconfig  .prettierrc.json  .prettierignore
    tsconfig.base.json  tsconfig.check.json  tsconfig.build.json  eslint.config.js  vitest.config.ts
    scripts/  lib.mjs clean.mjs typecheck.mjs check-deps.mjs build-stamp.mjs ci.mjs smoke.mjs dev.mjs
              stress.mjs check-text.mjs check-docs.mjs release-check.mjs parity-capture.mjs   (last five: slice S9/S8)
    ci/github-actions-ci.yml  (inactive)
    packages/
      shared/   src/index.ts  src/protocol/index.ts  ...            -> dist/
      engine/   src/...  test/*.int.test.ts                        -> dist/
      server/   src/...  test/*.int.test.ts                        -> dist/
      cli/      src/main.ts  src/hook.ts  src/hook/**  src/io/terminal.ts  test/*.int.test.ts -> dist/ (dist/main.js, dist/hook.js)
      web/      index.html  public/  src/**  e2e/  vite.config.ts  vitest.config.ts       -> dist/ (Vite)
      testkit/  src/**                                             -> dist/ (dev only, for Playwright)
    tests/
      tsconfig.json
      isolation/  resilience/  security/  parity/  tooling/
    .mcs-build.json           build stamp (gitignored)
    node_modules/.mcs-install.json   install stamp (gitignored with node_modules)
  tests/legacy-parity/        README.md  tools/*.py  golden/{meta.json,trees,api,cli,vectors}   (design 06 section 5.2.1, slice PP2)
```

### 2.2 Packages

| Package | Kind | Exports (`@mcs/source` -> `src/*.ts`, `types` -> `dist/*.d.ts`, `default` -> `dist/*.js`) | Runtime deps (exact) | May import (lint-enforced) |
|---|---|---|---|---|
| `@mcs/shared` | isomorphic contracts | `.` and `./protocol` (zod-free) | `zod` 4.6.5 | `zod` only; `protocol/**` imports nothing |
| `@mcs/engine` | Node domain | `.` | `@mcs/shared`, `better-sqlite3` 13.0.3, `zod` 4.6.5 | shared, node:*; `better-sqlite3` only in `src/db/driver.ts` (03 section 4.5); `node:child_process` only in `src/platform/exec.ts` |
| `@mcs/server` | Express app + process main | `.` (app factory for tests); process entry `dist/main.js` by path | `@mcs/engine`, `@mcs/shared`, `express` 5.3.0, `zod` 4.6.5 | engine, shared, express, node:* except child_process |
| `@mcs/cli` | `mcs` commands + hook handler | none (entries by path: `dist/main.js`, `dist/hook.js`); `bin.mcs` for completeness | `@mcs/engine`, `@mcs/shared` | engine, shared, node:* except child_process; `src/hook.ts`+`src/hook/**`: only `node:*`, `@mcs/shared/protocol`, `./` |
| `@mcs/web` | React SPA | none (static `dist/` served by server) | `@mcs/shared`, react 19.3.0, react-dom 19.3.0, react-router 8.4.0, @tanstack/react-query 5.104.1, lucide-react 1.55.0 | shared and the listed libs; no node:*, no zod (schemas via shared) |
| `@mcs/testkit` | dev-only fixtures | `.` and `./legacy` (design 06 section 5.3 legacy tree builders `tk/legacy/*`, registry C46) | `@mcs/shared` | anything; never imported by any `src/**` non-test file (lint + check-deps) |

Dev dependencies: root holds the toolchain (`typescript` 6.0.3, `@tsconfig/node24` 24.0.5, `@types/node` 24.19.2, `vitest` 5.0.3,
`@vitest/coverage-v8` 5.0.3, `eslint` 10.12.0, `@eslint/js` 10.0.1, `typescript-eslint` 8.71.1, `eslint-plugin-react-hooks` 7.1.1,
`eslint-plugin-jsx-a11y` 6.10.2, `globals` 17.13.0, `prettier` 3.9.10, `@playwright/test` 1.64.0); each package holds its own
`@types/*` and test-only libraries (engine `@types/better-sqlite3` 9.6.0; server `@types/express` 5.0.6; web `vite` 8.3.4,
`@vitejs/plugin-react` 6.1.2, `happy-dom` 20.14.6, `@testing-library/{react 16.3.3, dom 10.4.2, jest-dom 7.0.1, user-event 14.6.7}`,
`@types/react{,-dom}` 19.3.0; engine/server/cli/web `@mcs/testkit` 3.0.0). `axe-core` is added to web devDependencies by the UI slice (ADR 0039)
with an exact pin. `typescript-native` (TS 7) is not added (stack-versions section 3: not needed at this size).

Versioning: every `package.json` in `runtime/` carries the same `version`, which is `RUNTIME_VERSION` (D13). Internal dependencies are
written as that exact version (npm links the workspace because the version matches; `*` would not match a prerelease). `check-deps`
fails when any version or internal spec differs. Bump procedure (slice S1 script `scripts/set-version.mjs <semver>`): rewrite all seven
manifests, then `npm install --package-lock-only --offline`, then `npm run ci`.

### 2.3 Dependency graph, build order, outputs

```
shared <- engine <- server
   ^         ^------ cli
   |-------- web            testkit -> shared   (dev only; consumed by tests and Playwright)
```

`npm run build` = `clean` -> `tsc -b tsconfig.build.json` (order from references: shared, engine, server, cli, testkit; incremental info in
`dist/.tsbuildinfo`) -> `vite build` in `packages/web` -> `build-stamp.mjs write`. `clean` always runs first because `tsc` never deletes
the output of a removed source file (stale `dist/*.js` would otherwise ship). Outputs: `packages/{shared,engine,server,cli,testkit}/dist/**`
(`.js`, `.d.ts`, maps; no test files because `tsconfig.build.json` excludes `*.test.ts` and `test/`), `packages/web/dist/` (index.html,
hashed assets, `.vite/manifest.json` per ADR 0039), `runtime/.mcs-build.json`. Measured: full build 1.9-5.4 s (section 9).

### 2.4 TypeScript

`tsconfig.base.json` extends `@tsconfig/node24` (lib es2024 + ESNext.*, `module: nodenext`, `moduleResolution: node16`, `target: es2024`,
`types: ["node"]`, `strict`, `esModuleInterop`, `skipLibCheck`) and adds:

| Flag | Why |
|---|---|
| `strict` | brief: strict type checking |
| `noUncheckedIndexedAccess` | array/record reads are `T \| undefined`; transcripts and configs are sparse |
| `exactOptionalPropertyTypes` | `{ a?: string }` cannot hold `undefined`; JSON contracts distinguish missing from null |
| `noPropertyAccessFromIndexSignature` | dynamic keys must use `obj['k']` (visible at review) |
| `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `useUnknownInCatchVariables` | standard hygiene |
| `verbatimModuleSyntax` | type-only imports must say `type`; matches native type stripping |
| `erasableSyntaxOnly` | no `enum`, runtime `namespace`, parameter properties: sources stay runnable with Node type stripping (dev mode) |
| `isolatedModules` | per-file transpilers (Vite, Vitest) see the same semantics |
| `rewriteRelativeImportExtensions` | sources import `./x.ts`; emitted JS imports `./x.js` (verified in `dist/main.js`) |
| `forceConsistentCasingInFileNames` | Windows is case-insensitive, CI Linux is not |
| `declaration`, `declarationMap`, `sourceMap`, `newLine: "lf"` | debuggable shipped code, LF output on Windows |
| `resolveJsonModule: false` | JSON is read at runtime with validation, never imported |

Three configuration kinds:
1. `tsconfig.check.json` (root) = base + `noEmit: true` + `customConditions: ["@mcs/source"]`. Every package `tsconfig.json` extends it and
   includes `src` (+ `test`). `shared` overrides `lib: ["es2024"]` and `types: []`, so a stray `process` or `Buffer` in shared fails the type
   check (in addition to the lint rule). `web` overrides `lib` (+DOM), `module: esnext`, `moduleResolution: bundler`, `jsx: react-jsx`,
   `allowImportingTsExtensions: true`, `rewriteRelativeImportExtensions: false`, `types: ["vite/client", "@testing-library/jest-dom/vitest"]`.
2. `packages/<p>/tsconfig.build.json` = base + `composite`, `rootDir: src`, `outDir: dist`, `tsBuildInfoFile: dist/.tsbuildinfo`,
   `exclude: ["src/**/*.test.ts"]`, `references` to its workspace dependencies. No custom condition: imports of `@mcs/*` resolve to the
   referenced projects' outputs.
3. `runtime/tests/tsconfig.json` and `packages/web/e2e/tsconfig.json` extend the check config (Node types).

`npm run typecheck` runs `tsc -p <project>` for the eight projects in sequence (shared, engine, server, cli, testkit, web, tests, web/e2e);
each resolves sibling packages to their sources through the condition, so type checking never needs `dist/` (verified: `--listFilesOnly`
on server lists `packages/shared/src/*.ts` with no `dist` present). Measured 4.5-6.5 s.

### 2.5 npm configuration

`.npmrc` (committed):
```
ignore-scripts=true      # better-sqlite3 lockfile installs otherwise run node-gyp and fail without Visual Studio; supply-chain hygiene
save-exact=true          # every `npm install <pkg>` writes an exact version
fund=false
update-notifier=false    # quiet, deterministic output for the launcher
```
Consequences: no lifecycle script runs, including the root package's own (`postinstall`, `prepare`); anything that must happen after
install is done explicitly by the launcher or by `npm run build`. `engine-strict` is NOT set (react-router declares `>=22.22.0`, see
CHALLENGES C-1; a hard failure inside `npm ci` is worse than the launcher's own clear Node check). `min-release-age` is NOT put in
`.npmrc` because npm 10 (bundled with Node 22) warns on unknown keys during every install; the dependency-update procedure (section 5.5,
S-DEP-6) passes it on the command line with npm >= 11.10.

Root `package.json` fields: `"private": true`, `"type": "module"`, `"workspaces"` (explicit list of six, not a glob, so a stray folder
is never a package), `"engines": { "node": "^22.22.0 || ^24.0.0 || >=26.0.0" }`, `"overrides": { "eslint-plugin-jsx-a11y": { "eslint":
"$eslint" } }` (the only override; `check-deps` fails on any other). All package manifests: `"private": true`, `"type": "module"`,
`"files": ["dist"]`, `"license"` only on the root (`UNLICENSED`, nothing is published).

### 2.6 ESLint

Configuration: Appendix A.9. Base: `@eslint/js` recommended, `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked` with
`projectService` (each file is linted with the type info of its nearest `tsconfig.json`; root `*.config.ts` via `allowDefaultProject`),
`linterOptions.reportUnusedDisableDirectives: "error"`. Flat config replaces a rule per block, so the file builds every
`no-restricted-imports` value with `restrictImports()` (global bans + block bans) and the web globals with `webGlobals(...allowed)`.

| Guarantee | Rule(s) | Scope | Probe result (section 9, E6/E7) |
|---|---|---|---|
| No `any` | `@typescript-eslint/no-explicit-any` + `no-unsafe-*` (strict preset) | all TS | `const v: any` -> error |
| No unsafe assertions | `@typescript-eslint/consistent-type-assertions: { assertionStyle: "never" }` (`as const` still allowed); `no-non-null-assertion` (preset) | non-test TS | `JSON.parse(x) as number` -> error; `as const` ok |
| Exhaustive switches | `@typescript-eslint/switch-exhaustiveness-check` | all TS | (preset behaviour) |
| Type-only imports explicit | `consistent-type-imports`, `no-import-type-side-effects` | all TS | |
| No raw HTML | `no-restricted-syntax`: `dangerouslySetInnerHTML`, assignment to `innerHTML`/`outerHTML`, `insertAdjacentHTML(...)`, `document.write(ln)` | all TS (web is where it matters) | all four -> error. Note: an earlier selector on any `.write()` call also matched `process.stdout.write`; the selector is restricted to `document` |
| No computed `href/src/srcDoc/formAction/action`, no `target="_blank"`, no `javascript:` | `no-restricted-syntax` (web), `no-script-url` | web src | both -> error |
| No eval | `no-eval`, `no-new-func`, `@typescript-eslint/no-implied-eval` (preset) | all | |
| No console | `no-console` | all TS (scripts `*.mjs` exempt) | `console.log` in engine -> error |
| Process streams only via sinks | `no-restricted-properties` `process.stdout` / `process.stderr` | engine, server, cli src; allowed in `engine/src/log/logger.ts` and `cli/src/io/terminal.ts` | `process.stdout.write` in engine -> error |
| No shell | `no-restricted-syntax` `Property[key.name='shell'][value.value=true]`; `exec`/`execSync` import names banned | all TS | `{ shell: true }` -> error |
| One process launcher | `node:child_process` banned except `engine/src/platform/exec.ts` | engine, server, cli | import in server/engine -> error |
| One SQLite module | `better-sqlite3` banned except `engine/src/db/driver.ts` (03 section 4.5, which adds a grep test); banned in server/cli | engine, server, cli | -> error (re-verified after the rename, E22) |
| Platform branching in one place (06 section 4, critic issue I-34) | `no-restricted-properties` entry `PLATFORM_ENTRY` (`process.platform`) next to `NO_STDIO`; `no-restricted-syntax` `CallExpression[callee.object.name='os'][callee.property.name='platform']` | `packages/engine/src/**`; allow-list `engine/src/platform/**` and `engine/src/security/paths.ts` (block re-declares `['error', ...NO_STDIO]` and the base syntax list); logger block `['error', PLATFORM_ENTRY]`; shared, cli, server, `scripts/**` and test files exempt | 06 E24: `process.platform` in `engine/src/panels/x.ts` -> error; `platform/x.ts`, `security/paths.ts`, `shared/src/protocol/x.ts` -> none; re-run on the A.9 file here (E24 of this design); regression test 06 PP1 `engine/test/platform/platform-branching.test.ts` |
| Layering | `shared` imports no `node:*`/builtins/`@mcs/*`; `shared/protocol` imports no `zod` and no `../`; `engine` imports no server/cli/web/testkit/express/react; `server` no cli/web/testkit/react; `cli` no server/web/testkit/express/react; `web` no node builtins, no engine/server/cli/testkit/express/better-sqlite3/zod | per package | every case -> error |
| Hook handler stays tiny | `cli/src/hook.ts`, `cli/src/hook/**`: regex `^(?!node:\|@mcs/shared/protocol$\|\./)` | hook files | `zod`, `@mcs/shared`, `../io/terminal.ts` -> error; `node:crypto`, `@mcs/shared/protocol` ok |
| No deep imports | `@mcs/*/src/*`, `@mcs/*/dist/*`, relative `../(../)*(shared\|engine\|...)/` | all | both -> error |
| Banned packages | axios, node-fetch, lodash, moment, date-fns, uuid, dotenv, commander, yargs, ws, socket.io, cors, body-parser, jsdom, rehype-raw, marked, markdown-it, ts-node, tsx, pino | all | `axios` -> error |
| UI rules of 04 section 8 | `react-markdown`, `remark*`, `rehype*`, `dompurify`, `react-router-dom` banned; `lucide-react` only in `src/components/icons.ts`; `**/test/**`, `**/fixtures/**` not importable from production; `fetch` only in `src/data/api-client.ts`, `EventSource` only in `src/stream/stream-client.ts`, storage only in `src/lib/prefs.ts`; `src/lib/**` imports no react/router/query | web | every case -> error |
| React correctness, a11y | `react-hooks` recommended (incl. v7 compiler-derived rules such as `immutability`), `jsx-a11y` recommended | web | conditional hook, missing `alt`, click without key handler -> error |
| Tests deterministic | `setTimeout(...)` banned in test files ("use fake timers or `waitFor`") | `TEST_FILES` | -> error |
| Tests may assert | assertions, non-null assertions, `process.stdout` allowed | `TEST_FILES` | `as number` in test -> ok |

Import order is not linted (no core rule sorts declarations; adding eslint-plugin-import for ordering alone is not justified). Prettier keeps
formatting; reviewers keep the group order "node builtins, external, `@mcs/*`, relative" by convention (documented in `docs/testing.md`).

`tests/tooling/lint-rules.test.ts` (slice S1) turns the probes of section 9 into a regression test: it writes each probe file into a
temporary folder `packages/<p>/src/__lint_probe__/` (ignored by the main lint run through `ignores`; excluded from the package
`tsconfig.json` through `exclude`), runs the ESLint Node API with `ignore: false`, asserts the exact `ruleId` per line, and deletes the folder
in `finally`. UNVERIFIED: whether `projectService` type-checks a file excluded from its tsconfig without a parse error; if it does not, the
probes use `languageOptions.parserOptions.project` pointing at a dedicated `tests/tooling/probe.tsconfig.json`. Verify in slice S1.

### 2.7 Prettier, EditorConfig, line endings (Windows)

Prettier 3.9.10: `singleQuote`, `printWidth: 120`, `trailingComma: "all"`, `endOfLine: "lf"`. `.prettierignore`: `dist/`, `coverage/`,
`node_modules/`, `test-results/`, `playwright-report/`, `.dev/`, `package-lock.json`. Prettier rewrites `package.json` arrays one item per
line; npm writes the same shape, so `npm install` and `prettier --check` do not fight (verified after `npm install -D` in section 9).

Line endings: the skill repo already has `.gitattributes` `* text=auto eol=lf` while this machine has `core.autocrlf=true`; `git check-attr`
confirms `eol: lf` for new paths (`runtime/package-lock.json`, `scripts/mcs.mjs`). A CRLF file fails `prettier --check` (verified). Build
stamps hash raw bytes, so a checkout that converts line endings only triggers a rebuild, never a wrong reuse. `.editorconfig`
mirrors Prettier for editors.

### 2.8 Vitest

Root `vitest.config.ts` (Appendix A.10): `ssr.resolve.conditions: ['@mcs/source', 'node', 'import', 'default']` is REQUIRED (without it
Node-environment projects fail with `Failed to resolve entry for package "@mcs/testkit"`; a top-level `resolve.conditions` alone is
neither needed nor sufficient, verified E9). Defaults inherited by every inline project (`extends: true`): `restoreMocks`, `unstubEnvs`,
`unstubGlobals`, `testTimeout: 10000`, `hookTimeout: 20000`, `env: { TZ: 'UTC', MCS_HOOK_DISABLE: '1' }`, `retry: 0` (default).

| Project | Include | Environment / pool | Resources | Script |
|---|---|---|---|---|
| `unit` | `packages/{shared,engine,server,cli,testkit}/src/**/*.test.ts` | node / threads | none (pure; fake clock, in-memory) | `test:unit` |
| `web` | `packages/web/vitest.config.ts` (04): `src/**/*.test.{ts,tsx}` | happy-dom | none | `test:unit` |
| `integration` | `packages/*/test/**/*.int.test.ts` | node / forks | temp dirs, real SQLite files, HTTP on 18000-18499, child processes | `test:int` |
| `isolation` | `tests/isolation/**/*.test.ts` | node / forks | two or more real instances | `test:isolation` |
| `resilience` | `tests/resilience/**/*.test.ts` | node / forks | real files, processes | `test:resilience` |
| `security` | `tests/security/**/*.test.ts` | node / forks | real server, canaries | `test:security` |
| `parity` | `tests/parity/**/*.test.ts` | node / forks | Python 3 for live mode | `test:parity` |
| `tooling` | `tests/tooling/**/*.test.ts` | node / forks | ESLint API, scripts | `test:tooling` |

Projects `security` and `tooling` are added to the root config by slices S8/S1 (the scaffold-check had the other six; the mechanism is
identical). Coverage (`npm run test:coverage`, projects unit+web+integration): provider v8, include `packages/*/src/**/*.{ts,tsx}`,
exclude tests, testkit, entry files (`main.ts`, `main.tsx`, `hook.ts`, `index.ts`); thresholds in section 4.13 (verified that a shortfall
fails the run, E10).

### 2.9 `.gitignore` additions (skill root)

```
# Node runtime (v3)
runtime/node_modules/
runtime/packages/*/dist/
runtime/coverage/
runtime/.mcs-build.json
runtime/.dev/
runtime/packages/web/e2e/test-results/
runtime/packages/web/e2e/playwright-report/
*.tsbuildinfo
```
The existing entries (`node_modules/`, `state.json`, `*.state.json`, `__pycache__/`) stay. No source file may be named `state.json`.

---

## 3. Commands

### 3.1 Root scripts (`cd runtime && npm run <name>`)

| Script | Command | Purpose | Network | Exit |
|---|---|---|---|---|
| `install` (npm built-in) | `npm ci` | exact install from lockfile (scripts ignored) | yes, or `--offline` from cache | npm's |
| `clean` | `node scripts/clean.mjs` | remove all `dist/`, `coverage/`, `.mcs-build.json` | no | 0 |
| `build` | `clean && tsc -b tsconfig.build.json && npm run build -w @mcs/web && build-stamp write` | production build | no | non-zero on any failure |
| `typecheck` | `node scripts/typecheck.mjs` | 8 projects, `noEmit` | no | 1 if any fails |
| `lint` / `lint:fix` | `eslint . --max-warnings 0` / `--fix` | static rules | no | |
| `format` / `format:check` | `prettier --write .` / `--check .` | formatting | no | |
| `check:deps` | `node scripts/check-deps.mjs` | pins, versions, declared imports, overrides | no | 1 on problems |
| `check:text` | `node scripts/check-text.mjs` (S9) | English-only + private-data patterns (5.3 S-LOG-5) | no | |
| `check:docs` | `node scripts/check-docs.mjs` (S10) | doc links, required sections (6.6) | no | |
| `test` | `vitest run --project unit --project web --project integration --project isolation --project resilience --project security` | all offline suites | no | |
| `test:unit`, `test:int`, `test:isolation`, `test:resilience`, `test:security`, `test:parity`, `test:tooling` | `vitest run --project <x>` | one layer | parity live mode needs Python | |
| `test:coverage` | `vitest run --coverage --project unit --project web --project integration` | thresholds | no | 1 below threshold |
| `test:stress` | `node scripts/stress.mjs` | isolation+resilience+security, 3 runs, `--sequence.shuffle --sequence.seed=<1..3>` | no | |
| `test:e2e` | `playwright test -c packages/web/e2e/playwright.config.ts` | browser E2E (installed Chrome) | no | |
| `dev` | `node scripts/dev.mjs [--api-port 18765 --web-port 18766] [-- <server args>]` | server from sources (`node --watch --conditions=@mcs/source`) + Vite dev with `/api` proxy | no | |
| `start` | `node packages/cli/dist/main.js start` (+ args after `--`) | start an instance | no | CLI's |
| `migrate` | `node packages/cli/dist/main.js db migrate` | DB migrations for `--task` (01 section 5.4 `mcs db migrate`) | no | CLI's |
| `health` | `node packages/cli/dist/main.js verify` | health check of a running instance | no | CLI's |
| `init-instance` | `node packages/cli/dist/main.js init` | create an instance | no | CLI's |
| `audit` / `audit:prod` | `npm audit --audit-level=low` / `--omit=dev` | advisories | yes | 1 on findings |
| `ci` | `node scripts/ci.mjs [--offline] [--keep-going]` | gates of section 8 | audit only | 1 unless all PASS |
| `ci:full` | `node scripts/ci.mjs --full` | + parity + e2e | audit | |
| `release-check` | `node scripts/release-check.mjs` (S9) | section 7.1 sequence with a report file | audit | |
| `parity:capture` | `node scripts/parity-capture.mjs` (S8) | regenerate goldens with design 06's `capture_golden.py` (4.11.4) | no | wrapper passes the tool's exit code |
| `parity:check` | `node scripts/parity-capture.mjs --check` (S8) | golden drift check (`capture_golden.py --check`) | no | 0 identical, 1 drift, 2 no usable Python |
| `schemas` | `node scripts/gen-schemas.mjs` (01 S16) | regenerate the committed JSON Schemas: `<skill>/schemas/*.json` (01 2.9) and `schemas/api/**` (03 section 13 item 4); one generator for both (registry C45) | no | 1 on error |
| `schemas:check` | `node scripts/gen-schemas.mjs --check` (01 S16) | regenerate into a temp folder and byte-compare with the committed files | no | 0 identical, 1 drift |
| `parity:shadow` | `node scripts/parity-shadow.mjs` (06 section 5.6, slice PP9) | live shadow comparison on the owner's task (`-- --task <slug> ...`) | no | 06's |
| `bench` | runs `runtime/bench/*.mjs` in sequence (06 section 8.3; slice PP10 writes the exact command) | performance budgets B1-B7, phase boundaries only | no | 1 when a budget fails |
| `testkit` | `node packages/testkit/dist/cli.js` (06 section 6.4, slice PP6) | fixture CLI `list`, `demo`, `scenario`, `big` | no | 06's |

Agents and the SKILL use `node .claude/skills/monitoring-claude-sessions/scripts/mcs.mjs <command>` ($MCS, D6). The npm wrappers above
exist for developers inside `runtime/`; they never bootstrap. Appendix A.1 is the slice S1 baseline: the scripts marked with a slice
(`check:text`, `check:docs`, `test:security`, `test:tooling`, `test:stress`, `release-check`, `parity:capture`, and `--project security`
in `test`, and `parity:check`) are added to `package.json` and `ci.mjs` by that slice together with the script file; likewise `schemas`,
`schemas:check` (01 S16), `parity:shadow` (06 PP9), `bench` (06 PP10) and `testkit` (06 PP6) are added to `package.json` by the named
slice (registry C45). None of these five is a `ci` gate.

### 3.2 Repository scripts (all zero-dependency ESM, Node >= 22.22.0, the one floor of 01 section 5.1 with its message, critic I-05, registry C28; Appendix A.31-A.38)

Common rules: spawn only `process.execPath` with a JS entry resolved from the tool's `package.json` `bin` field (`lib.mjs binPath()`),
never a `.cmd` shim (Node refuses `.cmd` without a shell, E12), `shell: false`, `windowsHide: true`; print one summary line per step;
non-zero exit on failure; no network except `npm audit`.

- `lib.mjs`: `RUNTIME_ROOT`, `PACKAGES`, `readJson`, `binPath(pkg, bin?)`, `runNode(script, args, {cwd, stdio, env}) -> Promise<exitCode>`.
- `clean.mjs`: removes the paths in 2.3 with `rmSync({recursive, force, maxRetries: 5})` (Windows file locks).
- `typecheck.mjs`: sequential `tsc -p` over the eight projects; prints `typecheck <project>: ok|FAILED (exit n) <ms> ms`.
- `check-deps.mjs` rules (each failure prints `check-deps: <file>: <problem>`):
  1. every dependency spec in every manifest is `x.y.z[-pre]` or `npm:<name>@x.y.z`;
  2. every workspace manifest `version` equals root `version`; every `@mcs/*` dependency spec equals it; every workspace is `private`;
  3. root `overrides` keys are exactly `["eslint-plugin-jsx-a11y"]`;
  4. for each `.ts/.tsx` file of a package, every bare import specifier (excluding `node:*` and builtins) maps to a package declared in
     that package's `dependencies`; test files (`*.test.*`, `/test/`, `/e2e/`, `test-setup`, `*.config.ts`) and `import type` may also use
     the package `devDependencies` and the root `devDependencies`.
- `build-stamp.mjs`: section 3.3.
- `ci.mjs`: section 8.1.
- `smoke.mjs` (critic N-02): drives the real CLI, never a server argv of its own (01 4.1 owns the `serve` argv). `$MCS` here is the
  built CLI `node packages/cli/dist/main.js` (what the launcher runs after bootstrap; the smoke never bootstraps). Steps: (1) readiness:
  when `packages/server/dist/boot.js` (01 S8) or `packages/engine/dist/ops/lifecycle.js` (01 S9, `start`/`stop`) is missing, print
  `smoke: SKIPPED (01 S8/S9 not built: <missing path>)` and exit 77, which `ci.mjs` records as `SKIPPED` (8.1); (2) temp root
  `mcs-smoke-<random>` with `FIXTURE.md`, `MCS_HOME=<tmp>/mcs-home`, `CLAUDE_CONFIG_DIR=<tmp>/claude-home` (empty), `repo=<tmp>/repo`,
  env `MCS_HOOK_DISABLE=1`; (3) port = first free port in 18800-18849 (`exclusive: true` probe; registry C54); (4) `$MCS init --slug
  smoke --name "FIXTURE smoke" --repo <repo> --port <port>`, then `$MCS start --task smoke --repo <repo>`, each must exit 0; (5) `GET
  /api/v3/health` with `Host: 127.0.0.1:<port>` polled up to 10 s until 200, then once with `Host: evil.example`, expecting 403; (6) in
  `finally`: `$MCS stop --task smoke --repo <repo>`, then assert the port is closed (connection refused within 5 s), remove the temp
  root. Exit 0 only when every step passed; one summary line `smoke: port <p> health <s>, foreign host <s>, stop exit <n>, port
  closed <bool>`. The broader flow (`verify`, `status`, `restart`, a second instance, `doctor`) is release step 7.1-9.
- `dev.mjs`: section 3.1; sets `MCS_HOOK_DISABLE=1`, `MCS_DEV_API=http://127.0.0.1:<api>`, `MCS_WEB_DEV_PORT=<web>` (04's env names);
  if either child exits the other is killed. Known limit: `taskkill /F` on the parent orphans the children on Windows (no signal
  propagation); stop with Ctrl+C in the console.
- `stress.mjs` (S9): runs `vitest run --project isolation --project resilience --project security --sequence.shuffle
  --sequence.seed=<s>` for s = 1, 2, 3 (flags verified on Vitest 5.0.3, E11); fails if any run fails; prints the seed of a failing run.
- `release-check.mjs` (S9): executes section 7.1 steps 2-9 and writes a Markdown report to the path given by `--out <file>` (required;
  outside the repository by convention, for example the lead's scratch folder); the report is the input of the migration report (7.2).
  It never claims a step it did not run: such rows read `SKIPPED (<reason>)`.

### 3.3 Install and build stamps (launcher contract, ADR 0047)

#### 3.3.1 Files

`runtime/node_modules/.mcs-install.json` (written only after a successful `npm ci`; lives inside `node_modules` so deleting
`node_modules` deletes it):
```json
{ "schemaVersion": 1, "installStamp": "win32-x64-node24:<sha256 hex>", "installedAt": "2026-10-11T07:23:07.576Z" }
```
`runtime/.mcs-build.json` (written only by the last step of a successful `npm run build`):
```json
{ "schemaVersion": 1, "runtimeVersion": "3.0.0", "buildStamp": "<sha256 hex>", "codeStamp": "<first 10 hex>",
  "node": "v24.14.1", "builtAt": "2026-10-11T07:23:07.576Z" }
```
`codeStamp` is the Node engine's equivalent of the legacy 10-hex `code_stamp` (current-state-backend C.10); the server reads it at start
and reports it in health; the server and `status` compare the running instance's boot `codeStamp` with the `codeStamp` of
`runtime/.mcs-build.json` (the built code on disk, not the source tree) to set `outdated` (01 section 5.3 owns that use; registry C30).

#### 3.3.2 Algorithm (`computeStamps(root)`)

1. `platform = <process.platform>-<process.arch>-node<major>`.
2. `digest(files)`: sort the root-relative POSIX paths; SHA-256 over, per path, `path + "\0" + bytes + "\0"`; hex.
3. `installStamp = platform + ":" + digest([package-lock.json, .npmrc])`.
4. `buildStamp = digest(buildInputs)` where `buildInputs` = root `package.json`, `package-lock.json`, `tsconfig.base.json`,
   `tsconfig.build.json`; for each package except testkit: `package.json`, every `tsconfig*.json`, `vite.config.ts`, `index.html` that
   exists, every file under `src/` except `*.test.ts(x)` and `test-setup.ts`, and for web every file under `public/`. Directories named
   `node_modules`, `dist`, `coverage`, `test`, `test-results` are skipped. Paths are relative, so the stamp is identical in any checkout
   location (verified: two copies gave the same `dbf346b34f...`).
5. `staleness(root)` returns `{ install, build, reasons, installStamp, buildStamp }`: `install = installed?.installStamp !== now.installStamp`
   (reason `no install stamp` or `lockfile, .npmrc or platform changed`); `build = install || built?.buildStamp !== now.buildStamp` (reason
   `no build stamp` or `sources changed since last build`).
Measured: 9 ms warm, 103 ms cold for the scaffold; expected under 150 ms for the real tree (a few hundred files). Verified behaviours:
editing a test file leaves `build: false`; editing a source sets `build: true`; editing `.npmrc` sets `install: true`.

#### 3.3.3 Exported API (the launcher imports this file; it must stay zero-dependency)

```ts
// runtime/scripts/build-stamp.mjs
export const STAMP_SCHEMA_VERSION: 1;
export const BUILD_STAMP_FILE: '.mcs-build.json';
export const INSTALL_STAMP_FILE: 'node_modules/.mcs-install.json';  // joined with the platform separator
export function computeStamps(root?: string): { installStamp: string; buildStamp: string };
export function staleness(root?: string): { install: boolean; build: boolean; reasons: string[]; installStamp: string; buildStamp: string };
// CLI: node build-stamp.mjs check (exit 0 current, 1 stale, prints JSON) | write | write-install
```

#### 3.3.4 Stamp contract the launcher relies on (the bootstrap steps are design 01's)

The launcher algorithm (Node floor and its message, mutex, `RUNTIME_IN_USE` guard, npm resolution, progress messages,
`runtime/.mcs-bootstrap.log`, verification) is normative in 01 section 5.1 and is not restated here (registry C29). This design
guarantees only the stamp side:
1. `staleness(runtimeRoot)` (3.3.3) is the only staleness test; `{ install: false, build: false }` means the CLI can run without a
   bootstrap. It is cheap enough to call twice (before and after acquiring the bootstrap mutex, 01 5.1 step 6a).
2. The install stamp is written only by `node scripts/build-stamp.mjs write-install`, which the launcher runs after a successful
   `npm ci` (root lifecycle scripts do not run under `ignore-scripts`, C-4); the build stamp only by the last step of `npm run build`.
3. Stamps are written atomically (temp + rename) and only after success, so a failed or killed bootstrap never leaves a stamp that
   claims a state which does not exist.
4. `build-stamp.mjs` stays zero-dependency and importable by path before any install (the launcher imports it, 01 5.1 step 4).
Measured costs on this machine: `npm ci` 6.8-7.2 s from a warm cache, 15.7 s with an empty cache (397 packages, 273 MB `node_modules`,
largest: lucide-react 42 MB, better-sqlite3 26 MB, typescript 24 MB, @rolldown 21 MB); build 1.9-5.4 s.

---

## 4. Test strategy

### 4.1 Layers

| Layer | Location / naming | Runner | Real resources | Release-blocking |
|---|---|---|---|---|
| Unit | `packages/<p>/src/**/<module>.test.ts` next to the module | Vitest `unit` | none | yes |
| Component | `packages/web/src/**/<Component>.test.tsx` (04 section 11) | Vitest `web` | happy-dom | yes |
| Integration | `packages/<p>/test/<area>.int.test.ts` | Vitest `integration` | temp dirs, SQLite files, HTTP, child processes | yes |
| Isolation | `runtime/tests/isolation/<guarantee>.test.ts` | Vitest `isolation` | 2+ instances, real CLI processes | yes (brief section 4) |
| Resilience | `runtime/tests/resilience/<case>.test.ts` | Vitest `resilience` | files, processes, kill -9 | yes |
| Security / privacy | `runtime/tests/security/<control>.test.ts` | Vitest `security` | server, canaries | yes |
| Tooling | `runtime/tests/tooling/<tool>.test.ts` | Vitest `tooling` | ESLint API, scripts | yes |
| Parity (Python oracle) | `runtime/tests/parity/<projection>.test.ts` + goldens in `tests/legacy-parity/` | Vitest `parity` | Python 3 (live mode) | yes for Phase 6 sign-off |
| E2E | `packages/web/e2e/specs/<flow>.spec.ts` (04 section 11.4) | Playwright, installed Chrome | built runtime, real instances | yes |
| Legacy suites | `tests/test_*.py`, `tests/frontend/*.test.mjs` (read-only) | `python -m unittest`, `node --test` | | yes until the fallback is retired |

Naming: `describe('<unit or guarantee>')`, `it('<observable behaviour in present tense>')`; an id prefix where a matrix references the
test, e.g. `it('T-ISO-09 token totals exclude the other instance')`, `it('legacy: ...')` for ported Python tests (04 uses `legacy:`). Test
titles are English and contain no private data. File suffixes: `.test.ts(x)` unit/component, `.int.test.ts` integration, `.spec.ts`
Playwright only.

### 4.2 Brief section 14 coverage map

| Brief item | Test file(s) (owner slice) |
|---|---|
| Unit: schema validation | `shared/src/**/*.test.ts` (shared slice) |
| Unit: configuration merging | `engine/src/config/merge.test.ts`, `provenance.test.ts` (01 S5); Python-regex dialect `shared/src/pyregex/*.test.ts` (01 section 2.8, S3) and `runtime/tests/parity/pyregex.golden.test.ts` (01 S3) |
| Unit: lifecycle transitions | `engine/src/lifecycle/transitions.test.ts` (02 section 7.7 table) + `properties.test.ts` (02 section 9.5); test ids `T-LF-*` (02 lifecycle model, critic N-12) |
| Unit: token aggregation | `engine/src/tokens/aggregate.test.ts`, `worked-example.test.ts` (02 sections 6.4, 9.5) |
| Unit: deduplication | `engine/src/ingest/dedupe.test.ts`; message-id dedupe across files in `engine/src/tokens/aggregate.test.ts` (02 section 6) |
| Unit: transcript parsing | `engine/src/ingest/transcripts/normalize-record.test.ts` (fixture records 1-25 of transcript-survey section 8; 02 section 5) |
| Unit: incremental offsets | `engine/src/ingest/tail/jsonl-tailer.test.ts` (ported `test_reader.py`; 02 section 5.3) |
| Unit: filtering | `shared/src/api/filters.test.ts` (03 section 23 S3), `web/src/lib/filters.test.ts` (04) |
| Unit: instance routing | `shared/src/protocol/routes.test.ts` (`matchRoutes`, 02 T-HK-05 unit part) |
| Unit: retention calculations | `engine/src/maintenance/retention.test.ts` (03 section 3.8) |
| Integration: hook payload to database | `engine/test/hook-to-db.int.test.ts` (handler process -> spool -> drain -> rows) |
| Integration: database to API | `server/test/api-*.int.test.ts` |
| Integration: API to frontend data model | `server/test/api-to-web.int.test.ts` (04 section 11.3) |
| Integration: persistence before broadcast | `server/test/persist-then-publish.int.test.ts` |
| Integration: realtime reconnect and reconciliation | `server/test/stream-reconnect.int.test.ts` (04 section 11.3) |
| Integration: transcript import and token accounting | `engine/test/import-tokens.int.test.ts` |
| Integration: CLI diagnostics | `cli/test/doctor.int.test.ts`, `cli/test/status.int.test.ts` |
| Integration: instance initialization and shutdown | `cli/test/lifecycle.int.test.ts` (ports from 18000-18499, real processes) |
| E2E 1-14 | `packages/web/e2e/specs/lifecycle.spec.ts` steps 1-14 (04 section 11.4) |

### 4.3 Directory layout of cross-package suites

```
runtime/tests/
  tsconfig.json
  isolation/   _setup.ts  (this design, S9: shared two-instance setup; the only file of this folder owned here, 4.8)
               the isolation-project tests of 01 T-ISO-* grouped by brief bullet; each file belongs to the 01 slice that implements
               its rows, hook-routing-isolation.test.ts to 02 (T-HK-05) (4.8, critic N-07):
               read-isolation.test.ts  config-write-isolation.test.ts  token-isolation.test.ts  search-isolation.test.ts
               lifecycle-isolation.test.ts  restart-isolation.test.ts  ownership-isolation.test.ts  upgrade-isolation.test.ts
               hook-routing-isolation.test.ts  db-identity.test.ts
  resilience/  partial-line.test.ts  truncation.test.ts  rotation.test.ts  duplicates.test.ts  out-of-order.test.ts
               restart-recovery.test.ts  upgrade-migrations.test.ts  partial-init.test.ts  concurrency.test.ts  large-file.test.ts
               malformed-input.test.ts  storage-errors.test.ts  hook-failsafe.test.ts
  security/    host-origin.test.ts  csrf.test.ts  limits.test.ts  headers.test.ts  path-containment.test.ts  privacy-canaries.test.ts
               terminal-output.test.ts  subprocess.test.ts  logger-allowlist.test.ts  hook-ingest.test.ts  secrets-never-read.test.ts
  parity/      projections.ts  normalize.ts  run-python.ts                                  (this design, slice S8)
               pyjson.golden.test.ts  pyregex.golden.test.ts                                 (design 01, slices S2/S3; the golden
                                                  JSON stays in tests/legacy-parity/{pyjson,regex}/, where @mcs/* does not resolve, C-3)
               reference-usage.ts  legacy-trees.parity.test.ts  vectors.parity.test.ts       (design 06, slice PP4)
               sessions|events|search|attempts|panels|tokens|config-regex|workspace-files|diffs.parity.test.ts
                                                                                             (design 06, slice PP8; field matrix 06 5.4)
               shadow.test.ts                                                                (design 06, slice PP9)
  tooling/     lint-rules.test.ts  check-deps.test.ts  build-stamp.test.ts  ci-script.test.ts  parity-capture.test.ts
               env-vars.test.ts   (asserts every `MCS_*` name read under `runtime/packages/*/src` and `scripts/` is in 01 section 2.10)
```
(`parity/*.parity.test.ts` matches the project's `**/*.test.ts` include.)

### 4.4 `@mcs/testkit` (fixture library)

Rules: every artefact is synthetic and labelled. Every generated string that stands for user content starts with `FIXTURE` (for example
`FIXTURE prompt 3`); every temp root is named `mcs-<purpose>-<random>` and contains a `FIXTURE.md` marker (`Synthetic test data generated by
@mcs/testkit. Not real data.`); no real paths, names, emails or tokens; TypeScript fixture files under `packages/web/src/test/fixtures/` start
with `// FIXTURE: invented data for tests` (04 UI-I12). Builders are pure until `write*`/`build*` is called. Testkit never reads the
real `~/.claude`.

Modules and signatures (`packages/testkit/src/`):

```ts
// temp.ts
export interface TempDir { readonly path: string; remove(): void }
export function makeTempDir(purpose: string): TempDir;            // mkdtemp under os.tmpdir(), writes FIXTURE.md
export function useTempDirs(): (purpose: string) => TempDir;      // registers afterEach cleanup (vitest), returns a factory

// ports.ts  (ranges in 4.5; the only free-port helper, registry C32: 01 3.5 and 04 11.4 call it instead of a findFreePort)
export type PortRange = readonly [min: number, max: number];
export const VITEST_PORTS: PortRange;                             // [18000, 18499]
export function allocatePort(range?: PortRange): Promise<number>; // default VITEST_PORTS: block of 50 per VITEST_POOL_ID; another range
                                                                  // (Playwright: allocatePort([18500, 18599])) is scanned from its start;
                                                                  // exclusive listen probe on 127.0.0.1; throws when the range is full
export function assertPortClosed(port: number): Promise<void>;    // throws if something still listens

// wait.ts  (the only sanctioned polling)
export function waitFor<T>(probe: () => T | Promise<T>, opts?: { timeoutMs?: number; intervalMs?: number; what?: string }):
  Promise<NonNullable<T>>;                                        // default 5000 / 25 ms; error names `what` and last value
export function eventLoopLagProbe(): { stop(): { maxMs: number; p99Ms: number } }; // perf_hooks.monitorEventLoopDelay

// clock.ts  (the interface is 01's: packages/shared/src/time.ts, registry C27; testkit declares only the fake)
import type { Clock } from '@mcs/shared';
export class FakeClock implements Clock { constructor(startMs: number); now(): number; advance(ms: number): void; set(ms: number): void }
export const FIXTURE_EPOCH_MS: number;                            // Date.UTC(2026, 0, 1)

// processes.ts
export interface TrackedProcess { readonly pid: number; readonly exited: Promise<number | null>; kill(): void }
export function spawnTracked(file: string, args: readonly string[], opts?: { cwd?: string; env?: Record<string, string> }): TrackedProcess;
export function killAllTracked(): Promise<void>;                  // afterAll; taskkill /F semantics on Windows
export function runCli(args: readonly string[], opts: { mcsHome: string; cwd?: string; env?: Record<string, string> }):
  Promise<{ code: number; stdout: string; stderr: string }>;      // node packages/cli/dist/main.js; MCS_HOOK_DISABLE=1 always

// isolation.ts  (the fixtures 01 section 3.5 names, registry C33; 01's tempRoot = makeTempDir, snapshotWorkspace = snapshotTree with
// the runtime-mutable paths excluded, makeWorkspace = runCli(['init', ...]))
export function hermeticEnv(root: string): Record<string, string>;
  // minimal env: PATH, win32 SystemRoot/TEMP/TMP, HOME and USERPROFILE -> <root>/home, MCS_HOME=<root>/mcs-home,
  // CLAUDE_CONFIG_DIR=<root>/claude-home, MCS_HOOK_DISABLE=1, TZ=UTC; nothing else inherited (no MCS_*, CLAUDE_* of the parent)
export interface StartedInstance { readonly repo: string; readonly slug: string; readonly port: number; readonly pid: number; stop(): Promise<void> }
export function startInstance(ws: { repo: string; slug: string; env: Record<string, string> }, opts: { port: number }):
  Promise<StartedInstance>;                                       // real `$MCS start` through runCli; waits for /api/v3/health 200;
                                                                  // stop() = `$MCS stop` + assertPortClosed (also run by killAllTracked)
export function spawnImpostor(argv: readonly string[]): TrackedProcess; // idle Node child whose command line ends with argv (pid reuse)
export function makeJunction(link: string, target: string): void; // win32 fs.symlinkSync(target, link, 'junction') (no shell, no
                                                                  // privilege needed); elsewhere a 'dir' symlink

// http.ts  (agent: false on every request: E8 showed a reused keep-alive socket reset under Vitest)
export function httpRequest(port: number, path: string, opts?: { method?: string; host?: string; origin?: string;
  headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
export function readSse(port: number, path: string, opts: { lastEventId?: string; maxEvents: number; timeoutMs: number }):
  Promise<{ id?: string; event?: string; data: string }[]>;

// transcript.ts  (record shapes from transcript-survey section 8; reference/transcript-format.md)
export interface UsageFixture { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number; iterations?: readonly UsageFixture[] }
export class TranscriptBuilder {
  constructor(opts: { sessionId: string; cwd: string; startMs: number; stepMs?: number; agentId?: string });
  user(text?: string): this;                                       // FIXTURE text by default
  assistant(opts: { messageId: string; text?: string; usage?: UsageFixture; stop?: 'end_turn' | 'tool_use' | null;
    model?: string; snapshots?: number }): this;                   // snapshots>1 repeats the id (streaming records)
  toolUse(name: string, input?: Record<string, unknown>, opts?: { messageId?: string; id?: string }): string; // returns tool_use_id
  toolResult(toolUseId: string, opts?: { isError?: boolean; content?: string; denial?: boolean }): this;
  turnEnd(opts?: { pendingBackgroundAgentCount?: number; pendingWorkflowCount?: number }): this;
  interrupt(opts?: { forToolUse?: boolean }): this;
  apiError(status?: number): this;                                 // isApiErrorMessage, <synthetic>
  compact(): this;                                                 // compact_boundary + summary + cache_read reset
  bookkeeping(kind: 'last-prompt' | 'ai-title' | 'custom-title' | 'queue-operation' | 'file-history-snapshot' | 'cost-state' | 'continued-in'): this;
  agentLaunch(opts: { agentId: string; background: boolean }): string;
  raw(record: Record<string, unknown>): this;
  invalidLine(text?: string): this;
  lines(): string[];                                               // one JSON per line
  write(path: string, opts?: { newlineAtEnd?: boolean; crlf?: boolean; bom?: boolean; partialLastBytes?: number }): void;
  appendTo(path: string, fromLine: number): void;                  // grow a file in place
}
export function bigTranscript(opts: { sessionId: string; targetBytes: number; maxLineBytes?: number }): TranscriptBuilder;

// claude-home.ts  (a fake CLAUDE_CONFIG_DIR)
export interface SessionSpec { id: string; project: string; build(b: TranscriptBuilder): void; mtimeAgeMs?: number;
  subagents?: { agentId: string; meta: Record<string, unknown>; build(b: TranscriptBuilder): void }[];
  workflow?: { runId: string; finished: boolean; agents: string[] } }
export interface ClaudeHome { readonly root: string; readonly projectsDir: string; sessionPath(id: string): string }
export function buildClaudeHome(root: string, spec: { sessions: SessionSpec[]; registry?: Record<string, unknown>[];
  keyDecoys?: boolean; nowMs: number }): ClaudeHome;               // keyDecoys writes sessions/<pid>.key containing CANARY.key

// hooks.ts  (payload shapes: claude-code-hooks.md sections 2 and 11; event list and async set owned by design 02 section 2.4)
import { INSTALLED_HOOK_EVENTS, ASYNC_HOOK_EVENTS } from '@mcs/shared/protocol';
export type HookEventName = (typeof INSTALLED_HOOK_EVENTS)[number];   // the 21 installed events; testkit never lists them itself
export function hookPayload(event: HookEventName, base: { sessionId: string; cwd: string; transcriptPath: string },
  extra?: Record<string, unknown>): Record<string, unknown>;          // raw stdin payload as Claude Code sends it (hook_event_name = event)
export interface RunHookOptions {
  mcsHome: string;                 // temp per-user state folder; the handler reads routes from <mcsHome>/routes
  event?: HookEventName;           // argv event; default: payload.hook_event_name (required when rawStdin is used)
  async?: boolean;                 // append --async; default: ASYNC_HOOK_EVENTS includes the event
  direct?: boolean;                // true: spawn runtime/packages/cli/dist/hook.js directly (handler unit of 02); default false = the stub
  env?: Record<string, string>;    // merged over a minimal env; MCS_HOOK_DISABLE is removed unless set here
  rawStdin?: string;               // sent instead of JSON.stringify(payload) (malformed-input cases)
}
export function runHookHandler(payload: unknown, opts: RunHookOptions):
  Promise<{ code: number; stdout: string; stderr: string; durationMs: number }>;
// Default spawn = the installed command of 02 section 2.1: process.execPath ['--no-warnings', <skill>/scripts/mcs-hook.mjs,
// '--mcs-hook', <event>, ...(async ? ['--async'] : [])]; direct: process.execPath ['--no-warnings',
// <skill>/runtime/packages/cli/dist/hook.js, '--mcs-hook', <event>, ...]. Both require a built runtime (npm run build).

// workspace.ts  (legacy-compatible task workspace, D3)
export function buildRepo(root: string): { repo: string; tasksRoot: string };
export function buildTaskWorkspace(repo: string, opts: { slug: string; config: Record<string, unknown>; runtime?: Record<string, unknown>;
  instance?: Partial<InstanceFile> }): string;    // returns workspace path
// `InstanceFile` = `z.infer<typeof InstanceFileSchema>` from `@mcs/shared` (01 section 1.5). When `instance` is given, the builder writes a
// complete `instance.json`: defaults { schema_version: 1, instanceId: <seeded uuid v4>, slug: opts.slug, createdAt: FIXTURE_EPOCH_MS as
// 'YYYY-MM-DDTHH:MM:SSZ', createdBy: 'mcs <RUNTIME_VERSION>', runtimeVersion: RUNTIME_VERSION, dbSchemaVersion: 0, engine: 'node',
// hooks: { enabled: false }, upgradedAt: null } overlaid with `instance`, keys in the schema order, validated with
// `InstanceFileSchema.parse` before writing (a fixture that the schema rejects throws). Without `instance`, no instance.json is written
// (legacy-only workspace).
export function snapshotTree(dir: string, opts?: { exclude?: readonly string[] }): string;          // sha256 of rel path + bytes

// demo.ts  (04 section 11.5 owns the letter list and the result contract; testkit hosts the builder; 06 6.1)
// Contract verbatim from 04 section 11.5 (registry C34; DemoSession and DemoResult are declared there, without a runtimeJson field):
export type DemoLetter = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
export interface DemoOptions { root: string; nowMs: number; letters?: DemoLetter[] /* default all */; project?: string /* 'FIXTURE-demo' */ }
export function buildDemo(o: DemoOptions): Promise<DemoResult>;
// Hook data in DemoResult are raw payloads for `runHookHandler`, never hand-built envelopes (06 6.2; envelope type `HookEnvelopeV1`
// from `@mcs/shared/protocol`).

// canary.ts  (section 4.10)
export const CANARY: { prompt: string; toolResult: string; thinking: string; key: string; envToken: string; attachment: string; query: string };
export function scanForCanaries(paths: readonly string[], allowed: readonly (keyof typeof CANARY)[]): { file: string; canary: string }[];
```
Subpath `@mcs/testkit/legacy` (A.21, registry C46) exposes design 06's legacy tree builders (`src/legacy/index.ts`: `buildLegacyFixtureHome`,
`buildLegacyDemo`, `buildPanelsTree`, `buildRulesTree`, `buildRegistryHome`; 06 sections 5.3 and 6, slice PP3), so the core entry `.`
carries no legacy-tree code.
Testkit has its own unit tests (`packages/testkit/src/*.test.ts`): builders emit valid JSON per line, labelled content, deterministic
output for the same inputs (no `Math.random` except `makeTempDir` names; ids passed in or derived from a seeded counter).

### 4.5 Ports, temp dirs, processes

| Range | User | Rule |
|---|---|---|
| 18000-18499 | Vitest (integration, isolation, resilience, security, parity Node side) | `allocatePort()`: block of 50 per worker, `18000 + ((VITEST_POOL_ID - 1) * 50) % 500`, probe `listen({ host: '127.0.0.1', port, exclusive: true })` |
| 18500-18599 | Playwright E2E (04 section 11.4) | `allocatePort([18500, 18599])` (registry C32); specs start instances with `$MCS start`, no Playwright `webServer` (04 W14 config); workers 1 |
| 18760-18769 | `npm run dev` (default 18765 API, 18766 web) | never 8765/5173 by default |
| 18800-18849 | `scripts/smoke.mjs` | |
| 18850-18899 | parity: Python engine `serve --port`, Node engine | |
| 18900-18999 | manual experiments, testkit `demo --port` (06 6.4), benchmarks in 18900-18949 (06 8.3) | never used by Vitest, Playwright or `ci` gates |
Never 8765, 3000, 3100, 8080, 8089 (owner rule). Every test that starts a server or process stops it in `afterEach/afterAll` and calls
`assertPortClosed`. Temp dirs: `useTempDirs()`; on Windows `rmSync` uses `maxRetries: 5` because SQLite WAL files and just-killed processes
hold locks for tens of ms. Every test sets `MCS_HOME` to a temp dir, `CLAUDE_CONFIG_DIR` to a testkit Claude home, and never touches
`~/.claude` or real settings files (C3). Hooks are never installed into real settings: installer tests pass `--settings-file <temp>` /
scope paths under `MCS_HOME` (design 01 owns the flag; the security suite asserts the real user settings file is byte-identical before and
after the whole suite, `secrets-never-read.test.ts`).

### 4.6 Determinism rules

1. No sleeps in tests (lint-enforced). Time-based logic gets `FakeClock` (engine) or `vi.useFakeTimers` (web); waiting for real
   processes uses `waitFor` with a timeout and a description.
2. `TZ=UTC` for every project; tests that need another zone set `process.env.TZ` inside the test and restore it.
3. Fixture timestamps derive from `FIXTURE_EPOCH_MS` or an explicit `nowMs`; file mtimes are set with `utimesSync`, never left to the clock.
4. No dependence on test order: `npm run test:stress` runs shuffled with three seeds before release.
5. No network: tests bind 127.0.0.1 only and make no outbound requests. Production code in engine/server/cli has no outbound HTTP
   client: `tooling/check-deps.test.ts` greps `packages/{engine,server,cli}/src` for `fetch(`, `http.request`, `https.request` and
   `net.connect` and allows only the hook handler's loopback POST and the CLI's loopback health probe (named files).
6. Random ids in production code come from `crypto.randomUUID()` and are asserted by shape, never by value.
7. Each test owns its temp dir, ports and processes; no shared mutable fixtures across files (`pool: 'forks'` for every project with I/O).
8. HTTP helpers use `agent: false` (E8).
9. Output comparisons normalise only what the test names (paths -> `<root>`, times -> offsets); never blanket regex replacement.

### 4.7 Flake policy

- Retries: 0 in Vitest and Playwright (`retries: 0`, `forbidOnly: true`).
- A test that fails without a code change is a defect. Allowed response: fix the cause or quarantine it by `it.skip` with a comment
  `QUARANTINE <date> <reason>` and a row in the `docs/testing.md` "Quarantine" table (test, date, symptom, suspected cause, owner).
- Release gate (7.1): the quarantine table must be empty for release-blocking layers; `test:stress` must pass all three seeds.
- Timeouts are budgets, not waits: a test that needs more than its default timeout states why in a comment.

### 4.8 Isolation suite (brief section 4 "Required isolation tests", release-blocking)

One id per brief bullet (the traceability matrix uses ISO-n, 7.4); design 01 section 3.5 owns the individual tests (T-ISO-01..27, with
setup and assertions) and design 02 owns T-HK-05. Placement rule: every T-ISO row whose 01 project is `isolation`, `integration` or
`resilience` lives in the 4.3 file of its ISO row (Vitest project `isolation`, release-blocking, `pool: 'forks'`, one worker per file);
rows marked `unit` in 01 live next to their module (01 slice table). File ownership (critic N-07): each `runtime/tests/isolation/*.test.ts`
belongs to the 01 slice that implements its T-ISO rows (01 "Phase 2+ task slices" table: for example S6 T-ISO-01/02/06/07/21, S9
T-ISO-13/14/18/19/20/22, S12 T-ISO-24..27, S13a T-ISO-09..12, S15 T-ISO-23); a file with rows of several slices is created by the
earliest of them and extended by the later ones; `hook-routing-isolation.test.ts` belongs to 02 (T-HK-05). This design (slice S9) owns only
`runtime/tests/isolation/_setup.ts` and the project wiring: `_setup.ts` exports `twoInstances({ sameRepo? })`, which builds A and B with
testkit (`makeTempDir`, `hermeticEnv`, `buildDemo` or `buildRepo`, `runCli(['init', ...])`) in separate temp repos (or two tasks in one
repo where 01 says so), starts both with `startInstance` on ports from `allocatePort()`, and registers `afterAll` stops
(`assertPortClosed`). Test titles start with the T-ISO id, for example `it('T-ISO-09 token totals exclude the other instance')`.

| Id | Brief bullet | Implemented by | File (4.3) | Summary of what must hold (01 3.5 is normative) |
|---|---|---|---|---|
| ISO-1 | A cannot read B's private state | 01 T-ISO-01..05 (01, 02 unit) | `read-isolation.test.ts` (T-ISO-03, 04), `db-identity.test.ts` (T-ISO-05) | A's API and CLI outputs contain none of B's ids or marker words; B's session id on A -> 404 `session_not_found`; SSE on A never carries B's ids; B's DB copied into A -> A refuses to start (exit 11, `IDENTITY_MISMATCH`), B untouched |
| ISO-2 | A cannot overwrite B's configuration | 01 T-ISO-06..08 (07 unit) | `config-write-isolation.test.ts` | B's snapshot unchanged around every write command for A; traversal and prototype keys rejected |
| ISO-3 | A's tokens exclude B's usage | 01 T-ISO-09, 10 (10 unit) | `token-isolation.test.ts` | A's usage = expected(own sessions) exactly, B's likewise; no cross-instance aggregate route |
| ISO-4 | A's search excludes B's transcripts | 01 T-ISO-11, 12 | `search-isolation.test.ts` | marker only in B's scope -> zero hits on A; out-of-scope id on disk -> 404 |
| ISO-5 | Stopping A does not stop B | 01 T-ISO-13..15 | `lifecycle-isolation.test.ts` | `mcs stop --task a` leaves B's pid, health and `state.json` bytes unchanged; a forged A `state.json` naming B kills nothing |
| ISO-6 | Restarting one does not corrupt the other's DB | 01 T-ISO-16, 17 | `restart-isolation.test.ts` | five restarts and one force kill of A during ingestion: `PRAGMA integrity_check` = `ok` for both, B counts exact |
| ISO-7 | No conflicting ownership/port/state | 01 T-ISO-18..23 | `ownership-isolation.test.ts` | distinct ports for equal configs; one process per instance under concurrent starts; hand-started `serve` exits 12; copied workspace -> `IDENTITY_MISMATCH`; impostor pid never killed; legacy viewer detected (skipped without Python >= 3.8, recorded) |
| ISO-8 | Template upgrades never overwrite user config/audit | 01 T-ISO-24..27 (27 unit + integration) | `upgrade-isolation.test.ts` | `config.json`, `task.json`, `README.md` bytes equal; old audit bytes are a prefix; backup equals the originals; newer DB refused `DB_NEWER_THAN_RUNTIME` |
| ISO-9 | (D2, brief 5) Hooks route only to the owning instance | 02 T-HK-05 (unit part in `shared/src/protocol/routes.test.ts`) | `hook-routing-isolation.test.ts` | `runHookHandler` with `cwd`/transcript in A's scope -> line only in A's spool segment; two matching routes -> two lines with one `event_uid`; outside both -> no spool written |

### 4.9 Resilience suite

| File | Cases (each an `it`) |
|---|---|
| `partial-line.test.ts` | last line without newline is not consumed; completing it later yields exactly one record; unterminated valid JSON at EOF handled per C.2 golden |
| `truncation.test.ts` | file shrinks -> cursor reset, records re-read, tokens not doubled (message.id dedupe) |
| `rotation.test.ts` | file replaced (same path, different first-256-bytes hash, larger size) -> identity change detected, reset |
| `duplicates.test.ts` | same hook envelope delivered twice (spool replay + POST) -> one event row; resume copy with same uuids/message ids in two files -> counted once; streaming snapshots of one message.id -> per-field max |
| `out-of-order.test.ts` | PostToolUse before PreToolUse; SessionEnd before Stop; SubagentStop after parent SessionEnd; terminal state never regresses without a reconciliation record |
| `restart-recovery.test.ts` | kill the server between spool append and drain -> restart drains each line once; transcript offsets resume (no full re-parse: bytes read after restart < 2x appended bytes) |
| `upgrade-migrations.test.ts` | DB created by every prior schema version migrates; backup created first; a DB newer than the runtime is refused with its error code |
| `partial-init.test.ts` | init interrupted after `task.json`, before `instance.json` -> re-run completes idempotently; doctor names the missing file |
| `concurrency.test.ts` | 8 hook handler processes append concurrently while the server drains: no lost or torn lines; CLI read-only access while the server writes (WAL) |
| `large-file.test.ts` | 30 MB transcript + one 1.3 MB line: import completes, memory stays under 200 MB RSS delta, event-loop p99 lag under 100 ms during import (`eventLoopLagProbe`) |
| `malformed-input.test.ts` | invalid JSON line, non-object JSON, BOM, CRLF, 2 MB hook payload, wrong field types -> counted as invalid, runtime keeps running, health shows the counter |
| `storage-errors.test.ts` | DB directory read-only, injected `SQLITE_FULL`/`ENOSPC` -> health `degraded` with error code, no crash, recovery after the fault clears |
| `hook-failsafe.test.ts` | through the installed stub (`runHookHandler` default) and `direct: true`: server down -> handler exits 0 within 1 s, stdout empty; spool dir missing -> created or skipped without error; `MCS_HOOK_DISABLE=1` -> no spool write; malformed stdin -> exit 0; runtime not built (stub cannot import `dist/hook.js`) -> exit 0, `HANDLER_UNAVAILABLE` in `$MCS_HOME/logs/hook-handler.jsonl` |
The exact thresholds of ingestion behaviour come from the ingestion design; the files and cases above are the contract this design owns.

### 4.10 Security and privacy suite (canaries)

Canary strings (testkit `CANARY`), each unique and grep-able: `CANARY.prompt` (user prompt text), `CANARY.toolResult` (tool_result
body), `CANARY.thinking` (thinking text and signature), `CANARY.attachment` (attachment body), `CANARY.key` (content of `.key` decoys),
`CANARY.envToken` (value of `CLAUDE_CODE_MESSAGING_TOKEN` in the hook env), `CANARY.query` (a search query). Policy matrix enforced by
`privacy-canaries.test.ts` after a full ingest + API + search + export + backup + CLI run:

| Canary | DB file bytes | API responses | Logs (`logs/*.log`) | Audit (`audit/*.md`) | Export/backup | CLI output |
|---|---|---|---|---|---|---|
| prompt | allowed only within `limits.text_chars` (D8 policy of the persistence design) | allowed (clipped) | never | never | allowed (export is user data) | allowed only in commands that show sessions |
| toolResult, attachment, thinking | never | never (D8: bodies not persisted) | never | never | never | never |
| key, envToken | never | never | never | never | never | never |
| query | never | only echoed in the same response if the API design says so | never | never | never | never |
The test reads the SQLite file, WAL, spool, logs, audit, exports and captured stdout/stderr as bytes and fails with the file and canary.

### 4.11 Cross-engine parity harness (Python oracle)

#### 4.11.1 Feasibility (verified, E13; capture engine verified by design 06, E12 there)
`python template/viewer.py serve --config <temp cfg> --repo <temp> --state-file <temp> --port 18850` with `CLAUDE_CONFIG_DIR=<fixture home>`
and `PYTHONDONTWRITEBYTECODE=1` served `/api/sessions` (5 sessions, keys `age, agents, completeness, done, first_epoch, id, label,
matched, pending_tools, size, state, state_evidence, state_source, usage, usage_total`) and wrote nothing inside the skill folder
(`git status` unchanged). The committed capture engine is design 06's in-process generator `tests/legacy-parity/tools/capture_golden.py`
(06 section 5.2, ADR 0053): it serves the same legacy `Server` under a frozen clock and produced byte-identical output in two runs
(06 E12). This design does not keep a second capture procedure (critic issue I-09).

#### 4.11.2 Modes
- Golden mode (default, no Python): the `*.parity.test.ts` files (06 PP4/PP8) read the raw legacy `[status, body]` responses, CLI
  outputs, tree manifests and vectors from `goldenDir()` (`MCS_GOLDEN_DIR` if set, else `<skill>/tests/legacy-parity/golden`), build
  the Node side on the same trees under the frozen clock (06 5.4 steps 1-4), project both sides with `projections.ts` and compare with
  06's field matrix (5.4). No age buckets: ages and times are exact because both sides use `FROZEN_NOW`.
- Live mode (`MCS_PARITY_LIVE=1`, needs Python >= 3.8): `globalSetup` of the parity project calls `runCapture({ out: <temp> })`
  (run-python.ts), which runs `capture_golden.py --out <temp>` against the current legacy code, then sets `MCS_GOLDEN_DIR=<temp>` for the
  run; the comparisons are the golden-mode ones. It detects a legacy or generator change that the committed goldens do not yet
  reflect. Without a usable Python the project prints `parity live mode SKIPPED (<reason>)` and fails only if `MCS_PARITY_LIVE=1` was
  set together with `CI=true` (the release gate 7.1 step 6 needs a real run). The temp dir is removed in `globalTeardown`.
- Drift check: `npm run parity:check` = `capture_golden.py --check` (06 5.2.2; refuses another Python minor version than `meta.json`).
- Time-zone variant (06 5.2.6): `parity-capture.mjs --tz Asia/Ho_Chi_Minh --out <temp>` then the suite with `MCS_GOLDEN_DIR=<temp>`.

#### 4.11.3 Projections and normalisation (`runtime/tests/parity/projections.ts`, `normalize.ts`; slice S8 base, 06 PP8 extends)

```ts
// projections.ts (base shapes; 06 PP8 adds the legacy-shape projections of its field matrix 5.4 in the same file)
import type { LegacyState } from '@mcs/shared';          // 03 section 5.5 owns the union (registry C36); no local declaration
export interface SessionProjection {
  id: string; label: string | null; matched: boolean; legacyState: LegacyState; stateSource: string;
  usage: { input: number; output: number; cacheRead: number; cacheCreation: number } | null;
  pendingTools: number; agents: { id: string; workflow: string | null; legacyState: LegacyState }[];
}
export interface EventsProjection { total: number; kinds: Record<string, number>; toolNames: string[]; errorCount: number }
export interface SearchProjection { query: string; hitIndexes: number[]; truncated: boolean }
export interface AttemptsProjection { rows: { part: string; status: string; sessionIds: string[] }[] }
export interface ConfigRegexProjection { pattern: string; accepted: boolean; matches: Record<string, boolean> }
export interface WorkspaceFilesProjection { files: Record<string, string> } // rel path -> text (task.json, config.json, README.md, audit/*.md)
export interface Mismatch { pointer: string; rule: 'EXACT' | 'MAPPED' | 'SET' | 'CI' | 'TOL' | 'DIFF'; legacy: unknown; node: unknown }
export function compareProjection<T>(legacy: T, node: T, rules: Readonly<Record<string, Mismatch['rule']>>): Mismatch[];

// normalize.ts
export const FROZEN_NOW_S = 1790000000;                 // = 06 5.2.3 FROZEN_NOW; the Node side runs with clock { now: () => FROZEN_NOW_S * 1000 }
export interface NormalizeContext { tempRoots: readonly string[]; port?: number; pid?: number }
export function normalizeText(s: string, ctx: NormalizeContext): string;   // every spelling of each temp root -> '<TMP>', longest first
export function normalizeValue(v: unknown, ctx: NormalizeContext): unknown; // deep copy; strings via normalizeText; keys below replaced
export function goldenDir(): string;                     // MCS_GOLDEN_DIR ?? resolve(<runtime>, '../tests/legacy-parity/golden')
export function readGoldenApi(scenario: string, name: string): { status: number; body: unknown };  // golden/api/<scenario>/<name>.json
```
Normalisation is applied to the Node side only and mirrors 06 5.2.3 exactly (the goldens are already normalised by the generator):
1. Temp roots: for each root, the spellings as given, `fs.realpathSync.native`, forward-slash form, and each of those JSON-escaped once
   and twice are replaced by `<TMP>`, longest string first.
2. Keys `config_hash` -> `<MACHINE>`, `pid` -> `<PID>`, `url` -> `<URL>`, `port` -> `<PORT>`, `code_stamp` -> `<STAMP>` (any depth).
3. Nothing else: no time bucketing, no rounding (TOL rules of 06 5.4 are comparison rules, not normalisation), arrays keep their order
   unless the field matrix says SET.
Stability margin (unchanged, used by the scenario catalogue 06 6.3 and by integration/E2E fixtures built at the real `now`, not by the
goldens): time-sensitive sessions sit at least 60 s from any threshold (`active_seconds`, `pending_tool_grace_seconds`).

#### 4.11.4 Golden capture procedure (adopts design 06 section 5.2 and ADR 0053; slice S8 owns only the wrapper)
`runtime/tests/parity/run-python.ts` (test helper) and `runtime/scripts/parity-capture.mjs` (zero-dependency ESM) share this behaviour:
```ts
export interface PythonInfo { file: string; prefixArgs: readonly string[]; version: string }  // e.g. { file: 'py', prefixArgs: ['-3'] }
export function findPython(): PythonInfo | null;      // tries 'python', 'python3', then on win32 'py' ['-3']; requires >= 3.8
export function runCapture(o: { out?: string; check?: boolean; golden?: string; tz?: string; portBase?: number; trees?: string;
  timeoutMs?: number /* 600000 */ }): Promise<{ code: number; stdout: string; stderr: string }>;
```
`parity-capture.mjs [--check] [--out <dir>] [--golden <dir>] [--tz <zone>] [--port-base <n>] [--trees <dir>]`:
1. Parse arguments; `--port-base` must lie in 18850-18855 (the legacy `bind` scans +19, so the server stays inside 18850-18874, 4.5);
   unknown argument -> usage message, exit 2.
2. `findPython()`: run `<file> <prefixArgs> --version` with `shell: false`, `windowsHide: true`; none, or a version below 3.8 ->
   `parity-capture: no Python >= 3.8 found (tried python, python3, py -3)`, exit 2.
3. Spawn `<file> <prefixArgs> -B tests/legacy-parity/tools/capture_golden.py` with `--out <dir>` (default
   `tests/legacy-parity/golden`) or `--check [--golden <dir>]`, plus `--tz`/`--port-base`/`--trees` when given; `cwd` = skill root,
   `stdio: 'inherit'`, env = process env + `PYTHONDONTWRITEBYTECODE=1`, `shell: false`, `windowsHide: true`.
4. After a successful capture into the default folder: print `git status --short -- tests/legacy-parity/golden` (read-only) as the change
   summary, or `(git not available: review tests/legacy-parity/golden by hand)`.
5. Exit with the tool's exit code. The wrapper never writes files itself, never commits, never starts the Node runtime.
Procedure for a reviewed golden update (lead): (1) `npm run parity:capture`; (2) `npm run parity:check` prints `golden check: N files
identical`; (3) inspect every changed file in the printed summary; (4) the lead commits `tests/legacy-parity/golden/**`. Determinism
controls (frozen clock, seeded uuids, `TZ`, mtimes, placeholders), file layout, scenarios (`fixture`, `demo`, `rules`, `panels`,
`registry`, `task-lifecycle`) and L1 vectors are those of 06 sections 5.2.1-5.2.4. The parity cases this design listed before
(states, tokens, rules, events window, search, attempts, regex dialect, workspace, workflows path) are covered there: states, tokens,
events and search by `fixture` and `demo`; rules and regex dialect by `rules` and `golden/vectors/classify_rules.json`; attempts by
`panels`; workspace files by `task-lifecycle`; the workflows path by defect D1 (PD1). Never capture from real transcripts; never write
outside the output folder.

#### 4.11.5 Known legacy divergences (closes foundations open question 6 for the defects list in current-state-backend F.6.5)

| Id | Python behaviour | Node decision | Parity assertion |
|---|---|---|---|
| PD1 | `'workflows' in p` tags agents under any path containing `workflows` (`sessions.py:138`) | FIX: test path segments | scenario `workflows-path` asserts the documented divergence exactly |
| PD2 | `init_task` raises `ValueError` across drives (`tasks.py:86`) | FIX: store absolute path when no relative path exists | not projected (Windows-only CLI case; covered by `cli/test/init.int.test.ts`) |
| PD3 | legacy flat config problems computed but never raised (`config.py:187,196`) | N/A in Node: flat configs are served by the legacy engine (01 section 6.5 delegates every flat-config form to `$V`); `config migrate --from-legacy` (01 2.7) reports dropped keys and refuses untranslatable regexes (`REGEX_UNSUPPORTED`); no `configWarnings` field anywhere (critic N-05) | 06 R25 asserts those outcomes; `config-regex.parity` compares only the translator's accept set (01 2.8) |
| PD4 | `usage_total` lacks `scanned_pct`/`models` | N/A (v3 API) | excluded from projection |
| PD5 | `config_hash` is machine-specific | N/A | excluded |
| PD6 | attempts rows keyed by `part`, fixed 24 h window, multiple rows per session | REPRODUCE until the attempts design changes it with an ADR | `attempts.parity` golden |
| PD7 | `/api/*` Host check accepts `[::1]`, rejects bare `::1` | N/A: Node binds 127.0.0.1 and allows only `127.0.0.1:<port>`/`localhost:<port>` | security suite |
Design 06 section 5.8 (ADR 0055) is the detailed defect table: PD1 = D1, PD2 = D2, PD3 = D3, PD4 = D4, PD5 = D5, PD6 = D6 + D7 + D20 + D22,
PD7 = D18. Any new divergence needs a row there (with decision) before the parity test is changed.

### 4.12 E2E conventions (specs owned by 04)
The config file is 04's `packages/web/e2e/playwright.config.ts` (04 slice W14, section 11.4): no `webServer`, no port variable; each spec
starts its instances with `$MCS init`/`start` on `allocatePort([18500, 18599])` ports and stops them (A.28 withdrawn, critic N-02).
Playwright 1.64.0, `channel: 'chrome'` (no browser download), `workers: 1`, `retries: 0`, `forbidOnly: true`, `timezoneId: 'UTC'`,
`locale: 'en-US'`, trace `retain-on-failure`, output under `packages/web/e2e/test-results/` (gitignored). Ports 18500-18599. Each spec uses
`MCS_HOME` and `CLAUDE_CONFIG_DIR` temp dirs and stops every instance it started. Testkit is imported from `dist` (Playwright does not
apply `@mcs/source`; testkit is part of `tsconfig.build.json`, verified E14). E2E runs after `npm run build`.

### 4.13 Coverage expectations

Global (unit + web + integration): lines 80, statements 80, functions 80, branches 75. Per glob: `packages/engine/src/{lifecycle,ingest,
tokens,config}/**` and `packages/shared/src/**` 90/90/90/85. Coverage is a floor, not the proof: every guarantee in the traceability
matrix (7.4) names its test; a module below threshold blocks `test:coverage`. Excluded: entry files, `index.ts` barrels, testkit.

---

## 5. Security model

### 5.1 Assets, actors, boundaries

Assets: transcript content (prompts, code, tool output), file paths, session metadata, token usage, hook payloads (raw prompts, env-derived
tokens), the SQLite DB, spool, logs, audit, exports, the ingest token, the user's Claude settings files.
Actors: the user (trusted), Claude Code sessions (trusted process, untrusted content), other local processes of the same user (cannot be
stopped by us; same privileges), other local users (filesystem permissions), web pages in the user's browser (untrusted: CSRF, DNS
rebinding), the transcript content itself (untrusted data that may contain instructions, HTML, terminal escapes), npm supply chain.

```
 Claude Code --hook stdin--> mcs-hook.mjs/hook.js --append--> <workspace>/data/spool/hooks-*.ndjson --drain--> server --> SQLite
      |                         \--POST nudge (no data)--> 127.0.0.1:<port> -/                |
      \--writes--> ~/.claude/projects/**/*.jsonl --read (contained paths)--> importer ---------/
 Browser (same machine) --GET/POST + SSE--> 127.0.0.1:<port> [Host/Origin/Sec-Fetch guard] --> API v3 (read-only + few explicit mutations)
 Terminal --> mcs CLI --> (sanitised output) ;  CLI --argv, no shell--> git, powershell, taskkill, claude (hooks disabled)
```
Trust boundaries: (1) hook stdin -> handler, (2) browser -> server, (3) transcript bytes -> importer, (4) DB/API text -> UI and terminal,
(5) runtime -> child processes, (6) npm registry -> `node_modules`.

### 5.2 Threats and mitigations

| # | Threat | Mitigation (control ids from 5.3) | Residual risk |
|---|---|---|---|
| T1 | DNS rebinding: evil.example resolves to 127.0.0.1 and reads the API | S-NET-2 exact Host allow-list | none known |
| T2 | CSRF: a web page POSTs to a mutating endpoint | S-NET-3/4/5: Origin + Sec-Fetch-Site + JSON + custom header, no CORS | none known |
| T3 | Cross-origin read of SSE/JSON | no ACAO headers (browser blocks reads), Host + Sec-Fetch-Site checks | none known |
| T4 | Network exposure | S-NET-1 bind 127.0.0.1 only; non-loopback bind not implemented (brief allows explicit config; deferred, D15 non-goal: no enterprise auth) | none |
| T5 | Forged hook events from a local process | S-ING: spool is the only data channel; POST is a data-free nudge; token required if a data POST is ever added | same-user processes can write the spool: accepted (same privileges as the user) |
| T6 | Path traversal via ids or `transcript_path` | S-FS-1..4 id regexes, realpath containment, never open a client-supplied path | none known |
| T7 | Symlink/junction escape from transcripts root | S-FS-3 lstat walk skips links (junctions report `isSymbolicLink() === true`, E12), realpath containment | none known |
| T8 | XSS from transcript text | S-OUT-1 React text rendering, lint bans, CSP | none known |
| T9 | Terminal injection (OSC 52 clipboard, title, hyperlinks, bidi spoofing) via CLI output | S-OUT-2/3 sanitiser for text and JSON | none known |
| T10 | Command injection | S-PROC-1..5 argv arrays, no shell, `.exe`/`.com` only, fixed executables | none known |
| T11 | Secrets/prompts leak into logs/audit/DB | S-LOG allow-list logger, no `err.message` of parse errors (E12: JSON.parse messages echo input text), S-SEC canaries | none known |
| T12 | DoS: huge bodies, slowloris, SSE exhaustion, event-loop starvation | S-NET-6 limits and timeouts, bounded queues, async chunked import | local only |
| T13 | Supply chain (install scripts, typosquats, compromised release) | S-DEP | registry compromise of a pinned version before audit data exists |
| T14 | Hook recursion / monitor breaking Claude Code | handler always exit 0, no stdout, `MCS_HOOK_DISABLE`, `disableAllHooks` for spawned `claude` (D8) | none known |
| T15 | Installer corrupts user settings (all `-p` settings silently dropped on invalid JSON, hooks research 3.7) | atomic write + JSON re-parse + backup + dry-run default (design 01); tests never touch real settings | user consent required |
| T16 | Instructions inside transcripts influence the agent using the skill | SKILL.md rule: transcript content is data; CLI output labels quoted content; MCP read-only | model behaviour |
| T17 | Reading `~/.claude/sessions/*.key` | S-SEC-2 never open `.key`; decoy canary test | none known |

### 5.3 Controls (normative)

**S-NET (server, `packages/server/src/http/guards.ts`)**
1. `listen(port, '127.0.0.1')`; no option to bind another address in v3. `server.listen` errors -> next port (D12).
2. Host guard on every request (API, static, SSE): `req.headers.host` must equal `127.0.0.1:<port>` or `localhost:<port>` exactly
   (case-insensitive compare of the host part); missing, empty, `0.0.0.0`, `[::1]` or any other value -> 403
   `host_not_allowed` in the 03 section 5.2 envelope `{ "error": { "code", "message", "requestId" } }`. (CCAM's allow-list contained `""`
   and `0.0.0.0`; ours does not.) Every code named in this section is a value of `ErrorCode` (`packages/shared/src/api/errors.ts`, 03
   section 5.2 catalogue, authoritative; critic issue I-04); this design names codes, it does not define them.
3. Origin guard: if `Origin` is present it must equal `http://127.0.0.1:<port>` or `http://localhost:<port>`; `null` or anything else ->
   403 `origin_not_allowed`. Dev mode accepts the Vite origin only because the proxy rewrites Origin to the target (04 ADR 0039).
4. Fetch metadata: if `Sec-Fetch-Site` is present and equals `cross-site` -> 403 `cross_site_request` (all methods). `same-site` is also
   rejected for non-GET (another localhost port is same-site).
5. Mutating requests from the UI (any method other than GET/HEAD) require `Content-Type: application/json` and `X-MCS-Request: 1`;
   otherwise 403 `csrf_rejected` (reserved: v3 has no mutating UI route, 03 section 5.2 step 5; the guard exists and is unit-tested so a
   future route cannot skip it). The one non-GET route is the hook nudge `POST /api/v3/ingest/nudge` (02 section 2.8, 03 section 5.2
   step 7): not `application/json` -> 415 `unsupported_media_type`; any `Origin` header -> 403 `origin_not_allowed` (a browser cannot
   send it: browsers always attach `Origin` to a cross-site POST); body > 256 bytes -> 413 `payload_too_large`; body not
   `{"instanceId": "<uuid>"}` -> 400 `validation_failed`; another instance's id -> 409 `instance_mismatch`; else 204. `OPTIONS` (and any
   unsupported method on a known path) -> 405 `method_not_allowed` with `Allow` and no CORS headers. The server never sends
   `Access-Control-Allow-*`.
6. Limits: `express.json({ limit: '64kb', strict: true })` (nudge route 256 bytes; larger -> 413 `payload_too_large`, unparsable ->
   400 `body_invalid_json`); URL length > 8192 -> 414 `uri_too_long`; query params validated by Zod with max lengths (400
   `validation_failed`, repeated key 400 `param_repeated`); `server.headersTimeout = 10_000`, `server.requestTimeout` =
   `server.requestTimeoutMs` (default 30_000, 01 section 1.6), `server.keepAliveTimeout = 5_000`, `server.maxHeadersCount = 64`,
   `server.maxConnections = 128`; SSE connections per instance <= 16 (17th -> 503 `stream_limit`);
   per-request DB work bounded by pagination limits of the API design; never `insecureHTTPParser`.
7. Headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`,
   `Cross-Origin-Resource-Policy: same-origin`, `X-Frame-Options: DENY`; `/api/*` `Cache-Control: no-store`; HTML the CSP of ADR 0039
   (`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none';
   base-uri 'none'; frame-ancestors 'none'; form-action 'none'`); `app.disable('x-powered-by')`.
8. Errors: uniform envelope, no stack traces, no echo of request bodies, no file paths outside the instance in messages.

**S-ING (hook ingest)**
1. The hook handler writes the full (already summarised) envelope only to the spool; the POST to `/api/v3/ingest/nudge` carries only
   `{"instanceId"}` and only schedules a drain (02 section 2.8, its ADR 0012: no token because no data). The server never trusts POST
   content as an event.
2. If the ingestion design ever adds a data-carrying POST, it requires header `X-MCS-Ingest-Token` equal to the 32-byte random hex
   in `<workspace>/data/ingest.token` (created at init; POSIX mode 0600; on Windows it inherits the workspace ACL, documented), compared
   with `crypto.timingSafeEqual` after a length check; token never logged, never in API/exports/backups/diagnostics; plus S-NET-2..6.
3. Spool lines are size-capped on both sides with 02's constants (no second value here): the handler sanitises and clips fields and
   writes the minimal envelope when a line exceeds `ENVELOPE_MAX_BYTES` (16 KiB, 02 section 2.2 step 11); the drain skips and counts
   (`LINE_TOO_LONG`) a line above `MAX_LINE_BYTES` (`shared/src/protocol/limits.ts`, the one line cap of 02 section 1.1, critic I-32).

**S-FS (paths)** in `packages/engine/src/security/paths.ts`:
```ts
// The id regexes are 02's (section 2.3.2, `shared/src/protocol/hook-envelope.ts`: SID_RE, AGENT_RE, RUN_ID_RE, legacy rules);
// re-exported here for path code, never a second literal (critic I-26, registry C35).
export { SID_RE, AGENT_RE, RUN_ID_RE } from '@mcs/shared/protocol';
export function resolveContained(root: string, ...segments: string[]): string | null; // realpath(root) prefix check, case-insensitive on win32
export function isContained(root: string, candidate: string): boolean;
export function* walkNoLinks(dir: string, opts: { maxDepth: number; maxEntries: number }): Generator<string>; // lstat; skips symlinks/junctions
```
1. Client-supplied ids are validated by regex before any path work; paths are found by listing a known directory and matching names,
   never by joining client strings (legacy rule, `sessions.py:151-161`).
2. Hook `transcript_path` / `agent_transcript_path` are used only if `isContained(transcriptsRoot, realpath(p))`; otherwise the event is
   kept without a transcript link and an ingest warning is counted (CCAM weakness 11).
3. Directory walks use `walkNoLinks` (junctions are links, E12) and bounded depth/entries; containment is checked after `realpath`
   with `path.relative` not starting with `..` and not absolute; Windows comparison lower-cases both.
4. Files written by the runtime live only under the instance workspace (and `MCS_HOME` registry); every write uses temp + rename.
5. `cleanup`/`retention` delete only paths for which `isContained(workspace, p)` holds, after listing them in a dry run.

**S-OUT (rendering untrusted text)**
1. UI: 04 section 8 (text rendering, legacy Markdown subset, lint bans, source audit, CSP).
2. CLI text mode: `cli/src/io/terminal.ts` `printLine(text)` escapes, as `\uXXXX`, every code point in C0 except TAB and LF, DEL, C1
   (U+0080-U+009F), U+2028, U+2029, bidi controls U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069; only this module writes to
   stdout/stderr in the CLI (lint-enforced).
3. CLI JSON mode: `safeJsonStringify(value)` = `JSON.stringify` then the same escape of C1, DEL, U+2028/2029 and bidi controls (JSON.stringify
   escapes C0 but leaves these raw, E12). Output stays valid JSON.
4. Untrusted strings never become a terminal hyperlink, title or colour sequence; colours are emitted only by the CLI around trusted text
   and only when `stdout.isTTY` and `NO_COLOR` is unset.

**S-PROC (subprocesses)** in `packages/engine/src/platform/exec.ts` (file, signature and slice owned by design 06 section 3.6 / PP1:
`execFileText(spec: ChildSpec, signal?: AbortSignal): Promise<ChildResult>`, never throws; `ChildKind` includes `'node'` for launcher and
legacy-engine spawns with `file = process.execPath`, critic issue I-06). Rules 1-5 are the security rules that implementation must keep:
1. `spawn(file, argv, { shell: false, windowsHide: true, timeout, stdio })` only; `exec`/`execSync` and `shell: true` banned by lint.
2. `file` is an absolute path to a `.exe` (or `.com`, 06 3.6 rule 2) on Windows (Node refuses `.cmd`/`.bat` without a shell and throws synchronously, E12, so the
   helper wraps `spawn` in try/catch and resolves a `ChildResult` with `ok: false`, `code: null`, `error: 'SPAWN_FAILED'`); executables used: `git`, `powershell.exe`
   (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`), `taskkill.exe` (also 01's `forceKill`, 01 4.2), `icacls.exe`, `docker`, `claude`,
   `node` (`process.execPath`; `hooks verify` V4/V6 spawn the installed hook command, 06 3.6 rule 8, and V6 alone passes the probe payload as
   `ChildSpec.stdin`, kind `node` only, at most 4096 bytes, registry C60), `python` (absolute path probed by 01 6.5, never by `resolveExecutable`) and kind `opener` (`explorer.exe`,
   `/usr/bin/open`, `xdg-open`); the kinds and their resolution are 06 section 3.6 `ChildKind`/`resolveExecutable` (critic I-06, registry C11).
3. Environment: start from an allow-list (`PATH`, `SystemRoot`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `LANG`) plus explicit additions;
   for `git` also `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` (never take the index lock the user may need) and never pass `GIT_DIR`,
   `GIT_WORK_TREE`, `GIT_INDEX_FILE` (CCAM issue #323); for `claude` `--settings '{"disableAllHooks":true}'` and `MCS_HOOK_DISABLE=1`;
   every child gets `MCS_HOOK_DISABLE=1` (D8 recursion guard); kind `docker` passes `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`
   through when set (06 CH-4, accepted: they select the user's engine and are not secrets of this runtime).
4. Untrusted strings never become an argument that starts with `-` (prefix `--` separator where the tool supports it) and never become
   PowerShell script text: PowerShell commands are fixed strings with numeric pids validated by `^\d+$`; the only `opener` argument is
   `http://127.0.0.1:<port>/` built from the validated integer port (06 3.6 rule 8).
5. Every call has a timeout (default 10 s; `powershell` CIM 20 s, legacy) and an output cap (1 MiB, then kill).

**S-LOG (logging and audit)**
1. `engine/src/log/logger.ts`: JSON lines, levels `debug|info|warn|error` (`MCS_LOG_LEVEL`), closed field allow-list: `event, instanceId,
   sessionId, agentId, code, count, durationMs, bytes, offset, port, pid, status, method, route, version, schemaVersion, phase`; values
   are numbers, booleans or strings matching `^[\w.:/@-]{0,128}$`; anything else is dropped and counted (`droppedFields`).
2. Never logged: prompts, transcript text, tool input/output, search queries, request bodies, env values, tokens, file contents, raw hook
   payloads, `err.message` of parse/validation errors (log `code` and `err.name` only, E12).
3. Request logging logs `method`, the route pattern (not the URL with query string), status, duration.
4. Audit records (`audit/changes.md`, `decisions.md`) contain config keys and JSON values the user set, reasons the user typed, never
   transcript content or secrets; legacy format C.8.
5. `check-text.mjs` (repo gate) scans code, docs, fixtures for e-mail addresses, user home paths (`[A-Z]:\\Users\\[^\\<]+`,
   `/Users/[^/<]+`, `/home/[^/<]+`), token shapes (`sk-ant-[A-Za-z0-9_-]{20,}`, `ghp_[A-Za-z0-9]{36}`, `github_pat_[A-Za-z0-9_]{40,}`,
   `xox[bp]-[A-Za-z0-9-]{10,}`, and `[0-9a-f]{40,}` outside lockfiles, goldens and commit/action SHAs listed in the allow file), and Vietnamese-specific letters (U+0110/0111, U+01A0/01A1, U+01AF/01B0, U+1EA0-U+1EF9); allow-list file
   `runtime/scripts/check-text.allow` for justified exceptions (each line `path:line reason`).
6. Rotation (critic issue I-25; 01 section 1.6 and 06 section 7.1 refer here). Constants and API in `engine/src/log/logger.ts`:
   ```ts
   export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;   // 10 MiB
   export const LOG_KEEP = 5;                            // runtime.log.1 .. runtime.log.5
   export const LOG_ROTATE_RETRY_BUDGET_MS = 3000;       // ADR 0058 budget
   export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
   export interface LoggerOptions {
     file: string | null;          // <workspace>/logs/runtime.log for the server; null = stderr sink only (CLI)
     level: LogLevel;              // runtime.json logLevel, env MCS_LOG_LEVEL, CLI --log-level (01 1.6)
     rotate: boolean;              // true only in the process that holds the instance lock (the server, 01 INV-03)
     clock: Clock;
     rotateBytes?: number;         // tests only; default LOG_ROTATE_BYTES
   }
   export interface Logger {
     debug(event: string, fields?: LogFields): void; info(...): void; warn(...): void; error(...): void;  // same signature
     readonly stats: { droppedFields: number; rotations: number; rotateFailures: number; writeFailures: number };
     close(): Promise<void>;       // flushes the queue, closes the handle
   }
   export function createLogger(o: LoggerOptions): Logger;
   ```
   Algorithm. Calls enqueue the serialised line and return at once; one async writer drains the queue in order. Before each append of a
   line of `b` bytes: (1) `size` is the tracked size of the open file (from `fstat` at open; `ENOENT` -> create, 0). (2) If `rotate` and
   `size > 0` and `size + b > rotateBytes`, rotate: close the handle; unlink `runtime.log.5` (`ENOENT` ignored); for k = 4, 3, 2, 1 rename
   `runtime.log.k` -> `runtime.log.(k+1)` (`ENOENT` ignored); rename `runtime.log` -> `runtime.log.1`; reopen `runtime.log` with flag `a`,
   `size = 0`, `stats.rotations += 1`. Each unlink/rename that fails with `EPERM | EBUSY | EACCES` (a reader such as an editor, the legacy
   Python tools or an antivirus holds the file on Windows; E23: `EBUSY` while a Python reader or appender holds it, success right after
   it closes) is retried after `min(50 * 2^k, 250)` ms while the elapsed time of this rotation is below
   `LOG_ROTATE_RETRY_BUDGET_MS` (ADR 0058 schedule). (3) If the budget runs out: `stats.rotateFailures += 1`, reopen `runtime.log` in
   append mode, keep appending (a temporarily larger file beats a lost line) and do not try again for 60 s (by `clock`). A partially
   shifted chain is valid because every step is a single rename and the next rotation restarts from `.5`. (4) Append with the handle;
   a write error increments `writeFailures` and drops that line (the logger never throws into callers). With `rotate: false` a process
   only appends (flag `a`) and never renames, so a CLI process cannot race the server's rotation. Rotated files beyond `.5` never exist;
   `cleanup --scope logs` (01) removes old `runtime.log.N` by age.

**S-SEC (secrets)**
1. The runtime has one secret of its own (ingest token, only if S-ING-2 applies). Never stored in the DB, config, audit, exports, backups,
   diagnostics bundles or logs.
2. Never open `~/.claude/sessions/*.key` (or any `*.key`); the registry reader filters by `.json` extension before opening; decoy test.
3. Never read or record environment values of hook processes (names only, if ever).
4. Diagnostics (`mcs diagnostics`, 01 section 6.3; registry C55) include versions, counts, error codes and paths inside the workspace;
   no env, no content.

**S-DEP (supply chain)**
1. Exact pins, single lockfile, `npm ci` only (launcher and CI), `.npmrc ignore-scripts=true`.
2. Minimal tree: the avoid list (lint-enforced bans) and ADR required for any new dependency (AGENTS-style rule: documented reason).
3. `npm audit --audit-level=low` in `ci`; `audit:prod` reported separately in the migration report.
4. `check-deps` gate (2.5, 3.2).
5. Typosquat check at review: every new name compared to the intended package page; lockfile diff reviewed (`resolved` host is
   `registry.npmjs.org` only; a `check-deps` rule, added in slice S1, fails on any other host in `package-lock.json`).
6. Update procedure: `npm outdated`; for each upgrade `npm install <pkg>@<x.y.z> --min-release-age=7` (npm >= 11.10), read the
   changelog, `npm run ci:full`, record the version check in the ADR evidence.
7. Native code: only `better-sqlite3` (prebuilds, no compile under `ignore-scripts`); platforms without a prebuild are unsupported
   (documented; fallback `node:sqlite` per D7).

### 5.4 Non-loopback exposure
Not supported in v3 (D15). A future change requires an ADR, TLS, and authentication; until then there is no option and the security suite
asserts `listen` address `127.0.0.1` for every started server.

### 5.5 Privacy defaults
Persist only what the persistence/ingestion designs list (D8: no tool-result bodies, attachment bodies, thinking signatures, account ids);
labels from first prompts are clipped (legacy behaviour, privacy note F.6.6) and never logged.

### 5.6 Checklist (each line is a test or a review item; ids referenced by the traceability matrix)

| Id | Control | Verification |
|---|---|---|
| SEC-01 | bind 127.0.0.1 only | `security/headers.test.ts` (server address), smoke |
| SEC-02 | Host allow-list exact; empty/0.0.0.0/[::1]/evil/`127.0.0.1.evil.com` -> 403 `host_not_allowed` | `security/host-origin.test.ts` (node:http with explicit Host) |
| SEC-03 | Origin allow-list; `null` -> 403 `origin_not_allowed` | `host-origin.test.ts` |
| SEC-04 | `Sec-Fetch-Site: cross-site` -> 403 `cross_site_request`; `same-site` non-GET -> 403 `cross_site_request` | `csrf.test.ts` |
| SEC-05 | reserved UI-mutation rule: the guard on a test app with one POST route rejects a request without JSON or without `X-MCS-Request` -> 403 `csrf_rejected`; nudge: not JSON -> 415 `unsupported_media_type`, any `Origin` -> 403 `origin_not_allowed`, > 256 bytes -> 413 `payload_too_large`, foreign `instanceId` -> 409 `instance_mismatch`; `OPTIONS` -> 405 `method_not_allowed`; no ACAO header anywhere | `server/src/http/guards.test.ts` (test app), `csrf.test.ts` (real server) |
| SEC-06 | body > limit -> 413 `payload_too_large`; URL > 8192 -> 414 `uri_too_long`; timeouts set (read `server.*Timeout`) | `limits.test.ts` |
| SEC-07 | 17th SSE connection -> 503 `stream_limit` | `limits.test.ts` |
| SEC-08 | security headers + CSP on HTML; no-store on API; no `x-powered-by` | `headers.test.ts`; E2E CSP no-violation (04) |
| SEC-09 | error envelope has no stack/paths/body echo | `headers.test.ts` (malformed JSON body -> 400 `body_invalid_json` without echo; envelope keys exactly `code`, `message`, `requestId`, optional `details`) |
| SEC-10 | hook nudge carries no event data; a forged nudge only schedules a drain of the instance's own spool | `hook-ingest.test.ts` (with 02 T-HK-06) |
| SEC-11 | ingest token (if any): timing-safe, never in outputs | `hook-ingest.test.ts`, `privacy-canaries.test.ts` |
| SEC-12 | id regexes; traversal ids -> 400/404, no fs access outside root | `path-containment.test.ts` |
| SEC-13 | hook `transcript_path` outside root ignored + counted | `path-containment.test.ts` |
| SEC-14 | symlink and junction escape skipped | `path-containment.test.ts` (creates a junction with `mklink /J` on win32, symlink elsewhere) |
| SEC-15 | cleanup deletes only contained paths, dry-run first | `security/path-containment.test.ts` + cleanup int test |
| SEC-16 | UI renders hostile strings as text | `web/src/components/Markdown.test.tsx`, E2E hostile fixture (04) |
| SEC-17 | lint bans raw HTML, computed href/src, eval | `tooling/lint-rules.test.ts` |
| SEC-18 | terminal sanitiser covers C0/C1/DEL/bidi/U+2028-9 in text and JSON | `cli/src/io/terminal.test.ts`, `security/terminal-output.test.ts` (runs CLI on a hostile fixture, scans stdout bytes) |
| SEC-19 | no shell, argv arrays, `.exe`/`.com` only (06 3.6 rule 2), try/catch around spawn | `engine/src/platform/exec.test.ts` (06 PP1), `security/subprocess.test.ts`, lint |
| SEC-20 | git env scrubbed (`GIT_DIR` etc. absent, `GIT_OPTIONAL_LOCKS=0`) | `subprocess.test.ts` (spawns `node -e` echo of env through the helper) |
| SEC-21 | spawned `claude` gets `disableAllHooks` + `MCS_HOOK_DISABLE` | `subprocess.test.ts` (argv builder unit) |
| SEC-22 | logger drops non-allow-listed fields and unsafe strings; parse errors logged by code only | `security/logger-allowlist.test.ts` |
| SEC-23 | canary matrix 4.10 holds | `security/privacy-canaries.test.ts` |
| SEC-24 | `.key` never opened; real user settings file unchanged by the whole suite | `security/secrets-never-read.test.ts` (decoy canary + hash of `~/.claude/settings.json` if present, read-only) |
| SEC-25 | hook handler: exit 0, empty stdout, < 1 s when server is down, honours `MCS_HOOK_DISABLE` | `resilience/hook-failsafe.test.ts` |
| SEC-26 | exact pins, declared imports, single override, registry host | `check-deps` in `ci`; `tooling/check-deps.test.ts` |
| SEC-27 | `npm audit` clean | `ci` gate (network) |
| SEC-28 | no private data / non-English text in code and docs | `check-text` in `ci` |
| SEC-29 | transcript content treated as data in SKILL.md and MCP (read-only tools) | review item (SKILL.md rule text), MCP tool list review |
| SEC-30 | installer: dry-run default, backup, atomic write, JSON re-parse, never in tests | design 01 tests + review |
| SEC-31 | log rotation keeps at most `LOG_KEEP` files of `LOG_ROTATE_BYTES`, survives a held file (S-LOG-6) | `engine/src/log/logger.test.ts` |

Every expected error code in `runtime/tests/security/*.test.ts` and `server/src/http/guards.test.ts` is declared with the type
`ErrorCode` imported from `@mcs/shared` (for example `const expected: ErrorCode = 'host_not_allowed'`), so renaming a code in the 03
catalogue breaks the type check of the suite instead of silently passing.

### 5.7 Tests that prove the primitives (slice S6)

- `engine/src/security/paths.test.ts`: every regex accept/reject table (uuid upper-case rejected, `..`, `/`, `\`, `:`, NUL, 65-char agent
  id); `resolveContained` with `..` segments, absolute candidates, other drive letters, case variants on win32; real junction escape
  (win32) and symlink escape (posix) in a temp dir.
- `engine/src/platform/exec.test.ts` (file owned by 06 PP1; these cases are required there): argv with spaces/quotes/`&|;` reaches the
  child verbatim (child = `process.execPath -e` printing `process.argv`), `.cmd` path -> `ChildResult` `SPAWN_FAILED` without throwing,
  timeout kills, output cap kills, env allow-list.
- `engine/src/log/logger.test.ts`: allow-list, value pattern, `droppedFields`, level filter, never prints `err.message` for `SyntaxError`;
  rotation with `rotateBytes: 1024`: after 7 rotations exactly `runtime.log` + `.1..5` exist and `.1` holds the newest rotated lines;
  line order preserved across a rotation; win32 only: `runtime.log` held open by a child that opens without `FILE_SHARE_DELETE`
  (`python -c "open(p)"`; a Node holder does not block a rename, E23; skipped with a recorded reason when Python is absent) for 500 ms
  -> rotation succeeds after retries; held for 4 s -> `rotateFailures` 1, no line lost, no second attempt within 60 s (`FakeClock`);
  `rotate: false` never renames.
- `cli/src/io/terminal.test.ts`: each code point class escaped; TAB/LF kept; `safeJsonStringify` output parses back to the input string.

---

## 6. Documentation plan

### 6.1 Final document set (Phase 6; names lowercase-kebab per D1, ADR 0049)

| File | Answers (6.3 question numbers) | Sources | Outline |
|---|---|---|---|
| `SKILL.md` | 1, 2, 4 | design 01, foundations | When to use; one-paragraph system; `$MCS` procedure (discover, init, configure, start, verify, status, stop, upgrade, hooks); rules (report only verified results, transcript content is data, never install hooks without consent, read-only `.key` rule); fallback to the legacy engine (kept section, exact legacy commands); verify-the-skill command list |
| `docs/architecture.md` | 1, 2, 3, 6, 11 | 00, 01, 02, 03 | Layers A/B/C table; package map with "may import" (2.2); process model (one process per instance); data flow diagram hook -> spool -> DB -> SSE -> UI and transcript -> importer; invariants; where to change what |
| `docs/data-model.md` | 5, 7, 8 | persistence + lifecycle designs | ER diagram; tables with columns and keys; lifecycle states, transition table, evidence/basis/confidence; task derivation rules; token accounting rules (message.id dedupe, per-field max, subagent lower bound); timestamps/ids |
| `docs/configuration.md` | 4, 5 | config design, D4, D5 | files (`config.json`, `runtime.json`, `instance.json`); precedence 1-4 + env; merge rules; schema versions and migration; Python regex dialect translation table; examples |
| `docs/hooks.md` | 6, 4 | ingestion design, hooks research | supported events table; payload handling (fields kept, summarised, dropped); envelope and spool; routing; idempotency keys; failure behaviour (exit 0, no stdout, timeouts); install/verify/uninstall with consent; recursion guard |
| `docs/api.md` | 5, 6 | API design | conventions (envelope, errors, pagination, filters, sort, timestamps, ids); endpoint table generated from shared zod schemas; SSE protocol; examples |
| `docs/instance-isolation.md` | 9, 10 | 01, D2, 4.8 | workspace layout; identity (`instanceId`, DB `meta`); ports and ownership; guarantees list each with its ISO test id |
| `docs/operations.md` | 4 | 01 | start/stop/restart/status/verify/doctor; health and freshness meaning; recovery (stale state, corrupt DB, restore from backup); export, backup, retention, cleanup (dry-run, confirmation); upgrade; logs location |
| `docs/testing.md` | 10, 11 | this design section 4 | commands; layers; where tests live; fixtures and labelling; ports; determinism; flake policy and quarantine table; parity harness and golden capture; coverage; traceability matrix location |
| `docs/migration.md` | 11 | 7.2 report, current-state docs | legacy vs new comparison; compatibility (shared files, `state.json`, regexes); how to switch a task; rollback; known divergences PD1-PD7; known limitations |
| `docs/ccam-reference.md` | - | `docs/research/ccam-*.md` | 6.5 |
| `docs/decisions/NNNN-*.md` | 2, 11 | all designs | ADRs (already written in Phase 1; status updated to Accepted/Superseded in Phase 6) |
| `docs/traceability.md` | 10 | 7.4 | requirement matrix |
| `docs/legacy/*.md` | legacy engine | moved files | unchanged content, banner line added at top |

### 6.2 Rules for AI-readable docs (each final doc)
1. First lines: one-sentence purpose, "Applies to: runtime vX / legacy", and "Read next" links.
2. Every behaviour claim names its source of truth: code path (`runtime/packages/engine/src/...`), schema (`schemas/*.json` or the zod
   export name) or test file; no claim without a path.
3. Prefer tables, numbered steps and small examples (real command lines with fixture data) over prose; one diagram per data flow.
4. Each doc ends with "Invariants" (bullets, each with its test id) and "Safe to change independently" / "Change together".
5. No private data; examples use the generic "nightly build" fixture vocabulary; English only (`check-text`).
6. Generated sections are marked `<!-- generated by <script>; do not edit -->` (API endpoint table, CLI command table, config key table).

### 6.3 The eleven questions (brief section 15) and where each is answered

| # | Question | Primary doc (section) |
|---|---|---|
| 1 | What is the system? | `SKILL.md` overview; `architecture.md` 1 |
| 2 | Skill vs runtime? | `architecture.md` "Layers"; `SKILL.md` |
| 3 | Where does each piece of code live? | `architecture.md` package map |
| 4 | Which command starts or validates it? | `operations.md` command table; `SKILL.md` procedure; `testing.md` commands |
| 5 | Which schema is authoritative? | `configuration.md` + `api.md` (zod export -> generated JSON Schema under `schemas/`) |
| 6 | How does a hook event reach the UI? | `architecture.md` data flow; `hooks.md` |
| 7 | Session state vs task completion? | `data-model.md` lifecycle + task derivation |
| 8 | How is token usage calculated? | `data-model.md` token accounting |
| 9 | How are projects isolated? | `instance-isolation.md` |
| 10 | Which tests verify each guarantee? | `traceability.md`; per-doc "Invariants" |
| 11 | Which changes are safe independently? | every doc's "Safe to change independently"; `architecture.md` |
`check-docs.mjs` (S10) asserts each listed doc exists, contains the headings named in this table, and that every relative link and every
code path in backticks that starts with `runtime/`, `scripts/`, `docs/` or `tests/` exists.

### 6.4 Moving the legacy docs (Phase 6, slice S10)
1. `git mv docs/{api,architecture,changelog,configuration,development,troubleshooting,ui-decision-record}.md docs/legacy/` (lead runs git).
2. Add at the top of each moved file: `> Legacy engine (Python, v2.x). The Node runtime docs are in ../`.
3. Fix links inside moved files: they link each other by bare name (`api.md`) and stay valid inside `docs/legacy/`; links to
   `../reference/*.md` become `../../reference/*.md`.
4. Links into the moved docs from outside: `SKILL.md` (lines 20, 48: rewritten anyway), `reference/transcript-format.md:22` and
   `reference/viewer-reference.md:3`. `reference/` is legacy read-only (C1): changing these two lines needs the lead's explicit approval.
   If not approved: the new `docs/api.md`, `docs/architecture.md` and `docs/configuration.md` start with the pointer line
   "Legacy engine: see `legacy/<name>.md`", and a one-line `docs/troubleshooting.md` stub points to `legacy/troubleshooting.md` and
   `operations.md`, so every old link still lands on a page that leads to the legacy text.
5. `check-docs.mjs` runs over `SKILL.md`, `docs/**/*.md`, `reference/*.md` and fails on broken relative links.

### 6.5 `docs/ccam-reference.md` plan
Sources: `docs/research/ccam-docs-analysis.md` (section 15 decision table, sections 13-14) and `ccam-source-analysis.md` (sections 1, 11,
14-16). Outline: (1) what CCAM is, URLs and review date 2026-10-11 (provenance lines copied from both research files); (2) decision table
with columns Feature / CCAM behaviour / Decision (ADOPT, ADAPT, DEFER, REJECT) / Where in our design (doc + ADR) / Status in v3
(implemented, deferred, rejected) filled from the research table plus the Phase 2-5 outcome; (3) security lessons (Host allow-list without
empty/0.0.0.0, path traversal probe, token in query string) mapped to our SEC ids; (4) test-gap lessons (ccam-source section 14) mapped to
our resilience/isolation tests; (5) explicitly not copied (non-goals D15). Rule: no CCAM code is copied; every row cites a source section.

### 6.6 Doc gates
`check:docs` and `check:text` run in `ci` once the docs exist (S10 adds them to `ci.mjs`).

---

## 7. Release gates and reports

### 7.1 Definition-of-done command list (run in order on a clean clone; `release-check.mjs` automates 2-9)

| Step | Command (cwd) | Pass condition |
|---|---|---|
| 1 | `git status --short` (skill root) | only intended changes; no untracked build output |
| 2 | `npm ci` (`runtime/`), on Node 24 and, where available, 22.22.x and 26 | exit 0, lockfile unchanged (`git diff --exit-code package-lock.json`) |
| 3 | `npm run ci -- --strict` | every gate PASS (format, lint, typecheck, deps, text, docs, test incl. isolation/resilience/security, build, smoke, audit); `--strict` turns a SKIPPED gate into a failure, so a release never ships with the smoke skipped |
| 4 | `npm run test:coverage` | thresholds met |
| 5 | `npm run test:stress` | 3 seeds pass |
| 6 | `npm run test:parity` with `MCS_PARITY_LIVE=1` and in golden mode | pass; divergences only those in 4.11.5 |
| 7 | `npm run test:e2e` | all specs pass (installed Chrome) |
| 8 | `PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests` and `node --test "tests/frontend/*.test.mjs"` (skill root) | legacy fallback intact |
| 9 | `$MCS` smoke on a temp repo with `MCS_HOME`: `init`, `start`, `verify`, `status`, `restart`, `stop`; a second instance in parallel; `doctor` | exit codes 0; ports closed after stop |
| 10 | Traceability matrix: every row status `verified` or `deferred` with reason | review |
| 11 | Quarantine table empty for release-blocking layers | review |
| 12 | Migration report (7.2) written from the actual outputs | review |

### 7.2 Migration report template (`docs/migration.md` section "Verification report", filled by the lead)
```
## Verification report (<UTC date>, commit <sha>, runtime <RUNTIME_VERSION>)
Machine: <OS>, Node <v>, npm <v>, Python <v>, Chrome <v>
Baseline: tag pre-v3-python; legacy suites: <python result line>; <node --test result line>
| Step (7.1) | Command | Result (exit, summary line) | Duration | Notes |
Parity: | Scenario | Projection | Live | Golden | Divergence ids |
Isolation: | ISO id | Test | Result |
Skipped or not run: | What | Reason | Risk |
Known divergences: PD table (4.11.5) with final decisions
Rollback: steps (7.2.1)
Known limitations: bullets with evidence
```
7.2.1 Rollback (content of the report section): stop Node instances (`$MCS stop --task <slug>`); start the legacy viewer with the
unchanged legacy command (`python .claude/skills/monitoring-claude-sessions/template/viewer.py start --task <slug>`); Node-only files
(`instance.json`, `runtime.json`, `data/`, `logs/`) are ignored by the legacy engine and can stay; hooks: `$MCS hooks uninstall` (dry-run
first) or leave them (handler is fail-safe and only writes the spool); git: `git checkout pre-v3-python -- SKILL.md` restores the old
procedure text.

### 7.3 Final report format (brief section 18, used by the lead)
1. Current architecture and major changes (diagram + package table + what moved).
2. Technology decisions and reasons (ADR index with one line each).
3. Features implemented (table: feature, brief section, evidence test/command).
4. Features deferred and why (table, with brief section and ADR).
5. Isolation guarantees and the tests proving them (ISO table with results).
6. Commands executed and their actual results (from the release-check output; exit codes and summary lines verbatim; SKIPPED rows kept).
7. Migration and rollback instructions (7.2.1).
8. Known limitations (with evidence or UNVERIFIED labels).
9. Files future agents should read first (`SKILL.md`, `docs/architecture.md`, `docs/traceability.md`, `docs/testing.md`, ADR index).
Rule: a statement without a command result or test reference is labelled UNVERIFIED.

### 7.4 Requirements traceability matrix (`docs/traceability.md`)
Row format:
```
| Req id | Source | Requirement (short) | Design (doc#section) | Code (path#symbol) | Test (path > title) | Status | Evidence |
| B4-ISO-3 | brief 4 "Required isolation tests" bullet 3 | A's tokens exclude B | 05#4.8 | engine/src/tokens/aggregate.ts#totalsForInstance | tests/isolation/token-isolation.test.ts > T-ISO-09 ... | verified | npm run test:isolation 2026-..-.. exit 0 |
```
Id scheme: `B<section>-<tag>-<n>` for brief items (`B4-ISO-1..8`, `B5-HOOK-n`, `B6-LC-n`, `B12-SEC-n`, `B14-UT-n`, `B14-IT-n`,
`B14-E2E-1..14`, `B18-DOD-n`), `F-D<n>` for foundations decisions, `SEC-nn` for 5.6 lines. Status: `planned | implemented | verified |
deferred (reason) | not applicable (reason)`. Test ids are quoted as their owners write them: `T-LC-*` are 01's process-lifecycle
tests (01 4.16) and `T-LF-*` are 02's lifecycle-model tests (02 7.12, 9.5; critic N-12, registry C37), so a lifecycle-model row cites
`T-LF-*`, never `T-LC-*`. Evidence: command + date + exit code, or review note + reviewer. One matrix for the whole
migration; each design doc's "Requirements covered" list seeds the rows.

---

## 8. CI

### 8.1 Local (`npm run ci`, `scripts/ci.mjs`, Appendix A.36)
Order: `format:check`, `lint`, `typecheck`, `check:deps`, (`check:text`, `check:docs` once S9/S10 land), `test` (unit, web, integration,
isolation, resilience, security), `build`, `smoke`, `audit` (skipped with `--offline`). `--full` adds `test:parity` and `test:e2e`.
Stops at the first failure unless `--keep-going`; prints a Markdown table `| gate | result | ms |` and lists gates not run; exit 0 only if
every gate ran and passed or reported `SKIPPED (exit 77)`. Exit code 77 is the one way a gate says "cannot run yet" (today only the
smoke before 01 S8/S9 are built, 3.2); the table shows it as `SKIPPED (exit 77)`, never as PASS, and `--strict` (release step 7.1-3)
counts it as a failure. Measured on the scaffold: 35 s (cold), 54 s (machine busy), about 25 s warm; lint is the slowest gate
(19.6-26.4 s cold, 5.6 s warm).

### 8.2 GitHub Actions (inactive)
The skill repository has a remote (`origin` on GitHub) but this design does not activate CI: the workflow is shipped as
`runtime/ci/github-actions-ci.yml` (Appendix A.41) and the owner activates it with `git mv runtime/ci/github-actions-ci.yml
.github/workflows/ci.yml`. It was validated locally only (YAML parsed with PyYAML 6.0.3; Prettier-formatted); it was NOT executed
remotely. Jobs: `gates` matrix {windows-latest, ubuntu-latest} x {22.22, 24, 26} running `npm ci` + `npm run ci`; `e2e-and-parity` on
windows-latest/Node 24 + Python 3.12 running the legacy suites and `npm run ci:full`, uploading Playwright traces on failure.
`permissions: contents: read`, `persist-credentials: false`, actions pinned by commit SHA (looked up with `git ls-remote` 2026-10-11:
checkout v7.0.1 `3d3c42e5...`, setup-node v7.1.0 `949feb24...`, setup-python v7.0.0 `5fda3b95...`, upload-artifact v7.0.2 `cf430e03...`).
UNVERIFIED: Chrome availability on the hosted runner image at activation time (Playwright `channel: 'chrome'` needs it).

---

## 9. Experiments (2026-10-11, all in `D:/mvp/private/scratch/mcs-v3/`)

| Id | What | Command (short) | Observed |
|---|---|---|---|
| E1 | Install pinned workspace | `npm install --prefer-offline` (scaffold-check/runtime) | 397 packages in 13 s, 0 vulnerabilities, no ERESOLVE/EBADENGINE; `node_modules/@mcs/*` are junction links to `packages/*` |
| E2 | Offline clean install | clean copy, `npm ci --offline` | 6.8 s / 7.2 s, `package-lock.json` byte-identical (sha256 check OK) |
| E3 | Cold install | `npm ci --cache <empty>` | 15.7 s, `node_modules` 273 MB, cache 57 MB |
| E4 | Type check without build | `npm run typecheck` | 8 projects ok, 4.5-6.5 s; `tsc --listFilesOnly` shows `packages/shared/src/*.ts` resolved through `@mcs/source` with no `dist` |
| E5 | Build | `npm run build` | `tsc -b` + Vite 8.3.4 (2005 modules) + stamp in 1.9-5.4 s; `dist/main.js` imports `./app.js` (rewritten); no test files in `dist` |
| E6 | Lint probes (layering/safety) | probe files in each package, `eslint -f json` | 35 messages: 33 targeted findings, each on the expected line and rule; 2 type-aware side effects (`no-unsafe-*`) of the deliberately broken code; `as const`, `node:crypto` + `@mcs/shared/protocol` in the hook, assertions in tests accepted |
| E7 | Lint probes (web rules of 04) | `lib/probe.ts`, `ProbeLink.tsx` | lucide outside icons.ts, react in lib, fixture import, `localStorage`, `fetch`, computed `href`, `target="_blank"` all errors |
| E8 | HTTP test flake source | server int test with Node global agent | 2nd request on reused keep-alive socket -> `read ECONNRESET` inside Vitest (not reproduced outside); `agent: false` passes |
| E9 | Vitest condition config | remove blocks one at a time | without `ssr.resolve.conditions` -> `Failed to resolve entry for package "@mcs/testkit"`; top-level `resolve.conditions` not needed |
| E10 | Coverage gate | `npm run test:coverage` on stubs | 77.5% lines < 80 -> 4 threshold errors, exit 1 |
| E11 | Shuffle/seed, JSON reporter | `vitest run --sequence.shuffle --sequence.seed=3`; `--reporter=json` | both work on Vitest 5.0.3 |
| E12 | Security behaviours | `security-probe/probe.mjs` | `JSON.parse` error message contains `""prompt": FIXTURE_SE"` (input echo); `JSON.stringify` leaves U+009B, U+202E, U+2028 raw; junction `lstat().isSymbolicLink() === true`, realpath resolves through it; `spawn('x.cmd', {shell:false})` throws `EINVAL` synchronously |
| E13 | Python oracle | `viewer.py serve --config <tmp> --port 18850` on `make.py` fixture | 200 health, 5 sessions, nothing written in the skill folder; stopped by verified pid |
| E14 | Full gate run | clean copy `npm run ci`; `npm run test:e2e` | all 8 gates PASS (35 s cold, 54 s busy); Playwright `channel: 'chrome'` 3 passed incl. a page test and a `@mcs/testkit` import from `dist` |
| E15 | Other Node lines | typecheck, vitest, eslint, tsc -b, vite build, smoke, `node --conditions=@mcs/source hook.ts` with Node 22.23.3 and 26.11.1 | all pass; no ExperimentalWarning |
| E16 | Dev mode | `npm run dev` on 18781/18782 and 18783/18784 | server from TS sources via type stripping (no warning on 24.14.1); Vite proxy with Origin rewrite -> 200; processes stopped by command-line match |
| E17 | Hook start cost | `echo {} \| node packages/cli/dist/hook.js` x5 | 78-98 ms vs bare `node -e ""` 61-75 ms (+~25 ms for the ESM graph) |
| E18 | Stamps | `build-stamp.mjs check` | 9 ms warm / 103 ms cold; path-independent; test edit -> no rebuild, src edit -> rebuild, `.npmrc` edit -> reinstall |
| E19 | Line endings | CRLF file + `prettier --check`; `git check-attr` | Prettier fails on CRLF; new paths get `eol: lf` despite `core.autocrlf=true` |
| E20 | Deps gate | undeclared `vitest` in engine src, `^5.3.0` in server, then `@mcs/testkit` in web e2e | each reported, exit 1; fixed by `npm install -D @mcs/testkit@3.0.0 -w @mcs/web` (exact spec written) |
| E21 | Workflow file | PyYAML parse, Prettier | parses (2 jobs, 6-cell matrix); not run remotely |
| E22 | Driver module rename (critic issue I-14) | `scaffold-check`: `db/sqlite.ts` -> `db/driver.ts`, eslint config paths updated, probe `src/probe-i14/other.ts` importing `better-sqlite3` | probe -> 1 error `no-restricted-imports` "Only engine/src/db/driver.ts opens the driver"; without the probe engine src+test lint exit 0, `tsc -p packages/engine` exit 0 |
| E23 | Renaming a held log file (S-LOG-6) | `tooling-fix/rot/rot.mjs`: `renameSync('runtime.log', 'runtime.log.1')` while another process holds the source | Python `open(p)` or `open(p, 'a')` holder -> `EBUSY`, retry succeeds about 1.5 s later when the holder exits; Node `fs.openSync` holder -> rename succeeds at once (libuv opens with `FILE_SHARE_DELETE`) |
| E24 | Revision 2 appendix files (N-02, I-34, C32, C45, C46) | `tooling-fix/rev2/runtime` = copy of `scaffold-check/runtime` with A.1, A.9, A.21, A.31, A.36, A.37, A.40 extracted from this document; `npm run ci -- --offline` (+ `--strict`); ESLint `lintFiles` probes; smoke against a fake CLI | `ci`: format, lint, typecheck, check:deps, test, build PASS, smoke `SKIPPED (exit 77)` (no `server/dist/boot.js`), exit 0; `--strict` exit 1. Probe `import os; process.platform; os.platform(); process.stdout.write` -> `engine/src/panels/x.ts` 3 errors (L2 properties, L3 syntax, L5 properties); `platform/x.ts`, `security/paths.ts` only L5; `log/logger.ts` L2, L3 (stdio allowed); `engine/src/panels/x.test.ts`, `server/src/x.ts`, `cli/src/x.ts` no platform error; `shared/src/protocol/x.ts` only the `node:os` import ban. Smoke with a fake `cli/dist/main.js` (init/start/stop of a detached host-checking server): `port 18800 health 200, foreign host 403, stop exit 0, port closed true`, exit 0; with 18800 occupied it used 18801; temp root removed. The real `init`/`start`/`stop` path is UNVERIFIED until 01 S9 |

---

## 10. CHALLENGES

**C-1 (D7 Node floor 22.12 -> effective floor 22.22.0).** Evidence: `npm view react-router@8.4.0 engines` = `{"node": ">=22.22.0"}`
(2026-10-11); D6's bootstrap installs and builds the whole workspace, including react-router, on the user's machine; stack-versions
recommends root engines `^22.22.0 || ^24.0.0 || >=26.0.0`, which the scaffold uses (no EBADENGINE on 24.14.1, E1). On 22.12-22.21 `npm ci`
would print EBADENGINE warnings (not fatal without `engine-strict`) and the launcher would run a toolchain outside its declared support.
Alternative: launcher floor 22.22.0 (the runtime server alone could run on 22.12, but there is no supported way to get it without the
build). Status: resolved by critic issue I-05: one floor 22.22.0 for the launcher (01 section 5.1 step 1, ADR 0007, no warning branch)
and the `engines` field; the lead annotates D7.

**C-2 (D1 five packages -> plus `@mcs/testkit`).** Unit tests in four packages, the cross-package suites, the parity harness and Playwright
all need the same fixture builders; options without a package were (a) duplicated builders per package (drift), (b) relative imports out of
a package (breaks `rootDir`/project boundaries and the deep-import lint rule), (c) test code inside `@mcs/shared` (ships test code). A
private dev-only package costs nothing at runtime (not imported by any `src/**`, lint- and check-deps-enforced) and builds in well under a
second (E5). If rejected: fall back to (a) for package unit tests and keep testkit sources under `runtime/tests/kit/` for the suites.

**C-3 (D1 `tests/legacy-parity/` holds the cross-engine tests).** Node module resolution of `@mcs/*` only works under `runtime/` (the
workspace `node_modules`), so the executable parity suite lives in `runtime/tests/parity/`; `tests/legacy-parity/` keeps the artefacts D1
places there (goldens, the generator tools and README, owned by design 06 PP2). No behaviour change; only the code location moves.

**C-4 (D6 "stamp of lockfile + sources" -> two stamps).** One combined stamp would run `npm ci` (7-16 s, E2/E3) after every source edit.
Separate install and build stamps re-install only when the lockfile, `.npmrc`, platform or Node major change. Also: with
`ignore-scripts=true` npm runs no root lifecycle scripts, so the launcher itself must write the install stamp (3.3.4 item 2, 01 section 5.1 step 6e).

Coordination notes for design 04 (not foundation challenges): (1) and (2) are resolved by critic issue I-13: 04 section 12.2 adopts
Appendix A.27 (`MCS_DEV_API` default `http://127.0.0.1:18765`, `MCS_WEB_DEV_PORT` 18766, preview 18767, the `resolve.conditions`
line) and documents `npm run dev` (3.1); (3) web forbids importing `zod` directly (schemas and inferred types come from `@mcs/shared`);
(4) `axe-core` must be added with an exact version to `packages/web/devDependencies` for `check-deps`.

Environment variables read by code this design owns (listed for 01 section 2.10, critic issue I-27, which owns the complete table and
whose `tests/tooling/env-vars.test.ts` greps for unlisted names): `MCS_PARITY_LIVE` (parity live mode, 4.11.2), `MCS_GOLDEN_DIR`
(golden folder override, 4.11.3), `MCS_DEV_API`, `MCS_WEB_DEV_PORT` (set by `scripts/dev.mjs`, read by `vite.config.ts`),
`MCS_BUILD_ID` (`vite.config.ts` define), `MCS_LOG_LEVEL` (logger, S-LOG-1), `MCS_HOME` and `MCS_HOOK_DISABLE` (set by testkit and
scripts, read by 01/02 code). `MCS_E2E_CLAUDE` gates 02's optional real-provider E2E. There is no `MCS_E2E_PORT`: it was read only by
the withdrawn A.28 stub (critic N-02, I-27; 01 section 2.10 drops it).

---

## Appendix A. Scaffold files (verbatim from `D:/mvp/private/scratch/mcs-v3/scaffold-check`, verified by E1-E22)

Paths are relative to the skill root. A.39 (`terminal.ts`) and A.40 (`testkit/src/index.ts`) are scaffold stubs: the full contracts are
5.3 S-OUT and 4.4. Package `tsconfig.json` files for engine, server and cli are identical (`{"extends": "../../tsconfig.check.json",
"include": ["src", "test"]}`). Stub sources used for the check (not part of the deliverable; the real `HealthReport` module is 03's `shared/src/api/health.ts`,
registry C51): `shared/src/{index,health}.ts`,
`shared/src/protocol/index.ts`, `engine/src/{index.ts,db/driver.ts,platform/exec.ts,log/logger.ts}` (`db/driver.ts` was `db/sqlite.ts` until E22; the rename is the only change), `server/src/{app,index,main}.ts`,
`cli/src/{main,hook}.ts`, `cli/src/hook/hook.ts`, `web/src/{main,App}.tsx`, `web/src/components/icons.ts`, `web/src/test/setup.ts`, one
test per layer, `web/e2e/specs/health.spec.ts`.
Revision 2 (critic N-02, I-34, N-07, registry C32, C45, C46): A.9 (platform entries), A.21 (`./legacy` export), A.31 (Node floor
comment), A.36 (exit 77 = SKIPPED, `--strict`), A.37 (CLI-driven smoke) and A.40 (`allocatePort(range)`) changed after the scaffold run;
they were re-checked in a copy of the scaffold (E24, section 9). A.28 is withdrawn in favour of 04's config (04 W14).

### A.1 `runtime/package.json`

````json
{
  "name": "@mcs/runtime",
  "version": "3.0.0",
  "private": true,
  "description": "Runtime workspace of the monitoring-claude-sessions skill (engine, server, CLI, web UI).",
  "license": "UNLICENSED",
  "type": "module",
  "workspaces": [
    "packages/shared",
    "packages/engine",
    "packages/server",
    "packages/cli",
    "packages/web",
    "packages/testkit"
  ],
  "engines": {
    "node": "^22.22.0 || ^24.0.0 || >=26.0.0"
  },
  "scripts": {
    "clean": "node scripts/clean.mjs",
    "build": "node scripts/clean.mjs && tsc -b tsconfig.build.json && npm run build -w @mcs/web && node scripts/build-stamp.mjs write",
    "typecheck": "node scripts/typecheck.mjs",
    "lint": "eslint . --max-warnings 0",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "check:deps": "node scripts/check-deps.mjs",
    "test": "vitest run --project unit --project web --project integration --project isolation --project resilience",
    "test:unit": "vitest run --project unit --project web",
    "test:int": "vitest run --project integration",
    "test:isolation": "vitest run --project isolation",
    "test:resilience": "vitest run --project resilience",
    "test:parity": "vitest run --project parity",
    "test:coverage": "vitest run --coverage --project unit --project web --project integration",
    "test:e2e": "playwright test -c packages/web/e2e/playwright.config.ts",
    "dev": "node scripts/dev.mjs",
    "start": "node packages/cli/dist/main.js start",
    "migrate": "node packages/cli/dist/main.js db migrate",
    "health": "node packages/cli/dist/main.js verify",
    "init-instance": "node packages/cli/dist/main.js init",
    "audit": "npm audit --audit-level=low",
    "audit:prod": "npm audit --omit=dev --audit-level=low",
    "ci": "node scripts/ci.mjs",
    "ci:full": "node scripts/ci.mjs --full"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@playwright/test": "1.64.0",
    "@tsconfig/node24": "24.0.5",
    "@types/node": "24.19.2",
    "@vitest/coverage-v8": "5.0.3",
    "eslint": "10.12.0",
    "eslint-plugin-jsx-a11y": "6.10.2",
    "eslint-plugin-react-hooks": "7.1.1",
    "globals": "17.13.0",
    "prettier": "3.9.10",
    "typescript": "6.0.3",
    "typescript-eslint": "8.71.1",
    "vitest": "5.0.3"
  },
  "overrides": {
    "eslint-plugin-jsx-a11y": {
      "eslint": "$eslint"
    }
  }
}
````
This is the slice S1 baseline. Scripts added later by the slice that adds their file (3.1): `check:text`, `test:stress`,
`release-check` (S9), `check:docs` (S10), `test:security` and `--project security` in `test`, `parity:capture`, `parity:check` (S8),
`test:tooling` (S1 with the tooling project), `schemas`, `schemas:check` (01 S16), `parity:shadow` (06 PP9), `bench` (06 PP10),
`testkit` (06 PP6) (registry C45).

### A.2 `runtime/.npmrc`

````ini
ignore-scripts=true
save-exact=true
fund=false
update-notifier=false
````

### A.3 `runtime/tsconfig.base.json`

````json
{
  "extends": "@tsconfig/node24/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "rewriteRelativeImportExtensions": true,
    "resolveJsonModule": false,
    "skipLibCheck": true,
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true,
    "newLine": "lf"
  }
}
````

### A.4 `runtime/tsconfig.check.json`

````json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "customConditions": ["@mcs/source"]
  }
}
````

### A.5 `runtime/tsconfig.build.json`

````json
{
  "files": [],
  "references": [
    { "path": "packages/shared/tsconfig.build.json" },
    { "path": "packages/engine/tsconfig.build.json" },
    { "path": "packages/server/tsconfig.build.json" },
    { "path": "packages/cli/tsconfig.build.json" },
    { "path": "packages/testkit/tsconfig.build.json" }
  ]
}
````

### A.6 `runtime/.prettierrc.json`

````json
{
  "singleQuote": true,
  "printWidth": 120,
  "trailingComma": "all",
  "endOfLine": "lf"
}
````

### A.7 `runtime/.prettierignore`

````text
**/dist/
**/coverage/
**/node_modules/
**/test-results/
**/playwright-report/
.dev/
package-lock.json
````

### A.8 `runtime/.editorconfig`

````ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
````

### A.9 `runtime/eslint.config.js`

````js
// Flat config for the runtime workspace. Layering and safety rules are documented in
// docs/design/05-tooling-testing-security.md section 2.6; change both together.
import { builtinModules } from 'node:module';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_BUILTINS = [...builtinModules.filter((m) => !m.startsWith('_')), 'node:*'];

/** Packages that must never be added (stack-versions.md section 9, ADR-0041). */
const BANNED_PACKAGES = [
  'axios',
  'node-fetch',
  'lodash',
  'moment',
  'date-fns',
  'uuid',
  'dotenv',
  'commander',
  'yargs',
  'ws',
  'socket.io',
  'cors',
  'body-parser',
  'jsdom',
  'rehype-raw',
  'marked',
  'markdown-it',
  'ts-node',
  'tsx',
  'pino',
].map((name) => ({ name, message: 'Banned dependency (see ADR-0041 avoid list).' }));

const DEEP_IMPORTS = [
  {
    group: ['@mcs/*/src/*', '@mcs/*/dist/*'],
    message: 'Import a package through its exports map, never by file path.',
  },
  {
    regex: '^(\\.\\./)+(shared|engine|server|cli|web|testkit)/',
    message: 'Do not reach into another workspace package with a relative path; import @mcs/<name>.',
  },
];

/**
 * Builds one complete `no-restricted-imports` entry. Flat config replaces a rule per block, so every
 * block must carry the global bans plus its own.
 */
function restrictImports({ paths = [], patterns = [] } = {}) {
  return ['error', { paths: [...BANNED_PACKAGES, ...paths], patterns: [...DEEP_IMPORTS, ...patterns] }];
}

const forbid = (names, message) => ({ group: names, message });

const UNSAFE_HTML_SYNTAX = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'Do not inject raw HTML; render text or sanitized markdown elements.',
  },
  {
    selector: 'AssignmentExpression > MemberExpression[property.name=/^(innerHTML|outerHTML)$/]',
    message: 'Do not assign HTML strings to the DOM.',
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: 'Do not write HTML strings to the DOM.',
  },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
    message: 'Do not write HTML strings to the DOM.',
  },
];

const NO_SHELL_SYNTAX = [
  {
    selector: "Property[key.name='shell'][value.value=true]",
    message: 'Child processes run without a shell: pass an argv array.',
  },
];

const CHILD_PROCESS_UNSAFE = {
  name: 'node:child_process',
  importNames: ['exec', 'execSync'],
  message: 'exec/execSync go through a shell; use execFileText from @mcs/engine.',
};

const NO_STDIO = [
  { object: 'process', property: 'stdout', message: 'Write output through the CLI terminal module or the logger.' },
  { object: 'process', property: 'stderr', message: 'Write output through the CLI terminal module or the logger.' },
];

/** Platform branching lives in engine/src/platform/** (06-panels-parity-platform.md section 4, critic I-34). */
const PLATFORM_ENTRY = {
  object: 'process',
  property: 'platform',
  message: 'Branch on the platform only in engine/src/platform/** (import hostPlatform from platform/host.ts).',
};

const OS_PLATFORM_SYNTAX = {
  selector: "CallExpression[callee.object.name='os'][callee.property.name='platform']",
  message: 'Branch on the platform only in engine/src/platform/** (import hostPlatform from platform/host.ts).',
};

const WEB_SYNTAX = [
  {
    selector: 'JSXAttribute[name.name=/^(href|src|srcDoc|formAction|action)$/] > JSXExpressionContainer',
    message: 'No computed href/src: build internal links with router Link from ids.',
  },
  { selector: "JSXAttribute[name.name='target'][value.value='_blank']", message: 'The UI renders no external links.' },
];

/** Web import rule; flags lift single exceptions owned by one file (04-ui.md section 8). */
function webImports({ lucide = false, extra = [] } = {}) {
  return restrictImports({
    paths: [{ name: 'react-router-dom', message: 'Use react-router (v8 single package).' }],
    patterns: [
      forbid(NODE_BUILTINS, 'web runs in the browser.'),
      forbid(
        ['@mcs/engine', '@mcs/server', '@mcs/cli', '@mcs/testkit', 'express', 'better-sqlite3', 'zod'],
        'web imports only @mcs/shared (schemas come from shared).',
      ),
      forbid(
        ['react-markdown', 'remark*', 'rehype*', 'dompurify'],
        'Markdown is the ported legacy subset (04-ui.md section 8).',
      ),
      ...(lucide ? [] : [forbid(['lucide-react'], 'Icons come from src/components/icons.ts only.')]),
      forbid(['**/test/**', '**/fixtures/**'], 'Production code never imports test code or fixtures.'),
      ...extra,
    ],
  });
}

const WEB_GLOBALS = {
  fetch: 'Only src/data/api-client.ts calls fetch.',
  EventSource: 'Only src/stream/stream-client.ts opens EventSource.',
  localStorage: 'Only src/lib/prefs.ts touches storage.',
  sessionStorage: 'Only src/lib/prefs.ts touches storage.',
};

function webGlobals(...allowed) {
  return [
    'error',
    ...Object.entries(WEB_GLOBALS)
      .filter(([name]) => !allowed.includes(name))
      .map(([name, message]) => ({ name, message })),
  ];
}

const SRC = (pkg) => `packages/${pkg}/src/**/*.{ts,tsx}`;
const TEST_FILES = [
  '**/*.test.{ts,tsx}',
  'packages/*/test/**/*.ts',
  'packages/web/src/test/**/*.{ts,tsx}',
  'tests/**/*.ts',
  'packages/web/e2e/**/*.ts',
];

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '.dev/**',
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': restrictImports({ paths: [CHILD_PROCESS_UNSAFE] }),
      'no-restricted-syntax': ['error', ...UNSAFE_HTML_SYNTAX, ...NO_SHELL_SYNTAX],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  // ---- layering: shared is isomorphic and depends on nothing internal
  {
    files: [SRC('shared')],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': restrictImports({
        patterns: [
          forbid(NODE_BUILTINS, 'shared is isomorphic: no Node built-ins.'),
          forbid(['@mcs/*', 'express', 'better-sqlite3', 'react', 'react-*'], 'shared depends only on zod.'),
        ],
      }),
    },
  },
  {
    files: ['packages/shared/src/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports({
        patterns: [
          forbid(
            [...NODE_BUILTINS, '@mcs/*', 'zod', 'express', 'better-sqlite3', 'react'],
            'protocol is dependency-free.',
          ),
          { regex: '^\\.\\./', message: 'protocol must not import the zod-based part of shared.' },
        ],
      }),
    },
  },
  // ---- engine: Node domain; no HTTP, no UI, no CLI
  {
    files: [SRC('engine')],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': restrictImports({
        paths: [
          { name: 'better-sqlite3', message: 'Only engine/src/db/driver.ts opens the driver.' },
          { name: 'node:child_process', message: 'Only engine/src/platform/exec.ts starts processes.' },
          { name: 'child_process', message: 'Use node:child_process inside engine/src/platform/exec.ts only.' },
        ],
        patterns: [
          forbid(
            ['@mcs/server', '@mcs/cli', '@mcs/web', '@mcs/testkit', 'express', 'react', 'react-*'],
            'engine must not depend on server, cli, web or test code.',
          ),
        ],
      }),
      'no-restricted-properties': ['error', ...NO_STDIO, PLATFORM_ENTRY],
      'no-restricted-syntax': ['error', ...UNSAFE_HTML_SYNTAX, ...NO_SHELL_SYNTAX, OS_PLATFORM_SYNTAX],
    },
  },
  {
    // allow-list of the platform rule; re-declares the stdio and base syntax entries (a later block replaces rule options)
    files: ['packages/engine/src/platform/**/*.ts', 'packages/engine/src/security/paths.ts'],
    rules: {
      'no-restricted-properties': ['error', ...NO_STDIO],
      'no-restricted-syntax': ['error', ...UNSAFE_HTML_SYNTAX, ...NO_SHELL_SYNTAX],
    },
  },
  {
    files: ['packages/engine/src/db/driver.ts'],
    rules: {
      'no-restricted-imports': restrictImports({
        patterns: [forbid(['@mcs/server', '@mcs/cli', '@mcs/web', '@mcs/testkit'], 'engine layering')],
        paths: [CHILD_PROCESS_UNSAFE],
      }),
    },
  },
  {
    files: ['packages/engine/src/platform/exec.ts'],
    rules: {
      'no-restricted-imports': restrictImports({
        paths: [
          CHILD_PROCESS_UNSAFE,
          { name: 'better-sqlite3', message: 'Only engine/src/db/driver.ts opens the driver.' },
        ],
        patterns: [forbid(['@mcs/server', '@mcs/cli', '@mcs/web', '@mcs/testkit'], 'engine layering')],
      }),
    },
  },
  {
    files: ['packages/engine/src/log/logger.ts'],
    rules: { 'no-restricted-properties': ['error', PLATFORM_ENTRY] },
  },
  // ---- server: HTTP over engine; never the driver, never processes
  {
    files: [SRC('server')],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': restrictImports({
        paths: [
          { name: 'better-sqlite3', message: 'Use engine repositories.' },
          { name: 'node:child_process', message: 'The server never starts processes.' },
          { name: 'child_process', message: 'The server never starts processes.' },
        ],
        patterns: [
          forbid(
            ['@mcs/cli', '@mcs/web', '@mcs/testkit', 'react', 'react-*'],
            'server depends on engine and shared only.',
          ),
        ],
      }),
      'no-restricted-properties': ['error', ...NO_STDIO],
    },
  },
  // ---- cli: commands over engine; output through io/terminal.ts only
  {
    files: [SRC('cli')],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': restrictImports({
        paths: [
          { name: 'better-sqlite3', message: 'Use engine repositories.' },
          { name: 'node:child_process', message: 'Use execFileText/spawnDetached from @mcs/engine.' },
          { name: 'child_process', message: 'Use execFileText/spawnDetached from @mcs/engine.' },
        ],
        patterns: [
          forbid(
            ['@mcs/server', '@mcs/web', '@mcs/testkit', 'express', 'react', 'react-*'],
            'cli depends on engine and shared only.',
          ),
        ],
      }),
      'no-restricted-properties': ['error', ...NO_STDIO],
    },
  },
  {
    files: ['packages/cli/src/io/terminal.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    files: ['packages/cli/src/hook.ts', 'packages/cli/src/hook/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports({
        patterns: [
          {
            regex: '^(?!node:|@mcs/shared/protocol$|\\./)',
            message: 'The hook handler imports only node:* and @mcs/shared/protocol (fast start, no zod).',
          },
        ],
      }),
    },
  },
  // ---- web: browser only, talks to the server over HTTP, imports only shared (rules from 04-ui.md section 8)
  {
    files: [SRC('web')],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'no-script-url': 'error',
      'no-restricted-imports': webImports(),
      'no-restricted-globals': webGlobals(),
      'no-restricted-syntax': ['error', ...UNSAFE_HTML_SYNTAX, ...WEB_SYNTAX],
    },
  },
  { files: ['packages/web/src/components/icons.ts'], rules: { 'no-restricted-imports': webImports({ lucide: true }) } },
  { files: ['packages/web/src/data/api-client.ts'], rules: { 'no-restricted-globals': webGlobals('fetch') } },
  {
    files: ['packages/web/src/stream/stream-client.ts'],
    rules: { 'no-restricted-globals': webGlobals('EventSource') },
  },
  {
    files: ['packages/web/src/lib/prefs.ts'],
    rules: { 'no-restricted-globals': webGlobals('localStorage', 'sessionStorage') },
  },
  {
    files: ['packages/web/src/lib/**/*.ts'],
    rules: {
      'no-restricted-imports': webImports({
        extra: [
          forbid(['react', 'react-dom', 'react-router', '@tanstack/*'], 'lib/ is pure: no React, router or query.'),
        ],
      }),
    },
  },
  // ---- tests: assertions allowed, no sleeps, fixtures from testkit
  {
    files: TEST_FILES,
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-imports': restrictImports(),
      'no-restricted-syntax': [
        'error',
        ...UNSAFE_HTML_SYNTAX,
        ...NO_SHELL_SYNTAX,
        {
          selector: "CallExpression[callee.name='setTimeout']",
          message: 'No sleeps in tests: use fake timers or waitFor() from @mcs/testkit.',
        },
      ],
    },
  },
  {
    files: ['packages/web/src/**/*.test.tsx', 'packages/web/src/**/*.test.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  // ---- plain JS tooling (scripts/, config files)
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
);
````

### A.10 `runtime/vitest.config.ts`

````ts
import { defineConfig } from 'vitest/config';

const SOURCE_CONDITION = '@mcs/source';

export default defineConfig({
  ssr: { resolve: { conditions: [SOURCE_CONDITION, 'node', 'import', 'default'] } },
  test: {
    // Determinism defaults for every project (05-tooling-testing-security.md section 3.6).
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 10_000,
    hookTimeout: 20_000,
    env: { TZ: 'UTC', MCS_HOOK_DISABLE: '1' },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/{shared,engine,server,cli,testkit}/src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          pool: 'forks',
          include: ['packages/*/test/**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: { name: 'isolation', environment: 'node', pool: 'forks', include: ['tests/isolation/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'resilience', environment: 'node', pool: 'forks', include: ['tests/resilience/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'parity', environment: 'node', pool: 'forks', include: ['tests/parity/**/*.test.ts'] },
      },
      './packages/web/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', 'packages/testkit/**', '**/main.ts', '**/main.tsx', '**/hook.ts', '**/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
        'packages/engine/src/{lifecycle,ingest,tokens,config}/**': {
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 85,
        },
        'packages/shared/src/**': { lines: 90, statements: 90, functions: 90, branches: 85 },
      },
    },
  },
});
````

### A.11 `runtime/packages/shared/package.json`

````json
{
  "name": "@mcs/shared",
  "version": "3.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "@mcs/source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./protocol": {
      "@mcs/source": "./src/protocol/index.ts",
      "types": "./dist/protocol/index.d.ts",
      "default": "./dist/protocol/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc -b tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "zod": "4.6.5"
  }
}
````

### A.12 `runtime/packages/shared/tsconfig.json`

````json
{
  "extends": "../../tsconfig.check.json",
  "compilerOptions": {
    "lib": ["es2024"],
    "types": []
  },
  "include": ["src"]
}
````

### A.13 `runtime/packages/shared/tsconfig.build.json`

````json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "lib": ["es2024"],
    "types": [],
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
````

### A.14 `runtime/packages/engine/package.json`

````json
{
  "name": "@mcs/engine",
  "version": "3.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "@mcs/source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc -b tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@mcs/shared": "3.0.0",
    "better-sqlite3": "13.0.3",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@mcs/testkit": "3.0.0",
    "@types/better-sqlite3": "9.6.0"
  }
}
````

### A.15 `runtime/packages/engine/tsconfig.json`

````json
{
  "extends": "../../tsconfig.check.json",
  "include": ["src", "test"]
}
````

### A.16 `runtime/packages/engine/tsconfig.build.json`

````json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"],
  "references": [{ "path": "../shared/tsconfig.build.json" }]
}
````

### A.17 `runtime/packages/server/package.json`

````json
{
  "name": "@mcs/server",
  "version": "3.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "@mcs/source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc -b tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@mcs/engine": "3.0.0",
    "@mcs/shared": "3.0.0",
    "express": "5.3.0",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@mcs/testkit": "3.0.0",
    "@types/express": "5.0.6"
  }
}
````

### A.18 `runtime/packages/server/tsconfig.build.json`

````json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"],
  "references": [{ "path": "../shared/tsconfig.build.json" }, { "path": "../engine/tsconfig.build.json" }]
}
````

### A.19 `runtime/packages/cli/package.json`

````json
{
  "name": "@mcs/cli",
  "version": "3.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "mcs": "dist/main.js"
  },
  "exports": {
    "./package.json": "./package.json"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc -b tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@mcs/engine": "3.0.0",
    "@mcs/shared": "3.0.0"
  },
  "devDependencies": {
    "@mcs/testkit": "3.0.0"
  }
}
````

### A.20 `runtime/packages/cli/tsconfig.build.json`

````json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"],
  "references": [{ "path": "../shared/tsconfig.build.json" }, { "path": "../engine/tsconfig.build.json" }]
}
````

### A.21 `runtime/packages/testkit/package.json`

````json
{
  "name": "@mcs/testkit",
  "version": "3.0.0",
  "private": true,
  "description": "Test-only fixture builders and helpers. Every artefact it writes is a labelled synthetic fixture.",
  "type": "module",
  "exports": {
    ".": {
      "@mcs/source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./legacy": {
      "@mcs/source": "./src/legacy/index.ts",
      "types": "./dist/legacy/index.d.ts",
      "default": "./dist/legacy/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc -b tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@mcs/shared": "3.0.0"
  }
}
````

### A.22 `runtime/packages/testkit/tsconfig.json`

````json
{
  "extends": "../../tsconfig.check.json",
  "include": ["src"]
}
````

### A.23 `runtime/packages/testkit/tsconfig.build.json`

````json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"],
  "references": [{ "path": "../shared/tsconfig.build.json" }]
}
````

### A.24 `runtime/packages/web/package.json`

````json
{
  "name": "@mcs/web",
  "version": "3.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./package.json": "./package.json"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@mcs/shared": "3.0.0",
    "@tanstack/react-query": "5.104.1",
    "lucide-react": "1.55.0",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "react-router": "8.4.0"
  },
  "devDependencies": {
    "@mcs/testkit": "3.0.0",
    "@testing-library/dom": "10.4.2",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.7",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.2",
    "happy-dom": "20.14.6",
    "vite": "8.3.4"
  }
}
````

### A.25 `runtime/packages/web/tsconfig.json`

````json
{
  "extends": "../../tsconfig.check.json",
  "compilerOptions": {
    "lib": ["es2024", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": false,
    "types": ["vite/client", "@testing-library/jest-dom/vitest"]
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
````

### A.26 `runtime/packages/web/vitest.config.ts`

````ts
import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

export default defineConfig((env) =>
  mergeConfig(viteConfig(env), {
    test: {
      name: 'web',
      environment: 'happy-dom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      restoreMocks: true,
      unstubEnvs: true,
      unstubGlobals: true,
      env: { TZ: 'UTC' },
    },
  }),
);
````

### A.27 `runtime/packages/web/vite.config.ts`

````ts
// Stub for the scaffold check. The real file is owned by 04-ui.md section 12.2; it must keep the
// `resolve.conditions` line (workspace sources without a prior build) and must never default to port 8765.
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'MCS_');
  const api = env['MCS_DEV_API'] ?? 'http://127.0.0.1:18765';
  return {
    plugins: [react()],
    base: '/',
    resolve: { conditions: ['@mcs/source', ...defaultClientConditions] },
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, manifest: true, modulePreload: { polyfill: false } },
    server: {
      host: '127.0.0.1',
      port: Number(env['MCS_WEB_DEV_PORT'] ?? '18766'),
      strictPort: true,
      proxy: {
        '/api': {
          target: api,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('proxyReq', (req) => {
              if (req.getHeader('origin') !== undefined) req.setHeader('origin', api);
            });
          },
        },
      },
    },
  };
});
````

### A.28 `runtime/packages/web/e2e/playwright.config.ts`

Replaced by 04 W14 `e2e/playwright.config.ts` (no `webServer`): 04 section 11.4 is authoritative for the file. The scaffold stub that
started `server/dist/main.js --port N` with a port from `MCS_E2E_PORT` is withdrawn (critic N-02): that argv is not the server's (01 4.1),
and the variable is not documented (01 2.10). Conventions this design still requires of 04's file (4.7, 4.12): `testDir: './specs'`,
`workers: 1`, `retries: 0`, `forbidOnly: true`, `channel: 'chrome'`, `timezoneId: 'UTC'`, `locale: 'en-US'`, trace
`retain-on-failure`, output under `e2e/test-results/`; the path `packages/web/e2e/playwright.config.ts` used by `test:e2e` and
`ci.mjs --full` is unchanged.

### A.29 `runtime/packages/web/e2e/tsconfig.json`

````json
{
  "extends": "../../../tsconfig.check.json",
  "include": ["**/*.ts"]
}
````

### A.30 `runtime/tests/tsconfig.json`

````json
{
  "extends": "../tsconfig.check.json",
  "include": ["**/*.ts"]
}
````

### A.31 `runtime/scripts/lib.mjs`

````js
// Shared helpers for repository scripts. Zero dependencies; Node >= 22.22.0 (the one floor, 01 section 5.1).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGES = ['shared', 'engine', 'server', 'cli', 'web', 'testkit'];

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Absolute path of a tool's JS entry, read from its package.json "bin" (never a .cmd shim). */
export function binPath(pkg, bin = pkg) {
  const dir = join(RUNTIME_ROOT, 'node_modules', pkg);
  const manifest = readJson(join(dir, 'package.json'));
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[bin];
  return join(dir, rel);
}

/** Runs `node <script> ...args` with inherited stdio, no shell. Resolves to the exit code. */
export function runNode(script, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd ?? RUNTIME_ROOT,
      stdio: options.stdio ?? 'inherit',
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...options.env },
    });
    child.on('error', () => resolvePromise(127));
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}
````

### A.32 `runtime/scripts/clean.mjs`

````js
// Removes build outputs so a removed source file can never survive as stale JS in dist/.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { PACKAGES, RUNTIME_ROOT } from './lib.mjs';

const targets = [
  ...PACKAGES.map((p) => join(RUNTIME_ROOT, 'packages', p, 'dist')),
  join(RUNTIME_ROOT, 'coverage'),
  join(RUNTIME_ROOT, '.mcs-build.json'),
];
for (const target of targets) {
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(`clean: removed ${targets.length} build output paths`);
````

### A.33 `runtime/scripts/typecheck.mjs`

````js
// Type-checks every project with noEmit against sources (custom condition @mcs/source), no build needed.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { binPath, runNode } from './lib.mjs';

const PROJECTS = [
  'packages/shared',
  'packages/engine',
  'packages/server',
  'packages/cli',
  'packages/testkit',
  'packages/web',
  'tests',
  'packages/web/e2e',
];

const tsc = binPath('typescript', 'tsc');
let failed = 0;
for (const project of PROJECTS) {
  const started = Date.now();
  const code = await runNode(tsc, ['-p', project, '--pretty', 'false']);
  console.log(`typecheck ${project}: ${code === 0 ? 'ok' : `FAILED (exit ${code})`} ${Date.now() - started} ms`);
  if (code !== 0) failed += 1;
}
process.exitCode = failed === 0 ? 0 : 1;
````

### A.34 `runtime/scripts/check-deps.mjs`

````js
// Dependency hygiene gate (ADR-0041): exact pins, one shared version, and every import declared
// in the importing package (hoisting would otherwise hide a missing declaration).
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, sep } from 'node:path';

import { PACKAGES, RUNTIME_ROOT, readJson } from './lib.mjs';

const problems = [];
const root = readJson(join(RUNTIME_ROOT, 'package.json'));
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ALIAS_EXACT = /^npm:[@a-z0-9/._-]+@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const BUILTINS = new Set(builtinModules);
const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

function checkExact(owner, deps) {
  for (const [name, spec] of Object.entries(deps ?? {})) {
    if (!EXACT.test(spec) && !ALIAS_EXACT.test(spec))
      problems.push(`${owner}: ${name}@${spec} is not an exact version`);
  }
}

function packageOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  return BUILTINS.has(name) ? null : name;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full;
  }
}

checkExact('package.json devDependencies', root.devDependencies);
checkExact('package.json dependencies', root.dependencies);
const overrideKeys = Object.keys(root.overrides ?? {});
if (overrideKeys.join(',') !== 'eslint-plugin-jsx-a11y') {
  problems.push(
    `package.json overrides must contain only eslint-plugin-jsx-a11y (ADR-0042), found: ${overrideKeys.join(',')}`,
  );
}

const rootDev = new Set(Object.keys(root.devDependencies ?? {}));
for (const pkg of PACKAGES) {
  const dir = join(RUNTIME_ROOT, 'packages', pkg);
  const manifest = readJson(join(dir, 'package.json'));
  const where = `packages/${pkg}/package.json`;
  if (manifest.version !== root.version) problems.push(`${where}: version ${manifest.version} != root ${root.version}`);
  if (manifest.private !== true) problems.push(`${where}: must be private`);
  checkExact(where, manifest.dependencies);
  checkExact(where, manifest.devDependencies);
  for (const [name, spec] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (name.startsWith('@mcs/') && spec !== root.version)
      problems.push(`${where}: ${name}@${spec} must equal ${root.version}`);
  }
  const prod = new Set(Object.keys(manifest.dependencies ?? {}));
  const dev = new Set(Object.keys(manifest.devDependencies ?? {}));
  for (const file of walk(dir)) {
    const rel = relative(RUNTIME_ROOT, file).split(sep).join('/');
    const isTest =
      /\.test\.tsx?$/.test(rel) ||
      rel.includes('/test/') ||
      rel.includes('/e2e/') ||
      rel.endsWith('test-setup.ts') ||
      rel.endsWith('.config.ts');
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const name = packageOf(specifier);
      if (name === null || name === manifest.name) continue;
      const typeOnly = /^\s*(import|export)\s+type\s/.test(match[0].trim());
      const declared = prod.has(name) || (isTest || typeOnly ? dev.has(name) || rootDev.has(name) : false);
      if (!declared) {
        problems.push(
          `${rel}: imports '${name}' which is not declared in ${isTest ? 'dependencies/devDependencies' : 'dependencies'} of ${where}`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`check-deps: ${p}`);
  console.error(`check-deps: ${problems.length} problem(s)`);
  process.exitCode = 1;
} else {
  console.log('check-deps: ok');
}
````

### A.35 `runtime/scripts/build-stamp.mjs`

````js
// Install and build stamps shared by `npm run build` and the launcher (scripts/mcs.mjs).
// Contract: docs/design/05-tooling-testing-security.md section 2.3. Zero dependencies.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PACKAGES, RUNTIME_ROOT, readJson } from './lib.mjs';

export const STAMP_SCHEMA_VERSION = 1;
export const BUILD_STAMP_FILE = '.mcs-build.json';
export const INSTALL_STAMP_FILE = join('node_modules', '.mcs-install.json');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test', 'test-results']);
const SKIP_FILE = /\.test\.(ts|tsx)$|^test-setup\.ts$/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (!SKIP_FILE.test(entry.name)) {
      yield full;
    }
  }
}

function digest(root, files) {
  const hash = createHash('sha256');
  const rels = files.map((f) => relative(root, f).split(sep).join('/')).sort();
  for (const rel of rels) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Inputs that require `npm ci` when they change. */
export function installInputs(root = RUNTIME_ROOT) {
  return [join(root, 'package-lock.json'), join(root, '.npmrc')];
}

/** Inputs that require a rebuild when they change (production sources only; tests excluded). */
export function buildInputs(root = RUNTIME_ROOT) {
  const files = [
    join(root, 'package.json'),
    join(root, 'package-lock.json'),
    join(root, 'tsconfig.base.json'),
    join(root, 'tsconfig.build.json'),
  ];
  for (const pkg of PACKAGES) {
    if (pkg === 'testkit') continue;
    const dir = join(root, 'packages', pkg);
    files.push(join(dir, 'package.json'));
    for (const name of readdirSync(dir)) {
      if (/^(tsconfig.*\.json|vite\.config\.ts|index\.html)$/.test(name)) files.push(join(dir, name));
    }
    files.push(...walk(join(dir, 'src')));
    if (pkg === 'web') files.push(...walk(join(dir, 'public')));
  }
  return files;
}

export function computeStamps(root = RUNTIME_ROOT) {
  const platform = `${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}`;
  return {
    installStamp: `${platform}:${digest(root, installInputs(root))}`,
    buildStamp: digest(root, buildInputs(root)),
  };
}

function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function readOptional(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

/** Returns which steps are needed: { install: boolean, build: boolean, reasons: string[] }. */
export function staleness(root = RUNTIME_ROOT) {
  const now = computeStamps(root);
  const installed = readOptional(join(root, INSTALL_STAMP_FILE));
  const built = readOptional(join(root, BUILD_STAMP_FILE));
  const reasons = [];
  const install = installed?.installStamp !== now.installStamp;
  if (install) reasons.push(installed === null ? 'no install stamp' : 'lockfile, .npmrc or platform changed');
  const build = install || built?.buildStamp !== now.buildStamp;
  if (build && !install) reasons.push(built === null ? 'no build stamp' : 'sources changed since last build');
  return { install, build, reasons, ...now };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2] ?? 'check';
  const started = performance.now();
  const stamps = computeStamps();
  const root = readJson(join(RUNTIME_ROOT, 'package.json'));
  if (command === 'write') {
    writeAtomic(join(RUNTIME_ROOT, BUILD_STAMP_FILE), {
      schemaVersion: STAMP_SCHEMA_VERSION,
      runtimeVersion: root.version,
      buildStamp: stamps.buildStamp,
      codeStamp: stamps.buildStamp.slice(0, 10),
      node: process.version,
      builtAt: new Date().toISOString(),
    });
    console.log(`build-stamp: wrote ${BUILD_STAMP_FILE} ${stamps.buildStamp.slice(0, 10)}`);
  } else if (command === 'write-install') {
    writeAtomic(join(RUNTIME_ROOT, INSTALL_STAMP_FILE), {
      schemaVersion: STAMP_SCHEMA_VERSION,
      installStamp: stamps.installStamp,
      installedAt: new Date().toISOString(),
    });
    console.log('build-stamp: wrote install stamp');
  } else {
    const state = staleness();
    console.log(JSON.stringify({ ...state, ms: Math.round(performance.now() - started) }));
    process.exitCode = state.install || state.build ? 1 : 0;
  }
}
````

### A.36 `runtime/scripts/ci.mjs`

````js
// Local CI: runs every gate in a fixed order and prints a result table. Zero dependencies.
// Usage: npm run ci [-- --offline] [-- --keep-going]   |   npm run ci:full (adds e2e + parity)
import { binPath, runNode } from './lib.mjs';

const args = new Set(process.argv.slice(2));
const full = args.has('--full');
const offline = args.has('--offline');
const keepGoing = args.has('--keep-going');
const strict = args.has('--strict'); // release-check: a SKIPPED gate fails
// npm_execpath is set when run through npm; otherwise fall back to the npm CLI bundled next to this node binary (lead decision CR-WP-01-2).
function resolveNpmCli() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  const root = dirname(process.execPath);
  const candidates = [
    join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(root, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
const npmCli = resolveNpmCli();
const SKIP_EXIT = 77; // a gate that cannot run yet (smoke before 01 S8/S9); shown as SKIPPED, never as PASS
const SKIPPED = `SKIPPED (exit ${SKIP_EXIT})`;

const steps = [
  ['format:check', binPath('prettier'), ['--check', '.', '--log-level', 'warn']],
  ['lint', binPath('eslint'), ['.', '--max-warnings', '0']],
  ['typecheck', 'scripts/typecheck.mjs', []],
  ['check:deps', 'scripts/check-deps.mjs', []],
  [
    'test',
    binPath('vitest'),
    [
      'run',
      '--project',
      'unit',
      '--project',
      'web',
      '--project',
      'integration',
      '--project',
      'isolation',
      '--project',
      'resilience',
    ],
  ],
  ['build', npmCli, ['run', 'build']],
  ['smoke', 'scripts/smoke.mjs', []],
];
if (!offline) steps.push(['audit', npmCli, ['audit', '--audit-level=low']]);
if (full) {
  steps.push(['test:parity', binPath('vitest'), ['run', '--project', 'parity']]);
  steps.push([
    'test:e2e',
    binPath('@playwright/test', 'playwright'),
    ['test', '-c', 'packages/web/e2e/playwright.config.ts'],
  ]);
}

const results = [];
for (const [name, script, stepArgs] of steps) {
  if (script === undefined) {
    results.push([name, 'SKIPPED (npm CLI not found: run through npm so npm_execpath is set)', 0]);
    continue;
  }
  const started = Date.now();
  console.log(`\n=== ${name}`);
  const code = await runNode(script, stepArgs);
  const result = code === 0 ? 'PASS' : code === SKIP_EXIT ? SKIPPED : `FAIL (exit ${code})`;
  results.push([name, result, Date.now() - started]);
  if (result.startsWith('FAIL') && !keepGoing) break;
}

console.log('\n| gate | result | ms |\n|---|---|---|');
for (const [name, result, ms] of results) console.log(`| ${name} | ${result} | ${ms} |`);
const notRun = steps.slice(results.length).map(([name]) => name);
if (notRun.length > 0) console.log(`not run: ${notRun.join(', ')}`);
const ok = (r) => r === 'PASS' || (r === SKIPPED && !strict);
process.exitCode = results.every(([, r]) => ok(r)) && notRun.length === 0 ? 0 : 1;
````

### A.37 `runtime/scripts/smoke.mjs`

````js
// Post-build smoke (05 section 3.2, critic N-02): the real CLI creates a throw-away instance on a smoke port and starts it; the
// server answers health and refuses a foreign Host; the CLI stops it and the port closes. Exit 77 (SKIPPED) until 01 S8/S9 are built.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RUNTIME_ROOT } from './lib.mjs';

const SKIP_EXIT = 77;
const CLI = join(RUNTIME_ROOT, 'packages/cli/dist/main.js');
const READY = ['packages/server/dist/boot.js', 'packages/engine/dist/ops/lifecycle.js', 'packages/cli/dist/main.js'];

const missing = READY.find((p) => !existsSync(join(RUNTIME_ROOT, p)));
if (missing !== undefined) {
  console.log(`smoke: SKIPPED (01 S8/S9 not built: ${missing})`);
  process.exit(SKIP_EXIT);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function free(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

function closed(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

function health(port, host) {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/v3/health', headers: { host }, timeout: 1000, agent: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', () => resolve(0));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

async function until(probe, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value || Date.now() >= deadline) return value;
    await sleep(100);
  }
}

// `$MCS <args>` without the launcher's bootstrap; output is kept for the failure message only.
function mcs(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env,
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.once('error', (e) => resolve({ code: -1, out: String(e) }));
    child.once('exit', (code) => resolve({ code: code ?? -1, out }));
  });
}

let port = 18800;
while (!(await free(port)) && port < 18849) port += 1;

const root = mkdtempSync(join(tmpdir(), 'mcs-smoke-'));
writeFileSync(join(root, 'FIXTURE.md'), 'Synthetic test data generated by runtime/scripts/smoke.mjs. Not real data.\n');
const repo = join(root, 'repo');
for (const dir of [repo, join(root, 'mcs-home'), join(root, 'claude-home')]) mkdirSync(dir, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MCS_|CLAUDE_)/i.test(k)));
Object.assign(env, {
  MCS_HOME: join(root, 'mcs-home'),
  CLAUDE_CONFIG_DIR: join(root, 'claude-home'),
  MCS_HOOK_DISABLE: '1',
});
const task = ['--task', 'smoke', '--repo', repo];

let ok = false;
let started = false;
let summary = `smoke: port ${port}`;
try {
  const init = await mcs(
    ['init', '--slug', 'smoke', '--name', 'FIXTURE smoke', '--repo', repo, '--port', String(port)],
    env,
  );
  if (init.code !== 0) throw new Error(`init exited ${init.code}: ${init.out.trim()}`);
  const start = await mcs(['start', ...task], env);
  started = true;
  if (start.code !== 0) throw new Error(`start exited ${start.code}: ${start.out.trim()}`);
  const own = await until(async () => ((await health(port, `127.0.0.1:${port}`)) === 200 ? 200 : 0), 10_000);
  const foreign = await health(port, 'evil.example');
  summary += ` health ${own}, foreign host ${foreign}`;
  ok = own === 200 && foreign === 403;
} catch (error) {
  summary += ` error ${error instanceof Error ? error.message : String(error)}`;
} finally {
  if (started) {
    const stop = await mcs(['stop', ...task], env);
    const portClosed = await until(() => closed(port), 5_000);
    summary += `, stop exit ${stop.code}, port closed ${portClosed}`;
    ok = ok && stop.code === 0 && portClosed;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(summary);
process.exitCode = ok ? 0 : 1;
````

### A.38 `runtime/scripts/dev.mjs`

````js
// Development mode: server from TypeScript sources (native type stripping + @mcs/source condition, restarts on
// change) and the Vite dev server with /api proxied to it. Ports are test-range defaults, never 8765/3000.
// Usage: npm run dev [-- --api-port 18765 --web-port 18766 -- <extra server args>]
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { binPath, RUNTIME_ROOT } from './lib.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'api-port': { type: 'string', default: '18765' }, 'web-port': { type: 'string', default: '18766' } },
});
const env = {
  ...process.env,
  MCS_HOOK_DISABLE: '1',
  MCS_DEV_API: `http://127.0.0.1:${values['api-port']}`,
  MCS_WEB_DEV_PORT: values['web-port'],
};
const children = [
  spawn(
    process.execPath,
    [
      '--watch',
      '--conditions=@mcs/source',
      join(RUNTIME_ROOT, 'packages/server/src/main.ts'),
      '--port',
      values['api-port'],
      ...positionals,
    ],
    { stdio: 'inherit', shell: false, windowsHide: true, env },
  ),
  spawn(process.execPath, [binPath('vite')], {
    cwd: join(RUNTIME_ROOT, 'packages/web'),
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    env,
  }),
];
console.log(`dev: api http://127.0.0.1:${values['api-port']}  web http://127.0.0.1:${values['web-port']}`);

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => stopAll(code ?? 1));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
````

### A.39 `runtime/packages/cli/src/io/terminal.ts`

````ts
// C0 controls except TAB and LF, DEL, and C1 controls (covers ESC/CSI/OSC introducers).
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this pattern
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/** Neutralise terminal control sequences in untrusted text before it reaches a TTY. */
export function sanitizeForTerminal(text: string): string {
  return text.replace(UNSAFE_CONTROL, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The only place in the CLI that writes to stdout. */
export function printLine(text: string): void {
  process.stdout.write(`${sanitizeForTerminal(text)}\n`);
}
````

### A.40 `runtime/packages/testkit/src/index.ts`

````ts
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_LABEL = 'mcs-test-fixture';

export interface TempDir {
  readonly path: string;
  remove(): void;
}

export function makeTempDir(purpose: string): TempDir {
  const path = mkdtempSync(join(tmpdir(), `mcs-${purpose}-`));
  return {
    path,
    remove: () => {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

export type PortRange = readonly [min: number, max: number];

/** Real-process Vitest tests (4.5). The block-per-worker rule of 4.4 replaces the spread below in slice S2. */
export const VITEST_PORTS: PortRange = [18000, 18499];

/** Picks a free loopback port inside `range` (default VITEST_PORTS; Playwright passes [18500, 18599]). */
export async function allocatePort(range: PortRange = VITEST_PORTS): Promise<number> {
  const [min, max] = range;
  const span = max - min + 1;
  const start = min + ((process.pid * 7919 + Number(process.env['VITEST_POOL_ID'] ?? 0) * 101) % span);
  for (let i = 0; i < span; i += 1) {
    const port = min + ((start - min + i) % span);
    if (await isFree(port)) {
      return port;
    }
  }
  throw new Error(`no free port in ${String(min)}-${String(max)}`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(false);
    });
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      probe.close(() => {
        resolve(true);
      });
    });
  });
}
````

### A.41 `runtime/ci/github-actions-ci.yml`

````yaml
# INACTIVE DRAFT. Not executed remotely. To activate: git mv runtime/ci/github-actions-ci.yml .github/workflows/ci.yml
# Mirrors `npm run ci` / `npm run ci:full` (docs/design/05-tooling-testing-security.md section 7).
name: ci

on:
  push:
    branches: [main, "feat/**"]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  MCS_HOOK_DISABLE: "1"
  TZ: UTC

jobs:
  gates:
    name: gates (${{ matrix.os }}, node ${{ matrix.node }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest]
        node: ["22.22", "24", "26"]
    defaults:
      run:
        working-directory: runtime
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: ${{ matrix.node }}
          cache: npm
          cache-dependency-path: runtime/package-lock.json
      - run: npm ci
      - run: npm run ci

  e2e-and-parity:
    name: e2e + legacy parity (windows, node 24)
    runs-on: windows-latest
    timeout-minutes: 30
    needs: gates
    defaults:
      run:
        working-directory: runtime
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: "24"
          cache: npm
          cache-dependency-path: runtime/package-lock.json
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
        with:
          python-version: "3.12"
      - run: npm ci
      - name: legacy Python suite stays green
        working-directory: .
        run: python -m unittest discover -s tests
      - name: legacy frontend suite stays green
        working-directory: .
        run: node --test "tests/frontend/*.test.mjs"
      - run: npm run ci:full
      - if: failure()
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: e2e-traces
          path: runtime/e2e/test-results/
          retention-days: 7
````

---

## 11. Requirements covered

- Master brief preamble "Language, Coding Conventions, and Engineering Standards": English-only (S-LOG-5 `check-text`), current
  conventions with evidence (ADRs 0040-0049 evidence lines), strict TypeScript (2.4), automated enforcement (2.6-2.8, 8), reproducible
  commands (3.1), evidence-based decisions (ADRs), definition of done (7.1).
- Section 3: Node + TS strict, Vitest, deterministic commands for install, dev, build, run, unit/integration/E2E tests, type check,
  lint, migrations (`migrate` = `mcs db migrate`), health (`health`), instance init (`init-instance`) (3.1); simple root workspace
  without orchestration (T1).
- Section 4 "Required isolation tests": ISO-1..ISO-9 (4.8) with the implementing 01 T-ISO-01..27 and 02 T-HK-05, release-blocking (7.1).
- Section 5: hook fail-safety tests (4.9 `hook-failsafe`), duplicate/out-of-order tests (4.9), transcript edge cases (4.9).
- Section 9 "Use real runtime data in integration tests; fixtures labelled": 4.4 labelling rules.
- Section 12: every bullet mapped to controls S-NET/S-ING/S-FS/S-OUT/S-PROC/S-LOG/S-SEC/S-DEP and checklist 5.6 (error codes from
  03 section 5.2; log rotation S-LOG-6 for "bounded resource use").
- Section 13 Phase 6 items "compare old and new detection/token aggregates, large files, simultaneous instances, reconnect, restart,
  clean install, upgrade": parity harness 4.11, resilience 4.9, isolation 4.8, release gates 7.1.
- Section 14: unit, integration, E2E 1-14 mapping (4.2), "do not claim tests passed unless they ran; record skipped tests" (7.1, 7.2, 3.2
  `ci.mjs` "not run" list and `SKIPPED (exit 77)` rows, never PASS; `--strict` at release, 8.1).
- Section 15: required docs and AI-readable rules (6.1-6.4), CCAM reference (6.5), decisions folder (ADRs).
- Section 16 non-goals: no orchestration tool, no Docker/Electron/cloud CI dependency (8.2 inactive), no large frameworks.
- Section 17 items 6-7, 12: smallest tests per change and broader at phase boundaries (layers + `ci`), no fabricated results (7.3 rule).
- Section 18: DoD checklist (7.1) and final report format (7.3).
- Foundations: D6 (launcher stamp contract 3.3, bootstrap serialised by the 01 `ProcessMutex`), D7 (pinned stack, Appendix A; floor
  22.22.0 per I-05), C2, C3, C5, C6; open question 6 (4.11.4-4.11.5 together with design 06 section 5.2).
- Uncovered-matrix rows R-7.E.13 (attempts entity), R-8.3.11 (audit references) and R-8.9.9 (completion evidence) are not in this
  design's scope (owned by designs 03/06, 01 and 01/02 through critic issues I-07, I-19 and I-08); this design contributes only their
  test placement rules (4.1) and the traceability row format (7.4).

## 12. Open items

1. UNVERIFIED, verify in slice S1: probe files excluded from a package `tsconfig.json` still get typed linting under `projectService`
   (2.6); fallback stated there.
2. UNVERIFIED, verify at activation: hosted runner Chrome for Playwright `channel: 'chrome'` (8.2).
3. Lead decision needed: sixth package (C-2); `reference/*.md` link edits in Phase 6 (6.4 step 4). (The Node floor, C-1, is settled at
   22.22.0 by critic issue I-05.)
4. Expected values that come from other designs, by name: CLI flags (01: `--settings-file` for installer tests), identity exit code and
   error code (01/03: exit 11, `IDENTITY_MISMATCH`), ingestion thresholds for resilience assertions (02), API error codes (03 section 5.2
   `ErrorCode`, imported, never re-spelled). The test files and cases here do not change when those values do.
5. UNVERIFIED until 01 S9: the smoke's real CLI path (`init --port`, `start`, `stop` exit 0 on an empty `CLAUDE_CONFIG_DIR` and a
   non-git temp repo). Its mechanics and the SKIPPED path are verified (E24); the readiness markers `server/dist/boot.js` and
   `engine/dist/ops/lifecycle.js` follow 01's slice file lists (S8, S9) and move with them.

## 13. Phase 2+ task slices (dependency order; each independently testable)

| Slice | Files owned | Depends on | Done when (tests) |
|---|---|---|---|
| S1 Scaffold + gates | `runtime/{package.json,package-lock.json,.npmrc,.editorconfig,.prettierrc.json,.prettierignore,tsconfig.*.json,eslint.config.js,vitest.config.ts}`, `runtime/packages/*/{package.json,tsconfig*.json}` + one stub file each, `runtime/scripts/{lib,clean,typecheck,check-deps,build-stamp,ci,smoke,dev,set-version}.mjs`, `runtime/tests/tsconfig.json`, `runtime/tests/tooling/{lint-rules,check-deps,build-stamp,ci-script,env-vars}.test.ts` (env-vars allow-list = 01 section 2.10), `.gitignore` additions; `eslint.config.js` includes the platform entries of 06 section 4 (I-34, 2.6); testkit manifest exports `.` and `./legacy` (the `./legacy` target is written by 06 PP3) | nothing | `npm ci --offline` + `npm run ci` pass in a clean copy, smoke `SKIPPED (exit 77)` until 01 S8/S9 and PASS after them, `--strict` fails while it is skipped; `tests/tooling/{lint-rules,check-deps,build-stamp,ci-script}.test.ts` pass (probe tables of E6/E7/E18/E20/E24; `ci-script.test.ts` covers exit 77 and `--strict`) |
| S2 Testkit core | `packages/testkit/src/{temp,ports,wait,clock,processes,isolation,http,canary}.ts` + tests (`clock.ts` holds only `FakeClock`; `Clock`/`systemClock` are 01's `shared/src/time.ts`, I-36) | S1; 01 S1 (`shared/src/time.ts`) | testkit unit tests; port blocks never overlap across 4 workers (test spawns 4 forks); `allocatePort([18500, 18599])` stays in range; `hermeticEnv` contains no parent `MCS_*`/`CLAUDE_*`; `makeJunction` + `lstat` sees a link; `spawnImpostor` command line ends with its argv; `startInstance` is exercised by 01 S9's T-ISO rows |
| S3 Testkit fixtures | `packages/testkit/src/{transcript,claude-home,hooks,workspace,demo}.ts` + tests | S2; 02 `INSTALLED_HOOK_EVENTS`/`ASYNC_HOOK_EVENTS` and stub `scripts/mcs-hook.mjs` (02 I-2); 01 `InstanceFileSchema`; 04 11.5 `DemoOptions`/`DemoResult` verbatim (`nowMs`, no `runtimeJson`) | builders reproduce the 25 fixture shapes of transcript-survey section 8; `buildClaudeHome` equals the `make.py build_home` structure (file list compare); `HookEventName` has 21 members (type test); `runHookHandler` default and `direct` both write one spool line for a routed payload; `buildTaskWorkspace({instance: {}})` output parses with `InstanceFileSchema` |
| S4 Launcher stamp integration | (design 01 owns `scripts/mcs.mjs` and both copies of the mutex); this slice only ships `build-stamp.mjs` API tests from the launcher's perspective | S1, design 01 S4 (`mutex.ts`) | launcher test: missing `node_modules` -> install + build once; two concurrent launchers -> one bootstrap (`ProcessMutex`); a bootstrap killed with `taskkill /F` mid-build leaves no lock behind and the next launcher proceeds at once |
| S5 CI workflow | `runtime/ci/github-actions-ci.yml` | S1 | YAML parses, Prettier clean, `ci.mjs` gate names match |
| S6 Security primitives | `engine/src/security/paths.ts` (re-exports `SID_RE`, `AGENT_RE`, `RUN_ID_RE` from `@mcs/shared/protocol`, I-26), `engine/src/log/logger.ts` (incl. S-LOG-6 rotation), `cli/src/io/terminal.ts`, `server/src/http/guards.ts` + `guards.test.ts` (unless claimed by another design, 1.1) + unit tests 5.7. Not `platform/exec.ts`/`process.ts` (06 PP1) | S1; 03 `shared/src/api/errors.ts` (`ErrorCode`); 02 I-1 (`shared/src/protocol/hook-envelope.ts` regexes) | 5.7 tests and SEC-05/SEC-31 unit rows; lint probes still pass |
| S7 Security suite | `runtime/tests/security/*` | S6, 06 PP1 (`exec.ts`), server + CLI MVP | SEC-01..SEC-25 tests pass; every expected code typed `ErrorCode` |
| S8 Parity harness (Node side) | `runtime/tests/parity/{projections,normalize,run-python}.ts` (`LegacyState` imported from `@mcs/shared`, 03 S3), the parity project's `globalSetup` (live mode), `runtime/scripts/parity-capture.mjs`, `runtime/tests/tooling/parity-capture.test.ts`, `parity:capture`/`parity:check` scripts. Not `tests/legacy-parity/**` (06 PP2) and not the `*.parity.test.ts` files (06 PP4/PP8) | S3, 06 PP2 (`capture_golden.py`) | `parity-capture.test.ts`: argument validation, port-base range, missing Python -> exit 2 (PATH emptied), `--check` passes the tool's exit code; `npm run parity:check` prints `golden check: N files identical` on this machine; `normalizeValue` unit cases for every placeholder of 06 5.2.3; live mode runs 06 PP4's `legacy-trees.parity.test.ts` green against a fresh capture |
| S9 Isolation setup + resilience suite, stress, release check, text gate | `runtime/tests/isolation/_setup.ts` only (critic N-07: every `runtime/tests/isolation/*.test.ts` belongs to the 01 slice implementing its T-ISO rows, `hook-routing-isolation.test.ts` to 02, 4.8), `runtime/tests/resilience/*`, `runtime/scripts/{stress,release-check,check-text}.mjs`, `check-text.allow` | `_setup.ts`: S2, S3 only, so it lands before the first 01 slice that adds an isolation file; the rest: S6, 01 S9 (CLI lifecycle), ingestion | `_setup.ts` self-test: `twoInstances()` starts two instances on distinct ports and its teardown leaves both ports closed; resilience files pass 3 shuffled seeds; the isolation files present at that time pass `test:stress`; `release-check` runs `ci --strict` and writes a report with no fabricated rows |
| S10 Docs assembly | `docs/*.md` final set, `docs/legacy/` move (lead runs `git mv`), `docs/traceability.md`, `runtime/scripts/check-docs.mjs` | all designs implemented | `check-docs` and `check-text` pass; 11-question table satisfied |
