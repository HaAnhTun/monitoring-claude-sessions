// The stream hub (03 9.2, ADR 0025): pull-based fan-out over the persisted change log. Each client has `lastSent`; `pump` writes
// the frames after it, in batches of 100, until `write()` answers false, then waits for `drain`. The change log is the buffer,
// so a slow client costs about one socket buffer and nothing else (prototype X5: the push-based first version failed this
// test). A client that stays undrained for 30 s is destroyed and reconnects: it is replayed, or reset.
//
// The hub knows neither HTTP nor SQL: it reads the log through `ChangeLog`, writes to a `StreamSink`, learns about commits
// through `subscribe` (the engine's `onCommitted`, so a frame is published strictly after COMMIT, DA-I7) and gets its frames
// from `hydrate`. It subscribes while at least one client is connected, so an idle server holds no listener and no timer.
import type { Logger } from '@mcs/engine';
import {
  STREAM_HEARTBEAT_MS,
  STREAM_RETRY_MS,
  isoMsZ,
  type StreamChange,
  type StreamHeartbeat,
  type StreamHello,
  type StreamReset,
} from '@mcs/shared';

import type { ChangeRow } from './hydrate.ts';

/** The limits of 03 9.2 and registry section 4. */
export const STREAM_LIMITS = {
  /** Concurrent streams per instance; the 17th gets `503 stream_limit`. */
  maxStreams: 16,
  /** Frames per `pump` step. */
  batchSize: 100,
  /** A client undrained for this long is destroyed. */
  stallMs: 30_000,
  /** Frames built once per seq and shared by all clients. */
  frameCacheSize: 512,
  /** A cursor further behind than this is `cursor_too_old`. */
  maxReplay: 2000,
  heartbeatMs: STREAM_HEARTBEAT_MS,
} as const;

/** The limits as numbers, so that a test can shorten one. */
export type StreamLimits = { readonly [K in keyof typeof STREAM_LIMITS]: number };
export type StreamLimitOverrides = Partial<StreamLimits>;

/** The read side of the change log (`ChangesRepo` of the engine). */
export interface ChangeLog {
  /** The head of the log, valid after pruning. */
  head(): number;
  /** The oldest retained seq, `undefined` for an empty log. */
  oldest(): number | undefined;
  /** The rows with `seq > afterSeq`, in order, at most `limit`. */
  since(afterSeq: number, limit: number): readonly ChangeRow[];
}

/** Where frames go: the response of one client. `write` answers false when its buffer is full, as `Writable.write` does. */
export interface StreamSink {
  write(chunk: string): boolean;
  /** Calls `callback` once, when the sink can take data again. */
  onceDrain(callback: () => void): void;
  destroy(): void;
}

/** What the client asked for: no cursor, a cursor that is not a non-negative integer, or a seq (`Last-Event-ID` or `since`). */
export type StreamCursor =
  { readonly kind: 'none' } | { readonly kind: 'invalid' } | { readonly kind: 'seq'; readonly seq: number };

export interface StreamRequest {
  readonly cursor: StreamCursor;
  /** The `epoch` the client holds, when it sent one. */
  readonly epoch: string | undefined;
}

export interface StreamHandle {
  /** Removes the client and clears its timers. Idempotent; the sink is not touched. */
  close(): void;
}

export interface StreamHub {
  /** Number of connected clients. */
  readonly size: number;
  /** False when the limit of concurrent streams is reached. */
  hasCapacity(): boolean;
  /** Registers a client and writes its opening frames; `null` when the limit is reached (the caller answers `503 stream_limit`). */
  accept(sink: StreamSink, request: StreamRequest): StreamHandle | null;
  /** Destroys every sink and removes every client (server shutdown, tests). */
  closeAll(): void;
}

