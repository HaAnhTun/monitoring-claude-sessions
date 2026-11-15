// The test hooks of 01 2.10 and of the user instance (06 2.5): inert unless MCS_TEST is exactly 1, and only the documented
// hooks exist.
import { describe, expect, it, vi } from 'vitest';

import { EMPTY_CENSUS, type TerminalCensus } from './user-services.ts';
import {
  FAKE_TERMINALS_MAX,
  TEST_HOOK_NAMES,
  TEST_HOOK_VARIABLES,
  fakeTerminalCount,
  folderPickerHook,
  testHook,
  withFakeTerminals,
} from './test-hooks.ts';

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

  it('documents exactly the hooks of 01 2.10, the open-file recorder, the fake terminals and the folder picker', () => {
    expect([...TEST_HOOK_NAMES].sort()).toEqual([
      'BOOT_HANG',
      'FAKE_TERMINALS',
      'FOLDER_PICKER',
      'IGNORE_CONTROL',
      'INIT_CRASH',
      'OPEN_FILE',
    ]);
    expect(TEST_HOOK_VARIABLES.FOLDER_PICKER).toBe('MCS_TEST_FOLDER_PICKER');
  });
});

describe('FAKE_TERMINALS (06 1.7): scripted terminal sessions for the stop guard', () => {
  const ON = { MCS_TEST: '1' } as const;

  /** A census with real sessions: two live, listed oldest first. */
  function realCensus(): TerminalCensus & { drained: number } {
    const sessions = [
      { name: 'real-1', startedAt: '2026-11-14T10:00:00.000Z' },
      { name: 'real-2', startedAt: '2026-11-14T10:01:00.000Z' },
    ];
    const census = {
      drained: 0,
      count: (): number => sessions.length,
      sessions: (limit: number) => sessions.slice(0, limit),
      beginDrain: (): void => {
        census.drained += 1;
      },
    };
    return census;
  }

  it('is read as a count from MCS_TEST_FAKE_TERMINALS, in test mode only', () => {
    expect(testHook('FAKE_TERMINALS', { ...ON, MCS_TEST_FAKE_TERMINALS: '2' })).toBe('2');
    expect(testHook('FAKE_TERMINALS', { MCS_TEST_FAKE_TERMINALS: '2' })).toBeUndefined();
    expect(fakeTerminalCount({ ...ON, MCS_TEST_FAKE_TERMINALS: '2' })).toBe(2);
    expect(fakeTerminalCount({ MCS_TEST_FAKE_TERMINALS: '2' })).toBe(0);
    expect(fakeTerminalCount(ON)).toBe(0);
  });

  it('reads anything that is not a positive whole number as none, and caps the count', () => {
    for (const value of ['0', '-1', '1.5', 'two', '1e3', '0x2', ' 2', '2 ', '+2', '']) {
      expect(fakeTerminalCount({ ...ON, MCS_TEST_FAKE_TERMINALS: value }), JSON.stringify(value)).toBe(0);
    }
    expect(fakeTerminalCount({ ...ON, MCS_TEST_FAKE_TERMINALS: String(FAKE_TERMINALS_MAX) })).toBe(FAKE_TERMINALS_MAX);
    expect(fakeTerminalCount({ ...ON, MCS_TEST_FAKE_TERMINALS: String(FAKE_TERMINALS_MAX + 1) })).toBe(
      FAKE_TERMINALS_MAX,
    );
    expect(fakeTerminalCount({ ...ON, MCS_TEST_FAKE_TERMINALS: '99999999999999999999' })).toBe(FAKE_TERMINALS_MAX);
  });

  it('returns the very same census while the hook is off', () => {
    const census = realCensus();
    expect(withFakeTerminals(census, {})).toBe(census);
    expect(withFakeTerminals(census, { MCS_TEST_FAKE_TERMINALS: '3' })).toBe(census);
    expect(withFakeTerminals(census, { ...ON, MCS_TEST_FAKE_TERMINALS: 'x' })).toBe(census);
  });

  it('adds n sessions named fake-1..fake-n to the count and to the list', () => {
    const wrapped = withFakeTerminals(EMPTY_CENSUS, { ...ON, MCS_TEST_FAKE_TERMINALS: '3' });
    expect(wrapped.count()).toBe(3);
    expect(wrapped.sessions(50).map((entry) => entry.name)).toEqual(['fake-1', 'fake-2', 'fake-3']);
    for (const entry of wrapped.sessions(50)) {
      expect(entry.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(entry.startedAt).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$/);
    }
    expect(wrapped.sessions(2).map((entry) => entry.name)).toEqual(['fake-1', 'fake-2']);
    expect(wrapped.sessions(0)).toEqual([]);
  });

  it('keeps the real sessions: the count adds up, the list is oldest first and bounded by the limit', () => {
    const census = realCensus();
    const wrapped = withFakeTerminals(census, { ...ON, MCS_TEST_FAKE_TERMINALS: '2' });
    expect(wrapped.count()).toBe(4);
    expect(wrapped.sessions(50).map((entry) => entry.name)).toEqual(['fake-1', 'fake-2', 'real-1', 'real-2']);
    expect(wrapped.sessions(3).map((entry) => entry.name)).toEqual(['fake-1', 'fake-2', 'real-1']);
    const stamps = wrapped.sessions(50).map((entry) => entry.startedAt);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('hands the drain to the wrapped census and ends nothing itself', () => {
    const census = realCensus();
    const wrapped = withFakeTerminals(census, { ...ON, MCS_TEST_FAKE_TERMINALS: '1' });
    wrapped.beginDrain();
    expect(census.drained).toBe(1);
    expect(wrapped.count()).toBe(3);
  });
});

describe('FOLDER_PICKER: the testkit fake picker instead of the Windows dialog', () => {
  const ON = { MCS_TEST: '1' } as const;
  const SCRIPT = '/FIXTURE/testkit/assets/fake-picker.mjs';

  it('is read in test mode only, by its short name and by its variable', () => {
    expect(testHook('FOLDER_PICKER', { ...ON, MCS_TEST_FOLDER_PICKER: SCRIPT })).toBe(SCRIPT);
    expect(testHook('MCS_TEST_FOLDER_PICKER', { ...ON, MCS_TEST_FOLDER_PICKER: SCRIPT })).toBe(SCRIPT);
    expect(testHook('FOLDER_PICKER', { MCS_TEST_FOLDER_PICKER: SCRIPT })).toBeUndefined();
    expect(testHook('FOLDER_PICKER', { ...ON, MCS_TEST_FOLDER_PICKER: '' })).toBeUndefined();
  });

  it('answers the script of the fake picker and hands its answer variable on, only while the hook is on', () => {
    const answer = 'D:\\FIXTURE\\one';
    expect(folderPickerHook({ ...ON, MCS_TEST_FOLDER_PICKER: SCRIPT, FAKE_PICKER_RESULT: answer })).toEqual({
      script: SCRIPT,
      env: { FAKE_PICKER_RESULT: answer },
    });
    expect(folderPickerHook({ ...ON, MCS_TEST_FOLDER_PICKER: SCRIPT })).toEqual({ script: SCRIPT, env: {} });
  });

  it('is undefined while the hook is off: test mode off, no variable, an empty variable', () => {
    expect(folderPickerHook({ MCS_TEST_FOLDER_PICKER: SCRIPT, FAKE_PICKER_RESULT: 'x' })).toBeUndefined();
    expect(folderPickerHook(ON)).toBeUndefined();
    expect(folderPickerHook({ ...ON, MCS_TEST_FOLDER_PICKER: '' })).toBeUndefined();
  });

  it('hands on nothing else of the environment', () => {
    const hook = folderPickerHook({ ...ON, MCS_TEST_FOLDER_PICKER: SCRIPT, MCS_HOME: '/h', SECRET_TOKEN: 's' });
    expect(hook?.env).toEqual({});
  });
});
