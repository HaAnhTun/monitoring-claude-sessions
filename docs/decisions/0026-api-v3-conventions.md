# 0026 API v3 conventions: read-only HTTP plus the hook nudge, error envelope and codes, keyset cursors, comma lists, instance stamping, legacy `/api/health`

Status: Proposed (Phase 1, 2026-10-11). Owner: data/API design (`docs/design/03-data-api-realtime.md` sections 5, 6, 13).

## Context
Brief 11 asks for a small, consistent API with request/response schemas, one error structure, pagination, filter and sort semantics, id
and time formats, and generated docs. CCAM documents no single convention (`docs/research/ccam-docs-analysis.md` C17). The UI is
read-only (04-ui ADR 0031); design 01 keeps HTTP read-only and sends backups through a local control channel; design 02 needs one POST
that only says "drain your spool now".

## Decision
- Prefix `/api/v3`; additive changes only within v3; strict Zod schemas per route in one registry in `@mcs/shared`; JSON Schema and a
  reference page generated from it, with a CI drift check.
- Read-only: every route is `GET` except `POST /api/v3/ingest/nudge` (`{instanceId}`, <= 256 bytes, no `Origin`, `204`).
- Errors: `{ error: { code, message, requestId, details?: [{ path, issue }] } }`, lowercase snake_case codes with fixed HTTP statuses;
  messages never echo input.
- Lists: keyset cursors (base64url JSON with route, sort, last key, last id, frozen window, filter hash), `Page<T> = { items,
  nextCursor, asOfSeq, total, totalIsLowerBound, limit }`; `limit` max 200; total order = sort key then id in the same direction.
- Filters: one typed model shared with the UI's URL parameters; list values comma-separated; a repeated key is `400 param_repeated`.
- Guards and limits follow ADR 0045 (design 05): exact Host `127.0.0.1:<port>` / `localhost:<port>`, Origin allow-list, fetch-metadata
  checks, 8 KiB URLs, 128 connections, 16 streams; this ADR fixes the error-code names (`host_not_allowed`, `origin_not_allowed`,
  `cross_site_request`, reserved `csrf_rejected`).
- Every response: `X-MCS-Instance`, `X-MCS-Runtime`, `X-Request-Id`, `Cache-Control: no-store`, `nosniff`.
- One non-v3 route, `GET /api/health`, with exactly the 13 keys of design 01 C-4 (`ok, version, pid, started, uptime, now, code_stamp,
  engine: 'node', instanceId, task, config_source: 'task', errors: [], reader: {}`), so the legacy Python CLI recognizes a running Node
  instance and its `status`/`verify` readers find every key they read (D12; revision 2, critic issue I-30).
- The Origin allow-list is exactly `http://127.0.0.1:<port>` and `http://localhost:<port>`, with no configuration key: the Vite dev
  proxy rewrites `Origin`, so dev mode needs no exception (revision 2, I-31).
- Revision 2 adds two read-only routes: `GET /api/v3/ingest/probes/:probeSessionId` (`{receivedAt, committedAt}` or `404
  probe_not_found`; the id must carry the probe prefix `00000000-0000-4000-8000-`), used by `mcs hooks verify` (I-37), and
  `GET /api/v3/completion` (exactly one of `session`, `label` (1..200), `attemptPart` (0..512, empty allowed); design 02's
  `CompletionTargetError` maps to `400 validation_failed` (`target_invalid`) and `404 completion_target_not_found`
  (`target_not_found`); no `null` result), the HTTP side of `verify-completion` (I-08; revision 3, registry C16/C17).

## Consequences
- No CSRF surface beyond the nudge, whose only effect is a spool drain.
- The UI renames a few fields in its endpoint layer (design doc 15.1).
- Clients built by another runtime version can hit contract errors; `hello.codeStamp` lets the UI ask for a reload.

## Alternatives rejected
- Maintenance POST routes (backup, export job, cleanup) guarded by a custom header: duplicates the CLI and widens the attack surface of
  a loopback server.
- Offset pagination: unstable under inserts, slow on deep pages.
- Repeated query keys for lists: ambiguous with Express's parser and longer URLs.
- CORS headers for local tools: weakens the DNS-rebinding defence.
- A configurable `server.devOrigins` list: an extra writable trust root for no gain, since the dev proxy already rewrites `Origin`.
- Reproducing the legacy health body's `transcripts_dir` key or a populated `errors`/`reader`: no legacy reader needs them; v3 errors
  and ingestion state are served by `/api/v3/errors` and `/api/v3/health`.

## Evidence
- 2026-10-11, `misc-probes.mjs` (Express 5.3.0, Zod 4.6.5, port 18432, stopped): Express 5 `query parser` is `simple`; `a=1&a=2` gives
  an array; brackets are not parsed; `z.toJSONSchema` emits draft 2020-12 and supports `io: 'input'`; Zod issues expose path and code,
  not values; `z.uuid()` enforces RFC variant bits (so session ids use a plain lowercase pattern).
- Legacy health contract: `docs/research/current-state-backend.md` C.10 and F.5; readers re-checked 2026-10-11 in
  `src/backend/cli.py` (read-only): `instance_alive` lines 69-81 (`pid`), `cmd_status` lines 267-270 (`uptime`, `code_stamp`, `task`,
  `config_source`, `errors`, `reader`), `verify` line 372 (`errors`).
