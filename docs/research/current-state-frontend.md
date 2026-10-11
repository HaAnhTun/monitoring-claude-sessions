# Current state: vanilla-JS frontend, tests and tools

Audit date: 2026-10-11. Branch `feat/v3-node-runtime` (tag `pre-v3-python` marks the old state). Read-only audit: nothing under `src/`, `template/`, `config/`, `tests/`, `reference/` or the existing `docs/*.md` was changed.
Sources are given as `file:line`/file names or as a command with its observed result. Paths are relative to the skill folder. No transcript content was inspected (code and fixtures only).

Files read: `src/frontend/index.html` (201 lines), `styles.css` (379), `app.js` (799), `modules/*.js` (11 files), `icons.svg` (162), `tests/frontend/*.test.mjs` (4 files), `tests/tools/screenshots.mjs` (76), `tests/tools/demo.py` (152), `docs/ui-decision-record.md`, `docs/troubleshooting.md`; also `docs/api.md` and `config/defaults.json` for API and poll defaults.

Test run: `node --test tests/frontend/*.test.mjs` from the skill folder: `tests 37, pass 37, fail 0, cancelled 0, skipped 0, duration_ms ~252`. Per file (counted from `test(` declarations): filters-timeline 16, format 7, markdown-safety 5, prefs-api 9 = 37.

Architecture in one paragraph: a static page (`index.html`, `__TITLE__` placeholder replaced by the Python server), one ES-module entry `app.js`, 11 modules, one stylesheet, one SVG sprite. No build step, no framework, no network resources. All page state is one object `S` (`app.js:22-43`); DOM is updated imperatively with `el()` helpers. A debug handle `window.__ccm = { api, state, timeline, pollers }` is exposed in `boot()` (handy for E2E).

---

## 1. UI inventory

### 1.1 Page structure (index.html)

| Region | Id / selector | Content |
|---|---|---|
| Skip links | `.skip-link` x2 | "Skip to timeline", "Skip to session list". Click handler calls preventDefault so the `#sid=...` hash is kept (`app.js`, skip-link loop). |
| Top bar | `#topbar` | `h1#app-title` + `#task-name` ("Task: NAME"); health group; prefs group. |
| Health group | `role=group` "Monitor connection and data freshness" | `#health-status` chip (`data-status` connecting/ok/reconnecting/lost, icon + text), `#health-age` ("updated 12s ago" / "not updated yet"), `#stale-badge` (hidden unless stale: "STALE: no update for Ns"), `#health-error` ("name: message"), `#retry-btn` (label "Refresh", or "Retry now" when failing; `is-loading` while any poller runs), `#health-details-btn` (aria-expanded). |
| Prefs group | `role=group` "Display preferences" | `#theme-toggle` (auto -> light -> dark -> auto; label "Theme: X"; sun/moon icon), `#density-toggle` (comfortable <-> compact), `#shortcuts-btn` (opens dialog). |
| Health details | `#health-details` (hidden) | Per-endpoint "name: ok 3s ago; N failures in a row, last: msg"; monitor line (version, pid, uptime, config source, transcripts folder found/NOT found, reader stats); server-side error list (newest first); "Last config change". |
| Sidebar | `aside#side` (width `--side-w` 380px) | Sessions nav, then six collapsible panels. |
| Sessions nav | `#sessions-nav` | `h2`, `#sessions-window` ("Sessions touched in the last N h"), `#session-filter`, `#show-all` ("Show unmatched sessions"), `#session-list` (aria-busy), `#empty-state`. |
| Panels | `#panel-overview` (config key `git`), `-machine`, `-attempts`, `-ledger`, `-chain` (`chain_log`), `-logs` | Each: `h2 > button.panel-toggle` (aria-expanded, aria-controls), `.panel-status` line, `.panel-body.dim-when-stale`. Shown only if `config.panels[key]` is truthy. |
| Main | `main#main` | `#session-info`, `#partial-banner`, `#timeline-status`, toolbar, `#search-results`, timeline frame. |
| Toolbar | `role=search` | Row 1: `#search-input` ("Search events ( / )"), `#search-whole`, `#tool-filter` select, `#errors-only`, prev/next error. Row 2: `#kind-filter` fieldset (5 checkboxes built in JS), `#newest-first`, `#follow-toggle`, `#jump-form` (`#jump-input` + Go). Then `#timeline-count` (role=status). |
| Timeline | `#timeline` (tabindex 0, role=region "Session events") | `#timeline-load-older`, `ol#timeline-list`, `#timeline-empty`; floating `#resume-follow`. |
| Feedback | `#live-region` (sr-only, role=status, polite, atomic), `#toast` (2.5 s), `dialog#shortcuts-dialog` | |

### 1.2 Views and panels (data source -> rendering)

| Panel / view | Endpoint | Content (`modules/panels.js`, `sessions.js`) |
|---|---|---|
| Session list | `/api/sessions?all=0\|1` | Groups in fixed order "Running now", "Idle", "Completed & failed", "Unknown" (`GROUPS`). Session button: label, state badge (icon + word), `state_evidence`, meta line (age, size MB, subagent count), pending tool-call line, token line, "partial history" badge. Subagents grouped by workflow ("Subagents" first, then "Workflow NAME"), collapsible with count + per-state summary; auto-collapsed when more than 30 agents (`LAZY_AGENT_THRESHOLD`), 100 per page with "Show N more" (`AGENT_PAGE`). |
| Session info bar | from list | Title (`label` or `label / agent`), state badge + evidence, token line (+ "(incl. subagents)"), usage badge, models, turns, "not in list" badge, "Copy link". |
| Overview (git) | `/api/overview` | `dl` branch + uncommitted count; "STOP file present" alert (role=status); last commits. |
| Machine | `/api/machine` | RAM and CPU `role=meter` bars with text value and "high" badge above 90%; watched-process table; Docker list. |
| Attempts | `/api/attempts` | Table part / # / model(/effort) / took / result badge / out tokens, newest first; row or part button opens that session. |
| Ledger | `/api/overview` (`ledger`) | Markdown-table lines parsed to a table; PASS-like cells -> COMPLETED badge, FAIL/BLOCKED/ERROR -> FAILED badge (`OK_RE`, `BAD_RE`). |
| Chain log | `/api/overview` (`chain`) | `pre` tail; sticks to bottom only if user was within 8 px of it. |
| Live logs | `/api/logs` | Per file: name, "writing now" (age < 30 s) or "idle Nm", size, tail `pre`. |
| Shortcuts dialog | static | `dl` of keys in 1.4. |

