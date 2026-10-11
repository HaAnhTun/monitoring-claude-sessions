# Foundations: fixed decisions for the V3 migration

Status: input to Phase 1 (design). Written by the lead on 2026-10-11 from the Phase 0 research in `docs/research/`.
Designers may CHALLENGE any item below, but only with evidence, in a section named `CHALLENGES`; silent deviation is not allowed.

## 0. Mission in one paragraph
`monitoring-claude-sessions` stays a **skill** (agent-facing instructions + deterministic CLI). It gains a versioned
**runtime** (Node.js + TypeScript server with SQLite, hooks-first ingestion with transcript recovery) and a **data-driven React UI**.
The Python engine (`template/viewer.py`, `src/backend`, `src/frontend`, `config/defaults.json`) is the **legacy fallback**: it keeps working
untouched (a live V9 monitor runs from it) until the new runtime passes the regression checks.

## 1. Hard constraints (from the owner's brief, MEGA-PROMT-V3, and from the live environment)
- C1. The legacy files above are **read-only** for this migration. No edits to `src/`, `template/`, `config/defaults.json`, existing `docs/*.md`, `reference/`, existing `tests/`. (A live monitor serves them; `code_stamp` and the page would change.)
- C2. English-only code, comments, docs, logs, tests. No private data (prompts, source, tokens, emails) in code, fixtures, docs, logs.
- C3. Never install hooks into real settings during development or tests. Hook tests use temp dirs and `--settings` files. The installer is a user-run, consent-gated command. Hook config reloads live, so an install affects running sessions.
- C4. No commits by agents. The lead commits per phase on branch `feat/v3-node-runtime` (tag `pre-v3-python` = old state).
- C5. Never claim a check passed unless it ran. Fixtures are labelled as fixtures. No fabricated metrics in production views.
- C6. Bind 127.0.0.1 only; validate Host and Origin; transcript content is untrusted data; monitoring failures never block Claude Code.

## 2. Product layers
| Layer | Responsibility | Lives in |
|---|---|---|
| A. Skill + lifecycle | SKILL.md procedure, CLI (`mcs`): discover, init, inspect, configure, decide, audit, check, start, stop, restart, status, verify, doctor, upgrade, hooks install/verify/uninstall, export/backup, cleanup, migrate | `SKILL.md`, `scripts/mcs.mjs` (launcher), `runtime/packages/cli` |
| B. Runtime | ingestion (hook spool + transcript import), lifecycle engine, SQLite persistence, API v3, SSE, analytics, search, alerts, panels (machine/git/logs/ledger/attempts) | `runtime/packages/engine`, `runtime/packages/server` |
| C. UI | React SPA, typed API client, no per-session markup | `runtime/packages/web` |

## 3. Decisions

