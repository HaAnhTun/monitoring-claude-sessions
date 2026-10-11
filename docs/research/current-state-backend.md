# Current state: the Python engine (audit for the Node/TypeScript port)

Audited: 2026-10-11. Skill repo HEAD `f0fb062` on branch `feat/v3-node-runtime` (tag `pre-v3-python` = old state), engine version `2.0.2` (`src/backend/__init__.py:3`). Everything below was read from the files named; line numbers are `file:line` inside `src/backend/` unless a path is given. Machine: Windows 11, Python 3.14.3, Node 24.14.1 (V8 13.6).

Evidence run: `python -m unittest discover -s tests` -> `Ran 56 tests in 4.651s  OK` (2026-10-11; one `ResourceWarning` from `test_state_config_tasks.py:199`, an unclosed file in the test, harmless). The Node frontend tests (`node --test tests/frontend`) were NOT run (not requested); their `test(` count was taken with grep only.

Conventions: "golden" = a behavior a TypeScript port must reproduce byte-for-byte or value-for-value and should pin with a test. UNVERIFIED = not checked by me. Layers: **A** = skill + CLI (agent-facing), **B** = runtime (server/ingest/state), **C** = UI.

---

## A. Current-state architecture

### A.1 Files and sizes
| File | Lines | Role |
|---|---|---|
| `template/viewer.py` | 18 | Entry point: puts `../src` on `sys.path`, calls `backend.cli.main` (`viewer.py:11-17`). Path is part of the compatibility promise (`docs/architecture.md`, "Compatibility constraints"). |
| `src/backend/__init__.py` | 20 | `__version__`, `code_stamp()` |
| `config.py` | 217 | defaults + override merge, validation (`SCHEMA`), schema version gate, provenance, slug rules, atomic JSON write |
| `tasks.py` | 233 | task workspaces: init/reuse, configure + audit, inspect, audit check, isolation snapshot |
| `reader.py` | 340 | `TranscriptReader` (incremental, two cursors), `ReaderPool`, `events_of` |
| `state.py` | 101 | `classify_state` (pure), `external_state`, Claude registry, `pid_alive` |
| `sessions.py` | 225 | transcripts-dir detection, rule matching, subagent discovery, `list_sessions` |
| `panels.py` | 228 | attempts table, machine (Win32), git, docker, log tails, ledger/chain overview |
| `server.py` | 262 | `Monitor` (config + pool + TTL cache + error ring), HTTP handler, static files, port bind |
| `cli.py` | 453 | all commands, lifecycle (start/stop/status/doctor), legacy flags |
| `proc.py` | 14 | `run()` = `subprocess.run` + `CREATE_NO_WINDOW` |
| `config/defaults.json` | 25 | the only place defaults live |
| `src/frontend/**` | ~728 (app.js) + modules | vanilla ES modules, served from disk per request (Layer C, out of scope here) |

### A.2 Data-flow diagram
```
                         READ-ONLY INPUTS (never written by the monitor)
 ~/.claude/projects/<proj>/<sid>.jsonl ............ sessions.list_sessions glob  (sessions.py:188)
 ~/.claude/projects/<proj>/<sid>/subagents/**/agent-<id>.jsonl (+ .meta.json)
 ~/.claude/projects/<proj>/<sid>/workflows/<wf>.json ........... sessions.agent_files (sessions.py:127)
 ~/.claude/sessions/<pid>.json (registry, interactive only) ..... state.registry (state.py:89)
 <repo>/<chain_log>, <ledger>, <live_log_globs>, <stop_file> .... panels.* (tail_lines)
 git, docker (child processes), Win32 (ctypes) .................. panels.overview / panels.machine
                                    |
                                    v
 +-------------------- ReaderPool (reader.py:308) -------------------------+
 | one TranscriptReader per .jsonl path, created lazily, pruned after 30 min idle |
 |  events cursor (starts at tail window)  usage cursor (starts at byte 0, time budget) |
 |  -> msgs{message.id: max per field}, pending{tool_id: ts}, last_stop, events[] (only if keep) |
 +--------------------------------+---------------------------------------+
                                  |
        per session + per agent   v
 sessions.classify (rules: regex on first real prompts) --> label, matched
 sessions._view --> state.classify_state(evidence...) --> state, state_evidence, state_source
                                  ^
                                  | external{sid: {state, evidence}}
 panels.attempts_rows(chain_log, attempts regexes) -- external_state(row) (state.py:41)
                                  |
                                  v
 server.Monitor.cached(key, ttl, fn)   shared TTL cache + per-key lock + last-good-value fallback
   sessions 3s | attempts 4s | overview 10s | machine 1.8s | logs 2s | health/config/task/events/search/locate uncached
                                  |
                                  v
 http.server ThreadingMixIn, 127.0.0.1 only, GET only, Host validated (server.py:187-191)
   /api/health /api/config /api/task /api/sessions /api/events /api/search /api/locate
   /api/overview /api/machine /api/logs /api/attempts   +   / and /static/*  (frontend from disk)
                                  |
                                  v   poll (poll.*_ms from /api/config)
                     browser: vanilla ES modules (Layer C)

 TASKS / AUDIT (separate path, used by CLI only)
 <repo>/.claude/monitor/tasks/<slug>/{task.json, config.json, README.md, state.json, audit/changes.md, audit/decisions.md}
   cli.cmd_configure -> tasks.configure -> validate(strict) -> write_json_atomic -> audit_change (+ snapshot isolation check)

 PROCESS LIFECYCLE
 cli.cmd_start: build_monitor (validate) -> instance_alive? -> Popen(viewer.py serve ..., hidden, detached)
   -> poll state.json + /api/health up to 60 x 0.2 s -> print URL
 viewer.py serve (cmd_serve): bind first free port in [port, port+19] -> write state.json -> serve_forever
   -> finally: delete state.json only if it still names this pid
 cli.stop_target: read state.json -> pid_alive? -> cmdline contains "viewer.py"? -> taskkill /F (POSIX SIGTERM) -> wait 25 x 0.2 s -> remove state.json
```

### A.3 Key architectural facts
- **Pull model, no database.** Everything is recomputed from files on request, bounded by a TTL cache; reader checkpoints (byte offsets, token maps) are the only in-memory state (`reader.py:67-86`). Nothing is persisted except task files and `state.json`.
- **Per-process cache sharing:** `Monitor.cached` (`server.py:30-50`) serializes the result to a JSON string once per key per TTL, so N tabs cost one computation. If recomputation raises and an older value exists, the older value is served and the error goes to the 20-entry ring (`server.py:23,27-28,44-48`).
- **Three separate notions** (docs/architecture.md "State model"): execution state of a session, monitor health (`/api/health`), data freshness (client-side clock since last good poll; the server has no concept of it beyond `poll.stale_after_ms` in `/api/config`).
- **Task workspace lives in the monitored repo**, not in the skill (`tasks.py:22-23`); the skill folder holds only code + defaults.
- `code_stamp` makes "running code older than disk code" detectable (`__init__.py:6-20`); the frontend is exempt because it is served from disk on each request (`server.py:173-185`).

---

## B. Feature inventory

Must-preserve legend: **Y** = users/agents rely on it or docs promise it; **N** = implementation artifact, may change; **Y*** = preserve the observable result, change the mechanism.

