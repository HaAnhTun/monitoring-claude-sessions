# 03 Data, API and realtime: persistence, API v3, SSE, search, analytics, alerts, export/retention

Status: Phase 1 design, written 2026-10-11 for the V3 migration (branch `feat/v3-node-runtime`). Owner of this document: the
data/API designer. ADRs 0020-0029 belong to it. Revision 2 (2026-10-11) applies the critic review of
`99-requirements-matrix.md` in place: I-07 (attempts tables), I-30 (legacy health key set), I-31 (no dev origins), I-37 (probe route),
and aligns with I-01, I-02, I-03, I-08, I-10, I-12, I-14, I-15, I-16, I-19, I-20, I-21, I-22, I-32, I-33, I-35 (section 15). Revision 3 adopts `98-contract-registry.md` names: I-08 (completion lookup, errors, schema), I-19 (async audit references), I-21 (`ChildKindStats`), N-08 (`event` entity), and aligns with N-01, N-09, N-10, I-15 (C09) and the N-13 rows C20, C45, C51, C52, C53. Inputs: `docs/design/00-foundations.md` (D1-D15), the owner's brief MEGA-PROMT-V3
(sections 7, 8.1-8.8, 8.10, 10, 11, 12), `docs/research/*`, and the sibling designs written in parallel: `01-instances-config-ops.md`
(workspace, CLI, backups, upgrades, control channel), `02-ingestion-lifecycle.md` (hooks, importer, tokens, lifecycle; it delegates
table names, DDL and indexes to this document), `04-ui.md` (UI; its section 13 lists the contracts it assumed),
`05-tooling-testing-security.md` (request security, ADR 0045) and `06-panels-parity-platform.md` (panels). Section 15 maps every
cross-design contract.

Evidence labels: `[exp:Xn]` = experiment run on 2026-10-11 on this machine (Windows 11, Node 24.14.1, better-sqlite3 13.0.3 bundling
SQLite 3.53.4, Express 5.3.0, Zod 4.6.5), scripts in `D:/mvp/private/scratch/mcs-v3/data-api/`, results in section 18;
`[research:file]` = Phase 0 research file; `[02 x.y]`, `[01 x.y]`, `[04 x.y]` = sibling design sections; `UNVERIFIED` = not measured,
with a plan. All data in experiments was synthetic.

Reading guide for implementers: find your slice in section 23, then read the sections it names. Every guarantee has an id (`DA-...`)
and a test list in section 19.

---

## 1. Scope

In scope (this document decides): the per-instance SQLite schema (DDL, indexes, constraints, retention SQL) for every entity of the
product including the logical entities of `[02 4.1]` and the attempts tables of `[06 3.10]`; the migration runner and the DB functions other designs call (`openInstanceDb`,
`peekDbSchemaVersion`, `planDbMigrations`, `migrateDb`, `backupDb`, `applyRetention`, `exportInstance`); the one repository module that
owns the driver; the read-only HTTP API v3 (every route, schema, error, header, guard) plus the hook nudge route; the SSE change stream
and the client reconciliation rules; transcript access (window, locate) and structured/transcript search; analytics and cost; alerts;
the export format `mcs.export/1`; the API contract test strategy.

Not in scope (owned elsewhere; this document only stores or serves their results; assumed shapes in section 20): the hook handler, the
spool, the transcript importer, token rules and the lifecycle derivation `[02]`; workspace layout, CLI commands and their UX, backup
folders and manifests, restore, upgrade orchestration, cleanup command scopes and confirmations, the control channel `[01]`; panels
data `[06]`; UI rendering `[04]`.

## 2. Invariants (each has tests in section 19)

| Id | Invariant |
|---|---|
| DA-I1 | One SQLite file per instance (`data/monitor.db`); the server process holds the only writer connection; the hook handler never opens it; the CLI opens it only while no server runs (D2, D10, `[01 5.5]`). |
| DA-I2 | The DB never contains prompt text, assistant text, thinking text or signatures, tool-input bodies, tool-result bodies, attachment bodies, account ids or environment values. Allowed bounded text is listed in table 3.1 (labels, titles, 160-code-point summaries and previews, all redacted). |
| DA-I3 | A DB is served only if `PRAGMA application_id = 1296253747` and `meta.instance_id` equals `instance.json.instanceId`; every repository call carries a `RepoContext` whose `instanceId` is asserted (D2). |
| DA-I4 | Applied migrations are checksum-verified; a migration of a non-empty DB runs only after the caller made a backup; a DB newer than the runtime is refused untouched (D10, D13). |
| DA-I5 | The same hook delivery (`event_uid`), the same transcript record (`record_uuid`), the same logical event seen by both sources (`natural_key`), the same tool call (`tool_use_id`) and the same provider message (`message_key`) never create two rows. |
| DA-I6 | Token aggregates are sums over one `usage` row per message key (per-field max over its files, owner = oldest file `[02 6.2]`); session and agent rollup columns equal those sums after every commit. |
| DA-I7 | Every change a client can observe is written to `changes` in the same transaction as the data; the stream publishes only committed rows (persist, then publish, D11). |
| DA-I8 | `changes.seq` is contiguous and strictly increasing; a stream epoch identifies one server process lifetime; every snapshot response carries `asOfSeq` read in the same synchronous step as its data. |
| DA-I9 | No API response claims coverage it does not have: usage carries `completeness`, `lowerBound` and per-field `missing`; search carries `coverage.complete`; unknown values are `null`, never `0`. |
| DA-I10 | No API route accepts a file-system path; every file the server reads is resolved from the DB (`transcript_files.path`, re-checked with `realpath` containment) or from fixed instance folders. |
| DA-I11 | The HTTP API is read-only: the only state-changing route is `POST /api/v3/ingest/nudge`, whose only effect is "drain your own spool now" `[02 2.8]`. Destructive operations are engine functions run by the CLI on a stopped instance `[01 6.4]`. |
| DA-I12 | No transaction spans an `await`; every writer bounds its transactions (ingestion: the `[02 4.6]` tick of 500 items or 8 ms; maintenance: at most 10 sessions per transaction). |
| DA-I13 | API, CLI and UI read the same answers: the server routes and the CLI DB reader call the same engine query functions and validate with the same Zod schemas (`InstanceReader`, `[01 6.1]`). |

## 3. Persistence model

### 3.1 What is stored and what is referenced

The DB is a metadata index over three sources: the hook spool (`data/spool/hooks-<YYYYMMDD>T<HH>Z.ndjson`, extension
`SPOOL_SEGMENT_EXT` of `[02 2.3]` in `shared/src/protocol/hook-envelope.ts`, never `.jsonl`, I-02; envelopes already sanitized by the
handler `[02 2.4]`), the transcript files under the instance's transcripts directory, and monitor-derived facts (lifecycle views,
reconciliations, alerts). A fourth, optional source is the configured chain log (`config.chain_log`): its START/END lines become
`attempt_runs` rows `[06 3.10]`. Transcript text stays in the transcript files and is read on demand (section 7.3, ADR 0022).

