# 97 Reconciliation log: final verification of the design set before Phase 2

Status: written 2026-10-11 by the final verifier. Inputs: `00-foundations.md`, designs `01`-`06` as reconciled by their owners (01 revision 4,
02 revision 2026-10-11c, 03 reconciliation pass, 04, 05 revision 2, 06 revision 4), `90-implementation-plan.md`, `98-contract-registry.md`,
`99-requirements-matrix.md`, ADRs 0001-0059 and the residual list `private/scratch/mcs-v3/phase1b-residuals.json` (29 open issues, 59 conflicts).
No git command was run and no legacy file was touched. Nothing was executed except read-only searches and small analysis scripts under the
scratch folder; this log therefore proves agreement of texts, not behaviour of code.

Method: for every item both sides of the contradiction were located by searching all six designs, the 59 ADRs, the registry and the plan
for the old spelling (must be gone) and for the new spelling (must be present and identical), and the cited sections were read. The plan
was parsed (master DAG, 79 work-package blocks, shared-file register) and cross-checked against the registry and the slice tables of the
designs. A status is CLOSED only when every document involved agrees. FIXED-NOW means the verifier edited the named documents (section 2).

## 1. Result

| Measure | Count |
|---|---|
| Residual items checked | 88 (29 open issues, 59 conflicts) |
| CLOSED | 84 (27 of 29 issues, 57 of 59 conflicts) |
| STILL-OPEN, all minor | 4 residuals = 2 defects: I-22 / C38 (one wrong test file name in 06 OI-1) and N-12 / C37 (stale test ids in `99`) |
| Blockers remaining | 0 |
| Majors remaining | 0 |
| Registry second-pass rows C60-C63 | C60 FIXED-NOW (F-1); C61, C62, C63 STILL-OPEN, minor |
| New defects found by the 28-contract sample and the plan checks | 5 majors, all FIXED-NOW (F-1 to F-5), plus 2 plan clarifications (P-1, P-2) |
| Contracts traced end to end | 28 (section 5): 22 agree, 5 disagreed or had no producer and were fixed (F-1 to F-5), 1 is partial and covered by an accepted minor (A-13) |
| Go / no-go for Phase 2 | GO with the precautions of section 8 |

## 2. Edits made by this verification (each is the smallest edit that removes the contradiction)

