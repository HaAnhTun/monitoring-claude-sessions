import { describe, expect, it } from 'vitest';

import { ENV_PREFIX, LEGACY_ENV_PREFIX, legacyEnvName, readEnv, readEnvEntry, setEnvBoth } from './env-names.ts';

// Names are sample names of this test file (never registered variables of the product).
const NAME = 'CAW_SAMPLE_THING';
const LEGACY = 'MCS_SAMPLE_THING';

describe('prefixes', () => {
  it('names the canonical and the legacy family', () => {
    expect(ENV_PREFIX).toBe('CAW_');
    expect(LEGACY_ENV_PREFIX).toBe('MCS_');
  });
});

describe('legacyEnvName', () => {
  it('replaces the canonical prefix with the legacy one', () => {
    expect(legacyEnvName(NAME)).toBe(LEGACY);
    expect(legacyEnvName('CAW_A')).toBe('MCS_A');
  });

  it('throws for a name without the canonical prefix', () => {
    expect(() => legacyEnvName(LEGACY)).toThrow(/CAW_/);
    expect(() => legacyEnvName('HOME')).toThrow();
    expect(() => legacyEnvName('')).toThrow();
    expect(() => legacyEnvName('caw_lower')).toThrow();
  });

  it('throws for a bare prefix', () => {
    expect(() => legacyEnvName('CAW_')).toThrow();
  });
});

describe('readEnvEntry precedence', () => {
  it('reads nothing when neither name is defined', () => {
    expect(readEnvEntry({}, NAME)).toBeUndefined();
    expect(readEnv({}, NAME)).toBeUndefined();
    expect(readEnvEntry({ [NAME]: undefined, [LEGACY]: undefined }, NAME)).toBeUndefined();
  });

  it('reads the canonical name when only it is defined', () => {
    expect(readEnvEntry({ [NAME]: 'a' }, NAME)).toEqual({ value: 'a', name: NAME, legacy: false });
    expect(readEnv({ [NAME]: 'a' }, NAME)).toBe('a');
  });

  it('reads the legacy name when only it is defined, and says so', () => {
    expect(readEnvEntry({ [LEGACY]: 'b' }, NAME)).toEqual({ value: 'b', name: LEGACY, legacy: true });
    expect(readEnv({ [LEGACY]: 'b' }, NAME)).toBe('b');
  });

  it('lets the canonical name win when both are defined', () => {
    const env = { [NAME]: 'a', [LEGACY]: 'b' };
    expect(readEnvEntry(env, NAME)).toEqual({ value: 'a', name: NAME, legacy: false });
    expect(readEnv(env, NAME)).toBe('a');
  });

  it('treats an empty canonical value as defined: it wins and does not fall back', () => {
    const env = { [NAME]: '', [LEGACY]: 'b' };
    expect(readEnvEntry(env, NAME)).toEqual({ value: '', name: NAME, legacy: false });
    expect(readEnv(env, NAME)).toBe('');
  });

  it('treats an empty legacy value as defined when the canonical one is not', () => {
    expect(readEnvEntry({ [LEGACY]: '' }, NAME)).toEqual({ value: '', name: LEGACY, legacy: true });
  });

  it('does not fall back from a canonical value that a later validation would reject', () => {
    // The variable's own validation runs on the value that was read; the reader does not look at the content.
    const env = { [NAME]: 'relative/path', [LEGACY]: '/absolute/path' };
    expect(readEnv(env, NAME)).toBe('relative/path');
  });

  it('falls back to the legacy name when the canonical key is present but undefined', () => {
    expect(readEnv({ [NAME]: undefined, [LEGACY]: 'b' }, NAME)).toBe('b');
  });

  it('ignores a legacy-named request: the argument is always the canonical name', () => {
    expect(() => readEnvEntry({ [LEGACY]: 'b' }, LEGACY)).toThrow();
    expect(() => readEnv({}, 'HOME')).toThrow();
  });

  it('does not read the prototype chain', () => {
    expect(readEnv(Object.create({ [NAME]: 'inherited' }) as Record<string, string>, NAME)).toBeUndefined();
  });
});

describe('setEnvBoth', () => {
  it('sets the canonical and the legacy spelling to the same value', () => {
    const target: Record<string, string> = {};
    setEnvBoth(target, NAME, '1');
    expect(target).toEqual({ [NAME]: '1', [LEGACY]: '1' });
  });

  it('overwrites both spellings and leaves other keys alone', () => {
    const target: Record<string, string> = { [NAME]: 'old', [LEGACY]: 'older', OTHER: 'x' };
    setEnvBoth(target, NAME, 'new');
    expect(target).toEqual({ [NAME]: 'new', [LEGACY]: 'new', OTHER: 'x' });
  });

  it('writes an empty value to both spellings', () => {
    const target: Record<string, string> = {};
    setEnvBoth(target, NAME, '');
    expect(target).toEqual({ [NAME]: '', [LEGACY]: '' });
  });

  it('refuses a name without the canonical prefix and writes nothing', () => {
    const target: Record<string, string> = {};
    expect(() => {
      setEnvBoth(target, LEGACY, '1');
    }).toThrow();
    expect(target).toEqual({});
  });

  it('round-trips with readEnv', () => {
    const target: Record<string, string> = {};
    setEnvBoth(target, NAME, 'v');
    expect(readEnv(target, NAME)).toBe('v');
    expect(readEnv({ [LEGACY]: target[LEGACY] }, NAME)).toBe('v');
  });
});
