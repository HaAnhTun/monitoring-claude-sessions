// The test hooks of 01 2.10 and of the user instance (06 2.5): inert unless MCS_TEST is exactly 1, and only the documented
// hooks exist.
import { describe, expect, it, vi } from 'vitest';

import { TEST_HOOK_NAMES, testHook } from './test-hooks.ts';

describe('testHook', () => {
  it('is inert while MCS_TEST is not set to 1', () => {
    vi.stubEnv('MCS_TEST', '');
    vi.stubEnv('MCS_TEST_BOOT_HANG', '1');
    expect(testHook('BOOT_HANG')).toBeUndefined();
    vi.stubEnv('MCS_TEST', 'true');
    expect(testHook('BOOT_HANG')).toBeUndefined();
    vi.stubEnv('MCS_TEST', '0');
    expect(testHook('BOOT_HANG')).toBeUndefined();
  });

  it('returns the value of a documented hook when MCS_TEST is 1', () => {
    vi.stubEnv('MCS_TEST', '1');
    vi.stubEnv('MCS_TEST_IGNORE_CONTROL', '1');
    vi.stubEnv('MCS_TEST_BOOT_HANG', '1');
    vi.stubEnv('MCS_TEST_INIT_CRASH', 'before-rename');
    expect(testHook('IGNORE_CONTROL')).toBe('1');
    expect(testHook('BOOT_HANG')).toBe('1');
    expect(testHook('INIT_CRASH')).toBe('before-rename');
  });

  it('OPEN_FILE (the recorder that replaces opening a page in the shell) follows the same rules', () => {
    vi.stubEnv('MCS_TEST', '');
    vi.stubEnv('MCS_TEST_OPEN_FILE', '/some/recorder.txt');
    expect(testHook('OPEN_FILE')).toBeUndefined();
    vi.stubEnv('MCS_TEST', '1');
    expect(testHook('OPEN_FILE')).toBe('/some/recorder.txt');
    expect(testHook('MCS_TEST_OPEN_FILE')).toBe('/some/recorder.txt');
    vi.stubEnv('MCS_TEST_OPEN_FILE', '');
    expect(testHook('OPEN_FILE')).toBeUndefined();
    expect(testHook('OPEN_FILE', { MCS_TEST: '1', MCS_TEST_OPEN_FILE: '/x' })).toBe('/x');
    expect(testHook('OPEN_FILE', { MCS_TEST_OPEN_FILE: '/x' })).toBeUndefined();
  });

  it('answers undefined for a hook that is not set or is empty', () => {
    vi.stubEnv('MCS_TEST', '1');
    vi.stubEnv('MCS_TEST_IGNORE_CONTROL', '');
    expect(testHook('IGNORE_CONTROL')).toBeUndefined();
    expect(testHook('BOOT_HANG')).toBeUndefined();
  });

  it('accepts the full variable name as well as the short name', () => {
    vi.stubEnv('MCS_TEST', '1');
    vi.stubEnv('MCS_TEST_BOOT_HANG', '1');
    expect(testHook('MCS_TEST_BOOT_HANG')).toBe('1');
  });

  it('never exposes any other variable, even with MCS_TEST on', () => {
    vi.stubEnv('MCS_TEST', '1');
    vi.stubEnv('MCS_TEST_SOMETHING_ELSE', 'x');
    vi.stubEnv('MCS_HOME', 'C:/somewhere');
    expect(testHook('SOMETHING_ELSE')).toBeUndefined();
    expect(testHook('MCS_TEST_SOMETHING_ELSE')).toBeUndefined();
    expect(testHook('MCS_HOME')).toBeUndefined();
    expect(testHook('PATH')).toBeUndefined();
    expect(testHook('')).toBeUndefined();
    expect(testHook('__proto__')).toBeUndefined();
  });

  it('reads the environment it is given instead of the process environment', () => {
    expect(testHook('BOOT_HANG', { MCS_TEST: '1', MCS_TEST_BOOT_HANG: '1' })).toBe('1');
    expect(testHook('BOOT_HANG', { MCS_TEST_BOOT_HANG: '1' })).toBeUndefined();
  });

  it('documents exactly the hooks of 01 2.10 and the open-file recorder', () => {
    expect([...TEST_HOOK_NAMES].sort()).toEqual(['BOOT_HANG', 'IGNORE_CONTROL', 'INIT_CRASH', 'OPEN_FILE']);
  });
});
