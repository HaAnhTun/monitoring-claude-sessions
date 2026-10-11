# 0035 Styling: plain CSS custom properties ported from legacy, cascade layers, contrast-driven additions

Status: Proposed (Phase 1, 2026-10-11). Owner: UI design (`docs/design/04-ui.md` sections 6.1-6.3).

## Context
Brief 9 asks to keep the current visual identity. D7 fixes plain CSS custom properties with tokens ported from the legacy UI. The
legacy density mode multiplies all spacing and control heights by `--d`; utility-class systems would break it (research risk 7). The new
lifecycle model (D9) adds a "waiting for input" state with no legacy colour.

## Decision
- Port `src/frontend/styles.css` tokens verbatim (light, dark, `auto` duplicate block, compact density).
- Global CSS split into files under `@layer tokens, base, layout, components, pages`; legacy class names kept where the element is a
  port; component-prefixed names for new parts. No CSS modules, Tailwind or CSS-in-JS.
- Add `--control-border` (light #858594, dark #75768a) for input/button boundaries, and `--waiting-fg/--waiting-bg` (light #0e5a6b/#d9f1f6,
  dark #7fd3e6/#0f2f37). `--border-strong` stays for decorative lines.
- A unit test parses `tokens.css` and asserts the contrast pairs in both themes.
- Inline `style` props only for computed geometry (React applies them through CSSOM, allowed by `style-src 'self'`).

## Consequences
- Identity preserved; compact density keeps targets >= 24 px.
- Slightly darker control borders than the legacy page (visible change, justified by WCAG 1.4.11).

## Alternatives rejected
- Tailwind / CSS-in-JS: avoid list (stack-versions section 9), breaks the `--d` multiplier model.
- CSS modules: scoping is not needed for one small app and hides the legacy class names agents already know.
- `light-dark()` instead of the duplicated `auto` block: possible, but keeping the legacy mechanism avoids behaviour drift; revisit later.

## Evidence
- Contrast run 2026-10-11 (`D:/mvp/private/scratch/mcs-v3/ui/contrast.mjs`, `contrast2.mjs`): legacy `--border-strong` on surface 2.32:1
  (light) and 2.57:1 (dark); `--control-border` 3.63/3.14 (surface/surface-2, light) and 3.86/3.42 (dark); waiting pair 6.63:1 (light)
  and 8.34:1 (dark); all legacy state pairs >= 5.57:1.
- CSP probe 2026-10-11 (`csp/csp.spec.mjs`, Chrome 155): React `style={{width:'40%'}}` applied under `style-src 'self'`, no violation.
- Token inventory: `docs/research/current-state-frontend.md` section 3.
