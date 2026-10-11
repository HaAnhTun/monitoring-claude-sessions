# Stack versions for the Node.js + TypeScript + React platform

Reviewed: 2026-10-11. Machine: Windows 11, Node v24.14.1, npm 11.11.0, no C/C++ compiler or Visual Studio on PATH (checked: no `cl.exe`, `g++`, `gcc`).
Scope: toolchain verification only. The legacy engine was not touched.

Evidence conventions: `[npm]` = `npm view <pkg> ...` run 2026-10-11; `[smoke]` = ran in `D:/mvp/private/scratch/mcs-v3/stack-smoke`; `[url]` = page fetched 2026-10-11; `[judgment]` = my reasoning, not a measured fact. Anything not verified is marked UNVERIFIED.

## 0. Headline findings (read these first)

1. TypeScript 7.0.2 (native Go port) is `latest` on npm, but it ships **no programmatic API** until 7.1, and typescript-eslint 8.71.1 declares `typescript >=4.8.4 <6.1.0`. So the practical pin today is **TypeScript 6.0.3** as `typescript`, with TS 7 optionally run as a second, faster type checker. [npm][url: devblogs.microsoft.com/typescript/announcing-typescript-7-0/]
2. Almost every tool is now very new: Vite 8 (Rolldown), Vitest 5, ESLint 10, React Router 8, jest-dom 7, better-sqlite3 13, lucide-react 1.x, Express 5.3. Peer ranges matter more than usual.
3. **One real peer conflict**: `eslint-plugin-jsx-a11y@6.10.2` (latest, last published 2024-10-26) declares `eslint ^3 ... ^9` and ESLint is 10.12.0. It needs an npm `overrides` entry. After the override it loaded and enforced rules under ESLint 10 [smoke].
4. **`npm ci` / `npm install` from an existing lockfile runs `node-gyp rebuild` for better-sqlite3 and fails without Visual Studio**, even though the package declares `"gypfile": false` and ships prebuilds [smoke, npm 11.11.0]. A fresh `npm install` without a lockfile does not. Fix: project `.npmrc` with `ignore-scripts=true` (also a Node security recommendation). Verified clean `npm ci` + full pipeline with it.
5. `jsdom@30.1.2` requires Node `^22.22.2 || ^24.15.0 || >=26` and prints EBADENGINE on this machine's 24.14.1 [smoke]. Use **happy-dom** (works, tested) for component tests.
6. npm 12.2.0 is the current npm and itself refuses Node 24.14.1 (`supports ^22.22.2 || ^24.15.0 || >=26`, warning observed) [smoke: `npx npm@latest ci`]. Keep scripts compatible with npm 11 and 12.
7. `node:sqlite` is only Stability 1.1 on Node 22.x and on this machine's 24.14.1 and prints an ExperimentalWarning there. It is 1.2 (release candidate) from 24.15.0 and 25.7.0. better-sqlite3 is the safer pin.

## 1. Node.js release lines (question 1)

Source: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json fetched 2026-10-11 (start / LTS / maintenance / end):

| Line | Start | LTS from | Maintenance from | End of life | Status on 2026-10-11 |
|---|---|---|---|---|---|
| v20 | 2023-04-18 | 2023-10-24 | 2024-10-22 | 2026-04-30 | EOL |
| v22 "Jod" | 2024-04-24 | 2024-10-29 | 2025-10-21 | 2027-04-30 | Maintenance LTS |
| v24 "Krypton" | 2025-05-06 | 2025-10-28 | **2026-10-20** | 2028-04-30 | Active LTS (becomes Maintenance in 9 days) |
| v25 | 2025-10-15 | none | 2026-04-01 | 2026-06-01 | EOL |
| v26 | 2026-05-05 | **2026-10-28** | 2027-10-20 | 2029-04-30 | Current (becomes the newest LTS in 17 days) |
| v27 | 2027-04-22 | none | 2027-10-20 | 2030-04-30 | future |

Constraints from the pinned tools (all `[npm]` engines fields): vite 8.3.4 `^20.19.0 || >=22.12.0`; vitest 5.0.3 `^22.12.0 || ^24.0.0 || >=26.0.0`; eslint 10.12.0 `^20.19.0 || ^22.13.0 || >=24`; react-router 8.4.0 `>=22.22.0`; better-sqlite3 13.0.3 `>=22`; express 5.3.0 `>=18`; @testing-library/jest-dom 7.0.1 `>=22`; jsdom 30.1.2 `^22.22.2 || ^24.15.0 || >=26` (avoided).

Recommendation (engines):
- Root workspace (dev tooling): `"engines": { "node": "^22.22.0 || ^24.0.0 || >=26.0.0" }`. Drops EOL 20/25, includes this machine (24.14.1), Active LTS 24 and the soon-LTS 26. Used in the smoke repo, no EBADENGINE warnings on 24.14.1.
- Runtime package that users run (server + built UI): `">=22.12.0"` is enough (better-sqlite3 floor is 22). Note 22 reaches EOL 2027-04-30, so document 24 as the supported default. [judgment]
- Whole smoke pipeline (vitest, eslint, tsc, vite build) passed on Node 22.23.3, 24.14.1 and 26.11.1 (obtained with `npm i node@22 / node@26` into scratch dirs) [smoke].

## 2. SQLite driver (question 2)

### 2.1 Facts

