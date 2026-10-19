import { McsError } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { parseJson, type JsonDoc } from '../json/index.ts';
import { PYTHON_SYNTAX_HINT } from '../regex/index.ts';
import {
  LEGACY_KEYS,
  LegacyConfigFileSchema,
  compileConfigPatterns,
  validateLegacy,
  type LegacyValidateOptions,
} from './validate-legacy.ts';

function check(text: string, o: Partial<LegacyValidateOptions> = {}): string[] {
  return validateLegacy(parseJson(text), { strict: true, platform: 'linux', ...o });
}

/**
 * Documents with a non-finite float. A text cannot hold `NaN` or `Infinity` (`parseJson` refuses the tokens; a number
 * such as 1e999 overflows to infinity and is parsed), so these are built by hand: the validator stays defensive.
 */
function checkDoc(key: string, value: number): string[] {
  return validateLegacy({ k: 'obj', v: [[key, { k: 'float', v: value }]] }, { strict: true, platform: 'linux' });
}

function checkNested(key: string, inner: string, value: number): string[] {
  const doc: JsonDoc = { k: 'obj', v: [[key, { k: 'obj', v: [[inner, { k: 'float', v: value }]] }]] };
  return validateLegacy(doc, { strict: true, platform: 'linux' });
}

function failure(run: () => unknown): McsError {
  try {
    run();
  } catch (e) {
    if (e instanceof McsError) return e;
    throw e;
  }
  throw new Error('expected McsError');
}

interface Golden {
  readonly input: string;
  readonly strict: boolean;
  readonly problems: readonly string[];
}

