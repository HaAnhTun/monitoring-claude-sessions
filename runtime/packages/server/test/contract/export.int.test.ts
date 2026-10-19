// `GET /api/v3/export` on a real instance behind a real HTTP server (03 11.1, 19.8, DA-T-E-1 and DA-T-E-2 over HTTP, WP-60): the
// NDJSON stream with its header and trailer, the copy of the database it reads from (`data/exports/.tmp-*.db`), the one export
// at a time (`429 export_busy`, `Retry-After: 2`), and the copy that is gone after a success, after a failure, after a client
// that leaves and after the server closes its connections. Every row and transcript is synthetic.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request, type ClientRequest, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';

import {
  buildInstanceContext,
  defaultSkillDir,
  initWorkspace,
  type InstanceContext,
  type Logger,
  type SqlValue,
} from '@mcs/engine';
import { ErrorEnvelopeSchema, ExportLineSchema, RUNTIME_VERSION, routes, type ExportLine } from '@mcs/shared';
import {
  FakeClock,
  TranscriptBuilder,
  allocatePort,
  assertPortClosed,
  httpRequest,
  useTempDirs,
  waitFor,
} from '@mcs/testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, createHttpServer } from '../../src/app.ts';
import { readLegacyTask } from '../../src/routes/meta.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 3_600_000;
const ID = '11111111-1111-4111-8111-111111111111';
const EXPORT = '/api/v3/export';
const SECRET_PROMPT = 'SENTINEL-PROMPT-TEXT-0001';

interface Running {
  readonly ctx: InstanceContext;
  readonly port: number;
  readonly server: Server;
  readonly instanceDir: string;
  readonly exports: string;
}

const live: { server: Server; ctx: InstanceContext; port: number; closed: boolean }[] = [];
const requests: ClientRequest[] = [];

// the transcript service looks for the project folder below the Claude home of the environment: an empty temp home keeps the real
// one unread, and the folder of the main transcript stays the containment root
beforeEach(() => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', makeTemp('claude-home').path);
});

afterEach(async () => {
  for (const req of requests.splice(0)) req.destroy();
  for (const entry of live.splice(0)) {
    if (!entry.closed) {
      await new Promise<void>((resolve) => {
        entry.server.closeAllConnections();
        entry.server.close(() => {
          resolve();
        });
      });
    }
    entry.ctx.db.close();
    await assertPortClosed(entry.port);
  }
});

function silentLogger(): Logger {
  const none = (): void => undefined;
  return {
    debug: none,
    info: none,
    warn: none,
    error: none,
    stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
    close: () => Promise.resolve(),
  };
}

async function startInstance(): Promise<Running> {
  const root = makeTemp('export-contract').path;
  const skill = path.join(root, 'skill');
  const runtimeDir = path.join(skill, 'runtime');
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), path.join(skill, 'config', 'defaults.json'));
  writeFileSync(path.join(runtimeDir, 'defaults.json'), '{"schema_version": 1}\n');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const clock = new FakeClock(NOW);
  const { ws } = await initWorkspace({ repo, name: 'Demo', slug: 'demo', clock, newId: () => ID });
  const ctx = await buildInstanceContext({
    instanceDir: ws.dir,
    env: { MCS_HOME: path.join(root, 'mcs-home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') },
    cli: {},
    skillDir: skill,
    runtimeDir,
    build: { runtimeVersion: RUNTIME_VERSION, codeStamp: 'abcdef0123' },
    clock,
    logger: silentLogger(),
  });
  const port = await allocatePort();
  const app = createApp({
    ctx,
    port: () => port,
    nudge: () => undefined,
    task: await readLegacyTask(ws.dir),
    validateResponses: true,
  });
  const server = createHttpServer(app, ctx.config.runtime.server.requestTimeoutMs);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });
  live.push({ server, ctx, port, closed: false });
  return { ctx, port, server, instanceDir: ws.dir, exports: path.join(ws.dir, 'data', 'exports') };
}

// ---- seeding -----------------------------------------------------------------------------------------------------------------

