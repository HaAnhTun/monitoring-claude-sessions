# UI decision record: foundation for the session monitor page

Status: accepted for this iteration (2026-10-11). Final dashboard layout is NOT decided here.
Context: small, offline, no-build, Python-served local page with dense technical data (timelines, tool calls, token numbers).

## Hypothesis tested

Keep plain HTML/CSS/JS with a small custom design system on CSS custom properties, borrow Tabler dashboard
patterns (look, spacing, status colours) without importing the framework, and vendor only the Tabler Icons we use (MIT).

**Verdict: confirmed.** Nothing in the research contradicts it. The one partial surprise is that Pico CSS, the closest
"drop in one file" alternative, is documented by its own site as no longer maintained (see below).

## Options compared

Sizes measured 2026-10-11 from jsDelivr npm files (minified; gzip -9 computed locally). Versions and dates from the npm registry and GitHub releases API.

| | A. Custom CSS + Tabler Icons subset (chosen) | B. Tabler core | C. Pico CSS | D. Open Props (tokens) | E. Simple.css |
|---|---|---|---|---|---|
| Latest stable | icons v3.49.0 | @tabler/core 1.6.1 | 2.1.1 | 1.7.23 (GitHub release v1.6.0, 2023-09-29) | 2.3.7 |
| Last release | 2026-10-05 (icons) | 2026-09-28 | 2025-03-15 | 2026-01-31 (npm) | 2025-05-29 |
| Licence | MIT (icons, (c) Paweł Kuna); own CSS | MIT; bundled libs in `dist/libs` have own licences (ApexCharts is not MIT since v5) | MIT code, docs CC BY-SA 4.0 | MIT | MIT |
| Runtime size | own CSS (target under 20 KB) + sprite 10 KB (30 icons, measured) | CSS 635 KB (79 KB gz) + JS 135 KB (39 KB gz) | CSS 83 KB (11.6 KB gz), no JS | 29.6 KB (7.6 KB gz; docs claim about 4 KB brotli) | 9.4 KB (2.8 KB gz) |
| Maintenance | active (icons release roughly weekly) | active (commit 2026-10-10, semver, changesets) | its docs state "no longer maintained"; last release 2025-03 | slow; last npm release 2026-01 | sporadic, last release 2025-05 |
| Offline | yes, local files | yes after self-hosting dist files (CDN is the documented default) | yes, single file | yes, local files | yes, single file |
| Build step | none | none for CDN/self-host; npm import needs a bundler | none | none; custom media queries need PostCSS (skip them) | none |
| Fit for dense data | full control over row height, mono numerals | rich dashboard components, but heavy and Bootstrap-shaped | classless prose/forms feel, roomy spacing, weak for dense tables | tokens only, no components | classless blog look, not dashboard |

Other facts: Tabler Icons has 6,238 icons (5,184 outline), ships as individual SVGs, sprite package, webfont and framework packages.
Tabler core needs Chrome/Edge 123, Firefox 128, Safari 17.5 (it uses `light-dark()`, `color-mix()`, `:has()`, `@property`).
Tabler bundles Bootstrap 5 JS inside `tabler.min.js`; loading Bootstrap separately double-fires handlers.

## Trade-offs against the criteria (priority order)

1. Overhead: A is smallest and fully predictable; B is 50x larger than needed for one page; C/E add 3-12 KB gz but also impose element styling we would override.
2. No build / 3. Offline: all options can meet both; only A avoids vendoring a large third-party tree.
4. Modern professional look: Tabler's look is the reference; A reproduces its tokens (neutral greys, blue accent, 1px borders, soft radius) by hand.
5. Dense data: A can set 24-28 px rows, tabular numerals, sticky headers; B/C/E defaults are roomier and need overrides anyway.
6. Keyboard and responsive: with native elements (`button`, `details`, `table`) plus a visible `:focus-visible` ring it is achievable in any option. Tabler/Pico accessibility claims are not verified (Pico docs page has no accessibility statement; Tabler install page has none).
7. Easy for AI agents to edit: one small CSS file with named tokens is easier to edit safely than overriding a 635 KB framework cascade.
8. Migration risk: low, no existing framework to remove; icons are additive.
9. Maintainability/licence clarity: one MIT dependency (icons) with a pinned tag; no framework upgrades to track.

Cost of A: we own the CSS (about a day of work), no ready-made components, and we must test contrast and focus ourselves.
Rejected: B (size, Bootstrap coupling, ApexCharts licence note, modern-CSS minimums), C (unmaintained per its docs, roomy styling), E (blog look), D (tokens only; we write a few dozen variables ourselves, adding a dependency for little gain; could be revisited as a reference for easing/shadow scales).

## Selected approach

