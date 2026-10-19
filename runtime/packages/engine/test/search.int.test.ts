// Transcript content search over real databases and real files (03 7.4, 19.5): coverage honesty (DA-T-S-1), the legacy rules
// against a naive full-parse reference (DA-T-S-2), path containment (DA-T-S-4), event-loop slices (DA-T-S-5), cancellation and the
// two slots (DA-T-S-6), and instance isolation (DA-T-S-10, engine part). Every transcript is synthetic.
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import type { EntryKind, InstanceSearchQuery, TranscriptSearchQuery } from '@mcs/shared';
import { FIXTURE_EPOCH_MS, FakeClock, makeJunction, useTempDirs } from '@mcs/testkit';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSkillDir } from '../src/config/defaults.ts';
import { resolveConfig, type ResolvedConfig } from '../src/config/resolve.ts';
import { openInstanceDb, type InstanceDb, type RepoContext } from '../src/db/open.ts';
import { createQueries } from '../src/query/index.ts';
import type { QueryDeps } from '../src/runtime/context.ts';
import {
  SearchBusyError,
  createSearchService,
  type SearchService,
  type SearchServiceOptions,
} from '../src/search/service.ts';
import { displayEntries } from '../src/transcript/entries.ts';
import { createEntryIndexService, type EntryIndexService } from '../src/transcript/index-service.ts';
import { Prng, seedFromEnv } from './support/prng.ts';

const tempDir = useTempDirs();
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const T0 = FIXTURE_EPOCH_MS;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SEED = seedFromEnv(process.env, 20261020);
const BACKSLASH = String.fromCharCode(92);
const MIB = 1024 * 1024;
const E_ACUTE = String.fromCodePoint(0xe9);
const EMOJI = String.fromCodePoint(0x1f600);

let config: ResolvedConfig;
beforeAll(async () => {
  config = await resolveConfig({ workspace: null, env: {}, cli: {}, skillDir: defaultSkillDir() });
});

// `transcripts_dir: auto` discovers the project folder below the Claude home of the environment: point that home at an empty
// folder, so the real home of the machine is never read and the folder of the main transcript stays the containment root.
beforeEach(() => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir('claude-home').path);
});

const opened: InstanceDb[] = [];
const links: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  // a link is removed on its own, never with the tree around it (it could lead out of the temp folder)
  for (const link of links.splice(0)) {
    try {
      unlinkSync(link);
    } catch {
      try {
        rmdirSync(link);
      } catch {
        // already gone
      }
    }
  }
});

// ---- the instance -------------------------------------------------------------------------------------------------------------

interface Env {
  readonly db: InstanceDb;
  readonly ctx: RepoContext;
  readonly dir: string;
  readonly root: string;
  readonly clock: FakeClock;
  readonly deps: QueryDeps;
}

function makeEnv(instanceId = ID_A): Env {
  const dir = tempDir('search-int').path;
  const clock = new FakeClock(T0);
  const db = openInstanceDb({
    path: join(dir, 'monitor.db'),
    expectedInstanceId: instanceId,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock,
  });
  opened.push(db);
  const root = join(dir, 'projects');
  mkdirSync(root, { recursive: true });
  return {
    db,
    ctx: { instanceId },
    dir,
    root,
    clock,
    deps: { config, now: () => clock.now(), audit: { entriesBetween: () => Promise.resolve([]) } },
  };
}

const uidOf = (n: number): string => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface Added {
  readonly uid: string;
  readonly label: string;
  readonly mainPath: string;
  readonly mainId: number;
}

