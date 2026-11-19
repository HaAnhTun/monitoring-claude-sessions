import { describe, expect, it } from 'vitest';

import type { HostPlatform } from '../platform/host.ts';
import { buildNativeEnv, buildTerminalEnv, envValue, type EnvSource } from './env.ts';
import { TERM_PROGRAM } from './limits.ts';

const build = (source: EnvSource, platform: HostPlatform = 'win32', keep: readonly string[] = []) =>
  buildTerminalEnv(source, { keep, platform });

describe('TC-UNIT-03 buildTerminalEnv: names that are stripped', () => {
  const STRIPPED = [
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_X',
    'CLAUDECODE',
    'CLAUDE_SESSION_ID',
    'NO_COLOR',
    'FORCE_COLOR',
    'MCS_HOOK_DISABLE',
  ];

  it.each(STRIPPED)('drops %s', (name) => {
    expect(build({ [name]: '1', KEEP_ME: 'yes' })).not.toHaveProperty(name);
    expect(build({ [name]: '1', KEEP_ME: 'yes' }, 'linux')).not.toHaveProperty(name);
  });

  it.each(STRIPPED)('on win32 the strip list is case-insensitive: %s in lower and mixed case', (name) => {
    const lower = name.toLowerCase();
    const mixed = name.charAt(0) + name.slice(1).toLowerCase();
    const out = build({ [lower]: '1', [mixed]: '2', KEEP_ME: 'yes' }, 'win32');
    expect(Object.keys(out).filter((key) => key.toUpperCase() === name)).toEqual([]);
    expect(out['KEEP_ME']).toBe('yes');
  });

  it.each(STRIPPED)('elsewhere the strip list is exact: %s in lower case survives on linux and darwin', (name) => {
    const lower = name.toLowerCase();
    for (const platform of ['linux', 'darwin', 'other'] as const) {
      expect(build({ [lower]: '1' }, platform)[lower]).toBe('1');
    }
  });

  it('keeps names that only look like the stripped ones', () => {
    const lookalikes = {
      CLAUDE_CODE: 'a',
      CLAUDE_CODEX: 'b',
      CLAUDECODEX: 'c',
      MY_CLAUDE_CODE_X: 'd',
      CLAUDE_CONFIG_DIR: 'e',
      CLAUDE_SESSION: 'f',
      ANTHROPIC_API_KEY: 'g',
      ANTHROPIC_BASE_URL: 'h',
      MCS_HOME: 'i',
      NOT_MCS_HOOK_DISABLE: 'j',
      NO_COLORS: 'k',
    };
    const out = build(lookalikes);
    for (const [name, value] of Object.entries(lookalikes)) expect(out[name], name).toBe(value);
  });

  it('passes everything else through, PATH and SystemRoot included', () => {
    const out = build({ PATH: 'C:\\bin', SystemRoot: 'C:\\Windows', CLAUDE_CONFIG_DIR: 'C:\\cfg', LANG: 'en' });
    expect(out['PATH']).toBe('C:\\bin');
    expect(out['SystemRoot']).toBe('C:\\Windows');
    expect(out['CLAUDE_CONFIG_DIR']).toBe('C:\\cfg');
    expect(out['LANG']).toBe('en');
  });
});

describe('TC-UNIT-03 buildTerminalEnv: the keep list (terminal.envKeep)', () => {
  it('keeps a stripped name that is listed', () => {
    const out = build({ CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OTHER: '2', CLAUDECODE: '1' }, 'linux', [
      'CLAUDE_CODE_USE_BEDROCK',
    ]);
    expect(out['CLAUDE_CODE_USE_BEDROCK']).toBe('1');
    expect(out).not.toHaveProperty('CLAUDE_CODE_OTHER');
    expect(out).not.toHaveProperty('CLAUDECODE');
  });

  it('on win32 a listed name matches in any case, and keeps the spelling of the source', () => {
    const out = build({ claude_code_use_bedrock: '1', No_Color: '1' }, 'win32', ['CLAUDE_CODE_USE_BEDROCK']);
    expect(out['claude_code_use_bedrock']).toBe('1');
    expect(out).not.toHaveProperty('No_Color');
  });

  it('elsewhere a listed name matches exactly', () => {
    const out = build({ claude_code_use_bedrock: '1', CLAUDE_CODE_USE_BEDROCK: '2' }, 'linux', [
      'CLAUDE_CODE_USE_BEDROCK',
    ]);
    expect(out['CLAUDE_CODE_USE_BEDROCK']).toBe('2');
    expect(out['claude_code_use_bedrock']).toBe('1');
  });

  it('can keep the plain strip-list names too', () => {
    const out = build({ NO_COLOR: '1', MCS_HOOK_DISABLE: '1', CLAUDE_SESSION_ID: 'x' }, 'win32', [
      'NO_COLOR',
      'MCS_HOOK_DISABLE',
    ]);
    expect(out['NO_COLOR']).toBe('1');
    expect(out['MCS_HOOK_DISABLE']).toBe('1');
    expect(out).not.toHaveProperty('CLAUDE_SESSION_ID');
  });
});

