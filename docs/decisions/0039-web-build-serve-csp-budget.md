# 0039 Web build and serve: Vite base `/`, hashed assets, external pre-paint script, strict CSP, bundle budget, axe-core

Status: Amended by 0063 (proposed Phase 1, 2026-10-11). Owner: UI design (`docs/design/04-ui.md` sections 11.4, 12).

## Context
The server (`packages/server`) hosts the built SPA from `packages/web/dist` (D1). The page must load nothing from the network except
same-origin files (legacy rule), must avoid a theme flash (research risk 6), and should run under a strict Content-Security-Policy. In
development the Vite dev server proxies `/api` to a real instance whose Host/Origin guard rejects foreign hosts.

## Decision
- Vite 8.3.4, `base: '/'`, output `dist/` with hashed `assets/*`, `manifest: true`, `sourcemap: false`, `modulePreload.polyfill: false`.
- `public/theme-init.js` (classic, blocking, tiny) sets `data-theme`/`data-density` before paint; no inline script anywhere.
- Server headers for HTML: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`; assets
  `immutable`, `index.html` `no-store`.
- Dev proxy: `changeOrigin: true` plus an `Origin` rewrite to the target. Dev defaults (adopted from design 05 Appendix A.27, critic
  issue I-13): `MCS_DEV_API` `http://127.0.0.1:18765`, dev server `MCS_WEB_DEV_PORT` 18766, preview 18767 (range 18760-18769 of 05 4.5);
  never 8765 (the owner's live legacy monitor). `resolve.conditions: ['@mcs/source', ...defaultClientConditions]` so dev and build use
  workspace TypeScript sources without a prior `tsc -b` (ADR 0040). Developers start both processes with the root `npm run dev` (05 3.1).
- `scripts/check-bundle-budget.mjs` fails the build above 200 kB gzip initial JS, 260 kB gzip total JS, 25 kB gzip CSS, or when
  `index.html` contains an inline script or an external URL.
- Add `axe-core` (pinned, dev only) for the E2E accessibility scan, injected with `page.addScriptTag({ path })`; no `@axe-core/playwright`.

## Consequences
- The budget leaves about 80 kB gzip for application code above the measured framework baseline (118.5 kB).
- Any future inline script or third-party CDN breaks the build or the CSP, by design.

## Alternatives rejected
- Inline theme script: needs `'unsafe-inline'` or a hash in the CSP.
- Relative `base: './'`: deep routes (`/sessions/x`) would resolve assets relative to the path.
- `@axe-core/playwright`: one more package for what `addScriptTag` does.

## Evidence
- Build probe 2026-10-11 (`D:/mvp/private/scratch/mcs-v3/ui/app`, Vite 8.3.4, Rolldown): no inline script in `dist/index.html`;
  `theme-init.js` copied unchanged; React + router + query + 37 icons = 95.0 kB gzip; React + zod = 91.9 kB; React alone 68.3 kB.
- CSP probe 2026-10-11 (`cspserve.mjs` + `csp/csp.spec.mjs`, Chrome 155): app rendered under the policy above, style props applied, no
  violation (one favicon 404, handled by `<link rel="icon" href="data:,">`).
- Proxy probe 2026-10-11 (`app/vite.dev.config.ts`, `app/vite.dev2.config.ts`, `hostecho.mjs`): without `changeOrigin` the backend saw
  `Host: 127.0.0.1:<vite port>`; with `changeOrigin` + `proxyReq` rewrite it saw the target host and origin; SSE first chunk after 33 ms.
- Design 05 experiments E5/E16 (2026-10-11, Vite 8.3.4): the `@mcs/source` condition resolves `@mcs/shared` sources in dev and build.
- Playwright `channel: 'chrome'` works without a browser download (`stack-versions.md` section 6, re-run 2026-10-11).
