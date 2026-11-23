// TC-EVW-01: the incremental parser of a `text/event-stream` body (ADR 0108).
import { McsError } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { createSseParser, type SseFrame } from './sse.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('createSseParser', () => {
  it('reads id, event and data, joins data lines, and skips comments, retry and a frame without data', () => {
    const parser = createSseParser();
    const text = [
      'retry: 3000',
      '',
      ': a comment',
      'event: hello',
      'data: {"a":1}',
      '',
      'id: 7',
      'event: change',
      'data: one',
      'data:two',
      'unknown: x',
      '',
      'data: plain\r',
      '\r',
      '',
    ].join('\n');
    expect(parser.push(bytes(text))).toEqual<SseFrame[]>([
      { id: null, event: 'hello', data: '{"a":1}' },
      { id: '7', event: 'change', data: 'one\ntwo' },
      { id: null, event: 'message', data: 'plain' },
    ]);
  });

  it('gives the same frames for any split of the bytes, also inside a UTF-8 sequence', () => {
    const whole = bytes('id: 12\nevent: change\ndata: {"text":"café ✓"}\n\nevent: heartbeat\ndata: {}\n\n');
    const expected = createSseParser().push(whole);
    expect(expected).toHaveLength(2);
    for (let size = 1; size <= 7; size += 1) {
      const parser = createSseParser();
      const frames: SseFrame[] = [];
      for (let at = 0; at < whole.length; at += size) frames.push(...parser.push(whole.subarray(at, at + size)));
      expect(frames, `chunks of ${String(size)}`).toEqual(expected);
    }
  });

  it('refuses a frame above the limit, and counts every frame on its own', () => {
    const parser = createSseParser(64);
    const frame = bytes(`data: ${'x'.repeat(40)}\n\n`);
    expect(parser.push(frame)).toHaveLength(1);
    expect(parser.push(frame)).toHaveLength(1);
    let error: unknown;
    try {
      parser.push(bytes(`data: ${'x'.repeat(80)}`));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(McsError);
    expect((error as McsError).details).toMatchObject({ reason: 'frame_too_large' });
  });
});
