// Alerts over real instances (03 10.2, 19.7; DA-T-AL-2 and 4, ADR 0027, WP-59). A real workspace, database, query layer, ingest
// service and health evaluator; every row is synthetic. Proven here:
//   DA-T-AL-2  an evaluator that throws never reaches the ingest transaction: the import is committed and an `ingest_errors` row with
//              source `alerts` says what failed (rule and error name only)
//   DA-T-AL-4  a `runtime_unavailable` reconciliation reaches the service through the health refresh and its alert expires after
//              `expireHours`, driven through the `alerts` job of the real schedule on a FakeClock
//   the wiring  the registered factory starts with the runtime, listens to the alert inputs and sweeps; a rule that is switched off
//              in `runtime.json` has its open alerts resolved at startup
//   the importer keeps committing while the sweep runs between its transactions
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AlertListQuerySchema, RUNTIME_VERSION } from '@mcs/shared';
import { sanitizeProjectName } from '@mcs/shared/protocol';
import { FakeClock, buildClaudeHome, useTempDirs, waitFor, type TranscriptBuilder } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { alertContextOf, createAlertComponents, createAlertService } from '../src/alerts/service.ts';
import { defaultSkillDir } from '../src/config/defaults.ts';
import { ReconciliationsRepo } from '../src/db/repos/reconciliations.ts';
import { withWriteTx } from '../src/db/write.ts';
import { subscribeAlertInputs } from '../src/health/alert-inputs.ts';
import { ingestHealthEvaluatorOf } from '../src/health/ingest-health.ts';
import { createIngestService } from '../src/ingest/service.ts';
import { createDbSchedulerWith } from '../src/maintenance/schedule.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { createInstanceRuntime } from '../src/runtime/instance-runtime.ts';
import { initWorkspace } from '../src/workspace/init.ts';

const makeTemp = useTempDirs();
const SESSION = '77777777-7777-4777-8777-777777777777';
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');
const MIN = 60_000;
const HOUR = 60 * MIN;

const contexts: InstanceContext[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    ctx.db.close();
    await ctx.logger.close();
  }
});

interface InstanceOptions {
  readonly clock?: FakeClock;
  /** The `alerts` section of `runtime.json`. */
  readonly alerts?: Record<string, unknown>;
  /** A session whose transcript the importer reads. */
  readonly transcript?: (b: TranscriptBuilder) => void;
}

/** A real instance (workspace, database, Claude home) in a temp folder; the clock is the real one unless given. */
async function instance(options: InstanceOptions = {}): Promise<InstanceContext> {
  const root = makeTemp('alerts-int').path;
  const skill = path.join(root, 'skill');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const { ws } = await initWorkspace({
    repo,
    name: 'Demo',
    slug: 'demo',
    ...(options.clock ? { clock: options.clock } : {}),
  });
  if (options.alerts !== undefined) {
    writeFileSync(path.join(ws.dir, 'runtime.json'), JSON.stringify({ schema_version: 1, alerts: options.alerts }));
  }
  const claudeHome = path.join(root, 'claude-home');
  const nowMs = options.clock?.now() ?? Date.now();
  buildClaudeHome(claudeHome, {
    nowMs,
    sessions:
      options.transcript === undefined
        ? []
        : [
            {
              id: SESSION,
              project: sanitizeProjectName(repo),
              cwd: repo,
              startMs: nowMs - 3 * HOUR,
              build: options.transcript,
            },
          ],
  });
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: claudeHome },
    cli: {},
    skillDir: skill,
    runtimeDir: path.join(skill, 'runtime'),
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    ...(options.clock ? { clock: options.clock } : {}),
  });
  contexts.push(ctx);
  return ctx;
}

function count(ctx: InstanceContext, sql: string): number {
  return ctx.db.driver.prepare<{ n: number }>(sql).get()?.n ?? -1;
}

/** `n` occurrences of one ingest error code, the newest `ageMs` old. */
function seedErrors(ctx: InstanceContext, code: string, n: number, ageMs = 1000): void {
  withWriteTx(ctx.db, ctx.scope, () => {
    for (let i = 0; i < n; i += 1) {
      ctx.db.driver
        .prepare("INSERT INTO ingest_errors (at, source, code) VALUES (:at, 'transcript', :code)")
        .run({ at: ctx.clock.now() - ageMs - i, code });
    }
  });
}