export interface StreamHubOptions {
  readonly log: ChangeLog;
  /** The frame of one change row (`createHydrator`). */
  readonly hydrate: (row: ChangeRow) => StreamChange;
  /** Registers a listener for committed transactions; returns the unsubscribe function (`onCommitted(db, ...)`). */
  readonly subscribe: (listener: () => void) => () => void;
  readonly info: {
    readonly instanceId: string;
    readonly epoch: string;
    readonly runtimeVersion: string;
    readonly codeStamp: string;
  };
  /** Epoch ms. */
  readonly now: () => number;
  readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  /** Tests may shorten the limits. */
  readonly limits?: StreamLimitOverrides;
}

interface Client {
  readonly sink: StreamSink;
  lastSent: number;
  closed: boolean;
  /** True while a write was refused and the sink has not drained: nothing is written until it does. */
  waiting: boolean;
  pumping: boolean;
  heartbeat: NodeJS.Timeout | undefined;
  stall: NodeJS.Timeout | undefined;
}

function field(name: string, value: string): string {
  return `${name}: ${value}\n`;
}

/** One SSE frame: its fields, then the blank line. `data` is JSON, so it never contains a raw newline. */
function frameText(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? '' : field('id', String(id))}${field('event', event)}${field('data', JSON.stringify(data))}\n`;
}

export function createStreamHub(options: StreamHubOptions): StreamHub {
  const { log, logger, info } = options;
  const limits: StreamLimits = { ...STREAM_LIMITS, ...options.limits };
  const clients = new Set<Client>();
  const frames = new Map<number, string>();
  let unsubscribe: (() => void) | undefined;

  // ---- frames ------------------------------------------------------------------------------------------------------------

  /** Built once per seq and shared; an LRU of `frameCacheSize` entries (a read refreshes the entry). */
  function changeFrame(row: ChangeRow): string {
    const known = frames.get(row.seq);
    if (known !== undefined) {
      frames.delete(row.seq);
      frames.set(row.seq, known);
      return known;
    }
    const text = frameText('change', options.hydrate(row), row.seq);
    frames.set(row.seq, text);
    if (frames.size > limits.frameCacheSize) {
      const oldest = frames.keys().next();
      if (oldest.done !== true) frames.delete(oldest.value);
    }
    return text;
  }

  function helloFrame(): string {
    const hello: StreamHello = {
      instanceId: info.instanceId,
      epoch: info.epoch,
      headSeq: log.head(),
      heartbeatMs: limits.heartbeatMs,
      serverTime: isoMsZ(options.now()),
      runtimeVersion: info.runtimeVersion,
      codeStamp: info.codeStamp,
    };
    return frameText('hello', hello);
  }

  // ---- writing -----------------------------------------------------------------------------------------------------------

  /** True when nothing may be written to the client now: it left, or it has not drained. A function so that the checks are not narrowed away. */
  function blocked(client: Client): boolean {
    return client.closed || client.waiting;
  }

  function remove(client: Client): void {
    if (client.closed) return;
    client.closed = true;
    clearInterval(client.heartbeat);
    clearTimeout(client.stall);
    client.heartbeat = undefined;
    client.stall = undefined;
    clients.delete(client);
    if (clients.size === 0 && unsubscribe !== undefined) {
      unsubscribe();
      unsubscribe = undefined;
    }
  }

  /** Removes the client and destroys its sink (an eviction, or a sink that failed). */
  function evict(client: Client, reason: string): void {
    const wasOpen = !client.closed;
    remove(client);
    if (!wasOpen) return;
    logger.warn('stream_client_evicted', { reason });
    try {
      client.sink.destroy();
    } catch {
      // the socket is gone already
    }
  }

  /** Writes one chunk; a refused write (or a sink that throws) stops the pump until the sink drains. */
  function send(client: Client, chunk: string): void {
    if (client.closed) return;
    let accepted: boolean;
    try {
      accepted = client.sink.write(chunk);
    } catch {
      evict(client, 'write_failed');
      return;
    }
    if (accepted || client.waiting) return;
    client.waiting = true;
    client.stall = setTimeout(() => {
      evict(client, 'stalled');
    }, limits.stallMs);
    client.sink.onceDrain(() => {
      if (client.closed) return;
      client.waiting = false;
      clearTimeout(client.stall);
      client.stall = undefined;
      pump(client);
    });
  }

  function resetFrame(client: Client, reason: StreamReset['reason']): void {
    const headSeq = log.head();
    const data: StreamReset = { headSeq, reason };
    send(client, frameText('reset', data, headSeq));
    client.lastSent = headSeq;
  }

  /** Writes the frames after `lastSent`, `batchSize` at a time, until the log is exhausted or the sink is full. */
  function pump(client: Client): void {
    if (client.pumping || client.closed) return;
    client.pumping = true;
    try {
      while (!blocked(client)) {
        const rows = log.since(client.lastSent, limits.batchSize);
        if (rows.length === 0) return;
        for (const row of rows) {
          if (blocked(client)) return;
          if (row.seq !== client.lastSent + 1) {
            // the rows between were pruned while this client lagged: a gap would corrupt its cache, so it resynchronizes
            resetFrame(client, 'cursor_too_old');
            break;
          }
          send(client, changeFrame(row));
          client.lastSent = row.seq;
        }
      }
    } catch (error) {
      logger.error('stream_pump_failed', { error: error instanceof Error ? error.name : 'non-error' });
      evict(client, 'pump_failed');
    } finally {
      client.pumping = false;
    }
  }

  function pumpAll(): void {
    for (const client of [...clients]) pump(client);
  }

  function heartbeat(client: Client): void {
    // a client that has not drained gets nothing more: the buffer stays bounded
    if (blocked(client)) return;
    const data: StreamHeartbeat = { headSeq: log.head(), epoch: info.epoch, serverTime: isoMsZ(options.now()) };
    send(client, frameText('heartbeat', data));
  }

  // ---- the cursor decision (03 9.2 step 3) ---------------------------------------------------------------------------------

  type Decision =
    | { readonly kind: 'live' }
    | { readonly kind: 'replay'; readonly from: number }
    | { readonly kind: 'reset'; readonly reason: StreamReset['reason'] };

  function decide(request: StreamRequest): Decision {
    const { cursor, epoch } = request;
    if (cursor.kind === 'none') return { kind: 'live' };
    if (epoch !== undefined && epoch !== info.epoch) return { kind: 'reset', reason: 'epoch_changed' };
    if (cursor.kind === 'invalid') return { kind: 'reset', reason: 'cursor_invalid' };
    const head = log.head();
    const c = cursor.seq;
    if (c > head) return { kind: 'reset', reason: 'cursor_ahead' };
    const oldest = log.oldest() ?? head + 1;
    if (c < oldest - 1 || head - c > limits.maxReplay) return { kind: 'reset', reason: 'cursor_too_old' };
    return { kind: 'replay', from: c };
  }

  // ---- the public side ---------------------------------------------------------------------------------------------------

  return {
    get size(): number {
      return clients.size;
    },

    hasCapacity: () => clients.size < limits.maxStreams,

    accept(sink, request) {
      if (clients.size >= limits.maxStreams) return null;
      const client: Client = {
        sink,
        lastSent: 0,
        closed: false,
        waiting: false,
        pumping: false,
        heartbeat: undefined,
        stall: undefined,
      };
      clients.add(client);
      unsubscribe ??= options.subscribe(pumpAll);
      client.heartbeat = setInterval(() => {
        heartbeat(client);
      }, limits.heartbeatMs);

      send(client, `retry: ${String(STREAM_RETRY_MS)}\n\n`);
      send(client, helloFrame());
      const decision = decide(request);
      if (decision.kind === 'reset') resetFrame(client, decision.reason);
      else client.lastSent = decision.kind === 'replay' ? decision.from : log.head();
      pump(client);
      return {
        close: () => {
          remove(client);
        },
      };
    },

    closeAll() {
      for (const client of [...clients]) {
        remove(client);
        try {
          client.sink.destroy();
        } catch {
          // already gone
        }
      }
    },
  };
}
