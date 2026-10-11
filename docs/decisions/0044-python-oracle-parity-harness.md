# 0044 Cross-engine parity: the Python engine is the oracle (live dual-run and normalised goldens)

Status: Proposed (Phase 1, 2026-10-11; revised the same day after the design review, critic issue I-09). Owner: tooling design (05
section 4.11) for the Node side; the capture engine is ADR 0053 (design 06 section 5.2). Closes foundations open question 6 for the
capture procedure and the latent-defect list together with ADR 0053 and ADR 0055.

## Context
The brief (section 13, Phase 6) requires comparing old and new session detection and token aggregates. The Python engine stays the
fallback and is read-only; it has no injectable clock (`sessions.py:186` uses `time.time()`), and the v3 API differs from the legacy API
(D11), so raw JSON cannot be diffed.

## Decision
- Compare typed projections (sessions with legacy 5-state, tokens, events, search, attempts, regex acceptance, workspace files) of
  the raw legacy responses with the Node engine's output, field by field per design 06's matrix (5.4); the Node side runs under the
  same frozen clock (`FROZEN_NOW = 1790000000`), so ages and times compare exactly. Node-side normalisation only mirrors the
  generator's placeholders (`<TMP>`, `<MACHINE>`, `<PID>`, `<URL>`, `<PORT>`, `<STAMP>`); no time buckets.
- Capture: design 06's `tests/legacy-parity/tools/capture_golden.py` (ADR 0053) is the only capture engine; goldens live in
  `tests/legacy-parity/golden/{meta.json,trees,api,cli,vectors}`. `npm run parity:capture` / `parity:check` are thin wrappers
  (`runtime/scripts/parity-capture.mjs`) that find Python >= 3.8 and pass the tool's exit code.
- Golden mode (default, no Python): compare with the committed goldens (or `MCS_GOLDEN_DIR`).
- Live mode (`MCS_PARITY_LIVE=1`): capture fresh goldens into a temp dir with the same tool, then run the golden-mode comparisons
  against them. Goldens never come from real transcripts.
- Latent defects PD1-PD7 each have a decision (fix, reproduce, not applicable) and an exact parity assertion; new divergences need a row.
- The executable suite lives in `runtime/tests/parity/` (module resolution); artefacts in `tests/legacy-parity/` (D1).

## Consequences
- Parity runs without Python in CI (golden mode); live mode is part of the release gate on the owner's machine.
- Changing a projection or normalisation rule is a reviewed change to both modes.

## Alternatives rejected
- Diffing legacy endpoint JSON against a Node legacy-compat API: would force keeping legacy endpoints (D11 rejects them).
- Only goldens: drift if the legacy code or the generator changes; live mode and `parity:check` catch it.
- Patching the Python engine to accept a clock: legacy files are read-only (C1); the generator patches `time.time` in its own process.
- Capture at the real `now` with normalised projections and 10 s age buckets (this ADR's first version): hides threshold behaviour
  and needs a recapture for every projection change; superseded by ADR 0053's raw frozen-clock capture.

## Evidence
- 2026-10-11, Python 3.14.3, legacy engine 2.0.2: `viewer.py serve --config <temp> --port 18850` with `CLAUDE_CONFIG_DIR` at a `make.py`
  fixture served `/api/sessions` (5 sessions, documented key set) and wrote nothing into the skill folder (`git status` unchanged);
  stopped after a command-line check (design 05 section 9, E13). Defect list from `docs/research/current-state-backend.md` F.6.5.
- 2026-10-11, Python 3.14.3: design 06's frozen-clock dry run produced byte-identical captures twice (06 section 2, E12; ADR 0053).
