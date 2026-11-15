// `verify` (01 6.3, 4.10; 06 2.3): the message of a verified instance, of a task or of the app.
import type { OpContext, VerifyResult } from '@mcs/engine';
import { McsError } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './verify.ts';

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

describe('verify command', () => {
  it('takes --task only, and verifies the app when nothing selects a task', () => {
    expect(command.name).toBe('verify');
    expect(command.defaultScope).toBe('user');
    expect(Object.keys(command.options)).toEqual(['task']);
    expect(command.options['task']?.required).not.toBe(true);
  });

  it('prints the verified line', async () => {
    const result: VerifyResult = {
      slug: 'demo',
      url: 'http://127.0.0.1:18000',
      sessions: 3,
      exitCode: 0,
      message: ['verified http://127.0.0.1:18000: health, instance, sessions (3), overview all valid'],
    };
    const out = await makeCommand({ verify: () => Promise.resolve(result) }).run(contextOf({ task: 'demo' }));
    expect(out.text).toEqual(result.message);
    expect(out.exitCode).toBe(0);
    expect(out.data).toMatchObject({ sessions: 3 });
  });
});

describe('verify command: a task call', () => {
  it('asks the task operation with the task, and never the app', async () => {
    const seen: unknown[] = [];
    const result: VerifyResult = { slug: 'demo', url: null, sessions: null, exitCode: 1, message: ['x'] };
    const cmd = makeCommand(
      {
        verify: (_ctx, input) => {
          seen.push(input);
          return Promise.resolve(result);
        },
      },
      {
        verifyUser: () => {
          throw new Error('a call in task scope reached the app operation');
        },
      },
    );
    const out = await cmd.run(contextOf({ task: 'demo' }, 'task'));
    expect(seen).toEqual([{ task: 'demo' }]);
    expect(out.exitCode).toBe(1);
  });
});

describe('verify command: the app', () => {
  const RESULT: VerifyResult = {
    slug: 'user',
    url: 'http://127.0.0.1:18000',
    sessions: 0,
    exitCode: 0,
    message: ['verified http://127.0.0.1:18000: health, instance, sessions (0), overview all valid'],
  };

  function neverTask(): never {
    throw new Error('a call in the scope of the app reached the task operation');
  }

  it('prints the verified line of the app, exit 0, and the whole result as data', async () => {
    const out = await makeCommand({ verify: neverTask }, { verifyUser: () => Promise.resolve(RESULT) }).run(
      contextOf({ task: 'user' }, 'user'),
    );
    expect(out.text).toEqual(RESULT.message);
    expect(out.exitCode).toBe(0);
    expect(out.data).toMatchObject({ slug: 'user', sessions: 0 });
  });

  it('a failed check is the exit code of the operation', async () => {
    const failed: VerifyResult = { ...RESULT, exitCode: 1, message: ['FAILED /api/v3/health: no valid body'] };
    const out = await makeCommand({ verify: neverTask }, { verifyUser: () => Promise.resolve(failed) }).run(
      contextOf({}, 'user'),
    );
    expect(out.exitCode).toBe(1);
    expect(out.text).toEqual(failed.message);
  });

  it('passes the refusal of an app that was never started on as it is', async () => {
    const refusal = new McsError('INSTANCE_NOT_RUNNING', 'the app was never started: there is nothing to verify', {
      hint: 'run `caw start`',
    });
    const cmd = makeCommand({ verify: neverTask }, { verifyUser: () => Promise.reject(refusal) });
    await expect(cmd.run(contextOf({}, 'user'))).rejects.toBe(refusal);
  });
});
