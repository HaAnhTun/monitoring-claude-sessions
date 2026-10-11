// `verify` (01 6.3, 4.10): the message of a verified instance.
import type { OpContext, VerifyResult } from '@mcs/engine';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './verify.ts';

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

describe('verify command', () => {
  it('takes --task only', () => {
    expect(command.name).toBe('verify');
    expect(Object.keys(command.options)).toEqual(['task']);
  });

  it('prints the verified line', async () => {
    const result: VerifyResult = {
      slug: 'demo',
      url: 'http://127.0.0.1:18000',
      sessions: 3,
      exitCode: 0,
      message: ['verified http://127.0.0.1:18000: health, instance, sessions (3), overview all valid'],
      delegated: false,
    };
    const out = await makeCommand({ verify: () => Promise.resolve(result) }).run(contextOf({ task: 'demo' }));
    expect(out.text).toEqual(result.message);
    expect(out.exitCode).toBe(0);
    expect(out.data).toMatchObject({ sessions: 3 });
  });
});
