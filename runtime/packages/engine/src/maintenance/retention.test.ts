// The rules of retention that a small database shows (03 3.8): which sessions are candidates, where the cutoffs fall, how the plan is
// cut for a person to read, and the limits of the automatic run. The behaviour against whole databases (the bytes of a dry run, the
// rows that go with a session, the importer, the ingest writer) is in `test/maintenance-retention.int.test.ts`.
import path from 'node:path';

import { LIFECYCLE_STATES, RuntimeFileSchema } from '@mcs/shared';
import { FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import type { SqlValue } from '../db/driver.ts';
import { openInstanceDb, type InstanceDb } from '../db/open.ts';
import { applyRetention, runBookkeepingRetention } from './retention.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111';
const CTX = { instanceId: ID };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const CUTOFF = NOW - 30 * DAY;
const POLICY = { sessionsOlderThanDays: 30, eventsOlderThanDays: null } as const;
const SETTINGS = RuntimeFileSchema.parse({ schema_version: 1 }).retention;

const opened: InstanceDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function database(): InstanceDb {
  const db = openInstanceDb({
    path: path.join(makeTemp('retention').path, 'monitor.db'),
    expectedInstanceId: ID,
    mode: 'serve',
    runtimeVersion: '4.0.0',
    clock: new FakeClock(NOW),
  });
  opened.push(db);
  return db;
}

let counter = 0;

function addSession(db: InstanceDb, over: Record<string, SqlValue> = {}): number {
  counter += 1;
  const uid = `dddddddd-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
  const activity = typeof over['last_activity_at'] === 'number' ? over['last_activity_at'] : CUTOFF - DAY;
  const row: Record<string, SqlValue> = {
    session_uid: uid,
    first_seen_at: activity - HOUR,
    started_at: activity - HOUR,
    last_activity_at: activity,
    updated_at: activity,
    ...over,
  };
  const columns = Object.keys(row);
  return db.driver
    .prepare(`INSERT INTO sessions (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
    .run(row).lastInsertRowid;
}

describe('which sessions are candidates', () => {
  it('an empty database has nothing to plan, delete or give back', async () => {
    const db = database();
    const plan = await applyRetention(db, CTX, POLICY, { dryRun: true, now: NOW });
    expect(plan).toEqual({
      now: NOW,
      sessionsCutoff: CUTOFF,
      eventsCutoff: null,
      sessions: 0,
      sessionSample: [],
      rows: {
        agents: 0,
        events: 0,
        toolCalls: 0,
        turns: 0,
        usage: 0,
        usageFiles: 0,
        transitions: 0,
        reconciliations: 0,
        costStates: 0,
        checkpoints: 0,
        attemptRunsDetached: 0,
      },
      reownedMessages: 0,
      applied: false,
      freedBytes: null,
    });
    const applied = await applyRetention(db, CTX, POLICY, { dryRun: false, now: NOW });
    expect(applied).toMatchObject({ applied: true, sessions: 0, freedBytes: 0 });
  });

  it('no state that is active is ever a candidate, and every other state is', async () => {
    const db = database();
    const ids = new Map<string, number>();
    for (const state of LIFECYCLE_STATES) ids.set(state, addSession(db, { state }));
    const plan = await applyRetention(db, CTX, POLICY, { dryRun: true, now: NOW });
    expect(plan.sessions).toBe(6);
    expect(plan.sessionSample.map((s) => s.state).sort()).toEqual(
      ['completed', 'failed', 'stale', 'turn_ended', 'unknown', 'waiting_input'].sort(),
    );
    await applyRetention(db, CTX, POLICY, { dryRun: false, now: NOW });
    const left = db.driver
      .prepare<{ state: string }>('SELECT state FROM sessions ORDER BY id')
      .all()
      .map((row) => row.state);
    expect(left).toEqual(['running', 'working', 'waiting_tool', 'waiting_agent']);
  });

  it('a pinned session is never a candidate, however old and however finished', async () => {
    const db = database();
    addSession(db, { state: 'completed', pinned: 1 });
    addSession(db, { state: 'completed' });
    const plan = await applyRetention(db, CTX, POLICY, { dryRun: true, now: NOW });
    expect(plan.sessions).toBe(1);
  });

  it('the cutoff is exclusive: a session whose last activity is exactly at it stays', async () => {
    const db = database();
    const at = addSession(db, { last_activity_at: CUTOFF });
    const before = addSession(db, { last_activity_at: CUTOFF - 1 });
    await applyRetention(db, CTX, POLICY, { dryRun: false, now: NOW });
    const left = db.driver
      .prepare<{ id: number }>('SELECT id FROM sessions')
      .all()
      .map((row) => row.id);
    expect(left).toEqual([at]);
    expect(left).not.toContain(before);
  });

  it('lists the 20 oldest candidates, oldest first, and counts them all', async () => {
    const db = database();
    for (let i = 0; i < 25; i += 1)
      addSession(db, { last_activity_at: CUTOFF - (i + 1) * HOUR, label: `FIXTURE ${String(i)}` });
    const plan = await applyRetention(db, CTX, POLICY, { dryRun: true, now: NOW });
    expect(plan.sessions).toBe(25);
    expect(plan.sessionSample).toHaveLength(20);
    expect(plan.sessionSample.map((s) => s.label)).toEqual(
      Array.from({ length: 20 }, (_, i) => `FIXTURE ${String(24 - i)}`),
    );
    const times = plan.sessionSample.map((s) => s.lastActivityAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('the days of the policy decide the cutoffs', async () => {
    const db = database();
    const plan = await applyRetention(
      db,
      CTX,
      { sessionsOlderThanDays: 7, eventsOlderThanDays: 3 },
      { dryRun: true, now: NOW },
    );
    expect(plan.sessionsCutoff).toBe(NOW - 7 * DAY);
    expect(plan.eventsCutoff).toBe(NOW - 3 * DAY);
  });
});

describe('the limits of the automatic run', () => {
  it('a row exactly at a limit stays: change log age, resolved alerts and hook probes', async () => {
    const db = database();
    const change = db.driver.prepare(
      "INSERT INTO changes (at, kind, op, payload) VALUES (?, 'health', 'upsert', '{}')",
    );
    change.run([NOW - SETTINGS.changesMaxAgeHours * HOUR]);
    change.run([NOW - SETTINGS.changesMaxAgeHours * HOUR - 1]);
    const alert = (key: string, resolvedAt: number): void => {
      db.driver
        .prepare(
          `INSERT INTO alerts (rule_id, rule_kind, scope_kind, scope_key, severity, status, title, first_fired_at,
             last_fired_at, resolved_at, resolved_reason)
           VALUES ('hook_failing', 'hook_failing', 'instance', ?, 'warning', 'resolved', 'FIXTURE', 1, 1, ?, 'condition_cleared')`,
        )
        .run([key, resolvedAt]);
    };
    alert('at', NOW - SETTINGS.resolvedAlertsDays * DAY);
    alert('before', NOW - SETTINGS.resolvedAlertsDays * DAY - 1);
    const probe = db.driver.prepare(
      'INSERT INTO hook_probes (probe_session_id, received_at, committed_at) VALUES (?, 1, ?)',
    );
    probe.run(['eeeeeeee-0000-4000-8000-000000000001', NOW - 24 * HOUR]);
    probe.run(['eeeeeeee-0000-4000-8000-000000000002', NOW - 24 * HOUR - 1]);

    const removed = await runBookkeepingRetention(db, CTX, SETTINGS, NOW);

    expect(removed).toMatchObject({ changes: 1, resolvedAlerts: 1, hookProbes: 1 });
    expect(db.driver.prepare('SELECT scope_key AS key FROM alerts').all()).toEqual([{ key: 'at' }]);
    expect(db.driver.prepare('SELECT probe_session_id AS id FROM hook_probes').all()).toEqual([
      { id: 'eeeeeeee-0000-4000-8000-000000000001' },
    ]);
  });

  it('keeps the newest ingest errors up to the limit and deletes the older ones', async () => {
    const db = database();
    const insert = db.driver.prepare(
      "INSERT INTO ingest_errors (at, source, code, detail) VALUES (?, 'spool', 'E_FIXTURE', 'x')",
    );
    db.driver.transaction(() => {
      for (let i = 0; i < 130; i += 1) insert.run([NOW - 130 + i]);
    });
    const removed = await runBookkeepingRetention(db, CTX, { ...SETTINGS, ingestErrorsMaxRows: 100 }, NOW, {
      batchRows: 7,
    });
    expect(removed.ingestErrors).toBe(30);
    const times = db.driver
      .prepare<{ at: number }>('SELECT at FROM ingest_errors ORDER BY at')
      .all()
      .map((row) => row.at);
    expect(times).toHaveLength(100);
    expect(times[0]).toBe(NOW - 100);
  });
});
