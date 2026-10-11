# 0031 Read-only UI; server state in TanStack Query with instance-scoped keys; transcript window as a reducer

Status: Proposed (Phase 1, 2026-10-11). Owner: UI design (`docs/design/04-ui.md` sections 1, 5.1-5.5).

## Context
The UI shows data from one monitoring instance (D2) through API v3 (D11). It must reconcile realtime changes without duplicates, never
mix instances (a port can be reused by another instance after a restart), and avoid duplicating business logic (brief 11). Mutations
(export, backup, cleanup, hooks install) are destructive or security-relevant and already exist as CLI commands.

## Decision
1. The UI is read-only: only `GET` requests and one `EventSource`. Settings shows exact CLI commands (provided by the server) with copy
   buttons instead of buttons that mutate.
2. Server state is held in TanStack Query 5.104.1. Every key starts with `['mcs', instanceId]`. A changed `instanceId` (stream `hello`
   or `/instance`) removes all `mcs` queries and shows a notice.
3. Lists use `useInfiniteQuery` with opaque cursors, `maxPages`, and `keepPreviousData` for filter changes.
4. Entities carry `seq`, snapshots carry `asOfSeq`; patches apply only when newer; a bounded patch ledger re-applies patches over late
   snapshots (rules R1-R5 in 04-ui section 5.5).
5. The provider-native transcript is not a TanStack query: it is an index-addressed, append-only window managed by a pure reducer ported
   from the legacy client (`mergeEvents`, generation guard, window replace, reset detection).
6. Responses are validated in the browser with the shared zod schemas from `@mcs/shared` (contract errors become a distinct error kind).

## Consequences
- No CSRF surface; Host/Origin checks remain the only server guard needed for the UI.
- Two caching mechanisms exist (query cache and transcript reducer); both are covered by unit tests.
- About 23.5 kB gzip for zod in the bundle (measured), accepted for contract safety on a local tool.

## Alternatives rejected
- Hand-written fetch hooks: re-implements dedupe, abort, infinite pages, invalidation (stack-versions section 5).
- Redux/Zustand/SWR: extra dependency with no extra capability (avoid list).
- Mutation endpoints in the UI: expands the attack surface of a loopback tool and duplicates CLI logic.
- Transcript as an infinite query: index windows, window replacement on jump and reset detection do not map onto page arrays.

## Evidence
- `docs/research/stack-versions.md` section 5: TanStack smoke test (`useInfiniteQuery` + `invalidateQueries` -> exactly one refetch).
- Scratch 2026-10-11 (`D:/mvp/private/scratch/mcs-v3/ui`): query-core 5.104.1 declares `maxPages?: number`; `keepPreviousData` exported.
- Bundle measurement 2026-10-11 (Vite 8.3.4): React only 68.3 kB gzip, React + zod 4.6.5 91.9 kB gzip.
- Legacy reducer logic: `src/frontend/modules/timeline-model.js`, `src/frontend/app.js` (generation guard).
