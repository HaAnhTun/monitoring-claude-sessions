# 0135 Terminal quality in the browser: the WebGL renderer as an optional lazy chunk, Unicode 11, clipboard keys

Status: Accepted (CAW, 2026-11-20). Owner: web terminal (CAW-144, design 09). Amends 0097 decision 2 (the renderer) and finding 5's size table; keeps the rest of 0097
(three base packages, the nonce shim, the CSSOM colour adapter, the key table, the release chord). Related: 0041 (a new dependency needs an ADR), 0086 (CSP), 0100 (font).

## Context
The owner finds the in-app terminal poor next to Windows Terminal and VS Code. Causes found: the DOM renderer draws no custom box glyphs (gaps at line height 1.2), Unicode 6 widths
(no wide emoji), plain Ctrl+V sends 0x16 instead of pasting (xterm 6.0.0 `Keyboard.ts`), no right click paste or copy, no cursor option.

## Evidence
- Pairing: `@xterm/addon-webgl` 0.19.0 and `@xterm/addon-unicode11` 0.9.0 carry the commit of xterm 6.0.0, fit 0.11.0 and web-links 0.12.0 (`f447274f`); the webgl beta
  0.20.0-beta.331 needs xterm `^6.1.0-beta.338`. MIT, no dependencies, no install script, published 2025-12-22.
- Real browser (installed Chrome 157.0.8103.79, headless, software WebGL2 through SwiftShader; the real `htmlCsp` and `Permissions-Policy` headers of the server, the real loader, key
  table and options of the web package; probe page and script under `.dev/caw/shots/CAW-144/probe/`, results in `probe-results.json`):

| Probe | What was done | Result |
|---|---|---|
| P1 | Loader with the GPU chunk under the real CSP and nonce | 0 `securitypolicyviolation`; `kind()` is `webgl`; 2 `canvas` in `.xterm-screen`, no `.xterm-rows`; 24-bit colours painted; the DOM terminal next to it has `.xterm-rows` and no canvas; both chunks fetched |
| P2 | Ctrl+V and Ctrl+Shift+V with a two-line clipboard, in a terminal that enabled bracketed paste | both deliver exactly one `ESC[200~line one CR line two ESC[201~`; no 0x16; plain typing still arrives. The browser's own paste event fires for Ctrl+V once the handler returns false without `preventDefault` |
| P2b | `navigator.clipboard.readText()` on the page | rejected with `NotAllowedError`: the server's `Permissions-Policy: clipboard-read=()` forbids it (`document.permissionsPolicy.allowsFeature('clipboard-read')` is false) |
| P3 | `WEBGL_lose_context.loseContext()` without restore | after about 4 s `onContextLoss` fired once, the DOM renderer is back (`.xterm-rows` exists with the text written before and after), typing still arrives, 0 violations |
| P4 | Chrome with `--disable-gpu --disable-webgl --disable-3d-apis` | `webgl2Available()` is false, no request for the GPU chunk, the terminal draws on the DOM renderer, Unicode 11 still loads, 0 violations |
| P5 | Five terminals opened one after the other | `webgl`, `webgl`, `webgl`, `webgl`, `dom` |
| P6 | Cursor position report after an emoji line, a Vietnamese line, both mixed and combining marks | the reported column equals the expected one in all four lines (an emoji takes two cells, a combining mark none) |

  The GPU renderer draws the box border of Claude Code's UI as continuous lines at line height 1.2 (screenshot `P1-gpu-then-dom.png`); its cell width differs a little from the DOM
  renderer's, which is why a fallback ends with a fit.
- Size (gzip -9 of the Vite build, `check-bundle-budget.mjs`): Initial JS 186.3 kB; Terminal chunk 94.9 kB (it was 85.3 kB; Unicode 11 is 9.0 kB of it); Terminal GPU chunk 30.6 kB;
  All JS without the GPU chunk 428.0 kB (it was 416.5 kB); CSS 19.6 kB.

## Decision
1. Two exact pins in `@mcs/web`: `@xterm/addon-webgl` 0.19.0, `@xterm/addon-unicode11` 0.9.0 (one shared version, imports only in `xterm-loader.ts`, `check:deps`).
2. The WebGL renderer is a separate lazy chunk, imported only when WebGL2 is available and the preference is not "dom", attached after `open()` inside `try/catch`, at most 4 terminals at
   a time, back to the DOM renderer on `onContextLoss`. Any failure leaves the DOM renderer and never fails the engine.
3. Unicode 11 is loaded with `allowProposedApi` true (no other proposed API is used) and activated; a failure leaves Unicode 6.
4. No font file: the stack of 0100 (Cascadia Mono first) stays; Cascadia Mono has all 134 Vietnamese letters.
5. Plain Ctrl+V pastes through the browser paste event (not on macOS); right click is smart copy/paste with Shift+right click as the browser menu; copy on select, cursor style and
   renderer are preferences (renderer auto|dom, right click smart|menu, copy on select off, cursor block). A right click without a selection pastes only when the page may read the
   clipboard: while the server's `Permissions-Policy` carries `clipboard-read=()` (P2b) it opens the browser menu at once, and the menu has Paste. Raising the policy to
   `clipboard-read=(self)` is a decision of the security design, not of this package; the code asks the browser (`document.permissionsPolicy`) and follows whatever the server says.
6. Budget: new row "Terminal GPU chunk" (limit 34 kB, measured 30.6 plus 10 percent), Terminal chunk 105 kB (measured 94.9 plus 10 percent), All JS 432 kB without the GPU chunk
   (owner decision Q1: the total reaches 466 kB, above the 450 of CAW-53, because the GPU chunk is optional, lazy and loaded from loopback only on a machine with WebGL2).
   The partition is by manifest key (`/@xterm/addon-webgl/`), and the script fails when the renderer's code (`webglcontextlost`) is in an initial chunk or outside its own chunk.

## Consequences / revisit
GPU text is grayscale antialiased (the preference returns to the DOM renderer). If a stable xterm release pairs a newer webgl addon, only the pins, the loader and the numbers change.
If WebGL breaks under the policy in a later Chrome, ship with the preference defaulting to "dom": one constant. The probes ran in headless Chrome with a software GPU; the manual
acceptance of design 09 section A10 on a real GPU (box borders, copy and paste with the real clipboard, context loss) is the owner's two minutes after `caw restart`.
