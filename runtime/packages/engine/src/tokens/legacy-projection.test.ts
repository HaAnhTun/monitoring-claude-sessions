// T-TK-04: the legacy parity projection (02 6.5). The numbers of the worked example are checked against the text of the design
// AND against the legacy Python reader (read-only, `python -B`, temp files only), which is the oracle of `usage` and `usage_total`.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TranscriptRecordShape, isoMsZ } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { DbError } from '../db/errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../db/open.ts';
import { UsageRepo } from '../db/repos/usage.ts';
import { withWriteTx } from '../db/write.ts';
import { accumulateRecord } from './accumulate.ts';
import { aggregateSession } from './aggregate.ts';
import { legacyFileUsage, legacyUsageTotal } from './legacy-projection.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX: RepoContext = { instanceId: INSTANCE_ID };
const S1_UID = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2_UID = 'bbbbbbbb-0000-4000-8000-000000000002';
const T0 = FIXTURE_EPOCH_MS;
const MIN = 60_000;
const LEGACY_SRC = fileURLToPath(new URL('../../../../../src', import.meta.url));

const opened: InstanceDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

interface FileSpec {
  readonly name: string;
  readonly kind: 'session' | 'subagent';
  readonly session: 's1' | 's2';
  readonly birth: number;
  readonly lines: string[];
}

type Rec = Record<string, unknown>;

let seq = 0;

/** One assistant record in the shape of Claude Code; `usage` undefined leaves the object out. */
function assistant(
  id: string | null,
  model: string,
  usage: Rec | undefined,
  stop: string | null,
  extra: Rec = {},
): Rec {
  seq += 1;
  return {
    type: 'assistant',
    uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    timestamp: isoMsZ(T0 + seq * 1000),
    message: {
      ...(id === null ? {} : { id }),
      model,
      role: 'assistant',
      stop_reason: stop,
      ...(usage === undefined ? {} : { usage }),
    },
    ...extra,
  };
}

const u = (i: number, o: number, cr: number, cc: number, split: readonly [number, number], extra: Rec = {}): Rec => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cc,
  cache_creation: { ephemeral_5m_input_tokens: split[0], ephemeral_1h_input_tokens: split[1] },
  ...extra,
});

/** The worked example of 02 6.4 as three transcript files (plus a bookkeeping record and a torn-free tail). */
function workedExample(): FileSpec[] {
  const a = u(10, 200, 5000, 1000, [0, 1000]);
  const aFinal = { ...a, iterations: [a] };
  const f1 = [
    { type: 'last-prompt', lastPrompt: 'FIXTURE', timestamp: isoMsZ(T0 + 1) },
    assistant('msg_A', 'model-x', a, null),
    assistant('msg_A', 'model-x', aFinal, 'end_turn'),
    assistant('msg_B', 'model-x', u(4, 50, 6000, 0, [0, 0], { iterations: [u(4, 50, 6000, 0, [0, 0])] }), 'tool_use'),
    assistant(
      'msg_Z',
      'model-x',
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: [u(2, 300, 959_572, 4000, [0, 4000])],
      },
      'tool_use',
    ),
    assistant(
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      '<synthetic>',
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      'stop_sequence',
    ),
    assistant('msg_N', 'model-x', undefined, 'end_turn'),
  ];
  const c = (o: number, stop: string | null): Rec =>
    assistant(
      'msg_C',
      'model-y',
      u(3, o, 1000, 200, [200, 0], stop === null ? {} : { iterations: [u(3, o, 1000, 200, [200, 0])] }),
      stop,
    );
  const d = (): Rec => assistant('msg_D', 'model-y', u(5, 8, 800, 0, [0, 0]), null);
  const f2 = [c(8, null), c(8, null), c(412, 'tool_use'), d(), d()];
  const f3 = [
    assistant('msg_A', 'model-x', a, null),
    assistant('msg_A', 'model-x', aFinal, 'end_turn'),
    assistant(
      'msg_E',
      'model-x',
      u(6, 70, 7000, 500, [0, 500], { iterations: [u(6, 70, 7000, 500, [0, 500])] }),
      'end_turn',
    ),
  ];
  const lines = (recs: Rec[]): string[] => recs.map((r) => JSON.stringify(r));
  return [
    { name: 'f1.jsonl', kind: 'session', session: 's1', birth: T0, lines: lines(f1) },
    { name: 'f2.jsonl', kind: 'subagent', session: 's1', birth: T0 + 5 * MIN, lines: lines(f2) },
    { name: 'f3.jsonl', kind: 'session', session: 's2', birth: T0 + 60 * MIN, lines: lines(f3) },
  ];
}

