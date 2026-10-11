import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { DbError } from '../errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../open.ts';
import { withWriteTx } from '../write.ts';
import { UsageRepo, type UsageValues } from './usage.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX: RepoContext = { instanceId: INSTANCE_ID };
const FOREIGN: RepoContext = { instanceId: '22222222-2222-4222-8222-222222222222' };
const S1_UID = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2_UID = 'bbbbbbbb-0000-4000-8000-000000000002';
const T0 = FIXTURE_EPOCH_MS;
const MIN = 60_000;

const opened: InstanceDb[] = [];
// registered after useTempDirs(): Vitest runs `afterEach` hooks in reverse order, so the files close before they are removed
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

interface Fixture {
  readonly db: InstanceDb;
  readonly clock: FakeClock;
  readonly repo: UsageRepo;
  readonly s1: number;
  readonly s2: number;
  readonly main1: number;
  readonly main2: number;
  readonly sub1: number;
  /** F1: main file of S1 (birth T0), F2: subagent file of S1 (T0 + 5 min), F3: main file of S2 (T0 + 60 min) */
  readonly f1: number;
  readonly f2: number;
  readonly f3: number;
}

interface FileSpec {
  readonly path: string;
  readonly sessionId: number | null;
  readonly sessionUid: string;
  readonly agentId: number | null;
  readonly birthMs: number | null;
  readonly firstSeenMs: number | null;
}

function addFile(db: InstanceDb, spec: FileSpec): number {
  return db.driver
    .prepare(
      "INSERT INTO transcript_files (path, path_key, kind, session_uid, session_id, agent_id, birth_ms, first_seen_mtime_ms, discovered_at, updated_at) VALUES (?, ?, 'session', ?, ?, ?, ?, ?, ?, ?)",
    )
    .run([spec.path, spec.path, spec.sessionUid, spec.sessionId, spec.agentId, spec.birthMs, spec.firstSeenMs, T0, T0])
    .lastInsertRowid;
}

