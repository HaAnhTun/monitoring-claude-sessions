// The entry index of the transcript service (03 7.2; DA-T-S-7, 8, 9): absolute and stable entry indexes and checkpoints that equal a
// sequential count, whatever the order or the size of the reads; an identity change resets the index. Every transcript is synthetic.
import { appendFileSync, mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHECKPOINT_EVERY_ENTRIES } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { DbError } from '../db/errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../db/open.ts';
import { CheckpointsRepo, type Checkpoint } from '../db/repos/checkpoints.ts';
import { TranscriptFilesRepo } from '../db/repos/transcript-files.ts';
import { countEntries } from './entries.ts';
import { TranscriptError, createEntryIndexService, type EntryIndexService } from './index-service.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX: RepoContext = { instanceId: INSTANCE_ID };
const SESSION = '55555555-5555-4555-8555-555555555555';
const T0 = FIXTURE_EPOCH_MS;
const EVERY = 5;
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

const opened: InstanceDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

interface Fixture {
  readonly db: InstanceDb;
  readonly dir: string;
  readonly files: TranscriptFilesRepo;
  readonly checkpoints: CheckpointsRepo;
  readonly service: EntryIndexService;
  /** Registers a file row for `name` in the temp folder and returns its id and path. */
  track(name: string): { id: number; path: string };
}

