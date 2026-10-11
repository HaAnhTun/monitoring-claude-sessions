// The transcript window and locate (03 7.3; DA-T-S-7, 9): ranges, the thinking filter, clips, refusals and a reference implementation that
// reads the whole file. Every transcript is synthetic.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import type { TranscriptEntry } from '@mcs/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { DbError } from '../db/errors.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../db/open.ts';
import { SessionsRepo } from '../db/repos/sessions.ts';
import { withWriteTx } from '../db/write.ts';
import { displayEntries } from './entries.ts';
import { createEntryIndexService } from './index-service.ts';
import {
  TranscriptError,
  createTranscriptWindowService,
  type TranscriptLocateRequest,
  type TranscriptWindowRequest,
  type TranscriptWindowService,
} from './window.ts';

const tempDir = useTempDirs();
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CTX: RepoContext = { instanceId: INSTANCE_ID };
const SESSION = '55555555-5555-4555-8555-555555555555';
const OTHER_SESSION = '66666666-6666-4666-8666-666666666666';
const AGENT = 'a9f8e7d6c5b4a3921';
const T0 = FIXTURE_EPOCH_MS;
const LF = String.fromCharCode(10);
const TEXT_CHARS = 6000;

const opened: InstanceDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

interface Fixture {
  readonly db: InstanceDb;
  readonly dir: string;
  readonly service: TranscriptWindowService;
  readonly mainPath: string;
  /** Creates the session row and the main file row; returns the file id. */
  main(): number;
  track(sessionUid: string, filePath: string, kind: 'session' | 'subagent', agentUid: string | null): number;
  setState(fileId: number, state: string): void;
}

function fixture(
  opts: {
    transcriptsDir?: string | null | ((dir: string) => string);
    readBudgetBytes?: number;
    chunkBytes?: number;
    checkpointEvery?: number;
  } = {},
): Fixture {
  const dir = tempDir('transcript-window').path;
  const db = openInstanceDb({
    path: join(dir, 'monitor.db'),
    expectedInstanceId: INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(T0),
  });
  opened.push(db);
  const chunkBytes = opts.chunkBytes ?? 400;
  const service = createTranscriptWindowService(db, {
    transcriptsDir:
      typeof opts.transcriptsDir === 'function' ? opts.transcriptsDir(dir) : (opts.transcriptsDir ?? null),
    defaultTextChars: TEXT_CHARS,
    index: createEntryIndexService(db, { checkpointEvery: opts.checkpointEvery ?? 5, chunkBytes }),
    chunkBytes,
    ...(opts.readBudgetBytes === undefined ? {} : { readBudgetBytes: opts.readBudgetBytes }),
  });
  const mainPath = join(dir, 'projects', `${SESSION}.jsonl`);
  mkdirSync(dirname(mainPath), { recursive: true });
  let n = 0;
  const track: Fixture['track'] = (sessionUid, filePath, kind, agentUid) => {
    n += 1;
    return db.driver
      .prepare(
        'INSERT INTO transcript_files (path, path_key, kind, session_uid, agent_uid, discovered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run([filePath, `${filePath}#${String(n)}`, kind, sessionUid, agentUid, T0, T0]).lastInsertRowid;
  };
  return {
    db,
    dir,
    service,
    mainPath,
    main() {
      withWriteTx(db, CTX, (tx) => {
        new SessionsRepo(db).ensure(CTX, tx, { sessionUid: SESSION, projectId: null, startedAt: T0 });
      });
      return track(SESSION, mainPath, 'session', null);
    },
    track,
    setState(fileId, state) {
      db.driver.prepare('UPDATE transcript_files SET state = ? WHERE id = ?').run([state, fileId]);
    },
  };
}

const stamp = (n: number): string => new Date(T0 + n * 1000).toISOString();
const userLine = (n: number, text = `FIXTURE prompt ${String(n)}`): string =>
  JSON.stringify({ type: 'user', timestamp: stamp(n), message: { content: text } });
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

const text = (lines: readonly string[]): string => lines.map((line) => `${line}${LF}`).join('');

/** Every entry of the file in order, read with no index at all: the reference of the tests. */
function allEntries(lines: readonly string[]): {
  entries: TranscriptEntry[];
  lineStarts: { at: number; first: number }[];
} {
  const entries: TranscriptEntry[] = [];
  const lineStarts: { at: number; first: number }[] = [];
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
    lineStarts.push({ at: start, first: entries.length });
    for (const entry of produced) entries.push({ i: entries.length, ...entry });
  }
  return { entries, lineStarts };
}