| Data | Stored? | Where | Bound / form | Why |
|---|---|---|---|---|
| Provider ids (session, agent, message key, request, tool use, prompt, record uuid, workflow run) | yes | typed columns | verbatim, length-checked | identity, dedupe, joins |
| Timestamps | yes | INTEGER epoch ms UTC | exposed as ISO `...Z` | D10 |
| Session label, AI/custom titles | yes | `sessions.label` (<= 200), `title_ai`/`title_custom` (<= 120) | rule label, or the first prompt clipped to 70 code points for unmatched sessions (legacy parity `[02 5.2]`); titles clipped and redacted | listing, sorting, `q` |
| Tool summaries, notification/reason/subject previews | yes | `tool_calls.summary` (<= 160), `events.summary` (<= 240), `events.detail` | `summarizeToolInput` and previews of `[02 2.4, 2.5]` (160 code points, redacted) | timeline rows without opening transcripts |
| Sanitized hook data | yes | `events.detail` (JSON <= 16 KiB) | the `data` object of the envelope `[02 2.3]` (kept/summarized fields only) | evidence, D-3 dedupe |
| Agent description and label, workflow name/phase | yes | `agents.label`/`description` (<= 160), `workflow_runs.workflow_name` | from `.meta.json` / workflow file scalars `[02 5.1.2]` | hierarchy display |
| Lifecycle facts | yes | `sessions/agents/workflow_runs.facts_json` | semilattice registers of `[02 7.2]`: stamps, enums, counts, hashes | order-independent derivation |
| cwd, git branch, entrypoint, Claude Code version, permission mode, model ids, Claude pid | yes | `sessions` columns | bounded | filters, detail, liveness |
| Lengths, hashes, counts | yes | `events.text_len`, `detail` | numbers and hex prefixes | evidence without content |
| Usage numbers, provider cost-state numbers | yes | `usage_files`, `usage`, `cost_states` | integers / REAL | analytics |
| Chain-log attempts (the runner's own log lines, not transcripts) | yes | `attempt_sources`, `attempt_runs` | regex group text clipped by `AttemptsRepo`: `part` <= 512, `n_raw`/`exit_raw` <= 64, `model` <= 128, `effort` <= 64, `status_raw` <= 512 code points; rendered `evidence` <= 1024 | legacy attempts panel, D9 external evidence `[06 3.10.7]` |
| Prompt, reply, thinking, tool input body, tool result body, attachment bodies | **no** | transcript file, referenced by `(file_id, byte_offset, byte_length)` | read on demand, legacy clips | DA-I2 |
| Signatures, `bridge-session` account ids, env values, control tokens | **never** | - | - | D8, `[02 5.7]` |

### 3.2 Connection model, pragmas, WAL initialisation

One writer connection in the server process (`openInstanceDb({ mode: 'serve' })`). API reads use the same connection: the driver is
synchronous, all work is serialized on the event loop, so a second connection adds no parallelism. The CLI opens the DB itself only
while no server runs: read-only for reads and backups, as the single writer for `db migrate` and `cleanup --scope data` `[01 5.4,
6.4]`; while a server runs, the CLI reads through HTTP and asks for backups through the control channel `[01 4.3]`.

`openInstanceDb` open sequence (`packages/engine/src/db/open.ts`):
1. `new Database(path, { timeout: 5000, fileMustExist: mode !== 'serve' })` (mode `serve` creates a missing file, `[01 4.4]` step 7).
2. New file only: `PRAGMA auto_vacuum = INCREMENTAL` before anything else (it cannot change after the first table) `[exp:X7]`.
3. Writer modes: `PRAGMA journal_mode = WAL` with BUSY retry: on `SQLITE_BUSY` wait 25 ms and retry, at most 20 attempts, then fail
   `db_busy` (cold-start race measured in `[research:stack-versions.md 2.2]`). Read-only mode never changes the journal mode.
4. `PRAGMA synchronous = NORMAL` (WAL + NORMAL survives application crashes; a power loss can lose the last transactions, which are
   re-derived from the spool and transcript cursors, both persisted in the same transactions as their rows).
5. `PRAGMA foreign_keys = ON` (better-sqlite3's build defaults to ON `[exp:X0]`; set explicitly for the `node:sqlite` fallback),
   `temp_store = MEMORY`, `cache_size = -16000` (16 MiB; 64 MiB gave no gain `[exp:X3]`), `journal_size_limit = 67108864`;
   read-only mode adds `PRAGMA query_only = 1`.
6. Identity (DA-I3): `PRAGMA application_id` must be 1296253747 (ASCII "MCS3"); `meta.instance_id` must equal the expected id. A new
   file gets both from the migration runner.
7. Version (D13): `migrationStatus` (4.3). Newer -> `db_newer_than_runtime`; older with pending migrations -> `db_migration_required`
   (`serve` never migrates an existing DB `[01 5.4]`); a new file is migrated to the latest version at once.
8. Opening starts no timer: the background schedule of 11.4 is `createDbScheduler(ctx)`, started and stopped by `[01 4.4]`'s
   `createInstanceRuntime(ctx)` (composition root, I-15).

Exit mapping for the server boot `[01 4.4 step 7]`: `db_identity_mismatch` and `db_not_mcs` -> exit 11; `db_newer_than_runtime` -> 15;
`db_migration_required` -> 16; every other open failure -> 14.

Read-only connections: `new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 })`. Verified: a read-only connection
opens a WAL database whose `-wal`/`-shm` were removed at close, refuses writes with `SQLITE_READONLY`, sees commits of a concurrent
writer `[exp:X1]`, and can run the online backup API `[exp:X12]`.

Facts that shape the design (`PRAGMA compile_options` `[exp:X0]`): `ENABLE_FTS5`, `ENABLE_DBSTAT_VTAB`, `ENABLE_STAT4`,
`ENABLE_UPDATE_DELETE_LIMIT`, `ENABLE_MATH_FUNCTIONS`, `ENABLE_PERCENTILE`, `DEFAULT_WAL_SYNCHRONOUS=1` and **`OMIT_PROGRESS_CALLBACK`**:
a running statement cannot be interrupted, so every query is bounded by indexes, windows and `LIMIT` (6.4). The design uses none of
FTS5, percentile functions or `DELETE ... LIMIT`, so the `node:sqlite` fallback stays possible.

### 3.3 Identity rows and constants

| `meta` key | value | written |
|---|---|---|
| `instance_id` | uuid v4 from `instance.json` | by the migration runner when the file is created; never changed |
| `db_format` | `mcs-monitor-db` | at creation |
| `created_at`, `created_by_runtime` | ISO time, runtime semver | at creation |
| `privacy_profile` | `metadata-v1` (meaning: table 3.1) | at creation; storing content later needs a migration, a new value and an ADR |
| `last_alive_at` | ISO time | every 60 s by the server (input of the downtime reconciliation `[02 8.1]`) |
| `last_shutdown_at` | ISO time | on graceful stop |
| `last_integrity_check` | JSON `{at, kind: 'quick' or 'full', result}` | after each check |

Constants (`packages/shared/src/db-constants.ts`): `APPLICATION_ID = 1296253747`, `CHECKPOINT_EVERY_ENTRIES = 256`,
`WAL_RETRY = { attempts: 20, delayMs: 25 }`. `MAX_LINE_BYTES` (64 MiB) is not defined here: the single constant lives in
`packages/shared/src/protocol/limits.ts` (owned by `[02 1.1]`, I-32; no `runtime.json` key, tests inject a smaller cap as an option) and
is imported by the importer, the entry index (7.2), the transcript window (7.3) and the search (7.4).

### 3.4 Schema conventions (ADR 0020)

- `STRICT` tables; booleans `INTEGER CHECK (x IN (0,1))`; timestamps `INTEGER` ms; JSON columns `TEXT` with `json_valid()` and a cap.
- Small, stable enums (lifecycle, presence, board, statuses) have `CHECK ... IN (...)`; the high-volume `events.kind` has a format check
  only (`<domain>.<verb>`), its values are validated in code, so a new event kind never rebuilds the largest table.
- Hard foreign keys only point at owners: `sessions(id)` `ON DELETE CASCADE`, `projects`, `work_items`. Every other cross-row reference is
  a soft integer id (no `REFERENCES`) checked by the repository: each FK child column needs an index for cascades, secondary indexes are
  the dominant insert cost `[exp:X3]`, all soft-referenced rows die with their session, and out-of-order ingestion may reference rows
  created later in the same transaction.
- Every FK child column leads an index (verified on the final DDL `[exp:X12]`).
- Entities observed by clients carry `updated_seq` (events: `change_seq`): the `changes.seq` of their last visible modification (9.1).

### 3.5 DDL: `runtime/packages/engine/migrations/0001_initial.sql`

Executed verbatim with better-sqlite3 13.0.3 on a fresh file: 28 tables of its own (30 with SQLite's `sqlite_sequence` and the runner's
`schema_migrations`), 52 indexes including autoindexes, `PRAGMA foreign_key_check` empty, every foreign-key child column leads an
index, and every constraint probe of section 19 rejected as expected `[exp:X12, X14]`. The sha256 of the LF-normalised file is recorded
in section 18 (X14). Content status: final. The two conditions the critic set for freezing `0001` are met here: the single `events`
table with the normative natural keys and stored kinds of 3.6 (I-03; `[02 4.1]` adopts them) and the attempts tables (I-07). Slice S1
commits the file with the X14 checksum; from then on it is frozen (DA-I4) and every change is a new migration.
`schema_migrations` is created by the runner (4.2), not by this file.

```sql
-- mcs:migration version=1 name=initial
-- Initial schema of the per-instance monitor database (one file per monitoring instance).
-- Conventions: STRICT tables; timestamps are INTEGER epoch milliseconds UTC; booleans are INTEGER 0/1;
-- provider ids are TEXT kept verbatim; hard foreign keys only point at owners (sessions, projects, work_items);
-- every other cross-row reference is a soft integer id (no REFERENCES) validated by the repository.
-- Logical entities of docs/design/02-ingestion-lifecycle.md 4.1 map to these tables (03 section 3.5, mapping table).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  value TEXT NOT NULL CHECK (length(value) <= 4096)
) STRICT, WITHOUT ROWID;

CREATE TABLE projects (
  id               INTEGER PRIMARY KEY,
  project_key      TEXT NOT NULL UNIQUE CHECK (length(project_key) BETWEEN 1 AND 255 AND project_key = lower(project_key)),
  dir_name         TEXT NOT NULL CHECK (length(dir_name) BETWEEN 1 AND 255),
  root_path        TEXT CHECK (root_path IS NULL OR length(root_path) <= 1024),
  first_seen_at    INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id                 INTEGER PRIMARY KEY,
  session_uid        TEXT NOT NULL UNIQUE CHECK (length(session_uid) = 36 AND session_uid = lower(session_uid)),
  project_id         INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  transcript_file_id INTEGER,                          -- soft ref transcript_files(id): the main file
  label              TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 200),
  label_source       TEXT NOT NULL DEFAULT 'none'
                     CHECK (label_source IN ('rule','custom_title','ai_title','first_prompt','none')),
  matched            INTEGER NOT NULL DEFAULT 0 CHECK (matched IN (0,1)),
  rule_index         INTEGER CHECK (rule_index IS NULL OR rule_index >= 0),
  pinned             INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  title_ai           TEXT CHECK (title_ai IS NULL OR length(title_ai) <= 120),
  title_custom       TEXT CHECK (title_custom IS NULL OR length(title_custom) <= 120),
  search_text        TEXT NOT NULL DEFAULT '' CHECK (length(search_text) <= 1024),
  entrypoint         TEXT CHECK (entrypoint IS NULL OR length(entrypoint) <= 32),
  cc_version         TEXT CHECK (cc_version IS NULL OR length(cc_version) <= 32),
  cwd                TEXT CHECK (cwd IS NULL OR length(cwd) <= 1024),
  git_branch         TEXT CHECK (git_branch IS NULL OR length(git_branch) <= 255),
  permission_mode    TEXT CHECK (permission_mode IS NULL OR length(permission_mode) <= 32),
  last_model         TEXT CHECK (last_model IS NULL OR length(last_model) <= 128),
  models             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(models) AND json_type(models) = 'array' AND length(models) <= 1024),
  claude_pid         INTEGER CHECK (claude_pid IS NULL OR claude_pid > 0),
  continued_in       TEXT CHECK (continued_in IS NULL OR length(continued_in) = 36),
  copied_from        TEXT CHECK (copied_from IS NULL OR length(copied_from) = 36),
  hook_coverage      TEXT NOT NULL DEFAULT 'none' CHECK (hook_coverage IN ('none','full','partial')),
  hook_missing_tools INTEGER NOT NULL DEFAULT 0 CHECK (hook_missing_tools >= 0),
  hook_missing_turns INTEGER NOT NULL DEFAULT 0 CHECK (hook_missing_turns >= 0),
  first_seen_at      INTEGER NOT NULL,
  started_at         INTEGER NOT NULL,
  last_activity_at   INTEGER NOT NULL,
  last_hook_at       INTEGER,
  last_transcript_at INTEGER,
  ended_at           INTEGER,
  -- lifecycle view (02 7.1 LifecycleView); facts are the semilattice registers of 02 7.2
  state              TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN
                     ('running','working','waiting_input','waiting_tool','waiting_agent','turn_ended','completed','failed','stale','unknown')),
  presence           TEXT NOT NULL DEFAULT 'unknown' CHECK (presence IN ('open','ended','unknown')),
  wait_reason        TEXT CHECK (wait_reason IS NULL OR wait_reason IN ('user','permission','elicitation','agent_input','idle_prompt')),
  stale_kind         TEXT CHECK (stale_kind IS NULL OR stale_kind IN ('silent','abandoned','process_gone','parent_ended')),
  end_reason         TEXT CHECK (end_reason IS NULL OR length(end_reason) <= 64),
  turn_outcome       TEXT CHECK (turn_outcome IS NULL OR turn_outcome IN ('ok','error','interrupted')),
  state_basis        TEXT NOT NULL DEFAULT 'inferred' CHECK (state_basis IN ('observed','inferred')),
  state_confidence   TEXT NOT NULL DEFAULT 'low' CHECK (state_confidence IN ('high','medium','low')),
  state_rule         TEXT NOT NULL DEFAULT 'none' CHECK (length(state_rule) BETWEEN 1 AND 16),
  state_evidence     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(state_evidence) AND length(state_evidence) <= 4096),
  state_since        INTEGER,
  evaluated_at       INTEGER,
  next_check_at      INTEGER,
  facts_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facts_json) AND length(facts_json) <= 65536),
  -- counters
  agent_count        INTEGER NOT NULL DEFAULT 0 CHECK (agent_count >= 0),
  event_count        INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  tool_call_count    INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  open_tool_count    INTEGER NOT NULL DEFAULT 0 CHECK (open_tool_count >= 0),
  error_count        INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  warning_count      INTEGER NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  -- usage rollup over the messages this session owns (main agent and its agents; 02 6.2 rule 7)
  usage_messages     INTEGER NOT NULL DEFAULT 0 CHECK (usage_messages >= 0),
  usage_synthetic    INTEGER NOT NULL DEFAULT 0 CHECK (usage_synthetic >= 0),
  usage_unfinalized  INTEGER NOT NULL DEFAULT 0 CHECK (usage_unfinalized >= 0),
  tok_input          INTEGER NOT NULL DEFAULT 0 CHECK (tok_input >= 0),
  tok_output         INTEGER NOT NULL DEFAULT 0 CHECK (tok_output >= 0),
  tok_cache_read     INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_read >= 0),
  tok_cache_creation INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_creation >= 0),
  tok_input_missing  INTEGER NOT NULL DEFAULT 0 CHECK (tok_input_missing >= 0),
  tok_output_missing INTEGER NOT NULL DEFAULT 0 CHECK (tok_output_missing >= 0),
  tok_cache_read_missing     INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_read_missing >= 0),
  tok_cache_creation_missing INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_creation_missing >= 0),
  usage_status       TEXT NOT NULL DEFAULT 'none' CHECK (usage_status IN ('none','partial','complete','unavailable')),
  reported_cost_usd  REAL CHECK (reported_cost_usd IS NULL OR reported_cost_usd >= 0),
  reported_cost_at   INTEGER,
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL,
  CHECK (last_activity_at >= started_at),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
) STRICT;
CREATE INDEX idx_sessions_activity       ON sessions(last_activity_at DESC, id DESC);
CREATE INDEX idx_sessions_state_activity ON sessions(state, last_activity_at DESC);
CREATE INDEX idx_sessions_project        ON sessions(project_id, last_activity_at DESC);
CREATE INDEX idx_sessions_next_check     ON sessions(next_check_at) WHERE next_check_at IS NOT NULL;

CREATE TABLE workflow_runs (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_uid            TEXT NOT NULL CHECK (run_uid GLOB 'wf_*' AND length(run_uid) <= 67),
  workflow_name      TEXT CHECK (workflow_name IS NULL OR length(workflow_name) <= 128),
  launch_tool_use_id TEXT CHECK (launch_tool_use_id IS NULL OR length(launch_tool_use_id) <= 128),
  status_file        TEXT CHECK (status_file IS NULL OR length(status_file) <= 32),
  agent_count        INTEGER CHECK (agent_count IS NULL OR agent_count >= 0),
  started_count      INTEGER NOT NULL DEFAULT 0 CHECK (started_count >= 0),
  result_count       INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  failed_count       INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  started_at         INTEGER,
  ended_at           INTEGER,
  duration_ms        INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  state              TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN
                     ('running','working','waiting_input','waiting_tool','waiting_agent','turn_ended','completed','failed','stale','unknown')),
  stale_kind         TEXT CHECK (stale_kind IS NULL OR stale_kind IN ('silent','abandoned','process_gone','parent_ended')),
  state_basis        TEXT NOT NULL DEFAULT 'inferred' CHECK (state_basis IN ('observed','inferred')),
  state_confidence   TEXT NOT NULL DEFAULT 'low' CHECK (state_confidence IN ('high','medium','low')),
  state_rule         TEXT NOT NULL DEFAULT 'none' CHECK (length(state_rule) BETWEEN 1 AND 16),
  state_evidence     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(state_evidence) AND length(state_evidence) <= 4096),
  state_since        INTEGER,
  evaluated_at       INTEGER,
  next_check_at      INTEGER,
  facts_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facts_json) AND length(facts_json) <= 16384),
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL,
  UNIQUE (session_id, run_uid)
) STRICT;
CREATE INDEX idx_workflow_runs_next_check ON workflow_runs(next_check_at) WHERE next_check_at IS NOT NULL;

CREATE TABLE agents (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_uid          TEXT NOT NULL CHECK (agent_uid = 'main' OR (length(agent_uid) BETWEEN 3 AND 64 AND agent_uid NOT GLOB '*[^0-9A-Za-z_-]*')),
  parent_agent_id    INTEGER,                          -- soft ref agents(id); NULL only for kind 'main'
  kind               TEXT NOT NULL CHECK (kind IN ('main','subagent','workflow_agent','teammate','internal')),
  depth              INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 16),
  agent_type         TEXT CHECK (agent_type IS NULL OR length(agent_type) <= 64),
  label              TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 160),
  description        TEXT CHECK (description IS NULL OR length(description) <= 160),
  request_shape      TEXT CHECK (request_shape IS NULL OR request_shape IN ('foreground','background')),
  spawn_tool_use_id  TEXT CHECK (spawn_tool_use_id IS NULL OR length(spawn_tool_use_id) <= 128),
  workflow_run_id    INTEGER,                          -- soft ref workflow_runs(id)
  workflow_phase     TEXT CHECK (workflow_phase IS NULL OR length(workflow_phase) <= 120),
  model              TEXT CHECK (model IS NULL OR length(model) <= 128),
  transcript_file_id INTEGER,                          -- soft ref transcript_files(id)
  first_seen_at      INTEGER NOT NULL,
  started_at         INTEGER NOT NULL,
  last_activity_at   INTEGER NOT NULL,
  ended_at           INTEGER,
  state              TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN
                     ('running','working','waiting_input','waiting_tool','waiting_agent','turn_ended','completed','failed','stale','unknown')),
  presence           TEXT NOT NULL DEFAULT 'unknown' CHECK (presence IN ('open','ended','unknown')),
  wait_reason        TEXT CHECK (wait_reason IS NULL OR wait_reason IN ('user','permission','elicitation','agent_input','idle_prompt')),
  stale_kind         TEXT CHECK (stale_kind IS NULL OR stale_kind IN ('silent','abandoned','process_gone','parent_ended')),
  end_reason         TEXT CHECK (end_reason IS NULL OR length(end_reason) <= 64),
  turn_outcome       TEXT CHECK (turn_outcome IS NULL OR turn_outcome IN ('ok','error','interrupted')),
  state_basis        TEXT NOT NULL DEFAULT 'inferred' CHECK (state_basis IN ('observed','inferred')),
  state_confidence   TEXT NOT NULL DEFAULT 'low' CHECK (state_confidence IN ('high','medium','low')),
  state_rule         TEXT NOT NULL DEFAULT 'none' CHECK (length(state_rule) BETWEEN 1 AND 16),
  state_evidence     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(state_evidence) AND length(state_evidence) <= 4096),
  state_since        INTEGER,
  evaluated_at       INTEGER,
  next_check_at      INTEGER,
  facts_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facts_json) AND length(facts_json) <= 16384),
  tool_call_count    INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  error_count        INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  usage_messages     INTEGER NOT NULL DEFAULT 0 CHECK (usage_messages >= 0),
  usage_synthetic    INTEGER NOT NULL DEFAULT 0 CHECK (usage_synthetic >= 0),
  usage_unfinalized  INTEGER NOT NULL DEFAULT 0 CHECK (usage_unfinalized >= 0),
  tok_input          INTEGER NOT NULL DEFAULT 0 CHECK (tok_input >= 0),
  tok_output         INTEGER NOT NULL DEFAULT 0 CHECK (tok_output >= 0),
  tok_cache_read     INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_read >= 0),
  tok_cache_creation INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_creation >= 0),
  tok_input_missing  INTEGER NOT NULL DEFAULT 0 CHECK (tok_input_missing >= 0),
  tok_output_missing INTEGER NOT NULL DEFAULT 0 CHECK (tok_output_missing >= 0),
  tok_cache_read_missing     INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_read_missing >= 0),
  tok_cache_creation_missing INTEGER NOT NULL DEFAULT 0 CHECK (tok_cache_creation_missing >= 0),
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL,
  UNIQUE (session_id, agent_uid),
  CHECK ((kind = 'main') = (agent_uid = 'main')),
  CHECK ((kind = 'main') = (parent_agent_id IS NULL)),
  CHECK ((kind = 'main') = (depth = 0))
) STRICT;
CREATE INDEX idx_agents_state_activity ON agents(state, last_activity_at DESC) WHERE kind NOT IN ('main','internal');
CREATE INDEX idx_agents_next_check     ON agents(next_check_at) WHERE next_check_at IS NOT NULL;

CREATE TABLE turns (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id           INTEGER,                          -- soft ref agents(id); NULL = main agent
  prompt_id          TEXT NOT NULL CHECK (length(prompt_id) BETWEEN 1 AND 128),
  started_at         INTEGER,
  ended_at           INTEGER,
  end_kind           TEXT CHECK (end_kind IS NULL OR end_kind IN ('stop','stop_failure','end_turn','turn_duration','interrupted')),
  end_rank           INTEGER,                          -- with ended_at and end_tie: the LWW stamp of end_kind (02 4.3 Stamp)
  end_tie            TEXT CHECK (end_tie IS NULL OR length(end_tie) <= 200),
  origin             TEXT CHECK (origin IS NULL OR length(origin) <= 32),
  tool_count         INTEGER NOT NULL DEFAULT 0 CHECK (tool_count >= 0),
  UNIQUE (session_id, prompt_id),
  CHECK (started_at IS NULL OR ended_at IS NULL OR started_at <= ended_at)
) STRICT;
CREATE INDEX idx_turns_session ON turns(session_id, started_at);

CREATE TABLE transcript_files (
  id                 INTEGER PRIMARY KEY,
  path               TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  path_key           TEXT NOT NULL UNIQUE CHECK (length(path_key) BETWEEN 1 AND 1024),
  kind               TEXT NOT NULL CHECK (kind IN ('session','subagent','workflow_agent','workflow_journal','workflow_status')),
  session_uid        TEXT NOT NULL CHECK (length(session_uid) = 36),
  agent_uid          TEXT CHECK (agent_uid IS NULL OR length(agent_uid) <= 64),
  run_uid            TEXT CHECK (run_uid IS NULL OR length(run_uid) <= 67),
  session_id         INTEGER,                          -- soft ref sessions(id); NULL after cleanup (retired tombstone)
  agent_id           INTEGER,                          -- soft ref agents(id)
  workflow_run_id    INTEGER,                          -- soft ref workflow_runs(id)
  -- identity and import cursors (02 5.3-5.5): 0 <= head_end <= backfill_offset <= tail_start <= tail_offset <= size_seen
  ino                TEXT CHECK (ino IS NULL OR length(ino) <= 40),
  head_len           INTEGER NOT NULL DEFAULT 0 CHECK (head_len BETWEEN 0 AND 256),
  head_hash          TEXT CHECK (head_hash IS NULL OR length(head_hash) = 64),
  head_end           INTEGER NOT NULL DEFAULT 0,
  backfill_offset    INTEGER NOT NULL DEFAULT 0,
  tail_start         INTEGER NOT NULL DEFAULT 0,
  tail_offset        INTEGER NOT NULL DEFAULT 0,
  partial_bytes      INTEGER NOT NULL DEFAULT 0 CHECK (partial_bytes >= 0),
  size_seen          INTEGER NOT NULL DEFAULT 0 CHECK (size_seen >= 0),
  mtime_seen         INTEGER,
  birth_ms           INTEGER,
  first_seen_mtime_ms INTEGER,
  line_count         INTEGER NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  state              TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','missing','unreadable','untracked','retired')),
  usage_state        TEXT NOT NULL DEFAULT 'partial' CHECK (usage_state IN ('complete','partial','skipped_backfill')),
  invalid_json       INTEGER NOT NULL DEFAULT 0 CHECK (invalid_json >= 0),
  not_object         INTEGER NOT NULL DEFAULT 0 CHECK (not_object >= 0),
  shape_invalid      INTEGER NOT NULL DEFAULT 0 CHECK (shape_invalid >= 0),
  oversized          INTEGER NOT NULL DEFAULT 0 CHECK (oversized >= 0),
  utf8_invalid       INTEGER NOT NULL DEFAULT 0 CHECK (utf8_invalid >= 0),
  bom_stripped       INTEGER NOT NULL DEFAULT 0 CHECK (bom_stripped >= 0),
  crlf_lines         INTEGER NOT NULL DEFAULT 0 CHECK (crlf_lines >= 0),
  unknown_types      INTEGER NOT NULL DEFAULT 0 CHECK (unknown_types >= 0),
  read_errors        INTEGER NOT NULL DEFAULT 0 CHECK (read_errors >= 0),
  identity_resets    INTEGER NOT NULL DEFAULT 0 CHECK (identity_resets >= 0),
  classified_lines   INTEGER NOT NULL DEFAULT 0 CHECK (classified_lines >= 0),
  label_cache        TEXT CHECK (label_cache IS NULL OR length(label_cache) <= 200),
  first_ts_in_order  TEXT CHECK (first_ts_in_order IS NULL OR length(first_ts_in_order) <= 40),
  max_ts_string      TEXT CHECK (max_ts_string IS NULL OR length(max_ts_string) <= 40),
  last_stop_legacy   TEXT CHECK (last_stop_legacy IS NULL OR length(last_stop_legacy) <= 32),
  behind_since       INTEGER,
  discovered_at      INTEGER NOT NULL,
  last_read_at       INTEGER,
  last_growth_at     INTEGER,
  -- entry index of the transcript view (03 7.2), independent of the import cursors
  index_offset       INTEGER NOT NULL DEFAULT 0 CHECK (index_offset >= 0),
  index_head_hash    TEXT CHECK (index_head_hash IS NULL OR length(index_head_hash) = 64),
  entries_total      INTEGER NOT NULL DEFAULT 0 CHECK (entries_total >= 0),
  updated_at         INTEGER NOT NULL,
  CHECK (0 <= head_end AND head_end <= backfill_offset AND backfill_offset <= tail_start AND tail_start <= tail_offset),
  CHECK (tail_offset <= size_seen OR state <> 'active')
) STRICT;
CREATE INDEX idx_transcript_files_session ON transcript_files(session_uid);
CREATE INDEX idx_transcript_files_behind  ON transcript_files(behind_since) WHERE behind_since IS NOT NULL;

-- Sparse entry index of each transcript file: one row about every 256 display entries, always at a line start.
-- Gives stable absolute entry indexes (legacy `i`) and bounded seeks for the transcript window, locate and search.
CREATE TABLE transcript_checkpoints (
  file_id            INTEGER NOT NULL,                 -- soft ref transcript_files(id)
  entry_index        INTEGER NOT NULL CHECK (entry_index >= 0),
  byte_offset        INTEGER NOT NULL CHECK (byte_offset >= 0),
  min_ts             INTEGER,
  max_ts             INTEGER,
  PRIMARY KEY (file_id, entry_index)
) STRICT, WITHOUT ROWID;

CREATE TABLE tool_calls (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id           INTEGER NOT NULL,                 -- soft ref agents(id) (the main agent row for the main conversation)
  prompt_id          TEXT CHECK (prompt_id IS NULL OR length(prompt_id) <= 128),
  tool_use_id        TEXT NOT NULL UNIQUE CHECK (length(tool_use_id) BETWEEN 1 AND 128),
  name               TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mcp_server         TEXT CHECK (mcp_server IS NULL OR length(mcp_server) <= 128),
  summary            TEXT CHECK (summary IS NULL OR length(summary) <= 160),
  input_hash         TEXT CHECK (input_hash IS NULL OR length(input_hash) <= 64),
  input_bytes        INTEGER CHECK (input_bytes IS NULL OR input_bytes >= 0),
  started_at         INTEGER,
  ended_at           INTEGER,
  batch_at           INTEGER,
  outcome            TEXT CHECK (outcome IS NULL OR outcome IN ('ok','error','denied','interrupted')),
  exit_code          INTEGER,
  duration_ms        INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  duration_source    TEXT CHECK (duration_source IS NULL OR duration_source IN ('hook','timestamps')),
  sources            INTEGER NOT NULL DEFAULT 0 CHECK (sources BETWEEN 0 AND 31),  -- 1 hook_pre, 2 hook_post, 4 transcript_use, 8 transcript_result, 16 hook_batch
  call_file_id       INTEGER,                          -- soft ref transcript_files(id)
  call_offset        INTEGER CHECK (call_offset IS NULL OR call_offset >= 0),
  result_file_id     INTEGER,
  result_offset      INTEGER CHECK (result_offset IS NULL OR result_offset >= 0),
  subagent_id        INTEGER,                          -- soft ref agents(id) (Agent tool)
  workflow_run_id    INTEGER,                          -- soft ref workflow_runs(id) (Workflow tool)
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL,
  CHECK (outcome IS NULL OR ended_at IS NOT NULL)
) STRICT;
CREATE INDEX idx_tool_calls_session ON tool_calls(session_id, started_at DESC);
CREATE INDEX idx_tool_calls_name    ON tool_calls(name, started_at DESC);
CREATE INDEX idx_tool_calls_open    ON tool_calls(session_id, started_at) WHERE ended_at IS NULL AND batch_at IS NULL;

-- One timeline for hook envelopes (02 `hook_event`) and transcript entries (02 `transcript_entry`).
-- Rows that describe the same logical event from both sources share a natural key and are merged (sources bitmask).
CREATE TABLE events (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id           INTEGER,                          -- soft ref agents(id)
  kind               TEXT NOT NULL CHECK (length(kind) BETWEEN 3 AND 40 AND kind GLOB '[a-z]*.[a-z]*' AND kind NOT GLOB '*[^a-z._]*'),
  entry_kind         TEXT CHECK (entry_kind IS NULL OR entry_kind IN ('prompt','say','think','tool','result','system','attachment')),
  severity           INTEGER NOT NULL DEFAULT 0 CHECK (severity IN (0,1,2)),
  sources            INTEGER NOT NULL CHECK (sources BETWEEN 1 AND 7),      -- 1 hook, 2 transcript, 4 monitor
  ts                 INTEGER NOT NULL,
  ts_rank            INTEGER NOT NULL DEFAULT 70 CHECK (ts_rank BETWEEN 0 AND 99),
  ts_tie             TEXT NOT NULL DEFAULT '' CHECK (length(ts_tie) <= 200),
  ts_source          TEXT NOT NULL CHECK (ts_source IN ('record','hook_received','derived')),
  received_at        INTEGER NOT NULL,
  event_uid          TEXT CHECK (event_uid IS NULL OR length(event_uid) = 36),
  natural_key        TEXT CHECK (natural_key IS NULL OR length(natural_key) BETWEEN 3 AND 300),
  record_uuid        TEXT CHECK (record_uuid IS NULL OR length(record_uuid) BETWEEN 1 AND 80),
  hook_event         TEXT CHECK (hook_event IS NULL OR length(hook_event) <= 64),
  content_hash       TEXT CHECK (content_hash IS NULL OR length(content_hash) = 32),
  spool_segment      TEXT CHECK (spool_segment IS NULL OR length(spool_segment) <= 128),
  spool_offset       INTEGER CHECK (spool_offset IS NULL OR spool_offset >= 0),
  flags              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags) AND json_type(flags) = 'array' AND length(flags) <= 1024),
  prompt_id          TEXT CHECK (prompt_id IS NULL OR length(prompt_id) <= 128),
  tool_use_id        TEXT CHECK (tool_use_id IS NULL OR length(tool_use_id) <= 128),
  tool_name          TEXT CHECK (tool_name IS NULL OR length(tool_name) <= 200),
  message_id         TEXT CHECK (message_id IS NULL OR length(message_id) <= 128),
  file_id            INTEGER,                          -- soft ref transcript_files(id)
  byte_offset        INTEGER CHECK (byte_offset IS NULL OR byte_offset >= 0),
  byte_length        INTEGER CHECK (byte_length IS NULL OR byte_length > 0),
  line_no            INTEGER CHECK (line_no IS NULL OR line_no >= 0),
  record_type        TEXT CHECK (record_type IS NULL OR length(record_type) <= 32),
  subtype            TEXT CHECK (subtype IS NULL OR length(subtype) <= 40),
  text_len           INTEGER CHECK (text_len IS NULL OR text_len >= 0),
  summary            TEXT CHECK (summary IS NULL OR length(summary) <= 240),
  detail             TEXT CHECK (detail IS NULL OR (json_valid(detail) AND length(detail) <= 16384)),
  change_seq         INTEGER NOT NULL DEFAULT 0 CHECK (change_seq >= 0),
  CHECK (event_uid IS NOT NULL OR natural_key IS NOT NULL OR record_uuid IS NOT NULL),
  CHECK ((file_id IS NULL) = (byte_offset IS NULL))
) STRICT;
CREATE UNIQUE INDEX ux_events_event_uid   ON events(event_uid)   WHERE event_uid IS NOT NULL;
CREATE UNIQUE INDEX ux_events_natural_key ON events(natural_key) WHERE natural_key IS NOT NULL;
CREATE UNIQUE INDEX ux_events_record_uuid ON events(record_uuid) WHERE record_uuid IS NOT NULL;
CREATE INDEX idx_events_session_ts ON events(session_id, ts DESC, id DESC);
CREATE INDEX idx_events_ts         ON events(ts DESC, id DESC);
CREATE INDEX idx_events_kind_ts    ON events(kind, ts DESC, id DESC);
CREATE INDEX idx_events_problems   ON events(ts DESC, id DESC) WHERE severity > 0;
CREATE INDEX idx_events_content    ON events(session_id, hook_event, content_hash, received_at) WHERE content_hash IS NOT NULL;

-- Second and later occurrences of a transcript record (resume copies, 02 D-4).
CREATE TABLE entry_occurrences (
  file_id            INTEGER NOT NULL,                 -- soft ref transcript_files(id)
  byte_offset        INTEGER NOT NULL CHECK (byte_offset >= 0),
  record_uuid        TEXT NOT NULL CHECK (length(record_uuid) BETWEEN 1 AND 80),
  PRIMARY KEY (file_id, byte_offset)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_entry_occurrences_uuid ON entry_occurrences(record_uuid);

-- Per-file usage per message key (02 6.2 rules 1-5, 11): NULL = missing value; legacy_* = top-level integers for parity.
CREATE TABLE usage_files (
  file_id            INTEGER NOT NULL,                 -- soft ref transcript_files(id)
  message_key        TEXT NOT NULL CHECK (length(message_key) BETWEEN 1 AND 160),
  model              TEXT CHECK (model IS NULL OR length(model) <= 128),
  input_tokens       INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens      INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens  INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_creation_tokens    INTEGER CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
  cache_creation_5m_tokens INTEGER CHECK (cache_creation_5m_tokens IS NULL OR cache_creation_5m_tokens >= 0),
  cache_creation_1h_tokens INTEGER CHECK (cache_creation_1h_tokens IS NULL OR cache_creation_1h_tokens >= 0),
  thinking_tokens    INTEGER CHECK (thinking_tokens IS NULL OR thinking_tokens >= 0),
  web_search_requests INTEGER CHECK (web_search_requests IS NULL OR web_search_requests >= 0),
  web_fetch_requests  INTEGER CHECK (web_fetch_requests IS NULL OR web_fetch_requests >= 0),
  legacy_in          INTEGER NOT NULL DEFAULT 0 CHECK (legacy_in >= 0),
  legacy_out         INTEGER NOT NULL DEFAULT 0 CHECK (legacy_out >= 0),
  legacy_cr          INTEGER NOT NULL DEFAULT 0 CHECK (legacy_cr >= 0),
  legacy_cc          INTEGER NOT NULL DEFAULT 0 CHECK (legacy_cc >= 0),
  finalized          INTEGER NOT NULL DEFAULT 0 CHECK (finalized IN (0,1)),
  usage_source       TEXT NOT NULL DEFAULT 'top' CHECK (usage_source IN ('top','iterations')),
  synthetic          INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0,1)),
  first_ts           INTEGER,
  last_ts            INTEGER,
  record_count       INTEGER NOT NULL DEFAULT 1 CHECK (record_count >= 1),
  invalid_values     INTEGER NOT NULL DEFAULT 0 CHECK (invalid_values >= 0),
  PRIMARY KEY (file_id, message_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_usage_files_key ON usage_files(message_key);

-- Instance-wide value of each message key (02 6.2 rules 6-7): per-field max over its usage_files rows, owner = oldest file.
CREATE TABLE usage (
  id                 INTEGER PRIMARY KEY,
  message_key        TEXT NOT NULL UNIQUE CHECK (length(message_key) BETWEEN 1 AND 160),
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,   -- owner session
  agent_id           INTEGER NOT NULL,                 -- soft ref agents(id): owner agent (main agent row for a main file)
  owner_file_id      INTEGER NOT NULL,                 -- soft ref transcript_files(id)
  model              TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  ts                 INTEGER NOT NULL,                 -- earliest first_ts over the files (bucketing time)
  input_tokens       INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens      INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens  INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_creation_tokens    INTEGER CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
  cache_creation_5m_tokens INTEGER CHECK (cache_creation_5m_tokens IS NULL OR cache_creation_5m_tokens >= 0),
  cache_creation_1h_tokens INTEGER CHECK (cache_creation_1h_tokens IS NULL OR cache_creation_1h_tokens >= 0),
  thinking_tokens    INTEGER CHECK (thinking_tokens IS NULL OR thinking_tokens >= 0),
  web_search_requests INTEGER CHECK (web_search_requests IS NULL OR web_search_requests >= 0),
  web_fetch_requests  INTEGER CHECK (web_fetch_requests IS NULL OR web_fetch_requests >= 0),
  finalized          INTEGER NOT NULL CHECK (finalized IN (0,1)),
  usage_source       TEXT NOT NULL CHECK (usage_source IN ('top','iterations')),
  synthetic          INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0,1)),
  files              INTEGER NOT NULL DEFAULT 1 CHECK (files >= 1),
  updated_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_usage_session  ON usage(session_id);
-- Covering index for every time-window aggregate; analytics queries name it with INDEXED BY (03 3.7 rule 1).
CREATE INDEX idx_usage_ts_cover ON usage(ts, model, session_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, finalized, synthetic);

-- Provider-reported cumulative cost per file (02 6.6); never summed with transcript tokens.
CREATE TABLE cost_states (
  file_id            INTEGER PRIMARY KEY,              -- soft ref transcript_files(id)
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  total_cost_usd     REAL CHECK (total_cost_usd IS NULL OR total_cost_usd >= 0),
  model_usage_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(model_usage_json) AND length(model_usage_json) <= 8192),
  byte_offset        INTEGER NOT NULL CHECK (byte_offset >= 0),
  is_trailing        INTEGER NOT NULL DEFAULT 0 CHECK (is_trailing IN (0,1)),
  observed_at        INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_cost_states_session ON cost_states(session_id);

CREATE TABLE state_transitions (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id           INTEGER,                          -- soft ref agents(id); NULL = session level
  from_state         TEXT,
  to_state           TEXT NOT NULL,
  rule               TEXT NOT NULL CHECK (length(rule) BETWEEN 1 AND 16),
  basis              TEXT NOT NULL CHECK (basis IN ('observed','inferred')),
  confidence         TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  evidence           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence) AND length(evidence) <= 4096),
  at                 INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_transitions_session ON state_transitions(session_id, at DESC);

-- Append-only reconciliation records (02 8.1); ids and numbers only.
CREATE TABLE reconciliations (
  id                 INTEGER PRIMARY KEY,
  session_id         INTEGER REFERENCES sessions(id) ON DELETE CASCADE,       -- NULL = instance level
  scope_key          TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 64), -- session uid or 'instance'
  kind               TEXT NOT NULL CHECK (kind IN ('activity_after_end','hook_gap','runtime_unavailable','identity_reset','copied_records','handler_failing')),
  at                 INTEGER NOT NULL,
  detail             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND length(detail) <= 2048),
  detail_hash        TEXT NOT NULL CHECK (length(detail_hash) = 32),
  UNIQUE (scope_key, kind, detail_hash)
) STRICT;
CREATE INDEX idx_reconciliations_session ON reconciliations(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_reconciliations_kind_at ON reconciliations(kind, at DESC);

-- Latest external observation per session and source (02 7.10).
CREATE TABLE external_observations (
  session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source             TEXT NOT NULL CHECK (source IN ('registry','job','pid','attempt')),
  observed_at        INTEGER NOT NULL,
  value_json         TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 2048),
  PRIMARY KEY (session_id, source)
) STRICT, WITHOUT ROWID;

CREATE TABLE hook_probes (
  probe_session_id   TEXT PRIMARY KEY NOT NULL CHECK (length(probe_session_id) = 36),
  received_at        INTEGER NOT NULL,
  committed_at       INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE work_items (
  id                 INTEGER PRIMARY KEY,
  item_key           TEXT NOT NULL UNIQUE CHECK (length(item_key) BETWEEN 3 AND 200),  -- 'attempt:<part>' | 'label:<label>' | declared key
  kind               TEXT NOT NULL CHECK (kind IN ('declared','attempt','label')),
  title              TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  state              TEXT NOT NULL CHECK (state IN ('working','waiting','completed','failed','stale','unknown')),
  rule               TEXT NOT NULL CHECK (rule IN ('W-DECL','W-ATT','W-LBL')),
  board_reason       TEXT NOT NULL CHECK (length(board_reason) BETWEEN 1 AND 16),   -- order row of the board-state table (02 7.11)
  evidence           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence) AND length(evidence) <= 8192),
  state_since        INTEGER NOT NULL,
  session_count      INTEGER NOT NULL DEFAULT 0 CHECK (session_count >= 0),
  last_activity_at   INTEGER,
  created_at         INTEGER NOT NULL,
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_work_items_state ON work_items(state, last_activity_at DESC);

CREATE TABLE work_item_sessions (
  work_item_id       INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  session_id         INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,   -- a session belongs to at most one item
  linked_at          INTEGER NOT NULL,
  PRIMARY KEY (work_item_id, session_id)
) STRICT, WITHOUT ROWID;

-- Instance ingestion health (02 8.2): one row, the last computed report plus durable counters.
CREATE TABLE ingest_health (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  evaluated_at       INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('ok','degraded','down')),
  last_envelope_at   INTEGER,
  last_commit_at     INTEGER,
  last_drain_at      INTEGER,
  last_nudge_at      INTEGER,
  last_scan_at       INTEGER,
  last_sync_at       INTEGER,
  counters_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counters_json) AND length(counters_json) <= 16384),
  report_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(report_json) AND length(report_json) <= 65536),
  updated_at         INTEGER NOT NULL
) STRICT;

-- One row per ingest error occurrence (02 4.8); retention keeps the newest 1000.
CREATE TABLE ingest_errors (
  id                 INTEGER PRIMARY KEY,
  at                 INTEGER NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('spool','transcript','external','writer','handler','alerts','db')),
  code               TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code = upper(code)),
  file_id            INTEGER,                          -- soft ref transcript_files(id)
  segment            TEXT CHECK (segment IS NULL OR length(segment) <= 128),
  byte_offset        INTEGER CHECK (byte_offset IS NULL OR byte_offset >= 0),
  session_uid        TEXT CHECK (session_uid IS NULL OR length(session_uid) = 36),
  detail             TEXT CHECK (detail IS NULL OR length(detail) <= 200)
) STRICT;
CREATE INDEX idx_ingest_errors_at   ON ingest_errors(at DESC);
CREATE INDEX idx_ingest_errors_code ON ingest_errors(code, at DESC);

-- Spool segment cursors (02 2.7, `spool_cursor`).
CREATE TABLE spool_cursors (
  segment            TEXT PRIMARY KEY NOT NULL
                     CHECK (length(segment) BETWEEN 7 AND 128 AND segment GLOB '*.ndjson' AND segment NOT GLOB '*[/\:]*'),
  offset_bytes       INTEGER NOT NULL DEFAULT 0 CHECK (offset_bytes >= 0),
  size_seen          INTEGER NOT NULL DEFAULT 0 CHECK (size_seen >= 0),
  ino                TEXT CHECK (ino IS NULL OR length(ino) <= 40),
  head_hash          TEXT CHECK (head_hash IS NULL OR length(head_hash) = 64),
  lines              INTEGER NOT NULL DEFAULT 0 CHECK (lines >= 0),
  partial_bytes      INTEGER NOT NULL DEFAULT 0 CHECK (partial_bytes >= 0),
  sealed             INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0,1)),
  errors             INTEGER NOT NULL DEFAULT 0 CHECK (errors >= 0),
  oldest_received_at INTEGER,
  newest_received_at INTEGER,
  first_seen_at      INTEGER NOT NULL,
  drained_at         INTEGER,
  updated_at         INTEGER NOT NULL,
  CHECK (offset_bytes <= size_seen)
) STRICT, WITHOUT ROWID;

-- Chain-log attempts (06 3.10): one row per configured chain-log file, one row per START line of that file.
CREATE TABLE attempt_sources (
  id                 INTEGER PRIMARY KEY,
  path               TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),          -- canonicalPath of chain_log (06 4.1)
  path_key           TEXT NOT NULL UNIQUE CHECK (length(path_key) BETWEEN 1 AND 1024),  -- pathKey(path): samePath comparison key
  generation         INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),             -- +1 when the file was truncated or replaced
  ino                TEXT CHECK (ino IS NULL OR length(ino) <= 40),
  head_len           INTEGER NOT NULL CHECK (head_len BETWEEN 0 AND 256),
  head_hash          TEXT NOT NULL CHECK (length(head_hash) = 64),                   -- sha256 hex of the first head_len bytes
  read_offset        INTEGER NOT NULL DEFAULT 0 CHECK (read_offset >= 0),            -- byte offset after the last consumed LF
  config_sha256      TEXT NOT NULL CHECK (length(config_sha256) = 64),               -- hash of {start, end, label_prefix, time_format}
  updated_at         INTEGER NOT NULL
) STRICT;

CREATE TABLE attempt_runs (
  id                 INTEGER PRIMARY KEY,
  source_id          INTEGER NOT NULL,                 -- soft ref attempt_sources(id)
  generation         INTEGER NOT NULL CHECK (generation >= 1),
  start_offset       INTEGER NOT NULL CHECK (start_offset >= 0),                     -- byte offset of the START line (natural key)
  part               TEXT NOT NULL CHECK (length(part) <= 512),                      -- '' when the group is absent (legacy)
  n_raw              TEXT CHECK (n_raw IS NULL OR length(n_raw) <= 64),
  model              TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 128),  -- NULL when absent or empty
  effort             TEXT CHECK (effort IS NULL OR length(effort) BETWEEN 1 AND 64),
  started_at         INTEGER NOT NULL,
  end_offset         INTEGER CHECK (end_offset IS NULL OR end_offset > start_offset),
  ended_at           INTEGER,                          -- = started_at when the END time does not parse (legacy)
  exit_raw           TEXT CHECK (exit_raw IS NULL OR length(exit_raw) <= 64),
  status_raw         TEXT CHECK (status_raw IS NULL OR length(status_raw) <= 512),
  end_reason         TEXT NOT NULL DEFAULT 'open' CHECK (end_reason IN ('open','ended','superseded')),
  state              TEXT NOT NULL DEFAULT 'RUNNING' CHECK (state IN ('COMPLETED','FAILED','RUNNING','UNKNOWN')),
  evidence           TEXT NOT NULL CHECK (length(evidence) BETWEEN 1 AND 1024),
  session_id         INTEGER,                          -- soft ref sessions(id); NULL = not matched
  match_delta_ms     INTEGER,
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  updated_at         INTEGER NOT NULL,
  UNIQUE (source_id, generation, start_offset),
  CHECK ((end_reason = 'open') = (state = 'RUNNING')),
  CHECK ((end_reason = 'ended') = (ended_at IS NOT NULL AND end_offset IS NOT NULL)),
  CHECK (match_delta_ms IS NULL OR session_id IS NOT NULL)
) STRICT;
CREATE INDEX idx_attempt_runs_session ON attempt_runs(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_attempt_runs_open    ON attempt_runs(source_id, generation, part) WHERE end_reason = 'open';
CREATE INDEX idx_attempt_runs_start   ON attempt_runs(started_at, id);

CREATE TABLE alerts (
  id                 INTEGER PRIMARY KEY,
  rule_id            TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 64),
  rule_kind          TEXT NOT NULL CHECK (rule_kind IN
                     ('inactivity','ingest_errors','runtime_unavailable','token_threshold','import_lag','db_disk','hook_gap','hook_failing')),
  scope_kind         TEXT NOT NULL CHECK (scope_kind IN ('instance','session','code')),
  scope_key          TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
  session_id         INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  severity           TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  status             TEXT NOT NULL CHECK (status IN ('open','resolved')),
  title              TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail             TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND length(detail) <= 2048),
  first_fired_at     INTEGER NOT NULL,
  last_fired_at      INTEGER NOT NULL,
  fire_count         INTEGER NOT NULL DEFAULT 1 CHECK (fire_count >= 1),
  resolved_at        INTEGER,
  resolved_reason    TEXT CHECK (resolved_reason IS NULL OR resolved_reason IN ('condition_cleared','expired','rule_disabled','scope_deleted')),
  updated_seq        INTEGER NOT NULL DEFAULT 0 CHECK (updated_seq >= 0),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (last_fired_at >= first_fired_at)
) STRICT;
CREATE UNIQUE INDEX ux_alerts_live    ON alerts(rule_id, scope_key) WHERE status = 'open';
CREATE INDEX idx_alerts_status        ON alerts(status, last_fired_at DESC);
CREATE INDEX idx_alerts_session       ON alerts(session_id) WHERE session_id IS NOT NULL;

CREATE TABLE alert_state (
  rule_id            TEXT NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 64),
  scope_key          TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
  condition_since    INTEGER,
  last_value         REAL,
  last_evaluated_at  INTEGER NOT NULL,
  cooldown_until     INTEGER,
  PRIMARY KEY (rule_id, scope_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE changes (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                 INTEGER NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('session','agent','workflow','tool_call','event','transcript','work_item','usage','alert','health','attempt')),
  op                 TEXT NOT NULL CHECK (op IN ('upsert','delete','append','invalidate')),
  session_uid        TEXT CHECK (session_uid IS NULL OR length(session_uid) = 36),
  entity_id          INTEGER,
  payload            TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND length(payload) <= 2048),
  CHECK (kind || '/' || op IN ('session/upsert','session/delete','agent/upsert','workflow/upsert','tool_call/upsert','event/append',
         'transcript/append','work_item/upsert','usage/invalidate','alert/upsert','health/upsert','attempt/upsert'))
) STRICT;
CREATE INDEX idx_changes_at ON changes(at);
```

Mapping of the logical entities of `[02 4.1]` (that document owns their semantics; this one owns names, DDL and indexes):

| 02 entity | Table | Column notes |
|---|---|---|
| `hook_event` | `events` rows with `sources & 1` | `event_uid`, `hook_event` (= envelope `event`), `received_at`, `content_hash`, `spool_segment`, `spool_offset`, `flags` (envelope flags), `detail` (= sanitized envelope `data`), `prompt_id`, `tool_use_id`; D-2/D-3 duplicates are not inserted (counted in `ingest_health.counters_json`), so `duplicate_of` is not needed |
| `transcript_entry` | `events` rows with `sources & 2` | `record_uuid` (= `entry_key`: record uuid, or `f<file_id>:<byte_offset>` for records without one), `file_id`, `byte_offset`, `byte_length`, `line_no`, `record_type`, `subtype`, `entry_kind` (= 02 entry `kind`), `ts`, `message_id`, `tool_use_id`, `tool_name`, `summary`, `text_len`, `flags`; 02's `is_error` = `kind 'tool.failure'` + `severity 2` |
| (both sources, same logical event) | one `events` row | merged through `natural_key` (3.6); `sources` = 3 |
| `entry_occurrence` | `entry_occurrences` | |
| `session` | `sessions` | `project_dir` -> `project_id` (`projects.dir_name`); `version` -> `cc_version`; `cwd_latest` -> `cwd`; `title_ai`, `title_custom`; `continued_in`, `copied_from`; `hook_coverage` + `hook_missing_tools/turns`; `facts_json`; lifecycle view columns (`state ... next_check_at`; `ruleId` -> `state_rule`) |
| `agent` | `agents` | kind `internal` hidden by default; `facts_json`; lifecycle view |
| `workflow_run` | `workflow_runs` | `name` -> `workflow_name`; counters; `facts_json`; lifecycle view |
| `turn` | `turns` | `end_kind` LWW by the stamp `(ended_at, end_rank, end_tie)` |
| `tool_call` | `tool_calls` | same fields; `sources` bits identical (`hook_pre` 1, `hook_post` 2, `transcript_use` 4, `transcript_result` 8, `hook_batch` 16) |
| `transcript_file` | `transcript_files` | every cursor and counter of `[02 5.3-5.9]`; extra state `retired` (cleanup tombstone, 11.3); extra entry-index columns of 7.2 |
| `message_usage_file` | `usage_files` | NULL = missing value; `legacy_*` for the parity projection `[02 6.5]` |
| (instance value of a message key) | `usage` | per-field max over its files, owner of `[02 6.2 rule 7]`, rollups 3.6 |
| `spool_cursor` | `spool_cursors` | `offset` -> `offset_bytes` |
| `ingest_error` | `ingest_errors` | sources `spool, transcript, external, writer, handler` plus `alerts`, `db` |
| `reconciliation` | `reconciliations` | `scope_key` = session uid or `instance`; dedupe `(scope_key, kind, detail_hash)` |
| `external_observation` | `external_observations` | latest per `(session, source)` |
| `cost_state` | `cost_states` | plus owner `session_id`; latest trailing value also denormalized into `sessions.reported_cost_usd/_at` |
| `hook_probe` | `hook_probes` | |
| `ingest_health` | `ingest_health` | one row: last `IngestHealth` report (`report_json`) and durable counters |
| work items `[02 7.11]` | `work_items`, `work_item_sessions` | `rule` W-DECL/W-ATT/W-LBL, `board_reason` = order row of the board table, `evidence` `{sessionId, state, ruleId}[]`; a session belongs to at most one item (UNIQUE) |
| `attempt_source` `[06 3.10.2]` | `attempt_sources` | `PRIMARY KEY (instance_id, path)` -> `id` + `path_key UNIQUE` (no `instance_id`, C-1); `path` = `canonicalPath(chain_log)`, `path_key` = `pathKey(path)`, the comparison key of `samePath` (`[06 4.1]`); other columns unchanged |
| `attempt_run` `[06 3.10.2]` | `attempt_runs` | `instance_id` dropped (C-1); `source_path` -> `source_id` (soft ref); `session_id` holds the `sessions.id` row id (the panel maps it to the provider id); `seq` -> `updated_seq`; + `updated_at`; natural key `UNIQUE (source_id, generation, start_offset)`; CHECKs tie `end_reason`, `state`, `ended_at`/`end_offset` and the match columns together; the three indexes of 06 without `instance_id` |

Tables owned by this document: `meta`, `projects`, `transcript_checkpoints` (7.2), `state_transitions` (written when a view's state
changes), `alerts`, `alert_state` (section 10), `changes` (section 9). Tables whose semantics `[06 3.10]` owns (this document owns
names, DDL, indexes and `AttemptsRepo`): `attempt_sources`, `attempt_runs`.

### 3.6 Write paths (repository statements)

Every write runs inside `withWriteTx(db, ctx, fn)` (4.5): one `BEGIN IMMEDIATE` transaction with a fresh `ChangeRecorder`; COMMIT; then the
stream is notified. The ingestion writer of `[02 4.6]` calls it once per tick and implements its `ChangeSink` on top of the recorder
(9.1). Statements below are normative; parameters are named.

**Ensure a session and its main agent** (`SessionsRepo.ensure`):
```sql
INSERT INTO sessions (session_uid, project_id, first_seen_at, started_at, last_activity_at, updated_at)
VALUES (:uid, :projectId, :now, :startedAt, :startedAt, :now)
ON CONFLICT(session_uid) DO UPDATE SET
  started_at = min(sessions.started_at, excluded.started_at),
  project_id = coalesce(sessions.project_id, excluded.project_id)
RETURNING id;
INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at)
VALUES (:sessionId, 'main', NULL, 'main', 0, :now, :startedAt, :startedAt, :now)
ON CONFLICT(session_id, agent_uid) DO NOTHING;
```

**Events (hook envelopes and transcript entries).** Natural keys, shared by both sources where the provider gives a common id (storage
contract; the ingestion doc decides which records and envelopes become rows `[02 4.3, 5.6]`):

| Logical event | Hook | Transcript | `natural_key` | `kind` |
|---|---|---|---|---|
| tool call started | PreToolUse | assistant `tool_use` block | `tool.call:<tool_use_id>` | `tool.call` |
| tool call ended | PostToolUse, PostToolUseFailure | user `tool_result` block | `tool.end:<tool_use_id>` | `tool.result`; `tool.failure` wins on merge (and `severity 2`) |
| prompt | UserPromptSubmit | user prompt record (`promptId`) | `prompt:<session_uid>:<prompt_id>` | `prompt.submit` |
| permission denied | PermissionDenied | - | `permission.denied:<tool_use_id>` | `permission.denied` |
| tool batch | PostToolBatch | - | `tool.batch:<session_uid>:<ids_hash>` | `tool.batch` |
| task created / completed | TaskCreated / TaskCompleted | - | `task.<created\|completed>:<session_uid>:<task_id>` | `task.created` / `task.completed` |
| any other hook event | envelope | - | NULL (dedupe by `event_uid` and the D-3 content window `[02 4.4]`) | 5.5 |
| any other stored transcript record | - | record | NULL (dedupe by `record_uuid`) | 5.5 |

**Stored kind (normative, I-03).** The value of `events.kind` for every envelope and record that `[02 4.3, 5.6]` turns into a row.
`[02]` decides WHICH envelopes and records become rows; this table decides the stored value, and `[02]`'s tables (4.1, 4.3, 5.6) carry a
"stored kind" column equal to it. A new kind is a code change (a new `EVENT_KINDS` value, no migration: 3.4).

| Source | Hook envelope `event` / transcript record | Stored `kind` |
|---|---|---|
| hook | SessionStart / SessionEnd | `session.start` / `session.end` |
| hook, transcript | UserPromptSubmit / user prompt record (`promptId`) | `prompt.submit` |
| transcript | interrupt marker | `turn.interrupt` |
| hook, transcript | PreToolUse / assistant `tool_use` block | `tool.call` |
| hook, transcript | PostToolUse / `tool_result` that is not an error | `tool.result` |
| hook, transcript | PostToolUseFailure / `tool_result` error or denial | `tool.failure` (`severity 2`) |
| hook | PostToolBatch | `tool.batch` |
| hook | PermissionRequest / PermissionDenied | `permission.request` / `permission.denied` |
| hook | Notification | `notification.sent` |
| hook | SubagentStart / SubagentStop | `agent.start` / `agent.stop` |
| transcript | `structured_output` attachment | `agent.final` |
| transcript | task-notification record | `agent.notification` |
| hook | Stop / StopFailure | `turn.stop` / `turn.failure` |
| transcript | `system` record with subtype `turn_duration` | `turn.duration` |
| transcript | API error record | `api.error` |
| hook, transcript | PreCompact, PostCompact / `compact_boundary` | `context.compact` |
| hook | PostModelSwitch | `model.switch` |
| hook | CwdChanged | `cwd.change` |
| hook | TaskCreated / TaskCompleted | `task.created` / `task.completed` |
| hook | TeammateIdle | `teammate.idle` |
| transcript | assistant text block / thinking block | `assistant.message` / `assistant.thinking` |
| transcript | `queued_command` attachment | `prompt.queued` |
| transcript | any other stored `system` or `attachment` entry | `system.info` |
| hook | the handler's own `hook_non_blocking_error` record | `hook.handler_error` |
| hook | a hook name outside the installed set | `hook.unknown` |
| monitor | reconciliation (below) | `monitor.gap` (`runtime_unavailable`, `hook_gap`), `monitor.reconcile` (others) |
| hook (probe) | probe envelope `[02 3.7]` | none: a `hook_probes` row only, never an event or a session |

```sql
INSERT INTO events (session_id, agent_id, kind, entry_kind, severity, sources, ts, ts_rank, ts_tie, ts_source, received_at, event_uid,
                    natural_key, record_uuid, hook_event, content_hash, spool_segment, spool_offset, flags, prompt_id, tool_use_id,
                    tool_name, message_id, file_id, byte_offset, byte_length, line_no, record_type, subtype, text_len, summary, detail, change_seq)
VALUES (:sessionId, :agentId, :kind, :entryKind, :severity, :sources, :ts, :tsRank, :tsTie, :tsSource, :receivedAt, :eventUid,
        :naturalKey, :recordUuid, :hookEvent, :contentHash, :spoolSegment, :spoolOffset, :flags, :promptId, :toolUseId,
        :toolName, :messageId, :fileId, :byteOffset, :byteLength, :lineNo, :recordType, :subtype, :textLen, :summary, :detail, :seq)
ON CONFLICT(event_uid) WHERE event_uid IS NOT NULL DO NOTHING
ON CONFLICT(record_uuid) WHERE record_uuid IS NOT NULL DO NOTHING
ON CONFLICT(natural_key) WHERE natural_key IS NOT NULL DO UPDATE SET
  sources     = events.sources | excluded.sources,
  kind        = CASE WHEN excluded.kind = 'tool.failure' THEN 'tool.failure' ELSE events.kind END,
  severity    = max(events.severity, excluded.severity),
  event_uid   = coalesce(events.event_uid, excluded.event_uid),
  record_uuid = coalesce(events.record_uuid, excluded.record_uuid),
  hook_event  = coalesce(events.hook_event, excluded.hook_event),
  entry_kind  = coalesce(events.entry_kind, excluded.entry_kind),
  file_id     = coalesce(events.file_id, excluded.file_id),
  byte_offset = coalesce(events.byte_offset, excluded.byte_offset),
  byte_length = coalesce(events.byte_length, excluded.byte_length),
  summary     = coalesce(events.summary, excluded.summary),
  ts          = CASE WHEN events.ts_source = 'record' THEN events.ts WHEN excluded.ts_source = 'record' THEN excluded.ts ELSE min(events.ts, excluded.ts) END,
  ts_source   = CASE WHEN excluded.ts_source = 'record' THEN 'record' ELSE events.ts_source END
RETURNING id, change_seq;
```
Verified `[exp:X12]`: a transcript `tool_use` first, then the hook `PreToolUse` merges into the same row (`sources 3`, `event_uid`
adopted, record timestamp kept); a redelivered envelope (same `event_uid`) returns no row; a resume copy (same `record_uuid` in another
file) returns no row, and the repository then inserts `entry_occurrences (file_id, byte_offset, record_uuid)`; transcript-only and
hook-only rows insert normally. A returned `change_seq` equal to the transaction's reserved seq means a new row; an older one means a
merge into an announced row (not re-announced); no row means a duplicate (counted, `[02 4.4]`). `excluded` cannot be used in
`RETURNING`, hence this rule. A record ingested as a merge target keeps the hook row's `received_at`.

**Tool calls** (`[02 4.1]` merge rules: `started_at` min, `ended_at` max, `batch_at` max, `sources` OR, `outcome` by precedence error >
denied > interrupted > ok, other columns first non-null). Multi-argument `min()`/`max()` return NULL when an argument is NULL, so each is
wrapped as `coalesce(max(a, b), a, b)`:
```sql
INSERT INTO tool_calls (session_id, agent_id, prompt_id, tool_use_id, name, mcp_server, summary, input_hash, input_bytes, started_at,
                        ended_at, batch_at, outcome, exit_code, duration_ms, duration_source, sources, call_file_id, call_offset,
                        result_file_id, result_offset, subagent_id, workflow_run_id, updated_seq, updated_at)
VALUES (:sessionId, :agentId, :promptId, :toolUseId, :name, :mcpServer, :summary, :inputHash, :inputBytes, :startedAt,
        :endedAt, :batchAt, :outcome, :exitCode, :durationMs, :durationSource, :sources, :callFileId, :callOffset,
        :resultFileId, :resultOffset, :subagentId, :workflowRunId, :seq, :now)
ON CONFLICT(tool_use_id) DO UPDATE SET
  started_at      = coalesce(min(tool_calls.started_at, excluded.started_at), tool_calls.started_at, excluded.started_at),
  ended_at        = coalesce(max(tool_calls.ended_at, excluded.ended_at), tool_calls.ended_at, excluded.ended_at),
  batch_at        = coalesce(max(tool_calls.batch_at, excluded.batch_at), tool_calls.batch_at, excluded.batch_at),
  sources         = tool_calls.sources | excluded.sources,
  outcome         = CASE WHEN ${rank('excluded.outcome')} > ${rank('tool_calls.outcome')} THEN excluded.outcome ELSE tool_calls.outcome END,
  duration_ms     = coalesce(CASE WHEN excluded.duration_source = 'hook' THEN excluded.duration_ms END, tool_calls.duration_ms, excluded.duration_ms),
  duration_source = CASE WHEN excluded.duration_source = 'hook' THEN 'hook' ELSE coalesce(tool_calls.duration_source, excluded.duration_source) END,
  prompt_id = coalesce(tool_calls.prompt_id, excluded.prompt_id), mcp_server = coalesce(tool_calls.mcp_server, excluded.mcp_server),
  summary = coalesce(tool_calls.summary, excluded.summary), input_hash = coalesce(tool_calls.input_hash, excluded.input_hash),
  input_bytes = coalesce(tool_calls.input_bytes, excluded.input_bytes), exit_code = coalesce(tool_calls.exit_code, excluded.exit_code),
  call_file_id = coalesce(tool_calls.call_file_id, excluded.call_file_id), call_offset = coalesce(tool_calls.call_offset, excluded.call_offset),
  result_file_id = coalesce(tool_calls.result_file_id, excluded.result_file_id), result_offset = coalesce(tool_calls.result_offset, excluded.result_offset),
  subagent_id = coalesce(tool_calls.subagent_id, excluded.subagent_id), workflow_run_id = coalesce(tool_calls.workflow_run_id, excluded.workflow_run_id),
  updated_seq = :seq, updated_at = excluded.updated_at;
```
`rank(x)` is a TypeScript helper that inlines `(CASE x WHEN 'error' THEN 4 WHEN 'denied' THEN 3 WHEN 'interrupted' THEN 2 WHEN 'ok' THEN 1
ELSE 0 END)` (no custom SQL function, so the statement also runs on `node:sqlite`). Executed `[exp:X13]`: a transcript result
(`ok`, bit 8) first, then the hook `PreToolUse` sets `started_at` (bits 9), a hook failure with `duration_ms` wins (`error`, `hook`
duration, bits 11), `PostToolBatch` sets `batch_at` (bits 27), a late `ok` does not regress. After the upsert, `sessions.open_tool_count` and `tool_call_count` are recomputed for the session with
indexed counts (`idx_tool_calls_open`).

**Turns** (`started_at` min; the end fields follow the greater stamp `(ended_at, end_rank, end_tie)`, LWW `[02 4.1]`):
```sql
INSERT INTO turns (session_id, agent_id, prompt_id, started_at, ended_at, end_kind, end_rank, end_tie, origin, tool_count)
VALUES (:sessionId, :agentId, :promptId, :startedAt, :endedAt, :endKind, :endRank, :endTie, :origin, :toolCount)
ON CONFLICT(session_id, prompt_id) DO UPDATE SET
  started_at = coalesce(min(turns.started_at, excluded.started_at), turns.started_at, excluded.started_at),
  end_kind = CASE WHEN ${newer} THEN excluded.end_kind ELSE turns.end_kind END,
  end_rank = CASE WHEN ${newer} THEN excluded.end_rank ELSE turns.end_rank END,
  end_tie  = CASE WHEN ${newer} THEN excluded.end_tie  ELSE turns.end_tie  END,
  ended_at = CASE WHEN ${newer} THEN excluded.ended_at ELSE turns.ended_at END,
  origin = coalesce(turns.origin, excluded.origin), tool_count = max(turns.tool_count, excluded.tool_count);
-- ${newer} = (excluded.ended_at IS NOT NULL AND (turns.ended_at IS NULL OR
--             (excluded.ended_at, excluded.end_rank, excluded.end_tie) > (turns.ended_at, turns.end_rank, turns.end_tie)))
```
Executed `[exp:X13]`: a transcript `end_turn` at 200 (rank 20), then the hook prompt sets `started_at` 100, the hook `Stop` at the same
time with rank 60 wins, an older interrupt at 150 is ignored, a newer interrupt at 250 wins.

**Usage, two levels** (`UsageRepo.applyRecord(ctx, file, key, values)`), inside the caller's transaction:
1. Upsert `usage_files` with per-field maximum that keeps NULL as missing (verified `[exp:X12]`):
   `input_tokens = coalesce(max(usage_files.input_tokens, excluded.input_tokens), usage_files.input_tokens, excluded.input_tokens)` and
   the same for every numeric field; `finalized = max(...)`; `usage_source = CASE WHEN 'iterations' IN (old, new) THEN 'iterations' ELSE
   'top' END`; `synthetic = max(...)`; `record_count + 1`; `invalid_values + :invalid`; `first_ts` min, `last_ts` max; legacy columns max.
2. Recompute the instance value of the key: `SELECT max(input_tokens), ..., max(finalized), max(synthetic), count(*), min(first_ts) FROM
   usage_files WHERE message_key = :k` (aggregate `max` ignores NULL, so a field stays NULL only when every file misses it) and the owner
   file `SELECT u.file_id FROM usage_files u JOIN transcript_files f ON f.id = u.file_id WHERE u.message_key = :k ORDER BY CASE WHEN
   f.birth_ms > 0 THEN f.birth_ms ELSE f.first_seen_mtime_ms END, f.path LIMIT 1` (`idx_usage_files_key`, verified with the `[02 6.4]`
   msg_C shape: input 3, output 420, cache read 1000, cache creation 200, finalized, 2 files, owner the older file `[exp:X12]`). The
   owner session/agent come from that file's `session_id`/`agent_id` (the main agent row for a main file). `model` = the owner file's
   model, else any non-null one.
3. Contribution of a `usage` row to a rollup: `messages 1`, `synthetic`, `unfinalized = synthetic ? 0 : 1 - finalized`, and for each of
   the four main fields `tok_x += coalesce(x, 0)`, `tok_x_missing += (x IS NULL)`. If the owner changed: subtract the old row's
   contribution from the old owner session and agent, add the new contribution to the new owner; else add `new - old` to the owner.
   One `UPDATE sessions` and one `UPDATE agents` per touched owner; `ChangeRecorder.touch('usage', sessionId)`.
4. Upsert `usage` (`ON CONFLICT(message_key) DO UPDATE SET` every column). `UsageRepo.verifyRollups(ctx)` returns rows where a rollup
   differs from `SELECT session_id, sum(...), sum(x IS NULL) FROM usage GROUP BY session_id` (maintenance and tests).
5. `sessions.models` gets the model (`json_insert(models, '$[#]', :model)` when absent, at most 16) and `last_model`.
6. On a file identity reset `[02 5.3]` the importer deletes that file's `usage_files` rows and re-runs step 2 for each affected key.

**Lifecycle views** (`SessionsRepo.writeView(ctx, id, view, factsJson)`, same for agents and workflow runs): `UPDATE ... SET state, presence,
wait_reason, stale_kind, end_reason, turn_outcome, state_basis, state_confidence, state_rule, state_evidence, state_since, evaluated_at,
next_check_at, facts_json`. When `viewChanged(old, new)` `[02 7.8]` is true the update also sets `updated_seq` from a reserved
`session/upsert` (`agent/upsert`, `workflow/upsert`) change, and when `state` differs a `state_transitions` row is inserted
(`from_state, to_state, rule, basis, confidence, evidence, at`). Facts-only updates record no change.

**Activity-only session updates** (`last_activity_at`, counters, rollups, labels) reserve `session/upsert` at most once per second per
session: within the second the session is marked dirty and a 1 s timer runs `withWriteTx` that reserves the change for all dirty
sessions. This bounds stream traffic during backfill while keeping persist-before-publish (the data committed first, the change row
after).

**Reconciliations** (`ReconciliationsRepo.insert`): `INSERT ... ON CONFLICT(scope_key, kind, detail_hash) DO NOTHING`; for a new row the
repository also inserts an `events` row (`kind 'monitor.gap'` for `runtime_unavailable` and `hook_gap`, `'monitor.reconcile'` for the
others, `sources 4`, `severity 1`, `natural_key 'recon:' || id`, `detail` = the reconciliation detail) so timelines and the activity
feed show where data may be missing (brief 8.4). Instance-level rows (`session_id` NULL) produce no timeline row; they reach the UI as
alerts (section 10) and through `GET /health/ingest`.

**Attempts** (`AttemptsRepo`, `packages/engine/src/db/repos/attempts.ts`; the tick algorithm, matching and evidence rules are
`[06 3.10.3-3.10.8]`). One `withWriteTx` per attempts tick holds every `AttemptsRepo` write of that tick (the `attempt/upsert`
reservation, `saveSource`, `resetSource`, `insertRun`, `endRun`, `supersedeRun`, `setMatch`); the chain-log read happens before it,
asynchronously (DA-I12). After that COMMIT the tick submits its `external.attempt` / `external.attempt_cleared` logical events to `[02]`'s
writer (`writer.submit({ source: 'external', items: [{ kind: 'external', events, rows: [] }] })`, `[06 3.10.7]`, N-01), which commits
them in its own transaction and publishes their lifecycle effect as `session/upsert`; the two transactions are not shared. The session
row ids returned by `resetSource` and stored in `attempt_runs.session_id` are mapped to provider ids with `SessionsRepo.uidsByRowIds(ctx,
rowIds): Map<number, string>` (`SELECT id, session_uid FROM sessions WHERE id IN (SELECT value FROM json_each(:idsJson))`, primary key)
before the 02 events are built (N-10). Every changed `attempt_runs` row is stamped with the seq of the one `attempt/upsert` change
reserved for the transaction (9.1).
```ts
export interface AttemptSourceRow { id: number; path: string; pathKey: string; generation: number; ino: string | null; headLen: number;
  headHash: string; readOffset: number; configSha256: string; updatedAt: number }
export type AttemptEndReason = 'open' | 'ended' | 'superseded';
export interface AttemptRunRow { id: number; sourceId: number; generation: number; startOffset: number; part: string; nRaw: string | null;
  model: string | null; effort: string | null; startedAt: number; endOffset: number | null; endedAt: number | null; exitRaw: string | null;
  statusRaw: string | null; endReason: AttemptEndReason; state: AttemptState /* [06 3.3] */; evidence: string; sessionRowId: number | null;
  matchDeltaMs: number | null; updatedSeq: number; updatedAt: number }
export type NewAttemptRun = Pick<AttemptRunRow, 'sourceId' | 'generation' | 'startOffset' | 'part' | 'nRaw' | 'model' | 'effort' | 'startedAt' | 'evidence'>;
export interface AttemptsRepo {
  getSource(ctx: RepoContext, pathKey: string): AttemptSourceRow | undefined;
  saveSource(ctx: RepoContext, tx: WriteTx, s: Omit<AttemptSourceRow, 'id' | 'updatedAt'>): number;      // upsert by path_key, returns id
  /** Config hash changed: returns the session row ids that had an ended matched run, deletes the source's runs, generation 1, offset 0. */
  resetSource(ctx: RepoContext, tx: WriteTx, sourceId: number, configSha256: string): number[];
  openRun(ctx: RepoContext, sourceId: number, generation: number, part: string): AttemptRunRow | undefined;
  insertRun(ctx: RepoContext, tx: WriteTx, r: NewAttemptRun): number | undefined;                         // undefined = already stored
  endRun(ctx: RepoContext, tx: WriteTx, id: number, e: { endOffset: number; endedAt: number; exitRaw: string | null;
    statusRaw: string | null; state: 'COMPLETED' | 'FAILED' | 'UNKNOWN'; evidence: string }): boolean;     // false = not open
  supersedeRun(ctx: RepoContext, tx: WriteTx, id: number, evidence: string): boolean;                     // false = not open
  setMatch(ctx: RepoContext, tx: WriteTx, id: number, sessionRowId: number, matchDeltaMs: number): boolean; // false = already matched
  runsToMatch(ctx: RepoContext, startedSinceMs: number, limit: number): AttemptRunRow[];                  // unmatched, start order
  latestRuns(ctx: RepoContext, limit: number): AttemptRunRow[];                                           // newest `limit`, start order
  evidenceRun(ctx: RepoContext, sessionRowId: number): AttemptRunRow | undefined;                         // newest ended run
  runsByPart(ctx: RepoContext, part: string): AttemptRowRef[];   // [02 7.13] CompletionLookup.attemptRowsByPart, every generation (I-08)
}
```
Statements (normative; `:seq` = the reserved `attempt/upsert` seq, `:now` = `tx.now`):
- `saveSource`: `INSERT INTO attempt_sources (path, path_key, generation, ino, head_len, head_hash, read_offset, config_sha256,
  updated_at) VALUES (...) ON CONFLICT(path_key) DO UPDATE SET path = excluded.path, generation = excluded.generation, ino =
  excluded.ino, head_len = excluded.head_len, head_hash = excluded.head_hash, read_offset = excluded.read_offset, config_sha256 =
  excluded.config_sha256, updated_at = excluded.updated_at RETURNING id`.
- `resetSource`: `SELECT DISTINCT session_id FROM attempt_runs WHERE source_id = :id AND end_reason = 'ended' AND session_id IS NOT
  NULL`; `DELETE FROM attempt_runs WHERE source_id = :id` (autoindex of the natural key); `UPDATE attempt_sources SET generation = 1,
  read_offset = 0, config_sha256 = :cfg, updated_at = :now WHERE id = :id`; the change payload gets `truncated: true`.
- `openRun`: `SELECT ... FROM attempt_runs WHERE source_id = :s AND generation = :g AND part = :p AND end_reason = 'open' ORDER BY
  start_offset DESC LIMIT 1` (`idx_attempt_runs_open`).
- `insertRun`: `INSERT INTO attempt_runs (source_id, generation, start_offset, part, n_raw, model, effort, started_at, end_reason, state,
  evidence, updated_seq, updated_at) VALUES (:sourceId, :generation, :startOffset, :part, :nRaw, :model, :effort, :startedAt, 'open',
  'RUNNING', :evidence, :seq, :now) ON CONFLICT(source_id, generation, start_offset) DO NOTHING RETURNING id` (a re-read after a crash
  between read and commit cannot happen because `read_offset` commits with the rows; the conflict clause makes it harmless anyway).
- `endRun`: `UPDATE attempt_runs SET end_reason = 'ended', state = :state, end_offset = :endOffset, ended_at = :endedAt, exit_raw =
  :exitRaw, status_raw = :statusRaw, evidence = :evidence, updated_seq = :seq, updated_at = :now WHERE id = :id AND end_reason = 'open'`.
- `supersedeRun`: `UPDATE attempt_runs SET end_reason = 'superseded', state = 'UNKNOWN', evidence = :evidence, updated_seq = :seq,
  updated_at = :now WHERE id = :id AND end_reason = 'open'`.
- `setMatch`: `UPDATE attempt_runs SET session_id = :sessionRowId, match_delta_ms = :delta, updated_seq = :seq, updated_at = :now WHERE
  id = :id AND session_id IS NULL` (a matched run keeps its session, `[06 3.10.6]`).
- `runsToMatch`: `SELECT ... FROM attempt_runs WHERE started_at >= :since AND session_id IS NULL ORDER BY started_at, id LIMIT :limit`
  (`idx_attempt_runs_start`).
- `latestRuns`: `SELECT * FROM (SELECT ... FROM attempt_runs ORDER BY started_at DESC, id DESC LIMIT :limit) ORDER BY started_at, id`.
- `evidenceRun`: `SELECT ... FROM attempt_runs WHERE session_id = :sid AND end_reason = 'ended' ORDER BY started_at DESC, id DESC
  LIMIT 1` (`idx_attempt_runs_session`; the legacy "latest START wins" rule of `[06 3.10.7]`).
- `runsByPart` (I-08): `SELECT r.id, r.part, r.started_at, r.ended_at, r.end_reason, r.state, r.evidence, s.session_uid FROM attempt_runs r
  LEFT JOIN sessions s ON s.id = r.session_id WHERE r.part = :part ORDER BY r.started_at, r.id` (`:part` clipped like a stored part;
  `sessionId` = `session_uid`, null when unmatched or detached). No index covers `part` across generations: the call is
  operator-triggered (`verify-completion`), never polled, and DA-T-API-15 records its plan and time (O-5).
Value rules applied by the repository before every write: `part`, `nRaw`, `exitRaw`, `model`, `effort`, `statusRaw` and `evidence` are
clipped to their column caps (3.1) by code points with `clip()` of `[02 2.5]`; empty `model`/`effort` become NULL (legacy `or None`); a
clipped `part` stays the matching key (session labels are at most 200 code points, so a part longer than that never matches anyway).
Attempt rows are never deleted by bookkeeping retention (history of every generation, `[06 3.10.8]`); data retention detaches them from
deleted sessions (3.8 step 3j); they are not exported (11.1: the chain log in the repository is their source).
Match candidates for `[06 3.10.6]`: `SessionsRepo.attemptCandidates(ctx, labels: readonly string[], activeSinceMs: number):
AttemptCandidate[]` with `AttemptCandidate = { sessionRowId: number; sessionId: string; label: string; matched: boolean;
firstRecordAtMs: number | null; lastActivityAtMs: number }`:
`SELECT s.id, s.session_uid, s.label, (s.matched = 1 OR s.pinned = 1) AS matched, f.first_ts_in_order, coalesce(f.mtime_seen,
s.last_activity_at) AS last_activity FROM sessions s LEFT JOIN transcript_files f ON f.id = s.transcript_file_id WHERE
s.last_activity_at >= :since - 3600000 AND s.label IN (SELECT value FROM json_each(:labelsJson))` (`idx_sessions_activity`; at most
500 labels per call, chunked). `firstRecordAtMs` = `Date.parse(first_ts_in_order)` (the first record in file order with a string
`timestamp`, legacy `usage.first`), `NaN` -> `null`; `lastActivityAtMs` = the main file's `mtime_seen` (legacy `age`), else
`last_activity_at`. The one-hour slack only widens the prefilter; `[06 3.10.6]` applies the exact window and delta rules.
Completion candidates for `[02 7.13]` (I-08): `SessionsRepo.completionCandidates(ctx, by: { sessionId: string } | { label: string }):
CompletionCandidate[]` (`[02 7.13]`'s type: `{ sessionId, label, startedAt, lastActivityAt, view }`): `SELECT s.session_uid, s.label,
s.started_at, s.last_activity_at, <the stored view columns of 3.5>, s.facts_json FROM sessions s WHERE s.session_uid = :id` (unique index)
or `WHERE s.label = :label` (exact, case-sensitive; a scan of `sessions`, O-5); `view` is rebuilt from the stored columns exactly as the
lifecycle sweeper reads it. `CompletionLookup.sessionById` returns the single element or null.

**Write discipline** (DA-I12): the ingestion tick of `[02 4.6]` (500 items or 8 ms) is the dominant writer. Measured on the final schema
(nine event indexes, ordered timestamps, random ids): about 16,000 event rows/s with 500-row transactions, slowest transaction 99.6 ms
including WAL auto-checkpoints `[exp:X12]`; on the first schema draft (six indexes) 28,000-30,000 rows/s, 120,000 rows/s in memory,
162,000 rows/s without secondary indexes, CHECK constraints not measurable `[exp:X3]`. The 8 ms tick therefore commits about 130 event
rows per transaction on this machine; disk I/O and index maintenance dominate.

### 3.7 Index justification (measured)

Two synthetic datasets. `[exp:X2]` (first schema draft, same index design for the tables below): 3 projects, 2,000 sessions over 60 days,
8,000 agents and transcript files, 80,000 tool calls, 400,000 events, 150,000 usage rows, 50,000 change rows (196 MB file).
`[exp:X12]` (final schema): 500 sessions, 100,000 events, 50,000 usage rows (38.9 MB). Plans from `EXPLAIN QUERY PLAN` after `ANALYZE`;
times are averages of 10-20 warm runs.

| Query (API use) | Index | Plan detail | ms |
|---|---|---|---|
| Sessions page in a window, `ORDER BY last_activity_at DESC, id DESC LIMIT 51` (+ keyset) (`listSessions`) | `idx_sessions_activity` | SEARCH, covering for keyset | 0.03-0.06 |
| Sessions by state | `idx_sessions_state_activity` | SEARCH + temp b-tree for ORDER BY | 0.03 |
| Sessions by project | `idx_sessions_activity` (planner choice) | SEARCH | 0.04 |
| Sessions sorted by tokens (expression) | none | SCAN + temp b-tree (2,000 rows) | 0.36 |
| Sessions `q` (`instr(search_text, ?)`) | `idx_sessions_activity` | SCAN in index order | 0.30 |
| Overview state counts `GROUP BY state` | `idx_sessions_state_activity` | SCAN covering | 0.33 |
| Lifecycle sweeper `next_check_at <= ? LIMIT 200` `[02 7.8]` | `idx_sessions_next_check` (partial) | SEARCH covering | 0.02 `[X12]` |
| Session timeline `WHERE session_id = ? ORDER BY ts DESC, id DESC` (+ keyset) | `idx_events_session_ts` | SEARCH covering | 0.01-0.02 |
| Activity feed newest first (+ keyset) | `idx_events_ts` | SCAN / SEARCH covering | 0.02-0.10 |
| Feed by event kinds / categories | `idx_events_kind_ts` | SEARCH covering | 0.02-0.07; **without this index 113-128 ms** `[X2b]` |
| Feed problems (`severity > 0`) | `idx_events_problems` (partial) | SCAN partial | 0.01 |
| Live tail `id > ? ORDER BY id LIMIT 500`; stream hydration `id BETWEEN ? AND ? AND +session_id = ?` | primary key | SEARCH rowid | 0.04; 0.018 `[X8]` |
| D-3 content window `[02 4.4]` | `idx_events_content` (partial) | SEARCH covering, all five terms | 0.02 `[X12]` |
| Feed `q` in a 24 h window, no match | `idx_events_ts` | SEARCH + filter | 0.52 |
| Feed `q` in a 7 d window, no match (worst case) | `idx_events_ts` | SEARCH + filter | 362 (hence the scan cap, rule 2) |
| Feed `q` over all time, no match | `idx_events_ts` | SCAN | 1817 (hence: refused, rule 2) |
| Feed `tool` filter through `tool_calls`, rare tool, 7 d | `idx_tool_calls_name` + bloom filter | SEARCH | 73 (direct `events.tool_name` filter: 395) |
| Session-scoped `q` (no window) | `idx_events_session_ts` | SEARCH | 1.6 |
| Open tool calls of a session `[02 7.4]` | `idx_tool_calls_open` (partial) | SEARCH | < 0.01 `[X12]` |
| Tool calls by name in 7 d; tool frequency | `idx_tool_calls_name` | SEARCH covering; SEARCH (ANY(name) AND started_at>?) | 0.02; 3.5 |
| Instance value of a message key | `idx_usage_files_key` | SEARCH | < 0.1 `[X12]` |
| Usage totals in a window | `idx_usage_ts_cover` (INDEXED BY) | SEARCH covering | 3.8 (7 d, 50k rows) `[X12]`; 18 (30 d, 150k rows); non-covering `(ts, model)`: 185 |
| Usage per model in a window | `idx_usage_ts_cover` | SEARCH covering + temp b-tree | 8.1 `[X12]`; 40 (30 d); non-covering: 218 |
| Usage hourly / daily buckets | `idx_usage_ts_cover` | SEARCH covering | 10 (7 d hourly); 23 (60 d daily; SCAN table: 85) |
| Usage per session top 20 in 30 d | `idx_usage_ts_cover` **forced** | SEARCH covering | 15.6 (planner's own choice `idx_usage_session`: 129-190) |
| Usage per project in 30 d (group by session first, then join) | `idx_usage_ts_cover` forced | CO-ROUTINE + PK join | 11.8 (planner's own join: 216) |
| Session usage by model | `idx_usage_session` | SEARCH | 0.10 |
| Running agents | `idx_agents_state_activity` (partial) | SEARCH | 0.02 |
| Agents of a session | autoindex `(session_id, agent_uid)` | SEARCH | 0.02 |
| Stream replay `seq > ? LIMIT 2000` | primary key | SEARCH rowid | 0.03 |
| Ingest errors of a code in a window (alert input `[02 8.3]`) | `idx_ingest_errors_code` | SEARCH covering | 0.01 `[X12]` |
| Reconciliations of a kind since t | `idx_reconciliations_kind_at` | SEARCH covering | 0.01 `[X12]` |
| Open alerts | `idx_alerts_status` | SEARCH covering | < 0.01 |
| Open attempt of a part (attempts tick `[06 3.10.3]`) | `idx_attempt_runs_open` (partial) | SEARCH covering | 0.05 `[X14]` |
| Attempts panel: newest 30 in start order | `idx_attempt_runs_start` | SCAN index with LIMIT, 30 rows re-sorted | 0.08 `[X14]` |
| Evidence attempt of a session | `idx_attempt_runs_session` (partial) | SEARCH + temp b-tree over that session's runs | 0.03 `[X14]` |
| Unmatched attempts in the match window | `idx_attempt_runs_start` | SEARCH (started_at>?) | 0.11 `[X14]` |
| Hook probe by id (`ingestProbe`) | primary key | SEARCH | 0.01 `[X14]` |
| Attempt match candidates (`SessionsRepo.attemptCandidates`, 5,000 sessions) | `idx_sessions_activity` + bloom filter on the label list, main file by primary key | SEARCH | 0.06 `[X14]` |
| Retention candidates | `idx_sessions_activity` | SEARCH (last_activity_at<?) | 0.20 |
| Rollup verification (all sessions) | `idx_usage_session` + automatic index | MATERIALIZE | 118 (maintenance only) |

Rules derived from these numbers (normative for the query layer; plan snapshots in DA-T-DB-14):
1. Every analytics aggregate over a time window names `INDEXED BY idx_usage_ts_cover`; per-project aggregation first groups `usage` by
   `session_id` in a subquery, then joins `sessions`. A missing index then fails loudly instead of silently scanning.
2. Event `q` and event `tool` filters require a `session` filter or a window of at most 7 days (`400 filter_requires_scope`); the `q`
   filter scans at most the newest 50,000 events of the window (`ORDER BY ts DESC, id DESC LIMIT 50000` subquery) and the page says
   `scanCapped: true` when the cap was reached.
3. No query on `events`, `usage`, `usage_files` or `tool_calls` without `LIMIT`, except rollup verification and export (keyset chunks).
4. Session deletion runs in batches of at most 10 sessions per transaction (50 sessions with about 10k events took 1.1 s in one
   transaction `[X2]`; 150 sessions with 75k small events 346-379 ms `[X7]`).

### 3.8 Retention and cleanup

Two classes (ADR 0028):
- **Automatic retention** (server timer, bookkeeping only; never sessions or events): 60 s after start and every 6 h, each category in
  transactions of at most 5,000 rows (`WHERE rowid IN (SELECT rowid ... LIMIT 5000)`; no `DELETE ... LIMIT`, for `node:sqlite`), then
  `PRAGMA incremental_vacuum(2000)` until `freelist_count = 0` (21 MB freed in 3 steps, 74-76 ms `[exp:X7]`).
- **Data retention** (`applyRetention`, below): deletes old sessions and/or old timeline rows. Run only by the CLI command
  `mcs cleanup --task S --scope data` on a stopped instance, with dry run by default, `--yes --confirm <slug>`, and an automatic
  backup first `[01 6.4]`. The server never deletes session data on its own.

`runtime.json` section `retention` (owned by this document; composed by the config design `[01 1.6]`, `RetentionSectionSchema` with
`.prefault({})`):

| Key | Default | Range | Used by |
|---|---|---|---|
| `retention.changesMaxAgeHours` | 24 | 1..720 | automatic: `DELETE FROM changes WHERE seq IN (SELECT seq FROM changes WHERE at < :cutoff ORDER BY seq LIMIT 5000)` |
| `retention.changesMaxRows` | 20000 | 2000..1000000 | automatic: `DELETE FROM changes WHERE seq IN (SELECT seq FROM changes WHERE seq <= (SELECT max(seq) FROM changes) - :maxRows ORDER BY seq LIMIT 5000)` |
| `retention.ingestErrorsMaxRows` | 1000 (`[02 4.1]`) | 100..100000 | automatic: `DELETE FROM ingest_errors WHERE id IN (SELECT id FROM ingest_errors ORDER BY at DESC, id DESC LIMIT -1 OFFSET :max)` |
| `retention.resolvedAlertsDays` | 30 | 1..3650 | automatic: `DELETE FROM alerts WHERE id IN (SELECT id FROM alerts WHERE status = 'resolved' AND resolved_at < :cutoff LIMIT 5000)`; `alert_state` rows with no condition, no cooldown and older than the cutoff |
| `retention.instanceReconciliationsDays` | 90 | 1..3650 | automatic: instance-level `reconciliations` (`session_id IS NULL`) older than the cutoff |
| (fixed) | - | - | automatic: `transcript_checkpoints`, `usage_files` and `entry_occurrences` of files in state `retired` with `session_id IS NULL`; `hook_probes` with `committed_at` older than 24 h |
| `retention.sessionsDays` | null (keep) | null or 1..3650 | `applyRetention` default for sessions when `--older-than` is not given |
| `retention.eventsDays` | null (keep) | null or 1..3650 | `applyRetention` default for timeline rows (sessions, tool calls, usage and turns are kept) |

Spool segments `[02 2.7]`, backups (`backup.keep` `[01 1.6]`) and log files are retained by their owners.

```ts
// packages/engine/src/maintenance/retention.ts
export interface RetentionPolicy { sessionsOlderThanDays: number | null; eventsOlderThanDays: number | null }
export interface RetentionPlan {
  now: number; sessionsCutoff: number | null; eventsCutoff: number | null;
  sessions: number; sessionSample: { sessionId: string; label: string; lastActivityAt: number; state: string }[];  // <= 20 oldest
  rows: { agents: number; events: number; toolCalls: number; turns: number; usage: number; usageFiles: number; transitions: number;
          reconciliations: number; costStates: number; checkpoints: number; attemptRunsDetached: number };
  reownedMessages: number;          // message keys that move to another session's file after the deletion (step 3)
}
export function applyRetention(db: InstanceDb, ctx: RepoContext, policy: RetentionPolicy,
  opts: { dryRun: boolean; now: number; signal?: AbortSignal }): Promise<RetentionPlan & { applied: boolean; freedBytes: number | null }>;
```
Algorithm (requires a writer connection on a stopped instance; the caller made the backup):
1. Session candidates: `SELECT id, session_uid FROM sessions WHERE last_activity_at < :cutoff AND pinned = 0 AND state IN
   ('completed','failed','stale','unknown','turn_ended','waiting_input') ORDER BY last_activity_at, id` (`idx_sessions_activity`).
   Active states (`running`, `working`, `waiting_tool`, `waiting_agent`) are never eligible.
2. Counts per table by indexed `count(*)` over the candidates; `dryRun` returns here.
3. For each batch of at most 10 sessions, one transaction: (a) `batchFiles = SELECT id FROM transcript_files WHERE session_uid IN
   (:uids)`; (b) `reowned = SELECT DISTINCT message_key FROM usage_files WHERE file_id IN (:batchFiles) AND message_key IN (SELECT
   message_key FROM usage_files WHERE file_id NOT IN (:batchFiles))`; (c) `DELETE FROM sessions WHERE id IN (:ids)` (cascades to agents,
   workflow runs, turns, tool calls, events, usage, cost states, transitions, session reconciliations, external observations,
   work-item links; `alerts.session_id` becomes NULL); (d) `DELETE FROM usage_files WHERE file_id IN (:batchFiles)`, the same for
   `entry_occurrences` and `transcript_checkpoints`; (e) `UPDATE transcript_files SET state = 'retired', session_id = NULL, agent_id =
   NULL, workflow_run_id = NULL, updated_at = :now WHERE id IN (:batchFiles)` (cursors kept: the importer never re-imports deleted
   history from a transcript that still exists; a retired file that grows again is reactivated from its cursors, only new records are
   imported); (f) for each `reowned` key re-run the usage recompute of 3.6 steps 2-4 (the message moves to the oldest remaining file);
   (g) open session-scoped alerts of the batch -> `resolved` with `scope_deleted`; (h) recompute `work_items.session_count`; (i) one
   `session/delete` change per session; (j) attempts are detached, not deleted (chain-log history, `[06 3.10.8]`): `UPDATE attempt_runs
   SET session_id = NULL, match_delta_ms = NULL, updated_seq = :seq, updated_at = :now WHERE session_id IN (:ids)`
   (`idx_attempt_runs_session`), plus one `attempt/upsert` change with `truncated: true` when rows changed. Yield between batches; check
   `signal`.
4. Timeline retention (`eventsCutoff`): `DELETE FROM events WHERE id IN (SELECT e.id FROM events e JOIN sessions s ON s.id =
   e.session_id WHERE e.ts < :cutoff AND s.state NOT IN ('running','working','waiting_tool','waiting_agent') ORDER BY e.ts LIMIT 5000)`
   repeated; `sessions.event_count` recomputed for touched sessions.
5. `PRAGMA wal_checkpoint(TRUNCATE)`, `incremental_vacuum` loop, `freedBytes` = file size before minus after.

Growth estimate: about 330-340 bytes per event including indexes on both datasets (`[X2]` 400k events in 136 MB of events data and
indexes; `[X12]` 100k events, 50k usage rows, 500 sessions in 38.9 MB). 100k events per day is about 34 MB/day; the `db_disk` alert
(section 10) warns at 2048 MB by default.

## 4. Migration framework and the repository boundary (ADR 0021)

### 4.1 Files

```
runtime/packages/engine/migrations/
  0001_initial.sql            -- header line: "-- mcs:migration version=1 name=initial"
  0002_<snake_name>.sql       -- future; optional directive line "-- mcs:foreign_keys=off" for table rebuilds
runtime/packages/engine/src/db/migrations.ts   -- the only code that applies DDL
runtime/packages/engine/test/fixtures/db/v<N>.db -- one fixture DB per released schema version, written by that version's runner
```
The `.sql` files ship as plain files next to `dist/` (the runtime folder is the template, D6). The runner resolves them with
`new URL('../../migrations/', import.meta.url)` and fails with `migrations_missing` when absent. File name pattern
`^(\d{4})_([a-z0-9_]{1,48})\.sql$`; the number must equal `version=` in the header; versions start at 1 without gaps (`migration_gap`).
Checksum: sha256 (hex) of the text after removing a UTF-8 BOM and converting CRLF to LF (a Windows checkout with other git settings must
not change checksums; the repository has `* text=auto eol=lf`).

### 4.2 Bootstrap table (created by the runner, never by a migration file)

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version         INTEGER PRIMARY KEY NOT NULL CHECK (version >= 1),
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  checksum        TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at      INTEGER NOT NULL,
  runtime_version TEXT NOT NULL CHECK (length(runtime_version) BETWEEN 1 AND 32),
  duration_ms     INTEGER NOT NULL CHECK (duration_ms >= 0)
) STRICT;
```
`PRAGMA user_version` mirrors `max(version)` so that `peekDbSchemaVersion` can read it without a lock.

### 4.3 Runner and the functions other designs call

```ts
// packages/engine/src/db/migrations.ts
export interface MigrationFile { version: number; name: string; checksum: string; sql: string; foreignKeysOff: boolean }
export interface MigrationStatus { dbVersion: number; latest: number; pending: MigrationFile[]; isNew: boolean }
export function loadMigrationFiles(dir?: URL): MigrationFile[];                            // sorted; validates names, headers, gaps
export function migrationStatus(db: SqlDriver, files: MigrationFile[]): MigrationStatus;   // read-only; throws DbError
/** [01 4.7 step 5]: no lock, read-only open, PRAGMA user_version only. null when the file does not exist. */
export function peekDbSchemaVersion(path: string): { userVersion: number; latest: number } | null;
/** [01 5.4 step 3]: what `upgrade`/`db migrate` would apply. */
export function planDbMigrations(path: string): { from: number; to: number; steps: { version: number; name: string }[] };
/** [01 5.4 step 7]: applies pending migrations. The caller holds the task mutex, the instance is stopped, and the backup is done. */
export function migrateDb(path: string, opts: { backupDone: boolean; runtimeVersion: string; expectedInstanceId: string; now?: () => number }):
  { from: number; to: number; durationMs: number };
```

`migrationStatus`:
1. A file without tables (`user_version = 0`, `sqlite_schema` empty): `isNew = true`, `pending = all`.
2. Else read `schema_migrations`. Every applied version must exist among the shipped files (`migration_unknown`, treated as newer) and
   its checksum must match (`migration_checksum_mismatch`, names the version, never auto-repairs).
3. `max(applied) > latest` -> `db_newer_than_runtime` (D13); the file is not modified (sha256 test).
4. Applied versions must be exactly `1..max(applied)` (`migration_gap`).
5. `pending` = shipped versions above `max(applied)`.

`migrateDb` (also used internally by `openInstanceDb` for a new file):
1. Refuse `backup_required` when the DB has tables, `pending` is non-empty and `backupDone` is false. The backup itself is the caller's
   (`[01 5.4]`: `backup` with reason `upgrade` through `backupDb`).
2. New file: `PRAGMA auto_vacuum = INCREMENTAL`, `journal_mode = WAL` (with BUSY retry), `application_id = 1296253747`.
3. For each pending file in order: if `foreignKeysOff`, `PRAGMA foreign_keys = OFF` before `BEGIN` (inside a transaction it is
   ignored `[exp:X10]`); `BEGIN IMMEDIATE`; `exec(sql)`; `INSERT INTO schema_migrations (version, name, checksum, applied_at,
   runtime_version, duration_ms) VALUES (:v, :name, :checksum, :now, :runtimeVersion, :ms)`; `PRAGMA user_version = N`; for version 1
   also the `meta` rows of 3.3 (with `expectedInstanceId`); `PRAGMA foreign_key_check` must be empty (`migration_fk_violation`);
   `COMMIT`; `PRAGMA foreign_keys = ON`. On error: `ROLLBACK`, `PRAGMA foreign_keys = ON`, throw `migration_failed { version,
   sqliteCode }` (never SQL text with data). Earlier steps of the same run stay applied (each is atomic); the backup is the recovery point.
4. `PRAGMA optimize`.

Error codes (`DbErrorCode`, `packages/engine/src/db/errors.ts`): `db_busy`, `db_locked`, `db_not_mcs`, `db_identity_mismatch`,
`db_corrupt`, `db_readonly`, `db_full`, `db_io`, `db_cantopen`, `db_constraint`, `db_migration_required`, `db_newer_than_runtime`,
`migration_checksum_mismatch`, `migration_gap`, `migration_unknown`, `migration_failed`, `migration_fk_violation`, `migrations_missing`,
`backup_required`, `backup_failed`, `scope_mismatch`. SQLite mapping (better-sqlite3 `err.code`; `node:sqlite` `err.errcode`):
`SQLITE_BUSY*` -> `db_busy`; `SQLITE_LOCKED*` -> `db_locked`; `SQLITE_CORRUPT*`, `SQLITE_NOTADB` -> `db_corrupt`; `SQLITE_READONLY*` ->
`db_readonly`; `SQLITE_FULL` -> `db_full`; `SQLITE_IOERR*` -> `db_io`; `SQLITE_CANTOPEN*` -> `db_cantopen`; `SQLITE_CONSTRAINT*` ->
`db_constraint` with `constraint: 'unique' | 'check' | 'foreignkey' | 'notnull' | 'datatype' | 'other'`.

### 4.4 Backup function and recovery guidance

```ts
// packages/engine/src/db/backup.ts  [01 5.5]: the folder, manifest, pruning and restore belong to 01
export function backupDb(src: InstanceDb | { path: string; expectedInstanceId: string }, destPath: string,
  opts?: { onProgress?: (p: { totalPages: number; remainingPages: number }) => void }): Promise<{ bytes: number; dbSchemaVersion: number }>;
```
1. Source: the server's writer connection (control op `backup` `[01 4.3]`, the server stays the only writer) or, with a path, a
   read-only connection opened with the identity check only (no schema check: an older schema must be backed up before `upgrade`).
   For the writer, `PRAGMA wal_checkpoint(PASSIVE)` first.
2. `destPath` must not exist and its folder must exist (01 checks containment and the `.partial` folder).
3. `driver.backupTo(destPath)` (SQLite online backup API; better-sqlite3 copies pages in steps with the event loop free between them;
   that concurrent writes during a backup leave a consistent copy is UNVERIFIED until DA-T-E-3 runs).
4. Open the copy read-only: `PRAGMA quick_check` = `ok`, `application_id`, `meta.instance_id`, `user_version`; any mismatch -> delete
   the copy, throw `backup_failed`.
Measured: online backup of a 196 MB DB 581 ms from the writer `[exp:X1]`, of a 38.9 MB DB 124 ms from a read-only connection, copy passed
`quick_check` `[exp:X12]`; `quick_check` 988 ms and full `integrity_check` 7.6 s on 196 MB `[exp:X1]` (full check only on request).

Recovery guidance (goes to `docs/operations.md` with `[01 5.6]`, registry C20):
- Migrations are forward-only; the recovery point of every migration is the `upgrade` backup made by `[01 5.4]`; rollback is
  `mcs backup restore --id <that backup>` `[01 5.5]`, run by the older runtime if needed (it refuses the newer DB until then).
- A failed migration leaves the DB at the last successful version; fix the cause (disk, permissions), rerun `mcs db migrate`, or restore.
- A checksum mismatch means a shipped migration file was edited after release: restore the original file from git; the runner never
  rewrites `schema_migrations`.
- A corrupt DB (`db_corrupt`, `quick_check` not `ok`): stop, restore the newest good backup, or start from an empty DB (move
  `monitor.db` aside; the next `start` creates a new DB and the importer re-imports the transcripts and spool segments still on disk;
  history no longer on disk is lost).
- There is no `reimport` command (I-12): rebuilding from the sources still on disk is exactly "stop, back up, move `monitor.db` aside,
  start". If `[01]` adds `mcs db rebuild --task S --yes --confirm <slug>`, it performs these steps on a stopped instance (backup first,
  audited) and calls no DB function other than `backupDb`.
- Stale `-wal`/`-shm` after a hard kill are recovered by SQLite on the next open; only `[01 5.5]` restore removes them, with the instance
  stopped and the task mutex held.

### 4.5 Repository module boundary

`packages/engine/src/db/driver.ts` is the **only** file that imports `better-sqlite3` (ESLint `no-restricted-imports` with an override for
that file, plus a grep test; design 05's ESLint rules in A.9 and 2.2 name this same path, I-14). Switching to `node:sqlite` when the
Node floor reaches 24.15 (D7) changes this file only.

```ts
// packages/engine/src/db/driver.ts
export type SqlValue = number | bigint | string | Uint8Array | null;
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;
export interface Stmt<R> {
  run(params?: SqlParams): { changes: number; lastInsertRowid: number };
  get(params?: SqlParams): R | undefined;
  all(params?: SqlParams): R[];
}
export interface SqlDriver {
  readonly path: string;
  readonly readonly: boolean;
  prepare<R = Record<string, SqlValue>>(sql: string): Stmt<R>;          // cached by SQL text (LRU 200)
  exec(sql: string): void;
  transaction<T>(fn: () => T, mode?: 'deferred' | 'immediate'): T;     // synchronous fn only; rollback on throw
  pragma(text: string): unknown;
  backupTo(destPath: string, onProgress?: (p: { totalPages: number; remainingPages: number }) => void): Promise<void>;
  close(): void;
}
export function openSqlite(path: string, opts: { readonly: boolean; fileMustExist: boolean; timeoutMs: number }): SqlDriver;
export function toDbError(err: unknown): DbError;
```
No `iterate()` is exposed: an open iterator keeps the connection busy, so long reads page by keyset (export, verification).

```ts
// packages/engine/src/db/open.ts
export interface RepoContext { readonly instanceId: string }
export type OpenMode = 'serve' | 'readonly' | 'maintenance';   // maintenance = writer on a stopped instance (db migrate, cleanup --scope data)
export interface InstanceDb {
  readonly driver: SqlDriver; readonly instanceId: string; readonly mode: OpenMode; readonly epoch: string; // epoch: 8 hex, new per open
  assertScope(ctx: RepoContext): void;           // DbError('scope_mismatch') unless ctx.instanceId === instanceId
  headSeq(): number;                             // coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'changes'), 0)
  close(): void;                                 // writer modes: PRAGMA optimize first
}
export function openInstanceDb(o: { path: string; expectedInstanceId: string; mode: OpenMode; runtimeVersion: string }): InstanceDb;
export const DB_OPEN_EXIT_CODES: Readonly<Record<DbErrorCode, 11 | 14 | 15 | 16>>;   // 3.2: identity 11, newer 15, older 16, else 14
```
`serve` creates a missing file at the latest schema; `readonly` and `maintenance` require an existing file. All three refuse
`db_newer_than_runtime`; `serve` and `readonly` refuse `db_migration_required`; `maintenance` allows it only for `migrateDb`.

Repositories (`packages/engine/src/db/repos/*.ts`): `MetaRepo`, `ProjectsRepo`, `SessionsRepo`, `AgentsRepo`, `WorkflowRunsRepo`,
`TurnsRepo`, `EventsRepo`, `ToolCallsRepo`, `UsageRepo`, `TranscriptFilesRepo`, `CheckpointsRepo`, `TransitionsRepo`,
`ReconciliationsRepo`, `ExternalObservationsRepo`, `CostStatesRepo`, `HookProbesRepo`, `WorkItemsRepo`, `IngestHealthRepo`,
`IngestErrorsRepo`, `SpoolCursorsRepo`, `AttemptsRepo` (3.6), `AlertsRepo`, `ChangesRepo`. Each is constructed with an `InstanceDb`; every public method takes
`ctx: RepoContext` first and calls `db.assertScope(ctx)` before any statement. Repositories hold SQL only; the rules live in the
engine services and in the ingestion/lifecycle modules of `[02]`. The server and the CLI never import repositories (ESLint
`no-restricted-imports` on `**/db/repos/**` outside `packages/engine/src`).

```ts
// packages/engine/src/db/write.ts
export interface WriteTx { readonly changes: ChangeRecorder; readonly now: number }
/** The only transaction entry point: BEGIN IMMEDIATE, fn, ChangeRecorder.flush(), COMMIT, then onCommitted(headSeq).
 *  fn must be synchronous (DA-I12). A throw rolls back and nothing is published. */
export function withWriteTx<T>(db: InstanceDb, ctx: RepoContext, fn: (tx: WriteTx) => T): T;
export function onCommitted(db: InstanceDb, listener: (headSeq: number) => void): () => void;   // the stream hub subscribes (9.2)
```

## 5. API v3 conventions (ADR 0026)

### 5.1 Basics

| Topic | Rule |
|---|---|
| Base | `http://127.0.0.1:<port>/api/v3/...`, one process per instance (D2): every route is implicitly scoped to that instance; there are no cross-instance routes (D11). |
| Read-only | Every route is `GET` (and implicit `HEAD`) except `POST /api/v3/ingest/nudge` (DA-I11). Backups, upgrades, restores and cleanups are CLI operations `[01 5, 6.4]`; while a server runs the CLI uses the control channel for backups `[01 4.3]`. The UI is read-only (`[04]` ADR 0031). |
| Versioning | The path carries the major version. Inside v3, changes are additive (new routes, optional params, new fields); removal or renaming needs v4. Response schemas are `z.strictObject` in `@mcs/shared` so contract tests catch undocumented fields; the stream `hello` carries `runtimeVersion` and `codeStamp` so a page built by an older runtime can ask for a reload. |
| Format | JSON, UTF-8, `Content-Type: application/json; charset=utf-8`; the export route streams `application/x-ndjson`; the stream route `text/event-stream`. |
| Ids | `instanceId` uuid v4; `sessionId` = Claude session id, lowercase `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (not `z.uuid()`, which enforces RFC variant bits `[exp:X6]`); `agentId` = `'main'` or the Claude agent id `^[0-9A-Za-z_-]{3,64}$`, always with its `sessionId`; `projectId` = lowercase sanitized project folder name `^[a-z0-9][a-z0-9-]{0,254}$`; `eventId`, `toolCallId`, `workItemId`, `alertId` = positive integers stable for the life of the DB; `eventKey` / `workItemKey` = natural keys stable across a rebuild (used in exports); `toolUseId` = provider id `^[A-Za-z0-9_-]{1,128}$`. |
| Time | Output: ISO-8601 UTC with milliseconds and `Z` (`new Date(ms).toISOString()`). Input: ISO-8601 with `Z` or an offset (`z.iso.datetime({ offset: true })`), normalised to epoch ms. Durations are integer `...Ms`, sizes integer `...Bytes`. Presets (`range`) resolve with the server clock. |
| Missing vs zero | Unknown is `null`; `0` means measured zero (DA-I9). |
| Request id | Every response has `X-Request-Id: r-<12 base36>`; the error envelope repeats it. The logger records route id, status, duration, request id only (never query strings, bodies or search text). |
| Instance stamp | Every API response has `X-MCS-Instance: <instanceId>` and `X-MCS-Runtime: <runtimeVersion>+<codeStamp>`. |
| Snapshot position | Every snapshot body has `asOfSeq` (the change-log head read in the same synchronous step as the data, DA-I8). |
| Headers | `/api/*`: `Cache-Control: no-store`; every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `X-Frame-Options: DENY` (ADR 0045); static assets and CSP follow `[04]` ADR 0039; `x-powered-by` disabled; never `Access-Control-Allow-*`. |
| Server limits | ADR 0045: `headersTimeout 10000`, `requestTimeout` = `server.requestTimeoutMs` (default 30000, `[01 1.6]`), `keepAliveTimeout 5000`, `maxHeadersCount 64`, `server.maxConnections 128`, 16 SSE streams. |

### 5.2 Guards, limits and the error envelope

Middleware order (`packages/server/src/http/guards.ts`; the request-security rules and limits are ADR 0045 of design 05, the error codes are
this catalogue):
1. `requestContext`: request id, start time, `X-MCS-Instance`, `X-MCS-Runtime`.
2. `hostGuard`: `Host` must equal (case-insensitive) `127.0.0.1:<port>` or `localhost:<port>` (the bound port); everything else,
   including an empty Host, `0.0.0.0` and `[::1]` (the server binds 127.0.0.1 only, C6), -> `403 host_not_allowed` (DNS-rebinding
   defence).
3. `originGuard`: a present `Origin` must be `http://127.0.0.1:<port>` or `http://localhost:<port>` (`null` refused); dev mode works
   because the Vite proxy rewrites `Origin` (`[04 E9]`, ADR 0045), so the allow-list is exactly these two values and has no configuration
   key (there is no `server.devOrigins`, I-31); else `403 origin_not_allowed`. `Sec-Fetch-Site: cross-site` (any
   method) or `same-site` (non-GET) -> `403 cross_site_request`.
4. `uriLimit`: `req.originalUrl.length > 8192` -> `414 uri_too_long`.
5. Route match: unknown `/api/*` path -> `404 route_not_found`; known path with another method (including `OPTIONS`) -> `405
   method_not_allowed` + `Allow`. v3 has no mutating UI route; if one is added, ADR 0045's rule applies (JSON body and header
   `X-MCS-Request: 1`, else `403 csrf_rejected`).
6. Query: Express 5 uses the `simple` parser, a repeated key arrives as an array `[exp:X6]` -> `400 param_repeated`; lists are
   comma-separated in one key. Then the route's Zod schema (`z.strictObject`, `z.coerce` for numbers) -> `400 validation_failed` with
   `details[] = { path, issue }`, `issue` = the Zod issue code, never the rejected value `[exp:X6]`.
7. `POST /api/v3/ingest/nudge` only (`[02 2.8]`): `Content-Type: application/json` (`415 unsupported_media_type`), no `Origin` header
   (`403 origin_not_allowed`), body <= 256 bytes (`413 payload_too_large`), body `{ "instanceId": "<uuid>" }` (`400 validation_failed`),
   `instanceId` equal to the server's (`409 instance_mismatch`); answer `204` at once and schedule a drain.
8. Handler -> engine query function (section 12). All DB reads of one handler run in one synchronous step (DA-I8).
9. Error mapper: `DbError` `db_busy` -> `503` + `Retry-After: 1`; `db_full` -> `503 disk_full`; other `DbError` -> `500
   internal_error`; anything else -> `500 internal_error` with a fixed message, recorded in the server error ring (20 entries
   `{ at, where: routeId, message }`; the message never contains request data).

```ts
// packages/shared/src/api/errors.ts
export interface ErrorEnvelope { error: { code: ErrorCode; message: string; requestId: string; details?: { path: string; issue: string }[] } }
```

| HTTP | `code` values |
|---|---|
| 400 | `validation_failed`, `param_repeated`, `body_invalid_json`, `cursor_invalid`, `range_invalid`, `range_too_large`, `filter_requires_scope`, `query_too_short` |
| 403 | `host_not_allowed`, `origin_not_allowed`, `cross_site_request`, `csrf_rejected` (reserved, see step 5) |
| 404 | `route_not_found`, `session_not_found`, `agent_not_found`, `event_not_found`, `work_item_not_found`, `alert_not_found`, `panel_disabled`, `probe_not_found`, `completion_target_not_found` |
| 405 | `method_not_allowed` |
| 409 | `instance_mismatch` |
| 410 | `transcript_gone` (the file was deleted, for example by Claude Code's `cleanupPeriodDays`) |
| 413 | `payload_too_large` |
| 414 | `uri_too_long` |
| 415 | `unsupported_media_type` |
| 429 | `search_busy`, `export_busy` (+ `Retry-After: 2`) |
| 500 | `internal_error` |
| 503 | `db_busy`, `disk_full`, `stream_limit`, `shutting_down` |

`message` is fixed English per code (numbers allowed, never request values). The UI groups codes by HTTP status (`[04 5.1]`).

### 5.3 Pagination and sorting

```ts
export interface Page<T> {
  items: T[];
  nextCursor: string | null;    // null = no more items in this direction
  asOfSeq: number;
  total: number | null;         // only with includeTotal=1; capped at 10000
  totalIsLowerBound: boolean;   // true when the count reached the cap
  limit: number;
}
```
- `limit`: default 50 (sessions, agents, tool calls, alerts), 100 (events, timeline), maximum 200; `afterId` reads up to 500.
- Cursor = base64url of `{"v":1,"r":<routeId>,"s":<sort>,"d":"asc"|"desc","k":<last sort value>,"i":<last id>,"w":[fromMs,toMs]|null,
  "f":<12 hex of sha256(canonical filter JSON)>}`, at most 512 characters. The time window resolved for the first page is frozen in the
  cursor (`w`), so later pages do not move with the clock. A cursor whose `v`, `r`, `s`, `d` or `f` does not match -> `400
  cursor_invalid` (the UI restarts at the first page).
- Total order: the sort key, then `id` in the same direction. Indexed keys use row values (`(last_activity_at, id) < (?, ?)`);
  expression keys use `(expr < :k OR (expr = :k AND id < :i))`. Every sort key is a `NOT NULL` column or an expression over them.
- `includeTotal=1`: `SELECT count(*) FROM (<filtered query> LIMIT 10001)`.
- Events support three modes on the same route: history pages (`cursor`, newest first), `around=<eventId>` (the page whose middle is
  that event, with `nextCursor` towards older and `newerCursor` towards newer events), and the live tail `afterId=<eventId>` (ascending
  by id, at most 500).

| Resource | `sort` values (default first) | `dir` default |
|---|---|---|
| sessions | `lastActivity`, `started`, `duration` (`coalesce(ended_at, last_activity_at) - started_at`), `tokens` (`tok_input + tok_output + tok_cache_read + tok_cache_creation`), `state` (position in `LIFECYCLE_STATES`), `label` (`COLLATE NOCASE`), `errors` (`error_count`) | `desc` (`label`: `asc`) |
| agents (cross-session) | `lastActivity`, `started` | `desc` |
| events, timeline | `at` (`ts`, then `ts_rank`, then `id`: the display order of `[02 4.5]`) | `desc` |
| tool calls | `started` (`coalesce(started_at, ended_at)`), `duration` (`coalesce(duration_ms, -1)`) | `desc` |
| alerts | `lastFired` | `desc` |

### 5.4 The typed filter model (brief 8.5) and URL mapping

One Zod schema per list route, composed from shared field schemas in `packages/shared/src/api/filters.ts`. The UI uses the same parameter
names in its URLs (`[04 3.2]`, with the renames of section 15) and passes them through; `toQuery(filter)` / `fromQuery(params)` are pure
shared functions with a round-trip test; `matchesEventFilter(filter, event)` is the shared predicate the UI's live buffers use and the
server's SQL is tested against. Parameters combine with AND; values inside one list parameter combine with OR.

| Param | Validation | Routes | SQL semantics |
|---|---|---|---|
| `q` | trimmed, 2..200 chars (`query_too_short`); folded `normalize('NFKC').toLowerCase()` | sessions, agents, events/timeline, tool-calls, work-items | sessions: `instr(search_text, :q) > 0`, `search_text` = folded label, session id, project folder name, models, git branch, state rule and evidence words (maintained on write, <= 1024); agents: `label`/`agent_type` `LIKE`; events: `(summary LIKE :p ESCAPE '\' OR tool_name LIKE :p ESCAPE '\')` (ASCII case-insensitive; non-ASCII exact) under rule 2 of 3.7; tool calls: `summary`/`name` `LIKE`, same scope rule. Never transcript text (section 7). |
| `project` | comma list (<= 20) of `projectId` | sessions, agents, events, tool-calls, analytics | `project_id IN (SELECT id FROM projects WHERE project_key IN (...))`; child tables through `session_id IN (SELECT id FROM sessions WHERE ...)` |
| `workItem` | positive int | sessions, events, analytics | `session_id IN (SELECT session_id FROM work_item_sessions WHERE work_item_id = :w)` |
| `session` | comma list (<= 50) of `sessionId` | agents, events, tool-calls, analytics, search | `session_id IN (SELECT id FROM sessions WHERE session_uid IN (...))` |
| `agent` | `agentId`; requires exactly one `session` | events/timeline, tool-calls, search | `agent_id = (SELECT id FROM agents WHERE session_id = :s AND agent_uid = :a)`; unknown -> `404 agent_not_found` |
| `state` | comma list of `LifecycleState` (<= 10) or the alias `active` (= `ACTIVE_STATES`) | sessions, agents | `state IN (...)` |
| `presence` | comma list of `open`, `ended`, `unknown` | sessions | `presence IN (...)` |
| `type` | comma list of `EventKind` (<= 40) | events/timeline | `kind IN (...)` |
| `category` | comma list of `EventCategory` | events/timeline | `kind IN (kinds of those categories)`; with `type`: intersection |
| `severity` | comma list of `info`, `warning`, `error` | events/timeline | `severity IN (0, 1, 2)` |
| `tool` | comma list (<= 20) of `^[A-Za-z0-9_.:-]{1,200}$` | events/timeline, tool-calls, analytics/tools | tool calls: `name IN (...)`; events: `tool_use_id IN (SELECT tool_use_id FROM tool_calls INDEXED BY idx_tool_calls_name WHERE name IN (...) AND started_at >= :from AND started_at < :to)`, requires `session` or a window <= 7 d |
| `status` | comma list of `ToolStatus` | tool-calls | derived status of 5.5 |
| `model` | comma list (<= 10) of `^[^,\s]{1,128}$` | sessions, analytics | sessions: `EXISTS (SELECT 1 FROM json_each(sessions.models) j WHERE j.value IN (...))`; usage: `model IN (...)` |
| `hasErrors` | `1` | sessions, agents | `error_count > 0` |
| `includeInternal` | `1` | agents | without it `kind <> 'internal'` (internal agents are hidden by default `[02 7.5]`) |
| `range` | `1h`, `6h`, `24h`, `7d`, `30d`, `all` | lists with time, analytics, overview | `from = now - preset`, `to = now + 1` ms; `all` = no bound |
| `from`, `to` | ISO; `from < to`; `to` optional (= now); span <= 3650 d | same | explicit bounds; with `range` -> `400 range_invalid` |
| `window` | `1` | sessions, agents, overview | `from = now - window_hours` (config, legacy semantics); pinned sessions (`session_ids`) always included |
| `tokensMin`, `tokensMax` | integers 0..1e15, min <= max | sessions | `(tok_input + tok_output + tok_cache_read + tok_cache_creation) BETWEEN :min AND :max` |
| `includeUnmatched` | `1` | sessions, agents, overview | without it `(matched = 1 OR pinned = 1)` unless config `include_unmatched` is true (legacy parity) |
| `sort`, `dir`, `cursor`, `limit`, `includeTotal` | 5.3 | lists | 5.3 |
| `around`, `afterId` | positive int | events/timeline | 5.3 |

Time semantics: sessions and agents overlap the window (`last_activity_at >= :from AND started_at < :to`); events use `ts`; tool calls
`coalesce(started_at, ended_at)`; usage `ts` (earliest first record of the message). Defaults: sessions/agents/overview `window=1`; events
and tool calls `range=24h` (timeline with a `session`: `all`); analytics `range=7d`; alerts and work items: no time filter.

### 5.5 Shared entity types (`packages/shared/src/api/entities.ts`, Zod schemas; TypeScript types are `z.infer` of them)

```ts
export type IsoTime = string;
export const LIFECYCLE_STATES = ['running','working','waiting_input','waiting_tool','waiting_agent','turn_ended','completed','failed','stale','unknown'] as const;
export type LifecycleState = typeof LIFECYCLE_STATES[number];                       // same ten values as [02 7.1] and [04 13]
export const ACTIVE_STATES = ['running','working','waiting_tool','waiting_agent'] as const satisfies readonly LifecycleState[];
export type LegacyState = 'RUNNING' | 'IDLE' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';  // toLegacy() of [02 7.9]
export const BOARD_STATES = ['working','waiting','completed','failed','stale','unknown'] as const;
export type BoardState = typeof BOARD_STATES[number];
export const EVENT_KINDS = ['session.start','session.end','prompt.submit','prompt.queued','assistant.message','assistant.thinking',
  'tool.call','tool.result','tool.failure','tool.batch','permission.request','permission.denied','notification.sent',
  'agent.start','agent.stop','agent.final','agent.notification','turn.stop','turn.failure','turn.duration','turn.interrupt',
  'api.error','context.compact','model.switch','cwd.change','task.created','task.completed','teammate.idle','system.info',
  'hook.handler_error','hook.unknown','monitor.gap','monitor.reconcile'] as const;
export type EventKind = typeof EVENT_KINDS[number];
export const EVENT_CATEGORIES = ['lifecycle','prompt','tool','agent','notification','compaction','error','ingest'] as const;
export type EventCategory = typeof EVENT_CATEGORIES[number];
export const CATEGORY_OF: Record<EventKind, EventCategory> = {
  'session.start': 'lifecycle', 'session.end': 'lifecycle', 'turn.stop': 'lifecycle', 'turn.duration': 'lifecycle',
  'turn.interrupt': 'lifecycle', 'model.switch': 'lifecycle', 'cwd.change': 'lifecycle', 'task.created': 'lifecycle',
  'task.completed': 'lifecycle', 'teammate.idle': 'lifecycle', 'system.info': 'lifecycle',
  'prompt.submit': 'prompt', 'prompt.queued': 'prompt', 'assistant.message': 'prompt', 'assistant.thinking': 'prompt',
  'tool.call': 'tool', 'tool.result': 'tool', 'tool.failure': 'tool', 'tool.batch': 'tool',
  'permission.request': 'notification', 'permission.denied': 'notification', 'notification.sent': 'notification',
  'agent.start': 'agent', 'agent.stop': 'agent', 'agent.final': 'agent', 'agent.notification': 'agent',
  'context.compact': 'compaction', 'turn.failure': 'error', 'api.error': 'error',
  'hook.handler_error': 'ingest', 'hook.unknown': 'ingest', 'monitor.gap': 'ingest', 'monitor.reconcile': 'ingest',
};
export type ToolStatus = 'pending' | 'succeeded' | 'failed' | 'denied' | 'interrupted' | 'unknown';
// derived from tool_calls: outcome ok -> succeeded, error -> failed, denied -> denied, interrupted -> interrupted;
// outcome NULL and batch_at set -> denied ([02 4.1] 'closed_by_batch'); NULL and its turn ended -> unknown ('closed_by_turn_end'); else pending
export type Completeness = 'complete' | 'partial' | 'unavailable';
export type TranscriptFileState = 'active' | 'missing' | 'unreadable' | 'untracked' | 'retired';

export interface EvidenceItem { kind: string /* '<source>:<fact>' of [02 7.1] */; at: IsoTime | null; text: string /* rendered at response time, never content */ }
export interface StateAssessment {
  state: LifecycleState; presence: 'open' | 'ended' | 'unknown';
  waitReason: 'user' | 'permission' | 'elicitation' | 'agent_input' | 'idle_prompt' | null;
  staleKind: 'silent' | 'abandoned' | 'process_gone' | 'parent_ended' | null;
  endReason: string | null; turnOutcome: 'ok' | 'error' | 'interrupted' | null;
  basis: 'observed' | 'inferred'; confidence: 'high' | 'medium' | 'low'; rule: string /* e.g. 'S-7c' */;
  evidence: EvidenceItem[] /* <= 8 */; since: IsoTime | null; evaluatedAt: IsoTime | null; legacyState: LegacyState;
}
export interface TokenUsage {                     // projection of [02 6.3]
  input: number | null; output: number | null; cacheCreation: number | null; cacheRead: number | null;  // null when every counted message misses the field
  total: number | null;                           // sum of the four non-null fields; null when turns = 0
  missing: { input: number; output: number; cacheCreation: number; cacheRead: number };   // messages without a value
  turns: number;                                  // counted message keys (synthetic included, legacy parity)
  synthetic: number; unfinalized: number;
  completeness: Completeness; scannedPct: number | null; lowerBound: boolean;   // 8.2
}
export interface CostEstimate { amount: number; currency: string; basis: 'estimate'; pricedTokensPct: number; unpricedModels: string[] }

export interface SessionSummary {
  id: string; seq: number; label: string; labelSource: 'rule' | 'custom_title' | 'ai_title' | 'first_prompt' | 'none';
  matched: boolean; pinned: boolean; projectId: string | null; projectLabel: string | null; workItemIds: number[] /* <= 1 today */;
  provider: 'claude-code'; entrypoint: string | null; ccVersion: string | null; models: string[]; lastModel: string | null;
  startedAt: IsoTime; lastActivityAt: IsoTime; endedAt: IsoTime | null; durationMs: number;
  state: StateAssessment;
  agentCount: number; activeAgentCount: number; toolCallCount: number; pendingTools: number; errorCount: number; warningCount: number;
  usage: TokenUsage;                 // main agent (scope 'own')
  usageInclSubagents: TokenUsage;    // scope 'total' (legacy usage_total)
  cost: CostEstimate | null;         // of usageInclSubagents; null without configured prices
  reportedCost: { amountUsd: number; at: IsoTime; trailing: boolean; label: string } | null;   // provider cost-state [02 6.6]
  partial: boolean;                  // usageInclSubagents.completeness !== 'complete'
  sources: { hooks: boolean; transcript: boolean };
  freshness: { lastHookAt: IsoTime | null; lastTranscriptAt: IsoTime | null; transcriptLagBytes: number;
               hookCoverage: 'none' | 'full' | 'partial'; eventsComplete: boolean; usageComplete: boolean };   // [02 8.2]
}
export interface SessionDetail extends SessionSummary {
  cwd: string | null; gitBranch: string | null; permissionMode: string | null; claudePid: number | null;
  continuedIn: string | null; copiedFrom: string | null; hookMissing: { tools: number; turns: number };
  external: { source: 'registry' | 'job' | 'pid' | 'attempt'; observedAt: IsoTime; value: Record<string, string | number | boolean | null> }[];
  workItems: { id: number; title: string; state: BoardState }[];
  files: { agentId: string; kind: 'session' | 'subagent' | 'workflow_agent' | 'workflow_journal' | 'workflow_status'; state: TranscriptFileState;
           sizeBytes: number; importedBytes: number; behindBytes: number; entries: number; usageState: 'complete' | 'partial' | 'skipped_backfill' }[];  // <= 500
  filesTruncated: boolean;
  copiedMessages: number;            // message keys in this session's files owned by another session [02 6.3]
  reconciliations: { kind: string; at: IsoTime; detail: Record<string, string | number | boolean | null> }[];   // <= 20 newest
  auditRefs: { file: 'changes' | 'decisions'; at: IsoTime; title: string; summary: string }[];                    // <= 10 [01 audit]
}
export interface AgentNode {
  id: string; seq: number; sessionId: string; kind: 'main' | 'subagent' | 'workflow_agent' | 'teammate' | 'internal'; depth: number;
  parentAgentId: string | null; parentToolUseId: string | null; agentType: string | null; label: string;
  workflow: { runId: string; name: string | null; phase: string | null; state: LifecycleState } | null; requestShape: 'foreground' | 'background' | null;
  model: string | null; startedAt: IsoTime; lastActivityAt: IsoTime; endedAt: IsoTime | null; state: StateAssessment;
  usage: TokenUsage; toolCallCount: number; errorCount: number;
  transcript: { state: TranscriptFileState; sizeBytes: number; importedBytes: number } | null;
}
export interface ActivityEvent {
  id: number; seq: number; key: string;                       // natural key, 'h:<event uid>' or 't:<record uuid>'
  sessionId: string; sessionLabel: string; agentId: string | null; agentLabel: string | null;
  at: IsoTime; atSource: 'record' | 'hook_received' | 'derived'; receivedAt: IsoTime;
  sources: ('hook' | 'transcript' | 'monitor')[]; source: 'hook' | 'transcript' | 'monitor';   // first of sources in that order
  type: EventKind; category: EventCategory; severity: 'info' | 'warning' | 'error';
  hookEvent: string | null; entryKind: 'prompt' | 'say' | 'think' | 'tool' | 'result' | 'system' | 'attachment' | null;
  toolName: string | null; toolUseId: string | null; toolStatus: ToolStatus | null; durationMs: number | null;
  summary: string;                                             // '' when none
  details: Record<string, string | number | boolean | null>;   // allow-listed keys of events.detail, <= 24
  transcriptRef: { agentId: string; offset: number } | null;   // resolve with /transcript/locate?offset=
}
export interface ToolCallItem {
  id: number; seq: number; toolUseId: string; sessionId: string; agentId: string; promptId: string | null; name: string; mcpServer: string | null;
  status: ToolStatus; outcome: 'ok' | 'error' | 'denied' | 'interrupted' | null; summary: string | null; inputBytes: number | null;
  startedAt: IsoTime | null; endedAt: IsoTime | null; batchAt: IsoTime | null; durationMs: number | null; durationSource: 'hook' | 'timestamps' | null;
  exitCode: number | null; sources: ('hook_pre' | 'hook_post' | 'transcript_use' | 'transcript_result' | 'hook_batch')[];
  subagentId: string | null; workflowRunId: string | null; transcriptRef: { agentId: string; offset: number } | null;
}
export interface TransitionItem {
  id: number; at: IsoTime; agentId: string | null; from: LifecycleState | null; to: LifecycleState; rule: string;
  basis: 'observed' | 'inferred'; confidence: 'high' | 'medium' | 'low'; evidence: EvidenceItem[];
}
export interface WorkItem {
  id: number; key: string; seq: number; title: string;
  source: 'declared' | 'attempts' | 'label';   // = work_items.kind (3.5) with 'attempt' -> 'attempts' (registry C52)
  rule: 'W-DECL' | 'W-ATT' | 'W-LBL';
  state: BoardState; boardReason: string; evidence: EvidenceItem[] /* one per member: '<label>: <state> (<rule>)' */; since: IsoTime;
  sessionIds: string[] /* <= 50 */; sessionCount: number; lastActivityAt: IsoTime | null; usage: TokenUsage | null;
}
export type AlertRuleKind = 'inactivity' | 'ingest_errors' | 'runtime_unavailable' | 'token_threshold' | 'import_lag' | 'db_disk' | 'hook_gap' | 'hook_failing';
export interface AlertItem {
  id: number; seq: number; ruleId: string; rule: AlertRuleKind; severity: 'warning' | 'critical'; status: 'open' | 'resolved';
  title: string; scope: { kind: 'instance' | 'session' | 'code'; key: string }; sessionId: string | null;
  since: IsoTime; lastFiredAt: IsoTime; fireCount: number; resolvedAt: IsoTime | null;
  resolvedReason: 'condition_cleared' | 'expired' | 'rule_disabled' | 'scope_deleted' | null; detail: Record<string, string | number | boolean | null>;
}
```
`label` fallback for agents: the stored `label` (`[02 5.1.2]` precedence), else `agentType`, else the agent id. An empty session label is
shown as `'(no prompt)'` (legacy). `EvidenceItem.text` is rendered by the shared `renderEvidence(item, now)` of `[02 7.1]`.

## 6. Endpoint reference

Route ids (left column) are the keys of the shared route registry (section 13). Common errors (400 `validation_failed`,
`param_repeated`; 403 guards; 414; 500; 503) apply to every route and are not repeated. List routes return `Page<T>`.

### 6.1 Summary

| Route id | Method and path | Query / body | 200 response | Specific errors |
|---|---|---|---|---|
| `legacyHealth` | `GET /api/health` | - | `LegacyHealth` (6.2) | - |
| `health` | `GET /api/v3/health` | - | `HealthReport` | - |
| `healthIngest` | `GET /api/v3/health/ingest` | - | `IngestHealth` `[02 8.2]` + `asOfSeq` | - |
| `instance` | `GET /api/v3/instance` | - | `InstanceInfo` | - |
| `config` | `GET /api/v3/config` | - | `ConfigInspection` `{ entries: { key, value, source }[]; files: ConfigFileStatus[]; effectivePort; engine }`, defined by `[01]` in `packages/shared/src/cli/results.ts` as a pure projection of `inspect` (I-20) | - |
| `errors` | `GET /api/v3/errors` | `since` (ISO), `source` (comma list of `server`, `spool`, `transcript`, `external`, `writer`, `handler`, `alerts`, `db`), `limit` (1..200, default 50) | `{ asOfSeq, items: ErrorItem[] }` newest first | - |
| `overview` | `GET /api/v3/overview` | `range` / `from`,`to` / `window` (default), `includeUnmatched` | `Overview` | `range_invalid` |
| `listSessions` | `GET /api/v3/sessions` | `q state presence project workItem model hasErrors range from to window tokensMin tokensMax includeUnmatched sort dir cursor limit includeTotal` | `Page<SessionSummary>` | `cursor_invalid`, `range_invalid`, `range_too_large` |
| `getSession` | `GET /api/v3/sessions/:sessionId` | - | `SessionDetail & { asOfSeq }` | `session_not_found` |
| `sessionAgents` | `GET /api/v3/sessions/:sessionId/agents` | `state`, `includeInternal`, `cursor`, `limit` (default 200, max 500) | `Page<AgentNode>` (depth, started, id) | `session_not_found` |
| `sessionTimeline` | `GET /api/v3/sessions/:sessionId/timeline` | events params without `session`/`project`, plus `agent` | `EventPage` | `session_not_found`, `agent_not_found` |
| `sessionToolCalls` | `GET /api/v3/sessions/:sessionId/tool-calls` | `agent tool status q range from to sort dir cursor limit` | `Page<ToolCallItem>` | `session_not_found` |
| `sessionTransitions` | `GET /api/v3/sessions/:sessionId/transitions` | `agent`, `cursor`, `limit` | `Page<TransitionItem>` newest first | `session_not_found` |
| `sessionUsage` | `GET /api/v3/sessions/:sessionId/usage` | `groupBy=agent\|model` (default `agent`), `includeCost=1` | `UsageReport` | `session_not_found` |
| `transcriptWindow` | `GET /api/v3/sessions/:sessionId/transcript` | `agent` (default `main`), `after` (int >= -1, default -1), `before` (int >= 0), `limit` (1..2000; default 250 for tail/before, 2000 for after), `textChars` (200..20000, default config `limits.text_chars`), `thinking=1` | `TranscriptWindowResponse` | `session_not_found`, `agent_not_found`, `transcript_gone` |
| `transcriptLocate` | `GET /api/v3/sessions/:sessionId/transcript/locate` | `agent`; exactly one of `i` (int), `ts` (ISO), `offset` (int) | `TranscriptLocateResponse` | as above; `event_not_found` when no entries |
| `searchTranscript` | `GET /api/v3/search/transcript` | `session` (one id, required), `agent`, `q` (0..200; empty allowed with other filters), `kinds`, `tool`, `errors=1`, `limit` (1..1000, default 200), `budgetMs` (100..10000, default 3000) | `TranscriptSearchResponse` | `session_not_found`, `search_busy`, `transcript_gone` |
| `searchTranscripts` | `GET /api/v3/search/transcripts` | `q` (2..200, required), `session`, `project`, `workItem`, `range`/`from`/`to`/`window`, `kinds`, `limit` (1..500, default 100), `budgetMs` (default 3000, max 10000), `continue` (opaque) | `InstanceSearchResponse` | `search_busy`, `cursor_invalid` |
| `listAgents` | `GET /api/v3/agents` | `state kind q session project hasErrors includeInternal range from to window includeUnmatched sort dir cursor limit` | `Page<AgentNode>` | - |
| `listEvents` | `GET /api/v3/events` | `type category severity session agent project workItem tool q range from to dir cursor limit around afterId` | `EventPage` | `filter_requires_scope`, `event_not_found` (bad `around`) |
| `getEvent` | `GET /api/v3/events/:eventId` | - | `ActivityEvent & { asOfSeq }` | `event_not_found` |
| `listToolCalls` | `GET /api/v3/tool-calls` | `session agent project tool status q range from to sort dir cursor limit` | `Page<ToolCallItem>` | `filter_requires_scope` |
| `workItemBoard` | `GET /api/v3/work-items` | `state`, `q` | `WorkItemBoard` (all items, cap 500, `truncated`) | - |
| `getWorkItem` | `GET /api/v3/work-items/:workItemId` | - | `WorkItem & { sessions: SessionSummary[] /* <= 100 */; asOfSeq }` | `work_item_not_found` |
| `analyticsUsage` | `GET /api/v3/analytics/usage` | `groupBy=model\|session\|project\|workItem\|agent\|none` (default `model`), `session project workItem model range from to window`, `limit` (1..500, default 50), `includeCost=1` | `UsageReport` | `range_too_large` |
| `analyticsSeries` | `GET /api/v3/analytics/series` | `bucket=hour\|day` (default `day`), `tzOffsetMinutes` (-840..840, default 0), `groupBy=none\|model`, `session project workItem model range from to` | `UsageSeries` | `range_too_large` (> 2000 buckets) |
| `analyticsTools` | `GET /api/v3/analytics/tools` | `groupBy=tool\|mcpServer` (default `tool`), `session agent project tool range from to`, `limit` (1..200, default 50) | `ToolFrequencyReport` | - |
| `listAlerts` | `GET /api/v3/alerts` | `status` (default `open`), `severity`, `rule`, `session`, `cursor`, `limit` | `Page<AlertItem>` | - |
| `alertRules` | `GET /api/v3/alerts/rules` | - | `{ asOfSeq, enabled, sweepSeconds, rules: AlertRuleView[] }` | - |
| `panel` | `GET /api/v3/panels/:key` | `key` in `git, machine, attempts, ledger, chainLog, logs`; `limit` (1..200, default 30) for `attempts` only | `PanelResponse<K>`, schema `PanelResponseSchema` imported from `packages/shared/src/api/panels.ts` (`[06 3.3]`, I-35) | `panel_disabled` |
| `export` | `GET /api/v3/export` | `ExportQuery` (11.1) | `application/x-ndjson` stream in `mcs.export/1` | `range_invalid`, `export_busy` (an export is already running) |
| `ingestNudge` | `POST /api/v3/ingest/nudge` | `{ "instanceId": "<uuid>" }` (<= 256 bytes, no `Origin`) | `204` | `409 instance_mismatch`, `413`, `415` |
| `ingestProbe` | `GET /api/v3/ingest/probes/:probeSessionId` | path param matching `^00000000-0000-4000-8000-[0-9a-f]{12}$` (the probe prefix rule of `[02 2.2]` step 9 and `[02 3.7]`; anything else `400 validation_failed`) | `HookProbeResult` `{ receivedAt: IsoTime; committedAt: IsoTime }` | `404 probe_not_found` (not committed yet, or never received) |
| `explainCompletion` | `GET /api/v3/completion` | exactly one of `session` (one `sessionId`), `label` (1..200 chars), `attemptPart` (0..512 chars, present-but-empty allowed: legacy attempts without a `part` group; registry C17); none or several -> `400 validation_failed` | `CompletionEvidence & { asOfSeq }` (`[02 7.13]`, schema 6.3) | `400 validation_failed` (also `CompletionTargetError('target_invalid')`), `404 completion_target_not_found` (`target_not_found`) |
| `stream` | `GET /api/v3/stream` | `since` (int >= 0), `epoch` (8 hex); a `Last-Event-ID` header wins over `since` | `text/event-stream` (section 9) | `503 stream_limit` |

`EventPage = Page<ActivityEvent> & { scanCapped: boolean; newerCursor: string | null }` (`newerCursor` only with `around`).
`ErrorItem = { at: IsoTime; source: string; code: string; where: string | null; message: string; sessionId: string | null }` (server ring
entries have `source 'server'` and `code 'INTERNAL'`; ingest rows carry their `code` and `detail` as `message`).

### 6.2 Meta routes

`LegacyHealth` (`GET /api/health`, the only non-v3 route; key set adopted verbatim from `[01]` C-4, I-30):
```ts
// packages/shared/src/api/legacy-health.ts; LegacyHealthSchema = z.strictObject with exactly these 13 keys
export interface LegacyHealth {
  ok: true; version: string /* runtime semver */; pid: number; started: number /* epoch s, float */; uptime: number /* s, 1 decimal */;
  now: number /* epoch s, float */; code_stamp: string; engine: 'node'; instanceId: string;
  task: { id: string; name: string; description: string } | null;   // legacy task_brief(): config.json `task`, description default ''
  config_source: 'task'; errors: [] /* always empty: v3 errors are GET /api/v3/errors */; reader: Record<string, never> /* always {} */;
}
```
Legacy readers of this body (`src/backend/cli.py`, read-only reference): `instance_alive` compares `pid` (lines 69-81); `status` fetches
`/api/health` and `/api/sessions` and then reads `uptime`, `code_stamp`, `task`, `config_source`, `errors`, `reader` (lines 267-270);
the Node server answers `/api/sessions` with `404 route_not_found`, so legacy `status` stops with an HTTP error, never a `KeyError`
(the keys stay complete so the reader works against any server that also serves `/api/sessions`); `verify` reads `errors` (line 372). The legacy key `transcripts_dir` is not reproduced (no legacy reader uses it). Without this route a legacy `start` on the
same task would declare the Node instance dead and launch a second engine (`[research:current-state-backend.md C.10, F.5]`).
`legacyHealth` and `ingestProbe` are the two meta routes without `asOfSeq` (they read no change-tracked entity).

`HealthReport`, `InstanceInfo` and `ErrorItem` live in `packages/shared/src/api/health.ts` (registry C51; `LegacyHealth` in `legacy-health.ts`).

`HealthReport` (target <= 10 ms per request, measured in slice S4; polled by the UI every 5 s `[04 5.2]`; used by `mcs status` `[01 4.10]`):
```ts
export interface HealthReport {
  checkedAt: IsoTime; status: 'ok' | 'degraded' | 'error'; instanceId: string; asOfSeq: number; epoch: string;
  runtime: { version: string; codeStamp: string; outdated: boolean; pid: number; startedAt: IsoTime; uptimeMs: number; eventLoopDelayP99Ms: number;
             rssBytes: number; heapUsedBytes: number; cpuUserMicros: number; cpuSystemMicros: number;          // I-21, [06 8.2]
             sseClients: number; search: { total: number; byStoppedBy: Record<'complete' | 'match_limit' | 'time_budget' | 'cancelled', number> } };
  db: { ok: boolean; sizeBytes: number; walBytes: number; freeDiskBytes: number | null; schemaVersion: number; lastError: string | null };
  ingestion: {
    status: 'ok' | 'degraded' | 'stalled' | 'down' | 'disabled' | 'unknown'; reasons: string[];
    hooks: { enabled: boolean; installed: boolean | null; lastReceivedAt: IsoTime | null; lastEventAt: IsoTime | null;
             spoolPendingBytes: number; spoolLagMs: number | null; errorsLastHour: number; lastError: ErrorItem | null };
    transcripts: { dirFound: boolean; filesTracked: number; lastScanAt: IsoTime | null; lastImportedAt: IsoTime | null;
                   importLagMs: number | null; pendingBytes: number; invalidLines: number; errorsLastHour: number; lastError: ErrorItem | null };
  };
  children: Record<ChildKind, ChildKindStats>;   // [06 3.6] childStats(); ChildKindStats = { spawned; failed; timedOut; totalMs } (I-21)
  panels: PanelStats;                       // [06 3.4] PanelService.stats() (I-21)
  alerts: AlertItem[];               // open, newest first, <= 20
  errors: ErrorItem[];               // server error ring, newest first, <= 20
}
```
Computation: `ingestion` is the projection of the last `IngestHealth` (`ingest_health.report_json`, refreshed every 5 s by `[02 8.2]`)
exactly as `[02 8.2]` defines it ("Projection to the UI's assumed HealthReport.ingestion"); `disabled` is never produced. `db.sizeBytes`
and `walBytes` from `fs.stat`; `freeDiskBytes` from `fs.statfs(dataDir)` (`bavail * bsize`, works on Windows `[exp:X6]`), cached 30 s;
`db.ok` = no `db_corrupt`, `db_io` or `db_full` in the last 5 minutes and the last write committed. `runtime.outdated` per `[01 5.3]`.
`status` = `error` if `db.ok` is false or ingestion is `down`; `degraded` if ingestion is not `ok` or a critical alert is open; else `ok`.
Resources (I-21): `rssBytes`, `heapUsedBytes` from `process.memoryUsage()`; `cpuUserMicros`, `cpuSystemMicros` from `process.cpuUsage()`
(cumulative since process start; benchmarks take differences); `eventLoopDelayP99Ms` from `perf_hooks.monitorEventLoopDelay({ resolution:
20 })`, reset every 60 s. `children` and `panels` are read from `[06]`'s `childStats()` and `PanelService.stats()` at request time (every
`ChildKind` present, zeros when never spawned; both come from `createQueries` deps `childStats` and `panelStats` (12.1), absent in the
`DbReader`, which reports zeros and `{}`). `ChildKind`, `ChildKindStats` and `PanelStats` are declared in `packages/shared/src/api/panels.ts`
(`[06]` owns their definition there; `engine/src/platform/exec.ts` imports `ChildKind` from it, so `@mcs/shared` never imports the engine).
`HealthReport` is the measurement surface of `[06 8.2]` and the `health` member of `[01]`'s diagnostics bundle.

`InstanceInfo` (adopts `[04 13]`, adds `epoch` and `limits`):
```ts
export interface InstanceInfo {
  instanceId: string; slug: string; title: string; description: string | null; runtimeVersion: string; codeStamp: string;
  dbSchemaVersion: number; headSeq: number; epoch: string; staleAfterMs: number; heartbeatMs: number; windowHours: number;
  ui: { theme: 'auto' | 'light' | 'dark'; density: 'comfortable' | 'compact'; newestFirst: boolean; showTools: boolean; showThinking: boolean; showPrompts: boolean };
  panels: Record<'git' | 'machine' | 'attempts' | 'ledger' | 'chainLog' | 'logs', boolean>;
  poll: { healthMs: number; sessionsMs: number; overviewMs: number; transcriptMs: number; machineMs: number; logsMs: number; attemptsMs: number };
  features: { transcriptSearch: 'session' | 'instance'; costEstimates: boolean; usageTrend: boolean; hooks: boolean };
  retention: { summary: string };
  commands: { status: string; restart: string; inspect: string; export: string; backup: string; cleanupDryRun: string };   // [01 6.6]
  limits: { pageMax: 200; eventsQueryWindowDays: 7; searchBudgetMsMax: 10000; textChars: number };
}
```
`poll` (registry C26): `transcriptMs` = config `poll.events_ms` (1500); `overviewMs` = `poll.overview_ms` (5000; the legacy `/api/overview`
cadence, also the interval of the git, ledger and chainLog panels `[04 5.2]`); `sessionsMs` = `poll.sessions_ms`; `machineMs` =
`poll.machine_ms`; `logsMs` = `poll.logs_ms`; `attemptsMs` = `poll.attempts_ms`; `healthMs` = constant 5000 (no legacy key).
`staleAfterMs` = config `poll.stale_after_ms` (15000); `heartbeatMs` = 15000; `features.usageTrend` = `runtime.json` `analytics.usageTrend`
(false until the lead enables it after the Phase 6 token parity test, `[04 4.4.6]`); `features.costEstimates` = `pricing.models`
non-empty; `features.hooks` = `instance.json.hooks.enabled`.

### 6.3 Notes per route (only what the summary table does not say)

- `listSessions`: per page, five indexed queries: the page; `work_item_sessions` for the page ids; active agent counts
  (`kind NOT IN ('main','internal') AND state IN (ACTIVE_STATES)`); the main-agent rows (scope `own` usage); `transcript_files` of the
  page sessions (completeness, `scannedPct`, `transcriptLagBytes`); plus, only with configured prices, `usage` grouped by `(session_id,
  model, day)` for the page.
- `getSession`: 404 when the row does not exist (the detail route ignores windows). `copiedMessages` = `SELECT count(*) FROM usage_files
  uf JOIN usage u ON u.message_key = uf.message_key WHERE uf.file_id IN (<session files>) AND u.session_id <> :id`.
- `sessionTimeline` = `listEvents` with `session` fixed (same function, same schema); default range `all`.
- `transcriptWindow`, `transcriptLocate`, `searchTranscript(s)`: section 7.
- `listEvents` with `around`: the event must match the other filters, else `event_not_found`.
- `errors`: merges the in-memory server ring with `ingest_errors` rows (`idx_ingest_errors_at`); offline (DB reader `[01 6.1]`) only the
  rows exist and `source 'server'` is absent.
- `export`: one export at a time per instance (`429 export_busy`); see 11.1.
- `ingestNudge`: the body carries no event data; the spool is the only input (D8, `[02 2.8]`).
- `ingestProbe` (I-37): `SELECT received_at, committed_at FROM hook_probes WHERE probe_session_id = :id` (primary key, 0.01 ms `[X14]`).
  `[02]` writes the row in the drain transaction that reads the probe envelope (`received_at` = envelope receive time, `committed_at` =
  that transaction's `now`); the probe never becomes a session, event or count. `mcs hooks verify` check V7 polls this route every 100 ms
  for at most 3 s `[02 3.7]`; `404 probe_not_found` means "not committed yet". Rows are bookkeeping (3.8: deleted after 24 h).
- `explainCompletion` (I-08, brief 8.9, registry C16): `EngineQueries.explainCompletion` (12.1) builds a `CompletionLookup` over the
  repositories and calls `[02 7.13]`'s `explainCompletion(lookup, target, deps.now())` (`engine/src/lifecycle/completion.ts`) in the same
  synchronous step as `headSeq`. There is no `null` path: `[02]` throws `CompletionTargetError`, the query rethrows it unchanged (so the
  `DbReader` sees the same error), and the route maps `target_invalid` -> `400 validation_failed` and `target_not_found` -> `404
  completion_target_not_found`. Lookup: `sessionById(id)` and `sessionsByLabel(label)` = `SessionsRepo.completionCandidates(ctx, { sessionId
  } | { label })` (`WHERE session_uid = :id` through its unique index, or `WHERE label = :label`, exact and case-sensitive, a scan of
  `sessions`; each row gives `{ sessionId, label, startedAt, lastActivityAt, view }` with `view` read from the stored view columns and
  `facts_json` of 3.5, the projection `SessionsRepo.writeView` writes); `attemptRowsByPart(part)` = `AttemptsRepo.runsByPart` (3.6). The
  resolution order and the rule "terminal outcome only when `basis === 'observed'`" (D9) are `[02 7.13]`'s. The response schema
  `CompletionEvidenceSchema` lives in `packages/shared/src/api/completion.ts` and `[02]`'s `CompletionEvidence` type is its `z.infer` (one
  definition): `{ outcome: 'completed' | 'failed' | 'not_terminal'; state: LifecycleState; basis: 'observed' | 'inferred'; confidence:
  'high' | 'medium' | 'low'; evidence: EvidenceItem[] /* <= 8 */; sessionId: string | null /* null only for an unmatched attempt row */;
  ruleId: string; resolvedBy: 'session_id' | 'label' | 'attempt_part'; candidates: number /* int >= 1 */ }`. Consumer: `mcs
  verify-completion` through `InstanceReader` (12.2), which maps the two error codes to `USAGE` / `NOT_FOUND` `[01 6.4]`.
- `getSession` `auditRefs` (I-19): `EngineQueries.getSession` stays synchronous and returns `auditRefs: []`, because `[01 7.1]`'s
  `entriesBetween(ws, fromMs, toMs, limit): Promise<AuditRef[]>` reads files asynchronously (01 1.2: no synchronous file API in the
  server). After the snapshot, the route handler and the `DbReader` both `await queries.sessionAuditRefs(detail)` (12.1), which calls
  `deps.audit.entriesBetween(Date.parse(startedAt), Date.parse(endedAt ?? lastActivityAt) + 1, 10)` and attaches the result unchanged
  (`AuditRef` is structurally the `auditRefs` element: ISO `at`, `summary` clipped to 300 code points by `[01 7.1]`); a rejected promise
  gives `[]`, never an error. The audit files are not change-tracked, so `asOfSeq` still describes the snapshot.

### 6.4 Bounded queries, cancellation and stale-request protection

- SQLite statements cannot be interrupted in this build (`OMIT_PROGRESS_CALLBACK` `[exp:X0]`), so the bound is structural: indexes,
  windows, scan caps and `LIMIT` (rules of 3.7). The slowest permitted API query measured on the 400k-event dataset is the 7-day no-match
  event `q` search under the 50k-row cap (before the cap: 362 ms).
- Expensive work that is not one statement (transcript window reads and indexing, search scans, export) runs as async chunks
  (`fs.promises` reads of 1 MiB, at most 7 ms of CPU per chunk `[exp:X4]`) with an `AbortSignal` that fires when the client disconnects
  (`req.once('close', ...)` while `!res.writableEnded`); loops check it before every chunk.
- Concurrency: at most 2 transcript searches (`429 search_busy`) and 1 export (`429 export_busy`) per instance, both with
  `Retry-After: 2`; every search has a time budget (`budgetMs`) and a match limit.
- Client side: TanStack Query passes its `AbortSignal` and aborts on key change `[04 5.3]`; search responses echo the normalised `query`
  so a client can drop a response that does not match its current query.
- Response size: bounded by `limit` maxima and the 8 MiB read budget of the transcript window (7.3).

## 7. Search and transcript access (ADRs 0022, 0023)

Two different searches, never mixed and labelled differently in API and UI (brief 8.5):
- **Structured metadata search**: the `q` filter of list routes (5.4). It matches stored metadata only (labels, ids, project, models,
  tool names, summaries, evidence words) and says so in the UI copy. Bounded by indexes and scan caps (3.7).
- **Transcript content search**: reads the transcript files themselves (prompt, reply, thinking, tool input and result text) and reports
  coverage. Per session (`searchTranscript`, legacy-compatible) or per instance (`searchTranscripts`).

### 7.1 Display entries (legacy `events_of` projection)

The projection of one transcript record into legacy display entries (kinds `prompt | say | think | tool | result`, legacy clips:
`text_chars` 6000, tool input 4000, think 1500, summary 160, code points) is implemented once, in
`packages/engine/src/transcript/entries.ts` (owned by this document, slice S7); `readEntryText` of `[02 5.7]` calls it for single
records, and the counting function used by the entry index lives beside it:
```ts
export type EntryKind = 'prompt' | 'say' | 'think' | 'tool' | 'result';
export interface TranscriptEntry { i: number; t: string /* record timestamp or '' */; k: EntryKind; id?: string; text?: string;
  name?: string; summary?: string; input?: string; err?: boolean }
export function displayEntries(record: unknown, opts: { textChars: number }): Omit<TranscriptEntry, 'i'>[];   // [02 5.7] projection
export function countEntries(record: unknown): number;   // === displayEntries(record).length, without building text
```
Only `user` and `assistant` records produce entries; invalid and oversized lines produce none (the one `MAX_LINE_BYTES` of `shared/src/protocol/limits.ts`, as `[02 5.3]`).
Golden tests compare against the Python engine (`[research:current-state-backend.md C.2]`).

### 7.2 Entry index (`transcript_checkpoints`), owned by the transcript service

Legacy entry indexes `i` must be absolute and stable. The importer cannot provide them, because it reads head, then tail, then backfill
`[02 5.5]`, so its cursors are not a prefix of the file. The transcript service therefore keeps its own sequential index, lazily:
```ts
// packages/engine/src/transcript/index-service.ts
export interface EntryIndexService {
  /** Extends the index of a file from index_offset to the last complete line (up to `untilBytes`), within `budgetMs`. */
  ensureIndexed(ctx: RepoContext, fileId: number, opts: { untilBytes?: number; budgetMs: number; signal: AbortSignal }):
    Promise<{ entriesTotal: number; indexOffset: number; sizeBytes: number; complete: boolean; reset: boolean }>;
}
```
Algorithm:
1. Identity: read the first `min(256, size)` bytes; if `index_head_hash` is set and differs, or `size < index_offset`, reset: delete the
   file's checkpoints, `index_offset = 0`, `entries_total = 0`, `reset = true`. Store the head hash on the first run.
2. Read forward from `index_offset` in 1 MiB async chunks to the last LF before `size` (an unterminated tail is not indexed), parse each
   line, `n = countEntries(record)`; keep `{ entriesTotal, sinceCheckpoint, blockMinTs, blockMaxTs }`. At a line start, when
   `sinceCheckpoint >= 256`, insert checkpoint `(file_id, entriesTotal, lineStart, min_ts, max_ts)` and reset the block. The first line
   of a file gets checkpoint `(file_id, 0, 0, ...)`.
3. Persist in transactions of at most 8 ms of work (`withWriteTx`; checkpoints, `index_offset`, `entries_total`, `index_head_hash`),
   yielding between chunks; stop at `budgetMs` (`complete = false`).
4. The read-only CLI reader cannot write: it computes the same index in memory for the call.
Cost: one JSON parse pass per file once (JSON.parse 373-567 MB/s measured by `[02 E3/E4]`; a 70 MB file is about 0.15-0.3 s), then only
appended bytes. A file of 43k lines needs about 200 checkpoint rows.

### 7.3 Transcript window and locate (legacy `/api/events` and `/api/locate` semantics, full history)

```ts
export interface TranscriptWindowResponse {
  sessionId: string; agentId: string; total: number; base: number; from: number; next: number; partial: boolean;
  skippedBytes: number; pendingBytes: number; fileState: TranscriptFileState; asOfSeq: number; events: TranscriptEntry[];
}
export interface TranscriptLocateResponse { i: number; t: string; base: number; total: number }
```
Window algorithm (`TranscriptWindowService.read`):
1. Resolve the file: `kind = 'session'` for `agent=main`, else the file with that `agent_uid` in the session; none -> `404
   agent_not_found`; state `missing` -> `410 transcript_gone`. The path is re-checked with `realpath` containment in the transcripts root.
2. `ensureIndexed(file, { budgetMs: 2000 })`; a `reset` returns `total = 0, events = []` (the client sees `total < next` and resets, legacy).
3. `total = entries_total`; `pendingBytes = size - index_offset` (bytes not indexed yet). Range: `after = -1` -> `[max(0, total - limit),
   total)`; `after = N` -> `[min(N, total), min(total, N + limit))`; `before = N` -> `[max(0, min(N, total) - limit), min(N, total))`.
4. Seek `SELECT entry_index, byte_offset FROM transcript_checkpoints WHERE file_id = ? AND entry_index <= :start ORDER BY entry_index
   DESC LIMIT 1`; read forward in 1 MiB async chunks up to `index_offset`, number entries from the checkpoint, collect `[start, end)`.
   Read budget 8 MiB after the checkpoint; when exhausted return what was collected (`next` = index after the last returned entry).
   `think` entries are returned only with `thinking=1`.
5. `base = 0` (the whole indexed file is addressable), `from = start`, `next = end`, `partial = pendingBytes > 0`, `skippedBytes = 0`.
6. Text never leaves the request; nothing is cached server-side.

Locate: `i` clamps into `[0, total - 1]`; `ts` = the first entry in file order whose `t >= ts` (ISO string compare, legacy), skipping
blocks by checkpoint `max_ts`, else the last entry; `offset` = the first entry produced at or after the line starting at that byte
offset (checkpoints are monotonic in both columns). No entries -> `404 event_not_found`.

### 7.4 Transcript content search (bounded scan)

Matching (legacy `/api/search`, over the whole indexed file): an entry matches when the case-insensitive substring `q` occurs in
`text + ' ' + summary + ' ' + input + ' ' + name`; `kinds` restricts entry kinds (default all five); `tool=<name>` keeps tool entries of
that name and their results; `errors=1` keeps result entries with `err` and their tool entries. Snippet: 160 characters of
`text || summary || input`, starting 40 characters before the match.

Algorithm (`packages/engine/src/search/scan.ts`), per file in scope, block by block (block = bytes between consecutive checkpoints):
1. `ensureIndexed` first (counts against the budget).
2. Prefilter regex `P` (flag `i`): alternation of `escapeRe(JSON.stringify(q).slice(1, -1))` (the needle as it appears inside a JSON
   string written with raw UTF-8) and the same with non-ASCII characters as `\uXXXX` (writers that escape, for example the Python
   fixtures). `errors=1` without `q`: `"is_error"\s*:\s*true`; `tool` without `q`: the JSON-escaped tool name.
3. Read the block (async, at most 1 MiB per read), decode UTF-8, test `P` once. No hit -> skip; the entry count comes from the
   checkpoints, so indexes stay exact.
4. Hit -> split lines, parse, `displayEntries`, number from the block's checkpoint, verify each entry with `toLowerCase().includes()`
   on the joined fields and the filters, build snippets. Stop at `limit` matches (`truncated = true`).
5. Before each block: `signal.aborted` -> `stoppedBy 'cancelled'`; elapsed > `budgetMs` -> `stoppedBy 'time_budget'`.

Measured on 120 MB of synthetic JSONL, warm cache `[exp:X4]`: no-match prefilter 950-1065 MB/s with 1 MiB chunks, at most 4.5-7 ms per
chunk; a needle in 70% of lines 521 MB/s (parse cost); a non-ASCII needle (U+0110/U+0111) matched case-insensitively at 1039 MB/s; raw
byte `indexOf` (case-sensitive) 3170 MB/s. Cold-cache throughput is UNVERIFIED (open item O-1). At about 1 GB/s this machine's whole
corpus (777 MB) scans in about 1 s; the default 3 s budget covers typical instances completely once indexed.
Case folding limit (documented in the UI help): simple case folding only; multi-character foldings (U+00DF sharp s versus `SS`) and U+0130 do not match `[exp:X6]`.

```ts
export interface SearchCoverage {
  scope: 'session' | 'agent' | 'instance'; filesInScope: number; filesScanned: number; filesMissing: number; filesUnreadable: number;
  bytesInScope: number; bytesScanned: number; bytesNotIndexed: number; entriesScanned: number;
  complete: boolean;      // every in-scope file scanned to its end, bytesNotIndexed = 0, no missing or unreadable file
  stoppedBy: 'complete' | 'match_limit' | 'time_budget' | 'cancelled';
  elapsedMs: number;
  note: string;           // e.g. "Searched 42 of 42 transcript files (180.2 MB) of 17 sessions. 2 files were deleted by Claude Code and could not be searched."
}
export interface TranscriptSearchResponse {          // per session; legacy fields first
  matches: { i: number; k: EntryKind; t: string; name: string | null; snippet: string; offset: number }[];
  count: number; truncated: boolean; partial: boolean /* = !complete */; complete: boolean; searchedEntries: number;
  query: { q: string; kinds: EntryKind[]; tool: string | null; errors: boolean }; coverage: SearchCoverage;
}
export interface InstanceSearchResponse {
  query: { q: string; kinds: EntryKind[] };
  matches: { sessionId: string; sessionLabel: string; agentId: string; i: number; k: EntryKind; t: string; name: string | null; snippet: string }[];
  truncated: boolean; coverage: SearchCoverage; continuation: string | null;
}
```
Instance scope: files of the sessions matching the filters (default: the session window), ordered by session `last_activity_at` desc, the
main file before agent files. `continuation` is a server-side handle (`c-<random>`) to an in-memory record `{ fileIds, position,
queryHash, expiresAt: now + 5 min }`, at most 20 records (LRU); an unknown or expired handle -> `400 cursor_invalid`. Files resolve from
`transcript_files.path` with `realpath` containment in the transcripts root (symlinks out of the root count as `filesUnreadable`, DA-I10).

### 7.5 FTS5: not used in v3.0 (ADR 0023)

Measured on 29 MB of synthetic text in 40,000 rows `[exp:X4]`: FTS5 `unicode61` index 44.6 MB (1.54x the text), build 24 MB/s, queries
0.02-1.2 ms; FTS5 `trigram` (needed for the legacy substring semantics) 124 MB (4.28x), build 5.3 MB/s, queries <= 0.1 ms. For an
instance with 400 MB of transcript text a trigram index would copy about 1.7 GB of private text into the task folder and cost about 75 s
of indexing, while the scan covers it in under a second on a warm cache. Decision: no FTS5; scan with honest coverage. Revisit when more
than 10% of searches end with `stoppedBy: 'time_budget'` (in-memory counters since start, reported as
`HealthReport.runtime.search`) or when search over transcripts already deleted by Claude Code is
wanted (that requires stored content: a new `meta.privacy_profile`, a migration and an ADR).

## 8. Analytics (brief 8.1, 8.7)

### 8.1 Metric catalogue (`GET /overview`)

```ts
export interface Metric { key: string; label: string; value: number | null; unit: 'count' | 'tokens' | 'ms' | 'bytes' | 'currency';
  currency?: string; source: string; rule: string; completeness: Completeness; asOf: IsoTime; link: string | null }
export interface Overview { asOfSeq: number; generatedAt: IsoTime; window: { from: IsoTime | null; to: IsoTime; source: 'window_hours' | 'range' | 'custom' };
  metrics: Metric[]; recentActivity: ActivityEvent[] /* <= 15 */; recentErrors: ActivityEvent[] /* <= 10 */;
  alerts: { open: number; critical: number; items: AlertItem[] /* <= 5 */ } }
```
"In window" for sessions = overlaps the window (5.4) or pinned; for usage = message `ts` in the window. `source` and `rule` are fixed English
texts from this table (the UI shows them in an info tip `[04 4.4.1]`). Ingestion health and last event/transcript times are in
`HealthReport` (6.2), which the overview page also shows.

| key | label | unit | source | rule | completeness | link |
|---|---|---|---|---|---|---|
| `sessions.active` | Active sessions | count | `sessions.state` | sessions in window with state running, working, waiting_tool or waiting_agent | complete | `/sessions?state=active` |
| `sessions.waiting_input` | Waiting for input | count | `sessions.state` | state = waiting_input | complete | `/sessions?state=waiting_input` |
| `sessions.turn_ended` | Turn ended | count | `sessions.state` | state = turn_ended | complete | `/sessions?state=turn_ended` |
| `sessions.completed` | Completed | count | `sessions.state` | state = completed (only from SessionEnd, daemon job or attempts evidence, D9) | complete | `/sessions?state=completed` |
| `sessions.failed` | Failed | count | `sessions.state` | state = failed | complete | `/sessions?state=failed` |
| `sessions.stale` | Stale | count | `sessions.state` | state = stale | complete | `/sessions?state=stale` |
| `sessions.unknown` | Unknown | count | `sessions.state` | state = unknown | complete | `/sessions?state=unknown` |
| `agents.running` | Running agents | count | `agents.state` | subagents and workflow agents (not main, not internal) of sessions in window in an active state | complete | `/sessions?state=active` |
| `events.errors` | Errors | count | `events.severity` | events with severity error and ts in window | complete | `/activity?severity=error` |
| `tokens.input` | Input tokens (uncached) | tokens | `usage.input_tokens` | sum over message keys with ts in window | 8.2 | `/analytics` |
| `tokens.input_new` | New input tokens | tokens | `usage.input_tokens + cache_creation_tokens` | sum; tokens sent to the model that were not read from cache | 8.2 | `/analytics` |
| `tokens.output` | Output tokens | tokens | `usage.output_tokens` | sum; lower bound when some messages never got a final record | 8.2 | `/analytics` |
| `tokens.cache_creation` | Cache writes | tokens | `usage.cache_creation_tokens` | sum | 8.2 | `/analytics` |
| `tokens.cache_read` | Cache reads | tokens | `usage.cache_read_tokens` | sum (shown separately, never merged into input) | 8.2 | `/analytics` |
| `cost.estimate` | Estimated cost | currency | configured prices x usage | 8.3; only when prices are configured | `partial` when any model is unpriced | `/analytics` |
| `cost.reported` | Cost reported by Claude Code | currency (USD) | latest `cost_states` value per session | sum over sessions in window that have one; cumulative per process, may include calls not in transcripts `[02 6.6]` | `partial` when some sessions have none | `/analytics` |
| `alerts.open` | Open alerts | count | `alerts.status` | status open | complete | `/settings?section=health` |

`recentActivity`: the 15 newest events in window (`idx_events_ts`); `recentErrors`: the 10 newest with severity >= warning
(`idx_events_problems`).

### 8.2 Usage aggregation (rules of `[02 6.2-6.3]`, storage of 3.6)

- Source: transcript assistant records only; hooks contribute zero tokens (D8, `[02 6.1]`). One `usage` row per message key: per-field
  maximum over its files, NULL = missing, owner = oldest file `[02 6.2]`. Summing per file would overcount 2.4-4.0% on this machine's
  corpus `[research:transcript-survey.md 3.5]`.
- Compaction and cumulative usage: usage is per API call and never cumulative; compaction appends records and never rewrites earlier
  ones, so no baselines are needed `[02 6.2 rule 13]`.
- Aggregate of a scope (owner scope: a session's total = its own and its agents' messages; `own` = main agent; agent = its messages):
  for each of the four fields `sum` over rows with a value and `missing` = rows without; `turns` = rows; `synthetic`; `unfinalized` =
  non-synthetic rows with `finalized = 0`. Per-model aggregates exclude synthetic rows `[02 6.2 rule 10]`. For list pages the session
  and agent rollup columns are used (equal to the sums, DA-I6); windowed aggregates query `usage` through `idx_usage_ts_cover`.
- `TokenUsage` projection `[02 6.3]`: a field is `null` when every counted row misses it (all `null` when `turns = 0`); `total` = sum of
  the four non-null fields; `completeness` = `complete` when every contributing file has `usage_state = 'complete'`, `unavailable` when
  every contributing file is `skipped_backfill`, else `partial`; `scannedPct` = the minimum over contributing files of
  `floor(100 * consumed / max(1, size_seen - partial_bytes))` with `consumed = head_end + (backfill_offset - head_end) + (tail_offset -
  tail_start)` `[02 5.5]`; `lowerBound = unfinalized > 0 || completeness !== 'complete'`.
- Contributing files: the transcript files of the sessions/agents in scope; for time-window aggregates without a session filter, the
  files of the sessions overlapping the window.
- Buckets (`analyticsSeries`): `bucketStart = floor((ts + off) / size) * size - off`, `size` 3,600,000 or 86,400,000 ms, `off =
  tzOffsetMinutes * 60000` (a fixed offset: DST changes inside the range shift day boundaries by one hour, documented). Empty buckets are
  omitted (gaps, never zero bars). A bucket is `partial` when it contains an unfinalized message. The sum of buckets equals the totals of
  the same filter (tested). More than 2000 buckets -> `400 range_too_large`. Trend charts stay behind `features.usageTrend` `[04 4.4.6]`.

```ts
export interface UsageRow { key: string; label: string; usage: TokenUsage; cost: CostEstimate | null; sessions: number }
export interface UsageReport { asOfSeq: number; window: { from: IsoTime | null; to: IsoTime }; groupBy: string; totals: UsageRow;
  rows: UsageRow[]; rowsTruncated: boolean; source: string; cost: CostSummary | null;
  reportedCost: { amountUsd: number; sessionsWithReport: number; sessionsInScope: number; label: string } | null }
export interface SeriesPoint { start: IsoTime; input: number; output: number; cacheCreation: number; cacheRead: number; messages: number; completeness: 'complete' | 'partial' }
export interface UsageSeries { asOfSeq: number; bucket: 'hour' | 'day'; tzOffsetMinutes: number; window: { from: IsoTime | null; to: IsoTime };
  points: SeriesPoint[]; series: { key: string; label: string; points: SeriesPoint[] }[] | null }
```
`source` text: "Token usage from transcript assistant records: one value per provider message (per-field maximum over all files), owned by the
oldest file's session; subagents included; hooks add no tokens."

### 8.3 Cost estimate (configured prices only, D15)

`runtime.json` section `pricing` (owned by this document; composed by `[01 1.6]`):
```json
{ "pricing": { "currency": "USD", "models": [
  { "match": "<model id or glob with *>", "effectiveFrom": "2026-01-01",
    "inputPerMTok": 0, "outputPerMTok": 0, "cacheReadPerMTok": 0, "cacheWrite5mPerMTok": 0, "cacheWrite1hPerMTok": 0 } ] } }
```
No prices ship (D15); without `pricing.models` every `cost` is `null` and `features.costEstimates = false`.
1. Model match: exact id first, else globs (`*` only) by the longest literal length, ties -> the first in file order; among matching
   entries the latest `effectiveFrom <= message day (UTC)`; none -> unpriced. Synthetic rows are never priced.
2. A message is priced only if every token category it has (> 0) has a price; else its model counts as unpriced for that message.
3. Cost = `(input * inputPerMTok + output * outputPerMTok + cacheRead * cacheReadPerMTok + c5m * cacheWrite5mPerMTok + c1h *
   cacheWrite1hPerMTok) / 1e6`; when the 5m/1h split is missing the whole `cache_creation` is priced at `cacheWrite5mPerMTok` and the
   summary sets `assumedCacheWriteTier: true`.
4. SQL groups by `(model, day)` (reads the split columns from the table, so it is not covered by `idx_usage_ts_cover`); TypeScript
   applies the prices. Cost queries run on the analytics page and for listed session pages only.
```ts
export interface CostSummary { currency: string; basis: 'estimate'; source: 'configured_prices'; amount: number; pricedTokensPct: number;
  pricedModels: string[]; unpricedModels: string[]; assumedCacheWriteTier: boolean; note: string }
```
`note`: "Estimate from prices configured in runtime.json; not a bill." The provider-reported cost (`cost_states`, `[02 6.6]`) is shown
separately as `reportedCost` and never added to the estimate.

### 8.4 Tool frequency (`analyticsTools`)

Source `tool_calls` with `coalesce(started_at, ended_at)` in the window (`idx_tool_calls_name`). Per tool name (or MCP server): `calls`,
counts per derived `ToolStatus`, `failurePct = round(100 * failed / (calls - pending), 1)` or `null` without finished calls,
`maxDurationMs`, and `medianDurationMs` computed in TypeScript from the finished calls' durations (`SELECT name, duration_ms ... ORDER BY
name, duration_ms`, at most 100,000 rows; above that `sampled: true`). Pending calls are never failures. No `median()` SQL dependency.
```ts
export interface ToolFrequencyRow { toolName: string; mcpServer: string | null; calls: number; succeeded: number; failed: number;
  denied: number; interrupted: number; pending: number; unknown: number; failurePct: number | null; medianDurationMs: number | null; maxDurationMs: number | null }
export interface ToolFrequencyReport { asOfSeq: number; window: { from: IsoTime | null; to: IsoTime }; items: ToolFrequencyRow[]; sampled: boolean }
```

## 9. Realtime: change log and SSE (ADR 0025)

### 9.1 Change log (`changes`), the `ChangeRecorder` and the `[02]` `ChangeSink`

`changes` rows are small references written in the same transaction as the data they describe (DA-I7); the stream turns them into full
frames when it sends them (9.3). `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`: never reused, persistent, and a rolled-back transaction
leaves no gap (verified: a rolled-back reservation left the head unchanged and the next seq was contiguous `[exp:X8]`).

```ts
// packages/engine/src/db/changes.ts
export type ChangeKind = 'session' | 'agent' | 'workflow' | 'tool_call' | 'event' | 'transcript' | 'work_item' | 'usage' | 'alert' | 'health' | 'attempt';
export type ChangeOp = 'upsert' | 'delete' | 'append' | 'invalidate';
export interface ChangeRecorder {
  /** Reserves at most one change row per (kind, op, coalescing key) per transaction and returns its seq; the caller stamps
   *  updated_seq / change_seq with it in the statement that modifies the entity. */
  reserve(kind: ChangeKind, op: ChangeOp, ref: { entityId: number | null; sessionUid: string | null }): number;
  noteId(seq: number, id: number): void;                                                        // event and tool-call ids under one reservation
  noteTranscript(seq: number, p: { sizeBytes: number; tailOffset: number; agentUid: string | null }): void;
  flush(): void;                                                                                // final payloads, called by withWriteTx before COMMIT
}
/** [02 4.6] ChangeSink on top of the recorder: record() maps to reserve() (table below); flush() and discard() are no-ops because
 *  withWriteTx publishes after COMMIT and a ROLLBACK removes the reserved rows. */
export function createChangeSink(tx: WriteTx): ChangeSink;
```

| Change (kind/op) | Written when | Coalescing key | `entity_id` / `session_uid` | `payload` (<= 2048 bytes) |
|---|---|---|---|---|
| `session/upsert` | a view change (immediately); other visible session columns (throttled, 3.6) | session | `sessions.id` / uid | `{}` |
| `session/delete` | data retention (one per deleted session) | session | NULL / uid | `{}` |
| `agent/upsert` | agent view change or visible columns (usage rollups throttled like sessions) | agent | `agents.id` / uid | `{}` |
| `workflow/upsert` | workflow run view change or counters | run | `workflow_runs.id` / uid | `{}` |
| `tool_call/upsert` | tool call upsert that changed a visible column | session | NULL / uid | `{"ids":[<= 50 tool call ids],"truncated":bool}` |
| `event/append` | new `events` rows | session | `sessions.id` / uid | `{"from":<min id>,"to":<max id>,"count":<distinct ids>}` |
| `transcript/append` | `TranscriptFilesRepo.updateCursors` when `size_seen` grew | file | `transcript_files.id` / uid | `{"size":n,"tail":n,"agent":<uid or null>}` |
| `work_item/upsert` | board derivation changed an item | item | `work_items.id` / NULL | `{}` |
| `usage/invalidate` | usage rollups changed | session | `sessions.id` / uid | `{}` |
| `alert/upsert` | alert inserted, resolved, or severity changed | alert | `alerts.id` / uid when session-scoped | `{}` |
| `health/upsert` | `IngestHealth.status` or `HealthReport.status` changed (checked every 5 s, at most 1 per second `[02 8.2]`) | instance | NULL / NULL | `{"status":"degraded","previous":"ok"}` |
| `attempt/upsert` | an attempts tick, a config reset or a retention detach changed `attempt_runs` rows (3.6) | instance | NULL / NULL | `{"ids":[<= 50 attempt run ids],"truncated":bool}` (`truncated` true for a reset, a detach or more than 50 ids) |

Attempts have their own kind (decision for I-07) instead of riding on `session/upsert`: an unmatched run has no session, and DA-I7
requires every observable change in the log. The lifecycle effect of an attempt (the `attempt` fact of a session) still arrives as
`session/upsert`, written by `[02]`'s writer in its own transaction after the attempts transaction commits (3.6, N-01). `AttemptsRepo` reserves the change directly through
`tx.changes.reserve('attempt', 'upsert', { entityId: null, sessionUid: null })` and `noteId`; it does not go through `ChangeSink`.

`ChangeSink.record(entity, key, op)` mapping: `session` and `turn` -> `session/upsert` (throttled unless the view changed); `agent` ->
`agent/upsert`; `workflow_run` -> `workflow/upsert`; `tool_call` -> `tool_call/upsert` (with the id); `event` (the single entity name
`[02 4.6]` passes for hook and transcript rows, I-03) -> `event/append` (with the id); `usage` -> `usage/invalidate`; `ingest_health` -> `health/upsert`; `reconciliation` -> `event/append` of
the monitor row inserted by `ReconciliationsRepo` (3.6), or `health/upsert` for instance-level rows. A transaction touching one session
1,000 times and appending 1,000 events writes exactly two change rows (DA-T-RT-7).

Snapshot position: `headSeq = coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'changes'), 0)` (valid after pruning). Every
snapshot handler reads it in the same synchronous step as its data; this is exact because all DB work runs on one connection in one thread.

### 9.2 SSE protocol (`GET /api/v3/stream`)

Request: optional `since` (int >= 0) and `epoch` (8 hex); a `Last-Event-ID` header (int) takes precedence over `since` (`[04 E2]`: native
reconnect sends the header with the original URL). Response `200` with `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control:
no-store`, `Connection: keep-alive`, `X-Accel-Buffering: no` and the common headers; `res.flushHeaders()`, `socket.setNoDelay(true)`,
`socket.setTimeout(0)`. Host and Origin guards apply as for every route.

Epoch: `InstanceDb.epoch` is a random 8-hex value created when the server opens the DB, so one epoch = one server process lifetime. A
restarted server (including after a restore or a rebuild `[01 5.5]`) has a new epoch and clients resynchronize; within one process,
replay by seq works.

Frames, in order:
1. `retry: 3000`
2. `event: hello` (no `id`), data `StreamHello`.
3. Cursor decision (c = header or `since`; `head`; `oldest` = `min(seq)` of `changes`, or `head + 1` when empty): no cursor -> live
   from `head`; `epoch` given and different -> `reset(epoch_changed)`; c not an integer -> `reset(cursor_invalid)`; c > head ->
   `reset(cursor_ahead)`; c < oldest - 1 or head - c > 2000 -> `reset(cursor_too_old)`; else replay `c+1 .. head`, then live. A reset frame
   is `id: <head>` + `event: reset` + data `StreamReset` (the browser's last event id becomes `head`).
4. `event: change`, `id: <seq>`, data `StreamChange`, for every seq in order without gaps.
5. `event: heartbeat` (no `id`) every 15,000 ms, data `StreamHeartbeat`. No comment lines: `EventSource` hides them from scripts, so they
   cannot drive a watchdog (`[04 E2]`; CHALLENGE C-2).

```ts
// packages/shared/src/api/stream.ts
export interface StreamHello { instanceId: string; epoch: string; headSeq: number; heartbeatMs: number; serverTime: IsoTime; runtimeVersion: string; codeStamp: string }
export interface StreamHeartbeat { headSeq: number; epoch: string; serverTime: IsoTime }
export interface StreamReset { headSeq: number; reason: 'cursor_too_old' | 'cursor_ahead' | 'epoch_changed' | 'cursor_invalid' }
export interface WorkflowRunItem { runId: string; seq: number; sessionId: string; name: string | null; state: StateAssessment;
  agentCount: number | null; started: number; results: number; failed: number; startedAt: IsoTime | null; endedAt: IsoTime | null }
