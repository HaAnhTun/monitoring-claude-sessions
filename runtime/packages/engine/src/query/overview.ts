// `overview` (03 8.1, 10.3, 12.1): the metric catalogue of the instance, the newest events and problems of the window and
// the open alerts, read inside one synchronous step (DA-I8). The `source` and `rule` of every metric are fixed English texts
// (the UI shows them in an info tip). No metric is made up: a row exists only when its source does. The state tiles use the
// session filter of `listSessions` (03 5.4: the window overlaps by `last_activity_at`, pinned sessions join `window=1`,
// unmatched sessions need `includeUnmatched`), so a tile equals the total of the matching `listSessions` (DA-T-API-1).
//
// WP-58 adds the `tokens.*` and `cost.*` rows (03 8.2, 8.3) through `registerMetricProvider`, in its block at the end of
// this file; the metrics of a provider come between `events.errors` and `alerts.open`, the order of the table of 8.1.
import {
  ACTIVE_STATES,
  isoMsZ,
  type EventListQuery,
  type IsoTime,
  type Metric,
  type Overview,
  type OverviewQuery,
} from '@mcs/shared';

import type { SqlValue } from '../db/driver.ts';
import type { InstanceDb, RepoContext } from '../db/open.ts';
import { AlertsRepo } from '../db/repos/alerts.ts';
import type { QueryDeps } from '../runtime/context.ts';
import { selectAlerts } from './alerts.ts';
import { createEventQueries } from './events.ts';
import { Binder, resolveWindow, snapshot, type Window } from './transitions.ts';

export interface OverviewQueries {
  overview(ctx: RepoContext, q: OverviewQuery): Overview;
}

// ---- the extension point of WP-58 ----------------------------------------------------------------------------------------

/** What a provider may read: it runs inside the snapshot of the overview, so everything it reads agrees with `asOfSeq`. */
export interface MetricProviderInput {
  readonly db: InstanceDb;
  readonly ctx: RepoContext;
  readonly deps: QueryDeps;
  readonly window: Window;
  readonly asOfSeq: number;
  /** The time stamp of every metric (`Metric.asOf`). */
  readonly asOf: IsoTime;
  /** The unmatched sessions are part of the answer (`includeUnmatched=1` or the monitor setting). */
  readonly includeUnmatched: boolean;
}

export type MetricProvider = (input: MetricProviderInput) => Metric[];

const providers: MetricProvider[] = [];

/** Adds metric rows to every overview made afterwards. Returns the function that removes the provider again (tests). */
export function registerMetricProvider(provider: MetricProvider): () => void {
  providers.push(provider);
  return () => {
    const index = providers.indexOf(provider);
    if (index >= 0) providers.splice(index, 1);
  };
}

// ---- the catalogue (03 8.1) ---------------------------------------------------------------------------------------------------

interface MetricSpec {
  readonly key: string;
  readonly label: string;
  readonly source: string;
  readonly rule: string;
  readonly link: string;
}

const SESSION_SOURCE = 'sessions.state';

const SPEC = {
  active: {
    key: 'sessions.active',
    label: 'Active sessions',
    source: SESSION_SOURCE,
    rule: 'sessions in window with state running, working, waiting_tool or waiting_agent',
    link: '/sessions?state=active',
  },
  waitingInput: {
    key: 'sessions.waiting_input',
    label: 'Waiting for input',
    source: SESSION_SOURCE,
    rule: 'state = waiting_input',
    link: '/sessions?state=waiting_input',
  },
  turnEnded: {
    key: 'sessions.turn_ended',
    label: 'Turn ended',
    source: SESSION_SOURCE,
    rule: 'state = turn_ended',
    link: '/sessions?state=turn_ended',
  },
  completed: {
    key: 'sessions.completed',
    label: 'Completed',
    source: SESSION_SOURCE,
    rule: 'state = completed (only from SessionEnd, daemon job or attempts evidence, D9)',
    link: '/sessions?state=completed',
  },
  failed: {
    key: 'sessions.failed',
    label: 'Failed',
    source: SESSION_SOURCE,
    rule: 'state = failed',
    link: '/sessions?state=failed',
  },
  stale: {
    key: 'sessions.stale',
    label: 'Stale',
    source: SESSION_SOURCE,
    rule: 'state = stale',
    link: '/sessions?state=stale',
  },
  unknown: {
    key: 'sessions.unknown',
    label: 'Unknown',
    source: SESSION_SOURCE,
    rule: 'state = unknown',
    link: '/sessions?state=unknown',
  },
  agentsRunning: {
    key: 'agents.running',
    label: 'Running agents',
    source: 'agents.state',
    rule: 'subagents and workflow agents (not main, not internal) of sessions in window in an active state',
    link: '/sessions?state=active',
  },
  errors: {
    key: 'events.errors',
    label: 'Errors',
    source: 'events.severity',
    rule: 'events with severity error and ts in window',
    link: '/activity?severity=error',
  },
  alertsOpen: {
    key: 'alerts.open',
    label: 'Open alerts',
    source: 'alerts.status',
    rule: 'status open',
    link: '/settings?section=health',
  },
} as const satisfies Record<string, MetricSpec>;

function countMetric(spec: MetricSpec, value: number, asOf: IsoTime): Metric {
  return {
    key: spec.key,
    label: spec.label,
    value,
    unit: 'count',
    source: spec.source,
    rule: spec.rule,
    completeness: 'complete',
    asOf,
    link: spec.link,
  };
}