const alertsOf = (ctx: InstanceContext): ReturnType<InstanceContext['queries']['listAlerts']>['items'] =>
  ctx.queries.listAlerts(ctx.scope, AlertListQuerySchema.parse({ status: 'open,resolved' })).items;

function transcript(b: TranscriptBuilder): void {
  b.user('FIXTURE prompt');
  b.assistant({ messageId: 'msg_fixture_a', stop: 'end_turn' });
  b.user('FIXTURE second prompt');
  b.assistant({ messageId: 'msg_fixture_b', stop: 'end_turn' });
}

describe('DA-T-AL-2: an evaluator that throws never breaks ingestion', () => {
  it('commits the import, records the failure with source alerts and leaves the health refresh unharmed', async () => {
    const ctx = await instance({ transcript });
    const service = createAlertService(alertContextOf(ctx), {
      evaluate: (rule) => {
        if (rule.kind === 'ingest_errors') throw new Error(`boom in ${ctx.instanceDir}`);
        return [];
      },
    });
    const unsubscribe = subscribeAlertInputs(ctx, (inputs) => {
      service.onInputs(inputs);
    });

    const ingest = createIngestService(ctx);
    await ingest.start();
    await ingest.untilIdle({ timeoutMs: 30_000 });
    // the import is committed
    expect(count(ctx, 'SELECT count(*) AS n FROM sessions')).toBe(1);
    const events = count(ctx, 'SELECT count(*) AS n FROM events');
    expect(events).toBeGreaterThan(0);

    // twelve repeated errors: the health refresh emits `ingest_errors_repeated` after its commit, the rule throws
    seedErrors(ctx, 'READ_FAILED', 12);
    const report = await ingestHealthEvaluatorOf(ctx).refresh();
    await ingest.stop(Date.now() + 2000);
    unsubscribe();

    expect(report.evaluatedAt).toBeGreaterThan(0);
    expect(count(ctx, 'SELECT count(*) AS n FROM events')).toBe(events);
    const rows = ctx.db.driver
      .prepare<{ source: string; code: string; detail: string | null }>(
        "SELECT source, code, detail FROM ingest_errors WHERE source = 'alerts'",
      )
      .all();
    expect(rows).toEqual([{ source: 'alerts', code: 'ALERT_EVALUATION_FAILED', detail: 'ingest_errors Error' }]);
    // neither the message of the error nor a path reached the row or the error ring
    expect(JSON.stringify(rows)).not.toContain(ctx.instanceDir);
    expect(JSON.stringify(ctx.errors.list())).not.toContain(ctx.instanceDir);
    expect(alertsOf(ctx)).toEqual([]);
  });

  it('keeps the importer committing while the sweep runs between its transactions', async () => {
    const control = await instance({ transcript });
    const ingestControl = createIngestService(control);
    await ingestControl.start();
    await ingestControl.untilIdle({ timeoutMs: 30_000 });
    await ingestControl.stop(Date.now() + 2000);
    const expected = count(control, 'SELECT count(*) AS n FROM events');

    const ctx = await instance({ transcript, alerts: { rules: { inactivity: { minutes: 1 } } } });
    const service = createAlertService(alertContextOf(ctx));
    const ingest = createIngestService(ctx);
    const state = { sweeping: true };
    let sweeps = 0;
    const loop = (async (): Promise<void> => {
      while (state.sweeping) {
        service.sweep();
        sweeps += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();
    await ingest.start();
    await ingest.untilIdle({ timeoutMs: 30_000 });
    await ingest.stop(Date.now() + 2000);
    state.sweeping = false;
    await loop;

    expect(sweeps).toBeGreaterThan(0);
    expect(count(ctx, 'SELECT count(*) AS n FROM events')).toBe(expected);
    expect(count(ctx, "SELECT count(*) AS n FROM ingest_errors WHERE source = 'alerts'")).toBe(0);
    expect(count(ctx, "SELECT count(*) AS n FROM alerts WHERE status = 'open'")).toBeLessThanOrEqual(1);
  });
});

describe('DA-T-AL-4: a runtime_unavailable reconciliation', () => {
  it('opens one alert through the health refresh and expires it after expireHours through the schedule', async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 20, 12, 0, 0));
    const ctx = await instance({ clock });
    const [component] = createAlertComponents(ctx);
    if (component === undefined) throw new Error('the alerts component is missing');
    await component.start();
    const scheduler = createDbSchedulerWith(ctx, { evaluator: ingestHealthEvaluatorOf(ctx) });

    const at = clock.now() - MIN;
    withWriteTx(ctx.db, ctx.scope, (tx) => {
      new ReconciliationsRepo(ctx.db).insert(ctx.scope, tx, {
        sessionId: null,
        scopeKey: 'instance',
        kind: 'runtime_unavailable',
        at,
        detail: { from: at - 6 * MIN, to: at, envelopes: 14 },
        detailHash: 'cd'.repeat(16),
      });
    });
    // the health refresh sees the downtime and hands the input over after its commit: the alert opens at once
    await scheduler.runJob('health');
    const opened = alertsOf(ctx);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      ruleId: 'runtime_unavailable',
      severity: 'warning',
      status: 'open',
      title: 'Monitor was not running for 6 min while 14 hook events arrived',
      scope: { kind: 'instance', key: 'instance' },
    });

    // the sweep of the `alerts` job refires it, still one alert
    clock.advance(HOUR);
    await scheduler.runJob('alerts');
    expect(alertsOf(ctx)).toHaveLength(1);
    expect(alertsOf(ctx)[0]?.fireCount).toBeGreaterThan(1);

    // 24 hours after the downtime it has run out
    clock.set(at + 24 * HOUR);
    await scheduler.runJob('alerts');
    expect(alertsOf(ctx)).toHaveLength(1);
    expect(alertsOf(ctx)[0]).toMatchObject({ status: 'resolved', resolvedReason: 'expired' });

    await component.stop(clock.now());
  });
});