function addSession(env: Env, n: number, over: { ageMs?: number; mainPath?: string } = {}): Added {
  const uid = uidOf(n);
  const label = `session ${String(n)}`;
  const at = T0 - (over.ageMs ?? n * MINUTE);
  env.db.driver
    .prepare(
      `INSERT INTO sessions (session_uid, label, matched, first_seen_at, started_at, last_activity_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
    )
    .run([uid, label, at - HOUR, at - HOUR, at, at]);
  const mainPath = over.mainPath ?? join(env.root, `${uid}.jsonl`);
  const mainId = insertFile(env, mainPath, 'session', uid, null);
  return { uid, label, mainPath, mainId };
}

function insertFile(
  env: Env,
  path: string,
  kind: 'session' | 'subagent',
  sessionUid: string,
  agentUid: string | null,
): number {
  return env.db.driver
    .prepare(
      `INSERT INTO transcript_files (path, path_key, kind, session_uid, agent_uid, discovered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run([path, path, kind, sessionUid, agentUid, T0, T0]).lastInsertRowid;
}

function addAgent(env: Env, session: Added, agent: string): { path: string; fileId: number } {
  const path = join(env.root, session.uid, 'subagents', `agent-${agent}.jsonl`);
  return { path, fileId: insertFile(env, path, 'subagent', session.uid, agent) };
}

/** Writes a file and tells the database how big it is (`size_seen` is what the importer would have said). */
function writeLines(env: Env, path: string, lines: readonly string[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const text = lines.map((line) => `${line}\n`).join('');
  writeFileSync(path, text);
  env.db.driver
    .prepare('UPDATE transcript_files SET size_seen = ? WHERE path = ?')
    .run([Buffer.byteLength(text), path]);
}

const user = (text: string): Record<string, unknown> => ({
  type: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: { role: 'user', content: text },
});
const say = (text: string): Record<string, unknown> => ({
  type: 'assistant',
  timestamp: '2026-01-01T00:00:01.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const toolUse = (id: string, name: string, input: Record<string, unknown>): Record<string, unknown> => ({
  type: 'assistant',
  timestamp: '2026-01-01T00:00:02.000Z',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, content: unknown, isError: boolean): Record<string, unknown> => ({
  type: 'user',
  timestamp: '2026-01-01T00:00:03.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});

/** One prompt per text. */
function prompts(...texts: string[]): string[] {
  return texts.map((text) => JSON.stringify(user(text)));
}

function serviceOf(env: Env, over: Partial<SearchServiceOptions> = {}): SearchService {
  return createSearchService(env.db, {
    deps: env.deps,
    roots: () => Promise.resolve(env.root),
    chunkBytes: 4096,
    checkpointEvery: 4,
    ...over,
  });
}

const live = (): AbortSignal => new AbortController().signal;

function instanceQuery(q: string, over: Partial<InstanceSearchQuery> = {}): InstanceSearchQuery {
  return { q, limit: 100, budgetMs: 10_000, ...over };
}

function sessionQuery(session: string, over: Partial<TranscriptSearchQuery> = {}): TranscriptSearchQuery {
  return { session, limit: 200, budgetMs: 10_000, ...over };
}

// ---- coverage honesty (DA-T-S-1) ---------------------------------------------------------------------------------------------

describe('coverage honesty (DA-T-S-1)', () => {
  it('counts a file that is gone, names it, and never calls the answer complete', async () => {
    const env = makeEnv();
    const a = addSession(env, 1, { ageMs: 10 * MINUTE });
    writeLines(env, a.mainPath, prompts('alpha MARKER one', 'alpha filler'));
    const agent = addAgent(env, a, 'agentfixture0001');
    writeLines(env, agent.path, prompts('MARKER from the agent'));
    const b = addSession(env, 2, { ageMs: 20 * MINUTE });
    writeLines(env, b.mainPath, prompts('MARKER two'));
    const c = addSession(env, 3, { ageMs: 30 * MINUTE });
    writeLines(env, c.mainPath, prompts('MARKER three'));
    rmSync(b.mainPath);

    const answer = await serviceOf(env).searchInstance(env.ctx, instanceQuery('marker'), live());
    expect(answer.matches.map((m) => [m.sessionId, m.agentId, m.sessionLabel])).toEqual([
      [a.uid, 'main', 'session 1'],
      [a.uid, 'agentfixture0001', 'session 1'],
      [c.uid, 'main', 'session 3'],
    ]);
    expect(answer.coverage).toMatchObject({
      scope: 'instance',
      filesInScope: 4,
      filesScanned: 3,
      filesMissing: 1,
      filesUnreadable: 0,
      complete: false,
      stoppedBy: 'complete',
    });
    expect(answer.coverage.note).toContain('Searched 3 of 4 transcript files');
    expect(answer.coverage.note).toContain('1 file was deleted by Claude Code');
    expect(answer.coverage.note).toContain(b.uid);
    expect(answer.continuation).toBeNull();
    expect(answer.truncated).toBe(false);
  });

  it('counts the file of a session that the database already knows to be gone', async () => {
    const env = makeEnv();
    const a = addSession(env, 1);
    writeLines(env, a.mainPath, prompts('MARKER one'));
    const b = addSession(env, 2);
    writeLines(env, b.mainPath, prompts('MARKER two'));
    env.db.driver.prepare("UPDATE transcript_files SET state = 'missing' WHERE id = ?").run([b.mainId]);
    const answer = await serviceOf(env).searchInstance(env.ctx, instanceQuery('marker'), live());
    expect(answer.matches).toHaveLength(1);
    expect(answer.coverage).toMatchObject({ filesInScope: 2, filesScanned: 1, filesMissing: 1, complete: false });
  });

  it('says nothing is wrong when everything was searched, and does not search untracked or retired files', async () => {
    const env = makeEnv();
    const a = addSession(env, 1);
    writeLines(env, a.mainPath, prompts('MARKER one'));
    const answer = await serviceOf(env).searchInstance(env.ctx, instanceQuery('marker'), live());
    expect(answer.coverage).toMatchObject({
      filesInScope: 1,
      filesScanned: 1,
      filesMissing: 0,
      filesUnreadable: 0,
      bytesNotIndexed: 0,
      complete: true,
      stoppedBy: 'complete',
    });
    expect(answer.coverage.bytesScanned).toBe(answer.coverage.bytesInScope);
    expect(answer.coverage.entriesScanned).toBe(1);

    const b = addSession(env, 2);
    writeLines(env, b.mainPath, prompts('MARKER retired'));
    env.db.driver.prepare("UPDATE transcript_files SET state = 'retired' WHERE id = ?").run([b.mainId]);
    const again = await serviceOf(env).searchInstance(env.ctx, instanceQuery('marker'), live());
    expect(again.matches.map((m) => m.sessionId)).toEqual([a.uid]);
    expect(again.coverage).toMatchObject({ filesInScope: 2, filesUnreadable: 1, complete: false });
  });

  it('does not search the bytes after the last line feed and says how many there are', async () => {
    const env = makeEnv();
    const a = addSession(env, 1);
    const lines = prompts('MARKER first', 'plain second');
    const last = JSON.stringify(user('MARKER last, still being written'));
    writeFileSync(a.mainPath, `${lines.join('\n')}\n${last}`);
    env.db.driver
      .prepare('UPDATE transcript_files SET size_seen = ? WHERE id = ?')
      .run([Buffer.byteLength(`${lines.join('\n')}\n${last}`), a.mainId]);
    const svc = serviceOf(env);
    const first = await svc.searchInstance(env.ctx, instanceQuery('marker'), live());
    expect(first.matches.map((m) => m.snippet)).toEqual(['MARKER first']);
    expect(first.coverage.bytesNotIndexed).toBe(Buffer.byteLength(last));
    expect(first.coverage.complete).toBe(false);
    expect(first.coverage.note).toContain('not indexed');

    appendFileSync(a.mainPath, '\n');
    const second = await svc.searchInstance(env.ctx, instanceQuery('marker'), live());
    expect(second.matches.map((m) => m.snippet)).toEqual(['MARKER first', 'MARKER last, still being written']);
    expect(second.coverage).toMatchObject({ bytesNotIndexed: 0, complete: true });
  });

  it('counts a file that is replaced by a shorter one while the search runs, and does not fail', async () => {
    const env = makeEnv();
    const a = addSession(env, 1);
    writeLines(env, a.mainPath, prompts(...Array.from({ length: 30 }, (_, i) => `MARKER number ${String(i)}`)));
    const real = createEntryIndexService(env.db, { chunkBytes: 4096, checkpointEvery: 4 });
    const replacing: EntryIndexService = {
      ensureIndexed: async (ctx, fileId, opts) => {
        const state = await real.ensureIndexed(ctx, fileId, opts);
        writeFileSync(a.mainPath, 'tiny\n'); // another process replaced the file after the index was read
        return state;
      },
    };
    const answer = await serviceOf(env, { index: replacing }).searchInstance(env.ctx, instanceQuery('marker'), live());
    expect(answer.coverage).toMatchObject({ filesUnreadable: 1, filesScanned: 0, complete: false });
  });

  it('counts a file that goes away while it is searched as missing, for one session as for the instance', async () => {
    const env = makeEnv();
    const a = addSession(env, 1);
    const b = addSession(env, 2);
    for (const s of [a, b]) {
      writeLines(env, s.mainPath, prompts(...Array.from({ length: 30 }, (_, i) => `MARKER number ${String(i)}`)));
    }
    const real = createEntryIndexService(env.db, { chunkBytes: 4096, checkpointEvery: 4 });
    const vanishing: EntryIndexService = {
      ensureIndexed: async (ctx, fileId, opts) => {
        const state = await real.ensureIndexed(ctx, fileId, opts);
        rmSync(join(env.root, `${fileId === a.mainId ? a.uid : b.uid}.jsonl`)); // deleted by Claude Code after the index was read
        return state;
      },
    };
    const svc = serviceOf(env, { index: vanishing });
    const one = await svc.searchSession(env.ctx, sessionQuery(a.uid, { q: 'marker' }), live());
    expect(one.coverage).toMatchObject({ filesMissing: 1, filesScanned: 0, complete: false });
    expect(one.matches).toEqual([]);
    const all = await svc.searchInstance(env.ctx, instanceQuery('marker'), live());
    expect(all.coverage).toMatchObject({ filesInScope: 2, filesMissing: 2, filesScanned: 0, complete: false });
  });

  it('lets a search whose budget ends inside the entry index go on where the index stopped, call after call', async () => {
    const env = makeEnv();
    const a = addSession(env, 1);
    const count = 6000;
    writeLines(
      env,
      a.mainPath,
      prompts(...Array.from({ length: count }, (_, i) => `MARKER number ${String(i)} ${'x'.repeat(100)}`)),
    );
    const svc = serviceOf(env);
    const first = await svc.searchSession(env.ctx, sessionQuery(a.uid, { q: 'marker', budgetMs: 1 }), live());
    // a file of this size cannot be indexed in a millisecond: the answer says it stopped and searched nothing it did not index
    expect(first.coverage).toMatchObject({ stoppedBy: 'time_budget', complete: false });
    expect(first.coverage.bytesScanned).toBe(0);
    let calls = 1;
    let last = first;
    while (last.coverage.entriesScanned === 0 && calls < 5000) {
      last = await svc.searchSession(env.ctx, sessionQuery(a.uid, { q: 'marker', budgetMs: 1 }), live());
      calls += 1;
    }
    expect(last.coverage.entriesScanned).toBeGreaterThan(0); // the index reached the end and the scan began
    expect(calls).toBeGreaterThan(2);
    const done = await svc.searchSession(env.ctx, sessionQuery(a.uid, { q: 'marker', limit: 10_000 }), live());
    expect(done.matches).toHaveLength(count);
    expect(done.coverage).toMatchObject({ complete: true, stoppedBy: 'complete', entriesScanned: count });
  });

  it('cuts the scope at the session cap and says so', async () => {
    const env = makeEnv();
    for (let n = 1; n <= 3; n += 1) {
      const s = addSession(env, n);
      writeLines(env, s.mainPath, prompts(`MARKER ${String(n)}`));
    }
    const answer = await serviceOf(env, { maxSessions: 2 }).searchInstance(env.ctx, instanceQuery('marker'), live());
    expect(answer.coverage).toMatchObject({ filesInScope: 2, complete: false });
    expect(answer.coverage.note).toContain('most recently active sessions');
    expect(answer.matches.map((m) => m.sessionId)).toEqual([uidOf(1), uidOf(2)]);
  });
});

describe('continuation (DA-T-S-1)', () => {
  function populate(env: Env): void {
    let first: Added | undefined;
    for (let n = 1; n <= 4; n += 1) {
      const s = addSession(env, n);
      first ??= s;
      writeLines(
        env,
        s.mainPath,
        prompts(
          ...Array.from({ length: 14 }, (_, i) =>
            i % 3 === 0 ? `MARKER s${String(n)} line ${String(i)}` : `plain ${String(i)}`,
          ),
        ),
      );
    }
    if (first === undefined) throw new Error('no session');
    const agent = addAgent(env, first, 'agentfixture0001');
    writeLines(env, agent.path, prompts('MARKER of the agent', 'plain'));
  }

  type InstanceAnswer = Awaited<ReturnType<SearchService['searchInstance']>>;

  async function pages(svc: SearchService, env: Env, over: Partial<InstanceSearchQuery>): Promise<InstanceAnswer[]> {
    const out: InstanceAnswer[] = [];
    let handle: string | null = null;
    for (let guard = 0; guard < 200; guard += 1) {
      const page = await svc.searchInstance(
        env.ctx,
        instanceQuery('marker', { ...over, ...(handle === null ? {} : { continue: handle }) }),
        live(),
      );
      out.push(page);
      if (page.continuation === null) return out;
      handle = page.continuation;
    }
    throw new Error('the search did not end');
  }

  it('gives the matches of the one-shot search, page by page, whatever stops each page', async () => {
    const env = makeEnv();
    populate(env);
    const svc = serviceOf(env);
    const whole = await svc.searchInstance(env.ctx, instanceQuery('marker'), live());
    expect(whole.coverage.complete).toBe(true);
    expect(whole.matches.length).toBeGreaterThan(10);

    for (const over of [{ budgetMs: 0 }, { limit: 3 }, { limit: 4, budgetMs: 0 }, { limit: 1 }]) {
      const got = await pages(svc, env, over);
      expect(got.length, JSON.stringify(over)).toBeGreaterThan(1);
      expect(
        got.flatMap((page) => page.matches),
        JSON.stringify(over),
      ).toEqual(whole.matches);
      for (const page of got.slice(0, -1)) {
        expect(page.coverage.complete).toBe(false);
        expect(['time_budget', 'match_limit']).toContain(page.coverage.stoppedBy);
        expect(page.truncated).toBe(page.coverage.stoppedBy === 'match_limit');
        if (over.limit !== undefined) expect(page.matches.length).toBeLessThanOrEqual(over.limit);
      }
      // the numbers add up over the pages: the last page says what all of them searched
      const last = got.at(-1);
      expect(last?.coverage).toMatchObject({
        complete: true,
        stoppedBy: 'complete',
        filesScanned: whole.coverage.filesScanned,
        bytesScanned: whole.coverage.bytesScanned,
        entriesScanned: whole.coverage.entriesScanned,
        bytesInScope: whole.coverage.bytesInScope,
      });
    }
  });

  it('refuses a handle that is forged, of another query, expired, evicted or of another instance (cursor_invalid)', async () => {
    const env = makeEnv();
    populate(env);
    const svc = serviceOf(env, { maxContinuations: 3 });
    const first = await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1 }), live());
    const handle = first.continuation;
    expect(handle).toMatch(/^c-[A-Za-z0-9_-]{16,64}$/);
    const refused = { name: 'QueryRefusal', code: 'cursor_invalid' };

    await expect(
      svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1, continue: 'c-forged' }), live()),
    ).rejects.toMatchObject(refused);
    // another query, another filter
    await expect(
      svc.searchInstance(env.ctx, instanceQuery('plain', { limit: 1, continue: handle ?? '' }), live()),
    ).rejects.toMatchObject(refused);
    await expect(
      svc.searchInstance(
        env.ctx,
        instanceQuery('marker', { limit: 1, kinds: ['say'], continue: handle ?? '' }),
        live(),
      ),
    ).rejects.toMatchObject(refused);
    // the same query, even with another limit and budget, is the same search
    const same = await svc.searchInstance(
      env.ctx,
      instanceQuery('marker', { limit: 2, budgetMs: 5000, continue: handle ?? '' }),
      live(),
    );
    expect(same.matches.length).toBeGreaterThan(0);

    // another instance never knows it
    const other = makeEnv(ID_B);
    await expect(
      serviceOf(other).searchInstance(other.ctx, instanceQuery('marker', { limit: 1, continue: handle ?? '' }), live()),
    ).rejects.toMatchObject(refused);

    // the least recently used record is evicted when more than the limit are alive
    const oldest = (await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1 }), live())).continuation;
    for (let i = 0; i < 3; i += 1) await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1 }), live());
    await expect(
      svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1, continue: oldest ?? '' }), live()),
    ).rejects.toMatchObject(refused);

    // five minutes
    const fresh = (await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1 }), live())).continuation;
    env.clock.advance(5 * MINUTE - 1);
    const stillGood = await svc.searchInstance(
      env.ctx,
      instanceQuery('marker', { limit: 1, continue: fresh ?? '' }),
      live(),
    );
    expect(stillGood.matches.length).toBe(1);
    const late = (await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1 }), live())).continuation;
    env.clock.advance(5 * MINUTE);
    await expect(
      svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1, continue: late ?? '' }), live()),
    ).rejects.toMatchObject(refused);
  });

  it('does not put the query into the handle or the coverage', async () => {
    const env = makeEnv();
    populate(env);
    const first = await serviceOf(env).searchInstance(env.ctx, instanceQuery('marker', { limit: 1 }), live());
    expect(first.continuation).not.toBeNull();
    expect(JSON.stringify([first.continuation, first.coverage]).toLowerCase()).not.toContain('marker');
  });
});

