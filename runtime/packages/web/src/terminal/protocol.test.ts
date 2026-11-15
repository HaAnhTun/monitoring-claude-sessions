import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_SIZE_LIMITS,
  TERMINAL_TEXT_FRAME_MAX_BYTES,
  TerminalClientMessageSchema,
} from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import {
  chunkBytes,
  closePolicy,
  encodeInput,
  encodeResize,
  FIT_DEBOUNCE_MS,
  MAX_CONTROL_FRAME_CHARS,
  MAX_INPUT_FRAME_BYTES,
  parseServerFrame,
  RECONNECT_CAP_MS,
  RELEASE_CHORD,
  terminalSocketUrl,
  type ClosePolicy,
} from './protocol.ts';

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Decodes with `fatal`: a chunk that cut a code point in half throws and fails the test. */
function decodedChunks(chunks: readonly Uint8Array[]): string[] {
  return chunks.map((chunk) => strictDecoder.decode(chunk));
}

describe('constants', () => {
  it('names the limits of design 04 7.2', () => {
    expect(MAX_INPUT_FRAME_BYTES).toBe(16_384);
    expect(FIT_DEBOUNCE_MS).toBe(100);
    expect(RECONNECT_CAP_MS).toBe(15_000);
    expect(RELEASE_CHORD).toBe('Ctrl+Shift+Space');
  });

  it('keeps an input frame far below the server limit of one message', () => {
    expect(MAX_INPUT_FRAME_BYTES).toBeLessThan(262_144);
  });
});

describe('TC-UI-06: terminalSocketUrl', () => {
  const NAME = 'fixture-term-1';

  it('uses ws for http and carries the host and the port of the page', () => {
    expect(terminalSocketUrl(NAME, { protocol: 'http:', host: '127.0.0.1:7690' })).toBe(
      'ws://127.0.0.1:7690/api/v3/terminal/sessions/fixture-term-1/socket',
    );
  });

  it('uses wss for https', () => {
    expect(terminalSocketUrl(NAME, { protocol: 'https:', host: 'app.example.test' })).toBe(
      'wss://app.example.test/api/v3/terminal/sessions/fixture-term-1/socket',
    );
  });

  it('keeps an IPv6 host in brackets', () => {
    expect(terminalSocketUrl(NAME, { protocol: 'http:', host: '[::1]:7690' })).toBe(
      'ws://[::1]:7690/api/v3/terminal/sessions/fixture-term-1/socket',
    );
  });

  it('has no query string and no fragment, so no credential can travel in it (the cookie authenticates)', () => {
    const url = terminalSocketUrl(NAME, { protocol: 'http:', host: '127.0.0.1:7690' });
    expect(url).not.toContain('?');
    expect(url).not.toContain('#');
  });

  it.each(['', 'a/b', '..', 'a b', 'name.with.dot', 'a'.repeat(65), 'tab\tname', 'caf\u00e9'])(
    'refuses the name %j without echoing it',
    (name) => {
      expect(() => terminalSocketUrl(name, { protocol: 'http:', host: '127.0.0.1:7690' })).toThrow(TypeError);
      try {
        terminalSocketUrl(name, { protocol: 'http:', host: '127.0.0.1:7690' });
      } catch (error) {
        if (name !== '') expect(String(error)).not.toContain(name);
      }
    },
  );

  it.each(['file:', 'about:', 'ftp:', ''])('refuses a page that is not served over http or https (%j)', (protocol) => {
    expect(() => terminalSocketUrl(NAME, { protocol, host: 'x' })).toThrow(TypeError);
  });
});

