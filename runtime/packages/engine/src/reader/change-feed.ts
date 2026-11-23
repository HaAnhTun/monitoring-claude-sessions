// The follower of the durable change stream `GET /api/v3/stream` (ADR 0108): what `events` and `wait` read. It only reads:
//   - the instance must run (`running` of the probe, nothing else), else `INSTANCE_NOT_RUNNING`;
//   - the address is `http://127.0.0.1:<port>` and the URL comes from `routeUrl(routes.stream, ...)`;
//   - the `X-MCS-Instance` header and the `instanceId` of the `hello` frame must name the instance of the workspace;
//   - every frame is validated with the schemas of `@mcs/shared`; a frame that does not match ends the feed with `API_ERROR`
//     (an event name this version does not know is skipped, the way a browser skips it);
//   - the server writes a heartbeat every 15 s: a connection that is silent for 2.5 times that is dropped (the idle timeout of
//     the transport) and opened again;
//   - after a drop the feed reconnects with the last id it saw (`since=<seq>&epoch=<epoch>`), so the server replays what was
//     missed or says `reset`; the pause grows 1, 2, 4, 8 s and stays there, and after 8 reconnects in a row without one frame
//     the feed gives up;
//   - `503 stream_limit` is `API_ERROR` with `details.reason: 'stream_limit'` and a hint.
// The stream route is open (no control token is sent).
import {
  CLI_NAME,
  ErrorEnvelopeSchema,
  McsError,
  STREAM_HEARTBEAT_MS,
  StreamEventSchemas,
  routeUrl,
  routes,
  safeParseStreamChange,
  type ErrorCode,
  type StreamChange,
  type StreamHeartbeat,
  type StreamHello,
  type StreamReset,
} from '@mcs/shared';

import { requireInstance } from '../ops/backup.ts';
import { isLoopbackBase, probeInstance, type ProbeOptions, type ProbeResult } from '../ops/probe.ts';
import type { WorkspaceRef } from '../workspace/paths.ts';
import { loopbackStream, type ApiStreamOpen, type StreamedReply } from './api-reader.ts';
import { readerErrorOfCode } from './open.ts';
import { createSseParser, type SseFrame } from './sse.ts';

export type ChangeFeedEvent =
  /** The first frame of every connection; `reconnect` is false for the first connection only. */
  | { readonly type: 'hello'; readonly hello: StreamHello; readonly reconnect: boolean }
  | { readonly type: 'change'; readonly change: StreamChange }
  | { readonly type: 'heartbeat'; readonly heartbeat: StreamHeartbeat }
  /** The cursor could not be served: the stream goes on at `headSeq` and what lies before it must be read again. */
  | { readonly type: 'reset'; readonly reset: StreamReset };

export interface ChangeFeedOptions {
  /** Replay the change log after this seq first; absent: start at the head. */
  readonly since?: number;
  /** Ends the feed quietly: the connection is closed and the generator returns. */
  readonly signal?: AbortSignal;
}

/** Waits `ms`, or less when `signal` aborts; never rejects. */
export type FeedSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface ChangeFeedDeps {
  readonly runtimeDir: string;
  /** Default: `probeInstance`. */
  readonly probe?: (ws: WorkspaceRef, o?: ProbeOptions) => Promise<ProbeResult>;
  /** Default: `loopbackStream`. */
  readonly openStream?: ApiStreamOpen;
  /** The pause before a reconnect (default: a timer). */
  readonly sleep?: FeedSleep;
  /** Silence after which a connection is dropped (default 2.5 heartbeats). */
  readonly idleTimeoutMs?: number;
}

/** 1, 2, 4, 8, 8, ... seconds. */
export const FEED_BACKOFF_BASE_MS = 1000;
export const FEED_BACKOFF_CAP_MS = 8000;
/** Reconnects in a row without one frame before the feed gives up. */
export const FEED_MAX_RECONNECTS = 8;
const IDLE_TIMEOUT_MS = STREAM_HEARTBEAT_MS * 2.5;
const ERROR_BODY_MAX_BYTES = 64 * 1024;