| | `node:sqlite` | `better-sqlite3` 13.0.3 |
|---|---|---|
| Stability | Node 22.23.x docs and 24.14.1 docs: **1.1 Active development**. Node 24.15.0+ and Node 26 docs: **1.2 Release candidate** (RC since v25.7.0 / v24.15.0). [url: nodejs.org/docs/v24.14.1/api/sqlite.html, latest-v22.x, latest-v26.x, latest-v24.x] | Third-party, stable API. Releases: 12.5.0 2025-11-29, 12.8.0 2026-03-14, 12.10.0 2026-05-12, 13.0.0 2026-07-21, 13.0.3 2026-08-05 (actively maintained) [npm time] |
| Warning | `ExperimentalWarning: SQLite is an experimental feature` printed on **22.23.3 and 24.14.1**, **not** printed on 26.11.1 [smoke] | none |
| Flag | none needed since v22.13.0 / v23.4.0 | none |
| Install | built in | `npm install better-sqlite3@13.0.3`: 1.5 s with empty cache dir, 27 MB package of which 17 MB is `prebuilds/` (win32-x64, win32-arm64, darwin x64/arm64, linux x64/arm64, linuxmusl x64/arm64). No compiler needed: `gypfile: false`, no install script. Loaded OK on Node 22.23.3, 24.14.1 and 26.11.1 [smoke] |
| Bundled SQLite | 3.51.2 (Node 24.14.1), 3.51.3 (22.23.3), 3.53.4 (26.11.1); FTS5 and JSON functions available in all three [smoke] | 3.53.4; FTS5 available [smoke] |
| Pragmas | via `exec`/`prepare('PRAGMA ...')` | `db.pragma()` helper |
| Transactions | manual `BEGIN`/`COMMIT`/`ROLLBACK` via `exec`; `db.isTransaction` exists. No wrapper helper | `db.transaction(fn)` wrapper, auto rollback on throw (tested) |
| Prepared statements | `prepare()` + `run/get/all/iterate`, `createTagStore()` LRU cache (added v24.9.0) | `prepare()` + `run/get/all/iterate`, `pluck()`, `.raw()` |
| Busy timeout | constructor option `timeout` | constructor option `timeout` |
| Other | backup (async), sessions/changesets, custom functions, authorizer; `defensive` default true since v24.14.0 | backup, custom functions, aggregates, user-defined table functions |
| Error codes | generic `ERR_SQLITE_ERROR` plus `errcode`/`errstr` | named codes such as `SQLITE_BUSY`, `SQLITE_CONSTRAINT_FOREIGNKEY` |
| Types | built into `@types/node` | `@types/better-sqlite3@9.6.0` (DefinitelyTyped, last modified 2026-10-04). Compiled cleanly against 13.0.3 for the subset I used; full coverage UNVERIFIED |
| Cost | none | native binary per OS/arch; a platform not in the prebuild list needs a compiler (UNVERIFIED for other platforms) |

### 2.2 Smoke results (`D:/mvp/private/scratch/mcs-v3/bs3`, scripts `t-native.mjs`, `t-bs3.mjs`)

Per run: open with `timeout: 5000`, `PRAGMA journal_mode = WAL`, `foreign_keys = ON`, create parent/child tables, insert a child with a missing parent (expect FK error), 1000-row transaction, rolled-back transaction, count rows. Three OS processes started simultaneously on the same new file.

- WAL: `journal_mode` returned `wal` in both libraries on Node 22.23.3, 24.14.1, 26.11.1. Rows after three writers: 1000, 2000, 3000 (all committed, none lost). FK error raised in both (`ERR_SQLITE_ERROR` vs `SQLITE_CONSTRAINT_FOREIGNKEY`). Rollback verified in both.
- **Cold-start race**: when 3-4 processes create the DB and switch to WAL at the same instant, the first `PRAGMA journal_mode = WAL` can throw `database is locked` (SQLITE_BUSY) despite `timeout: 5000`. Seen once with better-sqlite3 on Node 24 (1 of 3 processes) and once with `node:sqlite` on Node 26; with better-sqlite3 on Node 26 4 of 8 four-process runs had a failure, on Node 24 0 of 8. Non-deterministic, so it is a property of SQLite's WAL switch, not of one driver. Mitigation implemented and tested in `packages/server/src/db.ts`: retry the pragma on `SQLITE_BUSY` (20 x 25 ms). Better: one process owns schema/WAL initialisation.
- Once the DB is already in WAL mode, 6 concurrent writer processes each committed a 1000-row transaction with zero failures for both libraries (`w.sqlite`, `w2.sqlite`).
- A second `-wal` file did not remain after all connections closed (checkpoint on last close).

### 2.3 Recommendation

Use **better-sqlite3 13.0.3** behind a small repository module (one file owns the driver). Reasons: a stable, warning-free API on every supported Node line, `transaction()` and `pragma()` helpers remove boilerplate, named error codes, no compiler needed on Windows x64, same results on Node 22/24/26.
Fallback: `node:sqlite` once the supported floor is Node >= 24.15 (RC, no warning on 26). Because the repository module hides the driver, switching is a one-file change; both passed the same WAL/FK/transaction/concurrency probes. Always: `.npmrc ignore-scripts=true` (see section 6) so lockfile installs do not try to compile.
Rejected: `sqlite3` (async wrapper) and `sql.js` (WASM, no WAL on disk) were not evaluated. [judgment]

## 3. TypeScript (question 3)

Facts:
- npm `latest` = 7.0.2, `rc` = 7.0.1-rc, `next` = 7.1.0-dev.20261010.1; last 6.x = 6.0.3. [npm dist-tags]
- 7.0 released 2026-07-08; CLI is still `tsc`; native Go compiler, 8x-12x faster full builds claimed by Microsoft. [url: devblogs.microsoft.com/typescript/announcing-typescript-7-0/]
- Breaking changes listed there: `target: es5` removed; `moduleResolution: node/node10` and `classic` removed; `baseUrl` removed; `module: amd|umd|systemjs|none` removed; `esModuleInterop`/`allowSyntheticDefaultImports` cannot be false. New defaults: `strict: true`, `module: esnext`, `types: []`, `rootDir: ./`.
- "TypeScript 7.0 does not ship with an API"; the programmatic API is planned for 7.1 (the package exposes only `unstable/*` subpaths today [npm exports]). Compatibility package `@typescript/typescript6` (6.0.2) provides a `tsc6` bin and depends on `typescript@^6`.
- typescript-eslint 8.71.1 (latest) peer `typescript >=4.8.4 <6.1.0`; `@typescript-eslint/typescript-estree` the same. [npm]