### 1.3 Controls

Session filter (tokens ANDed over label/id/state/evidence; agents matched too; persisted); Show unmatched (persisted, re-polls with `all=1`); panel toggles (persisted); theme and density toggles (persisted); search box (150 ms debounce; Esc clears when non-empty); "Search whole transcript" (`/api/search`); tool select (options rebuilt only when the name set changes, keeps a selected name that vanished); Errors only; Prev/Next error; five kind checkboxes Prompts / Claude / Thinking / Tool calls / Results (persisted); Newest first (persisted; default true unless `ui.newest_first === false`); Follow new events; Jump form; Resume following (floating, "(N new)"); Load older (banner and edge button, 250 events); per-event copy buttons (event text, tool input, tool id, tool result) and `#N` buttons that copy the index; Show more/less for bodies over 1,500 chars (`CLAMP_CHARS`); Copy link.

### 1.4 Keyboard shortcuts (`app.js` keydown handler, dialog in index.html)

| Key | Action |
|---|---|
| `/` | focus and select the search box |
| `f` | toggle following (announces "Following new events" / "Follow off") |
| `]` / `[` | next / previous error (down / up the list) |
| `?` | open shortcuts dialog |
| Up / Down / Home / End | move through session list `[data-nav]` items (roving tabindex; Enter/Space select via native button) |
| Esc | closes dialog (native); clears search text when focus is in a non-empty search box |

Ignored when: default prevented; Ctrl/Meta/Alt held; target is TEXTAREA, SELECT or contentEditable; target is an INPUT of a text-like type (text, search, number, email, url, tel, password, date, time); the dialog is open.

### 1.5 URL, storage, polling

URL hash `#sid=<id>[&agent=<id>]`, both capped at 200 chars on parse (`prefs.js` `parseHash`/`buildHash`). Written with `history.replaceState` on selection; `hashchange` selects without rewriting; hash wins over the saved selection at boot. The page itself uses no query params.

localStorage: one key `ccm.prefs.v1`, JSON, validated per field (`prefs.js` `VALIDATORS`):

| Field | Validator |
|---|---|
| `theme` | auto / light / dark |
| `density` | comfortable / compact |
| `newestFirst`, `showAll` | boolean |
| `filter` | string <= 400 chars |
| `kinds` | object, keys subset of prompt/say/think/tool/result, boolean values |
| `collapsed` | object of booleans, fewer than 50 keys (panel key -> collapsed) |
| `sel` | `{sid <= 200, agent <= 200}` |

Unknown keys and wrong types are dropped on load; throwing storage or corrupt JSON degrades to in-memory defaults. Panel collapse default: collapsed when `(max-width: 899px)` matches, else open.

Polling (defaults `config/defaults.json:23`, overridable by `/api/config` `poll`; JS fallback in `app.js:25`):

| Poller | Interval | Notes |
|---|---|---|
| events | 1500 ms | cursor `after=<next>`; up to 3 chained fetches per run while `r.next < r.total`; aborted by selection generation |
| sessions | 6000 ms | `?all=0\|1` |
| machine | 2000 ms | only if panel on |
| logs | 3000 ms | only if panel on |
| overview | 5000 ms | shared by Overview, Ledger, Chain |
| attempts | 6000 ms | only if panel on |
| health | max(5000, overview_ms) | `/api/health` |
| task | 15000 ms (hard-coded) | `/api/task` |
| config | loop until first success | `nextDelay(2000, failures)`; Retry wakes the sleep |

`stale_after_ms`: 15000 in `config/defaults.json:23` but 20000 in the JS fallback `app.js:25` (mismatch, only matters before config loads). Fetch timeout 8000 ms (`api.js`). Backoff: `min(30000, max(1000, interval) * 2^min(failures,12))`; success returns to the normal interval. A `setInterval(1000)` re-renders health and calls `timeline.tick()` (live tool durations; time tooltips refresh every 30 ticks).

### 1.6 Freshness, health and the stale bar

`computeHealth` (`health.js`) looks at core endpoints: `config` until it loads, then `health` + `sessions`, plus `events` when a session is selected.
- `connecting`: no core endpoint has succeeded or failed yet. `ok`: none failing. `reconnecting`: some failing but not "down". `lost`: a failing endpoint with no success ever and >= 3 failures, or last success older than `stale_after_ms`.
- `stale`: age of the OLDEST core success > `stale_after_ms` -> STALE badge.
- `body[data-stale] = stale || lost`; CSS dims `.dim-when-stale` to opacity 0.6 (last good data stays visible, never blanked).
- Chip text: "Connecting...", "Monitor connected", "Reconnecting (retry in Ns)", "Connection lost (retry in Ns)"; countdown from the soonest `pollers[n].state.nextAt`.
- Transitions are announced once via the live region (lost, restored, not responding, stale, up to date); a newer server-side error in `/api/health.errors` is announced.
- Page title `"<N> running, <M> failed - <title>"`, or `"Monitor offline - <title>"` when lost (`titleFor`).
- Per-panel status line: "Could not refresh: MSG. Showing data from Ns ago." / "Could not load: MSG." / "Stale: no update for Ns."; panel gets `is-stale` (body opacity 0.55).
- State-change announcements after each sessions poll: up to 3 "label: FROM to TO", else "N sessions changed state".

