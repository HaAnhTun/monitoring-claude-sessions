# 0084 Terminal write surface: route access field, guard order, csrf by default

Status: Accepted (CAW, 2026-11-15). Owner: server area (srv), design 02 (sections 3, 4.1 to 4.3 and 12, amendments A1 to A3). Amends 0026 (every route is a read-only
`GET` apart from the nudge), 0031 (read-only UI and server state) and 0045 (`csrf_rejected` reserved, the 64 KiB JSON body, the plain `Origin` rule) for the write surface
only. Related: 0079 (the stance), 0085 (access ticket and session cookie), 0087 (socket protocol).

## Context
0079 says the terminal part is active and that every route that starts, writes to or kills a terminal needs the access code. 0045 built the request checks (`Host`, `Origin`,
fetch metadata, JSON plus `X-MCS-Request`) but kept the last guard unused: v3 had no mutating UI route, so `csrf_rejected` was reserved and `csrfGuard` was mounted nowhere.
The route adapter (`registerRoute`) knew `GET` and `POST`, parsed only the parameters and the query, and gave the handler no body. A write surface needs three things that
cannot be left to each route author: who may call a route, the order of the checks, and one strict way to read a body.

Two further facts shape the decision. The user instance serves the transcripts of every project (spec Q9), so the content routes cannot stay open to any local client, yet
the CLI, the skill and the MCP server read a running instance over HTTP and have no cookie. And the control channel (0005) already carries the lifecycle, with its own token
file as the root of trust.

## Decision
1. **A route says who may call it.** `RouteDefinition.access` is one of `open` (the default: every route that existed), `reader`, `session` and `ticket`
   (`packages/shared/src/api/routes.ts`; the field and its invariants landed with the route metadata package). A write route other than the hook nudge is never `open`;
   a `ticket` route has a body; `routeErrors` adds `access_required`, `csrf_rejected`, `payload_too_large` and `body_invalid_json` where the metadata implies them.
2. **The adapter builds the guard chain from the definition**, in this order, and a route module cannot change it:
   1. the route id marker (the access log needs it for a refused request too);
   2. `csrfGuard` on **every POST**: `Content-Type: application/json` and `X-MCS-Request: 1`, else `403 csrf_rejected`. The one exception is a route that registers with
      `csrf: false`; only the hook nudge does, because the hook handler is not a browser and its own guard is stricter (no `Origin` at all, 256 bytes, the instance id);
   3. the access guard of `route.access`: `session` wants a live session cookie of this instance; `reader` wants the cookie or, on `GET` and `HEAD` only, the control token as
      `Authorization: Bearer`; `ticket` wants no credential (its handler redeems the access code). For every write and for the socket route the `Origin` header must also be
      present and exactly one of the two allowed origins (`403 origin_not_allowed`), and that check runs first;
   4. the guards of the route's `before` option (the nudge guard);
   5. the parameters and the query, then the body (decision 4);
   6. the handler.
   `Host`, `Origin` when present, fetch metadata and the URL limit stay global, ahead of all of this (0045). The effective order for a write is therefore Host, Origin, JSON
   plus `X-MCS-Request`, the exact Origin, the credential, a body of at most 4 KiB read strictly, the handler.
3. **A refused write is never read.** Every refusal of a write (csrf, Origin, credential, payload size) is sent with `Connection: close`: the body of an unauthenticated
   request is not read, parsed or buffered, so it costs the server nothing. A refusal repeats nothing the client sent: not a cookie, a header, a body or a name.
4. **One strict body reader.** A POST route with a body schema is read with `readCapped` (the declared `Content-Length` first, then the streamed byte count; at most
   `route.maxBodyBytes`, 4096 by default and 256 for the nudge) and answers `413 payload_too_large`; the bytes are strict UTF-8 JSON (no byte order mark, no trailing text) or
   `400 body_invalid_json`; the value is checked with the strict schema of the route (`z.strictObject`: an unknown key, `__proto__` included, is refused) or
   `400 validation_failed` whose details are paths and Zod issue codes only. The handler receives the result as `RouteInput.body`. No form, urlencoded or multipart parser
   exists, so anything that is not JSON dies at step 2. A route whose guard already read the body (the nudge) says `bodyConsumed` and takes the validated value from
   `res.locals.body`; the adapter never reads a request twice.
5. **Reader access (amendment A1).** On the user instance the nine routes that return transcript content (`transcriptWindow`, `transcriptLocate`, `searchTranscript`,
   `searchTranscripts`, `export`, `getEvent`, `listToolCalls`, `sessionToolCalls`, `sessionTimeline`) are `reader`. A valid session cookie opens them; so does the control
   token of `run/control.token`, as `Authorization: Bearer <token>`, on `GET` and `HEAD`. The header is **never** accepted on a write, whatever its value: a leaked token
   must not be able to start, write to or kill anything through the API. The access service compares SHA-256 hashes with `timingSafeEqual` and keeps no token. Lists, counts,
   labels and the working folders of all projects stay open to local clients; `docs/security.md` and the README say so. With no access service wired (a task instance) a
   `reader` route is served open, exactly as before.
