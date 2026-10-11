# 0038 Long lists: no virtualization library; cursor pages with `maxPages`, row caps, `content-visibility`

Status: Proposed (Phase 1, 2026-10-11). Owner: UI design (`docs/design/04-ui.md` sections 4.4.3, 5.3).

## Context
Session lists hold tens to hundreds of rows; transcripts and activity feeds can hold thousands of entries. The legacy timeline relies on
`scrollIntoView` for jumps, first-visible-row scroll anchoring and `<details>` state, which virtualization breaks (research risk 2).

## Decision
- No virtualization library.
- Server-side cursor pagination everywhere; `maxPages` bounds memory (sessions 10 x 100, activity 10 x 100, timeline 20 x 100); when
  the cap is reached the UI says so instead of dropping rows silently.
- Transcript window capped at 5,000 entries (reducer rule).
- Transcript and activity rows use `content-visibility: auto; contain-intrinsic-size: auto 72px`; filtered rows are `hidden`, not
  unmounted.
- Tables (sessions, usage) use the 1,000-row cap; no `content-visibility` on `<tr>`.

## Consequences
- Jumps, anchoring and focus restoration keep working with plain DOM.
- React render cost of large windows still needs measurement (open item O-2 in 04-ui with a budget and a fallback of a lower cap).

## Alternatives rejected
- react-window / TanStack Virtual: extra dependency, breaks `scrollIntoView`, anchoring and `<details>` state.
- Unbounded lists: memory and layout cost grow without limit.

## Evidence
- Experiment 2026-10-11, Chrome 155 (`D:/mvp/private/scratch/mcs-v3/ui/cv/cv.spec.mjs`): first layout 152 -> 41 ms (3,000 rows) and
  424 -> 138 ms (10,000 rows) with `content-visibility`; `scrollIntoView({block:'center'})` exact; prepend 50 rows with manual anchor
  restore: 0 px drift, 26.5 -> 2.1 ms (3,000) and 70.7 -> 9.8 ms (10,000).
- Experiment 2026-10-11 (`sc/sc.spec.mjs`): 5,000-row table, `content-visibility` on `<tr>` 275 -> 212 ms only, column widths stable.
- query-core 5.104.1 declares `maxPages?: number` (scratch types file).
