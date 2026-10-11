// `alerts` and `alert_state` (03 3.5, 10.2): the stored side of alert evaluation. SQL only: when a rule holds, the
// de-duplication and the cooldown are decided by `AlertService`; this repository stores what it decides. It reserves the
// `alert/upsert` change itself (03 9.1: an alert inserted, resolved or changed in severity), so a row and its change
// cannot drift apart.
import { z } from 'zod';

import type { ALERT_RULE_KINDS, ALERT_SCOPE_KINDS } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';
import { rowLimit } from './transitions.ts';

export type AlertRuleKind = (typeof ALERT_RULE_KINDS)[number];
export type AlertScopeKind = (typeof ALERT_SCOPE_KINDS)[number];
export type AlertSeverity = 'warning' | 'critical';
export type AlertStatus = 'open' | 'resolved';
export type AlertResolvedReason = 'condition_cleared' | 'expired' | 'rule_disabled' | 'scope_deleted';
/** Numbers, short strings and booleans only: titles are fixed templates and details never carry content (03 10.2). */
export type AlertDetail = Record<string, string | number | boolean | null>;

const DetailSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export interface NewAlert {
  ruleId: string;
  ruleKind: AlertRuleKind;
  scopeKind: AlertScopeKind;
  scopeKey: string;
  /** `sessions.id` of a session scoped alert. */
  sessionId: number | null;
  /** The session uid for the change row of a session scoped alert. */
  sessionUid: string | null;
  severity: AlertSeverity;
  title: string;
  detail: AlertDetail;
  at: number;
}

export interface AlertRow {
  id: number;
  ruleId: string;
  ruleKind: AlertRuleKind;
  scopeKind: AlertScopeKind;
  scopeKey: string;
  sessionId: number | null;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  detail: AlertDetail;
  firstFiredAt: number;
  lastFiredAt: number;
  fireCount: number;
  resolvedAt: number | null;
  resolvedReason: AlertResolvedReason | null;
  updatedSeq: number;
}

interface AlertDbRow extends Omit<AlertRow, 'detail'> {
  detail: string;
}

export interface AlertStateRow {
  ruleId: string;
  scopeKey: string;
  conditionSince: number | null;
  lastValue: number | null;
  lastEvaluatedAt: number;
  cooldownUntil: number | null;
}

const COLUMNS = `id, rule_id AS ruleId, rule_kind AS ruleKind, scope_kind AS scopeKind, scope_key AS scopeKey,
  session_id AS sessionId, severity, status, title, detail, first_fired_at AS firstFiredAt, last_fired_at AS lastFiredAt,
  fire_count AS fireCount, resolved_at AS resolvedAt, resolved_reason AS resolvedReason, updated_seq AS updatedSeq`;

function toRow(row: AlertDbRow): AlertRow {
  let detail: AlertDetail = {};
  try {
    const parsed = DetailSchema.safeParse(JSON.parse(row.detail));
    if (parsed.success) detail = parsed.data;
  } catch {
    // a damaged detail column reads as empty
  }
  return { ...row, detail };
}

