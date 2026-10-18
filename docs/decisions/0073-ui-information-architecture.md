# 0073 UI information architecture: Overview is the landing page, one shell, built pages only

Status: Proposed (V4, milestone M6). Owner: UI (`packages/web`). Amends ADR 0030 (route table: landing page, new `/search` route, tab
names) and ADR 0033 (the top bar shows one live control; the three signals and the stale-data rule are unchanged). Replaces the shell
description in `docs/design/04-ui.md` sections 4.1 and 4.4 (sidebar, top bar, session tabs, default columns) and section 6.3
(responsive rules). Follows ADR 0071 (visual system) and ADR 0072 (languages).
Planned for a later 4.x release.

## Context
At the V3 head only `/sessions` and `/sessions/:id` are built; `/`, `/activity`, `/tasks`, `/analytics` and `/settings` render a
placeholder, and five of six menu entries lead to it. `/` is the first page a user sees. The session list sits in a 380 px sidebar and again
in the main area with a second filter box; the top bar has five outlined buttons and two chips; the detail tabs are links with
`role="tablist"` and no arrow keys. The owner's decision is that the landing page is an Overview of many sessions (attention strip,
running sessions, token figures, task panels) with drill-down to session detail, and that the whole backlog is built. The UI review
questions Q1 (many runs or one session), Q2 (is Overview required), Q3 (Working vs Running), Q7 (density control) and Q11 (small screens)
need a recorded answer.

## Decision
1. **Primary job.** Monitor many unattended runs first (answer Q1), then read one session deeply. `/` shows what needs attention in five
   seconds; `/sessions` is the full list; `/sessions/:id` is the deep view.
2. **Pages.** All seven are built before M6 closes: Overview `/`, Sessions `/sessions`, Session detail `/sessions/:id`, Activity
   `/activity`, Tasks `/tasks`, Analytics `/analytics`, Settings `/settings` (sections `health`, `config`, `preferences`, `data`,
   `about`), plus Search `/search` when `instance.features.transcriptSearch === 'instance'`. No placeholder page remains; every page has
   an instructive empty state (Tasks explains how work items are declared; Analytics explains that token numbers come from transcripts).
   `/health` keeps redirecting to `/settings?section=health`, so no link dead-ends.
3. **Navigation.** The nav is generated from the route table and lists a page only when its component is registered (R-01 stays true if a
   page is ever unregistered). Order: Overview, Sessions, Activity, Tasks, Analytics, Search (conditional), then Settings at the bottom.
   Counts: Sessions = active sessions (the `sessions.active` overview metric), Settings = open alerts (`overview.alerts.open`, shown only
   when above zero), each with a visible unit ("3 active"), never a bare number. Tasks has no count: it would need the whole board on every
   page (the review also asks to drop the unused count keys).
4. **Shell.** Top bar 48 px: instance title, one **Live** control, a refresh icon button, one user menu. Sidebar 240 px from 1200 px; a
   56 px icon rail from 900 to 1199 px; below 900 px the navigation is a menu sheet opened from a one-line Menu bar directly under the top bar (state in the
   existing `navOpen` preference), so the top bar itself stays within two rows at 600 px. The session list is not shown on `/sessions`; on `/sessions/:id` at 1200 px and above the sidebar shows a compact
   switcher (active sessions and sessions with errors, no filter box, current session marked). The filter box, the "Show unmatched"
   checkbox and the "All sessions" link of the old sidebar are removed.
5. **Live control.** One chip (dot plus word) whose colour is the worst of connection and ingestion, opening a popover with sections
   Connection, Ingestion, Server and Errors, each with its own status dot (answer to ADR 0033's two chips: the signals stay separate in
   the popover, the bar shows one). "updated Ns ago" appears only when data is stale. "Retry now" is the refresh button's label while
   disconnected. `/settings?section=health` stays the place for the long form.
6. **User menu.** Theme (auto, light, dark), Density (comfortable, compact; kept, answer to Q7, because it is cheap), Language (English,
   the Vietnamese name written in Vietnamese), Keyboard shortcuts. The language also appears in Settings > Preferences.
