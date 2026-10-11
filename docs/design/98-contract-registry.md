# 98 Contract registry: every name that crosses a package or document boundary

Status: Phase 1 reconciliation artefact, written 2026-10-11 by the contract registrar from `00-foundations.md`, designs `01`-`06`
(revision 2 texts), ADRs `0001`-`0059` and `99-requirements-matrix.md`. Authoritative index for Phase 2+ implementers: when a design
document and this registry disagree, the registry names the owner and the conflict (section 15) names the exact fix. The registry never
repeats long definitions: it points to the section that holds them.

## 0. How to read this registry

### 0.1 Authority order (applied to every name below)

| Kind of name | Authoritative design |
|---|---|
| API routes, response/request schemas, DB tables/columns/indexes/migrations, SSE frames, HTTP error codes | 03 |
| Hook envelope, spool, ingestion events, lifecycle states/facts/rules, token rules, ingest error codes | 02 |
| Workspace files, config schemas and keys, env vars, CLI commands/flags/exit codes, process lifecycle, launcher, control channel, audit | 01 |
| Panels, platform helpers (`exec`, `process`, `fsx`, `paths`, `host`, `glob`, `pytime`, `watch-hint`), parity/golden capture | 06 |
| Tooling, npm scripts, ports policy, testkit core, test layout, security primitives (`security/paths`, `logger`, `terminal`, `guards`) | 05 |
| UI-only names (routes, URL params, query keys, components, prefs) | 04 |

Where evidence overrides the order the conflict row says so. A name marked `[Cnn]` has a recorded conflict in section 15.

### 0.2 Abbreviations

| Short | Meaning |
|---|---|
| `sh/` | `runtime/packages/shared/src/` (`@mcs/shared`; `sh/protocol/**` = `@mcs/shared/protocol`, zod-free) |
| `en/` | `runtime/packages/engine/src/` (`@mcs/engine`) |
| `sv/` | `runtime/packages/server/src/` (`@mcs/server`) |
| `cl/` | `runtime/packages/cli/src/` (`@mcs/cli`) |
| `wb/` | `runtime/packages/web/src/` (`@mcs/web`) |
| `tk/` | `runtime/packages/testkit/src/` (`@mcs/testkit`, dev only) |
| `rt/` | `<skill>/runtime/` |
| `<ws>` | instance workspace `<repo>/.claude/monitor/tasks/<slug>/` |
| `<skill>` | `<repo>/.claude/skills/monitoring-claude-sessions/` |
| `01 4.3` | design document number and section; `A0005` = ADR `docs/decisions/0005-*.md` |
| Consumers | design numbers that read or call the name (`all` = every design) |

Kinds: `type` (TS interface/alias), `schema` (zod), `const`, `fn`, `class`, `enum` (string-literal union), `file`, `dir`, `route`,
`frame`, `table`, `col`, `index`, `key` (config), `env`, `code` (error code), `cmd`, `flag`, `script`, `port`.

## 1. Shared contracts: zod schemas and TypeScript types (`@mcs/shared`)

Rule (03 5.5, 04 13): every API, stream, panel and CLI-result shape is a zod schema in `sh/**` with its TS type as `z.infer`; no
consumer redeclares one. `sh/protocol/**` holds zod-free types used by the hook handler.

### 1.1 API entities and enums (`sh/api/entities.ts`)

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `IsoTime` | type | 03 5.5 | 03 | `sh/api/time.ts` | 04, 06 | ISO-8601 UTC ms `Z`; 06 imports it from `./time.js` |
| `LIFECYCLE_STATES`, `LifecycleState` | const, enum | 03 5.5, 02 7.1 | 02 (values), 03 (export) | `sh/api/entities.ts` | 01, 04, 06 | 10 values, section 11.1 |
| `ACTIVE_STATES` | const | 03 5.5 | 03 | `sh/api/entities.ts` | 04, URL alias `state=active` | `running working waiting_tool waiting_agent` |
| `LegacyState` | enum | 03 5.5 | 03 | `sh/api/entities.ts` | 02 7.9, 04, 05, 06 | `RUNNING IDLE COMPLETED FAILED UNKNOWN`; redeclared in 05 and 06 [C36] |
| `BOARD_STATES`, `BoardState` | const, enum | 03 5.5 | 03 | `sh/api/entities.ts` | 02 7.11, 04 | `working waiting completed failed stale unknown` |
| `EVENT_KINDS`, `EventKind` | const, enum | 03 5.5, section 3.6 | 03 | `sh/api/entities.ts` | 02 4.1.2, 04 | 33 stored kinds, section 11.4 |
| `EVENT_CATEGORIES`, `EventCategory`, `CATEGORY_OF` | const, enum | 03 5.5 | 03 | `sh/api/entities.ts` | 04 (`types` URL filter) | 8 categories |
| `ToolStatus` | enum | 03 5.5 | 03 | `sh/api/entities.ts` | 04 | `pending succeeded failed denied interrupted unknown`, derived from `tool_calls.outcome` |
| `Completeness` | enum | 03 5.5 | 03 | same | 04 | `complete partial unavailable` |
| `TranscriptFileState` | enum | 03 5.5 | 03 | same | 04 | `active missing unreadable untracked retired` |
| `EvidenceItem` (API form) | type | 03 5.5 | 03 | same | 02 `toApiEvidence`, 04 | `{kind: '<source>:<fact>', at, text}`; name collides with 02's engine type [C18] |
| `StateAssessment` | type | 03 5.5 | 03 | same | 04 | projection of 02 `LifecycleView` + `legacyState` |
| `TokenUsage` | type | 03 5.5 | 03 (shape), 02 6.3 (rules) | same | 04, 06 `AttemptsPanel` | a field is `null` when every counted message misses it |
| `CostEstimate` | type | 03 5.5 | 03 | same | 04 | `basis: 'estimate'` |
| `SessionSummary` | type | 03 5.5 | 03 | same | 01 `InstanceReader`, 04 | `workItemIds` (UI URL key `task`) |
| `SessionDetail` | type | 03 5.5 | 03 | same | 01, 04 | `auditRefs` from 01 `entriesBetween` |
| `AgentNode` | type | 03 5.5 | 03 | same | 04 | `workflow` = `{runId, name, phase, state}` |
| `ActivityEvent` | type | 03 5.5 | 03 | same | 04, export | `id: number`, `transcriptRef {agentId, offset}` |
| `ToolCallItem` | type | 03 5.5 | 03 | same | 04, stream | |
| `TransitionItem` | type | 03 5.5 | 03 | same | 04, export | |
| `WorkItem` | type | 03 5.5 | 03 (shape), 02 7.11 (rules) | same | 04 | `source` spelling differs from DB `kind` [C52] |
| `AlertRuleKind`, `AlertItem` | enum, type | 03 5.5 | 03 | same | 04 | 8 rule kinds, section 7.10 |
| `WorkflowRunItem` | type | 03 9.2 | 03 | `sh/api/stream.ts` | 04 | data of `workflow/upsert` |

### 1.2 Pagination, errors, filters, route registry

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `Page<T>` | type | 03 5.3 | 03 | `sh/api/entities.ts` | 01 readers, 04 | `items, nextCursor, asOfSeq, total, totalIsLowerBound, limit` |
| `EventPage` | type | 03 6.1 | 03 | same | 04 | adds `scanCapped`, `newerCursor` |
| cursor | format | 03 5.3 | 03 | `sh/api/cursor.ts` | 04 (opaque) | base64url JSON `{v,r,s,d,k,i,w,f}`, <= 512 chars |
| `ErrorEnvelope` | type, schema | 03 5.2 | 03 | `sh/api/errors.ts` | 02 2.8, 04 5.1, 05 5.3 | `{error: {code, message, requestId, details?}}` |
| `ErrorCode` (HTTP catalogue) | enum | 03 5.2 | 03 | `sh/api/errors.ts` | 02, 04, 05 security suite | catalogue section 7.1; name clash with the 01 CLI union [C19] |
| `Preset` | enum | 03 5.4, 04 3.2 | 03 | `sh/api/filters.ts` | 04 `lib/url-state.ts` | `1h 6h 24h 7d 30d all` |
| `toQuery`, `fromQuery`, `matchesEventFilter` | fn | 03 5.4 | 03 | `sh/api/filters.ts` | 04 4.4.4, section 5.2 | round trip tested (DA-T-API-7) |
| `SessionListQuery`, `AgentListQuery`, `EventListQuery`, `ToolCallListQuery`, `ErrorsQuery`, `OverviewQuery`, `UsageQuery`, `SessionUsageQuery`, `SeriesQuery`, `ToolsQuery`, `TransitionListQuery`, `SessionAgentsQuery`, `WorkItemBoardQuery`, `AlertListQuery`, `TranscriptWindowQuery`, `TranscriptLocateQuery`, `TranscriptSearchQuery`, `InstanceSearchQuery` | type | 03 12.1 | 03 | `sh/api/filters.ts` (parsed outputs of the route zod schemas) | 01 CLI flags, 04 | 04 aliases `EventFilter`, `SessionFilter` |
| `defineRoute`, route registry `routes` | fn, const | 03 13 | 03 | `sh/api/routes.ts` | 01 `ApiReader`, 04 `data/endpoints.ts`, contract tests | `{id, method, path, params, query, body, response, successStatus, errors, summary, contentType}` |
| `registerRoute(app, route, handler)` | fn | 03 13 | 03 | `sv/route-adapter.ts` | 06 panels route | validates responses when `NODE_ENV !== 'production'` (no design sets `NODE_ENV`; open point section 15 note N3) |

### 1.3 Health, instance, meta

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `HealthReport` | type, schema | 03 6.2 | 03 | `sh/api/health.ts` (03 S3 file list) [C51] | 01 `status`, `verify`, diagnostics; 04; 06 8.2 | includes `runtime.{rssBytes, heapUsedBytes, cpuUserMicros, cpuSystemMicros}`, `children`, `panels` |
| `InstanceInfo` | type, schema | 03 6.2 | 03 | `sh/api/health.ts` [C51] | 04 | `poll`, `features`, `commands`, `limits`, `epoch`, `headSeq`; `poll` keys [C26] |
| `ErrorItem` | type | 03 6.1 | 03 | `sh/api/health.ts` | 01 `InstanceReader.errors` [C21], 04 | `{at, source, code, where, message, sessionId}` |
| `LegacyHealth`, `LegacyHealthSchema` | type, schema | 03 6.2, 01 C-4 | 03 | `sh/api/legacy-health.ts` | legacy `cli.py` readers | exactly 13 keys |
| `IngestHealth` | type | 02 8.2 | 02 | `en/health/ingest-health.ts`; schema `IngestHealthSchema` in `sh/schemas/ingest.ts` | 03 route `healthIngest`, 04 (projection) | four blocks + `reasons` |
| `HookProbeResult` | type | 03 6.1 | 03 | `sh/api/*` (route `ingestProbe`) | 02 3.7 V7 | `{receivedAt, committedAt}` |
| `ConfigInspection`, `ConfigInspectionEntry`, `ConfigFileStatus`, `ConfigSource` | type | 01 6.4 | 01 | `sh/cli/results.ts` | 03 route `config`, 04 4.4.7 | `source` in `builtin skill config runtime env cli`; `toConfigInspection(r, engine)` pure |

### 1.4 Transcript, search, analytics, alerts, completion, export

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `EntryKind`, `TranscriptEntry` | enum, type | 03 7.1 | 03 | `sh/api/entities.ts`; projection in `en/transcript/entries.ts` | 02 `readEntryText`, 04 | kinds `prompt say think tool result` |
| `TranscriptWindowResponse`, `TranscriptLocateResponse` | type | 03 7.3 | 03 | `sh/api/*` | 04 5.4 | `base` always 0 |
| `SearchCoverage`, `TranscriptSearchResponse`, `InstanceSearchResponse` | type | 03 7.4 | 03 | `sh/api/*` | 04 4.4.3 | `stoppedBy`: `complete match_limit time_budget cancelled` |
| `Metric`, `Overview` | type | 03 8.1 | 03 | `sh/api/*` | 04 4.4.1 | metric keys below |
| `UsageRow`, `UsageReport`, `SeriesPoint`, `UsageSeries`, `CostSummary` | type | 03 8.2-8.3 | 03 | `sh/api/*` | 01 `usage`, 04 | |
| `ToolFrequencyRow`, `ToolFrequencyReport` | type | 03 8.4 | 03 | `sh/api/*` | 04 | `failed`, `failurePct` |
| `WorkItemBoard` | type | 03 6.1, section 15.1 | 03 | `sh/api/routes.ts` (response of `workItemBoard`) | 04 4.4.5 | `{asOfSeq, derivation, items, truncated}` |
| `AlertRuleView`, `AlertRulesView` | type | 03 6.1, section 12.1 | 03 | `sh/api/*` | 04 | body of `alertRules`; element shape not spelled out in 03 (note N4) |
| `CompletionTarget` | type | 02 7.13 | 02 | `en/lifecycle/completion.ts` (used by `sh/api/completion.ts`) | 01 `verify-completion`, 03 | `{sessionId} \| {label} \| {attemptPart}` |
| `CompletionEvidence`, `CompletionEvidenceSchema` | type, schema | 02 7.13, 03 6.3 | 02 (fields), 03 (schema file) | `sh/api/completion.ts` | 01, 03 | field sets differ [C16] |
| `ExportQuery`, `ExportSummary`, export line types | type, schema | 03 11.1 | 03 | `sh/api/export.ts` | 01 `export` | format `mcs.export/1` |

Overview metric keys (03 8.1; 04 S-7): `sessions.active`, `sessions.waiting_input`, `sessions.turn_ended`, `sessions.completed`,
`sessions.failed`, `sessions.stale`, `sessions.unknown`, `agents.running`, `events.errors`, `tokens.input`, `tokens.input_new`,
`tokens.output`, `tokens.cache_creation`, `tokens.cache_read`, `cost.estimate`, `cost.reported`, `alerts.open`.

### 1.5 Stream (`sh/api/stream.ts`)

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `StreamHello` | type, schema | 03 9.2 | 03 | `sh/api/stream.ts` | 04 5.6 | `instanceId, epoch, headSeq, heartbeatMs, serverTime, runtimeVersion, codeStamp` |
| `StreamHeartbeat` | type, schema | 03 9.2 | 03 | same | 04 | `headSeq, epoch, serverTime` |
| `StreamReset` | type, schema | 03 9.2 | 03 | same | 04 | reasons `cursor_too_old cursor_ahead epoch_changed cursor_invalid` |
| `StreamChange` | type, schema | 03 9.2 | 03 | same | 04 5.5 | discriminated by `kind`/`op`, section 4 |
| `ChangeKind`, `ChangeOp` | enum | 03 9.1 | 03 | `en/db/changes.ts` (and the stream schema) | 02 `ChangeSink`, 04 | 11 kinds, 4 ops |

### 1.6 Panels (`sh/api/panels.ts`, owner 06 3.3)

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `PanelKey`, `PANEL_KEYS` | enum, const | 06 3.3 | 06 | `sh/api/panels.ts` | 03 route `panel`, 04 | `git machine attempts ledger chainLog logs` |
| `PANEL_CONFIG_KEY` | const | 06 3.3 | 06 | same | 03 (404 rule) | `chainLog -> chain_log` |
| `PanelSource`, `SourceStatus`, `PanelSourceState` | enum, type | 06 3.3 | 06 | same | 04 `toPanelViewStatus` | |
| `PanelStatus`, `PanelResponse<K>`, `PanelDataMap` | enum, type | 06 3.3 | 06 | same | 03, 04 | `ok partial error`; the UI type `PanelViewStatus` is separate (04 4.4.1) |
| `MachinePanel`, `GitPanel`, `LinesPanel`, `LogsPanel`, `AttemptsPanel`, `AttemptState` | type, enum | 06 3.3 | 06 | same | 03 (`AttemptState`), 04 | `AttemptState`: `COMPLETED FAILED RUNNING UNKNOWN` |
| `PanelResponseSchema`, `GitPanelSchema`, `MachinePanelSchema`, `AttemptsPanelSchema`, `LinesPanelSchema`, `LogsPanelSchema` | schema | 06 3.3 | 06 | same | 03 13 registry | discriminated union on `key` |
| `ChildKind` | enum | 06 3.6 | 06 | `sh/api/panels.ts` (re-exported by `en/platform/exec.ts`) | 01, 03 `HealthReport.children` | lacks `opener` [C11] |
| `ChildKindStats` | type | 06 3.6 | 06 | same | 03 (spells it `ChildStat`) [C10] | `{spawned, failed, timedOut, totalMs}` |
| `PanelStats`, `PanelSourceStats` | type | 06 3.4 | 06 | same | 03 `HealthReport.panels` | |

### 1.7 Protocol, zod-free (`@mcs/shared/protocol`)

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `HookEnvelopeV1`, `HOOK_ENVELOPE_VERSION` | type, const | 02 2.3.1 | 02 | `sh/protocol/hook-envelope.ts` | 03, 04 tests, 05 testkit, 06 | envelope field is `event` (no `hook_event_name`) |
| `EnvelopeKind` | enum | 02 2.3.1 | 02 | same | 03 (`hook_probes`) | `hook probe` |
| envelope flags | enum | 02 2.3.3 | 02 | same | 03 `events.flags` | `stdin_truncated`, `invalid_<field>`, `event_mismatch`, `minimal`, `redacted`, `routed_by_cwd`, `routed_by_session_pin`, `data_truncated:<field>` |
| `SPOOL_SEGMENT_EXT`, `SPOOL_SEGMENT_RE`, `spoolSegmentName(receivedAt)` | const, fn | 02 2.3.1, section 2.7 | 02 | same | 01 `audit`, `ingest replay`; 03 CHECK; 04 E2E [C25]; 06 | `.ndjson`; `/^hooks-(\d{8})T(\d{2})Z\.ndjson$/` |
| `SID_RE`, `AGENT_RE`, `TOOL_ID_RE`, `RUN_ID_RE` | const | 02 2.3.2 | 02 | same | 03 5.1 id rules, 05 S-FS [C35], 05 testkit | `RUN_ID_RE = /^wf_[A-Za-z0-9_-]{1,64}$/` |
| caps `HANDLER_HARD_EXIT_MS`, `STDIN_MAX_BYTES`, `ENVELOPE_MAX_BYTES`, `SPOOL_SEGMENT_SOFT_CAP`, `SPOOL_SEGMENT_HARD_CAP`, `NUDGE_TIMEOUT_MS`, `SUMMARY_MAX_CP`, `TITLE_MAX_CP`, `PATH_MAX_CHARS`, `ID_MAX_CHARS`, `NAME_MAX_CHARS`, `ROUTES_MAX_FILES`, `ROUTE_FILE_MAX_BYTES` | const | 02 2.3.1 | 02 | same | 03, 05 | values section 10.1 |
| `MAX_LINE_BYTES` | const | 02 1.1 (I-32) | 02 | `sh/protocol/limits.ts` | 02 tailer, 03 7, 06 attempts reader | 64 MiB; no config key [C01] |
| `HOOK_EVENT_POLICY`, `INSTALLED_HOOK_EVENTS`, `ASYNC_HOOK_EVENTS`, `HOOK_EVENT_RANK` | const | 02 2.4, section 3.3, section 4.3 | 02 | `sh/protocol/hook-events.ts` | 04 demo, 05 testkit `HookEventName`, A0013 | 21 events, 4 async; ranks section 11.5 |
| `HookRouteV1`, `matchRoutes(routes, ids, now)` | type, fn | 02 2.6.2 | 02 | `sh/protocol/routes.ts` | hook handler, 01 route rewrites | |
| `Stamp`, `compareStamp` | type, fn | 02 4.3 | 02 | `sh/protocol/stamp.ts` | 03 `turns.end_rank/end_tie` LWW | `{at, rank, tie}` |
| `clip`, `summarizeToolInput`, `redact`, `REDACTION_RULES`, `canonicalJsonHash`, `normalizePath`, `routeKey`, `pyJsonDumps` | fn, const | 02 2.5 | 02 | `sh/protocol/sanitize.ts` | 03 `AttemptsRepo` (`clip`), 06 | rules R1-R7; `routeKey` is the only platform branch outside `en/platform/**` (06 4) |
| `ControlRequest`, `ControlResponse`, `ControlPhase` | type | 01 4.3 | 01 | `sh/protocol/control.ts` | server, CLI, 02 (op name [C03]) | ops `identify shutdown backup ingest-replay`; phases `starting ready stopping` |
| `HANDLER_VERSION` | const | 02 2.1 | 02 | `sh/protocol/hook-envelope.ts` (implied by 02 1.1) | `hooks verify` V4 | equals `RUNTIME_VERSION` |

Zod mirrors (`sh/schemas/ingest.ts`, owner 02 4.2): `HookEnvelopeV1Schema`, `HookRouteV1Schema`, `TranscriptRecordShape` (loose),
`IngestHealthSchema`, `NudgeBodySchema` (strict `{instanceId}`).

