# ADR 0011: Route hook events to instances through per-user route files

Status: Proposed (Phase 1 design, 2026-10-11). Answers foundations open question 5. Design reference: section 2.6.

## Context

One handler command serves every instance (D2: one process and DB per instance). An event must reach exactly the instances
whose scope contains the session. The legacy scope of an instance is the Claude project folder (`transcripts_dir`, detected
from the repo path or configured), plus pinned `session_ids`. Hooks may be installed per project (`settings.local.json`) or for
the user (every session on the machine). The handler must stay cheap (it runs per event) and cannot evaluate Python-syntax
session rules or detect transcript folders.

## Decision

- Each instance has one file `$MCS_HOME/routes/<instanceId>.json` (`HookRouteV1`: `workspace`, `spoolDir`, `stateFile`,
  `enabled`, `match.transcriptsDirs`, `match.sessionIds`, `stoppedAt`, `spoolUntil`, `updatedAt`), written atomically by the
  server at start (resolved and predicted transcript folders), at stop (`stoppedAt`, `spoolUntil` = now + 72 h by default), by
  `mcs stop`/`configure`, and removed with the instance. Single writer per file, so no lost updates.
- The handler reads all route files (<= 64, each <= 16 KiB) and matches by `dirname(transcript_path)` (backslashes normalized,
  case-insensitive on win32), else by pinned session id, else by the sanitized `cwd` when no transcript path is present.
- `MCS_HOME` = env `MCS_HOME`, else `%LOCALAPPDATA%/mcs` on Windows, else `$XDG_STATE_HOME/mcs` or `~/.local/state/mcs`.
- Session rules are applied by the server, not the handler: every session of the folder is stored with `matched` true/false,
  as the legacy engine lists unmatched sessions on request.

## Consequences

- Works identically for project-local and user scope, and for instances whose `transcripts_dir` points outside their repo.
- Cost per event: readdir + N small reads (E1: 5 ms in-script for 10 routes, including stdin parse).
- A stopped instance keeps receiving envelopes for a bounded time, so SessionEnd reasons are not lost while it is down.
- Route files contain only local paths and ids, never session data.

## Alternatives rejected

- Scanning `CLAUDE_PROJECT_DIR/.claude/monitor/tasks/*` per event: needs config parsing, regex translation and transcript-folder
  detection in the handler; misses instances whose `transcripts_dir` is elsewhere.
- One shared per-repo or per-user index file: several writers (servers, CLI) would race on read-modify-write.
- Routing by `session_id` lookups against the DB: the handler must never open the DB (D10).

## Evidence

- E1 `D:/mvp/private/scratch/mcs-v3/ingestion/e1/bench.mjs`, 2026-10-11, Node 24.14.1: 10 route files, no match, 65 ms wall
  median, 5.1 ms in-script.
- E7 `D:/mvp/private/scratch/mcs-v3/ingestion/e7/probe.mjs`, Claude Code 2.1.289, 2026-10-11: `CLAUDE_PROJECT_DIR` equals payload
  `cwd`; `transcript_path` ends with `<session_id>.jsonl` (also `docs/research/claude-code-hooks.md` verification log).
- Project folder naming rule: `docs/research/transcript-survey.md` section 1 (2026-10-11).

## Requirements covered

Master brief MEGA-PROMT-V3 sections 4 (instance routing identity, isolation), 5 ("attach the appropriate instance/project routing identity", "deliver events to the intended runtime"), foundations open question 5.

## Open items

None blocking; OI-10 (settings.local.json in subfolders) affects only which sessions fire hooks, not routing. Plans: design `02-ingestion-lifecycle.md` section 12.

## Phase 2+ task slices

I-1 (`HookRouteV1`, `matchRoutes`), I-2 (route reading in the handler), I-4 (route-file writer). Slice table: design section 13.