function put(ctx: InstanceContext, table: string, row: Record<string, SqlValue>): number {
  const columns = Object.keys(row);
  return ctx.db.driver
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `:${c}`).join(', ')})`)
    .run(row).lastInsertRowid;
}

const uidOf = (n: number): string => `cccccccc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface Added {
  readonly id: number;
  readonly uid: string;
  readonly agentId: number;
}

function addSession(ctx: InstanceContext, n: number, over: Record<string, SqlValue> = {}): Added {
  const uid = uidOf(n);
  const id = put(ctx, 'sessions', {
    session_uid: uid,
    label: `FIXTURE session ${String(n)}`,
    matched: 1,
    first_seen_at: NOW - 2 * HOUR,
    started_at: NOW - 2 * HOUR,
    last_activity_at: NOW - HOUR,
    updated_at: NOW,
    ...over,
  });
  const agentId = put(ctx, 'agents', {
    session_id: id,
    agent_uid: 'main',
    kind: 'main',
    depth: 0,
    first_seen_at: NOW - 2 * HOUR,
    started_at: NOW - 2 * HOUR,
    last_activity_at: NOW - HOUR,
    updated_at: NOW,
  });
  return { id, uid, agentId };
}

let eventCounter = 0;

/** `count` events of a session in one transaction. */
function addEvents(ctx: InstanceContext, s: Added, count: number): void {
  ctx.db.driver.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      eventCounter += 1;
      put(ctx, 'events', {
        session_id: s.id,
        agent_id: s.agentId,
        kind: 'tool.call',
        sources: 1,
        ts: NOW - HOUR + i,
        ts_source: 'record',
        received_at: NOW - HOUR + i,
        natural_key: `fixture:event:${String(eventCounter)}`,
        summary: 'FIXTURE summary of an event, long enough to give every line some weight in the stream',
      });
    }
  });
}

// ---- requests ----------------------------------------------------------------------------------------------------------------

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

async function get(run: Running, url: string, method = 'GET'): Promise<Reply> {
  const reply = await httpRequest(run.port, url, { method });
  return { status: reply.status, headers: reply.headers, body: reply.body };
}

function codeOf(reply: Reply): string | undefined {
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(reply.body));
  return parsed.success ? parsed.data.error.code : undefined;
}

function linesOf(body: string): ExportLine[] {
  return body
    .split('\n')
    .filter((line) => line !== '')
    .map((line): ExportLine => {
      const parsed = ExportLineSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`not a line of the export: ${line.slice(0, 300)}`);
      return parsed.data;
    });
}

/** An export request whose body is not read until `resume`: the server fills its buffers and waits for `drain`. */
interface Slow {
  readonly req: ClientRequest;
  readonly res: IncomingMessage;
  /** Reads the rest; `complete` is false when the stream ended without its last chunk (the server cut it). */
  resume(): Promise<{ body: string; complete: boolean }>;
}

function openExport(run: Running, query = ''): Promise<Slow> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: run.port,
        path: `${EXPORT}${query}`,
        agent: false,
        headers: { Host: `127.0.0.1:${String(run.port)}` },
      },
      (res) => {
        res.pause();
        const chunks: Buffer[] = [];
        let ended = false;
        let finished: (value: { body: string; complete: boolean }) => void = () => undefined;
        const done = new Promise<{ body: string; complete: boolean }>((ok) => {
          finished = ok;
        });
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('end', () => {
          ended = true;
          finished({ body: Buffer.concat(chunks).toString('utf8'), complete: true });
        });
        // a connection that the server destroys ends the stream with an error or a close, never with `end`
        res.once('error', () => undefined);
        res.once('close', () => {
          if (!ended) finished({ body: Buffer.concat(chunks).toString('utf8'), complete: false });
        });
        resolve({
          req,
          res,
          resume: () => {
            res.resume();
            return done;
          },
        });
      },
    );
    requests.push(req);
    req.once('error', reject);
    req.end();
  });
}

/** Everything the server keeps in `data/exports/`: the copies, and the files SQLite makes next to a copy it reads. */
function leftovers(run: Running): string[] {
  return existsSync(run.exports) ? readdirSync(run.exports).filter((name) => name.startsWith('.tmp-')) : [];
}

