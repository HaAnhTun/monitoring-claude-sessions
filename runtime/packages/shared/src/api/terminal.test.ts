import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TerminalSectionKeys } from '../config/runtime/terminal.ts';
import { ACCESS_CODE_RE } from '../protocol/access.ts';
import { ERROR_CODES, TERMINAL_ERROR_CODES } from './errors.ts';
import { TerminalLinkSchema } from './folders.ts';
import {
  AccessCodeSchema,
  AuthSessionResponseSchema,
  CreateSessionBodySchema,
  CreateSessionResponseSchema,
  EmptyBodySchema,
  ExchangeBodySchema,
  ExchangeResponseSchema,
  FolderPathSchema,
  KillSessionResponseSchema,
  LogoutResponseSchema,
  PickFolderResponseSchema,
  ResumeBodySchema,
  ResumeResponseSchema,
  TERMINAL_CLOSE_CODES,
  TERMINAL_EVENT_NAMES,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_NAME_RE,
  TERMINAL_SIZE_LIMITS,
  TERMINAL_SUBPROTOCOL,
  TERMINAL_TEXT_FRAME_MAX_BYTES,
  TERMINAL_UNAVAILABLE_REASONS,
  TerminalCapabilitiesSchema,
  TerminalClientMessageSchema,
  TerminalEventSchemas,
  TerminalNameParamsSchema,
  TerminalNameSchema,
  TerminalServerMessageSchema,
  TerminalSessionInfoSchema,
  TerminalStateSchema,
  clampTerminalSize,
} from './terminal.ts';

const AT = '2026-11-14T09:30:05.000Z';
const SID = '0b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d11';
const INSTANCE = '3f2b8c1e-0d4a-4b7e-9c11-5a6d7e8f9a0b';
/** A fixed fake access code: 43 characters of the alphabet, the shape of 32 random bytes in base64url. */
const CODE = 'FIXTUREcodeFIXTUREcodeFIXTUREcodeFIXTUREcod';
const BACKSLASH = String.fromCharCode(92);

/** A copy of `value` without one key (the tests need objects with a missing field). */
function without(value: object, omit: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omit));
}

const link = {
  status: 'linked',
  sessionId: SID,
  previousSessionIds: [],
  basis: 'registry-pid',
  confidence: 'high',
  since: AT,
  claudePid: 4321,
  transcript: 'tracked',
  registryStatus: 'busy',
  waitingFor: null,
  reason: null,
  shared: false,
};

const session = {
  name: 'app-1',
  path: 'D:\\work\\app',
  createdAt: AT,
  cols: 120,
  rows: 30,
  viewers: 1,
  link,
  folderKey: 'd--work-app',
};

const capabilities = { available: true, reason: null, folderPicker: true, resume: true, maxSessions: 8 };

describe('terminal names (design 02 2.3)', () => {
  it('pins the MTOP pattern', () => {
    expect(TERMINAL_NAME_RE.source).toBe('^[A-Za-z0-9_-]{1,64}$');
  });

  it.each(['a', 'app-1', 'My_Folder-12', 'A'.repeat(64), '0', '-', '_'])('accepts %s', (name) => {
    expect(TerminalNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['65 characters', 'a'.repeat(65)],
    ['a slash', 'a/b'],
    ['a backslash', `a${BACKSLASH}b`],
    ['two dots', '..'],
    ['one dot', '.'],
    ['a dot inside', 'a.b'],
    ['a space', 'a b'],
    ['a NUL', 'a\u0000b'],
    ['a trailing newline', 'a\n'],
    ['a leading newline', '\na'],
    ['a percent escape', 'a%2Fb'],
    ['a letter with an accent', 'caf\u00e9'],
    ['a fullwidth digit', '\uff11'],
    ['a colon', 'a:b'],
  ])('refuses %s', (_label, name) => {
    expect(TerminalNameSchema.safeParse(name).success).toBe(false);
  });

  it('refuses a name that is not a string', () => {
    for (const value of [1, null, undefined, ['a'], { name: 'a' }]) {
      expect(TerminalNameSchema.safeParse(value).success).toBe(false);
    }
  });

  it('the path parameter object is strict and has the one key name', () => {
    expect(TerminalNameParamsSchema.safeParse({ name: 'app-1' }).success).toBe(true);
    expect(TerminalNameParamsSchema.safeParse({ name: 'app-1', extra: 1 }).success).toBe(false);
    expect(TerminalNameParamsSchema.safeParse({}).success).toBe(false);
    expect(Object.keys(TerminalNameParamsSchema.shape)).toEqual(['name']);
  });
});

describe('AccessCodeSchema (the code of protocol/access.ts)', () => {
  it('accepts exactly what ACCESS_CODE_RE accepts', () => {
    const samples = [
      CODE,
      'a'.repeat(32),
      'a'.repeat(128),
      'a'.repeat(31),
      'a'.repeat(129),
      `${CODE}\n`,
      `${CODE}=`,
      CODE.replace('F', '+'),
      CODE.replace('F', '/'),
      CODE.replace('F', ' '),
      '',
      '-_'.repeat(20),
    ];
    for (const sample of samples) {
      expect(AccessCodeSchema.safeParse(sample).success, sample).toBe(ACCESS_CODE_RE.test(sample));
    }
  });

  it('refuses a value that is not a string', () => {
    for (const value of [1, null, undefined, [CODE]]) expect(AccessCodeSchema.safeParse(value).success).toBe(false);
  });

  it('does not repeat the code in a failure', () => {
    const bad = `${CODE.slice(0, 30)}!!`;
    const result = AccessCodeSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).not.toContain(bad);
  });
});

