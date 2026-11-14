# 0081 ws for the terminal WebSocket

Status: Accepted (CAW, 2026-11-14). Owner: foundation area (fnd), server design (design 02, section 5.1). Amends 0041 (adds one exact-pinned dependency to
`@mcs/server`, and lifts the avoid-list entry `ws` for the terminal code only). Related: 0079, 0080.

## Context
The terminal talks to the browser over one WebSocket per session: binary frames carry raw bytes both ways and a text frame carries the resize message (spec section 2).
Node has no server-side WebSocket in its standard library. 0041 lists `ws` on the avoid list so that nothing pulls a networking library in by habit; the terminal is the one
feature that needs it. The spec lists `ws` as an assumed choice, confirmed by the owner.

## Decision
1. **`ws` 8.22.0**, exact pin, declared in `packages/server/package.json` `dependencies`; `@types/ws` 8.18.2, exact, in the `devDependencies` of the same package.
   `scripts/check-deps.mjs` keeps checking that every import is declared in the importing package.
2. **Scope**: the `ws` entry of the avoid list is lifted for the terminal code of the server only (`packages/server/src/terminal`, and the server tests that need a client
   that can set `Origin` and `Cookie`). `ws` stays banned everywhere else (engine, web, the other server folders). The change of `eslint.config.js` and its probes belong
   to the boundaries package of the program; until it lands the global ban stands and nothing imports `ws`.
3. **Layering**: the engine owns the terminal service and the processes; the server owns the sockets and the access checks. The server still never starts a child process.
4. **Optional peers not installed**: `bufferutil` and `utf-8-validate` are optional peer dependencies of `ws`; they are native, so they are not installed and `ws` falls
   back to its JavaScript code inside a `try/catch`. The bundle lists them as external so that the `require` stays a runtime no-op (a later package).

## Evidence
- `ws` 8.22.0: MIT licence, pure JavaScript, Node >= 10; it was already in `package-lock.json` as a development-only transitive dependency at this exact version, so the
  tarball integrity is unchanged: `sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg==`. This change removes the `dev` flag
  from that entry because the server now depends on it in production.
- No lifecycle script and no runtime dependency in the `ws` package; the two optional peers are absent from the lockfile install.
- `npm ci --ignore-scripts` in a scratch copy of the manifests installs it and `require('ws')` loads.
- `@types/ws` 8.18.2 is a types-only package (MIT).

## Consequences
- The server gains one production dependency (about 0.1 MB of JavaScript in the bundle, with its licence in the third-party notices).
- A WebSocket upgrade is a new request path: the upgrade handler repeats the `Host`, `Origin` and access-code checks of the HTTP chain (design 02, section 5.2) before `ws` sees
  the socket.
- Replacing `ws` later means changing one gateway file; no `ws` type leaves `packages/server/src/terminal`.

## Alternatives rejected
- Hand-written WebSocket framing (as MTOP does in `wsock.py`): more code to maintain and to audit than a small, widely used library, in a security-relevant path.
- `socket.io`, `uWebSockets.js` and similar: larger, a custom protocol or a native addon.
- Server-sent events plus HTTP posts for keystrokes: no binary frames, one request per keystroke, and a worse latency and ordering story for a terminal.
