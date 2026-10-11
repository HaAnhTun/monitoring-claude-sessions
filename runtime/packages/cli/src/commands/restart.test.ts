// `restart` (01 6.3, 4.10): the options of `start`, two lines of output.
import type { OpContext, RestartResult, StartInput } from '@mcs/engine';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './restart.ts';
import { command as startCommand } from './start.ts';

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

describe('restart command', () => {
  it('takes the options of start', () => {
    expect(command.name).toBe('restart');
    expect(command.options).toEqual(startCommand.options);
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
      delegated: false,
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
