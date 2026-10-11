# 99 Requirements matrix and critic review (Phase 1 reconciliation)

Status: Critic output, 2026-10-11. Author: independent critic (read every design doc 00-06, ADRs 0001-0059, the master brief
MEGA-PROMT-V3 in full, the research files for the facts the designs rely on, and the legacy sources named below).
Inputs are the design documents as they stood at 15:36 on 2026-10-11. Nothing in this file changes a design; it records where the
designs agree, where they conflict and what is missing. The lead resolves the issues listed in section 2 before Phase 2 starts.

Reading guide: section 1 is the one-row-per-requirement matrix (brief sections 1-18). Section 2 lists the cross-design conflicts
and gaps with the required fix and the document that must change. Section 3 checks the Phase 2+ slices across documents.
Section 4 lists the experiments run for this review. Section 5 is the uncovered-requirements list.

Conventions: `R-<brief section>.<n>` ids; "design" names the document and section that satisfies the row; "code" is the planned
location (from the designs, not yet written); "test" is the planned test id or file; status is one of
`designed | gap | deferred-with-reason | non-goal`. A row whose status is `designed` but whose design has an open conflict carries the
issue id (`I-nn`) in the notes column so the matrix and the issue list stay linked.

---

## 1. Requirements matrix

### Preamble: language, conventions, engineering standards

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-0.1 | English-only code, comments, docs, tests, commits | 05 5.3 S-LOG-5 (`check-text`), C2 | `runtime/scripts/check-text.mjs` | `npm run check:text` (ci gate) | designed | |
| R-0.2 | Current, verified conventions with sources and dates | 05 0 (ADR evidence lines), all ADRs | `docs/decisions/*` | review | designed | every ADR has an Evidence section with date and version |
| R-0.3 | Stable releases, no experimental features | 05 2.4 (`erasableSyntaxOnly`, type stripping dev-only), D6 | `tsconfig.base.json` | `npm run build` | designed | `fs.glob` deliberately avoided (06 3.9.4) |
| R-0.4 | TypeScript strict, no `any`, no unsafe assertions, runtime validation at boundaries | 05 2.4, 2.6; 03 5.2 step 6; 02 4.2 | `tsconfig.base.json`, `eslint.config.js`, shared zod schemas | `tests/tooling/lint-rules.test.ts` | designed | |
| R-0.5 | Consistent naming, formatting, imports, error handling, async, cleanup | 05 2.6-2.7; 01 INV-11; 03 DA-I12 | `eslint.config.js`, `.prettierrc.json` | `npm run lint`, `format:check` | designed | import order not linted (documented) |
| R-0.6 | Automated enforcement: format, lint, typecheck, tests, dependency and security checks, reproducible commands, CI | 05 3.1, 5.3 S-DEP, 8 | `runtime/scripts/ci.mjs`, `check-deps.mjs`, `runtime/ci/github-actions-ci.yml` | `npm run ci` | designed | GitHub workflow inactive, never run remotely (05 8.2) |
| R-0.7 | Maintainability over ceremony: no speculative abstractions or needless deps | 05 ADR 0041 avoid list; 04 ADR 0034/0038 | `eslint.config.js` banned packages | lint | designed | |
| R-0.8 | Repository consistency: inspect before changing, preserve patterns | 00 C1 (legacy read-only), 01 INV-02 | n/a | T-XE-01/02 | designed | |
| R-0.9 | Evidence-based decisions recorded in ADRs | ADRs 0001-0059 | `docs/decisions/` | review | designed | |
| R-0.10 | Definition of done: formatter, linter, type checker, tests, build pass or failures documented; no unrun claims | 05 7.1-7.3; 00 C5 | `runtime/scripts/release-check.mjs` | release-check report | designed | |

### 1. Reference project and research

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-1.1 | Read current CCAM docs and source before implementing an equivalent | Phase 0 `docs/research/ccam-docs-analysis.md`, `ccam-source-analysis.md` | n/a | review | designed | done in Phase 0 |
| R-1.2 | Extract behaviour, data model, lifecycle, API, errors, security boundaries | research files sections cited by 02 (CC:), 03, 05 | n/a | review | designed | |
| R-1.3 | Record adopted / adapted / deferred / rejected per concept | 05 6.5 `docs/ccam-reference.md` plan | `docs/ccam-reference.md` (Phase 6) | `check-docs` | designed | |
| R-1.4 | Do not infer undocumented behaviour from screenshots | research method sections | n/a | review | designed | |
| R-1.5 | Prefer versioned source docs over wiki | research provenance lines | n/a | review | designed | |
| R-1.6 | Record URLs and review date | research files, 05 6.5 | `docs/ccam-reference.md` | review | designed | |
| R-1.7 | Do not clone the CCAM UI; keep the visual direction | 04 6.1 (tokens ported), ADR 0035 | `packages/web/src/styles/tokens.css` | `tokens-contrast.test.ts` | designed | |

### 2. Product identity (three layers)

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-2.1 | Still a skill with documented instructions and deterministic commands | 01 Appendix A (SKILL.md), 01 6, ADR 0008 | `SKILL.md`, `scripts/mcs.mjs`, `packages/cli` | T-CLI-01..10 | designed | |
| R-2.A.1 | Discover environment and sessions | 01 6.4 `discover` | `engine/src/ops/workspace.ts` | T-CLI-03 | designed | |
| R-2.A.2 | Initialize an independent instance | 01 4.12 | `ops/workspace.init` | T-LC-10/11/12 | designed | |
| R-2.A.3 | Create and validate configuration | 01 2, 6.4 `configure`/`check` | `engine/src/config/*` | T-CLI-04 | designed | I-01 (runtime.json sections) |
| R-2.A.4 | Select runtime/template version | 01 5.2, 5.4 | `ops/upgrade.ts` | T-UP-05..07 | designed | |
| R-2.A.5 | Install or verify dependencies | 01 5.1 launcher, 05 3.3 | `scripts/mcs.mjs`, `runtime/scripts/build-stamp.mjs` | T-UP-01..04 | designed | I-05 (Node floor), I-24 (bootstrap lock) |
| R-2.A.6 | Start, stop, inspect, upgrade, recover | 01 4, 5 | `ops/lifecycle.ts`, `ops/upgrade.ts` | T-LC-*, T-UP-* | designed | |
| R-2.A.7 | Health checks and E2E verification | 01 4.10 `verify`, 6.4 `doctor` | `ops/lifecycle.verify`, `ops/diagnostics.doctor` | T-LC-01, doctor tests | designed | |
| R-2.A.8 | Task-specific audit records | 01 7 | `engine/src/audit/writer.ts` | T-AU-01..05 | designed | |
| R-2.A.9 | Report real status, never unverified success | 01 INV-10 | every ops function | T-LC-01 ("verifies before reporting") | designed | |
| R-2.B.1 | Event ingestion | 02 2, 4 | `engine/src/ingest/**` | T-HK-*, T-PL-* | designed | |
| R-2.B.2 | Session and agent lifecycle state | 02 7 | `engine/src/lifecycle/**` | P1-P9, T-LC-01..53 | designed | |
| R-2.B.3 | Transcript import and incremental reading | 02 5 | `engine/src/ingest/transcripts/**`, `ingest/tail/**` | T-TR-01..19 | designed | |
| R-2.B.4 | Normalized data storage | 03 3 | `engine/migrations/0001_initial.sql`, `engine/src/db/**` | DA-T-DB-* | designed | I-03 (events table acceptance) |
| R-2.B.5 | Search and filtering | 03 5.4, 7 | `engine/src/search/**`, `shared/src/api/filters.ts` | DA-T-S-*, DA-T-API-7 | designed | |
| R-2.B.6 | Token usage and analytics | 02 6, 03 8 | `engine/src/tokens/**`, `engine/src/analytics/**` | T-TK-*, DA-T-A-* | designed | |
| R-2.B.7 | API endpoints | 03 5, 6 | `packages/server/src/routes/**` | DA-T-API-* | designed | |
| R-2.B.8 | Realtime delivery | 03 9 | `packages/server/src/stream/**` | DA-T-RT-* | designed | |
| R-2.B.9 | Health checks and diagnostics | 02 8, 03 6.2, 01 6.4 `doctor`/`diagnostics` | `engine/src/health/**`, `engine/src/query/health.ts` | T-HE-*, DA-T-API-13 | designed | |
| R-2.B.10 | Runtime holds no project-specific hardcoded assumptions | all config from `config.json`/`runtime.json` (01 2) | `engine/src/config/resolve.ts` | T-CLI-04, DA-T-API-1 | designed | |
| R-2.C.1 | React + TypeScript UI | 04 | `packages/web` | 04 11 | designed | |
| R-2.C.2 | Typed API responses, no hardcoded data, no per-session markup, no duplicated state | 04 1, 2 (UI-I12), 5 | `web/src/data/**` | `source-audit.test.ts` | designed | |
| R-2.C.3 | Same components render different sessions/projects from data | 04 4 | `web/src/pages/**` | component tests | designed | |

### 3. Mandatory technology direction

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-3.B.1 | Node LTS compatible with deps | D7, 05 2.5 engines, 05 C-1 | `runtime/package.json` | `npm ci` | designed | I-05 floor 22.12 vs 22.22 |
| R-3.B.2 | TypeScript strict | 05 2.4 | `tsconfig.base.json` | `npm run typecheck` | designed | |
| R-3.B.3 | Express or justified alternative | D7, 03 5 (Express 5.3.0) | `packages/server` | DA-T-API-1 | designed | |
| R-3.B.4 | Zod or equivalent | D7, 03 13 | `@mcs/shared` | DA-T-API-2 | designed | |
| R-3.B.5 | SQLite with a maintained driver | D7, D10, 03 3.2, ADR 0020 | `engine/src/db/driver.ts` | DA-T-DB-1 | designed | I-14 (driver file path 05 vs 03) |
| R-3.B.6 | Versioned DB migrations | 03 4, ADR 0021 | `engine/src/db/migrations.ts` | DA-T-DB-2..6 | designed | |
| R-3.B.7 | WebSocket or SSE | D11, 03 9, ADR 0025 | `server/src/stream/**` | DA-T-RT-* | designed | SSE chosen with evidence |
| R-3.B.8 | Structured logging with levels | 05 S-LOG, 01 1.6 `logLevel` | `engine/src/log/logger.ts` | `logger.test.ts`, SEC-22 | designed | I-25 (rotation constants undefined) |
| R-3.B.9 | Maintained test framework | D7 Vitest 5.0.3, ADR 0043 | `runtime/vitest.config.ts` | `npm test` | designed | |
| R-3.F.1 | React | D7, 04 | `packages/web` | | designed | |
| R-3.F.2 | TypeScript (web) | 05 2.4 web tsconfig | `web/tsconfig.json` | typecheck | designed | |
| R-3.F.3 | Vite | 04 12.2, ADR 0039 | `web/vite.config.ts` | `npm run build -w @mcs/web` | designed | I-13 (MCS_DEV_API 8765, conditions) |
| R-3.F.4 | Lightweight CSS | 04 6.2, ADR 0035 | `web/src/styles/*.css` | `tokens-contrast.test.ts` | designed | |
| R-3.F.5 | Router only if needed | 04 3.1, ADR 0030 | `web/src/app/routes.tsx` | component tests | designed | seven views justify it |
| R-3.F.6 | Small component system | 04 4.3 | `web/src/components/**` | component tests | designed | |
| R-3.F.7 | Lucide icons (local) | 04 6.4, ADR 0037 | `web/src/components/icons.ts` | lint | designed | |
| R-3.F.8 | Data fetching and cache strategy | 04 5.2, ADR 0031 | `web/src/data/query-client.ts` | 04 11.1 | designed | |
| R-3.F.9 | No large component framework | ADR 0035 | lint banned packages | lint | designed | |
| R-3.S.1 | TS interfaces and schemas for API payloads | 03 5.5, 13 | `shared/src/api/*.ts` | DA-T-API-1/2 | designed | |
| R-3.S.2 | Explicit event type definitions | 03 5.5 `EVENT_KINDS`; 02 4.3 `LogicalEvent`; 02 2.3 `HookEnvelopeV1` | `shared/src/api/entities.ts`, `shared/src/protocol/*.ts` | unit | designed | I-03 (kind mapping 02 -> 03 unconfirmed) |
| R-3.S.3 | Runtime validation at external boundaries | 02 4.2, 03 5.2 | zod schemas | T-PL-07, DA-T-API-3 | designed | |
| R-3.S.4 | Stable ids for projects, tasks, sessions, agents, events | 01 3.1, 03 5.1 Ids | `shared/src/ids.ts`, `shared/src/api/ids.ts` | unit | designed | taskId = slug (01) and `workItemId` (03) both exist; documented |
| R-3.S.5 | Explicit timestamps and timezone handling | D10, 03 5.1 Time, 06 4.9 | all entity schemas | DA-T-A-3 | designed | |
| R-3.S.6 | Versioned configuration schema | 01 2.6, 2.7, 2.9 | `shared/src/config/**`, `schemas/*.schema.json` | `schemas.drift.test.ts`, T-ISO-27 | designed | |
| R-3.D.1 | Command: install deps | 05 3.1 `npm ci`; launcher bootstrap | `scripts/mcs.mjs` | T-UP-01 | designed | |
| R-3.D.2 | Command: dev mode | 05 3.1 `dev` (18765/18766) | `runtime/scripts/dev.mjs` | 05 E16 | designed | |
| R-3.D.3 | Command: build frontend | 05 3.1 `build` | `package.json` scripts | 05 E5 | designed | |
| R-3.D.4 | Command: run backend | 05 `start`, 01 `start`/`serve` | `packages/cli/dist/main.js` | T-LC-01 | designed | |
| R-3.D.5 | Commands: unit, integration, E2E tests | 05 3.1 `test:*`, `test:e2e` | `vitest.config.ts`, Playwright config | `npm test` | designed | |
| R-3.D.6 | Command: type-check | 05 `typecheck` | `runtime/scripts/typecheck.mjs` | E4 | designed | |
| R-3.D.7 | Command: lint | 05 `lint` | `eslint.config.js` | E6/E7 | designed | |
| R-3.D.8 | Command: run DB migrations | 01 5.4 `mcs db migrate`; 05 `migrate` script | `ops/upgrade.migrateDb` | T-UP-06 | designed | I-26 (05 script spells `migrate`, CLI is `db migrate`) |
| R-3.D.9 | Command: health check | 01 `verify`, 05 `health` | `ops/lifecycle.verify` | T-LC-01 | designed | |
| R-3.D.10 | Command: initialize a new instance | 01 `init`, 05 `init-instance` | `ops/workspace.init` | T-LC-10..12 | designed | |
| R-3.D.11 | Simple monorepo, no build orchestration tooling | 05 T1, ADR 0040 | `runtime/package.json` workspaces | `npm run ci` | designed | |

