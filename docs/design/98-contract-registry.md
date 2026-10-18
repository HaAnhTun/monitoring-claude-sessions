# 98 Contract registry: every name that crosses a package or document boundary

Status: Phase 1 reconciliation artefact, written 2026-10-11 by the contract registrar and refreshed the same day (second pass) from
`00-foundations.md`, the six designs as reconciled by their owners against `phase1b-residuals.json` (01 revision 4, 02 revision
2026-10-11c, 03 reconciliation pass, 04 with its C25/C26/C32/C50/C51/C58 edits, 05 revision 2 and reconciliation, 06 revision 4), ADRs
`0001`-`0059` and `99-requirements-matrix.md`. Authoritative index for Phase 2+ implementers: when a design document and this registry
disagree, the owner named in section 0.1 wins; section 15 records every divergence found (C01-C63) as RESOLVED, with the design section
where the texts are now consistent, or OPEN, with the exact fix and its owner; the table at its end lists the OPEN ones. The registry never
repeats long definitions: it points to the section that holds them.

## 0. How to read this registry

### 0.1 Authority order (applied to every name below)

| Kind of name | Authoritative design |
|---|---|
| API routes, response/request schemas, DB tables/columns/indexes/migrations, SSE frames, HTTP error codes | 03 |
| Hook envelope, spool, ingestion events, lifecycle states/facts/rules, token rules, ingest error codes | 02 |
| Workspace files, config schemas and keys (every `runtime.json` section module is written by 01 S1; the owner's key table stays normative for semantics, type, range and default), env vars, CLI commands/flags/exit codes, process lifecycle, launcher, control channel, audit, composition root (`runtime/context.ts`, `runtime/instance-runtime.ts`), `Clock` (`shared/src/time.ts`), `platform/mutex.ts`, `platform/markers.ts` | 01 |
| Panels, platform helpers (`exec`, `process`, `fsx`, `paths`, `host`, `glob`, `pytime`, `watch-hint`; not `mutex` and `markers`, which are 01's), parity/golden capture | 06 |
| Tooling, npm scripts, ports policy, testkit core (including the isolation fixtures), test layout, security primitives (`security/paths`, `logger`, `terminal`, `guards`) | 05 |
| UI-only names (routes, URL params, query keys, components, prefs) | 04 |

Where evidence overrides the order the conflict row says so. A name followed by `(Cnn OPEN)` (C37, C38, C61, C62, C63) has an open conflict in section 15 (C60 was fixed in the designs by the final verification, `97-reconciliation-log.md`); a note
`(Cnn resolved)` says that the divergence existed in the revision 2 texts and the designs now agree on the form shown.

### 0.3 What the second pass removed or superseded

Names that no design contains any more and whose rows were deleted: `import.maxLineBytes` (C01), `MCS_E2E_PORT` (C31), `ExecutableName`
and `resolveExecutable('python')` (C11), `ChildStat` (C10), `createMaintenanceScheduler` (C08), `replaySpool` and `ingest.replay {from}`
(C03, C04), `writeFileAtomic` (C14), `SESSION_ID_RE` and `AGENT_ID_RE` (C35), `workspaceDir` (C07), `hook_event` and
`transcript_entry` as `ChangeSink` entities (C59), `E_ATTEMPTS_TIME_FORMAT` and `E_MSYS_PATH` (C42), `configWarnings` (C43),
`planHooksInstall` and `applyHooksPlan` (C23), `gen-api-schemas.mjs` (C45). Three first-pass fix columns were superseded by the
owners' later decisions and are recorded as such in section 15: C02 (the owner's table is normative, N-04, not 01 1.6), C31 (no
`MCS_E2E_PORT` at all, N-02, I-27) and C43 (flat configs are N/A in Node, N-05).

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
| `LegacyState` | enum | 03 5.5 | 03 | `sh/api/entities.ts` | 02 7.9, 04, 05, 06 | `RUNNING IDLE COMPLETED FAILED UNKNOWN`; declared once and imported by 02, 05 (`projections.ts`) and 06 (`tk/expect.ts`) (C36 resolved) |
| `BOARD_STATES`, `BoardState` | const, enum | 03 5.5 | 03 | `sh/api/entities.ts` | 02 7.11, 04 | `working waiting completed failed stale unknown` |
| `EVENT_KINDS`, `EventKind` | const, enum | 03 5.5, section 3.6 | 03 | `sh/api/entities.ts` | 02 4.1.2, 04 | 33 stored kinds, section 11.4 |
| `EVENT_CATEGORIES`, `EventCategory`, `CATEGORY_OF` | const, enum | 03 5.5 | 03 | `sh/api/entities.ts` | 04 (`types` URL filter) | 8 categories |
| `ToolStatus` | enum | 03 5.5 | 03 | `sh/api/entities.ts` | 04 | `pending succeeded failed denied interrupted unknown`, derived from `tool_calls.outcome` |
| `Completeness` | enum | 03 5.5 | 03 | same | 04 | `complete partial unavailable` |
| `TranscriptFileState` | enum | 03 5.5 | 03 | same | 04 | `active missing unreadable untracked retired` |
| `EvidenceItem` (API form) | type | 03 5.5 | 03 | same | 02 `toApiEvidence` (imports it as `ApiEvidenceItem`), 04 | `{kind: '<source>:<fact>', at, text}`; the engine form is 02's `LifecycleEvidence` (sections 2.5 and 11.1; C18 resolved) |
| `StateAssessment` | type | 03 5.5 | 03 | same | 04 | projection of 02 `LifecycleView` + `legacyState` |
| `TokenUsage` | type | 03 5.5 | 03 (shape), 02 6.3 (rules) | same | 04, 06 `AttemptsPanel` | a field is `null` when every counted message misses it |
| `CostEstimate` | type | 03 5.5 | 03 | same | 04 | `basis: 'estimate'` |
| `SessionSummary` | type | 03 5.5 | 03 | same | 01 `InstanceReader`, 04 | `workItemIds` (UI URL key `task`) |
| `SessionDetail` | type | 03 5.5 | 03 | same | 01, 04 | `auditRefs` from 01 `entriesBetween` |
| `AgentNode` | type | 03 5.5 | 03 | same | 04 | `workflow` = `{runId, name, phase, state}` |
| `ActivityEvent` | type | 03 5.5 | 03 | same | 04, export | `id: number`, `transcriptRef {agentId, offset}` |
| `ToolCallItem` | type | 03 5.5 | 03 | same | 04, stream | |
| `TransitionItem` | type | 03 5.5 | 03 | same | 04, export | |
| `WorkItem` | type | 03 5.5 | 03 (shape), 02 7.11 (rules) | same | 04 | `source` `declared attempts label` = `work_items.kind` `declared attempt label` with `attempt` -> `attempts` (03 5.5; C52 resolved) |
| `AlertRuleKind`, `AlertItem` | enum, type | 03 5.5 | 03 | same | 04 | 8 rule kinds, section 7.10 |
| `WorkflowRunItem` | type | 03 9.2 | 03 | `sh/api/stream.ts` | 04 | data of `workflow/upsert` |

### 1.2 Pagination, errors, filters, route registry

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `Page<T>` | type | 03 5.3 | 03 | `sh/api/entities.ts` | 01 readers, 04 | `items, nextCursor, asOfSeq, total, totalIsLowerBound, limit` |
| `EventPage` | type | 03 6.1 | 03 | same | 04 | adds `scanCapped`, `newerCursor` |
| cursor | format | 03 5.3 | 03 | `sh/api/cursor.ts` | 04 (opaque) | base64url JSON `{v,r,s,d,k,i,w,f}`, <= 512 chars |
| `ErrorEnvelope` | type, schema | 03 5.2 | 03 | `sh/api/errors.ts` | 02 2.8, 04 5.1, 05 5.3 | `{error: {code, message, requestId, details?}}` |
| `ErrorCode` (HTTP catalogue) | enum | 03 5.2 | 03 | `sh/api/errors.ts` | 02, 04, 05 security suite | catalogue section 7.1; the only type named `ErrorCode` in `@mcs/shared`: the CLI union is `CliErrorCode` (`sh/errors.ts`, C19 resolved) |
| `Preset` | enum | 03 5.4, 04 3.2 | 03 | `sh/api/filters.ts` | 04 `lib/url-state.ts` | `1h 6h 24h 7d 30d all` |
| `toQuery`, `fromQuery`, `matchesEventFilter` | fn | 03 5.4 | 03 | `sh/api/filters.ts` | 04 4.4.4, section 5.2 | round trip tested (DA-T-API-7) |
| `SessionListQuery`, `AgentListQuery`, `EventListQuery`, `ToolCallListQuery`, `ErrorsQuery`, `OverviewQuery`, `UsageQuery`, `SessionUsageQuery`, `SeriesQuery`, `ToolsQuery`, `TransitionListQuery`, `SessionAgentsQuery`, `WorkItemBoardQuery`, `AlertListQuery`, `TranscriptWindowQuery`, `TranscriptLocateQuery`, `TranscriptSearchQuery`, `InstanceSearchQuery` | type | 03 12.1 | 03 | `sh/api/filters.ts` (parsed outputs of the route zod schemas) | 01 CLI flags, 04 | 04 aliases `EventFilter`, `SessionFilter` |
| `defineRoute`, route registry `routes` | fn, const | 03 13 | 03 | `sh/api/routes.ts` | 01 `ApiReader`, 04 `data/endpoints.ts`, contract tests | `{id, method, path, params, query, body, response, successStatus, errors, summary, contentType}` |
| `registerRoute(app, route, handler)` | fn | 03 13 | 03 | `sv/route-adapter.ts` | 06 panels route | validates responses when `NODE_ENV !== 'production'` (no design sets `NODE_ENV`; open point section 15 note N3) |

### 1.3 Health, instance, meta

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `HealthReport` | type, schema | 03 6.2 | 03 | `sh/api/health.ts` (03 6.2, S3; C51 resolved) | 01 `status`, `verify`, diagnostics; 04; 06 8.2 | includes `runtime.{rssBytes, heapUsedBytes, cpuUserMicros, cpuSystemMicros}`, `children: Record<ChildKind, ChildKindStats>`, `panels: PanelStats`; the last three come from `QueryDeps` and are absent for the DbReader; no `configWarnings` field (C43 resolved) |
| `InstanceInfo` | type, schema | 03 6.2 | 03 | `sh/api/health.ts` (C51 resolved) | 04 | `poll`, `features`, `commands`, `limits`, `epoch`, `headSeq`; `poll` mapping (C26 resolved): `transcriptMs` = config `poll.events_ms`, `overviewMs` = `poll.overview_ms` (also the git, ledger and chainLog panel interval), `sessionsMs`, `machineMs`, `logsMs`, `attemptsMs` = the legacy keys of the same name, `healthMs` = constant 5000; `staleAfterMs` = `poll.stale_after_ms` (C50 resolved) |
| `ErrorItem` | type | 03 6.1 | 03 | `sh/api/health.ts` | 01 `InstanceReader.errors` returns `ErrorItem[]` (C21 resolved), 04 | `{at, source, code, where, message, sessionId}` |
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
| `CompletionEvidence`, `CompletionEvidenceSchema` | type, schema | 02 7.13, 03 6.3 | 02 (fields), 03 (schema file) | `sh/api/completion.ts` | 01, 03 | `{outcome, state, basis, confidence, evidence (<= 8), sessionId: string \| null, ruleId, resolvedBy: 'session_id' \| 'label' \| 'attempt_part', candidates >= 1}`; one definition, the type is the `z.infer` (C16 resolved) |
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
| `ChildKind` | enum | 06 3.6 | 06 | `sh/api/panels.ts` (re-exported by `en/platform/exec.ts`) | 01, 03 `HealthReport.children` | `powershell.processes powershell.cmdline git docker ps taskkill node python icacls opener` (C11 resolved) |
| `ChildKindStats` | type | 06 3.6 | 06 | same | 01 4.2 (`childStats()`), 03 6.2 and `QueryDeps` | `{spawned, failed, timedOut, totalMs}`; 03 renamed its `ChildStat` (C10 resolved) |
| `PanelStats`, `PanelSourceStats` | type | 06 3.4 | 06 | same | 03 `HealthReport.panels` | |

### 1.7 Protocol, zod-free (`@mcs/shared/protocol`)

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `HookEnvelopeV1`, `HOOK_ENVELOPE_VERSION` | type, const | 02 2.3.1 | 02 | `sh/protocol/hook-envelope.ts` | 03, 04 tests, 05 testkit, 06 | envelope field is `event` (no `hook_event_name`) |
| `EnvelopeKind` | enum | 02 2.3.1 | 02 | same | 03 (`hook_probes`) | `hook probe` |
| envelope flags | enum | 02 2.3.3 | 02 | same | 03 `events.flags` | `stdin_truncated`, `invalid_<field>`, `event_mismatch`, `minimal`, `redacted`, `routed_by_cwd`, `routed_by_session_pin`, `data_truncated:<field>` |
| `SPOOL_SEGMENT_EXT`, `SPOOL_SEGMENT_RE`, `spoolSegmentName(receivedAt)` | const, fn | 02 2.3.1, section 2.7 | 02 | same | 01 `audit`, `ingest replay`; 03 CHECK; 04 E2E (`hooks-*.ndjson`, newest by `SPOOL_SEGMENT_RE`; C25 resolved); 06 | `.ndjson`; `/^hooks-(\d{8})T(\d{2})Z\.ndjson$/` |
| `SID_RE`, `AGENT_RE`, `TOOL_ID_RE`, `RUN_ID_RE` | const | 02 2.3.2 | 02 | same | 03 5.1 id rules (imports them, no second literal), 05 `security/paths.ts` (re-exports `SID_RE`, `AGENT_RE`, `RUN_ID_RE`; C35 resolved), 05 testkit | `RUN_ID_RE = /^wf_[A-Za-z0-9_-]{1,64}$/` |
| caps `HANDLER_HARD_EXIT_MS`, `STDIN_MAX_BYTES`, `ENVELOPE_MAX_BYTES`, `SPOOL_SEGMENT_SOFT_CAP`, `SPOOL_SEGMENT_HARD_CAP`, `NUDGE_TIMEOUT_MS`, `SUMMARY_MAX_CP`, `TITLE_MAX_CP`, `PATH_MAX_CHARS`, `ID_MAX_CHARS`, `NAME_MAX_CHARS`, `ROUTES_MAX_FILES`, `ROUTE_FILE_MAX_BYTES` | const | 02 2.3.1 | 02 | same | 03, 05 | values section 10.1 |
| `MAX_LINE_BYTES` | const | 02 1.1 (I-32) | 02 | `sh/protocol/limits.ts` | 02 tailer, 03 7, 05 S-ING-3, 06 attempts reader | 64 MiB; a constant, never a config key (C01 resolved) |
| `HOOK_EVENT_POLICY`, `INSTALLED_HOOK_EVENTS`, `ASYNC_HOOK_EVENTS`, `HOOK_EVENT_RANK` | const | 02 2.4, section 3.3, section 4.3 | 02 | `sh/protocol/hook-events.ts` | 04 demo, 05 testkit `HookEventName`, A0013 | 21 events, 4 async; ranks section 11.5 |
| `HookRouteV1`, `matchRoutes(routes, ids, now)`, `resolveMcsHome(env)` | type, fn | 02 2.6.1, section 2.6.2 | 02 | `sh/protocol/routes.ts` (02 1.1; N8 resolved) | hook handler, engine (`routes-file.ts`, ctx `mcsHome`), 01 route rewrites | `resolveMcsHome`: `MCS_HOME` if absolute, else Windows `%LOCALAPPDATA%/mcs`, else `${XDG_STATE_HOME:-~/.local/state}/mcs` |
| `Stamp`, `compareStamp` | type, fn | 02 4.3 | 02 | `sh/protocol/stamp.ts` | 03 `turns.end_rank/end_tie` LWW | `{at, rank, tie}` |
| `clip`, `summarizeToolInput`, `redact`, `REDACTION_RULES`, `canonicalJsonHash`, `normalizePath`, `routeKey`, `pyJsonDumps` | fn, const | 02 2.5 | 02 | `sh/protocol/sanitize.ts` | 03 `AttemptsRepo` (`clip`), 06 | rules R1-R7; `routeKey` is the only platform branch outside `en/platform/**` (06 4) |
| `ControlRequest`, `ControlResponse`, `ControlPhase` | type | 01 4.3 | 01 | `sh/protocol/control.ts` | server, CLI, 02 (op name `ingest-replay`, field `fromSegment`; C03 resolved) | ops `identify shutdown backup ingest-replay`; phases `starting ready stopping` |
| `HANDLER_VERSION` | const | 02 2.1 | 02 | `sh/protocol/hook-envelope.ts` (02 1.1; N2 resolved) | `hooks verify` V4 | equals `RUNTIME_VERSION` |

Zod mirrors (`sh/schemas/ingest.ts`, owner 02 4.2): `HookEnvelopeV1Schema`, `HookRouteV1Schema`, `TranscriptRecordShape` (loose),
`IngestHealthSchema`, `NudgeBodySchema` (strict `{instanceId}`).

### 1.8 Workspace files, config schemas, ids, time, CLI results (owner 01 unless noted)

| Name | Kind | Defined in | Owner | Code path | Consumers | Notes |
|---|---|---|---|---|---|---|
| `InstanceFileSchema`, `InstanceFile` | schema, type | 01 1.5 | 01 | `sh/files/instance.ts` | 05 testkit `buildTaskWorkspace` | key order fixed |
| `StateFileSchema`, `StateFile`, `stateEngine` | schema, type, fn | 01 1.7 | 01 | `sh/files/state.ts` | 02 handler (nudge targets) | non-strict |
| `BackupManifestSchema` | schema | 01 5.5 | 01 | `sh/files/backup-manifest.ts` | 03 `backupDb` callers | `dbCopy`: `online raw none` |
| `KeySpec`, `SectionKeys`, `sectionSchema`, `sectionOverridesSchema` | type, fn | 01 1.6 | 01 | `sh/config/runtime/section.ts` | 02, 03, 06 section modules | `.prefault({})` rule (01 E12) |
| `<Name>SectionKeys`, `<Name>SectionSchema` for `Server Process Backup Lifecycle Hooks Ingest Import Spool Health Analytics Board PanelOptions Retention Alerts Pricing` | const, schema | 01 1.6 | 01 writes every module (S1, N-03); the section owner's table is normative | `sh/config/runtime/<name>.ts` (`board.ts`, `panelOptions.ts`, `retention.ts`, `alerts.ts`, `pricing.ts` are 01's files too; the owners add no file there) | all | keys section 6.2; 01 S1 also lists a `logging.ts` module that `R_TOP_KEYS` does not need (note N5) |
| `RuntimeFileSchema`, `RuntimeOverridesSchema`, `RuntimeConfig` | schema, type | 01 1.6 | 01 | `sh/config/runtime/index.ts` | `resolveConfig` | |
| `R_TOP_KEYS`, `R_MERGED`, `R_KEY_CATALOGUE`, `R_DERIVED_DEFAULTS`, `DerivedDefault` | const, type | 01 1.6 | 01 | same | contract test `runtime-sections.contract.test.ts` (which also parses section 6.2 of this registry: every catalogue row equals its registry row) | catalogue `owner: '01' \| '02' \| '03' \| '06'` and `ref` = the owner's normative section; 9 `import` keys, 15 new keys in `spool import health analytics` |
| `LegacyConfigFileSchema` | predicate table | 01 2.4 | 01 | `en/config/validate-legacy.ts` | `check`, `configure`, server boot | legacy messages; not zod |
| `LegacyConfigZodMirror` | schema | 01 2.9 | 01 | `sh/config/*` | `config.v1.schema.json` only | |
| `L_MERGED`, `mergeLayer` | const, fn | 01 2.2 | 01 | `en/config/merge.ts` | | `panels ui poll limits` |
| `ResolveInput`, `ResolvedConfig`, `resolveConfig(i)` | type, fn | 01 2.3 | 01 | `en/config/resolve.ts` | 02, 03, 06 through `ctx.config` | |
| `FileMigration`, `FILE_MIGRATIONS` | type, const | 01 2.7 | 01 | `en/config/migrations.ts` | `config migrate` | empty in v1 |
| `DOCUMENTED_ENV_VARS` | const | 01 2.10 | 01 | `sh/env.ts` | 05 `tests/tooling/env-vars.test.ts` | section 6.3 |
| `RUNTIME_VERSION` | const | 01 5.2 | 01 | `sh/version.ts` | all | equals `rt/package.json` `version` (`3.0.0`) |
| `UUID_V4_RE`, `SLUG_RE`, `IsoSecondsZ`, `Semver` | const, schema | 01 1.5, section 3.1 | 01 | `sh/ids.ts` | | slug `^[a-z0-9][a-z0-9-]{0,47}$`, not a device name |
| `Clock`, `systemClock`, `isoSecondsZ`, `isoMsZ` | type, const, fn | 01 4.4a (I-36) | 01 | `sh/time.ts` only (05 declares no clock module; C27 resolved) | 02, 03, 05 testkit `FakeClock` (`implements Clock`), 06 (`ctx.clock.now()`) | `interface Clock { now(): number }` |
| `LogLevel` | enum | 05 5.3 S-LOG-6, 01 1.6 | 05 | `en/log/logger.ts`; mirrored in `sh/config` | 01 | `error warn info debug` |
| `CliEnvelope<T>`, `CliError` | type | 01 6.2 | 01 | `sh/cli/envelope.ts` | 02 3.1 | `schema: 'mcs.cli/1'` |
| `CliErrorCode` (the CLI error union) | enum | 01 6.2 | 01 | `sh/errors.ts` | 02 (`HOOKS_FAILED`, `USAGE`, `NOT_FOUND`), `McsError`, `CliError.code` | catalogue section 7.2; the name `ErrorCode` belongs to 03's HTTP codes (C19 resolved) |
| `StatusReport`, `InstanceRow`, `DoctorCheck`, `DiagnosticsBundle` | type | 01 4.10, section 6.4 | 01 | `sh/cli/results.ts` | 06 runbook | `DiagnosticsBundle.hooks: HooksVerifyResult \| null` (C22 resolved); `InstanceRow` fields only in prose (`slug engine state url pid version outdated`, note N1) |
| `HooksApplyResult`, `HooksWarningCode`, `HooksVerifyResult`, `HooksStatusResult` | type, enum | 02 3.1 | 02 (shape), 01 (file) | `sh/cli/results.ts` | 01 diagnostics; `hooks install\|uninstall\|verify\|status --json` (the `data` of the `mcs.cli/1` envelope) | warnings `HOOKS_SETTINGS_NOT_IGNORED HOOKS_USER_SCOPE HOOKS_LIVE_RELOAD` |
| `ProbeState`, `ProbeResult` | enum, type | 01 4.8 | 01 | `en/ops/probe.ts` | `StatusReport.probe` | states section 11.7 |

