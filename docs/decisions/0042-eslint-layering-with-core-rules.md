# 0042 ESLint 10 flat config: typed linting, layering and safety with core restriction rules

Status: Proposed (Phase 1, 2026-10-11). Owner: tooling design (05 section 2.6). Web-specific rules come from 04-ui.md section 8.

## Context
The brief requires no `any`, no unsafe assertions, validated boundaries, and safe rendering; the foundations require layering (shared has
no Node imports, engine <- server/cli, web imports only shared), a tiny zod-free hook handler, one SQLite module and one process launcher.
ESLint 10.12.0 is flat-config only; eslint-plugin-jsx-a11y 6.10.2 declares peer `eslint <= 9`.

## Decision
- `eslint.config.js` with `@eslint/js` recommended, typescript-eslint 8.71.1 `strictTypeChecked` + `stylisticTypeChecked`
  (`projectService`), react-hooks 7.1.1 and jsx-a11y 6.10.2 (npm override `"eslint": "$eslint"`) for web.
- `consistent-type-assertions: never` outside tests; `switch-exhaustiveness-check`; `reportUnusedDisableDirectives: error`.
- Layering, deep-import, banned-package, hook-handler, driver and child-process rules via `no-restricted-imports` blocks built by one
  helper (flat config replaces rule values per block); stdout/stderr via `no-restricted-properties`; raw HTML, `shell: true` and test
  sleeps via `no-restricted-syntax`; browser globals via `no-restricted-globals`.
- `tests/tooling/lint-rules.test.ts` keeps the probe table as a regression test.

## Consequences
- No extra lint plugins for architecture; rules are readable in one file. Import ordering is not linted.
- Lint is the slowest gate (about 20-26 s cold, 6 s warm on the scaffold).

## Alternatives rejected
- eslint-plugin-import / eslint-plugin-boundaries: more dependencies, peer-range risk with ESLint 10, same result for our rule set.
- dependency-cruiser: separate tool and config for what core rules express.
- Waiting for jsx-a11y to support ESLint 10: blocks the a11y rules the UI needs; the override is verified working.

## Evidence
- 2026-10-11, ESLint 10.12.0, typescript-eslint 8.71.1: probe files produced 33 targeted findings on the expected lines and rules,
  allowed cases passed (`as const`, `node:crypto` and `@mcs/shared/protocol` in the hook, assertions in tests); a first selector on any
  `.write()` call wrongly matched `process.stdout.write` and was narrowed to `document.write` (design 05 section 9, E6, E7).
- `stack-versions.md` section 6 (jsx-a11y peer conflict and override).
