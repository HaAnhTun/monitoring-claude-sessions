// Retention over real databases (03 3.8, 19.8, WP-60). Both classes are proven against the rows they may and may not touch:
//   DA-T-E-4  data retention: a dry run changes nothing (sha256 of the database file, size of the WAL); an apply deletes exactly
//             the planned sessions and what hangs on them; active, pinned and recent sessions survive; attempt runs are
//             detached, never deleted; the transcript files become retired tombstones that the importer leaves alone; a
//             message that another session's file still holds moves there and the totals stay exact
//   DA-T-E-5  bookkeeping retention: an automatic run changes only the listed bookkeeping tables and never sessions or attempts
//   and both while the ingest writer commits between their transactions.
// Every row is synthetic and every database lives in a temp folder.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUNTIME_VERSION, RuntimeFileSchema } from '@mcs/shared';
import { sanitizeProjectName } from '@mcs/shared/protocol';
import { FakeClock, bigTranscript, buildClaudeHome, useTempDirs, type TranscriptBuilder } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import type { SqlValue } from '../src/db/driver.ts';
import { isDbError } from '../src/db/errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../src/db/open.ts';
import { TranscriptFilesRepo } from '../src/db/repos/transcript-files.ts';
import { UsageRepo, type UsageValues } from '../src/db/repos/usage.ts';
import { onCommitted, withWriteTx } from '../src/db/write.ts';
import { createIngestService } from '../src/ingest/service.ts';
import { applyRetention, runBookkeepingRetention } from '../src/maintenance/retention.ts';
import { buildInstanceContext, type InstanceContext } from '../src/runtime/context.ts';
import { initWorkspace } from '../src/workspace/init.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const CTX: RepoContext = { instanceId: ID };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const RETENTION = RuntimeFileSchema.parse({ schema_version: 1 }).retention;

const opened: InstanceDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function open(mode: 'serve' | 'readonly' | 'maintenance' = 'serve', dir = makeTemp('retention-int').path): InstanceDb {
  const db = openInstanceDb({
    path: path.join(dir, 'monitor.db'),
    expectedInstanceId: ID,
    mode,
    runtimeVersion: RUNTIME_VERSION,
    clock: new FakeClock(NOW),
  });
  opened.push(db);
  return db;
}

// ---- seeding -----------------------------------------------------------------------------------------------------------------