describe('the wiring of the runtime', () => {
  it('starts with the runtime: a burst of errors found by the first health refresh opens an alert, and stopping detaches it', async () => {
    const ctx = await instance();
    seedErrors(ctx, 'READ_FAILED', 12);
    const runtime = createInstanceRuntime(ctx);
    await runtime.start();
    try {
      await waitFor(() => alertsOf(ctx).length > 0, { what: 'the alert of 12 repeated errors', timeoutMs: 20_000 });
      expect(alertsOf(ctx)[0]).toMatchObject({
        ruleId: 'ingest_errors',
        status: 'open',
        scope: { kind: 'code', key: 'READ_FAILED' },
        title: '12 READ_FAILED errors in 10 min',
      });
    } finally {
      await runtime.stop(Date.now() + 5000);
    }
    // detached: more errors and another refresh change nothing
    const before = alertsOf(ctx)[0]?.fireCount;
    seedErrors(ctx, 'OTHER_CODE', 12);
    await ingestHealthEvaluatorOf(ctx).refresh();
    expect(alertsOf(ctx)).toHaveLength(1);
    expect(alertsOf(ctx)[0]?.fireCount).toBe(before);
  }, 60_000);

  it('resolves the open alerts of a rule that is switched off in runtime.json at startup (rule_disabled)', async () => {
    const ctx = await instance({ alerts: { rules: { ingest_errors: { enabled: false } } } });
    // an alert that an earlier run, with the rule on, left open
    ctx.db.driver
      .prepare(
        `INSERT INTO alerts (rule_id, rule_kind, scope_kind, scope_key, severity, status, title, detail, first_fired_at, last_fired_at)
         VALUES ('ingest_errors', 'ingest_errors', 'code', 'READ_FAILED', 'warning', 'open', '12 READ_FAILED errors in 10 min', '{}', :at, :at)`,
      )
      .run({ at: Date.now() - MIN });
    const [component] = createAlertComponents(ctx);
    if (component === undefined) throw new Error('the alerts component is missing');
    await component.start();
    expect(alertsOf(ctx)[0]).toMatchObject({ status: 'resolved', resolvedReason: 'rule_disabled' });
    await component.stop(Date.now());
  });
});