export const abortableSleep: FeedSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

function contractError(what: string): McsError {
  return new McsError('API_ERROR', `the instance sent ${what} that does not match the API contract`, {
    hint: `the instance may run another version than this command; restart it with \`${CLI_NAME} restart\``,
    details: { reason: 'contract', route: routes.stream.id },
  });
}

/** The frame as a feed event; `null` for an event name this version does not know. */
function eventOf(frame: SseFrame): ChangeFeedEvent | null {
  if (!Object.hasOwn(StreamEventSchemas, frame.event)) return null;
  let value: unknown;
  try {
    value = JSON.parse(frame.data);
  } catch {
    throw contractError(`a ${frame.event} frame`);
  }
  if (frame.event === 'change') {
    const change = safeParseStreamChange(value);
    if (!change.success) throw contractError('a change frame');
    return { type: 'change', change: change.data };
  }
  if (frame.event === 'heartbeat') {
    const heartbeat = StreamEventSchemas.heartbeat.safeParse(value);
    if (!heartbeat.success) throw contractError('a heartbeat frame');
    return { type: 'heartbeat', heartbeat: heartbeat.data };
  }
  if (frame.event === 'reset') {
    const reset = StreamEventSchemas.reset.safeParse(value);
    if (!reset.success) throw contractError('a reset frame');
    return { type: 'reset', reset: reset.data };
  }
  const hello = StreamEventSchemas.hello.safeParse(value);
  if (!hello.success) throw contractError('a hello frame');
  return { type: 'hello', hello: hello.data, reconnect: false };
}

/** The code of an error envelope, `null` for a body that is not one. */
function errorCodeOf(text: string): ErrorCode | null {
  try {
    const envelope = ErrorEnvelopeSchema.safeParse(JSON.parse(text));
    return envelope.success ? envelope.data.error.code : null;
  } catch {
    return null;
  }
}

/** The error of an answer that is not `200`: the envelope's code, with the words for a full stream table. */
async function failureOf(reply: StreamedReply): Promise<McsError> {
  const { status } = reply;
  if (status >= 300 && status < 400) {
    return new McsError('API_ERROR', 'the instance answered with a redirect; the reader does not follow redirects', {
      details: { reason: 'redirect', status },
    });
  }
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of reply.body) {
      size += chunk.length;
      if (size > ERROR_BODY_MAX_BYTES) break;
      parts.push(Buffer.from(chunk));
    }
  } catch {
    // a cut error body is no envelope
  }
  const code = errorCodeOf(Buffer.concat(parts).toString('utf8'));
  if (code === null) {
    return new McsError('API_ERROR', `the instance answered with status ${String(status)} and no error envelope`, {
      details: { reason: 'no_envelope', status },
    });
  }
  if (code === 'stream_limit') {
    return new McsError('API_ERROR', 'every live stream of the instance is taken', {
      hint: 'close a monitor tab or another follower',
      details: { reason: 'stream_limit' },
    });
  }
  return readerErrorOfCode(code);
}

/**
 * Follows the change stream of the instance of `ws`. The generator yields every valid frame (the `hello` of each connection,
 * changes, heartbeats, resets) and reconnects by itself; it throws `McsError` when the instance does not run, answers for
 * another instance, breaks the contract, has no free stream, or stays unreachable. It returns only when `signal` aborts.
 */