function insert(db: InstanceDb, table: string, row: Record<string, SqlValue>): number {
  const columns = Object.keys(row);
  return db.driver
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => `:${column}`).join(', ')})`,
    )
    .run(row).lastInsertRowid;
}

function count(db: InstanceDb, sql: string, params: Record<string, SqlValue> = {}): number {
  return db.driver.prepare<{ n: number }>(sql).get(params)?.n ?? -1;
}

const uidOf = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface Seeded {
  readonly id: number;
  readonly uid: string;
  readonly main: number;
  readonly file: number;
}

interface SessionOptions {
  readonly lastActivityAt: number;
  readonly state?: string;
  readonly pinned?: boolean;
  /** Birth time of the main transcript file: the oldest file owns a message that several files hold. */
  readonly birthMs?: number;
}

function addSession(db: InstanceDb, n: number, o: SessionOptions): Seeded {
  const uid = uidOf(n);
  const startedAt = o.lastActivityAt - HOUR;
  const id = insert(db, 'sessions', {
    session_uid: uid,
    label: `FIXTURE session ${String(n)}`,
    state: o.state ?? 'completed',
    pinned: o.pinned === true ? 1 : 0,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: o.lastActivityAt,
    updated_at: o.lastActivityAt,
  });
  const main = insert(db, 'agents', {
    session_id: id,
    agent_uid: 'main',
    kind: 'main',
    depth: 0,
    first_seen_at: startedAt,
    started_at: startedAt,
    last_activity_at: o.lastActivityAt,
    updated_at: o.lastActivityAt,
  });
  const file = insert(db, 'transcript_files', {
    path: `FIXTURE/projects/${uid}.jsonl`,
    path_key: `fixture/projects/${uid}.jsonl`,
    kind: 'session',
    session_uid: uid,
    session_id: id,
    agent_id: main,
    birth_ms: o.birthMs ?? startedAt,
    discovered_at: startedAt,
    updated_at: startedAt,
  });
  return { id, uid, main, file };
}

let eventCounter = 0;

function addEvents(db: InstanceDb, s: Seeded, times: readonly number[]): void {
  for (const ts of times) {
    eventCounter += 1;
    insert(db, 'events', {
      session_id: s.id,
      agent_id: s.main,
      kind: 'tool.call',
      sources: 1,
      ts,
      ts_source: 'record',
      received_at: ts,
      natural_key: `fixture:event:${String(eventCounter)}`,
    });
  }
  db.driver
    .prepare('UPDATE sessions SET event_count = (SELECT count(*) FROM events WHERE session_id = :id) WHERE id = :id')
    .run({ id: s.id });
}

/** One of each kind of child row, so that a delete that forgets a table shows. */
function addChildren(db: InstanceDb, s: Seeded, n: number): void {
  const at = NOW - 50 * DAY;
  insert(db, 'tool_calls', {
    session_id: s.id,
    agent_id: s.main,
    tool_use_id: `toolu_fixture_${String(n)}`,
    name: 'Bash',
    updated_at: at,
  });
  insert(db, 'turns', { session_id: s.id, prompt_id: `prompt-${String(n)}`, started_at: at });
  insert(db, 'state_transitions', {
    session_id: s.id,
    to_state: 'completed',
    rule: 'T-1',
    basis: 'observed',
    confidence: 'high',
    at,
  });
  insert(db, 'reconciliations', {
    session_id: s.id,
    scope_key: s.uid,
    kind: 'hook_gap',
    at,
    detail_hash: String(n).padStart(32, '0'),
  });
  insert(db, 'cost_states', { file_id: s.file, session_id: s.id, byte_offset: 0, observed_at: at });
  insert(db, 'transcript_checkpoints', { file_id: s.file, entry_index: 0, byte_offset: 0 });
  insert(db, 'entry_occurrences', { file_id: s.file, byte_offset: 10, record_uuid: `fixture-record-${String(n)}` });
}

function tokens(input: number): UsageValues {
  return {
    model: 'fixture-model',
    inputTokens: input,
    outputTokens: input * 2,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
    thinkingTokens: null,
    webSearchRequests: null,
    webFetchRequests: null,
    legacyIn: input,
    legacyOut: input * 2,
    legacyCr: 0,
    legacyCc: 0,
    finalized: true,
    usageSource: 'top',
    synthetic: false,
    ts: NOW - 50 * DAY,
    invalidValues: 0,
  };
}

function addUsage(db: InstanceDb, s: Seeded, key: string, input: number): void {
  withWriteTx(db, CTX, (tx) => {
    new UsageRepo(db).applyRecord(CTX, tx, s.file, key, tokens(input));
  });
}

/** An attempt source with one run matched to the session. */
function addAttempt(db: InstanceDb, s: Seeded): number {
  const source = insert(db, 'attempt_sources', {
    path: 'FIXTURE/chain.log',
    path_key: 'fixture/chain.log',
    head_len: 0,
    head_hash: 'a'.repeat(64),
    config_sha256: 'b'.repeat(64),
    updated_at: NOW,
  });
  return insert(db, 'attempt_runs', {
    source_id: source,
    generation: 1,
    start_offset: 0,
    part: 'A',
    started_at: NOW - 50 * DAY,
    evidence: 'FIXTURE running',
    session_id: s.id,
    match_delta_ms: 1000,
    updated_at: NOW,
  });
}

function addAlert(db: InstanceDb, s: Seeded | null, over: Record<string, SqlValue> = {}): number {
  return insert(db, 'alerts', {
    rule_id: 'inactivity',
    rule_kind: 'inactivity',
    scope_kind: s === null ? 'instance' : 'session',
    scope_key: s === null ? 'instance' : s.uid,
    session_id: s === null ? null : s.id,
    severity: 'warning',
    status: 'open',
    title: 'FIXTURE alert',
    first_fired_at: NOW - 50 * DAY,
    last_fired_at: NOW - 50 * DAY,
    ...over,
  });
}

const OLD = NOW - 40 * DAY;
const RECENT = NOW - DAY;

// ---- reading back -----------------------------------------------------------------------------------------------------------

const TABLES = [
  'sessions',
  'agents',
  'workflow_runs',
  'turns',
  'tool_calls',
  'events',
  'usage',
  'usage_files',
  'cost_states',
  'state_transitions',
  'reconciliations',
  'external_observations',
  'work_items',
  'work_item_sessions',
  'transcript_files',
  'transcript_checkpoints',
  'entry_occurrences',
  'attempt_sources',
  'attempt_runs',
  'alerts',
  'alert_state',
  'hook_probes',
  'ingest_errors',
  'changes',
  'meta',
  'projects',
  'spool_cursors',
  'ingest_health',
] as const;

/** The number of rows of every table. */
function rowCounts(db: InstanceDb, tables: readonly string[] = TABLES): Record<string, number> {
  return Object.fromEntries(tables.map((table) => [table, count(db, `SELECT count(*) AS n FROM ${table}`)]));
}

/** A hash of every row of the given tables, so that an edit that keeps the count shows too. */
function tableHash(db: InstanceDb, tables: readonly string[]): string {
  const hash = createHash('sha256');
  for (const table of tables) {
    hash.update(`${table}\n`);
    // a full scan answers in the order of the table itself (rowid, or the primary key of a WITHOUT ROWID table)
    for (const row of db.driver.prepare(`SELECT * FROM ${table}`).all()) {
      hash.update(JSON.stringify(row));
    }
  }
  return hash.digest('hex');
}

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** The database is whole: its integrity and its foreign keys hold, and the rollups equal the sums of their rows. */
function expectConsistent(db: InstanceDb, scope: RepoContext = CTX): void {
  expect(db.driver.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
  expect(db.driver.pragma('foreign_key_check')).toEqual([]);
  expect(new UsageRepo(db).verifyRollups(scope)).toEqual([]);
}

function yieldOnce(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

// ---- DA-T-E-4: data retention -----------------------------------------------------------------------------------------------

/** Old sessions A and A2 (to delete), a pinned old session, an active old one, a recent one; A shares a message with the recent one. */
function world(db: InstanceDb): {
  a: Seeded;
  a2: Seeded;
  pinned: Seeded;
  active: Seeded;
  recent: Seeded;
  itemId: number;
  attemptId: number;
  alertId: number;
} {
  const a = addSession(db, 1, { lastActivityAt: OLD, birthMs: 1000 });
  const a2 = addSession(db, 2, { lastActivityAt: OLD + HOUR, state: 'failed' });
  const pinned = addSession(db, 3, { lastActivityAt: OLD, pinned: true });
  const active = addSession(db, 4, { lastActivityAt: OLD, state: 'running' });
  const recent = addSession(db, 5, { lastActivityAt: RECENT, birthMs: 2000 });
  for (const [n, s] of [a, a2, pinned, active, recent].entries()) {
    addEvents(db, s, [NOW - 60 * DAY, NOW - 50 * DAY, NOW - HOUR]);
    addChildren(db, s, n + 1);
  }
  // `shared` is held by the file of A (the older file, which owns it) and by the file of the recent session
  addUsage(db, a, 'msg_only_a', 10);
  addUsage(db, a, 'msg_shared', 100);
  addUsage(db, recent, 'msg_shared', 100);
  addUsage(db, recent, 'msg_only_recent', 1);
  addUsage(db, a2, 'msg_only_a2', 5);
  const itemId = insert(db, 'work_items', {
    item_key: 'label:FIXTURE item',
    kind: 'label',
    title: 'FIXTURE item',
    state: 'completed',
    rule: 'W-LBL',
    board_reason: 'done',
    state_since: OLD,
    session_count: 2,
    created_at: OLD,
    updated_at: OLD,
  });
  insert(db, 'work_item_sessions', { work_item_id: itemId, session_id: a.id, linked_at: OLD });
  insert(db, 'work_item_sessions', { work_item_id: itemId, session_id: recent.id, linked_at: OLD });
  const attemptId = addAttempt(db, a);
  const alertId = addAlert(db, a);
  return { a, a2, pinned, active, recent, itemId, attemptId, alertId };
}

const SESSIONS_30D = { sessionsOlderThanDays: 30, eventsOlderThanDays: null } as const;

describe('DA-T-E-4: data retention (applyRetention)', () => {
  it('a dry run only reads: the database bytes and the WAL stay as they were, and the plan names what an apply deletes', async () => {
    const dir = makeTemp('retention-dry').path;
    const db = open('serve', dir);
    const w = world(db);
    db.driver.pragma('wal_checkpoint(TRUNCATE)');
    const file = path.join(dir, 'monitor.db');
    const before = { hash: sha256Of(file), wal: sizeOf(`${file}-wal`), counts: rowCounts(db) };

    const plan = await applyRetention(db, CTX, SESSIONS_30D, { dryRun: true, now: NOW });

    expect(plan).toMatchObject({
      applied: false,
      freedBytes: null,
      now: NOW,
      sessionsCutoff: NOW - 30 * DAY,
      eventsCutoff: null,
      sessions: 2,
      reownedMessages: 1,
      rows: {
        agents: 2,
        events: 6,
        toolCalls: 2,
        turns: 2,
        usage: 3,
        usageFiles: 3,
        transitions: 2,
        reconciliations: 2,
        costStates: 2,
        checkpoints: 2,
        attemptRunsDetached: 1,
      },
    });
    expect(plan.sessionSample.map((s) => [s.sessionId, s.state, s.lastActivityAt, s.label])).toEqual([
      [w.a.uid, 'completed', OLD, 'FIXTURE session 1'],
      [w.a2.uid, 'failed', OLD + HOUR, 'FIXTURE session 2'],
    ]);
    expect(sha256Of(file)).toBe(before.hash);
    expect(sizeOf(`${file}-wal`)).toBe(before.wal);
    expect(rowCounts(db)).toEqual(before.counts);
  });

  it('a dry run works on a read-only connection; an apply is refused there', async () => {
    const dir = makeTemp('retention-readonly').path;
    const writer = open('serve', dir);
    world(writer);
    writer.close();
    const reader = open('readonly', dir);
    const plan = await applyRetention(reader, CTX, SESSIONS_30D, { dryRun: true, now: NOW });
    expect(plan.sessions).toBe(2);
    const refused = await applyRetention(reader, CTX, SESSIONS_30D, { dryRun: false, now: NOW }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isDbError(refused, 'db_readonly')).toBe(true);
  });

  it('an apply deletes exactly the planned sessions and what hangs on them, and spares pinned, active and recent ones', async () => {
    const db = open();
    const w = world(db);
    const planned = await applyRetention(db, CTX, SESSIONS_30D, { dryRun: true, now: NOW });
    const before = rowCounts(db);

    const result = await applyRetention(db, CTX, SESSIONS_30D, { dryRun: false, now: NOW });

    expect(result).toMatchObject({ applied: true, sessions: 2, rows: planned.rows, reownedMessages: 1 });
    expect(result.freedBytes).toBeGreaterThanOrEqual(0);
    const alive = db.driver
      .prepare<{ session_uid: string }>('SELECT session_uid FROM sessions ORDER BY id')
      .all()
      .map((row) => row.session_uid);
    expect(alive).toEqual([w.pinned.uid, w.active.uid, w.recent.uid]);
    const after = rowCounts(db);
    expect(after['sessions']).toBe(3);
    expect(after['agents']).toBe((before['agents'] ?? 0) - planned.rows.agents);
    expect(after['events']).toBe((before['events'] ?? 0) - planned.rows.events);
    expect(after['tool_calls']).toBe((before['tool_calls'] ?? 0) - planned.rows.toolCalls);
    expect(after['turns']).toBe((before['turns'] ?? 0) - planned.rows.turns);
    expect(after['state_transitions']).toBe((before['state_transitions'] ?? 0) - planned.rows.transitions);
    expect(after['reconciliations']).toBe((before['reconciliations'] ?? 0) - planned.rows.reconciliations);
    expect(after['cost_states']).toBe((before['cost_states'] ?? 0) - planned.rows.costStates);
    expect(after['transcript_checkpoints']).toBe((before['transcript_checkpoints'] ?? 0) - planned.rows.checkpoints);
    // the rows of the sessions that stay are untouched: three events each
    for (const stays of [w.pinned, w.active, w.recent]) {
      expect(count(db, 'SELECT count(*) AS n FROM events WHERE session_id = :id', { id: stays.id })).toBe(3);
      expect(count(db, 'SELECT count(*) AS n FROM agents WHERE session_id = :id', { id: stays.id })).toBe(1);
    }
    expectConsistent(db);
  });

  it('detaches attempt runs instead of deleting them, resolves the open alerts of the sessions, recounts the work item and records the deletes', async () => {
    const db = open();
    const w = world(db);
    const attemptsBefore = rowCounts(db, ['attempt_runs', 'attempt_sources']);
    const seqBefore = db.headSeq();

    await applyRetention(db, CTX, SESSIONS_30D, { dryRun: false, now: NOW });

    expect(rowCounts(db, ['attempt_runs', 'attempt_sources'])).toEqual(attemptsBefore);
    expect(
      db.driver
        .prepare('SELECT session_id AS sessionId, match_delta_ms AS delta, part FROM attempt_runs WHERE id = :id')
        .get({ id: w.attemptId }),
    ).toEqual({ sessionId: null, delta: null, part: 'A' });
    expect(
      db.driver
        .prepare('SELECT status, resolved_reason AS reason, session_id AS sessionId FROM alerts WHERE id = :id')
        .get({ id: w.alertId }),
    ).toEqual({ status: 'resolved', reason: 'scope_deleted', sessionId: null });
    expect(db.driver.prepare('SELECT session_count AS n FROM work_items WHERE id = :id').get({ id: w.itemId })).toEqual(
      { n: 1 },
    );
    const changes = db.driver
      .prepare<{ kind: string; op: string; sessionUid: string | null }>(
        'SELECT kind, op, session_uid AS sessionUid FROM changes WHERE seq > :seq ORDER BY seq',
      )
      .all({ seq: seqBefore });
    const deleted = changes.filter((c) => c.kind === 'session' && c.op === 'delete').map((c) => c.sessionUid);
    expect(deleted.sort()).toEqual([w.a.uid, w.a2.uid].sort());
    expect(changes.some((c) => c.kind === 'attempt' && c.op === 'upsert')).toBe(true);
    expect(changes.some((c) => c.kind === 'work_item' && c.op === 'upsert')).toBe(true);
  });

  it('moves a message that another session still holds to that session and keeps every total exact', async () => {
    const db = open();
    const w = world(db);
    const owner = (key: string): number | undefined =>
      db.driver.prepare<{ session_id: number }>('SELECT session_id FROM usage WHERE message_key = :key').get({ key })
        ?.session_id;
    expect(owner('msg_shared')).toBe(w.a.id);
    const rollup = (id: number): number => count(db, 'SELECT tok_input AS n FROM sessions WHERE id = :id', { id });
    expect(rollup(w.recent.id)).toBe(1);

    await applyRetention(db, CTX, SESSIONS_30D, { dryRun: false, now: NOW });

    expect(owner('msg_shared')).toBe(w.recent.id);
    expect(owner('msg_only_a')).toBeUndefined();
    expect(owner('msg_only_a2')).toBeUndefined();
    expect(owner('msg_only_recent')).toBe(w.recent.id);
    // the recent session now carries 1 + 100 input tokens, and the rollups of sessions and agents equal their usage rows
    expect(rollup(w.recent.id)).toBe(101);
    expect(
      db.driver.prepare('SELECT tok_input AS input, tok_output AS output FROM agents WHERE id = :id').get({
        id: w.recent.main,
      }),
    ).toEqual({ input: 101, output: 202 });
    expect(count(db, "SELECT files AS n FROM usage WHERE message_key = 'msg_shared'")).toBe(1);
    expectConsistent(db);
  });

  it('keeps the transcript files of deleted sessions as retired tombstones with their cursors, and never re-links them', async () => {
    const db = open();
    const w = world(db);
    db.driver.prepare('UPDATE transcript_files SET tail_offset = 500, size_seen = 500 WHERE id = :id').run({
      id: w.a.file,
    });

    await applyRetention(db, CTX, SESSIONS_30D, { dryRun: false, now: NOW });

    const tombstone = db.driver
      .prepare(
        `SELECT state, session_id AS sessionId, agent_id AS agentId, tail_offset AS tail, index_offset AS indexOffset,
                session_uid AS sessionUid FROM transcript_files WHERE id = :id`,
      )
      .get({ id: w.a.file });
    expect(tombstone).toEqual({
      state: 'retired',
      sessionId: null,
      agentId: null,
      tail: 500,
      indexOffset: 0,
      sessionUid: w.a.uid,
    });
    expect(count(db, 'SELECT count(*) AS n FROM usage_files WHERE file_id = :id', { id: w.a.file })).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM entry_occurrences WHERE file_id = :id', { id: w.a.file })).toBe(0);
    // finding the file again changes nothing: it stays retired and unlinked, and the importer does not load it
    const files = new TranscriptFilesRepo(db);
    const registered = withWriteTx(db, CTX, (tx) =>
      files.register(CTX, tx, {
        path: `FIXTURE/projects/${w.a.uid}.jsonl`,
        pathKey: `fixture/projects/${w.a.uid}.jsonl`,
        kind: 'session',
        sessionUid: w.a.uid,
        agentUid: null,
        runUid: null,
        sessionId: null,
        agentId: null,
        workflowRunId: null,
        birthMs: null,
        firstSeenMtimeMs: null,
        mtimeSeen: null,
      }),
    );
    expect(registered).toEqual({ id: w.a.file, created: false });
    expect(files.get(CTX, w.a.file)).toMatchObject({ state: 'retired', sessionId: null });
    expect(
      files.listByStates(CTX, ['active', 'missing', 'unreadable', 'untracked'], 100).map((f) => f.id),
    ).not.toContain(w.a.file);
  });

  it('timeline retention deletes old events of sessions that stay, recounts them, and spares pinned and active sessions', async () => {
    const db = open();
    const kept = addSession(db, 10, { lastActivityAt: RECENT });
    const pinned = addSession(db, 11, { lastActivityAt: RECENT, pinned: true });
    const active = addSession(db, 12, { lastActivityAt: RECENT, state: 'working' });
    const t = (days: number): number => NOW - days * DAY;
    for (const s of [kept, pinned, active]) addEvents(db, s, [t(30), t(20), t(2), t(1)]);
    addChildren(db, kept, 10);
    addUsage(db, kept, 'msg_kept', 7);

    const policy = { sessionsOlderThanDays: null, eventsOlderThanDays: 10 } as const;
    const plan = await applyRetention(db, CTX, policy, { dryRun: true, now: NOW });
    expect(plan).toMatchObject({ sessions: 0, eventsCutoff: NOW - 10 * DAY, rows: { events: 2, toolCalls: 0 } });
    const result = await applyRetention(db, CTX, policy, { dryRun: false, now: NOW });

    expect(result.rows.events).toBe(2);
    const eventsOf = (id: number): number[] =>
      db.driver
        .prepare<{ ts: number }>('SELECT ts FROM events WHERE session_id = :id ORDER BY ts')
        .all({ id })
        .map((row) => row.ts);
    expect(eventsOf(kept.id)).toEqual([t(2), t(1)]);
    expect(eventsOf(pinned.id)).toHaveLength(4);
    expect(eventsOf(active.id)).toHaveLength(4);
    expect(count(db, 'SELECT event_count AS n FROM sessions WHERE id = :id', { id: kept.id })).toBe(2);
    // sessions, tool calls, turns and usage are kept
    expect(rowCounts(db, ['sessions', 'tool_calls', 'turns', 'usage'])).toEqual({
      sessions: 3,
      tool_calls: 1,
      turns: 1,
      usage: 1,
    });
    expectConsistent(db);
  });

  it('works in batches and an abort between two batches leaves a consistent database with the first batch gone', async () => {
    const db = open();
    for (let n = 1; n <= 7; n += 1) addSession(db, n, { lastActivityAt: OLD + n * HOUR });
    const keeper = addSession(db, 20, { lastActivityAt: RECENT });
    const controller = new AbortController();
    let commits = 0;
    onCommitted(db, () => {
      commits += 1;
      if (commits === 1) controller.abort();
    });

    const stopped = await applyRetention(db, CTX, SESSIONS_30D, {
      dryRun: false,
      now: NOW,
      signal: controller.signal,
      batch: { sessions: 2 },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(stopped).toBeInstanceOf(Error);
    expect(stopped instanceof Error ? stopped.name : '').toBe('AbortError');
    // the first batch (the two oldest sessions) is gone, the rest is untouched
    expect(count(db, 'SELECT count(*) AS n FROM sessions')).toBe(6);
    expect(count(db, 'SELECT count(*) AS n FROM sessions WHERE id = :id', { id: keeper.id })).toBe(1);
    expectConsistent(db);

    // the same call again, uninterrupted, finishes the job in several transactions
    commits = 0;
    const done = await applyRetention(db, CTX, SESSIONS_30D, { dryRun: false, now: NOW, batch: { sessions: 2 } });
    expect(done).toMatchObject({ applied: true, sessions: 5 });
    expect(commits).toBeGreaterThanOrEqual(3);
    expect(count(db, 'SELECT count(*) AS n FROM sessions')).toBe(1);
    expectConsistent(db);
  });

  it('refuses a foreign instance and a policy that is not whole days', async () => {
    const db = open();
    world(db);
    const foreign = await applyRetention(db, { instanceId: OTHER_ID }, SESSIONS_30D, { dryRun: true, now: NOW }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isDbError(foreign, 'scope_mismatch')).toBe(true);
    for (const days of [0, -3, 1.5, Number.NaN]) {
      await expect(
        applyRetention(db, CTX, { sessionsOlderThanDays: days, eventsOlderThanDays: null }, { dryRun: true, now: NOW }),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('with no policy there is nothing to delete', async () => {
    const db = open();
    world(db);
    const before = rowCounts(db);
    const result = await applyRetention(
      db,
      CTX,
      { sessionsOlderThanDays: null, eventsOlderThanDays: null },
      { dryRun: false, now: NOW },
    );
    expect(result).toMatchObject({ applied: true, sessions: 0, sessionSample: [], reownedMessages: 0 });
    expect(rowCounts(db)).toEqual(before);
  });

  it('an ingest writer that commits between the batches loses nothing and is never deleted', async () => {
    const db = open();
    for (let n = 1; n <= 6; n += 1) addSession(db, n, { lastActivityAt: OLD + n * HOUR });
    const live = addSession(db, 30, { lastActivityAt: NOW - 1000, state: 'working' });
    let written = 0;
    const writer = (async (): Promise<void> => {
      for (let i = 0; i < 25; i += 1) {
        withWriteTx(db, CTX, (tx) => {
          insert(db, 'events', {
            session_id: live.id,
            agent_id: live.main,
            kind: 'tool.call',
            sources: 1,
            ts: tx.now,
            ts_source: 'record',
            received_at: tx.now,
            natural_key: `fixture:live:${String(i)}`,
          });
        });
        written += 1;
        await yieldOnce();
      }
    })();

    const result = await applyRetention(db, CTX, SESSIONS_30D, { dryRun: false, now: NOW, batch: { sessions: 2 } });
    await writer;

    expect(result.sessions).toBe(6);
    expect(written).toBe(25);
    expect(count(db, 'SELECT count(*) AS n FROM events WHERE session_id = :id', { id: live.id })).toBe(25);
    expect(count(db, 'SELECT count(*) AS n FROM sessions')).toBe(1);
    expectConsistent(db);
  });
});

// ---- the importer leaves a retired file alone -------------------------------------------------------------------------------

const SESSION = '66666666-6666-4666-8666-666666666666';
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');

describe('DA-T-E-4: a retired transcript file is not imported again', () => {
  const contexts: InstanceContext[] = [];
  afterEach(async () => {
    for (const ctx of contexts.splice(0)) {
      ctx.db.close();
      await ctx.logger.close();
    }
  });

  /** A real instance (workspace, database, Claude home) with one session whose transcript the importer reads. */
  async function ingestInstance(build: (b: TranscriptBuilder) => void, bigBytes?: number): Promise<InstanceContext> {
    const root = makeTemp('retention-ingest').path;
    const skill = path.join(root, 'skill');
    mkdirSync(path.join(skill, 'config'), { recursive: true });
    mkdirSync(path.join(skill, 'runtime'), { recursive: true });
    writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
    writeFileSync(path.join(skill, 'runtime', 'defaults.json'), '{"schema_version": 1}\n');
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo' });
    const claudeHome = path.join(root, 'claude-home');
    const startMs = Date.now() - 3 * HOUR;
    buildClaudeHome(claudeHome, {
      nowMs: Date.now(),
      sessions: [
        {
          id: SESSION,
          project: sanitizeProjectName(repo),
          cwd: repo,
          startMs,
          build,
        },
      ],
    });
    if (bigBytes !== undefined) {
      bigTranscript({ sessionId: SESSION, targetBytes: bigBytes }).write(
        path.join(claudeHome, 'projects', sanitizeProjectName(repo), `${SESSION}.jsonl`),
      );
    }
    const ctx = await buildInstanceContext({
      instanceDir: ws.dir,
      env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: claudeHome },
      cli: {},
      skillDir: skill,
      runtimeDir: path.join(skill, 'runtime'),
      build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    });
    contexts.push(ctx);
    return ctx;
  }

  it('after the retention a new ingest service does not bring the deleted session back from the transcript that is still on disk', async () => {
    const ctx = await ingestInstance((b) => {
      b.user('FIXTURE prompt');
      b.assistant({ messageId: 'msg_fixture_a', stop: 'end_turn' });
    });

    const first = createIngestService(ctx);
    await first.start();
    await first.untilIdle({ timeoutMs: 30_000 });
    await first.stop(Date.now() + 2000);
    expect(count(ctx.db, 'SELECT count(*) AS n FROM sessions')).toBe(1);
    expect(count(ctx.db, 'SELECT count(*) AS n FROM events')).toBeGreaterThan(0);
    ctx.db.driver.prepare("UPDATE sessions SET state = 'completed'").run();

    const result = await applyRetention(
      ctx.db,
      ctx.scope,
      { sessionsOlderThanDays: 1, eventsOlderThanDays: null },
      { dryRun: false, now: Date.now() + 10 * DAY },
    );
    expect(result.sessions).toBe(1);
    expect(count(ctx.db, 'SELECT count(*) AS n FROM sessions')).toBe(0);
    expect(count(ctx.db, "SELECT count(*) AS n FROM transcript_files WHERE state = 'retired'")).toBe(1);

    const second = createIngestService(ctx);
    await second.start();
    await second.untilIdle({ timeoutMs: 30_000 });
    await second.stop(Date.now() + 2000);

    expect(rowCounts(ctx.db, ['sessions', 'agents', 'events', 'tool_calls', 'usage', 'usage_files'])).toEqual({
      sessions: 0,
      agents: 0,
      events: 0,
      tool_calls: 0,
      usage: 0,
      usage_files: 0,
    });
    expect(count(ctx.db, "SELECT count(*) AS n FROM transcript_files WHERE state = 'retired'")).toBe(1);
  }, 60_000);

  it('the automatic retention runs again and again while the real ingest writer imports a transcript, and neither loses a row', async () => {
    const ctx = await ingestInstance(() => undefined, 6 * 1024 * 1024);
    const service = createIngestService(ctx);
    await service.start();
    // every change row that exists counts as old for this run: the retention keeps deleting what the writer keeps adding
    const later = Date.now() + 3 * DAY;
    let rounds = 0;
    const importing = new AbortController();
    const retention = (async (): Promise<void> => {
      while (!importing.signal.aborted) {
        await runBookkeepingRetention(ctx.db, ctx.scope, RETENTION, later, { batchRows: 40 });
        rounds += 1;
        await yieldOnce();
      }
    })();
    await service.untilIdle({ timeoutMs: 120_000 });
    importing.abort();
    await retention;
    await service.stop(Date.now() + 2000);

    expect(rounds).toBeGreaterThan(3);
    expect(service.stats()).toMatchObject({ failures: 0, queued: 0 });
    expect(count(ctx.db, 'SELECT count(*) AS n FROM sessions WHERE session_uid = :uid', { uid: SESSION })).toBe(1);
    expect(count(ctx.db, 'SELECT count(*) AS n FROM events')).toBeGreaterThan(100);
    expectConsistent(ctx.db, ctx.scope);
  }, 180_000);
});

// ---- DA-T-E-5: bookkeeping retention ----------------------------------------------------------------------------------------

/** Every table that the automatic retention must not touch, and the rows it may not reach in the ones it does. */
const UNTOUCHED = [
  'sessions',
  'agents',
  'workflow_runs',
  'turns',
  'tool_calls',
  'events',
  'usage',
  'cost_states',
  'state_transitions',
  'external_observations',
  'work_items',
  'work_item_sessions',
  'transcript_files',
  'attempt_sources',
  'attempt_runs',
  'meta',
  'projects',
  'spool_cursors',
  'ingest_health',
] as const;

describe('DA-T-E-5: bookkeeping retention (runBookkeepingRetention)', () => {
  it('changes only the bookkeeping tables, and only what is older than its limits', async () => {
    const db = open();
    const old = addSession(db, 1, { lastActivityAt: OLD });
    addEvents(db, old, [OLD]);
    addChildren(db, old, 1);
    addUsage(db, old, 'msg_old', 3);
    addAttempt(db, old);
    const active = addSession(db, 2, { lastActivityAt: NOW - 1000, state: 'running' });
    addEvents(db, active, [NOW - 1000]);

    // the change log: 30 rows from 2 days ago go (changesMaxAgeHours 24), the 5 of the last hour stay
    const insertChange = db.driver.prepare(
      "INSERT INTO changes (at, kind, op, payload) VALUES (?, 'health', 'upsert', '{}')",
    );
    db.driver.transaction(() => {
      for (let i = 0; i < 30; i += 1) insertChange.run([NOW - 48 * HOUR + i]);
      for (let i = 0; i < 5; i += 1) insertChange.run([NOW - HOUR + i]);
    });
    // ingest errors: 150 rows, 100 are kept
    const insertError = db.driver.prepare(
      "INSERT INTO ingest_errors (at, source, code, detail) VALUES (?, 'spool', 'E_FIXTURE', 'x')",
    );
    db.driver.transaction(() => {
      for (let i = 0; i < 150; i += 1) insertError.run([NOW - 150 * 1000 + i * 1000]);
    });
    // alerts: a resolved one from 40 days ago goes, a recent resolved one and an old open one stay
    const resolvedOld = addAlert(db, null, {
      scope_key: 'old',
      status: 'resolved',
      resolved_at: NOW - 40 * DAY,
      resolved_reason: 'condition_cleared',
    });
    const resolvedRecent = addAlert(db, null, {
      scope_key: 'recent',
      status: 'resolved',
      resolved_at: NOW - DAY,
      resolved_reason: 'condition_cleared',
    });
    const openOld = addAlert(db, null, { scope_key: 'open' });
    // alert states: idle and old goes; with a condition, or a cooldown that runs, stays
    const state = (ruleId: string, over: Record<string, SqlValue>): void => {
      insert(db, 'alert_state', {
        rule_id: ruleId,
        scope_key: 's',
        last_evaluated_at: NOW - 40 * DAY,
        ...over,
      });
    };
    state('idle_old', {});
    state('with_condition', { condition_since: NOW - 40 * DAY });
    state('cooling', { cooldown_until: NOW + HOUR });
    // reconciliations: the instance level one from 100 days ago goes; a recent one and a session level one stay
    const reconcile = (scopeKey: string, at: number, sessionId: number | null, hash: string): void => {
      insert(db, 'reconciliations', {
        session_id: sessionId,
        scope_key: scopeKey,
        kind: 'runtime_unavailable',
        at,
        detail_hash: hash.padStart(32, '0'),
      });
    };
    reconcile('instance', NOW - 100 * DAY, null, 'a');
    reconcile('instance', NOW - DAY, null, 'b');
    reconcile(old.uid, NOW - 100 * DAY, old.id, 'c');
    // hook probes: older than 24 h goes
    insert(db, 'hook_probes', {
      probe_session_id: uidOf(900),
      received_at: NOW - 25 * HOUR,
      committed_at: NOW - 25 * HOUR,
    });
    insert(db, 'hook_probes', { probe_session_id: uidOf(901), received_at: NOW - HOUR, committed_at: NOW - HOUR });
    // the rows of a retired file go, those of an active file stay
    const retired = insert(db, 'transcript_files', {
      path: 'FIXTURE/retired.jsonl',
      path_key: 'fixture/retired.jsonl',
      kind: 'session',
      session_uid: uidOf(777),
      state: 'retired',
      discovered_at: OLD,
      updated_at: OLD,
    });
    for (const file of [retired, old.file]) {
      insert(db, 'usage_files', { file_id: file, message_key: `msg_leftover_${String(file)}`, finalized: 1 });
    }
    insert(db, 'transcript_checkpoints', { file_id: retired, entry_index: 0, byte_offset: 0 });
    insert(db, 'transcript_checkpoints', { file_id: retired, entry_index: 256, byte_offset: 9000 });
    insert(db, 'entry_occurrences', { file_id: retired, byte_offset: 1, record_uuid: 'fixture-retired-record' });
    const settings = { ...RETENTION, ingestErrorsMaxRows: 100 };
    const untouchedBefore = tableHash(db, UNTOUCHED);
    const filesBefore = rowCounts(db, ['usage_files']);

    const removed = await runBookkeepingRetention(db, CTX, settings, NOW);

    expect(removed).toMatchObject({
      changes: 30,
      ingestErrors: 50,
      resolvedAlerts: 1,
      alertStates: 1,
      instanceReconciliations: 1,
      hookProbes: 1,
      retiredFileRows: 4,
    });
    // what is left of each bookkeeping table
    const ids = (sql: string): number[] =>
      db.driver
        .prepare<{ id: number }>(sql)
        .all()
        .map((row) => row.id);
    expect(resolvedOld).toBeLessThan(resolvedRecent);
    expect(ids('SELECT id FROM alerts ORDER BY id')).toEqual([resolvedRecent, openOld]);
    expect(
      db.driver
        .prepare<{ ruleId: string }>('SELECT rule_id AS ruleId FROM alert_state ORDER BY rule_id')
        .all()
        .map((row) => row.ruleId),
    ).toEqual(['cooling', 'with_condition']);
    expect(count(db, "SELECT count(*) AS n FROM reconciliations WHERE kind = 'runtime_unavailable'")).toBe(2);
    expect(count(db, 'SELECT count(*) AS n FROM ingest_errors')).toBe(100);
    expect(count(db, 'SELECT count(*) AS n FROM hook_probes')).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM changes WHERE at < :cut', { cut: NOW - 24 * HOUR })).toBe(0);
    expect(filesBefore['usage_files']).toBe(3);
    expect(count(db, 'SELECT count(*) AS n FROM usage_files WHERE file_id = :id', { id: retired })).toBe(0);
    expect(count(db, 'SELECT count(*) AS n FROM usage_files WHERE file_id = :id', { id: old.file })).toBe(2);
    expect(count(db, 'SELECT count(*) AS n FROM transcript_checkpoints WHERE file_id = :id', { id: old.file })).toBe(1);
    // sessions, events, usage, attempts, files and every other table are byte for byte what they were
    expect(tableHash(db, UNTOUCHED)).toBe(untouchedBefore);
    expectConsistent(db);
  });

  it('keeps only the newest rows of the change log when it is longer than changesMaxRows, in batches', async () => {
    const db = open();
    const insertChange = db.driver.prepare(
      "INSERT INTO changes (at, kind, op, payload) VALUES (?, 'health', 'upsert', '{}')",
    );
    db.driver.transaction(() => {
      for (let i = 0; i < 2600; i += 1) insertChange.run([NOW - 1000 + i]);
    });
    const head = db.headSeq();
    let commits = 0;
    onCommitted(db, () => {
      commits += 1;
    });

    const removed = await runBookkeepingRetention(db, CTX, { ...RETENTION, changesMaxRows: 2000 }, NOW, {
      batchRows: 200,
    });

    expect(removed.changes).toBe(600);
    expect(commits).toBeGreaterThanOrEqual(3);
    expect(count(db, 'SELECT count(*) AS n FROM changes')).toBe(2000);
    // the log is cut from the old end: the head is where it was
    expect(db.headSeq()).toBe(head);
    expect(count(db, 'SELECT min(seq) AS n FROM changes')).toBe(head - 1999);
  });

  it('gives the free pages back after a large delete', async () => {
    const db = open();
    const insertChange = db.driver.prepare(
      "INSERT INTO changes (at, kind, op, payload) VALUES (?, 'health', 'upsert', ?)",
    );
    const payload = JSON.stringify({ filler: 'x'.repeat(1900) });
    db.driver.transaction(() => {
      for (let i = 0; i < 3000; i += 1) insertChange.run([NOW - 48 * HOUR, payload]);
    });
    db.driver.pragma('wal_checkpoint(TRUNCATE)');
    const file = db.driver.path;
    const grown = sizeOf(file);

    const removed = await runBookkeepingRetention(db, CTX, RETENTION, NOW);

    expect(removed.changes).toBe(3000);
    expect(removed.vacuumedPages).toBeGreaterThan(100);
    expect(db.driver.pragma('freelist_count')).toEqual([{ freelist_count: 0 }]);
    db.driver.pragma('wal_checkpoint(TRUNCATE)');
    expect(sizeOf(file)).toBeLessThan(grown / 2);
  });

  it('does nothing to an empty database, and an abort stops it between two transactions', async () => {
    const db = open();
    expect(await runBookkeepingRetention(db, CTX, RETENTION, NOW)).toEqual({
      changes: 0,
      ingestErrors: 0,
      resolvedAlerts: 0,
      alertStates: 0,
      instanceReconciliations: 0,
      hookProbes: 0,
      retiredFileRows: 0,
      vacuumedPages: 0,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(runBookkeepingRetention(db, CTX, RETENTION, NOW, { signal: controller.signal })).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
    await expect(runBookkeepingRetention(db, { instanceId: OTHER_ID }, RETENTION, NOW)).rejects.toSatisfy((error) =>
      isDbError(error, 'scope_mismatch'),
    );
  });

  it('an ingest writer that commits between its transactions loses nothing', async () => {
    const db = open();
    const insertChange = db.driver.prepare(
      "INSERT INTO changes (at, kind, op, payload) VALUES (?, 'health', 'upsert', '{}')",
    );
    db.driver.transaction(() => {
      for (let i = 0; i < 1000; i += 1) insertChange.run([NOW - 48 * HOUR]);
    });
    const live = addSession(db, 1, { lastActivityAt: NOW - 1000, state: 'working' });
    const writer = (async (): Promise<void> => {
      for (let i = 0; i < 20; i += 1) {
        withWriteTx(db, CTX, () => {
          insert(db, 'events', {
            session_id: live.id,
            agent_id: live.main,
            kind: 'tool.call',
            sources: 1,
            ts: NOW,
            ts_source: 'record',
            received_at: NOW,
            natural_key: `fixture:live:${String(i)}`,
          });
        });
        await yieldOnce();
      }
    })();

    const removed = await runBookkeepingRetention(db, CTX, RETENTION, NOW, { batchRows: 100 });
    await writer;

    expect(removed.changes).toBe(1000);
    expect(count(db, 'SELECT count(*) AS n FROM events WHERE session_id = :id', { id: live.id })).toBe(20);
    expectConsistent(db);
  });
});