interface ChangeBase<K extends ChangeKind, O extends ChangeOp, D> { seq: number; at: IsoTime; instanceId: string; kind: K; op: O; sessionId: string | null; data: D }
export type StreamChange =
  | ChangeBase<'session', 'upsert', SessionSummary | null>
  | ChangeBase<'session', 'delete', null>
  | ChangeBase<'agent', 'upsert', AgentNode | null>
  | ChangeBase<'workflow', 'upsert', WorkflowRunItem | null>
  | ChangeBase<'tool_call', 'upsert', { items: ToolCallItem[]; truncated: boolean }>
  | ChangeBase<'event', 'append', { items: ActivityEvent[]; count: number; truncated: boolean }>
  | ChangeBase<'transcript', 'append', { agentId: string; sizeBytes: number } | null>
  | ChangeBase<'work_item', 'upsert', WorkItem | null>
  | ChangeBase<'usage', 'invalidate', { sessionId: string }>
  | ChangeBase<'alert', 'upsert', AlertItem | null>
  | ChangeBase<'health', 'upsert', HealthReport>
  | ChangeBase<'attempt', 'upsert', { ids: number[]; truncated: boolean }>;
```
`data: null` means the referenced entity no longer exists (or is not readable now): clients invalidate that entity. The seq sequence
stays gap-free even when an entity was deleted after its change was written.

Limits and fan-out (`packages/server/src/stream/hub.ts`), verified by the prototype `[exp:X5]`:
- At most 16 concurrent streams per instance; the 17th gets `503 stream_limit` (JSON envelope).
- Pull-based fan-out: each client has `lastSent`; `pump(client)` writes frames `> lastSent` in batches of 100 until `res.write()` returns
  `false`, then waits for `drain`. The change log is the buffer, so per-client memory stays at about one socket buffer (16.7 KB when the
  slow client was evicted). A client undrained for 30 s is destroyed; it reconnects and is replayed or reset.
- `onCommitted(head)` (4.5) triggers `pump` for every client. Frames are built once per seq (LRU of 512) and shared by all clients; a frame
  is at most 64 KB (`event/append` carries at most 50 events, `tool_call/upsert` at most 50 calls).
- `req.on('close')` removes the client and clears its heartbeat and stall timers.

### 9.3 Frame hydration

`buildFrame(changeRow)` reads the current state of the referenced entity with the same query functions as the REST routes (one source for
shapes):

| kind/op | `data` |
|---|---|
| `session/upsert` | `sessionSummaries([id])[0]` or `null` |
| `agent/upsert`, `workflow/upsert`, `work_item/upsert`, `alert/upsert` | the entity as in its REST route, or `null` |
| `tool_call/upsert` | `ToolCallItem[]` for the payload ids that still exist |
| `event/append` | `SELECT ... FROM events WHERE id BETWEEN :from AND :to AND +session_id = :sid ORDER BY id LIMIT 50` (rowid range, 0.018 ms `[exp:X8]`), as `ActivityEvent`; `truncated = count > 50` |
| `transcript/append` | `{ agentId, sizeBytes }` from the payload |
| `usage/invalidate` | `{ sessionId }` |
| `health/upsert` | `HealthReport` computed at send time (cached 1 s) |
| `attempt/upsert` | `{ ids, truncated }` from the payload (no DB read; the rows are served by `GET /panels/attempts`) |

Because hydration reads current state, `data.seq` can exceed the frame `seq`; clients apply an entity only when its `seq` is newer than
what they hold (`[04 5.5]` R1), so an old frame never regresses newer data.

### 9.4 Client reconciliation rules (protocol level; implemented by `[04 5.5-5.7]`)

1. Snapshot then subscribe: `GET /instance` gives `instanceId`, `epoch`, `headSeq`; open the stream with `since=headSeq&epoch=epoch`.
   Every later snapshot carries `asOfSeq`.
2. `hello`: another `instanceId` -> the page talks to another instance (port reused): drop all caches and reload instance info. Another
   `epoch` -> full resync.
3. `change`: `seq <= lastSeq` -> duplicate, ignore; `seq > lastSeq + 1` -> gap -> full resync; else apply: patch an entity only if
   `data.seq > cached.seq`; `data: null` -> invalidate that entity; `event/append` items go to live buffers (dedupe by event `id`);
   `truncated` -> refetch the first page of affected feeds; `tool_call/upsert` patches timeline rows by `toolUseId`; `transcript/append`
   -> mounted transcript windows refresh with `after=next`; `usage/invalidate` -> debounced invalidation of analytics and overview; `attempt/upsert` -> invalidate the attempts panel query
   (otherwise polled every `poll.attemptsMs`).
4. `reset` -> `lastSeq = headSeq`; full resync (invalidate every query of the instance, clear live buffers).
5. `heartbeat`: `headSeq > lastSeq` on two consecutive heartbeats -> resync. No message (change or heartbeat) for 2.5 x `heartbeatMs` ->
   reconnect.
6. A snapshot never overwrites an entity patched with a newer `seq` (`[04 5.5]` R4); live buffers drop items already in a refetched page
   (`event.seq <= page.asOfSeq`).
7. Stream connectivity is not ingestion health: the UI shows the stream state and `HealthReport.ingestion` separately (brief 10).

### 9.5 Reconnect story

| Situation | What happens |
|---|---|
| Network blip, server alive | the client reconnects with `since=lastSeq&epoch` after backoff (2, 4, 8, 16, 30 s, `[04 5.6]`); the server replays the missed seqs |
| Server restart (stop/start, upgrade, restore) | new epoch -> `reset(epoch_changed)` -> full resync; `hello.runtimeVersion/codeStamp` lets the UI offer a reload |
| Client asleep beyond the retention (24 h or 20,000 changes) | `reset(cursor_too_old)` -> full resync |
| Another instance now owns the port | `hello.instanceId` (and every REST `X-MCS-Instance`) differs -> instance-changed flow |
| More than 16 tabs | `503 stream_limit`; the client backs off and polls REST (`[04]` `polling` state) |
| Slow or throttled tab | evicted after 30 s without drain; reconnects and replays |

### 9.6 Prototype evidence `[exp:X5]`

Express 5.3.0 on 127.0.0.1:18431 (stopped at the end), raw `node:http` clients: 13 of 13 checks passed: `hello` first; three live changes
with ids 1, 2, 3; named heartbeat received; `Last-Event-ID: 1` replays 2 and 3 exactly; foreign epoch, pruned, ahead and garbage cursors
each produce `reset` with the right reason; `Host: evil.example` gets 403; six aborted clients are all removed; a paused client is evicted
with 16,722 bytes buffered while a concurrent fast client received all 400 large frames; no clients left; heap 11.8 MB. The first,
push-based version failed the slow-client test (both clients exceeded a byte limit during a synchronous burst and were dropped
repeatedly), which is why the design is pull-based.

## 10. Alerts (brief 8.8, ADR 0027)

### 10.1 Rules

Rules are configuration (`runtime.json` section `alerts`, owned by this document, validated and audited by `mcs configure` `[01 1.6]`),
not API-editable records: the API and UI are read-only. Built-in rule ids equal their kind. State lives in `alerts` and `alert_state`.
Alerts are not acknowledged; they resolve when the condition clears (or expire).

| Rule (`ruleId`) | Scope key | Condition (holds when) | Severity | Evaluated | Clears when | Defaults |
|---|---|---|---|---|---|---|
| `inactivity` | session uid | state in `ACTIVE_STATES` and `now - last_activity_at >= minutes` | warning; critical at 4 x minutes | sweep | activity resumes or state leaves the active set | `minutes: 30, cooldownMinutes: 10` |
| `ingest_errors` | error `code` | at least `count` `ingest_errors` rows with that code within `windowMinutes` (`[02 8.3]` `ingest_errors_repeated`) | warning; critical at `criticalCount` | after a commit that recorded errors, and sweep | count in window < `count` | `count: 10, windowMinutes: 10, criticalCount: 50` |
| `runtime_unavailable` | `instance` | a `reconciliations` row of kind `runtime_unavailable` newer than the last evaluation, or `IngestHealth` reason `HOOKS_FAILING` from `HANDLER_UNAVAILABLE` (`[02 8.3]`) | warning | after commit, at startup | not by condition: resolves as `expired` after `expireHours` | `expireHours: 24` |
| `token_threshold` | session uid | the session's total (`field: 'total'` or `'output'`) >= `tokens` | warning; critical at 2 x tokens | after usage changes, and sweep | never while the session exists (tokens only grow); `scope_deleted` on retention | `enabled: false, tokens: null` |
| `import_lag` | `instance` | `IngestHealth.receiving.transcripts.status = 'lagging'` (`maxLagMs > health.importLagWarnMs`) | warning; critical when `maxLagMs` > 10 x the threshold | sweep (after each 5 s health refresh) | status not `lagging` | `cooldownMinutes: 10` |
| `db_disk` | `instance` | `IngestHealth.persisted.status = 'db_error'`, `ENOSPC`/`SPOOL_FULL` reasons, free disk < `minFreeMb`, or DB + WAL > `maxDbMb` | warning; critical for write failures or free < `minFreeMb / 4` | sweep and immediately from the DB error mapper | none holds | `minFreeMb: 500, maxDbMb: 2048, cooldownMinutes: 30` |
| `hook_gap` | session uid | `sessions.hook_coverage = 'partial'` (`[02 8.1]`) | warning | after a commit that changed coverage | coverage `full` or `none` | `enabled: true` |
| `hook_failing` | `instance` | `IngestHealth.receiving.hooks.status = 'failing'` | warning | sweep | status not `failing` | `enabled: true` |

Notes: `token_threshold` fires on lower-bound totals, which can only make it fire late, never early (DA-I9; `[02 8.3]` offers the input
only for complete aggregates, the lower-bound rule is equivalent in safety and earlier). `db_disk` conditions are also kept in memory and
reported through `HealthReport.db` because writing the alert row can itself fail on a full disk.

`runtime.json` section `alerts`:
```json
{ "alerts": { "enabled": true, "sweepSeconds": 60, "rules": {
  "inactivity": { "enabled": true, "minutes": 30, "cooldownMinutes": 10 },
  "ingest_errors": { "enabled": true, "count": 10, "windowMinutes": 10, "criticalCount": 50, "cooldownMinutes": 10 },
  "runtime_unavailable": { "enabled": true, "expireHours": 24 },
  "token_threshold": { "enabled": false, "tokens": null, "field": "total" },
  "import_lag": { "enabled": true, "cooldownMinutes": 10 },
  "db_disk": { "enabled": true, "minFreeMb": 500, "maxDbMb": 2048, "cooldownMinutes": 30 },
  "hook_gap": { "enabled": true, "cooldownMinutes": 30 },
  "hook_failing": { "enabled": true, "cooldownMinutes": 10 } } } }
