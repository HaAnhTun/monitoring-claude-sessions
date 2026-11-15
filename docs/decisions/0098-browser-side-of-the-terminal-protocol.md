# 0098 Browser side of the terminal protocol: one socket file, one events stream per browser, replay order, reconnect and the oracle

Status: Accepted (CAW, 2026-11-15). Owner: web transport (WEB-TRANSPORT), design 04 sections 3, 4.2, 4.3, 7.2, 7.4, 7.5, 7.6 and amendment A2. Related: 0087 (the
protocol and the event channel the browser speaks), 0085 (the cookie), 0086 (the CSP that allows the socket), 0097 (xterm.js and its loader), 0099 (the access flow and
the lock a 401 causes), 0096 (the Workspace page that hosts all of this), 0072 (the catalogue that carries the words of every state below).

## Context
ADR 0087 fixed what the server sends and accepts: protocol v1 on `caw.terminal.v1` (binary frames are raw bytes both ways, text frames are protocol messages, a replay between
`ready` and `live`), the close codes, and a dedicated session event channel. It left the browser open on purpose. The browser has problems the server cannot solve:

- It cannot see why a WebSocket handshake failed (a 401, a 404 and a server that is restarting all look like close 1006 before any open), and it cannot see why an
  `EventSource` failed at all.
- Several windows can watch one process, which has one size. The replay is a 1 MiB tail of bytes that the process produced at its own geometry.
- A browser holds six HTTP/1.1 connections per origin across all its tabs, loopback is HTTP/1.1, and every tab already keeps one for the monitor stream.
- The page must never write protocol text into the terminal, never lose or duplicate a replayed line, never trap the keyboard, and never log what a person types.

## Decision
1. **Frames.** A binary frame is terminal bytes, in both directions, and is the only thing written to the terminal. A text frame of the server is a protocol message and goes to
   the protocol handler only (MTOP wrote text into the terminal; this is a deliberate difference, matching 0087). `parseServerFrame` reads it through the shared
   `TerminalServerMessageSchema`; a frame that is not JSON, has another shape, an extra key or more than 1024 characters is counted (`invalidFrames`) and ignored, never
   repeated in an error and never written anywhere. The socket client delivers binary and text frames to its owner synchronously and in the order they arrived: it keeps no queue.
2. **Input.** Typed or pasted text is encoded as UTF-8 and cut into binary frames of at most 16 KiB that end at a code point boundary (`encodeInput`): each frame is valid UTF-8 on
   its own, a surrogate pair is never split, and a large paste cannot hold the socket for long (the server accepts 256 KiB per message). Raw bytes from xterm (mouse reports) are
   cut at the same size anywhere (`sendBinary`). Nothing is sent, and `false` is returned, unless the socket is open for both the client and the browser (`readyState`); keystrokes
   are never queued and replayed after a reconnect, because they would run in a screen the person has not seen. The view says once per outage that typing is paused.
3. **Replay order.** The server sends `ready` (with the size of the process), the replay as binary frames, then `live`. The view resets its terminal and adopts the size of the
   process on `ready` so the replay is read at the geometry that produced it, does not fit while the replay arrives, and on `live` fits to its window and sends its own size when
   it differs. A reconnect repeats the same sequence, and the reset on `ready` is what prevents duplicated lines.
4. **Resize and size ownership.** `encodeResize` clamps to the limits of the terminal (20 to 500 columns, 5 to 200 rows) and writes the one text frame the server accepts, well
   under its 256-byte cap. The view sends a size only when it changed, only from a visible tab, and always after `live`; it mirrors a `size` frame of another viewer and shows
   "Size set by another window" with a button, and typing in this window takes the size back. The server's rule (the last resize wins) is the only arbiter.
5. **Close codes** (`closePolicy`). 4000 `exited`, 4001 `killed` and 1000 end the view. 4003 `signed_out` shows the locked state. 1001, 1006, 1011, 1013 and every code the table
   does not know reconnect: the replay rebuilds the screen and the session list says whether the session still exists. 1002, 1007, 1008 and 1009 are a bug of ours (a frame the
   server cannot read or a size it refuses), so the view ends as "failed" with a Retry button instead of repeating it. 1007 is not in the design table (1002, 1008, 1009): a text
   frame that is not UTF-8 cannot come from this client, so a reconnect would only repeat it. After an `exit` frame any other close ends the view: the process is gone.