### 4. Skill generates instances

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-4.1 | Shared runtime/template separated from instance data; layout adapted to repo conventions | D1, D3, 01 1.1 | `runtime/`, `<repo>/.claude/monitor/tasks/<slug>/` | T-ISO-25 | designed | |
| R-4.ID.1 | `instanceId` | 01 1.5, 3.1 | `instance.json`, DB `meta.instance_id` | T-ISO-05, DA-T-DB-7 | designed | |
| R-4.ID.2 | `projectId` | 03 5.1 (sanitized project folder name) | `projects.project_key` | DA-T-API-1 | designed | |
| R-4.ID.3 | `taskId` | 01 3.1 (slug); 03 work items | folder name / `work_items.id` | T-ISO-01 | designed | |
| R-4.ID.4 | `sessionId` | 01 3.1, 03 5.1 | `sessions.session_uid` | unit | designed | |
| R-4.ID.5 | `agentId` | 03 5.1 (`main` or provider id) | `agents.agent_uid` | unit | designed | |
| R-4.ID.6 | `eventId` | 03 5.1 (integer) + `key` | `events.id` | DA-T-API-1 | designed | 04 assumed string (I-10) |
| R-4.ID.7 | Never conflate task, session, agent, OS process | 01 0.2 terms, 02 7 (session vs agent), 01 4.8 (pid never alone) | | T-ISO-22 | designed | |
| R-4.OWN.1 | Instance owns its configuration | 01 1.4, 1.6 | `config.json`, `runtime.json` | T-ISO-06 | designed | |
| R-4.OWN.2 | Its monitoring scope | D14, 02 2.6 route file, 02 5.1 | `config.json` L keys, `routes/<instanceId>.json` | T-HK-05, T-TR-12 | designed | |
| R-4.OWN.3 | Its state | 01 1.7 | `state.json` | T-LC-07 | designed | |
| R-4.OWN.4 | Its database / isolated partition | D2, 03 DA-I1/I3 | `data/monitor.db` | DA-T-DB-7, T-ISO-05 | designed | |
| R-4.OWN.5 | Its logs | 01 1.1 `logs/` | `logs/runtime.log`, `boot.log` | T-LC-01 | designed | |
| R-4.OWN.6 | Its audit trail | 01 7 | `audit/*.md` | T-AU-* | designed | |
| R-4.OWN.7 | Its endpoint or routing identity | 01 4.3 control channel, 4.11 port, 02 2.6 route file | `\\.\pipe\mcs-<id>`, `state.json.url` | T-ISO-18/19, T-HK-05 | designed | |
| R-4.OWN.8 | Its template/runtime version | 01 1.5 `runtimeVersion`, `dbSchemaVersion` | `instance.json` | T-UP-07 | designed | |
| R-4.ISO.1 | Isolation choice with rationale (process per instance) | D2, 06 CH-1 (memory cost measured) | | B1 budget | designed | |
| R-4.ISO.2 | Not one app copy per session | D2, D15 | | | designed | |
| R-4.ISO.3 | Every query, subscription, request, cache key, selector respects the instance boundary | 03 DA-I3 (`RepoContext`), 04 UI-I11 (query keys), 03 5.1 `X-MCS-Instance` | `db/open.ts assertScope`, `web/src/data/query-keys.ts` | DA-T-DB-7, `StreamProvider.test.tsx` | designed | 03 C-1: no per-row column (accepted with evidence) |
| R-4.CFG.1 | Precedence built-in -> skill -> instance -> CLI | D4, 01 2.1 | `engine/src/config/resolve.ts` | 01 S5 unit tests | designed | |
| R-4.CFG.2 | Env overrides only where documented | 01 2.10 | `resolveConfig` step 5 | unit | designed | I-27 (`MCS_FS_WATCH`, `MCS_TEST`, `MCS_PERF_FACTOR` undocumented in 01) |
| R-4.CFG.3 | Deterministic merge, documented rules | 01 2.2, C-3 | `engine/src/config/merge.ts` | C-3 merge tests | designed | |
| R-4.CFG.4 | Validate against a versioned schema | 01 2.4, 2.6 | `LegacyConfigFileSchema`, `RuntimeOverridesSchema` | legacy message goldens | designed | I-01 |
| R-4.CFG.5 | Migration or compatibility behaviour on schema change | 01 2.7 `config migrate`, 5.4 `upgrade` | `engine/src/config/migrations.ts` | T-ISO-27 | designed | |
| R-4.T.1 | Test: A cannot read B's private state | 01 T-ISO-01..05; 05 ISO-1, ISO-1b; 03 DA-T-DB-7 | `tests/isolation/read-isolation.test.ts`, `db-identity.test.ts` | release-blocking | designed | |
| R-4.T.2 | Test: A cannot overwrite B's configuration | 01 T-ISO-06..08; 05 ISO-2 | `tests/isolation/config-write-isolation.test.ts` | | designed | |
| R-4.T.3 | Test: A's tokens exclude B unless explicit cross-project aggregate | 01 T-ISO-09/10; 05 ISO-3; 03 DA-T-A-7; 02 T-TK-09 | `tests/isolation/token-isolation.test.ts` | | designed | no cross-instance endpoint exists (D11) |
| R-4.T.4 | Test: A's search excludes B's transcripts | 01 T-ISO-11/12; 05 ISO-4; 03 DA-T-S-10 | `tests/isolation/search-isolation.test.ts` | | designed | |
| R-4.T.5 | Test: stopping A does not stop B | 01 T-ISO-13..15; 05 ISO-5 | `tests/isolation/lifecycle-isolation.test.ts` | | designed | |
| R-4.T.6 | Test: restarting one does not corrupt the other's DB | 01 T-ISO-16/17; 05 ISO-6; 03 DA-T-E-6 | `tests/isolation/restart-isolation.test.ts` | | designed | |
| R-4.T.7 | Test: no conflicting ownership, port, runtime state | 01 T-ISO-18..23; 05 ISO-7 | `tests/isolation/ownership-isolation.test.ts` | | designed | |
| R-4.T.8 | Test: upgrades never overwrite user config or audit | 01 T-ISO-24..27; 05 ISO-8 | `tests/isolation/upgrade-isolation.test.ts` | | designed | |
| R-4.T.9 | Isolation tests release-blocking | 05 4.1, 7.1; 01 3.5 | `npm run test:isolation` in `ci` | | designed | I-23 (ISO ids differ between 01 and 05; matrix maps them) |

### 5. Data collection: hooks first, transcripts as recovery

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-5.1 | Research the current hook spec; do not assume stability | `docs/research/claude-code-hooks.md`; ADR 0013 (version-sensitive, re-check per minor) | `shared/src/protocol/hook-events.ts` | review | designed | |
| R-5.2 | Install only supported events; invent no fields | 02 2.4 (21 events), ADR 0013 | `INSTALLED_HOOK_EVENTS` | T-HK-03 | designed | |
| R-5.H.1 | Read and validate JSON stdin | 02 2.2 steps 4, 6, 7; 2.3.2 | `cli/src/hook/main.ts` | T-HK-01 | designed | I-17 (entry file must be `cli/src/hook.ts` to emit `dist/hook.js`) |
| R-5.H.2 | Preserve provider ids and timestamps | 02 2.3.1 | envelope | T-HK-03 | designed | |
| R-5.H.3 | Attach instance routing identity | 02 2.6 (`instance_id` per envelope), ADR 0011 | `shared/src/protocol/routes.ts` | T-HK-05 | designed | |
| R-5.H.4 | Deliver to the intended runtime | 02 2.2 steps 11-13 (spool + nudge) | `cli/src/hook/{spool-writer,nudge}.ts` | T-HK-05/06 | designed | |
| R-5.H.5 | Bounded timeouts | 02 2.1 (5 s / 2 s), 2.2 (1200 ms hard exit, 300 ms nudge) | handler | T-HK-06/07 | designed | |
| R-5.H.6 | Fail safely when monitoring is unavailable | 02 2.11, C1 stub | `scripts/mcs-hook.mjs` | T-HK-11 | designed | |
| R-5.H.7 | Never block normal agent execution | 02 2.1 (exit 0, no stdout), ADR 0013 async tool events | handler | T-HK-01/10 | designed | |
| R-5.H.8 | Actionable diagnostics without secrets | 02 2.11 handler log | `$MCS_HOME/logs/hook-handler.jsonl` | T-HE-04 | designed | |
| R-5.H.9 | No recursive monitoring loops | D8, 02 2.9 | `MCS_HOOK_DISABLE`, `claudeArgsWithoutHooks` | T-HK-02/15, SEC-21 | designed | |
| R-5.H.10 | Important failures recorded observably | 02 2.11 table, 8.2 `receiving.hooks.status` | handler log + health | T-HE-04/05 | designed | |
| R-5.H.11 | Best effort; no exactly-once claim; duplicates and reordering handled | 02 4.4, 4.5, ADR 0012 | `engine/src/ingest/dedupe.ts` | T-PL-02/04/09 | designed | |
| R-5.I.1 | Dedupe on stable provider ids or a bounded fallback key | 02 4.4 D-1..D-3, research 11 | `dedupe.ts`, `events` unique indexes (03 3.5) | DA-T-DB-9, T-PL-04 | designed | |
| R-5.I.2 | Repeat delivery never double-counts tokens | D8 (hooks carry no tokens), 02 6 | `engine/src/tokens/*` | T-TK-08 | designed | |
| R-5.I.3 | Never duplicates tool executions | 02 4.1 `tool_call` upsert, 03 3.6 | `ToolCallsRepo` | DA-T-DB-12, D3 | designed | |
| R-5.I.4 | Never creates multiple logical sessions | 02 4.1 `session` natural key | `SessionsRepo.ensure` | T-PL-02 | designed | |
| R-5.I.5 | Never re-applies terminal transitions | 02 7.2 semilattice, P4 | `lifecycle/merge.ts` | P4, D2 | designed | |
| R-5.I.6 | Never corrupts the agent hierarchy | 02 8.1 exact id joins | `AgentsRepo` | T-HE-01, D4 | designed | |
| R-5.T.1 | Large JSONL without loading the whole file | 02 5.3 chunked reads, ADR 0015 | `ingest/tail/jsonl-tailer.ts` | T-TR-11, E3/E4 | designed | |
| R-5.T.2 | Files growing while read | 02 5.3, 5.9 | tailer | T-TR-03 | designed | |
| R-5.T.3 | Incomplete final lines | 02 5.3 step 5 | tailer | T-TR-01/02 | designed | |
| R-5.T.4 | Truncation, rotation, compaction, changed identity | 02 5.3 `checkIdentity`, C3 | `ingest/tail/file-identity.ts` | T-TR-07 | designed | |
| R-5.T.5 | UTF-8 and JSON parsing preserved | 02 5.3 | tailer | T-TR-04/06 | designed | |
| R-5.T.6 | Track read offsets safely | 02 5.5 cursors, 03 `transcript_files` | `TranscriptFilesRepo.updateCursors` | T-TR-09, DA-T-DB-1 | designed | |
| R-5.T.7 | Detect and recover from offset invalidation | 02 5.3 reset, 4.8 `IDENTITY_RESET` | tailer | T-TR-07/08 | designed | |
| R-5.T.8 | Avoid unbounded cache growth | 02 5.8 | queue caps, LRU | T-PL-06 | designed | |
| R-5.T.9 | Expose transcript freshness and import errors | 02 5.9, 8.2 | `engine/src/health/ingest-health.ts` | T-HE-06 | designed | |
| R-5.T.10 | Metadata to reconcile transcripts with hooks | 02 8.1, `sources` bits | `tool_calls.sources`, `events.natural_key` | T-HE-01 | designed | |
| R-5.T.11 | No complicated indexing engine without evidence | 03 7.5 (no FTS5, measured), ADR 0023 | `engine/src/search/scan.ts` | DA-T-S-2 | designed | |
| R-5.R.1 | Distinguish provider generating / monitor receiving / persisted / displayed | 02 8.2 four blocks, 04 5.6 | `IngestHealth` | T-HE-03 | designed | |
| R-5.R.2 | Expose ingestion health, last event, last sync, stale indicators | 02 8.2, 03 6.2, 04 4.4.7 | `GET /api/v3/health`, `/health/ingest` | DA-T-API-13, 04 freshness tests | designed | |

