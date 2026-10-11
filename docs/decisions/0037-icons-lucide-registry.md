# 0037 Icons: lucide-react through a single registry module

Status: Proposed (Phase 1, 2026-10-11). Owner: UI design (`docs/design/04-ui.md` section 6.4).

## Context
The legacy page uses a 30-symbol Tabler Icons sprite. D7 pins lucide-react 1.55.0. Icons must be decorative (`aria-hidden`) next to
text, and the set should stay small and consistent.

## Decision
- Import Lucide icons only in `src/components/icons.ts`, which maps semantic names (`running`, `failed`, `waiting-input`, ...) to Lucide
  components; everything else uses `<Icon name="..."/>`. ESLint `no-restricted-imports` blocks `lucide-react` elsewhere.
- `Icon` renders `aria-hidden="true" focusable="false"`, `size="1.1em"`, stroke 2, class `icon`.
- Mapping table in 04-ui section 6.4 (legacy sprite ids -> Lucide exports).

## Consequences
- One place to change an icon; tree-shaking keeps only used icons.
- The look changes slightly from Tabler to Lucide outlines (same outline style, same stroke width).

## Alternatives rejected
- Keep the Tabler sprite: works, but `<use href>` to a sprite file is an extra request and D7 already chose Lucide.
- `@tabler/icons-react`: not pinned in D7; no advantage.

## Evidence
- Probe 2026-10-11 (`D:/mvp/private/scratch/mcs-v3/ui/exports.mjs` and a follow-up one-liner, lucide-react 1.55.0): all mapped names exist,
  including `Activity`, `CirclePause`, `CircleCheck`, `CircleX`, `CircleHelp`, `MessageCircleQuestion`, `Hourglass`, `Rows3`, `SunMoon`,
  `SquareKanban`, `ChartColumn`, `Wifi`, `WifiOff`.
- Bundle 2026-10-11 (Vite 8.3.4): React + react-router + TanStack Query + 37 icons = 95.0 kB gzip vs React alone 68.3 kB gzip.
- Legacy sprite inventory: `docs/research/current-state-frontend.md` section 3.
