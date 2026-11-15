# 0097 xterm.js in the web bundle: one lazy chunk, the DOM renderer under a style nonce, and a CSSOM adapter for 24-bit colours

Status: Accepted (CAW, 2026-11-15). Owner: WEB-XTERM (CAW-40), design 04 sections 7.1, 7.5, 10, 11 and conflict X6. Amends 0039 (the numbers of the bundle budget and the
`index.html` scan, the dev proxy now carries the WebSocket) and 0041 (three new runtime dependencies, with the evidence its rule asks for). Corrects one sentence of 0086 (what xterm
does with style attributes); the policy of 0086 is unchanged. Related: 0086 (the CSP the page runs under), 0087 (the protocol the terminal speaks), 0098 (the connection that feeds
it), 0100 (the colours and the font it is given), 0079 (the stance: the terminal is the one place the UI writes to a process).

## Context
The Workspace page shows a real terminal, and the owner asked for xterm.js (three packages, bundled by Vite, no CDN). The design left four things open, each to be settled by a spike in
the installed browser under the real policy rather than by reading code:

- Does the policy of 0086 (`style-src 'self'; style-src-elem 'self' 'nonce-<n>'`, no `style-src-attr`) let xterm paint, with zero `securitypolicyviolation` events?
- Which renderer? Area uis wanted WebGL (or canvas) with a contrast ratio of 4.5 and refused the DOM renderer, areas srv and qa assumed the DOM renderer under a nonce (conflict X6).
- Does the DOM renderer still run when a renderer addon replaces it?
- What do both options weigh?

## Spike
Installed Chrome 157.0.8103.51 through Playwright (`channel: 'chrome'`), headless. A small server answers with the exact policy string of `htmlCsp` (0086) and a fresh nonce in
`<meta name="csp-nonce">`; every `securitypolicyviolation` event of the page is collected. Page 1 loads the published ES modules of xterm 6.0.0, `addon-fit` 0.11.0 and
`addon-web-links` 0.12.0, writes invented coloured text (palette colours, bold, dim, a 256-colour index, 24-bit foreground and background, italic, underline, a link, a box-drawing line),
resizes and fits. Page 2 is the real loader (`xterm-loader.ts`) and the real built stylesheet, in light and dark at 1440, 1024 and 600 px. The scripts and screenshots stay in
`.dev/caw/shots/CAW-40/` (not tracked).

| Variant (xterm 6.0.0, DOM renderer unless stated) | Violations | What the cells look like |
|---|---|---|
| no nonce wrapper | 21 (`style-src-elem` and `style-src-attr`) | no cell styled at all: the theme `<style>` is blocked, every colour falls back to the default |
| nonce wrapper | 9 to 11, all `style-src-attr` | palette, 256-colour, bold, dim, italic styled; every **24-bit foreground and background lost** |
| nonce wrapper and `minimumContrastRatio: 4.5` | 13, all `style-src-attr` | as above, and the adjusted colours lost as well |
| no nonce wrapper and `minimumContrastRatio: 4.5` | 25 | nothing styled |
| **nonce wrapper and the colour adapter** (below) | **0** | every colour renders, also with `minimumContrastRatio: 4.5` (0 violations) |
| WebGL addon 0.19.0 loaded before `open()`, nonce wrapper | 0 | rendered in headless Chrome; no `.xterm-rows`, no DOM renderer style elements |
| the same without the nonce wrapper | 2 (`style-src-elem`) | the scroll bar's `<style>` element of xterm's viewport is still created and blocked |
| WebGL addon loaded after `open()`, nonce wrapper | 0 | the DOM renderer was built and then disposed; same picture |
| WebGL addon 0.20.0-beta.330, nonce wrapper | 0 | same picture; its peer range is `^6.1.0-beta.337`, so it is not a release for 6.0.0 |

