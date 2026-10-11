// Token accounting: the record rules of 02 6.2 (accumulate), the aggregates of 6.3, and the guarantees T-TK-03, 05, 06, 07, 08, 09.
// The worked example (T-TK-01, 02) is in worked-example.test.ts, the legacy projection (T-TK-04) in legacy-projection.test.ts.
import { join } from 'node:path';

import { TranscriptRecordShape } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, TranscriptBuilder, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { fixtureEnvelope } from '../../test/fixtures/hooks.ts';
import { DbError } from '../db/errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../db/open.ts';
import { UsageRepo } from '../db/repos/usage.ts';
import { withWriteTx } from '../db/write.ts';
import { normalizeEnvelope } from '../ingest/hooks/normalize-envelope.ts';
import type { TranscriptRecord } from '../ingest/transcripts/normalize-record.ts';
import { accumulateRecord, messageKeyOf, usageOfRecord } from './accumulate.ts';
import {
  aggregateAgent,
  aggregateByHour,
  aggregateByModel,
  aggregateInstance,
  aggregateSession,
  type UsageAggregate,
} from './aggregate.ts';

const tempDir = useTempDirs();
const T0 = FIXTURE_EPOCH_MS;
const MIN = 60_000;
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const INSTANCE_B = '22222222-2222-4222-8222-222222222222';
const S1_UID = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2_UID = 'bbbbbbbb-0000-4000-8000-000000000002';

const opened: InstanceDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function parse(value: Record<string, unknown>): TranscriptRecord {
  return TranscriptRecordShape.parse(value);
}

function assistantRecord(message: Record<string, unknown>, over: Record<string, unknown> = {}): TranscriptRecord {
  return parse({
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { id: 'msg_1', model: 'model-x', role: 'assistant', stop_reason: null, ...message },
    ...over,
  });
}

const SITE = { fileId: 7, byteOffset: 4096 };

// ---- record rules (accumulate) -------------------------------------------------------------------------------------------

describe('message key (02 6.2 rule 1)', () => {
  it('is message.id when it is a non-empty string of at most 128 characters', () => {
    expect(messageKeyOf(assistantRecord({ id: 'msg_abc' }), SITE)).toBe('msg_abc');
    expect(messageKeyOf(assistantRecord({ id: 'x'.repeat(128) }), SITE)).toBe('x'.repeat(128));
  });

  it('falls back to uuid:<uuid>, then to line:<file>:<offset>', () => {
    expect(messageKeyOf(assistantRecord({ id: '' }), SITE)).toBe('uuid:00000000-0000-4000-8000-000000000001');
    expect(messageKeyOf(assistantRecord({ id: 'x'.repeat(129) }), SITE)).toBe(
      'uuid:00000000-0000-4000-8000-000000000001',
    );
    const noIds = parse({ type: 'assistant', message: { model: 'model-x' } });
    expect(messageKeyOf(noIds, SITE)).toBe('line:7:4096');
    expect(messageKeyOf(parse({ type: 'assistant', uuid: 'u'.repeat(129), message: {} }), SITE)).toBe('line:7:4096');
  });

  it('never exceeds the 160 characters of the column', () => {
    const key = messageKeyOf(assistantRecord({ id: undefined }, { uuid: 'u'.repeat(128) }), SITE);
    expect(key.length).toBeLessThanOrEqual(160);
  });
});