- Plain HTML + CSS + vanilla JS, ES modules served by the Python server, no bundler, no CDN.
- One stylesheet with layered tokens on `:root`: colour (surface, text, border, accent, status running/idle/completed/failed/unknown), spacing scale (4 px base), type scale, radius, density (`--row-h`), focus ring.
- Light and dark via `prefers-color-scheme` plus a manual override attribute (`data-theme`); `color-scheme` set so native controls follow.
- Status never relies on colour alone: every status has an icon and a text label.
- Tabular numerals (`font-variant-numeric: tabular-nums`) and a monospace stack for ids, paths and token counts; system fonts only (no web-font download).
- Icons: `src/frontend/icons.svg`, 30 `<symbol id="i-NAME">` entries from Tabler Icons v3.49.0 outline (MIT, (c) Paweł Kuna), referenced via `<svg aria-hidden="true"><use href="#i-NAME"/></svg>` next to a visible or `aria-label` text.

## Dependencies

Add: Tabler Icons subset, tag v3.49.0, MIT (30 SVG shapes copied, no npm install, no runtime code). Retain the LICENSE reference in the sprite header.
Avoid: Tabler core, Bootstrap, Pico, Simple.css, any CDN link, any bundler, ApexCharts, icon webfonts.

## Migration complexity

Low. Existing frontend modules keep their structure; work is (1) add the token stylesheet, (2) replace ad-hoc status text/colours with the status component, (3) add icon sprite usage. Rough estimate: 0.5-1 day for tokens plus components, then incremental per-view changes. Rollback is trivial (remove stylesheet link).

## Validation plan

- Browser test (Playwright or Chrome DevTools) at 1280, 768 and about 500 px width: no horizontal page scroll, all controls reachable by Tab, visible focus on every control, Escape closes any popover.
- Lighthouse accessibility score target 100 and performance target 95+ or better on the local page; record transfer size (target under 100 KB total, uncompressed).
- Contrast checks in both themes: text 4.5:1 (WCAG 1.4.3), UI components and status icons 3:1 (1.4.11), including dimmed/secondary text and disabled states.
- Check offline: block network in DevTools, page still renders fully with icons.
- Check no external requests in the network panel.

## Accessibility principles (WCAG 2.2 references)

Semantic elements first; ARIA only to fill gaps (1.1.1, 4.1.2). Full keyboard operation (2.1.1) and visible focus (2.4.7). Contrast 1.4.3 and 1.4.11.
Do not use colour alone for status (1.4.1). Interactive targets at least 24x24 CSS px (2.5.8), compact density must keep this.
Reflow at 320 px width without two-dimensional scrolling except data tables inside a scroll container (1.4.10).
Respect `prefers-reduced-motion` and `prefers-color-scheme`. Live updates must not steal focus; announce only meaningful changes through a polite live region.

## Deferred layout decisions (not decided in this iteration)

Overall dashboard layout (list plus detail vs. board vs. timeline-first); sidebar vs. top bar; table vs. card rows for sessions;
timeline visualisation form; default density; whether to split views by route; chart usage (if any) and its library or hand-drawn SVG choice;
mobile-specific navigation. These get their own record once the data model for each view is settled.

## Sources consulted (accessed 2026-10-11)

- https://docs.tabler.io/ui/getting-started/installation
- https://github.com/tabler/tabler (README: licence, Bootstrap, browser support)
- https://github.com/tabler/tabler-icons (README: icon counts, sprite, licence)
- https://raw.githubusercontent.com/tabler/tabler-icons/v3.49.0/LICENSE and `icons/outline/*.svg` at tag v3.49.0 (tag verified to exist, HTTP 200)
- https://api.github.com/repos/tabler/tabler/releases/latest and `/tabler-icons/`, `/picocss/pico/`, `/argyleink/open-props/`, `/kevquirk/simple.css/` releases/latest
- https://registry.npmjs.org/ entries for @tabler/core, @tabler/icons, @picocss/pico, open-props, simpledotcss
- https://cdn.jsdelivr.net/npm/ (file sizes for tabler.min.css/js, pico.min.css, open-props.min.css, simple.min.css)
- https://picocss.com/docs (version, "no longer maintained", licence)
- https://open-props.style/ (what it is, individual files, sizes, licence)
- https://www.w3.org/TR/WCAG22/ (success criteria numbers; only the first 100,000 characters of the page were read)

## Not verified

Accessibility conformance of Tabler core, Pico and Simple.css components (no statements found on the pages read); Simple.css and Open Props docs pages were not fetched (data from npm/GitHub only);
Pico "no longer maintained" is quoted from its docs page via a summarising fetch, check the live page before citing publicly; whether Tabler's icon sprite package (`@tabler/icons-sprite`) differs from our hand-built sprite (we did not install it);
Lighthouse and contrast results (planned, not run); Tabler core real-world gzip/brotli transfer beyond our local gzip -9 measurement.
