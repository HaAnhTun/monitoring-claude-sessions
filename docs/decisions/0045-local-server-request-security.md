# 0045 Local server request security: loopback, exact Host/Origin, fetch metadata, CSRF header, data-free hook nudge

Status: Proposed (Phase 1, 2026-10-11). Owner: tooling/security design (05 section 5.3 S-NET, S-ING). Implemented in
`packages/server/src/http/guards.ts`.

## Context
The server is a loopback HTTP app holding transcripts. Threats: DNS rebinding, CSRF from any web page, cross-origin reads, forged hook
events, request floods. `EventSource` cannot send custom headers. CCAM's guard accepted an empty Host and `0.0.0.0` and exempted the hook
route from auth.

## Decision
- Bind `127.0.0.1` only; no non-loopback option in v3.
- Every request: `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>`; `Origin`, if present, must be `http://127.0.0.1:<port>`
  or `http://localhost:<port>`; `Sec-Fetch-Site: cross-site` rejected (and `same-site` for non-GET). Errors use design 03's envelope
  and catalogue (03 section 5.2, `ErrorCode` in `packages/shared/src/api/errors.ts`, authoritative): `host_not_allowed`,
  `origin_not_allowed`, `cross_site_request`, `csrf_rejected` (reserved: v3 has no mutating UI route), `payload_too_large`,
  `unsupported_media_type`, `validation_failed`, `instance_mismatch`, `uri_too_long`, `method_not_allowed`, `stream_limit`. The security
  suite imports `ErrorCode` instead of spelling codes (revision 2026-10-11, critic issue I-04).
- UI non-GET requests need `Content-Type: application/json` and `X-MCS-Request: 1`. The hook nudge (`POST /api/v3/ingest/nudge`, 02
  section 2.8) instead must be JSON, have no `Origin` header, a body of at most 256 bytes and the server's own `instanceId`; no CORS
  headers ever; `OPTIONS` -> 405 `method_not_allowed`.
- Limits: JSON body 64 KiB (nudge 256 bytes), URL 8 KiB, `headersTimeout` 10 s, `requestTimeout` 30 s (`server.requestTimeoutMs`), `keepAliveTimeout` 5 s, 128
  connections, 16 SSE streams; headers `nosniff`, `no-referrer`, COOP/CORP same-origin, `X-Frame-Options: DENY`, CSP of ADR 0039.
- Hook ingest: the spool file is the only event channel; the handler's POST is a data-free nudge (`{"instanceId"}` only; 02 ADR 0012).
  A data-carrying POST, if ever added, requires a timing-safe token from `<workspace>/data/ingest.token` that never appears in any output.

## Consequences
- The UI must send `X-MCS-Request: 1` on mutations (04's API client); dev mode relies on the Vite proxy Origin rewrite.
- Same-user local processes can still write the spool: accepted, they have the user's privileges anyway.

## Alternatives rejected
- Bearer token for the UI: `EventSource` cannot send it; query-string tokens leak into logs and history.
- CORS allow-list: weakens rebinding defence and adds a dependency (`cors`).
- Helmet: one dependency for a fixed header set we set directly.

## Evidence
- 2026-10-11: Express 5.3.0 guard returned 403 for `Host: evil.example` and 200 for `127.0.0.1:<port>` in the scaffold integration
  test and `scripts/smoke.mjs` (design 05 E5, E14); Vite proxy with Origin rewrite passed the guard (E16; 04 ADR 0039 E9).
- Node.js security best practices (nodejs.org, fetched 2026-10-11 per `stack-versions.md` section 7): HTTP timeouts, no
  `insecureHTTPParser`, `timingSafeEqual`. CCAM weaknesses: `ccam-source-analysis.md` section 11.
