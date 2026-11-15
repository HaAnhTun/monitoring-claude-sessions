# 0087 Terminal socket protocol v1 and the session event channel

Status: Accepted (CAW, 2026-11-15). Owner: server area (srv), design 02 (sections 5, 6 and 10, amendment A5). Related: 0079 (the stance), 0081 (`ws`), 0084 (write surface and
guard order), 0085 (access ticket and cookie), 0083 (terminal service in the engine, the replay buffer).

## Context
A terminal is a long-lived, two-way byte stream, and the list of sessions around it changes while nobody asks. The product needs, from the spec: binary frames carrying raw bytes
in both directions and one text message for the size (the MTOP wire format); a session that outlives its tab, with a replay when a tab comes back; several viewers per session;
and a list that follows sessions that appear and exit. The server must keep every check of the request chain on the handshake (a socket is the one request that can run code as the
user), never let one slow tab stall the process or the other tabs, and never write what the user types or sees into a log.

Three facts shape the decision. Node does not give an `upgrade` request a response object, so a naive handler skips the guards of the route chain. A browser holds at most six
HTTP/1.1 connections per origin, across all its tabs, and loopback is HTTP/1.1; every tab already keeps one monitor stream open. And the monitor stream (`/api/v3/stream`) is a change
feed over the database with a sequence number and a replay, which terminal membership (process memory that dies with the instance) is not.

## Decision
1. **The socket is a normal route and the upgrade runs through the Express app.** `GET /api/v3/terminal/sessions/:name/socket` (`terminalSocket`, access `session`) is in the
   route registry. `terminal/upgrade.ts` gives Node's `upgrade` event a `ServerResponse` on the socket (`shouldKeepAlive = false`) and runs the app on it, after storing the `head`
   bytes and declaring the request body empty. Host, Origin (present and exact), fetch metadata, the URL limit and the access guard therefore run on the handshake exactly as on
   any `GET`, and every refusal is the JSON envelope on that connection, which then closes (`destroySoon` once the answer is flushed). The handler asks for the `head`: a request
   without one, or without `Upgrade: websocket` (exactly that value, in any case, as `ws` reads it) and a `Connection: Upgrade` token, is `426 upgrade_required` (a plain `GET`, `Upgrade: h2c`, an `Upgrade` list). On success it detaches the socket from
   the response object and hands it to the gateway; the response object is abandoned. Risk R1 of the design (a `ServerResponse` on an upgraded socket) was proved first, on
   Node 24.14.1 on Windows, by `terminal-upgrade.int.test.ts`: refusals are the envelope and the server ends the connection, the success path hands the socket over, and an
   upgraded socket survives a `requestTimeoutMs` of 200 ms and a keep-alive timeout of 100 ms while a request stalled inside its body is cut by the same timeouts (the control that
   shows they were armed). The raw-socket fallback of the design was not needed.