### 1.7 Partial, stale, error and empty states

| State | Trigger | Rendering |
|---|---|---|
| Booting | before config + first polls | `body.booting .layout {visibility:hidden}`, class removed 700 ms after boot |
| Sessions loading | `S.sessions === null`, no failure | spinner + "Loading sessions...", `aria-busy=true` |
| Sessions error | first load failed | red banner "Could not load sessions: MSG. Retrying automatically." |
| Sessions empty | list is `[]` | `#empty-state`: three likely causes; "Likely here:" flag when `transcripts_dir === false`, or when no rule matched and Show-unmatched is off; mentions `window_hours` |
| Filter matches none | text filter | `No session matches "X"` + "Clear filter" link-button |
| Partial history | events response `partial` | `#partial-banner` (role=status): "Showing only the latest events (N MB of older history not loaded)" + Load older (disabled, with tooltip, when none) |
| Events refresh error | `api.status('events')` failures | `#timeline-status`: 404 -> "The monitor does not know this session ..."; else "Could not refresh events: MSG. Showing the events loaded earlier." |
| Transcript reset | `r.total < meta.next` | `ingest` returns `needsReset`; timeline reset, toast "The transcript was reset; reloading events", refetch |
| Timeline empty | none selected / loading / no events / all filtered | "Select a session to see its events." / "Loading events..." / "No events recorded for this session yet." / "No events match the current filters." |
| Not in list | selected id missing from sessions | "not in list" badge; events still load |
| Token completeness | `usage.complete === false` or `completeness.usage` partial/unavailable | badge "lower bound" (tooltip "scan N% complete") or "not available" |
| Count line | every sync | "Showing V of U loaded items · N errors · events #A to #B of TOTAL" |
| Search results | whole-transcript search | rows `#i  HH:MM:SS  Kind name  snippet`; notes for `truncated` and `partial` |

### 1.8 Timeline behaviors

- Pairing (`timeline-model.js` `pairEvents`): events `{i, k, t, id, text, name, summary, input, err}`, `k` in prompt/say/think/tool/result. A tool unit takes the result with the same `id` (first result per id wins). Status `active` (no result) / `completed` / `failed` (`result.err`). A result whose tool is not loaded is an orphan unit; orphans are dropped when the tool arrives later (older events loaded).
- Plain events: head with kind icon + label, error badge, `#i` copy button, time, copy text. Body rendered through the safe markdown subset for prompt and say, raw text for think and result. Think is italic muted.
- Tool unit: `<details class="tool">`, status pill (icon + "running 12s" / "ok 3s" / "failed 3s"), name, one-line summary, `#i`, time. Open state kept per `sid|agent|key` in a Set so it survives updates. Body: copy input / tool id / `#i`, pretty-printed JSON input (raw fallback), result block "Result" or "Result: error" (4 px left border when error).
- Durations: `toolDurationSec` (result time minus call time, or now minus call time while active); running ones tick every second.
- Rows are created once and updated in place (`rows` Map keyed `e<i>`); only tool rows whose signature `kind|status|resultIndex` changed are updated; `order()` reorders DOM with minimal moves; filtering sets `hidden`, it does not remove.
- Ordering: newest first (default) or oldest first; the Load-older row moves to the far edge; Resume-follow sits at `data-edge` top or bottom accordingly.
- Follow state machine (`followReducer`): scrolling away from the latest edge turns follow off with `away`; scrolling back resumes only if it was turned off by scrolling; explicit toggle/off never auto-resumes; `unseen` counts new events while off; `resume`, `reset`. Edge tolerance 24 px (`atLatestEdge`).
- Scroll anchoring when not following: `captureAnchor` stores the first visible row + offset, `restoreAnchor` restores it after merges, filters, reorders; scroller has `overflow-anchor: none`. When following, each sync snaps to the latest edge.
- Filters (`unitVisible`): kind checkboxes (a tool unit shows if Tools is on, or Results is on and it has a result); tool-name filter and errors-only hide non-tool kinds (orphan results are filtered by `err`); text query matches lower-cased `text|name|summary|input` of tool + result. `hide-result` class hides result blocks when Results is off.
- Error stepping: `stepError(keys, cursor, dir)` over visible error units in DISPLAY order, no wraparound; cursor resets when filters change; announces "Error P of T" or toasts "No more errors in that direction" / "No errors in the loaded events".
- Jump: `parseJump` -> `/api/locate?sid&agent&i|ts` -> if the index is not loaded, fetch a window `after=max(base, i-15)` and `replaceWindow` (bumps generation, follow off) -> `jumpTo(i)`. A hidden target clears search/tool/errors filters and toasts. Target row gets `is-target` outline, focus, `scrollIntoView({block:'center'})`; a tool row opens if the jump hit its result index or it failed.
- Load older: `/api/events?before=<first>&limit=250`, merged without moving the poll cursor; announces "Loaded N older events".
- Whole-transcript search: `/api/search?sid&agent&q&kinds&tool&errors&limit=200` mirrors the filters (`searchQuery`); requires text or an active filter; a sequence counter and the generation guard drop stale responses; closing returns focus to the button.
- Stale-response guard: `timeline.gen` increments on `reset` and `replaceWindow`; every async path compares it before applying.

### 1.9 Markdown and DOM safety rules