describe('TC-UI-06: encodeInput', () => {
  it('sends nothing for an empty string', () => {
    expect(encodeInput('')).toEqual([]);
  });

  it('encodes a short string as one frame of its UTF-8 bytes', () => {
    const frames = encodeInput('ls -la\r');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(encoder.encode('ls -la\r'));
  });

  it('passes control characters through unchanged (Ctrl+C is 0x03, Tab is 0x09, Escape is 0x1b)', () => {
    expect([...joined(encodeInput('\x03\t\x1b[A\x00'))]).toEqual([0x03, 0x09, 0x1b, 0x5b, 0x41, 0x00]);
  });

  it('keeps exactly 16 KiB in one frame', () => {
    const frames = encodeInput('a'.repeat(MAX_INPUT_FRAME_BYTES));
    expect(frames.map((frame) => frame.length)).toEqual([MAX_INPUT_FRAME_BYTES]);
  });

  it('splits 16 KiB plus one byte into two frames in order', () => {
    const frames = encodeInput(`${'a'.repeat(MAX_INPUT_FRAME_BYTES)}b`);
    expect(frames.map((frame) => frame.length)).toEqual([MAX_INPUT_FRAME_BYTES, 1]);
    expect(decodedChunks(frames).join('')).toBe(`${'a'.repeat(MAX_INPUT_FRAME_BYTES)}b`);
  });

  it('never exceeds 16 KiB per frame and reassembles to the original bytes (1 MiB paste)', () => {
    const text = 'line of text \u00e9\u1ec7 \u20ac \u{1f600}\n'.repeat(40_000);
    const frames = encodeInput(text);
    expect(Math.max(...frames.map((frame) => frame.length))).toBeLessThanOrEqual(MAX_INPUT_FRAME_BYTES);
    expect(frames.length).toBeGreaterThan(40);
    expect(joined(frames)).toEqual(encoder.encode(text));
  });

  // The size of a character in UTF-8 and one sample of it; a frame boundary is tried at every offset around 16 KiB.
  const SAMPLES: readonly (readonly [string, number, string])[] = [
    ['one byte', 1, 'a'],
    ['two bytes', 2, '\u00e9'],
    ['three bytes', 3, '\u20ac'],
    ['four bytes (a surrogate pair)', 4, '\u{1f600}'],
  ];

  it.each(SAMPLES)(
    'cuts only at code point boundaries: a %s character at every offset around the limit',
    (_label, width, sample) => {
      for (let offset = MAX_INPUT_FRAME_BYTES - 5; offset <= MAX_INPUT_FRAME_BYTES + 1; offset += 1) {
        const text = `${'a'.repeat(offset)}${sample}${sample}tail`;
        const frames = encodeInput(text);
        // decoding with `fatal` throws when a frame ends inside a code point
        expect(decodedChunks(frames).join('')).toBe(text);
        for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(MAX_INPUT_FRAME_BYTES);
        expect(joined(frames)).toEqual(encoder.encode(text));
        if (width > 1 && offset + width > MAX_INPUT_FRAME_BYTES && offset < MAX_INPUT_FRAME_BYTES) {
          // the character straddles the limit: the first frame ends before it
          expect(frames[0]?.length).toBe(offset);
        }
      }
    },
  );

  it('starts the second frame with the whole straddling character (a euro sign across the limit)', () => {
    const frames = encodeInput(`${'a'.repeat(MAX_INPUT_FRAME_BYTES - 1)}\u20ac`);
    expect(frames.map((frame) => frame.length)).toEqual([MAX_INPUT_FRAME_BYTES - 1, 3]);
    expect(strictDecoder.decode(frames[1])).toBe('\u20ac');
  });

  it('keeps a surrogate pair together across the limit', () => {
    const frames = encodeInput(`${'a'.repeat(MAX_INPUT_FRAME_BYTES - 2)}\u{1f600}`);
    expect(frames.map((frame) => frame.length)).toEqual([MAX_INPUT_FRAME_BYTES - 2, 4]);
    expect(strictDecoder.decode(frames[1])).toBe('\u{1f600}');
  });

  it('sends a lone surrogate as the replacement character, always as valid UTF-8', () => {
    const frames = encodeInput('a\ud800b');
    expect(decodedChunks(frames).join('')).toBe('a\ufffdb');
  });

  it('encodes Vietnamese text with combining marks without loss', () => {
    const text = 'Ti\u1ebfng Vi\u1ec7t: \u0111\u01b0\u1eddng g\u0323\u0302'.repeat(5000);
    expect(joined(encodeInput(text))).toEqual(encoder.encode(text));
  });
});

