# Work package status (walking skeleton)

Generated from git history and the lead's overrides: 2026-10-12 08:51 local. Checkpoint: **2026-10-12 12:00 local (moved from 06:00 to 09:00 to 12:00 by the owner)** (no new WP after it). Never PASS unless the checks ran: a `committed` row means an independent verifier passed the WP gates and the committer ran `wp-gate end`.

Scope (owner decision, plan 90 section 9A): a walking skeleton alongside the Python skill (SKILL.md and the Python code are untouched): transcript importer -> database -> query API -> web list page and detail page, started by the standard CLI.

| WP | title | status | commit | date | notes |
|---|---|---|---|---|---|
| WP-14 | Engine ops: workspace, config, audit | committed (checks ran: see commit) | 7ceccd4 | 2026-10-12 02:11 |  |
| WP-15 | CLI kernel and config commands | committed (checks ran: see commit) | 53ed1a4 | 2026-10-12 02:44 | `check` does not yet print the detected transcripts folder: the discovery/probe/route-file call sites are seams (CR-WP-15-2), wired by the owners later |
| WP-17 | Server app, meta routes, static hosting | committed (checks ran: see commit) | 7f291d7 | 2026-10-12 03:38 |  |
| WP-18 | Server process shell | committed (checks ran: see commit) | cd39696 | 2026-10-12 04:58 |  |
| WP-19 | Lifecycle ops and CLI | committed (checks ran: see commit) | 4bbaca9 | 2026-10-12 06:04 | smoke gate PASS after a kit fix (build stamp); POSIX branches unverified |
| WP-25 | Hook handler and stub | committed (checks ran: see commit) | be8d945 | 2026-10-12 02:33 |  |
| WP-26 | Ingestion primitives: tailer and normalizers | committed (checks ran: see commit) | d61a93c | 2026-10-12 02:39 |  |
| WP-27 | Token accounting | committed (checks ran: see commit) | c1a0cf7 | 2026-10-12 02:55 |  |
| WP-28 | Lifecycle model | committed (checks ran: see commit) | 794e4de | 2026-10-12 03:40 |  |
| WP-32 | Hook path to the database | committed (checks ran: see commit) | dd0cb61 | 2026-10-12 04:42 | activity throttle and ingest-replay audit left to WP-35/WP-38 (see plan note) |
| WP-33 | Transcript entries, index, window, locate | committed (checks ran: see commit) | 1ee78d0 | 2026-10-12 04:28 |  |
| WP-30 | Query layer A: sessions, agents, events, tool calls | committed (checks ran: see commit) | de76878 | 2026-10-12 04:36 |  |
| WP-34 | Transcript importer | committed (checks ran: see commit) | 62e480d | 2026-10-12 05:35 | KNOWN LIMITATION: usage applied after the cursor commit can be lost if the process is killed in between (CR-WP-34-1 accepted for the skeleton; follow-up: usage row kind in the WP-32 writer). readEntryText signature differs from the registry (CR-WP-34-3). |
| WP-35 | Ingest service, sweeper, external evidence, ingestion health, DB schedule | committed (checks ran: see commit) | 10041cb | 2026-10-12 06:58 |  |
| WP-31 | Query layer B: overview, work items, alerts, errors | committed (checks ran: see commit) | 6de2418 | 2026-10-12 05:01 | stretch item, committed |
| WP-36 | Stream: hub, hydration, SSE | committed (checks ran: see commit) | ba4097d | 2026-10-12 05:19 | stream hub + SSE (server side); the web client is wired to it since LF-7, and LF-8, LF-9, LF-10 completed the live behaviour |
| WP-44 | Web scaffold | committed (checks ran: see commit) | 695e4d6 | 2026-10-12 02:32 |  |
| WP-45 | Pure lib port | committed (checks ran: see commit) | e3677ad | 2026-10-12 02:26 |  |
| WP-46 | Data layer | committed (checks ran: see commit) | 397b4ec | 2026-10-12 02:56 |  |
| WP-47 | Stream client and reconciliation | committed (checks ran: see commit) | 3a6ca83 | 2026-10-12 03:25 | stream client committed; mounted in the built app by LF-7 (no longer 'fake stream only') |
| WP-48 | Connection and freshness UI | committed (checks ran: see commit) | 180cb50 | 2026-10-12 07:55 |  |
| WP-49 | Shell, sidebar, prefs | committed (checks ran: see commit) | 33ac6e9 | 2026-10-12 03:15 |  |
| WP-50 | Sessions explorer and list components | committed (checks ran: see commit) | c9f6cd7 | 2026-10-12 03:48 |  |
| WP-51 | Transcript viewer and text primitives | committed (checks ran: see commit) | 7d83148 | 2026-10-12 03:38 |  |
| WP-52 | Session detail page | committed (checks ran: see commit) | 33cbe51 | 2026-10-12 04:00 |  |
| LF-5 | Walking-skeleton smoke at API level: fixture -> import -> list -> detail (harness) | committed (checks ran: see commit) | 2c47b26 | 2026-10-12 07:08 |  |
| LF-2 | Walking-skeleton smoke in the browser: list page, detail page | committed (checks ran: see commit) | a47f7e1 | 2026-10-12 07:35 | browser smoke: fixture -> import -> list page -> detail page; found the ApiContext blocker (fixed by LF-6) |
| LF-6 | Web wiring blocker: API client provided in the built app | committed (checks ran: see commit) | 71a4cc6 | 2026-10-12 07:27 |  |
| LF-7 | Stream client mounted in the built app + live-update e2e | committed (checks ran: see commit) | 922126e | 2026-10-12 08:20 | process deviation accepted by the lead: the implementer ran git stash/pop (tree and stash list verified intact, no other uncommitted work existed) |
| LF-8 | TopBar in the shell, eslint stream pattern, chip e2e | committed (checks ran: see commit) | 4006254 | 2026-10-12 08:33 |  |
| LF-9 | Stream session/upsert frames carry the committed token totals | committed (checks ran: see commit) | 5e95a27 | 2026-10-12 08:35 |  |
| LF-10 | Explorer list-changed notice while the stream is live | committed (checks ran: see commit) | 5452fb3 | 2026-10-12 08:29 | sticky styling of the notice left to a follow-up (CR-LF-10-1) |
| WP-01 | Monorepo scaffold and gates | committed (foundation, before the scope change) | 46bead4 | 2026-10-11 19:22 |  |
| WP-02 | Shared contracts: ids, time, files, runtime config sections, CLI results, control protocol | committed (foundation, before the scope change) | 5ac95a4 | 2026-10-11 19:59 |  |
| WP-03 | Shared API and panel contracts | committed (foundation, before the scope change) | 8676f34 | 2026-10-11 21:25 |  |
| WP-04 | Hook protocol contracts | committed (foundation, before the scope change) | 88840a3 | 2026-10-11 20:13 |  |
| WP-05 | Python compatibility: PyJson and regex translator | committed (foundation, before the scope change) | 4ca9ba9 | 2026-10-11 22:18 |  |
| WP-06 | Testkit core and fixtures | committed (foundation, before the scope change) | 7c75653 | 2026-10-11 20:53 |  |
| WP-07 | Platform layer, mutex and markers | committed (foundation, before the scope change) | 43d798a | 2026-10-11 23:01 |  |
| WP-08 | Security primitives | committed (foundation, before the scope change) | 3ce211e | 2026-10-12 00:33 |  |
| WP-09 | DB core | committed (foundation, before the scope change) | e1e4bc7 | 2026-10-11 22:41 |  |
| WP-10 | Write-path repositories and change sink | committed (foundation, before the scope change) | 44d90c6 | 2026-10-12 00:10 |  |
| WP-11 | Entity and operations repositories | committed (foundation, before the scope change) | ae347c1 | 2026-10-12 00:46 |  |
| WP-12 | Config resolution | committed (foundation, before the scope change) | dfc27d7 | 2026-10-11 23:33 |  |
| WP-13 | Workspace and audit | committed (foundation, before the scope change) | dcf697a | 2026-10-12 00:47 |  |
| WP-16 | Composition root | committed (foundation, before the scope change) | b0e03b9 | 2026-10-12 01:41 |  |
| WP-23 | Tooling tests, JSON Schema generator, inactive CI | committed (foundation, before the scope change) | 9a19c22 | 2026-10-11 21:57 |  |
| WP-24 | Golden generator (Python oracle) | committed (foundation, before the scope change) | 15c4c86 | 2026-10-11 20:04 |  |
| LF-1 |  | committed (foundation, before the scope change) | 2e3ea85 | 2026-10-12 00:41 |  |
| LF-3 | Integration coherence fixes from the clean-checkout gate | committed (foundation, before the scope change) | 3968fa8 | 2026-10-12 06:53 |  |
| LF-4 | Control channel: ingest-replay for a missing segment | committed (foundation, before the scope change) | 2e4a724 | 2026-10-12 06:55 |  |
| WP-20 | Isolation setup and lifecycle isolation tests | DEFERRED |  |  | isolation-suite setup and lifecycle isolation tests: release gate, not needed by the skeleton |
| WP-21 | Launcher | DEFERRED |  |  | launcher scripts/mcs.mjs: the skeleton starts from the cli package entry |
| WP-22 | Instances, doctor, diagnostics | DEFERRED |  |  | instances/doctor/diagnostics commands: not needed by the skeleton |
| WP-29 | Completion evidence end to end | DEFERRED |  |  | completion-evidence extras |
| WP-37 | Hooks installer | DEFERRED |  |  | hooks installer: out of scope (owner) |
| WP-38 | Hooks and ingest CLI | DEFERRED |  |  | hooks and ingest CLI commands: out of scope (hooks) |
| WP-39 | Ingestion integration and ingestion isolation rows | DEFERRED |  |  | ingestion integration and isolation rows: release gate |
| WP-40 | Attempts | DEFERRED |  |  | attempts: out of scope (owner) |
| WP-41 | Panels: samplers, service, route, runtime wiring | DEFERRED |  |  | panels/samplers: out of scope (owner) |
| WP-42 | Testkit legacy builders | DEFERRED |  |  | testkit legacy builders: out of scope (owner) |
| WP-43 | Parity harness base and L1 vectors | DEFERRED |  |  | parity harness: out of scope (owner) |
| WP-53 | Activity feed | DEFERRED |  |  | activity feed page: out of scope (owner) |
| WP-54 | Overview page | DEFERRED |  |  | overview page: out of scope (owner) |
| WP-55 | Scenario catalogue and testkit CLI | DEFERRED |  |  | scenario catalogue and testkit CLI: not needed by the skeleton |
| WP-56 | Cross-stack tests and Phase 4 E2E smoke | DEFERRED |  |  | cross-stack tests and Phase 4 E2E: replaced by the single skeleton smoke test LF-2 |
| WP-57..WP-68 |  | DEFERRED |  |  | Phase 5 (search, analytics, alerts, export/retention, readers, backup/upgrade, benchmarks, MCP, panels/board/settings UI): deferred by the owner |
| WP-69..WP-79 |  | DEFERRED |  |  | Phase 6 (parity, E2E completion, security/data/resilience suites, release tooling, docs, SKILL.md candidate): deferred by the owner except the single smoke test LF-2 |

## Handoff

Handoff note: `docs/design/handoff-walking-skeleton.md` (what exists, how to run it, what was verified on a clean checkout at 5e95a27, known limitations, deferred list, decisions for the owner). Change requests: `docs/design/change-requests.md`.