Smoke [smoke]: `typescript@6.0.3` as `typescript`, plus `"typescript-native": "npm:typescript@7.0.2"` for TS 7 (run as `node node_modules/typescript-native/bin/tsc`). Both compiled the same project; both reported the same four diagnostics on a negative probe (`noUncheckedIndexedAccess`, two `erasableSyntaxOnly`, `exactOptionalPropertyTypes`). Indicative timing (not controlled): TS 6 `tsc -b` 1.36 s, TS 7 `tsc -b --force` 0.31 s on this tiny repo. Aliasing `typescript` to `@typescript/typescript6` was tried first and worked, but its hoisted `@typescript/old` stole the `tsc` bin from the TS 7 alias, so I dropped that layout.

Recommendation:
- Pin `typescript` **6.0.3** (exact). Revisit when typescript-eslint publishes a version whose peer range includes 7.x (UNVERIFIED roadmap). Optional `typescript-native` alias is not required; skip it unless build time becomes a problem (it will not for this repo size). [judgment]
- Base: `@tsconfig/node24@24.0.5` (contents: lib es2024+ESNext iterator/promise/etc., `module: nodenext`, `target: es2024`, `strict`, `esModuleInterop`, `skipLibCheck`, `moduleResolution: node16`) [smoke: file read]. There is also `@tsconfig/node22@22.0.6` [npm].
- Flags used in `tsconfig.base.json` and verified to compile and to catch errors on TS 6.0.3 and 7.0.2: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules`, `forceConsistentCasingInFileNames`, `rewriteRelativeImportExtensions`, `composite`, `declaration`, `sourceMap`.
- Server project: `module`/`moduleResolution` from the base (`nodenext`/`node16`), source imports written with `.ts` extensions, rewritten to `.js` on emit by `rewriteRelativeImportExtensions` (verified in `dist/app.js` on both compilers). Web project: `module: esnext`, `moduleResolution: bundler`, `jsx: react-jsx`, `allowImportingTsExtensions` (needs `emitDeclarationOnly`/noEmit), `types: ["vite/client", "@testing-library/jest-dom/vitest"]`.
- Keep explicit `types` arrays: TS 7 defaults to `types: []`.

### Native type stripping (can we skip the build?)

- Node 24 `typescript` docs: **Stability 2 (Stable)** as of v24.12.0, enabled by default since v23.6.0, no experimental warning. Limits: erasable syntax only (no `enum`, runtime `namespace`, parameter properties), `tsconfig.json` ignored, imports need real extensions (`./x.ts`), **`.tsx` unsupported**, `.ts` inside `node_modules` refused. [url: nodejs.org/docs/latest-v24.x/api/typescript.html]
- Observed: a `.ts` file with interfaces ran silently on 22.23.3, 24.14.1 and 26.11.1; an `enum` file failed with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` on all three [smoke: `D:/mvp/private/scratch/mcs-v3/ts-strip`].
- Recommendation: **compile with tsc for anything shipped** (the skill is installed as a folder; compiled JS runs on any supported Node, produces declaration/source maps, and the React part needs Vite anyway). Use native stripping only for dev convenience (`node --watch src/main.ts`) and one-off scripts; `erasableSyntaxOnly` keeps both paths valid. Do not use `tsx` / `ts-node`. [judgment]
- Separate `typecheck` (no emit) from `build`: my first layout ran `tsc -b` for both and emitted `app.test.js` into `dist/`. Use `--noEmit` for typecheck or exclude tests via `tsconfig.build.json` and clean `dist` first.

## 4. Server libraries (question 4)

| Library | Version | Notes |
|---|---|---|
| Express | 5.3.0 (`latest`; `latest-4` = 4.22.3) [npm] | The Express support page lists v5 (min Node 18, support start September 2024, end "ongoing") and v4 (end "ongoing") and states "Only the latest version of any given major release line is supported." [url: expressjs.com/en/support/, re-fetched 2026-10-11]. Production security page targets 5.x. `@types/express@5.0.6` compiled cleanly. |
| Zod | 4.6.5 [npm] | `z.strictObject({...})`, `z.enum`, `safeParse`, `z.infer` worked as in the smoke test (`schema.ts`); issue paths returned as field names only, not values (privacy). No other Zod 4 migration notes were reviewed (UNVERIFIED). |
| pino | 10.4.0, 11 direct deps, 706 KB unpacked [npm] | Worked with `redact`; `pino-pretty` 13.2.0 exists (dev only). |
| ws | 8.22.0, 0 deps, 151 KB; optional peers `bufferutil`, `utf-8-validate` [npm] | Only needed for bidirectional sockets. |
| helmet | 0 deps, 105 KB [npm] | Recommended by Express security page. Not smoke-tested. |

