// The output batcher of the terminal socket (CAW-25, design 02 5.5, ADR 0087). A session reports output in whatever pieces the
// process writes it; the socket wants few, bounded frames. The batcher keeps the pieces of one viewer in order and sends them
// as frames of at most 64 KiB, ONE frame per `setImmediate` tick: a process that prints a lot cannot hold the event loop for
// the time it takes to send everything, and the other viewers and the HTTP routes get their turn between two frames.
//   - Small pushes that arrive before the tick are one frame (coalescing); a large push is several frames over several ticks.
//   - High water: before every frame the consumer is asked (`congested`, the socket's buffered amount in the gateway); a
//     congested consumer, or more than `maxPendingBytes` waiting, stops the batcher for good and `onHighWater` runs once. The
//     process is never slowed down for one viewer: the viewer is the one that leaves (the gateway closes it with 1013).
//   - `flush` sends everything that waits, now: the gateway calls it before the `exit` frame so that the last output of a
//     process comes before its end.
// Pure: no socket, no timer of its own (the scheduler is a parameter), no log. The bytes of a chunk are not copied: a frame is a
// view of the chunks that make it up, which is why the owner of a chunk never changes it after reporting it.

/** The most bytes of one frame. */
export const OUTPUT_FRAME_BYTES = 65_536;
/** The most bytes that may wait for the next ticks before the viewer counts as too slow. */
export const OUTPUT_MAX_PENDING_BYTES = 4_194_304;

/** Runs `run` later (one event loop turn); returns the way to cancel it. */
export type OutputScheduler = (run: () => void) => () => void;

export interface OutputBatcherOptions {
  /** Writes one frame of at most `frameBytes`. It must not throw: a throw would end a timer callback. */
  readonly send: (frame: Buffer) => void;
  /** Asked before every frame: true when the consumer is over its high-water mark. Default: never. */
  readonly congested?: () => boolean;
  /** Runs once, after the batcher stopped because of the high-water mark. */
  readonly onHighWater?: () => void;
  /** Default `OUTPUT_FRAME_BYTES`. */
  readonly frameBytes?: number;
  /** Default `OUTPUT_MAX_PENDING_BYTES`. */
  readonly maxPendingBytes?: number;
  /** Default: `setImmediate`. */
  readonly schedule?: OutputScheduler;
}

export interface OutputBatcher {
  /** Queues output; it is sent in the coming ticks. Ignored after `close` and for an empty chunk. */
  push(chunk: Uint8Array): void;
  /** Sends everything that waits, in frames, now (an exit frame follows). Stops at a congested consumer. */
  flush(): void;
  /** Drops what waits and cancels the tick; later pushes are ignored. Idempotent. */
  close(): void;
  /** The bytes that wait. */
  readonly pendingBytes: number;
  /** True after `close` and after a high-water stop. */
  readonly closed: boolean;
}

const immediate: OutputScheduler = (run) => {
  const handle = setImmediate(run);
  return () => {
    clearImmediate(handle);
  };
};

function bufferOf(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`createOutputBatcher: ${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

export function createOutputBatcher(options: OutputBatcherOptions): OutputBatcher {
  const frameBytes = positive('frameBytes', options.frameBytes ?? OUTPUT_FRAME_BYTES);
  const maxPendingBytes = positive('maxPendingBytes', options.maxPendingBytes ?? OUTPUT_MAX_PENDING_BYTES);
  const schedule = options.schedule ?? immediate;
  const { send, congested, onHighWater } = options;

  /** The chunks that wait, `queue[at]` first; `at` moves instead of shifting an array that may hold many small chunks. */
  let queue: Buffer[] = [];
  let at = 0;
  let pending = 0;
  let cancel: (() => void) | undefined;
  let closed = false;

  function takeFrame(): Buffer {
    const parts: Buffer[] = [];
    let room = frameBytes;
    while (room > 0 && at < queue.length) {
      const chunk = queue[at];
      if (chunk === undefined) break;
      if (chunk.length <= room) {
        parts.push(chunk);
        room -= chunk.length;
        at += 1;
      } else {
        parts.push(chunk.subarray(0, room));
        queue[at] = chunk.subarray(room);
        room = 0;
      }
    }
    if (at > 1024 && at * 2 > queue.length) {
      queue = queue.slice(at);
      at = 0;
    }
    const frame = parts.length === 1 && parts[0] !== undefined ? parts[0] : Buffer.concat(parts);
    pending -= frame.length;
    return frame;
  }

  function stop(): void {
    closed = true;
    cancel?.();
    cancel = undefined;
    queue = [];
    at = 0;
    pending = 0;
  }

  function highWater(): void {
    if (closed) return;
    stop();
    onHighWater?.();
  }

  /** Sends one frame; false when nothing was sent (nothing waits, or the consumer is congested and the batcher stopped). */
  function sendOne(): boolean {
    if (closed || pending === 0) return false;
    if (congested?.() === true) {
      highWater();
      return false;
    }
    send(takeFrame());
    return true;
  }

  function tick(): void {
    cancel = undefined;
    sendOne();
    if (!closed && pending > 0) cancel = schedule(tick);
  }

  return {
    push(chunk) {
      if (closed || chunk.byteLength === 0) return;
      if (pending + chunk.byteLength > maxPendingBytes) {
        highWater();
        return;
      }
      queue.push(bufferOf(chunk));
      pending += chunk.byteLength;
      cancel ??= schedule(tick);
    },

    flush() {
      if (closed || pending === 0) return;
      cancel?.();
      cancel = undefined;
      while (sendOne()) {
        // every frame goes out now: the exit frame must come after the last byte (pending is bounded by `maxPendingBytes`)
      }
    },

    close: stop,

    get pendingBytes(): number {
      return pending;
    },

    get closed(): boolean {
      return closed;
    },
  };
}