// Captured once from the legacy engine: `backend.config.validate(json.loads(input), strict)` of
// src/backend/config.py, run with Python 3.14 against these inputs. The messages are the contract (01 2.4). The reasons
// inside an `invalid regex` message are the V8 reasons of the JavaScript dialect (ADR 0067); the rest of that line is legacy.
const GOLDEN: readonly Golden[] = [
  { input: '{"unknown_one": 1}', strict: true, problems: ["unknown key 'unknown_one'"] },
  { input: '{"unknown_one": 1}', strict: false, problems: [] },
  { input: '{"title": "  "}', strict: true, problems: ['title: expected non-empty string, got "  "'] },
  { input: '{"title": 5}', strict: true, problems: ['title: expected non-empty string, got 5'] },
  { input: '{"port": 0}', strict: true, problems: ['port: expected integer 1-65535, got 0'] },
  { input: '{"port": 65536}', strict: true, problems: ['port: expected integer 1-65535, got 65536'] },
  { input: '{"port": true}', strict: true, problems: ['port: expected integer 1-65535, got true'] },
  { input: '{"port": 8765.0}', strict: true, problems: ['port: expected integer 1-65535, got 8765.0'] },
  { input: '{"port": "8765"}', strict: true, problems: ['port: expected integer 1-65535, got "8765"'] },
  { input: '{"repo": 1}', strict: true, problems: ['repo: expected string path, got 1'] },
  { input: '{"transcripts_dir": 5}', strict: true, problems: ["transcripts_dir: expected 'auto' or a path, got 5"] },
  { input: '{"window_hours": 0}', strict: true, problems: ['window_hours: expected positive number, got 0'] },
  { input: '{"window_hours": -1.5}', strict: true, problems: ['window_hours: expected positive number, got -1.5'] },
  { input: '{"window_hours": "8"}', strict: true, problems: ['window_hours: expected positive number, got "8"'] },
  {
    input: '{"active_seconds": false}',
    strict: true,
    problems: ['active_seconds: expected positive number, got false'],
  },
  {
    input: '{"pending_tool_grace_seconds": null}',
    strict: true,
    problems: ['pending_tool_grace_seconds: expected positive number, got null'],
  },
  { input: '{"include_unmatched": 1}', strict: true, problems: ['include_unmatched: expected boolean, got 1'] },
  { input: '{"docker": "yes"}', strict: true, problems: ['docker: expected boolean, got "yes"'] },
  {
    input: '{"session_rules": [{"label": "x"}]}',
    strict: true,
    problems: ['session_rules: expected list of {match, label, scope?}, got [{"label": "x"}]'],
  },
  {
    input: '{"session_ids": [1, 2]}',
    strict: true,
    problems: ['session_ids: expected list of session id strings, got [1, 2]'],
  },
  { input: '{"live_log_globs": "a"}', strict: true, problems: ['live_log_globs: expected list of strings, got "a"'] },
  {
    input: '{"watched_processes": [null]}',
    strict: true,
    problems: ['watched_processes: expected list of strings, got [null]'],
  },
  { input: '{"panels": {"git": 1}}', strict: true, problems: ['panels: expected object of booleans, got {"git": 1}'] },
  { input: '{"panels": []}', strict: true, problems: ['panels: expected object of booleans, got []'] },
  { input: '{"chain_log": 3}', strict: true, problems: ['chain_log: expected string or null, got 3'] },
  { input: '{"ledger": []}', strict: true, problems: ['ledger: expected string or null, got []'] },
  { input: '{"stop_file": {}}', strict: true, problems: ['stop_file: expected string or null, got {}'] },
  {
    input: '{"attempts": {"start": "a"}}',
    strict: true,
    problems: ['attempts: expected null or {start, end, ...}, got {"start": "a"}'],
  },
  { input: '{"attempts": "x"}', strict: true, problems: ['attempts: expected null or {start, end, ...}, got "x"'] },
  {
    input: '{"ui": {"theme": "pink"}}',
    strict: true,
    problems: [
      'ui: expected object: theme auto|light|dark, density comfortable|compact, booleans, got {"theme": "pink"}',
    ],
  },
  {
    input: '{"ui": {"density": "tiny"}}',
    strict: true,
    problems: [
      'ui: expected object: theme auto|light|dark, density comfortable|compact, booleans, got {"density": "tiny"}',
    ],
  },
  {
    input: '{"ui": {"newest_first": "yes"}}',
    strict: true,
    problems: [
      'ui: expected object: theme auto|light|dark, density comfortable|compact, booleans, got {"newest_first": "yes"}',
    ],
  },
  { input: '{"ui": {"theme": "dark", "density": "compact", "extra": true}}', strict: true, problems: [] },
  {
    input: '{"poll": {"events_ms": "fast"}}',
    strict: true,
    problems: ['poll: expected object of numbers (milliseconds), got {"events_ms": "fast"}'],
  },
  {
    input: '{"limits": {"max_events": true}}',
    strict: true,
    problems: ['limits: expected object of numbers, got {"max_events": true}'],
  },
  { input: '{"limits": [1]}', strict: true, problems: ['limits: expected object of numbers, got [1]'] },
  { input: '{"schema_version": "1"}', strict: true, problems: ['schema_version: expected integer, got "1"'] },
  { input: '{"schema_version": 1.5}', strict: true, problems: ['schema_version: expected integer, got 1.5'] },
  {
    input:
      '{"title": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "port": "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"}',
    strict: true,
    problems: ['port: expected integer 1-65535, got "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'],
  },
  {
    input: '{"port": "caf\u00e9 \ud83d\ude00"}',
    strict: true,
    problems: ['port: expected integer 1-65535, got "caf\\u00e9 \\ud83d\\ude00"'],
  },
  {
    input: '{"zz": 1, "port": 0, "aa": 2, "title": 3}',
    strict: true,
    problems: [
      "unknown key 'zz'",
      'port: expected integer 1-65535, got 0',
      "unknown key 'aa'",
      'title: expected non-empty string, got 3',
    ],
  },
  { input: '{"_comment": 5, "title": "ok"}', strict: true, problems: [] },
  {
    input: '{"session_rules": [{"match": "("}]}',
    strict: true,
    problems: ["session_rules: invalid regex '(' (Unterminated group)"],
  },
  {
    input: '{"session_rules": [{"match": "ok"}, {"match": "[a-"}]}',
    strict: true,
    problems: ["session_rules: invalid regex '[a-' (Unterminated character class)"],
  },
  {
    input: '{"attempts": {"start": "(", "end": "a**"}}',
    strict: true,
    problems: ['attempts.start: invalid regex (Unterminated group)', 'attempts.end: invalid regex (Nothing to repeat)'],
  },
  { input: '{"attempts": {"start": "a", "end": "b"}}', strict: true, problems: [] },
  {
    input: '{"port": 0, "session_rules": [{"match": "("}], "attempts": {"start": ")", "end": "x"}}',
    strict: true,
    problems: [
      'port: expected integer 1-65535, got 0',
      "session_rules: invalid regex '(' (Unterminated group)",
      "attempts.start: invalid regex (Unmatched ')')",
    ],
  },
  { input: '[1]', strict: true, problems: ['config must be a JSON object'] },
  { input: '"s"', strict: true, problems: ['config must be a JSON object'] },
  { input: 'null', strict: true, problems: ['config must be a JSON object'] },
];

