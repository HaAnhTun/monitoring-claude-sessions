// `serve` (01 6.3, 4.10; 06 2.3): foreground server of a task or of the app; the command owns SIGINT while the server runs
// (`interruptible: 'command'`).
import type { OpContext, ServeInput, ServeResult, UserServeInput } from '@mcs/engine';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandContext } from '../main.ts';
import { command, makeCommand } from './serve.ts';

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
  it('takes the options of 01 6.3 without --timeout-ms, with --state-file for the legacy flag, and serves the app by default', () => {
    expect(command.name).toBe('serve');
    expect(command.defaultScope).toBe('user');
    expect(Object.keys(command.options)).toEqual(['task', 'port', 'log-level', 'open', 'no-open', 'state-file']);
    expect(command.options['state-file']).toMatchObject({ type: 'string' });
    expect(command.options['state-file']?.description).toContain('ignored');
  });

  it('opens nothing for the app: --open is a task option, and the options of a login (--window, --tab, --print) are not offered', () => {
    expect(command.options['open']?.scope).toBe('task');
    for (const name of ['window', 'tab', 'print', 'timeout-ms']) expect(command.options[name]).toBeUndefined();
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

  it("owns Ctrl+C itself (interruptible: 'command') and does not touch the listeners of the process", async () => {
    expect(command.interruptible).toBe('command');
    const kernel = (): void => undefined;
    process.on('SIGINT', kernel);
    added.push(kernel);
    const before = process.listeners('SIGINT');
    const during: (readonly unknown[])[] = [];
    const cmd = makeCommand({
      serveForeground: () => {
        during.push(process.listeners('SIGINT'));
        return Promise.reject(new Error('the server failed'));
      },
    });
    await expect(cmd.run(contextOf({}))).rejects.toThrow('the server failed');
    expect(during).toEqual([before]);
    expect(process.listeners('SIGINT')).toEqual(before);
  });
});

// ---- a task call ------------------------------------------------------------------------------------------------------------------

function neverUser(): never {
  throw new Error('a call in task scope reached the app operation');
}

function neverTask(): never {
  throw new Error('a call in the scope of the app reached the task operation');
}

describe('serve command: a task call', () => {
  it('goes to the task operation, keeps --open and ignores --no-open', async () => {
    const seen: ServeInput[] = [];
    const cmd = makeCommand(
      {
        serveForeground: (_ctx, input) => {
          seen.push(input ?? {});
          return Promise.resolve(RESULT);
        },
      },
      { serveUser: neverUser },
    );
    await cmd.run(contextOf({ task: 'demo', open: true, 'no-open': true }, 'task'));
    expect(seen).toEqual([{ task: 'demo', open: true }]);
  });
});

// ---- the app ----------------------------------------------------------------------------------------------------------------------

describe('serve command: the app', () => {
  it('passes the port and the log level, and never the injected task', async () => {
    const seen: UserServeInput[] = [];
    const cmd = makeCommand(
      { serveForeground: neverTask },
      {
        serveUser: (_ctx, input) => {
          seen.push(input ?? {});
          return Promise.resolve({ ...RESULT, slug: 'user', warnings: [] });
        },
      },
    );
    await cmd.run(contextOf({ task: 'user' }, 'user'));
    await cmd.run(contextOf({ task: 'user', port: '18003', 'log-level': 'debug', 'no-open': true }, 'user'));
    expect(seen).toEqual([{}, { port: 18003, logLevel: 'debug' }]);
  });

  it('sends the legacy --state-file nowhere and says that it is ignored: the app has one state file', async () => {
    const seen: UserServeInput[] = [];
    const cmd = makeCommand(
      { serveForeground: neverTask },
      {
        serveUser: (_ctx, input) => {
          seen.push(input ?? {});
          return Promise.resolve({ ...RESULT, slug: 'user', warnings: ['from the operation'] });
        },
      },
    );
    const out = await cmd.run(contextOf({ task: 'user', 'state-file': 'x.json' }, 'user'));
    expect(seen).toEqual([{}]);
    expect(out.warnings).toEqual([
      'from the operation',
      '--state-file is ignored: the app always uses its own state.json',
    ]);
  });

  it('renders the result of the operation: the message, the warnings and the exit code of the foreground run', async () => {
    const result: ServeResult = { slug: 'user', exitCode: 0, message: ['stopped'], warnings: ['w'], interrupted: true };
    const out = await makeCommand({ serveForeground: neverTask }, { serveUser: () => Promise.resolve(result) }).run(
      contextOf({}, 'user'),
    );
    expect(out.text).toEqual(['stopped']);
    expect(out.warnings).toEqual(['w']);
    expect(out.exitCode).toBe(0);
    expect(out.data).toMatchObject({ slug: 'user', interrupted: true });
  });

  it('passes the failure of the foreground run on (a live app answers INSTANCE_RUNNING)', async () => {
    const failure = new Error('the server failed');
    const cmd = makeCommand({ serveForeground: neverTask }, { serveUser: () => Promise.reject(failure) });
    await expect(cmd.run(contextOf({}, 'user'))).rejects.toBe(failure);
  });
});
