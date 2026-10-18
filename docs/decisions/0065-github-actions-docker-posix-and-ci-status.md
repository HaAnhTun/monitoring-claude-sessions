# 0065 CI: active GitHub Actions workflow, Docker POSIX harness and the `ci-status` branch

Status: Accepted (V4, 2026-10-18). Owner: platform area (A). Amends 0048 (the workflow is no longer an inactive draft, its Python job is removed,
the full run is end-to-end only, one job may write a results branch). Related: 0062, 0063, 0064.

## Context
Owner decision 8: Linux is tested locally in Docker; GitHub Actions is activated for Windows x64 and Ubuntu x64 on every milestone push
and for macOS arm64 (lean, no Playwright); the full matrix (Windows arm64, macOS x64, Linux arm64) only after the repository is public. The lead
has no `gh` CLI, so results must be readable with `git fetch`. The repository stays private until the end; another session on the same
machine runs Docker containers that must never be touched.

## Decision
1. **Workflow** `.github/workflows/ci.yml` (moved from `runtime/ci/github-actions-ci.yml`), triggers `push` (branches `main`, `feat/**`),
   `pull_request`, `workflow_dispatch`; default `permissions: contents: read`; actions pinned by commit SHA (checkout v7.0.1
   `3d3c42e5aac5ba805825da76410c181273ba90b1`, setup-node v7.1.0 `949feb2413d6458794dcd2491c4babbbce0c15c1`, upload-artifact v7.0.2
   `cf430e030ddbb5b0abf93d22962f4752f3646cd9`, download-artifact v8.0.2 `9000827ccba6bdab643e8b6fd33ac0654aef8333`; re-verified with `git ls-remote` by the work package);
   `persist-credentials: false` on every checkout; no `pull_request_target`; no `secrets.*`.
2. **Jobs**:
   - `gates`: `windows-latest` (x64) and `ubuntu-latest` (x64) x Node `22.22`, `24`, `26`; `macos-latest` (arm64) x Node `24` only. Steps: checkout, setup-node
     with npm cache, `npm ci`, `npm run ci -- --bundle --summary-json ci-summary.json`, then (always) `node scripts/ci-status.mjs summarize` and an artifact upload.
   - `e2e`: `windows-latest` and `ubuntu-latest`, Node 24: `npx playwright install --with-deps chromium` (Linux) / `npx playwright install chromium` (Windows), `npm run build`, `npm run test:e2e`; traces uploaded on failure. Not on macOS.
   - `report`: `needs: [gates, e2e]`, `if: always() && github.event_name == 'push'`, the only job with `permissions: contents: write`. It downloads the per-job
     summaries and runs `node scripts/ci-status.mjs publish`, which commits them to the orphan branch `ci-status`.
   The Python job and `ci:full`'s parity part are gone; the full matrix additions (Windows arm64, macOS x64, Linux arm64) are commented placeholders until the repository is public.
3. **`ci-status` branch** (orphan, created by the first publish): `runs/<sha>/<run_id>-<attempt>.json` with `{ schema: "mcs.ci-status/1", sha, ref, runId, runAttempt, runUrl,
   finishedAt, result, jobs: [{ name, os, arch, node, result, gates: [{ name, result, ms }], failedGate, tail }] }` (`tail` = at most 40 lines of the failing gate's output with
   anything that looks like a token removed) and `latest.json` (`{ sha, runId, result }`). `publish` retries `fetch` / `rebase` / `push` up to 5 times, authenticates through
   `git -c http.extraheader=...` (the token is never in a URL or a log line) and never force-pushes. The lead reads results with:
   `git fetch origin ci-status` then `node runtime/scripts/ci-status.mjs read --sha <sha|HEAD> [--wait 600]` (exit 0 all green, 1 a job failed, 3 no result yet), or plainly
   `git show origin/ci-status:runs/<sha>/<run>.json`.