describe('legacy validation messages (goldens captured from the legacy engine)', () => {
  for (const g of GOLDEN) {
    it(`${g.strict ? 'strict' : 'lenient'}: ${g.input.slice(0, 70)}`, () => {
      expect(check(g.input, { strict: g.strict })).toEqual(g.problems);
    });
  }

  it('covers every key of the legacy SCHEMA at least once', () => {
    const text = GOLDEN.map((g) => g.problems.join('\n')).join('\n');
    for (const key of LEGACY_KEYS) {
      if (key === 'schema_version') continue;
      expect(text, key).toContain(`${key}:`);
    }
  });
});

describe('LegacyConfigFileSchema (the predicate table of config.py)', () => {
  it('has the 22 L keys in the legacy order', () => {
    expect(LEGACY_KEYS).toEqual([
      'schema_version',
      'title',
      'port',
      'repo',
      'transcripts_dir',
      'window_hours',
      'active_seconds',
      'pending_tool_grace_seconds',
      'include_unmatched',
      'session_rules',
      'session_ids',
      'panels',
      'live_log_globs',
      'chain_log',
      'ledger',
      'stop_file',
      'attempts',
      'watched_processes',
      'docker',
      'ui',
      'poll',
      'limits',
    ]);
    expect(Object.keys(LegacyConfigFileSchema)).toEqual([...LEGACY_KEYS]);
  });

  it('carries the expected text of each key', () => {
    expect(LegacyConfigFileSchema['port']?.expected).toBe('integer 1-65535');
    expect(LegacyConfigFileSchema['attempts']?.expected).toBe('null or {start, end, ...}');
  });
});