/** What the importer keeps in `first_ts_in_order`, `max_ts_string` and `last_stop_legacy` (02 6.5), computed straight from the lines. */
function importerColumns(lines: readonly string[]): { first: string | null; max: string | null; stop: string | null } {
  let first: string | null = null;
  let max: string | null = null;
  let stop: string | null = null;
  let lastId: unknown = undefined;
  for (const line of lines) {
    const rec = TranscriptRecordShape.parse(JSON.parse(line));
    if (rec.timestamp !== undefined && rec.timestamp !== '') {
      first ??= rec.timestamp;
      if (max === null || rec.timestamp > max) max = rec.timestamp;
    }
    if (rec.type === 'assistant') {
      const id = rec.message?.id ?? rec.uuid;
      if (id !== lastId) {
        lastId = id;
        stop = null;
      }
      const reason = rec.message?.stop_reason;
      if (typeof reason === 'string' && reason !== '') stop = reason;
    }
  }
  return { first, max, stop };
}

interface Loaded {
  readonly db: InstanceDb;
  readonly s1: number;
  readonly s2: number;
  readonly ids: readonly number[];
  readonly paths: readonly string[];
}

function load(specs: readonly FileSpec[], dir: string): Loaded {
  const db = openInstanceDb({
    path: join(tempDir('legacy').path, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  opened.push(db);
  const insert = (sql: string, params: readonly (string | number | null)[]): number =>
    db.driver.prepare(sql).run([...params]).lastInsertRowid;
  const session = (uid: string): number =>
    insert(
      'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [uid, T0, T0, T0, T0],
    );
  const agent = (sessionId: number, uid: string, parent: number | null): number =>
    insert(
      'INSERT INTO agents (session_id, agent_uid, parent_agent_id, kind, depth, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [sessionId, uid, parent, parent === null ? 'main' : 'subagent', parent === null ? 0 : 1, T0, T0, T0, T0],
    );
  const s1 = session(S1_UID);
  const s2 = session(S2_UID);
  const main1 = agent(s1, 'main', null);
  agent(s2, 'main', null);
  const sub1 = agent(s1, 'agent-a1b2c3', main1);
  const repo = new UsageRepo(db);
  const ids: number[] = [];
  const paths: string[] = [];
  for (const spec of specs) {
    const path = join(dir, spec.name);
    writeFileSync(path, `${spec.lines.join('\n')}\n`);
    paths.push(path);
    const size = Buffer.byteLength(`${spec.lines.join('\n')}\n`);
    const sessionId = spec.session === 's1' ? s1 : s2;
    const cols = importerColumns(spec.lines);
    const id = insert(
      `INSERT INTO transcript_files (path, path_key, kind, session_uid, session_id, agent_id, birth_ms, first_seen_mtime_ms, discovered_at, updated_at,
         usage_state, tail_offset, size_seen, first_ts_in_order, max_ts_string, last_stop_legacy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?, ?, ?)`,
      [
        spec.name,
        spec.name,
        spec.kind,
        spec.session === 's1' ? S1_UID : S2_UID,
        sessionId,
        spec.kind === 'subagent' ? sub1 : null,
        spec.birth,
        spec.birth,
        T0,
        T0,
        size,
        size,
        cols.first,
        cols.max,
        cols.stop,
      ],
    );
    ids.push(id);
    withWriteTx(db, CTX, (tx) => {
      spec.lines.forEach((line, n) => {
        const parsed = TranscriptRecordShape.parse(JSON.parse(line));
        accumulateRecord(repo, CTX, tx, { fileId: id, byteOffset: n * 100 }, parsed);
      });
    });
  }
  return { db, s1, s2, ids, paths };
}

const ORACLE = `
import sys, json
sys.path.insert(0, sys.argv[1])
from backend.reader import TranscriptReader
from backend.sessions import add_usage
usages = [TranscriptReader(p).refresh().usage() for p in sys.argv[2:]]
total = None
for usage in usages:
    total = add_usage(total, usage)
print(json.dumps({'usages': usages, 'total': total}))
`;

function oracle(paths: readonly string[]): { usages: unknown[]; total: unknown } {
  const out = execFileSync('python', ['-B', '-c', ORACLE, LEGACY_SRC, ...paths], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
    encoding: 'utf8',
    windowsHide: true,
  });
  const parsed: unknown = JSON.parse(out);
  if (typeof parsed !== 'object' || parsed === null || !('usages' in parsed) || !('total' in parsed))
    throw new Error('unexpected oracle output');
  const { usages, total } = parsed;
  if (!Array.isArray(usages)) throw new Error('unexpected oracle output');
  return { usages, total };
}

describe('legacyFileUsage (02 6.5)', () => {
  it('reproduces the numbers of the design for the worked example', () => {
    const dir = tempDir('legacy-files').path;
    const loaded = load(workedExample(), dir);
    const [f1, f2, f3] = loaded.ids;
    expect(legacyFileUsage(loaded.db, CTX, f1 ?? 0)).toMatchObject({
      in: 14,
      out: 250,
      cr: 11_000,
      cc: 1000,
      turns: 5,
      models: ['<synthetic>', 'model-x'],
      complete: true,
      scanned_pct: 100,
    });
    expect(legacyFileUsage(loaded.db, CTX, f2 ?? 0)).toMatchObject({ in: 8, out: 420, cr: 1800, cc: 200, turns: 2 });
    expect(legacyFileUsage(loaded.db, CTX, f3 ?? 0)).toMatchObject({
      in: 16,
      out: 270,
      cr: 12_000,
      cc: 1500,
      turns: 2,
    });
    expect(legacyUsageTotal(loaded.db, CTX, loaded.s1)).toEqual({
      in: 22,
      out: 670,
      cr: 12_800,
      cc: 1200,
      turns: 7,
      complete: true,
    });
  });

  it('equals the legacy reader on every file and the legacy usage_total on the session (T-TK-04)', () => {
    const dir = tempDir('legacy-oracle').path;
    const loaded = load(workedExample(), dir);
    const expected = oracle(loaded.paths);
    loaded.ids.forEach((id, n) => {
      expect(legacyFileUsage(loaded.db, CTX, id), `file ${String(n + 1)}`).toEqual(expected.usages[n]);
    });
    const s1Only = oracle(loaded.paths.slice(0, 2));
    expect(legacyUsageTotal(loaded.db, CTX, loaded.s1)).toEqual(s1Only.total);
    expect(legacyUsageTotal(loaded.db, CTX, loaded.s2)).toEqual(oracle(loaded.paths.slice(2)).total);
  });

  it('reports a file whose backfill was skipped as unscanned (scanned_pct 0, skipped) and incomplete', () => {
    const dir = tempDir('legacy-skipped').path;
    const loaded = load(workedExample(), dir);
    const f2 = loaded.ids[1] ?? 0;
    loaded.db.driver.prepare("UPDATE transcript_files SET usage_state = 'skipped_backfill' WHERE id = ?").run([f2]);
    expect(legacyFileUsage(loaded.db, CTX, f2)).toMatchObject({ complete: false, scanned_pct: 0, skipped: true });
    expect(legacyUsageTotal(loaded.db, CTX, loaded.s1).complete).toBe(false);
  });

  it('computes scanned_pct from the cursors of 5.5 for a partial file', () => {
    const dir = tempDir('legacy-partial').path;
    const loaded = load(workedExample(), dir);
    const f1 = loaded.ids[0] ?? 0;
    loaded.db.driver
      .prepare(
        "UPDATE transcript_files SET usage_state = 'partial', head_end = 0, backfill_offset = 0, tail_start = 0, tail_offset = 300, size_seen = 1000, partial_bytes = 0 WHERE id = ?",
      )
      .run([f1]);
    expect(legacyFileUsage(loaded.db, CTX, f1)).toMatchObject({ complete: false, scanned_pct: 30 });
    expect('skipped' in (legacyFileUsage(loaded.db, CTX, f1) ?? {})).toBe(false);
  });

  it('an unknown file is the empty usage, an unknown session the empty total, and a foreign scope is refused', () => {
    const dir = tempDir('legacy-empty').path;
    const loaded = load(workedExample(), dir);
    expect(legacyFileUsage(loaded.db, CTX, 9999)).toBeUndefined();
    expect(legacyUsageTotal(loaded.db, CTX, 9999)).toEqual({ in: 0, out: 0, cr: 0, cc: 0, turns: 0, complete: true });
    const foreign: RepoContext = { instanceId: '22222222-2222-4222-8222-222222222222' };
    expect(() => legacyFileUsage(loaded.db, foreign, 1)).toThrow(DbError);
    expect(() => legacyUsageTotal(loaded.db, foreign, 1)).toThrow(DbError);
  });

  it('the new totals differ from the legacy ones exactly as ADR 0017 documents (iterations fallback, resume copy excluded)', () => {
    const dir = tempDir('legacy-diff').path;
    const loaded = load(workedExample(), dir);
    const legacy = legacyUsageTotal(loaded.db, CTX, loaded.s1);
    const next = aggregateSession(loaded.db, CTX, loaded.s1, 'total');
    expect([
      next.sum.input - legacy.in,
      next.sum.output - legacy.out,
      next.sum.cacheRead - legacy.cr,
      next.sum.cacheCreation - legacy.cc,
    ]).toEqual([2, 300, 959_572, 4000]);
    const s2Legacy = legacyUsageTotal(loaded.db, CTX, loaded.s2);
    const s2New = aggregateSession(loaded.db, CTX, loaded.s2, 'total');
    expect([
      s2New.sum.input - s2Legacy.in,
      s2New.sum.output - s2Legacy.out,
      s2New.sum.cacheRead - s2Legacy.cr,
      s2New.sum.cacheCreation - s2Legacy.cc,
    ]).toEqual([-10, -200, -5000, -1000]);
  });
});
