# Handoff: V3 walking skeleton

Written 2026-10-12 for the owner. Branch `feat/v3-node-runtime`, now also `main` (76 commits after the rollback tag `pre-v3-python`). Everything below
that claims a result comes from a command that was run in this session; the sources are named in each section.

## What exists

A second, Node.js/TypeScript implementation of the monitor next to the Python skill. The Python code, `SKILL.md`, `template/`,
`config/`, `reference/`, the old `docs/*.md` and the legacy tests are byte-identical to the tag `pre-v3-python`
(`git diff --exit-code pre-v3-python -- src template config reference SKILL.md tests/fixtures tests/frontend tests/tools` is empty).
The new code lives in `runtime/` (npm workspaces: `shared`, `engine`, `server`, `cli`, `testkit`, `web`).

The flow that works end to end: Claude Code transcript files -> transcript importer -> SQLite database of the instance -> query API
`/api/v3/*` plus the server-sent event stream -> React pages (session list, session detail, shell with connection and
ingestion chips), started and stopped by the CLI.

Work packages: every package in the walking-skeleton scope is committed. G1: WP-14, 15, 17, 18, 19. G2: WP-25, 26, 27, 28, 30, 32, 33, 34, 35
and the stretch items WP-31, WP-36. G3: WP-44 to WP-52 (WP-48 was a stretch item). Also committed: the foundation packages (WP-01 to WP-13, 16, 23, 24,
LF-1) and the follow-up items LF-2 to LF-10 that the integration gates and the browser smoke test found. The per-WP table with commits is
`docs/design/wp-status.md` (generated; never marks a row done unless its checks ran).

## How to run it

From the skill folder (Windows; POSIX is not verified):

```
cd runtime
npm ci                # the gates used `npm ci --offline` from the local cache
npm run build
node packages/cli/dist/main.js version      # prints "build current" when the build matches the sources
```

A monitor is one task workspace per repository. These commands were run by hand on 2026-10-12 against a throw-away repository and
synthetic transcripts (`python tests/fixtures/make.py OUTDIR`), then the instance was stopped and the port was closed:

```
M="node packages/cli/dist/main.js"
$M init --slug demo --repo <repo> --port <free port>          # not 8765 or 8771 (the live monitors)
$M configure --task demo --repo <repo> --set 'transcripts_dir="<folder with the .jsonl files>"'
$M configure --task demo --repo <repo> --set 'session_rules=[{"match":"<regex on the first prompt>","label":"<label>"}]' --reason "why"
$M check   --task demo --repo <repo>
$M start   --task demo --repo <repo>        # prints the URL (loopback only)
$M verify  --task demo --repo <repo>        # health, instance, sessions, overview return valid bodies
$M status  --task demo --repo <repo>        # JSON: url, pid, uptime, sessions by state, recent errors
$M stop    --task demo --repo <repo>
```

Without a `session_rules` entry the session list is empty (same rule as the Python skill): in the hand run, `verify` said
"sessions (0)" before the rule and "sessions (5)" after it plus a restart. `configure` leaves `restart_needed: true`; run `restart`.
Open the printed URL in a browser for the list and detail pages.

## What was verified (clean checkout, HEAD `5e95a27`, gate run 3)

Source: `private/scratch/mcs-v3/qa-report3.md` (not in the repository). A detached worktree of committed content only, Node 24.14.1.

| check | result |
|---|---|
| `node scripts/ci.mjs --offline --keep-going` | 7 of 7 gates pass: format, lint, typecheck (8 projects), check:deps, build (initial JS 149.6 of 200 kB), test (316 files, 6267 tests passed, 2 skipped), smoke |
| `npm run test:tooling` / `test:isolation` / `test:resilience` | 174 of 174 / 5 of 5 / 6 of 6 pass |
| Playwright skeleton spec (3 specs, `retries: 0`), run three times | 3 of 3 pass each time |
| `npm run schemas:check` | pass: 87 files identical, 2 pending |
| legacy Python tests / legacy frontend tests | 56 OK / 37 of 37 pass |
| diff of the legacy trees against `pre-v3-python` | empty |

The browser spec covers: list page and detail page show the fixture sessions; the open list page follows the stream (a new session and a
new turn appear without a reload); after the instance stops the page keeps its rows and the connection chip leaves "live".
The sample for flakiness is small (one full CI run, three browser runs).

## Known limitations

- Usage rows of the importer are applied after the cursor commit; a hard kill between the two loses them (CR-WP-34-1, accepted for the
  skeleton; the fix is a usage row kind in the WP-32 writer).
- `check` and `start` rely on an explicit `transcripts_dir`; auto-detection of the transcripts folder, the probe and the route file are
  seams that are not wired (CR-WP-15-2).
- Hooks: the handler (WP-25) and the hook-to-database path (WP-32) exist and are tested, but no hook is installed anywhere and the
  installer and ingest commands are deferred. The skeleton gets its data from transcripts only.
- Windows only: POSIX branches are written but unverified.
- `schemas:check` has 2 pending schemas (config and diagnostics are not exported by `@mcs/shared` yet).
- The notice of the explorer ("list changed") has no sticky styling (CR-LF-10-1).
- 158 change requests were filed by implementers and verifiers (`docs/design/change-requests.md`). The design documents and the
  contract registry `98-contract-registry.md` are NOT synced with them; where they disagree, the committed and tested code is the
  working truth.
- Process deviation, accepted: the implementer of LF-7 ran `git stash` and `git stash pop` once (the tree and the stash list were
  checked afterwards and nothing else was uncommitted).

## Deferred (not started, by the owner's scope decision)

WP-20 (isolation suite), WP-21 (launcher `scripts/mcs.mjs`), WP-22 (instances/doctor), WP-29, WP-37 and WP-38 (hooks installer and
commands), WP-39, WP-40, WP-41, WP-42, WP-43, WP-53, WP-54, WP-55, WP-56, Phase 5 (WP-57 to WP-68) and Phase 6 (WP-69 to WP-79, except
the single smoke test LF-2 that exists). Reasons per row are in `docs/design/wp-status.md`.

## Safety

The live monitors (:8765, :8771) and the blog servers (:3000, :8080) kept their process ids during the gates. No hook was installed in any
settings file. Test instances used ports from the 18000-18999 range and were stopped. The legacy monitor runs from files that did not change.

## Decisions for the owner

1. Merged (the owner decided on 2026-10-12): `main` was fast-forwarded to `feat/v3-node-runtime` (local only, nothing pushed to `origin`).
   `SKILL.md` still describes only the Python engine; nothing tells an agent to use the Node CLI yet. To go back to the old state, check out
   the tag `pre-v3-python`, or move `main` back with `git branch -f main pre-v3-python` while another branch is checked out.
2. Whether to continue with the deferred list. A sensible order: WP-21 launcher and WP-22 diagnostics (daily use), WP-20 isolation suite,
   WP-37/38 hooks (needs consent: hooks change settings for every session), then the Phase 5 features.
3. A documentation sync that folds the change requests into the registry and the design documents.
