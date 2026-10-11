# 0022 Metadata-only database: transcript text stays in the transcript files and is read on demand

Status: Proposed (Phase 1, 2026-10-11). Owner: data/API design (`docs/design/03-data-api-realtime.md` sections 3.1, 7.3).

## Context
Transcripts contain prompts, source code, command output and possibly secrets. The legacy skill rule is "never copy transcript text
into task files", and the DB lives in the task folder. CCAM stores whole hook payloads and reached a 2 GB database (its issue #315,
`docs/research/ccam-source-analysis.md` section 7). The UI still needs transcript context and search.

## Decision
- The DB stores ids, timestamps, kinds, states, counts, token numbers, tool names, model ids, bounded labels (rule label, titles, or the
  first prompt clipped to 70 code points, legacy parity), bounded summaries and previews (160 code points, redacted by design 02's
  sanitizer), the sanitized hook envelope `data` (design 02 field policy, <= 16 KiB), lifecycle facts (stamps, enums, counts, hashes),
  lengths and hash prefixes, and byte references `(file_id, byte_offset, byte_length)` into the transcript files.
- It never stores prompt, reply or thinking text, tool input or result bodies, attachment bodies, signatures, account ids or env values.
- Transcript text is read on demand by the transcript window/locate/search endpoints and is not cached server-side.
- `meta.privacy_profile = 'metadata-v1'` records this; storing content later requires a migration, a new profile and an ADR.

## Consequences
- Small rows (about 340 bytes per event including indexes) and a privacy story that matches the legacy rule.
- When Claude Code deletes a transcript (`cleanupPeriodDays`), its text is gone; the API answers `410 transcript_gone` and searches
  report `filesMissing`.
- Exports contain no transcript text (ADR 0028).

## Alternatives rejected
- Store clipped text per event: duplicates private data into the repo folder and grows the DB by the transcript size.
- Store full hook payloads (CCAM): unbounded growth, secrets at rest.

## Evidence
- 2026-10-11, `ddl-bench.mjs` on 400,000 synthetic events: events table 85 MB plus 51 MB of event indexes (about 340 bytes per event).
- Transcript survey (`docs/research/transcript-survey.md` sections 2.5, 5): `toolUseResult` and attachment bodies can be megabytes;
  lines up to 1.3 MB.
- Scan speed that makes on-demand reading viable: ADR 0023.