describe('chunkBytes', () => {
  it('returns no frame for no bytes', () => {
    expect(chunkBytes(new Uint8Array(0))).toEqual([]);
  });

  it('splits raw bytes at exactly the limit, in order, without copying meaning into them', () => {
    const bytes = Uint8Array.from({ length: MAX_INPUT_FRAME_BYTES * 2 + 7 }, (_value, index) => index % 251);
    const frames = chunkBytes(bytes);
    expect(frames.map((frame) => frame.length)).toEqual([MAX_INPUT_FRAME_BYTES, MAX_INPUT_FRAME_BYTES, 7]);
    expect(joined(frames)).toEqual(bytes);
  });

  it('keeps a short input as one frame', () => {
    expect(chunkBytes(Uint8Array.of(0x1b, 0x5b, 0x4d))).toEqual([Uint8Array.of(0x1b, 0x5b, 0x4d)]);
  });
});

describe('TC-UI-06: encodeResize', () => {
  it('writes the one text frame a client sends', () => {
    expect(encodeResize(120, 30)).toBe('{"type":"resize","cols":120,"rows":30}');
  });

  it('is accepted by the shared client message schema and fits the text limit of the server', () => {
    const text = encodeResize(500, 200);
    expect(TerminalClientMessageSchema.parse(JSON.parse(text))).toEqual({ type: 'resize', cols: 500, rows: 200 });
    expect(encoder.encode(text).length).toBeLessThanOrEqual(TERMINAL_TEXT_FRAME_MAX_BYTES);
  });

  it('clamps to the limits of the terminal before sending', () => {
    const limits = TERMINAL_SIZE_LIMITS;
    expect(JSON.parse(encodeResize(1, 1))).toEqual({ type: 'resize', cols: limits.minCols, rows: limits.minRows });
    expect(JSON.parse(encodeResize(5000, 5000))).toEqual({
      type: 'resize',
      cols: limits.maxCols,
      rows: limits.maxRows,
    });
  });

  it('cuts a fraction and replaces a value that is not a finite number with the default', () => {
    const limits = TERMINAL_SIZE_LIMITS;
    expect(JSON.parse(encodeResize(80.9, 24.2))).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(JSON.parse(encodeResize(Number.NaN, Number.POSITIVE_INFINITY))).toEqual({
      type: 'resize',
      cols: limits.defaultCols,
      rows: limits.defaultRows,
    });
  });
});

