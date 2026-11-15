# 0086 CSP for the terminal page: a style nonce for xterm, ws:// in connect-src, a Permissions-Policy

Status: Accepted (CAW, 2026-11-15). Owner: server area (srv), design 02 (section 7). Amends 0039 (the strict policy `style-src 'self'` with no inline style) for HTML responses.
Related: 0045 (the global headers), 0081 (the terminal WebSocket), 0085 (the access cookie).

## Context
0039 gave the page a strict policy: same-origin sources, no inline script, no inline style. The terminal view brings two things that policy does not allow.

- **xterm.js creates `<style>` elements.** Its DOM renderer builds one with `textContent` at construction, again on resize and on a theme change. The renderer is created by `open()` before an addon
  such as WebGL or canvas can replace it, so under `style-src 'self'` every terminal open produces a blocked inline style and a `securitypolicyviolation` event. Choosing another renderer does not avoid it.
- **The terminal talks over a WebSocket** to the same host and port. `connect-src 'self'` covers a same-origin `ws:` in current browsers, but older ones (Safari) do not apply it.

## Decision
1. **The policy is a function of the request.** `htmlCsp(host, nonce)` replaces the constant and gives, character for character:
   `default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'nonce-<nonce>'; img-src 'self' data:; connect-src 'self' ws://<host>; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.
2. **A nonce for style elements only.** `style-src-elem` takes the nonce, so an injected `<style>` without it is blocked; `style-src` stays `'self'` and `style-src-attr` is not set, so inline `style=` attributes stay
   blocked (React and xterm set styles through CSSOM, which CSP does not govern). A nonce is stricter than `'unsafe-inline'`. The script policy is untouched: no inline script, no `unsafe-eval`.
3. **A fresh nonce per HTML response.** `sendStatic` makes 16 random bytes (24 base64 characters), replaces every `__CSP_NONCE__` in the HTML body with it and puts the same value in the header. The page is `no-store`, so no
   cache serves one nonce twice. The web build puts `<meta name="csp-nonce" content="__CSP_NONCE__">` in `index.html`; the terminal module wraps `document.createElement` once so that a created `style` element gets `el.nonce`.
   A file that is not HTML (script, style, image, font) is sent as it is: no policy, no replacement.
4. **`ws://<host>`, never `wss:`.** The server speaks plain HTTP on loopback, so a secure socket cannot connect. The host is the `Host` header after `hostGuard` (`127.0.0.1:<port>` or `localhost:<port>`), and the function
   checks it again against `^(127.0.0.1|localhost):<1 to 5 digits>$` and the nonce against base64, and throws a `RangeError` otherwise: no header text is ever interpolated into the policy.
5. **A Permissions-Policy on every HTML response:** `camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(self)`. The page may copy to the clipboard, and a program in the terminal that asks the page
   to read it back (an OSC 52 query) gets nothing: `clipboard-read` is denied for the page and every frame.
6. **Unchanged and global:** `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and `-Resource-Policy` same-origin, `Cache-Control: no-store` for `/api/*`.
   No `Access-Control-*` header exists anywhere.

## Fallback
If the browser proof (the terminal in a real browser under this policy, zero `securitypolicyviolation` events) fails, the one change allowed is `style-src-elem 'self' 'unsafe-inline'` in `htmlCsp`, with `style-src-attr` still unset.
That is weaker than the nonce but still blocks inline style attributes and inline script. It needs a new ADR that supersedes this decision, because it loosens a policy this one tightened.

## Consequences
- Every HTML response is built per request, so it is never cached and never shared between requests. Its cost is one random call and a replacement of a short text.
- The design file of the web area chose WebGL or canvas under the strict policy and expected no violation; that expectation holds only with the nonce, and the DOM renderer then also works as the fallback when WebGL is unavailable.
  The choice of renderer stays with the web area; the policy is this one.
- A host that is not a loopback name with a port cannot reach `sendStatic` (the Host guard answers first), and if one did, the page would be a 500 and never a policy with that text in it. The guard ignores the letter case of `Host`, so `sendStatic` lower-cases it before it builds the policy: `LOCALHOST:<port>` gets the page, with `ws://localhost:<port>` in `connect-src`. `htmlCsp` itself stays strict about case.

## Alternatives rejected
- **`style-src 'unsafe-inline'`:** it lets any injected markup restyle the page, and it applies to attributes as well.
- **A hash of each style text:** xterm builds its style text from the theme and the cell size, so the hash changes with the user's settings and on every resize.
- **One nonce for the whole process:** a nonce that does not change is a constant an attacker can learn from one response.
- **`wss:` or a wildcard `ws:` in `connect-src`:** a secure socket cannot work here, and a wildcard lets the page connect to any server.

## Evidence
- `app.test.ts`: `htmlCsp` character for character for both hosts, a table of hostile hosts and nonces that throw, 12 responses with 12 different nonces that match in header and body, the Permissions-Policy on HTML only, a non-HTML file untouched.
- `test/static.int.test.ts`: the header for `127.0.0.1` and `localhost` on a real server, the nonce in the header and in the body, no `unsafe-inline`, `unsafe-eval` or `wss:`, assets untouched, and the earlier cases of the static site
  (cache rules, fallback, files never served) unchanged apart from the nonce.
