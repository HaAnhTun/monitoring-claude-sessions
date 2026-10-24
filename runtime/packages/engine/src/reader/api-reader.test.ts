// `ApiReader` (01 6.1, 03 12.2, T-CLI-05 unit part): URLs come from the route registry, every body is validated with the response
// schema of its route, the `X-MCS-Instance` header of every answer must name the instance of the workspace, a redirect is never
// followed, a request carries no body, and an error envelope becomes the same `McsError` the `DbReader` raises. The HTTP client is
// scripted for the contract checks and real (a loopback server on a test port) for the wire behaviour.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Readable, Writable } from 'node:stream';

import { EXPORT_FORMAT, McsError, routeUrl, routes } from '@mcs/shared';
import { allocatePort } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import type { HttpFullAttempt } from '../ops/probe.ts';
import {
  createApiReader,
  loopbackStream,
  type ApiHttpGet,
  type ApiStreamOpen,
  type StreamedReply,
} from './api-reader.ts';
import { readerErrorOfCode } from './open.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SESSION = 'aaaaaaaa-0000-4000-8000-000000000001';
const BASE = 'http://127.0.0.1:18001';
const LF = String.fromCharCode(10);

const EMPTY_PAGE = { items: [], nextCursor: null, asOfSeq: 3, total: 0, totalIsLowerBound: false, limit: 50 };

function reply(status: number, body: unknown, instance: string | null = ID): HttpFullAttempt {
  return {
    ok: true,
    reply: {
      status,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: instance === null ? {} : { 'x-mcs-instance': instance },
    },
  };
}

function envelope(code: string, status: number, instance: string | null = ID): HttpFullAttempt {
  return reply(status, { error: { code, message: 'x', requestId: 'r-abcdefghijkl' } }, instance);
}

