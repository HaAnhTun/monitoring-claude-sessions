# ADR 0013: Installed hook events and async registration of tool events

Status: Proposed (Phase 1 design, 2026-10-11). Version-sensitive: Claude Code 2.1.289. Design reference: sections 2.4, 3.3.

## Context

Claude Code 2.1.289 knows 33 hook events. Some must never get a silent monitor handler (WorktreeCreate replaces git worktree
creation and needs printed output; PreModelSwitch blocks the switch on timeout; MessageDisplay delays display). A synchronous
Node handler costs about 70 ms per event on this machine, and every tool call fires PreToolUse, PostToolUse (or
PostToolUseFailure) and PostToolBatch. Async hooks do not delay the agent but are cancelled at `-p` teardown if still running.

## Decision

- Install exactly 21 events: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse,
  PostToolUseFailure, PostToolBatch, Notification, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure,
  TeammateIdle, PreCompact, PostCompact, PostModelSwitch, CwdChanged, SessionEnd. No matcher (all tools).
- Register PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch with `async: true` (and argv `--async`); all lifecycle
  events stay synchronous. `mcs hooks install --sync-tool-events` installs everything synchronous.
- Never install WorktreeCreate, WorktreeRemove, MessageDisplay, PreModelSwitch, Elicitation, ElicitationResult, FileChanged,
  Setup, ConfigChange, InstructionsLoaded, UserPromptExpansion, DirectoryAdded.

## Consequences

- About 0.2 s per tool call is removed from the agent loop. The last tool events of a `-p` run can be lost when the process
  exits; transcripts recover them (tool rows merge both sources) and the coverage check ignores the last 5 s before SessionEnd.
- Async tool events can be stamped tens of ms out of order; the lifecycle model uses prompt/stop hooks for turn boundaries and
  `tool_use_id` for tool rows, so this cannot change states (design 7.4, test L2).
- Re-check this list on every Claude Code minor version (the docs already describe 2.1.290-2.1.296 additions).

## Alternatives rejected

- All synchronous: about 0.2 s per tool call on every monitored session (thousands of calls per long session).
- All async: Stop and SessionEnd would be cancelled at `-p` teardown (observed in the lab), losing the most important signals.
- Registering every event: breaks worktrees and model switches, slows display.

## Evidence

- `docs/research/claude-code-hooks.md` sections 1, 3.2-3.3, 4, 10 (docs fetched 2026-10-11; lab runs on Claude Code 2.1.289;
  async Stop observed `cancelled` in run4).
- E1 `D:/mvp/private/scratch/mcs-v3/ingestion/e1/bench.mjs`, 2026-10-11, Node 24.14.1: 65-72 ms median per synchronous handler.

## Requirements covered

Master brief MEGA-PROMT-V3 sections 5 (research the current hook specification, do not install unsupported hooks or invent fields, avoid blocking normal agent execution).

## Open items

OI-1, OI-2 (subagent and workflow tool events), OI-5 (live reload); re-check the event list on each Claude Code minor version. Plans: design `02-ingestion-lifecycle.md` section 12.

## Phase 2+ task slices

I-1 (`INSTALLED_HOOK_EVENTS`, `ASYNC_HOOK_EVENTS`), I-9 (installer). Slice table: design section 13.
