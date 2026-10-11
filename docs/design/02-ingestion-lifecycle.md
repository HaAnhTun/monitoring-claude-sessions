# 02 - Ingestion and lifecycle: hooks, spool, transcripts, tokens, state

Status: Phase 1 design, written 2026-10-11 for the V3 migration. Owner of this file and of ADRs 0010-0019: ingestion/lifecycle designer.
Scope: everything between Claude Code and the normalized in-memory/DB model (master brief sections 5, 6, 8.7, the hook and
transcript parts of 12, and 14). Table DDL is NOT in this document: section 4.1 defines the logical entities, their keys,
invariants and the exact write each one needs; the data-model design (`03-data-api-realtime.md` 3.5-3.6) owns the DDL, the table
names and the repository statements, and this document adopts them (one `events` table for hook envelopes and transcript entries).

Revision 2026-10-11 (Phase 1 reconciliation, critic issues of `99-requirements-matrix.md` section 2): I-02 spool segments are
`*.ndjson`; I-03 single `events` table and normative stored `kind` values (4.1, 4.3, 5.6); I-04 HTTP error codes from the 03
catalogue (2.8); I-08 completion evidence (7.13); I-15 `createIngestService` / `createLifecycleSweeper` (4.10); I-16 `withWriteTx`
wording (4.6); I-17 handler entry `cli/src/hook.ts` (1.1); I-18 `external.attempt_cleared` (4.3, 7.3, 7.7); I-29 CLI envelope,
audit template, mutex and `ingest replay` (2.7, 3.1, 3.5); I-32 one `MAX_LINE_BYTES` (1.1, 5.3); I-33 exported `renderEvidence`,
`viewChanged`, `toLegacy` (7.1). Alignment with issues owned elsewhere: I-01 (1.2), I-07 (7.10), I-11 (9.1), I-22 (9.5), I-26
(2.3.2, 9.5), I-27 (1.3), I-34 (2.5.4, 5.1.1), I-37 (3.7).

Revision 2026-10-11b (second critic pass; `98-contract-registry.md` is the arbiter of names): N-11 / C23 installer modules in
`engine/src/hooks/installer/` behind 01's `ops.hooks.*` (1.1, 3, 9.5, 13 I-9); I-29 / C03 / C05 control op `ingest-replay` with
`fromSegment` and 01 7.2's audit template (2.7, 4.10, 12); N-12 / C37 lifecycle-model test ids renamed `T-LF-01..57` (01 keeps
`T-LC-*` for process lifecycle). Alignment: N-01 / C57 (4.3, 4.10, 5.4), I-08 / C16 / C17 (7.13), I-15 / C06 / C07 (4.10, 12),
N-03 (1.2), N-04 / C02 (1.2), C18 `LifecycleEvidence` (7.1), C24 (5.2), C48 (3.5), C49 (ADRs 0012, 0014, 0016), C56 (4.1),
registry notes N2, N8, N13 (1.1, 2.6.1, 9.4).

Read first: `00-foundations.md` (D1-D15), `docs/research/claude-code-hooks.md` (cited `HK:<section>`),
`docs/research/transcript-survey.md` (`TS:<section>`), `docs/research/current-state-backend.md` (`CS:<section>`),
`docs/research/ccam-source-analysis.md` (`CC:<section>`).

Conventions: MUST/SHOULD as in RFC 2119. All times are integer epoch milliseconds UTC unless named `*Seconds`. "cp" = Unicode
code points (never UTF-16 units). UNVERIFIED = not measured; each one has a verification plan in section 12.

## 0. Evidence gathered for this design (experiments, 2026-10-11, Windows 11 NTFS, Node 24.14.1, Claude Code 2.1.289)

All scripts live in `D:/mvp/private/scratch/mcs-v3/ingestion/<id>/`. No transcript content was printed or copied.

| Id | Question | Script | Observed result |
|---|---|---|---|
| E1 | Cost of a zero-dependency Node hook handler | `e1/proto-hook.mjs`, `e1/bench.mjs` (15 runs per row) | Wall-clock medians (spawn to exit): bare `node -e ""` 40 ms; handler with `MCS_HOOK_DISABLE=1` 64 ms; 10 route files, none match 65 ms (in-script 5.1 ms); route match + spool append, no server 67 ms (6.1 ms); same with 1 MiB `tool_input` 70 ms (8.5 ms); `state.json` port closed 72 ms (ECONNREFUSED after 9.6 ms in-script); server answers 204: 70 ms; server accepts but never answers: 377 ms when waiting for the response (300 ms timeout) |
| E1b | Exit on request flush instead of response | `e1/bench2.mjs` | Hanging server: median 92 ms, p90 100 ms; the server still received 15 of 15 nudges. Answering server: 15 of 15 |
| E2 | Are concurrent appends from many processes line-atomic? | `e2/append-race.mjs` | 16 processes appending to one file (`appendFileSync` and `open('a')+writeSync`), lines of 1 KB, 16 KB, 64 KB, 256 KB (640 lines each) and 1 MB, 4 MB (64 lines each): 0 torn, 0 lost, 0 duplicated lines on NTFS |
| E3 | JSON.parse throughput and a time-sliced tail reader | `e3/gen.mjs`, `e3/tailer.mjs` | Synthetic 100 MB JSONL (37,920 lines, longest 1.2 MB, multibyte text, 88-byte unterminated tail): 248-317 ms total (315-404 MB/s), JSON.parse 555 MB/s, the partial tail stayed unconsumed (88 bytes carried), event-loop delay max 3.0 ms (256 KiB chunks), 4.9 ms (1 MiB), 12.1 ms (4 MiB), heap 7-12 MB |
| E4 | Same reader on the three largest real transcripts (66.8, 31.0, 22.7 MB) | `e3/tailer.mjs` (numbers only) | 243-371 MB/s, JSON.parse 373-565 MB/s, event-loop delay max 4.4-13.3 ms (1 MiB chunks, 20 ms slices), 0 invalid lines, 0 non-UTF-8 lines |
| E5 | File identity on NTFS | `e5/identity.mjs` | `fs.stat(p, {bigint:true}).ino` is non-zero and wider than 2^53 (store as decimal string); append keeps `ino` and `birthtime`; truncate-then-write keeps `ino` (size shrinks); replace-by-rename, copy and delete-recreate change `ino` |
| E7 | Provider environment of a hook process | `e7/probe.mjs`, `e7/settings.probe.json`, one `claude -p` (haiku, 0.014 USD, temp `--settings`, `--setting-sources project`, all `CLAUDE*` vars removed) | On SessionStart, UserPromptSubmit, Stop, SessionEnd: `CLAUDE_PID` == `process.ppid` == pid of `claude.exe`; `CLAUDE_CODE_SESSION_ID` == payload `session_id`; `CLAUDE_PROJECT_DIR` == payload `cwd` == hook process cwd. After exit, `process.kill(pid, 0)` threw `ESRCH`; 1000 such probes took 3.9 ms |
| E8 | Validation and write cost | `e8/zod-sqlite.mjs` (zod 4.6.5, better-sqlite3 13.0.3) | Strict envelope `safeParse` 2.0 us, loose transcript-record schema 0.46 us; `INSERT OR IGNORE` with a UNIQUE key: 18.8k rows/s at 1 row per transaction, 183k at 50, 304k at 500; replaying 20,000 duplicates inserted 0 rows at 483k rows/s |
| E9 | What a failing hook leaves in the transcript | `keys-attach.mjs` on the hook-lab run3 transcript (keys only) | `attachment.type = hook_non_blocking_error` with keys `hookName, toolUseID, hookEvent, stderr, stdout, exitCode, command, durationMs`; for exec-form handlers `command` is the command plus its args joined by spaces, so a marker argument is visible |
| E10 | Can one ESM file be both the import target of the stub and a directly runnable script? | `e10/entry.mjs`, `e10/stub.mjs` | `pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url` is true when run directly with the path spelled `D:/mvp/...`, `d:/mvp/...` and `D:/MVP/...` (Node keeps the spelling in both values), and false when imported by the stub; the import does not run the entry, the stub's explicit `runHook(argv)` does |
| X1 (critic) | Does the legacy `audit` accept a spool segment? | `99-requirements-matrix.md` section 4, X1 (legacy `viewer.py audit` on a temp workspace) | `data/spool/hooks-20261011T14Z.jsonl`: `ok: false` ("transcript copy found"), exit 1; the same file renamed `.ndjson`: `ok: true`, exit 0. Source rule: legacy `src/backend/tasks.py` audit loop flags every name ending in `.jsonl` (re-read 2026-10-11) |

ADRs written for this document (in `docs/decisions/`): 0010 hook handler and envelope; 0011 hook routing by per-user route files; 0012 hourly spool segments and the nudge;
0013 installed hook events and async tool events; 0014 hook installer merge, marker and consent; 0015 transcript tailer
identity and main-thread scheduling; 0016 transcript references instead of stored bodies; 0017 token accounting with global
dedupe; 0018 lifecycle as a fact semilattice with decision tables; 0019 Windows liveness through the Claude Code pid.

Consequences used below: a synchronous handler costs about 70 ms per event on this machine (E1), so high-frequency tool
events are registered `async` (ADR 0013); the spool can be a shared append-only file per hour (E2, ADR 0012); no worker
thread is needed for transcript parsing (E3/E4, ADR 0015); file identity uses the bigint inode plus a head hash (E5);
Windows liveness can use the Claude Code pid that the handler sees (E7, ADR 0019).

## 1. Architecture of this domain

```
 Claude Code process (claude.exe, pid P)                              ~/.claude/projects/<proj>/*.jsonl (+ subagents, workflows)
   | hook fires (exec form, env CLAUDE_PID=P)                          ~/.claude/sessions/<pid>.json   ~/.claude/jobs/<id>/state.json
   v                                                                                     |
 node --no-warnings <skill>/scripts/mcs-hook.mjs --mcs-hook <Event>   (stub, zero deps)  |
   -> import runtime/packages/cli/dist/hook.js (handler, imports only node:* + @mcs/shared/protocol)
   -> read $MCS_HOME/routes/*.json -> match instance(s) by transcript dir / pinned session id
   -> sanitize -> envelope v1 -> append one line to <workspace>/data/spool/hooks-<UTC hour>.ndjson  (per matched instance)
   -> if the instance is running: POST /api/v3/ingest/nudge (exit on flush, <= 300 ms) -> exit 0, no output
                                                                                         |
 ===================================== monitor server process (one per instance, D2) =====================================
   SpoolDrainer (P0)        TranscriptImporter: Discovery -> Classifier -> JsonlTailer (P1 tail, P2 head, P3 backfill)
        |                         |                                     External pollers: registry, jobs, pid (sweeper)
        v                         v                                                   |
   normalizeEnvelope()      normalizeRecord()  -> LogicalEvent[] + UsageRecord[] + EntryRow[]  <-----------------------+
                                  |
                                  v
   IngestWriter (single writer, bounded queue, batches <= 500 items / 8 ms)
     withWriteTx (03 4.5): BEGIN IMMEDIATE; rows (EventsRepo / upserts); cursor update; facts merge; lifecycle re-derive;
     ChangeSink.record() -> ChangeRecorder.reserve(); COMMIT
     -> onCommitted(headSeq)  (the stream hub publishes only committed changes: persist-before-publish)
                                  ^
   LifecycleSweeper (every 5 s): rows with next_check_at <= now -> re-derive -> same writer path
```

### 1.1 Files and modules owned by this design (Phase 2+ implementers)

| Path (under `.claude/skills/monitoring-claude-sessions/`) | Content |
|---|---|
| `runtime/packages/shared/src/protocol/hook-envelope.ts` | `HookEnvelopeV1` type, `HOOK_ENVELOPE_VERSION`, caps (section 2.3), `EnvelopeKind`, `SPOOL_SEGMENT_EXT`, `SPOOL_SEGMENT_RE`, `spoolSegmentName()` (2.7), id regexes `SID_RE`, `AGENT_RE`, `RUN_ID_RE`, `TOOL_ID_RE` (2.3.2), `HANDLER_VERSION` (2.1, registry N2) |
| `runtime/packages/shared/src/protocol/limits.ts` | `MAX_LINE_BYTES = 64 * 1024 * 1024`: the single line-length cap shared by the tailer (5.3), `readEntryText` (5.7) and the data design's transcript window and search (03 7); no configuration key (I-32) |
| `runtime/packages/shared/src/protocol/hook-events.ts` | `HOOK_EVENT_POLICY` table (section 2.4), `INSTALLED_HOOK_EVENTS`, `ASYNC_HOOK_EVENTS`, `HOOK_EVENT_RANK` |
| `runtime/packages/shared/src/protocol/sanitize.ts` | `clip()`, `summarizeToolInput()`, `redact()`, `canonicalJsonHash()`, `normalizePath()` (zod-free, used by handler and engine) |
| `runtime/packages/shared/src/protocol/routes.ts` | `HookRouteV1` type, `matchRoutes()` (pure), `resolveMcsHome(env)` (2.6.1; zod-free so the handler and the engine share it, registry N8) |
| `runtime/packages/shared/src/protocol/stamp.ts` | `Stamp`, `compareStamp()` |
| `runtime/packages/shared/src/schemas/ingest.ts` | zod: `HookEnvelopeV1Schema`, `HookRouteV1Schema`, `TranscriptRecordShape` (loose), `IngestHealthSchema` |
| `scripts/mcs-hook.mjs` | Stable hook entry stub (section 2.1, CHALLENGES C1) |
| `runtime/packages/cli/src/hook.ts` | Handler entry, emitted by `tsc` as `runtime/packages/cli/dist/hook.js`: `export { runHook } from './hook/main.js';` plus a main-module guard `if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) void runHook(process.argv.slice(2));` (E10). Imported by the stub (which calls `runHook` itself; the guard is false) or run directly (`node dist/hook.js --mcs-hook <Event>`, 05 `runHookHandler` option `direct: true`). Matches 05's lint block `cli/src/hook.ts` + `cli/src/hook/**` |
| `runtime/packages/cli/src/hook/{main,routes-reader,spool-writer,nudge,handler-log}.ts` | The handler modules (`main.ts` exports `runHook(argv: string[]): Promise<void>`); emitted as `dist/hook/*.js`, reached only through `dist/hook.js` |
| `runtime/packages/engine/src/hooks/installer/{plan,apply,verify,uninstall,status,settings-io}.ts` | Installer, verifier, uninstaller, status (section 3; N-11, C23). Called only by 01's `ops.hooks.{install,uninstall,verify,status}` (`engine/src/ops/hooks.ts`, INV-12); the engine never imports `cli/` (05 2.2) |
| `runtime/packages/cli/src/commands/hooks/{install,uninstall,verify,status}.ts` | Option tables and rendering only (3.1 flags, 3.6 human text, `--json` envelope): parse, call `ops.hooks.*`, print. Written in 01 S14 (CLI owner, 3.1 header); the text formats of 3.1 and 3.6 are normative here |
| `runtime/packages/engine/src/ingest/tail/{jsonl-tailer,file-identity,line-splitter}.ts` | Shared tail reader for spool and transcripts (section 5.3) |
| `runtime/packages/engine/src/ingest/spool/{spool-drainer,segments,replay}.ts` | Spool consumption, retention and replay (section 2.7) |
| `runtime/packages/engine/src/ingest/service.ts` | `createIngestService(ctx)` (section 4.10) |
| `runtime/packages/engine/src/ingest/transcripts/{discovery,classify,importer,scheduler,normalize-record,task-notification,entry-text}.ts` | Transcript import (section 5) |
| `runtime/packages/engine/src/ingest/hooks/normalize-envelope.ts` | Envelope to logical events (section 4.3) |
| `runtime/packages/engine/src/ingest/{writer,dedupe,errors,routes-file,event-row}.ts` | Writer, dedupe rules, error codes, route-file writer, `EventRowWrite` (4.1.2) |
| `runtime/packages/engine/src/external/{registry,jobs,pid}.ts` | External evidence pollers (section 7.10) |
| `runtime/packages/engine/src/tokens/{accumulate,aggregate,legacy-projection}.ts` | Token accounting (section 6) |
| `runtime/packages/engine/src/lifecycle/{facts,merge,derive-session,derive-agent,derive-workflow,rules,legacy,next-check,sweeper,work-items,completion}.ts` | Lifecycle (section 7); `rules.ts` exports `renderEvidence`, `toApiEvidence`, `viewChanged` (7.1); `legacy.ts` exports `toLegacy` (7.9); `completion.ts` exports `explainCompletion` (7.13) |
| `runtime/packages/engine/src/health/{ingest-health,alert-inputs}.ts` | Health model (section 8) |

