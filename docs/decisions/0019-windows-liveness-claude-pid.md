# ADR 0019: Session liveness through the Claude Code pid seen by the hook handler

Status: Proposed (Phase 1 design, 2026-10-11). Version-sensitive: relies on the undocumented env var `CLAUDE_PID`
(observed on Claude Code 2.1.289). Design reference: sections 2.3.1, 7.4 (S-5), 7.8, 7.10.

## Context

Without a SessionEnd (crash, kill, lost hook) a session would stay "working" or "turn ended" until a long abandonment timeout.
CCAM's process-liveness reaping is disabled on Windows. The Claude registry (`~/.claude/sessions/<pid>.json`) lists interactive
sessions only (unattended `-p` runs are not known to be listed). The hook process environment contains `CLAUDE_PID`.

## Decision

- The handler records `claude_pid` from `CLAUDE_PID` (digits only) on every envelope.
- The sweeper probes known pids of sessions with presence `open` every 10 s with `process.kill(pid, 0)` (ESRCH = dead, EPERM =
  alive), emitting `external.pid` facts.
- Trust is asymmetric: a dead pid is high-confidence evidence that the process is gone (rule S-5: `stale/process_gone` after a
  30 s grace that lets a spooled SessionEnd arrive first); an alive pid is medium-confidence (pids are reused on Windows) and only
  prevents `abandoned`.
- If a future Claude Code version drops `CLAUDE_PID`, the handler stores null and the model falls back to the registry and
  timeouts (no code path requires the pid).

## Consequences

- Crashed or killed sessions become visibly `stale (process_gone)` within about 40 s instead of hours, on Windows too, and are
  never reported as completed.
- One `kill(pid, 0)` per open session per 10 s (microseconds).

## Alternatives rejected

- PowerShell/CIM process queries per check: hundreds of ms per call and a console-window risk.
- `process.ppid` of the handler alone: equal to `CLAUDE_PID` for exec-form hooks (E7) but would be a shell for shell-form hooks.
- Native addon for process start times (pid-reuse proof): a new native dependency (D7).

## Evidence

- E7 `D:/mvp/private/scratch/mcs-v3/ingestion/e7/probe.mjs` with `settings.probe.json`, one `claude -p` (Claude Code 2.1.289,
  haiku, temp `--settings`, 0.014 USD), 2026-10-11: on SessionStart, UserPromptSubmit, Stop, SessionEnd, `CLAUDE_PID` ==
  `process.ppid` == the `claude.exe` pid (tasklist), `CLAUDE_CODE_SESSION_ID` == payload `session_id`; after exit
  `process.kill(pid, 0)` threw ESRCH; 1000 probes of a dead pid took 3.9 ms (Node 24.14.1).
- `docs/research/claude-code-hooks.md` section 3.4 (env var names present in every hook process).
- `docs/research/ccam-source-analysis.md` section 5 (no liveness on win32).

## Requirements covered

Master brief MEGA-PROMT-V3 sections 6 (stale state visibly different, missing events never success), 8.8 (runtime unavailable / no activity inputs), foundations C6 (Windows is the primary platform).

## Open items

None; pid reuse is handled by asymmetric trust. Plans: design `02-ingestion-lifecycle.md` section 12.

## Phase 2+ task slices

I-2 (handler records `claude_pid`), I-8 (sweeper pid checks, external pollers). Slice table: design section 13.
