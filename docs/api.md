# HTTP API (v3)

The server of an instance (a task or the user instance) listens on `127.0.0.1:<port>` only. The full, generated contract (every
route, its parameters, its response schema and its errors) is [api/reference.md](api/reference.md), generated from the route
registry `runtime/packages/shared/src/api/routes.ts`; the JSON Schemas are under `schemas/api/`.

## Rules

- A task instance is read-only: every route it serves is a `GET`, except `POST /api/v3/ingest/nudge`, whose body carries no
  data. The user instance adds the routes that start, write to and kill terminals; they are `POST` routes behind the access code
  (see "Writes and the access code").
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

## Writes and the access code

The routes of the terminal and of the access code exist on the user instance only; a task instance answers
`404 route_not_found` for them. Every route says who may call it (the `Access:` line of the reference):

| Access | Who may call | Routes |
|---|---|---|
| `open` | any local client that passes the `Host` and `Origin` checks | the monitor routes (lists, counts, health, the stream) and `authSession` |
| `reader` | a valid session cookie, or, on `GET` and `HEAD` only, the control token of the instance (`run/control.token`) as `Authorization: Bearer <token>`; served open on a task instance | the nine routes that return transcript content: `transcriptWindow`, `transcriptLocate`, `searchTranscript`, `searchTranscripts`, `export`, `getEvent`, `listToolCalls`, `sessionToolCalls`, `sessionTimeline` |
| `ticket` | the one-time access code in the body | `authExchange` |
| `session` | a valid session cookie | `authLogout`, `terminalState`, `terminalEvents`, `terminalSocket`, `terminalCreateSession`, `terminalKillSession`, `terminalPickFolder`, `terminalResume`, `listFolders`, `addFolder`, `removeFolder`, `sessionResume` |

Lists, counts, labels and working folders of every project stay `open` to local clients, so the command line, the skill and the
MCP server keep working; the control token is accepted on `reader` routes and nowhere else, and never on a `POST`.

**Signing in.** A one-time access code (43 characters, valid once and for 120 seconds, at most four outstanding) is minted over
the control channel and printed by the command line tool in a link `http://127.0.0.1:<port>/#code=<code>`. The code is in the
fragment, so it never reaches a log, a `Referer` header or the request line. The page posts it once:

- `POST /api/v3/auth/exchange` with `{"code": "<code>"}` answers `200 {"authenticated": true}` and sets
  `caw_<first 8 hex characters of the instance id>=<credential>; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`. The cookie
  holds a different value from the code (a credential of 43 characters), so the printed code is useless once exchanged.
- A wrong, expired or used code is `401 access_code_invalid`. After eight wrong codes within 60 seconds every wrong code is
  `429 access_rate_limited` with `Retry-After`; a valid code still redeems.
- A credential lives 24 hours at most and 12 hours without a request; at most 16 are valid at once (the oldest is revoked).
  `POST /api/v3/auth/logout` revokes the credential of the cookie: its terminal sockets close with 4003 and its event streams
  end. A restart of the instance invalidates every credential.

**What a write needs**, checked in this order: the `Host` is `127.0.0.1:<port>` or `localhost:<port>`; the `Origin` header is
present and exactly `http://127.0.0.1:<port>` or `http://localhost:<port>` (`403 origin_not_allowed`; the terminal socket needs
it too); `Content-Type: application/json` and `X-MCS-Request: 1` (`403 csrf_rejected`); the session cookie
(`401 access_required` with `WWW-Authenticate: CAW-Access`); a JSON body of at most 4096 bytes in strict UTF-8
(`413 payload_too_large`, `400 body_invalid_json`) that matches a strict schema (`400 validation_failed`; `details` name the
path and the issue code, never the value). A refused write closes the connection without reading its body. No route takes a
command line, arguments or an environment: the host plans and builds `claude` itself.

## Terminal socket

`GET /api/v3/terminal/sessions/:name/socket` (`terminalSocket`, access `session`) upgrades to a WebSocket (RFC 6455, version 13)
that carries one terminal. `:name` matches `^[A-Za-z0-9_-]{1,64}$`. The handshake must offer the subprotocol `caw.terminal.v1`
(the server selects it), carry the cookie and an exact `Origin`, and runs through the same checks as any other request. No
compression is negotiated. A refusal is the normal JSON error envelope on the connection, with no `101`, and the connection
closes:

| Status | Code | When |
|---|---|---|
| 426 | `upgrade_required` | not a WebSocket upgrade (a plain `GET`, `Upgrade: h2c`, an `Upgrade` that is a list or anything but `websocket`); the answer carries `Upgrade: websocket` |
| 401 | `access_required` | no valid cookie |
| 403 | `host_not_allowed`, `origin_not_allowed`, `cross_site_request` | the usual checks; a missing `Origin` is `origin_not_allowed` |
| 400 | `validation_failed` | a bad name, a key that is not 16 bytes in base64, a version other than 13, a `Sec-WebSocket-Protocol` list that cannot be parsed (an empty element, a duplicate, a character that is not a token character; `invalid_format`) or that does not offer `caw.terminal.v1` exactly as written, so `CAW.TERMINAL.V1` does not count (`invalid_value`); `details` name the header, never its value |
| 503 | `terminal_unavailable` | this system cannot run terminals |
| 404 | `terminal_not_found` | no session of that name |
| 503 | `stream_limit` | 32 sockets on the instance or 8 on one session |
| 503 | `shutting_down` | the server is stopping |