// ---- the rules of the legacy search against a naive reference (DA-T-S-2) ---------------------------------------------------

const VOCAB = [
  'alpha',
  'beta',
  'Gamma',
  'delta',
  'epsilon',
  'error',
  'timeout',
  'build',
  'Retry',
  'cache',
  'index',
  'needle',
  'ZULU',
  `caf${E_ACUTE}`,
  `smile${EMOJI}`,
];
const TOOLS = ['Bash', 'Read', 'Grep', 'Edit'];

function escapeUnits(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    out += unit < 0x80 ? text.charAt(i) : `${BACKSLASH}u${unit.toString(16).padStart(4, '0')}`;
  }
  return out;
}

/** A transcript of `count` records of every shape the display projection knows, with a bit of noise, as lines of text. */
function randomTranscript(prng: Prng, count: number): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let tools = 0;
  const words = (n: number): string => Array.from({ length: n }, () => prng.pick(VOCAB)).join(' ');
  for (let i = 0; i < count; i += 1) {
    const roll = prng.int(14);
    let record: unknown;
    if (roll < 2) record = user(words(prng.range(1, 10)));
    else if (roll < 4) record = say(words(prng.range(1, 10)));
    else if (roll === 4) {
      record = {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:04.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: words(5), signature: 'FIXTURE' },
            { type: 'text', text: words(4) },
          ],
        },
      };
    } else if (roll < 8) {
      const id = `toolu_${String(tools)}`;
      tools += 1;
      open.push(id);
      const input = prng.pick<Record<string, unknown>>([
        { command: words(3) },
        { file_path: `src/${words(1)}.ts` },
        { pattern: words(1), path: 'src' },
      ]);
      record = toolUse(id, prng.pick(TOOLS), input);
    } else if (roll < 11 && open.length > 0) {
      const id = open.splice(prng.int(open.length), 1)[0] ?? '';
      const content = prng.chance(0.3)
        ? [
            { type: 'text', text: words(3) },
            { type: 'text', text: words(2) },
          ]
        : words(prng.range(1, 8));
      record = toolResult(id, content, prng.chance(0.35));
    } else if (roll === 11) {
      record = say(`${words(2)} ${'filler '.repeat(prng.range(900, 1200))} ${words(1)}`); // longer than the clip
    } else if (roll === 12) {
      record = { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-01-01T00:00:05.000Z' };
    } else {
      lines.push('{"type":"user", this line is not JSON');
      continue;
    }
    const line = JSON.stringify(record);
    lines.push(prng.chance(0.3) ? escapeUnits(line) : line);
  }
  return lines;
}

