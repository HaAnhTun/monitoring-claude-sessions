# HTTP API (v2) and static assets

Loopback only (`127.0.0.1`), read-only, JSON over `GET`. Requests whose `Host` header is not `127.0.0.1`, `localhost` or `::1` get 403. Host validation and loopback binding are safeguards, not authentication. Every response carries `Cache-Control: no-store`.

**Compatibility rule:** every v1 endpoint and field is unchanged; v2 only adds fields, endpoints and query parameters. Clients must ignore unknown fields.

## Static files
- `GET /` serves `src/frontend/index.html` (the `<title>` is replaced with the configured title).
- `GET /static/<path>` serves files below `src/frontend/` (`.html .css .js .svg .json .txt`). No `..`, no absolute paths, no dotfiles; anything else is 404. ES modules load from `/static/modules/*.js`.
- The page must not load anything from the network except these same-origin files.

## Concepts

### Session state (separate from monitor health and data freshness)
`state` is one of `RUNNING`, `IDLE`, `COMPLETED`, `FAILED`, `UNKNOWN`.

| State | Evidence required |
|---|---|
| `RUNNING` | transcript written within `active_seconds`; or a subagent written within 60 s; or a tool call without result and quiet less than `pending_tool_grace_seconds`; or the Claude session registry says `busy` |
| `IDLE` | quiet longer than `active_seconds`, nothing pending, last stop reason `end_turn`/`stop_sequence` (the turn ended; the transcript alone cannot show whether the job is finished or waiting), or the registry says `idle` |
| `COMPLETED` | external evidence only: the chain log / attempts table reports an end with a PASS-like status |
| `FAILED` | external evidence only: the attempts table reports a non-zero exit or a FAIL/BLOCKED-like status. A failed poll never produces `FAILED` |
| `UNKNOWN` | no usable records; or a tool call has been pending longer than `pending_tool_grace_seconds` (stalled, killed or a very long tool); or the file is unreadable |

Fields next to `state`: `state_evidence` (short human text), `state_source` (`transcript`, `registry` or `external`), `pending_tools` (count of tool calls without result).

For **subagents** a finished turn (`end_turn`, quiet over a minute) is shown `COMPLETED` (state_source `transcript`): a subagent cannot continue unless its parent resumes it.

The v1 boolean `done` stays for compatibility (heuristic, deprecated). New UI must use `state`.

### Completeness
`completeness`: `{ "events": "full"|"partial", "events_skipped_bytes": int, "usage": "complete"|"partial"|"unavailable", "usage_scanned_pct": 0-100, "invalid_lines": int }`.
- `events: partial` means older events were not loaded (the file was bigger than the event window, or the in-memory cap dropped the oldest events).
- `usage: partial` means the token scan has not reached the end of the file yet (totals are lower bounds and grow on later polls); `unavailable` means the file is over the size limit or unreadable.
- Never present `partial`/`unavailable` totals as complete.

### Monitor health vs data freshness
- Health (`/api/health`) describes the monitor process. Freshness is measured by the client: time since the last successful response of each poll. The page marks data **stale** when no poll succeeded for `poll.stale_after_ms`.

## Endpoints

### `GET /api/health`
```json
{"ok": true, "version": "2.0.0", "pid": 123, "started": 1790000000.0, "uptime": 42.0, "now": 1790000042.0,
 "task": {"id": "nightly-build", "name": "Nightly build"} , "config_source": "task|legacy|defaults",
 "transcripts_dir": true,
 "errors": [{"t": 1790000040.0, "where": "sessions", "message": "…"}],
 "reader": {"files": 12, "invalid_lines": 0, "bytes_scanned": 123456}}
```
`task` is `null` for legacy configs. `errors` holds at most the 20 most recent server-side errors.

### `GET /api/config`
v1 fields (`title, panels, active, window_hours, transcripts_dir:bool`) plus:
`version`, `task` (`{id,name,description}` or null), `ui` (`theme: auto|light|dark`, `density: comfortable|compact`, `newest_first`, `show_tools`, `show_thinking`, `show_prompts`), `poll` (`events_ms, sessions_ms, machine_ms, logs_ms, overview_ms, attempts_ms, stale_after_ms`), `features` (`{"search": true, "locate": true}`).
`ui` values are defaults; the viewer's own saved preferences win in the browser.