**Frames (protocol v1).** Binary frames carry terminal bytes, text frames carry protocol messages; a client sends binary to the
terminal and routes every text frame of the server to its protocol handler, never to the terminal.

| Direction | Frame | Meaning |
|---|---|---|
| client to server | binary | raw input bytes, written to the process unchanged; at most 262144 bytes per message (`TERMINAL_INPUT_MAX_BYTES`), else close 1009 |
| client to server | text, at most 256 bytes | `{"type":"resize","cols":n,"rows":n}` with whole numbers from 1 to 1000; clamped to 20 to 500 columns and 5 to 200 rows |
| server to client | text | `{"type":"ready","v":1,"cols","rows","replayBytes","viewers"}` first, before any byte |
| server to client | binary | the replay snapshot in chunks of at most 64 KiB (`replayBytes` in all), then live output in frames of at most 64 KiB |
| server to client | text | `{"type":"live"}` once the replay is sent |
| server to client | text | `{"type":"size","cols","rows"}` to every viewer when any viewer resizes (the last resize wins) |
| server to client | text | `{"type":"exit","code","signal"}` after the last output, then the close 4000 (4001 when the kill route ended it) |

The replay snapshot and the subscription to live output are one step, so no byte is lost or sent twice between them. Several
viewers may watch one session; the server never echoes input. A malformed text frame (not JSON, a wrong shape, an unknown
`type`, an extra key, a float or a size outside 1 to 1000) closes with 1008; a text frame over 256 bytes closes with 1009; an
unmasked client frame or a reserved bit closes with 1002. The schemas are in
[`schemas/api/terminal-socket.schema.json`](../schemas/api/terminal-socket.schema.json).

**Close codes** (a client tells them apart by number; the reason is a fixed token, never request data):

| Code | Reason | Meaning | A client |
|---|---|---|---|
| 1000 | | the client leaves | |
| 1001 | `shutting_down` | the server is stopping | reconnects with back-off |
| 1002 | | protocol error (unmasked frame, reserved bit) | |
| 1008 | `bad_message` | a malformed text frame | |
| 1009 | `too_big` | a message over its limit | |
| 1011 | `internal_error` | the host failed | |
| 1013 | `slow_consumer` | the connection holds more than 4 MiB it has not read (beyond the replay just sent) | reconnects; the replay re-synchronises the screen |
| 4000 | `exited` | the process ended | does not reconnect |
| 4001 | `killed` | the kill route ended the process | does not reconnect |
| 4003 | `signed_out` | logout, or the credential expired or was revoked | shows the locked state |

**Backpressure and liveness.** Output is sent as frames of at most 64 KiB, one per turn of the event loop. The process is never
slowed down for a viewer: a viewer that holds more than 4 MiB (or whose output waits for more than 4 MiB) is closed with 1013
and may reconnect for the replay (the replay buffer is 1 MiB by default, `terminal.replayBytes`, and is kept in memory only). The server pings every 30 seconds; a connection that did
not answer by the next tick is terminated. The same tick closes the sockets of a credential that expired. At shutdown every
socket is closed with 1001 and what is still open after one second is terminated. The server logs counts and close codes only,
never a session name, a folder, a keystroke or a byte of output.

## Terminal events

`GET /api/v3/terminal/events` (`terminalEvents`, access `session`) is a server-sent event stream for the session list, so that a
session started in another tab appears and one that exited leaves at once:

- `retry: 3000`, then `hello` (`instanceId`, `epoch`, `serverTime`, `heartbeatMs`), then `sessions` (`version` and the full list
  of live sessions, at most 64), sent on connect and after every change, coalesced to one frame per 50 ms, then `heartbeat`
  (`serverTime`) every 15 seconds.
- Latest wins: a frame is the whole list, so a client keeps the highest `version` and nothing is queued or replayed. A client
  that does not read for 30 seconds is dropped and reconnects.
- At most 8 streams on the instance; the ninth is `503 stream_limit`, answered before any byte of the stream. A browser keeps
  one stream for all its tabs (ADR 0087).
- State and token counts of a row are not on this stream: the row carries a `link` to the monitored session, and the page
  joins it with the monitor stream and the usual queries.

`GET /api/v3/terminal/state` answers the same list once and is the polling fallback while the stream is down. The schemas are in
[`schemas/api/terminal-events.schema.json`](../schemas/api/terminal-events.schema.json). The decisions behind both channels are
in [ADR 0087](decisions/0087-terminal-socket-protocol-and-event-channel.md).

## Session states

`state` is one of `running`, `working`, `waiting_input`, `waiting_tool`, `waiting_agent`, `turn_ended`, `completed`, `failed`,
`stale`, `unknown`, each with evidence, a `basis` and a `confidence`. A transcript alone never yields `completed`: a finished turn
is `turn_ended`. See [architecture.md](architecture.md), "State model".
