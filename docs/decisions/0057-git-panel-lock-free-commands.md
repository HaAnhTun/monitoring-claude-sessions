# ADR 0057: Git panel: lock-free porcelain v2 status, log only when HEAD moves

Status: Proposed (Phase 1, 2026-10-11). Design reference: `docs/design/06-panels-parity-platform.md` section 3.8.

## Context
The legacy overview runs `git branch --show-current`, `git log -3` and `git status --short` every 10 s while polled, in the owner's repo.
A plain `git status` may refresh and write the index, taking `.git/index.lock`; a concurrent `git commit` by the owner then fails.
Three spawns per refresh also cost CPU.

## Decision
- One `git --no-optional-locks -c core.fsmonitor=false -c color.ui=never status --porcelain=v2 --branch` per refresh (TTL 15 s,
  stale-while-revalidate): `# branch.oid`, `# branch.head` and the entry count (= `status --short` count).
- `git --no-optional-locks log -3 --no-color --format=%h%x1f%aI%x1f%s` only when `branch.oid` changes or every 120 s.
- Environment `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`; real `mingw64\bin\git.exe` on Windows (ADR 0051).
- Not a repository / git missing / dubious ownership are panel states, never errors of the instance.

## Consequences
- The monitor never takes the index lock and never starts an fsmonitor daemon for the owner.
- About 47 ms child CPU per 15 s while a client watches (0.3% of a core), plus a rare log call.

## Alternatives rejected
- Legacy three-command refresh every 10 s: lock risk and more spawns.
- Reading `.git` files directly: re-implements git (packed refs, worktrees, index format).

## Evidence
2026-10-11, Git for Windows (`mingw64/bin/git.exe`), repo `D:/mvp` with 1,184 tracked files: `measure-git.ps1` (E16): branch 15.6 ms /
136 ms wall, log 15.6 / 129, `status --short` 46.9 / 159, `status -uno` 31.2 / 112; through the `cmd/git.exe` shim the real git's CPU is
not attributed. Git documentation of `--no-optional-locks` / `GIT_OPTIONAL_LOCKS` (git(1)).

## Requirements covered
Brief 8.1 (overview panels), 12 (monitoring never interferes with the developer's tools).

## Open items
None.

## Phase 2+ task slices
PP7. Slice table: design section 13.