2. **Order of the handler's own refusals**: not an upgrade request (426); no usable terminal host (`503 terminal_unavailable`); a handshake the protocol cannot use, namely a key
   that is not 16 bytes in base64, a version other than 13, a `Sec-WebSocket-Protocol` list that `ws` could not parse (an empty element, a duplicate, a character that is not a token
   character) or a list that does not offer `caw.terminal.v1` exactly as written (`400 validation_failed`, `details` naming the header and never its value). The route judges the
   subprotocol list by the grammar `ws` parses it with and compares the names case-sensitively, as the gateway selects them: anything the route lets through is parsed and selected
   by `ws` as the route judged it, and `ws` never answers a raw `text/html` 400 of its own; an unknown
   name (`404 terminal_not_found`); the caps (`503 stream_limit`, 32 sockets on the instance and 8 on one session, a backstop above the engine's own count); `503 shutting_down`
   once the gateway is closing. The route writes no log line and never a session name.
3. **Gateway** (`terminal/gateway.ts`, the one importer of `ws`): `ws` in `noServer` mode, `maxPayload` equal to the shared `TERMINAL_INPUT_MAX_BYTES` (262144, one limit for the
   whole path), `perMessageDeflate` off (CPU for nothing on a terminal stream, and a decompression-bomb surface), `clientTracking` off, the subprotocol `caw.terminal.v1` required.
4. **Protocol v1.** The server sends the text frame `ready` (`v`, `cols`, `rows`, `replayBytes`, `viewers`) before any byte, then the replay snapshot as binary chunks of at most 64 KiB,
   then `live`, then live output as binary frames of at most 64 KiB. `session.attach(viewer)` returns the snapshot and registers the viewer in one synchronous call and all of this is
   written in the same turn, so no byte is lost or sent twice between the replay and the live output; output that reaches the viewer afterwards waits for the next tick. The client
   sends binary frames (raw input, written to the session unchanged, never echoed) and one text frame, `{"type":"resize","cols","rows"}` of at most 256 bytes, strict and clamped to
   20 to 500 by 5 to 200. A size change reaches every viewer as a `size` frame, after the output that was written for the old size (the last resize wins). At the end of a process
   the pending output is flushed, then comes `exit` (`code`, `signal`, both `null` when they are not a plain integer or token), then the close 4000 (`exited`) or 4001 (`killed`,
   when the kill route ended it). Text frames of the server are never terminal output (MTOP wrote them into the terminal; this is a deliberate difference): a client routes text to
   its protocol handler and only binary to the terminal.
5. **Close codes**, told apart by number: 1000 the client leaves, 1001 `shutting_down`, 1002 protocol error (an unmasked frame or a reserved bit, closed by `ws`), 1007 text that is not
   UTF-8 (`ws`), 1008 `bad_message` (not JSON, a wrong shape, an unknown `type`, an extra key, a float or a size outside 1 to 1000, which includes `__proto__`), 1009 `too_big` (a
   binary message over the limit, a text frame over 256 bytes), 1011 `internal_error` (the session threw on attach, write or resize), 1013 `slow_consumer`, 4000 `exited`, 4001
   `killed`, 4003 `signed_out`. The reason is a fixed token, never request data. Client policy (web area): 4000 and 4001 do not reconnect, 4003 shows the locked state, 1001, 1006
   and 1013 reconnect with back-off and reset the terminal on the next `ready`, because the replay re-synchronises the screen.
6. **Backpressure: the process is never slowed down for a viewer.** Each viewer has an output batcher (`terminal/output-batcher.ts`, pure): pushes before a tick coalesce, a large push
   becomes frames of at most 64 KiB sent one per `setImmediate` tick, so a process that prints a lot cannot hold the event loop and the other viewers and routes get their turn
   between two frames. Before every frame the gateway asks whether the socket holds more than 4 MiB (`ws.bufferedAmount`, beyond the replay that was just written in one go, bounded by
   `terminal.replayBytes`), and the batcher refuses to hold more than 4 MiB of pending output; either is a slow consumer: the viewer is detached and closed with 1013 and may reconnect
   for the replay. The other viewers and the child are untouched. The replay buffer stays in memory (0083); nothing of it is written to disk or to the database.
7. **Liveness and revocation.** One interval (30 s, `unref`) exists while at least one socket is open: it pings every socket, terminates one that did not pong since the previous tick
   (browsers pong by themselves; there is no idle limit otherwise, a terminal may sit idle for days) and calls `access.verify(undefined)`, which judges nobody and makes the access
   service sweep expired credentials. The gateway listens to `access.onRevoked` (only while a socket is open): a logout, a credential dropped at the cap or an expired one closes the
   sockets of that credential with 4003 `signed_out`.
8. **Shutdown.** `closeAll(1001, 'shutting_down')` closes every socket, terminates any that has not completed the close handshake after `closeGraceMs` (1 s), and resolves when none is
   left; afterwards `admit` answers `shutting_down`. The boot code (a later package) runs it first in the HTTP close, because `http.closeAllConnections()` does not know an upgraded
   socket.
9. **Logging is counts and numeric codes only**: `terminal_socket_open` and `terminal_socket_close` with the count and the close code, `terminal_socket_dead_peer`,
   `terminal_socket_slow_consumer`, `terminal_socket_revoked`, `terminal_socket_error` with the `ws` error code. Never a session name, a folder, a byte of input or output, a cookie
   or a credential; the access log of the HTTP chain (route id, method, status) does not see a successful upgrade at all.
10. **The session list is a dedicated server-sent event channel**, `GET /api/v3/terminal/events` (`terminalEvents`, access `session`): `retry: 3000`, `hello`, then full-snapshot
    `sessions` frames (`version` and the whole list, at most 64 sessions) sent on connect and after every change, coalesced to one per 50 ms, and `heartbeat` every 15 s. The sender
    keeps one pending frame per client and writes it on `drain` (latest wins: no queue, no replay, no gap handling); a client undrained for 30 s is destroyed and reconnects. The feed
    subscribes to the session list and to revocations only while a client is connected. At most 8 streams; the ninth is `503 stream_limit` before any byte. `GET /api/v3/terminal/state`
    is the polling fallback.

## Why a dedicated channel, and why one stream per browser
- **Not the monitor stream.** Its frames come from the persisted change log (`ChangesRepo`: a database sequence and a replay after a reconnect). Terminal membership is process memory
  that dies with the instance, has no sequence, and persisting every start and exit only to replay it would be the wrong cost. The monitor hub is also capped at 16 streams; a separate
  cap of 8 keeps terminal tabs from starving it and the reverse.
- **Snapshots, not deltas.** The list is tiny, a lagging client needs only the newest, and a delta stream would need sequence numbers, a buffer and a resync path for nothing.
- **Not polling alone.** A process that exits must leave the list at once and a session started in another tab must appear; polling every few seconds shows both late and costs a request
  per tab per interval. Polling stays as the fallback while the stream is down.
- **The browser limit.** A browser holds at most six HTTP/1.1 connections per origin across all its tabs, and loopback is HTTP/1.1. Every tab already holds one connection for the monitor
  stream. If every tab also held its own events stream, three tabs would use all six connections and every ordinary request of every tab (create, kill, state, a page load) would wait
  behind them. With one events stream per browser, n tabs use n + 1 connections. The web client therefore opens ONE events stream for all the tabs of a browser (a Web Lock; the other
  tabs poll `terminalState`) and closes it 15 s after the tab is hidden (design 04, amendment A2). The server's cap of 8 is a backstop, not the plan. These are counts of connections
  of a browser; how a browser counts a WebSocket against its own pools is a measurement of the web area (ADR 0098), and the server counts sockets separately (32, 8 per session).

## Consequences
- A change to the handshake is a change to one route and one registry; the guards cannot be skipped by the upgrade path, and a test per refusal (Host, Origin, no Origin, cross-site, no
  cookie, an unknown name, a bad handshake, a stopping server) proves the envelope and the close.
- One viewer that stops reading is dropped after at most 4 MiB, costs the server at most that much memory, and may come back for the replay; a viewer that is merely busy is not
  dropped while its socket drains.
- The terminal limit of input is one number everywhere (262144 bytes per message); a larger paste is sent by the client in chunks.
- `ws` appears in `packages/server/src/terminal` only; no `ws` type leaves the gateway, and the tests use the raw client of the testkit, an oracle that shares no code with `ws`.
- The session must not change a chunk after reporting it to a viewer (a frame is a view of the chunks that make it up): the engine hands out its own buffers.
- Replacing the event channel by something else later is a change to one module (`terminal/events.ts`) and one route.

## Alternatives rejected
- **Handling `upgrade` in a bare listener with the guards copied in:** two code paths for the same checks, and the first regression would skip a guard silently (design 08 lists it as a
  risk). Running the app on a response object keeps one path; the raw-socket responder stays the documented fallback.
- **Pausing the process when a viewer lags:** one stuck tab would freeze the child and every other tab. The replay buffer makes a reconnect cheap, so the lagging viewer is the one that
  leaves.
- **Compression (`permessage-deflate`):** CPU on every output frame of a stream that is mostly small, and a decompression-bomb surface on input.
- **Text frames for output, as MTOP did:** the client could not tell a protocol message from terminal output; binary and text are separate on purpose.
- **Reusing the monitor stream for the session list:** see above (no sequence, a persistence cost for no benefit, a shared cap).
- **One events stream per tab:** see the browser limit above.

## Evidence
- `output-batcher.test.ts` (19 cases): coalescing, frames of at most 64 KiB one per tick, exact bytes and order, a split chunk, 50000 one-byte chunks, both high-water signals, the flush before
  an exit frame, close, and the real `setImmediate` scheduler.
- `upgrade.test.ts` (10 cases): the head once, an empty head, the response on the upgrade socket with `Connection: close` and the end of the connection, the 426 headers, an empty body for
  a write that says `Upgrade`, the hand-over after `detachSocket`, a reset of the socket, a throwing app, a connection that is not a `net.Socket`.
- `gateway.test.ts` (61 cases): ready, replay and live in order, chunks of at most 64 KiB, 20 viewers attaching during a numbered stream with no gap and no duplicate, input fidelity (0x00,
  0xFF, 0x03, fragments, an empty frame, never echoed), every close code (1001, 1002, 1007, 1008, 1009, 1011, 1013, 4000, 4001, 4003), 14 malformed text frames, the limits at and one
  over, resize clamped and broadcast with the old-size output first, the last output before the exit frame, the slow consumer and the large replay that is not one, the dead peer and the
  answering peer, revocation and the listeners that exist only while a socket is open, the caps, `closeAll` with and without an unresponsive peer, and a log with no name, folder, byte or
  credential.
- `terminal-upgrade.int.test.ts` (23 cases, risk R1 first) and `terminal-socket.int.test.ts` (21 cases) run the whole chain on a real loopback server with the real access service and
  cookie: refusals as the envelope with the connection ended by the server, the plain `GET` as 426, the success path, an upgraded socket outliving a shortened `requestTimeoutMs`, replay
  without loss or duplication, several viewers, exit and kill, the slow consumer and the reconnect, oversize, an unmasked frame and a lying length field, the caps, ping, logout and expiry
  with 4003, shutdown with 1001, and a log file with no secret.
- Design 08 ids covered here: TC-WS-01 to 09 and 11, TC-SEC-03, 11 to 13, 16, 19, 24 to 26 and 52.