export class AlertsRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  /** The one open alert of a rule and scope (`ux_alerts_live`). */
  openFor(ctx: RepoContext, ruleId: string, scopeKey: string): AlertRow | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver
      .prepare<AlertDbRow>(
        `SELECT ${COLUMNS} FROM alerts WHERE rule_id = :ruleId AND scope_key = :scopeKey AND status = 'open'`,
      )
      .get({ ruleId, scopeKey });
    return row === undefined ? undefined : toRow(row);
  }

  byId(ctx: RepoContext, id: number): AlertRow | undefined {
    this.db.assertScope(ctx);
    const row = this.db.driver.prepare<AlertDbRow>(`SELECT ${COLUMNS} FROM alerts WHERE id = :id`).get({ id });
    return row === undefined ? undefined : toRow(row);
  }

  /** Newest firing first. */
  list(ctx: RepoContext, q: { status?: AlertStatus; limit: number }): AlertRow[] {
    this.db.assertScope(ctx);
    const rows =
      q.status === undefined
        ? this.db.driver
            .prepare<AlertDbRow>(`SELECT ${COLUMNS} FROM alerts ORDER BY last_fired_at DESC, id DESC LIMIT :limit`)
            .all({ limit: rowLimit(q.limit) })
        : this.db.driver
            .prepare<AlertDbRow>(
              `SELECT ${COLUMNS} FROM alerts WHERE status = :status ORDER BY last_fired_at DESC, id DESC LIMIT :limit`,
            )
            .all({ status: q.status, limit: rowLimit(q.limit) });
    return rows.map(toRow);
  }

  countOpen(ctx: RepoContext): { warning: number; critical: number } {
    this.db.assertScope(ctx);
    const counts = { warning: 0, critical: 0 };
    const rows = this.db.driver
      .prepare<{ severity: AlertSeverity; n: number }>(
        "SELECT severity, count(*) AS n FROM alerts WHERE status = 'open' GROUP BY severity",
      )
      .all();
    for (const row of rows) counts[row.severity] = row.n;
    return counts;
  }

  /**
   * Inserts an open alert and reserves its `alert/upsert` change. A second open alert for the same rule and scope is a
   * `db_constraint` error (`ux_alerts_live`): the caller checks `openFor` first.
   */
  insertOpen(ctx: RepoContext, tx: WriteTx, a: NewAlert): number {
    this.db.assertScope(ctx);
    const { driver } = this.db;
    const row = driver
      .prepare<{ id: number }>(
        `INSERT INTO alerts (rule_id, rule_kind, scope_kind, scope_key, session_id, severity, status, title, detail,
                             first_fired_at, last_fired_at, fire_count, updated_seq)
         VALUES (:ruleId, :ruleKind, :scopeKind, :scopeKey, :sessionId, :severity, 'open', :title, :detail, :at, :at, 1, 0)
         RETURNING id`,
      )
      .get({
        ruleId: a.ruleId,
        ruleKind: a.ruleKind,
        scopeKind: a.scopeKind,
        scopeKey: a.scopeKey,
        sessionId: a.sessionId,
        severity: a.severity,
        title: a.title,
        detail: JSON.stringify(a.detail),
        at: a.at,
      });
    if (row === undefined) throw new Error('INSERT ... RETURNING answered no row');
    const seq = tx.changes.reserve('alert', 'upsert', { entityId: row.id, sessionUid: a.sessionUid });
    driver.prepare('UPDATE alerts SET updated_seq = :seq WHERE id = :id').run({ seq, id: row.id });
    return row.id;
  }

  /**
   * The rule still holds for an open alert: counts the firing and stores the new detail (and title). Only a change of
   * severity reserves a change row (03 10.2). `undefined` = the alert is not open.
   */
  refire(
    ctx: RepoContext,
    tx: WriteTx,
    id: number,
    f: { at: number; severity: AlertSeverity; detail: AlertDetail; title?: string },
  ): { severityChanged: boolean } | undefined {
    this.db.assertScope(ctx);
    const { driver } = this.db;
    const old = this.openRow(id);
    if (old === undefined) return undefined;
    const severityChanged = old.severity !== f.severity;
    const seq = severityChanged
      ? tx.changes.reserve('alert', 'upsert', { entityId: id, sessionUid: old.sessionUid })
      : null;
    driver
      .prepare(
        `UPDATE alerts SET last_fired_at = :at, fire_count = fire_count + 1, detail = :detail, severity = :severity,
                           title = coalesce(:title, title), updated_seq = coalesce(:seq, updated_seq)
         WHERE id = :id AND status = 'open'`,
      )
      .run({ id, at: f.at, detail: JSON.stringify(f.detail), severity: f.severity, title: f.title ?? null, seq });
    return { severityChanged };
  }

  /** Resolves an open alert and reserves its change. False when the alert is not open. */
  resolve(ctx: RepoContext, tx: WriteTx, id: number, r: { at: number; reason: AlertResolvedReason }): boolean {
    this.db.assertScope(ctx);
    return this.resolveOpen(tx, id, r);
  }

  /** Retention (03 3.8 step 3g): resolves the open alerts of sessions that are about to be deleted. Returns the count. */
  resolveForSessions(ctx: RepoContext, tx: WriteTx, sessionRowIds: readonly number[], at: number): number {
    this.db.assertScope(ctx);
    if (sessionRowIds.length === 0) return 0;
    const ids = this.db.driver
      .prepare<{ id: number }>(
        `SELECT id FROM alerts WHERE status = 'open' AND session_id IN (SELECT value FROM json_each(:idsJson)) ORDER BY id`,
      )
      .all({ idsJson: JSON.stringify([...new Set(sessionRowIds)]) });
    let resolved = 0;
    for (const { id } of ids) {
      if (this.resolveOpen(tx, id, { at, reason: 'scope_deleted' })) resolved += 1;
    }
    return resolved;
  }

  getState(ctx: RepoContext, ruleId: string, scopeKey: string): AlertStateRow | undefined {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare<AlertStateRow>(
        `SELECT rule_id AS ruleId, scope_key AS scopeKey, condition_since AS conditionSince, last_value AS lastValue,
                last_evaluated_at AS lastEvaluatedAt, cooldown_until AS cooldownUntil
         FROM alert_state WHERE rule_id = :ruleId AND scope_key = :scopeKey`,
      )
      .get({ ruleId, scopeKey });
  }

  saveState(ctx: RepoContext, _tx: WriteTx, s: AlertStateRow): void {
    this.db.assertScope(ctx);
    this.db.driver
      .prepare(
        `INSERT INTO alert_state (rule_id, scope_key, condition_since, last_value, last_evaluated_at, cooldown_until)
         VALUES (:ruleId, :scopeKey, :conditionSince, :lastValue, :lastEvaluatedAt, :cooldownUntil)
         ON CONFLICT(rule_id, scope_key) DO UPDATE SET
           condition_since = excluded.condition_since, last_value = excluded.last_value,
           last_evaluated_at = excluded.last_evaluated_at, cooldown_until = excluded.cooldown_until`,
      )
      .run({
        ruleId: s.ruleId,
        scopeKey: s.scopeKey,
        conditionSince: s.conditionSince,
        lastValue: s.lastValue,
        lastEvaluatedAt: s.lastEvaluatedAt,
        cooldownUntil: s.cooldownUntil,
      });
  }

  /** Automatic retention (03 3.8): at most `limit` resolved alerts resolved before the cutoff. Returns the count. */
  deleteResolvedBefore(ctx: RepoContext, _tx: WriteTx, cutoffAt: number, limit: number): number {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare(
        `DELETE FROM alerts WHERE id IN (
           SELECT id FROM alerts WHERE status = 'resolved' AND resolved_at < :cutoffAt ORDER BY resolved_at, id LIMIT :limit)`,
      )
      .run({ cutoffAt, limit: rowLimit(limit) }).changes;
  }

  /** Automatic retention (03 3.8): states with no condition and no running cooldown, last evaluated before the cutoff. */
  deleteIdleStatesBefore(ctx: RepoContext, _tx: WriteTx, cutoffAt: number, limit: number): number {
    this.db.assertScope(ctx);
    return this.db.driver
      .prepare(
        `DELETE FROM alert_state WHERE (rule_id, scope_key) IN (
           SELECT rule_id, scope_key FROM alert_state
           WHERE condition_since IS NULL AND (cooldown_until IS NULL OR cooldown_until < :cutoffAt)
             AND last_evaluated_at < :cutoffAt
           ORDER BY last_evaluated_at LIMIT :limit)`,
      )
      .run({ cutoffAt, limit: rowLimit(limit) }).changes;
  }

  private openRow(id: number): { severity: AlertSeverity; sessionUid: string | null } | undefined {
    return this.db.driver
      .prepare<{ severity: AlertSeverity; sessionUid: string | null }>(
        `SELECT a.severity AS severity, s.session_uid AS sessionUid
         FROM alerts a LEFT JOIN sessions s ON s.id = a.session_id WHERE a.id = :id AND a.status = 'open'`,
      )
      .get({ id });
  }

  private resolveOpen(tx: WriteTx, id: number, r: { at: number; reason: AlertResolvedReason }): boolean {
    const old = this.openRow(id);
    if (old === undefined) return false;
    const seq = tx.changes.reserve('alert', 'upsert', { entityId: id, sessionUid: old.sessionUid });
    return (
      this.db.driver
        .prepare(
          `UPDATE alerts SET status = 'resolved', resolved_at = :at, resolved_reason = :reason, updated_seq = :seq
           WHERE id = :id AND status = 'open'`,
        )
        .run({ id, at: r.at, reason: r.reason, seq }).changes > 0
    );
  }
}
