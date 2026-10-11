// T-TK-01 and T-TK-02: the worked example of 02 6.4 and its edge cases X1-X5, through the whole path: raw transcript record ->
// `accumulateRecord` (effective values) -> `UsageRepo` (per-file maximum, instance value, owner, rollups) -> `aggregate*`.
import { join } from 'node:path';

import { TranscriptRecordShape, isoMsZ } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb, type RepoContext } from '../db/open.ts';
import { UsageRepo } from '../db/repos/usage.ts';
import { withWriteTx } from '../db/write.ts';
import type { TranscriptRecord } from '../ingest/transcripts/normalize-record.ts';
import { accumulateRecord } from './accumulate.ts';
import {
  aggregateAgent,
  aggregateByHour,
  aggregateByModel,
  aggregateInstance,
  aggregateSession,
  type UsageAggregate,
} from './aggregate.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX: RepoContext = { instanceId: INSTANCE_ID };
const S1_UID = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2_UID = 'bbbbbbbb-0000-4000-8000-000000000002';
const T0 = FIXTURE_EPOCH_MS;
const MIN = 60_000;

const opened: InstanceDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

type FileName = 'f1' | 'f2' | 'f3';

interface Fixture {
  readonly db: InstanceDb;
  readonly repo: UsageRepo;
  readonly s1: number;
  readonly s2: number;
  readonly main1: number;
  readonly sub1: number;
  readonly files: Readonly<Record<FileName, number>>;
}

function addFile(
  db: InstanceDb,
  name: string,
  sessionId: number,
  sessionUid: string,
  agentId: number | null,
  birthMs: number,
): number {
  return db.driver
    .prepare(
      "INSERT INTO transcript_files (path, path_key, kind, session_uid, session_id, agent_id, birth_ms, first_seen_mtime_ms, discovered_at, updated_at, usage_state) VALUES (?, ?, 'session', ?, ?, ?, ?, ?, ?, ?, 'complete')",
    )
    .run([name, name, sessionUid, sessionId, agentId, birthMs, birthMs, T0, T0]).lastInsertRowid;
}