const live = (): AbortSignal => new AbortController().signal;
const windowQuery = (over: Partial<TranscriptWindowRequest> = {}): TranscriptWindowRequest => ({
  sessionId: SESSION,
  agent: 'main',
  after: -1,
  ...over,
});
const locateQuery = (over: Partial<TranscriptLocateRequest>): TranscriptLocateRequest => ({
  sessionId: SESSION,
  agent: 'main',
  ...over,
});

async function refusal(run: Promise<unknown>): Promise<string> {
  const error = await run.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TranscriptError);
  return (error as TranscriptError).code;
}

function seeded(lines: readonly string[]): Fixture & { fileId: number } {
  const f = fixture();
  const fileId = f.main();
  writeFileSync(f.mainPath, text(lines));
  return Object.assign(f, { fileId });
}

describe('window ranges (03 7.3 step 3)', () => {
  const lines = sessionLines(80);
  const { entries } = allEntries(lines);
  const total = entries.length;
  const visible = (from: number, to: number): TranscriptEntry[] =>
    entries.slice(from, to).filter((e) => e.k !== 'think');

  it('has a file with enough entries', () => {
    expect(total).toBeGreaterThan(100);
  });

  it('returns the tail without `after`, in the legacy shape', async () => {
    const f = seeded(lines);
    const response = await f.service.read(CTX, windowQuery({ limit: 20, thinking: true }), live());
    expect(response).toMatchObject({
      sessionId: SESSION,
      agentId: 'main',
      total,
      base: 0,
      from: total - 20,
      next: total,
      partial: false,
      skippedBytes: 0,
      pendingBytes: 0,
      fileState: 'active',
    });
    expect(response.asOfSeq).toBe(f.db.headSeq());
    expect(response.events).toEqual(entries.slice(total - 20));
  });

  it('defaults the tail to 250 entries and `after` to 2000', async () => {
    const f = seeded(sessionLines(400));
    const all = allEntries(sessionLines(400)).entries;
    const tail = await f.service.read(CTX, windowQuery({ thinking: true }), live());
    expect(tail.events).toHaveLength(250);
    expect(tail.from).toBe(all.length - 250);
    const head = await f.service.read(CTX, windowQuery({ after: 0, thinking: true }), live());
    expect(head.events).toHaveLength(all.length);
    expect(head.from).toBe(0);
    expect(head.next).toBe(all.length);
  });

  it('leaves out thinking entries unless asked, keeping the absolute indexes', async () => {
    const f = seeded(lines);
    const without = await f.service.read(CTX, windowQuery({ after: 10, limit: 30 }), live());
    expect(without.events).toEqual(visible(10, 40));
    expect(without.events.some((e) => e.k === 'think')).toBe(false);
    expect(without.next).toBe(40);
    const withThinking = await f.service.read(CTX, windowQuery({ after: 10, limit: 30, thinking: true }), live());
    expect(withThinking.events).toEqual(entries.slice(10, 40));
  });

  it('answers `before` with the entries just below it', async () => {
    const f = seeded(lines);
    const response = await f.service.read(CTX, windowQuery({ before: 50, limit: 12, thinking: true }), live());
    expect(response).toMatchObject({ from: 38, next: 50, total });
    expect(response.events).toEqual(entries.slice(38, 50));
    const clamped = await f.service.read(CTX, windowQuery({ before: 5, limit: 12, thinking: true }), live());
    expect(clamped).toMatchObject({ from: 0, next: 5 });
    const beyond = await f.service.read(CTX, windowQuery({ before: total + 500, limit: 3, thinking: true }), live());
    expect(beyond).toMatchObject({ from: total - 3, next: total });
  });

  it('lets `before` win over `after`', async () => {
    const f = seeded(lines);
    const response = await f.service.read(
      CTX,
      windowQuery({ before: 20, after: 100, limit: 5, thinking: true }),
      live(),
    );
    expect(response.events).toEqual(entries.slice(15, 20));
  });

  it('answers `after` past the end with an empty window at the end', async () => {
    const f = seeded(lines);
    const response = await f.service.read(CTX, windowQuery({ after: total + 40, thinking: true }), live());
    expect(response).toMatchObject({ total, from: total, next: total, events: [] });
  });

  it('equals the reference for every kind of range over the whole file', async () => {
    const f = seeded(lines);
    for (const after of [-1, 0, 1, 4, 5, 6, 37, total - 1]) {
      for (const limit of [1, 2, 7, 64]) {
        const response = await f.service.read(CTX, windowQuery({ after, limit, thinking: true }), live());
        const start = after < 0 ? Math.max(0, total - limit) : Math.min(after, total);
        const end = after < 0 ? total : Math.min(total, start + limit);
        expect(response.events, `after ${String(after)} limit ${String(limit)}`).toEqual(entries.slice(start, end));
        expect([response.from, response.next]).toEqual([start, end]);
      }
    }
  });

  it('clips the text of entries to `textChars`', async () => {
    const f = fixture();
    f.main();
    writeFileSync(f.mainPath, text([userLine(1, 'x'.repeat(500))]));
    const response = await f.service.read(CTX, windowQuery({ textChars: 200 }), live());
    expect(response.events[0]?.text).toBe(`${'x'.repeat(200)} ... [truncated 300 chars]`);
  });

  it('reports bytes that are not indexed yet as pending and the window as partial', async () => {
    const f = seeded(lines);
    appendFileSync(f.mainPath, userLine(900));
    const response = await f.service.read(CTX, windowQuery({ limit: 5, thinking: true }), live());
    expect(response.total).toBe(total);
    expect(response.pendingBytes).toBe(Buffer.byteLength(userLine(900)));
    expect(response.partial).toBe(true);
    appendFileSync(f.mainPath, LF);
    const done = await f.service.read(CTX, windowQuery({ limit: 5, thinking: true }), live());
    expect(done).toMatchObject({ total: total + 1, pendingBytes: 0, partial: false });
  });

  it('returns what it collected when the read budget after the checkpoint is used up', async () => {
    const f = fixture({ readBudgetBytes: 1 });
    f.main();
    writeFileSync(f.mainPath, text(lines));
    const response = await f.service.read(CTX, windowQuery({ after: 0, limit: 50, thinking: true }), live());
    expect(response.total).toBe(total);
    expect(response.events.length).toBeLessThan(50);
    expect(response.next).toBe(response.events.length === 0 ? 0 : (response.events.at(-1)?.i ?? 0) + 1);
  });
});