describe('FolderPathSchema (design 02 2.3)', () => {
  it.each([
    ['a drive path', 'D:\\work\\app'],
    ['a drive path with forward slashes', 'D:/work/app'],
    ['a path with a space and a non-ASCII letter', 'D:\\work\\caf\u00e9 app'],
    ['a POSIX path', '/home/user/app'],
    ['a relative path (the engine decides)', 'app'],
    ['1024 characters', `D:\\${'a'.repeat(1021)}`],
  ])('accepts %s', (_label, path) => {
    expect(FolderPathSchema.safeParse(path).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['1025 characters', `D:\\${'a'.repeat(1022)}`],
    ['a UNC path', `${BACKSLASH}${BACKSLASH}host${BACKSLASH}share${BACKSLASH}dir`],
    ['a UNC path with forward slashes', '//host/share/dir'],
    ['a UNC path with mixed slashes', `/${BACKSLASH}host/share`],
    ['a UNC path with a leading space', ` ${BACKSLASH}${BACKSLASH}host${BACKSLASH}share`],
    ['a quoted UNC path', `"${BACKSLASH}${BACKSLASH}host${BACKSLASH}share"`],
    ['a device path (extended)', `${BACKSLASH}${BACKSLASH}?${BACKSLASH}C:${BACKSLASH}dir`],
    ['a device path (local device)', `${BACKSLASH}${BACKSLASH}.${BACKSLASH}pipe${BACKSLASH}x`],
    ['a device path with forward slashes', '//?/C:/dir'],
    ['an NT object path', `${BACKSLASH}??${BACKSLASH}C:${BACKSLASH}dir`],
    ['a NUL character', 'D:\\work\\a\u0000b'],
    ['a newline', 'D:\\work\\a\nb'],
    ['a tab', 'D:\\work\\a\tb'],
    ['a DEL character', 'D:\\work\\a\u007fb'],
    ['a C1 control character', 'D:\\work\\a\u0085b'],
  ])('refuses %s', (_label, path) => {
    expect(FolderPathSchema.safeParse(path).success).toBe(false);
  });

  it('refuses a value that is not a string', () => {
    for (const value of [1, null, undefined, ['D:\\x']]) expect(FolderPathSchema.safeParse(value).success).toBe(false);
  });

  it('does not repeat the path in a failure', () => {
    const bad = `${BACKSLASH}${BACKSLASH}FIXTUREhost${BACKSLASH}share`;
    const result = FolderPathSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).not.toContain('FIXTUREhost');
  });
});