describe('TC-UI-06: parseServerFrame', () => {
  it('parses the four frames of protocol v1', () => {
    expect(parseServerFrame('{"type":"ready","v":1,"cols":120,"rows":30,"replayBytes":4096,"viewers":2}')).toEqual({
      type: 'ready',
      v: 1,
      cols: 120,
      rows: 30,
      replayBytes: 4096,
      viewers: 2,
    });
    expect(parseServerFrame('{"type":"live"}')).toEqual({ type: 'live' });
    expect(parseServerFrame('{"type":"size","cols":90,"rows":25}')).toEqual({ type: 'size', cols: 90, rows: 25 });
    expect(parseServerFrame('{"type":"exit","code":3,"signal":null}')).toEqual({
      type: 'exit',
      code: 3,
      signal: null,
    });
    expect(parseServerFrame('{"type":"exit","code":null,"signal":"SIGTERM"}')).toEqual({
      type: 'exit',
      code: null,
      signal: 'SIGTERM',
    });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['an empty string', ''],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"ready"'],
    ['a JSON number', '1'],
    ['an object without a type', '{"cols":80,"rows":24}'],
    ['an unknown type', '{"type":"focus"}'],
    ['a client frame sent by the server', '{"type":"resize","cols":80,"rows":24}'],
    ['an extra key', '{"type":"live","extra":true}'],
    ['a wrong protocol version', '{"type":"ready","v":2,"cols":80,"rows":24,"replayBytes":0,"viewers":0}'],
    ['a missing field', '{"type":"ready","v":1,"cols":80,"rows":24,"viewers":0}'],
    ['a zero dimension', '{"type":"size","cols":0,"rows":24}'],
    ['a dimension over 1000', '{"type":"size","cols":1001,"rows":24}'],
    ['a fractional dimension', '{"type":"size","cols":80.5,"rows":24}'],
    ['a string dimension', '{"type":"size","cols":"80","rows":24}'],
    ['an exit code that is not an integer', '{"type":"exit","code":1.5,"signal":null}'],
    ['an empty signal', '{"type":"exit","code":0,"signal":""}'],
    ['a prototype key', '{"type":"live","__proto__":{"x":1}}'],
  ])('returns null for %s', (_label, text) => {
    expect(parseServerFrame(text)).toBeNull();
  });

  it('returns null for a text frame over the size cap, even when its content would be valid', () => {
    const padded = `{"type":"live"${' '.repeat(MAX_CONTROL_FRAME_CHARS)}}`;
    expect(padded.length).toBeGreaterThan(MAX_CONTROL_FRAME_CHARS);
    expect(parseServerFrame(padded)).toBeNull();
    expect(parseServerFrame(`{"type":"exit","code":0,"signal":"${'S'.repeat(5000)}"}`)).toBeNull();
  });

  it('accepts a frame exactly at the cap', () => {
    const base = '{"type":"live"}';
    const padded = base.slice(0, -1) + ' '.repeat(MAX_CONTROL_FRAME_CHARS - base.length) + '}';
    expect(padded.length).toBe(MAX_CONTROL_FRAME_CHARS);
    expect(parseServerFrame(padded)).toEqual({ type: 'live' });
  });

  it('never throws, whatever the text', () => {
    for (const text of ['{', '}', '\u0000', '{"type":', '\ud800', '{"type":"live"}garbage']) {
      expect(() => parseServerFrame(text)).not.toThrow();
      expect(parseServerFrame(text)).toBeNull();
    }
  });
});

describe('TC-UI-06: closePolicy', () => {
  // Every code of the shared table has a stated answer; a code added to the table without one fails the first test.
  const BY_NAME: Record<keyof typeof TERMINAL_CLOSE_CODES, ClosePolicy> = {
    normal: 'end',
    shuttingDown: 'reconnect',
    protocolError: 'fail',
    badMessage: 'fail',
    tooBig: 'fail',
    internalError: 'reconnect',
    slowConsumer: 'reconnect',
    exited: 'end',
    killed: 'end',
    signedOut: 'locked',
  };

  it('answers every code of TERMINAL_CLOSE_CODES', () => {
    expect(Object.keys(BY_NAME).sort()).toEqual(Object.keys(TERMINAL_CLOSE_CODES).sort());
    for (const [name, code] of Object.entries(TERMINAL_CLOSE_CODES)) {
      const policy = BY_NAME[name as keyof typeof TERMINAL_CLOSE_CODES];
      expect(closePolicy(code), `${name} (${String(code)})`).toBe(policy);
    }
  });

  it.each([
    [4000, 'end'],
    [4001, 'end'],
    [1000, 'end'],
    [4003, 'locked'],
    [1001, 'reconnect'],
    [1006, 'reconnect'],
    [1013, 'reconnect'],
    [1011, 'reconnect'],
    [1002, 'fail'],
    [1007, 'fail'],
    [1008, 'fail'],
    [1009, 'fail'],
  ] as const)('maps %i to %s', (code, policy) => {
    expect(closePolicy(code)).toBe(policy);
  });

  it.each([0, 1005, 1012, 1014, 1015, 3000, 4002, 4004, 4999, -1, 70_000])(
    'reconnects after an unknown code (%i): the oracle ends the view if the session is gone',
    (code) => {
      expect(closePolicy(code)).toBe('reconnect');
    },
  );
});