function fixture(options: { chunkBytes?: number; checkpointEvery?: number } = {}): Fixture {
  const dir = tempDir('entry-index').path;
  const db = openInstanceDb({
    path: join(dir, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  opened.push(db);
  let n = 0;
  return {
    db,
    dir,
    files: new TranscriptFilesRepo(db),
    checkpoints: new CheckpointsRepo(db),
    service: createEntryIndexService(db, { checkpointEvery: EVERY, ...options }),
    track(name) {
      n += 1;
      const path = join(dir, 'projects', name);
      mkdirSync(join(dir, 'projects'), { recursive: true });
      const { lastInsertRowid } = db.driver
        .prepare(
          "INSERT INTO transcript_files (path, path_key, kind, session_uid, discovered_at, updated_at) VALUES (?, ?, 'session', ?, ?, ?)",
        )
        .run([path, `${path}#${String(n)}`, SESSION, T0, T0]);
      return { id: lastInsertRowid, path };
    },
  };
}

const stamp = (n: number): string => new Date(T0 + n * 1000).toISOString();

// ---- synthetic lines: each kind yields a known number of entries -----------------------------------------------------------------

const userLine = (n: number): string =>
  JSON.stringify({ type: 'user', timestamp: stamp(n), message: { content: `FIXTURE prompt ${String(n)}` } });
/** Three entries: text, thinking and one tool call. */
const assistantLine = (n: number): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: stamp(n),
    message: {
      content: [
        { type: 'thinking', thinking: `FIXTURE thought ${String(n)}` },
        { type: 'text', text: `FIXTURE answer ${String(n)}` },
        { type: 'tool_use', id: `toolu_${String(n)}`, name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
const systemLine = (n: number): string => JSON.stringify({ type: 'system', timestamp: stamp(n), content: 'FIXTURE' });
const INVALID = '{"type":"user", FIXTURE invalid line';

/** A varied session of `n` lines: prompts, three-entry answers, records without entries and an invalid line. */
function sessionLines(n: number, first = 0): string[] {
  const lines: string[] = [];
  for (let i = first; i < first + n; i += 1) {
    if (i % 7 === 3) lines.push(systemLine(i));
    else if (i % 11 === 5) lines.push(INVALID);
    else if (i % 2 === 0) lines.push(userLine(i));
    else lines.push(assistantLine(i));
  }
  return lines;
}

function text(lines: readonly string[], eol = LF): string {
  return lines.map((line) => `${line}${eol}`).join('');
}

interface Expected {
  readonly total: number;
  readonly checkpoints: Omit<Checkpoint, 'fileId'>[];
}

/** The index of the file text computed from scratch: the rules of 03 7.2, written independently of the service. */
function reference(body: string, every = EVERY): Expected {
  const rows: Omit<Checkpoint, 'fileId'>[] = [];
  let total = 0;
  let since = 0;
  let min: number | null = null;
  let max: number | null = null;
  let at = 0;
  let current: Omit<Checkpoint, 'fileId'> | null = null;
  const close = (): void => {
    if (current !== null) rows.push({ ...current, minTs: min, maxTs: max });
  };
  for (const raw of body.split(LF).slice(0, -1)) {
    const lineStart = at;
    at += Buffer.byteLength(raw) + 1;
    const line = raw.endsWith(String.fromCharCode(13)) ? raw.slice(0, -1) : raw;
    if (line === '') continue;
    if (current === null || since >= every) {
      close();
      current = { entryIndex: total, byteOffset: current === null ? 0 : lineStart, minTs: null, maxTs: null };
      since = 0;
      min = null;
      max = null;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const n = countEntries(record);
    if (n === 0) continue;
    total += n;
    since += n;
    const ts = Date.parse((record as { timestamp: string }).timestamp);
    min = min === null ? ts : Math.min(min, ts);
    max = max === null ? ts : Math.max(max, ts);
  }
  close();
  return { total, checkpoints: rows };
}

function storedCheckpoints(f: Fixture, fileId: number): Omit<Checkpoint, 'fileId'>[] {
  return f.checkpoints
    .list(CTX, fileId, -1, 1_000_000)
    .map(({ entryIndex, byteOffset, minTs, maxTs }) => ({ entryIndex, byteOffset, minTs, maxTs }));
}

const live = (): { signal: AbortSignal } => ({ signal: new AbortController().signal });
const BUDGET = 5000;

async function indexFully(f: Fixture, fileId: number): ReturnType<EntryIndexService['ensureIndexed']> {
  return f.service.ensureIndexed(CTX, fileId, { budgetMs: BUDGET, ...live() });
}

describe('ensureIndexed', () => {
  it('counts every entry and writes the checkpoints of the sequential rules', async () => {
    const f = fixture();
    const file = f.track('a.jsonl');
    const body = text(sessionLines(60));
    writeFileSync(file.path, body);
    const result = await indexFully(f, file.id);
    const expected = reference(body);
    expect(expected.checkpoints.length).toBeGreaterThan(3);
    expect(result).toEqual({
      entriesTotal: expected.total,
      indexOffset: Buffer.byteLength(body),
      sizeBytes: Buffer.byteLength(body),
      complete: true,
      reset: false,
    });
    expect(storedCheckpoints(f, file.id)).toEqual(expected.checkpoints);
    const row = f.files.get(CTX, file.id);
    expect(row?.entriesTotal).toBe(expected.total);
    expect(row?.indexOffset).toBe(Buffer.byteLength(body));
    expect(row?.indexHeadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps every checkpoint exactly at the entries before its byte offset', async () => {
    const f = fixture();
    const file = f.track('a.jsonl');
    const lines = sessionLines(120);
    writeFileSync(file.path, text(lines));
    await indexFully(f, file.id);
    const bytes = Buffer.from(text(lines));
    for (const row of storedCheckpoints(f, file.id)) {
      const before = bytes
        .subarray(0, row.byteOffset)
        .toString('utf8')
        .split(LF)
        .filter((line) => line !== '')
        .map((line) => {
          try {
            return countEntries(JSON.parse(line));
          } catch {
            return 0;
          }
        })
        .reduce((a, b) => a + b, 0);
      expect(row.entryIndex).toBe(before);
    }
  });

  it('uses the shared checkpoint spacing by default', async () => {
    const f = fixture();
    const service = createEntryIndexService(f.db);
    const file = f.track('a.jsonl');
    writeFileSync(file.path, text(sessionLines(400)));
    await service.ensureIndexed(CTX, file.id, { budgetMs: BUDGET, ...live() });
    const rows = storedCheckpoints(f, file.id);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[1]?.entryIndex).toBeGreaterThanOrEqual(CHECKPOINT_EVERY_ENTRIES);
  });

  it('gives the same index however the file grew (DA-T-S-8)', async () => {
    const f = fixture({ chunkBytes: 300 });
    const grown = f.track('grown.jsonl');
    const once = f.track('once.jsonl');
    const lines = sessionLines(90);
    const body = text(lines);
    writeFileSync(once.path, body);
    // the importer reads head, tail and backfill; the index must not care: grow the file in odd pieces, indexing in between
    const cuts = [137, 1000, 1001, 4999, 7000, Buffer.byteLength(body)];
    const bytes = Buffer.from(body);
    writeFileSync(grown.path, '');
    let from = 0;
    for (const cut of cuts) {
      appendFileSync(grown.path, bytes.subarray(from, cut));
      from = cut;
      await indexFully(f, grown.id);
    }
    await indexFully(f, once.id);
    expect(f.files.get(CTX, grown.id)?.entriesTotal).toBe(f.files.get(CTX, once.id)?.entriesTotal);
    expect(storedCheckpoints(f, grown.id)).toEqual(storedCheckpoints(f, once.id));
    expect(storedCheckpoints(f, grown.id)).toEqual(reference(body).checkpoints);
  });

  it('does not index an unterminated last line until its LF arrives', async () => {
    const f = fixture();
    const file = f.track('a.jsonl');
    const first = text([userLine(1), userLine(2)]);
    writeFileSync(file.path, first + userLine(3));
    const partial = await indexFully(f, file.id);
    expect(partial).toMatchObject({ entriesTotal: 2, indexOffset: Buffer.byteLength(first), complete: true });
    expect(partial.sizeBytes).toBe(Buffer.byteLength(first + userLine(3)));
    appendFileSync(file.path, LF);
    expect(await indexFully(f, file.id)).toMatchObject({ entriesTotal: 3, reset: false });
  });

  it('reads lines with CRLF, blank lines and a BOM the way the tailer does', async () => {
    const f = fixture();
    const file = f.track('a.jsonl');
    const lines = [userLine(1), '', userLine(2), assistantLine(3)];
    const body = text(lines, CRLF);
    writeFileSync(file.path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]));
    const result = await indexFully(f, file.id);
    expect(result.entriesTotal).toBe(5);
    expect(storedCheckpoints(f, file.id)[0]).toMatchObject({ entryIndex: 0, byteOffset: 0 });
  });

  it('stops at the budget and resumes where it stopped', async () => {
    const f = fixture({ chunkBytes: 400 });
    const file = f.track('a.jsonl');
    const body = text(sessionLines(150));
    writeFileSync(file.path, body);
    const first = await f.service.ensureIndexed(CTX, file.id, { budgetMs: 0, ...live() });
    expect(first.complete).toBe(false);
    expect(first.indexOffset).toBeGreaterThan(0);
    expect(first.indexOffset).toBeLessThan(Buffer.byteLength(body));
    let last = first;
    for (let i = 0; i < 1000 && !last.complete; i += 1) {
      last = await f.service.ensureIndexed(CTX, file.id, { budgetMs: 0, ...live() });
    }
    expect(last.complete).toBe(true);
    expect(storedCheckpoints(f, file.id)).toEqual(reference(body).checkpoints);
    expect(last.entriesTotal).toBe(reference(body).total);
  });

  it('indexes only up to `untilBytes`, at a line start', async () => {
    const f = fixture();
    const file = f.track('a.jsonl');
    const lines = [userLine(1), userLine(2), userLine(3)];
    const body = text(lines);
    writeFileSync(file.path, body);
    const firstLine = Buffer.byteLength(lines[0] ?? '') + 1;
    const result = await f.service.ensureIndexed(CTX, file.id, {
      untilBytes: firstLine + 10,
      budgetMs: BUDGET,
      ...live(),
    });
    expect(result).toMatchObject({ entriesTotal: 1, indexOffset: firstLine, complete: true });
  });

  it('stops when the request is cancelled and keeps what it indexed', async () => {
    const f = fixture({ chunkBytes: 400 });
    const file = f.track('a.jsonl');
    writeFileSync(file.path, text(sessionLines(150)));
    const controller = new AbortController();
    controller.abort();
    const result = await f.service.ensureIndexed(CTX, file.id, { budgetMs: BUDGET, signal: controller.signal });
    expect(result.complete).toBe(false);
    expect(result.indexOffset).toBeLessThan(result.sizeBytes);
  });

  it('serialises two calls for one file and gives the sequential result', async () => {
    const f = fixture({ chunkBytes: 400 });
    const file = f.track('a.jsonl');
    const body = text(sessionLines(150));
    writeFileSync(file.path, body);
    const [a, b] = await Promise.all([indexFully(f, file.id), indexFully(f, file.id)]);
    expect(a.complete && b.complete).toBe(true);
    expect(a.entriesTotal).toBe(b.entriesTotal);
    expect(storedCheckpoints(f, file.id)).toEqual(reference(body).checkpoints);
  });

  it('continues from the stored state with a new service instance', async () => {
    const f = fixture();
    const file = f.track('a.jsonl');
    const lines = sessionLines(40);
    writeFileSync(file.path, text(lines.slice(0, 20)));
    await indexFully(f, file.id);
    appendFileSync(file.path, text(lines.slice(20)));
    const again = createEntryIndexService(f.db, { checkpointEvery: EVERY });
    const result = await again.ensureIndexed(CTX, file.id, { budgetMs: BUDGET, ...live() });
    expect(result).toMatchObject({ complete: true, reset: false, entriesTotal: reference(text(lines)).total });
    expect(storedCheckpoints(f, file.id)).toEqual(reference(text(lines)).checkpoints);
  });

  it('indexes a file that is short at first and grows past the identity head without a false reset', async () => {
    const f = fixture();
    const file = f.track('a.jsonl');
    const short = text([userLine(1)]);
    expect(Buffer.byteLength(short)).toBeLessThan(256 + 100);
    writeFileSync(file.path, short);
    await indexFully(f, file.id);
    for (let i = 2; i < 12; i += 1) {
      appendFileSync(file.path, text([userLine(i)]));
      const result = await indexFully(f, file.id);
      expect(result.reset).toBe(false);
    }
    expect(f.files.get(CTX, file.id)?.entriesTotal).toBe(11);
  });

  describe('identity (DA-T-S-9)', () => {
    it('resets the index when the file is replaced by one with another head', async () => {
      const f = fixture();
      const file = f.track('a.jsonl');
      writeFileSync(file.path, text(sessionLines(40)));
      const before = await indexFully(f, file.id);
      expect(before.entriesTotal).toBeGreaterThan(20);
      expect(storedCheckpoints(f, file.id).length).toBeGreaterThan(1);
      const replacement = text(sessionLines(45, 1000));
      writeFileSync(file.path, replacement);
      const reset = await indexFully(f, file.id);
      expect(reset).toMatchObject({ reset: true, entriesTotal: 0, indexOffset: 0 });
      expect(storedCheckpoints(f, file.id)).toEqual([]);
      expect(f.files.get(CTX, file.id)).toMatchObject({ entriesTotal: 0, indexOffset: 0 });
      const after = await indexFully(f, file.id);
      expect(after).toMatchObject({ reset: false, complete: true, entriesTotal: reference(replacement).total });
      expect(storedCheckpoints(f, file.id)).toEqual(reference(replacement).checkpoints);
    });

    it('resets the index when the file became shorter than the indexed part', async () => {
      const f = fixture();
      const file = f.track('a.jsonl');
      const body = text(sessionLines(40));
      writeFileSync(file.path, body);
      await indexFully(f, file.id);
      truncateSync(file.path, 300);
      expect(await indexFully(f, file.id)).toMatchObject({ reset: true, entriesTotal: 0 });
    });

    it('does not reset a file that only grew', async () => {
      const f = fixture();
      const file = f.track('a.jsonl');
      writeFileSync(file.path, text(sessionLines(40)));
      await indexFully(f, file.id);
      appendFileSync(file.path, text(sessionLines(10, 40)));
      expect((await indexFully(f, file.id)).reset).toBe(false);
    });
  });

  describe('refusals', () => {
    it('reports a file that is gone as transcript_gone', async () => {
      const f = fixture();
      const file = f.track('gone.jsonl');
      const error = await indexFully(f, file.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TranscriptError);
      expect((error as TranscriptError).code).toBe('transcript_gone');
    });

    it('refuses a file id that is not tracked', async () => {
      const f = fixture();
      await expect(indexFully(f, 999)).rejects.toThrow(RangeError);
    });

    it('refuses the context of another instance', async () => {
      const f = fixture();
      const file = f.track('a.jsonl');
      writeFileSync(file.path, text([userLine(1)]));
      const foreign: RepoContext = { instanceId: '22222222-2222-4222-8222-222222222222' };
      const error = await f.service
        .ensureIndexed(foreign, file.id, { budgetMs: BUDGET, ...live() })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DbError);
    });
  });
});