describe('legacy behaviours that need a decision', () => {
  it('accepts a full valid config and a partial one', () => {
    expect(check('{"schema_version": 1, "title": "t", "port": 9000, "window_hours": 8.5}')).toEqual([]);
    expect(check('{}')).toEqual([]);
  });

  it('keeps the file order of keys, not the schema order, and reports unknown keys in place', () => {
    expect(check('{"zz": 1, "port": 0, "aa": 2}')).toEqual([
      "unknown key 'zz'",
      'port: expected integer 1-65535, got 0',
      "unknown key 'aa'",
    ]);
  });

  it('reports a Python repr for an unknown key with a quote or non-ASCII character', () => {
    expect(check('{"it\'s": 1}')).toEqual(['unknown key "it\'s"']);
    expect(check('{"caf\\u00e9": 1}')).toEqual(["unknown key 'caf\u00e9'"]);
  });

  it('accepts a lenient (flat legacy) file with unknown keys, strict mode does not', () => {
    expect(check('{"anything": 1}', { strict: false })).toEqual([]);
    expect(check('{"anything": 1}')).toEqual(["unknown key 'anything'"]);
  });

  it('reports a whole-file problem for a non-object', () => {
    for (const text of ['[1]', '"s"', 'null', '5']) expect(check(text), text).toEqual(['config must be a JSON object']);
  });

  it('keeps bool out of numbers: true is not a number, 1.0 is not an integer', () => {
    expect(check('{"window_hours": true}')).toEqual(['window_hours: expected positive number, got true']);
    expect(check('{"port": 1.0}')).toEqual(['port: expected integer 1-65535, got 1.0']);
    expect(check('{"window_hours": 8.0}')).toEqual([]);
  });

  it('cuts the echoed value at 60 characters of the ASCII JSON text', () => {
    const [problem] = check(`{"port": "${'y'.repeat(80)}"}`);
    expect(problem).toBe(`port: expected integer 1-65535, got "${'y'.repeat(59)}`);
  });

  it('treats a whitespace-only title as empty with the Python whitespace set', () => {
    expect(check('{"title": "\\u00a0\\u3000 \\t"}')).toEqual([
      'title: expected non-empty string, got "\\u00a0\\u3000 \\t"',
    ]);
    expect(check('{"title": "\\ufeff"}')).toEqual([]);
  });

  it('does not report regex problems for a session_rules value of the wrong type (legacy emitted one per character)', () => {
    expect(check('{"session_rules": "abc"}')).toEqual([
      'session_rules: expected list of {match, label, scope?}, got "abc"',
    ]);
  });

  it('reports a pattern that is not JavaScript as a validation problem, with the migration hint for Python syntax', () => {
    expect(
      check('{"session_rules": [{"match": "(?P<n>a)"}], "attempts": {"start": "a*+", "end": "(?#note)b"}}'),
    ).toEqual([
      `session_rules: invalid regex '(?P<n>a)' (Invalid group; ${PYTHON_SYNTAX_HINT})`,
      'attempts.start: invalid regex (Nothing to repeat)',
      `attempts.end: invalid regex (Invalid group; ${PYTHON_SYNTAX_HINT})`,
    ]);
    expect(PYTHON_SYNTAX_HINT).toBe(
      'this looks like Python regex syntax; run `mcs migrate-workspace --task <slug>` (dry run first)',
    );
  });

  it('refuses an inline modifier group and a pattern V8 cannot compile at validation time', () => {
    const huge = `(${'a?'.repeat(20000)})`;
    const problems = check(
      JSON.stringify({ session_rules: [{ match: '(?i:a)' }], attempts: { start: huge, end: 'b' } }),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("session_rules: invalid regex '(?i:a)' (inline modifier groups");
    expect(problems[1]?.startsWith('attempts.start: invalid regex (')).toBe(true);
    expect(problems[1]).not.toContain('a?a?');
  });

  it('accepts JavaScript patterns that the old Python dialect could not express', () => {
    expect(
      check('{"session_rules": [{"match": "(?<n>a)(?<m>b)?"}], "attempts": {"start": "(?<=x)a", "end": "b"}}'),
    ).toEqual([]);
  });
});

describe('Node-only additions (01 2.4; stricter than legacy, all CONFIG_INVALID problems)', () => {
  it('rejects non-finite numbers', () => {
    expect(check('{"window_hours": 1e999}')).toEqual(['window_hours: expected finite number']);
    expect(checkDoc('active_seconds', Number.POSITIVE_INFINITY)).toEqual(['active_seconds: expected finite number']);
    expect(check('{"poll": {"events_ms": 1e999}}')).toEqual(['poll.events_ms: expected finite number']);
    expect(checkNested('limits', 'max_events', Number.NaN)).toEqual(['limits.max_events: expected finite number']);
  });

  it('keeps the legacy message when the legacy predicate already fails (NaN is not positive)', () => {
    expect(checkDoc('window_hours', Number.NaN)).toEqual(['window_hours: expected positive number, got NaN']);
    expect(checkDoc('window_hours', Number.NEGATIVE_INFINITY)).toEqual([
      'window_hours: expected positive number, got -Infinity',
    ]);
  });

  it('rejects integers beyond 2^53-1 in numeric keys, and accepts the largest safe integer', () => {
    expect(check('{"window_hours": 9007199254740993}')).toEqual([
      'window_hours: expected integer within 2^53-1, got 9007199254740993',
    ]);
    expect(check('{"limits": {"max_events": 9007199254740993}}')).toEqual([
      'limits.max_events: expected integer within 2^53-1, got 9007199254740993',
    ]);
    expect(check('{"window_hours": 9007199254740991}')).toEqual([]);
    expect(check('{"limits": {"max_events": -9007199254740992}}')).toEqual([
      'limits.max_events: expected integer within 2^53-1, got -9007199254740992',
    ]);
  });

  it('requires a session rule label that is present to be a string', () => {
    expect(check('{"session_rules": [{"match": "a", "label": "x"}, {"match": "b", "label": 5}]}')).toEqual([
      'session_rules[1].label: expected string',
    ]);
    expect(check('{"session_rules": [{"match": "a", "label": null}]}')).toEqual([
      'session_rules[0].label: expected string',
    ]);
  });

  it('checks attempts.time_format with validateTimeFormat and reports its message', () => {
    expect(check('{"attempts": {"start": "a", "end": "b", "time_format": "%Y-%m-%d %H:%M:%S"}}')).toEqual([]);
    expect(check('{"attempts": {"start": "a", "end": "b", "time_format": "%Y %X"}}')).toEqual([
      'attempts.time_format: unsupported directive %X (supported: %Y %m %d %H %M %S %f %y %b %B %a %A %I %p %j %z %Z %%)',
    ]);
  });

  it('refuses %j with a month or day directive, a long format and too many directives in time_format', () => {
    expect(check('{"attempts": {"start": "a", "end": "b", "time_format": "%Y %j %H:%M:%S"}}')).toEqual([]);
    expect(check('{"attempts": {"start": "a", "end": "b", "time_format": "%Y %m %j"}}')).toEqual([
      'attempts.time_format: %j cannot be combined with %m, %d, %b or %B',
    ]);
    expect(check(JSON.stringify({ attempts: { start: 'a', end: 'b', time_format: 'x'.repeat(201) } }))).toEqual([
      'attempts.time_format: longer than 200 characters',
    ]);
    expect(check(JSON.stringify({ attempts: { start: 'a', end: 'b', time_format: '%d'.repeat(17) } }))).toEqual([
      'attempts.time_format: more than 16 directives',
    ]);
  });

  it('requires attempts.time_format and attempts.label_prefix to be strings when present', () => {
    expect(check('{"attempts": {"start": "a", "end": "b", "time_format": 5, "label_prefix": null}}')).toEqual([
      'attempts.time_format: expected string',
      'attempts.label_prefix: expected string',
    ]);
  });

  it('rejects a /c/... path on win32 for every path key, and accepts it elsewhere', () => {
    const doc =
      '{"repo": "/c/Users/x", "transcripts_dir": "/d/t", "chain_log": "/c/l.log", "ledger": "/e", ' +
      '"stop_file": "/c/stop", "live_log_globs": ["ok/*.log", "/c/logs/*.log"]}';
    expect(check(doc, { platform: 'win32' })).toEqual([
      'repo: use C:/... instead of /c/...',
      'transcripts_dir: use C:/... instead of /c/...',
      'chain_log: use C:/... instead of /c/...',
      'ledger: use C:/... instead of /c/...',
      'stop_file: use C:/... instead of /c/...',
      'live_log_globs[1]: use C:/... instead of /c/...',
    ]);
    expect(check(doc, { platform: 'linux' })).toEqual([]);
  });

  it('leaves auto, drive paths, relative paths and a null value alone on win32', () => {
    const doc =
      '{"repo": "C:/work", "transcripts_dir": "auto", "chain_log": null, "ledger": "rel/path", "stop_file": "//server/share", "live_log_globs": ["C:/x/*.log"]}';
    expect(check(doc, { platform: 'win32' })).toEqual([]);
  });

  it('puts the additions after the key problem, before the regex problems, in key order', () => {
    expect(
      check(
        '{"repo": "/c/x", "window_hours": 1e999, "session_rules": [{"match": "("}], "attempts": {"start": "a", "end": "b", "time_format": "%X"}}',
        { platform: 'win32' },
      ),
    ).toEqual([
      'repo: use C:/... instead of /c/...',
      'window_hours: expected finite number',
      'attempts.time_format: unsupported directive %X (supported: %Y %m %d %H %M %S %f %y %b %B %a %A %I %p %j %z %Z %%)',
      "session_rules: invalid regex '(' (Unterminated group)",
    ]);
  });
});

describe('compileConfigPatterns (step 7 of resolveConfig)', () => {
  it('compiles every session rule and both attempts patterns', () => {
    const out = compileConfigPatterns({
      session_rules: [{ match: 'abc(?<n>\\d+)' }, { match: 'x' }],
      attempts: { start: '^start (?<id>\\w+)', end: '^end' },
    });
    expect(out.sessionRules).toHaveLength(2);
    expect(out.sessionRules[0]?.exec('zzabc42')?.groupdict()).toEqual({ n: '42' });
    expect(out.attempts?.start.exec('start a1')?.groupdict()).toEqual({ id: 'a1' });
    expect(out.attempts?.end.exec('end')).not.toBeNull();
  });

  it('has no attempts patterns when attempts is null', () => {
    expect(compileConfigPatterns({ session_rules: [], attempts: null })).toEqual({ sessionRules: [], attempts: null });
  });

  it('lists every failing pattern by position as CONFIG_INVALID and never repeats a pattern text', () => {
    const e = failure(() =>
      compileConfigPatterns({
        session_rules: [{ match: 'fine' }, { match: '(?P<secret>rule)' }, { match: 'a*+' }],
        attempts: { start: 'ok', end: '(?>secret-end)' },
      }),
    );
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toContain(`session_rules[1]: invalid regex (Invalid group; ${PYTHON_SYNTAX_HINT})`);
    expect(e.hint).toBe('Run `mcs migrate-workspace --task <slug>` (dry run first) to convert Python regex syntax.');
    expect(e.message).toContain('session_rules[1]: ');
    expect(e.message).toContain('session_rules[2]: ');
    expect(e.message).toContain('attempts.end: ');
    expect(e.message).not.toContain('session_rules[0]');
    expect(e.message).not.toContain('attempts.start');
    expect(e.message).not.toContain('secret');
    expect(JSON.stringify(e.details)).not.toContain('secret');
    expect(e.details?.['patterns']).toHaveLength(3);
  });

  it('points a pattern that is only a JavaScript error at the key reference of the skill folder', () => {
    const e = failure(() => compileConfigPatterns({ session_rules: [{ match: 'a*+' }], attempts: null }));
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.hint).toBe(
      'Write the pattern as a JavaScript regular expression (v flag rules; see reference/configuration.md in the skill folder).',
    );
    expect(e.details?.['patterns']).toEqual([{ where: 'session_rules[0]', pythonSyntax: false }]);
  });
});