7. **Sessions list.** One filter row (search with `/`, multi-select state chip with counts, time range, "Only errors", "More filters (n)"
   popover, active filters as removable chips). An attention strip above the table has four toggle tiles (Working, Quiet (inferred), With
   errors, Waiting for input). Default sort stays Last activity descending (answer to Q6); "Attention first" is an option, applied on the
   loaded rows, because a live list must not reorder under the reader. Default columns: State, Session (label, 8-character id, model
   when it differs), Last activity, Errors, Output, Input; Project / task, Model, Started, Active span (renamed from Duration), Freshness
   are in the column chooser and hide themselves when every row is empty or equal. Model, Started and Active span hide below 1280 px.
   Below 900 px the table is a list of cards. The first column stays visible when a wide table scrolls.
8. **Session detail.** A compact header (a back link to Sessions, title, state dot and word, evidence line, copy link), four stat tiles
   (Active span, Last activity, Tokens, Errors), and a collapsed "Details" section that hides empty fields. Tabs are a `<nav
   aria-label>` of links with `aria-current="page"`; order Transcript, Errors, Agents, Tokens, Events (the old Timeline, URL value
   `events`, the value `timeline` is still accepted). The tab bar is sticky. The transcript must start above y = 300 px at 1440 x 900.
9. **Overview.** Attention strip; "Needs attention" (at most 5 sessions with their evidence line); "Running now"; token figures (Output,
   Input (new), Cache read, estimated cost only when prices are configured), each with source and rule in an info tip; recent errors;
   recent activity (compact feed with a link to `/activity`); ingestion summary; the workspace panels (Git, Machine, Attempts, Ledger,
   Chain log, Logs) in the right column from 1280 px, collapsible, collapsed by default below 900 px. A metric the server does not return
   is absent, never zero.
10. **Small screens (answer to Q11).** 600 px is supported and tested; below it the layout may degrade but never breaks the page width.
    Phones are not a target.
11. **Default theme (Q12)** stays `auto`. The state vocabulary decisions (Q3, Q4, Q5) are ADR 0074.
12. **Responsive contract (executable).** At 600, 1024 and 1440 px in both themes: no horizontal page scroll; at 1024 px no clipped
    column and no table row taller than 80 px; the number of Tab stops before the main content is at most 10; the first data row of the
    sessions table starts above y = 280 at 1440 x 900.

## Consequences
- The sidebar session list of the V3 UI, its filter preference (`filter`, `showAll`) and its ARIA grouping are retired; the switcher keeps
  roving tabindex and arrow keys. The V3 design asked for a Tasks count on the nav item; this ADR drops it.
- The default view of a fresh install is no longer the table, so the owner's dogfood check moves to the Overview.
- Hiding Model, Started and Active span below 1280 px means a column can be missing for a reader at 1024 px; the card layout and the
  column chooser are the way to reach them.
- Page code is lazy-loaded per route; the nav test depends on the registry, so a page that fails to register fails a test, not a
  production click.

## Alternatives rejected
- Keep `/` as a redirect to `/sessions` until Overview exists (the review's interim step): the owner decided Overview is the landing page.
- Hide Tasks and Analytics until they have real data (review section 4): the decision is to build everything; instructive empty states
  replace hiding.
- Merge health into the popover and remove the Health section: the popover is for a glance; the section holds history and the long form.
- A 64 px icon rail at all widths: labels help new users and the sidebar has few entries.
- "Attention first" as the default sort: rows would jump under the cursor.
- Rename "Turn ended" to "Waiting for you": it claims something the engine cannot know (ADR 0074).

## Evidence
- UI/UX review of 2026-10-12, sections 2 (R-01, R-04, R-05, R-06, R-07, R-08, R-09, R-11, R-18, R-19, R-23, R-24, R-32), 4 and 6 (planning
  artefact). V3 routes: `packages/web/src/app/routes.tsx` (placeholders), `packages/web/src/shell/SidebarNav.tsx`, `TopBar.tsx`.
- Overview data contract: `OverviewSchema` and `OVERVIEW_METRIC_KEYS` in `packages/shared/src/api/entities.ts`.