Real loader and real CSS, eight runs (dark and light at 1440, 1024 and 600 px, plus the 4.5 ratio at 1440): zero violations in all of them, every cell styled (including a 24-bit
background pair like Claude Code's diff lines and a 256-colour index), `scrollWidth` equal to the viewport (no horizontal scroll), 187x50, 132x42 and 83x50 cells after the fit (12 px
font below 700 px), the text area focused after `focus()` with the one pixel focus line on the host, and the computed background of `.xterm-viewport` equal to the terminal token in both
themes (`xterm.css` paints it black; `terminal.css` wins from the pages layer, no `!important`).

Findings, from the runs and from the sources of 6.0.0:

1. **A nonce is needed whatever the renderer.** `Viewport.ts` creates a `<style>` element for the scroll bar, so even with the WebGL addon the page would log violations without it.
2. **The DOM renderer is not constructed when an addon replaces it before `open()`.** `open()` fires `onWillOpen`, an addon may set the renderer there, and `_createRenderer()` runs only
   `if (!hasRenderer())`. This corrects the assumption in design 04 (X6 reason 3) and in 0086 ("created by `open()` before an addon can replace it") for the 6.x line; it does not change the
   need for the nonce (finding 1).
3. **0086 is wrong about one thing.** It says "React and xterm set styles through CSSOM, which CSP does not govern". The DOM renderer writes `element.setAttribute('style', ...)` in exactly
   three places of `DomRendererRowFactory`: the foreground colour of a 24-bit cell (`color:#rrggbb`), the background colour of a 24-bit cell (`background-color:#rrggbb`) and a colour that the
   minimum contrast adjusted (`color:<css>`). A style attribute is governed by `style-src-attr`, which falls back to `style-src 'self'` and blocks it. Claude Code draws with 24-bit colours
   (diff lines, its own accent), so without a remedy the terminal loses them and logs a violation per painted cell.
4. **Writing the same declarations through the CSSOM is not governed by the policy**, in Chrome 157: `element.style.cssText = 'color:#0ac832'` and `style.setProperty(...)` both produced zero
   violations and the colour (page 1, `adapter-css` and `adapter-prop` variants).
5. **Size.** xterm 6.0.0 is 345.0 kB raw and 88.3 kB gzip as published (`gzip -9`), against the 5.5 build of the design (289 kB raw, 67.2 kB gzip): 21 kB more. Built by Vite the chunks are
   `xterm` 82.1 kB, `addon-fit` 0.5, `addon-web-links` 1.1 and the loader with both shims 1.5: **85.3 kB gzip** (the number the budget script reports), plus 2.5 kB of `xterm.css` in the
   initial CSS. The WebGL option would add 35.9 kB (0.19.0) or 68.4 kB (the 6.1 beta) to that: about 121 kB for the stable one, and a fourth package.

## Decision
1. **Three runtime dependencies of `@mcs/web`**, exact pins, latest stable by `npm view` on 2026-11-15: `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-web-links` 0.12.0. All MIT,
   none declares an install script, a dependency or a peer, so `npm ci --ignore-scripts` installs them as they are; the lockfile holds the `sha512` integrity of each tarball.
   (0041 asks for purpose, size, maintenance status and version evidence: purpose above, sizes in finding 5, the versions are the `latest` dist-tags, and the spike ran them.)
2. **The renderer is xterm's DOM renderer, with no renderer addon**; no WebGL or canvas package is added. Reasons: the owner's list has three packages; the only addon that declares a peer
   range for 6.x is a beta, and the latest stable one (0.19.0) declares no range at all, so no stable pairing exists; the nonce is needed anyway (finding 1); WebGL can be unavailable
   (blocklisted GPU, a lost context) and the DOM renderer is then the only fallback, so it must work under the policy in any case; the WebGL option costs 36 kB and a dependency.
   If a later release pairs a stable WebGL addon with xterm, only `xterm-loader.ts` (one `loadAddon` before `open`) and the budget numbers change.
