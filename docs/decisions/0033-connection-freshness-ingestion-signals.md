# 0033 Three separate signals: connection, freshness, ingestion; stale outline instead of opacity dimming

Status: Proposed (Phase 1, 2026-10-11). Owner: UI design (`docs/design/04-ui.md` sections 5.6, 6.1).

## Context
Brief 10: "Do not treat WebSocket connectivity as proof that ingestion is healthy" and "a disconnected UI visibly indicates that its data
may be stale". The legacy page derived health from per-endpoint poll success and dimmed stale content to opacity 0.6.

## Decision
- **Connection** (client-observed): `connecting | live | polling | reconnecting | offline`, computed by a pure function from the stream
  snapshot, endpoint records (legacy `computeHealth` thresholds) and `navigator.onLine`.
- **Freshness** (client-observed): `stale` when `now - lastSyncAt > staleAfterMs` (single default 15000 ms from `@mcs/shared`).
  `lastSyncAt` = last heartbeat with `headSeq === lastSeq` or last applied batch while live; otherwise the oldest core endpoint success.
- **Ingestion** (server-computed only): `health.ingestion.status`; shown as "unknown (last known X, N s ago)" whenever the client is not
  in sync. The UI never infers ingestion health from the stream.
- Stale data stays visible, marked by a dashed outline in the stale tone and an "as of HH:MM:SS (N s ago)" line; text colours are not
  reduced.

## Consequences
- The top bar has two chips (connection, ingestion); tests cover a matrix of combinations.
- The server must provide ingestion status and reasons in `/health` and push `health` changes on the stream.
- Legacy opacity dimming is deliberately replaced.

## Alternatives rejected
- One combined "health" chip: hides which layer is failing (the CCAM docs' four-question model separates producer, receiver, storage and
  client).
- Keep opacity 0.6 dimming: fails WCAG 1.4.3.

## Evidence
- Contrast calculation 2026-10-11 (`D:/mvp/private/scratch/mcs-v3/ui/contrast.mjs`, WCAG 2 luminance): legacy muted text at opacity 0.6
  over surface = 2.83:1 (light), 3.35:1 (dark); at 0.55 = 2.54:1 (light).
- Legacy behaviour: `src/frontend/modules/health.js` (`computeHealth`), `styles.css` dim rule (opacity 0.6), research
  `current-state-frontend.md` section 1.6; stale default mismatch 15000 vs 20000 (`config/defaults.json:23`, `app.js:25`).
- `docs/research/ccam-docs-analysis.md` section 5 (pipeline health is a separate concern from client updates).
