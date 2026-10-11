// DA-T-S-7, 8, 9 over a real database, the real query layer (`createQueries`), real files and the production chunk size and checkpoint
// spacing: window and locate equal a reference that reads the whole file; the index does not depend on the order in which the
// importer read the file; a replaced file resets the index. Every transcript is synthetic.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHECKPOINT_EVERY_ENTRIES, type TranscriptEntry } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, TranscriptBuilder, bigTranscript, useTempDirs } from '@mcs/testkit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { resolveConfig, type ResolvedConfig } from '../src/config/resolve.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../src/db/open.ts';
import { CheckpointsRepo } from '../src/db/repos/checkpoints.ts';
import { createQueries, type Queries } from '../src/query/index.ts';
import { displayEntries } from '../src/transcript/entries.ts';
import { SENTINEL } from './fixtures/transcripts.ts';
import { Prng, seedFromEnv } from './support/prng.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX: RepoContext = { instanceId: INSTANCE_ID };
const SESSION = '55555555-5555-4555-8555-555555555555';
const T0 = FIXTURE_EPOCH_MS;
const LF = String.fromCharCode(10);
const TEXT_CHARS = 6000;
const SEED = seedFromEnv(process.env, 20261012);

let config: ResolvedConfig;
beforeAll(async () => {
  config = await resolveConfig({ workspace: null, env: {}, cli: {}, skillDir: defaultSkillDir() });
});

const opened: InstanceDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

interface Instance {
  readonly db: InstanceDb;
  readonly dir: string;
  readonly queries: Queries;
  readonly transcript: string;
  readonly fileId: number;
}

