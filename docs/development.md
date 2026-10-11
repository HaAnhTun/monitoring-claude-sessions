# Developing the skill and keeping running monitors in sync

The skill lives in its own git repository (this folder). It contains tools only: no task workspaces, no transcripts, no project data. Task workspaces (`<repo>/.claude/monitor/tasks/`) belong to the monitored project and are not part of this repository.

## One source of truth
A running monitor executes the skill's files from disk: `template/viewer.py serve` imports `src/backend/*` and serves `src/frontend/*`. There is no copy to keep in sync, only a running process that may be older than the code:
- **Frontend** (`src/frontend/*`): served from disk on every request. Reload the page.
- **Backend** (`src/backend/*`, `config/defaults.json`): loaded at start. The monitor remembers a `code_stamp` (hash of those files); `status` compares it with the files on disk and prints `"outdated": true` plus a hint. Apply with `restart`.
- **Task config** (`<task>/config.json`): read at start; use `configure` then `restart`.

## Change loop
1. Edit the skill (read `docs/architecture.md`; keep API changes additive, update `docs/api.md`).
2. From this folder: `python -m unittest discover -s tests` and `node --test "tests/frontend/*.test.mjs"`.
3. Optional browser check on synthetic data: `python tests/fixtures/make.py OUT` builds a fake `CLAUDE_CONFIG_DIR`; run `serve` with that env var and a config whose `transcripts_dir` is `OUT/projects/demo`.
4. `git add -A && git commit` in this folder.
5. For every monitor that should pick the change up: `python template/viewer.py status --repo <project> --task <slug>` (look for `outdated`), then `restart`.

## Conventions
Python stdlib only (3.8+), no frontend build, no CDN, no `innerHTML` with data (a test enforces it). New config key: `config/defaults.json` + `SCHEMA` in `config.py` + `docs/configuration.md`. New state rule: `state.classify_state` + tests + the table in `docs/api.md`. Keep project-specific names, paths and prompts out of this repository (examples use a generic "nightly build").
