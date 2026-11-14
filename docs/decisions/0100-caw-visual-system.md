# 0100 CAW visual system: the MTOP palette as the dark theme, a warm light theme, one monospace stack, terminal tokens

Status: Accepted (CAW, 2026-11-15). Owner: web design system (UIS-TOKENS), design 05 sections 2, 3.2, 3.4 and 4. Supersedes ADR 0071 decisions 3
(colour), 4 (type) and 5 (space, shape, elevation), and the numbers of its decisions 6 (top bar height) and 11 (the pairs of the contrast
gate; the mechanism stays). ADR 0071 decision 12 (budgets) is closed by ADR 0101. ADR 0074 keeps its decisions (stale data is an outline
and an "as of" line; ADR 0033 stays), only the colour values it points at change. ADR 0071 decisions 1, 2, 7 to 10 stay: plain CSS custom
properties, the cascade layers, the three button levels, motion and focus, icons, one file per feature. The Status lines of the amended ADRs
are updated by the documentation package of the program. Related: 0097 (the terminal renderer and its CSP), 0096 (the workspace layout).

## Context
CAW merges the terminal-panel product MTOP into this application (spec section 2, Q4, Q8). MTOP is dark only, with a small token set
(`--bg #141414`, `--panel #1b1b1b`, `--hover #242424`, `--line #2c2c2c`, `--text #d4d4d4`, `--strong #f0f0f0`, `--dim #8c8c8c`, `--faint #5e5e5e`,
`--accent #d97757`, `--green #6cc785`, `--yellow #e2c070`, `--blue #7aa2f7`, `--red #e06c75`, `--selected #2a2e33`), a monospace stack, 13 px text and 4 px
radii. The owner decided (Q4) that MTOP's tokens become the default dark theme, that a warm light theme in the same orange family
exists beside it, that the whole UI uses the MTOP monospace stack, that no proprietary Claude font is shipped, and that the theme and density
controls stay. ADR 0071 gave the monitor a calm, blue-accented, proportional-font system with its own numbers for colour, type and shape, so
those three decisions change. Its architecture (tokens, layers, `light-dark()`, the contrast gate) is sound and is kept.

The terminal also needs colours: sixteen ANSI colours, a cursor, a selection, a scrollbar. They must follow the theme, and the only way a
terminal widget takes colours is as an object, while the tokens are `light-dark()` custom properties that the browser stores unresolved.

## Decision
1. **Dark theme = the MTOP palette, with two measured deviations.** Every dark value of the table in decision 2 that has an MTOP name keeps
   the exact MTOP value (`--bg`, `--surface` = MTOP panel, `--surface-2` = MTOP hover, `--border` = MTOP line, `--text`, `--strong`, `--faint`,
   `--accent`, and the four semantic colours as the dots of working blue, completed green, stale yellow and failed red). The test
   (`lib/tokens-contrast.test.ts`) pins them. Two values cannot be MTOP's, because the new selected-row surface and the muted text meet:
   - `--text-muted` is `#9a9a9a`, not MTOP's `--dim #8c8c8c`: `#8c8c8c` on the MTOP selected colour `#2a2e33` is 4.06:1, below the 4.5:1 of
     WCAG 1.4.3; `#9a9a9a` on our selected surface is 5.13:1.
   - `--selected` is `#262a2f`, not MTOP's `#2a2e33`: the accent as link text on `#2a2e33` is 4.38:1, on `#262a2f` it is 4.62:1.
   Dark separation stays MTOP's: 1 px lines, not fills (the surface against the page is 1.07:1, the line against the page 1.32:1; no text or
   control boundary depends on either). `--faint #5e5e5e` is decoration and disabled marks only (2.66:1 on the surface), never text; a style
   guard enforces it (decision 9).
2. **Light theme = a warm cream in the family of the accent; two oranges.** Light values, dark values:

   | Token | Light | Dark |
   |---|---|---|
   | `--bg` page | `#f5f2ea` | `#141414` |
   | `--surface` | `#fcfbf7` | `#1b1b1b` |
   | `--surface-2` hover | `#ece8dd` | `#242424` |
   | `--selected` | `#ebe4d2` | `#262a2f` |
   | `--border` / `--border-strong` | `#ddd8ca` / `#c7c0ac` | `#2c2c2c` / `#3d3d3d` |
   | `--control-border` | `#7d7662` | `#767676` |
   | `--text` / `--strong` | `#2a2723` / `#14110d` | `#d4d4d4` / `#f0f0f0` |
   | `--text-muted` / `--faint` | `#5f584a` / `#aaa38f` | `#9a9a9a` / `#5e5e5e` |
   | `--accent` (= `--focus`) / `--accent-contrast` | `#a84826` / `#ffffff` | `#d97757` / `#141414` |
   | `--selection` | `#ddc9b0` | `#3a4a5e` |

   The exact MTOP orange `#d97757` is 3.02:1 on the light surface, so it cannot be a text or control colour there. `--accent` is the
   WCAG-safe orange for text, links, the primary button and the focus ring (4.57:1 on the worst of the four surfaces, 5.60:1 on the
   surface); `--brand` is `#d97757` in both themes and marks only (the logo, the favicon), declared once in the plain `:root` block. The
   accent still marks interaction only (ADR 0071 decision 3, kept); it is never a state colour. The four surfaces a text colour must pass on
   are `--bg`, `--surface`, `--surface-2` and `--selected`. Selection is a `--selected` fill with a 2 px accent bar (an accent border for
   toggles) and `--strong` or `--text` text; hover is `--surface-2`.