```
`sweepSeconds` 15..600. A disabled rule resolves its open alerts with `rule_disabled` at startup.

### 10.2 Evaluation, de-duplication and cooldown

`AlertService.apply(ruleId, scopeKey, r: { holds: boolean; severity: 'warning' | 'critical'; value: number | null; title: string; detail:
Record<string, number | string | boolean | null>; sessionId: number | null })` runs in its own small transaction **after** the transaction
that produced the condition committed, never inside ingestion; it is wrapped in try/catch and a failure becomes an `ingest_errors` row with
`source 'alerts'` that never propagates:
```
open  := SELECT * FROM alerts WHERE rule_id = :rule AND scope_key = :key AND status = 'open'      -- at most one (ux_alerts_live)
state := SELECT * FROM alert_state WHERE rule_id = :rule AND scope_key = :key                     -- or a new row
if r.holds:
  state.condition_since := coalesce(state.condition_since, now)
  if open:  UPDATE alerts SET last_fired_at = now, fire_count = fire_count + 1, detail = :detail, severity = :sev,
                              updated_seq = CASE WHEN severity <> :sev THEN :seq ELSE updated_seq END   -- change row only on severity change
  elif state.cooldown_until IS NOT NULL AND now < state.cooldown_until:  (suppressed)
  else:     INSERT INTO alerts (..., status, first_fired_at, last_fired_at, updated_seq) VALUES (..., 'open', now, now, :seq)