interface Expected {
  readonly i: number;
  readonly k: EntryKind;
  readonly t: string;
  readonly name: string | null;
  readonly snippet: string;
  readonly offset: number;
}

interface Wanted {
  readonly q: string;
  readonly kinds?: readonly EntryKind[];
  readonly tool?: string;
  readonly errors?: true;
}

/** The legacy `/api/search` of the pre-4.0 monitor, written the naive way: parse everything, then filter. */
function legacySearch(lines: readonly string[], wanted: Wanted): Expected[] {
  const entries: { e: ReturnType<typeof displayEntries>[number]; i: number; offset: number }[] = [];
  let offset = 0;
  for (const line of lines) {
    const start = offset;
    offset += Buffer.byteLength(line) + 1;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    for (const e of displayEntries(record, { textChars: 6000 })) entries.push({ e, i: entries.length, offset: start });
  }
  const names = new Map<string, string | undefined>();
  const bad = new Set<string>();
  for (const { e } of entries) {
    if (e.k === 'tool' && e.id !== undefined) names.set(e.id, e.name);
    if (e.k === 'result' && e.err === true && e.id !== undefined) bad.add(e.id);
  }
  const needle = wanted.q.toLowerCase();
  const out: Expected[] = [];
  for (const { e, i, offset: at } of entries) {
    if (wanted.kinds !== undefined && !wanted.kinds.includes(e.k)) continue;
    if (
      wanted.errors === true &&
      !((e.k === 'result' && e.err === true) || (e.k === 'tool' && e.id !== undefined && bad.has(e.id)))
    )
      continue;
    if (
      wanted.tool !== undefined &&
      !(
        (e.k === 'tool' && e.name === wanted.tool) ||
        (e.k === 'result' && e.id !== undefined && names.get(e.id) === wanted.tool)
      )
    ) {
      continue;
    }
    const hay = [e.text, e.summary, e.input, e.name]
      .map((field) => field ?? '')
      .join(' ')
      .toLowerCase();
    if (needle !== '' && !hay.includes(needle)) continue;
    const source =
      e.text !== undefined && e.text !== ''
        ? e.text
        : e.summary !== undefined && e.summary !== ''
          ? e.summary
          : (e.input ?? '');
    let from = 0;
    if (needle !== '') {
      const lowered = source.toLowerCase();
      const found = lowered.indexOf(needle);
      from = found < 0 ? 0 : Math.max(0, Array.from(lowered.slice(0, found)).length - 40);
    }
    out.push({
      i,
      k: e.k,
      t: e.t,
      name: e.name === undefined || e.name === '' ? null : e.name,
      snippet: Array.from(source)
        .slice(from, from + 160)
        .join(''),
      offset: at,
    });
  }
  return out;
}

