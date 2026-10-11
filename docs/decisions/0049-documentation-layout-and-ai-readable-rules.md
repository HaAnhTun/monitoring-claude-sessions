# 0049 Documentation layout: lowercase-kebab docs, legacy docs in `docs/legacy/`, AI-readable rules

Status: Proposed (Phase 1, 2026-10-11). Owner: documentation plan (05 section 6).

## Context
The brief (section 15) names upper-case files (`docs/ARCHITECTURE.md`, ...) and allows adapting names to the repository convention. The
skill repo uses lowercase names (`docs/api.md`, `docs/architecture.md`, ...) for the legacy engine; D1 decides that legacy docs move to
`docs/legacy/` and the new docs take the names. Future agents must answer eleven questions quickly (brief section 15).

## Decision
- Final set: `SKILL.md`, `docs/{architecture,data-model,configuration,hooks,api,instance-isolation,operations,testing,migration,
  ccam-reference,traceability}.md`, `docs/decisions/`, `docs/legacy/` (moved legacy docs with a banner line).
- Every doc: purpose line, "Applies to", "Read next"; claims cite a code path, schema or test; tables and numbered steps; ends with
  "Invariants" (with test ids) and "Safe to change independently / Change together"; generated sections marked.
- `scripts/check-docs.mjs` gate: required docs and headings exist, relative links and backticked repo paths resolve; `check-text` gate:
  English-only and no private data.
- `reference/*.md` link edits need the lead's approval (C1); otherwise pointer lines in the new docs keep old links useful.

## Consequences
- Old links (`docs/api.md`) resolve to the new runtime docs, which point to `legacy/` for the Python engine.
- Doc drift is caught mechanically for paths and links, not for prose.

## Alternatives rejected
- Upper-case names from the brief: break the repository convention and every existing link.
- Keeping legacy docs in place with new names elsewhere: two "api" documents at the same level confuse agents.

## Evidence
- 2026-10-11: link inventory with `grep` over `SKILL.md`, `reference/*.md`, `docs/*.md` (design 05 section 6.4): links into the moved
  docs exist in `SKILL.md` (lines 20, 48), `reference/transcript-format.md:22`, `reference/viewer-reference.md:3`; legacy docs link each
  other by bare file name. Foundations D1 (2026-10-11).