### `GET /api/sessions?hours=N&all=1`
Array, newest first. v1 fields: `id, label, matched, age, size, agents[], usage, usage_total, first_epoch, done`. v2 adds `state, state_evidence, state_source, pending_tools, completeness`.
`agents[]` items: `agent, label, model, workflow, age, size, usage, done` plus the same v2 fields. There is no cap on the number of agents; `workflow` (name or id, `""` for plain subagents) lets the client group them.
`usage` / `usage_total`: `in, out, cr, cc, turns` (+ `models, first, last, stop` for `usage`) plus v2 `complete` (bool) and `scanned_pct`.

### `GET /api/events?sid=ID&agent=AGENTID&after=N&before=N&limit=N`
- `after=-1` (default) returns the last 250 events. `after=N` returns events with index ≥ N (at most 2000 per call; use `next`). `before=N` returns the `limit` (default 250) events just before index N, for loading older history.
- Response: `{ "total": int, "from": int, "base": int, "next": int, "partial": bool, "skipped_bytes": int, "events": [...] }`. Indexes are absolute and stable: the first available event has index `base` (> 0 when older events were dropped). `next` = index to pass as `after` on the next poll (equals `total` when caught up).
- Each event: `{i, t, k, ...}` where `t` is an ISO UTC timestamp and `k` one of:
  - `prompt` `{text}`; `say` `{text}`; `think` `{text}`
  - `tool` `{id, name, summary, input}` (`input` is a JSON string, truncated)
  - `result` `{id, text, err}` (`id` equals the `id` of the `tool`; `err` true for tool errors)
  - Text fields are truncated at `limits.text_chars`; when truncated they end with ` ... [truncated N chars]`.
- 404 `{"error":"not found"}` for unknown ids.
- A `tool` is **active** while no `result` with the same `id` has arrived, **failed** when its result has `err: true`, otherwise **completed**. That pairing is done by the client.

### `GET /api/search?sid=ID&agent=AGENTID&q=TEXT&kinds=say,tool,result,prompt,think&tool=Bash&errors=1&limit=200`
Searches the events currently held in memory for that transcript (case-insensitive substring of text/summary/input/name; empty `q` allowed with other filters). `errors=1` keeps only `result` events with `err` and their tools. Response: `{ "matches": [{"i":int,"k":"…","t":"…","name":"…","snippet":"…"}], "count": int, "truncated": bool, "partial": bool }` ordered by index ascending, at most `limit` (default 200, max 1000).

### `GET /api/locate?sid=ID&agent=AGENTID&ts=ISO|i=N`
`ts`: nearest event index at or after that ISO timestamp; `i`: clamps an index into the available range. Response `{ "i": int, "t": "…", "base": int, "total": int }`; 404 when there are no events.

### `GET /api/task`
`{ "task": {id,name,description,created,schema_version,repo} | null, "config_source": "task|legacy|defaults", "last_change": {"t":"…","summary":"…"} | null }`.

### Unchanged v1 panel endpoints
`/api/overview` `{ledger[], chain[], branch, commits[], dirty, stop, now}`; `/api/machine` `{free_gb, total_gb, used_pct, cpu_pct, procs[{name,count,mb}], docker[], now}`; `/api/logs` `[{name, age, size, tail[]}]`; `/api/attempts` `[{part, n, model, effort, start, end, exit, status, sid, usage_total}]` (v2 adds `state`: `COMPLETED`/`FAILED`/`RUNNING`/`UNKNOWN` derived from `exit`/`status`).

### Errors
Non-2xx responses are JSON `{"error": "message"}` (except 403 and static 404, plain text). 500 responses are also recorded in `/api/health` `errors`.

## Icon sprite
`GET /static/icons.svg` is an SVG sprite of `<symbol id="i-NAME">` (24×24, `stroke="currentColor"`, `fill="none"`, stroke-width 2, round caps). Use as `<svg class="icon"><use href="/static/icons.svg#i-NAME"/></svg>`. Names: `running idle completed failed unknown search copy refresh chevron-down chevron-right arrow-up arrow-down alert sun moon density tool user bot filter x check clock help wifi-off layers cpu git-branch keyboard link`.