### 6. Lifecycle model

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-6.1 | Formal documented state model | 02 7, ADR 0018 | `engine/src/lifecycle/*` | T-LC-01..53 | designed | |
| R-6.2 | No completion inferred from a turn end | 02 7.1, P9 | `derive-session.ts` | P9, N8/N9 | designed | 02 C2 keeps D9 |
| R-6.S.1 | Ten semantics incl. inferred-from-incomplete-evidence | 02 7.1 `LifecycleState` + `basis` | `shared` `LIFECYCLE_STATES` | 04 `lifecycle-display.test.ts`, T-LC-49 | designed | same ten values in 02, 03 5.5, 04 13 |
| R-6.R.1 | Subagent end never completes parent | 02 7.5, P8 | `derive-agent.ts` | P8, D4 | designed | |
| R-6.R.2 | Stop is not SessionEnd | 02 S-8e vs S-3b, P9 | | N8/N9, P9 | designed | |
| R-6.R.3 | Missing events never mean success | 02 P5, S-5 | | P5, M2 | designed | |
| R-6.R.4 | Stale visibly different from verified | 02 `stale` + `basis`; 04 6.1, ADR 0033 | `StateBadge` | UI-I8 tests | designed | |
| R-6.R.5 | Idempotent transitions | 02 P1 | `merge.ts` | P1, D1-D5 | designed | |
| R-6.R.6 | Out-of-order never regresses terminal state without reconciliation | 02 P4, `activity_after_end` | `reconciliations` | P4, O4 | designed | |
| R-6.R.7 | Inferred states carry evidence and confidence | 02 7.1 `LifecycleView` | `state_evidence`, `state_confidence` | T-LC-49 | designed | |
| R-6.R.8 | Operator can tell observed from inferred | 02 `basis`; 04 `SessionHeader` | | `SessionDetailPage.test.tsx` | designed | |
| R-6.T.1 | Transition table + tests for normal, failed, duplicated, missing, delayed, out-of-order | 02 7.7 (48 rows), 7.12 | `lifecycle.transitions.test.ts` | T-LC-01..48 | designed | |

### 7. Data model and persistence

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-7.1 | SQLite default store, driver validated | D7/D10, 03 3.2, stack-versions 2 | `engine/src/db/driver.ts` | DA-T-DB-1 | designed | `node:sqlite` fallback UNVERIFIED (03 O-2) |
| R-7.E.1 | Entity: monitoring instances | 03 3.3 `meta` | DDL | DA-T-DB-1 | designed | |
| R-7.E.2 | Projects | 03 `projects` | DDL | | designed | |
| R-7.E.3 | Tasks | 03 `work_items`, `work_item_sessions` | DDL | T-LC-52 | designed | |
| R-7.E.4 | Sessions | 03 `sessions` | DDL | | designed | |
| R-7.E.5 | Agents | 03 `agents` | DDL | | designed | |
| R-7.E.6 | Events | 03 `events` | DDL | DA-T-DB-9 | designed | I-03 |
| R-7.E.7 | Transcript entries or references | 03 `events` (sources & 2), `transcript_files`, `transcript_checkpoints`, ADR 0022 | DDL | DA-T-S-7 | designed | |
| R-7.E.8 | Token usage | 03 `usage_files`, `usage`, ADR 0024 | DDL | DA-T-DB-10 | designed | |
| R-7.E.9 | Model and pricing metadata (if cost) | 03 8.3 (`pricing` in `runtime.json`, `usage.model`) | config + DDL | DA-T-A-4 | designed | prices never shipped (D15) |
| R-7.E.10 | Ingestion health | 03 `ingest_health`, `ingest_errors` | DDL | DA-T-API-13 | designed | |
| R-7.E.11 | Alerts | 03 `alerts`, `alert_state` | DDL | DA-T-AL-* | designed | |
| R-7.E.12 | Schema migrations | 03 4.2 `schema_migrations` | runner | DA-T-DB-2..6 | designed | |
| R-7.E.13 | Attempts (chain-log runs) | 06 3.10.2 proposes `attempt_source`, `attempt_run`; absent from 03 `0001_initial.sql` | | | gap | I-07 |
| R-7.2 | Only needed entities, relationships and indexes | 03 3.4, 3.7 (measured) | DDL | DA-T-DB-14 | designed | |
| R-7.P.1 | Parameterized queries | 03 3.6 | repos | review | designed | |
| R-7.P.2 | Foreign keys enabled and verified | 03 3.2 step 5, 4.3 | `openInstanceDb` | DA-T-DB-1/8 | designed | |
| R-7.P.3 | Transactions for related updates | 03 4.5 `withWriteTx`, 02 4.6 | `db/write.ts` | DA-T-RT-1, T-PL-05 | designed | I-16 |
| R-7.P.4 | WAL evaluated | 03 3.2, ADR 0020 | pragmas | DA-T-DB-15 | designed | |
| R-7.P.5 | Migrations plus rollback/recovery guidance | 03 4.4, 01 5.5-5.6 | `docs/operations.md` | T-UP-05/08 | designed | |
| R-7.P.6 | Retention and cleanup defined | 03 3.8, 01 `cleanup` | `maintenance/retention.ts` | DA-T-E-4/5 | designed | |
| R-7.P.7 | Export and backup explicit | 03 11.1, 4.4; 01 5.5 | `maintenance/export.ts`, `db/backup.ts` | DA-T-E-1/3, T-UP-08 | designed | |
| R-7.P.8 | No destructive migration without safeguards | 03 4.3 `backup_required`, ADR 0021 | runner | DA-T-DB-4 | designed | |
| R-7.P.9 | No credentials or secrets in the DB | 03 DA-I2, ADR 0022 | | DA-T-PRIV-1 | designed | |
| R-7.P.10 | No unbounded transcript copy in memory | 02 5.8, 03 7.2-7.4 | | T-PL-06, DA-T-S-5 | designed | |
| R-7.3 | DB is the source of truth; realtime messages are notifications | 03 9.1, DA-I7 | `db/changes.ts` | DA-T-RT-1 | designed | |

### 8. Features

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-8.1.1 | Overview: active sessions | 03 8.1 `sessions.active`; 04 4.4.1 | `analytics/metrics.ts`, `OverviewPage` | DA-T-A-6 | designed | |
| R-8.1.2 | Running agents and subagents | 03 `agents.running` | | DA-T-A-6 | designed | |
| R-8.1.3 | Completed, failed, waiting, stale counts | 03 `sessions.*` metrics | | DA-T-A-6 | designed | |
| R-8.1.4 | Recent activity | 03 `Overview.recentActivity`; 04 compact feed | | | designed | |
| R-8.1.5 | Recent errors | 03 `recentErrors`; 04 `RecentErrors` | | | designed | |
| R-8.1.6 | Tokens and cost when reliable | 03 `tokens.*`, `cost.estimate` | | DA-T-A-4 | designed | |
| R-8.1.7 | Ingestion health | 03 `HealthReport.ingestion`; 04 `IngestionSummary` | | | designed | |
| R-8.1.8 | Last successful event and transcript timestamps | 02 8.2 `lastEnvelopeAt`, `lastSyncAt`; 03 6.2 | | T-HE-06 | designed | |
| R-8.1.9 | Every metric has source and aggregation rule | 03 8.1 `Metric.source/rule`; 04 `InfoTip` | | DA-T-A-6 | designed | |
| R-8.1.10 | No unlabeled precision | 03 `completeness`, 04 UI-I9/I12 | | `TokenSummary.test.tsx` | designed | |
| R-8.2.1 | Session list: search | 03 5.4 `q` | `listSessions` | DA-T-API-7 | designed | |
| R-8.2.2 | Sorting | 03 5.3 | | DA-T-API-6 | designed | |
| R-8.2.3 | Filtering | 03 5.4 | | DA-T-API-7 | designed | |
| R-8.2.4 | Status | `SessionSummary.state` | | | designed | |
| R-8.2.5 | Project and task | `projectId`, `workItemIds` | | | designed | 04 `taskIds` -> rename (I-10) |
| R-8.2.6 | Provider | `provider: 'claude-code'` | | | designed | |
| R-8.2.7 | Model when known | `models`, `lastModel` | | | designed | |
| R-8.2.8 | Start time and last activity | `startedAt`, `lastActivityAt` | | | designed | |
| R-8.2.9 | Duration | `durationMs` | | | designed | |
| R-8.2.10 | Token usage | `usage`, `usageInclSubagents` | | | designed | |
| R-8.2.11 | Error indicators | `errorCount`, `warningCount` | | | designed | |
| R-8.2.12 | Freshness and ingestion health | `freshness` | | | designed | |
| R-8.2.13 | Stable URL parameters | 04 3.2, UI-I10 | `web/src/lib/url-state.ts` | `url-state.test.ts` | designed | |
| R-8.2.14 | No transcript in the initial page load | 04 5.4 | | E2E step 3 | designed | |
| R-8.3.1 | Detail: metadata | 03 `SessionDetail`; 04 `SessionHeader` | | | designed | |
| R-8.3.2 | Current or last-known state | `StateAssessment` | | | designed | |
| R-8.3.3 | Parent-child hierarchy | 03 `sessionAgents`, 04 4.4.2 | `lib/agent-tree.ts` | `agent-tree.test.ts` | designed | |
| R-8.3.4 | Chronological timeline | 03 `sessionTimeline`; 04 `SessionTimeline` | | | designed | |
| R-8.3.5 | Tool executions | 03 `sessionToolCalls`, `tool.*` events | | | designed | |
| R-8.3.6 | Notifications | `notification.sent` events | | | designed | |
| R-8.3.7 | Lifecycle events | `session.*`, `turn.*` events; `sessionTransitions` | | | designed | |
| R-8.3.8 | Transcript context | 03 7.3 window/locate; 04 4.4.3 | `transcript/window.ts` | DA-T-S-7 | designed | |
| R-8.3.9 | Token usage | `sessionUsage`; 04 `SessionTokens` | | | designed | |
| R-8.3.10 | Errors and warnings | timeline severity filter; 04 `SessionErrors` | | | designed | |
| R-8.3.11 | Project/task audit references | 03 `SessionDetail.auditRefs` needs 01 `entriesBetween` | `audit/writer.ts` | | gap | I-19 |
| R-8.3.12 | Timeline distinguished from the provider transcript | 04 `SessionTimeline` heading, separate tabs | | | designed | |
| R-8.4.1 | Feed: chronological activity | 03 `listEvents`; 04 4.4.4 | | | designed | |
| R-8.4.2 | Event-type filters | `type`, `category` | | DA-T-API-7 | designed | |
| R-8.4.3 | Session/project filters | `session`, `project` | | | designed | |
| R-8.4.4 | Pause/resume live updates | 04 5.7 | | `live-buffer.test.ts` | designed | |
| R-8.4.5 | Bounded buffering while paused | 04 5.7 caps 500 | | | designed | |
| R-8.4.6 | Cursor history loading | 03 5.3, 04 5.3 | | DA-T-API-6 | designed | |
| R-8.4.7 | Error highlighting | 04 `ActivityRow` | | | designed | |
| R-8.4.8 | Event details and timestamps | `ActivityEvent.details`, `at` | | | designed | |
| R-8.4.9 | Clear indication of missing or stale data | 03 `monitor.gap` events; 04 separator + `StaleDataIndicator` | | | designed | 04 assumed `gapBefore` (I-10) |
| R-8.5.1 | Typed reusable filter model | 03 5.4 `shared/src/api/filters.ts`; 04 `FilterBar` | | DA-T-API-7 | designed | |
| R-8.5.2 | Filters: text, project, task, session, agent, state, type, tool, model, errors, time, tokens | 03 5.4 table | | | designed | |
| R-8.5.3 | Transcript content search separate from metadata search | 03 7 | `search/scan.ts` | DA-T-S-2 | designed | |
| R-8.5.4 | Never claim "entire transcript" when partial | 03 `SearchCoverage`, 04 4.4.3 step 9 | | DA-T-S-1 | designed | |
| R-8.5.5 | Pagination, limits, cancellation, stale-request protection | 03 6.4, 04 5.3 | | DA-T-S-6 | designed | |
| R-8.6.1 | Board with six states | 02 7.11, 03 `BOARD_STATES`, 04 4.4.5 | `lifecycle/work-items.ts` | T-LC-52 | designed | |
| R-8.6.2 | Explicit task records or documented derivation | 02 7.11 W-DECL/W-ATT/W-LBL, D14 | `runtime.json board.items` | T-LC-52 | designed | 04 `tasks[]` -> `board.items` (I-10) |
| R-8.6.3 | Evidence explains a task's state | 03 `WorkItem.evidence`, `boardReason` | | | designed | |
| R-8.7.1 | Input / output / cache categories | 02 6.3, 03 `TokenUsage` | | T-TK-01 | designed | |
| R-8.7.2 | Per session / project / model, over time, tool frequency | 03 8.2-8.4 | `analytics/*` | DA-T-A-1..5 | designed | |
| R-8.7.3 | Optional cost estimates labelled | 03 8.3, D15 | | DA-T-A-4 | designed | |
| R-8.7.4 | Source and schema of usage identified | 02 6.1 | | | designed | |
| R-8.7.5 | Compaction and cumulative usage | 02 6.2 rule 13, 6.6 | | | designed | |
| R-8.7.6 | No duplicate accounting | 02 6.2 rules 4-7 | | T-TK-03/05 | designed | |
| R-8.7.7 | Missing vs zero | 02 6.2 rule 8, 03 DA-I9 | | T-TK-06, DA-T-API-8 | designed | |
| R-8.7.8 | Estimated vs provider-reported cost | 03 `CostEstimate.basis`, `reportedCost` | | DA-T-A-4 | designed | |
| R-8.7.9 | No hook/transcript double counting | D8, 02 6.1 | | T-TK-08 | designed | |
| R-8.7.10 | Trend charts only after validation | 03 `features.usageTrend` default false; 04 4.4.6 | | `AnalyticsPage.test.tsx` | designed | needs 01 `analytics` section (I-01) |
| R-8.8.1 | Alert: no activity beyond threshold | 03 10.1 `inactivity` | `alerts/rules.ts` | DA-T-AL-5 | designed | |
| R-8.8.2 | Repeated ingestion errors | `ingest_errors` rule | | | designed | |
| R-8.8.3 | Runtime unavailable | `runtime_unavailable` rule | | DA-T-AL-4 | designed | |
| R-8.8.4 | Token threshold | `token_threshold` | | DA-T-AL-3 | designed | |
| R-8.8.5 | Transcript import lag | `import_lag` | | | designed | |
| R-8.8.6 | DB or disk errors | `db_disk` | | | designed | |
| R-8.8.7 | Webhooks later, secrets protected | 03 10.4 (deferred, safe design recorded) | | | deferred-with-reason | D15 |
| R-8.9.1 | CLI: list instances | 01 `instances list` | `ops/instances.ts` | | designed | |
| R-8.9.2 | Initialize instance | 01 `init` | | | designed | |
| R-8.9.3 | Check runtime health | 01 `status`, `verify` | | | designed | |
| R-8.9.4 | List sessions | 01 `sessions list` | `InstanceReader.sessions` | T-CLI-05 | designed | |
| R-8.9.5 | Inspect session state | 01 `sessions show` | | | designed | |
| R-8.9.6 | Read recent errors | 01 `errors` | | | designed | |
| R-8.9.7 | Run diagnostics | 01 `doctor`, `diagnostics` | | T-CLI-09 | designed | |
| R-8.9.8 | Validate configuration | 01 `check`, `configure` dry run | | T-CLI-04 | designed | |
| R-8.9.9 | Verify task completion evidence | 01 `verify-completion` depends on 02 `explainCompletion`, which 02 does not define | `InstanceReader.explainCompletion` | T-CLI-08 | gap | I-08 |
| R-8.9.10 | Read-only MCP after contracts stabilize | D1 (optional MCP in `packages/cli`), open question 7 | | | deferred-with-reason | Phase 5 research + ADR; read-only only (SEC-29) |
| R-8.9.11 | No unrestricted file access, shell or destructive mutation tools | 03 DA-I10/I11, 05 S-PROC | | SEC-19 | designed | |
| R-8.10.1 | Configuration inspection | 01 `inspect`, 03 `GET /config` | | | designed | I-20 (`ConfigInspection` undefined) |
| R-8.10.2 | Runtime health | 01 `status`, 03 `/health` | | | designed | |
| R-8.10.3 | Data export | 01 `export`, 03 11.1 | | DA-T-E-1 | designed | |
| R-8.10.4 | Database backup | 01 5.5, 03 4.4 | | T-UP-08 | designed | |
| R-8.10.5 | Transcript/index retention | 03 3.8, 02 2.7 spool retention | | DA-T-E-5 | designed | |
| R-8.10.6 | Cleanup of stale records | 01 `cleanup` scopes | | T-CLI-06 | designed | |
| R-8.10.7 | Version information | 01 `version`, 5.2 | | T-UP-10 | designed | |
| R-8.10.8 | Diagnostics report | 01 `diagnostics` bundle | `schemas/diagnostics.v1.schema.json` | T-CLI-09 | designed | I-21 |
| R-8.10.9 | Destructive cleanup needs scope and confirmation; never another instance's data | 01 6.2, 6.4 containment | | T-CLI-06, SEC-15 | designed | |