6. **Reconnect.** The delays are 0, 1, 2, 4, 8 and then 15 s (`RECONNECT_CAP_MS`) for as long as connections fail. The count of failed attempts restarts only when a connection
   stayed open for 2 s, not at the browser's `open` event: a server that accepts and drops at once (a slow consumer, 1013) must not turn the first delay of 0 into a loop. A
   tab that becomes visible and the `online` event end a wait at once; `retryNow` does too and is also the Retry button of a failed ending; `stop` is idempotent and `start`
   after it opens a new connection (StrictMode runs start, stop, start).
7. **The oracle.** A refused handshake is invisible, so the client does not guess: it counts closes that came before any open (`refusals`) and records the last close code and time.
   The terminal view decides with the lists it can read: an `exit` frame is authoritative; after two refusals, or any reconnect close, it refreshes the terminal state; when that
   state is newer than the close and lacks the session, the view ends; when the session route says the browser has no cookie, the page is locked; otherwise it keeps backing off
   (the server may be restarting, and 15 s bounds the noise). A restart of the server ends every session (spec Q11), so the list is empty within one poll.
8. **Keyboard, copy, paste and links** (built by the xterm and view packages against this decision). The terminal owns the keyboard while it has focus: the shortcut registry
   ignores every event inside `[data-terminal-region]`, Tab and Shift+Tab belong to the program, and the way out is `Ctrl+Shift+Space` (`RELEASE_CHORD`, WCAG 2.1.2), shown
   next to the pane and in the shortcuts dialog. `Ctrl+C` with a selection copies and clears the selection, without one it interrupts; `Ctrl+Shift+C` copies or does nothing; paste
   goes through xterm's own path so bracketed paste works. `Ctrl+W`, `Ctrl+T` and `Ctrl+N` belong to the browser and cannot be taken; the user documentation says so. A link in the
   output opens only if it is `http:` or `https:`, with `window.open(href, '_blank', 'noopener,noreferrer')`, on a person's click: it is not a rendered link, so the lint rule
   against `target="_blank"` in JSX does not apply.
9. **One file per transport.** `src/terminal/ws-client.ts` is the only file that opens a `WebSocket` and `src/terminal/events-client.ts` is the second and last that opens an
   `EventSource` (after `stream/stream-client.ts`); both are enforced by `no-restricted-globals` and probed in `tests/tooling/lint-rules.test.ts`. Both clients are pure of React,
   take their `WebSocket`/`EventSource` factory, timers, clock, visibility and network target by injection, and expose `snapshot()` and `subscribe()` for a store.
10. **The events stream** (the session list of ADR 0087 decision 10). Every `sessions` frame is the whole list with a `version`: the newest version wins within one epoch, an older or
    equal one is dropped and counted, and a hello with a new epoch (the server restarted, its versions start over) resets the versions and tells the owner. A heartbeat watchdog of
    2.5 intervals closes a silent stream; the client owns its reconnect (2, 4, 8, 15 s, like the monitor stream) instead of the browser's native one, which resends the same URL and
    gives up after a non-200 answer. The browser cannot say why a stream failed, so after each failure the client asks an injected access check; a negative answer stops it with the
    status `revoked`, once. `useTerminalEvents` patches only the `sessions` of a terminal state that was already loaded (it never invents capabilities), refreshes the terminal
    state and the folders 800 ms after the last change of the set of names (a trailing debounce: marks and membership of the folders follow), refreshes everything of the instance on
    a new epoch, and calls `markLocked` on revoke. A hello of another instance stops the stream.
11. **Connection arithmetic: one events stream per browser.** Only the tab that holds the Web Lock `caw-terminal-events` opens the `EventSource`; the other visible tabs wait
    (status `waiting`) and poll the terminal state every 5 s meanwhile, and the browser hands the lock on when the holder closes. A tab hidden for 15 s closes its stream, releases the
    lock and aborts a pending request (status `paused`) and reopens on visible, so a background tab neither holds a stream nor a place in the queue. The lock manager is a seam:
    without one (no Web Locks, the tests) a client opens directly, and a lock manager that fails opens directly too. With six connections per origin: n tabs keep n monitor streams,
    plus ONE events stream, so n + 1 connections are held (per-tab streams would hold 2n: three tabs would take all six, and every create, kill and page load would wait behind them).
    The socket of a session is a further connection per tab that shows a terminal. How a browser counts an upgraded connection against its HTTP pool is **not measured** in this
    package: the design assumes it leaves the pool after the handshake, which gives n + 1; if a browser counted it, n tabs with an open terminal would hold 2n + 1 (five for two
    tabs). The browser tests of the Workspace count the `EventSource` requests of two pages and are where this is measured; this paragraph is amended if the assumption is wrong. The
    server's cap of 8 streams (0087) stays a backstop.