Official Express production-security checklist (reviewed 2026-10-11, https://expressjs.com/en/advanced/best-practice-security.html): keep Express current; TLS; do not trust user input and validate redirects; use Helmet; `app.disable('x-powered-by')` and custom 404/error output; secure cookies; brute-force limiting; `npm audit`; parameterised SQL; `safe-regex` for ReDoS.

**Logger decision**: use a ~30-line in-house JSON-lines logger with an explicit field allow-list and no prompt/response text, rather than pino. Reason: the project's privacy rule is "never log content"; a closed field set is easier to audit than redaction paths, and it removes 11+ packages. Fallback: pino 10.4.0 (proven compatible in the smoke repo: `redact`, level from env). [judgment]

**SSE vs WebSocket**: use **Server-Sent Events** for one-way notifications. Reasons: it is plain HTTP so Express middleware (Host/Origin guard, headers) applies unchanged; the browser `EventSource` reconnects automatically and sends `Last-Event-ID` (MDN: the `id` field sets the last event ID; `retry:` sets reconnect delay in ms; comment lines starting with `:` are keep-alives) [url: developer.mozilla.org/.../Using_server-sent_events]. Limits from the same page: **6 connections per browser+domain on HTTP/1.1, shared across tabs** (Chrome/Firefox "won't fix"), so open one stream per tab and multiplex event kinds. `EventSource` cannot set custom headers (the page documents only `withCredentials`), so authenticate by same-origin policy and Host/Origin checks, not by bearer header. Verified in the smoke test: `/stream` returned `text/event-stream`, and with `Last-Event-ID: 1` it replayed only ids 2 and 3. Fallback: `ws` 8.22.0 only if the UI must send high-frequency commands upstream (not expected: UI is read-only).

## 5. Client libraries (question 5)

| Package | Version | Engine / peers | Notes |
|---|---|---|---|
| react, react-dom | 19.3.0 | react-dom peer `react ^19.3.0` | `@types/react`/`@types/react-dom` 19.3.0 |
| vite | 8.3.4 | Node `^20.19.0 \|\| >=22.12.0` [npm; docs page says "20.19+, 22.12+"] | Bundler is Rolldown 1.2.13 (no esbuild installed in the tree) [smoke; url: vite.dev/guide]. Build of the hello page: 1983 modules transformed, 261 kB JS (83 kB gzip), 0.3-1.5 s. |
| @vitejs/plugin-react | 6.1.2 | peer `vite ^8.0.0`; optional peers `babel-plugin-react-compiler`, `@rolldown/plugin-babel`, `oxc-transform-react` | works, no Babel needed |
| react-router | 8.4.0 | Node `>=22.22.0`; peers react/react-dom `>=19.2.7` | single package: `react-router-dom` is no longer used (docs import `BrowserRouter` from `react-router`); `react-router-dom` still exists at 7.18.4 on npm and is not needed [npm] |
| @tanstack/react-query | 5.104.1 | peer react 18 or 19, 1 dependency | tested (below) |
| lucide-react | 1.55.0 | peer react 16.5 to 19 | named imports tree-shake |
| @testing-library/react | 16.3.3 | peers `@testing-library/dom ^10`, `@types/react*` | `@testing-library/dom@10.4.2` is a peer; I declared it explicitly so the version is pinned |
| @testing-library/jest-dom | 7.0.1 | Node `>=22`, peer `vitest >=0.32`, `@testing-library/dom >=10 <11` | import `@testing-library/jest-dom/vitest` |
| @testing-library/user-event | 14.6.7 | peer dom `>=7.21.4` | |
| happy-dom | 20.14.6 | Node `>=20` | used as Vitest `environment`; 9 tests passed |
| jsdom | 30.1.2 | Node `^22.22.2 \|\| ^24.15.0 \|\| >=26` | **not usable without EBADENGINE on 24.14.1**; avoid |
| react-markdown / rehype-sanitize | 10.1.0 / 6.0.0 | react >=18 | see section 7 |

React Router mode (https://reactrouter.com/start/modes, 2026-10-11): three modes: declarative, data, framework. The page says framework or data mode suit SPAs, but declarative mode "can work for SPAs with existing data layers that handle their own pending states". Recommendation: **declarative mode** (`BrowserRouter`, `Routes`, `Route`, `Link`) combined with TanStack Query for data. Verified: renders and navigates under `MemoryRouter` in Vitest + happy-dom, and builds with Vite. Use `HashRouter`/`createHashRouter`-style URLs only if the static host cannot rewrite unknown paths; the Express server can serve `index.html` for non-API paths. [judgment]

**TanStack Query**: justified. Smoke test (`packages/web/src/query.test.tsx`): `useInfiniteQuery` with `getNextPageParam` cursor pagination loaded a page, and `client.invalidateQueries({queryKey: ['events']})` (the call an SSE handler would make) triggered exactly one refetch (2 calls total). The alternative is a hand-written hook layer; that must reimplement request de-duplication, abort on unmount, stale-while-revalidate, infinite pages and invalidation across several views. Cost: 1.7 MB unpacked, 1 dependency (`@tanstack/query-core`). Recommend adopt; keep every call behind `useXxx` hooks so it is replaceable. [judgment]

**CSS**: plain CSS with custom properties, reusing the existing tokens (smoke `styles.css` uses `:root { --bg; --fg; --accent; color-scheme }`). Do not add Tailwind or CSS-in-JS. Vite handles CSS imports natively [smoke build output: `index-*.css`]. [judgment]

## 6. Quality tools (question 6)

| Tool | Version | Notes |
|---|---|---|
| vitest | 5.0.3 | Node `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`. `projects` config works: root `vitest.config.ts` with `test.projects: ['packages/*']`, each package has its own config (`name`, `environment`). Migration page (https://vitest.dev/guide/migration, 2026-10-11): Node >= 22.12, Vite >= 6.4, inline projects inherit root config, `clearMocks` default true, async `resolves/rejects` must be awaited, `vi.mock` hoisting top-level only. |
| @vitest/coverage-v8 | 5.0.3 | works: `vitest run --coverage` printed a table (all files 87.5% stmts on the toy repo). Provider `v8` configured in root config. |
| eslint | 10.12.0 | `maintenance` tag = 9.39.5. Flat config only (eslintrc removed). Node `^20.19 \|\| ^22.13 \|\| >=24`. |
| @eslint/js | 10.0.1 | |
| typescript-eslint | 8.71.1 | peers `eslint ^8.57 \|\| ^9 \|\| ^10`, `typescript >=4.8.4 <6.1.0`. Used `strictTypeChecked` + `stylisticTypeChecked` with `projectService`; it found 6 genuine style errors in my first code which I fixed. First lint 24 s (cold type info), then about 6 s. |
| eslint-plugin-react-hooks | 7.1.1 | peer eslint up to 10; `configs.recommended.rules` caught a conditional hook call [smoke]. |
| eslint-plugin-jsx-a11y | 6.10.2 | **peer eslint <= 9**. Override used: `"overrides": {"eslint-plugin-jsx-a11y": {"eslint": "$eslint"}}`. Caught missing `alt`, click-without-key handler, non-interactive handler [smoke]. |
| prettier | 3.9.10 | `.prettierrc.json` (singleQuote, printWidth 120, trailingComma all); `prettier --check .` clean. |
| @playwright/test | 1.64.0 | Node `>=20`. Installing with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` added 3 packages / 19 MB. **`use: { channel: 'chrome' }` drove the installed Google Chrome** (`C:/Program Files/Google/Chrome/Application/chrome.exe`, UA `HeadlessChrome/155.0.0.0`): 1 test passed in 1.0 s with no browser download [smoke: `D:/mvp/private/scratch/mcs-v3/pw-smoke`]. |

Custom lint rule added and proven: `no-restricted-syntax` with selector `JSXAttribute[name.name='dangerouslySetInnerHTML']` (the react-hooks and jsx-a11y presets do not flag it; negative probe produced the error).

**npm audit**: `npm audit` and `npm audit --omit=dev` both "found 0 vulnerabilities" for the final tree (about 475 unique package versions; 473 counted before TanStack Query was added) [smoke, 2026-10-11]. `npm outdated` showed only `@types/node` (24.19.2 vs 26.6.5, intentional: match the Node 24 line) and `typescript` (6.0.3 vs 7.0.2, intentional). No package in the lockfile has a `deprecated` field (0 found).

**Workspaces + lockfile + `npm ci`**: root `workspaces: ["packages/*"]`, one `package-lock.json` (lockfileVersion 3, 450 packages). Clean copy (no `node_modules`) of the repo: `npm ci` 9.7 s with the `.npmrc` below, lockfile byte-identical afterwards, then `npm run ci` (typecheck, lint, prettier check, tests, build) passed in 52 s, with no warnings. Without `ignore-scripts=true`, `npm ci` failed on the implicit `node-gyp rebuild` (finding 4). A web search turned up a reported npm fix for "respect gypfile:false" but I did not confirm which npm version contains it (UNVERIFIED); npm 12.2.0 did not attempt the build in my one run (it printed `install-scripts better-sqlite3@13.0.3 (install: node-gyp rebuild)` as a warning).

`.npmrc` to commit:
```
ignore-scripts=true
save-exact=true
```
Node's security guide also recommends `--ignore-scripts`, exact pins, lockfiles and `npm ci`, and a dependency cooldown `--min-release-age=1` (npm >= 11.10.0) [url: nodejs.org/en/learn/getting-started/security-best-practices]. `npm config get min-release-age` returned `null` here (not set).

Overrides: exactly one needed (jsx-a11y, above). No other peer errors were reported by npm 11.11.0 in `npm install`/`npm ci`.

## 7. Security guidance to enforce (question 7)

From the Node.js security best-practices page (2026-10-11):
- HTTP DoS: set `headersTimeout`, `requestTimeout`, `timeout`, `keepAliveTimeout`; cap sockets; add error handlers.
- DNS rebinding: the page ties it to `--inspect` (do not enable the inspector protocol in production).
- Do not enable `insecureHTTPParser`.
- Use `crypto.timingSafeEqual()` to compare secrets.
- Supply chain: `--ignore-scripts`, exact versions, lockfile, `npm ci`, `npm audit`, typosquat check, `--min-release-age`.
- Prototype pollution: validate untrusted JSON with a schema (Zod covers this), avoid recursive merges, use `Object.hasOwn`.
- Permission model `--permission` exists for restricting fs/network/child-process. Not tried (UNVERIFIED for this project).

From Express production-security page: Helmet, `x-powered-by` off, input validation, parameterised queries (listed above).

**Loopback servers: DNS rebinding and cross-site requests.** The Node page does not give a recipe for app-level rebinding defense, so this is my design, verified by tests [judgment + smoke]:
1. Bind to `127.0.0.1` only (`app.listen(port, '127.0.0.1')`).
2. Middleware `hostGuard(allowedSet)`: reject any request whose `Host` header is not in the exact allow-list (`127.0.0.1:<port>`, `localhost:<port>`), and any request with an `Origin` header whose host is not in the list. In the smoke tests a request with `Host: evil.example` (sent with `node:http` because `fetch` forbids overriding Host) and one with `Origin: http://evil.example` both got 403.
3. `express.json({ limit: '16kb' })`, Zod `strictObject` on every body, no stack traces in responses.
4. For a mutating API also require a custom header or `Content-Type: application/json` (browsers cannot send this cross-origin without preflight). [judgment, not tested]
5. `app.disable('x-powered-by')`; add Helmet only if the app serves HTML from Express (CSP). With a Vite SPA served by Express, set `Content-Security-Policy: default-src 'self'` manually or via Helmet. UNVERIFIED in smoke.

**React/Vite XSS.**
- React escapes text by default; ban `dangerouslySetInnerHTML` via the ESLint rule above.
- Markdown: **react-markdown 10.1.0** turns Markdown into React elements, never an HTML string. Tested [smoke: `D:/mvp/private/scratch/mcs-v3/md-smoke`] with a document containing a `<script>` block, an `<img onerror>` tag and a `javascript:` link: by default the raw HTML is rendered as escaped text (`&lt;script&gt;...`) and the `javascript:` link becomes `href=""`; with `rehype-sanitize@6.0.0` the HTML is dropped entirely and the bad link loses its `href`. A normal `https://` link and bold text survived. Recommend `react-markdown` + `rehype-sanitize`, never enable `rehype-raw`, and never hand-roll a Markdown-to-HTML converter. Tree: 225 lines in `npm ls --all`, 15 MB `node_modules`, 0 vulnerabilities.
- Never render transcript text with `innerHTML`; treat all session data as untrusted (it contains arbitrary model output).

## 8. PINNED version table (installed together and run) [smoke]

All exact (`.npmrc save-exact=true`). Verified by `npm ci` in a clean copy followed by `npm run ci` on Node 24.14.1, and by running vitest, eslint, tsc, vite build on Node 22.23.3 and 26.11.1.

| Package | Pinned | Scope | Purpose |
|---|---|---|---|
| typescript | 6.0.3 | dev (root) | compiler and API for typescript-eslint |
| typescript-native (alias of typescript@7.0.2) | 7.0.2 | optional dev | fast second type checker, not required |
| @tsconfig/node24 | 24.0.5 | dev | tsconfig base |
| @types/node | 24.19.2 | dev | Node 24 types |
| vitest | 5.0.3 | dev | test runner |
| @vitest/coverage-v8 | 5.0.3 | dev | coverage |
| eslint | 10.12.0 | dev | linter |
| @eslint/js | 10.0.1 | dev | base rules |
| typescript-eslint | 8.71.1 | dev | TS rules (type-aware) |
| eslint-plugin-react-hooks | 7.1.1 | dev | hooks rules |
| eslint-plugin-jsx-a11y | 6.10.2 | dev (+ override) | a11y rules |
| globals | 17.13.0 | dev | env globals for flat config |
| prettier | 3.9.10 | dev | formatting |
| express | 5.3.0 | runtime | HTTP server |
| @types/express | 5.0.6 | dev | types |
| better-sqlite3 | 13.0.3 | runtime | SQLite |
| @types/better-sqlite3 | 9.6.0 | dev | types |
| zod | 4.6.5 | runtime | input validation, shared schemas |
| pino | 10.4.0 | optional runtime | structured logging if the in-house logger is rejected |
| react / react-dom | 19.3.0 | runtime (web) | UI |
| @types/react / @types/react-dom | 19.3.0 | dev | types |
| react-router | 8.4.0 | runtime (web) | routing (declarative) |
| @tanstack/react-query | 5.104.1 | runtime (web) | server state, cursor pages, SSE invalidation |
| lucide-react | 1.55.0 | runtime (web) | icons |
| vite | 8.3.4 | dev (web) | dev server and bundler (Rolldown 1.2.13) |
| @vitejs/plugin-react | 6.1.2 | dev (web) | JSX transform |
| happy-dom | 20.14.6 | dev (web) | test DOM |
| @testing-library/react / dom / jest-dom / user-event | 16.3.3 / 10.4.2 / 7.0.1 / 14.6.7 | dev (web) | component tests |
| @playwright/test | 1.64.0 | dev (e2e, separate smoke) | E2E via `channel: 'chrome'` (tested in `pw-smoke`, not in the workspace) |
| react-markdown / rehype-sanitize | 10.1.0 / 6.0.0 | runtime (web), only when Markdown is shown | safe Markdown (tested in `md-smoke`) |

Commands run in `D:/mvp/private/scratch/mcs-v3/stack-smoke` and observed results:

| Command | Result |
|---|---|
| `npm install` (first, no override) | `ERESOLVE`: jsx-a11y peer eslint <= 9 vs 10.12.0 |
| `npm install` (with override) | added 403 packages in 19 s, 0 vulnerabilities |
| `npm run typecheck` (`tsc -b packages/server packages/web`) | exit 0, 1.4 s |
| `node node_modules/typescript-native/bin/tsc -b packages/server packages/web --force` | exit 0, 0.3 s |
| `npm test` (`vitest run`, 2 projects) | 3 files, 9 tests passed (WAL pragma, FK enforcement, rollback, Host and Origin 403, Zod 400/201, SSE `Last-Event-ID` replay, component render, router navigation, TanStack invalidation) |
| `npm run lint` (`eslint .`) | clean after fixing 6 findings; 24 s cold, 6 s warm |
| `npm run format:check` (`prettier --check .`) | clean |
| `npm run build` | `tsc -p tsconfig.build.json` ok; `vite build` ok; `node packages/server/dist/db.js` imports OK |
| `npm run ci` in clean copy after `npm ci` | exit 0, 52 s |
| `npm audit` | 0 vulnerabilities |
| same suite via `node.exe` from `node@22` (22.23.3) and `node@26` (26.11.1) | vitest, eslint, tsc, vite build all passed |

## 9. Dependency list to add

Runtime (shipped):
- `better-sqlite3`: the only database driver, WAL, sync API suits an ingest worker.
- `express`: HTTP API, SSE endpoint, static files; Express 5 is the supported major.
- `zod`: validates every external input (hook payloads, query strings, config) and types the contracts.
- `react`, `react-dom`: UI.
- `react-router`: client routing (declarative mode).
- `@tanstack/react-query`: cache, cursor pagination, SSE invalidation.
- `lucide-react`: icon set.
- `react-markdown` + `rehype-sanitize`: only if Markdown from transcripts is rendered.

Dev:
- `typescript` 6.0.3, `@types/node`, `@tsconfig/node24`: compile and base config.
- `vite`, `@vitejs/plugin-react`: build the SPA.
- `vitest`, `@vitest/coverage-v8`, `happy-dom`, `@testing-library/react|dom|jest-dom|user-event`: unit and component tests.
- `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `globals`: static checks.
- `prettier`: formatting.
- `@types/express`, `@types/better-sqlite3`, `@types/react`, `@types/react-dom`: types.
- `@playwright/test`: E2E against installed Chrome (optional, root-level or separate package).

AVOID (and why):
- `typescript@7` as the only compiler (typescript-eslint cannot use it yet); `ts-node`, `tsx` (Node strips types natively on 22.23.3/24/26 and tsc builds shipped code); `nodemon` (`node --watch`).
- `jsdom` 30 (engine range excludes this machine's Node 24.14.1); `ws`/`socket.io` (SSE is enough); `axios` (use `fetch`); `dotenv` (use `node --env-file` / `process.loadEnvFile`); `commander`/`yargs` (use `node:util` `parseArgs`); `uuid` (`crypto.randomUUID`); `lodash`, `moment`, `date-fns` (use `Intl` and small helpers); `cors` (same-origin plus Host/Origin guard; wildcard CORS would weaken the rebinding defense); `body-parser` (built into Express 5 as `express.json`).
- `node:sqlite` as primary until the supported floor is >= 24.15 (RC, still 1.1 on 22.x); `sqlite3`.
- `pino` unless the in-house logger is rejected; `helmet` unless Express serves HTML with a CSP need.
- `tailwindcss`, CSS-in-JS, Redux/Zustand/SWR (TanStack Query covers server state; local state fits React hooks), `react-router-dom`, `next`/`remix` (SPA only), `rehype-raw`, `marked`/`markdown-it` plus `dangerouslySetInnerHTML`.
- Any dependency with install scripts: `.npmrc ignore-scripts=true` makes them inert, which is a feature.

## 10. Peer-dependency conflicts and deprecations found

| Item | Evidence | Resolution |
|---|---|---|
| jsx-a11y peer `eslint <= 9` vs ESLint 10.12.0 | `ERESOLVE` on first `npm install` [smoke] | `overrides` `$eslint`; rules verified working |
| typescript-eslint peer `typescript <6.1.0` vs TS 7.0.2 `latest` | `npm view typescript-eslint@8.71.1 peerDependencies` | pin TS 6.0.3 |
| TS 7 has no stable API until 7.1 | TS 7 announcement | same as above |
| jsdom 30.1.2 engines vs Node 24.14.1 | `EBADENGINE` warning [smoke] | use happy-dom |
| npm 12.2.0 engines vs Node 24.14.1 | warning from `npx npm@latest` [smoke] | stay on npm 11 here; upgrade Node to 24.15+ before npm 12 |
| lockfile install triggers `node-gyp rebuild` for better-sqlite3 (npm 11.11.0) | `npm ci` failed "Could not find any Visual Studio installation" [smoke] | `.npmrc ignore-scripts=true` |
| `typescript` alias to `@typescript/typescript6` hoists `@typescript/old`, which owns the `tsc` bin | `.bin/tsc` pointed at `@typescript/old` [smoke] | avoided; pin `typescript@6.0.3` directly |
| `@types/better-sqlite3@9.6.0` versus better-sqlite3 13 | compiled for the used subset | verify types when adding API calls |
| Deprecated packages in lockfile | 0 found [smoke: lockfile scan] | none |

## 11. Decision per question

1. Node: engines `^22.22.0 || ^24.0.0 || >=26.0.0` for dev, `>=22.12.0` for runtime; document 24 (Active LTS now, Maintenance from 2026-10-20) and 26 (LTS 2026-10-28) as the targets; 22 is a courtesy until 2027-04-30.
2. SQLite: better-sqlite3 13.0.3 behind one repository module; fallback `node:sqlite` when floor >= 24.15. Initialise WAL once, retry on `SQLITE_BUSY`.
3. TypeScript: 6.0.3 now; compile with tsc to `dist/`; native type stripping for dev only; flags as listed in section 3; revisit TS 7 when typescript-eslint supports it (7.1 API).
4. Server: Express 5.3.0, Zod 4.6.5, in-house logger (pino fallback), SSE with `Last-Event-ID`; no ws.
5. Client: React 19.3.0, Vite 8.3.4, plugin-react 6.1.2, React Router 8.4.0 declarative mode, TanStack Query 5.104.1, lucide-react 1.55.0, plain CSS variables, Testing Library + happy-dom.
6. Quality: Vitest 5.0.3 with `projects`, ESLint 10.12.0 flat + typescript-eslint 8.71.1 + hooks + jsx-a11y (override), Prettier 3.9.10, Playwright 1.64.0 with `channel: 'chrome'`; `npm ci` with `.npmrc` (`ignore-scripts`, `save-exact`).
7. Security: Host+Origin guard, 127.0.0.1 bind, strict Zod bodies, size limits, no raw HTML (lint-enforced), react-markdown + rehype-sanitize, `npm audit` in CI, `--min-release-age` for installs.

## 12. Unverified items

- typescript-eslint support timeline for TS 7 (7.1 API is the Microsoft statement; no typescript-eslint announcement was read).
- Which npm release fixes the `gypfile:false` lockfile behavior; only one search snippet, no issue read.
- better-sqlite3 prebuild coverage on platforms other than Windows x64 (only the file list was inspected, binaries loaded only on win32-x64).
- `@types/better-sqlite3` accuracy for 13.x beyond the calls used.
- Helmet/CSP behavior, the Node permission model and Zod 4 migration notes were not exercised.
- Playwright against the real app (only a data: URL page was driven).
- Timing numbers are single runs on one machine.

Scratch artifacts (outside the skill, gitignored): `D:/mvp/private/scratch/mcs-v3/{stack-smoke,stack-smoke-ci,bs3,bs3-ci,bs3-clean,nodes,ts-strip,pw-smoke,md-smoke,jsdom-smoke}`.

## Verification log (2026-10-11)

Adversarial pass by a second agent. Re-ran commands or re-fetched primary sources; scratch work in `D:/mvp/private/scratch/mcs-v3/verify`.

| Claim | Verdict | Evidence |
|---|---|---|
| Node release table (v20 EOL, v22 maint, v24 maint 2026-10-20, v25 EOL, v26 LTS 2026-10-28) | confirmed | `curl` of nodejs/Release `schedule.json`, all dates match |
| TS 7.0.2 is npm `latest`; no API until 7.1; 8x-12x claim | confirmed | `npm view typescript dist-tags` (latest 7.0.2, next 7.1.0-dev.20261010.1); TS 7.0 blog (dated 2026-07-08): "does not ship with an API", "We expect TypeScript 7.1 to ship with a new (and different) API", "speedups between 8x and 12x on full builds" |
| typescript-eslint 8.71.1 peer `typescript >=4.8.4 <6.1.0` | confirmed | `npm view typescript-eslint@8.71.1 peerDependencies` |
| Type stripping Stability 2 since v24.12.0, `.tsx` unsupported, no tsconfig, enum rejected | confirmed | nodejs.org latest-v24.x typescript.html (History: v24.12.0 stable, v24.3.0 no warning, v23.6.0 on by default); `node enum.ts` gives `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, `node a.ts` runs |
| `node:sqlite` 1.1 on 22.x and 24.14.1, 1.2 RC from 24.15.0/25.7.0, warning on 24.14.1 | confirmed | docs for v24.14.1 and latest-v22.x show "1.1 - Active development"; latest-v24.x shows history "v24.15.0 SQLite is now a release candidate" and 1.2; latest-v26.x history "v25.7.0 ... release candidate"; local `node:sqlite` on 24.14.1 printed ExperimentalWarning. No-warning on 26.11.1 not re-run (UNVERIFIED here) |
| better-sqlite3 13.0.3 engines `>=22`, `gypfile:false`, release dates | confirmed | `npm view better-sqlite3@13.0.3 engines gypfile`; `npm view better-sqlite3 time` (13.0.0 2026-07-21, 13.0.3 2026-08-05); unpackedSize 27302969 bytes |
| `npm ci` and lockfile `npm install` run node-gyp and fail without VS; fresh install does not; `--ignore-scripts` fixes it | confirmed | minimal repro `verify/gyp2` (only better-sqlite3 13.0.3): first `npm install` 0.8 s, loads; `npm ci` fails with gyp ERR "not ok"; `npm install` with lockfile fails "Could not find any Visual Studio installation"; `npm ci --ignore-scripts` added 2 packages in 0.5 s and the module loads |
| jsx-a11y 6.10.2 peer eslint <=9 gives ERESOLVE with ESLint 10.12.0; last published 2024 | confirmed | `npm view` peerDependencies (`^3 ... ^9`), time.modified 2024-10-26, still dist-tag latest; fresh `npm install` with eslint 10.12.0 gave ERESOLVE |
| jsdom 30.1.2 and npm 12.2.0 engines `^22.22.2 \|\| ^24.15.0 \|\| >=26`, machine is 24.14.1 | confirmed | `npm view jsdom@30.1.2 engines`, `npm view npm@12.2.0 engines`, `node -v` = v24.14.1 |
| Engines/versions for vite 8.3.4, vitest 5.0.3, eslint 10.12.0, react-router 8.4.0; all pinned versions are `latest` | confirmed | `npm view <pkg> engines` and `dist-tags.latest` for vite, vitest, eslint, react-router, express, zod, playwright, react-markdown, rehype-sanitize, happy-dom, react, react-query, better-sqlite3, jsdom, npm |
| Playwright `channel: 'chrome'` drives installed Chrome 155 with no download | confirmed | re-ran `playwright test` in `pw-smoke`: UA HeadlessChrome/155.0.0.0, 1 passed (762 ms) |
| react-markdown escapes raw HTML, drops `javascript:` href; rehype-sanitize drops script/img | confirmed | re-ran `md-smoke/t.mjs`: default output contains escaped `&lt;script&gt;` and `href=""`; sanitized output has no script/img and the bad link has no href |
| Smoke suite 9 tests pass (incl. SSE Last-Event-ID, Host/Origin 403) | confirmed | re-ran `npx vitest run` in `stack-smoke`: 3 files, 9 tests passed |
| MDN: 6 connections per browser+domain on HTTP/1.1, "Won't fix" | confirmed | MDN Using_server-sent_events (last modified 2026-09-03): limit "(6)", per browser + domain, "Won't fix" in Chrome and Firefox, HTTP/2 default 100 |
| Node security page: DNS rebinding tied to `--inspect`; ignore-scripts; `--min-release-age`; no insecureHTTPParser | confirmed | nodejs.org security-best-practices re-fetched |
| Express support page quote "only the latest major actively supported" | corrected | Page says "Only the latest version of any given major release line is supported." and lists v5 and v4 both "ongoing". Section 4 table row fixed |
| No private text or secrets in this file | confirmed | grep for email-like strings, user home paths, tokens: none; only scratch paths and the public Chrome install path |

Not re-verified (remain as the author marked them): 3-4 process cold-start WAL race frequencies, TS 6/7 timings, 52 s full pipeline, Node 22/26 pipeline runs, `npm audit` result, `@types/better-sqlite3` coverage.