function instance(): Instance {
  const dir = tempDir('transcript-int').path;
  const clock = new FakeClock(T0);
  const db = openInstanceDb({
    path: join(dir, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  opened.push(db);
  const transcript = join(dir, 'projects', `${SESSION}.jsonl`);
  db.driver
    .prepare(
      'INSERT INTO sessions (session_uid, first_seen_at, started_at, last_activity_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run([SESSION, T0, T0, T0, T0]);
  const fileId = db.driver
    .prepare(
      "INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at) VALUES (?, ?, 'session', ?, ?, ?)",
    )
    .run([transcript, transcript, SESSION, T0, T0]).lastInsertRowid;
  const queries = createQueries(db, {
    config,
    now: () => clock.now(),
    audit: { entriesBetween: () => Promise.resolve([]) },
  });
  return { db, dir, queries, transcript, fileId };
}

/** A session of a few MiB with prompts, answers, thinking, tool calls, failures, bookkeeping records and an invalid line. */
function bigSession(targetBytes: number): TranscriptBuilder {
  const b = bigTranscript({ sessionId: SESSION, targetBytes });
  for (let i = 0; i < 40; i += 1) {
    const ok = b.toolUse('Bash', { command: `echo FIXTURE ${String(i)}` });
    b.toolResult(ok, { content: `FIXTURE out ${String(i)}` });
    const failing = b.toolUse('Read', { file_path: `FIXTURE/f${String(i)}.txt` });
    b.toolResult(failing, { isError: true, content: 'FIXTURE failure' });
    if (i % 9 === 0) b.invalidLine();
    if (i % 5 === 0) b.bookkeeping('queue-operation');
  }
  b.turnEnd();
  return b;
}

/** Everything the file says, read sequentially with no index: the reference of the tests. */
function reference(lines: readonly string[]): {
  entries: TranscriptEntry[];
  firstOf: { at: number; first: number }[];
} {
  const entries: TranscriptEntry[] = [];
  const firstOf: { at: number; first: number }[] = [];
  let at = 0;
  for (const line of lines) {
    const start = at;
    at += Buffer.byteLength(line) + 1;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const produced = displayEntries(record, { textChars: TEXT_CHARS });
    if (produced.length === 0) continue;
    firstOf.push({ at: start, first: entries.length });
    for (const entry of produced) entries.push({ i: entries.length, ...entry });
  }
  return { entries, firstOf };
}

const live = (): AbortSignal => new AbortController().signal;
const windowOf = (
  i: Instance,
  over: { after?: number; before?: number; limit?: number; thinking?: true; textChars?: number },
): ReturnType<Queries['window']> =>
  i.queries.window(CTX, { sessionId: SESSION, agent: 'main', after: -1, ...over }, live());

describe('window and locate against a reference that reads the whole file (DA-T-S-7)', () => {
  it('equal it at random positions of a file of several MiB', async () => {
    const i = instance();
    const b = bigSession(3 * 1024 * 1024);
    const lines = b.lines();
    b.write(i.transcript);
    const { entries, firstOf } = reference(lines);
    const total = entries.length;
    expect(total).toBeGreaterThan(CHECKPOINT_EVERY_ENTRIES * 8);
    const prng = new Prng(SEED);

    const tail = await windowOf(i, { limit: 100, thinking: true });
    expect(tail).toMatchObject({ total, from: total - 100, next: total, pendingBytes: 0, partial: false });
    expect(tail.events).toEqual(entries.slice(total - 100));

    for (let round = 0; round < 40; round += 1) {
      const limit = prng.range(1, 400);
      const at = prng.int(total);
      const mode = prng.pick(['after', 'before'] as const);
      const response =
        mode === 'after'
          ? await windowOf(i, { after: at, limit, thinking: true })
          : await windowOf(i, { before: at, limit, thinking: true });
      const start = mode === 'after' ? at : Math.max(0, at - limit);
      const end = mode === 'after' ? Math.min(total, at + limit) : at;
      expect(response.events, `seed ${String(SEED)} ${mode} ${String(at)} limit ${String(limit)}`).toEqual(
        entries.slice(start, end),
      );
      expect([response.from, response.next]).toEqual([start, end]);
    }

    for (let round = 0; round < 25; round += 1) {
      const at = prng.int(total);
      const found = await i.queries.locate(CTX, { sessionId: SESSION, agent: 'main', i: at }, live());
      expect(found, `seed ${String(SEED)} i ${String(at)}`).toEqual({ i: at, t: entries[at]?.t, base: 0, total });
    }
    for (let round = 0; round < 25; round += 1) {
      const wanted = entries[prng.int(total)]?.t ?? '';
      const ts = new Date(Date.parse(wanted) + prng.range(-1500, 1500)).toISOString();
      const expected = entries.findIndex((entry) => entry.t >= ts);
      const found = await i.queries.locate(CTX, { sessionId: SESSION, agent: 'main', ts }, live());
      expect(found.i, `seed ${String(SEED)} ts ${ts}`).toBe(expected < 0 ? total - 1 : expected);
    }
    const size = readFileSync(i.transcript).length;
    for (let round = 0; round < 25; round += 1) {
      const offset = prng.int(size + 100);
      const line = firstOf.find((candidate) => candidate.at >= offset);
      const found = await i.queries.locate(CTX, { sessionId: SESSION, agent: 'main', offset }, live());
      expect(found.i, `seed ${String(SEED)} offset ${String(offset)}`).toBe(
        line === undefined ? total - 1 : line.first,
      );
    }
  });

  it('keeps every checkpoint at the entries before its byte offset', async () => {
    const i = instance();
    const b = bigSession(2 * 1024 * 1024);
    b.write(i.transcript);
    await windowOf(i, { limit: 1 });
    const { entries, firstOf } = reference(b.lines());
    const rows = new CheckpointsRepo(i.db).list(CTX, i.fileId, -1, 1_000_000);
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      const line = firstOf.find((candidate) => candidate.at >= row.byteOffset);
      expect(row.entryIndex).toBe(line === undefined ? entries.length : line.first);
    }
  });
});

describe('independent of the import order (DA-T-S-8)', () => {
  it('counts the same whatever the importer cursors say and however the file grew', async () => {
    const i = instance();
    const b = bigSession(1.5 * 1024 * 1024);
    const lines = b.lines();
    const bytes = Buffer.from(lines.map((line) => `${line}${LF}`).join(''));
    const { entries } = reference(lines);
    const prng = new Prng(SEED + 1);

    // the importer reads head, tail, then backfill: its cursors are not a prefix of the file; the index must not look at them
    mkdirSync(join(i.dir, 'projects'), { recursive: true });
    writeFileSync(i.transcript, '');
    let written = 0;
    while (written < bytes.length) {
      const piece = Math.min(bytes.length - written, prng.range(1, 400_000));
      appendFileSync(i.transcript, bytes.subarray(written, written + piece));
      written += piece;
      const tailStart = Math.floor(written * 0.7);
      i.db.driver
        .prepare(
          'UPDATE transcript_files SET head_end = 100, backfill_offset = 100, tail_start = ?, tail_offset = ?, size_seen = ? WHERE id = ?',
        )
        .run([tailStart, written, written, i.fileId]);
      const response = await windowOf(i, { limit: 1 });
      expect(response.pendingBytes).toBeGreaterThanOrEqual(0);
    }
    const done = await windowOf(i, { after: 0, limit: 2000, thinking: true });
    expect(done).toMatchObject({ total: entries.length, pendingBytes: 0 });
    expect(done.events).toEqual(entries.slice(0, 2000));
    const last = await windowOf(i, { limit: 50, thinking: true });
    expect(last.events).toEqual(entries.slice(-50));
  });
});

describe('file replacement (DA-T-S-9)', () => {
  it('answers total 0 for the replaced file, drops its checkpoints and then serves the new one', async () => {
    const i = instance();
    const first = bigSession(600 * 1024);
    first.write(i.transcript);
    const before = await windowOf(i, { limit: 5 });
    expect(before.total).toBeGreaterThan(CHECKPOINT_EVERY_ENTRIES);
    expect(new CheckpointsRepo(i.db).count(CTX, i.fileId)).toBeGreaterThan(1);

    const other = new TranscriptBuilder({ sessionId: SESSION, cwd: 'FIXTURE/other', startMs: T0 + 5_000_000 });
    other.user('FIXTURE replacement prompt');
    other.assistant({ messageId: 'msg_fixture_replacement', text: 'FIXTURE replacement answer' });
    other.write(i.transcript);
    const reset = await windowOf(i, { limit: 5 });
    expect(reset).toMatchObject({ total: 0, from: 0, next: 0, events: [] });
    expect(new CheckpointsRepo(i.db).count(CTX, i.fileId)).toBe(0);
    expect(await windowOf(i, { thinking: true })).toMatchObject({ total: 2 });
    expect(new CheckpointsRepo(i.db).count(CTX, i.fileId)).toBe(1);
  });
});

describe('privacy (ADR 0016)', () => {
  it('leaves no transcript text in the database files after reading windows', async () => {
    const i = instance();
    const b = new TranscriptBuilder({ sessionId: SESSION, cwd: 'FIXTURE/privacy', startMs: T0 });
    b.user(SENTINEL.prompt);
    b.assistant({ messageId: 'msg_fixture_privacy', text: SENTINEL.assistant });
    const use = b.toolUse('Bash', { command: SENTINEL.toolInput });
    b.toolResult(use, { content: SENTINEL.toolResult });
    b.write(i.transcript);
    const window = await windowOf(i, { limit: 50, thinking: true });
    expect(JSON.stringify(window)).toContain(SENTINEL.prompt);
    expect(JSON.stringify(window)).toContain(SENTINEL.toolResult);
    i.db.driver.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all([]);
    for (const name of ['monitor.db', 'monitor.db-wal']) {
      let bytes: string;
      try {
        bytes = readFileSync(join(i.dir, name)).toString('latin1');
      } catch {
        continue;
      }
      for (const text of [SENTINEL.prompt, SENTINEL.assistant, SENTINEL.toolInput, SENTINEL.toolResult]) {
        expect(bytes.includes(text), `${name} holds ${text}`).toBe(false);
      }
    }
  });
});