### 1.8 Workspace files, config schemas, ids, time, CLI results (owner 01 unless noted)

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `InstanceFileSchema`, `InstanceFile` | schema, type | 01 1.5 | 01 | `sh/files/instance.ts` | 05 testkit `buildTaskWorkspace` | key order fixed |
| `StateFileSchema`, `StateFile`, `stateEngine` | schema, type, fn | 01 1.7 | 01 | `sh/files/state.ts` | 02 handler (nudge targets) | non-strict |
| `BackupManifestSchema` | schema | 01 5.5 | 01 | `sh/files/backup-manifest.ts` | 03 `backupDb` callers | `dbCopy`: `online raw none` |
| `KeySpec`, `SectionKeys`, `sectionSchema`, `sectionOverridesSchema` | type, fn | 01 1.6 | 01 | `sh/config/runtime/section.ts` | 02, 03, 06 section modules | `.prefault({})` rule (01 E12) |
| `<Name>SectionKeys`, `<Name>SectionSchema` for `Server Process Backup Lifecycle Hooks Ingest Import Spool Health Analytics Board PanelOptions Retention Alerts Pricing` | const, schema | 01 1.6 | 01 (pattern), section owner (values) | `sh/config/runtime/<name>.ts` | all | keys section 6.2; 01 S1 also lists a `logging.ts` module that `R_TOP_KEYS` does not need (note N5) |
| `RuntimeFileSchema`, `RuntimeOverridesSchema`, `RuntimeConfig` | schema, type | 01 1.6 | 01 | `sh/config/runtime/index.ts` | `resolveConfig` | |
| `R_TOP_KEYS`, `R_MERGED`, `R_KEY_CATALOGUE`, `R_DERIVED_DEFAULTS`, `DerivedDefault` | const, type | 01 1.6 | 01 | same | contract test `runtime-sections.contract.test.ts` | catalogue `owner: '01' \| '02' \| '03' \| '06'` |
| `LegacyConfigFileSchema` | predicate table | 01 2.4 | 01 | `en/config/validate-legacy.ts` | `check`, `configure`, server boot | legacy messages; not zod |
| `LegacyConfigZodMirror` | schema | 01 2.9 | 01 | `sh/config/*` | `config.v1.schema.json` only | |
| `L_MERGED`, `mergeLayer` | const, fn | 01 2.2 | 01 | `en/config/merge.ts` | | `panels ui poll limits` |
| `ResolveInput`, `ResolvedConfig`, `resolveConfig(i)` | type, fn | 01 2.3 | 01 | `en/config/resolve.ts` | 02, 03, 06 through `ctx.config` | |
| `FileMigration`, `FILE_MIGRATIONS` | type, const | 01 2.7 | 01 | `en/config/migrations.ts` | `config migrate` | empty in v1 |
| `DOCUMENTED_ENV_VARS` | const | 01 2.10 | 01 | `sh/env.ts` | 05 `tests/tooling/env-vars.test.ts` | section 6.3 |
| `RUNTIME_VERSION` | const | 01 5.2 | 01 | `sh/version.ts` | all | equals `rt/package.json` `version` (`3.0.0`) |
| `UUID_V4_RE`, `SLUG_RE`, `IsoSecondsZ`, `Semver` | const, schema | 01 1.5, section 3.1 | 01 | `sh/ids.ts` | | slug `^[a-z0-9][a-z0-9-]{0,47}$`, not a device name |
| `Clock`, `systemClock`, `isoSecondsZ`, `isoMsZ` | type, const, fn | 01 4.4a (I-36) | 01 | `sh/time.ts` | 02, 03, 05 `FakeClock`, 06 | 05 names `sh/clock.ts` [C27] |
| `LogLevel` | enum | 05 5.3 S-LOG-6, 01 1.6 | 05 | `en/log/logger.ts`; mirrored in `sh/config` | 01 | `error warn info debug` |
| `CliEnvelope<T>`, `CliError` | type | 01 6.2 | 01 | `sh/cli/envelope.ts` | 02 3.1 | `schema: 'mcs.cli/1'` |
| CLI error union | enum | 01 6.2 | 01 | `sh/errors.ts` | 02 (`HOOKS_FAILED`, `USAGE`, `NOT_FOUND`) | spelled `ErrorCode` in 01 [C19]; catalogue section 7.2 |
| `StatusReport`, `InstanceRow`, `DoctorCheck`, `DiagnosticsBundle` | type | 01 4.10, section 6.4 | 01 | `sh/cli/results.ts` | 06 runbook | `DiagnosticsBundle.hooks` type name [C22]; `InstanceRow` fields only in prose (`slug engine state url pid version outdated`) |
| `HooksApplyResult`, `HooksWarningCode`, `HooksVerifyResult`, `HooksStatusResult` | type, enum | 02 3.1 | 02 (shape), 01 (file) | `sh/cli/results.ts` | 01 diagnostics | warnings `HOOKS_SETTINGS_NOT_IGNORED HOOKS_USER_SCOPE HOOKS_LIVE_RELOAD` |
| `ProbeState`, `ProbeResult` | enum, type | 01 4.8 | 01 | `en/ops/probe.ts` | `StatusReport.probe` | states section 11.7 |

### 1.9 Python-regex translator (`sh/pyregex/`, owner 01 2.8)

| Name | Kind | Notes |
|---|---|---|
| `PyRegexContext` | enum | `session_rule attempts` |
| `PyRegexErrorCode`, `PyRegexError` | enum, type | `SYNTAX UNSUPPORTED_CONSTRUCT UNSUPPORTED_FLAG INEXACT_SEMANTICS JS_COMPILE` |
| `TranslatedPattern`, `translatePyRegex(source, ctx)` | type, fn | |
| `PyMatch`, `CompiledPyRegex`, `compilePyRegex(source, ctx)` | type, fn | throws `McsError REGEX_UNSUPPORTED`; consumers 02 5.2 [C24], 06 3.10.1 |
| `applyLabelTemplate(template, m)` | fn | `{n}` sequential, `{0}` first 40 code points |

## 2. Engine public functions, classes and interfaces (with signatures)

Signatures are copied from the owning section; when two documents disagree the owner's form is shown and the conflict is marked.

### 2.1 Workspace, PyJson, audit, ops (owner 01)

| Name | Kind | Signature | Defined in | Code path | Consumers |
|---|---|---|---|---|---|
| `writeWorkspaceFile` | fn | `(path: string, data: string \| Uint8Array, o?: { budgetMs?: number }) => Promise<void>` | 01 1.2 | `en/workspace/fsio.ts` | 06 (calls it `writeFileAtomic`) [C14] |
| `writePyJsonFile` | fn | `(path: string, value: PyJsonValue, o?: { budgetMs?: number }) => Promise<void>` | 01 1.2 | same | 06 4.3, A0003, A0058 |
| `readTextUniversal` | fn | `(path: string, maxBytes?: number /* 16 MiB */) => Promise<string>` | 01 1.2 | same | audit reader |
| `readJsonFile` | fn | `(path: string) => Promise<{ text: string; value: PyJsonValue }>` | 01 1.2 | same | |
| `compareAndDelete` | fn | `(path: string, expected: Uint8Array) => Promise<'deleted' \| 'changed' \| 'absent'>` | 01 1.2 | same | stop, shutdown |
| `assertNotLink` | fn | `(path: string) => void` | 01 1.2 | same | throws `WORKSPACE_SYMLINK` |
| `PyJsonValue`, `parsePyJson`, `dumpPyJson`, `toPlain`, `fromPlain`, `pyEquals`, `pyShort`, `pyRepr`, `pyFloatRepr` | type, fn | `parsePyJson(text) => PyJsonValue`; `dumpPyJson(v, {indent: 2} \| {compact: true, asciiOnly?})` | 01 1.9 | `en/pyjson/` | 06 vectors, parity |
| `slugify`, `resolveWorkspace(root, slug)` | fn | | 01 3.1-3.2 | `en/workspace/paths.ts` | all ops |
| `WorkspaceRef` | type | not spelled out (resolved workspace handle) | 01 2.3, section 4.8, section 7.1 | `en/workspace/*` | note N6 |
| `ChangeEntry`, `appendChange`, `appendDecision`, `lastChange`, `recentAudit` | type, fn | `appendChange(ws, e: ChangeEntry, nowMs) => Promise<void>` | 01 7.1 | `en/audit/writer.ts` | 02 3.5 step 12 |
| `AuditRef`, `entriesBetween` | type, fn | `(ws, fromMs, toMs, limit) => Promise<AuditRef[]>` | 01 7.1 | `en/audit/reader.ts` | 03 `deps.audit` (`AuditReader.entriesBetween(fromMs, toMs, limit)`) |
| `OpContext` | type | `{repo, root, skillDir, runtimeDir, launcherPath, env, clock, log}` | 01 6.1 | `en/ops/*` | CLI |
| `ops.workspace.{discover,init}`, `ops.config.{inspect,configure,check,migrate,importLegacy}`, `ops.audit.{recordDecision,check}`, `ops.lifecycle.{start,serveForeground,verify,status,stop,restart}`, `ops.diagnostics.{doctor,bundle}`, `ops.instances.{list,setEngine,repairIdentity}`, `ops.upgrade.{run,migrateDb,rebuildDb}`, `ops.ingest.replay`, `ops.hooks.{install,verify,uninstall,setEnabled}`, `ops.backup.*`, `ops.cleanup.run`, `ops.version` | fn | `(ctx: OpContext, input) => Promise<Result>` (result types in `sh/cli/results.ts`) | 01 6.3 | `en/ops/{workspace,config,audit,lifecycle,instances,upgrade,backup,cleanup,diagnostics,hooks,data,legacy,ingest}.ts` | CLI commands; `ops.hooks.status` missing [C23] |
| `probeInstance` | fn | `(ws: WorkspaceRef, o?: { httpTimeoutMs?: number; controlTimeoutMs?: number }) => Promise<ProbeResult>` | 01 4.8 | `en/ops/probe.ts` | start, stop, status, cleanup |
| `InstanceReader`, `openInstanceReader` | type, fn | `{mode, sessions, session, usage, errors, explainCompletion, exportTo, close}`; `openInstanceReader(ws) => Promise<InstanceReader>` | 01 6.1 | `en/reader/{api-reader,db-reader}.ts` (01 S13a) | 03 12.2; `errors` type [C21]; `explainCompletion` [C16] |
| `formatCommand` | fn | `(argv) => string` | 01 6.6 | `en/ops/commands.ts` | 03 `InstanceInfo.commands` |
| `McsError` | class | `(code: CliErrorCode, message)`; not declared as a signature in 01 (note N7) | 01 1.2, section 6.2 | `sh/errors.ts` | all engine modules |

### 2.2 Composition root (owner 01 4.4a)

| Name | Kind | Signature | Code path | Consumers |
|---|---|---|---|---|
| `ErrorRing`, `createErrorRing` | type, fn | `push({source, code, where, message, sessionId?})`, `list(limit?) => ErrorItem[]`; `createErrorRing(clock, capacity? /* 20 */)` | `en/runtime/error-ring.ts` | 03 `errors` route, 06 `SourceCache` |
| `ExecApi` | type | `{execFileText, resolveExecutable, childStats}` | `en/runtime/context.ts` | tests inject fakes |
| `RuntimeProcessInfo` | type | `{pid, startedAtMs, runtimeVersion, bootCodeStamp, previousRunUnclean, phase(), outdated(), ownershipConflict()}` | same | 03 health |
| `InstanceContext` | type | `{instanceId, slug, instanceDir, repoDir, claudeHome, mcsHome, skillDir, runtimeDir, config, instance, hooksEnabled, clock, db, scope, queries, errors, exec, logger, process}` | `en/runtime/context.ts` (06 cites `instance-runtime.ts` [C15]) | 02 (asks `workspaceDir` [C07]), 03, 06 |
| `BuildContextInput`, `buildInstanceContext` | type, fn | `(i: BuildContextInput) => Promise<InstanceContext>` | same | server main, parity harness (06 5.4), benches |
| `RuntimeComponent` | type | `{name, start(), stop(deadlineMs)}` | `en/runtime/instance-runtime.ts` | 02, 03, 06 factories |
| `InstanceRuntime`, `createInstanceRuntime` | type, fn | `{start(), stop(deadlineMs) => {completed, pendingComponent}, ingestUntilIdle({timeoutMs}) => {idle, waitedMs, stats}, ingestReplay(fromSegment) => {segments}, health(), panels}`; `(ctx) => InstanceRuntime` | same | server, 06 5.4, 02/03 integration tests |
| `createStateWatchdog` | fn | `(ctx, { stateFileBytes }) => RuntimeComponent` | `en/runtime/state-watchdog.ts` | runtime |
| `testHook` | fn | `(name: string) => string \| undefined` (only when `MCS_TEST === '1'`) | `en/runtime/test-hooks.ts` | server boot, init, control channel |
| component order | rule | ingest service, lifecycle sweeper, maintenance scheduler [C08], panel service, state watchdog, then `writeRouteFile` | 01 4.4a | `tickAttempts` driver missing [C57] |

### 2.3 Platform (owner 06 unless noted)

| Name | Kind | Signature | Defined in | Code path | Consumers |
|---|---|---|---|---|---|
| `ChildSpec`, `ChildResult`, `ChildErrorCode` | type, enum | `ChildSpec {kind, file, args, cwd?, timeoutMs, maxOutputBytes, encoding: 'utf8' \| 'latin1', extraEnv?}`; `ChildResult {ok, code, stdout, stderr, error, truncated, durationMs}` | 06 3.6 | `en/platform/exec.ts` | 01, 05 S-PROC |
| `execFileText` | fn | `(spec: ChildSpec, signal?: AbortSignal) => Promise<ChildResult>` (never throws) | 06 3.6 (I-06) | same | 01 (python probe, icacls, opener [C11]), 06 panels |
| `resolveExecutable` | fn | `(name: 'git' \| 'docker' \| 'powershell' \| 'ps' \| 'taskkill' \| 'icacls' \| 'node') => Promise<string \| null>` | 06 3.6 | same | 01 calls it with `ExecutableName` incl. `python`, `opener` [C11] |
| `childStats` | fn | `() => Record<ChildKind, ChildKindStats>` | 06 3.6 | same | 03 `HealthReport.children` |
| `spawnDetached` | fn | `(file, args, o: {cwd, env, stdoutFd, stderrFd}) => ChildProcess` | 01 4.2 (signature), 06 3.6 (file) | same | `start` |
| `spawnForeground` | fn | `(file, args, o: {cwd, env}) => ChildProcess` | 01 4.2, 06 3.6 | same | `serve`, legacy delegation |
| `pidAlive`, `commandLineOf`, `forceKill`, `waitForExit` | fn | `pidAlive(pid) => boolean`; `commandLineOf(pid) => Promise<string \| null>`; `forceKill(pid) => Promise<void>`; `waitForExit(pid, timeoutMs, pollMs?) => Promise<boolean>` | 06 4.2 | `en/platform/process.ts` | 01 stop; `forceKill` mechanism differs [C12] |
| `listRuntimeProcesses` | fn | `(runtimeDir: string) => Promise<{pid, instanceId, instanceDir}[]>` | 01 4.2 | `en/platform/markers.ts` (01) vs `process.ts` (06) [C13] | launcher (copy), `probeInstance` |
| `hasRuntimeMarker`, `hasLegacyMarker` | fn | `(commandLine, instanceId) => boolean`; `(commandLine) => boolean` | 01 4.2 | `en/platform/markers.ts` | stop |
| `ProcessMutex`, `tryAcquireMutex`, `acquireMutex`, `mutexName` | type, fn | `mutexName(kind: 'task' \| 'bootstrap' \| 'settings', key) => string`; `acquireMutex(name, {timeoutMs, onWait?}) => Promise<ProcessMutex>` | 01 4.2 | `en/platform/mutex.ts` (+ zero-dep copy in `scripts/mcs.mjs`) | 02 3.5 (key form [C48]), 05 3.3.4 |
| `atomicWriteFile`, `readSmallFile`, `unlinkWithRetry`, `AtomicWriteError`, `SmallFileError` | fn, class | `atomicWriteFile(file, data, {budgetMs?: 3000, mode?}) => Promise<void>` | 06 4.3 | `en/platform/fsx.ts` | 01 `fsio.ts` wrapper |
| `tailLines`, `pySplitlines`, `clipCodePoints` | fn | `tailLines(path, n) => Promise<string[]>` | 06 3.9.1 | `en/platform/fsx.ts` | panels |
| `canonicalPath`, `samePath`, `toPosixRel`, `pathKey` | fn | `pathKey(path)` = `samePath` comparison key | 06 4.1, 03 15.5 | `en/platform/paths.ts` | 03 `attempt_sources.path_key`, 01 markers |
| `hostPlatform`, `pathsCaseInsensitive` | const | | 06 4 | `en/platform/host.ts` | every engine module needing the platform |
| `globFiles` | fn | `(pattern, base, opts = {maxMatches: 500, maxDepth: 8})` | 06 3.9.4 | `en/platform/glob.ts` | logs panel |
| `pyStrptime`, `pyStrptimeValidate`, `toEpochMs` | fn | `pyStrptime(text, format) => {...} \| null` | 06 3.10.4 | `en/platform/pytime.ts` | attempts, config validation [C42] |
| `WatchHint`, `createWatchHint` | type, fn | `(root, onHint, o?: {debounceMs?: 100}) => WatchHint` | 06 4.4 | `en/platform/watch-hint.ts` | 02 scheduler |
| `SESSION_ID_RE`, `AGENT_ID_RE`, `RUN_ID_RE`, `resolveContained`, `isContained`, `walkNoLinks` | const, fn | `resolveContained(root, ...segments) => string \| null` | 05 5.3 S-FS | `en/security/paths.ts` | 03, 06; regexes duplicate 02 [C35] |
| `createLogger`, `Logger`, `LoggerOptions`, `LOG_ROTATE_BYTES`, `LOG_KEEP`, `LOG_ROTATE_RETRY_BUDGET_MS` | fn, type, const | `createLogger({file, level, rotate, clock, rotateBytes?}) => Logger` | 05 5.3 S-LOG-6 | `en/log/logger.ts` | all |

### 2.4 Ingestion (owner 02)

| Name | Kind | Signature | Defined in | Code path |
|---|---|---|---|---|
| `runHook` | fn | `(argv: string[]) => Promise<void>` | 02 1.1, section 2.2 | `cl/hook.ts` -> `cl/hook/main.ts` |
| `resolveMcsHome` | fn | `(env) => string` | 02 2.6.1 | `sh/protocol/*` or `en/ingest/*` (handler and engine both call it; location not fixed, note N8) |
| `writeRouteFile` | fn | `(instance, state: {stoppedAt, spoolUntil?}) => Promise<void>` | 02 2.6.2 | `en/ingest/routes-file.ts` |
| `createIngestService`, `IngestService`, `IngestStats` | fn, type | `(ctx) => {writer, start(), stop(deadlineMs), untilIdle({timeoutMs}): Promise<void>, nudge(), replay(from) => {segmentsReset}, stats()}` | 02 4.10 | `en/ingest/service.ts`; 01 expects other shapes [C06] |
| `IngestIdleTimeoutError` | class | `{pending: IngestStats}` | 02 4.10 | same |
| `IngestWriter`, `IngestBatch`, `IngestItem`, `CursorUpdate` | type | `submit(batch) => boolean; onDrain(cb); flushNow(); stats` | 02 4.6 | `en/ingest/writer.ts`; used by 06 `tickAttempts` |
| `ChangeSink` | type | `record(entity, key, op); flush(); discard()` | 02 4.6 | implemented by 03 `createChangeSink` |
| `EventRowWrite` | type | input of 03 `EventsRepo.insert` | 02 4.1.2 | `en/ingest/event-row.ts` |
| `eventKindOfEnvelope`, `eventKindOfRecord`, `normalizeEnvelope`, `normalizeRecords` | fn | `eventKindOfEnvelope(env) => EventKind \| null` | 02 4.1.2, section 4.3, section 5.6 | `en/ingest/hooks/normalize-envelope.ts`, `en/ingest/transcripts/normalize-record.ts` |
| `LogicalEvent`, `ToolOutcome` | type | union of `k` kinds, section 11.3 | 02 4.3 | `en/ingest/*` |
| `FileIdentity`, `RawLine`, `ReadResult`, `TailCounters`, `IdentityCheck`, `checkIdentity`, `readLines`, `lineStartAtOrAfter` | type, fn | `readLines(path, from, to, deadline, {chunkBytes, maxLineBytes?, acceptValidUnterminatedTail})` | 02 5.3 | `en/ingest/tail/jsonl-tailer.ts`; used by 06 3.10.3 |
| `projectsRoot`, `sanitizeProjectName`, `detectTranscriptsDir` | fn | `detectTranscriptsDir(repo, root) => Promise<string \| null>` | 02 5.1.1 | `en/ingest/transcripts/discovery.ts`; 01 `discover` |
| `realFirstPrompt` | fn | used by 01 `discover` | 01 6.4 | `en/ingest/transcripts/classify.ts` (implied) |
| `SpoolReplayPlan`, `planSpoolReplay`, `applySpoolReplay` | type, fn | `planSpoolReplay(ctx, repos, spoolDir, from)`; `applySpoolReplay(db, ctx, plan) => {segmentsReset}` | 02 2.7 | `en/ingest/spool/replay.ts`; 01 calls `replaySpool` [C04] |
| `TranscriptRef`, `readEntryText` | type, fn | `readEntryText(ref, opts) => entries \| {ok: false, reason: 'REF_STALE' \| 'READ_FAILED' \| 'NOT_FOUND'}` | 02 5.7 | `en/ingest/transcripts/entry-text.ts` (uses 03 `displayEntries`) |
| `claudeArgsWithoutHooks` | fn | `(args) => {args, env}` | 02 2.9 | `en/external/launch-claude.ts` |
| `planHooks`, `buildEntry`, `isOurs` | fn | `planHooks(text \| null, op: 'install' \| 'uninstall', desired) => {obj, text, changed, added, replaced, removed, kept, diff}` | 02 3.3-3.4 | `cl/commands/hooks/plan.ts` (location [C23]) |

### 2.5 Tokens and lifecycle (owner 02)

| Name | Kind | Signature | Defined in | Code path |
|---|---|---|---|---|
| `UsageFields`, `UsageAggregate` | type | | 02 6.3 | `en/tokens/aggregate.ts` |
| `aggregateSession`, `aggregateAgent`, `aggregateByModel`, `aggregateByHour`, `aggregateInstance` | fn | `aggregateSession(sessionId, scope: 'own' \| 'agents' \| 'total') => UsageAggregate` | 02 6.3 | same; 06 parity T2 |
| `legacyFileUsage`, `legacyUsageTotal` | fn | `(fileId)`, `(sessionId)` | 02 6.5 | `en/tokens/legacy-projection.ts`; 06 T1 |
| `LifecycleView`, `SessionFacts`, `AgentFacts`, `WorkflowFacts`, `TurnEndInfo` | type | | 02 7.1-7.2 | `en/lifecycle/facts.ts` |
| `mergeFacts`, `derive` (session, agent, workflow) | fn | `derive(facts, rows, now, cfg) => LifecycleView` | 02 7.2-7.6 | `en/lifecycle/{merge,derive-session,derive-agent,derive-workflow}.ts` |
| `fmtAge`, `renderEvidence`, `toApiEvidence`, `viewChanged` | fn | `renderEvidence(item, now) => string`; `viewChanged(a \| null, b) => boolean` | 02 7.1 | `en/lifecycle/rules.ts`; 03 3.6, section 5.5 |
| `toLegacy`, `classifyLegacy`, `legacyDone` | fn | `toLegacy(view) => LegacyState` | 02 7.9 | `en/lifecycle/legacy.ts` |
| `nextCheckAt` | fn | `(view, input, cfg) => number \| null` | 02 7.8 | `en/lifecycle/next-check.ts` |
| `createLifecycleSweeper`, `LifecycleSweeper` | fn, type | `(ctx, deps: {writer}) => {start(), stop(deadlineMs), tickNow()}` | 02 4.10 | `en/lifecycle/sweeper.ts`; 01 shape differs [C06] |
| work items | fn | rules W-DECL, W-ATT, W-LBL | 02 7.11 | `en/lifecycle/work-items.ts` |
| `explainCompletion`, `CompletionLookup`, `CompletionCandidate`, `AttemptRowRef`, `CompletionTargetError` | fn, type, class | `explainCompletion(lookup, target, now) => CompletionEvidence` | 02 7.13 | `en/lifecycle/completion.ts`; 01/03 call `(queries, target)` [C16] |
| `computeIngestHealth`, alert inputs | fn | (names not fixed) | 02 8.2-8.3 | `en/health/{ingest-health,alert-inputs}.ts` |

