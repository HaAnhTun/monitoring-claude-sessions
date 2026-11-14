# Architecture (4.0)

A monitor of Claude Code sessions with a terminal for them. The monitoring never writes to transcripts and never starts, stops or signals a session; only the terminal part
starts, writes to and kills the `claude` processes the application itself started (ADR 0079). It binds `127.0.0.1` only and has one engine: the Node runtime. Transcripts contain private data (prompts, file contents, possibly
secrets): the page shows them, so the port must never be exposed. Decisions are recorded in [decisions/](decisions/).

## Repository layout

```
.claude-plugin/                 plugin.json and marketplace.json (the plugin "session-monitor", ADR 0061)
install.mjs                     install path B: copies the skill folder into a skills folder
skills/monitoring-claude-sessions/   the self-contained skill folder that both install paths ship (ADR 0062)
  SKILL.md                      how an agent operates the monitor
  scripts/mcs.mjs               the launcher (Node floor check, then the bundle or a checkout build)
  scripts/mcs-hook.mjs          stable hook entry point (`mcs hooks install` is opt-in)
  bundle/                       committed build: mcs-cli.mjs, mcs-server.mjs, mcs-hook.mjs, web/, migrations/, notices
  config/defaults.json          shared monitor defaults; runtime/defaults.json: runtime section defaults
  reference/                    agent reference: configuration, troubleshooting, transcript format
runtime/                        npm workspace with the TypeScript sources (developers only)
  packages/shared               contracts: zod schemas, API route registry, protocol ids, environment variable list
  packages/engine               configuration, workspaces, transcript ingestion, lifecycle, SQLite, queries, operations
  packages/server               HTTP server (express), API routes, server-sent events, control channel, static web assets
  packages/cli                  the `mcs` commands and the hook handler
  packages/web                  the React web UI (built with Vite)
  packages/testkit              test helpers: synthetic Claude homes, demo data, frozen fixtures
  scripts/                      build, bundle, CI, Docker POSIX harness, schema generation
schemas/                        generated JSON Schemas (CLI envelope, API, workspace files)
docs/                           user and developer documentation, ADRs (decisions/), design notes (design/)
```

Task workspaces live in the monitored repository, not in the skill: `<repo>/.claude/monitor/tasks/<slug>/` (see
[configuration.md](configuration.md)). A per-user folder `MCS_HOME` (default `%LOCALAPPDATA%/mcs` on Windows,
`${XDG_STATE_HOME:-~/.local/state}/mcs` elsewhere) holds locks and route files shared by all tasks.

## Process model

```
node scripts/mcs.mjs <command>        launcher: Node >= 22.22.0, then imports bundle/mcs-cli.mjs in-process
        │ start
        ▼
detached server process (bundle/mcs-server.mjs), one per task
  ├── ingest service: tails transcripts, registry and job files ──> SQLite (<workspace>/data/monitor.db, node:sqlite)
  ├── lifecycle: derives the state of every session, agent and workflow from facts
  ├── HTTP API /api/v3/* + /api/v3/stream (SSE) + static web UI   on 127.0.0.1:<port>
  └── control channel (named pipe or Unix socket) for stop, status and identity checks
```

`start` waits until the server answers its health route and writes `state.json`; a second `start` for the same task reports the
running one. `stop` asks the server through the control channel and kills a process only after it verified the process identity.
`status` compares the code stamp of the running server with the files on disk (`outdated`).

## Data flow

```
Claude Code ── writes ──> <claude home>/projects/<project>/<session>.jsonl, <session>/subagents/**, workflows
                          <claude home>/sessions/<pid>.json (registry), <claude home>/jobs/<id>/state.json (daemon jobs)
        │ read-only, incremental (byte offsets, truncation and replacement detected)
        ▼
ingest writer: events, tool calls, token usage (deduplicated by message.id), file links, cursor ── one transaction
        ▼
lifecycle facts ──> session / agent / workflow state with evidence, basis and confidence
        ▼
query layer ──> HTTP API (docs/api.md) ──> web UI (polling plus server-sent events)
```

The claude home is `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. `transcripts_dir: "auto"` finds the project folder of the
repository from its path. The database holds metadata only (ids, times, states, counts, file references): transcript text is read
from the transcript file on request and is never copied into the database (ADR 0016, 0022).

## State model

Execution state, monitor health and data freshness are three separate things.

- **Execution state** per session and agent: `running`, `working`, `waiting_input`, `waiting_tool`, `waiting_agent`, `turn_ended`,
  `completed`, `failed`, `stale`, `unknown`, each with evidence, a basis (observed or inferred) and a confidence. The CLI and the
  compatibility health route map them to `RUNNING`, `IDLE`, `COMPLETED`, `FAILED`, `UNKNOWN`. A transcript alone never proves
  completion: a finished turn is `turn_ended` (`IDLE`). `completed` and `failed` need external evidence (a finished daemon
  job, or a finished attempt read from `chain_log` and `attempts`). External evidence keeps the time its source recorded (ADR 0069).
- **Monitor health**: `/api/v3/health` (runtime, database, ingestion, recent errors).
- **Data freshness**: measured by the page per data source.

## Security posture

Loopback bind; `Host` and `Origin` validation against DNS rebinding and cross-site requests (not authentication); every monitoring route is
read-only `GET` apart from a body-less ingest nudge. The terminal is the one active part (ADR 0079): it acts only on processes it started, its write routes and its
WebSocket need the per-start access code, and the MCP server and the skill never touch a terminal; ids are validated and resolved through directory listings, never joined from
client input; the web UI is served with a strict Content Security Policy and loads nothing from the network; transcript text is
rendered as text, never as HTML. No outbound network code. See ADR 0045.

## Shipping

Users run the committed bundle; they never run npm or a build. The bundle is built with rolldown from the sources and is
deterministic: `npm run bundle:check` rebuilds it and compares (ADR 0063). There is one native dependency, the terminal's `@lydell/node-pty` (ADR 0080; Windows x64 and arm64 prebuilds, loaded by path, not part of the bundled code): SQLite is Node's
built-in `node:sqlite` behind the single driver seam `engine/src/db/driver.ts` (ADR 0064), and the terminal WebSocket uses `ws` (ADR 0081).

## Where to change what

| Goal | Edit |
|---|---|
| New monitor config key | `skills/monitoring-claude-sessions/config/defaults.json`, the schema in `engine/src/config`, `docs/configuration.md` and the skill's `reference/configuration.md` |
| New runtime section key | `shared/src/config/runtime/<section>.ts` |
| New state rule | `engine/src/lifecycle` and its tests |
| New API route | `shared/src/api/routes.ts`, a handler in `server/src/routes`, `npm run schemas` |
| New command | `cli/src/commands`, the `CLI_COMMANDS` list of `tests/tooling/plugin-layout.test.ts` when `SKILL.md` teaches it |
| Web UI | `packages/web/src` |
