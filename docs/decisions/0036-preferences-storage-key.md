# 0036 Preferences: new key `mcs.ui.v3` with one-way import from `ccm.prefs.v1`

Status: Proposed (Phase 1, 2026-10-11). Owner: UI design (`docs/design/04-ui.md` section 9).

## Context
Legacy users have display preferences in `localStorage` key `ccm.prefs.v1` (theme, density, kinds, collapsed panels, filter, selection).
D12 keeps the base port 8765, so the new UI and the legacy UI can be served from the same origin at different times and share
`localStorage`. The legacy `sanitize` drops unknown keys and rewrites the whole object on every `set`, which would erase any new field
stored under the old key.

## Decision
- Store new-UI preferences under `mcs.ui.v3` (legacy validators + `navOpen`, `lastInstanceId`; `sel` dropped because selection is the URL).
- On first load without `mcs.ui.v3`, import the shared fields from a sanitised `ccm.prefs.v1` once. Never write `ccm.prefs.v1`.
- Pre-paint `theme-init.js` reads `mcs.ui.v3`, falling back to `ccm.prefs.v1`.
- Every storage access is wrapped; failures fall back to in-memory defaults (legacy tests carried over).

## Consequences
- Existing theme/density/kinds survive the switch; rolling back to the legacy UI loses nothing.
- Changes made in the new UI are not visible to the legacy UI (acceptable: it is the fallback).

## Alternatives rejected
- Reuse `ccm.prefs.v1` with extra fields: the legacy UI would delete them.
- Ignore legacy prefs: needless reset for existing users (research risk 12).

## Evidence
- `src/frontend/modules/prefs.js` (key, `VALIDATORS`, `sanitize` rewrites `data` on `set`), read 2026-10-11.
- `docs/research/current-state-frontend.md` section 1.5 and risk 12; foundations D12 (default port 8765).
- Browser storage is per origin (scheme, host, port): same port means shared storage (web platform rule; no experiment needed).