### 2.6 Database (owner 03)

| Name | Kind | Signature | Defined in | Code path |
|---|---|---|---|---|
| `SqlValue`, `SqlParams`, `Stmt<R>`, `SqlDriver`, `openSqlite`, `toDbError` | type, fn | `openSqlite(path, {readonly, fileMustExist, timeoutMs}) => SqlDriver` | 03 4.5 | `en/db/driver.ts` (only importer of `better-sqlite3`) |
| `DbError`, `DbErrorCode` | class, enum | section 7.4 | 03 4.3 | `en/db/errors.ts` |
| `RepoContext`, `OpenMode`, `InstanceDb`, `openInstanceDb`, `DB_OPEN_EXIT_CODES` | type, fn, const | `openInstanceDb({path, expectedInstanceId, mode: 'serve' \| 'readonly' \| 'maintenance', runtimeVersion}) => InstanceDb` | 03 4.5 | `en/db/open.ts` |
| `WriteTx`, `withWriteTx`, `onCommitted` | type, fn | `withWriteTx<T>(db, ctx, fn: (tx) => T): T` (03 3.6 prose shows `(ctx, fn)` [C53]); `onCommitted(db, listener) => unsubscribe` | 03 4.5 | `en/db/write.ts` |
| `ChangeRecorder`, `createChangeSink` | type, fn | `reserve(kind, op, {entityId, sessionUid}) => seq; noteId; noteTranscript; flush`; `createChangeSink(tx) => ChangeSink` | 03 9.1 | `en/db/changes.ts`, `en/db/change-sink.ts` |
| `MigrationFile`, `MigrationStatus`, `loadMigrationFiles`, `migrationStatus`, `peekDbSchemaVersion`, `planDbMigrations`, `migrateDb` | type, fn | `migrateDb(path, {backupDone, runtimeVersion, expectedInstanceId, now?}) => {from, to, durationMs}` | 03 4.3 | `en/db/migrations.ts` |
| `backupDb` | fn | `(src: InstanceDb \| {path, expectedInstanceId}, destPath, opts?) => Promise<{bytes, dbSchemaVersion}>` | 03 4.4 | `en/db/backup.ts` |
| `RetentionPolicy`, `RetentionPlan`, `applyRetention` | type, fn | `applyRetention(db, ctx, policy, {dryRun, now, signal?})` | 03 3.8 | `en/maintenance/retention.ts` |
| `exportInstance` | fn | `(db, ctx, q: ExportQuery, out, signal) => Promise<ExportSummary>` | 03 11.1 | `en/maintenance/export.ts` |
| repositories | class | `MetaRepo ProjectsRepo SessionsRepo AgentsRepo WorkflowRunsRepo TurnsRepo EventsRepo ToolCallsRepo UsageRepo TranscriptFilesRepo CheckpointsRepo TransitionsRepo ReconciliationsRepo ExternalObservationsRepo CostStatesRepo HookProbesRepo WorkItemsRepo IngestHealthRepo IngestErrorsRepo SpoolCursorsRepo AttemptsRepo AlertsRepo ChangesRepo`; every method takes `ctx: RepoContext` first | 03 4.5 | `en/db/repos/*.ts` (never imported outside `en/`) |
| named repository methods | fn | `SessionsRepo.ensure`, `SessionsRepo.writeView`, `SessionsRepo.attemptCandidates(ctx, labels, activeSinceMs) => AttemptCandidate[]`, `EventsRepo.insert`, `EventsRepo.findByNaturalKey`, `EventsRepo.deleteTranscriptOnly`, `EventsRepo.detachTranscript`, `UsageRepo.applyRecord`, `UsageRepo.verifyRollups`, `TranscriptFilesRepo.updateCursors`, `ReconciliationsRepo.insert` | 03 3.6, 02 4.4, section 5.3 | `en/db/repos/*.ts` |
| `AttemptsRepo`, `AttemptSourceRow`, `AttemptRunRow`, `NewAttemptRun`, `AttemptEndReason`, `AttemptCandidate` | type | `getSource, saveSource, resetSource, openRun, insertRun, endRun, supersedeRun, setMatch, runsToMatch, latestRuns, evidenceRun` | 03 3.6 | `en/db/repos/attempts.ts` (06 adapter `en/panels/attempts/repo.ts`) |
| `APPLICATION_ID`, `CHECKPOINT_EVERY_ENTRIES`, `WAL_RETRY` | const | 1296253747, 256, `{attempts: 20, delayMs: 25}` | 03 3.3 | `sh/db-constants.ts` |

### 2.7 Query layer, transcript, search, alerts, schedule (owner 03)

| Name | Kind | Signature | Defined in | Code path |
|---|---|---|---|---|
| `EngineQueries` | type | `instanceInfo, health, ingestHealth, errors, overview, listSessions, getSession, sessionSummaries, sessionAgents, listAgents, agentNode, workflowRun, listEvents, getEvent, eventsByIdRange, listToolCalls, toolCallsByIds, sessionTransitions, workItemBoard, getWorkItem, listAlerts, alertRules, usage, sessionUsage, series, tools, hookProbe, explainCompletion` (each `(ctx: RepoContext, ...)`) | 03 12.1 | `en/query/index.ts` |
| `TranscriptQueries` | type | `window, locate, searchSession, searchInstance` (async, with `AbortSignal`) | 03 12.1 | same |
| `AuditEntry`, `AuditReader` | type | `entriesBetween(fromMs, toMs, limit) => AuditEntry[]` (sync) | 03 12.1 | same; 01 version is async (note N9) |
| `createQueries` | fn | `(db, deps: {config, now, audit}) => EngineQueries & TranscriptQueries` | 03 12.1 | same; 01 passes `{config, now, process}` [C09] |
| `displayEntries`, `countEntries` | fn | `displayEntries(record, {textChars}) => Omit<TranscriptEntry,'i'>[]` | 03 7.1 | `en/transcript/entries.ts` |
| `EntryIndexService.ensureIndexed` | fn | `(ctx, fileId, {untilBytes?, budgetMs, signal}) => Promise<{entriesTotal, indexOffset, sizeBytes, complete, reset}>` | 03 7.2 | `en/transcript/index-service.ts` |
| `TranscriptWindowService.read` | fn | | 03 7.3 | `en/transcript/window.ts` |
| search scan | fn | | 03 7.4 | `en/search/{scan,service}.ts` |
| `AlertService.apply` | fn | `(ruleId, scopeKey, r: {holds, severity, value, title, detail, sessionId})` | 03 10.2 | `en/alerts/service.ts` |
| `createDbScheduler` | fn | `(ctx: InstanceContext) => {start(): void; stop(): Promise<void>}` | 03 11.4 | `en/maintenance/schedule.ts`; 01 calls it `createMaintenanceScheduler` [C08] |

### 2.8 Panels (owner 06)

| Name | Kind | Signature | Defined in | Code path |
|---|---|---|---|---|
| `PanelService`, `createPanelService` | type, fn | `{get(key, {limit?}), tickAttempts() => AttemptsTickResult, stats() => PanelStats, close()}`; `(ctx) => PanelService` | 06 3.4 | `en/panels/service.ts` |
| `SourceSpec`, `SourceResult`, `CacheRead`, `SourceCache` | type, class | `new SourceCache(spec, clock: () => number, errors: ErrorRing)`; `read()`, `abort()` | 06 3.5 | `en/panels/source-cache.ts` |
| `CpuSampler`, `memorySample`, `matchWatched` | class, fn | | 06 3.7.1-3.7.2 | `en/panels/machine.ts` |
| `PROC_SCRIPT_NET`, `PROC_SCRIPT_CLM`, `parseProcLines`, `parsePsOutput` | const, fn | | 06 3.7.3-3.7.4 | `en/panels/proc-{win32,posix}.ts` |
| `parseStatusV2`, git sampler | fn | | 06 3.8 | `en/panels/git.ts` |
| `externalState` | fn | `(exitRaw, statusRaw) => {state: AttemptState, evidence}` | 06 3.10.5 | `en/panels/attempts/state.ts` |
| attempts ingest, match, evidence | fn | `matchSticky(rx, line)`, `evidenceRow(s)`, `publishAt` rule | 06 3.10.3-3.10.7 | `en/panels/attempts/{parse,ingest,match,evidence}.ts` |

### 2.9 Server, CLI, launcher, UI entry points

| Name | Kind | Signature / contract | Defined in | Owner | Code path |
|---|---|---|---|---|---|
| server process main | entry | `node <skill>/runtime/packages/server/dist/main.js serve --mcs-instance=<id> --instance-dir=<abs> [--port=<n>] [--log-level=<l>]` | 01 4.1, section 4.4 | 01 | `sv/main.ts`, `sv/{boot,control-channel,shutdown,state-file}.ts` |
| app factory | fn | built from `ctx` and `runtime` | 01 4.4 step 8, 03 S4 | 03 | `sv/app.ts` |
| guards `requestContext`, `hostGuard`, `originGuard`, `uriLimit` | middleware | order of 03 5.2 | 03 5.2, 05 5.3 S-NET | 05 (file), 03 (codes) | `sv/http/guards.ts` |
| stream hub | module | pull-based fan-out | 03 9.2 | 03 | `sv/stream/{hub,hydrate,sse}.ts` |
| routes | module | `sv/routes/{meta,ingest,sessions,agents,events,tool-calls,work-items,overview,alerts,errors,completion,transcript,search,analytics,export,panels}.ts` | 03 23, 06 3.2 | 03 (06 panels) | |
| CLI main | fn | `main(argv: string[], {launcherPath, skillDir, runtimeDir}) => Promise<number>` | 01 5.1 step 7 | 01 | `cl/main.ts`, `cl/commands/<name>.ts`, `cl/render/{text,json,legacy}.ts` |
| `printLine`, `sanitizeForTerminal`, `safeJsonStringify` | fn | only stdout writer of the CLI | 05 5.3 S-OUT, A.39, A0046 | 05 | `cl/io/terminal.ts` |
| launcher | script | `node <skill>/scripts/mcs.mjs <command>` (`$MCS`) | 01 5.1, A0007 | 01 | `<skill>/scripts/mcs.mjs` |
| hook stub | script | `node --no-warnings <skill>/scripts/mcs-hook.mjs --mcs-hook <Event> [--async]`; `--version` prints `HANDLER_VERSION` | 02 2.1, A0010 | 02 | `<skill>/scripts/mcs-hook.mjs` |
| `staleness`, `computeStamps`, `STAMP_SCHEMA_VERSION`, `BUILD_STAMP_FILE`, `INSTALL_STAMP_FILE` | fn, const | `staleness(root?) => {install, build, reasons, installStamp, buildStamp}` | 05 3.3.3, A0047 | 05 | `rt/scripts/build-stamp.mjs` (CLI `check`, `write`, `write-install`) |
| web API client | fn, class | `createApiClient(o) => ApiClient`, `ApiError`, `describeFailure`, `EndpointName` | 04 5.1 | 04 | `wb/data/api-client.ts`, `api-errors.ts`, `endpoint-tracker.ts` |
| web stream client | fn | `createStreamClient(opts: StreamClientOptions) => StreamClient` | 04 5.6 | 04 | `wb/stream/stream-client.ts` |
| web query keys `qk` | const | every key starts `['mcs', instanceId]` | 04 5.2 | 04 | `wb/data/query-keys.ts` |

## 3. Server routes (owner 03 6.1 unless noted)

Common to every route (03 5.1-5.2): guards in order `requestContext`, `hostGuard`, `originGuard`, `uriLimit`, route match, query zod,
handler, error mapper; common errors `400 validation_failed`, `400 param_repeated`, `403 host_not_allowed`, `403 origin_not_allowed`,
`403 cross_site_request`, `404 route_not_found`, `405 method_not_allowed`, `414 uri_too_long`, `500 internal_error`, `503 db_busy`,
`503 disk_full`, `503 shutting_down`. Headers: `X-Request-Id`, `X-MCS-Instance`, `X-MCS-Runtime`, `Cache-Control: no-store` on `/api/*`,
`nosniff`, `no-referrer`, COOP/CORP `same-origin`, `X-Frame-Options: DENY`. Route ids are keys of `sh/api/routes.ts`.

| Route id | Method, path | Request (query/body) | Response schema | Specific errors | Consumers |
|---|---|---|---|---|---|
| `legacyHealth` | `GET /api/health` | - | `LegacyHealth` | - | legacy `cli.py`, 01 `verify` |
| `health` | `GET /api/v3/health` | - | `HealthReport` | - | 01 `status`/`verify`/`start`, 04 `useHealth` |
| `healthIngest` | `GET /api/v3/health/ingest` | - | `IngestHealth & {asOfSeq}` | - | 01 `status` |
| `instance` | `GET /api/v3/instance` | - | `InstanceInfo` | - | 04 `useInstance`, 01 `verify` |
| `config` | `GET /api/v3/config` | - | `ConfigInspection` | - | 04 `useConfigInspection` |
| `errors` | `GET /api/v3/errors` | `since`, `source` list, `limit` 1..200 | `{asOfSeq, items: ErrorItem[]}` | - | 01 `errors` via `ApiReader` |
| `overview` | `GET /api/v3/overview` | `range`/`from`,`to`/`window`, `includeUnmatched` | `Overview` | `range_invalid` | 01 `status`/`verify`, 04 |
| `listSessions` | `GET /api/v3/sessions` | `q state presence project workItem model hasErrors range from to window tokensMin tokensMax includeUnmatched sort dir cursor limit includeTotal` | `Page<SessionSummary>` | `cursor_invalid`, `range_invalid`, `range_too_large` | 01 `sessions list`, 04 |
| `getSession` | `GET /api/v3/sessions/:sessionId` | - | `SessionDetail & {asOfSeq}` | `session_not_found` | 01 `sessions show`, 04 |
| `sessionAgents` | `GET /api/v3/sessions/:sessionId/agents` | `state`, `includeInternal`, `cursor`, `limit` (default 200, max 500) | `Page<AgentNode>` | `session_not_found` | 04 `useAgents` |
| `sessionTimeline` | `GET /api/v3/sessions/:sessionId/timeline` | events params without `session`/`project`, plus `agent` | `EventPage` | `session_not_found`, `agent_not_found` | 04 `useTimeline` |
| `sessionToolCalls` | `GET /api/v3/sessions/:sessionId/tool-calls` | `agent tool status q range from to sort dir cursor limit` | `Page<ToolCallItem>` | `session_not_found` | 04 |
| `sessionTransitions` | `GET /api/v3/sessions/:sessionId/transitions` | `agent`, `cursor`, `limit` | `Page<TransitionItem>` | `session_not_found` | 04 |
| `sessionUsage` | `GET /api/v3/sessions/:sessionId/usage` | `groupBy=agent\|model`, `includeCost=1` | `UsageReport` | `session_not_found` | 01 `usage --session`, 04 |
| `transcriptWindow` | `GET /api/v3/sessions/:sessionId/transcript` | `agent`, `after` (>= -1), `before`, `limit` 1..2000, `textChars` 200..20000, `thinking=1` | `TranscriptWindowResponse` | `session_not_found`, `agent_not_found`, `transcript_gone` | 04 `useTranscriptWindow` |
| `transcriptLocate` | `GET /api/v3/sessions/:sessionId/transcript/locate` | `agent`; one of `i`, `ts`, `offset` | `TranscriptLocateResponse` | as above + `event_not_found` | 04 |
| `searchTranscript` | `GET /api/v3/search/transcript` | `session` (required), `agent`, `q` 0..200, `kinds`, `tool`, `errors=1`, `limit` 1..1000, `budgetMs` 100..10000 | `TranscriptSearchResponse` | `session_not_found`, `search_busy`, `transcript_gone` | 04 `useTranscriptSearch` |
| `searchTranscripts` | `GET /api/v3/search/transcripts` | `q` 2..200, `session`, `project`, `workItem`, `range`/`from`/`to`/`window`, `kinds`, `limit` 1..500, `budgetMs`, `continue` | `InstanceSearchResponse` | `search_busy`, `cursor_invalid` | 01 T-ISO-11 (v3.0 UI does not use it) |
| `listAgents` | `GET /api/v3/agents` | `state kind q session project hasErrors includeInternal range from to window includeUnmatched sort dir cursor limit` | `Page<AgentNode>` | - | - |
| `listEvents` | `GET /api/v3/events` | `type category severity session agent project workItem tool q range from to dir cursor limit around afterId` | `EventPage` | `filter_requires_scope`, `event_not_found` | 04 `useActivity` |
| `getEvent` | `GET /api/v3/events/:eventId` | - | `ActivityEvent & {asOfSeq}` | `event_not_found` | - |
| `listToolCalls` | `GET /api/v3/tool-calls` | `session agent project tool status q range from to sort dir cursor limit` | `Page<ToolCallItem>` | `filter_requires_scope` | - |
| `workItemBoard` | `GET /api/v3/work-items` | `state`, `q` | `WorkItemBoard` | - | 04 `useWorkItems` (UI route `/tasks`) |
| `getWorkItem` | `GET /api/v3/work-items/:workItemId` | - | `WorkItem & {sessions: SessionSummary[]; asOfSeq}` | `work_item_not_found` | 04 |
| `analyticsUsage` | `GET /api/v3/analytics/usage` | `groupBy=model\|session\|project\|workItem\|agent\|none`, filters, `limit` 1..500, `includeCost=1` | `UsageReport` | `range_too_large` | 01 `usage`, 04 |
| `analyticsSeries` | `GET /api/v3/analytics/series` | `bucket=hour\|day`, `tzOffsetMinutes` -840..840, `groupBy=none\|model`, filters | `UsageSeries` | `range_too_large` (> 2000 buckets) | 04 (gated by `features.usageTrend`) |
| `analyticsTools` | `GET /api/v3/analytics/tools` | `groupBy=tool\|mcpServer`, filters, `limit` 1..200 | `ToolFrequencyReport` | - | 04 |
| `listAlerts` | `GET /api/v3/alerts` | `status` (default `open`), `severity`, `rule`, `session`, `cursor`, `limit` | `Page<AlertItem>` | - | 04 |
| `alertRules` | `GET /api/v3/alerts/rules` | - | `{asOfSeq, enabled, sweepSeconds, rules: AlertRuleView[]}` | - | 04 |
| `panel` | `GET /api/v3/panels/:key` | `key` in `PANEL_KEYS`; `limit` 1..200 (attempts only) | `PanelResponse<K>` (`PanelResponseSchema`) | `panel_disabled` | 04 `usePanel` (owner of payload: 06 3.3-3.4) |
| `export` | `GET /api/v3/export` | `ExportQuery` | `application/x-ndjson` stream `mcs.export/1` | `range_invalid`, `export_busy` | 01 `export` via `ApiReader` |
| `ingestNudge` | `POST /api/v3/ingest/nudge` | body `{"instanceId"}` <= 256 bytes, JSON, no `Origin` | `204` | `409 instance_mismatch`, `413 payload_too_large`, `415 unsupported_media_type`, `400 body_invalid_json`, `400 validation_failed` | hook handler (02 2.8) |
| `ingestProbe` | `GET /api/v3/ingest/probes/:probeSessionId` | id `^00000000-0000-4000-8000-[0-9a-f]{12}$` | `HookProbeResult` | `404 probe_not_found` | 02 `hooks verify` V7 |
| `explainCompletion` | `GET /api/v3/completion` | exactly one of `session`, `label` (1..200), `attemptPart` (1..512 [C17]) | `CompletionEvidence & {asOfSeq}` | `404 completion_target_not_found` | 01 `verify-completion` via `ApiReader` [C16] |
| `stream` | `GET /api/v3/stream` | `since` (int >= 0), `epoch` (8 hex); `Last-Event-ID` wins over `since` | `text/event-stream` (section 4) | `503 stream_limit` | 04 stream client |
| static | `GET /`, `/assets/*`, `/theme-init.js`, history fallback | `Accept: text/html` and path not under `/api/` or `/assets/` -> `index.html` | in-memory copy of `rt/packages/web/dist` | `/assets/*` unknown -> 404 | 04 3.1 rule 4, section 12.2 (owner 04 ADR 0039; server side 03 5.1) |

## 4. SSE stream events and payloads (owner 03 9.2)

| Name | Kind | Payload | Notes |
|---|---|---|---|
| `retry: 3000` | frame | - | first line |
| `hello` | frame (no `id`) | `StreamHello` | always second; `instanceId` mismatch -> client stops (04 UI-I11) |
| `change` | frame (`id: <seq>`) | `StreamChange` | contiguous `seq`; hydrated at send time (03 9.3) |
| `heartbeat` | frame (no `id`) | `StreamHeartbeat` | every 15000 ms; no comment lines (03 C-2, 04 CH-1) |
| `reset` | frame (`id: <head>`) | `StreamReset` | reasons `cursor_too_old` (> 2000 behind or pruned), `cursor_ahead`, `epoch_changed`, `cursor_invalid` |

Change kind/op pairs (DB CHECK on `changes`, 03 3.5; `data` of the frame, 03 9.2-9.3):

