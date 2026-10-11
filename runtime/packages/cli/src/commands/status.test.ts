// `status` (01 6.3, 4.10): the legacy JSON with the new keys, exit 0 iff running.
import type { OpContext, StatusReport, StatusResult } from '@mcs/engine';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './status.ts';

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

const STOPPED: StatusReport = {
  running: false,
  state_file: 'S',
  engine: null,
  probe: 'stopped',
  instance_id: 'I',
};

describe('status command', () => {
  it('takes --task only', () => {
    expect(command.name).toBe('status');
    expect(Object.keys(command.options)).toEqual(['task']);
  });

  it('prints the report as the legacy JSON and as the data of the envelope, exit 1 when it is not running', async () => {
    const result: StatusResult = { report: STOPPED, exitCode: 1, delegated: false };
    const cmd = makeCommand({ status: () => Promise.resolve(result) });
    const out = await cmd.run(contextOf({ task: 'demo' }));
    expect(out.legacy).toEqual(STOPPED);
    expect(out.data).toEqual(STOPPED);
    expect(out.exitCode).toBe(1);
    expect(out.text).toBeUndefined();
  });

  it('exit 0 for a running instance', async () => {
    const running: StatusReport = { ...STOPPED, running: true, probe: 'running', engine: 'node' };
    const cmd = makeCommand({ status: () => Promise.resolve({ report: running, exitCode: 0, delegated: false }) });
    expect((await cmd.run(contextOf({}))).exitCode).toBe(0);
  });

  it('a delegated status has nothing of its own to print', async () => {
    const cmd = makeCommand({ status: () => Promise.resolve({ report: null, exitCode: 1, delegated: true }) });
    const out = await cmd.run(contextOf({}));
    expect(out.legacy).toBeUndefined();
    expect(out.data).toEqual({ delegated: true });
    expect(out.exitCode).toBe(1);
  });
});
