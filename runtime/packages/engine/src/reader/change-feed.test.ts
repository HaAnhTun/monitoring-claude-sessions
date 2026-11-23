// TC-EVW-02: the follower of the change stream over a scripted transport (ADR 0108): the cursor and the epoch of a
// reconnect, a frame that breaks the contract, the answers that end the feed, and the pause that grows and stops.
import { McsError } from '@mcs/shared';
import { buildRepo, buildTaskWorkspace, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import type { ProbeResult, ProbeState } from '../ops/probe.ts';
import { resolveWorkspace, type WorkspaceRef } from '../workspace/paths.ts';
import type { ApiStreamOpen, StreamAttempt } from './api-reader.ts';
import { FEED_MAX_RECONNECTS, openChangeFeed, type ChangeFeedDeps, type ChangeFeedEvent } from './change-feed.ts';

const makeTemp = useTempDirs();
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';
const AT = '2026-11-20T10:00:00.000Z';
const EPOCH = '0a1b2c3d';
const BASE = 'http://127.0.0.1:18002';

function workspace(): WorkspaceRef {
  const { repo, tasksRoot } = buildRepo(makeTemp('change-feed').path);
  buildTaskWorkspace(repo, {
    slug: 'demo',
    config: { title: 'FIXTURE demo' },
    instance: { slug: 'demo', instanceId: ID, runtimeVersion: '4.0.0', dbSchemaVersion: 1 },
  });
  return resolveWorkspace(tasksRoot, 'demo');
}

function probeOf(state: ProbeState): () => Promise<ProbeResult> {
  const url = state === 'running' ? BASE : null;
  return () =>
    Promise.resolve({
      state,
      engine: 'node',
      pid: 4242,
      url,
      port: url === null ? null : 18002,
      identity: null,
      stateFile: null,
      stateFileBytes: null,
      reason: 'scripted',
    });
}

function frame(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? '' : `id: ${String(id)}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const hello = (headSeq: number): string =>
  frame('hello', {
    instanceId: ID,
    epoch: EPOCH,
    headSeq,
    heartbeatMs: 15000,
    serverTime: AT,
    runtimeVersion: '4.0.0',
    codeStamp: 'stamp',
  });

const change = (seq: number): string =>
  frame('change', { seq, at: AT, instanceId: ID, kind: 'session', op: 'upsert', sessionId: SESSION, data: null }, seq);

/** An answer whose body is `text` and then ends, the way a dropped connection ends. */
function answer(text: string, o: { status?: number; instance?: string } = {}): StreamAttempt {
  return {
    ok: true,
    reply: {
      status: o.status ?? 200,
      headers: { 'x-mcs-instance': o.instance ?? ID },
      body: (async function* () {
        yield await Promise.resolve(new TextEncoder().encode(text));
      })(),
      abort: () => undefined,
    },
  };
}

interface Script {
  readonly deps: ChangeFeedDeps;
  readonly urls: string[];
  readonly accepts: (string | undefined)[];
  readonly sleeps: number[];
}

/** A transport that gives `answers` in order and refuses the connection afterwards. */
function script(state: ProbeState, ...answers: StreamAttempt[]): Script {
  const urls: string[] = [];
  const accepts: (string | undefined)[] = [];
  const sleeps: number[] = [];
  const openStream: ApiStreamOpen = (url, o) => {
    urls.push(url.slice(BASE.length));
    accepts.push(o.accept);
    return Promise.resolve(answers[urls.length - 1] ?? { ok: false, reason: 'refused' });
  };
  return {
    urls,
    accepts,
    sleeps,
    deps: {
      runtimeDir: 'runtime',
      probe: probeOf(state),
      openStream,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
}

async function take(feed: AsyncGenerator<ChangeFeedEvent, void, void>, count: number): Promise<string[]> {
  const seen: string[] = [];
  for await (const event of feed) {
    seen.push(
      event.type === 'change'
        ? `change ${String(event.change.seq)}`
        : event.type === 'hello'
          ? `hello ${event.reconnect ? 'again' : 'first'}`
          : event.type,
    );
    if (seen.length === count) break;
  }
  return seen;
}

async function failure(feed: AsyncGenerator<ChangeFeedEvent, void, void>): Promise<McsError> {
  try {
    let done = false;
    while (!done) done = (await feed.next()).done === true;
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected the feed to fail');
}

describe('openChangeFeed', () => {
  it('reconnects after a drop with the last id and the epoch, and skips what the replay repeats', async () => {
    const s = script(
      'running',
      answer(hello(5) + change(6) + frame('heartbeat', { headSeq: 6, epoch: EPOCH, serverTime: AT })),
      answer(hello(8) + change(6) + change(7) + frame('reset', { headSeq: 9, reason: 'cursor_too_old' }, 9)),
      answer(hello(9)),
    );
    const seen = await take(openChangeFeed(workspace(), s.deps), 7);
    expect(seen).toEqual(['hello first', 'change 6', 'heartbeat', 'hello again', 'change 7', 'reset', 'hello again']);
    expect(s.urls).toEqual([
      '/api/v3/stream',
      `/api/v3/stream?epoch=${EPOCH}&since=6`,
      `/api/v3/stream?epoch=${EPOCH}&since=9`,
    ]);
    expect(s.accepts[0]).toBe('text/event-stream');
    expect(s.sleeps).toEqual([1000, 1000]);
  });

  it('starts a replay at the cursor it was given', async () => {
    const s = script('running', answer(hello(5) + change(4)));
    expect(await take(openChangeFeed(workspace(), s.deps, { since: 3 }), 2)).toEqual(['hello first', 'change 4']);
    expect(s.urls).toEqual(['/api/v3/stream?since=3']);
  });

  it('ends with API_ERROR on a frame that breaks the contract, and skips an event name it does not know', async () => {
    const bad = frame('change', { seq: 'six', kind: 'session', op: 'upsert' }, 6);
    const s = script('running', answer(hello(5) + frame('later', { any: 1 }) + bad));
    const error = await failure(openChangeFeed(workspace(), s.deps));
    expect(error.code).toBe('API_ERROR');
    expect(error.details).toMatchObject({ reason: 'contract' });
    expect(s.urls).toHaveLength(1);
  });

  it('maps the answers that end a feed: not running, another instance, no free stream', async () => {
    const stopped = await failure(openChangeFeed(workspace(), script('stopped').deps));
    expect(stopped.code).toBe('INSTANCE_NOT_RUNNING');

    const foreign = await failure(
      openChangeFeed(workspace(), script('running', answer(hello(1), { instance: OTHER })).deps),
    );
    expect(foreign.code).toBe('IDENTITY_MISMATCH');

    const body = JSON.stringify({ error: { code: 'stream_limit', message: 'x', requestId: 'r-abcdefghijkl' } });
    const full = await failure(openChangeFeed(workspace(), script('running', answer(body, { status: 503 })).deps));
    expect(full.code).toBe('API_ERROR');
    expect(full.details).toMatchObject({ reason: 'stream_limit' });
    expect(full.hint).toContain('close a monitor tab');
  });

  it('pauses 1, 2, 4, 8 s and then 8 s, and gives up after eight reconnects without a frame', async () => {
    const s = script('running');
    const error = await failure(openChangeFeed(workspace(), s.deps));
    expect(error.code).toBe('INSTANCE_NOT_RUNNING');
    expect(s.sleeps).toEqual([1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000]);
    expect(s.urls).toHaveLength(FEED_MAX_RECONNECTS + 1);
  });

  it('returns quietly when the signal aborts', async () => {
    const stop = new AbortController();
    const s = script('running', answer(hello(5)));
    const seen: string[] = [];
    for await (const event of openChangeFeed(workspace(), s.deps, { signal: stop.signal })) {
      seen.push(event.type);
      stop.abort();
    }
    expect(seen).toEqual(['hello']);
    expect(s.sleeps).toEqual([]);
  });
});