- Markdown subset only: fenced code (``` or ~~~, language label = first token, max 24 chars), inline code, paragraphs. No links, emphasis or HTML (`markdown.js`). Output uses `createElement` + `textContent`/`createTextNode`; tags used are only div, p, pre, code, span.
- No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, `srcdoc` anywhere in `app.js` or `modules/*.js`; enforced by the source-audit test in `tests/frontend/markdown-safety.test.mjs`. Attributes are set only from constants (the fake node in the test has no `setAttribute`).
- The same test asserts index.html has `<title>__TITLE__</title>`, local stylesheet and module-script links, and no `http(s)://` string.
- Prefs store only display state (`prefs.js` header). `sel.sid` is stored; no prompts or paths.
- Server (docs/api.md): loopback only; Host must be 127.0.0.1 / localhost / ::1 else 403, which the page maps to "open this page via 127.0.0.1 or localhost" (`describeFailure`).

### 1.10 Accessibility features

Skip links (hash-preserving); landmarks (`header`, labelled `aside`, `nav` labelled by `h2`, `main`, `role=search` toolbar, regions for timeline and logs); icons `aria-hidden` and paired with text or `aria-label`; status never colour-only (icon + word on every badge; meters have text and `aria-valuetext`); `:focus-visible` ring 2 px `--focus`; roving tabindex + arrows/Home/End on the session list with focus restored by `data-key` after re-render; polite live region (clear, then set after 30 ms so repeats re-announce); toast also announced; native `<dialog>`; `aria-expanded` on panel/group/details toggles, `aria-busy` on the list, `aria-current` on the selected session; tables have `caption.sr-only` and `th scope=col`; `<time datetime>` with ISO + relative tooltip; `prefers-reduced-motion` disables animation; `forced-colors: active` rules; `color-scheme: light dark`; compact density keeps control min-height `calc(30px*var(--d)+6px)` (about 25.5 px, meets the 24 px target in `docs/ui-decision-record.md`); live updates never steal focus.

---

## 2. Features that MUST survive a React rewrite

UT = unit test (Vitest, pure TS), CT = component test (Testing Library), E2E = real browser against the demo project (section 5).

| # | Feature | How to test |
|---|---|---|
| 1 | Hash `#sid=&agent=`: select, round trip, hash beats saved selection, `hashchange` without rewrite, 200-char cap | UT port `parseHash/buildHash`; E2E open URL with hash, assert `aria-current` |
| 2 | Prefs validation, corrupt JSON, throwing storage, key `ccm.prefs.v1` kept | UT port 3 prefs tests; E2E reload keeps theme/density/kinds/collapsed |
| 3 | Theme cycle + density toggle, `data-theme`/`data-density` on `<html>`, labels, icon swap | CT click -> attribute; E2E screenshots dark/light/compact |
| 4 | Poller + backoff (base doubles, cap 30 s, floor 1 s, reset on success, single in-flight, coalesced trigger) | UT port backoff + poller tests with fake timers |
| 5 | API client: 8 s timeout, kinds network/timeout/http/parse, per-endpoint lastSuccess/lastError/failures, messages (403 mentions 127.0.0.1) | UT port 3 api tests; add parse + abort cases |
| 6 | Health model thresholds, stale by OLDEST core success, title text | UT port `computeHealth`, `titleFor`; CT health bar from injected records |
| 7 | STALE badge, dimming (not blanking) of last good data, retry countdown, "Retry now", details panel | CT with fake clock; E2E offline capture |
| 8 | Live announcements (connection, stale, state changes max 3 + summary, server error, theme/density, follow, jump, older loaded, "Error N of M") | CT assert `role=status` text after each action |
| 9 | Session list: group order, text filter (tokens AND, agent-only match keeps matching agents), workflow groups, lazy collapse >30, page of 100, summary, evidence, token line, usage badges | UT port `session view`, `groupAgents`; CT lazy/"Show more"; E2E demo F |
| 10 | List keyboard: roving tabindex, arrows/Home/End, focus kept across re-render | CT userEvent; E2E |
| 11 | Auto-select first RUNNING else first session | UT on a selector function |
| 12 | Loading / error / empty / "no match" session states and causes text | CT per state |
| 13 | Global shortcuts `/ f ] [ ?` with the ignore rules | CT keyboard events on each target type |
| 14 | Pairing, orphans, late tool, status, signature, error units, durations | UT port 4 timeline-model tests |
| 15 | `mergeEvents` (append fast path, dedupe, olderAdded, incoming wins) | UT port |
| 16 | Follow reducer + `atLatestEdge` | UT port both |
| 17 | Scroll anchoring when not following (new events, filter change, order flip) | E2E measure row offset before/after a poll; jsdom cannot |
| 18 | Newest/oldest order, load-older row placement, resume button edge | CT order of `li`; E2E |
| 19 | Filters (kinds, text, tool, errors-only, `hide-result`) and `searchQuery` mirror | UT port; CT toolbar |
| 20 | Tool dropdown rebuilt only when names change; keeps vanished selection | CT |
| 21 | Error stepping order, no wrap | UT port; E2E shot 03 |
| 22 | Jump parsing and flow (window replace, filter clearing, `is-target`, tool opens) | UT port `parseJump`; CT with mock api; E2E `#N` and `HH:MM` on demo B |
| 23 | Whole-transcript search incl. stale-response guard and truncated/partial notes | CT with delayed mocks; E2E shot 04 |
| 24 | Tool `<details>` open state survives updates | CT: open, push update, assert still open |
| 25 | Clamp at 1,500 chars + Show more/less (`aria-expanded`) | CT |
| 26 | Safe markdown: parse cases, hostile input rendered as text, no HTML sinks | UT port 4 markdown tests; CT render of `<img onerror>`; replace the source audit with an ESLint ban on `dangerouslySetInnerHTML` plus a grep test |
| 27 | Partial banner, load older, "transcript reset" refetch, 404 message | CT; E2E shot 05 |
| 28 | Panels: config-driven visibility, persisted collapse, narrow default collapsed, per-panel stale line, ARIA meters, ledger parse, attempts click-through, log tail stick-to-bottom | CT per panel; E2E |
| 29 | Copy buttons (clipboard + textarea fallback), Copy link | CT with mocked clipboard / `execCommand` |
| 30 | Responsive: one column under 900 px, no horizontal page scroll, tables scroll inside wrapper | E2E at 1440 and 390 px |
| 31 | Only same-origin requests, no external fonts | E2E fail on non-same-origin requests; scan built HTML |
| 32 | A11y: skip links, focus ring, reduced motion, forced colors, live region | E2E with axe-core (new, not in current suite) |
| 33 | `document.title` with running/failed counts and offline | CT |
| 34 | Boot: layout hidden until config + first polls | E2E compare before/after screenshot (how to measure shift: UNVERIFIED) |

---

## 3. Design-token inventory (ready to port)

Source: `src/frontend/styles.css:4-102`. System font stacks only. Mechanics: `data-theme="auto|light|dark"` and `data-density="comfortable|compact"` on `<html>` (initial `auto`/`comfortable`, from prefs, then config `ui.theme`/`ui.density`). Compact sets `--d: 0.65; --lh: 1.35` and all spacing tokens and control min-heights multiply by `--d`. `auto` uses `@media (prefers-color-scheme: dark) { :root[data-theme="auto"] {...} }` (a full duplicate of the dark block); explicit `light`/`dark` override it.

Breakpoint: one, `max-width: 899px` (single column; `body` leaves `100vh`; sidebar stops scrolling independently; `.main` min-height 100vh; timeline `min-height 60vh; max-height 80vh`; search input full width; `.prefs` margin-left 0). Panels default collapsed below it (JS media query). Other media queries: `prefers-reduced-motion: reduce`, `forced-colors: active`.

```css
:root {
  color-scheme: light dark;

  /* spacing (multiplied by density factor --d) */
  --d: 1;
  --sp-1: calc(2px * var(--d));
  --sp-2: calc(4px * var(--d));
  --sp-3: calc(8px * var(--d));
  --sp-4: calc(12px * var(--d));
  --sp-5: calc(16px * var(--d));
  --sp-6: calc(24px * var(--d));

  /* type */
  --fs-xs: 0.75rem;
  --fs-sm: 0.8125rem;
  --fs-md: 0.875rem;
  --fs-lg: 1rem;
  --fs-xl: 1.25rem;
  --lh: 1.5;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;

  /* shape and motion */
  --radius-sm: 4px;
  --radius: 8px;
  --radius-lg: 12px;
  --border-w: 1px;
  --t-fast: 120ms ease;
  --t-med: 200ms ease;
  --side-w: 380px;
}
:root[data-density="compact"] { --d: 0.65; --lh: 1.35; }

