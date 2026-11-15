// `restart` (01 6.3, 4.10; 06 2.3): the options of `start` and `--force` for the app, two lines of output; the app's restart is
// `opsApp.restartUser`, whose guard is proven in the engine.
import type {
  OpContext,
  RestartResult,
  StartInput,
  UserRestartResult,
  UserStartInput,
  UserStartResult,
  UserStopResult,
} from '@mcs/engine';
import { McsError, cliExitCode } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './restart.ts';
import { command as startCommand } from './start.ts';

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

describe('restart command', () => {
  it('takes the options of start and --force, and restarts the app when nothing selects a task', () => {
    expect(command.name).toBe('restart');
    expect(command.defaultScope).toBe('user');
    expect(Object.keys(command.options)).toEqual([...Object.keys(startCommand.options), 'force']);
    for (const [name, spec] of Object.entries(startCommand.options)) expect(command.options[name]).toEqual(spec);
    expect(command.options['force']).toMatchObject({ type: 'boolean', scope: 'user' });
  });

  it('passes the options on and prints the stop line and the start line', async () => {
    const seen: StartInput[] = [];
    const result: RestartResult = {
      slug: 'demo',
      stop: null,
      start: null,
      exitCode: 0,
      message: ['stopped runtime pid 1 (u)', 'started: u (pid 2)'],
      warnings: ['w'],
    };
    const cmd = makeCommand({
      restart: (_ctx, input) => {
        seen.push(input ?? {});
        return Promise.resolve(result);
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo', port: '18001', open: true }));
    expect(seen).toEqual([{ task: 'demo', port: 18001, open: true }]);
    expect(out.text).toEqual(result.message);
    expect(out.warnings).toEqual(['w']);
    expect(out.exitCode).toBe(0);
  });
});

// ---- a task call ------------------------------------------------------------------------------------------------------------------

function neverUser(): never {
  throw new Error('a call in task scope reached the app operation');
}

function neverTask(): never {
  throw new Error('a call in the scope of the app reached the task operation');
}

describe('restart command: a task call', () => {
  it('goes to the task operation, ignores --no-open and never reaches the app', async () => {
    const seen: StartInput[] = [];
    const result: RestartResult = { slug: 'demo', stop: null, start: null, exitCode: 0, message: ['m'], warnings: [] };
    const cmd = makeCommand(
      {
        restart: (_ctx, input) => {
          seen.push(input ?? {});
          return Promise.resolve(result);
        },
      },
      { restartUser: neverUser },
    );
    await cmd.run(contextOf({ task: 'demo', 'no-open': true, 'timeout-ms': '5000' }, 'task'));
    expect(seen).toEqual([{ task: 'demo', timeoutMs: 5000 }]);
  });
});

// ---- the app ----------------------------------------------------------------------------------------------------------------------

const LOGIN_URL = 'http://127.0.0.1:18000/#code=0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
const LOGIN = { url: LOGIN_URL, expiresAt: '2030-01-01T00:00:00.000Z', ttlSeconds: 120 };

const STOPPED: UserStopResult = {
  scope: 'user',
  outcome: 'stopped',
  slug: 'user',
  pid: 41,
  url: 'http://127.0.0.1:18000',
  forced: false,
  reason: null,
  terminalsEnded: 0,
  exitCode: 0,
  message: ['stopped runtime pid 41 (http://127.0.0.1:18000)'],
};

const STARTED: UserStartResult = {
  outcome: 'started',
  slug: 'user',
  dir: 'D',
  instanceId: 'I',
  engine: 'node',
  url: 'http://127.0.0.1:18000',
  pid: 42,
  createdDefault: false,
  adopted: false,
  opened: true,
  exitCode: 0,
  message: ['started: http://127.0.0.1:18000/ (pid 42)', 'opened: default browser tab'],
  warnings: [],
  scope: 'user',
  browserUrl: 'http://127.0.0.1:18000/',
  configuredPort: 18000,
  portNote: null,
  outdated: false,
  upgraded: null,
  login: null,
  browser: 'default-browser',
};

const RESTARTED: UserRestartResult = {
  scope: 'user',
  stop: STOPPED,
  start: STARTED,
  exitCode: 0,
  message: [...STOPPED.message, ...STARTED.message],
  warnings: [],
};

type RestartInput = UserStartInput & { readonly force?: boolean };

function userOps(seen: RestartInput[], result: UserRestartResult = RESTARTED) {
  return {
    restartUser: (_ctx: OpContext, input?: RestartInput) => {
      seen.push(input ?? {});
      return Promise.resolve(result);
    },
  };
}

describe('restart command: the app', () => {
  it('opens the browser unless --no-open, passes --force, and never the injected task', async () => {
    const seen: RestartInput[] = [];
    const cmd = makeCommand({ restart: neverTask }, userOps(seen));
    await cmd.run(contextOf({ task: 'user' }, 'user'));
    await cmd.run(contextOf({ task: 'user', 'no-open': true, force: true }, 'user'));
    expect(seen).toEqual([{ open: true }, { open: false, force: true }]);
  });

  it('passes the port, the log level, the timeout, the kind of browser and --print', async () => {
    const seen: RestartInput[] = [];
    await makeCommand({ restart: neverTask }, userOps(seen)).run(
      contextOf(
        { task: 'user', port: '18002', 'log-level': 'debug', 'timeout-ms': '5000', tab: true, print: true },
        'user',
      ),
    );
    expect(seen).toEqual([
      { port: 18002, logLevel: 'debug', timeoutMs: 5000, open: true, browser: 'tab', print: true },
    ]);
  });

  it('renders the stop line, the start lines, the warnings, the exit code and the result as data', async () => {
    const result: UserRestartResult = { ...RESTARTED, warnings: ['could not refresh the autostart shortcut'] };
    const out = await makeCommand({ restart: neverTask }, userOps([], result)).run(contextOf({}, 'user'));
    expect(out.text).toEqual(RESTARTED.message);
    expect(out.warnings).toEqual(['could not refresh the autostart shortcut']);
    expect(out.exitCode).toBe(0);
    expect(out.data).toMatchObject({ scope: 'user', stop: { pid: 41 }, start: { pid: 42 } });
  });

  it('passes the refusal of live terminals on as it is: exit 3, and nothing was changed (06 3.3)', async () => {
    const refusal = new McsError(
      'TERMINALS_LIVE',
      '2 terminal sessions are live (api-1, web-1); restarting would end them',
      {
        hint: 'close them in the app, or run `caw restart --force` to end them now',
        details: { live: 2, sessions: ['api-1', 'web-1'] },
      },
    );
    const cmd = makeCommand({ restart: neverTask }, { restartUser: () => Promise.reject(refusal) });
    await expect(cmd.run(contextOf({}, 'user'))).rejects.toBe(refusal);
    expect(cliExitCode(refusal.code)).toBe(3);
  });
});

describe('restart command: the login URL is a password (06 5.2)', () => {
  const withLogin = (opened: boolean | null): UserRestartResult => ({
    ...RESTARTED,
    start: { ...STARTED, opened, browser: null, login: LOGIN, message: ['started: http://127.0.0.1:18000/ (pid 42)'] },
    message: [...STOPPED.message, 'started: http://127.0.0.1:18000/ (pid 42)'],
  });

  it('--print: the login stays in the data, and the line that shows it is part of the text', async () => {
    const printed: UserRestartResult = {
      ...withLogin(null),
      message: [
        ...STOPPED.message,
        'started: http://127.0.0.1:18000/ (pid 42)',
        `login: ${LOGIN_URL}  (single use, 120 s)`,
      ],
    };
    const out = await makeCommand({ restart: neverTask }, userOps([], printed)).run(contextOf({ print: true }, 'user'));
    expect(out.text).toEqual(printed.message);
    expect(out.data).toMatchObject({ start: { login: LOGIN } });
  });

  it('a browser that could not be opened: the URL is a line of text, never in the data', async () => {
    const out = await makeCommand({ restart: neverTask }, userOps([], withLogin(false))).run(contextOf({}, 'user'));
    expect(out.text).toEqual([
      ...STOPPED.message,
      'started: http://127.0.0.1:18000/ (pid 42)',
      `open: ${LOGIN_URL}  (single use, 120 s)`,
    ]);
    expect(JSON.stringify(out.data)).not.toContain('#code=');
    expect(out.data).toMatchObject({ start: { login: null, opened: false } });
  });

  it('without --print the data never holds a login, even when the result has one', async () => {
    const out = await makeCommand({ restart: neverTask }, userOps([], withLogin(true))).run(contextOf({}, 'user'));
    expect(JSON.stringify(out.data)).not.toContain('#code=');
    expect(out.text).toEqual([...STOPPED.message, 'started: http://127.0.0.1:18000/ (pid 42)']);
  });
});