### 1.9 Python-regex translator (`sh/pyregex/`, owner 01 2.8)

| Name | Kind | Notes |
|---|---|---|
| `PyRegexContext` | enum | `session_rule attempts` |
| `PyRegexErrorCode`, `PyRegexError` | enum, type | `SYNTAX UNSUPPORTED_CONSTRUCT UNSUPPORTED_FLAG INEXACT_SEMANTICS JS_COMPILE` |
| `TranslatedPattern`, `translatePyRegex(source, ctx)` | type, fn | |
| `PyMatch`, `CompiledPyRegex`, `compilePyRegex(source, ctx)` | type, fn | throws `McsError REGEX_UNSUPPORTED`; consumers 02 5.2 (`compilePyRegex(rule.match, 'session_rule')`, C24 resolved), 06 3.10.1 (`'attempts'`) |
| `applyLabelTemplate(template, m)` | fn | `{n}` sequential, `{0}` first 40 code points; 02 5.2 calls it, no second implementation (C24 resolved) |

## 2. Engine public functions, classes and interfaces (with signatures)

Signatures are copied from the owning section; when two documents disagree the owner's form is shown and the conflict is marked.

### 2.1 Workspace, PyJson, audit, ops (owner 01)

| Name | Kind | Signature | Defined in | Code path | Consumers |
|---|---|---|---|---|---|
| `writeWorkspaceFile` | fn | `(path: string, data: string \| Uint8Array, o?: { budgetMs?: number }) => Promise<void>` | 01 1.2 | `en/workspace/fsio.ts` | 06 4.3 (same name, async; C14 resolved) |
| `writePyJsonFile` | fn | `(path: string, value: PyJsonValue, o?: { budgetMs?: number }) => Promise<void>` | 01 1.2 | same | 06 4.3, A0003, A0058 |
| `readTextUniversal` | fn | `(path: string, maxBytes?: number /* 16 MiB */) => Promise<string>` | 01 1.2 | same | audit reader |
| `readJsonFile` | fn | `(path: string) => Promise<{ text: string; value: PyJsonValue }>` | 01 1.2 | same | |
| `compareAndDelete` | fn | `(path: string, expected: Uint8Array) => Promise<'deleted' \| 'changed' \| 'absent'>` | 01 1.2 | same | stop, shutdown |
| `assertNotLink` | fn | `(path: string) => void` | 01 1.2 | same | throws `WORKSPACE_SYMLINK` |
| `PyJsonValue`, `parsePyJson`, `dumpPyJson`, `toPlain`, `fromPlain`, `pyEquals`, `pyShort`, `pyRepr`, `pyFloatRepr` | type, fn | `parsePyJson(text) => PyJsonValue`; `dumpPyJson(v, {indent: 2} \| {compact: true, asciiOnly?})` | 01 1.9 | `en/pyjson/` | 06 vectors, parity |
| `slugify`, `resolveWorkspace(root, slug)` | fn | | 01 3.1-3.2 | `en/workspace/paths.ts` | all ops |
| `WorkspaceRef` | type | not spelled out (resolved workspace handle) | 01 2.3, section 4.8, section 7.1 | `en/workspace/*` | note N6 |
| `ChangeEntry`, `appendChange`, `appendDecision`, `lastChange`, `recentAudit` | type, fn | `appendChange(ws, e: ChangeEntry, nowMs) => Promise<void>` | 01 7.1 | `en/audit/writer.ts` | 02 3.5 step 12 |
| `AuditRef`, `entriesBetween` | type, fn | `(ws, fromMs, toMs, limit) => Promise<AuditRef[]>` (`AuditRef = {file, at: ISO, title, summary}`) | 01 7.1 | `en/audit/reader.ts` | 03 `deps.audit` (`AuditReader.entriesBetween(fromMs, toMs, limit): Promise<AuditRef[]>`, async; N9 resolved) |
| `OpContext` | type | `{repo, root, skillDir, runtimeDir, launcherPath, env, clock, log}` | 01 6.1 | `en/ops/*` | CLI |
| `ops.workspace.{discover,init}`, `ops.config.{inspect,configure,check,migrate,importLegacy}`, `ops.audit.{recordDecision,check}`, `ops.lifecycle.{start,serveForeground,verify,status,stop,restart}`, `ops.diagnostics.{doctor,bundle}`, `ops.instances.{list,setEngine,repairIdentity}`, `ops.upgrade.{run,migrateDb,rebuildDb}`, `ops.ingest.replay`, `ops.hooks.{install,verify,uninstall,status,setEnabled}`, `ops.backup.*`, `ops.cleanup.run`, `ops.version` | fn | `(ctx: OpContext, input) => Promise<Result>` (result types in `sh/cli/results.ts`) | 01 6.3 | `en/ops/{workspace,config,audit,lifecycle,instances,upgrade,backup,cleanup,diagnostics,hooks,data,legacy,ingest}.ts` | CLI commands; `ops.hooks.*` call 02's installer in `en/hooks/installer/` (C23 resolved); `ops.version` names no module (note N14) |
| `probeInstance` | fn | `(ws: WorkspaceRef, o?: { httpTimeoutMs?: number; controlTimeoutMs?: number }) => Promise<ProbeResult>` | 01 4.8 | `en/ops/probe.ts` | start, stop, status, cleanup |
| `InstanceReader`, `openInstanceReader` | type, fn | `{mode, sessions, session, usage, errors, explainCompletion, exportTo, close}`; `errors(q): Promise<ErrorItem[]>` (C21 resolved); `explainCompletion(t): Promise<CompletionEvidence>` rejects `McsError` `USAGE` (`target_invalid`) or `NOT_FOUND` (`target_not_found`) (C16 resolved); `openInstanceReader(ws) => Promise<InstanceReader>` | 01 6.1 | `en/reader/{api-reader,db-reader}.ts` (01 S13a) | 03 12.2 (`session(id)` = `getSession` then `await sessionAuditRefs(detail)`) |
| `formatCommand` | fn | `(argv) => string` | 01 6.6 | `en/ops/commands.ts` | 03 `InstanceInfo.commands` |
| `McsError` | class | `(code: CliErrorCode, message)`; not declared as a signature in 01 (note N7) | 01 1.2, section 6.2 | `sh/errors.ts` | all engine modules |

### 2.2 Composition root (owner 01 4.4a)

| Name | Kind | Signature | Code path | Consumers |
|---|---|---|---|---|
| `ErrorRing`, `createErrorRing` | type, fn | `push({source, code, where, message, sessionId?})`, `list(limit?) => ErrorItem[]`; `createErrorRing(clock, capacity? /* 20 */)` | `en/runtime/error-ring.ts` | 03 `errors` route, 06 `SourceCache` |
| `ExecApi` | type | `{execFileText, resolveExecutable, childStats}` | `en/runtime/context.ts` | tests inject fakes |
| `RuntimeProcessInfo` | type | `{pid, startedAtMs, runtimeVersion, bootCodeStamp, previousRunUnclean, phase(), outdated(), ownershipConflict()}` | same | 03 health |
| `InstanceContext` | type | `{instanceId, slug, instanceDir, repoDir, claudeHome, mcsHome, skillDir, runtimeDir, config, instance, hooksEnabled, clock, db, scope, queries, errors, exec, logger, process}` | `en/runtime/context.ts` (C15 resolved) | 02 (reads `ctx.instanceDir`, never `workspaceDir`; C07 resolved), 03, 06 |
| `BuildContextInput`, `buildInstanceContext` | type, fn | `(i: BuildContextInput) => Promise<InstanceContext>`; opens the DB (`openInstanceDb('serve')`) and calls `createQueries(db, { config, now: () => clock.now(), audit, process, childStats: exec.childStats, panelStats })` with all six deps (03 12.1 `QueryDeps`; C09 resolved; 03 12.1 attributes this to `createInstanceRuntime`, C61) | same | server main, parity harness (06 5.4), benches |
| `bindPanelStats` | fn | `(ctx: InstanceContext, get: () => PanelStats) => void`; called once by `createInstanceRuntime` after the panel service exists; before that `panelStats()` returns `{}` | `en/runtime/context.ts` | `QueryDeps.panelStats` -> `HealthReport.panels` |
| `RuntimeComponent` | type | `{name, start(), stop(deadlineMs)}` | `en/runtime/instance-runtime.ts` | 02, 03, 06 factories |
| `InstanceRuntime`, `createInstanceRuntime` | type, fn | `{start(), stop(deadlineMs) => {completed, pendingComponent}, ingestUntilIdle({timeoutMs}) => {idle, waitedMs, stats}, ingestReplay(fromSegment) => {segments}, health(), panels}`; `(ctx) => InstanceRuntime`; `ingestUntilIdle` calls `ingest.untilIdle({timeoutMs: remaining})`, maps `IngestIdleTimeoutError` to `idle: false`, then `sweeper.tickNow()` and one attempts tick; callers assert `.idle === true` (C06 resolved); `ingestReplay` = `{segments: (await ingest.replay(from)).segmentsReset}` (C04 resolved) | same | server, 06 5.4, 02/03 integration tests |
| `createStateWatchdog` | fn | `(ctx, { stateFileBytes }) => RuntimeComponent` | `en/runtime/state-watchdog.ts` | runtime |
| `testHook` | fn | `(name: string) => string \| undefined` (only when `MCS_TEST === '1'`) | `en/runtime/test-hooks.ts` | server boot, init, control channel |
| component order | rule | 1 `ingest = createIngestService(ctx)`; 2 `createLifecycleSweeper(ctx, {writer: ingest.writer})`; 3 `createDbScheduler(ctx)` wrapped as `{name: 'db-scheduler', start, stop}` (C08 resolved); 4 `createPanelService(ctx, {writer: ingest.writer})` plus `bindPanelStats` and a 2000 ms `setTimeout` chain calling `panels.tickAttempts()` through one serializer `tickAttemptsOnce()` (skipped while a tick runs; a rejection is logged `attempts_tick_failed` and pushed to `ctx.errors`; first call at start; cleared by stop, then `panels.close()`; C57 resolved); 5 `createStateWatchdog`; 6 `writeRouteFile` | 01 4.4a | the timer belongs to 01 S8 even though the panel service is 06's (06 OI-14) |

### 2.3 Platform (owner 06 unless noted)

