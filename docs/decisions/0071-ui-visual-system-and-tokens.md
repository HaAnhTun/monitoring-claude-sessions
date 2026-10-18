# 0071 UI visual system: calm, dense, one accent; new design tokens, per-feature style files, wider responsive rules

Status: Proposed (V4, milestone M6). Owner: UI (`packages/web`). Supersedes ADR 0035 (CSS tokens ported from the legacy page). Amends ADR 0037
(icon size and stroke). Reaffirms ADR 0033 (stale data is marked by an outline and an "as of" line, never by opacity) and ADR 0038 (no
virtualisation). Changes `docs/design/04-ui.md` sections 4.1, 6.1 and 6.3 (those sections stop being normative once this ADR is accepted).
Planned for a later 4.x release.

## Context
ADR 0035 ported the legacy tokens verbatim ("identity preserved") and kept a flat scale: five font sizes of 12 to 20 px with weights 400,
600 and 700, one 8 px radius, no cards and no elevation, 36 px controls that all share one outlined style, a 380 px sidebar, and pill
badges for every state, tag and source. A review judged the result hard to read and unattractive. The 2026-10-12 UI/UX review (a planning artefact,
not shipped) traced the problem to hierarchy and density, not to colour or contrast: every control weighs the same, the numbers that
matter are small, half of each table row is empty, and the layout breaks at 1024 px and 600 px. The review recommends changing token
values and adding a few tokens while keeping the CSS layer architecture.

V4 builds every page of the UI (Overview as the landing page, Activity, Tasks, Analytics, Search, Settings), adds a second language (ADR
0072) and a dark theme that must stay first class. Those pages need one consistent system rather than per-page styling.

## Decision
1. **Direction.** Calm, information-dense, one accent colour, state shown as a dot plus a word, large numbers for the figures that matter,
   flat white cards with a 1 px border on a light grey page (dark: a clearly lighter surface on a near-black page), at most one primary
   button per screen. Linear, Vercel and GitHub Actions are named as references for the feel only; nothing is copied.
2. **Token architecture.** Plain CSS custom properties in `styles/tokens.css`, cascade layers `tokens, base, layout, components, pages`
   unchanged, token names kept (`--bg`, `--surface`, `--surface-2`, `--border`, `--control-border`, `--text`, `--text-muted`, `--accent`).
   Light and dark values are written once with `light-dark()`; `color-scheme` follows `data-theme` (`light`, `dark`, `auto` = `light dark`).
   The duplicated `auto` block of ADR 0035 is removed. A browser without `light-dark()` would see the custom properties as invalid, so `:root` first
   declares plain light values and the `light-dark()` declarations sit inside `@supports (color: light-dark(black, white))`; the contrast test checks
   that the plain fallback equals the light half of every pair. `theme-init.js` and the `data-theme` / `data-density` attributes are unchanged.
3. **Colour.** The accent is used only for interaction (links, focus ring, the primary button, selected nav item). State colours are
   semantic and separate: working (teal, filled dot, slow pulse), waiting for input (cyan, ring dot), turn ended (neutral grey), completed
   (green), failed (red, tinted background), stale or quiet-inferred (orange, tinted background, dashed ring), unknown (purple). Working
   must not share the accent hue (the review table gave both a similar blue; this ADR resolves it in favour of the review's own rule that
   the accent never marks a state). Starting values, light / dark: bg `#f5f6f8` / `#0f1115`, surface `#ffffff` / `#171a20`, surface-2
   `#f0f1f4` / `#1e222a`, border `#d0d3db` / `#2c313b`, control-border `#8a8f9c` / `#7a8090`, text `#14161a` / `#e8eaf0`, text-muted
   `#5b6070` / `#9aa1b0`, accent `#2f5bea` / `#6b9bff`, working `#0d9488` / `#2dd4bf`, waiting `#0891b2` / `#5cc8e0`, completed `#15803d` /
   `#4cc38a`, failed `#dc2626` / `#ff7a6b`, stale `#b45309` / `#f0b45a`, unknown `#7e22ce` / `#c4a2ff`. New role colours `--role-user`,
   `--role-assistant`, `--role-tool` (three neutral tones) colour transcript rows and never reuse a state colour. The final values are
   fixed by the contrast test below and by screenshot review; the implementer may adjust lightness, not hue families.
4. **Type.** Sizes 12 / 13 / 14 / 16 / 22 / 28 px with line heights 16 / 18 / 20 / 24 / 28 / 32; `--fs-2xl` (28) is new and is the size of
   headline figures. Weights 400, 500 and 600 only (700 is removed). Page titles 22 px / 600, section titles 16 px / 600, table and
   transcript text 13 px, body 14 px, captions and column headers 12 px muted. Monospace only for ids, paths, tool names and clock times.
