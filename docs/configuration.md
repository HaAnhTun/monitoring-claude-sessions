# Configuration

## Sources and precedence (lowest to highest)
1. `config/defaults.json` – shared defaults, `schema_version` 1. The only place defaults live.
2. One override layer, exactly one of:
   - a **task workspace** `<repo>/.claude/monitor/tasks/<slug>/config.json` (preferred), or
   - a **legacy flat file** passed with `--config FILE` (any file name, no `schema_version` needed).
3. Nothing else. Environment variables and CLI flags only choose *which* config to load (`--task`, `--config`, `--repo`, `--root`) and the port (`--port` wins over `port`).

Merge rule (deterministic): keys in `panels`, `ui`, `poll`, `limits` merge per sub-key; every other key (scalars, lists such as `session_rules`) is replaced as a whole. Defaults never override a task value. Keys starting with `_` are comments and ignored. `python viewer.py inspect --task SLUG` prints the effective config and, for each key, whether it is `default` or `task`.

## Task workspace
```
<repo>/.claude/monitor/tasks/<slug>/
  README.md        what this is (human)
  task.json        identity: schema_version, id (= slug), name, description, created, repo (relative to this folder), links[]
  config.json      overrides only, schema_version 1
  state.json       runtime only (pid, url, port, started); exists while the monitor runs; never copied or committed
  audit/changes.md append-only: timestamp, action, summary (old -> new), reason, files, validation, outcome, unresolved
  audit/decisions.md append-only: decisions and rejected alternatives
```
Rules enforced by the code: slug = `[a-z0-9][a-z0-9-]{0,47}` (path traversal impossible); `init-task` on an existing slug reuses it and overwrites nothing; `configure` reads the current file first, changes only the requested keys, validates the whole result (unknown keys and wrong types are rejected and nothing is written), writes atomically and appends to the audit; a no-op writes nothing; other tasks are never touched (checked by a snapshot comparison after every `configure`); unsupported or missing `schema_version` fails with a message and the file is left as is (no silent migration). Nothing deletes a task: removing a workspace is a manual action that needs the user's explicit instruction. Transcripts are referenced by session id in `session_ids`/rules, never copied; the audit stores key names and short values, not prompts.

Whether to create a task: only when the user explicitly asks to monitor a major piece of work (a chain, a long multi-agent job). A quick look at "what are my sessions doing" can use `start` without `--task` (defaults only) or a throw-away legacy config.

## Keys
| Key | Type | Default | Meaning |
|---|---|---|---|
| `schema_version` | int | 1 | required in a task `config.json`; unsupported values are refused |
| `title` | string | "Claude sessions monitor" | page title |
| `port` | int | 8765 | first port to try (next free one, up to +19, is used if busy) |
| `repo` | path | `.` | repository root; relative to the config file's folder (task: from `task.json`) |
| `transcripts_dir` | `auto` or path | `auto` | Claude project folder; auto = sanitized repo path, else match recorded `cwd` |
| `window_hours` | number | 8 | only sessions written within this window are listed (older ones are hidden, the page says so) |
| `active_seconds` | number | 120 | written within this → `RUNNING` |
| `pending_tool_grace_seconds` | number | 900 | a tool call without result for longer than this → `UNKNOWN` |
| `include_unmatched` | bool | false | also list sessions no rule matched |
| `session_rules` | list | `[]` | `{match, label, scope?}`: Python regex on the first real prompt (`scope: "any"` = any of the first 25); `{1}` = capture group 1; first match wins |
| `session_ids` | list | `[]` | explicit session ids always shown (even outside the window) |
| `panels` | dict of bool | machine, git, logs on | `machine git logs ledger chain_log attempts` |
| `live_log_globs`, `chain_log`, `ledger`, `stop_file` | | empty | extra files, relative to `repo` |
| `attempts` | dict or null | null | `{label_prefix, time_format, start, end}` regexes with named groups (`time part n model effort` / `time part exit status`); this is the evidence that makes a session `COMPLETED` or `FAILED` |
| `watched_processes`, `docker` | | | machine panel contents |
| `ui` | dict | auto / comfortable | `theme auto|light|dark`, `density comfortable|compact`, `newest_first`, `show_tools`, `show_thinking`, `show_prompts` (defaults; the viewer's own saved preferences win in their browser) |
| `poll` | dict (ms) | 1500 … | `events_ms sessions_ms machine_ms logs_ms overview_ms attempts_ms stale_after_ms` |
| `limits` | dict | | `event_window_mb` 8, `max_events` 20000, `text_chars` 6000, `usage_scan_budget_ms` 1500, `usage_max_mb` 512 |

Regex tip: JSON needs doubled backslashes; prefer character classes (`[.]`, `[0-9]`).

## Safe change procedure (for an agent)
1. `inspect --task SLUG` – read the current effective config, provenance and the last audit entries.
2. `configure --task SLUG --set KEY=JSON ... --unset KEY --reason "why"` – validated, audited. For a decision worth remembering add `--decision "..."` or run `decide`.
3. `check --task SLUG`, then `start`/`verify` (or restart: `stop` + `start`; config is read at start).
4. Report what changed and what did not.

## Examples
```bash
python template/viewer.py init-task --name "Nightly build" --description "unattended build steps A..E"
python template/viewer.py configure --task nightly-build --reason "match the chain's sessions" \
  --set 'session_rules=[{"match":"STEP=([A-Z0-9]+)","label":"build step {1}"}]' --set window_hours=24 --set panels.attempts=true
python template/viewer.py inspect --task nightly-build
```
Minimal task `config.json`:
```json
{ "schema_version": 1, "title": "Nightly build", "window_hours": 24,
  "session_rules": [ { "match": "STEP=([A-Z0-9]+)", "label": "build step {1}" } ] }
```

## Retention and privacy
Nothing is stored except the task files above. The monitor keeps parsed events in memory only (caps in `limits`); closing it frees everything. Transcripts are never modified or deleted. The task folder is not a security boundary (it sits in the repo's `.claude/`, which is normally git-ignored: check before committing).

## Schema versions
`schema_version` 1 is the only supported version. A higher or missing version stops with an explicit error. To add version 2 later: extend `SUPPORTED_SCHEMAS` in `config.py`, write an explicit `migrate` step that keeps a backup, and document it here.
