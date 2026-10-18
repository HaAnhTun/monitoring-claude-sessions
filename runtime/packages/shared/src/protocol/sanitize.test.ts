import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  REDACTION_RULES,
  canonicalJsonHash,
  clip,
  normalizePath,
  pyJsonDumps,
  redact,
  redactDetailed,
  routeKey,
  summarizeToolInput,
  summarizeToolInputDetailed,
} from './sanitize.ts';

const BS = String.fromCharCode(92);
const EMOJI = String.fromCodePoint(0x1f642);
const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde42);
const E_ACUTE = String.fromCharCode(0xe9);

// Frozen data of the pre-4.0 engine, ADR 0066: the captured outputs of the legacy clip, committed as JSON.
const GOLDEN_CLIP = new URL('../../test/fixtures/clip.frozen.json', import.meta.url);

interface ClipVector {
  case: string;
  input: { n: number; value?: unknown; value_json?: string };
  output: string;
}

// Golden cases that JavaScript cannot represent after JSON.parse (Python keeps int and float apart, and orders
// integer-like keys by insertion). Each is covered by an explicit test below instead.
const NOT_REPRESENTABLE = new Set([
  'float-one', // 1.0 parses to the integer 1
  'float-in-list', // [1.5, 2.0]
  'integer-big', // 12345678901234567890 loses digits
  'dict-numeric-keys-order', // JS orders integer-like keys first
]);

