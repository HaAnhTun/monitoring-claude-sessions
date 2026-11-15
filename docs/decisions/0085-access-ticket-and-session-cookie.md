# 0085 Access ticket and session cookie: a one-use code in the link, an HttpOnly cookie for the browser

Status: Accepted (CAW, 2026-11-15). Owner: server area (srv), design 02 (sections 4.1 to 4.6, amendments A2 and A3). Amends 0045 (the plain `Origin` rule: a write now also needs
a credential) for the write surface only. Related: 0079 (the stance), 0084 (route access field and guard order), 0094 (the control op that mints the code), 0086 (the page policy).

## Context
The terminal part of the app starts processes and writes to them, so every route that does so, and the socket, must know who is calling. The browser has nothing to prove who it
is: there is no account, only the person who ran `caw start` on this machine. The proof has to travel from that command to the browser once, without leaving a long-lived secret in a
place that survives (a shell history, a transcript of an agent that ran the command, a log, a file), and the browser must then keep a credential that a page script cannot read.

Two facts bound the design. The server listens on loopback only, and the browser sends a cookie to every port of the same host, so a cookie is not scoped to this server. And all
clients of a user instance are on one machine, so a limiter per address would mean nothing.

## Decision
1. **Two secrets, not one.** The link carries a **ticket** (the access code); the cookie carries a different **credential**. The printed code is useless once exchanged, and logout revokes
   the credential without needing the code. Both are 32 random bytes in base64url (43 characters, `ACCESS_CODE_RE` for the code).
2. **The link** is `http://127.0.0.1:<port>/#code=<code>` (`buildLoginUrl`, `parseLoginFragment` of `@mcs/shared`). The code is in the **fragment**: a browser never sends it in the request line, in
   a `Referer` header or to the server at all. The host is `127.0.0.1` and not `localhost`: nothing can pre-bind that address, while a squatter on `[::1]` could answer a `localhost` link.
   The page reads the fragment, exchanges it once and removes it from the address bar (`history.replaceState`).
3. **A ticket is single use and lives 120 seconds.** It is minted in memory by the access service (the control op `access` of 0094 calls `mint()`), at most four are outstanding (the oldest
   goes), and none is ever written to `state.json`, `run/control.token`, a log, the database or the environment. Tickets and credentials die with the process: a restart always needs a new link.
4. **The exchange** is `POST /api/v3/auth/exchange {code}`, a `ticket` route (0084): Host, Origin and the csrf header have passed and the body is a strict JSON object of at most 4 KiB before the
   code reaches the service. Success answers `200 {authenticated:true}` and `Set-Cookie`. A wrong, expired or reused code is `401 access_code_invalid` with no cookie. `GET /api/v3/auth/session`
   is open and answers `{authenticated}` only, so the page can ask before it exchanges. `POST /api/v3/auth/logout` is a `session` route: it revokes the credential, closes its sockets and
   streams through the revocation listeners of the service, and clears the cookie.
5. **The cookie** is named `caw_` plus the first eight hex characters of the instance id and is written by one function: `<name>=<credential>; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`.
   No `Domain` (host only), no `Expires`, and no `Secure`: plain-HTTP loopback cannot rely on it in every browser, and the `__Host-` prefix needs it. A test compares the bytes. Logout sends the same
   name with an empty value and `Max-Age=0`. The server reads only its own name, the first match, and only a value of exactly 43 base64url characters (a code does not pass for a credential);
   a `Cookie` header over 4 KiB is treated as absent.
6. **The credential lives 24 hours** from sign-in (the cookie `Max-Age`) and ends after 12 hours without use, whichever comes first; at most 16 are live (the oldest is revoked). The idle clock moves at most once
   a minute. The cookie lifetime was 7 days in the first draft (amendment A2): a day is as long as one working session needs, and a stolen cookie is useful for less time.
7. **The failure limiter** bounds noise and CPU, it must not lock the owner out (amendment A3). Wrong codes are counted in a sliding 60-second window; at eight, every **wrong** code is
   `429 access_rate_limited` with `Retry-After` (whole seconds, rounded up) until the oldest failure leaves the window. A **valid** code still redeems while the limiter is tripped. The constant-time
   comparison against every outstanding ticket always runs first, so the limiter reveals nothing a guess could use. The limit is global: all clients are loopback. A request that fails the Host,
   Origin or csrf check never reaches the service and is not counted.
8. **Redaction.** Never logged: a ticket, a credential, a `Cookie` or `Set-Cookie` value, a body, a wrong code. The exchange route logs two events, `ticket_exchanged` and `access_rate_limited`, each with
   a count and nothing else; the access log has the route id, the method, the status and the duration. The service keeps SHA-256 hashes only. Tests run a full flow against a real logger file and
   scan it for every secret of the flow.

## Residual exposure (recorded, accepted)
- **The cookie jar is shared by every port of `127.0.0.1`.** Cookies are scoped by host, not by port, so every other server the browser visits on `127.0.0.1` receives the HttpOnly cookie. The Origin and
  Host checks stop another web page in the browser (`SameSite=Strict` does not: a page on another port is the same site, so the exact `Origin` check is the defence there), but they do not stop a
  non-browser server that replays a cookie it was sent. The instance-id suffix keeps two instances of this product from overwriting each other, nothing more. The credential lasts at most 24 hours
  and is revoked by logout and by any restart.
- A process of the same user can read `run/control.token` and so could already drive the control channel or run `claude`: the control token is the root of trust (0084), not this cookie.
- An optional `caw.localhost` origin (a separate cookie jar, both loopback addresses bound) would close the first point. It needs a spike (Edge `--app`, `explorer.exe`, a secure context for the clipboard) and
  is not planned.

## Consequences
- The page treats `401 access_required` on any later call as the locked state ("Access link needed"); a failed exchange shows the same state, not the raw error.
- `caw start` and `caw open` print or open the login URL; a URL left in a scrollback is dead after use or after two minutes.
- Nothing in the HTTP API mints a code or starts or stops the server (0084 decision 8).

## Alternatives rejected
- **One long-lived token in the URL and as the cookie value:** a printed URL would stay valid, and every place that kept it (history, transcripts) would be a credential.
- **The code in the query string:** it reaches the request line, the access log of a proxy and the `Referer` of the next navigation.
- **`__Host-` cookie prefix:** it needs `Secure`, which loopback over plain HTTP cannot rely on everywhere.
- **A per-address limiter:** every client is `127.0.0.1`.
- **A hard lockout after eight failures:** a stray script could lock the owner out of their own app; the limiter only refuses wrong codes.

## Evidence
- `routes/auth.test.ts` (fake service): the three handlers, the cookie strings, `Retry-After` rounding, a valid code redeemed after a limited answer, nothing reaching the service from a refused
  request, counts-only log lines.
- `test/terminal/auth-access.int.test.ts` (real HTTP, real service, fake clock): TC-SEC-01 (43 characters, single use, expiry at 120 s), TC-SEC-02 (logout without a credential), TC-SEC-04 (wrong code,
  eight failures, 429, a valid code while limited, recovery), TC-SEC-05 (the cookie byte for byte), TC-SEC-06 (name by instance, two servers in one jar), TC-SEC-08 (the code in the query, a header or a cookie
  never authenticates), TC-SEC-11, 12 and 14 (Host, Origin, csrf before the service), TC-SEC-16 and 18 (no CORS header, no-store), TC-SEC-41 (no secret in the log file), 12 h idle and 24 h absolute expiry.