else:
  if open:  UPDATE alerts SET status = 'resolved', resolved_at = now, resolved_reason = 'condition_cleared', updated_seq = :seq
            state.cooldown_until := now + cooldownMinutes
  state.condition_since := NULL
state.last_evaluated_at := now; state.last_value := r.value; upsert alert_state
```
Titles are fixed templates with numbers only ("No activity for 47 min", "12 TRANSCRIPT_READ_FAILED errors in 10 min", "Monitor was not
running for 6 min while 14 hook events arrived", "Session used 2.1M tokens (threshold 2M)", "Transcript import 90 s behind", "Free disk
space 410 MB", "Hooks missed 3 tool calls in this session", "Hook handler failing"). Schedule: sweep every `sweepSeconds` (first 10 s
after start), event-driven checks after commits that record ingest errors, usage changes or coverage changes, and the startup check.

### 10.3 Exposure

`GET /alerts`, `GET /alerts/rules` (6.1); `HealthReport.alerts` and `Overview.alerts`; stream `alert/upsert`; the CLI reads them through
the same routes or the DB reader `[01 6.1]`; `mcs status` can show the open count by severity.

### 10.4 Outbound webhooks: deferred (D15)

Not built in v3. Future safe design, recorded so nobody adds an unsafe shortcut: opt-in per instance in `runtime.json`
(`alerts.webhooks[]`, audited); HTTPS targets on an explicit allow-list (plain HTTP only for `127.0.0.1`); the signing secret read from a
file or environment variable named in the config and never stored in the DB, config output or logs (shown as `***`); each request
signed with HMAC-SHA256 over the body and a timestamp; payload = alert metadata only (rule, severity, title values, counts, instance id,
session id), never labels, summaries or transcript text; 5 s timeout, no redirects, at most 3 retries with exponential backoff, sent from
an in-process queue after commit (never in the ingest path); a bounded delivery log (last 500 attempts, status codes only) in diagnostics.

## 11. Export, backup, retention and the background schedule (brief 7, 8.10; ADR 0028)

Division of work: this document defines the DB functions and the export format; `[01]` owns the commands, their confirmations, backup
folders and manifests, restore and the task mutex (`[01 5.4-5.6, 6.4]`). No API route writes to disk except the temporary snapshot of an
export inside `data/exports/` (DA-I10, DA-I11).

### 11.1 Export format `mcs.export/1` (JSONL, metadata by default)

```ts
export interface ExportQuery {                 // GET /api/v3/export query params; CLI flags of `mcs export` [01 6.4]
  session?: string[];                          // <= 500 ids; empty = whole instance
  workItem?: number; range?: Preset; from?: IsoTime; to?: IsoTime;
  include?: ('sessions' | 'agents' | 'workflows' | 'work_items' | 'events' | 'tool_calls' | 'turns' | 'usage' | 'transitions' | 'alerts')[];  // default all
  redaction?: 'standard' | 'strict';           // default standard
  includeContent?: boolean;                    // default false; `--include-content`
}
export interface ExportSummary { lines: number; bytes: number; sha256: string; counts: Record<string, number>; includeContent: boolean }
export function exportInstance(db: InstanceDb, ctx: RepoContext, q: ExportQuery, out: NodeJS.WritableStream, signal: AbortSignal): Promise<ExportSummary>;
```
Lines (UTF-8, LF, one JSON object each):
1. Header `{"type":"header","format":"mcs.export/1","instanceId":..,"slug":..,"exportedAt":..,"runtimeVersion":..,"dbSchemaVersion":..,
   "scope":{resolved from/to, session ids},"include":[..],"redaction":"standard","includeContent":false,"privacyNote":"Metadata only: no
   prompt, reply, thinking or tool result text."}` (with `includeContent: true` the note says "Contains transcript text: treat as
   confidential").
2. Records in this order, each `{"type":"<t>","data":{...}}`: `session` (`SessionSummary` + `cwd`, `gitBranch`, `permissionMode`), `agent`
   (`AgentNode`), `workflow` (`WorkflowRunItem`), `work_item` (`WorkItem`), `turn` (`{ sessionId, agentId, promptId, startedAt, endedAt,
   endKind, origin, toolCount }`), `event` (`ActivityEvent` without `sessionLabel`/`agentLabel`), `tool_call` (`ToolCallItem`), `usage`
   (`{ messageKey, sessionId, agentId, model, ts, input, output, cacheRead, cacheCreation, cacheCreation5m, cacheCreation1h, thinking,
   finalized, synthetic, usageSource, files }`), `transition` (`TransitionItem` + `sessionId`), `alert` (`AlertItem`). The data objects use
   the API's Zod schemas (`packages/shared/src/api/export.ts` adds only the `type` discriminator): no second definition.
3. With `includeContent`: after each session's records, `{"type":"transcript","sessionId","agentId","entries":[TranscriptEntry...]}`
   lines of at most 500 entries, produced by the transcript window function (7.3) for files still on disk (missing files are listed in the
   trailer); thinking entries excluded.
4. Trailer `{"type":"trailer","counts":{..},"missingTranscripts":[..],"sha256":"<hex of all bytes before this line>"}`.

`strict` redaction: `label` -> `''` when `labelSource = 'first_prompt'`; `summary` fields, agent `description`/`label` (-> `agentType`),
`workflow.name`, `cwd`, `gitBranch`, `projectLabel` -> `null`; `projectId` -> `'p-' + sha256(projectId)[0..12]`; `includeContent` is
refused with `strict` (`400 validation_failed`).

Consistency: with a running server the route first makes an online backup into `data/exports/.tmp-<random>.db` (4.4), streams from a
read-only connection on that copy and deletes it in `finally` (one export at a time, `429 export_busy`); the CLI DB reader on a stopped
instance streams from a read-only connection directly. Rows are read with keyset pages of 1,000 (`WHERE id > :last ORDER BY id LIMIT
1000`), awaiting `drain` and checking the abort signal between pages. No size cap. No import in v3: an export is for analysis and
archiving; backup/restore is the byte-exact path. Attempt runs are not exported: the chain log in the repository is their source.

### 11.2 Backups, restore, rebuild

`backupDb` (4.4) is the only DB-level function; folders, manifests, pruning (`backup.keep`), `mcs backup restore` and the stale WAL
handling belong to `[01 5.5]`. After a restore or after moving a corrupt DB aside, the next server process has a new stream epoch (9.2),
so connected clients resynchronize; nothing in the DB has to change.

### 11.3 Data retention

`applyRetention` (3.8) is run by `mcs cleanup --task S --scope data` `[01 6.4]` on a stopped instance after the automatic `cleanup`
backup; the command owns the dry run, `--yes` and `--confirm <slug>`. Automatic bookkeeping retention (3.8) runs in the server.

### 11.4 Background schedule (server process)

`createDbScheduler(ctx: InstanceContext): { start(): void; stop(): Promise<void> }` in `packages/engine/src/maintenance/schedule.ts`.
`[01 4.4a]`'s `createInstanceRuntime(ctx)` calls `start()` after the DB is open and the ingest service started, and `stop()` (clears
every timer, awaits a running retention batch) before the DB closes (I-15). Timers use `ctx.clock` so tests drive them with fake time.