/** F1 = main file of S1 (created 10:00), F2 = subagent file of S1 (10:05), F3 = main file of S2 (11:00, a resume of S1). */
function fixture(): Fixture {
  const db = openInstanceDb({
    path: join(tempDir('tokens').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
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
  main(s2);
  const sub1 = db.driver
    .prepare(
      "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'agent-a1b2c3', ?, 'subagent', 1, ?, ?, ?, ?)",
    )
    .run([s1, main1, T0, T0, T0, T0]).lastInsertRowid;
  const files = {
    f1: addFile(db, 'f1.jsonl', s1, S1_UID, main1, T0),
    f2: addFile(db, 'f2.jsonl', s1, S1_UID, sub1, T0 + 5 * MIN),
    f3: addFile(db, 'f3.jsonl', s2, S2_UID, null, T0 + 60 * MIN),
  };
  return { db, repo: new UsageRepo(db), s1, s2, main1, sub1, files };
}

// ---- record builders ------------------------------------------------------------------------------------------------

interface Four {
  readonly i: number;
  readonly o: number;
  readonly cr: number;
  readonly cc: number;
  readonly split?: readonly [number, number];
}

function usageObject(f: Four): Record<string, unknown> {
  return {
    input_tokens: f.i,
    output_tokens: f.o,
    cache_read_input_tokens: f.cr,
    cache_creation_input_tokens: f.cc,
    ...(f.split === undefined
      ? {}
      : { cache_creation: { ephemeral_5m_input_tokens: f.split[0], ephemeral_1h_input_tokens: f.split[1] } }),
  };
}

let seq = 0;

interface AssistantInit {
  readonly id: string | null;
  readonly model: string;
  readonly usage?: Record<string, unknown>;
  readonly stop: string | null;
  readonly offsetMs?: number;
  readonly extraUsage?: Record<string, unknown>;
}

function assistant(init: AssistantInit): TranscriptRecord {
  seq += 1;
  const usage = init.usage === undefined ? undefined : { ...init.usage, ...init.extraUsage };
  return TranscriptRecordShape.parse({
    type: 'assistant',
    uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    timestamp: isoMsZ(T0 + (init.offsetMs ?? seq)),
    message: {
      ...(init.id === null ? {} : { id: init.id }),
      model: init.model,
      role: 'assistant',
      stop_reason: init.stop,
      ...(usage === undefined ? {} : { usage }),
    },
  });
}

const SYNTHETIC_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

interface Rec {
  readonly file: FileName;
  readonly record: TranscriptRecord;
}

/** The records of the worked example of 02 6.4, in file order. */
function workedExample(): Rec[] {
  const a: Four = { i: 10, o: 200, cr: 5000, cc: 1000, split: [0, 1000] };
  const b: Four = { i: 4, o: 50, cr: 6000, cc: 0, split: [0, 0] };
  const z: Four = { i: 2, o: 300, cr: 959_572, cc: 4000, split: [0, 4000] };
  const e: Four = { i: 6, o: 70, cr: 7000, cc: 500, split: [0, 500] };
  const c = (o: number): Four => ({ i: 3, o, cr: 1000, cc: 200, split: [200, 0] });
  const d: Four = { i: 5, o: 8, cr: 800, cc: 0, split: [0, 0] };
  const x = 'model-x';
  const y = 'model-y';
  const iter = (f: Four): Record<string, unknown> => ({ iterations: [usageObject(f)] });
  const zero: Four = { i: 0, o: 0, cr: 0, cc: 0 };
  const first = (file: FileName, offsetMs: number): Rec => ({
    file,
    record: assistant({ id: 'msg_A', model: x, usage: usageObject(a), stop: null, offsetMs }),
  });
  const second = (file: FileName, offsetMs: number): Rec => ({
    file,
    record: assistant({
      id: 'msg_A',
      model: x,
      usage: usageObject(a),
      stop: 'end_turn',
      extraUsage: iter(a),
      offsetMs,
    }),
  });
  return [
    first('f1', 1),
    second('f1', 2),
    {
      file: 'f1',
      record: assistant({
        id: 'msg_B',
        model: x,
        usage: usageObject(b),
        stop: 'tool_use',
        extraUsage: iter(b),
        offsetMs: 3,
      }),
    },
    {
      file: 'f1',
      record: assistant({
        id: 'msg_Z',
        model: x,
        usage: usageObject(zero),
        stop: 'tool_use',
        extraUsage: iter(z),
        offsetMs: 4,
      }),
    },
    {
      file: 'f1',
      record: assistant({
        id: SYNTHETIC_ID,
        model: '<synthetic>',
        usage: usageObject(zero),
        stop: 'stop_sequence',
        offsetMs: 5,
      }),
    },
    { file: 'f1', record: assistant({ id: 'msg_N', model: x, stop: 'end_turn', offsetMs: 6 }) },
    ...[8, 8, 412].map((o, n): Rec => ({
      file: 'f2',
      record: assistant({
        id: 'msg_C',
        model: y,
        usage: usageObject(c(o)),
        stop: n === 2 ? 'tool_use' : null,
        ...(n === 2 ? { extraUsage: iter(c(o)) } : {}),
        offsetMs: 10 + n,
      }),
    })),
    ...[0, 1].map((n): Rec => ({
      file: 'f2',
      record: assistant({ id: 'msg_D', model: y, usage: usageObject(d), stop: null, offsetMs: 20 + n }),
    })),
    first('f3', 100),
    second('f3', 101),
    {
      file: 'f3',
      record: assistant({
        id: 'msg_E',
        model: x,
        usage: usageObject(e),
        stop: 'end_turn',
        extraUsage: iter(e),
        offsetMs: 102,
      }),
    },
  ];
}

function applyAll(fx: Fixture, records: readonly Rec[]): void {
  let offset = 0;
  withWriteTx(fx.db, CTX, (tx) => {
    for (const r of records) {
      offset += 1;
      accumulateRecord(fx.repo, CTX, tx, { fileId: fx.files[r.file], byteOffset: offset }, r.record);
    }
  });
}

const FIELDS = ['input', 'output', 'cacheRead', 'cacheCreation', 'cacheCreation5m', 'cacheCreation1h'] as const;

function mainSums(a: UsageAggregate): number[] {
  return FIELDS.map((f) => a.sum[f]);
}

describe('worked example of 02 6.4 (T-TK-01)', () => {
  it('S1 own (F1): 16 / 550 / 970,572 / 5,000, split 0 / 5,000, five messages one of them synthetic', () => {
    const fx = fixture();
    applyAll(fx, workedExample());
    const own = aggregateSession(fx.db, CTX, fx.s1, 'own');
    expect(mainSums(own)).toEqual([16, 550, 970_572, 5000, 0, 5000]);
    expect(own.messages).toBe(5);
    expect(own.synthetic).toBe(1);
    expect([own.missing.input, own.missing.output, own.missing.cacheRead, own.missing.cacheCreation]).toEqual([
      1, 1, 1, 1,
    ]);
    expect(own.missing.cacheCreation5m).toBe(2);
    expect(own.unfinalized).toBe(0);
    expect(own.outputIsLowerBound).toBe(false);
    expect(own.complete).toBe(true);
    expect(own.copiedMessages).toBe(0);
  });

  it('S1 agents (F2): 8 / 420 / 1,800 / 200, split 200 / 0, one unfinalized message makes the output a lower bound', () => {
    const fx = fixture();
    applyAll(fx, workedExample());
    const agents = aggregateSession(fx.db, CTX, fx.s1, 'agents');
    expect(mainSums(agents)).toEqual([8, 420, 1800, 200, 200, 0]);
    expect(agents.messages).toBe(2);
    expect(agents.missing.input).toBe(0);
    expect(agents.unfinalized).toBe(1);
    expect(agents.outputIsLowerBound).toBe(true);
    expect(aggregateAgent(fx.db, CTX, fx.sub1)).toEqual(agents);
  });

  it('S1 total: 24 / 970 / 972,372 / 5,200, split 200 / 5,000 with the split missing on two messages; = own + agents', () => {
    const fx = fixture();
    applyAll(fx, workedExample());
    const total = aggregateSession(fx.db, CTX, fx.s1, 'total');
    expect(mainSums(total)).toEqual([24, 970, 972_372, 5200, 200, 5000]);
    expect(total.messages).toBe(7);
    expect(total.missing.input).toBe(1);
    expect(total.missing.cacheCreation5m).toBe(2);
    expect(total.outputIsLowerBound).toBe(true);
    const own = aggregateSession(fx.db, CTX, fx.s1, 'own');
    const agents = aggregateSession(fx.db, CTX, fx.s1, 'agents');
    for (const f of FIELDS) expect(total.sum[f]).toBe(own.sum[f] + agents.sum[f]);
    expect(total.messages).toBe(own.messages + agents.messages);
  });

  it('S2 own (F3): 6 / 70 / 7,000 / 500, the copied msg_A is counted once and owned by S1', () => {
    const fx = fixture();
    applyAll(fx, workedExample());
    const s2 = aggregateSession(fx.db, CTX, fx.s2, 'own');
    expect(mainSums(s2)).toEqual([6, 70, 7000, 500, 0, 500]);
    expect(s2.messages).toBe(1);
    expect(s2.copiedMessages).toBe(1);
    expect(fx.repo.get(CTX, 'msg_A')?.sessionId).toBe(fx.s1);
  });

  it('instance: 30 / 1,040 / 979,372 / 5,700, split 200 / 5,500, eight messages, one without values', () => {
    const fx = fixture();
    applyAll(fx, workedExample());
    const all = aggregateInstance(fx.db, CTX, {});
    expect(mainSums(all)).toEqual([30, 1040, 979_372, 5700, 200, 5500]);
    expect(all.messages).toBe(8);
    expect(all.synthetic).toBe(1);
    expect(all.missing.input).toBe(1);
    expect(all.outputIsLowerBound).toBe(true);
    expect(fx.repo.verifyRollups(CTX)).toEqual([]);
  });

  it('per model: model-x 22 / 620 / 977,572 / 5,500 (five messages), model-y 8 / 420 / 1,800 / 200; synthetic excluded; sum = instance', () => {
    const fx = fixture();
    applyAll(fx, workedExample());
    const models = aggregateByModel(fx.db, CTX, {});
    expect(models.map((m) => m.model)).toEqual(['model-x', 'model-y']);
    const [x, y] = models;
    if (x === undefined || y === undefined) throw new Error('two models expected');
    expect(mainSums(x.agg)).toEqual([22, 620, 977_572, 5500, 0, 5500]);
    expect(x.agg.messages).toBe(5);
    expect(x.agg.missing.input).toBe(1);
    expect(x.agg.outputIsLowerBound).toBe(false);
    expect(mainSums(y.agg)).toEqual([8, 420, 1800, 200, 200, 0]);
    expect(y.agg.messages).toBe(2);
    expect(y.agg.outputIsLowerBound).toBe(true);
    const all = aggregateInstance(fx.db, CTX, {});
    for (const f of FIELDS) expect(x.agg.sum[f] + y.agg.sum[f]).toBe(all.sum[f]);
  });

  it('per hour: the buckets add up to the instance totals', () => {
    const fx = fixture();
    applyAll(fx, workedExample());
    const hours = aggregateByHour(fx.db, CTX, {});
    const all = aggregateInstance(fx.db, CTX, {});
    expect(hours.length).toBeGreaterThanOrEqual(1);
    for (const f of FIELDS) expect(hours.reduce((n, h) => n + h.agg.sum[f], 0)).toBe(all.sum[f]);
    expect(hours.reduce((n, h) => n + h.agg.messages, 0)).toBe(all.messages);
    for (const h of hours) expect(h.hourStart % 3_600_000).toBe(0);
  });

  it('msg_C is finalized by its third record, msg_D never is; msg_Z takes its values from iterations[0]', () => {
    const fx = fixture();
    applyAll(fx, workedExample());
    expect(fx.repo.get(CTX, 'msg_C')).toMatchObject({ inputTokens: 3, outputTokens: 412, finalized: true });
    expect(fx.repo.get(CTX, 'msg_D')).toMatchObject({ inputTokens: 5, outputTokens: 8, finalized: false });
    expect(fx.repo.get(CTX, 'msg_Z')).toMatchObject({
      inputTokens: 2,
      outputTokens: 300,
      cacheReadTokens: 959_572,
      usageSource: 'iterations',
    });
  });
});

describe('edge cases (T-TK-02)', () => {
  it('X1: invalid values (1.5, -3, "12", true) leave the output missing and count four invalid values', () => {
    const fx = fixture();
    const bad = [1.5, -3, '12', true].map((o, n): Rec => ({
      file: 'f1',
      record: assistant({
        id: 'msg_X1',
        model: 'model-x',
        usage: { input_tokens: 7, output_tokens: o, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
        stop: null,
        offsetMs: n,
      }),
    }));
    applyAll(fx, bad);
    expect(fx.repo.get(CTX, 'msg_X1')).toMatchObject({ inputTokens: 7, outputTokens: null });
    expect(fx.repo.getFile(CTX, fx.files.f1, 'msg_X1')?.invalidValues).toBe(4);
    const all = aggregateInstance(fx.db, CTX, {});
    expect(all.missing.output).toBe(1);
    expect(all.sum.output).toBe(0);
    expect(all.sum.input).toBe(7);
  });

  it('X2: differing copies, output 100 in F1 and 120 in F3, give 120 owned by S1', () => {
    const fx = fixture();
    const usage = (o: number): Record<string, unknown> => usageObject({ i: 1, o, cr: 0, cc: 0 });
    applyAll(fx, [
      { file: 'f1', record: assistant({ id: 'msg_F', model: 'model-x', usage: usage(100), stop: 'end_turn' }) },
      { file: 'f3', record: assistant({ id: 'msg_F', model: 'model-x', usage: usage(120), stop: 'end_turn' }) },
    ]);
    expect(fx.repo.get(CTX, 'msg_F')).toMatchObject({ outputTokens: 120, sessionId: fx.s1 });
    expect(aggregateInstance(fx.db, CTX, {}).sum.output).toBe(120);
  });

  it('X3: split reads, output 8 and unfinalized after the first read, 412 and finalized after the second', () => {
    const fx = fixture();
    const c = (o: number, stop: string | null): Rec => ({
      file: 'f2',
      record: assistant({
        id: 'msg_C',
        model: 'model-y',
        usage: usageObject({ i: 3, o, cr: 1000, cc: 200, split: [200, 0] }),
        stop,
      }),
    });
    applyAll(fx, [c(8, null), c(8, null)]);
    expect(fx.repo.get(CTX, 'msg_C')).toMatchObject({ outputTokens: 8, finalized: false });
    expect(aggregateAgent(fx.db, CTX, fx.sub1).unfinalized).toBe(1);
    applyAll(fx, [c(412, 'tool_use')]);
    expect(fx.repo.get(CTX, 'msg_C')).toMatchObject({ outputTokens: 412, finalized: true });
    expect(aggregateAgent(fx.db, CTX, fx.sub1).unfinalized).toBe(0);
  });

  it('X4: zero is not missing, usage {0, 0, 0, 0} without iterations gives zeros and no missing count', () => {
    const fx = fixture();
    applyAll(fx, [
      {
        file: 'f1',
        record: assistant({
          id: 'msg_X4',
          model: 'model-x',
          usage: usageObject({ i: 0, o: 0, cr: 0, cc: 0 }),
          stop: 'end_turn',
        }),
      },
    ]);
    const all = aggregateInstance(fx.db, CTX, {});
    expect(all.messages).toBe(1);
    expect(mainSums(all).slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect([all.missing.input, all.missing.output, all.missing.cacheRead, all.missing.cacheCreation]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(fx.repo.get(CTX, 'msg_X4')?.usageSource).toBe('top');
  });

  it('X5: 200 seeded permutations of record order (files interleaved) give identical aggregates', () => {
    const fx = fixture();
    const records = workedExample();
    applyAll(fx, records);
    const snapshot = (): unknown[] => [
      aggregateSession(fx.db, CTX, fx.s1, 'own'),
      aggregateSession(fx.db, CTX, fx.s1, 'agents'),
      aggregateSession(fx.db, CTX, fx.s1, 'total'),
      aggregateSession(fx.db, CTX, fx.s2, 'own'),
      aggregateInstance(fx.db, CTX, {}),
      aggregateByModel(fx.db, CTX, {}),
    ];
    const expected = snapshot();
    let state = 0x9e3779b9;
    const random = (): number => {
      // mulberry32: a seeded generator, so a failure names a reproducible permutation
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    for (let round = 0; round < 200; round += 1) {
      for (const id of Object.values(fx.files)) withWriteTx(fx.db, CTX, (tx) => fx.repo.removeFile(CTX, tx, id));
      expect(aggregateInstance(fx.db, CTX, {}).messages).toBe(0);
      const order = [...records];
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const a = order[i];
        const b = order[j];
        if (a === undefined || b === undefined) throw new Error('permutation index out of range');
        order[i] = b;
        order[j] = a;
      }
      applyAll(fx, order);
      expect(snapshot(), `permutation ${String(round)}`).toEqual(expected);
    }
    expect(fx.repo.verifyRollups(CTX)).toEqual([]);
  });
});