describe('TC-UNIT-03 buildTerminalEnv: the values it sets', () => {
  it('sets TERM, COLORTERM and TERM_PROGRAM', () => {
    const out = build({});
    expect(out['TERM']).toBe('xterm-256color');
    expect(out['COLORTERM']).toBe('truecolor');
    expect(out['TERM_PROGRAM']).toBe('CAW');
    expect(TERM_PROGRAM).toBe('CAW');
  });

  it('replaces what the server environment had, TERM_PROGRAM of another terminal included', () => {
    const out = build({ TERM: 'dumb', COLORTERM: '', TERM_PROGRAM: 'vscode' }, 'linux');
    expect(out['TERM']).toBe('xterm-256color');
    expect(out['COLORTERM']).toBe('truecolor');
    expect(out['TERM_PROGRAM']).toBe('CAW');
  });

  it('on win32 a key of another case is replaced, never left next to the new one', () => {
    const out = build({ Term: 'dumb', colorterm: '24bit', Term_Program: 'vscode' }, 'win32');
    expect(Object.keys(out).filter((key) => key.toUpperCase() === 'TERM')).toEqual(['TERM']);
    expect(Object.keys(out).filter((key) => key.toUpperCase() === 'COLORTERM')).toEqual(['COLORTERM']);
    expect(Object.keys(out).filter((key) => key.toUpperCase() === 'TERM_PROGRAM')).toEqual(['TERM_PROGRAM']);
    expect(out['TERM']).toBe('xterm-256color');
  });

  it('elsewhere a key of another case is a different variable and stays', () => {
    const out = build({ term: 'dumb' }, 'linux');
    expect(out['term']).toBe('dumb');
    expect(out['TERM']).toBe('xterm-256color');
  });

  it('sets NoDefaultCurrentDirectoryInExePath=1 so cmd.exe never runs a planted node.cmd of the project folder', () => {
    expect(build({})['NoDefaultCurrentDirectoryInExePath']).toBe('1');
    expect(build({}, 'linux')['NoDefaultCurrentDirectoryInExePath']).toBe('1');
  });

  it('on win32 replaces a server value of that variable whatever its case', () => {
    const out = build({ nodefaultcurrentdirectoryinexepath: '0' }, 'win32');
    expect(Object.keys(out).filter((key) => key.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH')).toEqual([
      'NoDefaultCurrentDirectoryInExePath',
    ]);
    expect(out['NoDefaultCurrentDirectoryInExePath']).toBe('1');
  });
});