describe('capabilities and the session row (design 02 2.3, 03 7.3, plan decision 1: Option A)', () => {
  it('names the four reasons a terminal cannot run', () => {
    expect([...TERMINAL_UNAVAILABLE_REASONS]).toEqual([
      'unsupported_os',
      'addon_missing',
      'claude_not_found',
      'not_configured',
    ]);
  });

  it('accepts an available and an unavailable terminal', () => {
    expect(TerminalCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    for (const reason of TERMINAL_UNAVAILABLE_REASONS) {
      expect(
        TerminalCapabilitiesSchema.safeParse({ ...capabilities, available: false, reason, folderPicker: false })
          .success,
        reason,
      ).toBe(true);
    }
  });

  it('refuses an unknown reason, a missing key, an extra key and a negative size', () => {
    expect(TerminalCapabilitiesSchema.safeParse({ ...capabilities, reason: 'broken' }).success).toBe(false);
    for (const key of Object.keys(capabilities)) {
      expect(TerminalCapabilitiesSchema.safeParse(without(capabilities, key)).success, key).toBe(false);
    }
    expect(TerminalCapabilitiesSchema.safeParse({ ...capabilities, extra: 1 }).success).toBe(false);
    expect(TerminalCapabilitiesSchema.safeParse({ ...capabilities, maxSessions: -1 }).success).toBe(false);
  });

  it('accepts a session row with its link and folder key', () => {
    expect(TerminalSessionInfoSchema.safeParse(session).success).toBe(true);
    expect(TerminalSessionInfoSchema.safeParse({ ...session, folderKey: null }).success).toBe(true);
  });

  it('embeds the TerminalLink of the projects area and carries no monitorSessionId', () => {
    expect(TerminalSessionInfoSchema.shape.link).toBe(TerminalLinkSchema);
    expect(Object.keys(TerminalSessionInfoSchema.shape).sort()).toEqual(
      ['cols', 'createdAt', 'folderKey', 'link', 'name', 'path', 'rows', 'viewers'].sort(),
    );
    expect(TerminalSessionInfoSchema.safeParse({ ...session, monitorSessionId: SID }).success).toBe(false);
  });

  it('refuses a row without a link or a folder key, and a bad name, path, key or time', () => {
    expect(TerminalSessionInfoSchema.safeParse(without(session, 'link')).success).toBe(false);
    expect(TerminalSessionInfoSchema.safeParse(without(session, 'folderKey')).success).toBe(false);
    expect(TerminalSessionInfoSchema.safeParse({ ...session, name: 'a/b' }).success).toBe(false);
    expect(
      TerminalSessionInfoSchema.safeParse({ ...session, path: `${BACKSLASH}${BACKSLASH}h${BACKSLASH}s` }).success,
    ).toBe(false);
    expect(TerminalSessionInfoSchema.safeParse({ ...session, folderKey: 'D:\\work' }).success).toBe(false);
    expect(TerminalSessionInfoSchema.safeParse({ ...session, folderKey: '' }).success).toBe(false);
    expect(TerminalSessionInfoSchema.safeParse({ ...session, createdAt: '2026-11-14' }).success).toBe(false);
    expect(TerminalSessionInfoSchema.safeParse({ ...session, viewers: -1 }).success).toBe(false);
    expect(TerminalSessionInfoSchema.safeParse({ ...session, link: { ...link, extra: 1 } }).success).toBe(false);
  });

  it('the state holds the capabilities, at most 64 sessions, the epoch and the time', () => {
    const state = { capabilities, sessions: [session], epoch: '0a1b2c3d', generatedAt: AT };
    expect(TerminalStateSchema.safeParse(state).success).toBe(true);
    expect(TerminalStateSchema.safeParse({ ...state, sessions: [] }).success).toBe(true);
    expect(
      TerminalStateSchema.safeParse({ ...state, sessions: Array.from({ length: 64 }, () => session) }).success,
    ).toBe(true);
    expect(
      TerminalStateSchema.safeParse({ ...state, sessions: Array.from({ length: 65 }, () => session) }).success,
    ).toBe(false);
    expect(TerminalStateSchema.safeParse({ ...state, epoch: 'XYZ' }).success).toBe(false);
    expect(TerminalStateSchema.safeParse({ ...state, extra: 1 }).success).toBe(false);
    for (const key of Object.keys(state))
      expect(TerminalStateSchema.safeParse(without(state, key)).success, key).toBe(false);
  });

  it('does not repeat the folders: they belong to listFolders', () => {
    expect(Object.keys(TerminalStateSchema.shape).sort()).toEqual(['capabilities', 'epoch', 'generatedAt', 'sessions']);
  });
});

describe('bodies and responses are strict objects (an extra key is validation_failed)', () => {
  it('the empty body is `{}` and nothing else', () => {
    expect(EmptyBodySchema.safeParse({}).success).toBe(true);
    expect(EmptyBodySchema.safeParse({ a: 1 }).success).toBe(false);
    expect(EmptyBodySchema.safeParse(null).success).toBe(false);
    expect(EmptyBodySchema.safeParse([]).success).toBe(false);
  });

  it('exchange takes { code } and answers { authenticated: true }', () => {
    expect(ExchangeBodySchema.safeParse({ code: CODE }).success).toBe(true);
    expect(ExchangeBodySchema.safeParse({}).success).toBe(false);
    expect(ExchangeBodySchema.safeParse({ code: CODE, extra: 1 }).success).toBe(false);
    expect(ExchangeBodySchema.safeParse({ code: 'short' }).success).toBe(false);
    expect(ExchangeBodySchema.shape.code).toBe(AccessCodeSchema);
    expect(ExchangeResponseSchema.safeParse({ authenticated: true }).success).toBe(true);
    expect(ExchangeResponseSchema.safeParse({ authenticated: false }).success).toBe(false);
    expect(ExchangeResponseSchema.safeParse({ authenticated: true, extra: 1 }).success).toBe(false);
  });

  it('the session probe answers { authenticated } and logout answers { authenticated: false }', () => {
    expect(AuthSessionResponseSchema.safeParse({ authenticated: true }).success).toBe(true);
    expect(AuthSessionResponseSchema.safeParse({ authenticated: false }).success).toBe(true);
    expect(AuthSessionResponseSchema.safeParse({ authenticated: 'yes' }).success).toBe(false);
    expect(AuthSessionResponseSchema.safeParse({}).success).toBe(false);
    expect(LogoutResponseSchema.safeParse({ authenticated: false }).success).toBe(true);
    expect(LogoutResponseSchema.safeParse({ authenticated: true }).success).toBe(false);
  });

  it('create takes only a folder path: no command line, no arguments, no environment', () => {
    expect(CreateSessionBodySchema.safeParse({ path: 'D:\\work\\app' }).success).toBe(true);
    expect(CreateSessionBodySchema.safeParse({}).success).toBe(false);
    for (const key of ['command', 'args', 'env', 'cols', 'rows', 'name']) {
      expect(CreateSessionBodySchema.safeParse({ path: 'D:\\work\\app', [key]: 'x' }).success, key).toBe(false);
    }
    expect(CreateSessionBodySchema.safeParse({ path: `${BACKSLASH}${BACKSLASH}h${BACKSLASH}s` }).success).toBe(false);
    expect(CreateSessionResponseSchema.safeParse({ session }).success).toBe(true);
    expect(CreateSessionResponseSchema.safeParse({}).success).toBe(false);
    expect(CreateSessionResponseSchema.safeParse({ session, extra: 1 }).success).toBe(false);
  });

  it('kill answers the name of the session', () => {
    expect(KillSessionResponseSchema.safeParse({ name: 'app-1' }).success).toBe(true);
    expect(KillSessionResponseSchema.safeParse({ name: 'a/b' }).success).toBe(false);
    expect(KillSessionResponseSchema.safeParse({ name: 'app-1', extra: 1 }).success).toBe(false);
  });

  it('the folder dialog answers a folder path or null (the person closed the dialog)', () => {
    expect(PickFolderResponseSchema.safeParse({ path: 'D:\\work\\app' }).success).toBe(true);
    expect(PickFolderResponseSchema.safeParse({ path: null }).success).toBe(true);
    expect(PickFolderResponseSchema.safeParse({}).success).toBe(false);
    expect(PickFolderResponseSchema.safeParse({ path: `${BACKSLASH}${BACKSLASH}h${BACKSLASH}s` }).success).toBe(false);
    expect(PickFolderResponseSchema.safeParse({ path: null, extra: 1 }).success).toBe(false);
  });

  it('resume takes a monitored session id and an optional fork flag, nothing else', () => {
    expect(ResumeBodySchema.safeParse({ sessionId: SID }).success).toBe(true);
    expect(ResumeBodySchema.safeParse({ sessionId: SID, fork: true }).success).toBe(true);
    expect(ResumeBodySchema.safeParse({ sessionId: SID, fork: false }).success).toBe(true);
    expect(ResumeBodySchema.safeParse({ sessionId: SID, fork: 'yes' }).success).toBe(false);
    expect(ResumeBodySchema.safeParse({ fork: true }).success).toBe(false);
    expect(ResumeBodySchema.safeParse({ sessionId: 'abc' }).success).toBe(false);
    for (const key of ['command', 'args', 'env', 'path', 'cwd']) {
      expect(ResumeBodySchema.safeParse({ sessionId: SID, [key]: 'x' }).success, key).toBe(false);
    }
    expect(ResumeResponseSchema.safeParse({ session }).success).toBe(true);
    expect(ResumeResponseSchema.safeParse({ session, extra: 1 }).success).toBe(false);
  });

  it('every body and response converts to JSON Schema', () => {
    const schemas = [
      EmptyBodySchema,
      ExchangeBodySchema,
      ExchangeResponseSchema,
      AuthSessionResponseSchema,
      LogoutResponseSchema,
      CreateSessionBodySchema,
      CreateSessionResponseSchema,
      KillSessionResponseSchema,
      PickFolderResponseSchema,
      ResumeBodySchema,
      ResumeResponseSchema,
      TerminalStateSchema,
      TerminalClientMessageSchema,
      TerminalServerMessageSchema,
      ...Object.values(TerminalEventSchemas),
    ];
    for (const schema of schemas) {
      expect(() => z.toJSONSchema(schema, { io: 'input' })).not.toThrow();
      expect(() => z.toJSONSchema(schema, { io: 'output' })).not.toThrow();
    }
  });
});

describe('the terminal size (design 02 2.3, 5.4)', () => {
  it('pins the limits of MTOP', () => {
    expect(TERMINAL_SIZE_LIMITS).toEqual({
      minCols: 20,
      maxCols: 500,
      minRows: 5,
      maxRows: 200,
      defaultCols: 120,
      defaultRows: 30,
    });
  });

  it('keeps values inside the limits and clamps the others', () => {
    expect(clampTerminalSize(120, 30)).toEqual({ cols: 120, rows: 30 });
    expect(clampTerminalSize(20, 5)).toEqual({ cols: 20, rows: 5 });
    expect(clampTerminalSize(500, 200)).toEqual({ cols: 500, rows: 200 });
    expect(clampTerminalSize(1, 1)).toEqual({ cols: 20, rows: 5 });
    expect(clampTerminalSize(0, 0)).toEqual({ cols: 20, rows: 5 });
    expect(clampTerminalSize(-7, -7)).toEqual({ cols: 20, rows: 5 });
    expect(clampTerminalSize(1000, 1000)).toEqual({ cols: 500, rows: 200 });
    expect(clampTerminalSize(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toEqual({ cols: 500, rows: 200 });
    expect(clampTerminalSize(19, 201)).toEqual({ cols: 20, rows: 200 });
  });

  it('is total: a value that is not a finite number becomes the default, a fraction is cut', () => {
    expect(clampTerminalSize(Number.NaN, Number.NaN)).toEqual({ cols: 120, rows: 30 });
    expect(clampTerminalSize(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toEqual({ cols: 120, rows: 30 });
    expect(clampTerminalSize(80.9, 24.9)).toEqual({ cols: 80, rows: 24 });
  });

  it('the default size lies inside the limits', () => {
    const limits = TERMINAL_SIZE_LIMITS;
    expect(limits.defaultCols).toBeGreaterThanOrEqual(limits.minCols);
    expect(limits.defaultCols).toBeLessThanOrEqual(limits.maxCols);
    expect(limits.defaultRows).toBeGreaterThanOrEqual(limits.minRows);
    expect(limits.defaultRows).toBeLessThanOrEqual(limits.maxRows);
  });
});

describe('socket protocol v1 (design 02 5.4)', () => {
  it('names the subprotocol', () => {
    expect(TERMINAL_SUBPROTOCOL).toBe('caw.terminal.v1');
  });

  it('keeps one input limit, equal to the default and the maximum of terminal.maxInputBytes', () => {
    expect(TERMINAL_INPUT_MAX_BYTES).toBe(262144);
    expect(TERMINAL_INPUT_MAX_BYTES).toBe(256 * 1024);
    const key = TerminalSectionKeys.maxInputBytes;
    expect(key.default).toBe(TERMINAL_INPUT_MAX_BYTES);
    expect(key.schema.safeParse(TERMINAL_INPUT_MAX_BYTES).success).toBe(true);
    expect(key.schema.safeParse(TERMINAL_INPUT_MAX_BYTES + 1).success).toBe(false);
  });

  it('limits a text frame of the client to 256 bytes, and the largest resize message fits', () => {
    expect(TERMINAL_TEXT_FRAME_MAX_BYTES).toBe(256);
    const largest = JSON.stringify({ type: 'resize', cols: 1000, rows: 1000 });
    expect(new TextEncoder().encode(largest).byteLength).toBeLessThanOrEqual(TERMINAL_TEXT_FRAME_MAX_BYTES);
  });

  it('the client sends resize and nothing else, with sizes from 1 to 1000', () => {
    expect(TerminalClientMessageSchema.safeParse({ type: 'resize', cols: 120, rows: 30 }).success).toBe(true);
    expect(TerminalClientMessageSchema.safeParse({ type: 'resize', cols: 1, rows: 1 }).success).toBe(true);
    expect(TerminalClientMessageSchema.safeParse({ type: 'resize', cols: 1000, rows: 1000 }).success).toBe(true);
    for (const bad of [
      { type: 'resize', cols: 0, rows: 30 },
      { type: 'resize', cols: 120, rows: 0 },
      { type: 'resize', cols: 1001, rows: 30 },
      { type: 'resize', cols: 120, rows: 1001 },
      { type: 'resize', cols: 80.5, rows: 24 },
      { type: 'resize', cols: '80', rows: 24 },
      { type: 'resize', cols: -1, rows: 24 },
      { type: 'resize', cols: 80 },
      { type: 'resize', rows: 24 },
      { cols: 80, rows: 24 },
      { type: 'input', data: 'x' },
      { type: 'RESIZE', cols: 80, rows: 24 },
      { type: 'resize', cols: 80, rows: 24, extra: 1 },
      [],
      null,
      'resize',
    ]) {
      expect(TerminalClientMessageSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('the server sends ready, live, size and exit', () => {
    const frames = [
      { type: 'ready', v: 1, cols: 120, rows: 30, replayBytes: 0, viewers: 1 },
      { type: 'ready', v: 1, cols: 80, rows: 24, replayBytes: 1048576, viewers: 8 },
      { type: 'live' },
      { type: 'size', cols: 100, rows: 40 },
      { type: 'exit', code: 0, signal: null },
      { type: 'exit', code: null, signal: 'SIGKILL' },
      { type: 'exit', code: 3, signal: null },
      { type: 'exit', code: null, signal: null },
    ];
    for (const frame of frames) {
      expect(TerminalServerMessageSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
    }
  });

  it('the server frames are strict, versioned and complete', () => {
    const ready = { type: 'ready', v: 1, cols: 120, rows: 30, replayBytes: 0, viewers: 1 };
    const exit = { type: 'exit', code: 0, signal: null };
    for (const bad of [
      { ...ready, v: 2 },
      { ...ready, v: '1' },
      without(ready, 'v'),
      without(ready, 'cols'),
      without(ready, 'replayBytes'),
      without(ready, 'viewers'),
      { ...ready, replayBytes: -1 },
      { ...ready, viewers: -1 },
      { ...ready, cols: 0 },
      { ...ready, rows: 1001 },
      { ...ready, extra: 1 },
      { type: 'live', extra: 1 },
      { type: 'size', cols: 100 },
      { type: 'size', cols: 100, rows: 40, extra: 1 },
      without(exit, 'code'),
      without(exit, 'signal'),
      { ...exit, code: 'x' },
      { ...exit, code: 1.5 },
      { ...exit, signal: 9 },
      { ...exit, signal: '' },
      { ...exit, extra: 1 },
      { type: 'bell' },
      { type: 'output', data: 'x' },
      {},
      [],
      null,
    ]) {
      expect(TerminalServerMessageSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('reads the type first: a bad frame reports one branch, not four', () => {
    const result = TerminalServerMessageSchema.safeParse({ type: 'size', cols: 100 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toEqual(['rows']);
    }
  });

  it('pins the application close codes and the standard ones the gateway uses', () => {
    expect(TERMINAL_CLOSE_CODES.exited).toBe(4000);
    expect(TERMINAL_CLOSE_CODES.killed).toBe(4001);
    expect(TERMINAL_CLOSE_CODES.signedOut).toBe(4003);
    expect(TERMINAL_CLOSE_CODES).toEqual({
      normal: 1000,
      shuttingDown: 1001,
      protocolError: 1002,
      badMessage: 1008,
      tooBig: 1009,
      internalError: 1011,
      slowConsumer: 1013,
      exited: 4000,
      killed: 4001,
      signedOut: 4003,
    });
  });

  it('every close code is distinct, and the application codes are in the private range 4000 to 4999', () => {
    const codes = Object.values(TERMINAL_CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const name of ['exited', 'killed', 'signedOut'] as const) {
      expect(TERMINAL_CLOSE_CODES[name], name).toBeGreaterThanOrEqual(4000);
      expect(TERMINAL_CLOSE_CODES[name], name).toBeLessThanOrEqual(4999);
    }
    // a close code a WebSocket may send: 1000 and 1003 to 1014 except 1004 to 1006, or 3000 to 4999
    for (const code of codes)
      expect(code === 1000 || (code >= 1001 && code <= 1014) || (code >= 3000 && code <= 4999)).toBe(true);
    for (const code of codes) expect([1004, 1005, 1006, 1015]).not.toContain(code);
  });
});

describe('terminal events (design 02 6)', () => {
  it('names the three events in the order a client sees them', () => {
    expect([...TERMINAL_EVENT_NAMES]).toEqual(['hello', 'sessions', 'heartbeat']);
    expect(Object.keys(TerminalEventSchemas)).toEqual([...TERMINAL_EVENT_NAMES]);
  });

  it('hello carries the instance, the epoch, the time and the heartbeat interval', () => {
    const hello = { instanceId: INSTANCE, epoch: '0a1b2c3d', serverTime: AT, heartbeatMs: 15000 };
    expect(TerminalEventSchemas.hello.safeParse(hello).success).toBe(true);
    for (const key of Object.keys(hello))
      expect(TerminalEventSchemas.hello.safeParse(without(hello, key)).success, key).toBe(false);
    expect(TerminalEventSchemas.hello.safeParse({ ...hello, extra: 1 }).success).toBe(false);
    expect(TerminalEventSchemas.hello.safeParse({ ...hello, instanceId: 'x' }).success).toBe(false);
    expect(TerminalEventSchemas.hello.safeParse({ ...hello, heartbeatMs: -1 }).success).toBe(false);
  });

  it('sessions carries a version and the full list of at most 64 rows', () => {
    const frame = { version: 3, sessions: [session] };
    expect(TerminalEventSchemas.sessions.safeParse(frame).success).toBe(true);
    expect(TerminalEventSchemas.sessions.safeParse({ version: 0, sessions: [] }).success).toBe(true);
    expect(
      TerminalEventSchemas.sessions.safeParse({ version: 1, sessions: Array.from({ length: 64 }, () => session) })
        .success,
    ).toBe(true);
    expect(
      TerminalEventSchemas.sessions.safeParse({ version: 1, sessions: Array.from({ length: 65 }, () => session) })
        .success,
    ).toBe(false);
    expect(TerminalEventSchemas.sessions.safeParse({ version: -1, sessions: [] }).success).toBe(false);
    expect(TerminalEventSchemas.sessions.safeParse({ sessions: [] }).success).toBe(false);
    expect(TerminalEventSchemas.sessions.safeParse({ version: 1 }).success).toBe(false);
    expect(TerminalEventSchemas.sessions.safeParse({ ...frame, extra: 1 }).success).toBe(false);
    expect(TerminalEventSchemas.sessions.safeParse({ version: 1, sessions: [{ ...session, extra: 1 }] }).success).toBe(
      false,
    );
  });

  it('heartbeat carries the server time only', () => {
    expect(TerminalEventSchemas.heartbeat.safeParse({ serverTime: AT }).success).toBe(true);
    expect(TerminalEventSchemas.heartbeat.safeParse({}).success).toBe(false);
    expect(TerminalEventSchemas.heartbeat.safeParse({ serverTime: 'now' }).success).toBe(false);
    expect(TerminalEventSchemas.heartbeat.safeParse({ serverTime: AT, extra: 1 }).success).toBe(false);
  });
});

describe('error vocabulary the contracts rely on', () => {
  it('the terminal error codes are catalogue codes', () => {
    for (const code of TERMINAL_ERROR_CODES) expect(ERROR_CODES).toContain(code);
  });
});
