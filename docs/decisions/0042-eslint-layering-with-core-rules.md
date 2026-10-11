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
- Platform branching (design 06 section 4, critic I-34; revision 2026-10-11): `no-restricted-properties` entry `PLATFORM_ENTRY`
  (`process.platform`) and `no-restricted-syntax` for `os.platform()` in `packages/engine/src/**`, allow-list
  `engine/src/platform/**` and `engine/src/security/paths.ts` (that block re-declares the stdio entries, because a later block replaces
  a rule's options); the logger keeps `['error', PLATFORM_ENTRY]`.
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
- 2026-10-11, same versions, Appendix A.9 of design 05 revision 2 in a scaffold copy: `process.platform`/`os.platform()` reported in
  `engine/src/panels/x.ts` and `engine/src/log/logger.ts`, not in `engine/src/platform/x.ts`, `engine/src/security/paths.ts`, test files,
  server, cli or `shared/src/protocol`; stdout still reported in the allow-list files (design 05 E24, design 06 E24).
- `stack-versions.md` section 6 (jsx-a11y peer conflict and override).