3. **State hues.** Token names are unchanged (`--state-{working,waiting,ended,completed,failed,stale,unknown}-{dot,fg,bg}` and the ADR 0035
   aliases). Working is blue, because the accent is no longer blue and may not collide with it (ADR 0071 gave Working teal for that
   reason). Dark dot / label, light dot / label:

   | State | Dark | Light | Shape |
   |---|---|---|---|
   | working | `#7aa2f7` / `#7aa2f7` | `#3d6fd6` / `#2a58b8` | solid, slow pulse |
   | waiting for input | `#5cc8e0` / `#5cc8e0` | `#0e8aa6` / `#0b6b80` | ring |
   | turn ended | `#8c8c8c` / `#a8a8a8` | `#7d7766` / `#5b5649` | solid |
   | completed | `#6cc785` / `#6cc785` | `#2f8f48` / `#1f6b31` | solid |
   | failed | `#e06c75` / `#e8767f` | `#d03a2f` / `#b3261e` | solid |
   | stale | `#e2c070` / `#e2c070` | `#a86e00` / `#8a5a00` | solid, dashed ring when inferred |
   | unknown | `#c4a2ff` / `#c4a2ff` | `#8a4cc7` / `#7035a8` | solid |

   A tint (`--state-*-bg`) is the label colour mixed into the surface, 10 % in the light theme and 14 % in the dark one (a test recomputes
   it). The failed label is `#e8767f` in the dark theme because the MTOP red `#e06c75` is 4.37:1 on its tint and the label needs 4.5:1. Badge
   structure (dot, word, tint only for failed, stale and inferred states) and the word that always accompanies the colour are unchanged.
   The recency marks of the project folders are aliases: `--recency-full` = the completed dot, `--recency-half` = the stale dot,
   `--recency-none` = `--faint`, always next to the relative time as text.
4. **One monospace stack for the whole UI.**
   `--mono: 'Cascadia Mono', 'Cascadia Code', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', 'Segoe UI Symbol',
   monospace` and `--font: var(--mono)`. It is the MTOP stack plus the macOS and Linux names that a later port needs, plus `Segoe UI Symbol` as the
   symbol fallback. Coverage was measured from the font files of the machine (`.dev/caw/design/font-coverage.mjs`, 134 Vietnamese letters and
   46 glyphs that Claude Code and terminals draw):

   | Font | Vietnamese letters (134) | Terminal glyphs (46) |
   |---|---|---|
   | Consolas | 134 | 33 (lacks 13: the spinner stars, the record dot, the corner and prompt arrow, the check marks, the half circle, the play triangle, the bolt and the warning sign) |
   | Courier New | 134 | 27 |
   | Lucida Console | 42, so it is never listed | 25 |
   | Segoe UI | 134 | 10 |
   | Segoe UI Symbol | 32, so it comes after the two fonts that have Vietnamese | 46 |

   Order matters, because the browser falls back per glyph: `Segoe UI Symbol` stands after Consolas and Courier New (Vietnamese never lands
   on it) and before the generic family. A test pins the relative order and forbids Lucida Console and any proportional family. Cascadia Mono
   is not installed on the measuring machine, so its own coverage is unverified and nothing depends on it. Consequences for layout: advance
   widths differ (Cascadia 0.586 em, Consolas 0.550 em), so widths use `ch`, `rem` and `minmax(0, 1fr)`; Consolas has regular and bold only, so
   weight 500 renders as 400 and hierarchy comes from colour and weight 600; no text container uses a line height below 1.35 (stacked
   Vietnamese marks). No web font is shipped: the application is offline, and a font would cost licence review and budget.