| Name | Kind | Signature | Defined in | Code path | Consumers |
|---|---|---|---|---|---|
| `ChildSpec`, `ChildResult`, `ChildErrorCode` | type, enum | `ChildSpec {kind, file, args, cwd?, timeoutMs, maxOutputBytes, encoding: 'utf8' \| 'latin1', extraEnv?, stdin?}`; `stdin?: string` is for kind `node` only, at most 4096 bytes, written once then closed (02 3.7 V6; C60 resolved); `ChildResult {ok, code, stdout, stderr, error, truncated, durationMs}` | 06 3.6 | `en/platform/exec.ts` | 01, 02 `hooks verify`, 05 S-PROC |
| `execFileText` | fn | `(spec: ChildSpec, signal?: AbortSignal) => Promise<ChildResult>` (never throws) | 06 3.6 (I-06) | same | 01 (python probe, icacls, opener, runtime listing), 02 (`hooks verify` V4, V6 with kind `node`), 06 panels |
| `resolveExecutable` | fn | `(name: 'git' \| 'docker' \| 'powershell' \| 'ps' \| 'taskkill' \| 'icacls' \| 'node' \| 'opener') => Promise<string \| null>`; no `ExecutableName` type and no `'python'`: 01 6.5 probes `MCS_PYTHON`, `python`, `python3`, `py` itself and passes the absolute path as `ChildSpec.file` (C11 resolved) | 06 3.6 | same | 01 (`opener`: `explorer.exe`, `/usr/bin/open`, `xdg-open`) |
| `childStats` | fn | `() => Record<ChildKind, ChildKindStats>` | 06 3.6 | same | 03 `HealthReport.children` |
| `spawnDetached` | fn | `(file, args, o: {cwd, env, stdoutFd, stderrFd}) => ChildProcess` | 01 4.2 (signature), 06 3.6 (file) | same | `start` |
| `spawnForeground` | fn | `(file, args, o: {cwd, env}) => ChildProcess` | 01 4.2, 06 3.6 | same | `serve`, legacy delegation |
| `pidAlive`, `commandLineOf`, `forceKill`, `waitForExit` | fn | `pidAlive(pid) => boolean`; `commandLineOf(pid) => Promise<string \| null>`; `forceKill(pid) => Promise<void>` (Windows `taskkill.exe /PID <pid> /F` through `execFileText` kind `taskkill`, exit 128 = already gone = success; POSIX SIGKILL; C12 resolved); `waitForExit(pid, timeoutMs, pollMs?) => Promise<boolean>` | 06 4.2 | `en/platform/process.ts` | 01 stop; 02 sweeper and registry poller (`pidAlive`, no second probe; ADR 0019) |
| `listRuntimeProcesses` | fn | `(runtimeDir: string) => Promise<{pid, instanceId, instanceDir}[]>` | 01 4.2 | `en/platform/markers.ts` (01 S4; C13 resolved) | launcher (copy), `probeInstance` |
| `hasRuntimeMarker`, `hasLegacyMarker` | fn | `(commandLine, instanceId) => boolean`; `(commandLine) => boolean` | 01 4.2 | `en/platform/markers.ts` | stop |
| `ProcessMutex`, `tryAcquireMutex`, `acquireMutex`, `mutexName` | type, fn | `mutexName(kind: 'task' \| 'bootstrap' \| 'settings', key) => 'mcs-<kind>-' + sha256(key.toLowerCase() on win32).slice(0,16)`; `acquireMutex(name, {timeoutMs, onWait?}) => Promise<ProcessMutex>`; the `settings` key is `path.resolve(settingsPath)` (C48 resolved) | 01 4.2 | `en/platform/mutex.ts` (+ zero-dep copy in `scripts/mcs.mjs`) | 02 3.5, 05 3.3.4 |
| `atomicWriteFile`, `readSmallFile`, `unlinkWithRetry`, `AtomicWriteError`, `SmallFileError` | fn, class | `atomicWriteFile(file, data, {budgetMs?: 3000, mode?}) => Promise<void>` | 06 4.3 | `en/platform/fsx.ts` | 01 `fsio.ts` wrapper |
| `tailLines`, `pySplitlines`, `clipCodePoints` | fn | `tailLines(path, n) => Promise<string[]>` | 06 3.9.1 | `en/platform/fsx.ts` | panels |
| `canonicalPath`, `samePath`, `toPosixRel`, `pathKey` | fn | `pathKey(path)` = `samePath` comparison key | 06 4.1, 03 15.5 | `en/platform/paths.ts` | 03 `attempt_sources.path_key`, 01 markers |
| `hostPlatform`, `pathsCaseInsensitive` | const | | 06 4 | `en/platform/host.ts` | every engine module needing the platform |
| `globFiles` | fn | `(pattern, base, opts = {maxMatches: 500, maxDepth: 8})` | 06 3.9.4 | `en/platform/glob.ts` | logs panel |
| `pyStrptime`, `pyStrptimeValidate`, `toEpochMs` | fn | `pyStrptime(text, format) => {...} \| null` | 06 3.10.4 | `en/platform/pytime.ts` | attempts; 01 2.4 config validation (`attempts.time_format`, reported as `CONFIG_INVALID`; C42 resolved) |
| `WatchHint`, `createWatchHint` | type, fn | `(root, onHint, o?: {debounceMs?: 100}) => WatchHint` | 06 4.4 | `en/platform/watch-hint.ts` | 02 scheduler |
| `SID_RE`, `AGENT_RE`, `RUN_ID_RE` (re-exports), `resolveContained`, `isContained`, `walkNoLinks` | const, fn | `resolveContained(root, ...segments) => string \| null`; the three regexes are re-exported from `@mcs/shared/protocol`, never a second literal (C35 resolved; `SESSION_ID_RE` and `AGENT_ID_RE` no longer exist) | 05 5.3 S-FS | `en/security/paths.ts` | 03, 06 |
| `createLogger`, `Logger`, `LoggerOptions`, `LOG_ROTATE_BYTES`, `LOG_KEEP`, `LOG_ROTATE_RETRY_BUDGET_MS` | fn, type, const | `createLogger({file, level, rotate, clock, rotateBytes?}) => Logger` | 05 5.3 S-LOG-6 | `en/log/logger.ts` | all |

### 2.4 Ingestion (owner 02)

| Name | Kind | Signature | Defined in | Code path |
|---|---|---|---|---|
| `runHook` | fn | `(argv: string[]) => Promise<void>` | 02 1.1, section 2.2 | `cl/hook.ts` -> `cl/hook/main.ts` |
| `resolveMcsHome` | fn | `(env) => string` | 02 2.6.1 | `sh/protocol/routes.ts` (zod-free; shared by the handler and the engine; N8 resolved) |
| `writeRouteFile` | fn | `(instance, state: {stoppedAt, spoolUntil?}) => Promise<void>` | 02 2.6.2 | `en/ingest/routes-file.ts` |
| `createIngestService`, `IngestService`, `IngestStats` | fn, type | `(ctx) => {writer, start(), stop(deadlineMs), untilIdle({timeoutMs}): Promise<void>, nudge(), replay(fromSegment) => {segmentsReset}, stats()}` | 02 4.10 | `en/ingest/service.ts`; 01 4.4a adopts this shape (C06 resolved) |
| `IngestIdleTimeoutError` | class | `{pending: IngestStats}` | 02 4.10 | same |
| `IngestWriter`, `IngestBatch`, `IngestItem`, `CursorUpdate` | type | `submit(batch) => boolean; onDrain(cb); flushNow(); stats`; one writer per instance (`IngestService.writer`), shared with the sweeper and with 06 `tickAttempts`, which submits `{source: 'external', items: [{kind: 'external', events, rows: []}], bytes: 0}` after its own COMMIT (N-01) | 02 4.6 | `en/ingest/writer.ts` |
| `ChangeSink` | type | `record(entity, key, op); flush(); discard()` | 02 4.6 | implemented by 03 `createChangeSink` |
| `EventRowWrite` | type | input of 03 `EventsRepo.insert` | 02 4.1.2 | `en/ingest/event-row.ts` |
| `eventKindOfEnvelope`, `eventKindOfRecord`, `normalizeEnvelope`, `normalizeRecords` | fn | `eventKindOfEnvelope(env) => EventKind \| null` | 02 4.1.2, section 4.3, section 5.6 | `en/ingest/hooks/normalize-envelope.ts`, `en/ingest/transcripts/normalize-record.ts` |
| `LogicalEvent`, `ToolOutcome` | type | union of `k` kinds, section 11.3 | 02 4.3 | `en/ingest/*` |
| `FileIdentity`, `RawLine`, `ReadResult`, `TailCounters`, `IdentityCheck`, `checkIdentity`, `readLines`, `lineStartAtOrAfter` | type, fn | `readLines(path, from, to, deadline, {chunkBytes, maxLineBytes?, acceptValidUnterminatedTail})` | 02 5.3 | `en/ingest/tail/jsonl-tailer.ts`; used by 06 3.10.3 |
| `projectsRoot`, `sanitizeProjectName`, `detectTranscriptsDir` | fn | `detectTranscriptsDir(repo, root) => Promise<string \| null>` | 02 5.1.1 | `en/ingest/transcripts/discovery.ts`; 01 `discover` |
| `realFirstPrompt` | fn | used by 01 `discover` | 01 6.4 | `en/ingest/transcripts/classify.ts` (implied) |
| `SpoolReplayPlan`, `planSpoolReplay`, `applySpoolReplay` | type, fn | `planSpoolReplay(ctx, repos, spoolDir, from)`; `applySpoolReplay(db, ctx, plan) => {segmentsReset}`; 01 6.4 calls both (stopped instance) or `IngestService.replay` (running, control op `ingest-replay {fromSegment}`) and maps `segmentsReset` to `segments` (C03, C04 resolved) | 02 2.7 | `en/ingest/spool/replay.ts` |
| `TranscriptRef`, `readEntryText` | type, fn | `readEntryText(ref, opts) => entries \| {ok: false, reason: 'REF_STALE' \| 'READ_FAILED' \| 'NOT_FOUND'}` | 02 5.7 | `en/ingest/transcripts/entry-text.ts` (uses 03 `displayEntries`) |
| `claudeArgsWithoutHooks` | fn | `(args) => {args, env}` | 02 2.9 | `en/external/launch-claude.ts` |
| `planHooks`, `applyHooks`, `verifyHooks`, `hooksStatus`, `buildEntry`, `isOurs` | fn | `planHooks(text \| null, op: 'install' \| 'uninstall', desired) => {obj, text, changed, added, replaced, removed, kept, diff}`; `applyHooks` (3.5, settings mutex, backup, atomic write), `verifyHooks` (3.7 V1-V7), `hooksStatus` | 02 3.1, section 3.3-3.7 | `en/hooks/installer/{plan,apply,verify,uninstall,status,settings-io}.ts`, called only by 01 `ops.hooks.*`; `cl/commands/hooks/*.ts` keep option tables and rendering (C23 resolved) |

### 2.5 Tokens and lifecycle (owner 02)