export async function* openChangeFeed(
  ws: WorkspaceRef,
  deps: ChangeFeedDeps,
  options: ChangeFeedOptions = {},
): AsyncGenerator<ChangeFeedEvent, void, void> {
  const { signal } = options;
  const instance = await requireInstance(ws);
  const probe = await (deps.probe ?? probeInstance)(ws, { runtimeDir: deps.runtimeDir });
  if (probe.state !== 'running' || probe.url === null || !isLoopbackBase(probe.url)) {
    throw new McsError('INSTANCE_NOT_RUNNING', `the instance of task '${ws.slug}' is not running (${probe.state})`, {
      hint: `changes are followed on a running instance only; start it with \`${CLI_NAME} start --task ${ws.slug}\``,
      details: { reason: 'not_running', state: probe.state },
    });
  }
  const base = probe.url;
  const openStream = deps.openStream ?? loopbackStream;
  const sleep = deps.sleep ?? abortableSleep;
  const idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  /** The last id seen: where a reconnect goes on. */
  let cursor = options.since;
  let epoch: string | undefined;
  let greeted = false;
  /** Connections in a row that ended without one frame. */
  let failures = 0;
  /** Asked again after every wait: the signal aborts while the feed waits for a connection, a frame or a pause. */
  const aborted = (): boolean => signal?.aborted === true;

  for (;;) {
    if (aborted()) return;
    const query = cursor === undefined ? {} : { since: cursor, ...(epoch === undefined ? {} : { epoch }) };
    const attempt = await openStream(`${base}${routeUrl(routes.stream, { query })}`, {
      idleTimeoutMs,
      accept: 'text/event-stream',
    });
    const refused = !attempt.ok && attempt.reason === 'refused';
    if (attempt.ok) {
      const { reply } = attempt;
      if (aborted()) {
        reply.abort();
        return;
      }
      const close = (): void => {
        reply.abort();
      };
      signal?.addEventListener('abort', close, { once: true });
      try {
        if (reply.headers['x-mcs-instance'] !== instance.instanceId) {
          throw new McsError(
            'IDENTITY_MISMATCH',
            `the server at ${base} answers for another instance; nothing was read`,
            {
              hint: `the instance may have been replaced; run \`${CLI_NAME} instances list\` and try again`,
              details: { reason: 'instance_header' },
            },
          );
        }
        if (reply.status !== 200) throw await failureOf(reply);
        const parser = createSseParser();
        for await (const chunk of reply.body) {
          for (const frame of parser.push(chunk)) {
            const event = eventOf(frame);
            if (event === null) continue;
            failures = 0;
            if (event.type === 'hello') {
              const { hello } = event;
              if (hello.instanceId !== instance.instanceId) {
                throw new McsError('IDENTITY_MISMATCH', `the server at ${base} streams for another instance`, {
                  details: { reason: 'instance_hello' },
                });
              }
              epoch = hello.epoch;
              // a stream that began at the head goes on from that head after a drop
              cursor ??= hello.headSeq;
              const reconnect = greeted;
              greeted = true;
              yield { type: 'hello', hello, reconnect };
              continue;
            }
            if (event.type === 'change') {
              // a replay never goes back: a change at or before the cursor was delivered already
              if (cursor !== undefined && event.change.seq <= cursor) continue;
              cursor = event.change.seq;
            } else if (event.type === 'reset') {
              cursor = event.reset.headSeq;
            }
            yield event;
          }
        }
      } catch (error) {
        // ours are final (identity, contract, an error answer, an oversize frame); anything else is a cut connection
        if (error instanceof McsError) throw error;
      } finally {
        signal?.removeEventListener('abort', close);
        reply.abort();
      }
    }
    if (aborted()) return;
    failures += 1;
    if (failures > FEED_MAX_RECONNECTS) {
      if (refused) {
        throw new McsError('INSTANCE_NOT_RUNNING', 'the instance stopped answering while its changes were followed', {
          hint: `it may have been stopped; check \`${CLI_NAME} status --task ${ws.slug}\``,
          details: { reason: 'connection_refused' },
        });
      }
      throw new McsError('API_ERROR', 'the change stream of the instance was lost and did not come back', {
        hint: `check \`${CLI_NAME} status --task ${ws.slug}\` and \`${CLI_NAME} doctor --task ${ws.slug}\``,
        details: { reason: 'stream_lost' },
      });
    }
    await sleep(Math.min(FEED_BACKOFF_BASE_MS * 2 ** (failures - 1), FEED_BACKOFF_CAP_MS), signal);
  }
}
