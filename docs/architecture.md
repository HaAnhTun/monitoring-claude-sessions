# Architecture

Read-only monitor for Claude Code sessions. It never writes to transcripts, never starts or stops sessions, and binds `127.0.0.1` only. Transcripts contain private data (prompts, file contents, possibly secrets): the page shows them, so never expose the port.

## Layout
```
SKILL.md                    how an agent operates the skill (short)
template/viewer.py          entry point (only adds ../src to sys.path and calls backend.cli.main)
template/config.example.json, template/examples/   legacy flat configs (still supported)
config/defaults.json        shared defaults: the single source of truth for every default value
src/backend/
  config.py                 defaults + overrides merge, validation, schema versions, provenance
  tasks.py                  task workspaces: init/reuse, configure + audit, inspect, isolation snapshot
  reader.py                 TranscriptReader / ReaderPool: incremental, defensive JSONL reader
  state.py                  session state classification (pure), Claude session registry, pid liveness
  sessions.py               transcripts dir detection, rule classification, subagents, session list
  panels.py                 machine, git, log tails, ledger, attempts table
  server.py                 Monitor (config + readers + caches), HTTP handler, static files
  cli.py                    commands: discover init-task inspect configure decide audit check start serve verify status stop doctor
src/frontend/               index.html, styles.css, app.js, modules/*.js, icons.svg (no build, no CDN)
tests/                      unittest (backend, stdlib only) and node:test (frontend pure modules)
docs/                       api.md  architecture.md  configuration.md  development.md  troubleshooting.md  ui-decision-record.md changelog.md
reference/                  transcript-format.md (what Claude Code writes), viewer-reference.md (short key list)
```
Task workspaces live outside the skill, in the monitored repository: `<repo>/.claude/monitor/tasks/<slug>/` (see configuration.md). The skill folder holds tools; the repo holds per-task data.

## Data flow
```
Claude Code ── writes ──> ~/.claude/projects/<proj>/<sid>.jsonl, <sid>/subagents/**, <sid>/workflows/*.json
                          ~/.claude/sessions/<pid>.json (registry: busy/idle, interactive sessions only)
optional: chain log, ledger, live logs, git, docker, tasklist
        │ read-only
        ▼
ReaderPool (one TranscriptReader per file, checkpoints in memory)
        │ per poll: only the bytes appended since the last poll are parsed
        ▼
sessions.list_sessions → state.classify_state (evidence → RUNNING/IDLE/COMPLETED/FAILED/UNKNOWN)
        │ shared TTL cache (all tabs share one computation)
        ▼
HTTP JSON API (docs/api.md)  ──poll──>  browser (vanilla ES modules)
```

## Reader (reader.py)
- Two cursors per file. The **events cursor** starts at the last `event_window_mb` of a big file so something shows at once; the **usage cursor** starts at byte 0 and advances within `usage_scan_budget_ms` per poll. When both are in sync a line is parsed once.
- Handles: files growing while read; an unterminated last line (consumed only when it is already valid JSON, otherwise waited for; a writer mid-line never makes the scan look incomplete); invalid lines (counted, skipped); unknown record types (counted); records longer than a chunk (the window grows up to 64 MB); truncation and replacement (the first 256 bytes are compared on every poll; any change resets the reader, so two files are never mixed).
- Token totals deduplicate by `message.id` (Claude Code writes one assistant message as several records that repeat the usage; each field takes the maximum). `complete=false` + `scanned_pct` while the scan is behind; `unavailable` above `usage_max_mb`.
- Events are kept in memory only for transcripts somebody opened (`want_events`), capped at `max_events` (oldest dropped, indexes stay absolute). Readers idle for 30 minutes are dropped. Measured: about 50 MB RSS with 300+ transcripts known.

## State model (state.py, evidence table in api.md)
Execution state, monitor health and data freshness are three separate things:
- **Execution state** per session/agent: from transcript recency, pending tool calls, subagent activity, the optional Claude registry, and external evidence (attempts table). A transcript alone never proves completion or failure; a finished turn is `IDLE`. A subagent whose turn ended is shown `COMPLETED` (it cannot continue unless its parent resumes it).
- **Monitor health**: `/api/health` (process alive, recent server errors).
- **Data freshness**: measured by the page per endpoint (time since the last successful poll). A failed poll never changes a session's state.

## Concurrency and caching
`ThreadingMixIn` HTTP server, one thread per request. `Monitor.cached(key, ttl, fn)` computes once per key per TTL under a per-key lock, so cost does not grow with the number of tabs; if a recomputation raises, the previous good value is served and the error goes to `/api/health`. Each reader has its own lock.

## Security posture
Loopback bind; `Host` validated (127.0.0.1, localhost, ::1) against DNS rebinding; this is not authentication. Session and agent ids are validated (UUID / id pattern) and resolved through directory listings, never joined from client input. Static files: allow-listed extensions, no dotfiles, `realpath` must stay inside `src/frontend`. The page renders transcript text only through `textContent`. No outbound network code. `stop` kills only a pid whose command line contains `viewer.py` and whose state file names it.

## Compatibility constraints
- v1 endpoints and fields are unchanged (v2 only adds). `done` is kept (deprecated).
- v1 CLI flags (`--config FILE [--check|--stop]`, `--discover`) and `template/viewer.py` path are unchanged.
- Legacy flat config files keep working as an override layer over the shared defaults.
- The old single-file page is gone (replaced by `src/frontend`); its panels all remain.
- Transcript format is undocumented upstream: see `reference/transcript-format.md` for what was verified and on which versions.

## Where to change what
| Goal | Edit |
|---|---|
| New config key | `config/defaults.json` + `SCHEMA` in `config.py` + `docs/configuration.md` |
| New state rule | `state.classify_state` + its tests + the table in `docs/api.md` |
| New API field | `server.py`/`sessions.py` + `docs/api.md` + frontend consumer |
| Look and feel | `src/frontend/styles.css` (tokens at the top) |
| Timeline behaviour | `src/frontend/modules/timeline.js` |
