# 0040 npm workspaces with a `@mcs/source` export condition; tsc builds, sources everywhere else

Status: Proposed (Phase 1, 2026-10-11). Owner: tooling design (`docs/design/05-tooling-testing-security.md` sections 2.1-2.4).

## Context
D1 fixes a `runtime/` workspace with packages shared, engine, server, cli, web. Type-checking, tests, dev mode and the Vite build all need
cross-package imports. Building `dist/` before every check slows the loop and creates "stale dist" bugs; path aliases (`paths`) diverge
from what Node resolves at runtime. Tests in four packages, the cross-package suites and Playwright also need one fixture library.

## Decision
- npm workspaces (explicit list of six packages), one `package-lock.json`, no orchestration tool.
- Sixth package `@mcs/testkit`: private, dev-only, never imported by production code (lint + `check-deps`).
- Every package `exports` entry has three conditions in this order: `"@mcs/source": "./src/x.ts"`, `"types": "./dist/x.d.ts"`,
  `"default": "./dist/x.js"`.
- `tsconfig.check.json` sets `customConditions: ["@mcs/source"]` + `noEmit`; Vitest sets `ssr.resolve.conditions`; Vite sets
  `resolve.conditions: ['@mcs/source', ...defaultClientConditions]`; dev mode runs `node --conditions=@mcs/source src/main.ts`.
- Shipping build: `tsc -b tsconfig.build.json` (composite per-package configs, no custom condition) after a full `clean`, then
  `vite build`; Node at runtime resolves `default` -> `dist/*.js`.
- TypeScript 6.0.3 with the strict flag set of design 05 section 2.4 (`erasableSyntaxOnly` keeps sources runnable by type stripping).

## Consequences
- `typecheck`, `test`, `dev` work on a fresh clone after `npm ci` with no build; only shipping and Playwright need `dist/`.
- All internal versions are equal to `RUNTIME_VERSION`; bumping needs the set-version script.
- Contributors must never import `@mcs/x/src/...` (lint-enforced deep-import ban).

## Alternatives rejected
- `paths` aliases: tsc does not rewrite them in emitted JS; runtime and type resolution would differ.
- Build-before-check (`tsc -b` for typecheck): emitted tests into `dist` in the Phase 0 smoke and needs ordering.
- turbo/nx/lerna: brief section 3 "avoid build orchestration tooling unless justified"; six packages build in about 2 s.
- No testkit package (duplicated builders or relative imports across packages): drift or broken project boundaries.

## Evidence
- 2026-10-11, TypeScript 6.0.3, Vitest 5.0.3, Vite 8.3.4, Node 24.14.1/22.23.3/26.11.1, `D:/mvp/private/scratch/mcs-v3/scaffold-check`:
  `tsc -p packages/server --listFilesOnly` lists `packages/shared/src/*.ts` with no `dist`; Vitest without `ssr.resolve.conditions`
  fails `Failed to resolve entry for package "@mcs/testkit"`; `node --conditions=@mcs/source packages/server/src/main.ts` served
  health 200 with no warning; full `npm run ci` passed in a clean copy (design 05 section 9, E4, E5, E9, E14-E16).
- TypeScript `customConditions` requires `moduleResolution` node16/nodenext/bundler (all used here).