describe('read budget (03 7.3 step 4): the way to the first wanted entry is not counted', () => {
  // few checkpoints and a small budget: the bytes between the checkpoint and the wanted entry exceed the budget many times
  const big = (n: number, size: number): string => userLine(n, `${String(n)} ${'x'.repeat(size)}`);
  const lines: string[] = [];
  for (let n = 0; n < 40; n += 1) lines.push(n === 20 ? big(n, 5000) : big(n, 300));
  const { entries, lineStarts } = allEntries(lines);
  const total = entries.length;
  const small = { checkpointEvery: 1000, readBudgetBytes: 1000, chunkBytes: 400 };

  function sparse(): Fixture {
    const f = fixture(small);
    f.main();
    writeFileSync(f.mainPath, text(lines));
    return f;
  }

  /** Pages with `limit` entries from `start` on until the end; fails when a call does not advance. */
  async function pageForward(f: Fixture, start: number, limit: number): Promise<TranscriptEntry[]> {
    const got: TranscriptEntry[] = [];
    let after = start;
    for (let calls = 0; after < total; calls += 1) {
      expect(calls, 'paging does not terminate').toBeLessThan(total + 5);
      const response = await f.service.read(CTX, windowQuery({ after, limit, thinking: true }), live());
      expect(response.next, `no progress at ${String(after)}`).toBeGreaterThan(after);
      expect(response.total).toBe(total);
      got.push(...response.events);
      after = response.next;
    }
    return got;
  }

  it('pages from after=0 over the whole file and equals the reference', async () => {
    expect(await pageForward(sparse(), 0, 7)).toEqual(entries);
  });

  it('pages from the tail position over the rest and equals the reference', async () => {
    const f = sparse();
    const tail = await f.service.read(CTX, windowQuery({ limit: 5, thinking: true }), live());
    // the budget may cut the tail window short after its first entries; what it returns is a prefix that advances
    expect(tail.events.length).toBeGreaterThan(0);
    expect(tail.events).toEqual(entries.slice(tail.from, tail.from + tail.events.length));
    expect(tail.from).toBe(total - 5);
    expect(tail.next).toBeGreaterThan(tail.from);
    expect(await pageForward(f, total - 12, 4)).toEqual(entries.slice(total - 12));
  });

  it('returns the first wanted entry even when one line is larger than the budget (the middle line)', async () => {
    const f = sparse();
    const response = await f.service.read(CTX, windowQuery({ after: 20, limit: 3, thinking: true }), live());
    expect(response.events[0]).toEqual(entries[20]);
    expect(response.next).toBeGreaterThan(20);
    expect(await pageForward(f, 19, 2)).toEqual(entries.slice(19));
  });

  it('locates by i, ts and offset past the budget, exactly as the reference does', async () => {
    const f = sparse();
    for (const i of [0, 19, 20, 21, 33, total - 1]) {
      const response = await f.service.locate(CTX, locateQuery({ i }), live());
      expect(response, `i ${String(i)}`).toEqual({ i, t: entries[i]?.t, base: 0, total });
      const byTs = await f.service.locate(CTX, locateQuery({ ts: entries[i]?.t ?? '' }), live());
      expect(byTs.i, `ts of ${String(i)}`).toBe(entries.findIndex((entry) => entry.t >= (entries[i]?.t ?? '')));
    }
    for (const line of [lineStarts[21], lineStarts[30], lineStarts[total - 1]]) {
      const response = await f.service.locate(CTX, locateQuery({ offset: line?.at ?? 0 }), live());
      expect(response.i, `offset ${String(line?.at)}`).toBe(line?.first);
    }
  });
});

