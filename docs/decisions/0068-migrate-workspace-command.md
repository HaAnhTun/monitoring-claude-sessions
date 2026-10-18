# 0068 One-time workspace migration: `mcs migrate-workspace`

Status: Accepted (V4, milestone M0, 2026-10-18). Owner: V4 area B (Python removal and configuration compatibility).
Related: ADR 0066 (Python removal), ADR 0067 (configuration dialect), ADR 0001 (workspace files), ADR 0009 (upgrade, rollback,
downgrade), ADR 0021 (forward-only migrations).

## Context
Workspaces created by the Python skill have no `instance.json` and hold Python-syntax patterns. The V3 Node runtime adopted such a
workspace on `start` (it added `instance.json`, `data/` and `logs/`) but left the patterns in Python syntax and translated them at
load. After ADR 0067 the loader accepts JavaScript syntax only, so every old workspace needs one conversion. The runtime upgrade
commands of the data work (`upgrade`, `db migrate`, `config migrate`) are about the database and file schema versions of Node-era
workspaces; they must not be overloaded with this one-time legacy job, and their names must not collide with it.

## Decision
- A command `mcs migrate-workspace (--task SLUG | --all) [--apply] [--json]` (plus the common `--repo` and `--root`) converts a
  pre-4.0 workspace in place. The name is deliberate: it is not `upgrade` (runtime and database versions) and not `config migrate`
  (file schema versions); the two stay free for their own jobs.
- It is a dry run unless `--apply` is given. The dry run reads only, writes nothing, takes no lock longer than the read and prints, per
  workspace, a verdict (`current`, `needs-migration` or `blocked`) and the list of actions and blockers.
- Actions: translate every Python-syntax pattern of `session_rules[].match`, `attempts.start` and `attempts.end` with the translator of
  ADR 0067 (exact or refused); validate `attempts.time_format` against the documented subset; add `instance.json`, `audit/`, `data/`
  and `logs/` when the workspace has no `instance.json` (the existing adoption routine); append one `migrate-workspace` entry to
  `audit/changes.md` that names counts and locations, never pattern texts.
- Which patterns are translated: in a workspace without `instance.json` every pattern is Python-era and is translated. In a workspace
  that has `instance.json` only a pattern that does not compile as JavaScript and does parse as Python is translated; a pattern
  that compiles is kept as written (this includes a pattern that the translator rejects as invalid Python but that compiles as
  JavaScript). A pattern that cannot be translated exactly and does not compile is a blocker (code and position, no text) and
  nothing is written for that workspace. This makes the command idempotent without a marker in the files: after a successful run there
  is no pattern left that fails to compile, so a second run finds `current`, writes nothing and creates no backup.
- Safety: refuses while a monitor runs for the workspace (a live pid in `state.json` that answers, whatever engine wrote it; the
  `probeInstance` states `running` and `unmanaged-running`); takes the task mutex for the whole read-validate-write-audit sequence;
  copies `task.json`, `config.json`, `README.md`, `instance.json` (when present) and the two audit files to
  `data/backups/pre-migrate-<UTC stamp>/` before the first write and verifies the copies; writes `config.json` atomically only when it
  changed; re-resolves the configuration after the write and restores `config.json` from the backup when that fails; never touches
  `logs/`, the database, `runtime.json` or another task; never starts, stops or signals a process.
- `--all` visits every workspace of the tasks root independently; one blocked workspace does not stop the others; the exit code is 1
  when any workspace is blocked.
- `start` and `init` keep adopting a workspace that has no `instance.json` (adding the Node files) but do not translate patterns: a
  Python-syntax pattern then fails the configuration check with the hint of ADR 0067.
- The command reads workspaces only. The flat legacy `--config FILE` mode is not supported; `mcs init --config FILE` seeds a new task
  from a flat file whose patterns are already JavaScript.

## Consequences
- The owner's four task workspaces are converted at the end of the run with dry runs first, on copies, then in place; none is deleted.
- The backup folder lives under `data/backups/` but is not a database backup set (it has no manifest); `backup list` of the data work must
  ignore folders without a manifest.
- Workspaces adopted by a V3 Node run whose patterns happen to be valid in both syntaxes keep them as written; the few inputs
  where the two meanings differ (`$` before a final line break, `\d` on non-ASCII digits) follow JavaScript from then on. The dry run
  lists these patterns as `kept` so the owner can look at them.

## Alternatives rejected
- A silent conversion on `start`: writes user files without consent or backup.
- A `schema_version` bump of `config.json` as the marker: touches about 50 test and fixture files and forces a bump for configs that
  hold no pattern; idempotency by construction needs no marker.
- Reuse `upgrade` or `config migrate`: different job, different safety rules (database backups, version chains).
- Keep translating at load for old workspaces: keeps the 1,400-line translator on the hot path and the Python dialect alive.
- Move the backup next to the workspace: clutters the tasks root that other tools list.

## Evidence
- Python coupling fact report (planning notes, not published) section 4: all four real configs pass `check` and `audit` on copies; only
  `v9-chain` needs the dialect (named groups in `attempts.start` and `attempts.end`).
- The tests build synthetic workspaces shaped like the four configs (no real data) and prove: dry run writes nothing, apply is
  idempotent, a running monitor blocks, a blocked pattern writes nothing, a failed re-resolve restores the file, another task is untouched.