### 9. UI requirements

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-9.1 | Keep visual identity, improve incrementally | 04 6.1 tokens ported verbatim, ADR 0035 | `styles/tokens.css` | `tokens-contrast.test.ts` | designed | |
| R-9.2 | Not every CCAM screen | 04 3.1 (seven routes) | | | designed | |
| R-9.3 | React components driven by typed data | 04 4, 5 | | | designed | |
| R-9.C.1 | Conceptual components (AppShell ... StaleDataIndicator) | 04 4.2 file layout maps every listed name | `web/src/**` | component tests | designed | names are examples; all present |
| R-9.Q.1 | Clear navigation, compact layout | 04 4.1, 6.3 | `AppShell`, `Sidebar` | `AppShell.test.tsx` | designed | |
| R-9.Q.2 | Responsive for smaller windows | 04 6.3 | CSS | E2E 390 px check | designed | |
| R-9.Q.3 | Keyboard accessibility | 04 6.5, 6.6 | `shortcuts.ts` | `a11y.test.tsx`, axe E2E | designed | |
| R-9.Q.4 | Loading, empty, error, stale states | 04 7 table | `Skeleton`, `EmptyState`, `ErrorState`, `StaleDataIndicator` | component tests | designed | |
| R-9.Q.5 | Reusable filtering controls | 04 4.3 `FilterBar` | | `SessionExplorerPage.test.tsx` | designed | |
| R-9.Q.6 | Stable sorting and pagination | 04 5.3, 03 5.3 | | DA-T-API-6 | designed | |
| R-9.Q.7 | Safe Markdown and code rendering | 04 8, ADR 0034 | `components/Markdown.tsx` | `Markdown.test.tsx` | designed | |
| R-9.Q.8 | No unsafe HTML rendering | 04 UI-I1/I2, lint, audit | | `source-audit.test.ts` | designed | |
| R-9.Q.9 | No fake charts or hardcoded metrics | 04 UI-I12, 4.4.6 (trend gated) | | audit test | designed | |
| R-9.Q.10 | No unnecessary animation | 04 6.7 | | | designed | |
| R-9.Q.11 | No decorative-component dependency | 04 ADR 0037/0038 | | | designed | |
| R-9.Q.12 | Preserve useful existing UI features | 04 10 (36 of 37 legacy tests carried), must-preserve list | | `vitest run -t legacy:` | designed | |
| R-9.T.1 | Real runtime data in integration tests; fixtures labelled | 04 11.3 (real server), 05 4.4 `FIXTURE` rules | `server/test/api-to-web.int.test.ts` | | designed | |

### 10. Realtime and frontend data consistency

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-10.1 | UI requests an initial snapshot | 03 9.4 step 1, 04 5.2 | `useInstance` | | designed | |
| R-10.2 | UI subscribes to realtime updates | 04 5.6 `StreamProvider` | `stream-client.ts` | `stream-client.test.ts` | designed | |
| R-10.3 | Server persists before publishing | 03 DA-I7, 02 4.6 | `withWriteTx`, `onCommitted` | DA-T-RT-1, T-PL-05 | designed | |
| R-10.4 | Messages carry type, entity, timestamp, instance scope | 03 `StreamChange {seq, at, instanceId, kind, op, sessionId}` | `shared/src/api/stream.ts` | DA-T-RT-2 | designed | 04 assumed shapes differ (I-10) |
| R-10.5 | UI reconciles without duplicates | 04 5.5 R1-R5 | `reconcile.ts`, `patch-ledger.ts` | `reconcile.test.ts` | designed | |
| R-10.6 | Reconnect: fresh snapshot or validated cursor | 03 9.2 (`since`, epoch, reset), 04 5.6 | | DA-T-RT-2/3/8, `stream-reconnect.int.test.ts` | designed | |
| R-10.7 | Disconnected UI shows stale data | 04 5.6, ADR 0033 | `StaleDataIndicator` | `freshness.test.ts`, E2E step 9 | designed | |
| R-10.8 | Connectivity is not ingestion health | 04 UI-I4, 03 9.4 rule 7 | `computeIngestionView` | `TopBar.test.tsx`, E2E 13-14 | designed | |
| R-10.9 | Reconnect backoff | 04 5.6 (2, 4, 8, 16, 30 s) | `lib/backoff.ts` | `stream-client.test.ts` | designed | |
| R-10.10 | Heartbeats | 03 9.2 named `heartbeat` 15 s | `server/src/stream/sse.ts` | DA-T-RT-4 | designed | D11 "comments" refined by 03 C-2 / 04 CH-1 with evidence |
| R-10.11 | Message validation | 04 5.6 zod validation of `StreamChange` | | `stream-client.test.ts` | designed | |
| R-10.12 | Bounded event buffers | 04 UI-I7; 03 9.2 pull fan-out | | `live-buffer.test.ts`, DA-T-RT-6 | designed | |
| R-10.13 | Connection status | 04 5.6 `ConnectionChip` | | `TopBar.test.tsx` | designed | |
| R-10.14 | Error reporting | 04 `HealthDetails`, `ErrorState` | | | designed | |
| R-10.15 | Cleanup on unmount | 04 UI-I14 | | `stream-client.test.ts` cleanup | designed | |
| R-10.16 | WebSocket only if clearly beneficial | D11 SSE, ADR 0025/0032 | | | designed | |

### 11. API and contract design

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-11.1 | Small consistent API, not CCAM's inventory | 03 6.1 (33 routes) | `shared/src/api/routes.ts` | DA-T-API-1 | designed | |
| R-11.2 | Versioning / compatibility strategy | 03 5.1 (`/api/v3`, additive) | | | designed | |
| R-11.G.1 | Health and diagnostics | `health`, `healthIngest`, `errors` | | | designed | |
| R-11.G.2 | Instances/projects/tasks | `instance`, `workItemBoard`, `project` filter | | | designed | no cross-instance routes (D11) |
| R-11.G.3 | Sessions | `listSessions`, `getSession` | | | designed | |
| R-11.G.4 | Agents | `sessionAgents`, `listAgents` | | | designed | |
| R-11.G.5 | Events | `listEvents`, `getEvent`, `sessionTimeline` | | | designed | |
| R-11.G.6 | Transcripts/search | `transcriptWindow`, `transcriptLocate`, `searchTranscript(s)` | | | designed | |
| R-11.G.7 | Token usage and analytics | `analyticsUsage/Series/Tools`, `sessionUsage` | | | designed | |
| R-11.G.8 | Settings | `config`, `alertRules`, `instance` | | | designed | |
| R-11.G.9 | Export | `export` | | DA-T-E-1 | designed | |
| R-11.D.1 | Request and response schemas | 03 13 registry | | DA-T-API-1/2 | designed | |
| R-11.D.2 | Error response structure | 03 5.2 `ErrorEnvelope` | | DA-T-API-3 | designed | I-04 (code names differ in 02/05/04) |
| R-11.D.3 | Pagination conventions | 03 5.3 | | DA-T-API-6 | designed | |
| R-11.D.4 | Filter semantics | 03 5.4 | | DA-T-API-7 | designed | |
| R-11.D.5 | Sort semantics | 03 5.3 | | DA-T-API-6 | designed | |
| R-11.D.6 | Timestamp formats | 03 5.1 Time | | | designed | |
| R-11.D.7 | Identifier formats | 03 5.1 Ids | | | designed | |
| R-11.D.8 | Data ownership and access boundaries | 03 DA-I3, 5.1 instance stamp | | DA-T-DB-7 | designed | |
| R-11.3 | Validate external input at runtime | 03 5.2 step 6 | `route-adapter.ts` | DA-T-API-3 | designed | |
| R-11.4 | Generate API docs from contracts | 03 13 (`schemas/api/**`, `docs/api/reference.md`) | `scripts/gen-api-schemas.mjs` | DA-T-API-2 | designed | merge with 01 `gen-schemas.mjs` (S16) |
| R-11.5 | No duplicated business logic across API, CLI, UI | 03 12 (`createQueries`), 01 INV-12, 04 1 | `engine/src/query/index.ts` | DA-T-CLI-1 | designed | |

### 12. Security and reliability

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-12.1 | Bind loopback by default | 05 S-NET-1, 01 4.11, ADR 0045 | `server/src/main.ts` | SEC-01 | designed | |
| R-12.2 | No all-interfaces exposure without explicit config | 05 5.4 (no option in v3) | | SEC-01 | designed | |
| R-12.3 | Validate Host and Origin | 05 S-NET-2/3/4, 03 5.2 | `server/src/http/guards.ts` | SEC-02..04, DA-T-API-4 | designed | I-04 |
| R-12.4 | Protect non-loopback endpoints with auth and TLS | 05 5.4 | | | non-goal | no non-loopback endpoint exists (D15) |
| R-12.5 | Secrets out of logs and audit | 05 S-LOG, 01 7.1, 8.2 | `engine/src/log/logger.ts` | SEC-22/23, T-AU-05 | designed | |
| R-12.6 | Filesystem access restricted to configured paths | 05 S-FS, 03 DA-I10, 02 5.1.2 | `engine/src/security/paths.ts` | SEC-12..15 | designed | |
| R-12.7 | Prevent path traversal and unsafe symlinks | 05 S-FS-3, 01 1.1 (no links below tasks root), 02 `SYMLINK_SKIPPED` | | SEC-14, T-ISO-02, T-SEC-04 | designed | |
| R-12.8 | Validate hook payloads and request sizes | 02 2.3.2, 4.2; 05 S-NET-6 | | T-HK-01/03, SEC-05/06 | designed | |
| R-12.9 | Timeouts and resource limits | 05 S-NET-6, 03 6.4, 06 3.6 | | SEC-06/07, DA-T-S-6 | designed | |
| R-12.10 | Escape transcript and event content in the UI | 04 8 | | SEC-16 | designed | |
| R-12.11 | No arbitrary command execution from the web UI | 03 DA-I11 (read-only API) | | SEC-05 | designed | |
| R-12.12 | Safe subprocess argument handling in the CLI | 05 S-PROC, 01 INV-11, 06 3.6 | `engine/src/platform/exec.ts` | SEC-19/20, T-LC-16 | designed | I-06 (three `execFileText` signatures) |
| R-12.13 | Malformed JSONL and events never crash the runtime | 02 4.8, 03 14 | | T-PL-07/08, `malformed-input.test.ts` | designed | |
| R-12.14 | Clear shutdown and restart behaviour | 01 4.5, 4.10 | | T-LC-05/15 | designed | |
| R-12.15 | Monitoring failures never block Claude Code | 02 2.1/2.11, D8 | | T-HK-01/11, SEC-25 | designed | |
| R-12.16 | Transcript content is untrusted data; never execute instructions found in it | 00 C6, 05 T16 (SKILL.md rule), 04 8, 05 S-OUT | | SEC-16/18/29 | designed | |

