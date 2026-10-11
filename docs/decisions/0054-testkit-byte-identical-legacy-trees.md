# ADR 0054: The TypeScript testkit reproduces the legacy fixture trees byte for byte

Status: Proposed (Phase 1, 2026-10-11). Design reference: `docs/design/06-panels-parity-platform.md` sections 5.3, 6.2.

## Context
Parity tests must run without Python in CI, yet sizes, byte offsets, `events_skipped_bytes` and `scanned_pct` depend on the exact bytes
of the legacy fixtures (`tests/fixtures/make.py`, `tests/tools/demo.py`).

## Decision
- `@mcs/testkit` `legacy/*` builders reproduce the trees that `capture_golden.py` builds: `pyDumps` (Python `json.dumps` separators,
  `ensure_ascii=True`, indent mode), `pyIso` (microseconds truncated to milliseconds), the same uuid draw order (documented in
  `legacy/ORDER.md`), LF for JSONL and CRLF for files the legacy builders wrote in text mode on Windows, `utimes` ages from the frozen now.
- `runtime/tests/parity/legacy-trees.parity.test.ts` asserts the manifest (path, size, sha256, age_s) equals `golden/trees/*.manifest.json`.
- A file that cannot be reproduced is listed with its reason in `ORDER.md` and its content is stored under `golden/trees/<scenario>/`
  (invented data only) for the builder to copy.

## Consequences
- Any drift in either builder is caught by one manifest test. The TS builders double as fast fixtures for engine tests.

## Alternatives rejected
- Committing the generated trees: about 1 MB of JSONL and mtimes are lost by git (they need a manifest anyway).
- Approximate trees with tolerance on sizes: hides offset bugs.

## Evidence
2026-10-11: dry-run tree inspection (E21: `chain.log` 378 B, `status.md` 226 B, `demo.config.json` 1,123 B are CRLF; JSONL LF);
`make.py` source (`write_jsonl` uses `newline='\n'`, `iso()` uses `strftime('%f')[:-3]`).

## Requirements covered
Brief 14 (deterministic fixtures, regression coverage), 13 Phase 6.

## Open items
None.

## Phase 2+ task slices
PP3, PP4. Slice table: design section 13.