/* light (default) */
:root, :root[data-theme="light"] {
  --bg: #f6f6f8;  --surface: #ffffff;  --surface-2: #eeeef2;
  --border: #d6d6de;  --border-strong: #a9a9b6;
  --text: #1b1b21;  --text-muted: #55555f;
  --accent: #1d4ed8;  --accent-contrast: #ffffff;  --focus: #1d4ed8;
  --shadow: 0 1px 2px rgb(20 20 30 / 0.08), 0 4px 12px rgb(20 20 30 / 0.06);
  --running-fg: #1d4ed8;   --running-bg: #e2eaff;
  --idle-fg: #474752;      --idle-bg: #e9e9ee;
  --completed-fg: #0a6340; --completed-bg: #dcf3e8;
  --failed-fg: #b01e12;    --failed-bg: #fde5e2;
  --unknown-fg: #6b21a8;   --unknown-bg: #f0e6fb;
  --stale-fg: #7c3f00;     --stale-bg: #fdecc8;
  --partial-fg: #8a3100;   --partial-bg: #ffe6d2;
  --ok-fg: #0a6340;        --ok-bg: #dcf3e8;
}
/* dark: this block under :root[data-theme="dark"], and again inside
   @media (prefers-color-scheme: dark) { :root[data-theme="auto"] { ... } } */
