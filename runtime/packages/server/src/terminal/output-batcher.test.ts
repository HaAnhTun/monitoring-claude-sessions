// The output batcher of the terminal socket (CAW-25, design 02 5.5) without a socket: a scripted scheduler stands for the
// `setImmediate` tick. What is proved: small pushes become one frame, a large push becomes frames of at most 64 KiB sent one per
// tick, the bytes and their order are exact, the high-water signals (a congested consumer and too much pending data), the
// flush before an exit frame, and that a closed batcher sends nothing. TC-WS-07 (the real socket) is terminal-socket.int.test.ts.
import { describe, expect, it } from 'vitest';

import {
  OUTPUT_FRAME_BYTES,
  OUTPUT_MAX_PENDING_BYTES,
  createOutputBatcher,
  type OutputBatcher,
} from './output-batcher.ts';

/** A scheduler that runs a tick only when the test says so; `cancelled` counts the ticks that were cancelled. */
class ManualTicks {
  private next: (() => void) | undefined;
  scheduled = 0;
  cancelled = 0;

  readonly schedule = (run: () => void): (() => void) => {
    this.scheduled += 1;
    this.next = run;
    return () => {
      this.cancelled += 1;
      this.next = undefined;
    };
  };

  get waiting(): boolean {
    return this.next !== undefined;
  }

  /** Runs the waiting tick, if any; true when one ran. */
  tick(): boolean {
    const run = this.next;
    this.next = undefined;
    if (run === undefined) return false;
    run();
    return true;
  }

  /** Runs ticks until none waits; the number that ran. */
  drain(): number {
    let ran = 0;
    while (this.tick()) ran += 1;
    return ran;
  }
}

function bytes(length: number, seed = 0): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

interface Harness {
  readonly ticks: ManualTicks;
  readonly frames: Buffer[];
  readonly highWater: { count: number };
  readonly batcher: OutputBatcher;
  congested: boolean;
}

function harness(options: { frameBytes?: number; maxPendingBytes?: number } = {}): Harness {
  const ticks = new ManualTicks();
  const frames: Buffer[] = [];
  const highWater = { count: 0 };
  const state = { congested: false };
  const batcher = createOutputBatcher({
    send: (frame) => {
      frames.push(frame);
    },
    congested: () => state.congested,
    onHighWater: () => {
      highWater.count += 1;
    },
    schedule: ticks.schedule,
    ...options,
  });
  return {
    ticks,
    frames,
    highWater,
    batcher,
    get congested() {
      return state.congested;
    },
    set congested(value: boolean) {
      state.congested = value;
    },
  };
}

describe('output batcher: defaults', () => {
  it('a frame is 64 KiB and at most 4 MiB may wait', () => {
    expect(OUTPUT_FRAME_BYTES).toBe(65_536);
    expect(OUTPUT_MAX_PENDING_BYTES).toBe(4_194_304);
  });
});

describe('output batcher: coalescing and frames', () => {
  it('sends nothing before the tick and one frame after it for many small pushes', () => {
    const h = harness();
    for (let i = 0; i < 100; i += 1) h.batcher.push(bytes(10, i));
    expect(h.frames).toHaveLength(0);
    expect(h.batcher.pendingBytes).toBe(1000);
    expect(h.ticks.scheduled).toBe(1);
    h.ticks.drain();
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]?.length).toBe(1000);
    expect(h.batcher.pendingBytes).toBe(0);
  });

  it('keeps the bytes and their order across pushes', () => {
    const h = harness();
    const parts = [bytes(7, 1), bytes(1, 2), bytes(300, 3), bytes(0, 4), bytes(64, 5)];
    for (const part of parts) h.batcher.push(part);
    h.ticks.drain();
    expect(Buffer.concat(h.frames).equals(Buffer.concat(parts))).toBe(true);
  });

  it('sends one frame of at most 64 KiB per tick and a large push takes several ticks', () => {
    const h = harness();
    const big = bytes(OUTPUT_FRAME_BYTES * 2 + 123);
    h.batcher.push(big);
    expect(h.ticks.tick()).toBe(true);
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]?.length).toBe(OUTPUT_FRAME_BYTES);
    expect(h.ticks.waiting).toBe(true);
    expect(h.ticks.tick()).toBe(true);
    expect(h.frames).toHaveLength(2);
    expect(h.ticks.tick()).toBe(true);
    expect(h.frames).toHaveLength(3);
    expect(h.frames[2]?.length).toBe(123);
    expect(h.ticks.waiting).toBe(false);
    expect(Buffer.concat(h.frames).equals(big)).toBe(true);
  });

  it('fills a frame from several chunks and splits the chunk that crosses the limit', () => {
    const h = harness({ frameBytes: 10 });
    const parts = [bytes(6, 1), bytes(6, 2), bytes(6, 3)];
    for (const part of parts) h.batcher.push(part);
    h.ticks.drain();
    expect(h.frames.map((frame) => frame.length)).toEqual([10, 8]);
    expect(Buffer.concat(h.frames).equals(Buffer.concat(parts))).toBe(true);
  });

  it('accepts a Uint8Array that is not a Buffer, a view onto a larger array included', () => {
    const h = harness();
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    h.batcher.push(backing.subarray(2, 5));
    h.ticks.drain();
    expect([...(h.frames[0] ?? [])]).toEqual([1, 2, 3]);
  });

  it('ignores an empty push and schedules nothing for it', () => {
    const h = harness();
    h.batcher.push(new Uint8Array(0));
    expect(h.ticks.scheduled).toBe(0);
    expect(h.batcher.pendingBytes).toBe(0);
  });

  it('keeps the order when pushes arrive between ticks', () => {
    const h = harness({ frameBytes: 4 });
    h.batcher.push(Buffer.from('abcdef'));
    h.ticks.tick();
    h.batcher.push(Buffer.from('gh'));
    h.ticks.drain();
    expect(Buffer.concat(h.frames).toString('latin1')).toBe('abcdefgh');
    expect(h.frames.every((frame) => frame.length <= 4)).toBe(true);
  });

  it('survives a large number of one-byte chunks without losing a byte', () => {
    const h = harness({ frameBytes: 1024 });
    const count = 50_000;
    const expected = Buffer.alloc(count);
    for (let i = 0; i < count; i += 1) {
      expected[i] = i & 0xff;
      h.batcher.push(Buffer.from([i & 0xff]));
    }
    h.ticks.drain();
    expect(Buffer.concat(h.frames).equals(expected)).toBe(true);
    expect(h.frames.every((frame) => frame.length <= 1024)).toBe(true);
  });
});