| # | Feature | Where | Observable behavior | Must-preserve? | Target home |
|---|---|---|---|---|---|
| 1 | Shared defaults | `config.py:84-89`, `config/defaults.json` | keys starting `_` dropped; unreadable file -> `ConfigError` | Y (file reused as-is) | A+B: `core/config` loads the same JSON |
| 2 | Config merge | `config.py:130-140` | `panels,ui,poll,limits` merge per sub-key; everything else replaced; `_` keys ignored; inputs not mutated | Y (docs/configuration.md promise) | `core/config` |
| 3 | Provenance | `config.py:143-156` | per key `default` or `task`/`legacy`; dict keys flattened `panels.git` | Y (`inspect` output, SKILL.md "inherited vs overridden") | `core/config` |
| 4 | Validation | `config.py:58-81,92-119` | strict for task configs (unknown key rejected), lenient for legacy; regexes compiled | Y (dialect issue, see F.2) | `core/config` + `core/pyregex` |
| 5 | schema_version gate | `config.py:122-127` | missing -> refuse ("refusing to guess"); unsupported -> refuse; no silent migration | Y (SKILL.md rule) | `core/config` |
| 6 | Slug rules | `config.py:12,158-166` | `^[a-z0-9][a-z0-9-]{0,47}$`, reserved `con nul prn aux`; `slugify` | Y | `core/tasks` |
| 7 | Task init/reuse | `tasks.py:79-96` | creates 4 files + audit entry, or reuses (nothing overwritten) | Y | A: `cli` + `core/tasks` |
| 8 | configure | `tasks.py:131-167` | dotted keys, validated whole result, atomic write, audit entry, no-op writes nothing, schema_version immutable | Y | A+B shared `core/tasks` |
| 9 | decide | `tasks.py:59-61`, `cli.py:161-165` | appends to `audit/decisions.md` | Y | A |
| 10 | inspect | `tasks.py:170-177`, `cli.py:116-133` | effective config + provenance + runtime state + last change + `config_hash` + recent audit (last 3 blocks) | Y | A |
| 11 | audit | `tasks.py:187-215` | checks id match, schema, config resolves, `changes.md` exists, no symlink, no `.jsonl` copy; exit 1 on problems | Y | A |
| 12 | Isolation snapshot | `tasks.py:218-233`, `cli.py:153-156` | SHA-1 over other tasks' files (excluding `state.json`) before/after configure | Y (invariant: configure touches only its task) | A |
| 13 | discover | `cli.py:86-105` | text report: transcripts dir, 15 recent sessions + first prompt, log/ledger candidates, tasks | Y (first step of SKILL.md procedure) | A |
| 14 | Transcripts dir detect | `sessions.py:32-47` | sanitized path guess (`[^A-Za-z0-9]` -> `-`, also lowercase), else match recorded `cwd` of 3 newest files per project dir | Y | B `ingest/discovery` |
| 15 | Incremental reader | `reader.py:59-305` | see C.2 | Y (core value) | B `ingest/reader` |
| 16 | Token dedupe | `reader.py:271-280` | see C.3 | Y | B |
| 17 | Event normalization | `reader.py:24-56` | prompt/say/think/tool/result events with clipping | Y (API contract) | B `ingest/events` |
| 18 | Session rules/labels | `sessions.py:55-117` | see C.4 | Y | B `ingest/classify` |
| 19 | Subagents/workflows | `sessions.py:127-148` | `agent-*.jsonl` + meta + workflow name; tokens aggregated into `usage_total` | Y | B |
| 20 | State classification | `state.py:13-38`, `sessions.py:170-178` | see C.1 | Y | B `core/state` |
| 21 | Claude registry | `state.py:89-101` | optional liveness evidence from `~/.claude/sessions/<pid>.json` when pid alive | Y | B |
| 22 | Attempts table | `panels.py:30-74` | see C.5 | Y (only source of COMPLETED/FAILED) | B `panels/attempts` |
| 23 | Machine panel | `panels.py:87-198` | RAM, CPU%, watched processes (count, MB), docker names | Y* (mechanism changes, see D) | B `panels/machine` |
| 24 | Git/overview panel | `panels.py:213-228` | branch, 3 commits, dirty count, ledger/chain tails, stop file | Y | B `panels/overview` |
| 25 | Live logs | `panels.py:203-210` | up to 4 newest files, tails (16 lines, 220 chars) for the first 2 | Y | B |
| 26 | TTL cache + error ring | `server.py:23-50` | see A.3 | Y | B `runtime/cache` |
| 27 | HTTP API v2 | `server.py:187-243`, `docs/api.md` | additive-only compatibility; no-store; nosniff | Y (Layer C + older clients) | B `runtime/http` |
| 28 | Host validation | `server.py:9,188-191` | 403 plain text unless host is 127.0.0.1, localhost, ::1 | Y (security) | B |
| 29 | Static serving | `server.py:173-185` | allow-listed extensions, no dotfiles/`..`/`:`, realpath inside root, `__TITLE__` replaced | Y* (new UI is a build output) | B serves built UI |
| 30 | Events / search / locate | `server.py:82-151` | pagination, filters, snippets | Y | B |
| 31 | start | `cli.py:175-206` | idempotent, hidden, waits <= ~12 s for health, prints real URL | Y | A+B |
| 32 | serve | `cli.py:209-237` | foreground; port bind; state.json write; cleanup only if pid matches | Y | B |
| 33 | stop | `cli.py:282-312` | kills only a pid whose command line contains `viewer.py`; stale file removed, nothing killed | Y (command-line marker must change, see F.5) | A |
| 34 | restart | `cli.py:315-321` | stop then start; abort if stop failed | Y | A |
| 35 | verify | `cli.py:240-258` | 4 endpoints return JSON, sessions is a list | Y | A |
| 36 | status | `cli.py:261-279` | running, url, pid, uptime, code_stamp, `outdated`, error tail, reader stats, state counts, partial count, newest age | Y | A |
| 37 | check | `cli.py:324-331` | one summary line, validates config | Y | A |
| 38 | doctor | `cli.py:334-380` | list of `{check, ok, detail}`; exit 1 if any false | Y | A |
| 39 | Legacy flags | `cli.py:418-432` | `--config FILE [--check/--stop]`, `--discover`, bare `--config FILE` = serve | Y (docs promise) | A `cli/legacy` |
| 40 | Legacy flat config | `config.py:178-187` | override layer, no workspace, no audit, state in `<config>.state.json` | Y | A |
| 41 | Machine/process spawning without windows | `proc.py`, `cli.py:192-197` | see D | Y | A+B |
| 42 | Demo/fixtures tools | `tests/fixtures/make.py`, `tests/tools/demo.py` | made-up transcripts | Y* (reuse data shape, port builders to TS) | tests |

---

## C. Golden contracts

### C.1 State classification (`state.py:13-38`, called from `sessions.py:170-178`)
Pure function `classify_state(now, mtime, active_seconds, last_stop, pending, oldest_pending_ts, agent_mtimes, grace_seconds, registry=None, external=None, has_records=True)` returning `(state, evidence, source)`. **Rules are evaluated in this exact order** (first hit wins):

| Order | Condition | state | source | evidence text (golden) |
|---|---|---|---|---|
| 1 | `external` truthy | `external.state` | `external` | `external.evidence` |
| 2 | `not has_records` | UNKNOWN | transcript | `no readable records` |
| 3 | registry status `busy` | RUNNING | registry | `Claude session registry reports busy` |
| 4 | `age < active_seconds` (`age = now - mtime`) | RUNNING | transcript | `transcript written %ds ago` |
| 5 | any agent mtime with `now - a < 60` | RUNNING | transcript | `%d subagent(s) written within the last minute` |
| 6 | `pending > 0` and `waited < grace` | RUNNING | transcript | `%d tool call(s) without result for %ds (within the %ds grace)` |
| 6b | `pending > 0` and `waited >= grace` | UNKNOWN | transcript | `%d tool call(s) without result for %dm: stalled, killed, waiting for permission or a very long tool` |
| 7 | registry status `idle` | IDLE | registry | `Claude session registry reports idle; quiet %dm` |
| 8 | `last_stop` in (`end_turn`, `stop_sequence`) | IDLE | transcript | `turn ended (%s), quiet %dm; the transcript cannot show whether the job is finished or waiting` |
| 9 | otherwise | UNKNOWN | transcript | `quiet %dm and the last stop reason is %r` (`'missing'` when empty) |

Details a port must copy:
- `waited = now - oldest_pending_ts` if `oldest_pending_ts` truthy else `age` (`state.py:30`). `oldest_pending_ts` is the minimum epoch of `reader.pending` values, 0 when none parse (`sessions.py:172`).
- `%d` and `//` on floats: Python `%d` truncates toward zero; `age // 60` is float floor. Port with `Math.trunc` / `Math.floor` exactly where the Python does; otherwise evidence strings differ by 1 at boundaries.
- `has_records = bool(reader.total or reader.msgs) and not reader.unreadable` (`sessions.py:175`). Note `total` counts events, `msgs` counts message ids.
- The registry is looked up only for the top-level session (`reg.get(sid)`, `sessions.py:220`); agents pass `registry=None` (`sessions.py:216`), external applies to sessions only.
- **Agent override** (`sessions.py:176-177`): for an agent, `IDLE` + `last_stop` in END_STOPS becomes `COMPLETED` with evidence `subagent ended its turn (%s); it continues only if its parent resumes it`.
- `done` booleans kept for v1 compatibility: session `age >= active_seconds and stop in END_STOPS and no agent younger than 60s` (`sessions.py:223`); agent `aage >= 60 and stop in END_STOPS` (`sessions.py:218`).
- Registry (`state.py:89-101`): every `<CLAUDE_CONFIG_DIR or ~/.claude>/sessions/*.json`; used only if `sessionId` is a string, `status` in (`busy`,`idle`) and `pid_alive(pid)`; result `{status, pid, kind}`.
- External state (`state.py:41-54`, golden table):

| Row | Result |
|---|---|
| `None` or `end is None` | no external evidence (transcript decides) |
| exit not in (None, '', '0', 0) OR status matches `FAIL_RE` (`(FAIL\|BLOCK\|ERROR\|ABORT)`, case-insens., `search`) | FAILED, evidence `chain log: exit=%s status=%s` (`-` when status blank) |
| status matches `PASS_RE` (`^\s*(PASS\|DONE\|OK\|COMPLETE[D]?\|SUCCESS)`, case-insens.) OR (blank status and exit in ('0',0)) | COMPLETED |
| anything else (e.g. exit None + blank status) | UNKNOWN, evidence `chain log: the run ended (exit=%s) but its status %r is neither a pass nor a failure` |
Failure test runs before the pass test, so `PASS_WITH_ERRORS` is FAILED and exit=1 + `PASS` is FAILED (`tests/test_state_config_tasks.py:55-58`).

Tests protecting this: `StateTest` (9 tests, `tests/test_state_config_tasks.py:23-63`), `test_session_states_from_evidence` (`tests/test_server.py:84`).

