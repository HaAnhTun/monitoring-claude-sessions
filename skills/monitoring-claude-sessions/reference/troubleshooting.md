# Troubleshooting

Start with `doctor [--task <slug>]`. It checks Node, the runtime (bundle integrity), the Claude home and, with a task, the
transcripts folder, the configuration, the port, the workspace, the database and whether a running monitor is outdated. Every
failed or warned check prints a `fix:` line. All commands below run through the launcher
`node "<skill dir>/scripts/mcs.mjs" <command>`.

| Symptom | Cause | Fix |
|---|---|---|
| `ERROR: Node >= 22.22.0 is required` | Node is too old | install a current Node LTS (24 recommended) |
| `ERROR: no runtime found` | the skill folder has no `bundle/` (incomplete copy) | reinstall the skill (plugin or `install.mjs`); in a source checkout run `npm ci && npm run build` in `runtime/` |
| `start` says the server did not become healthy | invalid configuration, port range busy, start timeout | `check --task <slug>`; `doctor --task <slug>`; run `serve --task <slug>` in the foreground to see the error; read `logs/boot.log` of the workspace |
| `start` reports a monitor that already runs | one monitor per task | use that URL, or `stop` first; `instances list` shows every task |
| Port already in use | another program holds the port | the next free port is used automatically and printed; `server.portScan` sets how many are tried |
| `invalid regex ... this looks like Python regex syntax` | a workspace from before 4.0, or a pattern in the old syntax | `migrate-workspace --task <slug>` (dry run), then `--apply`; or rewrite the pattern in JavaScript syntax |
| `invalid regex (Invalid character class)` | `-` or another class syntax character unescaped inside `[...]` under the `v` flag | `[a-z\-]` or move `-` out of the class |
| `migrate-workspace` refuses | the monitor of that task runs, or a pattern cannot be translated exactly | `stop --task <slug>` first; a blocked pattern is named by position: rewrite it by hand with `configure` |
| Empty session list | no rule matched, window too short, wrong repository, transcripts folder not found | `discover` shows recent sessions and their first prompt; adjust `session_rules`, `"scope": "any"`, `window_hours`, `repo` or `transcripts_dir` |
| `transcripts.dir` warning in `doctor` | no Claude Code session ran in this repository yet, or another config folder is used | run a session in the repository, set `CLAUDE_CONFIG_DIR` the way Claude Code uses it, or set `transcripts_dir` |
| A finished job shows `IDLE` | a transcript cannot prove completion | `IDLE` is the honest answer; in 4.0 only a finished daemon job completes a session (the attempts reader comes later) |
| A session shows `UNKNOWN` | no readable records, or a tool call pending longer than `pending_tool_grace_seconds` | look at its last events; raise the grace for known long tools |
| Token numbers marked partial | the token scan of a large file has not reached the end | it converges on later reads; very large files stay unavailable (`limits.usage_max_mb`) |
| `status` shows `outdated: true` | the skill was updated after the monitor started | `restart --task <slug>` |
| 403 from the page | it was opened through another host name (proxy, tunnel, LAN address) | open `http://127.0.0.1:<port>`; never forward the port |
| `instances list` shows two tasks with the same identity | a workspace was copied or renamed | `instances repair --task <slug>` (dry run), then `--yes` with the monitor stopped |
| `stop` says nothing was stopped | the recorded process is gone or is not this monitor | nothing was killed; `status` and `instances list` show what is left |

Logs: each workspace has `logs/boot.log` and `logs/runtime.log`. `MCS_LOG_LEVEL=debug` (or `start --log-level debug`) adds
detail; `MCS_DEBUG=1` adds stacks to launcher and CLI errors. Logs are designed to hold no transcript text; still read a log
before you share it.