describe('output batcher: high water', () => {
  it('stops for good and signals once when the consumer is congested at a tick', () => {
    const h = harness();
    h.batcher.push(bytes(100));
    h.congested = true;
    h.ticks.drain();
    expect(h.frames).toHaveLength(0);
    expect(h.highWater.count).toBe(1);
    expect(h.batcher.closed).toBe(true);
    expect(h.batcher.pendingBytes).toBe(0);
    h.congested = false;
    h.batcher.push(bytes(10));
    h.ticks.drain();
    expect(h.frames).toHaveLength(0);
    expect(h.highWater.count).toBe(1);
  });

  it('stops when more than the pending limit waits and queues nothing of the push that crossed it', () => {
    const h = harness({ maxPendingBytes: 1000 });
    h.batcher.push(bytes(600));
    h.batcher.push(bytes(400));
    expect(h.highWater.count).toBe(0);
    h.batcher.push(bytes(1));
    expect(h.highWater.count).toBe(1);
    expect(h.batcher.closed).toBe(true);
    h.ticks.drain();
    expect(h.frames).toHaveLength(0);
  });

  it('a large push over the pending limit is refused at once', () => {
    const h = harness({ maxPendingBytes: 100 });
    h.batcher.push(bytes(101));
    expect(h.highWater.count).toBe(1);
    expect(h.batcher.closed).toBe(true);
  });

  it('asks the consumer before every frame, not only before the first', () => {
    const h = harness({ frameBytes: 10 });
    h.batcher.push(bytes(35));
    h.ticks.tick();
    expect(h.frames).toHaveLength(1);
    h.congested = true;
    h.ticks.drain();
    expect(h.frames).toHaveLength(1);
    expect(h.highWater.count).toBe(1);
  });
});

describe('output batcher: flush and close', () => {
  it('flush sends everything pending now, in frames of at most the limit, and cancels the tick', () => {
    const h = harness({ frameBytes: 10 });
    const parts = [bytes(25, 1), bytes(7, 2)];
    for (const part of parts) h.batcher.push(part);
    h.batcher.flush();
    expect(h.frames.map((frame) => frame.length)).toEqual([10, 10, 10, 2]);
    expect(Buffer.concat(h.frames).equals(Buffer.concat(parts))).toBe(true);
    expect(h.batcher.pendingBytes).toBe(0);
    expect(h.ticks.cancelled).toBe(1);
    expect(h.ticks.waiting).toBe(false);
  });

  it('flush of an empty batcher does nothing', () => {
    const h = harness();
    h.batcher.flush();
    expect(h.frames).toHaveLength(0);
    expect(h.ticks.cancelled).toBe(0);
  });

  it('flush stops at a congested consumer', () => {
    const h = harness({ frameBytes: 10 });
    h.batcher.push(bytes(30));
    h.congested = true;
    h.batcher.flush();
    expect(h.frames).toHaveLength(0);
    expect(h.highWater.count).toBe(1);
  });

  it('close drops what is pending, cancels the tick and ignores later pushes and flushes', () => {
    const h = harness();
    h.batcher.push(bytes(100));
    h.batcher.close();
    expect(h.batcher.closed).toBe(true);
    expect(h.batcher.pendingBytes).toBe(0);
    expect(h.ticks.cancelled).toBe(1);
    h.batcher.push(bytes(10));
    h.batcher.flush();
    h.ticks.drain();
    expect(h.frames).toHaveLength(0);
    expect(h.highWater.count).toBe(0);
    h.batcher.close();
  });

  it('a push from inside send is queued behind the frame being sent', () => {
    const ticks = new ManualTicks();
    const frames: Buffer[] = [];
    const holder: { batcher?: OutputBatcher } = {};
    const batcher = createOutputBatcher({
      send: (frame) => {
        frames.push(frame);
        if (frames.length === 1) holder.batcher?.push(Buffer.from('tail'));
      },
      schedule: ticks.schedule,
    });
    holder.batcher = batcher;
    batcher.push(Buffer.from('head'));
    ticks.drain();
    expect(Buffer.concat(frames).toString('latin1')).toBe('headtail');
  });
});

describe('output batcher: the real scheduler', () => {
  it('sends a large push as several frames over several event loop turns', async () => {
    const frames: Buffer[] = [];
    let done: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    const total = OUTPUT_FRAME_BYTES * 3;
    let sent = 0;
    const batcher = createOutputBatcher({
      send: (frame) => {
        frames.push(frame);
        sent += frame.length;
        if (sent === total) done?.();
      },
    });
    batcher.push(bytes(total));
    expect(frames).toHaveLength(0);
    await finished;
    expect(frames.map((frame) => frame.length)).toEqual([OUTPUT_FRAME_BYTES, OUTPUT_FRAME_BYTES, OUTPUT_FRAME_BYTES]);
  });
});