function scripted(...answers: HttpFullAttempt[]): { get: ApiHttpGet; urls: string[] } {
  const urls: string[] = [];
  let next = 0;
  return {
    urls,
    get: (url) => {
      urls.push(url);
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      if (answer === undefined) throw new Error('no scripted answer');
      return Promise.resolve(answer);
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<McsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

function reasonOf(error: McsError): unknown {
  return error.details?.['reason'];
}

const readerWith = (get: ApiHttpGet, extra: Partial<Parameters<typeof createApiReader>[0]> = {}) =>
  createApiReader({ base: BASE, instanceId: ID, httpGet: get, ...extra });

describe('createApiReader: the address', () => {
  it('accepts only http://127.0.0.1:<port>', () => {
    for (const base of [
      'http://localhost:18001',
      'http://10.0.0.5:18001',
      'https://127.0.0.1:18001',
      'http://127.0.0.1',
      'http://127.0.0.1:18001/',
      'http://127.0.0.1:18001/api',
      'http://[::1]:18001',
      'http://127.0.0.1:0',
      '',
    ]) {
      expect(() => createApiReader({ base, instanceId: ID }), base).toThrow(McsError);
    }
    expect(createApiReader({ base: BASE, instanceId: ID }).mode).toBe('api');
  });
});

describe('ApiReader: URLs and bodies', () => {
  it('builds every URL with routeUrl from the registry', async () => {
    const s = scripted(
      reply(200, EMPTY_PAGE),
      reply(200, { ...EMPTY_PAGE, limit: 200 }),
      reply(200, { asOfSeq: 1, items: [] }),
    );
    const reader = readerWith(s.get);
    const sessionsQuery = {
      includeTotal: true as const,
      limit: 7,
      sort: 'lastActivity' as const,
      state: ['failed' as const, 'stale' as const],
    };
    await reader.sessions(sessionsQuery);
    await reader.sessionAgents(SESSION, { limit: 200 });
    await reader.errors({ limit: 5, source: ['spool'] });
    expect(s.urls).toEqual([
      `${BASE}${routeUrl(routes.listSessions, { query: sessionsQuery })}`,
      `${BASE}${routeUrl(routes.sessionAgents, { params: { sessionId: SESSION }, query: { limit: 200 } })}`,
      `${BASE}${routeUrl(routes.errors, { query: { limit: 5, source: ['spool'] } })}`,
    ]);
    expect(s.urls[0]).toBe(`${BASE}/api/v3/sessions?includeTotal=1&limit=7&sort=lastActivity&state=failed%2Cstale`);
  });

  it('puts the session of a transcript window in the path and leaves it out of the query', async () => {
    const s = scripted(envelope('transcript_gone', 410));
    const reader = readerWith(s.get);
    const error = await failure(reader.transcriptWindow({ sessionId: SESSION, agent: 'main', after: -1, limit: 5 }));
    expect(s.urls[0]).toBe(`${BASE}/api/v3/sessions/${SESSION}/transcript?after=-1&agent=main&limit=5`);
    expect(error.code).toBe('NOT_FOUND');
    expect(reasonOf(error)).toBe('transcript_gone');
  });

  it('returns the errors of the response as a list', async () => {
    const item = {
      at: '2026-10-20T12:00:00.000Z',
      source: 'spool',
      code: 'TORN',
      where: null,
      message: 'x',
      sessionId: null,
    };
    const reader = readerWith(scripted(reply(200, { asOfSeq: 1, items: [item] })).get);
    expect(await reader.errors({ limit: 50 })).toEqual([item]);
  });

  it('refuses a body that does not match the response schema of the route', async () => {
    const wrong = await failure(
      readerWith(scripted(reply(200, { ...EMPTY_PAGE, extra: 1 })).get).sessions({ limit: 50 } as never),
    );
    expect(wrong.code).toBe('API_ERROR');
    expect(reasonOf(wrong)).toBe('contract');
    const missing = await failure(readerWith(scripted(reply(200, { items: [] })).get).alerts({ limit: 50 } as never));
    expect(reasonOf(missing)).toBe('contract');
    const notJson = await failure(readerWith(scripted(reply(200, '<html>')).get).overview({}));
    expect(reasonOf(notJson)).toBe('body_invalid');
  });

  it('refuses a session id that is not one before it asks', async () => {
    const s = scripted(reply(200, EMPTY_PAGE));
    const error = await failure(readerWith(s.get).session('../etc'));
    expect(error.code).toBe('USAGE');
    expect(s.urls).toEqual([]);
  });
});

describe('ApiReader: the instance header', () => {
  it('refuses an answer of another instance, whatever its status, and uses nothing of it', async () => {
    for (const answer of [
      reply(200, EMPTY_PAGE, OTHER),
      envelope('session_not_found', 404, OTHER),
      reply(200, EMPTY_PAGE, null),
    ]) {
      const error = await failure(readerWith(scripted(answer).get).sessions({ limit: 50 } as never));
      expect(error.code).toBe('IDENTITY_MISMATCH');
    }
    const session = await failure(readerWith(scripted(envelope('session_not_found', 404, OTHER)).get).session(SESSION));
    expect(session.code).toBe('IDENTITY_MISMATCH');
  });
});

describe('ApiReader: failures', () => {
  it('session_not_found is null for session() and NOT_FOUND for the others', async () => {
    const s = scripted(envelope('session_not_found', 404));
    const reader = readerWith(s.get);
    expect(await reader.session(SESSION)).toBeNull();
    const agents = await failure(reader.sessionAgents(SESSION, { limit: 200 }));
    expect(agents.code).toBe('NOT_FOUND');
    expect(reasonOf(agents)).toBe('session_not_found');
  });

  it('maps a refused query to USAGE and a busy search to API_ERROR with a hint', async () => {
    const usage = await failure(readerWith(scripted(envelope('range_invalid', 400)).get).overview({}));
    expect(usage.code).toBe('USAGE');
    const busy = await failure(
      readerWith(scripted(envelope('search_busy', 429)).get).searchTranscripts({
        q: 'ab',
        limit: 1,
        budgetMs: 100,
      }),
    );
    expect(busy.code).toBe('API_ERROR');
    expect(busy.hint).toContain('try again');
  });

  it('maps the two completion errors like the DbReader does', async () => {
    const invalid = await failure(
      readerWith(scripted(envelope('validation_failed', 400)).get).explainCompletion({ label: 'x' }),
    );
    expect(invalid.code).toBe('USAGE');
    expect(reasonOf(invalid)).toBe('target_invalid');
    const missing = await failure(
      readerWith(scripted(envelope('completion_target_not_found', 404)).get).explainCompletion({ sessionId: SESSION }),
    );
    expect(missing.code).toBe('NOT_FOUND');
    expect(reasonOf(missing)).toBe('target_not_found');
    // the message never carries the target (a label can be private)
    expect(JSON.stringify(readerErrorOfCode('completion_target_not_found'))).not.toContain('FIXTURE');
  });

  it('never follows a redirect: a 3xx answer is a failure', async () => {
    const s = scripted({
      ok: true,
      reply: { status: 302, body: '', headers: { 'x-mcs-instance': ID, location: '/elsewhere' } },
    });
    const error = await failure(readerWith(s.get).sessions({ limit: 50 } as never));
    expect(reasonOf(error)).toBe('redirect');
    expect(s.urls).toHaveLength(1);
  });

  it('reports an answer without an envelope, a refused connection, a timeout and a big body', async () => {
    const plain = await failure(readerWith(scripted(reply(500, 'oops')).get).sessions({ limit: 50 } as never));
    expect(reasonOf(plain)).toBe('no_envelope');
    const refused = await failure(
      readerWith(scripted({ ok: false, reason: 'refused' }).get).sessions({ limit: 50 } as never),
    );
    expect(refused.code).toBe('INSTANCE_NOT_RUNNING');
    expect(refused.hint).toContain('again');
    const slow = await failure(
      readerWith(scripted({ ok: false, reason: 'timeout' }).get).sessions({ limit: 50 } as never),
    );
    expect(reasonOf(slow)).toBe('timeout');
    const big = await failure(
      readerWith(scripted({ ok: false, reason: 'too-large' }).get).sessions({ limit: 50 } as never),
    );
    expect(reasonOf(big)).toBe('too_large');
    const broken = await failure(
      readerWith(scripted({ ok: false, reason: 'error' }).get).sessions({ limit: 50 } as never),
    );
    expect(reasonOf(broken)).toBe('request_failed');
  });

  it('a client that throws is a failure, not a crash', async () => {
    const reader = readerWith(() => Promise.reject(new RangeError('only loopback')));
    expect((await failure(reader.sessions({ limit: 50 } as never))).code).toBe('API_ERROR');
  });

  it('gives a search the time of its own budget on top of the request time', async () => {
    const seen: number[] = [];
    const reader = readerWith(
      (_url, o) => {
        seen.push(o.timeoutMs);
        return Promise.resolve(envelope('search_busy', 429));
      },
      { requestTimeoutMs: 1000 },
    );
    await failure(reader.searchTranscripts({ q: 'ab', limit: 1, budgetMs: 5000 }));
    await failure(reader.sessions({ limit: 1 } as never));
    expect(seen[0]).toBeGreaterThan(6000);
    expect(seen[1]).toBe(1000);
  });
});

// ---- the export stream ---------------------------------------------------------------------------------------------------------------

function exportBytes(o: { includeContent?: boolean; tamper?: boolean; noTrailer?: boolean } = {}): {
  text: string;
  sha256: string;
} {
  const header = JSON.stringify({
    type: 'header',
    format: EXPORT_FORMAT,
    instanceId: ID,
    slug: 'demo',
    exportedAt: '2026-10-20T12:00:00.000Z',
    runtimeVersion: '4.0.0',
    dbSchemaVersion: 1,
    scope: { from: null, to: '2026-10-20T12:00:00.000Z', sessions: [] },
    include: ['sessions'],
    redaction: 'standard',
    includeContent: o.includeContent === true,
    privacyNote: 'x',
  });
  const data = [JSON.stringify({ type: 'session', n: 1 }), JSON.stringify({ type: 'session', n: 2 })];
  const before = `${[header, ...data].join(LF)}${LF}`;
  const sha256 = createHash('sha256').update(before).digest('hex');
  const trailer = JSON.stringify({
    type: 'trailer',
    counts: { session: 2 },
    missingTranscripts: [],
    sha256: o.tamper === true ? 'f'.repeat(64) : sha256,
  });
  return { text: o.noTrailer === true ? before : `${before}${trailer}${LF}`, sha256 };
}

function streamOf(
  text: string,
  o: { status?: number; instance?: string | null; split?: number; failAfter?: boolean } = {},
): ApiStreamOpen {
  const bytes = Buffer.from(text);
  const size = o.split ?? bytes.length;
  return () => {
    const state = { aborted: false };
    function* body(): Generator<Uint8Array> {
      for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
      if (o.failAfter === true) throw new Error('connection reset');
    }
    const replyValue: StreamedReply = {
      status: o.status ?? 200,
      headers: o.instance === null ? {} : { 'x-mcs-instance': o.instance ?? ID },
      body: Readable.from(body()),
      abort: () => {
        state.aborted = true;
      },
    };
    return Promise.resolve({ ok: true, reply: replyValue });
  };
}

function sink(): { out: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const out = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  return { out, text: () => Buffer.concat(chunks).toString('utf8') };
}

describe('ApiReader.exportTo', () => {
  it('copies the stream to the output and reports the lines, bytes, counts and checksum of the trailer', async () => {
    const good = exportBytes({ includeContent: true });
    const o = sink();
    // chunks that cut lines in the middle
    const reader = createApiReader({ base: BASE, instanceId: ID, openStream: streamOf(good.text, { split: 37 }) });
    const summary = await reader.exportTo({ includeContent: true }, o.out);
    expect(o.text()).toBe(good.text);
    expect(summary).toEqual({
      lines: 4,
      bytes: Buffer.byteLength(good.text),
      sha256: good.sha256,
      counts: { session: 2 },
      includeContent: true,
    });
  });

  it('refuses a stream whose checksum does not match, or that has no trailer, or that is cut', async () => {
    for (const [name, text, options] of [
      ['checksum', exportBytes({ tamper: true }).text, {}],
      ['no trailer', exportBytes({ noTrailer: true }).text, {}],
      ['cut inside a line', exportBytes().text.slice(0, -40), {}],
      ['connection reset', exportBytes().text.slice(0, 200), { failAfter: true }],
    ] as const) {
      const reader = createApiReader({ base: BASE, instanceId: ID, openStream: streamOf(text, options) });
      const error = await failure(reader.exportTo({}, sink().out));
      expect(error.code, name).toBe('API_ERROR');
      expect(reasonOf(error), name).toBe('export_cut');
    }
  });

  it('writes nothing when the header names another instance, and maps an error envelope', async () => {
    const o = sink();
    const other = createApiReader({
      base: BASE,
      instanceId: ID,
      openStream: streamOf(exportBytes().text, { instance: OTHER }),
    });
    expect((await failure(other.exportTo({}, o.out))).code).toBe('IDENTITY_MISMATCH');
    expect(o.text()).toBe('');
    const body = JSON.stringify({ error: { code: 'export_busy', message: 'x', requestId: 'r-abcdefghijkl' } });
    const busy = createApiReader({ base: BASE, instanceId: ID, openStream: streamOf(body, { status: 429 }) });
    const error = await failure(busy.exportTo({}, o.out));
    expect(error.code).toBe('API_ERROR');
    expect(reasonOf(error)).toBe('export_busy');
    expect(o.text()).toBe('');
  });

  it('turns a failing output into an error that says so', async () => {
    const out = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error('disk full'));
      },
    });
    out.on('error', () => undefined);
    const reader = createApiReader({ base: BASE, instanceId: ID, openStream: streamOf(exportBytes().text) });
    expect(reasonOf(await failure(reader.exportTo({}, out)))).toBe('output');
  });

  it('maps a 400 of the export route to USAGE', async () => {
    const body = JSON.stringify({ error: { code: 'validation_failed', message: 'x', requestId: 'r-abcdefghijkl' } });
    const reader = createApiReader({ base: BASE, instanceId: ID, openStream: streamOf(body, { status: 400 }) });
    expect((await failure(reader.exportTo({ includeContent: true, redaction: 'strict' }, sink().out))).code).toBe(
      'USAGE',
    );
  });
});