| Id | Severity | Finding | Edit |
|---|---|---|---|
| F-1 | major (Phase 2: WP-07 builds `exec.ts`, WP-37 needs V6) | registry C60: 02 3.7 V6 and X-3 spawn the installed hook command with the probe payload on stdin; 06 3.6 `ChildSpec` had no stdin and `stdio[0]` was `'ignore'`; the plan said "file a CR, V6 stays unbuilt" | 06 3.6: `ChildSpec.stdin?: string` (kind `node` only, at most 4096 bytes, written once then closed, never logged), rule 1 (stdin `'pipe'` only when defined, EPIPE ignored), rule 8 (the one stdin user; for `hooks verify` V4/V6 the `file` is the installed entry's `command` after V1-V3), test row in 3.11; ADR 0051 bullet; 05 S-PROC-2; 02 3.7 wording; registry rows (`ChildSpec`, `hooks verify`, C60 RESOLVED, section 17 now five rows); plan WP-07 and WP-37 text |
| F-2 | major (plan gap; WP-17 cannot fill `InstanceInfo.commands`) | `formatCommand` (`engine/src/ops/commands.ts`, 01 6.6, registry 2.1) is in no slice of 01 and no WP of the plan | plan: WP-17 Creates, Produces, Inputs and Tests; plan section 10 row D-17 |
| F-3 | major (plan gap; T-HK-15 cannot pass) | `claudeArgsWithoutHooks` (`engine/src/external/launch-claude.ts`, 02 2.9, T-HK-15, registry 2.4) is in no slice of 02 and no WP | plan: WP-25 Creates, Blocks (`engine/src/index.ts`, register row 4.2), Produces, Tests, Gate; D-17 |
| F-4 | major (WP-17 gate DA-T-API-3 unsatisfiable without weakening a test) | 03 5.2 lists `alert_not_found` (no route raises it) and `csrf_rejected` (reserved, no mutating route), while DA-T-API-3 and 03 13 item 6 require every `ErrorCode` to be listed by a route and produced by a test | 03 5.2: "Reserved codes" paragraph (`query_too_short` is listed by every route with a `q` filter); DA-T-API-3 row and 13 item 6 exempt exactly the two reserved codes (`csrf_rejected` is produced by 05 SEC-05, `alert_not_found` by an error-mapper unit test); registry rows `alert_not_found`, `csrf_rejected`, note N11 RESOLVED |
| F-5 | major (WP-23 gate and every later phase gate red) | 01 2.10 `env-vars.test.ts` fails when a documented name is never read; WP-23 creates it in wave W2.4 while most readers arrive later, and `MCS_E2E_CLAUDE` has no reader in any WP | 01 2.10 and plan WP-23: names whose `readers` files do not exist yet are printed `pending` and do not fail; the Phase 6 gate requires zero `pending` (plan section 9.2); WP-39 now creates `packages/engine/test/real-provider.int.test.ts` (02 9.3, `describe.skipIf(MCS_E2E_CLAUDE !== '1')`) as the reader; plan row D-18 |
| P-1 | clarification | WP-02 Tests list `derived-defaults.test.ts`, but the behavioural cases need `resolveConfig` (WP-12) | plan WP-02: data part here, behavioural cases in WP-12 |
| P-2 | clarification | plan section 10 numbering | rows D-17 and D-18 appended in order |

Files changed: `01-instances-config-ops.md` (1 sentence), `02-ingestion-lifecycle.md` (1 sentence), `03-data-api-realtime.md` (3 places),
`05-tooling-testing-security.md` (S-PROC-2), `06-panels-parity-platform.md` (3.6 and 3.11), `90-implementation-plan.md`, `98-contract-registry.md`,
`docs/decisions/0051-child-process-kinds-semaphore.md`. `99-requirements-matrix.md` and `00-foundations.md` were not edited (lead-owned).

## 3. Table A: the 29 open issues of the residual list

Legend: C = CLOSED, O = STILL-OPEN. "Read" lists the sections of the documents involved that were read on both sides.

| Id | Sev | Status | Read | Result |
|---|---|---|---|---|
| N-01 | major | C | 01 4.4a (component 4, tests, open item), 06 3.2, 3.4, 3.10.3 step 7, 3.10.7, OI-14/15, 02 4.3, 4.10, 5.4, 03 3.6, 9.1, ADR 0059, registry 2.2, 2.8 | writer passed to `createPanelService`, 2 s serialized timer, one `withWriteTx` then `writer.submit` after COMMIT, no "same transaction" wording left, `endedAt` present |
| N-02 | major | C | 05 3.2, A.28 (withdrawn), A.37, 4.5; 01 2.10; 04 4.2, 11.4, W14; plan WP-01 | smoke drives `$MCS init/start/stop` on 18800-18849 and prints SKIPPED (exit 77) until 01 S8/S9; no `webServer`, no `MCS_E2E_PORT` |
| N-03 | major | C | 01 1.6 section table and S1; 02 1.2; 03 3.8, 8.3, 10.1; 06 3.5; registry 6.2 | 01 S1 writes every section module; owners' tables stay normative; slice lists agree |
| N-11 | major | C | 02 1.1, 3 intro, 9.5, 13 I-9; 01 6.3; ADR 0014; registry 2.4; plan WP-37/38 | installer in `engine/src/hooks/installer`, CLI renders only, `hooks status` and `--sync-tool-events` in 01, name `planHooks`; the sub-dependency "V6 needs stdin" was FIXED-NOW (F-1) |
| I-08 | major | C | 02 7.13; 03 6.1, 6.3, 12.1, 12.2; 01 6.1, 6.4; ADR 0026 | no null path, `CompletionTargetError` mapping, nullable `sessionId`, `resolvedBy`, `candidates`, `attemptPart` 0..512 everywhere (accepted minor A-15) |
| I-15 | major | C | 01 4.4a; 02 4.10; 03 11.4, 12.1; 06 3.2, 5.4; plan WP-16/35 | owners' factory shapes adopted: `{writer}`, `tickNow`, `untilIdle({timeoutMs})` rejection mapped to `idle:false`, `createDbScheduler`, six query deps, `ctx.instanceDir`, `context.ts` (wording point C61 stays) |
| I-02 | minor | C | 04 11.4 step 13; 02 2.7; 03 3.5; 01 1.1; ADR 0001, 0012 | `hooks-<YYYYMMDD>T<HH>Z.ndjson`, newest by `SPOOL_SEGMENT_RE` |
| I-05 | minor | C | 01 5.1; 05 3.2, 3.3.4, C-1; 06 3.9.4, 7.1 item 2, T21; ADR 0007 | 22.22.0 everywhere; only foundations D7 keeps 22.12 (annotated, accepted A-21) |
| I-06 | minor | C | 01 4.2; ADR 0006; 06 3.6, 4.2; ADR 0051 | `forceKill` = `taskkill.exe /PID /F` via kind `taskkill` (exit 128 = gone), kind `opener`, no `ExecutableName`, `listRuntimeProcesses` in `markers.ts` |
| I-12 | minor | C | 06 7.1 item 6, closing note; 01 5.4 | `$MCS stop` then `db rebuild --yes --confirm` then `$MCS start`; OI-7 closed |
| I-18 | minor | C | 06 3.10.7; 02 4.3; ADR 0059 | `endedAt: row.ended_at`, `observedAt = publishAt` |
| I-19 | minor | C | 03 6.3, 12.1, 12.2; 01 7.1 | async `AuditReader`, `getSession` returns `auditRefs: []`, handler and DbReader await `sessionAuditRefs` |
| I-21 | minor | C | 03 6.2, A-6, O-4; 06 3.6, 8.2; 01 4.2 | `ChildKindStats` only |
| I-22 | minor | O | 05 4.2, 04 11.3, 02 9.5, 01 2.8, 03 23, 06 OI-1 | 05 and 04 now use the owners' names; 06 OI-1 line 1777 still says `panels.contract.test.ts` (A-1) |
| I-26 | minor | C | 05 4.4, 5.3 S-FS, S3; 04 11.5; 02 2.3.2 | `DemoOptions` verbatim (`nowMs`, no `runtimeJson`); id regexes re-exported from `@mcs/shared/protocol` |
| I-27 | minor | C | 01 2.10; 05 A.28, 4.5; 04 11.4; registry 6.3, 14 | no `MCS_E2E_PORT`; Playwright ports from `allocatePort([18500, 18599])` |
| I-29 | minor | C | 02 2.7, 4.10, X-2; 01 4.3, 4.4a, 6.4, 7.2; ADR 0005, 0012 | op `ingest-replay {fromSegment}`, `planSpoolReplay` + `applySpoolReplay` or `IngestService.replay`, 01 7.2 template verbatim |
| I-32 | minor | C | 01 1.6, E14; 02 1.1, 1.2; 03 3.3 | no `import.maxLineBytes`; 9 `import` keys; constant `MAX_LINE_BYTES` |
| I-34 | minor | C | 05 2.6 table, A.9; 06 4 | `PLATFORM_ENTRY` rule, allow-list block and logger block present |
| I-36 | minor | C | 05 1.2, S2; 01 4.4a, S1 | `Clock` only in `shared/src/time.ts`; testkit `clock.ts` holds `FakeClock` |
| N-04 | minor | C | 01 1.6 (tables, derivation, tests), 2.4, open item 6; 02 1.2, 2.6.2 | every bound in 01 equals 02; `spoolWhileStoppedHours` 0..720; behaviour change recorded (accepted A-24) |
| N-05 | minor | C | 06 5.7 R25, 5.8 D3; 05 4.11.5 PD3; 01 2.7, 6.5; 03 6.2; ADR 0055 | flat configs N/A in Node, no `configWarnings` anywhere |
| N-06 | minor | C | 06 3.10.1, 4.1; 01 2.4, 6.2 | `McsError('CONFIG_INVALID', ...)`; the two `E_*` codes are gone |
| N-07 | minor | C | 05 1.1, 2.2, 4.8, S9, A.21; 01 3.5, S2/S3; 06 5.3; plan WP-05/20/73 | `_setup.ts` only; golden tests under `runtime/tests/parity`; `./legacy` export |
| N-08 | minor | C | 03 9.1, 3.5; 02 4.6; 01 6.1 | `event` maps to `event/append`; `ErrorItem[]` |
| N-09 | minor | C | 03 6.2; 04 5.2; registry C26 | `transcriptMs` = `events_ms`, `overviewMs` = `overview_ms`, `healthMs` = 5000; 04 polls git/ledger/chainLog with `overviewMs` |
| N-10 | minor | C | 06 3.10.2, 3.10.8; 03 3.5, 3.6; registry 2.6 | pointer to 03, row ids mapped through `SessionsRepo.uidsByRowIds` (03 names it; 06 says "by-id lookup", A-19), `idx_attempt_runs_start` |
| N-12 | minor | O | 02 7.12, 9.2, 9.5; 05 4.2, 7.4; 01 4.16; 99 rows | designs use `T-LF-01..57`; `99` rows R-2.B.2, R-6.1, R-6.S.1, R-6.R.7, R-6.T.1, R-7.E.3, R-8.6.1, R-8.6.2, R-8.9.9 still cite `T-LC-*` (A-2) |
| N-13 | minor | C | the 23 member rows C14, C18-C20, C22, C24, C29, C30, C32, C33, C36, C39, C45, C47-C53, C55, C56, C58 | every member row is CLOSED in table B |

## 4. Table B: the 59 conflicts (and the registry's second-pass rows)

| Id | Status | Sections read on both sides |
|---|---|---|
| C01 | C | 01 1.6, 02 1.1/1.2, 03 3.3 |
| C02 | C | 02 1.2 (normative), 01 1.6 (identical bounds) |
| C03 | C | 01 4.3, 02 2.7/4.10/X-2, ADR 0005, 0012 |
| C04 | C | 02 2.7, 01 4.4a/6.4 |
| C05 | C | 01 7.2, 02 2.7 step 5 |
| C06 | C | 01 4.4a, 02 4.10, 06 5.4 |
| C07 | C | 01 4.4a, 02 4.10 |
| C08 | C | 01 4.4a, 03 11.4 |
| C09 | C | 03 12.1, 01 4.4a |
| C10 | C | 03 6.2/A-6/O-4, 06 3.6, 01 4.2 |
| C11 | C | 06 3.6, ADR 0051, 01 4.2/6.5, 05 S-PROC-2 |
| C12 | C | 01 4.2, ADR 0006, 06 4.2 |
| C13 | C | 06 3.2/4.2/4.11, ADR 0051, 01 4.2/S4 |
| C14 | C | 01 1.2, 06 4.3 |
| C15 | C | 01 4.4a, 06 3.2/5.4 |
| C16 | C | 02 7.13, 03 6.1/6.3/12, 01 6.1/6.4 |
| C17 | C | 02 7.13, 03 6.1, ADR 0026, 01 6.4 |
| C18 | C | 02 7.1, 03 5.5, 06 3.10.7 |
| C19 | C | 01 6.2, 03 5.2 |
| C20 | C | 03 4.4 |
| C21 | C | 01 6.1, 03 12.2 |
| C22 | C | 01 6.4, 02 3.1 |
| C23 | C | 01 6.3, 02 1.1/3/9.5/13, ADR 0014, 05 1.2 |
| C24 | C | 02 5.2, 01 2.8 |
| C25 | C | 04 11.4 |
| C26 | C | 03 6.2, 04 5.2 |
| C27 | C | 05 1.2/S2, 01 4.4a |
| C28 | C | 05 3.2/3.3.4/A.31, 06 3.9.4/7.1/T21, 01 5.1 |
| C29 | C | 05 3.3.4, 01 5.1, ADR 0047 |
| C30 | C | 05 3.3.1, 01 5.3 |
| C31 | C (superseded by N-02/I-27) | 05 A.28/4.5, 04 11.4, 01 2.10 |
| C32 | C | 05 4.4/A.40, 01 3.5, 04 11.3/11.4, 02 9.4 |
| C33 | C | 05 4.4, 01 3.5 (mechanism of `makeJunction` is C62) |
| C34 | C | 05 4.4, 04 11.5 |
| C35 | C | 05 5.3, 02 2.3.2 |
| C36 | C | 05 4.11.3, 06 6.2, 02 7.1, 03 5.5 |
| C37 | O (minor) | designs agree (02 7.12/9.2/9.5, 05 4.2/7.4); `99` rows still cite `T-LC-*` (A-2) |
| C38 | O (minor) | 05 4.2, 04 11.3 agree; 06 OI-1 still names `panels.contract.test.ts` (A-1) |
| C39 | C | 01 1.1/6.4, 03 11.1, 06 7.1 |
| C40 | C | 06 3.10.2/3.10.8, 03 3.5/3.6/9.1 |
| C41 | C | 06 3.10.7, 02 4.3 |
| C42 | C | 06 3.10.1/4.1, 01 2.4 |
| C43 | C (superseded by N-05) | 06 5.8 D3, 05 4.11.5 PD3, 03 6.2 |
| C44 | C | 06 7.1, 01 5.4 |
| C45 | C | 05 3.1, 01 2.9, 03 13 item 4 |
| C46 | C | 05 2.2, A.21 |
| C47 | C | 06 3.11, 4.11, 05 4.1 |
| C48 | C | 02 3.5, 01 4.2, ADR 0014 |
| C49 | C | ADR 0012, 0014, 0016 |
| C50 | C | ADR 0033, 03 6.2 |
| C51 | C | 03 6.2, 04 13 |
| C52 | C | 03 5.5 |
| C53 | C | 03 3.6, 4.5, 06 3.10.3 |
| C54 | C | 05 3.2, A.37, 01 4.11 |
| C55 | C | 05 S-SEC-4, 01 6.3 |
| C56 | C | 02 4.1, 7.2, 03 3.5 |
| C57 | C | 01 4.4a, 06 3.2/3.4, 02 4.3/5.4, ADR 0059 |
| C58 | C | 04 4.2, 11.4, 05 A.28 |
| C59 | C | 03 9.1, 3.5, 02 4.6 |
| C60 | FIXED-NOW | F-1 |
| C61 | O (minor) | 03 12.1 and A-4 say `createInstanceRuntime` builds `ctx.queries`; 01 4.4a: `buildInstanceContext` (A-3) |
| C62 | O (minor) | 01 3.5 says `cmd /c mklink /J`; 05 4.4 says `fs.symlinkSync(target, link, 'junction')` (A-4) |
| C63 | O (minor) | 05 4.8 inline example list versus 01 3.5 table (A-5) |

## 5. Sample of 28 cross-document contracts, end to end

Producer doc, consumer doc, code path (work package), test, verdict. All were read in both documents.

| # | Contract | Producer | Consumer | Code path (WP) | Test | Verdict |
|---|---|---|---|---|---|---|
| 1 | `state.json` fields (`engine`, `port`, `instanceId`) | 01 1.7 | 02 2.2 step 12 (handler nudge) | `sh/files/state.ts` (WP-02), `cl/hook/nudge.ts` (WP-25) | T-HK-06, T-LC-01 | agree (the handler parses by hand; the registry consumer cell is loose, A-20) |
| 2 | `HookRouteV1` route file | 02 2.6.2 | 01 4.4a c6, 6.3 `hooks enable`, set-engine, repair | `sh/protocol/routes.ts` (WP-04), `ingest/routes-file.ts` (WP-32) | T-HK-05, T-ISO-08 | agree |
| 3 | spool segment name and extension | 02 2.3.1, 2.7 | 03 3.5 CHECK, 01 1.1, 04 11.4, 05 1.2 | `sh/protocol/hook-envelope.ts` (WP-04) | T-HK-16, T-PL-12 | agree |
| 4 | control op `ingest-replay` | 01 4.3 | 02 2.7/4.10, ADR 0005/0012 | WP-02, WP-18, WP-32, WP-35, WP-38 | T-CLI-11, T-PL-11 | agree |
| 5 | `explainCompletion` chain | 02 7.13 | 03 6.1/6.3/12, 01 6.4 | WP-29, WP-61 | CE-1..17, DA-T-API-15, T-CLI-08 | agree (error type A-15) |
| 6 | `HealthReport` | 03 6.2 | 01 4.10/6.4, 04 `useHealth`, 06 8.2 | WP-03, WP-17 | DA-T-API-16, T-CLI-09 | agree |
| 7 | `LegacyHealth` (13 keys) | 03 6.2 | 01 C-4, legacy `cli.py` | WP-03, WP-17 | T-XE-03 | agree |
| 8 | SSE `hello`/`heartbeat`/`reset` | 03 9.2 | 04 5.6 | WP-03, WP-36, WP-47 | DA-T-RT-2/3/8, `stream-reconnect.int` | agree |
| 9 | `InstanceInfo.commands` | 03 6.2 | 01 6.6 (`formatCommand`) | `ops/commands.ts` (WP-17) | `commands.test.ts` | had no producer, FIXED-NOW (F-2) |
| 10 | `IngestHealth` to alert rules | 02 8.2, 8.3 | 03 10.1 | WP-35, WP-59 | T-HE-01..07, DA-T-AL-1..5 | agree |
| 11 | `LifecycleView` and `sessions` columns | 02 7.1 | 03 3.5, 3.6 | WP-28, WP-11 | T-LF-*, DA-T-DB | agree |
| 12 | `TokenUsage` and `UsageAggregate` | 02 6.3 | 03 5.5, 04 | WP-27, WP-30 | worked example, DA-T-A-1 | agree |
| 13 | `IngestWriter.submit` external batch | 02 4.6 | 06 3.10.7, 03 3.6 | WP-32, WP-40 | `attempts-evidence.test` | agree |
| 14 | `AttemptsPanel` | 06 3.3 | 04 panels, 03 route `panel` | WP-03, WP-41, WP-65 | `panels.test`, `panels.contract.int` | agree |
| 15 | `ConfigInspection` | 01 6.4 | 03 route `config`, 04 4.4.7 | WP-02, WP-17, WP-67 | `config-inspection.test` | agree |
| 16 | Host/Origin/CSRF guards | 05 S-NET | 03 5.2, 01 4.1 | WP-08, WP-17 | SEC-02..05, DA-T-API-4 | agree |
| 17 | DB open exit codes | 03 3.2, 4.5 | 01 4.1, 6.2 | WP-09, WP-18 | DA-T-DB-3, T-LC-03 | agree |
| 18 | `ChildSpec` / `execFileText` with stdin | 06 3.6 | 02 3.7 V6, 01 4.2, 05 S-PROC | WP-07, WP-37 | `exec.test`, T-IN-08 | disagreed, FIXED-NOW (F-1) |
| 19 | CLI `usage --by`, `sessions show`, `export` flags | 01 6.3, 6.4 | 03 8.2, 11.1, 12.2 (`InstanceReader`, `ExportQuery`) | WP-61 | T-CLI-05/13, DA-T-CLI-1 | values `day`, `tool`, agent tree, `--events`, `--include-text`, `--format` have no reader or query counterpart; accepted minor A-13 |
| 20 | `backupDb` | 03 4.4 | 01 5.5 | WP-09, WP-62 | DA-T-E-3, T-UP-08 | agree (01 uses shorthand, A-14) |
| 21 | `applyRetention` | 03 3.8 | 01 6.4 `cleanup --scope data` | WP-60, WP-62 | DA-T-E-4, T-CLI-06 | agree (shorthand, A-14) |
| 22 | `mutexName` kinds and keys | 01 4.2 | 02 3.5, ADR 0014, launcher copy 01 5.1 | WP-07, WP-21, WP-37 | `launcher-parity.test`, T-IN-05 | agree |
| 23 | stamp API `staleness`, `computeStamps` | 05 3.3 | 01 5.1/5.3, ADR 0047 | WP-01, WP-21 | `build-stamp.test`, T-UP-01..04 | agree |
| 24 | `DemoOptions` / `buildDemo` | 04 11.5 | 05 4.4 | WP-06, WP-56 | testkit demo tests, E2E | agree |
| 25 | `DOCUMENTED_ENV_VARS` and its readers | 01 2.10 | 05 3.1, plan WP-02/WP-23 | WP-02, WP-23 | `env-vars.test` | gate unsatisfiable in W2.4 and `MCS_E2E_CLAUDE` unread, FIXED-NOW (F-5) |
| 26 | `ErrorCode` catalogue and its meta-test | 03 5.2 | 03 DA-T-API-3, 13 item 6, 05 SEC-05 | WP-03, WP-17 | DA-T-API-3 | disagreed (reserved codes), FIXED-NOW (F-4) |
| 27 | `RUNTIME_VERSION` and `HANDLER_VERSION` | 01 5.2 | 02 2.1, 05 `set-version.mjs` | WP-01, WP-02, WP-04 | `version.test`, T-HK-14 | agree; `set-version.mjs` rewrites manifests only (A-17) |
| 28 | `claudeArgsWithoutHooks` | 02 2.9 | 02 T-HK-15, 05 S-PROC-3 | `external/launch-claude.ts` (WP-25) | T-HK-15 | had no producer, FIXED-NOW (F-3) |

## 6. Checks of the implementation plan

| Check | Result |
|---|---|
| Work packages | 79 WP blocks (24, 19, 13, 12, 11 per phase) plus lead steps LS-0, LS-6a, LS-6b; every WP block has Goal, Inputs, Creates, Blocks, Depends, Tests, Gate, Verifier; all 29 L work packages name a cut line |
| Dependencies acyclic | yes (master table parsed; the `Depends` line of every block equals its table row; the only wave-order note is WP-45's documented soft edge to WP-44) |
| Critical path | the 17-node chain of plan section 7 is reproduced exactly by a longest-path computation |
| File ownership | 860 created paths (after the edits of section 2); the only paths with two creators are stub files that WP-01 seeds and a later work package in a later wave replaces (`cli/src/hook.ts` WP-25, `cli/src/main.ts` WP-15, `web/src/main.tsx`, `vite.config.ts`, `vitest.config.ts` WP-44, the testkit `./legacy` export WP-42); no two work packages of one wave create the same file |
| Shared-file protocol | all 26 shared files of section 4.2 have a creator; the owner list of every register row equals the union of the `Blocks` lines of the WPs (both directions); the new owner WP-25 was added to the engine barrel row |
| Layout | every Creates path is under `packages/<pkg>/{src,test,e2e,public,migrations}`, `tests/`, `scripts/`, `bench/` or a skill path; the testkit `legacy/` folder and `web/scripts/` match 06 PP3 and 04 12.4 |
| Design coverage | every file named in a slice table of 01-06 is created by some WP (relative paths matched by suffix); the only uncovered names were `formatCommand` and `claudeArgsWithoutHooks` (F-2, F-3); every route module of 98 section 2.9 has a creator |
| Producer before consumer | the Produces/Consumes lines show no consumer whose ancestry lacks the producer; 28 contracts traced (section 5); one missing edge: WP-62 edits a block in a file WP-20 creates but does not depend on WP-20 (guaranteed by phase order, A-23) |
| Gate commands | every `npm run <x>` named in the plan is a script of 05 3.1 / registry 13; every `scripts/*.mjs` is a file of 05 2.1/3.2 or a generated one (`gen-schemas`, `parity-shadow`); vitest projects used by the macros exist (security added by WP-72); `ci.mjs --strict` and exit 77 exist (05 A.35, A.36); gate test paths exist or are created by the WP itself or an ancestor (WP-62 / WP-20 aside) |
| Phase gates | Phase 6 gate now also requires `env-vars` to print zero `pending` (F-5) |
| Size labels | WP-44 is labelled M but creates about 24 source files; WP-38 and WP-52 create 9 (A-23) |

## 7. Remaining blockers and majors

None. Every major found (F-1 to F-5) was fixed in the documents; their effect on the plan is in plan section 10 rows D-17 and D-18.

### 7.1 Accepted minors and the rule an implementer must follow

Where a rule below names two documents, the registry rule "registry wins" (98 0.1) decides unless the row says otherwise.

| Id | Minor | Rule |
|---|---|---|
| A-1 | I-22 / C38: 06 OI-1 names `panels.contract.test.ts` | The file is `packages/server/test/panels.contract.int.test.ts` (plan WP-56) |
| A-2 | N-12 / C37: `99` rows R-2.B.2, R-6.1, R-6.S.1, R-6.R.7, R-6.T.1, R-7.E.3, R-8.6.1, R-8.6.2, R-8.9.9 cite `T-LC-*` for the lifecycle model | Read `T-LF-*` there; `T-LC-01..16` are 01's process-lifecycle tests only; `99` is not an input of any gate and `docs/traceability.md` (WP-78) is built from the real tests |
| A-3 | C61: 03 12.1 and A-4 say `createInstanceRuntime` builds `ctx.queries` | `buildInstanceContext` (01 4.4a, `runtime/context.ts`: WP-16 stub, WP-17 block with the six deps) builds `ctx.queries`; `createInstanceRuntime(ctx)` receives the finished context |
| A-4 | C62: `makeJunction` mechanism (01 3.5, 05 SEC-14 text mention `mklink /J`) | `fs.symlinkSync(target, link, 'junction')` (05 4.4); no shell spawn anywhere, tests included |
| A-5 | C63: 05 4.8 inline example list of T-ISO owners | the 01 3.5 table wins; the plan already follows it |
| A-6 | registry notes N1 (`InstanceRow`), N4 (`AlertRuleView`), N6 (`WorkspaceRef`), N7 (`McsError` signature) | the owning WP declares the type minimally (N1: `slug engine state url pid version outdated`; N4: rule id, enabled flag, effective parameters of 03 10.1; N6: the handle `resolveWorkspace` returns; N7: `McsError extends Error {code: CliErrorCode; hint?; details?}` matching `CliError`) and adds the row to the registry in the same commit |
| A-7 | N3: nobody sets `NODE_ENV` for the detached server | do not set it; response validation stays on in every environment except `NODE_ENV === 'production'`; WP-17 records the decision in a CR and measures the DA-T-API timings with validation on |
| A-8 | N5: 01 S1 lists a `logging.ts` section module | create no section module that is not in `R_TOP_KEYS`; `logLevel` is a top-level key |
| A-9 | N10: `SUPPORTED_DB_SCHEMA` (01 2.6, 5.8) | use `migrationStatus().latest` of 03 |
| A-10 | N12 / N13 / N14 / N15: duplicate `T1..` ids inside 06, loose port wording, `ops.version` home, `ci` flags | 06 keeps both series (they never meet); 05 4.5 is the port authority; `ops.version` is in `ops/workspace.ts` (WP-14); `--strict` and `--full` of A.35 apply |
| A-13 | CLI data commands outrun the readers: `usage --by day\|tool`, `sessions show --events N --include-text` and the agent tree, `export --format --since --until` against `InstanceReader.usage/session` and `ExportQuery` | WP-61 maps `--since/--until` to `from/to`, accepts `--format ndjson` only, offers `usage --by` values that `UsageQuery.groupBy` supports and prints for `sessions show` the fields of `SessionDetail`; any wider output needs a CR that extends 01 6.1 and 03 12.2 first |
| A-14 | 01 6.4 and 5.5 write `backupDb(srcPath, dest)` and `applyRetention(db, policy, {dryRun})` | 03's signatures win (4.4: `{path, expectedInstanceId}` as source; 3.8: `(db, ctx, policy, {dryRun, now, signal?})`) |
| A-15 | error type of `InstanceReader.explainCompletion` (01 6.1 and registry: `McsError`; 03 12.2: `CompletionTargetError`) | `reader/*` converts to `McsError` `USAGE` / `NOT_FOUND` (registry wins) so both modes reject identically; DA-T-CLI-1 compares the code |
| A-16 | 05 text names slice S8 for the `security` project | WP-72 (05 S7) adds it, as the plan says |
| A-17 | `set-version.mjs` rewrites manifests only | a version bump also edits `shared/src/version.ts` and `HANDLER_VERSION`; the equality tests fail until it is done |
| A-18 | 01 2.10 places `env-vars.test.ts` in `runtime/tooling/` (project unit) | 05 and the plan win: `runtime/tests/tooling/env-vars.test.ts`, project `tooling` |
| A-19 | 06 3.10.2 does not name the by-id lookup | use `SessionsRepo.uidsByRowIds` (03 3.6) |
| A-20 | registry lists `StateFileSchema` as consumed by the hook handler | the handler parses `state.json` by hand and never imports zod or `@mcs/shared` outside `protocol` |
| A-21 | foundations D3 (`*.jsonl`) and D7 (22.12) are stale | the designs win (`*.ndjson`, 22.22.0); the lead annotates `00-foundations.md` |
| A-22 | `99` status and notes columns are partly historical (R-4.CFG.2, R-3.B.1, R-14.E.1-14) | design and registry text win |
| A-23 | plan: WP-44 is labelled M; WP-62 lacks a dependency edge on WP-20 | treat WP-44 as L with the cut line "styles and app shell" versus "components"; start WP-62 only after WP-20 is committed |
| A-24 | N-04 behaviour change: a legacy `config.json` with a fractional `window_hours` or `limits.event_window_mb` below 1 starts under the legacy engine but is refused by Node | WP-12 implements the exact 01 1.6 messages; WP-77 lists it under known limitations in `docs/migration.md`; the lead checks the owner's live task config against these bounds before any G2 shadow run |
| A-25 | plan WP-05 opt-in regex check reads a real `config.json` through `MCS_GOLDEN_LIVE_CONFIG` | only the lead sets it; an agent never points it at a real task workspace (plan section 12 rule 3) |

## 8. Go / no-go

GO for Phase 2 with these precautions for the lead and the implementers:

1. Build and self-test LS-0 first; no work package starts before its dependencies are verified. WP-03 is verified by an opus xhigh verifier before anything consumes it.
2. Authority order is 98 section 0.1. Before writing a name, read its registry row; for the five OPEN rows of 98 section 17 (C37, C38, C61, C62, C63) apply the rules A-1 to A-5 above.
3. WP-02 writes `DOCUMENTED_ENV_VARS` with a `readers` list (file paths) for every name, because the staged `env-vars.test.ts` (F-5) depends on it.
4. WP-07 implements `ChildSpec.stdin` and the `taskkill` `forceKill` (F-1, C12); WP-17 builds `formatCommand` (F-2) and the reserved-code exemption (F-4); WP-25 builds `launch-claude.ts` (F-3); WP-39 builds the gated real-provider test (F-5).
5. `0001_initial.sql` is frozen after WP-09's commit (checksum in 03 X14); editing it later is stop-the-line.
6. Never touch the live V9 monitor, its workspace, real hook settings or `~/.claude`; every CLI call passes `--repo` and `--port`; the hook installer runs only against a temp `--settings-file`.
7. Items still UNVERIFIED in the designs (POSIX control channel, cold-cache scan, `node:sqlite` fallback, `backup()` typings, typed-lint probes, render cost of a 2,000-row transcript, constrained PowerShell) stay labelled UNVERIFIED in reports until their named WP measures them; this verification adds no measurement.
8. Each WP final answer states the exact gate commands and results; a gate that was not run is reported as NOT RUN.
