# 0099 Mutating requests from the UI and the access flow: `ApiClient.post`, no retries, the code never stored

Status: Accepted (CAW, 2026-11-15). Owner: web data layer (WEB-DATA), design 04 sections 4.1, 4.2, 4.4 and 4.5. Amends the consequences of ADR 0045 (the
UI "must send `X-MCS-Request: 1` on mutations": this is the one place that does) and the web side of ADR 0085 (the exchange of the access code and the
cookie). Related: 0084 (route access and the 4 KiB body limit), 0072 (the catalogue the failure texts come from), 0098 (the browser side of the terminal
protocol), 0096 (the Workspace page that shows the locked state).

## Context
Until now the web app only read: `ApiClient.get`, retried by TanStack Query, with failure texts from the catalogue. The terminal area writes: it
redeems an access code, starts, stops and resumes terminals, adds a folder, opens the folder dialog of the computer and ends the session. Every write
is a POST of the registry (`WRITE_ROUTE_IDS`), needs the `X-MCS-Request` header (ADR 0045) and, except the exchange, the session cookie (ADR 0085).

Two things make a write different from a read. A retry of a read is invisible; a retry of a write starts a second process, a second dialog or spends a
second access code. And the access code is the one secret the page ever holds: it must be able to go from the address bar to one request and nowhere
else.

## Decision
1. **`ApiClient.post(name, path, body, schema, opts)`** sits beside `get` and shares one private `request(spec, schema)` with it: the same timeout and
   abort handling, the same error envelope, the same `ApiError` kinds, the same contract check, the same tracking by endpoint name. It sends
   `Content-Type: application/json` and `X-MCS-Request: 1`, `credentials: 'same-origin'` and `cache: 'no-store'`. The default timeout is the client's
   (8 s); a call may pass its own (`terminalPickFolder` waits for a person: 600 s, with an abort on unmount).
2. **A body over 4096 UTF-8 bytes, or one with no JSON form, is a programming error.** `post` rejects with a `TypeError` before anything is tracked or sent
   (the server refuses over 4 KiB, ADR 0084). The error never repeats the body: a body can hold a folder path or a code.
3. **A write is never retried, by anyone.** The client does not retry; the mutation hooks use TanStack's default of zero retries. The codes that decide
   what a failed write means (`access_required`, `access_code_invalid`, `access_rate_limited`, `terminal_limit`, `terminal_unavailable`, `claude_not_found`,
   the folder, resume and picker codes) are listed once in `api-errors.ts`, decided by code before the generic 429 and 503 groups. The `retry` plan of
   those rows is the one the query client already applies to their status (`shouldRetry`, kept in step by an existing test): it concerns reads only.