| Timer | Interval | Work |
|---|---|---|
| liveness mark | 60 s | `meta.last_alive_at` (input of the downtime reconciliation `[02 8.1]`) |
| health refresh | 5 s (`[02 8.2]`) | `ingest_health` row; `health/upsert` only when a status changes |
| alert sweep | `alerts.sweepSeconds` (60) | 10.2 |
| throttled session/agent announcements | 1 s | 3.6 "Activity-only session updates" |
| WAL checkpoint | 15 min, or WAL > 64 MiB | `PRAGMA wal_checkpoint(PASSIVE)` |
| optimize | 6 h and on close | `PRAGMA optimize` |
| bookkeeping retention | 60 s after start, then 6 h | 3.8 automatic categories, then `incremental_vacuum` |

## 12. One query layer for API, CLI and stream (ADR 0029, DA-I13)

### 12.1 Engine query functions (`packages/engine/src/query/index.ts`)

The server routes, the stream hydration and the CLI DB reader `[01 6.1]` call these functions; repositories are never called from
outside the engine.
```ts
export interface EngineQueries {
  instanceInfo(ctx: RepoContext): InstanceInfo;
  health(ctx: RepoContext): HealthReport;
  ingestHealth(ctx: RepoContext): IngestHealth & { asOfSeq: number };
  errors(ctx: RepoContext, q: ErrorsQuery): { asOfSeq: number; items: ErrorItem[] };
  overview(ctx: RepoContext, q: OverviewQuery): Overview;
  listSessions(ctx: RepoContext, q: SessionListQuery): Page<SessionSummary>;
  getSession(ctx: RepoContext, sessionId: string): SessionDetail & { asOfSeq: number };          // NotFoundError('session_not_found')
  sessionSummaries(ctx: RepoContext, sessionRowIds: readonly number[]): SessionSummary[];        // hydration
  sessionAgents(ctx: RepoContext, sessionId: string, q: SessionAgentsQuery): Page<AgentNode>;
  listAgents(ctx: RepoContext, q: AgentListQuery): Page<AgentNode>;
  agentNode(ctx: RepoContext, agentRowId: number): AgentNode | null;
  workflowRun(ctx: RepoContext, runRowId: number): WorkflowRunItem | null;
  listEvents(ctx: RepoContext, q: EventListQuery): EventPage;
  getEvent(ctx: RepoContext, eventId: number): ActivityEvent & { asOfSeq: number };
  eventsByIdRange(ctx: RepoContext, sessionRowId: number, from: number, to: number, limit: number): ActivityEvent[];
  listToolCalls(ctx: RepoContext, q: ToolCallListQuery): Page<ToolCallItem>;
  toolCallsByIds(ctx: RepoContext, ids: readonly number[]): ToolCallItem[];
  sessionTransitions(ctx: RepoContext, sessionId: string, q: TransitionListQuery): Page<TransitionItem>;
  workItemBoard(ctx: RepoContext, q: WorkItemBoardQuery): WorkItemBoard;
  getWorkItem(ctx: RepoContext, id: number): WorkItem & { sessions: SessionSummary[]; asOfSeq: number };
  listAlerts(ctx: RepoContext, q: AlertListQuery): Page<AlertItem>;
  alertRules(ctx: RepoContext): AlertRulesView;
  usage(ctx: RepoContext, q: UsageQuery): UsageReport;
  sessionUsage(ctx: RepoContext, sessionId: string, q: SessionUsageQuery): UsageReport;
  series(ctx: RepoContext, q: SeriesQuery): UsageSeries;
  tools(ctx: RepoContext, q: ToolsQuery): ToolFrequencyReport;
  hookProbe(ctx: RepoContext, probeSessionId: string): HookProbeResult | null;                     // route ingestProbe (I-37)
  explainCompletion(ctx: RepoContext, target: CompletionTarget): CompletionEvidence & { asOfSeq: number };   // [02 7.13] over a CompletionLookup (6.3); throws CompletionTargetError (I-08)
}
export interface TranscriptQueries {
  window(ctx: RepoContext, q: TranscriptWindowQuery, signal: AbortSignal): Promise<TranscriptWindowResponse>;
  locate(ctx: RepoContext, q: TranscriptLocateQuery, signal: AbortSignal): Promise<TranscriptLocateResponse>;
  searchSession(ctx: RepoContext, q: TranscriptSearchQuery, signal: AbortSignal): Promise<TranscriptSearchResponse>;
  searchInstance(ctx: RepoContext, q: InstanceSearchQuery, signal: AbortSignal): Promise<InstanceSearchResponse>;
}
export interface AuditQueries {
  sessionAuditRefs(detail: Pick<SessionDetail, 'startedAt' | 'endedAt' | 'lastActivityAt'>): Promise<AuditRef[]>;   // 6.3 (I-19)
}
export interface AuditReader { entriesBetween(fromMs: number, toMs: number, limit: number): Promise<AuditRef[]> }   // [01 7.1] AuditRef, bound to the workspace
export interface QueryDeps {
  config: ResolvedConfig; now: () => number; audit: AuditReader;
  process?: RuntimeProcessInfo;                                  // [01 4.4a]; HealthReport.runtime pid/startedAt (registry C09)
  childStats?: () => Record<ChildKind, ChildKindStats>;          // [06 3.6]; HealthReport.children
  panelStats?: () => PanelStats;                                 // [06 3.4] PanelService.stats(); HealthReport.panels
}
export function createQueries(db: InstanceDb, deps: QueryDeps): EngineQueries & TranscriptQueries & AuditQueries;
```
`CompletionTarget` (`{ sessionId } | { label } | { attemptPart }`), `CompletionLookup`, `CompletionTargetError` and `explainCompletion(lookup,
target, now)` are `[02 7.13]`'s; `CompletionEvidence` is the `z.infer` of the shared schema (6.3). `AuditRef` is `[01 7.1]`'s type
(`engine/src/audit/reader.ts`). Composition (I-15, registry C09): `[01 4.4a]`'s `createInstanceRuntime(ctx)` builds `ctx.queries =
createQueries(ctx.db, { config: ctx.config, now: ctx.clock.now, audit, process, childStats, panelStats })` with all six deps (`audit` =
`entriesBetween` bound to the workspace); the CLI `DbReader` passes `config`, `now` and `audit` only. The server routes, the stream hub,
`[06]`'s `createPanelService(ctx, { writer })`, `[02]`'s `createIngestService(ctx)` (for `health()` inputs only) and the CLI DB reader
use that one object.
All synchronous functions read inside one synchronous step and return `asOfSeq` (DA-I8); `sessionAuditRefs` is the only async read
outside `TranscriptQueries`, and it reads no database table. The query types (`SessionListQuery`, ...) are
the parsed outputs of the route Zod schemas, so the CLI builds them from flags with the same schemas.

### 12.2 Mapping of `[01 6.1]` `InstanceReader`

| `InstanceReader` method | `ApiReader` (server running) | `DbReader` (stopped, read-only) |
|---|---|---|
| `sessions(q)` | `GET /api/v3/sessions` | `listSessions` |
| `session(id)` | `GET /api/v3/sessions/:id` (404 -> null; the route already attached `auditRefs`) | `getSession`, then `await sessionAuditRefs(detail)` attached as `auditRefs` (6.3, I-19) |
| `usage(q)` | `GET /api/v3/analytics/usage` | `usage` |
| `errors(q)` | `GET /api/v3/errors` | `errors` (ingest rows only; no server ring offline) |
| `explainCompletion(t)` | `GET /api/v3/completion`; `404 completion_target_not_found` -> throws `CompletionTargetError('target_not_found')`, `400 validation_failed` -> `CompletionTargetError('target_invalid')` | `explainCompletion` (12.1, wraps `[02 7.13]`; the error propagates unchanged) |
| `exportTo(q, out)` | `GET /api/v3/export` streamed to `out` | `exportInstance` |
Both modes return the same JSON (validated with the same response schemas); a contract test runs every method in both modes on one
fixture and compares (DA-T-CLI-1).

## 13. API contract strategy (Zod -> JSON Schema -> docs)

1. **Registry** (`packages/shared/src/api/routes.ts`): `defineRoute({ id, method, path, params, query, body, response, successStatus,
   errors, summary, contentType })` for every route of 6.1. Query schemas are `z.strictObject` with `z.coerce` for numbers; response
   schemas are `z.strictObject` all the way down. Every contract lives under `packages/shared/src/api/*.ts`, including the panel
   contracts (`panels.ts`, written by `[06]`, I-35) and `completion.ts`; the registry imports `PanelResponseSchema` from there.
2. **Server**: handlers are registered only through `registerRoute(app, route, handler)`, which validates params/query/body, maps errors
   to the envelope and, when `NODE_ENV !== 'production'`, validates the response with `route.response` before sending. A test lists
   Express's routes and asserts a 1:1 match with the registry (plus the static and history fallback of `[04]` ADR 0039).
3. **Clients**: the web client (`[04]` `data/endpoints.ts`) and the CLI `ApiReader` build URLs from `route.path` and validate responses
   with `route.response`; stream messages are validated with the schemas of `stream.ts`.
4. **JSON Schema**: `npm run schemas` (the one generator `runtime/scripts/gen-schemas.mjs` of `[05 3.1]`/`[01 2.9]`, registry C45; this
   document owns its API part) writes per route `schemas/api/<routeId>.{params,query,body,response}.schema.json` with `z.toJSONSchema(schema, { io: 'input' })`
   for inputs and the default (output) for responses (draft 2020-12, verified on Zod 4.6.5 `[exp:X6]`), plus `schemas/api/stream.schema.json`,
   `schemas/export/<type>.schema.json` and `docs/api/reference.md` (method, path, summary, params, error codes, schema links).
5. **Drift check**: `npm run schemas:check` regenerates into a temporary folder and diffs with the committed files (CI and the root `ci`).
6. **Contract tests** (`packages/server/test/contract/*.test.ts`): a synthetic fixture DB from the testkit, the server on `listen(0)`; per
   route one valid request (status and strict parse), one request per listed error code (envelope and code), an unknown query key
   (`validation_failed`), a repeated key (`param_repeated`); a meta-test asserts that every `ErrorCode` is listed by some route and
   produced by some test.

## 14. Security and reliability mapping (brief 12, API parts)

| Brief 12 requirement | Mechanism here |
|---|---|
| Loopback bind; no all-interfaces exposure | bind `127.0.0.1` `[01 4.11]`, ADR 0045; Host guard accepts only `127.0.0.1:<port>` and `localhost:<port>` (5.2) |
| Validate Host and Origin | 5.2 steps 2-3 and `Sec-Fetch-Site`; the nudge refuses any `Origin`; tests DA-T-API-4 |
| Keep secrets out of logs and audit | allow-listed logger fields; no query strings, bodies, search text or summaries in logs; error messages never echo input; Zod issues as paths and codes only `[exp:X6]` |
| Restrict filesystem access; no traversal or unsafe symlinks | no path parameters (DA-I10); transcript reads only through `transcript_files.path` with `realpath` containment in the transcripts root; the export snapshot only under `data/exports/`; segment names validated by pattern and CHECK |
| Validate payloads and request sizes | strict Zod schemas; 256-byte nudge body; 8 KiB URLs (ADR 0045); list caps; `limit` maxima; `q` length |
| Timeouts and resource limits | server timeouts (5.1); search budgets and semaphores; export single-flight; stream limit 16 and stall eviction; scan caps; bounded frames |
| Escape transcript content in the UI | the API returns plain text only; rendering rules are `[04]` ADR 0034 |
| No arbitrary command execution from the web interface | the HTTP API is read-only (DA-I11); no route executes commands or writes files outside `data/exports/.tmp-*` |
| Malformed JSONL never crashes the runtime | the entry index and the scan treat invalid lines as zero entries; repositories validate with Zod before writing; ingest errors are rows, not exceptions `[02 4.8]` |
| Clear shutdown | `[01 4.5]` (graceful): streams end, the current transaction finishes, `meta.last_shutdown_at`, `PRAGMA optimize`, close |
| Monitoring failures never block Claude Code | the hook handler never touches the DB; the nudge answers `204` at once; DB problems surface as alerts and health |

## 15. Reconciliation with the sibling designs

### 15.1 `04-ui.md` section 13 (assumed contracts)

The UI isolates names in `data/endpoints.ts` (`[04]` O-1). After I-10, `[04]` section 13 imports every contract from `@mcs/shared`
(this document's 5.5, 6.2, 9.2 and `[06 3.3]`) and keeps no definitions of its own; `useWorkItems`/`qk.workItems` replace the task names
(the UI route `/tasks` and URL param `task` may stay as UI-only names). The table records the deltas; rows marked "adapt" are carried
out by I-10 in `[04]`.

| UI assumption | This document | UI action |
|---|---|---|
| `ErrorCode` with 6 coarse values; `409 cursor_expired` | granular lowercase codes (5.2); an invalid cursor is `400 cursor_invalid` | adapt: reset the infinite query on `cursor_invalid`; group other codes by status |
| `Page<T>` | same + `totalIsLowerBound` | none |
| `LIFECYCLE_STATES` (10), `StateAssessment` | same + `presence, waitReason, staleKind, endReason, turnOutcome, rule, evaluatedAt` (`[02 7.1]`) | none |
| `TokenUsage` | same + `total`, `missing`, `synthetic`, `unfinalized`; `turns` is a number | none |
| `CostEstimate` | + `unpricedModels` | none |
| `SessionSummary.taskIds`, query `task` | `workItemIds`, query `workItem` ("task" clashes with the monitoring task `--task <slug>`) | adapt (rename) |
| `SessionSummary.freshness` | + `transcriptLagBytes, hookCoverage, eventsComplete, usageComplete` (`[02 8.2]`) | none |
| `SessionDetail.ruleLabel` | `label` with `labelSource = 'rule'` | adapt |
| `AgentNode.workflow: string \| null` | `{ runId, name, phase, state }` + `kind, depth, requestShape, endedAt, toolCallCount, transcript` | adapt display |
| `ActivityEvent.id: string`, `transcriptRef { agentId, index }`, `gapBefore`, sources `derived/external` | `id: number`; `transcriptRef { agentId, offset }` (resolve with `/transcript/locate?offset=`); gaps are `monitor.gap` events (category `ingest`) rendered as separators; sources `hook/transcript/monitor`; + `hookEvent`, `entryKind` | adapt |
| Transcript window/locate | same + `sessionId, agentId, pendingBytes, fileState, asOfSeq`; `base` always 0; `thinking=1` opt-in | none |
| `TranscriptSearchQuery.sessionId` | query param `session` (+ `budgetMs`) | adapt (rename) |
| `TranscriptSearchResponse` | same + `offset, count, partial, query, coverage` | none (show `coverage.note`) |
| `/tasks`, `TaskBoard`, `TaskCard` | `/work-items`, `WorkItemBoard { asOfSeq, derivation, items, truncated }`, `WorkItem` (`source` values `declared/attempts/label`, + `key, rule, boardReason, since`) | adapt (rename) |
| `Overview`, keys S-7 | superset; every S-7 key provided (8.1) + `Metric.link` | none |
| `AnalyticsQuery.groupBy 'task'` | `'workItem'` (+ `agent`, `none`) | adapt |
| `UsageSeries` points with `null` values | numbers; empty buckets omitted (gaps) | adapt |
| `ToolFrequencyRow.failures` | `failed` (+ other statuses, `failurePct`, `maxDurationMs`) | adapt |
| `HealthReport.alerts[]` `{ id: string, rule, severity, since, message, sessionId }` | `AlertItem` (`id: number`, `title` instead of `message`, same rule names plus `hook_gap`, `hook_failing`, no acknowledgement) | adapt |
| `InstanceInfo` | same + `epoch`, `limits` | none |
| Stream `hello`/`change`/`heartbeat`/`reset`, `Last-Event-ID` precedence (S-10) | same; `hello` + `epoch, runtimeVersion, codeStamp`; heartbeat + `epoch`; reset reasons `cursor_too_old, cursor_ahead, epoch_changed, cursor_invalid`; the epoch changes with every server process | adapt reason enum |
| `StreamChange` kinds (`task`, `config`, single-event `event/append`) | `work_item` instead of `task`; no `config` kind (config is read at start; a change needs a restart, visible through `hello`); `event/append` data is `{ items[], count, truncated }`; extra kinds `workflow`, `tool_call`, `alert`; `data` may be `null` | adapt |
| S-3 tie-break `id` ascending | tie-break `id` in the sort direction (still a total order; the UI never re-sorts) | none |
| S-5 shared `matchesEventFilter`; S-6 `around`; S-7; S-9; S-10 | provided | none |
| Panel payloads (`GitPanel`, `MachinePanel`, ...) returned bare | wrapped in `PanelResponse<K>` `{ key, status, generatedAt, sources, data }` (`[06 3.3]`, CH-3) | adapt: `usePanel` reads `data`, maps `status` and `sources` |
| no attempts change kind | `attempt/upsert` (9.1) invalidates the attempts panel query | adapt |

### 15.2 `01-instances-config-ops.md`

| 01 expects (its open item 3, C-4, 1.6) | This document |
|---|---|
| `openInstanceDb({path, instanceId, mode: 'serve'})`: new DB created and stamped; identity exit 11, newer 15, older 16, other failures 14 | 3.2 and 4.5 (`DB_OPEN_EXIT_CODES`); `expectedInstanceId` naming |
| `peekDbSchemaVersion(path)` without a lock | 4.3 |
| `backupDb(src, dest)` from the server connection and from a read-only CLI connection | 4.4; verified from a read-only connection `[exp:X12]` |
| `planDbMigrations(path)` -> `{from, to, steps}`, `migrateDb(path, {backupDone: true})` | 4.3 (+ `runtimeVersion`, `expectedInstanceId`) |
| `applyRetention(db, policy, {dryRun})` | 3.8 (signature adds `ctx`, `now`, `signal`; the plan type is defined there) |
| export format `mcs.export/1`, meaning of `--include-content` | 11.1 |
| C-4: `GET /api/health` compatibility | 6.2 |
| `/api/v3/health` fields used by `status` | `HealthReport` 6.2 |
| `runtime.json` sections `retention`, `alerts`, `pricing` owned by the data design | 3.8, 10.1, 8.3 |
| `InstanceReader` with Api and Db readers calling the same engine functions | 12.2 |
| this document needs from 01 | the `analytics` R section `{ usageTrend: boolean }` (default false, owned here) composed as `strictObject().prefault({})` (I-01); nothing in `server` (no `server.devOrigins`, I-31) |
| C-4 key set `{ ok, version, pid, started, uptime, now, code_stamp, engine, instanceId, task, config_source, errors, reader }` | 6.2 `LegacyHealth`, adopted verbatim (I-30) |
| composition root `InstanceContext`, `createInstanceRuntime(ctx)` (`[01 4.4a]`, I-15) | `ctx.queries` = `createQueries(ctx.db, { config, now, audit, process, childStats, panelStats })` (12.1, C09); `createDbScheduler(ctx)` (11.4) plugs into `start`/`stop`; the runtime's `health()` returns `EngineQueries.health` |
| `entriesBetween(ws, fromMs, toMs, limit): Promise<AuditRef[]>` (`[01 7.1]`, I-19) | `SessionDetail.auditRefs` through `deps.audit` and the async `sessionAuditRefs`, awaited after the snapshot (6.3, 12.1) |
| `ConfigInspection` in `shared/src/cli/results.ts` (I-20) | response of route `config` (6.1) |
| diagnostics bundle `health` (I-21) | carries `HealthReport` (6.2) with `runtime` resources, `children`, `panels` |
| `verify-completion`, `InstanceReader.explainCompletion` (I-08) | route `explainCompletion` and `EngineQueries.explainCompletion` (6.1, 6.3, 12); both readers throw `CompletionTargetError`, mapped by `[01 6.4]` to `USAGE` / `NOT_FOUND` |
| `InstanceReader.errors` (`[01 6.1]`) | returns `ErrorItem[]` (6.1, `shared/src/api/health.ts`; registry C21) |
| optional `mcs db rebuild` (I-12) | the 4.4 recovery steps; no DB function other than `backupDb` |

### 15.3 `05-tooling-testing-security.md` (ADR 0045)

| 05 rule | This document |
|---|---|
| Host exactly `127.0.0.1:<port>` / `localhost:<port>`; empty, `0.0.0.0`, `[::1]` refused | 5.2 step 2 (adopted) |
| Origin allow-list, `null` refused; `Sec-Fetch-Site` cross-site (all) and same-site (non-GET) refused | 5.2 step 3 (adopted) |
| UI mutations need JSON + `X-MCS-Request: 1` | no mutating UI route in v3; reserved code `csrf_rejected` |
| Nudge: no `Origin`, <= 256 bytes, data-free | 5.2 step 7 |
| Limits: URL 8 KiB, 128 connections, 16 SSE streams, timeouts; headers incl. COOP | 5.1, 5.2, 9.2 (adopted) |
| Code names `HOST_FORBIDDEN`, `ORIGIN_FORBIDDEN`, `CSRF_REJECTED` ("final names follow the API design's catalogue") | `host_not_allowed`, `origin_not_allowed` / `cross_site_request`, `csrf_rejected` |
| Guard module `packages/server/src/http/guards.ts` | same path (5.2) |
| ESLint restriction of `better-sqlite3` (A.9, 2.2) | allowed only in `packages/engine/src/db/driver.ts` (4.5; I-14 changes 05's path to this one) |
| coverage map 4.2 (I-22) | the test files of section 23, named by the `[05 4.1]` layout (for example `engine/src/maintenance/retention.test.ts`, `shared/src/api/routes.test.ts`, `server/test/stream-*.int.test.ts`) |
| guard module ownership (`99` section 3) | `[05]` S6 owns `guards.ts`; this document's S4 depends on it and supplies the error codes of 5.2 |

### 15.4 `02-ingestion-lifecycle.md`

| 02 contract | This document |
|---|---|
| "The data-model designer owns names, DDL, indexes" (4.1) | 3.5 DDL and the entity mapping table; access patterns of 4.1 covered by `idx_events_session_ts`, `idx_events_content`, `ux_events_*`, `idx_tool_calls_open`, `idx_*_next_check`, `idx_turns_session`, `idx_usage_files_key` (verified plans `[exp:X12]`) |
| one `event` entity in the single `events` table (`[02 4.1]`, I-03) | 3.5 and the natural-key and stored-kind tables of 3.6 (normative; `[02 4.1, 4.3, 5.6]` carry the same stored kind); 02 writes through `EventsRepo` |
| `ChangeSink { record, flush, discard }` implemented by the realtime layer; entity `event` (4.6) | `createChangeSink` (9.1; `event` -> `event/append`); one `withWriteTx` per tick, `record()` -> `reserve()`, publication in `onCommitted` (I-16, no behaviour change) |
| `GET /api/v3/health/ingest` served by the API design | 6.1 `healthIngest` |
| Projection of `IngestHealth` to `HealthReport.ingestion` | 6.2 uses it as defined in `[02 8.2]` |
| Alert inputs (8.3) | 10.1 rules |
| Nudge protocol (2.8): `{instanceId}` <= 256 bytes, no `Origin`, `204`, `409` on mismatch | 5.2 step 7 (lowercase codes `origin_not_allowed`, `payload_too_large`, `validation_failed`, `instance_mismatch`; the handler does not read them) |
| Token rules 6.2 and aggregates 6.3 | storage and rollups 3.6, aggregation 8.2 (normative rules stay in 02) |
| Entry text on demand (`readEntryText`, 5.7) | the transcript window reuses the same projection (7.1); the entry index is this document's (7.2) |
| `GET /api/v3/ingest/probes/:probeSessionId` (3.7 V7, I-37) | route `ingestProbe` (6.1, 6.3) |
| `explainCompletion(lookup, target, now)`, `CompletionLookup`, `CompletionTarget`, `CompletionEvidence`, `CompletionTargetError` (7.13, I-08) | `EngineQueries.explainCompletion` builds the lookup (6.3, `SessionsRepo.completionCandidates`, `AttemptsRepo.runsByPart`) and the route maps `target_invalid` -> 400, `target_not_found` -> 404; shared response schema with `resolvedBy`, `candidates`, nullable `sessionId` (6.3); `attemptPart` 0..512 (C17) |
| spool segments `hooks-<YYYYMMDD>T<HH>Z.ndjson`, `SPOOL_SEGMENT_EXT` (2.3, 2.7, I-02) | `spool_cursors.segment` CHECK `GLOB '*.ndjson'` (3.5) |
| `MAX_LINE_BYTES` in `shared/src/protocol/limits.ts` (1.1, I-32) | imported (3.3); no copy in `db-constants.ts` |
| `renderEvidence(item, now)` and `viewChanged` (`lifecycle/rules.ts`), `toLegacy` (`lifecycle/legacy.ts`) (7.1, 7.9, I-33) | used by 5.5 and the view writes of 3.6 |
| `createIngestService(ctx)`, `createLifecycleSweeper(ctx)` (4.10, I-15) | use `ctx.db`, the repositories and `withWriteTx`; nothing here changes |
| `external.attempt` / `external.attempt_cleared` logical events of the attempts tick (`[06 3.10.7]`) | submitted to `[02]`'s writer after the attempts `withWriteTx` commits; the writer commits them in its own transaction (3.6, N-01) |

### 15.5 `06-panels-parity-platform.md`

| 06 contract | This document |
|---|---|
| attempts DDL 3.10.2 (OI-2, I-07) | `attempt_sources`, `attempt_runs` in `0001` (3.5) without `instance_id` (C-1); `AttemptsRepo` and `SessionsRepo.attemptCandidates` (3.6); change kind `attempt/upsert` (9.1); 06 3.10 refers to these names |
| source key of the chain log | `pathKey(path)`, exported by `[06 4.1]` `platform/paths.ts` next to `canonicalPath`/`samePath` |
| panel contracts in `shared/src/api/panels.ts` (I-35) | route `panel` response schema `PanelResponseSchema` (6.1, 13) |
| `PanelService.stats()`, `childStats()` and process resources for measurement (8.2, I-21) | `HealthReport.panels`, `HealthReport.children`, `HealthReport.runtime` resources (6.2) |
| runbook 7.1/7.2 (I-12) | backups and restore are `[01 5.5]`; no `reimport` (4.4); health field names are 6.2's |
| `createPanelService(ctx, { writer })` (I-15, N-01) | reads `ctx.queries` (session `TokenUsage` for rows); the attempts tick writes through `AttemptsRepo` inside one `withWriteTx`, then submits the 02 events to `writer` after COMMIT (3.6); candidates from `SessionsRepo.attemptCandidates`, uids from `SessionsRepo.uidsByRowIds` (N-10) |

## 16. CHALLENGES

**C-1. D2 "every query is also scoped by `instance_id`".** Followed as a repository-level scope check, not as a per-row column. Main
text: `openInstanceDb` verifies `application_id` and `meta.instance_id`, every repository method asserts `ctx.instanceId ===
db.instanceId` before running SQL (DA-I3), and every API response carries `X-MCS-Instance`. `[02 4.1]` writes "every entity is scoped
by `instance_id`" as natural keys `(instance_id, ...)`; with one file per instance the column would be constant. Evidence against the
column: a row of another instance can only appear if rows are copied between files, which no code path does (no import in v3); the
column would lead every composite index (nine on `events`), and secondary indexes are the dominant write cost (162k rows/s without them,
about 30k with six, about 16k with nine `[exp:X3, X12]`). Alternative if several instances ever share a process (D2 rejects it): add the
column and composite indexes in a migration. The attempts tables proposed by `[06 3.10.2]` with an `instance_id` column follow the same
rule and are stored without it (I-07).

**C-2. D11 "heartbeat comments" and "`Last-Event-ID` = seq".** Comments never reach `EventSource` listeners, so they cannot drive a
client watchdog (`[04 E2]`; this document's prototype uses a named `heartbeat` event `[exp:X5]`). Main text: a named `heartbeat` event
every 15 s and no comments. `Last-Event-ID` stays the plain numeric `seq`; because a restored DB can reuse seq values, `hello` and
`heartbeat` carry an `epoch` that changes with every server process, and the client sends it with `since`, so a cursor from another DB
generation produces `reset(epoch_changed)` instead of a wrong replay.

## 17. Decisions (ADRs 0020-0029)

| ADR | Title |
|---|---|
| 0020 | SQLite schema conventions: STRICT tables, epoch-ms time, owner-only foreign keys, enum CHECK policy, incremental auto-vacuum, WAL + synchronous NORMAL |
| 0021 | Forward-only, checksummed SQL migrations, applied explicitly after a verified backup; a newer DB is refused |
| 0022 | Metadata-only database: transcript text stays in the transcript files and is read on demand |
| 0023 | No FTS5 in v3.0: bounded block-prefilter scan of transcripts with coverage reporting |
| 0024 | Usage stored per file and per provider message key, per-field max with NULL as missing, owner = oldest file, delta-maintained rollups, covering time index forced for analytics |
| 0025 | Change log with reserved contiguous seqs, persist-then-publish, hydrated SSE frames, pull-based fan-out, per-process epoch |
| 0026 | API v3 conventions: read-only HTTP plus the nudge, error envelope and codes, keyset cursors, comma lists, instance stamping, legacy `/api/health` |
| 0027 | Alerts as configured rules with DB state, de-duplication, cooldown and expiry; no acknowledgement; webhooks deferred |
| 0028 | Export `mcs.export/1` (metadata by default, opt-in content) from a consistent snapshot; `backupDb`; bookkeeping retention automatic, data retention through the CLI |
| 0029 | One engine query layer for API routes, stream hydration and the CLI readers |

## 18. Experiments (2026-10-11, `D:/mvp/private/scratch/mcs-v3/data-api/`, synthetic data only, ports 18431-18432 opened and closed)

X1-X3, X7-X9 and X11 ran on the first schema draft (`0001_initial.draft1.sql`, same index design for sessions, events, usage and tool
calls; the final schema adds tables and columns from `[02]`); X12-X13 ran on the final schema.

| Id | Question | Command / file | Result |
|---|---|---|---|
| X0 | Driver, SQLite and library versions; compile options | `node -e` probe with better-sqlite3 from `stack-smoke` | SQLite 3.53.4; FTS5 yes; DBSTAT, STAT4, UPDATE_DELETE_LIMIT, MATH, PERCENTILE enabled; `DEFAULT_FOREIGN_KEYS`; `DEFAULT_WAL_SYNCHRONOUS=1`; **`OMIT_PROGRESS_CALLBACK`**; better-sqlite3 13.0.3, Express 5.3.0, Zod 4.6.5 |
| X1 | DDL executes; constraints; read-only access; backup timings | `ddl-bench.mjs` | migration in 13-14 ms; `foreign_key_check` empty; 11 probes rejected (CHECK, FOREIGNKEY, DATATYPE, UNIQUE); two-target event upsert merges and dedupes; read-only open after close works, writes refused, concurrent commits visible; backup 581 ms, `VACUUM INTO` 640 ms, `quick_check` 988 ms, `integrity_check` 7,623 ms (196 MB) |
| X2 | Query plans and timings, 400k events / 150k usage | `ddl-bench.mjs`, `ddl-bench2.mjs`, `usage-plans.mjs`, `usage-plans2.mjs` | table 3.7; non-covering usage index 115-220 ms vs covering forced 12-23 ms; unbounded event `LIKE` 1.8 s; without `idx_events_kind_ts` kind filters 113-128 ms; cascade delete of 50 sessions 1.1 s |
| X3 | Insert throughput cost drivers | `insert-profile.mjs` | file + 6 event indexes ~28-30k rows/s (500-row batches, max 46-59 ms); memory 120k; no secondary indexes 162k; only the natural-key index 44k; no CHECKs 30.7k; batch 100 -> 15.5k; batch 2000 -> 64k |
| X4 | FTS5 size/time vs streaming scan | `search-bench.mjs` | FTS5 unicode61 1.54x text, 24 MB/s build; trigram 4.28x, 5.3 MB/s; scan 950-1065 MB/s (no match), 521 MB/s (frequent match), max 7 ms per 1 MiB chunk; U+0110/U+0111 matched case-insensitively |
| X5 | Express 5 SSE replay, reset, heartbeat, cleanup, slow client | `sse-proto.mjs` (port 18431, closed) | 13/13 checks with pull-based fan-out (9.6); the push-based first version failed the slow-client test |
| X6 | Zod JSON Schema, disk free on Windows, regex folding, Express query parser | `misc-probes.mjs` (port 18432, closed) | `z.toJSONSchema` draft 2020-12 with `io: 'input'`; issues give paths and codes only; `statfs` works (141.7 GB free on D:); `i` flag folds U+0110/U+0111, not U+00DF/`SS` or U+0130; Express 5 `simple` parser, repeated keys -> arrays, brackets not parsed; `z.uuid()` enforces RFC variant bits |
| X7 | Incremental vacuum | `final-ddl-check.mjs` | `auto_vacuum = 2`; delete of 150 sessions / 75k events 346-379 ms; 5,379 free pages reclaimed in 3 steps, 74-76 ms, file 32.2 -> 11.1 MB |
| X8 | Seq reservation, rollback, kind/op check, hydration plan | `seq-flow.mjs` + inline probe | seqs 1, 2 in one transaction; a rolled-back reservation leaves the head at 2; next seq 3; invalid kind/op pair refused; hydration by rowid range 0.018 ms |
| X9 | Embedded DDL equals the executed file (final schema, re-run after assembly) | `verify-doc-ddl.mjs` | equal text and sha256; executes in memory; no FK child column without a leading index |
| X10 | `PRAGMA foreign_keys` inside a transaction | `node -e` probe | `OFF` inside `BEGIN` ignored (stays 1); outside it takes effect (0) |
| X11 | Tool-call merge, first vocabulary | `toolcall-upsert.mjs` | merge shape works; superseded by X13 for the final vocabulary |
| X12 | Final schema: execution, constraints, upserts, usage two-level model, plans, throughput, backup from read-only | `ddl2-check.mjs` | sha256 of the executed LF-normalised `0001_initial.sql` of revision 1 = `b7b68fc18bc19655fe92a295817b79fef807ca71f4ebf9e0be57fb5ad0a40ebc` (superseded by X14); 28 tables, 47 indexes, FK check empty, no FK child column without an index; 10 probes behave (cursor invariant, tail beyond size, outcome without end, event without key, second `ingest_health` row, duplicate reconciliation, session in two work items, second open alert, bad change pair rejected; internal agent accepted); three-target upsert: transcript-first + hook merge (`sources 3`), redelivery and resume copy return no row; usage_files nullable max and global recompute give the `[02 6.4]` msg_C values with the older file as owner; plans covering (table 3.7, `[X12]` rows); events insert with 9 indexes 16,207 rows/s, slowest 500-row transaction 99.6 ms; backup from a read-only connection 124 ms, copy `quick_check ok` |
| X14 | Revision 2 schema (I-07 attempts tables, I-02 `.ndjson` segments, `attempt` change kind): execution, constraints, plans | `rev2/ddl3-check.mjs` (in memory, 20,000 synthetic attempt runs) | sha256 of the LF-normalised DDL embedded in 3.5 = `56cdf39902ad1e135b1d1de996a30ff72f5b604ecb9bbd96672c1d84019e25eb`; 28 own tables (30 with `sqlite_sequence` and `schema_migrations`), 52 indexes, FK check empty, no FK child column without a leading index; 19 of 19 probes behave (rejected: duplicate `path_key`, `head_len` 300, short head hash, duplicate natural key, open run not `RUNNING`, `ended` without `ended_at`, `end_offset` before start, match delta without session, unknown state, 513-code-point part, `.jsonl` segment, `attempt/delete`; accepted: source, open run, end, supersede, match, `.ndjson` segment, `attempt/upsert`); `ON CONFLICT DO NOTHING RETURNING id` gives no row for a re-read START and the new id otherwise; plans: open run by part SEARCH covering 0.047 ms, panel newest 30 0.076 ms, evidence run 0.027 ms, unmatched in window 0.112 ms, retention detach SEARCH covering 0.022 ms, source reset through the natural-key autoindex 2.7 ms for 20,000 rows, hook probe by primary key 0.012 ms; `rev2/candidates-plan.mjs`: `attemptCandidates` over 5,000 sessions SEARCH `idx_sessions_activity` with a bloom filter on the `json_each` label list, 0.057 ms |
| X13 | Final-schema turn LWW and tool outcome precedence | `upserts2.mjs` | turn: `end_turn` (rank 20) then `Stop` at the same time (rank 60) wins, older interrupt ignored, newer interrupt wins, prompt start kept; tool call: result-first, hook start, hook failure with duration wins, batch time set, late `ok` does not regress, source bits OR-ed (8 -> 9 -> 11 -> 27) |

Not measured (UNVERIFIED, plans in section 22): cold-cache scan throughput; the DDL and tests on `node:sqlite`; `@types/better-sqlite3`
coverage of `backup()`; backup consistency under concurrent writes (DA-T-E-3).

## 19. Tests that prove it

Layers: U = unit (Vitest, pure or in-memory DB), I = integration (file DB in a temp dir, server on `listen(0)`), E = E2E (Playwright,
`[04 11.4]`). All tests use temp folders (`fs.mkdtemp`), synthetic fixtures with placeholder strings, no real transcripts, no fixed ports.
File layout follows `[05 4.1]` (I-22): unit tests next to their module (`packages/<p>/src/**/<module>.test.ts`), integration tests in
`packages/<p>/test/<area>.int.test.ts`, cross-instance tests in `runtime/tests/isolation/`, privacy tests in `runtime/tests/security/`;
section 23 names the files per slice (for example `engine/src/maintenance/retention.test.ts`, `shared/src/api/routes.test.ts`).

### 19.1 Database, migrations, write paths

| Id | Guarantee | Test | Layer |
|---|---|---|---|
| DA-T-DB-1 | 0001 applies cleanly | new file through `openInstanceDb('serve')`: `user_version 1`, `application_id`, meta rows, `foreign_key_check` empty; `sqlite_schema` dump equals the committed `schema.snapshot.sql`; the file's LF-normalised sha256 equals X14 | I |
| DA-T-DB-2 | checksums verified | flip one byte of a copied migration file -> `migration_checksum_mismatch`; DB sha256 unchanged | I |
| DA-T-DB-3 | newer DB refused untouched (D13) | `user_version 99` + row 99 -> `db_newer_than_runtime` for every mode and for `peekDbSchemaVersion` consumers; sha256 unchanged; `DB_OPEN_EXIT_CODES` gives 15 | I |
| DA-T-DB-4 | explicit migration needs a backup | fixture v1 DB + a test-only `0002`: `serve` refuses `db_migration_required` (exit 16); `migrateDb({ backupDone: false })` -> `backup_required`; with `true` it applies; `planDbMigrations` lists the step | I |
| DA-T-DB-5 | failed migration rolls back | test-only `0002` with a failing statement -> version stays 1, rows intact, error `migration_failed { version }` without SQL text | I |
| DA-T-DB-6 | upgrade from every released version | table test over `test/fixtures/db/v*.db` -> latest; row counts preserved | I |
| DA-T-DB-7 | identity (DA-I3) | another `expectedInstanceId` -> `db_identity_mismatch` (exit 11); wrong `application_id` -> `db_not_mcs`; a repository call with a foreign `ctx` -> `scope_mismatch` | U |
| DA-T-DB-8 | constraints | the probes of `[exp:X1, X12]` as a table test | U |
| DA-T-DB-9 | event idempotency (DA-I5) | same `event_uid` twice -> 1 row; hook + transcript with a shared natural key -> 1 row, `sources 3`, record timestamp kept; resume copy -> no new row + one `entry_occurrences` row; `tool.failure` wins over `tool.result` on merge | U |
| DA-T-DB-10 | usage two-level model and rollups (DA-I6) | the `[02 6.4]` worked example (F1, F2, F3; msg_A, B, Z, synthetic, N, C, D, E) through `UsageRepo.applyRecord` in 200 seeded orders: `usage` rows, owners and every rollup equal the table of `[02 6.4]`; `verifyRollups()` empty after every transaction; NULL stays missing | U |
| DA-T-DB-11 | owner change and re-owning | a copy file older than the original (`birth_ms`): ownership moves, both sessions' rollups adjust; deleting the owner session in `applyRetention` re-owns the message to the remaining file | U |
| DA-T-DB-12 | tool call merge | all outcome pairs in both orders follow error > denied > interrupted > ok; `started_at` min, `ended_at`/`batch_at` max with NULLs; hook duration preferred; `open_tool_count` equals the count query (`[exp:X13]` sequence included) | U |
| DA-T-DB-13 | turn LWW | `[exp:X13]` sequence and 200 seeded permutations give the same row | U |
| DA-T-DB-14 | query plans stay indexed | seeded 50k-event fixture: `EXPLAIN QUERY PLAN` of every query in 3.7 matches a committed snapshot (no `SCAN events`, no `SCAN usage` outside verification) | I |
| DA-T-DB-15 | WAL init retry | driver stub throwing `SQLITE_BUSY` 3 times -> success; 21 times -> `db_busy`; 4 child processes opening a new file at once -> all succeed | U + I |
| DA-T-DB-16 | read-only access never writes | read-only reader: file sha256 and mtime unchanged after every query function; a write -> `db_readonly` | I |
| DA-T-DB-17 | write discipline (DA-I12) | lint rule: no `await` inside `withWriteTx` callbacks; a `withWriteTx` that throws publishes nothing | U |
| DA-T-DB-18 | driver boundary | grep test: only `src/db/driver.ts` imports `better-sqlite3`; the ESLint negative probe fails | U |
| DA-T-DB-19 | view writes | `writeView` with an unchanged view records no change; a state change writes one `state_transitions` row and one change; facts-only updates record nothing | U |
| DA-T-DB-20 | attempts storage (I-07) | the X14 probes as a table test; `insertRun` twice with the same `(source, generation, start_offset)` -> one row, second call `undefined`; `endRun`/`supersedeRun` return `false` on a run that is not open; `setMatch` never re-matches a matched run; `resetSource` deletes the source's runs, resets generation and offset and returns exactly the session row ids that had ended matched runs; a 600-code-point `part` is stored clipped to 512, an empty `model` as NULL; data retention detaches runs of deleted sessions and keeps the rows; `attemptCandidates` returns `firstRecordAtMs` from `first_ts_in_order` and the main file's `mtime_seen` | U |

### 19.2 Privacy

| Id | Guarantee | Test | Layer |
|---|---|---|---|
| DA-T-PRIV-1 | no content in the DB (DA-I2) | import fixtures whose prompts, replies, thinking, tool inputs and results carry unique sentinels (the `[02]` T-TR-16 fixtures): a full `.dump` contains none, except the bounded label column for unmatched sessions (70 code points of the first prompt, legacy parity) | I |
| DA-T-PRIV-2 | no content in metadata routes | same fixtures: responses of every route except the transcript, search and `includeContent` export contain no sentinel | I |
| DA-T-PRIV-3 | bounded text columns | inserting over-long `label`, `summary`, `detail`, `facts_json` values fails the CHECK constraints | U |
| DA-T-PRIV-4 | logs carry no request data | logger capture for a request with `q=<sentinel>` and a search -> sentinel absent | I |

### 19.3 API

| Id | Guarantee | Test | Layer |
|---|---|---|---|
| DA-T-API-1 | contracts (DA-I13) | per route: valid request -> success status and strict response parse | I |
| DA-T-API-2 | schema drift | `npm run schemas:check` passes; a changed schema without regeneration fails | U (CI) |
| DA-T-API-3 | error envelope per code | one crafted request per `ErrorCode`; meta-test: every code listed and produced | I |
| DA-T-API-4 | guards (with `[05]` SEC-02..05) | Host `evil.example`, `127.0.0.1.evil.com`, empty, `0.0.0.0`, `[::1]:<port>`, another port -> 403; `localhost:<port>`, `127.0.0.1:<port>` -> 200; bad or `null` Origin, and a Vite dev origin such as `http://localhost:5173` -> 403 (exactly two allowed values, I-31); `Sec-Fetch-Site: cross-site` -> 403; 9000-char URL -> 414; repeated key -> 400 `param_repeated`; `OPTIONS` -> 405 without CORS headers; any `POST` other than the nudge -> 404/405 | I |
| DA-T-API-5 | nudge | valid body -> 204 and a drain is scheduled; with `Origin` -> 403; 257-byte body -> 413; `text/plain` -> 415; another instance id -> 409 | I |
| DA-T-API-6 | keyset pagination | walk all pages of sessions (every sort/dir) and events while inserting rows between requests: no duplicates, no gaps among rows that existed at the first page, total order respected; changed filter with an old cursor -> `cursor_invalid`; frozen window | I |
| DA-T-API-7 | filter model | each filter alone and pairwise on a fixture with known answers; `fromQuery(toQuery(f))` round trip (seeded); `matchesEventFilter` agrees with SQL on 1,000 random filters | U + I |
| DA-T-API-8 | missing vs zero (DA-I9) | session without assistant records -> token fields `null`, `turns 0`; zero-usage messages -> `0`; a field missing in every message -> `null` with `missing` = turns | I |
| DA-T-API-9 | bounded expensive queries | event `q` over 8 days without `session` -> `filter_requires_scope`; 7-day `q` on 60k events sets `scanCapped` | I |
| DA-T-API-10 | headers | every `/api` response has `no-store`, `nosniff`, `X-MCS-Instance`, `X-Request-Id` | I |
| DA-T-API-11 | legacy health parity (I-30) | `GET /api/health` parses with `LegacyHealthSchema` and its key set equals exactly the 13 keys of 6.2; the keys read by the legacy status reader, extracted by a regex over `src/backend/cli.py` (`h\['(\w+)'\]` and `h\.get\('(\w+)'\)` on the lines that read the health body), are a subset of that key set (today `pid`, `uptime`, `code_stamp`, `task`, `config_source`, `errors`, `reader`); with Python 3 available, the legacy `instance_alive()` run against the server returns alive and legacy `status` fails on `/api/sessions` (HTTP 404), never with a `KeyError` | I |
| DA-T-API-12 | asOfSeq consistency (DA-I8) | under concurrent writes every snapshot's `asOfSeq` <= the head after the response, and every entity `seq <= asOfSeq` | I |
| DA-T-API-13 | ingest health route | `/health/ingest` equals the last `ingest_health.report_json` with `asOfSeq`; `HealthReport.ingestion` equals the `[02 8.2]` projection on table-driven inputs | U + I |
| DA-T-API-14 | probe route (I-37) | a drained probe envelope -> `200 { receivedAt, committedAt }` with `committedAt >= receivedAt`; an unknown probe id -> `404 probe_not_found`; a non-probe session id or an uppercase probe id -> `400 validation_failed`; no session, event or counter changes; a row older than 24 h is gone after bookkeeping retention | I |
| DA-T-API-15 | completion route (I-08) | for each `[02 7.13]` fixture target (`[01]` T-CLI-08 fixtures over S-1, S-3, S-4, S-8e) the route body equals `EngineQueries.explainCompletion` and the `DbReader` result; none or two of `session`/`label`/`attemptPart` -> 400; a malformed session id (`target_invalid`) -> `400 validation_failed`; an unknown label or part -> `404 completion_target_not_found` and the `DbReader` throws `CompletionTargetError('target_not_found')`; `attemptPart=` (empty) is accepted and a 513-character part is refused; the body parses with `CompletionEvidenceSchema` including `resolvedBy`, `candidates` and `sessionId: null` for an unmatched ended row (CE-12); records `EXPLAIN QUERY PLAN` and time of the label and part lookups at 5,000 sessions / 20,000 runs (O-5) | I |
| DA-T-API-17 | audit references (I-19) | `EngineQueries.getSession` returns `auditRefs: []` synchronously; the route and the `DbReader` return the entries of a fixture `audit/changes.md` and `decisions.md` inside the session window (<= 10, newest first) identically; an `entriesBetween` stub that rejects gives `auditRefs: []` and `200` | U + I |
| DA-T-API-16 | health resources (I-21) | `HealthReport` parses; `runtime.rssBytes` and `heapUsedBytes` > 0; `cpuUserMicros` does not decrease across two calls; `children` has every `ChildKind` key; `panels` equals the stubbed `PanelService.stats()` | U + I |

