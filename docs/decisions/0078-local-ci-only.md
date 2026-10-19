# 0078 CI is local only: GitHub Actions and the `ci-status` branch are dropped

Status: Accepted (V4, 2026-10-20). Owner: platform area (A), by decision of the repository owner. Supersedes the GitHub Actions workflow and the
`ci-status` branch parts of ADR 0065 (items 1, 2, 3 and 6, and the macOS job of item 5) and the hosted-workflow consequence of ADR 0048. The Docker POSIX harness of
ADR 0065 (item 4) stays.

## Context
ADR 0065 activated a GitHub Actions workflow (Windows and Ubuntu on Node 22.22, 24 and 26, a lean macOS job, end-to-end tests, a report job) and a results branch
`ci-status` that a session without the `gh` CLI could read with `git fetch`. On 2026-10-20 the owner decided that GitHub Actions are no longer used: the
backend and the interface are finished and polished locally before the repository goes public, and nothing runs on hosted runners. A workflow file that never
runs is dead weight, and tests that parse it protect nothing.

## Decision
1. **No hosted CI.** `.github/workflows/ci.yml`, `runtime/scripts/ci-status.mjs`, `runtime/scripts/ci-lean.mjs` and the tests and fixtures that only served them
   (`ci-status.test.ts`, `fake-git.mjs`, the workflow half of `ci-script.test.ts`) are deleted. The five `MCS_CI_*` names that only `ci-status.mjs` read are removed
   from the closed list of environment variables.
2. **`npm run ci --summary-json` is removed.** Its only consumer was `ci-status.mjs summarize`. `npm run ci` keeps its flags (`--offline`, `--full`, `--keep-going`,
   `--strict`, `--bundle`) and its result table; exit 77 stays the single "cannot run yet" signal.
3. **The local gates are the gates.** `npm run ci` (and `npm run ci:full`), the release tool of ADR 0076 and the Docker POSIX harness (`npm run docker:posix`: Linux x64 and
   arm64 emulated, glibc and musl, Node 22, 24 and 26) remain and are the evidence behind every claim in the documents and the release report.
4. **macOS is verified by hand.** The macOS branches (`ps` process listing, lock-file mutex, socket folder under `os.tmpdir()`, `/usr/bin/open`) stay marked
   UNVERIFIED in the code comments, the platform document and the release report until someone runs `npm run ci` and the smoke on a Mac. Nothing says "supported
   and tested" for macOS before that run exists.
5. **The remote `ci-status` branch** is not touched by this change. Whether it is deleted before publication is a later owner step; no code reads or writes it any more.

## Consequences
- No result is produced for a push; the person who pushes runs the local gates first. A red gate is visible in the terminal, not in a hosted run.
- No Windows arm64, macOS or Node-matrix result exists for a commit unless someone runs it by hand. The documents say so.
- No action pins, workflow token permissions or hosted-minute costs to maintain.
- The workflow-related tests of ADR 0065 are gone with the file; `ci-script.test.ts` keeps the tests of the local `ci.mjs`.

## Alternatives rejected
- Keeping the workflow inactive: a file nobody runs drifts from `ci.mjs`, and its tests would keep passing against a dead file.
- Keeping `ci-status.mjs` for manual use: it only summarised hosted runs.
- Keeping `--summary-json` for a future consumer: no consumer exists; a flag without a reader is untested surface.

## Evidence
- 2026-10-20: the owner's decision, recorded in the decisions file of the V4 run. After the removal the tooling tests, Prettier, ESLint on the changed scripts and
  `check-deps` pass (see the work package report).