4. **A failed write can be told from a failed read.** `ApiErrorInfo` gets an optional `method`, set to `'POST'` by `post` and absent for a read. It
   changes the words of one code: `access_required` on a read is the **locked** action (`ErrorState` renders "Access link needed. Paste it on the
   Workspace page to unlock this view": no page changes), on a write it is `access-required` ("The access link is required"). The texts of the new
   codes come from the catalogue and never from the server text, so a message cannot echo what a person pasted.
5. **The endpoints and keys.** Eleven endpoint names (`authSession`, `authExchange`, `authLogout`, `terminalState`, `terminalCreateSession`,
   `terminalKillSession`, `terminalPickFolder`, `terminalResume`, `folders`, `addFolder`, `sessionResume`) map to route ids of the registry; a route is
   a POST exactly when the registry lists it as a write (a test holds it). Every key starts with the instance id. The folder rows and the monitor rows
   of the live terminals are keyed under `sessions` (`linkedSessions`, `folderSessions`), so the stream patches their state and tokens in place without a
   new line of reconcile code; they do not carry the `sidebar` mark, so the reconciler does not add rows to them.
6. **The access flow is a store without React** (`data/access-flow.ts`), created once per shell and shared through `AccessFlowContext`. `submit(code)`
   exchanges the code (`POST authExchange`), then re-reads the session with a fresh `GET authSession`: authenticated is `granted` (the terminal state and
   the folders are refreshed), not authenticated is `cookie-not-kept` (the browser dropped the cookie; the code is spent), `access_code_invalid` is
   `invalid`, `access_rate_limited` is `rate-limited` with the `Retry-After`, anything else is `failed` with the `ApiError`. It never rejects.
7. **One request per code value, even under StrictMode.** Calls with the same code while the first is in flight share one promise. The map is emptied
   when the request settles; a rate-limited or failed code can be sent again, a spent one is answered by the server.
8. **The fragment is read once and removed after the request settles.** The key is `code` and the reader is the shared `parseLoginFragment` (conflict X1 of
   design 04: ADR 0085 chose `#code=`, 120 seconds). `redeemFragment` sends the code of the address bar and calls `stripAccessFragment` after the request
   has settled, whatever the outcome, with `history.replaceState` keeping the path, the query and the history state (the router's). A malformed `#code=...`
   is removed without a request. The paste field accepts the whole printed link or the bare code (`readAccessInput`); anything else sends nothing.
9. **The code is never stored.** It is not a mutation (the exchange is a plain `post`, so it stays out of the mutation cache), not part of a query key, a
   snapshot of the flow, an error (a failure that is not an `ApiError` is wrapped without its message), a log, web storage or the DOM, except the paste
   field a person typed it in. Tests look in each of those places.
10. **A 401 anywhere locks the terminal area.** While `useAuthSession` is mounted (the shell mounts it), any query or mutation of the instance that fails
    with `access_required` calls `markLocked`, which sets the session entry to `{authenticated: false}`; no page is edited. Logout (`useLogout`) posts
    first; on success it locks the page, removes the terminal state, the folder list and the resume answers (private to the session) from the cache,
    forgets `lastTerminal` and announces. A failed logout changes nothing and rejects (the server still holds the session); one that answers
    `access_required` finishes the lock.
11. **The test doubles follow the server.** `createFakeApi` matches a route by method as well as path (`/folders` is a read and a write), answers
    `csrf_rejected` to a write without the header, `body_invalid_json` and `validation_failed` to a bad body (and records a violation), and hands the
    parsed body to the handler. `fixtures/terminal.ts` holds invented factories for the terminal, folder, resume and access bodies.

## Consequences
- The one `fetch` of the web app now also carries writes; the ESLint rule that confines `fetch` to `api-client.ts` is unchanged.
- A page that shows a failed read through `ErrorState` needs no change to say "Access link needed" after a restart of the app.
- The access code lives in memory for the length of one request, in the address bar until that request settles, and nowhere else. A person who copies the
  address bar before the request settles copies the code, which is spent when the request lands.
- The retry plan of a 429 from `terminal_limit` or `access_rate_limited` on a **read** would be "once"; no read route answers them, so the row is only
  a statement for the table test.

## Alternatives rejected
- A mutation for the exchange: the code would sit in the mutation cache and its devtools for as long as the cache keeps it.
- Letting `markLocked` be called by every hook that sees a 401: one place (the cache subscription) is the rule, a hook cannot forget it.
- Retrying a write after a network failure: the server may have run it (a second terminal, a second dialog), and the person can press the button again.
- `history.replaceState(null, ...)`: it drops the state the router keeps on the entry; the state of the entry is passed through instead.

## Evidence
- `data/api-client.test.ts` (headers, 4096-byte guard in bytes, no retry, error kinds, timeouts and abort of a write), `data/api-errors.test.ts` (every
  code of the table, the locked and the refused wording, 429 and 503 by code), `data/query-keys.test.ts` (keys under the sessions prefix, the
  endpoint to route table, POST exactly for the writes), `data/access-flow.test.ts` (every outcome, one request per code under StrictMode, fragment
  stripped after the request settles, the code in no snapshot or storage), `data/hooks/useAuth.test.tsx` (a 401 locks, logout clears the terminal
  queries and `lastTerminal`, the real dependencies of the flow, the fake API's writes).