:root[data-theme="dark"] {
  --bg: #111216;  --surface: #1a1b21;  --surface-2: #24252d;
  --border: #353641;  --border-strong: #5a5b6a;
  --text: #e9e9ef;  --text-muted: #a3a3b1;
  --accent: #8aaaff;  --accent-contrast: #101218;  --focus: #a9c0ff;
  --shadow: 0 1px 2px rgb(0 0 0 / 0.5), 0 4px 12px rgb(0 0 0 / 0.35);
  --running-fg: #9db9ff;   --running-bg: #1b2850;
  --idle-fg: #bcbfca;      --idle-bg: #2b2d36;
  --completed-fg: #74dca8; --completed-bg: #12331f;
  --failed-fg: #ff9e92;    --failed-bg: #421a17;
  --unknown-fg: #cbaeff;   --unknown-bg: #2e2147;
  --stale-fg: #f6c56e;     --stale-bg: #3b2a0e;
  --partial-fg: #ffb98a;   --partial-bg: #3d2211;
  --ok-fg: #74dca8;        --ok-bg: #12331f;
}
```

Semantic mapping to keep: state classes `st-running|idle|completed|failed|unknown`; tool statuses `st-tool-active|completed|failed` (reuse running/completed/failed pairs); tags `tag-running|idle|failed|partial|unavailable`; chips `data-status` ok/connecting/reconnecting/lost plus `chip-stale`. Base: `html` 16px, body `var(--fs-md)/var(--lh) var(--font)` (14px), `.mono` adds `font-variant-numeric: tabular-nums`. Icon `1.1em`, stroke `currentColor`, fill none. Badge: pill (999px), `--fs-xs`, weight 600, 1px currentColor border. Focus ring `2px solid var(--focus)`, offset 2px. Control min height `calc(30px * var(--d) + 6px)`.

Layout constants worth keeping: sidebar 380px; timeline min-height 240px; event body clamp `max-height 14em` with mask fade; code block 28em; field pre 20em; log 12em; search results 30vh; meter height 8px; toast bottom `--sp-6`.

Icons (`icons.svg`, 30 `<symbol id="i-NAME">`, Tabler Icons v3.49.0 outline, MIT; from `grep -o 'id="i-..."'`): running, idle, completed, failed, unknown, search, copy, refresh, chevron-down, chevron-right, arrow-up, arrow-down, alert, sun, moon, density, tool, user, bot, filter, x, check, clock, help, wifi-off, layers, cpu, git-branch, keyboard, link. Used as `<svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-NAME"/></svg>`. `filter` and `cpu` are unused: a grep of `src/frontend` (excluding icons.svg) finds no `i-filter` or `i-cpu` reference (verified 2026-10-11). Tabler v3.49.0 is stated in `icons.svg:5`.

---

## 4. Pure modules worth porting verbatim to TypeScript

All are DOM-free and tested under plain `node --test`. Port with types; keep logic and tests (convert asserts to Vitest `expect`).

| Module | Exports | Port notes | Existing tests to carry over |
|---|---|---|---|
| `filters.js` | `KINDS`, `KIND_LABELS`, `defaultFilters(ui)`, `unitText`, `unitVisible`, `hasActiveFilters`, `collectToolNames`, `searchQuery` | Uses a `WeakMap` text cache keyed by event object (keep or key by `ev.i`). Defaults: prompts off unless `ui.show_prompts`, thinking off unless `ui.show_thinking`, tools on unless `show_tools === false`, say and result on. | `filters: kinds, text, tool, errors only`; `searchQuery mirrors filters` |
| `timeline-model.js` | `pairEvents`, `unitSig`, `isErrorUnit`, `toolDurationSec`, `mergeEvents`, `initialFollow`, `followReducer`, `atLatestEdge`, `stepError`, `parseJump` | `followReducer` already fits `useReducer`; keep returning the same object when nothing changes (a test asserts identity) so React skips renders. Type event as `{i:number; k:'prompt'\|'say'\|'think'\|'tool'\|'result'; t:string; id?; text?; name?; summary?; input?; err?}`. Keep the `now` parameter of `parseJump`. | `pairEvents nests results...`; `failed tool when result has err; sig changes...`; `orphan result is dropped...`; `tool duration...`; `mergeEvents appends, dedupes...`; `follow state machine`; `atLatestEdge respects direction`; `stepError walks...` (unknown cursor falls back to first); `parseJump` (index, `12:30`, `25:00` null, ISO, garbage, empty) |
| `format.js` | `pad2`, `fmtClock`, `fmtAge`, `fmtRelative`, `timeTitle`, `fmtDuration`, `fmtBytes`, `fmtTok`, `tokenParts`, `tokenLine`, `usageBadge`, `plural`, `fmtMB` | Keep age thresholds (<90 s seconds, <5400 s minutes, <129600 s hours, else days). Token line "out X · new input Y · cache read Z"; the word "processed" must never appear (tested). `fmtClock` uses local time and no locale argument. | `fmtAge`; `fmtBytes / fmtTok / fmtDuration`; `fmtClock is local HH:MM:SS...`; `relative age and tooltip`; `token line ...`; `usageBadge`; `plural` |
| `prefs.js` | `sanitize`, `safeLocalStorage`, `createPrefs`, `parseHash`, `buildHash` | Wrap as a store hook (`useSyncExternalStore`); keep key `ccm.prefs.v1` and validators. | `prefs persist known keys and reject bad values`; `prefs survive storage that throws on read and write`; `prefs survive missing storage and corrupt JSON`; `hash round trip` |
| `poller.js` | `BACKOFF_CAP_MS`, `nextDelay`, `createPoller` | Injectable `setT/clearT/delayFn` make it testable with fake timers. If replaced by a query library, the same delay table must still be asserted. | `backoff: doubles, capped at 30 s...` (1500 -> 3000 -> 6000 -> 24000 -> 30000; 200 ms -> 2000 under failure; 60000 capped to 30000); `poller: failure schedules backoff and success resumes the normal interval` |
| `api.js` | `ApiError`, `describeFailure`, `createApi` | Keep per-endpoint tracking: the health bar and details list read the snapshot. `fetchImpl` and `now` injectable. | `api tracks last success / last error per endpoint...` (net, 404, junk, 500, then recovery); `api times out hanging requests`; `describeFailure for 403 mentions the host` |
| `health.js` | `computeHealth`, `countStates`, `normalizeState`, `titleFor` | Verbatim. | `computeHealth: connecting, ok, reconnecting, lost, stale`; `page title uses words, not emoji` |
| `markdown.js` (parser half) | `parseMarkdown`, `parseInline` | Port parser verbatim; replace `renderMarkdown` with a React component mapping blocks to `<p>`, `<pre><code>`, never raw HTML. | `parse: fences, inline code, paragraphs`; `unterminated fence, ~~~, empty input`; `hostile input never produces HTML`; `language label ...` |
| `sessions.js` (logic half) | `GROUPS`, `buildSessionView`, `groupAgents`, `stateSummary`, `stateMap`, `diffStates`, `LAZY_AGENT_THRESHOLD`, `AGENT_PAGE` | Render half (`renderSessionList`, `installListKeys`, roving tabindex) must be rewritten as components. | `session view groups by state, filters, and keeps agents`; `groupAgents: workflows, plain subagents, no cap, per-group summary`; `state change detection` |
| `panels.js` (logic bits) | `attemptState`; ledger parsing and `OK_RE`/`BAD_RE` inside `renderLedger` (not exported) | Extract ledger parsing into a pure function and add tests; panels have NO unit tests today. | none |