function fixture(): Fixture {
  const clock = new FakeClock(T0);
  const db = openInstanceDb({
    path: join(tempDir('usage').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  opened.push(db);
  const session = (uid: string): number =>
    db.driver
      .prepare(
        'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run([uid, T0, T0, T0, T0]).lastInsertRowid;
  const main = (sessionId: number): number =>
    db.driver
      .prepare(
        "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'main', NULL, 'main', 0, ?, ?, ?, ?)",
      )
      .run([sessionId, T0, T0, T0, T0]).lastInsertRowid;
  const s1 = session(S1_UID);
  const s2 = session(S2_UID);
  const main1 = main(s1);
  const main2 = main(s2);
  const sub1 = db.driver
    .prepare(
      "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'agent-a1b2c3', ?, 'subagent', 1, ?, ?, ?, ?)",
    )
    .run([s1, main1, T0, T0, T0, T0]).lastInsertRowid;
  // F1 names its agent, F3 does not: the owner agent of a main file falls back to the main agent row
  const f1 = addFile(db, {
    path: 'f1.jsonl',
    sessionId: s1,
    sessionUid: S1_UID,
    agentId: main1,
    birthMs: T0,
    firstSeenMs: T0 + 1,
  });
  const f2 = addFile(db, {
    path: 'f2.jsonl',
    sessionId: s1,
    sessionUid: S1_UID,
    agentId: sub1,
    birthMs: T0 + 5 * MIN,
    firstSeenMs: T0 + 5 * MIN,
  });
  const f3 = addFile(db, {
    path: 'f3.jsonl',
    sessionId: s2,
    sessionUid: S2_UID,
    agentId: null,
    birthMs: T0 + 60 * MIN,
    firstSeenMs: T0 + 60 * MIN,
  });
  return { db, clock, repo: new UsageRepo(db), s1, s2, main1, main2, sub1, f1, f2, f3 };
}

function values(over: Partial<UsageValues> = {}): UsageValues {
  return {
    model: 'model-x',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    cacheCreation5mTokens: null,
    cacheCreation1hTokens: null,
    thinkingTokens: null,
    webSearchRequests: null,
    webFetchRequests: null,
    legacyIn: 0,
    legacyOut: 0,
    legacyCr: 0,
    legacyCc: 0,
    finalized: false,
    usageSource: 'top',
    synthetic: false,
    ts: null,
    invalidValues: 0,
    ...over,
  };
}

/** The usage of the four main fields (in, out, cache read, cache creation) and the split of the creation, legacy values equal. */
function four(
  i: number,
  o: number,
  cr: number,
  cc: number,
  split: readonly [number, number] | null,
  over: Partial<UsageValues> = {},
): UsageValues {
  return values({
    inputTokens: i,
    outputTokens: o,
    cacheReadTokens: cr,
    cacheCreationTokens: cc,
    cacheCreation5mTokens: split === null ? null : split[0],
    cacheCreation1hTokens: split === null ? null : split[1],
    legacyIn: i,
    legacyOut: o,
    legacyCr: cr,
    legacyCc: cc,
    ...over,
  });
}

interface Rec {
  readonly file: 'f1' | 'f2' | 'f3';
  readonly key: string;
  readonly v: UsageValues;
}

const SYNTHETIC_KEY = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/** The records of the worked example of 02 6.4, in file order (the tests shuffle them). */
function workedExample(): Rec[] {
  const A1 = four(10, 200, 5000, 1000, [0, 1000], { ts: T0 + 1000 });
  const A2 = four(10, 200, 5000, 1000, [0, 1000], { ts: T0 + 1001, finalized: true });
  return [
    { file: 'f1', key: 'msg_A', v: A1 },
    { file: 'f1', key: 'msg_A', v: A2 },
    { file: 'f1', key: 'msg_B', v: four(4, 50, 6000, 0, [0, 0], { ts: T0 + 2000, finalized: true }) },
    // top-level usage is all zero: the iterations fallback supplies the values, the legacy values stay zero
    {
      file: 'f1',
      key: 'msg_Z',
      v: four(2, 300, 959572, 4000, [0, 4000], {
        ts: T0 + 3000,
        finalized: true,
        usageSource: 'iterations',
        legacyIn: 0,
        legacyOut: 0,
        legacyCr: 0,
        legacyCc: 0,
      }),
    },
    {
      file: 'f1',
      key: SYNTHETIC_KEY,
      v: four(0, 0, 0, 0, null, { model: '<synthetic>', ts: T0 + 4000, finalized: true, synthetic: true }),
    },
    // a record without a usage object: every field is missing
    { file: 'f1', key: 'msg_N', v: values({ ts: T0 + 5000, finalized: true }) },
    { file: 'f2', key: 'msg_C', v: four(3, 8, 1000, 200, [200, 0], { model: 'model-y', ts: T0 + 6000 }) },
    { file: 'f2', key: 'msg_C', v: four(3, 8, 1000, 200, [200, 0], { model: 'model-y', ts: T0 + 6001 }) },
    {
      file: 'f2',
      key: 'msg_C',
      v: four(3, 412, 1000, 200, [200, 0], { model: 'model-y', ts: T0 + 6002, finalized: true }),
    },
    { file: 'f2', key: 'msg_D', v: four(5, 8, 800, 0, [0, 0], { model: 'model-y', ts: T0 + 7000 }) },
    { file: 'f2', key: 'msg_D', v: four(5, 8, 800, 0, [0, 0], { model: 'model-y', ts: T0 + 7001 }) },
    // the resumed session S2 begins with copies of the records of msg_A
    { file: 'f3', key: 'msg_A', v: A1 },
    { file: 'f3', key: 'msg_A', v: A2 },
    { file: 'f3', key: 'msg_E', v: four(6, 70, 7000, 500, [0, 500], { ts: T0 + 8000, finalized: true }) },
  ];
}

function apply(f: Fixture, ...records: Rec[]): ReturnType<UsageRepo['applyRecord']>[] {
  return withWriteTx(f.db, CTX, (tx) => records.map((r) => f.repo.applyRecord(CTX, tx, f[r.file], r.key, r.v)));
}

interface UsageDbRow {
  message_key: string;
  session_id: number;
  agent_id: number;
  owner_file_id: number;
  model: string;
  ts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_creation_5m_tokens: number | null;
  cache_creation_1h_tokens: number | null;
  thinking_tokens: number | null;
  web_search_requests: number | null;
  web_fetch_requests: number | null;
  finalized: number;
  usage_source: string;
  synthetic: number;
  files: number;
}

const USAGE_SELECT = `SELECT message_key, session_id, agent_id, owner_file_id, model, ts, input_tokens, output_tokens, cache_read_tokens,
  cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, thinking_tokens, web_search_requests,
  web_fetch_requests, finalized, usage_source, synthetic, files FROM usage`;

function usageRows(db: InstanceDb): UsageDbRow[] {
  return db.driver.prepare<UsageDbRow>(`${USAGE_SELECT} ORDER BY message_key`).all();
}

function usageRow(db: InstanceDb, key: string): UsageDbRow | undefined {
  return db.driver.prepare<UsageDbRow>(`${USAGE_SELECT} WHERE message_key = ?`).get([key]);
}

const ROLLUP_COLUMNS = `usage_messages, usage_synthetic, usage_unfinalized, tok_input, tok_output, tok_cache_read, tok_cache_creation,
  tok_input_missing, tok_output_missing, tok_cache_read_missing, tok_cache_creation_missing`;

function rollups(db: InstanceDb, table: 'sessions' | 'agents'): unknown[] {
  return db.driver.prepare(`SELECT id, ${ROLLUP_COLUMNS} FROM ${table} ORDER BY id`).all();
}

/** [messages, synthetic, unfinalized, in, out, cr, cc, in missing, out missing, cr missing, cc missing] */
function rollup(id: number, c: readonly number[]): Record<string, number> {
  return {
    id,
    usage_messages: c[0] ?? -1,
    usage_synthetic: c[1] ?? -1,
    usage_unfinalized: c[2] ?? -1,
    tok_input: c[3] ?? -1,
    tok_output: c[4] ?? -1,
    tok_cache_read: c[5] ?? -1,
    tok_cache_creation: c[6] ?? -1,
    tok_input_missing: c[7] ?? -1,
    tok_output_missing: c[8] ?? -1,
    tok_cache_read_missing: c[9] ?? -1,
    tok_cache_creation_missing: c[10] ?? -1,
  };
}

function changes(
  db: InstanceDb,
): { seq: number; kind: string; op: string; session_uid: string | null; entity_id: number | null }[] {
  return db.driver
    .prepare<{ seq: number; kind: string; op: string; session_uid: string | null; entity_id: number | null }>(
      'SELECT seq, kind, op, session_uid, entity_id FROM changes ORDER BY seq',
    )
    .all();
}

function dbErrorOf(run: () => unknown): DbError {
  try {
    run();
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error('expected a DbError');
}

/** The expected end state of the worked example (02 6.4), independent of the order of the records. */
function expectedExample(f: Fixture): { usage: unknown[]; sessions: unknown[]; agents: unknown[] } {
  const row = (
    key: string,
    owner: [number, number, number],
    model: string,
    ts: number,
    v: (number | null)[],
    flags: [number, string, number, number],
  ): unknown => ({
    message_key: key,
    session_id: owner[0],
    agent_id: owner[1],
    owner_file_id: owner[2],
    model,
    ts,
    input_tokens: v[0],
    output_tokens: v[1],
    cache_read_tokens: v[2],
    cache_creation_tokens: v[3],
    cache_creation_5m_tokens: v[4],
    cache_creation_1h_tokens: v[5],
    thinking_tokens: null,
    web_search_requests: null,
    web_fetch_requests: null,
    finalized: flags[0],
    usage_source: flags[1],
    synthetic: flags[2],
    files: flags[3],
  });
  const own1: [number, number, number] = [f.s1, f.main1, f.f1];
  const sub1: [number, number, number] = [f.s1, f.sub1, f.f2];
  return {
    usage: [
      row(SYNTHETIC_KEY, own1, '<synthetic>', T0 + 4000, [0, 0, 0, 0, null, null], [1, 'top', 1, 1]),
      row('msg_A', own1, 'model-x', T0 + 1000, [10, 200, 5000, 1000, 0, 1000], [1, 'top', 0, 2]),
      row('msg_B', own1, 'model-x', T0 + 2000, [4, 50, 6000, 0, 0, 0], [1, 'top', 0, 1]),
      row('msg_C', sub1, 'model-y', T0 + 6000, [3, 412, 1000, 200, 200, 0], [1, 'top', 0, 1]),
      row('msg_D', sub1, 'model-y', T0 + 7000, [5, 8, 800, 0, 0, 0], [0, 'top', 0, 1]),
      row('msg_E', [f.s2, f.main2, f.f3], 'model-x', T0 + 8000, [6, 70, 7000, 500, 0, 500], [1, 'top', 0, 1]),
      row('msg_N', own1, 'model-x', T0 + 5000, [null, null, null, null, null, null], [1, 'top', 0, 1]),
      row('msg_Z', own1, 'model-x', T0 + 3000, [2, 300, 959572, 4000, 0, 4000], [1, 'iterations', 0, 1]),
    ],
    sessions: [
      rollup(f.s1, [7, 1, 1, 24, 970, 972372, 5200, 1, 1, 1, 1]),
      rollup(f.s2, [1, 0, 0, 6, 70, 7000, 500, 0, 0, 0, 0]),
    ],
    agents: [
      rollup(f.main1, [5, 1, 0, 16, 550, 970572, 5000, 1, 1, 1, 1]),
      rollup(f.main2, [1, 0, 0, 6, 70, 7000, 500, 0, 0, 0, 0]),
      rollup(f.sub1, [2, 0, 1, 8, 420, 1800, 200, 0, 0, 0, 0]),
    ],
  };
}

describe('UsageRepo.applyRecord: the worked example of 02 6.4 (DA-T-DB-10)', () => {
  it('stores the per-file maxima, the instance values, the owners and every rollup of the table', () => {
    const f = fixture();
    for (const record of workedExample()) apply(f, record);
    const expected = expectedExample(f);
    expect(usageRows(f.db)).toEqual(expected.usage);
    expect(rollups(f.db, 'sessions')).toEqual(expected.sessions);
    expect(rollups(f.db, 'agents')).toEqual(expected.agents);
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
    // the 5m/1h split of the creation per scope: S1 200 / 5,000, S2 0 / 500 (instance 200 / 5,500)
    expect(
      f.db.driver
        .prepare(
          'SELECT session_id, sum(cache_creation_5m_tokens) AS m5, sum(cache_creation_1h_tokens) AS h1 FROM usage GROUP BY session_id ORDER BY 1',
        )
        .all(),
    ).toEqual([
      { session_id: f.s1, m5: 200, h1: 5000 },
      { session_id: f.s2, m5: 0, h1: 500 },
    ]);
    // the legacy values of 02 6.5 per file: F1 14 / 250 / 11,000 / 1,000, F2 8 / 420 / 1,800 / 200, F3 16 / 270 / 12,000 / 1,500
    expect(
      f.db.driver
        .prepare(
          'SELECT file_id, sum(legacy_in) AS i, sum(legacy_out) AS o, sum(legacy_cr) AS cr, sum(legacy_cc) AS cc, count(*) AS turns FROM usage_files GROUP BY file_id ORDER BY 1',
        )
        .all(),
    ).toEqual([
      { file_id: f.f1, i: 14, o: 250, cr: 11000, cc: 1000, turns: 5 },
      { file_id: f.f2, i: 8, o: 420, cr: 1800, cc: 200, turns: 2 },
      { file_id: f.f3, i: 16, o: 270, cr: 12000, cc: 1500, turns: 2 },
    ]);
  });

  it('the models of the owner sessions: the synthetic model is never listed, a model is listed once', () => {
    const f = fixture();
    for (const record of workedExample()) apply(f, record);
    const models = (id: number): string[] =>
      f.db.driver
        .prepare<{ value: string }>('SELECT value FROM sessions s, json_each(s.models) WHERE s.id = ? ORDER BY value')
        .all([id])
        .map((row) => row.value);
    expect(models(f.s1)).toEqual(['model-x', 'model-y']);
    expect(models(f.s2)).toEqual(['model-x']);
  });

  it('is announced as usage/invalidate of the owner session, once per session and transaction', () => {
    const f = fixture();
    apply(f, ...workedExample());
    expect(changes(f.db)).toEqual([
      { seq: 1, kind: 'usage', op: 'invalidate', session_uid: S1_UID, entity_id: f.s1 },
      { seq: 2, kind: 'usage', op: 'invalidate', session_uid: S2_UID, entity_id: f.s2 },
    ]);
  });
});

describe('UsageRepo.applyRecord: per-file maximum, NULL as missing, validity (02 6.2)', () => {
  it('keeps the maximum of every field over the records of one file (X3: split reads of a growing message)', () => {
    const f = fixture();
    const rec = (out: number, finalized: boolean): Rec => ({
      file: 'f2',
      key: 'msg_C',
      v: four(3, out, 1000, 200, [200, 0], { model: 'model-y', finalized, ts: T0 + out }),
    });
    apply(f, rec(8, false));
    apply(f, rec(8, false));
    expect(usageRow(f.db, 'msg_C')).toMatchObject({ output_tokens: 8, finalized: 0 });
    apply(f, rec(412, true));
    expect(usageRow(f.db, 'msg_C')).toMatchObject({ output_tokens: 412, finalized: 1 });
    // a late smaller snapshot does not lower anything
    apply(f, rec(100, false));
    expect(usageRow(f.db, 'msg_C')).toMatchObject({ output_tokens: 412, finalized: 1 });
    expect(f.repo.getFile(CTX, f.f2, 'msg_C')).toMatchObject({
      outputTokens: 412,
      recordCount: 4,
      firstTs: T0 + 8,
      lastTs: T0 + 412,
      finalized: true,
    });
  });

  it('missing stays missing until a record provides a value; zero is a value (X4)', () => {
    const f = fixture();
    apply(f, { file: 'f1', key: 'msg_M', v: values({ inputTokens: 5, outputTokens: null }) });
    expect(usageRow(f.db, 'msg_M')).toMatchObject({ input_tokens: 5, output_tokens: null });
    expect(f.repo.getFile(CTX, f.f1, 'msg_M')).toMatchObject({ inputTokens: 5, outputTokens: null });
    expect(rollups(f.db, 'sessions')[0]).toMatchObject({
      tok_input: 5,
      tok_output: 0,
      tok_input_missing: 0,
      tok_output_missing: 1,
    });
    apply(f, { file: 'f1', key: 'msg_M', v: values({ inputTokens: null, outputTokens: 0 }) });
    expect(usageRow(f.db, 'msg_M')).toMatchObject({ input_tokens: 5, output_tokens: 0 });
    expect(rollups(f.db, 'sessions')[0]).toMatchObject({
      tok_input: 5,
      tok_output: 0,
      tok_input_missing: 0,
      tok_output_missing: 0,
    });
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
  });

  it('the instance value is missing only when every file misses it; one file with a value supplies it (NULL ignored by max)', () => {
    const f = fixture();
    apply(f, { file: 'f1', key: 'msg_M', v: values({ inputTokens: null, outputTokens: 7, ts: T0 }) });
    apply(f, { file: 'f3', key: 'msg_M', v: values({ inputTokens: 9, outputTokens: null, ts: T0 }) });
    expect(usageRow(f.db, 'msg_M')).toMatchObject({ input_tokens: 9, output_tokens: 7, files: 2, owner_file_id: f.f1 });
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
  });

  it('counts the invalid values of the records (X1) and keeps the field missing', () => {
    const f = fixture();
    for (let i = 0; i < 4; i += 1)
      apply(f, { file: 'f1', key: 'msg_X1', v: values({ inputTokens: 1, outputTokens: null, invalidValues: 1 }) });
    expect(f.repo.getFile(CTX, f.f1, 'msg_X1')).toMatchObject({ outputTokens: null, invalidValues: 4, recordCount: 4 });
    expect(usageRow(f.db, 'msg_X1')?.output_tokens).toBeNull();
  });

  it('differing copies: the larger value wins and the older file stays the owner (X2)', () => {
    const f = fixture();
    apply(f, { file: 'f3', key: 'msg_F', v: four(1, 120, 0, 0, null, { ts: T0 }) });
    apply(f, { file: 'f1', key: 'msg_F', v: four(1, 100, 0, 0, null, { ts: T0 }) });
    expect(usageRow(f.db, 'msg_F')).toMatchObject({
      output_tokens: 120,
      owner_file_id: f.f1,
      session_id: f.s1,
      agent_id: f.main1,
      files: 2,
    });
    expect(rollups(f.db, 'sessions')).toEqual([
      expect.objectContaining({ id: f.s1, usage_messages: 1, tok_output: 120 }),
      expect.objectContaining({ id: f.s2, usage_messages: 0, tok_output: 0 }),
    ]);
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
  });

  it('a synthetic message is counted as synthetic and never as unfinalized, finalized or not', () => {
    const f = fixture();
    apply(f, {
      file: 'f1',
      key: SYNTHETIC_KEY,
      v: four(0, 0, 0, 0, null, { model: '<synthetic>', ts: T0, finalized: false, synthetic: true }),
    });
    apply(f, { file: 'f1', key: 'msg_open', v: four(1, 1, 1, 1, null, { ts: T0, finalized: false }) });
    expect(rollups(f.db, 'sessions')[0]).toMatchObject({ usage_messages: 2, usage_synthetic: 1, usage_unfinalized: 1 });
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
  });

  it('usage_source becomes iterations as soon as one record of the file or one file used the iterations', () => {
    const f = fixture();
    apply(f, { file: 'f1', key: 'msg_I', v: four(1, 2, 3, 4, null, { ts: T0 }) });
    expect(usageRow(f.db, 'msg_I')?.usage_source).toBe('top');
    apply(f, { file: 'f1', key: 'msg_I', v: four(1, 2, 3, 4, null, { ts: T0, usageSource: 'iterations' }) });
    apply(f, { file: 'f1', key: 'msg_I', v: four(1, 2, 3, 4, null, { ts: T0 }) });
    expect(usageRow(f.db, 'msg_I')?.usage_source).toBe('iterations');
    apply(f, { file: 'f3', key: 'msg_J', v: four(1, 2, 3, 4, null, { ts: T0 }) });
    apply(f, { file: 'f1', key: 'msg_J', v: four(1, 2, 3, 4, null, { ts: T0, usageSource: 'iterations' }) });
    expect(usageRow(f.db, 'msg_J')?.usage_source).toBe('iterations');
  });

  it('the time of the instance value is the earliest first record of its files; a record without time falls back to the file', () => {
    const f = fixture();
    apply(f, { file: 'f3', key: 'msg_T', v: four(1, 1, 1, 1, null, { ts: T0 + 500 }) });
    apply(f, { file: 'f1', key: 'msg_T', v: four(1, 1, 1, 1, null, { ts: T0 + 300 }) });
    apply(f, { file: 'f1', key: 'msg_T', v: four(1, 1, 1, 1, null, { ts: T0 + 900 }) });
    expect(usageRow(f.db, 'msg_T')?.ts).toBe(T0 + 300);
    apply(f, { file: 'f1', key: 'msg_U', v: four(1, 1, 1, 1, null, { ts: null }) });
    expect(usageRow(f.db, 'msg_U')?.ts).toBe(T0); // the discovery time of the owner file
    apply(f, { file: 'f1', key: 'msg_U', v: four(1, 1, 1, 1, null, { ts: T0 + 77 }) });
    expect(usageRow(f.db, 'msg_U')?.ts).toBe(T0 + 77);
  });

  it('the model is the owner file model, else any non-null one; a message without any model is stored as unknown', () => {
    const f = fixture();
    apply(f, { file: 'f1', key: 'msg_K', v: four(1, 1, 1, 1, null, { ts: T0, model: null }) });
    expect(usageRow(f.db, 'msg_K')?.model).toBe('unknown');
    apply(f, { file: 'f3', key: 'msg_K', v: four(1, 1, 1, 1, null, { ts: T0, model: 'model-z' }) });
    expect(usageRow(f.db, 'msg_K')?.model).toBe('model-z'); // owner F1 has none: any non-null model
    apply(f, { file: 'f1', key: 'msg_K', v: four(1, 1, 1, 1, null, { ts: T0, model: 'model-x' }) });
    expect(usageRow(f.db, 'msg_K')?.model).toBe('model-x'); // now the owner file has one
  });

  it('lists at most 16 models of a session, within the 1 KiB column', () => {
    const f = fixture();
    for (let i = 1; i <= 20; i += 1) {
      apply(f, {
        file: 'f1',
        key: `msg_${String(i)}`,
        v: four(1, 1, 1, 1, null, { ts: T0, model: `model-${String(i).padStart(2, '0')}` }),
      });
    }
    const models = f.db.driver
      .prepare<{ models: string; last_model: string }>('SELECT models, last_model FROM sessions WHERE id = ?')
      .get([f.s1]);
    expect(JSON.parse(models?.models ?? '[]')).toHaveLength(16);
    expect(models?.last_model).toBe('model-20');
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
  });
});

describe('UsageRepo.applyRecord: owner by the oldest file and re-owning (DA-T-DB-11)', () => {
  const key = 'msg_A';
  const rec = (file: Rec['file']): Rec => ({
    file,
    key,
    v: four(10, 200, 5000, 1000, [0, 1000], { ts: T0 + 1000, finalized: true }),
  });

  it('a copy that is read first owns the message until the older file is read, then the contribution moves', () => {
    const f = fixture();
    const first = apply(f, rec('f3'))[0];
    expect(first?.owner).toEqual({ fileId: f.f3, sessionId: f.s2, agentId: f.main2 });
    expect(rollups(f.db, 'sessions')[1]).toMatchObject({ usage_messages: 1, tok_input: 10 });
    const second = apply(f, rec('f1'))[0];
    expect(second).toEqual({
      changed: true,
      owner: { fileId: f.f1, sessionId: f.s1, agentId: f.main1 },
      touchedSessionIds: [f.s1, f.s2],
      touchedAgentIds: [f.main1, f.main2],
    });
    expect(rollups(f.db, 'sessions')).toEqual([
      rollup(f.s1, [1, 0, 0, 10, 200, 5000, 1000, 0, 0, 0, 0]),
      rollup(f.s2, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ]);
    expect(rollups(f.db, 'agents')).toEqual([
      rollup(f.main1, [1, 0, 0, 10, 200, 5000, 1000, 0, 0, 0, 0]),
      rollup(f.main2, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      rollup(f.sub1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ]);
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
    // both sessions are told: the old owner lost the message, the new one gained it
    const rows = changes(f.db);
    expect(rows.map((c) => [c.kind, c.op])).toEqual(Array<string[]>(3).fill(['usage', 'invalidate']));
    expect(rows[0]?.entity_id).toBe(f.s2);
    expect(
      rows
        .slice(1)
        .map((c) => c.entity_id)
        .sort(),
    ).toEqual([f.s1, f.s2]);
  });

  it('a copy file that is older than the original by birth time owns the message, whatever the read order', () => {
    const f = fixture();
    f.db.driver.prepare('UPDATE transcript_files SET birth_ms = ? WHERE id = ?').run([T0 - 10 * MIN, f.f3]);
    apply(f, rec('f1'));
    apply(f, rec('f3'));
    expect(usageRow(f.db, key)).toMatchObject({ owner_file_id: f.f3, session_id: f.s2, agent_id: f.main2 });
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
  });

  it('a file without a birth time is ordered by the mtime of its first sight, then by path', () => {
    const f = fixture();
    f.db.driver
      .prepare('UPDATE transcript_files SET birth_ms = 0, first_seen_mtime_ms = ? WHERE id = ?')
      .run([T0 - 5 * MIN, f.f3]);
    apply(f, rec('f1'), rec('f3'));
    expect(usageRow(f.db, key)?.owner_file_id).toBe(f.f3);
    // equal ages: the smaller path owns
    f.db.driver.prepare('UPDATE transcript_files SET birth_ms = 7 WHERE id IN (?, ?)').run([f.f1, f.f3]);
    withWriteTx(f.db, CTX, (tx) => f.repo.recomputeKey(CTX, tx, key));
    expect(usageRow(f.db, key)?.owner_file_id).toBe(f.f1); // 'f1.jsonl' < 'f3.jsonl'
    // a file whose age is unknown does not take the message from a file that has one
    f.db.driver
      .prepare('UPDATE transcript_files SET birth_ms = NULL, first_seen_mtime_ms = NULL WHERE id = ?')
      .run([f.f1]);
    withWriteTx(f.db, CTX, (tx) => f.repo.recomputeKey(CTX, tx, key));
    expect(usageRow(f.db, key)?.owner_file_id).toBe(f.f3);
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
  });

  it('the agent of a subagent file owns its messages and the session of the file gets the rollup', () => {
    const f = fixture();
    apply(f, { file: 'f2', key: 'msg_C', v: four(3, 8, 1000, 200, null, { model: 'model-y', ts: T0 }) });
    expect(usageRow(f.db, 'msg_C')).toMatchObject({ session_id: f.s1, agent_id: f.sub1 });
    expect(rollups(f.db, 'agents')[2]).toMatchObject({ id: f.sub1, usage_messages: 1, tok_output: 8 });
    expect(rollups(f.db, 'agents')[0]).toMatchObject({ id: f.main1, usage_messages: 0 });
  });

  it('removeFile of the owner file re-owns a shared message to the remaining file and drops the others (identity reset, retention)', () => {
    const f = fixture();
    apply(f, ...workedExample());
    const removed = withWriteTx(f.db, CTX, (tx) => f.repo.removeFile(CTX, tx, f.f1));
    expect(removed.keys.sort()).toEqual(['msg_A', 'msg_B', 'msg_N', 'msg_Z', SYNTHETIC_KEY].sort());
    expect(usageRows(f.db).map((row) => [row.message_key, row.session_id, row.agent_id, row.owner_file_id])).toEqual([
      ['msg_A', f.s2, f.main2, f.f3], // the copy now owns the message
      ['msg_C', f.s1, f.sub1, f.f2],
      ['msg_D', f.s1, f.sub1, f.f2],
      ['msg_E', f.s2, f.main2, f.f3],
    ]);
    expect(rollups(f.db, 'sessions')).toEqual([
      rollup(f.s1, [2, 0, 1, 8, 420, 1800, 200, 0, 0, 0, 0]),
      rollup(f.s2, [2, 0, 0, 16, 270, 12000, 1500, 0, 0, 0, 0]),
    ]);
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
    expect(f.db.driver.prepare('SELECT count(*) AS n FROM usage_files WHERE file_id = ?').get([f.f1])).toEqual({
      n: 0,
    });
    // reading the file again restores the table of the worked example
    for (const record of workedExample().filter((r) => r.file === 'f1')) apply(f, record);
    const expected = expectedExample(f);
    expect(usageRows(f.db)).toEqual(expected.usage);
    expect(rollups(f.db, 'sessions')).toEqual(expected.sessions);
  });

  it('removeFile works in bounded steps (maxKeys) and ends in the same state, the rollups right after every step', () => {
    const f = fixture();
    apply(f, ...workedExample());
    const keys: string[] = [];
    const steps: number[] = [];
    for (let step = 0; step < 10; step += 1) {
      const result = withWriteTx(f.db, CTX, (tx) => f.repo.removeFile(CTX, tx, f.f1, { maxKeys: 2 }));
      keys.push(...result.keys);
      steps.push(result.keys.length);
      expect(f.repo.verifyRollups(CTX), `after step ${String(step + 1)}`).toEqual([]);
      if (!result.more) break;
    }
    expect(steps).toEqual([2, 2, 1]);
    expect(keys.sort()).toEqual(['msg_A', 'msg_B', 'msg_N', 'msg_Z', SYNTHETIC_KEY].sort());
    expect(usageRows(f.db).map((row) => row.message_key)).toEqual(['msg_A', 'msg_C', 'msg_D', 'msg_E']);
    // a file without rows is a no-op
    expect(withWriteTx(f.db, CTX, (tx) => f.repo.removeFile(CTX, tx, f.f1))).toEqual({ keys: [], more: false });
  });

  it('deleting the owner session (cascade) and then its file re-owns the message to the remaining file (applyRetention)', () => {
    const f = fixture();
    apply(f, ...workedExample());
    f.db.driver.prepare('DELETE FROM sessions WHERE id = ?').run([f.s1]);
    expect(usageRow(f.db, 'msg_A')).toBeUndefined(); // the cascade took the row with its owner
    withWriteTx(f.db, CTX, (tx) => {
      for (const file of [f.f1, f.f2]) f.repo.removeFile(CTX, tx, file);
    });
    expect(usageRows(f.db).map((row) => [row.message_key, row.session_id, row.owner_file_id])).toEqual([
      ['msg_A', f.s2, f.f3],
      ['msg_E', f.s2, f.f3],
    ]);
    expect(rollups(f.db, 'sessions')).toEqual([rollup(f.s2, [2, 0, 0, 16, 270, 12000, 1500, 0, 0, 0, 0])]);
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
  });

  it('a file whose session is gone (retired tombstone) cannot own a message', () => {
    const f = fixture();
    apply(f, rec('f1'), rec('f3'));
    f.db.driver.prepare('UPDATE transcript_files SET session_id = NULL, agent_id = NULL WHERE id = ?').run([f.f1]);
    withWriteTx(f.db, CTX, (tx) => f.repo.recomputeKey(CTX, tx, key));
    expect(usageRow(f.db, key)).toMatchObject({ owner_file_id: f.f3, session_id: f.s2, files: 2 });
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
    // and when no file is eligible the instance row is gone and the rollups are released
    f.db.driver.prepare('UPDATE transcript_files SET session_id = NULL, agent_id = NULL WHERE id = ?').run([f.f3]);
    const result = withWriteTx(f.db, CTX, (tx) => f.repo.recomputeKey(CTX, tx, key));
    expect(result).toMatchObject({ changed: true, owner: null });
    expect(usageRow(f.db, key)).toBeUndefined();
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
    expect(rollups(f.db, 'sessions')).toEqual([
      rollup(f.s1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      rollup(f.s2, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ]);
  });
});

describe('UsageRepo: idempotency, announcements and references', () => {
  it('re-applying a record leaves the instance value, the rollups, the change log and updated_at as they were', () => {
    const f = fixture();
    const record: Rec = {
      file: 'f1',
      key: 'msg_A',
      v: four(10, 200, 5000, 1000, [0, 1000], { ts: T0 + 1000, finalized: true }),
    };
    apply(f, record);
    f.clock.advance(9000);
    const state = (): unknown => ({
      usage: f.db.driver.prepare('SELECT * FROM usage ORDER BY id').all(),
      sessions: rollups(f.db, 'sessions'),
      agents: rollups(f.db, 'agents'),
      head: f.db.headSeq(),
    });
    const before = state();
    const [again] = apply(f, record);
    expect(again).toMatchObject({ changed: false, touchedSessionIds: [], touchedAgentIds: [] });
    expect(state()).toEqual(before);
    // the per-file counter is the one thing that moves (02 4.1: record_count += 1)
    expect(f.repo.getFile(CTX, f.f1, 'msg_A')?.recordCount).toBe(2);
  });

  it('the usage row is not rewritten when a second file confirms the same values; only the file count and the owner rule apply', () => {
    const f = fixture();
    apply(f, { file: 'f1', key: 'msg_A', v: four(10, 200, 5000, 1000, null, { ts: T0 + 1000 }) });
    const [copy] = apply(f, { file: 'f3', key: 'msg_A', v: four(10, 200, 5000, 1000, null, { ts: T0 + 1000 }) });
    expect(copy).toMatchObject({ changed: false, touchedSessionIds: [] });
    expect(usageRow(f.db, 'msg_A')).toMatchObject({ files: 2, session_id: f.s1 });
    expect(changes(f.db)).toHaveLength(1);
  });

  it('refuses a transcript file that does not exist or has no session, and writes nothing', () => {
    const f = fixture();
    const record = four(1, 1, 1, 1, null, { ts: T0 });
    expect(
      dbErrorOf(() => withWriteTx(f.db, CTX, (tx) => f.repo.applyRecord(CTX, tx, 999, 'msg_Q', record))),
    ).toMatchObject({
      code: 'db_constraint',
      constraint: 'foreignkey',
    });
    f.db.driver.prepare('UPDATE transcript_files SET session_id = NULL WHERE id = ?').run([f.f1]);
    expect(
      dbErrorOf(() => withWriteTx(f.db, CTX, (tx) => f.repo.applyRecord(CTX, tx, f.f1, 'msg_Q', record))),
    ).toMatchObject({
      code: 'db_constraint',
      constraint: 'foreignkey',
    });
    expect(usageRows(f.db)).toEqual([]);
    expect(f.db.driver.prepare('SELECT count(*) AS n FROM usage_files').get()).toEqual({ n: 0 });
  });

  it('refuses a main file whose session has no main agent row', () => {
    const f = fixture();
    f.db.driver.prepare('UPDATE transcript_files SET agent_id = NULL WHERE id = ?').run([f.f1]);
    f.db.driver.prepare("DELETE FROM agents WHERE id = ? AND agent_uid = 'main'").run([f.main1]);
    expect(
      dbErrorOf(() => apply(f, { file: 'f1', key: 'msg_Q', v: four(1, 1, 1, 1, null, { ts: T0 }) })),
    ).toMatchObject({
      code: 'db_constraint',
    });
    expect(usageRows(f.db)).toEqual([]);
  });

  it.each([
    ['a negative token count', { inputTokens: -1 }],
    ['a message key above 160 characters', { key: 'k'.repeat(161) }],
    ['a model above 128 characters', { model: 'm'.repeat(129) }],
    ['a fractional value', { outputTokens: 1.5 }],
  ] as const)('refuses %s (CHECK or datatype) and rolls the transaction back', (_label, over) => {
    const f = fixture();
    const key = 'key' in over ? over.key : 'msg_Q';
    const v = four(1, 1, 1, 1, null, { ts: T0, ...('key' in over ? {} : over) });
    expect(dbErrorOf(() => apply(f, { file: 'f1', key, v }))).toMatchObject({ code: 'db_constraint' });
    expect(usageRows(f.db)).toEqual([]);
    expect(f.db.driver.prepare('SELECT count(*) AS n FROM usage_files').get()).toEqual({ n: 0 });
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
    expect(changes(f.db)).toEqual([]);
  });

  it('get and getFile return typed rows, or undefined', () => {
    const f = fixture();
    apply(f, { file: 'f1', key: 'msg_B', v: four(4, 50, 6000, 0, [0, 0], { ts: T0 + 2000, finalized: true }) });
    expect(f.repo.get(CTX, 'msg_B')).toMatchObject({
      messageKey: 'msg_B',
      sessionId: f.s1,
      agentId: f.main1,
      ownerFileId: f.f1,
      model: 'model-x',
      ts: T0 + 2000,
      inputTokens: 4,
      outputTokens: 50,
      cacheReadTokens: 6000,
      cacheCreationTokens: 0,
      thinkingTokens: null,
      finalized: true,
      synthetic: false,
      usageSource: 'top',
      files: 1,
    });
    expect(f.repo.get(CTX, 'nope')).toBeUndefined();
    expect(f.repo.getFile(CTX, f.f1, 'msg_B')).toMatchObject({
      fileId: f.f1,
      legacyIn: 4,
      legacyOut: 50,
      legacyCr: 6000,
      legacyCc: 0,
    });
    expect(f.repo.getFile(CTX, f.f2, 'msg_B')).toBeUndefined();
  });

  it('every public method asserts the scope first', () => {
    const f = fixture();
    const record = four(1, 1, 1, 1, null, { ts: T0 });
    apply(f, { file: 'f1', key: 'msg_B', v: record });
    const calls: (() => unknown)[] = [
      () => withWriteTx(f.db, CTX, (tx) => f.repo.applyRecord(FOREIGN, tx, f.f1, 'msg_Q', record)),
      () => withWriteTx(f.db, CTX, (tx) => f.repo.recomputeKey(FOREIGN, tx, 'msg_B')),
      () => withWriteTx(f.db, CTX, (tx) => f.repo.removeFile(FOREIGN, tx, f.f1)),
      () => f.repo.verifyRollups(FOREIGN),
      () => f.repo.get(FOREIGN, 'msg_B'),
      () => f.repo.getFile(FOREIGN, f.f1, 'msg_B'),
    ];
    for (const run of calls) expect(dbErrorOf(run).code).toBe('scope_mismatch');
    expect(usageRows(f.db)).toHaveLength(1);
  });
});

describe('UsageRepo.verifyRollups', () => {
  it('reports every session and agent whose rollup differs from the sums of the usage rows, in both directions', () => {
    const f = fixture();
    apply(f, ...workedExample());
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
    f.db.driver
      .prepare('UPDATE sessions SET tok_input = tok_input + 1, tok_output_missing = 0 WHERE id = ?')
      .run([f.s1]);
    f.db.driver.prepare('UPDATE agents SET usage_messages = usage_messages + 3 WHERE id = ?').run([f.sub1]);
    f.db.driver.prepare('UPDATE sessions SET usage_synthetic = 1 WHERE id = ?').run([f.s2]); // a rollup without rows behind it
    const mismatches = f.repo.verifyRollups(CTX);
    expect(mismatches.map((m) => [m.scope, m.id])).toEqual([
      ['session', f.s1],
      ['session', f.s2],
      ['agent', f.sub1],
    ]);
    expect(mismatches[0]).toMatchObject({
      stored: { input: 25, outputMissing: 0 },
      expected: {
        input: 24,
        outputMissing: 1,
        messages: 7,
        synthetic: 1,
        unfinalized: 1,
        output: 970,
        cacheRead: 972372,
        cacheCreation: 5200,
      },
    });
    expect(mismatches[1]).toMatchObject({ stored: { synthetic: 1 }, expected: { synthetic: 0, messages: 1 } });
    expect(mismatches[2]).toMatchObject({ stored: { messages: 5 }, expected: { messages: 2 } });
  });

  it('reports a session without any usage row and a zero rollup as consistent', () => {
    const f = fixture();
    expect(f.repo.verifyRollups(CTX)).toEqual([]);
  });
});

/** mulberry32: a tiny seeded generator, so that a failing order reproduces from the printed seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

function wipe(f: Fixture): void {
  f.db.driver.exec(`
    DELETE FROM usage; DELETE FROM usage_files; DELETE FROM changes;
    UPDATE sessions SET usage_messages = 0, usage_synthetic = 0, usage_unfinalized = 0, tok_input = 0, tok_output = 0,
      tok_cache_read = 0, tok_cache_creation = 0, tok_input_missing = 0, tok_output_missing = 0, tok_cache_read_missing = 0,
      tok_cache_creation_missing = 0, models = '[]', last_model = NULL;
    UPDATE agents SET usage_messages = 0, usage_synthetic = 0, usage_unfinalized = 0, tok_input = 0, tok_output = 0,
      tok_cache_read = 0, tok_cache_creation = 0, tok_input_missing = 0, tok_output_missing = 0, tok_cache_read_missing = 0,
      tok_cache_creation_missing = 0;
  `);
}

function snapshot(db: InstanceDb): unknown {
  return {
    usage: usageRows(db),
    files: db.driver
      .prepare(
        `SELECT file_id, message_key, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                cache_creation_5m_tokens, cache_creation_1h_tokens, legacy_in, legacy_out, legacy_cr, legacy_cc, finalized,
                usage_source, synthetic, first_ts, last_ts, record_count, invalid_values
           FROM usage_files ORDER BY file_id, message_key`,
      )
      .all(),
    sessions: rollups(db, 'sessions'),
    agents: rollups(db, 'agents'),
    models: db.driver
      .prepare(
        `SELECT s.id, (SELECT json_group_array(value) FROM (SELECT value FROM json_each(s.models) ORDER BY value)) AS models
           FROM sessions s ORDER BY s.id`,
      )
      .all(),
  };
}

describe('UsageRepo.applyRecord: 200 seeded orders (DA-T-DB-10, DA-T-DB-11, adversarial)', () => {
  const BASE_SEED = 20261014;
  const ORDERS = 200;

  it(`the worked example in ${String(ORDERS)} shuffled orders of files, records and transactions: same rows, owners and rollups, verifyRollups empty after every transaction (base seed ${String(BASE_SEED)})`, () => {
    const f = fixture();
    const records = workedExample();
    let expected: unknown;
    for (let order = 0; order < ORDERS; order += 1) {
      const seed = BASE_SEED + order;
      const rand = prng(seed);
      wipe(f);
      const sequence = shuffled(records, rand);
      for (let at = 0; at < sequence.length;) {
        const batch = sequence.slice(at, at + 1 + Math.floor(rand() * 5));
        apply(f, ...batch);
        expect(f.repo.verifyRollups(CTX), `seed ${String(seed)} after ${String(at + batch.length)} records`).toEqual(
          [],
        );
        at += batch.length;
      }
      const result = snapshot(f.db);
      expected ??= result;
      expect(result, `seed ${String(seed)}`).toEqual(expected);
    }
    const final = expectedExample(f);
    expect(expected).toMatchObject({ usage: final.usage, sessions: final.sessions, agents: final.agents });
    expect(expected).toMatchObject({
      models: [
        { id: f.s1, models: '["model-x","model-y"]' },
        { id: f.s2, models: '["model-x"]' },
      ],
    });
  }, 60_000);

  it(`the same with a reset of file F2 in the middle (T-TK-03: re-read after a forced identity reset) (base seed ${String(BASE_SEED + 1000)})`, () => {
    const f = fixture();
    const records = workedExample();
    // the reference: the records in file order, no reset
    apply(f, ...records);
    const reference = snapshot(f.db);
    for (let order = 0; order < 50; order += 1) {
      const seed = BASE_SEED + 1000 + order;
      const rand = prng(seed);
      wipe(f);
      const shuffledRecords = shuffled(records, rand);
      const cut = 3 + Math.floor(rand() * 9);
      apply(f, ...shuffledRecords.slice(0, cut));
      withWriteTx(f.db, CTX, (tx) => f.repo.removeFile(CTX, tx, f.f2));
      expect(f.repo.verifyRollups(CTX), `seed ${String(seed)} after the reset`).toEqual([]);
      // file F2 is read again from its start; the rest of the other files arrives in a new order
      const afterReset = shuffled(
        [...shuffledRecords.slice(cut).filter((r) => r.file !== 'f2'), ...records.filter((r) => r.file === 'f2')],
        rand,
      );
      for (let at = 0; at < afterReset.length;) {
        const batch = afterReset.slice(at, at + 1 + Math.floor(rand() * 5));
        apply(f, ...batch);
        expect(f.repo.verifyRollups(CTX), `seed ${String(seed)}`).toEqual([]);
        at += batch.length;
      }
      expect(snapshot(f.db), `seed ${String(seed)}`).toEqual(reference);
    }
  }, 60_000);
});