describe('effective values of a record (02 6.2 rules 2, 3, 5, 10-12)', () => {
  it('only assistant records with a message object carry usage; every other record (a hook-like field included) gives null', () => {
    expect(
      usageOfRecord(parse({ type: 'user', message: { role: 'user', usage: { input_tokens: 5 } } }), SITE),
    ).toBeNull();
    expect(usageOfRecord(parse({ type: 'system', agent_total_tokens: 9999 }), SITE)).toBeNull();
    expect(usageOfRecord(parse({ type: 'assistant' }), SITE)).toBeNull();
  });

  it('reads the nine fields, the thinking tokens and the cache split, and keeps the legacy top-level integers', () => {
    const r = usageOfRecord(
      assistantRecord({
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 200,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
          output_tokens_details: { thinking_tokens: 30 },
          server_tool_use: { web_search_requests: 2, web_fetch_requests: 3 },
        },
      }),
      SITE,
    );
    expect(r?.messageKey).toBe('msg_1');
    expect(r?.values).toMatchObject({
      model: 'model-x',
      inputTokens: 10,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheCreationTokens: 1000,
      cacheCreation5mTokens: 400,
      cacheCreation1hTokens: 600,
      thinkingTokens: 30,
      webSearchRequests: 2,
      webFetchRequests: 3,
      legacyIn: 10,
      legacyOut: 200,
      legacyCr: 5000,
      legacyCc: 1000,
      finalized: true,
      usageSource: 'top',
      synthetic: false,
      invalidValues: 0,
      ts: Date.parse('2026-01-01T00:00:01.000Z'),
    });
  });

  it('a missing field is null, never zero, and a record without usage has every field missing and legacy values 0', () => {
    const r = usageOfRecord(assistantRecord({ usage: { input_tokens: 4 } }), SITE);
    expect(r?.values).toMatchObject({
      inputTokens: 4,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreation5mTokens: null,
      thinkingTokens: null,
      webSearchRequests: null,
      legacyOut: 0,
    });
    const none = usageOfRecord(assistantRecord({}), SITE);
    expect(none?.values).toMatchObject({ inputTokens: null, outputTokens: null, legacyIn: 0, finalized: false });
  });

  it('a valid number is a safe integer >= 0: floats, negatives, strings, booleans and null are missing and counted when present', () => {
    const r = usageOfRecord(
      assistantRecord({
        usage: {
          input_tokens: 1.5,
          output_tokens: -3,
          cache_read_input_tokens: '12',
          cache_creation_input_tokens: true,
          output_tokens_details: { thinking_tokens: null },
          server_tool_use: { web_search_requests: Number.MAX_SAFE_INTEGER + 2 },
        },
      }),
      SITE,
    );
    expect(r?.values).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      webSearchRequests: null,
      legacyIn: 0,
      invalidValues: 6,
    });
  });

  const iterationUsage = {
    input_tokens: 2,
    output_tokens: 300,
    cache_read_input_tokens: 959_572,
    cache_creation_input_tokens: 4000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 4000 },
  };

  it('uses iterations[0] when the four top-level fields are all 0 and it has a positive value; the legacy values stay 0', () => {
    const r = usageOfRecord(
      assistantRecord({
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          iterations: [iterationUsage],
        },
      }),
      SITE,
    );
    expect(r?.values).toMatchObject({
      inputTokens: 2,
      outputTokens: 300,
      cacheReadTokens: 959_572,
      cacheCreationTokens: 4000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 4000,
      usageSource: 'iterations',
      finalized: true,
      legacyIn: 0,
      legacyOut: 0,
      legacyCr: 0,
      legacyCc: 0,
    });
  });

  it('uses iterations[0] when the four top-level fields are all missing', () => {
    const r = usageOfRecord(assistantRecord({ usage: { iterations: [iterationUsage] } }), SITE);
    expect(r?.values).toMatchObject({ inputTokens: 2, usageSource: 'iterations' });
  });

  it('keeps the top-level values when one of them is positive, or when iterations[0] has no positive value', () => {
    const topPositive = usageOfRecord(
      assistantRecord({ usage: { input_tokens: 0, output_tokens: 1, iterations: [iterationUsage] } }),
      SITE,
    );
    expect(topPositive?.values).toMatchObject({ inputTokens: 0, outputTokens: 1, usageSource: 'top', finalized: true });
    const emptyIteration = usageOfRecord(
      assistantRecord({
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          iterations: [{ input_tokens: 0, output_tokens: 0 }],
        },
      }),
      SITE,
    );
    expect(emptyIteration?.values).toMatchObject({ inputTokens: 0, usageSource: 'top', finalized: true });
    const notObject = usageOfRecord(assistantRecord({ usage: { input_tokens: 0, iterations: [5] } }), SITE);
    expect(notObject?.values).toMatchObject({ inputTokens: 0, usageSource: 'top' });
  });

  it('finalized is a stop reason or an iterations array; synthetic is the model <synthetic>', () => {
    expect(usageOfRecord(assistantRecord({ stop_reason: 'tool_use' }), SITE)?.values.finalized).toBe(true);
    expect(usageOfRecord(assistantRecord({ stop_reason: null }), SITE)?.values.finalized).toBe(false);
    expect(usageOfRecord(assistantRecord({ usage: { iterations: [] } }), SITE)?.values.finalized).toBe(true);
    expect(usageOfRecord(assistantRecord({ model: '<synthetic>' }), SITE)?.values.synthetic).toBe(true);
    expect(usageOfRecord(assistantRecord({ model: 'model-x' }), SITE)?.values.synthetic).toBe(false);
  });

  it('a record without a valid timestamp has ts null', () => {
    expect(usageOfRecord(assistantRecord({}, { timestamp: 'not a time' }), SITE)?.values.ts).toBeNull();
    expect(usageOfRecord(parse({ type: 'assistant', message: { id: 'm' } }), SITE)?.values.ts).toBeNull();
  });
});

