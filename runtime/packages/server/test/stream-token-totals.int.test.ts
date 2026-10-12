// LF-9 (CR-LF-7-1): after a turn is appended to an existing session, the LAST `session/upsert` frame of that session carries the
// committed token totals, i.e. it equals `GET /sessions/:id` (03 9.3, DA-I6: the frame data is the committed rollups). The usage
// of a slice is committed by the importer after the batch that announced the session change, so a frame hydrated at the first
// commit would carry the new `lastActivityAt` with the old totals.
import { request, type ClientRequest } from 'node:http';

import { routes, type SessionSummary } from '@mcs/shared';
import { waitFor } from '@mcs/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appendFixtureTurn } from './helpers/skeleton-live.ts';
import { FIXTURE_SESSION_A, startSkeletonInstance, type SkeletonInstance } from './helpers/skeleton-instance.ts';

let instance: SkeletonInstance;
let open: StreamClient | undefined;

beforeAll(async () => {
  instance = await startSkeletonInstance();
}, 180_000);

afterAll(async () => {
  open?.close();
  await instance.stop();
}, 60_000);

interface ChangeFrame {
  readonly seq: number;
  readonly kind: string;
  readonly op: string;
  readonly sessionId: string | null;
  readonly data: unknown;
}

/** A raw event stream client that keeps the `change` frames it has seen. */
class StreamClient {
  readonly changes: ChangeFrame[] = [];
  /** True once the `hello` frame arrived: the stream is live from its head. */
  hello = false;
  private pending = '';
  private readonly req: ClientRequest;

  constructor(port: number) {
    this.req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/v3/stream',
        method: 'GET',
        headers: { Host: `127.0.0.1:${String(port)}`, Accept: 'text/event-stream' },
        agent: false,
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (text: string) => {
          this.pending += text;
          for (let end = this.pending.indexOf('\n\n'); end >= 0; end = this.pending.indexOf('\n\n')) {
            const block = this.pending.slice(0, end);
            this.pending = this.pending.slice(end + 2);
            this.take(block);
          }
        });
        res.on('error', () => undefined);
      },
    );
    this.req.on('error', () => undefined);
    this.req.end();
  }

  private take(block: string): void {
    let event = '';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
    }
    if (event === 'hello') this.hello = true;
    if (event !== 'change' || data.length === 0) return;
    this.changes.push(JSON.parse(data.join('\n')) as ChangeFrame);
  }

  close(): void {
    this.req.destroy();
  }
}

/** The last `session/upsert` frame of the session, or undefined. */
function lastSessionUpsert(client: StreamClient, id: string): ChangeFrame | undefined {
  return client.changes.findLast(
    (frame) => frame.kind === 'session' && frame.op === 'upsert' && frame.sessionId === id,
  );
}

describe('stream session/upsert frames carry the committed token totals (CR-LF-7-1)', () => {
  it('the last session/upsert after an appended turn equals GET /sessions/:id, usage included', async () => {
    const before = routes.getSession.response.parse(
      (await instance.getJson(routes.getSession.path.replace(':sessionId', FIXTURE_SESSION_A))).body,
    );
    open = new StreamClient(instance.port);
    const stream = open;
    // the stream is live from its head: the file changes only after the connection is established
    await waitFor(() => stream.hello, { what: 'the hello frame of the stream', timeoutMs: 10_000, intervalMs: 50 });
    const want = appendFixtureTurn(instance.paths);
    expect(want.own.output).toBeGreaterThan(before.usage.output ?? 0);

    const detailPath = routes.getSession.path.replace(':sessionId', FIXTURE_SESSION_A);
    // the REST read settles first: the importer has applied the usage of the new turn
    await waitFor(
      async () => {
        const reply = await instance.getJson(detailPath);
        return reply.status === 200 && routes.getSession.response.parse(reply.body).usage.output === want.own.output;
      },
      { what: 'GET /sessions/:id shows the new token totals', timeoutMs: 30_000, intervalMs: 100 },
    );
    // the stream catches up with the committed state: it delivers every change up to the head the REST read saw
    const { asOfSeq } = routes.getSession.response.parse((await instance.getJson(detailPath)).body);
    await waitFor(() => stream.changes.some((frame) => frame.seq >= asOfSeq), {
      what: `the stream reaches seq ${String(asOfSeq)}`,
      timeoutMs: 30_000,
      intervalMs: 50,
    });

    const last = lastSessionUpsert(stream, FIXTURE_SESSION_A);
    expect(last, 'a session/upsert frame of the session').toBeDefined();
    const frame = last?.data as SessionSummary | null | undefined;
    expect(frame, 'the frame carries the session').toBeTruthy();
    const detail = routes.getSession.response.parse((await instance.getJson(detailPath)).body);
    expect(frame?.usage.output).toBe(want.own.output);
    expect(frame?.usageInclSubagents.output).toBe(want.inclSubagents.output);
    expect(frame?.usage).toEqual(detail.usage);
    expect(frame?.usageInclSubagents).toEqual(detail.usageInclSubagents);
    expect(frame?.lastActivityAt).toBe(detail.lastActivityAt);
  }, 120_000);
});