### C.2 Reader cursor / partial line / truncation rules (`reader.py`)
- Constants: `CHUNK = 4 MiB` (`:15`), `MAX_LINE = 64 MiB` (`:16`), head fingerprint = first 256 bytes (`:165-167`), `KNOWN_TYPES` set of 14 names (`:13-14`).
- **Two cursors**: `eoff` (events) starts at `_line_start(size - window)` when `size > window` else 0 (`:129`); `uoff` (usage) starts at 0 (`:73`). When `size > usage_max`, `usage_state='unavailable'` and `uoff=size` (`:131-132`).
- **Event index `i`** is assigned sequentially from `self.total` by the events cursor (`:291-293`), i.e. relative to the first event parsed in the window, not to the file. "Absolute" in the API means stable across polls for a given reader instance; a reader reset or `want_events` reload re-numbers from 0 (`:103-106`).
- `_scan` (`:219-248`): events cursor first (loop while `eoff < size`, time-boxed to `2 * budget`), then the usage cursor catches up from `uoff` to `eoff` within `budget` seconds. When both cursors coincide a line is parsed once (`usage=(self.uoff == pos)`, `:228`).
- **Partial last line** (`_read_lines`, `:188-217`): only newline-terminated lines are consumed. An unterminated tail is consumed only if `json.loads` succeeds on it (`:204-210`), otherwise left for the next poll. `tail` = bytes of unterminated remainder; `eff = size - tail`; `usage_state = 'complete'` iff `uoff >= size - tail` (`:248`), so a writer mid-line never looks like an incomplete scan.
- **Long records**: the read window grows x4 until a newline is found, up to `MAX_LINE`; an oversized record is skipped and counted as invalid (`:196-213`).
- **Invalid lines**: non-JSON or non-object lines are counted - `inv_events` when seen by the events cursor, `inv_pre` when seen only by the usage cursor before the event window (`:255-261`); `invalid_lines = inv_events + inv_pre`. Blank lines are not counted.
- **Truncation / replacement** (`:109-134`): reset when `size < eoff` or `size < uoff` or the 256-byte head no longer starts with the remembered head. The remembered head is replaced by a longer prefix when the file was shorter than 256 bytes at first. Reset keeps the `keep` flag (`:85`).
- **Unreadable**: `OSError` on stat/open sets `unreadable=True` without clearing state (`:116-118`).
- **Memory cap**: `events` is only filled when `keep` is true; when more than `max_events`, the oldest are dropped, `base` and `dropped` advance (`:301-305`). `keep` is enabled by `want_events` (called for `/api/events|search|locate`, `server.py:226`); the first `want_events` after a list-only refresh clears and re-reads the event window (`:93-107`).
- **Per-record bookkeeping** (`_record`, `:250-305`): `first` = first timestamp seen by the usage cursor, `last` = lexicographic max of timestamps (string compare, `:269`); `models` set; `last_asst`/`last_stop`: when the assistant message id (or `uuid`) changes, `last_stop` resets to `''`, then set from `stop_reason` if present (`:282-288`); `last_type` is tracked but never read elsewhere; `pending[tool_id] = event timestamp` on `tool`, removed on matching `result` (`:297-300`).
- `usage()` (`:136-149`): sums over `msgs`; `turns = len(msgs)`; `scanned_pct = 100` if nothing to scan else `min(100, int(100*uoff/eff))`; for `unavailable`, `scanned_pct = 0` and `skipped: true`.
- `completeness()` (`:151-155`): `events` is `partial` if `events_start > 0 or dropped > 0`.
- `events_of` (`:24-56`) - golden shapes:
  - user string content -> one `prompt`; user list -> `prompt` per `text` block, `result` per `tool_result` block (`id` = `tool_use_id`, `text` = string or `\n`-joined `text` of list items, `err = bool(is_error)`).
  - assistant list -> `say` for non-blank text, `tool` for `tool_use` (`name` default `?`, `summary` = first line of the first truthy of `command, file_path, pattern, description, prompt, script` via `str()`, clipped 160; `input` = clipped 4000 of the JSON-dumped input dict), `think` when `thinking` truthy (clipped 1500).
  - `clip(s, n)`: non-strings are `json.dumps(ensure_ascii=False)`; longer than n -> `s[:n] + ' ... [truncated %d chars]' % (len-n)`. **Python counts code points; JS `.length` counts UTF-16 units.** Port with code-point-aware slicing/counting or the truncation marker will differ for astral characters (emoji).
  - `str(key)` of a non-string `command` yields a Python repr (`"['a', 'b']"`); not reproducible without emulation (edge case, UNVERIFIED how often it occurs in real data).
  - Event `t` = record `timestamp` or `''`.
- Tests: `tests/test_reader.py` (14 tests; see E.3).

### C.3 Token dedupe (`reader.py:271-280`)
Only assistant records whose `message` is a dict and only when the usage cursor sees the line. Key = `message.id` or else record `uuid` or else `line<byte pos>`. Per key keep four counters `in, out, cr, cc` = max seen of `input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens`, and only integer values count (`isinstance(v, int)`; a bool would pass in Python, a float would not). Totals = sum over keys; `turns = len(msgs)`. Cache reads are reported separately (never merged into `in`). Session `usage_total` = own + every agent (`sessions.py:164-167,205-213`); `add_usage` returns only `in,out,cr,cc,turns,complete` (so `usage_total` has no `scanned_pct`, `models`, `first/last/stop`) and `complete` is the AND of both sides.
Reference check: `full_scan_usage` in `tests/test_reader.py:11-25` (independent whole-file computation) and `test_duplicate_records_of_one_message_are_counted_once` (expects `(14, 7, 100, 18, 2)`, `tests/test_reader.py:58-66`). Doc evidence: `reference/transcript-format.md` ("225 records for 112 messages").

### C.4 Session rules (`sessions.py:55-117`)
- Harness boilerplate filter `BOILER = ^\s*<(local-command|ide_|browser_instruction|system-reminder|command-|user-prompt)` (`:8`) applies to **text blocks** of `user` records only (`tool_result` blocks are never text candidates).
- `user_texts(path, limit=25)`: iterates the first 401 lines (`i > 400` breaks), appends all qualifying blocks of a record (`extend`), stops at the next line once `len >= limit`. So it can exceed 25 when one record carries several blocks; nothing truncates the list. Invalid JSON lines are skipped but still consume line numbers.
- `real_first_prompt`: `user_texts(path, 1)[0]`, else `first_user_text` (first 121 lines, first non-empty text block even if boilerplate), else `''`.
- `classify(cfg, path)`: rules tried in order; `scope == 'any'` matches against the first-25 texts joined with `\n`, otherwise against the first real prompt only. `re.search(rule['match'], text, re.S)` - **DOTALL only; no MULTILINE/IGNORECASE** unless inline flags in the pattern. `re.error` at runtime -> rule skipped silently. First match wins.
- Label: `rule.get('label', rule.get('name', 'session'))` (the legacy `name` fallback is undocumented), then for each group index `i` (1-based) replace `{i}` by the group text or `''` for non-participating groups; then `{0}` -> `m.group(0)[:40]`. Substitution is sequential, so group text containing `{2}` is substituted again later. Unmatched: first prompt, stripped, newlines -> spaces, 70 chars, else `(no prompt)`; `matched=False`.
- `session_ids` pins a session (always `matched=True`, shown even outside the window) (`sessions.py:187,196-200`).
- Listing filter: file `mtime` older than `hours*3600` hidden unless pinned; unmatched hidden unless `all=1` or `include_unmatched` (`:201-202`). `/api/attempts` internally lists with `hours=24, show_all=False` regardless of `window_hours` (`server.py:54`).
- Real-world usage of the dialect: the live task `v9-chain` (task config at `<repo>/.claude/monitor/tasks/v9-chain/config.json`) has 2 session rules without scope, and `attempts.start`/`attempts.end` regexes that use `(?P<name>...)` (checked structurally with a script: no inline flags, no lookarounds, no `\A`/`\Z` in any of the 4 patterns). A port that cannot read `(?P<` breaks that task immediately.

### C.5 Attempts table (`panels.py:30-84`)
- Preconditions: `cfg.attempts` truthy and `cfg.chain_log` truthy; otherwise `[]`. (The `panels.attempts` boolean is read only by the frontend; `/api/attempts` and external states ignore it - `server.py:58,214`.)
- Input: `tail_lines(chain_log, 4000)` (reads `max(64 KiB, 4000*400)` bytes from the end, `splitlines()[-4000:]`, UTF-8 with `replace`).
- Per line: `start_re.match(line)` (anchored at position 0, not full-match) first; then `end_re.match(line)`. Start row = `{part, n, model, effort, start, end:None, exit:None, status:None, sid:None}` using `groupdict()` entries; missing `part/n` -> `''`, missing `model/effort` -> `''`. `time` parsed with `time.mktime(time.strptime(g['time'], time_format))` (**local time**, default `%Y-%m-%d %H:%M:%S`); a start line whose time fails to parse is skipped. Rows pending are keyed by `part` only (`open_[part]`), so a second START for the same part replaces the pending slot and leaves the earlier row open (state RUNNING forever).
- End line must have `part` in `open_`; `end` = parsed time, or `start` when the time cannot be parsed; `exit` and `status` are the raw group strings (or `None` when the group is absent).
- Matching rows to sessions: candidates = sessions whose label starts with `label_prefix`; session matches a row when `label == label_prefix + row.part`, `first_epoch` non-zero and `-15 <= first_epoch - row.start <= 600` seconds; the smallest delta wins. The same session can be matched by several rows (no exclusivity). Matched rows get `sid` and `usage_total`.
- Row `state`: `external_state(row)['state']` when it ended, else `RUNNING` when no end. Keeps only the last 30 rows.
- `external_map(rows)`: `{sid: ext}` for rows with a `sid` and an end; fed back into `list_sessions` as `external` (`server.py:58-60`) - this is the only path to COMPLETED/FAILED for top-level sessions.
- Test: `AttemptsTest.test_attempts_rows_and_external_states` (`tests/test_state_config_tasks.py:211-230`) expects `[('A','COMPLETED','sa'),('B','FAILED','sb'),('C','RUNNING',None)]`.
- Required for the port: a `strptime` that supports at least `%Y %m %d %H %M %S` (and ideally the rest of the Python directive set), DST-aware local `mktime`, and full-consumption semantics (Python raises when text remains).

