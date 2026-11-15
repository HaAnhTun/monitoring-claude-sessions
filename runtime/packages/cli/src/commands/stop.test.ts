// `stop` (01 6.3): the option table and the rendering of `ops.lifecycle.stop`.
import type { OpContext, StopInput, StopResult } from '@mcs/engine';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './stop.ts';

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
  it('takes --task and --timeout-ms', () => {
    expect(command.name).toBe('stop');
    expect(Object.keys(command.options)).toEqual(['task', 'timeout-ms']);
    expect(command.options['timeout-ms']).toMatchObject({ type: 'string', integer: [1000, 300_000] });
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