### 19.4 Realtime

| Id | Guarantee | Test | Layer |
|---|---|---|---|
| DA-T-RT-1 | persist before publish (DA-I7) | throw after `reserve()` inside `withWriteTx` -> no frame ever, head unchanged; for every received frame, `GET` of its entity returns `seq >= frame.seq` | I |
| DA-T-RT-2 | replay | `Last-Event-ID: n` -> frames `n+1..head` exactly once in order; `since` used without the header; header wins when both | I |
| DA-T-RT-3 | reset reasons | pruned cursor, cursor ahead, foreign epoch, garbage, > 2000 behind -> `reset` with the reason and `id = head` | I |
| DA-T-RT-4 | heartbeat | named `heartbeat` every `heartbeatMs` (fake timers) with `headSeq` and `epoch` | U |
| DA-T-RT-5 | disconnect cleanup | abort 6 clients -> client set empty, timers cleared, `process.getActiveResourcesInfo()` back to baseline | I |
| DA-T-RT-6 | slow client | paused socket evicted after the stall timeout with < 64 KiB buffered; a concurrent fast client receives every frame | I |
| DA-T-RT-7 | coalescing | one transaction touching one session 1,000 times and appending 1,000 events -> exactly 2 change rows; the frame has `count 1000`, `truncated true`, 50 items | U |
| DA-T-RT-8 | epoch per process | restart the server: `hello.epoch` differs; a client sending the old epoch gets `reset(epoch_changed)` | I |
| DA-T-RT-9 | stream limit | 17th stream -> `503 stream_limit` | I |
| DA-T-RT-10 | deleted entity frame | change for a session deleted before hydration -> `data: null`, no seq gap | U |
| DA-T-RT-11 | ChangeSink mapping | each `[02]` entity passed to `record()` produces the change kind of the 9.1 table; activity-only session updates are throttled to 1 per second; view changes are immediate | U |
| DA-T-RT-12 | browser reconnect (brief 14 E2E 9, 13, 14) | Playwright: stop and start the runtime; the page shows reconnecting, then live; data reconciled without duplicates (spec owned by `[04 11.4]`) | E |
| DA-T-RT-13 | attempt changes (I-07) | an attempts transaction that inserts 3 runs and ends 1 writes exactly one `attempt/upsert` change whose payload ids are the 4 rows and whose seq equals their `updated_seq`; a config reset -> `truncated true`; the frame carries `{ ids, truncated }` without a DB read | U |

