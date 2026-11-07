# HTTP API (v3)

The server of a task listens on `127.0.0.1:<port>` only. The full, generated contract (every route, its parameters, its response
schema and its errors) is [api/reference.md](api/reference.md), generated from the route registry
`runtime/packages/shared/src/api/routes.ts`; the JSON Schemas are under `schemas/api/`.

## Rules

- Read-only: every route is a `GET`, except `POST /api/v3/ingest/nudge`, whose body carries no data.
- Requests whose `Host` is not a loopback name, or whose `Origin` is foreign, are refused (`host_not_allowed`,
  `origin_not_allowed`, `cross_site_request`). This is a safeguard, not authentication.
- Responses are JSON; errors use one envelope with a stable `code`. Lists are paged with a keyset cursor. Times are UTC.
- Clients must ignore unknown fields: new fields may be added within v3.
- The web UI is served from `/` with a strict Content Security Policy and loads nothing from the network.

## Routes served in 4.0

| Area | Routes |
|---|---|
| Health and identity | `/api/v3/health`, `/api/v3/health/ingest`, `/api/v3/instance`, `/api/v3/config`, `/api/v3/errors`; `/api/health` (compatibility body read by the CLI) |
| Overview | `/api/v3/overview` |
| Sessions | `/api/v3/sessions`, `/api/v3/sessions/:sessionId` and its `agents`, `timeline`, `tool-calls`, `transitions`, `usage` |
| Transcript | `/api/v3/sessions/:sessionId/transcript` (a window read from the file on request), `.../transcript/locate` |
| Across sessions | `/api/v3/agents`, `/api/v3/events`, `/api/v3/events/:eventId`, `/api/v3/tool-calls` |
| Work items | `/api/v3/work-items`, `/api/v3/work-items/:workItemId` |
| Alerts | `/api/v3/alerts`, `/api/v3/alerts/rules` (read only; the rules are evaluated inside the monitor) |
| Ingestion | `POST /api/v3/ingest/nudge`, `/api/v3/ingest/probes/:probeSessionId` |
| Live updates | `/api/v3/stream` (server-sent events: hello, change, heartbeat and reset frames) |

The reference also lists routes of features that are not built in 4.0 (search, analytics, panels, export). In 4.0 those answer
404 `route_not_found`.

## Session states

`state` is one of `running`, `working`, `waiting_input`, `waiting_tool`, `waiting_agent`, `turn_ended`, `completed`, `failed`,
`stale`, `unknown`, each with evidence, a `basis` and a `confidence`. A transcript alone never yields `completed`: a finished turn
is `turn_ended`. See [architecture.md](architecture.md), "State model".
