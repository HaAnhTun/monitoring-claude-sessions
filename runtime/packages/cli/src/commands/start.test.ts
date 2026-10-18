// `start` (01 6.3): the option table and the rendering of the result of `ops.lifecycle.start`; the operation itself is
// proven in the engine (lifecycle.test.ts) and on real processes (cli/test/lifecycle.int.test.ts).
import type { OpContext, StartInput, StartResult } from '@mcs/engine';
import { McsError } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand, startInputOf } from './start.ts';

type Typed = Record<string, string | boolean>;

/** The context a command gets from the kernel: the values are the text typed on the command line. */
function contextOf(values: Typed): CommandContext {
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
  it('is named start and takes the options of 01 6.3', () => {
    expect(command.name).toBe('start');
    expect(Object.keys(command.options)).toEqual(['task', 'port', 'log-level', 'open', 'timeout-ms']);
    expect(command.options['port']).toMatchObject({ type: 'string', integer: [1, 65535] });
    expect(command.options['log-level']).toMatchObject({ type: 'string', choices: ['error', 'warn', 'info', 'debug'] });
    expect(command.options['open']).toMatchObject({ type: 'boolean' });
    expect(command.options['timeout-ms']).toMatchObject({ type: 'string', integer: [1000, 300_000] });
    expect(command.options['task']?.required).not.toBe(true);
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
