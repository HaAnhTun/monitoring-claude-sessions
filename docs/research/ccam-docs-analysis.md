# CCAM documentation analysis

Research input for the Node.js + TypeScript + React migration of the `monitoring-claude-sessions` skill.
Scope: what the Claude Code Agent Monitor (CCAM) documentation says it does. Not a code audit.

## 0. Provenance and method

- Reviewed on 2026-10-11. Repo default branch `master`, commit `a06db038a93b4d7316492dc55758f597e104894c` (2026-10-09T19:19:29-07:00, "Merge pull request #365 from hoangsonww/chore/release"). Shallow clone, in scratch.
- Wiki git repo commit `49e2722517812f801ff9f430fd3e0cedd6a2c0db` (2026-08-13T11:06:20-07:00).
- Commands run: `git clone --depth 1` of `https://github.com/hoangsonww/Claude-Code-Agent-Monitor.git` and `...Claude-Code-Agent-Monitor.wiki.git`; `curl -sL https://hoangsonww.github.io/Claude-Code-Agent-Monitor/wiki/` (HTTP 200, 403,067 bytes); `cmp` showed that page is byte-identical to `wiki/index.html` in the repo.
- Documents read (URLs are the canonical view of each file):
  - https://hoangsonww.github.io/Claude-Code-Agent-Monitor/wiki/#overview (static localized wiki; text extracted and read for Features, Hook Integration, Import, Remote Sources, Security, Performance)
  - Wiki pages: Home, Core-Concepts, Hook-Health-and-Ingestion, Documentation-Map (all four fully), plus Tokens-Costs-and-Analytics, Backups-Restore-and-Retention, Security-and-Remote-Access, Reading-the-Dashboard, Kanban-and-Task-Progress, Investigating-Sessions-and-Agents (https://github.com/hoangsonww/Claude-Code-Agent-Monitor/wiki/<Page>)
  - https://github.com/hoangsonww/Claude-Code-Agent-Monitor/blob/master/{docs/HOOKS.md, ARCHITECTURE.md, docs/API.md, docs/DATABASE.md, docs/MCP.md, SETUP.md, README.md}
  - Also read because they carry the state machines, config table and hook table that the listed files point to: `README-EN.md` (sections "How It Works", "Configuration", "API Reference", "Hook Events") and the `openapi.yaml` path list.
- Secondary source-code spot checks (two greps only, labelled "src" below): `scripts/install-hooks.js` (hook list, entry shape), `server/routes/hooks.js` (compaction dedup key). Everything else is documentation, not verified against code.
- Citation shorthand: `H`=docs/HOOKS.md, `A`=ARCHITECTURE.md, `D`=docs/DATABASE.md, `API`=docs/API.md, `M`=docs/MCP.md, `S`=SETUP.md, `R`=README.md, `RE`=README-EN.md, `W:<Page>`=wiki page, `SW`=static wiki page. `H:339` = line 339. `A:343` means the "Server Components" module table that starts at ARCHITECTURE.md line 343 (rows are very long; the row is named in the text). Line numbers are exact for single-line facts and approximate (start of the section) for ranges.
- Not verified at all: CCAM runtime behavior (never installed or run), the real Claude Code hook payloads (another agent's task), anything about Claude Code 2.1.289.

## 1. Summary (what matters for our design)

1. CCAM is hooks first, with transcript parsing for everything hooks cannot carry. Hooks give state changes; the JSONL transcript (read incrementally from `transcript_path`) gives tokens, titles, compactions, API errors, turn durations and Esc interrupts. A background importer is the recovery path. This matches our intended shape. [W:Core-Concepts, A:226-262, H:630-668]
2. The hardest-won correctness knowledge is in token accounting and in "who is really alive". Per `message.id` last-record-wins usage reconciliation (fixes a 2-4x over-count), monotonic high-water baselines for compaction, watchdog recovery for hooks that never fire (Esc, killed terminal, API error). These are the items to adopt first. [A:1434-1500, H:672-690]
3. The documentation is internally inconsistent in many places (Section 2 lists 22). Several older sections describe a schema, endpoints and payloads that no longer exist. Treat `README-EN.md` hook/state tables, `ARCHITECTURE.md` module table and `DATABASE.md` DDL blocks as the newest; treat `HOOKS.md` payload examples, `API.md` WebSocket/session examples and the `DATABASE.md` ER diagram as stale.
4. Much of CCAM is scope we reject (Electron, Docker/K8s/Terraform, SSH remote sources, remote push, 14 webhook providers, Cursor/Codex providers, plugin marketplace, 103-tool MCP, Config Explorer, Run Agent). Section 14 has the decisions.
5. CCAM stores prompts: `card_prompt_preview` keeps the two newest human prompts, `events.data` is "Full event JSON", snapshots copy whole transcripts. Our rule "never copy prompt text into outputs" means we must decide explicitly what to persist. [D:181-215, A:944-947]

## 2. Contradictions and vague spots register

Each item says which sources disagree. "Newest wins" is my judgement from internal evidence, not a statement by the authors.

| # | Topic | Disagreement | Likely truth |
|---|---|---|---|
| C1 | Number of hooks | 7 in SW overview ("7 Hook types captured"), S:23-33 JSON, RE:506 note; 8 in H:339-545, A (hooks.js row), RE hook table (adds `UserPromptSubmit`). src `scripts/install-hooks.js:87-95` lists 8 (5 with matcher, `SessionStart`/`SessionEnd`/`UserPromptSubmit` without). | 8 |
| C2 | Hook wire format | H examples use `{"type":"sessionStart","sessionId":...,"timestamp":...}` (camelCase, invented fields such as `durationMs`, `inputTokens`). RE:1097-1108 and A:228-262 use `{"hook_type":"PreToolUse","data":{"session_id":..,"tool_name":..,"tool_input":..}}` (Claude Code's own snake_case payload wrapped by the handler). | RE/A. H payloads are illustrative only. |
| C3 | Hook endpoint | H:85 sequence diagram `POST /hooks/{type}`; H:605 code sample `/session-start`; API:1736 sequence `POST /hooks/post-tool-use`. Everywhere else: single `POST /api/hooks/event` (A:228, RE:1093, openapi). | `/api/hooks/event` |
| C4 | Hook implementation | H:154-200 (installation) and H:714-748 (error handling) describe Python scripts copied to `.githooks/*.py` that exec `node hook-handler.js`. S, A, RE, src: `settings.json` entries run `node "<path>/hook-handler.js" <HookType>` directly. | Direct node entry |
| C5 | Handler time limits | H:553-575: 2.5 s safety net. A:1218-1250 and SW: 3 s per-target HTTP timeout + 5 s process-wide safety net. H:136 (diagram): "5s Timeout". H:698 error diagram says "Log + Exit 1" while H:748 says "Always exit 0 to avoid blocking". | Always exit 0. Code at the reviewed commit (src `scripts/hook-handler.js:69` `setTimeout(() => process.exit(0), 2500)`; `scripts/hook-transport.js:83` request `timeout: 2000`) matches H (2.5 s safety net), not the 3 s / 5 s in A and SW, which are stale. Corrected 2026-10-11 |
| C6 | Agent status enum | D:257-270 DDL: `idle,connected,working,completed,error` and says Waiting is "not a persisted status". A:925 ER and RE:531-559: `working,waiting,completed,error`, "waiting is now a real persisted status". D:80-100 old ER: `running,completed,failed`. | RE/A (waiting persisted) is newer by wording ("now"); D DDL may be stale. UNVERIFIED |
| C7 | Session/agent schema | D ER diagram and D indexes (`sessions.session_id`, `total_cost`, `agents.agent_id`, `tool_executions`, `notifications`, `pricing_rules`, `PRAGMA user_version` migrations, `SCHEMA_VERSION = 3`) vs D DDL blocks and A ER (`sessions.id`, `events`, `token_usage`, `model_pricing`; migrations are `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE`, A:351). The old ER also appears in API.md WebSocket examples (`id:1, session_id:"sess_abc123", total_cost`). | A ER + DDL |
| C8 | WebSocket type names | API:1552-1636 dotted legacy names (`session.created`, `agent.updated`, `tool.executed`, `notification.received`). A:1140-1150 and RE:1302: `session_created`, `session_updated`, `agent_created`, `agent_updated`, `new_event`, `alert_triggered`, `alert_updated`, `workflow_upserted`; only `remote_source.status`, `remote_data.updated`, `import.progress` are dotted. | A/RE snake_case set |
| C9 | Compaction baseline algorithm | SW import page: "if new input_tokens < existing, move existing into baseline_* and add new on top". A:1446-1466: that formula "ratcheted" a 26-day session to ~11x real usage; now `baseline := max(old_live + old_baseline - new_live, 0)` so `effective = max(old_effective, new_live)`. | A (corrected) |
| C10 | Default DB location | D:62-65: canonical `~/.claude/agent-dashboard/dashboard.db`, repo `./data/dashboard.db` migrated on first launch. S:89-95 table and S "Database" say `data/dashboard.db`; A:387 (CLI offline row) reads `data/dashboard.db`; API:1342 snapshot paths under `~/.claude/agent-dashboard/`. | D (canonical home dir) for current builds |
| C11 | Remote sync interval | A:347 (index.js row): `DASHBOARD_REMOTE_SYNC_MS` default 60000. RE config table and SW: 15000. | 15000 (two sources, newer table) |
| C12 | Hook install | S:21-33: "server configures hooks automatically on startup ... writes to settings.json every time it starts". H:130-160, A:1254-1283, W:Hook-Health: interactive installer / first-visit gate, warns before replacing dashboard-owned entries. Desktop app installs on first owned boot (S). | Both exist (server bootstrap + installer). Docs do not say when each applies. Vague |
| C13 | Startup import | S "Importing" says the dashboard imports `~/.claude/projects` "on every startup". A:1351: startup auto-import is one-time, gated by `.legacy-import.done`, plus continuous `syncDefaultProjects` (immediate sweep, debounced `fs.watch`, 30 s poll). | A |
| C14 | Dependency surface | A:2746 "5 runtime server deps, 6 client deps" vs R badges and S/A mention express, ws, cors, uuid, multer, adm-zip, tar, web-push, swagger-ui-express, better-sqlite3, redoc. | The "5" is stale |
| C15 | Query-string tokens | API:65-90: `?token=` accepted for `DASHBOARD_TOKEN`; A:2745 and H:104-115: `?token=` rejected for remote push because it lands in logs. Inconsistent threat model across routes. | Both true per route |
| C16 | "Stale" vs "abandoned" | W:Reading-the-Dashboard has a "Stale" state; schema enum is `abandoned`. SW Kanban lists `working, waiting, completed, error, abandoned`. | Same thing, UI naming differs. Vague |
| C17 | API conventions | API:1753-1815 error shape `{error, code, details}` with `VALIDATION_ERROR`/`NOT_FOUND`/`DUPLICATE_PATTERN`; real codes elsewhere: `EUNAUTHORIZED`, `EBADHOST`, `INVALID_INPUT`, `INVALID_PRUNE_REQUEST`, `EXTRACTION_LIMIT_EXCEEDED`, `REMOTE_PUSH_NOT_CONFIGURED`, `BATCH_TOO_LARGE`. HTTP table (API:1767) lists no 401/403/413/503. API:1838-1860 pagination example shows `has_more`, list examples in API:200-260 do not. | No single convention is documented |
| C18 | Endpoint inventory gaps | `/api/events`, `/api/stats`, `/api/analytics`, `/api/health` appear only in RE, openapi and mentions in API prose, with no API.md sections. API.md documents `/api/tools` which is not in the 99-path openapi list. `/api/workflows/runs` is in openapi and A but not API.md. | openapi.yaml is the closest to complete |
| C19 | Latency claims | H:779-787 "<100 ms total, ~70 ms"; SW "<50 ms"; A:2755 "<5 ms cache hit, <50 ms miss". Unmeasured, different scopes. | Marketing numbers: UNVERIFIED |
| C20 | PostToolUse cost | H:230-260: cost = input/1M*in + output/1M*out from hook token counts. A:343 (pricing row): per-bucket (model, speed, geo, tier) with cache-read, 5m/1h cache-write, modifiers, server-tool fees, computed on read from `token_usage`. | A |
| C21 | `stop_reason` | H:454-475 and RE: `Stop` with `stop_reason="error"` marks error. Nothing documents that Claude Code's Stop payload carries `stop_reason`; errors are also found by the transcript watchdog (`isApiErrorMessage`). | UNVERIFIED against real Claude Code payloads |
| C22 | Liveness on Windows | H:681-690 (and RE:506-520): process probe returns "no answer" on Windows and in containers, so dead-session reap never runs there; S ships a Windows desktop app. | Windows users rely on stale sweep only (180 min default). Relevant: our machine is Windows |

## 3. Data model (documented)

Engine: SQLite via `better-sqlite3`, fallback `node:sqlite` through a `compat-sqlite.js` wrapper (A:351, S "Troubleshooting"). Pragmas: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000` (A:1112-1118). D:836-845 also lists `synchronous=NORMAL`, 64 MB cache, `mmap_size` 30 GB; those appear only in a code sample inside the stale part of D, treat as UNVERIFIED. One writer: Helm schema and Kustomize force 1 replica (A:2920).

Core tables (A ER 917-1085, D DDL 181-340):

| Table | Key fields | Notes |
|---|---|---|
| `sessions` | `id` (Claude session UUID), `name`, `status` CHECK `active/completed/error/abandoned`, `cwd`, `repo_remote_url` (credential-stripped, first writer wins), `model`, `provider` (`claude/cursor/codex`), `started_at`, `ended_at`, `metadata` JSON, `card_prompt_preview`, `updated_at`, `awaiting_input_since`, `awaiting_reason` (`notification/stop/session_start/interrupted`), `transcript_path`, `source` (`local` or remote id) | `updated_at` is bumped on every event and so is not "last activity"; list rows expose `last_activity` = newest durable event (API:197-199) |
| `agents` | `id` (`<session_id>-main` or UUID; imported subagents `<sid>-jsonl-<agentId>`), `session_id` FK cascade, `name`, `type` main/subagent, `subagent_type`, `status`, `task`, `current_tool`, `started_at`, `ended_at`, `parent_agent_id` (FK, SET NULL), `metadata` (`model`, `tokens[]` per-subagent buckets), `awaiting_*`, `workflow_run_id`, `workflow_phase` | Compaction is modelled as a pseudo-subagent of `subagent_type = compaction` (RE hook table) |
| `events` | autoincrement `id`, `session_id`, `agent_id`, `event_type`, `tool_name`, `summary`, `data` (full event JSON), `created_at` | Single timeline table. Types include hook names plus synthetic `Compaction`, `APIError`, `TurnDuration`, `ToolError`, `Interrupted`, `RemoteToolEvent`, `RemoteTurn`, `TaskCreated`, `TaskCompleted`, Codex `codex_*` (RE:1328-1349, A:343 task-progress row) |
| `token_usage` | PK (`session_id`, `model`, `speed`, `inference_geo`, `service_tier`); `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cache_write_1h_tokens`, `web_search_requests`, `web_fetch_requests`, `code_execution_requests`, `baseline_*` per metric | The 5-part PK is the pricing dimension. `service_tier='workflow'` is a namespaced bucket for Workflow-tool fleets (A:1763) |
| `model_pricing` | `model_pattern` PK (SQL LIKE, longest first), `display_name`, input/output/cache_read/cache_write/cache_write_1h per Mtok, fast-mode in/out, `intro_*` and `intro_until` (YYYY-MM-DD) | Separate `cursor_model_pricing`, `gpt_model_pricing` (short/long split at 272,000 input tokens, plus fast variants) (D:404-505) |
| `workflows` | `run_id` PK, `session_id` FK, `status`, `phases`/`progress` JSON, `source` `journal`/`live` | A:1835-1843 |
| `alert_rules`, `alert_events`, `webhook_targets`, `webhook_deliveries` | See Section 12 | alert_events keeps no FK to sessions so history survives purge |
| `remote_sources` | SSH host, ports, per-provider status | Out of scope for us |
| `codex_ingest_state`, `codex_tool_ingest_state` | Durable byte cursor + remainder + cumulative token snapshot per rollout | The pattern is relevant: append-only JSONL consumption with a persisted byte offset makes hook, watcher and poll triggers idempotent (D:507-513) |
| `push_subscriptions`, `dashboard_runs` | Web push, Run Agent history | Out of scope |

Indexes worth copying in spirit (A:1088-1110, D:565-640): `events(session_id, created_at)`, `events(agent_id, created_at)`, `events(agent_id, event_type)`, partial `events(tool_name) WHERE tool_name IS NOT NULL` (an unindexed GROUP BY took 45.7 s on a 3.9M-row table because the driver is synchronous), partial `sessions(status, transcript_path) WHERE status='active' AND transcript_path IS NOT NULL`. Lesson recorded by the authors: partial indexes only match if the query repeats the predicate literally.

Files besides the DB (A:1632-1685): `transcripts/`, `cursor-transcripts/`, `codex-transcripts/` snapshot roots; marker files `.legacy-import.done`, `.token-repair-v2.done`; `~/.claude/.agent-dashboard.json` discovery registry.

## 4. Hooks: list and documented behavior

Registered events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `Notification`, `SessionEnd` (src `scripts/install-hooks.js:87-95`; entries use `matcher: "*"` for Pre/PostToolUse, Stop, SubagentStop, Notification; none for the other three). The installer sets no `timeout` and no async flag on entries (src `makeHookEntry`, lines 97-110). CCAM does not register any other Claude Code hook event (it never mentions e.g. subagent start, tool failure, pre-compact or permission events): UNVERIFIED whether those exist in Claude Code 2.1.289, that is for the hook-docs research task.

| Hook | Documented effect (H:339-545, RE:1328-1349) |
|---|---|
| `SessionStart` | Create session + main agent on first contact. `source` startup/resume/clear: stamp `awaiting_input_since` with reason `session_start` (shows Waiting). `source=compact` fires mid-turn so the flag is left untouched. Reactivates completed/abandoned sessions on resume. Also sweeps other `active` sessions idle longer than `DASHBOARD_STALE_MINUTES` (default 180) to `abandoned`, agents to `completed`. |
| `UserPromptSubmit` | Clear waiting flag and reason together; main agent to `working` (the only signal for text-only replies that make no tool call). |
| `PreToolUse` | Clear waiting; agent `working`; set `current_tool`; if tool name is `Agent`, create a subagent row (parent assumed main until reconciled). Also recovers `error` sessions. |
| `PostToolUse` | Clear waiting (covers approval of a permission prompt mid-tool); clear `current_tool`; refresh tokens from the transcript cache; update cost. |
| `Stop` | Non-error: main agent to waiting, stamp `awaiting_reason=stop`; background subagents keep running. `stop_reason=error`: session and agent to `error`. Also reactivates completed/abandoned imports. |
| `SubagentStop` | Match finishing subagent by description, type or task, set `completed`. Does NOT clear waiting. Then a fire-and-forget scan of `subagents/agent-*.jsonl` pairs `tool_use` with `tool_result` by `tool_use_id`, emits per-tool Pre/Post events under the subagent's own agent id, stamps the subagent's own model and token buckets, and re-parents nested subagents from `toolUseResult.agentId`. Merge into a live hook row by `subagent_type + started_at` within 30 s. |
| `Notification` | Log. If message matches patterns (`permission`, `waiting for input`, `needs your approval`, `awaiting your response`, ...) stamp waiting with reason `notification` and set agent waiting. Compaction-like messages are tagged `Compaction`. |
| `SessionEnd` | Clear waiting; complete session and agents, unless the session is `error` and that error is still unrecovered at the transcript tail (`isErrorAtTail`), then keep `error`. Evict transcript cache entry. |
| Synthetic (not hooks) | `Compaction` (JSONL `isCompactSummary`, dedup by uuid, src `hooks.js:991-994` key `<sid>-compact-<uuid>`), `APIError` (`isApiErrorMessage` and raw `type:"error"`; immediately marks session and agent `error`), `TurnDuration` (`system` subtype `turn_duration`), `ToolError` (`toolUseResult.is_error`), `Interrupted`. |

Handler (A:1218-1250, H:553-600):
- Reads stdin to EOF, wraps as `{hook_type, data}`; unparseable input is wrapped as `{raw: ...}`; POST to `127.0.0.1:<port>/api/hooks/event`; always exit 0; never waits for the response body (resolves on flush); 2 s per-target request timeout and 2.5 s process safety net in code (A and SW say 3 s / 5 s; see C5).
- Port resolution: `CLAUDE_DASHBOARD_PORT` override (single target, no fan-out) > `~/.claude/.agent-dashboard.json` registry (servers append `{port,pid,startedAt,dataDir}` at startup, handler prunes dead PIDs, posts one request per unique `dataDir`, lowest port wins) > fallback 4820.
- Remote mode (`CCAM_DASHBOARD_URL`): non-loopback must be HTTPS and carry `x-ccam-hook-token`; server checks it in constant time against `DASHBOARD_HOOK_TOKEN`. The `/api/hooks` path is exempt from `DASHBOARD_TOKEN` (loopback-only trust; GHSA-gr74-4xfh-6jw9).
- Servers refuse to install from inside a container (issue #193) because the written path would not exist on the host.

## 5. Ingestion and health semantics

Documented paths into the DB:
1. Live hooks (`POST /api/hooks/event`), one SQLite transaction per event: `ensureSession`, state transition, `insertEvent`, COMMIT; then WebSocket broadcast and alert evaluation after commit and after the HTTP response (A:228-262, A alerts row).
2. Shared transcript cache read on every event carrying `transcript_path` (Section 8).
3. History importer `parseSessionFile` + `importSession` (the same code as live, "no import math distinct from live math", A:1298-1312): startup, continuous `syncDefaultProjects` (mtime-fingerprinted; immediate, debounced `fs.watch`, `DASHBOARD_SESSION_SYNC_MS` poll default 30 s; recursive watch only on macOS/Windows, per-folder on Linux), manual rescan, scan-path, archive upload (zip/tar/tgz/gz with path-traversal and size caps).
4. Workflow journals poll (`DASHBOARD_WORKFLOW_POLL_MS`, ~12 s, A:1765).
5. SSH remote mirror and `ingest-batch` push (rejected for us).

"Health" in the docs is about the pipeline, not a score:
- W:Hook-Health-and-Ingestion: install hooks on the producer host; local check = start a short session and see it appear; diagnose by layer (provider hook config, wrapper execution, network/TLS, auth 401/403, persistence, client update/WebSocket). Recovery after a gap: `npx ccam import rescan`, "re-import rather than fabricate hook events", never make the wrapper block.
- W:Core-Concepts four-question model: producer generating? CCAM receiving? server storing? client showing newest stored state? Live state vs durable history are different things.
- Hook failures are invisible by design (exit 0, fire-and-forget, no retry, no queue, no on-disk spool): the docs never describe a hook delivery log or an ingest-health endpoint, only `GET /api/health` returning `{status:"ok", timestamp}` (RE:1032-1036) and `GET /api/settings/info` ("per-provider hook status", A settings row). A gap is repaired by transcript re-import. This is a documented weakness, not a feature.
- `GET /api/metrics` Prometheus exposition: `ccam_up`, `ccam_sessions{status}`, `ccam_agents{status}`, `ccam_events_total`, `ccam_tokens_total{kind}`, `ccam_websocket_clients`, uptime, RSS (API:673-715).

Background jobs (A:347 `server/index.js` row, H:672-690):
| Job | Cadence | What |
|---|---|---|
| Error/interrupt watchdog | 15 s | For `active` sessions (and, newer, `error` ones) with no hook for >10 s: re-read transcript for API errors; detect Esc interrupt; clear stale `error` when the transcript has moved past the last error; sync session name; liveness reap (below) |
| Maintenance / stale sweep | quarter of `DASHBOARD_STALE_MINUTES` clamped 60 s..5 min | Abandon sessions idle >180 min; evict cache; scan for new compactions via `sessions.transcript_path` |
| Liveness reap | at startup, +5 s, then each watchdog tick | Complete an `active` local session whose `cwd` has no live `claude` process (`ps -Ao pid=,args=` + `lsof`/`/proc/<pid>/cwd`); gated by `DASHBOARD_LIVENESS_IDLE_SECONDS` (60) on ticks, ungated at startup; skipped on Windows, in containers, for non-POSIX-absolute `cwd`, remote sessions, or `DASHBOARD_LIVENESS_PROBE=0`; writes synthetic `SessionEnd` with `data.source="liveness-probe"` |
| Session file sync | 30 s + fs.watch | See ingestion path 3 |
| Snapshot retention | first ~2 min after boot, then 6 h | Section 12 |
| Alert time rules | 60 s | `inactivity`, `status_duration` |
| Update check | 5 min default | Out of scope |

## 6. Session and agent lifecycle (the actual rules)

Two layers (RE:531-593, D:216-250):

Session persisted `status`: `active | completed | error | abandoned`. "Waiting" is a UI overlay: `status=active` and `awaiting_input_since IS NOT NULL`; the overlay is ignored on non-active sessions. The list API cannot filter by waiting; clients filter `status=active` and inspect the field (API:149).

| From | Trigger | To |
|---|---|---|
| none | first hook / import | `active` (+ waiting stamp if SessionStart startup/resume/clear) |
| waiting | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | active, flag cleared |
| active | `Stop` (non-error), permission/input `Notification`, Esc recovery | waiting (flag + reason stamped) |
| active/waiting | `Stop` with `stop_reason=error`; watchdog finds API error (401, rate limit, quota) | `error` |
| error | `UserPromptSubmit` or `PreToolUse`; or watchdog sees transcript progressed past last API error | active |
| active/waiting | `SessionEnd`, or liveness reap | `completed` (but `error` kept if still unrecovered at tail) |
| active/waiting | no activity > `DASHBOARD_STALE_MINUTES` (180) | `abandoned`, agents `completed` |
| completed/error/abandoned | any new work event (including Stop/SubagentStop on imported rows) | `active` |

Agent `status` (see C6): `working | waiting | completed | error` per RE/A; D says `idle | connected | working | completed | error`. Subagents are `completed` by `SubagentStop`/`SessionEnd`; main agent mirrors the session flag. `current_tool` is set on `PreToolUse` and cleared on `PostToolUse`.

Waiting reasons (`awaiting_reason`): `session_start`, `stop`, `notification`, `interrupted`. Stamp and clear always change together; `SubagentStop` never clears; `compact`-source `SessionStart` never touches.

Esc handling (H:672-680): Esc emits no hook. Recovered two ways: (a) marker path, the transcript gets a user entry `[Request interrupted by user]` (with `interruptedMessageId`); `pendingInterrupt` is computed purely from transcript ordering (latest interrupt vs latest real turn activity, both on Claude Code's clock) and is explicitly NOT compared to hook timestamps because the clocks differ; (b) idle-working timeout: main agent `working`, `current_tool` null, neither hook nor transcript mtime advanced for `DASHBOARD_WORKING_IDLE_SECONDS` (120). Both land in Waiting with reason `interrupted` and an `Interrupted` event. Streaming turns (growing transcript) and in-flight tools are exempt. A false flip self-heals on the next hook.

Lost `SessionEnd` (H:681-690): hooks are fire-and-forget, so a monitor that was down misses terminal events; recovered by the liveness reap and the stale sweep. Every guard is described as "false completion self-heals on next hook".

Codex rules (hook-only sessions, byte cursors, `awaiting_reason=interrupted` not promoted to terminal, silence is not a trigger because a tool call can emit zero hooks for 12 s+) are out of scope but contain one reusable principle, stated in H:263: "a guess must not be promoted to a terminal state"; and "silence alone never completes a session".

Nested agents: all subagents are inserted flat under main, then `reconcileSubagentParents` repoints `parent_agent_id` from the child ids recorded in each subagent's transcript tool results (idempotent, additive).

Workflow-tool fleets (A:1690-1843): invisible to hooks; read from `<projects>/<enc-cwd>/<sessionId>/workflows/wf_<runId>.json` (terminal journal, written only at completion) and live `subagents/workflows/<runId>/journal.jsonl` + `agent-*.jsonl`. Status `running` replaced by the terminal journal (idempotent upsert on `run_id`). Not verified against Claude Code 2.1.289.

Task progress (A:343 task-progress row, API:262-290): derives nullable `todo_summary`/`todo_snapshot` from Claude `TaskCreate/TaskGet/TaskUpdate/TaskList`, legacy `TodoWrite`, and subagent transcripts; resets on a real human turn; reads newest 32 MiB on first contact, incrementally afterwards; max 200 rows, 5 preview items, enrichment limited to 100 list rows. Display-only, "feeds no server-side logic".

## 7. Dedup and idempotency (as documented)

| Path | Key / mechanism |
|---|---|
| Session create | `POST /api/sessions` idempotent on `id`; imports dedup on session UUID |
| Import re-run | Per-event-type high-water `MAX(created_at) GROUP BY event_type`: only JSONL entries with `ts > cutoff[type]` are inserted for Stop/PostToolUse/TurnDuration/ToolError (A:388) |
| Tool events from subagent transcripts | `data LIKE '%"tool_use_id":"X"%'` plus index `events(agent_id,event_type)`; imported rows carry `imported:true, source:"subagent_jsonl"` |
| Compaction | uuid based id `<sid>-compact-<uuid>` |
| API errors | dedup by summary (A:388), a weak key |
| Subagent rows | live hook row and transcript row merged by `subagent_type + started_at` within 30 s; skip fallback `-subagent-N` rows when subagent transcripts exist (otherwise doubled) |
| Multi-dashboard hook fan-out | one POST per unique data dir, so two dashboards on the same DB never double-ingest |
| Remote push | `(session_id, event_type, uuid)` against committed rows and within the batch; batch cap 1000; `SESSION_LOCALLY_OWNED` refusal |
| Codex | persisted byte cursor + remainder per rollout; hook, `fs.watch`, 4 s poll all safe |
| Export import | session already present (by UUID) is skipped whole; config rows `INSERT OR IGNORE` on natural key |
| Live hook POST | No idempotency key is documented. A duplicate delivery would insert a second event row: UNVERIFIED. Docs rely on "at most once" delivery (no retry) |
| Token rows | Replace semantics, not increment: re-parse writes totals; see Section 8 |
| TurnDuration | stable identity = record UUID or byte offset; complete parses reconcile and repair legacy duplicates; tail parses are append-only (H:265) |

Weak spots the docs admit: dedup by `LIKE` on JSON text, dedup by summary, 30 s time-window matching (documented as "fragile" in A:388).

## 8. Token and cost accounting

Source of tokens: the transcript, never the hook payload. Hooks carry only `transcript_path`; the shared `TranscriptCache` (A:343 row) keys on `(path, mtime, size)`, reads only appended bytes, does a full re-read when the file shrinks, uses a 4 MiB chunked line reader (split on 0x0A, 64 MiB per-line cap) because V8 cannot hold a >512 MiB string, caps in-memory arrays at 1000 (`TRANSCRIPT_CACHE_MAX_ARRAY_LEN`), LRU 200 entries, evicts on SessionEnd.

Rules, in order of importance:
1. Per-message reconciliation (A:1468-1500). Claude Code writes one JSONL record per content block and each repeats the message's `usage`; summing records over-counted 2-4x (issue #293). Streaming writes partial usage first (`output_tokens: 5`) and the full figure last (`742`), so first-wins under-counts. Rule: last record per `message.id` is authoritative; keep `message.id -> contribution` map, subtract the old contribution and add the new. Window bounded to 1000 ids (records of one message are adjacent). Records without `message.id` count unconditionally; per-record content-block processing (thinking counts, tool_use) is unchanged because blocks differ.
2. Cumulative, not additive. Columns hold "current JSONL total". `replaceTokenUsage` overwrites; `baseline_*` keeps `effective = live + baseline = max ever seen` per metric, so a compaction that shrinks the transcript, or a re-import, never lowers or inflates cost (A:1434-1466; C9 for the corrected formula).
3. Pricing dimension is the PK `(model, speed, inference_geo, service_tier)`, so partial and final records landing in different buckets can leave a partial in the high-water fold (documented limitation, bounded by one record per drifted message; `repair-tokens` clears it).
4. Subagent usage is added to the session (`combineSessionTokens`) because sidechain contexts are not in the parent transcript; each subagent is priced at its OWN model (issue #185); every hook event reads main plus flat `subagents/*.jsonl` and writes the combined buckets (issue #345). Nested workflow agents go to the `service_tier='workflow'` bucket (full recompute each ingest, replace semantics).
5. Compaction detection: `isCompactSummary` entries; `SessionStart source=compact` for mid-turn auto-compaction; shrunk file triggers re-read; `baseline_*` preserves earlier totals.
6. Repair tooling: `npm run repair-tokens` = `--reconcile-tokens --all --reset-baselines`; refuses to run while a dashboard answers; auto-run once per DB behind `.token-repair-v2.done`, with `token_usage_pre_repair_v2` safety copy; `DASHBOARD_TOKEN_REPAIR=0` disables. Transcripts that were deleted cannot be repaired ("missingFiles").
7. Codex: cumulative snapshots converted to deltas (`upsertCodexTokenDelta`), 272K short/long boundary. Remote push: each bucket is a full current total, not a delta.

Pricing (A pricing row, D:404-505, RE:593-611):
- Rates per million tokens: input, output, cache read, cache write 5m, cache write 1h, fast-mode input/output, optional time-limited intro rates (`intro_until` date; the calculator picks the effective rate per usage day, so promos are right before and after the cutoff, retroactively).
- Rule match: SQL LIKE pattern, longest pattern first. Edits apply retroactively because cost is computed on read from `token_usage`.
- Modifiers: US data residency 1.1x, Batch 0.5x, fast-mode premium, web search $10 per 1k requests, code execution estimated by container time with a monthly free-hours allowance, web fetch free. Constants in `lib/pricing-constants.js` (not read).
- Defaults are shipped in the DB and corrected on startup when exact obsolete seed values are found; custom rules are preserved. No automatic price download (RE:611).
- Unpriced models: GPT rules with a zero group are "reported as unpriced, not free" (D:495). Sessions expose `has_token_usage` separately from `cost` so clients never infer coverage from a zero price (API:119-130).
- W:Tokens-Costs-and-Analytics: cost is "an estimate derived from recorded usage and configured pricing, not a billing invoice"; check scope, provider/model identity, import completeness, overrides, duplicate remote+local collection, rounding; "never fix a number by editing the database".
- Per-agent cost: only subagents get their own cost (from `metadata.tokens`); main agent cost is the session total (A agents row).

## 9. API inventory and conventions

Base: `http://localhost:4820`, prefix `/api`, JSON, 1 MB body limit (A:440, A security table), no rate limiting ("Currently, no rate limiting", API:1819). OpenAPI 3.0.3 served at `/api/openapi.json`, Swagger UI `/api/docs`, ReDoc `/api/redoc` (self-hosted bundle); `openapi.yaml` is generated and committed (header says do not edit; version 2.3.0 at review). Inventory by group (openapi.yaml path list, 99 paths, cross-checked with RE/API where present):

| Group | Endpoints |
|---|---|
| Health/meta | `GET /api/health`, `GET /api/metrics`, `/api/openapi.json`, `/api/docs`, `/api/redoc`, `GET /api/updates/status`, `POST /api/updates/check` |
| Sessions | `GET,POST /api/sessions`, `GET,PATCH /api/sessions/{id}`, `/{id}/stats`, `/{id}/transcripts`, `/{id}/transcript` (`agent_id`, `run_id`, `limit` <=200, `offset`, `after`, `before`; per-message 10,240-char cap), `/{id}/transcript-image`, `/{id}/agents`, `/{id}/notifications`, `GET /api/sessions/facets` (cwds, sources) |
| Agents / events / stats | `GET,POST /api/agents`, `GET,PATCH /api/agents/{id}`, `/api/agents/{id}/tools`, `GET /api/events`, `GET /api/events/facets`, `GET /api/stats`, `GET /api/analytics` |
| Hooks | `POST /api/hooks/event`, `POST /api/hooks/codex`, `POST /api/hooks/ingest-batch` |
| Pricing | `GET,PUT /api/pricing`, `DELETE /api/pricing/{pattern}` (URL-encoded), `/api/pricing/gpt`, `/api/pricing/cursor` (+ deletes), `GET /api/pricing/cost`, `/api/pricing/cost/{sessionId}`, `POST /api/settings/reset-pricing` |
| Workflows | `GET /api/workflows`, `/api/workflows/session/{id}`, `/api/workflows/runs`, `/api/workflows/runs/{runId}` |
| Alerts / webhooks | `GET /api/alerts` (`unacked`, paging), `POST /api/alerts/{id}/ack`, `/ack-all`, `GET,POST /api/alerts/rules`, `PATCH,DELETE /api/alerts/rules/{id}`; `GET /api/webhooks/providers`, `GET,POST /api/webhooks`, `PATCH,DELETE /{id}`, `/{id}/test`, `/{id}/deliveries` |
| Settings / data | `GET /api/settings/info`, `export`, `POST import`, `cleanup`, `clear-data`, `reimport`, `install-hooks`, `reinstall-hooks`, `snapshots` (+ `compress`, `prune`), `GET,PUT claude-home`, `codex-home` |
| Import | `GET /api/import/guide`, `POST rescan`, `scan-path`, `upload` (multipart) |
| Config / run / push / remote | `/api/cc-config/*` (read and write Claude config files with backups), `/api/codex-config/*`, `/api/run/*` (spawn `claude`), `/api/push/*`, `/api/remote-sources/*` |

Conventions that are actually documented:
- Pagination: `limit` (default 50, max 10000 on sessions; 100 default on tools) and `offset`; responses `{sessions, total, limit, offset}` (C17 for `has_more`). Transcript uses cursor `after`/`before`.
- Filters: `status`, `q` (case-insensitive over id, name, cwd), repeatable `cwd`, `sort_by` (`time|duration|price`), `sort_desc`, comma lists `sources` and `providers`, `include_transient`, `include_task_progress`.
- Errors: `{error, code, details}`, `401 EUNAUTHORIZED`, `403 EBADHOST`, `400 INVALID_*`, `413 ...`, `503 REMOTE_PUSH_NOT_CONFIGURED`; CLI uses stable codes `UNKNOWN_COMMAND`, `MISSING_ARGUMENT`, `CONFIRMATION_REQUIRED`, `SERVER_DOWN`.
- Destructive operations need typed confirmation: `confirm: "PRUNE_SNAPSHOTS"`, `CLEAR_ALL_DATA`, `PURGE_REMOTE_SOURCE_DATA`; dry-run is the default for prune.
- Redaction: webhook URLs masked and secrets redacted in responses; webhook delivery rejects redirects.
- `last_activity` is "latest durable event", deliberately not `updated_at`, so repairs cannot make an idle session look active (API:197).
- Auth: Section 13.
- Sessions list performance guards: transient rows only on the first page; task progress only for first 100 rows.

## 10. WebSocket protocol

- Path `/ws`, plain RFC 6455 via `ws`; server `ping` every 30 s, clients that miss `pong` are terminated; upgrade passes the same Host-header allowlist and optional token as HTTP (A:1134-1138, A:347 websocket row).
- Envelope (A:1140-1150): `{ type, data, timestamp }` (ISO 8601). Broadcast to all open clients; there is no subscribe/unsubscribe, no filtering, no auth scopes, no sequence numbers and no replay documented. Messages are not acked.
- Types (A + RE, newer set): `session_created`, `session_updated`, `agent_created`, `agent_updated`, `new_event`, `alert_triggered`, `alert_updated`, `workflow_upserted`, `remote_source.status`, `remote_data.updated`, `import.progress` (throttled to ~150 ms; phases start, scan, extract, parse, complete, error), `run_stream`, `run_status`, `run_input_ack`, `cc_config_changed`. Hook-based types are sent after commit (batch route flushes after commit, not during).
- Client (A:1199-1214): reconnect 2 s after close; on reconnect the page refetches via REST; client `eventBus` fans messages to page subscribers (workflows page debounces 3 s). Pages load via REST first, then subscribe; messages trigger "reload or optimistic update". Because of no replay, a missed message is healed only by REST refetch.
- Docs say the dashboard "refreshes every 5 seconds through WebSocket push" (SW Features) while A says "WebSocket push, no polling": vague.

## 11. MCP

(M, A:1917-1972.) 103 tools in 16 domain modules, one registrar shared by stdio, Streamable HTTP + legacy SSE (`/mcp`, `/sse`, `/messages`, `/health`, default 8819) and a REPL. The server never reads the DB; every tool calls the dashboard's `/api/*` over loopback (keeps validation and redaction in one backend). Tool domains: observability, sessions, transcripts, agents, events/hooks, pricing and cost, workflows, alerts, webhooks, import/portability, Claude/Codex config, Run Agent, remote sources, settings/updates, push, maintenance. Naming `dashboard_<verb>_<noun>`.

Policy tiers: Read (default on) / Mutation (`MCP_DASHBOARD_ALLOW_MUTATIONS=true`; imports, syncs, process control, webhook tests, notifications) / Destructive (`MCP_DASHBOARD_ALLOW_DESTRUCTIVE=true` plus `confirmation_token`). Transport hardening: only loopback base URLs (and named container-host aliases, HTTPS if a token is sent), redirects rejected, GET-only automatic retry (2 retries, 250 ms backoff base), request timeout 10 s, upload caps 50 MiB/file and 100 MiB/call, image stream cap 10 MiB, idle HTTP session reaping (30 min, clamp 60 s..24 h), stdio server exits on stdin end/close or re-parenting (poll 5 s against the startup ppid, not "pid 1"), logs on stderr only. Tool-count parity is asserted in tests (`test:mcp`). The claim "103" is repeated in M, A, `README`; I did not count.

## 12. Settings, export, retention, alerts

Settings page (S "Data management", API settings table): model pricing editor and reset, hook status and reinstall, data export (JSON), session cleanup (abandon stale after N hours, purge old after N days), clear all data (alert rules and webhook targets are kept as configuration), provider-home overrides persisted to a dotenv file (`DASHBOARD_ENV_PATH`), transcript snapshots, remote sources, alerts and webhooks, update check, sound cues, i18n.

Export/import (A:391, W:Backups): `format: "ccam-export"` versioned bundle of sessions, agents, events, token_usage, workflows, dashboard_runs, alert_rules, three pricing tables; machine-bound or secret tables excluded (push subscriptions, webhook targets/deliveries, alert events, ingest cursors). Import: session-atomic in one transaction with deferred FKs; existing session skipped whole; events reinserted without their autoincrement ids; max 25 MiB; `400 INVALID_JSON / INVALID_FORMAT`, `413 IMPORT_TOO_LARGE`. "Not a byte-for-byte restore". A single-file export cap of 25 MiB means a large DB cannot round-trip: a design smell worth avoiding.

Backups: production uses SQLite online backup with integrity check and SHA-256, restore requires one writer (scale to zero), clears stale `-wal`/`-shm`, pre-restore backup (W:Backups, D:880-925: `VACUUM INTO`, then `PRAGMA integrity_check` must print `ok`; restore drill on a copy with a different port).

Retention policy (D, A:1632-1685, API:1327-1380): 
- Claude deletes its own transcripts after `cleanupPeriodDays`, so CCAM keeps durable snapshots (`transcripts/<...>`); reads serve whichever of live or snapshot is longer (`pickMoreComplete`, live wins ties).
- Snapshot writer: temp file + rename, never shrinks an existing snapshot, tombstones in `.pruned/<sessionId>` after cap prune, Windows lock retries (`EBUSY/EPERM/EACCES`), never follows symlinks.
- Lossless gzip of snapshots whose source is gone and idle 24 h (FEXTRA header stores exact length; plain file removed only after decompress + SHA-256 + length match; skipped if the source tree is missing or unreadable so an unmounted drive is not read as "deleted").
- Opt-in caps `DASHBOARD_SNAPSHOT_MAX_AGE_DAYS` and `DASHBOARD_SNAPSHOT_MAX_BYTES`; whole finished sessions, oldest first by `max(DB activity, snapshot mtime)`, `active` never touched, size cap also spares sessions active within 24 h; apply requires dry-run default + `confirm`.
- Rule: "never delete the only remaining copy of a transcript for a session the user still has unless the user opted in".
- Purge by `POST /api/settings/cleanup` also deletes the purged sessions' snapshots; deleting a remote source keeps imported data unless `purge=true`.

Alerts (A alerts rows): four rule types: `event_pattern` (`event_type`, `tool_name`, `summary_contains`, optional `count` within `window_minutes`), `token_threshold` (session total tokens, evaluated only on token-bearing events), `inactivity` (active session idle `minutes`), `status_duration` (agent stuck working/waiting). Per (rule, session, agent) cooldown (`cooldown_seconds`, default 300) checks the last `alert_events` row; rules cached in memory and invalidated on CRUD; event-driven rules run after commit and are try/catch-guarded so alerting can never fail ingestion; time rules sweep every 60 s. Rule type immutable after create. Fired alert goes to webhooks fire-and-forget (14 providers + generic with optional HMAC-SHA256, retries, timeouts, 2000-row delivery log pruning). Browser Web Push (VAPID) and sound cues are separate.

## 13. Security posture

- Bind `127.0.0.1` by default (fix for GHSA-gr74-4xfh-6jw9; it used to bind `0.0.0.0` with no auth). `DASHBOARD_HOST` widens and logs a warning. [API:55-65, A:2742-2745]
- Host-header allowlist on HTTP and WebSocket upgrade (DNS rebinding); extras via `DASHBOARD_ALLOWED_HOSTS`; violation = `403 EBADHOST`. CORS loopback-only via `corsOptions()` (no-Origin requests such as curl pass). Prometheus in Docker must be allowlisted.
- Auth is off by default; the loopback bind is the trust boundary. `DASHBOARD_TOKEN`/`_FILE` gates all `/api/*` and `/ws` (Bearer, `x-dashboard-token`, or `?token=`); exempt: `/api/health`, `/api/openapi.json`, `/api/docs`, `/api/hooks` (see C15). Constant-time compare. Separate secrets for dashboard, hook (`DASHBOARD_HOOK_TOKEN`), remote push (`REMOTE_PUSH_TOKEN`, disabled until set), MCP HTTP (`MCP_HTTP_AUTH_TOKEN`).
- No secrets stored by CCAM; SSH relies on the host's ssh stack and `known_hosts`.
- Upload hardening: path-traversal guard (`safeJoin`), extraction cap 4 GB, per-file 1 GB, 2000 files, per-request temp dir cleaned in `finally`, `scan-path` must be absolute, existing, a directory.
- Config write APIs (cc-config, codex-config) use an allowlist and create timestamped backups before write/delete.
- Privacy statement in W:Security: CCAM "stores prompts, paths, tool activity, transcripts"; "treat it as access to the underlying development environment"; redact exports; do not expose to an untrusted LAN.
- Gaps (docs silent): no CSRF discussion beyond Origin/Host checks, no rate limit, no log-redaction policy for hook payloads, no encryption at rest, `events.data` stores full hook JSON including whatever tool input Claude Code sends.

## 14. Setup, ports, operations

- Requirements: Node >= 22.22, npm >= 9 (R). Quick start: `npm run setup` (root, client, VS Code extension, MCP; links `ccam`), `npm run dev` (Vite 5173 proxying `/api` and `/ws` to 4820), production `npm run build && npm start` on 4820. `npm run dev` runs `scripts/dev.js`, probing 127.0.0.1 and `::1`, picking the first free port in 4820-4859, writing it to the discovery file.
- Ports: 4820 server, 5173 Vite dev, 8819 MCP HTTP, 8080 Nginx, 9090 Prometheus, 3000 Grafana (container stack). Desktop app adopts a healthy server on 4820, else 4821-4829, then random 49152-49500.
- `CLAUDE_DASHBOARD_PORT` forces the hook target; `DASHBOARD_PORT` sets the server port; `DASHBOARD_DATA_DIR`/`DASHBOARD_DB_PATH` relocate data (DATABASE.md and S disagree on default, C10).
- Env vars with documented defaults: `DASHBOARD_STALE_MINUTES` 180, `DASHBOARD_WORKING_IDLE_SECONDS` 120, `DASHBOARD_LIVENESS_IDLE_SECONDS` 60, `DASHBOARD_LIVENESS_PROBE` 1, `DASHBOARD_SESSION_SYNC_MS` 30000, `DASHBOARD_WORKFLOW_POLL_MS` (default not documented), `DASHBOARD_TASK_SUMMARY_TTL_MS` 2000, `DASHBOARD_SNAPSHOT_COMPRESS` 1, `CCAM_IMPORT_MAX_*`, plus the token/host variables above.
- CLI (A:343 bin row, docs/CLI.md not read): `ccam` on Commander.js; global `--json`, `--format auto|json|pretty`, `--server`/`CCAM_URL`, `--token`; destructive commands need `--yes`; offline fallback reads the DB directly (SELECT-only, not opened read-only so a live WAL stays visible); `ccam commands --json` emits a machine-readable schema of all commands; `ccam doctor` runs structured checks.
- Containers/K8s/Terraform/Desktop/VS Code/PWA: documented at length (S, A:2441-2730, 2780-2930); all out of scope.
- Known operational pitfalls from the docs: single writer only; stale `-wal`/`-shm` after unclean kill; hooks must be installed on the host, not in a container; hooks apply only to sessions started after installation; Node not on PATH for hook commands (they suggest an absolute `node` path); restart Claude Code after install.
- Dev process notes: dev server uses a debounced restarter (500 ms) because `node --watch` caused fatal `EPIPE` that left Vite without a backend.

## 15. Decision table

Legend: ADOPT = copy the behavior; ADAPT = copy the idea, change the mechanism; DEFER = maybe later, not in the migration; REJECT = out of scope. Product constraints: skill-managed, one SQLite DB per monitoring task, local-first loopback, hooks first with transcript import as recovery, no Electron/Docker/SaaS/enterprise auth/marketplace, keep current visual identity.

| Feature | CCAM behavior | Decision | Reason | Notes for our design |
|---|---|---|---|---|
| Hooks as primary signal, transcript as detail and recovery | Hooks for state, JSONL for tokens, titles, compaction, errors, interrupts | ADOPT | Same architecture we want; docs show why hooks alone are insufficient | Keep "re-import, do not fabricate hook events" as a rule |
| Fail-open forwarder (exit 0, no wait for reply, hard time limits) | node script, 2 s/2.5 s limits in code | ADOPT | Monitoring must never block Claude Code | Add an on-disk spool so a down monitor does not lose events (CCAM has none, documented gap) |
| Wire envelope `{hook_type, data}` | Handler wraps raw payload, `{raw}` on parse failure | ADAPT | Good, but store and validate the raw payload version | Include handler version, instance id, receive timestamp |
| Global install into `~/.claude/settings.json`, idempotent merge by "contains hook-handler.js" | One entry per hook type, replace own entry, keep others | ADAPT | Idempotent self-detecting merge is right; global scope contradicts per-instance isolation | Decide scope (project/local settings vs global) in the install design; always back up, never auto-write on server start (C12) |
| Port discovery file + fan-out per data dir | `~/.claude/.agent-dashboard.json` with PID pruning | ADAPT | Needed when hooks are global and several instances run | Keep the registry idea (instance id, port, pid, task, data dir); route a session to the instance that claims its task; prune dead PIDs |
| Single `events` timeline + normalized `sessions`/`agents` | Yes | ADAPT | Good shape; reduce JSON-in-text dedup hacks | Give every event a deterministic dedup key (session, source, uuid or tool_use_id); store typed columns for tool_use_id |
| Persisted status vs derived "waiting" overlay | Waiting = `active` + `awaiting_input_since` + reason | ADOPT | Keeps persisted enum small and queryable; reason enum is useful | Resolve agent-status ambiguity (C6) once, in a state-machine doc with tests |
| `awaiting_reason` stamp/clear in lock-step; `SubagentStop` never clears; `compact` SessionStart never stamps | Yes | ADOPT | Hard-won edge rules | Encode as table-driven tests |
| Esc recovery (transcript marker + idle-working timeout) | Marker `[Request interrupted by user]` ordering-based; 120 s idle fallback | ADOPT | Esc fires no hook per docs; otherwise sessions stick in working | Verify marker text and fields on Claude Code 2.1.289 transcripts (UNVERIFIED). Compare transcript timestamps to each other only |
| Error watchdog + `isErrorAtTail` self-heal | 15 s tick; clears `error` when transcript progressed | ADOPT | Prevents stuck `error` | Needs the exact API-error record shapes (`isApiErrorMessage`): verify |
| Liveness reap by `ps`/`lsof`/`/proc` | Completes dead sessions; skipped on Windows | ADAPT | Concept right, mechanism not portable (C22; we are on Windows) | Use transcript mtime + last-hook age + optional PID from SessionStart if available; write a synthetic end event with `source:"liveness-probe"` and make it reversible |
| Stale sweep (`abandoned` after 180 min) | Yes, plus reactivation on new work | ADOPT | Cheap, bounded; unattended chains may run silent longer, so make it per-instance configurable | Never promote an inferred state to terminal when a tool call may be running (CCAM's own rule) |
| Incremental transcript cache keyed `(path, mtime, size)` with byte offsets | Yes, chunked reader, bounded arrays | ADOPT | Required for large transcripts | Persist a durable cursor (byte offset + inode/size) per transcript, like Codex cursors, so restart does not re-parse |
| Per-`message.id` last-record-wins usage | Yes | ADOPT | Fixes 2-4x over-count | Prefer storing per-message usage rows keyed by `message.id` and summing in SQL; that makes totals idempotent without baselines (my recommendation, not CCAM's design) |
| `baseline_*` high-water columns | Monotonic effective total | ADAPT | Solves compaction/re-import, but the first formula inflated by 11x (C9) | If we store per-message rows, no baseline is needed; if totals are stored, keep `max()` semantics and test with shrinking transcripts |
| Pricing table with LIKE patterns, modifiers, cache tiers, intro rates | Editable, retroactive, computed on read | ADAPT | Right model; ship a small default table we maintain, verified against Anthropic's pricing page | Cost is an estimate; show `has_token_usage` and "unpriced" separately from `$0` |
| Subagent tokens and own-model pricing; transcript scan on SubagentStop | Yes | ADAPT | Needed for accurate cost and tool timeline | Do the scan in the importer, not only on a hook; handle both subagent dir layouts; time-window row merging should be replaced by ids |
| Nested subagent reparenting from `toolUseResult.agentId` | Yes | ADAPT | Correct tree | Verify field against current transcripts |
| Compaction events (`isCompactSummary`, `SessionStart source=compact`) | Pseudo-agent plus event | ADAPT | Useful signal for cost and context pressure | Model as an event only, not an agent row |
| Session naming precedence `custom-title > ai-title > first prompt` | Yes | ADOPT | Cheap, sensible | First-prompt fallback copies prompt text: truncate and treat as user data |
| Prompt previews (`card_prompt_preview`, `events.data` full JSON) | Stores prompts | ADAPT | Conflicts with our "no prompt text in outputs" rule | Store minimal fields by default; opt-in for text; redact in logs and exports |
| Continuous project sync (startup + fs.watch + 30 s poll with mtime cache) | Yes | ADOPT | This is our "transcript import as recovery" | Windows `fs.watch` recursive is supported (they use it); keep the poll as safety net |
| Workflow-tool journal ingestion | Files under `<session>/workflows/` | DEFER | Our skill mentions workflows but formats are unverified for 2.1.289 | Re-check against a real run before building |
| Task progress from TaskCreate/TodoWrite | Display-only summary | DEFER | Nice for "progress of a long chain" | Keep out of core state logic like CCAM |
| Durable transcript snapshots with never-shrink, tombstones, opt-in caps | Yes | ADAPT | Claude deletes transcripts after `cleanupPeriodDays`; our DB would otherwise lose detail | Per-instance snapshot dir inside the task folder; opt-in only; dry-run default |
| Lossless gzip of idle snapshots | Yes | DEFER | Optimization | Add if disk becomes an issue |
| SQLite WAL, FK on, busy timeout 5000, prepared statements | Yes | ADOPT | Standard and cheap | One DB file per task makes the single-writer rule trivial; assert one server per DB |
| `better-sqlite3` with `node:sqlite` fallback | Yes | ADAPT | Native build risk on Windows | Pick one driver after a smoke test on Node 24.14.1 (UNVERIFIED here) |
| Schema migrations | `CREATE IF NOT EXISTS` + `ALTER TABLE` (C7) | ADAPT | Docs show contradictory approaches | Use numbered migrations with `user_version`, tested from each prior version |
| Partial indexes for hot queries | Several | ADOPT | Documented 180x speedup | Write queries first, then indexes; verify planner uses them |
| Backups via `VACUUM INTO` + integrity check + checksum | Yes | ADOPT | Safe and simple | Expose as CLI command; restore drill on a copy |
| JSON export/import, session-atomic, idempotent | Yes, 25 MiB cap | ADAPT | Useful for moving a task's data | No size cap; stream it; skip existing by session id |
| REST shape: `limit/offset/total`, filters, `last_activity` | Yes | ADAPT | Sound | Define one error envelope and one pagination envelope up front (C17); prefer cursor for events |
| OpenAPI generation + Swagger/ReDoc UI | Yes | DEFER | We have `docs/api.md`; maybe emit `openapi.json` only | Do not ship a docs UI |
| WebSocket broadcast `/ws`, ping 30 s, envelope `{type,data,timestamp}` | Yes, no replay | ADAPT | Fine for a loopback UI | Add monotonic event ids so a reconnecting client can resume or refetch; keep types snake_case and consistent (C8). SSE is an alternative: UNVERIFIED which fits our UI better |
| Host-header allowlist + loopback CORS + loopback bind | Yes | ADOPT | Cheap protection against DNS rebinding, a real risk for a loopback app | Per-instance random port; token optional, default off |
| `DASHBOARD_TOKEN`, hook token, remote push token, MCP token | Four secrets | REJECT | Enterprise-style auth, out of scope | Maybe one optional per-instance token if the owner binds beyond loopback; never support query-string tokens |
| Remote hook delivery over HTTPS, remote push `ingest-batch`, SSH remote sources | Yes | REJECT | Local-first only | Keep `source` column out of v1 or default to `local` |
| Prometheus metrics, Grafana, Nginx, Compose, K8s, Terraform, Docker | Yes | REJECT | Out of scope | |
| Electron desktop, tray, auto-start, VS Code extension, PWA, update notifier | Yes | REJECT | Out of scope | |
| Plugin marketplace, 14 plugins, 66 skills, Codex dual manifests | Yes | REJECT | Out of scope | |
| Cursor and Codex providers, separate pricing tables, rollout cursors | Yes | REJECT | Claude Code only | Keep a `provider` column only if free; the byte-cursor pattern is reusable for Claude JSONL |
| MCP server with 103 tools, three tiers | Wraps REST | DEFER | Not required for monitoring; if added, keep read-only tier first | The tiered gates and "MCP calls REST, not the DB" principle are good |
| `ccam` CLI with `--json`, `--yes`, stable error codes, offline DB read, `doctor` | Yes | ADAPT | Our skill already has a CLI; copy the conventions | Offline read must open the DB read-only to avoid WAL surprises (they deliberately do not; revisit) |
| Alert rules (4 types, cooldown, post-commit evaluation) | Yes | DEFER | Useful for unattended chains (inactivity, token threshold) | If built: evaluate after commit, never in the ingest path, cooldown per scope |
| Webhooks (14 providers, HMAC, retries) | Yes | REJECT | Out of scope | At most one generic local notification later |
| Browser push, sound cues, Tabby mascot, Command palette | Yes | REJECT | Identity/scope; palette/sound could be revisited | |
| Kanban lanes, Activity feed, Analytics, Workflows pages | UI | DEFER | Keep our visual identity; reuse only the data contracts (status buckets, grouped feed, per-tool/per-model aggregates) | |
| Config Explorer, Run Agent (spawn `claude`) | Reads and writes Claude config, runs processes | REJECT | Monitor must stay read-only | |
| Settings: cleanup abandon/purge, clear-all | Yes | ADAPT | Needed lifecycle control per instance | "Delete instance" and "purge older than N days" with dry-run default and typed confirmation |
| Import UI with archive upload and bomb defenses | Yes | DEFER | Local-first rarely needs archives | If built, copy the limits (path containment, extraction cap) |
| i18n (5 languages) | Yes | DEFER | Not required | |

## 16. Notes and open questions for the design phase

1. Hooks do not give tokens, titles, compactions or interrupts. The ingestion core must therefore be "event arrives, then read the transcript increment", with the cursor stored durably.
2. CCAM relies on 8 hooks only. Whether Claude Code 2.1.289 offers more useful ones (failure, subagent start, compaction, permission) is for the hooks research; CCAM's docs neither confirm nor deny.
3. Clock handling: CCAM explicitly avoids comparing transcript time to hook time (H:672-680). Adopt the principle: compare like with like, store both timestamps.
4. "Never promote a guess to a terminal state" and "silence is not completion" are the most reusable rules for unattended chains where one tool call may run for minutes.
5. Decide early whether Waiting is persisted or derived, and write the state table as executable tests (CCAM's docs show three versions).
6. Privacy defaults: CCAM persists prompts and full hook JSON. Our storage design must choose a minimal default and an explicit opt-in.
7. Windows: no process probe in CCAM; plan another liveness signal (C22).
8. Hook-delivery observability is absent in CCAM. Consider a per-instance counter of received hooks, last-hook age and handler errors, shown in the UI header.

## 17. UNVERIFIED list

- Everything about actual CCAM runtime behavior (not installed, not run).
- Real Claude Code hook payload fields (`stop_reason`, `tool_input`, `source`, `transcript_path`) and the Esc marker text for 2.1.289.
- Whether `Stop` payload ever carries `stop_reason`; how CCAM detects error otherwise beyond the transcript scan.
- Handler time limits (C5), latency claims (C19), "103 tools" count, "5 runtime deps".
- Which agent status enum is current (C6) and which hook install behavior applies when (C12).
- `docs/CLI.md`, `docs/DEPLOYMENT.md`, `server/README.md`, `mcp/README.md` were not read (outside the assigned list); `lib/pricing-constants.js` and `lib/token-usage.js` internals not read.
- Default for `DASHBOARD_WORKFLOW_POLL_MS`; `/api/workflows` response shape.
- `node:sqlite` stability on Node 24.14.1 as a `better-sqlite3` replacement.

## 18. Verification log (2026-10-11)

Checked against the scratch clone (repo commit a06db03, wiki commit 49e2722; both hashes and dates re-read with `git log -1`).

| Claim | Verdict | Evidence |
|---|---|---|
| Repo/wiki commit hashes and dates | confirmed | `git log -1 --format='%H %cI'` in both clones matches Section 0 |
| Exactly 8 hooks, 5 with matcher, no timeout/async on entries | confirmed | `scripts/install-hooks.js:87-95`; `makeHookEntry` sets only `type`, `command`, optional `matcher` |
| Wire format `{hook_type, data}` | confirmed | `README-EN.md:1101`, `ARCHITECTURE.md:242` show `"hook_type":"PreToolUse","data":{...}` |
| Handler time limits 3 s per target / 5 s cap | wrong, corrected | code: `hook-handler.js:69` 2500 ms exit timer, `hook-transport.js:83` `timeout: 2000`. `ARCHITECTURE.md:1237,2741` still say 5 s. C5 and Section 4 edited |
| Baseline formula max-based, old formula inflated a session about 11x | confirmed | `ARCHITECTURE.md:1458-1466` |
| Compaction dedup key `<sid>-compact-<uuid>` | confirmed | `server/routes/hooks.js:994` |
| Stale sweep default 180 min, interval quarter clamped 60 s..5 min | confirmed | `server/index.js:1496-1503` |
| Esc idle fallback default 120 s | confirmed | `server/routes/hooks.js:1541` (`120_000`) |
| Esc marker regex `[Request interrupted by user` | confirmed | `server/lib/transcript-cache.js:28` (case-insensitive prefix match) |
| Process liveness reap skipped on Windows, containers, non-POSIX cwd | confirmed | `server/lib/*:64,128` (`process.platform === "win32"`), `docs/HOOKS.md:685` |
| DASHBOARD_REMOTE_SYNC_MS default 15000 (C11) | confirmed | `server/index.js:703-705` |
| Watchdog tick 15 s | confirmed | `server/index.js:705` area shows `15_000` (note: that line is the remote-sync default; watchdog cadence itself rests on docs `ARCHITECTURE`/`HOOKS.md:672-690`, so treat as documented, not code-verified) |
| openapi.yaml version 2.3.0, 99 paths | confirmed | `openapi.yaml:6`; `grep -c "^  /"` returned 99 |
| MCP default port 8819 | confirmed | `docs/MCP.md:39,241` |
| MCP has 103 tools | unverifiable | stated in `docs/MCP.md:3,275` (`test:mcp` asserts it); not counted by me |
| Privacy scan of this file | clean | no prompt text, secrets, emails or user paths found; only public repo URLs and env var names |