### 13. Migration strategy

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-13.0.1 | Phase 0 outputs: current-state architecture, feature inventory, data-flow diagram, dependency inventory, risks, capability mapping, must-preserve list | `docs/research/current-state-backend.md` A-G, `current-state-frontend.md` | n/a | review | designed | done |
| R-13.1.1 | Phase 1: module boundaries | 05 2.2, 00 D1 | | lint layering | designed | |
| R-13.1.2 | Event schemas | 02 2.3, 4.3; 03 5.5 | | | designed | I-03 |
| R-13.1.3 | Lifecycle state machine | 02 7 | | | designed | |
| R-13.1.4 | Instance isolation | 01 3, D2 | | | designed | |
| R-13.1.5 | Configuration precedence | 01 2 | | | designed | |
| R-13.1.6 | Persistence model | 03 3-4 | | | designed | |
| R-13.1.7 | API contracts | 03 5-6 | | | designed | |
| R-13.1.8 | Realtime synchronization | 03 9, 04 5.5-5.6 | | | designed | |
| R-13.1.9 | Migration and rollback strategy | 01 5.6, 06 5.9, 05 7.2.1 | | | designed | |
| R-13.1.10 | Decision records before irreversible changes | ADRs 0001-0059 | | | designed | |
| R-13.2.1 | Phase 2: Node + TS server, validated config, migrations, health endpoint, logging, core contracts, identity/isolation, unit + integration tests | 01 S1-S9, 03 S1-S5, 05 S1-S6 | | | designed | see section 3 slice check |
| R-13.3.1 | Phase 3: hook handler, install/verify, validation/normalization, idempotency, transcript import, reconciliation, token correctness, ingestion diagnostics | 02 I-1..I-11 | | | designed | |
| R-13.3.2 | No advanced charts before Phase 3 trustworthy | 03 `usageTrend` gate | | | designed | |
| R-13.4.1 | Phase 4: React + Vite, components, routing, typed client, states, explorer, detail, feed, realtime | 04 W1-W8 | | | designed | |
| R-13.5.1 | Phase 5: search, board, hierarchy, analytics, alerts, export/retention, CLI, optional MCP | 03 S8-S11, 04 W9-W12, 01 S11-S13 | | | designed | MCP deferred (R-8.9.10) |
| R-13.6.1 | Compare old and new session detection | 06 5.4, 5.6 (shadow) | `runtime/tests/parity/sessions.parity.test.ts` | G1/G2 | designed | I-09 (capture engine 05 vs 06) |
| R-13.6.2 | Compare token aggregates | 06 5.5 T1-T7, 02 6.5 | `tokens.parity.test.ts` | | designed | |
| R-13.6.3 | Test lifecycle transitions | 02 7.7, 7.12 | | G3 | designed | |
| R-13.6.4 | Test large and changing transcripts | 05 4.9 `large-file`, 06 S14/S30, B4 | | | designed | |
| R-13.6.5 | Test two or more simultaneous instances | 01 T-ISO-*, 05 ISO-*, 06 S33 | | G6 | designed | |
| R-13.6.6 | Test browser reconnect | 04 E2E step 9, DA-T-RT-12 | | | designed | |
| R-13.6.7 | Test restart and recovery | 01 T-LC-14, 05 `restart-recovery.test.ts` | | | designed | |
| R-13.6.8 | Test clean installation | 01 T-UP-01, 05 7.1 step 2 | | | designed | |
| R-13.6.9 | Test upgrade from existing configuration | 01 T-LC-12 (adoption), T-ISO-24, 06 G8 | | | designed | |
| R-13.6.10 | Update documentation and examples | 05 6, 06 7 | | `check-docs` | designed | |
| R-13.6.11 | Verified migration report | 05 7.2 | `docs/migration.md` | review | designed | |
| R-13.6.12 | Fallback path until regression checks pass | 06 5.9 gates, ADR 0056, 01 6.5 delegation | | G1-G10 | designed | I-02 (legacy `audit` breaks on `.jsonl` spool) |

### 14. Testing requirements

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-14.U.1 | Unit: schema validation | 05 4.2 | `shared/src/**/*.test.ts` | | designed | |
| R-14.U.2 | Configuration merging | 01 S5 | `engine/src/config/merge.test.ts` | | designed | |
| R-14.U.3 | Lifecycle transitions | 02 7.12 | `lifecycle.transitions.test.ts` | | designed | |
| R-14.U.4 | Token aggregation | 02 6.7 | `tokens.worked-example.test.ts` | | designed | |
| R-14.U.5 | Deduplication | 02 4.9, 03 DA-T-DB-9 | `ingest/dedupe.test.ts` | | designed | |
| R-14.U.6 | Transcript parsing | 02 5.10 T-TR-15 | `normalize-record` tests | | designed | 05 4.2 paths stale (I-22) |
| R-14.U.7 | Incremental offsets | 02 T-TR-01..09 | `ingest/tail/*.test.ts` | | designed | |
| R-14.U.8 | Filtering | 03 DA-T-API-7, 04 `filters.test.ts` | `shared/src/api/filters.test.ts` | | designed | |
| R-14.U.9 | Instance routing | 02 T-HK-05 | `shared/src/protocol/routes.test.ts` | | designed | |
| R-14.U.10 | Retention calculations | 03 DA-T-E-4 | `maintenance/retention.test.ts` | | designed | |
| R-14.I.1 | Integration: hook payload to DB | 02 T-PL-01, 05 `hook-to-db.int.test.ts` | | | designed | |
| R-14.I.2 | DB to API | 03 DA-T-API-1 | `server/test/contract/*` | | designed | |
| R-14.I.3 | API to frontend data model | 04 11.3 `api-to-web.int.test.ts` | | | designed | |
| R-14.I.4 | Persistence before broadcast | 03 DA-T-RT-1, 02 T-PL-05 | | | designed | |
| R-14.I.5 | Realtime reconnect and reconciliation | 04 11.3 `stream-reconnect.int.test.ts`, 03 DA-T-RT-2 | | | designed | |
| R-14.I.6 | Transcript import and token accounting | 02 T-TK-*, 05 `import-tokens.int.test.ts` | | | designed | |
| R-14.I.7 | CLI diagnostics | 05 `cli/test/doctor.int.test.ts`, 01 T-CLI-09 | | | designed | |
| R-14.I.8 | Instance initialization and shutdown | 01 T-LC-01, 05 `cli/test/lifecycle.int.test.ts` | | | designed | |
| R-14.E.1-14 | E2E steps 1-14 | 04 11.4 `lifecycle.spec.ts` | `packages/web/e2e/` | Playwright | designed | I-11 (`sendHook`/`hookEnvelope` vs real handler; `init --task`) |
| R-14.E.15 | Browser automation where supported | 04 11.4 Playwright `channel: 'chrome'` | | | designed | |
| R-14.1 | Never claim unrun tests; record skipped | 05 7.1-7.3, `release-check.mjs` SKIPPED rows | | | designed | |

### 15. Documentation deliverables

| Id | Requirement (short) | Design | Code | Test | Status | Notes |
|---|---|---|---|---|---|---|
| R-15.1 | `SKILL.md` | 01 Appendix A | `SKILL.md` | review | designed | installed in Phase 6 (C1) |
| R-15.2 | `docs/architecture.md` | 05 6.1 | | `check-docs` | designed | lowercase names (ADR 0049) |
| R-15.3 | `docs/data-model.md` | 05 6.1 (03 + 02 sources) | | | designed | |
| R-15.4 | `docs/configuration.md` | 05 6.1 (01 source) | | | designed | |
| R-15.5 | `docs/hooks.md` | 05 6.1 (02 source) | | | designed | |
| R-15.6 | `docs/api.md` | 05 6.1, 03 13 generated reference | | DA-T-API-2 | designed | |
| R-15.7 | `docs/instance-isolation.md` | 05 6.1 (01 source) | | | designed | |
| R-15.8 | `docs/operations.md` | 05 6.1, 06 7.1 | | | designed | I-12 (06 runbook commands do not match 01) |
| R-15.9 | `docs/testing.md` | 05 6.1 | | | designed | |
| R-15.10 | `docs/migration.md` | 05 6.1, 7.2 | | | designed | |
| R-15.11 | `docs/ccam-reference.md` | 05 6.5 | | | designed | |
| R-15.12 | `docs/decisions/` | 59 ADRs | | | designed | |
| R-15.Q.1-11 | Eleven AI-readable questions answered | 05 6.3 table | | `check-docs` | designed | |
| R-15.13 | Diagrams, tables, invariants, examples; no name-only prose | 05 6.2 rules | | review | designed | |

### 16. Non-goals

| Id | Requirement (short) | Design | Status |
|---|---|---|---|
| R-16.1-11 | Electron, Docker/K8s, multi-machine, marketplace, enterprise auth, large UI framework, cloud backend, distributed queue, per-session process, custom analytics engine, new design system | D15, 05 11, ADR 0035/0059 | non-goal |
| R-16.12 | No wholesale CCAM copy or dependency matching | 05 6.5 rule, ADR 0041 | non-goal |

### 17. Execution protocol

| Id | Requirement (short) | Design | Status | Notes |
|---|---|---|---|---|
| R-17.1 | Inspect before editing | 00 C1, Phase 0 | designed | |
| R-17.2 | Preserve uncommitted changes | 00 C4 (lead commits) | designed | process |
| R-17.3 | Record the baseline | tag `pre-v3-python`, research | designed | |
| R-17.4 | Phased plan with acceptance criteria | every design's "Phase 2+ task slices" with "Done when" | designed | section 3 of this file |
| R-17.5-7 | One phase at a time; smallest tests per change; broader at boundaries | 05 3.1 layers, `ci` | designed | |
| R-17.8 | Review for regressions and cross-instance leakage | 05 4.8/4.10 isolation + canary suites | designed | |
| R-17.9 | Docs alongside behaviour | 05 6.6 gates, AGENTS.md rule 12 | designed | |
| R-17.10 | Stable skill invocation interface | 01 6.5 legacy flags/delegation, ADR 0008 | designed | |
| R-17.11 | Never discard old config or data | 01 INV-08/09, D13 | designed | |
| R-17.12 | No fake success or metrics | 01 INV-10, 04 UI-I12, 05 7.3 | designed | |
| R-17.13 | No scaffolding-only deliverables | slices each end in passing tests | designed | |
| R-17.14 | Document blockers, continue independent work | every design's "Open items" | designed | |
| R-17.15 | Reasonable reversible decisions, documented | ADRs | designed | |

### 18. Definition of done

| Id | Requirement (short) | Design | Test / evidence | Status | Notes |
|---|---|---|---|---|---|
| R-18.1 | Still invokable and managed as a skill | 01 Appendix A, 6 | T-CLI-* | designed | |
| R-18.2 | Node + TS + React architecture | D1, D7, 05 2 | `npm run ci` | designed | |
| R-18.3 | Data-driven UI | 04 | audit test | designed | |
| R-18.4 | Runtime and template versions explicit | 01 5.2 | T-UP-10 | designed | |
| R-18.5 | Repeatable, deterministic instance init | 01 4.12 | T-LC-10/11 | designed | |
| R-18.6 | Isolation tested | 01 3.5, 05 4.8 | ISO suite | designed | |
| R-18.7 | Hook ingestion fail-safe | 02 2.11 | T-HK-01/11, SEC-25 | designed | |
| R-18.8 | Transcript import handles large and changing files | 02 5, 06 B4 | T-TR-03/11, `large-file.test.ts` | designed | |
| R-18.9 | Lifecycle semantics documented and tested | 02 7, `docs/data-model.md` | P1-P9 | designed | |
| R-18.10 | Token accounting regression coverage | 02 6.7, 06 5.5 | T-TK-*, `tokens.parity.test.ts` | designed | |
| R-18.11 | API and frontend contracts validated | 03 13, 04 11.3 | DA-T-API-1/2, `api-to-web` | designed | |
| R-18.12 | Realtime disconnection and stale data visible | 04 5.6 | E2E step 9 | designed | |
| R-18.13 | DB migrations and recovery procedures exist | 03 4, 01 5.5-5.6 | DA-T-DB-*, T-UP-* | designed | |
| R-18.14 | Existing functionality preserved or deliberately replaced | 06 5.8 D1-D35, 04 10, ADR 0055 | `diffs.parity.test.ts` | designed | |
| R-18.15 | Skill can init, inspect, start, stop, diagnose, verify | 01 6.3 | T-CLI-*, T-LC-* | designed | |
| R-18.16 | Documentation sufficient for a future agent | 05 6 | `check-docs` | designed | |
| R-18.17 | Tests, typecheck, lint, build run where supported | 05 7.1 | release-check | designed | |
| R-18.18 | Honest report of results, limitations, remaining work | 05 7.2-7.3 | report | designed | |
| R-18.R.1-9 | Final report: architecture, decisions, features, deferred, isolation proofs, commands run, migration/rollback, limitations, files to read first | 05 7.3 | report | designed | |

