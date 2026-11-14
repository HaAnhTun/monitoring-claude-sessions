import { describe, expect, it } from 'vitest';

import { RuntimeFileSchema, RuntimeOverridesSchema } from './index.ts';
import { AppSectionKeys, AppSectionSchema } from './app.ts';
import { TerminalSectionKeys, TerminalSectionSchema } from './terminal.ts';

const accepts = (key: string, value: unknown) =>
  RuntimeOverridesSchema.safeParse({ schema_version: 1, terminal: { [key]: value } }).success;

describe('terminal section (TC-CFG-01, design 01 3.3 with the bounds of 06 1.6)', () => {
  it('has exactly the nine keys and their defaults', () => {
    expect(Object.keys(TerminalSectionKeys).sort()).toEqual(
      [
        'args',
        'command',
        'conptyDll',
        'envKeep',
        'killTimeoutMs',
        'maxInputBytes',
        'maxSessions',
        'replayBytes',
        'startTimeoutMs',
      ].sort(),
    );
    expect(TerminalSectionSchema.parse(undefined)).toEqual({
      command: 'claude',
      args: [],
      envKeep: [],
      maxSessions: 8,
      replayBytes: 1_048_576,
      maxInputBytes: 262_144,
      startTimeoutMs: 10_000,
      killTimeoutMs: 3000,
      conptyDll: false,
    });
  });

  it('is part of the merged file and of the overrides file', () => {
    const merged = RuntimeFileSchema.parse({ schema_version: 1 });
    expect(merged.terminal.command).toBe('claude');
    expect(RuntimeOverridesSchema.parse({ schema_version: 1 })).toEqual({ schema_version: 1 });
    expect(RuntimeOverridesSchema.parse({ schema_version: 1, terminal: { maxSessions: 2 } })).toEqual({
      schema_version: 1,
      terminal: { maxSessions: 2 },
    });
  });

  it('refuses an unknown key, in the section schema and in the overrides file', () => {
    expect(accepts('shell', 'cmd')).toBe(false);
    expect(accepts('enabled', true)).toBe(false);
    expect(TerminalSectionSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it('command: 1..260 characters, no quote and no control character', () => {
    expect(accepts('command', 'claude')).toBe(true);
    expect(accepts('command', 'C:/tools/claude.exe')).toBe(true);
    expect(accepts('command', 'x'.repeat(260))).toBe(true);
    expect(accepts('command', 'x'.repeat(261))).toBe(false);
    expect(accepts('command', '')).toBe(false);
    expect(accepts('command', 'cla"ude')).toBe(false);
    expect(accepts('command', 'claude\n')).toBe(false);
    expect(accepts('command', 'cla\u0000ude')).toBe(false);
    expect(accepts('command', 'cla\u001fude')).toBe(false);
    expect(accepts('command', 'cla\u007fude')).toBe(false);
    expect(accepts('command', 42)).toBe(false);
  });

  it('args: at most 32 strings of at most 500 characters, none with a NUL', () => {
    expect(accepts('args', [])).toBe(true);
    expect(accepts('args', ['--verbose', '--model', 'sonnet'])).toBe(true);
    expect(
      accepts(
        'args',
        Array.from({ length: 32 }, () => 'a'),
      ),
    ).toBe(true);
    expect(
      accepts(
        'args',
        Array.from({ length: 33 }, () => 'a'),
      ),
    ).toBe(false);
    expect(accepts('args', ['a'.repeat(500)])).toBe(true);
    expect(accepts('args', ['a'.repeat(501)])).toBe(false);
    expect(accepts('args', ['a\u0000b'])).toBe(false);
    expect(accepts('args', ['--flag value with spaces'])).toBe(true);
    expect(accepts('args', 'one string')).toBe(false);
    expect(accepts('args', [1])).toBe(false);
  });

  it('envKeep: at most 32 variable names', () => {
    expect(accepts('envKeep', ['CLAUDE_CODE_USE_BEDROCK', '_X1'])).toBe(true);
    expect(
      accepts(
        'envKeep',
        Array.from({ length: 33 }, (_, i) => `NAME_${String(i)}`),
      ),
    ).toBe(false);
    expect(accepts('envKeep', ['1BAD'])).toBe(false);
    expect(accepts('envKeep', ['A-B'])).toBe(false);
    expect(accepts('envKeep', ['A=B'])).toBe(false);
    expect(accepts('envKeep', [''])).toBe(false);
    expect(accepts('envKeep', ['A'.repeat(129)])).toBe(false);
  });

  it('maxSessions: integer 1..64', () => {
    expect(accepts('maxSessions', 1)).toBe(true);
    expect(accepts('maxSessions', 64)).toBe(true);
    expect(accepts('maxSessions', 0)).toBe(false);
    expect(accepts('maxSessions', 65)).toBe(false);
    expect(accepts('maxSessions', 2.5)).toBe(false);
    expect(accepts('maxSessions', '8')).toBe(false);
  });

  it('replayBytes: integer 64 KiB..16 MiB', () => {
    expect(accepts('replayBytes', 65_536)).toBe(true);
    expect(accepts('replayBytes', 16_777_216)).toBe(true);
    expect(accepts('replayBytes', 65_535)).toBe(false);
    expect(accepts('replayBytes', 16_777_217)).toBe(false);
  });

  it('maxInputBytes: default and maximum are the one shared limit of 262144, the minimum is 1024', () => {
    expect(TerminalSectionSchema.parse({}).maxInputBytes).toBe(262_144);
    expect(accepts('maxInputBytes', 262_144)).toBe(true);
    expect(accepts('maxInputBytes', 262_145)).toBe(false);
    expect(accepts('maxInputBytes', 1_048_576)).toBe(false);
    expect(accepts('maxInputBytes', 1024)).toBe(true);
    expect(accepts('maxInputBytes', 1023)).toBe(false);
  });

  it('startTimeoutMs 1000..60000 and killTimeoutMs 500..30000', () => {
    expect(accepts('startTimeoutMs', 1000)).toBe(true);
    expect(accepts('startTimeoutMs', 60_000)).toBe(true);
    expect(accepts('startTimeoutMs', 999)).toBe(false);
    expect(accepts('startTimeoutMs', 60_001)).toBe(false);
    expect(accepts('killTimeoutMs', 500)).toBe(true);
    expect(accepts('killTimeoutMs', 30_000)).toBe(true);
    expect(accepts('killTimeoutMs', 499)).toBe(false);
    expect(accepts('killTimeoutMs', 30_001)).toBe(false);
  });

  it('conptyDll is a boolean', () => {
    expect(accepts('conptyDll', true)).toBe(true);
    expect(accepts('conptyDll', 'yes')).toBe(false);
    expect(accepts('conptyDll', 1)).toBe(false);
  });

  it('does not share the default arrays between parses or with the key table', () => {
    const first = TerminalSectionSchema.parse({});
    first.args.push('--x');
    first.envKeep.push('X');
    expect(TerminalSectionSchema.parse({}).args).toEqual([]);
    expect(TerminalSectionSchema.parse({}).envKeep).toEqual([]);
    expect(TerminalSectionKeys.args.default).toEqual([]);
    expect(TerminalSectionKeys.envKeep.default).toEqual([]);
  });
});

describe('app section (TC-CFG-03, design 06 1.6)', () => {
  const acceptsApp = (key: string, value: unknown) =>
    RuntimeOverridesSchema.safeParse({ schema_version: 1, app: { [key]: value } }).success;

  it('has name and openAppWindow with their defaults, and the section is app (never ui)', () => {
    expect(Object.keys(AppSectionKeys).sort()).toEqual(['name', 'openAppWindow']);
    expect(AppSectionSchema.parse(undefined)).toEqual({ name: 'Claude Agent Workspace', openAppWindow: false });
    expect(RuntimeFileSchema.parse({ schema_version: 1 }).app.name).toBe('Claude Agent Workspace');
    expect(RuntimeOverridesSchema.safeParse({ schema_version: 1, ui: { name: 'x' } }).success).toBe(false);
  });

  it('name: 1..80 printable characters', () => {
    expect(acceptsApp('name', 'My workspace')).toBe(true);
    expect(acceptsApp('name', 'x'.repeat(80))).toBe(true);
    expect(acceptsApp('name', 'x'.repeat(81))).toBe(false);
    expect(acceptsApp('name', '')).toBe(false);
    expect(acceptsApp('name', 'a\nb')).toBe(false);
    expect(acceptsApp('name', 'a\u0000b')).toBe(false);
    expect(acceptsApp('name', 'a\u007fb')).toBe(false);
  });

  it('openAppWindow is a boolean and unknown keys are refused', () => {
    expect(acceptsApp('openAppWindow', true)).toBe(true);
    expect(acceptsApp('openAppWindow', 'true')).toBe(false);
    expect(acceptsApp('title', 'x')).toBe(false);
  });
});