| kind/op | `data` | Written when (03 9.1) | Client effect (04 5.5) |
|---|---|---|---|
| `session/upsert` | `SessionSummary \| null` | view change (immediate), visible columns (throttled 1 s) | patch by `seq` (R1) |
| `session/delete` | `null` | data retention | remove |
| `agent/upsert` | `AgentNode \| null` | agent view or columns | patch `qk.agents` |
| `workflow/upsert` | `WorkflowRunItem \| null` | run view or counters | patch member agents' `workflow.state` |
| `tool_call/upsert` | `{items: ToolCallItem[], truncated}` | visible tool-call change | patch rows by `toolUseId` |
| `event/append` | `{items: ActivityEvent[], count, truncated}` | new `events` rows (<= 50 items per frame) | live buffers |
| `transcript/append` | `{agentId, sizeBytes} \| null` | `size_seen` grew | refresh mounted viewers |
| `work_item/upsert` | `WorkItem \| null` | board derivation changed | patch board |
| `usage/invalidate` | `{sessionId}` | rollups changed | debounced invalidate |
| `alert/upsert` | `AlertItem \| null` | insert, resolve, severity change | invalidate health/overview |
| `health/upsert` | `HealthReport` | status change (<= 1/s) | `setQueryData` |
| `attempt/upsert` | `{ids: number[], truncated}` | `attempt_runs` changed | invalidate attempts panel (06 3.10.2 still says "not a stream kind" [C40]) |

`ChangeSink.record(entity, ...)` mapping (03 9.1): `session`, `turn` -> `session/upsert`; `agent` -> `agent/upsert`; `workflow_run` ->
`workflow/upsert`; `tool_call` -> `tool_call/upsert`; `event` -> `event/append` (03 text still names `hook_event`, `transcript_entry`
[C59]); `usage` -> `usage/invalidate`; `ingest_health` -> `health/upsert`; `reconciliation` -> `event/append` (session) or `health/upsert`
(instance). Limits: 16 streams per instance (17th `503 stream_limit`), eviction after 30 s undrained, frame LRU 512, frame <= 64 KB,
change-log retention 24 h or 20,000 rows (`retention.changesMaxAgeHours`, `retention.changesMaxRows`).

## 5. Database (owner 03 3-4)

### 5.1 Files, pragmas, identity

| Name | Kind | Defined in | Code path / value | Notes |
|---|---|---|---|---|
| `data/monitor.db` (+ `-wal`, `-shm`) | file | 03 3.2, 01 1.1 | `<ws>/data/monitor.db` | one writer (server); CLI read-only or `maintenance` mode when stopped |
| `0001_initial.sql` | migration | 03 3.5 | `rt/packages/engine/migrations/0001_initial.sql` | frozen after S1; sha256 (LF) `56cdf39902ad1e135b1d1de996a30ff72f5b604ecb9bbd96672c1d84019e25eb` (03 X14) |
| migration file pattern | rule | 03 4.1 | `^(\d{4})_([a-z0-9_]{1,48})\.sql$`; header `-- mcs:migration version=N name=x`; optional `-- mcs:foreign_keys=off` | runner `en/db/migrations.ts` |
| fixture DBs | file | 03 4.1 | `rt/packages/engine/test/fixtures/db/v<N>.db`, `schema.snapshot.sql` | DA-T-DB-1, 6 |
| PRAGMAs | config | 03 3.2, A0020 | `auto_vacuum=INCREMENTAL` (new file), `journal_mode=WAL` (BUSY retry 20 x 25 ms), `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=MEMORY`, `cache_size=-16000`, `journal_size_limit=67108864`, read-only adds `query_only=1` | |
| `application_id` | const | 03 3.3 | 1296253747 ("MCS3") | `db_not_mcs` on mismatch |
| `user_version` | pragma | 03 4.2 | mirrors `max(schema_migrations.version)` | read by `peekDbSchemaVersion` |
| `SUPPORTED_DB_SCHEMA` | const | 01 2.6 | not defined in 03 (03 uses `latest` from shipped files) | note N10 |

`meta` keys (03 3.3): `instance_id`, `db_format` (`mcs-monitor-db`), `created_at`, `created_by_runtime`, `privacy_profile`
(`metadata-v1`), `last_alive_at` (60 s), `last_shutdown_at`, `last_integrity_check`.

### 5.2 Tables (03 3.5; 28 own tables + runner table `schema_migrations` + `sqlite_sequence`)

| Table | Key / unique | Hard FK | Main consumers | Notes (02 logical entity, 03 3.5 mapping) |
|---|---|---|---|---|
| `meta` | `key` PK | - | open identity | WITHOUT ROWID |
| `projects` | `id`; `project_key` UNIQUE | - | filters `project` | |
| `sessions` | `id`; `session_uid` UNIQUE | `project_id -> projects` SET NULL | 02 writer, 03 queries | lifecycle view columns `state presence wait_reason stale_kind end_reason turn_outcome state_basis state_confidence state_rule state_evidence state_since evaluated_at next_check_at facts_json`; rollups `usage_* tok_*`; `hook_coverage`, `hook_missing_*`; `updated_seq` |
| `workflow_runs` | `id`; `(session_id, run_uid)` UNIQUE | `session_id -> sessions` CASCADE | 02 `workflow_run` | `run_uid GLOB 'wf_*'` |
| `agents` | `id`; `(session_id, agent_uid)` UNIQUE | `session_id` CASCADE | 02 `agent` | `kind` in `main subagent workflow_agent teammate internal` (02 lists 3 values [C56]); `agent_uid = 'main'` row per session |
| `turns` | `id`; `(session_id, prompt_id)` UNIQUE | CASCADE | 02 `turn` | `end_kind` in `stop stop_failure end_turn turn_duration interrupted`; LWW stamp `(ended_at, end_rank, end_tie)` |
| `transcript_files` | `id`; `path_key` UNIQUE | - | 02 `transcript_file` | cursors `head_end backfill_offset tail_start tail_offset size_seen partial_bytes`; `state` adds `retired`; `usage_state`; counters; entry index `index_offset index_head_hash entries_total` |
| `transcript_checkpoints` | `(file_id, entry_index)` PK | - | 03 7.2 | WITHOUT ROWID; one row per ~256 entries |
| `tool_calls` | `id`; `tool_use_id` UNIQUE | CASCADE | 02 `tool_call` | `sources` bits 1 hook_pre, 2 hook_post, 4 transcript_use, 8 transcript_result, 16 hook_batch; `outcome` `ok error denied interrupted` |
| `events` | `id`; partial UNIQUE `event_uid`, `natural_key`, `record_uuid` | CASCADE | 02 `event` (single table, I-03) | `kind` format-checked `<domain>.<verb>`; `sources` 1 hook, 2 transcript, 4 monitor; `ts_source` `record hook_received derived`; `change_seq` |
| `entry_occurrences` | `(file_id, byte_offset)` PK | - | 02 resume copies | |
| `usage_files` | `(file_id, message_key)` PK | - | 02 `message_usage_file` | NULL = missing; `legacy_in/out/cr/cc` |
| `usage` | `id`; `message_key` UNIQUE | CASCADE | 03 analytics | owner `session_id`, `agent_id`, `owner_file_id`; `ts` = earliest first record |
| `cost_states` | `file_id` PK | CASCADE | 02 `cost_state` | provider-reported, never summed |
| `state_transitions` | `id` | CASCADE | 03 `sessionTransitions` | written on state change |
| `reconciliations` | `id`; `(scope_key, kind, detail_hash)` UNIQUE | CASCADE (nullable) | 02 8.1 | kinds section 11.6 |
| `external_observations` | `(session_id, source)` PK | CASCADE | 02 `external_observation` | `source` `registry job pid attempt` |
| `hook_probes` | `probe_session_id` PK | - | route `ingestProbe` | deleted after 24 h |
| `work_items` | `id`; `item_key` UNIQUE | - | 02 7.11, route `workItemBoard` | `kind` `declared attempt label` (API `source` `declared attempts label` [C52]); `rule` `W-DECL W-ATT W-LBL` |
| `work_item_sessions` | `(work_item_id, session_id)` PK; `session_id` UNIQUE | both CASCADE | board | a session in at most one item |
| `ingest_health` | `id = 1` | - | 02 8.2 | `report_json`, `counters_json` |
| `ingest_errors` | `id` | - | 02 4.8 | `code = upper(code)`; `source` `spool transcript external writer handler alerts db`; newest 1000 kept |
| `spool_cursors` | `segment` PK | - | 02 `spool_cursor` | `segment GLOB '*.ndjson'`; columns `offset_bytes size_seen ino head_hash lines partial_bytes sealed errors ...` (01 6.4 says `offset`, 02 2.7 `offset_bytes` = owner form) |
| `attempt_sources` | `id`; `path_key` UNIQUE | - | 06 3.10 | no `instance_id` (03 C-1) |
| `attempt_runs` | `id`; `(source_id, generation, start_offset)` UNIQUE | - (soft `source_id`, soft `session_id` = `sessions.id`) | 06 3.10 | `end_reason` `open ended superseded`; `state` `COMPLETED FAILED RUNNING UNKNOWN`; 06's reference copy is stale [C40] |
| `alerts` | `id`; partial UNIQUE `(rule_id, scope_key) WHERE status='open'` | `session_id` SET NULL | 03 10 | `severity warning critical`, `status open resolved`, `resolved_reason condition_cleared expired rule_disabled scope_deleted` |
| `alert_state` | `(rule_id, scope_key)` PK | - | 03 10.2 | cooldown |
| `changes` | `seq` AUTOINCREMENT | - | stream | `CHECK (kind/op pairs of section 4)` |
| `schema_migrations` | `version` PK | - | runner only | `name, checksum, applied_at, runtime_version, duration_ms` (03 4.2) |

### 5.3 Indexes (03 3.5, justified in section 3.7)

`idx_sessions_activity`, `idx_sessions_state_activity`, `idx_sessions_project`, `idx_sessions_next_check` (partial),
`idx_workflow_runs_next_check` (partial), `idx_agents_state_activity` (partial), `idx_agents_next_check` (partial), `idx_turns_session`,
`idx_transcript_files_session`, `idx_transcript_files_behind` (partial), `idx_tool_calls_session`, `idx_tool_calls_name`,
`idx_tool_calls_open` (partial), `ux_events_event_uid`, `ux_events_natural_key`, `ux_events_record_uuid` (all partial unique),
`idx_events_session_ts`, `idx_events_ts`, `idx_events_kind_ts`, `idx_events_problems` (partial), `idx_events_content` (partial),
`idx_entry_occurrences_uuid`, `idx_usage_files_key`, `idx_usage_session`, `idx_usage_ts_cover` (named with `INDEXED BY` in every
time-window aggregate), `idx_cost_states_session`, `idx_transitions_session`, `idx_reconciliations_session` (partial),
`idx_reconciliations_kind_at`, `idx_work_items_state`, `idx_ingest_errors_at`, `idx_ingest_errors_code`, `idx_attempt_runs_session`
(partial), `idx_attempt_runs_open` (partial), `idx_attempt_runs_start`, `ux_alerts_live` (partial unique), `idx_alerts_status`,
`idx_alerts_session` (partial), `idx_changes_at`. Total with autoindexes: 52 (03 X14). 06 3.10.2 uses obsolete names
`attempt_runs_by_session`, `attempt_runs_open_by_part`, `attempt_runs_by_start` [C40].

### 5.4 Natural keys of `events` (03 3.6, adopted by 02 4.1.1)

`tool.call:<tool_use_id>`, `tool.end:<tool_use_id>`, `prompt:<session_uid>:<prompt_id>`, `permission.denied:<tool_use_id>`,
`tool.batch:<session_uid>:<ids_hash>`, `task.created:<session_uid>:<task_id>`, `task.completed:<session_uid>:<task_id>`,
`recon:<reconciliation id>` (monitor rows). `record_uuid` = record `uuid`, else `f<file_id>:<byte_offset>`. API `ActivityEvent.key` =
natural key, `h:<event uid>` or `t:<record uuid>`.

## 6. Configuration keys and environment variables (owner 01 1.6, section 2)

Precedence (01 2.1): builtin < skill (`config/defaults.json`, `runtime/defaults.json`) < instance (`config.json`, then `runtime.json`) <
env (`MCS_LOG_LEVEL` only) < CLI (`--port`, `--log-level`). Provenance tags `builtin skill config runtime env cli`. L and R top-level
names are disjoint; `configure --set` routes by the first path segment.

### 6.1 Legacy L keys (`<ws>/config.json`, schema_version 1; defaults in `<skill>/config/defaults.json`, read-only)

| Key | Type / predicate (01 2.4) | Default | Read by (Node) |
|---|---|---|---|
| `schema_version` | int (1) | 1 | schema gate 01 2.6 |
| `title` | non-empty string | `Claude sessions monitor` | `InstanceInfo.title` |
| `port` | int 1..65535 | 8765 | `effectivePort` (01 2.1) |
| `repo` | string path | `.` | `ctx.repoDir`, 06 git panel |
| `transcripts_dir` | `'auto'`, path or null | `auto` | 02 5.1.1 |
| `window_hours` | number > 0 | 8 | derived `import.lookbackHours`, API `window=1`, `InstanceInfo.windowHours` |
| `active_seconds` | number > 0 | 120 | derived `lifecycle.activeSeconds` |
| `pending_tool_grace_seconds` | number > 0 | 900 | derived `lifecycle.pendingToolGraceSeconds` |
| `include_unmatched` | boolean | false | 03 `includeUnmatched`, 06 matching |
| `session_rules` | list of `{match, label?, scope?, name?}` | `[]` | 02 5.2 (Python regex, 01 2.8) |
| `session_ids` | list of strings | `[]` | 02 pinned sessions, route file `match.sessionIds` |
| `panels` | object of booleans: `machine git logs ledger chain_log attempts` | `machine, git, logs` true | 06 `PANEL_CONFIG_KEY`, 03 `panel_disabled` |
| `live_log_globs` | list of strings | `[]` | 06 3.9.3 |
| `chain_log` | string or null | null | 06 3.10 |
| `ledger` | string or null | null | 06 3.9.2 |
| `stop_file` | string or null | null | 06 3.8 |
| `attempts` | null or `{start, end, label_prefix?, time_format?}` | null | 06 3.10.1 (`time_format` check [C42]) |
| `watched_processes` | list of strings | 9 image names | 06 3.7.2 |
| `docker` | boolean | true | 06 3.7.5 |
| `ui` | `{theme, density, newest_first, show_tools, show_thinking, show_prompts}` | `auto, comfortable, true, true, false, false` | `InstanceInfo.ui` (camelCase) |
| `poll` | `{events_ms, sessions_ms, machine_ms, logs_ms, overview_ms, attempts_ms, stale_after_ms}` | `1500, 6000, 2000, 3000, 5000, 6000, 15000` | `InstanceInfo.poll`, `staleAfterMs` (mapping undefined [C26]) |
| `limits` | `{event_window_mb, max_events, text_chars, usage_scan_budget_ms, usage_max_mb}` | `8, 20000, 6000, 1500, 512` | derived `import.tailWindowBytes`, `import.backfillMaxBytes`; `textChars` |

Merged per sub-key: `panels ui poll limits` (`L_MERGED`). Keys starting with `_` are ignored.

### 6.2 Runtime R keys (`<ws>/runtime.json`, schema_version 1; skill layer `<skill>/runtime/defaults.json`)

| Key | Type | Default | Range (01 1.6) | Semantics owner | Notes |
|---|---|---|---|---|---|
| `logLevel` | enum | `info` | `error warn info debug` | 01, 05 | env `MCS_LOG_LEVEL`, CLI `--log-level` |
| `server.port` | int or null | null | 1..65535 | 01 | null = `config.json port` |
| `server.portScan` | int | 19 | 0..99 | 01 | |
| `server.requestTimeoutMs` | int | 30000 | 1000..600000 | 01 (used by 03 5.1, 05 S-NET-6) | |
| `server.shutdownGraceMs` | int | 5000 | 100..60000 | 01 4.5 | |
| `process.startTimeoutMs` | int | 20000 | 1000..300000 | 01 4.7 | |
| `process.stopTimeoutMs` | int | 10000 | 1000..300000 | 01 4.9 | |
| `process.stateWatchdogMs` | int | 15000 | 1000..600000 | 01 4.6 | |
| `backup.keep` | int | 5 | 1..100 | 01 5.5 | |
| `lifecycle.activeSeconds` | number or null | derived `active_seconds` | > 0, <= 86400 | 02 7.8 | |
| `lifecycle.pendingToolGraceSeconds` | number or null | derived `pending_tool_grace_seconds` | > 0, <= 86400 | 02 7.8 | |
| `lifecycle.subagentActiveSeconds` | int | 60 | 1..86400 | 02 7.8 | |
| `lifecycle.staleAfterSeconds` | int | 1800 | 60..604800 | 02 7.8 | |
| `lifecycle.abandonedAfterSeconds` | int | 86400 | 600..2592000 | 02 7.8 | |
| `lifecycle.processGoneGraceSeconds` | int | 30 | 0..3600 | 02 7.8 | |
| `lifecycle.crossSourceToleranceMs` | int | 2000 | 0..60000 | 02 7.8 | |
| `lifecycle.reopenToleranceMs` | int | 2000 | 0..60000 | 02 7.8 | |
| `lifecycle.sweepIntervalMs` | int | 5000 | 500..60000 | 02 7.8 | |
| `lifecycle.pidCheckIntervalMs` | int | 10000 | 1000..600000 | 02 7.8 | |
| `lifecycle.registryPollMs` | int | 5000 | 1000..600000 | 02 7.8 | |
| `lifecycle.jobsPollMs` | int | 15000 | 1000..600000 | 02 7.8 | |
| `hooks.spoolWhileStoppedHours` | int | 72 | 1..720 (02: 0..720, 0 = stop at once) | 02 2.6.2 | [C02] |
| `ingest.queueMaxItems` | int | 5000 | 100..100000 | 02 4.7 | |
| `ingest.queueMaxBytes` | int | 33554432 | 1 MiB..512 MiB | 02 4.7 | |
| `spool.pollMs` | int | 500 | 50..60000 (02: 100..10000) | 02 2.7 | [C02] |
| `spool.sealGraceMs` | int | 120000 | 5000..3600000 (02: 10000..) | 02 2.7 | [C02] |
| `spool.retainHours` | int | 24 | 1..720 | 02 2.7 | |
| `import.lookbackHours` | number or null | derived `window_hours` | > 0, <= 8760 (02: int 1..8760) | 02 5.1.2 | [C02] |
| `import.tailWindowBytes` | int or null | derived `limits.event_window_mb` x 1 MiB | 65536..1 GiB (02: 1 MiB..4 GiB) | 02 5.5 | [C02] |
| `import.backfillMaxBytes` | int or null | derived `limits.usage_max_mb` x 1 MiB | 65536..64 GiB (02: 0..64 GiB) | 02 5.5 | [C02] |
| `import.headMaxBytes` | int | 16777216 | 64 KiB..256 MiB (02: 1 MiB..) | 02 5.2, section 5.5 | [C02] |
| `import.maxLineBytes` | int | 67108864 | 1 MiB..256 MiB | - | must not exist (02 I-32) [C01] |
| `import.untrackAfterHours` | int | 48 | 1..8760 | 02 5.1.2 | |
| `import.discoveryIntervalMs` | int | 5000 | 500..600000 (02: 1000..) | 02 5.1.2 | [C02] |
| `import.scanIntervalMs` | int | 1000 | 100..60000 (02: 250..) | 02 5.4 | [C02] |
| `import.sliceMs` | int | 20 | 5..200 | 02 5.4 | |
| `import.backfillShare` | number | 0.25 | 0.05..1 | 02 5.4 | |
| `health.importLagWarnMs` | int | 30000 | 1000..3600000 | 02 8.2 | |
| `health.backlogWarnMs` | int | 10000 | 1000..3600000 | 02 8.2 | |
| `analytics.usageTrend` | boolean | false | - | 03 6.2, 04 4.4.6 | `InstanceInfo.features.usageTrend` |
| `board.items` | `{key, title, match: {labels?, labelPrefix?, sessionIds?, attemptParts?}}[]` | `[]` | owner schema | 02 7.11 | 04 S-8 |
| `panelOptions.attemptsWindowHours` | int | 24 | (06: not stated) | 06 3.10.3 | |
| `panelOptions.machineProcessIntervalMs` | int | 20000 | 10000..300000 | 06 3.5 | |
| `retention.changesMaxAgeHours` | int | 24 | 1..720 | 03 3.8 | |
| `retention.changesMaxRows` | int | 20000 | 2000..1000000 | 03 3.8 | |
| `retention.ingestErrorsMaxRows` | int | 1000 | 100..100000 | 03 3.8 | |
| `retention.resolvedAlertsDays` | int | 30 | 1..3650 | 03 3.8 | |
| `retention.instanceReconciliationsDays` | int | 90 | 1..3650 | 03 3.8 | |
| `retention.sessionsDays` | int or null | null | 1..3650 | 03 3.8 | `applyRetention` default |
| `retention.eventsDays` | int or null | null | 1..3650 | 03 3.8 | |
| `alerts.enabled` | boolean | true | - | 03 10.1 | |
| `alerts.sweepSeconds` | int | 60 | 15..600 | 03 10.1 | |
| `alerts.rules.inactivity` | `{enabled, minutes, cooldownMinutes}` | `true, 30, 10` | | 03 10.1 | |
| `alerts.rules.ingest_errors` | `{enabled, count, windowMinutes, criticalCount, cooldownMinutes}` | `true, 10, 10, 50, 10` | | 03 10.1 | |
| `alerts.rules.runtime_unavailable` | `{enabled, expireHours}` | `true, 24` | | 03 10.1 | |
| `alerts.rules.token_threshold` | `{enabled, tokens, field}` | `false, null, 'total'` | | 03 10.1 | |
| `alerts.rules.import_lag` | `{enabled, cooldownMinutes}` | `true, 10` | | 03 10.1 | |
| `alerts.rules.db_disk` | `{enabled, minFreeMb, maxDbMb, cooldownMinutes}` | `true, 500, 2048, 30` | | 03 10.1 | |
| `alerts.rules.hook_gap` | `{enabled, cooldownMinutes}` | `true, 30` | | 03 10.1 | |
| `alerts.rules.hook_failing` | `{enabled, cooldownMinutes}` | `true, 10` | | 03 10.1 | |
| `pricing.currency` | string | `USD` | | 03 8.3 | |
| `pricing.models[]` | `{match, effectiveFrom, inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWrite5mPerMTok, cacheWrite1hPerMTok}` | `[]` (no prices ship, D15) | | 03 8.3 | `features.costEstimates` |

Derived defaults (`R_DERIVED_DEFAULTS`, 01 1.6): `lifecycle.activeSeconds`, `lifecycle.pendingToolGraceSeconds`, `import.lookbackHours`
(identity), `import.tailWindowBytes`, `import.backfillMaxBytes` (`mib-to-bytes`). No `server.devOrigins`, no `server.bindHost` (I-31).