describe('TC-UNIT-03 buildTerminalEnv: entries that cannot reach a child', () => {
  it('drops an undefined value, a NUL in the name or the value, an empty name and a name with "="', () => {
    const out = build({
      GOOD: 'fine',
      GONE: undefined,
      'A=B': 'x',
      '=C:': 'x',
      '': 'x',
      'BAD\u0000NAME': 'x',
      NUL_VALUE: 'a\u0000b',
    });
    expect(out['GOOD']).toBe('fine');
    for (const name of ['GONE', 'A=B', '=C:', '', 'BAD\u0000NAME', 'NUL_VALUE']) {
      expect(Object.keys(out), JSON.stringify(name)).not.toContain(name);
    }
    expect(Object.keys(out).filter((key) => key.includes('=') || key.includes('\u0000') || key === '')).toEqual([]);
  });

  it('keeps an empty value', () => {
    expect(build({ EMPTY: '' })['EMPTY']).toBe('');
  });

  it('on win32 keeps the first spelling of two keys that differ only in case', () => {
    const out = build({ Path: 'first', PATH: 'second', path: 'third' }, 'win32');
    expect(Object.keys(out).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['Path']);
    expect(out['Path']).toBe('first');
  });

  it('elsewhere keeps both', () => {
    const out = build({ Path: 'first', PATH: 'second' }, 'linux');
    expect(out['Path']).toBe('first');
    expect(out['PATH']).toBe('second');
  });

  it('does not mutate its input and returns a new object', () => {
    const source = Object.freeze({ A: '1', CLAUDECODE: '1', TERM: 'dumb' });
    const before = JSON.stringify(source);
    const out = build(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(out).not.toBe(source);
    out['A'] = 'changed';
    expect(source.A).toBe('1');
  });

  it('a variable named __proto__ is data, never the prototype of the result', () => {
    const source: Record<string, string> = JSON.parse('{"__proto__":"x","OK":"1"}') as Record<string, string>;
    const out = build(source);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toContain('__proto__');
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe('x');
    expect(out['OK']).toBe('1');
  });
});

describe('TC-UNIT-03 envValue', () => {
  it('on win32 finds a name in any case and prefers the exact spelling', () => {
    expect(envValue({ Path: 'a' }, 'PATH', 'win32')).toBe('a');
    expect(envValue({ pathext: '.EXE' }, 'PATHEXT', 'win32')).toBe('.EXE');
    expect(envValue({ Path: 'a', PATH: 'b' }, 'PATH', 'win32')).toBe('b');
    expect(envValue({}, 'PATH', 'win32')).toBeUndefined();
  });

  it('elsewhere is exact', () => {
    expect(envValue({ Path: 'a' }, 'PATH', 'linux')).toBeUndefined();
    expect(envValue({ PATH: 'b' }, 'PATH', 'linux')).toBe('b');
  });
});

describe('CAW-145 buildNativeEnv: the environment of a window of a native terminal', () => {
  const native = (source: EnvSource, platform: HostPlatform = 'win32', keep: readonly string[] = []) =>
    buildNativeEnv(source, { keep, platform });

  it.each(['CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'CLAUDE_SESSION_ID', 'MCS_HOOK_DISABLE'])('drops %s', (name) => {
    expect(native({ [name]: '1', KEEP_ME: 'yes' })).not.toHaveProperty(name);
    expect(native({ [name]: '1', KEEP_ME: 'yes' }, 'linux')).not.toHaveProperty(name);
    expect(native({ [name.toLowerCase()]: '1' }, 'win32')).not.toHaveProperty(name.toLowerCase());
    expect(native({ [name]: '1' }, 'win32', [name])).toHaveProperty(name, '1');
  });

  it('keeps NO_COLOR and FORCE_COLOR as the person set them, unlike the in-app terminal', () => {
    const out = native({ NO_COLOR: '1', FORCE_COLOR: '3' });
    expect(out['NO_COLOR']).toBe('1');
    expect(out['FORCE_COLOR']).toBe('3');
    expect(build({ NO_COLOR: '1', FORCE_COLOR: '3' })).not.toHaveProperty('NO_COLOR');
  });

  it('sets none of TERM, COLORTERM and TERM_PROGRAM: the terminal of the person sets its own', () => {
    const out = native({ PATH: 'C:\bin', Path: 'x' });
    for (const name of ['TERM', 'COLORTERM', 'TERM_PROGRAM']) expect(out, name).not.toHaveProperty(name);
    expect(out['PATH']).toBe('C:\bin');
  });

  it('sets NoDefaultCurrentDirectoryInExePath over any value and keeps the rest of the environment', () => {
    const out = native({ NoDefaultCurrentDirectoryInExePath: '0', PATH: 'C:\bin', OTHER: 'v', gone: undefined });
    expect(out['NoDefaultCurrentDirectoryInExePath']).toBe('1');
    expect(out['OTHER']).toBe('v');
    expect(out).not.toHaveProperty('gone');
    expect(Object.keys(out).filter((key) => key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath')).toHaveLength(
      1,
    );
  });

  it('does not change the input and buildTerminalEnv keeps its own result', () => {
    const source = { CLAUDECODE: '1', NO_COLOR: '1', TERM: 'dumb' };
    native(source);
    expect(source).toEqual({ CLAUDECODE: '1', NO_COLOR: '1', TERM: 'dumb' });
    expect(build(source)).toEqual({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM,
      NoDefaultCurrentDirectoryInExePath: '1',
    });
  });
});
