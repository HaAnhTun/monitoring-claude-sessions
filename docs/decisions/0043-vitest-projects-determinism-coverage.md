# 0043 Vitest 5 projects per test layer, determinism defaults, zero retries, coverage floors

Status: Proposed (Phase 1, 2026-10-11). Owner: tooling design (05 sections 2.8, 4).

## Context
The brief requires separate unit, integration and E2E commands, release-blocking isolation tests, and honest results. Tests start real
servers and processes on a machine shared with live monitors (ports 8765, 3000, 3100, 8080, 8089 are off limits).

## Decision
- Root `vitest.config.ts` with inline projects `unit`, `integration`, `isolation`, `resilience`, `security`, `parity`, `tooling`
  (`extends: true`) plus the web project from `packages/web/vitest.config.ts`; scripts select layers with `--project`.
- Defaults: `TZ=UTC`, `MCS_HOOK_DISABLE=1`, `restoreMocks`, `unstubEnvs`, `unstubGlobals`, `pool: 'forks'` for I/O projects, retries 0.
- No sleeps in tests (lint rule); `FakeClock`/fake timers, `waitFor` for real processes; HTTP helpers use `agent: false`.
- Ports: Vitest 18000-18499 in blocks of 50 per worker, E2E 18500-18599, dev 18760-18769, smoke 18800-18849, parity 18850-18899.
- Coverage v8: global 80/80/80/75 (lines/statements/functions/branches); 90/90/90/85 for engine lifecycle, ingest, tokens, config and for
  shared. `test:stress` runs release-blocking suites three times shuffled (seeds 1-3).
- Flaky test = defect: fix or quarantine with a dated row in `docs/testing.md`; release requires an empty quarantine for blocking layers.

## Consequences
- One runner and one config for all Node-side layers; layer commands are stable for docs and agents.
- I/O projects are slower (forks) but isolated.

## Alternatives rejected
- `node:test` for server code (CCAM's choice): a second runner, no projects/coverage thresholds in one config.
- Retries: hide real races in lifecycle and ingestion code.
- One flat test glob with name filters: cannot run "isolation only" reliably.

## Evidence
- 2026-10-11, Vitest 5.0.3 on Node 24.14.1/22.23.3/26.11.1: projects and `--project` filtering worked; coverage thresholds failed the run
  at 77.5% lines; `--sequence.shuffle --sequence.seed=3` and `--reporter=json` worked; a reused keep-alive socket gave `read
  ECONNRESET` in an integration test and `agent: false` fixed it (design 05 section 9, E8-E11).
