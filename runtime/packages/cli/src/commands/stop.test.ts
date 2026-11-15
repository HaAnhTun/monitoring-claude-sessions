// `stop` (01 6.3, 06 2.3, 3): the option table and the rendering of `ops.lifecycle.stop` for a task and of `opsApp.stopUser` for the
// app. The guard itself (the census, `TERMINALS_LIVE`, `--force`) is proven in the engine (lifecycle.test.ts, app.test.ts) and on
// real processes (cli/test/user-lifecycle.int.test.ts); here is what the command passes on and what it prints.
import type { OpContext, StopInput, StopResult, UserStopInput, UserStopResult } from '@mcs/engine';
import { McsError, cliExitCode } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './stop.ts';

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

const RESULT: StopResult = {
  outcome: 'stopped',
  slug: 'demo',
  pid: 42,
  url: 'http://127.0.0.1:18000',
  forced: false,
  reason: null,
  terminalsEnded: 0,
  exitCode: 0,
  message: ['stopped runtime pid 42 (http://127.0.0.1:18000)'],
};

describe('stop command', () => {
  it('takes --task, --timeout-ms and, for the app, --force; without a selector it stops the app', () => {
    expect(command.name).toBe('stop');
    expect(command.defaultScope).toBe('user');
    expect(Object.keys(command.options)).toEqual(['task', 'timeout-ms', 'force']);
    expect(command.options['timeout-ms']).toMatchObject({ type: 'string', integer: [1000, 300_000] });
    expect(command.options['task']?.required).not.toBe(true);
  });

  it('--force belongs to the app: the kernel refuses it in a task call (06 2.2)', () => {
    expect(command.options['force']).toMatchObject({ type: 'boolean', scope: 'user' });
    expect(command.options['force']?.description).toContain('terminal');
  });

  it('passes the options on and renders the message', async () => {
    const seen: StopInput[] = [];
    const cmd = makeCommand({
      stop: (_ctx, input) => {
        seen.push(input ?? {});
        return Promise.resolve(RESULT);
      },
    });
    const out = await cmd.run(contextOf({ task: 'demo', 'timeout-ms': '2500' }));
    expect(seen).toEqual([{ task: 'demo', timeoutMs: 2500 }]);
    expect(out.text).toEqual(RESULT.message);
    expect(out.exitCode).toBe(0);
    expect(out.data).toMatchObject({ outcome: 'stopped', forced: false });
  });

  it('passes nothing when nothing was typed', async () => {
    const seen: StopInput[] = [];
    await makeCommand({
      stop: (_ctx, input) => {
        seen.push(input ?? {});
        return Promise.resolve(RESULT);
      },
    }).run(contextOf({}));
    expect(seen).toEqual([{}]);
  });
});

// ---- a task call: the operation of a task, whatever the app does ----------------------------------------------------------------

function neverUser(): never {
  throw new Error('a call in task scope reached the app operation');
}

function neverTask(): never {
  throw new Error('a call in the scope of the app reached the task operation');
}

describe('stop command: a task call', () => {
  it('goes to the task operation and never to the app, and never sends --force', async () => {
    const seen: StopInput[] = [];
    const cmd = makeCommand(
      {
        stop: (_ctx, input) => {
          seen.push(input ?? {});
          return Promise.resolve(RESULT);
        },
      },
      { stopUser: neverUser },
    );
    const out = await cmd.run(contextOf({ task: 'demo', 'timeout-ms': '3000' }, 'task'));
    expect(seen).toEqual([{ task: 'demo', timeoutMs: 3000 }]);
    expect(out.text).toEqual(RESULT.message);
  });
});

// ---- the app ----------------------------------------------------------------------------------------------------------------------

const USER_RESULT: UserStopResult = {
  ...RESULT,
  scope: 'user',
  slug: 'user',
};

function userOps(seen: UserStopInput[], result: UserStopResult = USER_RESULT) {
  return {
    stopUser: (_ctx: OpContext, input?: UserStopInput) => {
      seen.push(input ?? {});
      return Promise.resolve(result);
    },
  };
}

describe('stop command: the app', () => {
  it('passes the timeout and --force, and never the injected task', async () => {
    const seen: UserStopInput[] = [];
    const cmd = makeCommand({ stop: neverTask }, userOps(seen));
    await cmd.run(contextOf({ task: 'user' }, 'user'));
    await cmd.run(contextOf({ task: 'user', 'timeout-ms': '4000' }, 'user'));
    await cmd.run(contextOf({ task: 'user', force: true }, 'user'));
    expect(seen).toEqual([{}, { timeoutMs: 4000 }, { force: true }]);
  });

  it('renders the lines, the exit code and the whole result as data', async () => {
    const out = await makeCommand({ stop: neverTask }, userOps([])).run(contextOf({}, 'user'));
    expect(out.text).toEqual(USER_RESULT.message);
    expect(out.exitCode).toBe(0);
    expect(out.data).toMatchObject({ scope: 'user', outcome: 'stopped', pid: 42 });
  });

  it('an app that is not running is "nothing to stop" with exit 0', async () => {
    const idle: UserStopResult = {
      ...USER_RESULT,
      outcome: 'nothing-to-stop',
      pid: null,
      url: null,
      message: ['nothing to stop (the app was never started)'],
    };
    const out = await makeCommand({ stop: neverTask }, userOps([], idle)).run(contextOf({}, 'user'));
    expect(out.text).toEqual(['nothing to stop (the app was never started)']);
    expect(out.exitCode).toBe(0);
  });

  it('a forced stop says how many terminal sessions it ended, and the data counts them', async () => {
    const forced: UserStopResult = {
      ...USER_RESULT,
      forced: true,
      terminalsEnded: 2,
      message: ['stopped runtime pid 42 (http://127.0.0.1:18000)', 'ended 2 terminal sessions'],
    };
    const out = await makeCommand({ stop: neverTask }, userOps([], forced)).run(contextOf({ force: true }, 'user'));
    expect(out.text).toEqual(forced.message);
    expect(out.data).toMatchObject({ forced: true, terminalsEnded: 2 });
  });

  it('passes the refusal of live terminals on as it is: the kernel prints it and exits 3 (06 3.3)', async () => {
    const refusal = new McsError(
      'TERMINALS_LIVE',
      '2 terminal sessions are live (api-1, web-1); stopping would end them',
      {
        hint: 'close them in the app, or run `caw stop --force` to end them now',
        details: { live: 2, sessions: ['api-1', 'web-1'] },
      },
    );
    const cmd = makeCommand({ stop: neverTask }, { stopUser: () => Promise.reject(refusal) });
    await expect(cmd.run(contextOf({}, 'user'))).rejects.toBe(refusal);
    expect(cliExitCode(refusal.code)).toBe(3);
  });
});