| Name | Kind | Signature | Defined in | Code path |
|---|---|---|---|---|
| `UsageFields`, `UsageAggregate` | type | | 02 6.3 | `en/tokens/aggregate.ts` |
| `aggregateSession`, `aggregateAgent`, `aggregateByModel`, `aggregateByHour`, `aggregateInstance` | fn | `aggregateSession(sessionId, scope: 'own' \| 'agents' \| 'total') => UsageAggregate` | 02 6.3 | same; 06 parity T2 |
| `legacyFileUsage`, `legacyUsageTotal` | fn | `(fileId)`, `(sessionId)` | 02 6.5 | `en/tokens/legacy-projection.ts`; 06 T1 |
| `LifecycleView`, `LifecycleEvidence`, `SessionFacts`, `AgentFacts`, `WorkflowFacts`, `TurnEndInfo` | type | `LifecycleEvidence {source, fact, at, count?, value?}` is the engine form of an evidence item (C18 resolved); `AgentFacts.kind` covers non-main agents only (C56 note) | 02 7.1-7.2 | `en/lifecycle/facts.ts` |
| `mergeFacts`, `derive` (session, agent, workflow) | fn | `derive(facts, rows, now, cfg) => LifecycleView` | 02 7.2-7.6 | `en/lifecycle/{merge,derive-session,derive-agent,derive-workflow}.ts` |
| `fmtAge`, `renderEvidence`, `toApiEvidence`, `viewChanged` | fn | `renderEvidence(item: LifecycleEvidence, now) => string`; `toApiEvidence(item, now) => ApiEvidenceItem`; `viewChanged(a \| null, b) => boolean` | 02 7.1 | `en/lifecycle/rules.ts`; 03 3.6, section 5.5 |
| `toLegacy`, `classifyLegacy`, `legacyDone` | fn | `toLegacy(view) => LegacyState` | 02 7.9 | `en/lifecycle/legacy.ts` |
| `nextCheckAt` | fn | `(view, input, cfg) => number \| null` | 02 7.8 | `en/lifecycle/next-check.ts` |
| `createLifecycleSweeper`, `LifecycleSweeper` | fn, type | `(ctx, deps: {writer}) => {start(), stop(deadlineMs), tickNow()}` | 02 4.10 | `en/lifecycle/sweeper.ts`; 01 4.4a adopts this shape (C06 resolved) |
| work items | fn | rules W-DECL, W-ATT, W-LBL | 02 7.11 | `en/lifecycle/work-items.ts` |
| `explainCompletion`, `CompletionLookup`, `CompletionCandidate`, `AttemptRowRef`, `CompletionTargetError` | fn, type, class | `explainCompletion(lookup, target, now) => CompletionEvidence`; throws `CompletionTargetError('target_invalid' \| 'target_not_found')`, never returns `null`; `attemptPart` 0..512 (empty legal); `AttemptRowRef.sessionId` is the provider id (`sessions.session_uid`) that 03 maps from the row id | 02 7.13 | `en/lifecycle/completion.ts`; 03 `EngineQueries.explainCompletion` builds the lookup (C16, C17 resolved) |
| ingest health computation, alert inputs | fn | no function names are fixed in 02 8.2-8.3 (the 5 s computation returns `IngestHealth`; 03's `EngineQueries.ingestHealth` serves the stored `ingest_health.report_json`) | 02 8.2-8.3 | `en/health/{ingest-health,alert-inputs}.ts` |

### 2.6 Database (owner 03)

| Name | Kind | Signature | Defined in | Code path |
|---|---|---|---|---|
| `SqlValue`, `SqlParams`, `Stmt<R>`, `SqlDriver`, `openSqlite`, `toDbError` | type, fn | `openSqlite(path, {readonly, fileMustExist, timeoutMs}) => SqlDriver` | 03 4.5 | `en/db/driver.ts` (only importer of `better-sqlite3`) |
| `DbError`, `DbErrorCode` | class, enum | section 7.4 | 03 4.3 | `en/db/errors.ts` |
| `RepoContext`, `OpenMode`, `InstanceDb`, `openInstanceDb`, `DB_OPEN_EXIT_CODES` | type, fn, const | `openInstanceDb({path, expectedInstanceId, mode: 'serve' \| 'readonly' \| 'maintenance', runtimeVersion}) => InstanceDb` | 03 4.5 | `en/db/open.ts` |
| `WriteTx`, `withWriteTx`, `onCommitted` | type, fn | `withWriteTx<T>(db, ctx, fn: (tx) => T): T` (03 3.6 prose now says the same; C53 resolved); `onCommitted(db, listener) => unsubscribe` | 03 4.5 | `en/db/write.ts` |
| `ChangeRecorder`, `createChangeSink` | type, fn | `reserve(kind, op, {entityId, sessionUid}) => seq; noteId; noteTranscript; flush`; `createChangeSink(tx) => ChangeSink` | 03 9.1 | `en/db/changes.ts`, `en/db/change-sink.ts` |
| `MigrationFile`, `MigrationStatus`, `loadMigrationFiles`, `migrationStatus`, `peekDbSchemaVersion`, `planDbMigrations`, `migrateDb` | type, fn | `migrateDb(path, {backupDone, runtimeVersion, expectedInstanceId, now?}) => {from, to, durationMs}` | 03 4.3 | `en/db/migrations.ts` |
| `backupDb` | fn | `(src: InstanceDb \| {path, expectedInstanceId}, destPath, opts?) => Promise<{bytes, dbSchemaVersion}>` | 03 4.4 | `en/db/backup.ts` |
| `RetentionPolicy`, `RetentionPlan`, `applyRetention` | type, fn | `applyRetention(db, ctx, policy, {dryRun, now, signal?})` | 03 3.8 | `en/maintenance/retention.ts` |
| `exportInstance` | fn | `(db, ctx, q: ExportQuery, out, signal) => Promise<ExportSummary>` | 03 11.1 | `en/maintenance/export.ts` |
| repositories | class | `MetaRepo ProjectsRepo SessionsRepo AgentsRepo WorkflowRunsRepo TurnsRepo EventsRepo ToolCallsRepo UsageRepo TranscriptFilesRepo CheckpointsRepo TransitionsRepo ReconciliationsRepo ExternalObservationsRepo CostStatesRepo HookProbesRepo WorkItemsRepo IngestHealthRepo IngestErrorsRepo SpoolCursorsRepo AttemptsRepo AlertsRepo ChangesRepo`; every method takes `ctx: RepoContext` first | 03 4.5 | `en/db/repos/*.ts` (never imported outside `en/`) |
| named repository methods | fn | `SessionsRepo.ensure`, `SessionsRepo.writeView`, `SessionsRepo.attemptCandidates(ctx, labels, activeSinceMs) => AttemptCandidate[]`, `SessionsRepo.uidsByRowIds(ctx, rowIds) => Map<number, string>` (row id -> `session_uid`; 06 3.10.2, N-10), `SessionsRepo.completionCandidates(ctx, by: {sessionId} \| {label}) => CompletionCandidate[]` (I-08), `EventsRepo.insert`, `EventsRepo.findByNaturalKey`, `EventsRepo.deleteTranscriptOnly`, `EventsRepo.detachTranscript`, `UsageRepo.applyRecord`, `UsageRepo.verifyRollups`, `TranscriptFilesRepo.updateCursors`, `ReconciliationsRepo.insert` | 03 3.6, 02 4.4, section 5.3 | `en/db/repos/*.ts` |
| `AttemptsRepo`, `AttemptSourceRow`, `AttemptRunRow`, `NewAttemptRun`, `AttemptEndReason`, `AttemptCandidate` | type | `getSource, saveSource, resetSource, openRun, insertRun, endRun, supersedeRun, setMatch, runsToMatch, latestRuns, evidenceRun, runsByPart` (`runsByPart(ctx, part): AttemptRowRef[]`, every generation, for `explainCompletion`); `attempt_runs.session_id` holds the `sessions.id` row id (`AttemptRunRow.sessionRowId`) | 03 3.6 | `en/db/repos/attempts.ts` (06 adapter `en/panels/attempts/repo.ts`, no SQL) |
| `APPLICATION_ID`, `CHECKPOINT_EVERY_ENTRIES`, `WAL_RETRY` | const | 1296253747, 256, `{attempts: 20, delayMs: 25}` | 03 3.3 | `sh/db-constants.ts` |

### 2.7 Query layer, transcript, search, alerts, schedule (owner 03)

| Name | Kind | Signature | Defined in | Code path |
|---|---|---|---|---|
| `EngineQueries` | type | `instanceInfo, health, ingestHealth, errors, overview, listSessions, getSession, sessionSummaries, sessionAgents, listAgents, agentNode, workflowRun, listEvents, getEvent, eventsByIdRange, listToolCalls, toolCallsByIds, sessionTransitions, workItemBoard, getWorkItem, listAlerts, alertRules, usage, sessionUsage, series, tools, hookProbe, explainCompletion` (each `(ctx: RepoContext, ...)`; `getSession` returns `auditRefs: []`; `explainCompletion` has no `null` result and throws `CompletionTargetError`) | 03 12.1 | `en/query/index.ts` |
| `TranscriptQueries` | type | `window, locate, searchSession, searchInstance` (async, with `AbortSignal`) | 03 12.1 | same |
| `AuditReader`, `AuditQueries`, `QueryDeps` | type | `AuditReader.entriesBetween(fromMs, toMs, limit): Promise<AuditRef[]>` (01's `AuditRef`; the old sync `AuditEntry` is gone); `AuditQueries.sessionAuditRefs(detail): Promise<AuditRef[]>`, awaited by the route handler and the DbReader after the snapshot, a rejection gives `[]`; `QueryDeps = {config, now, audit, process?: RuntimeProcessInfo, childStats?, panelStats?}` | 03 12.1 | same |
| `createQueries` | fn | `(db: InstanceDb, deps: QueryDeps) => EngineQueries & TranscriptQueries & AuditQueries`; the server passes all six deps, the CLI DbReader `{config, now, audit}` (C09 resolved) | 03 12.1 | same |
| `displayEntries`, `countEntries` | fn | `displayEntries(record, {textChars}) => Omit<TranscriptEntry,'i'>[]` | 03 7.1 | `en/transcript/entries.ts` |
| `EntryIndexService.ensureIndexed` | fn | `(ctx, fileId, {untilBytes?, budgetMs, signal}) => Promise<{entriesTotal, indexOffset, sizeBytes, complete, reset}>` | 03 7.2 | `en/transcript/index-service.ts` |
| `TranscriptWindowService.read` | fn | | 03 7.3 | `en/transcript/window.ts` |
| search scan | fn | | 03 7.4 | `en/search/{scan,service}.ts` |
| `AlertService.apply` | fn | `(ruleId, scopeKey, r: {holds, severity, value, title, detail, sessionId})` | 03 10.2 | `en/alerts/service.ts` |
| `createDbScheduler` | fn | `(ctx: InstanceContext) => {start(): void; stop(): Promise<void>}`; 01 wraps it as a `RuntimeComponent` named `db-scheduler` (C08 resolved) | 03 11.4 | `en/maintenance/schedule.ts` |

### 2.8 Panels (owner 06)

| Name | Kind | Signature | Defined in | Code path |
|---|---|---|---|---|
| `PanelService`, `AttemptsTickResult`, `createPanelService` | type, fn | `PanelService {get(key, {limit?}), tickAttempts() => AttemptsTickResult, stats() => PanelStats, close()}`; `AttemptsTickResult {state, linesRead, rowsChanged, eventsSubmitted}`; `createPanelService(ctx, deps: {writer: IngestWriter}) => PanelService` (N-01); `tickAttempts` is driven by 01 4.4a's 2 s timer and a call while a tick runs returns that tick's promise | 06 3.4 | `en/panels/service.ts` |
| `SourceSpec`, `SourceResult`, `CacheRead`, `SourceCache` | type, class | `new SourceCache(spec, clock: Clock, errors: ErrorRing)`; `read()`, `abort()`; `Clock` is `sh/time.ts` (I-36) | 06 3.5 | `en/panels/source-cache.ts` |
| `CpuSampler`, `memorySample`, `matchWatched` | class, fn | | 06 3.7.1-3.7.2 | `en/panels/machine.ts` |
| `PROC_SCRIPT_NET`, `PROC_SCRIPT_CLM`, `parseProcLines`, `parsePsOutput` | const, fn | | 06 3.7.3-3.7.4 | `en/panels/proc-{win32,posix}.ts` |
| `parseStatusV2`, git sampler | fn | | 06 3.8 | `en/panels/git.ts` |
| `externalState` | fn | `(exitRaw, statusRaw) => {state: AttemptState, evidence}` | 06 3.10.5 | `en/panels/attempts/state.ts` |
| attempts ingest, match, evidence | fn | one `withWriteTx(db, ctx, fn)` per tick for every `AttemptsRepo` write and the matching (`SessionsRepo.attemptCandidates`, `AttemptsRepo.setMatch`), then `writer.submit` after COMMIT; `matchSticky(rx, line)`, `AttemptsRepo.evidenceRun(sessionRowId)` (the former `evidenceRow`), `publishAt` rule; events `external.attempt {..., endedAt, observedAt}` and `external.attempt_cleared` (C40, C41 resolved) | 06 3.10.3-3.10.7 | `en/panels/attempts/{parse,ingest,match,evidence}.ts` |

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
| `getSession` | `GET /api/v3/sessions/:sessionId` | - | `SessionDetail & {asOfSeq}` | `session_not_found` | 01 `sessions show`, 04; `EngineQueries.getSession` returns `auditRefs: []`, the handler (and the DbReader) awaits `sessionAuditRefs(detail)` after the snapshot and attaches it (I-19) |
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
| `explainCompletion` | `GET /api/v3/completion` | exactly one of `session`, `label` (1..200), `attemptPart` (0..512, present-but-empty allowed; C17 resolved) | `CompletionEvidence & {asOfSeq}` | `400 validation_failed` (also `CompletionTargetError('target_invalid')`), `404 completion_target_not_found` (`target_not_found`); no `null` result | 01 `verify-completion` via `ApiReader`: 400 -> `USAGE`, 404 -> `NOT_FOUND` (C16 resolved) |
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
| `attempt/upsert` | `{ids: number[], truncated}` | `attempt_runs` changed (one reservation per attempts transaction, `AttemptsRepo`) | invalidate attempts panel (06 3.10.2 now cites 03 3.5/9.1; C40 resolved) |

`ChangeSink.record(entity, ...)` mapping (03 9.1): `session`, `turn` -> `session/upsert`; `agent` -> `agent/upsert`; `workflow_run` ->
`workflow/upsert`; `tool_call` -> `tool_call/upsert`; `event` (the one entity name 02 4.6 passes for hook and transcript rows) ->
`event/append` (C59 resolved); `usage` -> `usage/invalidate`; `ingest_health` -> `health/upsert`; `reconciliation` -> `event/append`
(session) or `health/upsert` (instance). The lifecycle effect of an attempt event is a `session/upsert` written by 02's writer in its own
transaction after the attempts transaction commits (N-01); the attempts transaction itself reserves `attempt/upsert`. Limits: 16 streams per instance (17th `503 stream_limit`), eviction after 30 s undrained, frame LRU 512, frame <= 64 KB,
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
| `agents` | `id`; `(session_id, agent_uid)` UNIQUE | `session_id` CASCADE | 02 `agent` | `kind` in `main subagent workflow_agent teammate internal` (02 4.1 lists the same five; C56 resolved); `agent_uid = 'main'` row per session (`SessionsRepo.ensure`) |
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
| `work_items` | `id`; `item_key` UNIQUE | - | 02 7.11, route `workItemBoard` | `kind` `declared attempt label` (API `source` `declared attempts label`, mapped by 03 5.5; C52 resolved); `rule` `W-DECL W-ATT W-LBL` |
| `work_item_sessions` | `(work_item_id, session_id)` PK; `session_id` UNIQUE | both CASCADE | board | a session in at most one item |
| `ingest_health` | `id = 1` | - | 02 8.2 | `report_json`, `counters_json` |
| `ingest_errors` | `id` | - | 02 4.8 | `code = upper(code)`; `source` `spool transcript external writer handler alerts db`; newest 1000 kept |
| `spool_cursors` | `segment` PK | - | 02 `spool_cursor` | `segment GLOB '*.ndjson'`; columns `offset_bytes size_seen ino head_hash lines partial_bytes sealed errors ...` (`offset_bytes` is the owner's spelling, 02 2.7; 01 6.4 describes the reset without a column name) |
| `attempt_sources` | `id`; `path_key` UNIQUE | - | 06 3.10 | no `instance_id` (03 C-1) |
| `attempt_runs` | `id`; `(source_id, generation, start_offset)` UNIQUE | - (soft `source_id`, soft `session_id` = `sessions.id`) | 06 3.10 | `end_reason` `open ended superseded`; `state` `COMPLETED FAILED RUNNING UNKNOWN`; `session_id` is the `sessions.id` row id; 06 3.10.2 now points here instead of copying the DDL (C40 resolved) |
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
`idx_alerts_session` (partial), `idx_changes_at`. Total with autoindexes: 52 (03 X14). 06 3.10.2 and 3.10.8 use these names (the obsolete
`attempt_runs_by_*` names are gone; C40 resolved). 03 O-5: the label and part lookups of `explainCompletion` scan `sessions` and
`attempt_runs`; a later migration may add `idx_sessions_label` and `idx_attempt_runs_part` if DA-T-API-15 measures more than 5 ms
(`0001` stays frozen).

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
| `window_hours` | number > 0 | 8 | derived `import.lookbackHours`, API `window=1`, `InstanceInfo.windowHours` (Node only: the derived `import.lookbackHours` must be an integer 1..8760, so a fractional value that legacy accepts is refused with a `CONFIG_INVALID` message naming the R key to set; N-04, 01 1.6 and open item 6) |
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
| `attempts` | null or `{start, end, label_prefix?, time_format?}` | null | 06 3.10.1 (`time_format` is checked by `pyStrptimeValidate` and reported as `CONFIG_INVALID`; C42 resolved) |
| `watched_processes` | list of strings | 9 image names | 06 3.7.2 |
| `docker` | boolean | true | 06 3.7.5 |
| `ui` | `{theme, density, newest_first, show_tools, show_thinking, show_prompts}` | `auto, comfortable, true, true, false, false` | `InstanceInfo.ui` (camelCase) |
| `poll` | `{events_ms, sessions_ms, machine_ms, logs_ms, overview_ms, attempts_ms, stale_after_ms}` | `1500, 6000, 2000, 3000, 5000, 6000, 15000` | `InstanceInfo.poll` (`transcriptMs` = `events_ms`, `overviewMs` = `overview_ms`, `sessionsMs`, `machineMs`, `logsMs`, `attemptsMs`, `healthMs` = 5000; C26 resolved), `staleAfterMs` = `stale_after_ms` (C50 resolved) |
| `limits` | `{event_window_mb, max_events, text_chars, usage_scan_budget_ms, usage_max_mb}` | `8, 20000, 6000, 1500, 512` | derived `import.tailWindowBytes` (Node only: `event_window_mb` below 1 is refused unless `import.tailWindowBytes` is set), `import.backfillMaxBytes`; `textChars` |

Merged per sub-key: `panels ui poll limits` (`L_MERGED`). Keys starting with `_` are ignored. Node-only validation additions (01 2.4;
all reported as `CONFIG_INVALID` problems, never as codes of their own): `attempts.time_format` unsupported directive; on win32 a path
value (`repo`, `transcripts_dir`, `chain_log`, `ledger`, `stop_file`, `live_log_globs[i]`) starting with `/<letter>/`; an L value whose
derived R key falls outside the owner's bounds. Flat configs are not loaded by Node at all (served by `$V`, 01 6.5; N-05).

### 6.2 Runtime R keys (`<ws>/runtime.json`, schema_version 1; skill layer `<skill>/runtime/defaults.json`)

| Key | Type | Default | Range (the owner's table is normative; 01 1.6 copies it) | Semantics owner | Notes |
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
| `hooks.spoolWhileStoppedHours` | int | 72 | 0..720 (0 = stop spooling at once) | 02 2.6.2 | C02 resolved |
| `ingest.queueMaxItems` | int | 5000 | 100..100000 | 02 4.7 | |
| `ingest.queueMaxBytes` | int | 33554432 | 1 MiB..512 MiB | 02 4.7 | |
| `spool.pollMs` | int | 500 | 100..10000 | 02 2.7 | |
| `spool.sealGraceMs` | int | 120000 | 10000..3600000 | 02 2.7 | |
| `spool.retainHours` | int | 24 | 1..720 | 02 2.7 | |
| `import.lookbackHours` | int or null | derived `window_hours` | 1..8760 | 02 5.1.2 | a fractional `window_hours` is refused (N-04) |
| `import.tailWindowBytes` | int or null | derived `limits.event_window_mb` x 1 MiB | 1 MiB..4 GiB | 02 5.5 | `event_window_mb` < 1 is refused (N-04) |
| `import.backfillMaxBytes` | int or null | derived `limits.usage_max_mb` x 1 MiB | 0..64 GiB | 02 5.5 | |
| `import.headMaxBytes` | int | 16777216 | 1 MiB..256 MiB | 02 5.2, section 5.5 | |
| `import.untrackAfterHours` | int | 48 | 1..8760 | 02 5.1.2 | |
| `import.discoveryIntervalMs` | int | 5000 | 1000..600000 | 02 5.1.2, section 5.4 | |
| `import.scanIntervalMs` | int | 1000 | 250..60000 | 02 5.4 | |
| `import.sliceMs` | int | 20 | 5..200 | 02 5.4 | |
| `import.backfillShare` | number | 0.25 | 0.05..1 | 02 5.4 | |
| `health.importLagWarnMs` | int | 30000 | 1000..3600000 | 02 8.2 | |
| `health.backlogWarnMs` | int | 10000 | 1000..3600000 | 02 8.2 | |
| `analytics.usageTrend` | boolean | false | - | 03 6.2, 04 4.4.6 | `InstanceInfo.features.usageTrend` |
| `board.items` | `{key, title, match: {labels?, labelPrefix?, sessionIds?, attemptParts?}}[]` | `[]` | owner schema | 02 7.11 | 04 S-8 |
| `panelOptions.attemptsWindowHours` | int | 24 | 1..8760 | 06 3.5 (key table), 3.10.3 | owner `'06'` in `R_KEY_CATALOGUE`; module written by 01 S1 |
| `panelOptions.machineProcessIntervalMs` | int | 20000 | 10000..300000 | 06 3.5 | owner `'06'` |
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
(identity), `import.tailWindowBytes`, `import.backfillMaxBytes` (`mib-to-bytes`, `Math.floor(v * 1048576)`). A derived value that the
owner's bounds reject gives `CONFIG_INVALID` `runtime: <R key> derived from <from> (<value>): <zod message>; set <R key> in
runtime.json`. No `server.devOrigins`, no `server.bindHost` (I-31), no `import.maxLineBytes` (the cap is the constant `MAX_LINE_BYTES`;
C01 resolved).

Authority (C02 resolved, N-03, N-04): for every key owned by 02, 03 and 06 the owner's table (02 1.2, 02 7.8 and 7.11, 03 3.8, 8.3 and
10.1, 06 3.5) is normative for semantics, type, range and default; 01 S1 transcribes it into `sh/config/runtime/<section>.ts` and
registers it in `R_KEY_CATALOGUE`; the ranges of `lifecycle.*` are 01's because 02 7.8 states none. `runtime-sections.contract.test.ts`
fails when a catalogue row differs from this table, so a change of a key is made in the owner's table, in the module and in this
table in one commit. Totals: 9 `import`, 3 `spool`, 2 `health`, 1 `analytics` keys (15 new keys of revision 2 minus the removed one).

### 6.3 Environment variables (the closed list `DOCUMENTED_ENV_VARS`, 01 2.10)

There is no `MCS_E2E_PORT` (I-27, N-02; C31 superseded): the Playwright specs start their instances with `$MCS init`/`start` on ports
from `allocatePort([18500, 18599])` (04 11.4, 05 4.5) and the config has no `webServer`.

| Variable | Scope | Reader | Effect | Defined in |
|---|---|---|---|---|
| `MCS_LOG_LEVEL` | runtime | config resolution, logger | `logLevel` (layer env) | 01 2.10, 05 S-LOG-1 |
| `MCS_HOOK_DISABLE` | runtime | hook stub and handler | `1` = exit 0 without work; set for every child and the server | 01 2.10, 02 2.9 |
| `MCS_HOME` | runtime | `resolveMcsHome(env)` | per-user state folder | 02 2.6.1 |
| `CLAUDE_CONFIG_DIR` | runtime (non-MCS) | discovery, installer user scope, external pollers | Claude home (default `~/.claude`) | 01 2.10, 02 1.3 |
| `MCS_FS_WATCH` | runtime | `createWatchHint` | `0` = no `fs.watch` hint | 06 4.4 |
| `MCS_LAUNCHER_NO_BOOTSTRAP` | runtime | launcher | accepted and ignored (ADR 0062 item 4); removed by the cleanup area | 01 5.1 |
| `MCS_LAUNCHER_MODE` | runtime | launcher | `bundle` or `dev` forces the runtime the launcher imports (default: the bundle when it exists, else a checkout's `dist`) | ADR 0062 item 4 |
| `MCS_DEBUG` | runtime | CLI, launcher | `1` = stack traces | 01 2.10 |
| `MCS_TEST` | test | `testHook`, installer and hooks CLI guards | `1` = test mode | 01 2.10, 02 3.5 |
| `VITEST` | test (non-MCS) | installer guard | same guard effect as `MCS_TEST` | 01, 02 |
| `MCS_TEST_IGNORE_CONTROL` | test | control channel | ignore `shutdown` (T-LC-06) | 01 2.10 |
| `MCS_TEST_BOOT_HANG` | test | server boot | stop before `ready` (T-LC-08) | 01 2.10 |
| `MCS_TEST_INIT_CRASH` | test | `ops.workspace.init` | `before-rename` -> exit 70 (T-LC-10) | 01 2.10 |
| `MCS_TEST_CASES` | test | lifecycle property tests (`engine/src/lifecycle/properties.test.ts`) | cases per scenario template, default 500; 1 replays one failing seed together with `MCS_TEST_SEED` | LF-3 |
| `MCS_PERF_FACTOR` | test | performance tests | budget multiplier (default 1) | 01 2.10, 02 2.10 |
| `MCS_E2E_CLAUDE` | test | optional real-provider E2E | `1` enables | 02 3.7 |
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
| `validation_failed` | 400 | route zod schema, nudge body, `CompletionTargetError('target_invalid')` | `API_ERROR` (completion route: `USAGE`, 01 6.4) |
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
| `csrf_rejected` | 403 | reserved (no mutating UI route in v3); exempt from the DA-T-API-3 meta-test, produced by 05 SEC-05 on a test app | - |
| `route_not_found` | 404 | unknown `/api/*` path (also legacy `/api/sessions`) | - |
| `session_not_found` | 404 | session routes | `null` in `InstanceReader.session` |
| `agent_not_found` | 404 | `agent` filter, transcript routes | |
| `event_not_found` | 404 | `getEvent`, `around`, locate without entries | |
| `work_item_not_found` | 404 | `getWorkItem` | |
| `alert_not_found` | 404 | reserved: no v3 route raises it; exempt from the DA-T-API-3 meta-test (03 5.2; N11 resolved) | |
| `panel_disabled` | 404 | `panel` route when `config.panels[...]` is not `true` | 04 removes the panel |
| `probe_not_found` | 404 | `ingestProbe` | `hooks verify` V7 keeps polling |
| `completion_target_not_found` | 404 | `explainCompletion` (`CompletionTargetError('target_not_found')`) | `NOT_FOUND` (01 6.4) |
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

### 7.2 CLI error codes (owner 01 6.2, `sh/errors.ts`, union `CliErrorCode`; C19 resolved)

All exit 1 except `USAGE` (exit 2). Emitted in `CliEnvelope.error.code`.

| Code | Raised by (01 section) | Proc exit when raised at boot |
|---|---|---|
| `USAGE` | parser, `--set` without `=`, `ingest replay --from` bad name, completion `target_invalid` (an invalid id, a label or `attemptPart` longer than the bound; through the API reader a 400 `validation_failed`) | - |
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
| Node-only config validation (no codes of their own) | `CONFIG_INVALID` problems with the messages `attempts.time_format: unsupported directive %X (supported: ...)`, `<key>: use C:/... instead of /c/...`, `runtime: <R key> derived from ...` | 01 2.4 and 1.6 (06 3.10.1 and 4.1 supply the checks; `E_ATTEMPTS_TIME_FORMAT` and `E_MSYS_PATH` do not exist; C42 resolved) | `en/config/validate-legacy.ts`, `en/config/resolve.ts` |
| Completion | `target_invalid`, `target_not_found` (`CompletionTargetError`; HTTP 400 `validation_failed` / 404 `completion_target_not_found`; CLI `USAGE` / `NOT_FOUND`; C16 resolved) | 02 7.13 | `en/lifecycle/completion.ts` |
| Entry text | `REF_STALE`, `READ_FAILED`, `NOT_FOUND` | 02 5.7 | `en/ingest/transcripts/entry-text.ts` |
| Ingest health reasons | `HOOKS_FAILING`, `HOOK_GAP`, `IMPORT_LAG`, `BACKFILLING`, `SPOOL_BACKLOG`, `DB_ERROR`, `TRANSCRIPTS_NOT_FOUND`, `PROVIDER_SILENT`, `EVENT_LOOP_SLOW` | 02 8.2 | `IngestHealth.reasons[].code` |
| Alert input codes | `no_activity`, `ingest_errors_repeated`, `runtime_unavailable`, `import_lag`, `hook_gap`, `hook_failing`, `db_error`, `disk`, `token_threshold` | 02 8.3 | consumed by 03 10.1 rules |
| Alert rule ids | `inactivity`, `ingest_errors`, `runtime_unavailable`, `token_threshold`, `import_lag`, `db_disk`, `hook_gap`, `hook_failing` | 03 10.1 | `alerts.rule_kind` |
| Doctor check names | `node >= 22.22`, `runtime build is current`, `config loads and validates`, `regexes translate exactly`, `transcripts folder found`, `recent transcripts parse`, `rules match at least one session`, `chain_log exists`, `ledger exists`, `instance identity is consistent`, `database integrity`, `state file is current` / `running runtime answers`, `no recent server errors`, `runtime is not outdated`, `no ownership conflict`, `hooks installed and verified for this instance`, `spool backlog below threshold`, `free disk space >= 1 GiB`, `workspace is git-ignored`, `workspace is not writable by other users`, `task <slug> audit` | 01 6.4 | `ops.diagnostics.doctor` |
| Hooks verify checks | `V1`..`V7` | 02 3.7 | `HooksVerifyResult.checks` |
| Log events named in designs | `runtime ready`, `ownership_conflict`, `state_file_restored`, `component_stop_failed`, `shutdown deadline exceeded at step N`, `audit_truncated`, `previous run ended without a clean shutdown` | 01 4.4-4.6, section 7.1 | logger `event` field |
| Gate exit codes | `77` = SKIPPED (a gate that cannot run yet: `scripts/smoke.mjs` before 01 S8/S9 are built; `ci.mjs` prints `SKIPPED (exit 77)`, never PASS); `ci.mjs --strict` turns SKIPPED into a failure; `parity-capture` exits 0 identical, 1 drift, 2 no usable Python | 05 3.2, 8.1, 4.11.4, ADR 0048 | `runtime/scripts/{smoke,ci,parity-capture}.mjs` |

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
| `start` | `--task`, `--port`, `--log-level`, `--open`, `--timeout-ms` | `started: <url> (pid N)` | `ops.lifecycle.start` | `--open` hands `http://127.0.0.1:<port>/` to ChildKind `opener` (`resolveExecutable('opener')`; the exit code is advisory; C11 resolved) |
| `serve` | `--task`, `--port`, `--log-level`, `--open`, `--state-file` (ignored) | foreground | `ops.lifecycle.serveForeground` | |
| `verify` | `--task` | `verified <url>: ...` | `ops.lifecycle.verify` | 5 endpoints schema-validated |
| `status` | `--task` | legacy JSON + new keys (`StatusReport`) | `ops.lifecycle.status` | exit 0 iff running |
| `stop` | `--task`, `--timeout-ms` | legacy line | `ops.lifecycle.stop` | |
| `restart` | as `start` | two lines | `ops.lifecycle.restart` | |
| `doctor` | `--task` | JSON array `{check, ok, detail, level}` | `ops.diagnostics.doctor` | names section 7.6 |
| `instances list` | `--repo`, `--no-probe` | table | `ops.instances.list` | `InstanceRow[]` |
| `instances set-engine` | `--task`, `node\|legacy`, `--yes` | text | `ops.instances.setEngine` | |
| `instances repair` | `--task`, `--yes` | text | `ops.instances.repairIdentity` | |
| `config migrate` | `--task` or `--from-legacy FILE --name N [--slug] [--description]`, `--dry-run`, `--yes` | text | `ops.config.migrate`, `ops.config.importLegacy` | `--from-legacy` validates strictly, lists the dropped keys and refuses a pattern that does not translate exactly (`REGEX_UNSUPPORTED`, nothing written); Node never loads a flat config leniently (N-05) |
| `upgrade` | `--task`, `--dry-run`, `--yes`, `--restart` | text | `ops.upgrade.run` | |
| `db migrate` | `--task`, `--dry-run`, `--yes` | text | `ops.upgrade.migrateDb` | npm script `migrate` |
| `db rebuild` | `--task`, `--yes`, `--confirm SLUG` | text | `ops.upgrade.rebuildDb` | defined by 01 5.4 (`dbCopy: 'raw'` backup, T-CLI-12); 06 7.1 item 6 uses `$MCS stop` -> `db rebuild --task X --yes --confirm X` -> `$MCS start` (C44 resolved) |
| `ingest replay` | `--task`, `--from SEGMENT`, `--yes` | text | `ops.ingest.replay` | stopped: `planSpoolReplay` + `applySpoolReplay`; running: control op `ingest-replay {fromSegment}` -> `IngestService.replay`; `segmentsReset` is printed and replied as `segments` (C03, C04 resolved); audit template of 01 7.2 (C05 resolved) |
| `hooks install` | `--scope project-local\|user`, `--settings-file PATH`, `--task`, `--sync-tool-events`, `--yes`, `--dry-run` (explicit spelling of the default dry run), `--json` | plan/result | `ops.hooks.install` | -> 02 `planHooks` + `applyHooks` in `en/hooks/installer/`; the CLI module renders only (C23 resolved) |
| `hooks verify` | same selectors, `--json` | report | `ops.hooks.verify` | V1-V7 (V4 and V6 spawn through `execFileText` kind `node`; V6 passes the probe payload as `ChildSpec.stdin`, C60 resolved) |
| `hooks uninstall` | same + `--yes`, `--dry-run`, `--json` | plan/result | `ops.hooks.uninstall` | |
| `hooks status` | `--task`, `--json` | installed scopes, handler log summary, last envelope per instance (`HooksStatusResult`) | `ops.hooks.status` | exit 0 always; row exists in 01 6.3 (C23 resolved) |
| `hooks enable` / `hooks disable` | `--task` | text | `ops.hooks.setEnabled` | writes `instance.json.hooks.enabled`, route file |
| `sessions list` | `--task`, `--state`, `--since`, `--limit`, `--all` | table | `InstanceReader.sessions` | |
| `sessions show` | `--task`, `--session ID`, `--events N`, `--include-text` | text | `InstanceReader.session` | |
| `errors` | `--task`, `--since`, `--limit` | lines | `InstanceReader.errors` | |
| `diagnostics` | `--task`, `--out FILE` | path | `ops.diagnostics.bundle` | `mcs.diagnostics/1`; 05 S-SEC-4 names `mcs diagnostics` (C55 resolved) |
| `export` | `--task`, `--out FILE`, `--format`, `--since`, `--until`, `--session`..., `--include-content`, `--force` | summary | `InstanceReader.exportTo` | refuses `*.jsonl` inside a workspace |
| `backup [create]` / `backup list` / `backup restore` | `--label`; `--verify`; `--id ID --include-runtime-config --yes` | text | `ops.backup.*` | |
| `cleanup` | `--task`, `--scope stale-state\|init-leftovers\|logs\|backups\|spool\|data`, `--older-than`, `--keep`, `--dry-run`, `--yes`, `--confirm SLUG` | plan/result | `ops.cleanup.run` | `data` calls 03 `applyRetention` |
| `usage` | `--task`, `--session`, `--by session\|model\|day\|tool`, `--since`, `--until` | table | `InstanceReader.usage` | |
| `verify-completion` | `--task`, one of `--session ID` / `--label TEXT` / `--attempt PART` (<= 512 characters), `--expect completed\|failed\|terminal` | verdict | `InstanceReader.explainCompletion` | `target_invalid` -> `USAGE` exit 2, `target_not_found` -> `NOT_FOUND` exit 1; `sessionId: null` prints `attempt <part>` (C16 resolved) |
| `version` | `--short`, `--json` | `mcs 3.0.0 (code ..., node ..., build current)` | `ops.version` | launcher answers `--version` without a build |
| `help` | `[command]` | text | parser tables | |

Legacy delegation (01 6.5): `--config FILE` forms, `--discover`, and instances with `engine = legacy` (`start stop status verify restart
serve check doctor --task`) run `python <skill>/template/viewer.py ...` (`$V`). `InstanceInfo.commands` keys (01 6.6): `status`,
`restart`, `inspect`, `export` (`--out "<ws>/logs/export.ndjson"`), `backup`, `cleanupDryRun` (`cleanup --task <slug> --scope logs`).

Audit actions (01 7.2): `init-task`, `adopt-instance`, `configure`, `config-migrate`, `config-import`, `upgrade`, `db-migrate`,
`backup`, `backup-restore`, `cleanup`, `engine-switch`, `hooks-enable`, `hooks-disable`, `hooks-install`, `hooks-uninstall`,
`instances-repair`, `db-rebuild`, `ingest-replay` (02 2.7 step 5 uses this template verbatim; C05 resolved), decision entries (title `configuration` for
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
| `data/exports/` (`.tmp-<random>.db`) | dir (temp files) | server export route snapshot | 03 11.1; listed in 01 1.1 as runtime-mutable; `cleanup --scope stale-state` deletes `.tmp-*` older than 10 min (C39 resolved) |
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
| `rt/packages/engine/src/hooks/installer/{plan,apply,verify,uninstall,status,settings-io}.ts` | 02 1.1, section 3 | installer engine modules called only by 01 `ops.hooks.*` (C23 resolved); `cl/commands/hooks/{install,uninstall,verify,status}.ts` keep option tables and rendering |
| `rt/scripts/gen-schemas.mjs` | 01 2.9, 05 3.1 | the one schema generator: config, CLI and `schemas/api/**`; `npm run schemas` and `schemas:check` (C45 resolved) |
| `rt/packages/web/e2e/playwright.config.ts`, `e2e/specs/*.spec.ts` | 04 11.4, W14 | no `webServer`, no port variable; specs start instances with `$MCS` on `allocatePort([18500, 18599])` (replaces 05 A.28; C31, C58 resolved) |
| `<skill>/schemas/{config,runtime,instance,state,backup-manifest,cli-envelope,diagnostics}.v1.schema.json`, `schemas/api/<routeId>.{params,query,body,response}.schema.json`, `schemas/api/stream.schema.json`, `schemas/export/<type>.schema.json` | 01 2.9, 03 13 | `$id` prefix `https://monitoring-claude-sessions.local/schemas/` |
| `<skill>/docs/api/reference.md` | 03 13 | generated |
| `tests/legacy-parity/{README.md,tools/*.py,golden/**}` | 06 5.2.1 | goldens committed by the lead |
| `tests/legacy-parity/pyjson/`, `tests/legacy-parity/regex/` (`gen_*_golden.py`, `regex-golden.json`, `regex-rejects.json`) | 01 1.9, section 2.8 | golden data only; the tests are `rt/tests/parity/{pyjson,pyregex}.golden.test.ts` because `@mcs/*` resolves only under `runtime/` (N-07, 05 C-3); the cross-engine tests are `rt/tests/parity/cross-engine.parity.test.ts` (01 S15) |
| `rt/tests/{isolation,resilience,security,parity,tooling}/` | 05 4.3 | isolation: 05 owns only `_setup.ts` (`twoInstances`) and the project wiring, every `*.test.ts` belongs to the 01 slice of its T-ISO rows, `hook-routing-isolation.test.ts` to 02, `data-*.test.ts` to 03 (N-07); parity: base modules 05 S8, `*.golden.test.ts` 01 S2/S3, `*.parity.test.ts` 06 |
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
| Node floor | 22.22.0 (engines `^22.22.0 \|\| ^24.0.0 \|\| >=26.0.0`); message `ERROR: Node >= 22.22.0 is required (found <v>); install the Node 24 LTS` | | 01 5.1, 05 2.5, 3.2, 06 3.9.4, 7.1 and T21 (C28 resolved) |

### 10.4 Panels, platform, UI

| Constant | Value | Defined in |
|---|---|---|
| panel TTLs | memory/cpu 1800 ms; processes `machineProcessIntervalMs` (20000); docker 15000; git.status 15000; git.log on HEAD change or 120000; stopFile 2000; ledger/chainLog 5000; logs 2000; attempts read 2000 (ms) | 06 3.5 |
| child semaphore | 2 running, FIFO 8, then `QUEUE_FULL` | 06 3.6 |
| child defaults | timeout 10 s (CIM 20 s), output cap 1 MiB | 05 S-PROC-5 |
| `resolveExecutable` cache | 10 min (null 5 min) | 06 3.6 |
| `commandLineOf` cache | 5 s per pid, 64 entries | 06 4.2 |
| attempts read slice | 8 MiB per tick, `maxLineBytes` 1 MiB, ticks every 2000 ms (01 4.4a timer, serialized, skipped while a tick runs) | 06 3.10.3, section 3.4; 01 4.4a |
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
| engine evidence item | `{source, fact, at, count?, value?}` | - | named `LifecycleEvidence` in 02 (the API form is 03's `EvidenceItem`; C18 resolved) |
| `ProbeState` (process, owner 01 4.8) | `running starting stopping unhealthy stopped stale foreign-pid legacy-running legacy-stale` | `status` JSON `probe` | - |
| `ControlPhase` (owner 01 4.3) | `starting ready stopping` | - | - |
| Board states | `working waiting completed failed stale unknown` | - | columns of `/tasks` |
| Agent kinds | 03 3.5 and 02 4.1: `main subagent workflow_agent teammate internal` (`main` created by `SessionsRepo.ensure`, `teammate` reserved; C56 resolved) | - | `internal` hidden by default |

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
`external.registry` (`busy idle waiting`), `external.job`, `external.attempt` (carries `endedAt` + `observedAt`; C41 resolved),
`external.attempt_cleared`, `external.pid`, `info` (`task_created task_completed teammate_idle model_switch cwd_changed queued_command
away_summary local_command`). Producers outside 02: 06 `PanelService.tickAttempts` (`external.attempt*`), submitted through `IngestWriter` after the attempts COMMIT (N-01).

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
| latent defects | D1-D35 (06 5.8) = PD1-PD7 (05 4.11.5); D3 / PD3 (lenient flat configs) are N/A in Node (N-05) | 06 5.8, A0055 |

## 12. Test helpers, testkit exports, fixtures, test ids

### 12.1 `@mcs/testkit` (owner 05 4.4 core, 06 6 additions, 04 11.5 demo contract)

| Name | Kind | Signature / notes | Module | Owner |
|---|---|---|---|---|
| `TempDir`, `makeTempDir`, `useTempDirs` | type, fn | `makeTempDir(purpose)` writes `FIXTURE.md` | `tk/temp.ts` | 05 |
| `PortRange`, `VITEST_PORTS`, `allocatePort`, `assertPortClosed` | type, const, fn | `allocatePort(range?: PortRange)`: default `VITEST_PORTS` (block of 50 per `VITEST_POOL_ID`), another range is scanned from its start (`allocatePort([18500, 18599])` for Playwright); the only free-port helper, `findFreePort` does not exist (C32 resolved) | `tk/ports.ts` | 05 |
| `waitFor`, `eventLoopLagProbe` | fn | default 5000 ms / 25 ms | `tk/wait.ts` | 05 |
| `FakeClock`, `FIXTURE_EPOCH_MS` | class, const | `implements Clock` (imports `type Clock` from `@mcs/shared`, `sh/time.ts`; C27 resolved); `Date.UTC(2026, 0, 1)` | `tk/clock.ts` | 05 |
| `TrackedProcess`, `spawnTracked`, `killAllTracked`, `runCli` | type, fn | `runCli(args, {mcsHome, cwd?, env?})` runs `packages/cli/dist/main.js` with `MCS_HOOK_DISABLE=1` | `tk/processes.ts` | 05 |
| `hermeticEnv`, `StartedInstance`, `startInstance`, `spawnImpostor`, `makeJunction` | fn, type | `hermeticEnv(root)` (minimal env: `MCS_HOME`, `CLAUDE_CONFIG_DIR` and `HOME` in the temp root, `MCS_HOOK_DISABLE=1`, `TZ=UTC`, nothing inherited from `MCS_*`/`CLAUDE_*`); `startInstance(ws: {repo, slug, env}, {port}) => StartedInstance {repo, slug, port, pid, stop()}` (real `$MCS start`, waits for `/api/v3/health` 200, `stop()` = `$MCS stop` + `assertPortClosed`); `spawnImpostor(argv) => TrackedProcess`; `makeJunction(link, target)` (win32 `fs.symlinkSync(target, link, 'junction')`, no shell; 01 3.5 still says `cmd /c mklink /J`: C62 OPEN) | `tk/isolation.ts` | 05 (C33 resolved) |
| `httpRequest`, `readSse` | fn | `agent: false` | `tk/http.ts` | 05 |
| `UsageFixture`, `TranscriptBuilder`, `bigTranscript` | type, class, fn | builder methods `user assistant toolUse toolResult turnEnd interrupt apiError compact bookkeeping agentLaunch raw invalidLine lines write appendTo`; 06 requests `assistant({outputPerRecord, zeroTopLevel, booleanUsageField, final})`, `taskNotification` | `tk/transcript.ts` | 05 (+06 6.2) |
| `SessionSpec`, `ClaudeHome`, `buildClaudeHome` | type, fn | `keyDecoys` writes `sessions/<pid>.key` | `tk/claude-home.ts` | 05 |
| `HookEventName`, `hookPayload`, `RunHookOptions`, `runHookHandler` | type, fn | `runHookHandler(payload, {mcsHome, event?, async?, direct?, env?, rawStdin?})` spawns the stub (or `dist/hook.js` with `direct`) | `tk/hooks.ts` | 05 |
| `buildRepo`, `buildTaskWorkspace`, `snapshotTree` | fn | `buildTaskWorkspace(repo, {slug, config, runtime?, instance?})` | `tk/workspace.ts` | 05 |
| `DemoLetter`, `DemoOptions`, `DemoSession`, `DemoResult`, `buildDemo` | type, fn | letters `A..H`; options `{root, nowMs, letters?, project?}`, repeated verbatim by 05 4.4 (no `now`, no `runtimeJson`; C34 resolved) | `tk/demo.ts` | 04 (contract), 05 (host) |
| `CANARY`, `scanForCanaries` | const, fn | `prompt toolResult thinking key envToken attachment query` | `tk/canary.ts` | 05 |
| `pyDumps`, `pyIso`, `detUuidSequence` | fn | Python `json.dumps` compatible | `tk/pyjson.ts` | 06 |
| `setAge`, `freezeUntouched`, `appendWithOpenHandle`, `treeManifest`, `ManifestRow` | fn, type | | `tk/io.ts` | 06 |
| `UsageTotals`, `SessionExpectation`, `ScenarioExpectation` | type | `LegacyState` imported from `@mcs/shared` (C36 resolved) | `tk/expect.ts` | 06 |
| `buildBigTranscript` | fn | 70 MB = 62,735 lines | `tk/big.ts` | 06 |
| `ScenarioId`, `ScenarioSession`, `ScenarioResult`, `buildScenario`, `listScenarios` | type, fn | L-FIX L-DEMO L-PANELS L-RULES L-REGISTRY S01-S34 (+S06b) | `tk/scenarios/index.ts` | 06 |
| `buildLegacyFixtureHome`, `buildLegacyDemo`, `buildPanelsTree`, `buildRulesTree`, `buildRegistryHome` | fn | `@mcs/testkit/legacy` subpath, exported by 05 2.2 and A.21 (C46 resolved) | `tk/legacy/*`, `legacy/ORDER.md` | 06 |
| testkit CLI | entry | `node rt/packages/testkit/dist/cli.js list \| demo \| scenario \| big` | `tk/cli.ts` | 06 6.4 |
| names used by 01 3.5 | fn | `tempRoot()` = `makeTempDir`, `makeWorkspace()` = `runCli(['init', ...])`, `snapshotWorkspace()` = `snapshotTree(dir, {exclude: RUNTIME_MUTABLE_PATHS})`; `hermeticEnv`, `startInstance`, `spawnImpostor`, `makeJunction` are exported (row above); `listRuntimeProcesses` is 01's `platform/markers.ts` | 01 3.5 | 01 uses, 05 owns (C33 resolved) |

### 12.2 Other test helpers and harness modules

| Name | Owner | Code path |
|---|---|---|
| `FakeEventSource`, `renderWithProviders`, `createFakeApi`, fixture factories `makeSession makeAgent makeEvent makeTranscript makeHealth` | 04 11 | `wb/test/{fake-event-source,render,fake-api}.ts(x)`, `wb/test/fixtures/*.ts` (header `// FIXTURE: invented data for tests`) |
| `twoInstances({sameRepo?})` | 05 4.8 (slice S9) | `rt/tests/isolation/_setup.ts`: builds instances A and B with testkit (`makeTempDir`, `hermeticEnv`, `buildDemo` or `buildRepo`, `runCli(['init', ...])`), starts both with `startInstance` on `allocatePort()` ports and registers `afterAll` stops plus `assertPortClosed`; the only isolation file 05 owns (N-07) |
| lint rule `PLATFORM_ENTRY` (`no-restricted-properties` on `process.platform`) and the `os.platform()` `no-restricted-syntax` entry | 05 2.6, A.9 (the rule is specified by 06 4, critic I-34) | `rt/eslint.config.js`: error in `engine/src/**`, allow-list `engine/src/platform/**` and `engine/src/security/paths.ts`, logger block `['error', PLATFORM_ENTRY]`; regression test `engine/src/platform/platform-branching.test.ts` (06 PP1) |
| `SessionProjection`, `EventsProjection`, `SearchProjection`, `AttemptsProjection`, `ConfigRegexProjection`, `WorkspaceFilesProjection`, `Mismatch`, `compareProjection` | 05 4.11.3 | `rt/tests/parity/projections.ts` |
| `FROZEN_NOW_S` (1790000000), `NormalizeContext`, `normalizeText`, `normalizeValue`, `goldenDir`, `readGoldenApi` | 05 4.11.3 | `rt/tests/parity/normalize.ts` |
| `PythonInfo`, `findPython`, `runCapture` | 05 4.11.4 | `rt/tests/parity/run-python.ts` |
| `referenceUsage`, `runVectorFile`, legacy shapes | 06 5.4-5.5, PP4 | `rt/tests/parity/{reference-usage,vectors,legacy-shapes}.ts` |
| golden generator | 06 5.2 | `tests/legacy-parity/tools/{capture_golden,determinism,vectors,panel_scenarios}.py`; vectors `golden/vectors/*.json` |
| engine fixture builders | 02 9.1 | `rt/packages/engine/test/fixtures/{transcripts,hooks,hook-sequences,spool,external}.ts`, `rt/packages/engine/test/fixtures/settings/*.json` (the installer moved to the engine), `rt/packages/engine/test/fixtures/db/{schema.snapshot.sql,v<N>.db}` (03) |
| seeded PRNG | 02 7.12 | `rt/packages/engine/test/support/prng.ts` (mulberry32) |
| `lint-rules`, `check-deps`, `build-stamp`, `ci-script`, `parity-capture`, `env-vars` tests | 05 4.3 | `rt/tests/tooling/*.test.ts` |

### 12.3 Test id prefixes (one id space per prefix)

| Prefix | Owner | Range |
|---|---|---|
| `T-ISO-`, `T-XE-`, `T-UP-`, `T-CLI-`, `T-AU-`, `T-SEC-`, `T-LC-` (process lifecycle) | 01 | T-ISO-01..27, T-XE-01..07, T-UP-01..10, T-CLI-01..13, T-AU-01..06, T-SEC-01..05, T-LC-01..16 |
| `T-HK-`, `T-IN-`, `T-PL-`, `T-TR-`, `T-TK-`, `T-HE-`, `T-LF-` (lifecycle model), `P1-P9`, `CE-1..17` | 02 | `T-LF-01..57`, renamed from `T-LC-` so that 01's `T-LC-01..16` (process lifecycle) stay unique (C37; 02 and 05 now agree, 99 rows still cite `T-LC-`: OPEN) |
| `DA-T-DB-`, `DA-T-PRIV-`, `DA-T-API-`, `DA-T-RT-`, `DA-T-S-`, `DA-T-A-`, `DA-T-AL-`, `DA-T-E-`, `DA-T-CLI-`, invariants `DA-I1..13` | 03 | |
| `UI-I1..14`, `legacy:` test titles (36) | 04 | |
| `ISO-1..9`, `SEC-01..31`, `PD1..PD7`, `S-NET`, `S-ING`, `S-FS`, `S-OUT`, `S-PROC`, `S-LOG`, `S-SEC`, `S-DEP` | 05 | |
| `E-n` experiments (per document), `D1..D35`, `G1..G10`, `B1..B7`, `R01..R33`, `T1..T7` (token rules), `T1..T23` (troubleshooting) | 06 | `T1`..`T7` and `T1`..`T23` share a prefix inside 06 (note N12) |
| `INV-01..12`, `C-1..C-6` | 01 | |
| Requirement ids `R-<section>.<tag>.<n>`, issues `I-01..I-37` | 99 | |

### 12.4 Plan-assigned test file names (90-implementation-plan section 10, D-14) and test-file ownership

The designs name test ids and folders (`<area>.int.test.ts` under `packages/<p>/test/`, one file per guarantee under `runtime/tests/**`,
05 4.1); the work-package plan assigns these concrete files. They are registered here so that a design change that renames a folder
changes this table in the same commit. Paths are relative to `rt/`.

| File | Owner (work package) | Proves |
|---|---|---|
| `packages/engine/test/{workspace-init,audit-concurrency,query-plans}.int.test.ts` | WP-13, WP-13, WP-30 | T-LC-10/11/12 at engine level; T-AU-03; DA-T-DB-14 |
| `packages/cli/test/{cli-config,ingest-replay,export,verify-completion,backup,upgrade,db-rebuild,cleanup}.int.test.ts` | WP-15, WP-38, WP-61, WP-61, WP-62 (x4) | T-CLI-01/02/04 and T-SEC-04; T-CLI-11; T-CLI-05/13; T-CLI-08 and CE-17; T-UP-05..09; T-CLI-12; cleanup scopes |
| `packages/server/test/{static,boot,control,shutdown,state-file,crash-recovery,stream-replay,stream-limits,stream-lifecycle}.int.test.ts` | WP-17, WP-18 (x4), WP-39, WP-36 (x3) | static hosting and history fallback (04 12.2); T-LC-03/04/05/07 and the boot part of T-LC-14; T-LC-14 replay part; DA-T-RT-1..6, 8..10 |
| `tests/parity/{cli-config,cross-engine}.parity.test.ts` | WP-15, WP-63 | T-XE-01/02, T-AU-01, T-CLI-03; T-XE-03..07 (01 S15; not under `tests/legacy-parity/`, N-07) |
| `tests/resilience/process-lifecycle.test.ts` | WP-19 | T-LC-06/08/13 |
| `tests/isolation/{setup-selftest,data-crash-isolation}.test.ts` | WP-20, WP-73 | the `_setup.ts` self-test; DA-T-E-6 crash isolation |
| `tests/tooling/{launcher-bootstrap,schemas-drift,check-text,check-docs,release-check}.test.ts` | WP-21, WP-23, WP-75 (x3) | 05 S4 bootstrap cases; DA-T-API-2 drift; the text, docs and release gates |
| `packages/web/e2e/global-setup.ts` | WP-56 | Playwright global setup (no `webServer`) |
| `packages/web/src/pages/overview/OverviewPage.test.tsx` | WP-54 | overview tiles (04 11.2) |

Not plan-assigned any more: `packages/web/e2e/specs/perf.spec.ts` is 04 O-2's own name (WP-56 writes it). Test-file ownership rules fixed by
the second pass (N-07, C38): each `runtime/tests/isolation/*.test.ts` belongs to the 01 slice that implements its T-ISO rows (01 3.5),
`hook-routing-isolation.test.ts` to 02 (T-HK-05), `data-*.test.ts` to 03 S13; the pyjson and pyregex golden tests are
`runtime/tests/parity/{pyjson,pyregex}.golden.test.ts` (01 S2/S3); unit tests of 06 sit next to their modules and only
`*.int.test.ts` files live under `engine/test/{panels,platform}/` (C47); 04 names its two server-side web contract tests
`api-to-web.int.test.ts` and `stream-reconnect.int.test.ts` (04 11.3), and 06 OI-1 still calls the third `panels.contract.test.ts`
(C38 residual; the plan uses `panels.contract.int.test.ts`).

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
| `ci`, `ci:full` | `node scripts/ci.mjs [--offline] [--keep-going] [--strict]`, `--full` | A.1, A.35, 8.1; a gate that exits 77 prints `SKIPPED (exit 77)` (only the smoke, until 01 S8/S9 are built), never PASS; `--strict` (release-check) turns it into a failure; the 05 3.1 `ci` row lists only `--offline --keep-going` |
| `release-check` | `node scripts/release-check.mjs --out <file>` | S9 |
| `parity:capture`, `parity:check` | `node scripts/parity-capture.mjs [--check]` | S8 |
| `schemas`, `schemas:check` | `node scripts/gen-schemas.mjs`, `node scripts/gen-schemas.mjs --check` (regenerate into a temp folder, byte-compare, exit 1 on drift); one generator for `<skill>/schemas/*.json` (01 2.9) and `schemas/api/**` (03 13 item 4) | in 05 3.1 (C45 resolved); added to `package.json` by 01 S16 |
| `parity:shadow` | `node scripts/parity-shadow.mjs` | in 05 3.1 (C45 resolved); added by 06 PP9 |
| `bench` | runs `rt/bench/*.mjs` in sequence | in 05 3.1 (C45 resolved); added by 06 PP10 (8.3) |
| `testkit` | `node packages/testkit/dist/cli.js` | in 05 3.1 (C45 resolved); added by 06 PP6 (6.4) |
| web package scripts (`-w @mcs/web`) | `dev` (`vite`), `build` (`vite build && node scripts/check-bundle-budget.mjs`), `preview`, `typecheck`, `test` (`vitest run --project web`), `test:e2e` | 04 12.4 |
| other repo scripts | `scripts/lib.mjs`, `smoke.mjs` (drives the real CLI: `$MCS init --slug smoke --port <18800-18849>`, `start`, `GET /api/v3/health` 200 for `Host: 127.0.0.1:<port>` and 403 for `Host: evil.example`, `stop`, port closed; prints `smoke: SKIPPED (...)` and exits 77 while `server/dist/boot.js` or `engine/dist/ops/lifecycle.js` is missing), `set-version.mjs <semver>`, `build-stamp.mjs check\|write\|write-install` | 05 3.2 |

Legacy commands that stay: `python <skill>/template/viewer.py <command>` (`$V`), `python -m unittest discover -s tests`,
`node --test "tests/frontend/*.test.mjs"` (05 7.1 step 8).

## 14. Ports and URLs

| Port / URL | User | Owner | Notes |
|---|---|---|---|
| 8765 (+19 scan) | default base port (`config.json` `port`) | 01 4.11 | never used by tests or experiments (live legacy monitor) |
| 3000, 3100, 8080, 8089 | forbidden | foundations section 5 | owner's other services |
| 18000-18499 | Vitest real-process tests (`VITEST_PORTS`, blocks of 50 per worker) | 05 4.5 | 01 3.5, 02 9.4 and 04 11.3 call `allocatePort()` (C32 resolved; N13 resolved) |
| 18500-18599 | Playwright E2E (04 writes 18510, 18511 for the values a clean run gets) | 05 4.5, 04 11.4 | `allocatePort([18500, 18599])`; no `MCS_E2E_PORT`, no `webServer` (C31 superseded by N-02, I-27) |
| 18760-18769 | `npm run dev` (API 18765, web 18766, preview 18767) | 05 4.5, 04 12.2 | |
| 18800-18849 | `scripts/smoke.mjs` | 05 4.5, A0043 | 05 3.2 and A.37 loop 18800-18849 (C54 resolved) |
| 18850-18874 | legacy Python server in golden capture (`--port-base` 18850-18855) | 06 5.2.2, 05 4.11.4 | |
| 18875-18899 | Node server in parity harness | 06 5.4 | |
| 18900-18999 | manual experiments, testkit `demo --port` | 05 4.5, 06 6.4 | |
| 18900-18949 | benchmarks (`bench-first-import` 18900, `bench-idle` 18901, `bench-api` 18902) | 06 8.3 | |
| (loose wording) | `04-ui.md` 12.2 and `06` 7.1 item 14 say "a port in 18000-18999" for dev checks and tests | 05 4.5 is the authority | manual runs use 18900-18999 (plan slots 18950-18997); Vitest 18000-18499 (note N13) |
| `http://127.0.0.1:<port>` | `state.json.url` (no trailing slash) | 01 1.7 | Host allow-list `127.0.0.1:<port>`, `localhost:<port>` |
| `http://127.0.0.1:<port>/api/v3/...` | API base | 03 5.1 | |
| `http://127.0.0.1:<port>/api/health` | legacy health | 03 6.2 | |
| `http://127.0.0.1:<port>/api/v3/stream?since=<seq>&epoch=<epoch>` | SSE | 03 9.2, 04 5.6 | |
| `http://127.0.0.1:<port>/api/v3/ingest/nudge` | hook nudge | 02 2.8 | |
| UI routes `/`, `/sessions`, `/sessions/:sessionId`, `/activity`, `/tasks`, `/analytics`, `/settings`, `/health` (redirect), `*` | SPA | 04 3.1 | `/tasks` and URL key `task` are UI-only (API: work items) |
| `https://monitoring-claude-sessions.local/schemas/<file>` | JSON Schema `$id` | 01 2.9 | |

## 15. Conflicts (divergent definitions): status after the owners' reconciliation

Second pass, 2026-10-11: every row of the first pass (C01-C59) was re-checked against the reconciled design texts and ADRs 0001-0059
(the check is a read of the section named in the last column plus a search of all six designs and all ADRs for the old spelling). Status
`RESOLVED` means the divergence is gone from every design and ADR and the cited section holds the agreed form; `RESOLVED (fix
superseded)` means the owners agreed on another form than the first-pass fix column proposed (the cited section says which); `OPEN`
means a divergence remains and the last column gives the reason and the exact fix. C60-C63 are new divergences found in the second
pass. Owner = authoritative document per section 0.1 (or the evidence named in the row). The OPEN rows are repeated in the table that
ends this file (section 17).

| Id | Name | Owner | Status | Divergence in the revision 2 texts | Where the designs now agree, or why open |
|---|---|---|---|---|---|
| C01 | `import.maxLineBytes` | 02 (I-32) | RESOLVED | 01 1.6 listed the key (10 `import` keys); 02 1.2 and 03 3.3 say the cap is only the constant `MAX_LINE_BYTES` | 01 1.6 (row and `R_KEY_CATALOGUE` entry deleted, "There is no `import.maxLineBytes`", contract test counts 9 `import` keys and rejects the key), 02 1.2, 02 1.1, 03 3.3 |
| C02 | R-key ranges (`spool.*`, `import.*`, `hooks.spoolWhileStoppedHours`) | the owner's table (02 1.2, N-04) | RESOLVED (fix superseded) | 02 1.2 stated other ranges than 01 1.6; value 0 of `spoolWhileStoppedHours` had a meaning 01 forbade | 02 1.2 "Ranges" paragraph (the 02 table is normative) and 01 1.6 (a copy with identical bounds: `spool.pollMs` 100..10000, `sealGraceMs` 10000..3600000, `lookbackHours` int 1..8760, `tailWindowBytes` 1 MiB..4 GiB, `backfillMaxBytes` 0..64 GiB, `headMaxBytes` 1 MiB..256 MiB, `discoveryIntervalMs` 1000.., `scanIntervalMs` 250.., `spoolWhileStoppedHours` 0..720). The first-pass direction (02 points to 01) was reversed by N-04; section 6.2 now shows the owner's ranges. Consequence recorded in 01 1.6, 2.4, open item 6 and 02 1.2: legacy configs with a fractional `window_hours` or `event_window_mb` < 1 are refused by Node with a message naming the R key to set |
| C03 | control op for spool replay | 01 4.3 | RESOLVED | 02 wrote `ingest.replay {from}` | 02 2.7 step 4, 02 4.10 (`replay(fromSegment)`), 02 12 X-2, ADR 0012: op `ingest-replay`, field `fromSegment`, reply `{segments}` |
| C04 | spool replay engine API | 02 2.7 | RESOLVED | 01 called `replaySpool(db, scope, {fromSegment, nowMs})` | 01 6.4 step 3 and 4.3 (`planSpoolReplay` then `applySpoolReplay` when stopped, `IngestService.replay` when running, `segmentsReset` -> `segments`), 01 4.4a `ingestReplay`, 02 2.7 |
| C05 | audit template `ingest-replay` | 01 7.2 | RESOLVED | 02 2.7 step 5 had its own Summary/Files/Validation/Outcome | 02 2.7 step 5 ("01 7.2's template verbatim"), 01 6.4 step 4 |
| C06 | `createIngestService` / `createLifecycleSweeper` shapes | 02 4.10 | RESOLVED | 01 4.4a expected `untilIdle(remaining)` -> boolean and `createLifecycleSweeper(ctx)` -> `{start, stop, tick}` | 01 4.4a components 1 and 2 and the `ingestUntilIdle` algorithm (rejection mapped to `idle: false`, `{writer: ingest.writer}`, `tickNow`), 01 open item 3, 02 4.10, 06 5.4 (`.idle === true`) |
| C07 | `InstanceContext` workspace field | 01 4.4a | RESOLVED | 02 requested `workspaceDir` | 02 4.10 (`instanceDir`), 02 12 X-2 (request dropped), 01 4.4a ("There is no `workspaceDir` field") |
| C08 | maintenance scheduler factory | 03 11.4 | RESOLVED | 01 named `createMaintenanceScheduler(ctx)` | 01 4.4a component 3 (`createDbScheduler(ctx)` wrapped as `{name: 'db-scheduler', ...}`), 03 11.4, 03 15 |
| C09 | `createQueries` deps | 03 12.1 | RESOLVED | 01 passed `{config, now, process}`, 03 had `{config, now, audit}` | 03 12.1 `QueryDeps` (six deps, `process?`, `childStats?`, `panelStats?`), 01 4.4a "Query deps" (server passes all six, DbReader three), ADR 0029. Which function builds `ctx.queries` is C61 |
| C10 | child stats type name | 06 3.6 | RESOLVED | 03 said `ChildStat` | 03 6.2, A-6, O-4 and 01 4.2 use `ChildKindStats` (declared in `sh/api/panels.ts`) |
| C11 | `ChildKind` / executable names | 06 3.6 (A0051) | RESOLVED | 01 needed kind `opener` and `ExecutableName` with `python` | 06 3.6 (`ChildKind` has `opener`; `resolveExecutable(..., 'opener')`; no `ExecutableName`), 01 4.2 and 6.5 (Python path passed as `ChildSpec.file`), ADR 0051, 05 S-PROC-2 and SEC-19 |
| C12 | `forceKill` on Windows | 06 4.2 | RESOLVED | 01 4.2 and ADR 0006 said `process.kill(pid)` | 01 4.2 (`forceKill` comment, E3 paragraph), ADR 0006, 06 4.2: `taskkill.exe /PID <pid> /F` through `execFileText` kind `taskkill`, exit 128 = gone |
| C13 | `listRuntimeProcesses` home | 01 4.2 | RESOLVED | 06 and ADR 0051 put it in `platform/process.ts` | 06 3.2, 4.2, 4.11 ("is 01's, in `platform/markers.ts`"), ADR 0051, 01 4.2 and S4 |
| C14 | workspace writer name | 01 1.2 | RESOLVED | 06 4.3 listed `writeFileAtomic` (sync) | 06 4.3 (`writeWorkspaceFile`, async) |
| C15 | file of `InstanceContext` | 01 4.4a | RESOLVED | 06 cited `instance-runtime.ts` | 06 3.2, 5.4, section 10 (`runtime/context.ts`), 01 4.4a, 02 4.10 |
| C16 | `explainCompletion` signature and `CompletionEvidence` fields | 02 7.13, 03 (schema file) | RESOLVED | 01 and 03 used `explainCompletion(queries, target)` returning `null`; 03 schema lacked `resolvedBy`, `candidates` | 03 6.1 and 6.3 (`CompletionEvidenceSchema` with nullable `sessionId`, `resolvedBy`, `candidates`; `CompletionLookup` built from `SessionsRepo.completionCandidates` and `AttemptsRepo.runsByPart`; 400/404 mapping), 03 12.1, 02 7.13, 01 6.1 and 6.4 (`USAGE` / `NOT_FOUND`) |
| C17 | `attemptPart` length | 02 7.13 with the 03 3.5 column cap | RESOLVED | 02 0..128 vs 03 1..512 | 02 7.13 step 1 and 03 6.1: 0..512, present-but-empty allowed; ADR 0026; 01 6.4 |
| C18 | `EvidenceItem` name | 03 5.5 | RESOLVED | 02 7.1 used `EvidenceItem` for the engine shape | 02 7.1 (`LifecycleEvidence`; `ApiEvidenceItem` = import of 03's `EvidenceItem`), 03 5.5, 06 3.10.7 |
| C19 | `ErrorCode` name | 03 5.2 | RESOLVED | 01 6.2 declared the CLI union as `ErrorCode` | 01 6.2 (`CliErrorCode`, `CliError.code: CliErrorCode`), 02 4.8, 03 5.2 note |
| C20 | doc file name casing | 05 6.1 (A0049) | RESOLVED | 03 4.4 said `docs/OPERATIONS.md` | 03 4.4 (`docs/operations.md`) |
| C21 | `InstanceReader.errors` item type | 03 6.1 | RESOLVED | 01 6.1 used `ServerErrorItem[]` | 01 6.1 (`ErrorItem[]`), 03 12.2 |
| C22 | hooks verify type in diagnostics | 02 3.1 | RESOLVED | 01 6.4 `HooksVerifyReport` | 01 6.4 (`hooks: HooksVerifyResult \| null`) |
| C23 | hooks CLI surface and installer home | 01 6.1-6.3 (INV-12, A0008) | RESOLVED | 02 put the installer in `cl/commands/hooks/*`; 01 lacked `hooks status`, `--sync-tool-events` and named `planHooksInstall` | 01 6.3 (rows `hooks install` with `--sync-tool-events`, `--dry-run`, `--json`; `hooks status`; installer in `engine/src/hooks/installer/`), 02 1.1, 3 intro, 9.5, 13 I-9, ADR 0014, 05 1.2 (CLI command names) |
| C24 | `compilePyRegex` call | 01 2.8 | RESOLVED | 02 5.2 called `compilePyRegex(match, {dotAll: true})` | 02 5.2 step 4 (`compilePyRegex(rule.match, 'session_rule')`, `applyLabelTemplate`) |
| C25 | spool glob in E2E | 02 2.7 | RESOLVED | 04 11.4 step 13 appended to `hooks-*.jsonl` | 04 11.4 step 13a (`hooks-<YYYYMMDD>T<HH>Z.ndjson`, newest by `SPOOL_SEGMENT_RE`) |
| C26 | `InstanceInfo.poll` keys and mapping | 03 6.2 | RESOLVED | 04 5.2 used `poll.<key>Ms` for git/ledger/chainLog; 03 mapped no legacy key | 03 6.2 (`poll` paragraph), 04 5.2 (`usePanel`, `useHealth`, `useOverview`, `useTranscriptWindow`), 06 8.3 |
| C27 | home of `Clock` | 01 4.4a | RESOLVED | 05 owned `sh/clock.ts` | 05 1.2 and S2 (`Clock` in `sh/time.ts`, testkit `clock.ts` holds only `FakeClock`), 06 header and 3.2 |
| C28 | Node floor | 01 5.1 (A0007) | RESOLVED | 05 3.2 and 06 said 22.12 | 05 3.2 and A.31 (22.22.0), 06 3.9.4, 7.1 item 2, T21; only the foundations D7 text keeps "22.12" (annotated by the lead, 01 open item 4) |
| C29 | launcher bootstrap steps and messages | 01 5.1 | RESOLVED | 05 3.3.4 restated the steps | 05 3.3.4 ("Stamp contract the launcher relies on"), ADR 0047 |
| C30 | `outdated` comparison source | 01 5.3 | RESOLVED | 05 3.3.1 compared with `staleness().buildStamp` | 05 3.3.1 (`codeStamp` of `rt/.mcs-build.json`), ADR 0047 |
| C31 | Playwright port and server start | 05 4.5, 04 11.4, 01 4.1 | RESOLVED (fix superseded) | 05 A.28 defaulted `MCS_E2E_PORT` to 18900 and started `server/dist/main.js --port N`; the first-pass fix said "default 18500, no `webServer`" | the variable and the `webServer` are gone: 01 2.10 ("There is no `MCS_E2E_PORT`"), 04 11.4 (config of `e2e/playwright.config.ts`), 05 A.28 (withdrawn), 05 4.5, 4.12 and the environment note of section 10 (N-02, I-27) |
| C32 | free-port helper | 05 4.4 | RESOLVED | 01 3.5, 04 11.4, 05 4.5 used `findFreePort`; A.40 scanned 18000-18999 | 05 4.4 `ports.ts` and A.40 (`allocatePort(range)`), 01 3.5, 04 11.3 and 11.4, 02 T-HK-06, T-IN-08, 9.4 (`allocatePort(VITEST_PORTS)`) |
| C33 | isolation fixtures named by 01 | 05 4.4 | RESOLVED | 01 3.5 named seven helpers testkit did not export | 05 4.4 `isolation.ts` (`hermeticEnv`, `startInstance`, `spawnImpostor`, `makeJunction`), 01 3.5 (mapping to `makeTempDir`, `snapshotTree`, `runCli`). The mechanism of `makeJunction` differs: C62 |
| C34 | demo builder options | 04 11.5 | RESOLVED | 05 4.4 `{root, now}` and `runtimeJson` | 05 4.4 (`DemoOptions` verbatim, `nowMs`, no `runtimeJson`), 05 S3 |
| C35 | id regexes defined twice | 02 2.3.2 | RESOLVED | 05 5.3 declared `SESSION_ID_RE`, `AGENT_ID_RE`, `RUN_ID_RE` | 05 5.3 S-FS (re-exports `SID_RE`, `AGENT_RE`, `RUN_ID_RE` from `@mcs/shared/protocol`), 03 5.1 |
| C36 | `LegacyState` redeclared | 03 5.5 | RESOLVED | 05 4.11.3 and 06 6.2 declared their own | 05 4.11.3, 06 6.2, 02 7.1 import it from `@mcs/shared` |
| C37 | test id prefix `T-LC-` | 01 4.16 | OPEN | 02 used `T-LC-01..57` for lifecycle-model tests | resolved in the designs (02 7.12, 9.2, 9.5 and 05 4.2, 7.4 use `T-LF-01..57`; 01 keeps `T-LC-01..16`); still open in `99-requirements-matrix.md`: rows R-2.B.2, R-6.1, R-6.S.1, R-6.R.7, R-6.T.1, R-7.E.3, R-8.6.1, R-8.6.2 cite `T-LC-49..53` or `T-LC-01..48` for the lifecycle model. Owner: the lead (99). Fix: read `T-LF-*` in those rows |
| C38 | test file names | per owning design (I-22) | OPEN | 05 4.2 and 04 11.3 used other names than 02 9.5, 01 2.8, 03 23 | resolved in 05 4.2 (`transitions.test.ts`, `worked-example.test.ts`, `shared/src/pyregex/*.test.ts`, `shared/src/api/filters.test.ts`) and 04 11.3 (`api-to-web.int.test.ts`, `stream-reconnect.int.test.ts`, `panels.contract.int.test.ts`); one residual: 06 OI-1 still names `panels.contract.test.ts`. Owner: 06. Fix: `panels.contract.int.test.ts` |
| C39 | `data/exports/` folder | 01 1.1 | RESOLVED | 03 11.1 wrote `data/exports/.tmp-*.db`; 01 1.1 lacked the folder | 01 1.1 (tree row, runtime-mutable), 01 6.4 `cleanup --scope stale-state`, 03 11.1, 06 7.1 item 1 |
| C40 | attempts tables as seen by 06 | 03 3.5, 9.1 | RESOLVED | 06 3.10.2 copied stale DDL and "not a stream kind" | 06 3.10.2 (points to 03 3.5/3.6; row ids; `idx_attempt_runs_*`; change kind `attempt/upsert`), 3.10.8, 06 OI-2, ADR 0059 |
| C41 | `external.attempt` payload | 02 4.3 | RESOLVED | 06 3.10.7 omitted `endedAt` | 06 3.10.7 (`endedAt: row.ended_at`, `observedAt = publishAt`), 02 4.3, 02 12 X-3 |
| C42 | config errors proposed by 06 | 01 2.4, 6.2 | RESOLVED | `E_ATTEMPTS_TIME_FORMAT`, `E_MSYS_PATH` outside the catalogue | 06 3.10.1 and 4.1 (`McsError('CONFIG_INVALID', ...)` with the quoted messages), 01 2.4 Node-only additions |
| C43 | `configWarnings` in health | 03 6.2 | RESOLVED (fix superseded) | 06 5.8 D3 exposed flat-config warnings in `/api/v3/health` | first-pass fix said "inspect and doctor only"; N-05 decided N/A in Node: 06 5.8 D3 and R25, 05 4.11.5 PD3, ADR 0055, 01 2.7 and 6.5, 03 15 (flat configs are served by `$V`; `config migrate --from-legacy` reports dropped keys and refuses untranslatable regexes) |
| C44 | `db rebuild` | 01 5.4 | RESOLVED | 06 7.1 item 6 and OI-7 called it a proposal | 06 7.1 item 6 and the closing note (OI-7 closed), 03 4.4 and 15 |
| C45 | root npm scripts | 05 3.1 | RESOLVED | `schemas`, `schemas:check`, `parity:shadow`, `bench`, `testkit` absent from 05 3.1; two generators | 05 3.1 (five rows and the slice note), A.1 note; 01 2.9 and S16 (`gen-schemas.mjs`), 03 13 item 4 and S3 (API part of the one generator) |
| C46 | `@mcs/testkit/legacy` subpath | 05 2.2 | RESOLVED | 05 exported only `.` | 05 2.2 manifest row, A.21 (`./legacy`), 4.4 |
| C47 | test placement in 06 | 05 4.1 | RESOLVED | 06 put unit tests under `test/` folders | 06 3.11, 4.11 (placement sentence), PP0, PP1, PP5, PP7 (unit tests next to modules, `*.int.test.ts` only under `test/`) |
| C48 | settings mutex key | 01 4.2 | RESOLVED | 02 3.5 hashed `normalizePath(settingsPath)` | 02 3.5 step 1 (`path.resolve(settingsPath)`), 01 4.2, ADR 0014 |
| C49 | stale ADR texts owned by 02 | 02, 03 | RESOLVED | ADRs 0012, 0014, 0016 carried old wording | ADR 0012 (`UNIQUE event_uid`, `spool.retainHours`), ADR 0014 (OS mutex, engine home), ADR 0016 (single `events` table) |
| C50 | `staleAfterMs` source | 03 6.2 | RESOLVED | ADR 0033 said a fixed default from `@mcs/shared` | ADR 0033 (`InstanceInfo.staleAfterMs` from `poll.stale_after_ms`), 03 6.2 |
| C51 | module of `HealthReport`, `InstanceInfo`, `ErrorItem` | 03 23 S3 | RESOLVED | 04 13 said `entities.ts` | 03 6.2 (`sh/api/health.ts`), 04 13 row, 05 A scaffold label |
| C52 | work item source spelling | 03 | RESOLVED | `attempts` vs `attempt` | 03 5.5 `WorkItem.source` comment (`attempt` -> `attempts`) |
| C53 | `withWriteTx` signature | 03 4.5 | RESOLVED | 03 3.6 prose `withWriteTx(ctx, fn)` | 03 3.6 (`withWriteTx(db, ctx, fn)`), 06 3.10.3 |
| C54 | smoke port range | 05 4.5, A0043 | RESOLVED | 05 3.2 and A.37 scanned 18800-18899 | 05 3.2 smoke bullet and A.37 (18800-18849), 01 4.11 |
| C55 | diagnostics command | 01 6.3 | RESOLVED | 05 S-SEC-4 said `mcs doctor --report` | 05 S-SEC-4 (`mcs diagnostics`), 05 1.2 (CLI command names) |
| C56 | agent kinds | 03 3.5 | RESOLVED | 02 4.1 listed three kinds | 02 4.1 entity table and 7.2 `AgentFacts` note (`main subagent workflow_agent teammate internal`) |
| C57 | driver of `tickAttempts` | 01 4.4a | RESOLVED | 06 said the ingestion scheduler tick drives it; 01 started nothing | 01 4.4a component 4 and tests (2000 ms serialized timer, first call at start, cleared by `stop`), 06 3.2 and 3.4, 02 4.3 and 5.4, ADR 0059 |
| C58 | E2E spec folder | 04 11.4 | RESOLVED | 04 4.2 showed `e2e/` | 04 4.2 (`e2e/specs/*.spec.ts`), 05 A.28 note |
| C59 | `ChangeSink.record` entity names | 03 9.1 vs 02 4.6 | RESOLVED | 03 9.1 mapping named `hook_event`, `transcript_entry` | 03 9.1 and 3.5 entity table (`event` -> `event/append`), 03 A-1 and 15 |
| C60 | `ChildSpec.stdin` | 06 3.6 | RESOLVED (fixed by the final verification, `97-reconciliation-log.md` F-1) | 02 3.7 (V6 spawns the installed command with the probe payload on stdin) and 02 12 X-3 required an optional capped `stdin` string on `ChildSpec`; 06 3.6 `ChildSpec` had no such field | 06 3.6 (`stdin?: string`, kind `node` only, <= 4096 bytes, rules 1 and 8, test row of 3.11), ADR 0051, 05 S-PROC-2, 02 3.7 (adopted wording); WP-07 implements it, WP-37 uses it |
| C61 | who builds `ctx.queries` | 01 4.4a | OPEN | 01 4.4a: `buildInstanceContext` opens the DB and calls `createQueries` (`createInstanceRuntime` receives the finished context); 03 12.1 closing paragraph and A-4 say `createInstanceRuntime(ctx)` builds `ctx.queries` and opens the DB | reason: wording divergence, no behaviour difference. Fix: 03 12.1 and A-4 say `buildInstanceContext` (01 4.4a); the plan follows 01 (the call sits in `runtime/context.ts`) |
| C62 | `makeJunction` mechanism | 05 4.4 | OPEN | 01 3.5: `makeJunction(link, target)` uses `cmd /c mklink /J` on Windows; 05 4.4: `fs.symlinkSync(target, link, 'junction')` (no shell) | reason: not reconciled; a shell spawn outside `platform/exec.ts` would also break 05 S-PROC. Fix: 01 3.5 states 05's mechanism |
| C63 | file ownership example for the T-ISO files | 01 3.5 and the 01 slice table | OPEN | 05 4.8 gives "for example S6 T-ISO-01/02/06/07/21, S9 T-ISO-13/14/18/19/20/22, S12 T-ISO-24..27, S13a T-ISO-09..12" | reason: cosmetic. The 01 slice table (T-ISO-06 rows with each command slice, T-ISO-05/08/16/17/21 with S9, T-ISO-15 with S12, T-ISO-03/04/09..12 with S13a) wins and the plan follows it. Fix: 05 4.8 cites the 01 table instead of an inline list |

### 15.1 Notes (gaps, not conflicts)

Status per note after the second pass: OPEN notes stay gaps that an implementing slice closes; RESOLVED notes were closed by the owners'
reconciliation.

| Id | Status | Note |
|---|---|---|
| N1 | OPEN | `InstanceRow` (01 6.4) has no type declaration beyond the column list `slug engine state url pid version outdated`. |
| N2 | RESOLVED | `HANDLER_VERSION` lives in `sh/protocol/hook-envelope.ts` (02 1.1). |
| N3 | OPEN | `registerRoute` validates responses unless `NODE_ENV === 'production'`; no design sets `NODE_ENV` for the detached server (01 4.7 env), so production validates every response. 01 or 03 should state the value. |
| N4 | OPEN | `AlertRuleView` element shape is not written out in 03 6.1/section 12.1. |
| N5 | OPEN | 01 S1 lists a `logging` module in `sh/config/runtime/` though `logLevel` is a top-level key with no section. |
| N6 | OPEN | `WorkspaceRef` (01) is used everywhere but never declared. |
| N7 | OPEN | `McsError` (01) has no declared signature; `CliError.details` and `hint` population is implicit. |
| N8 | RESOLVED | `resolveMcsHome` lives in `sh/protocol/routes.ts` (02 1.1 and 2.6.1). |
| N9 | RESOLVED | 03 6.3 and 12.1: `AuditReader.entriesBetween` returns `Promise<AuditRef[]>` (01 7.1); `getSession` stays synchronous with `auditRefs: []` and the route handler and the DbReader await `sessionAuditRefs(detail)` after the snapshot. |
| N10 | OPEN | 01 2.6 and 5.8 name `SUPPORTED_DB_SCHEMA`; 03 derives the supported version from shipped migration files (`latest`). Use 03's `migrationStatus().latest`. |
| N11 | RESOLVED | `alert_not_found` (03 5.2) is not raised by any route in 03 6.1: 03 5.2 now marks it and `csrf_rejected` as reserved and exempts exactly these two from the DA-T-API-3 meta-test (final verification, `97-reconciliation-log.md` F-4). |
| N12 | OPEN | 06 uses `T1`..`T7` for token rules and `T1`..`T23` for troubleshooting rows. |
| N13 | RESOLVED (loose wording remains) | 02 9.4 now uses `allocatePort(VITEST_PORTS)`; 04 12.2 (dev check) and 06 7.1 item 14 still say "a port in 18000-18999" loosely; 05 4.5 is the authority (Vitest 18000-18499, Playwright 18500-18599, manual runs 18900-18999). |
| N14 | OPEN | `ops.version` (01 6.3 row `version`) names no module in 01 6.1; the plan places it in `ops/workspace.ts` (WP-14). |
| N15 | OPEN | 05 3.1 lists `ci` as `[--offline] [--keep-going]`; `--strict` and `--full` are in A.35, 7.1 and 8.1 (same document, no cross-design effect). |

## 16. Maintaining this registry

1. A change to any name listed here changes the owning design section and this registry in the same commit.
2. A new cross-boundary name gets a row before code uses it; a divergence gets a `Cnn` row with the owner and the exact fix.
3. When an OPEN conflict of section 15 is fixed in the designs, its row becomes RESOLVED with the section where the texts agree and it
   leaves the table of section 17 in the same commit.
4. Phase 2 contract tests that enforce rows here: `runtime-sections.contract.test.ts` (section 6.2), `env-vars.test.ts` (section 6.3),
   `schemas.drift.test.ts` and `schemas:check` (section 1, section 3), DA-T-API-3 meta-test (section 7.1), `launcher-parity.test.ts` (mutex names, markers),
   `routes.test.ts` (Express routes 1:1 with the registry), `normalize-envelope.test.ts`/`normalize-record.test.ts` (section 11.4).

## 17. OPEN conflicts at the end of the second pass

Everything else in section 15 (C01-C36, C39-C60) is RESOLVED. The five rows below are the only divergences left; none changes a
database table, a route, a file path or a signature, and none blocks a work package of `90-implementation-plan.md`.

| Id | Owner of the fix | Exact fix | Effect on the plan |
|---|---|---|---|
| C37 | lead (`99-requirements-matrix.md`) | rows R-2.B.2, R-6.1, R-6.S.1, R-6.R.7, R-6.T.1, R-7.E.3, R-8.6.1 and R-8.6.2 read `T-LF-*` instead of `T-LC-*` for the lifecycle-model tests | none: the plan cites `T-LF-*` |
| C38 | 06 | OI-1 names `panels.contract.int.test.ts` | none: WP-56 creates `panels.contract.int.test.ts` |
| C61 | 03 | 12.1 closing paragraph and A-4 attribute `ctx.queries` and the DB open to `buildInstanceContext` (01 4.4a) | WP-16 builds `ctx.queries` in `runtime/context.ts`; WP-17 owns a block there (plan section 4.2) |
| C62 | 01 | 3.5 states `fs.symlinkSync(target, link, 'junction')` for `makeJunction` (05 4.4) instead of `cmd /c mklink /J` | WP-06 follows 05 4.4 |
| C63 | 05 | 4.8 cites the 01 slice table instead of an inline example list | none: WP-15, WP-20, WP-22, WP-38, WP-39, WP-62, WP-63, WP-73 follow 01 3.5 |