---

## 2. Cross-design issues (conflicts, feasibility, gaps)

Severity: blocker = implementation would fail or contradict a hard requirement; major = rework across slices; minor = polish.
"Owner" is the document that must change; "also touches" lists documents whose text must follow.

| Id | Sev | Owner | Also touches | Finding | Required fix (single authoritative shape) |
|---|---|---|---|---|---|
| I-01 | blocker | 01 | 02, 03 | `RuntimeFileSchema` (01 1.6) is `z.strictObject` with `R_TOP_KEYS = logLevel, server, process, backup, lifecycle, hooks, ingest, board, panelOptions, retention, alerts, pricing`. Design 02 reads 19 keys under `spool.*`, `import.*`, `health.*` (02 2.7, 5.4, 5.5, 8.2; e.g. `spool.pollMs`, `import.sliceMs`, `health.importLagWarnMs`) and 03 needs `analytics.usageTrend` (03 6.2, A-5). None of these top-level names exists in 01, so any such override in `runtime.json` fails validation (`CONFIG_INVALID`, server exit 10) and the defaults 02 depends on have no home. | 01 adds sections `spool` (`SpoolSectionSchema`: `pollMs 500`, `sealGraceMs 120000`, `retainHours 24`), `import` (02 5.4/5.5 keys incl. derived defaults `lookbackHours <- window_hours`, `tailWindowBytes <- limits.event_window_mb`, `backfillMaxBytes <- limits.usage_max_mb` in `R_DERIVED_DEFAULTS`), `health` (`importLagWarnMs 30000`, `backlogWarnMs 10000`), `analytics` (`usageTrend false`), all `strictObject().prefault({})`; 01 1.6 ownership table lists them (owner 02 for the first three, 03 for `analytics`). 02 keeps `ingest.queueMaxItems/queueMaxBytes` under `ingest`. Unit test: every key named in 02/03 parses through `RuntimeOverridesSchema`. |
| I-02 | major | 02 | 01, 03, 05, 06 | Spool segments are `data/spool/hooks-<hour>.jsonl` (02 2.7, ADR 0012); 03 `spool_cursors.segment CHECK (segment GLOB '*.jsonl')`; 05 1.2 and 06 7.1 repeat `.jsonl`. The legacy `audit` walks the whole workspace and reports every `*.jsonl` as "transcript copy found" with exit 1 (`tasks.py:205-211`); legacy `doctor` runs that audit. Verified in this review (section 4, X1): legacy `audit` exits 1 with a `.jsonl` spool and 0 with `.ndjson`. This breaks 01 T-XE-06, gate G8 and the brief's fallback requirement for every adopted workspace. | 02 renames segments to `hooks-<YYYYMMDD>T<HH>Z.ndjson` (same JSON Lines content; `SPOOL_SEGMENT_EXT = '.ndjson'` in `shared/src/protocol/hook-envelope.ts`); 03 changes the CHECK to `GLOB '*.ndjson'`; 01 1.1/C-1, 05 1.2, 06 7.1, D3 text follow. 01's Node `audit` keeps refusing `*.jsonl` anywhere (legacy parity). |
| I-03 | major | 02 | 03 | 03 stores hook envelopes and transcript entries in one `events` table with natural keys and `EVENT_KINDS` (03 3.5-3.6, 5.5) and lists the envelope/record to `kind` mapping only as an assumption (03 A-2, O-4a). 02 4.1 still specifies two entities (`hook_event`, `transcript_entry`) with different natural keys and never names the stored `kind` values; 02 I-5/I-8 and 03 S2 cannot both start from the current text. 03 says the fallback (two tables) must be decided before `0001` ships. | 02 4.1 adopts the single `events` table and 03 3.6 natural-key table verbatim, and adds a normative column "stored `kind`" to its 4.3 envelope table and 5.6 record table equal to 03 A-2 (SessionStart -> `session.start` ... unknown hook -> `hook.unknown`). 03 removes the "assumed" label from A-2 and freezes `0001`. |
| I-04 | major | 02 | 05, 04 | Error-code names differ: 03 uses lowercase codes (`host_not_allowed`, `origin_not_allowed`, `cross_site_request`, `payload_too_large`, `validation_failed`, `instance_mismatch`, `stream_limit`, `cursor_invalid`); 02 2.8 uses `ORIGIN_FORBIDDEN`, `PAYLOAD_TOO_LARGE`, `VALIDATION`, `INSTANCE_MISMATCH`; 05 S-NET uses `HOST_FORBIDDEN`, `ORIGIN_FORBIDDEN`, `CSRF_REJECTED`, `TOO_MANY_STREAMS` and its SEC tests assert them; 04 13 assumes six coarse codes and `409 cursor_expired`. 05 already says the API catalogue wins. | Authoritative: 03 5.2 catalogue. 02 2.8, 05 5.3/5.6 (SEC-02..07) and 04 13/5.3 replace their names with 03's (`csrf_rejected` reserved, `stream_limit`, `cursor_invalid` 400). One shared `ErrorCode` union in `shared/src/api/errors.ts`; 05 `tests/security/*` import it. |
| I-05 | major | 01 | 00, 05 | Node floor: D7 and 01 5.1 / ADR 0007 say 22.12.0 (warning below 22.22); 05 C-1 and the scaffold `engines` say `^22.22.0 || ^24 || >=26` because react-router 8.4.0 declares `>=22.22.0` and the launcher builds web on the user's machine. Two floors in two documents. | One floor: 22.22.0. 01 5.1 step 1 and ADR 0007 change the check and the message (`Node >= 22.22.0 is required`), drop the warning branch; 00 D7 is annotated by the lead. |
| I-06 | major | 01 | 06, 05 | Three signatures for the one process helper: 01 4.2 `execFileText(file, args, {timeoutMs, cwd, env, maxStdoutBytes}) -> {code, signal, stdout, stderr, timedOut}`; 06 3.6 `execFileText(spec: ChildSpec{kind,file,args,cwd,timeoutMs,maxOutputBytes,encoding,extraEnv}, signal?) -> ChildResult{ok,code,stdout,stderr,error,truncated,durationMs}` (never throws, semaphore, stats); 05 S-PROC names the function without a signature. 01 and 06 also both specify `platform/process.ts` (`commandLineOf` built with `-Command` vs `-EncodedCommand`; `forceKill`+`waitForExit` vs `killPid`). Slices 01 S4 and 06 PP1 would write the same files. | Authoritative: 06 3.6 `ChildSpec`/`ChildResult` (measured, adds kinds, caps, stats) with 05's security rules; add kind `node` for the launcher/legacy-delegation spawns and keep 01's `spawnDetached(file,args,{cwd,env,stdoutFd,stderrFd})` and `spawnForeground` in the same file. `process.ts`: `pidAlive`, `commandLineOf` (06 `-EncodedCommand` form, 5 s cache), `forceKill(pid)`, `waitForExit(pid, timeoutMs)` (01), `killPid` removed (= `forceKill` + `waitForExit`). 01 4.2 rewrites its block to import these; 06 PP1 owns `exec.ts` additions, 01 S4 owns `mutex.ts` and `fsio.ts` only. |
| I-07 | major | 03 | 06, 02 | Attempts persistence: 06 3.10.2 proposes `attempt_source`/`attempt_run` with an `instance_id` column, soft `seq`, non-STRICT naming; 03 `0001_initial.sql` has no attempts tables and 03 C-1 rejects per-row `instance_id`. 06 OI-2 is open; without the tables 06 PP5 has no DDL and the legacy attempts panel (C.5 parity, D9 external evidence) cannot be built. | 03 adds to `0001_initial.sql` (before it is frozen) `attempt_sources (id, path, path_key UNIQUE, generation, ino, head_len, head_hash, read_offset, config_sha256, updated_at) STRICT` and `attempt_runs (id, source_id soft ref, generation, start_offset, part, n_raw, model, effort, started_at, end_offset, ended_at, exit_raw, status_raw, end_reason CHECK, state CHECK, evidence, session_id soft ref sessions(id) or NULL, match_delta_ms, updated_seq, updated_at, UNIQUE(source_id, generation, start_offset))` with the three indexes of 06 3.10.2 minus `instance_id`; `changes.kind` gains `attempt` (kind/op `attempt/upsert`) or 06 publishes through `session/upsert` only. 06 3.10.2 then references 03's names. |
| I-08 | major | 02 | 01 | 01 6.3/6.4 `verify-completion` and `InstanceReader.explainCompletion(target: CompletionTarget) -> CompletionEvidence {outcome, state, basis, confidence, evidence[]}` depend on "lifecycle design (02 section 7)", but 02 defines no such function or types (grep: no `explainCompletion`, `CompletionEvidence`, `CompletionTarget`). Brief 8.9 "verifying task completion evidence" has no implementation owner. | 02 7.13 (new) defines `CompletionTarget = {sessionId} | {label} | {attemptPart}`, resolution order (session id, exact label newest first, attempts rows by part newest START), `CompletionEvidence {outcome: 'completed'|'failed'|'not_terminal'; state: LifecycleState; basis; confidence; evidence: EvidenceItem[]; sessionId; ruleId}` where `outcome` is terminal only when `basis === 'observed'` (D9), and `explainCompletion(queries, target)` in `engine/src/lifecycle/completion.ts`; 03 12.1 adds it to `EngineQueries`; 01 keeps the CLI mapping. Tests: 01 T-CLI-08 fixtures plus a unit table over S-1/S-3/S-4/S-8e. |
| I-09 | major | 05 | 06 | Two golden-capture procedures: 05 4.11.4 captures projections at real `now` with 10 s age buckets into `tests/legacy-parity/golden/<scenario>/<projection>.json` + `manifest.json`; 06 5.2 / ADR 0053 captures raw legacy responses under a frozen clock into `golden/{meta.json,trees,api,cli,vectors}` and keeps 05's command name. Two layouts for one folder; 05 S8 and 06 PP2/PP4 both own `tests/legacy-parity/**`. 06's approach is evidenced (E12: two byte-identical captures, skill tree clean). | 05 4.11.4 and ADR 0044 adopt 06 5.2 (frozen clock, raw responses, `capture_golden.py`, `--check`), delete the 10 s bucket rule from 4.11.3, and keep live mode. Ownership: 06 PP2 owns `tests/legacy-parity/tools/**` and `golden/**`; 05 S8 owns `runtime/tests/parity/{projections,normalize,run-python}.ts` and `parity-capture.mjs` (a thin wrapper calling the Python tool). |
| I-10 | major | 04 | 03 | 04 section 13 contracts differ from 03 in the rows 03 15.1 marks "adapt": `taskIds`/`task` -> `workItemIds`/`workItem`; `/tasks` API -> `/work-items`; `TaskBoard`/`TaskCard`/`task` stream kind -> `WorkItemBoard`/`WorkItem`/`work_item`; `ActivityEvent.id` string -> number; `transcriptRef.index` -> `offset`; `gapBefore` -> `monitor.gap` events; sources `derived/external` -> `monitor`; `TranscriptSearchQuery.sessionId` -> `session`; `409 cursor_expired` -> `400 cursor_invalid`; `StreamReset.reason` enum; `config/invalidate` kind does not exist; `transcript/append` data `{agentId, sizeBytes}`; `features.transcriptSearch 'session'|'instance'`; `InstanceInfo` + `epoch`, `limits`; `AlertItem` shape; `UsageSeries` numbers with omitted buckets; `ToolFrequencyRow.failed`; panels wrapped in `PanelResponse` (06 CH-3/OI-1). 04 5.2 query table and 5.5 dispatch table still use the old names. | 04 rewrites section 13 as "contracts imported from `@mcs/shared` (03 5.5, 9.2, 06 3.3)" with no own definitions, renames `useTasks`/`qk.tasks` to `useWorkItems`/`qk.workItems` (UI route `/tasks` and URL param `task` may stay as UI-only names mapped to `workItem`), updates 5.5 to 03's `StreamChange` kinds (`workflow`, `tool_call`, `alert` added; `data: null` invalidation), `usePanel` reads `PanelResponse.data` and maps `status`/`sources` to `PanelStatus`, and drops `gapBefore`/`config` handling. |
| I-11 | major | 04 | 05, 06, 02 | 04 11.5 proposes testkit functions `hookEnvelope(event, payload, {eventUid, receivedAt})`, `sendHook(handlerPath, envelopePayload, env)`, `writeSpoolLines(dir, (HookEnvelope|string)[])` and assumes an envelope field `hook_event_name` (S-11); 02 2.3 names the field `event`, and 06 6.2 rules that spool lines come only from the real handler (`runHookHandler`, 05 4.4). E2E step 4 passes an "envelope" to the handler, which reads a raw hook payload. `init --task e2e-a` (step 1) is not an `init` option (01 6.3: `--slug`). | 04 11.4/11.5 use 05's `hookPayload` + `runHookHandler(payload, {mcsHome})` for steps 4, 12, 13 (malformed lines appended as raw text, 06 6.2), delete `hookEnvelope`/`sendHook`/S-11, import `HookEnvelopeV1` from `@mcs/shared/protocol` where the type is needed, and use `$MCS init --slug e2e-a --name "FIXTURE e2e-a" --repo <repo> --port 18510 --config <demo config>`. |
| I-12 | major | 06 | 01, 03 | 06 7.1 runbook names commands and outputs that do not exist in 01: `$MCS restore --task X --from <file>` (01: `backup restore --task X --id ID`), `$MCS reimport --task X --yes` (no such command; 03 4.4 recovery = move `monitor.db` aside and `start`), `cleanup --task X --dry-run` without `--scope` (01 requires a scope), `backup` to `data/backups/<slug>-<ts>.db` keeping 10 (01: folder `<backupId>/` with manifest, `backup.keep` 5), `export --include-text` (01: `--include-content`), `verify` calls "panels" (01: health, instance, sessions, overview, legacy health), health fields `process/ingest/hooks/panels/children` (03: `runtime/db/ingestion/alerts/errors`), logs rotated at 10 MB x 5 (undefined, I-25). | 06 7.1 and 7.2 are rewritten against 01 6.3/6.4 and 03 6.2 before PP11; `reimport` is removed (recovery per 03 4.4) or 01 adds `mcs db rebuild --task S --yes --confirm <slug>` (stopped instance: backup, move DB aside, next start re-imports) with an audit action; the runbook table cites the 01 section per command. |
| I-13 | blocker | 04 | 05 | 04 12.2 `vite.config.ts` defaults `MCS_DEV_API` to `http://127.0.0.1:8765` (the owner's live legacy monitor; hard rule "no ports 8765/3000/3100/8080/8089") and dev server port 5173; it lacks `resolve.conditions: ['@mcs/source', ...defaultClientConditions]` (05 2.8/ADR 0040: without it the dev server and build need a prior `tsc -b`). 05 A.27 already carries the corrected stub (18765, 18766, conditions). | 04 12.2 adopts 05 A.27: `MCS_DEV_API` default `http://127.0.0.1:18765`, `MCS_WEB_DEV_PORT` 18766, preview 18767, `resolve.conditions` line, and the dev-workflow text names `npm run dev` (05 3.1). |
| I-14 | minor | 05 | 03 | 05 eslint config allows `better-sqlite3` only in `packages/engine/src/db/sqlite.ts`; 03 4.5 names the single driver module `packages/engine/src/db/driver.ts` (and its grep test). | 05 A.9 (two rules) and 05 2.2 use `db/driver.ts`. |
| I-15 | major | 01 | 02, 03, 06 | No document owns the server-side composition root: 06 depends on `InstanceContext {instanceId, repoDir, config, clock, db, errors, exec}` and `engine.ingestUntilIdle({timeoutMs})` "owned by the instance design"; 02 says "the process main wires `IngestService` and `LifecycleSweeper` start/stop" but defines neither; 01 4.4 boot step 11 says "start ingestion, timers" without an interface; 03 S4 depends on "01 S8 server main". The parity harness (06 5.4 step 3), 02 I-11 and 03 S4 all need the same object. | 01 4.4 (slice S8) defines `createInstanceRuntime(ctx: InstanceContext) -> { start(): Promise<void>; stop(deadlineMs): Promise<void>; ingestUntilIdle(o: {timeoutMs}): Promise<void>; health(): HealthReport }` in `packages/engine/src/runtime/instance-runtime.ts` and the `InstanceContext` type (06's fields plus `claudeHome`, `mcsHome`, `logger`, `queries`); 02 4.6 (new 4.10) defines `createIngestService(ctx) -> { start, stop, untilIdle, stats }` and `createLifecycleSweeper(ctx)` with the same start/stop shape; 03 `createQueries` and 06 `createPanelService(ctx)` plug into it. |
| I-16 | minor | 02 | 03 | 02 4.6 describes the writer transaction with `better-sqlite3 db.transaction` and a `ChangeSink.flush()` after COMMIT; 03 4.5 makes `withWriteTx(db, ctx, fn)` the only transaction entry point (lint-enforced, DA-I12) and implements `ChangeSink.flush/discard` as no-ops. | 02 4.6 text: "one `withWriteTx` call per tick; `record()` -> `reserve()`; publication happens in `onCommitted`". No behaviour change. |
| I-17 | minor | 02 | 05 | 02 1.1 lists the handler as `cli/src/hook/{main,...}.ts` emitted as `dist/hook.js`; `tsc` emits `dist/hook/main.js` for that layout. 05 2.2 and its lint block expect `cli/src/hook.ts` + `cli/src/hook/**`. | 02 1.1 adds `runtime/packages/cli/src/hook.ts` (entry: `export { runHook } from './hook/main.ts'`, run when `import.meta.main`), keeping the lint regex of 05 valid. |
| I-18 | major | 02 | 06 | 06 3.10.3/3.10.7 emit `{k: 'external.attempt_cleared', sessionId, observedAt}` after a chain-log config rebuild; 02 4.3 has no such event and the `attempt` fact is LWW, so stale COMPLETED/FAILED evidence would survive a config change (wrong state, S-1). | 02 4.3 adds the event; 7.3 merges it as `attempt` LWW with value `null` (cleared) at `observedAt`; S-1 treats a null value as "no attempt evidence"; T-LC adds a row "cleared after rebuild -> state re-derived without S-1". |
| I-19 | minor | 01 | 03 | 03 A-7 and `SessionDetail.auditRefs` need `entriesBetween(fromMs, toMs, limit)` over `audit/changes.md` and `decisions.md`; 01 7.1 defines only `appendChange`, `appendDecision`, `lastChange`, `recentAudit`. | 01 7.1 adds `entriesBetween(ws, fromMs, toMs, limit): {file, at, title, summary}[]` (parse `## <ts> | <title>` headers with the legacy split rule, universal newlines). |
| I-20 | minor | 01 | 03, 04 | `GET /api/v3/config` returns `ConfigInspection` "from the 01 inspect service" (03 6.1, 04 13), but 01 defines only the legacy `inspect` JSON (`effective`, `provenance`, ...), never a `ConfigInspection {entries[], files[]}` type. | 01 2.5/6.4 defines `ConfigInspection { entries: {key, value, source}[]; files: ConfigFileStatus[]; effectivePort; engine }` in `shared/src/cli/results.ts` as a pure projection of `inspect` (regex and path values included: local UI; the diagnostics bundle keeps its redaction). |
| I-21 | minor | 06 | 03, 01 | 06 8.2 and OI-6 request fields on a `DiagnosticsReport.server` that 03 does not define (03 has `HealthReport.runtime.eventLoopDelayP99Ms`; 01 has `DiagnosticsBundle 'mcs.diagnostics/1'`). | 03 6.2 adds `HealthReport.runtime.{rssBytes, heapUsedBytes, cpuUserMicros, cpuSystemMicros}`, `HealthReport.children: Record<ChildKind, {spawned, failed, timedOut, totalMs}>` and `HealthReport.panels: PanelStats`; 06 8.2 and 3.4 cite `HealthReport`; 01's `DiagnosticsBundle.health` carries it unchanged. |
| I-22 | minor | 05 | 02, 03 | 05 4.2 coverage map names test paths that do not exist in the owning designs (`engine/src/ingest/transcript/parse.test.ts`, `cursor.test.ts`, `engine/src/retention/plan.test.ts`, `engine/src/instances/scope.test.ts`, `cli/src/hook/route.test.ts`, `tokens/message-dedupe.test.ts`). | 05 4.2 points at 02/03 names: `ingest/transcripts/normalize-record.test.ts`, `ingest/tail/jsonl-tailer.test.ts`, `maintenance/retention.test.ts`, `shared/src/protocol/routes.test.ts`, `tokens/aggregate.test.ts`. |
| I-23 | minor | 05 | 01 | Isolation test ids: 01 T-ISO-01..27 and 05 ISO-1..9 cover the same eight brief bullets with different granularity and file names; the traceability matrix (05 7.4) needs one id per row. | 05 4.8 keeps ISO-1..9 as the brief-bullet ids and lists the 01 T-ISO numbers that implement each (ISO-1 = T-ISO-01..05, ISO-2 = 06..08, ISO-3 = 09/10, ISO-4 = 11/12, ISO-5 = 13..15, ISO-6 = 16/17, ISO-7 = 18..23, ISO-8 = 24..27, ISO-9 = 02 T-HK-05); files follow 05 4.3. |
| I-24 | minor | 05 | 01 | Bootstrap serialization: 05 3.3.4 step 3 and ADR 0047 use a `mkdir` lock `runtime/.mcs-bootstrap.lock` with a 10 min staleness rule; 01 5.1 and ADR 0007 use the OS-released `ProcessMutex` (named pipe, E10) and argue a `mkdir` lock survives a crashed bootstrap. | 05 3.3.4 step 3 and ADR 0047 reference `acquireMutex(mutexName('bootstrap', realpath(runtimeDir)))` (01 4.2); the launcher owns the copy of the mutex primitive (zero deps). |
| I-25 | minor | 05 | 01, 06 | Log rotation: 01 1.6 says "rotation size and count are constants of the 05 logger"; 06 7.1 says 10 MB x 5; 05 S-LOG defines levels and the allow-list but no rotation at all. | 05 S-LOG-6: `LOG_ROTATE_BYTES = 10 * 1024 * 1024`, `LOG_KEEP = 5`, rename chain `runtime.log.1..5`, rotation checked before each append, retry rule of ADR 0058 on Windows. |
| I-26 | minor | 05 | 01 | 05 3.1 scripts `migrate` -> `node packages/cli/dist/main.js migrate`; 01 has `db migrate` and `config migrate` (two words), no bare `migrate`. `hookPayload` in 05 4.4 lists 16 events; 02 installs 21 (missing TaskCreated, TaskCompleted, TeammateIdle, PostModelSwitch, CwdChanged). `runHookHandler` spawns `dist/hook.js` directly while the installed command is the stub `scripts/mcs-hook.mjs`. `buildDemo({root, nowMs})` returns `{claudeHome, repo, config, ids}` while 04 11.5 (the contract owner per 06 6.1) returns `DemoResult` with `expected`, `hooks`, `configJson`. `buildTaskWorkspace.instance` lacks `slug, createdAt, createdBy, engine, hooks, upgradedAt` of `InstanceFileSchema`. 05 1.2 calls `MCS_HOME` "test-only" while 01/02 make it the per-user state folder. `RUN_ID_RE` `/^wf_[0-9a-f]{8}-[0-9a-f]{3}$/` vs 02/03 `^wf_[A-Za-z0-9_-]{1,64}$`. | 05 3.1 `"migrate": "node packages/cli/dist/main.js db migrate"`; 4.4 `HookEventName` = `INSTALLED_HOOK_EVENTS` (21) imported from shared; `runHookHandler` spawns `node --no-warnings <skill>/scripts/mcs-hook.mjs --mcs-hook <Event>` (option `direct: true` for the dist file); `buildDemo` signature = 04 11.5; `buildTaskWorkspace` writes a full `InstanceFile`; 1.2 describes `MCS_HOME` per 02 2.6.1; `RUN_ID_RE` = 02's pattern. |
| I-27 | minor | 01 | 06, 02, 05 | 01 2.10 claims a complete env list, but 06 reads `MCS_FS_WATCH=0`, 02 reads `MCS_PERF_FACTOR`, 01/02 read `MCS_TEST`, 01 reads `MCS_TEST_IGNORE_CONTROL`/`MCS_TEST_BOOT_HANG`/`MCS_TEST_INIT_CRASH` (test builds), 05 `MCS_PARITY_LIVE`, `MCS_GOLDEN_DIR`, `MCS_E2E_CLAUDE`, `MCS_DEV_API`, `MCS_WEB_DEV_PORT`, `MCS_BUILD_ID`, `MCS_LAUNCHER_NO_BOOTSTRAP`. | 01 2.10 gains a second table "test and development variables" with these names, readers and effects, and the sentence "no other `MCS_*` variable is read" becomes a grep test (`tooling/env-vars.test.ts`). |
| I-28 | major | 06 | 01 | 06 4.3 `atomicWriteFile`/`readSmallFile` in `platform/fsx.ts` duplicate 01 1.2 `writeFileAtomic`/`readTextUniversal` in `workspace/fsio.ts` (different budgets 3000 vs 2000 ms, async vs sync), and 06 4.3 step 5 writes the shared legacy JSON files with `JSON.stringify(v, null, 2)`, which ADR 0003 / 01 1.9 reject (3,340 of 26,016 number lexemes differ from Python; INV-02 byte compatibility, gate G8). | One module `engine/src/platform/fsx.ts` (06 async API, 3000 ms budget) used by 01's `writePyJsonFile` (PyJson serializer, ADR 0003) and by panels; 01 1.2 drops `fsio.ts` or makes it a thin wrapper; 06 4.3 step 5 is replaced by "shared JSON files are written through 01's `writePyJsonFile`". |
| I-29 | minor | 02 | 01 | 02 2.7 names the CLI command `mcs ingest replay --task <slug> [--from <segment>]` (T-PL-03) and 02 3.1 gives `mcs hooks *` its own `--json` object; 01 6.3 has no `ingest replay` and requires `--json` output inside the `mcs.cli/1` envelope. 02 3.5 step 12 audit summary ("`<scope>: <n> events`") differs from 01 7.2 (`<scope> settings ~/<path>: <n> added, <m> replaced, <k> removed`). 02 3.5 uses its own `wx` lock file instead of 01's mutex. | 01 6.3 adds `ingest replay --task S [--from SEGMENT] [--yes]` (stopped instance or control op `replay`; sets `spool_cursors.offset_bytes = 0`, `sealed = 0`; audited `ingest-replay`); 02 3.1 nests its object as `data` of the envelope and uses 01's audit template; 02 3.5 step 1 uses `acquireMutex(mutexName('settings', path))`. |
| I-30 | minor | 03 | 01 | 03 `LegacyHealth` = `{ok, version, pid, started, uptime, now, code_stamp, engine, instance_id}`; 01 C-4 lists additionally `task, config_source, errors, reader` and camelCase `instanceId`. Legacy `instance_alive` needs only `pid` (verified `cli.py:69-81`), but legacy `status` reads more fields from the same body. | 03 6.2 adopts 01's list: `{ok, version, pid, started, uptime, now, code_stamp, engine: 'node', instanceId, task, config_source: 'task', errors: [], reader: {}}`; DA-T-API-11 asserts the key set against the legacy `status` reader. |
| I-31 | minor | 03 | 01 | 03 asks 01 for `server.devOrigins: string[]` (A-5) while 03 5.2 and ADR 0045 say dev mode works because the Vite proxy rewrites `Origin`, and 05 5.4 forbids any non-loopback allowance. | 03 drops `server.devOrigins` from A-5 and 15.2 (no code change needed); the Origin allow-list stays exactly two values. |
| I-32 | minor | 02 | 03 | `MAX_LINE_BYTES` exists twice: 02 `import.maxLineBytes` (configurable, 64 MiB) and 03 `shared/src/db-constants.ts MAX_LINE_BYTES` ("same constant as 02 5.3"); the transcript window and search (03 7) and `readEntryText` must agree with the importer on one value. | One constant `MAX_LINE_BYTES = 64 * 1024 * 1024` in `shared/src/protocol/limits.ts`; 02 removes `import.maxLineBytes` from `runtime.json` (test cap via an injected option). |
| I-33 | minor | 02 | 03 | 03 relies on `renderEvidence(item, now)`, `viewChanged`, `toLegacy` as exported 02 functions; 02 names `viewChanged` (7.8) and `toLegacy` (keyInterfaces) but only describes evidence rendering in prose (7.1). | 02 7.1 exports `renderEvidence(item: EvidenceItem, now: number): string` (table of `fact` -> template, e.g. `clock:quiet` -> "quiet 12m") in `engine/src/lifecycle/rules.ts` with a golden table test. |
| I-34 | minor | 06 | 01, 02 | 06 4 says `process.platform` may be branched on only under `engine/src/platform/` (lint `no-restricted-properties`); 02's handler (`routeKey` lowercases on win32, `shared/src/protocol/sanitize.ts`), 01 `mutexName`, 01 4.1 marker compare and 05 `build-stamp.mjs` branch on it outside that folder. | 06 4 scopes the rule to `packages/engine/src/**` with an allow-list `platform/**`, `security/paths.ts`; shared protocol and scripts are exempt. |
| I-35 | minor | 06 | 03 | 06 3.2 puts panel contracts in `shared/src/contracts/panels.ts`; 03 keeps every API contract under `shared/src/api/*.ts` and the route registry imports from there. | 06 uses `shared/src/api/panels.ts`; 03 route `panel` response schema = `PanelResponseSchema`. |
| I-36 | minor | 01 | 05 | Clock injection differs: 01 `OpContext.now: () => Date`; 05 `interface Clock { now(): number }`; 02/03/06 `() => number` (epoch ms). | 01 uses `clock: Clock` (05) everywhere; `Date` values are derived at the call site. |

Feasibility notes (no change required, recorded for the lead):
- F-1 (02 2.1, hooks `args` exec form): the settings schema supports `command` + `args` (research `claude-code-hooks.md` 3.1, D1:454-461) and the lab used it; the stub path survives `npm ci` (02 C1). Verified by research, not re-run here.
- F-2 (03 C-1, no per-row `instance_id`): acceptable under D2 (one file per instance) with the `application_id` + `meta.instance_id` + `RepoContext` checks; the brief's "every query respects the instance boundary" is met by construction. A later shared-process mode would need the column (03 says so).
- F-3 (01 4.3, named-pipe lock on Windows; abstract socket on Linux): Windows verified (E3/E10); Linux and macOS UNVERIFIED and release-gated to the 05 CI matrix (01 open item 1). Acceptable because Windows is the owner's platform; CI must run before cutover (G1).
- F-4 (06 3.7.3, PowerShell one-shot): verified cost; Constrained Language Mode and AppLocker fallbacks UNVERIFIED but degrade to `unavailable` without affecting correctness.
- F-5 (03 7.4 cold-cache scan): UNVERIFIED; the budget/continuation design degrades honestly (`stoppedBy: 'time_budget'`).
- F-6 (03 O-3): `@types/better-sqlite3@9.6.0` coverage of `backup()` against 13.0.3 UNVERIFIED; local augmentation planned.
- F-7 (05 2.6): typed linting of probe files excluded from tsconfig UNVERIFIED; fallback stated.
- F-8 (04 O-2): React render cost for a 2,000-5,000 entry transcript window UNVERIFIED; perf spec with a cap fallback planned.
- F-9 (02 OI-3): duplicate hook registrations assumed to deliver identical stdin bytes; entities stay correct either way (D-6/D-7).
- F-10 (D8 `node <abs>/hook.js`): 02 C1 refines D1/D8 with a committed stub; the evidence (24 `hook_non_blocking_error` entries per broken handler run) justifies it; the lead should accept C1 explicitly.
- F-11 (D11 heartbeat comments / Last-Event-ID): refined identically by 03 C-2 and 04 CH-1/CH-2 with browser evidence; the lead should annotate D11.
- F-12 (D1 five packages): 05 C-2 adds `@mcs/testkit`; 04, 06, 01 all depend on it; accept.
- F-13 (D1 `tests/legacy-parity/` executable tests): 05 C-3 moves executable tests to `runtime/tests/parity/`; artefacts stay; accept.

## 3. Slice consistency check (Phase 2+ task slices across documents)

| Check | Result | Action |
|---|---|---|
| File ownership overlaps | `engine/src/platform/{exec,process}.ts`: 01 S4 and 06 PP1 (I-06). `platform/fsx.ts` vs `workspace/fsio.ts`: 01 S4 and 06 PP1 (I-28). `server/src/http/guards.ts`: 05 S6 and 03 S4 (03 defers to 05; codes from 03, I-04). `tests/legacy-parity/**`: 05 S8 and 06 PP2 (I-09). `runtime/packages/testkit/**`: 05 S2/S3, 04 W13, 06 PP3/PP6 (06 6.1 splits modules; 04 W13 must shrink to "requirements on testkit", not files). `runtime/eslint.config.js` web block: 04 W1 and 05 S1 (04 says "coordinate"; make 05 S1 the owner, 04 supplies the rule list). | Lead assigns each file to one slice as in the issue fixes; 04 W13 becomes "consumer of testkit (05 S3 + 06 PP3)". |
| Ordering | 03 S1 (DB core, `0001_initial.sql`) must land before 02 I-4/I-8, 06 PP5 and 01 S8; 03 freezes `0001` only after I-03 and I-07 are resolved. 01 S1 (shared contracts incl. runtime sections) must absorb I-01 before 02 I-1 and 03 S3 import them. 01 S8 (server shell) needs 03 S1 and the composition root (I-15) before 03 S4 and 02 I-11. 06 PP1 (exec additions) must precede 01 S9 (`stop` forced path) and 06 PP7. 05 S1 scaffold is first for everyone (every design agrees). | Proposed order: 05 S1 -> 01 S1 (+I-01) -> {01 S2, 01 S3, 02 I-1, 03 S3, 05 S2} -> 03 S1 (+I-03, I-07) -> {01 S4/06 PP1 merged, 05 S6} -> 01 S5, S6 -> 03 S2 -> 02 I-3, I-5, I-6, I-7 -> 01 S8 (+I-15) -> 03 S4, S5 -> 02 I-4, I-8 -> 01 S9 -> 03 S6, S7 -> 04 W1..W8 -> 02 I-9, I-10 -> 06 PP5, PP7 -> 03 S8..S11 -> 01 S11..S15 -> 04 W9..W12 -> parity (06 PP2..PP4, PP8; 05 S8) -> 05 S7, S9 -> 06 PP9, PP10 -> docs (05 S10, 01 S16, 06 PP11). |
| Independent testability | Every slice names "Done when" tests. Exceptions: 04 W13 (ownership unclear, O-4), 06 PP4 ("the rest listed as pending" is not a pass criterion: must list the exact vector files expected to pass at that point), 01 S13 depends on three designs at once (split: S13a readers over 03 S5 queries; S13b `verify-completion` after I-08). | 04 drops W13 as a file-owning slice; 06 PP4 enumerates its vectors; 01 splits S13. |
| Missing slices | (a) Composition root / instance runtime (I-15): no slice owns `engine/src/runtime/*`; add to 01 S8. (b) `ingest replay` CLI (I-29): add to 01 S13b or 02 I-4. (c) `explainCompletion` (I-08): add 02 slice I-7b. (d) Attempts DDL (I-07): add to 03 S1. (e) `renderEvidence`/`viewChanged`/`toLegacy` exports (I-33): 02 I-7. (f) Env-var grep test (I-27): 05 S1. (g) Log rotation (I-25): 05 S6. | Listed in the issue table; each is small. |
| Phase mapping | 02 I-2 (handler) is Phase 3 but 04 W14/E2E and 06 S31/S32 fixtures need it in Phase 4; 03 S8 search is Phase 5 but E2E step 7 (Phase 4 smoke in 04) needs it. | 04 marks steps 7 and 13-14 of the Phase 4 smoke as Phase 5/6 additions; or 03 S8 moves to Phase 4. |

## 4. Experiments run for this review (2026-10-11, Windows 11 Pro 10.0.26200, Node v24.14.1, Python 3.14.3)

Scratch folder `D:/mvp/private/scratch/mcs-v3/critic/`. No legacy file was modified; `PYTHONDONTWRITEBYTECODE=1`; the skill's `git status` showed only the pre-existing untracked design files before and after.

| Id | Question | Command | Result |
|---|---|---|---|
| X1 | Does the legacy `audit` reject a spool file named `*.jsonl` (01 C-1)? | `python template/viewer.py init-task --name "critic probe" --repo <tmp>`; create `data/spool/hooks-20261011T14Z.jsonl`; `python template/viewer.py audit --repo <tmp>`; rename to `.ndjson`; `audit` again | `.jsonl`: `ok: false`, problem `transcript copy found (never copy transcripts): data\spool\hooks-20261011T14Z.jsonl`, exit 1. `.ndjson`: `ok: true`, exit 0. Confirms I-02 and the proposed fix. |
| X2 | Which `/api/health` fields does the legacy CLI need (01 C-4 vs 03 6.2)? | read `src/backend/cli.py:69-81, 247, 267, 371` | `instance_alive` compares only `pid`; `verify` also calls `/api/config`, `/api/sessions`, `/api/overview` (will fail against Node by design); `status` reads the health body (I-30). |
| X3 | Does the legacy audit walk the whole workspace? | read `src/backend/tasks.py:205-211, 218-233` | `os.walk(d)` over every file; `snapshot()` hashes every file except `state.json` (confirms 01 C-2). |
| X4 | Do hook settings support the exec form (`args`)? | read `docs/research/claude-code-hooks.md` 3.1, 3.4 (D1:454-461) | `command` + `args` exec form documented and used in the lab (F-1). |
| X5 | Referenced-but-undefined interfaces | `grep` over the six designs for `explainCompletion`, `renderEvidence`, `IngestService`, `ingestUntilIdle`, `entriesBetween`, `ConfigInspection`, `probes`, `attempt_cleared`, `attempt_run`, `ingest replay`, rotation constants, `spool.`/`import.`/`health.` sections | Each is referenced by one design and defined by none (I-01, I-07, I-08, I-15, I-18, I-19, I-20, I-25, I-29, I-33) or defined only in 03 as `hook_probes` without a route (I-37 below). |

I-37 (minor, owner 03, also 02): 02 3.7 V7 polls `GET /api/v3/ingest/probes/:sessionId` and 02 keyInterfaces list it; 03 6.1 has no such route (only the `hook_probes` table). Fix: 03 adds route `ingestProbe` `GET /api/v3/ingest/probes/:probeSessionId` -> `{ receivedAt, committedAt } | 404 probe_not_found`, probe id validated by the `00000000-0000-4000-8000-` prefix rule.

## 5. Uncovered requirements (status `gap`)

| Row | Requirement | Why it is a gap | Closed by |
|---|---|---|---|
| R-7.E.13 | Attempts (chain-log runs) persisted entity | 06 proposes DDL; 03's migration has none | I-07 |
| R-8.3.11 | Project/task audit references in session detail | 03 depends on an undefined 01 function | I-19 |
| R-8.9.9 | Verify task completion evidence (`verify-completion`) | 01 depends on an undefined 02 function | I-08 |

Every other brief bullet is `designed`, `deferred-with-reason` (R-8.8.7 webhooks, R-8.9.10 MCP) or `non-goal` (section 16, R-12.4).
The three gaps are each closed by one named issue above; no requirement lacks an owner after the issue list is applied.
