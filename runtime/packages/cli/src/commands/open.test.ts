// `open` (06 2.3, 5.2): the option table, the input mapping and the secrecy rule of the login URL. The operation is
// `opsApp.openUser`, proven in the engine (app.test.ts) and on real processes (cli/test/user-lifecycle.int.test.ts); here it is
// a fake. The rule that matters: the login URL holds a one-time code, so it is in the data and the text only when it was asked
// for (`--print`) or when no browser could be opened, and never on stderr.
import type { OpContext, StartResult, UserOpenInput, UserOpenResult } from '@mcs/engine';
import { McsError } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand, userOpenInputOf } from './open.ts';

type Typed = Record<string, string | boolean>;

/** The context a command gets from the kernel: the values are the text typed on the command line. */
function contextOf(values: Typed, scope: 'user' | 'task' = 'user'): CommandContext {
  const text = (name: string): string | undefined => {
    const v = values[name];
    return typeof v === 'string' ? v : undefined;
  };
  return {
    op: { repo: 'R' } as unknown as OpContext,
    args: {
      positionals: [],
      string: text,
      strings: (name) => {
        const v = text(name);
        return v === undefined ? [] : [v];
      },
      flag: (name) => values[name] === true,
      int: (name) => {
        const v = text(name);
        return v === undefined ? undefined : Number(v);
      },
    },
    scope,
    deps: {},
    json: false,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

// FIXTURE: invented data for tests
const CODE = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
const LOGIN_URL = `http://127.0.0.1:18000/#code=${CODE}`;

const STARTED: StartResult = {
  outcome: 'already-running',
  slug: 'user',
  dir: 'D',
  instanceId: 'I',
  engine: 'node',
  url: 'http://127.0.0.1:18000',
  pid: 42,
  createdDefault: false,
  adopted: false,
  opened: null,
  exitCode: 0,
  message: [],
  warnings: [],
};

const OPENED: UserOpenResult = {
  scope: 'user',
  url: 'http://127.0.0.1:18000/',
  port: 18000,
  start: STARTED,
  login: null,
  browser: 'default-browser',
  exitCode: 0,
  message: ['opened: default browser tab'],
  warnings: [],
};

const PRINTED: UserOpenResult = {
  ...OPENED,
  login: { url: LOGIN_URL, expiresAt: '2026-01-01T00:02:00.000Z', ttlSeconds: 120 },
  browser: null,
  message: [`login: ${LOGIN_URL}  (single use, 120 s)`],
};

const NO_BROWSER: UserOpenResult = {
  ...PRINTED,
  message: [],
  warnings: ['could not open a browser (no-browser)'],
};

function fake(seen: UserOpenInput[], result: UserOpenResult) {
  return {
    openUser: (_ctx: OpContext, input?: UserOpenInput) => {
      seen.push(input ?? {});
      return Promise.resolve(result);
    },
  };
}

describe('open command', () => {
  it('is named open, takes the options of 06 2.3, and acts on the app only', () => {
    expect(command.name).toBe('open');
    expect(command.defaultScope).toBe('user');
    expect(command.userOnly).toBe(true);
    expect(Object.keys(command.options)).toEqual(['window', 'tab', 'print', 'no-start', 'timeout-ms']);
    for (const name of ['window', 'tab', 'print', 'no-start']) {
      expect(command.options[name]).toMatchObject({ type: 'boolean' });
    }
    expect(command.options['window']?.conflictsWith).toEqual(['tab']);
    expect(command.options['timeout-ms']).toMatchObject({ type: 'string', integer: [1000, 300_000] });
  });

  it('has no task option: --task is an unknown option of an app-only command', () => {
    expect(command.options['task']).toBeUndefined();
    expect(command.positionals).toBeUndefined();
  });

  it('passes only the options that were given', () => {
    expect(userOpenInputOf(contextOf({}).args)).toEqual({});
    expect(
      userOpenInputOf(contextOf({ window: true, print: true, 'no-start': true, 'timeout-ms': '4000' }).args),
    ).toEqual({ browser: 'window', print: true, noStart: true, timeoutMs: 4000 });
    expect(userOpenInputOf(contextOf({ tab: true }).args)).toEqual({ browser: 'tab' });
  });

  it('hands the input to the operation and renders its message lines and warnings', async () => {
    const seen: UserOpenInput[] = [];
    const out = await makeCommand(fake(seen, { ...OPENED, warnings: ['an app window was requested but nothing'] })).run(
      contextOf({ tab: true }),
    );
    expect(seen).toEqual([{ browser: 'tab' }]);
    expect(out.text).toEqual(['opened: default browser tab']);
    expect(out.warnings).toEqual(['an app window was requested but nothing']);
    expect(out.exitCode).toBe(0);
  });

  it('passes the refusal of an app that does not run (--no-start) unchanged', async () => {
    const refusal = new McsError('INSTANCE_NOT_RUNNING', 'the app is not running (--no-start)');
    const cmd = makeCommand({ openUser: () => Promise.reject(refusal) });
    await expect(cmd.run(contextOf({ 'no-start': true }))).rejects.toBe(refusal);
  });

  it('passes the error of a code that cannot be had unchanged', async () => {
    const problem = new McsError('API_ERROR', 'the app did not give a login code (no answer)');
    const cmd = makeCommand({ openUser: () => Promise.reject(problem) });
    await expect(cmd.run(contextOf({}))).rejects.toMatchObject({ code: 'API_ERROR' });
  });
});

describe('open command: the login URL is a password', () => {
  it('is in the data and in one text line with --print, and nowhere else', async () => {
    const out = await makeCommand(fake([], PRINTED)).run(contextOf({ print: true }));
    expect(JSON.stringify(out.data)).toContain(CODE);
    expect(out.text).toEqual([`login: ${LOGIN_URL}  (single use, 120 s)`]);
    expect(JSON.stringify(out.warnings ?? [])).not.toContain(CODE);
  });

  it('is not in the data of a call that opened a browser', async () => {
    const out = await makeCommand(fake([], OPENED)).run(contextOf({}));
    expect(JSON.stringify(out)).not.toContain(CODE);
    expect(JSON.stringify(out)).not.toContain('#code=');
  });

  it('is shown as one fallback line of text when no browser could be opened, but stays out of the data and the warnings', async () => {
    const out = await makeCommand(fake([], NO_BROWSER)).run(contextOf({}));
    expect(out.text).toEqual([`open: ${LOGIN_URL}  (single use, 120 s)`]);
    expect(JSON.stringify(out.data)).not.toContain(CODE);
    expect(JSON.stringify(out.warnings ?? [])).not.toContain(CODE);
    expect(out.warnings).toEqual(['could not open a browser (no-browser)']);
    expect(out.exitCode).toBe(0);
  });

  it('keeps every other field of the result when the login is taken out', async () => {
    const out = await makeCommand(fake([], NO_BROWSER)).run(contextOf({}));
    expect(out.data).toMatchObject({ scope: 'user', port: 18000, login: null, url: 'http://127.0.0.1:18000/' });
  });
});
