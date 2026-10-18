import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AGENT_RE,
  ENVELOPE_FLAG_RE,
  ENVELOPE_MAX_BYTES,
  EVENT_NAME_RE,
  HANDLER_HARD_EXIT_MS,
  HANDLER_VERSION,
  HOOK_ENVELOPE_VERSION,
  ID_MAX_CHARS,
  MINIMAL_CALLS_MAX,
  MINIMAL_DATA_KEYS,
  NAME_MAX_CHARS,
  NUDGE_TIMEOUT_MS,
  PATH_MAX_CHARS,
  PROBE_NOTIFICATION_TYPE,
  PROBE_SESSION_PREFIX,
  ROUTES_MAX_FILES,
  ROUTE_FILE_MAX_BYTES,
  RUN_ID_RE,
  SID_RE,
  SPOOL_SEGMENT_EXT,
  SPOOL_SEGMENT_HARD_CAP,
  SPOOL_SEGMENT_RE,
  SPOOL_SEGMENT_SOFT_CAP,
  STDIN_MAX_BYTES,
  SUMMARY_MAX_CP,
  TITLE_MAX_CP,
  TOOL_ID_RE,
  spoolSegmentName,
  type EnvelopeKind,
  type HookEnvelopeV1,
} from './hook-envelope.ts';

const PROTOCOL_DIR = new URL('./', import.meta.url);
const RUNTIME_PACKAGE_JSON = new URL('../../../../package.json', import.meta.url);