function seededQuery(prng: Prng): Wanted {
  const word = prng.pick(VOCAB);
  const queries = [
    word,
    word.toLowerCase(),
    word.toUpperCase(),
    `${word} ${prng.pick(VOCAB)}`,
    word.slice(1, 4),
    '',
    '"command"',
    '{"file_path": "src/',
    `"pattern": "${word}"`,
    'src/',
    prng.pick(['a', 'e', 'ed', 'chars', 'truncated', '...']),
    `${word}"`,
  ];
  const q = prng.pick(queries);
  const kinds: EntryKind[] = ['prompt', 'say', 'think', 'tool', 'result'];
  const chosen = prng.chance(0.35) ? kinds.filter(() => prng.chance(0.5)) : [];
  return {
    q,
    ...(chosen.length > 0 ? { kinds: chosen } : {}),
    ...(prng.chance(0.3) ? { tool: prng.pick(TOOLS) } : {}),
    ...(prng.chance(0.3) ? { errors: true as const } : {}),
  };
}

describe('the legacy rules against a naive full-parse reference (DA-T-S-2)', () => {
  it(
    'give the same matches for 200 seeded queries (kinds, tool, errors) over a file of many blocks and slices',
    { timeout: 120_000 },
    async () => {
      const env = makeEnv();
      const prng = new Prng(SEED);
      const s = addSession(env, 1);
      const lines = randomTranscript(prng, 700);
      writeLines(env, s.mainPath, lines);
      const svc = serviceOf(env, { chunkBytes: 2048, checkpointEvery: 8 });
      let withMatches = 0;
      for (let round = 0; round < 200; round += 1) {
        const wanted = seededQuery(prng);
        const expected = legacySearch(lines, wanted);
        const label = `seed ${String(SEED)} round ${String(round)} ${JSON.stringify(wanted)}`;
        const answer = await svc.searchSession(
          env.ctx,
          sessionQuery(s.uid, {
            q: wanted.q,
            limit: 1000,
            ...(wanted.kinds === undefined ? {} : { kinds: [...wanted.kinds] }),
            ...(wanted.tool === undefined ? {} : { tool: wanted.tool }),
            ...(wanted.errors === undefined ? {} : { errors: wanted.errors }),
          }),
          live(),
        );
        expect(answer.matches, label).toEqual(expected);
        expect(answer.coverage, label).toMatchObject({ complete: true, stoppedBy: 'complete', scope: 'session' });
        expect(answer.truncated, label).toBe(false);
        expect(answer.count, label).toBe(expected.length);
        if (expected.length > 0) withMatches += 1;

        // the same query with a small limit is the start of the same answer
        const few = await svc.searchSession(
          env.ctx,
          sessionQuery(s.uid, {
            q: wanted.q,
            limit: 3,
            ...(wanted.kinds === undefined ? {} : { kinds: [...wanted.kinds] }),
            ...(wanted.tool === undefined ? {} : { tool: wanted.tool }),
            ...(wanted.errors === undefined ? {} : { errors: wanted.errors }),
          }),
          live(),
        );
        expect(few.matches, label).toEqual(expected.slice(0, 3));
        expect(few.truncated, label).toBe(expected.length > 3);
      }
      expect(withMatches).toBeGreaterThan(100); // the queries are not all empty answers
    },
  );

  it(
    'give the same matches with the production block and slice sizes on a file of several MiB',
    { timeout: 60_000 },
    async () => {
      const env = makeEnv();
      const prng = new Prng(SEED + 1);
      const s = addSession(env, 1);
      const lines = randomTranscript(prng, 4000);
      writeLines(env, s.mainPath, lines);
      const queries = createQueries(env.db, env.deps);
      for (let round = 0; round < 25; round += 1) {
        const wanted = seededQuery(prng);
        const answer = await queries.searchSession(
          env.ctx,
          sessionQuery(s.uid, {
            q: wanted.q,
            limit: 1000,
            ...(wanted.kinds === undefined ? {} : { kinds: [...wanted.kinds] }),
            ...(wanted.tool === undefined ? {} : { tool: wanted.tool }),
            ...(wanted.errors === undefined ? {} : { errors: wanted.errors }),
          }),
          live(),
        );
        const expected = legacySearch(lines, wanted);
        const label = `seed ${String(SEED + 1)} round ${String(round)} ${JSON.stringify(wanted)}`;
        expect(answer.matches, label).toEqual(expected.slice(0, 1000));
        expect(answer.truncated, label).toBe(expected.length > 1000);
      }
    },
  );

  it('gives the byte offset of the line of each match, and the label, agent and time of an instance match', async () => {
    const env = makeEnv();
    const a = addSession(env, 1);
    writeLines(env, a.mainPath, prompts('first line', 'the NEEDLE is here', 'last line'));
    const agent = addAgent(env, a, 'agentfixture0001');
    writeLines(env, agent.path, [JSON.stringify(say('an agent says needle'))]);
    const svc = serviceOf(env);
    const one = await svc.searchSession(env.ctx, sessionQuery(a.uid, { q: 'needle' }), live());
    const bytes = readFileSync(a.mainPath);
    expect(one.matches).toHaveLength(1);
    expect(bytes.subarray(one.matches[0]?.offset).toString('utf8').split('\n')[0]).toContain('the NEEDLE is here');
    expect(one.matches[0]).toMatchObject({ i: 1, k: 'prompt', t: '2026-01-01T00:00:00.000Z', name: null });

    const all = await svc.searchInstance(env.ctx, instanceQuery('needle'), live());
    expect(all.matches).toEqual([
      expect.objectContaining({ sessionId: a.uid, sessionLabel: 'session 1', agentId: 'main', i: 1, k: 'prompt' }),
      expect.objectContaining({
        sessionId: a.uid,
        sessionLabel: 'session 1',
        agentId: 'agentfixture0001',
        i: 0,
        k: 'say',
      }),
    ]);
    const only = await svc.searchSession(
      env.ctx,
      sessionQuery(a.uid, { q: 'needle', agent: 'agentfixture0001' }),
      live(),
    );
    expect(only.coverage.scope).toBe('agent');
    expect(only.matches.map((m) => m.snippet)).toEqual(['an agent says needle']);
  });
});

