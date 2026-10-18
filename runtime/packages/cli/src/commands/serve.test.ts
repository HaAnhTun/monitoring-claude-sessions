// `serve` (01 6.3, 4.10): foreground server; the command takes SIGINT over from the kernel while the server runs.
import type { OpContext, ServeInput, ServeResult } from '@mcs/engine';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './serve.ts';

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

const RESULT: ServeResult = {
  slug: 'demo',
  exitCode: 0,
  message: [],
  warnings: ['--state-file is ignored by the Node runtime (it always uses S)'],
  interrupted: false,
};

const added: (() => void)[] = [];
afterEach(() => {
  for (const handler of added.splice(0)) process.off('SIGINT', handler);
});

describe('serve command', () => {
  it('takes the options of 01 6.3, with --state-file for the legacy flag', () => {
    expect(command.name).toBe('serve');
    expect(Object.keys(command.options)).toEqual(['task', 'port', 'log-level', 'open', 'state-file']);
    expect(command.options['state-file']).toMatchObject({ type: 'string' });
    expect(command.options['state-file']?.description).toContain('ignored');
  });

  it('passes the options on and renders the warnings', async () => {
    const seen: ServeInput[] = [];
    const cmd = makeCommand({
      serveForeground: (_ctx, input) => {
        seen.push(input ?? {});
        return Promise.resolve(RESULT);
      },
    });
    const out = await cmd.run(
      contextOf({ task: 'demo', port: '18002', 'state-file': 'x.json', open: true, 'log-level': 'warn' }),
    );
    expect(seen).toEqual([{ task: 'demo', port: 18002, logLevel: 'warn', open: true, stateFile: 'x.json' }]);
    expect(out.warnings).toEqual(RESULT.warnings);
    expect(out.exitCode).toBe(0);
  });

  it('takes SIGINT over from the kernel while the server runs and gives it back afterwards, even after a failure', async () => {
    const kernel = (): void => undefined;
    process.on('SIGINT', kernel);
    added.push(kernel);
    const during: number[] = [];
    const cmd = makeCommand({
      serveForeground: () => {
        during.push(process.listeners('SIGINT').filter((listener) => listener === kernel).length);
        return Promise.reject(new Error('the server failed'));
      },
    });
    await expect(cmd.run(contextOf({}))).rejects.toThrow('the server failed');
    expect(during).toEqual([0]);
    expect(process.listeners('SIGINT').filter((listener) => listener === kernel)).toHaveLength(1);
  });
});
