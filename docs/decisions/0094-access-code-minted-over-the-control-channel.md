# 0094 The access code is minted on demand over the control channel and lives in memory only

Status: Accepted (CAW, 2026-11-15). Owner: lifecycle area (lif), work package CAW-22; co-owned with the security area (srv), whose 0085 describes the code, its exchange and the cookie. Builds on
0005 (the control channel) and 0093 (the protocol extension). Related: 0079 (every write route needs the code), 0084 (the guard chain), 0091 (the user instance).

## Context
The terminal part of the app starts processes with the person's credentials, so the browser has to prove that it was sent by the person who ran `caw start` on this machine. The proof travels
from the CLI to the browser once. Everything it passes through can leak it: a file the CLI reads, the command line of the browser (other processes of the same user can list it), the
history of the browser, the log of a server or a proxy, the transcript of an agent that ran `caw start --json` (and this product reads transcripts).

The server already has a root of trust that the CLI shares: the token of `run/control.token` over the pipe (0005). The access service (0085) knows how to mint a one-use code. What was open was
how the code gets from one to the other and who may see it.

## Decision
1. **A control operation, `access`.** It needs the instance id and the token, the phase `ready`, and an access service behind it. It answers
   `{ code, expiresAt, ttlSeconds }`; a task instance, or a user instance without an access service, answers `UNSUPPORTED`; before `ready` it answers `NOT_READY`. It is the only way to get a
   code: no HTTP route mints one (0084 item 8), because a browser can reach HTTP and cannot reach a pipe.
2. **Minted on demand, one per call.** Every call asks `AccessService.mint()` for a new code: 32 random bytes in base64url (`ACCESS_CODE_RE`), one use, 120 seconds by default, at most four
   outstanding (0085). A second `caw open` is a second code; nothing is reused, and a restart of the instance ends every code and every cookie.
3. **In memory only.** The code is never written to `state.json`, `run/`, `boot.log`, `runtime.log`, the audit trail, the database, an environment variable or the shortcut of autostart. The
   control channel logs `control_request` with the route `control:access` and the status and nothing else, and a refusal or a failing minter is logged by route and code, never with the
   value. The access service keeps hashes, not codes. The CLI holds the code in memory between the reply and the call that opens the browser, and forgets it.
4. **The fragment URL.** The code travels as `http://127.0.0.1:<port>/#code=<code>` (`buildLoginUrl`). A fragment never reaches a server, a `Referer` header or a request line; the page removes
   it with `history.replaceState` after the exchange (0085 item 2). The host is `127.0.0.1`, not `localhost`.
5. **Print rules (the CLI half).** The URL is opened in the browser and not shown. It is printed only with `caw open --print`, or as the fallback when the browser could not be opened. It is never
   in the envelope of `--json` unless `--print` is given: an agent that ran `caw start --json` would record a credential in a transcript. `caw start --no-open` mints nothing. A test starts an
   instance, runs `open --print`, and scans every file under the instance folder and the MCS home and the captured output of `start`, `status` and `stop`: the one hit is the line it asked for.
6. **Why a request and not a file.** A file like `control.token` would be a long-lived credential on disk, readable by every process of the user. The code unlocks terminals, that is, arbitrary
   commands as the user. A code that does not exist until it is asked for, dies in two minutes and works once shrinks the unavoidable leak windows (the browser's command line and its history) to
   something that is already useless by the time anyone reads them.
7. **What the token still means.** Whoever holds `run/control.token` can ask for a code, so the token is the root of trust and stays one: it is written at every boot, owner-only where the system has file modes,
   and removed at shutdown. This decision adds a use for it; it does not weaken the rule that the token never travels over HTTP and is never accepted on a write route (0084 item 5).

## Consequences
- After a restart or a logon the old link is dead; `caw open` makes a new one. Autostart starts with `--no-open` for that reason, and the README says to run `start.bat` or `caw open`.
- A scrollback that still shows a link holds nothing usable after two minutes or one use.
- The lifecycle package owns the operation and its logging rules, the security package owns the code and its exchange; neither can change the other's half without this record.
- An older server answers `BAD_REQUEST` to `access`; the lifecycle CLI treats that as an instance that must be restarted before it can open a login link.

## Alternatives rejected
- **A code printed by the server at start and kept in `state.json`:** a credential on disk and in `boot.log` for the whole life of the instance.
- **The CLI reading `run/control.token` and signing a code itself:** the secret that signs would have to be shared with the CLI, and the CLI could not be told apart from any other reader.
- **An HTTP route that mints a code for a caller with the control token:** the token would have to travel over a transport that a browser page can reach.
- **A code in the query string or in a cookie set by the CLI:** the query string reaches logs and the next request's `Referer`; the CLI has no way to set a cookie in a browser it did not start.
- **One long code per start, reusable:** a link in a history, a transcript or a chat would stay a credential until the next restart.

## Evidence
- `server/src/control-channel.test.ts`: `access` answers the code, an ISO expiry and the lifetime; a new code per request; `UNSUPPORTED` without a minter, in every phase, and for a minter that has none;
  `NOT_READY` before `ready` and `FORBIDDEN` for a wrong token without minting; a minter that throws answers `INTERNAL` with no message and no code in the reply or the log; the log carries the route
  and the status and never the code.
- `server/src/boot.test.ts`: the minter is read from the user services when the request arrives, and a task instance, a missing runtime and a runtime without an access service all answer `UNSUPPORTED`.
- `engine/src/runtime/access-service.test.ts` (0085): the code is one use, lives 120 seconds, and a code is never taken for a credential.