// ---- who and what is in scope -------------------------------------------------------------------------------------------------

describe('scope', () => {
  it('searches the window of sessions by default and follows the session and time filters', async () => {
    const env = makeEnv();
    const fresh = addSession(env, 1, { ageMs: HOUR });
    const old = addSession(env, 2, { ageMs: 20 * HOUR });
    const other = addSession(env, 3, { ageMs: 2 * HOUR });
    for (const s of [fresh, old, other]) writeLines(env, s.mainPath, prompts(`MARKER of ${s.label}`));
    const svc = serviceOf(env);
    const ids = async (over: Partial<InstanceSearchQuery> = {}): Promise<string[]> =>
      (await svc.searchInstance(env.ctx, instanceQuery('marker', over), live())).matches.map((m) => m.sessionId);

    expect(await ids()).toEqual([fresh.uid, other.uid]); // the window is 8 hours, most recent first
    expect(await ids({ range: 'all' })).toEqual([fresh.uid, other.uid, old.uid]);
    expect(await ids({ session: [old.uid] })).toEqual([]); // outside the window even when asked for by id
    expect(await ids({ session: [old.uid, other.uid], range: 'all' })).toEqual([other.uid, old.uid]);
    expect(await ids({ session: [uidOf(99)] })).toEqual([]);
    const none = await svc.searchInstance(env.ctx, instanceQuery('marker', { session: [uidOf(99)] }), live());
    expect(none.coverage).toMatchObject({ filesInScope: 0, complete: true });
    await expect(
      svc.searchInstance(env.ctx, instanceQuery('marker', { range: '1h', window: true }), live()),
    ).rejects.toMatchObject({
      name: 'QueryRefusal',
      code: 'range_invalid',
    });
  });

  it('does not resolve a session that is only on disk, and refuses unknown agents and gone files', async () => {
    const env = makeEnv();
    const onDisk = uidOf(50);
    writeFileSync(join(env.root, `${onDisk}.jsonl`), `${prompts('MARKER only on disk').join('\n')}\n`);
    const svc = serviceOf(env);
    await expect(svc.searchSession(env.ctx, sessionQuery(onDisk, { q: 'marker' }), live())).rejects.toMatchObject({
      name: 'TranscriptError',
      code: 'session_not_found',
    });
    const a = addSession(env, 1);
    writeLines(env, a.mainPath, prompts('MARKER'));
    await expect(
      svc.searchSession(env.ctx, sessionQuery(a.uid, { q: 'marker', agent: 'nosuchagent' }), live()),
    ).rejects.toMatchObject({
      name: 'TranscriptError',
      code: 'agent_not_found',
    });
    rmSync(a.mainPath);
    await expect(svc.searchSession(env.ctx, sessionQuery(a.uid, { q: 'marker' }), live())).rejects.toMatchObject({
      name: 'TranscriptError',
      code: 'transcript_gone',
    });
    env.db.driver.prepare("UPDATE transcript_files SET state = 'missing' WHERE id = ?").run([a.mainId]);
    await expect(svc.searchSession(env.ctx, sessionQuery(a.uid, { q: 'marker' }), live())).rejects.toMatchObject({
      name: 'TranscriptError',
      code: 'transcript_gone',
    });
  });

  it('refuses the context of another instance', async () => {
    const env = makeEnv();
    await expect(
      serviceOf(env).searchInstance({ instanceId: ID_B }, instanceQuery('marker'), live()),
    ).rejects.toThrow();
  });
});

// ---- path containment (DA-T-S-4) ---------------------------------------------------------------------------------------------

describe('path containment (DA-T-S-4)', () => {
  it('skips a file whose real path leaves the transcripts folder and counts it unreadable', async () => {
    const env = makeEnv();
    const inside = addSession(env, 1);
    writeLines(env, inside.mainPath, prompts('MARKER inside'));
    const outside = join(env.dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'escaped.jsonl'), `${prompts('MARKER SECRET outside the folder').join('\n')}\n`);
    const link = join(env.root, 'linked');
    makeJunction(link, outside);
    links.push(link);
    const escaped = addSession(env, 2, { mainPath: join(link, 'escaped.jsonl') });

    const svc = serviceOf(env);
    const answer = await svc.searchInstance(env.ctx, instanceQuery('marker'), live());
    expect(answer.matches.map((m) => m.sessionId)).toEqual([inside.uid]);
    expect(JSON.stringify(answer)).not.toContain('SECRET');
    expect(answer.coverage).toMatchObject({ filesInScope: 2, filesScanned: 1, filesUnreadable: 1, complete: false });
    expect(answer.coverage.note).toContain('could not be read');
    expect(answer.coverage.note).toContain(escaped.uid);

    await expect(svc.searchSession(env.ctx, sessionQuery(escaped.uid, { q: 'secret' }), live())).rejects.toMatchObject({
      name: 'TranscriptError',
      code: 'transcript_gone',
    });
  });
});

// ---- cancellation and the two slots (DA-T-S-6) --------------------------------------------------------------------------------

