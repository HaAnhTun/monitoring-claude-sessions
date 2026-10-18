---
name: monitoring-claude-sessions
description: Use when the user wants to watch, monitor or get a live view of running Claude Code sessions, unattended `claude -p` runs, subagents or workflows (what each is doing now, token use, which have finished or failed, progress of a long chain) without interrupting them, or asks to set up, change, inspect, check or stop such a monitor.
---

# Monitoring Claude Code sessions

## Overview

Claude Code writes every session (including `claude -p`, subagents and workflows) to a transcript file **while it runs**. This
skill reads those files, read-only, keeps a small metadata database per task and serves a local page on `127.0.0.1`. Never
change how sessions are launched and never touch a running one.

Entry point (call it `$MCS` below): `node "${CLAUDE_SKILL_DIR}/scripts/mcs.mjs" <command>`. It needs only Node 22.22 or newer
(no npm, no build). `$MCS help` lists the commands and `$MCS help <command>` shows the options of one. Every command accepts
`--repo PATH` (default: the current directory), `--root PATH` (tasks root) and `--json` (one machine-readable document).

Reference (read when needed):

- `${CLAUDE_SKILL_DIR}/reference/configuration.md`: every configuration key, the regular expression syntax, examples.
- `${CLAUDE_SKILL_DIR}/reference/troubleshooting.md`: symptoms, causes and fixes.
- `${CLAUDE_SKILL_DIR}/reference/transcript-format.md`: what Claude Code writes into a transcript.

## When to use

- "What are my background sessions doing", "tokens per session", "which finished or failed", "progress of the chain".
- A **major task** the user explicitly wants monitored gets its own task workspace (below). A quick look can use `$MCS discover`
  or the task "default" (`$MCS start` without `--task` creates it on demand).
- Not for: one finished session (read its transcript), money cost (only token counts exist), other machines.

## Procedure (report a step as done only after checking its output)

1. `$MCS discover` shows the transcripts folder, recent sessions with their first prompt, log candidates and existing tasks.
2. `$MCS init --name "<name>" [--description TEXT]` creates `<repo>/.claude/monitor/tasks/<slug>/` or **reuses** it (it never
   overwrites). No name given: derive a short one from the task context; do not ask.
3. `$MCS inspect --task <slug>`: **read before changing**. It shows the effective configuration, which keys are default and
   which come from the task, the recent audit entries and the runtime state.
4. `$MCS configure --task <slug> --set KEY=JSON ... [--unset KEY] --reason "<why>"` changes the configuration (validated as a
   whole, written atomically, audited; `--dry-run` writes nothing). Add one `session_rules` entry per kind of session.
   `$MCS decide --task <slug> --title TEXT --decision TEXT` records a decision.
5. `$MCS check --task <slug>` validates every file and every regex; `$MCS audit --task <slug>` checks the workspace.
6. `$MCS start --task <slug>` starts the monitor in the background (loopback only), waits until it answers and prints the real
   URL (the next free port is used when the configured one is busy). If it already runs, it reports that one and never starts
   a second. Give the URL to the user.
7. `$MCS verify --task <slug>` checks that the running monitor answers with valid data. Then `$MCS status --task <slug>`
   (URL, pid, uptime, sessions by state, recent errors). Nothing or the wrong sessions listed: fix the rule regex, `scope`
   or `window_hours`.
8. `$MCS stop --task <slug>` when asked or done (it stops only a process whose identity it verified). After the skill itself
   changed, `$MCS status` shows `outdated: true`: run `$MCS restart --task <slug>`. A configuration change also needs a
   restart. `$MCS version` prints the runtime version.

Health and housekeeping:

- `$MCS doctor [--task <slug>]` checks Node, the runtime, the Claude home and, with a task, the workspace, configuration,
  database and port. Each failed check prints a `fix:` line. Run it first when anything looks wrong.
- `$MCS instances list` lists the tasks of the repository with state, URL, pid, version and whether they are outdated.
  `$MCS instances repair --task <slug>` gives a copied or renamed workspace a new identity (a dry run without `--yes`).
- `$MCS migrate-workspace --task <slug>` converts a workspace made by a version before 4.0 (old regex syntax, no
  `instance.json`). It is a dry run unless `--apply`; with `--apply` it backs up to `data/backups/` first. Show the dry run
  to the user before applying. It refuses while that task's monitor runs: stop it first.

## Adapting to the request

| User wants | Change |
|---|---|
| only sessions about X | a `session_rules` entry (`match` = X; `"scope": "any"` if X is not in the first prompt) |
| older sessions | `window_hours` (older ones are hidden) or `session_ids` |
| another repository | `--repo PATH`, or `repo`; `transcripts_dir` if the transcripts folder is not found |
| PASS or FAIL per run | `chain_log` and `attempts` can be configured and checked, but 4.0 does not read the attempts table yet: say so |
| another port | `port` (or `start --port N`) |

## Rules

- Read-only; bind `127.0.0.1` only. Host and origin checks are a safeguard, **not authentication**. Transcripts hold
  prompts, file contents and possibly secrets: never expose or forward the port, and never copy transcript text into task
  files, decisions or audit reasons.
- Patterns in `session_rules[].match`, `attempts.start` and `attempts.end` are **JavaScript** regular expressions, compiled
  with the `v` flag: named groups are `(?<name>...)`; there are no inline flags such as `(?i)` (write `[Ss]tep`); inside a
  character class escape `-` and the other class syntax characters, or move `-` out of the class. Prefer classes like
  `[0-9]` over backslash escapes (JSON doubles every backslash, and shells may eat them).
- Session state, monitor health and data freshness are three different things. `IDLE` is not "done": a transcript cannot
  prove completion. Never report a guess as a fact; show partial or unavailable data as such.
- Do not tail a `claude -p` attempt log: it stays empty until the run ends.
- Tokens: deduplicate by `message.id` (one message is written as several records that repeat the usage); show cache reads
  separately. Timestamps are UTC.
- Never delete or reset a task workspace, and never edit another task, without the user's explicit instruction. Change the
  configuration only through `configure`, never by hand.

## Common mistakes

| Mistake | Fix |
|---|---|
| Wrapping future launches (`stream-json` tee) for visibility | Not needed; it changes the user's run. Read transcripts. |
| Summing `usage` over every record | Deduplicate by `message.id`. |
| Calling a quiet session finished | Only external evidence gives COMPLETED or FAILED; in 4.0 that is a finished daemon job. |
| `(?P<name>...)` or `(?i)` in a rule | JavaScript syntax: `(?<name>...)`, letter classes; old workspaces: `migrate-workspace`. |
| `[a-z-]` in a pattern | Invalid under the `v` flag: write `[a-z\-]` (in JSON `[a-z\\-]`) or keep `-` outside the class. |
| Starting a second monitor on a new port | `start` reports the running one; use `status` or `instances list`. |
| Killing a monitor by guessing its pid | Use `stop`; it checks the process. |
| Editing `config.json` by hand | Use `configure` (validated, audited), then `restart`. |