### 6.3 Environment variables (the closed list `DOCUMENTED_ENV_VARS`, 01 2.10)

| Variable | Scope | Reader | Effect | Defined in |
|---|---|---|---|---|
| `MCS_LOG_LEVEL` | runtime | config resolution, logger | `logLevel` (layer env) | 01 2.10, 05 S-LOG-1 |
| `MCS_HOOK_DISABLE` | runtime | hook stub and handler | `1` = exit 0 without work; set for every child and the server | 01 2.10, 02 2.9 |
| `MCS_HOME` | runtime | `resolveMcsHome(env)` | per-user state folder | 02 2.6.1 |
| `CLAUDE_CONFIG_DIR` | runtime (non-MCS) | discovery, installer user scope, external pollers | Claude home (default `~/.claude`) | 01 2.10, 02 1.3 |
| `MCS_FS_WATCH` | runtime | `createWatchHint` | `0` = no `fs.watch` hint | 06 4.4 |
| `MCS_LAUNCHER_NO_BOOTSTRAP` | runtime | launcher | `1` = stale build is an error | 01 5.1 |
| `MCS_PYTHON` | runtime | legacy delegation probe | Python executable for `$V` | 01 6.5 |
| `MCS_DEBUG` | runtime | CLI, launcher | `1` = stack traces | 01 2.10 |
| `MCS_TEST` | test | `testHook`, installer and hooks CLI guards | `1` = test mode | 01 2.10, 02 3.5 |
| `VITEST` | test (non-MCS) | installer guard | same guard effect as `MCS_TEST` | 01, 02 |
| `MCS_TEST_IGNORE_CONTROL` | test | control channel | ignore `shutdown` (T-LC-06) | 01 2.10 |
| `MCS_TEST_BOOT_HANG` | test | server boot | stop before `ready` (T-LC-08) | 01 2.10 |
| `MCS_TEST_INIT_CRASH` | test | `ops.workspace.init` | `before-rename` -> exit 70 (T-LC-10) | 01 2.10 |
| `MCS_PERF_FACTOR` | test | performance tests | budget multiplier (default 1) | 01 2.10, 02 2.10 |
| `MCS_GOLDEN_LIVE_CONFIG` | test | regex parity | path of a real `config.json` (counts only) | 01 2.8 |
| `MCS_GOLDEN_DIR` | test | parity harness | golden folder override | 05 4.11.3, 06 5.2.6 |
| `MCS_PARITY_LIVE` | test | parity project | `1` = run the Python oracle | 05 4.11.2 |
| `MCS_E2E_CLAUDE` | test | optional real-provider E2E | `1` enables | 02 3.7 |
| `MCS_E2E_PORT` | test | Playwright config | port (01 says default 18900; must be 18500-18599 [C31]) | 01 2.10, 05 A.28 |
| `MCS_DEV_API` | dev | `vite.config.ts` | proxy target (default `http://127.0.0.1:18765`) | 04 12.2, 05 A.27 |
| `MCS_WEB_DEV_PORT` | dev | `vite.config.ts` | default 18766 | same |
| `MCS_WEB_PREVIEW_PORT` | dev | `vite.config.ts` | default 18767 | same |
| `MCS_BUILD_ID` | dev | `vite.config.ts` | `VITE_BUILD_ID` (default `dev`) | same |
| `LOCALAPPDATA`, `XDG_STATE_HOME` | runtime (non-MCS) | `resolveMcsHome` | default `MCS_HOME` location | 02 2.6.1 |
| `CLAUDE_PID` | runtime (non-MCS) | hook handler | `claude_pid` envelope field | 02 2.3.1, A0019 |
| `TZ` | test (non-MCS) | Vitest config, golden capture | `UTC` pinned | 05 2.8, 06 5.2.3 |
| `VITEST_POOL_ID` | test (non-MCS) | testkit `allocatePort` | port block | 05 4.5 |
| `PYTHONDONTWRITEBYTECODE` | test (non-MCS) | parity wrapper | no `__pycache__` | 05 4.11.4 |
| `NO_COLOR` | runtime (non-MCS) | `cl/io/terminal.ts` | disables colours | 05 S-OUT-4 |
| `NODE_ENV` | runtime (non-MCS) | `registerRoute` | response validation off in production | 03 13 (note N3) |
| `VITE_BUILD_ID` | build output | web `AboutSection` | `import.meta.env.VITE_BUILD_ID` | 04 4.4.7 |
| `GIT_TERMINAL_PROMPT`, `GIT_OPTIONAL_LOCKS`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG` | child env | `execFileText` env policy | set or passed for kinds `git`, `docker` | 05 S-PROC-3, 06 3.6 rule 4 |

## 7. Error codes: the single catalogue

Seven code families exist; they never share a spelling style: HTTP codes are lowercase snake_case, CLI codes are UPPER_SNAKE, DB
codes are lowercase, ingest codes are UPPER_SNAKE stored in `ingest_errors.code`. "CLI exit" is the `mcs` exit code (0 ok, 1 failure, 2
usage, 130 interrupted; 01 6.2); "Proc exit" is the server process exit code (01 4.1).

### 7.1 HTTP `ErrorCode` (owner 03 5.2, `sh/api/errors.ts`)

| Code | HTTP | Raised by | CLI mapping when read through `ApiReader` |
|---|---|---|---|
| `validation_failed` | 400 | route zod schema, nudge body | `API_ERROR` |
| `param_repeated` | 400 | query parser | `API_ERROR` |
| `body_invalid_json` | 400 | JSON body parser (nudge) | - |
| `cursor_invalid` | 400 | cursor check, `searchTranscripts` continuation | UI restarts list (04 5.3) |
| `range_invalid` | 400 | `range` with `from`/`to`, bad bounds | `API_ERROR` |
| `range_too_large` | 400 | > 2000 buckets, span > 3650 d | `API_ERROR` |
| `filter_requires_scope` | 400 | event `q`/`tool` without `session` and window > 7 d | `API_ERROR` |
| `query_too_short` | 400 | `q` < 2 chars | `API_ERROR` |
| `host_not_allowed` | 403 | `hostGuard` (05 S-NET-2) | `API_ERROR` |
| `origin_not_allowed` | 403 | `originGuard`; any `Origin` on the nudge | - |
| `cross_site_request` | 403 | `Sec-Fetch-Site` rule | - |
| `csrf_rejected` | 403 | reserved (no mutating UI route in v3) | - |
| `route_not_found` | 404 | unknown `/api/*` path (also legacy `/api/sessions`) | - |
| `session_not_found` | 404 | session routes | `null` in `InstanceReader.session` |
| `agent_not_found` | 404 | `agent` filter, transcript routes | |
| `event_not_found` | 404 | `getEvent`, `around`, locate without entries | |
| `work_item_not_found` | 404 | `getWorkItem` | |
| `alert_not_found` | 404 | listed in catalogue; no route raises it in 03 6.1 (note N11) | |
| `panel_disabled` | 404 | `panel` route when `config.panels[...]` is not `true` | 04 removes the panel |
| `probe_not_found` | 404 | `ingestProbe` | `hooks verify` V7 keeps polling |
| `completion_target_not_found` | 404 | `explainCompletion` | `NOT_FOUND` (01 6.4) |
| `method_not_allowed` | 405 | known path, other method incl. `OPTIONS` | |
| `instance_mismatch` | 409 | nudge with another `instanceId` | handler ignores it |
| `transcript_gone` | 410 | transcript file `missing` | |
| `payload_too_large` | 413 | body > 64 KiB (nudge > 256 bytes) | |
| `uri_too_long` | 414 | URL > 8192 | |
| `unsupported_media_type` | 415 | nudge not JSON | |
| `search_busy`, `export_busy` | 429 (+ `Retry-After: 2`) | > 2 searches, > 1 export | |
| `internal_error` | 500 | unexpected error (error ring `source 'server'`, `code 'INTERNAL'`) | `API_ERROR` |
| `db_busy` | 503 (+ `Retry-After: 1`) | `DbError db_busy` | |
| `disk_full` | 503 | `DbError db_full` | |
| `stream_limit` | 503 | 17th SSE stream | 04 falls back to polling |
| `shutting_down` | 503 | server phase `stopping` | |

### 7.2 CLI error codes (owner 01 6.2, `sh/errors.ts`; spelled `ErrorCode` there [C19])

All exit 1 except `USAGE` (exit 2). Emitted in `CliEnvelope.error.code`.

| Code | Raised by (01 section) | Proc exit when raised at boot |
|---|---|---|
| `USAGE` | parser, `--set` without `=`, `ingest replay --from` bad name, completion `target_invalid` | - |
| `CONFIG_INVALID` | section 2.3-2.4, configure, derived defaults, `MCS_LOG_LEVEL` invalid | 10 |
| `CONFIG_SCHEMA_MISSING`, `CONFIG_SCHEMA_UNSUPPORTED` | section 2.6 schema gate | 10 |
| `CONFIG_UNREADABLE` | `readJsonFile`, shared defaults unreadable | 10 |
| `REGEX_UNSUPPORTED` | section 2.8 translator | 10 |
| `SLUG_INVALID`, `WORKSPACE_ESCAPE`, `WORKSPACE_SYMLINK` | `resolveWorkspace` section 3.2 | 17 |
| `TASK_NOT_FOUND` | `start` without `task.json` section 4.7 | - |
| `WORKSPACE_INVALID` | file problems, `AtomicWriteError` mapping section 1.2 | 17 |
| `WORKSPACE_EXISTS_CONFIG_DIFFERS` | `init` reuse section 4.12, `config migrate --from-legacy` | - |
| `INSTANCE_NOT_INITIALIZED` | `upgrade` without `instance.json` section 5.4 | - |
| `IDENTITY_MISMATCH` | section 3.2 checks | 11 |
| `INSTANCE_RUNNING` | repair, restore, db rebuild, upgrade without `--restart`, `serve` | - |
| `INSTANCE_NOT_RUNNING` | (catalogue only; `verify` path) | - |
| `ENGINE_CONFLICT` | `db rebuild` on a legacy engine | - |
| `LEGACY_ENGINE_UNAVAILABLE` | section 6.5 Python probe | - |
| `START_FAILED`, `START_TIMEOUT` | `start` section 4.7 | - |
| `PORT_EXHAUSTED` | bind section 4.11 | 13 |
| `STOP_FAILED`, `NOT_OUR_PROCESS` | `stop` section 4.9 | - |
| `DB_NEWER_THAN_RUNTIME` | open, start, upgrade, restore | 15 |
| `DB_UPGRADE_REQUIRED` | start on an older DB | 16 |
| `DB_ERROR` | migration failure, open failure | 14 |
| `DOWNGRADE_REFUSED` | `upgrade` section 5.7 | - |
| `BACKUP_NOT_FOUND`, `BACKUP_INVALID` | backup restore section 5.5 | - |
| `CONFIRMATION_REQUIRED` | destructive command without `--confirm` | - |
| `ISOLATION_VIOLATION` | `configure` step 10 | - |
| `OUTPUT_EXISTS`, `OUTPUT_PATH_FORBIDDEN` | `export`, `diagnostics --out` | - |
| `BOOTSTRAP_FAILED`, `NODE_TOO_OLD`, `RUNTIME_IN_USE` | launcher section 5.1 | - |
| `HOOKS_FAILED` | hooks commands; `details.reason` in section 7.6 | - |
| `NOT_FOUND` | readers, `ingest replay --from` missing segment, completion `target_not_found` | - |
| `API_ERROR` | `ApiReader` non-2xx | - |
| `INTERNAL` | uncaught (stack with `MCS_DEBUG=1`) | 70 |

### 7.3 Server process exit codes (owner 01 4.1)

| Exit | Name | Meaning |
|---|---|---|
| 0 | `OK` | graceful shutdown (also after a missed shutdown deadline) |
| 1 | (reserved) | Windows forced termination, never used by our code |
| 10 | `CONFIG_INVALID` | config or regex invalid |
| 11 | `IDENTITY_MISMATCH` | argv / `instance.json` / `task.json` / DB identity (`db_identity_mismatch`, `db_not_mcs`) |
| 12 | `INSTANCE_LOCKED` | control-channel name taken |
| 13 | `PORT_EXHAUSTED` | no free port in base..base+`server.portScan` |
| 14 | `DB_ERROR` | other DB open failure |
| 15 | `DB_NEWER_THAN_RUNTIME` | `db_newer_than_runtime` |
| 16 | `DB_UPGRADE_REQUIRED` | `db_migration_required` |
| 17 | `WORKSPACE_INVALID` | bad argv, files, links |
| 18 | `BUILD_INVALID` | `rt/.mcs-build.json` missing or version mismatch |
| 70 | `INTERNAL` | uncaught during boot; also `MCS_TEST_INIT_CRASH` exit of `init` |

`DB_OPEN_EXIT_CODES` (03 4.5): identity 11, newer 15, older 16, every other `DbErrorCode` 14.

### 7.4 `DbErrorCode` (owner 03 4.3, `en/db/errors.ts`)

`db_busy`, `db_locked`, `db_not_mcs`, `db_identity_mismatch`, `db_corrupt`, `db_readonly`, `db_full`, `db_io`, `db_cantopen`,
`db_constraint` (+ `constraint: unique check foreignkey notnull datatype other`), `db_migration_required`, `db_newer_than_runtime`,
`migration_checksum_mismatch`, `migration_gap`, `migration_unknown`, `migration_failed`, `migration_fk_violation`, `migrations_missing`,
`backup_required`, `backup_failed`, `scope_mismatch`. SQLite mapping in 03 4.3. HTTP mapping: `db_busy` -> 503 `db_busy`, `db_full`
-> 503 `disk_full`, others -> 500 `internal_error`.

### 7.5 Ingest error codes (owner 02 4.8; stored in `ingest_errors.code`)

`SPOOL_LINE_INVALID_JSON`, `ENVELOPE_SCHEMA`, `ENVELOPE_VERSION`, `INSTANCE_MISMATCH`, `SPOOL_TORN_TAIL`, `INVALID_SESSION_ID`,
`RECORD_INVALID_JSON`, `RECORD_NOT_OBJECT`, `RECORD_SHAPE`, `LINE_TOO_LONG`, `UTF8_INVALID`, `READ_FAILED`, `SYMLINK_SKIPPED`,
`PATH_OUTSIDE_ROOT`, `IDENTITY_RESET`, `PERSIST_FAILED`, `EXTERNAL_READ_FAILED`; plus `SPOOL_SEGMENT_NOT_FOUND` (replay, 02 2.7;
CLI maps to `NOT_FOUND`). `ROUTE_INVALID` doubles as a handler-log code.

### 7.6 Other code sets

| Set | Codes | Owner | Code path |
|---|---|---|---|
| Hook handler log `code` | `HANDLER_UNAVAILABLE`, `STDIN_PARSE_ERROR`, `ROUTES_UNREADABLE`, `ROUTE_INVALID`, `SPOOL_WRITE_FAILED`, `SPOOL_FULL`, `UNCAUGHT` | 02 2.11 | `cl/hook/handler-log.ts` -> `$MCS_HOME/logs/hook-handler.jsonl` |
| `HOOKS_FAILED` `details.reason` | `SETTINGS_INVALID_JSON`, `SETTINGS_NOT_OBJECT`, `SETTINGS_HOOKS_NOT_OBJECT`, `SETTINGS_EVENT_NOT_ARRAY`, `SCOPE_NOT_ALLOWED`, `LOCKED`, `REAL_SETTINGS_IN_TEST`, `WRITE_VALIDATION_FAILED`, `SETTINGS_CHANGED_CONCURRENTLY`, `RENAME_FAILED`, `POST_CHECK_FAILED` | 02 3.1 | installer |
| `HooksWarningCode` | `HOOKS_SETTINGS_NOT_IGNORED`, `HOOKS_USER_SCOPE`, `HOOKS_LIVE_RELOAD` | 02 3.1 | |
| Control channel errors | `BAD_REQUEST`, `FORBIDDEN`, `INSTANCE_MISMATCH`, `NOT_READY`, `BACKUP_FAILED` | 01 4.3 | `sh/protocol/control.ts` |
| `PyRegexErrorCode` | `SYNTAX`, `UNSUPPORTED_CONSTRUCT`, `UNSUPPORTED_FLAG`, `INEXACT_SEMANTICS`, `JS_COMPILE` | 01 2.8 | `sh/pyregex/` |
| `ChildErrorCode` | `ENOENT`, `EACCES`, `TIMEOUT`, `OUTPUT_LIMIT`, `NONZERO_EXIT`, `SPAWN_FAILED`, `QUEUE_FULL`, `ABORTED` | 06 3.6 | `en/platform/exec.ts` |
| fsx errors | `E_ATOMIC_WRITE_BUSY`, `E_ATOMIC_WRITE_IO` (`AtomicWriteError`), `E_FILE_TOO_LARGE`, `E_FILE_BUSY` (`SmallFileError`) | 06 4.3 | `en/platform/fsx.ts`; 01 maps to `WORKSPACE_INVALID` |
| Config validation (06 proposal) | `E_ATTEMPTS_TIME_FORMAT`, `E_MSYS_PATH` | 06 3.10.1, section 4.1 | not in 01's catalogue [C42] |
| Completion | `target_invalid`, `target_not_found` (`CompletionTargetError`) | 02 7.13 | `en/lifecycle/completion.ts` [C16] |
| Entry text | `REF_STALE`, `READ_FAILED`, `NOT_FOUND` | 02 5.7 | `en/ingest/transcripts/entry-text.ts` |
| Ingest health reasons | `HOOKS_FAILING`, `HOOK_GAP`, `IMPORT_LAG`, `BACKFILLING`, `SPOOL_BACKLOG`, `DB_ERROR`, `TRANSCRIPTS_NOT_FOUND`, `PROVIDER_SILENT`, `EVENT_LOOP_SLOW` | 02 8.2 | `IngestHealth.reasons[].code` |
| Alert input codes | `no_activity`, `ingest_errors_repeated`, `runtime_unavailable`, `import_lag`, `hook_gap`, `hook_failing`, `db_error`, `disk`, `token_threshold` | 02 8.3 | consumed by 03 10.1 rules |
| Alert rule ids | `inactivity`, `ingest_errors`, `runtime_unavailable`, `token_threshold`, `import_lag`, `db_disk`, `hook_gap`, `hook_failing` | 03 10.1 | `alerts.rule_kind` |
| Doctor check names | `node >= 22.22`, `runtime build is current`, `config loads and validates`, `regexes translate exactly`, `transcripts folder found`, `recent transcripts parse`, `rules match at least one session`, `chain_log exists`, `ledger exists`, `instance identity is consistent`, `database integrity`, `state file is current` / `running runtime answers`, `no recent server errors`, `runtime is not outdated`, `no ownership conflict`, `hooks installed and verified for this instance`, `spool backlog below threshold`, `free disk space >= 1 GiB`, `workspace is git-ignored`, `workspace is not writable by other users`, `task <slug> audit` | 01 6.4 | `ops.diagnostics.doctor` |
| Hooks verify checks | `V1`..`V7` | 02 3.7 | `HooksVerifyResult.checks` |
| Log events named in designs | `runtime ready`, `ownership_conflict`, `state_file_restored`, `component_stop_failed`, `shutdown deadline exceeded at step N`, `audit_truncated`, `previous run ended without a clean shutdown` | 01 4.4-4.6, section 7.1 | logger `event` field |

## 8. CLI: commands, flags, exit codes, JSON envelope (owner 01 6)

Invocation `$MCS <command> [subcommand] [options]` = `node <skill>/scripts/mcs.mjs ...`. Common options: `--repo PATH` (default `.`),
`--root PATH`, `--task SLUG`, `--json`, `-h/--help`; `--config FILE` = legacy flat config (delegated to `$V`) except on `init` (seed).
Exit codes 0 / 1 / 2 (usage) / 130 (Ctrl+C). `--json` prints one `CliEnvelope` `{schema: 'mcs.cli/1', command, ok, exitCode, data,
error, warnings}` (`schemas/cli-envelope.v1.schema.json`). Destructive commands are dry runs without `--yes`; data deletion also needs
`--confirm <slug>`. Without `--task`: `start`/`serve`/`restart` use workspace `default` (created on demand).

| Command | Key flags | Default output | Engine function | Notes |
|---|---|---|---|---|
| `discover` | `--repo` | text | `ops.workspace.discover` | legacy lines + Node lines |
| `init` (alias `init-task`) | `--name`, `--slug`, `--description`, `--port`, `--config FILE` (seed), `--engine node\|legacy` | text | `ops.workspace.init` | 04 E2E also passes `--repo` |
| `inspect` | `--task` | legacy JSON | `ops.config.inspect` | `--json` adds `data.inspection` (`ConfigInspection`) |
| `configure` | `--task`, `--set KEY=JSON`..., `--unset KEY`..., `--reason`, `--decision`, `--dry-run` | legacy JSON | `ops.config.configure` | routes L/R keys; `restart_needed` |
| `decide` | `--task`, `--title`, `--decision`, `--rejected` | text | `ops.audit.recordDecision` | |
| `audit` | `--task` | legacy JSON array | `ops.audit.check` | flags any `*.jsonl` in a workspace |
| `check` | `--task` | one line | `ops.config.check` | |
| `start` | `--task`, `--port`, `--log-level`, `--open`, `--timeout-ms` | `started: <url> (pid N)` | `ops.lifecycle.start` | `--open` needs ChildKind `opener` [C11] |
| `serve` | `--task`, `--port`, `--log-level`, `--open`, `--state-file` (ignored) | foreground | `ops.lifecycle.serveForeground` | |
| `verify` | `--task` | `verified <url>: ...` | `ops.lifecycle.verify` | 5 endpoints schema-validated |
| `status` | `--task` | legacy JSON + new keys (`StatusReport`) | `ops.lifecycle.status` | exit 0 iff running |
| `stop` | `--task`, `--timeout-ms` | legacy line | `ops.lifecycle.stop` | |
| `restart` | as `start` | two lines | `ops.lifecycle.restart` | |
| `doctor` | `--task` | JSON array `{check, ok, detail, level}` | `ops.diagnostics.doctor` | names section 7.6 |
| `instances list` | `--repo`, `--no-probe` | table | `ops.instances.list` | `InstanceRow[]` |
| `instances set-engine` | `--task`, `node\|legacy`, `--yes` | text | `ops.instances.setEngine` | |
| `instances repair` | `--task`, `--yes` | text | `ops.instances.repairIdentity` | |
| `config migrate` | `--task` or `--from-legacy FILE --name N [--slug] [--description]`, `--dry-run`, `--yes` | text | `ops.config.migrate`, `ops.config.importLegacy` | |
| `upgrade` | `--task`, `--dry-run`, `--yes`, `--restart` | text | `ops.upgrade.run` | |
| `db migrate` | `--task`, `--dry-run`, `--yes` | text | `ops.upgrade.migrateDb` | npm script `migrate` |
| `db rebuild` | `--task`, `--yes`, `--confirm SLUG` | text | `ops.upgrade.rebuildDb` | 06 still calls it an open proposal [C44] |
| `ingest replay` | `--task`, `--from SEGMENT`, `--yes` | text | `ops.ingest.replay` | control op `ingest-replay` [C03], engine replay [C04] |
| `hooks install` | `--scope project-local\|user`, `--settings-file PATH`, `--task`, `--dry-run`, `--yes` (02 adds `--sync-tool-events`, `--json`) | plan/result | `ops.hooks.install` | [C23] |
| `hooks verify` | same selectors | report | `ops.hooks.verify` | V1-V7 |
| `hooks uninstall` | same + `--yes` | plan/result | `ops.hooks.uninstall` | |
| `hooks status` | `--task`, `--json` | report | missing in 01 6.3 | defined by 02 3.1 [C23] |
| `hooks enable` / `hooks disable` | `--task` | text | `ops.hooks.setEnabled` | writes `instance.json.hooks.enabled`, route file |
| `sessions list` | `--task`, `--state`, `--since`, `--limit`, `--all` | table | `InstanceReader.sessions` | |
| `sessions show` | `--task`, `--session ID`, `--events N`, `--include-text` | text | `InstanceReader.session` | |
| `errors` | `--task`, `--since`, `--limit` | lines | `InstanceReader.errors` | |
| `diagnostics` | `--task`, `--out FILE` | path | `ops.diagnostics.bundle` | `mcs.diagnostics/1`; 05 says `doctor --report` [C55] |
| `export` | `--task`, `--out FILE`, `--format`, `--since`, `--until`, `--session`..., `--include-content`, `--force` | summary | `InstanceReader.exportTo` | refuses `*.jsonl` inside a workspace |
| `backup [create]` / `backup list` / `backup restore` | `--label`; `--verify`; `--id ID --include-runtime-config --yes` | text | `ops.backup.*` | |
| `cleanup` | `--task`, `--scope stale-state\|init-leftovers\|logs\|backups\|spool\|data`, `--older-than`, `--keep`, `--dry-run`, `--yes`, `--confirm SLUG` | plan/result | `ops.cleanup.run` | `data` calls 03 `applyRetention` |
| `usage` | `--task`, `--session`, `--by session\|model\|day\|tool`, `--since`, `--until` | table | `InstanceReader.usage` | |
| `verify-completion` | `--task`, one of `--session ID` / `--label TEXT` / `--attempt PART`, `--expect completed\|failed\|terminal` | verdict | `InstanceReader.explainCompletion` | [C16] |
| `version` | `--short`, `--json` | `mcs 3.0.0 (code ..., node ..., build current)` | `ops.version` | launcher answers `--version` without a build |
| `help` | `[command]` | text | parser tables | |

Legacy delegation (01 6.5): `--config FILE` forms, `--discover`, and instances with `engine = legacy` (`start stop status verify restart
serve check doctor --task`) run `python <skill>/template/viewer.py ...` (`$V`). `InstanceInfo.commands` keys (01 6.6): `status`,
`restart`, `inspect`, `export` (`--out "<ws>/logs/export.ndjson"`), `backup`, `cleanupDryRun` (`cleanup --task <slug> --scope logs`).

Audit actions (01 7.2): `init-task`, `adopt-instance`, `configure`, `config-migrate`, `config-import`, `upgrade`, `db-migrate`,
`backup`, `backup-restore`, `cleanup`, `engine-switch`, `hooks-enable`, `hooks-disable`, `hooks-install`, `hooks-uninstall`,
`instances-repair`, `db-rebuild`, `ingest-replay` (02 2.7 uses another template [C05]), decision entries (title `configuration` for
`configure --decision`).

## 9. Files and folders

### 9.1 Instance workspace `<ws>` (owner 01 1.1)

| Path | Kind | Writer | Format / owner of format |
|---|---|---|---|
| `task.json` | file | `init` (either engine) | legacy, `TASK_SCHEMA = 1` (01 1.3) |
| `config.json` | file | `configure`, `init` | L keys, PyJson (01 1.4, section 1.9) |
| `README.md` | file | `init` | 01 1.8 |
| `instance.json` | file | `init`, adopt, upgrade, `db migrate`, `set-engine`, `hooks enable/disable`, repair | `InstanceFileSchema` |
| `runtime.json` | file (optional) | `configure`, `config migrate` | `RuntimeOverridesSchema` |
| `state.json` | file | running engine; CLI deletes stale copies | `StateFileSchema` (7 legacy keys first) |
| `run/control.token` | file | server at boot (deleted at exit) | 64 hex + LF; never copied or printed |
| `data/monitor.db` (+ `-wal`, `-shm`) | file | server only (CLI when stopped) | 03 5 |
| `data/spool/hooks-<YYYYMMDD>T<HH>Z.ndjson` | file | hook handler only (append) | `HookEnvelopeV1` per line (02 2.7) |
| `data/backups/<backupId>/` (`<UTC yyyymmddThhmmssZ>-<reason>`, `.partial` while writing) | dir | backup, upgrade, restore, db rebuild | `manifest.json` (`BackupManifestSchema`), `monitor.db` (+ `-wal`/`-shm` for `raw`), copies of the JSON files |
| `data/backups/orphaned-<UTC ts>/` | dir | `instances repair` | moved `data/` |
| `data/exports/.tmp-<random>.db` | file (temp) | export route snapshot | 03 11.1; folder absent from 01 1.1 [C39] |
| `logs/runtime.log` (+ `.1`..`.5`) | file | server logger | JSON lines, rotation 10 MiB x 5 (05 S-LOG-6) |
| `logs/boot.log` (+ `.1`) | file | OS redirection at spawn | detached server stdout/stderr |
| `logs/diagnostics-<UTC ts>.json` | file | `diagnostics` | `DiagnosticsBundle` |
| `logs/export.ndjson` | file (suggested) | `export` | `mcs.export/1` |
| `audit/changes.md`, `audit/decisions.md` | file | both engines (append) | legacy byte format (01 7.1) |
| `*.<pid>.<rand8>.tmp` | file (temp) | `atomicWriteFile` | removed by `cleanup --scope stale-state` after 10 min |
| `<tasks root>/.init-<slug>-<pid>-<rand8>/` | dir (temp) | `init` staging | removed by `init` step 3 or `cleanup --scope init-leftovers` |
| runtime-mutable set | rule | - | `state.json`, `run/**`, `data/**`, `logs/**`, `*.tmp` (excluded from isolation snapshots) |

### 9.2 Per-user folder `$MCS_HOME` (owner 02 2.6.1 for its subfolders, 01 for the rest)

| Path | Writer | Reader |
|---|---|---|
| `routes/<instanceId>.json` (`HookRouteV1`) | server start/stop, `mcs stop`, `configure`, `hooks enable/disable`, `set-engine`, repair | hook handler |
| `logs/hook-handler.jsonl` (+ `hook-handler.1.jsonl` at 1 MiB) | hook handler | `hooks status`, `doctor`, server health task |
| `hooks/installs.json` | installer | `hooks status`, health `hooks.installed` |
| `backups/settings/<sha8(path)>/<UTC>-<op>.json` + `index.jsonl` (20 kept) | installer | humans |
| `locks/mutex/<name>.lock` | macOS/other POSIX mutex fallback (01 4.2) | mutex |

Default location: `MCS_HOME` if absolute; Windows `%LOCALAPPDATA%/mcs`; else `${XDG_STATE_HOME:-~/.local/state}/mcs`.

### 9.3 Skill and runtime files

| Path | Owner | Notes |
|---|---|---|
| `<skill>/SKILL.md` | 01 Appendix A (lead installs in Phase 6) | |
| `<skill>/scripts/mcs.mjs` | 01 5.1 | launcher; zero-dependency copies of the mutex, runtime listing and spawn |
| `<skill>/scripts/mcs-hook.mjs` | 02 2.1 | hook stub (`HOOK_ENTRY_PATH`) |
| `<skill>/config/defaults.json` | legacy (read-only) | L defaults |
| `rt/defaults.json` | 01 2.1 | ships `{"schema_version": 1}` |
| `rt/.mcs-build.json` | 05 3.3.1 | `{schemaVersion, runtimeVersion, buildStamp, codeStamp, node, builtAt}`; gitignored |
| `rt/node_modules/.mcs-install.json` | 05 3.3.1 | `{schemaVersion, installStamp, installedAt}` |
| `rt/.mcs-bootstrap.log` | 01 5.1 | npm output of the bootstrap; gitignored |
| `rt/packages/*/dist/` | 05 2.3 | gitignored |
| `rt/packages/cli/dist/main.js`, `rt/packages/cli/dist/hook.js` | 05 2.2 | CLI and handler entries by path |
| `rt/packages/server/dist/main.js` | 01 4.1 | runtime marker path `/packages/server/dist/main.js` |
| `rt/packages/web/dist/` (`index.html`, `theme-init.js`, `assets/*-[hash].*`, `.vite/manifest.json`, `build-report.json`) | 04 12 | loaded in memory by the server |
| `rt/packages/engine/migrations/*.sql` | 03 4.1 | shipped next to `dist/` |
| `<skill>/schemas/{config,runtime,instance,state,backup-manifest,cli-envelope,diagnostics}.v1.schema.json`, `schemas/api/<routeId>.{params,query,body,response}.schema.json`, `schemas/api/stream.schema.json`, `schemas/export/<type>.schema.json` | 01 2.9, 03 13 | `$id` prefix `https://monitoring-claude-sessions.local/schemas/` |
| `<skill>/docs/api/reference.md` | 03 13 | generated |
| `tests/legacy-parity/{README.md,tools/*.py,golden/**}` | 06 5.2.1 | goldens committed by the lead |
| `tests/legacy-parity/pyjson/`, `tests/legacy-parity/regex/` (`gen_*_golden.py`, `regex-golden.json`, `regex-rejects.json`) | 01 1.9, section 2.8 | |
| `rt/tests/{isolation,resilience,security,parity,tooling}/` | 05 4.3 | |
| `rt/bench/**`, `rt/bench/results/` | 06 8.3 | results gitignored |
| `rt/ci/github-actions-ci.yml` | 05 8.2 | inactive |
| `rt/scripts/check-text.allow` | 05 S-LOG-5 | |
| control channel address | 01 4.3 | Windows `\\.\pipe\mcs-<instanceId>`; Linux abstract `\0mcs-<instanceId>`; other POSIX `<tmpdir>/mcs-<uid>/<instanceId>.sock` |
| mutex names | 01 4.2 | `'mcs-<kind>-' + sha256(key).slice(0,16)`; Windows pipe `\\.\pipe\<name>`; kinds `task bootstrap settings` |
| Claude Code inputs (read-only) | 02 5.1, section 7.10 | `<claudeHome>/projects/<proj>/*.jsonl`, `<sid>/subagents/**/agent-<id>.jsonl` (+ `.meta.json`), `<sid>/subagents/workflows/<runId>/journal.jsonl`, `<sid>/workflows/<runId>.json`, `<sid>/custom-title.json`, `<claudeHome>/sessions/*.json` (never `*.key`), `<claudeHome>/jobs/<id>/state.json` |
| settings files (installer) | 02 3.2 | `<repoRoot>/.claude/settings.local.json` (project-local), `${CLAUDE_CONFIG_DIR or ~/.claude}/settings.json` (user); `.claude/settings.json` refused |
| web storage keys | 04 9 | `mcs.ui.v3` (written), `ccm.prefs.v1` (read once, never written) |

## 10. Constants and limits (with units)

### 10.1 Hook handler and spool (02 2.3.1)

| Constant | Value | Unit |
|---|---|---|
| `HANDLER_HARD_EXIT_MS` | 1200 | ms |
| `STDIN_MAX_BYTES` | 8 Mi | bytes |
| `ENVELOPE_MAX_BYTES` | 16 Ki | bytes |
| `SPOOL_SEGMENT_SOFT_CAP` / `SPOOL_SEGMENT_HARD_CAP` | 64 Mi / 256 Mi | bytes |
| `NUDGE_TIMEOUT_MS` | 300 | ms |
| `SUMMARY_MAX_CP` / `TITLE_MAX_CP` | 160 / 80 | code points |
| `PATH_MAX_CHARS` / `ID_MAX_CHARS` / `NAME_MAX_CHARS` | 1024 / 128 / 64 | chars |
| `ROUTES_MAX_FILES` / `ROUTE_FILE_MAX_BYTES` | 64 / 16 Ki | files / bytes |
| hook `timeout` in settings | 5 (SessionEnd 2) | s |
| nudge body max | 256 | bytes |
| handler log rotation | 1 | MiB |
| `redact` input clip | 4096 | code points |
| minimal envelope `calls` cap | 16 | entries |

### 10.2 Ingestion, tokens, lifecycle (02)

| Constant | Value | Unit | Defined in |
|---|---|---|---|
| `MAX_LINE_BYTES` | 64 Mi | bytes | 02 1.1 |
| writer batch | 500 items or 8 | items / ms | 02 4.6 |
| writer retry backoff | 100, 200, 400 ... max 5000 | ms | 02 4.6 |
| facts LRU | 2000 | entities | 02 4.6 |
| sweeper per tick | 200 | rows per entity type | 02 7.8 |
| read chunk | 1 Mi | bytes | 02 5.3 |
| head scan | 401 lines or `import.headMaxBytes` | lines / bytes | 02 5.5 |
| classification limits | 25 texts, lines 0..400 (first text 0..120), unmatched label 70 cp, `{0}` 40 cp | | 02 5.2 |
| identity head | 256 | bytes | 02 5.3 |
| D-3 content window | 2000 | ms | 02 4.4 |
| `ingest_errors` kept | 1000 | rows | 02 4.1 |
| coverage lag tolerances | 10 s (async lag), 5 s before SessionEnd | s | 02 8.1 |
| health computation | every 5 s, <= 1 change/s | s | 02 8.2 |
| `readEntryText` clips | text 6000, tool input 4000, think 1500, summary 160 | code points | 02 5.7, 03 7.1 |
| `renderEvidence` output | 120 | code points | 02 7.1.1 |
| `LifecycleView.evidence` | <= 8 | items | 02 7.1 |
| workflow status file read cap | 8 Mi | bytes | 02 5.1.2 |
| agent `.meta.json` cap | 64 Ki | bytes | 02 5.1.2 |

### 10.3 Server, API, DB, realtime (03, 05)

| Constant | Value | Unit | Defined in |
|---|---|---|---|
| `headersTimeout` / `requestTimeout` / `keepAliveTimeout` | 10000 / `server.requestTimeoutMs` (30000) / 5000 | ms | 03 5.1, 05 S-NET-6 |
| `maxHeadersCount` / `maxConnections` | 64 / 128 | | same |
| URL max | 8192 | chars | 03 5.2 |
| JSON body limit | 64 Ki (nudge 256) | bytes | 05 S-NET-6 |
| page `limit` | default 50 (lists) / 100 (events), max 200; `afterId` 500; agents 500 | rows | 03 5.3 |
| `includeTotal` cap | 10000 | rows | 03 5.3 |
| event `q` scan cap / window | 50000 rows / 7 days | | 03 3.7 rule 2 |
| searches / exports concurrent | 2 / 1 | per instance | 03 6.4 |
| search `budgetMs` | default 3000, max 10000 | ms | 03 7.4 |
| transcript window read budget | 8 Mi | bytes | 03 7.3 |
| checkpoint spacing | 256 | entries | 03 7.2 |
| SSE streams / stall eviction / heartbeat / retry | 16 / 30 s / 15000 ms / 3000 ms | | 03 9.2 |
| replay window | 2000 | changes | 03 9.2 |
| frame cap / event items per frame / frame LRU | 64 KB / 50 / 512 | | 03 9.2 |
| server error ring | 20 entries, message 200 chars | | 01 4.4a, 03 5.2 |
| DB retry on WAL init | 20 x 25 | ms | 03 3.2 |
| DB busy timeout | 5000 | ms | 03 3.2 |
| statement cache | LRU 200 | statements | 03 4.5 |
| retention batch / session delete batch | 5000 rows / 10 sessions | | 03 3.7-3.8 |
| `db_disk` alert default | 2048 MB DB, 500 MB free | MB | 03 10.1 |
| control channel request / timeouts | 4096 bytes; idle 2 s; client 2 s (backup 10 min, replay 30 s) | | 01 4.3 |
| CLI health probe | 2 s (start), 5 s (verify), 300 ms / 1 s (instances list) | | 01 4.7-4.10, section 6.4 |
| legacy health probe | 3 s | | 01 4.8 |
| `staleness()` re-read for `outdated` | every 10 s max | | 01 5.3 |
| init staging cleanup age | 10 | min | 01 4.12 |
| folder rename retry | 2 | s | 01 4.12 |
| atomic write budget | 3000, backoff `min(50*2^k, 250)` | ms | 06 4.3 |
| reader retry | 10 x 20 | ms | 01 1.2, 06 4.3 |
| log rotation | `LOG_ROTATE_BYTES` 10 MiB, `LOG_KEEP` 5, `LOG_ROTATE_RETRY_BUDGET_MS` 3000, pause 60 s | | 05 S-LOG-6 |
| bootstrap mutex timeout | 15 | min | 01 5.1 |
| Node floor | 22.22.0 (engines `^22.22.0 \|\| ^24.0.0 \|\| >=26.0.0`) | | 01 5.1, 05 2.5 (stale "22.12" in 05/06 [C28]) |

### 10.4 Panels, platform, UI

| Constant | Value | Defined in |
|---|---|---|
| panel TTLs | memory/cpu 1800 ms; processes `machineProcessIntervalMs` (20000); docker 15000; git.status 15000; git.log on HEAD change or 120000; stopFile 2000; ledger/chainLog 5000; logs 2000; attempts read 2000 (ms) | 06 3.5 |
| child semaphore | 2 running, FIFO 8, then `QUEUE_FULL` | 06 3.6 |
| child defaults | timeout 10 s (CIM 20 s), output cap 1 MiB | 05 S-PROC-5 |
| `resolveExecutable` cache | 10 min (null 5 min) | 06 3.6 |
| `commandLineOf` cache | 5 s per pid, 64 entries | 06 4.2 |
| attempts read slice | 8 MiB per tick, `maxLineBytes` 1 MiB, ticks every 2 s | 06 3.10.3, section 3.4 |
| matching window | -15..600 s, `attemptsWindowHours` 24 | 06 3.10.6 |
| logs panel | 4 files, tails for 2, 16 lines, 220 cp; glob 500 matches, depth 8 | 06 3.9 |
| ledger/chain tails | 30 lines starting with `\|` / 10 lines; read `max(64 KiB, n*400)` | 06 3.9 |
| UI buffers | stream queue 1000, live head 500, paused buffer 500, transcript window 5000 (`MAX_TRANSCRIPT_EVENTS`), `maxPages` 10 (timeline 20), `LAZY_AGENT_THRESHOLD` 30, `AGENT_PAGE` 100 | 04 2 UI-I7, section 4.4 |
| UI timings | API timeout 8000 ms, backoff 2-30 s, watchdog 2.5 x `heartbeatMs`, `staleAfterMs` from `poll.stale_after_ms` (15000) | 04 5.1-5.6 |
| bundle budget | initial JS 200 kB gz, all JS 260 kB gz, CSS 25 kB gz | 04 12.3 |
| benchmark budgets | B1-B7 | 06 8.1 |

## 11. Lifecycle vocabulary, events and legacy mapping (owner 02 7 unless noted)

### 11.1 States and axes (02 7.1; DB CHECKs 03 3.5; UI display 04 6.1)

| Name | Values | Legacy 5-state (`toLegacy`, 02 7.9) | UI label / tone (04 6.1) |
|---|---|---|---|
| `LifecycleState` | `running`, `working`, `waiting_input`, `waiting_tool`, `waiting_agent`, `turn_ended`, `completed`, `failed`, `stale`, `unknown` | `running working waiting_agent waiting_tool` -> `RUNNING`; `waiting_input turn_ended` -> `IDLE`; `completed` -> `COMPLETED`; `failed` -> `FAILED`; `stale unknown` -> `UNKNOWN` | "Running", "Working", "Waiting for input", "Waiting for tool", "Waiting for subagent", "Turn ended", "Completed", "Failed", "Stale", "Unknown" |
| `Presence` | `open ended unknown` | - | - |
| `WaitReason` | `user permission elicitation agent_input idle_prompt` | - | - |
| `StaleKind` | `silent abandoned process_gone parent_ended` | - | - |
| `Basis` / `Confidence` | `observed inferred` / `high medium low` | - | inferred: dashed badge |
| `turnOutcome` | `ok error interrupted` | - | - |
| `EvidenceSource` | `hook transcript registry job attempts pid workflow_file journal meta clock` | `state_source` (06 5.4): `attempts` -> `external`, `registry` -> `registry`, else `transcript`; new `hook` | - |
| `EvidenceFact` | `session_end session_start stop stop_failure end_turn interrupt prompt tool_open permission_request notification registry_status job_state attempt_row pid_dead pid_alive file_written child_active background_pending agent_notification agent_stop agent_final agent_link workflow_status quiet no_records api_error activity_after_end parent_ended` | - | templates 02 7.1.1 |
| engine evidence item | `{source, fact, at, count?, value?}` | - | named `EvidenceItem` in 02 [C18] |
| `ProbeState` (process, owner 01 4.8) | `running starting stopping unhealthy stopped stale foreign-pid legacy-running legacy-stale` | `status` JSON `probe` | - |
| `ControlPhase` (owner 01 4.3) | `starting ready stopping` | - | - |
| Board states | `working waiting completed failed stale unknown` | - | columns of `/tasks` |
| Agent kinds | 03: `main subagent workflow_agent teammate internal`; 02: `subagent workflow_agent internal` [C56] | - | `internal` hidden by default |

### 11.2 Decision rules (ids used by `state_rule`, `ruleId`, `TransitionItem.rule`)

Session rules S-1, S-2, S-3a, S-3b, S-4a, S-4b, S-5, S-6a, S-6b, S-6c, S-7a..S-7f, S-8a..S-8f, S-9a..S-9c, S-10 (02 7.4); agent rules
A-1..A-10 (02 7.5); workflow rules W-1..W-7 (02 7.6); completion rules `C-ATT-ENDED`, `C-ATT-OPEN`, `C-ATT-SUPERSEDED` (02 7.13);
board rules `W-DECL`, `W-ATT`, `W-LBL` (02 7.11; note: `W-*` prefix used by both workflow and board rules). Transition table rows
N1-N16, F1-F6, D1-D5, M1-M7, L1-L4, O1-O6, C1-C3 (02 7.7). Property tests P1-P9 (02 7.12). Thresholds: section 6.2 `lifecycle.*`.

### 11.3 Logical events (`LogicalEvent.k`, 02 4.3)

`session.seen`, `session.start`, `session.end`, `turn.prompt`, `turn.end` (kinds `stop stop_failure end_turn turn_duration`),
`tool.start`, `tool.end` (`ToolOutcome` `ok error denied interrupted`; display-only `closed_by_batch`, `closed_by_turn_end`),
`tool.batch`, `permission.request`, `notification`, `agent.start`, `agent.stop`, `agent.link`, `agent.final` (`tool_ends_turn`,
`structured_output`), `agent.notification` (`completed failed killed stopped`), `agent.meta`, `workflow.launch`, `workflow.status`,
`activity` (`hook assistant user tool_result system`), `interrupt` (`user_marker aborted_mid_stream`), `api_error`, `assistant.ok`,
`compaction`, `title` (`ai custom agent_name`), `session.continued_in`, `session.copied_from`, `cost_state`, `hook.handler_error`,
`external.registry` (`busy idle waiting`), `external.job`, `external.attempt` (needs `endedAt` + `observedAt` [C41]),
`external.attempt_cleared`, `external.pid`, `info` (`task_created task_completed teammate_idle model_switch cwd_changed queued_command
away_summary local_command`). Producers outside 02: 06 `PanelService.tickAttempts` (`external.attempt*`).

### 11.4 Stored event kinds (`events.kind`, owner 03 3.6 / section 5.5, mapped by 02 4.3, section 5.6)

| Kind | Source mapping | Severity |
|---|---|---|
| `session.start`, `session.end` | SessionStart / SessionEnd | 0 |
| `prompt.submit` | UserPromptSubmit / user prompt record | 0 |
| `prompt.queued` | `queued_command` attachment | 0 |
| `assistant.message`, `assistant.thinking` | assistant text / thinking block | 0 |
| `tool.call`, `tool.result`, `tool.failure`, `tool.batch` | Pre/PostToolUse, `tool_use`/`tool_result`, PostToolBatch | failure 2 |
| `permission.request`, `permission.denied` | PermissionRequest / PermissionDenied | denied 1 |
| `notification.sent` | Notification | 0 |
| `agent.start`, `agent.stop`, `agent.final`, `agent.notification` | SubagentStart/Stop, `structured_output`, task-notification | 0 |
| `turn.stop`, `turn.failure`, `turn.duration`, `turn.interrupt` | Stop / StopFailure / `turn_duration` / interrupt marker | failure 2, interrupt 1 |
| `api.error` | API error record | 2 |
| `context.compact` | Pre/PostCompact, `compact_boundary` | 0 |
| `model.switch`, `cwd.change`, `task.created`, `task.completed`, `teammate.idle` | hooks | 0 |
| `system.info` | other stored system/attachment entries | 0 |
| `hook.handler_error` | own `hook_non_blocking_error` attachment | 2 |
| `hook.unknown` | non-installed hook name | 1 |
| `monitor.gap`, `monitor.reconcile` | reconciliations (`runtime_unavailable`, `hook_gap` / others) | 1 |

`entry_kind` values: `prompt say think tool result system attachment`. `events.sources` bits: 1 hook, 2 transcript, 4 monitor.

### 11.5 Hook events (installed set, 02 2.4, A0013)

21 installed (order = `INSTALLED_HOOK_EVENTS`): SessionStart, UserPromptSubmit, PreToolUse*, PermissionRequest, PermissionDenied,
PostToolUse*, PostToolUseFailure*, PostToolBatch*, Notification, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop,
StopFailure, TeammateIdle, PreCompact, PostCompact, PostModelSwitch, CwdChanged, SessionEnd (* = `ASYNC_HOOK_EVENTS`). Never installed:
WorktreeCreate, WorktreeRemove, MessageDisplay, PreModelSwitch, Elicitation, ElicitationResult, FileChanged, Setup, ConfigChange,
InstructionsLoaded, UserPromptExpansion, DirectoryAdded. `HOOK_EVENT_RANK`: SessionStart 0, UserPromptSubmit 10, PreToolUse 20,
PermissionRequest 22, PermissionDenied 24, PostToolUse 30, PostToolUseFailure 30, PostToolBatch 34, SubagentStart 40, SubagentStop 44,
TaskCreated 46, TaskCompleted 47, Notification 50, PreCompact 52, PostCompact 53, PostModelSwitch 54, CwdChanged 55, TeammateIdle 56,
Stop 60, StopFailure 60, SessionEnd 90, unknown 70; transcript ranks user prompt 10, assistant 20, tool_result 30, attachment 50,
compact_boundary 52, system other 58, turn_duration 61. Probe: `session_id` prefix `00000000-0000-4000-8000-`, Notification type
`mcs_probe`. Ownership marker: argument `--mcs-hook`.

### 11.6 Reconciliation kinds and coverage (02 8.1, DB CHECK 03 3.5)

`activity_after_end`, `hook_gap`, `runtime_unavailable`, `identity_reset`, `copied_records`, `handler_failing`. Hook coverage
`none full partial`. Ingest health block statuses: provider `active quiet silent none`; hooks `ok not_installed idle gap failing`;
transcripts `ok backfilling lagging errors not_found`; persisted `ok backlog failing db_error`; overall `ok degraded down`.
`HealthReport.ingestion.status` adds `stalled disabled unknown` (02 8.2 projection; `disabled` never produced).

### 11.7 Legacy mapping summary

| Legacy item | Node source | Defined in |
|---|---|---|
| 5 states `RUNNING IDLE COMPLETED FAILED UNKNOWN` | `toLegacy(view)`; `classifyLegacy` for sessions without hooks | 02 7.9 |
| `done` (v1) | `legacyDone` | 02 7.9 |
| `usage`, `usage_total` | `legacyFileUsage`, `legacyUsageTotal` | 02 6.5 |
| `external_state` table | `externalState(exitRaw, statusRaw)` | 06 3.10.5 |
| `state.json` 7 keys | `StateFileSchema` first 7 keys | 01 1.7 |
| `/api/health` | `LegacyHealth` | 03 6.2 |
| `inspect` provenance `default\|task` | `builtin\|skill` / `config` | 01 2.5, 06 5.4 |
| `ccm.prefs.v1` | read once into `mcs.ui.v3` | 04 9 |
| `#sid=&agent=` links | `LegacyHashRedirect` -> `/sessions/<sid>?tab=transcript` | 04 3.3 |
| latent defects | D1-D35 (06 5.8) = PD1-PD7 (05 4.11.5) | 06 5.8, A0055 |

## 12. Test helpers, testkit exports, fixtures, test ids

### 12.1 `@mcs/testkit` (owner 05 4.4 core, 06 6 additions, 04 11.5 demo contract)

| Name | Kind | Signature / notes | Module | Owner |
|---|---|---|---|---|
| `TempDir`, `makeTempDir`, `useTempDirs` | type, fn | `makeTempDir(purpose)` writes `FIXTURE.md` | `tk/temp.ts` | 05 |
| `PortRange`, `VITEST_PORTS`, `allocatePort`, `assertPortClosed` | type, const, fn | `allocatePort(range?)`; 01/04 call `findFreePort` [C32] | `tk/ports.ts` | 05 |
| `waitFor`, `eventLoopLagProbe` | fn | default 5000 ms / 25 ms | `tk/wait.ts` | 05 |
| `FakeClock`, `FIXTURE_EPOCH_MS` | class, const | implements `Clock`; `Date.UTC(2026, 0, 1)` | `tk/clock.ts` | 05 |
| `TrackedProcess`, `spawnTracked`, `killAllTracked`, `runCli` | type, fn | `runCli(args, {mcsHome, cwd?, env?})` runs `packages/cli/dist/main.js` with `MCS_HOOK_DISABLE=1` | `tk/processes.ts` | 05 |
| `httpRequest`, `readSse` | fn | `agent: false` | `tk/http.ts` | 05 |
| `UsageFixture`, `TranscriptBuilder`, `bigTranscript` | type, class, fn | builder methods `user assistant toolUse toolResult turnEnd interrupt apiError compact bookkeeping agentLaunch raw invalidLine lines write appendTo`; 06 requests `assistant({outputPerRecord, zeroTopLevel, booleanUsageField, final})`, `taskNotification` | `tk/transcript.ts` | 05 (+06 6.2) |
| `SessionSpec`, `ClaudeHome`, `buildClaudeHome` | type, fn | `keyDecoys` writes `sessions/<pid>.key` | `tk/claude-home.ts` | 05 |
| `HookEventName`, `hookPayload`, `RunHookOptions`, `runHookHandler` | type, fn | `runHookHandler(payload, {mcsHome, event?, async?, direct?, env?, rawStdin?})` spawns the stub (or `dist/hook.js` with `direct`) | `tk/hooks.ts` | 05 |
| `buildRepo`, `buildTaskWorkspace`, `snapshotTree` | fn | `buildTaskWorkspace(repo, {slug, config, runtime?, instance?})` | `tk/workspace.ts` | 05 |
| `DemoLetter`, `DemoOptions`, `DemoSession`, `DemoResult`, `buildDemo` | type, fn | letters `A..H`; options `{root, nowMs, letters?, project?}` (05 writes `now` [C34]) | `tk/demo.ts` | 04 (contract), 05 (host) |
| `CANARY`, `scanForCanaries` | const, fn | `prompt toolResult thinking key envToken attachment query` | `tk/canary.ts` | 05 |
| `pyDumps`, `pyIso`, `detUuidSequence` | fn | Python `json.dumps` compatible | `tk/pyjson.ts` | 06 |
| `setAge`, `freezeUntouched`, `appendWithOpenHandle`, `treeManifest`, `ManifestRow` | fn, type | | `tk/io.ts` | 06 |
| `UsageTotals`, `SessionExpectation`, `ScenarioExpectation` | type | `LegacyState` redeclared [C36] | `tk/expect.ts` | 06 |
| `buildBigTranscript` | fn | 70 MB = 62,735 lines | `tk/big.ts` | 06 |
| `ScenarioId`, `ScenarioSession`, `ScenarioResult`, `buildScenario`, `listScenarios` | type, fn | L-FIX L-DEMO L-PANELS L-RULES L-REGISTRY S01-S34 (+S06b) | `tk/scenarios/index.ts` | 06 |
| `buildLegacyFixtureHome`, `buildLegacyDemo`, `buildPanelsTree`, `buildRulesTree`, `buildRegistryHome` | fn | `@mcs/testkit/legacy` subpath (not exported by 05 2.2 [C46]) | `tk/legacy/*`, `legacy/ORDER.md` | 06 |
| testkit CLI | entry | `node rt/packages/testkit/dist/cli.js list \| demo \| scenario \| big` | `tk/cli.ts` | 06 6.4 |
| helpers named only in 01 3.5 | fn | `tempRoot()`, `hermeticEnv()`, `makeWorkspace()`, `startInstance()`, `snapshotWorkspace()`, `spawnImpostor()`, `makeJunction()`, `listRuntimeProcesses` | not in 05 4.4 [C33] | 01 asks, 05 owns |

### 12.2 Other test helpers and harness modules

| Name | Owner | Code path |
|---|---|---|
| `FakeEventSource`, `renderWithProviders`, `createFakeApi`, fixture factories `makeSession makeAgent makeEvent makeTranscript makeHealth` | 04 11 | `wb/test/{fake-event-source,render,fake-api}.ts(x)`, `wb/test/fixtures/*.ts` (header `// FIXTURE: invented data for tests`) |
| `SessionProjection`, `EventsProjection`, `SearchProjection`, `AttemptsProjection`, `ConfigRegexProjection`, `WorkspaceFilesProjection`, `Mismatch`, `compareProjection` | 05 4.11.3 | `rt/tests/parity/projections.ts` |
| `FROZEN_NOW_S` (1790000000), `NormalizeContext`, `normalizeText`, `normalizeValue`, `goldenDir`, `readGoldenApi` | 05 4.11.3 | `rt/tests/parity/normalize.ts` |
| `PythonInfo`, `findPython`, `runCapture` | 05 4.11.4 | `rt/tests/parity/run-python.ts` |
| `referenceUsage`, `runVectorFile`, legacy shapes | 06 5.4-5.5, PP4 | `rt/tests/parity/{reference-usage,vectors,legacy-shapes}.ts` |
| golden generator | 06 5.2 | `tests/legacy-parity/tools/{capture_golden,determinism,vectors,panel_scenarios}.py`; vectors `golden/vectors/*.json` |
| engine fixture builders | 02 9.1 | `rt/packages/engine/test/fixtures/{transcripts,hooks,hook-sequences,spool,external}.ts`, `rt/packages/cli/test/fixtures/settings/*.json` |
| seeded PRNG | 02 7.12 | `rt/packages/engine/test/support/prng.ts` (mulberry32) |
| `lint-rules`, `check-deps`, `build-stamp`, `ci-script`, `parity-capture`, `env-vars` tests | 05 4.3 | `rt/tests/tooling/*.test.ts` |

### 12.3 Test id prefixes (one id space per prefix)

| Prefix | Owner | Range |
|---|---|---|
| `T-ISO-`, `T-XE-`, `T-UP-`, `T-CLI-`, `T-AU-`, `T-SEC-`, `T-LC-` (process lifecycle) | 01 | T-ISO-01..27, T-XE-01..07, T-UP-01..10, T-CLI-01..13, T-AU-01..06, T-SEC-01..05, T-LC-01..16 |
| `T-HK-`, `T-IN-`, `T-PL-`, `T-TR-`, `T-TK-`, `T-HE-`, `T-LC-` (lifecycle model), `P1-P9`, `CE-1..17` | 02 | T-LC-01..57 collides with 01 [C37] |
| `DA-T-DB-`, `DA-T-PRIV-`, `DA-T-API-`, `DA-T-RT-`, `DA-T-S-`, `DA-T-A-`, `DA-T-AL-`, `DA-T-E-`, `DA-T-CLI-`, invariants `DA-I1..13` | 03 | |
| `UI-I1..14`, `legacy:` test titles (36) | 04 | |
| `ISO-1..9`, `SEC-01..31`, `PD1..PD7`, `S-NET`, `S-ING`, `S-FS`, `S-OUT`, `S-PROC`, `S-LOG`, `S-SEC`, `S-DEP` | 05 | |
| `E-n` experiments (per document), `D1..D35`, `G1..G10`, `B1..B7`, `R01..R33`, `T1..T7` (token rules), `T1..T23` (troubleshooting) | 06 | `T1`..`T7` and `T1`..`T23` share a prefix inside 06 (note N12) |
| `INV-01..12`, `C-1..C-6` | 01 | |
| Requirement ids `R-<section>.<tag>.<n>`, issues `I-01..I-37` | 99 | |

## 13. npm scripts and root commands (owner 05 3.1, A.1)

| Script (`cd runtime && npm run <name>`) | Command | Status |
|---|---|---|
| `clean` | `node scripts/clean.mjs` | A.1 |
| `build` | `clean && tsc -b tsconfig.build.json && npm run build -w @mcs/web && node scripts/build-stamp.mjs write` | A.1 |
| `typecheck` | `node scripts/typecheck.mjs` (8 projects) | A.1 |
| `lint`, `lint:fix` | `eslint . --max-warnings 0`, `eslint . --fix` | A.1 |
| `format`, `format:check` | `prettier --write .`, `prettier --check .` | A.1 |
| `check:deps` | `node scripts/check-deps.mjs` | A.1 |
| `check:text`, `check:docs` | `node scripts/check-text.mjs`, `node scripts/check-docs.mjs` | added by S9/S10 |
| `test` | `vitest run --project unit --project web --project integration --project isolation --project resilience [--project security]` | A.1 (security added by S8) |
| `test:unit`, `test:int`, `test:isolation`, `test:resilience`, `test:security`, `test:parity`, `test:tooling` | `vitest run --project <x>` (`test:unit` also runs `web`) | partly added by slices |
| `test:coverage` | `vitest run --coverage --project unit --project web --project integration` | A.1 |
| `test:stress` | `node scripts/stress.mjs` | S9 |
| `test:e2e` | `playwright test -c packages/web/e2e/playwright.config.ts` | A.1 |
| `dev` | `node scripts/dev.mjs [--api-port 18765 --web-port 18766] [-- <server args>]` | A.1 |
| `start`, `migrate`, `health`, `init-instance` | `node packages/cli/dist/main.js start` / `db migrate` / `verify` / `init` | A.1 |
| `audit`, `audit:prod` | `npm audit --audit-level=low` (`--omit=dev`) | A.1 |
| `ci`, `ci:full` | `node scripts/ci.mjs [--offline] [--keep-going]`, `--full` | A.1 |
| `release-check` | `node scripts/release-check.mjs --out <file>` | S9 |
| `parity:capture`, `parity:check` | `node scripts/parity-capture.mjs [--check]` | S8 |
| `schemas`, `schemas:check` | 01 2.9 `scripts/gen-schemas.mjs`; 03 13 `scripts/gen-api-schemas.mjs` | missing from 05 3.1 [C45] |
| `parity:shadow` | `node scripts/parity-shadow.mjs` | 06 5.6, missing from 05 [C45] |
| `bench` | runs `rt/bench/*.mjs` | 06 8.3, missing from 05 [C45] |
| `testkit` | `node packages/testkit/dist/cli.js` | 06 6.4, missing from 05 [C45] |
| web package scripts (`-w @mcs/web`) | `dev` (`vite`), `build` (`vite build && node scripts/check-bundle-budget.mjs`), `preview`, `typecheck`, `test` (`vitest run --project web`), `test:e2e` | 04 12.4 |
| other repo scripts | `scripts/lib.mjs`, `smoke.mjs`, `set-version.mjs <semver>`, `build-stamp.mjs check\|write\|write-install` | 05 3.2 |

Legacy commands that stay: `python <skill>/template/viewer.py <command>` (`$V`), `python -m unittest discover -s tests`,
`node --test "tests/frontend/*.test.mjs"` (05 7.1 step 8).

## 14. Ports and URLs

| Port / URL | User | Owner | Notes |
|---|---|---|---|
| 8765 (+19 scan) | default base port (`config.json` `port`) | 01 4.11 | never used by tests or experiments (live legacy monitor) |
| 3000, 3100, 8080, 8089 | forbidden | foundations section 5 | owner's other services |
| 18000-18499 | Vitest real-process tests (`VITEST_PORTS`, blocks of 50 per worker) | 05 4.5 | 01 3.5 uses it via `findFreePort` [C32]; 02 9.4 says "18000-18999" for its tests (note N13) |
| 18500-18599 | Playwright E2E (04 uses 18510, 18511) | 05 4.5, 04 11.4 | `MCS_E2E_PORT` default 18900 contradicts [C31] |
| 18760-18769 | `npm run dev` (API 18765, web 18766, preview 18767) | 05 4.5, 04 12.2 | |
| 18800-18849 | `scripts/smoke.mjs` | 05 4.5, A0043 | 05 3.2 and A.37 say 18800-18899 [C54] |
| 18850-18874 | legacy Python server in golden capture (`--port-base` 18850-18855) | 06 5.2.2, 05 4.11.4 | |
| 18875-18899 | Node server in parity harness | 06 5.4 | |
| 18900-18999 | manual experiments, testkit `demo --port` | 05 4.5, 06 6.4 | |
| 18900-18949 | benchmarks (`bench-first-import` 18900, `bench-idle` 18901, `bench-api` 18902) | 06 8.3 | |
| `http://127.0.0.1:<port>` | `state.json.url` (no trailing slash) | 01 1.7 | Host allow-list `127.0.0.1:<port>`, `localhost:<port>` |
| `http://127.0.0.1:<port>/api/v3/...` | API base | 03 5.1 | |
| `http://127.0.0.1:<port>/api/health` | legacy health | 03 6.2 | |
| `http://127.0.0.1:<port>/api/v3/stream?since=<seq>&epoch=<epoch>` | SSE | 03 9.2, 04 5.6 | |
| `http://127.0.0.1:<port>/api/v3/ingest/nudge` | hook nudge | 02 2.8 | |
| UI routes `/`, `/sessions`, `/sessions/:sessionId`, `/activity`, `/tasks`, `/analytics`, `/settings`, `/health` (redirect), `*` | SPA | 04 3.1 | `/tasks` and URL key `task` are UI-only (API: work items) |
| `https://monitoring-claude-sessions.local/schemas/<file>` | JSON Schema `$id` | 01 2.9 | |

## 15. Conflicts (divergent definitions) and the exact fixes

Owner = authoritative document per section 0.1 (or the evidence named in the row). "Fix" names the document and section to change; the owner's
text stays as is unless the fix says otherwise.

| Id | Name | Owner | Divergence | Required fix |
|---|---|---|---|---|
| C01 | `import.maxLineBytes` | 02 (I-32) | 01 1.6 table and contract-test text list the key (64 MiB, "10 `import` keys"); 02 1.2 and 03 3.3 say the cap is only the constant `MAX_LINE_BYTES` | 01 1.6: delete the `import.maxLineBytes` row and its `R_KEY_CATALOGUE` entry; change "10 `import`" to "9 `import`" in `runtime-sections.contract.test.ts` |
| C02 | R-key ranges (`spool.pollMs`, `spool.sealGraceMs`, `import.lookbackHours`, `import.headMaxBytes`, `import.tailWindowBytes`, `import.backfillMaxBytes`, `import.scanIntervalMs`, `import.discoveryIntervalMs`, `hooks.spoolWhileStoppedHours`) | 01 (schema) | 02 1.2 states other ranges; 02 2.6.2 gives `spoolWhileStoppedHours` value 0 a meaning that 01's minimum 1 forbids | 02 1.2: replace the "Type, range" column with "01 1.6"; 01 1.6: `hooks.spoolWhileStoppedHours` range 0..720 (0 = stop spooling at once) |
| C03 | control op for spool replay | 01 4.3 | 02 2.7 step 4, section 4.10 comment, section 12 X-2 say `ingest.replay {from}` | 02: use op `ingest-replay` with field `fromSegment` (reply `{segments}`) everywhere |
| C04 | spool replay engine API | 02 2.7 | 01 4.3, section 4.4a, section 6.4 (`ingest replay` step 3), Open item 3 call `replaySpool(db, scope, {fromSegment, nowMs})` and expect `{segments}` | 01: call `planSpoolReplay(ctx, repos, spoolDir, from)` then `applySpoolReplay(db, ctx, plan)` (stopped) or `IngestService.replay(from)` (running); map `segmentsReset` to the control reply `segments` |
| C05 | audit template `ingest-replay` | 01 7.2 | 02 2.7 step 5 uses Summary `spool replay from ...: <n> segments, <bytes> bytes`, Files `data/monitor.db`, Validation `cursors reset`, Outcome `applied` | 02 2.7 step 5: replace with "audit action `ingest-replay` with 01 7.2's template" (no own wording) |
| C06 | `createIngestService` / `createLifecycleSweeper` shapes | 02 4.10 | 01 4.4a table and Open item 3: `untilIdle(remaining)` returning a boolean, `createLifecycleSweeper(ctx) -> {start, stop, tick}` | 01 4.4a: `ingestUntilIdle` calls `await ingest.untilIdle({timeoutMs: remaining})` and maps `IngestIdleTimeoutError` to `idle: false`; sweeper = `createLifecycleSweeper(ctx, {writer: ingest.writer})` with `tickNow()` |
| C07 | `InstanceContext` workspace field | 01 4.4a | 02 4.10 and section 12 X-2 request `workspaceDir` | 02: read `ctx.instanceDir`; drop the X-2 request |
| C08 | maintenance scheduler factory | 03 11.4 | 01 4.4a component 3 and Open item 3 name `createMaintenanceScheduler(ctx) -> RuntimeComponent` | 01: use `createDbScheduler(ctx)` from `en/maintenance/schedule.ts`, wrapped as `{name: 'db-scheduler', start, stop: () => sched.stop()}` |
| C09 | `createQueries` deps | 03 12.1 | 01 4.4a passes `{config, now, process}` and expects health to read `process`, `childStats()`, `panels.stats()`; 03 12.1 has `{config, now, audit}` only although 03 6.2 needs those inputs | 03 12.1: deps `{config, now, audit, process?: RuntimeProcessInfo, childStats?: () => Record<ChildKind, ChildKindStats>, panelStats?: () => PanelStats}` (absent for the DbReader); 01 4.4a: pass `audit` (01 `entriesBetween` bound to the workspace) |
| C10 | child stats type name | 06 3.6 | 03 6.2, section 20 A-6, section 22 O-4 say `ChildStat` | 03: rename to `ChildKindStats` |
| C11 | `ChildKind` / executable names | 06 3.6 (A0051) | 01 4.2, section 4.7 need kind `opener` and `ExecutableName` += `python`, `icacls`, `opener`; 06 has no `opener` and resolves no `python`; no type `ExecutableName` exists | 06 3.6 + A0051: add kind `opener` and `resolveExecutable('opener')` (`explorer.exe` / `/usr/bin/open` / `xdg-open`); 01 4.2: drop `ExecutableName` and the `python` resolution request (01 6.5 passes an absolute path) |
| C12 | `forceKill` on Windows | 06 4.2 | 01 4.2 comment and A0006 say `process.kill(pid)` without a child process; 06 uses `taskkill.exe /PID n /F` via `execFileText` | 01 4.2 comment and A0006: replace `process.kill(pid)` by 06's `taskkill.exe /PID <pid> /F` through `execFileText` kind `taskkill` (exit 128 = already gone) |
| C13 | `listRuntimeProcesses` home | 01 4.2 (launcher copy parity, 01 S4) | 06 3.2, section 4.2, section 4.11, A0051 put it in `platform/process.ts` (06 PP1) | 06 3.2, section 4.2, section 4.11 row, A0051: move it to `en/platform/markers.ts` (01 S4); `process.ts` keeps `pidAlive commandLineOf forceKill waitForExit` |
| C14 | workspace writer name | 01 1.2 | 06 4.3 lists `writeFileAtomic` (and "01's synchronous signatures") | 06 4.3: `writeWorkspaceFile` (async) |
| C15 | file of `InstanceContext` | 01 4.4a | 06 3.2, section 5.4, section 10 cite `en/runtime/instance-runtime.ts` | 06: `InstanceContext` in `en/runtime/context.ts`, `createInstanceRuntime` in `en/runtime/instance-runtime.ts` |
| C16 | `explainCompletion` signature and `CompletionEvidence` fields | 02 7.13 (fields and semantics); 03 owns the schema file | 01 6.1, section 6.4, Open item 3 and 03 6.3, section 12.1, section 15.4, section 20 A-1 use `explainCompletion(queries, target)` returning `null`; 03 schema lacks `resolvedBy`, `candidates` and has `sessionId: string` | 03 6.3: `CompletionEvidenceSchema` adds `resolvedBy`, `candidates`, `sessionId: string \| null`; 03 12.1: `EngineQueries.explainCompletion` builds a `CompletionLookup` from repositories and calls `explainCompletion(lookup, target, now)`, maps `target_not_found` -> 404 `completion_target_not_found`, `target_invalid` -> 400 `validation_failed`; 01 6.4: CLI maps `target_invalid` -> `USAGE`, `target_not_found` -> `NOT_FOUND` |
| C17 | `attemptPart` length | 02 7.13 (semantics) with 03 3.5 column cap as evidence | 02: 0..128 (empty legal); 03 6.1 route: 1..512; `attempt_runs.part` <= 512 | 02 7.13 step 1: `attemptPart` 0..512; 03 6.1: `attemptPart` 0..512 (present-but-empty allowed) |
| C18 | `EvidenceItem` name | 03 5.5 (API name) | 02 7.1 uses `EvidenceItem` for the engine `{source, fact, at, count?, value?}` and `ApiEvidenceItem` for 03's type | 02 7.1, section 7.13: rename the engine type to `LifecycleEvidence`; `ApiEvidenceItem` = import of `EvidenceItem` from `sh/api/entities.ts` |
| C19 | `ErrorCode` name | 03 5.2 | 01 6.2 declares the CLI union as `ErrorCode` in `sh/errors.ts` (same package) | 01 6.2 and S1: rename to `CliErrorCode`; `CliError.code: CliErrorCode` |
| C20 | doc file name casing | 05 6.1 (A0049) | 03 4.4 says `docs/OPERATIONS.md` | 03 4.4: `docs/operations.md` |
| C21 | `InstanceReader.errors` item type | 03 6.1 | 01 6.1 uses `ServerErrorItem[]` | 01 6.1: `ErrorItem[]` |
| C22 | hooks verify type in diagnostics | 02 3.1 | 01 6.4 `DiagnosticsBundle.hooks: HooksVerifyReport` | 01 6.4: `HooksVerifyResult` |
| C23 | hooks CLI surface and installer home | 01 6.1-6.3 (INV-12, A0008) | 02 3.1 defines `hooks status`, `--sync-tool-events`, `--json`, and puts plan/apply/verify in `cl/commands/hooks/*` (engine `ops.hooks.*` cannot import `cl/`); 01 names `planHooksInstall + applyHooksPlan` and `--dry-run` | 01 6.3: add `hooks status` (`--task`, `--json`, exit 0, `ops.hooks.status`) and `--sync-tool-events` on `hooks install`, name 02's `planHooks`; 02 1.1, section 9.5, section 13 I-9: move `{plan,apply,verify,uninstall,status,settings-io}.ts` to `en/hooks/installer/` called by `ops.hooks.*`; `cl/commands/hooks/*.ts` keep option tables and rendering only |
| C24 | `compilePyRegex` call | 01 2.8 | 02 5.2 step 4 calls `compilePyRegex(rule.match, { dotAll: true })` and re-implements label substitution | 02 5.2: `compilePyRegex(rule.match, 'session_rule')` and `applyLabelTemplate(label, m)` |
| C25 | spool glob in E2E | 02 2.7 (`.ndjson`, I-02) | 04 11.4 step 13 appends to `<workspaceA>/data/spool/hooks-*.jsonl` | 04 11.4 step 13: `hooks-*.ndjson` (newest by `SPOOL_SEGMENT_RE`) |
| C26 | `InstanceInfo.poll` keys and mapping | 03 6.2 | 04 5.2 `usePanel` uses `poll.<key>Ms` for git/ledger/chainLog (no such keys); 03 never maps legacy `poll.events_ms`/`overview_ms` or a source for `healthMs` | 03 6.2: state `transcriptMs = poll.events_ms`, `overviewMs = poll.overview_ms` (also the git/ledger/chainLog panel interval, legacy `/api/overview` cadence), `healthMs` = constant 5000; 04 5.2: git/ledger/chainLog panels use `poll.overviewMs` |
| C27 | home of `Clock` | 01 4.4a (I-36) | 05 1.2 and section 13 S2 own `sh/clock.ts` | 05 1.2, S2: `Clock`/`systemClock` live in `sh/time.ts` (01 S1); testkit `FakeClock` imports from there |
| C28 | Node floor | 01 5.1 (I-05, A0007) | 05 3.2 ("Node >= 22.12" for repo scripts), 06 3.9.4, section 7.1 item 2, section 7.2 T21 say 22.12 | 05 3.2, 06 3.9.4, section 7.1 item 2, T21: 22.22.0 |
| C29 | launcher bootstrap steps and messages | 01 5.1 | 05 3.3.4 prints `bootstrap: installing dependencies ...`, resolves npm only next to node, omits `RUNTIME_IN_USE` and `.mcs-bootstrap.log` | 05 3.3.4: keep only the stamp contract and point to 01 5.1 for steps, messages, npm resolution and the `RUNTIME_IN_USE` guard |
| C30 | `outdated` comparison source | 01 5.3 | 05 3.3.1 compares the running `codeStamp` with `staleness().buildStamp.slice(0, 10)` (source tree) | 05 3.3.1: compare with `codeStamp` of `rt/.mcs-build.json` (built code) |
| C31 | Playwright port and server start | 05 4.5 (ports), 01 4.1 (argv), 04 11.4 (specs) | 05 A.28 defaults `MCS_E2E_PORT` to 18900 and starts `node ../../server/dist/main.js --port N`; 01 2.10 repeats default 18900 | 05 A.28: default 18500, remove `webServer` (specs start instances with `$MCS start`); 01 2.10: `MCS_E2E_PORT` default 18500 |
| C32 | free-port helper | 05 4.4 (`allocatePort`) | 01 3.5 `findFreePort(18000, 18499)`, 04 11.4 and 05 4.5 `findFreePort(18500, 18599)`; 05 A.40 stub scans 18000-18999 | 01 3.5, 04 11.4, 05 4.5: `allocatePort(VITEST_PORTS)` / `allocatePort([18500, 18599])`; 05 A.40: range from `VITEST_PORTS` |
| C33 | isolation fixtures named by 01 | 05 4.4 | 01 3.5 uses `tempRoot`, `hermeticEnv`, `makeWorkspace`, `startInstance`, `snapshotWorkspace`, `spawnImpostor`, `makeJunction`, none exported by testkit | 05 4.4: add `hermeticEnv(root)`, `startInstance(ws, {port})`, `spawnImpostor(argv)`, `makeJunction(link, target)`; 01 3.5: `tempRoot` -> `makeTempDir`, `snapshotWorkspace` -> `snapshotTree` (exclude runtime-mutable paths), `makeWorkspace` -> `runCli(['init', ...])` |
| C34 | demo builder options | 04 11.5 | 05 4.4 `DemoOptions = { root, now, ... }` and lists `runtimeJson` in `DemoResult` | 05 4.4: `nowMs`; drop `runtimeJson` (or 04 11.5 adds it) |
| C35 | id regexes defined twice | 02 2.3.2 (I-26) | 05 5.3 S-FS declares `SESSION_ID_RE`, `AGENT_ID_RE`, `RUN_ID_RE` in `en/security/paths.ts` | 05 5.3: re-export `SID_RE`, `AGENT_RE`, `RUN_ID_RE` from `@mcs/shared/protocol` (no second literal) |
| C36 | `LegacyState` redeclared | 03 5.5 | 05 4.11.3 (`projections.ts`) and 06 6.2 (`tk/expect.ts`) declare their own union | 05, 06: `import type { LegacyState } from '@mcs/shared'` |
| C37 | test id prefix `T-LC-` | 01 4.16 (cited by 01 2.10 env table) | 02 7.12, section 9.2, section 9.5 use T-LC-01..57 for lifecycle-model tests | 02: rename to `T-LF-01..57` (and `T-LF-54`, `T-LF-57` references in 02 4.10, section 7.13) |
| C38 | test file names | per owning design (I-22); 05 owns layout | 05 4.2 names `lifecycle.transitions.test.ts`, `tokens.worked-example.test.ts`, `engine/src/config/pyregex.test.ts`, `shared/src/filters/*.test.ts`; 04 11.3 `server/test/api-to-web.test.ts` | 05 4.2: `transitions.test.ts`, `worked-example.test.ts` (02 9.5), `sh/pyregex/*.test.ts` (01 2.8), `sh/api/filters.test.ts` (03 23); 04 11.3: `api-to-web.int.test.ts` |
| C39 | `data/exports/` folder | 01 1.1 (workspace files) | 03 11.1 writes `data/exports/.tmp-<random>.db`; absent from 01's tree, cleanup scopes and audit rules | 01 1.1: add `data/exports/` (writer: server export route; runtime-mutable); 01 6.4 `cleanup --scope stale-state`: also delete `data/exports/.tmp-*` older than 10 min |
| C40 | attempts tables as seen by 06 | 03 3.5, section 9.1 | 06 3.10.2 reference DDL: `session_id TEXT` provider id, FK `REFERENCES attempt_sources`, indexes `attempt_runs_by_*`, "attempts rows are not a stream kind"; 06 3.10.8 index `attempt_runs_by_start` | 06 3.10.2: drop the reference DDL, cite 03 3.5 (`session_id` = `sessions.id` row id, soft refs, `idx_attempt_runs_*`, change kind `attempt/upsert`); 06 3.10.8: `idx_attempt_runs_start` |
| C41 | `external.attempt` payload | 02 4.3 | 06 3.10.7 emits `{k, sessionId, state, evidence, rowKey, observedAt}` without `endedAt` | 06 3.10.7: add `endedAt: row.ended_at` |
| C42 | config errors proposed by 06 | 01 2.4, section 6.2 | 06 3.10.1 `E_ATTEMPTS_TIME_FORMAT`, section 4.1 `E_MSYS_PATH` are not CLI codes and not in the validation table | 06: report both as `CONFIG_INVALID` problems with the quoted messages; 01 2.4 Node-only additions: `attempts.time_format` checked by `pyStrptimeValidate`, MSYS-style `/<letter>/` paths rejected on win32 |
| C43 | `configWarnings` in health | 03 6.2 | 06 5.8 D3 exposes flat-config warnings in `/api/v3/health configWarnings` (field absent; flat configs are delegated to `$V`, 01 6.5) | 06 5.8 D3: surface warnings in `inspect` and `doctor` only |
| C44 | `db rebuild` | 01 5.4 (I-12) | 06 7.1 item 6 and OI-7 call it an open proposal and give manual steps | 06 7.1 item 6: use `$MCS db rebuild --task X --yes --confirm X`; close OI-7 |
| C45 | root npm scripts | 05 3.1 | used but absent: `schemas`, `schemas:check` (01 2.9 `gen-schemas.mjs`, 03 13 `gen-api-schemas.mjs`), `parity:shadow` (06 5.6), `bench` (06 8.3), `testkit` (06 6.4) | 05 3.1 + A.1: add the five scripts; one generator `scripts/gen-schemas.mjs` that also writes `schemas/api/**` (03 13 item 4 renamed accordingly) |
| C46 | `@mcs/testkit/legacy` subpath | 05 2.2 | 06 5.3 imports `@mcs/testkit/legacy`; 05 exports only `.` | 05 2.2 + A.21: add export `./legacy` (three conditions) |
| C47 | test placement in 06 | 05 4.1 | 06 3.11, section 4.11 put unit tests in `engine/test/panels/*.test.ts`, `engine/test/platform/*.test.ts`; PP0 `shared/test/api/panels.test.ts` | 06: unit tests next to the module (`en/panels/*.test.ts`, `en/platform/*.test.ts`, `sh/api/panels.test.ts`); `test/` keeps only `*.int.test.ts` |
| C48 | settings mutex key | 01 4.2 | 02 3.5 step 1 hashes `normalizePath(settingsPath)` (forward slashes), 01 hashes the absolute path | 02 3.5: `mutexName('settings', path.resolve(settingsPath))` |
| C49 | stale ADR texts owned by 02 | 02 2.7, 03 3.5, 02 3.5, 03 3.5 (I-03) | A0012: "UNIQUE (`instance_id`, `event_uid`)", "deleted 24 h after sealing"; A0014: "lock file"; A0016: `transcript_entry` rows | A0012: `UNIQUE event_uid` (no `instance_id`), retention `hourEnd + spool.retainHours`; A0014: OS mutex `mutexName('settings', ...)`; A0016: rows of the single `events` table |
| C50 | `staleAfterMs` source | 03 6.2 | A0033 says "single default 15000 ms from `@mcs/shared`" | A0033: value = `InstanceInfo.staleAfterMs` from config `poll.stale_after_ms` (default 15000) |
| C51 | module of `HealthReport`, `InstanceInfo`, `ErrorItem` | 03 23 S3 file list (`health.ts`, `legacy-health.ts`) | 04 13 says `sh/api/entities.ts`; 03 6.2 does not name the module | 03 6.2: state `sh/api/health.ts`; 04 13 row: same path |
| C52 | work item source spelling | 03 (both) | `WorkItem.source` `declared attempts label` (03 5.5) vs `work_items.kind` `declared attempt label` (03 3.5) | 03 5.5: state the mapping (`attempt` -> `attempts`) or use one spelling |
| C53 | `withWriteTx` signature | 03 4.5 | 03 3.6 prose `withWriteTx(ctx, fn)` | 03 3.6: `withWriteTx(db, ctx, fn)` |
| C54 | smoke port range | 05 4.5, A0043 | 05 3.2 and A.37 loop scan 18800-18899 (overlaps parity 18850-18899) | 05 3.2, A.37: 18800-18849 |
| C55 | diagnostics command | 01 6.3 | 05 5.3 S-SEC-4 says `mcs doctor --report` | 05 S-SEC-4: `mcs diagnostics` |
| C56 | agent kinds | 03 3.5 | 02 4.1 lists `subagent workflow_agent internal` | 02 4.1: `main subagent workflow_agent teammate internal` (`main` created by `SessionsRepo.ensure`; `teammate` reserved) |
| C57 | driver of `tickAttempts` | 01 4.4a | 06 3.2 says `createInstanceRuntime.start()` calls `panels.tickAttempts()` on the ingestion tick, 06 3.4 "every 2 s"; 01 component 4 starts nothing and 02 has no such hook | 01 4.4a component 4: start a 2 s timer (via `ctx.clock`) calling `panels.tickAttempts()` (serialized, skipped while one runs), stop clears it |
| C58 | E2E spec folder | 04 11.4 (specs) | 05 4.1/A.28 `testDir: './specs'`; 04 4.2 shows `e2e/` without `specs/` | 04 4.2: `e2e/specs/*.spec.ts` |
| C59 | `ChangeSink.record` entity names | 03 9.1 vs 02 4.6 (02 entity list is the input contract) | 03 9.1 mapping text still names `hook_event`, `transcript_entry` | 03 9.1: `event` -> `event/append` |

### 15.1 Notes (gaps, not conflicts)

| Id | Note |
|---|---|
| N1 | `InstanceRow` (01 6.4) has no type declaration beyond the column list `slug engine state url pid version outdated`. |
| N2 | `HANDLER_VERSION` file location is implied (02 2.1); place it in `sh/protocol/hook-envelope.ts`. |
| N3 | `registerRoute` validates responses unless `NODE_ENV === 'production'`; no design sets `NODE_ENV` for the detached server (01 4.7 env), so production validates every response. 01 or 03 should state the value. |
| N4 | `AlertRuleView` element shape is not written out in 03 6.1/section 12.1. |
| N5 | 01 S1 lists `sh/config/runtime/logging.ts` though `logLevel` is a top-level key with no section. |
| N6 | `WorkspaceRef` (01) is used everywhere but never declared. |
| N7 | `McsError` (01) has no declared signature; `CliError.details` and `hint` population is implicit. |
| N8 | `resolveMcsHome` is needed by the zod-free handler and by the engine; it must live in `sh/protocol/**` (02 2.6.1 gives no path). |
| N9 | 01 `entriesBetween` is async; 03 `AuditReader.entriesBetween` is sync (called inside a synchronous read step). The composition root must pre-read or 03 must accept a promise; decide in 01 S8 / 03 S5. |
| N10 | 01 2.6 names `SUPPORTED_DB_SCHEMA`; 03 derives the supported version from shipped migration files (`latest`). Use 03's `migrationStatus().latest`. |
| N11 | `alert_not_found` (03 5.2) is not raised by any route in 03 6.1. |
| N12 | 06 uses `T1`..`T7` for token rules and `T1`..`T23` for troubleshooting rows. |
| N13 | 02 9.4 allows ports 18000-18999 for its tests; 05 4.5 assigns 18000-18499 to Vitest. |

## 16. Maintaining this registry

1. A change to any name listed here changes the owning design section and this registry in the same commit.
2. A new cross-boundary name gets a row before code uses it; a divergence gets a `Cnn` row with the owner and the exact fix.
3. Phase 2 contract tests that enforce rows here: `runtime-sections.contract.test.ts` (section 6.2), `env-vars.test.ts` (section 6.3),
   `schemas.drift.test.ts` and `schemas:check` (section 1, section 3), DA-T-API-3 meta-test (section 7.1), `launcher-parity.test.ts` (mutex names, markers),
   `routes.test.ts` (Express routes 1:1 with the registry), `normalize-envelope.test.ts`/`normalize-record.test.ts` (section 11.4).
