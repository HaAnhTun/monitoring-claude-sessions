// `start` (01 6.3, 06 2.3): the option table and the rendering of the result of `ops.lifecycle.start` for a task and of
// `opsApp.startUser` for the app; the operations themselves are proven in the engine (lifecycle.test.ts, app.test.ts) and on real
// processes (cli/test/lifecycle.int.test.ts, cli/test/user-lifecycle.int.test.ts).
import type { OpContext, StartInput, StartResult, UserStartInput, UserStartResult } from '@mcs/engine';
import { McsError } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand, startInputOf, userStartInputOf } from './start.ts';

type Typed = Record<string, string | boolean>;

/** The context a command gets from the kernel: the values are the text typed on the command line. */
function contextOf(values: Typed, scope?: 'user' | 'task'): CommandContext {
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
    ...(scope === undefined ? {} : { scope }),
    deps: {},
    json: false,
    globalOptions: {},
    catalog: { all: () => Promise.resolve([]), find: () => Promise.resolve(null) },
  };
}

const RESULT: StartResult = {
  outcome: 'started',
  slug: 'demo',
  dir: 'D',
  instanceId: 'I',
  engine: 'node',
  url: 'http://127.0.0.1:18000',
  pid: 42,
  createdDefault: false,
  adopted: false,
  opened: null,
  exitCode: 0,
  message: ['started: http://127.0.0.1:18000 (pid 42)'],
  warnings: [],
};