// ---- the wire ---------------------------------------------------------------------------------------------------------------------------

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

async function serve(
  handler: (req: IncomingMessage) => { status: number; headers?: Record<string, string>; body?: string },
): Promise<{
  base: string;
  requests: { method: string | undefined; url: string | undefined; bytes: number; host: string | undefined }[];
}> {
  const port = await allocatePort();
  const requests: { method: string | undefined; url: string | undefined; bytes: number; host: string | undefined }[] =
    [];
  const server = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, bytes, host: req.headers.host });
      const answer = handler(req);
      res.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers });
      res.end(answer.body ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen({ port, host: '127.0.0.1' }, resolve);
  });
  return { base: `http://127.0.0.1:${String(port)}`, requests };
}

describe('ApiReader over a real loopback connection', () => {
  it('sends a GET without a body and reads the body with the right instance header', async () => {
    const live = await serve(() => ({
      status: 200,
      headers: { 'X-MCS-Instance': ID },
      body: JSON.stringify(EMPTY_PAGE),
    }));
    const reader = createApiReader({ base: live.base, instanceId: ID });
    const page = await reader.sessions({ limit: 50 } as never);
    expect(page.total).toBe(0);
    expect(live.requests).toHaveLength(1);
    expect(live.requests[0]).toMatchObject({ method: 'GET', bytes: 0, host: live.base.slice('http://'.length) });
    expect(live.requests[0]?.url).toBe('/api/v3/sessions?limit=50');
  });

  it('does not follow a redirect to another path', async () => {
    const live = await serve((req) =>
      req.url === '/elsewhere'
        ? { status: 200, headers: { 'X-MCS-Instance': ID }, body: JSON.stringify(EMPTY_PAGE) }
        : { status: 302, headers: { 'X-MCS-Instance': ID, Location: '/elsewhere' } },
    );
    const reader = createApiReader({ base: live.base, instanceId: ID });
    const error = await failure(reader.sessions({ limit: 50 } as never));
    expect(reasonOf(error)).toBe('redirect');
    expect(live.requests.map((r) => r.url)).toEqual(['/api/v3/sessions?limit=50']);
  });

  it('a port reused by another instance is refused', async () => {
    const live = await serve(() => ({
      status: 200,
      headers: { 'X-MCS-Instance': OTHER },
      body: JSON.stringify(EMPTY_PAGE),
    }));
    const reader = createApiReader({ base: live.base, instanceId: ID });
    expect((await failure(reader.sessions({ limit: 50 } as never))).code).toBe('IDENTITY_MISMATCH');
  });

  it('a port nobody listens on is INSTANCE_NOT_RUNNING, quickly', async () => {
    const port = await allocatePort();
    const reader = createApiReader({
      base: `http://127.0.0.1:${String(port)}`,
      instanceId: ID,
      requestTimeoutMs: 2000,
    });
    const started = performance.now();
    expect((await failure(reader.sessions({ limit: 50 } as never))).code).toBe('INSTANCE_NOT_RUNNING');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('streams an export over the wire and checks it', async () => {
    const good = exportBytes();
    const live = await serve(() => ({
      status: 200,
      headers: { 'X-MCS-Instance': ID, 'Content-Type': 'application/x-ndjson' },
      body: good.text,
    }));
    const o = sink();
    const reader = createApiReader({ base: live.base, instanceId: ID });
    const summary = await reader.exportTo({}, o.out);
    expect(o.text()).toBe(good.text);
    expect(summary.sha256).toBe(good.sha256);
    expect(live.requests[0]).toMatchObject({ method: 'GET', bytes: 0, url: '/api/v3/export' });
  });

  it('the streaming client refuses an address that is not loopback', async () => {
    expect(await loopbackStream('http://203.0.113.9:80/x', { idleTimeoutMs: 100 })).toEqual({
      ok: false,
      reason: 'error',
    });
  });

  it('a hung server ends the request with a timeout', async () => {
    const port = await allocatePort();
    const hung = createServer(() => undefined);
    servers.push(hung);
    await new Promise<void>((resolve) => {
      hung.listen({ port, host: '127.0.0.1' }, resolve);
    });
    const reader = createApiReader({ base: `http://127.0.0.1:${String(port)}`, instanceId: ID, requestTimeoutMs: 300 });
    const started = performance.now();
    expect(reasonOf(await failure(reader.sessions({ limit: 50 } as never)))).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