## Consequences
- The terminal can never show protocol text or a half-read frame, a paste can never cut a character in two, and a dropped network shows a reconnecting state that rebuilds the screen
  from the replay with no duplicated line.
- A person who types during an outage loses those keystrokes (they are not sent late); the status line says so.
- A tab opened beside another one polls the terminal state every 5 s until it holds the lock; the sidebar is at most 5 s behind there. The holder follows the stream.
- A page that loses its credential locks without a request that fails visibly: the stream ends, the access check says no, `markLocked` shows the same state as a first visit.
- A server that accepts and drops at once is retried at 0, 1, 2, 4, 8 and 15 s instead of in a tight loop, at the price that a drop within 2 s of an open is treated like a refusal.
- Two files own the two transports, so a change of the wire is a change to one file each, and the lint rule makes a third opener a build failure.

## Alternatives rejected
- **Writing the text frames of the server into the terminal, as MTOP did:** the page could not tell a protocol message from output, and an invalid frame would corrupt the screen.
- **Queueing keystrokes while the socket is down:** a delayed command runs in a context the person no longer sees. The status line is the honest answer.
- **Resetting the attempt counter at `open`:** correct for a refused handshake, wrong for a server that accepts and drops.
- **Deciding "the session is gone" from the close code:** a refused handshake has none, and 1006 is also what a restarting server gives. The session list and the session route decide.
- **One events stream per tab:** 2n connections against a budget of six.
- **A shared worker that owns the stream:** not available in every browser, and a second runtime to test; a Web Lock does the same job in a few lines.
- **A single socket carrying every session:** a change of the server protocol for a saving of connections that the one events stream already gives.
- **Reusing the monitor stream for the list:** see 0087 (no sequence, a persistence cost, a shared cap).

## Evidence
- `terminal/protocol.test.ts` (86 cases): the URL for http, https and an IPv6 host, no query or credential, invalid names and pages refused without echoing the name; `encodeInput` for no
  text, exactly 16 KiB, 16 KiB plus one, a 1 MiB paste, one to four byte characters at every offset around the limit decoded with `fatal`, a surrogate pair and a lone surrogate;
  `encodeResize` clamped and accepted by the shared schema; `parseServerFrame` for the four frames and 19 invalid inputs and the size cap; `closePolicy` for every code of
  `TERMINAL_CLOSE_CODES`, the codes of this decision and unknown codes.
- `terminal/ws-client.test.ts` (60 cases, fake timers): subprotocol and `arraybuffer`, frames in arrival order, invalid text counted and ignored, every close code, the delays 0, 1, 2, 4, 8,
  15, 15, 15, a drop after a long connection and after a short one, refusal counting, `retryNow`, visibility and `online`, an idempotent `stop`, StrictMode, input gating and chunking at
  code point boundaries, resize clamping, a throwing constructor, and no console output while input and output pass through.
- `terminal/events-client.test.ts` (56 cases, fake timers, a fake `EventSource` and a fake lock manager): the three events, latest wins by version, a new epoch, a foreign instance, invalid
  frames, the watchdog, the connect timeout, client-owned backoff, `retryNow` and `online`, one source for two and for three tabs, hand-over when the holder stops or stays hidden 15 s, an
  aborted pending request, a tab that starts hidden, no lock manager, a failing lock manager, a late grant given back, and the revoke path (answers that are negative, positive, failing, late).
- `terminal/useTerminalEvents.test.tsx` (20 cases): one stream while enabled, the status, StrictMode, an injected lock manager, the cache patch, latest wins, no invented state, the 800 ms
  trailing debounce when the set of names changes and not when only details do, a new epoch, another instance, and the lock on a revoked credential.
- `test/fake-websocket.test.ts` (9 cases): the scripted socket the tests above use behaves like the browser's (send while connecting throws, while closing or closed it drops the frame silently, `Blob` unless `arraybuffer`, nothing after close).
- Not evidenced here: decisions 3, 4, 7 and 8 name behaviour of the terminal view, the key decisions and the loader (the xterm and view packages); each carries its own tests against this ADR.