/** The copies of the database (`.tmp-<random>.db`) that exist now. */
function snapshots(run: Running): string[] {
  return leftovers(run).filter((name) => name.endsWith('.db'));
}

// ---- the stream ------------------------------------------------------------------------------------------------------------

describe('GET /api/v3/export', () => {
  it('streams the instance as JSON lines with a header and a trailer, and leaves no copy behind', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    addSession(run.ctx, 2);
    addEvents(run.ctx, s, 5);

    const reply = await get(run, EXPORT);

    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(reply.headers['content-disposition']).toBe('attachment; filename="mcs-export-demo.jsonl"');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.headers['x-mcs-instance']).toBe(ID);
    expect(reply.headers['x-request-id']).toMatch(/^r-[0-9a-z]{12}$/);
    expect(reply.headers['transfer-encoding']).toBe('chunked');
    const lines = linesOf(reply.body);
    expect(lines.map((line) => line.type)).toEqual([
      'header',
      'session',
      'session',
      'agent',
      'agent',
      'event',
      'event',
      'event',
      'event',
      'event',
      'trailer',
    ]);
    expect(lines[0]).toMatchObject({ format: 'mcs.export/1', instanceId: ID, slug: 'demo', includeContent: false });
    const trailer = lines.at(-1);
    expect(trailer).toMatchObject({ counts: { session: 2, agent: 2, event: 5 }, missingTranscripts: [] });
    expect(leftovers(run)).toEqual([]);
  });

  it('exports with the filters of the query', async () => {
    const run = await startInstance();
    const a = addSession(run.ctx, 1);
    const b = addSession(run.ctx, 2, { label: 'FIXTURE first prompt', label_source: 'first_prompt' });
    addEvents(run.ctx, a, 2);
    addEvents(run.ctx, b, 3);

    const one = linesOf((await get(run, `${EXPORT}?session=${b.uid}&include=sessions,events`)).body);
    expect(one.map((line) => line.type)).toEqual(['header', 'session', 'event', 'event', 'event', 'trailer']);
    const strict = linesOf((await get(run, `${EXPORT}?redaction=strict&include=sessions`)).body);
    const labels = strict.flatMap((line) => (line.type === 'session' ? [line.data.label] : []));
    expect(labels.sort()).toEqual(['', 'FIXTURE session 1']);
    expect(strict[0]).toMatchObject({ type: 'header', redaction: 'strict' });
  });

  it('exports the transcripts of the sessions with includeContent=1, and only then', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    const transcript = path.join(run.instanceDir, 'transcripts', `${s.uid}.jsonl`);
    new TranscriptBuilder({ sessionId: s.uid, cwd: 'FIXTURE/cwd', startMs: NOW - 3 * HOUR })
      .user(SECRET_PROMPT)
      .assistant({ messageId: 'msg_fixture_1', text: 'FIXTURE reply' })
      .write(transcript);
    put(run.ctx, 'transcript_files', {
      path: transcript,
      path_key: transcript.toLowerCase(),
      kind: 'session',
      session_uid: s.uid,
      session_id: s.id,
      agent_id: s.agentId,
      discovered_at: NOW,
      updated_at: NOW,
    });

    const plain = await get(run, EXPORT);
    expect(plain.body).not.toContain(SECRET_PROMPT);
    const withContent = linesOf((await get(run, `${EXPORT}?includeContent=1`)).body);
    const transcripts = withContent.flatMap((line) => (line.type === 'transcript' ? [line] : []));
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toMatchObject({ sessionId: s.uid, agentId: 'main' });
    expect(transcripts[0]?.entries.map((entry) => [entry.k, entry.text])).toEqual([
      ['prompt', SECRET_PROMPT],
      ['say', 'FIXTURE reply'],
    ]);
    expect(withContent[0]).toMatchObject({
      includeContent: true,
      privacyNote: 'Contains transcript text: treat as confidential.',
    });
    expect(leftovers(run)).toEqual([]);
  });

  it('answers HEAD with the headers of an export and no copy', async () => {
    const run = await startInstance();
    addSession(run.ctx, 1);
    const reply = await get(run, EXPORT, 'HEAD');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/x-ndjson; charset=utf-8');
    expect(reply.body).toBe('');
    expect(leftovers(run)).toEqual([]);
  });

  it('answers the envelope of the right code for a request no export can answer', async () => {
    const run = await startInstance();
    addSession(run.ctx, 1);
    const cases: [string, number, string][] = [
      [`${EXPORT}?redaction=strict&includeContent=1`, 400, 'validation_failed'],
      [`${EXPORT}?redaction=thorough`, 400, 'validation_failed'],
      [`${EXPORT}?include=nothing`, 400, 'validation_failed'],
      [`${EXPORT}?file=out.jsonl`, 400, 'validation_failed'],
      [`${EXPORT}?path=..%2F..%2Felsewhere.jsonl`, 400, 'validation_failed'],
      [`${EXPORT}?out=data%2Fexports%2Fx.db`, 400, 'validation_failed'],
      [`${EXPORT}?session=${uidOf(1)}&session=${uidOf(2)}`, 400, 'param_repeated'],
      [`${EXPORT}?from=2026-10-20T12:00:00Z&to=2026-10-19T12:00:00Z`, 400, 'range_invalid'],
      [`${EXPORT}?to=2026-10-19T12:00:00Z`, 400, 'range_invalid'],
      [`${EXPORT}?range=7d&from=2026-10-19T12:00:00Z`, 400, 'range_invalid'],
    ];
    for (const [url, status, code] of cases) {
      const reply = await get(run, url);
      expect([reply.status, codeOf(reply)], url).toEqual([status, code]);
      expect(reply.headers['content-type']).toContain('application/json');
    }
    // a refusal is answered before a copy is made
    expect(leftovers(run)).toEqual([]);
    const post = await httpRequest(run.port, EXPORT, { method: 'POST' });
    expect(post.status).toBe(405);
  });
});