describe('clip', () => {
  it('matches the frozen legacy golden (test/fixtures/clip.frozen.json) case by case', () => {
    const vectors = JSON.parse(readFileSync(GOLDEN_CLIP, 'utf8')) as ClipVector[];
    expect(vectors.length).toBeGreaterThanOrEqual(45);
    let checked = 0;
    for (const vector of vectors) {
      if (NOT_REPRESENTABLE.has(vector.case)) continue;
      const value: unknown =
        vector.input.value_json !== undefined ? JSON.parse(vector.input.value_json) : vector.input.value;
      expect(clip(value, vector.input.n), vector.case).toBe(vector.output);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(vectors.length - NOT_REPRESENTABLE.size);
  });

  it('keeps a string that fits and cuts one that does not, counting code points', () => {
    expect(clip('hello', 10)).toBe('hello');
    expect(clip('hello', 5)).toBe('hello');
    expect(clip('hello', 4)).toBe('hell ... [truncated 1 chars]');
    expect(clip('', 0)).toBe('');
    expect(clip('abc', 0)).toBe(' ... [truncated 3 chars]');
  });

  it('never splits a surrogate pair and counts an astral character once', () => {
    expect(clip('ab' + EMOJI, 3)).toBe('ab' + EMOJI);
    expect(clip('ab' + EMOJI + 'cd', 3)).toBe('ab' + EMOJI + ' ... [truncated 2 chars]');
    expect(clip('ab' + EMOJI + 'cd', 2)).toBe('ab ... [truncated 3 chars]');
    expect(clip(EMOJI.repeat(10), 4)).toBe(EMOJI.repeat(4) + ' ... [truncated 6 chars]');
    // 6000 emoji are 12000 UTF-16 units but 6000 code points: they fit
    expect(clip(EMOJI.repeat(6000), 6000)).toBe(EMOJI.repeat(6000));
  });

  it('survives lone surrogates (counted as one unit each, never throws)', () => {
    expect(clip(HIGH + 'x', 1)).toBe(HIGH + ' ... [truncated 1 chars]');
    expect(clip(LOW + HIGH, 5)).toBe(LOW + HIGH);
    expect(() => clip(HIGH.repeat(5000), 160)).not.toThrow();
  });

  it('handles very long unicode input and keeps the marker count exact', () => {
    const text = EMOJI.repeat(50_000) + E_ACUTE.repeat(50_000);
    const out = clip(text, 160);
    expect(out).toBe(EMOJI.repeat(160) + ' ... [truncated 99840 chars]');
  });

  it('dumps a non-string with Python json.dumps formatting before clipping', () => {
    expect(clip({ a: 1, b: [1, 2] }, 100)).toBe('{"a": 1, "b": [1, 2]}');
    expect(clip({ a: 1, b: [1, 2] }, 7)).toBe('{"a": 1 ... [truncated 14 chars]');
    expect(clip(null, 10)).toBe('null');
    expect(clip(undefined, 10)).toBe('null');
    expect(clip(true, 10)).toBe('true');
    expect(clip(12345, 3)).toBe('123 ... [truncated 2 chars]');
  });

  it('follows Python slicing for a negative n (legacy parity)', () => {
    expect(clip('abcdef', -1)).toBe('abcde ... [truncated 7 chars]');
  });

  it('rejects an n that is not an integer', () => {
    expect(() => clip('abc', Number.NaN)).toThrow(RangeError);
    expect(() => clip('abc', 1.5)).toThrow(RangeError);
    expect(() => clip('abc', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('pyJsonDumps (json.dumps with ensure_ascii=False)', () => {
  it.each([
    [null, 'null'],
    [true, 'true'],
    [false, 'false'],
    [0, '0'],
    [-7, '-7'],
    [42, '42'],
    [0.1, '0.1'],
    [1.5, '1.5'],
    [-2.25, '-2.25'],
    [0.3333333333333333, '0.3333333333333333'],
    [1e22, '1e+22'],
    [1e16, '1e+16'],
    [1.5e16, '1.5e+16'],
    [123456789012345, '123456789012345'],
    [1e-7, '1e-07'],
    [1.5e-7, '1.5e-07'],
    [0.00001, '1e-05'],
    [0.0001, '0.0001'],
    [0.00012, '0.00012'],
    [5e-324, '5e-324'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
    [-0, '-0.0'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [Number.NEGATIVE_INFINITY, '-Infinity'],
    [123456789.125, '123456789.125'],
    [9007199254740993n, '9007199254740993'],
  ])('number-like %s -> %s', (value, expected) => {
    expect(pyJsonDumps(value)).toBe(expected);
  });

  it('escapes only the characters json.dumps escapes when ensure_ascii is false', () => {
    expect(pyJsonDumps('a"b')).toBe('"a' + BS + '"b"');
    expect(pyJsonDumps('a' + BS + 'b')).toBe('"a' + BS + BS + 'b"');
    expect(pyJsonDumps('line1' + String.fromCharCode(10) + 'line2')).toBe('"line1' + BS + 'nline2"');
    expect(pyJsonDumps(String.fromCharCode(13, 9, 8, 12))).toBe('"' + BS + 'r' + BS + 't' + BS + 'b' + BS + 'f"');
    expect(pyJsonDumps(String.fromCharCode(0, 1, 31))).toBe('"' + BS + 'u0000' + BS + 'u0001' + BS + 'u001f"');
    // not escaped: slash, DEL, NEL, line and paragraph separators, non-ASCII, astral, lone surrogate
    expect(pyJsonDumps('a/b')).toBe('"a/b"');
    expect(pyJsonDumps(String.fromCharCode(0x7f))).toBe('"' + String.fromCharCode(0x7f) + '"');
    expect(pyJsonDumps(String.fromCharCode(0x85, 0x2028, 0x2029))).toBe(
      '"' + String.fromCharCode(0x85, 0x2028, 0x2029) + '"',
    );
    expect(pyJsonDumps(E_ACUTE + EMOJI)).toBe('"' + E_ACUTE + EMOJI + '"');
    expect(pyJsonDumps(HIGH)).toBe('"' + HIGH + '"');
  });

  it('uses the default separators and keeps insertion order', () => {
    expect(pyJsonDumps({})).toBe('{}');
    expect(pyJsonDumps([])).toBe('[]');
    expect(pyJsonDumps({ b: 1, a: [1, { c: null }], d: {} })).toBe('{"b": 1, "a": [1, {"c": null}], "d": {}}');
    expect(pyJsonDumps([1, 'a', null, true, [], {}])).toBe('[1, "a", null, true, [], {}]');
  });

  it('treats undefined like json.dumps treats None in a list and omits it in an object', () => {
    expect(pyJsonDumps([undefined, 1])).toBe('[null, 1]');
    expect(pyJsonDumps({ a: undefined, b: 1 })).toBe('{"b": 1}');
    expect(pyJsonDumps(undefined)).toBe('null');
  });

  it('rejects what json.dumps rejects', () => {
    expect(() => pyJsonDumps(() => 1)).toThrow(TypeError);
    expect(() => pyJsonDumps(Symbol('x'))).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => pyJsonDumps(cyclic)).toThrow(TypeError);
  });

  it('does not treat a repeated (non-cyclic) object as a cycle', () => {
    const shared = { x: 1 };
    expect(pyJsonDumps([shared, shared])).toBe('[{"x": 1}, {"x": 1}]');
  });

  it('documents the golden cases JavaScript cannot represent (float-one, float-in-list, integer-big, numeric key order)', () => {
    expect(pyJsonDumps(JSON.parse('1.0'))).toBe('1'); // Python: 1.0
    expect(pyJsonDumps(JSON.parse('[1.5, 2.0]'))).toBe('[1.5, 2]'); // Python: [1.5, 2.0]
    expect(pyJsonDumps(JSON.parse('12345678901234567890'))).toBe('1.2345678901234567e+19'); // Python int: all digits
    expect(pyJsonDumps(JSON.parse('{"10": 1, "2": 2}'))).toBe('{"2": 2, "10": 1}'); // Python: insertion order
  });

  it('is exact for the integer and float cases of the golden that JavaScript can express', () => {
    expect(pyJsonDumps(JSON.parse('1e22'))).toBe('1e+22');
    expect(pyJsonDumps(JSON.parse('-0.0'))).toBe('-0.0');
    expect(pyJsonDumps(JSON.parse('0.1'))).toBe('0.1');
    expect(pyJsonDumps(JSON.parse('{"b": 1, "a": 2}'))).toBe('{"b": 1, "a": 2}');
  });
});

describe('redact (T-HK-04, rules R1-R7)', () => {
  it('lists R1-R7 in order with the replacement text of 02 2.5.3', () => {
    expect(REDACTION_RULES.map((rule) => rule.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
    expect(REDACTION_RULES.map((rule) => rule.to)).toEqual([
      '$1: [redacted]',
      '$1=[redacted]',
      '$1[redacted]',
      '[redacted]',
      '$1[redacted]@',
      '[email]',
      '[redacted:<length>]',
    ]);
  });

  describe('R1 authorization headers', () => {
    it.each([
      ['Authorization: Bearer abc123def', 'Authorization: [redacted]'],
      [
        'curl -H "authorization: basic dXNlcjpwYXNz" https://example.invalid',
        'curl -H "authorization: [redacted]" https://example.invalid',
      ],
      ['Proxy-Authorization=token abcdef', 'Proxy-Authorization: [redacted]'],
      ['x-authorization-note: none', 'x-authorization-note: none'],
      ['the author wrote: hello', 'the author wrote: hello'],
    ])('%s', (input, expected) => {
      expect(redact(input)).toBe(expected);
    });
  });

  describe('R2 name = value pairs', () => {
    it.each([
      ['password=hunter2', 'password=[redacted]'],
      ['API_KEY: "abc def"', 'API_KEY=[redacted]'],
      ["client_secret='s3cr3t value'", 'client_secret=[redacted]'],
      ['GITHUB_TOKEN=abc123 npm test', 'GITHUB_TOKEN=[redacted] npm test'],
      ['https://example.invalid/cb?access_key=AAA&x=1', 'https://example.invalid/cb?access_key=[redacted]&x=1'],
      ['db_passwd: letmein', 'db_passwd=[redacted]'],
      ['private-key = abcd', 'private-key=[redacted]'],
      ['username=alice', 'username=alice'],
      ['tokenizer is fast', 'tokenizer is fast'],
    ])('%s', (input, expected) => {
      expect(redact(input)).toBe(expected);
    });
  });

  describe('R3 secret command line flags', () => {
    it.each([
      ['tool --token abc123 run', 'tool --token [redacted] run'],
      ['tool --password=hunter2', 'tool --password=[redacted]'],
      ['tool -key "a b c"', 'tool -key [redacted]'],
      ['tool --api-key sk', 'tool --api-key [redacted]'],
      ['tool --verbose --name x', 'tool --verbose --name x'],
    ])('%s', (input, expected) => {
      expect(redact(input)).toBe(expected);
    });
  });

  describe('R4 well-known token shapes', () => {
    const fakeAnthropic = 'sk-ant-' + 'A1b2C3d4E5f6G7h8I9j0';
    const fakeOpenAi = 'sk-' + 'abcdefghijklmnopqrstuv';
    const fakeGithub = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123';
    const fakeAws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const fakeJwt = 'eyJ' + 'abcdefghij' + '.' + 'abcdefghijk' + '.' + 'abcdefghijkl';
    const fakeSlack = 'xoxb-' + '1234567890-abcdef';
    const fakeGoogle = 'AIza' + 'abcdefghijklmnopqrstuvwxyzABCDEFGHI';
    it.each([
      [fakeAnthropic],
      [fakeOpenAi],
      [fakeGithub],
      [fakeAws],
      [fakeJwt],
      [fakeSlack],
      [fakeGoogle],
      ['github_pat_' + 'abcdefghijklmnopqrstuvwxyz'],
    ])('replaces %s', (secret) => {
      expect(redact('use ' + secret + ' now')).toBe('use [redacted] now');
    });

    it('leaves near misses alone', () => {
      expect(redact('sk-short and ghp_short and AKIAshort')).toBe('sk-short and ghp_short and AKIAshort');
      expect(redact('task-1234567890123456')).toBe('task-1234567890123456');
    });
  });

  describe('R5 credentials in URLs', () => {
    it.each([
      ['git clone https://user:pass@example.invalid/repo.git', 'git clone https://[redacted]@example.invalid/repo.git'],
      ['postgres://admin:secret@localhost:5432/db', 'postgres://[redacted]@localhost:5432/db'],
      ['ssh://deploy:k3y@host', 'ssh://[redacted]@host'],
      ['https://example.invalid/path', 'https://example.invalid/path'],
      ['https://user@example.invalid/path', 'https://[email]/path'],
    ])('%s', (input, expected) => {
      expect(redact(input)).toBe(expected);
    });
  });

  describe('R6 email addresses', () => {
    it.each([
      ['mail alice@example.invalid now', 'mail [email] now'],
      ['a.b+c@sub.example.invalid', '[email]'],
      ['x@y.zz and q@r.ss', '[email] and [email]'],
      ['not an email: a@b', 'not an email: a@b'],
      ['@mcs/shared package', '@mcs/shared package'],
    ])('%s', (input, expected) => {
      expect(redact(input)).toBe(expected);
    });
  });

  describe('R7 long opaque strings', () => {
    it('replaces a 40+ character run with its length', () => {
      const run = 'Zq9'.repeat(15);
      expect(run).toHaveLength(45);
      expect(redact('blob ' + run + ' end')).toBe('blob [redacted:45] end');
      expect(redact('x'.repeat(40))).toBe('[redacted:40]');
      expect(redact('x'.repeat(39))).toBe('x'.repeat(39));
    });

    it('keeps pure lowercase hex of length 40 and 64 (git object ids), redacts other hex lengths', () => {
      const sha1 = 'a1b2c3d4e5'.repeat(4);
      const sha256 = 'a1b2c3d4e5f60718'.repeat(4);
      expect(redact('commit ' + sha1)).toBe('commit ' + sha1);
      expect(redact('digest ' + sha256)).toBe('digest ' + sha256);
      expect(redact('hex ' + 'a1b2c3d4e5'.repeat(4) + 'f')).toBe('hex [redacted:41]');
      expect(redact('hex ' + 'a1b2c3d4e5'.repeat(4).slice(1))).toBe('hex ' + 'a1b2c3d4e5'.repeat(4).slice(1));
      expect(redact('upper ' + 'A1B2C3D4E5'.repeat(4))).toBe('upper [redacted:40]');
    });

    it('does not touch normal paths and sentences', () => {
      const text = 'node --no-warnings scripts/mcs-hook.mjs --mcs-hook PreToolUse';
      expect(redact(text)).toBe(text);
    });
  });

  describe('quoted secret fields (hardening beyond R1-R7, CR-WP-04-1)', () => {
    it.each([
      ['{"password":"hunter2"}', '{"password":"[redacted]"}'],
      ['{"password": "hunter2", "user": "alice"}', '{"password": "[redacted]", "user": "alice"}'],
      ["{'api_key': 'abc 123', 'x': 1}", "{'api_key': \"[redacted]\", 'x': 1}"],
      ['{"headers":{"Authorization":"Bearer abc.def"}}', '{"headers":{"Authorization":"[redacted]"}}'],
      ['{"env":{"GITHUB_TOKEN":"abc"}}', '{"env":{"GITHUB_TOKEN":"[redacted]"}}'],
      ['{"client_secret":12345,"n":1}', '{"client_secret":"[redacted]","n":1}'],
      ['{"password":"a\\"b c"}', '{"password":"[redacted]"}'],
      [
        'curl -d \'{"token":"abc def"}\' https://example.invalid',
        'curl -d \'{"token":"[redacted]"}\' https://example.invalid',
      ],
      ['{"name":"alice","path":"/tmp/x"}', '{"name":"alice","path":"/tmp/x"}'],
      ['{"description":"about tokens"}', '{"description":"about tokens"}'],
    ])('%s', (input, expected) => {
      expect(redact(input)).toBe(expected);
    });

    it('is idempotent and reports the flag once', () => {
      const once = redactDetailed('{"password":"hunter2"}');
      expect(once.redacted).toBe(true);
      expect(redactDetailed(once.text)).toEqual({ text: once.text, redacted: false });
    });

    it('does not backtrack catastrophically on a long run of quotes and names', () => {
      for (const input of ['"a"'.repeat(1300), '"token.'.repeat(580), '"password":'.repeat(370), "'a-b'".repeat(800)]) {
        const started = performance.now();
        redact(input);
        expect(performance.now() - started, input.slice(0, 12)).toBeLessThan(400);
      }
    });
  });

  it('applies every rule inside one text, in order', () => {
    const input = 'curl -H "Authorization: Bearer tok.en" https://u:p@example.invalid -d password=hunter2 mail a@b.cc';
    const out = redact(input);
    expect(out).not.toMatch(/tok\.en|u:p@|hunter2|a@b\.cc/);
    expect(out).toContain('[email]');
  });

  it('is idempotent', () => {
    const inputs = [
      'Authorization: Bearer abc',
      'password=hunter2 --token xyz',
      'sk-ant-' + 'A1b2C3d4E5f6G7h8I9j0',
      'https://user:pass@example.invalid',
      'a@b.cc',
      'x'.repeat(60),
    ];
    for (const input of inputs) {
      const once = redact(input);
      expect(redact(once), input).toBe(once);
    }
  });

  it('is pure: no state survives between calls (global regexes)', () => {
    const input = 'password=a password=b';
    expect(redact(input)).toBe('password=[redacted] password=[redacted]');
    expect(redact(input)).toBe('password=[redacted] password=[redacted]');
  });

  it('never touches ids: UUIDs, tool use ids, agent ids and git ids pass through unchanged', () => {
    const ids = [
      '11111111-2222-4333-8444-555555555555',
      'toolu_01ABCDEFGHIJKLMNOPQRSTUV',
      'agent-a1b2c3d4e5f6a7b8c',
      'wf_run_0123456789',
      'a1b2c3d4e5'.repeat(4),
    ];
    for (const id of ids) {
      expect(redact(id), id).toBe(id);
    }
  });

  it('clips its input to 4096 code points before redacting (bounded work)', () => {
    const out = redact('a '.repeat(5000));
    expect(Array.from(out).length).toBeLessThan(4200);
    expect(out).toContain('[truncated');
  });

  it('does not backtrack catastrophically on adversarial input (the handler hard-exits at 1.2 s)', () => {
    const inputs = [
      'a.'.repeat(2048),
      'token'.repeat(820),
      'token.'.repeat(680),
      ('token.'.repeat(100) + ' ').repeat(6),
      'token.'.repeat(679) + '=',
      'a-'.repeat(2048) + '=',
      ('x'.repeat(39) + ' ').repeat(100),
      'password '.repeat(450),
      ':'.repeat(4096),
      'a@'.repeat(2048),
      'a.'.repeat(2000) + '@',
      'a'.repeat(2000) + '@' + 'a.'.repeat(1000),
      'http://'.repeat(585),
      '-token '.repeat(585),
      'api_key.'.repeat(500),
      'authorization:' + ' '.repeat(4000),
      'x://'.repeat(1000) + 'u:p',
    ];
    for (const input of inputs) {
      const started = performance.now();
      redact(input);
      expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(400);
    }
  });

  it('R2 keeps the meaning of the design pattern: differential test against the original regex', () => {
    const original =
      /\b([A-Za-z0-9_.-]*(token|secret|passw(or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)[A-Za-z0-9_.-]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s&]+)/gi;
    const rule = REDACTION_RULES.find((r) => r.id === 'R2');
    expect(rule).toBeDefined();
    const pieces = [
      'token',
      'Token',
      'SECRET',
      'password',
      'passwd',
      'Pwd',
      'api_key',
      'api-key',
      'apikey',
      'ACCESS_KEY',
      'access.key',
      'private-key',
      'client_secret',
      'credential',
      'credentials',
      'user',
      'x',
      'A1',
      '.',
      '-',
      '_',
      ':',
      '=',
      ' ',
      '  ',
      '&',
      '"',
      "'",
      '/',
      '[',
      ']',
      '1',
      String.fromCharCode(9),
      String.fromCharCode(10),
      EMOJI,
      E_ACUTE,
    ];
    let seed = 20_261_011;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    const piece = (): string => pieces[next() % pieces.length] ?? '';
    const keywords = pieces.slice(0, 14);
    const separators = ['=', ':', ' = ', ': ', '  :', '==', '=:', ''];
    const values = ['v', '"a b"', "'a b'", '"open', '', ' x', 'v&w', 'v w', '[redacted]'];
    let matched = 0;
    for (let i = 0; i < 30_000; i += 1) {
      let text = '';
      if (i % 2 === 0) {
        // shaped like a hit: filler, keyword, filler, separator, value, random tail
        text +=
          piece() +
          (keywords[next() % keywords.length] ?? '') +
          piece() +
          (separators[next() % separators.length] ?? '');
        text += (values[next() % values.length] ?? '') + piece() + piece();
      } else {
        const length = 1 + (next() % 14);
        for (let k = 0; k < length; k += 1) text += piece();
      }
      const expected = text.replace(original, '$1=[redacted]');
      const actual = text.replace(rule?.re ?? original, '$1=[redacted]');
      if (expected !== text) matched += 1;
      expect(actual, JSON.stringify(text)).toBe(expected);
    }
    expect(matched).toBeGreaterThan(3000);
  });

  it('survives lone surrogates and astral text next to a secret', () => {
    const text = HIGH + ' password=hunter2 ' + EMOJI + LOW;
    expect(redact(text)).toBe(HIGH + ' password=[redacted] ' + EMOJI + LOW);
  });

  describe('redactDetailed', () => {
    it('reports whether a rule changed the text (the "redacted" envelope flag)', () => {
      expect(redactDetailed('password=hunter2')).toEqual({ text: 'password=[redacted]', redacted: true });
      expect(redactDetailed('nothing secret')).toEqual({ text: 'nothing secret', redacted: false });
      expect(redactDetailed('')).toEqual({ text: '', redacted: false });
    });

    it('does not flag text that already holds the placeholder', () => {
      expect(redactDetailed('password=[redacted]').redacted).toBe(false);
    });

    it('agrees with redact on the text', () => {
      for (const input of ['a@b.cc', 'x'.repeat(50), 'plain']) {
        expect(redactDetailed(input).text).toBe(redact(input));
      }
    });
  });
});

describe('summarizeToolInput', () => {
  it('returns an empty string unless the input is a plain object', () => {
    for (const input of [null, undefined, 'npm test', 5, true, [], [{ command: 'x' }]]) {
      expect(summarizeToolInput(input)).toBe('');
    }
  });

  it('picks the first truthy key in legacy order, then the new keys', () => {
    expect(summarizeToolInput({ command: 'npm test', file_path: '/a' })).toBe('npm test');
    expect(summarizeToolInput({ command: '', file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(summarizeToolInput({ pattern: 'foo.*', description: 'search' })).toBe('foo.*');
    expect(summarizeToolInput({ description: 'd', prompt: 'p' })).toBe('d');
    expect(summarizeToolInput({ prompt: 'p', script: 's' })).toBe('p');
    expect(summarizeToolInput({ script: 's', url: 'u' })).toBe('s');
    expect(summarizeToolInput({ url: 'https://example.invalid/x', query: 'q' })).toBe('https://example.invalid/x');
    expect(summarizeToolInput({ query: 'q', path: '/p' })).toBe('q');
    expect(summarizeToolInput({ path: '/p', notebook_path: 'n' })).toBe('/p');
    expect(summarizeToolInput({ notebook_path: 'n.ipynb', skill: 's' })).toBe('n.ipynb');
    expect(summarizeToolInput({ skill: 'review', subject: 'x' })).toBe('review');
    expect(summarizeToolInput({ subject: 'only subject' })).toBe('only subject');
    expect(summarizeToolInput({ other: 'ignored' })).toBe('');
    expect(summarizeToolInput({})).toBe('');
  });

  it('skips falsy values (0, false, null, empty string) like the legacy "or" chain', () => {
    expect(summarizeToolInput({ command: 0, file_path: false, pattern: null, description: '', prompt: 'p' })).toBe('p');
  });

  it('stringifies a non-string key with JSON.stringify (documented deviation from str())', () => {
    expect(summarizeToolInput({ command: 123 })).toBe('123');
    expect(summarizeToolInput({ command: true })).toBe('true');
    expect(summarizeToolInput({ command: { a: 1, b: ['x'] } })).toBe('{"a":1,"b":["x"]}');
    expect(summarizeToolInput({ command: ['npm', 'test'] })).toBe('["npm","test"]');
  });

  it('keeps only the first line', () => {
    expect(summarizeToolInput({ command: 'first' + String.fromCharCode(10) + 'second' })).toBe('first');
    expect(summarizeToolInput({ command: String.fromCharCode(10) + 'after blank' })).toBe('');
  });

  it('redacts secrets in the first line and in nested JSON values', () => {
    expect(summarizeToolInput({ command: 'curl -H "Authorization: Bearer abc.def" https://example.invalid' })).toBe(
      'curl -H "Authorization: [redacted]" https://example.invalid',
    );
    expect(summarizeToolInput({ command: { env: { GITHUB_TOKEN: 'ghp_' + 'a'.repeat(30) } } })).not.toContain(
      'a'.repeat(30),
    );
    expect(summarizeToolInput({ command: [{ nested: { deeper: 'password=hunter2' } }] })).not.toContain('hunter2');
  });

  it('redacts quoted secret fields of a nested JSON tool input at any depth', () => {
    const nested = {
      command: {
        a: { b: [{ c: { api_key: 'sekret-one', password: 'sekret-two', Authorization: 'Bearer sekret-three' } }] },
      },
    };
    const out = summarizeToolInput(nested);
    expect(out).not.toMatch(/sekret/);
    expect(out).toContain('"api_key":"[redacted]"');
    expect(summarizeToolInputDetailed(nested).redacted).toBe(true);
    expect(
      summarizeToolInput({ command: 'curl -d \'{"password":"sekret-four"}\' https://example.invalid' }),
    ).not.toMatch(/sekret/);
  });

  it('a secret on the second line never reaches the summary', () => {
    expect(summarizeToolInput({ command: 'echo ok' + String.fromCharCode(10) + 'password=hunter2' })).toBe('echo ok');
  });

  it('clips to 160 code points after redaction, counting astral characters once', () => {
    const out = summarizeToolInput({ command: EMOJI.repeat(500) });
    expect(out).toBe(EMOJI.repeat(160) + ' ... [truncated 340 chars]');
    expect(Array.from(summarizeToolInput({ command: 'x '.repeat(200) })).length).toBeLessThanOrEqual(160 + 30);
  });

  it('handles a lone surrogate in the command', () => {
    expect(summarizeToolInput({ command: HIGH + 'ls' })).toBe(HIGH + 'ls');
  });

  it('summarizeToolInputDetailed also reports the redacted flag', () => {
    expect(summarizeToolInputDetailed({ command: 'echo password=hunter2' })).toEqual({
      text: 'echo password=[redacted]',
      redacted: true,
    });
    expect(summarizeToolInputDetailed({ command: 'npm test' })).toEqual({ text: 'npm test', redacted: false });
    expect(summarizeToolInputDetailed(null)).toEqual({ text: '', redacted: false });
    expect(summarizeToolInput({ command: 'echo password=hunter2' })).toBe('echo password=[redacted]');
  });
});

describe('canonicalJsonHash', () => {
  const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);

  it('is the first 32 hex characters of the sha256 of the key-sorted JSON', () => {
    expect(canonicalJsonHash({ b: 1, a: 2 })).toBe(sha('{"a":2,"b":1}'));
    expect(canonicalJsonHash([3, 1, 2])).toBe(sha('[3,1,2]'));
    expect(canonicalJsonHash('abc')).toBe(sha('"abc"'));
    expect(canonicalJsonHash(null)).toBe(sha('null'));
    expect(canonicalJsonHash(12.5)).toBe(sha('12.5'));
    expect(canonicalJsonHash(true)).toBe(sha('true'));
  });

  it('has a known value (sha256 of "abc" is ba7816bf...)', () => {
    // canonical JSON of the empty object is "{}"
    expect(canonicalJsonHash({})).toBe(sha('{}'));
    expect(canonicalJsonHash({})).toMatch(/^[0-9a-f]{32}$/);
    expect(createHash('sha256').update('abc').digest('hex').slice(0, 8)).toBe('ba7816bf');
  });

  it('ignores key order at every depth but keeps array order', () => {
    const a = { x: 1, y: { p: [1, { q: 1, r: 2 }], o: null }, z: 'k' };
    const b = { z: 'k', y: { o: null, p: [1, { r: 2, q: 1 }] }, x: 1 };
    expect(canonicalJsonHash(a)).toBe(canonicalJsonHash(b));
    expect(canonicalJsonHash([1, 2])).not.toBe(canonicalJsonHash([2, 1]));
  });

  it('sorts integer-like keys as strings (not numerically, as object property order would)', () => {
    expect(canonicalJsonHash({ 10: 'a', 2: 'b', b: 'c', 1: 'd' })).toBe(sha('{"1":"d","10":"a","2":"b","b":"c"}'));
  });

  it('distinguishes values that differ', () => {
    const hashes = new Set([
      canonicalJsonHash({ command: 'ls' }),
      canonicalJsonHash({ command: 'ls ' }),
      canonicalJsonHash({ command: 'LS' }),
      canonicalJsonHash({ cmd: 'ls' }),
      canonicalJsonHash({ command: ['ls'] }),
      canonicalJsonHash({ command: null }),
      canonicalJsonHash({}),
    ]);
    expect(hashes.size).toBe(7);
  });

  it('drops undefined object values and turns undefined array items into null, like JSON.stringify', () => {
    expect(canonicalJsonHash({ a: 1, b: undefined })).toBe(canonicalJsonHash({ a: 1 }));
    expect(canonicalJsonHash([undefined, 1])).toBe(sha('[null,1]'));
  });

  it('writes a non-finite number as null, like JSON.stringify', () => {
    expect(canonicalJsonHash(Number.NaN)).toBe(sha('null'));
    expect(canonicalJsonHash({ a: Number.POSITIVE_INFINITY })).toBe(sha('{"a":null}'));
  });

  it('hashes UTF-8 bytes: non-ASCII, astral characters and lone surrogates', () => {
    expect(canonicalJsonHash(E_ACUTE)).toBe(sha('"' + E_ACUTE + '"'));
    expect(canonicalJsonHash(EMOJI.repeat(100))).toBe(sha('"' + EMOJI.repeat(100) + '"'));
    expect(canonicalJsonHash({ [EMOJI]: E_ACUTE })).toBe(sha('{"' + EMOJI + '":"' + E_ACUTE + '"}'));
    // JSON.stringify writes a lone surrogate as an escape, so the hashed text is plain ASCII
    expect(canonicalJsonHash(HIGH)).toBe(sha(JSON.stringify(HIGH)));
    expect(canonicalJsonHash(LOW + HIGH)).toBe(sha(JSON.stringify(LOW + HIGH)));
  });

  it('is correct across every sha256 block boundary (lengths 0..300)', () => {
    for (let length = 0; length <= 300; length += 1) {
      const text = 'k'.repeat(length);
      expect(canonicalJsonHash(text), String(length)).toBe(sha('"' + text + '"'));
    }
  });

  it('is correct for a multi-megabyte value', () => {
    const big = { data: 'x'.repeat(3_000_000), more: [EMOJI.repeat(1000)] };
    expect(canonicalJsonHash(big)).toBe(
      sha('{"data":"' + 'x'.repeat(3_000_000) + '","more":["' + EMOJI.repeat(1000) + '"]}'),
    );
  });

  it('rejects a cycle instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => canonicalJsonHash(cyclic)).toThrow(TypeError);
  });

  it('hashes a repeated, non-cyclic object normally', () => {
    const shared = { x: 1 };
    expect(canonicalJsonHash([shared, shared])).toBe(sha('[{"x":1},{"x":1}]'));
  });

  it('PermissionRequest and PreToolUse of the same input correlate', () => {
    const fromPre = canonicalJsonHash({ command: 'npm test', description: 'run tests' });
    const fromPermission = canonicalJsonHash({ description: 'run tests', command: 'npm test' });
    expect(fromPre).toBe(fromPermission);
  });
});

describe('normalizePath', () => {
  it.each([
    [['C:', 'Users', 'me', 'file.jsonl'].join(BS), 'C:/Users/me/file.jsonl'],
    [['C:', 'Users', 'me', ''].join(BS), 'C:/Users/me'],
    ['C:/Users//me///x/', 'C:/Users/me/x'],
    ['/home/me/x/', '/home/me/x'],
    ['/home//me', '/home/me'],
    ['relative/dir/', 'relative/dir'],
    ['', ''],
    ['a', 'a'],
    ['a/', 'a'],
    ['a//b', 'a/b'],
    ['C:/Mixed' + BS + 'Sep/x', 'C:/Mixed/Sep/x'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it('keeps a leading double slash (UNC) and collapses everything after it', () => {
    expect(normalizePath(BS + BS + 'server' + BS + 'share' + BS + 'dir' + BS)).toBe('//server/share/dir');
    expect(normalizePath('//server//share///dir/')).toBe('//server/share/dir');
    expect(normalizePath('///x')).toBe('/x');
  });

  it('keeps the root of a drive and of the file system', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('//')).toBe('//');
    expect(normalizePath('C:/')).toBe('C:/');
    expect(normalizePath(['C:', ''].join(BS))).toBe('C:/');
  });

  it('keeps case and spaces', () => {
    expect(normalizePath('C:/Program Files/Node JS/')).toBe('C:/Program Files/Node JS');
  });

  it('is idempotent', () => {
    for (const input of ['C:' + BS + 'a' + BS + BS + 'b' + BS, '//s/h/', '/x//y/', 'a', '']) {
      const once = normalizePath(input);
      expect(normalizePath(once)).toBe(once);
    }
  });
});

describe('routeKey', () => {
  it('lowercases on win32 only', () => {
    expect(routeKey('C:' + BS + 'Users' + BS + 'Me' + BS + 'Proj' + BS, true)).toBe('c:/users/me/proj');
    expect(routeKey('/Home/Me/Proj/', false)).toBe('/Home/Me/Proj');
  });

  it('defaults to the host platform', () => {
    const expected = process.platform === 'win32' ? 'c:/users/me' : 'C:/Users/Me';
    expect(routeKey('C:/Users/Me')).toBe(expected);
  });

  it('treats drive letter case variants as one key on win32', () => {
    expect(routeKey('D:/mvp/x', true)).toBe(routeKey('d:' + BS + 'MVP' + BS + 'X' + BS, true));
  });
});

describe('sanitize.ts source constraints', () => {
  it('reads no node module and no global other than the guarded process.platform', () => {
    const text = readFileSync(new URL('./sanitize.ts', import.meta.url), 'utf8');
    expect(text).not.toMatch(/from\s+['"]node:/);
    expect(text).not.toMatch(/\bBuffer\b/);
    expect(text).not.toMatch(/\bTextEncoder\b/);
    expect(text).not.toMatch(/\bprocess\.(?!platform)/);
  });
});
