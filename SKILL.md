---
name: monitoring-claude-sessions
description: Use when the user wants to watch, monitor or get a live view of running Claude Code sessions, unattended `claude -p` runs, subagents or workflows (what each is doing now, token use, which have finished or failed, progress of a long chain) without interrupting them, or asks to set up, change, inspect or stop such a monitor.
---

# Monitoring Claude Code sessions

## Overview
Claude Code writes every session (including `claude -p`, subagents, workflows) to a transcript **while it runs**. This skill reads those files, read-only, and serves a local page. Never change how sessions are launched, never touch a running one. Entry point: `python .claude/skills/monitoring-claude-sessions/template/viewer.py <command>` (call it `$V` below). Details: `docs/` (architecture, configuration, api, troubleshooting, ui-decision-record), `reference/transcript-format.md`.

## When to use
- "What are my background sessions doing", "tokens per session", "which finished/failed", "progress of the chain".
- A **major task** the user explicitly wants monitored gets its own task workspace (below). A quick look needs no workspace.
- Not for: one finished session (read its transcript), money cost (only token counts exist), other machines.

## Procedure (each step reports success only after checking)
1. `$V discover --repo .` – transcripts folder, recent sessions with first prompt, log/ledger candidates, existing tasks.
2. `$V init-task --name "<name>" [--description ...]` – creates `.claude/monitor/tasks/<slug>/` or **reuses** it (never overwrites). No name given: derive a short one from the task context; do not ask.
3. `$V inspect --task <slug>` – **read before changing**: effective config, which keys are default vs task, last audit entries.
4. `$V configure --task <slug> --set KEY=JSON ... [--unset KEY] --reason "<why>" [--decision "..."]` – validated, audited, touches only that task. Keys: `docs/configuration.md`. Always add one `session_rules` entry per kind of session; `chain_log` + `attempts` only if those files exist.
5. `$V audit --task <slug>` then `$V check --task <slug>`.
6. `$V start --task <slug>` – detached, loopback only, waits until `/api/health` answers, prints the real URL; already running = reports it, never starts a second one. Give the URL to the user.
7. `$V verify --task <slug>` – health, config, sessions, overview return valid JSON. Then `$V status --task <slug>` (state counts, partial data, recent errors). Nothing or the wrong sessions listed: fix the rule regex, `scope`, `window_hours`.
8. `$V doctor [--task <slug>]` when anything is off. `$V stop --task <slug>` when asked or done (kills only a verified viewer process). After the skill's own code changed: `$V status` shows `outdated: true`, then `$V restart --task <slug>` (frontend changes need only a page reload).

Legacy: `$V --config FILE [--check|--stop]` and `--discover` still work (flat config, no workspace, no audit).

## Answer these from the tools, not from memory
Which task? `inspect`/`/api/task`. Which sessions/agents? `/api/sessions`. Inherited vs overridden? `inspect` provenance. Last change and why? `inspect` → recent audit. Healthy? `status`. Data current/stale/partial? `status` `partial_sessions`, the page's freshness bar, `completeness` per session.

## Adapting to the request
| User wants | Change |
|---|---|
| only sessions about X | a `session_rules` entry (`match` = X; `"scope": "any"` if X is not in the first prompt) |
| older sessions | `window_hours` (older ones are hidden) or `session_ids` |
| another repo | `repo`, and `transcripts_dir` if auto-detect fails |
| watch a script's log | `live_log_globs` |
| PASS/FAIL per run | `chain_log` + `attempts` (named groups `time part n model effort exit status`); only this makes a session COMPLETED/FAILED |
| fewer panels, other look | `panels`, `ui` |
| notify when something ends | hooks change settings for every session: get consent, then **REQUIRED SUB-SKILL:** use update-config |

## Rules
- Read-only; bind `127.0.0.1` only. Host validation is a safeguard, **not authentication**. Transcripts hold prompts, file contents, possibly secrets: never expose the port, never copy transcript text into task files or audit entries.
- Session state ≠ monitor health ≠ data freshness. `IDLE` is not "done": a transcript cannot prove completion. Never report a guess as fact; show partial/unavailable data as such.
- Do not tail a `claude -p` attempt log: it stays empty until the run ends.
- Tokens: deduplicate by `message.id`; show cache reads separately. Timestamps are UTC.
- Never delete/reset a task workspace or edit another task without the user's explicit instruction. Never silently migrate a config.
- Changing the skill itself: read `docs/architecture.md` and `docs/development.md` first; keep API changes additive; run the tests (below); commit in the skill's own git repo; then `restart` the running monitors so they run the new code.

## Verify the skill (after any change)
`python -m unittest discover -s tests -v` and `node --test tests/frontend` (from the skill folder). Browser checks need a running viewer on the synthetic fixtures (`tests/fixtures/make.py`).

## Common mistakes
| Mistake | Fix |
|---|---|
| Wrapping future launches (`stream-json` tee) for visibility | Not needed; it changes the user's run. Read transcripts. |
| Summing `usage` over every record | Dedupe by `message.id`. |
| Calling a quiet session finished | Only external evidence (attempts table) gives COMPLETED/FAILED. |
| Matching rules on `<local-command-caveat>` or IDE notes | The viewer skips that boilerplate; match the real prompt. |
| Killing a viewer by guessing its pid | Use `stop`; it checks the process. |
| Editing `config.json` by hand | Use `configure` so the change is validated and audited. |
