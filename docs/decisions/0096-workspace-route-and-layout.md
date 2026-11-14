# 0096 Workspace route and layout: `/` is the Workspace, the Overview moves to `/overview`, a full-bleed page with a project column

Status: Accepted (CAW, 2026-11-15). Owner: web foundation (WEB-FOUNDATION), design 04 sections 2, 5 and 9. Amends ADR 0073 decisions 2 (pages and
paths), 3 (navigation order), 4 (shell: the sidebar width and the session list) and 12 (responsive contract, the one measurement that names the
landing page). The rest of ADR 0073 stays: the Overview is still a page of the nav, the shell has one top bar and one live control, a page is
listed only when its component is registered, the compact session switcher stays on the session page (decision 4 of 0073), 600 px is supported.
Related: 0100 (the visual system and the `--list-w` token), 0097 (the terminal in the web bundle), 0098 (the browser side of the terminal
protocol), 0099 (mutating requests and the access flow). The Status lines of the amended ADRs are updated by the documentation package of the program.

## Context
CAW merges the terminal-panel product MTOP into this application. The owner decided (spec Q8) that `/` becomes the MTOP layout, with projects
and their sessions on the left and the real `claude` terminal on the right, and that the monitoring pages stay in the menu. Today `/` is the
Overview, the first page a person sees, and the page frame pads and scrolls its content like a document. A terminal cannot live in that frame:
it needs the whole height of the window, no page padding, and a width that is not shared with a 240 px sidebar more than it must be.

Three further facts shape the decision. A per-task instance (`instance.kind === 'task'`, ADR of the instance lifecycle) has no terminal: it is a
monitor for one task, and the Overview is the right landing page for it. The terminal must stay usable at 900 and 1024 px, where a second
column of 320 px leaves too few characters. And the project column is a list that people use with the keyboard, so its focus rules must not
fight the terminal's (ADR 0098).

## Decision
1. **`/` is the Workspace.** The route key is `workspace`, the component is lazy, and the title is the catalogue message `route.workspace.title`.
   The Overview keeps its component and its tests and moves to `/overview` (route key `overview`). The nav order is Workspace, Overview, Sessions,
   Activity, Tasks, Analytics, Search (conditional), Settings. Counts and the other rules of ADR 0073 decision 3 are unchanged; the Workspace
   entry has no count. `/#sid=...` bookmarks of the legacy UI still work, because the legacy hash redirect reads `/` and ignores the access
   fragment.
2. **A task instance keeps the Overview as its landing page.** The Workspace entry is listed only when the instance is a user instance (an unknown
   kind, before the instance is known, hides it), and `/` on a task instance redirects to `/overview`, so a bookmark of `/` lands somewhere useful.
3. **A full-bleed layout, declared by the route.** The route table gets one optional field, `layout: 'page' | 'bleed'` (default `page`). A bleed route
   has no page padding, the shell fills the height of the window and the page never scrolls; its `main` carries no stale outline (the monitor
   connection and the terminal socket are different connections, and the outline marks monitor pages only).
4. **The navigation sidebar is forced to the 56 px rail on a bleed route, behind one flag.** From 900 px the sidebar is a rail on `/`, whatever the
   window width, so the terminal gets the width (about 145 columns at 1440 px with a 320 px project column, against about 112 beside the 240 px
   sidebar). The flag is one constant (`FORCE_RAIL_ON_BLEED`); setting it to false restores the width rules of ADR 0073 decision 4 and nothing else
   changes (the `cols >= 80` contract from 600 px holds either way).
5. **A project column, an overlay below 1024 px.** From 1024 px the page has two columns: the project column (`--list-w` of ADR 0100: 320 px from
   1280 px, 280 px from 1024 px) and the terminal pane. Below 1024 px the column is an overlay that a button in the pane header opens and that a
   selection, Escape or a click outside closes. From 1024 px the same button folds the column away and back, and the choice is kept in the
   preference `workspaceCollapsed`; below 1024 px the overlay state is not kept.
