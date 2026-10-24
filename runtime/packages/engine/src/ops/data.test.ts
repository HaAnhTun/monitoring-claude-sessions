// `ops.data` (01 6.4, T-CLI-05 unit part): the flag and object builders that turn command-line values into the parsed query types of the
// routes (the same Zod schemas the server parses with), their refusals, and the four operations over a scripted reader: what
// `sessions show` reads without `--include-text` (no transcript text at all), how it clips, how it resolves an id prefix.
import path from 'node:path';

import {
  McsError,
  PRESET_MS,
  isoMsZ,
  type SessionDetail,
  type SessionSummary,
  type TranscriptWindowResponse,
} from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, useTempDirs } from '@mcs/testkit';
import { describe, expect, it, vi } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { Logger } from '../log/logger.ts';
import { readerErrorOfCode, type InstanceReader } from '../reader/open.ts';
import {
  SHOW_TEXT_CLIP,
  errorsQueryOf,
  listSessions,
  recentErrors,
  sessionListQueryOf,
  showSession,
  usageQueryOf,
  usageReport,
  type DataDeps,
} from './data.ts';
import type { OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const ID = '11111111-1111-4111-8111-111111111111';
const SESSION_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SESSION_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const SESSION_C = 'bbbbbbbb-0000-4000-8000-000000000003';

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

/** The error code of a rejected or thrown call. */
function codeOf(run: () => unknown): { code: string; message: string; flag: unknown } {
  try {
    run();
  } catch (error) {
    if (error instanceof McsError) return { code: error.code, message: error.message, flag: error.details?.['flag'] };
    throw error;
  }
  throw new Error('expected an McsError');
}

async function rejection(promise: Promise<unknown>): Promise<McsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('sessionListQueryOf', () => {
  it('defaults to 50 sessions with the total, newest activity first', () => {
    const q = sessionListQueryOf();
    expect(q.limit).toBe(50);
    expect(q.includeTotal).toBe(true);
    expect(q.sort).toBe('lastActivity');
    expect(q.range).toBeUndefined();
    expect(q.from).toBeUndefined();
    expect(q.includeUnmatched).toBeUndefined();
  });

  it('reads a state list from a text or an array, with the alias active', () => {
    expect(sessionListQueryOf({ state: 'failed, stale' }).state).toEqual(['failed', 'stale']);
    expect(sessionListQueryOf({ state: ['working', 'completed'] }).state).toEqual(['working', 'completed']);
    expect(sessionListQueryOf({ state: 'active' }).state).toEqual(['active']);
  });

  it('reads --since as a preset (range) or an ISO time (from)', () => {
    expect(sessionListQueryOf({ since: '24h' }).range).toBe('24h');
    expect(sessionListQueryOf({ since: 'all' }).range).toBe('all');
    const q = sessionListQueryOf({ since: '2026-10-01T00:00:00+02:00' });
    expect(q.range).toBeUndefined();
    expect(q.from).toBe('2026-09-30T22:00:00.000Z');
  });

  it('--all adds the unmatched sessions and every time, unless --since is given', () => {
    const all = sessionListQueryOf({ all: true });
    expect(all.includeUnmatched).toBe(true);
    expect(all.range).toBe('all');
    const bounded = sessionListQueryOf({ all: true, since: '7d' });
    expect(bounded.includeUnmatched).toBe(true);
    expect(bounded.range).toBe('7d');
  });

  it('takes the limit as a number or a text and refuses what the route refuses', () => {
    expect(sessionListQueryOf({ limit: 7 }).limit).toBe(7);
    expect(sessionListQueryOf({ limit: '200' }).limit).toBe(200);
    for (const bad of [0, 201, -1, 1.5, '1e2', 'abc', '', ' ']) {
      const refused = codeOf(() => sessionListQueryOf({ limit: bad }));
      expect(refused.code, String(bad)).toBe('USAGE');
      expect(refused.flag, String(bad)).toBe('--limit');
      expect(refused.message, String(bad)).toContain('--limit expects an integer from 1 to 200');
    }
  });

  it('names the flag of a value that does not parse', () => {
    expect(codeOf(() => sessionListQueryOf({ state: 'sleeping' }))).toMatchObject({ code: 'USAGE', flag: '--state' });
    expect(codeOf(() => sessionListQueryOf({ since: 'yesterday' }))).toMatchObject({ code: 'USAGE', flag: '--since' });
    expect(codeOf(() => sessionListQueryOf({ since: '2026-10-01' })).message).toContain('ISO-8601');
  });
});

describe('errorsQueryOf', () => {
  it('has no bound and the default limit without flags', () => {
    const q = errorsQueryOf({}, NOW);
    expect(q.since).toBeUndefined();
    expect(q.limit).toBe(50);
  });

  it('turns a preset into the time it means at the given moment, and `all` into no bound', () => {
    expect(errorsQueryOf({ since: '24h' }, NOW).since).toBe(isoMsZ(NOW - PRESET_MS['24h']));
    expect(errorsQueryOf({ since: '1h' }, NOW).since).toBe(isoMsZ(NOW - PRESET_MS['1h']));
    expect(errorsQueryOf({ since: 'all' }, NOW).since).toBeUndefined();
    expect(errorsQueryOf({ since: '2026-10-19T00:00:00Z' }, NOW).since).toBe('2026-10-19T00:00:00.000Z');
  });

  it('refuses an out-of-range limit, a bad time and a bad source', () => {
    expect(codeOf(() => errorsQueryOf({ limit: 0 }, NOW))).toMatchObject({ code: 'USAGE', flag: '--limit' });
    expect(codeOf(() => errorsQueryOf({ limit: 201 }, NOW))).toMatchObject({ code: 'USAGE', flag: '--limit' });
    expect(codeOf(() => errorsQueryOf({ since: 'last week' }, NOW))).toMatchObject({ code: 'USAGE', flag: '--since' });
    expect(codeOf(() => errorsQueryOf({ source: 'nowhere' }, NOW))).toMatchObject({ code: 'USAGE', flag: '--source' });
    expect(errorsQueryOf({ source: ['spool', 'db'] }, NOW).source).toEqual(['spool', 'db']);
  });
});

describe('usageQueryOf', () => {
  it('groups by model by default and asks for the cost', () => {
    const request = usageQueryOf();
    expect(request.by).toBe('model');
    if (request.by !== 'model') throw new Error('unreachable');
    expect(request.query.groupBy).toBe('model');
    expect(request.query.includeCost).toBe(true);
  });

  it('maps session and model to the usage query, day to the series query and tool to the tool query', () => {
    const session = usageQueryOf({ by: 'session', session: [SESSION_A, SESSION_B], since: '7d' });
    if (session.by !== 'session') throw new Error('unreachable');
    expect(session.query.groupBy).toBe('session');
    expect(session.query.session).toEqual([SESSION_A, SESSION_B]);
    expect(session.query.range).toBe('7d');

    const day = usageQueryOf({ by: 'day', since: '2026-10-01T00:00:00Z', until: '2026-10-08T00:00:00Z' });
    if (day.by !== 'day') throw new Error('unreachable');
    expect(day.query.bucket).toBe('day');
    expect(day.query.from).toBe('2026-10-01T00:00:00.000Z');
    expect(day.query.to).toBe('2026-10-08T00:00:00.000Z');

    const tool = usageQueryOf({ by: 'tool', since: '24h', limit: 10 });
    if (tool.by !== 'tool') throw new Error('unreachable');
    expect(tool.query.groupBy).toBe('tool');
    expect(tool.query.limit).toBe(10);
  });

  it('refuses --until without an ISO --since, and rows beyond the limit of the route', () => {
    expect(codeOf(() => usageQueryOf({ until: '2026-10-08T00:00:00Z' }))).toMatchObject({ code: 'USAGE' });
    expect(codeOf(() => usageQueryOf({ since: '7d', until: '2026-10-08T00:00:00Z' })).message).toContain('--until');
    expect(codeOf(() => usageQueryOf({ by: 'model', limit: 501 }))).toMatchObject({ code: 'USAGE', flag: '--limit' });
    expect(codeOf(() => usageQueryOf({ by: 'tool', limit: 201 }))).toMatchObject({ code: 'USAGE', flag: '--limit' });
    expect(codeOf(() => usageQueryOf({ session: 'not-a-session' }))).toMatchObject({
      code: 'USAGE',
      flag: '--session',
    });
    expect(codeOf(() => usageQueryOf({ since: '2026-10-08T00:00:00Z', until: '2026-10-01T00:00:00Z' }))).toMatchObject({
      code: 'USAGE',
    });
  });
});

// ---- the operations over a scripted reader -----------------------------------------------------------------------------------------

interface Harness {
  readonly ctx: OpContext;
  readonly reader: InstanceReader;
  readonly calls: string[];
  readonly deps: DataDeps;
  closed(): number;
}

function summary(id: string, label = `FIXTURE ${id.slice(0, 8)}`): SessionSummary {
  return { id, label } as unknown as SessionSummary;
}

function windowOf(texts: readonly string[]): TranscriptWindowResponse {
  return {
    sessionId: SESSION_A,
    agentId: 'main',
    total: 40,
    base: 0,
    from: 0,
    next: texts.length,
    partial: false,
    skippedBytes: 0,
    pendingBytes: 0,
    fileState: 'active',
    asOfSeq: 1,
    events: texts.map((text, i) => ({ i, t: '', k: 'say' as const, text })),
  };
}

function harness(over: Partial<InstanceReader> = {}): Harness {
  const { repo } = buildRepo(makeTemp('data-ops').path);
  buildTaskWorkspace(repo, {
    slug: 'demo',
    config: { title: 'FIXTURE demo' },
    instance: { slug: 'demo', instanceId: ID, runtimeVersion: '4.0.0', dbSchemaVersion: 1 },
  });
  const skillDir = defaultSkillDir();
  const ctx: OpContext = {
    repo,
    root: path.join(repo, '.claude', 'monitor', 'tasks'),
    skillDir,
    runtimeDir: path.join(skillDir, 'runtime'),
    launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
    env: {},
    clock: new FakeClock(NOW),
    log: silent,
  };
  const calls: string[] = [];
  let closes = 0;
  const track =
    <A extends unknown[], R>(name: string, value: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(name);
      return value(...args);
    };
  const page = {
    items: [summary(SESSION_A), summary(SESSION_B), summary(SESSION_C)],
    nextCursor: null,
    asOfSeq: 1,
    total: 3,
    totalIsLowerBound: false,
    limit: 50,
  };
  const detail = {
    ...summary(SESSION_A),
    asOfSeq: 9,
    state: { state: 'working', basis: 'observed', evidence: [] },
  } as unknown as SessionDetail & { asOfSeq: number };
  const event = (id: number, summaryText: string) => ({
    id,
    at: `2026-10-20T11:00:0${String(id)}.000Z`,
    agentId: 'main',
    type: 'tool.call',
    category: 'tool',
    severity: 'info',
    toolName: 'Bash',
    toolStatus: 'ok',
    durationMs: 10,
    summary: summaryText,
    sessionLabel: 'FIXTURE',
    details: {},
  });
  const reader: InstanceReader = {
    mode: 'db',
    instanceId: ID,
    sessions: track('sessions', () => Promise.resolve(page)),
    session: track('session', (id: string) =>
      Promise.resolve(id === SESSION_A || id === SESSION_C ? { ...detail, id } : null),
    ),
    sessionAgents: track('sessionAgents', () =>
      Promise.resolve({ items: [], nextCursor: null, asOfSeq: 1, total: null, totalIsLowerBound: false, limit: 200 }),
    ),
    sessionEvents: track('sessionEvents', () =>
      Promise.resolve({
        items: [event(2, 'FIXTURE secret command two'), event(1, 'FIXTURE secret command one')],
        nextCursor: 'older',
        asOfSeq: 1,
        total: null,
        totalIsLowerBound: false,
        limit: 10,
        scanCapped: false,
        newerCursor: null,
      }),
    ),
    usage: track('usage', () => Promise.resolve({ marker: 'usage' })),
    series: track('series', () => Promise.resolve({ marker: 'series' })),
    tools: track('tools', () => Promise.resolve({ marker: 'tools' })),
    errors: track('errors', () => Promise.resolve([])),
    overview: track('overview', () => Promise.reject(new Error('not used'))),
    alerts: track('alerts', () => Promise.reject(new Error('not used'))),
    explainCompletion: track('explainCompletion', () => Promise.reject(new Error('not used'))),
    searchTranscript: track('searchTranscript', () => Promise.reject(new Error('not used'))),
    searchTranscripts: track('searchTranscripts', () => Promise.reject(new Error('not used'))),
    transcriptWindow: track('transcriptWindow', () => Promise.resolve(windowOf(['FIXTURE reply one']))),
    exportTo: track('exportTo', () => Promise.reject(new Error('not used'))),
    close: () => {
      closes += 1;
      return Promise.resolve();
    },
    ...over,
  } as unknown as InstanceReader;
  return {
    ctx,
    reader,
    calls,
    deps: { openReader: () => Promise.resolve(reader) },
    closed: () => closes,
  };
}

describe('listSessions', () => {
  it('maps the page to the result and always closes the reader', async () => {
    const h = harness();
    const result = await listSessions(h.ctx, { task: 'demo', limit: 3 }, h.deps);
    expect(result).toMatchObject({
      task: 'demo',
      mode: 'db',
      total: 3,
      totalIsLowerBound: false,
      hasMore: false,
      limit: 50,
    });
    expect(result.items.map((s) => s.id)).toEqual([SESSION_A, SESSION_B, SESSION_C]);
    expect(h.closed()).toBe(1);
  });

  it('says that more sessions match when the page has a next cursor', async () => {
    const h = harness({
      sessions: () =>
        Promise.resolve({ items: [], nextCursor: 'c', asOfSeq: 1, total: 120, totalIsLowerBound: false, limit: 50 }),
    });
    expect((await listSessions(h.ctx, { task: 'demo' }, h.deps)).hasMore).toBe(true);
  });

  it('does not open a reader for a flag that does not parse, and closes it when the read fails', async () => {
    const h = harness();
    const open = vi.fn(h.deps.openReader);
    await rejection(listSessions(h.ctx, { task: 'demo', limit: 0 }, { openReader: open }));
    expect(open).not.toHaveBeenCalled();
    const failing = harness({ sessions: () => Promise.reject(readerErrorOfCode('db_busy')) });
    await rejection(listSessions(failing.ctx, { task: 'demo' }, failing.deps));
    expect(failing.closed()).toBe(1);
  });

  it('refuses a task that does not exist', async () => {
    const h = harness();
    const error = await rejection(listSessions(h.ctx, { task: 'missing' }, h.deps));
    expect(error.code).toBe('TASK_NOT_FOUND');
  });
});

describe('showSession', () => {
  it('reads no transcript text without --include-text, and drops the tool summaries', async () => {
    const h = harness();
    const { result, warnings } = await showSession(h.ctx, { task: 'demo', session: SESSION_A }, h.deps);
    expect(h.calls).not.toContain('transcriptWindow');
    expect(result.transcript).toBeNull();
    expect(result.events.map((e) => e.summary)).toEqual([null, null]);
    expect(JSON.stringify(result)).not.toContain('secret command');
    expect(warnings).toEqual([]);
  });

  it('lists the events oldest first, says that older ones exist, and keeps asOfSeq out of the session', async () => {
    const h = harness();
    const { result } = await showSession(h.ctx, { task: 'demo', session: SESSION_A, events: 2 }, h.deps);
    expect(result.events.map((e) => e.id)).toEqual([1, 2]);
    expect(result.eventsTruncated).toBe(true);
    expect('asOfSeq' in result.session).toBe(false);
    expect(result.asOfSeq).toBe(9);
  });

  it('with --include-text adds the summaries and the newest transcript entries, each clipped to 300 characters', async () => {
    const long = 'x'.repeat(1000);
    const h = harness({ transcriptWindow: () => Promise.resolve(windowOf(['short', long])) });
    const { result } = await showSession(h.ctx, { task: 'demo', session: SESSION_A, includeText: true }, h.deps);
    expect(result.events.map((e) => e.summary)).toEqual(['FIXTURE secret command one', 'FIXTURE secret command two']);
    const entries = result.transcript?.entries ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]?.text).toBe('short');
    expect(Array.from(entries[1]?.text ?? '')).toHaveLength(SHOW_TEXT_CLIP);
    expect(entries[1]?.text.endsWith('…')).toBe(true);
    expect(result.transcript?.clipChars).toBe(300);
  });

  it('a transcript that is gone is a warning, not a failure', async () => {
    const h = harness({ transcriptWindow: () => Promise.reject(readerErrorOfCode('transcript_gone')) });
    const { result, warnings } = await showSession(
      h.ctx,
      { task: 'demo', session: SESSION_A, includeText: true },
      h.deps,
    );
    expect(result.transcript).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('transcript');
  });

  it('resolves the first characters of an id when exactly one session starts with them', async () => {
    const h = harness();
    const { result } = await showSession(h.ctx, { task: 'demo', session: 'bbbbbbbb' }, h.deps);
    expect(result.task).toBe('demo');
    expect(h.calls).toContain('sessions');
  });

  it('refuses an ambiguous prefix, reports an unknown one, and refuses text that is not an id', async () => {
    const h = harness();
    const ambiguous = await rejection(showSession(h.ctx, { task: 'demo', session: 'aaaaaaaa' }, h.deps));
    expect(ambiguous.code).toBe('USAGE');
    const none = await rejection(showSession(h.ctx, { task: 'demo', session: 'cccccccc' }, h.deps));
    expect(none.code).toBe('NOT_FOUND');
    const text = await rejection(showSession(h.ctx, { task: 'demo', session: 'x; DROP' }, h.deps));
    expect(text.code).toBe('USAGE');
  });

  it('reports an unknown full id as not found', async () => {
    const h = harness();
    const error = await rejection(showSession(h.ctx, { task: 'demo', session: SESSION_B }, h.deps));
    expect(error.code).toBe('NOT_FOUND');
    expect(h.closed()).toBe(1);
  });

  it('checks --events before anything is read', async () => {
    const h = harness();
    for (const bad of [0, 101, 1.5, 'x']) {
      const error = await rejection(showSession(h.ctx, { task: 'demo', session: SESSION_A, events: bad }, h.deps));
      expect(error.code, String(bad)).toBe('USAGE');
    }
    expect(h.calls).toEqual([]);
  });
});