describe('constants of 98 10.1', () => {
  it('equal the registry values and units', () => {
    expect(HOOK_ENVELOPE_VERSION).toBe(1);
    expect(HANDLER_HARD_EXIT_MS).toBe(1200);
    expect(STDIN_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(ENVELOPE_MAX_BYTES).toBe(16 * 1024);
    expect(SPOOL_SEGMENT_SOFT_CAP).toBe(64 * 1024 * 1024);
    expect(SPOOL_SEGMENT_HARD_CAP).toBe(256 * 1024 * 1024);
    expect(NUDGE_TIMEOUT_MS).toBe(300);
    expect(SUMMARY_MAX_CP).toBe(160);
    expect(TITLE_MAX_CP).toBe(80);
    expect(PATH_MAX_CHARS).toBe(1024);
    expect(ID_MAX_CHARS).toBe(128);
    expect(NAME_MAX_CHARS).toBe(64);
    expect(ROUTES_MAX_FILES).toBe(64);
    expect(ROUTE_FILE_MAX_BYTES).toBe(16 * 1024);
    expect(MINIMAL_CALLS_MAX).toBe(16);
  });

  it('keeps the soft cap below the hard cap and the envelope below the soft cap', () => {
    expect(ENVELOPE_MAX_BYTES).toBeLessThan(SPOOL_SEGMENT_SOFT_CAP);
    expect(SPOOL_SEGMENT_SOFT_CAP).toBeLessThan(SPOOL_SEGMENT_HARD_CAP);
    expect(HANDLER_HARD_EXIT_MS).toBeGreaterThan(NUDGE_TIMEOUT_MS);
  });

  it('HANDLER_VERSION equals the runtime package version (98 1.7, N2)', () => {
    const pkg: unknown = JSON.parse(readFileSync(RUNTIME_PACKAGE_JSON, 'utf8'));
    expect(pkg).toMatchObject({ version: HANDLER_VERSION });
    expect(HANDLER_VERSION).toBe('4.0.0');
  });

  it('minimal envelope keeps the closed key list of 02 2.3.4', () => {
    expect([...MINIMAL_DATA_KEYS]).toEqual([
      'tool_name',
      'source',
      'reason',
      'notification_type',
      'trigger',
      'error',
      'exit_code',
      'calls',
    ]);
  });

  it('probe markers are the ones of 98 11.5', () => {
    expect(PROBE_SESSION_PREFIX).toBe('00000000-0000-4000-8000-');
    expect(PROBE_NOTIFICATION_TYPE).toBe('mcs_probe');
    expect(SID_RE.test(PROBE_SESSION_PREFIX + '000000000000')).toBe(true);
  });
});

describe('spool segment names (T-HK-16, unit part, I-02)', () => {
  it('uses the .ndjson extension and never .jsonl', () => {
    expect(SPOOL_SEGMENT_EXT).toBe('.ndjson');
    expect(SPOOL_SEGMENT_RE.source).toContain('ndjson');
    expect(SPOOL_SEGMENT_RE.source).not.toContain('jsonl');
  });

  it('spoolSegmentName(Date.UTC(2026, 9, 11, 14, 5)) is hooks-20261011T14Z.ndjson', () => {
    expect(spoolSegmentName(Date.UTC(2026, 9, 11, 14, 5))).toBe('hooks-20261011T14Z.ndjson');
  });

  it.each([
    ['hour 0', Date.UTC(2026, 9, 11, 0, 0, 0, 0), 'hooks-20261011T00Z.ndjson'],
    ['hour 23, last millisecond', Date.UTC(2026, 9, 11, 23, 59, 59, 999), 'hooks-20261011T23Z.ndjson'],
    ['new year, first millisecond', Date.UTC(2027, 0, 1, 0, 0, 0, 0), 'hooks-20270101T00Z.ndjson'],
    ['new year eve, last millisecond', Date.UTC(2026, 11, 31, 23, 59, 59, 999), 'hooks-20261231T23Z.ndjson'],
    ['leap day', Date.UTC(2028, 1, 29, 12, 0), 'hooks-20280229T12Z.ndjson'],
    ['single digit month and day', Date.UTC(2026, 0, 2, 3, 0), 'hooks-20260102T03Z.ndjson'],
    ['epoch', 0, 'hooks-19700101T00Z.ndjson'],
  ])('%s', (_label, at, expected) => {
    const name = spoolSegmentName(at);
    expect(name).toBe(expected);
    expect(SPOOL_SEGMENT_RE.test(name)).toBe(true);
    expect(name.endsWith('.jsonl')).toBe(false);
  });

  it('is independent of the process time zone (always UTC)', () => {
    // 2026-10-11T23:30:00Z is already the next day in UTC+2 and still the same day in UTC-5
    expect(spoolSegmentName(Date.UTC(2026, 9, 11, 23, 30))).toBe('hooks-20261011T23Z.ndjson');
  });

  it('gives every instant of one UTC hour the same name, and the next hour a different one', () => {
    const base = Date.UTC(2026, 9, 11, 14, 0, 0, 0);
    expect(spoolSegmentName(base)).toBe(spoolSegmentName(base + 3_599_999));
    expect(spoolSegmentName(base)).not.toBe(spoolSegmentName(base + 3_600_000));
  });

  it('SPOOL_SEGMENT_RE captures the date and the hour and rejects every other name', () => {
    const match = SPOOL_SEGMENT_RE.exec('hooks-20261011T14Z.ndjson');
    expect(match?.[1]).toBe('20261011');
    expect(match?.[2]).toBe('14');
    const rejected = [
      'hooks-20261011T14Z.jsonl',
      'hooks-20261011T14Z.ndjson.tmp',
      'hooks-20261011T14Z.ndjson\n',
      ' hooks-20261011T14Z.ndjson',
      'hooks-20261011t14z.ndjson',
      'hooks-2026101T14Z.ndjson',
      'hooks-202610111T14Z.ndjson',
      'hooks-20261011T4Z.ndjson',
      'hooks-20261011T144Z.ndjson',
      'hooks-20261011T14Z.NDJSON',
      'data/spool/hooks-20261011T14Z.ndjson',
      'hooks-20261011T14.ndjson',
      'hook-20261011T14Z.ndjson',
      '',
    ];
    for (const name of rejected) {
      expect(SPOOL_SEGMENT_RE.test(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('rejects a time it cannot name instead of producing a name the regex refuses', () => {
    expect(() => spoolSegmentName(Number.NaN)).toThrow(RangeError);
    expect(() => spoolSegmentName(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => spoolSegmentName(Date.UTC(10000, 0, 1))).toThrow(RangeError);
    expect(() => spoolSegmentName(Date.UTC(-1, 0, 1))).toThrow(RangeError);
    expect(() => spoolSegmentName(8.64e15 + 1)).toThrow(RangeError);
  });

  it('every name for a sample of random instants matches the regex', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let i = 0; i < 500; i += 1) {
      const at = Date.UTC(2000, 0, 1) + (next() % 1_000_000) * 100_000;
      expect(SPOOL_SEGMENT_RE.test(spoolSegmentName(at))).toBe(true);
    }
  });
});

describe('id regex tables (02 2.3.2, I-26)', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';

  it.each([
    [uuid, true],
    ['abcdef01-2345-6789-abcd-ef0123456789', true],
    ['00000000-0000-4000-8000-000000000000', true],
    ['ABCDEF01-2345-6789-ABCD-EF0123456789', false],
    ['11111111222243338444555555555555', false],
    ['11111111-2222-4333-8444-55555555555', false],
    ['11111111-2222-4333-8444-5555555555555', false],
    ['11111111-2222-4333-8444-55555555555g', false],
    [uuid + '\n', false],
    [' ' + uuid, false],
    ['', false],
    ['../' + uuid, false],
  ])('SID_RE %j -> %s', (value, ok) => {
    expect(SID_RE.test(value)).toBe(ok);
  });

  it.each([
    ['abc', true],
    ['a_B-9', true],
    ['a'.repeat(64), true],
    ['ab', false],
    ['a'.repeat(65), false],
    ['', false],
    ['a b c', false],
    ['abc/def', false],
    ['abc.def', false],
    ['..', false],
    ['abc\n', false],
  ])('AGENT_RE %j -> %s', (value, ok) => {
    expect(AGENT_RE.test(value)).toBe(ok);
  });

  it.each([
    ['toolu_PLACEHOLDER', true],
    ['a', true],
    ['A-b_9', true],
    ['x'.repeat(128), true],
    ['x'.repeat(129), false],
    ['', false],
    ['tool use', false],
    ['tool/use', false],
    ['tool.use', false],
    ['toolu_01\n', false],
  ])('TOOL_ID_RE %j -> %s', (value, ok) => {
    expect(TOOL_ID_RE.test(value)).toBe(ok);
  });

  it.each([
    ['wf_abc', true],
    ['wf_a', true],
    ['wf_' + 'a'.repeat(64), true],
    ['wf_' + 'a'.repeat(65), false],
    ['wf_', false],
    ['wf-abc', false],
    ['WF_abc', false],
    ['wf_a b', false],
    ['wf_a.b', false],
    ['xwf_abc', false],
    ['wf_abc\n', false],
  ])('RUN_ID_RE %j -> %s', (value, ok) => {
    expect(RUN_ID_RE.test(value)).toBe(ok);
  });

  it('RUN_ID_RE is the pattern of 02 2.3.2 (I-26)', () => {
    expect(RUN_ID_RE.source).toBe(/^wf_[A-Za-z0-9_-]{1,64}$/.source);
    expect(RUN_ID_RE.flags).toBe('');
  });

  it('no id regex is global or sticky (a shared regex with lastIndex state would be a bug)', () => {
    for (const re of [SID_RE, AGENT_RE, TOOL_ID_RE, RUN_ID_RE, SPOOL_SEGMENT_RE, EVENT_NAME_RE, ENVELOPE_FLAG_RE]) {
      expect(re.global, String(re)).toBe(false);
      expect(re.sticky, String(re)).toBe(false);
    }
  });

  it('EVENT_NAME_RE accepts only 1-64 ASCII letters', () => {
    expect(EVENT_NAME_RE.test('PreToolUse')).toBe(true);
    expect(EVENT_NAME_RE.test('A'.repeat(64))).toBe(true);
    expect(EVENT_NAME_RE.test('A'.repeat(65))).toBe(false);
    expect(EVENT_NAME_RE.test('')).toBe(false);
    expect(EVENT_NAME_RE.test('Pre Tool')).toBe(false);
    expect(EVENT_NAME_RE.test('Pre1')).toBe(false);
  });
});

describe('envelope flags (02 2.3.3, closed set)', () => {
  it.each([
    'stdin_truncated',
    'event_mismatch',
    'minimal',
    'redacted',
    'routed_by_cwd',
    'routed_by_session_pin',
    'invalid_session_id',
    'invalid_transcript_path',
    'invalid_agent_id',
    'data_truncated:calls',
  ])('accepts %s', (flag) => {
    expect(ENVELOPE_FLAG_RE.test(flag)).toBe(true);
  });

  it.each([
    'unknown_flag',
    'Minimal',
    'invalid_',
    'invalid_Session',
    'data_truncated:',
    'data_truncated:a b',
    'redacted ',
    'redacted\n',
    '',
    'invalid_' + 'a'.repeat(49),
  ])('rejects %j', (flag) => {
    expect(ENVELOPE_FLAG_RE.test(flag)).toBe(false);
  });
});

describe('HookEnvelopeV1 type', () => {
  it('has the field set of 02 2.3.1 (compile-time check, no hook_event_name key)', () => {
    expectTypeOf<HookEnvelopeV1['v']>().toEqualTypeOf<1>();
    expectTypeOf<HookEnvelopeV1['kind']>().toEqualTypeOf<EnvelopeKind>();
    expectTypeOf<EnvelopeKind>().toEqualTypeOf<'hook' | 'probe'>();
    expectTypeOf<HookEnvelopeV1['event']>().toEqualTypeOf<string>();
    expectTypeOf<HookEnvelopeV1['session_id']>().toEqualTypeOf<string | null>();
    expectTypeOf<HookEnvelopeV1['claude_pid']>().toEqualTypeOf<number | null>();
    expectTypeOf<HookEnvelopeV1['handler']>().toEqualTypeOf<{ version: string; pid: number; async: boolean }>();
    expectTypeOf<HookEnvelopeV1['flags']>().toEqualTypeOf<string[]>();
    expectTypeOf<keyof HookEnvelopeV1>().toEqualTypeOf<
      | 'v'
      | 'kind'
      | 'instance_id'
      | 'event_uid'
      | 'received_at'
      | 'event'
      | 'argv_event'
      | 'session_id'
      | 'transcript_path'
      | 'cwd'
      | 'prompt_id'
      | 'agent_id'
      | 'agent_type'
      | 'tool_use_id'
      | 'permission_mode'
      | 'claude_pid'
      | 'payload_bytes'
      | 'content_hash'
      | 'handler'
      | 'flags'
      | 'data'
    >();
  });
});

describe('protocol sources are dependency free (lint rule restated as a test)', () => {
  const sources = readdirSync(PROTOCOL_DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

  it('finds the protocol modules of this work package', () => {
    for (const name of ['hook-envelope.ts', 'hook-events.ts', 'sanitize.ts', 'routes.ts', 'stamp.ts', 'limits.ts']) {
      expect(sources).toContain(name);
    }
  });

  it.each(sources)('%s imports only ./ files and no node: module', (name) => {
    const text = readFileSync(new URL(name, PROTOCOL_DIR), 'utf8');
    const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    for (const specifier of specifiers) {
      expect(specifier, `${name} imports ${String(specifier)}`).toMatch(/^\.\//);
    }
    expect(text).not.toMatch(/\bfrom\s+['"](?:node:|@mcs\/|zod)/);
    expect(text).not.toMatch(/\brequire\s*\(/);
    expect(text).not.toMatch(/\bimport\s*\(/);
  });
});
