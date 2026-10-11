# 0027 Alerts: configured rules with DB state, de-duplication, cooldown and expiry; no acknowledgement; outbound webhooks deferred

Status: Proposed (Phase 1, 2026-10-11). Owner: data/API design (`docs/design/03-data-api-realtime.md` section 10). Inputs from
`02-ingestion-lifecycle.md` 8.3.

## Context
Brief 8.8 asks for a few useful local alerts (no activity, repeated ingestion errors, runtime unavailable, token threshold, transcript
import lag, DB/disk errors) and allows webhooks only later, with explicit configuration and secret protection. The API and the UI are
read-only, so an acknowledgement would need a mutation route. Design 02 publishes alert inputs (repeated error codes, downtime
reconciliations, import lag, hook gaps, failing handler, DB errors).

## Decision
- Eight built-in rules (`inactivity`, `ingest_errors`, `runtime_unavailable`, `token_threshold`, `import_lag`, `db_disk`, `hook_gap`,
  `hook_failing`) configured in `runtime.json` `alerts` (validated, audited by `mcs configure`); no rule CRUD in the API.
- State in `alerts` (at most one open alert per rule and scope through a partial unique index) and `alert_state` (condition start,
  cooldown); severities `warning`/`critical`; an alert resolves when its condition clears (or `expired` for the historical
  `runtime_unavailable`), then a cooldown suppresses re-firing. No acknowledgement.
- Evaluation after the triggering transaction commits (never inside ingestion; failures recorded, never propagated), plus a sweep every
  60 s and a startup check.
- Exposure: `GET /alerts`, `GET /alerts/rules`, health and overview summaries, stream `alert/upsert`.
- Webhooks are not built; the future safe design is recorded in the design doc (10.4).

## Consequences
- No alert spam: change rows only on insert, resolve or severity change.
- `ingest_errors` counts come from per-occurrence DB rows, so they survive restarts.
- `token_threshold` fires on lower-bound totals: possibly late, never early.

## Alternatives rejected
- Acknowledgement through an HTTP POST: a mutation surface in a read-only API for little value (alerts resolve by themselves).
- Rules as API-editable DB records: unaudited changes.
- Evaluating inside the ingest transaction: an alert bug could block ingestion.
- Webhooks now: out of scope (D15).

## Evidence
- 2026-10-11, `ddl2-check.mjs` (final schema): the partial unique index `ux_alerts_live` rejected a second open alert for the same rule
  and scope; ingest errors by code in a window used a covering index (0.01 ms); reconciliations by kind likewise (0.01 ms).
- `misc-probes.mjs`: `fs.statfs` returns free space on Windows (input of `db_disk`).
