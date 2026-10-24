// `ApiReader` (01 6.1, 03 12.2): the reader of an instance that runs. It asks the loopback server over HTTP and nothing else:
//   - the address must be `http://127.0.0.1:<port>`; a base that is anything else is refused when the reader is made;
//   - every URL is built with `routeUrl` from the route registry of `@mcs/shared`, so no path or query shape is written here;
//   - a request is a plain GET without a body, and a redirect is never followed (Node's `http` does not; a 3xx answer is a failure);
//   - the `X-MCS-Instance` header of every answer must be the instance id of the workspace, otherwise the port now belongs to
//     another instance (a reused port) and nothing of the answer is used;
//   - the body is parsed with the response schema of the route; a body that does not match is a failure, not a partial result;
//   - an error envelope becomes the same `McsError` the `DbReader` raises for the same cause (`readerErrorOfCode`).
// It holds no connection between calls (every request opens and closes its own socket), so `close` has nothing to release.
import { createHash } from 'node:crypto';
import { request } from 'node:http';

import {
  ErrorEnvelopeSchema,
  ExportLineSchemas,
  McsError,
  SessionIdSchema,
  routeUrl,
  routes,
  type ErrorCode,
  type ExportSummary,
  type RouteDefinition,
} from '@mcs/shared';
import type { z } from 'zod';

import { httpGetWithHeaders, isLoopbackBase, type HttpFullAttempt } from '../ops/probe.ts';
import { parseBody, readerErrorOfCode, readerReasonOf, type InstanceReader, type ReaderOutput } from './open.ts';

/** The GET of the probe, with the response headers; a test passes a scripted one. */
export type ApiHttpGet = (
  url: string,
  o: { readonly timeoutMs: number; readonly maxBytes?: number },
) => Promise<HttpFullAttempt>;

/** An open streaming answer: the status and headers are known, the body is read by the caller. */
export interface StreamedReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Closes the connection (the caller stops reading). */
  abort(): void;
}

export type StreamAttempt =
  | { readonly ok: true; readonly reply: StreamedReply }
  | { readonly ok: false; readonly reason: 'refused' | 'timeout' | 'error' };

/** The streaming GET of `exportTo`; a test passes a scripted one. */
export type ApiStreamOpen = (url: string, o: { readonly idleTimeoutMs: number }) => Promise<StreamAttempt>;

export interface ApiReaderOptions {
  /** `http://127.0.0.1:<port>`. */
  readonly base: string;
  /** The `instanceId` of the workspace the reader was opened for. */
  readonly instanceId: string;
  readonly httpGet?: ApiHttpGet;
  readonly openStream?: ApiStreamOpen;
  /** Per request (default 15 s); a search adds its own budget. */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** A transcript window can hold 2000 entries of 20000 characters. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const SEARCH_GRACE_MS = 10_000;
const EXPORT_IDLE_TIMEOUT_MS = 60_000;
/** One export line may be long (a transcript line holds up to 500 entries); a line beyond this is not an export. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const LF = 10;

/** A route with a JSON response of schema `S`; the reader reads these. */
type JsonRoute<S extends z.ZodType> = RouteDefinition<
  string,
  z.ZodObject | null,
  z.ZodType | null,
  z.ZodType | null,
  S
>;

interface RequestParts {
  readonly params?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, unknown>>;
}

function jsonOf(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// ---- the streaming client ---------------------------------------------------------------------------------------------------------

/** The real streaming GET: a fresh connection, `Connection: close`, no body, no redirect. Only `http://127.0.0.1:<port>/...`. */
export const loopbackStream: ApiStreamOpen = (url, o) =>
  new Promise((resolve) => {
    const match = /^(http:\/\/127\.0\.0\.1:[0-9]{1,5})(\/[^\s]*)$/.exec(url);
    const base = match?.[1];
    const pathPart = match?.[2];
    if (base === undefined || pathPart === undefined || !isLoopbackBase(base)) {
      resolve({ ok: false, reason: 'error' });
      return;
    }
    const port = Number(new URL(base).port);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: pathPart,
        method: 'GET',
        agent: false,
        headers: { Host: `127.0.0.1:${String(port)}`, Accept: 'application/x-ndjson', Connection: 'close' },
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers[name.toLowerCase()] = typeof value === 'string' ? value : value.join(', ');
        }
        resolve({
          ok: true,
          reply: {
            status: res.statusCode ?? 0,
            headers,
            body: res,
            abort: () => {
              req.destroy();
            },
          },
        });
      },
    );
    req.setTimeout(o.idleTimeoutMs, () => {
      req.destroy(new Error('idle'));
    });
    req.once('error', (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, reason: error.code === 'ECONNREFUSED' ? 'refused' : 'error' });
    });
    req.end();
  });

