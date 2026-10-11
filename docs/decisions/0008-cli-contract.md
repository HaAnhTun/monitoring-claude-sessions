# 0008 CLI contract: legacy-compatible commands and outputs, `--json` envelope, one ops layer, legacy delegation

Status: Proposed (Phase 1, 2026-10-11). Owner: instances/config/ops design (`docs/design/01-instances-config-ops.md` section 6).

## Context
Agents operate the skill through deterministic commands. The legacy CLI promises exit codes 0/1/2, prints JSON for `inspect`,
`configure`, `audit`, `status`, `doctor` and fixed text for lifecycle commands, and supports flat configs via `--config FILE`. The brief
forbids duplicating business logic across CLI, API and UI (section 11) and asks for many new commands (section 8.9/8.10).

## Decision
- Parsing with `node:util` `parseArgs` (no commander/yargs, stack avoid list), per-command option tables; `--help` generated from them.
- Every command calls one function in `@mcs/engine/ops/*`; data reads go through `InstanceReader` (HTTP API when the instance runs,
  read-only DB otherwise), and both call the same engine query functions as the server.
- Exit codes 0 (success), 1 (failure or problems found), 2 (usage), 130 (interrupted); detail in `error.code` strings.
- Default output keeps the legacy shape (JSON for the five legacy JSON commands, legacy texts such as `started: <url> (pid N)`).
  `--json` prints one envelope `{schema: 'mcs.cli/1', command, ok, exitCode, data, error, warnings}` validated by
  `schemas/cli-envelope.v1.schema.json`.
- Destructive or out-of-workspace changes are dry runs without `--yes`; data deletion also needs `--confirm <slug>`.
- Legacy flat-config forms and instances whose `engine` is `legacy` are delegated to `python template/viewer.py` with the same
  arguments; configuration commands stay in Node (byte-compatible files).
- Without `--task`, `start`/`serve`/`restart` use (and create) the workspace `default`.

## Consequences
- Agents and docs written for the legacy CLI keep working; new commands share the same conventions.
- Removing Python later only removes the delegation path.

## Alternatives rejected
- New exit codes per failure: breaks the legacy promise; agents would mis-read 3+.
- JSON by default for every command: changes existing text outputs agents rely on.
- Re-implementing flat-config mode in Node: duplicates a legacy path that `config migrate --from-legacy` replaces.

## Evidence
- `src/backend/cli.py:1-18, 385-453` (commands, exit codes, legacy flags), read 2026-10-11, engine 2.0.2.
- `docs/research/stack-versions.md` section 9 (avoid list: commander, yargs), 2026-10-11.
- Brief MEGA-PROMT-V3 sections 8.9, 8.10, 11 ("Do not duplicate the same business logic ... in the API layer, CLI, and UI").
