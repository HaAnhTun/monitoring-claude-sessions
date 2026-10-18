# Claude Code transcripts: what is on disk and how far to trust it

Verified on Claude Code 2.1.289 / 2.1.296, Windows, 2026-10-11. These are internal formats and can change: parse defensively.

## Where
- Session: `~/.claude/projects/<project>/<sessionId>.jsonl`. `<project>` is the repo path with every non-alphanumeric character replaced by `-` (here `d--work`, lowercase on this machine; the viewer also matches by the recorded `cwd`).
- Subagents and workflows of a session: `<sessionId>/subagents/**/agent-<id>.jsonl` (+ `agent-<id>.meta.json` with label and model), `<sessionId>/workflows/<wf>.json` (`workflowName`, `status`, `agentCount`, `durationMs`).
- Live registry: `~/.claude/sessions/<pid>.json` has `status` (`busy`/`idle`), `kind` (`interactive`/`bg`), `entrypoint`, `name`, `updatedAt` for interactive and background sessions. **Unattended `claude -p` runs are not listed there** (checked: a running `-p` session had no file). Never read the `.key` files.
- `claude agents` is reported to list only interactive and daemon sessions (not checked); `~/.claude/jobs/` exists only for daemon (`--bg`) sessions.
- `claude -p` prints its answer only when it finishes, so its attempt log is empty while running.

## Records
One JSON object per line. Useful types: `user` (prompt text, or `tool_result` blocks), `assistant` (blocks: `text`, `tool_use`, `thinking`), `attachment`, bookkeeping types to ignore. Every record has an ISO `timestamp` in **UTC**.

## Tokens
- `assistant.message.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
- One API message is written as several records with the same `message.id` and repeated usage (observed: 225 records for 112 messages). Take the max of each field per `message.id`, then sum. Verified against an independent computation.
- Cache reads are re-reads of the stored context on every call, so they dwarf the rest; show them separately. Subagent usage lives in the subagent files; the viewer adds it to the session total.
- There is no money cost in transcripts, only token counts.

## Finished or not (v2: evidence, not a guess)
- The transcript alone cannot prove that a job finished or failed. A normal end leaves a last `assistant` record with `stop_reason: end_turn`, but so does a session that is simply waiting for the user. The monitor therefore reports `IDLE` for that and reserves `COMPLETED`/`FAILED` for external evidence (the launcher's log with exit codes, matched to sessions by label and start time). Rules: `docs/api.md`.
- `stop_reason: tool_use` (or a `tool_use` block without a later `tool_result`) while quiet means a call is pending: running within a grace period, `UNKNOWN` afterwards (killed, crashed, waiting for permission, or a very long tool).
- **A turn can end while background work still runs.** A session that started a Workflow ends its turn and sleeps until the workflow reports back, so the main file goes quiet while subagent files are still written. Any subagent file written in the last minute keeps the parent `RUNNING` (observed: a part session with 10 subagents looked finished 7 minutes into its run).
- `~/.claude/sessions/<pid>.json` (`sessionId`, `status` busy/idle, `pid`) is used as extra evidence for interactive sessions only when its pid is alive (liveness is checked without signalling the process).

## Size
Transcripts reach tens of MB (one session was 70 MB). Read incrementally from a byte offset, cut at the last newline; load only a tail window of events at first and report that the view is partial; scan tokens progressively and report partial totals until the scan reaches the end.
