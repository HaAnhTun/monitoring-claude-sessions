// Incremental parser of a `text/event-stream` body (ADR 0108, the follower of `events` and `wait`). It takes the chunks of the
// answer as they arrive, in any split, and returns the frames that became complete:
//   - a line ends with LF or CR LF (what the server writes); a line may be cut anywhere, also inside a UTF-8 sequence;
//   - `id`, `event` and `data` are the fields of a frame, several `data` lines are joined with a line feed;
//   - a comment (a line that starts with `:`), `retry` and any unknown field are ignored;
//   - a blank line ends the frame; a frame without `data` is not delivered (the `retry:` frame the server opens with);
//   - a frame larger than the limit is an error: the server never writes more than 64 KiB, so more is not this stream.
import { McsError } from '@mcs/shared';

export interface SseFrame {
  /** The `id` field of this frame, `null` when it has none. */
  readonly id: string | null;
  /** The `event` field of this frame, `message` when it has none. */
  readonly event: string;
  readonly data: string;
}

export interface SseParser {
  /** The frames that `chunk` completed, in order. Throws `API_ERROR` (`frame_too_large`) for a frame above the limit. */
  push(chunk: Uint8Array): SseFrame[];
}

/** A frame of the stream is at most 64 KiB (03 9.3); the fields and the line ends add a little. */
export const SSE_MAX_FRAME_BYTES = 70 * 1024;

const LF = 10;

export function createSseParser(maxFrameBytes: number = SSE_MAX_FRAME_BYTES): SseParser {
  /** The pieces of the line that has not ended yet. */
  let pending: Buffer[] = [];
  /** The bytes of the frame that has not ended yet, line ends included. */
  let frameBytes = 0;
  let id: string | null = null;
  let event: string | null = null;
  let data: string[] = [];

  const count = (bytes: number): void => {
    frameBytes += bytes;
    if (frameBytes > maxFrameBytes) {
      throw new McsError('API_ERROR', 'a frame of the change stream is larger than the reader accepts', {
        details: { reason: 'frame_too_large' },
      });
    }
  };

  /** Applies one complete line; returns the frame when the line ended one that has data. */
  const line = (text: string): SseFrame | null => {
    if (text === '') {
      const frame = data.length === 0 ? null : { id, event: event ?? 'message', data: data.join('\n') };
      frameBytes = 0;
      id = null;
      event = null;
      data = [];
      return frame;
    }
    if (text.startsWith(':')) return null;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    const rest = colon < 0 ? '' : text.slice(colon + 1);
    const value = rest.startsWith(' ') ? rest.slice(1) : rest;
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
    return null;
  };

  return {
    push(chunk) {
      const frames: SseFrame[] = [];
      const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
      let from = 0;
      for (;;) {
        const at = buffer.indexOf(LF, from);
        if (at < 0) break;
        count(at + 1 - from);
        pending.push(buffer.subarray(from, at));
        // a line feed is never part of a UTF-8 sequence, so a complete line decodes on its own
        const text = Buffer.concat(pending).toString('utf8');
        pending = [];
        from = at + 1;
        const frame = line(text.endsWith('\r') ? text.slice(0, -1) : text);
        if (frame !== null) frames.push(frame);
      }
      if (from < buffer.length) {
        count(buffer.length - from);
        // a copy: the caller may reuse the memory of the chunk
        pending.push(Buffer.from(buffer.subarray(from)));
      }
      return frames;
    },
  };
}
