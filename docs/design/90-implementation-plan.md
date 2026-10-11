# 90 Implementation plan: work packages, DAG, gates and commit order (Phases 2-6)

Status: planning artefact, written 2026-10-11 by the implementation planner from `00-foundations.md`, designs `01`-`06` (revision 3
texts, as of 17:04), `98-contract-registry.md` and `99-requirements-matrix.md` (second review). It changes no design. Where a design and
this plan disagree on a name or a shape, the design (with the registry's authority order, 98 0.1) wins; this plan only decides who
builds what, in which order, under which gates. Plan-level choices that move or split a design slice are listed in plan section 10 with the reason.

Reading guide: plan section 1 conventions; plan section 2 rules for every agent; plan section 3 shared resources (locks, ports, the native SQLite binary, npm);
plan section 4 the shared-file marked-block protocol; plan section 5 gate macros; plan section 6 verifier protocol; plan section 7 the master DAG table; plan section 8 the work-package
catalogue (one block per WP); plan section 9 per-phase integration gates and the lead's commit order; plan section 10 deviations from the design slice tables;
plan section 11 risk register; plan section 12 stop-the-line rules; plan section 13 lead steps.

## 1. Conventions

| Item | Rule |
|---|---|
| References | Registry style (98 0.1): `03 5.2` = design 03, section 5.2; a following `, section 6.1` continues the same document; `plan section N` = this document; `ADR 00nn` = `docs/decisions/00nn-*.md`; `I-nn`, `N-nn`, `Cnn` = issues of 99 section 2/2a and conflicts of 98 section 15. |
| Paths | Relative to `<skill>/runtime/` unless they start with `<skill>/` (skill root `D:/mvp/.claude/skills/monitoring-claude-sessions`). `sh/ en/ sv/ cl/ wb/ tk/` are the registry abbreviations (98 0.2). |
| WP id | `WP-01`..`WP-79`, numbered in phase order. Lead-only steps are `LS-0`, `LS-6a`, `LS-6b` (plan section 13); they are not counted as WPs. |
| Source slice | Each WP names the design slices it implements (`01 S7`, `02 I-4`, `03 S5`, `04 W6`, `05 S2`, `06 PP5`). Every slice of the six slice tables maps to exactly one WP or LS; plan section 10 lists every split, merge and move. |
| Wave | `W<phase>.<n>`: the earliest wave in which a WP can start once every dependency is verified. Scheduling is rolling (plan section 9.1); waves are only the earliest-start bound. |
| Size | S: <= 3 source files or one well-specified module. M: <= 8 source files in one layer. L: 9-17 thin files of one kind (schemas, repositories, components, docs) or <= 8 complex files; every L WP names a cut line. Test files are not counted. An engine `ops/*` module plus its render-only `cl/commands/*` adapters, and an `en/query/*` module plus its thin `sv/routes/*` adapter, count as one layer (01 6.1 INV-12, ADR 0029). |
| Models | Implementer and verifier per WP. `opus xhigh` only for lifecycle, ingestion, concurrency and security-critical work; `sonnet high` for most implementation; `sonnet medium` or `haiku` for mechanical scaffolding, fixtures and docs; `fable` (or `opus xhigh`) for adversarial verification of critical WPs. |
| Counts | 79 agent WPs: Phase 2 = 24, Phase 3 = 19, Phase 4 = 13, Phase 5 = 12, Phase 6 = 11. Above the 50-70 aim on purpose: the six designs define 78 slices, and merging further would create WPs over the 8-file / two-layer limit on critical code (plan section 10 lists the merges already made). |

## 2. Rules for every agent (the lead pastes this section and the WP block into every implementer and verifier brief)

1. Foundations section 1 and section 5 apply unchanged: legacy paths are read-only (`<skill>/src/`, `template/`, `config/`, the existing `tests/`
   files and folders, `reference/`, `SKILL.md`, the existing top-level `docs/*.md`); English only; no private data; no git write command
   (`add`, `commit`, `mv`, `apply`, `stash`, `checkout -- <path>`, `worktree`, `tag`); scratch only under `D:/mvp/private/scratch/mcs-v3/`.
2. Write only the files your WP block lists under Creates, plus your own marked blocks (plan section 4) in the files listed under Blocks. A missing
   file, a needed contract change or a design gap is a change request (CR): write `D:/mvp/private/scratch/mcs-v3/cr/CR-<WP>-<n>.json`
   `{wp, doc, section, problem, proposal}` and continue with the rest of the WP; the lead answers and edits designs, the registry or this
   plan. Never change a name owned by another design (98 0.1) on your own.
3. Read the design sections listed under Inputs before writing code, and the registry rows of every name you produce or consume. Where a
   `Cnn` row of 98 section 15 still differs from the current design text, the registry's fix column wins.
4. Test first: the tests named under Tests exist and fail before the code that makes them pass. Never weaken, skip or delete a test, a
   lint rule or a check to get green; `it.skip` only through the quarantine protocol of 05 4.7 plus a CR.
5. Every CLI call in a test, probe or experiment passes `--repo <temp dir>` and, for `init`/`start`/`serve`, `--port <n>` from plan section 3.2.
   Every process gets `MCS_HOME=<temp>`, `CLAUDE_CONFIG_DIR=<temp>`, `MCS_HOOK_DISABLE=1` (except tests of the handler itself) and
   `MCS_LAUNCHER_NO_BOOTSTRAP=1` (except launcher tests on a temp copy of the runtime). No `init`/`start` without `--port` (the default
   scan 8765-8784 reaches the live monitor) and no CLI call with the working directory inside `D:/mvp` without `--repo` (it would create
   `D:/mvp/.claude/monitor/tasks/default`).
6. Run every gate command of your WP (plan section 5) under the locks of plan section 3 and paste the exact command, exit code and summary line into your final
   answer. A gate you could not run is reported as NOT RUN with the reason, never as passed (foundations C5).
7. Stop every process and free every port you started before you finish; `END` (plan section 5) checks it.
8. Python: only `PYTHONDONTWRITEBYTECODE=1 python -B ...`, only against temp repos; legacy servers only on 18850-18874.
9. Generated files (JSON Schemas, goldens, `docs/api/reference.md`) are written only by their generator WP or by the lead's phase gate.
10. Final answer (structured, short): files created and blocks edited, gates with results, deviations, CRs, UNVERIFIED items.

## 3. Shared resources

### 3.1 Locks (`D:/mvp/private/scratch/mcs-v3/kit/mcslock.mjs`, built in LS-0)

`node $K/mcslock.mjs <name> [--timeout-ms N] -- <command> [args...]` holds an OS-released mutex (a Windows named pipe `mcs-v3-<name>`, the
primitive of 01 4.2 verified by E10, so a killed holder releases at once), runs the command with inherited stdio and exits with its code.
Semaphores are numbered names (`lint.1`, `lint.2`; the tool takes the first free one).

| Lock | Taken around | Mode | Who | Max hold |
|---|---|---|---|---|
| `npm` | `npm ci`, `npm install`, `npm audit`, any lockfile change (`npm rebuild` is never used) | exclusive barrier: before taking it the lead pauses every agent and checks with a PowerShell CIM query that no `node.exe` command line contains the `runtime` folder of the skill, because a loaded `better_sqlite3.node` blocks the delete that `npm ci` performs (01 5.1 step 6b, E11). After `npm ci` the lead runs `node scripts/build-stamp.mjs write-install` so the launcher never sees a stale install and never bootstraps on its own | lead only (WP-01 runs it with the lead's grant) | 15 min |
| `run` | every `vitest` run (any project), `tsc -b` / `npm run build` / `npm run clean` / `vite build`, `scripts/smoke.mjs`, `npm run ci`, Playwright, `npm run bench`, `capture_golden.py`, any process started from `packages/*/dist`, `<skill>/scripts/mcs.mjs` or the legacy `viewer.py` | exclusive: two concurrent Vitest runs share `node_modules/.vite` and fail falsely; the port blocks of 05 4.5 assume one Vitest; `clean` deletes the `dist/` that other runs execute | any agent | 15 min per acquisition; release between batches |
| `lint.1`, `lint.2` | `eslint` (typed linting uses about 1-2 GB) | 2-slot semaphore | any | 10 min |
| `dev` | `npm run dev` (API 18765, web 18766), `vite preview` (18767) | exclusive | UI WPs | 20 min |
| `file:<path>` | read-modify-write of a shared file of plan section 4 (edit inside one's block, then `npx prettier --write <path>`) | exclusive per file | block owners | 2 min |
| `pkgjson` | `npm pkg set scripts.<key>=...` on `package.json` (plan section 4.3) | exclusive | listed WPs | 1 min |
| `git` | `git add`, `commit`, `apply --cached`, `tag`, `worktree` | exclusive | lead only | - |

Not locked: `tsc -p <project> --noEmit` (writes nothing), `prettier --check`, reading files. The native SQLite binary is never rebuilt;
development and tests use this machine's Node v24.14.1 (one ABI); a binary load error stops the line (plan section 12 rule 11).

### 3.2 Ports (05 4.5, 98 section 14; never 8765-8784, 3000, 3100, 8080, 8089)

| Range | User | Allocation |
|---|---|---|
| 18000-18499 | Vitest real-process tests | testkit `allocatePort()` (per-worker blocks of 50), inside `run` |
| 18500-18599 | Playwright E2E | `allocatePort([18500, 18599])`, inside `run` |
| 18760-18769 | `npm run dev` / `vite preview` | fixed 18765 / 18766 / 18767, inside `dev` |
| 18800-18849 | `scripts/smoke.mjs` | inside `run` |
| 18850-18874, 18875-18899 | legacy Python server (golden capture, live parity), Node server in the parity harness | inside `run` |
| 18900-18949 | benchmarks (06 8.3) | inside `run` |
| 18950-18997 | manual experiments | 12 slots of 4 ports (slot k = `18950+4k`..`18953+4k`), assigned by the lead in `$K/ports.json` when a WP starts, freed when it ends |
| 18998-18999 | lead | |

## 4. Shared-file protocol (append-only marked blocks)

### 4.1 Markers

TS/JS: `// @wp-begin WP-29` ... `// @wp-end WP-29`. CSS: `/* @wp-begin WP-50 */` ... `/* @wp-end WP-50 */`. The creator WP writes every
pair listed for the file in plan section 4.2, empty, in ascending WP order, at the file's anchor (end of the export list of a barrel; inside the array
or object literal of a registry, each entry ending with a comma; inside the top-level `describe` of a test file). An empty block is valid
code. Rules:
1. A WP edits only lines strictly between its own two markers, under the `file:<path>` lock: take the lock, re-read the file, edit, run
   `npx prettier --write <path>`, release. The Edit tool refuses a stale read; on that error re-read and retry.
2. Never reorder, hand-format or delete another WP's block or a marker. A block that is missing from plan section 4.2 is a CR; the lead adds the pair.
3. Barrel blocks hold only `export ... from './x.ts'` lines; registry blocks hold only entries; test-file blocks hold only `describe`/`it`.
4. `node $K/wp-gate.mjs markers --check` (part of `END`) fails on an unpaired or duplicated marker, a marker of an unknown WP, or a
   changed line outside the WP's own blocks in a file the WP does not own (diff against `HEAD`).
5. The lead's partial staging (plan section 9.1) uses the markers: `wp-gate stage --wp WP-xx` stages the WP's owned files plus only its blocks.
6. Markers stay until LS-6b, which removes them in one reformat-only commit (`grep -r "@wp-" runtime` finds nothing afterwards).

### 4.2 Shared-file register

| File (under `runtime/`) | Creator | Blocks (owners) |
|---|---|---|
| `packages/shared/src/index.ts` | WP-01 | WP-02, WP-03, WP-04, WP-05, WP-09, WP-29 |
| `packages/shared/src/protocol/index.ts` | WP-01 | WP-02, WP-04 |
| `packages/shared/src/api/routes.ts` (route registry) | WP-03 | WP-29 (`explainCompletion` row) |
| `packages/shared/src/cli/results.ts` | WP-02 | WP-37, WP-61, WP-62, WP-64 |
| `packages/engine/src/index.ts` (the only engine entry, 05 2.2) | WP-01 | one block per engine WP: WP-05, 07, 08, 09, 12, 13, 14, 16, 17, 19, 22, 28, 29, 30, 31, 32, 33, 34, 35, 37, 38, 40, 41, 57, 58, 59, 60, 61, 62, 63 |
| `packages/engine/src/query/index.ts` (`createQueries`) | WP-17 | WP-29, WP-30, WP-31, WP-33, WP-57, WP-58 |
| `packages/engine/src/query/overview.ts` | WP-31 | WP-58 (token and cost metrics of 03 8.1) |
| `packages/engine/src/runtime/instance-runtime.ts` (stub factories replaced by real ones) | WP-16 | WP-17 (`createQueries`), WP-35 (`createIngestService`, `createLifecycleSweeper`, `createDbScheduler`), WP-41 (`createPanelService` + 2 s attempts timer), WP-59 (alerts service) |
| `packages/engine/src/maintenance/schedule.ts` | WP-35 | WP-59 (alert sweep timer), WP-60 (bookkeeping retention timer) |
| `packages/engine/src/ops/lifecycle.ts` | WP-19 | WP-63 (legacy-engine delegation branch) |
| `packages/server/src/app.ts` (mounted route modules) | WP-17 | WP-29, WP-30, WP-31, WP-33, WP-36, WP-41, WP-57, WP-58, WP-60 |
| `packages/server/src/routes/sessions.ts` | WP-30 | WP-58 (`sessionUsage`) |
| `packages/cli/src/main.ts` (command registry) | WP-15 | WP-19, WP-22, WP-38, WP-61, WP-62, WP-63, WP-64 |
| `packages/testkit/src/index.ts` | WP-01 | WP-06, WP-42, WP-55 |
| `vitest.config.ts` | WP-01 | WP-43 (parity `globalSetup`, live mode), WP-72 (`security` project) |
| `scripts/ci.mjs` | WP-01 | WP-72 (`--project security` in the `test` gate), WP-75 (`check:text`, `check:docs` gates) |
| `tests/isolation/config-write-isolation.test.ts` | WP-15 | WP-22, WP-38, WP-39, WP-62 |
| `tests/isolation/lifecycle-isolation.test.ts` | WP-20 | WP-62 (T-ISO-15) |
| `tests/isolation/ownership-isolation.test.ts` | WP-20 | WP-63 (T-ISO-23) |
| `packages/engine/test/hook-to-db.int.test.ts` | WP-32 | WP-39 |
| `packages/web/src/app/routes.tsx` | WP-44 | WP-49, WP-50, WP-52, WP-53, WP-54, WP-66, WP-67 |
| `packages/web/src/styles/pages.css` | WP-44 | WP-49, WP-50, WP-52, WP-53, WP-54, WP-65, WP-66, WP-67 |
| `packages/web/src/styles/components.css` | WP-44 | WP-48, WP-50, WP-51, WP-54 |
| `packages/web/src/styles/transcript.css`, `panels.css` | WP-44 (empty) | WP-51, WP-65 (one block each) |
| `packages/web/e2e/specs/lifecycle.spec.ts` | WP-56 | WP-57 (step 7), WP-71 (steps 13-14) |

### 4.3 JSON manifests (no comments possible)

`package.json` files change only by keyed insertion: `node $K/mcslock.mjs pkgjson -- npm pkg set "scripts.<key>=<command>"`, only for the
keys assigned here (05 3.1, registry C45): WP-23 `schemas`, `schemas:check`; WP-43 `parity:capture`, `parity:check`; WP-55 `testkit`;
WP-68 `bench`; WP-70 `parity:shadow`; WP-72 `test:security` and the value of `test` (append `--project security`); WP-75 `check:text`,
`check:docs`, `test:stress`, `release-check`. Dependencies change only at an `npm` barrier run by the lead with an exact pin: `axe-core`
in `packages/web` devDependencies (WP-71; 04 W14, ADR 0039); an MCP SDK only if ADR 0060 of WP-64 accepts one (repository rule: no
dependency without a documented reason). `check-deps` (05 3.2) fails any other change.

### 4.4 Lead-owned files

`docs/design/*.md` (this plan included), `docs/decisions/*.md` status lines, `<skill>/runtime/eslint.config.js` after WP-01 (changes by
CR only, with a `lint-rules.test.ts` probe update in the same change), `<skill>/.gitignore` after WP-01, commits of
`tests/legacy-parity/golden/**`, regeneration commits of `<skill>/schemas/**` and `<skill>/docs/api/reference.md`.

## 5. Gate macros

Shell: Git Bash. `S=/d/mvp/.claude/skills/monitoring-claude-sessions`, `R=$S/runtime`, `K=/d/mvp/private/scratch/mcs-v3/kit`,
`W=<WP id>`. `wp-gate.mjs` (LS-0) reads the WP manifest `$K/wp/<WP>.json`, generated from the Creates and Blocks lines of plan section 8.

| Macro | Exact command |
|---|---|
| `FMT` | `cd $R && npx prettier --check <created and edited paths of $W>` |
| `LINT` | `cd $R && node $K/mcslock.mjs lint -- npx eslint --max-warnings 0 <created and edited .ts/.tsx/.js/.mjs paths of $W>` |
| `TSC p...` | `cd $R && node $K/wp-gate.mjs tsc --wp $W <p>...`: runs `npx tsc -p packages/<p>/tsconfig.json --noEmit --pretty false` per project (`tests` = `tests/tsconfig.json`, `e2e` = `packages/web/e2e/tsconfig.json`); fails on any diagnostic in a file of `$W`; lists foreign diagnostics (files of WPs in progress) without failing |
| `UNIT f...` | `cd $R && node $K/mcslock.mjs run -- npx vitest run --project unit <f>...` |
| `WEB f...` | `cd $R && node $K/mcslock.mjs run -- npx vitest run --project web <f>...` |
| `INT f...` | `cd $R && node $K/mcslock.mjs run -- sh -c "node $K/wp-gate.mjs build --wp $W && npx vitest run --project integration <f>..."`; `build` = `npm run clean` + `npx tsc -b tsconfig.build.json` with own-file diagnostics fatal; `build --web` adds `npm run build -w @mcs/web` |
| `ISO`, `RES`, `SEC`, `PAR`, `TOOL` `f...` | as `INT` with `--project isolation`, `resilience`, `security`, `parity`, `tooling` |
| `E2E s...` | `cd $R && node $K/mcslock.mjs run -- sh -c "npm run build && npx playwright test -c packages/web/e2e/playwright.config.ts <s>..."` |
| `PY c` | `cd $S && node $K/mcslock.mjs run -- sh -c "PYTHONDONTWRITEBYTECODE=1 python -B <c>"` |
| `END` | `node $K/wp-gate.mjs end --wp $W`: ownership (every changed path is in the manifest or is a block of `$W`), `markers --check`, legacy paths unchanged against `HEAD` (`git status --porcelain -- src template config reference SKILL.md tests/*.py tests/fixtures tests/frontend tests/tools` plus the top-level `docs/*.md` is empty), no listener left on 18000-18999 started by `$W`, no `node.exe`/`python.exe` left whose command line contains a temp root of `$W` |
| `STD(p...)` | `FMT` + `LINT` + `TSC p...` + `END` |

Every WP gate = `STD` over the projects it touches + the test macros of its block (each must exit 0) + any extra command in its block.
`WAVE` (lead, before committing WPs, plan section 9.1): `cd $R && node $K/mcslock.mjs run -- node scripts/ci.mjs --offline --keep-going` on the
working tree; a red gate in a file of a WP that is about to be committed stops that commit.

## 6. Verifier protocol

1. The verifier is a fresh agent with the model named in the WP block, never the implementer. Inputs: the WP block, plan section 2, the design
   sections listed, the implementer's structured answer, `git status` / `git diff` (read-only) and the new files.
2. It re-runs every gate command itself (it never trusts pasted output), checks the Verifier line of the WP block, and reviews the diff
   against the design text for every name the WP produces (registry rows).
3. Adversarial verification (`fable` or `opus xhigh` verifiers): the verifier also writes throw-away probes under
   `D:/mvp/private/scratch/mcs-v3/verify/<WP>/` (never in the repository) that try to break each invariant of the block (fault injection,
   reordering, concurrency, hostile input) and reports each probe and its outcome.
4. Verdict `PASS` or `FAIL` with numbered findings (file, line, design section). On FAIL the implementer is resumed (SendMessage, same
   context) and fixes; after two FAIL rounds the lead decides (re-plan, split, other model).
5. A verifier never edits repository files.

## 7. Master DAG

Dependencies are hard: a WP starts only when every listed WP is verified (plan section 6). Transitive dependencies are not repeated. `LS-*` rows are
lead steps (plan section 13). Earliest waves: Phase 2 W2.1-W2.10, Phase 3 W3.1-W3.6, Phase 4 W4.1-W4.6, Phase 5 W5.1-W5.3, Phase 6 W6.1-W6.3. At most
six implementers run at once (lock contention on `run`); a wave with more WPs is drained in the row order below.

| WP | Title | Phase | Wave | Size | Depends on | Implementer | Verifier | Source slices |
|---|---|---|---|---|---|---|---|---|
| LS-0 | Orchestration kit (locks, gates, manifests, port ledger) | 2 | W2.0 | S | - | lead (sonnet medium) | sonnet high | this plan, sections 3-5 |
| WP-01 | Monorepo scaffold and gates | 2 | W2.1 | L | LS-0 | sonnet medium | sonnet high | 05 S1 (files) |
| WP-24 | Golden generator (Python oracle) | 2 | W2.1 | M | LS-0 | sonnet high | opus xhigh | 06 PP2 |
| WP-02 | Shared contracts: ids, time, files, runtime config sections, CLI results, control protocol | 2 | W2.2 | L | WP-01 | sonnet high | sonnet high | 01 S1 |
| WP-04 | Hook protocol contracts | 2 | W2.2 | M | WP-01 | sonnet high | fable | 02 I-1 |
| WP-03 | Shared API and panel contracts | 2 | W2.3 | L | WP-02 | sonnet high | opus xhigh | 03 S3, 06 PP0 |
| WP-05 | Python compatibility: PyJson and regex translator | 2 | W2.3 | L | WP-02 | sonnet high | fable | 01 S2, 01 S3 |
| WP-06 | Testkit core and fixtures | 2 | W2.3 | L | WP-02, WP-04 | sonnet high | sonnet high | 05 S2, 05 S3 |
| WP-07 | Platform layer, mutex and markers | 2 | W2.4 | L | WP-02, WP-03 | opus xhigh | fable | 06 PP1, 01 S4 |
| WP-09 | DB core | 2 | W2.4 | L | WP-02, WP-03, WP-04 | opus xhigh | fable | 03 S1 |
| WP-12 | Config resolution | 2 | W2.4 | M | WP-02, WP-05 | sonnet high | opus xhigh | 01 S5 |
| WP-23 | Tooling tests, JSON Schema generator, inactive CI | 2 | W2.4 | M | WP-01, WP-02, WP-03 | sonnet high | sonnet high | 05 S1 (tests), 05 S5, 01 S16 + 03 S3 (generator) |
| WP-08 | Security primitives | 2 | W2.5 | M | WP-03, WP-04, WP-07 | opus xhigh | fable | 05 S6 |
| WP-10 | Write-path repositories and change sink | 2 | W2.5 | L | WP-09 | opus xhigh | fable | 03 S2 (part) |
| WP-11 | Entity and operations repositories | 2 | W2.5 | L | WP-09 | sonnet high | opus xhigh | 03 S2 (part) |
| WP-13 | Workspace and audit | 2 | W2.5 | L | WP-05, WP-07, WP-12 | opus xhigh | fable | 01 S6 |
| WP-14 | Engine ops: workspace, config, audit | 2 | W2.6 | M | WP-12, WP-13 | sonnet high | opus xhigh | 01 S7 (ops) |
| WP-16 | Composition root | 2 | W2.6 | M | WP-07, WP-08, WP-09, WP-12, WP-13 | opus xhigh | fable | 01 S8 (engine part) |
| WP-15 | CLI kernel and config commands | 2 | W2.7 | L | WP-08, WP-14 | sonnet high | sonnet high | 01 S7 (CLI) |
| WP-17 | Server app, meta routes, static hosting | 2 | W2.7 | M | WP-03, WP-08, WP-11, WP-16 | opus xhigh | fable | 03 S4 |
| WP-18 | Server process shell | 2 | W2.8 | M | WP-07, WP-13, WP-17 | opus xhigh | fable | 01 S8 (server part) |
| WP-19 | Lifecycle ops and CLI | 2 | W2.9 | M | WP-15, WP-18 | opus xhigh | fable | 01 S9 (ops, CLI) |
| WP-20 | Isolation setup and lifecycle isolation tests | 2 | W2.10 | M | WP-06, WP-19 | sonnet high | opus xhigh | 05 S9 (`_setup.ts`), 01 S9 (isolation files) |
| WP-21 | Launcher | 2 | W2.10 | M | WP-01, WP-07, WP-19 | opus xhigh | fable | 01 S10, 05 S4 |
| WP-22 | Instances, doctor, diagnostics | 2 | W2.10 | M | WP-15, WP-19 | sonnet high | opus xhigh | 01 S11 |
| WP-25 | Hook handler and stub | 3 | W3.1 | M | WP-04, WP-06 | opus xhigh | fable | 02 I-2 |
| WP-26 | Ingestion primitives: tailer and normalizers | 3 | W3.1 | L | WP-03, WP-04, WP-07 | opus xhigh | fable | 02 I-3, 02 I-5 |
| WP-30 | Query layer A: sessions, agents, events, tool calls | 3 | W3.1 | L | WP-10, WP-11, WP-17 | sonnet high | opus xhigh | 03 S5 (part) |
| WP-42 | Testkit legacy builders | 3 | W3.1 | M | WP-06, WP-24 | sonnet high | sonnet high | 06 PP3 |
| WP-27 | Token accounting | 3 | W3.2 | M | WP-26 | opus xhigh | fable | 02 I-6 |
| WP-28 | Lifecycle model | 3 | W3.2 | L | WP-26 | opus xhigh | fable | 02 I-7 |
| WP-31 | Query layer B: overview, work items, alerts, errors | 3 | W3.2 | M | WP-11, WP-30 | sonnet high | sonnet high | 03 S5 (part) |
| WP-33 | Transcript entries, index, window, locate | 3 | W3.2 | M | WP-10, WP-17, WP-26 | sonnet high | opus xhigh | 03 S7 |
| WP-37 | Hooks installer | 3 | W3.2 | M | WP-04, WP-07, WP-13, WP-25 | opus xhigh | fable | 02 I-9 |
| WP-43 | Parity harness base and L1 vectors | 3 | W3.2 | M | WP-05, WP-07, WP-12, WP-13, WP-24, WP-42 | sonnet high | opus xhigh | 05 S8, 06 PP4 |
| WP-29 | Completion evidence end to end | 3 | W3.3 | M | WP-11, WP-17, WP-28 | opus xhigh | opus xhigh | 02 I-7b, 03 S5b |
| WP-32 | Hook path to the database | 3 | W3.3 | L | WP-10, WP-11, WP-16, WP-17, WP-25, WP-26, WP-28 | opus xhigh | fable | 02 I-4 |
| WP-36 | Stream: hub, hydration, SSE | 3 | W3.3 | M | WP-09, WP-30, WP-31 | opus xhigh | fable | 03 S6 |
| WP-34 | Transcript importer | 3 | W3.4 | M | WP-05, WP-26, WP-27, WP-32, WP-33 | opus xhigh | fable | 02 I-8 (part) |
| WP-38 | Hooks and ingest CLI | 3 | W3.4 | M | WP-15, WP-18, WP-32, WP-37 | sonnet high | opus xhigh | 01 S14 |
| WP-40 | Attempts | 3 | W3.4 | M | WP-05, WP-07, WP-11, WP-26, WP-32, WP-43 | opus xhigh | opus xhigh | 06 PP5 |
| WP-35 | Ingest service, sweeper, external evidence, ingestion health, DB schedule | 3 | W3.5 | L | WP-16, WP-28, WP-32, WP-34 | opus xhigh | fable | 02 I-8 (part), 02 I-10, 03 S11 (schedule) |
| WP-41 | Panels: samplers, service, route, runtime wiring | 3 | W3.5 | L | WP-07, WP-16, WP-17, WP-40 | sonnet high | opus xhigh | 06 PP7 |
| WP-39 | Ingestion integration and ingestion isolation rows | 3 | W3.6 | M | WP-20, WP-25, WP-30, WP-35, WP-38 | sonnet high | opus xhigh | 02 I-11 |
| WP-44 | Web scaffold | 4 | W4.1 | M | WP-01, WP-03 | sonnet high | sonnet high | 04 W1 |
| WP-45 | Pure lib port | 4 | W4.1 | L | WP-01 (gate after WP-44) | sonnet high | sonnet high | 04 W2 |
| WP-55 | Scenario catalogue and testkit CLI | 4 | W4.1 | M | WP-25, WP-42 | sonnet medium | sonnet high | 06 PP6 |
| WP-46 | Data layer | 4 | W4.2 | L | WP-02, WP-03, WP-44 | sonnet high | opus xhigh | 04 W3 |
| WP-47 | Stream client and reconciliation | 4 | W4.3 | M | WP-46 | opus xhigh | fable | 04 W4 (stream part) |
| WP-49 | Shell, sidebar, prefs | 4 | W4.3 | L | WP-45, WP-46 | sonnet high | sonnet high | 04 W5 |
| WP-51 | Transcript viewer and text primitives | 4 | W4.3 | L | WP-45, WP-46 | sonnet high | fable | 04 W7 (part) |
| WP-48 | Connection and freshness UI | 4 | W4.4 | M | WP-45, WP-47 | sonnet high | sonnet high | 04 W4 (shell part) |
| WP-50 | Sessions explorer and list components | 4 | W4.4 | L | WP-47, WP-49 | sonnet high | sonnet high | 04 W6 |
| WP-54 | Overview page | 4 | W4.4 | M | WP-46, WP-49 | sonnet high | sonnet medium | 04 W9 (part) |
| WP-52 | Session detail page | 4 | W4.5 | M | WP-50, WP-51 | sonnet high | sonnet high | 04 W7 (part) |
| WP-53 | Activity feed | 4 | W4.5 | S | WP-47, WP-50 | sonnet high | sonnet high | 04 W8 |
| WP-56 | Cross-stack tests and Phase 4 E2E smoke | 4 | W4.6 | M | WP-19, WP-25, WP-30, WP-31, WP-33, WP-36, WP-38, WP-41, WP-48, WP-52, WP-53, WP-54 | sonnet high | opus xhigh | 04 11.3, 04 W14 (part) |
| WP-57 | Transcript search and E2E step 7 | 5 | W5.1 | M | WP-33, WP-51, WP-56 | opus xhigh | fable | 03 S8, 04 W14 (step 7) |
| WP-58 | Analytics, cost, session usage, overview token metrics | 5 | W5.1 | M | WP-27, WP-30, WP-31 | sonnet high | opus xhigh | 03 S9 |
| WP-59 | Alerts | 5 | W5.1 | M | WP-31, WP-35, WP-36 | sonnet high | opus xhigh | 03 S10 |
| WP-60 | Export and data retention | 5 | W5.1 | M | WP-09, WP-30, WP-33, WP-35 | opus xhigh | fable | 03 S11 (part) |
| WP-63 | Legacy delegation and cross-engine tests | 5 | W5.1 | M | WP-19, WP-20, WP-24 | sonnet high | opus xhigh | 01 S15 |
| WP-65 | Workspace panels UI | 5 | W5.1 | M | WP-41, WP-46, WP-54 | sonnet high | sonnet medium | 04 W9 (part) |
| WP-66 | Task board and analytics UI | 5 | W5.1 | M | WP-50 | sonnet high | sonnet medium | 04 W10, 04 W11 |
| WP-67 | Settings and health UI | 5 | W5.1 | M | WP-48 | sonnet high | sonnet medium | 04 W12 |
| WP-61 | Readers, data CLI, verify-completion | 5 | W5.2 | M | WP-15, WP-19, WP-29, WP-30, WP-60 | sonnet high | opus xhigh | 01 S13a, 01 S13b, 03 S12 |
| WP-62 | Backup, upgrade, DB migrate and rebuild, cleanup, config migrate | 5 | W5.2 | L | WP-09, WP-12, WP-19, WP-60 | opus xhigh | fable | 01 S12 |
| WP-68 | Benchmarks | 5 | W5.2 | M | WP-17, WP-19, WP-41, WP-55 | sonnet medium | sonnet high | 06 PP10 |
| WP-64 | Read-only MCP server | 5 | W5.3 | M | WP-61 | sonnet high | fable | foundations open question 7, R-8.9.10 |
| LS-6a | Legacy docs move (`git mv`) and banners | 6 | W6.1 | S | Phase 5 gate | lead | sonnet high | 05 6.4 |
| WP-69 | Parity L2 A and ported-function vectors | 6 | W6.1 | L | WP-27, WP-28, WP-30, WP-33, WP-34, WP-35, WP-43, WP-55, WP-57 | sonnet high | opus xhigh | 06 PP8 (part), 06 PP4 (later vectors) |
| WP-70 | Parity L2 B and shadow tool | 6 | W6.1 | L | WP-05, WP-13, WP-19, WP-40, WP-41, WP-43, WP-55 | sonnet high | opus xhigh | 06 PP8 (part), 06 PP9 |
| WP-71 | E2E completion and accessibility | 6 | W6.1 | M | WP-35, WP-56, WP-57, WP-65, WP-66, WP-67 | sonnet high | opus xhigh | 04 W14 (rest), 04 11.2 `a11y.test.tsx` |
| WP-72 | Security suite | 6 | W6.1 | L | WP-07, WP-08, WP-17, WP-19, WP-25, WP-37, WP-57, WP-60, WP-61 | opus xhigh | fable | 05 S7 |
| WP-73 | Data privacy and data isolation | 6 | W6.1 | M | WP-20, WP-57, WP-58, WP-60, WP-61 | sonnet high | fable | 03 S13, 01 S13a (isolation files) |
| WP-74 | Resilience suite | 6 | W6.1 | L | WP-13, WP-19, WP-25, WP-35, WP-62 | sonnet high | opus xhigh | 05 S9 (resilience) |
| WP-75 | Release tooling: check-text, check-docs, stress, release-check | 6 | W6.1 | M | WP-23 | sonnet medium | sonnet high | 05 S9 (scripts), 05 S10 (`check-docs.mjs`) |
| WP-76 | Docs A: architecture, data model, hooks, API, CCAM reference | 6 | W6.2 | L | LS-6a, WP-75, Phases 2-5 complete | sonnet medium | sonnet high | 05 S10 |
| WP-77 | Docs B: configuration, instance isolation, operations, troubleshooting | 6 | W6.2 | L | LS-6a, WP-75, WP-22, WP-62 | sonnet medium | sonnet high | 05 S10, 01 S16 (docs), 06 PP11 |
| WP-78 | Docs C: testing, migration, traceability | 6 | W6.2 | M | WP-69, WP-70, WP-71, WP-72, WP-73, WP-74, WP-75 | sonnet medium | sonnet high | 05 S10 |
| WP-79 | SKILL.md candidate and skill verification | 6 | W6.2 | M | WP-21, WP-22, WP-38, WP-61, WP-62, WP-63 | sonnet high | opus xhigh | 01 Appendix A, 01 S16 |
| LS-6b | Release gates, cutover evidence, marker cleanup, SKILL.md install | 6 | W6.3 | M | every WP | lead | opus xhigh | 05 section 7, 06 5.9 |

Critical path (longest dependency chain, 16 nodes, computed from the table): LS-0 -> WP-01 -> WP-02 -> WP-05 -> WP-12 -> WP-13 ->
WP-16 -> WP-17 -> WP-30 -> WP-31 -> WP-36 -> WP-56 -> WP-57 -> WP-71 -> WP-78 -> LS-6b. Two segments have an equally long twin, so both
twins are critical too: WP-02 -> WP-03 -> WP-07 -> WP-08 -> WP-16 (instead of WP-05 -> WP-12 -> WP-13) and WP-57 -> WP-69 -> WP-78
(instead of WP-71). Near-critical chains (one wave shorter): ingestion WP-26 -> WP-28 -> WP-32 -> WP-34 -> WP-35 -> WP-39, and UI WP-44 ->
WP-46 -> WP-47 -> WP-50 -> WP-52 -> WP-56. Most critical WPs are L or opus-xhigh work (WP-03, WP-07, WP-13, WP-16, WP-17, WP-30, WP-36,
WP-57, WP-69): the lead starts them as soon as their inputs are verified and gives their verifiers priority. WP-45's link to WP-44 is
soft (it may start in parallel; only its gate waits for `tokens.css`).

## 8. Work-package catalogue

Block format: header line = phase, earliest wave, size, implementer, verifier. Goal (2 sentences). Inputs (design sections to read).
Creates (exact files; the implementer may add private helper modules only inside the folders named here). Blocks (marked blocks it owns in
shared files, plan section 4.2; `pkg:` = package.json keys, plan section 4.3). Produces / Consumes (registry names, 98). Depends. Tests (design ids). Gate
(macros of plan section 5; `STD` always included). Verifier (checks beyond the tests). Cut line (L WPs only: what moves to a follow-up WP if the
session runs short; the lead then creates `WP-xxb` with the same deps).

### Phase 2: foundation

#### WP-01 Monorepo scaffold and gates
Phase 2, W2.1, L; impl sonnet medium; verify sonnet high; 05 S1 (files)
- Goal: Create the npm workspace exactly as 05 Appendix A, with the lockfile, so every later WP has working format, lint, typecheck,
  test, build and ci gates. Seed every shared file it creates with the empty marked blocks of plan section 4.2.
- Inputs: 05 2.1-2.9, section 3.1-3.3, section 4.1, section 4.5, section 8.1, Appendix A.1-A.27, A.29-A.38, A.40; 04 section 8 (web lint rules); 06 section 4 (`PLATFORM_ENTRY`);
  98 section 13; 99 I-14, I-34, N-02, C54.
- Creates: `package.json`, `package-lock.json`, `.npmrc`, `.editorconfig`, `.prettierrc.json`, `.prettierignore`, `tsconfig.base.json`,
  `tsconfig.check.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts` (projects `unit`, `web`, `integration`, `isolation`,
  `resilience`, `parity`, `tooling`), `packages/{shared,engine,server,cli,testkit,web}/package.json`, `packages/*/tsconfig.json`,
  `packages/*/tsconfig.build.json` (none for web), `packages/web/{vitest.config.ts,vite.config.ts}` (A.26, A.27 stubs),
  `packages/web/e2e/tsconfig.json` (A.29), stubs `packages/{shared,engine,server,testkit}/src/index.ts`, `packages/shared/src/protocol/index.ts`,
  `packages/cli/src/{main,hook}.ts`, `packages/web/src/main.tsx`, `scripts/{lib,clean,typecheck,check-deps,build-stamp,ci,smoke,dev,set-version}.mjs`,
  `tests/tsconfig.json`; `<skill>/.gitignore` (append 05 2.9 lines only). Not A.28 (withdrawn), A.39 (WP-08), A.41 (WP-23).
- Blocks: creates the files marked "WP-01" in plan section 4.2 with all their empty blocks. `pkg:` every A.1 script plus `test:tooling`.
- Produces: npm scripts of 98 section 13 (baseline), condition `@mcs/source`, `computeStamps`, `staleness`, `STAMP_SCHEMA_VERSION` (05 3.3.3),
  smoke exit 77 convention. Consumes: nothing.
- Depends: LS-0. Holds the `npm` lock (granted by the lead) for `npm install` (lockfile creation) and `npm ci --offline`.
- Tests: none new (stubs only); the gates themselves are the proof.
- Gate: `cd $R && npm ci --offline && node scripts/build-stamp.mjs write-install` (under `npm`), then under `run`: `npm run format:check`,
  `npm run lint`, `npm run typecheck`, `npm run check:deps`, `npm test`, `npm run build`, `node scripts/smoke.mjs` (expect exit 77),
  `node scripts/ci.mjs --offline` (exit 0, smoke `SKIPPED (exit 77)`), `node scripts/ci.mjs --offline --strict` (expect exit 1); `END`.
- Verifier: byte-compare every file with its Appendix A text (only the listed stubs differ); pins equal 05 2.2; Node floor
  `^22.22.0 || ^24.0.0 || >=26.0.0`; `better-sqlite3` allowed only in `src/db/driver.ts`; `PLATFORM_ENTRY` and 04 section 8 web rules present;
  smoke port range 18800-18849 and CLI-driven (N-02); no `webServer`, no `MCS_E2E_PORT`; marker pairs exactly as plan section 4.2.
- Cut line: none (verbatim transfer; do not split).

#### WP-24 Golden generator (Python oracle)
Phase 2, W2.1, M; impl sonnet high; verify opus xhigh; 06 PP2
- Goal: Build the frozen-clock capture tool that serves the legacy engine in process and writes raw legacy responses, CLI outputs, tree
  manifests and L1 vectors. Produce the first goldens and prove two captures are byte-identical.
- Inputs: 06 5.1, section 5.2.1-5.2.6, section 5.8, section 6.3 (scenario names); 05 4.11.4; ADR 0053, 0055; 99 I-09.
- Creates: `<skill>/tests/legacy-parity/README.md`, `<skill>/tests/legacy-parity/tools/{capture_golden,determinism,vectors,panel_scenarios}.py`,
  `<skill>/tests/legacy-parity/golden/**` (generated; the lead commits it separately).
- Blocks: none. Produces: golden layout `golden/{meta.json,trees,api,cli,vectors}`, `--check` drift mode, vector files `splitlines`,
  `tail`, `strptime`, `pydumps`, `slug`, `merge_provenance`, `audit_entry`, `json_atomic`, `external_state`, `classify_state`,
  `classify_rules`, `events_of`, `clip`. Consumes: legacy `src/` read-only.
- Depends: LS-0.
- Tests: 06 PP2 done-when (two captures, `--check` clean, tree clean, no `__pycache__`, temp removed).
- Gate: `PY "tests/legacy-parity/tools/capture_golden.py --out D:/mvp/private/scratch/mcs-v3/g1"`, `PY "tests/legacy-parity/tools/capture_golden.py --out tests/legacy-parity/golden"`,
  `PY "tests/legacy-parity/tools/capture_golden.py --check"`; `find $S -name __pycache__` prints nothing; ports 18850-18855 closed; `END`.
- Verifier: no real transcript or home path read (`CLAUDE_CONFIG_DIR` temp); frozen clock and seeded ids; nothing written outside the
  output folder; legacy code imported, never patched on disk; every vector file named by 06 PP4 and plan section 10 of this plan exists.

#### WP-02 Shared contracts: ids, time, files, runtime config sections, CLI results, control protocol
Phase 2, W2.2, L; impl sonnet high; verify sonnet high; 01 S1
- Goal: Transcribe the cross-package contracts owned by 01 into zod schemas and types in `@mcs/shared`, including every `runtime.json`
  section from the owners' normative tables. Make the registry contract tests for R keys and env vars executable.
- Inputs: 01 1.3-1.9, section 1.6 (with 02 1.2, section 7.8, section 7.11; 03 3.8, section 8.3, section 10.1; 06 3.5, section 3.10.3), section 2.6, section 2.10, section 3.1, section 4.3, section 4.4a
  (`time.ts`), section 6.2, section 6.4 (`ConfigInspection`); 98 1.8, section 6.2, section 6.3, section 7.2, C01, C02, C19, C27; 99 I-01, I-20, I-27, I-36, N-03, N-04.
- Creates: `packages/shared/src/{ids,errors,version,time,env}.ts`, `packages/shared/src/files/{instance,state,backup-manifest}.ts`,
  `packages/shared/src/config/runtime/{section,index,server,process,logging,backup,lifecycle,hooks,ingest,import,spool,health,analytics,board,panelOptions,retention,alerts,pricing}.ts`,
  `packages/shared/src/cli/{envelope,results}.ts`, `packages/shared/src/protocol/control.ts`; tests `packages/shared/src/{ids,version,env,time}.test.ts`,
  `packages/shared/src/config/runtime/{runtime-sections.contract,derived-defaults}.test.ts`, `packages/shared/src/cli/envelope.test.ts`.
- Blocks: `shared/src/index.ts` WP-02, `shared/src/protocol/index.ts` WP-02; creates `cli/results.ts` with blocks WP-37, 61, 62, 64.
- Produces: `RUNTIME_VERSION`, `Clock`, `systemClock`, `isoSecondsZ`, `isoMsZ`, slug rules, `CliErrorCode`, `McsError`, `InstanceFileSchema`,
  `StateFileSchema`, `BackupManifestSchema`, `RuntimeFileSchema`, `RuntimeOverridesSchema`, `R_TOP_KEYS`, `R_KEY_CATALOGUE`,
  `R_DERIVED_DEFAULTS`, `DOCUMENTED_ENV_VARS`, `CliEnvelope`, `CliError`, `ConfigInspection`, `toConfigInspection`, `ConfigFileStatus`,
  control ops (incl. `ingest-replay` with `fromSegment`). Consumes: zod only.
- Depends: WP-01.
- Tests: 01 S1 done-when (`runtime-sections.contract.test.ts` incl. 9 `import` keys and rejection of `import.maxLineBytes`,
  `derived-defaults.test.ts`, slug rules, `R_TOP_KEYS` disjoint from L keys, `RUNTIME_VERSION` = package version, env list).
- Gate: `STD(shared)` + `UNIT packages/shared/src/ids.test.ts packages/shared/src/version.test.ts packages/shared/src/env.test.ts packages/shared/src/time.test.ts packages/shared/src/config packages/shared/src/cli`.
- Verifier: every R key's type, range and default equals the owner table cited in 01 1.6 (02 keys from 02 1.2, N-04;
  `hooks.spoolWhileStoppedHours` min 0); no `import.maxLineBytes`; `CliErrorCode` name (C19); `Clock` only in `time.ts`; no `node:*` in
  shared; `MCS_E2E_PORT` absent from `DOCUMENTED_ENV_VARS`; `ConfigInspection.entries[].source` naming.
- Cut line: `cli/{envelope,results}.ts` + `protocol/control.ts` move to WP-02b (deps WP-02) if needed.

#### WP-04 Hook protocol contracts
Phase 2, W2.2, M; impl sonnet high; verify fable; 02 I-1
- Goal: Implement the zod-free protocol shared by the hook handler and the engine: envelope v1, caps, segment names, id regexes, event
  policy, sanitize/redact/clip, routes and `MCS_HOME` resolution. Add the zod ingest schemas next to it.
- Inputs: 02 1.1, section 2.3 (2.3.1-2.3.4), section 2.4, section 2.5, section 2.6, section 2.7 (names), section 4.2; 98 1.7, section 10.1, N2, N8; 99 I-02, I-26, I-32; ADR 0010-0013.
- Creates: `packages/shared/src/protocol/{hook-envelope,hook-events,sanitize,routes,stamp,limits}.ts`, `packages/shared/src/schemas/ingest.ts`;
  tests `packages/shared/src/protocol/{hook-envelope,sanitize,routes}.test.ts`, `packages/shared/src/schemas/ingest.test.ts`.
- Blocks: `shared/src/protocol/index.ts` WP-04, `shared/src/index.ts` WP-04 (`schemas/ingest`).
- Produces: `HookEnvelopeV1`, `HOOK_ENVELOPE_VERSION`, `HANDLER_VERSION`, `SPOOL_SEGMENT_EXT` (`.ndjson`), `SPOOL_SEGMENT_RE`,
  `spoolSegmentName`, `SID_RE`, `AGENT_RE`, `RUN_ID_RE`, `TOOL_ID_RE`, `MAX_LINE_BYTES`, `HOOK_EVENT_POLICY`, `INSTALLED_HOOK_EVENTS` (21),
  `ASYNC_HOOK_EVENTS`, `HOOK_EVENT_RANK`, `clip`, `summarizeToolInput`, `redact`, `canonicalJsonHash`, `normalizePath`, `HookRouteV1`,
  `matchRoutes`, `resolveMcsHome`, `Stamp`, `compareStamp`, `HookEnvelopeV1Schema`, `HookRouteV1Schema`, `TranscriptRecordShape`,
  `IngestHealthSchema`. Consumes: nothing (protocol), zod (schemas).
- Depends: WP-01.
- Tests: T-HK-04, T-HK-05 (unit part), T-HK-16 (unit part), clip and `pyJsonDumps` goldens, id regex tables.
- Gate: `STD(shared)` + `UNIT packages/shared/src/protocol packages/shared/src/schemas`.
- Verifier: `protocol/**` imports only `./` (lint) and no `node:*`; redaction never touches ids; `.ndjson` only (I-02); `RUN_ID_RE` equals
  02's pattern (I-26); 21 installed events; caps equal 98 10.1; adversarial probes: secrets in nested tool input, long unicode, surrogates.

#### WP-03 Shared API and panel contracts
Phase 2, W2.3, L; impl sonnet high; verify opus xhigh; 03 S3, 06 PP0
- Goal: Write every API, stream, export and panel contract as zod schemas with inferred types, plus the route registry that the server,
  the web client and the schema generator share. This WP is the contract hub; nothing downstream redeclares these shapes.
- Inputs: 03 5.1-5.5, section 6.1-6.3, section 7.3-7.4 (shapes), section 8.1-8.4 (shapes), section 9.2, section 10.3, section 11.1, section 13; 06 3.3; 04 section 13 (consumer view);
  98 1.1-1.6, section 3, section 4, section 7.1, C10, C17, C26, C36, C51, C52; 99 I-04, I-10, I-21, I-30, I-35, I-37.
- Creates: `packages/shared/src/api/{ids,time,errors,filters,cursor,entities,health,legacy-health,stream,export,routes,panels}.ts`;
  tests `packages/shared/src/api/{routes,filters,cursor,panels,entities}.test.ts`.
- Blocks: `shared/src/index.ts` WP-03; creates `api/routes.ts` with block WP-29.
- Produces: `ErrorCode`, `ErrorEnvelope`, `Page`, cursor codec, filter model (`fromQuery`, `toQuery`, `matchesEventFilter`), `EVENT_KINDS`,
  `LIFECYCLE_STATES`, `BOARD_STATES`, `LegacyState`, `SessionSummary`, `SessionDetail`, `AgentNode`, `ActivityEvent`, `ToolCallItem`,
  `TransitionItem`, `WorkItem`, `WorkItemBoard`, `EvidenceItem`, `HealthReport` (incl. `runtime` resources, `children`, `panels`),
  `InstanceInfo` (poll mapping C26), `ErrorItem`, `LegacyHealth` (13 keys), `IngestHealth` reference, `StreamChange` and frames, export
  line schemas, `defineRoute` and every 6.1 route except `explainCompletion`, `PanelKey`, `PanelResponse`, `PanelResponseSchema`,
  `ChildKind` (incl. `node`, `taskkill`, `opener`), `ChildKindStats`, `PanelStats`. Consumes: WP-02 `ConfigInspection`.
- Depends: WP-02.
- Tests: DA-T-API-7 (unit part), 03 S3 done-when (`routes.test.ts`, `filters.test.ts`, `cursor.test.ts`), 06 PP0 done-when
  (`panels.test.ts`); DA-T-API-2 round trip is WP-23's.
- Gate: `STD(shared)` + `UNIT packages/shared/src/api`.
- Verifier: every 6.1 row present with exact query bounds and error codes; work-item names (I-10), `cursor_invalid` 400, `ChildKindStats`
  (C10), `HealthReport` in `api/health.ts` (C51), `LegacyHealth` key set = 03 6.2; no hand-written type that duplicates a schema;
  `LegacyState` declared once (C36).
- Cut line: `api/{stream,export,panels}.ts` move to WP-03b.

#### WP-05 Python compatibility: PyJson and regex translator
Phase 2, W2.3, L; impl sonnet high; verify fable; 01 S2, 01 S3
- Goal: Implement Python-compatible JSON writing (byte-compatible shared workspace files) and the Python-regex to JS translator that
  accepts only exact translations. Ship both with their golden generators and golden tests.
- Inputs: 01 1.9 (ADR 0003), section 2.8 (ADR 0002); foundations D5; 98 1.9, section 2.1, C24; 99 N-07.
- Creates: `packages/engine/src/pyjson/*` (modules per 01 1.9) + colocated tests, `packages/shared/src/pyregex/*` + colocated tests,
  `tests/parity/{pyjson,pyregex}.golden.test.ts`, `<skill>/tests/legacy-parity/pyjson/*` (generator + golden JSON),
  `<skill>/tests/legacy-parity/regex/{gen_regex_golden.py,regex-golden.json,regex-rejects.json}`.
- Blocks: `shared/src/index.ts` WP-05, `engine/src/index.ts` WP-05.
- Produces: PyJson serializer and `writePyJsonFile` primitive (01 1.9 names), `compilePyRegex(source, ctx)`, `applyLabelTemplate`,
  `REGEX_UNSUPPORTED`. Consumes: WP-02 `McsError`, `CliErrorCode`.
- Depends: WP-02.
- Tests: E6 golden 0 mismatches, round-trip property tests, regex goldens and rejects (01 2.8), V9 replica (synthetic) and the opt-in
  live check (reads the live task config read-only, prints only pass/fail counts).
- Gate: `STD(shared, engine, tests)` + `UNIT packages/shared/src/pyregex packages/engine/src/pyjson` + `PAR tests/parity/pyjson.golden.test.ts tests/parity/pyregex.golden.test.ts`
  + regenerate both goldens with `PY` into scratch and `diff -r` against the committed ones.
- Verifier: number formatting and `ensure_ascii`/indent behaviour byte-equal; translator rejects every unsupported construct loudly (`\Z`,
  `$`, inline flags, Unicode classes probed adversarially); no V9 slug, path, label or regex text committed (memory rule: the skill repo
  holds tools only); generators write only inside their folders.
- Cut line: PyJson (with its golden test) lands as WP-05; the translator moves to WP-05b (deps WP-02).

#### WP-06 Testkit core and fixtures
Phase 2, W2.3, L; impl sonnet high; verify sonnet high; 05 S2, 05 S3
- Goal: Build the dev-only fixture library: temp dirs, ports, waits, fake clock, tracked processes, isolation helpers, HTTP/SSE helpers,
  canaries, transcript and Claude-home builders, hook payloads, workspaces and the demo builder of 04 11.5. Every artefact is synthetic
  and labelled `FIXTURE`.
- Inputs: 05 4.4, section 4.5, section 4.6, Appendix A.40; 04 11.5; 01 3.5 (helpers); 02 9.1; research transcript survey section 8 (25 shapes);
  98 12.1, C32, C33, C34; 99 I-26.
- Creates: `packages/testkit/src/{temp,ports,wait,clock,processes,isolation,http,canary,transcript,claude-home,hooks,workspace,demo}.ts`
  + colocated tests.
- Blocks: `testkit/src/index.ts` WP-06.
- Produces: `makeTempDir`, `useTempDirs`, `VITEST_PORTS`, `allocatePort`, `assertPortClosed`, `waitFor`, `eventLoopLagProbe`, `FakeClock`,
  `FIXTURE_EPOCH_MS`, `spawnTracked`, `killAllTracked`, `runCli`, `hermeticEnv`, `startInstance`, `spawnImpostor`, `makeJunction`,
  `httpRequest`, `readSse`, `CANARY`, `scanForCanaries`, `TranscriptBuilder`, `bigTranscript`, `buildClaudeHome`, `HookEventName`,
  `hookPayload`, `runHookHandler`, `buildRepo`, `buildTaskWorkspace`, `snapshotTree`, `buildDemo`. Consumes: WP-02, WP-04.
- Depends: WP-02, WP-04.
- Tests: 05 S2 and S3 done-when, except "runHookHandler writes one spool line", which needs the handler and is part of WP-25's gate, and
  `startInstance`, exercised by WP-20.
- Gate: `STD(testkit)` + `UNIT packages/testkit/src`.
- Verifier: every user-content string starts with `FIXTURE`; temp roots contain `FIXTURE.md`; the real `~/.claude` is never read;
  `DemoOptions = {root, nowMs, letters?, project?}` (C34); `runHookHandler` spawns `<skill>/scripts/mcs-hook.mjs` by default and
  `dist/hook.js` with `direct` (I-26); no `findFreePort` (C32); port blocks non-overlapping with 4 forks.
- Cut line: `demo.ts` + `claude-home.ts` move to WP-06b (deps WP-06).

#### WP-07 Platform layer, mutex and markers
Phase 2, W2.4, L; impl opus xhigh; verify fable; 06 PP1, 01 S4
- Goal: Implement the only place that spawns children, inspects or kills processes, branches on the platform and replaces files
  atomically, plus the OS-released mutex and the runtime markers. Every later process and file operation goes through it.
- Inputs: 06 3.6, section 3.9.1, section 3.9.4, section 3.10.4, section 4 (4.1-4.11); 01 4.2, section 4.15, section 5.1 (launcher copies); 05 5.3 (S-PROC 1-5), section 5.7 (exec cases);
  ADR 0006, 0050, 0051, 0052, 0058; 98 2.3, C11, C12, C13, C14, C47, C48; 99 I-06, I-28, I-34.
- Creates: `packages/engine/src/platform/{exec,process,fsx,host,paths,glob,pytime,watch-hint,mutex,markers}.ts` + colocated tests
  (`exec`, `process`, `fsx`, `paths`, `glob`, `pytime`, `watch-hint`, `mutex`, `markers`, `platform-branching`),
  `packages/engine/test/platform/{fsx,hidden-console,mutex}.int.test.ts`.
- Blocks: `engine/src/index.ts` WP-07.
- Produces: `execFileText` (`ChildSpec`/`ChildResult`), `resolveExecutable`, `childStats`, `spawnDetached`, `spawnForeground`, `pidAlive`,
  `commandLineOf`, `forceKill`, `waitForExit`, `atomicWriteFile`, `readSmallFile`, `tailLines`, `pySplitlines`, `clipCodePoints`,
  `hostPlatform`, `pathsCaseInsensitive`, `canonicalPath`, `samePath`, `toPosixRel`, `globFiles`, `pyStrptime`, `toEpochMs`,
  `createWatchHint`, `acquireMutex`, `tryAcquireMutex`, `mutexName`, marker helpers, `listRuntimeProcesses`. Consumes: WP-03 `ChildKind`,
  `ChildKindStats`.
- Depends: WP-02, WP-03.
- Tests: 06 3.11 exec/glob/pytime rows and 06 4.11 rows; 05 5.7 exec cases; 01 S4 done-when (E10 contention, `mutexName` table, marker
  table, `listRuntimeProcesses` finds a spawned marker process and not an impostor, T-LC-16). Golden-vector comparison of
  `splitlines`/`tail`/`strptime` is WP-43's.
- Gate: `STD(engine)` + `UNIT packages/engine/src/platform` + `INT packages/engine/test/platform`.
- Verifier: no `shell: true`, no `.cmd`, `windowsHide: true` on every spawn; `forceKill` = `taskkill /PID n /F` via kind `taskkill`
  (C12); `listRuntimeProcesses` in `markers.ts` (C13); kind `opener` (C11); PowerShell `-EncodedCommand`; atomic replace budget 3000 ms
  (I-28); `process.platform` only under `platform/**`; adversarial: kill a pid whose command line lacks the marker, hold a file open
  during replace, spawn argv with quotes and metacharacters.
- Cut line: `glob.ts`, `pytime.ts`, `watch-hint.ts` move to WP-07b.

#### WP-09 DB core
Phase 2, W2.4, L; impl opus xhigh; verify fable; 03 S1
- Goal: Write migration `0001_initial.sql`, the single SQLite driver module, the migration runner with checksums and backup gating, the
  identity-checked open, the only write-transaction entry point and the change recorder. Freeze `0001` with its checksum at commit.
- Inputs: 03 3.1-3.5, section 4.1-4.5, section 9.1 (`ChangeRecorder`), section 11.2, section 18 (X1, X12, X14), section 22 O-2, O-3; ADR 0020-0022, 0025;
  98 2.6, section 5, section 7.4, C53; 99 I-03, I-07, I-14, I-32.
- Creates: `packages/engine/migrations/0001_initial.sql`, `packages/engine/src/db/{driver,errors,open,migrations,backup,write,changes}.ts`,
  `packages/shared/src/db-constants.ts`; tests `packages/engine/src/db/{driver,migrations,write,changes}.test.ts`,
  `packages/engine/test/db-{migrations,open,constraints,backup}.int.test.ts`; fixtures `packages/engine/test/fixtures/db/{schema.snapshot.sql,v1.db}`.
- Blocks: `engine/src/index.ts` WP-09, `shared/src/index.ts` WP-09.
- Produces: `SqlDriver`, `openSqlite`, `toDbError`, `DbError`, `DbErrorCode`, `openInstanceDb`, `InstanceDb`, `RepoContext`, `OpenMode`,
  `DB_OPEN_EXIT_CODES`, `migrationStatus`, `planDbMigrations`, `migrateDb`, `peekDbSchemaVersion`, `backupDb`, `withWriteTx`,
  `onCommitted`, `WriteTx`, `ChangeRecorder`; the tables, indexes and CHECKs of 98 5. Consumes: WP-03 enums, WP-04 `MAX_LINE_BYTES`, WP-02.
- Depends: WP-02, WP-03, WP-04.
- Tests: DA-T-DB-1..8, 15..18, the X14 probes of DA-T-DB-20, DA-T-E-3; O-3 (compile `backupTo`, local augmentation if needed), O-2 noted.
- Gate: `STD(engine, shared)` + `UNIT packages/engine/src/db` + `INT packages/engine/test/db-migrations.int.test.ts packages/engine/test/db-open.int.test.ts packages/engine/test/db-constraints.int.test.ts packages/engine/test/db-backup.int.test.ts`;
  the final answer states the LF-normalised sha256 of `0001_initial.sql`.
- Verifier: DDL equals 03 3.5 text (diff); single `events` table and attempts tables (I-03, I-07); `spool_cursors.segment GLOB '*.ndjson'`;
  no per-row `instance_id`; `withWriteTx(db, ctx, fn)` synchronous with the no-`await` lint rule; only `driver.ts` imports `better-sqlite3`;
  no `iterate()`; migrations resolved next to `dist/`; adversarial: four processes open a new file at once, BUSY storms, a flipped byte.
- Cut line: `backup.ts` + DA-T-E-3 move to WP-09b.

#### WP-12 Config resolution
Phase 2, W2.4, M; impl sonnet high; verify opus xhigh; 01 S5
- Goal: Resolve the effective configuration from built-in, skill, instance, env and CLI layers with the legacy merge rule, legacy-exact
  validation messages and per-key provenance. Add the explicit config migrations registry.
- Inputs: 01 1.4, section 2.1-2.7, section 2.10; `<skill>/config/defaults.json` (read-only input); ADR 0002; 98 6.1, section 6.2, C42; 99 N-05, N-06.
- Creates: `packages/engine/src/config/{defaults,merge,validate-legacy,resolve,provenance,migrations}.ts` + colocated tests;
  `<skill>/runtime/defaults.json` (`{"schema_version": 1}`).
- Blocks: `engine/src/index.ts` WP-12.
- Produces: `resolveConfig`, `ResolvedConfig`, provenance tags `builtin|skill|config|runtime|env|cli`, legacy validation, config
  migration steps. Consumes: WP-02 sections, WP-05 `compilePyRegex`.
- Depends: WP-02, WP-05.
- Tests: 01 S5 done-when (2.x unit tests, legacy validation message goldens, C-3 merge tests, derived defaults).
- Gate: `STD(engine)` + `UNIT packages/engine/src/config`.
- Verifier: precedence D4 with env only for documented variables between layers 3 and 4; per-sub-key merge only for `panels|ui|poll|limits`;
  legacy defaults never written; Node refuses flat configs (N-05); `CONFIG_INVALID` messages of N-06 for `attempts.time_format` and MSYS paths.

#### WP-23 Tooling tests, JSON Schema generator, inactive CI
Phase 2, W2.4, M; impl sonnet high; verify sonnet high; 05 S1 (tests), 05 S5, 01 S16 + 03 S3 (generator)
- Goal: Turn the scaffold's probe tables into regression tests (lint rules, check-deps, stamps, ci script, env-var allow-list) and build
  the one JSON Schema generator for config, CLI and API schemas with a drift check. Ship the inactive GitHub workflow.
- Inputs: 05 2.5, section 2.6 (probes E6/E7/E18/E20/E24, F-7), section 3.2, section 3.3, section 4.3, section 8.1, section 8.2, A.41; 01 2.9, section 2.10; 03 section 13; 98 C45; 99 I-27.
- Creates: `tests/tooling/{lint-rules,check-deps,build-stamp,ci-script,env-vars,schemas-drift}.test.ts`, `tests/tooling/probe.tsconfig.json`
  (only when the F-7 fallback is needed), `scripts/gen-schemas.mjs`, `ci/github-actions-ci.yml`; generated `<skill>/schemas/**` and
  `<skill>/docs/api/reference.md`.
- Blocks: `pkg:` `schemas`, `schemas:check`.
- Produces: `npm run schemas`, `npm run schemas:check`, JSON Schemas with the `$id` prefix of 98 9.3. Consumes: WP-02, WP-03 schemas.
- Depends: WP-01, WP-02, WP-03.
- Tests: 05 S1 tooling tests; DA-T-API-2; `env-vars.test.ts` (every `MCS_*` read under `packages/*/src` and `scripts/` is in
  `DOCUMENTED_ENV_VARS` and every listed name is read, I-27); YAML parses and its gate names match `ci.mjs`.
- Gate: `STD(tests)` + `TOOL tests/tooling` + `cd $R && npm run schemas:check`.
- Verifier: probes assert exact rule ids and are deleted in `finally`; generated files carry the "generated; do not edit" marker;
  workflow actions SHA-pinned and inactive; the env test is a real grep, not a fixed list.

#### WP-08 Security primitives
Phase 2, W2.5, M; impl opus xhigh; verify fable; 05 S6
- Goal: Implement path containment, the allow-listed JSON logger with rotation, terminal-safe CLI output and the HTTP guards. Every
  server, CLI and engine module uses these four instead of its own variant.
- Inputs: 05 5.1-5.3 (S-NET, S-FS, S-OUT, S-LOG incl. S-LOG-6, S-PROC), section 5.6, section 5.7, A.39; 03 5.1 (headers), section 5.2 (codes); ADR 0045,
  0046, 0058; 98 C35; 99 I-04, I-25, I-31.
- Creates: `packages/engine/src/security/paths.ts`, `packages/engine/src/log/logger.ts`, `packages/cli/src/io/terminal.ts`,
  `packages/server/src/http/guards.ts`; tests `packages/engine/src/security/paths.test.ts`, `packages/engine/src/log/logger.test.ts`,
  `packages/cli/src/io/terminal.test.ts`, `packages/server/src/http/guards.test.ts`.
- Blocks: `engine/src/index.ts` WP-08.
- Produces: `resolveContained`, re-exports of `SID_RE`/`AGENT_RE`/`RUN_ID_RE`, `Logger`, `createLogger`, `LOG_ROTATE_BYTES`, `LOG_KEEP`,
  terminal escaping and `safeJsonStringify` (A.39), Host/Origin/`Sec-Fetch-Site`/JSON+custom-header guards. Consumes: WP-03 `ErrorCode`,
  WP-04 regexes, WP-07 replace retry.
- Depends: WP-03, WP-04, WP-07.
- Tests: 05 5.7; SEC-05 and SEC-31 unit rows.
- Gate: `STD(engine, cli, server)` + `UNIT packages/engine/src/security packages/engine/src/log packages/cli/src/io packages/server/src/http`.
- Verifier: Host allow-list exactly `127.0.0.1:<port>` and `localhost:<port>`; Origin list exactly two (I-31); no CORS header; logger
  drops non-allow-listed fields, never logs query text, tokens or `SyntaxError` messages; terminal escapes C0, C1, DEL, bidi,
  U+2028/U+2029; rotation 10 MiB x 5; codes only from `ErrorCode`; adversarial: Host case and port tricks, `null` Origin, junction escapes.

#### WP-10 Write-path repositories and change sink
Phase 2, W2.5, L; impl opus xhigh; verify fable; 03 S2 (part)
- Goal: Implement the repositories on the ingestion write path (events, tool calls, turns, usage two-level rows, transcript files,
  checkpoints) with natural-key idempotency, and the change sink that maps ingestion entities to change kinds with coalescing.
- Inputs: 03 3.6, section 3.7, section 4.5, section 9.1; 02 4.1.1, section 4.6, section 6.2-6.4; ADR 0017, 0024, 0025; 98 2.6, section 5.4, C59.
- Creates: `packages/engine/src/db/repos/{events,tool-calls,turns,usage,transcript-files,checkpoints}.ts`, `packages/engine/src/db/change-sink.ts`
  + colocated tests (`*.test.ts` for each).
- Blocks: none (repositories are engine-internal; server and CLI never import them).
- Produces: `EventsRepo`, `ToolCallsRepo`, `TurnsRepo`, `UsageRepo` (`applyRecord`, rollups), `TranscriptFilesRepo`, `CheckpointsRepo`,
  `createChangeSink`, `ChangeSink`. Consumes: WP-09.
- Depends: WP-09.
- Tests: DA-T-DB-9, 10, 11, 12, 13; DA-T-RT-7, 11; DA-T-PRIV-3.
- Gate: `STD(engine)` + `UNIT packages/engine/src/db/repos/events.test.ts packages/engine/src/db/repos/tool-calls.test.ts packages/engine/src/db/repos/turns.test.ts packages/engine/src/db/repos/usage.test.ts packages/engine/src/db/repos/transcript-files.test.ts packages/engine/src/db/repos/checkpoints.test.ts packages/engine/src/db/change-sink.test.ts`.
- Verifier: every public method takes `ctx` first and asserts scope; SQL only, no rules; natural keys of 98 5.4; per-field max and
  owner by `birth_ms`; seeded permutation tests print seeds; `event -> event/append` (C59); adversarial: 200 shuffled orders, resume copies.
- Cut line: `transcript-files.ts` + `checkpoints.ts` move to WP-10b.

#### WP-11 Entity and operations repositories
Phase 2, W2.5, L; impl sonnet high; verify opus xhigh; 03 S2 (part)
- Goal: Implement the remaining 17 repositories as SQL-only classes scoped by `RepoContext`, including the attempts repository and the
  view writer that records state transitions. Each repository has its own unit test against an in-memory or temp DB.
- Inputs: 03 3.6, section 4.5, section 9.1 (`attempt/upsert`); 06 3.10.2 (via 03); 98 2.6, C40, C52, C56; 99 N-10.
- Creates: `packages/engine/src/db/repos/{meta,projects,sessions,agents,workflow-runs,transitions,reconciliations,external-observations,cost-states,hook-probes,work-items,ingest-health,ingest-errors,spool-cursors,attempts,alerts,changes}.ts`
  + colocated tests.
- Blocks: none.
- Produces: `MetaRepo`, `ProjectsRepo`, `SessionsRepo` (`ensure`, `attemptCandidates`, `uidsByRowIds`, `completionCandidates`), `AgentsRepo`,
  `WorkflowRunsRepo`, `TransitionsRepo`, `ReconciliationsRepo`, `ExternalObservationsRepo`, `CostStatesRepo`, `HookProbesRepo`,
  `WorkItemsRepo`, `IngestHealthRepo`, `IngestErrorsRepo`, `SpoolCursorsRepo`, `AttemptsRepo` (`runsByPart`, `insertRun`, `endRun`,
  `supersedeRun`, `setMatch`, `resetSource`), `AlertsRepo`, `ChangesRepo`. Consumes: WP-09.
- Depends: WP-09.
- Tests: DA-T-DB-19, DA-T-DB-20, DA-T-RT-13.
- Gate: `STD(engine)` + `UNIT` over the 17 test files of this WP.
- Verifier: agent kinds `main subagent workflow_agent teammate internal` (C56); work-item source spelling (C52); attempts soft refs and
  `attempt/upsert` reserved by `AttemptsRepo` (C40, N-10); `writeView` records nothing for unchanged views.
- Cut line: the nine operations repositories (`cost-states` .. `changes`) move to WP-11b.

#### WP-13 Workspace and audit
Phase 2, W2.5, L; impl opus xhigh; verify fable; 01 S6
- Goal: Implement workspace resolution, atomic and Python-compatible file writes, the init transaction with adoption and partial-init
  cleanup, listing, identity repair and snapshots, plus the legacy-compatible audit writer and reader with `entriesBetween`.
- Inputs: 01 1.1-1.8, section 3.1-3.4, section 4.12, section 7.1-7.3, section 8.2; ADR 0001, 0058; 98 2.1, section 9.1, C14, C39; 99 I-19, I-28.
- Creates: `packages/engine/src/workspace/{fsio,paths,init,adopt,list,repair,snapshot}.ts`, `packages/engine/src/audit/{writer,reader}.ts`
  + colocated tests; `packages/engine/test/workspace-init.int.test.ts` (T-LC-10, 11, 12 at engine level, plan-assigned name),
  `packages/engine/test/audit-concurrency.int.test.ts` (T-AU-03, plan-assigned), fixture `packages/engine/test/fixtures/legacy-workspace/**`
  (made once with `$V init-task` on a temp repo, synthetic names).
- Blocks: `engine/src/index.ts` WP-13.
- Produces: `writeWorkspaceFile`, `readTextUniversal`, `writePyJsonFile`, `resolveWorkspace`, `WorkspaceRef`, init/adopt/list/repair
  functions, `RUNTIME_MUTABLE_PATHS`, workspace snapshot, `appendChange`, `appendDecision`, `lastChange`, `recentAudit`,
  `entriesBetween`, `AuditRef`. Consumes: WP-05, WP-07 (`fsx`, mutex), WP-12, WP-02.
- Depends: WP-05, WP-07, WP-12.
- Tests: T-LC-10, 11, 12; T-AU-02..06 (T-AU-01 parity part is WP-15's); T-ISO-01, 02, 07 (unit rows); E5 retry cases through
  `writeWorkspaceFile`; T-ISO-21 helper (its test file is WP-20's).
- Gate: `STD(engine)` + `UNIT packages/engine/src/workspace packages/engine/src/audit` + `INT packages/engine/test/workspace-init.int.test.ts packages/engine/test/audit-concurrency.int.test.ts`.
- Verifier: Node-only data never in `config.json`; shared files written through PyJson; audit header `## <UTC> | <action>` byte-compatible;
  `entriesBetween` async with ISO `at` (I-19); `data/exports/` in the tree (C39); the task mutex spans read-validate-write-audit;
  adversarial: crash between staging and rename, four concurrent inits, newline injection in reasons.
- Cut line: `audit/{writer,reader}.ts` + T-AU tests move to WP-13b.

#### WP-14 Engine ops: workspace, config, audit
Phase 2, W2.6, M; impl sonnet high; verify opus xhigh; 01 S7 (ops part)
- Goal: Implement the engine operations behind `discover`, `init`, `inspect`, `configure`, `decide`, `audit` and `check`, with typed
  results and `ConfigInspection` as a pure projection of `inspect`. The CLI and the server call these functions only.
- Inputs: 01 6.1 (`OpContext`, INV-12), section 6.3 rows, section 6.4 (discover, init, inspect, configure, decide, audit, check), section 7.2, section 3.5
  (T-ISO-07); ADR 0008; 98 2.1, section 8.
- Creates: `packages/engine/src/ops/{workspace,config,audit}.ts` (with `OpContext` where 01 6.1 places it) + colocated tests
  `ops/{config,audit}.test.ts`, `ops/config-inspection.test.ts`.
- Blocks: `engine/src/index.ts` WP-14.
- Produces: `ops.workspace.{discover,init}`, `ops.config.{inspect,configure,check}`, `ops.audit.{recordDecision,check}`, `OpContext`.
  Consumes: WP-12, WP-13, WP-02.
- Depends: WP-12, WP-13.
- Tests: `config-inspection.test.ts`, T-CLI-04 (unit part), T-ISO-07.
- Gate: `STD(engine)` + `UNIT packages/engine/src/ops`.
- Verifier: no business logic duplicated outside `ops`; `configure` no-op writes nothing; R-key routing creates `runtime.json` only on
  demand; isolation snapshot reported; legacy JSON keys of `inspect` in legacy order.

#### WP-16 Composition root
Phase 2, W2.6, M; impl opus xhigh; verify fable; 01 S8 (engine part)
- Goal: Implement `InstanceContext` and `createInstanceRuntime` with the owners' factory signatures as stubs, the error ring, the state
  watchdog and the test hooks. Every server-side service, the parity harness and the benchmarks build the runtime through it.
- Inputs: 01 4.4a, section 4.6, section 4.13, section 5.3; 02 4.10; 03 11.4, section 12.1; 06 3.2, section 3.4; 98 2.2, C06-C09, C15, C57; 99 I-15, N-01.
- Creates: `packages/engine/src/runtime/{context,instance-runtime,error-ring,state-watchdog,test-hooks}.ts`; tests
  `packages/engine/src/runtime/{instance-runtime,context,error-ring}.test.ts`, `packages/engine/test/ingest-until-idle.int.test.ts` (fake service).
- Blocks: `engine/src/index.ts` WP-16; creates `instance-runtime.ts` with blocks WP-17, WP-35, WP-41, WP-59.
- Produces: `InstanceContext`, `BuildContextInput`, `buildContext`, `RuntimeProcessInfo`, `ErrorRing`, `createErrorRing`,
  `createInstanceRuntime` (`start`, `stop(deadlineMs)`, `ingestUntilIdle({timeoutMs})`, `health()`, `ingestReplay`). Consumes: WP-07,
  WP-08 `Logger`, WP-09 `openInstanceDb`, WP-12, WP-13 `entriesBetween`, WP-03 types.
- Depends: WP-07, WP-08, WP-09, WP-12, WP-13.
- Tests: `instance-runtime.test.ts`, `context.test.ts`, `ingest-until-idle.int.test.ts` (01 S8 done-when, fake service).
- Gate: `STD(engine)` + `UNIT packages/engine/src/runtime` + `INT packages/engine/test/ingest-until-idle.int.test.ts`.
- Verifier: stub signatures equal 02 4.10, 03 11.4, section 12.1, 06 3.4 exactly (C06-C09); `IngestIdleTimeoutError` maps to `{idle: false}`;
  attempts timer 2 s, serialized, cleared on stop (C57); `ctx.instanceDir` (C07); test hooks inert unless the test env enables them.

#### WP-15 CLI kernel and config commands
Phase 2, W2.7, L; impl sonnet high; verify sonnet high; 01 S7 (CLI part)
- Goal: Implement the `mcs` dispatcher with per-command option tables, the three renderers and the `mcs.cli/1` envelope, and the thin
  commands `discover`, `init`, `inspect`, `configure`, `decide`, `audit`, `check`, `version`, `help`. Start the config-write isolation file.
- Inputs: 01 6.1-6.5 (rows of this WP), section 7.2, section 3.5 (T-ISO-06, 08), section 6.7, section 8.3; 05 5.3 S-OUT; ADR 0008, 0046; 98 8.
- Creates: `packages/cli/src/main.ts` (replaces the stub), `packages/cli/src/render/{text,json,legacy}.ts`,
  `packages/cli/src/commands/{discover,init,inspect,configure,decide,audit,check,version,help}.ts`; tests
  `packages/cli/test/cli-config.int.test.ts` (T-CLI-01, 02, 04, T-SEC-04; plan-assigned name),
  `tests/parity/cli-config.parity.test.ts` (T-CLI-03 config commands, T-XE-01, 02, T-AU-01; plan-assigned name),
  `tests/isolation/config-write-isolation.test.ts` (T-ISO-06 rows for init, configure, decide).
- Blocks: creates `cli/src/main.ts` with blocks WP-19, 22, 38, 61, 62, 63, 64 and `config-write-isolation.test.ts` with blocks WP-22,
  38, 39, 62.
- Produces: `main(argv, {launcherPath, skillDir, runtimeDir})`, command registry, renderers. Consumes: WP-14, WP-08 terminal.
- Depends: WP-08, WP-14.
- Tests: T-CLI-01, 02, 03 (config commands), 04, T-XE-01, 02, T-AU-01, T-SEC-04, T-ISO-06 (these commands).
- Gate: `STD(cli, tests)` + `INT packages/cli/test/cli-config.int.test.ts` + `PAR tests/parity/cli-config.parity.test.ts` + `ISO tests/isolation/config-write-isolation.test.ts`.
- Verifier: commands contain option tables and rendering only; all output through `io/terminal.ts`; exit codes 0/1/2; legacy JSON shape
  parity on keys and values; parity tests skip with a recorded reason when Python >= 3.8 is missing (never pass silently).
- Cut line: `discover` and `audit`/`check` commands move to WP-15b.

#### WP-17 Server app, meta routes, static hosting
Phase 2, W2.7, M; impl opus xhigh; verify fable; 03 S4
- Goal: Implement the Express app with guards, limits, headers, the error envelope, response validation through the route registry,
  the meta and ingest routes and the static hosting of the web build. Seed the query layer with `createQueries` and its health part.
- Inputs: 03 5.1, section 5.2, section 6.1 (meta rows), section 6.2, section 6.3, section 12.1, section 13, section 14; 04 3.1 (HTML fallback), section 12.2, ADR 0039; 02 2.8; 05 5.3
  S-NET; 98 section 3, section 7.1, N3, C26; 99 I-30, I-31, I-37.
- Creates: `packages/server/src/{app,errors,route-adapter}.ts`, `packages/server/src/routes/{meta,ingest}.ts`,
  `packages/engine/src/query/{index,health}.ts`; tests `packages/server/test/{meta,ingest,errors-envelope,static}.int.test.ts`
  (`static` plan-assigned).
- Blocks: `engine/src/index.ts` WP-17, `instance-runtime.ts` WP-17 (real `createQueries`); creates `app.ts` with blocks WP-29, 30, 31,
  33, 36, 41, 57, 58, 60 and `query/index.ts` with blocks WP-29, 30, 31, 33, 57, 58.
- Produces: `createApp`, `registerRoute`, routes `legacyHealth`, `health`, `healthIngest`, `instance`, `config`, `ingestNudge`,
  `ingestProbe`; `createQueries`, `EngineQueries.{instanceInfo,health,ingestHealth,hookProbe}`. Consumes: WP-03, WP-08 guards, WP-11
  (`MetaRepo`, `IngestHealthRepo`, `HookProbesRepo`), WP-16.
- Depends: WP-03, WP-08, WP-11, WP-16.
- Tests: DA-T-API-3, 4, 5, 10, 11, 13, 14, 16; static and history-fallback rules of 04 12.2.
- Gate: `STD(server, engine)` + `INT packages/server/test/meta.int.test.ts packages/server/test/ingest.int.test.ts packages/server/test/errors-envelope.int.test.ts packages/server/test/static.int.test.ts`.
- Verifier: Origin allow-list of two; no CORS; `/api/health` exactly the 13 keys (I-30); nudge <= 256 bytes and refused with `Origin`;
  probe id regex; `.vite/` never served; CSP of 04 12.2; response validation behaviour decided per N3 and recorded in a CR if unset;
  adversarial: Host/Origin matrix, oversized bodies, path traversal on static paths.

#### WP-18 Server process shell
Phase 2, W2.8, M; impl opus xhigh; verify fable; 01 S8 (server part)
- Goal: Implement the server process: argv contract, boot sequence with exit codes, port scan and bind on 127.0.0.1, the named-pipe
  control channel with token, graceful shutdown and the atomic `state.json` lifecycle. It wires `createApp` and `createInstanceRuntime`.
- Inputs: 01 4.1, section 4.3, section 4.4, section 4.5, section 4.6, section 4.11, section 4.13, section 8; 03 3.2 (open exit codes); ADR 0004, 0005; 98 7.3, section 9.1, section 9.3.
- Creates: `packages/server/src/{main,boot,control-channel,shutdown,state-file}.ts`; tests `packages/server/src/control-channel.test.ts`,
  `packages/server/test/{boot,control,shutdown,state-file}.int.test.ts` (T-LC-03, 04, 05, 07, 14 boot part, T-SEC-01 POSIX-only;
  plan-assigned names).
- Blocks: none.
- Produces: server entry `packages/server/dist/main.js` (runtime marker path), boot exit codes, control ops (`identify`, `shutdown`,
  `ingest-replay`, `backup`), `run/control.token`, `state.json` writes. Consumes: WP-16, WP-17, WP-07, WP-13, WP-09.
- Depends: WP-07, WP-13, WP-17.
- Tests: T-LC-03, 04, 05, 07; T-LC-14 boot part (previousRunUnclean, integrity; the no-duplicates-after-replay part is WP-39's);
  T-SEC-01 skipped on win32 with a recorded reason.
- Gate: `STD(server)` + `UNIT packages/server/src/control-channel.test.ts` + `INT packages/server/test/boot.int.test.ts packages/server/test/control.int.test.ts packages/server/test/shutdown.int.test.ts packages/server/test/state-file.int.test.ts`.
- Verifier: binds 127.0.0.1 only; scan base..base+19 from the configured port (tests always pass 18000-18499 ports); `state.json`
  written atomically after bind; token never logged; wrong token -> FORBIDDEN and process alive; graceful order of 01 4.5.

#### WP-19 Lifecycle ops and CLI
Phase 2, W2.9, M; impl opus xhigh; verify fable; 01 S9 (ops and CLI)
- Goal: Implement `start`, `stop`, `status`, `restart`, `verify` and `serve` with liveness probing, marker-verified kills and
  cross-engine ownership rules. After this WP the smoke gate turns from SKIPPED to PASS.
- Inputs: 01 4.7-4.10, section 4.14, section 4.15, section 6.3-6.4 (rows), section 4.16; ADR 0004, 0006; 98 8.
- Creates: `packages/engine/src/ops/{lifecycle,probe}.ts`, `packages/cli/src/commands/{start,stop,status,restart,verify,serve}.ts`;
  tests `packages/engine/src/ops/probe.test.ts`, `packages/cli/test/{lifecycle,status}.int.test.ts` (05 4.2 names; T-LC-01, 02, 09, 15),
  `tests/resilience/process-lifecycle.test.ts` (T-LC-06, 08, 13; plan-assigned name).
- Blocks: `cli/src/main.ts` WP-19, `engine/src/index.ts` WP-19; creates `ops/lifecycle.ts` with block WP-63.
- Produces: `ops.lifecycle.{start,stop,status,restart,verify,serveForeground}`, `probeInstance`. Consumes: WP-18, WP-15, WP-07.
- Depends: WP-15, WP-18.
- Tests: T-LC-01, 02, 06, 08, 09, 13, 15; smoke PASS.
- Gate: `STD(engine, cli, tests)` + `UNIT packages/engine/src/ops/probe.test.ts` + `INT packages/cli/test/lifecycle.int.test.ts packages/cli/test/status.int.test.ts`
  + `RES tests/resilience/process-lifecycle.test.ts` + `cd $R && node $K/mcslock.mjs run -- sh -c "node $K/wp-gate.mjs build --wp WP-19 && node scripts/smoke.mjs"` (exit 0).
- Verifier: `stop` verifies the marker before any kill and never kills a pid without it; a live legacy viewer means "running
  (engine=legacy)" and blocks a second engine; `start` idempotent; no console window (T-LC-13); every test passes `--port` and `--repo`.

#### WP-20 Isolation setup and lifecycle isolation tests
Phase 2, W2.10, M; impl sonnet high; verify opus xhigh; 05 S9 (`_setup.ts`), 01 S9 (isolation files)
- Goal: Provide the shared two-instance setup and the release-blocking isolation files for identity, stopping and ownership. Each test
  title starts with its T-ISO id.
- Inputs: 05 4.3, section 4.5, section 4.8; 01 3.2, section 3.5 (T-ISO-05, 13, 14, 18-22); 98 C32, C33; 99 N-07.
- Creates: `tests/isolation/_setup.ts`, `tests/isolation/setup-selftest.test.ts` (plan-assigned), `tests/isolation/db-identity.test.ts`,
  `tests/isolation/lifecycle-isolation.test.ts`, `tests/isolation/ownership-isolation.test.ts`.
- Blocks: creates `lifecycle-isolation.test.ts` with block WP-62 and `ownership-isolation.test.ts` with block WP-63.
- Produces: `twoInstances({sameRepo?})`. Consumes: WP-06, WP-19.
- Depends: WP-06, WP-19.
- Tests: `_setup.ts` self-test (05 S9), T-ISO-05, 13, 14, 18, 19, 20, 21, 22.
- Gate: `STD(tests)` + `ISO tests/isolation/setup-selftest.test.ts tests/isolation/db-identity.test.ts tests/isolation/lifecycle-isolation.test.ts tests/isolation/ownership-isolation.test.ts`.
- Verifier: assertions equal 01 3.5 (no weakened assertion); every started process stopped and port closed; hermetic env; one worker per file.

#### WP-21 Launcher
Phase 2, W2.10, M; impl opus xhigh; verify fable; 01 S10, 05 S4
- Goal: Implement the zero-dependency launcher with the Node floor check, stamp-based staleness, the mutex-serialized bootstrap with the
  `RUNTIME_IN_USE` guard, and in-process CLI execution. Prove its mutex and marker copies match the engine's.
- Inputs: 01 5.1-5.3, section 4.2; 05 3.3, S4; ADR 0007, 0047; 98 9.3, C29, C30; 99 I-05, I-24.
- Creates: `<skill>/scripts/mcs.mjs`, `tests/tooling/{launcher-parity,launcher-bootstrap}.test.ts` (plan-assigned names).
- Blocks: none.
- Produces: `$MCS`, `NODE_TOO_OLD`, `RUNTIME_IN_USE`, `BOOTSTRAP_FAILED`, `runtime/.mcs-bootstrap.log`. Consumes: WP-01 `build-stamp.mjs`,
  WP-07 (reference behaviour), WP-19 (CLI main).
- Depends: WP-01, WP-07, WP-19.
- Tests: T-UP-01, 02, 03, 04, 10; `launcher-parity.test.ts`; 05 S4 cases (one bootstrap for two launchers, killed bootstrap leaves no lock).
- Gate: `cd $R && npx prettier --check ../scripts/mcs.mjs && node --check ../scripts/mcs.mjs` + `STD(tests)` + `TOOL tests/tooling/launcher-parity.test.ts tests/tooling/launcher-bootstrap.test.ts`.
- Verifier: only `node:*` imports; never `npm install`, never a `.cmd` spawn; bootstrap tests operate on a temp copy of the runtime with
  `npm ci --offline`, never on the real runtime folder; floor message exact (22.22.0); launcher never touches workspaces.

#### WP-22 Instances, doctor, diagnostics
Phase 2, W2.10, M; impl sonnet high; verify opus xhigh; 01 S11
- Goal: Implement `instances list|set-engine|repair`, `doctor` and the privacy-safe `diagnostics` bundle. Doctor keeps the legacy JSON
  shape and adds Node checks.
- Inputs: 01 3.4, section 6.3-6.4 (rows), section 8.2; 98 C22, C55.
- Creates: `packages/engine/src/ops/{instances,diagnostics}.ts`, `packages/cli/src/commands/{instances,doctor,diagnostics}.ts`; tests
  `packages/engine/src/ops/diagnostics.test.ts`, `packages/cli/test/{doctor,diagnostics}.int.test.ts` (`doctor` 05 4.2 name).
- Blocks: `cli/src/main.ts` WP-22, `engine/src/index.ts` WP-22, `config-write-isolation.test.ts` WP-22 (`instances repair` row of T-ISO-06).
- Produces: `ops.instances.{list,setEngine,repairIdentity}`, `ops.diagnostics.{doctor,bundle}`, `mcs.diagnostics/1`. Consumes: WP-19, WP-14.
- Depends: WP-15, WP-19.
- Tests: T-CLI-09, T-SEC-02, T-SEC-03 (diagnostics part), T-SEC-05, doctor checks, T-ISO-06 row.
- Gate: `STD(engine, cli)` + `UNIT packages/engine/src/ops/diagnostics.test.ts` + `INT packages/cli/test/doctor.int.test.ts packages/cli/test/diagnostics.int.test.ts` + `ISO tests/isolation/config-write-isolation.test.ts`.
- Verifier: bundle holds no prompt marker, regex text, home path or control token; `HooksVerifyResult` type (C22); `mcs diagnostics`
  name (C55).

### Phase 3: ingestion and state correctness

#### WP-25 Hook handler and stub
Phase 3, W3.1, M; impl opus xhigh; verify fable; 02 I-2
- Goal: Implement the installed hook command: a committed zero-dependency stub that imports the built handler, which stamps envelopes,
  routes them to matching instance spools and nudges the server, always silent and always exit 0. Prove it never blocks Claude Code.
- Inputs: 02 1.1, section 2.1-2.12, CHALLENGES C1; 05 2.6 (hook lint block), section 4.4 (`runHookHandler`); ADR 0010-0013; 98 1.7, section 9.2, section 10.1.
- Creates: `<skill>/scripts/mcs-hook.mjs`, `packages/cli/src/hook.ts` (replaces the stub), `packages/cli/src/hook/{main,routes-reader,spool-writer,nudge,handler-log}.ts`,
  `packages/cli/test/hook.int.test.ts`.
- Blocks: none.
- Produces: installed command `node --no-warnings <skill>/scripts/mcs-hook.mjs --mcs-hook <Event> [--async]`, `runHook(argv)`, spool
  segments `data/spool/hooks-<YYYYMMDD>T<HH>Z.ndjson`, nudge POST, `$MCS_HOME/logs/hook-handler.jsonl`, `HANDLER_UNAVAILABLE`.
  Consumes: WP-04 protocol, WP-06 `hookPayload`, `runHookHandler`.
- Depends: WP-04, WP-06.
- Tests: T-HK-01..17 (T-HK-16 parity part with Python); 05 S3 row "runHookHandler default and direct both write one spool line".
- Gate: `STD(cli)` + `INT packages/cli/test/hook.int.test.ts`.
- Verifier: nothing on stdout in any path; exit 0 when the runtime is not built, the spool dir is missing, stdin is malformed or the
  server is down; `MCS_HOOK_DISABLE` checked first; imports only `node:*`, `@mcs/shared/protocol`, `./`; nudge timeout about 300 ms
  and no event data in its body; never opens the DB or reads settings; timing budget with `MCS_PERF_FACTOR`.

#### WP-26 Ingestion primitives: tailer and normalizers
Phase 3, W3.1, L; impl opus xhigh; verify fable; 02 I-3, 02 I-5
- Goal: Implement the incremental JSONL tailer shared by the spool and transcripts, and the normalizers that turn envelopes and
  transcript records into logical events and event-row writes with stored kinds, severities and natural keys.
- Inputs: 02 4.1, section 4.1.1, section 4.1.2, section 4.3, section 5.3, section 5.6, section 5.7, section 9.1; 03 3.6 (natural keys), section 5.5 (`EVENT_KINDS`); ADR 0015, 0016;
  98 11.3, section 11.4, C18.
- Creates: `packages/engine/src/ingest/tail/{jsonl-tailer,file-identity,line-splitter}.ts`, `packages/engine/src/ingest/hooks/normalize-envelope.ts`,
  `packages/engine/src/ingest/event-row.ts`, `packages/engine/src/ingest/transcripts/{normalize-record,task-notification}.ts` + colocated
  tests; fixtures `packages/engine/test/fixtures/{transcripts,hooks}.ts`.
- Blocks: none (engine-internal modules; no barrel export needed).
- Produces: `JsonlTailer`, file identity, `normalizeEnvelope`, `LogicalEvent`, `EventRowWrite`, `normalizeRecord`, `parseTaskNotification`.
  Consumes: WP-03, WP-04, WP-07 (`fsx`).
- Depends: WP-03, WP-04, WP-07.
- Tests: T-TR-01..08, 11, 15, 16, 19; `normalize-envelope.test.ts` and `normalize-record.test.ts` stored-kind tables.
- Gate: `STD(engine)` + `UNIT packages/engine/src/ingest/tail packages/engine/src/ingest/hooks packages/engine/src/ingest/event-row.test.ts packages/engine/src/ingest/transcripts/normalize-record.test.ts packages/engine/src/ingest/transcripts/task-notification.test.ts`.
- Verifier: offsets cut at the last newline; identity = (path, size, first-256-bytes hash, inode); `MAX_LINE_BYTES` is the only cap;
  bookkeeping records never count as activity; tool-result and attachment bodies, thinking signatures and account ids never reach a row
  (T-TR-16); stored kinds equal `EVENT_KINDS`; adversarial: truncate, replace, append partial lines, CRLF, BOM.
- Cut line: the normalizers (`hooks/`, `event-row.ts`, `transcripts/*`) move to WP-26b (deps WP-26).

#### WP-30 Query layer A: sessions, agents, events, tool calls
Phase 3, W3.1, L; impl sonnet high; verify opus xhigh; 03 S5 (part)
- Goal: Implement the engine query functions and thin routes for sessions, agents, timelines, events, tool calls and transitions with
  keyset pagination, the typed filter model in SQL and bounded scans. Every response carries a consistent `asOfSeq`.
- Inputs: 03 5.3, section 5.4, section 6.1 (rows listSessions, getSession, sessionAgents, sessionTimeline, sessionToolCalls, sessionTransitions,
  listAgents, listEvents, getEvent, listToolCalls), section 6.3, section 6.4, section 3.7, section 12.1; ADR 0026, 0029; 98 2.7, section 3.
- Creates: `packages/engine/src/query/{sessions,agents,events,tool-calls,transitions}.ts`, `packages/server/src/routes/{sessions,agents,events,tool-calls}.ts`;
  tests `packages/engine/src/query/{sessions,agents,events,tool-calls}.test.ts`, `packages/server/test/contract/{sessions,agents,events,tool-calls}.int.test.ts`,
  `packages/engine/test/query-plans.int.test.ts` (DA-T-DB-14, plan-assigned name).
- Blocks: `query/index.ts` WP-30, `app.ts` WP-30, `engine/src/index.ts` WP-30; creates `routes/sessions.ts` with block WP-58.
- Produces: `EngineQueries.{listSessions,getSession,sessionSummaries,sessionAgents,listAgents,agentNode,workflowRun,listEvents,getEvent,eventsByIdRange,listToolCalls,toolCallsByIds,sessionTransitions}`
  and their routes. Consumes: WP-10, WP-11, WP-17.
- Depends: WP-10, WP-11, WP-17.
- Tests: DA-T-API-1 (these routes), 6, 7 (SQL part), 8, 9, 12, 17; DA-T-DB-14.
- Gate: `STD(engine, server)` + `UNIT packages/engine/src/query` + `INT packages/server/test/contract packages/engine/test/query-plans.int.test.ts`.
- Verifier: no gaps or duplicates under concurrent inserts; snapshot read in one synchronous step; `filter_requires_scope`; routes call
  queries only; `getSession` returns `auditRefs: []` and the route attaches `entriesBetween` results (I-19).
- Cut line: events and tool calls (`query/{events,tool-calls}.ts` + routes) move to WP-30b.

#### WP-42 Testkit legacy builders
Phase 3, W3.1, M; impl sonnet high; verify sonnet high; 06 PP3
- Goal: Add the TypeScript builders that reproduce the legacy fixture trees byte for byte, plus the Python-compatible dumps, open-handle
  writer, expectation types and the big-file builder. They feed the parity skeleton and the scenario catalogue.
- Inputs: 06 5.3, section 6.1, section 6.2, section 6.5; ADR 0054; 98 12.1, C36, C46.
- Creates: `packages/testkit/src/{pyjson,io,expect,big}.ts`, `packages/testkit/src/legacy/*` (incl. `index.ts` for the `./legacy`
  export), `packages/testkit/legacy/{ORDER.md,shapes.json}` + tests of 06 6.5 (`shapes`, `pyjson`, `io`, `big`).
- Blocks: `testkit/src/index.ts` WP-42.
- Produces: `pyDumps`, `pyIso`, `detUuidSequence`, `setAge`, `freezeUntouched`, `appendWithOpenHandle`, `treeManifest`, `UsageTotals`,
  `SessionExpectation`, `ScenarioExpectation`, `buildBigTranscript`, `buildLegacyFixtureHome`, `buildLegacyDemo`, `buildPanelsTree`,
  `buildRulesTree`, `buildRegistryHome`. Consumes: WP-06, WP-24 (vectors), `LegacyState` from WP-03.
- Depends: WP-06, WP-24.
- Tests: 06 6.5 rows `shapes`, `pyjson` (against `golden/vectors/pydumps.json`), `io`, `big`.
- Gate: `STD(testkit)` + `UNIT packages/testkit/src`.
- Verifier: `LegacyState` imported, not redeclared (C36); if `pyDumps` duplicates engine PyJson (WP-05) the WP re-exports or documents
  why not (repository rule 2); everything synthetic and labelled.

#### WP-27 Token accounting
Phase 3, W3.2, M; impl opus xhigh; verify fable; 02 I-6
- Goal: Implement token accounting from transcripts only: global `message.id` dedupe, per-field maximum, `iterations[0]` fallback,
  subagent lower bounds and missing-versus-zero. Provide the legacy parity projection.
- Inputs: 02 6.1-6.7; 03 3.6 (usage storage), section 8.2; ADR 0017, 0024; 98 10.2.
- Creates: `packages/engine/src/tokens/{accumulate,aggregate,legacy-projection}.ts`; tests `packages/engine/src/tokens/{aggregate,worked-example,legacy-projection}.test.ts`.
- Blocks: none.
- Produces: accumulation and aggregation functions, legacy projection. Consumes: WP-26 records.
- Depends: WP-26.
- Tests: T-TK-01..08.
- Gate: `STD(engine)` + `UNIT packages/engine/src/tokens`.
- Verifier: worked example equals 02 6.4 exactly; dedupe across all files of an instance; hooks never contribute tokens; adversarial:
  streaming snapshots in shuffled order, resumed copies, zero-usage messages.

#### WP-28 Lifecycle model
Phase 3, W3.2, L; impl opus xhigh; verify fable; 02 I-7
- Goal: Implement the evidence-based lifecycle model as pure functions: facts semilattice and merges, session/agent/workflow decision
  tables, evidence rendering, view-change detection, the legacy five-state mapping, `nextCheckAt` and work-item derivation.
- Inputs: 02 7.1-7.12; foundations D9; ADR 0018, 0019; 98 section 11, C18, C37; 99 I-18, I-33.
- Creates: `packages/engine/src/lifecycle/{facts,merge,derive-session,derive-agent,derive-workflow,rules,legacy,next-check,work-items}.ts`;
  tests `packages/engine/src/lifecycle/{transitions,properties,rules,legacy,work-items}.test.ts`; `packages/engine/test/support/prng.ts`.
- Blocks: `engine/src/index.ts` WP-28.
- Produces: `LifecycleEvidence`, facts and merges (incl. `external.attempt_cleared`), `deriveSession`, `deriveAgent`, `deriveWorkflow`,
  `renderEvidence`, `toApiEvidence`, `viewChanged`, `toLegacy`, `nextCheckAt`, work-item derivation. Consumes: WP-26 `LogicalEvent`, WP-03 enums.
- Depends: WP-26.
- Tests: P1-P9, T-LF-01..52 (T-LF-50 model part), 55, 56.
- Gate: `STD(engine)` + `UNIT packages/engine/src/lifecycle`.
- Verifier: `Stop` != `SessionEnd`; a subagent ending never completes its parent; missing events never imply success; terminal states
  never regress without a reconciliation record; every 02 7.7 row is a table test; seeds printed; adversarial: random event
  permutations and duplicates against the properties.
- Cut line: `work-items.ts` + `next-check.ts` move to WP-28b.

#### WP-31 Query layer B: overview, work items, alerts, errors
Phase 3, W3.2, M; impl sonnet high; verify sonnet high; 03 S5 (part)
- Goal: Implement the overview (session, agent, event and alert metrics of 03 8.1), the work-item board, alert listing and the errors
  query with their routes. Token and cost metrics are left to WP-58 through a marked block.
- Inputs: 03 6.1 (rows overview, workItemBoard, getWorkItem, listAlerts, alertRules, errors), section 8.1, section 10.3, section 12.1; 01 4.4a (error
  ring); 98 C52.
- Creates: `packages/engine/src/query/{overview,work-items,alerts,errors}.ts`, `packages/server/src/routes/{overview,work-items,alerts,errors}.ts`;
  tests `packages/engine/src/query/{overview,work-items,errors}.test.ts`, `packages/server/test/contract/{overview,work-items,alerts,errors}.int.test.ts`.
- Blocks: `query/index.ts` WP-31, `app.ts` WP-31, `engine/src/index.ts` WP-31; creates `query/overview.ts` with block WP-58.
- Produces: `EngineQueries.{overview,workItemBoard,getWorkItem,listAlerts,alertRules,errors}` and routes. Consumes: WP-11, WP-30.
- Depends: WP-11, WP-30.
- Tests: DA-T-API-1 (these routes); overview state tiles equal `listSessions` counts.
- Gate: `STD(engine, server)` + `UNIT packages/engine/src/query/overview.test.ts packages/engine/src/query/work-items.test.ts packages/engine/src/query/errors.test.ts`
  + `INT packages/server/test/contract/overview.int.test.ts packages/server/test/contract/work-items.int.test.ts packages/server/test/contract/alerts.int.test.ts packages/server/test/contract/errors.int.test.ts`.
- Verifier: no fabricated metric (rows absent until their source exists); `source`/`rule` texts exactly 03 8.1; board cap 500 with `truncated`.

#### WP-33 Transcript entries, index, window, locate
Phase 3, W3.2, M; impl sonnet high; verify opus xhigh; 03 S7
- Goal: Implement the legacy-compatible display entries, the checkpoint entry index and the transcript window and locate reads over the
  full history, with the route. The importer's `readEntryText` builds on these modules.
- Inputs: 03 7.1-7.3, section 6.1 (rows transcriptWindow, transcriptLocate), section 3.6 (checkpoints); 02 5.7; ADR 0016, 0023.
- Creates: `packages/engine/src/transcript/{entries,index-service,window}.ts`, `packages/server/src/routes/transcript.ts`; tests
  `packages/engine/src/transcript/{entries,index-service,window}.test.ts`, `packages/engine/test/transcript-window.int.test.ts`.
- Blocks: `query/index.ts` WP-33 (`TranscriptQueries.window`, `locate`), `app.ts` WP-33, `engine/src/index.ts` WP-33.
- Produces: `displayEntries`, `countEntries`, entry index service, `TranscriptQueries.{window,locate}`, routes `transcriptWindow`,
  `transcriptLocate`. Consumes: WP-10 (`CheckpointsRepo`), WP-17, WP-26.
- Depends: WP-10, WP-17, WP-26.
- Tests: DA-T-S-7, 8, 9.
- Gate: `STD(engine, server)` + `UNIT packages/engine/src/transcript` + `INT packages/engine/test/transcript-window.int.test.ts`.
- Verifier: path containment through `security/paths.ts`; content read on demand and never persisted (ADR 0016); identity change resets
  the index; window bounds and `textChars` limits of 03 6.1.

#### WP-37 Hooks installer
Phase 3, W3.2, M; impl opus xhigh; verify fable; 02 I-9
- Goal: Implement the consent-gated installer, verifier, uninstaller and status in the engine: a pure plan over the settings text,
  atomic apply with validation and backup under the settings mutex, and verification without starting Claude Code.
- Inputs: 02 3.1-3.9; 01 6.3 (hooks rows), section 7.2 (audit template); ADR 0014; 98 C22, C23, C48; 99 N-11.
- Creates: `packages/engine/src/hooks/installer/{plan,apply,verify,uninstall,status,settings-io}.ts` + colocated tests
  (`plan`, `apply`, `verify`), `packages/engine/test/hooks-installer.int.test.ts`, fixtures `packages/engine/test/fixtures/settings/*`.
- Blocks: `engine/src/index.ts` WP-37, `shared/src/cli/results.ts` WP-37 (hooks result types of 02 3.1).
- Produces: `planHooks`, apply, `HooksInstallResult`, `HooksVerifyResult`, `HooksStatusResult`, uninstall. Consumes: WP-04, WP-25 (stub
  path), WP-07 (`acquireMutex(mutexName('settings', path.resolve(p)))`, `execFileText` kind `node`), WP-13 (audit writer).
- Depends: WP-04, WP-07, WP-13, WP-25.
- Tests: T-IN-01..09.
- Gate: `STD(engine, shared)` + `UNIT packages/engine/src/hooks/installer` + `INT packages/engine/test/hooks-installer.int.test.ts`.
- Verifier: refuses real settings paths under `MCS_TEST`/`VITEST` (T-IN-07) and every test uses temp `--settings-file` paths; the real
  user and project settings files are byte-identical before and after the suite (hash them); `.claude/settings.json` refused; dry run
  writes nothing; entries marked by script path; adversarial: concurrent installs, invalid JSON, foreign hooks preserved.

#### WP-43 Parity harness base and L1 vectors
Phase 3, W3.2, M; impl sonnet high; verify opus xhigh; 05 S8, 06 PP4
- Goal: Build the Node side of the parity harness (projections, normalisation, Python runner, capture wrapper) and the parity skeleton
  with byte-identical legacy trees and the first L1 vector files. Golden mode runs without Python; live mode re-captures.
- Inputs: 05 4.11 (4.11.1-4.11.5); 06 5.2-5.5, section 5.10; ADR 0044, 0053, 0054; 98 12.2, C36; 99 I-09.
- Creates: `tests/parity/{projections,normalize,run-python,reference-usage,vectors}.ts`, `tests/parity/global-setup.ts`,
  `tests/parity/{legacy-trees,vectors}.parity.test.ts`, `scripts/parity-capture.mjs`, `tests/tooling/parity-capture.test.ts`.
- Blocks: `vitest.config.ts` WP-43 (parity `globalSetup`); `pkg:` `parity:capture`, `parity:check`.
- Produces: `SessionProjection` .. `WorkspaceFilesProjection`, `compareProjection`, `FROZEN_NOW_S`, `normalizeText`, `normalizeValue`,
  `goldenDir`, `readGoldenApi`, `findPython`, `runCapture`, `referenceUsage`, `runVectorFile`. Consumes: WP-24 goldens, WP-42, WP-05,
  WP-07, WP-12, WP-13, WP-02.
- Depends: WP-05, WP-07, WP-12, WP-13, WP-24, WP-42.
- Tests: 05 S8 done-when; 06 PP4 done-when: vectors `splitlines`, `tail`, `strptime`, `pydumps`, `slug`, `merge_provenance`,
  `audit_entry`, `json_atomic` and manifests equal for all L-* trees.
- Gate: `STD(tests)` + `PAR tests/parity/legacy-trees.parity.test.ts tests/parity/vectors.parity.test.ts` + `TOOL tests/tooling/parity-capture.test.ts`
  + `cd $R && node $K/mcslock.mjs run -- npm run parity:check`.
- Verifier: normalisation applied to the Node side only and exactly 06 5.2.3; no age buckets; missing Python in live mode is SKIPPED with
  a reason and fails only with `CI=true`; the wrapper never writes files itself.

#### WP-29 Completion evidence end to end
Phase 3, W3.3, M; impl opus xhigh; verify opus xhigh; 02 I-7b, 03 S5b
- Goal: Implement `explainCompletion` with its target resolution and observed-only terminal outcomes, and expose it through the shared
  schema, the query layer and the completion route. The CLI `verify-completion` (WP-61) reuses it.
- Inputs: 02 7.13; 03 6.1 (row explainCompletion), section 6.3, section 12.1, section 22 O-5; 01 6.4 (`verify-completion`); 98 C16, C17; 99 I-08.
- Creates: `packages/engine/src/lifecycle/completion.ts`, `packages/shared/src/api/completion.ts`, `packages/engine/src/query/completion.ts`,
  `packages/server/src/routes/completion.ts`; tests `packages/engine/src/lifecycle/completion.test.ts`, `packages/server/test/completion.int.test.ts`.
- Blocks: `shared/src/index.ts` WP-29, `shared/src/api/routes.ts` WP-29, `query/index.ts` WP-29, `app.ts` WP-29, `engine/src/index.ts` WP-29.
- Produces: `explainCompletion(lookup, target, now)`, `CompletionTarget`, `CompletionLookup`, `CompletionTargetError`,
  `CompletionEvidenceSchema`, `EngineQueries.explainCompletion`, route `explainCompletion`. Consumes: WP-28, WP-11, WP-17.
- Depends: WP-11, WP-17, WP-28.
- Tests: T-LF-57 CE-1..16 (in-memory lookup), DA-T-API-15; O-5 measured (5,000 sessions, 20,000 runs) and reported.
- Gate: `STD(engine, shared, server)` + `UNIT packages/engine/src/lifecycle/completion.test.ts` + `INT packages/server/test/completion.int.test.ts`.
- Verifier: outcome terminal only when basis is `observed` (D9); `attemptPart` 0..512 with empty allowed (C17); `target_not_found` -> 404
  `completion_target_not_found`, `target_invalid` -> 400 `validation_failed` (C16); `sessionId: string | null`, `resolvedBy`, `candidates`.

#### WP-32 Hook path to the database
Phase 3, W3.3, L; impl opus xhigh; verify fable; 02 I-4
- Goal: Implement the spool drainer, segment sealing and retention, the replay engine, dedupe, ingest error codes, the route-file writer
  and the single `IngestWriter` with persist-before-publish transactions. Delivery is at-least-once and idempotent.
- Inputs: 02 2.6.2 (route file), section 2.7, section 2.8 (server side), section 4.4-4.8, section 4.10 (writer), section 8.1; 03 3.6, section 4.5, section 9.1; ADR 0011, 0012, 0025;
  98 2.4, section 7.5, C03, C04, C05, C53; 99 I-16, I-29.
- Creates: `packages/engine/src/ingest/{writer,dedupe,errors,routes-file}.ts`, `packages/engine/src/ingest/spool/{spool-drainer,segments,replay}.ts`
  + colocated tests (`dedupe`, `writer`, `segments`, `replay`, `routes-file`); fixtures `packages/engine/test/fixtures/{spool,hook-sequences}.ts`;
  `packages/engine/test/hook-to-db.int.test.ts` (T-PL-02..12, T-HK-06b; WP-39 extends it).
- Blocks: `engine/src/index.ts` WP-32; creates `hook-to-db.int.test.ts` with block WP-39.
- Produces: `IngestWriter` (`submit`), dedupe rules, ingest error codes (98 7.5), spool drainer, `planSpoolReplay`, `applySpoolReplay`,
  segment retention, route-file writer for `$MCS_HOME/routes/<instanceId>.json`. Consumes: WP-09, WP-10, WP-11, WP-16, WP-17 (nudge
  route), WP-25 (spool format), WP-26, WP-28.
- Depends: WP-10, WP-11, WP-16, WP-17, WP-25, WP-26, WP-28.
- Tests: T-PL-02..12, T-HK-06b; dedupe D1-D5.
- Gate: `STD(engine)` + `UNIT packages/engine/src/ingest/writer.test.ts packages/engine/src/ingest/dedupe.test.ts packages/engine/src/ingest/routes-file.test.ts packages/engine/src/ingest/spool`
  + `INT packages/engine/test/hook-to-db.int.test.ts`.
- Verifier: publication only in `onCommitted`; spool offsets advance in the same transaction as the rows; `event_uid` unique; backpressure
  bounded by `ingest.queueMax*`; malformed lines counted, never fatal; op `ingest-replay` with `fromSegment` (C03) and 01 7.2 audit
  template (C05); adversarial: kill between append and drain, duplicate POST plus replay, segment rotation at the hour boundary.
- Cut line: `spool/replay.ts` + its tests move to WP-32b.

#### WP-36 Stream: hub, hydration, SSE
Phase 3, W3.3, M; impl opus xhigh; verify fable; 03 S6
- Goal: Implement the SSE endpoint over the persisted change log: replay from `Last-Event-ID`, reset reasons, heartbeats, frame hydration
  through the query layer, slow-client eviction and the stream limit. Publish strictly after commit.
- Inputs: 03 9.1-9.6, section 6.1 (row stream); ADR 0025, 0032 (client side, for shapes); 98 section 4; 99 F-11.
- Creates: `packages/server/src/stream/{hub,hydrate,sse}.ts`; tests `packages/server/src/stream/hub.test.ts`, `packages/server/test/stream-{replay,limits,lifecycle}.int.test.ts` (names under the 03 S6 pattern `stream-*.int.test.ts`).
- Blocks: `app.ts` WP-36.
- Produces: route `stream`, frames of 98 section 4, epoch per process. Consumes: WP-09 `onCommitted`, WP-30, WP-31 hydration queries.
- Depends: WP-09, WP-30, WP-31.
- Tests: DA-T-RT-1..6, 8, 9, 10.
- Gate: `STD(server)` + `UNIT packages/server/src/stream/hub.test.ts` + `INT packages/server/test/stream-replay.int.test.ts packages/server/test/stream-limits.int.test.ts packages/server/test/stream-lifecycle.int.test.ts`.
- Verifier: bounded buffers; timers cleared on disconnect (`getActiveResourcesInfo` baseline); `reset` sends `id = head`; 17th stream 503;
  adversarial: paused sockets, abort storms, cursor ahead of head, foreign epoch.

#### WP-34 Transcript importer
Phase 3, W3.4, M; impl opus xhigh; verify fable; 02 I-8 (part)
- Goal: Implement transcript discovery, session classification with the Python-regex rules, the head/tail/backfill import policy, the
  time-sliced scheduler that never starves the event loop, and on-demand entry text. Imports feed the writer and token accounting.
- Inputs: 02 5.1, section 5.2, section 5.4, section 5.5, section 5.7, section 5.8, section 5.9, section 5.10; 03 7.1-7.2; ADR 0015, 0016; 98 C24.
- Creates: `packages/engine/src/ingest/transcripts/{discovery,classify,importer,scheduler,entry-text}.ts` + colocated tests.
- Blocks: `engine/src/index.ts` WP-34.
- Produces: discovery, `classify` (with `compilePyRegex(rule.match, 'session_rule')` and `applyLabelTemplate`, C24), importer,
  `ImportScheduler`, `readEntryText`. Consumes: WP-05, WP-26, WP-27, WP-32 (writer), WP-33 (`entries.ts`).
- Depends: WP-05, WP-26, WP-27, WP-32, WP-33.
- Tests: T-TR-09, 10, 12, 13, 14, 17, 18; T-TK-09.
- Gate: `STD(engine)` + `UNIT packages/engine/src/ingest/transcripts/discovery.test.ts packages/engine/src/ingest/transcripts/classify.test.ts packages/engine/src/ingest/transcripts/importer.test.ts packages/engine/src/ingest/transcripts/scheduler.test.ts packages/engine/src/ingest/transcripts/entry-text.test.ts`.
- Verifier: no worker thread (02 5.4); slices bounded by `import.sliceMs`; `.key` files never read; global uniqueness across resumed
  copies; classification parity with legacy `classify` on the shared fixtures.

#### WP-38 Hooks and ingest CLI
Phase 3, W3.4, M; impl sonnet high; verify opus xhigh; 01 S14
- Goal: Wire `hooks install|verify|uninstall|status|enable|disable` and `ingest replay` as engine ops with thin CLI commands, dry run by
  default and audited. `hooks enable` writes the route file under `MCS_HOME`, never a settings file.
- Inputs: 01 6.3 (rows hooks *, ingest replay), section 6.4, section 7.2; 02 3.1, section 3.6 (text formats), section 2.6.2, section 2.7; 98 C03, C04, C23.
- Creates: `packages/engine/src/ops/{hooks,ingest}.ts`, `packages/cli/src/commands/hooks/{install,uninstall,verify,status,enable,disable}.ts`,
  `packages/cli/src/commands/ingest-replay.ts`; tests `packages/engine/src/ops/hooks.test.ts` (T-CLI-10), `packages/cli/test/hooks.int.test.ts`
  (T-IN-10, 02 9.5 name), `packages/cli/test/ingest-replay.int.test.ts` (T-CLI-11, plan-assigned).
- Blocks: `cli/src/main.ts` WP-38, `engine/src/index.ts` WP-38, `config-write-isolation.test.ts` WP-38 (`hooks enable`, `ingest replay` rows).
- Produces: `ops.hooks.{install,verify,uninstall,status,setEnabled}`, `ops.ingest.replay`. Consumes: WP-37, WP-32, WP-18 (control op), WP-15.
- Depends: WP-15, WP-18, WP-32, WP-37.
- Tests: T-CLI-10, T-CLI-11, T-IN-10, T-ISO-06 rows.
- Gate: `STD(engine, cli)` + `UNIT packages/engine/src/ops/hooks.test.ts` + `INT packages/cli/test/hooks.int.test.ts packages/cli/test/ingest-replay.int.test.ts` + `ISO tests/isolation/config-write-isolation.test.ts`.
- Verifier: dry run without `--yes`; `--settings-file <temp>` in every test; JSON nested in the `mcs.cli/1` envelope; replay audit template of 01 7.2.

#### WP-40 Attempts
Phase 3, W3.4, M; impl opus xhigh; verify opus xhigh; 06 PP5
- Goal: Port attempts ingestion from the chain log: parsing, external state, matching rows to sessions and lifecycle evidence submitted
  through the shared writer after the attempts transaction commits. Reproduce the legacy panel exactly except the documented divergences.
- Inputs: 06 3.10.1-3.10.8; 03 3.5-3.6 (attempts tables, `AttemptsRepo`), section 9.1; 02 4.3 (`external.attempt`, `external.attempt_cleared`);
  ADR 0059; 98 C40, C41, C57; 99 I-18, N-01, N-10.
- Creates: `packages/engine/src/panels/attempts/{parse,state,ingest,match,evidence,repo}.ts`, colocated tests
  `packages/engine/src/panels/attempts/attempts-{parse,state,ingest,match,evidence}.test.ts`, `tests/parity/vectors/external_state.parity.test.ts`.
- Blocks: `engine/src/index.ts` WP-40.
- Produces: attempts tick functions used by `PanelService.tickAttempts`, `externalState`, matcher, evidence events with `endedAt`.
  Consumes: WP-05, WP-07 (`pyStrptime`, tailer helpers), WP-11 (`AttemptsRepo`, `SessionsRepo.attemptCandidates`), WP-26, WP-32 (writer),
  WP-43 (`runVectorFile`).
- Depends: WP-05, WP-07, WP-11, WP-26, WP-32, WP-43.
- Tests: 06 3.11 attempts rows (incl. stamp ordering); `external_state` vectors; L-PANELS attempts parity EXACT except D20 rows.
- Gate: `STD(engine, tests)` + `UNIT packages/engine/src/panels/attempts` + `PAR tests/parity/vectors/external_state.parity.test.ts`.
- Verifier: one `withWriteTx` for attempts rows, then `writer.submit` after COMMIT (N-01); `attempt/upsert` changes; config rebuild emits
  `external.attempt_cleared`; `CONFIG_INVALID` messages instead of `E_*` codes (N-06).

#### WP-35 Ingest service, sweeper, external evidence, ingestion health, DB schedule
Phase 3, W3.5, L; impl opus xhigh; verify fable; 02 I-8 (part), 02 I-10, 03 S11 (schedule part)
- Goal: Assemble the ingest service, the lifecycle sweeper, the external evidence pollers, the four-way ingestion health and the
  database background schedule, and replace their stubs in the composition root. After this WP an instance ingests on its own.
- Inputs: 02 4.10, section 7.8, section 7.10, section 8.1-8.4, section 1.2 (config keys); 03 11.4 (timers: liveness, health refresh, throttled announcements,
  WAL checkpoint, optimize; alert sweep and bookkeeping retention as empty blocks); 01 4.4a; 98 C06, C07, C08; 99 I-15.
- Creates: `packages/engine/src/ingest/service.ts`, `packages/engine/src/lifecycle/sweeper.ts`, `packages/engine/src/external/{registry,jobs,pid}.ts`,
  `packages/engine/src/health/{ingest-health,alert-inputs}.ts`, `packages/engine/src/maintenance/schedule.ts` + colocated tests
  (`sweeper`, `ingest-health`, `schedule`, `external/*`), `packages/engine/src/ingest/config-keys.test.ts`, `packages/engine/test/ingest-service.int.test.ts`,
  fixture `packages/engine/test/fixtures/external.ts`.
- Blocks: `instance-runtime.ts` WP-35, `engine/src/index.ts` WP-35; creates `schedule.ts` with blocks WP-59, WP-60.
- Produces: `createIngestService(ctx)` (`writer`, `start`, `stop`, `untilIdle`, `nudge`, `replay`, `stats`), `IngestIdleTimeoutError`,
  `createLifecycleSweeper(ctx, {writer})` (`tickNow`), external pollers, `IngestHealth` computation, alert inputs, `createDbScheduler(ctx)`.
  Consumes: WP-16, WP-28, WP-32, WP-34.
- Depends: WP-16, WP-28, WP-32, WP-34.
- Tests: T-PL-01, 13; T-LF-50 (sweeper part), 53, 54; T-HE-01..07; `config-keys.test.ts`; schedule timers with `FakeClock`.
- Gate: `STD(engine)` + `UNIT packages/engine/src/lifecycle/sweeper.test.ts packages/engine/src/health packages/engine/src/maintenance packages/engine/src/external packages/engine/src/ingest/config-keys.test.ts`
  + `INT packages/engine/test/ingest-service.int.test.ts packages/engine/test/ingest-until-idle.int.test.ts`.
- Verifier: no worker threads; `untilIdle` rejects with `IngestIdleTimeoutError` and the runtime maps it (C06); every timer on `ctx.clock`
  and cleared by `stop`; health "OK" never claimed while not in sync (UI-I4 source); alerts evaluated after commit, never in the ingest path.
- Cut line: `external/*` + their tests move to WP-35b.

#### WP-41 Panels: samplers, service, route, runtime wiring
Phase 3, W3.5, L; impl sonnet high; verify opus xhigh; 06 PP7
- Goal: Implement the machine, git, ledger, chain-log and logs samplers behind a single-flight cache, the panel service with the attempts
  tick, the panel route, and the runtime component with its 2 s attempts timer. Fill `HealthReport.panels` and `.children`.
- Inputs: 06 3.1-3.9, section 3.10.8, section 3.11, section 8.2; 01 4.4a (component 4); 03 6.1 (row panel), section 6.2; ADR 0050, 0051, 0052, 0057; 98 2.8, C57.
- Creates: `packages/engine/src/panels/{source-cache,machine,proc-win32,proc-posix,git,files,service,constants}.ts`, `packages/server/src/routes/panels.ts`;
  colocated tests `packages/engine/src/panels/{source-cache,machine,proc-win32,proc-posix,docker,git,files,service}.test.ts`,
  `packages/engine/test/panels/{machine-win32,panels-route}.int.test.ts`.
- Blocks: `instance-runtime.ts` WP-41, `app.ts` WP-41, `engine/src/index.ts` WP-41.
- Produces: `SourceCache`, `MachineSampler`, `GitSampler`, file panels, `createPanelService(ctx, {writer})` (`get`, `tickAttempts`, `stats`,
  `close`), route `panel`. Consumes: WP-07, WP-16, WP-17, WP-40.
- Depends: WP-07, WP-16, WP-17, WP-40.
- Tests: 06 3.11 rows (except attempts), Windows integration, B7 measured.
- Gate: `STD(engine, server)` + `UNIT packages/engine/src/panels/source-cache.test.ts packages/engine/src/panels/machine.test.ts packages/engine/src/panels/proc-win32.test.ts packages/engine/src/panels/proc-posix.test.ts packages/engine/src/panels/docker.test.ts packages/engine/src/panels/git.test.ts packages/engine/src/panels/files.test.ts packages/engine/src/panels/service.test.ts`
  + `INT packages/engine/test/panels`.
- Verifier: no sampling without requests; git commands lock-free (no `index.lock`); child processes only through `execFileText` with
  kinds and caps; the attempts timer is serialized and cleared on stop (C57).
- Cut line: `machine.ts`, `proc-win32.ts`, `proc-posix.ts` move to WP-41b.

#### WP-39 Ingestion integration and ingestion isolation rows
Phase 3, W3.6, M; impl sonnet high; verify opus xhigh; 02 I-11
- Goal: Prove the whole ingestion path end to end with real handler processes, real files and a real runtime, and add the isolation and
  crash rows that need ingestion. This WP closes Phase 3's correctness claims.
- Inputs: 02 9.2, section 9.3, section 2.6 (routing); 01 3.5 (T-ISO-08, 16, 17), section 4.16 (T-LC-14); 05 4.2, section 4.8 (ISO-9).
- Creates: `packages/engine/test/import-tokens.int.test.ts`, `tests/isolation/hook-routing-isolation.test.ts` (T-HK-05, 02-owned),
  `tests/isolation/restart-isolation.test.ts` (T-ISO-16, 17), `packages/server/test/crash-recovery.int.test.ts` (T-LC-14 replay part,
  plan-assigned).
- Blocks: `hook-to-db.int.test.ts` WP-39 (handler-process scenarios), `config-write-isolation.test.ts` WP-39 (T-ISO-08).
- Produces: tests only. Consumes: WP-20 `twoInstances`, WP-25, WP-30, WP-35, WP-38.
- Depends: WP-20, WP-25, WP-30, WP-35, WP-38.
- Tests: 02 9.3 scenarios; T-HK-05; T-ISO-08, 16, 17; T-LC-14 (no duplicate events after replay).
- Gate: `STD(engine, server, tests)` + `INT packages/engine/test/hook-to-db.int.test.ts packages/engine/test/import-tokens.int.test.ts packages/server/test/crash-recovery.int.test.ts`
  + `ISO tests/isolation/hook-routing-isolation.test.ts tests/isolation/restart-isolation.test.ts tests/isolation/config-write-isolation.test.ts`.
- Verifier: each test uses real processes and temp homes; counts are exact (no "at least"); `PRAGMA integrity_check` asserted for both
  instances; force-kill uses `forceKill` only on the test's own pid.

### Phase 4: UI foundation

#### WP-44 Web scaffold
Phase 4, W4.1, M; impl sonnet high; verify sonnet high; 04 W1
- Goal: Create the web package shell: `index.html` with the CSP-safe theme script, the real Vite and Vitest configs, routes with
  placeholders, error boundaries, the not-found page, tokens and base CSS, the icon registry, the first primitives and the bundle budget.
  Seed the shared web files with their marked blocks.
- Inputs: 04 3.1, section 3.4, section 4.1-4.3, section 6.1-6.4, section 6.8, section 7 (primitive states), section 8 (source audit), section 12.1-12.4, section 13; 05 A.24-A.27; ADR 0030,
  0035, 0037, 0039; 99 I-13.
- Creates: `packages/web/{index.html,public/theme-init.js,vite.config.ts,vitest.config.ts,scripts/check-bundle-budget.mjs}`,
  `packages/web/src/main.tsx` (replaces the stub), `packages/web/src/app/{App,AppProviders,routes,ErrorBoundary,RouteErrorBoundary,NotFoundPage,usePageChrome,PageSkeleton}.tsx`
  (`usePageChrome.ts`), `packages/web/src/styles/{index,tokens,base,layout,components,pages,transcript,panels}.css`,
  `packages/web/src/components/{Icon,icons,Button,StateBadge,TagBadge,EmptyState,ErrorState,Skeleton}.tsx` (`icons.ts`),
  `packages/web/src/test/{setup.ts,source-audit.test.ts}`; tests `StateBadge.test.tsx`, `routes.test.tsx`.
- Blocks: creates `routes.tsx`, `pages.css`, `components.css`, `transcript.css`, `panels.css` with the blocks of plan section 4.2.
- Produces: route table of 04 3.1 (placeholders), tokens of 04 6.1, icon registry, primitives. Consumes: WP-03 (via `@mcs/shared`).
- Depends: WP-01, WP-03.
- Tests: W1 done-when (placeholders render, not-found, boundaries, budget passes, source audit and lint rules fail on negative probes);
  `npm run dev` serves on 18766 against 18765.
- Gate: `STD(web)` + `WEB packages/web/src` + `cd $R && node $K/mcslock.mjs run -- npm run build -w @mcs/web`.
- Verifier: no inline script in `index.html`; `MCS_DEV_API` default `http://127.0.0.1:18765`, `resolve.conditions` with `@mcs/source`
  (I-13); `lucide-react` only in `icons.ts`; budget numbers of 04 12.3; the dev check ran under the `dev` lock and was stopped.

#### WP-45 Pure lib port
Phase 4, W4.1, L; impl sonnet high; verify sonnet high; 04 W2
- Goal: Port the legacy pure logic to typed, DOM-free modules with verbatim semantics and the 36 `legacy:` tests plus the new unit tests.
  Nothing in `lib/` imports React, the router or the query library.
- Inputs: 04 section 10, section 11.1 (pure parts), section 5.6 (connection-health model), section 6.1 (contrast pairs); legacy `src/frontend/*.js` and
  `tests/frontend/*.test.mjs` (read-only sources of semantics).
- Creates: `packages/web/src/lib/{format,filters,timeline-model,markdown,prefs,backoff,connection-health,sessions-view,agent-tree,ledger,attempts,url-state,lifecycle-display,shortcuts,clipboard,announce}.ts`
  + colocated tests, `packages/web/src/lib/tokens-contrast.test.ts`.
- Blocks: none.
- Produces: the pure functions of 04 10. Consumes: `@mcs/shared` types only.
- Depends: WP-01; `tokens-contrast.test.ts` and `lifecycle-display.test.ts` read `styles/tokens.css`, so the gate runs after WP-44.
- Tests: 36 `legacy:` tests; `url-state`, `lifecycle-display`, `shortcuts`, `agent-tree`, `connection-health`, `tokens-contrast` tests of 04 11.1.
- Gate: `STD(web)` + `WEB packages/web/src/lib`.
- Verifier: each `legacy:` test maps to a named legacy test (list in the final answer); `lib/**` import rule holds; prefs storage only in `prefs.ts`.
- Cut line: `ledger`, `attempts`, `clipboard`, `announce`, `shortcuts` move to WP-45b.

#### WP-55 Scenario catalogue and testkit CLI
Phase 4, W4.1, M; impl sonnet medium; verify sonnet high; 06 PP6
- Goal: Build the deterministic scenario catalogue (L-* trees and S01-S34) with expectations and the testkit CLI (`list`, `demo`,
  `scenario`, `big`). Spool lines in scenarios come only from the real handler.
- Inputs: 06 6.1-6.5; 05 4.4; 04 11.5; 98 12.1.
- Creates: `packages/testkit/src/scenarios/*`, `packages/testkit/src/cli.ts`; tests `packages/testkit/src/{scenarios,expectations,hooks-scenarios,cli}.test.ts`.
- Blocks: `testkit/src/index.ts` WP-55; `pkg:` `testkit`.
- Produces: `ScenarioId`, `ScenarioSession`, `ScenarioResult`, `buildScenario`, `listScenarios`, testkit CLI. Consumes: WP-42, WP-06, WP-25.
- Depends: WP-25, WP-42.
- Tests: 06 6.5 rows `scenarios`, `expectations`, `hooks-scenarios`, `cli`.
- Gate: `STD(testkit)` + `UNIT packages/testkit/src/scenarios.test.ts packages/testkit/src/expectations.test.ts packages/testkit/src/hooks-scenarios.test.ts packages/testkit/src/cli.test.ts`.
- Verifier: two builds give identical `treeManifest`; the CLI refuses a real Claude home, a non-empty dir and ports outside 18900-18999;
  expectations recomputed by an independent reader inside the test.

#### WP-46 Data layer
Phase 4, W4.2, L; impl sonnet high; verify opus xhigh; 04 W3
- Goal: Implement the typed API client with the error-code table, endpoint tracking, query keys, the TanStack Query client, cursor
  infinite queries, every data hook and the fake API and render helpers that validate fixtures against the shared contracts.
- Inputs: 04 5.1-5.4, section 13, section 11 (fake api, render, fixtures); 03 5.2-5.5, section 6.1; 06 3.3 (`usePanel`); 98 C26; 99 I-10, N-09.
- Creates: `packages/web/src/data/{api-client,endpoint-tracker,api-errors,endpoints,query-keys,query-client}.ts`,
  `packages/web/src/data/hooks/{useInstance,useHealth,useOverview,useSessions,useSession,useAgents,useTimeline,useActivity,useWorkItems,useAnalytics,useConfigInspection,usePanel,useTranscriptSearch}.ts`,
  `packages/web/src/lib/panel-status.ts`, `packages/web/src/test/{fake-api.ts,render.tsx}`, `packages/web/src/test/fixtures/*.ts`; tests
  `packages/web/src/data/{api-client,query-keys}.test.ts`, `packages/web/src/data/hooks/hooks.test.tsx`, `packages/web/src/lib/panel-status.test.ts`.
- Blocks: none.
- Produces: `createApiClient`, `ApiError` mapping, `qk.*`, data hooks, `createFakeApi`, `renderWithProviders`, fixture factories.
  Consumes: WP-03 route registry and schemas, WP-02 `ConfigInspection`.
- Depends: WP-02, WP-03, WP-44.
- Tests: W3 done-when (api-client incl. the 04 5.1 error-code table, hooks with the fake API, contract failures surfaced,
  `panel-status.test.ts`).
- Gate: `STD(web)` + `WEB packages/web/src/data packages/web/src/lib/panel-status.test.ts`.
- Verifier: `fetch` only in `api-client.ts`; fixtures start with `// FIXTURE: invented data for tests`; no contract redeclared (I-10);
  git/ledger/chainLog panels poll with `poll.overviewMs` (N-09).
- Cut line: `hooks/*` move to WP-46b (deps WP-46).

#### WP-47 Stream client and reconciliation
Phase 4, W4.3, M; impl opus xhigh; verify fable; 04 W4 (stream part)
- Goal: Implement the EventSource client state machine with epoch and gap handling, reconnect backoff and watchdog, the reconciliation of
  change frames into the query cache with the patch ledger, live buffers with pause/resume, and the freshness hook.
- Inputs: 04 5.5, section 5.6 (stream client, freshness), section 5.7; 03 9.2-9.5; ADR 0032, 0033; 99 F-11.
- Creates: `packages/web/src/stream/{stream-client,StreamProvider,reconcile,patch-ledger,live-buffer,freshness,useFreshness}.ts(x)`,
  `packages/web/src/test/fake-event-source.ts`; tests `packages/web/src/stream/{stream-client,reconcile,patch-ledger,live-buffer,freshness}.test.ts`.
- Blocks: none.
- Produces: `createStreamClient`, `StreamProvider`, reconcile dispatch for every 03 9.2 kind, `useFreshness`. Consumes: WP-46, WP-03 stream schemas.
- Depends: WP-46.
- Tests: every row of the 04 5.6 state table (incl. epoch rows), one reconcile test per 04 5.5 dispatch row, ledger and live-buffer tests.
- Gate: `STD(web)` + `WEB packages/web/src/stream`.
- Verifier: `EventSource` only in `stream-client.ts`; duplicate seq ignored, gap triggers one resync; `stop()` leaves zero timers; no
  `config` kind; adversarial: interleaved reset/heartbeat/hello, queue overflow at 1001, epoch change mid-replay.

#### WP-49 Shell, sidebar, prefs
Phase 4, W4.3, L; impl sonnet high; verify sonnet high; 04 W5
- Goal: Implement the application shell, sidebar navigation and session list, preference controls and store, shortcuts, skip links, the
  instance-changed notice and the legacy hash redirect. Keyboard and screen-reader behaviour follow 04 6.5-6.6.
- Inputs: 04 3.3, section 4.1, section 4.4 (shell rows), section 6.5, section 6.6, section 9; ADR 0036.
- Creates: `packages/web/src/shell/{AppShell,Sidebar,SidebarNav,SidebarSessionList,PrefsControls,ShortcutsDialog,SkipLinks,InstanceChangedNotice}.tsx`,
  `packages/web/src/state/{prefs-store.ts,announcer.tsx,shortcuts-registry.tsx,toast-store.ts}`, `packages/web/src/app/LegacyHashRedirect.tsx`;
  tests `AppShell.test.tsx`, `SidebarSessionList.test.tsx`, `LegacyHashRedirect.test.tsx`, `prefs-store.test.ts`.
- Blocks: `routes.tsx` WP-49, `pages.css` WP-49.
- Produces: shell components, prefs store (`mcs.ui.v3`, one-time `ccm.prefs.v1` import). Consumes: WP-45, WP-46.
- Depends: WP-45, WP-46.
- Tests: W5 done-when (shell component tests, legacy hash, prefs import).
- Gate: `STD(web)` + `WEB packages/web/src/shell packages/web/src/state packages/web/src/app/LegacyHashRedirect.test.tsx`.
- Verifier: `ccm.prefs.v1` read once and never written; roving tabindex and focus rules of 04 6.6; storage only via `lib/prefs.ts`.
- Cut line: `ShortcutsDialog` + `shortcuts-registry` move to WP-49b.

#### WP-51 Transcript viewer and text primitives
Phase 4, W4.3, L; impl sonnet high; verify fable; 04 W7 (part)
- Goal: Implement the safe Markdown subset renderer and the text primitives, and the transcript viewer with its window reducer, scroll
  anchoring, follow mode, tool-unit pairing and the transcript search results list against the shared contract.
- Inputs: 04 4.4.3 (must-preserve #14-#27), section 5.4, section 8, section 6.6; 03 7.3-7.4 (shapes); ADR 0031, 0034, 0038.
- Creates: `packages/web/src/components/{Markdown,ClampedText,CopyButton,Disclosure}.tsx`,
  `packages/web/src/transcript/{TranscriptViewer,TranscriptToolbar,TranscriptRow,ToolUnitRow,TranscriptSearchResults,PartialBanner,ResumeFollowButton}.tsx`,
  `packages/web/src/transcript/{useTranscriptWindow,transcript-reducer,useScrollAnchor}.ts`; tests `Markdown.test.tsx`, `CopyButton.test.tsx`,
  `TranscriptViewer.test.tsx`, `transcript-reducer.test.ts`.
- Blocks: `components.css` WP-51, `transcript.css` WP-51.
- Produces: `TranscriptViewer`, `Markdown`, primitives. Consumes: WP-45 (`markdown.ts`, `timeline-model.ts`), WP-46.
- Depends: WP-45, WP-46.
- Tests: W7 detail and transcript tests for these files; hostile Markdown inputs of 04 8.
- Gate: `STD(web)` + `WEB packages/web/src/components/Markdown.test.tsx packages/web/src/components/CopyButton.test.tsx packages/web/src/transcript`.
- Verifier: no `dangerouslySetInnerHTML`, no computed `href` (lint and audit); links only from the allow-listed schemes of 04 section 8;
  adversarial: script, `javascript:` links, bidi controls, giant lines, 5,000-entry windows (O-2 perf measured in WP-56).
- Cut line: `TranscriptSearchResults` + `TranscriptToolbar` move to WP-51b.

#### WP-48 Connection and freshness UI
Phase 4, W4.4, M; impl sonnet high; verify sonnet high; 04 W4 (shell part)
- Goal: Implement the top bar with the connection and ingestion chips, health details and the stale-data indicator, driven only by the
  pure connection model and server health. Connectivity and ingestion health are shown separately (UI-I4).
- Inputs: 04 5.6 (connection model, ingestion view, what the user sees), section 6.6, section 7; ADR 0033; 98 C50.
- Creates: `packages/web/src/shell/{TopBar,ConnectionChip,IngestionChip,HealthDetails}.tsx`, `packages/web/src/components/StaleDataIndicator.tsx`;
  tests `TopBar.test.tsx`, `StaleDataIndicator.test.tsx`.
- Blocks: `components.css` WP-48.
- Produces: chips and indicator. Consumes: WP-45 `connection-health`, WP-47 `useFreshness`.
- Depends: WP-45, WP-47.
- Tests: TopBar matrix tests (04 11.2).
- Gate: `STD(web)` + `WEB packages/web/src/shell/TopBar.test.tsx packages/web/src/components/StaleDataIndicator.test.tsx`.
- Verifier: the ingestion chip never says OK while not in sync; `staleAfterMs` from `InstanceInfo` (C50); retry countdown on fake timers.

#### WP-50 Sessions explorer and list components
Phase 4, W4.4, L; impl sonnet high; verify sonnet high; 04 W6
- Goal: Implement the sessions explorer with URL-driven filters, sorting, load-more pagination and in-place stream patches, plus the
  shared list components it introduces. Rows stay visible when a refetch fails (UI-I5).
- Inputs: 04 3.2, section 4.3, section 4.4 (explorer rows), section 5.3, section 7, section 6.6; 03 5.3-5.4.
- Creates: `packages/web/src/pages/sessions/{SessionExplorerPage,SessionFilterBar,SessionTable,SessionRow}.tsx`,
  `packages/web/src/components/{FilterBar,DataTable,LoadMore,TokenLine,TokenSummary,RelativeTime}.tsx`; tests `SessionExplorerPage.test.tsx`,
  `DataTable.test.tsx`, `FilterBar.test.tsx`.
- Blocks: `routes.tsx` WP-50, `pages.css` WP-50, `components.css` WP-50.
- Produces: explorer page and list components. Consumes: WP-47, WP-49.
- Depends: WP-47, WP-49.
- Tests: W6 explorer tests (04 11.2 row).
- Gate: `STD(web)` + `WEB packages/web/src/pages/sessions packages/web/src/components/DataTable.test.tsx packages/web/src/components/FilterBar.test.tsx`.
- Verifier: filter change aborts the previous request; `aria-sort` and URL in sync; capped note at 10 pages; token numbers never 0 for missing.
- Cut line: `TokenLine`, `TokenSummary`, `RelativeTime` move to WP-50b.

#### WP-54 Overview page
Phase 4, W4.4, M; impl sonnet high; verify sonnet medium; 04 W9 (part)
- Goal: Implement the overview page with metric tiles (value, source, rule, completeness), recent activity and errors, and the ingestion
  summary. Tiles show only metrics the server returns; nothing is fabricated.
- Inputs: 04 4.4.1, section 7; 03 8.1; foundations C5.
- Creates: `packages/web/src/pages/overview/{OverviewPage,MetricTile,MetricGrid,RecentErrors,IngestionSummary}.tsx`,
  `packages/web/src/components/{Meter,InfoTip}.tsx`; tests `OverviewPage.test.tsx` (plan-assigned name), `Meter.test.tsx`.
- Blocks: `routes.tsx` WP-54, `pages.css` WP-54, `components.css` WP-54.
- Produces: overview page. Consumes: WP-46 `useOverview`, `useHealth`, WP-49 shell.
- Depends: WP-46, WP-49.
- Tests: tiles render the server metrics only; missing metric rows render as absent, not zero; meter ARIA.
- Gate: `STD(web)` + `WEB packages/web/src/pages/overview packages/web/src/components/Meter.test.tsx`.
- Verifier: `InfoTip` shows `source` and `rule` verbatim; panels are not part of this WP (WP-65).

#### WP-52 Session detail page
Phase 4, W4.5, M; impl sonnet high; verify sonnet high; 04 W7 (part)
- Goal: Implement the session detail page with header and evidence, tabs bound to the URL, timeline, agent tree, tokens, errors and audit
  references, embedding the transcript viewer. Unknown sessions and agents get the states of 04 3.4 and section 7.
- Inputs: 04 4.4 (detail rows), section 4.4.2, section 3.2, section 3.4, section 7; 03 6.1 (detail routes), section 6.3 (`auditRefs`).
- Creates: `packages/web/src/pages/session-detail/{SessionDetailPage,SessionHeader,SessionTabs,SessionTimeline,TimelineRow,AgentTree,SessionErrors,SessionTokens,AuditRefs}.tsx`;
  tests `SessionDetailPage.test.tsx`, `AgentTree.test.tsx`.
- Blocks: `routes.tsx` WP-52, `pages.css` WP-52.
- Produces: detail page. Consumes: WP-50, WP-51.
- Depends: WP-50, WP-51.
- Tests: W7 detail tests (04 11.2 `SessionDetailPage` row).
- Gate: `STD(web)` + `WEB packages/web/src/pages/session-detail`.
- Verifier: token source note present; lower-bound labels from `usage.lowerBound`; tabs push `?tab=`.

#### WP-53 Activity feed
Phase 4, W4.5, S; impl sonnet high; verify sonnet high; 04 W8
- Goal: Implement the live activity feed with filters, live prepend from `event/append`, pause and resume with buffered counts and gap
  separators. Duplicate events never appear twice (UI-I6).
- Inputs: 04 4.4.4, section 5.7, section 7; 03 9.2.
- Creates: `packages/web/src/pages/activity/{ActivityPage,ActivityFeed,ActivityRow,ActivityFilterBar}.tsx`; test `ActivityFeed.test.tsx`.
- Blocks: `routes.tsx` WP-53, `pages.css` WP-53.
- Produces: activity page. Consumes: WP-47, WP-50.
- Depends: WP-47, WP-50.
- Tests: W8 feed tests incl. pause/resume.
- Gate: `STD(web)` + `WEB packages/web/src/pages/activity`.
- Verifier: overflow message and refetch on resume with drops; `monitor.gap` rendered as a separator.

#### WP-56 Cross-stack tests and Phase 4 E2E smoke
Phase 4, W4.6, M; impl sonnet high; verify opus xhigh; 04 11.3, 04 W14 (part)
- Goal: Prove the web data model against the real server (API-to-web contract, stream reconnect, panels contract) and run the Phase 4
  browser smoke through real CLI-started instances and real handler deliveries. Measure the transcript render cost (O-2).
- Inputs: 04 11.3, section 11.4 (steps 1-6, 8-12), section 11.5; 02 9.3; 05 4.12; 01 6.3 (init, hooks enable, start, stop); 98 C25, C31, C58;
  99 I-02, I-11, I-27, N-02.
- Creates: `packages/server/test/{api-to-web,stream-reconnect,panels.contract}.int.test.ts`, `packages/web/e2e/playwright.config.ts`
  (replaces the withdrawn A.28; no `webServer`), `packages/web/e2e/global-setup.ts`, `packages/web/e2e/specs/lifecycle.spec.ts`,
  `packages/web/e2e/specs/transcript-perf.spec.ts` (O-2, plan-assigned).
- Blocks: creates `lifecycle.spec.ts` with blocks WP-57 (step 7) and WP-71 (steps 13-14).
- Produces: E2E harness. Consumes: WP-19, WP-25, WP-30, WP-31, WP-33, WP-36, WP-38, WP-41, WP-48, WP-52, WP-53, WP-54, WP-06 `buildDemo`.
- Depends: WP-19, WP-25, WP-30, WP-31, WP-33, WP-36, WP-38, WP-41, WP-48, WP-52, WP-53, WP-54.
- Tests: brief 14 "API to frontend data model", "realtime reconnect and reconciliation"; DA-T-RT-12; E2E steps 1-6, 8-12; O-2 measured.
- Gate: `STD(server, e2e)` + `INT packages/server/test/api-to-web.int.test.ts packages/server/test/stream-reconnect.int.test.ts packages/server/test/panels.contract.int.test.ts`
  + `E2E specs/lifecycle.spec.ts specs/transcript-perf.spec.ts`.
- Verifier: specs start instances with `$MCS init`/`start` (04 11.4) on `allocatePort([18500, 18599])` ports, never `MCS_E2E_PORT`; hook payloads go through
  `runHookHandler` (never a settings file); `MCS_LAUNCHER_NO_BOOTSTRAP=1` in every spawned env; every instance stopped and port closed;
  `.ndjson` spool glob (C25); `workers: 1`, `retries: 0`.

### Phase 5: advanced features

#### WP-57 Transcript search and E2E step 7
Phase 5, W5.1, M; impl opus xhigh; verify fable; 03 S8, 04 W14 (step 7)
- Goal: Implement the bounded transcript content search (per session and per instance) with time budgets, continuation, cancellation and
  a search semaphore, and its routes. Wire E2E step 7 to the real search.
- Inputs: 03 7.4, section 7.5, section 6.1 (rows searchTranscript, searchTranscripts), section 22 O-1; 04 11.4 step 7; ADR 0023; 99 F-5.
- Creates: `packages/engine/src/search/{scan,service}.ts`, `packages/server/src/routes/search.ts`; tests `packages/engine/src/search/scan.test.ts`,
  `packages/engine/test/search.int.test.ts`.
- Blocks: `query/index.ts` WP-57, `app.ts` WP-57, `engine/src/index.ts` WP-57, `lifecycle.spec.ts` WP-57 (step 7).
- Produces: `TranscriptQueries.{searchSession,searchInstance}`, routes `searchTranscript`, `searchTranscripts`. Consumes: WP-33, WP-51, WP-56.
- Depends: WP-33, WP-51, WP-56.
- Tests: DA-T-S-1..6, 10; E2E step 7; O-1 measured (cold-cache scan) and reported to the lead for ADR 0023.
- Gate: `STD(engine, server, e2e)` + `UNIT packages/engine/src/search` + `INT packages/engine/test/search.int.test.ts` + `E2E specs/lifecycle.spec.ts`.
- Verifier: query text never logged (DA-T-PRIV-4 precondition); coverage honesty (`complete`, `filesMissing`, `stoppedBy`); third
  concurrent search -> `429 search_busy`; abort frees the semaphore within one block; adversarial: escaped needles, JSON unicode escapes in files
  (built from code points in the test, never typed as escapes in tool input), path escapes.

#### WP-58 Analytics, cost, session usage, overview token metrics
Phase 5, W5.1, M; impl sonnet high; verify opus xhigh; 03 S9
- Goal: Implement usage aggregation, time series, tool frequency, configured-price cost estimates and the metric catalogue, with their
  routes, the `sessionUsage` route and the token and cost rows of the overview.
- Inputs: 03 8.1-8.4, section 6.1 (rows analyticsUsage, analyticsSeries, analyticsTools, sessionUsage); 02 6.2-6.6; foundations D15
  (prices only from config); 98 10.3.
- Creates: `packages/engine/src/analytics/{usage,series,tools,cost,metrics}.ts`, `packages/server/src/routes/analytics.ts`; tests
  `packages/engine/src/analytics/{usage,series,tools,cost,metrics}.test.ts`, `packages/engine/test/analytics.int.test.ts`.
- Blocks: `query/index.ts` WP-58, `query/overview.ts` WP-58, `routes/sessions.ts` WP-58, `app.ts` WP-58, `engine/src/index.ts` WP-58.
- Produces: `EngineQueries.{usage,sessionUsage,series,tools}`, routes of 03 6.1, metric rows `tokens.*`, `cost.*`. Consumes: WP-27, WP-30, WP-31.
- Depends: WP-27, WP-30, WP-31.
- Tests: DA-T-A-1..7.
- Gate: `STD(engine, server)` + `UNIT packages/engine/src/analytics` + `INT packages/engine/test/analytics.int.test.ts`.
- Verifier: worked-example totals exact; no default price table shipped; cost labelled estimate and `partial` when a model is unpriced;
  empty buckets absent; `range_too_large` above 2,000 buckets.

#### WP-59 Alerts
Phase 5, W5.1, M; impl sonnet high; verify opus xhigh; 03 S10
- Goal: Implement alert rules, the evaluator with de-duplication and cooldown, and the alert service fed by ingestion health inputs after
  commit. Alert evaluation can never break ingestion.
- Inputs: 03 10.1-10.4, section 11.4 (alert sweep); 02 8.3; ADR 0027.
- Creates: `packages/engine/src/alerts/{rules,evaluator,service}.ts`; tests `packages/engine/src/alerts/{rules,evaluator,service}.test.ts`,
  `packages/engine/test/alerts.int.test.ts`.
- Blocks: `instance-runtime.ts` WP-59, `schedule.ts` WP-59 (alert sweep), `engine/src/index.ts` WP-59.
- Produces: alert rules, evaluator, service, `alert/upsert` changes. Consumes: WP-31, WP-35 (alert inputs), WP-36.
- Depends: WP-31, WP-35, WP-36.
- Tests: DA-T-AL-1..5.
- Gate: `STD(engine)` + `UNIT packages/engine/src/alerts` + `INT packages/engine/test/alerts.int.test.ts`.
- Verifier: evaluator exceptions land in `ingest_errors` with source `alerts` and the ingest transaction still commits; one open alert per
  rule and scope; no outbound webhook code (D15).

#### WP-60 Export and data retention
Phase 5, W5.1, M; impl opus xhigh; verify fable; 03 S11 (part)
- Goal: Implement the `mcs.export/1` JSONL export from a consistent snapshot, explicit data retention with dry run, and the automatic
  bookkeeping retention timer. Data deletion never touches active or pinned sessions.
- Inputs: 03 3.8, section 11.1-11.3, section 11.4 (bookkeeping retention), section 6.1 (row export); 01 1.1 (`data/exports/`), section 6.4 (`export`); ADR 0028; 98 C39.
- Creates: `packages/engine/src/maintenance/{export,retention}.ts`, `packages/server/src/routes/export.ts`; tests
  `packages/engine/src/maintenance/retention.test.ts`, `packages/engine/test/maintenance-{export,retention}.int.test.ts`.
- Blocks: `schedule.ts` WP-60, `app.ts` WP-60, `engine/src/index.ts` WP-60.
- Produces: `exportInstance`, retention plan/apply, route `export`. Consumes: WP-09 (backup snapshot), WP-30, WP-33, WP-35.
- Depends: WP-09, WP-30, WP-33, WP-35.
- Tests: DA-T-E-1, 2, 4, 5.
- Gate: `STD(engine, server)` + `UNIT packages/engine/src/maintenance/retention.test.ts` + `INT packages/engine/test/maintenance-export.int.test.ts packages/engine/test/maintenance-retention.int.test.ts`.
- Verifier: dry run changes nothing (sha256); `attempt_runs` never removed by the automatic run; temp snapshot deleted on abort;
  `includeContent` refused in strict mode; adversarial: retention during ingestion, aborted export stream.

#### WP-63 Legacy delegation and cross-engine tests
Phase 5, W5.1, M; impl sonnet high; verify opus xhigh; 01 S15
- Goal: Implement delegation to the legacy engine for `engine: legacy` instances and legacy flags, and the cross-engine tests that prove
  both engines can share a workspace safely. Only viewers started by the tests are ever stopped.
- Inputs: 01 4.14, section 6.5, section 3.5 (T-XE-03..07, T-ISO-23), section 6.7 (T-CLI-07); 99 I-02 (legacy audit with `.ndjson`), N-07.
- Creates: `packages/engine/src/ops/legacy.ts` + `legacy.test.ts`, `tests/parity/cross-engine.parity.test.ts` (plan-assigned instead of
  `tests/legacy-parity/cross-engine/*`, which cannot resolve `@mcs/*`, N-07).
- Blocks: `ops/lifecycle.ts` WP-63, `cli/src/main.ts` WP-63 (legacy flag delegation), `ownership-isolation.test.ts` WP-63 (T-ISO-23),
  `engine/src/index.ts` WP-63.
- Produces: `ops.legacy.*`, delegation branch. Consumes: WP-19, WP-20, WP-24 (Python discovery helpers if shared).
- Depends: WP-19, WP-20, WP-24.
- Tests: T-XE-03..07, T-ISO-23, T-CLI-07.
- Gate: `STD(engine, cli, tests)` + `UNIT packages/engine/src/ops/legacy.test.ts` + `PAR tests/parity/cross-engine.parity.test.ts` + `ISO tests/isolation/ownership-isolation.test.ts`.
- Verifier: legacy viewers only in temp workspaces on 18850-18874; skipped with a recorded reason when Python >= 3.8 is missing; the live
  monitor's process and workspace are never listed or touched (grep the tests for real paths and 8765).

#### WP-65 Workspace panels UI
Phase 5, W5.1, M; impl sonnet high; verify sonnet medium; 04 W9 (part)
- Goal: Implement the config-driven workspace panels (machine, git, attempts, ledger, chain log, logs) with per-panel status from
  `PanelResponse`, persisted collapse and narrow-screen defaults.
- Inputs: 04 4.4.1 (panels), section 5.2 (`usePanel`), section 7; 06 3.3, section 3.4; 98 C26.
- Creates: `packages/web/src/panels/{WorkspacePanels,PanelFrame,MachinePanel,GitPanel,AttemptsPanel,LedgerPanel,ChainLogPanel,LogsPanel}.tsx`;
  test `WorkspacePanels.test.tsx`.
- Blocks: `pages.css` WP-65, `panels.css` WP-65.
- Produces: panels UI mounted on the overview page. Consumes: WP-41 (contract), WP-46 `usePanel`, WP-54.
- Depends: WP-41, WP-46, WP-54.
- Tests: `WorkspacePanels.test.tsx` rows of 04 11.2.
- Gate: `STD(web)` + `WEB packages/web/src/panels`.
- Verifier: `404 panel_disabled` removes the panel; `partial` shows source notes; meters have ARIA values.

#### WP-66 Task board and analytics UI
Phase 5, W5.1, M; impl sonnet high; verify sonnet medium; 04 W10, 04 W11
- Goal: Implement the work-item board (route `/tasks`) with the six board states and evidence, and the analytics page whose trend chart
  appears only when the server enables it. Missing usage reads "not available", never 0.
- Inputs: 04 4.4.5, section 4.4.6, section 7; 03 8.1-8.4 (shapes), section 6.1 (workItemBoard); dataviz guidance for the one trend chart.
- Creates: `packages/web/src/pages/work-items/{WorkItemBoardPage,WorkItemColumn,WorkItemCard}.tsx`,
  `packages/web/src/pages/analytics/{AnalyticsPage,UsageTable,UsageOverTime,ToolFrequency}.tsx`; tests `WorkItemBoardPage.test.tsx`, `AnalyticsPage.test.tsx`.
- Blocks: `routes.tsx` WP-66, `pages.css` WP-66.
- Produces: board and analytics pages. Consumes: WP-50, WP-46.
- Depends: WP-50.
- Tests: the two 04 11.2 rows.
- Gate: `STD(web)` + `WEB packages/web/src/pages/work-items packages/web/src/pages/analytics`.
- Verifier: the request sends `workItem`; cost hidden when null and labelled estimate otherwise; partial buckets hatched and labelled.

#### WP-67 Settings and health UI
Phase 5, W5.1, M; impl sonnet high; verify sonnet medium; 04 W12
- Goal: Implement the settings page sections: health (ingestion block from health only, alerts), config inspection with source tags and
  file statuses, preferences, data retention information and about, with copyable commands from `instance.commands`.
- Inputs: 04 4.4.7, section 7, section 9; 01 6.4 (`ConfigInspection`), section 6.6 (`instance.commands`); 03 6.2, section 10.3.
- Creates: `packages/web/src/pages/settings/{SettingsPage,HealthPanel,ConfigInspector,PreferencesForm,DataRetention,AboutSection}.tsx`;
  tests `SettingsPage.test.tsx`, `HealthPanel.test.tsx`.
- Blocks: `routes.tsx` WP-67, `pages.css` WP-67.
- Produces: settings page and `/health` redirect target. Consumes: WP-48, WP-46.
- Depends: WP-48.
- Tests: the 04 11.2 rows.
- Gate: `STD(web)` + `WEB packages/web/src/pages/settings`.
- Verifier: read-only UI (no mutating request, ADR 0031); commands copied verbatim; `ConfigInspection.entries[].source` tags.

#### WP-61 Readers, data CLI, verify-completion
Phase 5, W5.2, M; impl sonnet high; verify opus xhigh; 01 S13a, 01 S13b, 03 S12
- Goal: Implement `InstanceReader` in API mode (running instance) and DB mode (stopped, read-only) over the same engine queries, and the
  CLI commands `sessions list|show`, `usage`, `export`, `errors` and `verify-completion`.
- Inputs: 01 6.1 (`InstanceReader`), section 6.3-6.4 (rows), section 6.7; 03 12.1, section 12.2; 02 7.13; 98 C16, C21; 99 I-08, I-19, N-08.
- Creates: `packages/engine/src/ops/data.ts`, `packages/engine/src/reader/{api-reader,db-reader}.ts`,
  `packages/cli/src/commands/{sessions,usage,export,errors,verify-completion}.ts`; tests `packages/engine/test/readers.int.test.ts`
  (DA-T-CLI-1 with T-CLI-05), `packages/cli/test/{export,verify-completion}.int.test.ts` (plan-assigned).
- Blocks: `cli/src/main.ts` WP-61, `shared/src/cli/results.ts` WP-61, `engine/src/index.ts` WP-61.
- Produces: `openInstanceReader`, `ApiReader`, `DbReader`, data ops. Consumes: WP-29, WP-30, WP-60, WP-19 (probe), WP-15.
- Depends: WP-15, WP-19, WP-29, WP-30, WP-60.
- Tests: T-CLI-05, T-CLI-08, T-CLI-13, DA-T-CLI-1, CE-17.
- Gate: `STD(engine, cli)` + `INT packages/engine/test/readers.int.test.ts packages/cli/test/export.int.test.ts packages/cli/test/verify-completion.int.test.ts`.
- Verifier: identical JSON in both modes except `asOfSeq` and time-relative fields; the DB reader never writes (sha256 and mtime);
  `export --out <ws>/logs/x.jsonl` refused; `CompletionTargetError` mapping to `USAGE`/`NOT_FOUND` (C16).

#### WP-62 Backup, upgrade, DB migrate and rebuild, cleanup, config migrate
Phase 5, W5.2, L; impl opus xhigh; verify fable; 01 S12
- Goal: Implement backup create/list/restore, explicit upgrade with backup-first DB migrations, `db migrate`, the guarded `db rebuild`,
  scoped cleanup and `config migrate`, all dry-run by default and audited. User-owned files are never rewritten.
- Inputs: 01 5.4-5.8, section 2.7, section 6.3-6.4 (rows backup, upgrade, db, cleanup, config migrate), section 3.5 (T-ISO-06 rows, 15, 24-27), section 7.2;
  03 4.3, section 4.4, section 11.2; ADR 0009, 0021, 0028; 98 C39, C44.
- Creates: `packages/engine/src/ops/{backup,upgrade,cleanup}.ts`, `packages/cli/src/commands/{backup,upgrade,db,cleanup,config-migrate}.ts`;
  tests `packages/engine/src/ops/upgrade.test.ts`, `packages/cli/test/{backup,upgrade,db-rebuild,cleanup}.int.test.ts` (plan-assigned),
  `tests/isolation/upgrade-isolation.test.ts`; fixture `packages/cli/test/fixtures/workspaces/older-runtime/**`.
- Blocks: `cli/src/main.ts` WP-62, `shared/src/cli/results.ts` WP-62, `engine/src/index.ts` WP-62, `config-write-isolation.test.ts`
  WP-62 (T-ISO-06 rows), `lifecycle-isolation.test.ts` WP-62 (T-ISO-15).
- Produces: `ops.backup.*`, `ops.upgrade.{run,migrateDb,rebuildDb}`, `ops.cleanup.run`, `config migrate` command. Consumes: WP-09, WP-12, WP-19, WP-60.
- Depends: WP-09, WP-12, WP-19, WP-60.
- Tests: T-UP-05..09, T-ISO-15, 24, 25, 26, 27 (integration part), T-CLI-06, T-CLI-12, T-ISO-06 rows.
- Gate: `STD(engine, cli, tests)` + `UNIT packages/engine/src/ops/upgrade.test.ts` + `INT packages/cli/test/backup.int.test.ts packages/cli/test/upgrade.int.test.ts packages/cli/test/db-rebuild.int.test.ts packages/cli/test/cleanup.int.test.ts`
  + `ISO tests/isolation/upgrade-isolation.test.ts tests/isolation/config-write-isolation.test.ts tests/isolation/lifecycle-isolation.test.ts`.
- Verifier: backup before the first DB change; a failing migration restores the DB and writes no audit entry; `config.json`, `task.json`,
  `README.md` bytes equal after upgrade; old audit bytes are a prefix; `--confirm <slug>` required for data deletion; a newer DB refused;
  adversarial: kill during migration, restore with a stale `-wal`, manifest of another instance.
- Cut line: `cleanup` + `config migrate` move to WP-62b.

#### WP-68 Benchmarks
Phase 5, W5.2, M; impl sonnet medium; verify sonnet high; 06 PP10
- Goal: Write the benchmark scripts for budgets B1-B7 that run against built outputs and testkit scenarios, and record a first run.
  Results are JSON, gitignored, and reported, never asserted silently.
- Inputs: 06 8.1-8.3; 03 6.2 (HealthReport resource fields); 05 4.5 (ports).
- Creates: `bench/*.mjs` with the script names of 06 8.3 (`bench-first-import.mjs`, `bench-idle.mjs`, `bench-api.mjs` and the rest of
  its table); results go to `bench/results/`, whose `.gitignore` line the lead adds (plan section 4.4, D-13).
- Blocks: `pkg:` `bench`.
- Produces: `npm run bench`. Consumes: WP-17, WP-19, WP-41, WP-55.
- Depends: WP-17, WP-19, WP-41, WP-55.
- Tests: B1-B7 evaluated (pass/fail per budget in the JSON).
- Gate: `STD(tests)` for the scripts (Prettier, ESLint) + `cd $R && node $K/mcslock.mjs run -- sh -c "npm run build && npm run bench"`.
- Verifier: ports 18900-18949 only; every started instance stopped; results under `bench/results/` (gitignored); numbers come from
  `HealthReport` and timers, none invented.

#### WP-64 Read-only MCP server
Phase 5, W5.3, M; impl sonnet high; verify fable; foundations open question 7, R-8.9.10
- Goal: Decide with evidence how a read-only stdio MCP server is built (hand-rolled JSON-RPC versus an SDK dependency) in ADR 0060, then
  implement the read-only tools over `InstanceReader`. Transcript content is returned as data and no tool mutates anything.
- Inputs: foundations 4 Q7, D15; 05 5.2 T16, section 5.6 SEC-29; 01 6.1 (`InstanceReader`); 99 R-8.9.10; current MCP specification
  (context7 or web research, cited in the ADR).
- Creates: `<skill>/docs/decisions/0060-read-only-mcp-server.md`, `packages/cli/src/mcp/*` (server, tool table), `packages/cli/src/commands/mcp.ts`;
  tests `packages/cli/src/mcp/*.test.ts`, `packages/cli/test/mcp.int.test.ts`.
- Blocks: `cli/src/main.ts` WP-64, `shared/src/cli/results.ts` WP-64; a dependency only through the lead's `npm` barrier if the ADR accepts one.
- Produces: `mcs mcp --task S` (stdio). Consumes: WP-61.
- Depends: WP-61.
- Tests: protocol handshake, tool listing, each tool against a fixture instance, refusal of any write-like call, output labelled as data.
- Gate: `STD(cli)` + `UNIT packages/cli/src/mcp` + `INT packages/cli/test/mcp.int.test.ts`.
- Verifier: no tool writes files, settings or config; no network listener (stdio only); terminal-safe output; SEC-29 review note; if the
  ADR defers MCP, the WP ends with the ADR and a CR updating R-8.9.10, and that outcome is accepted.

### Phase 6: regression, E2E, isolation, resilience, docs, release

#### WP-69 Parity L2 A and ported-function vectors
Phase 6, W6.1, L; impl sonnet high; verify opus xhigh; 06 PP8 (part), 06 PP4 (later vectors)
- Goal: Compare the Node engine with the legacy oracle on sessions, events, search and tokens for every committed scenario under the
  frozen clock, and add the vector tests of the functions ported in Phase 3. Every difference is EXACT, MAPPED or a documented DIFF.
- Inputs: 06 5.4-5.7, section 5.8 (D1-D35), section 5.10; 05 4.11.3, section 4.11.5 (PD1-PD7); ADR 0044, 0055; 99 I-09.
- Creates: `tests/parity/legacy-shapes.ts`, `tests/parity/{sessions,events,search,tokens}.parity.test.ts`,
  `tests/parity/vectors/{classify_state,classify_rules,events_of,clip}.parity.test.ts`.
- Blocks: none.
- Produces: L2 comparisons A, legacy-shape projections. Consumes: WP-43 harness, WP-55 scenarios, WP-27, WP-28 (`toLegacy`), WP-30, WP-33,
  WP-34 (`classify`), WP-35 (`ingestUntilIdle` through `createInstanceRuntime`), WP-57.
- Depends: WP-27, WP-28, WP-30, WP-33, WP-34, WP-35, WP-43, WP-55, WP-57.
- Tests: L2 matrix rows for sessions, events, search, tokens (T1-T6); the four vector files.
- Gate: `STD(tests)` + `PAR tests/parity/sessions.parity.test.ts tests/parity/events.parity.test.ts tests/parity/search.parity.test.ts tests/parity/tokens.parity.test.ts tests/parity/vectors`
  + live mode once: `cd $R && node $K/mcslock.mjs run -- sh -c "MCS_PARITY_LIVE=1 npx vitest run --project parity"`.
- Verifier: no blanket skip; every DIFF row asserts the new value explicitly and cites its D/PD id; the Node side runs at
  `FROZEN_NOW_S`; counts exact.
- Cut line: `search.parity.test.ts` + `events_of`/`clip` vectors move to WP-69b.

#### WP-70 Parity L2 B and shadow tool
Phase 6, W6.1, L; impl sonnet high; verify opus xhigh; 06 PP8 (part), 06 PP9
- Goal: Compare attempts, panels, config regexes and workspace files with the oracle, assert every deliberate difference, and build the
  shadow tool that compares both engines on a live task without printing labels.
- Inputs: 06 5.4, section 5.6, section 5.7, section 5.8, section 5.9 (G2), section 5.10; 01 2.8; 98 section 13 (`parity:shadow`).
- Creates: `tests/parity/{attempts,panels,config-regex,workspace-files,diffs}.parity.test.ts`, `scripts/parity-shadow.mjs`, `tests/parity/shadow.test.ts`.
- Blocks: `pkg:` `parity:shadow`.
- Produces: L2 comparisons B, `npm run parity:shadow`. Consumes: WP-43, WP-55, WP-40, WP-41, WP-05, WP-13, WP-19.
- Depends: WP-05, WP-13, WP-19, WP-40, WP-41, WP-43, WP-55.
- Tests: L2 matrix rows for these projections; `diffs.parity.test.ts`; `shadow.test.ts` (`unexplained == 0` on a testkit tree, no label
  text in output, ports 18850-18899, temp removed).
- Gate: `STD(tests)` + `PAR tests/parity/attempts.parity.test.ts tests/parity/panels.parity.test.ts tests/parity/config-regex.parity.test.ts tests/parity/workspace-files.parity.test.ts tests/parity/diffs.parity.test.ts tests/parity/shadow.test.ts`.
- Verifier: the shadow tool reads the target task read-only and is never run by an agent against the owner's live task (G2 runs are the
  lead's, LS-6b); attempts EXACT except D20 rows; config-regex compares only the translator's accept set (PD3).
- Cut line: `scripts/parity-shadow.mjs` + `shadow.test.ts` move to WP-70b.

#### WP-71 E2E completion and accessibility
Phase 6, W6.1, M; impl sonnet high; verify opus xhigh; 04 W14 (rest), 04 11.2 (`a11y.test.tsx`)
- Goal: Finish the browser suite: lifecycle steps 13-14 (ingestion failure shown as degraded), legacy parity, anchoring, same-origin,
  safety, accessibility and screenshots, plus the component-level axe test. Add the pinned `axe-core` dev dependency through the lead.
- Inputs: 04 11.2 (a11y row), section 11.4 (steps 13-14 and other specs), section 6.6; 02 8.2, section 9.3; 05 4.12; ADR 0039.
- Creates: `packages/web/e2e/specs/{legacy-parity,anchor,same-origin,safety,a11y,screenshots}.spec.ts`, `packages/web/src/a11y.test.tsx`.
- Blocks: `lifecycle.spec.ts` WP-71 (steps 13-14); dependency `axe-core` (exact pin) in `packages/web` devDependencies at a lead `npm` barrier.
- Produces: complete E2E suite (G4). Consumes: WP-56, WP-57, WP-65, WP-66, WP-67, WP-35 (ingest health).
- Depends: WP-35, WP-56, WP-57, WP-65, WP-66, WP-67.
- Tests: brief 14 E2E 1-14; 04 11.4 other specs; UI-I1, I3, I13 assertions; axe zero violations (wcag2a, 2aa, 21aa, 22aa).
- Gate: `STD(web, e2e)` + `WEB packages/web/src/a11y.test.tsx` + `E2E specs`.
- Verifier: malformed spool lines appended as raw text only to the newest `.ndjson` segment of a temp workspace; no request leaves the
  origin; screenshots are review aids, not assertions; every instance stopped.

#### WP-72 Security suite
Phase 6, W6.1, L; impl opus xhigh; verify fable; 05 S7
- Goal: Turn the security checklist into executable tests against the real server, CLI, handler and files: Host/Origin/CSRF, limits,
  headers, path containment, privacy canaries, terminal output, subprocess rules, logger allow-list, hook ingest and never-read secrets.
- Inputs: 05 4.10, section 5.1-5.6 (SEC-01..25), section 5.7; 03 5.2, section 14; 02 2.5, section 2.11; 01 section 8; 99 I-04.
- Creates: `tests/security/{host-origin,csrf,limits,headers,path-containment,privacy-canaries,terminal-output,subprocess,logger-allowlist,hook-ingest,secrets-never-read}.test.ts`.
- Blocks: `vitest.config.ts` WP-72 (`security` project), `scripts/ci.mjs` WP-72, `pkg:` `test:security` and the `test` value.
- Produces: the `security` Vitest project and gate. Consumes: WP-07, WP-08, WP-17, WP-19, WP-25, WP-37, WP-57, WP-60, WP-61.
- Depends: WP-07, WP-08, WP-17, WP-19, WP-25, WP-37, WP-57, WP-60, WP-61.
- Tests: SEC-01..25 with every expected code typed `ErrorCode`.
- Gate: `STD(tests)` + `SEC tests/security` + `cd $R && node $K/mcslock.mjs run -- node scripts/ci.mjs --offline` (the `test` gate now includes `security`).
- Verifier: `secrets-never-read.test.ts` hashes the real user settings file and `~/.claude/sessions/*.key` existence only (never content)
  before and after the whole run; canaries scanned as bytes in DB, WAL, spool, logs, audit, exports and captured output; adversarial:
  the verifier adds three probes of its own per control family.
- Cut line: `privacy-canaries` + `secrets-never-read` move to WP-72b.

#### WP-73 Data privacy and data isolation
Phase 6, W6.1, M; impl sonnet high; verify fable; 03 S13, 01 S13a (isolation files)
- Goal: Prove that no content reaches the database or metadata routes, that logs never carry request data, that a crash of one instance
  never touches another, and that reads, tokens and search stay inside their instance.
- Inputs: 03 19.2, section 19.8 (DA-T-E-6), section 21; 01 3.5 (T-ISO-03, 04, 09, 11, 12); 05 4.8 (ISO-1, 3, 4).
- Creates: `tests/security/data-privacy.test.ts`, `tests/isolation/{read-isolation,token-isolation,search-isolation,data-crash-isolation}.test.ts`.
- Blocks: none.
- Produces: tests only. Consumes: WP-20, WP-57, WP-58, WP-60, WP-61.
- Depends: WP-20, WP-57, WP-58, WP-60, WP-61.
- Tests: DA-T-PRIV-1, 2, 4; DA-T-E-6; T-ISO-03, 04, 09, 11, 12.
- Gate: `STD(tests)` + `SEC tests/security/data-privacy.test.ts` + `ISO tests/isolation/read-isolation.test.ts tests/isolation/token-isolation.test.ts tests/isolation/search-isolation.test.ts tests/isolation/data-crash-isolation.test.ts`.
- Verifier: expected values come from the demo builder's expectations, not from the system under test; a sentinel found anywhere fails
  with the file name; ISO-1..9 each have at least one passing test file (list them).

#### WP-74 Resilience suite
Phase 6, W6.1, L; impl sonnet high; verify opus xhigh; 05 S9 (resilience)
- Goal: Exercise partial lines, truncation, rotation, duplicates, out-of-order events, restart recovery, upgrades, partial init,
  concurrency, large files, malformed input, storage errors and the hook fail-safe against the real runtime.
- Inputs: 05 4.9; 02 5.3, section 4.5, section 4.8, section 2.11; 01 4.12, section 4.13, section 5.4; 03 4.3.
- Creates: `tests/resilience/{partial-line,truncation,rotation,duplicates,out-of-order,restart-recovery,upgrade-migrations,partial-init,concurrency,large-file,malformed-input,storage-errors,hook-failsafe}.test.ts`.
- Blocks: none.
- Produces: tests only. Consumes: WP-13, WP-19, WP-25, WP-35, WP-62.
- Depends: WP-13, WP-19, WP-25, WP-35, WP-62.
- Tests: every case of 05 4.9.
- Gate: `STD(tests)` + `RES tests/resilience` + three shuffled seeds: `cd $R && node $K/mcslock.mjs run -- sh -c "for s in 1 2 3; do npx vitest run --project resilience --sequence.shuffle --sequence.seed=$s || exit 1; done"`.
- Verifier: thresholds (memory delta, event-loop p99, bytes re-read) are the design's numbers; storage faults injected, never real disk
  exhaustion; no sleeps; every child stopped.
- Cut line: `upgrade-migrations`, `partial-init`, `storage-errors`, `hook-failsafe` move to WP-74b.

#### WP-75 Release tooling: check-text, check-docs, stress, release-check
Phase 6, W6.1, M; impl sonnet medium; verify sonnet high; 05 S9 (scripts), 05 S10 (`check-docs.mjs`)
- Goal: Implement the English-only and private-data text gate, the docs gate, the shuffled stress runner and the release-check runner that
  writes an honest report, and wire them into `npm run ci`.
- Inputs: 05 3.1, section 3.2, section 5.3 (S-LOG-5), section 6.2, section 6.3, section 6.6, section 7.1, section 7.2, section 8.1; ADR 0049.
- Creates: `scripts/{check-text,check-docs,stress,release-check}.mjs`, `scripts/check-text.allow`; tests `tests/tooling/{check-text,check-docs,release-check}.test.ts`.
- Blocks: `scripts/ci.mjs` WP-75; `pkg:` `check:text`, `check:docs`, `test:stress`, `release-check`.
- Produces: the four scripts and their gates. Consumes: WP-23.
- Depends: WP-23.
- Tests: fixture trees with non-English text, a private-data pattern, a broken link, a missing required heading; release-check writes
  `SKIPPED (<reason>)` rows for steps it did not run.
- Gate: `STD(tests)` + `TOOL tests/tooling/check-text.test.ts tests/tooling/check-docs.test.ts tests/tooling/release-check.test.ts` + `cd $R && npm run check:text`.
- Verifier: `check-docs` validates the 05 6.3 heading table and every backticked path under `runtime/`, `scripts/`, `docs/`, `tests/`;
  `release-check --out` refuses a path inside the repository; no fabricated row.

#### WP-76 Docs A: architecture, data model, hooks, API, CCAM reference
Phase 6, W6.2, L; impl sonnet medium; verify sonnet high; 05 S10
- Goal: Write the final AI-readable docs that explain the system, the data model and lifecycle, the hook pipeline and the API, plus the
  CCAM reference, each claim tied to a code path, schema or test. Generated sections come from the generators.
- Inputs: 05 6.1-6.6; 00; 01 sections 0-4; 02 sections 1-8; 03 sections 3-13; 06 sections 3-4; research `docs/research/ccam-*.md`; the code as built (read it).
- Creates: `<skill>/docs/architecture.md`, `<skill>/docs/data-model.md`, `<skill>/docs/hooks.md`, `<skill>/docs/api.md`, `<skill>/docs/ccam-reference.md`.
- Blocks: none (the names are free after LS-6a).
- Produces: docs answering questions 1, 2, 3, 5, 6, 7, 8 of 05 6.3. Consumes: LS-6a, WP-75, the built system.
- Depends: LS-6a, WP-75, Phases 2-5 complete.
- Tests: `check:docs`, `check:text`.
- Gate: `cd $R && npm run check:docs && npm run check:text` + `END`.
- Verifier: every behaviour claim names its source of truth and that path exists (spot-check 20 claims against the code); diagrams match
  the package map; nothing copied from CCAM; first lines and "Invariants" sections per 05 6.2.
- Cut line: `ccam-reference.md` + `hooks.md` move to WP-76b.

#### WP-77 Docs B: configuration, instance isolation, operations, troubleshooting
Phase 6, W6.2, L; impl sonnet medium; verify sonnet high; 05 S10, 01 S16 (docs), 06 PP11
- Goal: Write the configuration, isolation, operations and troubleshooting docs from the runbook content of 06 section 7, and execute every
  command they show once against a testkit demo instance. Commands must exist in 01 6.3.
- Inputs: 05 6.1-6.3; 01 sections 1-8 and 5.6; 06 7.1, section 7.2; 99 I-12, C44.
- Creates: `<skill>/docs/configuration.md`, `<skill>/docs/instance-isolation.md`, `<skill>/docs/operations.md`, `<skill>/docs/troubleshooting.md`.
- Blocks: none.
- Produces: docs answering questions 4, 5, 9 of 05 6.3; runbook execution log for the migration report (scratch). Consumes: LS-6a, WP-75, WP-22, WP-62.
- Depends: LS-6a, WP-22, WP-62, WP-75.
- Tests: `check:docs`, `check:text`; PP11 check (every command of 06 7.1 and section 7.2 executed on ports 18950-18997 slot, output captured).
- Gate: `cd $R && npm run check:docs && npm run check:text` + the runbook replay script output in `D:/mvp/private/scratch/mcs-v3/runbook/` + `END`.
- Verifier: no `reimport`, `restore --from` or `--include-text` (I-12); `db rebuild` per 01 5.4; every isolation guarantee cites its ISO id.
- Cut line: `troubleshooting.md` moves to WP-77b.

#### WP-78 Docs C: testing, migration, traceability
Phase 6, W6.2, M; impl sonnet medium; verify sonnet high; 05 S10
- Goal: Write the testing guide (commands, layers, fixtures, ports, flake policy and quarantine table), the migration guide with
  rollback and divergences, and the traceability matrix with statuses taken from real test runs.
- Inputs: 05 section 4, section 6.1-6.3, section 7.2, section 7.4; 06 5.8, section 5.9; 99 section 1 (requirement rows).
- Creates: `<skill>/docs/testing.md`, `<skill>/docs/migration.md` (the "Verification report" section is left for the lead in LS-6b),
  `<skill>/docs/traceability.md`.
- Blocks: none.
- Produces: docs answering questions 10 and 11. Consumes: results of WP-69..WP-75.
- Depends: WP-69, WP-70, WP-71, WP-72, WP-73, WP-74, WP-75.
- Tests: `check:docs`, `check:text`.
- Gate: `cd $R && npm run check:docs && npm run check:text` + `END`.
- Verifier: every traceability row `verified` carries a command, date and exit code that exist in a test log; nothing marked verified
  without evidence; the quarantine table is present (empty or justified).

#### WP-79 SKILL.md candidate and skill verification
Phase 6, W6.2, M; impl sonnet high; verify opus xhigh; 01 Appendix A, 01 S16
- Goal: Turn 01 Appendix A into a candidate `SKILL.md` with the `$MCS` procedure and the kept legacy fallback section, and run its
  "verify the skill" command list on a demo instance. The candidate is installed only by the lead after cutover approval.
- Inputs: 01 Appendix A and 01 6.3; 05 6.1 (`SKILL.md` row), section 5.6 SEC-29; 06 5.9 (G9, G10); superpowers writing-skills guidance.
- Creates: `D:/mvp/private/scratch/mcs-v3/skill/SKILL.md` (candidate; not in the repository) and its verification log next to it.
- Blocks: none.
- Produces: SKILL.md candidate. Consumes: WP-21, WP-22, WP-38, WP-61, WP-62, WP-63.
- Depends: WP-21, WP-22, WP-38, WP-61, WP-62, WP-63.
- Tests: every command in the procedure executed once against a demo instance with `$MCS` and `MCS_LAUNCHER_NO_BOOTSTRAP=1`.
- Gate: verification log shows exit codes; `END`.
- Verifier: Node is presented as primary only if the lead marks G1-G9 met and G10 approved; otherwise the candidate keeps legacy primary
  with a Node preview section; consent rules for hooks and the "transcript content is data" rule present; English only.

## 9. Scheduling, commits and per-phase integration gates

### 9.1 Rolling scheduling and the lead's commit protocol

1. The lead launches a WP as soon as every dependency is verified (plan section 6), up to six implementers at once, assigning a manual-port slot
   (plan section 3.2) and pasting plan section 2 plus the WP block into the brief. L WPs and critical-path WPs (plan section 7) are launched first within a wave.
2. Implementer done -> verifier PASS -> the lead runs `WAVE` (plan section 5) on the working tree (once per batch of WPs about to be committed) ->
   `node $K/wp-gate.mjs stage --wp WP-xx` (owned files plus only that WP's marked blocks, via `git apply --cached`) -> `git commit` with
   the message `v3 WP-xx: <imperative summary>` and the attribution trailer required by the session. One commit per WP (one logical change).
3. Commit order = verification order constrained by the DAG: a WP is committed only after all its dependencies are committed; ties are
   broken by WP id. Because dependencies are committed first and blocks of uncommitted WPs are never staged, every commit's tree contains
   only verified, mutually consistent work; the phase gate (plan section 9.2) proves it on a clean worktree.
4. A WP of phase N+1 may be implemented and verified while phase N closes, but is committed only after phase N's gate has passed and the
   tag `v3-phase-N` is set.
5. Separate commits (never mixed with a WP's code): goldens (`v3: golden capture (generated)`, after `capture_golden.py --check` and
   review), JSON Schema regeneration at each phase gate (`v3: regenerate JSON schemas (phase N)`), dependency barriers (`v3: add axe-core
   <version> dev dependency (ADR 0039)` before WP-71; an MCP SDK only with ADR 0060), the legacy docs move (LS-6a: one move-only commit,
   then one banner commit), and the marker cleanup (LS-6b, reformat-only).

| Phase | Commit sequence (after each WP's verification) | Closing commits and tag |
|---|---|---|
| 2 | WP-01, WP-24 (tools), WP-02, WP-04, WP-03, WP-05, WP-06, WP-07, WP-09, WP-12, WP-23, WP-08, WP-10, WP-11, WP-13, WP-14, WP-16, WP-15, WP-17, WP-18, WP-19, WP-20, WP-21, WP-22 | goldens (WP-24 output), schemas regeneration if drift, tag `v3-phase-2` |
| 3 | WP-25, WP-26, WP-30, WP-42, WP-27, WP-28, WP-31, WP-33, WP-37, WP-43, WP-29, WP-32, WP-36, WP-34, WP-38, WP-40, WP-35, WP-41, WP-39 | schemas regeneration, tag `v3-phase-3` |
| 4 | WP-44, WP-45, WP-55, WP-46, WP-47, WP-49, WP-51, WP-48, WP-50, WP-54, WP-52, WP-53, WP-56 | tag `v3-phase-4` |
| 5 | WP-57, WP-58, WP-59, WP-60, WP-63, WP-65, WP-66, WP-67, WP-61, WP-62, WP-68, WP-64 (+ ADR 0060) | schemas regeneration, tag `v3-phase-5` |
| 6 | LS-6a (move, then banners), WP-75, WP-69, WP-70, axe-core barrier, WP-71, WP-72, WP-73, WP-74, WP-76, WP-77, WP-78, WP-79 (candidate stays in scratch) | LS-6b: refreshed goldens if the legacy code changed (it must not), schemas, marker cleanup, migration verification report, ADR statuses, `SKILL.md` install only after G10, tag `v3-phase-6` |

### 9.2 Per-phase integration gates (lead, on a clean worktree of the phase head, never on the shared working tree)

Setup (lead git operation): `git -C $S worktree add --detach $Q HEAD` with `Q=D:/mvp/private/scratch/mcs-v3/qa-wt` (removed afterwards
with `git worktree remove`). All commands run under the `run` lock; Node 24.14.1, and for Phase 6 also the Node 22.22.x and 26 binaries
from `D:/mvp/private/scratch/mcs-v3/nodes/` where present (05 7.1 step 2).

`COMMON` (every phase):
```
cd $Q/runtime && npm ci --offline && node scripts/build-stamp.mjs write-install
node scripts/ci.mjs --offline                       # format, lint, typecheck, deps, test projects, build, smoke; table printed
npm run test:tooling
npm run schemas:check                               # from WP-23 on
cd $Q && PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests && node --test "tests/frontend/*.test.mjs"
git -C $Q diff --exit-code pre-v3-python -- src template config reference SKILL.md ':(glob)docs/*.md' ':(glob)tests/*.py' tests/fixtures tests/frontend tests/tools
node $K/wp-gate.mjs markers --check --root $Q && node $K/wp-gate.mjs ports --check
```
(`docs/*.md` leaves the diff list from LS-6a on; `SKILL.md` only in LS-6b.)

| Phase | Gate = `COMMON` plus | Pass condition |
|---|---|---|
| 2 | `npm run test:isolation`, `npm run test:parity` (PyJson and regex goldens, T-XE-01/02 when Python is present), `PYTHONDONTWRITEBYTECODE=1 python -B tests/legacy-parity/tools/capture_golden.py --check`, `MCS_LAUNCHER_NO_BOOTSTRAP=1 node ../scripts/mcs.mjs version` | ci table: every gate PASS and `smoke` PASS (not SKIPPED); 0 failing tests; golden check identical; launcher prints the version without bootstrapping |
| 3 | `npm run test:isolation`, `npm run test:resilience`, `npm run test:parity`, `npm run parity:check`, `npm run test:coverage` (recorded, not yet blocking) | all PASS; L1 vectors green; ISO rows of WP-20 and WP-39 green; coverage numbers recorded in the phase report |
| 4 | `npm run build` (bundle budget), `npx playwright test -c packages/web/e2e/playwright.config.ts specs/lifecycle.spec.ts specs/transcript-perf.spec.ts` | build within budget; E2E steps 1-6 and 8-12 pass on Chrome; O-2 number recorded |
| 5 | `node scripts/ci.mjs --offline --full` (adds parity and E2E incl. step 7), `npm run build && npm run bench` | all PASS; B1-B7 JSON produced and deviations reported to the owner (not silently accepted) |
| 6 | `npm run release-check -- --out D:/mvp/private/scratch/mcs-v3/release/report.md` (05 7.1 steps 2-9), then `node scripts/ci.mjs --offline --strict`, `npm run test:coverage`, `npm run test:stress`, `MCS_PARITY_LIVE=1 CI=true npm run test:parity`, `npm run test:e2e`, `npm run check:docs`, `npm run check:text` | every row PASS or an explicit SKIPPED row with reason that the owner accepts; coverage thresholds of 05 4.13 met; 3 seeds green; parity divergences only PD1-PD7 / D-rows; quarantine table empty for release-blocking layers; steps 10-12 of 05 7.1 reviewed |

A phase gate failure: the lead files the failure against the WP that owns the failing file, resumes that WP's implementer, re-verifies,
re-runs the full phase gate. No phase N+1 commit lands before the gate is green (plan section 12 rule 10).

## 10. Deviations from the design slice tables (each is a planning choice; the designs' normative content is unchanged)

| # | Plan choice | Slices | Reason |
|---|---|---|---|
| D-01 | Merged into one WP | 03 S3 + 06 PP0 (WP-03); 01 S2 + S3 (WP-05); 05 S2 + S3 (WP-06); 06 PP1 + 01 S4 (WP-07); 02 I-3 + I-5 (WP-26); 02 I-7b + 03 S5b (WP-29); 04 W10 + W11 (WP-66); 01 S13a + S13b + 03 S12 (WP-61); 06 PP8b + PP9 (WP-70) | same files or one feature end to end; 06 PP0 allows "same change"; 99 section 3 merges 01 S4 with 06 PP1 |
| D-02 | Split | 03 S2 (WP-10, WP-11); 01 S7 (WP-14, WP-15); 01 S8 (WP-16, WP-18); 03 S5 (WP-30, WP-31); 02 I-8 (WP-34, WP-35); 04 W4 (WP-47, WP-48); 04 W7 (WP-51, WP-52); 04 W9 (WP-54, WP-65); 04 W14 (WP-56, WP-57, WP-71); 06 PP8 (WP-69, WP-70); 05 S1 (WP-01, WP-23); 05 S9 (WP-20, WP-74, WP-75); 01 S16 (WP-23, WP-77, WP-79, LS-6b) | the 8-file / two-layer rule (plan section 1) |
| D-03 | 03 S4 placed between the two halves of 01 S8 | WP-16 -> WP-17 -> WP-18 | the server boot wires `createApp`; this order avoids a stub app and keeps 03 S4's dependency on the composition root |
| D-04 | 03 S11 `schedule.ts` moved to Phase 3 (WP-35) | 03 S11 | its timers (health refresh 5 s, throttled announcements 1 s, liveness, WAL checkpoint, optimize) feed ingestion health, the stream and the Phase 4 E2E; alert sweep and retention timers are added by WP-59/WP-60 through marked blocks |
| D-05 | Overview page moved to Phase 4 (WP-54) | 04 W9 | Phase 4 E2E step 3 asserts overview tiles; the panels part stays in Phase 5 (WP-65) |
| D-06 | Panels backend in Phase 3 | 06 PP7 (designed 4-5) | the lead's phase list puts "panels port" in Phase 3; the panels UI stays in Phase 5 |
| D-07 | Parity foundations early | 06 PP2 Phase 2 (WP-24); 06 PP3, 05 S8, 06 PP4 Phase 3 (WP-42, WP-43) | early regression signal (plan section 11 R7); the lead's Phase 6 item "parity harness + golden capture" is the L2 suite, the shadow tool and the final capture (WP-69, WP-70, LS-6b) |
| D-08 | Vector tests of ported functions moved | 06 PP4 "added by the porting slice": `classify_state`, `classify_rules`, `events_of`, `clip` -> WP-69 | the ingestion WPs do not wait on the parity harness; `external_state` stays in WP-40 as 06 PP5 lists it |
| D-09 | Scenario catalogue in Phase 4 | 06 PP6 (3-4) -> WP-55 | needs the handler (WP-25) and the legacy builders (WP-42) |
| D-10 | Data isolation files moved to Phase 6 | 01 S13a `read-`, `token-`, `search-isolation.test.ts` -> WP-73 | T-ISO-11/12 need search (WP-57); grouped with 03 S13 |
| D-11 | Rows moved between WPs | T-ISO-08 -> WP-39 (needs a running ingesting instance); T-LC-10/11/12 at engine level in WP-13 (CLI-level `init` cases in WP-15); T-LC-14 boot part WP-18, replay part WP-39; T-LF-50 model part WP-28, sweeper part WP-35; 05 S3 "`runHookHandler` writes one spool line" -> WP-25 | each row runs only when its inputs exist |
| D-12 | Paths corrected per critic notes | cross-engine tests in `runtime/tests/parity/cross-engine.parity.test.ts` (N-07); `platform-branching.test.ts` next to its module (C47; the integration project includes only `*.int.test.ts`) | executable tests must resolve `@mcs/*` |
| D-13 | Unowned items assigned | static web hosting (04 12.2, ADR 0039) -> WP-17; MCP (foundations Q7) -> WP-64 with ADR 0060; `security` project and `test:security` -> WP-72 (05 2.8 names S8, which has no security files); `runtime/bench/results/` gitignore line -> lead (98 9.3) | no design slice owned them |
| D-14 | Plan-assigned test file names | `engine/test/{workspace-init,audit-concurrency,query-plans}.int.test.ts`; `cli/test/{cli-config,ingest-replay,export,verify-completion,backup,upgrade,db-rebuild,cleanup}.int.test.ts`; `server/test/{static,boot,control,shutdown,state-file,crash-recovery,stream-replay,stream-limits,stream-lifecycle}.int.test.ts`; `tests/parity/{cli-config,cross-engine}.parity.test.ts`; `tests/resilience/process-lifecycle.test.ts`; `tests/isolation/{setup-selftest,data-crash-isolation}.test.ts`; `tests/tooling/{launcher-bootstrap,schemas-drift,check-text,check-docs,release-check}.test.ts`; `web/e2e/{global-setup.ts,specs/transcript-perf.spec.ts}`; `web/src/pages/overview/OverviewPage.test.tsx` | the designs name test ids, not these files; the lead adds them to 98 section 12 when this plan is accepted |

## 11. Risk register (top 10)

| # | Risk | Likelihood / impact | Mitigation | Trigger to act |
|---|---|---|---|---|
| R1 | Parallel agents in one working tree break each other's checks (half-written files, shared Vitest cache, `clean` deleting `dist/` mid-run) | high / medium | locks of plan section 3.1; own-file `TSC` filtering; marked blocks; per-WP staging; phase gates on a clean worktree; verifier re-runs | a gate fails on a file the WP does not own |
| R2 | Damage to the live environment: the V9 monitor on 8765, the owner's tasks root, real hook settings, real `~/.claude` | medium / critical | plan section 2 rule 5 (`--port`, `--repo`, temp `MCS_HOME`/`CLAUDE_CONFIG_DIR`, `MCS_LAUNCHER_NO_BOOTSTRAP=1`); installer guard T-IN-07; `secrets-never-read` hash check; ports policy; G2 shadow runs only by the lead | any process, file or port of plan section 12 rule 2-3 touched |
| R3 | Lifecycle or token accounting is subtly wrong (terminal state regresses, double count, false completion) | medium / high | opus xhigh implementers and fable verifiers on WP-26..WP-35; transition-table and property tests; 02 6.4 worked example; parity T1-T6 and G3; resilience duplicates and out-of-order | a property test seed fails or a parity DIFF lacks a D/PD id |
| R4 | Contract drift between the six designs during implementation | medium / high | registry authority (98 0.1) and CR protocol (plan section 2 rule 2); contract tests `runtime-sections.contract`, `env-vars`, `routes.test`, `schemas:check`, `launcher-parity`; WP-03 verified by opus xhigh before anything consumes it | a WP needs a shape the registry does not hold |
| R5 | Windows process and file semantics (killing the wrong pid, console windows, EBUSY on replace, named-pipe edge cases) | medium / high | WP-07 first with adversarial verification; marker-verified kills; impostor tests; atomic-replace retry; T-LC-13; POSIX parts labelled UNVERIFIED until the inactive CI runs (F-3) | an impostor or a non-test pid is ever signalled |
| R6 | Native module and npm hazards (`better_sqlite3.node` locked during `npm ci`, launcher bootstrapping on its own, ABI mismatch) | medium / high | `npm` barrier by the lead only; install stamp written after every `npm ci`; `MCS_LAUNCHER_NO_BOOTSTRAP=1` everywhere; one dev Node; no new dependency without an ADR | `.mcs-bootstrap.log` appears outside launcher tests, or a load error |
| R7 | Parity problems discovered late | medium / medium | goldens in Phase 2, L1 vectors in Phase 3, L2 in Phase 6; PD/D tables (ADR 0055) decide reproduce-or-fix | a vector or L2 row fails without a decision row |
| R8 | UNVERIFIED design assumptions (F-3 POSIX control channel, F-5/O-1 cold-cache scan, O-2 `node:sqlite`, O-3 `backup()` typings, F-7 typed-lint probes, F-8/UI O-2 render cost, F-4 constrained PowerShell) | high / medium | each is a named check inside its WP (WP-18, WP-57, WP-09, WP-23, WP-56, WP-41) with the design's fallback; anything still unverified is labelled UNVERIFIED in the release report | a WP reports the check as failing; the lead applies the documented fallback |
| R9 | Agent sessions stall or run out of budget on L WPs; background runs killed after 600 s | medium / medium | size rules and cut lines (plan section 8); resume the same agent with SendMessage; long gates run in the foreground with a done-marker poll; at most two FAIL rounds before re-planning | a WP exceeds one session or a gate never finishes |
| R10 | Schema churn after `0001_initial.sql` is frozen | low / high | freeze at WP-09's commit with the recorded checksum; any later DDL is `0002_*.sql` with the `v1.db` upgrade test (DA-T-DB-6) and a backup-first migration; editing `0001` is stop-the-line | a CR asks for a table or column change after WP-09 |

## 12. Stop-the-line rules (any one halts the current wave; the lead decides before work resumes)

1. A write to a legacy read-only path (plan section 2 rule 1) or to another design's file outside the protocol of plan section 4: revert it, re-verify the WP.
2. Any read or write of real hook settings (`~/.claude/settings*.json`, `<repo>/.claude/settings*.json`), a write under the real
   `~/.claude`, a read of a `.key` file's content, or a hook installed outside a temp `--settings-file`: halt all agents.
3. Any use of ports 8765-8784, 3000, 3100, 8080, 8089, or any interaction with the live V9 monitor (its process, its workspace
   `D:/mvp/.claude/monitor/tasks/v9-chain/`) or any other real task workspace: halt all agents.
4. A git write command run by an agent, or a commit that contains files of an unverified WP.
5. An edit of `packages/engine/migrations/0001_initial.sql` after WP-09's commit.
6. A claimed gate result the verifier cannot reproduce, or a fabricated metric, number or test result (foundations C5): halt the wave
   and re-verify every WP of that agent.
7. A disabled, skipped, weakened or deleted test, lint rule or check, or an `eslint-disable` without a written reason, outside the
   quarantine protocol.
8. Private data (prompts, tokens, real session ids, emails, the owner's paths or task names) in code, fixtures, logs, docs or test
   output: halt, purge, re-verify.
9. A dependency or framework added without the `npm` barrier and an ADR, or any lockfile change outside the barrier.
10. A red phase gate on a clean worktree: no commit of the next phase until it is green; a second failure from the same cause escalates
    to re-planning.
11. A native-module load error, a process left running, or a port left open after a WP (`END` red).
12. A flaky test (fails without a code change): the owner WP is reopened; quarantine only per 05 4.7, never in a release-blocking layer
    at release.
13. Contract drift: a WP changes a registry-listed name or shape it does not own without an accepted CR.

## 13. Lead steps

| Step | When | Content | Done when |
|---|---|---|---|
| LS-0 | before Phase 2 | create `D:/mvp/private/scratch/mcs-v3/kit/`: `mcslock.mjs` (named-pipe locks and semaphores, plan section 3.1), `wp-gate.mjs` (`tsc`, `build`, `end`, `markers --check`, `ports --check`, `stage`), `wp/WP-xx.json` manifests generated from plan section 8 Creates/Blocks lines, `ports.json` (12 manual slots), `cr/` folder; accept this plan and file the CR that adds the D-14 test names to 98 section 12 | self-tests: two `run` holders serialize; a killed holder releases at once; `wp-gate tsc` passes with a foreign error and fails with an own one; `stage` on a dummy repo stages only one block |
| LS-6a | start of Phase 6 | `git mv docs/{api,architecture,changelog,configuration,development,troubleshooting,ui-decision-record}.md docs/legacy/` (move-only commit); banner line and `../../reference/` link fixes in the moved files (second commit); `reference/*` links unchanged unless the owner approves (05 6.4 step 4) | `check-docs` passes on `docs/legacy/` and `reference/` |
| LS-6b | after every WP | Phase 6 gate (plan section 9.2); migration verification report in `docs/migration.md` (05 7.2) from real outputs; ADR statuses; cutover evidence G1-G9 (06 5.9; G2 shadow runs by the lead, read-only, 3 runs at least 1 h apart); marker cleanup (reformat-only commit, `grep -r "@wp-" runtime` empty); schemas regenerated; owner approval G10 requested; only then `SKILL.md` installed from the WP-79 candidate | release report has no fabricated row; G10 approval in an owner message |