Not portable as is: `dom.js` (imperative helpers), `timeline.js` (imperative row cache with scroll anchoring; re-implement with keyed rows and a layout-effect anchor), `app.js` controller.

Coverage gaps: no automated test for `timeline.js`, session-list/panel rendering, `dom.js`, `app.js`; the screenshot tool is a manual capture script, not an assertion suite.

---

## 5. Demo project and capture tooling

### tests/tools/demo.py (usable for E2E)

Usage: `python tests/tools/demo.py OUTDIR` (default `demo-out`); prints JSON `{out, home, ids}` with generated session UUIDs for letters A-G. Imports the fixture builder `tests/fixtures/make.py` (`user`, `assistant`, `text`, `tool`, `result`, `write_jsonl`, `age`, `iso`, `build_home`...). All content is invented.

Creates under OUTDIR:
- `home/projects/demo/<uuid>.jsonl`: a fake `CLAUDE_CONFIG_DIR` with one transcript per session;
- `repo/logs/chain.log` and `repo/docs/status.md` (markdown ledger table);
- `demo.config.json`: title "Nightly build monitor", `window_hours: 8`, `session_rules` regex `STEP=([A-Z]):` labelled "build step X", panels machine/ledger/chain_log/attempts on and git/logs/docker off, `attempts` START/END regexes, `limits.event_window_mb: 0.2` (makes E partial), `port: 8860`.