3. **Two shims, both in `terminal/style-nonce.ts`, installed by the loader once before xterm is imported, and the policy is not loosened** (no `style-src-attr`, no `'unsafe-inline'`).
   - `installStyleNonce` wraps `document.createElement` so that a `style` element it returns carries the nonce read from `<meta name="csp-nonce">`. It does nothing when the tag is missing,
     empty, still the placeholder (the dev server, tests) or not base64.
   - `installInlineColorAdapter` replaces `Element.prototype.setAttribute`: a `style` write whose value is nothing but `color` and `background-color` declarations with a hex or `rgb()`/`rgba()`
     value (at most 256 characters; the text is cut at `;` and each part is tested by an anchored pattern with one way to match, so the cost is linear, and a test bounds the time of crafted
     values: a first pattern with `\s*;?\s*` in a `+` group took 2.75 s for 205 characters) is applied with `element.style.cssText`, which replaces the whole style as the attribute would; every other call reaches the browser's method with the same
     `this` and arguments. It can therefore set no other property and no `url()`. A guard makes a DOM that reflects a CSSOM write back through `setAttribute` (happy-dom does) reach the real
     method instead of recursing. Both shims are idempotent and return their remover.
4. **Contrast.** `options.ts` (CAW-42) keeps `minimumContrastRatio` at 1 as planned. The reason design 04 gave (the DOM renderer applies a higher value through `setAttribute('style')`, which
   the policy blocks) no longer holds: with the adapter a ratio of 4.5 ran with zero violations. What remains is a product choice with a measured cost and benefit. At ratio 1 on the light theme,
   a program that paints a dark 24-bit background and leaves the default (dark) foreground is unreadable (the diff line of the spike screenshot at 600 px); at 4.5 it is readable
   (screenshot at 1440 px). The price is a contrast computation per colour pair (cached by xterm) and one CSSOM style write per adjusted cell. Recommendation to the owner and to CAW-42: 1 on the
   dark theme (the MTOP look, programs' own colours), 4.5 on the light theme. Not applied here: the file that would apply it belongs to the view package.
5. **One lazy chunk.** `terminal/xterm-loader.ts` is the only file that imports `@xterm/*` (ESLint: `no-restricted-imports` and an `ImportExpression` rule, lifted for this file only). It calls
   `installCspShims()` and then three `import()` calls in parallel (Vite makes one chunk per package, loaded together), adapts the classes to `TerminalEngine` (`terminal/engine.ts`) and returns it.
   The view loads it when a session is opened; the initial chunk never contains xterm (the budget script checks it, decision 9). The `WebLinksAddon` handler opens `http` and `https` addresses only,
   in a new tab with `noopener,noreferrer`; the text is terminal output and is never trusted. It is a click on printed text, not a rendered link, so the lint rule against `target="_blank"` in JSX is not involved.
6. **Keys** (`terminal/keys.ts`, pure, `decideKey`): `Ctrl+Shift+Space` releases the keyboard (the way out of the trap, WCAG 2.1.2); `Ctrl+C` copies when there is a selection (the view then clears it, so
   the second one interrupts) and passes otherwise; `Meta+C` with a selection copies; `Ctrl+Shift+C` copies with a selection and is swallowed without one (never an interrupt, never the browser's inspect);
   paste keys and everything else pass; only `keydown` is decided and nothing during an input method composition. The chord text for display is `RELEASE_CHORD` of `protocol.ts`.
7. **Styles.** `styles/index.css` imports `@xterm/xterm/css/xterm.css` once, in the `components` layer, so that the `pages` layer can override it; it is the only import that is not a local file (a guard of
   `tokens-usage.test.ts`, and an assertion in `styles.test.ts`). `styles/terminal.css` is layout only, in the `pages` layer, with `.terminal-*` selectors and tokens for every colour.
8. **The page.** `index.html` carries `<meta name="csp-nonce" content="__CSP_NONCE__">`, which the server replaces on every response (0086). `auditHtml` of the budget script fails the build when the tag
   is missing, duplicated or has another content: without it the terminal would paint unstyled in production only.
9. **Dev proxy.** `/api` is proxied with `ws: true`, and the `proxyReqWs` handler presents the target origin on a handshake that has an Origin, as `proxyReq` does for plain requests (the server compares the
   Origin of the handshake with its own, 0087). A handshake without an Origin is left alone.
10. **Budget** (`scripts/check-bundle-budget.mjs`, amends 0039): initial JS stays 200 kB; all JS 340 to **420 kB**; CSS 25 to **30 kB**; a new row **Terminal chunk** with a limit of **94 kB**, the fresh build
    (85.3 kB) plus 10 percent. The row is the gzip of every JavaScript file reachable from the manifest entry `src/terminal/TerminalView.tsx` or `src/terminal/xterm-loader.ts` through `imports` and
    `dynamicImports` that is not in the initial set (zero, with a note, while the build has neither). A new failure, `xterm is in the initial chunks: <file>`, fires when a terminal entry is itself an initial
    chunk or when an initial chunk contains the text `xterm-dom-renderer-owner`, which only xterm's code carries. `tests/tooling/web-bundle-budget.test.ts` builds a fake `dist` with a manifest and proves
    every row and both failures. The all-JS limit leaves about 8 percent headroom over the build with the terminal chunk (302 kB now, 387 kB with it); the retune from a fresh build belongs to the budget package.

## Consequences
- The page loads xterm only when a session is opened, and under the policy of 0086 as it is. The one change to the page's own code is that `Element.prototype.setAttribute` is wrapped after the first terminal is
  loaded and stays wrapped. The wrapper acts only on the exact value shape above; it is the narrowest remedy that was found, and it is covered by a table of accepted and refused values.
- The evidence is Chrome 157 (Edge shares the engine). Firefox and Safari were not run: the CSP specification does not govern CSSOM writes, so the adapter should behave the same there, but that is not
  measured here. The terminal page's Playwright specs run the real stack under the real policy and assert zero violations.
- xterm 6 costs 21 kB gzip more than the 5.5 of the design; the terminal chunk is lazy, so only people who open a session pay for it.
- Claude Code's 24-bit colours (diffs, its accent) now render. On the light theme they are still the program's own colours until decision 4 is taken.
- `terminal/engine.ts` (the types the loader returns) is created with the loader; the view package owns it from there.

## Alternatives rejected
- **`style-src-attr 'unsafe-inline'`** (or `'unsafe-hashes'` per value): it would let injected markup restyle the page through attributes, and the values are not static (`color:#rrggbb` for every colour a program prints).
  The adapter needs nothing from the policy.
- **`style-src-elem 'self' 'unsafe-inline'`:** the fallback of 0086, still not needed: the nonce wrapper gave zero violations.
- **The WebGL addon (0.19.0 or the 6.1 beta):** see decision 2. It would also not remove the nonce.
- **Patching xterm** (a vendored copy that writes through the CSSOM): a fork to maintain against every release, for what a shim of 40 lines does.
- **Staying on xterm 5.5** (smaller by 21 kB): the owner asked for the latest stable, and a pin on an older major would be the first thing the dependency check of a later release has to move.
- **Letting the 24-bit colours go** (default foreground and background for them): it removes the diff colours and the accent of the program the page exists to show.

## Verification
`keys.test.ts` (every row of the table, with and without a selection, the modifier combinations, key up and composition), `style-nonce.test.ts` (reading, wrapping, idempotence, removal, the adapter's accepted
and refused values, the recursion guard, the real prototype), `xterm-loader.test.ts` (the link rule, the adapter over fake classes call by call, the shims, and one load of the real packages), `styles.test.ts`
(the xterm import and `terminal.css`), `tests/tooling/web-bundle-budget.test.ts`, `tests/tooling/web-vite-proxy.test.ts`, `npm run build` and the printed budget table, `npm run check:deps`.