function writeChunk(out: ReaderOutput, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(chunk, (error) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}

/** Counts the lines and bytes of a stream, keeps the first and the last line, and hashes every line but the last. */
class LineTally {
  lines = 0;
  bytes = 0;
  first: Buffer | null = null;
  last: Buffer | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private readonly hash = createHash('sha256');
  /** The hash of every byte before the last complete line. */
  private beforeLast: Buffer | null = null;

  push(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    let from = 0;
    for (;;) {
      const at = buffer.indexOf(LF, from);
      if (at < 0) break;
      this.complete(buffer.subarray(from, at + 1));
      from = at + 1;
    }
    if (from < buffer.length) this.hold(buffer.subarray(from));
  }

  private hold(piece: Buffer): void {
    this.pendingBytes += piece.length;
    if (this.pendingBytes > MAX_LINE_BYTES) throw new McsError('API_ERROR', 'a line of the export is too long');
    this.pending.push(Buffer.from(piece));
  }

  private complete(end: Buffer): void {
    this.hold(end);
    const line = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    this.lines += 1;
    // the line that was last until now is a data line: it goes into the hash; this one may be the trailer
    if (this.last !== null) this.hash.update(this.last);
    this.first ??= line;
    this.last = line;
  }

  /** The hex digest of every byte before the last line, once the stream has ended. */
  digestBeforeLast(): string {
    this.beforeLast ??= this.hash.digest();
    return this.beforeLast.toString('hex');
  }

  /** Bytes after the last line feed (a cut stream). */
  get partial(): boolean {
    return this.pendingBytes > 0;
  }
}

export function createApiReader(options: ApiReaderOptions): InstanceReader {
  if (!isLoopbackBase(options.base)) {
    throw new McsError('API_ERROR', 'the reader only talks to http://127.0.0.1:<port>', {
      details: { reason: 'not_loopback' },
    });
  }
  const { base, instanceId } = options;
  const get = options.httpGet ?? httpGetWithHeaders;
  const openStream = options.openStream ?? loopbackStream;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** The failure of a request that got no answer. */
  function unreachable(reason: 'refused' | 'timeout' | 'too-large' | 'error'): McsError {
    if (reason === 'refused') {
      return new McsError('INSTANCE_NOT_RUNNING', 'the instance stopped answering while it was being read', {
        hint: 'it may have been stopped just now; run the command again',
        details: { reason: 'connection_refused' },
      });
    }
    if (reason === 'timeout') {
      return new McsError('API_ERROR', 'the instance did not answer in time', {
        hint: 'check `mcs status` and `mcs doctor`; the instance may be busy or hung',
        details: { reason: 'timeout' },
      });
    }
    if (reason === 'too-large') {
      return new McsError('API_ERROR', 'the answer of the instance is larger than the reader accepts', {
        details: { reason: 'too_large' },
      });
    }
    return new McsError('API_ERROR', 'the request to the instance failed', { details: { reason: 'request_failed' } });
  }

  /** `X-MCS-Instance` must name this workspace's instance: another value means the port was taken over. */
  function checkInstance(headers: Readonly<Record<string, string>>): void {
    if (headers['x-mcs-instance'] !== instanceId) {
      throw new McsError('IDENTITY_MISMATCH', `the server at ${base} answers for another instance; nothing was read`, {
        hint: 'the monitor may have been replaced; run `mcs instances list` and try again',
        details: { reason: 'instance_header' },
      });
    }
  }

  /** The error of a non-200 answer: the envelope's code mapped like the `DbReader` maps the engine's. */
  function failureOf(
    status: number,
    text: string,
    mapCode: ((code: ErrorCode) => McsError | undefined) | undefined,
  ): McsError {
    if (status >= 300 && status < 400) {
      return new McsError('API_ERROR', 'the instance answered with a redirect; the reader does not follow redirects', {
        details: { reason: 'redirect', status },
      });
    }
    const parsed = jsonOf(text);
    const envelope = parsed.ok ? ErrorEnvelopeSchema.safeParse(parsed.value) : null;
    if (envelope?.success !== true) {
      return new McsError('API_ERROR', `the instance answered with status ${String(status)} and no error envelope`, {
        details: { reason: 'no_envelope', status },
      });
    }
    const code = envelope.data.error.code;
    return mapCode?.(code) ?? readerErrorOfCode(code);
  }

  async function fetchRoute<S extends z.ZodType>(
    route: JsonRoute<S>,
    parts: RequestParts = {},
    o: { readonly timeoutMs?: number; readonly mapCode?: (code: ErrorCode) => McsError | undefined } = {},
  ): Promise<z.output<S>> {
    let url: string;
    try {
      url = `${base}${routeUrl(route, parts)}`;
    } catch (error) {
      throw new McsError('USAGE', 'the request is not valid', {
        cause: error,
        details: { reason: 'validation_failed' },
      });
    }
    let attempt: HttpFullAttempt;
    try {
      attempt = await get(url, { timeoutMs: o.timeoutMs ?? timeoutMs, maxBytes: MAX_BODY_BYTES });
    } catch (error) {
      throw new McsError('API_ERROR', 'the request to the instance was refused by the reader', {
        cause: error,
        details: { reason: 'request_refused' },
      });
    }
    if (!attempt.ok) throw unreachable(attempt.reason);
    const { reply } = attempt;
    checkInstance(reply.headers);
    if (reply.status !== 200) throw failureOf(reply.status, reply.body, o.mapCode);
    const parsed = jsonOf(reply.body);
    if (!parsed.ok) {
      throw new McsError('API_ERROR', `the instance answered ${route.id} with a body that is not JSON`, {
        details: { reason: 'body_invalid' },
      });
    }
    const checked = parseBody(route.response, parsed.value);
    if (!checked.ok) {
      throw new McsError(
        'API_ERROR',
        `the instance answered ${route.id} with a body that does not match the API contract`,
        {
          hint: 'the monitor may run another version than this command; restart it with `mcs restart`',
          details: { reason: 'contract', route: route.id },
        },
      );
    }
    return checked.data;
  }

  function validId(id: string): string {
    if (!SessionIdSchema.safeParse(id).success) {
      throw new McsError('USAGE', 'the session id is not valid', { details: { reason: 'validation_failed' } });
    }
    return id;
  }

  const completionCodes = (code: ErrorCode): McsError | undefined => {
    if (code === 'validation_failed') {
      return new McsError('USAGE', 'the completion target is not valid', { details: { reason: 'target_invalid' } });
    }
    if (code === 'completion_target_not_found') {
      return new McsError('NOT_FOUND', 'no run matches the completion target', {
        details: { reason: 'target_not_found' },
      });
    }
    return undefined;
  };

  async function exportTo(q: Parameters<InstanceReader['exportTo']>[0], out: ReaderOutput): Promise<ExportSummary> {
    let url: string;
    try {
      url = `${base}${routeUrl(routes.export, { query: q })}`;
    } catch (error) {
      throw new McsError('USAGE', 'the request is not valid', {
        cause: error,
        details: { reason: 'validation_failed' },
      });
    }
    let attempt: StreamAttempt;
    try {
      attempt = await openStream(url, { idleTimeoutMs: EXPORT_IDLE_TIMEOUT_MS });
    } catch (error) {
      throw new McsError('API_ERROR', 'the request to the instance was refused by the reader', {
        cause: error,
        details: { reason: 'request_refused' },
      });
    }
    if (!attempt.ok) throw unreachable(attempt.reason);
    const { reply } = attempt;
    try {
      checkInstance(reply.headers);
      if (reply.status !== 200) {
        const parts: Buffer[] = [];
        let size = 0;
        for await (const chunk of reply.body) {
          size += chunk.length;
          if (size > ERROR_BODY_MAX_BYTES) break;
          parts.push(Buffer.from(chunk));
        }
        throw failureOf(reply.status, Buffer.concat(parts).toString('utf8'), undefined);
      }
      const tally = new LineTally();
      try {
        for await (const chunk of reply.body) {
          tally.push(chunk);
          try {
            await writeChunk(out, chunk);
          } catch (error) {
            throw new McsError('API_ERROR', 'writing the export failed', {
              cause: error,
              details: { reason: 'output' },
            });
          }
        }
      } catch (error) {
        if (error instanceof McsError) throw error;
        throw new McsError('API_ERROR', 'the connection to the instance ended before the export was complete', {
          cause: error,
          details: { reason: 'export_cut' },
        });
      }
      return summaryOf(tally);
    } catch (error) {
      reply.abort();
      throw error;
    }
  }

  return {
    mode: 'api',
    instanceId,
    sessions: (q) => fetchRoute(routes.listSessions, { query: q }),
    session: async (id) => {
      try {
        return await fetchRoute(routes.getSession, { params: { sessionId: validId(id) } });
      } catch (error) {
        if (readerReasonOf(error) === 'session_not_found') return null;
        throw error;
      }
    },
    sessionAgents: (id, q) => fetchRoute(routes.sessionAgents, { params: { sessionId: validId(id) }, query: q }),
    sessionEvents: (id, q) => fetchRoute(routes.sessionTimeline, { params: { sessionId: validId(id) }, query: q }),
    usage: (q) => fetchRoute(routes.analyticsUsage, { query: q }),
    series: (q) => fetchRoute(routes.analyticsSeries, { query: q }),
    tools: (q) => fetchRoute(routes.analyticsTools, { query: q }),
    errors: async (q) => (await fetchRoute(routes.errors, { query: q })).items,
    overview: (q) => fetchRoute(routes.overview, { query: q }),
    alerts: (q) => fetchRoute(routes.listAlerts, { query: q }),
    explainCompletion: (target) =>
      fetchRoute(
        routes.explainCompletion,
        {
          query:
            'sessionId' in target
              ? { session: target.sessionId }
              : 'label' in target
                ? { label: target.label }
                : { attemptPart: target.attemptPart },
        },
        { mapCode: completionCodes },
      ),
    searchTranscript: (q) =>
      fetchRoute(routes.searchTranscript, { query: q }, { timeoutMs: timeoutMs + q.budgetMs + SEARCH_GRACE_MS }),
    searchTranscripts: (q) =>
      fetchRoute(routes.searchTranscripts, { query: q }, { timeoutMs: timeoutMs + q.budgetMs + SEARCH_GRACE_MS }),
    transcriptWindow: ({ sessionId, ...query }) =>
      fetchRoute(routes.transcriptWindow, { params: { sessionId: validId(sessionId) }, query }),
    exportTo,
    close: () => Promise.resolve(),
  };
}

function jsonValueOf(line: Buffer): unknown {
  try {
    return JSON.parse(line.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** The summary of a finished export stream: the trailer says the counts and the checksum, the header whether text is in it. */
function summaryOf(tally: LineTally): ExportSummary {
  const cut = (why: string): McsError =>
    new McsError('API_ERROR', `the export is not whole: ${why}`, { details: { reason: 'export_cut' } });
  if (tally.partial || tally.first === null || tally.last === null) throw cut('it ended inside a line');
  const header = ExportLineSchemas.header.safeParse(jsonValueOf(tally.first));
  const trailer = ExportLineSchemas.trailer.safeParse(jsonValueOf(tally.last));
  if (!header.success) throw cut('it has no header line');
  if (!trailer.success) throw cut('it has no trailer line');
  if (trailer.data.sha256 !== tally.digestBeforeLast()) throw cut('the checksum does not match');
  return {
    lines: tally.lines,
    bytes: tally.bytes,
    sha256: trailer.data.sha256,
    counts: trailer.data.counts,
    includeContent: header.data.includeContent,
  };
}
