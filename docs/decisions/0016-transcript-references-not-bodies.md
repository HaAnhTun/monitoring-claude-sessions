# ADR 0016: Persist transcript metadata and references, never bodies

Status: Proposed (Phase 1 design, 2026-10-11). Design reference: sections 5.6-5.7.

## Context

Transcripts contain prompts, source code, command output, file contents, thinking signatures and, in some records, account ids
(`bridge-session`, `credential_org`). The monitor needs timelines, tool executions, hierarchy, states, tokens and on-demand
transcript context. CCAM stores whole payloads and copies transcripts (privacy, 2 GB databases). Foundations D8 forbids
persisting tool-result bodies, attachment bodies, thinking signatures and account ids.

## Decision

- Each conversational record becomes a `transcript_entry` row with metadata only: kind, ids (uuid, parent, message, tool use,
  agent), timestamps, byte offset and length, line number, sizes, flags, tool name and a redacted 160-code-point tool summary.
- Text is read on demand through `readEntryText(ref)` from the provider file at the stored offset after re-checking the file
  identity; it returns the legacy `events_of` projection with the legacy clips and is not cached beyond the request.
- Never persisted: prompt and assistant text, thinking text and signatures, tool inputs (beyond summary and hash), tool results,
  `toolUseResult` (beyond agent/run ids and status), attachment bodies, `prompt_snapshot`, file-history backups, `bridge-session`,
  organization ids, `last-prompt` text, queue contents, summaries, workflow scripts/results/logs, journal results.
- Labels keep the legacy behavior (rule labels with captured groups; unmatched sessions labelled by 70 code points of the first
  prompt), documented as the one place where prompt text reaches the DB.

## Consequences

- The DB stays small and holds no secrets beyond what labels and redacted summaries carry.
- Transcript search must read files (bounded) or use an explicit, opt-in index; that is the search designer's decision (D10).
- A ref becomes `REF_STALE` if the provider file is replaced; deleted transcripts lose their text, by design.

## Alternatives rejected

- Storing clipped text per entry (or FTS by default): copies private content into the monitor's DB and backups.
- Copying transcripts (CCAM snapshots): duplicates private data with no retention by default.

## Evidence

- `docs/research/transcript-survey.md` sections 2.2, 2.4, 2.5 (record and attachment kinds, account-id records, 2026-10-11).
- `docs/research/ccam-source-analysis.md` sections 1, 4, 6 (whole-payload storage, issue #315, transcript snapshots).
- Privacy test T-TR-16 (sentinels in every never-persisted field must not appear in a DB dump).

## Requirements covered

Master brief MEGA-PROMT-V3 sections 7 (no secrets in the DB, no unbounded copies), 8.3 (transcript context distinct from the event timeline), 12 (sensitive content, untrusted transcript data).

## Open items

None. Plans: design `02-ingestion-lifecycle.md` section 12.

## Phase 2+ task slices

I-5 (record normalizer), I-8 (entry rows, `readEntryText`). Slice table: design section 13.