### C.6 Config merge, validation, provenance, schema gate
- **Merge** (`config.py:130-140`): deep copy of base; for key in override: skip `_*`; if key in `MERGED_DICTS` and both sides are dicts -> `update` (shallow, per sub-key); else replace (lists such as `session_rules`, scalars, `null`). Deterministic and non-mutating (`ConfigTest.test_merge_is_deterministic...`).
- **Resolution** (`resolve_runtime`, `config.py:169-196`): task mode reads `task.json` (must exist and be an object) and `config.json`, runs `check_schema_version` on config, validates **strict** and raises `ConfigError('invalid task config <path>: p1; p2')`. Legacy mode: path absolute, source `legacy`, schema check only when the key is present, validation **non-strict and the problem list is only returned, never raised** (so a bad legacy value surfaces later, at use time). No override: source `defaults`, base = cwd.
- **Repo resolution**: `repo = cfg.repo`; in task mode, when the override has no `repo` and `task.json` has one, use the task's; relative repos resolve against the task dir (task), the config file's dir (legacy) or cwd; result is `abspath`; `_source_path` is added to the runtime config (`config.py:190-196`).
- **Validation messages** (golden for CLI output): `unknown key %r`; `<key>: expected <text>, got <json[:60]>`; `session_rules: invalid regex %r (%s)`; `attempts.<start|end>: invalid regex (%s)`; non-object -> `config must be a JSON object`. Type rules: `_is_int` and `_is_num` exclude bool; `port` 1..65535; `window_hours, active_seconds, pending_tool_grace_seconds` positive; `session_rules` items need only a string `match` (`label`/`scope` are not validated); `panels` any-key bool dict; `ui` theme in auto/light/dark, density in comfortable/compact, all other values bool; `poll`/`limits` any-key number dicts; `attempts` null or dict with string `start` and `end` (`label_prefix`, `time_format` unvalidated); `transcripts_dir` string or null.
- **Provenance** (`:143-156`): for each default key; for merged dict keys one entry per default sub-key (`panels.git`); `source` if overridden else `default`; plus override keys unknown to defaults.
- **Schema gate** (`:122-127`): `SUPPORTED_SCHEMAS = (1,)`. Messages: `<where> has no schema_version; refusing to guess (add "schema_version": 1 after checking the keys against docs/configuration.md)` and `<where> uses schema_version <v> but this skill supports [1]; update the skill or migrate the file explicitly`. `tasks.configure` re-checks and refuses `--set schema_version`/`--unset schema_version` (`tasks.py:146-154`). `task.json`'s own `schema_version` is only checked by `audit` (`tasks.py:197`), not by `resolve_runtime`.
- **Atomic write**: `path + '.tmp'` then `os.replace`; JSON indent 2, `ensure_ascii=False`, LF, trailing newline (`config.py:212-217`).
- Tests: `ConfigTest` (5), `TaskTest` (10) in `tests/test_state_config_tasks.py`.

### C.7 Task slug rules
`slugify(name)`: lowercase, runs of `[^a-z0-9]` -> `-`, strip `-`, cut to 48, strip `-` again, empty -> `task` (`config.py:158-160`). `check_slug`: must match `^[a-z0-9][a-z0-9-]{0,47}$` and not in (`con`,`nul`,`prn`,`aux`) (`:163-166`). `task_dir` additionally verifies via `realpath`/`commonpath` that the result stays inside the root (`tasks.py:26-32`). Golden cases: `'Nightly build: Steps A/B'` -> `nightly-build-steps-a-b`; invalid: `../x a/b A '' . -x <60 x's> nul` (`tests:89-93`). Note `slugify` of a name that ends up only `con` yields an invalid slug at `check_slug` (init-task would fail with `ConfigError`, not rename).

### C.8 Audit file format (`tasks.py:44-76`)
- `audit/changes.md` is created on first append with header `# Changes\n\n`; `decisions.md` with `# Decisions\n\n`.
- Change entry (exact; LF; blank line after):
```
## <UTC YYYY-MM-DDTHH:MM:SSZ> | <action>
- Summary: <summary>
- Reason: <reason or "not given">
- Files changed: <comma-space list or "none">
- Validation: <text>
- Outcome: <text>
- Unresolved: <text, default "none">

```
- Decision entry: `## <ts> | <title>\n- Decision: <text>\n- Rejected alternatives: <text or "none recorded">\n\n`.
- `configure` summary = changes joined by `; `, each `<key>: <old> -> <new>` where old is `_short(value)` (JSON, max 120 chars, truncated to 117 + `...`) or `(default <_short(default)>)`; removal: `<key>: <old> -> (removed, default applies)`; Validation text `schema ok (strict)`, Outcome `applied`. `init-task` writes action `init-task`, summary `created task workspace '<slug>'`, files `task.json, config.json, README.md`.
- `last_change` parser: split on `(?m)^## `, last block, timestamp = text before ` | `, summary via regex `- Summary: (.*)` (a summary containing a newline would break it). `inspect`'s `recent_audit` = last 3 blocks split on `(?m)^(?=## )` (the `# Changes` header chunk counts as a block when fewer than 3 entries exist) (`cli.py:125`).
- Privacy rule: audit stores key names and short values; never transcript text (SKILL.md "Rules").

### C.9 Isolation snapshot (`tasks.py:218-233`, `cli.py:153-156`)
For every task except `exclude`: SHA-1 over, for each file in sorted walk order (excluding any file named `state.json`), `path.encode() + bytes`. `configure` takes the snapshot before and after; any difference -> `ERROR: isolation violated: another task changed during configure (this is a bug)` exit 1 (after the write already happened). The hash includes the **absolute path string**, so values are not comparable across machines; only equality within one run is meaningful (golden = the invariant, not the digest).

