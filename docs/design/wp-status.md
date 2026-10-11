# Work package status (walking skeleton)

Generated from git history and the lead's overrides: 2026-10-12 03:00 local. Checkpoint: **2026-10-12 12:00 local (moved from 06:00 to 09:00 to 12:00 by the owner)** (no new WP after it). Never PASS unless the checks ran: a `committed` row means an independent verifier passed the WP gates and the committer ran `wp-gate end`.

Scope (owner decision, plan 90 section 9A): a walking skeleton alongside the Python skill (SKILL.md and the Python code are untouched): transcript importer -> database -> query API -> web list page and detail page, started by the standard CLI.

| WP | title | status | commit | date | notes |
|---|---|---|---|---|---|
| WP-14 | Engine ops: workspace, config, audit | committed (checks ran: see commit) | 7ceccd4 | 2026-10-12 02:11 |  |
| WP-15 | CLI kernel and config commands | committed (checks ran: see commit) | 53ed1a4 | 2026-10-12 02:44 |  |
| WP-17 | Server app, meta routes, static hosting | fix round 1 (verifier FAIL: 1 major, 7 minor) |  |  |  |
| WP-18 | Server process shell | waiting for WP-17 |  |  |  |
| WP-19 | Lifecycle ops and CLI | waiting for WP-18 |  |  |  |
| WP-25 | Hook handler and stub | committed (checks ran: see commit) | be8d945 | 2026-10-12 02:33 |  |
| WP-26 | Ingestion primitives: tailer and normalizers | committed (checks ran: see commit) | d61a93c | 2026-10-12 02:39 |  |
| WP-27 | Token accounting | committed (checks ran: see commit) | c1a0cf7 | 2026-10-12 02:55 |  |
| WP-28 | Lifecycle model | implementing |  |  |  |
| WP-32 | Hook path to the database | waiting for WP-17, WP-28 |  |  |  |
| WP-33 | Transcript entries, index, window, locate | waiting for WP-17 |  |  |  |
| WP-30 | Query layer A: sessions, agents, events, tool calls | waiting for WP-17 |  |  |  |
| WP-34 | Transcript importer | pending |  |  |  |
| WP-35 | Ingest service, sweeper, external evidence, ingestion health, DB schedule | pending |  |  |  |
| WP-31 | Query layer B: overview, work items, alerts, errors | pending |  |  | stretch: only if time remains |
| WP-36 | Stream: hub, hydration, SSE | pending |  |  | stretch: only if time remains (stream); if skipped WP-47 is built against a fake stream, not integrated |
| WP-44 | Web scaffold | committed (checks ran: see commit) | 695e4d6 | 2026-10-12 02:32 |  |
| WP-45 | Pure lib port | committed (checks ran: see commit) | e3677ad | 2026-10-12 02:26 |  |
| WP-46 | Data layer | committed (checks ran: see commit) | 397b4ec | 2026-10-12 02:56 |  |
| WP-47 | Stream client and reconciliation | implementing |  |  |  |
| WP-49 | Shell, sidebar, prefs | implementing |  |  |  |
| WP-50 | Sessions explorer and list components | pending |  |  |  |
| WP-51 | Transcript viewer and text primitives | implementing |  |  |  |
| WP-52 | Session detail page | pending |  |  |  |
| LF-2 | Walking-skeleton smoke test: fixture -> import -> list page -> detail page | pending |  |  |  |
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
| WP-48 | Connection and freshness UI | DEFERRED |  |  | connection/freshness UI: needs the stream; not in the skeleton list |
| WP-53 | Activity feed | DEFERRED |  |  | activity feed page: out of scope (owner) |
| WP-54 | Overview page | DEFERRED |  |  | overview page: out of scope (owner) |
| WP-55 | Scenario catalogue and testkit CLI | DEFERRED |  |  | scenario catalogue and testkit CLI: not needed by the skeleton |
| WP-56 | Cross-stack tests and Phase 4 E2E smoke | DEFERRED |  |  | cross-stack tests and Phase 4 E2E: replaced by the single skeleton smoke test LF-2 |
| WP-57..WP-68 |  | DEFERRED |  |  | Phase 5 (search, analytics, alerts, export/retention, readers, backup/upgrade, benchmarks, MCP, panels/board/settings UI): deferred by the owner |
| WP-69..WP-79 |  | DEFERRED |  |  | Phase 6 (parity, E2E completion, security/data/resilience suites, release tooling, docs, SKILL.md candidate): deferred by the owner except the single smoke test LF-2 |

## Handoff

(to be written at the checkpoint)
