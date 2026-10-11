# viewer.py quick reference (v2)

Full documentation lives in `docs/`: `configuration.md` (keys, precedence, task workspaces), `api.md` (HTTP API), `architecture.md`, `troubleshooting.md`.

## Commands (`python template/viewer.py ...`)
| Command | Does |
|---|---|
| `discover [--repo .]` | prints transcripts folder, recent sessions, log/ledger candidates, existing tasks |
| `init-task --name N [--slug S] [--description D]` | create or reuse `.claude/monitor/tasks/<slug>/` |
| `inspect [--task S]` | effective config + provenance + runtime + recent audit (no `--task`: list tasks) |
| `configure --task S --set KEY=JSON --unset KEY --reason R [--decision D]` | validated, audited change |
| `decide --task S --title T --decision D [--rejected R]` | record a decision |
| `audit [--task S]` | check workspaces (ids, schema, audit file, no copied transcripts, no symlinks); exit 1 on problems |
| `check` / `start` / `serve` / `restart` / `verify` / `status` / `stop` / `doctor` | lifecycle; `start` is idempotent and waits for health; `serve` runs in the foreground; `restart` = stop + start; `status` reports `outdated` when the skill code changed since the monitor started |
| legacy: `--config FILE [--check|--stop]`, `--discover` | flat config files, unchanged |

Common options: `--repo` (default `.`), `--root` (tasks root), `--config`, `--task`, `--port`, `--open`. Exit code 0 = success, 1 = failure, 2 = bad usage.

## Where the runtime state is
Task: `<task>/state.json` (pid, url, port). Legacy: `<config>.state.json`. The real URL is there (the next free port is used if the configured one is busy).

## Cost
About 30 MB RAM; 0.1% of one core with no tab, 3-4% with a tab open (measured 2026-10-11); nothing runs when no tab polls. Readers idle for 30 minutes are dropped.
