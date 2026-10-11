# 0048 `npm run ci` as the single gate runner; GitHub Actions workflow shipped inactive

Status: Proposed (Phase 1, 2026-10-11). Owner: tooling design (05 sections 7, 8).

## Context
The brief requires reproducible quality checks "through documented commands and CI where available" and forbids claiming unrun checks.
The skill repository has a GitHub remote, but agents must not push or change remote behaviour, and nothing has been run remotely.

## Decision
- `runtime/scripts/ci.mjs` (zero-dependency) runs, in order: format check, lint, typecheck, check-deps, (check-text, check-docs),
  tests (unit, web, integration, isolation, resilience, security), build, smoke, audit; `--full` adds parity and E2E; `--offline` skips
  audit. It stops at the first failure (unless `--keep-going`), prints a `| gate | result | ms |` table and lists gates not run; exit 0
  only when every gate ran and passed.
- `runtime/ci/github-actions-ci.yml` mirrors it (matrix windows/ubuntu x Node 22.22/24/26; a Windows job with Python for parity and
  E2E), `permissions: contents: read`, `persist-credentials: false`, actions pinned by commit SHA. It is inactive until the owner moves it to
  `.github/workflows/ci.yml`.

## Consequences
- The same gate list runs locally and remotely; the migration report quotes `ci.mjs` output.
- The workflow is unverified on hosted runners until activated.

## Alternatives rejected
- Activating the workflow now: changes the remote repository's behaviour without the owner's decision; never executed.
- npm-run-all/concurrently: extra dependencies for a sequential list.

## Evidence
- 2026-10-11: `npm run ci` passed in a clean copy (8 gates, 35 s cold; 54 s on a busy machine) (design 05 E14). Workflow YAML parsed
  with PyYAML 6.0.3 and passed Prettier (E21). Action SHAs from `git ls-remote` on 2026-10-11: actions/checkout v7.0.1
  `3d3c42e5aac5ba805825da76410c181273ba90b1`, actions/setup-node v7.1.0 `949feb2413d6458794dcd2491c4babbbce0c15c1`, actions/setup-python
  v7.0.0 `5fda3b95a4ea91299a34e894583c3862153e4b97`, actions/upload-artifact v7.0.2 `cf430e030ddbb5b0abf93d22962f4752f3646cd9`.
