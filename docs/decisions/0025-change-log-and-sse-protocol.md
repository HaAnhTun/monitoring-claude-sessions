# 0025 Change log with reserved contiguous seqs, persist-then-publish, hydrated SSE frames, pull-based fan-out, per-process epoch

Status: Proposed (Phase 1, 2026-10-11). Owner: data/API design (`docs/design/03-data-api-realtime.md` section 9). Refines D11 (CHALLENGE
C-2 there; consistent with the UI's ADR 0032 and with design 02's `ChangeSink`).

## Context
D11: SSE, `Last-Event-ID` = monotonically increasing seq of persisted changes, persist then publish, reset for too-old cursors,
heartbeats, bounded buffers. The UI patches caches from full entities and needs a per-entity `seq` (04-ui 5.5). Design 02's ingestion
writer calls a `ChangeSink` inside its transaction. CCAM broadcast inside open transactions without seq or replay
(`docs/research/ccam-source-analysis.md` section 8).

## Decision
- Table `changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, at, kind, op, session_uid, entity_id, payload)`; rows are references written in
  the same transaction as the data. A `ChangeRecorder` reserves at most one row per (kind, op, coalescing key) per transaction and
  returns its seq, which stamps `updated_seq`/`change_seq`. `createChangeSink` implements design 02's interface on top of it.
- Activity-only session and agent updates are announced at most once per second per entity; lifecycle view changes immediately.
- The stream reads only committed rows; frames are hydrated at send time from current state with the REST query functions; a deleted
  entity gives `data: null`, so seqs stay gap-free.
- SSE: `hello` (instance id, epoch, head seq, heartbeat interval, runtime version), `change` (`id: <seq>`), named `heartbeat` every 15 s
  (no comment lines), `reset` (`id: <head>`) for cursors too old, ahead, invalid or from another epoch; `Last-Event-ID` wins over
  `since`. The epoch is random per server process (a restored DB always means a new process).
- Fan-out is pull-based: per client `lastSent`; stop on `write() === false`, resume on `drain`; evict after 30 s undrained; at most 16
  streams; frames built once per seq (LRU 512).
- Change log retention: 24 h or 20,000 rows.
- Change kinds (revision 2): `session`, `agent`, `workflow`, `tool_call`, `event`, `transcript`, `work_item`, `usage`, `alert`, `health`
  and `attempt` (`attempt/upsert`, payload `{ids, truncated}`, frame data taken from the payload) for chain-log attempt rows (critic
  issue I-07). There is no `config` kind: configuration is read at start and a change needs a restart, visible through `hello`.

## Consequences
- No phantom events (a rolled-back transaction never publishes) and no per-client queues.
- After a server restart clients resynchronize (one refetch of their active queries).
- Clients must handle `data: null`, gaps (resync) and resets.

## Alternatives rejected
- Push with per-client queues: the prototype's push version evicted both a slow and a fast client during a synchronous burst.
- Heartbeat comments: invisible to `EventSource` scripts (04-ui E2).
- Full entity snapshots stored in `changes`: larger rows and stale copies; hydration gives current state.
- Epoch stored in the DB and kept across restarts: needs coordination with restore (design 01) for little gain.
- WebSocket: one-way updates only (D11).
- Attempts announced only through `session/upsert`: an unmatched attempt run has no session, so its change would be invisible and
  break "every observable change is in the log".

## Evidence
- 2026-10-11, Express 5.3.0, Node 24.14.1, `D:/mvp/private/scratch/mcs-v3/data-api/sse-proto.mjs` on 127.0.0.1:18431 (stopped): 13/13
  checks (hello first, live ids 1-3, named heartbeat, `Last-Event-ID: 1` replays 2 and 3, resets for foreign epoch, pruned, ahead and
  garbage cursors, `Host: evil.example` 403, six aborted clients removed, slow client evicted with 16,722 bytes buffered while a fast
  client received all 400 frames).
- `seq-flow.mjs`: reserved seqs 1 and 2 in one transaction; a rolled-back reservation left the head at 2; the next seq was 3; invalid
  kind/op pairs refused; hydration by rowid range 0.018 ms. The final schema keeps the same `changes` design with two more kinds
  (`ddl2-check.mjs`: invalid kind/op pair refused).
- 2026-10-11, revision 2, `D:/mvp/private/scratch/mcs-v3/data-api/rev2/ddl3-check.mjs` (better-sqlite3 13.0.3, SQLite 3.53.4):
  `attempt/upsert` accepted, `attempt/delete` refused by the kind/op CHECK.
