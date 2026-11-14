# Configuration reference

The configuration of a task lives in its workspace, `<repo>/.claude/monitor/tasks/<slug>/`. Change it with
`configure --task <slug> --set KEY=JSON [--unset KEY] --reason TEXT` (validated as a whole, written atomically, audited;
`--dry-run` writes nothing) and read it with `inspect --task <slug>`. The configuration is read when the monitor starts:
run `restart` after a change.

## Layers (lowest to highest)

1. The shared defaults in the skill folder (`config/defaults.json`, `runtime/defaults.json`).
2. The task: `config.json` (monitor keys, below) and `runtime.json` (runtime sections, below). Both hold overrides only.
3. The environment: `MCS_LOG_LEVEL` (log level).
4. The command line: `start --port N`, `start --log-level LEVEL`.

Merge rule: the dictionaries `panels`, `ui`, `poll` and `limits` merge key by key; every other key (scalars, lists such as
`session_rules`) is replaced as a whole. Keys that start with `_` are comments and are ignored. `inspect` shows, for each key,
whether it is a default or comes from the task.

## Workspace files

| File | Content |
|---|---|
| `task.json` | identity: `schema_version`, `id` (= slug), `name`, `description`, `created`, `repo` (relative to the folder), `links` |
| `config.json` | monitor key overrides, `schema_version` 1 |
| `runtime.json` | optional runtime section overrides, `schema_version` 1 |
| `instance.json` | the instance identity used by the runtime |
| `state.json` | exists while the monitor runs (pid, URL, port); never copy or commit it |
| `audit/changes.md`, `audit/decisions.md` | append-only audit trail and decisions |
| `data/` | the SQLite metadata database (`monitor.db`) and backups |
| `logs/` | the runtime's own logs (`boot.log`, `runtime.log`) |

Slugs match `[a-z0-9][a-z0-9-]{0,47}`. `init` on an existing slug reuses it and overwrites nothing.

## Monitor keys (`config.json`)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `schema_version` | int | 1 | required; other values are refused |
| `title` | string | "Claude sessions monitor" | page title |
| `port` | int | 8765 | first port to try; the next free one (up to `server.portScan` above it) is used when busy |
| `repo` | path | `.` | repository root |
| `transcripts_dir` | `auto` or path | `auto` | Claude Code project folder of the repository; `auto` derives it from the repository path (under `CLAUDE_CONFIG_DIR` or `~/.claude`) |
| `window_hours` | number | 8 | only sessions written within this window are listed |
| `active_seconds` | number | 120 | written within this: `RUNNING` |
| `pending_tool_grace_seconds` | number | 900 | a tool call without a result for longer than this: `UNKNOWN` |
| `include_unmatched` | bool | false | also list sessions that no rule matched |
| `session_rules` | list | `[]` | `{match, label, scope?}`, see below; the first match wins |
| `session_ids` | list | `[]` | session ids that are always listed (even outside the window) |
| `panels` | dict of bool | machine, git, logs on | `machine git logs ledger chain_log attempts` |
| `live_log_globs`, `chain_log`, `ledger`, `stop_file` | | empty | extra files, relative to `repo` |
| `attempts` | dict or null | null | `{label_prefix, time_format, start, end}`: the attempts table of `chain_log` (validated and read: a finished attempt is external evidence of completion) |
| `watched_processes`, `docker` | | | contents of the machine panel |
| `ui` | dict | | `theme` (`auto`, `light`, `dark`), `density` (`comfortable`, `compact`), `newest_first`, `show_tools`, `show_thinking`, `show_prompts` |
| `poll` | dict (ms) | | `events_ms sessions_ms machine_ms logs_ms overview_ms attempts_ms stale_after_ms` |
| `limits` | dict | | `event_window_mb max_events text_chars usage_scan_budget_ms usage_max_mb` |

The panel keys (`panels`, `live_log_globs`, `ledger`, `stop_file`, `watched_processes`, `docker`) drive the panels of the
Overview (git, machine, logs, ledger, chain log, attempts); a source that cannot be read is shown with its own status
instead of failing the page. `chain_log` with `attempts` is read as the attempts table: a finished attempt is external
evidence that completes a session, next to a finished daemon job.

## Runtime sections (`runtime.json`)

`configure` sets them with dotted keys, for example `--set server.portScan=5`. The most useful ones:

| Key | Default | Meaning |
|---|---|---|
| `logLevel` | `info` | `error`, `warn`, `info` or `debug` |
| `server.portScan` | 19 | how many ports above `port` are tried |
| `server.requestTimeoutMs` | 30000 | request timeout |
| `process.startTimeoutMs` | 20000 | how long `start` waits for a healthy server |
| `process.stopTimeoutMs` | 10000 | how long `stop` waits for the server to exit |
| `lifecycle.subagentActiveSeconds` | 60 | a subagent written within this counts as active |
| `lifecycle.staleAfterSeconds` | 1800 | quiet longer than this: stale |
| `lifecycle.jobsPollMs` | 15000 | how often daemon job files are read |
| `terminal.command` | `claude` | program of every terminal session: a name on PATH or an absolute path (no quotes, 1 to 260 characters) |
| `terminal.args` | `[]` | extra arguments in front of `--resume` (at most 32), passed one by one and never through a shell |
| `terminal.envKeep` | `[]` | names of the stripped child environment that are kept, for example `CLAUDE_CODE_USE_BEDROCK` (at most 32) |
| `terminal.maxSessions` | 8 | terminal sessions at once (1 to 64); a new one over the limit is refused |
| `terminal.replayBytes` | 1048576 | replay buffer of one session, 64 KiB to 16 MiB |
| `terminal.maxInputBytes` | 262144 | largest single input to a terminal, 1 KiB to 256 KiB (the maximum is also the limit of the terminal socket) |
| `terminal.startTimeoutMs` | 10000 | how long to wait for a terminal child to start (1000 to 60000) |
| `terminal.killTimeoutMs` | 3000 | how long to wait for an exit after a kill before the whole process tree is killed (500 to 30000) |
| `terminal.conptyDll` | `false` | use the `conpty.dll` and `OpenConsole.exe` that ship with the terminal package |
| `app.name` | `Claude Agent Workspace` | name in the page header and title (1 to 80 characters) |
| `app.openAppWindow` | `false` | open an Edge or Chrome app window instead of a tab of the default browser |
| `projects.scope` | `auto` | `repo` reads one repository, `all` every project folder of the Claude home, `auto` is `all` on the user instance and `repo` on a task instance |
| `projects.fullSweepIntervalMs` | 60000 | full sweep of every project folder, scope `all` (5000 to 3600000) |
| `projects.coldStatIntervalMs` | 10000 | how often files without growth for five minutes are checked, scope `all` |
| `projects.catalogIntervalMs` | 30000 | refresh of the folder catalogue |
| `projects.daMemoryDir` | `null` | folder of the DA memory files; `null` is `.claude/memory` under the home folder |
| `projects.daCacheMs` | 3000 | how long one read of the DA memory is reused |
| `projects.userFoldersMax` | 200 | most folders a person may add by hand (1 to 1000) |
| `projects.linkPollMs` | 250 | registry poll of the terminal-to-session link while a terminal is young |
| `projects.linkSlowPollMs` | 2000 | poll after the fast window and for linked terminals |
| `projects.linkFastWindowMs` | 30000 | length of the fast poll window; the database fallback starts after it |
| `projects.linkStartToleranceMs` | 2000 | a registry entry may start this much before the spawn time and still count as the new session |

Unknown keys and values out of range are refused, and nothing is written.

The `terminal`, `app` and `projects` sections belong to the user-wide workspace instance; a task instance never reads them. A change needs a restart of the instance.

## Regular expressions

`session_rules[].match`, `attempts.start` and `attempts.end` are **JavaScript** regular expressions. They are compiled with
the `v` flag; session rules also get `s` (a dot matches a line break) and are searched anywhere in the text; attempt patterns
also get `y` (the match must start at the beginning of the line).

- Named groups: `(?<name>...)`. A backreference to one: `\k<name>`.
- No inline flags: `(?i)` and `(?i:...)` are refused. Write case-insensitive text with classes: `[Ss]tep`.
- Inside a character class, the `v` flag needs an escape for `-`, `(`, `)`, `[`, `]`, `{`, `}`, `/`, `|` and the backslash:
  `[a-z\-]`, or keep `-` outside the class.
- `\d`, `\w`, `\s` and `\b` are ASCII in JavaScript. `$` means the end of the text.
- JSON doubles every backslash (`"\\d"`). Classes such as `[0-9]` avoid backslashes altogether.
- A pattern in the old syntax (`(?P<name>...)`, `(?P=name)`, `(?#...)`, `(?i)`, `\A`, `\Z`) is refused with a hint: run
  `migrate-workspace --task <slug>` (a dry run first, then `--apply`).

`check --task <slug>` compiles every pattern and reports the first problem of each.

### Session rules

`{"match": REGEX, "label": TEXT, "scope": "any"}` (`scope` is optional). The pattern is matched against the first real
prompt of a session (with `"scope": "any"`: against any of the first 25 prompts). `{1}` in the label is replaced by capture group 1.

### Attempts

`start` and `end` are matched against each line of `chain_log`. `start` needs the named groups `time`, `part`, `n`, `model` and
`effort`; `end` needs `time`, `part`, `exit` and `status`. `label_prefix` is put before `part` in the title of the attempt on the work item board.
`time_format` is a subset of strftime: `%Y %m %d %H %M %S %f %y %b %B %a %A %I %p %j %z %Z %%`; without `%z` the time is local.

## Examples

```bash
MCS='node "<skill dir>/scripts/mcs.mjs"'
$MCS init --name "Nightly build" --description "unattended build steps A to E"
$MCS configure --task nightly-build --reason "match the build sessions" \
  --set 'session_rules=[{"match":"STEP=([A-Z0-9]+)","label":"build step {1}"}]' --set window_hours=24
$MCS configure --task nightly-build --reason "PASS or FAIL per step" --set 'chain_log="logs/chain.log"' \
  --set panels.attempts=true \
  --set 'attempts={"label_prefix":"build step ","time_format":"%Y-%m-%d %H:%M:%S","start":"(?<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) START part=(?<part>[A-Z0-9]+) n=(?<n>[0-9]+) model=(?<model>[a-z0-9.]+) effort=(?<effort>[a-z]+)","end":"(?<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) END part=(?<part>[A-Z0-9]+) exit=(?<exit>[0-9]+) status=(?<status>[A-Z]+)"}'
$MCS check --task nightly-build
```

A minimal `config.json`:

```json
{
  "schema_version": 1,
  "title": "Nightly build",
  "window_hours": 24,
  "session_rules": [{ "match": "STEP=([A-Z0-9]+)", "label": "build step {1}" }]
}
```

## Privacy

The database holds metadata only (ids, times, states, token counts, file references); transcript text is read from the
transcript file when the page asks for it. Transcripts are never modified. The task folder is not a security boundary: it sits
in the repository's `.claude/` folder, which is normally git-ignored (`doctor --task <slug>` checks it).