### 19.5 Search and transcript access

| Id | Guarantee | Test | Layer |
|---|---|---|---|
| DA-T-S-1 | coverage honesty | one missing file -> `filesMissing 1`, `complete false`, note names it; tiny budget -> `stoppedBy time_budget` + `continuation`; union of continued pages equals the one-shot result | I |
| DA-T-S-2 | correctness | results equal a naive full-parse reference search on fixtures for 200 seeded queries (kinds, `tool`, `errors`) | I |
| DA-T-S-3 | escaping | needles with `"`, `\`, non-ASCII, emoji; files with raw UTF-8 and with `\uXXXX` escapes -> same matches | U |
| DA-T-S-4 | path containment | a file row whose real path leaves the transcripts root is skipped and counted unreadable | I |
| DA-T-S-5 | event-loop slices | 100 MB synthetic scan: max delay between event-loop turns < 20 ms | I |
| DA-T-S-6 | cancellation and concurrency | client abort stops the scan within one block and frees the semaphore; a third concurrent search -> `429 search_busy` | I |
| DA-T-S-7 | entry indexes | `countEntries` equals `displayEntries(...).length` on all fixture records; checkpoint indexes equal a full count at random positions; window and locate (`i`, `ts`, `offset`) equal a reference implementation; golden entries vs the Python `events_of` | U + I |
| DA-T-S-8 | independent of import order | the importer reads head, tail, backfill `[02 5.5]`; entry indexes from the transcript service are identical to a sequential count | I |
| DA-T-S-9 | file replacement | replaced file (different head) -> index reset, window `total 0` | I |
| DA-T-S-10 | instance isolation of search (brief 4, `[01]` T-ISO-11) | two instances with disjoint fixture transcripts: A's search never returns B's text; coverage counts only A's files | I |

### 19.6 Analytics

| Id | Guarantee | Test | Layer |
|---|---|---|---|
| DA-T-A-1 | totals | `[02 6.4]` worked example: `usage()` per session, model and instance equals the expected table (S1 total 24 / 970 / 972,372 / 5,200; instance 30 / 1,040 / 979,372 / 5,700) | I |
| DA-T-A-2 | projection | completeness, `scannedPct` (minimum over files), `lowerBound`, per-field `null` per 8.2 on table-driven inputs | U |
| DA-T-A-3 | buckets | hour and day with offsets -480, 0, +420: sum of buckets = totals; empty buckets absent; > 2000 buckets -> `range_too_large` | U |
| DA-T-A-4 | cost | no pricing -> `null`; longest glob wins; `effectiveFrom` by message day; unpriced model listed and excluded; split missing -> `assumedCacheWriteTier`; synthetic never priced; reported cost never added | U |
| DA-T-A-5 | tool frequency | counts per derived status equal `tool_calls`; pending never failed; median over finished durations | U |
| DA-T-A-6 | metric catalogue | every key of 8.1 has `source` and `rule`; state tiles equal `listSessions` counts with the same filters | I |
| DA-T-A-7 | usage isolation (brief 4, `[01]` T-ISO-09) | two instances over overlapping fixture files: each total equals its own scope only | I |

### 19.7 Alerts

| Id | Guarantee | Test | Layer |
|---|---|---|---|
| DA-T-AL-1 | one open alert per rule and scope | condition held for 5 sweeps -> 1 row, `fire_count 5`, 1 change; clears -> resolved + 1 change; holds again inside the cooldown -> nothing; after it -> a new row | U |
| DA-T-AL-2 | never breaks ingestion | evaluator throws -> the ingest transaction committed, `ingest_errors` row with `source 'alerts'` | I |
| DA-T-AL-3 | token threshold on lower bounds | fires only when the lower-bound total reaches the threshold | U |
| DA-T-AL-4 | runtime unavailable | a `runtime_unavailable` reconciliation -> one alert; expires after `expireHours` (`resolved`, `expired`) | I |
| DA-T-AL-5 | per-rule conditions | table tests for every rule's holds/clears/severity boundaries, including `hook_gap` from coverage and `import_lag`/`hook_failing`/`db_disk` from `IngestHealth` inputs | U |

### 19.8 Export, backup, retention

| Id | Guarantee | Test | Layer |
|---|---|---|---|
| DA-T-E-1 | export format | every line validates against its export schema; trailer counts and sha256 match; no sentinel without `includeContent`; `strict` removes the listed fields and refuses `includeContent` | I |
| DA-T-E-2 | export isolation | instance A's export contains no row of B; the temporary snapshot is deleted (also when the client aborts) | I |
| DA-T-E-3 | backup consistency | `backupDb` from the writer during concurrent ingestion and from a read-only connection: `quick_check ok`, identity ok, row counts equal the source at a consistent point | I |
| DA-T-E-4 | data retention safety | dry run changes nothing (sha256); apply deletes exactly the planned sessions; active and pinned sessions never deleted; retired files are not re-imported; re-owned messages keep totals of the other session correct | I |
| DA-T-E-5 | bookkeeping retention scope | an automatic run changes only `changes`, `ingest_errors`, resolved alerts, instance reconciliations, `hook_probes` older than 24 h and orphan rows of retired files (never `attempt_runs`) | I |
| DA-T-E-6 | crash isolation (brief 4) | two instances; kill -9 instance A during ingestion; restart A; B's DB `quick_check ok` and unchanged sha256; A recovers from its cursors | I |

### 19.9 Readers

| Id | Guarantee | Test | Layer |
|---|---|---|---|
| DA-T-CLI-1 | same JSON from `ApiReader` and `DbReader` (DA-I13) | every `InstanceReader` method of 12.2 in both modes on one fixture -> identical JSON except `asOfSeq` and time-relative fields (joint with `[01]` T-CLI-05) | I |

## 20. Dependencies on other documents (assumed shapes)

| Id | Owner | What this document assumes |
|---|---|---|
| A-1 | `[02]` lifecycle | the `LifecycleView` fields and enums of `[02 7.1]` (stored as in 3.5); `facts_json` sizes within the caps (sessions 64 KiB, agents and runs 16 KiB); `viewChanged` and `renderEvidence(item, now)` exported from `engine/src/lifecycle/rules.ts`, `toLegacy()` from `lifecycle/legacy.ts` (I-33); `explainCompletion(lookup, target, now)` with `CompletionLookup`, `CompletionTarget` and `CompletionTargetError('target_invalid' | 'target_not_found')` (no `null` result), `attemptPart` 0..512, result typed as the `z.infer` of `CompletionEvidenceSchema` (6.3) (`[02 7.13]`, I-08, C16, C17); `ChangeSink.record` entity `event` for hook and transcript rows (`[02 4.6]`, N-08); board derivation `[02 7.11]` writes `work_items` with `rule` and `board_reason` |
| A-2 | `[02]` ingestion | writes through `withWriteTx` + `createChangeSink` and the repositories of 4.5 with the statements and natural keys of 3.6; `TranscriptFilesRepo.updateCursors` for cursor moves; reconciliations through `ReconciliationsRepo`; stores the values of the normative stored-kind table of 3.6 (I-03: `[02 4.1, 4.3, 5.6]` carry the same values; no longer an assumption); writes probe rows through `HookProbesRepo` in the drain transaction |
| A-3 | `[02]` hooks | nudge body and behaviour of `[02 2.8]` (no longer an assumption: adopted in 5.2) |
| A-4 | `[01]` instances/ops | the composition root of `[01 4.4a]` (I-15): `InstanceContext` (`instanceId, repoDir, config, clock, db, errors, exec` plus `claudeHome, mcsHome, logger, queries`) and `createInstanceRuntime(ctx)` -> `{ start(), stop(deadlineMs), ingestUntilIdle({ timeoutMs }), health() }`, which opens the DB with `openInstanceDb('serve')`, maps errors with `DB_OPEN_EXIT_CODES`, builds `ctx.queries` with `createQueries` and all six deps (12.1, C09), starts and stops `createDbScheduler(ctx)`, and runs `backupDb` for the control op `backup`; `mcs start` uses `peekDbSchemaVersion`; `upgrade`/`db migrate` use `planDbMigrations`/`migrateDb` after their backup; `cleanup --scope data` uses `applyRetention`; `commands` strings for `InstanceInfo` (`[01 6.6]`); `outdated` per `[01 5.3]`; graceful shutdown `[01 4.5]`; the bound port is passed to the Host guard |
| A-5 | `[01]` config | composes the sections `retention`, `alerts`, `pricing` and `analytics` (`{ usageTrend: boolean }`, default false) owned here, each `strictObject().prefault({})` (I-01); no `server.devOrigins` (I-31); legacy keys read here: `window_hours`, `include_unmatched`, `session_ids`, `poll.stale_after_ms`, `limits.text_chars`, `panels`, `ui`; `ConfigInspection` (`shared/src/cli/results.ts`, I-20) behind `GET /config` |
| A-6 | `[06]` panels | `PanelResponseSchema`, `AttemptState`, `ChildKind`, `ChildKindStats`, `PanelStats` exported from `shared/src/api/panels.ts` (I-35, I-21); `pathKey()` in `platform/paths.ts`; the attempts tick writes only through `AttemptsRepo` inside one `withWriteTx` and submits its 02 events to the writer after COMMIT (N-01); 06 3.10 uses the table names of 3.5 and points to 3.5/3.6 instead of a copy of the DDL (I-07, N-10) |
| A-7 | `[01]` audit | `entriesBetween(ws, fromMs, toMs, limit): Promise<AuditRef[]>` with `AuditRef = { file, at: ISO, title, summary }` (`[01 7.1]`, I-19) over `audit/changes.md` and `decisions.md` (`## <ts> \| <title>` headers, the legacy split rule, universal newlines) for `SessionDetail.auditRefs` |
| A-8 | `[04]` UI | adapts the rows marked "adapt" in 15.1 by importing the contracts from `@mcs/shared` (I-10) |
| A-9 | testkit (`[04 11.5]`, `[02]` fixtures) | synthetic transcripts and envelopes with sentinels, the `[02 6.4]` worked example files |
| A-10 | `[02]` constants and probes | `SPOOL_SEGMENT_EXT = '.ndjson'` (`shared/src/protocol/hook-envelope.ts`, I-02); `MAX_LINE_BYTES` (`shared/src/protocol/limits.ts`, I-32); the probe prefix rule of `[02 2.2]` step 9; probe rows written in the drain transaction |

## 21. Requirements covered

- Brief 7 (data model and persistence): every listed entity (instances via `meta`, projects, tasks as work items, sessions, agents,
  events, transcript references, token usage, pricing via config, ingestion health, alerts, schema migrations) in 3.5; parameterized
  queries (3.6); foreign keys enabled and verified (3.2, DA-T-DB-1/8); transactions (3.6, 4.5); WAL (3.2); migrations with rollback and
  recovery guidance (4); retention and cleanup (3.8, 11.3); export and backup explicit (11.1, 4.4); no destructive migration without a
  backup (4.3); no secrets stored (3.1); no unbounded in-memory transcript copy (7.2-7.4); the DB is the source of truth, stream messages
  are notifications (9).
- Brief 8.1 overview metrics with source and rule (8.1), ingestion health and last timestamps (6.2). 8.2 explorer API (5.3-5.5, 6.1).
  8.3 detail API: metadata, state, hierarchy, timeline, tool executions, notifications, lifecycle transitions, transcript context, usage,
  errors, audit references (6.1, 7.3). 8.4 feed API: type/session/project filters, cursor history, live tail, error severity, details,
  gaps (`monitor.gap`) (5.3, 6.1, 3.6). 8.5 typed filter model, metadata vs transcript search, honest coverage, limits, cancellation
  (5.4, 6.4, 7). 8.6 work-item storage and API with evidence (3.5, 6.1). 8.7 analytics: categories, per session/project/model, over time,
  tool frequency, optional cost, source and schema, compaction, duplicates, missing vs zero, estimate vs provider-reported, no
  hook/transcript double counting, trends gated (8). 8.8 alerts (10). 8.10 configuration inspection, health, export, backup and
  retention functions, version information (6.1, 6.2, 11).
- Brief 10: snapshot then subscribe, persist before publish, message identity/scope/timestamp, reconciliation without duplicates,
  cursor resume or reset, stale visibility support, connectivity separate from ingestion, heartbeats, validation, bounded buffers,
  cleanup (9).
- Brief 11: versioning, schemas, error structure, pagination, filter and sort semantics, time and id formats, ownership and access
  boundaries, runtime validation, generated documentation, no duplicated logic across API, CLI and UI (5, 6, 12, 13).
- Brief 12 (API parts): section 14.
- Brief 4 isolation tests owned here: DA-T-S-10, DA-T-A-7, DA-T-E-2, DA-T-E-6, DA-T-DB-7.
- Brief 5 idempotency at the storage level (DA-I5, DA-T-DB-9..13). Brief 14 unit/integration items: schema validation, token aggregation,
  deduplication, filtering, retention, DB to API, persistence before broadcast, realtime reconnect (19).
- Matrix rows closed by revision 2: R-7.E.13 attempts as a persisted entity (3.5 `attempt_sources`/`attempt_runs`, 3.6 `AttemptsRepo`,
  9.1 `attempt/upsert`; I-07); R-8.3.11 project/task audit references in session detail (6.3 `auditRefs` over `[01 7.1]`
  `entriesBetween`; I-19); R-8.9.9 verify task completion evidence (route and query `explainCompletion` over `[02 7.13]` with a `CompletionLookup`; I-08); brief
  13 fallback: the legacy CLI recognizes a running Node instance (6.2, I-30); brief 8.10 hook verification round trip (`ingestProbe`,
  I-37); brief 12 Origin validation without configurable exceptions (5.2, I-31).
- Foundations: D2 (C-1), D3 (data layout), D7 (one driver module), D8 (tokens from transcripts, dedupe), D9 (state columns, transitions),
  D10 (all), D11 (C-2), D13 (refusal of newer DB, explicit upgrade), D14 (scope columns, work items), D15 (no webhooks, no shipped prices).

## 22. Open items

- O-1 Cold-cache scan throughput is UNVERIFIED (all scan numbers are warm-cache). Plan: slice S8 measures a scan of a generated file
  larger than the free RAM and records it in ADR 0023; below 200 MB/s the default `budgetMs` rises to 5000 and the UI copy says first
  searches may take longer.
- O-2 `node:sqlite` with this DDL is not exercised. Plan: slice S1 runs the DB suite against a `node:sqlite` driver variant once the Node
  floor reaches 24.15 (D7); until then better-sqlite3 is the only driver.
- O-3 `@types/better-sqlite3@9.6.0` coverage of `backup()` against 13.0.3 is UNVERIFIED. Plan: slice S1 compiles `driver.ts`; a missing
  declaration goes into a local module augmentation in that file.
- O-4 Cross-design confirmations. This document is final on its side; each item is specified on the other side by the critic's fix and
  is checked by the lead when Phase 1 closes (grep of the six designs for the names in 15.2-15.5): (a) `[02]` 4.1/4.3/5.6 carry the
  stored-kind column equal to 3.6 (I-03), `[02 4.6]` records entity `event` (N-08) and `[02 7.13]` step 1 accepts `attemptPart` 0..512
  (I-08, C17); (b) `[01]` defines
  `InstanceContext`/`createInstanceRuntime` (4.4a, passing the six `createQueries` deps), `entriesBetween` (7.1), `ConfigInspection` and
  the `analytics` section (I-01, I-15, I-19, I-20), and types `InstanceReader.errors` as `ErrorItem[]` (6.1, N-08, C21); (c) `[04]` imports the contracts (I-10); (d) `[06]` uses the attempts names of 3.5, writes through `AttemptsRepo`, and
  exports `pathKey`, `ChildKind`, `ChildKindStats`, `PanelStats` from the paths of A-6 (I-07, I-21, I-35). No fallback is needed: `0001`
  contains the single `events` table and the attempts tables.
- O-5 Completion lookups by label and by attempt part scan `sessions` and `attempt_runs` (no index on `label` or on `part` across
  generations; the route is operator-triggered). UNVERIFIED time. Plan: slice S5b measures them in DA-T-API-15 at 5,000 sessions and
  20,000 runs; above 5 ms a later migration adds `idx_sessions_label` / `idx_attempt_runs_part` (0001 stays frozen).

## 23. Phase 2+ task slices (dependency order; each independently testable)

Order inside the cross-design plan of `99-requirements-matrix.md` section 3: S3 -> S1 (with I-03 and I-07, so `0001` is frozen once) ->
S2 -> `[01]` S8 (server shell and composition root, I-15) -> S4, S5 -> S6, S7 -> S5b (after `[02]` I-7b) -> S8 .. S11 -> S12 (after `[01]`
S13a/S13b) -> S13. Test file names follow `[05 4.1]` (section 19 intro).

| Slice | Phase | Depends on | Owns (paths under `runtime/`) | Done when |
|---|---|---|---|---|
| S1 DB core | 2 | `[05]` S1 scaffold, `[01]` S1 shared contracts | `packages/engine/migrations/0001_initial.sql` (as in 3.5, including the attempts tables; committed with the X14 checksum and frozen from then on), `packages/engine/src/db/{driver,errors,open,migrations,backup,write,changes}.ts`, `packages/shared/src/db-constants.ts`; tests `packages/engine/src/db/{driver,migrations,write,changes}.test.ts`, `packages/engine/test/db-{migrations,open,constraints,backup}.int.test.ts`, `packages/engine/test/fixtures/db/schema.snapshot.sql` | DA-T-DB-1..8, 15..18, the X14 probes of DA-T-DB-20 and DA-T-E-3 pass; O-2/O-3 checked |
| S2 Repositories and change sink | 2 | S1 | `packages/engine/src/db/repos/*.ts` (including `attempts.ts` with `runsByPart`, and `SessionsRepo.attemptCandidates`, `uidsByRowIds`, `completionCandidates`), `packages/engine/src/db/change-sink.ts`; tests `packages/engine/src/db/repos/*.test.ts`, `packages/engine/src/db/change-sink.test.ts` | DA-T-DB-9..13, 19, 20, DA-T-RT-7, 11, 13, DA-T-PRIV-3 pass |
| S3 Shared API contracts | 2 | `[05]` S1 (parallel with S1) | `packages/shared/src/api/{ids,time,errors,filters,cursor,entities,health,legacy-health,stream,export,routes}.ts` (the `panel` route row lands with `[06]`'s `panels.ts`), the API part of `scripts/gen-schemas.mjs` (registry C45), `schemas/api/**`, `schemas/export/**`, `docs/api/reference.md` (generated); tests `packages/shared/src/api/{routes,filters,cursor}.test.ts` | DA-T-API-2 and the round trip of DA-T-API-7 pass |
| S4 Server skeleton and meta routes | 2 | S1-S3, `[01]` S8 (server shell, `createInstanceRuntime`, I-15), `[05]` S6 (owns `packages/server/src/http/guards.ts`; error codes from 5.2) | `packages/server/src/{app,errors,route-adapter}.ts`, `packages/server/src/routes/{meta,ingest}.ts` (`legacyHealth`, `health`, `healthIngest`, `instance`, `config`, `ingestNudge`, `ingestProbe`), `packages/engine/src/query/health.ts`; tests `packages/server/test/{meta,ingest,errors-envelope}.int.test.ts` | DA-T-API-3, 4, 5, 10, 11, 13, 14, 16 pass |
| S5 Query layer and read routes | 2-3 | S2, S4 | `packages/engine/src/query/**` (except transcript, search, analytics, completion), `packages/server/src/routes/{sessions,agents,events,tool-calls,work-items,overview,alerts,errors}.ts`; tests `packages/engine/src/query/*.test.ts`, `packages/server/test/contract/*.int.test.ts` | DA-T-API-1, 6, 7, 8, 9, 12, 17, DA-T-DB-14 pass |
| S5b Completion route | 3 | S5, `[02]` I-7b (`explainCompletion`) | `packages/shared/src/api/completion.ts`, `packages/engine/src/query/completion.ts`, `packages/server/src/routes/completion.ts`; test `packages/server/test/completion.int.test.ts` | DA-T-API-15 passes; O-5 measured |
| S6 Stream | 3 | S5 | `packages/server/src/stream/{hub,hydrate,sse}.ts`; tests `packages/server/src/stream/hub.test.ts`, `packages/server/test/stream-*.int.test.ts` | DA-T-RT-1..6, 8..10 pass |
| S7 Transcript entries, index, window, locate | 3 | S2 (`[02]` `readEntryText` then imports `entries.ts`) | `packages/engine/src/transcript/{entries,index-service,window}.ts`, `packages/server/src/routes/transcript.ts`; tests `packages/engine/src/transcript/*.test.ts`, `packages/engine/test/transcript-window.int.test.ts` | DA-T-S-7, 8, 9 pass |
| S8 Search | 5 (4 if the lead keeps transcript search in the Phase 4 smoke, `99` section 3) | S7 | `packages/engine/src/search/{scan,service}.ts`, `packages/server/src/routes/search.ts`; tests `packages/engine/src/search/scan.test.ts`, `packages/engine/test/search.int.test.ts` | DA-T-S-1..6, 10 pass; O-1 measured |
| S9 Analytics and cost | 5 | S5 | `packages/engine/src/analytics/{usage,series,tools,cost,metrics}.ts`, `packages/server/src/routes/analytics.ts`; tests `packages/engine/src/analytics/*.test.ts`, `packages/engine/test/analytics.int.test.ts` | DA-T-A-1..7 pass |
| S10 Alerts | 5 | S5, S6, `[02]` health | `packages/engine/src/alerts/{rules,evaluator,service}.ts`; tests `packages/engine/src/alerts/*.test.ts`, `packages/engine/test/alerts.int.test.ts` | DA-T-AL-1..5 pass |
| S11 Export, retention, schedule | 5 | S5, S7, `[01]` S8 (the runtime starts `createDbScheduler`) | `packages/engine/src/maintenance/{export,retention,schedule}.ts`, `packages/server/src/routes/export.ts`; tests `packages/engine/src/maintenance/{retention,schedule}.test.ts`, `packages/engine/test/maintenance-{export,retention}.int.test.ts` | DA-T-E-1, 2, 4, 5 pass |
| S12 Reader integration | 5 | S5-S11, `[01]` S13a (readers over S5 queries) and S13b (`verify-completion`, after `[02]` I-7b) | `packages/engine/src/query/index.ts` exports used by `[01]` `reader/{api-reader,db-reader}.ts`; test `packages/engine/test/readers.int.test.ts` | DA-T-CLI-1 passes |
| S13 Privacy and isolation suite | 6 | S5-S12, testkit | `runtime/tests/security/data-privacy.test.ts`, `runtime/tests/isolation/data-*.test.ts` | DA-T-PRIV-1, 2, 4, DA-T-E-6 and the brief 4 tests of section 21 pass |
