# 0032 Realtime client: EventSource with client-owned reconnect, `since` parameter, named heartbeats

Status: Proposed (Phase 1, 2026-10-11). Owner: UI design (`docs/design/04-ui.md` section 5.6). Challenges part of D11 (see below).

## Context
D11 fixes SSE with `Last-Event-ID` = persisted change `seq`, heartbeat comments and a `reset` message for too-old cursors. The UI needs
a watchdog (detect half-open connections), bounded backoff, gap detection and a visible connection state. Browser behaviour had to be
measured, not assumed.

## Decision
- Use the browser `EventSource` behind an injectable factory. On any `error`, the client closes the source itself and reconnects with
  backoff `nextDelay(1000, attempt)` (2, 4, 8, 16, 30 s cap) to `/api/v3/stream?since=<lastSeq>&epoch=<epoch>` (protocol of design 03
  section 9.2, adopted 2026-10-11).
- Named events: `hello` (instance id, `epoch`, head seq, heartbeat interval, runtime version and code stamp), `change` (`id` = seq),
  `heartbeat` (no `id`, carries `headSeq` and `epoch`), `reset` (`id` = head seq; reasons `cursor_too_old`, `cursor_ahead`,
  `epoch_changed`, `cursor_invalid`). A new `epoch` (restarted server) triggers one full resync and a refetch of the instance info.
- Watchdog: no message or heartbeat for 2.5 x `heartbeatMs` -> reconnect. Duplicate seq ignored; a gap, an invalid message, a queue
  overflow (1000) or a head-ahead heartbeat twice -> resync (invalidate the instance's queries).
- Messages are validated with the shared stream schemas (`shared/src/api/stream.ts`) and applied in batches (animation frame or
  100 ms). Change kinds and `data: null` handling follow design 03 9.2; there is no `config` kind (configuration changes need a restart,
  visible as a new epoch).

## Consequences
- The server must: send a named `heartbeat` event (comments may also be sent), accept `since`, and give the `Last-Event-ID` header
  precedence when both are present; stream `change` ids must be contiguous per instance.
- One code path for reconnects, fully testable with a fake EventSource (happy-dom has none).

## Alternatives rejected
- Rely on native auto-reconnect: it resends the original URL (stale `since`) and stops for good after a non-200 response.
- Heartbeat as comments only (D11 as written): invisible to `EventSource` listeners, so no client watchdog is possible.
- fetch + ReadableStream SSE parser: sees comments, but re-implements browser behaviour and adds code.
- WebSocket: rejected by D11/stack-versions (one-way updates, Express middleware applies to SSE).

## Evidence
- Experiment 2026-10-11, Chrome 155 headless via Playwright 1.64 (`D:/mvp/private/scratch/mcs-v3/ui/sse/`): comment lines never reached
  listeners; named `heartbeat` events did; events without `id` kept the previous `lastEventId`; after the server ended the response the
  browser reconnected to `/stream?since=0` (stale) with header `Last-Event-ID: 12`; a `503` response left `readyState === 2` with no
  further attempts.
- happy-dom 20.14.6: `typeof window.EventSource === 'undefined'` (same scratch, `exports.mjs`).
- MDN Using server-sent events (cited in `docs/research/stack-versions.md` section 4): 6 connections per browser and domain on HTTP/1.1,
  so one stream per tab.