// ---- database fixtures ---------------------------------------------------------------------------------------------------

interface Fixture {
  readonly db: InstanceDb;
  readonly ctx: RepoContext;
  readonly repo: UsageRepo;
  readonly s1: number;
  readonly s2: number;
  readonly sub1: number;
  /** F1 main of S1, F2 subagent of S1, F3 main of S2. */
  readonly f1: number;
  readonly f2: number;
  readonly f3: number;
}

function fixture(instanceId = INSTANCE_A): Fixture {
  const db = openInstanceDb({
    path: join(tempDir('tokens-agg').path, 'monitor.db'),
    expectedInstanceId: instanceId,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  opened.push(db);
  const run = (sql: string, params: readonly unknown[]): number =>
    db.driver.prepare(sql).run(params as never[]).lastInsertRowid;
  const session = (uid: string): number =>
    run(
      'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [uid, T0, T0, T0, T0],
    );
  const main = (sessionId: number): number =>
    run(
      "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'main', NULL, 'main', 0, ?, ?, ?, ?)",
      [sessionId, T0, T0, T0, T0],
    );
  const file = (name: string, sessionId: number, uid: string, agentId: number | null, birth: number): number =>
    run(
      "INSERT INTO transcript_files (path, path_key, kind, session_uid, session_id, agent_id, birth_ms, first_seen_mtime_ms, discovered_at, updated_at, usage_state) VALUES (?, ?, 'session', ?, ?, ?, ?, ?, ?, ?, 'complete')",
      [name, name, uid, sessionId, agentId, birth, birth, T0, T0],
    );
  const s1 = session(S1_UID);
  const s2 = session(S2_UID);
  const main1 = main(s1);
  main(s2);
  const sub1 = run(
    "INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, 'agent-a1b2c3', ?, 'subagent', 1, ?, ?, ?, ?)",
    [s1, main1, T0, T0, T0, T0],
  );
  return {
    db,
    ctx: { instanceId },
    repo: new UsageRepo(db),
    s1,
    s2,
    sub1,
    f1: file('f1.jsonl', s1, S1_UID, main1, T0),
    f2: file('f2.jsonl', s1, S1_UID, sub1, T0 + 5 * MIN),
    f3: file('f3.jsonl', s2, S2_UID, null, T0 + 60 * MIN),
  };
}

function feed(fx: Fixture, fileId: number, lines: readonly string[]): void {
  withWriteTx(fx.db, fx.ctx, (tx) => {
    lines.forEach((line, n) => {
      const parsed = TranscriptRecordShape.safeParse(JSON.parse(line));
      if (parsed.success) accumulateRecord(fx.repo, fx.ctx, tx, { fileId, byteOffset: n * 100 }, parsed.data);
    });
  });
}

/** Three sessions' worth of generated records: a main file, a subagent file, and a resumed copy of the main file plus news. */
function generated(): { main: string[]; sub: string[]; resumed: string[]; all: string[][] } {
  const base = { sessionId: S1_UID, cwd: 'FIXTURE/project', startMs: T0 };
  const fill = (b: TranscriptBuilder): TranscriptBuilder =>
    b
      .user()
      .assistant({
        messageId: 'm1',
        snapshots: 3,
        usage: { input_tokens: 9, output_tokens: 90, cache_read_input_tokens: 800, cache_creation_input_tokens: 70 },
        stop: 'tool_use',
      })
      .assistant({
        messageId: 'm2',
        zeroTopLevel: true,
        usage: { input_tokens: 3, output_tokens: 33, cache_read_input_tokens: 1234, cache_creation_input_tokens: 56 },
      })
      .assistant({ messageId: 'm3', snapshots: 2, outputPerRecord: [5, 55], stop: 'end_turn' });
  const main = fill(new TranscriptBuilder(base));
  const sub = new TranscriptBuilder({ ...base, agentId: 'agent-a1b2c3', startMs: T0 + 5 * MIN })
    .user()
    .assistant({
      messageId: 's1',
      snapshots: 4,
      outputPerRecord: [8, 8, 8, 77],
      usage: { input_tokens: 2, output_tokens: 77, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    })
    .assistant({
      messageId: 's2',
      snapshots: 2,
      outputPerRecord: [8, 8],
      stop: null,
      usage: { input_tokens: 4, output_tokens: 8, cache_read_input_tokens: 11, cache_creation_input_tokens: 0 },
    });
  const resumed = fill(
    new TranscriptBuilder({ ...base, sessionId: S2_UID, uuidSeed: S1_UID, startMs: T0 + 60 * MIN }),
  ).assistant({
    messageId: 'm9',
    usage: { input_tokens: 6, output_tokens: 60, cache_read_input_tokens: 600, cache_creation_input_tokens: 6 },
  });
  return {
    main: main.lines(),
    sub: sub.lines(),
    resumed: resumed.lines(),
    all: [main.lines(), sub.lines(), resumed.lines()],
  };
}

interface Naive {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  messages: number;
}

/** The survey's method B: read every line of every file, the last record of an id wins (max per field), global dedupe. */
function naive(files: readonly (readonly string[])[]): Naive {
  const byId = new Map<string, [number, number, number, number]>();
  const num = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  for (const lines of files) {
    for (const line of lines) {
      const rec = JSON.parse(line) as { type?: string; message?: { id?: string; usage?: Record<string, unknown> } };
      if (rec.type !== 'assistant' || rec.message?.usage === undefined) continue;
      const id = rec.message.id ?? '';
      let u = rec.message.usage;
      const top = [
        u['input_tokens'],
        u['output_tokens'],
        u['cache_read_input_tokens'],
        u['cache_creation_input_tokens'],
      ].map(num);
      const iter = Array.isArray(u['iterations'])
        ? (u['iterations'][0] as Record<string, unknown> | undefined)
        : undefined;
      if (top.every((n) => n === 0) && iter !== undefined) u = iter;
      const v = [
        u['input_tokens'],
        u['output_tokens'],
        u['cache_read_input_tokens'],
        u['cache_creation_input_tokens'],
      ].map(num);
      const cur = byId.get(id) ?? [0, 0, 0, 0];
      byId.set(id, [
        Math.max(cur[0], v[0] ?? 0),
        Math.max(cur[1], v[1] ?? 0),
        Math.max(cur[2], v[2] ?? 0),
        Math.max(cur[3], v[3] ?? 0),
      ]);
    }
  }
  const out: Naive = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, messages: byId.size };
  for (const [i, o, cr, cc] of byId.values()) {
    out.input += i;
    out.output += o;
    out.cacheRead += cr;
    out.cacheCreation += cc;
  }
  return out;
}

function mainOf(a: UsageAggregate): Omit<Naive, 'messages'> & { messages: number } {
  return {
    input: a.sum.input,
    output: a.sum.output,
    cacheRead: a.sum.cacheRead,
    cacheCreation: a.sum.cacheCreation,
    messages: a.messages,
  };
}

function snapshot(fx: Fixture): unknown[] {
  return [
    aggregateSession(fx.db, fx.ctx, fx.s1, 'own'),
    aggregateSession(fx.db, fx.ctx, fx.s1, 'agents'),
    aggregateSession(fx.db, fx.ctx, fx.s1, 'total'),
    aggregateSession(fx.db, fx.ctx, fx.s2, 'own'),
    aggregateInstance(fx.db, fx.ctx, {}),
    aggregateByModel(fx.db, fx.ctx, {}),
    aggregateByHour(fx.db, fx.ctx, {}),
  ];
}

describe('independent recomputation (T-TK-05)', () => {
  it('aggregateInstance equals a naive last-record-wins, global-dedupe pass over the same files, resume copy included', () => {
    const fx = fixture();
    const g = generated();
    feed(fx, fx.f1, g.main);
    feed(fx, fx.f2, g.sub);
    feed(fx, fx.f3, g.resumed);
    const expected = naive(g.all);
    expect(expected.messages).toBe(6);
    expect(mainOf(aggregateInstance(fx.db, fx.ctx, {}))).toEqual(expected);
    expect(mainOf(aggregateSession(fx.db, fx.ctx, fx.s1, 'total'))).toEqual(naive([g.main, g.sub]));
    expect(aggregateSession(fx.db, fx.ctx, fx.s2, 'own').messages).toBe(1);
    expect(fx.repo.verifyRollups(fx.ctx)).toEqual([]);
  });
});

describe('idempotent re-import (T-TK-03)', () => {
  it('importing the three files twice, and once more after a forced identity reset of F2, leaves the aggregates unchanged', () => {
    const fx = fixture();
    const g = generated();
    const importAll = (): void => {
      feed(fx, fx.f1, g.main);
      feed(fx, fx.f2, g.sub);
      feed(fx, fx.f3, g.resumed);
    };
    importAll();
    const once = snapshot(fx);
    importAll();
    expect(snapshot(fx)).toEqual(once);
    withWriteTx(fx.db, fx.ctx, (tx) => fx.repo.removeFile(fx.ctx, tx, fx.f2));
    expect(aggregateSession(fx.db, fx.ctx, fx.s1, 'agents').messages).toBe(0);
    feed(fx, fx.f2, g.sub);
    expect(snapshot(fx)).toEqual(once);
    expect(fx.repo.verifyRollups(fx.ctx)).toEqual([]);
  });
});

describe('missing versus zero (T-TK-06)', () => {
  it('the aggregate carries a missing count for every field; a message without usage is never reported as zero tokens', () => {
    const fx = fixture();
    const line = (message: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { model: 'model-x', stop_reason: 'end_turn', ...message },
      });
    feed(fx, fx.f1, [
      line({ id: 'msg_none' }),
      line({
        id: 'msg_zero',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    ]);
    const agg = aggregateSession(fx.db, fx.ctx, fx.s1, 'own');
    expect(Object.keys(agg.missing).sort()).toEqual(Object.keys(agg.sum).sort());
    expect(Object.keys(agg.sum).sort()).toEqual(
      [
        'cacheCreation',
        'cacheCreation1h',
        'cacheCreation5m',
        'cacheRead',
        'input',
        'output',
        'thinking',
        'webFetch',
        'webSearch',
      ].sort(),
    );
    expect(agg.messages).toBe(2);
    expect([agg.missing.input, agg.missing.output, agg.missing.cacheRead, agg.missing.cacheCreation]).toEqual([
      1, 1, 1, 1,
    ]);
    expect(agg.missing.thinking).toBe(2);
    const empty = aggregateSession(fx.db, fx.ctx, fx.s2, 'own');
    expect(empty.messages).toBe(0);
    expect(empty.missing.input).toBe(0);
    expect(empty.complete).toBe(true);
  });
});

describe('partial scan (T-TK-07)', () => {
  it('complete is false while a contributing file is partial or skipped, true when every file is complete, with equal totals', () => {
    const fx = fixture();
    const g = generated();
    feed(fx, fx.f1, g.main);
    feed(fx, fx.f2, g.sub);
    feed(fx, fx.f3, g.resumed);
    const setState = (file: number, state: string): void => {
      fx.db.driver.prepare('UPDATE transcript_files SET usage_state = ? WHERE id = ?').run([state, file]);
    };
    const complete = snapshot(fx);
    setState(fx.f2, 'partial');
    expect(aggregateSession(fx.db, fx.ctx, fx.s1, 'own').complete).toBe(true);
    expect(aggregateSession(fx.db, fx.ctx, fx.s1, 'agents').complete).toBe(false);
    expect(aggregateAgent(fx.db, fx.ctx, fx.sub1).complete).toBe(false);
    expect(aggregateSession(fx.db, fx.ctx, fx.s1, 'total').complete).toBe(false);
    expect(aggregateInstance(fx.db, fx.ctx, {}).complete).toBe(false);
    expect(aggregateByModel(fx.db, fx.ctx, {}).every((m) => !m.agg.complete)).toBe(true);
    setState(fx.f2, 'skipped_backfill');
    expect(aggregateSession(fx.db, fx.ctx, fx.s1, 'total').complete).toBe(false);
    setState(fx.f2, 'complete');
    expect(snapshot(fx)).toEqual(complete);
  });

  it('a retired file does not hold the aggregate back', () => {
    const fx = fixture();
    feed(fx, fx.f1, generated().main);
    fx.db.driver
      .prepare("UPDATE transcript_files SET usage_state = 'partial', state = 'retired' WHERE id = ?")
      .run([fx.f2]);
    expect(aggregateSession(fx.db, fx.ctx, fx.s1, 'total').complete).toBe(true);
  });
});

describe('hooks add zero tokens (T-TK-08)', () => {
  it('a PostToolUse(Agent) envelope with agent_total_tokens 9999 changes no aggregate and produces no usage', () => {
    const fx = fixture();
    const g = generated();
    feed(fx, fx.f1, g.main);
    feed(fx, fx.f2, g.sub);
    const before = snapshot(fx);
    const envelope = fixtureEnvelope('PostToolUse', {
      data: { tool_name: 'Agent', agent_total_tokens: 9999, agent_id: 'agent-a1b2c3' },
    });
    const normalized = normalizeEnvelope(envelope);
    expect(normalized.events.length).toBeGreaterThan(0);
    // the only way into the usage tables is a transcript record: a hook-shaped record is not one
    const asRecord = usageOfRecord(
      TranscriptRecordShape.parse({
        type: 'system',
        subtype: 'hook',
        agent_total_tokens: 9999,
        message: { usage: { input_tokens: 9999 } },
      }),
      SITE,
    );
    expect(asRecord).toBeNull();
    expect(snapshot(fx)).toEqual(before);
    expect(aggregateInstance(fx.db, fx.ctx, {}).sum.input).toBeLessThan(9999);
  });
});

describe('isolation (T-TK-09)', () => {
  it('two instances over the same message ids count only their own files, and a foreign scope is refused', () => {
    const a = fixture(INSTANCE_A);
    const b = fixture(INSTANCE_B);
    const g = generated();
    feed(a, a.f1, g.main);
    feed(a, a.f2, g.sub);
    feed(b, b.f1, g.main);
    expect(mainOf(aggregateInstance(a.db, a.ctx, {}))).toEqual(naive([g.main, g.sub]));
    expect(mainOf(aggregateInstance(b.db, b.ctx, {}))).toEqual(naive([g.main]));
    expect(() => aggregateInstance(a.db, b.ctx, {})).toThrow(DbError);
    expect(() => aggregateSession(b.db, a.ctx, b.s1, 'total')).toThrow(DbError);
  });
});

describe('filters', () => {
  it('a window selects usage by the first time of the message, from inclusive to exclusive; a session filter narrows to owners', () => {
    const fx = fixture();
    const g = generated();
    feed(fx, fx.f1, g.main);
    feed(fx, fx.f2, g.sub);
    feed(fx, fx.f3, g.resumed);
    const all = aggregateInstance(fx.db, fx.ctx, {});
    const early = aggregateInstance(fx.db, fx.ctx, { toMs: T0 + 30 * MIN });
    const late = aggregateInstance(fx.db, fx.ctx, { fromMs: T0 + 30 * MIN });
    expect(early.messages + late.messages).toBe(all.messages);
    expect(early.sum.input + late.sum.input).toBe(all.sum.input);
    expect(aggregateInstance(fx.db, fx.ctx, { fromMs: T0 + 10 * MIN, toMs: T0 + 10 * MIN }).messages).toBe(0);
    const s1 = aggregateInstance(fx.db, fx.ctx, { sessionIds: [fx.s1] });
    expect(s1).toEqual({ ...aggregateSession(fx.db, fx.ctx, fx.s1, 'total'), copiedMessages: 0 });
    expect(aggregateInstance(fx.db, fx.ctx, { models: ['no-such-model'] }).messages).toBe(0);
    expect(aggregateByHour(fx.db, fx.ctx, { sessionIds: [] }).length).toBe(0);
  });

  it('an unknown session or agent gives the empty aggregate', () => {
    const fx = fixture();
    const agg = aggregateSession(fx.db, fx.ctx, 9999, 'total');
    expect(agg.messages).toBe(0);
    expect(agg.complete).toBe(true);
    expect(aggregateAgent(fx.db, fx.ctx, 9999).messages).toBe(0);
  });
});