// ---- the copy -------------------------------------------------------------------------------------------------------------------

/** Enough events that the export outgrows every buffer between the server and a client that does not read. */
const BIG = 40_000;

describe('the copy of the database', () => {
  it('reads from a copy of the database made when the export began, not from the live connection', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    addEvents(run.ctx, s, BIG);

    const slow = await openExport(run);
    // the copy exists while the export runs, and a change of the live database after it began is not part of the export
    await waitFor(() => snapshots(run).length === 1, { timeoutMs: 5000 });
    addSession(run.ctx, 2);
    run.ctx.db.driver.prepare('DELETE FROM events WHERE id <= 100').run();
    const done = await slow.resume();

    expect(done.complete).toBe(true);
    const lines = linesOf(done.body);
    expect(lines.flatMap((line) => (line.type === 'session' ? [line.data.id] : []))).toEqual([uidOf(1)]);
    expect(lines.filter((line) => line.type === 'event')).toHaveLength(BIG);
    expect(lines.at(-1)).toMatchObject({ type: 'trailer', counts: { session: 1, agent: 1, event: BIG } });
    await waitFor(() => leftovers(run).length === 0, { timeoutMs: 5000 });
  }, 60_000);

  it('answers 429 export_busy with Retry-After 2 while an export runs, and takes the next one when it is done', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    addEvents(run.ctx, s, BIG);

    const first = await openExport(run);
    const busy = await get(run, EXPORT);
    expect([busy.status, codeOf(busy)]).toEqual([429, 'export_busy']);
    expect(busy.headers['retry-after']).toBe('2');
    // the refused request made no copy of its own
    expect(snapshots(run)).toHaveLength(1);

    const done = await first.resume();
    expect(done.complete).toBe(true);
    await waitFor(() => leftovers(run).length === 0, { timeoutMs: 5000 });
    const next = await get(run, `${EXPORT}?include=sessions`);
    expect(next.status).toBe(200);
  }, 60_000);

  it('deletes the copy when the client leaves in the middle of the stream, and takes the next export', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    addEvents(run.ctx, s, BIG);

    const slow = await openExport(run);
    expect(snapshots(run)).toHaveLength(1);
    slow.res.destroy();
    slow.req.destroy();
    await waitFor(() => leftovers(run).length === 0, { timeoutMs: 10_000 });
    const next = await get(run, `${EXPORT}?include=sessions`);
    expect(next.status).toBe(200);
    expect(linesOf(next.body).at(-1)).toMatchObject({ type: 'trailer', counts: { session: 1 } });
  }, 60_000);

  it('deletes the copy when the server closes its connections (shutdown)', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    addEvents(run.ctx, s, BIG);

    const slow = await openExport(run);
    expect(snapshots(run)).toHaveLength(1);
    const entry = live.find((candidate) => candidate.port === run.port);
    if (entry === undefined) throw new Error('the instance is not tracked');
    // what the boot code does when the deadline of the shutdown passes
    await new Promise<void>((resolve) => {
      run.server.close(() => {
        resolve();
      });
      run.server.closeAllConnections();
    });
    entry.closed = true;
    const cut = await slow.resume();
    expect(cut.complete).toBe(false);
    expect(cut.body).not.toContain('"type":"trailer"');
    await waitFor(() => leftovers(run).length === 0, { timeoutMs: 10_000 });
  }, 60_000);

  it('deletes the copy and cuts the stream when the export fails after it began; no clean end hides the missing trailer', async () => {
    const run = await startInstance();
    const s = addSession(run.ctx, 1);
    addEvents(run.ctx, s, 200);
    // the alerts table is read last: the copy has none, so the failure comes after the headers and many lines
    run.ctx.db.driver.exec('DROP TABLE alert_state');
    run.ctx.db.driver.exec('DROP TABLE alerts');

    const slow = await openExport(run);
    const cut = await slow.resume();

    expect(cut.complete).toBe(false);
    expect(cut.body).not.toContain('"type":"trailer"');
    expect(cut.body).toContain('"type":"event"');
    await waitFor(() => leftovers(run).length === 0, { timeoutMs: 10_000 });
    expect(run.ctx.errors.list(10).map((entry) => entry.code)).toContain('INTERNAL');
    // the next export is taken: the busy flag was released (it fails the same way, but it starts)
    const next = await openExport(run);
    const again = await next.resume();
    expect(again.complete).toBe(false);
  }, 60_000);

  it('leaves a copy that a crashed run left behind alone, and exports around it', async () => {
    const run = await startInstance();
    addSession(run.ctx, 1);
    mkdirSync(run.exports, { recursive: true });
    const stale = path.join(run.exports, '.tmp-0123456789abcdef.db');
    writeFileSync(stale, 'left behind by a run that did not end');

    const reply = await get(run, EXPORT);

    expect(reply.status).toBe(200);
    expect(linesOf(reply.body).at(-1)).toMatchObject({ type: 'trailer', counts: { session: 1 } });
    // the route deletes its own copy only; `cleanup --scope stale-state` removes the old ones (registry C39)
    expect(leftovers(run)).toEqual(['.tmp-0123456789abcdef.db']);
  });

  it('answers a JSON error before the first byte when the copy cannot be made', async () => {
    const run = await startInstance();
    addSession(run.ctx, 1);
    // the folder of the copies is a file: nothing can be written there
    rmSync(run.exports, { recursive: true, force: true });
    writeFileSync(run.exports, 'not a folder');

    const reply = await get(run, EXPORT);

    expect([reply.status, codeOf(reply)]).toEqual([500, 'internal_error']);
    expect(reply.headers['content-type']).toContain('application/json');
    expect(reply.headers['content-disposition']).toBeUndefined();
    rmSync(run.exports, { force: true });
    mkdirSync(run.exports);
    const next = await get(run, `${EXPORT}?include=sessions`);
    expect(next.status).toBe(200);
  });

  it('names a route in the registry that answers application/x-ndjson and lists its own errors', () => {
    expect(routes.export).toMatchObject({
      id: 'export',
      method: 'GET',
      path: EXPORT,
      contentType: 'application/x-ndjson',
      errors: ['range_invalid', 'export_busy'],
    });
  });
});