6. **The readers keep working.** `ApiReader` (the CLI, the skill and the MCP server) reads `run/control.token`, re-reading it only when the file's size, times or file id
   change, and sends it to the routes whose access is `reader` and to **no other route**, so what an open route answers with never had the token. The probe client takes the
   same optional `bearer` value, which must be 64 lower-case hex digits and goes only to `127.0.0.1:<port>`. A reader without a token still sends its request and the server
   decides.
7. **Fail closed.** `registerRoute` throws at mount time when a `session` or `ticket` route has no access service to answer to (the message names the route id). The same
   routes refuse every request with `401 access_required` if the access service is taken away after the mount. A task instance therefore cannot expose a write route by a
   forgotten wiring.
8. **No lifecycle over HTTP.** Start, stop, restart, shutdown and the minting of an access code stay on the control channel (0005). No HTTP route stops the server or mints a
   code; the HTTP API gains the terminal and auth routes only.
9. **No new configuration key and no new environment variable.** The limits are constants, shortened by tests through option objects (0045 refuses an `Origin` list key for
   the same reason).

## Consequences
- Every later write route is one `defineRoute` with an `access` and a body schema plus one `registerRoute` call; it inherits csrf, the credential check and the body limits and
  cannot opt out of them except by naming `csrf: false`, which a reviewer can grep.
- The tests that said "every route is a GET except the nudge" are narrowed by the packages that add the write routes (`ACCESS_POLICY`), never loosened further.
- The web client treats `401 access_required` on a reader `GET` as the locked state; a CLI that is refused its token reports `API_ERROR` with the reason `access_required`.
- The control token becomes a second credential for reads. It was already the root of trust of the control channel: whoever can read `run/control.token` is the same user and
  could already run `claude`. The user-instance workspace must be a private per-user folder (lifecycle area), and `doctor` warns when it is not.
- A cookie is scoped by host, not by port, and the browser sends it to every server on `127.0.0.1`; that residual exposure and the cookie's name and lifetime belong to 0085.

## Alternatives rejected
- **Each route checks the cookie itself:** a route that forgets is silently open, and nothing can audit it. A declared field plus a throw at mount time can be tested for every
  route of the registry.
- **A global authentication middleware with an allow list:** every new route would be protected by default, but the three exceptions (`reader`, `ticket`, the nudge) would be paths
  in a list far from their definitions, and a task instance would need a second, different list.
- **Protecting every monitor read with the cookie:** it breaks `ApiReader`, the skill and the MCP server, which send no cookie. The middle path of decision 5 keeps them working
  and closes the content routes.
- **Accepting the control token on writes too:** it would let a process that can read one file drive terminals through HTTP. The control channel is the place for a caller with the
  token, and it has no terminal operation.
- **Sending the token with every request of the readers:** an open route would then receive a credential it does not need, and a process that took over the port would see it on the
  first request. Sending it to `reader` routes only keeps it to the requests that need it.

## Evidence
- `access-service.test.ts` (42 cases): expiry at exactly 120 s, single use, the cap of four tickets, the limiter (eight wrong codes in 60 s, then `rate_limited` with the wait,
  recovery when the oldest failure leaves the window, and a valid code redeemed while limited), idle expiry at 12 h and absolute expiry at 24 h to the millisecond, the cap of 16
  credentials, revocation with listeners, `verifyBearer`, a counted `timingSafeEqual` over every outstanding ticket, and no secret in a dump of the service.
- `cookie.test.ts`, `access-guard.test.ts` and `route-adapter.test.ts`: the cookie bytes, the matrix of cookie, `Origin` and `Authorization` cases for the three kinds of route, the
  refusal of the Bearer header on every write method, csrf before the cookie and the cookie before the body, 413 for a declared length, a streamed body and 4097 bytes, strict JSON
  cases, a client that goes away mid-body, `bodyConsumed`, the `handled` flag, and the throw of a `session` route without an access service.
- `api-reader.test.ts`, `probe.test.ts` and `open.test.ts`: the token reaches the wire as `Authorization: Bearer` on the four reader routes the `ApiReader` asks and on none of
  the open ones, a token source that fails or has no token still lets the request go out, and the probe client refuses a value that is not a control token before it connects.
- `errors-envelope.int.test.ts` and `ingest.int.test.ts` pass unchanged (25 tests): a task instance serves its reader routes open and the nudge still takes its own guard.