describe('cancellation and the two slots (DA-T-S-6)', () => {
  function gated(env: Env): { index: EntryIndexService; open: () => void } {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const real = createEntryIndexService(env.db, { chunkBytes: 4096, checkpointEvery: 4 });
    return {
      index: {
        ensureIndexed: async (ctx, fileId, opts) => {
          await gate;
          return real.ensureIndexed(ctx, fileId, opts);
        },
      },
      open,
    };
  }

  it('refuses the third search at once, takes no slot for a refusal and gives every slot back', async () => {
    const env = makeEnv();
    const a = addSession(env, 1);
    writeLines(env, a.mainPath, prompts('MARKER one'));
    const { index, open } = gated(env);
    const svc = serviceOf(env, { index });
    const first = svc.searchSession(env.ctx, sessionQuery(a.uid, { q: 'marker' }), live());
    const second = svc.searchInstance(env.ctx, instanceQuery('marker'), live());
    const third = svc.searchInstance(env.ctx, instanceQuery('marker'), live());
    await expect(third).rejects.toBeInstanceOf(SearchBusyError);
    await expect(svc.searchSession(env.ctx, sessionQuery(a.uid, { q: 'marker' }), live())).rejects.toMatchObject({
      name: 'SearchBusyError',
    });
    open();
    expect((await first).matches).toHaveLength(1);
    expect((await second).matches).toHaveLength(1);
    // both slots are free again
    expect((await svc.searchInstance(env.ctx, instanceQuery('marker'), live())).matches).toHaveLength(1);
    expect(svc.stats()).toMatchObject({ total: 3, byStoppedBy: { complete: 3 } });
  });

  it('does not keep a slot for a search that failed', async () => {
    const env = makeEnv();
    const svc = serviceOf(env);
    for (let i = 0; i < 5; i += 1) {
      await expect(svc.searchSession(env.ctx, sessionQuery(uidOf(70 + i), { q: 'x' }), live())).rejects.toMatchObject({
        code: 'session_not_found',
      });
    }
    const a = addSession(env, 1);
    writeLines(env, a.mainPath, prompts('MARKER'));
    const results = await Promise.all([
      svc.searchInstance(env.ctx, instanceQuery('marker'), live()),
      svc.searchInstance(env.ctx, instanceQuery('marker'), live()),
    ]);
    expect(results.map((r) => r.matches.length)).toEqual([1, 1]);
  });

  it('stops within a block when the client goes away, and frees the slot, a hundred times', async () => {
    const env = makeEnv();
    const a = addSession(env, 1);
    writeLines(
      env,
      a.mainPath,
      prompts(...Array.from({ length: 400 }, (_, i) => `MARKER filler line number ${String(i)} ${'x'.repeat(80)}`)),
    );
    let calls = 0;
    let abortAt = 0;
    let controller = new AbortController();
    const svc = serviceOf(env, {
      clock: () => {
        calls += 1;
        if (calls === abortAt) controller.abort();
        return performance.now();
      },
    });
    const whole = await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1000 }), live());
    expect(whole.coverage.complete).toBe(true);

    // abort in the middle of the scan: a few clock reads in, the loop is inside the lines of a block
    calls = 0;
    abortAt = 40;
    controller = new AbortController();
    const cut = await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1000 }), controller.signal);
    expect(cut.coverage).toMatchObject({ stoppedBy: 'cancelled', complete: false });
    expect(cut.coverage.bytesScanned).toBeLessThan(whole.coverage.bytesScanned);
    expect(cut.matches.length).toBeLessThan(whole.matches.length);
    expect(cut.continuation).toBeNull();
    expect(cut.coverage.note).toContain('cancelled');

    // a hundred searches that are cancelled at some point leave no slot taken
    for (let round = 0; round < 100; round += 1) {
      calls = 0;
      abortAt = 1 + (round % 60);
      controller = new AbortController();
      if (round % 10 === 0) controller.abort();
      const answer = await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1000 }), controller.signal);
      expect(answer.coverage.stoppedBy, `round ${String(round)}`).toBe('cancelled');
    }
    abortAt = 0;
    const [one, two] = await Promise.all([
      svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 5 }), live()),
      svc.searchSession(env.ctx, sessionQuery(a.uid, { q: 'marker', limit: 5 }), live()),
    ]);
    expect(one.matches).toHaveLength(5);
    expect(two.matches).toHaveLength(5);
    expect(svc.stats().byStoppedBy.cancelled).toBe(101);
  });
});

describe('the counters of the health report', () => {
  it('count every finished search by what stopped it, and nothing else', async () => {
    const env = makeEnv();
    for (let n = 1; n <= 3; n += 1) {
      const s = addSession(env, n);
      writeLines(env, s.mainPath, prompts(...Array.from({ length: 12 }, (_, i) => `MARKER ${String(i)}`)));
    }
    const svc = serviceOf(env);
    expect(svc.stats()).toEqual({
      total: 0,
      byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 },
    });
    await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1000 }), live());
    await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1000 }), live());
    await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 2 }), live());
    await svc.searchInstance(env.ctx, instanceQuery('marker', { limit: 1000, budgetMs: 0 }), live());
    const gone = new AbortController();
    gone.abort();
    await svc.searchInstance(env.ctx, instanceQuery('marker'), gone.signal);
    await expect(svc.searchSession(env.ctx, sessionQuery(uidOf(99), { q: 'x' }), live())).rejects.toThrow();
    const stats = svc.stats();
    expect(stats).toEqual({ total: 5, byStoppedBy: { complete: 2, match_limit: 1, time_budget: 1, cancelled: 1 } });
    // a copy: the caller cannot change the counters
    stats.byStoppedBy.complete = 99;
    expect(svc.stats().byStoppedBy.complete).toBe(2);
    // the query layer carries the same part
    expect(createQueries(env.db, env.deps).searchStats()).toEqual({
      total: 0,
      byStoppedBy: { complete: 0, match_limit: 0, time_budget: 0, cancelled: 0 },
    });
  });
});

// ---- instance isolation (DA-T-S-10, engine part) -----------------------------------------------------------------------------

