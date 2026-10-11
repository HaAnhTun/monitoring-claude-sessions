# CCAM source analysis (Claude Code Agent Monitor)

Research for the v3 Node.js + TypeScript + React migration of the `monitoring-claude-sessions` skill.
Scope: what the CCAM implementation really does, where it is weak, what our design should do differently, and which of its edge cases we should reuse as our own tests.

## 0. Provenance and method

- Source: `https://github.com/hoangsonww/Claude-Code-Agent-Monitor`, shallow clone made 2026-10-11 into `D:/mvp/private/scratch/mcs-v3/ccam-src`.
- Commit analysed: `a06db038a93b4d7316492dc55758f597e104894c` (committer date 2026-10-09), `package.json` version 2.3.0, MIT license.
- All `file:line` references below are relative to that clone and to that commit.
- Stack as found: Node (CommonJS) + Express + `ws` + SQLite (`better-sqlite3`, with a `node:sqlite` shim in `server/compat-sqlite.js`), React client, a separate TypeScript MCP server in `mcp/`. About 95k lines in total; `server/routes/hooks.js` alone is 2509 lines and `server/db.js` 2454.
- I read the code and ran two small probes against the unmodified clone (section 13). Anything I only read and did not execute is labelled "read only". Public GitHub issue titles and public issue text were fetched through the unauthenticated REST API on 2026-10-11 for bug history.
- No code was copied wholesale; snippets are paraphrased.

## 1. Executive summary: what to take, what to avoid

Take:

1. A hook handler that never blocks Claude Code: hard 2.5 s process timeout, 2 s socket timeout, exit 0 always, fire-and-forget (`scripts/hook-handler.js:61-69`, `scripts/hook-transport.js:54-96`).
2. Handling of the Claude Code lifecycle as a reducer with an explicit "awaiting input" flag separate from status.
3. Usage accounting keyed by `message.id`, last record wins (CCAM issue #293 showed 2-4x inflation without it).
4. Validation and partial-failure semantics of the remote `ingest-batch` route: per-item errors, dedup by uuid, persist then broadcast (`server/routes/hooks.js:2065-2498`).
5. Watchdog ideas: unrecovered error at transcript tail, Esc interrupt detection from the transcript tail, idle-working timeout.
6. Host-header allowlist, loopback CORS, constant-time token compare (`server/lib/security.js`).
7. Edge-case-rich tests (section 15).

Avoid (all verified in code, details below):

1. No event identity or uniqueness anywhere: the `events` table has no UNIQUE constraint, hooks carry no sequence number, `tool_use_id` is never used (0 occurrences in `hooks.js`). Retried or reordered delivery double-counts or flips state.
2. Broadcast happens inside the SQLite transaction in the main hook route (`hooks.js:494`, `:1310`), before commit.
3. The incremental transcript reader advances its byte cursor past a torn last line and loses that record until a full re-read. Reproduced (section 13).
4. The whole hook JSON payload is stored in `events.data` (`hooks.js:1298`). CCAM's own open issue #315 reports a 2 GB database caused by this.
5. The hook installer runs automatically on every server start and edits the user's real `settings.json` non-atomically, with no backup and no uninstall.
6. The "monitor" is also a control plane: it can spawn `claude` with `bypassPermissions`, write `~/.claude` config, import arbitrary directories, and exposes 103 MCP tools, 52 guard call sites for mutating ones.
7. Subagent identity is guessed by name prefix and "oldest working subagent" heuristics instead of the ids Claude Code provides.
8. Process-liveness reaping is disabled on Windows (`server/lib/session-liveness.js:64`), which is our platform.
9. Ad-hoc, un-versioned schema migrations executed as import-time side effects (`server/db.js`, no `user_version`).

## 2. Hook handler (`scripts/hook-handler.js`, `scripts/hook-transport.js`, `server/lib/server-info.js`)

### What it does

- Hook type comes from `argv[2]` (`hook-handler.js:24`); stdin is read fully, `JSON.parse`d, and on failure wrapped as `{raw: <text>}` (`:47-52`). Envelope sent: `{hook_type, data}` (`:54-57`). The hook's own `hook_event_name` field is not cross-checked against `argv[2]`.
- Delivery: POST to `http://127.0.0.1:<port>/api/hooks/event` for every live dashboard port. Port resolution (`server-info.js:197-243`): `CLAUDE_DASHBOARD_PORT` env override, else live entries from `~/.claude/.agent-dashboard.json` (pid liveness via `process.kill(pid,0)`), else fallback 4820. Servers sharing one data dir are collapsed to the lowest port to avoid duplicate ingest (`:66-69`, `:229-243`).
- Non-blocking design: it does not wait for the HTTP response, only for the request body to be flushed (`hook-transport.js:91-92`), then `setImmediate(process.exit(0))` (`hook-handler.js:61-63`). Safety net `setTimeout(exit(0), 2500)` (`:69`). Per-request socket timeout 2000 ms (`hook-transport.js:83`). Errors are swallowed (`:86`). It prints nothing to stdout and never returns a blocking exit code.
- Optional remote mode: `CCAM_DASHBOARD_URL` must be https unless loopback and then requires `CCAM_HOOK_TOKEN` or a token file (`hook-transport.js:26-52`), sent as `x-ccam-hook-token`.
- Tests: only 3 handler tests (slow server does not delay exit; connection refused exits promptly; token sent to remote), in `server/__tests__/hook-handler.test.js`.

### Weaknesses

- No durability. If the dashboard is down, the event is lost forever. CCAM's own comment admits a lost SessionEnd leaves sessions "Waiting until the 3 h stale sweep" (`hooks.js:1772-1777`).
- No client-side timestamp, no sequence number, no event id. Every hook is a separate short-lived process, so two hooks fired milliseconds apart race on TCP and can arrive reordered (section 4).
- No client-side payload bound. Large `tool_response` bodies are forwarded verbatim; the server limit is `express.json({limit:"1mb"})` (`server/index.js:96`), so a larger payload is rejected with 413 and silently dropped, while a payload just under the limit is stored whole (issue #315, open: rows over 700 KB, `originalFile` duplicated in Edit responses).
- The server discovery file is a read-modify-write without locking (acknowledged at `server-info.js:124-128`); stale entries are pruned by pid only (pid reuse is not handled).
- The fallback to `raw` means garbage input still POSTs and the server answers 400 `MISSING_SESSION` (`hooks.js:1398-1401`), which nobody sees.

### Our design should

- Handler = dependency-free script: read stdin (bounded, for example 1 MB), stamp `received_at` plus a per-process monotonic counter and `process.hrtime`, compute a deterministic event key (hash of session id, hook name, `tool_use_id` when present, and payload digest), truncate known heavy fields (`tool_response.*`, `originalFile`, base64) to a size cap before anything is stored, append one line to a local spool file (single `write` with append mode, small enough to be atomic), then optionally poke the server. Exit 0 always; no stdout.
- The server (or a reader inside it) tails the spool by offset. This removes the "dashboard was down" loss window and the HTTP dependency, and makes ingest replayable for tests.
- Keep CCAM's timing budget (hard exit around 2-3 s) as an explicit test.

## 3. Hook installer (`scripts/install-hooks.js`, `server/index.js:1464-1481`)

### What it does

- Events installed (`install-hooks.js:87-95`): `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `Notification` (with `matcher:"*"`) and `SessionStart`, `SessionEnd`, `UserPromptSubmit` (no matcher). Eight events. Command: `node "<abs path>/hook-handler.js" <HookType>`, backslashes normalised to `/` (`:16`, `:97-110`).
- Ownership test: any entry whose `command` contains the substring `hook-handler.js` (`:112-119`). Idempotence: the first matching entry per event is overwritten in place, otherwise the entry is appended (`:166-179`); covered by the test "is idempotent" in `install-hooks.test.js`.
- Writes `JSON.stringify(settings,null,2)` straight over `settings.json` (`:181-183`). A parse failure aborts (returns false) so a corrupt file is not overwritten (`:151-159`).
- Container guard (issue #193): refuses to write a container-internal handler path into a bind-mounted `~/.claude` (`:39-58`, `:145-148`).
- Called automatically with `silent=true` on every server start (`server/index.js:1468-1470`).
- There is no uninstall anywhere in the repo (searched "uninstall" across `*.js`, `*.json`, `Makefile`; the only hits are an unrelated watcher crash guard and i18n strings). `docs/HOOKS.md` has no removal instructions.

### Weaknesses

- Silent modification of a user-global file at every start: no consent, no backup, no dry-run, no atomic temp-and-rename, no lock (a concurrent write by Claude Code itself could interleave).
- Only the first matching entry is replaced; duplicates created by older versions or by the user stay, and each would POST again (double ingest). Read only, inferred from the `findIndex` logic.
- The substring ownership test `hook-handler.js` also matches any unrelated user script of that name (and `codex-hook-handler.js`, although Codex hooks live in another file).
- It does not subscribe to events that would remove the heuristics: no handler for `SubagentStart`, `PostToolUseFailure`, `PreCompact`, `PermissionRequest` exists in `hooks.js` (grep: none). Compaction is therefore discovered by polling the transcript (`server/index.js:1559+`).
- The path of the CCAM checkout is baked into the user's settings; moving or deleting the repo makes every hook fail with `MODULE_NOT_FOUND` (this is exactly the failure that motivated issue #193).

### Our design should

- Explicit `install`, `status`, `uninstall`, `--dry-run` commands; never auto-install at server start.
- Back up `settings.json` first, write a temp file then atomic rename, refuse on parse errors, preserve unknown keys and key order, never touch `settings.local.json` unless asked.
- Identify our entries with an unambiguous marker (a unique wrapper filename plus a fixed argument), replace or remove all of ours, and leave everything else equivalent after a JSON round trip.
- Install exactly the event set we handle, no more. Test matrix: empty file, missing file, corrupt file, existing user hooks on the same events, two-time install, uninstall after install equals the original, paths with spaces and Windows drive letters.

## 4. Server ingest route (`server/routes/hooks.js`, `router.post("/event")`, `processEvent`)

### What it does

- `POST /api/hooks/event` (`:1380-1521`): requires `hook_type` and `data` (400 otherwise); `data.session_id` must be truthy (else 400 `MISSING_SESSION`). No type, length or format check on `session_id`, `transcript_path`, `cwd`, `tool_name`.
- Everything runs in one synchronous better-sqlite3 transaction `processEvent` (`:494`). Single-process synchronous execution means no in-process interleaving, so races only appear across processes (two servers on one DB); that is why discovery dedupes by data dir.
- Session birth: `ensureSession` inserts the session on first sight of any hook (including mid-session), name `Session <id8>`, status `active`, plus a main agent `<sessionId>-main` (`:254-336`). `started_at` is the server's receive time, not the true session start.
- Metadata persisted on first sight only: `transcript_path` (SQL guard on NULL/empty), sanitised `repo_remote_url` (userinfo, query and fragment stripped, `:132-152`).
- All timestamps are server `now` (`db.js:1896-1898`). The hook envelope carries none and the handler adds none.
- Event row: one `INSERT INTO events` per hook with `JSON.stringify(data)` as `data` (`:1292-1300`). `touchSession` bumps `updated_at` on every event (`:1290`).
- Alert evaluation, Cursor enrichment, the subagent JSONL scan (`SubagentStop`), and workflow journal ingest run after the response, off the hot path, fail-safe (`:1406-1520`).
- A second route `POST /api/hooks/ingest-batch` (`:2065-2498`) is much better engineered: disabled (503) unless its own `REMOTE_PUSH_TOKEN` is set; header-only token (no query string); whole-request 409 on `schema_version` mismatch; at most 1000 items (413); per-item validation with error codes (`INVALID_UUID`, `INVALID_NUMERIC`, `CACHE_WRITE_1H_EXCEEDS_TOTAL`, `UNKNOWN_AGENT`, `SESSION_LOCALLY_OWNED`) while valid items still commit; `Number.isSafeInteger` checks; dedup by uuid both across requests and inside one batch (`:2007-2012`, `:2185-2340`); one transaction; and broadcasts collected in `pendingBroadcasts` and sent only after the transaction succeeds (`:2350`, `:2478-2490`). Ownership rule: a pushed session id cannot take over a locally owned session (`:2143-2173`).

### Ordering, dedup and out-of-order handling

- Hook events: none. `insertEvent` is unconditional; the schema has no UNIQUE constraint at all (grep `UNIQUE` in `db.js` returns nothing); `tool_use_id` is not read anywhere (0 matches in `hooks.js`). A retried POST or a duplicate server port yields duplicate rows and repeated state transitions.
- Order is arrival order. The code comments describe the symptom: a late `PostToolUse` or `SubagentStop` after `Stop` "must NOT clear the flag" (`:560-566`), handled by special cases rather than by ordering. A `PostToolUse` that arrives after `Stop` still clears `awaiting_input` when no working subagent exists.
- There is no test for duplicate delivery, replay or reordering (grep of `api.test.js` and `awaiting-subagent-guard.test.js` for "out of order", "duplicate hook", "redeliver", "concurrent": no matches).
- Transcript-derived rows do have app-level dedup: APIError by summary text (`:1050-1056`, `:1715-1727`), compaction agents by `${sessionId}-compact-${uuid}` (`:994-995`), TurnDuration by `turnId` with `uuid:`/`offset:`/`ordinal:` fallbacks and a full rebuild when the parse is complete (`:1124-1218`).

### Weaknesses

- Broadcast inside the transaction: `processEvent` (`:494`) calls `broadcast` at `:546`, `:624`, `:735`, `:1310`. The commit happens only when the function returns; an exception after a broadcast (for example a CHECK constraint, or a `TypeError` on a non-string `session_id`, read only) rolls back the DB while clients already saw the event. Only the batch route follows persist-then-broadcast.
- Heavy synchronous work inside the write transaction: `transcriptCache.extract` (file I/O and JSON parsing; on the first hook after a restart a full re-parse of a multi-MB transcript, `:959-960`, `:876`) holds the SQLite write lock and blocks the event loop for every other request. Issues #317 and #319 (list requests taking 10-20 s, 787 ms last-activity queries) are the same class of problem.
- `session_id` is attacker-supplied text that later becomes part of filesystem paths (section 11).
- `started_at` and every event time are receive time, so replaying a spool or recovering after downtime produces wrong timelines.
- Two writers for the same facts (live hooks and the history importer, `scripts/import-history.js`) are reconciled by a "fragile type+timing match" per CCAM's own comment (`import-history.js:1303-1310`), producing duplicate subagent rows when the match misses. The importer's event dedup is a per-type high-water timestamp (`:1215-1234`): events with equal timestamps are dropped and out-of-order backfill is lost.

### Our design should

- Give every event an id and a monotonic per-session sequence at the edge (handler), enforce `UNIQUE(session_id, event_key)` in the DB and make ingest `INSERT OR IGNORE`, so replays and retries are no-ops by construction.
- Make state a pure reduction over ordered events (order by hook-side sequence, tie-break by arrival), recomputable from the event log. Persist the event first, derive state second, broadcast last (after commit), with a global monotonically increasing `seq` on every broadcast.
- Do file I/O (transcript tailing) outside the write transaction; keep the DB write transaction short.
- Validate `session_id` (UUID or strict regex) and bound every string before use.
- Reuse the batch route's validation style (per-item error codes, `isSafeInteger`, schema version) for any API that accepts external input.

## 5. Session and agent status state machine

Statuses (`db.js:166`, `:184`): session `active | completed | error | abandoned`; agent `working | waiting | completed | error`; agent type `main | subagent`. "Waiting for the user" is not a status; it is `awaiting_input_since` plus `awaiting_reason` in `{stop, notification, session_start, interrupted}` on session and agent (`db.js:1118-1140`, `hooks.js:221-243`).

Transitions (all in `hooks.js` unless stated):

| Trigger | Effect | Lines |
|---|---|---|
| Any non-SessionEnd hook for a non-active session | Reactivate session (and main agent) when: `UserPromptSubmit` or `PreToolUse` always; other events if status is not `error`; `Stop`/`SubagentStop` only from `completed`/`abandoned`. `SessionEnd` never reactivates | 527-553 |
| `SessionStart` (source startup/resume/clear) | main agent `waiting -> working`, stamp awaiting `session_start`; source `compact` leaves state untouched (mid-turn compaction) | 800-837 |
| `SessionStart` (side effect) | marks every other `active` session idle for `DASHBOARD_STALE_MINUTES` (default 180) as `abandoned`, agents `completed` (the "/resume leaves the parent without Stop/SessionEnd" case) | 838-858 |
| `UserPromptSubmit` | clear awaiting; main agent -> `working` unless completed/error | 894-909 |
| `PreToolUse` | clear awaiting (unless a subagent is the actor and reason is `notification`); tool `Agent` creates a subagent row (`working`) with inferred parent; main -> `working` (plus `current_tool`) unless a subagent is the actor | 569-653 |
| `PostToolUse` | same guarded clear; clears `current_tool`; an `Agent` PostToolUse does NOT finish the subagent (backgrounding) | 655-691 |
| `Notification` | blocking type (`permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`, `quota_auto_resume_stale`) or text pattern -> main `waiting`, awaiting `notification`; non-blocking types including `idle_prompt` ignored; compaction-looking text relabelled `Compaction` | 79-121, 911-942 |
| `Stop` | `stop_reason=="error"` -> session and main agent `error`, awaiting cleared; else main `waiting`, awaiting `stop`. Session stays `active`; subagents are NOT completed | 693-740 |
| `SubagentStop` | find a subagent to complete by: name prefix of `description`/`agent_type`, then `subagent_type`, then identical prompt, then oldest working subagent; mark `completed`. If none matches, only the event row is written | 742-798 |
| `SessionEnd` | clear awaiting; every non-terminal agent completed (or `error`); session `completed`, or stays `error` only if an API error is still unrecovered at the transcript tail | 862-892 |
| Transcript: new unrecovered API error | session `active -> error`, main -> `error` | 1044-1099 |
| Transcript: error recovered (`isErrorAtTail` false) on any hook | session and main `error -> active/working` ("self-heal") | 1101-1122, 1563-1572 |
| Watchdog (every 15 s) | local `active`/`error` sessions silent for 10 s: self-heal error; Esc interrupt (`pendingInterrupt` from transcript tail) -> `waiting` plus awaiting `interrupted`; idle-working for more than 120 s with no tool in flight -> same | 1574-1707 |
| Liveness reap (watchdog and boot) | `active` session whose cwd has no live `claude` process and whose transcript mtime is older than 60 s -> `completed` with a synthetic `SessionEnd` (source `liveness-probe`); POSIX only | 1814-1938 |
| Periodic sweep | `active` and idle longer than the stale minutes -> `abandoned`, non-terminal agents -> `completed`; interval = stale/4 clamped to 60-300 s | `server/index.js:1496-1557`, `db.js:1864` |

Subagent parent inference: if main is `working` the parent is main; otherwise the deepest `working` subagent (recursive CTE `findDeepestWorkingAgent`, `db.js:1836-1853`, `hooks.js:605-611`). Tool events while main is `waiting` and a subagent is `working` are attributed to the deepest working subagent (`:636-643`, `:677-682`).

### Weaknesses

- Heuristic attribution. `SubagentStop` ignores `data.agent_id` even though a code comment says the payload provides it (`:748-749`; grep for `data.agent_id` in `hooks.js`: 0). With two parallel subagents of the same type, the wrong one can be completed. Tool events from parallel subagents are attributed to "deepest working", and events from background subagents while main is `working` are attributed to main (the guard only applies when main is `waiting`).
- The spawn tool is detected by the literal `toolName === "Agent"` (`:587`); the string `"Task"` (an older name) does not appear in `hooks.js` (grep 0). A Claude Code rename would silently stop subagent tracking. Verify the current tool name against Claude Code documentation in our own research.
- `abandoned` is only produced from `active`; sessions in `error` are never aged out (`db.js:1867` filters on `status='active'`). A session that errored and was never resumed stays `error` forever.
- The stale sweep marks agents `completed`, not `abandoned`, so the UI cannot tell "finished" from "gave up".
- The stale decision uses `updated_at`, which every event, import pass and watchdog write touches; CCAM already had to add "do not rewrite and broadcast an unchanged errored session every 15 s because it looks like fresh activity" (`:1709-1714`).
- `SessionStart` doing global cleanup of other sessions is a hidden cross-session side effect; an alive but quiet terminal that is idle for 3 h gets `abandoned` and relies on a later hook to reactivate.
- Status and awaiting flag are stored redundantly on session and agent (two sets of columns to keep in sync, with several explicit "do all writes before any broadcast" comments, `:706-710`).
- Liveness reap needs `ps`/`lsof` or `/proc`; unavailable on win32 (`session-liveness.js:64`, `:128`), in containers, and for remote sources. On Windows the only terminal signals are `SessionEnd` and the 3 h sweep.

### Our design should

- Define states and a transition table as data, with one function `reduce(state, event) -> state`, covered by table-driven tests. Keep "awaiting" as derived data (the last relevant event), not stored flags.
- Correlate by ids Claude Code gives (`agent_id`, `tool_use_id`, `SubagentStart`/`SubagentStop`) with heuristics only as a labelled fallback; keep unresolved events attached to the session with `agent_id = null` rather than guessing.
- Distinguish `ended` (SessionEnd seen), `stale` (no signal for N minutes) and `unknown`; do not rewrite agent status to `completed` when merely stale.
- Windows liveness: UNVERIFIED idea, record the Claude Code process id seen by the hook (the `process.ppid` chain) in the handler and probe it with `process.kill(pid,0)`; this needs a probe on Windows before we rely on it.
- Make stale detection depend on event time, not on `updated_at` bookkeeping, and include `error` sessions.

## 6. Transcript import and cache (`server/lib/transcript-cache.js`, `server/lib/token-usage.js`, `scripts/import-history.js`)

### What it does

- `TranscriptCache.extract(path)` (`transcript-cache.js:147-253`): `statSync`; cache hit if mtime and size are unchanged (`:160`); full re-read if first time or `size < bytesRead` (`:167-171`); incremental read from `bytesRead` if the file grew (`:174-244`); same size but different mtime -> full re-read (`:246-249`). LRU of 200 entries in memory only (`:21`; entries also dropped by `invalidate` on SessionEnd or abandon).
- Reading is chunked (4 MiB) with a byte buffer, splitting on 0x0A so multibyte characters survive; a single pending line is capped at 64 MiB and dropped beyond that (`:290-389`). The streaming design is consistent with CCAM issue #341 (a rollout above 512 MiB hit `ERR_STRING_TOO_LONG`).
- Per record (`_consumeLine`, `:451-624`): `custom-title` and `ai-title` (last wins), interrupt markers (`interruptedMessageId` or the text `[Request interrupted by user`), `isCompactSummary` entries (count, uuid, timestamp), `system/turn_duration` records, API errors (`isApiErrorMessage` and `message.type=="error"`), thinking blocks, first and two most recent human prompts (tool results, meta, slash-command plumbing filtered), and usage.
- Token extraction: tokens are bucketed by `(model, speed, inference_geo, service_tier)`; the `<synthetic>` model is skipped; cache-write 1 h split from `cache_creation.ephemeral_1h_input_tokens`; server-tool counts from `server_tool_use` (`token-usage.js:68-107`).
- Dedup by `message.id` (`transcript-cache.js:578-610`): Claude Code writes one JSONL record per content block, so records with the same id are retracted and replaced, last record wins; records without an id are always counted. The id map is seeded from the cached result on incremental reads and tail-bounded to 1000 entries (`:405`, `token-usage.js:160-173`). Introduced after issue #293 (2-4x inflation, "a $16k history shown as $32k").
- Arrays (errors, turn durations, compaction entries) are tail-capped at 1000 (`:60-69`); `turnDurationsComplete` says whether the capped parse is authoritative (`:671`).
- Live path: every hook re-runs `extract`, then `replaceTokenUsage` per bucket (`hooks.js:1256-1280`). Flat subagent transcripts (`<session>/subagents/agent-*.jsonl`) are merged by `combineLiveSessionTokens` (`:47-69`); workflow inner agents are kept in separate buckets.
- Importer (`scripts/import-history.js`): `parseSessionFile`/`parseSubagentFile` (own parsers with the same dedup after #293), `importSession`, `reconcileTokens` with `--reset-baselines`, plus a durable copy of each transcript into `<dataDir>/transcripts/` so history survives Claude Code's own cleanup (`:60-103`).

### Weaknesses

- Torn trailing line is lost (reproduced, section 13): the final bytes without `\n` are fed to `JSON.parse` (`:371-377`), fail silently, and the cursor is still set to `stat.size` (`:169`, `:232`). The remainder of that line later parses as garbage. The usage in that line is missing until a restart, a shrink, or a same-size rewrite forces a full read. Live hook reads race the writer constantly, so this is plausible in production. No test covers it (the unit tests include "should skip malformed JSON lines gracefully" but none for a partial tail).
- The cursor is memory only (`Map`). After a restart every active session is fully re-parsed inside the first hook's transaction.
- Rewrite detection is only `size < bytesRead` or "same size, new mtime". A rewrite that grows the file (for example a compaction that rewrites a prefix and ends larger) is treated as an append; offset-based reading then starts in the middle of new content and skips or duplicates records. No head fingerprint or inode check. Read only, inferred from `:167-244`.
- Dedup scope is `message.id` only, no `requestId`, and only within one transcript file and a 1000-id tail window; the test "bounds the over-count when a message's records fall outside the window" documents the accepted over-count. Duplicates across transcripts (for example a resumed or forked session that replays earlier assistant messages) are not deduped across sessions since `token_usage` is keyed per session. UNVERIFIED that Claude Code produces such duplicates; our design must test this with real fixtures.
- Token totals use a replace-with-high-water-mark scheme (`db.js:1960-2007`): `baseline := max(old_live + old_baseline - new_live, 0)`. It exists because two writers with different scopes (main-only live writer vs main plus subagents importer) wrote the same bucket, and an earlier "baseline += old" formula inflated one session to about 11x (comment `db.js:1968-1978`). The fix keeps a monotonic maximum, which also preserves any past over-count forever; `resetTokenUsage` and `--reset-baselines` exist to repair that. The schema carries 16 token columns per bucket (8 live, 8 baseline).
- Same-model subagent tokens were missing from live cost (issue #345: dashboard totals equalled the main transcript to the cent in 6 of 7 recent sessions with subagents) because the SubagentStop scan skipped buckets owned by the parent model. Fixed by `combineLiveSessionTokens`, but it shows the cost of two writers.
- Snapshots copy full transcripts (prompts, source code, any secrets pasted into prompts) into the dashboard data dir with no encryption; retention is opt-in (`snapshot-retention.js:1-27`; caps unset by default).
- The importer's event dedup is a per-type max timestamp (section 4).

### Our design should

- Tail with a persisted cursor per file: `(path, file id or birth time, offset of the last complete line, head hash of the first N KB)` in the DB. Advance only to the last `\n` actually seen; keep the partial tail unconsumed. If the head hash or file id changes, or the size shrinks, re-read from 0.
- Store usage as one row per `(session_id, message_id)` with upsert (last record wins), then derive totals with `SUM`. No in-memory window, no baselines, no two-writer buckets, and re-import is idempotent by construction. Parent and subagent files each own their rows; totals are a query.
- Decide the cross-file duplicate policy with real fixtures (resume, fork, subagent) and record it as a documented rule plus tests.
- Parse in a worker or between transactions; yield on large files.
- Keep a hard cap on line size (CCAM's 64 MiB drop is reasonable; count and log it instead of dropping silently).
- Do not duplicate transcripts. Reference them in place; if a copy is ever offered, make it opt-in and say what it contains.

## 7. Database schema, migrations, indices (`server/db.js`)

### What it does

- SQLite in WAL mode with `foreign_keys=ON` and `busy_timeout=5000` (`:134-136`). Default location under `~/.claude/agent-dashboard/dashboard.db`, with a non-destructive copy of older databases via `VACUUM INTO` (`:53-110`).
- 17 `CREATE TABLE` statements and 36 `CREATE INDEX` statements in one 2454-line module that runs at `require` time. Core tables: `sessions`, `agents`, `events` (`INTEGER PRIMARY KEY AUTOINCREMENT`, `data TEXT` holding the whole payload), `token_usage` (composite PK `session_id, model, speed, inference_geo, service_tier, context_size`), plus pricing tables (Claude, GPT, Cursor), alert rules and events, webhooks, workflows, remote sources, push subscriptions, dashboard runs, Codex ingest state (`byte_offset`, `remainder`).
- Indices added over time: `(session_id)`, `(event_type)`, `(created_at DESC)`, `(session_id,event_type)`, `(agent_id,event_type)`, `(agent_id,created_at)`, `(session_id,created_at)` (the last two after issue #319), partial `tool_name`, and a partial expression index on `json_extract(data,'$.uuid')` narrowed to `RemoteToolEvent`/`RemoteTurn` (`:404`).
- Migrations: no version table, no `PRAGMA user_version`. Each migration is a `try { SELECT ... } catch { ALTER ... }` or a `PRAGMA table_info` probe (examples `:570-639`, `:1057-1087`, `:1093-1140`, `:1326-1380`). Table rebuilds use rename-copy-drop with `foreign_keys=OFF`; some are wrapped in `BEGIN`, others are not (`:1062-1086` is not).
- The `node:sqlite` fallback shim implements `transaction()` as a raw `BEGIN`/`COMMIT` wrapper (`compat-sqlite.js:35-48`), so nested transaction functions would fail there (read only).

### Weaknesses

- No UNIQUE constraints anywhere, so idempotency is entirely application code.
- Import-time side effects and ad-hoc migrations are hard to test and to roll forward safely; narrowing one index needed a special `DROP INDEX` check (`:138-160`, test `idx-events-uuid-narrow-migration.test.js`).
- A legacy non-JSON row once broke creation of a partial index and needed a `json_valid` guard and a test (`events-uuid-index-legacy-json.test.js`): expression indexes on free-form `data` are fragile.
- `events.data` is unbounded (issue #315), on a table that can reach hundreds of thousands of rows with several single and composite indexes.
- `CHECK` constraints on status enums turn an unvalidated `PATCH /api/sessions/:id {status:"x"}` into a 500 (`sessions.js:609-630` passes `status` through unvalidated; read only).
- `settings.js` clear-data toggles `foreign_keys=OFF`, deletes, then toggles back without try/finally (`settings.js:157-171`): an exception leaves FK enforcement off for the shared connection.

### Our design should

- Numbered, transactional, forward-only migrations with `user_version`, each tested against a database created by the previous version (fixture DBs), run explicitly at startup, never at import.
- `UNIQUE(session_id, event_key)`, `STRICT` tables, explicit state columns, trimmed `events.payload` (heavy fields dropped or kept elsewhere), and a covering index on `(session_id, seq)`.
- FTS5 only if search is a requirement, kept outside the primary write path.

## 8. WebSocket broadcast (`server/websocket.js`)

- `ws` server on `/ws`, `maxPayload` 64 KiB, `verifyClient` enforces the Host allowlist and the optional token (`:11-23`); 30 s ping/pong heartbeat (`:38-52`); `broadcast(type,data)` serialises once with a server timestamp and sends to every OPEN client inside a try/catch (`:62-74`).
- Persist-before-broadcast: NOT in the main route (broadcast happens inside the open transaction, section 4); YES in `ingest-batch` (broadcasts queued and sent after the write succeeded).
- Frames are state snapshots (`session_updated` carries the whole row) plus `new_event`. No sequence number, no replay, no "resync" frame on connect, no per-client backpressure check (`bufferedAmount`), no subscription filter. A client that was disconnected must rely on REST polling: CCAM issue #319 notes a 2 s trailing throttle reload plus a 10 s poll as backstop.
- Several code comments record flicker bugs caused by broadcasting an intermediate state (for example `Stop` once broadcast the agent twice, `:706-710`).

Our design should: broadcast only after commit, put a monotonic `seq` on every frame, support `Last-Event-ID` or `since=seq` replay from the event log (bounded), send a `hello` frame with the current `seq`, drop slow clients, and make the UI idempotent on `seq` (ignore duplicates, refetch on a gap).

## 9. Pricing and cost (`server/routes/pricing.js`, `server/lib/pricing-constants.js`)

- Cost is computed at read time from raw token buckets and an editable `model_pricing` table (Claude), plus `gpt_model_pricing` and `cursor_model_pricing` (`pricing.js:93-204`). No cost snapshot is stored per message, so changing a rate reprices history, except for time-limited intro rates (`intro_until`, compared on the usage row's date, `:42-58`).
- Rule matching: longest pattern first, `%` wildcard translated to a regex, case-insensitive, one `new RegExp` per row per rule (`:25-30`, `:94-113`).
- Modifiers: fast mode (explicit fast rates, other categories scaled by ratio), `inference_geo=="us"` x1.1, `service_tier=="batch"` x0.5 (`:60-84`, constants `pricing-constants.js:9-20`). Cache read 0.1x, 5 m write 1.25x, 1 h write 2x are documented constants. Web search $10 per 1000 requests; code execution estimated at a 5 min minimum per request, free with search or fetch, with an org free allowance of 1550 h (`:27-46`).
- Models with no matching rule are reported as `unpriced_models` instead of silently costing 0 (`:110-128`, `:202`), which is a good idea.
- Weaknesses: commercial constants (including a free-hours quota) hard-coded; cost correctness depends on the `token_usage` writer problems in section 6; future rate cards need manual table edits; no long-context (above 200k) tier is modelled for Claude (grep: only GPT has `context_size`; read only). UNVERIFIED against Anthropic's live price list; do not reuse their numbers without checking the current official pricing page.
- Our design: store per-message usage, compute cost as a pure function `(usage, price table at date)`, ship the price table as a versioned data file with `effective_from`, always show unpriced models and label cost as an estimate, and keep cost out of any hot ingest path.

## 10. Retention and cleanup

- Events and sessions: no automatic retention. Manual only: `POST /api/settings/clear-data` (deletes everything, no server-side confirmation, `settings.js:157-171`), and a cleanup endpoint with `abandon_hours` and `purge_days` (only terminal sessions older than N days, `settings.js:455-505`).
- Snapshots: layered policy (lossless gzip of orphaned snapshots after 24 h idle, deletion together with the session, opt-in age and byte caps with tombstones and dry-run), maintenance first run after 2 min then every 6 h (`snapshot-retention.js:1-27`, `:46-60`). Added in response to issue #358 ("deleting it regrows on restart").
- `webhook_deliveries` is trimmed to a bounded count (`db.js:2381`). No `VACUUM` or `wal_checkpoint` scheduling found for the main DB (grep: only `VACUUM INTO` for copies).
- Open CCAM issues #305 (tiered retention with rollup before delete) and #315 (trim payloads) confirm that unbounded growth is their main operational problem.
- Our design: bounded by construction. Cap payload size at the edge, keep raw spool segments for N days, roll up per-session aggregates before deleting old events, run `PRAGMA optimize` and periodic `wal_checkpoint(TRUNCATE)`, expose DB size and row counts in the status endpoint, and test that a synthetic 100k-event database keeps list queries under a fixed budget.

## 11. Security-relevant code

Positive:

- Default bind 127.0.0.1 (`security.js:29-32`, `server/index.js:220`); Host allowlist (anti DNS rebinding) as middleware and in the WebSocket upgrade (`security.js:58-72`, `websocket.js:19`); CORS limited to loopback origins with credentials off (`security.js:80-99`); constant-time token compare with a length precheck (`:137-143`); separate tokens for dashboard, hooks and remote push; header-only token on the internet-facing route (`:163-169`); remote hook transport requires https and a token (`hook-transport.js:26-52`); secrets may come from a file (`security.js:101-112`); `redirect:"error"` on webhook fetches (`webhooks.js:134`).
- MCP: read-only by default, mutations behind `MCP_DASHBOARD_ALLOW_MUTATIONS`, destructive tools behind a second flag plus an exact confirmation token (`mcp/src/policy/tool-guards.ts:84-119`); the HTTP transport has its own token (`mcp/src/transports/http-server.ts:84-143`).

Weaknesses:

- `LOOPBACK_HOSTS` contains `""` and `"0.0.0.0"` (`security.js:26`; the test file asserts this, `security.test.js:50`). Consequences: an empty or `0.0.0.0` Host header passes the Host guard; and starting with `DASHBOARD_HOST=0.0.0.0` makes `boundLoopback` true (`server/index.js:221`), so the "reachable from the network, set DASHBOARD_TOKEN" warning is suppressed (`:242-249`). The Host guard still blocks other names unless allowlisted, so real exposure is reduced, but the warning logic is wrong. Read only.
- Token exemption: `/hooks` is exempt from `DASHBOARD_TOKEN` (`security.js:181`), and `hookGuard` is a no-op unless a separate hook token is set (`:206-213`). With only `DASHBOARD_TOKEN` configured on a LAN bind, `POST /api/hooks/event` is writable by anyone who passes the Host check.
- The dashboard token is also accepted as `?token=` for REST and WebSocket (`:150`, `:223-226`): it ends up in logs and history (they avoid this only on the push route).
- The hook payload's `transcript_path` is trusted: the server reads and parses whatever file path a caller supplies, and stores it (`hooks.js:318-320`, `:959-960`). Any local process can POST to the loopback hook route (no auth by default).
- Path construction from untrusted ids: `claude-home.js:68-142` joins `sessionId`, `agentId` and `runId` into paths with `path.join` and `fs.existsSync` without any character validation (only Cursor ids use `isSafeCursorId`). Probe (section 13): a crafted `agent_id` such as `x/../../../../../../outside/secret` resolved to a `.jsonl` file outside the projects directory at the path-resolution layer. The route layer was not executed, so end-to-end impact (reading any readable `*.jsonl`) is UNVERIFIED, but the validation gap is real. The `/transcript` route takes `agent_id` and `run_id` straight from the query string (`sessions.js:1430-1431`).
- `POST /api/import/scan-path` walks any absolute directory the caller names, and echoes the path in errors (`import.js:318-349`).
- The server can launch `claude` (`run-spawner.js:313`), with `bypassPermissions` among the allowed modes (`run.js:104`), write Claude config (`cc-mutate.js`), and send webhooks to arbitrary http(s) URLs with no private-address filter found (`webhooks.js:105-115`; grep for ssrf, private ranges and 169.254 returned nothing; read only). For a monitor this attack surface is unnecessary.
- Body limit 1 MB (`index.js:96`); WebSocket 64 KiB; no per-route rate limits; no limits on `events.data` growth.
- Privacy: transcripts are copied to the data dir; `events.data` stores full tool inputs and outputs; generated file headers embed the author's absolute home path (for example `mcp/src/policy/tool-guards.ts:9`), a small leak in boilerplate.
- `update-check` ran `git` with inherited `GIT_DIR`; tests committed into a real repository (issue #323: 1,046 files deleted in a downstream fork). A guard test `no-mutating-git-in-tests.test.js` now exists.

Our design should: loopback only (no `0.0.0.0` knob unless explicit and loudly warned), exact Host and Origin allowlists (no empty host, no `0.0.0.0`) for HTTP and WebSocket, token via header only, treat all hook-supplied strings as untrusted (validate ids with a strict regex; resolve paths with `realpath` and require containment under an allowed root, `~/.claude/projects` by default), a read-only API (no spawn, no config write, no import-by-path, no webhooks), a small purpose-built MCP surface (read tools only), and never run `git` in tests without clearing the `GIT_*` variables.

## 12. MCP server (`mcp/src`)

- A separate TypeScript package exposing a catalog of 103 tools (`mcp/README.md` line 3), shared by stdio, Streamable HTTP, legacy SSE and a REPL. 16 domain files in `mcp/src/tools/domains/`.
- Mutation gating: 52 call sites of `assertMutationsEnabled`/`assertDestructiveEnabled` across 13 domain files (grep count). Domains without guards: observability, session-detail, workflow. Mutating domains include run (launches and controls real Claude/Codex processes, README line 146), config, pricing, alerts, webhooks, push, remote, import, maintenance (clear-all-data, prune snapshots), settings.
- HTTP transport: host and port from config, token optional (`http-server.ts:128-143`, `:193`, `:400`).
- Weaknesses: the tool surface mirrors the whole REST API (103 tools is a large prompt and attack surface for an LLM client); policy is enforced per tool by convention, so a new tool can forget its guard (no registry-level `mutating` flag found); no MCP tool annotations (`readOnlyHint`, `destructiveHint`) in `mcp/src` (grep: none).
- Our design: a handful of read-only tools (list sessions, get session, recent events, active agents, usage summary), annotated `readOnlyHint`, with no mutation path at all. If a write tool ever exists, enforce the gate in the registry instead of in each handler.

## 13. Probes I ran (evidence)

Scratch files: `D:/mvp/private/scratch/mcs-v3/probes/torn-line.js` and `traversal.js`. Both only `require` library files of the clone; nothing was installed or started, no ports used.

1. Torn trailing line (`TranscriptCache`): a file with one complete assistant record (input 10, output 5) and a second record cut at 40 bytes with no newline. The first `extract` total (input plus output) was 15. After appending the rest of the second line plus `\n`, the incremental `extract` still returned 15; a fresh cache on the same file returned 32 (the correct total). Conclusion: records straddling a read are lost until the next full read. Observed output: `15`, `15 (correct = 32)`, `32`.
2. Path resolution (`getSubagentTranscriptPath` with `CLAUDE_HOME` pointed at a scratch dir): an `agent_id` of `x/../../../../../../outside/secret` returned a path outside the projects directory (`outside\secret.jsonl` relative to the scratch root), because the flat-layout candidate is `path.join(subagentsDir, "agent-" + agentId + ".jsonl")` and `path.join` normalises lexically. A `runId` of `..` returned null in this setup. The HTTP route was not exercised.

## 14. Test suite overview and what is not covered

- Layout: Node's built-in `node:test` for the server (80 files under `server/__tests__` plus `server/lib/__tests__`), Vitest for the client and MCP. CI runs lint, typecheck and tests, plus a cross-OS matrix (ubuntu, macOS, windows) (`.github/workflows/ci.yml:97-110`), which is worth copying.
- Strong areas: transcript cache (about 35 tests: cache hit, shrink, incremental, LRU, interrupt detection, bounded arrays), usage dedup and repair (`usage-dedup*.test.js`, `token-baseline.test.js`), session liveness (about 25), awaiting-input guards, subagent attribution and nesting up to depth 5 (`api.test.js:3129-3478`), ingest-batch (30+ tests on validation, dedup, ownership, token handling), installer idempotence, security helpers.
- Gaps (searched, none found): duplicate or retried hook delivery; reordered hooks (`PostToolUse` after `Stop`, `SubagentStop` before its spawn); torn or partial transcript tail; a rewrite that grows the file; two parallel same-type subagents; a hook payload with a non-string `session_id` or `transcript_path`; an oversized hook payload (413); path traversal through `agent_id`/`run_id`; uninstall (not implemented); database migration from previous schema versions as a table-driven test; server restart mid-session (cursor loss); Windows-specific liveness behaviour.

## 15. Edge cases to reuse as our own tests

Hooks and ingest:

1. The handler exits within about 3 s with exit code 0 when the server is slow, down, or the port is closed; the event is still delivered when the server is merely slow (their `hook-handler.test.js` pair).
2. The handler with invalid JSON on stdin, empty stdin, and stdin larger than the cap: never throws, never hangs, writes a marked-invalid or truncated record.
3. The same hook payload delivered twice yields one event and one state transition. The same payload delivered out of order (Stop, then a late PostToolUse) leaves the session idle/waiting, not working.
4. `SessionEnd` arriving first or twice; `Stop` after `SessionEnd` does not reactivate a completed session; `UserPromptSubmit` after `abandoned` or `error` does.
5. `SessionStart` with source `compact` mid-turn must not flip a working session to waiting (their comment `hooks.js:803-813`); sources startup, resume, clear do.
6. Notification types: `permission_prompt` blocks, `idle_prompt` does not even though its text says "waiting for your input"; unknown future types fall back to the text pattern (`hooks.js:91-121`).
7. Background subagent tool events must not clear a main-agent wait caused by a permission prompt (`awaiting-subagent-guard.test.js`, 4 cases); a passive `stop` wait may be cleared by a subagent's activity.
8. `PostToolUse` for the Agent tool does not complete the subagent (backgrounding); `SubagentStop` does.
9. Nested subagents depth 1 to 5 with parent inference; an orphaned subagent whose parent is missing; two parallel same-type subagents (we expect exact `agent_id` correlation, CCAM would pick the wrong one).
10. `Stop` with `stop_reason=error` -> error without a waiting flag; a following `Stop` must not reactivate an errored session; `UserPromptSubmit` does.
11. Stale sessions: a session idle past the threshold becomes abandoned but is reactivated by the next event; an alive but quiet session is not killed by another session's SessionStart (decide our rule and test it).
12. Interrupt (Esc) with no hook: the transcript tail shows an interrupt newer than the last turn -> idle; interrupt before any output; user resumes after the interrupt -> not pending (`transcript-cache.test.js`, 9 interrupt cases); the idle-working timeout is exempt while a tool is in flight.
13. API error at the transcript tail vs a recovered error: the session shows error only while unrecovered; repeated identical terminal errors do not rewrite or re-broadcast on every poll (`hooks.js:1709-1714`).
14. Batch input: oversized batch (413 before any DB work), batch exactly at the limit, per-item errors do not roll back valid items, negative/fractional/unsafe-integer counters, `cacheWrite1h > cacheWrite`, malformed uuid and timestamp, foreign-session agent id, schema version mismatch, a pushed id cannot hijack a local session (`ingest-batch.test.js`).
15. A broadcast carries exactly the persisted timestamp, and only after commit (`ingest-batch.test.js`: "broadcasts the SAME created_at it persisted", "only after it is persisted").

Transcripts and usage:

16. One message split across several records counts once; the last record wins when usage evolves (partial then final); id-less records are counted; the final record of a message arrives in the next incremental read; each record in its own incremental read (`usage-dedup.test.js`).
17. Thinking blocks counted per record while usage is counted per message id; the `<synthetic>` model skipped; multiple models in one file; a mid-session `/model` switch; cache read, and cache write 5 m vs 1 h split.
18. Compaction (file shrinks) forces a full re-read and never loses pre-compaction usage under our design; same-size rewrite; a growing rewrite (our addition, CCAM would fail).
19. A torn last line that completes later (our regression test for the bug in section 13); CRLF line endings; a line larger than the cap; a multibyte character split across a chunk boundary; an empty file; a file deleted between stat and open.
20. Subagent transcripts: flat layout plus nested workflow layout; same-model subagent tokens included in session cost (issue #345); a missing or partial subagent file never fails the main parse and is retried later; importing twice does not duplicate rows or tokens (`subagent-attribution.test.js`, `usage-dedup-import.test.js`).
21. First human prompt extraction ignores tool results, meta entries, slash-command plumbing, compact summaries and interrupt markers (`transcript-cache.js:77-116`); title precedence: custom title beats ai title.
22. Turn durations: equal durations without ids stay distinct; replays do not inflate counters (`turn-duration-ingest.test.js`).

Cost:

23. An unpriced model surfaces in `unpriced_models` rather than costing $0; wildcard rule precedence (longest match); 1 h cache split; fast, US-residency and batch modifiers; intro-price cutoff by usage date; the grand total equals the sum of per-bucket costs (`pricing-calc.test.js`, `usage-dedup-import.test.js:449`).

Installer and security:

24. Installer: empty, missing and corrupt settings; existing unrelated hooks preserved; re-install is a no-op; uninstall restores the original; refuse inside a container; paths with spaces (`install-hooks.test.js`).
25. Host guard: `localhost:port`, `127.0.0.1`, `[::1]` accepted; foreign names rejected, and (our stricter rule) empty Host and `0.0.0.0` rejected; the WebSocket upgrade enforces the same; CORS refuses non-loopback origins; token comparison with different lengths; a query-string token rejected (`security.test.js`, `ingest-batch.test.js`).
26. Path safety: `agent_id`, `run_id`, `session_id` containing `..`, separators, NUL, absolute paths or drive letters never resolve outside the allowed root (new).
27. Large-history scale test: 100k or more events and 10k agents; list queries stay under a budget (issues #317, #319); a 700 KB hook payload is trimmed before storage (issue #315).
28. No test may mutate the real repository or settings: clear `GIT_*` env in git-using tests, use a temp `CLAUDE_HOME` (issue #323).

## 16. Recommended architectural differences (summary for our ADRs)

1. Ingest = a spool file written by a dependency-free handler, plus an idempotent reader. Event identity and per-session sequence are first class. (Fixes: lost events, duplicates, ordering.)
2. State is a pure, table-tested reduction over the event log, recomputable. Correlate subagents by ids, not names. (Fixes: heuristic attribution, flicker.)
3. Usage stored per message id with totals by query; persisted tail cursors with head fingerprints; torn-line safe. (Fixes: double counting, torn lines, restart cost, baseline hacks.)
4. Persist, then broadcast, with `seq` and replay. (Fixes: phantom events, gaps after reconnect.)
5. Read-only by design and loopback-only; strict ids, containment checks, exact Host/Origin allowlists. (Fixes: control-plane exposure, traversal, warning logic.)
6. Explicit install/uninstall of hooks with backup and atomic write; never at server start. (Fixes: silent settings edits.)
7. Bounded storage by construction: payload cap at the edge, rollups, scheduled checkpoint and vacuum, DB size in status. (Fixes: the 2 GB database class of problem.)
8. Versioned migrations with fixture databases, no import-time work. (Fixes: ad-hoc schema drift.)
9. A small MCP surface, read-only, annotated. (Fixes: 103-tool sprawl.)
10. Windows is a first-class target: CCAM has no liveness signal there, so we need our own (process id from the hook, verified before use) and cross-OS CI.

## 17. UNVERIFIED items

- Whether Claude Code writes duplicate assistant messages (same `message.id`) across resumed, forked or subagent transcripts, and whether `requestId` should join the dedup key. CCAM does neither; no evidence either way here.
- The current Claude Code names and payload fields: spawn tool name (`Agent` vs the older `Task`), presence of `agent_id`, `tool_use_id`, `SubagentStart`, `PreCompact` and other events in hook payloads. CCAM's comments claim `SubagentStop` supplies `agent_type`, `agent_id`, `description`, `last_assistant_message` (`hooks.js:747-749`); I did not check Anthropic's documentation here (another research task covers it).
- End-to-end exploitability of the `agent_id`/`run_id` path issue through the HTTP route, and of arbitrary `transcript_path` reads (resolver level reproduced only).
- Whether the `0.0.0.0` bind warning suppression is reachable in practice (read only).
- SSRF exposure of webhook targets (read only; no private-range filter found by grep).
- Runtime behaviour of CCAM on Windows: not run. I did not install dependencies or start the server (rule: no ports, no processes), so server routes, SQLite behaviour and the React client were analysed by reading only.
- The rewrite-that-grows failure mode of the transcript cache (inferred from code, not reproduced).
- Pricing constants and rates: not compared with Anthropic's current price list.

## Verification log (2026-10-11)

Adversarial pass against the scratch clone at commit a06db03 (package.json 2.3.0) and the GitHub REST API. No claim needed correction; no private text or secrets found (regex scan for emails, key prefixes, user paths: no hits).

| Claim | Verdict | Evidence |
|---|---|---|
| Hook handler is fire-and-forget, 2500 ms hard exit, always exit 0 | confirmed | `scripts/hook-handler.js:61-69` (`process.exit(0)` after send, `setTimeout(..., 2500)`); `hook-transport.js:83` `timeout: 2000` |
| No event idempotency (0 UNIQUE in db.js, 0 `tool_use_id` in hooks.js, unconditional insertEvent) | confirmed | `grep -c UNIQUE server/db.js` = 0; `grep -c tool_use_id server/routes/hooks.js` = 0; `db.js:1896-1898` plain INSERT |
| Main route broadcasts inside the transaction | confirmed | `hooks.js:494` `db.transaction(...)`; `broadcast(` calls at 546, 624, 735 inside; batch route has `pendingBroadcasts` (`:2350`) |
| Torn trailing line is lost on incremental read | confirmed (re-run) | `probes/torn-line.js` output: incremental 15, correct 32, fresh read 32. Code: `transcript-cache.js:371-377`, `_consumeLine` swallows JSON.parse error (`:453-458`), `bytesRead: stat.size` at `:169`, `:232` |
| Usage dedup by message.id, 1000-entry window | confirmed | `token-usage.js:132` `USAGE_RECONCILE_WINDOW = 1000`; `transcript-cache.js:62` default 1000; subtract-then-add by `usageMsgId` |
| Baseline plus high-water upsert for token_usage | confirmed | `db.js:1983-2007` `ON CONFLICT ... baseline_* = MAX(...)` |
| Issues #293 (closed), #315 (open), #305 (open), #345 (closed), #323 (closed) and their titles | confirmed | `curl api.github.com/repos/hoangsonww/Claude-Code-Agent-Monitor/issues/N` |
| `data.agent_id` never read in hooks.js; spawn tool matched by literal `Agent` | partly corrected | `grep -c agent_id hooks.js` = 20, not 0: the "0 matches" in the orientation summary refers to the SubagentStop path only; this file's text states only the SubagentStop scope. Literal `"Agent"` at `hooks.js:587` confirmed |
| Process-liveness reap disabled on win32; 180 min sweep | confirmed | `server/lib/session-liveness.js:64`; `index.js:1490-1498` default 180 |
| LOOPBACK_HOSTS includes `""` and `0.0.0.0` | confirmed | `server/lib/security.js:26` |
| Installer: substring match, first match replaced, direct writeFileSync, no uninstall, runs at server start | confirmed | `install-hooks.js:114,169,183`; `index.js:1466-1471`; grep for "uninstall" finds only unrelated crash-guard functions in `cc-watcher.js` |
| 17 tables, 36 indexes, 2454-line db.js, no user_version, WAL/FK/busy_timeout | confirmed | 17 distinct `CREATE TABLE` names (22 raw matches include rebuild temp tables); `grep -c "CREATE.*INDEX"` = 36; `wc -l` = 2454; no `user_version`; `db.js:135-136` |
| MCP: 103 tools, 52 guard call sites in 13 of 16 domain files, no annotations | confirmed | `mcp/README.md:3`; `grep -rnE "assert(Mutations\|Destructive)Enabled\("` excluding comments = 52 in 13 files; 16 files in `domains/`; zero `annotations`/`readOnlyHint` in `mcp/src` |
| WebSocket 64 KiB maxPayload, 30 s heartbeat; 1 MB JSON body limit | confirmed | `websocket.js:17,52`; `index.js:96` |
| Pricing claims (section on rates) | unverifiable here | Not re-checked against Anthropic's price list; stays UNVERIFIED as the file already says |

Citation note: the clone keeps `transcript-cache.js`, `token-usage.js`, `security.js`, `session-liveness.js` and `run-spawner.js` under `server/lib/`, not `server/`. The file:line numbers are correct for those files.