6. **The selection is in the URL.** `/?session=<terminal name>`: the name follows the one pattern of the server (`TERMINAL_NAME_RE`: 1 to 64 of
   letters, digits, underscore and dash). Anything else is reported by key only and read as no selection. Selecting never changes the pathname,
   so the page chrome does not steal the focus from the terminal. A bare `/` restores the preference `lastTerminal` while that session still runs.
7. **The sidebar's rows come from one pure view model** (`lib/workspace-view.ts`), which joins the folder rows, the live terminals and the monitor
   rows: live folders first and the server order otherwise, so the list moves only when a live set changes (which the person causes; this is the one
   list that breaks the "never reorder under the reader" rule of ADR 0073 decision 7, and only for that reason); a session is never lost, an unknown
   folder becomes a synthetic row; MTOP's default of open when live or recently active, with the person's override kept per folder under a short
   hashed key (the preference `workspaceOpen`, at most 300 keys). The pane's state is one pure function with a fixed priority: locked, unavailable,
   loading, error, terminal, not-found, none-selected.
8. **The compact session switcher stays where it is** (`/sessions/:id` only). The Workspace column is a different list for a different job (start,
   open, stop and resume terminals) and is not reused on other pages.

## Consequences
- Every place that spells `/` as the Overview changes: the route table and its tests, the not-found page (its primary button opens `/overview`),
  the nav tests, the shell tests, the visual QA views. The package that moves the route owns that list (design 04 section 2.6).
- ADR 0073 decision 12 measures the first data row of the sessions table at 1440 x 900 and counts Tab stops before the main content; both are
  measured on `/sessions`, so they stay true. The Workspace has two extra skip links (project list, terminal), added by the shell package.
- The Workspace is a second place where sessions are listed. The two lists share the state words (the `state.*` catalogue keys) and the badge, not
  the component, so each can change without the other.
- The page needs the preferences `workspaceOpen`, `lastTerminal`, `workspaceCollapsed` and `terminalScreenReader`; each has a validator that
  drops a value of the wrong shape, so a corrupt store never breaks the page.
- The English and Vietnamese catalogues gain one block of about 150 messages for the whole area, written first so that no component carries text.

## Alternatives rejected
- **Keep the Overview at `/` and add the Workspace at `/workspace`.** The owner asked for `/` to become the MTOP layout; a second landing page would
  leave the product opening on the monitor and the terminal one click away.
- **Reuse the compact session switcher as the project column.** It lists sessions without folders, has no start, stop or resume action, and is
  built to be quiet; the Workspace list has the opposite job. One component for both would have to hide most of itself on each page.
- **A fixed 240 px sidebar beside the terminal.** At 1024 px that leaves about 60 columns for the terminal; the forced rail costs nothing the
  Workspace needs, because its own column is the navigation that matters on that page.
- **Reorder the list by activity as MTOP does not.** A list that reshuffles under the reader moves the button a person is about to press; live
  folders first is the smallest rule that keeps the sessions in view, and it moves only when a session starts or ends.
- **Store the selection in a preference only.** A URL can be shared, bookmarked and restored by the Back button; the preference is only the
  fallback for a bare `/`.

## Evidence
- `packages/web/src/lib/workspace-view.test.ts` (the join, the order, the row states, the filter, the default and the override of open, the
  pane priority with every adjacent pair of states), `src/lib/url-state.test.ts` (`?session=` and the key-only report),
  `src/lib/prefs.test.ts` (the four validators and the limit of 300), the catalogue tests `i18n/messages/en.test.ts`, `vi.test.ts` and
  `i18n/catalogue.test.ts`.
- Design `.dev/caw/design/04-web-terminal-page.md` sections 2, 5 and 9; MTOP `web/index.html` (the column, the live mark, the default of open),
  read-only reference `D:\mtop-main`.
- ADR 0073 (amended decisions), ADR 0100 (`--list-w`), ADR 0098 (keyboard ownership and the release chord).