describe('instance isolation (DA-T-S-10)', () => {
  it('never shows the text of another instance and counts only its own files', async () => {
    const a = makeEnv(ID_A);
    const b = makeEnv(ID_B);
    const sa = addSession(a, 1);
    writeLines(a, sa.mainPath, prompts('shared words and SENTINEL-ALPHA-ONLY'));
    const sb = addSession(b, 1);
    writeLines(b, sb.mainPath, prompts('shared words and SENTINEL-BETA-ONLY'));
    const sb2 = addSession(b, 2);
    writeLines(b, sb2.mainPath, prompts('more shared words'));

    const onA = await serviceOf(a).searchInstance(a.ctx, instanceQuery('shared words'), live());
    expect(onA.matches.map((m) => m.snippet)).toEqual(['shared words and SENTINEL-ALPHA-ONLY']);
    expect(onA.coverage.filesInScope).toBe(1);
    expect(JSON.stringify(onA)).not.toContain('BETA');

    expect((await serviceOf(a).searchInstance(a.ctx, instanceQuery('SENTINEL-BETA-ONLY'), live())).matches).toEqual([]);
    const onB = await serviceOf(b).searchInstance(b.ctx, instanceQuery('shared words'), live());
    expect(onB.matches).toHaveLength(2);
    expect(onB.coverage.filesInScope).toBe(2);
    expect(JSON.stringify(onB)).not.toContain('ALPHA');
    // a session of the other instance is not found by its id
    await expect(serviceOf(a).searchSession(a.ctx, sessionQuery(sb2.uid, { q: 'x' }), live())).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });
});

// ---- big files and long lines -------------------------------------------------------------------------------------------------

describe('read boundaries and long lines', () => {
  it('finds a needle that straddles the 1 MiB read boundary, one in a line of 1.3 MB, and one in the last line', async () => {
    const env = makeEnv();
    const s = addSession(env, 1);
    const empty = Buffer.byteLength(JSON.stringify(user('')));
    // line 1 ends 3000 bytes before the boundary; the needle of line 2 starts 5 bytes before it and ends after it
    const lineStart = MIB - 3000;
    const first = JSON.stringify(user('f'.repeat(lineStart - 1 - empty)));
    const probe = JSON.stringify(user('@@'));
    const textAt = Buffer.byteLength(probe.slice(0, probe.indexOf('@@')));
    const pad = MIB - 5 - lineStart - textAt;
    const straddling = JSON.stringify(user(`${'p'.repeat(pad)}STRADDLE-NEEDLE and the rest`));
    const long = JSON.stringify(user(`LONG-NEEDLE ${'z'.repeat(1_300_000)}`));
    const lines = [first, straddling, 'not json at all', long, JSON.stringify(user('LAST-NEEDLE'))];
    const text = lines.join('\n');
    writeFileSync(s.mainPath, text); // the last line has no line feed
    env.db.driver
      .prepare('UPDATE transcript_files SET size_seen = ? WHERE id = ?')
      .run([Buffer.byteLength(text), s.mainId]);
    expect(Buffer.byteLength(`${first}\n`)).toBe(lineStart);
    expect(Buffer.byteLength(`${first}\n${straddling.slice(0, textAt + pad + 5)}`)).toBe(MIB);

    const queries = createQueries(env.db, env.deps);
    const find = async (q: string): Promise<number[]> =>
      (await queries.searchSession(env.ctx, sessionQuery(s.uid, { q }), live())).matches.map((m) => m.i);
    expect(await find('STRADDLE-NEEDLE')).toEqual([1]);
    expect(await find('LONG-NEEDLE')).toEqual([2]);
    expect(await find('LAST-NEEDLE')).toEqual([]); // not indexed until its line feed is there
    const answer = await queries.searchSession(env.ctx, sessionQuery(s.uid, { q: 'LAST-NEEDLE' }), live());
    expect(answer.coverage).toMatchObject({ complete: false });
    expect(answer.coverage.bytesNotIndexed).toBe(Buffer.byteLength(lines[4] ?? ''));
    appendFileSync(s.mainPath, '\n');
    expect(await find('LAST-NEEDLE')).toEqual([3]);
  });
});

// ---- event-loop slices (DA-T-S-5) ----------------------------------------------------------------------------------------------

/** Records the longest time between two turns of the event loop while it runs. */
function loopGaps(): { stop: () => number } {
  let last = performance.now();
  let longest = 0;
  let running = true;
  const tick = (): void => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  return {
    stop: () => {
      running = false;
      return longest;
    },
  };
}

describe('event-loop slices (DA-T-S-5)', () => {
  it(
    'keeps the gap between two turns of the event loop short while it scans 100 MB',
    { timeout: 120_000 },
    async () => {
      const env = makeEnv();
      const s = addSession(env, 1);
      const unit = Buffer.from(`${JSON.stringify(user(`FIXTURE big prompt ${'lorem ipsum '.repeat(120)}`))}\n`);
      const chunk = Buffer.concat(Array.from({ length: Math.floor(MIB / unit.length) }, () => unit));
      const fd = openSync(s.mainPath, 'w');
      for (let i = 0; i < 100; i += 1) writeSync(fd, chunk);
      closeSync(fd);
      appendFileSync(s.mainPath, `${JSON.stringify(user('a RARE-NEEDLE at the very end'))}\n`);
      const size = statSync(s.mainPath).size;
      env.db.driver.prepare('UPDATE transcript_files SET size_seen = ? WHERE id = ?').run([size, s.mainId]);

      const svc = createSearchService(env.db, { deps: env.deps, roots: () => Promise.resolve(env.root) });
      // the first search also builds the entry index of the file
      const probe = loopGaps();
      const first = await svc.searchSession(env.ctx, sessionQuery(s.uid, { q: 'rare-needle' }), live());
      const withIndex = probe.stop();
      expect(first.matches).toHaveLength(1);
      expect(first.coverage).toMatchObject({ complete: true });
      expect(first.coverage.bytesScanned).toBe(size);

      // the scan alone, as the best of three runs (other processes may take the CPU for a moment)
      const gaps: number[] = [];
      for (let run = 0; run < 3; run += 1) {
        const gap = loopGaps();
        const again = await svc.searchSession(env.ctx, sessionQuery(s.uid, { q: 'rare-needle' }), live());
        gaps.push(gap.stop());
        expect(again.matches).toHaveLength(1);
      }
      // the parse path (no prefilter): every line is parsed, here for most of a second, twice
      const parseGaps: number[] = [];
      for (let run = 0; run < 2; run += 1) {
        const parse = loopGaps();
        const parsed = await svc.searchSession(
          env.ctx,
          sessionQuery(s.uid, { q: '', kinds: ['say'], limit: 1000, budgetMs: 800 }),
          live(),
        );
        parseGaps.push(parse.stop());
        expect(parsed.matches).toEqual([]); // the fixture holds prompts only: this run parses every line and finds nothing
      }

      expect(Math.min(...gaps), `gaps ${JSON.stringify(gaps)} ms, with index ${String(withIndex)} ms`).toBeLessThan(20);
      expect(Math.min(...parseGaps), `parse path gaps ${JSON.stringify(parseGaps)} ms`).toBeLessThan(40);
    },
  );
});
