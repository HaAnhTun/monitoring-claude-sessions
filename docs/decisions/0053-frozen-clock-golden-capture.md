# ADR 0053: Legacy goldens captured in-process under a frozen clock, stored raw, with a drift check

Status: Proposed (Phase 1, 2026-10-11; amended after the critic review, issue I-09). Design reference:
`docs/design/06-panels-parity-platform.md` section 5.2. Relationship with ADR 0044 / design 05 4.11.4: this is the single golden-capture
procedure; 05 adopts it, keeping its command `npm run parity:capture` (a wrapper), live mode and test-time projections, and dropping the
10 s age buckets.

## Context
The Python engine is the parity oracle and is read-only (C1). Its outputs depend on wall time (`time.time`), random uuids
(`make.py`, `demo.py`), `datetime.now`, file mtimes, the local zone (chain-log `mktime`) and temp paths. Bucketing ages hides
boundary behaviour (`active_seconds`, grace) that parity must prove.

## Decision
- `tests/legacy-parity/tools/capture_golden.py` (stdlib only, re-execs with `-B`): sets `TZ` (default UTC); replaces `time.time` with
  `FROZEN_NOW = 1790000000`, `uuid.uuid4` with a counter (`%08x-0000-4000-8000-%012x`), `datetime.now` via a subclass injected into
  `make`, `demo`, `tasks`; builds the legacy trees (`make.build_home`, `demo.build`) plus generator panel/rule/registry trees and any
  testkit tree passed with `--trees`; pins untouched mtimes to `FROZEN_NOW`; serves each tree with the legacy `Server` in-process on
  127.0.0.1:18850-18874; stores raw `[status, body]` responses, CLI workspace files, L1 function vectors and tree manifests under
  `tests/legacy-parity/golden/`; normalises only temp-dir spellings, `config_hash`, pids, ports and `code_stamp`.
- `--check` regenerates in a temp dir and fails on any byte difference (first differing JSON pointer printed).
- Ownership: design 06 slice PP2 owns `tests/legacy-parity/tools/**`, `tests/legacy-parity/golden/**` and `tests/legacy-parity/README.md`;
  design 05 slice S8 owns `runtime/tests/parity/{projections,normalize,run-python}.ts` and `runtime/scripts/parity-capture.mjs`, which
  runs `python -B tests/legacy-parity/tools/capture_golden.py` (and `--check`) and forwards the exit code.

## Consequences
- Exact ages, states and token values are comparable; projections can change without recapture.
- Goldens are captured on Windows (legacy text-mode files are CRLF there) with a recorded Python minor version.

## Alternatives rejected
- Real-now capture with 10 s age buckets (05 4.11.4): loses boundary checks. Patching the legacy code for a clock: violates C1.
- Capturing from real transcripts: private data.

## Evidence
2026-10-11, Python 3.14.3, legacy 2.0.2: `D:/mvp/private/scratch/mcs-v3/panels-parity/capture_golden_dry.py` run twice, outputs
byte-identical after fixing untouched mtimes, absolute paths in `demo.config.json`, short/long temp names and `config_hash` (E12);
`git status --short` of the skill clean before and after; `TZ=UTC` honoured by Python on Windows (E13).

## Requirements covered
Brief 13 Phase 6 (compare session detection and token aggregates), 14 (regression tests), foundations open question 6.

## Open items
None (former OI-4 closed by critic issue I-09).

## Phase 2+ task slices
PP2 (generator), PP4 (parity skeleton). Slice table: design section 13.