4. **Docker POSIX harness** `runtime/scripts/docker-posix.mjs` (`npm run docker:posix`): for each target it exports the committed tree with `git archive <ref>` (default `HEAD`)
   and pipes the tar into a container (`docker run --rm -i --user node ... tar -x`); **no bind mount of any host folder**, so the live tree is never visible, let alone writable. The containers run a derived image
   (`mcs-posix/<target>:<hash>`: the official image plus `git` and `ps`, which the slim and Alpine images lack and the panel tests need), built once by `docker build --label mcs-v4-harness=1 -` with the Dockerfile on stdin (no build context). Targets:
   `node22`, `node24`, `node26` (`node:<n>-bookworm-slim`, glibc) and `alpine24` (`node:24-alpine`, musl) for `linux/amd64`, and the same for `linux/arm64` through emulation with the
   quick gate list (`test`, `build`, `smoke`, `bundle:check`; lint and typecheck are platform independent and too slow under emulation), plus an optional `floor` target (`node:20-alpine`) that
   runs the launcher and expects the floor message. Every container carries the labels `mcs-v4-harness=1` and `mcs-v4-run=<run id>`, the name `mcs-posix-<run id>-<target>`, `--memory 3g`; the
   harness removes only containers that carry its own run label (on exit, on SIGINT, and with `--prune` for earlier runs of this harness; `--prune --images` also removes its own labelled images) and never lists, stops or removes anything else. Sequential
   (the Docker VM has 8 GB), results in `runtime/.dev/docker-posix/<run id>/{summary.json,<target>.log}` (git-ignored). *Consolidation amendment (plan section 10, D-11):* a ref export cannot test work that is not committed yet, so the harness has a second source `--worktree`
   (mutually exclusive with `--ref`): a snapshot of the working tree (`git ls-files -z --cached --others --exclude-standard`, read-only) streamed as a tar written by a small Node writer
   (`docker-posix-tar.mjs`) into the same container command; there is still no bind mount and no git write. The flag `--bundle` adds the bundle freshness gates to the gate lists and is meant for `--ref` runs on a commit whose bundle the lead has just
   regenerated; `--worktree` runs never use it. Every docker command that builds or starts something runs under the `docker` lock of the plan (exclusive, 45 minutes).
5. **Verification limits**: Docker covers Linux x64/arm64, glibc and musl. macOS branches (`ps` process listing, lock-file mutex, socket folder under `os.tmpdir()`, `/usr/bin/open`) run
   in the macOS job only; until it has run they stay marked UNVERIFIED in the code comments and the release report.
6. **Private repository cost**: hosted minutes are multiplied (Windows x2, macOS x10); milestone pushes only, `concurrency` cancels superseded runs of the same ref.

## Consequences
- A red CI is visible to the lead without `gh`; the branch is a normal git object, available offline after a fetch.
- Before the repository becomes public the owner decides whether the `ci-status` branch is deleted or kept (it holds only gate names, durations and short sanitized failure tails).
- The bundle freshness gate means a milestone push is green only if the lead regenerated the bundle first.
- Repository settings must allow the workflow token to write (`Settings -> Actions -> General -> Workflow permissions`); the `report` job declares its own `contents: write`.

## Alternatives rejected
- `gh` CLI or the REST API: not installed; needs a personal token on the dev machine.
- Commit statuses / check runs only: readable only through the API.
- Artifacts only: need the API and a token to download.
- Bind-mounting the working tree into containers: a test bug could modify the live tree; line endings and permissions differ from a checkout.
- Running the whole matrix on every push: private-repo minute multipliers and the Docker VM size.
- Parallel containers: the Docker VM has 8 GB and another session uses it.

## Evidence
- 2026-10-18: Docker Desktop 29.7.2 (containerd image store, 12 CPUs, 8 GB), images `node:22-bookworm-slim` (v22.23.3), `node:24-bookworm-slim` (v24.22.0),
  `node:26-bookworm-slim` (v26.12.0), `node:24-alpine` (musl) present; linux/arm64 emulation worked for `node:24-alpine` and `node:22-bookworm-slim` (`uname -m` aarch64, `node` arm64, the
  `node:sqlite` probe ran). Containers started by the probes carried `--rm` and the label `mcs-v4=plan-probe-A-platform`. Other containers on the machine (a compose project of another session) were not touched.
- `git ls-remote --tags --refs` on 2026-10-18 for the four actions (SHAs above).