describe('start command', () => {
  it('is named start, takes the options of 01 6.3 and of 06 2.3, and starts at the app', () => {
    expect(command.name).toBe('start');
    expect(command.defaultScope).toBe('user');
    expect(Object.keys(command.options)).toEqual([
      'task',
      'port',
      'log-level',
      'open',
      'timeout-ms',
      'no-open',
      'window',
      'tab',
      'print',
    ]);
    expect(command.options['port']).toMatchObject({ type: 'string', integer: [1, 65535] });
    expect(command.options['log-level']).toMatchObject({ type: 'string', choices: ['error', 'warn', 'info', 'debug'] });
    expect(command.options['open']).toMatchObject({ type: 'boolean' });
    expect(command.options['timeout-ms']).toMatchObject({ type: 'string', integer: [1000, 300_000] });
    expect(command.options['task']?.required).not.toBe(true);
  });

  it('the options of the browser belong to the app, and exclude each other the way 06 2.3 says', () => {
    for (const name of ['no-open', 'window', 'tab', 'print']) {
      expect(command.options[name]).toMatchObject({ type: 'boolean' });
    }
    // --no-open is accepted in a task call (and ignored): the shortcut of the autostart and the scripts pass it in both
    expect(command.options['no-open']?.scope).toBeUndefined();
    for (const name of ['window', 'tab', 'print']) expect(command.options[name]?.scope).toBe('user');
    expect(command.options['window']?.conflictsWith).toEqual(['tab']);
    expect(command.options['open']?.conflictsWith).toEqual(['no-open']);
  });

  it('passes only the options that were given', () => {
    expect(startInputOf(contextOf({}).args)).toEqual({});
    expect(
      startInputOf(
        contextOf({ task: 'demo', port: '18000', 'log-level': 'debug', open: true, 'timeout-ms': '4000' }).args,
      ),
    ).toEqual({ task: 'demo', port: 18000, logLevel: 'debug', open: true, timeoutMs: 4000 });
  });

  it('renders the result: the message lines, the warnings, the exit code, the whole result as data', async () => {
    const seen: StartInput[] = [];
    const cmd = makeCommand({
      start: (_ctx, input) => {
        seen.push(input ?? {});
        return Promise.resolve({ ...RESULT, warnings: ['could not open a browser; open http://127.0.0.1:18000'] });
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo' }));
    expect(seen).toEqual([{ task: 'demo' }]);
    expect(out.text).toEqual(RESULT.message);
    expect(out.warnings).toEqual(['could not open a browser; open http://127.0.0.1:18000']);
    expect(out.exitCode).toBe(0);
    expect(out.data).toMatchObject({ outcome: 'started', pid: 42 });
  });

  it('passes the refusal of a workspace held by a monitor that this runtime did not start through', async () => {
    const refusal = new McsError('INSTANCE_RUNNING', "a monitor runs 'demo' (pid 7, http://127.0.0.1:18000)");
    const cmd = makeCommand({ start: () => Promise.reject(refusal) });
    await expect(cmd.run(contextOf({}))).rejects.toBe(refusal);
  });
});

// ---- the task scope stays what it was ----------------------------------------------------------------------------------------

function neverUser(): never {
  throw new Error('a call in task scope reached the app operation');
}

describe('start command: a task call', () => {
  it('goes to the task operation with the options of a task, and ignores --no-open', async () => {
    const seen: StartInput[] = [];
    const cmd = makeCommand(
      {
        start: (_ctx, input) => {
          seen.push(input ?? {});
          return Promise.resolve(RESULT);
        },
      },
      { startUser: neverUser },
    );
    const out = await cmd.run(contextOf({ task: 'demo', 'no-open': true, port: '18001' }, 'task'));
    expect(seen).toEqual([{ task: 'demo', port: 18001 }]);
    expect(out.text).toEqual(RESULT.message);
  });

  it('a task call with --open still opens, as before', async () => {
    const seen: StartInput[] = [];
    const cmd = makeCommand({
      start: (_ctx, input) => {
        seen.push(input ?? {});
        return Promise.resolve(RESULT);
      },
    });
    await cmd.run(contextOf({ task: 'demo', open: true }, 'task'));
    expect(seen).toEqual([{ task: 'demo', open: true }]);
  });
});

// ---- the app --------------------------------------------------------------------------------------------------------------------

const LOGIN_URL = 'http://127.0.0.1:18000/#code=0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

const USER_RESULT: UserStartResult = {
  ...RESULT,
  slug: 'user',
  scope: 'user',
  browserUrl: 'http://127.0.0.1:18000/',
  configuredPort: 18000,
  portNote: null,
  outdated: false,
  upgraded: null,
  login: null,
  browser: 'default-browser',
  opened: true,
  message: ['started: http://127.0.0.1:18000/ (pid 42)', 'opened: default browser tab'],
};

function userOps(seen: UserStartInput[], result: UserStartResult = USER_RESULT) {
  return {
    startUser: (_ctx: OpContext, input?: UserStartInput) => {
      seen.push(input ?? {});
      return Promise.resolve(result);
    },
  };
}

function neverTask(): never {
  throw new Error('a call in the scope of the app reached the task operation');
}

describe('start command: the app', () => {
  it('opens the browser unless --no-open, and never passes the injected task', async () => {
    const seen: UserStartInput[] = [];
    const cmd = makeCommand({ start: neverTask }, userOps(seen));
    await cmd.run(contextOf({ task: 'user' }, 'user'));
    await cmd.run(contextOf({ task: 'user', 'no-open': true }, 'user'));
    expect(seen).toEqual([{ open: true }, { open: false }]);
  });

  it('passes the port, the log level, the timeout, the kind of browser and --print', async () => {
    const seen: UserStartInput[] = [];
    const cmd = makeCommand({ start: neverTask }, userOps(seen));
    await cmd.run(
      contextOf(
        { task: 'user', port: '18002', 'log-level': 'debug', 'timeout-ms': '5000', window: true, print: true },
        'user',
      ),
    );
    await cmd.run(contextOf({ task: 'user', tab: true }, 'user'));
    expect(seen).toEqual([
      { port: 18002, logLevel: 'debug', timeoutMs: 5000, open: true, browser: 'window', print: true },
      { open: true, browser: 'tab' },
    ]);
  });

  it('--open is the default of the app: it changes nothing', () => {
    expect(userStartInputOf(contextOf({ open: true }, 'user').args)).toEqual({ open: true });
  });

  it('renders the lines, the warnings, the exit code and the result as data', async () => {
    const seen: UserStartInput[] = [];
    const result: UserStartResult = { ...USER_RESULT, warnings: ['the running app is outdated; run `caw restart`'] };
    const out = await makeCommand({ start: neverTask }, userOps(seen, result)).run(contextOf({}, 'user'));
    expect(out.text).toEqual(USER_RESULT.message);
    expect(out.warnings).toEqual(['the running app is outdated; run `caw restart`']);
    expect(out.exitCode).toBe(0);
    expect(out.data).toMatchObject({ scope: 'user', pid: 42, browser: 'default-browser' });
  });

  it('passes the refusal of an app that cannot be started', async () => {
    const refusal = new McsError('INSTANCE_RUNNING', 'a monitor that this runtime did not start answers there');
    const cmd = makeCommand({ start: neverTask }, { startUser: () => Promise.reject(refusal) });
    await expect(cmd.run(contextOf({}, 'user'))).rejects.toBe(refusal);
  });
});

describe('start command: the login URL is a password (06 5.2)', () => {
  const login = { url: LOGIN_URL, expiresAt: '2030-01-01T00:00:00.000Z', ttlSeconds: 120 };

  it('--print: the line and the login of the result are shown', async () => {
    const printed: UserStartResult = {
      ...USER_RESULT,
      opened: null,
      browser: null,
      login,
      message: ['started: http://127.0.0.1:18000/ (pid 42)', `login: ${LOGIN_URL}  (single use, 120 s)`],
    };
    const out = await makeCommand({ start: neverTask }, userOps([], printed)).run(contextOf({ print: true }, 'user'));
    expect(out.text).toEqual(printed.message);
    expect(out.data).toMatchObject({ login });
  });

  it('a browser that could not be opened: the person gets the URL as the fallback, in the text and not in the data', async () => {
    const failed: UserStartResult = {
      ...USER_RESULT,
      opened: false,
      browser: null,
      login,
      message: ['started: http://127.0.0.1:18000/ (pid 42)'],
      warnings: ['could not open a browser (no-browser)'],
    };
    const out = await makeCommand({ start: neverTask }, userOps([], failed)).run(contextOf({}, 'user'));
    expect(out.text).toEqual(['started: http://127.0.0.1:18000/ (pid 42)', `open: ${LOGIN_URL}  (single use, 120 s)`]);
    expect(out.warnings).toEqual(['could not open a browser (no-browser)']);
    expect(JSON.stringify(out.data)).not.toContain('#code=');
    expect(out.data).toMatchObject({ login: null, opened: false });
  });

  it('without --print the data never holds a login, even when the result has one', async () => {
    const odd: UserStartResult = { ...USER_RESULT, login };
    const out = await makeCommand({ start: neverTask }, userOps([], odd)).run(contextOf({}, 'user'));
    expect(JSON.stringify(out.data)).not.toContain('#code=');
  });

  it('--no-open mints nothing: no login line, the pointer to `open` stays', async () => {
    const quiet: UserStartResult = {
      ...USER_RESULT,
      opened: null,
      browser: null,
      message: ['started: http://127.0.0.1:18000/ (pid 42)', 'next: caw open  (caw open --print gives a login URL)'],
    };
    const out = await makeCommand({ start: neverTask }, userOps([], quiet)).run(contextOf({ 'no-open': true }, 'user'));
    expect(out.text).toEqual(quiet.message);
    expect(JSON.stringify(out)).not.toContain('#code=');
  });
});