5. **Space, shape, elevation.** Spacing scale `--sp-1..6` unchanged times the density factor `--d`, plus `--sp-7` (32 px) and `--sp-8`
   (48 px). Radii 4 (chips), 6 (controls), 10 (cards); 999 only for filter chips. Control height `--ctl-h` 32 px (compact density 28, inline
   24; no interactive target below 24 px, WCAG 2.2). `--elev-1` (cards, `0 1px 2px` at low alpha) and `--elev-2` (popovers, dialogs,
   toasts). Dark theme separates surfaces by lightness and border; shadows are weaker there.
6. **Layout and breakpoints.** `--side-w` 240 px; `--side-w-rail` 56 px; top bar 48 px. Breakpoints are literals in media queries: 1280
   (secondary table columns hide), 1200 (sidebar becomes the rail), 900 (tables become card lists, the rail becomes a menu sheet), 600
   (the smallest supported width; below it the layout is best effort). Nothing may scroll the page horizontally at 600, 1024 or 1440 px;
   wide tables scroll inside their own wrapper only above 900 px.
7. **Controls.** Three button levels on the existing variants: primary (accent fill, at most one per screen), secondary (outline, the
   default variant), tertiary (no border, hover fill: the `quiet` and `icon` variants). One input style. Links are underlined only inside
   prose. Badges are `dot + 13 px word`, no border; only Failed and Stale (and the quiet-inferred "Working?") get a tinted background.
   Tags, sources and metadata are muted 12 px text. Popovers, menus and tab bars are shared primitives (`Popover`, `Menu`, link-based tab
   navigation) so that no page builds its own.
8. **Motion and focus.** The working dot pulses slowly; every animation and transition respects `prefers-reduced-motion`. The focus ring
   is `2px solid var(--focus)` with 2 px offset on every interactive element and is never part of a `transition`.
9. **Icons.** Fixed 16 px (18 px in menus), stroke 1.5, set in `Icon.tsx`; ADR 0037's registry rule is unchanged (amended: size and stroke only).
10. **Style files.** `styles/pages.css` and the shared blocks of `components.css` disappear. Each feature owns one file
    (`shell.css`, `topbar.css`, `lists.css`, `badges.css`, `states.css`, `sessions.css`, `session-detail.css`, `session-tabs.css`,
    `transcript.css`, `overview.css`, `activity.css`, `work.css`, `settings.css`, `panels.css`, `search.css`), imported once from
    `index.css`; `components.css` keeps only primitives. No file contains work-package markers.
11. **Contrast gate.** `lib/tokens-contrast.test.ts` reads `tokens.css` (including `light-dark()` pairs) and asserts WCAG 2 ratios in both
    themes: 4.5:1 for text pairs (text, muted text, accent on surface, accent-contrast on accent, every state label colour on its tinted
    and untinted surface), 3:1 for non-text pairs (control borders, focus ring, state dots on the surface, role borders). It also fails on
    weight 700, on a `transition` that lists `outline`, and on a second copy of the dark token block.
12. **Budgets.** Initial JavaScript stays at 200 kB gzip. Total JavaScript (all chunks, both locales, seven pages and one hand-drawn
    chart) moves from 260 kB to 340 kB gzip; CSS stays at 25 kB gzip. `scripts/check-bundle-budget.mjs` is the gate; the numbers are
    reviewed again when the last UI work package lands.

## Consequences
- The visual identity of the legacy page is gone on purpose; users of the old viewer see a different product.
- `light-dark()` needs Chrome 123, Safari 17.5 or Firefox 120 (baseline 2024). Older browsers get the light theme from the plain fallback
  values of `:root` and cannot switch to dark; this is documented in the user guide.
- Every component stylesheet moves once (a mechanical split owned by one work package), then each feature owns its file.
- The contrast test now fails on any new colour pair that is not registered, which keeps the dark theme honest.
- The review's hard measurements (first table row near y = 253 at 1440 px, no row above 80 px at 1024 px, three transcript rows visible
  on the first screen at 600 px) become Playwright assertions in the responsive suite.

## Alternatives rejected
- Keep ADR 0035 and only restyle pages: the pill badges, flat scale and equal-weight controls are tokens-level decisions; page styling
  cannot fix them.
- Tailwind or CSS-in-JS: unchanged from ADR 0035 (avoid list, breaks the density factor, new dependency).
- Rename every token (the visual review proposed new names): churn in every stylesheet and test for no user benefit.
- Two copies of the dark tokens (`data-theme='dark'` plus a media query): a source of drift (review item R-26); `light-dark()` removes it.
- Accent blue for the Working state (the review table): then links, focus and Working look the same, which the review itself rules out.

## Evidence
- UI/UX review of 2026-10-12, sections 1, 2 (R-02, R-10, R-26, R-27), 5 and 7 (planning artefact).
- `packages/web/src/styles/tokens.css` and `packages/web/src/lib/tokens-contrast.test.ts` at the V3 head (the pairs the new test extends).
- ADR 0033 evidence (opacity 0.6 fails WCAG 1.4.3), ADR 0035 evidence (legacy contrast ratios).