describe('usageReport and recentErrors', () => {
  it('asks the route behind --by and carries the mode', async () => {
    const h = harness();
    expect(await usageReport(h.ctx, { task: 'demo', by: 'day' }, h.deps)).toMatchObject({
      by: 'day',
      mode: 'db',
      series: { marker: 'series' },
    });
    expect(await usageReport(h.ctx, { task: 'demo', by: 'tool' }, h.deps)).toMatchObject({
      by: 'tool',
      tools: { marker: 'tools' },
    });
    expect(await usageReport(h.ctx, { task: 'demo', by: 'session' }, h.deps)).toMatchObject({
      by: 'session',
      report: { marker: 'usage' },
    });
    expect(await usageReport(h.ctx, { task: 'demo' }, h.deps)).toMatchObject({ by: 'model' });
    expect(h.closed()).toBe(4);
  });

  it('resolves the preset of errors --since with the clock of the call', async () => {
    const seen: unknown[] = [];
    const h = harness({
      errors: (q) => {
        seen.push(q);
        return Promise.resolve([]);
      },
    });
    const result = await recentErrors(h.ctx, { task: 'demo', since: '1h', limit: 5 }, h.deps);
    expect(result).toEqual({ task: 'demo', mode: 'db', items: [] });
    expect(seen).toEqual([{ since: isoMsZ(NOW - PRESET_MS['1h']), limit: 5 }]);
  });
});