Not owned here (consumed): `InstanceContext` and `createInstanceRuntime` (01 4.4, slice S8), repositories, `withWriteTx`,
`createChangeSink`, `createQueries` (03 4.5, 9.1, 12.1), `ErrorCode` (03 5.2, `shared/src/api/errors.ts`), `CliEnvelope`,
`acquireMutex`/`mutexName`, audit writer (01 6.2, 7.2), attempts rows (06 3.10 over 03's `attempt_runs`).

### 1.2 Runtime configuration keys read by this design (schemas owned by 01 1.6; alignment with I-01)

Every key lives in a `runtime.json` section that 01 composes into `RuntimeFileSchema` as `<Name>SectionSchema.prefault({})` with a
`z.strictObject`; the defaults below are normative. "Derived" = Zod default `null`, filled by 01's `R_DERIVED_DEFAULTS` from the legacy
(L) key named, multiplied by the scale shown (01 owns the mechanism; a scale of 1048576 converts the legacy MB values to bytes).

| Key | Type, range | Default | Read by |
|---|---|---|---|
| `spool.pollMs` | int 100..10000 | 500 | 2.7 drain poll |
| `spool.sealGraceMs` | int 10000..3600000 | 120000 | 2.7 sealing |
| `spool.retainHours` | int 1..720 | 24 | 2.7 retention |
| `import.lookbackHours` | int 1..8760 or null | derived `window_hours` (x1) | 5.1.2 |
| `import.headMaxBytes` | int 1 MiB..256 MiB | 16777216 | 5.2, 5.5 |
| `import.tailWindowBytes` | int 1 MiB..4 GiB or null | derived `limits.event_window_mb` (x1048576) | 5.5 |
| `import.backfillMaxBytes` | int 0..64 GiB or null | derived `limits.usage_max_mb` (x1048576) | 5.5 |
| `import.backfillShare` | number 0.05..1 | 0.25 | 5.4 |
| `import.sliceMs` | int 5..200 | 20 | 5.4 |
| `import.scanIntervalMs` | int 250..60000 | 1000 | 5.4 |
| `import.discoveryIntervalMs` | int 1000..600000 | 5000 | 5.1.2 |
| `import.untrackAfterHours` | int 1..8760 | 48 | 5.1.2 |
| `ingest.queueMaxItems` | int 100..100000 | 5000 | 4.7 |
| `ingest.queueMaxBytes` | int 1 MiB..512 MiB | 33554432 | 4.7 |
| `health.importLagWarnMs` | int 1000..3600000 | 30000 | 8.2 |
| `health.backlogWarnMs` | int 1000..3600000 | 10000 | 8.2 |
| `hooks.spoolWhileStoppedHours` | int 0..720 | 72 | 2.6.2 |
| `lifecycle.*` | see 7.8 | see 7.8 | 7 |
| `board.items` | see 7.11 | `[]` | 7.11 |

Ranges: the "Type, range" column is normative for these 02-owned keys (N-04); 01 1.6 copies it into the section schemas (registry
C02 points this column to 01 1.6, which then holds the same values; `hooks.spoolWhileStoppedHours` minimum 0 = stop spooling at
once, 2.6.2). The section modules `shared/src/config/runtime/{spool,import,ingest,health,hooks,lifecycle,board}.ts` are written by
01 S1 from this table, 7.8 and 7.11 and registered in `R_KEY_CATALOGUE` with owner `'02'` (N-03); this design's slices list no such
file.

There is no `import.maxLineBytes` (I-32): the line cap is the constant `MAX_LINE_BYTES` (1.1); tests lower it only through the injected
`readLines` option `maxLineBytes` (5.3). Test that proves it: 01's unit test parses an override file setting every key of this table
through `RuntimeOverridesSchema` (01 S1), and `config-keys.test.ts` in this design's slice I-8 asserts that every `cfg.<section>.<key>`
read under `engine/src/{ingest,lifecycle,health,external}` appears in this table (grep of the source).

### 1.3 Environment variables read by this design (listed for 01 2.10, alignment with I-27)

| Variable | Reader | Effect |
|---|---|---|
| `MCS_HOOK_DISABLE` | stub, handler (2.2 step 2), `claudeArgsWithoutHooks` (2.9) | `1` = handler exits 0 without reading routes or writing |
| `MCS_HOME` | handler, route writer, installer (2.6.1) | per-user state folder override (absolute path); tests point it at a temp dir |
| `LOCALAPPDATA`, `XDG_STATE_HOME` | `resolveMcsHome` (2.6.1) | default `MCS_HOME` location |
| `CLAUDE_PID` | handler (2.3.1 `claude_pid`) | Claude Code pid for liveness (E7) |
| `CLAUDE_CONFIG_DIR` | discovery (5.1.1), installer user scope (3.2), external pollers (7.10) | Claude home (default `~/.claude`) |
| `MCS_TEST`, `VITEST` | installer apply step 4 (3.5) | refuse writing real settings paths under test |
| `MCS_PERF_FACTOR` | handler performance tests (2.10, T-HK-10) | budget multiplier, default 1 (test-only) |
| `MCS_E2E_CLAUDE` | optional real-provider E2E (3.7, 9.3) | `1` enables the run (test-only) |

## 2. Hook handler

### 2.1 Invocation contract

Settings entry written by the installer (section 3.3), exec form, no shell:

```json
{ "type": "command", "command": "C:/Program Files/nodejs/node.exe",
  "args": ["--no-warnings", "<skill>/scripts/mcs-hook.mjs", "--mcs-hook", "PreToolUse", "--async"], "timeout": 5, "async": true }
```

- `command` = absolute path of the Node executable that ran `mcs hooks install` (`process.execPath`, forward slashes). Exec
  form avoids Git Bash (about 50 ms, profile output, quoting; HK:3.4, HK:8.2) and does not need `node` on PATH.
- `args[1]` = `scripts/mcs-hook.mjs`, a committed zero-dependency stub with a stable path (not a build output). It checks
  `MCS_HOOK_DISABLE`, then `await import(<skill>/runtime/packages/cli/dist/hook.js)` and calls `runHook(argv)`. If the import
  fails (runtime not built, `npm ci` in progress, upgrade), it drains stdin, appends `HANDLER_UNAVAILABLE` to the handler log
  (2.11) and exits 0. Reason: a missing handler path makes every hook fail with exit 1 and appends a
  `hook_non_blocking_error` attachment to the user's transcript per firing (HK:4, observed 24 entries in lab run3). The
  installer constant `HOOK_ENTRY_PATH` selects the stub; if the lead rejects the stub (CHALLENGES C1) only that constant
  changes to `runtime/packages/cli/dist/hook.js`.
- `--mcs-hook` is the ownership marker (section 3.3) and the hook-mode switch. `<Event>` is the event name the entry was
  installed for (`argv_event`, used when stdin is unparseable and to detect mismatches).
- `timeout` (seconds): 5 for every event except `SessionEnd`: 2 (the SessionEnd budget is shared, HK:3.2). The handler's
  own hard exit at 1200 ms makes the Claude Code timeout a second line of defence.
- `async: true` only for `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch` (ADR 0013).
- stdout: NEVER written in hook mode. stderr: never written intentionally (`--no-warnings` suppresses Node warnings).
  Exit code: always 0. The only non-hook mode is `mcs-hook.mjs --version` (prints `HANDLER_VERSION` + newline, exit 0),
  used by `mcs hooks verify`; any other argv without `--mcs-hook` exits 0 silently.

### 2.2 Handler algorithm (normative order)

```
runHook(argv):
 1. T0 = Date.now(); hardExit = setTimeout(() => process.exit(0), HANDLER_HARD_EXIT_MS=1200).unref()
    process.on('uncaughtException' | 'unhandledRejection', e => { logHandler('UNCAUGHT', ...); process.exit(0) })
 2. if env.MCS_HOOK_DISABLE === '1': drain stdin (bounded by hardExit); exit 0          (recursion guard, 2.9)
 3. if process.stdin.isTTY: exit 0                                                      (manual run, nothing to read)
 4. read stdin until 'end': keep the first STDIN_MAX_BYTES=8 MiB in memory, count the rest (payload_bytes = total),
    flag 'stdin_truncated' if total > cap
 5. mcsHome = resolveMcsHome(env)   (2.6.1); routes = readRoutes(mcsHome + '/routes')     (<= 64 files, each <= 16 KiB)
    if routes is empty: exit 0                                                           (fast path, nothing installed/running)
 6. payload = tryParse(raw as UTF-8): must be a plain object, else -> logHandler('STDIN_PARSE_ERROR', argv_event); exit 0
 7. ids = extractIds(payload): session_id, transcript_path, cwd, prompt_id, agent_id, agent_type, tool_use_id,
    permission_mode, hook_event_name; each validated (2.3.2); invalid ids become null and add flag 'invalid_<field>'
 8. matched = matchRoutes(routes, ids, T0)   (2.6.2); if matched is empty: exit 0
 9. kind = isProbe(payload) ? 'probe' : 'hook'      probe = session_id starts '00000000-0000-4000-8000-' AND
                                                     hook_event_name = 'Notification' AND notification_type = 'mcs_probe'
10. data = sanitizeEventData(event, payload)   (2.4, 2.5); content_hash = sha256hex(raw kept bytes).slice(0, 32)
11. for each route r in matched:
      env = envelope(r.instanceId, ...);  line = JSON.stringify(env) + '\n'
      if byteLength(line) > ENVELOPE_MAX_BYTES=16 KiB: env = minimalEnvelope(env) (flag 'minimal')
      seg = r.spoolDir + '/' + spoolSegmentName(T0)                  e.g. hooks-20261011T14Z.ndjson (2.7)
      fd = open(seg, 'a') (mkdir -p spoolDir once on ENOENT); size = fstat(fd).size
      if size >= SPOOL_SEGMENT_HARD_CAP=256 MiB: logHandler('SPOOL_FULL', r.instanceId); close; continue
      if size >= SPOOL_SEGMENT_SOFT_CAP=64 MiB: line = minimalEnvelope line
      writeSync(fd, line) (one call, whole line); close(fd)            on error: logHandler('SPOOL_WRITE_FAILED', r.instanceId)
12. nudgeTargets = matched routes with stoppedAt === null whose stateFile (<= 4 KiB) parses to
      {instanceId === r.instanceId, engine === 'node', port in 1..65535}
13. for each target in parallel: POST http://127.0.0.1:<port>/api/v3/ingest/nudge body {"instanceId": r.instanceId}
      settle on the FIRST of: response headers, request 'finish' (flushed), 'error', timeout NUDGE_TIMEOUT_MS=300
14. when all settled: process.exit(0)
```

Ordering rationale: routes are read before the payload is parsed so that machines with hooks installed but no running or
recent instance pay only the readdir (E1: 65 ms total, of which 5 ms in-script). The spool write happens before any
network I/O, so a slow or dead server never loses the event (the spool is the write-ahead log, D8).

### 2.3 Envelope v1

#### 2.3.1 Type (in `shared/src/protocol/hook-envelope.ts`, mirrored by `HookEnvelopeV1Schema`)

```ts
export const HOOK_ENVELOPE_VERSION = 1 as const;
export const HANDLER_HARD_EXIT_MS = 1200;
export const STDIN_MAX_BYTES = 8 * 1024 * 1024;
export const ENVELOPE_MAX_BYTES = 16 * 1024;
export const SPOOL_SEGMENT_SOFT_CAP = 64 * 1024 * 1024;
export const SPOOL_SEGMENT_HARD_CAP = 256 * 1024 * 1024;
export const NUDGE_TIMEOUT_MS = 300;
export const SUMMARY_MAX_CP = 160;      // tool summaries, previews
export const TITLE_MAX_CP = 80;
export const PATH_MAX_CHARS = 1024;
export const ID_MAX_CHARS = 128;
export const NAME_MAX_CHARS = 64;       // event names, agent types, enums
export const ROUTES_MAX_FILES = 64;
export const ROUTE_FILE_MAX_BYTES = 16 * 1024;
export const SPOOL_SEGMENT_EXT = '.ndjson' as const;    // never '.jsonl': the legacy audit flags every *.jsonl in a workspace (2.7, X1)
export const SPOOL_SEGMENT_RE = /^hooks-(\d{8})T(\d{2})Z\.ndjson$/;
export function spoolSegmentName(receivedAt: number): string;   // 'hooks-' + UTC yyyyMMdd + 'T' + UTC HH + 'Z' + SPOOL_SEGMENT_EXT

export type EnvelopeKind = 'hook' | 'probe';

export interface HookEnvelopeV1 {
  v: 1;
  kind: EnvelopeKind;
  instance_id: string;              // route the line was written for (uuid v4); drainers reject other values
  event_uid: string;                // crypto.randomUUID(), generated once per handler run, same in every routed copy
  received_at: number;              // T0 = Date.now() at handler start (the closest available "occurred at")
  event: string;                    // payload.hook_event_name if /^[A-Za-z]{1,64}$/ else argv_event else 'Unknown' (the field is `event`; there is no `hook_event_name` key in an envelope)
  argv_event: string;               // event name from argv ('' if absent)
  session_id: string | null;        // lowercase UUID (2.3.2) or null
  transcript_path: string | null;   // normalizePath(), <= 1024 chars
  cwd: string | null;               // normalizePath(), <= 1024 chars
  prompt_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  tool_use_id: string | null;
  permission_mode: string | null;
  claude_pid: number | null;        // env CLAUDE_PID when /^[0-9]{1,10}$/ (E7: the claude.exe pid)
  payload_bytes: number;            // total stdin bytes (also beyond the cap)
  content_hash: string;             // first 32 hex of sha256(stdin bytes kept)
  handler: { version: string; pid: number; async: boolean };   // async = argv contains '--async' (installer adds it with async: true)
  flags: string[];                  // see 2.3.3, max 32 entries
  data: Record<string, string | number | boolean | null | Array<Record<string, string | null>>>;   // 2.4
}
```

Example (PreToolUse, Bash; values are placeholders):

```json
{"v":1,"kind":"hook","instance_id":"6a0f3c1e-1b2c-4d3e-8f40-0123456789ab","event_uid":"0f8b5e2a-7c41-4e0b-9d3a-2b1c0d9e8f7a",
 "received_at":1791727200123,"event":"PreToolUse","argv_event":"PreToolUse","session_id":"11111111-2222-4333-8444-555555555555",
 "transcript_path":"C:/Users/<user>/.claude/projects/D--repo/11111111-2222-4333-8444-555555555555.jsonl","cwd":"D:/repo",
 "prompt_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","agent_id":null,"agent_type":null,"tool_use_id":"toolu_PLACEHOLDER",
 "permission_mode":"default","claude_pid":18380,"payload_bytes":512,"content_hash":"0123456789abcdef0123456789abcdef",
 "handler":{"version":"3.0.0","pid":20112,"async":true},"flags":[],
 "data":{"tool_name":"Bash","tool_summary":"npm test","tool_input_hash":"fedcba9876543210fedcba9876543210","tool_input_bytes":61,"tool_input_keys":"command,description"}}
```

#### 2.3.2 Field validation in the handler (cheap regexes, no zod)

Exported from `shared/src/protocol/hook-envelope.ts` and imported by every other design that validates these ids (05 testkit
`RUN_ID_RE` included, I-26): `SID_RE`, `AGENT_RE`, `TOOL_ID_RE`, `RUN_ID_RE = /^wf_[A-Za-z0-9_-]{1,64}$/`.

| Field | Accepted | Otherwise |
|---|---|---|
| `session_id` | `SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` (legacy `SID_RE`) | null + flag `invalid_session_id` |
| `agent_id` | `AGENT_RE = /^[0-9A-Za-z_-]{3,64}$/` (legacy `AGENT_RE`) | null + flag |
| `tool_use_id`, `prompt_id` | `TOOL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/` | null + flag |
| `agent_type`, `permission_mode`, enums | string, `<= 64` chars, no control characters | null + flag |
| paths | string, `<= 1024` chars after `normalizePath` (backslash to `/`, no trailing `/`) | null + flag `invalid_<field>` |

#### 2.3.3 Flags (closed set)

`stdin_truncated`, `invalid_<field>` (one per invalid id/path field), `event_mismatch` (payload event differs from
`argv_event`), `minimal` (reduced envelope), `redacted` (at least one redaction rule fired), `routed_by_cwd`,
`routed_by_session_pin`, `data_truncated:<field>` (a summarized list was cut, for example `calls`).

#### 2.3.4 Minimal envelope

Used when the full line exceeds 16 KiB or the segment passed the soft cap: same top-level fields, `flags` gets `minimal`,
`data` keeps only these keys when present: `tool_name, source, reason, notification_type, trigger, error, exit_code, calls`
(`calls` cut to 16 entries). A minimal envelope is still a complete lifecycle signal.

### 2.4 Per-event field policy (the 21 installed events)

Common fields are lifted to the top level (2.3.1). Everything not listed under "kept" or "summarized" is dropped, in
particular every free-text body. `cp` = code points. Previews pass through `redact()` (2.5). "Async" = registered with
`async: true` (ADR 0013). Dedupe keys are defined in section 4.4; N = exact natural key, C = content-hash window.

| # | Event | Mode | `data` kept verbatim (capped) | `data` summarized | Dropped (never stored) | Dedupe |
|---|---|---|---|---|---|---|
| 1 | SessionStart | sync | `source` (<=16), `model` (<=128), `context_tokens` (int) | `session_title` -> `session_title_len` | `session_title`, `seconds_since_last_response`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` | C |
| 2 | UserPromptSubmit | sync | - | `prompt` -> `prompt_len` (cp), `prompt_slash` (bool: first non-space char is `/`); `session_title` -> len | `prompt`, `session_title` | C |
| 3 | PreToolUse | async | `tool_name` (<=128), `mcp_server_name` (<=128) | `tool_input` -> `tool_summary` (2.5.2), `tool_input_hash`, `tool_input_bytes`, `tool_input_keys` (top-level names, comma-joined, <=16 names); Agent: `subagent_type` (<=64), `run_in_background` (bool); Workflow: `workflow_name` (<=128 from input `name` if string) | `tool_input` body | N (`tool_use_id`) |
| 4 | PermissionRequest | sync | `tool_name`, `mcp_server_name` | `tool_input` -> `tool_summary`, `tool_input_hash`; `permission_suggestions` -> `suggestion_count` | `tool_input`, `permission_suggestions` | C |
| 5 | PermissionDenied | sync | `tool_name` | `reason` -> `reason_preview` (<=160 cp) | `tool_input` | N (`tool_use_id`) |
| 6 | PostToolUse | async | `tool_name`, `duration_ms` (int) | `tool_response` -> `response_bytes`; Agent: `agent_link_id` (from `tool_response.agentId`, `AGENT_RE`), `agent_status` (<=32), `agent_total_tokens` (int, informational, never summed), `agent_total_duration_ms`, `agent_tool_use_count`; Workflow: `run_id` (`^wf_[A-Za-z0-9_-]{1,64}$`), `run_status` (<=32), `task_id` (<=128); Bash: `interrupted` (bool) | `tool_input`, `tool_response` bodies (`stdout`, `content`, `prompt`, `usage`...) | N (`tool_use_id`) |
| 7 | PostToolUseFailure | async | `tool_name`, `is_interrupt` (bool), `duration_ms` | `error` -> `exit_code` (int, only when the first line matches `^Exit code ([0-9]{1,5})$`), `error_len` | `error` text, `tool_input` | N (`tool_use_id`) |
| 8 | PostToolBatch | async | - | `tool_calls` -> `calls`: `[{tool_use_id, tool_name}]` (<=64, flag `data_truncated:calls`) | every `tool_input` and `tool_response` | N (`ids_hash`) |
| 9 | Notification | sync | `notification_type` (<=64) | `title` -> `title_preview` (<=80 cp), `message` -> `message_preview` (<=160 cp), `message_len` | - | C |
| 10 | SubagentStart | sync | (common `agent_id`, `agent_type`) | - | - | C |
| 11 | SubagentStop | sync | `agent_transcript_path` (path rules), `stop_hook_active` (bool) | `last_assistant_message` -> `last_message_len`; `background_tasks` -> `background_task_count`; `session_crons` -> `cron_count` | `last_assistant_message` | C |
| 12 | TaskCreated | sync | `task_id` (<=128), `teammate_name` (<=64), `team_name` (<=64) | `task_subject` -> `subject_preview` (<=160 cp); `task_description` -> `description_len` | `task_description` | N (`task_id`) |
| 13 | TaskCompleted | sync | as TaskCreated | as TaskCreated | as TaskCreated | N (`task_id`) |
| 14 | Stop | sync | `stop_hook_active` (bool) | `last_assistant_message` -> `last_message_len`; `background_tasks` -> `background_task_count`; `session_crons` -> `cron_count` | `last_assistant_message` | C |
| 15 | StopFailure | sync | `error` (<=64) | `error_details` -> `error_preview` (<=160 cp); `last_assistant_message` -> len | bodies | C |
| 16 | TeammateIdle | sync | `teammate_name`, `team_name` | - | - | C |
| 17 | PreCompact | sync | `trigger` (<=16) | `custom_instructions` -> `custom_instructions_len` | `custom_instructions` | C |
| 18 | PostCompact | sync | `trigger` | `compact_summary` -> `compact_summary_len` | `compact_summary` | C |
| 19 | PostModelSwitch | sync | `from_model`, `to_model`, `requested_model` (<=128), `source` (<=32), `context_tokens` (int), `prompt_cache_warm` (bool), `cache_ttl` (<=16) | - | `pricing`, `estimated_cache_write_usd` | C |
| 20 | CwdChanged | sync | `old_cwd`, `new_cwd` (path rules) | - | - | C |
| 21 | SessionEnd | sync | `reason` (<=32) | - | - | C |
| - | any other name | (not installed) | - | top-level key names -> `data_keys` (<=32 names) | everything else | C |

Common payload fields: `effort.level` -> top-level is not added; it goes to `data.effort_level` (<=16) when present;
`scratchpad_dir` is dropped. Not registered (HK:10): WorktreeCreate, WorktreeRemove (a silent handler would break worktree
creation), MessageDisplay (adds display latency), PreModelSwitch (a timeout blocks the switch), Elicitation,
ElicitationResult, FileChanged, Setup, ConfigChange, InstructionsLoaded, UserPromptExpansion, DirectoryAdded.

### 2.5 Sanitization functions (`shared/src/protocol/sanitize.ts`, used by the handler AND the transcript normalizer)

#### 2.5.1 `clip(value, n)` - legacy-compatible

1. `s = typeof value === 'string' ? value : pyJsonDumps(value)` where `pyJsonDumps` reproduces Python
   `json.dumps(v, ensure_ascii=False)` (separators `", "` and `": "`, insertion key order). 2. Count code points
   (`[...s].length`). 3. If count <= n return `s`; else return the first n code points + ` ... [truncated K chars]` with
   K = count - n. (Golden: CS:C.2 `clip`; code-point counting is required, UTF-16 counting differs on emoji.)

#### 2.5.2 `summarizeToolInput(input)`

1. If `input` is not a plain object return `''`.
2. `key` = the first truthy value among `input.command, input.file_path, input.pattern, input.description, input.prompt,
   input.script` (legacy order, CS:C.2), then `input.url, input.query, input.path, input.notebook_path, input.skill,
   input.subject` (new, after the legacy keys).
3. Non-string `key` -> `JSON.stringify(key)` (documented deviation: Python used `str()`).
4. Take the first line (split on LF), `redact()` it, `clip(..., 160)`.

#### 2.5.3 `redact(text)` - applied to every preview and summary; never to ids

Rules run in this order; each replacement sets the flag `redacted`. Flags `gi` unless noted.

```ts
// Order matters. Each rule that changes the text adds the envelope/entry flag 'redacted'.
export const REDACTION_RULES: ReadonlyArray<{ id: string; re: RegExp; to: string }> = [
  { id: 'R1', re: /\b(authorization|proxy-authorization)\s*[:=]\s*(bearer|basic|token)?\s*[^\s"']+/gi, to: '$1: [redacted]' },
  { id: 'R2', re: /\b([A-Za-z0-9_.-]*(token|secret|passw(or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)[A-Za-z0-9_.-]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s&]+)/gi, to: '$1=[redacted]' },
  { id: 'R3', re: /(--?(token|password|passwd|secret|api-?key|auth|key)(=|\s+))("[^"]*"|'[^']*'|\S+)/gi, to: '$1[redacted]' },
  { id: 'R4', re: /\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, to: '[redacted]' },
  { id: 'R5', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, to: '$1[redacted]@' },
  { id: 'R6', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: '[email]' },
  { id: 'R7', re: /[A-Za-z0-9+\/=_-]{40,}/g, to: '[redacted:<length>]' },   // replacer: keeps pure lowercase hex of length 40 or 64 (git ids), else '[redacted:' + m.length + ']'
];
```

`redact` is pure and bounded: input is clipped to 4,096 cp BEFORE redaction (all previews are shorter afterwards).

#### 2.5.4 Hashes and paths

- `canonicalJsonHash(v)`: JSON with object keys sorted recursively, UTF-8, sha256, first 32 hex chars. Used for
  `tool_input_hash` (correlates PermissionRequest with PreToolUse) and `ids_hash` (sorted tool_use_ids joined by `,`).
- `normalizePath(p)`: replace `\` by `/`; collapse repeated `/` except a leading `//` (UNC); strip a trailing `/`; keep
  case. `routeKey(p)` = `normalizePath(p)` lowercased when `process.platform === 'win32'`. This is the only platform branch of
  this design; engine modules (discovery 5.1.1) call `routeKey` instead of reading `process.platform`, and `shared/src/protocol/**`
  is exempt from 06's platform-branching lint rule (I-34).

### 2.6 Routing to instances (answers foundations open question 5)

Decision (ADR 0011): one small route file per running-or-recent instance in a per-user directory,
`$MCS_HOME/routes/<instanceId>.json`, written by the server and the CLI, read by the handler. Matching is by the
transcript project folder, which is exactly the legacy scope of an instance (`transcripts_dir`, CS:C.4). Rejected: scanning
`CLAUDE_PROJECT_DIR/.claude/monitor/tasks/*` per event (needs config parsing, the Python-regex rules and transcripts-dir
auto-detection inside the handler; misses instances whose `transcripts_dir` points elsewhere) and one shared per-repo index
(multi-writer lost updates).

#### 2.6.1 `MCS_HOME`

`resolveMcsHome(env)` (`shared/src/protocol/routes.ts`, 1.1): `env.MCS_HOME` if non-empty and absolute; else on win32 `env.LOCALAPPDATA + '/mcs'` (fallback
`os.homedir() + '/AppData/Local/mcs'`); else `(env.XDG_STATE_HOME || os.homedir() + '/.local/state') + '/mcs'`. Layout used by
this design: `routes/`, `logs/hook-handler.jsonl`, `hooks/installs.json`, `backups/settings/`. (The workspace
designer owns the rest of `MCS_HOME`, including the mutex fallback `locks/`; see dependencies.)

#### 2.6.2 Route file and `matchRoutes`

```ts
export interface HookRouteV1 {
  v: 1;
  instanceId: string;            // uuid v4, equals instance.json instanceId; file name = <instanceId>.json
  workspace: string;             // normalizePath(absolute task workspace)
  spoolDir: string;              // MUST equal workspace + '/data/spool' (handler rejects anything else)
  stateFile: string;             // MUST equal workspace + '/state.json'
  enabled: boolean;              // instance.json hooks.enabled
  match: {
    transcriptsDirs: string[];   // routeKey() of the resolved transcripts_dir (and the predicted one, see below); <= 8
    sessionIds: string[];        // legacy pinned session_ids (<= 256)
  };
  stoppedAt: number | null;      // null while the server runs
  spoolUntil: number | null;     // stopped instances keep receiving envelopes until this time (null = never)
  updatedAt: number;
}
```

`matchRoutes(routes, ids, now)` returns routes where ALL hold:
1. `r.v === 1`, `r.enabled === true`, `r.spoolDir === r.workspace + '/data/spool'`, `r.stateFile === r.workspace + '/state.json'`.
2. `r.stoppedAt === null || (r.spoolUntil !== null && now < r.spoolUntil)`.
3. One of: (a) `ids.transcript_path` non-null and `routeKey(dirname(transcript_path))` is in `r.match.transcriptsDirs`;
   (b) `ids.session_id` is in `r.match.sessionIds` (flag `routed_by_session_pin`);
   (c) `ids.transcript_path` is null, `ids.cwd` non-null and `sanitizeProjectName(cwd)` equals the last path segment of a
   `transcriptsDirs` entry, compared case-insensitively (flag `routed_by_cwd`). `sanitizeProjectName` replaces every
   character outside `[A-Za-z0-9]` with `-` (TS:1).

Subagent events carry the PARENT transcript path (HK:2.2), so they route with their session. The handler never opens
`transcript_path`; it is only a routing key.

Route writers (`engine/src/ingest/routes-file.ts`, function `writeRouteFile(instance, state)`; atomic temp + rename):
- server start, after transcripts-dir resolution: `stoppedAt: null`. `transcriptsDirs` = the resolved directory plus the
  predicted folder `projectsRoot/sanitizeProjectName(repo)` (so the first session of a fresh repo routes before its folder
  exists).
- server graceful stop and `mcs stop` (which may kill without the server's shutdown path): `stoppedAt: now`,
  `spoolUntil: now + hooks.spoolWhileStoppedHours * 3600000` (default 72 h; 0 = stop spooling at once).
- `mcs configure` of `repo`, `transcripts_dir`, `session_ids`, or `hooks.enabled`: rewrite.
- instance removal (`mcs cleanup`/delete): remove the file. No other writer exists; the handler only reads.

### 2.7 Spool format, segments, drain, retention, replay

- Directory: `<workspace>/data/spool/`. Segment name: `spoolSegmentName(received_at)` = `hooks-<YYYYMMDD>T<HH>Z.ndjson`, the UTC
  hour of `received_at` (constant `SPOOL_SEGMENT_EXT = '.ndjson'`, 2.3.1). The handler appends; nothing else writes segments.
  Content: UTF-8, one `HookEnvelopeV1` JSON object per line, LF (newline-delimited JSON; the format is JSON Lines, only the
  extension differs).
- Why `.ndjson` and not `.jsonl` (I-02): the legacy `audit` (and the legacy `doctor`, which runs it per task) reports every file
  whose name ends in `.jsonl` inside a task workspace as "transcript copy found" and exits 1 (critic X1: exit 1 with `.jsonl`,
  exit 0 with `.ndjson`). The legacy engine is the fallback and the parity oracle (D1, C1), so a Node workspace must keep passing
  it. The drainer lists only names matching `SPOOL_SEGMENT_RE`; any other file in `data/spool/` is ignored and counted once in
  health (`spool.foreignFiles`). Followers of this name (owned elsewhere): 03 `spool_cursors.segment` CHECK `GLOB '*.ndjson'`;
  01 1.1 workspace layout and C-1; 05 1.2; 06 7.1 workspace listing; foundations D3 text (`data/spool/*.ndjson`).
- Atomicity: every line is written with one `writeSync` on an fd opened with flag `a` (E2: no torn lines with 16
  concurrent writers up to 4 MB per line). The drainer still treats a torn line as an ingest error, never as a crash.
- `SpoolDrainer` (server, priority P0) per segment keeps a cursor (logical entity `spool_cursor`, 4.1) and uses the same
  `JsonlTailer` as transcripts (5.3), so partial last lines (a writer in flight) are never consumed.
  Drain triggers: server start (all segments with cursor not `sealed`), every nudge (coalesced: at most one drain running,
  a nudge during a drain sets `dirty`), and a poll every `spool.pollMs` (default 500) that stats only the current-hour and
  previous-hour segments.
- Per line: `JSON.parse` -> `HookEnvelopeV1Schema.safeParse` -> `instance_id` must equal this instance (`INSTANCE_MISMATCH`
  error otherwise) -> `normalizeEnvelope` (4.3) -> IngestWriter. The cursor advance for the lines of a batch is committed
  in the SAME transaction as their derived rows (4.6), so a crash re-reads at most one uncommitted batch, and dedupe on
  `event_uid` makes the re-read a no-op.
- Sealing: a segment is `sealed` when `now > hourEnd(segment) + spool.sealGraceMs` (default 120000, larger than the 1.2 s
  handler lifetime plus clock slack) AND `offset == size` AND no partial bytes. A partial tail older than the grace is
  counted once as `SPOOL_TORN_TAIL` and the segment is sealed anyway.
- Retention: sealed segments are deleted when `now > hourEnd + spool.retainHours * 3600000` (default 24). The total spool
  size is reported in health (8.2).
- Replay (`engine/src/ingest/spool/replay.ts`; the CLI command `mcs ingest replay --task <slug> [--from <segment>] [--yes]` is
  owned by 01 6.3, I-29):
  ```ts
  export interface SpoolReplayPlan { segments: Array<{ segment: string; bytes: number; offset: number; sealed: boolean }>; totalBytes: number }
  export function planSpoolReplay(ctx: RepoContext, repos: { spoolCursors: SpoolCursorsRepo }, spoolDir: string, from: string | null): Promise<SpoolReplayPlan>;
  export function applySpoolReplay(db: InstanceDb, ctx: RepoContext, plan: SpoolReplayPlan): { segmentsReset: number };
  ```
  1. `from` must match `SPOOL_SEGMENT_RE` and exist on disk, else error `SPOOL_SEGMENT_NOT_FOUND` (CLI: `NOT_FOUND`, exit 1).
  2. Plan = every segment file on disk whose name sorts `>= from` (all segments when `from` is null), with its cursor row.
  3. Without `--yes` the CLI prints the plan (`<segment> <bytes>` lines and the total) and exits 0 (dry run, 01 6.2).
  4. Instance stopped: the CLI opens the DB in `maintenance` mode (03 4.5) and calls `applySpoolReplay`, which runs ONE
     `withWriteTx` that sets `offset_bytes = 0, partial_bytes = 0, sealed = 0, lines = 0` for every planned segment (rows are
     created for segments without a cursor); 01 6.4 calls `planSpoolReplay` then `applySpoolReplay` (C04). Instance running: the
     CLI sends the control operation `ingest-replay` with field `fromSegment` (01 4.3, ADR 0005; reply `{segments}`); the server's
     `runtime.ingestReplay(fromSegment)` calls `IngestService.replay(fromSegment)` (4.10), which runs the same `applySpoolReplay`
     from the writer queue (so it never interleaves with a drain transaction) and then triggers a drain. Both paths map
     `segmentsReset` to the reply and output field `segments` (I-29, C03, C04).
  5. Audit action `ingest-replay` with 01 7.2's template verbatim (no wording of its own here; C05).
  6. Dedupe D-1 (`event_uid`) makes the re-drain a no-op for already ingested lines; only lines never committed add rows.
  Tests: T-PL-03 (no new rows after replay of 3 segments), T-PL-11 (dry run changes nothing; `--from` unknown -> `NOT_FOUND`;
  running instance path goes through the writer queue: a drain and a replay submitted together never run in one transaction).
- Identity: if a segment's `ino` or 256-byte head hash changes, its cursor resets to 0 (`identity_reset` reconciliation).
- Downtime evidence: at server start, if the oldest unconsumed envelope has `received_at < startedAt - 5000`, the writer
  records reconciliation `runtime_unavailable {from: oldest received_at, to: startedAt, envelopes: N}` (8.3).

### 2.8 Nudge protocol (`POST /api/v3/ingest/nudge`)

- Request: `Content-Type: application/json`, body `{"instanceId":"<uuid>"}` (<= 256 bytes), no `Origin` header, no auth.
- Server (error codes are the `ErrorCode` union of the data design's catalogue, 03 5.2, `shared/src/api/errors.ts`; the guards are
  03 5.2 steps 2-3 and 7, I-04): bad `Host` -> `403 host_not_allowed`; a request WITH an `Origin` header -> `403 origin_not_allowed`
  (browsers always send one on cross-site POST); `Sec-Fetch-Site: cross-site` -> `403 cross_site_request`; other content type ->
  `415 unsupported_media_type`; body > 256 bytes -> `413 payload_too_large`; unparseable body -> `400 body_invalid_json`; schema
  failure -> `400 validation_failed`; `instanceId` different from the server's -> `409 instance_mismatch`; otherwise
  `IngestService.nudge()` (4.10) and `204` at once (never wait for the drain).
- Why no token: the request carries no data. Its only effect is "read your own spool now", which the 500 ms poll does
  anyway. The trust boundary is the file system (the spool lives in the user's workspace). ADR 0012.
- Handler side: settles on response OR flush OR error OR 300 ms (E1b: a hanging server costs about 92 ms, delivery
  15 of 15). The handler never retries and never reads the response body or the error code.
- Test that proves the codes: T-HK-06b (in slice I-4, against the real nudge route of 03 S4): each refusal above returns the listed
  status and `error.code`, asserted with the shared `ErrorCode` type (no string literals in the test).

### 2.9 Recursion guard and self-observation

1. The handler checks `MCS_HOOK_DISABLE === '1'` before anything else (step 2) and exits 0 without writing.
2. Every `claude` process launched by monitor tooling (server features, tests that should not be observed) MUST be spawned
   through `engine/src/external/launch-claude.ts` `claudeArgsWithoutHooks(args)` which prepends
   `--settings '{"disableAllHooks":true}'` and sets `MCS_HOOK_DISABLE=1` in the child env. Hook processes inherit the
   session env (HK:3.4), so grandchildren are covered.
3. The handler spawns no process, writes no file outside `$MCS_HOME/logs/` and the matched spool dirs, emits no JSON on
   stdout (so it can never emit `decision`, `continue`, `additionalContext`, `watchPaths`...).
4. E2E tests that WANT their sessions observed run `claude -p` with a temp `--settings` file and a temp `MCS_HOME`; they
   never touch real settings (C3).

### 2.10 Performance budget (measured on this machine, E1)

| Path | Budget (median / p90 wall, spawn to exit) | Measured median |
|---|---|---|
| no route matches | 120 / 200 ms | 65 ms |
| route matches, server stopped | 120 / 200 ms | 67-70 ms |
| route matches, server running | 150 / 250 ms | 70 ms |
| server hung | 200 / 450 ms (300 ms nudge cap) | 92 ms (exit on flush) |
| in-script work (excluding Node start) | 25 ms median | 5-10 ms |

Budgets are 2x measurements to absorb slower machines; test T-HK-10 enforces them with `MCS_PERF_FACTOR` (default 1, CI
may set 2). A synchronous handler therefore adds about 0.07 s per lifecycle event; the four tool events run async.

### 2.11 Failure behavior and diagnostics (never blocking)

| Failure | Handler behavior | Observable where |
|---|---|---|
| `dist/hook.js` missing or fails to import | stub drains stdin, exit 0 | handler log `HANDLER_UNAVAILABLE`; `mcs hooks verify`; health `receiving.hooks.handlerErrors` |
| Node missing (bad `command` path) | Claude Code reports a non-blocking error (cannot be prevented) | transcript attachment `hook_non_blocking_error` whose `command` contains `--mcs-hook` (E9) -> importer emits `hook.handler_error` -> health and alert input `hook_failing`; `mcs doctor` checks the path |
| invalid stdin JSON | exit 0 | handler log `STDIN_PARSE_ERROR` (event name only) |
| routes dir unreadable / route invalid | skip the route | handler log `ROUTES_UNREADABLE` / `ROUTE_INVALID` (route file name only) |
| spool write fails / segment full | skip that instance | handler log `SPOOL_WRITE_FAILED` / `SPOOL_FULL` (instance id) |
| server down | spool keeps the event | reconciliation `runtime_unavailable` at next start; health `spool.oldestPendingReceivedAt` |
| uncaught exception | exit 0 | handler log `UNCAUGHT` (error name, no message text) |

Handler log: `$MCS_HOME/logs/hook-handler.jsonl`, one line `{"at":<ms>,"code":"<CODE>","event":"<name>","instanceId":<uuid|null>,"pid":<n>,"detail":"<= 120 ASCII chars, no payload, no paths except route file names>"}`.
When the file exceeds 1 MiB the handler renames it to `hook-handler.1.jsonl` (replacing the old one) before appending.
Readers: `mcs hooks status`, `mcs doctor`, and the server health task (every 30 s, tail 64 KiB, filter by `instanceId` or null).

### 2.12 Tests that prove it (handler)

All spawn the real built handler through the stub with `MCS_HOME` in a temp dir; none touch real settings.

| Id | Guarantee | Test |
|---|---|---|
| T-HK-01 | Never blocks, never prints, always exit 0 | For each of: the 21 event fixtures, invalid JSON, empty stdin, 9 MiB stdin, unknown event name, no `MCS_HOME/routes`, unreadable routes dir, route file with invalid JSON, read-only spool dir, invalid `state.json`: exit code 0, stdout and stderr empty |
| T-HK-02 | Recursion guard | `MCS_HOOK_DISABLE=1`: exit 0, no file created under `MCS_HOME` or any spool dir |
| T-HK-03 | Envelope shape and privacy | Each event fixture puts sentinel strings `SENTINEL_DROP_<field>` into every dropped field: the spool line passes `HookEnvelopeV1Schema`, is <= 16 KiB, and contains no sentinel |
| T-HK-04 | Redaction | Table test of R1-R7 (at least 3 inputs each incl. a non-match) on `redact()`; plus a Bash `tool_input.command` with a bearer token produces a redacted `tool_summary` and flag `redacted` |
| T-HK-05 | Routing | Unit (`matchRoutes`): backslash and drive-letter case variants, pinned session id, cwd fallback, disabled route, stopped route before and after `spoolUntil`, malformed `spoolDir`. Spawn test: two matching routes give two spool lines with the same `event_uid` and different `instance_id` |
| T-HK-06 | Nudge bounded | Test server on `allocatePort(VITEST_PORTS)`: answering (1 request seen), port closed (wall < 400 ms), hanging (wall < 450 ms and request received), `state.instanceId` mismatch or `engine: "legacy"` (no request) |
| T-HK-07 | Hard exit | stdin kept open: exit 0 within 1300 ms |
| T-HK-08 | Caps | Prefilled segment of 64 MiB -> `minimal` envelope; 256 MiB (sparse file) -> no write + `SPOOL_FULL` in handler log |
| T-HK-09 | Concurrency | 16 parallel handler runs on one route: 16 valid lines, 16 distinct `event_uid` |
| T-HK-10 | Performance | 30 runs per path of 2.10: medians and p90 within budget x `MCS_PERF_FACTOR` |
| T-HK-11 | Runtime unavailable | `dist/hook.js` renamed away: exit 0, empty output, `HANDLER_UNAVAILABLE` logged |
| T-HK-12 | Probe | Probe payload -> `kind: "probe"` |
| T-HK-13 | Hash identity | Same stdin twice -> equal `content_hash`, different `event_uid` |
| T-HK-14 | Version mode | `mcs-hook.mjs --version` prints `HANDLER_VERSION` and exits 0; without `--mcs-hook` and without `--version`: no output |
| T-HK-15 | Child sessions | `claudeArgsWithoutHooks()` output contains `--settings` with `disableAllHooks:true` and env `MCS_HOOK_DISABLE=1` |
| T-HK-16 | Legacy-audit-safe spool names | Unit: `spoolSegmentName(Date.UTC(2026, 9, 11, 14, 5))` = `hooks-20261011T14Z.ndjson`, matches `SPOOL_SEGMENT_RE`, never ends in `.jsonl` (also at hour 0 and 23, and year boundaries). Spawn: after a routed event, `data/spool/` holds only `*.ndjson`. Parity (Python available, 05 parity suite): legacy `viewer.py audit --repo <temp>` on a workspace whose spool holds a written segment exits 0 with `ok: true` (release gate input for 01 T-XE-06 and gate G8) |
| T-HK-17 | Entry is importable and runnable | Importing `dist/hook.js` runs nothing (no stdout, no spool write); `node dist/hook.js --mcs-hook Stop` with a probe payload writes one spool line (E10 guard) |


## 3. Hook installer, verifier, uninstaller

### 3.1 Commands (CLI designer owns parsing and help text; this section owns behavior)

Each command is a thin CLI module (1.1) that calls 01's op, which calls this design's engine module (`engine/src/hooks/installer/`,
N-11, C23): `hooks install` -> `ops.hooks.install` -> `planHooks` (3.4) + `applyHooks` (3.5); `hooks uninstall` ->
`ops.hooks.uninstall` -> the same with op `uninstall`; `hooks verify` -> `ops.hooks.verify` -> `verifyHooks` (3.7); `hooks status`
-> `ops.hooks.status` -> `hooksStatus`. 01 6.3 lists the same surface: `hooks install` with `--sync-tool-events`, `hooks status`
(`--task` optional, `--json`, exit 0). Dry run is the default without `--yes` (01's `--dry-run` is accepted as an explicit spelling
of the default).

| Command | Default | Effect | Exit codes |
|---|---|---|---|
| `mcs hooks install --task <slug> [--scope project-local\|user] [--sync-tool-events] [--yes] [--json]` | scope `project-local`, dry run | Plans the merge, prints the plan; with `--yes` applies it (3.5) | 0 planned/applied/already installed; 1 refused or failed; 2 usage |
| `mcs hooks uninstall --task <slug> [--scope ...] [--yes] [--json]` | dry run | Removes every handler carrying the marker from that settings file | same |
| `mcs hooks verify --task <slug> [--scope ...] [--json]` | - | Static checks + synthetic probe (3.7); never edits settings | 0 all ok; 1 any check false |
| `mcs hooks status [--task <slug>] [--json]` | - | Installed scopes (manifest + settings scan), handler log summary, last envelope per instance | 0 |
| `--settings-file <abs path>` (all four, test and expert flag) | - | Use this file instead of the scope path; the manifest records it as scope `file` | - |

`--json` output (all hooks commands, I-29): exactly one 01 `CliEnvelope<T>` (`schema: 'mcs.cli/1'`, 01 6.2) whose `command` is
`hooks install` | `hooks uninstall` | `hooks verify` | `hooks status` and whose `data` is the command's result object (types in
`@mcs/shared/cli/results.ts`, owned by 01; shapes owned here):

```ts
export interface HooksApplyResult {            // install, uninstall
  scope: 'project-local' | 'user' | 'file'; settingsPath: string; action: 'plan' | 'applied' | 'noop' | 'refused';
  added: string[]; replaced: string[]; removed: string[]; kept: string[];   // event names (3.4 step 8)
  warnings: Array<{ code: HooksWarningCode; message: string }>;
  backupPath: string | null; diff: string;       // unified diff of the `hooks` key only
}
export type HooksWarningCode = 'HOOKS_SETTINGS_NOT_IGNORED' | 'HOOKS_USER_SCOPE' | 'HOOKS_LIVE_RELOAD';
export interface HooksVerifyResult { checks: Array<{ check: 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7'; ok: boolean | null; detail: string }> }  // null = skipped (V7 when stopped)
export interface HooksStatusResult { installs: Array<{ settingsPath: string; scope: string; events: number; handlerVersion: string; at: number }>;
  handlerLog: Array<{ code: string; count: number; lastAt: number }>; lastEnvelopeAt: Record<string /* instanceId */, number | null> }
```

Failures use the envelope's `error` with the 01 code `HOOKS_FAILED` (exit 1) and `details.reason` set to one of this design's
reasons: `SETTINGS_INVALID_JSON`, `SETTINGS_NOT_OBJECT`, `SETTINGS_HOOKS_NOT_OBJECT`, `SETTINGS_EVENT_NOT_ARRAY`, `SCOPE_NOT_ALLOWED`,
`LOCKED`, `REAL_SETTINGS_IN_TEST`, `WRITE_VALIDATION_FAILED`, `SETTINGS_CHANGED_CONCURRENTLY`, `RENAME_FAILED`, `POST_CHECK_FAILED`
(`details` also carries `settingsPath`); usage errors are 01's `USAGE` (exit 2). With `action: 'refused'` the envelope has
`ok: false`. Test: T-IN-10 validates every `--json` output of T-IN-01..09 against `schemas/cli-envelope.v1.schema.json`.

### 3.2 Settings file per scope

| Scope | Path | Notes |
|---|---|---|
| `project-local` (default, D8) | `<repoRoot>/.claude/settings.local.json`, `repoRoot` = the directory that contains `.claude/monitor/tasks/<slug>` | Narrowest. Fires only for sessions that load this project's settings, which is the instance's legacy scope (sessions launched in `repoRoot`). If `git -C <repoRoot> check-ignore -q .claude/settings.local.json` does not exit 0, warning `HOOKS_SETTINGS_NOT_IGNORED` (never commit hook config, HK:7) |
| `user` | `${CLAUDE_CONFIG_DIR or ~/.claude}/settings.json` | Every session on the machine; the handler filters by routes. Extra warning `HOOKS_USER_SCOPE` (affects running sessions, HK:3.6) |
| `project` (`.claude/settings.json`) | - | Refused: `SCOPE_NOT_ALLOWED` (shared, committed file) |

### 3.3 Our handler entry and the marker

`buildEntry(event, ctx)` returns, with all paths through `normalizePath`:

```ts
{ type: 'command', command: ctx.nodePath,                       // process.execPath of the installing CLI
  args: ['--no-warnings', ctx.hookEntryPath, '--mcs-hook', event, ...(isAsync ? ['--async'] : [])],
  timeout: event === 'SessionEnd' ? 2 : 5,
  ...(isAsync ? { async: true } : {}) }
// isAsync = ASYNC_HOOK_EVENTS.has(event) && !opts.syncToolEvents ; ASYNC_HOOK_EVENTS = {PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch}
```

`isOurs(h)` = `h` is a plain object AND `h.type === 'command'` AND (`Array.isArray(h.args) && h.args.includes('--mcs-hook')`
OR (`typeof h.command === 'string'` AND `/(^|\s)--mcs-hook(\s|$)/.test(h.command)`)). The marker is a fixed argument no
other tool uses (CCAM's substring match on a file name also matched unrelated scripts, CC:3).
`INSTALLED_HOOK_EVENTS` = the 21 events of section 2.4, in that order.

### 3.4 Plan algorithm (pure: `planHooks(text: string | null, op: 'install' | 'uninstall', desired: Map<event, entry>)`)

```
 1. original = text. If text is null: obj = {}, created = true. Else strip a leading UTF-8 BOM (remember it);
    if text.trim() === '': obj = {}. Else obj = JSON.parse(text); on SyntaxError -> error SETTINGS_INVALID_JSON (no write).
 2. obj must be a plain object, else SETTINGS_NOT_OBJECT.
 3. hadHooks = 'hooks' in obj. hooks = obj.hooks ?? {}; must be a plain object, else SETTINGS_HOOKS_NOT_OBJECT.
 4. For every event key E in hooks (insertion order):
      groups = hooks[E]; if not an array: if E in INSTALLED_HOOK_EVENTS -> error SETTINGS_EVENT_NOT_ARRAY(E); else leave untouched.
      For each group g (index order): if g is a plain object with array g.hooks:
          before = g.hooks.length; g.hooks = g.hooks.filter(h => !isOurs(h))
          if g.hooks.length === 0 and before > 0: mark g for removal
      remove marked groups; if groups.length === 0 and it had groups before this step: delete hooks[E]   (only what we emptied)
 5. If op === 'install': for each E in INSTALLED_HOOK_EVENTS: hooks[E] = (hooks[E] ?? []); hooks[E].push({ hooks: [desired.get(E)] })
    (no matcher: all tools; appended after the user's groups; entries for events no longer in our set were removed in 4).
 6. If Object.keys(hooks).length === 0 and !hadHooks: do not add 'hooks'. Else obj.hooks = hooks (keeps its original key position).
 7. Serialize: indent = indentation of the first indented line of the original (2 spaces default; tab kept), EOL = CRLF if the
    original contains CRLF else LF, trailing newline iff the original had one (default yes), BOM restored if it was present.
 8. Return { obj, text: newText, changed: newText !== original, added, replaced, removed, kept, diff: unifiedDiff(original, newText, 3) },
    computed per event E of the union of events touched: before = our entries of E removed in step 4 (canonical JSON), after = the
    entry added in step 5: added = !before && after; removed = before && !after; replaced = before && after && before !== after;
    kept = before === after (one identical entry).
```

Properties (tests T-IN-01..05): `plan(plan(x).text).changed === false` (idempotent install); `uninstall(install(x))` is
deep-equal to `x` and byte-equal when `x` was produced by `JSON.stringify(v, null, 2) + '\n'`; user handlers, matchers and
unknown keys are preserved in order; two of our old entries with different paths (an old skill location) are both
replaced by one.

### 3.5 Apply (`--yes`): atomic write, validation, backup, concurrency

```
 1. mutex = await acquireMutex(mutexName('settings', path.resolve(settingsPath)), { timeoutMs: 10000 })   (C48; 01 `ProcessMutex`,
    ADR 0005: released by the OS when the holder dies, so there is no stale-lock rule); timeout -> HOOKS_FAILED reason LOCKED (exit 1).
    01's `mutexName` kind union gains `'settings'` (owned by 01).
 2. bytes0, stat0 = read(settingsPath) (ENOENT -> null); h0 = sha256(bytes0)
 3. plan = planHooks(bytes0 as UTF-8, op, desired); error -> exit 1 with that code; !changed -> action "noop", exit 0
 4. Refuse when the target is the REAL user or project-local path and env MCS_TEST === '1' or VITEST is set: REAL_SETTINGS_IN_TEST.
 5. If bytes0 !== null: backup = $MCS_HOME/backups/settings/<sha8(path)>/<UTC YYYYMMDDTHHMMSSZ>-<op>.json  (write + fsync);
    append {path, at, op, sha256: h0, backup} to that folder's index.jsonl; prune to the newest 20 backups per path.
 6. tmp = dirname(settingsPath) + '/.' + basename + '.mcs-' + pid + '-' + random6 + '.tmp'; write plan.text; fsync; close.
 7. Validate tmp: re-read, JSON.parse, deepEqual(parsed, plan.obj); every expected entry present (install) / no isOurs (uninstall).
    Failure -> delete tmp, error WRITE_VALIDATION_FAILED.
 8. Optimistic concurrency: re-read the target; if sha256 differs from h0 -> delete tmp, go back to 2 (at most 3 attempts),
    then error SETTINGS_CHANGED_CONCURRENTLY.
 9. rename(tmp, settingsPath); on EPERM/EBUSY/EACCES retry 10 x 50 ms (Windows sharing violations), else delete tmp, RENAME_FAILED.
10. Post-check: read target, parse, re-run the step 7 assertions; failure -> restore from backup, error POST_CHECK_FAILED.
11. Update the manifest $MCS_HOME/hooks/installs.json (atomic): key settingsPath -> {scope, op, at, events, handlerVersion,
    nodePath, hookEntryPath, async: !syncToolEvents, backup}. Uninstall removes the key.
12. Append an audit entry to the task's audit/changes.md through 01's audit writer with 01 7.2's template (legacy format CS:C.8):
    action `hooks-install` | `hooks-uninstall`, Summary `<scope> settings ~/<path>: <n> added, <m> replaced, <k> removed` (`~/<path>` =
    settings path relative to the home directory when inside it, else the absolute path; counts from step 3's plan), Files changed
    `none` (outside the workspace), Validation `settings re-read and verified`, Outcome `applied; settings backup <path>` (`applied`
    when no backup was needed because the file did not exist).
13. mutex.release() (finally).
```

Never written by anyone else: the installer never runs at server start, from `start`, `init`, `configure`, or tests
against real paths. Hook config reloads live in running sessions (HK:3.6), which the warning text states.

### 3.6 Dry run output (default)

Human form: settings path and scope; then `+ <Event>` / `- <Event>` / `= <Event>` lines; then warnings; then the unified diff
of the `hooks` key only; last line `dry run: nothing was written; re-run with --yes after the user agreed`. The JSON form is
3.1. Exit 0.

### 3.7 Verification without touching real settings or starting Claude Code

`mcs hooks verify` returns `{check, ok, detail}[]` (doctor style). V4 and V6 spawn through 06's `execFileText` with kind `node`
(engine modules may not import `node:child_process`, 01 T-LC-16); V6 needs stdin, which `ChildSpec` lacks (request to 06 3.6,
section 12 X-3). Checks in order:

| # | Check | Pass condition |
|---|---|---|
| V1 | settings file parses | 3.4 steps 1-3 succeed |
| V2 | entries complete | each of the 21 events has exactly one `isOurs` handler; none for other events |
| V3 | paths current | `command` exists; `args[1]` (stub) exists; every entry uses the same `hookEntryPath` as this skill |
| V4 | handler version | `execFileText({kind: 'node', file: command, args: [hookEntryPath, '--version'], timeoutMs: 2000, ...})` prints `HANDLER_VERSION` equal to the runtime version, exit 0, < 2 s |
| V5 | route file | `$MCS_HOME/routes/<instanceId>.json` exists, parses, `transcriptsDirs` contains the instance's resolved dir |
| V6 | synthetic probe | spawn EXACTLY `command args...` of the installed `Notification` entry with stdin = probe payload (below): exit 0, stdout and stderr empty, wall < 1500 ms; then the current spool segment contains a line with the probe `session_id` (scan the last 64 KiB) |
| V7 | server round trip (only if running; else `ok: null`) | `GET /api/v3/ingest/probes/:probeSessionId` (03 route `ingestProbe`, I-37) returns `200 {receivedAt, committedAt}` within 3 s (poll every 100 ms; `404 probe_not_found` = not yet committed); detail = commit latency `committedAt - receivedAt` |

Probe payload: `{"session_id":"00000000-0000-4000-8000-<12 random hex>","transcript_path":"<resolved transcripts dir>/<that id>.jsonl",
"cwd":"<repoRoot>","hook_event_name":"Notification","notification_type":"mcs_probe","message":"mcs probe"}`. The server stores
a probe as a `hook_probe` row only (never a session, never in counts). A real end-to-end check with Claude Code exists only in
the E2E suite (temp `--settings` file + temp `MCS_HOME`, gated by `MCS_E2E_CLAUDE=1`).

### 3.8 Consent rules (normative, mirrored in SKILL.md by the skill designer)

1. Install and uninstall are dry runs unless `--yes` is passed. 2. An agent passes `--yes` only after showing the dry-run
output to the user and receiving explicit agreement in the conversation for that scope. 3. `--scope user` requires that
the agreement names the user scope. 4. Nothing installs hooks implicitly (no server start, no other command). 5. Tests use
temp `MCS_HOME` and `--settings-file` in temp dirs; step 4 of 3.5 refuses real paths under test. 6. Uninstall is offered in
`mcs hooks status` output whenever an install exists.

### 3.9 Tests that prove it (installer)

| Id | Guarantee | Test |
|---|---|---|
| T-IN-01 | Merge matrix | `planHooks` on: missing file, empty file, whitespace, `{}`, settings with unrelated keys, with user hooks on the same events (with and without matchers), with our old entries (other path), CRLF + 4-space indent + BOM, invalid JSON, `hooks: []`, `hooks.Stop: {}` -> expected text/errors (golden files) |
| T-IN-02 | Idempotent | install twice -> second plan `changed: false` |
| T-IN-03 | Clean uninstall | for every fixture of T-IN-01 that is valid: `uninstall(install(x))` deep-equals `x` |
| T-IN-04 | Ownership | entries without the marker are never removed, including a user script named `hook.js` |
| T-IN-05 | Atomic apply | fault injection (`engine/src/hooks/installer/settings-io.ts` seams): crash after tmp write leaves the original intact; concurrent modification between read and rename -> retried, then `SETTINGS_CHANGED_CONCURRENTLY`; rename EPERM x3 then success |
| T-IN-06 | Backup | apply writes a backup equal to the original bytes; prune keeps 20 |
| T-IN-07 | Test guard | `MCS_TEST=1` + real user path + `--yes` -> `REAL_SETTINGS_IN_TEST`, file untouched (path computed from a temp `CLAUDE_CONFIG_DIR`, asserted equal to the guarded path) |
| T-IN-08 | Verify | in a temp env: V1-V6 ok after install; V3 fails after moving the stub; V6 fails with a handler that prints; V7 with an in-process test server on `allocatePort(VITEST_PORTS)` |
| T-IN-09 | Dry run writes nothing | without `--yes`: settings, manifest, backups, audit unchanged (hash before/after) |
| T-IN-10 | CLI contract | every `--json` output of T-IN-01..09 is one `mcs.cli/1` envelope (schema-validated) with the 3.1 `data` shape; failures carry `HOOKS_FAILED` + `details.reason`; the audit entry text equals 01 7.2's `hooks-install` template for a fixture plan (2 added, 1 replaced, 0 removed); two concurrent `--yes` runs on one settings file serialize through the mutex (second waits, both succeed, final file valid) |

## 4. Ingestion pipeline

### 4.1 Logical entities, invariants, and the write each one needs

Every entity is scoped by `instance_id` (D2, defence in depth: one DB per instance whose `meta.instance_id` is checked at open,
and every repository call takes `RepoContext { instanceId }`, 03 4.5); `sessionId` is the provider UUID; ids from the provider are
kept verbatim. "Upsert-max" = insert or update each listed column to `max(old, new)`; "LWW(stamp)" = keep the value with the
greater `Stamp` (4.5). The data-model design owns names, DDL, indexes and statements (03 3.5-3.6); the right-hand column names the
03 table. Hook envelopes and transcript entries are ONE entity, `event`, stored in 03's single `events` table (I-03): a hook
delivery and a transcript record that describe the same logical event share a natural key and become one row (`sources` 3).

| Entity | Natural key | Main fields | Invariants | Write operation |
|---|---|---|---|---|
| `event` (03 `events`) | one of: `event_uid` (hook rows), `natural_key` (4.1.1), `record_uuid` (= `entry_key`: record `uuid`, else `f<file_id>:<byte_offset>`); at least one is set, each UNIQUE | `session_id`, `agent_id`, `kind` (stored kind, 4.1.2), `entry_kind` (`prompt`, `say`, `think`, `tool`, `result`, `system`, `attachment`; transcript rows), `severity` (4.1.2), `sources` (bits: hook 1, transcript 2, monitor 4), `ts` + `ts_rank` + `ts_tie` (= `Stamp`, 4.3), `ts_source` (`hook_received` for hook rows, `record` for transcript rows, `derived` for monitor rows), `received_at`, hook columns (`hook_event` = envelope `event`, `content_hash`, `spool_segment`, `spool_offset`, `flags`, `detail` = sanitized envelope `data`, <= 16 KiB), transcript columns (`file_id`, `byte_offset`, `byte_length`, `line_no`, `record_type`, `subtype`, `message_id`, `text_len`, `summary` <= 160 cp redacted), shared ids (`prompt_id`, `tool_use_id`, `tool_name`) | never holds dropped fields (2.4) or a body (5.7); a D-2/D-3 hook duplicate (4.4) is NOT inserted (counter only) | `EventsRepo` insert of 03 3.6: `ON CONFLICT(event_uid)` and `ON CONFLICT(record_uuid)` do nothing; `ON CONFLICT(natural_key)` merges (`sources` OR, `tool.failure` wins, `severity` max, first non-null ids and transcript reference, record timestamp preferred); a `record_uuid` conflict from another file inserts an `entry_occurrence` instead |
| `session` | (`instance_id`, `session_id`) | `project_dir`, `transcript_file_id`, `label`, `matched`, `rule_index`, `pinned`, `title_ai`, `title_custom`, `entrypoint`, `version`, `git_branch`, `cwd_latest`, `first_seen_at`, `last_activity_at`, `claude_pid`, `continued_in`, `copied_from`, `hook_coverage`, `facts_json`, lifecycle view columns (7.1), `next_check_at` | `session_id` matches `SID_RE`; one row per id; `last_activity_at` only from activity facts (bookkeeping never) | upsert; facts merged with `mergeFacts` (7.2); view replaced when `derive` changes it |
| `agent` | (`instance_id`, `session_id`, `agent_id`) | `kind` (`main`, `subagent`, `workflow_agent`, `teammate`, `internal`; the `main` row per session is created by `SessionsRepo.ensure`, `teammate` is reserved; C56), `agent_type`, `label`, `model`, `request_shape`, `spawn_tool_use_id`, `workflow_run_id`, `transcript_file_id`, `facts_json`, lifecycle view, `next_check_at` | `agent_id` matches `AGENT_RE`; parent session exists (FK) | upsert + facts merge |
| `workflow_run` | (`instance_id`, `session_id`, `run_id`) | `name`, `launch_tool_use_id`, `status_file`, `agent_count`, `started_count`, `result_count`, `failed_count`, `facts_json`, lifecycle view | `run_id` matches `^wf_[A-Za-z0-9_-]{1,64}$` | upsert + facts merge |
| `turn` | (`instance_id`, `session_id`, `prompt_id`) | `started_at`, `ended_at`, `end_kind` (`stop`, `stop_failure`, `end_turn`, `interrupted`, null), `origin`, `tool_count` | `started_at <= ended_at` when both set | upsert: `started_at` = min, `ended_at` = max, `end_kind` LWW(stamp) |
| `tool_call` | (`instance_id`, `tool_use_id`) | `session_id`, `agent_id`, `prompt_id`, `name`, `summary` (<= 160 cp, redacted), `input_hash`, `started_at`, `ended_at` (only from PostToolUse/Failure, PermissionDenied, transcript `tool_result`), `batch_at` (PostToolBatch listing the call), `outcome` (`ok`, `error`, `denied`, `interrupted`, null), `exit_code`, `duration_ms`, `sources` (bit set: `hook_pre`=1, `hook_post`=2, `transcript_use`=4, `transcript_result`=8, `hook_batch`=16) | one row per call whatever the number of deliveries; open = `ended_at` and `batch_at` both null | upsert: `started_at` = min, `ended_at` = max, `batch_at` = max, `sources` = bitwise or, `outcome` by precedence `error > denied > interrupted > ok`, other columns first non-null. Display-only outcomes (never stored): `closed_by_batch` (no end, `batch_at` set: a denied call, HK:5) and `closed_by_turn_end` (no end, its turn ended) |
| `transcript_file` | (`instance_id`, `file_id`) | `path`, `kind` (`session`, `subagent`, `workflow_agent`, `workflow_journal`, `workflow_status`), `session_id`, `agent_id`, `run_id`, identity (`ino` text, `head_len`, `head_hash`), cursors (`head_end`, `tail_start`, `tail_offset`, `backfill_offset`), `line_count`, `size_seen`, `mtime_seen`, `birth_ms`, `first_seen_mtime_ms` (owner rule 6.2), `state` (`active`, `missing`, `unreadable`, `untracked`), counters (5.9), `classified_lines`, `label_cache`, legacy parity inputs (`first_ts_in_order`, `max_ts_string`, `last_stop_legacy`) | `0 <= head_end <= backfill_offset <= tail_start <= tail_offset <= size_seen` (5.5) | update in the same transaction as the rows derived from the bytes the cursor passed |
| `entry_occurrence` (03 `entry_occurrences`) | (`file_id`, `byte_offset`) | `record_uuid` | second and later occurrences of a record uuid (resume copies) | insert or ignore |
| `message_usage_file` | (`instance_id`, `file_id`, `message_key`) | `model`, `input`, `output`, `cache_read`, `cache_creation`, `cc_5m`, `cc_1h`, `thinking`, `web_search`, `web_fetch` (each nullable = missing), `legacy_in`, `legacy_out`, `legacy_cr`, `legacy_cc` (top-level integers only, missing = 0; 6.5), `finalized`, `usage_source` (`top`, `iterations`), `synthetic`, `first_ts`, `last_ts`, `record_count`, `invalid_values` | numbers are safe non-negative integers | upsert-max per numeric column; `finalized` = or; `usage_source` = `iterations` if any record used it; `record_count` += 1 |
| `spool_cursor` | (`instance_id`, `segment`) | `offset`, `size_seen`, `ino`, `head_hash`, `lines`, `partial_bytes`, `sealed`, `errors` | offset at a line start | same transaction as the segment's rows |
| `ingest_error` | (`instance_id`, `id`) | `at`, `source` (`spool`, `transcript`, `external`, `writer`, `handler`), `code` (4.8), `file_id`/`segment`, `byte_offset`, `detail` (<= 200 chars, no content) | capped: keep newest 1000 per instance; counters per code are kept separately | insert |
| `reconciliation` | (`instance_id`, `id`) | `session_id`, `kind` (8.1), `at`, `detail_json` (ids and numbers only) | append-only | insert (dedupe by (`session_id`, `kind`, `detail_hash`)) |
| `external_observation` | (`instance_id`, `session_id`, `source`) | `source` (`registry`, `job`, `pid`, `attempt`), `observed_at`, `value_json` | latest only | LWW(`observed_at`) |
| `cost_state` | (`instance_id`, `file_id`) | `total_cost_usd`, `model_usage_json` (numbers only), `byte_offset`, `is_trailing` | supplementary, never summed into tokens | LWW(byte_offset) |
| `hook_probe` | (`instance_id`, `probe_session_id`) | `received_at`, `committed_at` | never a session | insert or ignore |
| `ingest_health` | (`instance_id`) | section 8.2 fields | one row | update by the writer and the health task |

Access patterns needed (covered by 03 3.5/3.7 indexes): events by session and time (`idx_events_session_ts`); hook content window
D-3 (`idx_events_content` on `session_id, hook_event, content_hash, received_at`); natural-key and uuid lookups (`ux_events_*`);
`session/agent/workflow_run (next_check_at)`; open tool calls per session (`idx_tool_calls_open`); `usage_files (message_key)`;
`turns (session_id, started_at)`; transcript references by `(file_id, byte_offset)` (`entry_occurrences` primary key and the
`events` columns).

#### 4.1.1 Natural keys of `event` rows (adopted verbatim from 03 3.6)

A hook delivery and a transcript record merge only where the provider gives a common id:

| Logical event | Hook | Transcript | `natural_key` | stored `kind` |
|---|---|---|---|---|
| tool call started | PreToolUse | assistant `tool_use` block | `tool.call:<tool_use_id>` | `tool.call` |
| tool call ended | PostToolUse, PostToolUseFailure | user `tool_result` block | `tool.end:<tool_use_id>` | `tool.result`; `tool.failure` wins on merge (and `severity 2`) |
| prompt | UserPromptSubmit | user prompt record (`promptId`) | `prompt:<session_uid>:<prompt_id>` | `prompt.submit` |
| permission denied | PermissionDenied | - | `permission.denied:<tool_use_id>` | `permission.denied` |
| tool batch | PostToolBatch | - | `tool.batch:<session_uid>:<ids_hash>` | `tool.batch` |
| task created / completed | TaskCreated / TaskCompleted | - | `task.<created\|completed>:<session_uid>:<task_id>` | `task.created` / `task.completed` |
| any other hook event | envelope | - | NULL (dedupe by `event_uid` and the D-3 content window, 4.4) | 4.3 table |
| any other stored transcript record | - | record | NULL (dedupe by `record_uuid`) | 5.6 table |

`natural_key` is set only when its id is non-null (a prompt record without `promptId`, or a hook without `prompt_id`, gets NULL)
and only for the stored kinds of the table (a task-notification user record is `agent.notification` with no `prompt:` key).

#### 4.1.2 Stored `kind` and `severity` (normative; values are 03's `EVENT_KINDS`, `shared/src/api/entities.ts`)

The stored `kind` of every row is fixed by the "stored `kind`" columns of 4.3 (envelopes) and 5.6 (records); monitor rows written by
03's `ReconciliationsRepo` are `monitor.gap` (`runtime_unavailable`, `hook_gap`) and `monitor.reconcile` (the other reconciliation
kinds). A record or envelope whose mapping says "no row" produces no `events` row (it may still produce logical events). Severity:
`2` for `tool.failure`, `turn.failure`, `api.error`, `hook.handler_error`; `1` for `permission.denied`, `turn.interrupt`,
`hook.unknown`, `monitor.gap`, `monitor.reconcile`; `0` otherwise. The mapping functions are
`eventKindOfEnvelope(env: HookEnvelopeV1): EventKind | null` (`ingest/hooks/normalize-envelope.ts`) and
`eventKindOfRecord(rec: TranscriptRecordShape, block: ContentBlockRef | null, file: TrackedFile): EventKind | null`
(`ingest/transcripts/normalize-record.ts`); both return values typed by `EventKind`, so a kind outside `EVENT_KINDS` is a compile
error. Tests: `normalize-envelope.test.ts` (one row per 4.3 row, 21 events + unknown + probe) and `normalize-record.test.ts` (one row
per 5.6 row) assert the stored kind, severity and natural key; T-PL-01 asserts the same through the DB.

```ts
// ingest/event-row.ts: the input of 03 EventsRepo.insert (parameter names of the 03 3.6 statement)
export interface EventRowWrite {
  sessionUid: string; agentUid: string | null;                 // repository resolves row ids (main agent = 'main')
  kind: EventKind; entryKind: 'prompt' | 'say' | 'think' | 'tool' | 'result' | 'system' | 'attachment' | null;
  severity: 0 | 1 | 2; sources: 1 | 2 | 4; stamp: Stamp; tsSource: 'record' | 'hook_received' | 'derived'; receivedAt: number;
  eventUid: string | null; naturalKey: string | null; recordUuid: string | null;
  hookEvent: string | null; contentHash: string | null; spoolSegment: string | null; spoolOffset: number | null; flags: string[];
  promptId: string | null; toolUseId: string | null; toolName: string | null; messageId: string | null;
  fileId: number | null; byteOffset: number | null; byteLength: number | null; lineNo: number | null;
  recordType: string | null; subtype: string | null; textLen: number | null; summary: string | null;
  detail: Record<string, string | number | boolean | null> | null;   // hook rows: sanitized envelope data; monitor rows: reconciliation detail
}
```

### 4.2 Validation at the boundary (zod, `shared/src/schemas/ingest.ts`)

| Boundary | Schema | Cost (E8) | On failure |
|---|---|---|---|
| Spool line | `HookEnvelopeV1Schema` (strict object: unknown top-level keys rejected; `data` = record of string to scalar or array of small objects, <= 64 keys) | 2.0 us | `ingest_error ENVELOPE_SCHEMA` (+ zod issue path, no values); line skipped |
| Route file (server and CLI reading back) | `HookRouteV1Schema` | - | ignore file, `ROUTE_INVALID` |
| Transcript record | `TranscriptRecordShape` (loose object: `type` string required; optional `uuid`, `parentUuid` (string or null), `timestamp`, `sessionId`, `agentId`, `isSidechain`, `isMeta`, `promptId`, `subtype`, `message` (loose: `id`, `model`, `role`, `stop_reason`, `usage` (loose), `content` string or array of loose `{type}`), `toolUseResult` (unknown), `attachment` (loose `{type}`), `origin` (loose `{kind}`), `toolDenialKind`, `toolEndsTurn`, `isApiErrorMessage`, `isAbortedMidStream`, `isCompactSummary`, `compactMetadata` (loose)) | 0.46 us | `ingest_error RECORD_SHAPE`; counted as invalid line |
| Nudge endpoint (2.8) | `NudgeBodySchema` `{instanceId: uuid}` (strict) | - | `400 validation_failed` (03 5.2 `ErrorCode`) |

Numbers taken from records are re-checked with `Number.isSafeInteger(v) && v >= 0` at use (usage, durations, counts).

### 4.3 Normalization into logical events

```ts
export interface Stamp { at: number; rank: number; tie: string }   // total order: at, then rank, then tie (string compare)
export type LogicalEvent =
  | { k: 'session.seen'; sessionId: string; stamp: Stamp; cwd?: string; transcriptPath?: string; entrypoint?: string; version?: string; gitBranch?: string; claudePid?: number }
  | { k: 'session.start'; sessionId: string; stamp: Stamp; startSource: string; model?: string }
  | { k: 'session.end'; sessionId: string; stamp: Stamp; reason: string }
  | { k: 'turn.prompt'; sessionId: string; agentId: string | null; promptId: string | null; stamp: Stamp; origin: string; promptLen?: number }
  | { k: 'turn.end'; sessionId: string; agentId: string | null; promptId: string | null; stamp: Stamp; kind: 'stop' | 'stop_failure' | 'end_turn' | 'turn_duration'; error?: string; backgroundTasks?: number; pendingBackgroundAgents?: number; pendingWorkflows?: number }
  | { k: 'tool.start'; sessionId: string; agentId: string | null; promptId: string | null; toolUseId: string; name: string; stamp: Stamp; summary?: string; inputHash?: string }
  | { k: 'tool.end'; sessionId: string; agentId: string | null; toolUseId: string; stamp: Stamp; outcome: ToolOutcome; durationMs?: number; exitCode?: number }
  | { k: 'tool.batch'; sessionId: string; promptId: string | null; toolUseIds: string[]; stamp: Stamp }
  | { k: 'permission.request'; sessionId: string; promptId: string | null; toolName: string; inputHash: string; stamp: Stamp }
  | { k: 'notification'; sessionId: string; type: string; stamp: Stamp }
  | { k: 'agent.start'; sessionId: string; agentId: string; agentType: string; stamp: Stamp }
  | { k: 'agent.stop'; sessionId: string; agentId: string; agentType: string; stamp: Stamp; transcriptPath?: string }
  | { k: 'agent.link'; sessionId: string; agentId: string; toolUseId: string; status: string | null; stamp: Stamp }
  | { k: 'agent.final'; sessionId: string; agentId: string; stamp: Stamp; via: 'tool_ends_turn' | 'structured_output' }
  | { k: 'agent.notification'; sessionId: string; toolUseId: string | null; taskId: string | null; status: 'completed' | 'failed' | 'killed' | 'stopped' | null; stamp: Stamp }
  | { k: 'agent.meta'; sessionId: string; agentId: string; agentType?: string; description?: string; model?: string; requestShape?: string; spawnToolUseId?: string; workflowRunId?: string; workflowPhase?: string }
  | { k: 'workflow.launch'; sessionId: string; runId: string; toolUseId: string; name?: string; stamp: Stamp }
  | { k: 'workflow.status'; sessionId: string; runId: string; observedAt: number; fileStatus: string | null; agentCount?: number; started: number; results: number; failed: number }
  | { k: 'activity'; sessionId: string; agentId: string | null; stamp: Stamp; via: 'hook' | 'assistant' | 'user' | 'tool_result' | 'system' }
  | { k: 'interrupt'; sessionId: string; agentId: string | null; stamp: Stamp; via: 'user_marker' | 'aborted_mid_stream' }
  | { k: 'api_error'; sessionId: string; agentId: string | null; stamp: Stamp; status?: number; error?: string }
  | { k: 'assistant.ok'; sessionId: string; agentId: string | null; stamp: Stamp }
  | { k: 'compaction'; sessionId: string; stamp: Stamp; trigger: string; preTokens?: number; postTokens?: number }
  | { k: 'title'; sessionId: string; source: 'ai' | 'custom' | 'agent_name'; value: string; order: number }
  | { k: 'session.continued_in'; sessionId: string; target: string }
  | { k: 'session.copied_from'; sessionId: string; source: string; count: number }
  | { k: 'cost_state'; sessionId: string; fileId: number; byteOffset: number; totalCostUsd: number | null; modelUsage: Record<string, Record<string, number>> }
  | { k: 'hook.handler_error'; sessionId: string; hookEvent: string; exitCode: number | null; stamp: Stamp }
  | { k: 'external.registry'; sessionId: string; status: 'busy' | 'idle' | 'waiting'; waitingFor?: string; pid: number; pidAlive: boolean; observedAt: number }
  | { k: 'external.job'; sessionId: string; jobId: string; state: string; observedAt: number }
  | { k: 'external.attempt'; sessionId: string; state: 'COMPLETED' | 'FAILED' | 'UNKNOWN'; evidence: string; rowKey: string; endedAt: number; observedAt: number }
  | { k: 'external.attempt_cleared'; sessionId: string; observedAt: number }
  | { k: 'external.pid'; sessionId: string; pid: number; alive: boolean; checkedAt: number }
  | { k: 'info'; sessionId: string; stamp: Stamp; what: 'task_created' | 'task_completed' | 'teammate_idle' | 'model_switch' | 'cwd_changed' | 'queued_command' | 'away_summary' | 'local_command'; detail?: Record<string, string | number> };
export type ToolOutcome = 'ok' | 'error' | 'denied' | 'interrupted';   // stored; 'closed_by_batch' / 'closed_by_turn_end' are display-only (4.1)
```

Attempts evidence events (producer: 06 3.10.7 `PanelService.tickAttempts`, driven by 01 4.4a's 2 s clock timer, not by this
design's scheduler; N-01, C57; I-18). 06 first commits its `AttemptsRepo` writes in its own `withWriteTx`, then, after that COMMIT,
calls `writer.submit({source: 'external', items: [{kind: 'external', events, rows: []}], bytes: 0})`; the events commit in a later
writer transaction (two transactions, never one). `submit` returning false means: keep the events and resubmit on `onDrain`. The
`attempt` register is idempotent under resubmission (same stamp and `rowKey` -> no change, no publication), so 06 may resubmit
freely; recovering a publication lost between its two commits is 06's (3.10.7).
- `external.attempt`: `endedAt` = the attempt row's `ended_at` (the evidence time shown, `LifecycleEvidence.at`); `observedAt` = the
  `now` of the tick that published it (the register stamp, 7.3). Publication time, not `ended_at`, orders the register, because a
  config rebuild republishes OLD rows after a clear and they must win over the clear.
- `external.attempt_cleared`: emitted for every session that had attempts evidence when a chain-log config rebuild deleted the rows
  (06 3.10.3 step 3), with `observedAt` = the tick's `now`, BEFORE that tick republishes any row. It retracts the evidence: the
  `attempt` register takes the value `null` (7.3) and rule S-1 no longer applies until a new `external.attempt` arrives.
- Within one tick, `observedAt` is the same value for the clear and the republished rows; the stamp rank breaks the tie
  (`attempt_cleared` rank 0 < `attempt` rank 1), so a republish in the same tick wins. 06 3.10.7 sets `observedAt` = `publishAt` (tick
  `now`) and adds `endedAt: row.ended_at` (I-18, C41).

Hook envelope mapping (`normalizeEnvelope`, stamp = `{at: received_at, rank: HOOK_EVENT_RANK[event], tie: event_uid}`):

| Event | Logical events (besides `session.seen` with `claudePid`, emitted for every envelope) | Stored `kind` (`events` row, 4.1.2) |
|---|---|---|
| SessionStart | `session.start` | `session.start` |
| UserPromptSubmit | `turn.prompt` (origin `hook`), `activity` | `prompt.submit` (natural key `prompt:` when `prompt_id`) |
| PreToolUse | `tool.start`, `activity` | `tool.call` (natural key `tool.call:`) |
| PermissionRequest | `permission.request` | `permission.request` |
| PermissionDenied | `tool.end(denied)` | `permission.denied` (natural key `permission.denied:`) |
| PostToolUse | `tool.end(ok)`, `activity`; Agent with `agent_link_id`: `agent.link`; Workflow with `run_id`: `workflow.launch` | `tool.result` (natural key `tool.end:`) |
| PostToolUseFailure | `tool.end(is_interrupt ? interrupted : error)` with `exitCode`, `activity` | `tool.failure` (natural key `tool.end:`) |
| PostToolBatch | `tool.batch`, `activity` | `tool.batch` (natural key `tool.batch:`) |
| Notification | `notification` | `notification.sent` |
| SubagentStart / SubagentStop | `agent.start` / `agent.stop` (agent with empty `agent_type` and no file -> kind `internal`, hidden), `activity` (agentId) | `agent.start` / `agent.stop` |
| Stop / StopFailure | `turn.end(stop / stop_failure)` | `turn.stop` / `turn.failure` |
| SessionEnd | `session.end` | `session.end` |
| PreCompact / PostCompact | `compaction` (PostCompact only), `activity` | `context.compact` (both) |
| TaskCreated, TaskCompleted | `info` | `task.created`, `task.completed` (natural key `task.`) |
| TeammateIdle | `info` | `teammate.idle` |
| PostModelSwitch | `info` | `model.switch` |
| CwdChanged | `info` | `cwd.change` |
| any other event name (not installed) | `session.seen` only | `hook.unknown` |
| probe | `hook_probe` row only, no logical events | no row |

`HOOK_EVENT_RANK`: SessionStart 0, UserPromptSubmit 10, PreToolUse 20, PermissionRequest 22, PermissionDenied 24, PostToolUse 30,
PostToolUseFailure 30, PostToolBatch 34, SubagentStart 40, SubagentStop 44, TaskCreated 46, TaskCompleted 47, Notification 50,
PreCompact 52, PostCompact 53, PostModelSwitch 54, CwdChanged 55, TeammateIdle 56, Stop 60, StopFailure 60, SessionEnd 90,
unknown 70. Transcript ranks: user prompt 10, assistant 20, tool_result 30, attachment 50, compact_boundary 52, system other 58,
turn_duration 61. The transcript mapping is section 5.6.

### 4.4 Dedupe rules (`engine/src/ingest/dedupe.ts`)

| Layer | Key | Catches | Mechanism |
|---|---|---|---|
| D-1 envelope | `events.event_uid` (UNIQUE; one DB per instance) | spool re-drain after a crash, `mcs ingest replay` | `ON CONFLICT(event_uid) DO NOTHING` (E8: 0 rows from 20,000 replays) |
| D-2 exact natural key | `events.natural_key` of 4.1.1: `tool.call:<tool_use_id>`, `tool.end:<tool_use_id>`, `permission.denied:<tool_use_id>`, `tool.batch:<session_uid>:<ids_hash>`, `task.<created\|completed>:<session_uid>:<task_id>`, `prompt:<session_uid>:<prompt_id>` | the same hook registered twice (plugin or skill copy, HK:6.6) | the natural keys of 4.1.1; before the insert the writer reads `EventsRepo.findByNaturalKey(ctx, key) -> { id, sources } \| null`: an existing row with the hook bit (`sources & 1`) plus an incoming hook row = duplicate, counted in `ingest_health` counters `duplicates`, nothing written; an existing transcript-only row = cross-source merge (written) |
| D-3 content window | (`session_id`, `event`, `content_hash`) with `abs(received_at - existing.received_at) <= 2000` | duplicate registration of events without ids (identical stdin bytes in two handler processes) | indexed range lookup; same handling as D-2 |
| D-4 transcript entry | `events.record_uuid` = record `uuid`; id-less records `f<file_id>:<offset>` | resumed copies, re-reads after a cursor reset | `ON CONFLICT(record_uuid) DO NOTHING`; a conflict from another file -> `entry_occurrences` row |
| D-5 usage | `message_key` per file, then global by `message_key` (6.2) | one message in N records, resumed copies | upsert-max |
| D-6 entities | `tool_use_id`, (`session_id`, `prompt_id`), (`session_id`, `agent_id`), (`session_id`, `run_id`) | the same fact from hooks AND transcripts | upsert merge (4.1) |
| D-7 facts | semilattice merge (7.2) | anything that slipped through D-1..D-6 | merge is idempotent by construction |
| D-8 task notification | (`session_id`, `tool_use_id` or `task_id`, `status`) | the same notification read twice | key in facts set |

D-3 cannot distinguish two legitimate identical events within 2 s (for example two `idle_prompt` notifications with the same
text); the window is far shorter than their real cadence (about 60 s, HK:1). D-2/D-3 assume identical stdin bytes for
duplicate registrations (UNVERIFIED, plan in section 12); if bytes differ, a duplicate hook `events` row remains but D-6/D-7
keep entities and lifecycle correct.

### 4.5 Ordering and out-of-order input

- Hooks: `received_at` (handler clock, same machine as Claude Code) is the order key; sync hooks are serialized by Claude Code,
  async tool hooks can invert by tens of ms (E1 jitter), handled because tool facts are keyed by `tool_use_id` and turns by
  `prompt_id` (7.3).
- Transcripts: record `timestamp` is not monotonic in file order (TS:5: 4,456 records earlier than a predecessor, up to 494,000 s
  in resumed copies). Sequence within a file = byte offset; "last activity" = max(timestamp) over activity records.
- Cross-source comparisons use `lifecycle.crossSourceToleranceMs` (default 2000).
- The lifecycle never depends on arrival order: facts are a join-semilattice (7.2) and `derive` is a pure function of facts
  and `now`. A late event is merged like any other; property tests P2-P4 (7.12) prove order independence and terminal
  non-regression. Display order of events is (`stamp.at`, `stamp.rank`, `stamp.tie`).

### 4.6 IngestWriter and transaction boundaries (persist-before-publish)

```ts
export interface IngestItem { kind: 'envelope' | 'record' | 'external' | 'derive'; events: LogicalEvent[]; rows: RowWrite[] }
export type CursorUpdate = { kind: 'spool'; segment: string; cursor: SpoolCursor } | { kind: 'transcript'; fileId: number; cursor: FileCursor }
export interface IngestBatch { source: 'spool' | 'transcript' | 'external' | 'sweeper'; items: IngestItem[]; cursor?: CursorUpdate; bytes: number }
export interface IngestWriter {
  submit(batch: IngestBatch): boolean;     // false = queue full: caller stops reading and retries after onDrain
  onDrain(cb: () => void): void;
  flushNow(): Promise<void>;               // tests, shutdown
  readonly stats: { queued: number; queuedBytes: number; lastCommitAt: number | null; failures: number };
}
export interface ChangeSink {              // 03 9.1 createChangeSink(tx): implemented by the data/realtime design on top of ChangeRecorder
  record(entity: 'session' | 'agent' | 'workflow_run' | 'tool_call' | 'turn' | 'event' | 'usage' | 'ingest_health' | 'reconciliation',
         key: string, op: 'insert' | 'update' | 'delete'): void;   // INSIDE the transaction: maps to ChangeRecorder.reserve() (03 9.1 table;
                                           // 'event' replaces the former 'hook_event' | 'transcript_entry' and maps to event/append)
  flush(): void;                           // no-op (03 9.1): publication happens in onCommitted
  discard(): void;                         // no-op (03 9.1): a ROLLBACK removes the reserved change rows
}
```

Transaction (I-16): exactly ONE `withWriteTx(db, ctx, (tx) => { ... })` call per writer tick (03 4.5, the only transaction entry
point, lint-enforced; `fn` is synchronous, no `await` inside). Inside it `sink = createChangeSink(tx)` and the repositories of 03 4.5
do every write; no code of this design calls `driver.transaction` or `BEGIN` directly.
1. Before the call: take items from the queue until 500 items OR 8 ms of work OR the queue is empty (E8: 500 rows per transaction =
   304k rows/s). Facts of the touched entities are loaded from `facts_json` into a working copy (the LRU cache of 2,000 entities is
   read, never mutated here).
2. For each item: apply D-1..D-3 for envelopes (4.4), write `rows` through the repositories (03 3.6 statements: `EventsRepo`,
   `ToolCallsRepo`, `TurnsRepo`, `UsageRepo`, ...), merge `events` into the working copy of facts of each touched
   session/agent/workflow.
3. Apply the cursor update(s) carried by the batches (`SpoolCursorsRepo`, `TranscriptFilesRepo.updateCursors`).
4. For every touched session/agent/workflow: `view = derive(facts, now)`; persist `facts_json`; if `viewChanged(old, view)`
   (7.1) persist the view columns and `next_check_at` (`SessionsRepo.writeView`, which reserves `session/upsert` itself, 03 3.6);
   other visible changes call `sink.record(...)` (-> `reserve()`).
5. Update `ingest_health` counters; `sink.record('ingest_health', ...)` at most once per second.
6. `withWriteTx` runs `ChangeRecorder.flush()` and COMMIT, then calls its `onCommitted(headSeq)` listeners: the stream hub publishes
   (03 9.2) and the writer's own listener swaps the working copies into the facts LRU. `ChangeSink.flush()` and `discard()` are
   no-ops; there is no publication path in this design.
7. On a throw: `withWriteTx` rolls back and publishes nothing; the working copies are dropped (the LRU still holds the committed
   facts); keep the batch, retry with backoff 100 ms, 200 ms, 400 ms ... max 5 s. After 3 failures of the same batch: split it in
   halves recursively; a single item that still fails is recorded as `ingest_error PERSIST_FAILED` (reference only, in its own
   `withWriteTx`) and dropped while its cursor advances, so the pipeline never wedges. `DbError` `db_full` / `ENOSPC` sets
   `persisted.status = "db_error"` and pauses ingestion (retry every 30 s).
No file I/O happens inside the transaction (reads happen before `submit`).

### 4.7 Backpressure

- The queue is bounded: `ingest.queueMaxItems` 5,000 and `ingest.queueMaxBytes` 32 MiB. `submit` returns false when full; the
  producer (drainer, tailer) stops reading and resumes on `onDrain`. Nothing is lost: spool segments and transcripts are the
  buffers; the backlog is visible as `bytesBehind` (8.2).
- Nudges are coalesced (2.7). The importer schedules by priority (5.4). The sweeper submits at most 200 derives per tick.

### 4.8 Malformed input (never crash) - error codes

These are `ingest_errors.code` values (uppercase, 03 `ingest_errors` CHECK); they are distinct from the HTTP `ErrorCode` union
(lowercase, 03 5.2, used by 2.8) and from the CLI error codes (01 6.2, used by 3.1).

| Code | Source | Meaning | Handling |
|---|---|---|---|
| `SPOOL_LINE_INVALID_JSON` | spool | line is not JSON | count, `ingest_error`, skip |
| `ENVELOPE_SCHEMA` | spool | zod failure | count, skip |
| `ENVELOPE_VERSION` | spool | `v` > 1 | count, skip, health warning "newer handler" |
| `INSTANCE_MISMATCH` | spool | `instance_id` is another instance | count, skip |
| `SPOOL_TORN_TAIL` | spool | unterminated bytes at seal time | count once, seal |
| `INVALID_SESSION_ID` | any | id fails `SID_RE` | skip the item |
| `RECORD_INVALID_JSON` / `RECORD_NOT_OBJECT` / `RECORD_SHAPE` | transcript | line problems | counters per file, skip line |
| `LINE_TOO_LONG` | transcript/spool | line > `MAX_LINE_BYTES` (64 MiB, `shared/src/protocol/limits.ts`) | skip to next LF, count |
| `UTF8_INVALID` | transcript | line not valid UTF-8 | decode with replacement, still parsed, count |
| `READ_FAILED` | transcript | EACCES/EBUSY/EIO | file `state = unreadable`, retry next cycle, count |
| `SYMLINK_SKIPPED` | discovery | entry is a symlink | not tracked |
| `PATH_OUTSIDE_ROOT` | discovery/hint | resolved path outside the transcripts dir | ignored |
| `IDENTITY_RESET` | tail | truncation or replacement | reconciliation `identity_reset`, re-read from 0 |
| `PERSIST_FAILED` | writer | item failed alone after retries | dropped, cursor advanced |
| `EXTERNAL_READ_FAILED` | external | registry/job file unreadable | ignore that observation |

### 4.9 Tests that prove it (pipeline)

| Id | Guarantee | Test |
|---|---|---|
| T-PL-01 | Hook payload to DB | integration: spool fixture with all 21 events -> rows in `events` (stored `kind`, `severity`, `natural_key` per 4.1.1-4.1.2 and 4.3), `sessions`, `turns`, `tool_calls`, `agents` as expected (golden JSON of a DB dump with ids masked); then the matching transcript fixture: tool, prompt and tool-end rows merge (`sources` 3), no second row |
| T-PL-02 | Idempotent drain | drain the same segment twice; crash injected after the transaction body before COMMIT then restart: identical DB dump, `duplicates` counter = replayed lines |
| T-PL-03 | Replay | `mcs ingest replay` over 3 segments: no new rows |
| T-PL-04 | Duplicate registration | two envelopes, same stdin hash, 30 ms apart, different `event_uid`: one `events` row; 3 s apart: two; tool events with the same `tool_use_id` any distance: one |
| T-PL-05 | Persist before publish | real `withWriteTx` + `createChangeSink` on a temp DB with a recording `onCommitted` listener: every published `headSeq` is visible to a second read-only connection when the listener runs; a throw injected after `sink.record()` publishes nothing, leaves the head unchanged and leaves the facts LRU equal to its committed state; a lint/grep check finds no `transaction(`/`BEGIN` outside 03's `db/write.ts` in this design's modules |
| T-PL-06 | Backpressure | queue capacity 10: producer pauses, resumes on drain, all lines ingested, memory bounded (`queuedBytes <= cap`) |
| T-PL-07 | Malformed input | spool with each malformed case of 4.8 between valid lines: valid lines ingested, error counters exact, no throw |
| T-PL-08 | Poison item | an item whose row violates a constraint: split isolates it, `PERSIST_FAILED` once, other items committed |
| T-PL-09 | Out-of-order | the 21-event lab sequence shuffled 200 times (seeded): final DB facts and views identical |
| T-PL-10 | Downtime evidence | segment with envelopes 10 min older than server start: one `runtime_unavailable` reconciliation |
| T-PL-11 | Replay command semantics | 2.7 replay steps: dry run changes nothing; `--from` unknown -> `SPOOL_SEGMENT_NOT_FOUND`; stopped path resets cursors in one transaction; running path is queued behind an in-flight drain (never one transaction) |
| T-PL-12 | Foreign files | a `notes.txt` and a `hooks-x.jsonl` in `data/spool/` are never read, counted in `spool.foreignFiles` |


### 4.10 Service factories for the instance runtime (alignment with I-15)

01 4.4 (slice S8) owns `InstanceContext` and `createInstanceRuntime(ctx)`; it calls the two factories below. This design reads only
these `InstanceContext` fields (`engine/src/runtime/context.ts`): `instanceId`, `repoDir`, `instanceDir` (realpath of the task workspace: spool `<instanceDir>/data/spool/`, route file; C07), `config` (resolved, 1.2 keys), `clock` (`now(): number`),
`db` (`InstanceDb`, writer mode `serve`), `queries`, `claudeHome`, `mcsHome`, `logger` (05 logger, allow-listed fields), `errors`
(server error ring).

```ts
// engine/src/ingest/service.ts
export interface IngestStats {
  queued: number; queuedBytes: number; lastCommitAt: number | null; failures: number;
  spoolBytesBehind: number; transcriptBytesBehind: number; backfillRemainingBytes: number; filesTracked: number;
}
export interface IngestService {
  readonly writer: IngestWriter;                       // 01 4.4a passes it to createLifecycleSweeper(ctx, {writer}) and
                                                       // createPanelService(ctx, {writer}); 06 submits after its own COMMIT (4.3)
  start(): Promise<void>;
  stop(deadlineMs: number): Promise<void>;
  untilIdle(o: { timeoutMs: number }): Promise<void>;  // createInstanceRuntime.ingestUntilIdle delegates here
  nudge(): void;                                        // POST /api/v3/ingest/nudge (2.8), coalesced (2.7)
  replay(fromSegment: string | null): Promise<{ segmentsReset: number }>;   // control op ingest-replay {fromSegment} (2.7); 01 maps segmentsReset -> segments
  stats(): IngestStats;
}
export function createIngestService(ctx: InstanceContext): IngestService;

// engine/src/lifecycle/sweeper.ts
export interface LifecycleSweeper { start(): void; stop(deadlineMs: number): Promise<void>; tickNow(): Promise<void> }
export function createLifecycleSweeper(ctx: InstanceContext, deps: { writer: IngestWriter }): LifecycleSweeper;
```

`start()` (in order): 1. resolve the transcripts dir (5.1.1); 2. `writeRouteFile(instance, {stoppedAt: null})` (2.6.2); 3. drain
every unsealed spool segment once (records `runtime_unavailable`, 2.7); 4. start the spool poll (`spool.pollMs`), the import
scheduler (5.4) and the external pollers (7.10); resolves after step 3's first drain is committed. `stop(deadlineMs)`: 1. stop
accepting nudges and replays; 2. stop pollers and the scheduler after the current slice; 3. `writer.flushNow()` raced against
`deadlineMs` (uncommitted lines stay in the spool, uncommitted transcript bytes are re-read: nothing is lost); 4.
`writeRouteFile(instance, {stoppedAt: now, spoolUntil: ...})`. The sweeper's `start()` begins the `lifecycle.sweepIntervalMs` timer
(7.8); `stop()` clears it and waits for a running tick; `tickNow()` runs one tick (tests). `createInstanceRuntime` starts the
ingest service before the sweeper and stops them in reverse order.

`untilIdle({timeoutMs})` resolves when, at one check: every spool segment cursor equals its file size minus partial bytes, every
tracked transcript file has `bytes_behind == 0` and `backfill_remaining == 0` (or `skipped_backfill`), no discovery is pending, and
the writer queue is empty with no transaction in progress. It polls every 50 ms; on timeout it rejects with
`IngestIdleTimeoutError { pending: IngestStats }`. 01 4.4a `ingestUntilIdle` calls `untilIdle({timeoutMs: remaining})` and maps
`IngestIdleTimeoutError` to `{idle: false, stats}` (I-15, C06); 06 5.4 (parity harness) asserts `.idle === true`; integration tests
call the service directly.

Tests that prove it: T-PL-13 (`createIngestService` on a temp workspace: `start` drains a pre-filled spool before resolving;
`untilIdle` resolves after a 30 MB fixture import and rejects with `pending` on a file that keeps growing; `stop(500)` with a full
queue returns within 600 ms and a restart ingests the remainder without duplicates), T-LF-54 (sweeper `stop` waits for a running
tick; `tickNow` re-derives only rows past `next_check_at`).

## 5. Transcript importer

### 5.1 Discovery (`ingest/transcripts/discovery.ts`, port of `sessions.py` plus the survey facts)

#### 5.1.1 Transcripts directory

```ts
export function projectsRoot(env): string            // (env.CLAUDE_CONFIG_DIR || os.homedir() + '/.claude') + '/projects'  (legacy claude_home)
export function sanitizeProjectName(p: string): string   // every char outside [A-Za-z0-9] -> '-'  (TS:1, CS:C.4)
export function detectTranscriptsDir(repo: string, root: string): Promise<string | null>
```

`detectTranscriptsDir` (legacy `detect_transcripts_dir`, same order):
1. `root` is not a directory -> null.
2. `san = sanitizeProjectName(repo)` (repo = absolute path as configured). For `cand` in `[san, san.toLowerCase()]`: if
   `root/cand` is a directory -> return it. The comparison uses `routeKey()` of both names (2.5.4: case-insensitive on win32;
   list `root` once), because the folder case follows how the cwd was typed at launch (TS:1); discovery never reads
   `process.platform` itself (I-34).
3. `want = routeKey(repo)` (legacy `normcase(normalize())`; `routeKey` lowercases on win32, forward slashes on both sides). For each directory `d` of `root` sorted by mtime
   descending: its 3 newest `*.jsonl` files; for each, `firstCwd(f)` = the `cwd` of the first record with a truthy `cwd` within
   the first 61 lines (legacy `i > 60` break); if `routeKey(cwd) === want` -> return `d`.
4. null.

Config `transcripts_dir`: `"auto"` or null -> detect (retried every discovery cycle while null, because a fresh repo gets its
folder only after its first session); any other string -> absolute, or resolved against the repo. The route file always also
carries the predicted folder `root/sanitizeProjectName(repo)` (2.6.2).

#### 5.1.2 Files tracked

| Pattern under `tdir` | Kind | Rule |
|---|---|---|
| `<sid>.jsonl`, `sid` matches `SID_RE` | `session` | tracked when `mtime >= now - import.lookbackHours` (default = `window_hours`, 8) OR `sid` pinned (`session_ids`) OR the session has hook events OR it is already tracked |
| `<sid>/subagents/agent-<id>.jsonl` (+ `.meta.json`), `id` matches `AGENT_RE` | `subagent` | tracked with its session |
| `<sid>/subagents/workflows/<runId>/agent-<id>.jsonl` (+ `.meta.json`), `runId` matches `^wf_[A-Za-z0-9_-]{1,64}$` | `workflow_agent` | workflow membership ONLY by this exact relative layout (fixes the legacy defect that tested the word `workflows` anywhere in the absolute path, CS:F.6) |
| `<sid>/subagents/**/agent-<id>.jsonl` at other depths (<= 4 below `subagents/`) | `subagent` | forward compatibility |
| `<sid>/subagents/workflows/<runId>/journal.jsonl` | `workflow_journal` | tailed like a transcript; records `launched`, `started {agentId, key, label, phase}`, `result {agentId, key}`, `failed {agentId, key}` (TS:6.2); `result` bodies are never read past the keys |
| `<sid>/workflows/<runId>.json` | `workflow_status` | re-read whole (<= 8 MiB) when size or mtime changes; scalars only: `runId, workflowName, status, agentCount, durationMs, startTime`; never `script, result, logs, phases[].detail` |
| `<sid>/custom-title.json` | title | `customTitle` clipped to 120 cp, redacted |
| never opened | - | `tool-results/*`, `workflows/scripts/*`, `auto-mode-classifier-error.txt`, `memory/*`, any `*.key`, anything reached through a symlink |

- Every path opened by the importer comes from `readdir` of `tdir` or of a session folder inside it (`lstat`: regular files
  and real directories only; symlinks -> `SYMLINK_SKIPPED`). Paths from hook payloads or API input are hints only: on
  `SubagentStop` or the first envelope of an unknown session, discovery of THAT session folder runs immediately if
  `realpath(hint)` is inside `realpath(tdir)` (else `PATH_OUTSIDE_ROOT`).
- Agent metadata (`.meta.json`, <= 64 KiB, re-read on change): `agentType`, `description` (clip 160, redact), `model`,
  `requestShape`, `spawnDepth`, `toolUseId`, `workflowPhase` -> `agent.meta`. Agent label precedence (legacy):
  `label`, `description`, `name`, `agentType` (first non-empty string), else the agent id.
- Untracking: a tracked file that did not grow for `import.untrackAfterHours` (48) and whose session view is terminal or
  stale gets `state = 'untracked'` (cursors kept; it is re-tracked when its mtime moves into the window again).
- Cadence: `import.discoveryIntervalMs` 5000 for `readdir(tdir)` and the session folders of tracked sessions; on hints at once.

### 5.2 Session classification (port of `classify`, CS:C.4)

Computed from the head read (5.5), never by a second file pass:
1. `userTexts`: for records with `type === 'user'` within line indexes 0..400 (invalid lines consume an index): blocks = the
   string content, or the `text` of `type: 'text'` blocks; push every non-empty string NOT matching
   `BOILER = /^\s*<(local-command|ide_|browser_instruction|system-reminder|command-|user-prompt)/` (one record may push several);
   stop at the next line once `userTexts.length >= 25`.
2. `firstUserText`: within line indexes 0..120, the first non-empty text block of a `user` record, boilerplate included.
3. `realFirstPrompt = userTexts[0] ?? firstUserText ?? ''`.
4. For each rule in order: `text = rule.scope === 'any' ? userTexts.join('\n') : realFirstPrompt`;
   `re = compilePyRegex(rule.match, 'session_rule')` (01 2.8; context `session_rule` = Python `re.search(..., re.S)`; a
   `REGEX_UNSUPPORTED` throw at runtime skips the rule, as the legacy `re.error`); `m = re.exec(text)` (`PyMatch`, search
   semantics). On a match: `label = applyLabelTemplate(rule.label ?? rule.name ?? 'session', m)` (01 2.8: sequential `{i}`, then
   `{0}` = first 40 cp; C24). Result `(label, matched: true, ruleIndex)`.
5. No match: `label = realFirstPrompt.trim()` with LF -> space, first 70 cp, or `'(no prompt)'`; `matched = false`.
6. Pinned ids (`session_ids`) force `matched = true`.

Caching: the result is stored on the `transcript_file` row with `classified_lines` (number of head lines seen). It is recomputed
when the head grows and `classified_lines < 401`, when the rules change (config hash; heads are re-read, bounded by
`import.headMaxBytes` per file), or after an identity reset. Only the label is persisted. Privacy note (unchanged from legacy):
an unmatched session's label is the first 70 cp of its first prompt, and `{n}` substitution copies prompt text into labels.

### 5.3 Incremental tailing (`ingest/tail/jsonl-tailer.ts`, shared by transcripts and the spool)

```ts
export interface FileIdentity { ino: string | null; headLen: number; headHash: string }   // ino = decimal string of stat({bigint:true}).ino; head <= 256 bytes
export interface RawLine { offset: number; length: number; lineNo: number; bytes: Buffer }  // bytes exclude LF, trailing CR and a BOM at offset 0
export interface ReadResult { lines: RawLine[]; nextOffset: number; partialBytes: number; eof: boolean; counters: TailCounters }
export interface TailCounters { bomStripped: number; crlfLines: number; oversized: number; utf8Invalid: number }
export type IdentityCheck = { kind: 'unchanged' | 'grown'; stat: BigIntStats } | { kind: 'reset'; reason: 'truncated' | 'replaced'; stat: BigIntStats } | { kind: 'missing' } | { kind: 'unreadable'; code: string };
export function checkIdentity(path: string, stored: FileIdentity | null, storedSize: number, lowestCursor: number): Promise<IdentityCheck>;
export function readLines(path: string, from: number, to: number, deadline: number, opts: { chunkBytes: number; maxLineBytes?: number /* default MAX_LINE_BYTES (limits.ts); tests and 06's chain-log reader pass a smaller cap */; acceptValidUnterminatedTail: boolean }): Promise<ReadResult>;
export function lineStartAtOrAfter(path: string, pos: number): Promise<number>;   // legacy _line_start
```

`checkIdentity`:
1. `stat(path, {bigint: true})`: ENOENT -> `missing` (cursors kept); EACCES/EBUSY/EPERM -> `unreadable`.
2. `stored.ino` non-null and different -> `reset/replaced` (E5: replace-by-rename and delete-recreate change it).
3. `size < lowestCursor` (the smallest cursor that has consumed bytes) -> `reset/truncated`.
4. If size or mtime changed since the last check: read the first `min(256, size)` bytes; if `sha256(head[0..stored.headLen])` differs
   from `stored.headHash` -> `reset/replaced` (covers same-inode rewrites, E5 truncate keeps the inode). If `stored.headLen < 256`
   and the file is now longer, the identity is extended to the longer head (legacy behavior).
5. Else `grown` (size larger) or `unchanged`.

On `reset`: per-file rows of that `file_id` are deleted (`usage_files`, `entry_occurrences`, and the transcript reference of
`events` rows whose first occurrence is this file: transcript-only rows are deleted, merged rows (`sources & 1`) keep their hook part
with `record_uuid`, `file_id`, `byte_offset`, `byte_length`, `line_no` set to NULL and bit 2 removed, so the re-read merges again
through `natural_key`; repository methods `EventsRepo.deleteTranscriptOnly(ctx, fileId)` and `EventsRepo.detachTranscript(ctx,
fileId)` are requested from 03) in the same transaction as the first batch of the re-read; cursors restart from the initial
plan (5.5); reconciliation `identity_reset {reason}`. Facts are NOT rolled back (they are monotone evidence that activity
happened). Resets were never observed on real transcripts (TS:5: append-only, same inode, unchanged head on 18 live files).

`readLines(from, to)` (one call per scheduler slice):
1. Read `chunkBytes` (1 MiB) at `pos`, prepend the carry. Find the last LF (0x0A).
2. No LF yet: if `carry.length >= maxLineBytes` -> `LINE_TOO_LONG`: skip forward to the next LF without accumulating, count
   `oversized`; else read the next chunk (accumulate). At `to`/EOF go to step 5.
3. Split the bytes before the last LF on 0x0A. Per line: strip one trailing CR (count `crlfLines`); if `offset === 0` strip
   `EF BB BF` (count `bomStripped`); skip empty lines (not counted); `buffer.isUtf8(line)` false -> count `utf8Invalid`
   (decoding later uses replacement characters). A multi-byte UTF-8 character can never be split because 0x0A never occurs
   inside a multi-byte sequence.
4. After each line check `performance.now() >= deadline`; if so, stop with `nextOffset` = start of the next unread line.
5. At `to` with leftover bytes and no LF: if `acceptValidUnterminatedTail` and the leftover parses as a JSON object, emit it as a
   line and set `nextOffset = to` (legacy parity, CS:C.2; a later LF yields an empty line, skipped). Otherwise the leftover is
   NOT consumed: `partialBytes = leftover.length`, `nextOffset` stays at its start (fixes the CCAM torn-line loss, CC:13).
   Transcripts use `acceptValidUnterminatedTail: true`; the spool uses `false` (envelopes are always LF-terminated).

### 5.4 Scheduling (answers foundations open question 4: no worker thread)

Decision (ADR 0015): parse on the main thread with async chunked reads and 20 ms cooperative slices. Evidence E3/E4:
243-404 MB/s end to end, JSON.parse 373-567 MB/s, event-loop delay max 13.3 ms with 1 MiB chunks; the whole measured corpus
(about 780 MB, TS:0) is about 3 s of CPU. A worker pool would add serialization of lines and records for no measured need.

```
ImportScheduler (engine/src/ingest/transcripts/scheduler.ts)
  priorities: P0 spool drain | P1 tail of files with size > tail_offset | P2 head of newly discovered files | P3 backfill
  statTick  every import.scanIntervalMs (1000): async stat of tracked files, 32 in parallel -> mark P1 work
  discovery every import.discoveryIntervalMs (5000) and on hints
  loop while work exists:
    task = highest priority, round-robin inside a priority
    result = readLines(file, cursor, end, deadline = now + import.sliceMs (20))
    items = normalizeRecords(result.lines)  -> writer.submit({items, cursor}); false -> await writer.onDrain
    await setImmediate()                                   // yield to HTTP, SSE, timers
    P3 runs only while its token bucket allows import.backfillShare (0.25) of wall time per second
```

The scheduler drives no panel work: 06's `tickAttempts` runs on 01 4.4a's 2 s timer and reaches this design only through
`IngestWriter.submit` (4.3; N-01).

Guarantee: no synchronous section longer than `sliceMs` plus the parse time of one line (a 64 MiB line is the only exception).
Health exports `eventLoopDelayP99Ms` (`monitorEventLoopDelay`); if production shows p99 > 50 ms, parsing moves to a
`worker_threads` pool behind the same `normalizeRecords(lines) -> items` interface (UNVERIFIED need; plan in section 12).

### 5.5 Initial scan policy (the legacy two-cursor idea, persisted)

At first sight of a file of size `S0`:
1. Head (P2): `head_end` = offset after the first 401 lines or `import.headMaxBytes` (16 MiB), whichever comes first.
   Classification (5.2), first timestamp in file order, `cwd`, `entrypoint`, `version`.
2. Tail (P1): if `S0 - head_end > import.tailWindowBytes` (= `limits.event_window_mb`, default 8 MiB) then
   `tail_start = lineStartAtOrAfter(S0 - tailWindowBytes)`, else `tail_start = head_end`. `tail_offset = tail_start`, then the
   tail cursor follows growth forever.
3. Backfill (P3): range `[head_end, tail_start)`, cursor `backfill_offset = head_end`. If `S0 > import.backfillMaxBytes`
   (= `limits.usage_max_mb`, default 512 MiB): backfill skipped (`backfill_offset = tail_start`), `usage = 'skipped_backfill'`.
4. Invariant: `0 <= head_end <= backfill_offset <= tail_start <= tail_offset <= size`, all at line starts.

Order is head, tail, backfill: the newest state appears first and history fills in behind it. This is safe because usage rows
are max-merged and lifecycle facts are a semilattice (7.2): the reading order cannot change the result.

Completeness per file: `events = 'partial'` while `backfill_offset < tail_start`, else `'full'`; `usage` = `'complete'` |
`'partial'` | `'skipped_backfill'`; `scannedPct = floor(100 * consumed / max(1, size - partialBytes))` with
`consumed = head_end + (backfill_offset - head_end) + (tail_offset - tail_start)`.

### 5.6 Record normalization (`ingest/transcripts/normalize-record.ts`)

Input: one parsed record (`TranscriptRecordShape`), its file (kind, session id from the DIRECTORY, agent id from the file
name), offset and line number. Output: `LogicalEvent[]`, an optional `events` row (`EventRowWrite`, 4.1.2; stored kind = the
table's last column), optional usage update.
Stamp = `{ at: Date.parse(record.timestamp) (if valid), rank: per type (4.3), tie: 't:' + file_id + ':' + offset }`.
Records without a valid `timestamp` produce no stamped events (bookkeeping, TS:2.2).

| Record | Logical events | Entry `kind` (`entry_kind`) | Stored `kind` (`events.kind`, 4.1.2) |
|---|---|---|---|
| `user`, not `isMeta`, not `isCompactSummary`, content is a string or has a `text` block and NO `tool_result` block, text does not start with `[Request interrupted by user` | `turn.prompt` (`promptId` = record `promptId`, `origin` = `origin.kind` ?? `promptSource` ?? `'unknown'`), `activity(user)`; if `origin.kind === 'task-notification'`: `agent.notification` (below) | `prompt` (`text_len` only) | `prompt.submit` (natural key `prompt:` when `promptId`); `agent.notification` when `origin.kind === 'task-notification'` (no natural key) |
| `user` whose first text starts with `[Request interrupted by user` | `interrupt(user_marker)`, `activity(user)` | `prompt` with flag `interrupt` | `turn.interrupt` |
| `user` with `tool_result` blocks | per block `tool.end` with outcome: `denied` if record `toolDenialKind` set, else `error` if `is_error === true`, else `ok`; `activity(tool_result)`; Agent `toolUseResult.agentId` (`AGENT_RE`) -> `agent.link {status: toolUseResult.status}`; Workflow `toolUseResult.runId` -> `workflow.launch`; `toolEndsTurn === true` in an agent file -> `agent.final(tool_ends_turn)` | `result` (`tool_use_id`, `text_len`) | per block: `tool.result`, or `tool.failure` (`severity 2`) when the outcome is `error` or `denied` (natural key `tool.end:`); the first block's row carries `record_uuid`, later blocks of the same record carry only their natural key |
| `user`, `isMeta` or `isCompactSummary` | `activity(user)` | not stored | no row |
| `assistant` | `activity(assistant)`; usage (section 6); `isApiErrorMessage === true` -> `api_error {status: apiErrorStatus, error}`; else if `message.model !== '<synthetic>'` -> `assistant.ok`; `isAbortedMidStream` -> `interrupt(aborted_mid_stream)`; `tool_use` block -> `tool.start {name, summary: summarizeToolInput(input), inputHash}`; `stop_reason` in (`end_turn`, `stop_sequence`) -> `turn.end(end_turn)` | `tool` / `say` / `think` per block (one block per record, TS:2.5); `think` stores no text and no signature | `tool` -> `tool.call` (natural key `tool.call:`); `say` -> `assistant.message`, or `api.error` when `isApiErrorMessage === true`; `think` -> `assistant.thinking` |
| `system/turn_duration` | `turn.end(turn_duration, pendingBackgroundAgents, pendingWorkflows)` | `system` | `turn.duration` |
| `system/compact_boundary` | `compaction {trigger, preTokens, postTokens}` from `compactMetadata` | `system` | `context.compact` |
| `system/away_summary`, `local_command`, `informational`, other subtypes | `info` | `system` (no content) | `system.info` |
| `attachment/hook_non_blocking_error` whose `attachment.command` contains `--mcs-hook` | `hook.handler_error {hookEvent, exitCode}` | `attachment` flag `ours` | `hook.handler_error` |
| `attachment/queued_command` | `info(queued_command)` | `attachment` | `prompt.queued` |
| `attachment/task_status` | none (the task-notification is authoritative) | `attachment` | `system.info` |
| `attachment/structured_output` in a workflow agent file | `agent.final(structured_output)` | `attachment` | `agent.final` |
| other `attachment/*` (including `hook_non_blocking_error` without the marker) | none; counted per `attachment.type` | not stored | no row |
| `ai-title`, `custom-title`, `agent-name` | `title` (value clipped 120 cp, redacted; emitted only when it differs from the last value of that file) | not stored | no row |
| `continued-in` | `session.continued_in {target}` | not stored | no row |
| `cost-state` | `cost_state` (numbers only) | not stored | no row |
| `last-prompt`, `atis-latch`, `mode`, `permission-mode`, `queue-operation`, `file-history-snapshot`, `file-history-delta`, `bridge-session` | none (never activity; `bridge-session` is never stored because it carries account ids) | not stored | no row |
| journal `started` / `result` / `failed` | `workflow.status` counters for the run (agent ids only) | not stored | no row |
| unknown `type` | counted in `unknownRecordTypes` | not stored | no row |

Task notification parsing (`task-notification.ts`): take the string content or the first text block, first 64 KiB only; extract the
FIRST occurrence of each tag with `/<(task-id|tool-use-id|status)>([^<]{1,200})<\/\1>/g`; `status` outside
`completed|failed|killed|stopped` -> null (event-only notification). Never read `<result>`, `<summary>`, `<usage>`, `<output-file>`.

Resume copies: when the `events` insert of a record hits an existing `record_uuid` from another file (no row returned, 03 3.6),
the writer records an `entry_occurrences` row and counts it per (file, source file); after each batch, a file with a non-zero count emits
`session.copied_from {source session, count}` once per change (reconciliation `copied_records`). Copied records still update
usage rows of the copy's file (6.2 decides ownership) but their `activity` events are dropped (they are old evidence already
merged from the original).

### 5.7 Persisted versus referenced (privacy)

Persisted: the entry metadata of 4.1, tool summaries (160 cp, redacted), lengths, ids, flags, labels and titles (clipped,
redacted), usage numbers, cost-state numbers. A `TranscriptRef = { fileId, byteOffset, byteLength, ino, headHash }` points
at the provider file for everything else.

Never persisted (normative): prompt and assistant text; thinking text and `signature`; `tool_use.input` (only summary and hash);
`tool_result` content; `toolUseResult` (only `agentId`, `status`, `runId`, `workflowName`, `taskId`); attachment bodies (only
`type`, and for hook errors `hookEvent`, `exitCode`, ours yes/no); `prompt_snapshot`; `file-history-*`; `bridge-session`;
`credential_org.organizationUuid`; `last-prompt.lastPrompt`; `queue-operation.content`; `away_summary.content`;
`local_command.content`; workflow `script`, `result`, `logs`; journal `result`; `cost-state` non-numeric fields.

`readEntryText(ref, opts)` (`entry-text.ts`, used by session detail and search): re-checks the identity (`ino`, head hash),
reads `[byteOffset, byteOffset + byteLength)` (<= `MAX_LINE_BYTES`, the same constant as the tailer and 03's window and search), parses, and returns the legacy `events_of` projection
of that record (kinds `prompt|say|think|tool|result`, legacy clips: `text_chars` 6000, tool input 4000 via `pyJsonDumps`, think
1500, summary 160, code points). Failure: `{ ok: false, reason: 'REF_STALE' | 'READ_FAILED' | 'NOT_FOUND' }`. Nothing is cached
beyond the request. Treat the returned text as untrusted data (brief 12).

### 5.8 Memory bounds

| Holder | Bound |
|---|---|
| per tracked file state | about 1 KB; tracked files are bounded by the window (corpus: 25 sessions, 505 agent files) |
| read buffer | one chunk (1 MiB) + carry; carry <= `MAX_LINE_BYTES` (64 MiB) only for a pathological single line; one read at a time |
| ingest queue | 5,000 items / 32 MiB (4.7) |
| facts cache | LRU 2,000 entities |
| classification | <= 25 texts of one file during its head read |
| events in memory | none (the legacy `events[]` up to `max_events` is replaced by the DB) |

### 5.9 Freshness, lag and error counters

Per file (on `transcript_file`): `size_seen`, `mtime_seen`, `tail_offset`, `partial_bytes`, `bytes_behind = size_seen - tail_offset - partial_bytes`,
`behind_since` (first time `bytes_behind > 0`, cleared at 0), `last_read_at`, `last_growth_at` (mtime when size grew),
`backfill_remaining = tail_start - backfill_offset`, counters `invalid_json`, `not_object`, `shape_invalid`, `oversized`,
`utf8_invalid`, `bom_stripped`, `crlf_lines`, `unknown_types`, `read_errors`, `identity_resets`.

Instance aggregate (`ingest_health.transcripts`, section 8.2): `filesTracked`, `filesMissing`, `filesUnreadable`, `bytesBehind`
(sum), `maxLagMs` (`now - min(behind_since)`), `backfillRemainingBytes`, `lastSyncAt` (end of the last stat cycle in which
every tracked file had `bytes_behind == 0`), `lastScanAt`, error counters (sums), `eventLoopDelayP99Ms`.

### 5.10 Tests that prove it (importer)

Fixture builders in `engine/test/fixtures/transcripts.ts` produce the 25 survey shapes (TS:8) deterministically with
placeholder strings; parity fixtures also come from the legacy `tests/fixtures/make.py` output.

| Id | Guarantee | Test |
|---|---|---|
| T-TR-01 | Partial last line | write half a record, read, append the rest + LF, read: the record is ingested exactly once (CCAM regression, CC:13) |
| T-TR-02 | Valid unterminated tail (legacy) | a complete object without LF is consumed; the later LF yields no extra record |
| T-TR-03 | Growth during reads | a writer appends 10,000 lines in random-sized pieces while the tailer reads: final record set equals a one-shot parse |
| T-TR-04 | UTF-8 boundaries | chunk size 7 bytes over lines with 2-, 3-, 4-byte characters: identical records to a one-shot parse |
| T-TR-05 | Long lines | 1.3 MB and 3 MB lines with 1 MiB chunks parse; a line > the cap (test cap 1 MiB injected through the `readLines` option `maxLineBytes`; production uses `MAX_LINE_BYTES`) is skipped and counted, the next line parses |
| T-TR-06 | CRLF and BOM | fixture 23: records equal; counters set |
| T-TR-07 | Identity | truncate, replace-by-rename, delete-recreate with equal size, rewrite same inode with different head: each -> reset with the expected reason, per-file usage recomputed, no double count |
| T-TR-08 | Missing/unreadable | file deleted then recreated; EACCES simulated: state transitions and recovery |
| T-TR-09 | Initial scan | 30 MB fixture: head, tail, backfill order; after the tail phase, latest-state facts are present and `events: partial`; after backfill `usage: complete` and totals equal a full scan |
| T-TR-10 | Backfill skip | `backfillMaxBytes` 1 MiB on a 3 MiB file: `skipped_backfill`, legacy projection shows `unavailable` |
| T-TR-11 | Responsiveness | while importing a 100 MB fixture, a 5 ms `setInterval` probe never sees a delay > 50 ms (p99 < 25 ms) |
| T-TR-12 | Discovery | fixtures 18, 19, 25: subagent and workflow layouts, a project path containing the word `workflows` is not a workflow, symlinked file skipped, `.key` never opened (spy on `fs.open`) |
| T-TR-13 | Transcripts dir detection | sanitized name, lowercase variant, cwd fallback (3 newest files), drive-letter case difference, cwd moving into a subfolder (fixture 25) |
| T-TR-14 | Classification parity | golden labels from the Python oracle for: no rules, first-prompt rule, `scope:any`, `{1}`/`{0}` substitution, unmatched truncation at 70 cp, boilerplate-only first record, 401-line limit, pinned id |
| T-TR-15 | Record mapping | each row of the 5.6 table on fixtures 1-22: expected logical events; bookkeeping (fixture 14) never produces `activity` |
| T-TR-16 | Privacy | fixtures carry sentinel strings in every never-persisted field; after import, a full DB dump contains no sentinel |
| T-TR-17 | Text on demand | `readEntryText` returns the legacy projection; after replacing the file it returns `REF_STALE` |
| T-TR-18 | Resume copies | fixture 21: copied uuids recorded as occurrences, `copied_records` reconciliation, no duplicate activity |
| T-TR-19 | Task notification | fixture 17: statuses parsed; `<result>` sentinel never stored |

## 6. Token accounting (`engine/src/tokens/`)

### 6.1 Source and schema

Tokens come ONLY from `assistant` records of transcripts (`message.usage`, TS:3.1). Hooks contribute zero tokens (D8): the
PostToolUse Agent field `agent_total_tokens` is informational, labelled as such, and never summed (test T-TK-08). Fields read per
record: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
`cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, `output_tokens_details.thinking_tokens`
(included in output, never added), `server_tool_use.web_search_requests`, `server_tool_use.web_fetch_requests`, `iterations[0]`,
plus `message.id`, `message.model`, `message.stop_reason`, record `uuid`, `timestamp`.

### 6.2 Rules (normative)

1. Message key: `message.id` if it is a non-empty string of <= 128 chars; else `uuid:` + record `uuid`; else
   `line:<file_id>:<byte_offset>` (legacy fallback order id, uuid, line, CS:C.3).
2. Valid number: `Number.isSafeInteger(v) && v >= 0`. Anything else (float, negative, string, boolean, null) is MISSING for that
   record and increments `invalid_values` when the key was present.
3. Effective values of a record: if the four top-level fields are all 0 or all missing AND `usage.iterations` is an array whose
   element 0 is an object with at least one valid positive value among the four, use `iterations[0]` for the four fields and its
   `cache_creation` split (`usage_source = 'iterations'`, TS:3.3); otherwise the top-level values (`usage_source = 'top'`).
4. Per file and message key, every field is the MAX over that file's records of the key (TS:3.2: session files repeat identical
   usage; subagent files grow only `output_tokens`; max equals "last record wins" on the whole corpus). Missing stays missing
   until one record provides a valid value. Stored in `message_usage_file` together with the legacy values (rule 11).
5. `finalized` = any record of the key in that file has a non-null `stop_reason` or an `iterations` array.
6. Global dedupe: the instance-wide value of a message key is the per-field MAX over all its files (`message_usage_file` rows).
   A message key is counted once per instance, whatever the number of files containing it (resume copies, TS:3.5).
7. Owner (who gets the tokens): among the files containing the key, the file with the smallest
   `(birth_ms > 0 ? birth_ms : first_seen_mtime_ms, path)`; the owner session is that file's session (from its DIRECTORY), the
   owner agent is the file's agent (null for the main file). Copies are created after their originals, so the original wins;
   when the original is outside the tracked window, the copy owns the message (the instance still counts it once).
8. Missing versus zero: aggregates report `sum` over messages with a value AND `missing` = number of messages without one, per
   field. Zero is a value. The UI shows "N of M messages without <field>" (brief 8.7).
9. Lower bound: `unfinalized` = number of counted, non-synthetic messages with `finalized = false`; `outputIsLowerBound =
   unfinalized > 0` (subagent files: 38-53% of ids never finalize, TS:3.2). Additionally `complete = false` while any
   contributing file has `usage !== 'complete'`: then every field is a lower bound.
10. Synthetic messages (`message.model === '<synthetic>'`): counted in `messages` (legacy `turns` parity), flagged, excluded from
    per-model aggregates and from `models` in the new API.
11. Legacy values per (file, key): `legacy_in/out/cr/cc` = max of TOP-LEVEL integer values only (no iterations fallback,
    missing = 0), used only by the legacy projection (6.5).
12. Cache read and cache creation are always separate fields; cache creation is further split into 5m and 1h when the split is
    present (a missing split is missing, not zero).
13. Compaction: nothing special. Usage is per API call, not cumulative (TS:3.6); the summarization call is not an assistant
    record and is not counted (cost-state may include it, 6.6).

### 6.3 Aggregates (`aggregate.ts`)

```ts
export interface UsageFields { input: number; output: number; cacheRead: number; cacheCreation: number; cacheCreation5m: number; cacheCreation1h: number; thinking: number; webSearch: number; webFetch: number }
export interface UsageAggregate {
  sum: UsageFields;                                   // over messages with a value
  missing: { [K in keyof UsageFields]: number };      // messages without a value for K
  messages: number;                                   // counted message keys (owner scope)
  synthetic: number;
  unfinalized: number;
  outputIsLowerBound: boolean;
  complete: boolean;                                  // all contributing files fully scanned
  copiedMessages: number;                             // keys present in this scope's files but owned elsewhere (not summed)
}
export function aggregateSession(sessionId: string, scope: 'own' | 'agents' | 'total'): UsageAggregate;
export function aggregateAgent(sessionId: string, agentId: string): UsageAggregate;
export function aggregateByModel(filter: UsageFilter): Array<{ model: string; agg: UsageAggregate }>;
export function aggregateByHour(filter: UsageFilter): Array<{ hourStart: number; agg: UsageAggregate }>;   // bucket = message first_ts
export function aggregateInstance(filter: UsageFilter): UsageAggregate;
```

Projection to the UI's assumed `TokenUsage` (04 section 13): `input|output|cacheRead|cacheCreation` = `sum.<field>`, or null when every counted message misses that field; `turns` = `messages`; `completeness` = `complete` when `complete`, `unavailable` when every contributing file is `skipped_backfill`, else `partial`; `scannedPct` = the minimum over contributing files; `lowerBound` = `outputIsLowerBound || !complete`. The `missing` counts and the 5m/1h split are extra fields the API exposes.

### 6.4 Worked example (becomes `engine/src/tokens/worked-example.test.ts`)

Files: F1 = main file of session S1 (created 10:00); F2 = S1 subagent file `agent-a1` (10:05); F3 = main file of session S2,
which resumed S1 (11:00) and begins with copies of F1's msg_A records. Models: `model-x` for A, B, Z, N, E; `model-y` for C, D.

| Record(s) | File | Usage per record (in / out / cache_read / cache_creation; split 5m / 1h) | stop_reason | iterations |
|---|---|---|---|---|
| msg_A x2 | F1 | 10 / 200 / 5000 / 1000; 0 / 1000 (both records) | null, `end_turn` | on the 2nd |
| msg_B | F1 | 4 / 50 / 6000 / 0; 0 / 0 | `tool_use` | yes |
| msg_Z | F1 | top-level 0 / 0 / 0 / 0; `iterations[0]` = 2 / 300 / 959572 / 4000; 0 / 4000 | `tool_use` | yes |
| synthetic (id is a 36-char non-`msg_` value, model `<synthetic>`) | F1 | 0 / 0 / 0 / 0; no split | `stop_sequence` | no |
| msg_N (no `usage` object) | F1 | all missing | `end_turn` | no |
| msg_C x3 | F2 | in 3, cr 1000, cc 200 (split 200 / 0) on all; out 8, 8, 412 | null, null, `tool_use` | on the 3rd |
| msg_D x2 | F2 | in 5, cr 800, cc 0 (split 0 / 0); out 8, 8 | null, null | no |
| msg_A x2 (copies) | F3 | as in F1 | as in F1 | as in F1 |
| msg_E | F3 | 6 / 70 / 7000 / 500; 0 / 500 | `end_turn` | yes |

Expected per message (global): A 10/200/5000/1000 owner S1 (F1 older than F3); B 4/50/6000/0; Z 2/300/959572/4000 (`iterations`);
synthetic 0/0/0/0 (synthetic); N missing on all four; C 3/412/1000/200 (finalized); D 5/8/800/0 (NOT finalized); E 6/70/7000/500.

| Scope | input | output | cache_read | cache_creation | 5m / 1h | messages | missing (per main field) | flags |
|---|---|---|---|---|---|---|---|---|
| S1 own (F1) | 16 | 550 | 970,572 | 5,000 | 0 / 5,000 | 5 (1 synthetic) | 1 | complete |
| S1 agents (F2) | 8 | 420 | 1,800 | 200 | 200 / 0 | 2 | 0 | `unfinalized` 1, `outputIsLowerBound` |
| S1 total | 24 | 970 | 972,372 | 5,200 | 200 / 5,000 (split missing 2: synthetic, N) | 7 | 1 | `outputIsLowerBound` |
| S2 own (F3) | 6 | 70 | 7,000 | 500 | 0 / 500 | 1 | 0 | `copiedMessages` 1 |
| Instance | 30 | 1,040 | 979,372 | 5,700 | 200 / 5,500 | 8 | 1 | `outputIsLowerBound` |
| model-x | 22 | 620 | 977,572 | 5,500 | 0 / 5,500 | 5 | 1 | - |
| model-y | 8 | 420 | 1,800 | 200 | 200 / 0 | 2 | 0 | `outputIsLowerBound` |

Checks inside the test: model-x + model-y = instance on every field (the synthetic message adds zeros); S1 total = own + agents.

Edge cases (each a separate test):
- X1 invalid values: `output_tokens` 1.5, -3, `"12"`, `true` in four records of one id with no other output value -> output missing,
  `invalid_values = 4`.
- X2 differing copies: msg_F output 100 in F1 and 120 in F3 -> global output 120, owner S1.
- X3 split reads: msg_C records 1-2 in one incremental read and record 3 in the next: after read 1 output 8, `finalized` false;
  after read 2 output 412, `finalized` true.
- X4 zero is not missing: usage `{0, 0, 0, 0}` without iterations -> zeros, `missing` 0.
- X5 order independence: the F1/F2/F3 records in any of 200 seeded permutations of file read order and record order -> identical
  aggregates.

### 6.5 Legacy parity projection (`legacy-projection.ts`)

`legacyFileUsage(fileId)` reproduces `TranscriptReader.usage()` (CS:C.2, C.3) from persisted rows:
`in/out/cr/cc` = sum over the file's keys of `legacy_*` values; `turns` = number of keys in the file (synthetic and fallback keys
included); `models` = sorted distinct non-empty `message.model` values seen in the file (including `<synthetic>`); `first` = the
timestamp string of the first record in file order that has one; `last` = lexicographic max timestamp string over ALL records of
the file (bookkeeping included); `stop` = the legacy `last_stop` (stop_reason of the last assistant message in file order, reset
when the message id changes); `complete` = `usage === 'complete'`; `scanned_pct` from 5.5 (`skipped_backfill` -> 0 with
`skipped: true`). `legacyUsageTotal(sessionId)` = own + every agent file (`add_usage`: sums of `in, out, cr, cc, turns`,
`complete` = AND).

For the worked example: F1 legacy = 14 / 250 / 11,000 / 1,000, turns 5, models `['<synthetic>', 'model-x']`; F2 = 8 / 420 / 1,800 / 200,
turns 2; S1 `usage_total` = 22 / 670 / 12,800 / 1,200, turns 7; F3 = 16 / 270 / 12,000 / 1,500, turns 2. Documented, deliberate
differences of the new totals (ADR 0017): S1 +2 / +300 / +959,572 / +4,000 (the iterations fallback for msg_Z); S2 excludes the copied
msg_A (-10 / -200 / -5,000 / -1,000). Corpus scale of the second difference: +2.4% to +4.0% over-count in the legacy rule (TS:3.5).
Known legacy quirk not reproduced: Python counts `True` as 1 (bool is an int).

### 6.6 Provider cost state (supplementary)

The last `cost-state` record per file is kept (numbers only: `totalCostUSD`, per model `inputTokens, outputTokens, thinkingTokens,
cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD`, `is_trailing` when it is the last record of the
file). It is shown as "provider-reported, cumulative per process, may include calls not in the transcript (TS:3.4)", never summed
with transcript tokens, never used as a fallback. Cost estimates from user prices are the analytics designer's and are labelled
estimates (D15).

### 6.7 Tests that prove it (tokens)

| Id | Guarantee | Test |
|---|---|---|
| T-TK-01 | Rules 1-13 | the worked example table, exact numbers |
| T-TK-02 | X1-X5 | the edge cases above |
| T-TK-03 | Idempotent re-import | import the three files twice, and once more after a forced identity reset of F2: same aggregates |
| T-TK-04 | Legacy parity | `legacyFileUsage` equals the Python oracle's `/api/sessions` `usage` and `usage_total` on the parity fixtures (legacy `tests/fixtures/make.py` data and the worked example converted to legacy input) |
| T-TK-05 | Independent recomputation | a second, naive implementation in the test (read all lines, last record per id wins, global dedupe) equals `aggregateInstance` on fixtures 1-4, 21 (mirrors the survey's method B, TS:3.4) |
| T-TK-06 | Missing vs zero | API shape contains `missing` per field; a message without usage is never reported as zero |
| T-TK-07 | Partial scan | during backfill `complete: false`; after, `true` and equal totals |
| T-TK-08 | Hooks add zero | ingest a PostToolUse(Agent) envelope with `agent_total_tokens` 9999: no aggregate changes |
| T-TK-09 | Isolation | two instances over overlapping fixture files: each counts only its own files (release-blocking isolation test input, brief 4) |


## 7. Lifecycle model (`engine/src/lifecycle/`)

Design (ADR 0018): every source is reduced into FACTS that form a join-semilattice (each merge is commutative, associative and
idempotent), and the visible state is a PURE function `derive(facts, related rows, now, cfg)` evaluated through a
priority-ordered decision table. Order independence, idempotence and duplicate tolerance therefore hold by construction and
are checked by property tests (7.12); time-based states (stale, abandoned) are re-evaluated by a sweeper without new events (7.8).
Execution state, monitor health (section 8) and data freshness are separate.

### 7.1 Axes, enums, view

```ts
export type LifecycleState = 'running' | 'working' | 'waiting_input' | 'waiting_tool' | 'waiting_agent' | 'turn_ended' | 'completed' | 'failed' | 'stale' | 'unknown';
export type Presence = 'open' | 'ended' | 'unknown';                       // is the provider process/session still there
export type WaitReason = 'user' | 'permission' | 'elicitation' | 'agent_input' | 'idle_prompt';
export type StaleKind = 'silent' | 'abandoned' | 'process_gone' | 'parent_ended';
export type Basis = 'observed' | 'inferred';
export type Confidence = 'high' | 'medium' | 'low';
export type EvidenceSource = 'hook' | 'transcript' | 'registry' | 'job' | 'attempts' | 'pid' | 'workflow_file' | 'journal' | 'meta' | 'clock';
export type EvidenceFact = 'session_end' | 'session_start' | 'stop' | 'stop_failure' | 'end_turn' | 'interrupt' | 'prompt' | 'tool_open' | 'permission_request'
  | 'notification' | 'registry_status' | 'job_state' | 'attempt_row' | 'pid_dead' | 'pid_alive' | 'file_written' | 'child_active' | 'background_pending'
  | 'agent_notification' | 'agent_stop' | 'agent_final' | 'agent_link' | 'workflow_status' | 'quiet' | 'no_records' | 'api_error' | 'activity_after_end' | 'parent_ended';
export interface LifecycleEvidence { source: EvidenceSource; fact: EvidenceFact; at: number | null; count?: number;   // engine form (C18)
  value?: string /* enum-like, <= 64 chars, never content; exception: attempts:attempt_row carries 06's chain-log evidence text, <= 160 cp */ }
export interface LifecycleView {
  state: LifecycleState; presence: Presence; waitReason: WaitReason | null; staleKind: StaleKind | null;
  endReason: string | null;                         // SessionEnd reason, job state, attempt status
  turnOutcome: 'ok' | 'error' | 'interrupted' | null;
  basis: Basis; confidence: Confidence; ruleId: string;   // rule that decided, e.g. 'S-7c'
  evidence: LifecycleEvidence[];                    // ordered, <= 8; words are rendered at read time ("quiet 12m")
  since: number | null;                             // at of the deciding fact
  evaluatedAt: number; nextCheckAt: number | null;
}
```

API projection (the UI design 04 section 13 imports `StateAssessment` / `EvidenceItem { kind, at, text }`, defined in 03 5.5): `kind` = `<source>:<fact>`, `at` = ISO of `at`, `text` = `renderEvidence(item, now)` evaluated at response time; `legacyState` = `toLegacy()` of 7.9. The state names here are the `LIFECYCLE_STATES` list of `@mcs/shared` (same ten values as 04).

Exports used by the data design (03 3.6, 5.5, 9.3) and the CLI (I-33):

```ts
// engine/src/lifecycle/rules.ts
export function fmtAge(ms: number): string;                                  // 7.1.1
export function renderEvidence(item: LifecycleEvidence, now: number): string;     // 7.1.1 template table; pure, English, never content
export function toApiEvidence(item: LifecycleEvidence, now: number): ApiEvidenceItem;   // { kind: `${source}:${fact}`, at: iso(at) | null, text: renderEvidence(item, now) }
// ApiEvidenceItem = import type { EvidenceItem as ApiEvidenceItem } from '@mcs/shared' (sh/api/entities.ts, 03 5.5; C18)
export function viewChanged(a: LifecycleView | null, b: LifecycleView): boolean;   // 7.8 field list; a === null -> true
// engine/src/lifecycle/legacy.ts
export function toLegacy(view: Pick<LifecycleView, 'state'>): LegacyState;  // 7.9 item 2 mapping
```

#### 7.1.1 Evidence rendering (`renderEvidence`)

`fmtAge(ms)`: `ms = max(0, floor(ms))`; `< 60000` -> `<floor(ms/1000)>s`; `< 3600000` -> `<floor(ms/60000)>m`; `< 172800000` ->
`<floor(ms/3600000)>h`; else `<floor(ms/86400000)>d`. `ago` = `item.at === null ? '' : ' ' + fmtAge(now - item.at) + ' ago'`;
`age` = `item.at === null ? null : fmtAge(now - item.at)`. `v` = `item.value`, `c` = `item.count`. The result is clipped to 120 cp.

| Fact | Template (JS template-literal notation) |
|---|---|
| `session_end` | `session ended (${v ?? 'no reason'})${ago}` |
| `session_start` | `session started (${v ?? 'startup'})${ago}` |
| `stop` | `turn stopped${ago}` |
| `stop_failure` | `turn failed: ${v ?? 'error'}${ago}` |
| `end_turn` | `assistant ended the turn${ago}` |
| `interrupt` | `interrupted by the user${ago}` |
| `prompt` | `prompt submitted${ago}` |
| `tool_open` | `tool ${v ?? 'call'} open` + (c > 1 ? ` (${c} open)` : '') + (age ? ` for ${age}` : '') |
| `permission_request` | `waiting for permission (${v ?? 'tool'})${ago}` |
| `notification` | `notification ${v ?? 'received'}${ago}` |
| `registry_status` | `registry: ${v}${ago}` |
| `job_state` | `daemon job ${v}${ago}` |
| `attempt_row` | `${v}` (06's chain-log evidence text, verbatim; the CLI renderer escapes it for the terminal) |
| `pid_dead` | `process gone` + (age ? ` (checked ${age} ago)` : '') |
| `pid_alive` | `process alive` + (age ? ` (checked ${age} ago)` : '') |
| `file_written` | `transcript written${ago}` |
| `child_active` | `${c ?? 1} child agent(s) active` |
| `background_pending` | `${c ?? 1} background task(s) pending` |
| `agent_notification` | `agent ${v ?? 'notified'}${ago}` |
| `agent_stop` | `agent stopped${ago}` |
| `agent_final` | `agent returned its final output${ago}` |
| `agent_link` | `agent ${v ?? 'linked'}${ago}` |
| `workflow_status` | `workflow ${v ?? 'status unknown'}${ago}` |
| `quiet` | `quiet` + (age ? ` ${age}` : '') |
| `no_records` | `no records yet` |
| `api_error` | `API error` + (v ? ` ${v}` : '') + ago |
| `activity_after_end` | `activity after session end${ago}` |
| `parent_ended` | `parent session ended${ago}` |

Golden table test (`engine/src/lifecycle/rules.test.ts`, slice I-7), `now = 1791727200000`: `{clock, quiet, at: now - 720000}` ->
`quiet 12m`; `{hook, session_end, at: now - 180000, value: 'other'}` -> `session ended (other) 3m ago`; `{hook, tool_open, at: now -
95000, value: 'Bash', count: 2}` -> `tool Bash open (2 open) for 1m`; `{pid, pid_dead, at: now - 5000}` -> `process gone (checked 5s
ago)`; `{transcript, no_records, at: null}` -> `no records yet`; `{job, job_state, at: now - 90000000, value: 'done'}` -> `daemon job
done 25h ago`; `{clock, quiet, at: now - 259200000}` -> `quiet 3d`; `{attempts, attempt_row, at: now, value: 'chain log: exit=0
status=PASS'}` -> `chain log: exit=0 status=PASS`; `at` in the future -> age `0s`. Plus: the template map is an exhaustive
`Record<EvidenceFact, ...>` (a missing fact is a compile error) and no output contains a character outside printable ASCII except
characters copied from `v`.

| State | Meaning (positive evidence required) | Is NOT |
|---|---|---|
| `working` | a turn is in progress: model generating or a tool started less than `activeSeconds` ago | proof of progress beyond the evidence time |
| `running` | the session is active but the turn structure is unknown (registry `busy`, or the transcript file written within `activeSeconds` without turn records) | "working" with known turn |
| `waiting_input` | positive evidence that a human is expected: open PermissionRequest, blocking Notification, registry `waiting`/`idle`, idle_prompt, or SessionStart with no prompt yet | a guess from silence |
| `waiting_tool` | a tool call has been open between `activeSeconds` and `pendingToolGraceSeconds` | failure |
| `waiting_agent` | the main turn waits on a foreground subagent, or the turn ended with background agents/workflows outstanding | completion |
| `turn_ended` | the last turn ended (Stop, StopFailure, end_turn, interrupt) and nothing above applies; finished or waiting cannot be told | `completed` (Stop is not SessionEnd) |
| `completed` | SessionEnd observed (not after a StopFailure), daemon job `done`, or attempts row COMPLETED | task success (only an attempts row says that) |
| `failed` | attempts row FAILED, daemon job failure state, or SessionEnd whose last turn ended by StopFailure / an unrecovered API error | a tool error, a failed poll |
| `stale` | needs investigation: in-turn silence (`silent`), resting silence beyond `abandonedAfterSeconds` (`abandoned`), Claude Code process gone without SessionEnd (`process_gone`), agent whose parent ended first (`parent_ended`) | a verified current state |
| `unknown` | evidence contradicts or is insufficient (tool open beyond grace, no records, unclassified attempt status) | a failure |

### 7.2 Facts and merges (`facts.ts`, `merge.ts`)

Registers: `Max<Stamp>` (join = greater by `compareStamp`), `Min<number>`, `LWW<T>` = `{ stamp, value }` (join = greater stamp;
equal stamps tie-break on `JSON.stringify(value)` so the join stays deterministic), `Or` (boolean or), `GMap<K, R>` (pointwise join).

```ts
export interface SessionFacts {
  v: 1;
  firstSeenAt: number | null;                           // Min over all stamps and file first timestamp
  lastHookAt: number | null;                            // Max received_at over envelopes of this session
  hasRecords: boolean;                                  // Or: at least one valid conversational record in the own file
  transcriptMtime: number | null;                       // Max observed mtime of the own file
  lastActivity: Stamp | null;                           // Max over activity events of the session (both sources, main agent)
  lastPromptHook: Stamp | null; lastPromptTx: Stamp | null;                   // Max of turn.prompt per source (main agent)
  lastTurnEndHook: LWW<TurnEndInfo> | null; lastTurnEndTx: LWW<TurnEndInfo> | null;   // Max-stamp turn.end per source
  lastInterrupt: Stamp | null;                          // Max interrupt (transcript)
  starts: Partial<Record<'startup' | 'resume' | 'clear' | 'compact' | 'fork' | 'other', Stamp>>;   // pointwise Max
  end: { stamp: Stamp; reason: string } | null;         // LWW by stamp (the later SessionEnd)
  permissions: Record<string /* inputHash */, { requested: Stamp | null; resolved: Stamp | null }>;   // pointwise Max; <= 64 newest by requested
  notifications: Record<string /* type */, Stamp>;      // pointwise Max
  lastApiError: Stamp | null; lastAssistantOk: Stamp | null;   // Max (main agent)
  claudePid: LWW<number> | null;                        // stamp = received_at
  pid: LWW<{ pid: number; alive: boolean }> | null;     // stamp.at = checkedAt
  registry: LWW<{ status: 'busy' | 'idle' | 'waiting'; waitingFor: string | null; pid: number; pidAlive: boolean }> | null;
  job: LWW<{ jobId: string; state: string }> | null;
  attempt: LWW<{ state: 'COMPLETED' | 'FAILED' | 'UNKNOWN'; evidence: string; rowKey: string; endedAt: number } | null> | null;
                                                        // value null = retracted by external.attempt_cleared (I-18); stamp = {at: observedAt, rank: 1 attempt | 0 cleared, tie: rowKey | ''}
  costStateTrailing: LWW<boolean> | null;               // stamp.at = byte offset of the cost-state record (file order)
  hookHandlerErrors: Max<number>;                        // max count reported per file scan (monotone per file)
  legacy: { lastStop: LWW<string> | null; fileFirstTs: string | null; fileMaxTs: string | null };   // 6.5 / 7.9 parity inputs
}
export interface TurnEndInfo { kind: 'stop' | 'stop_failure' | 'end_turn' | 'turn_duration'; promptId: string | null; error: string | null;
  backgroundTasks: number | null; pendingBackgroundAgents: number | null; pendingWorkflows: number | null }
export interface AgentFacts {
  v: 1; kind: 'subagent' | 'workflow_agent' | 'internal';
  started: Stamp | null; stopped: Stamp | null; final: Stamp | null;        // Max: SubagentStart, SubagentStop, agent.final
  notification: LWW<'completed' | 'failed' | 'killed' | 'stopped'> | null;  // task-notification matched by spawn tool_use_id
  link: LWW<string> | null;                             // PostToolUse(Agent) / toolUseResult status: 'completed' | 'async_launched' | other
  journal: 'started' | 'result' | 'failed' | null;      // join: started < result, started < failed, result vs failed -> failed
  lastActivity: Stamp | null; fileMtime: number | null; hasRecords: boolean;
  lastTurnEnd: LWW<TurnEndInfo> | null; lastPrompt: Stamp | null;
  lastApiError: Stamp | null; lastAssistantOk: Stamp | null;
  legacy: { lastStop: LWW<string> | null };
}
export interface WorkflowFacts {
  v: 1; launched: Stamp | null; fileStatus: LWW<string> | null;     // workflows/<runId>.json status; stamp.at = observedAt
  started: number; results: number; failed: number;                 // Max of journal counters
  agentCount: number | null; lastAgentActivity: number | null;      // Max
}
```

Related rows used by `derive` (also semilattice rows, 4.1): `tool_call` (per `tool_use_id`: Min start, Max end, outcome
precedence), `turn` (per `prompt_id`), the derived views of the session's agents and workflow runs.

### 7.3 Fact update table (event -> join)

| Logical event | Session facts | Rows / other facts |
|---|---|---|
| `session.seen` | `firstSeenAt` Min; `claudePid` LWW (when present) | session upsert (cwd, entrypoint, version) |
| `session.start` | `starts[source]` Max | - |
| `session.end` | `end` LWW | - |
| `turn.prompt` (main) | `lastPromptHook` or `lastPromptTx` Max; `lastActivity` Max | `turn` upsert (`started_at` Min) |
| `turn.end` (main) | `lastTurnEndHook` / `lastTurnEndTx` LWW (`turn_duration` merges its pending counts into the Tx register when its stamp is the max) | `turn` upsert (`ended_at` Max, `end_kind` LWW) |
| `interrupt` (main) | `lastInterrupt` Max | `turn` `end_kind` = `interrupted` LWW |
| `tool.start` / `tool.end` / `tool.batch` | `lastActivity` Max (start/end/batch); permissions: for each ended or batched tool whose `input_hash` has a request, `resolved` Max | `tool_call` upsert; `tool.batch` sets `batch_at` (Max) on every listed call |
| `permission.request` | `permissions[hash].requested` Max | - |
| `notification` | `notifications[type]` Max | - |
| `activity` (main) | `lastActivity` Max; `hasRecords` Or (transcript only) | - |
| `api_error` / `assistant.ok` (main) | `lastApiError` / `lastAssistantOk` Max | - |
| `agent.start` / `agent.stop` / `agent.final` | - | agent facts `started` / `stopped` / `final` Max; `agent.stop` path is a discovery hint |
| `agent.link` | - | agent `link` LWW; `agent.spawn_tool_use_id` set; tool row `subagent` link |
| `agent.notification` | - | agent (found through `spawn_tool_use_id` = notification `tool-use-id`) `notification` LWW |
| `agent.meta` | - | agent row columns (first non-null) |
| `activity` / `turn.*` with `agentId` | - | agent `lastActivity`, `lastPrompt`, `lastTurnEnd` |
| `workflow.launch` / `workflow.status` | - | workflow facts (`launched` Max, `fileStatus` LWW, counters Max) |
| `external.registry` / `external.job` / `external.attempt` / `external.pid` | `registry` / `job` / `attempt` / `pid` LWW (`attempt` stamp `{at: observedAt, rank: 1, tie: rowKey}`) | - |
| `external.attempt_cleared` | `attempt` LWW with value `null`, stamp `{at: observedAt, rank: 0, tie: ''}` (a later or same-tick `external.attempt` wins; an older one loses) | - |
| `cost_state` | `costStateTrailing` LWW | `cost_state` row |
| `hook.handler_error` | `hookHandlerErrors` Max (count from the importer) | health counter |
| `session.continued_in` / `session.copied_from` | - | session columns + reconciliation |
| `title`, `info`, `compaction` | `lastActivity` Max for `compaction` | session title columns (LWW by order); timeline rows |

### 7.4 Session decision table (`derive-session.ts`; first matching rule wins)

Derived inputs (cfg values in 7.8; `tol = crossSourceToleranceMs`):
- `lastEvidence` = max(`lastHookAt`, `lastActivity.at`, `transcriptMtime`, max over agents of (`lastActivity.at`, `fileMtime`), workflows' `lastAgentActivity`); `quiet = now - lastEvidence`.
- `hookPath` = `lastPromptHook != null` AND max(`lastPromptHook`, `lastTurnEndHook`) >= max(`lastPromptTx`, `lastTurnEndTx`) - `tol` (hooks know the latest turn boundary; otherwise transcript turn boundaries are used).
- `P` = hookPath ? `lastPromptHook` : `lastPromptTx`; `E0` = hookPath ? `lastTurnEndHook` : `lastTurnEndTx`; `E` = the later of `E0` and `lastInterrupt` (kind `interrupted`), because Claude Code fires no Stop on a user interrupt (HK:1).
- `inTurn` = `P != null` AND (`E == null` OR `P > E`).
- `openTools` = `tool_call` rows of the main agent with `ended_at` and `batch_at` null and `started >= P.at - tol` (only when `inTurn`; a turn end closes the calls of its turn implicitly, without writing the row).
- `openPermission` = exists `permissions[h]` with `requested >= P.at - tol` and (`resolved == null` OR `resolved < requested`), only when `inTurn`.
- `blockingNotif` = the newest of `notifications[permission_prompt | elicitation_dialog | elicitation_url_dialog | agent_needs_input]` with stamp > `lastActivity`.
- `registryLive` = `registry` present AND `registry.pidAlive` AND `now - registry.stamp.at <= 2 * registryPollMs`.
- `pidDead` = `pid?.value.alive === false`; `pidAlive` = `pid?.value.alive === true` (medium trust: pids are reused on Windows).
- `childrenActive` = number of the session's agents in `working | waiting_tool | running` plus workflow runs in `running`.
- `pendingAtEnd` = from the turn end(s) whose stamp >= `P`: max(`backgroundTasks`, `pendingBackgroundAgents + pendingWorkflows`), 0 if none.
- `unrecoveredApiError` = `lastApiError != null` AND (`lastAssistantOk == null` OR `lastApiError > lastAssistantOk`).
- `reopened` = `end != null` AND `lastActivity != null` AND `lastActivity.at > end.stamp.at + reopenToleranceMs` (writes reconciliation `activity_after_end` once); `ended` = `end != null` AND NOT `reopened`.

| Rule | Condition | State | Presence | Basis / confidence | Evidence (first items) |
|---|---|---|---|---|---|
| S-1 | `attempt?.value != null` (a register holding `null` after `external.attempt_cleared` is "no evidence") | `COMPLETED` -> `completed`, `FAILED` -> `failed`, `UNKNOWN` -> `unknown` | `ended` | observed / high | `attempts:attempt_row` (`at` = `endedAt`, value = legacy evidence text) |
| S-2 | `lastHookAt == null` AND NOT `hasRecords` | `unknown` | `unknown` | inferred / low | `transcript:no_records` |
| S-3a | `ended` AND (`E.kind == 'stop_failure'` OR `unrecoveredApiError`) | `failed`, `endReason` = reason | `ended` | observed / medium | `hook:session_end`, `hook:stop_failure` or `transcript:api_error` |
| S-3b | `ended` | `completed`, `endReason` = reason | `ended` | observed / high | `hook:session_end` |
| S-4a | `job.state === 'done'` | `completed` | `ended` | observed / high | `job:job_state` |
| S-4b | `job.state` in (`failed`, `error`, `killed`, `cancelled`) (values UNVERIFIED, only `working`/`done` observed) | `failed` | `ended` | observed / high | `job:job_state` |
| S-5 | `pidDead` AND `quiet >= processGoneGraceSeconds` | `stale`, `process_gone` | `ended` | inferred / high | `pid:pid_dead`, `clock:quiet` |
| S-6a | `inTurn` AND `openPermission` | `waiting_input`, `permission` | `open` | observed / high | `hook:permission_request` |
| S-6b | `registryLive` AND status `waiting` | `waiting_input`, `permission` if `waitingFor` contains `permission` else `user` | `open` | observed / high | `registry:registry_status` |
| S-6c | `blockingNotif` AND (`inTurn` OR `E == null` OR `blockingNotif > E`) | `waiting_input`, `permission` / `elicitation` / `agent_input` by type | `open` | observed / high | `hook:notification` |
| S-7a | `inTurn`, oldest open tool `O` is `Agent` (or `Task`) and its link status is not `async_launched` | `waiting_agent` | `open` | observed / high | `hook\|transcript:tool_open`, `child_active` |
| S-7b | `inTurn`, `O` exists, `now - O.start < activeSeconds` | `working` | `open` | observed / high | `tool_open` (value = tool name) |
| S-7c | `inTurn`, `O` exists, `now - O.start < pendingToolGraceSeconds` | `waiting_tool` | `open` | observed / high | `tool_open` |
| S-7d | `inTurn`, `O` exists | `unknown` (legacy 6b) | `unknown` | inferred / low | `tool_open` (count, age) |
| S-7e | `inTurn`, no open tool, `quiet < staleAfterSeconds` | `working` | `open` | hookPath ? observed / high : inferred / medium | `prompt`, `clock:quiet` |
| S-7f | `inTurn` | `stale`, `silent` | `unknown` | inferred / pidAlive ? low : medium | `prompt`, `clock:quiet`, `pid:*` if known |
| S-8a | NOT `inTurn`, `E != null`, (`childrenActive > 0` OR (`pendingAtEnd > 0` AND `quiet < staleAfterSeconds`)) | `waiting_agent` | `open` | observed / high (inferred / medium when only file activity shows the children) | `background_pending` (count) or `child_active` |
| S-8b | NOT `inTurn`, `E != null`, `registryLive`, status `idle` | `waiting_input`, `user` | `open` | observed / high | `registry:registry_status` |
| S-8c | NOT `inTurn`, `E != null`, `notifications.idle_prompt > E` | `waiting_input`, `idle_prompt` | `open` | observed / high | `hook:notification` |
| S-8d | NOT `inTurn`, `E != null`, `quiet >= abandonedAfterSeconds`, NOT `pidAlive`, NOT `registryLive` | `stale`, `abandoned` | `unknown` | inferred / medium | `clock:quiet`, last turn end |
| S-8e | NOT `inTurn`, `E != null` | `turn_ended`, `turnOutcome` = `error` for `stop_failure`, `interrupted` for interrupts, else `ok` | `open` (`ended` with inferred basis when `costStateTrailing` and no live pid/registry, see CHALLENGES C2) | observed / high | `hook:stop` or `transcript:end_turn` / `interrupt` |
| S-8f | `P == null`, any `starts` other than `compact` | `waiting_input`, `user` | `open` | observed / medium | `hook:session_start` |
| S-9a | `registryLive` AND status `busy` | `running` | `open` | observed / high | `registry:registry_status` |
| S-9b | `transcriptMtime != null` AND `now - transcriptMtime < activeSeconds` | `running` | `open` | inferred / medium | `transcript:file_written` |
| S-9c | `childrenActive > 0` | `waiting_agent` | `open` | inferred / medium | `child_active` |
| S-10 | otherwise | `unknown` | `unknown` | inferred / low | `clock:quiet`, last stop reason |

`since` = the `at` of the first evidence item. A rule that needs `now` contributes to `nextCheckAt` (7.8).

### 7.5 Agent decision table (`derive-agent.ts`)

Inputs: `AgentFacts`, the parent session view, the agent's open tool rows (`agent_id` = this agent), cfg.
`episodeEnd` = max(`stopped`, `final`, `notification.stamp`); `reopened` = `started > episodeEnd + tol` (SubagentStart also
fires when an agent is resumed, HK:1). Internal agents (`kind = 'internal'`) are derived but hidden by default.

| Rule | Condition | State | Basis / confidence |
|---|---|---|---|
| A-1 | NOT `reopened`, `notification` = `completed` | `completed` | observed / high (transcript task-notification) |
| A-2 | NOT `reopened`, `notification` in (`failed`, `killed`, `stopped`) | `failed`, `endReason` = status | observed / high |
| A-3 | NOT `reopened`, `journal` = `failed` | `failed` | observed / high (workflow journal) |
| A-4 | NOT `reopened`, `journal` = `result` OR `final != null` OR `stopped != null` OR `link` = `completed` | `completed` | observed / high |
| A-5 | open tool rows exist (oldest `O`) | `working` / `waiting_tool` / `unknown` by the S-7b..S-7d thresholds | observed / high (low for unknown) |
| A-6 | `max(lastActivity.at, fileMtime) > now - subagentActiveSeconds` OR (`started` and NOT `episodeEnd` and `quiet < staleAfterSeconds`) | `working` | observed (hook start) or inferred (file) / medium |
| A-7 | parent `presence = 'ended'` | `stale`, `parent_ended` | inferred / medium |
| A-8 | `lastTurnEnd.kind` in (`end_turn`, `stop_sequence`) AND quiet >= `subagentActiveSeconds` | `completed` (legacy agent override, CS:C.1) | inferred / medium |
| A-9 | `quiet >= staleAfterSeconds` | `stale`, `silent` | inferred / medium |
| A-10 | otherwise | `unknown` | inferred / low |

A subagent never changes its parent's `completed`/`failed`; it only feeds `childrenActive` (S-7a, S-8a, S-9c). Test P8.

### 7.6 Workflow run decision table (`derive-workflow.ts`)

| Rule | Condition | State | Basis |
|---|---|---|---|
| W-1 | `fileStatus` = `completed` | `completed` | observed (workflow file) / high |
| W-2 | `fileStatus` in (`failed`, `error`, `cancelled`, `killed`) | `failed` | observed / high |
| W-3 | `fileStatus` other non-null value | `unknown` (value shown) | observed / low |
| W-4 | any agent of the run in `working \| waiting_tool` OR `lastAgentActivity > now - subagentActiveSeconds` | `running` | observed / high |
| W-5 | parent session `presence = 'ended'` | `stale`, `parent_ended` | inferred / medium |
| W-6 | `max(launched.at, lastAgentActivity) > now - staleAfterSeconds` | `running` | inferred / medium |
| W-7 | otherwise | `stale`, `silent` | inferred / medium |

The finished-run file is written only for finished runs (TS:6.2), so a run without it is never `completed`.

### 7.7 Transition table (derived from 7.3 + 7.4; each row is a table test in `engine/src/lifecycle/transitions.test.ts`)

Notation: prior state, then input (hook name or transcript fact), then expected state and deciding rule. Timings use cfg
defaults. Every row is run in two delivery orders: as listed and with the input arriving before its predecessor (stamps
unchanged); both must give the listed result unless the row is explicitly about arrival order.

| Id | Category | Prior | Input | Expected | Rule |
|---|---|---|---|---|---|
| N1 | normal | none | SessionStart(startup) | `waiting_input`/`user` | S-8f |
| N2 | normal | N1 | UserPromptSubmit | `working` | S-7e |
| N3 | normal | `working` | PreToolUse(Bash) | `working` | S-7b |
| N4 | normal | N3 | 3 min pass | `waiting_tool` | S-7c |
| N5 | normal | N4 | PostToolUse | `working` | S-7e |
| N6 | normal | `working` | PreToolUse(Agent, foreground) | `waiting_agent` | S-7a |
| N7 | normal | N6 | SubagentStart, SubagentStop, PostToolUse(Agent, status completed) | `working`; agent `completed` | S-7e, A-4 |
| N8 | normal | `working` | Stop | `turn_ended` (`ok`) | S-8e |
| N9 | normal | N8 | SessionEnd(other) | `completed` | S-3b |
| N10 | normal | N8 (interactive) | Notification(idle_prompt) | `waiting_input`/`idle_prompt` | S-8c |
| N11 | normal | `working` | PermissionRequest | `waiting_input`/`permission` | S-6a |
| N12 | normal | N11 | PostToolUse of the same input hash | `working` | S-7e |
| N13 | normal | `working` | Stop with `background_tasks` count 2 | `waiting_agent` | S-8a |
| N14 | normal | N13 | UserPromptSubmit (background report turn), then Stop with 0 | `working`, then `turn_ended` | S-7e, S-8e |
| N15 | normal | `working` | PreCompact, PostCompact, SessionStart(compact) | `working` | S-7e |
| N16 | normal | transcript only, last record assistant `end_turn`, quiet 5 min | - | `turn_ended`; legacy `IDLE` | S-8e |
| F1 | failed | `working` | StopFailure(rate_limit) | `turn_ended` (`error`) | S-8e |
| F2 | failed | F1 | SessionEnd | `failed` | S-3a |
| F3 | failed | any | attempts row with exit 1 | `failed` | S-1 |
| F4 | failed | `working` | PostToolUseFailure(Exit code 2) | `working` (a tool error is not a session failure) | S-7e |
| F5 | failed | transcript `isApiErrorMessage` as last assistant record, then SessionEnd | - | `failed` | S-3a |
| F6 | failed | `turn_ended` | job `state: done` | `completed` | S-4a |
| D1 | duplicated | `working` | Stop twice (same bytes, 20 ms apart) | `turn_ended`; one `events` row | D-3, S-8e |
| D2 | duplicated | `completed` | SessionEnd again (duplicate) | `completed`; no change published | S-3b |
| D3 | duplicated | `working` | PreToolUse twice, same `tool_use_id` (plugin copy) | one `tool_call`, `working` | D-2 |
| D4 | duplicated | N7 | SubagentStop twice | agent `completed`; unchanged | A-4 |
| D5 | duplicated | any | whole spool replayed | identical views | D-1 |
| M1 | missing | `working`, no further events, pid unknown | 30 min pass | `stale`/`silent` | S-7f |
| M2 | missing | `turn_ended`, no SessionEnd | `pid` check: dead, 30 s later | `stale`/`process_gone` (never `completed`) | S-5 |
| M3 | missing | `turn_ended`, pid unknown | 24 h pass | `stale`/`abandoned` | S-8d |
| M4 | missing | `working` | transcript `tool_use` with no PreToolUse hook (hook lost) | `working` then `waiting_tool` after 2 min | S-7b, S-7c |
| M5 | missing | hooks installed mid-session: no UserPromptSubmit hook for the current turn; transcript prompt present | - | transcript path: `working` (inferred) | S-7e |
| M6 | missing | hooks not installed at all | transcript fixtures of the legacy suite | new state per 7.4, legacy projection equals Python | 7.9 |
| M7 | missing | `working` | transcript interrupt marker, no Stop hook | `turn_ended` (`interrupted`) | S-8e |
| L1 | delayed | `completed` | a PostToolUse whose stamp is before SessionEnd arrives later | `completed` | S-3b, P4 |
| L2 | delayed | N8 | async PostToolUse stamped 30 ms after Stop (jitter) | `turn_ended` | S-8e (`hookPath` uses prompt/stop only) |
| L3 | delayed | server down for 10 min during N2..N9 | spool drained at start | final `completed`, same views as live; reconciliation `runtime_unavailable` | P2 |
| L4 | delayed | N3 | SessionEnd delivered before Stop (arrival), stamps ordered | `completed` | S-3b |
| O1 | out of order | `working` | PostToolUse arrives before its PreToolUse | `tool_call` closed; `working` | S-7e |
| O2 | out of order | N6 | SubagentStop arrives before SubagentStart | agent `completed` | A-4 |
| O3 | out of order | N2 | Stop arrives before UserPromptSubmit of the same turn | `turn_ended` | S-8e |
| O4 | out of order | `completed` | UserPromptSubmit stamped 10 s after SessionEnd (genuinely later) | reconciliation `activity_after_end`; `working` (explicit reopen) | S-7e |
| O5 | out of order | agent `completed` | SubagentStart again (resume) | agent `working` (episode 2) | A-6 |
| O6 | out of order | any | backfill of old transcript records after the tail was read | unchanged | P2 |
| C1 | cleared | `completed` by S-1 (attempts row COMPLETED), last turn ended by Stop, no SessionEnd | `external.attempt_cleared` (chain-log config rebuild, no matching row afterwards) | re-derived without S-1: `turn_ended` (`ok`) | S-8e |
| C2 | cleared | C1 prior | `external.attempt_cleared` then, in the same tick (equal `observedAt`), `external.attempt` FAILED for a re-matched row | `failed` (the same-tick republish wins by rank) | S-1 |
| C3 | cleared | C1 result (`turn_ended`) | an `external.attempt` delivered late whose `observedAt` is older than the clear | `turn_ended` (the stale evidence loses) | S-8e |

### 7.8 Thresholds, sweeper and `nextCheckAt`

| Config key (`runtime.json`, config designer owns schema) | Default | Source |
|---|---|---|
| `lifecycle.activeSeconds` | `active_seconds` (120) | legacy key (config.json) |
| `lifecycle.pendingToolGraceSeconds` | `pending_tool_grace_seconds` (900) | legacy key |
| `lifecycle.subagentActiveSeconds` | 60 | legacy constant |
| `lifecycle.staleAfterSeconds` | 1800 | new: long API calls with extended thinking stay below it; tools have their own grace |
| `lifecycle.abandonedAfterSeconds` | 86400 | new: interactive sessions left open overnight are normal |
| `lifecycle.processGoneGraceSeconds` | 30 | new: lets a SessionEnd still in the spool arrive first |
| `lifecycle.crossSourceToleranceMs` | 2000 | new |
| `lifecycle.reopenToleranceMs` | 2000 | new |
| `lifecycle.sweepIntervalMs` | 5000 | new |
| `lifecycle.pidCheckIntervalMs` | 10000 | new |
| `lifecycle.registryPollMs` | 5000 | new |
| `lifecycle.jobsPollMs` | 15000 | new |

`nextCheckAt(view, input, cfg)` = the smallest future time at which a rule input crosses a threshold, or null:
open tool `O` -> `O.start + activeSeconds`, `O.start + pendingToolGraceSeconds`; in turn without tools -> `lastEvidence + staleAfterSeconds`;
`waiting_agent` -> `lastEvidence + staleAfterSeconds`; resting states -> `lastEvidence + abandonedAfterSeconds`; `running` from
the file -> `transcriptMtime + activeSeconds`; agents -> `lastActivity + subagentActiveSeconds`, `+ staleAfterSeconds`;
`claudePid` known and presence `open` -> `now + pidCheckIntervalMs`; `pidDead` -> `lastEvidence + processGoneGraceSeconds`;
`completed`, `failed`, `stale/process_gone` -> null.

`LifecycleSweeper.tick()` (every `sweepIntervalMs`): (1) for sessions with a known `claudePid`, presence `open`, and
`next_check_at <= now`: `process.kill(pid, 0)` (ESRCH -> dead, EPERM -> alive; E7: about 4 us) -> `external.pid` events;
(2) select up to 200 rows per entity type with `next_check_at <= now`; (3) submit `derive` items to the writer, which
re-derives inside its transaction. `viewChanged(a, b)` compares `state, presence, waitReason, staleKind, endReason,
turnOutcome, basis, confidence, ruleId`; only then is a change recorded and published. Evidence wording is rendered at read
time from `at` values (`renderEvidence`, 7.1.1), so time passing alone never creates churn. `viewChanged` is exported from
`rules.ts` (7.1).

### 7.9 Mapping to the legacy five states (`legacy.ts`)

1. Sessions with NO hook evidence (`lastHookAt == null`): `classifyLegacy(input, now)` is a line-by-line port of
   `classify_state` (CS:C.1, rule order 1-9, evidence strings byte-identical, Python `%d` truncation and `//` floor reproduced)
   with inputs: `external` = the `attempt` fact's value (legacy `external_state` table; `null` or absent = no external entry), `has_records` = `hasRecords`, `mtime` =
   `transcriptMtime`, `registry` = `registry` restricted to `busy|idle` with live pid, `last_stop` = `legacy.lastStop`,
   `pending`/`oldest_pending_ts` = `tool_call` rows with the `transcript_use` bit and without `transcript_result`, agent mtimes,
   `active_seconds`, `pending_tool_grace_seconds`. Agents add the override `IDLE` + end stop -> `COMPLETED` with the legacy text.
   This path is the parity oracle target (T-LF-51).
2. Sessions with hook evidence, through the exported `toLegacy(view)` (7.1): `running | working | waiting_agent | waiting_tool` -> `RUNNING`; `waiting_input | turn_ended` -> `IDLE`;
   `completed` -> `COMPLETED`; `failed` -> `FAILED`; `stale | unknown` -> `UNKNOWN`. Evidence = the rendered new evidence;
   source `hook` (a new source value; legacy readers display it as text).
3. `legacyDone(session)` (v1 `done`) = `age >= active_seconds` AND legacy stop in (`end_turn`, `stop_sequence`) AND no agent written
   within 60 s; agents: `aage >= 60` AND stop in END_STOPS (CS:C.1).

### 7.10 External evidence (`engine/src/external/`)

| Source | Reader | Cadence | Validation and privacy | Event |
|---|---|---|---|---|
| Claude registry `<claudeHome>/sessions/*.json` | `registry.ts` | `registryPollMs` | glob `*.json` only (never `.key`), <= 64 KiB; `sessionId` must match `SID_RE` and be known to this instance; `status` in `busy\|idle\|waiting`; `waitingFor` clipped 64; pid liveness via `process.kill(pid, 0)` | `external.registry` when the value changes or every 60 s |
| Daemon jobs `<claudeHome>/jobs/<id>/state.json` | `jobs.ts` | `jobsPollMs` | `readdir(jobs)` one level, then only `<id>/state.json` (never walk the 6,000+ temp files, TS:6.3); match `sessionId` or `resumeSessionId` | `external.job` on change |
| Claude Code pid (E7) | sweeper | `pidCheckIntervalMs` | pid from envelopes `claude_pid`; dead is trusted (high), alive is medium (pid reuse) | `external.pid` |
| Attempts (06 3.10, rows in 03's `attempt_runs` / `attempt_sources`, I-07) | 06 `PanelService.tickAttempts` | on chain-log change | rows with a matched session and `end_reason = 'ended'` -> legacy `external_state`; a config rebuild retracts | `external.attempt`, `external.attempt_cleared` (4.3) |

### 7.11 Work items for the board (D14, brief 8.6; `work-items.ts`)

Inputs: sessions (label, matched, ruleIndex, view), attempts rows (03 `attempt_runs`: `part`, `started_at`, `end_reason`, `state`,
`session_id`), and `runtime.json` `board.items` declarations
(`{ key: string; title: string; match: { labels?: string[]; labelPrefix?: string; sessionIds?: string[]; attemptParts?: string[] } }[]`,
schema owned by the config designer). Each session belongs to at most one work item; first matching rule wins:

1. W-DECL: declared items in declaration order (`sessionIds`, then exact `labels`, then `labelPrefix`, then `attemptParts` through matched rows).
2. W-ATT: attempts rows grouped by `part` -> key `attempt:<part>`, title `<label_prefix><part>`; members = sessions matched to that part's rows.
3. W-LBL: matched sessions grouped by exact label -> key `label:<label>`.
4. Unmatched sessions belong to no work item (they appear only in the explorer). A session is never a work item by itself unless its label group has one member.

Board state of an item (first match):

| Order | Condition | Board state |
|---|---|---|
| 1 | attempt item whose latest row (by start) has ended | `completed` / `failed` / `unknown` from that row |
| 2 | any member `working \| running \| waiting_tool \| waiting_agent` | `working` |
| 3 | any member `waiting_input` | `waiting` |
| 4 | the most recently started member is `completed` / `failed` | `completed` / `failed` |
| 5 | any member `stale` | `stale` (needs investigation) |
| 6 | all non-terminal members `turn_ended` | `waiting` (finished or waiting cannot be told) |
| 7 | otherwise | `unknown` |

Each item carries `evidence: { sessionId, state, ruleId }[]` and the matching rule (`W-DECL|W-ATT|W-LBL`) so the board can explain
why it sits in a column.

### 7.12 Tests that prove it (lifecycle)

Seeded generator `engine/test/support/prng.ts` (mulberry32, no new dependency); each property runs 500 cases per scenario template
(templates: `-p` run, interactive turn pair, foreground subagent, background subagents, workflow, interrupt, StopFailure, crash)
with random noise (duplicates, delays up to 60 s, drops of non-terminal events), seed printed on failure.

| Id | Property / test |
|---|---|
| P1 | Idempotence: `merge(f, f) == f`; applying any event twice equals applying it once (facts and rows) |
| P2 | Order independence: any permutation of an event multiset gives identical facts, rows and `derive(..., now)` |
| P3 | Duplicate invariance: adding duplicates (same stamps) changes nothing |
| P4 | Terminal non-regression: with SessionEnd at T, adding events stamped <= T + `reopenToleranceMs` never moves `completed`/`failed` |
| P5 | Missing never succeeds: no SessionEnd, job `done` or attempts row -> session state is never `completed`; never `failed` without StopFailure/API error + SessionEnd, job failure or attempts row |
| P6 | Time monotonicity: for fixed facts, `derive(t2)` never leaves `stale` back to `working` for `t2 > t1` |
| P7 | `nextCheckAt` soundness: `derive(t)` equals `derive(evaluatedAt)` for 50 sampled `t` in `[evaluatedAt, nextCheckAt)` |
| P8 | Subagent isolation: adding agent stop/notification/journal events never changes a session to `completed`/`failed` |
| P9 | Stop is not SessionEnd: folds with Stop and without SessionEnd/job/attempt never yield `completed` |
| T-LF-01..48 | every row of 7.7 (47 rows: N1-N16, F1-F6, D1-D5, M1-M7, L1-L4, O1-O6, C1-C3; both delivery orders); T-LF-48 asserts that every row ran in both orders |
| T-LF-49 | agent table A-1..A-10 and workflow table W-1..W-7 rows |
| T-LF-50 | `viewChanged` + sweeper: 1,000 sessions, only rows past `next_check_at` are evaluated; an unchanged view publishes nothing |
| T-LF-51 | legacy parity: `classifyLegacy` equals the Python `classify_state` golden outputs (CS:C.1 cases + `tests/test_state_config_tasks.py` StateTest inputs + generated boundary cases at `age = active_seconds +- 1`, `waited = grace +- 1`, `age = 59/60/61 min`) |
| T-LF-52 | work items: fixtures for W-DECL, W-ATT (retry: attempt 1 failed, attempt 2 running -> `working`), W-LBL, unmatched excluded |
| T-LF-53 | external: registry `.key` never opened (fs spy), unknown session ids ignored, dead pid via a spawned-and-exited child process |
| T-LF-55 | attempts retraction: rows C1-C3 of 7.7 plus the property "clear then republish of the same evidence in one tick leaves the view unchanged and publishes no change" |
| T-LF-56 | `renderEvidence` golden table of 7.1.1 (`rules.test.ts`), `toLegacy` table of 7.9 item 2, `viewChanged` field list (one case per field) |
| T-LF-57 | completion evidence: the table of 7.13 (`completion.test.ts`) |


### 7.13 Completion evidence (`completion.ts`; brief 8.9 "verifying task completion evidence", I-08)

Consumers: 01 `verify-completion` through `InstanceReader.explainCompletion(t)`; 03 adds `explainCompletion(ctx, t)` to
`EngineQueries` (12.1), implemented by calling the function below with a `CompletionLookup` built over its repositories; `ApiReader`
reaches it through a 03 route and `DbReader` in process, so both return the same JSON. There is no `null` path: the function
throws `CompletionTargetError`; 03 maps `target_invalid` -> 400 `validation_failed` and `target_not_found` -> 404
`completion_target_not_found`, 01 maps them to `USAGE` (exit 2) and `NOT_FOUND` (exit 1). 03's `CompletionEvidenceSchema` carries
every field below, including `sessionId: string | null`, `resolvedBy` and `candidates` (I-08, C16).

```ts
// engine/src/lifecycle/completion.ts
export type CompletionTarget = { sessionId: string } | { label: string } | { attemptPart: string };
export interface CompletionEvidence {
  outcome: 'completed' | 'failed' | 'not_terminal';
  state: LifecycleState; basis: Basis; confidence: Confidence;
  evidence: ApiEvidenceItem[];               // toApiEvidence(item, now) of the deciding view (03 5.5 { kind, at, text }), <= 8
  sessionId: string | null;                  // the session that decided; null only for an attempt row without a matched session
  ruleId: string;                            // the lifecycle rule (S-1 .. S-10) or C-ATT-* below
  resolvedBy: 'session_id' | 'label' | 'attempt_part';
  candidates: number;                        // sessions (label) or rows (attempt part) that matched the target
}
export interface CompletionCandidate { sessionId: string; label: string; startedAt: number | null; lastActivityAt: number | null; view: LifecycleView }
export interface AttemptRowRef {             // projection of 03 attempt_runs (06 3.10)
  id: number; part: string; startedAt: number; endedAt: number | null; endReason: 'open' | 'ended' | 'superseded';
  state: 'COMPLETED' | 'FAILED' | 'RUNNING' | 'UNKNOWN'; evidence: string; sessionId: string | null;
}
export interface CompletionLookup {
  sessionById(sessionId: string): CompletionCandidate | null;
  sessionsByLabel(label: string): CompletionCandidate[];        // exact, case-sensitive label equality
  attemptRowsByPart(part: string): AttemptRowRef[];             // every generation
}
export class CompletionTargetError extends Error { constructor(readonly code: 'target_invalid' | 'target_not_found', readonly target: CompletionTarget) }
export function explainCompletion(lookup: CompletionLookup, target: CompletionTarget, now: number): CompletionEvidence;
```

Algorithm (numbered, normative):
1. Validate: `sessionId` must match `SID_RE`; `label` 1..200 chars; `attemptPart` 0..512 chars (= the `attempt_runs.part` cap of 03 3.5
   and 03 6.1's route bound; the empty part is legal: legacy attempts without a `part` group; C17). Otherwise throw `target_invalid` (01 maps it to `USAGE`, exit 2).
2. `{sessionId}`: `c = lookup.sessionById(id)`; null -> throw `target_not_found` (01: `NOT_FOUND`, exit 1). Go to step 5 with `c`,
   `resolvedBy 'session_id'`, `candidates 1`.
3. `{label}`: `cs = lookup.sessionsByLabel(label)`; empty -> `target_not_found`. Choose the most recently started candidate:
   sort by `startedAt` descending (null last), then `lastActivityAt` descending (null last), then `sessionId` ascending; take the first
   (same rule as the board, 7.11 order 4: a retry's newest session decides). Go to step 5, `resolvedBy 'label'`, `candidates
   cs.length`.
4. `{attemptPart}`: `rows = lookup.attemptRowsByPart(part)`; empty -> `target_not_found`. `r` = the row with the greatest
   `(startedAt, id)` (the latest START, 06 3.10.7). `resolvedBy 'attempt_part'`, `candidates rows.length`.
   a. `r.endReason === 'ended'` and `r.sessionId !== null` and `lookup.sessionById(r.sessionId)` is non-null: go to step 5 with that
      session (its `attempt` fact is this row or a later one, so S-1 decides unless a config rebuild retracted it).
   b. `r.endReason === 'ended'`, no matched session: `outcome` = `COMPLETED -> completed`, `FAILED -> failed`, else `not_terminal`;
      `state` = `completed` / `failed` / `unknown`; `basis 'observed'`, `confidence 'high'` (`'low'` for `UNKNOWN`); `ruleId
      'C-ATT-ENDED'`; `sessionId null`; `evidence` = `[toApiEvidence({source: 'attempts', fact: 'attempt_row', at: r.endedAt, value:
      clip(r.evidence, 160)}, now)]`. Return.
   c. `r.endReason === 'open'`: `outcome 'not_terminal'`, `state 'running'`, `basis 'observed'`, `confidence 'medium'`, `ruleId
      'C-ATT-OPEN'`, `sessionId` = `r.sessionId`, evidence = the row item with `at: r.startedAt`. Return.
   d. `r.endReason === 'superseded'`: `outcome 'not_terminal'`, `state 'unknown'`, `basis 'observed'`, `confidence 'low'`, `ruleId
      'C-ATT-SUPERSEDED'`, evidence as in c. Return.
5. From the candidate's stored view (re-derived with `derive(facts, now)` when `view.nextCheckAt !== null && view.nextCheckAt <=
   now`, so a sweeper delay never shows an out-of-date state): `outcome` = `'completed'` iff `view.state === 'completed' &&
   view.basis === 'observed'`; `'failed'` iff `view.state === 'failed' && view.basis === 'observed'`; else `'not_terminal'` (D9:
   an inferred state is never terminal; this guard also holds if CHALLENGE C2 is accepted later). `state`, `basis`, `confidence`,
   `ruleId` copied from the view; `evidence` = `view.evidence.map(e => toApiEvidence(e, now))`.

The function is pure (no clock, no I/O); `now` is passed by the caller.

Tests (`engine/src/lifecycle/completion.test.ts`, slice I-7b; in-memory `CompletionLookup` built from 7.7 fixtures):

| Case | Input | Expected `outcome` / `state` / `ruleId` |
|---|---|---|
| CE-1 | session with attempts row COMPLETED (S-1) | `completed` / `completed` / `S-1` |
| CE-2 | session with attempts row FAILED (S-1, transition F3) | `failed` / `failed` / `S-1` |
| CE-3 | SessionEnd after a normal turn (S-3b, N9) | `completed` / `completed` / `S-3b` |
| CE-4 | StopFailure then SessionEnd (S-3a, F2) | `failed` / `failed` / `S-3a` |
| CE-5 | daemon job `done` (S-4a, F6) | `completed` / `completed` / `S-4a` |
| CE-6 | Stop without SessionEnd (S-8e, N8) | `not_terminal` / `turn_ended` / `S-8e` |
| CE-7 | trailing cost-state, no live pid (S-8e with presence `ended` inferred) | `not_terminal` / `turn_ended` / `S-8e` |
| CE-8 | in-turn working session (S-7e) | `not_terminal` / `working` / `S-7e` |
| CE-9 | stale `process_gone` (S-5, M2) | `not_terminal` / `stale` / `S-5` |
| CE-10 | label shared by two sessions: older completed, newer working | `not_terminal` / `working`, `candidates 2` |
| CE-11 | attempt part: latest row open, older row ended PASS | `not_terminal` / `running` / `C-ATT-OPEN`, `candidates 2` |
| CE-12 | attempt part: latest row ended FAIL, unmatched | `failed` / `failed` / `C-ATT-ENDED`, `sessionId null` |
| CE-13 | attempt part: latest row superseded | `not_terminal` / `unknown` / `C-ATT-SUPERSEDED` |
| CE-14 | attempt part: ended row matched to a session whose evidence was retracted (C1) | `not_terminal` / `turn_ended` / `S-8e` |
| CE-15 | stored view past `nextCheckAt` (working view, 40 min quiet) | re-derived: `not_terminal` / `stale` / `S-7f` |
| CE-16 | invalid session id; unknown label; unknown part | `target_invalid`; `target_not_found`; `target_not_found` |
| CE-17 | every case: rendered `evidence[].text` equals `renderEvidence` at `now`; JSON equal through `ApiReader` and `DbReader` (03 DA-T-CLI-1) | - |

01 T-CLI-08 (`verify-completion` exit codes per `--expect`) runs on the CE-1, CE-4, CE-6 and CE-7 fixtures.

## 8. Reconciliation of hooks and transcripts, and the four-way health model

### 8.1 Reconciliation rules

Identity joins (all exact, no name heuristics; CCAM's name-prefix matching is rejected, CC:5):

| Concept | Hook side | Transcript side | Evidence |
|---|---|---|---|
| session | `session_id` | file stem `<sid>.jsonl`; record `sessionId` (copies under a resumed session keep or rewrite it, so the DIRECTORY decides) | HK:2.1, TS:1, TS:3.5, E7 |
| tool call | `tool_use_id` | `tool_use.id` = `tool_result.tool_use_id` | HK:2.2, TS:4.1 |
| subagent | `agent_id` (SubagentStart/Stop), PostToolUse `tool_response.agentId` | `agent-<id>.jsonl`, record `agentId`, `toolUseResult.agentId`, meta `toolUseId` | HK:8 run2, TS:6.1 |
| turn | `prompt_id` | user record `promptId` | HK:2.1, TS:2.2 |
| workflow run | PostToolUse(Workflow) `tool_response.runId` | `toolUseResult.runId`, `workflows/<runId>.json`, `subagents/workflows/<runId>/` | TS:6.2 |
| permission | `tool_input_hash` (PermissionRequest has no `tool_use_id`) | - | HK:2.2 |

Field responsibility: tokens -> transcripts only; session end, permission prompts, notifications, background task counts at Stop
-> hooks only (plus registry/jobs/attempts/pid); tool calls, turns, agents -> both, merged per row (4.1); turn boundaries ->
`hookPath` rule (7.4); interrupts, API errors, compaction, task-notification outcomes -> transcripts.

Hook coverage (computed by the writer for each touched session after its batch; stored on `session.hook_coverage`):
`firstHookAt` = first envelope of the session. `missingHookTools` = transcript tool calls (bit `transcript_use`) started after
`firstHookAt` without bit `hook_pre`, older than 10 s (async hooks may lag) and not within the last 5 s before a SessionEnd (async
hooks are cancelled at `-p` teardown, HK:3.3). `missingHookTurns` = transcript prompts after `firstHookAt` with no hook
`turn.prompt` within `tol`. `coverage` = `none` (no envelopes), `full` (both 0), `partial` (else; reconciliation `hook_gap
{missingTools, missingTurns, since}` written when the counts change).

Reconciliation kinds (append-only `reconciliation` rows, ids and numbers only): `activity_after_end`, `hook_gap`,
`runtime_unavailable`, `identity_reset`, `copied_records`, `handler_failing` (count of `hook.handler_error` grew).

### 8.2 Four-way health (`health/ingest-health.ts`; served by the API designer as `GET /api/v3/health/ingest`)

The four questions of brief section 5 map to four independent blocks; a connected SSE stream is never evidence of ingestion health.

```ts
export interface IngestHealth {
  evaluatedAt: number;
  provider: { lastActivityAt: number | null; source: 'hook' | 'transcript_mtime' | null; status: 'active' | 'quiet' | 'silent' | 'none' };   // 1. generating
  receiving: {                                                                                                                         // 2. receiving
    hooks: { installed: Array<{ scope: string; settingsPath: string; verifiedAt: number | null; ok: boolean | null }>;
             lastEnvelopeAt: number | null; envelopes1h: number; duplicates1h: number; invalid1h: number;
             handlerErrors: Array<{ code: string; count: number; lastAt: number }>; transcriptHookFailures: number;
             coverage: { full: number; partial: number; none: number };
             status: 'ok' | 'not_installed' | 'idle' | 'gap' | 'failing' };
    spool: { segments: number; bytes: number; bytesBehind: number; oldestPendingReceivedAt: number | null; lastNudgeAt: number | null; lastDrainAt: number | null;
             foreignFiles: number };   // files in data/spool/ not matching SPOOL_SEGMENT_RE (never read, 2.7)
    transcripts: { dir: string | null; dirFound: boolean; filesTracked: number; filesMissing: number; filesUnreadable: number; bytesBehind: number;
                   maxLagMs: number; backfillRemainingBytes: number; lastScanAt: number | null; lastSyncAt: number | null;
                   errors: Record<string, number>; status: 'ok' | 'backfilling' | 'lagging' | 'errors' | 'not_found' };
  };
  persisted: { lastCommitAt: number | null; queueItems: number; queueBytes: number; commitP95Ms: number; failures1h: number;           // 3. persisted
               lastError: { code: string; at: number } | null; status: 'ok' | 'backlog' | 'failing' | 'db_error' };
  display: { headSeq: number; serverTime: number };                                                                                    // 4. inputs for the UI check
  runtime: { startedAt: number; eventLoopDelayP99Ms: number };
  status: 'ok' | 'degraded' | 'down';
  reasons: Array<{ code: string; severity: 'info' | 'warn' | 'error'; since: number }>;
}
```

Computation (every 5 s and after commits, at most 1 change event per second):
1. `provider.lastActivityAt` = max(last envelope `received_at`, newest mtime of tracked in-scope files, newest spool segment mtime).
   It comes from `stat`, so it is independent of parsing. `status`: `active` < `activeSeconds`, `quiet` < `staleAfterSeconds`,
   `silent` beyond, `none` when null.
2. `hooks.status`: `not_installed` when no install manifest entry can fire for this instance (project-local for its repo root or
   user scope) AND no envelope was ever received; `failing` when the handler log has `HANDLER_UNAVAILABLE`, `SPOOL_FULL` or
   `SPOOL_WRITE_FAILED` for this instance in the last hour, or `transcriptHookFailures` grew in the last hour; `gap` when any
   session active in the last hour has `coverage = partial`; `idle` when installed, provider `active`, and no envelope for
   `staleAfterSeconds`; else `ok`.
3. `transcripts.status`: `not_found` when the transcripts dir is null; `errors` when read errors or identity resets happened in
   the last 10 min; `lagging` when `maxLagMs > health.importLagWarnMs` (30000); `backfilling` when `backfillRemainingBytes > 0`;
   else `ok`. `lastSyncAt` = end of the last stat cycle with `bytesBehind == 0` on every tracked file ("last successful transcript sync").
4. `persisted.status`: `db_error` after `SQLITE_FULL`, `SQLITE_IOERR*`, `SQLITE_CORRUPT`, `ENOSPC`; `failing` when the last commit
   failed; `backlog` when `queueItems > 0` or `spool.bytesBehind > 0` for longer than `health.backlogWarnMs` (10000); else `ok`.
5. `display`: `headSeq` (realtime layer) and `serverTime`; the UI compares its last applied seq and snapshot time and shows
   "data may be stale" itself (UI designer, brief 10).
6. Overall: `down` if persisted is `db_error|failing`, or transcripts `not_found` while hooks are `not_installed`; `degraded` if any
   reason has severity `warn` or `error`; else `ok`. `reasons` lists every non-ok block with a code (`HOOKS_FAILING`, `HOOK_GAP`,
   `IMPORT_LAG`, `BACKFILLING` (info), `SPOOL_BACKLOG`, `DB_ERROR`, `TRANSCRIPTS_NOT_FOUND`, `PROVIDER_SILENT` (info), `EVENT_LOOP_SLOW` when p99 > 50 ms).

Projection to the UI's assumed `HealthReport.ingestion` (04 section 13; the API designer owns the final names): `status` = `down` -> `down`; persisted `backlog` or spool backlog older than `health.backlogWarnMs` -> `stalled`; `disabled` is never produced (transcript import is always on; hooks switched off or not installed are reported in the `hooks` sub-block as `enabled: false` / `installed: false`); any other non-ok -> `degraded`; ok -> `ok`. `reasons` = rendered `reasons[].code` texts. `hooks.lastReceivedAt` = `lastEnvelopeAt`; `hooks.spoolPendingBytes` = `spool.bytesBehind`; `hooks.spoolLagMs` = `now - spool.oldestPendingReceivedAt`; `hooks.errorsLastHour` = `invalid1h` + handler errors in the last hour; `transcripts.lastImportedAt` = `lastSyncAt`; `transcripts.importLagMs` = `maxLagMs`; `transcripts.pendingBytes` = `bytesBehind` + `backfillRemainingBytes`; `transcripts.invalidLines` = sum of `invalid_json` + `not_object` + `shape_invalid`.

Per session, the API exposes freshness from the same data: `lastActivityAt`, `lastHookAt`, `transcriptLagBytes` (sum of
`bytes_behind` of its files), `usageComplete`, `eventsComplete`, `hookCoverage`.

### 8.3 Alert inputs (consumed by the alerts designer; evaluated after commit, never in the ingest path)

| Input code | Trigger | Payload |
|---|---|---|
| `no_activity` | provider `silent` longer than the alert threshold while >= 1 session is `working\|running\|waiting_tool\|waiting_agent` | `sessionIds`, `quietMs` |
| `ingest_errors_repeated` | >= 10 `ingest_error` rows with the same code in 10 min | `code`, `count`, `windowMs` |
| `runtime_unavailable` | reconciliation `runtime_unavailable`, or hooks `failing` with `HANDLER_UNAVAILABLE` | `from`, `to`, `envelopes` |
| `import_lag` | transcripts `lagging` | `maxLagMs`, `files` |
| `hook_gap` | coverage `partial` | `sessionId`, `missingTools`, `missingTurns` |
| `hook_failing` | `transcriptHookFailures` grew | `count`, `lastAt` |
| `db_error`, `disk` | persisted `db_error`; `ENOSPC` or `SPOOL_FULL` | `code`, `where` |
| `token_threshold` (input only) | section 6 aggregate with `complete: true` above the configured value | aggregate |

### 8.4 Tests that prove it (reconciliation and health)

| Id | Test |
|---|---|
| T-HE-01 | Hooks and transcript of the same lab-shaped session (fixtures from run1/run2 shapes): one session, one row per tool call with `sources` = 1+2+4+8, agent linked by id, coverage `full` |
| T-HE-02 | Transcript tool calls without hook envelopes after `firstHookAt`: coverage `partial`, one `hook_gap` row; tools in the last 5 s before SessionEnd ignored |
| T-HE-03 | Four-way independence: (a) provider writes, server stopped -> after start `runtime_unavailable` + spool backlog shown; (b) DB made read-only -> persisted `failing`, receiving still `ok`; (c) transcripts dir removed -> `not_found`; (d) SSE disconnected -> no health change |
| T-HE-04 | Handler log with `HANDLER_UNAVAILABLE` for this instance -> hooks `failing`; for another instance id -> unchanged |
| T-HE-05 | Transcript `hook_non_blocking_error` attachments with `--mcs-hook` in `command` -> `transcriptHookFailures` and `hook_failing`; without the marker -> ignored |
| T-HE-06 | `lastSyncAt` advances only when every tracked file is caught up; a growing file keeps `maxLagMs` rising |
| T-HE-07 | Alert inputs fire once per condition change (no repeat while unchanged) |

## 9. Test plan for this domain

### 9.1 Fixtures (all synthetic, placeholder strings, labelled as fixtures; C5)

| Fixture set | Builder | Shapes |
|---|---|---|
| Transcripts | `engine/test/fixtures/transcripts.ts` | the 25 shapes of TS:8 (streaming snapshots, global dedupe, unfinalized, zeroed usage + iterations, synthetic API error, aborted, tool pairs and variants, parallel calls, pending tool, interrupts, denial, turn end with pending counts, compaction, bookkeeping set, cost-state + continued-in, attachments, Agent launch + task-notification, subagent file + meta, workflow dir with and without the status file, workflow agent end, resume copy, order anomalies, defensive encodings, registry, project mapping) |
| Hook payloads | `engine/test/fixtures/hooks.ts` | one builder per installed event with the documented keys (HK:2.2) and the observed key sets of the lab (sanitized: key names and value types only, placeholder values): e.g. SessionStart `{session_id, transcript_path, cwd, hook_event_name, source}`; PostToolUse(Bash) `tool_response {stdout, stderr, interrupted, isImage, noOutputExpected}`; PostToolUse(Agent) `tool_response {status, prompt, agentId, agentType, harnessNoteCount, harnessTailCount, harnessSectionHash, content, resolvedModel, totalDurationMs, totalTokens, totalToolUseCount, usage}`; SubagentStop `{stop_hook_active, agent_id (17 hex), agent_type, agent_transcript_path, last_assistant_message, background_tasks, session_crons}` |
| Hook sequences | `engine/test/fixtures/hook-sequences.ts` | the observed orders of lab runs 1-4 (HK:8) with relative ms: allowed Bash, foreground subagent, denied call (PreToolUse, PermissionRequest, PostToolBatch only), failing Bash (PostToolUseFailure); plus docs-only events (StopFailure, Notification, PreCompact/PostCompact, TaskCreated/TaskCompleted) |
| Spool segments | `engine/test/fixtures/spool.ts` | valid envelopes, malformed cases of 4.8, torn tail, two instances, old segments for downtime. Valid lines are produced ONLY by the real handler (05 testkit `runHookHandler(payload, {mcsHome})` over 05 `hookPayload` builders, the rule of 06 6.2 and I-11); malformed cases are appended afterwards as raw text; segment names come from `spoolSegmentName()` |
| Settings files | `engine/test/fixtures/settings/*.json` | the T-IN-01 matrix |
| External | `engine/test/fixtures/external.ts` | registry files (busy, idle, waiting + waitingFor, bg kind, dead pid, a `.key` decoy), job `state.json` (working, done) |
| Legacy parity | legacy `tests/fixtures/make.py` output + this design's worked example converted | golden outputs captured from the Python engine by the cross-engine procedure (owned by the parity designer) |

### 9.2 Guarantees and the tests that prove them (index)

| Guarantee (brief) | Tests |
|---|---|
| Hook handler never blocks, bounded, silent, observable failures (5, 12) | T-HK-01, 06, 07, 10, 11, T-HE-04, 05 |
| No private data stored from hooks (5, 12) | T-HK-03, 04 |
| Routing to the right instance, isolation (4, 5) | T-HK-05, T-TK-09 |
| Installer: safe merge, atomic, backup, dry run, consent, verify (5, C3) | T-IN-01..09 |
| Idempotency, duplicates (5) | T-PL-02, 03, 04, D1-D5, P1, P3, T-TK-03 |
| Out-of-order and delayed input (5, 6) | T-PL-09, L1-L4, O1-O6, P2, P4 |
| Persist before publish (10) | T-PL-05 |
| Malformed input never crashes (12) | T-PL-07, 08, T-TR-05, 06 |
| Incremental transcript reading (5) | T-TR-01..11 |
| Discovery, classification parity (5) | T-TR-12..14 |
| Persisted vs referenced (12) | T-TR-16, 17 |
| Token accounting, missing vs zero, lower bounds, parity (8.7) | T-TK-01..09 |
| Lifecycle rules (6) | T-LF-01..57, P1-P9 |
| Completion evidence (8.9) | T-LF-57 (CE-1..17), 01 T-CLI-08 |
| Spool names keep the legacy audit green (13, fallback) | T-HK-16 |
| CLI contract of hooks commands and replay (5) | T-IN-10, T-PL-11 |
| Service lifecycle for the instance runtime | T-PL-13, T-LF-54 |
| Health and stale indicators (5, 8.8) | T-HE-01..07 |

### 9.3 E2E items of brief 14 that this domain feeds (the E2E designer owns the runner)

4/5 "generate a test event / verify it appears": run the installed handler command with a synthetic payload (as `mcs hooks
verify` V6) against a running test instance on a port from 05's `allocatePort` (E2E range of 05 4.5); expect the session in the API within 2 s. 8 "token
aggregates": import the worked-example fixture files into a temp `CLAUDE_CONFIG_DIR`; compare the API totals with 6.4.
13/14 "simulate ingestion failure / UI shows degraded": make the DB read-only or remove the transcripts dir; expect
`IngestHealth.status` `down`/`degraded` with the reason codes of 8.2. Optional real-provider E2E (`MCS_E2E_CLAUDE=1`): one
`claude -p` with a temp `--settings` file built by `planHooks` and a temp `MCS_HOME` (never the real settings), as E7.

### 9.4 Rules for every test in this domain

Temp dirs for `MCS_HOME`, `CLAUDE_CONFIG_DIR`, workspaces and settings; ports only from 05 4.4 `allocatePort(VITEST_PORTS)` (18000-18499, registry N13), closed in `afterEach`; no real
settings path is ever written (guard T-IN-07); performance assertions scale with `MCS_PERF_FACTOR`; seeds printed for every
randomized test; no test reads real transcripts.

### 9.5 Test file map (colocated `*.test.ts`, the 05 convention; names used by 05 4.2, I-22)

| Module | Test file | Tests |
|---|---|---|
| `shared/src/protocol/sanitize.ts` | `shared/src/protocol/sanitize.test.ts` | T-HK-04, clip/pyJsonDumps goldens |
| `shared/src/protocol/routes.ts` | `shared/src/protocol/routes.test.ts` | T-HK-05 unit part |
| `shared/src/protocol/hook-envelope.ts` | `shared/src/protocol/hook-envelope.test.ts` | T-HK-16 unit part, id regexes |
| `cli/src/hook.ts`, `cli/src/hook/**` | `cli/test/hook.int.test.ts` (spawns) | T-HK-01..03, 05..17 |
| `engine/src/hooks/installer/**` | `engine/src/hooks/installer/{plan,apply,verify}.test.ts`, `engine/test/hooks-installer.int.test.ts` | T-IN-01..09 |
| `cli/src/commands/hooks/**` (rendering) | `cli/test/hooks.int.test.ts` (spawns `mcs hooks *`, which goes through 01 `ops.hooks.*`) | T-IN-10 |
| `engine/src/ingest/tail/jsonl-tailer.ts` | `engine/src/ingest/tail/jsonl-tailer.test.ts` | T-TR-01..08, 11 |
| `engine/src/ingest/hooks/normalize-envelope.ts` | `engine/src/ingest/hooks/normalize-envelope.test.ts` | 4.3 table, stored kinds |
| `engine/src/ingest/transcripts/normalize-record.ts` | `engine/src/ingest/transcripts/normalize-record.test.ts` | T-TR-15, 16, 19, 5.6 stored kinds |
| `engine/src/ingest/dedupe.ts` | `engine/src/ingest/dedupe.test.ts` | T-PL-04, D1-D5 |
| `engine/src/ingest/{writer,service}.ts`, `spool/**` | `engine/test/hook-to-db.int.test.ts`, `engine/test/ingest-service.int.test.ts` | T-PL-01..03, 05..13 |
| `engine/src/ingest/transcripts/{discovery,classify,importer,entry-text}.ts` | same names `*.test.ts` + `engine/test/import-tokens.int.test.ts` | T-TR-09, 10, 12..14, 17, 18 |
| `engine/src/tokens/aggregate.ts` (+ `accumulate`, `legacy-projection`) | `engine/src/tokens/aggregate.test.ts`, `worked-example.test.ts`, `legacy-projection.test.ts` | T-TK-01..09 |
| `engine/src/lifecycle/**` | `transitions.test.ts`, `properties.test.ts`, `rules.test.ts`, `legacy.test.ts`, `completion.test.ts`, `work-items.test.ts`, `sweeper.test.ts` | T-LF-01..57, P1-P9 |
| `engine/src/health/**` | `engine/src/health/ingest-health.test.ts` | T-HE-01..07 |

## 10. CHALLENGES

C1 (refines D1/D8 "`node <abs>/hook.js`"). The installed command targets a committed, zero-dependency stub
`scripts/mcs-hook.mjs` that dynamically imports the built `runtime/packages/cli/dist/hook.js`. Evidence: the built file
does not exist before the first bootstrap and imports `@mcs/shared/protocol` through `runtime/node_modules`, which `npm ci`
deletes during upgrades; a hook whose module cannot load exits 1 and Claude Code appends a `hook_non_blocking_error`
attachment to the user's transcript on every firing (HK:4, 24 entries in lab run3; E9). With the stub, an unavailable runtime
costs one handler-log line and nothing in the user's transcripts, and the settings path survives upgrades. Alternative if
rejected: point `HOOK_ENTRY_PATH` at `dist/hook.js` and make bootstrap/upgrade write `dist/` atomically and never delete
`node_modules` while hooks are installed; accept the transcript pollution window.

C2 (D9 "COMPLETED/FAILED only from SessionEnd reasons, daemon job state, or external evidence"). A trailing `cost-state` record
coincided with process exit in 16 of 16 sessions and none of the live processes had one (TS:4.2). For sessions without hooks
this is the best available evidence of a clean exit. Proposal: allow `completed` with `basis: inferred`, `confidence: medium`,
rule S-8e' (trailing cost-state AND no live registry entry AND no live pid AND no record after it). Main text follows D9: such
a session stays `turn_ended` with `presence: ended (inferred)`.

C3 (D8 wording, clarification). "file identity = (path, size, first-256-bytes hash, inode where available)": size is not an
identity attribute (it changes on every append); identity here is (bigint inode, 256-byte head hash) and "size smaller than a
cursor" is the truncation test (E5). "global uniqueness on (session_id?, uuid, message.id)": implemented as `uuid` alone for
entries (copies keep uuids while rewriting `sessionId`, TS:3.5) and `message.id` alone for usage (rules 6-7 of 6.2).

C4 (D8 "best-effort POSTs with a ~300 ms timeout", clarification). The POST carries no data (a nudge) and the handler exits on
flush; 300 ms is the upper bound. Evidence E1/E1b: waiting for a hung server's response costs 377 ms per event, exiting on
flush 92 ms with 15 of 15 nudges delivered.

C5 (D8 "keep lengths + hashes", clarification). Hashes are kept for `tool_input` (needed to correlate PermissionRequest with
PreToolUse) and for the raw payload (dedupe), not for prompts or messages: a hash of a short prompt can be reversed by guessing,
and no feature needs it.

C6 (D3 "`data/spool/*.jsonl`", adopted in the main text by the Phase 1 reconciliation, I-02). Spool segments are named
`hooks-<YYYYMMDD>T<HH>Z.ndjson`. Evidence: the legacy `audit` flags every `*.jsonl` inside a task workspace and exits 1 (critic X1:
exit 1 with `.jsonl`, exit 0 with `.ndjson`; rule re-read in `src/backend/tasks.py` on 2026-10-11), and the legacy `doctor` runs that
audit, so D3's name would fail the legacy fallback and the cutover gate G8 (01 T-XE-06). Only the extension changes; the content is
still one JSON object per LF-terminated line. D3's text should read `data/spool/*.ndjson` (owner: lead, foundations).

## 11. Requirements covered (master brief MEGA-PROMT-V3)

- Section 4: routing identity per instance (route files, `instance_id` on every envelope and row), token-isolation test input (T-TK-09).
- Section 5: hooks first with researched events only (2.4, 21 events, unsupported/harmful ones excluded); all ten "Hook delivery
  requirements" bullets (2.1-2.11); "Idempotency" bullets (4.4, 7.12: tokens, tool executions, sessions, terminal transitions,
  hierarchy); all ten "Transcript import" bullets (5.3-5.9); "Reconciliation" four-way model and health fields (8).
- Section 6: all required semantics (7.1), all eight rules, transition table and tests for normal, failed, duplicated, missing,
  delayed and out-of-order inputs (7.7, 7.12), evidence and confidence (7.1), observed vs inferred (`basis`).
- Section 7 (for this domain): transactions for related updates (4.6), no unbounded memory (5.8), no secrets stored (2.4, 5.7),
  DB as source of truth with notifications after commit (4.6).
- Section 8.2/8.3/8.4 inputs: freshness and ingestion health per session (8.2), hierarchy, tool executions, notifications,
  lifecycle events, transcript context by reference (5.7), missing/stale indicators.
- Section 8.6: explicit work-item derivation rules with evidence (7.11). Section 8.7: all bullets except charts and cost
  estimates (analytics designer): source/schema, compaction, duplicates, missing vs zero, estimate vs provider cost, no
  hook/transcript double counting (6). Section 8.8: alert inputs (8.3).
- Section 10 item 3: persist before publish (4.6). Section 12: hook payload validation and size limits, timeouts, file-system
  restriction, path traversal and symlinks, malformed JSONL, untrusted transcript content, secrets out of logs, monitoring
  failures never block Claude Code.
- Section 8.9: "verifying task completion evidence" (7.13 `explainCompletion`, consumed by 01 `verify-completion`; observed
  evidence only, D9).
- Section 13 Phase 3: every listed item. Section 13 (legacy fallback keeps working): spool names that keep the legacy `audit` and
  `doctor` green (2.7, T-HK-16). Section 14: unit (schema validation, lifecycle, tokens, dedupe, parsing, offsets, routing),
  integration (hook payload to DB, persistence before broadcast, transcript import and tokens), E2E inputs (9.3).
- Section 11 (API contract): one shared `ErrorCode` for the nudge route (2.8); one CLI envelope for the hooks commands (3.1).

## 12. Open items (explicit; each has a verification plan and the design already works either way)

| Id | Item (UNVERIFIED) | Plan | Design impact if the answer differs |
|---|---|---|---|
| OI-1 | Tool events inside subagents carry `agent_id` (HK:9.2) | Phase 3 lab run (temp `--settings`) with a subagent that runs one Bash call | none: agent tool rows also come from subagent transcripts |
| OI-2 | Workflow agents fire SubagentStart/SubagentStop | same lab, one tiny workflow | none: workflows are derived from journal/status files |
| OI-3 | Duplicate registrations receive identical stdin bytes | lab: same handler in `--settings` and in a temp plugin | D-3 keeps a duplicate hook `events` row; entities and lifecycle unaffected (D-6, D-7) |
| OI-4 | `prompt_id` for cron / background-report turns | lab with a background subagent | none: turn boundaries compare stamps, not ids |
| OI-5 | Live reload of hook config on 2.1.289 | lab: install into a temp `--settings` file mid-run | only the warning text |
| OI-6 | Daemon job failure state names | observe a failing `--bg` job | S-4b value list |
| OI-7 | Payload size upper bound | lab: Write of a 5 MB file, Read of a large file | 8 MiB stdin cap already bounds memory |
| OI-8 | Need for a worker thread | health `eventLoopDelayP99Ms` in real use | switch behind the same interface (5.4) |
| OI-9 | File birth time on Linux/macOS for the owner rule (6.2 rule 7) | CI on Linux | falls back to first-seen mtime |
| OI-10 | Whether `.claude/settings.local.json` of a repo applies to sessions launched in its subfolders | lab | such sessions are outside the legacy scope anyway; user scope covers them |

Cross-document follow-ups (not unverified facts: each is a change another document makes to match this one; listed so the lead's
reconciliation can check them; this design is complete either way because each item names the exact shape):

| Id | Owner | Change requested |
|---|---|---|
| X-1 | 03 | `spool_cursors.segment` CHECK `GLOB '*.ndjson'` (I-02); `MAX_LINE_BYTES` moves from `shared/src/db-constants.ts` to `shared/src/protocol/limits.ts` (I-32); remove the "assumed" label of A-2 and freeze `0001` (I-03); `EventsRepo.findByNaturalKey`, `deleteTranscriptOnly`, `detachTranscript` (4.4, 5.3); `ChangeSink.record('event', ...)` maps to `event/append` (4.6); `explainCompletion(ctx, t)` in `EngineQueries` with a route for `ApiReader` (7.13, I-08); route `ingestProbe` with `probe_not_found` (I-37) |
| X-2 | 01 | `mutexName` kind `'settings'` keyed by `path.resolve(settingsPath)` (3.5, C48); `ingest replay` calling `planSpoolReplay` + `applySpoolReplay` (stopped) or control op `ingest-replay {fromSegment}` -> `IngestService.replay` (running), `segmentsReset` -> `segments`, audit action `ingest-replay` (2.7, I-29, C03-C05); 6.3 `hooks install --sync-tool-events`, `hooks status` -> `ops.hooks.status`, name `planHooks`, ops calling `engine/src/hooks/installer/*` (3.1, N-11, C23); 4.4a `ingestUntilIdle` and sweeper shapes (4.10, C06); 1.6 ranges of 1.2 (N-04, C02); sections `spool`, `import`, `health` with the 1.2 keys and the scaled derived defaults (I-01); the 1.3 variables in 2.10 (I-27); 1.1 / C-1 spool extension (I-02); `HOOKS_FAILED` `details.reason` values (3.1) |
| X-3 | 06 | `external.attempt` carries `endedAt` and `observedAt` = tick `now` (4.3, I-18); attempts rows commit first, events submitted to `IngestWriter` after COMMIT (4.3, N-01); `ChildSpec` gains an optional capped `stdin` string for `hooks verify` V6 (3.7); spool extension in 7.1 (I-02); 4's lint rule exempts `shared/src/protocol/**` (I-34) |
| X-4 | 05 | spool extension in 1.2 (I-02); `ErrorCode` names in 5.3/5.6 (I-04); test paths of 4.2 = 9.5 (I-22); `RUN_ID_RE` imported from `shared/src/protocol/hook-envelope.ts` (I-26) |
| X-5 | 04 | 11.4/11.5 use `runHookHandler` and the envelope field `event` (I-11); error names of 13 (I-04) |
| X-6 | lead | foundations D3 text `data/spool/*.ndjson` (C6) |

## 13. Phase 2+ task slices (dependency order; each slice independently testable)

| Slice | Scope | Files owned | Depends on | Done when |
|---|---|---|---|---|
| I-1 | Protocol: envelope types and caps, spool segment name, id regexes, line cap, event policy table, sanitize/redact/clip/pyJsonDumps, routes, stamps; zod schemas | `shared/src/protocol/{hook-envelope,hook-events,sanitize,routes,stamp,limits}.ts`, `shared/src/schemas/ingest.ts` + colocated tests (9.5) | 05 S1 scaffold, 01 S1 (shared contracts incl. the I-01 runtime sections) | T-HK-04, T-HK-16 unit part, unit tests of clip/redact/matchRoutes/schemas green |
| I-2 | Hook handler, entry and stub (Phase 3; needed by 04 W14 and 06 S31/S32 fixtures in Phase 4, so it lands first in Phase 3) | `scripts/mcs-hook.mjs`, `cli/src/hook.ts`, `cli/src/hook/*`, `cli/test/hook.int.test.ts` | I-1 | T-HK-01..17 green (T-HK-16 parity part when Python is present) |
| I-3 | JsonlTailer | `engine/src/ingest/tail/*` + tests | I-1 | T-TR-01..08, 11 green |
| I-5 | Normalizers (envelope and transcript record) with stored kinds, severity and natural keys, `EventRowWrite`, task-notification parser | `engine/src/ingest/hooks/normalize-envelope.ts`, `engine/src/ingest/event-row.ts`, `engine/src/ingest/transcripts/{normalize-record,task-notification}.ts` + tests | I-1, 03 S3 (`EVENT_KINDS` in `shared/src/api/entities.ts`) | T-TR-15, 16, 19; `normalize-envelope.test.ts` and `normalize-record.test.ts` (4.3 and 5.6 stored-kind columns) green |
| I-6 | Token accounting + legacy projection | `engine/src/tokens/*` | I-5 | T-TK-01..08 green |
| I-7 | Lifecycle facts, merges (incl. `external.attempt_cleared`), derive tables, `renderEvidence` / `toApiEvidence` / `viewChanged` (`rules.ts`), `toLegacy` (`legacy.ts`), nextCheckAt, work items | `engine/src/lifecycle/{facts,merge,derive-*,rules,legacy,next-check,work-items}.ts` + tests | I-5 | P1-P9, T-LF-01..52, 55, 56 green (in-memory model, no DB) |
| I-7b | Completion evidence | `engine/src/lifecycle/completion.ts`, `completion.test.ts` | I-7 | T-LF-57 CE-1..16 green with an in-memory `CompletionLookup`; CE-17 and 01 T-CLI-08 run when 03 S5/S12 and 01 S13b land |
| I-4 | Hook path to the DB: writer (`withWriteTx`), dedupe, error codes, spool drainer, segments, retention, replay engine, nudge handling, route-file writer | `engine/src/ingest/{writer,dedupe,errors}.ts`, `engine/src/ingest/spool/{spool-drainer,segments,replay}.ts`, `engine/src/ingest/routes-file.ts` + tests | I-1, I-3, I-5, I-7, 03 S1/S2 (DB, repositories, `withWriteTx`, `createChangeSink`), 03 S4 (nudge route), 01 S8 (+I-15 instance runtime) | T-PL-02..12, T-HK-06b green (the `mcs ingest replay` command itself is 01 S14) |
| I-8 | Transcript side and services: scheduler, discovery, classification, importer, entry text, `createIngestService`, `createLifecycleSweeper`, external pollers | `engine/src/ingest/service.ts`, `engine/src/ingest/transcripts/{discovery,classify,importer,scheduler,entry-text}.ts`, `engine/src/lifecycle/sweeper.ts`, `engine/src/external/*`, `engine/src/ingest/config-keys.test.ts` | I-4, I-6, 01 S8 (`InstanceContext`), D5 translator (01) | T-PL-01, 13, T-TR-09, 10, 12..14, 17, 18, T-LF-50, 53, 54, T-TK-09, config-keys test green |
| I-9 | Installer, verifier, uninstaller, status (engine side; N-11, C23) | `engine/src/hooks/installer/{plan,apply,verify,uninstall,status,settings-io}.ts` + colocated tests, `engine/test/hooks-installer.int.test.ts`, `engine/test/fixtures/settings/*` | I-1, I-2, 01 S4 (`acquireMutex` kind `settings`), 01 S6 (audit writer), 06 PP1 (`execFileText` kind `node`) | T-IN-01..09 green; T-IN-10 (`cli/test/hooks.int.test.ts`) green once 01 S14 wires `ops.hooks.*` and `cli/src/commands/hooks/*` |
| I-10 | Health + alert inputs | `engine/src/health/*` | I-8 | T-HE-01..07 green |
| I-11 | Integration + E2E inputs | `engine/test/{hook-to-db,import-tokens,ingest-service}.int.test.ts` (05 4.2 names) | I-8..I-10, 03 S4/S5, 01 S8 | 9.3 scenarios green; optional real-provider run recorded |

Order with the other designs (critic section 3): 05 S1 -> 01 S1 -> I-1 -> I-2, I-3 -> 03 S1, S2 -> I-5, I-6, I-7, I-7b -> 01 S8 ->
03 S4, S5 -> I-4, I-8 -> I-9, I-10 -> I-11. The table above lists the slices in this order.
