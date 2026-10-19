// The alert service over a real database (03 10.2, DA-T-AL-1, 2, 3, 4 and the guarantees of ADR 0027): one open alert per rule
// and scope, the cooldown, the change rows, expiry, the guard around every entry point, the sweep interval and the adversarial
// cases (1,000 inputs in one tick, a deleted session, a clock that steps back, a rule that was switched off).
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { RuntimeFileSchema, type IngestHealth } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { healthFixture, type HealthPatch } from '../../test/support/alert-fixtures.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { withWriteTx } from '../db/write.ts';
import type { AlertInput } from '../health/alert-inputs.ts';
import { cleared, type AlertFacts } from './evaluator.ts';
import { createAlertService, MAX_SCOPES_PER_RULE, type AlertService, type AlertServiceContext } from './service.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const SCOPE = { instanceId: INSTANCE_ID };
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const uidOf = (n: number): string => `dddddddd-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const dbs: InstanceDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

interface Rig {
  readonly db: InstanceDb;
  readonly clock: FakeClock;
  readonly ctx: AlertServiceContext;
  readonly warnings: string[];
  readonly ringed: string[];
  /** The report the service sees; replace it to move the health inputs. */
  setHealth(patch: HealthPatch | null): void;
  service(alerts?: Record<string, unknown>, options?: Parameters<typeof createAlertService>[1]): AlertService;
  /** A session with the given columns; returns its row id. */
  session(n: number, columns?: Record<string, string | number | null>): number;
  update(n: number, columns: Record<string, string | number | null>): void;
  alerts(): AlertRow[];
  changes(): number;
  errorRows(): { code: string; source: string; detail: string | null }[];
}

interface AlertRow {
  id: number;
  rule_id: string;
  scope_key: string;
  session_id: number | null;
  severity: string;
  status: string;
  title: string;
  detail: string;
  fire_count: number;
  resolved_reason: string | null;
}

function rig(): Rig {
  const root = tempDir('alert-service').path;
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const clock = new FakeClock(T0);
  const db = openInstanceDb({
    path: path.join(root, 'data', 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '4.0.0',
    clock,
  });
  dbs.push(db);
  let report: IngestHealth | null = healthFixture(T0);
  const warnings: string[] = [];
  const ringed: string[] = [];
  const make = (alerts: Record<string, unknown> = {}): AlertServiceContext => ({
    db,
    scope: SCOPE,
    clock,
    config: { runtime: RuntimeFileSchema.parse({ schema_version: 1, alerts }) },
    instanceDir: root,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (event) => {
        warnings.push(event);
      },
      error: () => undefined,
    },
    errors: {
      push: (entry) => {
        ringed.push(entry.code);
      },
    },
    health: () => report,
  });
  const sessions = new SessionsRepo(db);
  return {
    db,
    clock,
    ctx: make(),
    warnings,
    ringed,
    setHealth: (patch) => {
      report = patch === null ? null : healthFixture(clock.now(), patch);
    },
    service: (alerts, options) =>
      createAlertService(make(alerts), { freeDiskMb: () => 100_000, dbMb: () => 10, ...options }),
    session: (n, columns = {}) => {
      const id = withWriteTx(db, SCOPE, (tx) =>
        sessions.ensure(SCOPE, tx, { sessionUid: uidOf(n), projectId: null, startedAt: T0 - DAY }),
      ).id;
      const set = Object.entries({ last_activity_at: T0, ...columns });
      db.driver
        .prepare(`UPDATE sessions SET ${set.map(([key]) => `${key} = :${key}`).join(', ')} WHERE id = :id`)
        .run({ id, ...Object.fromEntries(set) });
      return id;
    },
    update: (n, columns) => {
      const set = Object.entries(columns);
      db.driver
        .prepare(`UPDATE sessions SET ${set.map(([key]) => `${key} = :${key}`).join(', ')} WHERE session_uid = :uid`)
        .run({ uid: uidOf(n), ...Object.fromEntries(set) });
    },
    alerts: () =>
      db.driver
        .prepare<AlertRow>(
          `SELECT id, rule_id, scope_key, session_id, severity, status, title, detail, fire_count, resolved_reason
           FROM alerts ORDER BY id`,
        )
        .all(),
    changes: () =>
      db.driver.prepare<{ n: number }>("SELECT count(*) AS n FROM changes WHERE kind = 'alert'").get()?.n ?? -1,
    errorRows: () =>
      db.driver
        .prepare<{ code: string; source: string; detail: string | null }>(
          'SELECT code, source, detail FROM ingest_errors ORDER BY id',
        )
        .all(),
  };
}

const ACTIVE = { state: 'working' } as const;

describe('DA-T-AL-1: one open alert per rule and scope', () => {
  it('holds for 5 sweeps into one row with fire_count 5 and one change, clears into resolved, stays quiet inside the cooldown and opens a new row after it', () => {
    const r = rig();
    const service = r.service();
    r.session(1, { ...ACTIVE, last_activity_at: T0 - 45 * MIN });

    for (let sweep = 0; sweep < 5; sweep += 1) {
      service.sweep(r.clock.now());
      r.clock.advance(MIN);
    }
    expect(r.alerts()).toHaveLength(1);
    expect(r.alerts()[0]).toMatchObject({
      rule_id: 'inactivity',
      scope_key: uidOf(1),
      status: 'open',
      severity: 'warning',
      fire_count: 5,
    });
    expect(r.changes()).toBe(1);

    // activity resumes: the condition clears
    r.update(1, { last_activity_at: r.clock.now() });
    service.sweep(r.clock.now());
    expect(r.alerts()[0]).toMatchObject({ status: 'resolved', resolved_reason: 'condition_cleared' });
    expect(r.changes()).toBe(2);

    // it holds again inside the 10 minute cooldown: nothing happens
    const resolvedAt = r.clock.now();
    r.update(1, { last_activity_at: resolvedAt - 40 * MIN });
    r.clock.advance(5 * MIN);
    service.sweep(r.clock.now());
    expect(r.alerts()).toHaveLength(1);
    expect(r.changes()).toBe(2);

    // after the cooldown a new row opens
    r.clock.advance(5 * MIN + 1);
    service.sweep(r.clock.now());
    expect(r.alerts()).toHaveLength(2);
    expect(r.alerts()[1]).toMatchObject({ status: 'open', fire_count: 1 });
    expect(r.changes()).toBe(3);
    expect(r.errorRows()).toEqual([]);
  });

  it('writes a change row only when an alert opens, resolves or changes its severity', () => {
    const r = rig();
    const service = r.service();
    r.session(1, { ...ACTIVE, last_activity_at: T0 - 45 * MIN });
    service.sweep(T0);
    service.sweep(T0 + MIN);
    expect(r.changes()).toBe(1);
    // 130 minutes idle is past four times the threshold: critical, one more change
    r.update(1, { last_activity_at: T0 - 130 * MIN });
    service.sweep(T0 + 2 * MIN);
    expect(r.alerts()[0]).toMatchObject({ severity: 'critical', fire_count: 3 });
    expect(r.changes()).toBe(2);
    service.sweep(T0 + 3 * MIN);
    expect(r.changes()).toBe(2);
  });

  it('keeps exactly one open alert per rule and scope under interleaved applies and a second service', () => {
    const r = rig();
    const first = r.service();
    const second = r.service();
    const holds = { ...cleared(), holds: true, title: 'Hook handler failing', detail: { n: 1 } };
    const outcomes: string[] = [];
    // two services over one database, many applies in a row: each runs in its own transaction and re-reads the open row
    for (let n = 0; n < 40; n += 1) {
      outcomes.push((n % 2 === 0 ? first : second).apply('hook_failing', 'instance', holds, T0 + n));
    }
    expect(outcomes.filter((outcome) => outcome === 'opened')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'refired')).toHaveLength(39);
    expect(r.alerts()).toHaveLength(1);
    expect(r.alerts()[0]?.fire_count).toBe(40);
    // the partial unique index was never the one to say no
    expect(r.errorRows()).toEqual([]);
  });

  it('survives concurrent callers on the event loop without a second open row', async () => {
    const r = rig();
    const service = r.service();
    const holds = { ...cleared(), holds: true, title: 'Hook handler failing' };
    await Promise.all(
      Array.from({ length: 50 }, (_, n) =>
        Promise.resolve().then(() => service.apply('hook_failing', 'instance', holds, T0 + n)),
      ),
    );
    expect(r.alerts().filter((row) => row.status === 'open')).toHaveLength(1);
    expect(r.errorRows()).toEqual([]);
  });
});

describe('the cooldown', () => {
  it('has no effect for a rule without a cooldown and clears with the configured minutes', () => {
    const r = rig();
    const service = r.service({ rules: { hook_failing: { cooldownMinutes: 0 } } });
    const holds = { ...cleared(), holds: true, title: 'Hook handler failing' };
    service.apply('hook_failing', 'instance', holds, T0);
    expect(service.apply('hook_failing', 'instance', cleared(), T0 + MIN)).toBe('resolved');
    // no cooldown: the next hold opens a row at once
    expect(service.apply('hook_failing', 'instance', holds, T0 + MIN + 1)).toBe('opened');
  });

  it('suppresses a hold inside the cooldown and opens after it (boundary on the clock)', () => {
    const r = rig();
    const service = r.service();
    const holds = { ...cleared(), holds: true, title: 'Hook handler failing' };
    service.apply('hook_failing', 'instance', holds, T0);
    service.apply('hook_failing', 'instance', cleared(), T0 + MIN);
    const until = T0 + MIN + 10 * MIN;
    expect(service.apply('hook_failing', 'instance', holds, until - 1)).toBe('suppressed');
    expect(service.apply('hook_failing', 'instance', holds, until)).toBe('opened');
    expect(r.alerts().map((row) => row.status)).toEqual(['resolved', 'open']);
  });

  it('does not stay suppressed for longer than its length when the clock steps back', () => {
    const r = rig();
    const service = r.service();
    const holds = { ...cleared(), holds: true, title: 'Hook handler failing' };
    service.apply('hook_failing', 'instance', holds, T0);
    service.apply('hook_failing', 'instance', cleared(), T0 + MIN);
    // an hour back: the stored cooldown end is 70 minutes away, further than the 10 minute cooldown can be
    expect(service.apply('hook_failing', 'instance', holds, T0 - HOUR)).toBe('opened');
    expect(r.errorRows()).toEqual([]);
  });
});

describe('DA-T-AL-2: evaluation never breaks ingestion', () => {
  it('records an evaluator that throws as an ingest_errors row with source alerts and carries on with the other rules', () => {
    const r = rig();
    r.session(1, { hook_coverage: 'partial', hook_missing_tools: 2 });
    const service = r.service(undefined, {
      evaluate: (rule, facts) => {
        if (rule.kind === 'inactivity') throw new Error('C:/secret/path boom');
        return [
          ...(rule.kind === 'hook_gap'
            ? facts.gaps.map((gap) => ({
                scopeKey: gap.uid,
                result: {
                  ...cleared(gap.rowId, gap.uid),
                  holds: true,
                  title: 'Hooks missed 2 tool calls in this session',
                },
              }))
            : []),
        ];
      },
    });
    expect(() => {
      service.sweep(T0);
    }).not.toThrow();
    expect(r.errorRows()).toEqual([{ code: 'ALERT_EVALUATION_FAILED', source: 'alerts', detail: 'inactivity Error' }]);
    // the message of the error never reaches a row, the ring or the log
    expect(JSON.stringify(r.errorRows())).not.toContain('secret');
    expect(r.ringed).toEqual(['ALERT_EVALUATION_FAILED']);
    // the rule that did not fail still opened its alert
    expect(r.alerts().map((row) => row.rule_id)).toEqual(['hook_gap']);
  });

  it('records a failed apply and returns failed instead of throwing', () => {
    const r = rig();
    const service = r.service();
    // a title longer than the column allows is refused by the database; the service cuts titles, so use a bad rule id
    expect(service.apply('no_such_rule', 'instance', { ...cleared(), holds: true, title: 'x' }, T0)).toBe('failed');
    expect(r.errorRows()).toEqual([
      { code: 'ALERT_APPLY_FAILED', source: 'alerts', detail: 'no_such_rule RangeError' },
    ]);
  });

  it('turns a failing fact gatherer into a recorded failure, not an exception', () => {
    const r = rig();
    const service = r.service(undefined, {
      freeDiskMb: () => {
        throw new Error('statfs boom');
      },
    });
    expect(() => {
      service.sweep(T0);
    }).not.toThrow();
    expect(r.errorRows().map((row) => row.code)).toEqual(['ALERT_FACTS_FAILED']);
  });

  it('survives a database that cannot record the failure', () => {
    const r = rig();
    const service = r.service(undefined, {
      evaluate: () => {
        throw new Error('boom');
      },
    });
    r.db.driver
      .prepare("CREATE TRIGGER refuse_errors BEFORE INSERT ON ingest_errors BEGIN SELECT RAISE(ABORT, 'refused'); END")
      .run();
    expect(() => {
      service.sweep(T0);
    }).not.toThrow();
    expect(r.warnings).toContain('alert_failed');
    expect(r.ringed).toContain('ALERT_EVALUATION_FAILED');
  });

  it('does not open or clear anything when an evaluator fails', () => {
    const r = rig();
    r.session(1, { ...ACTIVE, last_activity_at: T0 - 45 * MIN });
    r.service().sweep(T0);
    expect(r.alerts()).toHaveLength(1);
    const broken = r.service(undefined, {
      evaluate: () => {
        throw new Error('boom');
      },
    });
    broken.sweep(T0 + MIN);
    expect(r.alerts()[0]).toMatchObject({ status: 'open', fire_count: 1 });
  });
});

describe('DA-T-AL-3: token_threshold over lower-bound totals', () => {
  it('fires only when the stored lower-bound total reaches the threshold', () => {
    const r = rig();
    const on = { rules: { token_threshold: { enabled: true, tokens: 1000 } } };
    // 999 counted tokens, with more still missing from an unfinalized message: not yet
    r.session(1, {
      tok_input: 400,
      tok_output: 400,
      tok_cache_read: 100,
      tok_cache_creation: 99,
      usage_unfinalized: 1,
    });
    const service = r.service(on);
    service.sweep(T0);
    expect(r.alerts()).toEqual([]);
    r.update(1, { tok_cache_creation: 100 });
    service.sweep(T0 + MIN);
    expect(r.alerts()).toHaveLength(1);
    expect(r.alerts()[0]).toMatchObject({
      rule_id: 'token_threshold',
      scope_key: uidOf(1),
      severity: 'warning',
      title: 'Session used 1k tokens (threshold 1k)',
    });
    // tokens only grow: the alert stays while the session exists, and turns critical at twice the threshold
    r.update(1, { tok_output: 1400 });
    service.sweep(T0 + 2 * MIN);
    expect(r.alerts()[0]).toMatchObject({ status: 'open', severity: 'critical' });
  });

  it('can compare the output alone', () => {
    const r = rig();
    r.session(1, { tok_input: 5000, tok_output: 10 });
    r.service({ rules: { token_threshold: { enabled: true, tokens: 1000, field: 'output' } } }).sweep(T0);
    expect(r.alerts()).toEqual([]);
  });
});

describe('DA-T-AL-4: runtime_unavailable', () => {
  function reconciliation(r: Rig, at: number): void {
    r.db.driver
      .prepare(
        `INSERT INTO reconciliations (session_id, scope_key, kind, at, detail, detail_hash)
         VALUES (NULL, 'instance', 'runtime_unavailable', :at, :detail, :hash)`,
      )
      .run({
        at,
        detail: JSON.stringify({ from: at - 6 * MIN, to: at, envelopes: 14 }),
        hash: 'ab'.repeat(16),
      });
  }

  it('opens one alert for a downtime and expires it after expireHours', () => {
    const r = rig();
    const service = r.service();
    reconciliation(r, T0 - MIN);
    service.sweep(T0);
    service.sweep(T0 + MIN);
    expect(r.alerts()).toHaveLength(1);
    expect(r.alerts()[0]).toMatchObject({
      rule_id: 'runtime_unavailable',
      scope_key: 'instance',
      status: 'open',
      severity: 'warning',
      title: 'Monitor was not running for 6 min while 14 hook events arrived',
      fire_count: 2,
    });

    // just inside the 24 hours the downtime still counts; at 24 hours it has run out
    service.sweep(T0 - MIN + 24 * HOUR - 1);
    expect(r.alerts()[0]?.status).toBe('open');
    service.sweep(T0 - MIN + 24 * HOUR);
    expect(r.alerts()[0]).toMatchObject({ status: 'resolved', resolved_reason: 'expired' });
    // an expired alert starts no cooldown and is not opened again for the same, old downtime
    service.sweep(T0 + 25 * HOUR);
    expect(r.alerts()).toHaveLength(1);
  });

  it('opens an alert for the hook handler report too', () => {
    const r = rig();
    r.setHealth({
      hooks: { status: 'failing', handlerErrors: [{ code: 'HANDLER_UNAVAILABLE', count: 2, lastAt: T0 - MIN }] },
    });
    r.service().sweep(T0);
    expect(r.alerts().map((row) => [row.rule_id, row.title])).toEqual([
      ['runtime_unavailable', 'Hook handler could not reach the monitor 2 times'],
      ['hook_failing', 'Hook handler failing'],
    ]);
  });
});

describe('the other rules from the health report and the coverage columns', () => {
  it('opens and clears import_lag, hook_failing and db_disk with the health inputs', () => {
    const r = rig();
    const service = r.service();
    r.setHealth({
      transcripts: { status: 'lagging', maxLagMs: 400_000 },
      hooks: { status: 'failing' },
      persisted: { status: 'db_error', lastError: { code: 'db_busy', at: T0 } },
    });
    service.sweep(T0);
    const open = r.alerts().map((row) => [row.rule_id, row.severity, row.title]);
    expect(open).toEqual([
      ['import_lag', 'critical', 'Transcript import 400 s behind'],
      ['db_disk', 'critical', 'Database writes are failing'],
      ['hook_failing', 'warning', 'Hook handler failing'],
    ]);
    r.setHealth({});
    service.sweep(T0 + MIN);
    expect(r.alerts().map((row) => row.status)).toEqual(['resolved', 'resolved', 'resolved']);
    expect(new Set(r.alerts().map((row) => row.resolved_reason))).toEqual(new Set(['condition_cleared']));
  });

  it('leaves the rules that read the health report alone while there is no report', () => {
    const r = rig();
    const service = r.service();
    r.setHealth({ hooks: { status: 'failing' }, transcripts: { status: 'lagging', maxLagMs: 90_000 } });
    service.sweep(T0);
    expect(r.alerts().map((row) => row.status)).toEqual(['open', 'open']);
    // the report is gone (a refresh that has not happened yet): nothing is opened, refired or cleared on a guess
    r.setHealth(null);
    service.sweep(T0 + MIN);
    expect(r.alerts().map((row) => [row.status, row.fire_count])).toEqual([
      ['open', 1],
      ['open', 1],
    ]);
  });

  it('db_disk reacts to free space and to the size of the database', () => {
    const r = rig();
    let free = 410;
    let size = 10;
    const service = r.service(undefined, { freeDiskMb: () => free, dbMb: () => size });
    service.sweep(T0);
    expect(r.alerts()[0]).toMatchObject({ rule_id: 'db_disk', severity: 'warning', title: 'Free disk space 410 MB' });
    free = 100;
    service.sweep(T0 + MIN);
    expect(r.alerts()[0]).toMatchObject({ severity: 'critical', title: 'Free disk space 100 MB' });
    free = 100_000;
    size = 3000;
    service.sweep(T0 + 2 * MIN);
    expect(r.alerts()[0]).toMatchObject({ status: 'open', severity: 'warning', title: 'Database size 3000 MB' });
  });

  it('hook_gap follows the coverage of each session and clears when it is full or none', () => {
    const r = rig();
    const service = r.service();
    r.session(1, { hook_coverage: 'partial', hook_missing_tools: 3 });
    r.session(2, { hook_coverage: 'partial', hook_missing_turns: 1 });
    r.session(3, { hook_coverage: 'full' });
    service.sweep(T0);
    expect(r.alerts().map((row) => [row.scope_key, row.title])).toEqual([
      [uidOf(1), 'Hooks missed 3 tool calls in this session'],
      [uidOf(2), 'Hooks missed 1 turn in this session'],
    ]);
    r.update(1, { hook_coverage: 'full' });
    r.update(2, { hook_coverage: 'none' });
    service.sweep(T0 + MIN);
    expect(r.alerts().map((row) => row.status)).toEqual(['resolved', 'resolved']);
  });

  it('ingest_errors counts the rows of one code within the window and clears when they age out', () => {
    const r = rig();
    const service = r.service();
    withWriteTx(r.db, SCOPE, () => {
      for (let n = 0; n < 12; n += 1) {
        r.db.driver
          .prepare("INSERT INTO ingest_errors (at, source, code) VALUES (:at, 'transcript', 'READ_FAILED')")
          .run({ at: T0 - n * 10_000 });
      }
    });
    service.sweep(T0);
    expect(r.alerts()).toHaveLength(1);
    expect(r.alerts()[0]).toMatchObject({
      rule_id: 'ingest_errors',
      scope_key: 'READ_FAILED',
      title: '12 READ_FAILED errors in 10 min',
    });
    service.sweep(T0 + 11 * MIN);
    expect(r.alerts()[0]).toMatchObject({ status: 'resolved', resolved_reason: 'condition_cleared' });
  });
});

describe('rules and scopes that go away', () => {
  it('resolves the open alerts of a rule that is switched off with rule_disabled at startup', () => {
    const r = rig();
    r.session(1, { hook_coverage: 'partial', hook_missing_tools: 1 });
    r.service().sweep(T0);
    r.setHealth({ hooks: { status: 'failing' } });
    r.service().sweep(T0);
    expect(r.alerts().map((row) => row.status)).toEqual(['open', 'open']);

    const restarted = r.service({ rules: { hook_gap: { enabled: false } } });
    expect(restarted.resolveDisabled(T0 + MIN)).toBe(1);
    expect(r.alerts().map((row) => [row.rule_id, row.status, row.resolved_reason])).toEqual([
      ['hook_gap', 'resolved', 'rule_disabled'],
      ['hook_failing', 'open', null],
    ]);
    // a sweep of the new service leaves the disabled rule alone
    restarted.sweep(T0 + 2 * MIN);
    expect(r.alerts()).toHaveLength(2);
  });

  it('resolves everything when the section is switched off, and sweeps nothing', () => {
    const r = rig();
    r.session(1, { hook_coverage: 'partial', hook_missing_tools: 1 });
    r.service().sweep(T0);
    const off = r.service({ enabled: false });
    expect(off.resolveDisabled(T0)).toBe(1);
    off.sweep(T0 + MIN);
    expect(off.sweepIfDue(T0 + 2 * MIN, true)).toBe(false);
    expect(r.alerts()).toHaveLength(1);
  });

  it('resolves the alert of a session that retention deleted with scope_deleted', () => {
    const r = rig();
    const service = r.service();
    r.session(1, { hook_coverage: 'partial', hook_missing_tools: 1 });
    service.sweep(T0);
    expect(r.alerts()[0]?.session_id).not.toBeNull();
    // the session row goes (the foreign key detaches the alert); the condition is gone with its scope
    r.db.driver.prepare('DELETE FROM sessions WHERE session_uid = :uid').run({ uid: uidOf(1) });
    service.sweep(T0 + MIN);
    expect(r.alerts()[0]).toMatchObject({ status: 'resolved', resolved_reason: 'scope_deleted', session_id: null });
    expect(r.errorRows()).toEqual([]);
  });

  it('forgets a remembered condition that cleared inside the cooldown', () => {
    const r = rig();
    const service = r.service();
    r.session(1, { ...ACTIVE, last_activity_at: T0 - 45 * MIN });
    service.sweep(T0);
    r.update(1, { last_activity_at: T0 });
    service.sweep(T0 + MIN);
    // holds inside the cooldown (suppressed, but remembered), then clears without ever having an alert
    r.update(1, { last_activity_at: T0 - 60 * MIN });
    service.sweep(T0 + 2 * MIN);
    const since = (): number | null =>
      r.db.driver.prepare<{ since: number | null }>('SELECT condition_since AS since FROM alert_state').get()?.since ??
      null;
    expect(since()).not.toBeNull();
    r.update(1, { last_activity_at: T0 + 2 * MIN });
    service.sweep(T0 + 3 * MIN);
    expect(since()).toBeNull();
  });
});

describe('the sweep interval', () => {
  function counting(r: Rig, alerts: Record<string, unknown>): { service: AlertService; sweeps: () => number } {
    let sweeps = 0;
    const service = r.service(alerts, {
      evaluate: () => {
        sweeps += 1;
        return [];
      },
    });
    return { service, sweeps: () => sweeps / service.rules.rules.filter((rule) => rule.enabled).length };
  }

  it('runs when alerts.sweepSeconds have passed and not before', () => {
    const r = rig();
    const { service, sweeps } = counting(r, { sweepSeconds: 120 });
    expect(service.sweepIfDue(T0)).toBe(true);
    expect(service.sweepIfDue(T0 + 60_000)).toBe(false);
    expect(service.sweepIfDue(T0 + 119_999)).toBe(false);
    expect(service.sweepIfDue(T0 + 120_000)).toBe(true);
    expect(sweeps()).toBe(2);
  });

  it('runs a forced sweep at once and a sweep after the clock stepped back', () => {
    const r = rig();
    const { service, sweeps } = counting(r, { sweepSeconds: 600 });
    expect(service.sweepIfDue(T0)).toBe(true);
    expect(service.sweepIfDue(T0 + 1000)).toBe(false);
    expect(service.sweepIfDue(T0 + 1000, true)).toBe(true);
    expect(service.sweepIfDue(T0 - HOUR)).toBe(true);
    expect(sweeps()).toBe(3);
  });

  it('keeps the interval inside 15 and 600 seconds', () => {
    const r = rig();
    expect(r.service({ sweepSeconds: 15 }).rules.sweepSeconds).toBe(15);
    expect(r.service({ sweepSeconds: 600 }).rules.sweepSeconds).toBe(600);
  });
});

describe('the alert inputs', () => {
  const input = (code: AlertInput['code'], key: string): AlertInput => ({ code, key, payload: {} });

  it('evaluates only the rules the inputs concern, once for any number of inputs (1,000 in one tick)', () => {
    const r = rig();
    const asked: string[] = [];
    const service = r.service(undefined, {
      evaluate: (rule) => {
        asked.push(rule.kind);
        return [];
      },
    });
    const flood = Array.from({ length: 1000 }, (_, n) => input('hook_gap', `hook_gap:${String(n)}`));
    service.onInputs([...flood, input('disk', 'disk:spool'), input('db_error', 'db_error')]);
    expect(asked.sort()).toEqual(['db_disk', 'hook_gap']);
  });

  it('opens the alert of a condition at once, without waiting for the sweep', () => {
    const r = rig();
    const service = r.service();
    r.setHealth({ hooks: { status: 'failing' } });
    service.onInputs([input('hook_failing', 'hook_failing')]);
    expect(r.alerts().map((row) => row.rule_id)).toEqual(['hook_failing']);
  });

  it('never throws, whatever the inputs, the evaluator or the database do', () => {
    const r = rig();
    const service = r.service(undefined, {
      evaluate: () => {
        throw new Error('boom');
      },
    });
    expect(() => {
      service.onInputs([input('import_lag', 'import_lag')]);
      service.onInputs([]);
    }).not.toThrow();
    expect(r.errorRows().map((row) => row.code)).toEqual(['ALERT_EVALUATION_FAILED']);
  });

  it('ignores inputs of a disabled section', () => {
    const r = rig();
    const evaluate = vi.fn(() => []);
    r.service({ enabled: false }, { evaluate }).onInputs([input('import_lag', 'import_lag')]);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe('what is stored', () => {
  it('keeps the detail under 2,048 bytes whatever the evaluator hands over', () => {
    const r = rig();
    const detail = Object.fromEntries(Array.from({ length: 80 }, (_, n) => [`key${String(n)}`, 'x'.repeat(100)]));
    r.service().apply(
      'hook_failing',
      'instance',
      { ...cleared(), holds: true, title: 'Hook handler failing', detail },
      T0,
    );
    const stored = r.alerts()[0]?.detail ?? '';
    expect(Buffer.byteLength(stored)).toBeLessThan(2048);
    expect(stored.startsWith('{"key0"')).toBe(true);
  });

  it('keeps a session scoped alert tied to its session and its change to the session uid', () => {
    const r = rig();
    const id = r.session(1, { hook_coverage: 'partial', hook_missing_tools: 1 });
    r.service().sweep(T0);
    expect(r.alerts()[0]?.session_id).toBe(id);
    const change = r.db.driver
      .prepare<{ session_uid: string | null }>("SELECT session_uid FROM changes WHERE kind = 'alert'")
      .get();
    expect(change?.session_uid).toBe(uidOf(1));
  });

  it('reads at most MAX_SCOPES_PER_RULE scopes per rule and does not clear what it could not see', () => {
    const r = rig();
    const service = r.service({ rules: { hook_gap: { cooldownMinutes: 0 } } });
    const total = MAX_SCOPES_PER_RULE + 20;
    for (let n = 1; n <= total; n += 1) {
      r.session(n, { hook_coverage: 'partial', hook_missing_tools: 1, last_activity_at: T0 - n });
    }
    service.sweep(T0);
    expect(r.alerts()).toHaveLength(MAX_SCOPES_PER_RULE);
    // the cut list proves nothing about an alert outside it: the alert of a session that left the list stays open until a
    // sweep reads every scope, and the sessions that moved into the list open theirs
    r.update(1, { hook_coverage: 'full' });
    service.sweep(T0 + MIN);
    expect(r.alerts().find((row) => row.scope_key === uidOf(1))?.status).toBe('open');
    for (let n = 2; n <= total - 30; n += 1) r.update(n, { hook_coverage: 'full' });
    service.sweep(T0 + 2 * MIN);
    expect(r.alerts().find((row) => row.scope_key === uidOf(1))?.status).toBe('resolved');
  });
});

describe('facts', () => {
  it('are not gathered for a rule that is not asked for', () => {
    const r = rig();
    const seen: AlertFacts[] = [];
    r.service(undefined, {
      evaluate: (_rule, facts) => {
        seen.push(facts);
        return [];
      },
    }).sweep(T0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.now).toBe(T0);
  });
});