### C.10 Lifecycle semantics
- **State-file location** (`cli.py:37-42`): `<task>/state.json`; legacy `<abs config>.state.json`; none `<repo>/.claude/monitor/default.state.json`.
- **state.json fields actually written** (`cli.py:220-221`): `pid` (int), `url` (`http://127.0.0.1:<port>`), `port`, `started` (epoch seconds, float), `version` (`__version__`), `task` (slug or null), `config` (path or null). (docs/configuration.md lists only `pid, url, port, started`; verified against the live monitor's file: types `int,str,int,float,str,str,NoneType`.)
- **instance_alive** (`cli.py:69-81`): state file readable AND `pid_alive(pid)` AND `GET <url>/api/health` (3 s timeout) returns a `pid` equal to the file's. Anything else is "dead" (stale files are never trusted).
- **start** (`:175-206`): (1) `build_monitor` first = config validated before spawning anything; also resolves `transcripts_dir` (a disk scan); (2) alive -> `already running: <url> (pid N)` exit 0; (3) stale file removed; (4) spawn `sys.executable template/viewer.py serve [--task S] [--config C] --repo R --root ROOT --state-file SF [--port P]` with all three std handles `DEVNULL`; (5) poll `instance_alive` 60 x 0.2 s; success prints `started: <url> (pid N)`; failure `ERROR: monitor did not become healthy within 12 s; run doctor [--task S]` exit 1; `--open` opens the browser.
- **serve** (`:209-237`): `bind(mon, a.port or cfg.port)`; prints `monitor on <url> (read-only, loopback only; Ctrl+C to stop)`; writes state file (errors recorded, not fatal); on exit removes the state file only if it still names this pid. A kill with `taskkill /F` skips the `finally`, which is why `stop` removes the file itself.
- **Port selection** (`server.py:255-262`): try `port .. port+19` on `127.0.0.1` in order; `allow_reuse_address = False` so a second viewer on the same port fails instead of sharing it (matters on Windows, where SO_REUSEADDR permits port sharing); none free -> `ERROR: no free port near N`. `--port` beats `port` from config; `--port 0` is falsy and falls back to the config port (no ephemeral port).
- **stop** (`:282-305`): no state file -> `nothing to stop (no state file <sf>)` exit 0. Else `cmdline_of(pid)` only if the pid is alive; if `viewer.py` is not in the command line -> state file removed and message `pid N is not a viewer process (already stopped or pid reused); removed the stale state file, nothing was killed` exit 0. Otherwise `taskkill /PID N /F` (POSIX SIGTERM), wait 25 x 0.2 s for the pid to disappear (`pid N still alive after stop request` exit 1), remove the file, `stopped viewer pid N (<url>)`.
- **status** (`:261-279`): exit 0 iff running. Fields: `running, state_file`; when alive `url, pid, uptime_s, code_stamp, outdated, task, config_source, recent_errors[-5:], reader, sessions{RUNNING,IDLE,COMPLETED,FAILED,UNKNOWN counts}, partial_sessions, newest_session_age_s`; when dead with a file `stale_state_file`; `hint` when outdated.
- **code_stamp** (`__init__.py:6-20`): SHA-1 over, for each of the sorted `src/backend/*.py` then `config/defaults.json`, `basename + file bytes` (unreadable files skipped silently), first 10 hex digits. The monitor stores it at construction (`server.py:19`) and reports it in `/api/health`; `status` computes the current stamp and sets `outdated = (health.code_stamp != code_stamp())`. Consequences: any edit under `src/backend` or to `defaults.json` flips every running Python monitor to `outdated: true`; the stamp is engine-specific (a Node engine needs its own definition, and a Node `status` against a Python monitor will always say outdated - which is the correct signal to restart).
- **doctor** (`:334-380`) check names, in order: `python >= 3.8`; `config loads and validates`; `transcripts folder found`; `recent transcripts parse` (5 newest files; ok if invalid lines `== 0` or `< max(5, total_events // 100)`); `rules match at least one session` (ok when no rules or at least one session within the window); `chain_log exists` / `ledger exists` when configured; `state file is current` (stale) or `running monitor answers` + `no recent server errors`; per-task `task <slug> audit` (no `--task`) or `task audit`. Output is a JSON array; exit 1 when any is false.
- **verify** (`:240-258`): fails when no healthy instance; hits `/api/health, /api/config, /api/sessions, /api/overview` (5 s each), `/api/sessions` must be a list; prints `verified <url>: health, config, sessions (N), overview all valid JSON`.
- **Exit codes**: 0 success, 1 failure (`ConfigError`/`OSError` -> `ERROR: <msg>` on stderr), 2 usage (`cli.py:3,16-18,435-453`); no args prints help and returns 2, `-h` returns 0.
- **Host validation** (`server.py:187-191`): `host = Host.rsplit(':', 1)[0].strip('[]').lower()` must be in `127.0.0.1, localhost, ::1` else 403 `text/plain` body `forbidden host (this viewer only answers on 127.0.0.1 or localhost)`. Tested hosts: 403 for `evil.example.com`, `127.0.0.1.evil.com`, `evil.com:80`, empty; 200 for `localhost:<port>`, `127.0.0.1`, `[::1]:80` (`tests/test_server.py:53-57`). Quirk: a bare `::1` without brackets/port becomes `:` and is rejected.

### C.11 HTTP contract details beyond docs/api.md
- Only `GET` is implemented (other methods -> Python's default 501); every response has `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; protocol is HTTP/1.0 (connection per request) (`server.py:160-168`).
- JSON from `json.dumps` default: ASCII-escaped non-ASCII. Equivalent for any JSON client.
- `/api/sessions?hours=<float>&all=1`: non-numeric -> 400 `{"error":"hours must be a number"}`; cache key `sessions|<hours string>|<all>` TTL 3 s.
- `/api/events|search|locate`: `sid` must match lowercase UUID regex and `agent` `^[0-9A-Za-z_-]{3,64}$`, resolved via directory listing, never path-joined from the client (`sessions.py:151-161`); unknown -> 404 `{"error":"not found"}`; bad ints -> 400 (`after, before and limit must be integers`).
- `/api/events`: default `after=-1` -> last 250; `after=N` -> up to `limit or 2000` (limit clamped 1..2000); `before=N` -> `limit or 250` events preceding N; response `{total, from, base, next, partial, skipped_bytes, events}` (`server.py:82-103`).
- `/api/search`: case-insensitive substring over `text, summary, input, name` joined by spaces; filters `kinds`, `tool`, `errors=1` (error results plus their tools), `limit` 1..1000 default 200; snippet = 160 chars of `text or summary or input` starting 40 chars before the match; `truncated = count > len(matches)` (`:105-138`).
- `/api/locate`: `i` clamps into `[base, total-1]`; `ts` = first event with `t >= ts` (string compare) else last; 404 `no events` when none.
- `/api/health` fields: `ok, version, pid, started, uptime, now, code_stamp, task{id,name,description}|null, config_source, transcripts_dir(bool), errors[<=20], reader{files, invalid_lines, bytes_scanned, unknown_records}` (docs/api.md's example omits `code_stamp` and `unknown_records`).
- Static: `index.html` placeholder `__TITLE__` replaced with the title HTML-escaped for `&` and `<` only (`server.py:184`); allowed extensions `.html .css .js .svg .json .txt`; 404 for dot segments, `..`, `:` in a segment, other extensions (`tests/test_server.py:59-63`).

---

## D. Windows and process specifics

| Concern | Python implementation (evidence) | What a Node port must do |
|---|---|---|
| Detached start without console window | `Popen(..., creationflags=CREATE_NO_WINDOW\|CREATE_NEW_PROCESS_GROUP, stdio=DEVNULL)` (`cli.py:192-197`; constants `proc.py:7-8`). The comment states `DETACHED_PROCESS` is avoided because every child of a console-less process opens a visible window; `test_06` forbids the string `DETACHED_PROCESS` in `cli.py` (`tests/test_cli.py:127-135`). | Node `spawn(..., {detached:true, windowsHide:true, stdio:'ignore'})` + `unref()`. libuv (v1.x HEAD, `src/win/process.c:1099-1128`, fetched 2026-10-11) adds `CREATE_NO_WINDOW` when hide flags are set and no stdio is inherited, and `DETACHED_PROCESS \| CREATE_NEW_PROCESS_GROUP` when `detached` is set. Per Microsoft's CreateProcess documentation `CREATE_NO_WINDOW` is ignored with `DETACHED_PROCESS` (documentation statement from memory: UNVERIFIED here). So the detached Node process has no console, and **every child it spawns must pass `windowsHide:true`** or a console may flash. Whether the bundled libuv of Node 24.14.1 is identical to HEAD, and whether a window actually flashes, is UNVERIFIED (needs an empirical test on this machine). Alternative with no new risk: launch through a tiny hidden `powershell -WindowStyle Hidden Start-Process` or keep `node` as a hidden console child; decide after the empirical test. |
| Child processes never flash windows | every helper goes through `proc.run` (`proc.py:11-14`); `test_06` greps `src/backend/*.py` for `subprocess.run(` (`tests/test_cli.py:127-134`). | One `exec` helper that always sets `windowsHide:true`; enforce with a lint rule or a grep test on `child_process` imports (the grep test cannot be copied literally). |
| Pid liveness without signalling | `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION=0x1000)` + `GetExitCodeProcess == 259 (STILL_ACTIVE)`; POSIX `os.kill(pid,0)` with `PermissionError` = alive (`state.py:62-86`). The comment says Python's `os.kill(pid,0)` would kill on Windows. | Node's `process.kill(pid, 0)` is the documented liveness probe. Verified 2026-10-11: libuv `uv_process_kill` has a `case 0` "Health check: is the process still alive?" branch comparing the exit code to `STILL_ACTIVE` (`process.c:1416-1423`), and on this machine `process.kill(process.pid,0)` returned normally and `process.kill(999999,0)` threw `ESRCH`. Treat `EPERM` as alive. Same edge as Python: a process that exited with code 259 reads as alive. |
| Verify a pid's command line before stop | `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=<pid>').CommandLine"` (20 s timeout; roughly one PowerShell start per stop) on Windows, `/proc/<pid>/cmdline` elsewhere; marker is the substring `viewer.py` (`cli.py:58-66,288`). | Same query (or `wmic` is deprecated; CIM via PowerShell is what exists today). The marker must be extended: the Node monitor's command line will not contain `viewer.py`, and **both** markers must be accepted by the new CLI (old Python monitors still run) - and the old Python CLI will refuse to stop a Node monitor (see F.5). |
| Kill | `taskkill /PID <pid> /F` on Windows (no `/T`), `SIGTERM` elsewhere, then poll up to 5 s (`cli.py:291-300`). | `taskkill /PID /F` (or `process.kill(pid)` which on Windows is a forced terminate); no graceful hook runs, so the state-file removal stays in `stop`. A Node monitor could add a graceful `SIGINT`-style path only on POSIX. |
| Machine panel (Win32 via ctypes) | `GlobalMemoryStatusEx` (load %, avail/total phys) `panels.py:164-167`; `GetSystemTimes` delta for CPU% with a module-global previous sample, first call returns `None` (`:98-108`); `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` + `Process32FirstW/NextW` + `OpenProcess(0x1000)` + `K32GetProcessMemoryInfo.WorkingSetSize` for watched executables, matched by lowercased `szExeFile` against `watched_processes` (`:123-157`). Introduced because `tasklist` cost about 0.7 s CPU per call (`docs/changelog.md`, 2.0.1: about 16 ms with Win32). | Free/total memory: `os.freemem()/os.totalmem()` (not verified equal to `ullAvailPhys`; UNVERIFIED). CPU%: delta of `os.cpus()` times between two calls (first call `null`, same contract). **Per-process working set has no Node built-in** (`process.memoryUsage` is self only). Options: a native/FFI dependency (e.g. a Win32 binding - violates "no new dependency without reason", needs an ADR), a small bundled helper executable, or `tasklist /FO CSV` / PowerShell `Get-Process` with a long cache TTL (cost 0.7 s CPU each, UNVERIFIED for PowerShell). Decide in the architecture phase; keep the API shape `{name, count, mb}` sorted by `mb` descending. |
| Docker polling + cache | `docker ps --format '{{.Names}} ({{.Status}})'`, 8 s timeout, result cached 10 s in a module global; failure -> `['(docker unavailable)']`; disabled by `docker:false` -> `[]` (`panels.py:190-198`). | Same command via the no-window helper; global 10 s TTL independent of the 1.8 s machine cache. |
| Git polling | three calls per overview: `git branch --show-current`, `git log --format=%h %ad %s --date=format:%H:%M -3`, `git status --short` (line count = `dirty`), cwd = repo, 10 s timeout, failure -> `''`; the whole overview is cached 10 s (`panels.py:213-228`, `server.py:209`). Linux/macOS machine path exists and is unverified (`docs/troubleshooting.md`). | Same commands and cache. `git status --short` can be slow on large repos; the 10 s TTL already bounds it. |
| Process memory budget | about 27 MB idle, 33 MB with one tab, 0.1% / 3-4% of one core (`docs/changelog.md` 2.0.1, "measured"); 50 MB with 300+ transcripts known. | Baseline for acceptance criteria (the numbers are the skill's own claims; not re-measured by me). |
| Local-time parsing | chain-log times use `time.mktime(time.strptime(..))` (local zone); transcript timestamps are UTC ISO. | Explicit handling of both; never mix. |
| Text decoding | transcripts read as bytes + `json.loads`; head/prompt scans use `open(..., encoding='utf-8', errors='replace')` and **universal newlines**; `tail_lines` decodes with `replace` and uses `str.splitlines()` (splits also on `\x0b \x0c \x1c-\x1e \x85    `). | Use Python-compatible line splitting for chain/ledger/log tails (or accept and document the difference); for transcripts split on `\n` at the byte level as the Python reader does (`reader.py:215`). |

---

## E. Dependencies, config surface, tests

### E.1 Python standard library used (from `import` lines)
| Module(s) | Files |
|---|---|
| `os` (all), `json`, `re`, `time`, `glob` (most files) | config, tasks, reader, state, sessions, panels, cli |
| `hashlib` | `__init__` (code_stamp), tasks (snapshot, config_hash); imported but unused in `reader.py` |
| `copy` | config (deepcopy) |
| `datetime` | tasks (UTC ISO now), sessions (`fromisoformat`) |
| `threading` | reader (RLock per reader, Lock in pool), server (cache locks) |
| `ctypes` (+`wintypes`) | state (pid_alive), panels (machine) |
| `subprocess` | proc, cli (`Popen`); imported but unused directly in panels |
| `http.server, socketserver, urllib.parse, collections` | server |
| `argparse, sys, urllib.request, webbrowser` | cli (`csv`, `urllib.error` imported but unused) |
External programs: `git`, `docker`, `powershell` (Get-CimInstance), `taskkill`, `ps` (POSIX machine panel). Network: loopback only, no outbound code (`docs/architecture.md` "Security posture"). Python floor: documented 3.8 (`cli.py:341`, `docs/development.md`); only exercised on 3.14.3 by me, so the floor is UNVERIFIED. `datetime.fromisoformat` use is why timestamps are normalised with `Z -> +00:00` (`sessions.py:122`).

### E.2 Config surface (`config/defaults.json`, schema `config.py:58-81`)
| Key | Default | Type/validator | Used by |
|---|---|---|---|
| `schema_version` | 1 | int | gate |
| `title` | `"Claude sessions monitor"` | non-empty string | `/api/config`, page title |
| `port` | 8765 | int 1..65535 | bind start (+0..19) |
| `repo` | `"."` | string | git, logs, chain_log, transcripts detect |
| `transcripts_dir` | `"auto"` | string or null (`auto`/null = detect) | Monitor init |
| `window_hours` | 8 | number > 0 | session list default window |
| `active_seconds` | 120 | number > 0 | RUNNING rule 4, `done` |
| `pending_tool_grace_seconds` | 900 | number > 0 | rule 6 |
| `include_unmatched` | false | bool | session filter |
| `session_rules` | `[]` | list of `{match(str), label?, scope?}` | classify |
| `session_ids` | `[]` | list of strings | pin |
| `panels` | `{machine:true, git:true, logs:true, ledger:false, chain_log:false, attempts:false}` | bool dict (merged) | overview (git, ledger, chain_log) + frontend |
| `live_log_globs` | `[]` | list of strings | live logs |
| `chain_log` | null | string or null | attempts, overview |
| `ledger` | null | string or null | overview |
| `stop_file` | null | string or null | overview `stop` |
| `attempts` | null | null or `{start,end,label_prefix?,time_format?}` | attempts |
| `watched_processes` | `claude.exe java.exe node.exe python.exe docker.exe com.docker.backend.exe vmmemWSL chrome.exe Code.exe` | list of strings | machine |
| `docker` | true | bool | machine |
| `ui` | `{theme:"auto", density:"comfortable", newest_first:true, show_tools:true, show_thinking:false, show_prompts:false}` | merged dict | frontend |
| `poll` | `{events_ms:1500, sessions_ms:6000, machine_ms:2000, logs_ms:3000, overview_ms:5000, attempts_ms:6000, stale_after_ms:15000}` | merged number dict | frontend |
| `limits` | `{event_window_mb:8, max_events:20000, text_chars:6000, usage_scan_budget_ms:1500, usage_max_mb:512}` | merged number dict | reader pool (`reader.py:321-323`) |
Fixed constants not in config: events default page 250 / max 2000; search default 200 / max 1000; agent-recent window 60 s; attempt match window `-15..600` s; attempts rows kept 30; log tail 16 lines x 220 chars, 4 files, 2 with tails; ledger tail 30, chain tail 10; docker TTL 10 s; overview TTL 10 s; reader idle prune 1800 s; error ring 20; `start` wait 12 s; stop wait 5 s; cached TTLs per A.2. Task `task.json` keys: `schema_version, id, name, description, created, repo, links` (`tasks.py:87-89`). `watched_processes` default is Windows-centric.

### E.3 Test inventory (all run: 56 passed)
| File | Tests | What it protects |
|---|---|---|
| `tests/test_reader.py` | 14 | incremental == full scan while file grows (`:43`); duplicate message records counted once (`:58`); missing usage fields/unknown types/non-dict records (`:68`); invalid JSON lines counted (`:77`); partial last line not consumed and not counted, scan still `complete` (`:86`); unterminated valid last record accepted (`:102`); truncation and replacement by a larger different file reset the reader (`:107`); big file -> events `partial`, usage converges under a zero budget (`:122`); usage `unavailable` over size cap while events work (`:140`); record larger than a chunk (5 MiB) parses (`:147`); event cap keeps absolute indexes (`:155`); pending tools (`:164`); `events_of` shapes (`:170`); missing file = unreadable not error (`:178`). Line numbers are for the file itself. |
| `tests/test_state_config_tasks.py` | 25 (StateTest 9, ConfigTest 5, TaskTest 10, AttemptsTest 1) | every `classify_state` branch, external mapping, `pid_alive` safety; defaults valid, merge determinism, validation, slugs, schema gate; init/reuse, traversal, configure validate+audit+preserve, invalid change writes nothing, no-op does not audit, task isolation, provenance, unsupported schema fails safely, audit flags a copied `.jsonl`, repo stored relative; attempts rows + external map |
| `tests/test_server.py` | 11 | Host validation, static traversal/types, escaped title, unknown ids and bad params (404/400), session states from evidence on the fixture home, agents grouped by workflow with aggregated tokens, events pagination/index stability, search/locate, health/task/config shape, stale-but-valid cache and error ring, file growth picked up by the next poll. Runs a real `Server` on an ephemeral port (`('127.0.0.1', 0)`). |
| `tests/test_cli.py` | 6 | full lifecycle init/inspect/configure/audit (`:42`); start/verify/status/idempotent start/restart/doctor/stop on port 8830 (`:64`; **hard-coded port 8830/8840**); stale state file and pid reuse never kill another process (`:96`); two tasks side by side + port conflict moves on (`:114`); no bare `subprocess.run`, no `DETACHED_PROCESS` (`:127`); legacy `--config --check/--stop` (`:137`) |
| `tests/frontend/*.test.mjs` (Node `node:test`) | 4 files, 39 `test(` occurrences by grep (not run) | frontend pure modules: filters/timeline, format, markdown safety, prefs/api |
| `tests/fixtures/make.py` | helper (100 lines) | builders: `user, assistant, text, tool, result, write_jsonl, append_jsonl, age, conversation, build_home` (fake `CLAUDE_CONFIG_DIR` with sessions done/failing/running/pending/parent + subagent `aaa111` with `.meta.json` + workflow `wf1`/`review-changes` agent `bbb222`) |
| `tests/tools/demo.py`, `screenshots.mjs` | tooling | made-up demo project covering all five states + huge transcript; not tests |

Coverage gaps (observed, not assumed): no unit test for `sessions.classify` rule semantics (scope any, `{n}` substitution, `{0}`), `detect_transcripts_dir`, `user_texts` boilerplate filtering, `registry()`, the machine/git/log panels, `configure --unset`, dotted-key set into non-objects, `legacy_args`, HTTP method handling, or `tail_lines`. A port should add golden tests for these from the Python behavior documented above (these are the likeliest places for silent drift).

---

## F. Migration risks and compatibility constraints

### F.1 Promised compatibility (`docs/architecture.md`, "Compatibility constraints"; `docs/api.md` header)
1. v1 endpoints and fields unchanged; v2 only adds; clients ignore unknown fields; `done` kept (deprecated).
2. v1 CLI flags (`--config FILE [--check|--stop]`, `--discover`) and the path `template/viewer.py` unchanged. SKILL.md and every task's instructions call `python .claude/skills/monitoring-claude-sessions/template/viewer.py <command>` - the user's `SKILL.md` procedure and the live V9 chain depend on that exact invocation.
3. Legacy flat configs keep working as an override layer.
4. Schema gate: unsupported `schema_version` stops with an error; no silent migration.
**Port consequence:** either keep `viewer.py` as a thin shim that execs the Node CLI (needs Python on PATH, which is a contradiction for a "no Python" goal) or change the documented entry point and update SKILL.md, in a way recorded in an ADR. Option: keep `template/viewer.py` unchanged for the transition and add the Node entry beside it.

### F.2 Regex dialect (highest silent-drift risk)
Python `re` vs JavaScript (checked 2026-10-11 on Node 24.14.1 / V8 13.6 and Python 3.14.3):
| Construct | Python | JS (`new RegExp`) | Port action |
|---|---|---|---|
| Named group `(?P<n>..)` | valid | **SyntaxError** (`Invalid group`) | translate to `(?<n>..)`; `(?P=n)` -> `\k<n>` (SyntaxError today) |
| Leading inline flags `(?i)a` | valid | **SyntaxError**; only scoped `(?i:..)` is accepted | hoist leading `(?aiLmsux)` to JS flags `i m s`; reject or reject-with-message `x`, `a`, `L`, `u` |
| Mid-pattern global flag `a(?i)b` | error in Python 3.11+ (`global flags not at the start`) | SyntaxError | same error class |
| `\A`, `\Z` | start/end of string | **silently literal `A`/`Z`** in non-unicode mode (verified: `/a\Z/.test("aZ")` is true, `/a\Z/.test("a")` is false) | translate to `(?<![\s\S])` and `(?![\s\S])`, or reject |
| `$` (no MULTILINE) | matches at end **and before a trailing `\n`** (verified `$` matches `"a\n"`) | end only (verified false) | translate to `(?=\n?(?![\s\S]))` |
| `\w`, `\d`, `\s` on `str` | Unicode-aware (verified `\w` matches `é`) | ASCII for `\w`/`\d` even with `u` (verified false), Unicode for `\s` | translate to `\p{L}\p{N}_` classes or document the limit |
| `[[:alpha:]]` | literal set (FutureWarning) | literal set (no error) | same, but warn |
| Possessive `a++`, atomic `(?>..)` | valid in 3.11+ | **SyntaxError** | reject with a clear message |
| `re.S` (DOTALL) used for session rules | on | flag `s` | always set `s` for `session_rules`; none for `attempts` (`match` without flags) |
| `re.search` vs `re.match` | rules use search; attempts use match (anchored at 0, not full match) | `search` vs sticky/`^` anchor | keep the distinction |
| Case-insensitive helper regexes | `re.I` on `PASS_RE`, `FAIL_RE` | `i` flag | trivial |
| Capture groups `None` | `g or ''` | `undefined` | same substitution |
| Unicode flag semantics, surrogate pairs | code points | UTF-16 unless `u` flag | use `u` flag where the translation allows |
Validation happens at `configure` time with Python's compiler (`config.py:141-152`): a Node `configure` must reject exactly what the Python engine would reject, **or** the shared task config becomes unreadable by the Python engine (it re-compiles at load with `validate`, raising `ConfigError` for task configs). Recommended rule for the transition: a pattern is accepted only if it compiles in both dialects after translation, and the original (Python-syntax) text is what is stored in `config.json` (docs/configuration.md and the shipped examples say "Regexes use Python syntax"). The live task's `attempts` patterns already use `(?P<..>)`.

### F.3 Task workspace layout shared between engines
`<repo>/.claude/monitor/tasks/<slug>/` is owned by the monitored project, written by whichever engine runs `init-task/configure/decide`. Constraints: same file names, same JSON key order/indent (2 spaces, trailing newline, `ensure_ascii=False`), same audit markdown (C.8, so `last_change` and any existing tooling parse both), same `schema_version: 1`. Any new Node-only key must not appear in `config.json` (the Python strict validator rejects unknown keys and refuses to start) - put new state in new files (e.g. a separate sibling file) or bump `schema_version` (Python then refuses safely, which is the designed behavior). Real example on this machine: task `v9-chain` has `task.json, config.json, README.md, state.json, audit/{changes.md,decisions.md}` (listing).

### F.4 Running monitors
- A live Python monitor (`v9-chain`, port 8765, started from the skill files) loaded its code at start; it keeps running unchanged until restarted. `status` marks it `outdated` as soon as `src/backend/*.py` or `config/defaults.json` changes on disk (and the Python frontend is read from `src/frontend` on every request, so editing those files changes the live UI immediately). **Do not edit `defaults.json`, `src/`, or the frontend in place while it runs**; build the Node platform in a separate directory.
- `restart`/`stop` from a Node CLI must recognise the Python process (`viewer.py` in command line) and the Python-format `state.json`.

### F.5 state.json ownership across two engines
- The file is the contract between CLI and monitor: `{pid, url, port, started, version, task, config}`; liveness is `pid_alive` + `/api/health.pid == state.pid`. A Node monitor can honor this by exposing `/api/health` with the same `pid` key.
- Cross-engine failure modes: (1) The Python CLI `stop` against a Node monitor finds no `viewer.py` in the command line, **deletes the state file and kills nothing**, leaving an orphan Node monitor with no state file (the Python CLI then reports "nothing to stop" and `start` would launch a second monitor on the next free port). (2) The Node CLI `start` against a task with a running Python monitor must report `already running` rather than starting a second one. (3) `serve` removes the file only if it names its own pid (`cli.py:231-236`), the Node monitor must do the same. (4) Two engines writing `state.json` for the same task concurrently is unguarded (no lock); idempotent `start` relies on the health probe, not on locking.
- The `version` field differs by engine and is informational.

### F.6 Behavioral risks of a rewrite
1. **Time-budgeted progressive usage scan**: Python's threads let a slow scan overlap other requests; Node is single-threaded - `_read_lines` parsing 4 MiB chunks synchronously blocks the event loop (the Python budget `usage_scan_budget_ms` 1500 ms per poll per reader would stall all requests). Needs async I/O, chunking and yielding, or a worker thread.
2. **Cursor semantics are intentionally subtle** (two cursors, event index relative to window, `inv_pre` vs `inv_events`, unterminated-valid-JSON acceptance). Port them as-is first; do not "simplify" without golden tests (C.2).
3. **Per-poll cost model**: `list_sessions` re-opens and scans the first lines of every transcript in the window to classify (`classify` reads up to 401 lines, twice for `scope:any`) on every uncached call (3 s TTL). Cache `classify` by (path, mtime, size) in the port to avoid O(files) disk work, but the first-prompt rules must still see changes if the early lines change (they cannot, the head is append-only except replacement).
4. **Evidence text** is human-visible and used in docs/tests; keep byte-identical until the UI is replaced.
5. **Latent defects in the Python engine** (do not copy blindly; decide per item and record):
   - `'workflows' in p` tests the whole path, so an agent under a project folder whose path contains the word `workflows` is tagged as a workflow member using its parent directory name (`sessions.py:138`).
   - `os.path.relpath` in `init_task` raises `ValueError` (not caught by `main`'s `(ConfigError, OSError)`) when repo and task root are on different drives (`tasks.py:86`).
   - Legacy configs: validation problems are computed but never raised (`config.py:187,196`).
   - `usage_total` lacks `scanned_pct`/`models`; `usage.scanned_pct` reflects only the own transcript.
   - `config_hash` in `inspect` hashes `json.dumps(cfg, sort_keys=True)` of a dict that includes `_source_path` (absolute), so it is machine-specific (`tasks.py:177`); not a portable golden value.
   - Attempts rows keyed by `part` only; attempts window fixed at 24 h; a session can match multiple rows.
   - `last_type` is dead state; unused imports (`hashlib` in reader, `csv`, `subprocess` in panels, `urllib.error`).
   - Docs drift: `docs/api.md` health example says version `2.0.0` and omits `code_stamp`/`unknown_records`; `docs/configuration.md` omits `version, task, config` in `state.json`; `SKILL.md` says `node --test tests/frontend` while `docs/development.md` uses `"tests/frontend/*.test.mjs"`.
6. **Privacy**: unmatched sessions get the first prompt text as `label` in `/api/sessions` (`sessions.py:117`), and events expose clipped prompt/response/tool text through `/api/events` by design; loopback + Host check are the only protections. Keep both and never log them.
7. **Cross-platform**: Linux/macOS machine panel and `/proc` command-line paths exist but were never verified (`docs/changelog.md` 2.0.2 "Not verified").
8. **Test portability**: `test_cli.py` uses fixed ports 8830/8840 and real child processes; `test_06` is a source-grep. The Node suite needs ephemeral ports (the unit-level `Server(('127.0.0.1', 0), mon)` pattern in `test_server.py:23` is the model).

---

## G. Capability -> target module mapping (proposal)

Proposed layout (names are proposals for the architecture phase; npm workspaces monorepo, TypeScript, Node >= 24):

| Capability (current) | Proposed module | Layer | Reuse notes |
|---|---|---|---|
| defaults, merge, provenance, validation, schema gate, slug | `packages/core` -> `config/` (`defaults`, `merge`, `validate`, `provenance`, `slug`) | A+B | **Reuse `config/defaults.json` as-is** (single file, shared by both engines during transition). Port `SCHEMA` as a table-driven validator (zod or hand-written; a dependency decision for the ADR). |
| Python-regex translation + safe compile | `packages/core` -> `pyregex/` (translate + reject list from F.2, label templating `{0..n}`) | A+B | New; golden-tested against `re` behavior captured by running Python once to emit fixtures |
| state classification + external state + evidence strings | `packages/core` -> `state/` (`classifyState`, `externalState`) | B | Pure; port line by line, table in C.1 is the test spec |
| events normalization, clip (code-point aware), usage aggregation, dedupe | `packages/core` -> `transcript/` (`eventsOf`, `UsageAccumulator`) | B | Pure; fixtures from `tests/fixtures/make.py` |
| TranscriptReader (cursors, partial line, truncation) + ReaderPool | `packages/ingest` -> `reader/` (async, budgeted, yields to event loop) | B | Behavior contract C.2; use the 14 reader tests as the spec; consider a file watcher only as an optimization (poll remains the source of truth) |
| transcripts-dir detection, rules, subagents/workflows, registry | `packages/ingest` -> `discovery/` (`transcriptsDir`, `sessionRules`, `agents`, `registry`) | B | Add the missing golden tests (E.3 gaps) |
| attempts table (+ strptime/mktime) | `packages/ingest` -> `attempts/` | B | `strptime` subset module in `core` |
| machine / git / docker / logs / overview panels | `packages/runtime` -> `panels/` (`machine`, `git`, `docker`, `logs`, `overview`) with one `exec` helper (`windowsHide:true`) | B | Machine process list is the open design question (D, row 6) |
| `Monitor` (config + pool + TTL cache + error ring), health | `packages/runtime` -> `monitor/` (`ttlCache`, `errorRing`, `health`) | B | Keep per-key single-flight + last-good-value semantic |
| HTTP API, Host check, static serving, port bind (+19) | `packages/runtime` -> `http/` (Node `http` or Fastify; bind `127.0.0.1`, `exclusive`) | B | v2 contract frozen by `docs/api.md`; add contract tests that diff Node JSON shapes against the Python engine on the same fixtures |
| process lifecycle: detach, state.json, pid liveness, cmdline check, kill | `packages/cli` -> `lifecycle/` (`start`, `serve`, `stop`, `status`, `restart`, `verify`, `doctor`) | A+B | Marker list `['viewer.py', '<node marker>']`; `process.kill(pid,0)` for liveness |
| tasks: init/reuse, configure, decide, inspect, audit, snapshot | `packages/core` -> `tasks/` + `packages/cli` commands | A | Audit/markdown format C.8 byte-identical; atomic write helper |
| CLI argument parsing, legacy flags, exit codes | `packages/cli` -> `commands/`, `legacy/` | A | Same command names and exit codes; keep `--help` listing |
| `code_stamp` / outdated | `packages/runtime` -> `version/` (hash of the built runtime + defaults) | A+B | Redefine; document that Python and Node stamps are not comparable |
| SKILL.md procedure, docs | skill folder (`SKILL.md`, `docs/`) | A | Update entry point text only after the ADR; keep `reference/transcript-format.md` |
| Frontend (vanilla ES modules, ~13 files) | `packages/ui` (React) | C | Replaced; keep `docs/ui-decision-record.md` as input; API tests above guard the contract |
| Fixtures/demo builders | `packages/testkit` (TS port of `make.py`/`demo.py`) | tests | `tests/fixtures/make.py` can keep generating golden fixtures from the Python engine until it is retired |

### G.1 What can be reused unchanged
- `config/defaults.json` (read as-is by the TS config loader; the Python engine reads the same file, so any change must stay additive and Python-valid).
- `reference/transcript-format.md` and `reference/viewer-reference.md` (documentation of the on-disk format; verified on Claude Code 2.1.289/2.1.296, 2026-10-11 per the file).
- `docs/api.md` as the API contract, `docs/configuration.md` as the config contract, `docs/troubleshooting.md` as the symptom list (update names of commands/markers).
- `template/config.example.json` and `template/examples/chain.config.example.json` (note: the chain example contains `(?P<..>)` patterns, which exercises the translator).
- Test data: output of `tests/fixtures/make.py` and `tests/tools/demo.py` (made-up, no real data) as shared fixtures; run the Python engine over them once to capture golden JSON for `/api/sessions`, `/api/events`, `/api/search`, `/api/attempts`, `inspect`, `status` shapes.
- The unit test suites as executable specs: port `test_reader.py`, `test_state_config_tasks.py`, `test_server.py` nearly one-to-one; rewrite `test_cli.py` with ephemeral ports.

### G.2 Suggested order for the port (risk-first)
1. `core/pyregex` + `core/config` + `core/tasks` + audit format (shared files with the live engine: highest compatibility risk).
2. `core/state`, `core/transcript`, `ingest/reader` with the reader and state golden tests.
3. `ingest/discovery`, `ingest/attempts`.
4. `runtime/http` contract tests against Python on identical fixtures.
5. `cli/lifecycle` with the cross-engine `stop`/`status` cases in F.5.
6. Panels, then the UI.

---

## Appendix: commands run and observations
| Command | Observation (2026-10-11) |
|---|---|
| `python -m unittest discover -s tests` (skill folder, `PYTHONDONTWRITEBYTECODE=1`) | `Ran 56 tests in 4.651s`, `OK` |
| script over `<repo>/.claude/monitor/tasks/*/{state,config,task}.json` printing only key names/types | state keys `pid,url,port,started,version,task,config`; config keys `attempts, chain_log, ledger, live_log_globs, panels, port, schema_version, session_rules, stop_file, title, window_hours`; 2 rules; attempts keys `end,label_prefix,start,time_format`; patterns contain `(?P<` and no inline flags/anchors/lookarounds |
| `node` regex probes (`new RegExp` on Python constructs; `/a\Z/`) | table in F.2 |
| `curl https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/process.c` -> grep | lines 1099-1128 (hide/detach flags), 1416-1423 (signal 0 health check) |
| `node -e process.kill(pid,0)` on self and on pid 999999 | no throw / `ESRCH` |
| `git status --short` in the skill repo before the run | clean; the test run created no tracked changes (unittest ran with bytecode writing disabled) |

---

## Verification log (2026-10-11)

Adversarial pass by a second agent against the primary sources (files re-opened, commands re-run on this machine).

| Claim | Verdict | Evidence |
|---|---|---|
| 9-rule classification order and evidence strings (C.1) | confirmed | Re-read `state.py:13-38`: order external, no records, busy, age, recent agents, pending (grace / stalled), idle, END_STOPS, fallback; `%d` and `//` forms as listed. |
| `state.py` line citations (353-378, 381-393, 402-426, 429-441, 370) | corrected | `state.py` has 101 lines (`wc -l`), so those ranges could not exist. Replaced in place with 13-38, 41-54, 62-86, 89-101, 30 (checked with `grep -n "^def"`). |
| Agent override to COMPLETED; `has_records`; `oldest` pending (`sessions.py:172-177`) | confirmed | `_view` at `sessions.py:170-178` matches. |
| External state table, FAIL checked before PASS (C.1) | confirmed | `state.py:41-54`. |
| Token dedupe key and per-field max, ints only (C.3) | confirmed | `reader.py:271-280` (key `m.get('id') or uuid or 'line%d'`, `isinstance(v, int)`). `add_usage` returns only in/out/cr/cc/turns/complete (`sessions.py:164-167`). |
| Attempts table: `match` anchored, local-time `mktime`, key by part, `[-15,600]`, last 30, 24 h window | confirmed | `panels.py:30-84` and `server.py:54-56` re-read. |
| Config merge, schema gate messages, slug rule (C.6, C.7) | confirmed | `config.py:122-166` re-read. |
| Audit format and isolation snapshot (C.8, C.9) | confirmed | `tasks.py:44-76`, `tasks.py:218-233` (SHA-1 over `path.encode()+bytes`, skips `state.json`). |
| state.json fields; stop only if `viewer.py` in command line; removes file itself (C.10, F.5) | confirmed | `cli.py:216-224` (written dict), `cli.py:282-305`. The cross-engine orphan consequence is inference from that code, not run. |
| Port range +19 and `allow_reuse_address = False` | confirmed | `server.py:248,255-262`. |
| `code_stamp` definition | confirmed | `__init__.py:6-20` re-read. |
| Regex dialect table (F.2) | confirmed | Node 24 (V8 13.6.233.17): `(?P<n>a)` and `(?i)a` give "Invalid group", `(?>a)` "Invalid group", `a++` "Nothing to repeat" (also a SyntaxError); `/a\Z/.test("aZ")` true; `/a$/.test("a\n")` false; `/\w/u.test("é")` false. Python: `$` matches before trailing newline, `\w` matches `é`. |
| libuv flags and signal-0 branch | confirmed with caveat | Fetched `libuv/libuv` `v1.x` `src/win/process.c` (1488 lines today): hide flags add `CREATE_NO_WINDOW` and detached adds `DETACHED_PROCESS \| CREATE_NEW_PROCESS_GROUP` (plus `CREATE_SUSPENDED`, not mentioned above) near lines 1099-1128; `case 0` health check starts at line 1416. `process.kill(self,0)` returned normally and `process.kill(999999,0)` gave `ESRCH`. HEAD is not necessarily the libuv bundled in Node 24.14.1 (already marked UNVERIFIED in D). |
| Tests: 56 unit tests (reader 14, state/config/tasks 25, server 11, cli 6) and 39 frontend `test(` calls | confirmed | `python -m unittest discover -s tests` -> `Ran 56 tests ... OK`; per-file counts 14/25/11/6; frontend grep counts 16+7+5+11 = 39. |
| Per-process memory cost "0.7 s vs 16 ms" | unverifiable | Quoted from the skill's own `docs/changelog.md`, not re-measured here. |
| Privacy / secrets scan of this file | confirmed clean | grep for emails, tokens, key words and user-profile paths found nothing; no transcript text is quoted. |
