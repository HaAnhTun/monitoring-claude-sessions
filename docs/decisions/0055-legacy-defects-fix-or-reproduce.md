# ADR 0055: Latent legacy defects: an explicit fix-or-reproduce table, asserted by parity tests

Status: Amended by 0066 (proposed Phase 1, 2026-10-11). Design reference: `docs/design/06-panels-parity-platform.md` section 5.8 (D1-D35). Maps design
05's PD1-PD7: PD1 = D1, PD2 = D2, PD3 = D3, PD4 = D4, PD5 = D5, PD6 = D6 + D7 + D20 + D22, PD7 = D18.

## Context
The legacy engine is the oracle, but it has latent defects (research `current-state-backend.md` F.6.5 plus those found here). Copying
them blindly keeps bugs; silently fixing them makes parity tests fail or, worse, get loosened.

## Decision
- Every known divergence has a row with a decision: FIX (Node differs on purpose), REPRODUCE (Node copies the behaviour), or N/A.
- Behaviour changes made by this design: D1 workflow tagging by path segment; D2 absolute repo across drives; D10 JSON summaries of
  non-string keys; D13 booleans are not token counts; D16/D28/D33 full history instead of an 8 MB window; D17 `--no-optional-locks`;
  D20 a later START supersedes an open row (UNKNOWN instead of RUNNING forever); D21 `%z` honoured; D22 an attempt keeps its session
  match after 24 h; D23 docker status instead of a fake row; D25 vanished log files skipped; D26 recursive `**`; D27 BOM stripped;
  D30/D31 global dedupe and `iterations[0]` (foundations D8).
- Reproduced on purpose: D6 24 h attempts window (configurable), D7 several rows per session,
  D11 code-point clipping, D12 25-text overshoot, D24 raw exit text (`00` is non-zero), D29 first record in file order, D34 matched
  candidates only.
- N/A in Node: D3 lenient flat configs (flat configs stay with the legacy engine, design 01 6.5; `config migrate --from-legacy`
  validates strictly, reports dropped keys and refuses untranslatable regexes; no `configWarnings` field; critic N-05). Amended in
  revision 3.
- Each FIX row has a DIFF assertion of the new value in `runtime/tests/parity/diffs.parity.test.ts`; no blanket skips.

## Consequences
- A new divergence cannot land without a row and a test. Legacy-compatible projections (02 6.5, 7.9) remain exact where promised.

## Alternatives rejected
- Bug-for-bug parity: keeps lock contention (D17), stuck RUNNING rows (D20) and double counting (D30).
- Fixing without records: unreviewable drift.

## Evidence
2026-10-11: legacy source lines cited per row in the design; E12 goldens; `transcript-survey.md` 3.3, 3.5 (zeroed usage, resume copies);
E16 (git status cost and the optional lock); E17 (glob semantics).

## Requirements covered
Brief 13 Phase 6 (deliberate replacement documented), 17 (record decisions), 18 (existing functionality preserved or deliberately replaced).

## Open items
None.

## Phase 2+ task slices
PP5, PP7, PP8. Slice table: design section 13.