Run (from the script docstring; NOT executed here because the owner's live monitor shares the machine): `CLAUDE_CONFIG_DIR=OUTDIR/home python template/viewer.py serve --config OUTDIR/demo.config.json`.

| Session | Scenario |
|---|---|
| A | completed (chain log PASS), 3 tool calls + final answer; also the compact-density shot |
| B | failed (chain log FAIL), two tool results with `is_error`; error stepping, search "Checkout" |
| C | running, last tool call still pending (active status, live duration) |
| D | idle, ended with `end_turn`, one tool |
| E | 420 `Edit` steps with ~400-char results; window limit 0.2 MB makes it partial (banner, Load older) |
| F | parent with workflow `wf-review` (`workflows/wf-review.json`) and four subagents (`agent-*.jsonl` + `.meta.json`; one still writing, three finished), pending `sleep 300` tool |
| G | tool call pending for over 30 minutes -> UNKNOWN |

Time handling: record timestamps are relative to "now" at build time and `M.age()` rewrites file mtimes (A 2400 s, B 1900, C 25, D 1500, E 300, F 20, G 2000; live agent 8 s, finished agents 400 s). States therefore drift with `active_seconds` / `pending_tool_grace_seconds` and with how soon the viewer starts; for deterministic E2E rebuild right before each run or inject a clock in the new backend.

For the Node platform: `home/` is plain Claude Code transcript layout and can be reused unchanged, but `chain.log`, `attempts` regexes and `session_rules` are Python-engine config concepts; the new config format must support them or the demo needs a new config. Hook-sourced data (new platform) is not represented by this demo at all.

### tests/tools/screenshots.mjs

`node tests/tools/screenshots.mjs http://127.0.0.1:8860 OUTDIR [chrome-path]`. No npm packages: spawns headless Chrome (`--remote-debugging-port` random 9340-9389, temp profile), talks DevTools protocol over the global `WebSocket` (Node 22+); default Chrome path `C:/Program Files/Google/Chrome/Application/chrome.exe`. Eleven captures: 01 overview dark, 02 overview light (session F, 1440x1000), 03 failed session errors (B, clicks `#next-error`), 04 search whole transcript (types "Checkout" in `#search-input`, clicks `#search-whole`), 05 partial banner (E), 06 health details (`#health-details-btn`), 07 keyboard shortcuts (dispatches `?`), 08 compact density (A, `#density-toggle`), 09 mobile sessions, 10 mobile timeline (390x844, DPR 2, `mobile: true`), 11 offline/stale (kills the viewer pid from `/api/health`, waits 19 s, so `stale_after_ms` must be below 19 s; restart the viewer afterwards). It clears `localStorage` before each scenario, selects sessions via `#sid=` hashes after resolving labels with `label.endsWith(' ' + letter)` from `/api/sessions`, and uses fixed sleeps (2.6 s per page open).
It depends on element ids and `/api` shapes, so a React UI must keep these hooks or the script must be ported to Playwright. Existing `data-testid` hooks: task-name, health-status, health-age, stale-badge, health-error, retry-btn, theme-toggle, density-toggle, session-filter, show-all, session-list, empty-state, partial-banner, search-input, tool-filter, errors-only, prev-error, next-error, kind-filter, newest-first, follow-toggle, timeline-count, search-results, timeline, resume-follow, live-region.

---

## 6. Migration risks (what is easy to regress)

1. **Scroll anchoring and follow.** The imperative timeline keeps rows alive and restores the first visible row's offset after every merge, filter or reorder (`overflow-anchor: none`). A keyed React list with newest-first and prepends will jump or fight browser anchoring; jsdom cannot test it. Also keep the 24 px edge tolerance and the `away` flag semantics (explicit off must not auto-resume).
2. **Re-render cost and state loss.** Only changed tool rows are touched today and `<details>` state lives in a Set. In React, 420+ events polled every 1.5 s can re-render everything: use stable keys (`e<i>`), memoised rows, `hidden` rather than unmount for filtered rows (keeps scroll, focus, open state). Virtualisation would break `scrollIntoView`, jump and anchor capture.
3. **Focus and live-region behaviour.** The session list restores focus by `data-key` after each re-render; React must not remount it. The live region relies on clear-then-set so identical messages re-announce; Strict Mode double effects can double-announce.
4. **Generation guards for stale async results** (selection change, search sequence, load-older, jump window) and the `needsReset` refetch loop (max 3 chained fetches). A query library needs the same "ignore if selection changed" semantics.
5. **Health is coupled to per-endpoint success/failure history**, not to a query library's own status. The bar, STALE badge, panel notes, retry countdown (`nextAt`) and title all read it. Any new polling layer must keep `lastSuccess/lastError/failures/nextAt`. Settle the `stale_after_ms` default (15000 vs 20000) in one place.
6. **Theme flash and `auto` mode.** Theme is applied from localStorage by JS after load today; a static React build can flash. Apply the attribute before first paint (inline script) and keep the duplicated `auto` dark block or use `light-dark()`.
7. **Density multiplier.** All spacing and control heights derive from `--d`; fixed utility classes would silently break compact mode and the 24 px target size. Keep tokens as CSS variables.
8. **Safety regressions.** The only guards are a source-grep test and a fake-DOM test. React makes `dangerouslySetInnerHTML` and third-party markdown renderers (links, raw HTML) easy to add. Keep "no links, no HTML", add an ESLint ban and the hostile-input component test.
9. **Clipboard.** There is a non-secure-context fallback (`execCommand`); keep it (127.0.0.1 over a tunnel is not a secure context in some setups; UNVERIFIED).
10. **Shortcut scoping** is easy to get wrong with React focus events (inputs, selects, open dialog, modifiers; `f` must not fire while typing in the session filter).
11. **Host/403 behaviour and no external requests.** A bundler can introduce CDN fonts, source maps or dev-server URLs; test the production bundle for same-origin requests only (today's test covers only the vanilla index.html).
12. **Persisted data compatibility.** Existing users have `ccm.prefs.v1`; changing key or schema resets theme/filters/collapsed panels. Shared `#sid=...&agent=...` links must keep working.
13. **Timezone-dependent formatting.** `fmtClock` and `parseJump("12:30")` use browser local time; tests must fix `TZ` and use fake timers. The existing `parseJump` test builds a local `Date`, so it is TZ-safe; the `fmtClock` test is TZ-safe too: it compares against local `getHours/getMinutes/getSeconds` of the same Date (`tests/frontend/format.test.mjs:32-34`).
14. **Thin coverage where regressions are likeliest.** No automated test of the rendered timeline, session list, panels or controller. Add component and E2E tests (demo project + Playwright, `getByTestId`/roles) BEFORE removing the old UI; the `data-testid` list in section 5 is the minimum selector contract.
15. **Time-dependent demo data** (relative mtimes) makes states drift; E2E needs a fresh build per run or an injectable clock.
16. **Python-served concerns that move to Node**: `__TITLE__` substitution, the `/static/` allow-list (no dotfiles, no `..`), and `/api/*` shapes (`docs/api.md`: clients ignore unknown fields; v1 fields unchanged). Keep shapes or version the API.
17. **Ledger and chain panels** parse free-form text (markdown table lines, PASS/FAIL words) in the browser; this logic is untested and easy to break when moved.
18. **Possible dead code** to decide on, only after a real usage grep: `filter` and `cpu` icons, `.banner-info`, `--fs-xl`, `--radius-lg` (used by the dialog only) (UNVERIFIED).

---

## Verification log (2026-10-11)

| Claim | Verdict | Evidence |
|---|---|---|
| 37 tests pass (16/7/5/9) | confirmed | re-ran `node --test tests/frontend/*.test.mjs`: tests 37, pass 37, fail 0; `^test(` counts 16/7/5/9 |
| `stale_after_ms` 15000 vs 20000 | confirmed | `config/defaults.json:23` = 15000; `app.js:25` = 20000 |
| Backoff, cap 30 s, fetch timeout 8 s | confirmed | `poller.js` `nextDelay` (cap 30000, base max(1000, interval), `2**min(failures,12)`); `api.js:26` `timeoutMs = 8000` |
| Health 15000 task / max(5000, overview) | confirmed | `app.js:671` and `app.js:678` |
| computeHealth states, stale by OLDEST success | confirmed | `modules/health.js` (`Math.min` of lastSuccess; lost = no success and >=3 failures, or age >= staleAfterMs) |
| Stale dimming opacity 0.6 | confirmed | `styles.css:273`; panel-level `is-stale` is 0.55 (`styles.css:209`) |
| Shortcut ignore rules | confirmed | `app.js:740-752` |
| Safety grep test and no http(s) in index.html | confirmed | `markdown-safety.test.mjs:79,88` |
| Icon sprite 30 symbols, Tabler v3.49.0 | confirmed | `grep -c '<symbol '` = 30; `icons.svg:5` |
| `filter` / `cpu` icons unused | corrected (was UNVERIFIED, now confirmed unused) | full grep of `src/frontend` |
| screenshots.mjs 11 shots, 19 s offline wait | confirmed | 11 `shot('` calls; `screenshots.mjs:74` |
| demo.py port 8860 | confirmed | `demo.py:144` |
| `fmtClock` test TZ-safe | corrected (was UNVERIFIED) | `format.test.mjs:32-34` |
| Privacy: no transcript text, emails, secrets in file | confirmed | regex scan for emails, user paths and key patterns found nothing; file cites code and invented demo data only |
