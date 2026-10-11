# 0030 SPA routing: React Router 8 declarative mode, URL search params as filter state

Status: Proposed (Phase 1, 2026-10-11). Owner: UI design (`docs/design/04-ui.md` section 3).

## Context
The new UI has seven views (overview, sessions, session detail, activity, tasks, analytics, settings). The brief (8.2) asks for
bookmarkable filters. The legacy page used one URL hash `#sid=&agent=` that existing users have bookmarked. D7 pins React Router 8.4.0 in
declarative mode with TanStack Query owning data.

## Decision
- `BrowserRouter` (declarative) with the route table in 04-ui section 3.1; a layout route renders `AppShell`.
- The server serves `index.html` for non-API, non-asset HTML requests (history fallback).
- All filter state lives in the URL query string, parsed and serialised by one pure module (`src/lib/url-state.ts`) with total parsing:
  invalid or unknown keys are dropped, the URL is canonicalised with `replace`, and the page shows which keys were ignored. Defaults are
  omitted. Filters replace history entries; route and tab changes push.
- Cursors and scroll positions never enter the URL.
- `LegacyHashRedirect` maps `/#sid=X&agent=Y` to `/sessions/X?tab=transcript&agent=Y` (200-char caps kept).

## Consequences
- Every view is a shareable local link; tests can open any state directly.
- The server must implement the history fallback and keep `/api/` and `/assets/` out of it.
- Data loading stays in TanStack Query hooks; no router loaders/actions (data mode is not used).

## Alternatives rejected
- Data mode / framework mode: duplicates TanStack Query's cache and pending states; framework mode implies a server runtime we do not want.
- `HashRouter`: not needed because the Express server can rewrite paths; hash URLs would collide with the legacy `#sid=` links.
- Filter state in a store (Zustand/Redux): not bookmarkable, adds a dependency (avoid list in stack-versions section 9).

## Evidence
- `docs/research/stack-versions.md` section 5 (reactrouter.com/start/modes, fetched 2026-10-11; declarative mode "can work for SPAs with
  existing data layers").
- Scratch probe 2026-10-11 (`D:/mvp/private/scratch/mcs-v3/ui/exports.mjs`, react-router 8.4.0): `BrowserRouter`, `Routes`, `Route`,
  `NavLink`, `Navigate`, `Outlet`, `useSearchParams`, `createSearchParams` exported.
- Legacy hash behaviour: `src/frontend/modules/prefs.js` `parseHash`/`buildHash`; must-preserve item 1 in `current-state-frontend.md`.