5. **Scale, shape, space, density** (comfortable / compact):

   | Token | Comfortable | Compact |
   |---|---|---|
   | `--fs-xs` to `--fs-2xl` | 11, 12, 13, 15, 18, 24 px (body 13 px like MTOP) | same |
   | `--lh-xs` to `--lh-2xl` | 16, 18, 20, 22, 26, 32 px | same |
   | `--lh` | 1.5 | 1.35 |
   | `--radius-sm` / `--radius` / `--radius-lg` | 3 / 4 / 6 px | same |
   | `--d` (spacing factor on `--sp-1` to `--sp-8`) | 1 | 0.75 (was 0.65: sub-pixel gaps) |
   | `--ctl-h` | 30 px | 26 px |
   | `--row-h` (table, card and timeline row) | 36 px | 28 px |
   | `--row-h-list` (sidebar and menu rows) | 26 px | 24 px |
   | `--topbar-h` | 40 px (was 48) | 40 px |
   | `--list-w` (project and session column) | 320 px (280 px from 1024 px, an overlay below 1024 px; decided with ADR 0096) | same |

   The scale moves one notch down so that the wider glyphs of a monospace face cost about the line width that the proportional face did.
   Weights stay 400, 500 and 600 (700 stays forbidden). 24 px stays the floor of every interactive target (WCAG 2.2). `--ctl-h-inline` stays 24
   px. The breakpoints gain `--bp-list: 1023px` (the list column becomes an overlay); the others and the 56 px rail are unchanged. Elevation:
   `--elev-1` and `--elev-2` as shadows in the light theme; in the dark theme `--elev-1` is none and `--elev-2` a stronger black shadow
   (`light-dark()` takes colours only, so `--elev-2` is two shadow layers that swap with the theme). `--backdrop` is the dialog scrim of both
   themes, replacing the two `rgb(0 0 0 / 0.4)` literals of the shell and the shortcuts dialog. The focus ring stays `2px solid var(--focus)`
   with a 2 px offset (MTOP's 1 px outline is weaker than WCAG 2.2 asks); a terminal pane uses an inset 1 px accent line instead.
6. **Terminal tokens and the theme as data.** Sixteen tokens `--ansi-*` (light and dark values chosen so that every colour but one is at
   least 4.5:1 on the terminal background), `--selection`, and three aliases `--term-bg` = `--bg`, `--term-fg` = `--text`,
   `--term-cursor` = `--text`. In the light theme ANSI white and bright white are dark on purpose: a program that prints white text on a cream
   page must stay legible, so readable beats faithful. The one exception is the dark ANSI black `#2a2a2a` (1.28:1): programs use it as a
   background colour, not as text. `lib/term-theme.ts` turns the tokens into the object a terminal takes (`terminalThemeFrom`,
   `TERMINAL_THEME_TOKENS`), reads them through a hidden probe element (`cssColorResolver`: `getPropertyValue('--bg')` returns the
   unresolved text `light-dark(#f5f2ea, #141414)`, while the computed `color` of an element with `color: var(--bg)` is the resolved value),
   fixes the font (13 px, 12 px below a 700 px viewport, line height 1.2 so stacked Vietnamese marks do not clip) and exposes
   `readTerminalOptions`, which returns the theme, the font family, the size and the line height only. `state/color-scheme.ts` offers
   `resolveScheme`, `useColorScheme` (the `data-theme` attribute and the system preference) and `useTerminalTheme`, a new theme object exactly
   when the scheme changes. The module has no dependency on xterm; the type is structural. This ADR does not choose the terminal renderer, a
   minimum contrast ratio or the scrollback: those belong to the terminal area (ADR 0097). The theme reaches the terminal as an object, which
   needs no `<style>` element and so works under the CSP `style-src 'self'` with whichever renderer that ADR selects.
7. **Mechanism kept.** Colours are written once: the plain `:root` block holds the light value of every colour (the fallback of a browser
   without `light-dark()`), the `@supports (color: light-dark(black, white))` block holds the same names as pairs, `color-scheme` follows
   `data-theme`. There is no second block of dark values. The colour rows are generated by `node .dev/caw/design/contrast-check.mjs --tokens`
   (the calculator that also computed every ratio in this ADR) and pasted.
8. **Theme runtime.** `public/theme-init.js` stays the one blocking classic script and gains one thing: the `<meta name="theme-color">`
   colour, from a two-value table (`#f5f2ea` light, `#141414` dark) that a test holds equal to the `--bg` pair. `index.html` carries one meta
   per scheme with a `prefers-color-scheme` media query, which is already right under `auto`; the script sets both to the colour of an
   explicit stored choice, so that the choice wins over the system. The favicon is `public/favicon.svg`: a 32 px rounded square `#141414`
   with a `>_` mark in the brand orange, drawn with paths (no font, no external reference), replacing `href="data:,"`.
9. **Gates.** `lib/tokens-contrast.test.ts` reads `tokens.css` (parser in `src/test/css-tokens.ts`, shared by three suites) and checks 270
   pair-checks (135 pairs in each theme: text, strong, muted text, accent text, focus ring, control border and the three role colours on the
   four surfaces; the accent button; for each state the label on its tint and on the four surfaces, the dot on the four surfaces, text and muted
   text on the tint; the 16 ANSI colours, terminal text, cursor and selection; the brand mark; faint as information), plus the ADR 0035
   aliases, the MTOP values, the two deviations, the derived tints, the declared tokens and values, the compact density, the font stack order,
   the plain fallback equal to the light half of every pair, and no second block of dark values. `styles/tokens-usage.test.ts` forbids a
   colour literal (`#hex`, `rgb(`, `hsl(` and the other colour functions) outside `tokens.css`, a `font-family` other than `var(--mono)` and
   `var(--font)`, `color: var(--faint)`, a `var()` that names no token (three runtime custom properties are listed by name, and the test
   proves their setters still exist), and any `@import` that is neither a local file nor the xterm style sheet. Both suites carry negative probes.

## Consequences
- Every page changes appearance once, through values: the type scale shifts a notch down, the control and row heights shrink, the font is
  monospace. Layout fallout (overflow at 600 and 1024 px, clipped diacritics) is predicted from font metrics, not yet measured; the visual QA
  harness measures it, and the restyle packages that follow re-fit the stylesheets it flags. `tokens.css` is the only file that changed
  colours in this package; `shell.css` and `topbar.css` changed only their two scrims.
- The light theme looks less vivid than MTOP's orange on cream, by design: `--accent` has to be darker to be text. The brand orange keeps the
  exact MTOP colour wherever it is a mark. The owner reviews screenshots of both.
- Selected rows move from `--surface-2` to `--selected` plus an accent bar in later packages; until each stylesheet migrates, selected and
  hover look alike. `--faint` exists for decoration; a later author who wants it as text fails a test.
- `theme-color` follows the stored choice when the page loads. A switch made later in the user menu does not update the meta until the next
  load, because the meta is written by the pre-paint script only. Whether Chrome and Edge tint the title bar of an `--app` window from it is
  not verified (design 05 question O5).
- `::backdrop` inherits custom properties from its originating element in current browsers (Chrome 122 and later, Firefox 120 and later).
  `light-dark()` needs Chrome 123, Safari 17.5 or Firefox 120 anyway (ADR 0071); older browsers get the light theme and, for the dialog
  scrim, no tint.
- `Segoe UI Symbol` is a Windows font. On another platform the generic `monospace` family supplies those glyphs; adding a bundled font is
  revisited only when a port shows a machine without any listed font (design 05 question O3).

## Alternatives rejected
- Keep the blue accent and the proportional face of ADR 0071: contradicts the owner decision of Q4.
- Use MTOP's `--dim` and `--selected` unchanged: both fail 4.5:1 where they meet (4.06:1 and 4.38:1).
- Use `#d97757` as the light accent: 3.02:1 on the surface; the link, the focus ring and the primary button would fail WCAG.
- One orange for both themes with a darker dark accent: loses the exact MTOP accent that the owner asked for in the dark theme.
- Rename the tokens to MTOP's names: churn in every stylesheet and test (ADR 0071 rejected the same); MTOP names are an alias table in the
  design, and only `--strong`, `--faint` and `--selected` are new.
- Two copies of the dark values (`data-theme='dark'` plus a media query): a source of drift; `light-dark()` removes it (ADR 0071).
- A web font with Vietnamese coverage: no licence or budget cost today, and Consolas already covers all 134 letters on Windows.
- Reading `getPropertyValue('--ansi-red')` directly: it returns `light-dark(...)` text, not a colour; only a resolved read (the probe) works.
- Declaring in this ADR that one terminal renderer is unusable: the renderer is the terminal area's decision and this package has no
  spike behind such a claim.

## Evidence
- `.dev/caw/design/contrast-check.mjs` (`--grouped`, `--tokens`): 270 checks, 0 failures; every ratio quoted here comes from it or from the
  same formula in `lib/tokens-contrast.test.ts`. `.dev/caw/design/font-coverage.mjs`: the font table of decision 4.
- MTOP `web/index.html` (token block, font stack, 13 px, 4 px radii), read-only reference `D:\mtop-main`.
- `packages/web/src/lib/tokens-contrast.test.ts`, `src/styles/tokens-usage.test.ts`, `src/lib/term-theme.test.ts`,
  `src/state/color-scheme.test.ts`, `src/test/setup.test.ts` (the theme-color table and the favicon).
- ADR 0071 (superseded decisions), ADR 0033 and 0074 (stale outline, kept), ADR 0097 (terminal renderer and CSP), ADR 0096 (workspace layout).