// ---- reading ---------------------------------------------------------------------------------------------------------------

/** The sessions of the window, over `sessions s`: the filter of `listSessions` without its optional filters. */
function sessionsInWindow(window: Window, includeUnmatched: boolean, bind: Binder): string[] {
  const where: string[] = [];
  if (window.fromMs !== null) {
    // `window=1` always includes the pinned sessions (6.3, legacy `session_ids`)
    const pinned = window.source === 'window_hours' ? ' OR s.pinned = 1' : '';
    where.push(`(s.last_activity_at >= ${bind.bind(window.fromMs)}${pinned})`);
  }
  where.push(`s.started_at < ${bind.bind(window.toMs)}`);
  if (!includeUnmatched) where.push('(s.matched = 1 OR s.pinned = 1)');
  return where;
}

function countOf(db: InstanceDb, sql: string, params: Readonly<Record<string, SqlValue>>): number {
  return db.driver.prepare<{ n: number }>(sql).get(params)?.n ?? 0;
}

/** The time of the window as the events query takes it: a custom range, or `all` without a lower bound. */
function eventTime(window: Window): Pick<EventListQuery, 'range' | 'from' | 'to'> {
  return window.fromMs === null ? { range: 'all' } : { from: isoMsZ(window.fromMs), to: isoMsZ(window.toMs) };
}

export function createOverviewQueries(db: InstanceDb, deps: QueryDeps): OverviewQueries {
  const events = createEventQueries(db, deps);
  const alertRepo = new AlertsRepo(db);

  return {
    overview: (ctx, q) =>
      snapshot(db, ctx, (asOfSeq): Overview => {
        const nowMs = deps.now();
        const asOf = isoMsZ(nowMs);
        const window = resolveWindow(deps, q, 'window', null);
        const includeUnmatched = q.includeUnmatched === true || deps.config.monitor.include_unmatched;

        const states = new Map<string, number>();
        const sessionBind = new Binder();
        for (const row of db.driver
          .prepare<{ state: string; n: number }>(
            `SELECT s.state AS state, count(*) AS n FROM sessions s
              WHERE ${sessionsInWindow(window, includeUnmatched, sessionBind).join(' AND ')} GROUP BY s.state`,
          )
          .all(sessionBind.params)) {
          states.set(row.state, row.n);
        }
        const inState = (...names: readonly string[]): number =>
          names.reduce((sum, name) => sum + (states.get(name) ?? 0), 0);

        const agentBind = new Binder();
        const agentsRunning = countOf(
          db,
          `SELECT count(*) AS n FROM agents a JOIN sessions s ON s.id = a.session_id
            WHERE ${sessionsInWindow(window, includeUnmatched, agentBind).join(' AND ')}
              AND a.kind NOT IN ('main', 'internal') AND a.state IN ${agentBind.list(ACTIVE_STATES)}`,
          agentBind.params,
        );

        // `severity > 0` lets the partial index of problems answer the count
        const errorBind = new Binder();
        const errorTerms = ['e.severity = 2', 'e.severity > 0', `e.ts < ${errorBind.bind(window.toMs)}`];
        if (window.fromMs !== null) errorTerms.push(`e.ts >= ${errorBind.bind(window.fromMs)}`);
        const errors = countOf(
          db,
          `SELECT count(*) AS n FROM events e WHERE ${errorTerms.join(' AND ')}`,
          errorBind.params,
        );

        const open = alertRepo.countOpen(ctx);
        const base: Metric[] = [
          countMetric(SPEC.active, inState(...ACTIVE_STATES), asOf),
          countMetric(SPEC.waitingInput, inState('waiting_input'), asOf),
          countMetric(SPEC.turnEnded, inState('turn_ended'), asOf),
          countMetric(SPEC.completed, inState('completed'), asOf),
          countMetric(SPEC.failed, inState('failed'), asOf),
          countMetric(SPEC.stale, inState('stale'), asOf),
          countMetric(SPEC.unknown, inState('unknown'), asOf),
          countMetric(SPEC.agentsRunning, agentsRunning, asOf),
          countMetric(SPEC.errors, errors, asOf),
        ];
        const extra = providers.flatMap((provider) =>
          provider({ db, ctx, deps, window, asOfSeq, asOf, includeUnmatched }),
        );

        const time = eventTime(window);
        const alertBind = new Binder();
        return {
          asOfSeq,
          generatedAt: asOf,
          window: {
            from: window.fromMs === null ? null : isoMsZ(window.fromMs),
            // the upper bound of a preset is exclusive and one millisecond past now: show now
            to: isoMsZ(Math.min(window.toMs, nowMs)),
            source: window.source,
          },
          metrics: [...base, ...extra, countMetric(SPEC.alertsOpen, open.warning + open.critical, asOf)],
          recentActivity: events.listEvents(ctx, { limit: 15, ...time }).items,
          recentErrors: events.listEvents(ctx, { limit: 10, severity: ['warning', 'error'], ...time }).items,
          alerts: {
            open: open.warning + open.critical,
            critical: open.critical,
            items: selectAlerts(db, ["a.status = 'open'"], alertBind, 5).map((entry) => entry.item),
          },
        };
      }),
  };
}

// The block of the work package that adds the token and cost rows (see the header). It is empty until that package lands.
// @wp-begin WP-58
// @wp-end WP-58
