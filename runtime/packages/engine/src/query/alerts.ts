// `listAlerts` and `alertRules` (03 6.1, 10.1, 10.3, 12.1): the stored alerts, newest firing first, and the configured rules.
// Alerts are read-only here; they are written by the alert service (WP-59) and resolve when their condition clears.
import {
  ALERT_RULE_KINDS,
  type AlertItem,
  type AlertListQuery,
  type AlertRuleKind,
  type AlertRulesView,
  type AlertRuleView,
  type Page,
} from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import type { AlertRow } from '../db/repos/alerts.ts';
import type { QueryDeps } from '../runtime/context.ts';
import { toAlertItem } from './health.ts';
import {
  Binder,
  filterOf,
  flatRecord,
  numericKey,
  pageOf,
  readCursor,
  snapshot,
  writeCursor,
  type PageSpec,
} from './transitions.ts';

export interface AlertQueries {
  listAlerts(ctx: RepoContext, q: AlertListQuery): Page<AlertItem>;
  alertRules(ctx: RepoContext): AlertRulesView;
}

type DbRow = Omit<AlertRow, 'detail'> & { detail: string; sessionUid: string | null };

const ALERT_COLUMNS = `a.id AS id, a.rule_id AS ruleId, a.rule_kind AS ruleKind, a.scope_kind AS scopeKind,
  a.scope_key AS scopeKey, a.session_id AS sessionId, a.severity AS severity, a.status AS status, a.title AS title,
  a.detail AS detail, a.first_fired_at AS firstFiredAt, a.last_fired_at AS lastFiredAt, a.fire_count AS fireCount,
  a.resolved_at AS resolvedAt, a.resolved_reason AS resolvedReason, a.updated_seq AS updatedSeq,
  s.session_uid AS sessionUid`;

/** The stored alerts that match `where` (terms over `alerts a`), newest firing first: at most `limit` rows. */
export function selectAlerts(
  db: InstanceDb,
  where: readonly string[],
  bind: Binder,
  limit: number,
): { row: DbRow; item: AlertItem }[] {
  const rows = db.driver
    .prepare<DbRow>(
      `SELECT ${ALERT_COLUMNS} FROM alerts a LEFT JOIN sessions s ON s.id = a.session_id
        ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
        ORDER BY a.last_fired_at DESC, a.id DESC LIMIT ${bind.bind(limit)}`,
    )
    .all(bind.params);
  return rows.map((row) => ({
    row,
    item: toAlertItem({ ...row, detail: flatRecord(row.detail) }, row.sessionUid ?? undefined),
  }));
}

/** Where each rule keeps its state (03 10.1, column "Scope key"). */
const SCOPE_KIND: Readonly<Record<AlertRuleKind, AlertRuleView['scopeKind']>> = {
  inactivity: 'session',
  ingest_errors: 'code',
  runtime_unavailable: 'instance',
  token_threshold: 'session',
  import_lag: 'instance',
  db_disk: 'instance',
  hook_gap: 'session',
  hook_failing: 'instance',
};

type Setting = AlertRuleView['settings'][string];

function isSetting(value: unknown): value is Setting {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export function createAlertQueries(db: InstanceDb, deps: QueryDeps): AlertQueries {
  return {
    listAlerts: (ctx, q) =>
      snapshot(db, ctx, (asOfSeq) => {
        const spec: PageSpec = { route: 'listAlerts', sort: 'lastFiredAt', dir: 'desc', filter: filterOf(q) };
        const resume = readCursor(q.cursor, spec);
        const bind = new Binder();
        const where = [`a.status IN ${bind.list(q.status)}`];
        if (q.severity !== undefined) where.push(`a.severity IN ${bind.list(q.severity)}`);
        if (q.rule !== undefined) where.push(`a.rule_kind IN ${bind.list(q.rule)}`);
        if (q.session !== undefined) where.push(`s.session_uid IN ${bind.list(q.session)}`);
        if (resume !== null) {
          const k = bind.bind(numericKey(resume));
          where.push(`(a.last_fired_at < ${k} OR (a.last_fired_at = ${k} AND a.id < ${bind.bind(resume.i)}))`);
        }
        const found = selectAlerts(db, where, bind, q.limit + 1);
        const page = found.slice(0, q.limit);
        const last = page[page.length - 1];
        const nextCursor =
          found.length > q.limit && last !== undefined
            ? writeCursor(spec, last.row.lastFiredAt, last.row.id, null)
            : null;
        return pageOf(
          page.map((entry) => entry.item),
          { nextCursor, asOfSeq, limit: q.limit },
        );
      }),

    alertRules: (ctx) =>
      snapshot(db, ctx, (asOfSeq): AlertRulesView => {
        const { alerts } = deps.config.runtime;
        const open = new Map<string, number>();
        for (const row of db.driver
          .prepare<{ ruleId: string; n: number }>(
            "SELECT rule_id AS ruleId, count(*) AS n FROM alerts WHERE status = 'open' GROUP BY rule_id",
          )
          .all()) {
          open.set(row.ruleId, row.n);
        }
        const rules = ALERT_RULE_KINDS.map((kind): AlertRuleView => {
          const configured: Record<string, unknown> = { ...alerts.rules[kind] };
          const settings: AlertRuleView['settings'] = {};
          for (const [key, value] of Object.entries(configured)) {
            if (key !== 'enabled' && isSetting(value)) settings[key] = value;
          }
          return {
            ruleId: kind,
            rule: kind,
            enabled: configured['enabled'] === true,
            scopeKind: SCOPE_KIND[kind],
            settings,
            openCount: open.get(kind) ?? 0,
          };
        });
        return { asOfSeq, enabled: alerts.enabled, sweepSeconds: alerts.sweepSeconds, rules };
      }),
  };
}
