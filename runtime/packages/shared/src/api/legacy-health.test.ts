import { describe, expect, it } from 'vitest';

import { LEGACY_HEALTH_KEYS, LegacyHealthSchema } from './legacy-health.ts';

/** A copy of `value` without the key `omit` (the tests need an object with a missing field). */
function without(value: object, omit: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omit));
}

const sample = {
  ok: true,
  version: '3.0.0',
  pid: 4242,
  started: 1_780_000_000.5,
  uptime: 12.3,
  now: 1_780_000_012.8,
  code_stamp: 'abc123',
  engine: 'node',
  instanceId: '3f2b8c1e-0d4a-4b7e-9c11-5a6d7e8f9a0b',
  task: { id: 'demo', name: 'Demo', description: '' },
  config_source: 'task',
  errors: [],
  reader: {},
};

describe('LegacyHealth (03 6.2, I-30)', () => {
  it('has exactly the 13 documented keys', () => {
    expect([...LEGACY_HEALTH_KEYS].sort()).toEqual(
      [
        'ok',
        'version',
        'pid',
        'started',
        'uptime',
        'now',
        'code_stamp',
        'engine',
        'instanceId',
        'task',
        'config_source',
        'errors',
        'reader',
      ].sort(),
    );
    expect(LEGACY_HEALTH_KEYS).toHaveLength(13);
    expect(Object.keys(sample).sort()).toEqual([...LEGACY_HEALTH_KEYS].sort());
  });

  it('parses the sample and a null task, and is strict', () => {
    expect(LegacyHealthSchema.parse(sample)).toEqual(sample);
    expect(LegacyHealthSchema.safeParse({ ...sample, task: null }).success).toBe(true);
    expect(LegacyHealthSchema.safeParse({ ...sample, transcripts_dir: 'x' }).success).toBe(false);
    for (const key of LEGACY_HEALTH_KEYS) {
      expect(LegacyHealthSchema.safeParse(without(sample, key)).success, `without ${key}`).toBe(false);
    }
  });

  it('pins the constants: ok true, engine node, config_source task, errors empty, reader empty', () => {
    expect(LegacyHealthSchema.safeParse({ ...sample, ok: false }).success).toBe(false);
    expect(LegacyHealthSchema.safeParse({ ...sample, engine: 'legacy' }).success).toBe(false);
    expect(LegacyHealthSchema.safeParse({ ...sample, config_source: 'file' }).success).toBe(false);
    expect(LegacyHealthSchema.safeParse({ ...sample, errors: ['x'] }).success).toBe(false);
    expect(LegacyHealthSchema.safeParse({ ...sample, reader: { a: 1 } }).success).toBe(false);
  });
});
