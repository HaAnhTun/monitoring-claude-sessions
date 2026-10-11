# 0001 Instance workspace: Node-owned files beside the legacy files

Status: Proposed (Phase 1, 2026-10-11). Owner: instances/config/ops design (`docs/design/01-instances-config-ops.md` sections 1, 3).

## Context
D2/D3 make the existing task workspace `<repo>/.claude/monitor/tasks/<slug>/` the instance workspace. The legacy engine shares
`task.json`, `config.json`, `state.json` and `audit/*.md` and validates `config.json` strictly: an unknown key makes it refuse to start
(`config.py:92-119`), which would also block a rollback. A live V9 monitor runs from the legacy engine during the migration.

## Decision
- Node-only data lives in new files: `instance.json` (identity: `instanceId` uuid v4, `slug`, `runtimeVersion`, `dbSchemaVersion`,
  `engine`, `hooks.enabled`), `runtime.json` (R keys, own `schema_version`, optional), `run/control.token`, `data/`, `logs/`.
- L keys (legacy) and R keys (runtime) have disjoint top-level names; `configure` routes a key to `config.json` or `runtime.json` by its
  first segment. D3's "port, logLevel" become `server.port` (because `port` is an L key) and `logLevel`; server-process timeouts
  live in `process` because `lifecycle` holds design 02's session-state thresholds.
- `state.json` keeps the seven legacy keys first, in legacy order, then adds `schema_version`, `engine: "node"`, `instanceId`,
  `runtimeVersion`, `codeStamp`, `startedAt`, `nodeVersion`, `control`.
- A legacy workspace is adopted by `mcs init` or `mcs start` (creates `instance.json`, `data/`, `logs/`; prints it; audits
  `adopt-instance`; never rewrites legacy files). `runtime.json` is optional and created only by `configure` or `config migrate`.
- The workspace slug must equal `instance.json.slug`; a copied workspace is detected and repaired only by `mcs instances repair`.

## Consequences
- Both engines can operate the same workspace; the legacy engine ignores the new files.
- Rollback to the legacy engine needs no file changes.
- The legacy `audit` flags any `*.jsonl` in a workspace; therefore Node never creates one there: spool segments are
  `hooks-<YYYYMMDD>T<HH>Z.ndjson` (revision 2, critic issue I-02, verified by the critic's experiment X1: legacy `audit` exit 1 with a
  `.jsonl` segment, exit 0 with `.ndjson`) and `export` refuses a `.jsonl` path inside a workspace. The legacy `configure` snapshot
  still hashes runtime files (CHALLENGE C-2 in the design).

## Alternatives rejected
- New keys inside `config.json` with a `schema_version` bump: the legacy engine would refuse the file (safe but blocks coexistence).
- Runtime data outside the workspace (for example under `MCS_HOME`): splits ownership and cleanup across folders, contradicts D3.
- One `instance.json` holding R keys too: mixes identity (rarely written, audited) with tunables (edited by `configure`).

## Evidence
- `src/backend/config.py:92-119`, `tasks.py:79-96, 205-233`, `cli.py:216-224` read 2026-10-11 (engine 2.0.2).
- Structure of the live workspaces (key names and types only), script `D:/mvp/private/scratch/mcs-v3/instances-ops/struct.mjs`,
  2026-10-11: `state.json` keys `pid,url,port,started,version,task,config`; `task.json` keys `schema_version,id,name,description,created,repo,links`.