describe('read budget with the production sizes', () => {
  it('answers the tail, a later page and a locate in a file of 40 lines of 300 KB (12 MB, budget 8 MiB)', async () => {
    const f = fixture({ chunkBytes: 1024 * 1024, checkpointEvery: 256, readBudgetBytes: 8 * 1024 * 1024 });
    f.main();
    const lines = Array.from({ length: 40 }, (_unused, n) => userLine(n, `${String(n)} ${'y'.repeat(300_000)}`));
    writeFileSync(f.mainPath, text(lines));
    const tail = await f.service.read(CTX, windowQuery({ limit: 5 }), live());
    expect(tail).toMatchObject({ total: 40, from: 35 });
    expect(tail.events.map((event) => event.i)).toEqual([35, 36, 37, 38, 39]);
    const page = await f.service.read(CTX, windowQuery({ after: 20, limit: 10 }), live());
    expect(page.events.map((event) => event.i)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect((await f.service.locate(CTX, locateQuery({ i: 38 }), live())).i).toBe(38);
    expect((await f.service.locate(CTX, locateQuery({ ts: stamp(37) }), live())).i).toBe(37);
  });
});

describe('index reset (DA-T-S-9)', () => {
  it('answers total 0 for a replaced file and the new content once it is indexed', async () => {
    const f = seeded(sessionLines(60));
    const before = await f.service.read(CTX, windowQuery({ limit: 5 }), live());
    expect(before.total).toBeGreaterThan(50);
    const replacement = sessionLines(30, 1000);
    writeFileSync(f.mainPath, text(replacement));
    const reset = await f.service.read(CTX, windowQuery({ limit: 5 }), live());
    expect(reset).toMatchObject({ total: 0, from: 0, next: 0, events: [] });
    const after = await f.service.read(CTX, windowQuery({ limit: 1000, thinking: true }), live());
    expect(after.events).toEqual(allEntries(replacement).entries);
  });
});

describe('refusals', () => {
  it('knows no session', async () => {
    const f = seeded(sessionLines(5));
    expect(await refusal(f.service.read(CTX, windowQuery({ sessionId: OTHER_SESSION }), live()))).toBe(
      'session_not_found',
    );
  });

  it('knows no such agent', async () => {
    const f = seeded(sessionLines(5));
    expect(await refusal(f.service.read(CTX, windowQuery({ agent: AGENT }), live()))).toBe('agent_not_found');
  });

  it('knows no main file for a session without a transcript', async () => {
    const f = fixture();
    f.main();
    f.db.driver.prepare('DELETE FROM transcript_files').run([]);
    expect(await refusal(f.service.read(CTX, windowQuery(), live()))).toBe('agent_not_found');
  });

  it('answers a missing file as gone, by its state and by the disk', async () => {
    const f = seeded(sessionLines(5));
    f.setState(f.fileId, 'missing');
    expect(await refusal(f.service.read(CTX, windowQuery(), live()))).toBe('transcript_gone');
    f.setState(f.fileId, 'active');
    rmSync(f.mainPath);
    expect(await refusal(f.service.read(CTX, windowQuery(), live()))).toBe('transcript_gone');
    expect(await refusal(f.service.locate(CTX, locateQuery({ i: 0 }), live()))).toBe('transcript_gone');
  });

  it('refuses a file outside the transcripts folder', async () => {
    const elsewhere = tempDir('elsewhere').path;
    const f = fixture({ transcriptsDir: elsewhere });
    f.main();
    writeFileSync(f.mainPath, text(sessionLines(5)));
    expect(await refusal(f.service.read(CTX, windowQuery(), live()))).toBe('transcript_gone');
    expect(await refusal(f.service.locate(CTX, locateQuery({ i: 0 }), live()))).toBe('transcript_gone');
  });

  it('accepts a file inside the configured transcripts folder', async () => {
    const f = fixture({ transcriptsDir: (dir) => join(dir, 'projects') });
    f.main();
    writeFileSync(f.mainPath, text(sessionLines(5)));
    expect((await f.service.read(CTX, windowQuery(), live())).total).toBeGreaterThan(0);
  });

  it('stops when the request is cancelled', async () => {
    const f = seeded(sessionLines(20));
    const controller = new AbortController();
    controller.abort();
    expect(await refusal(f.service.read(CTX, windowQuery(), controller.signal))).toBe('aborted');
  });

  it('refuses the context of another instance', async () => {
    const f = seeded(sessionLines(5));
    const foreign: RepoContext = { instanceId: '22222222-2222-4222-8222-222222222222' };
    const error = await f.service.read(foreign, windowQuery(), live()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
  });
});

describe('subagent files', () => {
  it('reads the file of the agent of the session', async () => {
    const f = seeded(sessionLines(10));
    const agentPath = join(f.dir, 'projects', SESSION, 'subagents', `agent-${AGENT}.jsonl`);
    mkdirSync(dirname(agentPath), { recursive: true });
    const agentLines = [userLine(500, 'FIXTURE subagent prompt'), assistantLine(501)];
    writeFileSync(agentPath, text(agentLines));
    f.track(SESSION, agentPath, 'subagent', AGENT);
    const response = await f.service.read(CTX, windowQuery({ agent: AGENT, thinking: true }), live());
    expect(response).toMatchObject({ agentId: AGENT, total: 4 });
    expect(response.events).toEqual(allEntries(agentLines).entries);
  });
});

describe('locate (03 7.3)', () => {
  const lines = sessionLines(80);
  const { entries, lineStarts } = allEntries(lines);
  const total = entries.length;

  it('clamps `i` into the file', async () => {
    const f = seeded(lines);
    expect(await f.service.locate(CTX, locateQuery({ i: 17 }), live())).toEqual({
      i: 17,
      t: entries[17]?.t,
      base: 0,
      total,
    });
    expect((await f.service.locate(CTX, locateQuery({ i: -50 }), live())).i).toBe(0);
    expect(await f.service.locate(CTX, locateQuery({ i: total + 50 }), live())).toEqual({
      i: total - 1,
      t: entries[total - 1]?.t,
      base: 0,
      total,
    });
  });

  it('finds the first entry whose time is at or after `ts`, else the last', async () => {
    const f = seeded(lines);
    for (const second of [0, 1, 2, 9, 31, 56, 79]) {
      const ts = new Date(T0 + second * 1000).toISOString();
      const expected = entries.findIndex((entry) => entry.t >= ts);
      const response = await f.service.locate(CTX, locateQuery({ ts }), live());
      expect(response.i, `second ${String(second)}`).toBe(expected);
      expect(response.t).toBe(entries[expected]?.t);
    }
    const late = await f.service.locate(CTX, locateQuery({ ts: new Date(T0 + 10_000_000).toISOString() }), live());
    expect(late).toEqual({ i: total - 1, t: entries[total - 1]?.t, base: 0, total });
    const early = await f.service.locate(CTX, locateQuery({ ts: new Date(T0 - 10_000_000).toISOString() }), live());
    expect(early.i).toBe(0);
  });

  it('finds the first entry produced at or after the line that starts at a byte offset', async () => {
    const f = seeded(lines);
    const bytes = text(lines);
    const probes = [0, 1, 5, 120, 640, 1999, 3000, Buffer.byteLength(bytes) - 1, Buffer.byteLength(bytes) + 500];
    for (const offset of probes) {
      const line = lineStarts.find((candidate) => candidate.at >= offset);
      const expected = line === undefined ? total - 1 : line.first;
      const response = await f.service.locate(CTX, locateQuery({ offset }), live());
      expect(response.i, `offset ${String(offset)}`).toBe(expected);
      expect(response.t).toBe(entries[expected]?.t);
    }
  });

  it('answers event_not_found for a file without entries', async () => {
    const f = seeded([systemLine(1), INVALID]);
    expect(await refusal(f.service.locate(CTX, locateQuery({ i: 0 }), live()))).toBe('event_not_found');
    expect(await refusal(f.service.locate(CTX, locateQuery({ ts: stamp(1) }), live()))).toBe('event_not_found');
  });

  it('answers event_not_found right after the file was replaced', async () => {
    const f = seeded(lines);
    await f.service.locate(CTX, locateQuery({ i: 0 }), live());
    writeFileSync(f.mainPath, text(sessionLines(10, 2000)));
    expect(await refusal(f.service.locate(CTX, locateQuery({ i: 0 }), live()))).toBe('event_not_found');
  });
});
