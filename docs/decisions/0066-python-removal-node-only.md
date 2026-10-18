# 0066 Python is removed: the Node runtime is the only engine; goldens are frozen, not regenerated

Status: Accepted (V4, milestone M0, 2026-10-18). Owner: V4 area B (Python removal). Supersedes ADR 0056 (cutover gates and the
Python fallback), ADR 0044 (Python oracle and parity harness), ADR 0053 (frozen-clock golden capture by Python) and ADR 0054
(testkit byte-identical legacy trees). Amends ADR 0055 (fix-or-reproduce table). The configuration consequences are in
ADR 0067 (amends ADR 0002 and ADR 0003); the one-time workspace conversion is ADR 0068.

## Context
The V3 skill kept a Python engine (`src/backend`, `template/viewer.py`, `src/frontend`, 23 tracked `.py` files, 5,913 lines) next to
the Node runtime so that the Node runtime could be proved equal to it (parity harness, Python-generated goldens, cross-engine
tests, `engine: legacy` delegation) and so that agents had a documented fallback (ADR 0056: Python stays for one minor
release and 30 days, removing it needs a new ADR). The owner decided on 2026-10-18 (V4 decisions 1, 3 and 9) that a user machine
needs only Node, that Python leaves both the user machines and the developer toolchain, and that the parity-only work packages
(WP-42, 43, 63, 69, 70, LS-6a and gates G1, G2, G7 of ADR 0056) are dropped. The fact report of the same day found that three
things stood in the way of a plain delete: two Node tests fail without Python or `src/backend`, Node tests read frozen golden
data, and the Windows rename-retry tests used Python only as a file holder that opens without FILE_SHARE_DELETE.

## Decision
1. The Node runtime is the only engine. The working tree no longer contains `src/`, `template/`, `tests/*.py`,
   `tests/fixtures/make.py`, `tests/frontend/`, `tests/tools/`, `tests/legacy-parity/` (generators and the golden data nobody
   reads) and `reference/viewer-reference.md`. The last commit that has all of them is `8ca9475`; the tag `pre-v3-python` stays and the
   lead adds the tag `v3-last-with-python` on `8ca9475`. Six Python-era top-level documents move to `docs/legacy/` with a banner
   and are deleted when the 4.0 documentation (M8) replaces them; `docs/configuration.md` stays and is corrected in place (the dialect, the time format and the
   migration command), so nothing in the repository tells an agent that Python is current.
2. Golden data that a Node test still reads is frozen as committed JSON next to that test and never regenerated (the generators
   are deleted): the lifecycle vectors, the clip vectors, the external-state vectors (input for the attempts work package), the
   regex translator corpus (used only by the migration path of ADR 0068), the recorded configuration session and the numbers of the
   usage worked example. A frozen file may be changed only together with the test that reads it and a written reason. The
   Python-derived PyJson golden is retired with the requirement it proved (ADR 0067).
3. Code that existed only for the Python engine is removed: the `engine: 'legacy'` value of `instance.json`, the delegation seam
   of `ops/lifecycle.ts`, the `legacy-running` and `legacy-stale` probe states and the `viewer.py` command-line marker, the
   `python` child-process kind, the error codes `ENGINE_CONFLICT` and `LEGACY_ENGINE_UNAVAILABLE`, `init --engine`, the legacy-engine line of
   `discover` and `version`, the environment variables `MCS_PYTHON`, `MCS_GOLDEN_LIVE_CONFIG`, `MCS_GOLDEN_DIR`, `MCS_PARITY_LIVE`, the
   `./legacy` export of the testkit and the empty marker blocks of WP-42, WP-43 and WP-63. A monitor that this runtime did not start
   (a `state.json` without `engine: node` whose process answers) is reported as `unmanaged-running`, never signalled, and blocks `start`,
   `verify` and `migrate-workspace`.
4. What Python gave is replaced by Node-only tests: the Python file holder by a PowerShell holder that opens with `FileShare.Read`
   (testkit `holdFileOpen`), the Python usage oracle by the frozen numbers, the cross-engine rows by the recorded session replay, the
   legacy audit check by the Node `audit` command. The `parity` vitest project becomes the `slow` project (heavy data-driven suites,
   run by `ci:full`).
5. ADR 0056's gates are waived as follows. G1, G2, G7 and G8 (Python parity, shadow runs, rollback rehearsal, byte-identical open of
   existing tasks) are moot. G3 to G6 and G9 continue as the V4 release gates of the V4 plan (lifecycle property tests, E2E, budgets,
   isolation, documentation). G10 (explicit owner approval) is replaced by the owner's V4 decisions and the owner's review at the end of the run.
6. There is no in-product fallback. Rolling back means checking out `pre-v3-python` or `v3-last-with-python`; `mcs migrate-workspace`
   keeps a copy of every file it changes so a workspace can be put back.
7. No tool in the repository starts Python: no CI step installs it, no test spawns it, and `tests/tooling/python-free.test.ts`
   fails when a Python file, a forbidden token or a Python process reference appears (the Python regex translator of the migration
   path is the one named exception because it is TypeScript code that parses Python regex syntax).

## Consequences
- The repository and the toolchain need only Node; the public repository carries no unused Python code or generators.
- The differential oracle is gone: new behaviour is checked by tests and the frozen data, not by running the old engine. Where the old
  engine was the only specification (the attempts and panels work), the implementers use the frozen vectors and the design documents.
- Users of the Python skill cannot fall back inside the product. The one-time command (ADR 0068) and the backup it writes are the
  safety net, together with the git tags.
- The history keeps everything: `git show 8ca9475:<path>` returns any deleted file, golden data included.

## Alternatives rejected
- Keep Python as a development-only oracle: keeps a second toolchain, the 195 golden files and the generators in a public repository, and
  keeps the tests that fail without it.
- Keep the fallback for one more release (ADR 0056 as written): contradicts the owner's decision and doubles the test surface.
- Delete without freezing: loses regression data that the Node tests still use (classification vectors, clip vectors, regex corpus).
- Freeze everything under `tests/legacy-parity/golden`: 195 files nobody reads; they stay reachable through git history.

## Evidence
- Python coupling fact report (planning notes, not published) (HEAD `8ca9475`): inventory 1a, Node dependencies 1b, ADR map 1c.
- Decisions of 2026-10-18 (owner decision record (planning notes, not published), items 1, 3, 9, 11).
- The Windows holder equivalence is proved by `packages/testkit/src/file-holder.test.ts` (WP-90): a rename of the held file fails
  while the PowerShell holder lives and succeeds after it ends; a plain Node holder does not block it.
