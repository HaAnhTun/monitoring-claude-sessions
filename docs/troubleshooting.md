# Troubleshooting

Start with `python template/viewer.py doctor [--task SLUG]`: it checks config, transcripts folder, parse errors, rule matches, state file, a running instance and task audit, and prints what failed.

| Symptom | Cause | Fix |
|---|---|---|
| `start` says it did not become healthy | port range busy, config invalid, Python error | run `serve` in the foreground (`... serve --task SLUG`) to see the traceback; `doctor` |
| Port already used | another viewer or app on the port | the next free port (up to +19) is used automatically; the real URL is printed and kept in `state.json` / `<config>.state.json` |
| `start` says "already running" | a healthy instance for this task exists | use that URL, or `stop` first. A second instance for the same task is never started |
| `stop` says "not a viewer process" | the state file was stale (process gone, pid reused) | nothing was killed; the stale file was removed |
| Page shows data but a STALE badge | polls failing for longer than `poll.stale_after_ms` | the banner shows the last error; check `/api/health`, whether the process is alive (`status`), then Retry |
| Empty session list | no rule matched, window too short (`window_hours`), wrong repo, `transcripts_dir` not found | `doctor`; `discover` prints recent sessions and their first prompt; adjust `session_rules`, `scope: "any"`, `window_hours`, or tick "show unmatched" |
| Session shows `IDLE` for a finished job | a transcript cannot prove completion | configure `chain_log` + `attempts` for runs that have an end marker; otherwise `IDLE` is the honest answer |
| Session shows `UNKNOWN` | no readable records, or a tool call pending longer than the grace period (killed, waiting for permission, very long tool) | look at the last events of that session; raise `pending_tool_grace_seconds` for known long tools |
| "tokens partial" badge | the token scan has not reached the end of a big file yet | it converges on later polls (`scanned_pct`); above `usage_max_mb` it stays unavailable |
| "Showing only the latest events" | transcript larger than `event_window_mb`, or more than `max_events` events | use "Load older"; raise the limits if memory allows |
| Invalid lines counted in `/api/health` reader stats | truncated or corrupted records | harmless (skipped); a file being written mid-line is not counted |
| Missing token numbers for a session | file unreadable, over the size limit, or no `assistant` usage fields in this Claude Code version | check `completeness.usage`; see `reference/transcript-format.md` |
| 403 "forbidden host" | the page was opened through a name other than 127.0.0.1/localhost (proxy, tunnel) | open it via http://127.0.0.1:PORT; do not forward the port |
| Task command fails with "schema_version" | missing or unsupported version in `config.json` | read the message; fix the file by hand; the tool never rewrites it silently |
| Rule regex never matches | JSON escaping or the phrase is not in the first prompt | use character classes instead of backslashes; try `"scope": "any"` |
| Memory growth | many open transcripts with events held | readers idle for 30 min are dropped; lower `limits.max_events` |

Machine panel works fully on Windows only; Linux/macOS paths exist but were not verified.

Logs: the detached monitor writes nothing to disk. For a traceback run it in the foreground. Server-side errors of the last minutes are in `/api/health` under `errors`.