**D1. Repository layout (additive).** New top-level folders next to the legacy ones:
```
SKILL.md                          rewritten to the new procedure (legacy section kept)
scripts/mcs.mjs                   zero-dependency launcher: checks Node, bootstraps (npm ci + build, stamped), execs the CLI
runtime/                          npm workspace (the "template"); package.json, package-lock.json, .npmrc, tsconfig*, eslint.config.js, prettier, vitest
  packages/shared/                isomorphic contracts: zod schemas, types, constants, ids, error codes. No node:* imports. A `protocol` sub-entry is zod-free (used by the hook handler).
  packages/engine/                Node-only domain: config, workspace/instances, db + migrations + repositories, ingest (spool, transcript importer), lifecycle, tokens, search, analytics, alerts, panels
  packages/server/                Express 5 app, SSE, static hosting of web build, process main (one instance per process)
  packages/cli/                   `mcs` commands, hook handler (`hook.js`), optional read-only MCP server
  packages/web/                   React + Vite SPA
schemas/                          generated JSON Schemas (config, API) for agents and docs
docs/design/  docs/decisions/     design docs and ADRs (final docs are assembled in Phase 6)
tests/legacy-parity/              golden-file and cross-engine tests (the Python engine stays the oracle)
```
Existing `docs/*.md` are legacy-engine docs; in Phase 6 they move (git mv) to `docs/legacy/` and the new platform docs take their names (the owner's required doc list, lowercase-kebab because the repo convention is lowercase).

**D2. Isolation model: one OS process per monitoring instance (= task workspace), one SQLite DB per instance, one shared built runtime.** Not one process per session. Rationale: stop/restart independence, blast radius of corruption, trivial ownership; cost is about one small Node process per task. Every query is also scoped by `instance_id` (defence in depth) and the DB records its `instance_id` in `meta`; the server refuses to open a DB whose identity differs from its workspace.

**D3. Instance workspace = the existing task workspace**, `<repo>/.claude/monitor/tasks/<slug>/`, extended compatibly:
```
task.json        legacy identity (unchanged format)          config.json   legacy overrides, schema_version 1 (unchanged; shared with legacy engine)
instance.json    NEW, Node-owned: instanceId (uuid v4), runtimeVersion, createdAt, dbSchemaVersion, engine ("node"|"legacy"), hooks {enabled}
runtime.json     NEW, Node-owned overrides (ingest, retention, pricing, alerts, port, logLevel...), own schema_version
state.json       runtime-only (pid, port, url, started, engine, instanceId, runtimeVersion, codeStamp) - same field names as legacy plus new ones
data/monitor.db (+ -wal/-shm)   data/spool/*.jsonl (hook write-ahead log)   data/backups/
logs/runtime.log (+ rotated)    audit/changes.md, audit/decisions.md  (append-only, legacy-compatible format)
```
Node-only data NEVER goes into `config.json` (the legacy strict validator would refuse to start and block rollback).

**D4. Configuration precedence (deterministic, documented):** 1 built-in defaults (code) -> 2 skill defaults (`config/defaults.json` + `runtime/defaults.json`) -> 3 instance (`config.json`, then `runtime.json`) -> 4 explicit CLI overrides. Environment variables apply only where documented (`MCS_LOG_LEVEL`, `MCS_HOOK_DISABLE`, `MCS_HOME` for tests) and sit between 3 and 4. Merge rule identical to the legacy rule for `panels|ui|poll|limits` (per sub-key), replace for everything else. `inspect` prints provenance per key (`builtin|skill|config|runtime|env|cli`). Versioned schemas; refusing unknown/missing/higher versions; no silent migration; explicit `mcs config migrate` writes a backup first.

**D5. Regex dialect.** Existing configs use Python regex syntax (`(?P<name>..)`, `{1}` substitution). The loader keeps the Python-syntax text as the stored form and translates to JS RegExp at load via a documented, tested translator (named groups, leading inline flags, `\A`, `\Z`, `$` semantics, Unicode `\w \d`); a pattern is accepted only if translation is exact; unsupported constructs fail loudly at validation. The live V9 task regexes are the first golden test.

**D6. Launcher and build.** `scripts/mcs.mjs` (plain ESM, zero deps) is the stable entry: `node .claude/skills/monitoring-claude-sessions/scripts/mcs.mjs <command>` (call it `$MCS`). It verifies the Node floor, and if `runtime/packages/*/dist` is missing or stale (stamp of lockfile + sources), runs `npm ci` + build once with clear output. `.npmrc`: `ignore-scripts=true`, `save-exact=true`. `dist/` and `node_modules/` are gitignored. Shipped code is compiled with `tsc`; native type stripping is dev-only.

**D7. Stack (pinned by the Phase 0 smoke test; see `docs/research/stack-versions.md` section 8).** Node floor 22.12 runtime / targets 24 and 26; TypeScript 6.0.3 (TS 7 has no API for typescript-eslint yet); better-sqlite3 13.0.3 behind ONE repository module (WAL init once with BUSY retry; fallback `node:sqlite` when the floor is >= 24.15); Express 5.3.0; Zod 4.6.5; in-house JSON logger with a field allow-list (never log prompts, queries, tokens); SSE (not WebSocket); React 19.3.0, Vite 8.3.4, React Router 8.4.0 declarative, TanStack Query 5.104.1, lucide-react, plain CSS custom properties (tokens ported from the legacy UI), Vitest 5.0.3 + happy-dom + Testing Library, ESLint 10.12 flat + typescript-eslint 8.71.1 + react-hooks + jsx-a11y (npm `overrides`), Prettier 3.9.10, Playwright 1.64 via `channel: "chrome"` for E2E. The research file's avoid list stands (no ws, axios, dotenv, commander, uuid, lodash, cors, jsdom, tailwind...).

**D8. Data collection: hooks first, transcripts as recovery AND as the source of truth for usage.**
- A single zero-dependency hook handler (`node <abs>/hook.js`, exec form, short timeout, no stdout, always exit 0, global try/catch) stamps `event_uid` + `received_at`, drops or summarises large and sensitive fields (keep lengths + hashes), appends one envelope line to each matching instance spool (`data/spool/`), then best-effort POSTs to the instance with a ~300 ms timeout. The spool is the write-ahead log; the server drains it (offset in DB) at start and on each POST, so delivery is at-least-once and idempotent.
- Hooks carry NO token usage. Tokens come only from transcripts (dedupe by `message.id` across ALL files of an instance, per-field max, `iterations[0]` fallback, subagent output flagged as a lower bound). Double counting between hooks and transcripts is impossible because hooks contribute zero tokens.
- Hook payloads have no unique id: idempotency = handler `event_uid` + natural keys per event (table in `docs/research/claude-code-hooks.md` section 11).
- Recursion guard: any `claude` process launched by the monitor tooling passes `--settings '{"disableAllHooks":true}'` and `MCS_HOOK_DISABLE=1`; the handler checks the marker first.
- Installer: scopes `project-local` (default, `<repo>/.claude/settings.local.json`, narrowest) and `user`; atomic write + JSON validation + backup, entries marked by script path, dry-run default, explicit `--yes`; `verify` and `uninstall` commands. Tests never run it against real settings.
- Transcript importer: append-only assumption verified (survey), byte offsets cut at the last newline, file identity = (path, size, first-256-bytes hash, inode where available), reset on identity change, line buffer >= 2 MB, async chunked I/O with a time budget so the event loop is never starved, bookkeeping records never count as activity, global uniqueness on `(session_id?, uuid, message.id)` because resumed sessions copy records. Never persist tool-result bodies, attachment bodies, thinking signatures or account ids.

**D9. Lifecycle model (formal, evidence-based).** Execution state is separate from monitor health and from data freshness. Required semantics: running / working / waiting for input / waiting for tool or child agent / turn ended / completed / failed / stale (abandoned) / unknown, each with `basis` (`observed|inferred`), `evidence[]`, `confidence`. Rules: `Stop` != `SessionEnd`; a subagent ending never completes its parent; missing events never imply success; COMPLETED/FAILED only from SessionEnd reasons, daemon job state, or external evidence (attempts table); out-of-order events never regress a terminal state without an explicit reconciliation record; every transition is idempotent. Ship a transition table + property tests. The legacy 5-state vocabulary (`RUNNING IDLE COMPLETED FAILED UNKNOWN`) is derivable from the new model for parity tests and for the legacy-compatible `status` output.

**D10. Persistence.** SQLite WAL, `foreign_keys=ON`, `busy_timeout`, numbered SQL migrations with checksums, automatic backup before any migration, one writer connection owned by the server process (the hook handler never opens the DB), read-only CLI access when the server is stopped. Timestamps stored as integer epoch milliseconds UTC, exposed as ISO-8601 `Z` strings. IDs: `instanceId` uuid v4; internal ids integer or text keys; provider ids kept verbatim in separate columns. FTS5 only if transcript search needs it (decide with evidence). Retention and export are explicit and scoped to one instance.

**D11. API v3 + realtime.** `/api/v3/*` JSON, cursor pagination, uniform error envelope, Zod-validated query/body, no cross-instance endpoints. SSE `GET /api/v3/stream` with `Last-Event-ID` = monotonically increasing `seq` of persisted changes (persist, then publish); too-old cursor -> `reset` message -> client refetches; heartbeat comments; bounded server buffer. The server keeps no legacy endpoints unless Phase 1 shows a concrete need (the legacy UI stays with the legacy engine).

**D12. Ports and process ownership.** Base port from config (`port`, default 8765), scanning up to +19 like the legacy engine. `state.json` is written atomically after a successful bind; `start` is idempotent; `stop` verifies the pid's command line for the Node runtime marker (or legacy `viewer.py`) before killing; `mcs` treats a live legacy viewer on the same task as "running (engine=legacy)" and refuses to start a second engine; stale state files are cleaned without killing.

**D13. Upgrades.** Runtime/template version is explicit (`RUNTIME_VERSION`, semver) and recorded in `instance.json` and `state.json`. `mcs upgrade --task X` is explicit: backup, DB migrations, record in audit; config and audit are never rewritten. `status` shows `outdated: true` when the running process differs from disk. A DB newer than the runtime is refused.

**D14. Scope of instances.** An instance monitors sessions selected by the legacy keys (`repo`, `transcripts_dir`, `window_hours`, `session_rules`, `session_ids`, `include_unmatched`) plus hook envelopes whose `cwd`/`session_id` fall in scope. "Task" on the board = an explicit work item derived by documented rules (rule label groups + attempts rows) or declared in `runtime.json`; never "one session = one task".

**D15. Non-goals (do not build):** Electron, Docker/K8s, multi-machine, marketplace, enterprise auth, large UI framework, cloud backend, distributed queue, per-session process, custom analytics engine, outbound webhooks (deferred; documented), pricing tables shipped by default (cost shown only from user-configured prices, labelled estimate).

## 4. Open questions designers must close (each needs an ADR or a design section)
1. Exact lifecycle state machine and transition table (D9) including subagent/workflow handling and stale thresholds.
2. Machine panel per-process memory on Windows without a new native dependency (cached PowerShell/CIM call? documented trade-off) and detached start without console windows on Windows.
3. DDL and indexes; FTS5 yes/no; how transcript search stays bounded; retention defaults.
4. Reader concurrency in a single-threaded runtime (async chunking, worker thread or not).
5. Whether the hook handler routes by `CLAUDE_PROJECT_DIR` scan or a small per-repo index file; spool rotation and replay offsets.
6. Cross-engine golden capture procedure (the Python engine as oracle) and which latent Python defects to reproduce or fix (list in `current-state-backend.md`).
7. MCP: read-only, stdio, SDK or hand-rolled (decide in Phase 5 with research).

## 5. Rules for every agent
Read the research docs relevant to your task. Write only the files you own. Do not run git write commands. Use scratch under `D:/mvp/private/scratch/mcs-v3/` for temp files. Do not use ports 8765, 3000, 3100, 8080, 8089; test servers use 18000-18999 and must be stopped. Do not read `.key` files. Report honestly what you ran and what you could not run.
